/**
 * Production relational retrieval OFF/ON, on the same extracted index.
 *
 * Both arms use the product's query parser, one shared query embedding, and
 * a five-chunk output window. Graph metadata remains enabled in both arms.
 * This measures the effect of enabling relational retrieval in that pipeline;
 * it does not compare graph databases or remove every use of graph data.
 *
 * Live: bun eval/runner/relational-ab.ts
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
import { configureGateway, getEmbeddingModel, getEmbeddingDimensions, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { GbrainInlineAdapter, assertStubEmbedTransport, gcNow } from './adapters/gbrain-inline.ts';
import { pagesInResultOrder } from './adapters/page-results.ts';
import { buildRelationalQueries, loadWorldCorpus } from './queries/relational.ts';
import { sanitizePage, sanitizeQuery, type PublicQuery, type Query } from './types.ts';
import { precisionAtK, recallAtK, recallAnyAtK } from './metrics.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt, type FailureOrigin } from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';
import { searchObservation } from './retrieval-pins.ts';

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
  rows: Array<{ slug: string; chunk_id?: number; source_id?: string; score: number }>;
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
  relevant: string[];
  off: ScoredArm;
  on: ScoredArm;
}

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
  vector: Float32Array,
  search: RelationalSearch = hybridSearch,
): Promise<{ off: ArmResult; on: ArmResult }> {
  if (vector.length !== RELATIONAL_EMBEDDER.dimensions || vector.some(v => !Number.isFinite(v))) {
    throw new ObservationError('harness', 'invalid shared query vector');
  }
  const queryHash = vectorHash(vector);
  const runArm = async (enabled: boolean): Promise<ArmResult> => {
    const started = performance.now();
    const result: ArmResult = {
      relational_retrieval: enabled, rows: [], pages: [], query_embed_calls: 0,
      query_vector_sha256: queryHash, relational_meta: [], search_meta: null, wall_ms: 0,
    };
    try {
      const rows = await search(engine, query.text, {
        limit: RELATIONAL_LIMIT,
        relationalRetrieval: enabled,
        relationalRetrievalDepth: 2,
        expansion: false,
        autocut: false,
        adaptiveReturn: false,
        queryEmbedFn: text => {
          if (text !== query.text) throw new ObservationError('harness', 'unexpected query rewrite with expansion disabled');
          result.query_embed_calls += 1;
          // Separate copies protect one arm from mutating the other's input.
          return new Float32Array(vector);
        },
        onRelationalMeta: meta => { result.relational_meta.push({ ...meta }); },
        onMeta: meta => { result.search_meta = meta; },
      });
      result.rows = rows.map(r => ({ slug: r.slug, chunk_id: r.chunk_id, source_id: r.source_id, score: r.score }));
      result.pages = pagesInResultOrder(rows, RELATIONAL_LIMIT).map(r => r.page_id);
      if (rows.length > RELATIONAL_LIMIT) throw new ObservationError('sut', 'product exceeded the five-chunk output limit');
      if (!result.search_meta || result.query_embed_calls === 0) {
        throw new ObservationError('harness', 'missing search telemetry or shared query embedding was not used');
      }
      if (!result.search_meta.vector_enabled || result.search_meta.expansion_applied) {
        throw new ObservationError('harness', 'vector retrieval disabled or expansion unexpectedly enabled');
      }
      if (rows.some(r => Number.isFinite(r.rerank_score))) throw new ObservationError('harness', 'reranker ran in an explicitly disabled cell');
      if (enabled && result.relational_meta.length === 0) throw new ObservationError('harness', 'missing ON-arm relational telemetry');
      if (!enabled && result.relational_meta.length !== 0) throw new ObservationError('harness', 'relational arm ran while disabled');
      if (result.relational_meta.some(m => m.errored)) throw new ObservationError('sut', 'relational arm failed open (errored telemetry)');
      const failures = searchObservation({ query: query.text, queryId: query.id, results: rows, meta: result.search_meta }).failures;
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

/** Reporting only. This never controls query parsing or retrieval. */
function templateOf(q: Query): string {
  return q.text.startsWith('Who attended ') ? 'attended'
    : q.text.startsWith('Who works at ') ? 'works_at'
    : q.text.startsWith('Who invested in ') ? 'invested_in' : 'advises';
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

export interface RelationalABOptions {
  outputDir?: string;
  reportsDir?: string;
  corpusDir?: string;
  seeds?: number[];
  limit?: number;
  stubEmbed?: boolean;
  allowSkip?: boolean;
  quiet?: boolean;
}

export function parseRelationalArgs(args: string[]): RelationalABOptions {
  const options: RelationalABOptions = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = () => {
      const next = args[++i];
      if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === '--stub-embed') options.stubEmbed = true;
    else if (flag === '--allow-skip') options.allowSkip = true;
    else if (flag === '--output-dir') options.outputDir = value();
    else if (flag === '--reports-dir') options.reportsDir = value();
    else if (flag === '--seeds') options.seeds = value().split(',').map(Number);
    else if (flag === '--limit') options.limit = Number(value());
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
}

export async function runRelationalAB(
  options: RelationalABOptions = {},
  search: RelationalSearch = hybridSearch,
): Promise<{ receipt: Receipt; exitCode: number }> {
  validateOptions(options);
  const started = new Date().toISOString();
  const outputDir = options.outputDir ?? join(options.reportsDir ?? join(import.meta.dir, '../reports'), 'relational-ab');
  const seeds = options.seeds ?? [...RELATIONAL_SEEDS];
  const stub = options.stubEmbed ?? false;
  const base = {
    schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: 'relational-ab',
    gbrain_version: gbrainVersion(), gbrain_pin: gbrainPin(), started_at: started,
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
  const queries = options.limit === undefined ? allQueries : allQueries.slice(0, options.limit);
  if (!pages.length || !queries.length) throw new Error('relational corpus/query set is empty');
  const accounting = new ProbeAccounting(seeds.length * queries.length * 2);
  const rows: PairedRow[] = [];
  const indices: Array<Record<string, unknown>> = [];
  const embeddings = new Map<string, Float32Array>();
  const log = options.quiet ? (_: string) => {} : (text: string) => console.log(text);
  const oldKey = process.env.OPENAI_API_KEY;
  if (stub) {
    process.env.OPENAI_API_KEY = 'relational-ab-stub';
    configureGateway({ embedding_model: RELATIONAL_EMBEDDER.model, embedding_dimensions: RELATIONAL_EMBEDDER.dimensions, env: process.env });
    __setEmbedTransportForTests((async (params: { values: string[] }) => ({
      embeddings: params.values.map(hashEmbedding), values: params.values, warnings: [],
    })) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);
  }
  try {
    for (const seed of seeds) {
      log(`Relational OFF/ON: ingestion seed ${seed}, ${queries.length} paired queries`);
      const shuffled = shuffle(pages, seed);
      const indexId = randomUUID();
      const adapter = new GbrainInlineAdapter({
        topK: RELATIONAL_LIMIT, extract: true, searchConfig: { ...RELATIONAL_PINS },
        embeddingModel: RELATIONAL_EMBEDDER.model, embeddingDimensions: RELATIONAL_EMBEDDER.dimensions,
        expectStubTransport: stub,
      });
      let state: Awaited<ReturnType<typeof adapter.init>> | undefined;
      try {
        state = await adapter.init(shuffled.map(sanitizePage), { name: 'relational-shared-index' });
        const engine = adapter.engineOf(state);
        const readback: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(RELATIONAL_PINS)) {
          readback[key] = await engine.getConfig(key);
          if (readback[key] !== value) throw new ObservationError('harness', `config readback mismatch: ${key}`);
        }
        if (getEmbeddingModel() !== RELATIONAL_EMBEDDER.model || getEmbeddingDimensions() !== RELATIONAL_EMBEDDER.dimensions) {
          throw new ObservationError('harness', 'embedding gateway drifted during index initialization');
        }
        indices.push({ seed, index_id: indexId, ingestion_order_sha256: sha256(JSON.stringify(shuffled.map(p => p.slug))), config_readback: readback });
        for (const query of queries) {
          let pair: { off: ArmResult; on: ArmResult };
          try {
            if (stub) assertStubEmbedTransport('relational pair');
            let vector = embeddings.get(query.text);
            if (!vector) { vector = await embedQuery(query.text); embeddings.set(query.text, vector); }
            pair = await searchRelationalPair(engine, sanitizeQuery(query), vector, search);
          } catch (error) {
            const origin = error instanceof ObservationError ? error.origin : 'dependency';
            pair = failedPair(origin, String(error));
          }
          appendRow(seed, indexId, query, pair);
          if (rows.length % 25 === 0) gcNow();
        }
      } catch (error) {
        const origin = error instanceof ObservationError ? error.origin : 'sut';
        for (const query of queries) {
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
      __setEmbedTransportForTests(null);
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
    }
  }
  const summary = accounting.summary();
  const incompleteRecipe = options.limit !== undefined || JSON.stringify(seeds) !== JSON.stringify(RELATIONAL_SEEDS) || options.corpusDir !== undefined;
  const valid = summary.errors.length === 0 && summary.completion_rate === 1;
  const data = {
    summary: summarizeRelationalRows(rows),
    by_seed: Object.fromEntries(seeds.map(seed => [seed, summarizeRelationalRows(rows.filter(r => r.seed === seed))])),
    by_template: Object.fromEntries(['attended', 'works_at', 'invested_in', 'advises'].map(template => [template, summarizeRelationalRows(rows.filter(r => r.template === template))])),
    indices, per_query: rows,
  };
  const receipt: Receipt = {
    ...base, finished_at: new Date().toISOString(), run_status: valid ? 'completed' : 'error',
    ...(valid ? { verdict: stub || incompleteRecipe ? 'partial' as const : 'pass' as const } : {}),
    n_total: summary.n_total, n_scored: summary.n_scored, completion_rate: summary.completion_rate,
    errors: summary.errors, publishable: valid && !stub && !incompleteRecipe,
    resolved_config: {
      embedder: RELATIONAL_EMBEDDER, stub_embed: stub, ingestion_seeds: seeds,
      common_search_pins: RELATIONAL_PINS, relational_retrieval: { off: false, on: true },
      query_embedding: 'embedQuery once per distinct question, identical bytes shared across arms and repeats',
      product_limit: RELATIONAL_LIMIT, ranking_unit: 'chunk rows', scoring_unit: 'first occurrence of each page, no refill',
      precision_denominator: RELATIONAL_LIMIT, corpus_pages: pages.length,
      queries_per_seed: queries.length, available_queries: allQueries.length,
      repeat_interpretation: 'ingestion-order sensitivity, not independent question samples',
      comparison: 'effect of enabling relational retrieval under fixed graph metadata settings',
    },
    hashes: {
      corpus: sha256(JSON.stringify(pages.map(sanitizePage))),
      queries_and_gold: sha256(JSON.stringify(queries)),
      runner: sha256(readFileSync(import.meta.path)),
    },
    data,
  };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'report.json'), JSON.stringify({ ...data, resolved_config: receipt.resolved_config, hashes: receipt.hashes }, null, 2) + '\n');
  writeReceipt(join(outputDir, 'receipt.json'), receipt);
  log(JSON.stringify(data.summary, null, 2));
  log(`Receipt: ${join(outputDir, 'receipt.json')}`);
  return { receipt, exitCode: valid ? 0 : 1 };

  function appendRow(seed: number, indexId: string, query: Query, pair: { off: ArmResult; on: ArmResult }): void {
    const relevant = new Set(query.gold.relevant ?? []);
    const row: PairedRow = {
      seed, index_id: indexId, query_id: query.id, text: query.text, template: templateOf(query), relevant: [...relevant],
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

function failedPair(origin: FailureOrigin, message: string): { off: ArmResult; on: ArmResult } {
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
