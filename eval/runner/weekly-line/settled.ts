/**
 * A week's settled marker: the weekly runner writes it in custody only when every cell, particle-1 re-read and judgment
 * of that week is done or recorded as a harness failure, or when the week records no point. A block ends only when all
 * four of its weeks carry one, so a partial fourth week never ends a block (#611 read-only review, blocker 1; GBEV-3
 * ruling, 2026-11-23).
 *
 * A marker names its run (identity.ts) and week, the week's no-point reason (or null), its gbrain build, its worlds in slot order and the
 * count of steps it settled. The block writer checks each marker against the week's meta, so a marker from another week
 * or another build never settles a week.
 *
 * It also records the SHA-256 of every answer and judgment file under the run's cells/ directory at settle time
 * (recordDigests). The aggregates re-check them (recordDigestProblems) and refuse a run whose record files changed, appeared
 * or went missing after the week settled (#616 final review, finding 2; GBEV-3 ruling, 2026-11-23).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WlNoPoint } from './design.ts';

export const SETTLED_SCHEMA = 'gbrain-evals/weekly-line-settled/v1';
export const SETTLED_FILE = 'settled.json';
/** The record files under cells/<cell id>/ that the aggregates read (records.ts readRecordDirs). */
export const RECORD_FILES = ['answers.ndjson', 'judgments.ndjson'] as const;

/** One record file of a run, relative to the run directory, with the SHA-256 of its bytes. */
export interface RecordDigest { file: string; sha256: string }

export interface SettledMarker {
  schema: typeof SETTLED_SCHEMA;
  run_id: string;
  week: string;
  no_point: WlNoPoint | null;
  gbrain: { release: string; commit: string } | null;
  worlds: string[];
  steps: { cells: number; rereads: number; judgments: number; harness_failures: number };
  /** Every answer and judgment file of the run at settle time, in path order; empty for a run with none. */
  records: RecordDigest[];
}

/** The part of a week's meta a marker must agree with. */
export interface SettledWeek {
  run_id: string;
  week: string;
  no_point?: WlNoPoint | null;
  gbrain: { release: string; commit: string } | null;
  worlds: ReadonlyArray<{ world: string }>;
}

const isCount = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;

/** The SHA-256 of every answer and judgment file under the run directory's cells/<cell id>/, in path order. */
export function recordDigests(dir: string): RecordDigest[] {
  const cells = join(dir, 'cells');
  if (!existsSync(cells)) return [];
  return readdirSync(cells).sort().flatMap(cell => RECORD_FILES.map(f => join('cells', cell, f)).filter(f => existsSync(join(dir, f)))
    .map(file => ({ file, sha256: createHash('sha256').update(readFileSync(join(dir, file))).digest('hex') })));
}

/** Why the run directory's record files are not the ones its settled marker digested; empty when they are. */
export function recordDigestProblems(marker: unknown, dir: string): string[] {
  const want = (marker as { records?: unknown } | null)?.records;
  if (!Array.isArray(want) || want.some(r => typeof r?.file !== 'string' || !/^[0-9a-f]{64}$/.test(r?.sha256 ?? ''))) return [`the settled marker in ${dir} records no digest of the answer and judgment files it settled`];
  const settled = new Map((want as RecordDigest[]).map(r => [r.file, r.sha256])), now = new Map(recordDigests(dir).map(r => [r.file, r.sha256]));
  const changed = [...now].filter(([f, h]) => settled.has(f) && settled.get(f) !== h).map(([f]) => f);
  const added = [...now.keys()].filter(f => !settled.has(f)), gone = [...settled.keys()].filter(f => !now.has(f));
  return [
    ...(changed.length ? [`${changed.length} record file${changed.length === 1 ? '' : 's'} changed since the week settled (first ${changed[0]})`] : []),
    ...(added.length ? [`${added.length} record file${added.length === 1 ? '' : 's'} appeared since the week settled (first ${added[0]})`] : []),
    ...(gone.length ? [`${gone.length} record file${gone.length === 1 ? '' : 's'} the week settled ${gone.length === 1 ? 'is' : 'are'} missing (first ${gone[0]})`] : []),
  ];
}

/** Why a marker does not settle the week; empty when it does. */
export function settledProblems(marker: unknown, week: SettledWeek): string[] {
  const m = marker as Partial<SettledMarker> | null;
  if (typeof m !== 'object' || m === null || m.schema !== SETTLED_SCHEMA) return [`a settled marker for week ${week.week} is not a ${SETTLED_SCHEMA} marker`];
  const p: string[] = [];
  if (m.week !== week.week) p.push(`the settled marker names week ${String(m.week)}, not ${week.week}`);
  if (m.run_id !== week.run_id) p.push(`the settled marker for week ${week.week} settles run ${String(m.run_id)}, not the week's run ${week.run_id}`);
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
