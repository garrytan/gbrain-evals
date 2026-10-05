/**
 * Paired non-inferiority statistics for a small number of clusters.
 *
 * Input: one row per cluster (a conversation, persona or user) carrying the
 * number of paired questions `n` and the sum of their paired differences
 * `sum` (gbrain minus comparator, in points), plus a stratum (a BEAM size
 * such as 500k or 1m). The estimand is the question-weighted mean paired
 * difference over all clusters, which equals the stratum means weighted by
 * question share. Variance uses the stratified CR1 cluster-robust form:
 *
 *   var = sum_s w_s^2 * G_s/(G_s - 1) * sum_c e_c^2 / N_s^2,  e_c = sum_c - n_c * mean_s
 *
 * Every lower bound is one-sided at level alpha. Methods:
 *   - analytic:    theta - t(1 - alpha, G - S) * se
 *   - percentile:  alpha quantile of the stratified cluster bootstrap
 *   - boot-t:      stratified cluster bootstrap of the studentized statistic
 *   - wild-u:      unrestricted wild cluster bootstrap-t (Rademacher or Webb weights)
 *   - wild-r:      restricted wild cluster bootstrap-t test of H0: theta = theta0
 *                  (the null imposed when generating bootstrap samples); a bound comes
 *                  from inverting the test
 *
 * The first four are location-equivariant: adding a constant to every
 * difference shifts the bound by that constant when the bootstrap draws are
 * the same. The power simulation relies on that.
 */
import { seededRandom } from '../stats/paired.ts';

export interface ClusterRow { id: string; stratum: string; n: number; sum: number }
export type WildWeights = 'rademacher' | 'webb';
export type Method = 'analytic' | 'percentile' | 'boot-t' | 'wild-u-rademacher' | 'wild-u-webb' | 'wild-r-rademacher' | 'wild-r-webb';
export const BOUND_METHODS = ['analytic', 'percentile', 'boot-t', 'wild-u-rademacher', 'wild-u-webb'] as const;
export type BoundMethod = typeof BOUND_METHODS[number];

interface Stratum { n: Float64Array; sum: Float64Array; N: number; G: number }
export interface Prepared { strata: Stratum[]; N: number; G: number }

export function prepare(rows: readonly ClusterRow[]): Prepared {
  const by = new Map<string, ClusterRow[]>();
  for (const r of rows) {
    if (!(r.n > 0)) throw new Error(`cluster ${r.id} has no questions`);
    by.set(r.stratum, [...(by.get(r.stratum) ?? []), r]);
  }
  const strata = [...by.keys()].sort().map(k => {
    const rs = by.get(k)!;
    if (rs.length < 2) throw new Error(`stratum ${k} needs at least two clusters`);
    return { n: Float64Array.from(rs.map(r => r.n)), sum: Float64Array.from(rs.map(r => r.sum)), N: rs.reduce((s, r) => s + r.n, 0), G: rs.length };
  });
  return { strata, N: strata.reduce((s, x) => s + x.N, 0), G: rows.length };
}

/** Point estimate and stratified CR1 standard error from per-stratum cluster sums. */
export function estimateFrom(strata: readonly Stratum[], sums: readonly Float64Array[], N: number): { theta: number; se: number } {
  let total = 0, v = 0;
  for (let s = 0; s < strata.length; s++) {
    const st = strata[s], y = sums[s];
    let S = 0;
    for (let c = 0; c < st.G; c++) S += y[c];
    total += S;
    const mean = S / st.N;
    let ee = 0;
    for (let c = 0; c < st.G; c++) { const e = y[c] - st.n[c] * mean; ee += e * e; }
    v += (st.G / (st.G - 1)) * ee / (N * N);
  }
  return { theta: total / N, se: Math.sqrt(v) };
}

export function estimate(p: Prepared): { theta: number; se: number } {
  return estimateFrom(p.strata, p.strata.map(s => s.sum), p.N);
}

