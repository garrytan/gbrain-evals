/**
 * BrainBench: LongMemEval (public benchmark adapter)
 *
 * Runs gbrain's hybrid retrieval against the public LongMemEval benchmark
 * (xiaowu0162/longmemeval on HuggingFace). Each question carries a haystack
 * of conversation sessions plus ground-truth `answer_session_ids` — the
 * sessions that actually contain the answer.
 *
 * FEATURE BOUNDARY — what is under test vs what is seeded/stubbed:
 *   Under test: gbrain's retrieval pipeline end-to-end — importFromContent
 *   (chunking + inline embedding), engine.searchKeyword, engine.searchVector,
 *   and hybridSearch (RRF fusion, optional Haiku expansion) with the search
 *   mode + reranker + autocut PINNED via engine.setConfig (never defaults —
 *   gbrain's default 'balanced' bundle silently enables the reranker when a
 *   provider key is present).
 *   Legitimately seeded: the haystack sessions themselves (they come from the
 *   public dataset, rendered to markdown), and the content-addressed embedding
 *   cache (remembers past provider calls; keyed by model+dims+input_type so it
 *   can never substitute a different pipeline's vectors). In hermetic test
 *   runs the embed TRANSPORT may be stubbed via gbrain's
 *   __setEmbedTransportForTests seam — retrieval, fusion and scoring still
 *   run the real gbrain code.
 *
 * METRICS (official LongMemEval definitions):
 *   - recall_all@k — THE headline metric: 1 iff EVERY answer session is in the
 *     top-k (the official evaluator's `recall_all`; what published systems
 *     report). Computed via metrics.ts recallAllAtK on session ids.
 *   - recall_any@k — secondary/diagnostic: 1 if at least one answer session is
 *     in the top-k. This was the old (inflating) headline; kept only as a
 *     clearly-labeled secondary column (audit finding longmemeval-01).
 *   - ndcg_any@k — binary-graded nDCG over answer sessions, matching the
 *     official print script's ndcg_any output.
 *   - abs_noise@k — abstention diagnostic: for `_abs` questions (which have no
 *     answer in the haystack; the official protocol EXCLUDES them from recall
 *     denominators, audit finding longmemeval-02) we report the fraction of
 *     top-k slots occupied by claimed-evidence sessions. Lower is better.
 *
 * Design decisions:
 *
 *   1. **One PGLite per benchmark run, not per question.** Reset-in-place
 *      via TRUNCATE between questions. Runtime-enumerated tables via
 *      pg_tables so future schema migrations don't silently leak data
 *      across questions. Same architecture as `gbrain eval longmemeval`.
 *
 *   2. **Adapters compared:** keyword-only (no embedding API calls), vector,
 *      hybrid, hybrid+expansion, plus the sessdiv and rerank variants (see
 *      ADAPTER_SPECS). Search mode/reranker/autocut pinned per engine
 *      (resolvedSearchConfig — PINNED_SEARCH_CONFIG with the reranker
 *      overlaid ON for rerank specs) and recorded per adapter in the receipt
 *      (search_config_by_adapter).
 *
 *   3. **Retrieval recall, not QA accuracy.** No LLM judge required. The
 *      LongMemEval `_s` split labels every question with the session_ids
 *      that contain the answer. recall_all@k against that set is unambiguous.
 *
 * Run:
 *   bun eval/runner/longmemeval.ts                    # full 500-Q run
 *   bun eval/runner/longmemeval.ts --limit 25         # smoke test
 *   bun eval/runner/longmemeval.ts --keyword-only     # skip embeddings
 *   bun eval/runner/longmemeval.ts --dataset oracle   # easy split (3 sess/Q)
 *   bun eval/runner/longmemeval.ts --top-k 5          # default 8
 *   bun eval/runner/longmemeval.ts --seed 42          # stratified-sample seed
 *   bun eval/runner/longmemeval.ts --adapters hybrid-sessdiv --overfetch-factor 3
 *                                                     # session-diversity methodology row
 *
 * Adapter keys: keyword, vector, hybrid, hybrid+expansion (the four legacy
 * adapters, unchanged behavior), plus hybrid-sessdiv, hybrid+expansion-sessdiv
 * (over-fetch topK×factor chunks, score top-K DISTINCT sessions) and
 * hybrid+rerank, hybrid-sessdiv+rerank (cross-encoder reranker pinned ON;
 * fail-closed preflight — see rerank notes at ADAPTER_SPECS).
 *
 * Dataset: download to ~/datasets/longmemeval/longmemeval_s.json from
 *   https://huggingface.co/datasets/xiaowu0162/longmemeval
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { hybridSearch } from 'gbrain/search/hybrid';
import { expandQuery } from 'gbrain/search/expansion';
import type { SearchResult } from 'gbrain/types';
import { loadConfig } from 'gbrain/config';
// Query-side embed for the vector adapter — hybridSearch uses embedQuery for
// its vector arm, so the standalone vector adapter must too (document-side
// embed() returns different vectors on asymmetric models; longmemeval-06).
import { embedQuery } from 'gbrain/embedding';
import { configureGateway, getEmbeddingModel, getEmbeddingDimensions, getExpansionModel, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
// `ai` is a direct dependency of this repo (pinned to gbrain's major) — the
// old deep import into gbrain's nested node_modules broke on any packaged
// install because bun hoists the dependency (audit finding longmemeval-08).
import { embedMany as aiSdkEmbedMany } from 'ai';
import { EmbeddingCache, makeCachingTransport } from './longmemeval-cache.ts';
import {
  recallAllAtK,
  recallAnyAtK,
  ndcgAtK,
  precisionAtK,
  percentile,
  uniqueInOrder,
} from './metrics.ts';
import {
  writeReceipt,
  receiptPath,
  RECEIPT_SCHEMA_VERSION,
  BENCHMARK_VERSION,
  type Receipt,
  type FailureOrigin,
} from './receipt.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

// ─── CLI ──────────────────────────────────────────────────────────

export interface Opts {
  datasetPath: string;
  datasetName: string;
  limit: number | null;
  stratify: number | null;
  /** Seed for the stratified-sample PRNG (recorded in the report). */
  seed: number;
  topK: number;
  /**
   * Sessdiv over-fetch multiplier: sessdiv adapters fetch topK × this many
   * chunks before deduping to top-K distinct sessions. Ignored by
   * non-sessdiv adapters (they fetch exactly topK, unchanged legacy
   * behavior). Recorded per row (overfetch_factor) and in the receipt.
   */
  overfetchFactor: number;
  keywordOnly: boolean;
  /** Comma-separated subset of ADAPTER_SPECS keys; default: the four legacy adapters. */
  adapters: string[];
  cacheDir: string;
  noCache: boolean;
  output: string;
  /** Per-question NDJSON stream path. Resume-friendly: existing rows are skipped. */
  ndjsonPath: string;
  /** Wall-clock budget; exit cleanly when exceeded so a wrapper can restart. */
  maxWallSeconds: number | null;
  /** Worker shard: this process handles questions where `i % totalWorkers === workerId`. */
  workerId: number;
  totalWorkers: number;
  /** Acknowledge a skipped run (missing dataset/keys) — exit 0 instead of 1. */
  allowSkip: boolean;
  /** Gate: best adapter must reach this recall_all@k for verdict 'pass'. */
  minRecallAll: number | null;
  /** Override gbrain's configured embedding model/dims (recorded in receipt). */
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  /** Where receipt.json lands (receiptPath(category, reportsDir)). */
  reportsDir: string;
}

