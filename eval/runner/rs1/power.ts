/**
 * RS1's power model (docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md, "Power" and "Internal pilot"): GBEV-48's
 * rs1_narrow_power.py in TypeScript, with every simulated decision made by eval/runner/rs1/iut.ts's rule.
 *
 *   - Per-test n: the smallest n whose shifted-t power (one-sided alpha 0.05) reaches the target at margin M and true
 *     gap delta. Analytic, so it matches GBEV-48's power.json exactly.
 *   - Joint n: the gating tests' per-conversation differences (iut.ts GATING, the Astra/Opus view since the R78
 *     amendment) are drawn from a multivariate normal (their sds and correlation in a scenario's `keys` order), and the
 *     joint power is the share of simulations iut.ts passes. A scenario with keys COMPARISONS and gating COMPARISONS is
 *     GBEV-48's original four-test model, which the tests still reproduce against power.json. A
 *     seeded generator (stats/paired.ts seededRandom, SEED) and SIMS simulations per point give a Monte Carlo standard
 *     error of about 0.003 at power 0.8; MC_TOLERANCE (0.015) is the agreement power.ts claims with GBEV-48's numpy
 *     stream, which it cannot replay. Joint N is the smallest n with power at least the target at n and n + 1, as
 *     GBEV-48 searched it, so it can differ from power.json by one conversation.
 *   - Pilot: from wave A's two gating SDs and their correlation, N_required at true gaps of 0 and M = 3.5 and
 *     N_final = min(33, max(20, N_required)); above 33, the margin reachable at 33 (bisection over M with common
 *     random numbers, so power is monotone in M) and the price of N_required (pricing.ts).
 */
import { seededRandom } from '../stats/paired.ts';
import { COMPARISONS, GATING, passes, RS1_ALPHA, RS1_MARGIN, tCdf, tQuantile, type ComparisonKey } from './iut.ts';

export const SEED = 20261108;
export const SIMS = 20_000;
export const MC_TOLERANCE = 0.015;
export const TARGET_POWER = 0.8;
export const N_MIN = 20;
export const N_CAP = 33;

/**
 * GBEV-48's inputs: F6's S2b two-sided 95% conversation-cluster bootstrap intervals (GST-1365 summary.json; 24
 * conversations x 10 questions, three-reader mean, as fractions) for each server under the frontier judges, BEAM's judge
 * and their difference. The SE is the half-width over z(0.975); the SD at 10 items is SE x sqrt(24) x sqrt(24 / 23), and
 * the judge correlation per server comes from the three SEs. F6's frontier view was gpt-6.1-sol on Claude rows and
 * claude-opus-5-5 on Sol rows; it stands in for the Astra/Opus gating view until the pilot measures that view's SDs.
 */
const F6_CI = {
  'memory-bank': { frontier: [-0.013901, 0.053505], bridge: [-0.009748, 0.036661], delta: [-0.015806, 0.031693] },
  'extract-first': { frontier: [0.00383, 0.065436], bridge: [0.024905, 0.070303], delta: [-0.033225, 0.00918] },
} as const;
const F6_CONVERSATIONS = 24;
const seOf = ([lo, hi]: readonly number[]) => 100 * (hi - lo) / 2 / 1.959963984540054;
export const SD10 = Object.fromEntries(COMPARISONS.map(key => {
  const [server, view] = key.split('/') as ['memory-bank' | 'extract-first', 'frontier' | 'bridge'];
  return [key, seOf(F6_CI[server][view]) * Math.sqrt(F6_CONVERSATIONS) * Math.sqrt(F6_CONVERSATIONS / (F6_CONVERSATIONS - 1))];
})) as Record<ComparisonKey, number>;
export const RHO_JUDGE = Object.fromEntries((['memory-bank', 'extract-first'] as const).map(s => {
  const [f, b, d] = [seOf(F6_CI[s].frontier), seOf(F6_CI[s].bridge), seOf(F6_CI[s].delta)];
  return [s, (f * f + b * b - d * d) / (2 * f * b)];
})) as Record<'memory-bank' | 'extract-first', number>;
/** Assumed correlation between gbrain minus one server and gbrain minus the other (shared gbrain rows). */
export const RHO_CROSS = 0.5;
export const TAUS = { optimistic: 0, central: 3.2, pessimistic: 4.8 } as const;

