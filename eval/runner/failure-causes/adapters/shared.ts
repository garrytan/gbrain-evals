import type { EvalFailure, SourceCounts, StressCount } from '../types.ts';

export interface AdapterOutput { failures: EvalFailure[]; stress: StressCount[]; counts: SourceCounts }

export const emptyCounts = (): SourceCounts => ({ read: 0, mapped: 0, duplicate: 0, skipped: 0, failed: 0, skipped_reasons: {} });

export function skip(c: SourceCounts, reason: string): void {
  c.skipped++;
  c.skipped_reasons[reason] = (c.skipped_reasons[reason] ?? 0) + 1;
}
