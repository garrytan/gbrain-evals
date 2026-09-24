import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import inventory from '../../eval/regression/situation-recall-v1.json';
import { collectNativeRows246 } from '../../eval/runner/situation-recall-native-2-4-6.ts';
import { materializeNativeRegressionRows, type NativeRegressionObservation } from '../../eval/runner/situation-recall-native.ts';
import { aggregateRegressionMetric } from '../../eval/runner/situation-recall-regression.ts';
import type { RegressionMetricSpec, RegressionObservationValue, RegressionProfile } from '../../eval/runner/situation-recall-contract.ts';
import { score, type GoldEdge } from '../../eval/runner/type-accuracy.ts';
import { aggregate, runCat6, scoreExtraction, type VariantCase } from '../../eval/runner/cat6-prose-scale.ts';

type Category = 'cat2' | 'cat4' | 'cat6';
let output: string;
let temporary = false;
const artifacts: Record<string, any> = {};

beforeAll(() => {
  output = process.env.NATIVE_246_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'native-collector-2-4-6-'));
  temporary = process.env.NATIVE_246_ARTIFACT_DIR === undefined;
  if (temporary) {
    const root = resolve(import.meta.dir, '../..');
    const run = (runner: string, args: string[]) => {
      const result = Bun.spawnSync([process.execPath, join(root, 'eval/runner', runner), ...args], { cwd: output });
      if (result.exitCode !== 0) throw new Error(`${runner} failed: ${result.stderr.toString()}`);
      return JSON.parse(result.stdout.toString());
    };
    artifacts.cat2 = run('type-accuracy.ts', ['--json', `--dir=${join(root, 'eval/data/world-v1')}`]);
    artifacts.cat4 = run('temporal.ts', ['--json']);
    artifacts.cat6 = run('cat6-prose-scale.ts', [
      '--corpus-dir', join(root, 'eval/data/world-v1'),
      '--report-path', join(output, 'cat6.report.json'), '--receipt-path', join(output, 'cat6.receipt.json'),
    ]);
  } else {
    for (const category of ['cat2', 'cat4', 'cat6']) artifacts[category] = JSON.parse(readFileSync(join(output, `${category}.stdout.json`), 'utf8'));
  }
  artifacts.cat4Receipt = JSON.parse(readFileSync(join(output, 'eval/reports/temporal/receipt.json'), 'utf8'));
  artifacts.cat6Receipt = JSON.parse(readFileSync(join(output, 'cat6.receipt.json'), 'utf8'));
  artifacts.cat6Report = JSON.parse(readFileSync(join(output, 'cat6.report.json'), 'utf8'));
}, 30_000);

afterAll(() => {
  if (temporary) rmSync(output, { recursive: true, force: true });
});

function profile(category: Category, observations: NativeRegressionObservation[]): RegressionProfile {
  const contract = inventory.native_contracts[category];
  return {
    id: category, category, receipt_category: contract.receipt_category,
    mode: 'hermetic', arms: ['B', 'C0'], repeats: 1,
    probes: observations.map(row => ({
      probe_id: row.probe_id, family_id: row.family_id ?? row.probe_id,
      slices: [...row.slices], critical: false, no_gold_metrics: [],
    })),
    metrics: structuredClone(contract.metrics) as RegressionMetricSpec[],
    required_slices: [...contract.required_slices], cue_sources: [], config: {}, file_config: { engine: 'pglite' }, cue_config: {},
    hashes: { corpus: '', gold: '', queries: '', runner: '', scorer: '', models: '', prompts: '', source_timestamps: '' },
    native_contract_sha256: '', reranker: 'none', declared_pin: '', package_versions: { B: '', C0: '', C1: '' },
    clock: '', timeout_ms: 30_000, prerequisites: { supported: true, runner: contract.native_runner, evidence_sha256: '' },
    budget: { construction_usd: 0, embedding_usd: 0, reranking_usd: 0, judging_usd: 0, agent_usd: 0, enforcement: 'none' },
  };
}

