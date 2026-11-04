/**
 * Audit of 2026-11-04 (GST-1373): every published superiority p that came from the old \`superiorityP\` (the share of
 * cluster-bootstrap draws at or below \`min_effect\`), recomputed as the exact one-sided cluster sign-flip p at the same
 * unit of randomization, minimum effect and direction. Keyless, no model call, reads only files in this repository
 * (gbrain's dev verdicts come from the gbrain package \`package.json\` pins).
 *
 *   bun docs/audit/2026-11-04-superiority-p/recompute.ts > docs/audit/2026-11-04-superiority-p/results.json
 *
 * Three kinds of input:
 *   rows      per-question rows are committed: re-pair them as eval:compare does, then enumerate the sign-flip
 *             distribution exactly (all 2^g patterns up to 20 clusters, otherwise an exact convolution over the
 *             distinct cluster values, which these binary per-question metrics allow).
 *   recorded  only the comparison's recorded stats are committed. For min_effect 0 the exact p is the recorded
 *             sign-flip p_greater (p_less for "lower"): exact up to 20 clusters, a 10,000-draw Monte Carlo estimate
 *             above that. For min_effect > 0 we give a Hoeffding upper bound from the recorded cluster-robust SE.
 *   custody   held-out aggregates whose rows stay with the custodian: a Hoeffding upper bound from the published means
 *             (metrics in [0, 1]) and, for reference, a normal approximation from the published interval. A 0/1
 *             metric with one item per cluster whose baseline is 0 on every item (or candidate 1 on every item) has
 *             its paired differences fixed by the published means, so its exact p follows from them.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clusteredPairedDelta, holmAdjusted, pairObservations, superiorityP, type PairedDelta } from '../../../eval/runner/stats/paired.ts';
import { toObservation, type Row } from '../../../eval/runner/stats/rows.ts';
import { type ComparisonFamily } from '../../../eval/runner/stats/gates.ts';

const REPO = resolve(import.meta.dir, '../../..');
const read = (p: string) => JSON.parse(readFileSync(join(REPO, p), 'utf8'));
const ndjson = (p: string): Row[] => readFileSync(join(REPO, p), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

/** The function this audit replaces, verbatim from eval/runner/stats/paired.ts before 2026-11-04. */
function bootstrapShareP(stats: PairedDelta, minEffect: number, direction: 'higher' | 'lower'): number | null {
  if (!stats.bootstrap.length) return null;
  const sign = direction === 'higher' ? 1 : -1;
  const draws = stats.bootstrap.length;
  if (draws === 1) return sign * stats.bootstrap[0] > minEffect ? 0 : 1;
  let atOrBelow = 0;
  for (const d of stats.bootstrap) if (sign * d <= minEffect + 1e-12) atOrBelow++;
  return (atOrBelow + 1) / (draws + 1);
}

/** Exact P(sum of eps_c * v_c >= sum of v_c) over independent fair signs, by convolution over distinct values. */
function exactSignFlip(values: number[]): number {
  const SCALE = 1e6;
  const ints = values.map(v => Math.round(v * SCALE));
  if (values.some((v, i) => Math.abs(v * SCALE - ints[i]) > 1e-3)) throw new Error('cluster values are not on a 1e-6 lattice');
  const groups = new Map<number, number>();
  for (const v of ints) if (v !== 0) groups.set(Math.abs(v), (groups.get(Math.abs(v)) ?? 0) + 1);
  let dist = new Map<number, number>([[0, 1]]);
  for (const [v, count] of groups) {
    const next = new Map<number, number>();
    let b = 0.5 ** count;
    const binom: number[] = [];
    for (let i = 0; i <= count; i++) { binom.push(b); b = b * (count - i) / (i + 1); }
    for (const [s, p] of dist) for (let i = 0; i <= count; i++) {
      const key = s + v * (2 * i - count);
      next.set(key, (next.get(key) ?? 0) + p * binom[i]);
    }
    dist = next;
  }
  const observed = ints.reduce((s, v) => s + v, 0);
  let tail = 0;
  for (const [s, p] of dist) if (s >= observed) tail += p;
  return Math.min(1, tail);
}

const oriented = (stats: PairedDelta, minEffect: number, direction: 'higher' | 'lower') =>
  stats.sign_flip.sums.map((s, j) => (direction === 'higher' ? s : -s) - minEffect * stats.sign_flip.counts[j]);