export function parseOpts(argv: string[] = process.argv.slice(2)): Opts {
  const args = argv;
  const datasetSplit = arg(args, '--dataset') ?? 's';
  const home = homedir();
  const fname = datasetSplit === 'oracle'
    ? 'longmemeval_oracle.json'
    : datasetSplit === 's'
      ? 'longmemeval_s.json'
      : `longmemeval_${datasetSplit}.json`;
  const adaptersArg = arg(args, '--adapters');
  const adapters = adaptersArg
    ? adaptersArg.split(',').map(s => s.trim()).filter(Boolean)
    : args.includes('--keyword-only')
      ? ['keyword']
      : ['keyword', 'vector', 'hybrid', 'hybrid+expansion'];
  return {
    datasetPath: arg(args, '--path') ?? join(home, 'datasets', 'longmemeval', fname),
    datasetName: datasetSplit,
    limit: arg(args, '--limit') ? Number(arg(args, '--limit')) : null,
    stratify: arg(args, '--stratify') ? Number(arg(args, '--stratify')) : null,
    seed: arg(args, '--seed') ? Number(arg(args, '--seed')) : 42,
    topK: Number(arg(args, '--top-k') ?? '8'),
    overfetchFactor: Number(arg(args, '--overfetch-factor') ?? '3'),
    keywordOnly: args.includes('--keyword-only'),
    adapters,
    // Default cache lives under eval/reports/ which is gitignored — the
    // SQLite cache for the full _s split is ~700MB, too big to commit
    // under plain git. First run pays the provider embedding cost; the
    // (model, input_type, SHA-256(text)) keying makes the cache
    // content-addressed so subsequent runs hit cache and complete in minutes
    // for ~$0. To share warm cache across machines, copy the file in the
    // embed-cache/ directory.
    cacheDir: arg(args, '--cache-dir') ?? join(import.meta.dir, '..', 'reports', 'longmemeval', 'embed-cache'),
    noCache: args.includes('--no-cache'),
    output: arg(args, '--output') ?? '',
    ndjsonPath: arg(args, '--ndjson') ?? '',
    maxWallSeconds: arg(args, '--max-wall-seconds') ? Number(arg(args, '--max-wall-seconds')) : null,
    workerId: arg(args, '--worker-id') ? Number(arg(args, '--worker-id')) : 0,
    totalWorkers: arg(args, '--total-workers') ? Number(arg(args, '--total-workers')) : 1,
    allowSkip: args.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    minRecallAll: arg(args, '--min-recall-all')
      ? Number(arg(args, '--min-recall-all'))
      : process.env.LME_MIN_RECALL_ALL
        ? Number(process.env.LME_MIN_RECALL_ALL)
        : null,
    embeddingModel: arg(args, '--embedding-model'),
    embeddingDimensions: arg(args, '--embedding-dims') ? Number(arg(args, '--embedding-dims')) : null,
    reportsDir: arg(args, '--reports-dir') ?? join(process.cwd(), 'eval/reports'),
  };
}

/**
 * Read an existing NDJSON stream and return the set of (adapter, question_id)
 * pairs already completed. The wrapper loop relies on this for resume.
 *
 * Rows with an `error` field are NOT completed — they are re-queued on the
 * next invocation instead of becoming permanent misses (audit finding
 * longmemeval-03). Malformed/truncated lines (e.g. a final line cut mid-write
 * by a kill) are tolerated and that question re-runs.
 */
export function readCompletedPairs(path: string): Set<string> {
  const done = new Set<string>();
  if (!path || !existsSync(path)) return done;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.adapter && obj?.question_id && obj.error === undefined) {
        done.add(`${obj.adapter}::${obj.question_id}`);
      }
    } catch { /* truncated/malformed line → treat as not completed, re-run */ }
  }
  return done;
}

// ─── Seeded sampling ─────────────────────────────────────────────

/** Deterministic 32-bit PRNG (mulberry32). Same seed → same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Seeded stratified sample: N questions per question_type, drawn by a
 * seeded Fisher-Yates shuffle of each type bucket (audit finding
 * longmemeval-13 — first-N-in-dataset-order is position-biased). Each bucket
 * gets its own PRNG stream (seed ^ fnv1a(type)) so one type's size can't
 * shift another type's draw. Selected questions are returned in original
 * dataset order so worker sharding by index stays deterministic.
 */
export function stratifiedSample(questions: Question[], perType: number, seed: number): Question[] {
  const buckets: Record<string, Array<{ q: Question; idx: number }>> = {};
  questions.forEach((q, idx) => {
    (buckets[q.question_type] ??= []).push({ q, idx });
  });
  const picked: Array<{ q: Question; idx: number }> = [];
  for (const t of Object.keys(buckets).sort()) {
    const rand = mulberry32((seed ^ fnv1a(t)) >>> 0);
    const pool = [...buckets[t]];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    picked.push(...pool.slice(0, perType));
  }
  picked.sort((a, b) => a.idx - b.idx);
  return picked.map(p => p.q);
}

function arg(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

// ─── Dataset shape ────────────────────────────────────────────────

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface Session {
  session_id?: string;
  turns?: Turn[];
}

export interface Question {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  haystack_dates?: string[];
  haystack_session_ids?: string[];
  haystack_sessions: Session[] | Turn[][];
  answer_session_ids: string[];
}

/**
 * Abstention questions carry '_abs' in question_id. The official LongMemEval
 * protocol always excludes them from retrieval-recall denominators ("these
 * instances generally refer to non-existing events and do not have a ground
 * truth answer location"); we score them separately as abs_noise@k.
 */
export function isAbsQuestion(questionId: string): boolean {
  return questionId.includes('_abs');
}

// LongMemEval _s shape uses array of arrays for haystack_sessions (each
// inner array is the turns of that session). Oracle uses {session_id, turns}.
// Normalize to {session_id, turns}.
function normalizeSessions(q: Question): Array<{ session_id: string; turns: Turn[]; date?: string }> {
  const sessions: Array<{ session_id: string; turns: Turn[]; date?: string }> = [];
  const ids = q.haystack_session_ids ?? [];
  const dates = q.haystack_dates ?? [];
  const raw = q.haystack_sessions;
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as any;
    if (Array.isArray(item)) {
      // _s shape: array of turns
      const sid = ids[i] ?? `lme_${q.question_id}_${i}`;
      sessions.push({ session_id: sid, turns: item, date: dates[i] });
    } else if (item && typeof item === 'object' && Array.isArray(item.turns)) {
      // Oracle shape: {session_id, turns}
      sessions.push({
        session_id: item.session_id ?? `lme_${q.question_id}_${i}`,
        turns: item.turns,
        date: dates[i],
      });
    }
  }
  return sessions;
}

function renderSession(session: { session_id: string; turns: Turn[]; date?: string }): string {
  const fm: string[] = ['---', 'type: note'];
  if (session.date) fm.push(`date: ${session.date}`);
  fm.push(`session_id: ${session.session_id}`, '---', '');
  const body: string[] = [];
  for (const turn of session.turns) {
    body.push(`**${turn.role}:** ${turn.content}`);
    body.push('');
  }
  return fm.join('\n') + body.join('\n');
}

// ─── Harness ──────────────────────────────────────────────────────

const PRESERVE_TABLES = new Set(['sources', 'config', 'gbrain_cycle_locks', 'subagent_rate_leases']);

