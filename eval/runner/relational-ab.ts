/**
 * Production relational retrieval OFF/ON, on the same extracted index.
 *
 * Both arms use the product's query parser, one shared query embedding, and
 * a five-chunk output window. Graph metadata remains enabled in both arms.
 * This measures the effect of enabling relational retrieval in that pipeline;
 * it does not compare graph databases or remove every use of graph data.
 *
 * Two query splits run against the same index (--split template|paraphrase|both,
 * default both):
 *   template    the four world-v1 templates ("Who works at X?"), phrased in
 *               gbrain's relational-intent verbs, so their lift is an
 *               in-grammar upper bound (audit B-RAB-01);
 *   paraphrase  the same questions and gold reworded by a fixed seeded
 *               grammar (eval/generators/relational-paraphrase-gen.ts), frozen
 *               and committed before any scoring run. The runner refuses a
 *               paraphrase file that differs from the generator's output.
 * `by_split` reports each split's OFF/ON summary; `by_split_template`
 * breaks each split down by template.
 *
 * --limit N takes N queries round-robin across the four templates (audit
 * B-RAB-02: the first N were all "attended", which never fires relational
 * retrieval, so the documented smoke never exercised the treatment).
 *
 * Live runs embed through OpenAI and go through the budget ledger: pass
 * --budget-usd <dollars> (or BRAINBENCH_BUDGET_USD). The receipt's cost and
 * delivered_tokens come from the ledger; latency_ms summarizes arm wall time.
 *
 * Live: bun eval/runner/relational-ab.ts --budget-usd 1
 * Keyless plumbing: bun eval/runner/relational-ab.ts --stub-embed --limit 8 --seeds 1
 * Receipts: eval/reports/relational-ab/{receipt,report}.json
 */
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import { hybridSearch, type HybridSearchOpts } from 'gbrain/search/hybrid';
import type { HybridSearchMeta, SearchResult } from 'gbrain/types';
import { embedQuery } from 'gbrain/embedding';
import { configureGateway, getEmbeddingModel, getEmbeddingDimensions, __setEmbedTransportForTests, diagnoseEmbedding } from 'gbrain/ai/gateway';
import { GbrainInlineAdapter, assertStubEmbedTransport, gcNow } from './adapters/gbrain-inline.ts';
import { pagesInResultOrder } from './adapters/page-results.ts';
import { buildRelationalQueries, loadWorldCorpus, type RichPage } from './queries/relational.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { requirePaidArm } from './paid-arm.ts';
import { sourceTreeIdentity } from './receipt.ts';
import { PARAPHRASE_PATH, renderParaphraseFile, templateOfText, type ParaphraseFile } from '../generators/relational-paraphrase-gen.ts';
import { sanitizePage, sanitizeQuery, type PublicQuery, type Query } from './types.ts';
import { precisionAtK, recallAtK, recallAnyAtK } from './metrics.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, latencySummary, noModelSpend, type Receipt, type FailureOrigin } from './receipt.ts';
import { BudgetExceededError, budgetOptionsFrom, receiptCost, startPaidRun, type BudgetOptions, type BudgetRun, type PaidRequestGuard } from './budget-ledger.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';
import { searchObservation } from './retrieval-pins.ts';

/**
 * Extra engine config pins for a feature arm, from `GBRAIN_EVAL_SEARCH_PINS="key=value,key=value"`
 * (for example `search.relational_planner=true`). Applied after RELATIONAL_PINS, checked by the
 * config readback and recorded in the receipt. A build that does not know a key ignores it.
 */
export function evalSearchPins(raw: string | undefined = process.env.GBRAIN_EVAL_SEARCH_PINS): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const part of (raw ?? '').split(',').map(x => x.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq <= 0 || !/^search\.[a-z0-9_.]+$/.test(part.slice(0, eq))) throw new Error(`GBRAIN_EVAL_SEARCH_PINS: "${part}" is not search.<key>=<value>`);
    pins[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return pins;
}

export const RELATIONAL_LIMIT = 5;
export const RELATIONAL_EMBEDDER = { model: 'openai:text-embedding-3-large', dimensions: 1536 } as const;
export const RELATIONAL_SEEDS = [1, 2, 3] as const;
export const RELATIONAL_PINS: Readonly<Record<string, string>> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.autocut': 'false',
  'search.cache.enabled': 'false',
  'search.adaptive_return': 'false',
  'search.graph_signals': 'true',
  'search.metadata_boost_gate': 'lexical',
  'search.relational_retrieval_depth': '2',
};

