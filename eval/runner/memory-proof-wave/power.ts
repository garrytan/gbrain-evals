/**
 * Free power and coverage simulation for the memory proof wave's primary
 * test: is gbrain's graded accuracy non-inferior to the comparator's on
 * sealed BEAM conversations, within a margin, at one-sided 95%?
 *
 * Generative model for one simulated sealed run (true difference 0):
 *   1. In each stratum (a BEAM size), draw the sealed conversations at
 *      random, without replacement, from the real conversations. Each keeps
 *      its real question count and question categories.
 *   2. Each question is "discordant" with probability q_s. A discordant
 *      question's paired difference is X - Y, where X and Y are independent
 *      draws from the committed scores of that question's category in that
 *      stratum (graded rubric scores for BEAM, 0/1 elsewhere). Otherwise
 *      the two systems score it the same. q_s is set so the variance of the
 *      per-question difference equals the scenario's target, which comes
 *      from measured paired runs (see `scenarios`).
 *   3. Each conversation adds a shift u_c ~ Normal(0, tau^2) points to all
 *      its questions: some conversations favor one system.
 * A true difference theta enters as a location shift. Every bound method
 * except the restricted wild test is location-equivariant, so one set of
 * simulated bounds at theta = 0 gives coverage, power at every theta and
 * the minimum detectable margin. The restricted wild test is run at a grid
 * of distances between the null and the truth, which is what its decision
 * depends on under a location shift.
 */
import { seededRandom } from '../stats/paired.ts';
import type { AnalogPair, DatasetInput } from './harness-inputs.ts';
import { median } from './cluster-stats.ts';
import { BOUND_METHODS, lowerBounds, prepare, studentTQuantile, wildRestrictedP, type BoundMethod, type ClusterRow, type WildWeights } from './ni-stats.ts';

// ─── Paired-run anchors from gbrain's own LongMemEval-S receipts ────

export interface PairedAnchor { label: string; doc: string; level: 'retrieval' | 'answer'; n: number; plus: number; minus: number }

/** Paired counts as published; `plus` favors the first-named arm. */
export const GBRAIN_PAIRED_LME: PairedAnchor[] = [
  { label: 'reranker on against off, strict retrieval, opaque-id recount', doc: 'docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md', level: 'retrieval', n: 470, plus: 23, minus: 6 },
  { label: 'R2 against the published run: one configuration answered twice', doc: 'docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md', level: 'answer', n: 500, plus: 15, minus: 16 },
  { label: 'R1 reranker on against off, answers', doc: 'docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md', level: 'answer', n: 500, plus: 31, minus: 17 },
  { label: 'notes reader against direct reader, identical retrieval', doc: 'docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md', level: 'answer', n: 500, plus: 32, minus: 11 },
  { label: 'gpt-5.4 reader against GPT-4o reader, identical retrieval', doc: 'docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md', level: 'answer', n: 500, plus: 33, minus: 16 },
];

/** Variance of a per-question paired 0/1 difference: discordance minus the squared mean difference (score units). */
export function pairedVariance(n: number, plus: number, minus: number): number {
  return (plus + minus) / n - ((plus - minus) / n) ** 2;
}

export interface Scenario {
  name: 'optimistic' | 'central' | 'pessimistic' | 'stress';
  diff_variance: number;
  tau_points: number;
  /** A share of conversations where one system fails badly: their shift is `shift_points`, and every conversation is recentred so the true mean stays 0. */
  tail?: { share: number; shift_points: number };
  source: string;
}

/**
 * Three assumption sets.
 *   optimistic   gbrain's +23/-6 of 470 (two gbrain configurations), no conversation effect
 *   central      gbrain's widest answer-level paired run, median conversation effect
 *                from the cross-system rows
 *   pessimistic  the widest cross-system paired run in the harness's committed rows
 *                (two different memory systems), largest conversation effect
 */
