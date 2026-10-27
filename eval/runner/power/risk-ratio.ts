/**
 * PW, part 1: power and validated intervals for a clustered paired
 * failure-risk ratio (plan 2026-10-07, wave 1 PW; used by T0 and A10).
 *
 * Estimand. Two systems (baseline and candidate) run the same units: every
 * task, reader and repeat. A unit's outcome is a binary failure. Units are
 * paired by task (both systems see the same task) and clustered by persona
 * (tasks of one persona share a world, so their outcomes correlate). The
 * estimand is the pooled failure-risk ratio
 *     R = (candidate failures) / (baseline failures)
 * over the whole unit population, and the reported factor is 1 / R.
 *
 * Estimator (frozen). Cluster totals C_k and B_k (failures of persona k's
 * units under each system). R_hat = (sum C + 1/2) / (sum B + 1/2): the half
 * count keeps R_hat finite and positive when the candidate never fails (the
 * zero-candidate-failure case) and is the only continuity correction used.
 * The interval is chosen by simulation from three candidates, all clustered
 * by persona:
 *   delta-t      the ratio estimator's linearized variance,
 *                var(R_hat) = K/(K-1) * sum_k (C_k - R_hat B_k)^2 / (sum B + 1/2)^2,
 *                with a t quantile on K - 1 degrees of freedom;
 *   bootstrap    the percentile interval of R_hat over persona resamples;
 *   cond-binomial  conditional on each persona's total failures, the
 *                candidate's share is binomial in R / (1 + R); the Pearson
 *                design effect over personas (at least 1) deflates the
 *                counts and the exact Clopper-Pearson interval maps back to
 *                R, which stays honest at zero candidate failures.
 * Repeats and readers are not modelled separately: they are units inside a
 * persona's totals, so their correlation is carried by the cluster sums.
 *
 * Decision rule (frozen in the T0 preregistration). With a two-sided 95%
 * interval [L, U] for R:
 *   - `ceiling`        the baseline has no failures: no ratio exists;
 *   - `10x`            U <= 0.1 (the factor's lower bound is at least 10);
 *   - `improvement`    U < 1;
 *   - `worse`          L > 1;
 *   - `inconclusive`   otherwise.
 * The factor 1 / R_hat is published whatever it is. Separately, the loss
 * tolerance is a non-inferiority margin on the risk difference (candidate
 * minus baseline failure rate, clustered t interval): non-inferior when its
 * upper bound is at most the tolerance. Missing units are not imputed: a
 * run with an execution error is a failure (t0/score.ts), and a persona
 * missing from either system is dropped from both (complete pairs only).
 */

export interface ClusterTotals { /** units (task x reader x repeat) */ n: number; baseline: number; candidate: number }

export type Method = 'delta-t' | 'bootstrap' | 'cond-binomial';
export const METHODS: readonly Method[] = ['delta-t', 'bootstrap', 'cond-binomial'];
export const HALF = 0.5;

// ─── Small numeric helpers ──────────────────────────────────────────

