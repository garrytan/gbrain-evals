import type { EvalFailure, SourceCounts, StressCount } from '../types.ts';

/** not_run: tasks a system never ran (EvalFailure.not_run set, failed false); their answers still count as skipped. */
export interface AdapterOutput { failures: EvalFailure[]; stress: StressCount[]; counts: SourceCounts; not_run?: EvalFailure[] }

export const emptyCounts = (): SourceCounts => ({ read: 0, mapped: 0, duplicate: 0, skipped: 0, failed: 0, skipped_reasons: {} });

export function skip(c: SourceCounts, reason: string): void {
  c.skipped++;
  c.skipped_reasons[reason] = (c.skipped_reasons[reason] ?? 0) + 1;
}