// ─── Student t quantile (regularized incomplete beta) ───────────────

function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const cj of c) ser += cj / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betaContinuedFraction(a, b, x) / a : 1 - bt * betaContinuedFraction(b, a, 1 - x) / b;
}

export function studentTCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const tail = 0.5 * regularizedBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

export function studentTQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1) || !(df > 0)) throw new Error('studentTQuantile needs 0 < p < 1 and df > 0');
  let lo = -1e3, hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ─── Bootstrap machinery ────────────────────────────────────────────

const SQRT_HALF = Math.SQRT1_2, SQRT_3_2 = Math.sqrt(1.5);
const WEBB = [-SQRT_3_2, -1, -SQRT_HALF, SQRT_HALF, 1, SQRT_3_2];

export function wildWeight(kind: WildWeights, rng: () => number): number {
  if (kind === 'rademacher') return rng() < 0.5 ? -1 : 1;
  return WEBB[Math.floor(rng() * 6)];
}

/** Order statistic used for bootstrap quantiles: the ceil((B + 1) * q)-th smallest of B draws. */
export function bootQuantile(sorted: Float64Array, q: number): number {
  const k = Math.min(sorted.length, Math.max(1, Math.ceil((sorted.length + 1) * q)));
  return sorted[k - 1];
}

export interface BoundOptions { alpha: number; draws: number; seed: number }

/** Lower one-sided bounds from every equivariant method, sharing one prepared sample. */
export function lowerBounds(p: Prepared, o: BoundOptions, methods: readonly BoundMethod[] = BOUND_METHODS): Record<BoundMethod, number> & { theta: number; se: number } {
  const { theta, se } = estimate(p);
  const out = { theta, se } as Record<BoundMethod, number> & { theta: number; se: number };
  const rng = seededRandom(o.seed);
  const S = p.strata.length;
  const means = p.strata.map(s => { let t = 0; for (let c = 0; c < s.G; c++) t += s.sum[c]; return t / s.N; });
  const resid = p.strata.map((s, k) => Float64Array.from(s.sum, (y, c) => y - s.n[c] * means[k]));
  if (methods.includes('analytic')) out.analytic = theta - studentTQuantile(1 - o.alpha, p.G - S) * se;
  if (methods.includes('percentile') || methods.includes('boot-t')) {
    const thetas = new Float64Array(o.draws), ts = new Float64Array(o.draws);
    const bs = p.strata.map(s => ({ n: new Float64Array(s.G), sum: new Float64Array(s.G), N: 0, G: s.G }));
    for (let b = 0; b < o.draws; b++) {
      let Nb = 0;
      for (let s = 0; s < S; s++) {
        const st = p.strata[s], dst = bs[s];
        let N = 0;
        for (let c = 0; c < st.G; c++) { const k = Math.floor(rng() * st.G); dst.n[c] = st.n[k]; dst.sum[c] = st.sum[k]; N += st.n[k]; }
        dst.N = N; Nb += N;
      }
      const e = estimateFrom(bs, bs.map(x => x.sum), Nb);
      thetas[b] = e.theta;
      ts[b] = e.se > 0 ? (e.theta - theta) / e.se : e.theta > theta ? Infinity : e.theta < theta ? -Infinity : 0;
    }
    thetas.sort(); ts.sort();
    if (methods.includes('percentile')) out.percentile = bootQuantile(thetas, o.alpha);
    if (methods.includes('boot-t')) out['boot-t'] = theta - bootQuantile(ts, 1 - o.alpha) * se;
  }
  for (const kind of ['rademacher', 'webb'] as const) {
    const m = `wild-u-${kind}` as BoundMethod;
    if (!methods.includes(m)) continue;
    const ts = new Float64Array(o.draws);
    const sums = p.strata.map(s => new Float64Array(s.G));
    for (let b = 0; b < o.draws; b++) {
      for (let s = 0; s < S; s++) {
        const st = p.strata[s];
        for (let c = 0; c < st.G; c++) sums[s][c] = st.n[c] * means[s] + wildWeight(kind, rng) * resid[s][c];
      }
      const e = estimateFrom(p.strata, sums, p.N);
      ts[b] = e.se > 0 ? (e.theta - theta) / e.se : 0;
    }
    ts.sort();
    out[m] = theta - bootQuantile(ts, 1 - o.alpha) * se;
  }
  return out;
}

