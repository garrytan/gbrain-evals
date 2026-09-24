import type { ProbeError } from './receipt.ts';
import type { RegressionMetricValue } from './situation-recall-contract.ts';
import {
  nativeEvidenceObject,
  nativeEvidenceRows,
  nativeFinite,
  type NativeRegressionObservation,
} from './situation-recall-native.ts';

type Evidence = Record<string, unknown>;
type Category = 'cat2' | 'cat4' | 'cat6';
const TYPE_ACCURACY_LINK_TYPES = ['founded', 'works_at', 'invested_in', 'advises', 'attended', 'mentions'];

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is not a native identity/message`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is not a native boolean`);
  return value;
}

function count(value: unknown, label: string): number {
  const number = nativeFinite(value, label);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is not a nonnegative native count`);
  return number;
}

function length(value: unknown, label: string): number {
  if (!Array.isArray(value)) throw new Error(`${label} native labels/results are missing`);
  return value.length;
}

function fraction(numerator: number, denominator: number): { numerator: number; denominator: number } {
  return { numerator, denominator };
}

function checkMeasurement(actual: unknown, expected: number | null, label: string): void {
  if (expected === null ? actual !== null : typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > 1e-12) {
    throw new Error(`${label} does not match retained native rows`);
  }
}

function errorsOf(root: Evidence): Evidence[] {
  return root.errors === undefined ? [] : nativeEvidenceRows(root.errors, 'native errors');
}

function recordedError(errors: Evidence[], probeId: string, fallback = false): ProbeError | undefined {
  const error = errors.find(error => error.probe_id === probeId)
    ?? (fallback ? errors.find(error => error.probe_id === 'run') : undefined);
  if (!error) return undefined;
  if (!['sut', 'harness', 'dependency', 'judge'].includes(String(error.origin))) throw new Error(`native failure origin is missing: ${probeId}`);
  return { probe_id: probeId, origin: error.origin as ProbeError['origin'], message: text(error.message, `${probeId} error`) };
}

function collectTypeAccuracy(root: Evidence, data: Evidence): NativeRegressionObservation[] {
  const rows = nativeEvidenceRows(data.rows, 'Cat2');
  if (root.run_status === 'error') throw new Error('Cat2 failed run has no completed native scoring population');
  const attempts = nativeEvidenceRows(data.attempts, 'Cat2 attempts');
  type Counts = { gold: number; correctly_typed: number; mistyped: number; missed: number; spurious: number };
  const byPage = new Map<string, Map<string, Counts>>();
  for (const attempt of attempts) {
    const slug = text(attempt.slug, 'Cat2 attempted page slug');
    if (attempt.probe_id !== `page:${slug}` || attempt.status !== 'completed' || attempt.error !== undefined) {
      throw new Error(`Cat2 page lacks a completed recorded attempt: ${slug}`);
    }
    if (byPage.has(slug)) throw new Error(`duplicate Cat2 attempted page: ${slug}`);
    byPage.set(slug, new Map(TYPE_ACCURACY_LINK_TYPES.map(linkType => [linkType, {
      gold: 0, correctly_typed: 0, mistyped: 0, missed: 0, spurious: 0,
    }])));
  }
  const expectedPairs = new Set<string>();
  const goldEdges = nativeEvidenceRows(data.goldEdges, 'Cat2 goldEdges');
  const inferredEdges = attempts.flatMap(attempt => nativeEvidenceRows(attempt.inferred, `Cat2 ${attempt.slug} inferred`).map(edge => {
    if (edge.from !== attempt.slug) throw new Error(`Cat2 inference page mismatch: ${attempt.slug}`);
    return edge;
  }));
  for (const edge of [...goldEdges, ...inferredEdges]) {
    const from = text(edge.from, 'Cat2 edge source');
    const to = text(edge.to, 'Cat2 edge target');
    if (!byPage.has(from)) throw new Error(`Cat2 edge source has no completed recorded attempt: ${from}`);
    if (!TYPE_ACCURACY_LINK_TYPES.includes(text(edge.type, 'Cat2 edge type'))) throw new Error(`unknown Cat2 link type: ${edge.type}`);
    expectedPairs.add(`edge:${JSON.stringify([from, to])}`);
  }
  const observedPairs = new Set<string>();
  const totals = new Map<string, Counts>();
  for (const row of rows) {
    const pairId = text(row.probe_id, 'Cat2 pair ID');
    const page = byPage.get(text(row.from, `${pairId} source page`));
    if (!page) throw new Error(`Cat2 edge source has no completed recorded attempt: ${row.from}`);
    if (pairId !== `edge:${JSON.stringify([row.from, text(row.to, `${pairId} target`)])}` || !expectedPairs.has(pairId)) {
      throw new Error(`Cat2 pair has no raw edge evidence: ${pairId}`);
    }
    if (observedPairs.has(pairId)) throw new Error(`duplicate Cat2 native pair: ${pairId}`);
    observedPairs.add(pairId);
    if (!boolean(row.contributed, `${pairId} contributed`)) throw new Error(`Cat2 unscored pair lacks a native error: ${pairId}`);
    const observedTypes = new Set<string>();
    for (const raw of nativeEvidenceRows(row.counts, `${pairId} counts`)) {
      const linkType = text(raw.linkType, 'Cat2 link type');
      const group = page.get(linkType);
      if (!group) throw new Error(`unknown Cat2 link type: ${linkType}`);
      if (observedTypes.has(linkType)) throw new Error(`duplicate Cat2 pair/type counts: ${pairId}/${linkType}`);
      observedTypes.add(linkType);
      const gold = count(raw.gold, `${pairId} gold`);
      const correct = count(raw.correctly_typed, `${pairId} correctly_typed`);
      const mistyped = count(raw.mistyped, `${pairId} mistyped`);
      const missed = count(raw.missed, `${pairId} missed`);
      const spurious = count(raw.spurious, `${pairId} spurious`);
      if (gold !== correct + mistyped + missed) throw new Error(`Cat2 gold partition mismatch: ${pairId}`);
      const total = totals.get(linkType) ?? { gold: 0, correctly_typed: 0, mistyped: 0, missed: 0, spurious: 0 };
      for (const target of [group, total]) {
        target.gold += gold;
        target.correctly_typed += correct;
        target.mistyped += mistyped;
        target.missed += missed;
        target.spurious += spurious;
      }
      totals.set(linkType, total);
    }
  }
  if (observedPairs.size !== expectedPairs.size) throw new Error('Cat2 raw edges lack per-pair scoring evidence');
  if (data.goldTotal !== undefined) checkMeasurement(data.goldTotal, goldEdges.length, 'Cat2 goldTotal');
  if (data.inferredTotal !== undefined) checkMeasurement(data.inferredTotal, inferredEdges.length, 'Cat2 inferredTotal');
  const perType = nativeEvidenceRows(data.perType, 'Cat2 perType');
  if (perType.length !== totals.size) throw new Error('Cat2 per-type population mismatch');
  for (const raw of perType) {
    const linkType = text(raw.linkType, 'Cat2 perType link type');
    const total = totals.get(linkType);
    if (!total) throw new Error(`Cat2 per-type evidence missing: ${linkType}`);
    for (const key of ['gold', 'correctly_typed', 'mistyped', 'missed', 'spurious'] as const) checkMeasurement(raw[key], total[key], `Cat2 ${linkType}.${key}`);
  }
  const pooled = [...totals.values()].reduce((sum, row) => ({
    correct: sum.correct + row.correctly_typed,
    found: sum.found + row.correctly_typed + row.mistyped,
    denominator: sum.denominator + 2 * row.correctly_typed + row.mistyped + row.missed + row.spurious,
  }), { correct: 0, found: 0, denominator: 0 });
  if (data.overallTypeAccuracy !== undefined) checkMeasurement(data.overallTypeAccuracy, pooled.found ? pooled.correct / pooled.found : 0, 'Cat2 overallTypeAccuracy');
  if (data.overallStrictF1 !== undefined) checkMeasurement(data.overallStrictF1, pooled.denominator ? 2 * pooled.correct / pooled.denominator : 0, 'Cat2 overallStrictF1');
  return [...byPage.keys()].sort().flatMap(slug => [...byPage.get(slug)!].map(([linkType, counts]) => ({
    probe_id: `page:${JSON.stringify(slug)}:type:${JSON.stringify(linkType)}`, family_id: slug, slices: [linkType], contributed: true,
    metrics: {
      f1_strict: fraction(2 * counts.correctly_typed, 2 * counts.correctly_typed + counts.spurious + counts.mistyped + counts.missed),
      type_accuracy: fraction(counts.correctly_typed, counts.correctly_typed + counts.mistyped),
      recall: fraction(counts.correctly_typed, counts.gold),
      precision: fraction(counts.correctly_typed, counts.correctly_typed + counts.spurious),
    },
  })));
}

function collectTemporal(root: Evidence, data: Evidence): NativeRegressionObservation[] {
  const errors = errorsOf(root);
  return nativeEvidenceRows(data.rows, 'Cat4').map(row => {
    const probeId = text(row.probe_id, 'Cat4 probe ID');
    const kind = text(row.kind, `${probeId} kind`);
    if (!['point', 'range', 'recency', 'asof', 'setup'].includes(kind)) throw new Error(`unknown Cat4 kind: ${kind}`);
    const slices = kind === 'setup' ? [] : kind === 'range'
      ? ['range', row.status === 'error' ? text(probeId.startsWith('range:') ? probeId.slice(6) : undefined, 'Cat4 failed range label') : text(row.label, 'Cat4 range label')]
      : [kind];
    const contributed = boolean(row.contributed, `${probeId} contributed`);
    const observation: NativeRegressionObservation = { probe_id: probeId, family_id: probeId, slices, contributed, metrics: {} };
    if (!contributed) {
      if (row.status !== 'error') throw new Error(`Cat4 unscored probe has no recorded error status: ${probeId}`);
      const error = recordedError(errors, probeId, true);
      if (!error) throw new Error(`Cat4 failure origin is missing: ${probeId}`);
      observation.error = { ...error, message: text(row.error, `${probeId} error`) };
      return observation;
    }
    if (row.status !== 'scored' || kind === 'setup') throw new Error(`Cat4 invalid scored status: ${probeId}`);
    if (kind === 'asof') {
      observation.metrics.asOfAcc = Number(boolean(row.correct, `${probeId} correct`));
    } else {
      const hits = count(row.hits, `${probeId} hits`);
      const expected = count(row.expected, `${probeId} expected`);
      const returned = count(row.returned, `${probeId} returned`);
      if (hits > expected || hits > returned) throw new Error(`Cat4 hits exceed native counts: ${probeId}`);
      if (kind === 'point') {
        observation.metrics.pointRecall = fraction(hits, expected);
        observation.metrics.pointPrecision = fraction(hits, returned);
      } else if (kind === 'range') {
        observation.metrics.rangeRecall = nativeFinite(row.recall, `${probeId} recall`);
        observation.metrics.rangePrecision = nativeFinite(row.precision, `${probeId} precision`);
      } else observation.metrics.recencyAcc = fraction(hits, expected);
    }
    observation.error = recordedError(errors, probeId);
    return observation;
  });
}

function collectCat6(root: Evidence, data: Evidence): NativeRegressionObservation[] {
  const errors = errorsOf(root);
  const rows = nativeEvidenceRows(data.rows, 'Cat6');
  const kinds = ['code_fence_leak', 'inline_code_slug', 'substring_collision', 'ambiguous_role', 'multi_entity_sentence'];
  const counts = rows.map(row => {
    const probeId = text(row.probe_id, 'Cat6 probe ID');
    const kind = text(row.kind, `${probeId} kind`);
    if (probeId !== row.variantId || !kinds.includes(kind)) throw new Error(`Cat6 variant identity/kind mismatch: ${probeId}`);
    const contributed = boolean(row.contributed, `${probeId} contributed`);
    const gold = nativeEvidenceObject(row.goldDelta, `${probeId} goldDelta`);
    const must = length(gold.must_extract, `${probeId} must_extract`);
    const mustNot = length(gold.must_not_extract, `${probeId} must_not_extract`);
    const matched = count(row.matched, `${probeId} matched`);
    const mistyped = length(row.mistyped, `${probeId} mistyped`);
    const missed = length(row.missed, `${probeId} missed`);
    const fp = length(row.false_positives, `${probeId} false_positives`);
    if (matched + mistyped + missed !== must || fp > mustNot) throw new Error(`Cat6 gold partition mismatch: ${probeId}`);
    return { row, probeId, kind, contributed, must, mustNot, matched, mistyped, fp };
  });
  const pooled = counts.filter(row => row.contributed).reduce((total, row) => ({
    must: total.must + row.must,
    predicted: total.predicted + row.matched + row.mistyped + row.fp,
  }), { must: 0, predicted: 0 });
  const observations: NativeRegressionObservation[] = counts.map(({ row, probeId, kind, contributed, must, mustNot, matched, mistyped, fp }) => {
    const observation: NativeRegressionObservation = {
      probe_id: probeId, family_id: text(row.baseSlug, `${probeId} baseSlug`), slices: [kind], contributed, metrics: {},
    };
    if (!contributed) {
      observation.error = recordedError(errors, probeId, true);
      if (!observation.error) throw new Error(`Cat6 excluded variant lacks a recorded failure: ${probeId}`);
      return observation;
    }
    if (row.sut_error !== undefined) observation.error = { probe_id: probeId, origin: 'sut', message: text(row.sut_error, `${probeId} sut_error`) };
    else observation.error = recordedError(errors, probeId);
    const predicted = matched + mistyped + fp;
    const f1: RegressionMetricValue = pooled.must === 0 || pooled.predicted === 0
      ? { not_applicable: 'native_no_denominator', evidence: { expected_count: must, returned_count: predicted } }
      : fraction(2 * matched, must + predicted);
    observation.metrics = {
      link_recall: fraction(matched, must),
      link_precision: fraction(matched, predicted),
      link_f1: f1,
    };
    if (kind === 'code_fence_leak') observation.metrics.code_fence_leak_rate = fraction(fp, mustNot);
    if (kind === 'inline_code_slug') observation.metrics.inline_code_leak_rate = fraction(fp, mustNot);
    if (kind === 'substring_collision') observation.metrics.substring_fp_rate = fraction(fp, mustNot);
    if (kind === 'ambiguous_role') observation.metrics.ambiguous_role_type_match_rate = fraction(matched, matched + mistyped);
    return observation;
  });
  const controls = data.negative_controls === undefined && root.run_status === 'error'
    ? [] : nativeEvidenceRows(data.negative_controls, 'Cat6 negative_controls');
  for (const control of controls) {
    const name = text(control.control, 'Cat6 negative control ID');
    if (!['code_leak_detectable', 'substring_fp_detectable'].includes(name)) throw new Error(`unknown Cat6 negative control: ${name}`);
    const probeId = `native-gate:${name}`;
    const fired = boolean(control.fired, `${probeId} fired`);
    if (fired !== (count(control.fired_on, `${probeId} fired_on`) > 0)) throw new Error(`Cat6 negative control count mismatch: ${probeId}`);
    const error = recordedError(errors, `negative-control:${name}`);
    observations.push({
      probe_id: probeId, family_id: probeId, slices: [], contributed: true,
      metrics: { 'negative_controls.fired': Number(fired) },
      error: error ? { ...error, probe_id: probeId } : undefined,
    });
  }
  return observations;
}

export function collectNativeRows246(category: Category, artifact: unknown): NativeRegressionObservation[] {
  const root = nativeEvidenceObject(artifact, `${category} artifact`);
  const receiptCategory = { cat2: 'type-accuracy', cat4: 'temporal', cat6: 'cat6-prose-scale' }[category];
  const data = root.data === undefined ? root : nativeEvidenceObject(root.data, `${category} receipt.data`);
  if (root.data !== undefined && root.category !== receiptCategory) throw new Error(`${category} receipt category mismatch`);
  const observations = category === 'cat2' ? collectTypeAccuracy(root, data)
    : category === 'cat4' ? collectTemporal(root, data) : collectCat6(root, data);
  if (new Set(observations.map(row => row.probe_id)).size !== observations.length) throw new Error(`duplicate ${category} native observations`);
  return observations;
}
