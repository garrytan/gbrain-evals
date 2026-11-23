/**
 * engine-bench, stage "same answers": retrieval quality on LongMemEval-S per storage engine, compared per question.
 *
 * The question this stage answers for the Rust engine decision: given the same conversations and the same query, does
 * each engine put the same sessions in its top 5? Every engine (PGLite, Postgres with pgvector, and Rust once a gbrain
 * build carries it) is opened through openEvalEngine, gets a fresh store for each question, imports the question's
 * haystack sessions through gbrain's own importFromContent, and runs keyword, vector and hybrid retrieval at top-k 5
 * through gbrain's hybridSearch, the keyword arm on its keyless path (embeddings opted out, with the any-word fill the
 * search operation asks for) as a brain with no embedding provider searches, with the search config longmemeval.ts pins (PINNED_SEARCH_CONFIG). Scores are recall_all@5 (the official
 * LongMemEval headline: every evidence session is in the top 5) and recall_any@5, with abstention questions excluded
 * from both as the official protocol does. Engines are then compared question by question: the paired difference in
 * recall_all@5 with a cluster bootstrap interval (stats/paired.ts), the questions whose top-5 lists differ and which
 * session ids differ, and the share of questions whose top-5 lists are identical across every engine that ran, with
 * the number of those where every engine returned nothing.
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
 * Counted runs. With no --dev a run is counted, as in perf.ts: it refuses to start unless --prereg names a committed,
 * unchanged preregistration that is on origin, refuses at a one-minute load average above 2, refuses the plumbing stub,
 * and stops at the first cache miss. The attestation goes into the receipt, into the run configuration hash (so counted
 * and dev rows never mix in one NDJSON stream) and as one line into each NDJSON shard, which aggregate carries forward.
 *
 * Run:
 *   bun eval/runner/engine-bench/lme-recall.ts run --dev --engines pglite,postgres,rust --arms keyword --stratify 9 --pg-url <url>
 *   bun eval/runner/engine-bench/lme-recall.ts run --dev --arms keyword,vector,hybrid --plumbing-stub --limit 3
 *   bun eval/runner/engine-bench/lme-recall.ts run --prereg <path> --pg-url <url>
 *   bun eval/runner/engine-bench/lme-recall.ts count [--stratify N] [--limit N]
 *   bun eval/runner/engine-bench/lme-recall.ts fill-cache --paid --budget-run-id <id> [--budget-ledger <path>]
 *
 * Dataset: ~/datasets/longmemeval/longmemeval_s_cleaned.json from
 * https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned (SHA-256 d6f21ea9...c3a442), the file every
 * published LongMemEval-S run in this repository used.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, loadavg, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SQL } from 'bun';
import { embedMany as aiSdkEmbedMany } from 'ai';
import type { BrainEngine } from 'gbrain/engine';
import type { SearchResult } from 'gbrain/types';
import { EvalEngineUnavailable, EVAL_ENGINES, openEvalEngine, rustAddonIdentity, type EvalEmbedding, type EvalEngineKind, type RustAddonIdentity } from '../eval-engine.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { PINNED_SEARCH_CONFIG, canonicalJson, isAbsQuestion, normalizeSessions, stratifiedSample, sutPages, type Question } from '../longmemeval.ts';
import { EmbeddingCache, makeCachingTransport } from '../longmemeval-cache.ts';
import { writeScrubbedJson } from '../receipt.ts';
import { assertEmbedded } from '../import-embedded.ts';
import { uniqueInOrder, percentile } from '../metrics.ts';
import { clusteredPairedDelta, exactMcNemar, type PairedItem } from '../stats/paired.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun, type BudgetOptions } from '../budget-ledger.ts';
import { attestPreregistration, type Attestation } from '../prereg.ts';
import { assertPayload, withPermitted } from '../evaluator/allowlist.ts';
import {
  lmeForbiddenValues, lmeSessionMaterial, loadLongMemEvalGold, longMemEvalSutView, scoreLmeRetrieval, LME_SUT_PAGE, LME_SUT_QUERY,
  type LmeSutQuestion,
} from '../evaluator/longmemeval.ts';

export const LME_RECALL_SCHEMA = 'engine-bench.lme-recall/3';
export const LME_RECALL_TOP_K = 5;
export const LME_ARMS = ['keyword', 'vector', 'hybrid'] as const;
export type LmeArm = (typeof LME_ARMS)[number];
export const LME_FULL_RUN_QUESTIONS = 500;
/** SHA-256 of longmemeval_s_cleaned.json (Sept 2025 revision), the file the published LongMemEval-S runs used. */
export const PUBLISHED_LME_S_SHA256 = 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442';
export const BOOTSTRAP = { seed: 20261117, draws: 10_000 } as const;
/**
 * Preregistered gate (the 2026-11-20 amendment on stage 3's rule for Rust): Rust passes an arm against a TypeScript engine when the 95% paired lower
 * bound of Rust minus that engine is at least -RUST_RECALL_DELTA, the smallest detectable difference at the planned 470 scored
 * questions and a planning discordance of 2%.
 */
export const RUST_RECALL_DELTA = 0.018;
/** The superseded non-inferiority margin, kept as a secondary row that is not the gate. */
export const RUST_RECALL_NONINFERIORITY_MARGIN = -0.02;
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
  hybridSearch: (engine: BrainEngine, query: string, opts?: { limit?: number; expansion?: boolean; anyWordFill?: boolean; _embeddingOptedOut?: boolean }) => Promise<SearchResult[]>;
  embedQuery: (text: string) => Promise<Float32Array>;
  /** The document-side embed gbrain's import path calls (embed-retry.ts embedBatchKeepingUsable). */
  embedDocuments: (texts: string[]) => Promise<unknown>;
  configureGateway: (config: Record<string, unknown>) => void;
  setEmbedTransport: (fn: EmbedTransport | null) => void;
  defaultEmbedding: { model: string; dimensions: number };
}

