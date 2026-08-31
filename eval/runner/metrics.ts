/**
 * Shared ranking-metric primitives + per-benchmark wrappers (BrainBench v0.4.0).
 *
 * One denominator policy, one place to test. This file replaces the ~7
 * divergent recall/precision implementations that previously lived in
 * cat6 / cat15 / cat18 / cat18b / cat21 / cat26 / multi-adapter /
 * shootout-driver (audit 2026-08-31, findings shared-infra-02/03 and
 * the critic's cross-cut).
 *
 * Contract (WS0):
 *   - Callers pass NORMALIZED id lists. Chunk→page and turn→session mapping
 *     is the runner's explicit job — a chunk-grained result list handed to
 *     recallAtK will double-count and that is the caller's bug, not this
 *     file's leniency. Normalize first (`uniqueInOrder` helps).
 *   - Gold sets are Sets, so duplicates in gold cannot inflate denominators.
 *   - Binary recall_all (LongMemEval-style), fractional recall, and graded
 *     nDCG are DIFFERENT metrics with different formulas. They are separate
 *     functions here, not flags on one function.
 */

// ─── Primitives ──────────────────────────────────────────────────────

/** First occurrence of each id, order preserved. Use to normalize chunk-grained results. */
export function uniqueInOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Count of DISTINCT relevant ids present in the list (duplicates count once). */
export function uniqueHits(ids: readonly string[], relevant: ReadonlySet<string>): number {
  const matched = new Set<string>();
  for (const id of ids) if (relevant.has(id)) matched.add(id);
  return matched.size;
}

/** 1-based rank of the first relevant id; Infinity when none is present. */
export function rankOfFirstHit(ids: readonly string[], relevant: ReadonlySet<string>): number {
  for (let i = 0; i < ids.length; i++) {
    if (relevant.has(ids[i])) return i + 1;
  }
  return Infinity;
}

/**
 * Percentile with linear interpolation on the sorted copy (inclusive method,
 * same as numpy.percentile default). p in [0, 100]. Returns NaN on empty input
 * so callers cannot mistake "no data" for "0ms".
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (Math.min(Math.max(p, 0), 100) / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── Fractional recall / precision (BrainBench relational metrics) ──

/**
 * Recall@k: fraction of the relevant set found in the top-k, counting each
 * relevant id at most once. Never exceeds 1.0. Empty relevant set returns NaN
 * — exclude such queries from means instead of averaging in a fake 0.
 */
export function recallAtK(ids: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return NaN;
  return uniqueHits(ids.slice(0, k), relevant) / relevant.size;
}

/**
 * Precision@k with the standard /k denominator. An adapter that returns fewer
 * than k results is scored as if the missing slots were misses — returning
 * one relevant doc is NOT P@10 = 1.0 (audit finding shared-infra-03).
 */
export function precisionAtK(ids: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (k <= 0) return NaN;
  return uniqueHits(ids.slice(0, k), relevant) / k;
}

/** Mean Reciprocal Rank contribution for one query: 1/rank of first hit, 0 if no hit. */
export function reciprocalRank(ids: readonly string[], relevant: ReadonlySet<string>): number {
  const r = rankOfFirstHit(ids, relevant);
  return Number.isFinite(r) ? 1 / r : 0;
}

// ─── Binary recall_all (LongMemEval official definition) ────────────

/**
 * recall_all@k: 1 if EVERY relevant id appears in the top-k, else 0. This is
 * the official LongMemEval session-level metric (`all(doc in recalled_docs
 * for doc in correct_docs)`), the number published systems report against.
 * Any-hit recall is a strictly looser metric — never present it as this one.
 */
export function recallAllAtK(ids: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return NaN;
  const top = new Set(ids.slice(0, k));
  for (const r of relevant) if (!top.has(r)) return 0;
  return 1;
}

/** Any-hit recall@k: 1 if at least one relevant id is in the top-k. Diagnostic only. */
export function recallAnyAtK(ids: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return NaN;
  return uniqueHits(ids.slice(0, k), relevant) > 0 ? 1 : 0;
}

// ─── Graded nDCG ─────────────────────────────────────────────────────

/**
 * DCG@k over graded relevance. `grades` maps id → gain (missing id = 0).
 * Uses the standard log2 discount: sum(grade_i / log2(i + 1)), 1-based i.
 */
export function dcgAtK(ids: readonly string[], grades: ReadonlyMap<string, number>, k: number): number {
  let dcg = 0;
  const top = ids.slice(0, k);
  for (let i = 0; i < top.length; i++) {
    const g = grades.get(top[i]) ?? 0;
    if (g !== 0) dcg += g / Math.log2(i + 2);
  }
  return dcg;
}

/** nDCG@k: DCG normalized by the ideal ordering of the graded set. NaN when no positive grades. */
export function ndcgAtK(ids: readonly string[], grades: ReadonlyMap<string, number>, k: number): number {
  const ideal = [...grades.entries()]
    .filter(([, g]) => g > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  if (ideal.length === 0) return NaN;
  const idcg = dcgAtK(ideal, grades, k);
  if (idcg === 0) return NaN;
  return dcgAtK(ids, grades, k) / idcg;
}
