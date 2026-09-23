import type { Cat36BuildReceipt, Cat36Profile, Cat36Row } from './cat36-associative-retrieval.ts';
import type { Cat36Corpus } from './cat36-corpus.ts';
import { cat36RuntimeSourceId } from './cat36-production.ts';
import type { Receipt } from './receipt.ts';
import type {
  RegressionCellSpec, RegressionManifest, RegressionProbeSpec, RegressionProvenance, RegressionReceiptData,
} from './situation-recall-contract.ts';
import { effectiveRegressionConfig, regressionHash, SITUATION_RECALL_INVENTORY } from './situation-recall-regression.ts';
import { normalizeNativeProbeError } from './situation-recall-native.ts';

const metricIds = [
  'all_evidence_in_top5_chunks', 'page_recall_at5', 'page_precision_at5', 'page_mrr', 'page_ndcg_at5',
  'associative_false_fire', 'negative_result_count', 'returned_evidence_tokens', 'safety_violations',
] as const;

export function cat36RegressionProbeSpecs(corpus: Cat36Corpus, criticalIds: readonly string[]): RegressionProbeSpec[] {
  const families = new Map(corpus.families.map(f => [f.id, f]));
  const heldout = corpus.probes.filter(p => families.get(p.family_id)?.split === 'holdout');
  if (criticalIds.some(id => !heldout.some(p => p.id === id))) throw new Error('unknown critical Cat36 probe');
  return heldout.map(probe => ({
    probe_id: probe.id, family_id: probe.family_id,
    slices: [...new Set([probe.kind, families.get(probe.family_id)!.domain, ...probe.tags])],
    critical: criticalIds.includes(probe.id),
    no_gold_metrics: probe.kind === 'negative' ? metricIds.slice(0, 5) : [],
    positive_probe_metrics: probe.kind === 'negative' ? [] : ['associative_false_fire', 'negative_result_count'],
  }));
}

export function cat36RegressionCueSourceBindings(corpus: Pick<Cat36Corpus, 'sources'>): Record<string, string> {
  return Object.fromEntries([...new Set(corpus.sources.filter(source => source.visibility === 'public').map(source => source.source_id))]
    .map(sourceId => [sourceId, cat36RuntimeSourceId(sourceId)]));
}

export function cat36RecordedSourceBindings(build: Pick<Cat36BuildReceipt, 'mappings'>): Record<string, string> {
  const bindings = new Map<string, string>(), reverse = new Map<string, string>();
  if (!Array.isArray(build.mappings) || !build.mappings.length) throw new Error('Cat36 source mapping evidence missing');
  for (const mapping of build.mappings) {
    const fixture = mapping.fixture_source_id, runtime = mapping.runtime_source_id;
    if (typeof fixture !== 'string' || !fixture || typeof runtime !== 'string' || runtime !== cat36RuntimeSourceId(fixture)
      || (bindings.has(fixture) && bindings.get(fixture) !== runtime)
      || (reverse.has(runtime) && reverse.get(runtime) !== fixture)) throw new Error('Cat36 source mapping is not the recorded one-to-one fixture alias projection');
    bindings.set(fixture, runtime);
    reverse.set(runtime, fixture);
  }
  return Object.fromEntries(bindings);
}

