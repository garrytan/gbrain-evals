/**
 * The preregistered analysis for pinned questions
 * (docs/benchmarks/2026-11-24-pinned-questions-preregistration.md, "Metric and denominator" and "Decision rule"):
 * intervals by cluster bootstrap over questions (10,000 draws), exact McNemar tests on paired outcomes, Holm's
 * correction within a family, and the paired difference behind particle-1's non-inferiority call. Pure functions with
 * a seeded generator, so a receipt's numbers recompute exactly from its rows.
 */

export const BOOTSTRAP_DRAWS = 10_000;
export const NON_INFERIORITY_MARGIN = -0.1;

/** mulberry32: a small seeded generator, so the same rows always give the same interval. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quantile = (sorted: readonly number[], q: number) => {
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};

/**
 * Percentile 95% interval of `stat` by resampling whole clusters (questions) with replacement. Draws where the
 * statistic is undefined (an empty denominator) are skipped; null when no cluster or no defined draw.
 */
export function clusterBootstrap<T>(clusters: ReadonlyArray<readonly T[]>, stat: (rows: readonly T[]) => number | null, draws = BOOTSTRAP_DRAWS, seed = 1): [number, number] | null {
  return clusterBootstrapAll(clusters, rows => [stat(rows)], draws, seed)[0] ?? null;
}

/** clusterBootstrap for several statistics read off the same resamples. */
export function clusterBootstrapAll<T>(clusters: ReadonlyArray<readonly T[]>, stats: (rows: readonly T[]) => Array<number | null>, draws = BOOTSTRAP_DRAWS, seed = 1): Array<[number, number] | null> {
  const width = stats([]).length;
  if (!clusters.length) return Array.from({ length: width }, () => null);
  const next = rng(seed);
  const values: number[][] = Array.from({ length: width }, () => []);
  for (let d = 0; d < draws; d++) {
    const rows: T[] = [];
    for (let i = 0; i < clusters.length; i++) rows.push(...clusters[Math.floor(next() * clusters.length)]!);
    stats(rows).forEach((v, j) => { if (v !== null) values[j]!.push(v); });
  }
  return values.map(vs => { if (!vs.length) return null; vs.sort((x, y) => x - y); return [quantile(vs, 0.025), quantile(vs, 0.975)] as [number, number]; });
}

/** Group rows into clusters by key, in first-seen order. */
export function clustersBy<T>(rows: readonly T[], key: (r: T) => string): T[][] {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); const g = m.get(k); if (g) g.push(r); else m.set(k, [r]); }
  return [...m.values()];
}

/** Exact two-sided McNemar p-value from the discordant counts: b pairs where only the first is true, c where only the second is. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let logC = 0, tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

/** Holm step-down adjusted p-values, in the input order. */
export function holm(ps: readonly number[]): number[] {
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const out = new Array<number>(ps.length);
  let running = 0;
  order.forEach(({ p, i }, rank) => { running = Math.max(running, Math.min(1, (ps.length - rank) * p)); out[i] = running; });
  return out;
}

export interface PairedComparison {
  pairs: number;
  /** Pairs where only the reference (a) is true, and where only the comparison (b) is. */
  only_a: number; only_b: number;
  rate_a: number | null; rate_b: number | null;
  /** b minus a. */
  difference: number | null;
  difference_ci: [number, number] | null;
  mcnemar_p: number;
}

/** A paired comparison of two binary outcomes, one pair per cluster (question): the difference, its bootstrap interval over pairs, and McNemar's exact p. */
export function pairedComparison(pairs: ReadonlyArray<{ a: boolean; b: boolean }>, draws = BOOTSTRAP_DRAWS, seed = 1): PairedComparison {
  const only_a = pairs.filter(p => p.a && !p.b).length, only_b = pairs.filter(p => !p.a && p.b).length;
  const diff = (rows: ReadonlyArray<{ a: boolean; b: boolean }>) => (rows.length ? rows.reduce((s, p) => s + Number(p.b) - Number(p.a), 0) / rows.length : null);
  return {
    pairs: pairs.length, only_a, only_b,
    rate_a: pairs.length ? pairs.filter(p => p.a).length / pairs.length : null,
    rate_b: pairs.length ? pairs.filter(p => p.b).length / pairs.length : null,
    difference: diff(pairs),
    difference_ci: clusterBootstrap(pairs.map(p => [p]), diff, draws, seed),
    mcnemar_p: mcnemarExact(only_a, only_b),
  };
}

/**
 * A family of comparisons against one reference, Holm-corrected at 0.05, each with the non-inferiority call: the
 * lower bound of the paired 95% interval of (comparison minus reference) above NON_INFERIORITY_MARGIN.
 */
export function comparisonFamily(comparisons: Record<string, PairedComparison>, alpha = 0.05): Record<string, PairedComparison & { holm_p: number; significant: boolean; non_inferior: boolean | null }> {
  const names = Object.keys(comparisons);
  const adjusted = holm(names.map(n => comparisons[n]!.mcnemar_p));
  return Object.fromEntries(names.map((n, i) => {
    const c = comparisons[n]!;
    return [n, { ...c, holm_p: adjusted[i]!, significant: adjusted[i]! < alpha, non_inferior: c.difference_ci ? c.difference_ci[0] > NON_INFERIORITY_MARGIN : null }];
  }));
}