async function resetTables(engine: PGLiteEngine): Promise<void> {
  const rows = await engine.executeRaw<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const targets = rows.map(r => r.tablename).filter(t => !PRESERVE_TABLES.has(t));
  if (targets.length === 0) return;
  const list = targets.map(t => `"${t.replace(/"/g, '""')}"`).join(', ');
  await engine.executeRaw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * WS5 pinning: the search knobs that change gbrain's retrieval pipeline are
 * set EXPLICITLY per engine, never left to mode-bundle defaults. gbrain's
 * default 'balanced' bundle enables the cross-encoder reranker (fail-open on
 * missing key) and the same command would otherwise measure a different
 * pipeline depending on which API keys the machine has (finding
 * longmemeval-12). Keys verified against gbrain src/core/search/mode.ts
 * (SEARCH_MODE_CONFIG_KEYS + SEARCH_MODE_KEY). The 'config' table is in
 * PRESERVE_TABLES so per-question TRUNCATEs keep the pins.
 */
export const PINNED_SEARCH_CONFIG: Readonly<Record<string, string>> = Object.freeze({
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.autocut': 'false',
});

// ─── Adapter specs ────────────────────────────────────────────────

/**
 * One struct per adapter: which retrieval base runs, plus three orthogonal
 * toggles. The four legacy adapters keep byte-identical behavior (same fetch
 * limits, same retrieved lists); the new ones compose the same code paths:
 *
 *   - expansion  → hybridSearch({expansion: true, expandFn: expandQuery})
 *   - sessdiv    → over-fetch topK × overfetchFactor chunks, then score the
 *                  top-K DISTINCT sessions (see sessdivRetrieve). Closes the
 *                  structural under-measurement where slicing top-K CHUNKS
 *                  left ~3 distinct sessions in a top-5 list.
 *   - rerank     → search.reranker.enabled pinned 'true' for this adapter's
 *                  engine (resolvedSearchConfig overlay). Fail-closed: the
 *                  provider key is preflighted before question 1 and the
 *                  first scored result set must carry rerank_score
 *                  (gbrain's reranker is fail-open — a missing key would
 *                  silently measure plain hybrid under a "rerank" label).
 */
export interface AdapterSpec {
  name: string;
  base: 'keyword' | 'vector' | 'hybrid';
  expansion: boolean;
  sessdiv: boolean;
  rerank: boolean;
}

export const ADAPTER_SPECS: Readonly<Record<string, AdapterSpec>> = Object.freeze({
  keyword: { name: 'gbrain-keyword', base: 'keyword', expansion: false, sessdiv: false, rerank: false },
  vector: { name: 'gbrain-vector', base: 'vector', expansion: false, sessdiv: false, rerank: false },
  hybrid: { name: 'gbrain-hybrid', base: 'hybrid', expansion: false, sessdiv: false, rerank: false },
  'hybrid+expansion': { name: 'gbrain-hybrid+expansion', base: 'hybrid', expansion: true, sessdiv: false, rerank: false },
  'hybrid-sessdiv': { name: 'gbrain-hybrid-sessdiv', base: 'hybrid', expansion: false, sessdiv: true, rerank: false },
  'hybrid+expansion-sessdiv': { name: 'gbrain-hybrid+expansion-sessdiv', base: 'hybrid', expansion: true, sessdiv: true, rerank: false },
  'hybrid+rerank': { name: 'gbrain-hybrid+rerank', base: 'hybrid', expansion: false, sessdiv: false, rerank: true },
  'hybrid-sessdiv+rerank': { name: 'gbrain-hybrid-sessdiv+rerank', base: 'hybrid', expansion: false, sessdiv: true, rerank: true },
});

/**
 * The search config actually pinned for an adapter: PINNED_SEARCH_CONFIG,
 * with 'search.reranker.enabled' overlaid to 'true' for rerank specs. This
 * is what lands per adapter in the receipt (search_config_by_adapter) and in
 * the run_config_hash preimage.
 */
/**
 * The cross-encoder reranker pinned for rerank specs. gbrain's mode-bundle
 * default since v0.48.2.0 (Voyage rerank-2.5, same VOYAGE_API_KEY as the
 * embedding default); pinned here so the receipt names the model and the
 * fail-closed preflight (rerankPreflight) checks the matching key.
 */
export const RERANK_MODEL_PIN = 'voyage:rerank-2.5';

export function resolvedSearchConfig(spec?: Pick<AdapterSpec, 'rerank'>): Record<string, string> {
  return spec?.rerank
    ? { ...PINNED_SEARCH_CONFIG, 'search.reranker.enabled': 'true', 'search.reranker.model': RERANK_MODEL_PIN }
    : { ...PINNED_SEARCH_CONFIG };
}

export async function pinSearchConfig(engine: PGLiteEngine, spec?: Pick<AdapterSpec, 'rerank'>): Promise<void> {
  for (const [k, v] of Object.entries(resolvedSearchConfig(spec))) {
    await engine.setConfig(k, v);
  }
}

// ─── Rerank preflight (fail-closed) ───────────────────────────────

/**
 * Reranker provider → env key. FALLBACK MAP: gbrain resolves the reranker
 * model as per-call override ?? `search.reranker.model` DB config ?? the
 * mode bundle's default. Since gbrain v0.48.2.0 that default is
 * `voyage:rerank-2.5` (the ZeroEntropy hosted API ends 2026-09-04); this
 * runner PINS the same model explicitly for rerank specs
 * (RERANK_MODEL_PIN, recorded in the receipt) so the preflight and the
 * engine cannot disagree about which provider's key is required. Entries mirror the
 * auth_env.required of gbrain's reranker-capable recipes
 * (src/core/ai/recipes/{zeroentropyai,voyage,dashscope-rerank,openrouter}.ts).
 */
export const RERANKER_PROVIDER_ENV_KEY: Readonly<Record<string, string>> = Object.freeze({
  zeroentropyai: 'ZEROENTROPY_API_KEY',
  voyage: 'VOYAGE_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
});

export interface RerankPreflight {
  model: string;
  provider: string;
  envKey: string | null;
  keyPresent: boolean;
}

/**
 * Resolve the reranker provider + key presence BEFORE question 1. gbrain's
 * reranker is fail-open (missing/invalid key → results silently unreranked),
 * so a keyless rerank adapter would measure plain hybrid under a "rerank"
 * label. Fail closed instead: no key → the adapter is skipped (recorded in
 * the receipt), zero rows emitted. Providers not in the map (e.g. a local
 * llama-server reranker) also fail closed — extend the map when they matter.
 */
export function rerankPreflight(env: Record<string, string | undefined> = process.env): RerankPreflight {
  // The runner pins the reranker model for rerank specs (RERANK_MODEL_PIN);
  // a file-plane `reranker_model` override, if a gbrain version exposes one,
  // wins so the preflight follows whatever the engine will actually call.
  let model: string = RERANK_MODEL_PIN;
  try {
    const cfg = loadConfig() as Record<string, unknown> | null;
    const m = cfg?.['reranker_model'];
    if (typeof m === 'string' && m.includes(':')) model = m;
  } catch { /* no config file → pinned default */ }
  const provider = model.slice(0, model.indexOf(':'));
  const envKey = RERANKER_PROVIDER_ENV_KEY[provider] ?? null;
  return { model, provider, envKey, keyPresent: envKey !== null && Boolean(env[envKey]) };
}

function sessionIdFromSlug(slug: string): string {
  const idx = slug.indexOf('/');
  return idx >= 0 ? slug.slice(idx + 1) : slug;
}

function uniqSessionIds(results: SearchResult[]): string[] {
  return uniqueInOrder(results.map(r => sessionIdFromSlug(r.slug)));
}

// ─── Session-diversity retrieval (sessdiv adapters) ───────────────

export interface SessdivRetrieval {
  /** Top-K DISTINCT session ids, best-chunk order. */
  retrieved: string[];
  /** Chunks fetched before session dedupe (diagnostic). */
  candidates_total: number;
  /** Distinct sessions available before the top-K slice (diagnostic). */
  distinct_before_slice: number;
}

/**
 * Over-fetched chunk list → top-K distinct sessions. The input is one
 * descending ranked list, so the FIRST occurrence of a session id is that
 * session's best chunk, and first-occurrence order IS best-chunk-per-session
 * order — the same equivalence adapters/vector-grep-rrf-fusion.ts:169-183
 * establishes with an explicit max-score pass over page slugs. uniqSessionIds
 * (uniqueInOrder) already keeps first occurrences, so slicing its output to
 * topK yields the K best distinct sessions.
 */
export function sessdivRetrieve(results: SearchResult[], topK: number): SessdivRetrieval {
  const distinct = uniqSessionIds(results);
  return {
    retrieved: distinct.slice(0, topK),
    candidates_total: results.length,
    distinct_before_slice: distinct.length,
  };
}

// ─── run_config_hash ──────────────────────────────────────────────

/**
 * The preimage of the per-row run_config_hash. Two rows with the same hash
 * were produced by the same pipeline configuration; the aggregator rejects
 * mixed hashes within one adapter. The full preimage objects are stored once
 * per run in the report JSON's resolved.run_config_preimages (keyed by
 * adapter) so any hash is reversible to the config that produced it.
 */
export interface RunConfigPreimage {
  schema_version: 1;
  /** The dependency spec from package.json dependencies.gbrain (gbrainPin()). */
  gbrain_pin: string;
  dataset: string;
  top_k: number;
  adapter: string;
  /** resolvedSearchConfig(spec) — the pins this adapter's engine actually got. */
  search_config: Record<string, string>;
  /** Sessdiv adapters only. */
  overfetch_factor?: number;
  /** Embedding-backed adapters only (keyword ingests with noEmbed). */
  embedding_model?: string;
  embedding_dimensions?: number;
  /** Expansion adapters only; null when the gateway default could not be resolved. */
  expansion_model?: string | null;
}

export function buildRunConfigPreimage(
  spec: AdapterSpec,
  opts: Pick<Opts, 'datasetName' | 'topK' | 'overfetchFactor'>,
  resolved: { embeddingModel: string | null; embeddingDims: number | null; expansionModel: string | null },
): RunConfigPreimage {
  return {
    schema_version: 1,
    gbrain_pin: gbrainPin(),
    dataset: opts.datasetName,
    top_k: opts.topK,
    adapter: spec.name,
    search_config: resolvedSearchConfig(spec),
    ...(spec.sessdiv ? { overfetch_factor: opts.overfetchFactor } : {}),
    ...(spec.base !== 'keyword' && resolved.embeddingModel !== null ? { embedding_model: resolved.embeddingModel } : {}),
    ...(spec.base !== 'keyword' && resolved.embeddingDims !== null ? { embedding_dimensions: resolved.embeddingDims } : {}),
    ...(spec.expansion ? { expansion_model: resolved.expansionModel } : {}),
  };
}

/** Canonical JSON: object keys sorted recursively, undefined values dropped, arrays kept in order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

/** sha256 hex over the canonical-JSON preimage (node:crypto). */
export function runConfigHash(preimage: RunConfigPreimage): string {
  return createHash('sha256').update(canonicalJson(preimage)).digest('hex');
}

// ─── Scoring ──────────────────────────────────────────────────────

export interface QuestionMetrics {
  /** 1 iff EVERY ground-truth session is in the top-k (official headline). NaN when gt empty. */
  recall_all: number;
  /** 1 if at least one ground-truth session is in the top-k (secondary). NaN when gt empty. */
  recall_any: number;
  /** Binary-graded nDCG@k over ground-truth sessions. NaN when gt empty. */
  ndcg_any: number;
  /** Fraction of top-k slots occupied by ground-truth sessions ( _abs diagnostic). */
  abs_noise: number;
}

/**
 * The ONE id normalization for retrieved lists — lowercase (gbrain slugs are
 * stored lowercase via validateSlug; dataset ids preserve original case),
 * dedupe keeping first occurrence. Shared by scoreQuestion and the
 * session-diversity diagnostics in summarizeAdapterRows so the two can never
 * count "distinct session" differently (eng finding E2).
 */
export function normalizeIds(ids: readonly string[]): string[] {
  return uniqueInOrder(ids.map(s => s.toLowerCase()));
}

/**
 * Score one question. Both sides are lowercased and the retrieved list is
 * de-duplicated (normalizeIds) before ranking metrics apply.
 */
export function scoreQuestion(
  retrieved: readonly string[],
  groundTruth: readonly string[],
  k: number,
): QuestionMetrics {
  const ids = normalizeIds(retrieved);
  const gt = new Set(groundTruth.map(s => s.toLowerCase()));
  const grades = new Map<string, number>([...gt].map(id => [id, 1]));
  return {
    recall_all: recallAllAtK(ids, gt, k),
    recall_any: recallAnyAtK(ids, gt, k),
    ndcg_any: ndcgAtK(ids, grades, k),
    abs_noise: precisionAtK(ids, gt, k),
  };
}

/**
 * WS0 error typing for the receipt. The per-question watchdog timeout is a
 * harness bound around PGLite WASM instability (excluded + capped); provider
 * outages/rate limits are dependency; anything else that gbrain threw while
 * ingesting/searching is the system under test misbehaving (scored 0, stays
 * in the denominator).
 */
export function classifyErrorOrigin(msg: string): FailureOrigin {
  if (/^question_timeout_/.test(msg)) return 'harness';
  // Reranker contract violation: config pinned the reranker ON but gbrain
  // fail-opened (no rerank_score on any result). The pipeline under the
  // "rerank" label did not run — that is the SUT misbehaving, checked before
  // the dependency patterns because the message names the provider key.
  if (/^rerank_missing_score/.test(msg)) return 'sut';
  if (/rate.?limit|\b(408|425|429|500|502|503|504|529)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network|overloaded|quota|insufficient_quota|api.?key/i.test(msg)) {
    return 'dependency';
  }
  return 'sut';
}

// ─── Row + summary shapes (shared with longmemeval-aggregate.ts) ──

/**
 * One NDJSON row per (adapter, question). New writers emit every field;
 * legacy rows (pre 2026-08-31) carry only adapter/question_id/question_type/
 * retrieved/ground_truth/hit_at_k/num_haystack/latency_ms — the aggregate
 * recomputes metrics from retrieved+ground_truth so legacy streams still
 * summarize correctly.
 */
export interface NdjsonRow {
  adapter: string;
  question_id: string;
  question_type: string;
  retrieved: string[];
  ground_truth: string[];
  /** Legacy any-hit flag (== recall_any as boolean). Kept for old tooling. */
  hit_at_k: boolean;
  recall_all?: number;
  recall_any?: number;
  ndcg_any?: number;
  is_abs?: boolean;
  abs_noise?: number;
  num_haystack: number;
  latency_ms: number;
  top_k?: number;
  dataset?: string;
  /** Sessdiv adapters only: chunks fetched before session dedupe. */
  candidates_total?: number;
  /** Sessdiv adapters only: distinct sessions available before the top-K slice. */
  distinct_before_slice?: number;
  /** Sessdiv adapters only: over-fetch multiplier (fetch limit = top_k × this). */
  overfetch_factor?: number;
  /**
   * sha256 over the canonical run-config preimage (buildRunConfigPreimage).
   * Same hash ⇔ same pipeline configuration; the aggregator rejects mixed
   * hashes within one adapter. Absent on legacy rows (pre 2026-09-01).
   */
  run_config_hash?: string;
  error?: string;
  error_origin?: FailureOrigin;
}

export interface TypeBucket {
  total: number;
  hit_all: number;
  recall_all: number;
  hit_any: number;
  recall_any: number;
  /** Mean distinct sessions in the scored retrieved lists (normalizeIds — same normalization as scoring). */
  mean_distinct_sessions: number;
  /** Fraction of scored rows with fewer than topK distinct sessions available (pre-slice supply for sessdiv rows). */
  session_shortfall_rate: number;
}

export interface RunSummary {
  adapter: string;
  dataset: string;
  topK: number;
  /** Recall denominator: non-abstention questions scored (incl. sut-error zeros). */
  total: number;
  n_rows: number;
  n_abs: number;
  n_errors_sut: number;
  n_errors_infra: number;
  /** Headline: official LongMemEval recall_all@k. null when nothing scored. */
  recall_all_at_k: number | null;
  /** Secondary any-hit recall (the old, strictly looser metric). */
  recall_any_at_k: number | null;
  ndcg_any_at_k: number | null;
  /** _abs diagnostic: mean fraction of top-k that is claimed evidence for unanswerable questions. */
  abs_noise_at_k: number | null;
  /**
   * Session-diversity diagnostic: mean count of DISTINCT sessions in the
   * scored retrieved lists (normalizeIds — identical normalization to
   * scoreQuestion). On legacy chunk-sliced rows this exposes how few
   * distinct sessions a "top-k" list actually held; on sessdiv rows it
   * should sit at ~topK.
   */
  mean_distinct_sessions: number | null;
  /**
   * Fraction of scored rows whose distinct session count is < topK. For
   * sessdiv rows the PRE-SLICE count (distinct_before_slice) is used so the
   * rate reflects supply after over-fetch, not the slice.
   */
  session_shortfall_rate: number | null;
  recall_by_type: Record<string, TypeBucket>;
  avg_latency_ms: number | null;
  p50_latency_ms: number | null;
  p99_latency_ms: number | null;
  total_seconds: number;
}

function finiteOrNull(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

/**
 * The ONE summary implementation — used by the runner and by
 * longmemeval-aggregate.ts so writer and aggregator can never drift.
 *
 * Denominator policy (probe-accounting WS0):
 *   - clean rows → scored;
 *   - error rows with origin 'sut' → scored 0 (stay in the denominator);
 *   - error rows with origin 'harness'/'dependency' → excluded, counted;
 *   - _abs rows → excluded from ALL recall denominators, scored as abs_noise.
 * Metrics are recomputed from retrieved+ground_truth so legacy rows (which
 * lack the per-row metric fields) aggregate identically to new ones.
 */
export function summarizeAdapterRows(
  adapter: string,
  rows: NdjsonRow[],
  topK: number,
  dataset: string,
  totalSeconds?: number,
): RunSummary {
  const originOf = (r: NdjsonRow): FailureOrigin | null =>
    r.error === undefined ? null : (r.error_origin ?? classifyErrorOrigin(r.error));
  const isInfra = (r: NdjsonRow) => {
    const o = originOf(r);
    return o !== null && o !== 'sut';
  };

  const absRows = rows.filter(r => isAbsQuestion(r.question_id) && !isInfra(r));
  const evalRows = rows.filter(r => !isAbsQuestion(r.question_id) && !isInfra(r));
  const nErrorsSut = rows.filter(r => originOf(r) === 'sut').length;
  const nErrorsInfra = rows.filter(r => isInfra(r)).length;

  const recallAllVals: number[] = [];
  const recallAnyVals: number[] = [];
  const ndcgVals: number[] = [];
  const distinctVals: number[] = [];
  const shortfallVals: number[] = [];
  const byType: Record<string, TypeBucket> = {};
  const divByType: Record<string, { distinctSum: number; shortfalls: number }> = {};
  for (const r of evalRows) {
    const m = scoreQuestion(r.retrieved ?? [], r.ground_truth ?? [], topK);
    // sut-error rows have retrieved=[] → 0 across the board. A non-abs row
    // with an EMPTY ground_truth set is a dataset anomaly: metrics are NaN;
    // count it as 0 rather than silently dropping the probe.
    const rAll = Number.isFinite(m.recall_all) ? m.recall_all : 0;
    const rAny = Number.isFinite(m.recall_any) ? m.recall_any : 0;
    const nd = Number.isFinite(m.ndcg_any) ? m.ndcg_any : 0;
    recallAllVals.push(rAll);
    recallAnyVals.push(rAny);
    ndcgVals.push(nd);
    // Session-diversity diagnostics — computable for EVERY row generation
    // (legacy rows included) from the stored retrieved list, using the SAME
    // normalization scoreQuestion applies (normalizeIds, eng E2). Shortfall
    // prefers the sessdiv pre-slice count so it reflects supply after
    // over-fetch, not the top-K slice.
    const distinct = normalizeIds(r.retrieved ?? []).length;
    const supply = typeof r.distinct_before_slice === 'number' ? r.distinct_before_slice : distinct;
    distinctVals.push(distinct);
    shortfallVals.push(supply < topK ? 1 : 0);
    const b = byType[r.question_type] ?? (byType[r.question_type] = {
      total: 0, hit_all: 0, recall_all: 0, hit_any: 0, recall_any: 0,
      mean_distinct_sessions: 0, session_shortfall_rate: 0,
    });
    const d = divByType[r.question_type] ?? (divByType[r.question_type] = { distinctSum: 0, shortfalls: 0 });
    b.total++;
    if (rAll === 1) b.hit_all++;
    if (rAny === 1) b.hit_any++;
    d.distinctSum += distinct;
    if (supply < topK) d.shortfalls++;
  }
  for (const t of Object.keys(byType)) {
    byType[t].recall_all = byType[t].total > 0 ? byType[t].hit_all / byType[t].total : 0;
    byType[t].recall_any = byType[t].total > 0 ? byType[t].hit_any / byType[t].total : 0;
    byType[t].mean_distinct_sessions = byType[t].total > 0 ? divByType[t].distinctSum / byType[t].total : 0;
    byType[t].session_shortfall_rate = byType[t].total > 0 ? divByType[t].shortfalls / byType[t].total : 0;
  }

  const absNoiseVals = absRows.map(r => {
    const m = scoreQuestion(r.retrieved ?? [], r.ground_truth ?? [], topK);
    return Number.isFinite(m.abs_noise) ? m.abs_noise : 0;
  });

  // Latency over clean rows only: watchdog timeouts and provider stalls
  // measure the harness/provider, not gbrain's retrieval.
  const latencies = rows.filter(r => r.error === undefined).map(r => r.latency_ms);
  const mean = (v: number[]) => (v.length === 0 ? NaN : v.reduce((s, x) => s + x, 0) / v.length);

  return {
    adapter,
    dataset,
    topK,
    total: recallAllVals.length,
    n_rows: rows.length,
    n_abs: rows.filter(r => isAbsQuestion(r.question_id)).length,
    n_errors_sut: nErrorsSut,
    n_errors_infra: nErrorsInfra,
    recall_all_at_k: finiteOrNull(mean(recallAllVals)),
    recall_any_at_k: finiteOrNull(mean(recallAnyVals)),
    ndcg_any_at_k: finiteOrNull(mean(ndcgVals)),
    abs_noise_at_k: finiteOrNull(mean(absNoiseVals)),
    mean_distinct_sessions: finiteOrNull(mean(distinctVals)),
    session_shortfall_rate: finiteOrNull(mean(shortfallVals)),
    recall_by_type: byType,
    avg_latency_ms: finiteOrNull(mean(latencies)),
    p50_latency_ms: finiteOrNull(percentile(latencies, 50)),
    p99_latency_ms: finiteOrNull(percentile(latencies, 99)),
    total_seconds: totalSeconds ?? latencies.reduce((s, x) => s + x, 0) / 1000,
  };
}

// ─── Verdict ──────────────────────────────────────────────────────

/**
 * Default recall_all@k gate. Embedding-backed runs are held to the published
 * bar; keyword-only runs (BM25-class) to a lower one. Override with
 * --min-recall-all / LME_MIN_RECALL_ALL when running degraded configs on
 * purpose (e.g. hermetic stub-embed smoke tests).
 */
export function defaultMinRecallAll(adapterKeys: string[]): number {
  const hasEmbedding = adapterKeys.some(k => k !== 'keyword' && !k.startsWith('gbrain-keyword'));
  return hasEmbedding ? 0.75 : 0.4;
}

export function computeVerdict(
  summaries: RunSummary[],
  minRecallAll: number,
): { verdict: 'pass' | 'partial' | 'fail'; reason: string } {
  const scored = summaries.filter(s => s.recall_all_at_k !== null && s.total > 0);
  if (scored.length === 0) {
    return { verdict: 'partial', reason: 'no recall-eligible questions scored this invocation' };
  }
  const best = scored.reduce((a, b) => ((b.recall_all_at_k ?? -1) > (a.recall_all_at_k ?? -1) ? b : a));
  const v = best.recall_all_at_k ?? 0;
  const detail = `best adapter ${best.adapter} recall_all@${best.topK}=${v.toFixed(4)} vs gate ${minRecallAll}`;
  return v >= minRecallAll
    ? { verdict: 'pass', reason: detail }
    : { verdict: 'fail', reason: detail };
}

// ─── Run ──────────────────────────────────────────────────────────

export interface RunResult {
  summaries: RunSummary[];
  receipt: Receipt;
  receiptFile: string;
  reportPath: string | null;
  exitCode: number;
}

const LME_CATEGORY = 'longmemeval';

function baseReceipt(startedAt: string) {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: LME_CATEGORY,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
  } as const;
}

/** Provider prefix → env key that must be present for LIVE embed calls. */
const PROVIDER_ENV_KEY: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  voyage: 'VOYAGE_API_KEY',
  zeroentropyai: 'ZEROENTROPY_API_KEY',
};

