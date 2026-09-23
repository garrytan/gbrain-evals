import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import inventory from '../regression/situation-recall-v1.json';
import { ProbeAccounting } from './probe-accounting.ts';
import { percentile } from './metrics.ts';
import { validateReceipt } from './receipt.ts';
import { executedCueLookup } from './situation-recall-observations.ts';
import type {
  RegressionArm, RegressionCellResult, RegressionCellSpec, RegressionComparison,
  RegressionCoverage, RegressionDecision, RegressionManifest, RegressionMetricSpec,
  RegressionProbeRow, RegressionProfile, RegressionReceiptData,
  RegressionObservationValue, RegressionNativeContract,
} from './situation-recall-contract.ts';

export type * from './situation-recall-contract.ts';
export { resolveRegressionProduct } from './situation-recall-provenance.ts';
export const SITUATION_RECALL_INVENTORY = inventory;

export function regressionHash(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
    const encoded = JSON.stringify(v);
    if (encoded === undefined || (typeof v === 'number' && !Number.isFinite(v))) throw new Error('non-JSON manifest value');
    return encoded;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const integer = (x: unknown): x is number => finite(x) && Number.isSafeInteger(x) && x >= 0;
const digest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const sha = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const identifier = (x: unknown): x is string => text(x) && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(x) && !['__proto__', 'constructor', 'prototype'].includes(x);
const ratio = (x: unknown): x is { numerator: number; denominator: number } => Boolean(x && typeof x === 'object'
  && same(Object.keys(x).sort(), ['denominator', 'numerator']) && finite((x as { numerator?: unknown }).numerator)
  && integer((x as { denominator?: unknown }).denominator)
  && ((x as { denominator: number }).denominator !== 0 || (x as { numerator: number }).numerator === 0));
const numericValue = (x: RegressionObservationValue, metric?: RegressionMetricSpec): number => typeof x === 'number' ? x
  : x.denominator === 0 ? metric?.zero_denominator === 1 ? 1 : 0 : x.numerator / x.denominator;
const unique = (xs: string[]) => new Set(xs).size === xs.length;
const same = (a: unknown, b: unknown) => regressionHash(a) === regressionHash(b);
const time = (x: unknown) => typeof x === 'string' ? Date.parse(x) : NaN;
const inside = (parent: string, child: string) => {
  const r = relative(parent, child);
  return r !== '' && r !== '..' && !r.startsWith('../') && !isAbsolute(r);
};
const profileArms = (category: typeof inventory.categories[number], id: string): RegressionArm[] =>
  category.cue_eligible && !(('compatibility_profiles' in category ? category.compatibility_profiles : []) ?? []).includes(id)
    ? ['B', 'C0', 'C1'] : ['B', 'C0'];

export function inspectRegressionRunnerTree(root = process.cwd()): string[] {
  const known = new Set([...inventory.categories.flatMap(c => c.runner ? [c.runner] : []), ...inventory.auxiliary_category_files]);
  const issues: string[] = [];
  if (!existsSync(join(root, 'eval/runner'))) return [`runner tree unavailable: ${root}`];
  for (const name of readdirSync(join(root, 'eval/runner'))) {
    const path = `eval/runner/${name}`;
    if (/^cat\d+[a-z]?-.*\.ts$/.test(name) && !known.has(path)) issues.push(`untriaged category runner: ${path}`);
  }
  for (const category of inventory.categories) {
    if (category.runner && !existsSync(join(root, category.runner))) issues.push(`missing runner: ${category.id}:${category.runner}`);
    if (!category.runner) issues.push(`unsupported prerequisite: ${category.id}: ${'blocked_reason' in category ? category.blocked_reason : 'runner absent'}`);
    for (const id of category.profiles) {
      const runner = nativeRegressionContract({ id, category: category.id })?.runner;
      if (typeof runner === 'string' && !existsSync(join(root, runner))) issues.push(`missing registered profile runner: ${id}:${runner}`);
    }
    if ('supplementary_runner' in category && typeof category.supplementary_runner === 'string' && !existsSync(join(root, category.supplementary_runner))) issues.push(`missing supplementary runner: ${category.supplementary_runner}`);
  }
  return issues;
}

export function inspectRegressionInventory(root = process.cwd()): string[] {
  const issues = inspectRegressionRunnerTree(root);
  for (const category of inventory.categories) {
    for (const id of category.profiles) {
      const contract = nativeRegressionContract({ id, category: category.id });
      if (!contract) issues.push(`unmapped native metrics/floors/slices: ${id}`);
      else for (const blocker of contract.evidence_blockers ?? []) issues.push(`native evidence prerequisite: ${id}: ${blocker}`);
    }
  }
  return issues;
}

export function profileBudget(profile: RegressionProfile): number {
  return profile.budget.construction_usd + profile.budget.embedding_usd + profile.budget.reranking_usd
    + profile.budget.judging_usd + profile.budget.agent_usd;
}

export function effectiveRegressionConfig(profile: RegressionProfile, arm: RegressionArm): Record<string, string> {
  return {
    ...profile.config,
    ...(arm === 'C1' ? profile.cue_config : {}),
    'memory.cues.read': arm === 'C1' ? 'on' : 'off',
    'memory.cues.generation_enabled': arm === 'C1' ? 'true' : 'false',
  };
}

export function runtimeCueSourceIds(profile: RegressionProfile): string[] {
  return profile.cue_sources.map(id => profile.cue_source_bindings ? profile.cue_source_bindings[id] : id);
}

export function effectiveRegressionFileConfig(profile: RegressionProfile, cell: RegressionCellSpec): Record<string, unknown> {
  return { ...profile.file_config, database_path: cell.runtime.database };
}

export function validateRegressionManifest(manifest: RegressionManifest, options: { evalRoot?: string } = {}): string[] {
  const errors = validateRegressionRegistration(manifest);
  errors.push(...inspectRegressionRunnerTree(options.evalRoot));
  try {
    const root = resolve(options.evalRoot ?? process.cwd());
    const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const inspectedSha = git(['rev-parse', 'HEAD']);
    if (resolve(git(['rev-parse', '--show-toplevel'])) !== root) errors.push('runner inventory must inspect the registered eval repository root');
    if (inspectedSha !== manifest.eval_sha) errors.push('inspected runner tree does not match the registered eval SHA');
    if (git(['status', '--porcelain', '--untracked-files=all']) !== '') errors.push('inspected runner tree is dirty; release evidence requires a clean eval checkout');
  } catch { errors.push('inspected runner tree has no verifiable eval checkout identity'); }
  if (!Array.isArray(manifest?.profiles)) return errors;
  for (const profile of manifest.profiles) {
    try {
    const contract = nativeRegressionContract(profile);
    if (!contract) { errors.push(`${profile.id}: native metric/floor/slice mapping is not implemented; prerequisite blocked`); continue; }
    if (profile.native_contract_sha256 !== regressionHash(contract)) errors.push(`${profile.id}: native contract hash mismatch`);
    if (contract.mode !== 'either' && profile.mode !== contract.mode) errors.push(`${profile.id}: native execution mode mismatch`);
    if (profile.receipt_category !== contract.receipt_category) errors.push(`${profile.id}: native receipt category mismatch`);
    if (!same(profile.metrics, contract.metrics)) errors.push(`${profile.id}: native metric IDs/directions/floors changed`);
    if (!same(profile.native_constraints ?? [], contract.constraints ?? [])) errors.push(`${profile.id}: native cross-arm/slice constraints changed`);
    if (contract.required_slices.some(slice => !profile.required_slices.includes(slice))) errors.push(`${profile.id}: native slice missing`);
    if (contract.expected_probes && !same(profile.probes, contract.expected_probes)) errors.push(`${profile.id}: frozen native recipe probes/families/slices changed`);
    if (contract.frozen_recipe && (profile.native_hashes?.recipe !== contract.frozen_recipe.recipe_sha256
      || !profile.recipe_review?.reviewer.trim() || profile.recipe_review.recipe_sha256 !== contract.frozen_recipe.recipe_sha256)) errors.push(`${profile.id}: exact recipe hash and independent recipe approval required`);
    for (const blocker of contract.evidence_blockers ?? []) errors.push(`${profile.id}: native evidence prerequisite: ${blocker}`);
    } catch (error) { errors.push(`${profile?.id ?? 'unknown'}: malformed native contract registration: ${String(error)}`); }
  }
  return errors;
}

export function nativeRegressionContract(profile: Pick<RegressionProfile, 'id' | 'category'>): RegressionNativeContract | undefined {
  const contracts = inventory.native_contracts as unknown as Record<string, RegressionNativeContract>;
  return contracts[profile.id] ?? contracts[profile.category];
}

export function validateRegressionRegistration(manifest: RegressionManifest): string[] {
  const errors: string[] = [];
  try {
    if (manifest.schema_version !== 1 || !identifier(manifest.run_id)) errors.push('manifest schema/run ID invalid');
    if (!sha(manifest.eval_sha) || !sha(manifest.products.B.sha) || !sha(manifest.products.candidate.sha)
      || !sha(manifest.products.B.tree) || !sha(manifest.products.candidate.tree)) errors.push('exact eval/product commit/tree identities required');
    if ([manifest.products.B, manifest.products.candidate].some(p => p.package_sha256 !== undefined && !digest(p.package_sha256))) errors.push('invalid preregistered package content hash');
    if (manifest.inventory_sha256 !== regressionHash(inventory)) errors.push('inventory hash mismatch');
    if (!finite(time(manifest.registered_at)) || !finite(time(manifest.expires_at)) || time(manifest.expires_at) <= time(manifest.registered_at)) errors.push('invalid registration window');
    if (!finite(manifest.max_usd) || manifest.max_usd < 0) errors.push('invalid run budget');
    if (!integer(manifest.statistics.seed) || !integer(manifest.statistics.draws) || manifest.statistics.draws < 10000) errors.push('statistics require frozen seed and at least 10000 draws');
    if (!unique(manifest.profiles.map(p => p.id)) || !unique(manifest.cells.map(c => c.id))) errors.push('duplicate profile/cell ID');
    const expectedProfiles = inventory.categories.flatMap(c => c.profiles);
    if (!same([...expectedProfiles].sort(), manifest.profiles.map(p => p.id).sort())) errors.push('required inventory profiles missing or extra');
    for (const p of manifest.profiles) {
      const prefix = `${p.id}: `;
      if (!text(p.receipt_category)) errors.push(prefix + 'native receipt category required');
      const category = inventory.categories.find(c => c.id === p.category);
      if (!category || !category.profiles.includes(p.id)) { errors.push(prefix + 'unknown category/profile'); continue; }
      if (!same(p.arms, profileArms(category, p.id))) errors.push(prefix + 'required arms mismatch');
      if (!['live', 'hermetic'].includes(p.mode) || (p.id === 'cat34-hermetic' && p.mode !== 'hermetic')
        || (p.arms.includes('C1') && p.mode !== 'live')) errors.push(prefix + 'invalid live/hermetic mode');
      if (!integer(p.repeats) || p.repeats < (p.mode === 'live' ? 2 : 1)) errors.push(prefix + 'preregister repeated paired live runs');
      if (!p.probes.length || !unique(p.probes.map(r => r.probe_id))) errors.push(prefix + 'empty/duplicate expected probe IDs');
      if (!p.metrics.length || !unique(p.metrics.map(m => m.id)) || !p.metrics.some(m => m.primary)) errors.push(prefix + 'unique primary metrics required');
      if (!unique(p.required_slices) || p.required_slices.includes('all')) errors.push(prefix + 'unique native slices required; all is implicit');
      for (const m of p.metrics) {
        if (!text(m.id) || !['higher', 'lower'].includes(m.direction) || !['mean', 'max', 'min', 'sum', 'ratio', 'p50', 'p95', 'p99'].includes(m.aggregation)
          || !Array.isArray(m.range) || m.range.length !== 2 || !m.range.every(finite) || m.range[0] > m.range[1]
          || typeof m.primary !== 'boolean' || (m.floor !== undefined && (!finite(m.floor) || m.floor < m.range[0] || m.floor > m.range[1]))
          || (m.integer !== undefined && typeof m.integer !== 'boolean')
          || (m.ceiling !== undefined && (!finite(m.ceiling) || m.ceiling < m.range[0] || m.ceiling > m.range[1]))
          || (m.floor !== undefined && m.ceiling !== undefined && m.floor > m.ceiling)) errors.push(prefix + `invalid metric ${m.id}`);
        for (const slice of [...(m.bound_slices ?? []), ...(m.applies_to ?? []), ...(m.slice_bounds ?? []).map(b => b.slice)]) {
          if (slice !== 'all' && !p.required_slices.includes(slice)) errors.push(prefix + `unknown metric-bound/applicability slice ${slice}`);
        }
        if (m.applies_to && (!m.applies_to.length || !unique(m.applies_to))) errors.push(prefix + 'invalid metric applicability');
        if (m.probe_ids && (!m.probe_ids.length || !unique(m.probe_ids) || m.probe_ids.some(id => !p.probes.some(probe => probe.probe_id === id)))) errors.push(prefix + 'invalid native metric probe IDs');
        for (const bound of [m.probe_floor, m.probe_ceiling]) if (bound !== undefined && (!finite(bound) || bound < m.range[0] || bound > m.range[1])) errors.push(prefix + 'invalid per-probe bound');
        for (const exclusive of [m.floor_exclusive, m.ceiling_exclusive]) if (exclusive !== undefined && typeof exclusive !== 'boolean') errors.push(prefix + 'invalid exclusive bound');
        if (m.native_not_applicable && !['empty_gold', 'empty_gold_and_empty_results', 'empty_expected_or_no_predictions', 'unrecognized_safety'].includes(m.native_not_applicable)) errors.push(prefix + 'invalid native N/A rule');
        if (m.bound_arms && (!m.bound_arms.length || !unique(m.bound_arms) || m.bound_arms.some(arm => !p.arms.includes(arm)))) errors.push(prefix + 'invalid arm-scoped native bounds');
        for (const bound of m.slice_bounds ?? []) {
          if ((bound.floor === undefined && bound.ceiling === undefined) || (bound.floor !== undefined && (!finite(bound.floor) || bound.floor < m.range[0] || bound.floor > m.range[1]))
            || (bound.ceiling !== undefined && (!finite(bound.ceiling) || bound.ceiling < m.range[0] || bound.ceiling > m.range[1]))) errors.push(prefix + `invalid native slice bound ${m.id}`);
        }
      }
      for (const constraint of p.native_constraints ?? []) {
        const best = constraint.operation.startsWith('best_slice');
        if (!text(constraint.id) || !['difference', 'ratio', 'best_slice', 'best_slice_ratio'].includes(constraint.operation)
          || (best && (!text(constraint.slice_prefix) || !p.required_slices.some(s => s.startsWith(constraint.slice_prefix!))))
          || (constraint.operation !== 'best_slice' && !constraint.right)
          || (constraint.selection_metric !== undefined && !p.metrics.some(m => m.id === constraint.selection_metric))) errors.push(prefix + 'invalid native cross-slice constraint');
        for (const side of [constraint.left, ...(constraint.right ? [constraint.right] : [])]) {
          if (!p.metrics.some(m => m.id === side.metric) || (side.slice !== 'all' && !p.required_slices.includes(side.slice))) errors.push(prefix + 'native constraint references unknown metric/slice');
        }
        for (const bound of [constraint.floor, constraint.ceiling]) if (bound !== undefined && !finite(bound)) errors.push(prefix + 'invalid native constraint bound');
      }
      const sliceSet = new Set(p.required_slices);
      for (const probe of p.probes) {
        const excluded = [...probe.no_gold_metrics, ...(probe.positive_probe_metrics ?? [])];
        if (!text(probe.probe_id) || !text(probe.family_id) || typeof probe.critical !== 'boolean'
          || !unique(probe.slices) || probe.slices.some(s => !sliceSet.has(s))
          || !unique(excluded) || excluded.some(m => !p.metrics.some(spec => spec.id === m))
          || excluded.length === p.metrics.length) errors.push(prefix + `invalid expected probe ${probe.probe_id}`);
      }
      for (const slice of p.required_slices) if (!p.probes.some(r => r.slices.includes(slice))) errors.push(prefix + `empty required slice ${slice}`);
      for (const metric of p.metrics) if (!p.probes.some(r => !r.no_gold_metrics.includes(metric.id) && !r.positive_probe_metrics?.includes(metric.id))) errors.push(prefix + `metric has no applicable expected probes: ${metric.id}`);
      const hashKeys = ['corpus', 'gold', 'queries', 'runner', 'scorer', 'models', 'prompts', 'source_timestamps'];
      if (!same(Object.keys(p.hashes).sort(), hashKeys.sort()) || !Object.values(p.hashes).every(digest)) errors.push(prefix + 'complete frozen hashes required');
      if (!text(p.declared_pin) || !['B', 'C0', 'C1'].every(a => text(p.package_versions[a as RegressionArm])) || !text(p.reranker)
        || !finite(time(p.clock))) errors.push(prefix + 'version/model/clock missing');
      if (Object.keys(p.config).some(k => k.startsWith('memory.cues.')) || Object.entries(p.config).some(([k, v]) => /api.?key|secret|password|credential|auth.?token|access.?token/i.test(k) || typeof v !== 'string')) errors.push(prefix + 'unsafe or intervention-bearing common config');
      const fileKeys = ['engine', 'embedding_model', 'embedding_dimensions', 'chat_model', 'expansion_model'];
      if (!p.file_config || p.file_config.engine !== 'pglite' || Object.keys(p.file_config).some(k => !fileKeys.includes(k))
        || ((p.file_config.embedding_model !== undefined || p.file_config.embedding_dimensions !== undefined || p.mode === 'live')
          && (!text(p.file_config.embedding_model) || !integer(p.file_config.embedding_dimensions) || p.file_config.embedding_dimensions === 0))) errors.push(prefix + 'explicit non-secret product file-plane model config required');
      if (Object.keys(p.cue_config).some(k => !k.startsWith('memory.cues.')) || Object.values(p.cue_config).some(v => typeof v !== 'string')) errors.push(prefix + 'C1 intervention may change only memory.cues settings');
      if (p.arms.includes('C1')) {
        const threshold = Number(p.cue_config['memory.cues.min_similarity']);
        const weight = Number(p.cue_config['memory.cues.weight']);
        if (!p.cue_sources.length || !unique(p.cue_sources) || !text(p.cue_config['memory.cues.min_similarity']) || !finite(threshold) || threshold < -1 || threshold > 1
          || !finite(weight) || weight <= 0 || weight > 0.5 || p.cue_config['memory.cues.sources'] !== JSON.stringify(runtimeCueSourceIds(p))) errors.push(prefix + 'explicit calibrated/enrolled cue configuration required');
        if (!p.probes.some(probe => probe.cue_eligible !== false)) errors.push(prefix + 'C1 has no cue-eligible query probes');
      }
      if (p.cue_source_bindings !== undefined && (!p.cue_source_bindings || Array.isArray(p.cue_source_bindings)
        || !same(Object.keys(p.cue_source_bindings).sort(), [...p.cue_sources].sort())
        || !Object.values(p.cue_source_bindings).every(text) || !unique(Object.values(p.cue_source_bindings)))) errors.push(prefix + 'source bindings must be a complete one-to-one fixture/runtime mapping');
      if (!integer(p.timeout_ms) || p.timeout_ms === 0) errors.push(prefix + 'bounded timeout required');
      if (p.prerequisites.supported !== true || !text(p.prerequisites.runner) || !digest(p.prerequisites.evidence_sha256)) errors.push(prefix + `unsupported prerequisite: ${p.prerequisites.reason ?? 'verified runner/readiness evidence missing'}`);
      const costs = Object.entries(p.budget).filter(([key]) => key !== 'enforcement').map(([, value]) => value);
      if (costs.length !== 5 || !costs.every(v => finite(v) && v >= 0) || !finite(profileBudget(p))
        || !['none', 'isolated-provider-hard-limit'].includes(p.budget.enforcement)
        || (profileBudget(p) > 0 && p.budget.enforcement !== 'isolated-provider-hard-limit')
        || (p.mode === 'live' && profileBudget(p) <= 0) || (p.mode === 'hermetic' && profileBudget(p) !== 0)) errors.push(prefix + 'unknown/unbounded provider liability');
      const expectedCells = p.arms.flatMap(arm => Array.from({ length: Math.max(0, Math.min(p.repeats, 100)) }, (_, repeat) => `${arm}:${repeat}`));
      const actualCells = manifest.cells.filter(c => c.profile_id === p.id).map(c => `${c.arm}:${c.repeat}`);
      if (p.repeats > 100 || !same(expectedCells.sort(), actualCells.sort())) errors.push(prefix + 'missing/duplicate/extra arm-repeat cells');
    }
    for (const cell of manifest.cells) {
      if (!identifier(cell.id) || !manifest.profiles.some(p => p.id === cell.profile_id)) errors.push('invalid cell/profile identity');
      const paths = Object.entries(cell.runtime).filter(([key]) => key !== 'package_path').map(([, value]) => value);
      if (!paths.every(p => typeof p === 'string' && isAbsolute(p) && resolve(p) === p) || !unique(paths)
        || !paths.filter(p => p !== cell.runtime.root).every(p => inside(cell.runtime.root, p))) errors.push(`${cell.id}: runtime paths must be distinct and inside a run-local root`);
      if (cell.runtime.package_path !== cell.runtime.product_root) errors.push(`${cell.id}: package must resolve to the designated isolated product checkout`);
      if (cell.runtime.config !== join(cell.runtime.home, '.gbrain/config.json')) errors.push(`${cell.id}: config must be the isolated product file-plane path`);
      const writable = [cell.runtime.home, cell.runtime.database, cell.runtime.config, cell.runtime.output];
      if (writable.some((a, i) => writable.some((b, j) => i !== j && inside(a, b) && !(a === cell.runtime.home && b === cell.runtime.config)))) errors.push(`${cell.id}: writable namespaces overlap`);
    }
    for (let i = 0; i < manifest.cells.length; i++) for (let j = 0; j < i; j++) {
      const a = manifest.cells[i].runtime.root, b = manifest.cells[j].runtime.root;
      if (a === b || inside(a, b) || inside(b, a)) errors.push('cross-cell runtime isolation violation');
    }
    const liability = manifest.cells.reduce((sum, c) => sum + profileBudget(manifest.profiles.find(p => p.id === c.profile_id)!), 0);
    if (!finite(liability) || liability > manifest.max_usd) errors.push('full sweep liability exceeds authorized budget');
    const cat36 = manifest.profiles.find(p => p.id === manifest.statistics.cat36.profile_id);
    if (!cat36 || cat36.category !== 'cat36' || manifest.statistics.cat36.metric !== inventory.decision.cat36_metric
      || manifest.statistics.cat36.slice !== 'indirect') errors.push('Cat36 primary decision changed');
    if (cat36) {
      const searchKeys = inventory.native_contracts.cat36.required_search_settings;
      if (!same(Object.keys(cat36.config).filter(k => k.startsWith('search.')).sort(), [...searchKeys].sort())) errors.push('Cat36 complete native search settings required');
      if (!integer(cat36.output_token_budget) || cat36.output_token_budget === 0 || cat36.output_token_budget > 4096) errors.push('Cat36 requested output-token budget must be frozen in [1,4096]');
      if (!cat36.cue_source_bindings) errors.push('Cat36 fixture/runtime source bindings must be preregistered');
      const families = new Set(cat36.probes.map(p => p.family_id));
      if (cat36.probes.length !== 320 || families.size !== 80 || ['indirect', 'direct', 'negative'].some((slice, index) => cat36.probes.filter(p => p.slices.includes(slice)).length !== [160, 80, 80][index])) errors.push('Cat36 frozen holdout denominators changed');
      for (const family of families) {
        const rows = cat36.probes.filter(p => p.family_id === family);
        if (rows.length !== 4 || ['indirect', 'direct', 'negative'].some((slice, index) => rows.filter(r => r.slices.includes(slice)).length !== [2, 1, 1][index])) errors.push('Cat36 family clustering malformed');
        const domains = ['constraints', 'preferences', 'commitments', 'changing-decisions', 'causal-context'];
        const familyDomains = rows.map(row => row.slices.filter(s => domains.includes(s)));
        if (familyDomains.some(d => d.length !== 1) || new Set(familyDomains.flat()).size !== 1) errors.push('Cat36 family crosses domain boundaries');
      }
      const requiredMetrics = ['all_evidence_in_top5_chunks', 'page_recall_at5', 'page_precision_at5', 'page_mrr', 'page_ndcg_at5', 'associative_false_fire', 'negative_result_count', 'returned_evidence_tokens', 'safety_violations'];
      if (requiredMetrics.some(id => !cat36.metrics.some(m => m.id === id))) errors.push('Cat36 primary/guardrail metrics missing');
      if (!cat36.metrics.some(m => m.id === 'safety_violations' && m.ceiling === 0 && m.direction === 'lower')) errors.push('Cat36 zero-safety-violation floor missing');
      for (const id of requiredMetrics) {
        const metric = cat36.metrics.find(m => m.id === id);
        const positive = requiredMetrics.indexOf(id) < 5;
        if (metric && (metric.direction !== (positive ? 'higher' : 'lower') || metric.range[0] !== 0 || (positive && metric.range[1] !== 1)
          || (id === 'all_evidence_in_top5_chunks' && (!metric.primary || metric.aggregation !== 'mean')))) errors.push(`Cat36 metric contract changed: ${id}`);
      }
      const domains = ['constraints', 'preferences', 'commitments', 'changing-decisions', 'causal-context'];
      if (!cat36.required_slices.includes('multi-evidence') || domains.some(d => !cat36.required_slices.includes(d) || cat36.probes.filter(p => p.slices.includes(d)).length !== 64)) errors.push('Cat36 domain/multi-evidence slices missing');
      const native = inventory.native_contracts.cat36;
      if (!cat36.native_hashes || native.native_hash_keys.some(key => !digest(cat36.native_hashes?.[key]))) errors.push('Cat36 native dataset/scorer/model/prompt hashes missing');
      if (Object.entries(native.common_hash_mapping).some(([common, nativeKey]) => cat36.hashes[common as keyof typeof cat36.hashes] !== cat36.native_hashes?.[nativeKey])) errors.push('Cat36 native/common provenance hash mismatch');
    }
    const opportunities = manifest.statistics.opportunities;
    if (!opportunities.length || !unique(opportunities.map(o => `${o.profile_id}:${o.metric}:${o.slice}`))) errors.push('preregister unique existing retrieval opportunities');
    for (const o of opportunities) {
      const p = manifest.profiles.find(p => p.id === o.profile_id);
      if (!p || !inventory.decision.existing_opportunity_categories.includes(p.category) || !p.arms.includes('C1')
        || !p.metrics.some(m => m.id === o.metric && m.primary && m.aggregation === 'mean')
        || (o.slice !== 'all' && !p.required_slices.includes(o.slice))) errors.push('invalid existing retrieval opportunity');
    }
  } catch (error) { errors.push(`malformed manifest: ${String(error)}`); }
  return [...new Set(errors)];
}

export function validateRegressionCell(manifest: RegressionManifest, cell: RegressionCellSpec, result: RegressionCellResult): string[] {
  const errors: string[] = [];
  try {
    const p = manifest.profiles.find(p => p.id === cell.profile_id)!;
    const r = result.receipt;
    if (result.cell_id !== cell.id || result.exit_code !== 0) errors.push('child failed, crashed or wrong cell');
    if (!r) return [...errors, 'missing receipt'];
    errors.push(...validateReceipt(r));
    if (r.category !== p.receipt_category) errors.push('native receipt category mismatch');
    const nativeContract = nativeRegressionContract(p);
    if (r.run_status !== 'completed' || !(nativeContract?.completed_verdicts ?? ['pass']).includes(r.verdict as 'pass' | 'fail') || r.publishable !== true) errors.push('receipt is incomplete, failed, skipped or nonpublishable');
    if (nativeContract?.frozen_recipe && p.native_contract_sha256 === regressionHash(nativeContract)) {
      const nativeReview = (r.resolved_config?.profile as { fixture_review?: unknown } | undefined)?.fixture_review;
      if (r.hashes?.recipe !== nativeContract.frozen_recipe.recipe_sha256 || !same(nativeReview, p.recipe_review)) errors.push('native recipe hash/review differs from registration');
    }
    const d = r.data?.regression as RegressionReceiptData | undefined;
    if (!d) return [...errors, 'missing strict regression receipt payload'];
    if (d.schema_version !== 1 || d.run_id !== manifest.run_id || d.cell_id !== cell.id || d.manifest_sha256 !== regressionHash(manifest)) errors.push('stale run/cell/manifest identity');
    if (d.mode === 'offline' || d.mode !== p.mode) errors.push('offline or wrong execution mode');
    const times = [manifest.registered_at, result.started_at, r.started_at, r.finished_at, result.finished_at, manifest.expires_at].map(time);
    if (!times.every(finite) || times.some((t, i) => i > 0 && t < times[i - 1])) errors.push('stale receipt or invalid process timestamp window');
    if (time(result.finished_at) - time(result.started_at) > p.timeout_ms) errors.push('child exceeded registered timeout');
    const prov = d.provenance;
    const product = cell.arm === 'B' ? manifest.products.B : manifest.products.candidate;
    const archive = prov.product.sha === null && prov.product.tree === null && prov.product_dirty === null;
    const verifiedProduct = archive ? digest(product.package_sha256) && prov.product.package_sha256 === product.package_sha256
      : prov.product.sha === product.sha && prov.product.tree === product.tree && prov.product_dirty === false
        && (product.package_sha256 === undefined || prov.product.package_sha256 === product.package_sha256);
    if (prov.eval_sha !== manifest.eval_sha || prov.eval_dirty !== false || !verifiedProduct) errors.push('dirty, unverified archive or mixed eval/product commit/tree');
    if (prov.declared_pin !== p.declared_pin || r.gbrain_pin !== p.declared_pin || prov.package_version !== p.package_versions[cell.arm] || r.gbrain_version !== prov.package_version) errors.push('declared/loaded dependency identity mismatch');
    for (const name of ['package', 'deep_import', 'GBRAIN_SRC', 'GBRAIN_REPO'] as const) {
      const binding = prov.bindings[name];
      const expectedPath = name === 'package' ? cell.runtime.package_path : cell.runtime.product_root;
      if (!binding || binding.sha !== prov.product.sha || binding.tree !== prov.product.tree || binding.path !== expectedPath
        || (archive && binding.package_sha256 !== product.package_sha256)) errors.push(`mixed or missing ${name} binding`);
    }
    if (!same(prov.hashes, p.hashes) || !same(prov.config, effectiveRegressionConfig(p, cell.arm)) || prov.clock !== p.clock || !same(prov.runtime, cell.runtime)) errors.push('dataset/scorer/model/config/clock/runtime mismatch');
    if (!prov.file_config || prov.file_config.path !== cell.runtime.config || !same(prov.file_config.values, effectiveRegressionFileConfig(p, cell))) errors.push('actual product file-plane path/model config mismatch');
    if (d.observed.fallback !== false || d.observed.reranker !== p.reranker || d.observed.source_timestamps_frozen !== true) errors.push('fallback or unobserved runtime settings');
    const budget = profileBudget(p);
    if (!finite(d.spend.actual_usd) || d.spend.actual_usd < 0 || !finite(d.spend.reserved_usd) || d.spend.reserved_usd !== budget || d.spend.actual_usd > budget
      || (budget > 0 && !text(d.spend.enforcement_id))) errors.push('missing/enforcement/exceeded budget receipt');
    if (!Array.isArray(d.rows) || !unique(d.rows.map(row => row.probe_id)) || !same(d.rows.map(row => row.probe_id).sort(), p.probes.map(row => row.probe_id).sort())) return [...errors, 'missing/duplicate/extra expected probe rows'];
    const accounting = new ProbeAccounting(p.probes.length);
    const rowErrors = [];
    for (const row of d.rows) {
      const spec = p.probes.find(probe => probe.probe_id === row.probe_id)!;
      if (!same(Object.keys(row.metrics).sort(), p.metrics.map(m => m.id).sort())) errors.push(`metric IDs mismatch: ${row.probe_id}`);
      for (const metric of p.metrics) {
        const value = row.metrics[metric.id];
        const excluded = spec.no_gold_metrics.includes(metric.id) ? 'no_gold' : spec.positive_probe_metrics?.includes(metric.id) ? 'positive_probe'
          : !metricApplies(metric, spec) ? 'outside_metric_slice' : null;
        if (excluded) {
          if (!same(value, { not_applicable: excluded })) errors.push(`invalid tagged exclusion: ${row.probe_id}/${metric.id}`);
        } else if (!nativeNotApplicable(value, metric)) {
          const valid = metric.aggregation === 'ratio' ? ratio(value) : finite(value);
          const numeric = valid ? numericValue(value as RegressionObservationValue, metric) : NaN;
          if (!valid || !finite(numeric) || numeric < metric.range[0] || numeric > metric.range[1]
            || (metric.integer && (metric.aggregation === 'ratio' ? !Number.isSafeInteger((value as { numerator: number }).numerator) || !integer((value as { denominator: number }).denominator) : !Number.isSafeInteger(value)))) errors.push(`missing/nonfinite/out-of-range metric: ${row.probe_id}/${metric.id}`);
        }
        if (row.error?.origin === 'sut' && metric.primary && (finite(value) || ratio(value))) {
          const miss = metric.direction === 'higher' ? metric.range[0] : metric.range[1];
          if (numericValue(value, metric) !== miss) errors.push(`SUT failure is not scored as a miss: ${row.probe_id}/${metric.id}`);
        }
      }
      if (row.error) {
        if (row.error.probe_id !== row.probe_id) errors.push('row error/probe identity mismatch');
        rowErrors.push(row.error);
        accounting.error(row.probe_id, row.error.origin, row.error.message);
        if (row.error.origin !== 'sut') errors.push(`incomplete prerequisite/judge row: ${row.probe_id}`);
      } else accounting.score(row.probe_id, 1);
      const observedSutFailure = row.error?.origin === 'sut' && row.feature?.status === 'degraded' && row.feature.admitted === 0;
      const cueExpected = cell.arm === 'C1' && spec.cue_eligible !== false;
      if (cueExpected && (!row.feature || row.feature.attempted !== true || (!executedCueLookup(row.feature.status, row.feature.reason) && !observedSutFailure) || !integer(row.feature.admitted))) errors.push(`cue arm unexercised: ${row.probe_id}`);
      if (!cueExpected && row.feature && (row.feature.attempted || row.feature.admitted !== 0)) errors.push(`cue arm unexpectedly executed: ${row.probe_id}`);
    }
    const summary = accounting.summary();
    if (r.n_total !== summary.n_total || r.n_scored !== summary.n_scored || r.n_total !== p.probes.length || r.n_scored !== r.n_total
      || r.completion_rate !== 1 || !integer(r.n_total) || !integer(r.n_scored) || !same(r.errors, rowErrors) || !summary.publishable) errors.push('receipt counts/errors differ from complete per-probe accounting');
    const feature = d.feature;
    if (![feature.generated, feature.empty_windows, feature.rejected_windows].every(integer)) errors.push('invalid feature build counters');
    if (cell.arm === 'C1') {
      if (feature.supported !== true || feature.read_mode !== 'on' || feature.production_generation !== true || feature.build_complete !== true || !digest(feature.build_receipt_sha256)
        || (feature.generated === 0 && feature.empty_windows === 0) || !same([...feature.covered_sources].sort(), [...p.cue_sources].sort())) errors.push('production cue support/build/source coverage missing');
    } else if (feature.read_mode !== 'off' || feature.production_generation !== false || feature.build_complete !== false || feature.generated !== 0 || feature.build_receipt_sha256 !== null) errors.push('baseline/off arm borrowed candidate cue artifacts');
  } catch (error) { errors.push(`malformed receipt: ${String(error)}`); }
  return [...new Set(errors)];
}

function nativeNotApplicable(value: unknown, metric: RegressionMetricSpec): boolean {
  if (!metric.native_not_applicable || !value || typeof value !== 'object') return false;
  const tagged = value as { not_applicable?: unknown; evidence?: Record<string, unknown> };
  if (tagged.not_applicable !== 'native_no_denominator' || !tagged.evidence) return false;
  const evidence = tagged.evidence;
  if (metric.native_not_applicable === 'unrecognized_safety') {
    const validTier = (tier: unknown) => tier === null || typeof tier === 'string';
    const recognized = (tier: unknown) => ['exists', 'probable', 'unknown'].includes(String(tier));
    return validTier(evidence.left_tier) && validTier(evidence.right_tier) && (!recognized(evidence.left_tier) || !recognized(evidence.right_tier));
  }
  if (metric.native_not_applicable === 'empty_expected_or_no_predictions') return integer(evidence.expected_count) && integer(evidence.returned_count)
    && (evidence.expected_count === 0 || evidence.returned_count === 0);
  return evidence.expected_count === 0 && integer(evidence.returned_count)
    && (metric.native_not_applicable === 'empty_gold' || evidence.returned_count === 0);
}

function metricApplies(metric: RegressionMetricSpec, probe: RegressionProfile['probes'][number]): boolean {
  return (!metric.applies_to || metric.applies_to.some(s => s === 'all' || probe.slices.includes(s)))
    && (!metric.probe_ids || metric.probe_ids.includes(probe.probe_id));
}

function violatesBound(value: number, bound: { floor?: number; ceiling?: number; floor_exclusive?: boolean; ceiling_exclusive?: boolean }): boolean {
  return !finite(value) || (bound.floor !== undefined && (bound.floor_exclusive ? value <= bound.floor : value < bound.floor))
    || (bound.ceiling !== undefined && (bound.ceiling_exclusive ? value >= bound.ceiling : value > bound.ceiling));
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function aggregateRegressionMetric(values: RegressionObservationValue[], metric: RegressionMetricSpec): number {
  if (!values.length) return NaN;
  if (metric.aggregation === 'ratio') {
    const fractions = values as Array<{ numerator: number; denominator: number }>;
    if (!fractions.every(ratio)) return NaN;
    const denominator = fractions.reduce((sum, v) => sum + v.denominator, 0);
    return denominator === 0 ? typeof metric.zero_denominator === 'number' ? metric.zero_denominator : NaN
      : fractions.reduce((sum, v) => sum + v.numerator, 0) / denominator;
  }
  const numbers = values as number[];
  if (!numbers.every(finite)) return NaN;
  if (metric.aggregation === 'max') return numbers.reduce((a, b) => Math.max(a, b), -Infinity);
  if (metric.aggregation === 'min') return numbers.reduce((a, b) => Math.min(a, b), Infinity);
  if (metric.aggregation.startsWith('p')) {
    const p = Number(metric.aggregation.slice(1));
    return metric.percentile_method === 'nearest_rank' ? [...numbers].sort((a, b) => a - b)[Math.max(0, Math.ceil(numbers.length * p / 100) - 1)] : percentile(numbers, p);
  }
  const total = numbers.reduce((sum, x) => sum + x, 0);
  return metric.aggregation === 'sum' ? total : total / numbers.length;
}

export function clusteredRegressionStatistics(
  pairs: Array<{ family_id: string; baseline: RegressionObservationValue; candidate: RegressionObservationValue }>,
  metric: RegressionMetricSpec, seed: number, draws: number,
): { delta: number; lower95: number; upper95: number; p_value: number } {
  const validObservation = metric.aggregation === 'ratio' ? ratio : finite;
  if (!pairs.length || !pairs.every(p => text(p.family_id) && validObservation(p.baseline) && validObservation(p.candidate)) || !integer(draws) || draws < 10000) throw new Error('invalid clustered observations/draw count');
  const clusters = [...new Set(pairs.map(p => p.family_id))].sort().map(id => pairs.filter(p => p.family_id === id));
  const sign = metric.direction === 'higher' ? 1 : -1;
  const diff = (rows: typeof pairs) => sign * (aggregateRegressionMetric(rows.map(p => p.candidate), metric) - aggregateRegressionMetric(rows.map(p => p.baseline), metric));
  const delta = diff(pairs);
  if (clusters.length < 2) return { delta, lower95: metric.range[0] - metric.range[1], upper95: metric.range[1] - metric.range[0], p_value: 1 };
  if (pairs.every(p => same(p.baseline, p.candidate))) return { delta: 0, lower95: 0, upper95: 0, p_value: 1 };
  const differences = pairs.map(p => sign * (numericValue(p.candidate, metric) - numericValue(p.baseline, metric)));
  if (metric.aggregation === 'mean' && differences.every(d => d === differences[0])) {
    return { delta, lower95: delta, upper95: delta, p_value: delta > 0 ? 2 ** -clusters.length : 1 };
  }
  const rng = random(seed);
  const boot: number[] = [];
  const clusterMeans = clusters.map(rows => ({ sum: rows.reduce((sum, p) => sum + sign * (numericValue(p.candidate, metric) - numericValue(p.baseline, metric)), 0), count: rows.length }));
  for (let i = 0; i < draws; i++) {
    if (metric.aggregation === 'mean') {
      let sum = 0, count = 0;
      for (let j = 0; j < clusters.length; j++) {
        const c = clusterMeans[Math.floor(rng() * clusters.length)];
        sum += c.sum;
        count += c.count;
      }
      boot.push(sum / count);
    } else {
      const sample = Array.from({ length: clusters.length }, () => clusters[Math.floor(rng() * clusters.length)]).flat();
      boot.push(diff(sample));
    }
  }
  boot.sort((a, b) => a - b);
  if (!boot.every(finite)) return { delta, lower95: metric.range[0] - metric.range[1], upper95: metric.range[1] - metric.range[0], p_value: 1 };
  const count = clusters.length <= 16 ? 2 ** clusters.length : draws;
  let exceed = 0;
  for (let i = 0; i < count; i++) {
    if (metric.aggregation === 'mean') {
      const nullDelta = clusterMeans.reduce((sum, c, index) => {
        const swap = clusters.length <= 16 ? ((i >>> index) & 1) === 1 : rng() < 0.5;
        return sum + (swap ? -c.sum : c.sum);
      }, 0) / pairs.length;
      if (nullDelta >= delta - 1e-12) exceed++;
      continue;
    }
    const swapped = clusters.flatMap((rows, index) => {
      const swap = clusters.length <= 16 ? ((i >>> index) & 1) === 1 : rng() < 0.5;
      return swap ? rows.map(p => ({ ...p, baseline: p.candidate, candidate: p.baseline })) : rows;
    });
    if (diff(swapped) >= delta - 1e-12) exceed++;
  }
  return {
    delta, lower95: boot[Math.floor(draws * 0.025)], upper95: boot[Math.ceil(draws * 0.975) - 1],
    p_value: clusters.length <= 16 ? exceed / count : (exceed + 1) / (count + 1),
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

export function compareSituationRecall(manifest: RegressionManifest, results: RegressionCellResult[], options: { evalRoot?: string } = {}): RegressionDecision {
  const nativeErrors = validateRegressionManifest(manifest, options);
  const decision = compareRegressionMeasurements(manifest, results).measurement_decision;
  if (nativeErrors.length) {
    decision.status = 'blocked';
    decision.reasons = [...new Set([...nativeErrors, ...decision.reasons])];
    for (const coverage of decision.coverage) {
      const errors = nativeErrors.filter(e => e.startsWith(`${coverage.profile_id}:`));
      if (errors.length) { coverage.status = 'blocked'; coverage.reasons.push(...errors); }
    }
  }
  return decision;
}

export function compareRegressionMeasurements(manifest: RegressionManifest, results: RegressionCellResult[]): {
  release_eligible: false;
  measurement_decision: RegressionDecision;
} {
  return { release_eligible: false, measurement_decision: compareMeasurements(manifest, results) };
}

function compareMeasurements(manifest: RegressionManifest, results: RegressionCellResult[]): RegressionDecision {
  const reasons = validateRegressionRegistration(manifest);
  const coverage: RegressionCoverage[] = manifest.profiles?.map(p => ({ profile_id: p.id, status: 'blocked', reasons: [] })) ?? [];
  const comparisons: RegressionComparison[] = [];
  if (!Array.isArray(results) || !unique(results.map(r => r.cell_id)) || results.some(r => !manifest.cells?.some(c => c.id === r.cell_id))) reasons.push('duplicate/extra result cells');
  if (reasons.length) return { status: 'blocked', reasons, coverage, comparisons };
  for (const profile of manifest.profiles) {
    const report = coverage.find(c => c.profile_id === profile.id)!;
    const cells = manifest.cells.filter(c => c.profile_id === profile.id);
    for (const cell of cells) {
      const result = results.find(r => r.cell_id === cell.id);
      report.reasons.push(...(result ? validateRegressionCell(manifest, cell, result) : ['missing result cell']).map(e => `${cell.id}: ${e}`));
    }
    if (report.reasons.length) continue;
    report.status = 'pass';
    let eligibilityChanged = false;
    const rowsFor = (arm: RegressionArm, repeat: number): RegressionProbeRow[] => {
      const cell = cells.find(c => c.arm === arm && c.repeat === repeat)!;
      return (results.find(r => r.cell_id === cell.id)!.receipt!.data!.regression as RegressionReceiptData).rows;
    };
    for (const metric of profile.metrics) for (const slice of ['all', ...profile.required_slices]) {
      const probes = profile.probes.filter(p => (slice === 'all' || p.slices.includes(slice)) && !p.no_gold_metrics.includes(metric.id) && !p.positive_probe_metrics?.includes(metric.id)
        && metricApplies(metric, p));
      if (!probes.length) continue;
      for (const arm of profile.arms) {
        for (let repeat = 0; repeat < profile.repeats; repeat++) {
          const rows = rowsFor(arm, repeat);
          const values = probes.map(p => rows.find(r => r.probe_id === p.probe_id)!.metrics[metric.id]).filter(v => !nativeNotApplicable(v, metric)) as RegressionObservationValue[];
          if (!values.length && metric.native_not_applicable) continue;
          const score = aggregateRegressionMetric(values, metric);
          const applyBounds = !metric.bound_arms || metric.bound_arms.includes(arm);
          const bound = !applyBounds ? {} : metric.slice_bounds?.find(b => b.slice === slice)
            ?? ((metric.bound_slices ?? ['all']).includes(slice) ? metric : {});
          if (violatesBound(score, bound) || (applyBounds && values.some(v => violatesBound(numericValue(v, metric), { floor: metric.probe_floor, ceiling: metric.probe_ceiling })))) {
            report.status = 'regressed';
            report.reasons.push(`${arm}@${repeat}/${slice}/${metric.id}: native floor/ceiling failed (${score})`);
          }
        }
      }
      const pairs: Array<[RegressionArm, RegressionArm]> = profile.arms.includes('C1') ? [['C0', 'B'], ['C1', 'C0'], ['C1', 'B']] : [['C0', 'B']];
      for (const [candidate, baseline] of pairs) {
        const points = Array.from({ length: profile.repeats }, (_, repeat) => {
          const b = rowsFor(baseline, repeat), c = rowsFor(candidate, repeat);
          return probes.flatMap(p => {
            const baselineValue = b.find(r => r.probe_id === p.probe_id)!.metrics[metric.id];
            const candidateValue = c.find(r => r.probe_id === p.probe_id)!.metrics[metric.id];
            const baselineNA = nativeNotApplicable(baselineValue, metric), candidateNA = nativeNotApplicable(candidateValue, metric);
            if (baselineNA || candidateNA) {
              if (baselineNA !== candidateNA) {
                eligibilityChanged = true;
                report.reasons.push(`${candidate}-${baseline}/${slice}/${metric.id}/${p.probe_id}: native eligible denominator changed`);
              }
              return [];
            }
            return [{
            family_id: p.family_id, probe_id: p.probe_id, repeat, critical: p.critical,
            baseline: baselineValue as RegressionObservationValue,
            candidate: candidateValue as RegressionObservationValue,
          }]; });
        }).flat();
        if (!points.length) continue;
        const orientation = metric.direction === 'higher' ? 1 : -1;
        const losses = points.filter(p => orientation * (numericValue(p.candidate, metric) - numericValue(p.baseline, metric)) < 0);
        const wins = points.filter(p => orientation * (numericValue(p.candidate, metric) - numericValue(p.baseline, metric)) > 0);
        const stats = clusteredRegressionStatistics(points, metric, manifest.statistics.seed, manifest.statistics.draws);
        const comparison: RegressionComparison = {
          profile_id: profile.id, candidate, baseline, metric: metric.id, slice,
          baseline_value: aggregateRegressionMetric(points.map(p => p.baseline), metric), candidate_value: aggregateRegressionMetric(points.map(p => p.candidate), metric),
          n_pairs: points.length, n_families: new Set(points.map(p => p.family_id)).size,
          baseline_denominator: metric.aggregation === 'ratio' ? points.reduce((sum, p) => sum + (p.baseline as { denominator: number }).denominator, 0) : points.length,
          candidate_denominator: metric.aggregation === 'ratio' ? points.reduce((sum, p) => sum + (p.candidate as { denominator: number }).denominator, 0) : points.length,
          ...stats, wins: wins.map(p => `${p.probe_id}@${p.repeat}`), losses: losses.map(p => `${p.probe_id}@${p.repeat}`),
        };
        comparisons.push(comparison);
        if (stats.delta < 0 || losses.some(p => p.critical)) {
          report.status = 'regressed';
          report.reasons.push(`${candidate}-${baseline}/${slice}/${metric.id}: ${stats.delta < 0 ? 'observed decline' : 'critical known-correct probe loss'}`);
        } else if (profile.mode === 'live' && losses.length && stats.lower95 < 0 && report.status === 'pass') {
          report.status = 'inconclusive';
          report.reasons.push(`${candidate}-${baseline}/${slice}/${metric.id}: paired uncertainty includes a decline`);
        }
      }
    }
    for (const constraint of profile.native_constraints ?? []) for (const arm of profile.arms) for (let repeat = 0; repeat < profile.repeats; repeat++) {
      const rows = rowsFor(arm, repeat);
      const select = (side: { metric: string; slice: string }): number => {
        const metric = profile.metrics.find(m => m.id === side.metric)!;
        const ids = profile.probes.filter(p => (side.slice === 'all' || p.slices.includes(side.slice)) && metricApplies(metric, p)
          && !p.no_gold_metrics.includes(metric.id) && !p.positive_probe_metrics?.includes(metric.id)).map(p => p.probe_id);
        return aggregateRegressionMetric(rows.filter(r => ids.includes(r.probe_id)).map(r => r.metrics[metric.id] as RegressionObservationValue), metric);
      };
      let left = select(constraint.left), right = constraint.right ? select(constraint.right) : NaN;
      if (constraint.operation.startsWith('best_slice')) {
        const best = profile.required_slices.filter(s => s.startsWith(constraint.slice_prefix!)).map(slice => ({ slice, value: select({ metric: constraint.selection_metric ?? constraint.left.metric, slice }) })).sort((a, b) => b.value - a.value)[0];
        left = select({ metric: constraint.left.metric, slice: best.slice });
        if (constraint.right) right = select({ metric: constraint.right.metric, slice: best.slice });
      }
      const value = constraint.operation === 'best_slice' ? left : constraint.operation === 'difference' ? left - right : right === 0 ? NaN : left / right;
      if (violatesBound(value, constraint)) {
        report.status = 'regressed';
        report.reasons.push(`${arm}@${repeat}/${constraint.id}: native cross-arm/slice bound failed (${value})`);
      }
    }
    if (eligibilityChanged) report.status = 'blocked';
  }
  const cat36 = manifest.statistics.cat36;
  const primary = comparisons.find(c => c.profile_id === cat36.profile_id && c.metric === cat36.metric && c.slice === cat36.slice && c.candidate === 'C1' && c.baseline === 'B');
  if (!primary || primary.delta < 0.1 || primary.lower95 <= 0) reasons.push('Cat36 needs >=10pp indirect gain and a family-clustered 95% lower bound >0');
  const opportunities = manifest.statistics.opportunities.map(o => comparisons.find(c => c.profile_id === o.profile_id && c.metric === o.metric && c.slice === o.slice && c.candidate === 'C1' && c.baseline === 'B'));
  const adjusted = holmAdjusted(opportunities.map(c => c?.p_value ?? 1));
  opportunities.forEach((c, index) => { if (c) c.holm_p_value = adjusted[index]; });
  if (!opportunities.some(c => c && c.delta > 0 && c.lower95 > 0 && c.holm_p_value! <= 0.05)) reasons.push('no Holm-corrected preregistered existing retrieval gain');
  const status = coverage.some(c => c.status === 'blocked') ? 'blocked'
    : coverage.some(c => c.status === 'regressed') ? 'regressed'
    : reasons.length || coverage.some(c => c.status === 'inconclusive') ? 'inconclusive' : 'pass';
  return { status, reasons, coverage, comparisons };
}

if (import.meta.main) {
  const [command, manifestFile, resultsFile] = process.argv.slice(2);
  if (command === 'inventory') {
    const blockers = inspectRegressionInventory();
    console.log(JSON.stringify({ inventory, blockers }, null, 2));
    process.exitCode = blockers.length ? 2 : 0;
  } else if (command === 'compare' && manifestFile && resultsFile) {
    try {
      const decision = compareSituationRecall(JSON.parse(readFileSync(manifestFile, 'utf8')), JSON.parse(readFileSync(resultsFile, 'utf8')));
      console.log(JSON.stringify(decision, null, 2));
      process.exitCode = decision.status === 'pass' ? 0 : decision.status === 'regressed' ? 1 : 2;
    } catch (error) { console.error(String(error)); process.exitCode = 2; }
  } else if (command === 'collect' && manifestFile && resultsFile) {
    try {
      const { collectSituationNativeEvidence } = await import('./situation-recall-native.ts');
      const result = await collectSituationNativeEvidence(JSON.parse(readFileSync(manifestFile, 'utf8')), JSON.parse(readFileSync(resultsFile, 'utf8')));
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.accounting.n_scored === result.accounting.n_total && result.accounting.publishable ? 0 : 2;
    } catch (error) { console.error(String(error)); process.exitCode = 2; }
  } else {
    console.error('Usage: bun eval/runner/situation-recall-regression.ts inventory | compare <manifest.json> <cell-results.json> | collect <profile.json> <native-artifact.json>');
    process.exitCode = 2;
  }
}
