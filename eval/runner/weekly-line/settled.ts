/**
 * A week's settled marker: the weekly runner writes it in custody only when every cell, particle-1 re-read and judgment
 * of that week is done or recorded as a harness failure, or when the week records no point. A block ends only when all
 * four of its weeks carry one, so a partial fourth week never ends a block (#611 read-only review, blocker 1; GBEV-3
 * ruling, 2026-11-23).
 *
 * A marker names its week, the week's no-point reason (or null), its gbrain build, its worlds in slot order and the
 * count of steps it settled. The block writer checks each marker against the week's meta, so a marker from another week
 * or another build never settles a week.
 */
import type { WlNoPoint } from './design.ts';

export const SETTLED_SCHEMA = 'gbrain-evals/weekly-line-settled/v1';

export interface SettledMarker {
  schema: typeof SETTLED_SCHEMA;
  week: string;
  no_point: WlNoPoint | null;
  gbrain: { release: string; commit: string } | null;
  worlds: string[];
  steps: { cells: number; rereads: number; judgments: number; harness_failures: number };
}

/** The part of a week's meta a marker must agree with. */
export interface SettledWeek {
  week: string;
  no_point?: WlNoPoint | null;
  gbrain: { release: string; commit: string } | null;
  worlds: ReadonlyArray<{ world: string }>;
}

const isCount = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;

/** Why a marker does not settle the week; empty when it does. */
export function settledProblems(marker: unknown, week: SettledWeek): string[] {
  const m = marker as Partial<SettledMarker> | null;
  if (typeof m !== 'object' || m === null || m.schema !== SETTLED_SCHEMA) return [`a settled marker for week ${week.week} is not a ${SETTLED_SCHEMA} marker`];
  const p: string[] = [];
  if (m.week !== week.week) p.push(`the settled marker names week ${String(m.week)}, not ${week.week}`);
  if ((m.no_point ?? null) !== (week.no_point ?? null)) p.push(`the settled marker for week ${week.week} disagrees with its meta on whether the week has a point`);
  const g = m.gbrain ?? null, wg = week.gbrain ?? null;
  if ((g === null) !== (wg === null) || (g && wg && (g.release !== wg.release || g.commit !== wg.commit))) p.push(`the settled marker for week ${week.week} names another gbrain build than its meta`);
  const ids = week.no_point ? [] : week.worlds.map(w => w.world);
  if (!Array.isArray(m.worlds) || m.worlds.length !== ids.length || m.worlds.some((w, i) => w !== ids[i])) p.push(`the settled marker for week ${week.week} names other worlds than its meta`);
  const s = m.steps;
  if (!s || !isCount(s.cells) || !isCount(s.rereads) || !isCount(s.judgments) || !isCount(s.harness_failures)) p.push(`the settled marker for week ${week.week} has no step counts`);
  else if (!week.no_point && (s.cells === 0 || s.judgments === 0)) p.push(`the settled marker for week ${week.week} settles a point week with no cells or judgments`);
  return p;
}