/** The SD at q items from the SD at 10: SD_q^2 = tau^2 + (SD_10^2 - tau^2) x 10 / q. */
export const sdAtItems = (sd10: number, q: number, tau: number) => { const t = Math.min(tau, sd10); return Math.sqrt(t * t + (sd10 * sd10 - t * t) * 10 / q); };
/** The SDs at q items for `keys` (default the gating tests). */
export const sdsAt = (q: number, tau: number, keys: readonly ComparisonKey[] = GATING) => keys.map(k => sdAtItems(SD10[k], q, tau));

/** The gating tests' 2 x 2 correlation (GATING order): the assumed cross-server correlation. */
export const corr2 = (rx = RHO_CROSS): number[][] => [[1, rx], [rx, 1]];

/** GBEV-48's 4 x 4 correlation in COMPARISONS order (memory-bank frontier, memory-bank bridge, extract-first frontier, extract-first bridge). */
export function corr4(rx = RHO_CROSS, a = RHO_JUDGE['memory-bank'], b = RHO_JUDGE['extract-first']): number[][] {
  return [[1, a, rx, rx * b], [a, 1, rx * a, rx], [rx, rx * a, 1, b], [rx * b, rx, b, 1]];
}

/** The smallest n (from nMin) whose shifted-t power reaches the target for one test. */
export function analyticN(sd: number, margin: number, delta = 0, alpha = RS1_ALPHA, power = TARGET_POWER, nMin = 6): number | null {
  for (let n = nMin; n < 2000; n++) {
    const df = n - 1;
    if (1 - tCdf(tQuantile(1 - alpha, df) - (delta + margin) * Math.sqrt(n) / sd, df) >= power) return n;
  }
  return null;
}

/** The smallest margin one test reaches at n with the target power (analytic). */
export const minMargin = (sd: number, n: number, alpha = RS1_ALPHA, power = TARGET_POWER, delta = 0) => (tQuantile(1 - alpha, n - 1) + tQuantile(power, n - 1)) * sd / Math.sqrt(n) - delta;

function cholesky(a: number[][]): number[][] {
  const l = a.map(row => row.map(() => 0));
  for (let i = 0; i < a.length; i++) for (let j = 0; j <= i; j++) {
    let s = a[i][j];
    for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
    if (i === j && s <= 0) throw new Error('the covariance matrix is not positive definite');
    l[i][j] = i === j ? Math.sqrt(s) : s / l[j][j];
  }
  return l;
}

/** One simulated trial's decision: iut.ts's rule on the simulated tests' per-conversation differences. */
export const simulatedPass = (diffs: Partial<Record<ComparisonKey, readonly number[]>>, margin = RS1_MARGIN, quantile?: number, gating: readonly ComparisonKey[] = GATING) => passes(diffs, margin, quantile, gating);

/**
 * A simulated design: the tests drawn (`keys`, default GATING), their sds, correlation and true gaps in that order, and
 * the tests that decide (`gating`, default GATING).
 */
export interface Scenario { sds: readonly number[]; corr: readonly (readonly number[])[]; deltas?: readonly number[]; keys?: readonly ComparisonKey[]; gating?: readonly ComparisonKey[] }

