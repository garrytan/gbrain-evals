/**
 * Read the public agent-memory benchmark harness at its pinned commit and
 * reduce its committed per-question result files to the numbers the power
 * simulation needs: per-history clusters of graded or binary scores, and
 * paired outcomes between providers on the same questions.
 *
 * The harness names output directories after providers. The comparator's
 * directories are recognized by the SHA-256 of their names, listed in
 * `eval/data/memory-proof-wave/harness.lock.json`, so its product name never
 * appears in this repository. Every other provider directory except the
 * harness's hybrid-search baseline is labeled `other:<8 hex>`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { sha256Hex } from '../sealed-confirmation-lib.ts';

export const LOCK_PATH = 'eval/data/memory-proof-wave/harness.lock.json';

export interface HarnessLock {
  schema: string;
  HARNESS_REPO: string;
  HARNESS_COMMIT: string;
  HARNESS_COMMIT_DATE: string;
  checkout_env: string;
  comparator_output_dir_sha256: string[];
  baseline_output_dir: string;
}

export function loadLock(path = LOCK_PATH): HarnessLock {
  return JSON.parse(readFileSync(path, 'utf8')) as HarnessLock;
}

/** Map a provider directory name to its public label. */
export function providerLabel(dir: string, lock: HarnessLock): string {
  const h = sha256Hex(dir);
  if (lock.comparator_output_dir_sha256.includes(h)) return 'comparator';
  if (dir === lock.baseline_output_dir) return 'baseline:hybrid-search';
  return `other:${h.slice(0, 8)}`;
}

/** Datasets the wave splits: BEAM sizes are graded and grouped by conversation, PersonaMem by persona, LifeBench by user. */
export interface DatasetSpec { key: string; dataset: string; split: string; metric: 'graded' | 'binary'; grouping: 'conversation' | 'persona' | 'user'; mode: string }
export const DATASETS: DatasetSpec[] = [
  { key: 'beam/100k', dataset: 'beam', split: '100k', metric: 'graded', grouping: 'conversation', mode: 'single-query' },
  { key: 'beam/500k', dataset: 'beam', split: '500k', metric: 'graded', grouping: 'conversation', mode: 'single-query' },
  { key: 'beam/1m', dataset: 'beam', split: '1m', metric: 'graded', grouping: 'conversation', mode: 'single-query' },
  { key: 'personamem/32k', dataset: 'personamem', split: '32k', metric: 'binary', grouping: 'persona', mode: 'rag' },
  { key: 'lifebench/en', dataset: 'lifebench', split: 'en', metric: 'binary', grouping: 'user', mode: 'rag' },
];
/** Datasets whose committed rows give paired outcomes of two different systems under one answer model and judge. */
export const ANALOG_DATASETS = [
  { dataset: 'longmemeval', split: 's', mode: 'rag' },
  { dataset: 'locomo', split: 'locomo10', mode: 'rag' },
  { dataset: 'personamem', split: '32k', mode: 'rag' },
  { dataset: 'lifebench', split: 'en', mode: 'rag' },
];

interface QueryRow { id: string; user_id: string; meta: Record<string, any> }
interface ResultRow { query_id: string; correct: boolean; score?: number | null; meta: Record<string, any> }
interface ResultFile { memory_provider: string; mode: string; answer_llm: string | null; judge_llm: string | null; total_queries: number; correct: number; results: ResultRow[] }