/**
 * Restricted wild cluster bootstrap-t p-values for H0: theta = theta0 against
 * theta > theta0, for several theta0 at once (shared weights). Imposing the
 * null shifts every stratum mean by the same amount, the restricted
 * least-squares solution under question weighting.
 */
export function wildRestrictedP(p: Prepared, theta0s: readonly number[], o: { draws: number; seed: number; weights: WildWeights }): number[] {
  const { theta, se } = estimate(p);
  const rng = seededRandom(o.seed);
  const S = p.strata.length;
  const means = p.strata.map(s => { let t = 0; for (let c = 0; c < s.G; c++) t += s.sum[c]; return t / s.N; });
  const tObs = theta0s.map(t0 => (se > 0 ? (theta - t0) / se : theta > t0 ? Infinity : 0));
  const exceed = new Float64Array(theta0s.length);
  const v = p.strata.map(s => new Float64Array(s.G));
  const sums = p.strata.map(s => new Float64Array(s.G));
  for (let b = 0; b < o.draws; b++) {
    for (let s = 0; s < S; s++) for (let c = 0; c < p.strata[s].G; c++) v[s][c] = wildWeight(o.weights, rng);
    for (let j = 0; j < theta0s.length; j++) {
      const shift = theta - theta0s[j];
      for (let s = 0; s < S; s++) {
        const st = p.strata[s], mu = means[s] - shift;
        for (let c = 0; c < st.G; c++) sums[s][c] = st.n[c] * mu + v[s][c] * (st.sum[c] - st.n[c] * mu);
      }
      const e = estimateFrom(p.strata, sums, p.N);
      const t = e.se > 0 ? (e.theta - theta0s[j]) / e.se : 0;
      if (t >= tObs[j]) exceed[j]++;
    }
  }
  return [...exceed].map(k => (1 + k) / (o.draws + 1));
}

/** Lower bound by inverting the restricted wild test: the smallest theta0 the test does not reject, by bisection. */
export function wildRestrictedLowerBound(p: Prepared, o: BoundOptions & { weights: WildWeights }): number {
  const { theta, se } = estimate(p);
  const reject = (t0: number) => wildRestrictedP(p, [t0], o)[0] <= o.alpha;
  let lo = theta - 10 * se - 1, hi = theta;
  if (!reject(lo)) return lo;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (reject(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

// ─── Decision ───────────────────────────────────────────────────────

export type Outcome = 'ahead' | 'non-inferior' | 'behind' | 'inconclusive';

/**
 * Map one-sided bounds to the preregistered outcomes. `lower` and `upper`
 * are one-sided (1 - alpha) bounds of gbrain minus comparator in points;
 * `margin` is positive (2.0 means -2.0 points). There is no "tied".
 *   ahead          lower > 0
 *   non-inferior   -margin < lower <= 0 (reported with the upper bound, which
 *                  may itself be below 0: non-inferior but measurably lower)
 *   behind         lower <= -margin and upper < 0 (measurably lower, and the
 *                  data cannot rule out a loss larger than the margin)
 *   inconclusive   lower <= -margin and upper >= 0
 */
export function decide(lower: number, upper: number, margin: number): Outcome {
  if (!(margin > 0)) throw new Error('margin must be positive');
  if (!(lower <= upper)) throw new Error('lower bound above upper bound');
  if (lower > 0) return 'ahead';
  if (lower > -margin) return 'non-inferior';
  if (upper < 0) return 'behind';
  return 'inconclusive';
}
