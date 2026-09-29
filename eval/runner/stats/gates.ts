/**
 * Three-gate comparison policy over a preregistered family (plan amendment 4).
 *
 *   exact           Correctness and safety assertions. One violating item
 *                   fails the comparison at once. No significance test runs,
 *                   and no p-value can waive the failure. When any exact gate
 *                   fails, the statistical gates are not run.
 *   noninferiority  Noisy quality metrics. B passes only when it is shown to
 *                   be no worse than A by more than the stated tolerance:
 *                   the Holm-adjusted one-sided p-value is at or below alpha
 *                   (equivalently, the lower interval bound clears
 *                   -tolerance). Failing to find a difference is not proof of
 *                   equivalence, so a wide interval is "inconclusive", not a
 *                   pass. An interval entirely below -tolerance is a fail.
 *   exploratory     Dashboards. Reported with intervals and unadjusted
 *                   p-values, and never part of the verdict.
 *
 * Holm correction covers the noninferiority comparisons, the family's
 * confirmatory tests. The family file is written before the runs it judges;
 * comparisons outside it can only be exploratory.
 */
import { readFileSync } from 'node:fs';
import {
  clusteredPairedDelta, exactMcNemar, holmAdjusted, nonInferiorityP, pairObservations, PairingError, powerNote,
  type McNemarResult, type PairedDelta, type PowerNote,
} from './paired.ts';
import { toObservation, type Row } from './rows.ts';

export type Direction = 'higher' | 'lower';
export type ExactAssertion =
  | { kind: 'every_b_equals'; value: number }
  | { kind: 'b_at_most'; value: number }
  | { kind: 'b_at_least'; value: number }
  | { kind: 'no_item_regression'; direction: Direction };

export type ComparisonSpec =
  | { id: string; metric: string; gate: 'exact'; assertion: ExactAssertion; cluster_by?: string; description?: string }
  | { id: string; metric: string; gate: 'noninferiority'; direction: Direction; tolerance: number; cluster_by: string; description?: string }
  | { id: string; metric: string; gate: 'exploratory'; direction?: Direction; cluster_by?: string; description?: string };

export interface ComparisonFamily {
  schema_version: 1;
  family_id: string;
  /** ISO date the family was fixed, before the runs it judges. */
  registered_at: string;
  description?: string;
  alpha: number;
  seed: number;
  draws: number;
  /** Fewer clusters than this makes a noninferiority result inconclusive. Default 10. */
  min_clusters?: number;
  id_field: string;
  exclude_when?: string[];
  comparisons: ComparisonSpec[];
}

export type GateStatus = 'pass' | 'fail' | 'inconclusive' | 'report_only' | 'skipped' | 'blocked';

export interface ComparisonResult {
  id: string;
  metric: string;
  gate: ComparisonSpec['gate'];
  status: GateStatus;
  reasons: string[];
  n_pairs?: number;
  n_clusters?: number;
  n_excluded?: number;
  stats?: Omit<PairedDelta, 'bootstrap'>;
  mcnemar?: McNemarResult;
  power?: PowerNote;
  tolerance?: number;
  direction?: Direction;
  p_noninferiority?: number | null;
  p_holm?: number;
  violations?: string[];
}