type RelationalMeta = Parameters<NonNullable<HybridSearchOpts['onRelationalMeta']>>[0];
export type RelationalSearch = (engine: PGLiteEngine, text: string, opts: HybridSearchOpts) => Promise<SearchResult[]>;
export interface RetrievalMetrics { precision_at_5: number; recall_at_5: number; hit_at_1: number; hit_at_5: number }
export interface ArmResult {
  relational_retrieval: boolean;
  rows: Array<{ slug: string; chunk_id?: number; source_id?: string; score: number; relational?: { role: string; edges: Array<{ stored_from: string; stored_to: string; link_type: string }> } }>;
  pages: string[];
  query_embed_calls: number;
  query_vector_sha256: string;
  relational_meta: RelationalMeta[];
  search_meta: HybridSearchMeta | null;
  wall_ms: number;
  error?: { origin: FailureOrigin; message: string };
}
export interface ScoredArm extends ArmResult { metrics: RetrievalMetrics | null }
export interface PairedRow {
  seed: number;
  index_id: string;
  query_id: string;
  text: string;
  template: string;
  /** template | paraphrase here; other categories built on runSharedIndexPairs add their own splits. */
  split: string;
  relevant: string[];
  off: ScoredArm;
  on: ScoredArm;
}

export type QuerySplit = 'template' | 'paraphrase';
export const QUERY_SPLITS: readonly QuerySplit[] = ['template', 'paraphrase'];
const TEMPLATES = ['attended', 'works_at', 'invested_in', 'advises'] as const;
type SplitQuery = Query & { split: QuerySplit; template: string };

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function vectorHash(vector: Float32Array): string {
  return sha256(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

class ObservationError extends Error {
  constructor(readonly origin: FailureOrigin, message: string) { super(message); }
}

/** The scorer sees gold; this search boundary receives only PublicQuery. */
export async function searchRelationalPair(
  engine: PGLiteEngine,
  query: PublicQuery,
  /** null: keyword path (no embedding provider); both arms must then run without vectors. */
  vector: Float32Array | null,
  search: RelationalSearch = hybridSearch,
  options: { limit?: number } = {},
): Promise<{ off: ArmResult; on: ArmResult }> {
  const limit = options.limit ?? RELATIONAL_LIMIT;
  if (vector !== null && (vector.length !== RELATIONAL_EMBEDDER.dimensions || vector.some(v => !Number.isFinite(v)))) {
    throw new ObservationError('harness', 'invalid shared query vector');
  }
  const queryHash = vector === null ? 'keyword-only' : vectorHash(vector);
  const runArm = async (enabled: boolean): Promise<ArmResult> => {
    const started = performance.now();
    const result: ArmResult = {
      relational_retrieval: enabled, rows: [], pages: [], query_embed_calls: 0,
      query_vector_sha256: queryHash, relational_meta: [], search_meta: null, wall_ms: 0,
    };
    try {
      const rows = await search(engine, query.text, {
        limit,
        relationalRetrieval: enabled,
        relationalRetrievalDepth: 2,
        expansion: false,
        autocut: false,
        adaptiveReturn: false,
        ...(vector === null ? {} : {
          queryEmbedFn: (text: string) => {
            if (text !== query.text) throw new ObservationError('harness', 'unexpected query rewrite with expansion disabled');
            result.query_embed_calls += 1;
            // Separate copies protect one arm from mutating the other's input.
            return new Float32Array(vector);
          },
        }),
        onRelationalMeta: meta => { result.relational_meta.push({ ...meta }); },
        onMeta: meta => { result.search_meta = meta; },
      });
      result.rows = rows.map(r => {
        const rel = (r as { relational?: { role: string; edges?: Array<{ stored_from: string; stored_to: string; link_type: string }> } }).relational;
        return { slug: r.slug, chunk_id: r.chunk_id, source_id: r.source_id, score: r.score,
          ...(rel ? { relational: { role: rel.role, edges: (rel.edges ?? []).map(e => ({ stored_from: e.stored_from, stored_to: e.stored_to, link_type: e.link_type })) } } : {}) };
      });
      result.pages = pagesInResultOrder(rows, limit).map(r => r.page_id);
      if (rows.length > limit) throw new ObservationError('sut', `product exceeded the ${limit}-chunk output limit`);
      if (!result.search_meta) throw new ObservationError('harness', 'missing search telemetry');
      if (vector === null) {
        if (result.search_meta.vector_enabled) throw new ObservationError('harness', 'vector retrieval ran in a keyword-only cell (a provider key or embedding endpoint leaked in)');
      } else {
        if (result.query_embed_calls === 0) throw new ObservationError('harness', 'missing search telemetry or shared query embedding was not used');
        if (!result.search_meta.vector_enabled) throw new ObservationError('harness', 'vector retrieval disabled or expansion unexpectedly enabled');
      }
      if (result.search_meta.expansion_applied) throw new ObservationError('harness', 'vector retrieval disabled or expansion unexpectedly enabled');
      if (evalSearchPins()['search.reranker.enabled'] === 'true') {
        if (rows.length > 0 && !rows.some(r => Number.isFinite(r.rerank_score))) throw new ObservationError('harness', 'reranker pinned on but no row carries a rerank score (the reranker fail-opened)');
      } else if (rows.some(r => Number.isFinite(r.rerank_score))) throw new ObservationError('harness', 'reranker ran in an explicitly disabled cell');
      if (enabled && result.relational_meta.length === 0) throw new ObservationError('harness', 'missing ON-arm relational telemetry');
      if (!enabled && result.relational_meta.length !== 0) throw new ObservationError('harness', 'relational arm ran while disabled');
      if (result.relational_meta.some(m => m.errored)) throw new ObservationError('sut', 'relational arm failed open (errored telemetry)');
      const failures = searchObservation({ query: query.text, queryId: query.id, results: rows, meta: result.search_meta }).failures
        // The keyword cell has no embedding provider by design; every other degradation still invalidates it.
        .filter(f => vector !== null || (f !== 'vector_not_enabled' && !f.startsWith('embed_unavailable:')));
      if (failures.length > 0) throw new ObservationError('sut', `search incomplete: ${failures.join(', ')}`);
    } catch (error) {
      result.error = {
        origin: error instanceof ObservationError ? error.origin : 'sut',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    result.wall_ms = performance.now() - started;
    return result;
  };
  // Sequential calls on one engine avoid process-global gateway/config races.
  return { off: await runArm(false), on: await runArm(true) };
}

export function scoreRelationalArm(result: ArmResult, relevant: ReadonlySet<string>): ScoredArm {
  const metrics: RetrievalMetrics = {
    precision_at_5: precisionAtK(result.pages, relevant, RELATIONAL_LIMIT),
    recall_at_5: recallAtK(result.pages, relevant, RELATIONAL_LIMIT),
    hit_at_1: recallAnyAtK(result.pages, relevant, 1),
    hit_at_5: recallAnyAtK(result.pages, relevant, RELATIONAL_LIMIT),
  };
  if (result.error) {
    return { ...result, metrics: result.error.origin === 'sut'
      ? { precision_at_5: 0, recall_at_5: 0, hit_at_1: 0, hit_at_5: 0 } : null };
  }
  return { ...result, metrics };
}

const METRICS = ['precision_at_5', 'recall_at_5', 'hit_at_1', 'hit_at_5'] as const;
export function summarizeRelationalRows(rows: readonly PairedRow[]) {
  const arm = (key: 'off' | 'on') => {
    const scored = rows.map(r => r[key]).filter(r => r.metrics !== null);
    return {
      n_scored: scored.length,
      ...Object.fromEntries(METRICS.map(metric => [metric, scored.length
        ? scored.reduce((sum, r) => sum + r.metrics![metric], 0) / scored.length : null])),
      relational_fired_queries: scored.filter(r => r.relational_meta.some(m => m.fired)).length,
      mean_returned_chunks: scored.length ? scored.reduce((sum, r) => sum + r.rows.length, 0) / scored.length : null,
      mean_distinct_pages: scored.length ? scored.reduce((sum, r) => sum + r.pages.length, 0) / scored.length : null,
    };
  };
  const comparable = rows.filter(r => r.off.metrics !== null && r.on.metrics !== null);
  return {
    off: arm('off'), on: arm('on'),
    paired: Object.fromEntries(METRICS.map(metric => {
      const differences = comparable.map(r => r.on.metrics![metric] - r.off.metrics![metric]);
      return [metric, {
        n: differences.length,
        gains: differences.filter(d => d > 1e-12).length,
        losses: differences.filter(d => d < -1e-12).length,
        ties: differences.filter(d => Math.abs(d) <= 1e-12).length,
      }];
    })),
  };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const j = Math.floor((state / 0x100000000) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The paraphrase split: every template query reworded by the frozen grammar,
 * with the template query's id suffix, gold and template kept. Refuses a
 * committed file that differs from the generator (paraphrases are fixed
 * before scoring) or that does not cover the template queries one-to-one.
 */
export function paraphraseQueries(templateQueries: readonly Query[], corpusDir?: string): SplitQuery[] {
  const committed = readFileSync(PARAPHRASE_PATH, 'utf8');
  if (corpusDir === undefined && committed !== renderParaphraseFile()) {
    throw new ObservationError('harness', `${PARAPHRASE_PATH} differs from eval/generators/relational-paraphrase-gen.ts output; paraphrases must be frozen before scoring`);
  }
  const file = JSON.parse(corpusDir === undefined ? committed : renderParaphraseFile(corpusDir)) as ParaphraseFile;
  const byId = new Map(file.paraphrases.map(p => [p.query_id, p]));
  if (byId.size !== templateQueries.length || templateQueries.some(q => !byId.has(q.id))) {
    throw new ObservationError('harness', 'paraphrase set does not cover the template queries one-to-one');
  }
  return templateQueries.map(q => {
    const p = byId.get(q.id)!;
    return { ...q, id: `${q.id}-p`, text: p.text, split: 'paraphrase' as const, template: p.template };
  });
}

/** --limit N: N queries taken round-robin across templates, in query order. */
export function stratifiedLimit<T extends { template: string }>(queries: readonly T[], limit: number | undefined): T[] {
  if (limit === undefined) return [...queries];
  const buckets = TEMPLATES.map(t => queries.filter(q => q.template === t));
  const out: T[] = [];
  for (let i = 0; out.length < limit && buckets.some(b => i < b.length); i++) {
    for (const b of buckets) if (i < b.length && out.length < limit) out.push(b[i]!);
  }
  return out;
}

function hashEmbedding(text: string): number[] {
  const values = new Array<number>(RELATIONAL_EMBEDDER.dimensions).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const hash = createHash('sha256').update(token).digest().readUInt32LE();
    values[hash % values.length] += 1;
  }
  const norm = Math.hypot(...values) || 1;
  return values.map(v => v / norm);
}

/** The gbrain functions relational-ab calls, from the pinned package or a copied overlay. */
export interface RelationalProduct {
  /** Overlay root, or null for the pinned dependency (static imports). */
  root: string | null;
  hybridSearch: RelationalSearch;
  embedQuery: (text: string) => Promise<Float32Array>;
  configureGateway: typeof configureGateway;
  getEmbeddingModel: typeof getEmbeddingModel;
  getEmbeddingDimensions: typeof getEmbeddingDimensions;
  setEmbedTransport: typeof __setEmbedTransportForTests;
  diagnoseEmbedding: typeof diagnoseEmbedding;
}

export const PINNED_RELATIONAL_PRODUCT: RelationalProduct = {
  root: null, hybridSearch, embedQuery, configureGateway, getEmbeddingModel, getEmbeddingDimensions,
  setEmbedTransport: __setEmbedTransportForTests, diagnoseEmbedding,
};

/** Load every gbrain module the harness uses from one tree, so the gateway state is the overlay's own. */
export async function loadRelationalProduct(gut: GbrainUnderTest | null): Promise<RelationalProduct> {
  if (!gut?.overlay) return PINNED_RELATIONAL_PRODUCT;
  const search = await importGbrain<{ hybridSearch: RelationalSearch }>(gut, 'src/core/search/hybrid.ts');
  const embedding = await importGbrain<{ embedQuery: RelationalProduct['embedQuery'] }>(gut, 'src/core/embedding.ts');
  const gateway = await importGbrain<{
    configureGateway: typeof configureGateway; getEmbeddingModel: typeof getEmbeddingModel; getEmbeddingDimensions: typeof getEmbeddingDimensions;
    __setEmbedTransportForTests: typeof __setEmbedTransportForTests; diagnoseEmbedding: typeof diagnoseEmbedding;
  }>(gut, 'src/core/ai/gateway.ts');
  return {
    root: gut.root, hybridSearch: search.hybridSearch, embedQuery: embedding.embedQuery,
    configureGateway: gateway.configureGateway, getEmbeddingModel: gateway.getEmbeddingModel, getEmbeddingDimensions: gateway.getEmbeddingDimensions,
    setEmbedTransport: gateway.__setEmbedTransportForTests, diagnoseEmbedding: gateway.diagnoseEmbedding,
  };
}

/**
 * How the shared index and the query vector are made:
 *   openai   live OpenAI embeddings (paid, through the budget ledger);
 *   stub     hash embeddings through gbrain's test transport (plumbing only);
 *   keyword  no embedding at all: pages imported without vectors, both arms
 *            on gbrain's keyword path, the keyless default.
 */
export type EmbedMode = 'openai' | 'stub' | 'keyword';

export interface SharedIndexQuery extends Query { split: string; template: string; /** Result rows for this query; defaults to the run's limit. */ limit?: number }

export interface SharedIndexRun {
  rows: PairedRow[];
  indices: Array<Record<string, unknown>>;
}

/**
 * The relational-ab experiment core: per ingestion seed, build one extracted
 * index, run every query with relational retrieval off and on over it, and
 * pair the results. `afterIndex` runs extra probes on each live index (for
 * example presence checks) before it is torn down; its errors are harness
 * errors on that seed.
 */
export async function runSharedIndexPairs(o: {
  product: RelationalProduct;
  pages: readonly RichPage[];
  queries: readonly SharedIndexQuery[];
  seeds: readonly number[];
  embed: EmbedMode;
  limit?: number;
  search?: RelationalSearch;
  accounting: ProbeAccounting;
  log?: (line: string) => void;
  afterIndex?: (engine: PGLiteEngine, seed: number, search: RelationalSearch) => Promise<void>;
}): Promise<SharedIndexRun> {
  const { product, accounting, embed } = o;
  const search = o.search ?? product.hybridSearch;
  const limit = o.limit ?? RELATIONAL_LIMIT;
  const log = o.log ?? (() => {});
  const pins = { ...RELATIONAL_PINS, ...evalSearchPins() };
  const rows: PairedRow[] = [];
  const indices: Array<Record<string, unknown>> = [];
  const embeddings = new Map<string, Float32Array>();
  const stub = embed === 'stub';
  const oldKey = process.env.OPENAI_API_KEY;
  if (stub) {
    process.env.OPENAI_API_KEY = 'relational-ab-stub';
    product.configureGateway({ embedding_model: RELATIONAL_EMBEDDER.model, embedding_dimensions: RELATIONAL_EMBEDDER.dimensions, env: process.env });
    product.setEmbedTransport((async (params: { values: string[] }) => ({
      embeddings: params.values.map(hashEmbedding), values: params.values, warnings: [],
    })) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);
  }
  try {
    for (const seed of o.seeds) {
      log(`Relational OFF/ON: ingestion seed ${seed}, ${o.queries.length} paired queries (${embed})`);
      const shuffled = shuffle(o.pages, seed);
      const indexId = randomUUID();
      const adapter = new GbrainInlineAdapter({
        topK: limit, extract: true, searchConfig: { ...pins },
        embeddingModel: RELATIONAL_EMBEDDER.model, embeddingDimensions: RELATIONAL_EMBEDDER.dimensions,
        expectStubTransport: stub, embed: embed !== 'keyword', ...(product.root ? { productRoot: product.root } : {}),
      });
      let state: Awaited<ReturnType<typeof adapter.init>> | undefined;
      try {
        state = await adapter.init(shuffled.map(sanitizePage), { name: 'relational-shared-index' });
        const engine = adapter.engineOf(state);
        const readback: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(pins)) {
          readback[key] = await engine.getConfig(key);
          if (readback[key] !== value) throw new ObservationError('harness', `config readback mismatch: ${key}`);
        }
        if (embed !== 'keyword' && (product.getEmbeddingModel() !== RELATIONAL_EMBEDDER.model || product.getEmbeddingDimensions() !== RELATIONAL_EMBEDDER.dimensions)) {
          throw new ObservationError('harness', 'embedding gateway drifted during index initialization');
        }
        indices.push({ seed, index_id: indexId, ingestion_order_sha256: sha256(JSON.stringify(shuffled.map(p => p.slug))), config_readback: readback });
        for (const query of o.queries) {
          let pair: { off: ArmResult; on: ArmResult };
          try {
            if (stub) assertStubEmbedTransport('relational pair', product.diagnoseEmbedding);
            let vector: Float32Array | null = null;
            if (embed !== 'keyword') {
              vector = embeddings.get(query.text) ?? null;
              if (!vector) { vector = await product.embedQuery(query.text); embeddings.set(query.text, vector); }
            }
            pair = await searchRelationalPair(engine, sanitizeQuery(query), vector, search, { limit: query.limit ?? limit });
          } catch (error) {
            const origin = error instanceof ObservationError ? error.origin : 'dependency';
            pair = failedPair(origin, String(error));
          }
          appendRow(seed, indexId, query, pair);
          if (rows.length % 25 === 0) gcNow();
        }
        if (o.afterIndex) {
          try { await o.afterIndex(engine, seed, search); }
          catch (error) { accounting.error(`${seed}:after-index`, 'harness', `after-index probes failed: ${String(error)}`); }
        }
      } catch (error) {
        const origin = error instanceof ObservationError ? error.origin : 'sut';
        for (const query of o.queries) {
          if (!rows.some(r => r.seed === seed && r.query_id === query.id)) appendRow(seed, indexId, query, failedPair(origin, `index initialization: ${String(error)}`));
        }
      } finally {
        if (state !== undefined) {
          try { await adapter.teardown(state); }
          catch (error) { accounting.error(`${seed}:teardown`, 'harness', `index cleanup failed: ${String(error)}`); }
        }
      }
    }
  } finally {
    if (stub) {
      product.setEmbedTransport(null);
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
    }
  }
  return { rows, indices };

  function appendRow(seed: number, indexId: string, query: SharedIndexQuery, pair: { off: ArmResult; on: ArmResult }): void {
    const relevant = new Set(query.gold.relevant ?? []);
    const row: PairedRow = {
      seed, index_id: indexId, query_id: query.id, text: query.text, template: query.template, split: query.split, relevant: [...relevant],
      off: scoreRelationalArm(pair.off, relevant), on: scoreRelationalArm(pair.on, relevant),
    };
    rows.push(row);
    for (const arm of ['off', 'on'] as const) {
      const result = row[arm];
      const id = `${seed}:${query.id}:${arm}`;
      if (result.error) accounting.error(id, result.error.origin, result.error.message);
      else accounting.score(id, result.metrics!.recall_at_5);
    }
  }
}

export interface RelationalABOptions {
  outputDir?: string;
  reportsDir?: string;
  corpusDir?: string;
  seeds?: number[];
  limit?: number;
  /** Which query splits to run. Default both. */
  split?: QuerySplit | 'both';
  /** --budget-usd / --budget-ledger / --program-cap-usd (live runs only). */
  budget?: BudgetOptions;
  /** argv when --paid or --budget-run-id was given: the live arm then runs only through requirePaidArm. */
  paidArgv?: string[];
  /** --gbrain <checkout>[@ref]: measure a copied overlay instead of the pinned package. */
  gbrainSpec?: string;
  stubEmbed?: boolean;
  allowSkip?: boolean;
  quiet?: boolean;
}

export const RELATIONAL_AB_ESTIMATE_USD = 0.07;

export function parseRelationalArgs(args: string[]): RelationalABOptions {
  const options: RelationalABOptions = {};
  if (args.some(a => /^--(budget-usd|budget-ledger|program-cap-usd|budget-run-id)(=|$)/.test(a))) options.budget = budgetOptionsFrom(args);
  if (args.some(a => a === '--paid' || /^--budget-run-id(=|$)/.test(a))) options.paidArgv = [...args];
  const spec = gbrainSpecFrom(args);
  if (spec) options.gbrainSpec = spec;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = () => {
      const next = args[++i];
      if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === '--stub-embed') options.stubEmbed = true;
    else if (flag === '--allow-skip') options.allowSkip = true;
    else if (flag === '--paid') continue;
    else if (flag === '--output-dir') options.outputDir = value();
    else if (flag === '--reports-dir') options.reportsDir = value();
    else if (flag === '--seeds') options.seeds = value().split(',').map(Number);
    else if (flag === '--limit') options.limit = Number(value());
    else if (flag === '--split') options.split = value() as RelationalABOptions['split'];
    else if (['--budget-usd', '--budget-ledger', '--program-cap-usd', '--budget-run-id', '--gbrain'].includes(flag)) value();
    else if (flag.startsWith('--gbrain=')) continue;
    else throw new Error(`unknown option: ${flag}`);
  }
  validateOptions(options);
  return options;
}

function validateOptions(options: RelationalABOptions): void {
  if (options.seeds && (!options.seeds.length || new Set(options.seeds).size !== options.seeds.length
    || options.seeds.some(s => !Number.isInteger(s) || s < 1 || s > 0xffffffff))) {
    throw new Error('--seeds must contain distinct positive 32-bit integers');
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  if (options.split !== undefined && !['template', 'paraphrase', 'both'].includes(options.split)) {
    throw new Error('--split must be template, paraphrase or both');
  }
}

export async function runRelationalAB(
  options: RelationalABOptions = {},
  search?: RelationalSearch,
): Promise<{ receipt: Receipt; exitCode: number }> {
  validateOptions(options);
  const started = new Date().toISOString();
  const outputDir = options.outputDir ?? join(options.reportsDir ?? join(import.meta.dir, '../reports'), 'relational-ab');
  const seeds = options.seeds ?? [...RELATIONAL_SEEDS];
  const stub = options.stubEmbed ?? false;
  const gut = options.gbrainSpec ? resolveGbrainUnderTest(options.gbrainSpec) : null;
  const product = await loadRelationalProduct(gut);
  const base = {
    schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: 'relational-ab',
    gbrain_version: gut ? gut.version : gbrainVersion(), gbrain_pin: gbrainPin(), started_at: started,
    ...(gut ? { execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) } } : {}),
  } as const;
  if (!stub && !process.env.OPENAI_API_KEY) {
    const receipt: Receipt = {
      ...base, finished_at: new Date().toISOString(), run_status: 'skipped',
      skip_reason: 'OPENAI_API_KEY required; --stub-embed checks plumbing only',
      n_total: 0, n_scored: 0, completion_rate: 0, errors: [], publishable: false,
    };
    writeReceipt(join(outputDir, 'receipt.json'), receipt);
    return { receipt, exitCode: options.allowSkip ? 0 : 2 };
  }
  const pages = loadWorldCorpus(options.corpusDir ?? join(import.meta.dir, '../data/world-v1'));
  const allQueries = buildRelationalQueries(pages);
  const templateQueries: SplitQuery[] = allQueries.map(q => ({ ...q, split: 'template' as const, template: templateOfText(q.text) }));
  const split = options.split ?? 'both';
  const selectedTemplates = stratifiedLimit(templateQueries, options.limit);
  const queries: SplitQuery[] = [
    ...(split === 'paraphrase' ? [] : selectedTemplates),
    ...(split === 'template' ? [] : paraphraseQueries(selectedTemplates, options.corpusDir)),
  ];
  if (!pages.length || !queries.length) throw new Error('relational corpus/query set is empty');
  let paid: { run: BudgetRun; guard: PaidRequestGuard } | null = null;
  if (!stub) {
    if (options.paidArgv) requirePaidArm(options.paidArgv, { arm: 'relational-ab live arm (OpenAI embeddings)', estimateUsd: RELATIONAL_AB_ESTIMATE_USD });
    try {
      paid = startPaidRun('relational-ab', { ...(options.budget ?? budgetOptionsFrom([])), estimateUsd: options.paidArgv ? RELATIONAL_AB_ESTIMATE_USD : null });
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      const receipt: Receipt = {
        ...base, finished_at: new Date().toISOString(), run_status: 'skipped', skip_reason: `budget: ${error.message}`,
        n_total: 0, n_scored: 0, completion_rate: 0, errors: [], publishable: false,
      };
      writeReceipt(join(outputDir, 'receipt.json'), receipt);
      return { receipt, exitCode: options.allowSkip ? 0 : 2 };
    }
  }
  const accounting = new ProbeAccounting(seeds.length * queries.length * 2);
  const log = options.quiet ? (_: string) => {} : (text: string) => console.log(text);
  let run: SharedIndexRun;
  try {
    run = await runSharedIndexPairs({ product, pages, queries, seeds, embed: stub ? 'stub' : 'openai', search, accounting, log });
  } finally {
    paid?.guard.uninstall();
  }
  const { rows, indices } = run;
  const summary = accounting.summary();
  const incompleteRecipe = options.limit !== undefined || JSON.stringify(seeds) !== JSON.stringify(RELATIONAL_SEEDS) || options.corpusDir !== undefined || split !== 'both';
  const valid = summary.errors.length === 0 && summary.completion_rate === 1;
  const data = {
    summary: summarizeRelationalRows(rows),
    by_seed: Object.fromEntries(seeds.map(seed => [seed, summarizeRelationalRows(rows.filter(r => r.seed === seed))])),
    by_template: Object.fromEntries(TEMPLATES.map(template => [template, summarizeRelationalRows(rows.filter(r => r.template === template))])),
    by_split: Object.fromEntries(QUERY_SPLITS.filter(s => rows.some(r => r.split === s)).map(s => [s, summarizeRelationalRows(rows.filter(r => r.split === s))])),
    by_split_template: Object.fromEntries(QUERY_SPLITS.filter(s => rows.some(r => r.split === s)).map(s => [s,
      Object.fromEntries(TEMPLATES.map(template => [template, summarizeRelationalRows(rows.filter(r => r.split === s && r.template === template))]))])),
    indices, per_query: rows,
  };
  const receipt: Receipt = {
    ...base, finished_at: new Date().toISOString(), run_status: valid ? 'completed' : 'error',
    ...(valid ? { verdict: stub || incompleteRecipe ? 'partial' as const : 'pass' as const } : {}),
    n_total: summary.n_total, n_scored: summary.n_scored, completion_rate: summary.completion_rate,
    errors: summary.errors, publishable: valid && !stub && !incompleteRecipe,
    resolved_config: {
      embedder: RELATIONAL_EMBEDDER, stub_embed: stub, ingestion_seeds: seeds,
      common_search_pins: { ...RELATIONAL_PINS, ...evalSearchPins() }, relational_retrieval: { off: false, on: true },
      query_embedding: 'embedQuery once per distinct question, identical bytes shared across arms and repeats',
      product_limit: RELATIONAL_LIMIT, ranking_unit: 'chunk rows', scoring_unit: 'first occurrence of each page, no refill',
      precision_denominator: RELATIONAL_LIMIT, corpus_pages: pages.length,
      queries_per_seed: queries.length, available_queries: allQueries.length,
      splits: split === 'both' ? [...QUERY_SPLITS] : [split],
      paraphrase_grammar: split === 'template' ? null : { path: 'eval/data/relational-paraphrase-v1/paraphrases.json', generator: 'eval/generators/relational-paraphrase-gen.ts',
        sha256: sha256(readFileSync(PARAPHRASE_PATH)) },
      limit_selection: options.limit === undefined ? null : 'round-robin across templates',
      repeat_interpretation: 'ingestion-order sensitivity, not independent question samples',
      comparison: 'effect of enabling relational retrieval under fixed graph metadata settings',
      gbrain_overlay: gut ? overlaySummary(gut) : null,
      paid_guard: options.paidArgv ? '--paid --budget-run-id (eval/runner/paid-arm.ts)' : null,
    },
    hashes: {
      corpus: sha256(JSON.stringify(pages.map(sanitizePage))),
      queries_and_gold: sha256(JSON.stringify(queries)),
      runner: sha256(readFileSync(import.meta.path)),
    },
    data,
    ...(stub ? noModelSpend('hash embedding stub: no model and no paid request') : {}),
    latency_ms: latencySummary(rows.flatMap(r => [r.off, r.on]).filter(a => !a.error).map(a => a.wall_ms), 'wall time of each successful hybridSearch arm call (shared query embedding precomputed, index build excluded)'),
  };
  if (paid) {
    const spend = paid.run.close();
    receipt.cost = receiptCost(spend);
    receipt.delivered_tokens = { tokens: spend.input_tokens, basis: 'provider-reported input tokens of every paid embedding request (corpus pages per seed plus distinct questions), from the budget ledger' };
    paid = null;
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'report.json'), JSON.stringify({ ...data, resolved_config: receipt.resolved_config, hashes: receipt.hashes }, null, 2) + '\n');
  writeReceipt(join(outputDir, 'receipt.json'), receipt);
  log(JSON.stringify(data.summary, null, 2));
  log(`Receipt: ${join(outputDir, 'receipt.json')}`);
  return { receipt, exitCode: valid ? 0 : 1 };
}

export function failedPair(origin: FailureOrigin, message: string): { off: ArmResult; on: ArmResult } {
  const failed = (enabled: boolean): ArmResult => ({
    relational_retrieval: enabled, rows: [], pages: [], query_embed_calls: 0,
    query_vector_sha256: '', relational_meta: [], search_meta: null, wall_ms: 0,
    error: { origin, message },
  });
  return { off: failed(false), on: failed(true) };
}

if (import.meta.main) {
  runRelationalAB(parseRelationalArgs(process.argv.slice(2)))
    .then(result => { process.exitCode = result.exitCode; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
