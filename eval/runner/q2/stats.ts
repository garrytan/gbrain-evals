/**
 * Small statistics for the Q2 gates: Wilson score intervals (two-sided 95%), the per-100,000 junk bound, and a
 * cluster bootstrap of a proportion. Bootstrap intervals elsewhere use stats/paired.ts.
 */
import { seededRandom } from '../stats/paired.ts';

export const Z95 = 1.959963984540054;

/** Wilson score interval for k successes in n trials; [0, 1] when n is 0. */
export function wilson(k: number, n: number, z = Z95): { lower: number; upper: number; point: number | null } {
  if (n <= 0) return { lower: 0, upper: 1, point: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half), point: p };
}

/** G1: the Wilson upper bound of wrong mints, expressed per 100,000 list lines. */
export function wilsonUpperPer100k(wrong: number, listLines: number): number {
  return wilson(wrong, listLines).upper * 100_000;
}

/** Percentile bootstrap of a pooled proportion, resampling whole clusters (brains, pages) with replacement. */
export function clusterBootstrapProportion(clusters: ReadonlyArray<{ k: number; n: number }>, o: { seed: number; draws: number }): { point: number | null; ci95: [number, number] | null } {
  const used = clusters.filter(c => c.n > 0);
  const n = used.reduce((a, c) => a + c.n, 0);
  if (!n) return { point: null, ci95: null };
  const point = used.reduce((a, c) => a + c.k, 0) / n;
  if (used.length < 2) return { point, ci95: null };
  const rnd = seededRandom(o.seed);
  const draws: number[] = [];
  for (let d = 0; d < o.draws; d++) {
    let k = 0, m = 0;
    for (let i = 0; i < used.length; i++) { const c = used[Math.floor(rnd() * used.length)]; k += c.k; m += c.n; }
    draws.push(k / m);
  }
  draws.sort((a, b) => a - b);
  return { point, ci95: [draws[Math.floor(o.draws * 0.025)], draws[Math.ceil(o.draws * 0.975) - 1]] };
}