/** Every gbrain module comes from the build under test, so the transport seam and the import path share one gateway. */
async function loadGbrain(gut: GbrainUnderTest): Promise<GbrainModules> {
  const [imp, hybrid, embedding, gateway, retry] = await Promise.all([
    importGbrain<any>(gut, 'src/core/import-file.ts'),
    importGbrain<any>(gut, 'src/core/search/hybrid.ts'),
    importGbrain<any>(gut, 'src/core/embedding.ts'),
    importGbrain<any>(gut, 'src/core/ai/gateway.ts'),
    importGbrain<any>(gut, 'src/core/embed-retry.ts'),
  ]);
  return {
    importFromContent: imp.importFromContent,
    hybridSearch: hybrid.hybridSearch,
    embedQuery: embedding.embedQuery,
    embedDocuments: retry.embedBatchKeepingUsable,
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
async function storeFactory(gut: GbrainUnderTest, kind: EvalEngineKind, workDir: string, postgresUrl: string | undefined, embedding: EvalEmbedding): Promise<StoreFactory> {
  if (kind === 'postgres') {
    if (!postgresUrl) throw new EvalEngineUnavailable(kind, 'postgres_url_missing', 'The postgres engine needs a server URL (--pg-url), for example a local pgvector/pgvector:pg16 container.');
    const admin = new SQL(postgresUrl, { max: 1 });
    const prefix = 'eb_lme_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
    const template = prefix + '_tmpl';
    const created: string[] = [template];
    const drop = (db: string) => admin.unsafe('DROP DATABASE IF EXISTS "' + db + '" WITH (FORCE)');
    try {
      await admin.unsafe('CREATE DATABASE "' + template + '"');
      const t = await openEvalEngine({ gut, kind, databaseUrl: databaseUrlFor(postgresUrl, template), poolMax: 2, embedding });
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
        const { engine } = await openEvalEngine({ gut, kind, databaseUrl: databaseUrlFor(postgresUrl, db), poolMax: 2, embedding });
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
    const t = await openEvalEngine({ gut, kind, databasePath: template, embedding });
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
      const { engine } = await openEvalEngine({ gut, kind, databasePath: path, embedding });
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
  /** lmeRunConfigHash of the configuration that produced this row. */
  run_config_hash?: string;
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
          ? await mods.hybridSearch(opened.engine, q.question, { limit: LME_RECALL_TOP_K, expansion: false, anyWordFill: true, _embeddingOptedOut: true })
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
  /** The TypeScript side errored, or both sides did, or Rust failed an abstention question: left out of the paired delta and the top-5 comparison, and listed here. */
  excluded_errors: string[];
  /**
   * Only when one side is rust: non-abstention questions the other engine answered and Rust errored on or has no result
   * for. They stay in the paired delta with Rust's recall_all scored 0, and any one of them fails the arm.
   */
  rust_errors?: string[];
  /**
   * Only when one side is rust, and the gate: fail on any rust_errors; pass when every scored question is an exact tie;
   * otherwise pass when the lower bound of Rust minus the other is at least -RUST_RECALL_DELTA; unmeasured with no interval.
   */
  rust_verdict?: 'pass' | 'fail' | 'unmeasured';
  /** Only when one side is rust: the paired point estimate of recall_all@5, Rust minus the other, reported beside the gate; null with no scored pair. */
  rust_point_estimate?: number | null;
  /** Only when one side is rust: two secondary rows, reported beside the gate and not the gate, each failing on any rust_errors as the gate does. */
  rust_secondary?: { lower_bound_at_least_0: 'pass' | 'fail' | 'unmeasured'; non_inferiority_minus_0_02: 'pass' | 'fail' | 'unmeasured' };
  /** Scored questions whose top 5 holds the same session ids on both engines: exact ties, with a recall_all difference of 0. */
  exact_ties: number;
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
  /** Questions where every engine returned an empty top 5: they count as identical, so a share is read beside this. */
  n_all_empty: number;
}

const top5 = (r: ArmResult | undefined) => (r?.retrieved ?? []).slice(0, LME_RECALL_TOP_K);
const sameOrder = (x: string[], y: string[]) => x.length === y.length && x.every((s, i) => s === y[i]);
const sameSet = (x: string[], y: string[]) => x.length === y.length && x.every(s => y.includes(s));

export function comparePair(rows: readonly QuestionRow[], arm: LmeArm, a: EvalEngineKind, b: EvalEngineKind): PairComparison {
  const byEngine = (k: EvalEngineKind) => new Map(rows.filter(r => r.engine === k).map(r => [r.question_id, r]));
  const ra = byEngine(a), rb = byEngine(b);
  const rustSide = a === 'rust' ? a : b === 'rust' ? b : null;
  const answered = (r: QuestionRow | undefined) => !!r && r.error === undefined && !!r.arms[arm];
  const [rr, ro] = rustSide === a ? [ra, rb] : [rb, ra];
  const ids = (rustSide === null ? [...ra.keys()].filter(id => rb.has(id)) : [...ro.keys()]).sort();
  const usable = (id: string) => answered(ra.get(id)) && answered(rb.get(id));
  const rustErrors = rustSide === null ? [] : ids.filter(id => !answered(rr.get(id)) && answered(ro.get(id)) && ro.get(id)!.arms[arm]!.recall_all !== null);
  const excluded = ids.filter(id => !usable(id) && !rustErrors.includes(id));
  const kept = ids.filter(usable);
  const differences: Top5Difference[] = [];
  let ordered = 0, set = 0, exactTies = 0;
  const pairs: PairedItem[] = [];
  for (const id of kept) {
    const x = ra.get(id)!.arms[arm]!, y = rb.get(id)!.arms[arm]!;
    const ta = top5(x), tb = top5(y);
    const onlyA = ta.filter(s => !tb.includes(s)), onlyB = tb.filter(s => !ta.includes(s));
    if (sameOrder(ta, tb)) ordered++;
    else differences.push({ question_id: id, only_a: onlyA, only_b: onlyB, order_only: onlyA.length === 0 && onlyB.length === 0 });
    if (sameSet(ta, tb)) set++;
    if (x.recall_all === null || y.recall_all === null) continue;
    const tie = sameSet(ta, tb);
    if (tie) exactTies++;
    pairs.push({ id, cluster: id, a: x.recall_all, b: tie ? x.recall_all : y.recall_all });
  }
  for (const id of rustErrors) {
    const other = ro.get(id)!.arms[arm]!.recall_all!;
    pairs.push({ id, cluster: id, a: rustSide === a ? 0 : other, b: rustSide === a ? other : 0 });
  }
  let delta: PairComparison['recall_all_delta'] = null;
  if (pairs.length > 0) {
    const d = clusteredPairedDelta(pairs, BOOTSTRAP);
    const mc = exactMcNemar(pairs);
    delta = { n_pairs: d.n_pairs, mean_a: d.mean_a, mean_b: d.mean_b, delta: d.delta, ci95: d.ci95, p_two_sided: d.p_two_sided, wins_b: mc.wins, losses_b: mc.losses, mcnemar_p: mc.p_two_sided };
  }
  let rust: Pick<PairComparison, 'rust_errors' | 'rust_verdict' | 'rust_point_estimate' | 'rust_secondary'> = {};
  if (rustSide !== null) {
    const point = delta ? (rustSide === b ? delta.delta : 0 - delta.delta) : null;
    const lower = delta?.ci95 ? (rustSide === b ? delta.ci95[0] : -delta.ci95[1]) : null;
    const allTied = pairs.length > 0 && rustErrors.length === 0 && exactTies === pairs.length;
    const rule = (passes: (lo: number) => boolean) => rustErrors.length > 0 ? 'fail' : allTied ? 'pass' : lower === null ? 'unmeasured' : passes(lower) ? 'pass' : 'fail';
    rust = {
      rust_errors: rustErrors,
      rust_verdict: rule(lo => lo >= -RUST_RECALL_DELTA),
      rust_point_estimate: point,
      rust_secondary: { lower_bound_at_least_0: rule(lo => lo >= 0), non_inferiority_minus_0_02: rule(lo => lo >= RUST_RECALL_NONINFERIORITY_MARGIN) },
    };
  }
  return {
    arm, a, b, n_questions: kept.length, excluded_errors: excluded, ...rust, exact_ties: exactTies, recall_all_delta: delta,
    identical_top5_ordered: kept.length ? ordered / kept.length : 0,
    identical_top5_set: kept.length ? set / kept.length : 0,
    differences,
  };
}

export function armAgreement(rows: readonly QuestionRow[], arm: LmeArm, engines: readonly EvalEngineKind[]): ArmAgreement {
  const ids = [...new Set(rows.map(r => r.question_id))].sort();
  let n = 0, ordered = 0, set = 0, empty = 0;
  for (const id of ids) {
    const found = engines.map(k => rows.find(r => r.engine === k && r.question_id === id));
    if (found.some(r => !r || r.error !== undefined || !r.arms[arm])) continue;
    n++;
    const tops = found.map(r => top5(r!.arms[arm]));
    if (tops.every(t => sameOrder(t, tops[0]))) ordered++;
    if (tops.every(t => sameSet(t, tops[0]))) set++;
    if (tops.every(t => t.length === 0)) empty++;
  }
  return { arm, engines: [...engines], n_questions: n, identical_top5_share: n ? ordered / n : null, identical_top5_set_share: n ? set / n : null, n_all_empty: empty };
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

export interface RowsSummary {
  engines: EngineSummary[];
  comparisons: PairComparison[];
  agreement: ArmAgreement[];
}

export interface LmeRecallReceipt extends RowsSummary {
  schema: typeof LME_RECALL_SCHEMA;
  started_at: string;
  finished_at: string;
  counted: boolean;
  preregistration_attestation: Attestation | null;
  gbrain: { version: string; overlay: Record<string, unknown> | null; rust_addon: RustAddonIdentity | null };
  dataset: {
    file: string; sha256: string; matches_published_sha256: boolean; total_questions: number; selected: number; abstention_selected: number;
    stratify: number | null; limit: number | null; seed: number; question_ids: string[];
  };
  /** This process ran the selected questions at positions i with i % total_workers == worker_id. */
  shard: { worker_id: number; total_workers: number; questions: number };
  ndjson: string | null;
  /** Rows reused from the NDJSON stream under the same run configuration: clean rows, and Rust errors, which a rerun never replaces. */
  resumed_rows: number;
  run_config_hashes: Partial<Record<EvalEngineKind, string>>;
  top_k: number;
  arms: LmeArm[];
  search_config: Record<string, string>;
  embedder: { mode: EmbedderMode; model: string | null; dimensions: number | null; cache_path: string | null; plumbing_only: boolean; note: string };
  network: string;
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

/** Per-engine summaries, every pairwise comparison and the all-engine agreement, from the rows of engines that ran. */
export function summarizeRows(rows: readonly QuestionRow[], ran: readonly EvalEngineKind[], arms: readonly LmeArm[], strategies: Partial<Record<EvalEngineKind, string>> = {}): RowsSummary {
  const engines = ran.map(k => summarizeEngine(k, strategies[k] ?? 'see the worker receipts', rows.filter(r => r.engine === k), arms));
  const comparisons: PairComparison[] = [];
  for (const arm of arms) for (let i = 0; i < ran.length; i++) for (let j = i + 1; j < ran.length; j++) comparisons.push(comparePair(rows, arm, ran[i], ran[j]));
  return { engines, comparisons, agreement: arms.map(arm => armAgreement(rows, arm, ran)) };
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

// ─── Run configuration and the NDJSON stream ──────────────────────

/** Two rows with the same hash came from the same pipeline: gbrain build, dataset bytes, arms, search pins, embedder and engine. */
export function lmeRunConfigHash(o: {
  gbrain: { version: string; commit: string | null; rust_addon?: string | null }; datasetSha256: string; arms: readonly LmeArm[];
  embedder: { mode: EmbedderMode; model: string | null; dimensions: number | null }; engine: EvalEngineKind;
  preregistration?: { path: string; commit: string };
}): string {
  return createHash('sha256').update(canonicalJson({
    schema: LME_RECALL_SCHEMA, top_k: LME_RECALL_TOP_K, search_config: { ...PINNED_SEARCH_CONFIG }, ...o, arms: [...o.arms],
  })).digest('hex');
}

/** Rows and counted-run attestations from an NDJSON stream. A line cut short by a kill is skipped, so that question runs again. */
export function readLmeStream(path: string): { rows: QuestionRow[]; attestations: Attestation[]; builds: Array<{ gbrain: LmeRecallReceipt['gbrain'] | null; dataset: { sha256: string; matches_published_sha256: boolean } | null }> } {
  const out = { rows: [] as QuestionRow[], attestations: [] as Attestation[], builds: [] as Array<{ gbrain: LmeRecallReceipt['gbrain'] | null; dataset: { sha256: string; matches_published_sha256: boolean } | null }> };
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value?.engine && value?.question_id) out.rows.push(value as QuestionRow);
      else if (value?.preregistration_attestation) {
        out.attestations.push(value.preregistration_attestation as Attestation);
        out.builds.push({ gbrain: value.gbrain ?? null, dataset: value.dataset ?? null });
      }
    } catch { /* truncated line: re-run */ }
  }
  return out;
}

export function readLmeRows(path: string): QuestionRow[] {
  return readLmeStream(path).rows;
}

const rowKey = (r: Pick<QuestionRow, 'engine' | 'question_id'>) => r.engine + '::' + r.question_id;
/** A Rust error is never retried away: a later clean row for the same question does not replace it. */
const stickyError = (r?: QuestionRow) => r?.engine === 'rust' && r.error !== undefined;

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
  /** Append every row here; clean rows already in it under the same run configuration are reused, error rows run again. */
  ndjsonPath?: string;
  /** This worker runs the selected questions at positions i with i % totalWorkers == workerId. */
  workerId?: number;
  totalWorkers?: number;
  workDir?: string;
  perQuestionTimeoutMs?: number;
  log?: (line: string) => void;
  /** Makes the run counted: the committed preregistration it attests. Absent means a dev run. */
  prereg?: string;
}

export async function runLmeRecall(o: RunLmeRecallOptions): Promise<LmeRecallReceipt> {
  const started_at = new Date().toISOString();
  const log = o.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const arms = [...(o.arms ?? LME_ARMS)];
  for (const a of arms) if (!(LME_ARMS as readonly string[]).includes(a)) throw new Error('unknown arm ' + a + '; use ' + LME_ARMS.join(', '));
  for (const k of o.engines) if (!(EVAL_ENGINES as readonly string[]).includes(k)) throw new Error('unknown engine ' + k + '; use ' + EVAL_ENGINES.join(', '));
  const workerId = o.workerId ?? 0, totalWorkers = o.totalWorkers ?? 1;
  if (!Number.isInteger(totalWorkers) || totalWorkers < 1 || !Number.isInteger(workerId) || workerId < 0 || workerId >= totalWorkers) {
    throw new Error('--worker-id must be an integer from 0 to --total-workers - 1 (got ' + workerId + ' of ' + totalWorkers + ')');
  }
  let attestation: Attestation | null = null;
  if (o.prereg !== undefined) {
    if (o.embedder === 'plumbing-stub') throw new Error('a counted run reads real vectors from the cache; --plumbing-stub is for --dev runs only');
    attestation = attestPreregistration(o.prereg, REPO_ROOT);
    const load = loadavg()[0];
    if (load > 2) throw new Error('load average ' + load.toFixed(2) + ' is above 2 at launch; a counted run needs the machine to itself');
  }
  const build = { version: o.gut.version, overlay: overlaySummary(o.gut), rust_addon: o.engines.includes('rust') ? rustAddonIdentity(o.gut) : null };
  const seed = o.seed ?? 42;
  const ds = loadDataset(o.datasetPath ?? defaultDatasetPath(), { limit: o.limit, stratify: o.stratify, seed });
  const mine = ds.questions.filter((_, i) => i % totalWorkers === workerId);
  const mods = await loadGbrain(o.gut);
  const embedding = o.embedding ?? mods.defaultEmbedding;
  const needsVectors = arms.some(a => a !== 'keyword');
  const mode: EmbedderMode = needsVectors ? o.embedder ?? 'cache' : 'none';
  const embedderId = { mode, model: needsVectors ? embedding.model : null, dimensions: needsVectors ? embedding.dimensions : null };
  const hashes: Partial<Record<EvalEngineKind, string>> = Object.fromEntries(o.engines.map(engine => [engine, lmeRunConfigHash({
    gbrain: { version: o.gut.version, commit: o.gut.overlay?.build.commit ?? null, ...(engine === 'rust' ? { rust_addon: build.rust_addon?.sha256 ?? null } : {}) }, datasetSha256: ds.sha256, arms, embedder: embedderId, engine,
    preregistration: attestation ? { path: attestation.preregistration, commit: attestation.preregistration_commit } : undefined,
  })]));
  const prior = o.ndjsonPath ? readLmeRows(o.ndjsonPath) : [];
  const stale = prior.filter(r => r.error === undefined && r.engine in hashes && r.run_config_hash !== hashes[r.engine]);
  if (stale.length > 0) {
    throw new Error('NDJSON ' + o.ndjsonPath + ' already holds ' + stale.length + ' clean row(s) for ' + [...new Set(stale.map(r => r.engine))].join(', ')
      + ' from a different run configuration; resuming would mix configurations. Use a fresh --ndjson path.');
  }
  const mineIds = new Set(mine.map(q => q.question_id));
  const done = new Map<string, QuestionRow>();
  for (const r of prior) {
    if ((r.error === undefined || stickyError(r)) && r.run_config_hash === hashes[r.engine] && mineIds.has(r.question_id) && !stickyError(done.get(rowKey(r)))) done.set(rowKey(r), r);
  }
  if (o.ndjsonPath) {
    mkdirSync(dirname(o.ndjsonPath), { recursive: true });
    const existing = existsSync(o.ndjsonPath) ? readFileSync(o.ndjsonPath, 'utf8') : '';
    if (existing && !existing.endsWith('\n')) appendFileSync(o.ndjsonPath, '\n');
    if (attestation) appendFileSync(o.ndjsonPath, JSON.stringify({ preregistration_attestation: attestation, gbrain: build, dataset: { sha256: ds.sha256, matches_published_sha256: ds.sha256 === PUBLISHED_LME_S_SHA256 }, shard: { worker_id: workerId, total_workers: totalWorkers } }) + '\n');
  }
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
  const refusals: EngineSummary[] = [];
  const rows: QuestionRow[] = [...done.values()];
  try {
    for (const kind of o.engines) {
      try {
        factories.push(await storeFactory(o.gut, kind, workDir, o.postgresUrl, embedding));
        log('[lme-recall] ' + kind + ': store template ready');
      } catch (e) {
        const refused = e instanceof EvalEngineUnavailable;
        refusals.push({ kind, status: refused ? 'refused' : 'error', reason: refused ? e.reason : 'store_init_failed', message: (e as Error).message, n_questions: 0, n_errors: 0, errors: [], recall: {} });
        log('[lme-recall] ' + kind + ' ' + (refused ? 'refused (' + e.reason + ')' : 'failed') + ': ' + (e as Error).message);
      }
    }
    if (done.size > 0) log('[lme-recall] resuming: ' + done.size + ' row(s) already in ' + o.ndjsonPath + ' (clean rows, and Rust errors, which are never retried)');
    const timeout = o.perQuestionTimeoutMs ?? 600_000;
    for (let i = 0; i < mine.length; i++) {
      const q = mine[i];
      for (const f of factories) {
        if (done.has(rowKey({ engine: f.kind, question_id: q.question_id }))) continue;
        let row: QuestionRow;
        try {
          row = await runQuestion(mods, f, ds, q, arms, timeout);
          if (misses.n > 0) throw new EmbedCacheMiss('cache miss swallowed inside gbrain');
        } catch (e) {
          if (misses.n > 0 || e instanceof EmbedCacheMiss) {
            throw new EmbedCacheMiss(misses.n + ' text(s) for ' + q.question_id + ' are missing from the embedding cache ' + cachePath + '. The counted run stopped instead of calling a provider; fill the cache first.');
          }
          row = {
            engine: f.kind, question_id: q.question_id, question_type: q.question_type, is_abs: isAbsQuestion(q.question_id),
            num_sessions: q.haystack_sessions.length, arms: {}, timing_ms: { open: 0, import: 0, search: 0, total: 0 }, error: (e as Error).message,
          };
        }
        row.run_config_hash = hashes[f.kind];
        rows.push(row);
        if (o.ndjsonPath) appendFileSync(o.ndjsonPath, JSON.stringify(row) + '\n');
      }
      if ((i + 1) % 5 === 0 || i === mine.length - 1) {
        log('[lme-recall] ' + (i + 1) + '/' + mine.length + ' ' + factories.map(f => {
          const ok = rows.filter(x => x.engine === f.kind && x.error === undefined);
          return f.kind + ' ' + (ok.reduce((s, x) => s + x.timing_ms.total, 0) / Math.max(1, ok.length) / 1000).toFixed(2) + 's/question';
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
  const summary = summarizeRows(rows, factories.map(f => f.kind), arms, Object.fromEntries(factories.map(f => [f.kind, f.strategy])));
  const engines = [...summary.engines, ...refusals].sort((x, y) => o.engines.indexOf(x.kind) - o.engines.indexOf(y.kind));
  return {
    schema: LME_RECALL_SCHEMA,
    started_at, finished_at: new Date().toISOString(),
    counted: attestation !== null, preregistration_attestation: attestation,
    gbrain: build,
    dataset: {
      file: basename(ds.path), sha256: ds.sha256, matches_published_sha256: ds.sha256 === PUBLISHED_LME_S_SHA256, total_questions: ds.totalQuestions,
      selected: ds.questions.length, abstention_selected: ds.questions.filter(q => isAbsQuestion(q.question_id)).length,
      stratify: o.stratify ?? null, limit: o.limit ?? null, seed, question_ids: ds.questions.map(q => q.question_id),
    },
    shard: { worker_id: workerId, total_workers: totalWorkers, questions: mine.length },
    ndjson: o.ndjsonPath ?? null,
    resumed_rows: done.size,
    run_config_hashes: hashes,
    top_k: LME_RECALL_TOP_K, arms, search_config: { ...PINNED_SEARCH_CONFIG },
    embedder: {
      ...embedderId, cache_path: cachePath, plumbing_only: mode === 'plumbing-stub',
      note: mode === 'plumbing-stub'
        ? 'PLUMBING CHECK: vectors are sha256 hashes of the text, not embeddings. Vector and hybrid scores here mean nothing; they only show the pipeline runs on each engine.'
        : mode === 'cache' ? 'Vectors came from the content-addressed cache only; a miss stops the run and no provider was called.' : 'Keyword arm only; nothing was embedded.',
    },
    network: 'every HTTP(S) request to a non-loopback host was refused during the run',
    engines, comparisons: summary.comparisons, agreement: summary.agreement,
    bootstrap: BOOTSTRAP,
    rows,
  };
}

/**
 * Combine the NDJSON streams of sharded workers into one summary. Each engine must carry a single run configuration;
 * a question that appears more than once keeps its last clean row, except that a Rust error is never replaced. A counted aggregate needs an attestation in every
 * shard and lists each one (one per process start) under preregistration_attestation.
 */
export function aggregateLmeRows(paths: readonly string[]): RowsSummary & {
  ndjson: string[]; counted: boolean; preregistration_attestation: Array<Attestation & { ndjson: string }> | null;
  gbrain?: LmeRecallReceipt['gbrain']; dataset?: { sha256: string; matches_published_sha256: boolean };
  run_config_hashes: Partial<Record<EvalEngineKind, string>>; arms: LmeArm[]; rows: QuestionRow[];
} {
  const byKey = new Map<string, QuestionRow>();
  const attestations: Array<Attestation & { ndjson: string }> = [];
  const unattested: string[] = [];
  const builds = new Map<string, ReturnType<typeof readLmeStream>['builds'][number]>();
  for (const path of paths) {
    const stream = readLmeStream(path);
    if (stream.attestations.length === 0) unattested.push(path);
    for (const b of stream.builds) builds.set(JSON.stringify(b.gbrain && b.dataset ? { commit: b.gbrain.overlay?.commit ?? null, addon: b.gbrain.rust_addon?.sha256 ?? null, dataset: b.dataset.sha256 } : null), b);
    attestations.push(...stream.attestations.map(a => ({ ndjson: path, ...a })));
    for (const r of stream.rows) {
      const prev = byKey.get(rowKey(r));
      if (!prev || (!stickyError(prev) && (r.error === undefined || prev.error !== undefined || stickyError(r)))) byKey.set(rowKey(r), r);
    }
  }
  const rows = [...byKey.values()];
  const hashes: Partial<Record<EvalEngineKind, string>> = {};
  for (const r of rows) {
    const h = r.run_config_hash ?? '';
    if (hashes[r.engine] !== undefined && hashes[r.engine] !== h) throw new Error('engine ' + r.engine + ' has rows from more than one run configuration; aggregate one configuration at a time.');
    hashes[r.engine] = h;
  }
  if (attestations.length > 0 && unattested.length > 0) throw new Error('counted and dev shards are mixed: ' + unattested.join(', ') + ' carries no preregistration attestation.');
  const ran = EVAL_ENGINES.filter(k => k in hashes);
  const arms = LME_ARMS.filter(a => rows.some(r => r.arms[a]));
  const counted = attestations.length > 0;
  if (counted && (builds.size !== 1 || builds.has('null'))) throw new Error('counted shards must all record one gbrain build, Rust addon and dataset (a shard started before builds were recorded needs a fresh --ndjson); saw ' + [...builds.keys()].join(', '));
  const build = counted ? [...builds.values()][0]! : undefined;
  return { ndjson: [...paths], counted, preregistration_attestation: counted ? attestations : null, ...(build ? { gbrain: build.gbrain!, dataset: build.dataset! } : {}), run_config_hashes: hashes, arms, ...summarizeRows(rows, ran, arms), rows };
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
 * gateway's embed transport sees every text those arms embed.
 */
async function walkEmbeddings(o: { gut: GbrainUnderTest; mods: GbrainModules; ds: LoadedDataset; workDir: string; embedding: EvalEmbedding; log: (l: string) => void }): Promise<void> {
  const f = await storeFactory(o.gut, 'pglite', o.workDir, undefined, o.embedding);
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

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

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

interface Walked {
  ds: LoadedDataset;
  mods: GbrainModules;
  embedding: { model: string; dimensions: number };
  cachePath: string;
  /** Every distinct (side, text) the arms embed, with the text itself only for document texts the cache lacks. */
  seen: Map<string, { side: 'query' | 'document'; chars: number; cached: boolean; text?: string }>;
}

/** Free: walk the import path on hash vectors with every request off the machine refused, noting each text the arms embed. */
async function walkTexts(o: CountOptions, keepTexts: boolean): Promise<Walked> {
  const log = o.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const ds = loadDataset(o.datasetPath ?? defaultDatasetPath(), { limit: o.limit, stratify: o.stratify, seed: o.seed ?? 42 });
  const mods = await loadGbrain(o.gut);
  const embedding = o.embedding ?? mods.defaultEmbedding;
  const cachePath = o.cachePath ?? defaultCachePath(embedding.model, embedding.dimensions);
  const cache = existsSync(cachePath) ? new EmbeddingCache(cachePath, embedding.model + '@' + embedding.dimensions) : null;
  const seen: Walked['seen'] = new Map();
  const stub = stubTransport(embedding.dimensions);
  const workDir = mkdtempSync(join(tmpdir(), 'engine-bench-lme-walk-'));
  const restoreNetwork = refuseNetwork();
  configureEmbedding(mods, embedding, placeholderKeyEnv(embedding.model));
  mods.setEmbedTransport(async params => {
    const side = inputSide(params);
    for (const v of params.values) {
      const key = side + ':' + sha256(v);
      if (seen.has(key)) continue;
      const cached = cache?.get(v, side) != null;
      seen.set(key, { side, chars: v.length, cached, ...(keepTexts && !cached && side === 'document' ? { text: v } : {}) });
    }
    return stub(params);
  });
  try {
    await walkEmbeddings({ gut: o.gut, mods, ds, workDir, embedding, log });
  } finally {
    mods.setEmbedTransport(null);
    restoreNetwork();
    cache?.close();
    rmSync(workDir, { recursive: true, force: true });
  }
  return { ds, mods, embedding, cachePath, seen };
}

async function planOf(gut: GbrainUnderTest, w: Walked): Promise<EmbedPlan> {
  const todo = [...w.seen.values()].filter(x => !x.cached);
  const chars = todo.reduce((s, x) => s + x.chars, 0);
  const tokens = Math.ceil(chars / 3.5);
  const { lookupEmbeddingPrice } = await importGbrain<any>(gut, 'src/core/embedding-pricing.ts');
  const price = lookupEmbeddingPrice(w.embedding.model);
  const perM = price.kind === 'known' ? price.pricePerMTok as number : null;
  return {
    model: w.embedding.model, dimensions: w.embedding.dimensions, questions: w.ds.questions.length, texts: w.seen.size,
    texts_cached: w.seen.size - todo.length, texts_to_embed: todo.length, chars_to_embed: chars, est_tokens_to_embed: tokens,
    price_per_mtok_usd: perM, est_usd: perM === null ? null : Number((tokens / 1_000_000 * perM).toFixed(4)),
  };
}

/** Keyless: what fill-cache would embed for these questions, counted from the dataset through gbrain's own chunking. */
export async function countEmbedPlan(o: CountOptions): Promise<EmbedPlan> {
  return planOf(o.gut, await walkTexts(o, false));
}

export interface FillCacheOptions extends CountOptions {
  /** Must be true: fill-cache is the one paid step and never runs by default. */
  paid: boolean;
  budget: BudgetOptions;
  /** The provider transport; defaults to the AI SDK's embedMany. Tests pass a stub. */
  transport?: EmbedTransport;
  /** Environment the gateway reads provider keys from; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Document texts per gbrain embed call, and how many calls run at once. */
  batch?: number;
  parallel?: number;
}

export interface FillResult {
  plan: EmbedPlan;
  cache_path: string;
  cache_entries: number;
  /** Summed from the provider's usage field on every response; requests_without_usage counts responses that had none. */
  provider_usage: { tokens: number; requests: number; requests_without_usage: number; list_usd: number | null };
  cost: ReturnType<typeof receiptCost>;
}

/**
 * The paid step, outside every counted run. First a free walk of the import path finds the texts the cache lacks;
 * only then does it join the already-open budget-ledger run (--budget-run-id), so every provider request is reserved
 * before it leaves the process, and embed those texts in large batches through gbrain's own embed call (its batching,
 * input type and retry) into the cache. Rerunning it after a crash re-walks for free and embeds only what is missing.
 */
export async function fillCache(o: FillCacheOptions): Promise<FillResult> {
  if (!o.paid) throw new Error('fill-cache calls a paid embedding provider; pass --paid to confirm.');
  if (!o.budget.runId) throw new Error('fill-cache needs --budget-run-id <id>: open a run first with "bun eval/runner/budget-ledger.ts open --runner engine-bench-lme-recall --budget-usd <n>".');
  const log = o.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const walked = await walkTexts({ ...o, log }, true);
  const plan = await planOf(o.gut, walked);
  const { ds, mods, embedding, cachePath } = walked;
  const docs = [...walked.seen.values()].flatMap(x => (x.text === undefined ? [] : [x.text]));
  walked.seen.clear();
  log('[lme-recall] fill-cache: ' + plan.texts_to_embed + ' texts to embed (' + docs.length + ' document side), ' + plan.chars_to_embed + ' chars, about ' + plan.est_tokens_to_embed + ' tokens');
  mkdirSync(dirname(cachePath), { recursive: true });
  const { run, guard } = startPaidRun('engine-bench-lme-recall-fill', { ...o.budget, estimateUsd: plan.est_usd, log });
  const cache = new EmbeddingCache(cachePath, embedding.model + '@' + embedding.dimensions);
  const usage = { tokens: 0, requests: 0, requests_without_usage: 0 };
  let cost: ReturnType<typeof receiptCost>;
  try {
    configureEmbedding(mods, embedding, o.env ?? { ...process.env });
    const real: EmbedTransport = o.transport ?? (async params =>
      aiSdkEmbedMany(params as unknown as Parameters<typeof aiSdkEmbedMany>[0]) as unknown as ReturnType<EmbedTransport>);
    const metered: EmbedTransport = async params => {
      const result = await real(params);
      usage.requests++;
      const tokens = (result.usage as { tokens?: unknown } | undefined)?.tokens;
      if (typeof tokens === 'number') usage.tokens += tokens; else usage.requests_without_usage++;
      return result;
    };
    mods.setEmbedTransport(makeCachingTransport(metered, cache) as EmbedTransport);
    const batch = o.batch ?? 256, parallel = o.parallel ?? 4;
    let next = 0, embedded = 0, lastLog = 0, failed = false;
    const worker = async () => {
      while (!failed && next < docs.length) {
        const chunk = docs.slice(next, next + batch);
        next += batch;
        try { await mods.embedDocuments(chunk); } catch (e) { failed = true; throw e; }
        embedded += chunk.length;
        if (embedded - lastLog >= 5000 || embedded === docs.length) {
          lastLog = embedded;
          log('[lme-recall] fill-cache: ' + embedded + '/' + docs.length + ' document texts, ' + usage.tokens + ' provider tokens so far');
        }
      }
    };
    const settled = await Promise.allSettled(Array.from({ length: parallel }, worker));
    const rejected = settled.find(s => s.status === 'rejected');
    if (rejected) throw rejected.reason;
    for (const q of ds.questions) await mods.embedQuery(q.question);
  } finally {
    mods.setEmbedTransport(null);
    guard.uninstall();
    cost = receiptCost(run.close());
  }
  const entries = cache.size();
  cache.close();
  return {
    plan, cache_path: cachePath, cache_entries: entries,
    provider_usage: { ...usage, list_usd: plan.price_per_mtok_usd === null ? null : Number((usage.tokens / 1_000_000 * plan.price_per_mtok_usd).toFixed(4)) },
    cost,
  };
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
  'usage: bun eval/runner/engine-bench/lme-recall.ts <run|aggregate|count|fill-cache> [options]',
  '  run         --dev | --prereg <path>                                no --dev means counted: attest, load average <= 2, no cache miss',
  '              [--engines pglite,postgres,rust] [--arms keyword,vector,hybrid] [--pg-url <url>] [--plumbing-stub] [--out <file>]',
  '              [--ndjson <file>] [--worker-id N --total-workers M]   resume from and append to the stream; run one shard',
  '  aggregate   --ndjson <a.ndjson,b.ndjson,...> [--out <file>]       combine sharded workers into one summary',
  '  count       print what fill-cache would embed, keyless',
  '  fill-cache  --paid --budget-run-id <id> [--budget-ledger <path>]   the one paid step, never part of a counted run',
  '  shared      [--dataset <path>] [--cache <path>] [--limit N] [--stratify N] [--seed N] [--gbrain <checkout>@<ref>]',
].join('\n');

function headline(summary: RowsSummary & Record<string, unknown>): unknown {
  const { rows: _rows, comparisons, ...head } = summary as RowsSummary & { rows?: unknown };
  return { ...head, comparisons: comparisons.map(({ differences, ...c }) => ({ ...c, n_differences: differences.length })) };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0];
  if (cmd !== 'run' && cmd !== 'aggregate' && cmd !== 'count' && cmd !== 'fill-cache') {
    process.stderr.write(USAGE + '\n');
    return cmd === '--help' ? 0 : 2;
  }
  const reports = join(REPO_ROOT, 'eval', 'reports', 'engine-bench');
  if (cmd === 'aggregate') {
    const paths = list(flag(argv, '--ndjson') ?? '');
    if (paths.length === 0) { process.stderr.write(USAGE + '\n'); return 2; }
    const summary = aggregateLmeRows(paths);
    const out = flag(argv, '--out') ?? join(reports, 'lme-recall-aggregate-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    writeScrubbedJson(out, { schema: LME_RECALL_SCHEMA, bootstrap: BOOTSTRAP, ...summary });
    process.stdout.write(JSON.stringify(headline(summary as never), null, 2) + '\n');
    process.stderr.write('[lme-recall] aggregate: ' + out + '\n');
    return 0;
  }
  const dev = argv.includes('--dev'), prereg = flag(argv, '--prereg') ?? undefined;
  if (cmd === 'run' && dev === (prereg !== undefined)) {
    throw new Error(dev ? 'pass --dev or --prereg, not both.' : 'A counted run needs --prereg <committed preregistration>; pass --dev for an uncounted run.');
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
    ndjsonPath: flag(argv, '--ndjson') ?? undefined,
    workerId: num(flag(argv, '--worker-id')) ?? 0,
    totalWorkers: num(flag(argv, '--total-workers')) ?? 1,
    prereg,
  });
  const out = flag(argv, '--out') ?? join(reports, 'lme-recall-' + receipt.started_at.replace(/[:.]/g, '-') + '.json');
  writeScrubbedJson(out, receipt);
  process.stdout.write(JSON.stringify(headline(receipt as never), null, 2) + '\n');
  process.stderr.write('[lme-recall] receipt: ' + out + '\n');
  return 0;
}

if (import.meta.main) {
  main().then(code => process.exit(code), e => { process.stderr.write('[lme-recall] ' + ((e as Error).stack ?? String(e)) + '\n'); process.exit(1); });
}
