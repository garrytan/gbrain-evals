import type { HybridSearchMeta } from 'gbrain/types';

/** Explicit controls for comparisons that should not inherit a user's search mode. */
export const RETRIEVAL_EMBEDDER = 'openai:text-embedding-3-large';
export const RETRIEVAL_DIMENSIONS = 1536;
export const RETRIEVAL_RERANKER = 'voyage:rerank-2.5';

export function retrievalPins(reranker = false, autocut = false): Record<string, string> {
  return {
    'search.mode': 'balanced',
    'search.reranker.enabled': String(reranker),
    'search.reranker.model': RETRIEVAL_RERANKER,
    'search.autocut': String(autocut),
    'search.expansion': 'false',
    'search.cache.enabled': 'false',
    'search.metadata_boost_gate': 'lexical',
    'search.relational_rerank_pin': '3',
    'search.adaptive_return': 'false',
  };
}

/** A provider fallback is an incomplete experiment, not evidence about the requested model. */
export function rerankerFailures(meta: unknown): string[] {
  const degraded = (meta as { degraded?: Array<{ stage?: string; reason?: string }> } | undefined)?.degraded ?? [];
  return degraded.filter(d => d.stage === 'reranker_skipped' || d.stage === 'rerank_passthrough')
    .map(d => `${d.stage}:${d.reason ?? 'unknown'}`);
}

/** These describe a valid retrieval outcome, not an exception or a missing provider.
 * An empty arm, a lexical rescue, or the configured token budget can hurt scores;
 * keeping those outcomes in the measurement is part of testing the product. */
const MEASURED_DEGRADATIONS = new Set([
  'keyword_zero', 'keyword_relaxed_carried', 'budget_dropped_all', 'budget_truncated',
]);

export interface SearchObservation {
  query_id?: string;
  query: string;
  mode: 'hybrid' | 'keyword';
  result_count: number;
  rerank_scored: boolean;
  /** Product order before the adapter collapses chunks or filters fixture IDs. */
  ranked_results: Array<{ slug: string; score: number; rank: number; chunk_id?: number; rerank_score?: number }>;
  search_meta: HybridSearchMeta | null;
  relational_meta: unknown;
  failures: string[];
  error?: string;
  empty_query_skipped?: boolean;
}

export interface SearchObservationOptions {
  query: string;
  queryId?: string;
  mode?: 'hybrid' | 'keyword';
  results?: ReadonlyArray<{ slug: string; score: number; chunk_id?: number; rerank_score?: number }>;
  meta?: HybridSearchMeta;
  relationalMeta?: unknown;
  requireReranker?: boolean;
  /** Undefined means the runner did not pin this setting. */
  expectedReranker?: boolean;
  expectedExpansion?: boolean;
  error?: unknown;
  emptyQuerySkipped?: boolean;
}

/** Capture every call, including throws and fail-open answers. No quality threshold
 * appears here: a successful search returning zero relevant pages is still valid. */