type Status = 'pass' | 'fail' | 'inconclusive';
function status(ci: [number, number] | null, clusters: number, direction: 'higher' | 'lower', pHolm: number, alpha: number, minClusters: number, boundary = 0): Status {
  const sign = direction === 'higher' ? 1 : -1;
  const upper = ci ? Math.max(sign * ci[0], sign * ci[1]) : null;
  if (upper !== null && upper < boundary) return 'fail';
  if (clusters < minClusters) return 'inconclusive';
  return pHolm <= alpha ? 'pass' : 'inconclusive';
}
const familyVerdict = (s: Status[]) => s.includes('fail') ? 'fail' : s.includes('inconclusive') ? 'inconclusive' : 'pass';

/** Hoeffding: P(sum eps_c a_c >= t) <= exp(-t^2 / (2 sum a_c^2)) for independent fair signs. */
const hoeffding = (t: number, sumSq: number) => (t <= 0 ? 1 : Math.min(1, Math.exp(-(t * t) / (2 * sumSq))));
/** One-sided normal tail, Abramowitz-Stegun 26.2.17 (|error| < 7.5e-8). */
function normalTail(z: number): number {
  if (z < 0) return 1 - normalTail(-z);
  const t = 1 / (1 + 0.2316419 * z);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * poly;
}

// ---- 1. Rows on main ----------------------------------------------------------------------------------------------
const ROW_SOURCES = [
  { result: 'W10a current pin vs 2026-09-29 retrieval (Sonnet 5.5 reader, official judge)', doc: 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md',
    family: 'docs/benchmarks/2026-10-06-longmemeval-w10-families/w10a-official.json', a: 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/compare-w10a-a.ndjson',
    b: 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/compare-w10a-b.ndjson', summary: 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/summary.json' },
  { result: 'W10b reader replay against Sonnet 4.6 (official judge, Holm across six arms)', doc: 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md',
    family: 'docs/benchmarks/2026-10-06-longmemeval-w10-families/w10b-official.json', a: 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay/compare-w10b-official-a.ndjson',
    b: 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay/compare-w10b-official-b.ndjson', summary: 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay/summary.json' },
  { result: 'W10c whole history better than gbrain by more than 7 points (Holm across two readers)', doc: 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context.md',
    family: 'docs/benchmarks/2026-10-06-longmemeval-w10-families/w10c-loss.json', a: 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/compare-w10c-loss-a.ndjson',
    b: 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/compare-w10c-loss-b.ndjson', summary: 'docs/benchmarks/2026-10-07-longmemeval-w10c-full-context/summary.json' },
];

function publishedComparisons(summary: unknown, familyId: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    if (o.family_id === familyId && Array.isArray(o.comparisons)) found.push(...(o.comparisons as Array<Record<string, unknown>>));
    else Object.values(o).forEach(walk);
  };
  walk(summary);
  return found;
}

const rowResults = ROW_SOURCES.map(src => {
  const family = read(src.family) as ComparisonFamily;
  const aRows = ndjson(src.a), bRows = ndjson(src.b);
  const published = publishedComparisons(read(src.summary), family.family_id);
  const confirmatory = family.comparisons.filter(c => c.gate === 'superiority') as Array<Extract<ComparisonFamily['comparisons'][number], { gate: 'superiority' }>>;
  const rows = confirmatory.map(spec => {
    const sel = { idField: family.id_field, metric: spec.metric, clusterBy: spec.cluster_by, excludeWhen: family.exclude_when };
    const { pairs } = pairObservations(aRows.map(r => toObservation(r, sel)), bRows.map(r => toObservation(r, sel)));
    const stats = clusteredPairedDelta(pairs, { seed: family.seed, draws: family.draws });
    const pub = published.find(c => c.id === spec.id);
    const wins = pairs.filter(p => p.b > p.a).length, losses = pairs.filter(p => p.b < p.a).length;
    return { id: spec.id, spec, stats, units: stats.n_clusters, n_pairs: stats.n_pairs, unit: spec.cluster_by, min_effect: spec.min_effect, direction: spec.direction,
      wins, losses, old_p: bootstrapShareP(stats, spec.min_effect, spec.direction)!, published_old_p: (pub?.p_superiority as number | undefined) ?? null,
      published_old_holm: (pub?.p_holm as number | undefined) ?? null, published_old_status: (pub?.status as string | undefined) ?? null,
      exact_p: exactSignFlip(oriented(stats, spec.min_effect, spec.direction)), gate_p: superiorityP(stats, spec.min_effect, spec.direction)! };
  });
  const oldHolm = holmAdjusted(rows.map(r => r.old_p));
  const exactHolm = holmAdjusted(rows.map(r => r.exact_p));
  const gateHolm = holmAdjusted(rows.map(r => r.gate_p));
  const minClusters = family.min_clusters ?? 10;
  const out = rows.map((r, i) => {
    const oldStatus = status(r.stats.ci95, r.units, r.direction, oldHolm[i], family.alpha, minClusters);
    const exactStatus = status(r.stats.ci95, r.units, r.direction, exactHolm[i], family.alpha, minClusters);
    const gateStatus = status(r.stats.ci95, r.units, r.direction, gateHolm[i], family.alpha, minClusters);
    const { stats: _s, spec: _sp, ...rest } = r;
    return { ...rest, old_holm: oldHolm[i], exact_holm: exactHolm[i], gate_holm: gateHolm[i], old_status: oldStatus, exact_status: exactStatus, gate_status: gateStatus,
      gate_mc_se: r.units > 20 ? Math.sqrt(r.exact_p * (1 - r.exact_p) / family.draws) : 0 };
  });
  return { result: src.result, doc: src.doc, family: src.family, family_id: family.family_id, alpha: family.alpha, draws: family.draws, seed: family.seed,
    old_verdict: familyVerdict(out.map(o => o.old_status)), exact_verdict: familyVerdict(out.map(o => o.exact_status)), comparisons: out };
});

