/**
 * Phase 4 analysis of the open-source memory shootout: what the preregistration
 * (docs/benchmarks/2026-10-06-oss-memory-shootout-preregistration.md) defines, computed
 * from the committed cell results only.
 *
 *   bun eval/runner/shootout-report.ts [--results <results dir>] [--campaign <campaign.json>] --output <dir>
 *
 * Inputs. The campaign manifest lists every expected memory-QA cell (the sealed and
 * PrecisionMemBench cells are not part of Phase 4). Each cell's attempts are the lease
 * directories under `results/<cell>/`; an attempt listed in the results README's Status
 * table is a failed attempt, listed in the output and never used. The latest attempt not
 * listed there, with a lease summary, is the cell's settled attempt; a cell without one is
 * "pending". A system row (system, configuration, benchmark, replicate) joins its cells
 * (Basic Memory and Cognee split LongMemEval-S over shard cells) and each cell's sources
 * (`shard-<i>/` inside a cell, or the cell directory), and is pending while any cell is.
 *
 * Per question (memory-qa/outcomes.ts): `scored` and `ingest_degraded` keep their judge
 * score; `retrieval_error` and `unsupported` are product failures scored 0; the harness
 * failures (`reader_error`, `judge_error`, `harness_invalid`, `budget_not_run`) and a
 * missing row are excluded. QA service quality is the mean of that; completed-call quality
 * is the mean judge score over `scored` rows. Strict recall (`recall_all@5`, `@10`) is
 * averaged over non-abstention questions with gold sessions and no harness failure, a
 * product failure counting 0, and is "not measurable" for a system whose rows carry none
 * (provenance unavailable) and "not applicable" for the full-context and no-memory controls.
 *
 * Families (each with the primary family's method): the question ids of the benchmark's
 * system rows, `crossSystemExclusion` over every run in the family (a harness failure or a
 * missing row anywhere excludes the question from every pair), `pairObservations`,
 * `clusteredPairedDelta` (seed 20261006, 10,000 draws; delta = system minus gbrain),
 * `p_two_sided`, `holmAdjusted` across the family's tested pairs. A pair reads "incomplete",
 * with its numbers and no direction, when more than 5% of the questions are excluded or a
 * run of the pair is invalid or partial; "ceiling" when both systems are at or above 95%.
 * A family with a pending pair is provisional: its Holm step is over the pairs that landed.
 *
 *   primary   LongMemEval-S, fixed-evidence.native.b8000.main, QA service quality, each
 *             vendor common row against gbrain-shootout common at frozen master;
 *   pin       the same five pairs against gbrain-shootout common at the pin (secondary link);
 *   S1        the same pairs and arm, recall_all@5, systems with measurable provenance;
 *   S2        gbrain-shootout common (master) in the rehydrated context against the D1
 *             controls (see CONTROL_PAIRS);
 *   descriptive  LoCoMo dev (replicate 1) and BEAM-100K dev tables, conversations as
 *             clusters, no tests; the second LoCoMo ingest as run-to-run agreement.
 *
 * Ingest minutes are not in the committed receipts; each row reports the cells' wall-clock
 * minutes (receipt start to finish, reading included) instead, named as such.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { loadCampaign, type CellSpec } from './shootout-cell.ts';
import { crossSystemExclusion, HARNESS_FAILURES, outcomeOf, PRODUCT_FAILURES, type Outcome } from './memory-qa/outcomes.ts';
import { clusteredPairedDelta, holmAdjusted, pairObservations, powerNote, type Observation } from './stats/paired.ts';
import { percentile } from './metrics.ts';

const ROOT = resolve(import.meta.dir, '../..');
export const DEFAULT_RESULTS = join(ROOT, 'docs/benchmarks/2026-10-06-oss-memory-shootout/results');
export const DEFAULT_CAMPAIGN = join(ROOT, 'docs/benchmarks/2026-10-06-oss-memory-shootout/manifests/campaign.json');
export const SEED = 20261006;
export const DRAWS = 10_000;
export const ALPHA = 0.05;
export const PRIMARY_ARM = 'fixed-evidence.native.b8000.main';
export const VENDORS = ['basic-memory', 'mem0', 'graphiti', 'hindsight', 'cognee'] as const;
const INCOMPLETE_SHARE = 0.05;
const CEILING = 0.95;
const MASTER = 'gbrain-shootout-master', PIN = 'gbrain-shootout';
const BENCH_NAME: Record<string, string> = { 'lme-s': 'the LongMemEval-S slice', locomo: 'LoCoMo dev', 'beam-100k': 'BEAM-100K dev' };
const NUMBER_WORD: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };
/** S2: (control system, control arm, gbrain arm). The gbrain arm is the rehydrated arm of the same policy; no-memory has one arm and meets the 8,000-token arm. */
export const CONTROL_PAIRS: ReadonlyArray<{ control: string; arm: string; gbrainArm: string }> = [
  { control: 'full-context', arm: 'fixed-evidence.rehydrated.b8000.main', gbrainArm: 'fixed-evidence.rehydrated.b8000.main' },
  { control: 'full-context', arm: 'vendor-default.rehydrated.bnone.main', gbrainArm: 'vendor-default.rehydrated.bnone.main' },
  { control: 'plain-hybrid', arm: 'fixed-evidence.rehydrated.b8000.main', gbrainArm: 'fixed-evidence.rehydrated.b8000.main' },
  { control: 'plain-hybrid', arm: 'vendor-default.rehydrated.bnone.main', gbrainArm: 'vendor-default.rehydrated.bnone.main' },
  { control: 'no-memory', arm: 'vendor-default.native.bnone.main', gbrainArm: 'fixed-evidence.rehydrated.b8000.main' },
];

export type Row = Record<string, any> & { id: string };