export async function run(opts: Opts): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const receiptFile = receiptPath(LME_CATEGORY, opts.reportsDir);

  const skip = (reason: string): RunResult => {
    const receipt: Receipt = {
      ...baseReceipt(startedAt),
      run_status: 'skipped',
      skip_reason: reason,
      n_total: 0,
      n_scored: 0,
      completion_rate: 0,
      errors: [],
      publishable: false,
      finished_at: new Date().toISOString(),
    };
    writeReceipt(receiptFile, receipt);
    process.stderr.write(`[longmemeval] SKIPPED: ${reason}\n[longmemeval] receipt: ${receiptFile}\n`);
    return { summaries: [], receipt, receiptFile, reportPath: null, exitCode: opts.allowSkip ? 0 : 1 };
  };

  if (!existsSync(opts.datasetPath)) {
    return skip(
      `dataset not found at ${opts.datasetPath} — download from https://huggingface.co/datasets/xiaowu0162/longmemeval`,
    );
  }
  process.stderr.write(`[longmemeval] loading ${opts.datasetPath}...\n`);
  const raw: Question[] = JSON.parse(readFileSync(opts.datasetPath, 'utf8'));
  let all = raw;
  if (opts.stratify) all = stratifiedSample(raw, opts.stratify, opts.seed);
  if (opts.limit) all = all.slice(0, opts.limit);
  const nAbs = all.filter(q => isAbsQuestion(q.question_id)).length;
  process.stderr.write(
    `[longmemeval] dataset=${opts.datasetName} questions=${all.length} (${nAbs} _abs, excluded from recall denominators)` +
    `${opts.stratify ? ` (stratified ${opts.stratify}/type, seed=${opts.seed})` : ''} top_k=${opts.topK}\n`,
  );

  const adapters = opts.adapters.map(k => {
    const a = ADAPTER_SPECS[k];
    if (!a) {
      throw new Error(`Unknown adapter: "${k}". Allowed: ${Object.keys(ADAPTER_SPECS).join(', ')}`);
    }
    return a;
  });

  // Rerank preflight (fail-closed), BEFORE question 1: gbrain's reranker
  // fail-opens on a missing provider key, which would silently measure plain
  // hybrid under a "rerank" label. No key → the adapter is SKIPPED (receipt
  // records skip_reason), zero rows emitted, other adapters continue.
  const skippedAdapters: Array<{ adapter: string; skip_reason: string }> = [];
  const runnable: AdapterSpec[] = [];
  for (const spec of adapters) {
    if (!spec.rerank) {
      runnable.push(spec);
      continue;
    }
    const pre = rerankPreflight();
    if (pre.keyPresent) {
      runnable.push(spec);
      continue;
    }
    const reason = pre.envKey !== null
      ? `rerank preflight failed: ${pre.envKey} not set (reranker model ${pre.model})`
      : `rerank preflight failed: no known env key for reranker provider "${pre.provider}" (model ${pre.model}) — extend RERANKER_PROVIDER_ENV_KEY`;
    skippedAdapters.push({ adapter: spec.name, skip_reason: reason });
    process.stderr.write(`[longmemeval] SKIP adapter ${spec.name}: ${reason}\n`);
  }
  // Rerank adapters that DO run are still "pending acceptance run" until a
  // keyed end-to-end run has been published (plan D4c) — recorded in the
  // receipt so nobody quotes a rerank number without one.
  const rerankAdaptersPending = adapters.filter(a => a.rerank).map(a => a.name);
  const searchConfigByAdapter = Object.fromEntries(adapters.map(a => [a.name, resolvedSearchConfig(a)]));

  if (runnable.length === 0 && skippedAdapters.length > 0) {
    // Skip-only run: nothing measurable was requested-and-runnable. Exit 0 —
    // a fail-closed skip is the designed response, not a failure.
    const reason = `all requested adapters skipped: ${skippedAdapters.map(s => `${s.adapter} (${s.skip_reason})`).join('; ')}`;
    const receipt: Receipt = {
      ...baseReceipt(startedAt),
      run_status: 'skipped',
      skip_reason: reason,
      n_total: 0,
      n_scored: 0,
      completion_rate: 0,
      errors: [],
      publishable: false,
      resolved_config: {
        search_config_by_adapter: searchConfigByAdapter,
        adapters_skipped: skippedAdapters,
        rerank_adapters_pending_acceptance: rerankAdaptersPending,
      },
      finished_at: new Date().toISOString(),
    };
    writeReceipt(receiptFile, receipt);
    process.stderr.write(`[longmemeval] SKIPPED (all adapters): ${reason}\n[longmemeval] receipt: ${receiptFile}\n`);
    return { summaries: [], receipt, receiptFile, reportPath: null, exitCode: 0 };
  }

  const summaries: RunSummary[] = [];

  // Recycle the engine every RECYCLE_EVERY questions to bound memory AND
  // bound PGLite WASM state. The WASM module accumulates internal state
  // beyond what TRUNCATE clears; on long runs (500Q × 50 sessions ×
  // chunked + indexed) we've seen it lock up in an abort() loop after
  // ~75 questions. Recycling every 25Q keeps the WASM healthy at the
  // cost of ~2s cold-start × 20 cycles = ~40s extra wall time. Cheap
  // insurance against silent hangs that wasted hours of API spend.
  const RECYCLE_EVERY = 25;

  // Configure the AI gateway once (v0.27+ requires this before embed() works).
  // Mirror cli.ts#connectEngine: read config + env, hand to configureGateway.
  // Used by hybridSearch + importFromContent's chunk-embedding path.
  const needsEmbeddings = runnable.some(a => a.base !== 'keyword');
  let cache: EmbeddingCache | null = null;
  let resolvedEmbeddingModel: string | null = null;
  let resolvedEmbeddingDims: number | null = null;
  let resolvedExpansionModel: string | null = null;
  if (needsEmbeddings) {
    const cfg = loadConfig() || ({} as any);
    configureGateway({
      embedding_model: opts.embeddingModel ?? cfg.embedding_model,
      embedding_dimensions: opts.embeddingDimensions ?? cfg.embedding_dimensions,
      expansion_model: cfg.expansion_model,
      chat_model: cfg.chat_model,
      chat_fallback_chain: cfg.chat_fallback_chain,
      base_urls: cfg.provider_base_urls,
      env: { ...process.env },
    });
    // Read back what the gateway RESOLVED (config value or gbrain's own
    // fallback default) — never re-derive with local fallbacks that can
    // drift from gbrain's (audit finding longmemeval-05: the old
    // 'text-embedding-3-large@1536' fallback mislabeled zembed-1@1280
    // vectors and poisoned shared caches).
    resolvedEmbeddingModel = getEmbeddingModel();
    resolvedEmbeddingDims = getEmbeddingDimensions();
    // Same resolved-not-rederived rule for the expansion model: it goes into
    // the run_config_hash preimage of expansion adapters.
    try { resolvedExpansionModel = getExpansionModel(); } catch { resolvedExpansionModel = null; }
    const provider = resolvedEmbeddingModel.includes(':')
      ? resolvedEmbeddingModel.slice(0, resolvedEmbeddingModel.indexOf(':'))
      : 'openai';
    const envKey = PROVIDER_ENV_KEY[provider];
    if (envKey && !process.env[envKey]) {
      return skip(
        `embedding adapters requested but ${envKey} is not set (resolved embedding model: ${resolvedEmbeddingModel}). ` +
        `Run --keyword-only, set the key, or stub the embed transport for hermetic runs.`,
      );
    }
    if (!opts.noCache) {
      // Wire the content-addressed cache. Hits skip the provider API
      // entirely; misses fall through to the original ai-sdk embedMany.
      // First run pays full cost, every subsequent run on the same dataset
      // is essentially free. (model+dims, input_type, SHA-256(text)) keying
      // makes this fair AND side-aware: different content or embedding side
      // → different key → cache miss. We're remembering past computation,
      // not borrowing future data.
      const cacheKey = `${resolvedEmbeddingModel}@${resolvedEmbeddingDims}`;
      const cachePath = join(opts.cacheDir, `embed-cache-${cacheKey.replace(/[^a-z0-9@-]/gi, '_')}.sqlite`);
      cache = new EmbeddingCache(cachePath, cacheKey);
      // Pass the params straight through to the real ai-sdk embedMany so
      // model + providerOptions + dimensions arrive intact. gbrain's gateway
      // already builds the model object with the right dimensions config.
      const realTransport = async (params: { values: string[] } & Record<string, unknown>) =>
        aiSdkEmbedMany(params as Parameters<typeof aiSdkEmbedMany>[0]);
      // The caching wrapper satisfies the transport contract structurally
      // (embeddings + values + warnings); the cast crosses gbrain's
      // test-seam type, which demands the full ai-sdk embedMany signature.
      __setEmbedTransportForTests(
        makeCachingTransport(realTransport, cache) as unknown as Parameters<typeof __setEmbedTransportForTests>[0],
      );
      process.stderr.write(`[longmemeval] embedding cache at ${cachePath} (${cache.size()} entries warm)\n`);
    }
  }

  // Resume support: when --ndjson is given, every per-question result is
  // appended immediately. On restart we read it back and skip already-done
  // (adapter, question_id) pairs — error rows are NOT skipped; they re-run
  // (audit finding longmemeval-03). Pair this with --max-wall-seconds and a
  // wrapper bash loop to chip through the full run in 10-min batches.
  const completed = readCompletedPairs(opts.ndjsonPath);
  if (opts.ndjsonPath) {
    mkdirSync(dirname(opts.ndjsonPath) || '.', { recursive: true });
    process.stderr.write(`[longmemeval] ndjson stream: ${opts.ndjsonPath} (${completed.size} pairs already complete)\n`);
  }
  const wallStart = Date.now();
  const wallBudgetMs = opts.maxWallSeconds ? opts.maxWallSeconds * 1000 : Infinity;
  let timedOut = false;

  const inShard = (i: number) => opts.totalWorkers <= 1 || i % opts.totalWorkers === opts.workerId;
  // Expected probes count RUNNABLE adapters only: a preflight-skipped adapter
  // is declared skipped in the receipt, not "planned but never attempted".
  let expectedProbes = 0;
  for (const adapter of runnable) {
    for (let i = 0; i < all.length; i++) {
      if (!inShard(i)) continue;
      if (completed.has(`${adapter.name}::${all[i].question_id}`)) continue;
      expectedProbes++;
    }
  }
  const acc = new ProbeAccounting(expectedProbes);
  const runConfigPreimages: Record<string, RunConfigPreimage> = {};
  const abortedAdapters: Array<{ adapter: string; reason: string }> = [];

  for (const adapter of runnable) {
    if (timedOut) break;
    process.stderr.write(
      `\n[longmemeval] adapter=${adapter.name} (base=${adapter.base}` +
      `${adapter.expansion ? ' +expansion' : ''}` +
      `${adapter.sessdiv ? ` +sessdiv(overfetch=${opts.overfetchFactor})` : ''}` +
      `${adapter.rerank ? ' +rerank' : ''})\n`,
    );
    // Non-sessdiv adapters fetch exactly topK (legacy behavior, unchanged);
    // sessdiv adapters over-fetch so the session dedupe has supply to fill
    // K distinct slots.
    const fetchLimit = adapter.sessdiv ? opts.topK * opts.overfetchFactor : opts.topK;
    const preimage = buildRunConfigPreimage(adapter, opts, {
      embeddingModel: resolvedEmbeddingModel,
      embeddingDims: resolvedEmbeddingDims,
      expansionModel: resolvedExpansionModel,
    });
    runConfigPreimages[adapter.name] = preimage;
    const rowConfigHash = runConfigHash(preimage);
    // Rerank contract: the first non-empty scored result set must carry
    // rerank_score (gbrain stamps it on the reranked head) — otherwise the
    // reranker fail-opened and this adapter's label would be a lie.
    let rerankScoreSeen = false;
    let engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await pinSearchConfig(engine, adapter);
    const runStart = Date.now();
    const results: NdjsonRow[] = [];

    try {
      // Per-question watchdog: PGLite's WASM has been observed to enter a
      // tight Aborted() loop on certain inputs after ~75 vector questions —
      // process keeps using CPU but writes nothing for hours. Catching is
      // not enough (Aborted() is a WASM-level trap, not a JS throw); we
      // bound each question with a wall-clock timeout. On timeout we
      // forcibly disconnect, recreate the engine, and skip the question.
      const PER_QUESTION_TIMEOUT_MS = 90_000;

      async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
        return await Promise.race([
          p,
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`question_timeout_${ms}ms`)), ms),
          ),
        ]);
      }

      async function resetEngineHard(): Promise<void> {
        try { await engine.disconnect(); } catch { /* WASM aborted; ignore */ }
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        await pinSearchConfig(engine, adapter);
      }

      for (let i = 0; i < all.length; i++) {
        const q = all[i];
        // Worker shard: each parallel worker handles 1/N of the questions.
        // Deterministic by index so workers don't fight over the same row.
        if (!inShard(i)) continue;
        // Skip pairs already streamed to NDJSON (resume + cross-worker dedup).
        if (completed.has(`${adapter.name}::${q.question_id}`)) continue;
        // Wall-budget exit: clean exit lets the wrapper restart cleanly.
        if (Date.now() - wallStart > wallBudgetMs) {
          process.stderr.write(`[longmemeval] wall budget reached (${opts.maxWallSeconds}s); exiting for restart\n`);
          timedOut = true;
          break;
        }
        const probeId = `${adapter.name}::${q.question_id}`;
        const qStart = Date.now();
        try {
          if (i > 0 && i % RECYCLE_EVERY === 0) {
            await resetEngineHard();
          } else {
            await resetTables(engine);
          }
          const sessions = normalizeSessions(q);
          for (const s of sessions) {
            // gbrain's putPage lowercases via validateSlug, but upsertChunks
            // (also called by importFromContent) does NOT lowercase — passing
            // a mixed-case slug throws "Page not found" on the chunk write.
            // Normalize at the boundary so the dataset's mixed-case session_ids
            // (e.g. "sharegpt_yywfIrx_0") work end-to-end.
            const slug = `chat/${s.session_id}`.toLowerCase();
            await withTimeout(
              importFromContent(engine, slug, renderSession(s), {
                noEmbed: adapter.base === 'keyword',
              }),
              PER_QUESTION_TIMEOUT_MS,
            );
          }
          let searchResults: SearchResult[];
          if (adapter.base === 'keyword') {
            searchResults = await engine.searchKeyword(q.question, { limit: fetchLimit });
          } else if (adapter.base === 'vector') {
            // Vector-only: hybridSearch with the keyword half disabled isn't a
            // direct flag, so call engine.searchVector after embedding the
            // query QUERY-SIDE (embedQuery — what hybridSearch's vector half
            // does). Embedding goes through the cached transport like imports.
            const queryEmb = await embedQuery(q.question);
            searchResults = await engine.searchVector(queryEmb, { limit: fetchLimit });
          } else if (!adapter.expansion) {
            searchResults = await hybridSearch(engine, q.question, { limit: fetchLimit, expansion: false });
          } else {
            // hybrid + multi-query expansion via Haiku (gbrain's prod default)
            searchResults = await hybridSearch(engine, q.question, {
              limit: fetchLimit,
              expansion: true,
              expandFn: expandQuery,
            });
          }

          // Fail-closed rerank assertion: gbrain's reranker fail-opens
          // (provider error → results pass through unreranked, no
          // rerank_score stamped). The first non-empty result set decides:
          // no rerank_score anywhere → abort this adapter as an SUT error
          // rather than publish plain-hybrid numbers under a rerank label.
          if (adapter.rerank && !rerankScoreSeen && searchResults.length > 0) {
            if (searchResults.some(r => r.rerank_score !== undefined)) {
              rerankScoreSeen = true;
            } else {
              throw new Error(
                `rerank_missing_score: search.reranker.enabled pinned 'true' for ${adapter.name} ` +
                `but no result carried rerank_score on ${q.question_id} — the reranker fail-opened ` +
                `(invalid provider credentials or provider sunset short-circuit)`,
              );
            }
          }

          let retrieved: string[];
          let sessdiv: SessdivRetrieval | null = null;
          if (adapter.sessdiv) {
            sessdiv = sessdivRetrieve(searchResults, opts.topK);
            retrieved = sessdiv.retrieved;
          } else {
            retrieved = uniqSessionIds(searchResults);
          }
          const m = scoreQuestion(retrieved, q.answer_session_ids, opts.topK);
          const abs = isAbsQuestion(q.question_id);

          const row: NdjsonRow = {
            adapter: adapter.name,
            question_id: q.question_id,
            question_type: q.question_type,
            retrieved,
            ground_truth: q.answer_session_ids,
            hit_at_k: m.recall_any === 1,
            ...(abs
              ? { is_abs: true, abs_noise: m.abs_noise }
              : {
                  recall_all: Number.isFinite(m.recall_all) ? m.recall_all : 0,
                  recall_any: Number.isFinite(m.recall_any) ? m.recall_any : 0,
                  ndcg_any: Number.isFinite(m.ndcg_any) ? m.ndcg_any : 0,
                }),
            num_haystack: sessions.length,
            latency_ms: Date.now() - qStart,
            top_k: opts.topK,
            dataset: opts.datasetName,
            ...(sessdiv !== null
              ? {
                  candidates_total: sessdiv.candidates_total,
                  distinct_before_slice: sessdiv.distinct_before_slice,
                  overfetch_factor: opts.overfetchFactor,
                }
              : {}),
            run_config_hash: rowConfigHash,
          };
          results.push(row);
          acc.score(probeId, abs
            ? m.abs_noise
            : Number.isFinite(m.recall_all) ? m.recall_all : 0);
          if (opts.ndjsonPath) {
            appendFileSync(opts.ndjsonPath, JSON.stringify(row) + '\n');
          }

          if ((i + 1) % 25 === 0 || i === all.length - 1) {
            const scored = results.filter(r => !isAbsQuestion(r.question_id) && r.error === undefined);
            const hitsAll = scored.filter(r => r.recall_all === 1).length;
            const elapsed = ((Date.now() - runStart) / 1000).toFixed(0);
            const pct = scored.length > 0 ? (hitsAll / scored.length * 100).toFixed(1) : '—';
            process.stderr.write(
              `[${adapter.name}] ${i + 1}/${all.length}  recall_all@${opts.topK}=${pct}%  ${elapsed}s\n`,
            );
          }
        } catch (err: any) {
          const msg = String(err?.message ?? err);
          process.stderr.write(`[${adapter.name}] ${q.question_id} error: ${msg}\n`);
          if (i === 0) process.stderr.write(`stack: ${err?.stack ?? ''}\n`);
          // On timeout (WASM hang / abort loop), the engine is unrecoverable.
          // Force a hard reset so the next question starts clean.
          if (msg.startsWith('question_timeout_')) {
            try { await resetEngineHard(); } catch (e: any) {
              process.stderr.write(`[${adapter.name}] engine reset failed: ${e?.message ?? e}\n`);
            }
          }
          const origin = classifyErrorOrigin(msg);
          acc.error(probeId, origin, msg);
          const errRow: NdjsonRow = {
            adapter: adapter.name,
            question_id: q.question_id,
            question_type: q.question_type,
            retrieved: [],
            ground_truth: q.answer_session_ids,
            hit_at_k: false,
            num_haystack: 0,
            latency_ms: Date.now() - qStart,
            top_k: opts.topK,
            dataset: opts.datasetName,
            run_config_hash: rowConfigHash,
            error: msg,
            error_origin: origin,
          };
          results.push(errRow);
          if (opts.ndjsonPath) {
            // Error rows stream for observability but readCompletedPairs
            // ignores them — the question re-runs on the next invocation.
            appendFileSync(opts.ndjsonPath, JSON.stringify(errRow) + '\n');
          }
          if (msg.startsWith('rerank_missing_score')) {
            // Contract violation is systemic, not per-question: every later
            // question would fail identically. Abort this adapter (recorded
            // in the receipt), continue with the remaining adapters.
            process.stderr.write(`[${adapter.name}] ABORT adapter: reranker contract violated (fail-closed)\n`);
            abortedAdapters.push({ adapter: adapter.name, reason: msg });
            break;
          }
        }
      }
    } finally {
      await engine.disconnect();
    }

    if (results.length === 0) {
      // Resume-complete shard (or wall budget hit before the first question):
      // nothing to summarize. Guard instead of emitting NaN/undefined summaries
      // (audit finding longmemeval-07).
      process.stderr.write(`[${adapter.name}] no questions processed this invocation (resume-complete or budget hit)\n`);
      continue;
    }

    const summary = summarizeAdapterRows(
      adapter.name,
      results,
      opts.topK,
      opts.datasetName,
      (Date.now() - runStart) / 1000,
    );
    summaries.push(summary);

    process.stderr.write(
      `\n[${adapter.name}] done. recall_all@${opts.topK}=${summary.recall_all_at_k === null ? '—' : (summary.recall_all_at_k * 100).toFixed(2) + '%'}` +
      ` recall_any@${opts.topK}=${summary.recall_any_at_k === null ? '—' : (summary.recall_any_at_k * 100).toFixed(2) + '%'}` +
      ` in ${summary.total_seconds.toFixed(0)}s\n`,
    );
  }

  if (cache) {
    const c = cache.stats;
    const total = c.hits + c.misses;
    const hitPct = total > 0 ? (c.hits / total * 100).toFixed(1) : '0.0';
    process.stderr.write(`\n[longmemeval] embed cache: ${c.hits} hits / ${c.misses} misses (${hitPct}% hit) | ${c.inserts} new entries | ${(c.bytes / 1024).toFixed(0)} KB written | ${cache.size()} total entries\n`);
    cache.close();
  }

  // ── Report JSON + markdown ──────────────────────────────────────
  // Raw run outputs land under eval/reports/ which is gitignored. Baselines
  // (the canonical numbers + SVG charts that drive a published report) get
  // hand-copied into docs/benchmarks/<slug>/ for permanent record.
  const resolved = {
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    embedding_model: resolvedEmbeddingModel,
    embedding_dimensions: resolvedEmbeddingDims,
    expansion_model: resolvedExpansionModel,
    // Per-adapter search pins (rerank specs overlay reranker.enabled=true) —
    // one flat pinned_search_config can no longer describe a mixed run.
    search_config_by_adapter: searchConfigByAdapter,
    // Full run_config_hash preimages, keyed by adapter: any row hash in the
    // NDJSON is reversible to the exact configuration that produced it.
    run_config_preimages: runConfigPreimages,
    overfetch_factor: opts.overfetchFactor,
    seed: opts.seed,
  };
  const reportDir = join(import.meta.dir, '..', 'reports', 'longmemeval');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = opts.output || join(reportDir, `longmemeval-${opts.datasetName}-${ts}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ opts: { ...opts, datasetName: opts.datasetName }, resolved, summaries }, null, 2) + '\n');
  process.stderr.write(`\n[longmemeval] raw results: ${reportPath}\n`);

  const md = fmt(summaries);
  const mdPath = reportPath.replace(/\.json$/, '.md');
  writeFileSync(mdPath, md + '\n');
  process.stderr.write(`[longmemeval] markdown: ${mdPath}\n`);
  process.stderr.write('\n' + md + '\n');

  // ── Receipt ─────────────────────────────────────────────────────
  const accSummary = acc.summary();
  const minGate = opts.minRecallAll ?? defaultMinRecallAll(opts.adapters);
  const gate = timedOut
    ? { verdict: 'partial' as const, reason: 'wall budget hit before the shard finished — aggregate the NDJSON for the final verdict' }
    : computeVerdict(summaries, minGate);
  const runInvalid = accSummary.run_invalid;
  const receipt: Receipt = {
    ...baseReceipt(startedAt),
    run_status: runInvalid ? 'error' : 'completed',
    ...(runInvalid ? {} : { verdict: gate.verdict }),
    n_total: accSummary.n_total,
    n_scored: accSummary.n_scored,
    completion_rate: accSummary.completion_rate,
    errors: accSummary.errors,
    // Partial invocations (shards, wall-budget exits, resume no-ops),
    // subsampled runs, and runs where any requested adapter was skipped or
    // aborted are never publishable as full-benchmark numbers.
    publishable: accSummary.publishable && gate.verdict !== 'partial'
      && opts.limit === null && opts.stratify === null && opts.totalWorkers === 1
      && skippedAdapters.length === 0 && abortedAdapters.length === 0,
    resolved_config: {
      search_config_by_adapter: searchConfigByAdapter,
      embedding_model: resolvedEmbeddingModel,
      embedding_dimensions: resolvedEmbeddingDims,
      expansion_model: resolvedExpansionModel,
      dataset: opts.datasetName,
      top_k: opts.topK,
      overfetch_factor: opts.overfetchFactor,
      seed: opts.seed,
      adapters: opts.adapters,
      min_recall_all_gate: minGate,
      worker_id: opts.workerId,
      total_workers: opts.totalWorkers,
      cache: !opts.noCache,
      ...(skippedAdapters.length > 0 ? { adapters_skipped: skippedAdapters } : {}),
      ...(abortedAdapters.length > 0 ? { adapters_aborted: abortedAdapters } : {}),
      ...(rerankAdaptersPending.length > 0
        ? {
            // D4c: rerank adapters ship fail-closed but have no published
            // keyed acceptance run yet — never quote their numbers as final.
            rerank_adapters_pending_acceptance: rerankAdaptersPending,
          }
        : {}),
    },
    finished_at: new Date().toISOString(),
    data: {
      headline_metric: 'recall_all_at_k',
      verdict_reason: gate.reason,
      infra_error_rate: accSummary.infra_error_rate,
      summaries,
    },
  };
  writeReceipt(receiptFile, receipt);
  process.stderr.write(`[longmemeval] receipt: ${receiptFile} (run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'})\n`);

  const exitCode = runInvalid ? 1 : gate.verdict === 'fail' ? 1 : 0;
  return { summaries, receipt, receiptFile, reportPath, exitCode };
}

// ─── Output ───────────────────────────────────────────────────────

function pctOrDash(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(2)}%`;
}

function msOrDash(x: number | null): string {
  return x === null ? '—' : `${x.toFixed(0)}ms`;
}

export function fmt(summaries: RunSummary[]): string {
  const out: string[] = [];
  out.push('# LongMemEval results\n');
  if (summaries.length === 0) {
    out.push('No adapter processed any question this invocation (resume-complete shard).');
    out.push('Aggregate the NDJSON stream with longmemeval-aggregate.ts for the full picture.');
    return out.join('\n');
  }
  out.push(`Dataset: \`${summaries[0].dataset}\`  |  Top-K: ${summaries[0].topK}  |  recall_all@k is the official LongMemEval headline; recall_any@k (any-hit) is strictly looser and shown as a diagnostic. \`_abs\` questions are excluded from recall denominators (official protocol) and scored as abs_noise@k. div@k = mean DISTINCT sessions in the scored top-k; shortfall = fraction of scored rows with fewer than k distinct sessions available (pre-slice supply for sessdiv rows).\n`);
  out.push('| Adapter | n | recall_all@k | recall_any@k | ndcg_any@k | div@k | shortfall | abs_noise@k (n_abs) | errors (sut/infra) | p50 | p99 | Wall |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summaries) {
    out.push(
      `| ${s.adapter} | ${s.total} | ${pctOrDash(s.recall_all_at_k)} | ${pctOrDash(s.recall_any_at_k)} | ${pctOrDash(s.ndcg_any_at_k)} | ${s.mean_distinct_sessions === null ? '—' : s.mean_distinct_sessions.toFixed(2)} | ${pctOrDash(s.session_shortfall_rate)} | ${pctOrDash(s.abs_noise_at_k)} (${s.n_abs}) | ${s.n_errors_sut}/${s.n_errors_infra} | ${msOrDash(s.p50_latency_ms)} | ${msOrDash(s.p99_latency_ms)} | ${s.total_seconds.toFixed(0)}s |`,
    );
  }
  out.push('');
  const types = Array.from(new Set(summaries.flatMap(s => Object.keys(s.recall_by_type)))).sort();
  if (types.length > 0) {
    out.push('## recall_all by question_type\n');
    out.push('| question_type | total | ' + summaries.map(s => s.adapter).join(' | ') + ' |');
    out.push('|---|---|' + summaries.map(() => '---').join('|') + '|');
    for (const t of types) {
      const total = summaries.find(s => s.recall_by_type[t])?.recall_by_type[t]?.total ?? 0;
      const cells = summaries.map(s => {
        const b = s.recall_by_type[t];
        return b ? `${(b.recall_all * 100).toFixed(1)}% (${b.hit_all}/${b.total})` : '—';
      });
      out.push(`| ${t} | ${total} | ${cells.join(' | ')} |`);
    }
  }
  return out.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────

if (import.meta.main) {
  const opts = parseOpts();
  try {
    const result = await run(opts);
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(LME_CATEGORY, opts.reportsDir), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: LME_CATEGORY,
        run_status: 'error',
        n_total: 0,
        n_scored: 0,
        completion_rate: 0,
        errors: [{ probe_id: 'preflight', origin: 'harness', message: String(e?.message ?? e).slice(0, 500) }],
        publishable: false,
        gbrain_version: gbrainVersion(),
        gbrain_pin: gbrainPin(),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });
    } catch { /* receipt write failed too — exit code carries the failure */ }
    process.stderr.write(`[longmemeval] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
