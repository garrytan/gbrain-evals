/**
 * gate-proto.ts — PURE prototype of the adaptive return-sizing gate.
 *
 * This is the A5 instrumentation + the portable basis for the Phase-2 gbrain
 * core feature. It operates on the ordering-driving score of the candidate
 * set (post-rerank that is `rerank_score`; otherwise `score`) and decides how
 * many results to return:
 *
 *   - topk    : return everything (current gbrain behavior — the baseline)
 *   - fixed:N : return the top N (crude; for the sweep)
 *   - cliff   : cut at the largest relative score gap, but only if that gap
 *               exceeds `minGapRatio` (a flat distribution = no cliff = no
 *               trim, per decision A1); never return fewer than `minKeep`
 *               (the at-least-1 failsafe, A4).
 *
 * Kept dependency-free so it can be lifted into gbrain core (hybrid.ts) in
 * Phase 2 and unit-tested in isolation.
 */

export interface Scored {
  id: string;
  score: number;
}

export type ReturnPolicy =
  | { kind: 'topk' }
  | { kind: 'fixed'; n: number }
  | { kind: 'cliff'; minKeep: number; minGapRatio: number; maxKeep?: number };

export interface CliffDecision {
  kept: number;
  total: number;
  cutGapRatio: number; // the relative gap at the chosen cut (0 if no cut)
  cliffFound: boolean;
}

/**
 * Apply a return policy to a score-descending candidate list. Returns the kept
 * prefix plus a decision record (for the gate-decision observability field).
 * `sorted` MUST be sorted by the ordering-driving score, descending.
 */
export function applyReturnPolicy(
  sorted: Scored[],
  policy: ReturnPolicy,
): { kept: Scored[]; decision: CliffDecision } {
  const total = sorted.length;
  if (policy.kind === 'topk' || total === 0) {
    return { kept: sorted, decision: { kept: total, total, cutGapRatio: 0, cliffFound: false } };
  }
  if (policy.kind === 'fixed') {
    const k = Math.min(policy.n, total);
    return { kept: sorted.slice(0, k), decision: { kept: k, total, cutGapRatio: 0, cliffFound: false } };
  }

  // cliff
  const minKeep = Math.max(1, policy.minKeep);
  const maxKeep = policy.maxKeep ?? total;
  if (total <= minKeep) {
    return { kept: sorted, decision: { kept: total, total, cutGapRatio: 0, cliffFound: false } };
  }
  const top = sorted[0].score || 1e-9;
  let bestGap = -1;
  let cutAt = total; // default: keep all (no cliff)
  // Consider cut points from minKeep..min(maxKeep,total-1). A "cut at i" keeps
  // the first i items; the gap is between item i-1 and item i.
  const hi = Math.min(maxKeep, total - 1);
  for (let i = minKeep; i <= hi; i++) {
    const gap = (sorted[i - 1].score - sorted[i].score) / top;
    if (gap > bestGap) {
      bestGap = gap;
      cutAt = i;
    }
  }
  const cliffFound = bestGap >= policy.minGapRatio;
  const kept = cliffFound ? sorted.slice(0, cutAt) : sorted.slice(0, Math.min(maxKeep, total));
  return {
    kept,
    decision: {
      kept: kept.length,
      total,
      cutGapRatio: cliffFound ? Number(bestGap.toFixed(4)) : 0,
      cliffFound,
    },
  };
}