/** Failed attempts from the results README's Status table: cell id to the lease ids (or attempt prefixes such as `a2`) listed there. */
export function failedAttempts(readme: string): Map<string, Array<{ lease: string; note: string }>> {
  const out = new Map<string, Array<{ lease: string; note: string }>>();
  const status = readme.split(/^## /m).find(s => s.startsWith('Status')) ?? '';
  for (const line of status.split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*(.*)\|\s*$/);
    if (!m) continue;
    out.set(m[1], [...(out.get(m[1]) ?? []), { lease: m[2], note: m[3].trim() }]);
  }
  return out;
}

const attemptNo = (lease: string) => Number(lease.match(/-a(\d+)-[0-9a-f]+$/)?.[1] ?? 0);
const listed = (lease: string, entries: Array<{ lease: string }>) => entries.find(e => lease === e.lease || lease.endsWith(`-${e.lease}`) || (/^a\d+$/.test(e.lease) && attemptNo(lease) === Number(e.lease.slice(1))));

export interface CellAttempts { cell: string; used: { lease: string; dir: string } | null; failed: Array<{ lease: string; note: string }>; unlisted_unsettled: string[] }

export function selectAttempt(resultsDir: string, cell: string, failed: Map<string, Array<{ lease: string; note: string }>>): CellAttempts {
  const dir = join(resultsDir, cell);
  const leases = existsSync(dir) ? readdirSync(dir).filter(l => existsSync(join(dir, l)) && !l.startsWith('.')).sort((a, b) => attemptNo(b) - attemptNo(a) || (a < b ? 1 : -1)) : [];
  const entries = failed.get(cell) ?? [];
  const out: CellAttempts = { cell, used: null, failed: entries.map(e => ({ ...e })), unlisted_unsettled: [] };
  for (const l of leases) {
    if (listed(l, entries)) continue;
    if (!existsSync(join(dir, l, 'lease-summary.json'))) { out.unlisted_unsettled.push(l); continue; }
    out.used = { lease: l, dir: join(dir, l) };
    break;
  }
  return out;
}

