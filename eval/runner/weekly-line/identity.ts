/**
 * A weekly run's identity (run.json): what one week's run scores, written by the weekly runner (runner.ts) in custody
 * beside the run's cell records and read back by the aggregates writer, which scores exactly that run (preregistration
 * docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md, "Harness" item 4).
 *
 * The identity names the week (its Tuesday launch date) and world end, the Set W batch and week of that batch the worlds
 * came from (or the batch whose spares filled the week), the frozen gbrain release and commit, the comparators' versions,
 * the week's worlds in slot order with their seed and phrasing ids (the world's Set W seed set, W1-long for a long world,
 * and the seed line it phrases from; worldSeedProblems), the cells and particle-1 re-reads, and the week's
 * no-point reason, if any. Its run id is `wl-<week>-<first 12 hex of the SHA-256 of the rest>`, so an edited identity no
 * longer matches its id. The aggregates refuse a week meta, a record directory, a settled marker or a record that belongs
 * to another run or week (runBindingProblems). Each record a weekly cell writes carries the run id and week it ran under
 * (memory-qa/records.ts weekly_run, from the run id the launch path passes in GBRAIN_EVALS_WEEKLY_RUN), and the aggregates
 * refuse any answer or judgment without this run's stamp (recordBindingProblems), so another run's files left in a run
 * directory never count.
 */
import { createHash } from 'node:crypto';
import { bgwSeedSetOf, bgwSlotOf } from '../memory-qa/bg1-names.ts';
import { WEEKLY_RUN_ID, type WeeklyRunStamp } from '../memory-qa/records.ts';
import type { WlNoPoint, WlServer } from './design.ts';

export const RUN_SCHEMA = 'gbrain-evals/weekly-line-run/v1';
export const RUN_FILE = 'run.json';
export const RUN_ID = WEEKLY_RUN_ID;

export interface GbrainBuild { release: string; commit: string }
export interface RunWorld { world: string; seed_id: string; phrasing_id: string }

export interface RunIdentity {
  schema: typeof RUN_SCHEMA;
  run_id: string;
  week: string;
  world_end: string;
  /** The Set W batch whose kept worlds the week reads (bgw-<first slot>), and the week of that batch, 1 to 4; null for a week with no worlds. */
  batch: string | null;
  week_of_batch: number | null;
  /** The earlier batch whose two spares filled this week, or null. */
  spares_from: string | null;
  gbrain: GbrainBuild | null;
  comparators: Record<WlServer, { version: string; fixed: string }> | null;
  worlds: RunWorld[];
  cells: string[];
  rereads: string[];
  no_point: WlNoPoint | null;
}

export type RunBody = Omit<RunIdentity, 'schema' | 'run_id'>;

const canonical = (b: RunBody) => JSON.stringify([b.week, b.world_end, b.batch, b.week_of_batch, b.spares_from, b.gbrain && [b.gbrain.release, b.gbrain.commit],
  b.comparators && Object.keys(b.comparators).sort().map(k => [k, b.comparators![k as WlServer].version, b.comparators![k as WlServer].fixed]),
  b.worlds.map(w => [w.world, w.seed_id, w.phrasing_id]), b.cells, b.rereads, b.no_point]);

/** The run id of an identity's body. */
export const runIdOf = (b: RunBody): string => `wl-${b.week}-${createHash('sha256').update(canonical(b)).digest('hex').slice(0, 12)}`;

/** A run identity from its body, with its run id. */
export const runIdentity = (b: RunBody): RunIdentity => ({ schema: RUN_SCHEMA, run_id: runIdOf(b), ...b });

/**
 * Why worlds may not be counted together: a world whose seed id is not its slot's Set W seed set (bg1-names.ts
 * BGW_SEED_SETS: W1 on slots 1001 to 1999, W1-long on 2001 to 2999) or whose phrasing id is not that set's seed line, or
 * worlds of more than one length profile, so a standard and a long world are never confused or pooled. Empty when none.
 */
