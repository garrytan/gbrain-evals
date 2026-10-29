/**
 * Restricted wild cluster bootstrap-t for a paired comparison with few
 * clusters (the scoreboard's ten BEAM-10M conversations).
 *
 * Ported from the memory proof wave's non-inferiority statistics
 * (`eval/runner/memory-proof-wave/ni-stats.ts` on branch
 * `capy/memory-proof-wave`, gbrain-evals#69, GBRA-52), which wrote the
 * stratified CR1 estimator, the Webb six-point weights and the restricted
 * test this file keeps. The port keeps that code's arithmetic and random-draw
 * order, so one-sided p-values match the original exactly on shared inputs
 * (test/eval/wild-cluster.test.ts, fixture
 * test/eval/fixtures/wild-cluster/proof-wave-parity.json). What changed for
 * the scoreboard: the test is two-sided (superiority in either direction, not
 * a one-sided non-inferiority bound), the interval comes from inverting the
 * two-sided test on both sides, and the inner loop reuses buffers so a power
 * simulation can call it many thousands of times.
 *
 * Input: one row per cluster (a conversation) with the number of paired
 * questions `n` and the sum of their paired differences `sum` (first arm
 * minus second, in score units), plus a stratum. The estimand is the
 * question-weighted mean paired difference, which equals the stratum means
 * weighted by question share. Variance is the stratified CR1 form:
 *
 *   var = sum_s G_s/(G_s - 1) * sum_c e_c^2 / N^2,  e_c = sum_c - n_c * mean_s
 *
 * Restricted test of H0: theta = theta0. The null is imposed when generating
 * bootstrap samples (every stratum mean shifts by theta - theta0, the
 * restricted least-squares solution under question weighting); each draw
 * multiplies every cluster's restricted residual by one weight; the bootstrap
 * statistic is studentized by its own CR1 standard error. Two-sided p-values
 * are symmetric: the share of draws with |t*| >= |t_obs|, as (1 + k)/(B + 1).
 *
 * Webb weights take six values (+-sqrt(1/2), +-1, +-sqrt(3/2)) with equal
 * probability, so ten clusters give 6^10 sign patterns instead of
 * Rademacher's 2^10 = 1,024, which keeps p-values near 0.05 from being
 * coarse.
 */
import { seededRandom } from './paired.ts';

export interface ClusterRow { id: string; stratum: string; n: number; sum: number }
export type WildWeights = 'rademacher' | 'webb';
export type Alternative = 'greater' | 'less' | 'two-sided';

interface Stratum { n: Float64Array; sum: Float64Array; N: number; G: number }
export interface Prepared { strata: Stratum[]; N: number; G: number }

