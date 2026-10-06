/**
 * Keyless $0 re-score of a Cat 21 receipt (W5, 2026-10 follow-up round).
 *
 * Reads the per-query ranks a `cat21-code-retrieval.ts --split both` receipt
 * stores, and prints per split and cell: MRR, recall@5 and first-place hits,
 * plus every pairwise embedder comparison as a paired difference clustered by
 * gold file (exact sign-flip test over files, cluster bootstrap interval).
 * Holm's correction runs across the three pairwise comparisons of each split
 * and metric. The primary comparison is MRR on the paraphrase split.
 *
 *   bun eval/runner/cat21-paired.ts <receipt.json>
 */
import { readFileSync } from 'node:fs';
import { clusteredPairedDelta, holmAdjusted, type PairedItem } from './stats/paired.ts';

export const SEED = 20261006;
export const DRAWS = 10_000;
const K = 5;

interface Cell { cell: string; valid: boolean; per_query: Array<{ id: string; rank: number | null }> }
interface QueryMeta { id: string; expected_file: string; split: string }

export function reciprocal(rank: number | null): number { return rank ? 1 / rank : 0; }
export function hitAt5(rank: number | null): number { return rank !== null && rank <= K ? 1 : 0; }

export interface Comparison {
  split: string; metric: 'mrr' | 'recall_at_5'; a: string; b: string;
  mean_a: number; mean_b: number; delta: number; ci95: [number, number] | null;
  p_two_sided: number; p_holm: number; n_pairs: number; n_clusters: number; p_method: string;
}

/** Pair two cells question by question on one split; a query either cell did not score counts 0 for it (errors are results). */
export function pairCells(a: Cell, b: Cell, queries: QueryMeta[], metric: (rank: number | null) => number): PairedItem[] {
  const rank = (c: Cell) => new Map(c.per_query.map(p => [p.id, p.rank]));
  const ra = rank(a), rb = rank(b);
  return queries.map(q => ({ id: q.id, cluster: q.expected_file, a: metric(ra.get(q.id) ?? null), b: metric(rb.get(q.id) ?? null) }));
}

export function rescore(receipt: { data: { cells: Cell[] }; resolved_config: { queries: QueryMeta[] } }): { cells: unknown[]; comparisons: Comparison[] } {
  const { cells } = receipt.data;
  const queries = receipt.resolved_config.queries;
  const splits = [...new Set(queries.map(q => q.split))];
  const cellRows = cells.map(c => ({
    cell: c.cell, valid: c.valid,
    splits: Object.fromEntries(splits.map(s => {
      const qs = queries.filter(q => q.split === s);
      const ranks = new Map(c.per_query.map(p => [p.id, p.rank]));
      const rr = qs.map(q => reciprocal(ranks.get(q.id) ?? null));
      return [s, { queries: qs.length, mrr: rr.reduce((x, y) => x + y, 0) / qs.length,
        recall_at_5: qs.filter(q => hitAt5(ranks.get(q.id) ?? null)).length / qs.length,
        top1: qs.filter(q => ranks.get(q.id) === 1).length }];
    })),
  }));
  const comparisons: Comparison[] = [];
  for (const split of splits) {
    const qs = queries.filter(q => q.split === split);
    for (const [metric, fn] of [['mrr', reciprocal], ['recall_at_5', hitAt5]] as const) {
      const group: Omit<Comparison, 'p_holm'>[] = [];
      for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
        const d = clusteredPairedDelta(pairCells(cells[i]!, cells[j]!, qs, fn), { seed: SEED, draws: DRAWS });
        group.push({ split, metric, a: cells[i]!.cell, b: cells[j]!.cell, mean_a: d.mean_a, mean_b: d.mean_b, delta: d.delta, ci95: d.ci95,
          p_two_sided: d.p_two_sided, n_pairs: d.n_pairs, n_clusters: d.n_clusters, p_method: d.p_method });
      }
      const holm = holmAdjusted(group.map(g => g.p_two_sided));
      group.forEach((g, k) => comparisons.push({ ...g, p_holm: holm[k]! }));
    }
  }
  return { cells: cellRows, comparisons };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) { console.error('usage: bun eval/runner/cat21-paired.ts <receipt.json>'); process.exit(2); }
  console.log(JSON.stringify(rescore(JSON.parse(readFileSync(path, 'utf8'))), null, 2));
}
