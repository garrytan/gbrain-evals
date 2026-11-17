/**
 * engine-bench, stage "same answers": retrieval quality on LongMemEval-S per storage engine, compared per question.
 *
 * The question this stage answers for the Rust engine decision: given the same conversations and the same query, does
 * each engine put the same sessions in its top 5? Every engine (PGLite, Postgres with pgvector, and Rust once a gbrain
 * build carries it) is opened through openEvalEngine, gets a fresh store for each question, imports the question's
 * haystack sessions through gbrain's own importFromContent, and runs keyword, vector and hybrid retrieval at top-k 5
 * with the search config longmemeval.ts pins (PINNED_SEARCH_CONFIG). Scores are recall_all@5 (the official
 * LongMemEval headline: every evidence session is in the top 5) and recall_any@5, with abstention questions excluded
 * from both as the official protocol does. Engines are then compared question by question: the paired difference in
 * recall_all@5 with a cluster bootstrap interval (stats/paired.ts), the questions whose top-5 lists differ and which
 * session ids differ, and the share of questions whose top-5 lists are identical across every engine that ran.
 *
 * Fresh stores, never raw SQL from this runner. longmemeval.ts resets one PGLite with TRUNCATE between questions; the
 * Rust engine refuses raw SQL, so this runner never calls executeRaw. Each question gets a copy of a store that was
 * initialized once per engine: a copied data directory for the embedded engines (PGLite, Rust) and
 * CREATE DATABASE ... TEMPLATE for Postgres (run on the harness's own admin connection to the server, not through the
 * engine). The copy time is reported apart from import and search time. gbrain's own import path still issues raw
 * SQL through the engine at the pinned build (import-file.ts, inside its write transaction), so a Rust build has to
 * serve that path itself before this stage can run on it.
 *
 * Embeddings. The keyword arm needs none and imports with noEmbed. The vector and hybrid arms need real vectors so
 * ANN behaves as it does for users, so they read a content-addressed cache (longmemeval-cache.ts: keyed by model and
 * dimensions, and by input type inside the text hash) through gbrain's __setEmbedTransportForTests seam. The counted
 * run never calls a provider: a cache miss stops the run (EmbedCacheMiss), and every request to a non-loopback host
 * is refused while the run is in flight. The cache is filled once, outside the counted run, by the fill-cache
 * command, which needs an explicit --paid and --budget-run-id and reserves every request in the budget ledger. The
 * count command reports, keylessly, how many characters fill-cache would embed. A plumbing check can run the vector
 * and hybrid arms on a deterministic hash embedder (--plumbing-stub); its scores mean nothing and the receipt says so.
 *
 * Run:
 *   bun eval/runner/engine-bench/lme-recall.ts run --engines pglite,postgres,rust --arms keyword --stratify 9 --pg-url <url>
 *   bun eval/runner/engine-bench/lme-recall.ts run --arms keyword,vector,hybrid --plumbing-stub --limit 3
 *   bun eval/runner/engine-bench/lme-recall.ts count [--stratify N] [--limit N]
 *   bun eval/runner/engine-bench/lme-recall.ts fill-cache --paid --budget-run-id <id> [--budget-ledger <path>]
 *
 * Dataset: ~/datasets/longmemeval/longmemeval_s_cleaned.json from
 * https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned (SHA-256 d6f21ea9...c3a442), the file every
 * published LongMemEval-S run in this repository used.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SQL } from 'bun';
import { embedMany as aiSdkEmbedMany } from 'ai';
import type { BrainEngine } from 'gbrain/engine';
import type { SearchResult } from 'gbrain/types';
import { EvalEngineUnavailable, EVAL_ENGINES, openEvalEngine, type EvalEngineKind } from '../eval-engine.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { PINNED_SEARCH_CONFIG, isAbsQuestion, normalizeSessions, stratifiedSample, sutPages, type Question } from '../longmemeval.ts';
import { EmbeddingCache, makeCachingTransport } from '../longmemeval-cache.ts';
import { assertEmbedded } from '../import-embedded.ts';
import { uniqueInOrder, percentile } from '../metrics.ts';
import { clusteredPairedDelta, exactMcNemar, type PairedItem } from '../stats/paired.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun, type BudgetOptions } from '../budget-ledger.ts';
import { assertPayload, withPermitted } from '../evaluator/allowlist.ts';
import {
  lmeForbiddenValues, lmeSessionMaterial, loadLongMemEvalGold, longMemEvalSutView, scoreLmeRetrieval, LME_SUT_PAGE, LME_SUT_QUERY,
  type LmeSutQuestion,
} from '../evaluator/longmemeval.ts';

export const LME_RECALL_SCHEMA = 'engine-bench.lme-recall/1';
export const LME_RECALL_TOP_K = 5;
export const LME_ARMS = ['keyword', 'vector', 'hybrid'] as const;
export type LmeArm = (typeof LME_ARMS)[number];
export const LME_FULL_RUN_QUESTIONS = 500;
/** SHA-256 of longmemeval_s_cleaned.json (Sept 2025 revision), the file the published LongMemEval-S runs used. */
export const PUBLISHED_LME_S_SHA256 = 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442';
export const BOOTSTRAP = { seed: 20261117, draws: 10_000 } as const;
const REPO_ROOT = resolve(import.meta.dir, '../../..');

export function defaultDatasetPath(): string {
  return join(homedir(), 'datasets', 'longmemeval', 'longmemeval_s_cleaned.json');
}

/** The same file name longmemeval.ts gives its cache for this model, so a cache either runner filled serves both. */
export function defaultCachePath(model: string, dimensions: number): string {
  const key = model + '@' + dimensions;
  return join(REPO_ROOT, 'eval', 'reports', 'longmemeval', 'embed-cache', 'embed-cache-' + key.replace(/[^a-z0-9@-]/gi, '_') + '.sqlite');
}

