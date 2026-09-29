/**
 * Paired, clustered comparison of two runs over the same items.
 *
 * Generalizes the family-clustered bootstrap, sign-flip test and Holm
 * correction first written for the situation-recall regression gate
 * (`eval/runner/situation-recall-regression.ts`) so any runner's per-item
 * rows can be compared. Plan amendment 4 (2026-09-28 10x plan).
 *
 * Contract:
 *   - Each side has unique item ids, and both sides hold the same ids.
 *   - The same eligibility rule runs on both sides, and an item is either
 *     eligible on both or ineligible on both. Anything else blocks the
 *     comparison instead of quietly shrinking the denominator.
 *   - Every item carries a cluster id (a concept, a source history, a
 *     question family). Items in one cluster are not independent, so
 *     intervals and tests resample and flip whole clusters. Duplicated
 *     paraphrases therefore do not multiply the effective sample size.
 *   - Deltas are absolute, in the metric's own units: mean(B) - mean(A).
 */

export interface Observation {
  id: string;
  cluster: string;
  /** null when the item is ineligible on this side. */
  value: number | null;
  eligible: boolean;
  reason?: string;
}

export interface PairedItem { id: string; cluster: string; a: number; b: number }

export interface Pairing {
  pairs: PairedItem[];
  /** Items ineligible on both sides, with the A-side reason. */
  excluded: Array<{ id: string; reason: string }>;
}

export class PairingError extends Error {
  constructor(readonly problems: string[]) {
    super(`paired comparison blocked: ${problems.slice(0, 8).join('; ')}${problems.length > 8 ? ` (+${problems.length - 8} more)` : ''}`);
  }
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** mulberry32-style generator shared with the situation-recall regression gate. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function holmAdjusted(pValues: number[]): number[] {
  if (!pValues.every(p => finite(p) && p >= 0 && p <= 1)) throw new Error('invalid Holm p-value');
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(pValues.length);
  let previous = 0;
  order.forEach(({ p, index }, rank) => {
    previous = Math.max(previous, Math.min(1, p * (order.length - rank)));
    adjusted[index] = previous;
  });
  return adjusted;
}

export function pairObservations(a: readonly Observation[], b: readonly Observation[]): Pairing {
  const problems: string[] = [];
  const index = (side: 'A' | 'B', rows: readonly Observation[]) => {
    const map = new Map<string, Observation>();
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id) { problems.push(`${side}: item without an id`); continue; }
      if (typeof row.cluster !== 'string' || !row.cluster) problems.push(`${side}: ${row.id} has no cluster id`);
      if (map.has(row.id)) problems.push(`${side}: duplicate id ${row.id}`);
      if (row.eligible && !finite(row.value)) problems.push(`${side}: ${row.id} is eligible but has no finite value`);
      map.set(row.id, row);
    }
    return map;
  };
  const left = index('A', a), right = index('B', b);
  for (const id of left.keys()) if (!right.has(id)) problems.push(`missing in B: ${id}`);
  for (const id of right.keys()) if (!left.has(id)) problems.push(`missing in A: ${id}`);
  const pairs: PairedItem[] = [];
  const excluded: Pairing['excluded'] = [];
  for (const [id, x] of [...left.entries()].sort(([p], [q]) => p < q ? -1 : p > q ? 1 : 0)) {
    const y = right.get(id);
    if (!y) continue;
    if (x.cluster !== y.cluster) problems.push(`cluster differs for ${id}: ${x.cluster} vs ${y.cluster}`);
    if (x.eligible !== y.eligible) {
      problems.push(`eligibility differs for ${id}: A ${x.eligible ? 'eligible' : `ineligible (${x.reason ?? 'no reason'})`}, B ${y.eligible ? 'eligible' : `ineligible (${y.reason ?? 'no reason'})`}`);
      continue;
    }
    if (!x.eligible) { excluded.push({ id, reason: x.reason ?? 'ineligible' }); continue; }
    if (finite(x.value) && finite(y.value)) pairs.push({ id, cluster: x.cluster, a: x.value, b: y.value });
  }
  if (!problems.length && !pairs.length) problems.push('no eligible pairs');
  if (problems.length) throw new PairingError(problems);
  return { pairs, excluded };
}

export interface PairedDeltaOptions { seed: number; draws: number }