export interface FamilyDecision {
  family_id: string;
  verdict: 'pass' | 'fail' | 'inconclusive' | 'blocked' | 'report_only';
  reasons: string[];
  alpha: number;
  holm_family: string[];
  comparisons: ComparisonResult[];
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;

export function validateFamily(value: unknown): ComparisonFamily {
  const f = value as ComparisonFamily;
  const problems: string[] = [];
  if (!f || typeof f !== 'object') throw new Error('family must be a JSON object');
  const allowed = ['schema_version', 'family_id', 'registered_at', 'description', 'alpha', 'seed', 'draws', 'min_clusters', 'id_field', 'exclude_when', 'comparisons'];
  for (const key of Object.keys(f)) if (!allowed.includes(key)) problems.push(`unknown family field ${key}`);
  if (f.schema_version !== 1) problems.push('schema_version must be 1');
  if (!text(f.family_id)) problems.push('family_id required');
  if (!text(f.registered_at) || !Number.isFinite(Date.parse(f.registered_at))) problems.push('registered_at must be an ISO date');
  if (!finite(f.alpha) || f.alpha <= 0 || f.alpha >= 0.5) problems.push('alpha must be in (0, 0.5)');
  if (!Number.isSafeInteger(f.seed)) problems.push('seed must be an integer');
  if (!Number.isSafeInteger(f.draws) || f.draws < 1000) problems.push('draws must be an integer >= 1000');
  if (f.min_clusters !== undefined && (!Number.isSafeInteger(f.min_clusters) || f.min_clusters < 2)) problems.push('min_clusters must be an integer >= 2');
  if (!text(f.id_field)) problems.push('id_field required');
  if (f.exclude_when !== undefined && (!Array.isArray(f.exclude_when) || !f.exclude_when.every(r => text(r) && r.indexOf('=') > 0))) problems.push('exclude_when must be field=value rules');
  if (!Array.isArray(f.comparisons) || !f.comparisons.length) problems.push('comparisons must be a nonempty array');
  const ids = new Set<string>();
  for (const c of Array.isArray(f.comparisons) ? f.comparisons : []) {
    const label = `comparison ${c?.id ?? '?'}`;
    if (!text(c?.id) || ids.has(c.id)) problems.push(`${label}: id missing or duplicated`);
    ids.add(c?.id);
    if (!text(c?.metric)) problems.push(`${label}: metric required`);
    if (c?.gate === 'exact') {
      const a = c.assertion as ExactAssertion | undefined;
      if (!a || !['every_b_equals', 'b_at_most', 'b_at_least', 'no_item_regression'].includes(a.kind)) problems.push(`${label}: exact gate needs an assertion`);
      else if (a.kind === 'no_item_regression' ? !['higher', 'lower'].includes(a.direction) : !finite(a.value)) problems.push(`${label}: assertion needs ${a.kind === 'no_item_regression' ? 'a direction' : 'a finite value'}`);
    } else if (c?.gate === 'noninferiority') {
      if (!['higher', 'lower'].includes(c.direction)) problems.push(`${label}: direction must be higher or lower`);
      if (!finite(c.tolerance) || c.tolerance < 0) problems.push(`${label}: tolerance must be a finite number >= 0, in metric units`);
      if (!text(c.cluster_by)) problems.push(`${label}: cluster_by must be preregistered (use the id field when items are independent)`);
    } else if (c?.gate === 'exploratory') {
      if (c.direction !== undefined && !['higher', 'lower'].includes(c.direction)) problems.push(`${label}: direction must be higher or lower`);
    } else problems.push(`${label}: gate must be exact, noninferiority or exploratory`);
  }
  if (problems.length) throw new Error(`invalid comparison family: ${problems.join('; ')}`);
  return f;
}

export function loadFamily(path: string): ComparisonFamily {
  return validateFamily(JSON.parse(readFileSync(path, 'utf8')));
}

function strip(stats: PairedDelta): Omit<PairedDelta, 'bootstrap'> {
  const { bootstrap: _bootstrap, ...rest } = stats;
  return rest;
}

function exactViolations(assertion: ExactAssertion, pairs: Array<{ id: string; a: number; b: number }>): string[] {
  const sign = assertion.kind === 'no_item_regression' && assertion.direction === 'lower' ? -1 : 1;
  return pairs.filter(p => {
    switch (assertion.kind) {
      case 'every_b_equals': return p.b !== assertion.value;
      case 'b_at_most': return p.b > assertion.value;
      case 'b_at_least': return p.b < assertion.value;
      case 'no_item_regression': return sign * (p.b - p.a) < 0;
    }
  }).map(p => `${p.id} (A=${p.a}, B=${p.b})`);
}

export function evaluateFamily(aRows: readonly Row[], bRows: readonly Row[], family: ComparisonFamily): FamilyDecision {
  validateFamily(family);
  const minClusters = family.min_clusters ?? 10;
  const pair = (spec: ComparisonSpec) => {
    const selection = { idField: family.id_field, metric: spec.metric, clusterBy: spec.cluster_by, excludeWhen: family.exclude_when };
    return pairObservations(aRows.map(r => toObservation(r, selection)), bRows.map(r => toObservation(r, selection)));
  };
  const results: ComparisonResult[] = [];
  const blocked: string[] = [];
  const paired = new Map<string, ReturnType<typeof pair>>();
  for (const spec of family.comparisons) {
    try { paired.set(spec.id, pair(spec)); }
    catch (error) {
      const problems = error instanceof PairingError ? error.problems : [String(error)];
      blocked.push(`${spec.id}: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`);
      results.push({ id: spec.id, metric: spec.metric, gate: spec.gate, status: 'blocked', reasons: problems });
    }
  }
  const holmFamily = family.comparisons.filter(c => c.gate === 'noninferiority').map(c => c.id);
  if (blocked.length) {
    for (const spec of family.comparisons) if (!results.some(r => r.id === spec.id)) {
      results.push({ id: spec.id, metric: spec.metric, gate: spec.gate, status: 'skipped', reasons: ['another comparison in the family is blocked'] });
    }
    return { family_id: family.family_id, verdict: 'blocked', reasons: blocked, alpha: family.alpha, holm_family: holmFamily, comparisons: order(results, family) };
  }

  const exactFailures: string[] = [];
  for (const spec of family.comparisons) {
    if (spec.gate !== 'exact') continue;
    const { pairs, excluded } = paired.get(spec.id)!;
    const violations = exactViolations(spec.assertion, pairs);
    const result: ComparisonResult = { id: spec.id, metric: spec.metric, gate: 'exact', status: violations.length ? 'fail' : 'pass',
      reasons: violations.length ? [`${violations.length} of ${pairs.length} items violate ${spec.assertion.kind}; no significance test applies`] : [],
      n_pairs: pairs.length, n_excluded: excluded.length, ...(violations.length ? { violations: violations.slice(0, 50) } : {}) };
    if (violations.length) exactFailures.push(`${spec.id}: ${result.reasons[0]}`);
    results.push(result);
  }
  if (exactFailures.length) {
    for (const spec of family.comparisons) if (spec.gate !== 'exact') {
      results.push({ id: spec.id, metric: spec.metric, gate: spec.gate, status: 'skipped', reasons: ['an exact correctness or safety gate failed first'] });
    }
    return { family_id: family.family_id, verdict: 'fail', reasons: exactFailures, alpha: family.alpha, holm_family: holmFamily, comparisons: order(results, family) };
  }

  const statistical: Array<{ spec: Extract<ComparisonSpec, { gate: 'noninferiority' | 'exploratory' }>; stats: PairedDelta; result: ComparisonResult }> = [];
  for (const spec of family.comparisons) {
    if (spec.gate === 'exact') continue;
    const { pairs, excluded } = paired.get(spec.id)!;
    const stats = clusteredPairedDelta(pairs, { seed: family.seed, draws: family.draws });
    const binary = pairs.every(p => (p.a === 0 || p.a === 1) && (p.b === 0 || p.b === 1));
    const result: ComparisonResult = { id: spec.id, metric: spec.metric, gate: spec.gate, status: 'report_only', reasons: [],
      n_pairs: pairs.length, n_clusters: stats.n_clusters, n_excluded: excluded.length, stats: strip(stats),
      ...(binary ? { mcnemar: exactMcNemar(pairs) } : {}), power: powerNote(stats, { alpha: family.alpha, binary }),
      ...(spec.direction ? { direction: spec.direction } : {}) };
    if (binary && stats.n_clusters < stats.n_pairs) result.reasons.push('McNemar treats items as independent; the clustered sign-flip p-value is the primary test here');
    statistical.push({ spec, stats, result });
    results.push(result);
  }

  const ni = statistical.filter(s => s.spec.gate === 'noninferiority');
  const niP = ni.map(s => {
    const spec = s.spec as Extract<ComparisonSpec, { gate: 'noninferiority' }>;
    return nonInferiorityP(s.stats, spec.tolerance, spec.direction);
  });
  const adjusted = holmAdjusted(niP.map(p => p ?? 1));
  const reasons: string[] = [];
  ni.forEach((s, i) => {
    const spec = s.spec as Extract<ComparisonSpec, { gate: 'noninferiority' }>;
    const r = s.result;
    r.tolerance = spec.tolerance;
    r.p_noninferiority = niP[i];
    r.p_holm = adjusted[i];
    const sign = spec.direction === 'higher' ? 1 : -1;
    const ci = s.stats.ci95;
    const orientedUpper = ci ? Math.max(sign * ci[0], sign * ci[1]) : null;
    if (orientedUpper !== null && orientedUpper < -spec.tolerance) {
      r.status = 'fail';
      r.reasons.push(`the whole 95% interval is worse than the tolerance of ${spec.tolerance}`);
    } else if (s.stats.n_clusters < minClusters) {
      r.status = 'inconclusive';
      r.reasons.push(`${s.stats.n_clusters} clusters is below the family minimum of ${minClusters}`);
    } else if (niP[i] !== null && adjusted[i] <= family.alpha) {
      r.status = 'pass';
    } else {
      r.status = 'inconclusive';
      r.reasons.push(`non-inferiority within ${spec.tolerance} not shown (Holm p = ${adjusted[i].toFixed(4)} > ${family.alpha}); this is not evidence of a regression or of equivalence`);
    }
    if (r.status !== 'pass') reasons.push(`${spec.id}: ${r.status}`);
  });
  const verdict: FamilyDecision['verdict'] = !ni.length && !family.comparisons.some(c => c.gate === 'exact') ? 'report_only'
    : ni.some(s => s.result.status === 'fail') ? 'fail'
    : ni.some(s => s.result.status === 'inconclusive') ? 'inconclusive' : 'pass';
  return { family_id: family.family_id, verdict, reasons, alpha: family.alpha, holm_family: holmFamily, comparisons: order(results, family) };
}

function order(results: ComparisonResult[], family: ComparisonFamily): ComparisonResult[] {
  return family.comparisons.map(c => results.find(r => r.id === c.id)!);
}