/** Simulated intersection-union power at n: the share of SIMS draws that iut.ts's rule passes at margin. */
export function jointPower(n: number, s: Scenario, margin = RS1_MARGIN, o: { sims?: number; seed?: number } = {}): number {
  const keys = s.keys ?? GATING;
  const k = keys.length;
  if (s.sds.length !== k || s.corr.length !== k) throw new Error(`a scenario over ${k} tests needs ${k} sds and a ${k} x ${k} correlation`);
  const l = cholesky(s.corr.map((row, i) => row.map((c, j) => c * s.sds[i] * s.sds[j])));
  const deltas = s.deltas ?? keys.map(() => 0);
  const rand = seededRandom(o.seed ?? SEED);
  let spare: number | null = null;
  const normal = () => {
    if (spare !== null) { const z = spare; spare = null; return z; }
    const u = 1 - rand(), v = rand(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  const quantile = tQuantile(1 - RS1_ALPHA, n - 1);
  const sims = o.sims ?? SIMS;
  const z = new Array<number>(k);
  let pass = 0;
  for (let sim = 0; sim < sims; sim++) {
    const diffs = Object.fromEntries(keys.map(key => [key, new Array<number>(n)])) as Record<ComparisonKey, number[]>;
    for (let c = 0; c < n; c++) {
      for (let i = 0; i < k; i++) z[i] = normal();
      for (let i = 0; i < k; i++) { let x = deltas[i]; for (let j = 0; j <= i; j++) x += l[i][j] * z[j]; diffs[keys[i]][c] = x; }
    }
    if (simulatedPass(diffs, margin, quantile, s.gating ?? GATING)) pass++;
  }
  return pass / sims;
}

export const N_SEARCH_MAX = 400;

/**
 * GBEV-48's joint search rule, the first n with power at least the target at n and at n + 1, starting from the largest
 * per-test analytic n less 4. The first n reaching the target is found by doubling and bisection, then the n + 1 check
 * walks up; null above N_SEARCH_MAX.
 */
export function jointN(s: Scenario, margin = RS1_MARGIN, power = TARGET_POWER): { n: number | null; power: number } {
  const p = (n: number) => jointPower(n, s, margin);
  const analytic = s.sds.map((sd, i) => analyticN(sd, margin, s.deltas?.[i] ?? 0));
  if (analytic.some(n => n === null || n > N_SEARCH_MAX)) return { n: null, power: Number.NaN };
  let lo = Math.max(6, Math.max(...(analytic as number[])) - 4) - 1, hi = lo + 1;
  while (p(hi) < power) { if (hi >= N_SEARCH_MAX) return { n: null, power: Number.NaN }; lo = hi; hi = Math.min(N_SEARCH_MAX, hi * 2); }
  while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (p(m) >= power) hi = m; else lo = m; }
  for (let n = hi; n <= N_SEARCH_MAX; n++) { const pn = p(n); if (pn >= power && p(n + 1) >= power) return { n, power: pn }; }
  return { n: null, power: Number.NaN };
}

/** The smallest margin with simulated joint power at the target at n (bisection; common random numbers keep it monotone). */
export function marginAt(n: number, s: Scenario, power = TARGET_POWER): number {
  let lo = 0, hi = 50;
  for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (jointPower(n, s, m) >= power) hi = m; else lo = m; }
  return Math.round(hi * 100) / 100;
}

export interface PilotSize { n_required: number | null; n_final: number | null; power_at_required: number; over_cap: boolean; margin_at_cap: number | null }

/** The pilot's sizing from wave A's gating SDs and 2 x 2 correlation (GATING order), at true gaps of 0 and M = 3.5. */
export function pilotSize(sds: readonly number[], corr: readonly (readonly number[])[]): PilotSize {
  const s = { sds, corr };
  const { n, power } = jointN(s);
  const over = n === null || n > N_CAP;
  return { n_required: n, n_final: over ? null : Math.min(N_CAP, Math.max(N_MIN, n)), power_at_required: power, over_cap: over, margin_at_cap: over ? marginAt(N_CAP, s) : null };
}

if (import.meta.main) {
  for (const [name, tau] of Object.entries(TAUS)) {
    const sds = sdsAt(20, tau);
    const { n, power } = jointN({ sds, corr: corr2() });
    process.stdout.write(`${name}: gating SDs at 20 items ${sds.map(x => x.toFixed(2)).join(', ')}; two-test joint N at M = ${RS1_MARGIN} is ${n} (simulated power ${power.toFixed(3)}, ${SIMS} simulations, seed ${SEED})\n`);
  }
}
