/**
 * Exact (Clopper-Pearson) binomial confidence bounds, two-sided at level
 * 1 - alpha (default 95%): lower solves P(X >= x | p) = alpha/2, upper solves
 * P(X <= x | p) = alpha/2, by bisection on the binomial tail.
 */

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** P(X <= x) for X ~ Binomial(n, p). */
export function binomialCdf(x: number, n: number, p: number): number {
  if (x < 0) return 0;
  if (x >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let sum = 0;
  for (let k = 0; k <= x; k++) sum += Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
  return Math.min(1, sum);
}

function bisect(f: (p: number) => number, target: number, increasing: boolean): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const v = f(mid);
    if ((v < target) === increasing) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function clopperPearson(x: number, n: number, alpha = 0.05): { lower: number; upper: number } {
  if (!Number.isInteger(x) || !Number.isInteger(n) || n <= 0 || x < 0 || x > n) throw new Error(`clopperPearson needs integers 0 <= x <= n, n > 0 (got ${x}/${n})`);
  const lower = x === 0 ? 0 : bisect(p => 1 - binomialCdf(x - 1, n, p), alpha / 2, true);
  const upper = x === n ? 1 : bisect(p => binomialCdf(x, n, p), alpha / 2, false);
  return { lower, upper };
}