export function scenarios(analogs: readonly AnalogPair[]): Scenario[] {
  const anchor = GBRAIN_PAIRED_LME[0];
  const answer = GBRAIN_PAIRED_LME.filter(a => a.level === 'answer').map(a => ({ a, v: pairedVariance(a.n, a.plus, a.minus) })).sort((x, y) => y.v - x.v)[0];
  const cross = analogs.map(a => ({ a, v: pairedVariance(a.n, a.a_only, a.b_only) })).sort((x, y) => y.v - x.v)[0];
  const taus = analogs.map(a => a.tau_points).filter((t): t is number => t !== null && t > 0);
  const r = (x: number) => Number(x.toFixed(5));
  return [
    { name: 'optimistic', diff_variance: r(pairedVariance(anchor.n, anchor.plus, anchor.minus)), tau_points: 0, source: `+${anchor.plus}/-${anchor.minus} of ${anchor.n} (${anchor.label}); no conversation effect` },
    { name: 'central', diff_variance: r(answer.v), tau_points: Number(median(taus).toFixed(2)), source: `+${answer.a.plus}/-${answer.a.minus} of ${answer.a.n} (${answer.a.label}); conversation effect = median of ${taus.length} cross-system estimates` },
    { name: 'pessimistic', diff_variance: r(cross.v), tau_points: Number(Math.max(...taus).toFixed(2)), source: `+${cross.a.a_only}/-${cross.a.b_only} of ${cross.a.n} (${cross.a.dataset}, ${cross.a.a} against ${cross.a.b}); largest cross-system conversation effect` },
  ];
}

/** Coverage stress test: the central assumptions plus a skewed tail, one conversation in ten losing 15 points (an ingest that half fails, say). */
export function stressScenario(central: Scenario): Scenario {
  return { ...central, name: 'stress', tail: { share: 0.1, shift_points: -15 }, source: `${central.source}; plus 1 in 10 conversations shifted by -15 points, recentred to mean 0 (coverage stress test)` };
}

// ─── Simulation ─────────────────────────────────────────────────────

export interface DesignStratum { key: string; sealed: number }
export interface Design { id: string; label: string; strata: DesignStratum[] }

export interface PoolStratum { key: string; sealed: number; clusters: Int32Array[]; dists: Float64Array[]; m2: number }

/** Per-category score pools and the mean of 2 * Var(category) over questions: the difference variance when every question is discordant. */
export function poolStratum(input: DatasetInput, key: string, sealed: number): PoolStratum {
  const cats = new Map<string, number>();
  const values: number[][] = [];
  const clusters = input.clusters.map(c => Int32Array.from(c.items.map(i => {
    let k = cats.get(i.cat);
    if (k === undefined) { k = cats.size; cats.set(i.cat, k); values.push([]); }
    values[k].push(i.score);
    return k;
  })));
  if (sealed > clusters.length) throw new Error(`${key}: ${sealed} sealed clusters requested, ${clusters.length} exist`);
  const dists = values.map(v => Float64Array.from(v));
  const varOf = (v: Float64Array) => { const m = v.reduce((s, x) => s + x, 0) / v.length; return v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length; };
  const catVar = dists.map(varOf);
  let total = 0, n = 0;
  for (const c of clusters) for (const k of c) { total += 2 * catVar[k]; n++; }
  return { key, sealed, clusters, dists, m2: total / n };
}

export interface SimOptions { sims: number; draws: number; seed: number; alpha: number; distances: number[]; wild: WildWeights[] }

export interface SimResult {
  design: string;
  scenario: string;
  sealed_clusters: number;
  sealed_questions: number;
  discordance_probability: Record<string, number>;
  /** Per-question difference variance actually simulated (score units): the target, or 2 * Var(category) when every question is discordant. */
  effective_diff_variance: Record<string, number>;
  capped_strata: string[];
  sims: number;
  draws: number;
  mean_se: number;
  sd_theta_hat: number;
  /** Simulated one-sided lower bounds at true difference 0, per method. */
  bounds: Record<BoundMethod, Float64Array>;
  /** Restricted wild test rejection rate at each distance (null minus truth = -distance). */
  wild_r: Record<string, number[]>;
}

const normal = (rng: () => number) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

