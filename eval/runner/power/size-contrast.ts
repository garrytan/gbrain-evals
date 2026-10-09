/**
 * PW, part 2: power for a within-persona system-by-size contrast (plan
 * 2026-10-07, wave 3 B-man manifest).
 *
 * Estimand. Two systems answer the same questions of the same persona at two
 * brain sizes (the nested personal world: the small brain is a subset of the
 * large one). For persona k, with a_{s,z} the system s mean score at size z,
 *     d_k = (a_{gbrain,large} - a_{gbrain,small}) - (a_{other,large} - a_{other,small}),
 * the difference between the two systems' size slopes. The contrast is the
 * mean of d_k over personas present at both sizes; personas missing either
 * size or either system are dropped (complete cases only, never imputed).
 *
 * Test (frozen): a one-sample t interval on the d_k with K - 1 degrees of
 * freedom (persona is the cluster; questions, readers and repeats are
 * averaged inside d_k, so their correlation is carried by the persona mean).
 * Decision rule (frozen in the B-man preregistration): the minimum detectable
 * contrast (MDD) at 80% power and two-sided 5% must be at most the 3.0-point
 * tolerance for a non-inferiority claim on the slope; otherwise the 1M-to-10M
 * slope is reported descriptively with its MDD and no claim is made.
 */
import { rng, tQuantile } from './risk-ratio.ts';

export interface SizeDesign { personas: number; questions: number; readers: number; /** personas missing the large size, dropped from the contrast */ missing: number }

/**
 * Data-generating model (frozen assumptions). For persona k, system s, size z, question q, reader i:
 *   logit p = logit(base) + u_k + q_kq + g_{k,s} + h_{k,z} + slope_s * z + delta * [s = gbrain] * z
 * u persona level, q question difficulty (shared by systems and sizes: paired questions), g a persona-by-system
 * effect, h a persona-by-size effect, and a persona-specific slope difference e_k ~ N(0, slope_sd^2) added to the
 * gbrain arm at the large size (heterogeneous slopes). z is 0 (small) or 1 (large); delta is the true contrast on
 * the logit scale and is reported in points through `pointsFromLogit`.
 */
export interface SizeScenario {
  name: string;
  base: number;
  persona_sd: number;
  question_sd: number;
  persona_system_sd: number;
  persona_size_sd: number;
  slope_sd: number;
  common_slope: number;
  note: string;
}

export const SIZE_SCENARIOS: readonly SizeScenario[] = [
  { name: 'central', base: 0.7, persona_sd: 0.5, question_sd: 1.2, persona_system_sd: 0.3, persona_size_sd: 0.3, slope_sd: 0.2, common_slope: -0.4, note: '70% accuracy, both systems lose some accuracy at the large size' },
  { name: 'ceiling', base: 0.95, persona_sd: 0.5, question_sd: 1.2, persona_system_sd: 0.3, persona_size_sd: 0.3, slope_sd: 0.2, common_slope: -0.4, note: 'near-ceiling accuracy (95%)' },
  { name: 'sparse', base: 0.1, persona_sd: 0.5, question_sd: 1.2, persona_system_sd: 0.3, persona_size_sd: 0.3, slope_sd: 0.2, common_slope: -0.4, note: 'rare correct answers (10%)' },
  { name: 'heterogeneous', base: 0.7, persona_sd: 1.2, question_sd: 1.2, persona_system_sd: 0.6, persona_size_sd: 0.6, slope_sd: 0.6, common_slope: -0.4, note: 'strong persona-specific system and slope effects' },
];

const inv = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));

