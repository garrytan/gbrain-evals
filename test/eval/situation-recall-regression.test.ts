import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  clusteredRegressionStatistics, compareSituationRecall, compareRegressionMeasurements, effectiveRegressionConfig, holmAdjusted,
  aggregateRegressionMetric,
  nativeRegressionContract,
  effectiveRegressionFileConfig,
  profileBudget, regressionHash, SITUATION_RECALL_INVENTORY, validateRegressionCell, validateRegressionManifest, validateRegressionRegistration,
  type RegressionCellResult, type RegressionManifest, type RegressionMetricSpec, type RegressionProbeSpec,
  type RegressionProfile, type RegressionReceiptData,
  type RegressionNativeContract,
} from '../../eval/runner/situation-recall-regression.ts';
import {
  isolatedRegressionEnvironment, orchestrateSituationRecall, reserveRegressionBudget, regressionChildArguments,
} from '../../eval/runner/situation-recall-orchestration.ts';
import { regressionPackageHash, resolveRegressionProduct } from '../../eval/runner/situation-recall-provenance.ts';
import { toCat36RegressionData, cat36RecordedSourceBindings } from '../../eval/runner/situation-recall-cat36.ts';
import { offlineCat36Profile, type Cat36Row } from '../../eval/runner/cat36-associative-retrieval.ts';
import { cat36RuntimeSourceId } from '../../eval/runner/cat36-production.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION } from '../../eval/runner/receipt.ts';
import { normalizeNativeProbeError } from '../../eval/runner/situation-recall-native.ts';

const SHA = 'a'.repeat(40), CANDIDATE = 'b'.repeat(40), HASH = 'c'.repeat(64);
const domains = ['constraints', 'preferences', 'commitments', 'changing-decisions', 'causal-context'];
const positiveMetrics = ['all_evidence_in_top5_chunks', 'page_recall_at5', 'page_precision_at5', 'page_mrr', 'page_ndcg_at5'];
const negativeMetrics = ['associative_false_fire', 'negative_result_count'];
const primary: RegressionMetricSpec = { id: 'success', direction: 'higher', range: [0, 1], aggregation: 'mean', primary: true, floor: 0 };