export function simulate(pools: PoolStratum[], scenario: Scenario, design: Design, o: SimOptions): SimResult {
  const rng = seededRandom(o.seed);
  const q = pools.map(p => Math.min(1, scenario.diff_variance / p.m2));
  const capped = pools.filter(p => scenario.diff_variance / p.m2 > 1).map(p => p.key);
  const bounds = Object.fromEntries(BOUND_METHODS.map(m => [m, new Float64Array(o.sims)])) as Record<BoundMethod, Float64Array>;
  const rejects = Object.fromEntries(o.wild.map(w => [w, new Array(o.distances.length).fill(0)])) as Record<string, number[]>;
  const thetas = new Float64Array(o.sims);
  let seSum = 0;
  const sealedQuestions = { n: 0 };
  for (let s = 0; s < o.sims; s++) {
    const rows: ClusterRow[] = [];
    let qn = 0;
    pools.forEach((p, k) => {
      const order = Int32Array.from(p.clusters.keys());
      for (let i = 0; i < p.sealed; i++) {
        const j = i + Math.floor(rng() * (order.length - i));
        const t = order[i]; order[i] = order[j]; order[j] = t;
        const cats = p.clusters[order[i]];
        let u = scenario.tau_points > 0 ? scenario.tau_points * normal(rng) : 0;
        if (scenario.tail) u += (rng() < scenario.tail.share ? scenario.tail.shift_points : 0) - scenario.tail.share * scenario.tail.shift_points;
        let sum = 0;
        for (const cat of cats) {
          let d = u;
          if (rng() < q[k]) {
            const dist = p.dists[cat];
            d += 100 * (dist[Math.floor(rng() * dist.length)] - dist[Math.floor(rng() * dist.length)]);
          }
          sum += d;
        }
        qn += cats.length;
        rows.push({ id: `${p.key}#${order[i]}`, stratum: p.key, n: cats.length, sum });
      }
    });
    sealedQuestions.n = qn;
    const prepared = prepare(rows);
    const lb = lowerBounds(prepared, { alpha: o.alpha, draws: o.draws, seed: Math.floor(rng() * 2 ** 31) });
    for (const m of BOUND_METHODS) bounds[m][s] = lb[m];
    thetas[s] = lb.theta;
    seSum += lb.se;
    for (const w of o.wild) {
      const ps = wildRestrictedP(prepared, o.distances.map(d => -d), { draws: o.draws, seed: Math.floor(rng() * 2 ** 31), weights: w });
      ps.forEach((pv, j) => { if (pv <= o.alpha) rejects[w][j]++; });
    }
  }
  const mean = thetas.reduce((a, b) => a + b, 0) / o.sims;
  return {
    design: design.id, scenario: scenario.name,
    sealed_clusters: pools.reduce((a, p) => a + p.sealed, 0), sealed_questions: sealedQuestions.n,
    discordance_probability: Object.fromEntries(pools.map((p, i) => [p.key, Number(q[i].toFixed(4))])),
    effective_diff_variance: Object.fromEntries(pools.map((p, i) => [p.key, Number((q[i] * p.m2).toFixed(5))])), capped_strata: capped,
    sims: o.sims, draws: o.draws,
    mean_se: seSum / o.sims,
    sd_theta_hat: Math.sqrt(thetas.reduce((a, t) => a + (t - mean) ** 2, 0) / (o.sims - 1)),
    bounds,
    wild_r: Object.fromEntries(o.wild.map(w => [`wild-r-${w}`, rejects[w].map(k => k / o.sims)])),
  };
}

// ─── Summaries ──────────────────────────────────────────────────────

/** P(lower bound + theta > -margin): the chance non-inferiority is shown when the true difference is theta. */
export function powerAt(lbs: Float64Array, theta: number, margin: number): number {
  let k = 0;
  for (const lb of lbs) if (lb + theta > -margin) k++;
  return k / lbs.length;
}

/** One-sided coverage at the truth (0): share of bounds at or below it. */
export function coverage(lbs: Float64Array): number {
  let k = 0;
  for (const lb of lbs) if (lb <= 0) k++;
  return k / lbs.length;
}