// ─── gbrain modules, loaded from the build under test ─────────────

type EmbedTransport = (params: { values: string[] } & Record<string, unknown>) => Promise<{ embeddings: number[][]; values?: string[]; warnings?: unknown[]; usage?: unknown }>;

interface GbrainModules {
  importFromContent: (engine: BrainEngine, slug: string, content: string, opts?: { noEmbed?: boolean }) => Promise<{ embedding_deferred?: boolean }>;
  hybridSearch: (engine: BrainEngine, query: string, opts?: { limit?: number; expansion?: boolean }) => Promise<SearchResult[]>;
  embedQuery: (text: string) => Promise<Float32Array>;
  configureGateway: (config: Record<string, unknown>) => void;
  setEmbedTransport: (fn: EmbedTransport | null) => void;
  defaultEmbedding: { model: string; dimensions: number };
}

/** Every gbrain module comes from the build under test, so the transport seam and the import path share one gateway. */
async function loadGbrain(gut: GbrainUnderTest): Promise<GbrainModules> {
  const [imp, hybrid, embedding, gateway] = await Promise.all([
    importGbrain<any>(gut, 'src/core/import-file.ts'),
    importGbrain<any>(gut, 'src/core/search/hybrid.ts'),
    importGbrain<any>(gut, 'src/core/embedding.ts'),
    importGbrain<any>(gut, 'src/core/ai/gateway.ts'),
  ]);
  return {
    importFromContent: imp.importFromContent,
    hybridSearch: hybrid.hybridSearch,
    embedQuery: embedding.embedQuery,
    configureGateway: gateway.configureGateway,
    setEmbedTransport: gateway.__setEmbedTransportForTests,
    defaultEmbedding: { model: gateway.DEFAULT_EMBEDDING_MODEL, dimensions: gateway.DEFAULT_EMBEDDING_DIMENSIONS },
  };
}

// ─── Embedders ─────────────────────────────────────────────────────

export class EmbedCacheMiss extends Error {
  readonly code = 'embed_cache_miss';
  constructor(message: string) { super(message); this.name = 'EmbedCacheMiss'; }
}

/** Deterministic unit vector from sha256 of the text: proves the vector path runs, says nothing about quality. */
export function hashVector(text: string, dimensions: number): number[] {
  const out = new Array<number>(dimensions);
  let block = createHash('sha256').update(text).digest();
  for (let i = 0; i < dimensions; i++) {
    if (i % 32 === 0 && i > 0) block = createHash('sha256').update(block).digest();
    out[i] = block[i % 32] / 255 - 0.5;
  }
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map(x => x / norm);
}

export function stubTransport(dimensions: number): EmbedTransport {
  return async ({ values }) => ({ embeddings: values.map(v => hashVector(v, dimensions)), values, warnings: [] });
}

/** Reads only the cache; any text it lacks throws EmbedCacheMiss instead of reaching a provider. */
function cacheOnlyTransport(cache: EmbeddingCache, cachePath: string, misses: { n: number }): EmbedTransport {
  return makeCachingTransport(async ({ values }) => {
    misses.n += values.length;
    throw new EmbedCacheMiss(values.length + ' text(s) are not in the embedding cache ' + cachePath + '. The counted run never calls a provider; fill the cache with "fill-cache --paid --budget-run-id <id>" first.');
  }, cache) as EmbedTransport;
}

/** Refuse every HTTP(S) request to a non-loopback host until the returned function runs. */
export function refuseNetwork(): () => void {
  const previous = globalThis.fetch;
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !loopback) {
      throw new Error('engine-bench lme-recall makes no provider calls: refused a request to ' + url.host);
    }
    return previous(input, init);
  }) as typeof fetch;
  globalThis.fetch = guarded;
  return () => { if (globalThis.fetch === guarded) globalThis.fetch = previous; };
}

// ─── Stores ────────────────────────────────────────────────────────

interface OpenStore { engine: BrainEngine; close(): Promise<void> }

interface StoreFactory {
  kind: EvalEngineKind;
  strategy: string;
  open(): Promise<OpenStore>;
  dispose(): Promise<void>;
}

function databaseUrlFor(serverUrl: string, database: string): string {
  const u = new URL(serverUrl);
  u.pathname = '/' + database;
  return u.toString();
}

/**
 * Initialize one store per engine, then hand out copies of it. Throws EvalEngineUnavailable when the engine cannot
 * open (the Rust arm today), which the runner reports as a refusal.
 */
