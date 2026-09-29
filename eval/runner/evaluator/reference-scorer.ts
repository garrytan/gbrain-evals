/**
 * Evaluator-side reference scorer (plan amendment 6).
 *
 * Written from the metric definitions, with no import from the product or
 * from `eval/runner/metrics.ts`, so a scoring bug has to be made twice to go
 * unnoticed. Tests hold it to the runners' historical scorers on known
 * rankings and on random inputs.
 *
 * Two duplicate-handling protocols exist, and each runner names its own:
 *   - `collapse`  (LongMemEval sessions): ids are lowercased and repeated ids
 *     collapse to their first occurrence before the top-k cut. Several chunks
 *     from one session are one retrieved session.
 *   - `occupy`    (Cat13 pages): a repeated id keeps its rank slot and earns
 *     nothing, so returning duplicates can only lower the score.
 * Either way the count of repeats is reported so a broken adapter shows up.
 */

export const REFERENCE_SCORER_VERSION = 'reference-scorer@1';

export interface SessionRecallScore {
  /** 1 when every gold session is in the top k; NaN without gold. */
  recall_all: number;
  /** 1 when any gold session is in the top k; NaN without gold. */
  recall_any: number;
  /** Binary-gain nDCG@k over gold sessions; NaN without gold. */
  ndcg_any: number;
  /** Share of the k slots holding gold sessions. */
  abs_noise: number;
  /** Returned ids that repeated an earlier id (after lowercasing). */
  duplicates: number;
  returned: number;
}

function firstOccurrences(ids: readonly string[]): { unique: string[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return { unique, duplicates: ids.length - unique.length };
}

const discount = (rank: number) => 1 / Math.log2(rank + 1);

export function scoreSessionRecall(retrieved: readonly string[], gold: readonly string[], k: number): SessionRecallScore {
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer');
  const { unique, duplicates } = firstOccurrences(retrieved.map(id => id.toLowerCase()));
  const goldSet = new Set(gold.map(id => id.toLowerCase()));
  const top = unique.slice(0, k);
  const hits = top.filter(id => goldSet.has(id)).length;
  let dcg = 0;
  top.forEach((id, i) => { if (goldSet.has(id)) dcg += discount(i + 1); });
  let idcg = 0;
  for (let i = 1; i <= Math.min(k, goldSet.size); i++) idcg += discount(i);
  const none = goldSet.size === 0;
  return {
    recall_all: none ? NaN : [...goldSet].every(id => top.includes(id)) ? 1 : 0,
    recall_any: none ? NaN : hits > 0 ? 1 : 0,
    ndcg_any: none ? NaN : dcg / idcg,
    abs_noise: hits / k,
    duplicates,
    returned: retrieved.length,
  };
}

export interface GradedRankingScore {
  /** Graded nDCG@k; NaN when no id has a positive grade. */
  ndcg: number;
  /** Distinct ids with grade >= 1 in the top k, divided by k. */
  precision: number;
  /** 1 when the first returned id is a strict target. */
  top1_strict: number;
  duplicates: number;
  returned: number;
}

export function scoreGradedRanking(ranked: readonly string[], grades: Readonly<Record<string, number>>, targets: readonly string[], k: number): GradedRankingScore {
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer');
  const gain = (id: string) => Object.prototype.hasOwnProperty.call(grades, id) ? grades[id] : 0;
  const seen = new Set<string>();
  let dcg = 0, relevant = 0;
  ranked.slice(0, k).forEach((id, i) => {
    if (seen.has(id)) return;
    seen.add(id);
    const g = gain(id);
    dcg += g * discount(i + 1);
    if (g >= 1) relevant++;
  });
  const ideal = Object.values(grades).filter(g => g > 0).sort((x, y) => y - x).slice(0, k);
  const idcg = ideal.reduce((s, g, i) => s + g * discount(i + 1), 0);
  return {
    ndcg: idcg > 0 ? dcg / idcg : NaN,
    precision: relevant / k,
    top1_strict: ranked.length > 0 && targets.includes(ranked[0]) ? 1 : 0,
    duplicates: ranked.length - new Set(ranked).size,
    returned: ranked.length,
  };
}