// W10b's published sensitivity: Holm over the five arms without Fable.
const w10b = rowResults[1];
const noFable = w10b.comparisons.filter(c => !c.id.startsWith('correct__fable'));
const sensitivity = { result: 'W10b sensitivity: Holm over five arms without Fable (report-only)', doc: w10b.doc,
  arms: noFable.map((c, i) => ({ id: c.id, old_holm: holmAdjusted(noFable.map(x => x.old_p))[i], exact_holm: holmAdjusted(noFable.map(x => x.exact_p))[i] })) };

// ---- 2. Recorded stats (eval:decide dev verdicts) -----------------------------------------------------------------
const GBRAIN_DECISIONS = 'node_modules/gbrain/docs/eval/decisions';
const DEV_DECISIONS = ['p1-dev-2026-10-04', 'p1-dev-2026-10-04-r2', 'p2-attribution-dev', 'p2-date-grounding-dev', 'p6-think-dates', 'p6-think-notes'];
const OUR_VERDICTS = ['docs/benchmarks/2026-10-06-beam-1m-dates'];
const recorded = [...DEV_DECISIONS.map(d => join(GBRAIN_DECISIONS, d)), ...OUR_VERDICTS].map(dir => {
  const decision = read(join(dir, 'decision.json'));
  const verdict = read(join(dir, 'verdict.json'));
  const sources = (verdict.sources as Array<Record<string, any>>).map((src, si) => {
    const spec = decision.sources[si];
    const family = src.family;
    const unstated = !family || (family.comparisons as Array<Record<string, any>>).some(c => (c.gate === 'superiority' || c.gate === 'noninferiority') && !c.stats);
    if (unstated) return { source: spec.id, old_verdict: src.verdict, exact_verdict: src.verdict, comparisons: [] };
    const minClusters = spec.min_clusters ?? 10;
    const conf = (family.comparisons as Array<Record<string, any>>).filter(c => c.gate === 'superiority' || c.gate === 'noninferiority');
    const pNew = conf.map(c => {
      if (c.gate === 'noninferiority') return { p: c.p_noninferiority ?? 1, method: 'unchanged (nonInferiorityP)' };
      const s = c.stats;
      if (s.p_method === 'degenerate') return { p: 1, method: 'degenerate: every paired difference is 0 or fewer than two clusters' };
      if (c.min_effect === 0) return { p: c.direction === 'higher' ? s.p_greater : s.p_less, method: s.p_method === 'exact-sign-flip' ? 'exact (recorded sign-flip p)' : 'recorded Monte Carlo sign-flip p, 10,000 draws (MC SE <= 0.005)' };
      const k = s.n_pairs / s.n_clusters;
      if (!Number.isInteger(k)) throw new Error(c.id + ': unequal cluster sizes');
      const centered = (s.se_cluster * s.n_pairs) ** 2 * (s.n_clusters - 1) / s.n_clusters;
      const shift = (c.direction === 'higher' ? s.delta : -s.delta) - c.min_effect;
      return { p: hoeffding(s.n_pairs * shift, centered + shift * shift * s.n_clusters * k * k), method: 'Hoeffding upper bound from the recorded cluster SE (equal clusters of ' + k + ')' };
    });
    const holm = holmAdjusted(pNew.map(x => x.p));
    const comparisons = conf.map((c, i) => {
      const s = c.stats;
      const newStatus = status(s.ci95, c.n_clusters, c.direction, holm[i], family.alpha, minClusters, c.gate === 'noninferiority' ? -c.tolerance : 0);
      return { id: c.id, gate: c.gate, units: c.n_clusters, unit: spec.comparisons?.find((x: any) => x.id === c.id)?.cluster_by ?? null, min_effect: c.min_effect ?? c.tolerance,
        direction: c.direction, old_p: c.gate === 'superiority' ? c.p_superiority : c.p_noninferiority, old_holm: c.p_holm, new_p: pNew[i].p, new_p_method: pNew[i].method, new_holm: holm[i],
        old_status: c.status, new_status: newStatus };
    });
    const others = (family.comparisons as Array<Record<string, any>>).filter(c => c.gate === 'exact').map(c => c.status as Status);
    const exactVerdict = conf.length ? familyVerdict([...others, ...comparisons.map(c => c.new_status as Status)]) : src.verdict;
    return { source: spec.id, old_verdict: src.verdict, exact_verdict: exactVerdict, comparisons: comparisons.filter(c => c.gate === 'superiority' || c.old_status !== c.new_status) };
  });
  const order = ['invalid', 'blocked', 'fail', 'inconclusive'];
  const combine = (vs: string[]) => order.find(o => vs.includes(o)) ?? (vs.every(v => v === 'report_only') ? 'report_only' : 'pass');
  return { decision: verdict.decision_id, path: dir, old_overall: verdict.overall, exact_overall: combine(sources.map(s => s.exact_verdict)), sources: sources.filter(s => s.comparisons.length) };
}).filter(d => d.sources.length);

