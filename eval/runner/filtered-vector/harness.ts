/**
 * Small pure pieces of the filtered vector search runner (run.ts), kept apart so they are unit-tested
 * (docs/benchmarks/2026-11-26-filtered-vector-material-preregistration.md).
 */

export type AttemptKind = 'walk' | 'scope' | 'exact' | 'joined' | 'other';

/**
 * Which of gbrain's vector attempts a statement is (src/core/search/vector-statement.ts at the pin): the index walk
 * (an ann CTE), the small-scope exact scan (a scope_scan CTE), the exact fallback (the joined candidates ordered by the
 * distance plus 0, so no index serves it), or the joined pooled attempt, the only one where the arms can differ.
 */
export function attemptKind(sql: string): AttemptKind {
  if (sql.includes('WITH ann AS MATERIALIZED')) return 'walk';
  if (sql.includes('WITH scope_scan AS MATERIALIZED')) return 'scope';
  if (!sql.includes('WITH hnsw_candidates AS')) return 'other';
  return /\)\s*\+\s*0\s+LIMIT\s/.test(sql) ? 'exact' : 'joined';
}

/** True when a slug takes a source factor other than 1 or is hard-excluded (prefix match, as gbrain applies them). */
export function boostedSlug(slug: string, boosts: Record<string, number>, hardExcludes: readonly string[]): boolean {
  return Object.entries(boosts).some(([prefix, factor]) => factor !== 1 && slug.startsWith(prefix)) || hardExcludes.some(prefix => slug.startsWith(prefix));
}

/** A W query's text: the chunk's first sentence when it has at least 30 characters, else the chunk, at most 300 characters (gbrain's hnsw-iterative-scan rule). */
export function firstSentence(chunk: string): string {
  const first = chunk.split(/(?<=[.!?])\s/)[0] ?? chunk;
  return (first.length >= 30 ? first : chunk).slice(0, 300);
}

/**
 * Which query set a cell uses: the independent set in independent mode, for sanity filters, and for a filter that leaves
 * no page in or no page out for the caller; otherwise the per-filter set drawn half from selected pages and half from the rest.
 */
export function queryPlan(mode: 'independent' | 'clustered', kind: string, inPages: number, outPages: number): 'independent' | 'stratified' {
  return mode === 'independent' || kind === 'sanity' || inPages === 0 || outPages === 0 ? 'independent' : 'stratified';
}