export function worldSeedProblems(worlds: ReadonlyArray<{ world: string; seed_id: string; phrasing_id: string }>): string[] {
  const p: string[] = [], lengths = new Set<string>();
  for (const w of worlds) {
    const set = bgwSeedSetOf(bgwSlotOf(w.world) ?? Number.NaN);
    if (!set) { p.push(`${w.world} is in no Set W seed set`); continue; }
    lengths.add(set.profile);
    if (w.seed_id !== set.id || w.phrasing_id !== set.seed) p.push(`${w.world} is seed set ${set.id}'s world (phrasing ${set.seed}), not seed ${w.seed_id} with phrasing ${w.phrasing_id}`);
  }
  if (lengths.size > 1) p.push(`the worlds mix the ${[...lengths].sort().join(' and ')} lengths, which are never counted together`);
  return p;
}

/** The part of a week's meta a run must agree with. */
export interface RunWeek {
  run_id: string;
  week: string;
  no_point?: WlNoPoint | null;
  gbrain: GbrainBuild | null;
  worlds: ReadonlyArray<{ world: string; seed_id: string; phrasing_id: string }>;
}

/** Why a run identity is not the run of this week's meta; empty when it is. */
export function runBindingProblems(run: unknown, week: RunWeek): string[] {
  const r = run as Partial<RunIdentity> | null;
  if (typeof r !== 'object' || r === null || r.schema !== RUN_SCHEMA) return [`the run identity for week ${week.week} is not a ${RUN_SCHEMA} identity`];
  const p: string[] = [];
  const { schema: _s, run_id, ...body } = r as RunIdentity;
  if (run_id !== runIdOf(body)) p.push(`the run identity ${String(run_id)} does not match its own contents`);
  if (run_id !== week.run_id) p.push(`the records belong to run ${String(run_id)}, not to week ${week.week}'s run ${week.run_id}`);
  if (r.week !== week.week) p.push(`the run is week ${String(r.week)}'s, not week ${week.week}'s`);
  if ((r.no_point ?? null) !== (week.no_point ?? null)) p.push(`the run and week ${week.week}'s meta disagree on whether the week has a point`);
  const g = r.gbrain ?? null, wg = week.gbrain ?? null;
  if ((g === null) !== (wg === null) || (g && wg && (g.release !== wg.release || g.commit !== wg.commit))) p.push(`the run froze another gbrain build than week ${week.week}'s meta names`);
  const ws = r.worlds ?? [];
  if (ws.length !== week.worlds.length || ws.some((w, i) => w.world !== week.worlds[i].world || w.seed_id !== week.worlds[i].seed_id || w.phrasing_id !== week.worlds[i].phrasing_id)) p.push(`the run's worlds are not week ${week.week}'s Set W worlds`);
  p.push(...worldSeedProblems(ws));
  return p;
}

/**
 * Why a run's records do not belong to it: an answer or judgment not stamped by this run's cells (weekly_run, written by
 * the cell under the run id the launch path passes it), a record from a cell outside the run or a world outside its week.
 */
export function recordBindingProblems(run: Pick<RunIdentity, 'run_id' | 'week' | 'cells' | 'rereads' | 'worlds'>, answers: ReadonlyArray<{ cell_id: string; conversation: string; weekly_run?: WeeklyRunStamp }>,
  judgments: ReadonlyArray<{ weekly_run?: WeeklyRunStamp }> = []): string[] {
  const cells = new Set([...run.cells, ...run.rereads]), worlds = new Set(run.worlds.map(w => w.world));
  const strayCells = new Set(answers.filter(a => !cells.has(a.cell_id)).map(a => a.cell_id));
  const strayWorlds = answers.filter(a => !worlds.has(a.conversation)).length;
  const unstamped = [...answers, ...judgments].filter(r => r.weekly_run?.run_id !== run.run_id || r.weekly_run?.week !== run.week).length;
  return [
    ...(unstamped ? [`${unstamped} record${unstamped === 1 ? '' : 's'} in run ${run.run_id}'s records ${unstamped === 1 ? 'was' : 'were'} not written by this run's cells (no weekly_run stamp of run ${run.run_id}, week ${run.week})`] : []),
    ...(strayCells.size ? [`${strayCells.size} cell${strayCells.size === 1 ? '' : 's'} in run ${run.run_id}'s records ${strayCells.size === 1 ? 'is' : 'are'} not among its cells and re-reads`] : []),
    ...(strayWorlds ? [`${strayWorlds} answer${strayWorlds === 1 ? '' : 's'} in run ${run.run_id}'s records ${strayWorlds === 1 ? 'is' : 'are'} on a world outside its week`] : []),
  ];
}