// ---- 3. Custody aggregates ----------------------------------------------------------------------------------------
const HELD = 'docs/benchmarks/2026-10-05-heldout-verdicts';
const P1_MIN: Record<string, number> = { 'now-precision': 0.1, asof: 0.15, during: 0.15, correction: 0.2 };
/** correction_ok is Number(boolean) in eval/runner/temporal-edges.ts; the other P1 and H7 metrics are not per-item 0/1 with one item per cluster. */
const BINARY = new Set(['correction']);
const CUSTODY = [
  { result: 'P1 E1 round 2 held-out (set C), verdict pass', file: 'p1-e1-r2-heldout-2026-10-04.json', path: ['comparisons'], min: P1_MIN, confirmatory: 6, decides: true },
  { result: 'P1 E1 set E (reported after the exact trap gate failed)', file: 'p1-e1-sete-2026-10-05.json', path: ['comparisons_reported_after_the_exact_gate_failed'], min: P1_MIN, confirmatory: 6, decides: false },
  { result: 'P5 delta H7 validity ranges, range pages', file: 'p5-delta-heldout-2026-10-05.json', path: ['H7', 'range_pages', 'comparisons'], min: { asof: 0.1 } as Record<string, number>, confirmatory: 2, decides: true },
  { result: 'P5 set G, P1 superiority against 6622a119e (report-only)', file: 'p5-delta-set-g-2026-10-05.json', path: ['p1_superiority_vs_6622a119e_report'], min: P1_MIN, confirmatory: 6, decides: false },
];
const custody = CUSTODY.map(src => {
  let node: any = read(join(HELD, src.file));
  for (const k of src.path) node = node[k];
  const comparisons = (node as Array<Record<string, any>>).filter(c => c.gate === 'superiority').map(c => {
    const m = src.min[c.id];
    const k = c.n / c.clusters;
    const reach = Math.min(1, c.a + c.b, 2 - c.a - c.b);
    const perItem = Math.max(0, reach - 2 * m * c.delta + m * m);
    const bound = hoeffding(c.n * (c.delta - m), k * c.n * perItem);
    const se = (c.ci95[1] - c.ci95[0]) / (2 * 1.959964);
    const approx = normalTail(c.n * (c.delta - m) / Math.sqrt((se * c.n) ** 2 + (c.delta - m) ** 2 * c.clusters * k * k));
    const fixed = BINARY.has(c.id) && k === 1 && (c.a === 0 || c.b === 1);
    const gains = fixed ? Math.round((c.b - c.a) * c.n) : 0;
    const exact = fixed ? exactSignFlip([...Array(gains).fill(1 - m), ...Array(c.n - gains).fill(-m)]) : null;
    return { id: c.id, units: c.clusters, n: c.n, min_effect: m, delta: c.delta, ci95: c.ci95, old_status: c.status, exact_p: exact,
      exact_p_upper_bound: bound, bonferroni_bound: Math.min(1, bound * src.confirmatory), exact_p_normal_approx: approx, holm_approx_worst: Math.min(1, approx * src.confirmatory) };
  });
  return { result: src.result, file: join(HELD, src.file), rows: 'in custody, not published', decides_verdict: src.decides, comparisons };
});

console.log(JSON.stringify({ generated_by: 'docs/audit/2026-11-04-superiority-p/recompute.ts', rows: rowResults, w10b_sensitivity: sensitivity, recorded, custody }, null, 2));