function aggregateMetric(category: Category, rows: NativeRegressionObservation[], id: string, slice?: string): number {
  const metric = inventory.native_contracts[category].metrics.find(metric => metric.id === id) as RegressionMetricSpec;
  const values = rows.filter(row => row.contributed && (!slice || row.slices.includes(slice)) && Object.hasOwn(row.metrics, id)).map(row => row.metrics[id]);
  return aggregateRegressionMetric(values as RegressionObservationValue[], metric);
}

function cat2Artifact(pages: string[], gold: GoldEdge[], inferred: GoldEdge[]) {
  return {
    ...score(gold, inferred), goldEdges: gold, inferredEdges: inferred, goldTotal: gold.length, inferredTotal: inferred.length,
    attempts: pages.map(slug => ({ probe_id: `page:${slug}`, slug, status: 'completed', inferred: inferred.filter(edge => edge.from === slug) })),
  };
}

describe('Cat2 retained native count collector', () => {
  test('actual CLI observations reconstruct pooled and per-type aggregates', () => {
    const rows = collectNativeRows246('cat2', artifacts.cat2);
    expect(rows.length).toBe(artifacts.cat2.attempts.length * 6);
    expect(new Set(rows.map(row => row.probe_id)).size).toBe(rows.length);
    expect(aggregateMetric('cat2', rows, 'f1_strict')).toBeCloseTo(artifacts.cat2.overallStrictF1, 14);
    expect(aggregateMetric('cat2', rows, 'type_accuracy')).toBe(artifacts.cat2.overallTypeAccuracy);
    for (const perType of artifacts.cat2.perType) {
      for (const metric of ['recall', 'precision', 'f1_strict', 'type_accuracy']) {
        expect(aggregateMetric('cat2', rows, metric, perType.linkType)).toBeCloseTo(perType[metric], 14);
      }
      const selected = rows.filter(row => row.slices.includes(perType.linkType));
      const component = (metric: string, key: 'numerator' | 'denominator') => selected.reduce((sum, row) => sum + (row.metrics[metric] as { numerator: number; denominator: number })[key], 0);
      expect(component('recall', 'denominator')).toBe(perType.gold);
      expect(component('recall', 'numerator')).toBe(perType.correctly_typed);
      expect(component('type_accuracy', 'denominator') - component('recall', 'numerator')).toBe(perType.mistyped);
      expect(component('precision', 'denominator') - component('recall', 'numerator')).toBe(perType.spurious);
      expect(component('recall', 'denominator') - component('type_accuracy', 'denominator')).toBe(perType.missed);
    }
    for (const row of rows) {
      expect(row.probe_id).toBe(`page:${JSON.stringify(row.family_id)}:type:${JSON.stringify(row.slices[0])}`);
      expect(row.contributed).toBe(true);
    }
  });

  test('retains zero contributions for ignored wrong types, inferred-only native types, and empty gold', () => {
    const native = cat2Artifact(['a', 'b', 'c'], [{ from: 'a', to: 'b', type: 'works_at' }], [
      { from: 'a', to: 'b', type: 'works_at' }, { from: 'a', to: 'b', type: 'mentions' },
      { from: 'c', to: 'b', type: 'advises' },
    ]);
    const rows = collectNativeRows246('cat2', native);
    expect(rows.find(row => row.slices.includes('mentions'))!.metrics.f1_strict).toEqual({ numerator: 0, denominator: 0 });
    expect(rows.find(row => row.family_id === 'c' && row.slices.includes('advises'))!.metrics.precision).toEqual({ numerator: 0, denominator: 1 });
    expect(aggregateMetric('cat2', rows, 'f1_strict')).toBeCloseTo(native.overallStrictF1, 14);
    expect(collectNativeRows246('cat2', cat2Artifact([], [], []))).toEqual([]);
    const emptyGold = cat2Artifact(['x', 'y'], [], [{ from: 'x', to: 'y', type: 'mentions' }]);
    expect(aggregateMetric('cat2', collectNativeRows246('cat2', emptyGold), 'recall')).toBe(0);
    const emptyPage = collectNativeRows246('cat2', cat2Artifact(['no-edges'], [], []));
    expect(emptyPage).toHaveLength(6);
    for (const row of emptyPage) expect(Object.values(row.metrics)).toEqual(Array(4).fill({ numerator: 0, denominator: 0 }));
  });

  test('added and removed spurious predictions change counts without changing input-owned IDs', () => {
    const pages = ['a', 'b', 'empty'];
    const gold = [{ from: 'a', to: 'b', type: 'works_at' }];
    const before = cat2Artifact(pages, gold, gold);
    const after = cat2Artifact(pages, gold, [...gold,
      { from: 'a', to: 'new-target', type: 'works_at' },
      { from: 'empty', to: 'new-target', type: 'mentions' },
    ]);
    const baseline = collectNativeRows246('cat2', before);
    const candidate = collectNativeRows246('cat2', after);
    expect(candidate.map(row => row.probe_id)).toEqual(baseline.map(row => row.probe_id));
    expect(candidate.map(row => row.family_id)).toEqual(baseline.map(row => row.family_id));
    expect(candidate).toHaveLength(18);
    const registered = profile('cat2', baseline);
    expect(materializeNativeRegressionRows(registered, candidate)).toHaveLength(18);
    expect(materializeNativeRegressionRows(profile('cat2', candidate), baseline)).toHaveLength(18);
    expect(aggregateMetric('cat2', baseline, 'precision')).toBe(1);
    expect(aggregateMetric('cat2', candidate, 'precision')).toBeCloseTo(1 / 3, 14);
    const id = 'page:"a":type:"works_at"';
    expect(baseline.find(row => row.probe_id === id)!.metrics.precision).toEqual({ numerator: 1, denominator: 1 });
    expect(candidate.find(row => row.probe_id === id)!.metrics.precision).toEqual({ numerator: 1, denominator: 2 });
    expect(after.rows).toEqual(score(gold, after.inferredEdges).rows);
  });

  test('fails closed on missing or inconsistent native numeric evidence', () => {
    const incomplete = structuredClone(artifacts.cat2);
    delete incomplete.rows[0].counts;
    expect(() => collectNativeRows246('cat2', incomplete)).toThrow('counts');
    const inconsistent = structuredClone(artifacts.cat2);
    inconsistent.perType[0].gold++;
    expect(() => collectNativeRows246('cat2', inconsistent)).toThrow('does not match retained native rows');
  });

  test('failed inference is rejected rather than expanded into fabricated zero groups', () => {
    expect(() => collectNativeRows246('cat2', {
      run_status: 'error', rows: [],
      attempts: [
        { probe_id: 'page:a', slug: 'a', status: 'completed', inferred: [] },
        { probe_id: 'page:b', slug: 'b', status: 'error', inferred: [], error: 'extractor failed' },
      ],
      errors: [{ probe_id: 'page:b', message: 'extractor failed' }],
    })).toThrow('failed run');
    const native = cat2Artifact(['a'], [], []);
    expect(() => collectNativeRows246('cat2', { ...native, attempts: [{ ...native.attempts[0], status: 'error', error: 'failed' }] })).toThrow('completed recorded attempt');
  });

  test('unrecorded pages, missing pair evidence, duplicate attempts and unknown types fail closed', () => {
    const native = cat2Artifact(['a', 'b'], [], [{ from: 'a', to: 'b', type: 'mentions' }]);
    expect(() => collectNativeRows246('cat2', { ...native, attempts: undefined })).toThrow('attempts');
    expect(() => collectNativeRows246('cat2', { ...native, attempts: native.attempts.slice(1) })).toThrow('completed recorded attempt');
    expect(() => collectNativeRows246('cat2', { ...native, rows: [] })).toThrow('lack per-pair scoring evidence');
    expect(() => collectNativeRows246('cat2', { ...native, attempts: [...native.attempts, native.attempts[0]] })).toThrow('duplicate Cat2 attempted page');
    expect(() => collectNativeRows246('cat2', cat2Artifact(['a', 'b'], [], [{ from: 'a', to: 'b', type: 'unknown_type' }]))).toThrow('unknown Cat2 link type');
  });
});