async function storeFactory(gut: GbrainUnderTest, kind: EvalEngineKind, workDir: string, postgresUrl: string | undefined): Promise<StoreFactory> {
  if (kind === 'postgres') {
    if (!postgresUrl) throw new EvalEngineUnavailable(kind, 'postgres_url_missing', 'The postgres engine needs a server URL (--pg-url), for example a local pgvector/pgvector:pg16 container.');
    const admin = new SQL(postgresUrl, { max: 1 });
    const prefix = 'eb_lme_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
    const template = prefix + '_tmpl';
    const created: string[] = [template];
    const drop = (db: string) => admin.unsafe('DROP DATABASE IF EXISTS "' + db + '" WITH (FORCE)');
    try {
      await admin.unsafe('CREATE DATABASE "' + template + '"');
      const t = await openEvalEngine({ gut, kind, databaseUrl: databaseUrlFor(postgresUrl, template), poolMax: 2 });
      await t.engine.disconnect();
    } catch (e) {
      await drop(template).catch(() => {});
      await admin.close();
      throw e;
    }
    let n = 0;
    return {
      kind, strategy: 'CREATE DATABASE ... TEMPLATE of a store initialized once (on the harness admin connection, not the engine)',
      async open() {
        const db = prefix + '_q' + (n++);
        created.push(db);
        await admin.unsafe('CREATE DATABASE "' + db + '" TEMPLATE "' + template + '"');
        const { engine } = await openEvalEngine({ gut, kind, databaseUrl: databaseUrlFor(postgresUrl, db), poolMax: 2 });
        return {
          engine,
          async close() {
            try { await engine.disconnect(); } finally { await drop(db); }
          },
        };
      },
      async dispose() {
        for (const db of created) await drop(db).catch(() => {});
        await admin.close();
      },
    };
  }
  const root = mkdtempSync(join(workDir, kind + '-'));
  const template = join(root, 'template');
  try {
    const t = await openEvalEngine({ gut, kind, databasePath: template });
    await t.engine.disconnect();
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  let n = 0;
  return {
    kind, strategy: 'copy of a store initialized once',
    async open() {
      const path = join(root, 'q' + (n++));
      cpSync(template, path, { recursive: true });
      const { engine } = await openEvalEngine({ gut, kind, databasePath: path });
      return {
        engine,
        async close() {
          try { await engine.disconnect(); } finally { rmSync(path, { recursive: true, force: true }); }
        },
      };
    },
    async dispose() { rmSync(root, { recursive: true, force: true }); },
  };
}

// ─── Dataset ───────────────────────────────────────────────────────

export interface LoadedDataset {
  path: string;
  sha256: string;
  questions: LmeSutQuestion[];
  gold: ReturnType<typeof loadLongMemEvalGold>;
  totalQuestions: number;
}

export function loadDataset(datasetPath: string, select: { limit?: number | null; stratify?: number | null; seed?: number }): LoadedDataset {
  if (!existsSync(datasetPath)) {
    throw new Error('LongMemEval-S not found at ' + datasetPath + '. Download longmemeval_s_cleaned.json from https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned');
  }
  const bytes = readFileSync(datasetPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const gold = loadLongMemEvalGold(datasetPath, sha256);
  const all = (JSON.parse(bytes.toString('utf8')) as Question[]).map(longMemEvalSutView);
  let questions = all;
  if (select.stratify) questions = stratifiedSample(questions, select.stratify, select.seed ?? 42);
  if (select.limit) questions = questions.slice(0, select.limit);
  return { path: datasetPath, sha256, questions, gold, totalQuestions: all.length };
}

// ─── Per-question retrieval ───────────────────────────────────────

export interface ArmResult {
  /** Dataset session ids (lowercased), unique, in rank order. */
  retrieved: string[];
  /** null for abstention questions, which the official protocol leaves out of recall. */
  recall_all: number | null;
  recall_any: number | null;
  search_ms: number;
}

export interface QuestionRow {
  engine: EvalEngineKind;
  question_id: string;
  question_type: string;
  is_abs: boolean;
  num_sessions: number;
  arms: Partial<Record<LmeArm, ArmResult>>;
  timing_ms: { open: number; import: number; search: number; total: number };
  error?: string;
}

function sessionIdFromSlug(slug: string): string {
  const i = slug.indexOf('/');
  return i >= 0 ? slug.slice(i + 1) : slug;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('question_timeout_' + ms + 'ms: ' + what)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function importPages(mods: GbrainModules, engine: BrainEngine, pages: Array<{ slug: string; content: string }>, embed: boolean): Promise<void> {
  for (const page of pages) {
    const result = await mods.importFromContent(engine, page.slug, page.content, { noEmbed: !embed });
    if (embed) assertEmbedded(result, page.slug);
  }
}

async function runQuestion(mods: GbrainModules, store: StoreFactory, ds: LoadedDataset, q: LmeSutQuestion, arms: readonly LmeArm[], timeoutMs: number): Promise<QuestionRow> {
  const t0 = performance.now();
  const row: QuestionRow = {
    engine: store.kind, question_id: q.question_id, question_type: q.question_type, is_abs: isAbsQuestion(q.question_id),
    num_sessions: q.haystack_sessions.length, arms: {}, timing_ms: { open: 0, import: 0, search: 0, total: 0 },
  };
  const { pages, originalByOpaque } = sutPages(q);
  const forbidden = lmeForbiddenValues(ds.gold, q.question_id);
  const sessions = normalizeSessions(q);
  pages.forEach((page, p) => assertPayload(LME_SUT_PAGE, page, withPermitted(forbidden, lmeSessionMaterial(sessions[p]))));
  assertPayload(LME_SUT_QUERY, { text: q.question }, withPermitted(forbidden, [q.question]));
  const opened = await withTimeout(store.open(), timeoutMs, 'open');
  try {
    row.timing_ms.open = performance.now() - t0;
    const work = async () => {
      for (const [k, v] of Object.entries(PINNED_SEARCH_CONFIG)) await opened.engine.setConfig(k, v);
      const ti = performance.now();
      await importPages(mods, opened.engine, pages, arms.some(a => a !== 'keyword'));
      row.timing_ms.import = performance.now() - ti;
      for (const arm of arms) {
        const ts = performance.now();
        const results = arm === 'keyword'
          ? await opened.engine.searchKeyword(q.question, { limit: LME_RECALL_TOP_K })
          : arm === 'vector'
            ? await opened.engine.searchVector(await mods.embedQuery(q.question), { limit: LME_RECALL_TOP_K })
            : await mods.hybridSearch(opened.engine, q.question, { limit: LME_RECALL_TOP_K, expansion: false });
        const search_ms = performance.now() - ts;
        const retrieved = uniqueInOrder(results.map(r => sessionIdFromSlug(r.slug))).map(id => originalByOpaque.get(id) ?? id);
        const m = scoreLmeRetrieval(ds.gold, q.question_id, retrieved, LME_RECALL_TOP_K);
        row.arms[arm] = {
          retrieved,
          recall_all: row.is_abs ? null : Number.isFinite(m.recall_all) ? m.recall_all : 0,
          recall_any: row.is_abs ? null : Number.isFinite(m.recall_any) ? m.recall_any : 0,
          search_ms,
        };
        row.timing_ms.search += search_ms;
      }
    };
    await withTimeout(work(), timeoutMs, 'import and search');
  } finally {
    await opened.close().catch(() => {});
  }
  row.timing_ms.total = performance.now() - t0;
  return row;
}

// ─── Comparison ────────────────────────────────────────────────────

export interface Top5Difference {
  question_id: string;
  /** Session ids in A's top 5 and not in B's, and the reverse. Both empty when only the order differs. */
  only_a: string[];
  only_b: string[];
  order_only: boolean;
}

export interface PairComparison {
  arm: LmeArm;
  a: EvalEngineKind;
  b: EvalEngineKind;
  /** Questions both engines answered without error. */
  n_questions: number;
  /** Errored on either side: left out of the paired delta and the top-5 comparison, and listed here. */
  excluded_errors: string[];
  /** recall_all@5, B minus A, over non-abstention questions; null when there are none. */
  recall_all_delta: {
    n_pairs: number; mean_a: number; mean_b: number; delta: number; ci95: [number, number] | null; p_two_sided: number;
    wins_b: number; losses_b: number; mcnemar_p: number;
  } | null;
  identical_top5_ordered: number;
  identical_top5_set: number;
  differences: Top5Difference[];
}

export interface ArmAgreement {
  arm: LmeArm;
  engines: EvalEngineKind[];
  n_questions: number;
  /** Share of questions whose ordered top-5 lists are the same on every engine that ran; null with no shared question. */
  identical_top5_share: number | null;
  identical_top5_set_share: number | null;
}

const top5 = (r: ArmResult | undefined) => (r?.retrieved ?? []).slice(0, LME_RECALL_TOP_K);
const sameOrder = (x: string[], y: string[]) => x.length === y.length && x.every((s, i) => s === y[i]);
const sameSet = (x: string[], y: string[]) => x.length === y.length && x.every(s => y.includes(s));

export function comparePair(rows: readonly QuestionRow[], arm: LmeArm, a: EvalEngineKind, b: EvalEngineKind): PairComparison {
  const byEngine = (k: EvalEngineKind) => new Map(rows.filter(r => r.engine === k).map(r => [r.question_id, r]));
  const ra = byEngine(a), rb = byEngine(b);
  const ids = [...ra.keys()].filter(id => rb.has(id)).sort();
  const usable = (id: string) => ra.get(id)!.error === undefined && rb.get(id)!.error === undefined && !!ra.get(id)!.arms[arm] && !!rb.get(id)!.arms[arm];
  const excluded = ids.filter(id => !usable(id));
  const kept = ids.filter(usable);
  const differences: Top5Difference[] = [];
  let ordered = 0, set = 0;
  const pairs: PairedItem[] = [];
  for (const id of kept) {
    const x = ra.get(id)!.arms[arm]!, y = rb.get(id)!.arms[arm]!;
    const ta = top5(x), tb = top5(y);
    const onlyA = ta.filter(s => !tb.includes(s)), onlyB = tb.filter(s => !ta.includes(s));
    if (sameOrder(ta, tb)) ordered++;
    else differences.push({ question_id: id, only_a: onlyA, only_b: onlyB, order_only: onlyA.length === 0 && onlyB.length === 0 });
    if (sameSet(ta, tb)) set++;
    if (x.recall_all !== null && y.recall_all !== null) pairs.push({ id, cluster: id, a: x.recall_all, b: y.recall_all });
  }
  let delta: PairComparison['recall_all_delta'] = null;
  if (pairs.length > 0) {
    const d = clusteredPairedDelta(pairs, BOOTSTRAP);
    const mc = exactMcNemar(pairs);
    delta = { n_pairs: d.n_pairs, mean_a: d.mean_a, mean_b: d.mean_b, delta: d.delta, ci95: d.ci95, p_two_sided: d.p_two_sided, wins_b: mc.wins, losses_b: mc.losses, mcnemar_p: mc.p_two_sided };
  }
  return {
    arm, a, b, n_questions: kept.length, excluded_errors: excluded, recall_all_delta: delta,
    identical_top5_ordered: kept.length ? ordered / kept.length : 0,
    identical_top5_set: kept.length ? set / kept.length : 0,
    differences,
  };
}

export function armAgreement(rows: readonly QuestionRow[], arm: LmeArm, engines: readonly EvalEngineKind[]): ArmAgreement {
  const ids = [...new Set(rows.map(r => r.question_id))].sort();
  let n = 0, ordered = 0, set = 0;
  for (const id of ids) {
    const found = engines.map(k => rows.find(r => r.engine === k && r.question_id === id));
    if (found.some(r => !r || r.error !== undefined || !r.arms[arm])) continue;
    n++;
    const tops = found.map(r => top5(r!.arms[arm]));
    if (tops.every(t => sameOrder(t, tops[0]))) ordered++;
    if (tops.every(t => sameSet(t, tops[0]))) set++;
  }
  return { arm, engines: [...engines], n_questions: n, identical_top5_share: n ? ordered / n : null, identical_top5_set_share: n ? set / n : null };
}

// ─── Receipt ───────────────────────────────────────────────────────

export type EmbedderMode = 'none' | 'cache' | 'plumbing-stub';

export interface EngineSummary {
  kind: EvalEngineKind;
  status: 'ran' | 'refused' | 'error';
  reason?: string;
  message?: string;
  store_strategy?: string;
  n_questions: number;
  n_errors: number;
  errors: Array<{ question_id: string; error: string }>;
  recall: Partial<Record<LmeArm, { recall_all_at_5: number | null; recall_any_at_5: number | null; n_scored: number }>>;
  timing_ms?: {
    total: { mean: number; p50: number; p90: number; max: number };
    open: { mean: number; p50: number };
    import: { mean: number; p50: number; p90: number };
    search_by_arm: Partial<Record<LmeArm, { mean: number; p50: number }>>;
  };
  /** Mean total time per question times 500, in minutes: a full LongMemEval-S run on this engine in one process. */
  projected_full_run_minutes?: number;
}

export interface LmeRecallReceipt {
  schema: typeof LME_RECALL_SCHEMA;
  started_at: string;
  finished_at: string;
  gbrain: { version: string; overlay: Record<string, unknown> | null };
  dataset: {
    file: string; sha256: string; matches_published_sha256: boolean; total_questions: number; selected: number; abstention_selected: number;
    stratify: number | null; limit: number | null; seed: number; question_ids: string[];
  };
  top_k: number;
  arms: LmeArm[];
  search_config: Record<string, string>;
  embedder: { mode: EmbedderMode; model: string | null; dimensions: number | null; cache_path: string | null; plumbing_only: boolean; note: string };
  network: string;
  engines: EngineSummary[];
  comparisons: PairComparison[];
  agreement: ArmAgreement[];
  bootstrap: typeof BOOTSTRAP;
  rows: QuestionRow[];
}

const round = (x: number) => Math.round(x * 10) / 10;

function stats(values: number[]) {
  const mean = values.length ? values.reduce((s, x) => s + x, 0) / values.length : NaN;
  return { mean: round(mean), p50: round(percentile(values, 50)), p90: round(percentile(values, 90)), max: round(values.length ? Math.max(...values) : NaN) };
}

function summarizeEngine(kind: EvalEngineKind, strategy: string, rows: QuestionRow[], arms: readonly LmeArm[]): EngineSummary {
  const ok = rows.filter(r => r.error === undefined);
  const recall: EngineSummary['recall'] = {};
  const search_by_arm: NonNullable<EngineSummary['timing_ms']>['search_by_arm'] = {};
  for (const arm of arms) {
    const scored = ok.filter(r => !r.is_abs && r.arms[arm]);
    const mean = (f: (x: ArmResult) => number | null) => scored.length ? scored.reduce((s, r) => s + (f(r.arms[arm]!) ?? 0), 0) / scored.length : null;
    recall[arm] = { recall_all_at_5: mean(x => x.recall_all), recall_any_at_5: mean(x => x.recall_any), n_scored: scored.length };
    const s = stats(ok.filter(r => r.arms[arm]).map(r => r.arms[arm]!.search_ms));
    search_by_arm[arm] = { mean: s.mean, p50: s.p50 };
  }
  const total = stats(ok.map(r => r.timing_ms.total));
  const open = stats(ok.map(r => r.timing_ms.open));
  const imp = stats(ok.map(r => r.timing_ms.import));
  return {
    kind, status: 'ran', store_strategy: strategy, n_questions: rows.length, n_errors: rows.length - ok.length,
    errors: rows.filter(r => r.error !== undefined).map(r => ({ question_id: r.question_id, error: r.error! })),
    recall,
    timing_ms: { total, open: { mean: open.mean, p50: open.p50 }, import: { mean: imp.mean, p50: imp.p50, p90: imp.p90 }, search_by_arm },
    ...(ok.length ? { projected_full_run_minutes: round(total.mean * LME_FULL_RUN_QUESTIONS / 60_000) } : {}),
  };
}

const PROVIDER_KEY: Record<string, string> = { openai: 'OPENAI_API_KEY', voyage: 'VOYAGE_API_KEY' };

/**
 * The gateway refuses to embed without the provider's key even when the transport is replaced, so keyless modes hand
 * it a placeholder. The transport never reaches a provider and every non-loopback request is refused, so the
 * placeholder is never sent anywhere.
 */
function placeholderKeyEnv(model: string): Record<string, string> {
  const key = PROVIDER_KEY[model.includes(':') ? model.slice(0, model.indexOf(':')) : 'openai'];
  return key ? { [key]: 'engine-bench-placeholder-never-sent' } : {};
}

function configureEmbedding(mods: GbrainModules, embedding: { model: string; dimensions: number }, env: Record<string, string | undefined>): void {
  mods.configureGateway({ embedding_model: embedding.model, embedding_dimensions: embedding.dimensions, env });
}

// ─── runLmeRecall ──────────────────────────────────────────────────

export interface RunLmeRecallOptions {
  gut: GbrainUnderTest;
  engines: readonly EvalEngineKind[];
  postgresUrl?: string;
  datasetPath?: string;
  /** Embedding cache file for the vector and hybrid arms; defaults to defaultCachePath(model, dimensions). */
  cachePath?: string;
  limit?: number | null;
  /** Questions per question type (longmemeval.ts stratifiedSample), applied before limit. */
  stratify?: number | null;
  seed?: number;
  arms?: readonly LmeArm[];
  /** 'plumbing-stub' swaps the cache for hash vectors: the plumbing runs, the scores mean nothing. */
  embedder?: 'cache' | 'plumbing-stub';
  /** Defaults to gbrain's default embedding at the build under test (voyage:voyage-4 at 1024 dimensions today). */
  embedding?: { model: string; dimensions: number };
  workDir?: string;
  perQuestionTimeoutMs?: number;
  log?: (line: string) => void;
}

export async function runLmeRecall(o: RunLmeRecallOptions): Promise<LmeRecallReceipt> {
  const started_at = new Date().toISOString();
  const log = o.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const arms = [...(o.arms ?? LME_ARMS)];
  for (const a of arms) if (!(LME_ARMS as readonly string[]).includes(a)) throw new Error('unknown arm ' + a + '; use ' + LME_ARMS.join(', '));
  for (const k of o.engines) if (!(EVAL_ENGINES as readonly string[]).includes(k)) throw new Error('unknown engine ' + k + '; use ' + EVAL_ENGINES.join(', '));
  const seed = o.seed ?? 42;
  const ds = loadDataset(o.datasetPath ?? defaultDatasetPath(), { limit: o.limit, stratify: o.stratify, seed });
  const mods = await loadGbrain(o.gut);
  const embedding = o.embedding ?? mods.defaultEmbedding;
  const needsVectors = arms.some(a => a !== 'keyword');
  const mode: EmbedderMode = needsVectors ? o.embedder ?? 'cache' : 'none';
  const cachePath = mode === 'cache' ? o.cachePath ?? defaultCachePath(embedding.model, embedding.dimensions) : null;
  if (cachePath !== null && !existsSync(cachePath)) {
    throw new EmbedCacheMiss('no embedding cache at ' + cachePath + '. The counted run reads only the cache; fill it with "fill-cache --paid --budget-run-id <id>" first.');
  }
  const cache = cachePath === null ? null : new EmbeddingCache(cachePath, embedding.model + '@' + embedding.dimensions);
  const misses = { n: 0 };
  const workDir = o.workDir ?? mkdtempSync(join(tmpdir(), 'engine-bench-lme-'));
  const restoreNetwork = refuseNetwork();
  configureEmbedding(mods, embedding, placeholderKeyEnv(embedding.model));
  mods.setEmbedTransport(cache !== null ? cacheOnlyTransport(cache, cachePath!, misses)
    : mode === 'plumbing-stub' ? stubTransport(embedding.dimensions)
      : async () => { throw new Error('the keyword arm embeds nothing'); });
  const factories: StoreFactory[] = [];
  const summaries: EngineSummary[] = [];
  const rows: QuestionRow[] = [];
  try {
    for (const kind of o.engines) {
      try {
        factories.push(await storeFactory(o.gut, kind, workDir, o.postgresUrl));
        log('[lme-recall] ' + kind + ': store template ready');
      } catch (e) {
        const refused = e instanceof EvalEngineUnavailable;
        summaries.push({ kind, status: refused ? 'refused' : 'error', reason: refused ? e.reason : 'store_init_failed', message: (e as Error).message, n_questions: 0, n_errors: 0, errors: [], recall: {} });
        log('[lme-recall] ' + kind + ' ' + (refused ? 'refused (' + e.reason + ')' : 'failed') + ': ' + (e as Error).message);
      }
    }
    const timeout = o.perQuestionTimeoutMs ?? 600_000;
    for (let i = 0; i < ds.questions.length; i++) {
      const q = ds.questions[i];
      for (const f of factories) {
        try {
          rows.push(await runQuestion(mods, f, ds, q, arms, timeout));
        } catch (e) {
          if (misses.n > 0 || e instanceof EmbedCacheMiss) {
            throw new EmbedCacheMiss(misses.n + ' text(s) for ' + q.question_id + ' are missing from the embedding cache ' + cachePath + '. The counted run stopped instead of calling a provider; fill the cache first.');
          }
          rows.push({
            engine: f.kind, question_id: q.question_id, question_type: q.question_type, is_abs: isAbsQuestion(q.question_id),
            num_sessions: q.haystack_sessions.length, arms: {}, timing_ms: { open: 0, import: 0, search: 0, total: 0 }, error: (e as Error).message,
          });
        }
      }
      if ((i + 1) % 5 === 0 || i === ds.questions.length - 1) {
        log('[lme-recall] ' + (i + 1) + '/' + ds.questions.length + ' ' + factories.map(f => {
          const done = rows.filter(x => x.engine === f.kind && x.error === undefined);
          return f.kind + ' ' + (done.reduce((s, x) => s + x.timing_ms.total, 0) / Math.max(1, done.length) / 1000).toFixed(2) + 's/question';
        }).join(', '));
      }
    }
  } finally {
    for (const f of factories) await f.dispose().catch(() => {});
    mods.setEmbedTransport(null);
    restoreNetwork();
    cache?.close();
    if (!o.workDir) rmSync(workDir, { recursive: true, force: true });
  }
  for (const f of factories) summaries.push(summarizeEngine(f.kind, f.strategy, rows.filter(r => r.engine === f.kind), arms));
  summaries.sort((x, y) => o.engines.indexOf(x.kind) - o.engines.indexOf(y.kind));
  const ran = summaries.filter(s => s.status === 'ran').map(s => s.kind);
  const comparisons: PairComparison[] = [];
  for (const arm of arms) for (let i = 0; i < ran.length; i++) for (let j = i + 1; j < ran.length; j++) comparisons.push(comparePair(rows, arm, ran[i], ran[j]));
  return {
    schema: LME_RECALL_SCHEMA,
    started_at, finished_at: new Date().toISOString(),
    gbrain: { version: o.gut.version, overlay: overlaySummary(o.gut) },
    dataset: {
      file: basename(ds.path), sha256: ds.sha256, matches_published_sha256: ds.sha256 === PUBLISHED_LME_S_SHA256, total_questions: ds.totalQuestions,
      selected: ds.questions.length, abstention_selected: ds.questions.filter(q => isAbsQuestion(q.question_id)).length,
      stratify: o.stratify ?? null, limit: o.limit ?? null, seed, question_ids: ds.questions.map(q => q.question_id),
    },
    top_k: LME_RECALL_TOP_K, arms, search_config: { ...PINNED_SEARCH_CONFIG },
    embedder: {
      mode, model: needsVectors ? embedding.model : null, dimensions: needsVectors ? embedding.dimensions : null, cache_path: cachePath, plumbing_only: mode === 'plumbing-stub',
      note: mode === 'plumbing-stub'
        ? 'PLUMBING CHECK: vectors are sha256 hashes of the text, not embeddings. Vector and hybrid scores here mean nothing; they only show the pipeline runs on each engine.'
        : mode === 'cache' ? 'Vectors came from the content-addressed cache only; a miss stops the run and no provider was called.' : 'Keyword arm only; nothing was embedded.',
    },
    network: 'every HTTP(S) request to a non-loopback host was refused during the run',
    engines: summaries,
    comparisons,
    agreement: arms.map(arm => armAgreement(rows, arm, ran)),
    bootstrap: BOOTSTRAP,
    rows,
  };
}

// ─── count and fill-cache ──────────────────────────────────────────

export interface EmbedPlan {
  model: string;
  dimensions: number;
  questions: number;
  /** Distinct (input type, text) pairs the vector and hybrid arms embed for these questions. */
  texts: number;
  texts_cached: number;
  texts_to_embed: number;
  chars_to_embed: number;
  /** gbrain's own estimate, ceil(chars / 3.5) (embedding-pricing.ts estimateCostFromChars); the provider's tokenizer decides the bill. */
  est_tokens_to_embed: number;
  price_per_mtok_usd: number | null;
  est_usd: number | null;
}

/**
 * Drive the exact import and query-embedding path of the vector and hybrid arms on a scratch PGLite store, so the
 * gateway's embed transport sees every text those arms embed. count passes a recording stub; fill-cache passes the
 * cache over the real provider.
 */
async function walkEmbeddings(o: { gut: GbrainUnderTest; mods: GbrainModules; ds: LoadedDataset; workDir: string; log: (l: string) => void }): Promise<void> {
  const f = await storeFactory(o.gut, 'pglite', o.workDir, undefined);
  try {
    for (let i = 0; i < o.ds.questions.length; i++) {
      const q = o.ds.questions[i];
      const store = await f.open();
      try {
        await importPages(o.mods, store.engine, sutPages(q).pages, true);
        await o.mods.embedQuery(q.question);
      } finally {
        await store.close();
      }
      if ((i + 1) % 25 === 0 || i === o.ds.questions.length - 1) o.log('[lme-recall] walked ' + (i + 1) + '/' + o.ds.questions.length + ' questions');
    }
  } finally {
    await f.dispose();
  }
}

const inputSide = (params: Record<string, unknown>): 'query' | 'document' =>
  (params.providerOptions as { openaiCompatible?: { input_type?: unknown } } | undefined)?.openaiCompatible?.input_type === 'query' ? 'query' : 'document';

export interface CountOptions {
  gut: GbrainUnderTest;
  datasetPath?: string;
  cachePath?: string;
  limit?: number | null;
  stratify?: number | null;
  seed?: number;
  embedding?: { model: string; dimensions: number };
  log?: (l: string) => void;
}

/** Keyless: what fill-cache would embed for these questions, counted from the dataset through gbrain's own chunking. */
export async function countEmbedPlan(o: CountOptions): Promise<EmbedPlan> {
  const log = o.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const ds = loadDataset(o.datasetPath ?? defaultDatasetPath(), { limit: o.limit, stratify: o.stratify, seed: o.seed ?? 42 });
  const mods = await loadGbrain(o.gut);
  const embedding = o.embedding ?? mods.defaultEmbedding;
  const cachePath = o.cachePath ?? defaultCachePath(embedding.model, embedding.dimensions);
  const cache = existsSync(cachePath) ? new EmbeddingCache(cachePath, embedding.model + '@' + embedding.dimensions) : null;
  const seen = new Map<string, { chars: number; cached: boolean }>();
  const stub = stubTransport(embedding.dimensions);
  const workDir = mkdtempSync(join(tmpdir(), 'engine-bench-lme-count-'));
  const restoreNetwork = refuseNetwork();
  configureEmbedding(mods, embedding, placeholderKeyEnv(embedding.model));
  mods.setEmbedTransport(async params => {
    const side = inputSide(params);
    for (const v of params.values) {
      const key = side + ':' + createHash('sha256').update(v).digest('hex');
      if (!seen.has(key)) seen.set(key, { chars: v.length, cached: cache?.get(v, side) != null });
    }
    return stub(params);
  });
  try {
    await walkEmbeddings({ gut: o.gut, mods, ds, workDir, log });
  } finally {
    mods.setEmbedTransport(null);
    restoreNetwork();
    cache?.close();
    rmSync(workDir, { recursive: true, force: true });
  }
  const todo = [...seen.values()].filter(x => !x.cached);
  const chars = todo.reduce((s, x) => s + x.chars, 0);
  const tokens = Math.ceil(chars / 3.5);
  const { lookupEmbeddingPrice } = await importGbrain<any>(o.gut, 'src/core/embedding-pricing.ts');
  const price = lookupEmbeddingPrice(embedding.model);
  const perM = price.kind === 'known' ? price.pricePerMTok as number : null;
  return {
    model: embedding.model, dimensions: embedding.dimensions, questions: ds.questions.length, texts: seen.size,
    texts_cached: seen.size - todo.length, texts_to_embed: todo.length, chars_to_embed: chars, est_tokens_to_embed: tokens,
    price_per_mtok_usd: perM, est_usd: perM === null ? null : Number((tokens / 1_000_000 * perM).toFixed(4)),
  };
}

export interface FillCacheOptions extends CountOptions {
  /** Must be true: fill-cache is the one paid step and never runs by default. */
  paid: boolean;
  budget: BudgetOptions;
  /** The provider transport; defaults to the AI SDK's embedMany. Tests pass a stub. */
  transport?: EmbedTransport;
  /** Environment the gateway reads provider keys from; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * The paid step, outside every counted run: embed what the vector and hybrid arms need into the cache. It joins a
 * budget-ledger run that is already open (--budget-run-id), so every provider request is reserved before it leaves
 * the process and the run's budget caps it.
 */
export async function fillCache(o: FillCacheOptions): Promise<{ plan: EmbedPlan; cache_path: string; cache_entries: number; cost: ReturnType<typeof receiptCost> }> {
  if (!o.paid) throw new Error('fill-cache calls a paid embedding provider; pass --paid to confirm.');
  if (!o.budget.runId) throw new Error('fill-cache needs --budget-run-id <id>: open a run first with "bun eval/runner/budget-ledger.ts open --runner engine-bench-lme-recall --budget-usd <n>".');
  const log = o.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const plan = await countEmbedPlan({ ...o, log });
  log('[lme-recall] fill-cache plan: ' + plan.texts_to_embed + ' texts, ' + plan.chars_to_embed + ' chars, about ' + plan.est_tokens_to_embed + ' tokens');
  const ds = loadDataset(o.datasetPath ?? defaultDatasetPath(), { limit: o.limit, stratify: o.stratify, seed: o.seed ?? 42 });
  const mods = await loadGbrain(o.gut);
  const embedding = o.embedding ?? mods.defaultEmbedding;
  const cachePath = o.cachePath ?? defaultCachePath(embedding.model, embedding.dimensions);
  const { run, guard } = startPaidRun('engine-bench-lme-recall-fill', { ...o.budget, estimateUsd: plan.est_usd, log });
  const cache = new EmbeddingCache(cachePath, embedding.model + '@' + embedding.dimensions);
  const workDir = mkdtempSync(join(tmpdir(), 'engine-bench-lme-fill-'));
  try {
    configureEmbedding(mods, embedding, o.env ?? { ...process.env });
    const real = o.transport ?? (async (params: { values: string[] } & Record<string, unknown>) =>
      aiSdkEmbedMany(params as unknown as Parameters<typeof aiSdkEmbedMany>[0]) as unknown as Promise<{ embeddings: number[][] }>);
    mods.setEmbedTransport(makeCachingTransport(real, cache) as EmbedTransport);
    await walkEmbeddings({ gut: o.gut, mods, ds, workDir, log });
    return { plan, cache_path: cachePath, cache_entries: cache.size(), cost: receiptCost(run.summary()) };
  } finally {
    mods.setEmbedTransport(null);
    guard.uninstall();
    run.close();
    cache.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ─── CLI ───────────────────────────────────────────────────────────

function flag(argv: readonly string[], name: string): string | null {
  const eq = argv.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const num = (v: string | null) => (v === null ? null : Number(v));
const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean);

export const USAGE = [
  'usage: bun eval/runner/engine-bench/lme-recall.ts <run|count|fill-cache> [options]',
  '  run         [--engines pglite,postgres,rust] [--arms keyword,vector,hybrid] [--pg-url <url>] [--plumbing-stub] [--out <file>]',
  '  count       print what fill-cache would embed, keyless',
  '  fill-cache  --paid --budget-run-id <id> [--budget-ledger <path>]   the one paid step, never part of a counted run',
  '  shared      [--dataset <path>] [--cache <path>] [--limit N] [--stratify N] [--seed N] [--gbrain <checkout>@<ref>]',
].join('\n');

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0];
  if (cmd !== 'run' && cmd !== 'count' && cmd !== 'fill-cache') {
    process.stderr.write(USAGE + '\n');
    return cmd === '--help' ? 0 : 2;
  }
  const shared = {
    gut: resolveGbrainUnderTest(gbrainSpecFrom(argv)),
    datasetPath: flag(argv, '--dataset') ?? undefined, cachePath: flag(argv, '--cache') ?? undefined,
    limit: num(flag(argv, '--limit')), stratify: num(flag(argv, '--stratify')), seed: num(flag(argv, '--seed')) ?? 42,
  };
  if (cmd === 'count') {
    process.stdout.write(JSON.stringify(await countEmbedPlan(shared), null, 2) + '\n');
    return 0;
  }
  if (cmd === 'fill-cache') {
    process.stdout.write(JSON.stringify(await fillCache({ ...shared, paid: argv.includes('--paid'), budget: budgetOptionsFrom(argv) }), null, 2) + '\n');
    return 0;
  }
  const receipt = await runLmeRecall({
    ...shared,
    engines: list(flag(argv, '--engines') ?? EVAL_ENGINES.join(',')) as EvalEngineKind[],
    arms: list(flag(argv, '--arms') ?? LME_ARMS.join(',')) as LmeArm[],
    postgresUrl: flag(argv, '--pg-url') ?? undefined,
    embedder: argv.includes('--plumbing-stub') ? 'plumbing-stub' : 'cache',
  });
  const out = flag(argv, '--out') ?? join(REPO_ROOT, 'eval', 'reports', 'engine-bench', 'lme-recall-' + receipt.started_at.replace(/[:.]/g, '-') + '.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
  const { rows: _rows, comparisons, ...head } = receipt;
  process.stdout.write(JSON.stringify({ ...head, comparisons: comparisons.map(({ differences, ...c }) => ({ ...c, n_differences: differences.length })) }, null, 2) + '\n');
  process.stderr.write('[lme-recall] receipt: ' + out + '\n');
  return 0;
}

if (import.meta.main) {
  main().then(code => process.exit(code), e => { process.stderr.write('[lme-recall] ' + ((e as Error).stack ?? String(e)) + '\n'); process.exit(1); });
}
