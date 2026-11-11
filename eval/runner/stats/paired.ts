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
  /** Each cluster's summed B - A and item count, in cluster-id order, with the seed and draws, for superiorityP. Not serialized by the CLI. */
  sign_flip: { sums: number[]; counts: number[]; seed: number; draws: number };
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
  const signFlip = { sums: clusters.map(c => c.sum), counts: clusters.map(c => c.count), seed: options.seed, draws: options.draws };
  const base = { n_pairs: n, n_clusters: g, mean_a: meanA, mean_b: meanB, delta, sign_flip: signFlip };

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

export interface BandMember { id: string; pairs: readonly PairedItem[] }

export interface SimultaneousBand {
  method: 'max_t_cluster_bootstrap';
  level: number;
  seed: number;
  draws: number;
  /** Distinct clusters across every member; each draw resamples as many from each stratum as the stratum holds. */
  n_clusters: number;
  n_strata: number;
  /** The level quantile of the largest studentized deviation across banded members, which sets every band; null with no varying member. */
  critical_value: number | null;
  /** The normal critical value a Bonferroni split over the same members would use, recorded beside it and never used. */
  bonferroni_critical_value: number;
  /**
   * In input order: each member's delta, its bootstrap standard error and its band: zero width for a member that never
   * varies, and null (no band, so it cannot qualify) for a member that has no pairs in some draw or fewer than two
   * clusters in all.
   */
  members: Array<{ id: string; delta: number; se_boot: number | null; ci: [number, number] | null }>;
}

/**
 * A simultaneous band over several paired deltas measured on shared clusters (question ids): one cluster bootstrap
 * over the union of the members' clusters, resampling within each stratum (a question type, fixed by design) when
 * strata are given, every member recomputed on the same draw from its own clusters, each studentized by its own
 * bootstrap standard error, and the band's half-width the level quantile of the largest absolute studentized deviation
 * times that error. All members' bands then cover together at about the stated level, because the correlation that
 * shared questions create is in the draws rather than assumed away. No returned number is non-finite.
 */
export function simultaneousBand(members: readonly BandMember[], options: { seed: number; draws: number; level?: number; strata?: Readonly<Record<string, string>> }): SimultaneousBand {
  const level = options.level ?? 0.95;
  if (!members.length) throw new Error('simultaneousBand needs at least one member');
  if (!Number.isSafeInteger(options.draws) || options.draws < 1000) throw new Error('simultaneousBand needs at least 1000 draws');
  if (!(level > 0 && level < 1)) throw new Error('simultaneousBand level must be between 0 and 1');
  if (new Set(members.map(m => m.id)).size !== members.length) throw new Error('simultaneousBand member ids must be unique');
  for (const m of members) {
    if (!m.pairs.length || !m.pairs.every(p => finite(p.a) && finite(p.b) && typeof p.cluster === 'string' && p.cluster)) throw new Error('invalid paired observations in member ' + m.id);
  }
  const clusterIds = [...new Set(members.flatMap(m => m.pairs.map(p => p.cluster)))].sort((x, y) => x < y ? -1 : x > y ? 1 : 0);
  const index = new Map(clusterIds.map((id, i) => [id, i]));
  const g = clusterIds.length;
  const sums = members.map(m => {
    const s = new Float64Array(g), c = new Float64Array(g);
    for (const p of m.pairs) { const j = index.get(p.cluster)!; s[j] += p.b - p.a; c[j] += 1; }
    return { s, c };
  });
  const deltas = sums.map(({ s, c }) => s.reduce((a, x) => a + x, 0) / c.reduce((a, x) => a + x, 0));
  const byStratum = new Map<string, number[]>();
  clusterIds.forEach((id, j) => { const k = options.strata?.[id] ?? ''; byStratum.set(k, [...(byStratum.get(k) ?? []), j]); });
  const strata = [...byStratum.entries()].sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0).map(([, js]) => js);
  const base = { method: 'max_t_cluster_bootstrap' as const, level, seed: options.seed, draws: options.draws, n_clusters: g, n_strata: strata.length };
  const bonferroni = (k: number) => normalQuantile(1 - (1 - level) / (2 * Math.max(1, k)));
  if (g < 2) return { ...base, critical_value: null, bonferroni_critical_value: bonferroni(members.length), members: members.map((m, i) => ({ id: m.id, delta: deltas[i]!, se_boot: null, ci: null })) };

  const rng = seededRandom(options.seed);
  const boot = members.map(() => new Float64Array(options.draws));
  const weight = new Float64Array(g);
  for (let d = 0; d < options.draws; d++) {
    weight.fill(0);
    for (const js of strata) for (let j = 0; j < js.length; j++) weight[js[Math.floor(rng() * js.length)]!] += 1;
    for (let m = 0; m < members.length; m++) {
      const { s, c } = sums[m]!;
      let sum = 0, count = 0;
      for (let j = 0; j < g; j++) if (weight[j]) { sum += weight[j]! * s[j]!; count += weight[j]! * c[j]!; }
      boot[m]![d] = count > 0 ? sum / count : Number.NaN;
    }
  }
  const se = boot.map(draws => {
    if (!draws.every(Number.isFinite)) return null;
    const mean = draws.reduce((a, x) => a + x, 0) / draws.length;
    return Math.sqrt(draws.reduce((a, x) => a + (x - mean) ** 2, 0) / (draws.length - 1));
  });
  const varying = se.map(s => s !== null && s > 1e-12);
  const maxT = new Array<number>(options.draws);
  for (let d = 0; d < options.draws; d++) {
    let t = 0;
    for (let m = 0; m < members.length; m++) if (varying[m]) t = Math.max(t, Math.abs(boot[m]![d]! - deltas[m]!) / se[m]!);
    maxT[d] = t;
  }
  maxT.sort((x, y) => x - y);
  const k = varying.filter(Boolean).length;
  const critical = k ? maxT[Math.ceil(level * options.draws) - 1]! : null;
  return {
    ...base,
    critical_value: critical,
    bonferroni_critical_value: bonferroni(k || members.length),
    members: members.map((m, i) => ({
      id: m.id, delta: deltas[i]!, se_boot: se[i]!,
      ci: se[i] === null ? null : varying[i] && critical !== null ? [deltas[i]! - critical * se[i]!, deltas[i]! + critical * se[i]!] : [deltas[i]!, deltas[i]!],
    })),
  };
}