const readRows = (path: string): Row[] => gunzipSync(readFileSync(path)).toString('utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Row);
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

export interface CellData { cell: string; lease: string; receipts: Record<string, any>[]; arms: Map<string, { rows: Row[]; status: string[] }>; leaseUsd: number; committedUsd: number }

/** One settled attempt: every source's receipt and every arm's rows (the legacy path's single row set is arm `legacy`). */
export function loadCell(cell: string, att: { lease: string; dir: string }): CellData {
  const shards = readdirSync(att.dir).filter(d => /^shard-\d+$/.test(d)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  const sources = shards.length ? shards.map(s => join(att.dir, s)) : [att.dir];
  const arms = new Map<string, { rows: Row[]; status: string[] }>();
  const receipts: Record<string, any>[] = [];
  for (const src of sources) {
    const receipt = readJson(join(src, 'receipt.json'));
    receipts.push(receipt);
    const add = (arm: string, rows: Row[], status: string) => { const a = arms.get(arm) ?? { rows: [], status: [] }; a.rows.push(...rows); a.status.push(status); arms.set(arm, a); };
    if (existsSync(join(src, 'arms'))) {
      for (const arm of readdirSync(join(src, 'arms')).sort()) {
        const p = join(src, 'arms', arm);
        if (existsSync(join(p, 'rows.ndjson.gz'))) add(arm, readRows(join(p, 'rows.ndjson.gz')), existsSync(join(p, 'receipt.json')) ? String(readJson(join(p, 'receipt.json')).run_status) : 'unknown');
      }
    } else if (existsSync(join(src, 'rows.ndjson.gz'))) add('legacy', readRows(join(src, 'rows.ndjson.gz')), String(receipt.run_status));
  }
  const ls = readJson(join(att.dir, 'lease-summary.json'));
  return { cell, lease: att.lease, receipts, arms, leaseUsd: Number(ls.lease_usd ?? 0), committedUsd: Number(ls.committed_usd ?? 0) };
}

export interface Unit {
  key: string; system: string; config: string; benchmark: string; replicate: number;
  cells: string[]; status: 'settled' | 'pending'; pending_cells: string[];
  data: CellData[];
}

export const unitKey = (system: string, config: string, benchmark: string, replicate = 1) => `${system}|${config}|${benchmark}|r${replicate}`;
const replicateOf = (c: CellSpec) => /-r2$/.test(c.id) ? 2 : 1;

/** Questions scored for QA: the value pairs and means use, or why the question is out. */
export function qaValue(row: Row | undefined): { value: number | null; reason?: string } {
  if (!row) return { value: null, reason: 'harness error: no row' };
  const o = outcomeOf(row);
  if (HARNESS_FAILURES.has(o)) return { value: null, reason: `harness error: ${o}` };
  if (PRODUCT_FAILURES.has(o)) return { value: 0 };
  return typeof row.qa_score === 'number' ? { value: row.qa_score } : { value: null, reason: 'no reader on this arm' };
}

/** recall_all@k for one question, or why it has none. */
export function recallValue(row: Row | undefined, k: 5 | 10 = 5): { value: number | null; reason?: string } {
  if (!row) return { value: null, reason: 'harness error: no row' };
  const o = outcomeOf(row);
  if (HARNESS_FAILURES.has(o)) return { value: null, reason: `harness error: ${o}` };
  if (row.abstention || !(row.gold_count > 0)) return { value: null, reason: 'no gold sessions' };
  if (PRODUCT_FAILURES.has(o)) return { value: 0 };
  if (row.recall_measurable === false || typeof row[`recall_all_at_${k}`] !== 'number') return { value: null, reason: 'recall not measurable' };
  return { value: row[`recall_all_at_${k}`] };
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const round = (x: number | null | undefined, d = 4) => x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;

export interface ArmSummary {
  arm: string; rows: number; outcomes: Record<string, number>; run_status: string;
  qa_service: number | null; qa_completed: number | null; qa_n: number;
  recall_status: string; recall_all_at_5: number | null; recall_all_at_10: number | null; recall_n: number;
  reader_input_tokens: number | null; reader_output_tokens: number | null; context_tokens: number | null;
  latency_p50_ms: number | null; latency_p95_ms: number | null; query_usd_per_question: number | null;
}

export function capabilitiesOf(u: Unit): Record<string, any> { return u.data[0]?.receipts[0]?.system?.capabilities ?? {}; }

export function recallStatus(u: Unit, rows: Row[]): string {
  const cap = capabilitiesOf(u);
  if (cap.retrieval_metrics === 'not-applicable' || ['full-context', 'no-memory'].includes(u.system)) return 'not applicable';
  if (!rows.some(r => typeof r.recall_all_at_5 === 'number' && r.recall_measurable !== false)) return rows.some(r => !r.abstention && r.gold_count > 0) ? 'not measurable' : 'n/a';
  return `measurable, provenance ${cap.provenance?.status ?? (u.system.startsWith('gbrain') ? 'exact' : 'unknown')}`;
}

export function summarizeArm(u: Unit, arm: string): ArmSummary {
  const parts = u.data.map(d => d.arms.get(arm)).filter((x): x is { rows: Row[]; status: string[] } => !!x);
  const rows = parts.flatMap(p => p.rows);
  const statuses = parts.flatMap(p => p.status);
  const outcomes: Record<string, number> = {};
  for (const r of rows) { const o = outcomeOf(r); outcomes[o] = (outcomes[o] ?? 0) + 1; }
  const qa = rows.map(qaValue).filter(v => v.value !== null).map(v => v.value!);
  const completed = rows.filter(r => outcomeOf(r) === 'scored' && typeof r.qa_score === 'number').map(r => r.qa_score as number);
  const status = recallStatus(u, rows);
  const rec = (k: 5 | 10) => status.startsWith('measurable') ? rows.map(r => recallValue(r, k)).filter(v => v.value !== null).map(v => v.value!) : [];
  const read = rows.filter(r => typeof r.qa_score === 'number');
  const lat = rows.filter(r => ['scored', 'ingest_degraded'].includes(outcomeOf(r)) && typeof r.latency_ms === 'number').map(r => r.latency_ms as number);
  const usd = rows.filter(r => typeof r.provider?.usd === 'number').map(r => r.provider.usd as number);
  const tokens = (k: string) => round(mean(read.filter(r => typeof r[k] === 'number').map(r => r[k] as number)), 0);
  return {
    arm, rows: rows.length, outcomes, run_status: statuses.includes('invalid') ? 'invalid' : statuses.every(s => s === 'complete') ? 'complete' : 'partial',
    qa_service: round(mean(qa)), qa_completed: round(mean(completed)), qa_n: qa.length,
    recall_status: status, recall_all_at_5: round(mean(rec(5))), recall_all_at_10: round(mean(rec(10))), recall_n: rec(5).length,
    reader_input_tokens: tokens('qa_input_tokens'), reader_output_tokens: tokens('qa_output_tokens'), context_tokens: tokens('qa_context_tokens'),
    latency_p50_ms: lat.length ? round(percentile(lat, 50), 1) : null, latency_p95_ms: lat.length ? round(percentile(lat, 95), 1) : null,
    query_usd_per_question: usd.length ? round(mean(usd), 6) : null,
  };
}

export interface UnitSummary {
  key: string; system: string; config: string; benchmark: string; replicate: number; status: string; cells: Array<{ cell: string; lease: string | null }>; pending_cells: string[];
  provenance: string | null; ingest_usd: number | null; ingest_conversations: number | null; ingest_degraded_conversations: number | null; cell_wall_minutes: number | null; cell_usd: number | null; lease_usd: number | null;
  arms: ArmSummary[];
}

const wallMinutes = (d: CellData) => {
  const s = d.receipts.map(r => Date.parse(r.started_at)).filter(Number.isFinite), f = d.receipts.map(r => Date.parse(r.finished_at)).filter(Number.isFinite);
  return s.length && f.length ? (Math.max(...f) - Math.min(...s)) / 60_000 : null;
};

export function summarizeUnit(u: Unit): UnitSummary {
  const base = { key: u.key, system: u.system, config: u.config, benchmark: u.benchmark, replicate: u.replicate, status: u.status, cells: u.cells.map(c => ({ cell: c, lease: u.data.find(d => d.cell === c)?.lease ?? null })), pending_cells: u.pending_cells };
  if (u.status === 'pending') return { ...base, provenance: null, ingest_usd: null, ingest_conversations: null, ingest_degraded_conversations: null, cell_wall_minutes: null, cell_usd: null, lease_usd: null, arms: [] };
  const ingests = u.data.flatMap(d => d.receipts.map(r => r.ingest)).filter(Boolean);
  const arms = [...new Set(u.data.flatMap(d => [...d.arms.keys()]))].sort();
  const sum = (xs: Array<number | null>) => xs.every(x => x !== null) ? round(xs.reduce((a, b) => a! + b!, 0), 4) : null;
  return {
    ...base, provenance: capabilitiesOf(u).provenance?.status ?? null,
    ingest_usd: ingests.length ? round(ingests.reduce((s, i) => s + Number(i.usd ?? 0), 0), 4) : null,
    ingest_conversations: ingests.length ? ingests.reduce((s, i) => s + Number(i.conversations ?? 0), 0) : null,
    ingest_degraded_conversations: ingests.length ? ingests.reduce((s, i) => s + Number(i.degraded_conversations ?? 0), 0) : null,
    cell_wall_minutes: sum(u.data.map(wallMinutes)) === null ? null : round(sum(u.data.map(wallMinutes)), 1),
    cell_usd: round(u.data.reduce((s, d) => s + d.committedUsd, 0), 4), lease_usd: round(u.data.reduce((s, d) => s + d.leaseUsd, 0), 2),
    arms: arms.map(a => summarizeArm(u, a)),
  };
}

export type Metric = 'qa_service' | 'recall_all_at_5';
const valueOf = (metric: Metric) => metric === 'qa_service' ? qaValue : (r: Row | undefined) => recallValue(r, 5);

export interface Member { label: string; unit: Unit; arm: string }
export interface PairSpec { id: string; system: Member; gbrain: Member }
export interface PairResult {
  id: string; system: string; gbrain: string; arm_system: string; arm_gbrain: string; metric: Metric;
  status: 'tested' | 'pending' | 'not-measurable' | 'blocked'; reading: string; reasons: string[];
  excluded_family: number; excluded_undefined: number; questions: number;
  n_pairs?: number; n_clusters?: number; mean_system?: number; mean_gbrain?: number; delta?: number; ci95?: [number, number] | null;
  p_two_sided?: number; p_method?: string; p_holm?: number; mdd?: number | null; power_note?: string;
}
export interface FamilyResult { id: string; role: string; benchmark: string; metric: Metric; cluster: 'question' | 'conversation'; provisional: boolean; holm: boolean; excluded_questions: number; questions: number; holm_family: string[]; pairs: PairResult[] }

const rowsOf = (m: Member) => m.unit.data.flatMap(d => d.arms.get(m.arm)?.rows ?? []);
const armStatus = (m: Member) => summarizeArm(m.unit, m.arm).run_status;

/** One family: exclusion join over every settled member, then one paired comparison per pair, Holm over the tested ones when `holm`. */
export function runFamily(spec: { id: string; role: string; benchmark: string; metric: Metric; cluster: 'question' | 'conversation'; holm: boolean; pairs: PairSpec[] }): FamilyResult {
  const value = valueOf(spec.metric);
  const settled = (m: Member) => m.unit.status === 'settled';
  const measurable = (m: Member) => spec.metric !== 'recall_all_at_5' || recallStatus(m.unit, rowsOf(m)).startsWith('measurable');
  const members = new Map<string, Member>();
  for (const p of spec.pairs) for (const m of [p.gbrain, p.system]) if (settled(m) && measurable(m)) members.set(`${m.unit.key}#${m.arm}`, m);
  const index = new Map([...members].map(([k, m]) => [k, new Map(rowsOf(m).map(r => [String(r.id), r]))]));
  const ids = [...new Set([...index.values()].flatMap(ix => [...ix.keys()]))].sort();
  const clusterOf = new Map<string, string>();
  for (const ix of index.values()) for (const [id, r] of ix) if (!clusterOf.has(id)) clusterOf.set(id, spec.cluster === 'conversation' ? String(r.conversation ?? id) : id);
  const harness = (r: Row | undefined) => !r || HARNESS_FAILURES.has(outcomeOf(r));
  const joined = crossSystemExclusion(Object.fromEntries([...index].map(([k, ix]) => [k, ids.map((id): Observation => {
    const r = ix.get(id);
    return harness(r) ? { id, cluster: id, value: null, eligible: false, reason: `harness error: ${r ? outcomeOf(r) : 'no row'}` } : { id, cluster: id, value: 1, eligible: true };
  })])));
  const excluded = new Set(joined.excluded);
  const pairs: PairResult[] = spec.pairs.map(p => {
    const base: PairResult = { id: p.id, system: p.system.label, gbrain: p.gbrain.label, arm_system: p.system.arm, arm_gbrain: p.gbrain.arm, metric: spec.metric, status: 'tested', reading: '', reasons: [], excluded_family: excluded.size, excluded_undefined: 0, questions: ids.length };
    const pending = [p.system, p.gbrain].filter(m => !settled(m)).map(m => m.label);
    if (pending.length) return { ...base, status: 'pending', reading: 'pending', reasons: pending.map(l => `${l} has not landed`) };
    if (!measurable(p.system)) return { ...base, status: 'not-measurable', reading: 'not measurable', reasons: [`${p.system.label}: recall not measurable (no row carries strict recall)`] };
    if (!measurable(p.gbrain)) return { ...base, status: 'not-measurable', reading: 'not measurable', reasons: [`${p.gbrain.label}: recall not measurable`] };
    const sx = index.get(`${p.system.unit.key}#${p.system.arm}`)!, gx = index.get(`${p.gbrain.unit.key}#${p.gbrain.arm}`)!;
    const a: Observation[] = [], b: Observation[] = [];
    for (const id of ids) {
      if (excluded.has(id)) continue;
      const sv = value(sx.get(id)), gv = value(gx.get(id));
      const ok = sv.value !== null && gv.value !== null;
      if (!ok && !(sv.reason === 'no gold sessions' && gv.reason === 'no gold sessions')) base.excluded_undefined++;
      const cluster = clusterOf.get(id)!;
      a.push({ id, cluster, value: ok ? gv.value : null, eligible: ok, ...(ok ? {} : { reason: gv.reason ?? sv.reason ?? 'undefined' }) });
      b.push({ id, cluster, value: ok ? sv.value : null, eligible: ok, ...(ok ? {} : { reason: gv.reason ?? sv.reason ?? 'undefined' }) });
    }
    let paired;
    try { paired = pairObservations(a, b).pairs; } catch (e) { return { ...base, status: 'blocked', reading: 'blocked', reasons: [(e as Error).message.slice(0, 300)] }; }
    const s = clusteredPairedDelta(paired, { seed: SEED, draws: DRAWS });
    const pw = powerNote(s, { alpha: ALPHA });
    const reasons: string[] = [];
    if (excluded.size / Math.max(1, ids.length) > INCOMPLETE_SHARE) reasons.push(`${excluded.size} of ${ids.length} questions excluded for harness failures in the family (more than 5%)`);
    for (const m of [p.system, p.gbrain]) { const st = armStatus(m); if (st !== 'complete') reasons.push(`${m.label} ${m.arm} is ${st}`); }
    const ceiling = s.mean_a >= CEILING && s.mean_b >= CEILING;
    return { ...base, reasons, reading: reasons.length ? 'incomplete' : ceiling ? 'ceiling' : 'not distinguishable',
      n_pairs: s.n_pairs, n_clusters: s.n_clusters, mean_system: round(s.mean_b)!, mean_gbrain: round(s.mean_a)!, delta: round(s.delta)!,
      ci95: s.ci95 ? [round(s.ci95[0])!, round(s.ci95[1])!] : null, p_two_sided: s.p_two_sided, p_method: s.p_method, mdd: round(pw.mde), power_note: pw.note };
  });
  const tested = pairs.filter(p => p.status === 'tested');
  if (spec.holm && tested.length) {
    const adj = holmAdjusted(tested.map(p => p.p_two_sided!));
    tested.forEach((p, i) => {
      p.p_holm = adj[i];
      if (p.reading === 'not distinguishable' && adj[i] <= ALPHA && p.delta !== 0) p.reading = p.delta! > 0 ? 'system higher' : 'gbrain higher';
    });
  }
  return { id: spec.id, role: spec.role, benchmark: spec.benchmark, metric: spec.metric, cluster: spec.cluster, holm: spec.holm, provisional: pairs.some(p => p.status === 'pending'),
    excluded_questions: excluded.size, questions: ids.length, holm_family: spec.holm ? tested.map(p => p.id) : [], pairs };
}

const pct = (x: number) => (x * 100).toFixed(1);
const holmText = (p: number) => p < 0.001 ? '<0.001' : p.toFixed(3);
const pts = (x: number) => (x * 100).toFixed(1);

/** The preregistered sentences ("What the report may say"), filled from a QA family's pairs. */
export function primarySentences(f: FamilyResult, gbrainName = 'gbrain'): string[] {
  return f.pairs.map(p => {
    const sys = p.system;
    if (p.status === 'pending') return `${sys}: pending (${p.reasons.join('; ')}).`;
    if (p.status !== 'tested') return `${sys}: ${p.reading} (${p.reasons.join('; ')}).`;
    const a = pct(p.mean_system!), b = pct(p.mean_gbrain!);
    if (p.reading === 'incomplete') return `The comparison of ${sys} and ${gbrainName} is incomplete: ${p.reasons.join('; ')}.`;
    if (p.reading === 'ceiling') return `Both answered nearly every question on this slice; it cannot separate ${sys} and ${gbrainName}.`;
    const interval = p.ci95 ? `, 95% interval ${pts(p.ci95[0])} to ${pts(p.ci95[1])} points` : '';
    if (p.reading === 'system higher') return `On the LongMemEval-S slice, with the same reader and 8,000 tokens of each system's own evidence, ${sys} answered more questions correctly than ${gbrainName} (${a}% vs ${b}%, difference ${pts(p.delta!)} points${interval}).`;
    if (p.reading === 'gbrain higher') return `On the LongMemEval-S slice, with the same reader and 8,000 tokens of each system's own evidence, ${gbrainName} answered more questions correctly than ${sys} (${b}% vs ${a}%, difference ${pts(-p.delta!)} points${interval ? `, 95% interval ${pts(-p.ci95![1])} to ${pts(-p.ci95![0])} points` : ''}).`;
    return `On this slice we could not tell ${sys} and ${gbrainName} apart (${a}% vs ${b}%); a difference smaller than about ${p.mdd === null || p.mdd === undefined ? 'n/a' : pts(p.mdd)} points would not have been detected.`;
  });
}

export function recallSentences(f: FamilyResult, provenance: (label: string) => string, gbrainProvenance = 'provenance exact'): string[] {
  return f.pairs.map(p => p.status === 'tested'
    ? `Strict recall of all gold sessions at 5: ${p.system} ${pct(p.mean_system!)}% (${provenance(p.system)}) and gbrain ${pct(p.mean_gbrain!)}% (${gbrainProvenance}), ${p.reading}${p.p_holm !== undefined ? `, Holm p ${holmText(p.p_holm)}` : ''}.`
    : p.status === 'not-measurable' ? `Strict recall of all gold sessions at 5 for ${p.system}: not measurable (${provenance(p.system)}).` : `Strict recall of all gold sessions at 5 for ${p.system}: ${p.reading}.`);
}

export function descriptiveSentence(benchmark: string, conversations: number, system: string, a: number | null, b: number | null): string {
  const n = NUMBER_WORD[conversations] ?? String(conversations);
  const N = n.charAt(0).toUpperCase() + n.slice(1);
  if (a === null || b === null) return `On ${BENCH_NAME[benchmark]} (${n} conversations), ${system}: pending.`;
  return `On ${BENCH_NAME[benchmark]} (${n} conversations), ${system} scored ${pct(a)}% and gbrain ${pct(b)}%. ${N} conversations describe these systems on these conversations; they cannot rank them.`;
}

export interface Report {
  kind: 'oss-shootout-phase4-report'; schema_version: 1; generated_at: string; results_dir: string; campaign_sha256: string;
  method: Record<string, string>;
  attempts: CellAttempts[]; units: UnitSummary[];
  families: FamilyResult[];
  descriptive: Array<{ benchmark: string; arm: string; system: string; config: string; gbrain: string; conversations: number; a: number | null; b: number | null; paired: PairResult | null; sentence: string }>;
  run_to_run: Array<{ system: string; config: string; policy: string; r1: number | null; r2: number | null; questions: number; identical_share: number | null; status: string }>;
  sentences: { primary: string[]; pin: string[]; s1: string[]; s2: string[]; overall: string };
}

/** Load every expected memory-QA cell of the campaign into system rows. */
export function loadUnits(resultsDir: string, cells: CellSpec[], readme: string): { units: Map<string, Unit>; attempts: CellAttempts[] } {
  const failed = failedAttempts(readme);
  const units = new Map<string, Unit>();
  const attempts: CellAttempts[] = [];
  for (const c of cells) {
    const att = selectAttempt(resultsDir, c.id, failed);
    attempts.push(att);
    const key = unitKey(c.system, c.config, c.benchmark, replicateOf(c));
    const u = units.get(key) ?? { key, system: c.system, config: c.config, benchmark: c.benchmark, replicate: replicateOf(c), cells: [], status: 'settled' as const, pending_cells: [], data: [] };
    u.cells.push(c.id);
    if (att.used) u.data.push(loadCell(c.id, att.used));
    else { u.status = 'pending'; u.pending_cells.push(c.id); }
    units.set(key, u);
  }
  return { units, attempts };
}

export function memoryQaCells(campaignPath: string): { cells: CellSpec[]; sha256: string } {
  const { manifest, sha256 } = loadCampaign(campaignPath);
  return { cells: manifest.cells.filter(c => c.command.includes('memory-qa/run.ts') && !c.command.includes('--split sealed') && ['locomo', 'lme-s', 'beam-100k'].includes(c.benchmark)), sha256 };
}

const PENDING_UNIT = (key: string): Unit => { const [system, config, benchmark, r] = key.split('|'); return { key, system, config, benchmark, replicate: Number(r.slice(1)), cells: [], status: 'pending', pending_cells: ['(no cell in the campaign)'], data: [] }; };

export function buildReport(units: Map<string, Unit>, attempts: CellAttempts[], meta: { resultsDir: string; campaignSha: string }): Report {
  const get = (system: string, config: string, benchmark: string, replicate = 1) => units.get(unitKey(system, config, benchmark, replicate)) ?? PENDING_UNIT(unitKey(system, config, benchmark, replicate));
  const member = (label: string, unit: Unit, arm: string): Member => ({ label, unit, arm });
  const vendorPairs = (baseline: string, arm: string, benchmark: string) => VENDORS.map(v => ({ id: `${v}:${benchmark}`, system: member(`${v} common`, get(v, 'common', benchmark), arm), gbrain: member(`${baseline} common`, get(baseline, 'common', benchmark), arm) }));
  const families: FamilyResult[] = [
    runFamily({ id: 'primary', role: 'primary family (LongMemEval-S, 8,000 tokens of native evidence, QA service quality, gbrain-shootout common at frozen master)', benchmark: 'lme-s', metric: 'qa_service', cluster: 'question', holm: true, pairs: vendorPairs(MASTER, PRIMARY_ARM, 'lme-s') }),
    runFamily({ id: 'pin', role: 'secondary link: the same five pairs against gbrain-shootout common at the repository pin', benchmark: 'lme-s', metric: 'qa_service', cluster: 'question', holm: true, pairs: vendorPairs(PIN, PRIMARY_ARM, 'lme-s') }),
    runFamily({ id: 'S1', role: 'S1 strict recall (recall_all@5), same pairs and arm, systems with measurable provenance', benchmark: 'lme-s', metric: 'recall_all_at_5', cluster: 'question', holm: true, pairs: vendorPairs(MASTER, PRIMARY_ARM, 'lme-s') }),
    runFamily({ id: 'S2', role: 'S2 D1 controls: gbrain-shootout common (master) in the rehydrated context against each control', benchmark: 'lme-s', metric: 'qa_service', cluster: 'question', holm: true,
      pairs: CONTROL_PAIRS.map(c => ({ id: `${c.control}:${c.arm}`, system: member(`${c.control} (${c.arm})`, get(c.control, 'control', 'lme-s'), c.arm), gbrain: member(`gbrain-shootout-master common (${c.gbrainArm})`, get(MASTER, 'common', 'lme-s'), c.gbrainArm) })) }),
  ];
  const descriptive: Report['descriptive'] = [];
  for (const benchmark of ['locomo', 'beam-100k']) {
    const others = [...units.values()].filter(u => u.benchmark === benchmark && u.replicate === 1 && u.system !== MASTER && u.system !== 'gbrain-legacy' && u.system !== 'no-memory' && u.system !== 'full-context');
    for (const u of others.sort((x, y) => x.key < y.key ? -1 : 1)) {
      const config = u.config === 'control' ? 'common' : u.config;
      const g = get(MASTER, config, benchmark);
      const arm = PRIMARY_ARM;
      const label = u.system === PIN ? `gbrain-shootout ${u.config} at the pin` : `${u.system} ${u.config}`;
      const fam = runFamily({ id: `desc:${u.key}`, role: 'descriptive', benchmark, metric: 'qa_service', cluster: 'conversation', holm: false, pairs: [{ id: label, system: member(label, u, arm), gbrain: member(`${MASTER} ${config}`, g, arm) }] });
      const p = fam.pairs[0];
      const conv = u.status === 'settled' ? new Set(rowsOf(member('', u, arm)).map(r => r.conversation)).size : benchmark === 'locomo' ? 3 : 6;
      const a = p.status === 'tested' ? p.mean_system! : null, b = p.status === 'tested' ? p.mean_gbrain! : null;
      descriptive.push({ benchmark, arm, system: u.system, config: u.config, gbrain: `${MASTER} ${config}`, conversations: conv, a, b, paired: p.status === 'tested' ? p : null, sentence: descriptiveSentence(benchmark, conv, label, a, b) });
    }
  }
  const run_to_run: Report['run_to_run'] = [];
  for (const u2 of [...units.values()].filter(u => u.replicate === 2).sort((x, y) => x.key < y.key ? -1 : 1)) {
    const u1 = get(u2.system, u2.config, u2.benchmark, 1);
    for (const policy of ['fixed-evidence', 'vendor-default']) {
      if (u1.status !== 'settled' || u2.status !== 'settled') { run_to_run.push({ system: u2.system, config: u2.config, policy, r1: null, r2: null, questions: 0, identical_share: null, status: 'pending' }); continue; }
      const r1 = new Map(rowsOf(member('', u1, `${policy}.native.${policy === 'fixed-evidence' ? 'b8000' : 'bnone'}.main`)).map(r => [r.id, recallValue(r).value]));
      const r2 = new Map(rowsOf(member('', u2, `${policy}.retrieval`)).map(r => [r.id, recallValue(r).value]));
      const both = [...r1.keys()].filter(id => r1.get(id) !== null && r2.get(id) !== null && r2.get(id) !== undefined);
      run_to_run.push({ system: u2.system, config: u2.config, policy, r1: round(mean(both.map(id => r1.get(id)!))), r2: round(mean(both.map(id => r2.get(id)!))), questions: both.length,
        identical_share: both.length ? round(both.filter(id => r1.get(id) === r2.get(id)).length / both.length) : null, status: both.length ? 'settled' : 'no recall' });
    }
  }
  const prov = (label: string) => { const v = label.split(' ')[0]; const u = get(v, 'common', 'lme-s'); return u.status === 'settled' ? `provenance ${capabilitiesOf(u).provenance?.status ?? 'unknown'}` : 'pending'; };
  const primary = families[0];
  const winners = new Set(primary.pairs.map(p => p.reading));
  return {
    kind: 'oss-shootout-phase4-report', schema_version: 1, generated_at: new Date().toISOString(), results_dir: meta.resultsDir, campaign_sha256: meta.campaignSha,
    method: {
      attempts: 'latest settled attempt per cell; attempts listed in the results README Status table are failed, listed and never used; a cell without a usable attempt is pending',
      qa: 'service quality: judge score, product failures (retrieval_error, unsupported) as 0, ingest_degraded keeps its score, harness failures and missing rows excluded; completed-call quality: mean over scored rows',
      recall: 'recall_all@5 and @10 over non-abstention questions with gold sessions and no harness failure, product failures as 0; not measurable when no row carries it; not applicable for full-context and no-memory',
      families: `crossSystemExclusion over every settled run in the family, pairObservations, clusteredPairedDelta (seed ${SEED}, ${DRAWS} draws, delta = system minus gbrain), p_two_sided, holmAdjusted over the tested pairs; incomplete above 5% excluded or with an invalid or partial arm; ceiling when both are at or above 95%; a family with a pending pair is provisional`,
      mdd: `powerNote at alpha ${ALPHA} from the cluster-robust standard error`,
      s2: 'control minus gbrain-shootout common (master); full-context and plain-hybrid rehydrated arms meet the gbrain rehydrated arm of the same policy, no-memory meets fixed-evidence.rehydrated.b8000.main',
      descriptive: 'LoCoMo dev replicate 1 and BEAM-100K dev, arm fixed-evidence.native.b8000.main, each row against gbrain-shootout at frozen master in the same configuration (controls against common), conversations as clusters, no tests',
      minutes: 'ingest minutes are not recorded in the committed receipts; cell_wall_minutes is each cell receipt\'s start to finish, reading included',
    },
    attempts, units: [...units.values()].sort((x, y) => x.key < y.key ? -1 : 1).map(summarizeUnit), families, descriptive, run_to_run,
    sentences: {
      primary: primarySentences(primary), pin: primarySentences(families[1], 'gbrain at the pin (739e5cc)'), s1: recallSentences(families[2], prov),
      s2: families[3].pairs.map(p => p.status === 'tested' ? `${p.system}: ${pct(p.mean_system!)}% vs gbrain ${pct(p.mean_gbrain!)}% (difference ${pts(p.delta!)} points), ${p.reading}${p.p_holm !== undefined ? `, Holm p ${holmText(p.p_holm)}` : ''}.` : `${p.system}: ${p.reading}.`),
      overall: primary.provisional ? 'Provisional: the primary family has pending pairs, so no overall finding is written.'
        : winners.size === 1 && winners.has('system higher') ? 'Every primary comparison favors the vendor systems after Holm.' : winners.size === 1 && winners.has('gbrain higher') ? 'Every primary comparison favors gbrain after Holm.'
        : 'A workload-by-workload finding, not a leaderboard: no system is favored on every primary comparison.',
    },
  };
}

const f3 = (x: number | null | undefined) => x === null || x === undefined ? 'n/a' : x.toFixed(3);
const usd = (x: number | null | undefined) => x === null || x === undefined ? 'n/a' : `$${x.toFixed(2)}`;
const pv = (x: number | undefined) => x === undefined ? 'n/a' : x < 0.001 ? '<0.001' : x.toFixed(3);

export function renderMarkdown(r: Report): string {
  const out: string[] = ['# Open-source memory shootout, Phase 4 analysis', '', `Generated ${r.generated_at} from \`${r.results_dir}\` (campaign ${r.campaign_sha256.slice(0, 8)}). Computed as the preregistration defines; numbers are fractions of 1 unless marked %.`, ''];
  for (const f of r.families) {
    out.push(`## ${f.id}: ${f.role}`, '', `${f.questions} questions, ${f.excluded_questions} excluded from every pair for harness failures${f.provisional ? '; **provisional** (a pair is pending, Holm runs over the pairs that landed)' : ''}.`, '',
      '| Pair | System | gbrain | Delta | 95% interval | p | Holm p | Reading | Pairs | Undefined | MDD |', '|---|---:|---:|---:|---|---:|---:|---|---:|---:|---:|');
    for (const p of f.pairs) out.push(`| ${p.system} | ${f3(p.mean_system)} | ${f3(p.mean_gbrain)} | ${p.delta === undefined ? 'n/a' : (p.delta >= 0 ? '+' : '') + p.delta.toFixed(3)} | ${p.ci95 ? `${p.ci95[0].toFixed(3)} to ${p.ci95[1].toFixed(3)}` : 'n/a'} | ${pv(p.p_two_sided)} | ${pv(p.p_holm)} | ${p.reading} | ${p.n_pairs ?? 'n/a'} | ${p.excluded_undefined} | ${f3(p.mdd)} |`);
    const notes = f.pairs.filter(p => p.reasons.length).map(p => `- ${p.system}: ${p.reasons.join('; ')}`);
    if (notes.length) out.push('', ...notes);
    out.push('');
  }
  out.push('## What the report may say', '', '**Primary family**', '', ...r.sentences.primary.map(s => `- ${s}`), '', '**Secondary link (pin)**', '', ...r.sentences.pin.map(s => `- ${s}`), '', '**Recall (S1)**', '', ...r.sentences.s1.map(s => `- ${s}`), '',
    '**D1 controls (S2)**', '', ...r.sentences.s2.map(s => `- ${s}`), '', '**Descriptive sets**', '', ...r.descriptive.map(d => `- ${d.sentence}`), '', `**Overall**: ${r.sentences.overall}`, '');
  out.push('## Descriptive pairs (conversations as clusters, no tests)', '', '| Benchmark | System | gbrain | System QA | gbrain QA | Delta | 95% interval | Clusters |', '|---|---|---|---:|---:|---:|---|---:|');
  for (const d of r.descriptive) out.push(`| ${d.benchmark} | ${d.system} ${d.config} | ${d.gbrain} | ${f3(d.a)} | ${f3(d.b)} | ${d.paired ? (d.paired.delta! >= 0 ? '+' : '') + d.paired.delta!.toFixed(3) : 'n/a'} | ${d.paired?.ci95 ? `${d.paired.ci95[0].toFixed(3)} to ${d.paired.ci95[1].toFixed(3)}` : 'n/a'} | ${d.paired?.n_clusters ?? 'n/a'} |`);
  out.push('', '## Run-to-run (second LoCoMo ingest, recall_all@5)', '', '| System | Config | Policy | r1 | r2 | Questions | Identical |', '|---|---|---|---:|---:|---:|---:|');
  for (const x of r.run_to_run) out.push(x.status === 'pending' ? `| ${x.system} | ${x.config} | ${x.policy} | pending | | | |` : `| ${x.system} | ${x.config} | ${x.policy} | ${f3(x.r1)} | ${f3(x.r2)} | ${x.questions} | ${f3(x.identical_share)} |`);
  out.push('', '## Every system row and arm', '', 'QA service counts product failures as 0; completed is the mean over scored rows. Recall is strict recall of all gold sessions. Wall minutes are cell start to finish (ingest minutes are not recorded). Cell $ is the settled lease.', '',
    '| Benchmark | System | Config | r | Arm | Status | Outcomes | QA service | Completed | recall_all@5 | @10 | Recall status | Reader in/out tokens | Context tokens | p50 / p95 ms | Query $/q | Ingest $ | Wall min | Cell $ |',
    '|---|---|---|---:|---|---|---|---:|---:|---:|---:|---|---|---:|---|---:|---:|---:|---:|');
  for (const u of r.units) {
    if (u.status === 'pending') { out.push(`| ${u.benchmark} | ${u.system} | ${u.config} | ${u.replicate} | | pending (${u.pending_cells.join(', ')}) | | | | | | | | | | | | | |`); continue; }
    for (const a of u.arms) out.push(`| ${u.benchmark} | ${u.system} | ${u.config} | ${u.replicate} | ${a.arm} | ${a.run_status} | ${Object.entries(a.outcomes).map(([k, v]) => `${k} ${v}`).join(', ')} | ${f3(a.qa_service)} | ${f3(a.qa_completed)} | ${f3(a.recall_all_at_5)} | ${f3(a.recall_all_at_10)} | ${a.recall_status} | ${a.reader_input_tokens ?? 'n/a'} / ${a.reader_output_tokens ?? 'n/a'} | ${a.context_tokens ?? 'n/a'} | ${a.latency_p50_ms ?? 'n/a'} / ${a.latency_p95_ms ?? 'n/a'} | ${a.query_usd_per_question === null ? 'n/a' : `$${a.query_usd_per_question.toFixed(5)}`} | ${usd(u.ingest_usd)} | ${u.cell_wall_minutes ?? 'n/a'} | ${usd(u.cell_usd)} |`);
  }
  out.push('', '## Attempts', '', '| Cell | Used | Failed (listed in the results README) |', '|---|---|---|');
  for (const a of r.attempts) out.push(`| ${a.cell} | ${a.used?.lease ?? 'pending'} | ${a.failed.map(f => `\`${f.lease}\`: ${f.note.slice(0, 120)}`).join('<br>')} |`);
  out.push('');
  return out.join('\n');
}

export function parseArgs(argv: string[]): { results: string; campaign: string; output: string } {
  const allowed = ['--results', '--campaign', '--output'];
  for (let i = 0; i < argv.length; i += 2) if (!allowed.includes(argv[i]) || argv[i + 1] === undefined) throw new Error(`usage: bun eval/runner/shootout-report.ts [--results <dir>] [--campaign <campaign.json>] --output <dir> (got ${argv[i]})`);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const output = one('--output');
  if (!output) throw new Error('--output <dir> is required');
  return { results: resolve(one('--results') ?? DEFAULT_RESULTS), campaign: resolve(one('--campaign') ?? DEFAULT_CAMPAIGN), output: resolve(output) };
}

if (import.meta.main) {
  const a = parseArgs(process.argv.slice(2));
  const { cells, sha256 } = memoryQaCells(a.campaign);
  const { units, attempts } = loadUnits(a.results, cells, readFileSync(join(a.results, 'README.md'), 'utf8'));
  const report = buildReport(units, attempts, { resultsDir: a.results.startsWith(ROOT) ? a.results.slice(ROOT.length + 1) : a.results, campaignSha: sha256 });
  mkdirSync(a.output, { recursive: true });
  writeFileSync(join(a.output, 'shootout-report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(a.output, 'shootout-report.md'), renderMarkdown(report));
  const pending = report.units.filter(u => u.status === 'pending').length;
  process.stderr.write(`[shootout-report] ${report.units.length} system rows (${pending} pending); primary ${report.families[0].provisional ? 'provisional' : 'final'}; ${join(a.output, 'shootout-report.md')}\n`);
}

export type { Outcome };