describe('Cat4 retained temporal row collector', () => {
  test('actual stdout and receipt rows reconstruct all six native aggregates without mixing populations', () => {
    const rows = collectNativeRows246('cat4', artifacts.cat4);
    expect(collectNativeRows246('cat4', artifacts.cat4Receipt)).toEqual(rows);
    expect(rows).toHaveLength(114);
    for (const [metric, value] of Object.entries<number>(artifacts.cat4.summary)) expect(aggregateMetric('cat4', rows, metric)).toBe(value);
    expect(rows.filter(row => row.slices.includes('point'))).toHaveLength(30);
    expect(rows.filter(row => row.slices.includes('range'))).toHaveLength(4);
    expect(rows.filter(row => row.slices.includes('recency'))).toHaveLength(30);
    expect(rows.filter(row => row.slices.includes('asof'))).toHaveLength(50);
    for (const range of artifacts.cat4Receipt.data.range.per_range) {
      expect(aggregateMetric('cat4', rows, 'rangeRecall', range.label)).toBe(range.recall);
      expect(aggregateMetric('cat4', rows, 'rangePrecision', range.label)).toBe(range.precision);
    }
  });

  test('pooled point counts and macro range rates remain distinct with unequal denominators', () => {
    const row = (id: string, kind: string, hits: number, expected: number, returned: number, extra = {}) => ({
      probe_id: id, kind, status: 'scored', contributed: true, hits, expected, returned,
      recall: hits / expected, precision: returned ? hits / returned : 0, ...extra,
    });
    const rows = collectNativeRows246('cat4', { rows: [
      row('point:a', 'point', 1, 1, 2), row('point:b', 'point', 0, 3, 0),
      row('range:A', 'range', 1, 1, 2, { label: 'A' }), row('range:B', 'range', 0, 3, 0, { label: 'B' }),
    ] });
    expect(aggregateMetric('cat4', rows, 'pointRecall')).toBe(0.25);
    expect(aggregateMetric('cat4', rows, 'pointPrecision')).toBe(0.5);
    expect(aggregateMetric('cat4', rows, 'rangeRecall')).toBe(0.5);
    expect(aggregateMetric('cat4', rows, 'rangePrecision')).toBe(0.25);
  });

  test('partial errors preserve existing scores and do not invent a metric for the failed probe', () => {
    const native = {
      run_status: 'error', rows: [artifacts.cat4.rows[0], {
        probe_id: 'range:Q1 2024', kind: 'range', status: 'error', contributed: false, error: 'storage failed',
      }], errors: [{ probe_id: 'run', origin: 'sut', message: 'storage failed' }],
    };
    const rows = collectNativeRows246('cat4', native);
    expect(rows[0].contributed).toBe(true);
    expect(rows[1]).toEqual({
      probe_id: 'range:Q1 2024', family_id: 'range:Q1 2024', slices: ['range', 'Q1 2024'],
      contributed: false, metrics: {}, error: { probe_id: 'range:Q1 2024', origin: 'sut', message: 'storage failed' },
    });
    expect(() => collectNativeRows246('cat4', { ...native, errors: [] })).toThrow('failure origin');
    expect(() => materializeNativeRegressionRows(profile('cat4', collectNativeRows246('cat4', artifacts.cat4)), rows)).toThrow('complete registered probe IDs');
  });

  test('requires the retained contribution flag and accepts only the correct receipt category', () => {
    const row = { ...artifacts.cat4.rows[0] };
    delete row.contributed;
    expect(() => collectNativeRows246('cat4', { rows: [row] })).toThrow('native boolean');
    expect(() => collectNativeRows246('cat4', { ...artifacts.cat4Receipt, category: 'other' })).toThrow('category mismatch');
  });
});