function fixture(): { manifest: RegressionManifest; results: RegressionCellResult[] } {
  const profiles: RegressionProfile[] = SITUATION_RECALL_INVENTORY.categories.flatMap(category => category.profiles.map(id => {
    const enabled = category.cue_eligible && !(('compatibility_profiles' in category ? category.compatibility_profiles : []) ?? []).includes(id);
    const probes: RegressionProbeSpec[] = id === 'cat36' ? Array.from({ length: 80 }, (_, family) => Array.from({ length: 4 }, (_, index) => {
      const kind = index < 2 ? 'indirect' : index === 2 ? 'direct' : 'negative';
      return {
        probe_id: `p${family}-${index}`, family_id: `f${family}`,
        slices: [kind, domains[Math.floor(family / 16)], ...(index === 0 ? ['multi-evidence'] : [])],
        critical: kind === 'direct', no_gold_metrics: kind === 'negative' ? positiveMetrics : [],
        positive_probe_metrics: kind === 'negative' ? [] : negativeMetrics,
      };
    })).flat() : Array.from({ length: 16 }, (_, i) => ({ probe_id: `p${i}`, family_id: `f${i}`, slices: [i < 8 ? 'first' : 'second'], critical: i === 0, no_gold_metrics: [] }));
    return {
      id, category: category.id, receipt_category: id === 'cat36' ? 'cat36-associative-retrieval' : category.id,
      mode: enabled ? 'live' : 'hermetic', arms: enabled ? ['B', 'C0', 'C1'] : ['B', 'C0'], repeats: enabled ? 2 : 1,
      probes,
      metrics: id === 'cat36' ? [...positiveMetrics, ...negativeMetrics, 'returned_evidence_tokens', 'safety_violations'].map(metric => ({
        id: metric, direction: positiveMetrics.includes(metric) ? 'higher' as const : 'lower' as const,
        range: [0, metric === 'returned_evidence_tokens' ? 1000 : metric === 'negative_result_count' ? 5 : 1] as [number, number],
        aggregation: 'mean' as const, primary: metric === 'all_evidence_in_top5_chunks',
        ...(metric === 'safety_violations' ? { ceiling: 0 } : {}),
      })) : [{ ...primary }],
      required_slices: id === 'cat36' ? ['indirect', 'direct', 'negative', ...domains, 'multi-evidence'] : ['first', 'second'],
      cue_sources: enabled ? ['fixture-source'] : [],
      ...(id === 'cat36' ? { cue_source_bindings: { 'fixture-source': cat36RuntimeSourceId('fixture-source') }, output_token_budget: 4096 } : {}),
      config: id === 'cat36' ? offlineCat36Profile().search_config : { 'search.mode': 'balanced', 'search.reranker.enabled': 'false' },
      file_config: { engine: 'pglite', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 },
      cue_config: enabled ? { 'memory.cues.min_similarity': '0.7', 'memory.cues.weight': '0.25', 'memory.cues.sources': JSON.stringify([id === 'cat36' ? cat36RuntimeSourceId('fixture-source') : 'fixture-source']) } : {},
      hashes: { corpus: HASH, gold: HASH, queries: HASH, runner: HASH, scorer: HASH, models: HASH, prompts: HASH, source_timestamps: HASH },
      native_hashes: id === 'cat36' ? Object.fromEntries(SITUATION_RECALL_INVENTORY.native_contracts.cat36.native_hash_keys.map(k => [k, HASH])) : undefined,
      native_contract_sha256: HASH,
      reranker: 'none', declared_pin: 'github:garrytan/gbrain#' + SHA,
      package_versions: { B: 'baseline', C0: 'candidate', C1: 'candidate' },
      clock: '2026-09-23T00:00:00.000Z', timeout_ms: 600000,
      prerequisites: { supported: true, runner: category.runner ?? 'eval/runner/test-namedthing-driver.ts', evidence_sha256: HASH },
      budget: { construction_usd: enabled ? 1 : 0, embedding_usd: 0, reranking_usd: 0, judging_usd: 0, agent_usd: 0, enforcement: enabled ? 'isolated-provider-hard-limit' : 'none' },
    } as RegressionProfile;
  }));
  const manifest: RegressionManifest = {
    schema_version: 1, run_id: 'synthetic-unit-fixture-not-measurements', registered_at: '2026-09-23T00:00:00.000Z', expires_at: '2026-09-24T00:00:00.000Z',
    eval_sha: SHA, inventory_sha256: regressionHash(SITUATION_RECALL_INVENTORY),
    products: { B: { sha: SHA, tree: SHA }, candidate: { sha: CANDIDATE, tree: CANDIDATE } }, profiles,
    cells: profiles.flatMap(p => p.arms.flatMap(arm => Array.from({ length: p.repeats }, (_, repeat) => {
      const id = `${p.id}-${arm}-${repeat}`, root = `/isolated/${id}`;
      return { id, profile_id: p.id, arm, repeat, runtime: {
        root, eval_root: `${root}/eval`, product_root: `${root}/product`, package_path: `${root}/product`,
        home: `${root}/home`, config: `${root}/home/.gbrain/config.json`, database: `${root}/database`, output: `${root}/output`,
      } };
    }))), max_usd: 1000,
    statistics: { seed: 42, draws: 10000, cat36: { profile_id: 'cat36', metric: 'all_evidence_in_top5_chunks', slice: 'indirect' }, opportunities: [
      { profile_id: 'cat13', metric: 'success', slice: 'all' }, { profile_id: 'cat13b', metric: 'success', slice: 'all' },
      { profile_id: 'cat26', metric: 'success', slice: 'all' }, { profile_id: 'longmemeval', metric: 'success', slice: 'all' },
    ] },
  };
  const manifestHash = regressionHash(manifest);
  const results: RegressionCellResult[] = manifest.cells.map(cell => {
    const p = profiles.find(p => p.id === cell.profile_id)!;
    const product = cell.arm === 'B' ? manifest.products.B : manifest.products.candidate;
    const data: RegressionReceiptData = {
      schema_version: 1, run_id: manifest.run_id, cell_id: cell.id, manifest_sha256: manifestHash, mode: p.mode,
      provenance: {
        eval_sha: SHA, eval_dirty: false, product, product_dirty: false, declared_pin: p.declared_pin,
        package_version: p.package_versions[cell.arm],
        bindings: Object.fromEntries(['package', 'deep_import', 'GBRAIN_SRC', 'GBRAIN_REPO'].map(key => [key, { ...product, path: cell.runtime.product_root }])) as RegressionReceiptData['provenance']['bindings'],
        hashes: p.hashes, config: effectiveRegressionConfig(p, cell.arm), clock: p.clock, runtime: cell.runtime,
        file_config: { path: cell.runtime.config, values: effectiveRegressionFileConfig(p, cell) },
      },
      rows: p.probes.map(probe => ({
        probe_id: probe.probe_id,
        metrics: Object.fromEntries(p.metrics.map(m => [m.id, probe.no_gold_metrics.includes(m.id) ? { not_applicable: 'no_gold' }
          : probe.positive_probe_metrics?.includes(m.id) ? { not_applicable: 'positive_probe' }
          : m.id === 'all_evidence_in_top5_chunks' ? (cell.arm === 'C1' && probe.slices.includes('indirect') ? 1 : 0)
          : m.id === 'returned_evidence_tokens' ? 10
          : m.direction === 'lower' ? 0
          : p.category === 'cat13' && cell.arm === 'C1' ? 1 : 0.5])),
        feature: { attempted: cell.arm === 'C1', status: cell.arm === 'C1' ? 'ready' : 'skipped', admitted: cell.arm === 'C1' ? 1 : 0 },
      })),
      feature: {
        supported: cell.arm !== 'B', read_mode: cell.arm === 'C1' ? 'on' : 'off', production_generation: cell.arm === 'C1',
        build_complete: cell.arm === 'C1',
        build_receipt_sha256: cell.arm === 'C1' ? HASH : null, generated: cell.arm === 'C1' ? 1 : 0,
        empty_windows: 0, rejected_windows: 0, covered_sources: cell.arm === 'C1' ? p.cue_sources : [],
      },
      observed: { reranker: p.reranker, fallback: false, source_timestamps_frozen: true },
      spend: { reserved_usd: profileBudget(p), actual_usd: 0, enforcement_id: profileBudget(p) ? 'test-hard-limit' : null },
    };
    return { cell_id: cell.id, exit_code: 0, started_at: '2026-09-23T01:00:00.000Z', finished_at: '2026-09-23T01:00:03.000Z', receipt: {
      schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: p.receipt_category, run_status: 'completed', verdict: 'pass',
      n_total: p.probes.length, n_scored: p.probes.length, completion_rate: 1, errors: [], publishable: true,
      gbrain_pin: p.declared_pin, gbrain_version: p.package_versions[cell.arm], started_at: '2026-09-23T01:00:01.000Z', finished_at: '2026-09-23T01:00:02.000Z',
      data: { regression: data },
    } };
  });
  return { manifest, results };
}

function resign(manifest: RegressionManifest, results: RegressionCellResult[]): void {
  const hash = regressionHash(manifest);
  for (const result of results) (result.receipt!.data!.regression as RegressionReceiptData).manifest_sha256 = hash;
}

function measurements(manifest: RegressionManifest, results: RegressionCellResult[]) {
  const result = compareRegressionMeasurements(manifest, results);
  expect(result.release_eligible).toBe(false);
  return result.measurement_decision;
}