export interface PairedDelta {
  n_pairs: number;
  n_clusters: number;
  mean_a: number;
  mean_b: number;
  /** mean(B) - mean(A), absolute, in metric units. */
  delta: number;
  /** Cluster bootstrap percentile interval; null with fewer than two clusters. */
  ci95: [number, number] | null;
  /** Cluster sign-flip tests of "no paired difference". */
  p_two_sided: number;
  p_greater: number;
  p_less: number;
  /** Exact enumeration of all 2^clusters sign patterns, or Monte Carlo draws. */
  p_method: 'exact-sign-flip' | 'monte-carlo-sign-flip' | 'degenerate';
  /** Cluster-robust standard error of delta; null when not estimable. */
  se_cluster: number | null;
  /** Standard error if items were independent. */
  se_iid: number | null;
  /** (se_cluster / se_iid)^2 and n_pairs / design_effect. */
  design_effect: number | null;
  effective_n: number | null;
  /** Sorted bootstrap draws of delta, for non-inferiority tests. Not serialized by the CLI. */
  bootstrap: number[];
}

const EXACT_CLUSTER_LIMIT = 20;

export function clusteredPairedDelta(pairs: readonly PairedItem[], options: PairedDeltaOptions): PairedDelta {
  if (!pairs.length) throw new Error('clusteredPairedDelta needs at least one pair');
  if (!Number.isSafeInteger(options.draws) || options.draws < 1000) throw new Error('clusteredPairedDelta needs at least 1000 draws');
  if (!pairs.every(p => finite(p.a) && finite(p.b) && typeof p.cluster === 'string' && p.cluster)) throw new Error('invalid paired observations');
  const n = pairs.length;
  const byCluster = new Map<string, { sum: number; count: number }>();
  for (const p of pairs) {
    const c = byCluster.get(p.cluster) ?? { sum: 0, count: 0 };
    c.sum += p.b - p.a;
    c.count += 1;
    byCluster.set(p.cluster, c);
  }
  const clusters = [...byCluster.entries()].sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0).map(([, c]) => c);
  const g = clusters.length;
  const meanA = pairs.reduce((s, p) => s + p.a, 0) / n;
  const meanB = pairs.reduce((s, p) => s + p.b, 0) / n;
  const delta = clusters.reduce((s, c) => s + c.sum, 0) / n;
  const diffs = pairs.map(p => p.b - p.a);
  const base = { n_pairs: n, n_clusters: g, mean_a: meanA, mean_b: meanB, delta };

  const seIid = n > 1 ? Math.sqrt(diffs.reduce((s, d) => s + (d - delta) ** 2, 0) / (n - 1) / n) : null;
  const seCluster = g > 1 ? Math.sqrt(g / (g - 1) * clusters.reduce((s, c) => s + (c.sum - delta * c.count) ** 2, 0)) / n : null;
  const designEffect = seCluster !== null && seIid !== null && seIid > 0 ? (seCluster / seIid) ** 2 : null;
  const variance = { se_cluster: seCluster, se_iid: seIid, design_effect: designEffect, effective_n: designEffect ? n / designEffect : null };

  if (diffs.every(d => d === 0)) {
    return { ...base, ...variance, ci95: g > 1 ? [0, 0] : null, p_two_sided: 1, p_greater: 1, p_less: 1, p_method: 'degenerate', bootstrap: g > 1 ? [0] : [] };
  }
  if (g < 2) {
    return { ...base, ...variance, ci95: null, p_two_sided: 1, p_greater: 1, p_less: 1, p_method: 'degenerate', bootstrap: [] };
  }

  const rng = seededRandom(options.seed);
  const boot = new Array<number>(options.draws);
  for (let i = 0; i < options.draws; i++) {
    let sum = 0, count = 0;
    for (let j = 0; j < g; j++) {
      const c = clusters[Math.floor(rng() * g)];
      sum += c.sum;
      count += c.count;
    }
    boot[i] = sum / count;
  }
  boot.sort((x, y) => x - y);
  const ci95: [number, number] = [boot[Math.floor(options.draws * 0.025)], boot[Math.ceil(options.draws * 0.975) - 1]];

  const exact = g <= EXACT_CLUSTER_LIMIT;
  const patterns = exact ? 2 ** g : options.draws;
  const observed = delta;
  const eps = 1e-12;
  let geTwo = 0, geUp = 0, leDown = 0;
  for (let i = 0; i < patterns; i++) {
    let sum = 0;
    for (let j = 0; j < g; j++) {
      const flip = exact ? ((i >>> j) & 1) === 1 : rng() < 0.5;
      sum += flip ? -clusters[j].sum : clusters[j].sum;
    }
    const nullDelta = sum / n;
    if (Math.abs(nullDelta) >= Math.abs(observed) - eps) geTwo++;
    if (nullDelta >= observed - eps) geUp++;
    if (nullDelta <= observed + eps) leDown++;
  }
  const p = (k: number) => exact ? k / patterns : (k + 1) / (patterns + 1);
  return {
    ...base, ...variance, ci95,
    p_two_sided: Math.min(1, p(geTwo)), p_greater: Math.min(1, p(geUp)), p_less: Math.min(1, p(leDown)),
    p_method: exact ? 'exact-sign-flip' : 'monte-carlo-sign-flip',
    bootstrap: boot,
  };
}