export interface Item { q: string; cat: string; score: number }
export interface ClusterInput { id: string; histories: string[]; items: Item[] }
export interface DatasetInput {
  metric: 'graded' | 'binary';
  grouping: DatasetSpec['grouping'];
  provider: 'comparator';
  mode: string;
  answer_llm: string | null;
  judge_llm: string | null;
  queries_file: { path: string; sha256: string };
  results_file: { path: string; sha256: string };
  clusters: ClusterInput[];
}
export interface AnalogPair {
  dataset: string;
  a: string;
  b: string;
  n: number;
  a_correct: number;
  b_correct: number;
  a_only: number;
  b_only: number;
  clusters: number;
  /** Between-cluster SD of the true paired difference in points (method of moments; 0 when the estimate is negative). */
  tau_points: number | null;
  results_files: Array<{ path: string; sha256: string }>;
}
export interface PowerInputs {
  schema: 'gbrain-evals/mpw-power-inputs/v1';
  harness: { lock: string; commit: string; commit_date: string; checkout_head: string };
  datasets: Record<string, DatasetInput>;
  analogs: AnalogPair[];
}

const readGz = (path: string) => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));

function providerDirs(root: string, dataset: string, mode: string, split: string): Array<{ dir: string; path: string }> {
  const base = join(root, 'outputs', dataset);
  if (!existsSync(base)) return [];
  return readdirSync(base).sort()
    .map(dir => ({ dir, path: join(base, dir, mode, `${split}.json.gz`) }))
    .filter(x => existsSync(x.path));
}

function publicPath(dataset: string, label: string, mode: string, split: string): string {
  return `outputs/${dataset}/{${label}}/${mode}/${split}.json.gz`;
}

function clusterKey(spec: DatasetSpec, q: QueryRow): string {
  if (spec.grouping === 'persona') return String(q.meta.persona_id);
  if (spec.grouping === 'conversation') return String(q.meta.conversation_id ?? q.user_id);
  return String(q.user_id);
}

function category(spec: DatasetSpec, q: QueryRow): string {
  return String(q.meta.question_category ?? q.meta.question_type ?? q.meta.category ?? 'all');
}

/** Score a result row on the dataset's own scale: BEAM's graded rubric score, otherwise the binary verdict. */
export function rowScore(spec: Pick<DatasetSpec, 'metric'>, r: ResultRow): number {
  if (spec.metric === 'graded') {
    if (typeof r.score !== 'number' || !Number.isFinite(r.score)) throw new Error(`graded row ${r.query_id} has no numeric score`);
    return r.score;
  }
  return r.correct ? 1 : 0;
}

export function extractInputs(root: string, lock: HarnessLock): PowerInputs {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== lock.HARNESS_COMMIT) throw new Error(`harness checkout ${root} is at ${head}, lock pins ${lock.HARNESS_COMMIT}; run git -C ${root} checkout ${lock.HARNESS_COMMIT}`);
  const datasets: Record<string, DatasetInput> = {};
  for (const spec of DATASETS) {
    const qPath = join(root, 'data', spec.dataset, spec.split, 'queries.json.gz');
    const queries = readGz(qPath) as QueryRow[];
    const comp = providerDirs(root, spec.dataset, spec.mode, spec.split).filter(p => providerLabel(p.dir, lock) === 'comparator');
    if (comp.length !== 1) throw new Error(`${spec.key}: expected one comparator result file, found ${comp.length}`);
    const file = readGz(comp[0].path) as ResultFile;
    const byId = new Map(file.results.map(r => [r.query_id, r]));
    const clusters = new Map<string, ClusterInput>();
    for (const q of queries) {
      const r = byId.get(q.id);
      if (!r) throw new Error(`${spec.key}: query ${q.id} has no committed result row`);
      const key = clusterKey(spec, q);
      const c = clusters.get(key) ?? { id: key, histories: [], items: [] };
      if (!c.histories.includes(q.user_id)) c.histories.push(q.user_id);
      c.items.push({ q: q.id, cat: category(spec, q), score: rowScore(spec, r) });
      clusters.set(key, c);
    }
    if (byId.size !== queries.length) throw new Error(`${spec.key}: ${byId.size} result rows for ${queries.length} queries`);
    datasets[spec.key] = {
      metric: spec.metric, grouping: spec.grouping, provider: 'comparator', mode: file.mode,
      answer_llm: file.answer_llm, judge_llm: file.judge_llm,
      queries_file: { path: `data/${spec.dataset}/${spec.split}/queries.json.gz`, sha256: sha256Hex(readFileSync(qPath)) },
      results_file: { path: publicPath(spec.dataset, 'comparator', spec.mode, spec.split), sha256: sha256Hex(readFileSync(comp[0].path)) },
      clusters: [...clusters.values()].map(c => ({ ...c, histories: c.histories.sort() })).sort((a, b) => naturalCompare(a.id, b.id)),
    };
  }
  return {
    schema: 'gbrain-evals/mpw-power-inputs/v1',
    harness: { lock: LOCK_PATH, commit: lock.HARNESS_COMMIT, commit_date: lock.HARNESS_COMMIT_DATE, checkout_head: head },
    datasets,
    analogs: extractAnalogs(root, lock),
  };
}

