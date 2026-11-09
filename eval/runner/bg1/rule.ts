/**
 * BG1's one decision rule (preregistration docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md,
 * "Decision rule"; review finding F6). power.ts sizes the design with it and verdict.ts decides with it, so the words a
 * result gets and the MDD it was sized for come from the same alpha, Holm step and t distribution.
 *
 *   For each comparison, d_i is gbrain minus the comparator on world i, in points (0 to 100), and the test is a paired t
 *   on the mean of the d_i with n - 1 degrees of freedom.
 *     ahead                     the one-sided p for H0 "mean <= 0", Holm-adjusted across the family, is at most 0.05
 *     behind                    the mirror test, H0 "mean >= 0", also Holm-adjusted, is at most 0.05
 *     no measurable difference  otherwise
 *   "Ahead by more than 5 points" (or behind by more than 5) needs the simultaneous one-sided Bonferroni bound at
 *   alpha / m (m comparisons in the family) beyond 5 in that direction; it is reported, never required.
 *   Every comparison also carries its unadjusted two-sided 95% interval.
 *
 * The primary family is gbrain against BG1_COMPARATORS on the primary strata. The secondary families (time-indexed
 * strata, the design control against hybrid search) use the same function over their own comparisons.
 */
import { holmAdjusted } from '../stats/paired.ts';
import { tCdf, tQuantile } from '../power/risk-ratio.ts';

export const BG1_ALPHA = 0.05;
export const BG1_MARGIN_POINTS = 5;
export const BG1_TARGET_POWER = 0.8;
/** The three comparators of the primary family, in report order. */
export const BG1_COMPARATORS = ['ext-memory-bank', 'ext-extract-first', 'ext-temporal-graph'] as const;
/** The strictest Holm step of the primary family, which the design is sized at. */
export const BG1_STRICT_ALPHA = BG1_ALPHA / BG1_COMPARATORS.length;

export type VerdictWord = 'ahead' | 'behind' | 'no measurable difference';

export interface PairedT {
  n: number; mean: number; sd: number; se: number; df: number; t: number;
  /** One-sided p for H0 "mean <= 0" (evidence gbrain is ahead) and for H0 "mean >= 0" (evidence it is behind). */
  p_ahead: number; p_behind: number;
  /** Unadjusted two-sided 95% interval of the mean difference. */
  ci95: [number, number];
}

export function pairedT(diffs: readonly number[]): PairedT {
  const n = diffs.length;
  if (n < 2 || !diffs.every(Number.isFinite)) throw new Error(`a paired t needs at least two finite per-world differences, got ${n}`);
  const mean = diffs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n), df = n - 1;
  if (se === 0) {
    const t = mean === 0 ? 0 : mean > 0 ? Infinity : -Infinity;
    return { n, mean, sd, se, df, t, p_ahead: mean > 0 ? 0 : 1, p_behind: mean < 0 ? 0 : 1, ci95: [mean, mean] };
  }
  const t = mean / se, half = tQuantile(0.975, df) * se;
  return { n, mean, sd, se, df, t, p_ahead: 1 - tCdf(t, df), p_behind: tCdf(t, df), ci95: [mean - half, mean + half] };
}

export interface ComparisonVerdict extends PairedT {
  comparison: string;
  p_ahead_holm: number; p_behind_holm: number;
  verdict: VerdictWord;
  /** The simultaneous one-sided Bonferroni bounds at alpha / m: lower (for ahead) and upper (for behind). */
  bonferroni: { alpha: number; lower: number; upper: number };
  /** Ahead (or behind) and the Bonferroni bound beyond the margin in that direction. */
  beyond_margin: boolean;
}

/** The verdict words for one family: each comparison's per-world differences, Holm across the family's comparisons. */
export function decideFamily(family: Readonly<Record<string, readonly number[]>>, alpha = BG1_ALPHA, margin = BG1_MARGIN_POINTS): ComparisonVerdict[] {
  const keys = Object.keys(family);
  if (!keys.length) throw new Error('a family needs at least one comparison');
  const tests = keys.map(k => pairedT(family[k]));
  const ahead = holmAdjusted(tests.map(t => t.p_ahead)), behind = holmAdjusted(tests.map(t => t.p_behind));
  const bAlpha = alpha / keys.length;
  return tests.map((t, i) => {
    const q = t.se === 0 ? 0 : tQuantile(1 - bAlpha, t.df) * t.se;
    const verdict: VerdictWord = ahead[i] <= alpha ? 'ahead' : behind[i] <= alpha ? 'behind' : 'no measurable difference';
    const lower = t.mean - q, upper = t.mean + q;
    return { comparison: keys[i], ...t, p_ahead_holm: ahead[i], p_behind_holm: behind[i], verdict, bonferroni: { alpha: bAlpha, lower, upper },
      beyond_margin: (verdict === 'ahead' && lower > margin) || (verdict === 'behind' && upper < -margin) };
  });
}

/** The minimum detectable difference of a one-sided paired t at alpha with the given power: (t(1 - alpha) + t(power)) x sd / sqrt(n). */
export function mdd(sd: number, n: number, alpha: number, power = BG1_TARGET_POWER): number {
  if (!(n >= 2)) throw new Error('an MDD needs n >= 2');
  return (tQuantile(1 - alpha, n - 1) + tQuantile(power, n - 1)) * sd / Math.sqrt(n);
}

/** The smallest n (at least 2) whose MDD at alpha is at most the margin; Infinity when none up to 2,000 is. */
export function nRequired(sd: number, margin = BG1_MARGIN_POINTS, alpha = BG1_STRICT_ALPHA, power = BG1_TARGET_POWER): number {
  for (let n = 2; n <= 2000; n++) if (mdd(sd, n, alpha, power) <= margin) return n;
  return Infinity;
}