/**
 * Fieller's interval for the ratio of two independent estimates, each given as an estimate with a two-sided interval
 * at the same level (its standard error read as the interval's width over 2z). Null bounds when the denominator's
 * interval is too close to zero for the ratio to be bounded.
 */
export function fiellerRatio(num: { estimate: number; lo: number; hi: number }, den: { estimate: number; lo: number; hi: number }, level = 0.95): { estimate: number | null; lo: number | null; hi: number | null } {
  const z = normalQuantile(1 - (1 - level) / 2);
  const a = num.estimate, b = den.estimate;
  const sa = (num.hi - num.lo) / (2 * z), sb = (den.hi - den.lo) / (2 * z);
  const estimate = b !== 0 ? a / b : null;
  const qa = b * b - z * z * sb * sb, qb = -2 * a * b, qc = a * a - z * z * sa * sa;
  const disc = qb * qb - 4 * qa * qc;
  if (!(qa > 0) || disc < 0) return { estimate, lo: null, hi: null };
  const root = Math.sqrt(disc);
  return { estimate, lo: (-qb - root) / (2 * qa), hi: (-qb + root) / (2 * qa) };
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

/**
 * One-sided cluster sign-flip p-value for superiority by more than `minEffect`
 * (in metric units, oriented so a larger value is better). The unit of
 * randomization is the cluster, as in clusteredPairedDelta: each cluster's
 * oriented summed difference, less `minEffect` times its item count, keeps or
 * flips its sign, and p is the share of sign patterns whose mean is at least
 * the observed one. That tests H0: delta <= minEffect at its boundary; with
 * `minEffect` 0 it is the test behind p_greater (p_less for 'lower'), though
 * above 20 clusters the two are separate Monte Carlo estimates of it and can
 * differ by Monte Carlo error. Up to 20 clusters all 2^clusters patterns are
 * enumerated, so p is exact and never below 2^-clusters; above that p is
 * (k + 1) / (draws + 1) over `draws` patterns drawn from the recorded seed,
 * with a Monte Carlo standard error of at most 0.5 / sqrt(draws). Null with
 * fewer than two clusters.
 */
export function superiorityP(stats: PairedDelta, minEffect: number, direction: 'higher' | 'lower'): number | null {
  if (!finite(minEffect) || minEffect < 0) throw new Error('superiority minimum effect must be a finite number >= 0');
  const { sums, counts, seed, draws } = stats.sign_flip;
  const g = sums.length;
  if (g < 2) return null;
  const sign = direction === 'higher' ? 1 : -1;
  const shifted = sums.map((s, j) => sign * s - minEffect * counts[j]);
  const observed = shifted.reduce((s, x) => s + x, 0) / stats.n_pairs;
  const exact = g <= EXACT_CLUSTER_LIMIT;
  const patterns = exact ? 2 ** g : draws;
  const rng = seededRandom(seed);
  let atLeast = 0;
  for (let i = 0; i < patterns; i++) {
    let sum = 0;
    for (let j = 0; j < g; j++) {
      const flip = exact ? ((i >>> j) & 1) === 1 : rng() < 0.5;
      sum += flip ? -shifted[j] : shifted[j];
    }
    if (sum / stats.n_pairs >= observed - 1e-12) atLeast++;
  }
  return exact ? atLeast / patterns : (atLeast + 1) / (patterns + 1);
}
