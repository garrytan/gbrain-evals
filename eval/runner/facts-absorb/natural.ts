/**
 * Natural-prose stratum of the facts-absorb gate: which planted items of the
 * Cat 35 transcripts the stored facts cover, as judged by the Cat 35 coverage
 * judge (FULL, PARTIAL or ABSENT per item). A harm check, not a
 * non-inferiority test: 125 items in 20 transcripts cannot resolve a 5-point
 * margin, so the preregistered rule only blocks a candidate that loses more
 * than 10 points of covered items against the baseline.
 */
import { Rng } from '../../generators/seeded.ts';

export interface NaturalPage { page: string; items: number; full: number; partial: number; judge_failed: number; facts: number; verdicts: Array<{ item_id: string; status: string }> }

export const NATURAL_HARM_MARGIN = 0.10;
/** Above this share of items without a judge verdict, the check is inconclusive and fails. */
export const NATURAL_MAX_JUDGE_FAILED = 0.05;

export function naturalTotals(pages: readonly NaturalPage[]) {
  const items = pages.reduce((a, p) => a + p.items, 0);
  const full = pages.reduce((a, p) => a + p.full, 0);
  const partial = pages.reduce((a, p) => a + p.partial, 0);
  const failed = pages.reduce((a, p) => a + p.judge_failed, 0);
  return { items, full, partial, judge_failed: failed, covered: items ? (full + partial) / items : 0, full_rate: items ? full / items : 0, judge_failed_rate: items ? failed / items : 0 };
}

export function pairedNatural(base: readonly NaturalPage[], cand: readonly NaturalPage[], reps = 4000, seed = 3) {
  const byPage = new Map(cand.map(p => [p.page, p]));
  const pairs = base.flatMap(b => (byPage.has(b.page) ? [[b, byPage.get(b.page)!] as const] : []));
  const diffOf = (ps: ReadonlyArray<readonly [NaturalPage, NaturalPage]>) => naturalTotals(ps.map(p => p[1])).covered - naturalTotals(ps.map(p => p[0])).covered;
  const diff = diffOf(pairs);
  const rng = new Rng(seed);
  const ds: number[] = [];
  for (let r = 0; r < reps && pairs.length; r++) ds.push(diffOf(pairs.map(() => pairs[rng.int(0, pairs.length - 1)])));
  ds.sort((a, b) => a - b);
  const lo = ds[Math.floor(0.025 * ds.length)] ?? 0;
  const hi = ds[Math.ceil(0.975 * ds.length) - 1] ?? 0;
  const failed = Math.max(naturalTotals(base).judge_failed_rate, naturalTotals(cand).judge_failed_rate);
  const pass = diff >= -NATURAL_HARM_MARGIN && failed <= NATURAL_MAX_JUDGE_FAILED;
  const pts = (x: number) => `${(x * 100).toFixed(1)} pts`;
  return { diff, lo, hi, pass, detail: `covered items ${pts(diff)} [${pts(lo)}, ${pts(hi)}] vs harm margin -${pts(NATURAL_HARM_MARGIN)}; judge-failed share ${pts(failed)}` };
}
