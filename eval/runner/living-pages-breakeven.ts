#!/usr/bin/env bun
/**
 * Living pages (gbrain wave 4b W9) build decision: the break-even read/write ratio
 * and the classification of the owner's mcp_request_log operation counts.
 *
 * Frozen by docs/benchmarks/2026-10-17-living-pages-preregistration.md.
 *
 * Usage:
 *   bun eval/runner/living-pages-breakeven.ts --ops <ops.csv> [--page-days N] [--json out.json]
 *
 * <ops.csv> has a header row with at least `operation` and `ok` (successful calls), as returned by query A
 * of the preregistration. --page-days is query B's single number: distinct (page, day) pairs changed in the
 * same 30-day window. Without it the result is indicative only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { csv } from './living-pages-csv.ts';

export const PRIOR = {
  source: 'gbrain-evals docs/benchmarks/2026-10-05-memory-proof-wave-gbrain-verdicts/c4-pinned-questions/verdict.json, run_3, reads_per_write 1, mean of seeds 42, 7, 1234, reader anthropic:claude-sonnet-5-5',
  anchoredReadUsd: 0.001469,
  anchoredAccuracy: 0.967593,
  refreshedReadUsd: 0.000778,
  refreshedAccuracy: 0.99537,
  cheapestMeasuredRefreshUsd: 0.006023,
  livingRefreshUsd: 0.017,
  reviewMinutesPerProposal: 0.5,
  usdPerReviewMinute: 2,
} as const;

export const READ_OPS = [
  'assemble_evidence', 'context_pack', 'entity', 'get_chunks', 'get_page', 'query', 'recall', 'search',
  'synthesize', 'think', 'volunteer_context',
] as const;

export interface BreakEvenInput {
  refreshUsd: number;
  reviewMinutes: number;
  usdPerMinute: number;
}

export function breakEven(input: BreakEvenInput, prior = PRIOR): number {
  const savingPerRead = prior.anchoredReadUsd * prior.refreshedAccuracy / prior.anchoredAccuracy - prior.refreshedReadUsd;
  if (savingPerRead <= 0) return Number.POSITIVE_INFINITY;
  return (input.refreshUsd + input.reviewMinutes * input.usdPerMinute) / savingPerRead;
}

export const R_STAR_FLOOR = breakEven({ refreshUsd: PRIOR.cheapestMeasuredRefreshUsd, reviewMinutes: 0, usdPerMinute: 0 });
export const R_STAR_PRIOR = breakEven({
  refreshUsd: PRIOR.livingRefreshUsd,
  reviewMinutes: PRIOR.reviewMinutesPerProposal,
  usdPerMinute: PRIOR.usdPerReviewMinute,
});

export type Outcome = 'build_w9' | 'cheaper_designs_win' | 'indicative_only';

export interface Decision {
  reads: number;
  page_days: number | null;
  r_obs: number | null;
  r_star_floor: number;
  r_star_prior: number;
  outcome: Outcome;
  below_floor: boolean | null;
  w10: 'built_after_w9' | 'dropped_with_w9' | 'pending';
  unknown_operations: string[];
}

export function decide(rows: { operation: string; ok: number }[], pageDays: number | null): Decision {
  const known = new Set<string>(READ_OPS);
  const reads = rows.filter(r => known.has(r.operation)).reduce((s, r) => s + r.ok, 0);
  const r_obs = pageDays && pageDays > 0 ? reads / pageDays : null;
  const outcome: Outcome = r_obs === null ? 'indicative_only' : r_obs >= R_STAR_PRIOR ? 'build_w9' : 'cheaper_designs_win';
  return {
    reads,
    page_days: pageDays,
    r_obs,
    r_star_floor: R_STAR_FLOOR,
    r_star_prior: R_STAR_PRIOR,
    outcome,
    below_floor: r_obs === null ? null : r_obs < R_STAR_FLOOR,
    w10: outcome === 'build_w9' ? 'built_after_w9' : outcome === 'cheaper_designs_win' ? 'dropped_with_w9' : 'pending',
    unknown_operations: rows.map(r => r.operation).filter(op => !known.has(op)).sort(),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const opsPath = opt('--ops');
  if (!opsPath) { console.error('usage: --ops <ops.csv> [--page-days N] [--json out.json]'); process.exit(2); }
  const rows = csv(readFileSync(opsPath, 'utf8'));
  const pageDaysArg = opt('--page-days');
  const decision = decide(rows, pageDaysArg === undefined ? null : Number(pageDaysArg));
  const out = JSON.stringify(decision, null, 2);
  const jsonPath = opt('--json');
  if (jsonPath) writeFileSync(jsonPath, out + '\n');
  console.log(out);
}