describe('Cat6 retained variant and control collector', () => {
  test('actual report, stdout and receipt reconstruct native overall and per-kind metrics', () => {
    const rows = collectNativeRows246('cat6', artifacts.cat6);
    expect(collectNativeRows246('cat6', artifacts.cat6Report)).toEqual(rows);
    expect(collectNativeRows246('cat6', artifacts.cat6Receipt)).toEqual(rows);
    expect(rows).toHaveLength(252);
    for (const metric of inventory.native_contracts.cat6.metrics) {
      if (metric.id !== 'negative_controls.fired') expect(aggregateMetric('cat6', rows, metric.id)).toBe(artifacts.cat6.overall[metric.id]);
    }
    for (const kind of artifacts.cat6.per_kind) {
      if (kind.recall !== null) expect(aggregateMetric('cat6', rows, 'link_recall', kind.kind)).toBe(kind.recall);
      else expect(aggregateMetric('cat6', rows, 'link_recall', kind.kind)).toBeNaN();
      if (kind.precision !== null) expect(aggregateMetric('cat6', rows, 'link_precision', kind.kind)).toBe(kind.precision);
      else expect(aggregateMetric('cat6', rows, 'link_precision', kind.kind)).toBeNaN();
      if (kind.kind === 'ambiguous_role') expect(aggregateMetric('cat6', rows, 'ambiguous_role_type_match_rate')).toBe(kind.type_match_rate);
    }
    const gates = rows.filter(row => row.probe_id.startsWith('native-gate:'));
    expect(gates.map(row => row.probe_id)).toEqual(['native-gate:code_leak_detectable', 'native-gate:substring_fp_detectable']);
    expect(gates.every(row => row.slices.length === 0)).toBe(true);
    expect(aggregateMetric('cat6', rows, 'negative_controls.fired')).toBe(1);
  });

  test('mixed native results and SUT errors preserve pooled components without changing the scorer', async () => {
    let index = 0;
    const outcome = await runCat6({ perKind: 3 }, [], async variant => {
      const mode = index++ % 3;
      if (mode === 0) throw new Error('injected SUT failure');
      return [
        ...variant.goldDelta.must_extract.map(gold => ({ targetSlug: gold.slug, linkType: mode === 1 ? gold.type : 'wrong_type' })),
        ...variant.goldDelta.must_not_extract.map(gold => ({ targetSlug: gold.slug, linkType: 'mentions' })),
      ];
    });
    const rows = collectNativeRows246('cat6', outcome.report);
    for (const metric of inventory.native_contracts.cat6.metrics) {
      if (metric.id !== 'negative_controls.fired') expect(aggregateMetric('cat6', rows, metric.id)).toBeCloseTo(outcome.report.overall[metric.id as keyof typeof outcome.report.overall]!, 14);
    }
    const errors = rows.filter(row => row.error);
    expect(errors).toHaveLength(5);
    expect(errors.every(row => row.contributed && row.error!.origin === 'sut')).toBe(true);
    expect(errors.every(row => (row.metrics.link_recall as { numerator: number }).numerator === 0)).toBe(true);
  });

  test('all-miss null F1 stays unmeasurable instead of being silently turned into zero', async () => {
    const outcome = await runCat6({ perKind: 1 }, [], async () => { throw new Error('extractor unavailable'); });
    const rows = collectNativeRows246('cat6', outcome.report);
    expect(outcome.report.overall.link_f1).toBeNull();
    expect(aggregateMetric('cat6', rows, 'link_recall')).toBe(0);
    expect(aggregateMetric('cat6', rows, 'link_precision')).toBeNaN();
    expect(aggregateMetric('cat6', rows, 'link_f1')).toBeNaN();
    for (const row of rows.filter(row => row.slices.length > 0)) {
      expect(row.metrics.link_f1).toEqual({
        not_applicable: 'native_no_denominator', evidence: {
          expected_count: (row.metrics.link_recall as { denominator: number }).denominator, returned_count: 0,
        },
      });
    }
  });

  test('empty positive gold with a real false positive preserves null recall and F1', () => {
    const variant: VariantCase = {
      variantId: 'negative-only', baseSlug: 'people/example', baseType: 'person', kind: 'substring_collision', content: '',
      goldDelta: { must_extract: [], must_not_extract: [{ slug: 'people/forbidden', reason: 'negative-only fixture' }], note: 'negative-only fixture' },
    };
    const report = aggregate([variant], [scoreExtraction(variant, [{ targetSlug: 'people/forbidden', linkType: 'mentions' }])]);
    const rows = collectNativeRows246('cat6', report);
    expect(report.overall.link_recall).toBeNull();
    expect(report.overall.link_f1).toBeNull();
    expect(aggregateMetric('cat6', rows, 'link_recall')).toBeNaN();
    expect(aggregateMetric('cat6', rows, 'link_f1')).toBeNaN();
    expect(aggregateMetric('cat6', rows, 'link_precision')).toBe(0);
    expect(aggregateMetric('cat6', rows, 'substring_fp_rate')).toBe(1);
    expect(rows[0].metrics.link_f1).toEqual({ not_applicable: 'native_no_denominator', evidence: { expected_count: 0, returned_count: 1 } });
  });

  test('fatal harness artifacts retain observations without metric contributions or invented controls', () => {
    const native = artifacts.cat6.rows[0];
    const rows = collectNativeRows246('cat6', {
      category: 'cat6-prose-scale', run_status: 'error',
      data: { rows: [{ ...native, contributed: false }] },
      errors: [{ probe_id: 'run', origin: 'harness', message: 'aggregation failed' }],
    });
    expect(rows).toEqual([{
      probe_id: native.probe_id, family_id: native.baseSlug, slices: [native.kind], contributed: false, metrics: {},
      error: { probe_id: native.probe_id, origin: 'harness', message: 'aggregation failed' },
    }]);
  });

  test('failed negative controls retain their recorded zero and harness error', () => {
    const native = structuredClone(artifacts.cat6Receipt);
    native.data.negative_controls[0].fired = false;
    native.data.negative_controls[0].fired_on = 0;
    native.errors = [{ probe_id: 'negative-control:code_leak_detectable', origin: 'harness', message: 'control did not fire' }];
    const gate = collectNativeRows246('cat6', native).find(row => row.probe_id === 'native-gate:code_leak_detectable')!;
    expect(gate.contributed).toBe(true);
    expect(gate.metrics).toEqual({ 'negative_controls.fired': 0 });
    expect(gate.error).toEqual({ probe_id: gate.probe_id, origin: 'harness', message: 'control did not fire' });
  });
});

