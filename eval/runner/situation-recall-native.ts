import type { ProbeError } from './receipt.ts';
import { ProbeAccounting, type ProbeSummary } from './probe-accounting.ts';
import type { RegressionMetricValue, RegressionProbeRow, RegressionProfile } from './situation-recall-contract.ts';

export interface NativeRegressionObservation {
  probe_id: string;
  slices: string[];
  family_id?: string;
  metrics: Record<string, RegressionMetricValue>;
  contributed: boolean;
  error?: ProbeError;
  feature?: RegressionProbeRow['feature'];
}

export function normalizeNativeProbeError(error: ProbeError): ProbeError {
  const accounting = new ProbeAccounting(1);
  accounting.error(error.probe_id, error.origin, error.message);
  return accounting.summary().errors[0];
}

export function materializeNativeRegressionRows(profile: RegressionProfile, observations: NativeRegressionObservation[]): RegressionProbeRow[] {
  if (new Set(observations.map(r => r.probe_id)).size !== observations.length) throw new Error('duplicate native probe observations');
  if (observations.length !== profile.probes.length || observations.some(row => !profile.probes.some(p => p.probe_id === row.probe_id))) throw new Error('native observations do not match the complete registered probe IDs');
  return observations.map(row => {
    const expected = profile.probes.find(p => p.probe_id === row.probe_id)!;
    if (row.family_id !== undefined && row.family_id !== expected.family_id) throw new Error(`native family identity mismatch: ${row.probe_id}`);
    if (new Set(row.slices).size !== row.slices.length || [...row.slices].sort().join('\0') !== [...expected.slices].sort().join('\0')) throw new Error(`native slice identity mismatch: ${row.probe_id}`);
    if (!row.contributed && !row.error) throw new Error(`excluded native probe lacks recorded failure: ${row.probe_id}`);
    if (row.error && row.error.probe_id !== row.probe_id) throw new Error(`native error identity mismatch: ${row.probe_id}`);
    if (Object.keys(row.metrics).some(id => !profile.metrics.some(m => m.id === id))) throw new Error(`unmapped native metric: ${row.probe_id}`);
    const metrics: Record<string, RegressionMetricValue> = {};
    for (const metric of profile.metrics) {
      const exclusion = expected.no_gold_metrics.includes(metric.id) ? 'no_gold' : expected.positive_probe_metrics?.includes(metric.id) ? 'positive_probe'
        : (metric.applies_to && !metric.applies_to.some(s => s === 'all' || row.slices.includes(s))) || (metric.probe_ids && !metric.probe_ids.includes(row.probe_id)) ? 'outside_metric_slice' : null;
      if (exclusion) {
        const observed = row.metrics[metric.id];
        if (observed !== undefined && (typeof observed !== 'object' || !('not_applicable' in observed) || observed.not_applicable !== exclusion)) throw new Error(`frozen exclusion conflicts with native evidence: ${row.probe_id}/${metric.id}`);
        metrics[metric.id] = { not_applicable: exclusion };
      }
      else if (Object.hasOwn(row.metrics, metric.id)) metrics[metric.id] = row.metrics[metric.id];
      else if (row.contributed) throw new Error(`native metric evidence missing: ${row.probe_id}/${metric.id}`);
    }
    return { probe_id: row.probe_id, metrics, ...(row.error ? { error: normalizeNativeProbeError(row.error) } : {}), ...(row.feature ? { feature: row.feature } : {}) };
  });
}

export function nativeEvidenceObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an evidence object`);
  return value as Record<string, unknown>;
}

export function nativeEvidenceRows(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} per-item evidence is missing`);
  return value.map((row, i) => nativeEvidenceObject(row, `${label}[${i}]`));
}

export function nativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} is not a finite native measurement`);
  return value;
}

export async function collectSituationNativeRows(profile: RegressionProfile, artifact: unknown): Promise<RegressionProbeRow[]> {
  if (['cat2', 'cat4', 'cat6'].includes(profile.category)) {
    const { collectNativeRows246 } = await import('./situation-recall-native-2-4-6.ts');
    return materializeNativeRegressionRows(profile, collectNativeRows246(profile.category as 'cat2' | 'cat4' | 'cat6', artifact));
  }
  if (['cat18', 'cat18b', 'cat24'].includes(profile.category)) {
    const { collectNativeRows1824 } = await import('./situation-recall-native-18-24.ts');
    return materializeNativeRegressionRows(profile, collectNativeRows1824(profile.category as 'cat18' | 'cat18b' | 'cat24', artifact));
  }
  if (profile.category === 'cat35') {
    const { collectNativeRows35 } = await import('./situation-recall-native-35.ts');
    return materializeNativeRegressionRows(profile, collectNativeRows35(artifact));
  }
  throw new Error(`native row collector is not registered for ${profile.category}`);
}

export async function collectSituationNativeEvidence(profile: RegressionProfile, artifact: unknown): Promise<{
  release_eligible: false;
  rows: RegressionProbeRow[];
  accounting: ProbeSummary;
}> {
  const rows = await collectSituationNativeRows(profile, artifact);
  const accounting = new ProbeAccounting(profile.probes.length);
  for (const row of rows) {
    if (row.error) accounting.error(row.probe_id, row.error.origin, row.error.message);
    else accounting.score(row.probe_id, 1);
  }
  return { release_eligible: false, rows, accounting: accounting.summary() };
}