describe('full situation recall coverage inventory', () => {
  test('lists every actual category, suffix, standalone and explicit absence', () => {
    const ids = new Set(SITUATION_RECALL_INVENTORY.categories.map(c => c.id));
    for (const n of [...Array.from({ length: 15 }, (_, i) => i + 1), ...Array.from({ length: 19 }, (_, i) => i + 18)]) expect(ids.has(`cat${n}`)).toBe(true);
    for (const id of ['cat13b', 'cat18b', 'longmemeval', 'precisionmembench', 'multi-adapter', 'relational', 'namedthing']) expect(ids.has(id)).toBe(true);
    expect(SITUATION_RECALL_INVENTORY.absent_categories).toEqual(['cat16', 'cat17']);
    expect(SITUATION_RECALL_INVENTORY.categories.find(c => c.id === 'namedthing')!.runner).toBe('node_modules/gbrain/scripts/r1-namedthing-rerank-ab.ts');
  });

  test('every required profile has a machine-readable native contract and no guessed native floor', () => {
    for (const category of SITUATION_RECALL_INVENTORY.categories) for (const id of category.profiles) {
      const contract = nativeRegressionContract({ id, category: category.id });
      expect(contract).toBeDefined();
      expect(contract!.metrics.some(m => m.primary)).toBe(true);
      for (const metric of contract!.metrics) {
        expect(metric.range.every(Number.isFinite)).toBe(true);
        for (const slice of [...(metric.applies_to ?? []), ...(metric.bound_slices ?? []), ...(metric.slice_bounds ?? []).map(b => b.slice)]) {
          expect(slice === 'all' || contract!.required_slices.includes(slice)).toBe(true);
        }
      }
    }
    const perf = nativeRegressionContract({ id: 'cat7', category: 'cat7' })!;
    expect(perf.metrics.filter(m => m.ceiling !== undefined || m.slice_bounds?.some(b => b.ceiling !== undefined)).map(m => m.id)).toEqual(['search_keyword@10000.p95_ms']);
    const federation = nativeRegressionContract({ id: 'cat28', category: 'cat28' })!;
    expect(federation.metrics.filter(m => m.id.includes('_ms')).every(m => m.ceiling === undefined)).toBe(true);
    const mapped = SITUATION_RECALL_INVENTORY.native_contracts as unknown as Record<string, RegressionNativeContract>;
    expect(mapped.cat13.metrics.find(m => m.id === 'gbrain.ndcg5')!.floor_exclusive).toBe(true);
    expect(mapped.cat31.constraints!.find(c => c.id === 'loopLifts')!.floor_exclusive).toBe(true);
    expect(mapped.namedthing.metrics.find(m => m.id === 'hit_at_3_losses')!.ceiling).toBe(1);
    expect(mapped.cat22.evidence_blockers).toEqual([]);
    expect(mapped['cat22-associative-dev-v1'].evidence_blockers!.length).toBeGreaterThan(0);
    expect(mapped.cat26.evidence_blockers).toEqual([]);
    for (const [category, count] of [['cat22', 12], ['cat23', 7], ['cat27', 6], ['cat34', 5]] as const) {
      const contract = mapped[`${category}-associative-dev-v1`];
      expect(contract.expected_probes!.length).toBe(count);
      expect(contract.completed_verdicts).toEqual(['pass', 'fail']);
      expect(contract.metrics.find(m => m.id === 'probe_success')!.bound_arms).toEqual(['C1']);
    }
    expect(mapped['longmemeval-answers'].receipt_category).toBe('longmemeval-answers');
  });

  test('release validation discovers a new category even with a freshly hashed old inventory', () => {
    const root = mkdtempSync(join(tmpdir(), 'regression-tree-'));
    try {
      for (const category of SITUATION_RECALL_INVENTORY.categories) {
        if (!category.runner) continue;
        const path = join(root, category.runner);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, '');
      }
      writeFileSync(join(root, 'eval/runner/cat37-unregistered.ts'), 'export const newlyAddedCategory = true;');
      const { manifest, results } = fixture();
      expect(manifest.inventory_sha256).toBe(regressionHash(SITUATION_RECALL_INVENTORY));
      expect(validateRegressionManifest(manifest, { evalRoot: root }).join(';')).toContain('untriaged category runner: eval/runner/cat37-unregistered.ts');
      expect(compareSituationRecall(manifest, results, { evalRoot: root }).reasons.join(';')).toContain('cat37-unregistered.ts');
      expect(compareRegressionMeasurements(manifest, results).measurement_decision.status).toBe('pass');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('validates a complete synthetic preregistration and rejects category deletion', () => {
    const { manifest } = fixture();
    expect(validateRegressionRegistration(manifest)).toEqual([]);
    manifest.profiles = manifest.profiles.filter(p => p.id !== 'cat5');
    expect(validateRegressionManifest(manifest).join(';')).toContain('profiles missing');
  });

  test('mapped native metrics cannot turn a dummy metric and loose floor into release proof', () => {
    const { manifest, results } = fixture();
    const decision = compareSituationRecall(manifest, results);
    expect(decision.status).toBe('blocked');
    expect(decision.reasons.some(r => r.startsWith('cat1: native metric IDs/directions/floors changed'))).toBe(true);
    expect(decision.reasons.some(r => r.includes('mapping is not implemented'))).toBe(false);
    expect(decision.reasons.some(r => r.startsWith('cat5: native metric IDs/directions/floors changed'))).toBe(true);
    const cat36 = manifest.profiles.find(p => p.id === 'cat36')!;
    const contract = SITUATION_RECALL_INVENTORY.native_contracts.cat36;
    cat36.metrics = structuredClone(contract.metrics) as RegressionMetricSpec[];
    cat36.native_contract_sha256 = regressionHash(contract);
    expect(validateRegressionManifest(manifest).some(r => r.startsWith('cat36: native'))).toBe(false);
    cat36.metrics.find(m => m.id === 'safety_violations')!.ceiling = 1;
    expect(validateRegressionManifest(manifest).some(r => r.includes('cat36: native metric'))).toBe(true);
  });

  test.each(['direction', 'floor', 'hash', 'probes', 'slices', 'unsupported', 'budget', 'isolation', 'holdout'] as const)('blocks invalid frozen %s', kind => {
    const { manifest } = fixture();
    const p = manifest.profiles[0];
    if (kind === 'direction') p.metrics[0].direction = 'sideways' as never;
    if (kind === 'floor') p.metrics[0].floor = NaN;
    if (kind === 'hash') p.hashes.gold = 'unknown';
    if (kind === 'probes') p.probes[1].probe_id = p.probes[0].probe_id;
    if (kind === 'slices') p.required_slices.push('absent');
    if (kind === 'unsupported') p.prerequisites.supported = false;
    if (kind === 'budget') manifest.max_usd = 0;
    if (kind === 'isolation') manifest.cells[1].runtime.root = manifest.cells[0].runtime.root;
    if (kind === 'holdout') manifest.profiles.find(p => p.id === 'cat36')!.probes.pop();
    expect(validateRegressionManifest(manifest).length).toBeGreaterThan(0);
  });
});

describe('strict per-cell common receipt accounting', () => {
  test('native row errors use the same truncation as common receipt accounting', () => {
    const error = normalizeNativeProbeError({ probe_id: 'p0', origin: 'sut', message: 'x'.repeat(800) });
    expect(error.message).toBe('x'.repeat(500) + '…');
    expect(normalizeNativeProbeError(error)).toEqual(error);
  });
  test.each([
    'nonzero-exit', 'crash', 'missing', 'skipped', 'partial', 'nonpublishable', 'stale', 'mixed-sha', 'dirty', 'config',
    'gold', 'denominator', 'missing-row', 'duplicate-row', 'extra-row', 'NaN', 'Infinity', 'range', 'tagged-primary',
    'unknown-metric', 'missing-metric', 'unexercised', 'no-build', 'fallback', 'infra', 'sut-not-miss', 'spend', 'wrong-category',
  ])('blocks %s instead of accepting exit-code/aggregate success', kind => {
    const { manifest, results } = fixture();
    const cell = manifest.cells.find(c => c.profile_id === 'cat13' && c.arm === 'C1')!;
    const result = results.find(r => r.cell_id === cell.id)!;
    const r = result.receipt!, d = r.data!.regression as RegressionReceiptData;
    if (kind === 'nonzero-exit') result.exit_code = 1;
    if (kind === 'crash') result.exit_code = null;
    if (kind === 'missing') result.receipt = null;
    if (kind === 'skipped') { r.run_status = 'skipped'; delete r.verdict; r.skip_reason = 'no key'; }
    if (kind === 'partial') r.verdict = 'partial';
    if (kind === 'nonpublishable') r.publishable = false;
    if (kind === 'stale') r.started_at = '2025-01-01T00:00:00.000Z';
    if (kind === 'mixed-sha') d.provenance.bindings.GBRAIN_REPO.sha = SHA;
    if (kind === 'dirty') d.provenance.product_dirty = true;
    if (kind === 'config') d.provenance.config['search.mode'] = 'tokenmax';
    if (kind === 'gold') d.provenance.hashes = { ...d.provenance.hashes, gold: 'd'.repeat(64) };
    if (kind === 'denominator') r.n_scored--;
    if (kind === 'missing-row') d.rows.pop();
    if (kind === 'duplicate-row') d.rows[1] = d.rows[0];
    if (kind === 'extra-row') d.rows.push({ ...d.rows[0], probe_id: 'not-expected' });
    if (kind === 'NaN') d.rows[0].metrics.success = NaN;
    if (kind === 'Infinity') d.rows[0].metrics.success = Infinity;
    if (kind === 'range') d.rows[0].metrics.success = 2;
    if (kind === 'tagged-primary') d.rows[0].metrics.success = { not_applicable: 'no_gold' };
    if (kind === 'unknown-metric') d.rows[0].metrics.unknown = 1;
    if (kind === 'missing-metric') delete d.rows[0].metrics.success;
    if (kind === 'unexercised') d.rows[0].feature!.status = 'skipped';
    if (kind === 'no-build') d.feature.generated = 0;
    if (kind === 'fallback') d.observed.fallback = true;
    if (kind === 'infra' || kind === 'sut-not-miss') {
      const error = { probe_id: d.rows[0].probe_id, origin: kind === 'infra' ? 'dependency' as const : 'sut' as const, message: 'fixture failure' };
      d.rows[0].error = error;
      r.errors.push(error);
    }
    if (kind === 'spend') d.spend.actual_usd = 2;
    if (kind === 'wrong-category') r.category = 'another-native-runner';
    expect(validateRegressionCell(manifest, cell, result).length).toBeGreaterThan(0);
  });

  test('SUT misses remain in complete matched denominators', () => {
    const { manifest, results } = fixture();
    const cell = manifest.cells.find(c => c.profile_id === 'cat1' && c.arm === 'C0')!;
    const result = results.find(r => r.cell_id === cell.id)!;
    const d = result.receipt!.data!.regression as RegressionReceiptData;
    const error = { probe_id: d.rows[0].probe_id, origin: 'sut' as const, message: 'SUT miss' };
    d.rows[0].error = error;
    d.rows[0].metrics.success = 0;
    result.receipt!.errors.push(error);
    expect(validateRegressionCell(manifest, cell, result)).toEqual([]);
  });

  test('baseline B need not support the candidate feature API', () => {
    const { manifest, results } = fixture();
    const cell = manifest.cells.find(c => c.profile_id === 'cat13' && c.arm === 'B')!;
    expect(validateRegressionCell(manifest, cell, results.find(r => r.cell_id === cell.id)!)).toEqual([]);
  });

  test('completed empty production generation is scored rather than called an unexercised arm', () => {
    const { manifest, results } = fixture();
    const cell = manifest.cells.find(c => c.profile_id === 'cat13' && c.arm === 'C1')!;
    const result = results.find(r => r.cell_id === cell.id)!;
    const d = result.receipt!.data!.regression as RegressionReceiptData;
    d.feature.generated = 0;
    d.feature.empty_windows = 5;
    d.rows.forEach(row => row.feature = { attempted: true, status: 'empty', admitted: 0 });
    expect(validateRegressionCell(manifest, cell, result)).toEqual([]);
    d.feature.build_complete = false;
    expect(validateRegressionCell(manifest, cell, result).join(';')).toContain('build/source coverage missing');
  });

  test.each(['candidate_budget', 'iterative_scan_unavailable', 'evidence_budget_incomplete'])('bounded cue outcome %s remains a scored positive miss and clean negative', reason => {
    const { manifest, results } = fixture();
    const cell = manifest.cells.find(c => c.profile_id === 'cat36' && c.arm === 'C1')!;
    const result = results.find(r => r.cell_id === cell.id)!;
    const data = result.receipt!.data!.regression as RegressionReceiptData;
    const positive = data.rows.find(r => r.probe_id === 'p0-0')!, negative = data.rows.find(r => r.probe_id === 'p0-3')!;
    for (const row of [positive, negative]) row.feature = { attempted: true, status: 'degraded', reason, admitted: 0 };
    positive.metrics.all_evidence_in_top5_chunks = 0;
    negative.metrics.associative_false_fire = 0;
    negative.metrics.negative_result_count = 0;
    expect(validateRegressionCell(manifest, cell, result)).toEqual([]);
    expect(result.receipt!.n_scored).toBe(320);
    expect(result.receipt!.errors).toEqual([]);
    positive.feature!.reason = 'deadline';
    expect(validateRegressionCell(manifest, cell, result).join(';')).toContain('cue arm unexercised');
  });

  test('verified package archives preserve unknown git fields rather than claiming a loaded SHA', () => {
    const { manifest, results } = fixture();
    const cell = manifest.cells.find(c => c.profile_id === 'cat13' && c.arm === 'C1')!;
    const result = results.find(r => r.cell_id === cell.id)!;
    const d = result.receipt!.data!.regression as RegressionReceiptData;
    manifest.products.candidate.package_sha256 = HASH;
    d.provenance.product = { sha: null, tree: null, package_sha256: HASH };
    d.provenance.product_dirty = null;
    for (const binding of Object.values(d.provenance.bindings)) Object.assign(binding, { sha: null, tree: null, package_sha256: HASH });
    resign(manifest, results);
    expect(validateRegressionCell(manifest, cell, result)).toEqual([]);
    d.provenance.bindings.GBRAIN_SRC.package_sha256 = 'd'.repeat(64);
    expect(validateRegressionCell(manifest, cell, result).join(';')).toContain('GBRAIN_SRC');
    d.provenance.bindings.GBRAIN_SRC.package_sha256 = HASH;
    delete manifest.products.candidate.package_sha256;
    resign(manifest, results);
    expect(validateRegressionCell(manifest, cell, result).join(';')).toContain('unverified archive');
  });

  test('native output-dependent empty precision is tagged and unequal paired eligibility blocks', () => {
    const { manifest, results } = fixture();
    const profile = manifest.profiles.find(p => p.id === 'cat2')!;
    profile.metrics[0].native_not_applicable = 'empty_gold_and_empty_results';
    for (const result of results.filter(r => r.cell_id.startsWith('cat2-'))) {
      const data = result.receipt!.data!.regression as RegressionReceiptData;
      data.rows[0].metrics.success = { not_applicable: 'native_no_denominator', evidence: { expected_count: 0, returned_count: 0 } };
    }
    resign(manifest, results);
    expect(measurements(manifest, results).coverage.find(c => c.profile_id === 'cat2')!.status).toBe('pass');
    const candidate = results.find(r => r.cell_id === 'cat2-C0-0')!;
    (candidate.receipt!.data!.regression as RegressionReceiptData).rows[0].metrics.success = 0;
    expect(measurements(manifest, results).coverage.find(c => c.profile_id === 'cat2')!.status).toBe('blocked');
    const bad = (candidate.receipt!.data!.regression as RegressionReceiptData).rows[0];
    bad.metrics.success = { not_applicable: 'native_no_denominator', evidence: { expected_count: 0, returned_count: 1 } };
    expect(validateRegressionCell(manifest, manifest.cells.find(c => c.id === candidate.cell_id)!, candidate).join(';')).toContain('missing/nonfinite');
  });
});

describe('paired non-regression and improvement decisions', () => {
  test('passes complete synthetic cells with all slices and independent clustered gains', () => {
    const { manifest, results } = fixture();
    const decision = measurements(manifest, results);
    expect(decision.reasons).toEqual([]);
    expect(decision.coverage.filter(c => c.status !== 'pass')).toEqual([]);
    expect(decision.status).toBe('pass');
  });

  test('never passes missing, duplicate or empty cells', () => {
    const { manifest, results } = fixture();
    expect(measurements(manifest, []).status).toBe('blocked');
    expect(measurements(manifest, results.slice(1)).status).toBe('blocked');
    expect(measurements(manifest, [...results, results[0]]).status).toBe('blocked');
  });

  test('a slice regression cannot be purchased with wins in another slice', () => {
    const { manifest, results } = fixture();
    const d = results.find(r => r.cell_id === 'cat2-C0-0')!.receipt!.data!.regression as RegressionReceiptData;
    d.rows.forEach((r, i) => r.metrics.success = i < 8 ? 0 : 1);
    const decision = measurements(manifest, results);
    expect(decision.status).toBe('regressed');
    expect(decision.coverage.find(c => c.profile_id === 'cat2')!.reasons.some(r => r.includes('/first/'))).toBe(true);
  });

  test('a critical known-correct probe loss blocks even with a higher mean', () => {
    const { manifest, results } = fixture();
    const d = results.find(r => r.cell_id === 'cat2-C0-0')!.receipt!.data!.regression as RegressionReceiptData;
    d.rows.forEach((r, i) => r.metrics.success = i === 0 ? 0 : 1);
    expect(measurements(manifest, results).coverage.find(c => c.profile_id === 'cat2')!.reasons.some(r => r.includes('critical'))).toBe(true);
  });

  test('native floors still apply to the baseline instead of being reset', () => {
    const { manifest, results } = fixture();
    manifest.profiles.find(p => p.id === 'cat2')!.metrics[0].floor = 0.9;
    resign(manifest, results);
    expect(measurements(manifest, results).coverage.find(c => c.profile_id === 'cat2')!.reasons.some(r => r.includes('native floor'))).toBe(true);
  });

  test('an overall native floor is not silently applied to each native slice', () => {
    const { manifest, results } = fixture();
    manifest.profiles.find(p => p.id === 'cat2')!.metrics[0].floor = 0.9;
    for (const result of results.filter(r => r.cell_id.startsWith('cat2-'))) {
      (result.receipt!.data!.regression as RegressionReceiptData).rows.forEach((row, i) => row.metrics.success = i === 0 ? 0 : 1);
    }
    resign(manifest, results);
    expect(measurements(manifest, results).coverage.find(c => c.profile_id === 'cat2')!.status).toBe('pass');
  });

  test('native strict inequalities and signed cross-split bounds retain their semantics', () => {
    const { manifest, results } = fixture();
    const profile = manifest.profiles.find(p => p.id === 'cat2')!;
    profile.native_constraints = [{ id: 'signed_gap', operation: 'difference', left: { metric: 'success', slice: 'first' }, right: { metric: 'success', slice: 'second' }, ceiling: 0.1 }];
    for (const result of results.filter(r => r.cell_id.startsWith('cat2-'))) {
      (result.receipt!.data!.regression as RegressionReceiptData).rows.forEach((row, i) => row.metrics.success = i < 8 ? 0 : 1);
    }
    resign(manifest, results);
    expect(measurements(manifest, results).coverage.find(c => c.profile_id === 'cat2')!.status).toBe('pass');
    profile.metrics[0].floor = 0.5;
    profile.metrics[0].floor_exclusive = true;
    resign(manifest, results);
    expect(measurements(manifest, results).coverage.find(c => c.profile_id === 'cat2')!.status).toBe('regressed');
  });

  test('new capability acceptance applies only to C1 while baseline misses remain measurements', () => {
    const { manifest, results } = fixture();
    const profile = manifest.profiles.find(p => p.id === 'cat23-associative-dev-v1')!;
    profile.metrics[0].probe_floor = 1;
    profile.metrics[0].bound_arms = ['C1'];
    for (const result of results.filter(r => r.cell_id.startsWith(profile.id + '-'))) {
      const on = result.cell_id.includes('-C1-');
      (result.receipt!.data!.regression as RegressionReceiptData).rows.forEach(row => row.metrics.success = on ? 1 : 0);
      result.receipt!.verdict = on ? 'pass' : 'fail';
    }
    resign(manifest, results);
    expect(measurements(manifest, results).coverage.find(c => c.profile_id === profile.id)!.status).toBe('pass');
    const candidate = results.find(r => r.cell_id === `${profile.id}-C1-0`)!;
    (candidate.receipt!.data!.regression as RegressionReceiptData).rows[0].metrics.success = 0;
    candidate.receipt!.verdict = 'fail';
    expect(measurements(manifest, results).coverage.find(c => c.profile_id === profile.id)!.status).toBe('regressed');
  });

  test('a best-adapter native floor is applied to the best mean, not the pooled mean', () => {
    const { manifest, results } = fixture();
    const profile = manifest.profiles.find(p => p.id === 'cat2')!;
    profile.required_slices.push('adapter:first', 'adapter:second');
    profile.probes.forEach((p, i) => p.slices.push(i < 8 ? 'adapter:first' : 'adapter:second'));
    profile.native_constraints = [{ id: 'best_adapter', operation: 'best_slice', left: { metric: 'success', slice: 'all' }, slice_prefix: 'adapter:', floor: 0.75 }];
    for (const result of results.filter(r => r.cell_id.startsWith('cat2-'))) {
      (result.receipt!.data!.regression as RegressionReceiptData).rows.forEach((row, i) => row.metrics.success = i < 8 ? 0.4 : 0.8);
    }
    resign(manifest, results);
    expect(measurements(manifest, results).coverage.find(c => c.profile_id === 'cat2')!.status).toBe('pass');
  });

  test('lower is better for latency and native p95 uses percentile 95', () => {
    const { manifest, results } = fixture();
    const p = manifest.profiles.find(p => p.id === 'cat7')!;
    p.metrics[0] = { id: 'success', direction: 'lower', range: [0, 1000], aggregation: 'p95', primary: true, ceiling: 100 };
    for (const result of results.filter(r => r.cell_id.startsWith('cat7-'))) {
      const d = result.receipt!.data!.regression as RegressionReceiptData;
      d.rows.forEach((row, i) => row.metrics.success = i === 15 ? 900 : 0);
    }
    resign(manifest, results);
    const decision = measurements(manifest, results);
    expect(decision.coverage.find(c => c.profile_id === 'cat7')!.status).toBe('regressed');
    expect(decision.comparisons.find(c => c.profile_id === 'cat7' && c.slice === 'all')!.baseline_value).toBe(225);
  });

  test('Cat36 alone does not establish broad retrieval improvement', () => {
    const { manifest, results } = fixture();
    for (const r of results.filter(r => r.cell_id.startsWith('cat13-C1'))) (r.receipt!.data!.regression as RegressionReceiptData).rows.forEach(row => row.metrics.success = 0.5);
    const decision = measurements(manifest, results);
    expect(decision.status).toBe('inconclusive');
    expect(decision.reasons.join(';')).toContain('Holm');
  });

  test('a statistically clear Cat36 gain below ten percentage points remains inconclusive', () => {
    const { manifest, results } = fixture();
    const probes = manifest.profiles.find(p => p.id === 'cat36')!.probes;
    for (const result of results.filter(r => r.cell_id.startsWith('cat36-C1'))) {
      const d = result.receipt!.data!.regression as RegressionReceiptData;
      d.rows.filter(row => probes.find(p => p.probe_id === row.probe_id)!.slices.includes('indirect')).forEach(row => {
        row.metrics.all_evidence_in_top5_chunks = Number(/^p(?:[0-9]|1[01])-0$/.test(row.probe_id));
      });
    }
    const decision = measurements(manifest, results);
    expect(decision.status).toBe('inconclusive');
    expect(decision.reasons.join(';')).toContain('>=10pp');
  });
});

describe('clustered paired statistics', () => {
  test('preserves native pooled denominators rather than averaging per-probe ratios', () => {
    const metric: RegressionMetricSpec = { ...primary, aggregation: 'ratio', integer: true };
    expect(aggregateRegressionMetric([{ numerator: 1, denominator: 1 }, { numerator: 0, denominator: 9 }], metric)).toBe(0.1);
    expect(aggregateRegressionMetric([1, 0], { ...primary, aggregation: 'sum' })).toBe(1);
    expect(aggregateRegressionMetric([1, 0, 0.5], { ...primary, aggregation: 'p50' })).toBe(0.5);
    expect(aggregateRegressionMetric([0, 0, 0, 100], { ...primary, aggregation: 'p95', percentile_method: 'nearest_rank' })).toBe(100);
    expect(aggregateRegressionMetric([0, 0, 0, 100], { ...primary, aggregation: 'p95' })).toBeCloseTo(85);
    expect(Number.isNaN(aggregateRegressionMetric([{ numerator: 0, denominator: 0 }], metric))).toBe(true);
    expect(() => clusteredRegressionStatistics([{ family_id: 'f', baseline: { numerator: 1, denominator: 2 }, candidate: 1 }], metric, 42, 10000)).toThrow('invalid clustered');
  });
  test('paraphrases and repeats remain one family unit', () => {
    const pairs = Array.from({ length: 100 }, () => ({ family_id: 'one-world', baseline: 0, candidate: 1 }));
    const stats = clusteredRegressionStatistics(pairs, primary, 1, 10000);
    expect(stats.lower95).toBeLessThanOrEqual(0);
    expect(stats.p_value).toBe(1);
  });
  test('uses paired family sign flips and Holm rather than independent row p-values', () => {
    const pairs = Array.from({ length: 4 }, (_, i) => Array.from({ length: 10 }, () => ({ family_id: `f${i}`, baseline: 0, candidate: 1 }))).flat();
    expect(clusteredRegressionStatistics(pairs, primary, 1, 10000).p_value).toBe(0.0625);
    expect(holmAdjusted([0.01, 0.03, 0.2])).toEqual([0.03, 0.06, 0.2]);
    expect(() => holmAdjusted([NaN])).toThrow();
  });
  test('mixed paired changes get deterministic clustered uncertainty', () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({ family_id: `f${i}`, baseline: 0.5, candidate: i < 6 ? 1 : 0 }));
    const first = clusteredRegressionStatistics(pairs, primary, 42, 10000);
    expect(first).toEqual(clusteredRegressionStatistics(pairs, primary, 42, 10000));
    expect(first.lower95).toBeLessThan(0);
    expect(first.upper95).toBeGreaterThan(0);
  });
});