/** Smallest margin with at least `power` chance of showing non-inferiority when the true difference is 0. */
export function minimumDetectableMargin(lbs: Float64Array, power = 0.8): number {
  const s = Float64Array.from(lbs).sort();
  const k = Math.max(0, Math.floor((1 - power) * s.length + 1e-9));
  return -s[k];
}

/** Linear interpolation of the distance at which the rejection curve first reaches `power`. */
export function interpolateDistance(distances: number[], rates: number[], power = 0.8): number | null {
  for (let i = 0; i < distances.length; i++) {
    if (rates[i] >= power) {
      if (i === 0) return distances[0];
      const f = (power - rates[i - 1]) / (rates[i] - rates[i - 1]);
      return distances[i - 1] + f * (distances[i] - distances[i - 1]);
    }
  }
  return null;
}

export interface Summary {
  design: string;
  label: string;
  scenario: string;
  sealed_clusters: number;
  sealed_questions: number;
  discordance_probability: Record<string, number>;
  effective_diff_variance: Record<string, number>;
  capped_strata: string[];
  mean_se_points: number;
  sd_estimate_points: number;
  /** power[`margin_M`][`theta_T`]: chance the lower bound clears -M when the true difference is T points. */
  methods: Record<string, { coverage: number; power: Record<string, Record<string, number>>; mdm80: number | null }>;
}

export function summarize(r: SimResult, label: string, margins: number[], thetas: number[], distances: number[]): Summary {
  const r4 = (x: number) => Number(x.toFixed(4));
  const methods: Summary['methods'] = {};
  for (const m of BOUND_METHODS) {
    const lbs = r.bounds[m];
    methods[m] = {
      coverage: r4(coverage(lbs)),
      power: Object.fromEntries(margins.map(m => [`margin_${m}`, Object.fromEntries(thetas.map(t => [`theta_${t}`, r4(powerAt(lbs, t, m))]))])),
      mdm80: Number(minimumDetectableMargin(lbs).toFixed(2)),
    };
  }
  for (const [m, rates] of Object.entries(r.wild_r)) {
    const at = (d: number) => { const i = distances.indexOf(d); if (i < 0) throw new Error(`distance ${d} not simulated`); return r4(rates[i]); };
    const mdm = interpolateDistance(distances, rates);
    methods[m] = {
      coverage: r4(1 - at(0)),
      power: Object.fromEntries(margins.map(m => [`margin_${m}`, Object.fromEntries(thetas.map(t => [`theta_${t}`, at(m + t)]))])),
      mdm80: mdm === null ? null : Number(mdm.toFixed(2)),
    };
  }
  return {
    design: r.design, label, scenario: r.scenario, sealed_clusters: r.sealed_clusters, sealed_questions: r.sealed_questions,
    discordance_probability: r.discordance_probability, effective_diff_variance: r.effective_diff_variance, capped_strata: r.capped_strata,
    mean_se_points: Number(r.mean_se.toFixed(3)), sd_estimate_points: Number(r.sd_theta_hat.toFixed(3)), methods,
  };
}

/**
 * Closed-form check of the simulation: minimum detectable margin at true
 * difference 0 from the stratified variance of a mean of cluster means,
 * (t(1 - alpha) + t(power)) * se with G - S degrees of freedom.
 */
export function approximateMdm(pools: readonly PoolStratum[], diffVariance: number, tauPoints: number, o: { alpha?: number; power?: number } = {}): number {
  const sizes = pools.map(p => p.clusters.reduce((s, c) => s + c.length, 0) / p.clusters.length);
  const N = pools.reduce((s, p, i) => s + p.sealed * sizes[i], 0);
  let v = 0;
  pools.forEach((p, i) => {
    const w = (p.sealed * sizes[i]) / N;
    const veff = 1e4 * Math.min(diffVariance, p.m2);
    v += w * w * (veff / (p.sealed * sizes[i]) + tauPoints * tauPoints / p.sealed);
  });
  const df = pools.reduce((s, p) => s + p.sealed, 0) - pools.length;
  return (studentTQuantile(1 - (o.alpha ?? 0.05), df) + studentTQuantile(o.power ?? 0.8, df)) * Math.sqrt(v);
}