export function prepare(rows: readonly ClusterRow[]): Prepared {
  const by = new Map<string, ClusterRow[]>();
  for (const r of rows) {
    if (!(r.n > 0)) throw new Error(`cluster ${r.id} has no questions`);
    if (!Number.isFinite(r.sum)) throw new Error(`cluster ${r.id} has a non-finite sum`);
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

const SQRT_HALF = Math.SQRT1_2, SQRT_3_2 = Math.sqrt(1.5);
const WEBB = [-SQRT_3_2, -1, -SQRT_HALF, SQRT_HALF, 1, SQRT_3_2];

export function wildWeight(kind: WildWeights, rng: () => number): number {
  if (kind === 'rademacher') return rng() < 0.5 ? -1 : 1;
  return WEBB[Math.floor(rng() * 6)];
}

export interface WildOptions { draws: number; seed: number; weights: WildWeights; alternative: Alternative }

/**
 * Restricted wild cluster bootstrap-t p-values for H0: theta = theta0, for
 * several theta0 at once with shared weights. `greater` reproduces the proof
 * wave's one-sided test; `two-sided` is the scoreboard's superiority test.
 */
export function wildRestrictedP(p: Prepared, theta0s: readonly number[], o: WildOptions): number[] {
  if (!Number.isSafeInteger(o.draws) || o.draws < 1) throw new Error('wildRestrictedP needs a positive integer number of draws');
  const { theta, se } = estimate(p);
  const rng = seededRandom(o.seed);
  const S = p.strata.length;
  const means = p.strata.map(s => { let t = 0; for (let c = 0; c < s.G; c++) t += s.sum[c]; return t / s.N; });
  const observed = (t0: number) => {
    if (se > 0) return (theta - t0) / se;
    if (theta === t0) return 0;
    return theta > t0 ? Infinity : -Infinity;
  };
  const tObs = theta0s.map(observed);
  const exceed = new Float64Array(theta0s.length);
  const v = p.strata.map(s => new Float64Array(s.G));
  const y = p.strata.map(s => new Float64Array(s.G));
  for (let b = 0; b < o.draws; b++) {
    for (let s = 0; s < S; s++) for (let c = 0; c < p.strata[s].G; c++) v[s][c] = wildWeight(o.weights, rng);
    for (let j = 0; j < theta0s.length; j++) {
      const shift = theta - theta0s[j];
      let total = 0, variance = 0;
      for (let s = 0; s < S; s++) {
        const st = p.strata[s], mu = means[s] - shift, ys = y[s], vs = v[s];
        let sum = 0;
        for (let c = 0; c < st.G; c++) { ys[c] = st.n[c] * mu + vs[c] * (st.sum[c] - st.n[c] * mu); sum += ys[c]; }
        total += sum;
        const mean = sum / st.N;
        let ee = 0;
        for (let c = 0; c < st.G; c++) { const e = ys[c] - st.n[c] * mean; ee += e * e; }
        variance += (st.G / (st.G - 1)) * ee / (p.N * p.N);
      }
      const seB = Math.sqrt(variance);
      const t = seB > 0 ? (total / p.N - theta0s[j]) / seB : 0;
      const hit = o.alternative === 'greater' ? t >= tObs[j] : o.alternative === 'less' ? t <= tObs[j] : Math.abs(t) >= Math.abs(tObs[j]);
      if (hit) exceed[j]++;
    }
  }
  return [...exceed].map(k => (1 + k) / (o.draws + 1));
}

/**
 * Two-sided (1 - alpha) interval by inverting the two-sided restricted test:
 * on each side of the estimate, bisect for the farthest theta0 the test does
 * not reject. Every probe reuses the same seed, so the interval is
 * deterministic.
 */
export function wildRestrictedInterval(p: Prepared, o: Omit<WildOptions, 'alternative'> & { alpha: number }): [number, number] {
  const { theta, se } = estimate(p);
  if (!(se > 0)) return [theta, theta];
  const reject = (t0: number) => wildRestrictedP(p, [t0], { ...o, alternative: 'two-sided' })[0] <= o.alpha;
  const edge = (far: number) => {
    let out = far, inside = theta;
    if (!reject(out)) return out;
    for (let i = 0; i < 40; i++) {
      const mid = (out + inside) / 2;
      if (reject(mid)) out = mid; else inside = mid;
    }
    return inside;
  };
  return [edge(theta - 10 * se - 1), edge(theta + 10 * se + 1)];
}

export interface WildTest {
  theta: number;
  se: number;
  clusters: number;
  questions: number;
  /** Two-sided p-value of H0: no paired difference. */
  p: number;
  ci95: [number, number];
  weights: WildWeights;
  draws: number;
  seed: number;
}

/** The scoreboard's comparison: estimate, two-sided p at 0 and the inverted interval, from one seed. */
export function wildTest(rows: readonly ClusterRow[], o: { draws: number; seed: number; weights?: WildWeights; alpha?: number }): WildTest {
  const p = prepare(rows);
  const weights = o.weights ?? 'webb';
  const { theta, se } = estimate(p);
  const [pValue] = wildRestrictedP(p, [0], { draws: o.draws, seed: o.seed, weights, alternative: 'two-sided' });
  const ci95 = wildRestrictedInterval(p, { draws: o.draws, seed: o.seed, weights, alpha: o.alpha ?? 0.05 });
  return { theta, se, clusters: p.G, questions: p.N, p: pValue, ci95, weights, draws: o.draws, seed: o.seed };
}