describe('enforceable admission and runtime isolation', () => {
  test('the product reads the declared file plane and child dotenv loading stays disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'regression-file-plane-'));
    try {
      const { manifest } = fixture();
      const profile = manifest.profiles[0], cell = structuredClone(manifest.cells[0]);
      cell.runtime.home = join(root, 'home');
      cell.runtime.config = join(cell.runtime.home, '.gbrain/config.json');
      cell.runtime.database = join(root, 'database');
      mkdirSync(join(cell.runtime.home, '.gbrain'), { recursive: true });
      writeFileSync(cell.runtime.config, JSON.stringify(effectiveRegressionFileConfig(profile, cell)));
      writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=fixture-only-sentinel\nGBRAIN_EMBEDDING_MODEL=fixture:wrong\n');
      const configModule = Bun.resolveSync('gbrain/config', process.cwd());
      const script = `import {configPath,loadConfigFileOnly} from ${JSON.stringify(configModule)}; console.log(JSON.stringify({path:configPath(),config:loadConfigFileOnly(),dotenv_ignored:process.env.OPENAI_API_KEY===undefined}));`;
      const result = JSON.parse(execFileSync(process.execPath, regressionChildArguments([process.execPath, '-e', script]), {
        cwd: root, env: isolatedRegressionEnvironment(cell, profile), encoding: 'utf8',
      }));
      expect(result.path).toBe(cell.runtime.config);
      expect(result.config).toEqual(effectiveRegressionFileConfig(profile, cell));
      expect(result.config['search.mode']).toBeUndefined();
      expect(result.dotenv_ignored).toBe(true);
      expect(() => regressionChildArguments([process.execPath, 'runner.ts', '--env-file=ambient'])).toThrow('forbidden');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('does not inherit ambient keys, search overrides, HOME, database or allow-skip', () => {
    const { manifest } = fixture();
    const env = isolatedRegressionEnvironment(manifest.cells[0], manifest.profiles[0]);
    expect(env.HOME).toBe(manifest.cells[0].runtime.home);
    expect(env.GBRAIN_HOME).toBe(manifest.cells[0].runtime.home);
    expect(env.GBRAIN_CONFIG).toBeUndefined();
    expect(env.BRAINBENCH_ALLOW_SKIP).toBe('0');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.GBRAIN_SEARCH_MODE).toBeUndefined();
  });
  test('durably reserves liability, prevents retries and never refunds uncertain work', () => {
    const { manifest } = fixture();
    const root = mkdtempSync(join(tmpdir(), 'regression-ledger-'));
    try {
      const cell = manifest.cells.find(c => c.profile_id === 'cat13')!;
      const ledger = join(root, 'budget.json');
      reserveRegressionBudget(ledger, manifest, cell);
      expect(JSON.parse(readFileSync(ledger, 'utf8')).reservations[cell.id]).toBe(1);
      expect(() => reserveRegressionBudget(ledger, manifest, cell)).toThrow('already admitted');
      writeFileSync(ledger + '.lock', 'held');
      expect(() => reserveRegressionBudget(ledger, manifest, manifest.cells[0])).toThrow('locked');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('missing strict drivers and provider hard-limit authority block before any child or API work', async () => {
    const { manifest } = fixture();
    const outcome = await orchestrateSituationRecall({ manifest, drivers: [], ledger_path: '/unused/ledger', results_path: '/unused/results' });
    expect(outcome.decision.status).toBe('blocked');
    expect(outcome.results).toEqual([]);
    expect(outcome.decision.reasons.some(r => r.includes('enforceable provider budget'))).toBe(true);
    expect(outcome.decision.reasons.some(r => r.includes('driver prerequisite'))).toBe(true);
  });
});

describe('loaded package provenance and native Cat36 collector', () => {
  test('fixture source aliases remain one-to-one and cannot collapse namesakes', () => {
    const mappings = ['fixture/a', 'fixture/b'].map(fixture_source_id => ({ fixture_source_id, runtime_source_id: cat36RuntimeSourceId(fixture_source_id), fixture_slug: 'same-slug' }));
    expect(Object.keys(cat36RecordedSourceBindings({ mappings }))).toEqual(['fixture/a', 'fixture/b']);
    mappings[1].runtime_source_id = mappings[0].runtime_source_id;
    expect(() => cat36RecordedSourceBindings({ mappings })).toThrow('one-to-one');
  });
  test('archives require a verified content hash and reject inconsistent path bindings', () => {
    const root = mkdtempSync(join(tmpdir(), 'regression-product-'));
    try {
      const pkg = join(root, 'node_modules/gbrain');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { gbrain: 'pinned-test-only' } }));
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'gbrain', version: 'test', exports: { './package.json': './package.json' } }));
      writeFileSync(join(pkg, 'index.ts'), 'export const fixture = true;');
      expect(() => resolveRegressionProduct({ evalRoot: root, env: {} })).toThrow('preregistered');
      const hash = regressionPackageHash(pkg);
      const identity = resolveRegressionProduct({ evalRoot: root, expectedProductSha: SHA, expectedPackageSha256: hash, env: {} });
      expect(identity.product_sha).toBeNull();
      expect(identity.package_sha256).toBe(hash);
      expect(() => resolveRegressionProduct({ evalRoot: root, expectedPackageSha256: hash, env: { GBRAIN_REPO: root } })).toThrow('another product tree');
      const nested = join(root, 'eval/runner/node_modules/gbrain');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'gbrain', version: 'foreign', exports: { './package.json': './package.json' } }));
      expect(() => resolveRegressionProduct({ evalRoot: root, expectedPackageSha256: hash, env: {} })).toThrow('resolution differs');
      rmSync(join(root, 'eval'), { recursive: true, force: true });
      const pmbShadow = join(root, 'eval/precisionmembench/node_modules/gbrain');
      mkdirSync(pmbShadow, { recursive: true });
      writeFileSync(join(pmbShadow, 'package.json'), JSON.stringify({ name: 'gbrain', version: 'foreign-pmb', exports: { './package.json': './package.json' } }));
      expect(() => resolveRegressionProduct({ evalRoot: root, expectedPackageSha256: hash, env: {} })).toThrow('resolution differs');
      rmSync(join(root, 'eval'), { recursive: true, force: true });
      writeFileSync(join(pkg, 'index.ts'), 'export const fixture = false;');
      expect(() => resolveRegressionProduct({ evalRoot: root, expectedPackageSha256: hash, env: {} })).toThrow('content hash mismatch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('collector never converts an offline/stub receipt into publishable capability evidence', () => {
    const { manifest, results } = fixture();
    const cell = manifest.cells.find(c => c.profile_id === 'cat36')!;
    const receipt = results.find(r => r.cell_id === cell.id)!.receipt!;
    const d = receipt.data!.regression as RegressionReceiptData;
    expect(() => toCat36RegressionData(receipt, { manifest, cell, provenance: d.provenance, spend: d.spend })).toThrow('nonproduction');
  });

  test('collects only explicit native Cat36 metrics and rejects silent schema drift', () => {
    const { manifest, results } = fixture();
    const cell = manifest.cells.find(c => c.profile_id === 'cat36' && c.arm === 'C1')!;
    const profile = manifest.profiles.find(p => p.id === 'cat36')!;
    const receipt = results.find(r => r.cell_id === cell.id)!.receipt!;
    const d = receipt.data!.regression as RegressionReceiptData;
    receipt.hashes = { ...profile.native_hashes, build: HASH };
    receipt.resolved_config = { raw_chunk_limit: 5, profile: {
      mode: 'live', split: 'holdout', arm: 'C1', expected_product_sha: CANDIDATE,
      provider_budget: { kind: 'isolated-provider-cap', approval_id: d.spend.enforcement_id, max_usd: 1 },
      search_config: profile.config, token_budget: 4096,
    } };
    receipt.data = {
      mode: 'live', runtime_kind: 'production', relevance_review_approved: true,
      build: { mode: 'live', complete: true, feature_supported: true, generation_observed: true, families: ['scene', 'horizon'],
        mappings: [{ fixture_source_id: 'fixture-source', runtime_source_id: cat36RuntimeSourceId('fixture-source'), fixture_slug: 'fixture-page', page_id: 1, canonical_sha256: HASH, chunks: [] }],
        resolved_config: d.provenance.config,
        provenance: { product_sha: CANDIDATE, product_tree: CANDIDATE, package_path: cell.runtime.package_path, dirty: false,
          declared_pin: profile.declared_pin, package_version: 'candidate', fixed_source_timestamps: true, file_config: d.provenance.file_config,
          isolated_home: cell.runtime.home, database: cell.runtime.database },
        generation: { generated: 1, generated_unit: 'completed nonempty windows, not cue count', empty_windows: 0, rejected_windows: 0, covered_sources: Object.values(profile.cue_source_bindings!) },
      },
      rows: d.rows.map(row => {
        const spec = profile.probes.find(p => p.probe_id === row.probe_id)!;
        return { probe_id: row.probe_id, family_id: spec.family_id, split: 'holdout', kind: spec.slices[0], domain: spec.slices[1], tags: spec.slices.slice(2),
          metrics: { ...row.metrics, matched_span_ids: [], returned_page_ids: [] }, chunks: [{ token_count: 10 }],
          observation_failures: [], metadata: { mode: 'hybrid', failures: [], result_count: 1, rerank_scored: false },
          cue: { mode: 'on', status: 'ready', candidates: 1, admitted: 1 },
        };
      }),
    };
    const context = { manifest, cell, provenance: d.provenance, spend: d.spend };
    const collected = toCat36RegressionData(receipt, context);
    expect(collected.rows.length).toBe(320);
    expect(collected.feature.covered_sources).toEqual(['fixture-source']);
    expect(collected.feature.generated_unit).toBe('ready_windows');
    expect(Object.keys(collected.rows[0].metrics)).not.toContain('matched_span_ids');
    const nativeBudget = (receipt.resolved_config.profile as { provider_budget: { kind?: string } }).provider_budget;
    for (const kind of ['operator-authorized-development', undefined]) {
      if (kind === undefined) delete nativeBudget.kind;
      else nativeBudget.kind = kind;
      expect(() => toCat36RegressionData(receipt, context)).toThrow('provider admission');
    }
    nativeBudget.kind = 'isolated-provider-cap';
    for (const index of [0, 3]) {
      const bounded = (receipt.data.rows as Cat36Row[])[index];
      const metrics = bounded.metrics;
      if (!metrics) throw new Error('expected scored test row');
      bounded.chunks = [];
      metrics.returned_evidence_tokens = 0;
      bounded.cue = { mode: 'on', status: 'degraded', reason: 'candidate_budget', candidates: 0, admitted: 0 };
      bounded.metadata = { mode: 'hybrid', failures: [], result_count: 0, rerank_scored: false };
      if (bounded.kind === 'negative') { metrics.associative_false_fire = 0; metrics.negative_result_count = 0; }
      else {
        metrics.all_evidence_in_top5_chunks = 0;
        metrics.page_recall_at5 = 0;
        metrics.page_precision_at5 = 0;
        metrics.page_mrr = 0;
        metrics.page_ndcg_at5 = 0;
      }
    }
    const boundedData = toCat36RegressionData(receipt, context);
    expect(boundedData.rows[0].feature?.reason).toBe('candidate_budget');
    expect(boundedData.rows[0].metrics.all_evidence_in_top5_chunks).toBe(0);
    expect(boundedData.rows[3].metrics.associative_false_fire).toBe(0);
    expect(validateRegressionCell(manifest, cell, { ...results.find(r => r.cell_id === cell.id)!, receipt: { ...receipt, data: { ...receipt.data, regression: boundedData } } })).toEqual([]);
    receipt.hashes.scorer = 'd'.repeat(64);
    expect(() => toCat36RegressionData(receipt, context)).toThrow('scorer/model/prompt hash mismatch');
    receipt.hashes.scorer = HASH;
    (receipt.data.rows as Array<{ metrics: Record<string, unknown> }>)[0].metrics.new_metric = 1;
    expect(() => toCat36RegressionData(receipt, context)).toThrow('explicit collector mapping');
    delete (receipt.data.rows as Array<{ metrics: Record<string, unknown> }>)[0].metrics.new_metric;
    const failed = (receipt.data.rows as Cat36Row[])[0];
    const failedMetrics = failed.metrics;
    if (!failedMetrics) throw new Error('expected scored SUT test row');
    failed.error = { origin: 'sut', message: 'production search threw' };
    failed.observation_failures = ['sut_error'];
    failed.chunks = [];
    failed.metadata = null;
    failedMetrics.returned_evidence_tokens = 0;
    failedMetrics.all_evidence_in_top5_chunks = 0;
    failed.cue = { mode: 'on', status: 'degraded', candidates: 0, admitted: 0 };
    receipt.errors = [{ probe_id: failed.probe_id, ...failed.error }];
    const sutData = toCat36RegressionData(receipt, context);
    expect(sutData.rows[0].error?.origin).toBe('sut');
    const strictResult = { ...results.find(r => r.cell_id === cell.id)!, receipt: { ...receipt, data: { ...receipt.data, regression: sutData } } };
    expect(validateRegressionCell(manifest, cell, strictResult)).toEqual([]);
    failed.error.origin = 'dependency';
    expect(() => toCat36RegressionData(receipt, context)).toThrow('infrastructure/judge');
  });
});