export function toCat36RegressionData(receipt: Receipt, context: {
  manifest: RegressionManifest;
  cell: RegressionCellSpec;
  provenance: RegressionProvenance;
  spend: RegressionReceiptData['spend'];
}): RegressionReceiptData {
  const { manifest, cell, provenance, spend } = context;
  const profile = manifest.profiles.find(p => p.id === cell.profile_id);
  if (!profile || profile.category !== 'cat36' || !manifest.cells.some(c => regressionHash(c) === regressionHash(cell))) throw new Error('Cat36 cell/profile not in frozen registration');
  if (receipt.category !== 'cat36-associative-retrieval' || receipt.data?.mode !== 'live' || receipt.data?.runtime_kind !== 'production'
    || receipt.data?.relevance_review_approved !== true || receipt.publishable !== true) throw new Error('Cat36 offline/unreviewed/nonproduction/incomplete evidence cannot be promoted');
  const native = receipt.resolved_config?.profile as Cat36Profile | undefined;
  const build = receipt.data.build as Cat36BuildReceipt | undefined;
  if (!native || native.split !== 'holdout' || native.mode !== 'live' || native.arm !== cell.arm || receipt.resolved_config?.raw_chunk_limit !== 5
    || !build || build.complete !== true || build.mode !== 'live') throw new Error('Cat36 holdout/arm/raw-five-chunk/build contract mismatch');
  if (native.token_budget !== profile.output_token_budget || native.counterfactual || native.reuse_build_dir
    || regressionHash(native.search_config) !== regressionHash(Object.fromEntries(Object.entries(profile.config).filter(([key]) => key.startsWith('search.'))))) throw new Error('Cat36 native search/token/construction settings differ from registration');
  const sourceBindings = cat36RecordedSourceBindings(build);
  const reverseBindings = new Map(Object.entries(sourceBindings).map(([fixture, runtime]) => [runtime, fixture]));
  if (!profile.cue_source_bindings || profile.cue_sources.some(id => sourceBindings[id] !== profile.cue_source_bindings![id])) throw new Error('Cat36 enrolled fixture/runtime mapping differs from registration');
  const hashContract = SITUATION_RECALL_INVENTORY.native_contracts.cat36;
  if (!profile.native_hashes || hashContract.native_hash_keys.some(key => !/^[a-f0-9]{64}$/.test(profile.native_hashes?.[key] ?? ''))
    || Object.entries(profile.native_hashes).some(([key, value]) => receipt.hashes?.[key] !== value)
    || Object.entries(hashContract.common_hash_mapping).some(([common, nativeKey]) => profile.hashes[common as keyof typeof profile.hashes] !== receipt.hashes?.[nativeKey]
      || provenance.hashes[common as keyof typeof provenance.hashes] !== receipt.hashes?.[nativeKey])) throw new Error('Cat36 native corpus/scorer/model/prompt hash mismatch');
  const product = cell.arm === 'B' ? manifest.products.B : manifest.products.candidate;
  const archive = build.provenance.product_sha === null && build.provenance.product_tree === null && build.provenance.dirty === null;
  const validIdentity = archive ? product.package_sha256 !== undefined && build.provenance.package_sha256 === product.package_sha256
    : build.provenance.product_sha === product.sha && build.provenance.product_tree === product.tree && build.provenance.dirty === false;
  if (native.expected_product_sha !== product.sha || !validIdentity
    || build.provenance.package_path !== cell.runtime.package_path
    || build.provenance.declared_pin !== profile.declared_pin || build.provenance.package_version !== profile.package_versions[cell.arm]
    || build.provenance.fixed_source_timestamps !== true) throw new Error('Cat36 actual product provenance does not match frozen cell');
  if (build.provenance.isolated_home !== cell.runtime.home || build.provenance.database !== cell.runtime.database) throw new Error('Cat36 actual home/database namespace differs from registration');
  if (!build.provenance.file_config || regressionHash(build.provenance.file_config) !== regressionHash(provenance.file_config)) throw new Error('Cat36 actual product file-plane observation is missing or mismatched');
  if (native.provider_budget?.approval_id !== spend.enforcement_id || native.provider_budget.max_usd !== spend.reserved_usd) throw new Error('Cat36 provider admission does not match collected spend');
  const effective = effectiveRegressionConfig(profile, cell.arm);
  if (regressionHash(provenance.config) !== regressionHash(effective)) throw new Error('collector config does not match registered effective config');
  for (const [key, value] of Object.entries(effective)) {
    if (String(build.resolved_config[key]) !== value) throw new Error(`Cat36 config was not read back: ${key}`);
  }
  const rows = receipt.data.rows as Cat36Row[];
  if (!Array.isArray(rows) || new Set(rows.map(r => r.probe_id)).size !== rows.length || rows.length !== profile.probes.length) throw new Error('Cat36 duplicate/missing rows');
  const collected = rows.map(row => {
    const expected = profile.probes.find(p => p.probe_id === row.probe_id);
    const slices = [...new Set([row.kind, row.domain, ...row.tags])].sort();
    if (!expected || row.family_id !== expected.family_id || row.split !== 'holdout' || regressionHash(slices) !== regressionHash([...expected.slices].sort())) throw new Error('Cat36 probe family/slice identity mismatch');
    const tokens = row.chunks.reduce((sum, c) => sum + c.token_count, 0);
    const sutFailure = row.error?.origin === 'sut';
    if (row.error && !sutFailure) throw new Error('Cat36 infrastructure/judge failure is incomplete evidence');
    if (!row.metrics) throw new Error('Cat36 scored row lacks metrics');
    const metrics = row.metrics;
    const validFailures = sutFailure ? regressionHash(row.observation_failures) === regressionHash(['sut_error']) && row.chunks.length === 0 : row.observation_failures.length === 0;
    if (!validFailures || row.chunks.length > 5 || tokens > native.token_budget || tokens !== metrics.returned_evidence_tokens) throw new Error('Cat36 fallback or evidence budget violation');
    if (Object.keys(metrics).some(k => ![...metricIds, 'matched_span_ids', 'returned_page_ids'].includes(k))) throw new Error('unknown Cat36 metric requires explicit collector mapping');
    if (profile.metrics.some(m => !metricIds.includes(m.id as typeof metricIds[number]))) throw new Error('unsupported registered Cat36 metric mapping');
    const observation = row.metadata as { mode?: string; failures?: unknown[]; rerank_scored?: boolean; result_count?: number } | null;
    if (!sutFailure && (!observation || observation.mode !== 'hybrid' || !Array.isArray(observation.failures) || observation.failures.length
      || observation.result_count !== row.chunks.length || (native.search_config['search.reranker.enabled'] === 'true' && row.chunks.length > 0 && observation.rerank_scored !== true)
      || (native.search_config['search.reranker.enabled'] === 'false' && observation.rerank_scored !== false))) throw new Error('Cat36 search/reranker observation missing or mismatched');
    const expectedMode = cell.arm === 'C1' ? 'on' : 'off';
    if (row.cue.mode !== expectedMode || !Number.isSafeInteger(row.cue.candidates) || row.cue.candidates < row.cue.admitted) throw new Error('Cat36 cue execution observation mismatch');
    return {
      probe_id: row.probe_id,
      metrics: Object.fromEntries(profile.metrics.map(m => [m.id, metrics[m.id as typeof metricIds[number]]])),
      ...(row.error ? { error: normalizeNativeProbeError({ probe_id: row.probe_id, ...row.error }) } : {}),
      feature: { attempted: row.cue.mode === 'on', status: row.cue.status, ...(row.cue.reason === undefined ? {} : { reason: row.cue.reason }), admitted: row.cue.admitted },
    };
  });
  const generation = build.generation;
  const on = cell.arm === 'C1';
  if (on && (!['generated', 'empty_windows', 'rejected_windows'].every(k => Number.isSafeInteger(generation[k]) && (generation[k] as number) >= 0)
    || !Array.isArray(generation.covered_sources) || !(generation.covered_sources as unknown[]).every(s => typeof s === 'string')
    || generation.generated_unit !== 'completed nonempty windows, not cue count'
    || !/^[a-f0-9]{64}$/.test(receipt.hashes?.build ?? '') || regressionHash([...build.families].sort()) !== regressionHash(['horizon', 'scene']))) throw new Error('Cat36 production generation counters/coverage/families/build hash unavailable');
  const coveredSources = on ? generation.covered_sources as string[] : [];
  if (new Set(coveredSources).size !== coveredSources.length || coveredSources.some(id => !reverseBindings.has(id))) throw new Error('Cat36 covered source IDs are duplicated or absent from the recorded alias map');
  const expectedReranker = native.search_config['search.reranker.enabled'] === 'true' ? native.search_config['search.reranker.model'] : 'none';
  if (profile.reranker !== expectedReranker) throw new Error('Cat36 registered reranker mismatch');
  return {
    schema_version: 1, run_id: manifest.run_id, cell_id: cell.id, manifest_sha256: regressionHash(manifest), mode: 'live',
    provenance, rows: collected,
    feature: {
      supported: build.feature_supported, read_mode: on ? 'on' : 'off', production_generation: build.generation_observed,
      build_complete: on && build.complete,
      build_receipt_sha256: on ? receipt.hashes!.build : null,
      generated: on ? generation.generated as number : 0,
      ...(on ? { generated_unit: 'ready_windows' } : {}),
      empty_windows: on ? generation.empty_windows as number : 0,
      rejected_windows: on ? generation.rejected_windows as number : 0,
      covered_sources: coveredSources.map(id => reverseBindings.get(id)!),
    },
    observed: { reranker: expectedReranker, fallback: false, source_timestamps_frozen: true }, spend,
  };
}