/** Persona contrasts d_k (in points, 0-100) for one simulated experiment with true logit contrast `delta`. */
export function simulateContrasts(s: SizeScenario, d: SizeDesign, delta: number, r: ReturnType<typeof rng>): number[] {
  const out: number[] = [];
  for (let k = 0; k < d.personas; k++) {
    const u = s.persona_sd * r.normal();
    const g = [s.persona_system_sd * r.normal(), s.persona_system_sd * r.normal()];
    const h = [0, s.persona_size_sd * r.normal()];
    const e = s.slope_sd * r.normal();
    const sums = [[0, 0], [0, 0]];
    for (let q = 0; q < d.questions; q++) {
      const qd = s.question_sd * r.normal();
      for (let sys = 0; sys < 2; sys++) for (let z = 0; z < 2; z++) {
        const p = inv(logit(s.base) + u + qd + g[sys] + h[z] + s.common_slope * z + (sys === 0 ? (delta + e) * z : 0));
        for (let i = 0; i < d.readers; i++) if (r.next() < p) sums[sys][z]++;
      }
    }
    if (k < d.missing) continue;
    const n = d.questions * d.readers;
    out.push(100 * ((sums[0][1] - sums[0][0]) - (sums[1][1] - sums[1][0])) / n);
  }
  return out;
}

export function contrastInterval(dk: readonly number[], level = 0.95): { mean: number; lower: number; upper: number; personas: number } {
  const K = dk.length;
  const mean = dk.reduce((a, b) => a + b, 0) / K;
  if (K < 2) return { mean, lower: -Infinity, upper: Infinity, personas: K };
  const sd = Math.sqrt(dk.reduce((a, b) => a + (b - mean) ** 2, 0) / (K - 1));
  const q = tQuantile(1 - (1 - level) / 2, K - 1);
  return { mean, lower: mean - q * sd / Math.sqrt(K), upper: mean + q * sd / Math.sqrt(K), personas: K };
}

/** The true contrast in points that a logit-scale delta implies for a scenario, by Monte Carlo over the model. */
export function pointsFromLogit(s: SizeScenario, delta: number, draws = 100_000, seed = 3): number {
  const r = rng(seed);
  let acc = 0;
  for (let i = 0; i < draws; i++) {
    const base = logit(s.base) + s.persona_sd * r.normal() + s.question_sd * r.normal() + s.persona_size_sd * r.normal() + s.common_slope;
    const g = s.persona_system_sd * r.normal();
    const e = s.slope_sd * r.normal();
    acc += inv(base + g + delta + e) - inv(base + g + e);
  }
  return 100 * acc / draws;
}

export interface SizeSim { scenario: string; design: SizeDesign; sims: number; delta_logit: number; true_points: number; coverage: number; reject_rate: number }

export function simulateSize(s: SizeScenario, d: SizeDesign, delta: number, opts: { sims: number; seed: number }): SizeSim {
  const r = rng(opts.seed);
  const truth = pointsFromLogit(s, delta);
  let covered = 0, rejected = 0;
  for (let i = 0; i < opts.sims; i++) {
    const ci = contrastInterval(simulateContrasts(s, d, delta, r));
    if (ci.lower <= truth && truth <= ci.upper) covered++;
    if (ci.lower > 0 || ci.upper < 0) rejected++;
  }
  return { scenario: s.name, design: d, sims: opts.sims, delta_logit: delta, true_points: truth, coverage: covered / opts.sims, reject_rate: rejected / opts.sims };
}

/** Smallest true contrast (in points, on a logit grid) detected with `power`; null when none on the grid reaches it. */
export function minimumDetectableContrast(s: SizeScenario, d: SizeDesign, opts: { sims: number; seed: number; power?: number; grid?: number[] }): { mdd_points: number | null; curve: Array<{ delta_logit: number; points: number; power: number }> } {
  const grid = opts.grid ?? [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.85, 1.0, 1.25, 1.5];
  const curve = grid.map(delta => { const sim = simulateSize(s, d, delta, opts); return { delta_logit: delta, points: sim.true_points, power: sim.reject_rate }; });
  const hit = curve.find(c => c.power >= (opts.power ?? 0.8));
  return { mdd_points: hit ? hit.points : null, curve };
}

export const SLOPE_TOLERANCE_POINTS = 3.0;