function analogCluster(dataset: string, r: ResultRow): string {
  const m = r.meta ?? {};
  if (dataset === 'personamem') return String(m.persona_id);
  return String(m.sample_id ?? m.conversation_id ?? r.query_id);
}

function extractAnalogs(root: string, lock: HarnessLock): AnalogPair[] {
  const out: AnalogPair[] = [];
  for (const a of ANALOG_DATASETS) {
    const files = providerDirs(root, a.dataset, a.mode, a.split).map(p => ({ label: providerLabel(p.dir, lock), path: p.path, file: readGz(p.path) as ResultFile }));
    files.sort((x, y) => (x.label === 'comparator' ? -1 : y.label === 'comparator' ? 1 : x.label.localeCompare(y.label)));
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const A = files[i], B = files[j];
        const bById = new Map(B.file.results.map(r => [r.query_id, r]));
        const pairs: Array<{ cluster: string; d: number; a: number; b: number }> = [];
        for (const r of A.file.results) {
          const s = bById.get(r.query_id);
          if (!s) continue;
          const av = r.correct ? 1 : 0, bv = s.correct ? 1 : 0;
          pairs.push({ cluster: analogCluster(a.dataset, r), d: av - bv, a: av, b: bv });
        }
        if (pairs.length < 300) continue;
        out.push({
          dataset: `${a.dataset}/${a.split}`, a: A.label, b: B.label, n: pairs.length,
          a_correct: pairs.reduce((s, p) => s + p.a, 0), b_correct: pairs.reduce((s, p) => s + p.b, 0),
          a_only: pairs.filter(p => p.d === 1).length, b_only: pairs.filter(p => p.d === -1).length,
          clusters: new Set(pairs.map(p => p.cluster)).size,
          tau_points: betweenClusterSd(pairs),
          results_files: [A, B].map(f => ({ path: publicPath(a.dataset, f.label, a.mode, a.split), sha256: sha256Hex(readFileSync(f.path)) })),
        });
      }
    }
  }
  return out;
}

/**
 * Method-of-moments between-cluster SD of a paired difference, in points:
 * variance of cluster means minus the average within-cluster sampling
 * variance. Null when every question is its own cluster.
 */
export function betweenClusterSd(pairs: Array<{ cluster: string; d: number }>): number | null {
  const by = new Map<string, number[]>();
  for (const p of pairs) by.set(p.cluster, [...(by.get(p.cluster) ?? []), p.d]);
  if (by.size < 2 || by.size === pairs.length) return null;
  const groups = [...by.values()];
  const means = groups.map(g => g.reduce((s, x) => s + x, 0) / g.length);
  const grand = means.reduce((s, x) => s + x, 0) / means.length;
  const varMeans = means.reduce((s, x) => s + (x - grand) ** 2, 0) / (means.length - 1);
  const within = groups.reduce((s, g, i) => s + g.reduce((t, x) => t + (x - means[i]) ** 2, 0) / g.length / g.length, 0) / groups.length;
  const tau2 = varMeans - within;
  return tau2 > 0 ? Number((100 * Math.sqrt(tau2)).toFixed(3)) : 0;
}

export function naturalCompare(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}