/** Student t quantile (two-sided 1 - alpha) via the inverse incomplete beta, accurate to ~1e-8 for df >= 1. */
export function tQuantile(p: number, df: number): number {
  if (p <= 0 || p >= 1) throw new Error('p must be in (0, 1)');
  if (p < 0.5) return -tQuantile(1 - p, df);
  let lo = 0, hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const ib = incompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/** Inverse regularized incomplete beta by bisection (a, b > 0; non-integer counts allowed). */
export function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (incompleteBeta(mid, a, b) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function logGamma(z: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const v of c) ser += v / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betaCf(x, a, b) / a : 1 - bt * betaCf(1 - x, b, a) / b;
}

function betaCf(x: number, a: number, b: number): number {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

/** Seeded generator (mulberry32) so every simulation is reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(next(), 1e-12), v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, normal, int: (n: number) => Math.floor(next() * n) };
}

// ─── Estimators ─────────────────────────────────────────────────────

export interface RatioEstimate { method: Method; ratio: number; factor: number; lower: number; upper: number; baseline_failures: number; candidate_failures: number; clusters: number }

export function pointRatio(c: readonly ClusterTotals[]): number {
  const B = c.reduce((s, x) => s + x.baseline, 0), C = c.reduce((s, x) => s + x.candidate, 0);
  return (C + HALF) / (B + HALF);
}

export function ratioInterval(c: readonly ClusterTotals[], method: Method, opts: { level?: number; draws?: number; seed?: number } = {}): RatioEstimate {
  const level = opts.level ?? 0.95;
  const K = c.length;
  const B = c.reduce((s, x) => s + x.baseline, 0), C = c.reduce((s, x) => s + x.candidate, 0);
  const R = (C + HALF) / (B + HALF);
  const base = { method, ratio: R, factor: 1 / R, baseline_failures: B, candidate_failures: C, clusters: K };
  if (K < 2) return { ...base, lower: 0, upper: Infinity };
  if (method === 'delta-t') {
    const ss = c.reduce((s, x) => s + (x.candidate - R * x.baseline) ** 2, 0);
    const varR = (K / (K - 1)) * ss / (B + HALF) ** 2;
    const seLog = Math.sqrt(varR) / R;
    const q = tQuantile(1 - (1 - level) / 2, K - 1);
    return { ...base, lower: R * Math.exp(-q * seLog), upper: R * Math.exp(q * seLog) };
  }
  if (method === 'cond-binomial') {
    // Conditional on each persona's total failures T_k = B_k + C_k, C_k is binomial with pi = R / (1 + R) when both
    // systems run the same units. Persona heterogeneity in pi inflates the variance; the Pearson design effect
    // (at least 1) divides the counts, and the exact Clopper-Pearson interval on the deflated counts maps to R.
    const T = B + C;
    if (T === 0) return { ...base, lower: 0, upper: Infinity };
    const pi = (C + HALF) / (T + 1);
    const x2 = c.reduce((s, x) => { const t = x.baseline + x.candidate; return t ? s + (x.candidate - pi * t) ** 2 / (t * pi * (1 - pi)) : s; }, 0);
    const used = c.filter(x => x.baseline + x.candidate > 0).length;
    const deff = used > 1 ? Math.max(1, x2 / (used - 1)) : 1;
    const xe = C / deff, ne = T / deff, a = (1 - level) / 2;
    const pl = xe <= 0 ? 0 : betaQuantile(a, xe, ne - xe + 1);
    const pu = xe >= ne ? 1 : betaQuantile(1 - a, xe + 1, ne - xe);
    return { ...base, lower: pl / (1 - pl), upper: pu >= 1 ? Infinity : pu / (1 - pu) };
  }
  const draws = opts.draws ?? 1999;
  const r = rng(opts.seed ?? 1);
  const stats = new Float64Array(draws);
  for (let d = 0; d < draws; d++) {
    let b = 0, cc = 0;
    for (let k = 0; k < K; k++) { const x = c[r.int(K)]; b += x.baseline; cc += x.candidate; }
    stats[d] = (cc + HALF) / (b + HALF);
  }
  stats.sort();
  const lo = stats[Math.floor(((1 - level) / 2) * (draws + 1)) - 1] ?? stats[0];
  const hi = stats[Math.ceil((1 - (1 - level) / 2) * (draws + 1)) - 1] ?? stats[draws - 1];
  return { ...base, lower: lo, upper: hi };
}

/** Clustered risk difference (candidate minus baseline failure rate) with a t interval on K - 1 df: the loss-tolerance test. */
export function riskDifference(c: readonly ClusterTotals[], level = 0.95): { diff: number; lower: number; upper: number } {
  const N = c.reduce((s, x) => s + x.n, 0);
  const K = c.length;
  const diff = c.reduce((s, x) => s + x.candidate - x.baseline, 0) / N;
  if (K < 2) return { diff, lower: -Infinity, upper: Infinity };
  const ss = c.reduce((s, x) => s + (x.candidate - x.baseline - diff * x.n) ** 2, 0);
  const se = Math.sqrt((K / (K - 1)) * ss) / N;
  const q = tQuantile(1 - (1 - level) / 2, K - 1);
  return { diff, lower: diff - q * se, upper: diff + q * se };
}

/** Clustered failure rate of one system with a t interval (the baseline report's clustered interval). */
export function clusteredRate(c: ReadonlyArray<{ n: number; failures: number }>, level = 0.95): { rate: number; lower: number; upper: number; clusters: number } {
  const N = c.reduce((s, x) => s + x.n, 0);
  const K = c.length;
  const rate = c.reduce((s, x) => s + x.failures, 0) / N;
  if (K < 2) return { rate, lower: 0, upper: 1, clusters: K };
  const ss = c.reduce((s, x) => s + (x.failures - rate * x.n) ** 2, 0);
  const se = Math.sqrt((K / (K - 1)) * ss) / N;
  const q = tQuantile(1 - (1 - level) / 2, K - 1);
  return { rate, lower: Math.max(0, rate - q * se), upper: Math.min(1, rate + q * se), clusters: K };
}

export type Verdict = 'ceiling' | '10x' | 'improvement' | 'worse' | 'inconclusive';
export const TENFOLD_UPPER = 0.1;

export function verdictOf(e: RatioEstimate | null): Verdict {
  if (!e || e.baseline_failures === 0) return 'ceiling';
  return e.upper <= TENFOLD_UPPER ? '10x' : e.upper < 1 ? 'improvement' : e.lower > 1 ? 'worse' : 'inconclusive';
}

export function decide(c: readonly ClusterTotals[], method: Method, opts: { lossTolerance: number; seed?: number; draws?: number }): { verdict: Verdict; estimate: RatioEstimate | null; non_inferior: boolean; risk_difference: ReturnType<typeof riskDifference> } {
  const rd = riskDifference(c);
  const nonInferior = rd.upper <= opts.lossTolerance;
  const e = c.reduce((s, x) => s + x.baseline, 0) === 0 ? null : ratioInterval(c, method, { seed: opts.seed, draws: opts.draws });
  return { verdict: verdictOf(e), estimate: e, non_inferior: nonInferior, risk_difference: rd };
}

// ─── Data-generating model (frozen assumptions) ─────────────────────

/**
 * One simulated experiment. Per persona k (cluster) and task j: a baseline failure probability
 *   logit p_B = logit(base_rate) + u_k + v_kj + w_i   (u persona effect, v task effect shared by repeats and
 *                                                       both systems, w a fixed reader offset)
 * and a candidate probability p_C = min(1, ratio * p_B), so the population pooled ratio is `ratio` (exactly,
 * when no p_B * ratio exceeds 1). Each unit draws one uniform shared by both systems with probability
 * `coupling` (paired outcomes: a candidate failure then implies a baseline failure) and independent uniforms
 * otherwise. Cluster sizes are `tasks` per persona, or a uniform draw from `tasks_range` (unequal clusters).
 */
export interface Scenario {
  name: string;
  base_rate: number;
  ratio: number;
  persona_sd: number;
  task_sd: number;
  reader_offsets: number[];
  coupling: number;
  tasks_range?: [number, number];
  note: string;
}

export interface Design { personas: number; tasks: number; readers: number; repeats: number }

export function simulateTotals(s: Scenario, d: Design, r: ReturnType<typeof rng>): ClusterTotals[] {
  const logit = (p: number) => Math.log(p / (1 - p));
  const inv = (x: number) => 1 / (1 + Math.exp(-x));
  const out: ClusterTotals[] = [];
  for (let k = 0; k < d.personas; k++) {
    const u = s.persona_sd * r.normal();
    const tasks = s.tasks_range ? s.tasks_range[0] + r.int(s.tasks_range[1] - s.tasks_range[0] + 1) : d.tasks;
    let n = 0, b = 0, c = 0;
    for (let j = 0; j < tasks; j++) {
      const v = s.task_sd * r.normal();
      for (let i = 0; i < d.readers; i++) {
        const pB = inv(logit(s.base_rate) + u + v + (s.reader_offsets[i] ?? 0));
        const pC = Math.min(1, s.ratio * pB);
        for (let m = 0; m < d.repeats; m++) {
          const shared = r.next() < s.coupling;
          const x = r.next();
          const y = shared ? x : r.next();
          n++;
          if (x < pB) b++;
          if (y < pC) c++;
        }
      }
    }
    out.push({ n, baseline: b, candidate: c });
  }
  return out;
}

/** The population pooled ratio a scenario implies (differs from `ratio` only when ratio * p_B is capped at 1). */
export function trueRatio(s: Scenario, d: Design, seed = 7, draws = 200_000): number {
  const r = rng(seed);
  const logit = (p: number) => Math.log(p / (1 - p));
  const inv = (x: number) => 1 / (1 + Math.exp(-x));
  let sb = 0, sc = 0;
  for (let i = 0; i < draws; i++) {
    const pB = inv(logit(s.base_rate) + s.persona_sd * r.normal() + s.task_sd * r.normal() + (s.reader_offsets[i % Math.max(1, d.readers)] ?? 0));
    sb += pB; sc += Math.min(1, s.ratio * pB);
  }
  return sc / sb;
}

/** Frozen validation scenarios (null, sparse-event, ceiling, heterogeneous clusters, and the central T0 case). */
export const SCENARIOS: readonly Scenario[] = [
  { name: 'null-central', base_rate: 0.3, ratio: 1, persona_sd: 0.5, task_sd: 1.0, reader_offsets: [-0.4, 0, 0.4], coupling: 0.5, note: 'no effect at a 30% baseline failure rate' },
  { name: 'null-sparse', base_rate: 0.05, ratio: 1, persona_sd: 0.5, task_sd: 1.0, reader_offsets: [-0.4, 0, 0.4], coupling: 0.5, note: 'no effect, sparse events (5%)' },
  { name: 'null-heterogeneous', base_rate: 0.3, ratio: 1, persona_sd: 1.2, task_sd: 1.0, reader_offsets: [-0.8, 0, 0.8], coupling: 0.3, tasks_range: [2, 8], note: 'no effect, strong persona effects and unequal cluster sizes' },
  { name: 'tenfold-boundary', base_rate: 0.3, ratio: 0.1, persona_sd: 0.5, task_sd: 1.0, reader_offsets: [-0.4, 0, 0.4], coupling: 0.5, note: 'true factor exactly 10: a 10x claim here is a false positive at the boundary' },
  { name: 'fivefold', base_rate: 0.3, ratio: 0.2, persona_sd: 0.5, task_sd: 1.0, reader_offsets: [-0.4, 0, 0.4], coupling: 0.5, note: 'true factor 5: a 10x claim here is a false positive' },
  { name: 'tenfold-sparse', base_rate: 0.05, ratio: 0.1, persona_sd: 0.5, task_sd: 1.0, reader_offsets: [-0.4, 0, 0.4], coupling: 0.5, note: 'true factor 10 at a sparse baseline' },
  { name: 'tenfold-heterogeneous', base_rate: 0.3, ratio: 0.1, persona_sd: 1.2, task_sd: 1.0, reader_offsets: [-0.8, 0, 0.8], coupling: 0.3, tasks_range: [2, 8], note: 'true factor 10, heterogeneous clusters' },
  { name: 'twentyfold', base_rate: 0.3, ratio: 0.05, persona_sd: 0.5, task_sd: 1.0, reader_offsets: [-0.4, 0, 0.4], coupling: 0.5, note: 'true factor 20 (power)' },
  { name: 'ceiling-zero-candidate', base_rate: 0.3, ratio: 0, persona_sd: 0.5, task_sd: 1.0, reader_offsets: [-0.4, 0, 0.4], coupling: 0.5, note: 'the candidate never fails (zero-candidate-failure handling; power only)' },
  { name: 'ceiling-rare-baseline', base_rate: 0.02, ratio: 0.1, persona_sd: 0.5, task_sd: 1.0, reader_offsets: [-0.4, 0, 0.4], coupling: 0.5, note: 'baseline near the ceiling (2%): often too few baseline failures for any ratio' },
];

export interface SimSummary {
  scenario: string;
  method: Method;
  design: Design;
  sims: number;
  true_ratio: number;
  /** Share of runs whose 95% interval contains the true ratio (null when the true ratio is 0). */
  coverage: number | null;
  /** Share of runs with each verdict. */
  verdicts: Record<Verdict, number>;
  median_factor_lower_bound: number;
  /** 20th percentile of the factor's lower bound: the bound this design establishes with 80% probability. */
  p20_factor_lower_bound: number;
}

export function simulate(s: Scenario, d: Design, method: Method, opts: { sims: number; seed: number; draws?: number }): SimSummary {
  const r = rng(opts.seed);
  const tr = trueRatio(s, d);
  let covered = 0, coverable = 0;
  const verdicts: Record<Verdict, number> = { ceiling: 0, '10x': 0, improvement: 0, worse: 0, inconclusive: 0 };
  const lowers: number[] = [];
  for (let i = 0; i < opts.sims; i++) {
    const totals = simulateTotals(s, d, r);
    const e = totals.reduce((t, x) => t + x.baseline, 0) === 0 ? null : ratioInterval(totals, method, { seed: opts.seed + i, draws: opts.draws });
    verdicts[verdictOf(e)]++;
    if (!e) { lowers.push(0); continue; }
    lowers.push(1 / e.upper);
    if (tr > 0) { coverable++; if (e.lower <= tr && tr <= e.upper) covered++; }
  }
  lowers.sort((a, b) => a - b);
  for (const k of Object.keys(verdicts) as Verdict[]) verdicts[k] /= opts.sims;
  return {
    scenario: s.name, method, design: d, sims: opts.sims, true_ratio: tr,
    coverage: tr > 0 && coverable ? covered / coverable : null, verdicts,
    median_factor_lower_bound: lowers[Math.floor(lowers.length / 2)], p20_factor_lower_bound: lowers[Math.floor(lowers.length * 0.2)],
  };
}

/**
 * Method choice rule (frozen): among METHODS, keep those whose coverage is at least 0.93 in every scenario
 * with a positive true ratio and whose rate of a false `10x` verdict at the tenfold boundary is at most 0.05;
 * prefer delta-t (deterministic, no resampling seed) when both qualify; if neither qualifies, use the one with
 * the higher minimum coverage and report the shortfall.
 */
export function chooseMethod(results: readonly SimSummary[]): { method: Method; qualified: Method[]; min_coverage: Record<Method, number> } {
  const minCov = Object.fromEntries(METHODS.map(m => [m, Math.min(...results.filter(r => r.method === m && r.coverage !== null).map(r => r.coverage!))])) as Record<Method, number>;
  const fp = (m: Method) => Math.max(...results.filter(r => r.method === m && r.scenario.startsWith('tenfold')).map(r => r.verdicts['10x']));
  const qualified = METHODS.filter(m => minCov[m] >= 0.93 && fp(m) <= 0.05);
  const method = qualified.includes('delta-t') ? 'delta-t' : qualified[0] ?? (minCov['delta-t'] >= minCov.bootstrap ? 'delta-t' : 'bootstrap');
  return { method, qualified, min_coverage: minCov };
}