describe('registered native materialization', () => {
  test.each(['cat2', 'cat4', 'cat6'] as const)('%s uses observed native IDs/slices and frozen inventory metrics', category => {
    const observations = collectNativeRows246(category, artifacts[category]);
    const registered = profile(category, observations);
    const rows = materializeNativeRegressionRows(registered, observations);
    expect(rows).toHaveLength(observations.length);
    for (const [index, row] of rows.entries()) {
      expect(row.probe_id).toBe(observations[index].probe_id);
      expect(Object.keys(row.metrics)).toEqual(registered.metrics.map(metric => metric.id));
      for (const metric of registered.metrics) {
        if (Object.hasOwn(observations[index].metrics, metric.id)) expect(row.metrics[metric.id]).toEqual(observations[index].metrics[metric.id]);
        else expect(row.metrics[metric.id]).toEqual({ not_applicable: 'outside_metric_slice' });
      }
    }
    expect(() => materializeNativeRegressionRows(registered, observations.slice(1))).toThrow('complete registered probe IDs');
    expect(() => materializeNativeRegressionRows(registered, [...observations, observations[0]])).toThrow('duplicate');
    expect(() => materializeNativeRegressionRows(registered, observations.map((row, i) => i ? row : { ...row, slices: ['invented'] }))).toThrow('slice identity mismatch');
  });
});