export interface McNemarResult {
  /** A pass, B fail. */
  losses: number;
  /** A fail, B pass. */
  wins: number;
  both_pass: number;
  both_fail: number;
  discordant: number;
  /** Two-sided exact binomial test on the discordant pairs. */
  p_two_sided: number;
}

/** log(n choose k) via a running sum; exact enough for n up to millions. */
function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

export function exactMcNemar(pairs: readonly PairedItem[]): McNemarResult {
  if (!pairs.every(p => (p.a === 0 || p.a === 1) && (p.b === 0 || p.b === 1))) throw new Error('exact McNemar needs binary 0/1 outcomes on both sides');
  const losses = pairs.filter(p => p.a === 1 && p.b === 0).length;
  const wins = pairs.filter(p => p.a === 0 && p.b === 1).length;
  const bothPass = pairs.filter(p => p.a === 1 && p.b === 1).length;
  const discordant = losses + wins;
  const k = Math.min(losses, wins);
  let tail = 0;
  if (discordant <= 1000) {
    let term = 0.5 ** discordant;
    for (let i = 0; i <= k; i++) { tail += term; term = term * (discordant - i) / (i + 1); }
  } else {
    for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(discordant, i) - discordant * Math.LN2);
  }
  return { losses, wins, both_pass: bothPass, both_fail: pairs.length - discordant - bothPass, discordant, p_two_sided: discordant === 0 ? 1 : Math.min(1, 2 * tail) };
}

/** Fewest one-directional discordant pairs (and none the other way) an exact two-sided McNemar test needs to reach alpha. */
export function minimumDiscordantForSignificance(alpha = 0.05): number {
  let k = 1;
  while (2 * 0.5 ** k > alpha) k++;
  return k;
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error('normalQuantile needs 0 < p < 1');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface PowerNote {
  alpha: number;
  power: number;
  /** Smallest absolute delta this design detects with the stated power (two-sided), from the cluster-robust SE. */
  mde: number | null;
  /** Binary metrics only: wins needed with zero losses to reach alpha under exact McNemar. */
  min_one_sided_discordant: number | null;
  note: string;
}

export function powerNote(stats: PairedDelta, options: { alpha?: number; power?: number; binary?: boolean } = {}): PowerNote {
  const alpha = options.alpha ?? 0.05, power = options.power ?? 0.8;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  const mde = stats.se_cluster !== null && stats.se_cluster > 0 ? z * stats.se_cluster : null;
  const minK = options.binary ? minimumDiscordantForSignificance(alpha) : null;
  const parts: string[] = [];
  if (mde === null) {
    parts.push(stats.n_clusters < 2
      ? `only ${stats.n_clusters} cluster: no interval, no test, and no detectable effect can be estimated`
      : 'no paired variation was observed, so the detectable effect cannot be estimated from this data');
  } else {
    parts.push(`with ${stats.n_pairs} pairs in ${stats.n_clusters} clusters, a two-sided ${alpha} test has ${Math.round(power * 100)}% power for an absolute change of about ${mde.toFixed(4)}`);
    parts.push(Math.abs(stats.delta) < mde ? 'the observed delta is below that size, so a null result here is not evidence of no effect' : 'the observed delta is at least that size');
  }
  if (minK !== null) parts.push(`an exact McNemar test needs at least ${minK} wins with zero losses to reach ${alpha}`);
  if (stats.design_effect !== null && stats.design_effect > 1.05) parts.push(`clustering inflates variance by ${stats.design_effect.toFixed(2)}x (effective n about ${stats.effective_n!.toFixed(1)} of ${stats.n_pairs})`);
  return { alpha, power, mde, min_one_sided_discordant: minK, note: parts.join('; ') };
}

/**
 * One-sided non-inferiority p-value from the cluster bootstrap: the share of
 * bootstrap deltas at or below the tolerance boundary, oriented so a larger
 * value is better. Rejecting (p <= alpha) means the lower bound of a
 * (1 - 2 * alpha) interval sits above -tolerance.
 */
export function nonInferiorityP(stats: PairedDelta, tolerance: number, direction: 'higher' | 'lower'): number | null {
  if (!finite(tolerance) || tolerance < 0) throw new Error('non-inferiority tolerance must be a finite number >= 0');
  if (!stats.bootstrap.length) return null;
  const sign = direction === 'higher' ? 1 : -1;
  const boundary = -tolerance;
  const draws = stats.bootstrap.length;
  if (draws === 1) return sign * stats.bootstrap[0] > boundary ? 0 : 1;
  let atOrBelow = 0;
  for (const d of stats.bootstrap) if (sign * d <= boundary + 1e-12) atOrBelow++;
  return (atOrBelow + 1) / (draws + 1);
}