export function searchObservation(opts: SearchObservationOptions): SearchObservation {
  const results = opts.results ?? [];
  const rerankScored = results.some(r => Number.isFinite(r.rerank_score));
  const failures: string[] = [];
  if (opts.error !== undefined) failures.push('search_threw');
  if ((opts.mode ?? 'hybrid') === 'hybrid' && !opts.emptyQuerySkipped) {
    if (!opts.meta) failures.push('search_meta_missing');
    else {
      if (opts.meta.vector_enabled !== true) failures.push('vector_not_enabled');
      for (const d of opts.meta.degraded ?? []) {
        if (!MEASURED_DEGRADATIONS.has(d.stage)) failures.push(`${d.stage}:${d.reason ?? 'unknown'}`);
      }
      if (opts.expectedExpansion === false && opts.meta.expansion_applied) {
        failures.push('expansion_setting_mismatch');
      }
    }
    if ((opts.relationalMeta as { errored?: boolean } | undefined)?.errored) failures.push('relational_arm_failed');
    // A clean empty pool gives the reranker nothing to rank. It is not a provider failure.
    if ((opts.requireReranker || opts.expectedReranker === true) && results.length > 0 && !rerankScored) {
      failures.push('rerank_scores_missing');
    }
    if (opts.expectedReranker === false && rerankScored) failures.push('reranker_unexpected');
  }
  return {
    ...(opts.queryId === undefined ? {} : { query_id: opts.queryId }),
    query: opts.query, mode: opts.mode ?? 'hybrid', result_count: results.length,
    rerank_scored: rerankScored,
    ranked_results: results.map((r, i) => ({
      slug: r.slug, score: r.score, rank: i + 1,
      ...(r.chunk_id === undefined ? {} : { chunk_id: r.chunk_id }),
      ...(r.rerank_score === undefined ? {} : { rerank_score: r.rerank_score }),
    })),
    search_meta: opts.meta ? structuredClone(opts.meta) : null,
    relational_meta: opts.relationalMeta === undefined ? null : structuredClone(opts.relationalMeta),
    failures: [...new Set(failures)],
    ...(opts.error === undefined ? {} : { error: String(opts.error) }),
    ...(opts.emptyQuerySkipped ? { empty_query_skipped: true } : {}),
  };
}

/** Optional additions preserve the initial counter shape used by older runners. */
export interface SearchObservedStats {
  search_failed_queries?: number;
  search_failures?: Array<{ query_id: string; reasons: string[] }>;
  search_observations?: SearchObservation[];
}

export function recordSearchObservation(stats: SearchObservedStats & {
  queries: number; rerank_scored_queries: number;
  rerank_failed_queries?: number; rerank_failures?: Array<{ query_id: string; reasons: string[] }>;
  keyword_arm_confidence_stamped: number; keyword_arm_confidence_downweighted: number;
}, observation: SearchObservation): void {
  stats.queries += 1;
  (stats.search_observations ??= []).push(observation);
  if (observation.rerank_scored) stats.rerank_scored_queries += 1;
  if (observation.failures.length) {
    stats.search_failed_queries = (stats.search_failed_queries ?? 0) + 1;
    (stats.search_failures ??= []).push({ query_id: observation.query_id ?? observation.query, reasons: observation.failures });
  }
  const rerankFailures = observation.failures.filter(f => f.startsWith('rerank'));
  if (rerankFailures.length) {
    stats.rerank_failed_queries = (stats.rerank_failed_queries ?? 0) + 1;
    (stats.rerank_failures ??= []).push({ query_id: observation.query_id ?? observation.query, reasons: rerankFailures });
  }
  const kacf = observation.search_meta?.keyword_arm_confidence;
  if (kacf) {
    stats.keyword_arm_confidence_stamped += 1;
    if (kacf.downweighted) stats.keyword_arm_confidence_downweighted += 1;
  }
}

/** Runner-level rejection does not depend on an error-rate allowance: even one
 * fallback would mix a different search path into a controlled comparison. */
export function observedSearchFailures(observed: unknown, expectedQueries?: number): Array<{ query_id: string; reasons: string[] }> {
  const stats = observed as SearchObservedStats | undefined;
  const records = stats?.search_observations;
  const failures = records ? records.filter(o => o.failures.length > 0)
    .map(o => ({ query_id: o.query_id ?? o.query, reasons: o.failures }))
    : stats?.search_failures ?? ((stats?.search_failed_queries ?? 0) > 0
    ? [{ query_id: 'unknown', reasons: ['search_failures_without_query_records'] }] : []);
  if (expectedQueries !== undefined && (records?.length ?? 0) !== expectedQueries) {
    failures.push({ query_id: 'unknown', reasons: [`search_observation_count:${records?.length ?? 0}/${expectedQueries}`] });
  }
  return failures;
}
