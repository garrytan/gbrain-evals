#!/usr/bin/env bun
/**
 * The weekly held-out line's runner (preregistration docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md,
 * "Harness" item 4: newest gbrain release at launch, the week's worlds, the cells, the re-reads and the judging). It plans
 * and records one week's run in custody and never calls a provider: the paid cells launch through the existing launch
 * path (q1 cells on Ubicloud VMs from the custody host), which this runner hands a unit order to only under a granted
 * paid window.
 *
 *   bun eval/runner/weekly-line/runner.ts plan   --launch <Tuesday> --out <run dir> --batch bgw-<first> --batch-week1 <Tuesday>
 *                                                (--manifest <filled batch manifest> | --mint-failed)
 *                                                [--spares bgw-<first> --spare-manifest <filled manifest>] [--no-point "custody host offline"]
 *   bun eval/runner/weekly-line/runner.ts launch --run <run dir> --window-granted <unit> --window-cap-usd <the window's cap>
 *   bun eval/runner/weekly-line/runner.ts mark   --run <run dir> --step <step id> (--done | --harness-failure)
 *   bun eval/runner/weekly-line/runner.ts settle --run <run dir> [--costs <costs.json>] [--no-point "gbrain release failed to run"]
 *   bun eval/runner/weekly-line/runner.ts block  --block <n> --run <run dir>... --out <dir>
 *
 * Week and clock. A week is named by its Tuesday launch date, and its world end is the Sunday before (bgwWeekWorldEnd).
 * plan and launch refuse once the clock passes that world end by 14 days, and before the world end has passed
 * (bg1RunClock; the preregistration's "Dates").
 *
 * Worlds. A Set W batch is minted monthly and serves the four weeks from its first Tuesday (--batch-week1): week k of
 * the batch reads its kept worlds 8(k-1)+1 to 8k in slot order (bgwWeekWorlds). A mint still running refuses. Once a
 * batch is final, a week its own kept worlds do not reach has no worlds, except the first such week, which the previous
 * batch's two spares (its kept worlds 33 and 34) fill when --spares names that batch, the one just before it (this
 * batch starts one slot after it ended, at its 34th kept world, as custody's bgw-checks.ts batch check requires), so
 * each batch's spares fill at most one week. Any other week without worlds
 * records "no point: no worlds". --mint-failed stands for a batch whose mint kept no world.
 *
 * gbrain. The release is the highest version tag on gbrain's repository when the week is first planned (git ls-remote
 * --tags, injectable for tests), recorded with its commit and frozen for the week: a run directory that already holds
 * run.json keeps its build, and planning it again never resolves a newer one.
 *
 * Order. Launch the extract-first server's cells first (its ingest is the longest), then gbrain's, then the memory-bank
 * server's, then the grep agent's; then particle-1's re-reads of the frozen contexts; then the judging, each answer by
 * its reader's preregistered judge; then the aggregates writer. plan writes the run's identity (identity.ts, run.json)
 * and the ordered steps (plan.json) and prints them; launch writes the unit order (launch.json) for the existing launch
 * path, with the run id every weekly cell and re-read must run under (GBRAIN_EVALS_WEEKLY_RUN, which stamps each record),
 * and prints it, and refuses without --window-granted or when the launch check refuses the week's cells. Neither starts
 * a VM, a cell or a provider call.
 *
 * Settled. mark records each step as done or as a harness failure, in order (a re-read after its cell, a judgment after
 * the answers it judges). settle writes the week's meta (meta.json) and its settled marker (settled.ts, settled.json)
 * only once every cell, re-read and judgment is recorded, or for a week with no point; a week with a point also needs
 * its metered spend for every row, reader and world (--costs), since a settled week is never settled again.
 *
 * Blocks. block reads settled weeks only, so no week still running reaches the look, and writes a counted block file only after it proves, on synthetic values, that the block writer nulls an
 * open block's simultaneous interval and wild bootstrap and refuses to put an open block over an ended one (#611
 * read-only review blockers 2 and 3, which GBEV-3 ruled R113 integrity on 2026-11-23); otherwise it refuses
 * (WEEKLY_BLOCK_GUARDS).
 *
 * Cells. WIRED_CELL_SET builds the week's cells with harness PR (c)'s generateWeeklyLineCells and weeklyLineRereadPlans
 * (eval/runner/q1/cells/weekly-line.ts) from the week, its worlds and the frozen gbrain build, and plan keeps those
 * definitions in the run directory (cells.json). launch refuses unless they are the run's cells and pass the launch check
 * (launch.ts requireWeeklyLineLaunch) before it writes the unit order (WEEKLY_LAUNCH_CHECK, PREFLIGHT_FAILED). The tests
 * inject a cell set and a launch check.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GBRAIN_REPO, newestRelease } from '../gbrain-pin.ts';
import { sha256, WEEKLY_CELLS_ENV, WEEKLY_CELLS_SHA256_ENV, WEEKLY_RUN_ENV } from '../memory-qa/records.ts';
import { weeklyCampaignManifest, type WeeklyCellsFile } from '../q1/cell.ts';
import { BGW_BATCH_KEPT, BGW_BATCH_SLOTS, BGW_WEEKS_PER_BATCH, BGW_WORLDS_PER_WEEK, bgwBatchName, bgwSeedSetOf, bgwSlotOf } from '../memory-qa/bg1-names.ts';
import { bg1Kept, bg1RunClock, bgwSet, bgwWeekWorldEnd, bgwWeekWorlds, readBg1Manifest, type Bg1Manifest } from '../memory-qa/corpus.ts';
import { bg1JudgeOf, type CellDefinition } from '../q1/cells/definitions.ts';
import { generateWeeklyLineCells, WEEKLY_LINE_COMPARATORS, weeklyLineRereadPlans, type WeeklyLineRereadPlan, type WeeklyLineWeek } from '../q1/cells/weekly-line.ts';
import { blockAggregates, boundRecords, writeBlockFiles, type WeekMeta } from './aggregates.ts';
import { WL_READER_KEYS, WL_READERS, WL_ROWS, WL_SERVERS, WL_SYSTEMS, WL_WEEKS_PER_BLOCK, type WlNoPoint, type WlRow, type WlServer } from './design.ts';
import { recordBindingProblems, RUN_FILE, runIdentity, type GbrainBuild, type RunIdentity, type RunWorld } from './identity.ts';
import { requireWeeklyLineLaunch, type weeklyLineLaunchProblems } from './launch.ts';
import { plannedFor, questionsFromRecords, readRecordDirs, type WlQuestion } from './records.ts';
import { recordDigests, SETTLED_FILE, SETTLED_SCHEMA, type SettledMarker } from './settled.ts';
import type { CostCell } from './stats.ts';

export class WeeklyRunnerError extends Error {}
const refuse = (code: string, m: string): never => { throw new WeeklyRunnerError(`${code}: ${m}`); };
const [OPUS, PARTICLE] = WL_READERS;

// ─── Week and clock ──────────────────────────────────────────────────

const DAY = 86_400_000;
const dayOf = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY;

/** The week a Tuesday launch names and its world end (the Sunday before), refusing once the clock is more than 14 days past that world end or not yet past it. */
export function weekClock(launch: string, now: Date): { week: string; world_end: string } {
  let world_end: string;
  try {
    world_end = bgwWeekWorldEnd(launch);
    bg1RunClock({ worldEnd: world_end, now });
  } catch (e) {
    return refuse('WEEKLY_CLOCK', (e as Error).message);
  }
  return { week: launch, world_end };
}

// ─── The week's worlds ───────────────────────────────────────────────

/** A Set W batch as the monthly mint left it: its first slot, the Tuesday of its first week, and its filled manifest (null when the mint kept no world). */
export interface BatchInput { first: number; week1: string; manifest: Bg1Manifest | null }
export interface WeekWorlds { batch: string; week_of_batch: number; spares_from: string | null; worlds: RunWorld[] }

const runWorld = (id: string): RunWorld => {
  const set = bgwSeedSetOf(bgwSlotOf(id) ?? Number.NaN) ?? refuse('WEEKLY_WORLDS', `${id} is not a Set W world`);
  return { world: id, seed_id: set.id, phrasing_id: set.seed };
};

function keptOf(b: { first: number; manifest: Bg1Manifest | null }): { kept: string[]; final: boolean } {
  if (b.manifest === null) return { kept: [], final: true };
  try {
    const { kept, n_final } = bg1Kept(b.manifest, bgwSet(b.first));
    return { kept, final: n_final !== null && kept.length === n_final };
  } catch (e) {
    return refuse('WEEKLY_WORLDS', (e as Error).message);
  }
}

/**
 * The week's worlds: week k of the batch reads its kept worlds 8(k-1)+1 to 8k in slot order. A batch still minting
 * refuses. The first week a final batch cannot reach takes the previous batch's two spares, if given; any other week
 * without worlds gets none, and the runner records it as no point.
 */
export function weekWorlds(launch: string, batch: BatchInput, spares?: { first: number; manifest: Bg1Manifest }): WeekWorlds {
  const offset = dayOf(launch) - dayOf(batch.week1);
  const k = offset / 7 + 1;
  if (new Date(`${batch.week1}T00:00:00Z`).getUTCDay() !== 2) refuse('WEEKLY_NOT_IN_BATCH', `the batch's first week ${batch.week1} is not a Tuesday`);
  if (!Number.isInteger(k) || k < 1 || k > BGW_WEEKS_PER_BATCH) refuse('WEEKLY_NOT_IN_BATCH', `week ${launch} is not one of the ${BGW_WEEKS_PER_BATCH} weeks of batch ${bgwBatchName(batch.first)}, which start ${batch.week1}`);
  const name = bgwBatchName(batch.first);
  const { kept, final } = keptOf(batch);
  const own = kept.slice(BGW_WORLDS_PER_WEEK * (k - 1), BGW_WORLDS_PER_WEEK * k);
  if (own.length === BGW_WORLDS_PER_WEEK || (own.length && final)) return { batch: name, week_of_batch: k, spares_from: null, worlds: bgwWeekWorlds(batch.manifest!, k, bgwSet(batch.first)).map(runWorld) };
  if (!final) return refuse('WEEKLY_MINT_UNFINISHED', `batch ${name} keeps ${kept.length} worlds and is not final, so week ${k} of the batch cannot run yet`);
  const firstEmpty = Math.ceil(kept.length / BGW_WORLDS_PER_WEEK) + 1;
  if (k !== firstEmpty || !spares) return { batch: name, week_of_batch: k, spares_from: null, worlds: [] };
  const s = keptOf(spares);
  const end = s.kept.length >= BGW_BATCH_KEPT ? bgwSlotOf(s.kept[BGW_BATCH_KEPT - 1])! : spares.first + BGW_BATCH_SLOTS - 1;
  if (batch.first !== end + 1 || bgwSeedSetOf(spares.first) !== bgwSeedSetOf(batch.first)) refuse('WEEKLY_WORLDS', `spares come from the batch just before ${name}, and ${bgwBatchName(spares.first)} ended at slot ${end}, so the batch after it is bgw-${end + 1}`);
  const tail = s.kept.slice(BGW_WEEKS_PER_BATCH * BGW_WORLDS_PER_WEEK);
  if (!s.final || !tail.length) refuse('WEEKLY_WORLDS', `batch ${bgwBatchName(spares.first)} has no final spares to fill week ${launch}`);
  return { batch: name, week_of_batch: k, spares_from: bgwBatchName(spares.first), worlds: tail.map(runWorld) };
}

// ─── gbrain's newest release ─────────────────────────────────────────

/** The newest release in `git ls-remote --tags` output, with its commit (the peeled commit of an annotated tag). */
export function newestGbrainRelease(lsRemote: string): GbrainBuild {
  const commits = new Map<string, string>();
  for (const line of lsRemote.split('\n')) {
    const m = /^([0-9a-f]{40})\trefs\/tags\/([^\s^]+)(\^\{\})?$/.exec(line.trim());
    if (m && (m[3] || !commits.has(m[2]))) commits.set(m[2], m[1]);
  }
  const version = newestRelease([...commits.keys()]) ?? refuse('WEEKLY_GBRAIN', 'gbrain has no release tag');
  return { release: `v${version}`, commit: commits.get(`v${version}`)! };
}

/** gbrain's tags, read without credentials or the GitHub API. */
export function lsRemoteTags(): string {
  const p = spawnSync('git', ['ls-remote', '--tags', GBRAIN_REPO], { encoding: 'utf8', timeout: 60_000 });
  if (p.status !== 0) refuse('WEEKLY_GBRAIN', `git ls-remote --tags ${GBRAIN_REPO} exited ${p.status}`);
  return p.stdout;
}

// ─── The cell set (harness PR (c), eval/runner/q1/cells/weekly-line.ts) ─

/**
 * One reader's answers in one row. `unit` is the launch unit that runs it (the cell definition's id) and `records` the
 * cell id its answer records carry (the arm's cell id); both default to `id`. The grep agent's one cell runs both readers,
 * so its two entries share a unit and a records id. `shards` is how many launch units the unit splits into (1 by default):
 * a cell too long for one VM runs as units `<unit>.c<i>`, merged into the run directory before its re-read and judging.
 */
export interface WeeklyCell { id: string; row: WlRow; reader: string; worlds: string[]; unit?: string; records?: string; shards?: number }
/** particle-1's re-read of claude-opus-5-5's cell `from`; its id is its launch unit and the cell id its records carry. */
export interface WeeklyReread { id: string; row: WlRow; from: string; reader: string }
/** The cell definitions and re-read plans the launch path runs, kept in the run directory (cells.json) for the launch check. */
export interface WeeklyDefinitions { cells: CellDefinition[]; rereads: WeeklyLineRereadPlan[] }
export interface WeeklyCellPlan { cells: WeeklyCell[]; rereads: WeeklyReread[]; comparators: Record<WlServer, { version: string; fixed: string }>; definitions?: WeeklyDefinitions }
/** The week's cells and particle-1 re-reads for its week, worlds and frozen gbrain build. */
export type WeeklyCellSet = (input: { week: WeeklyLineWeek; worlds: readonly string[]; gbrain: GbrainBuild }) => WeeklyCellPlan;

const readerSlug = (reader: string) => reader.replace(/[^a-z0-9.-]+/gi, '-').toLowerCase();
const rowOf = (system: string): WlRow => WL_SYSTEMS[system] ?? refuse('WEEKLY_CELL_PLAN', `the cell set holds system ${system}, which is not one of the line's rows`);

/** The cell set: generateWeeklyLineCells and weeklyLineRereadPlans for the week, its worlds and the frozen gbrain build. */
export const WIRED_CELL_SET: WeeklyCellSet = ({ week, worlds, gbrain }) => {
  const cells = generateWeeklyLineCells({ week, worlds, gbrain });
  const rereads = weeklyLineRereadPlans(cells);
  return {
    cells: cells.flatMap(c => c.arms.flatMap(a => a.readers.map(reader => ({
      id: a.readers.length > 1 ? `${a.cell_id}.${readerSlug(reader)}` : a.cell_id, row: rowOf(c.system), reader, worlds: [...worlds], unit: c.id, records: a.cell_id, ...(c.shards > 1 ? { shards: c.shards } : {}),
    })))),
    rereads: rereads.map(r => ({ id: r.id, row: rowOf(cells.find(c => c.id === r.cell)!.system), from: r.arm_cell_id, reader: r.reader })),
    comparators: structuredClone(WEEKLY_LINE_COMPARATORS) as WeeklyCellPlan['comparators'],
    definitions: { cells, rereads },
  };
};

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/;

/** Why a cell plan is not the week's preregistered plan; empty when it is. */
export function cellPlanProblems(plan: WeeklyCellPlan, worlds: readonly string[]): string[] {
  const p: string[] = [];
  const ids = [...plan.cells.map(c => c.id), ...plan.rereads.map(r => r.id)];
  if (new Set(ids).size !== ids.length) p.push('a cell or re-read id appears twice');
  if (ids.some(id => !ID_RE.test(id))) p.push('a cell or re-read id is not a lower-case id');
  for (const c of plan.cells) {
    if (!(WL_ROWS as readonly string[]).includes(c.row)) p.push(`cell ${c.id} is in no row of the line`);
    if (!(WL_READERS as readonly string[]).includes(c.reader)) p.push(`cell ${c.id} is read by a reader outside the line`);
    if (c.worlds.length !== worlds.length || c.worlds.some((w, i) => w !== worlds[i])) p.push(`cell ${c.id} does not run exactly the week's worlds in slot order`);
  }
  for (const row of WL_ROWS) {
    const readers = row === 'grep-agent' ? [OPUS, PARTICLE] : [OPUS];
    for (const reader of readers) {
      const n = plan.cells.filter(c => c.row === row && c.reader === reader).length;
      if (n !== 1) p.push(`row ${row} needs one cell read by ${reader}, and has ${n}`);
    }
    if (row !== 'grep-agent' && plan.cells.some(c => c.row === row && c.reader === PARTICLE)) p.push(`row ${row} reads particle-1 as a re-read of the frozen contexts, not as a cell`);
    const rr = plan.rereads.filter(r => r.row === row);
    if (row === 'grep-agent' ? rr.length : rr.length !== 1) p.push(row === 'grep-agent' ? 'the grep agent has no re-read: particle-1 runs as the agent' : `row ${row} needs one particle-1 re-read, and has ${rr.length}`);
  }
  for (const r of plan.rereads) {
    const from = plan.cells.find(c => c.id === r.from);
    if (r.reader !== PARTICLE) p.push(`re-read ${r.id} is not read by particle-1`);
    if (!from || from.row !== r.row || from.reader !== OPUS) p.push(`re-read ${r.id} does not re-read claude-opus-5-5's cell in its row`);
  }
  for (const s of WL_SERVERS) if (!plan.comparators?.[s]?.version || !/^\d{4}-\d{2}-\d{2}$/.test(plan.comparators[s].fixed ?? '')) p.push(`the plan names no version and fixed date for the ${s} server`);
  return p;
}

// ─── Steps ───────────────────────────────────────────────────────────

/** Launch order: the extract-first server's ingest is the longest, so its cells go first, then gbrain's, the memory-bank server's and the grep agent's. */
export const LAUNCH_ORDER: readonly WlRow[] = ['extract-first', 'gbrain', 'memory-bank', 'grep-agent'];

export type Stage = 'launch' | 'merge' | 'reread' | 'judge' | 'aggregates';
/**
 * A step of the week; `unit` is the launch unit a launch or re-read step hands the launch path (for a merge, the cell its
 * units merge into), null for judging and the aggregates.
 */
export interface Step { id: string; stage: Stage; target: string; unit: string | null; row: WlRow | null; reader: string | null; judge: string | null; after: string[] }

/**
 * The week's steps in order: every cell's launch (one per launch unit of a cell split across VMs, then its merge), then
 * every re-read, then every judgment, then the aggregates. A split cell's answers are whole only after its merge, so its
 * re-read and judging wait on the merge, and the merge on every one of its units.
 */
export function weekSteps(plan: WeeklyCellPlan): Step[] {
  const rank = (row: WlRow, reader: string) => LAUNCH_ORDER.indexOf(row) * 2 + (reader === OPUS ? 0 : 1);
  const cells = [...plan.cells].sort((a, b) => rank(a.row, a.reader) - rank(b.row, b.reader));
  const rereads = [...plan.rereads].sort((a, b) => LAUNCH_ORDER.indexOf(a.row) - LAUNCH_ORDER.indexOf(b.row));
  const step = (s: Pick<Step, 'id' | 'stage' | 'target' | 'unit' | 'after'>, c: { row: WlRow; reader: string }): Step => ({ ...s, row: c.row, reader: c.reader, judge: null });
  const launch: Step[] = [], merge: Step[] = [], whole = new Map<string, Step>();
  for (const c of cells) {
    const unit = c.unit ?? c.id, n = c.shards ?? 1;
    if (n === 1) { const s = step({ id: `launch:${c.id}`, stage: 'launch', target: c.id, unit, after: [] }, c); launch.push(s); whole.set(c.id, s); continue; }
    const parts = Array.from({ length: n }, (_, i) => step({ id: `launch:${c.id}:c${i}`, stage: 'launch', target: c.id, unit: `${unit}.c${i}`, after: [] }, c));
    const m = step({ id: `merge:${c.id}`, stage: 'merge', target: c.id, unit, after: parts.map(p => p.id) }, c);
    launch.push(...parts); merge.push(m); whole.set(c.id, m);
  }
  const reread = rereads.map((r): Step => step({ id: `reread:${r.id}`, stage: 'reread', target: r.id, unit: r.id, after: [whole.get(r.from)?.id ?? `launch:${r.from}`] }, r));
  const judge = [...whole.values(), ...reread].map((s): Step => ({ id: `judge:${s.target}`, stage: 'judge', target: s.target, unit: null, row: s.row, reader: s.reader, judge: bg1JudgeOf(s.reader!), after: [s.id] }));
  return [...launch, ...merge, ...reread, ...judge, { id: 'aggregates:week', stage: 'aggregates', target: 'week', unit: null, row: null, reader: null, judge: null, after: judge.map(j => j.id) }];
}

// ─── Files in the run directory ──────────────────────────────────────

export const PLAN_FILE = 'plan.json';
export const PROGRESS_FILE = 'progress.ndjson';
export const LAUNCH_FILE = 'launch.json';
export const META_FILE = 'meta.json';
export { SETTLED_FILE };
export const CELLS_FILE = 'cells.json';
export const CAMPAIGN_FILE = 'campaign.json';

const readJson = (path: string): any => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : refuse('WEEKLY_RUN', `${path} does not exist`));
const writeJson = (path: string, x: unknown) => writeFileSync(path, JSON.stringify(x, null, 2) + '\n');
const loadRun = (dir: string) => ({ run: readJson(join(dir, RUN_FILE)) as RunIdentity, steps: (readJson(join(dir, PLAN_FILE)) as { steps: Step[] }).steps });

export type Status = 'done' | 'harness_failure';
/** Each step's latest recorded status. */
export function progressOf(dir: string): Map<string, Status> {
  const path = join(dir, PROGRESS_FILE);
  const out = new Map<string, Status>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(line) as { step: string; status: Status }; out.set(r.step, r.status); }
  return out;
}

// ─── Commands ────────────────────────────────────────────────────────

/** The check launch runs on a planned week before it writes the unit order; it throws to refuse. */
export type LaunchCheck = (dir: string, run: RunIdentity) => void;

/**
 * The launch check on the week's cell definitions (cells.json): they must be the run's cells and re-reads, and pass
 * requireWeeklyLineLaunch at the frozen gbrain build. `deps` reaches weeklyLineLaunchProblems (ripgrep, the registry).
 */
export function weeklyLaunchCheck(deps: Parameters<typeof weeklyLineLaunchProblems>[1] = {}): LaunchCheck {
  return (dir, run) => {
    const path = join(dir, CELLS_FILE);
    if (!existsSync(path)) refuse('WEEKLY_LAUNCH_CHECK', `week ${run.week}'s run has no ${CELLS_FILE}, so its cells cannot be checked before they launch; plan it again in a fresh run directory`);
    const d = readJson(path) as { run_id: string } & WeeklyDefinitions;
    const records = [...new Set(d.cells.flatMap(c => c.arms.map(a => a.cell_id)))].sort(), rereads = d.rereads.map(r => r.id).sort();
    if (d.run_id !== run.run_id || JSON.stringify(records) !== JSON.stringify([...run.cells].sort()) || JSON.stringify(rereads) !== JSON.stringify([...run.rereads].sort())) {
      refuse('WEEKLY_LAUNCH_CHECK', `${path} does not hold run ${run.run_id}'s cells and re-reads`);
    }
    requireWeeklyLineLaunch({ gbrain: run.gbrain!, cells: d.cells, rereads: d.rereads }, deps);
  };
}

export interface RunnerDeps { now: () => Date; lsRemote: () => string; cellSet: WeeklyCellSet | null; launchCheck: LaunchCheck }
export const DEFAULT_DEPS: RunnerDeps = { now: () => new Date(), lsRemote: lsRemoteTags, cellSet: WIRED_CELL_SET, launchCheck: weeklyLaunchCheck() };

export interface PlanInput { dir: string; launch: string; batch: BatchInput; spares?: { first: number; manifest: Bg1Manifest }; noPoint?: 'custody host offline' }

/** Plan a week: its clock, worlds, frozen gbrain build, cells and ordered steps, written to run.json and plan.json. A run directory already planned keeps its identity. */
export function planWeek(o: PlanInput, deps: RunnerDeps): { run: RunIdentity; steps: Step[]; frozen: boolean } {
  const { week, world_end } = weekClock(o.launch, deps.now());
  if (existsSync(join(o.dir, RUN_FILE))) {
    const { run, steps } = loadRun(o.dir);
    if (run.week !== week) refuse('WEEKLY_RUN', `${o.dir} holds week ${run.week}'s run, not week ${week}'s`);
    return { run, steps, frozen: true };
  }
  const w = o.noPoint ? null : weekWorlds(o.launch, o.batch, o.spares);
  const noPoint: WlNoPoint | null = o.noPoint ?? (w!.worlds.length ? null : 'no worlds');
  const base = { week, world_end, batch: w?.batch ?? bgwBatchName(o.batch.first), week_of_batch: w?.week_of_batch ?? null, spares_from: w?.spares_from ?? null };
  let body: Parameters<typeof runIdentity>[0], steps: Step[] = [], definitions: WeeklyDefinitions | null = null;
  if (noPoint) body = { ...base, gbrain: null, comparators: null, worlds: [], cells: [], rereads: [], no_point: noPoint };
  else {
    const gbrain = newestGbrainRelease(deps.lsRemote());
    const cellSet = deps.cellSet ?? refuse('WEEKLY_CELLS_NOT_WIRED', 'no weekly cell set is wired into this runner, so no week with a point can be planned');
    const ids = w!.worlds.map(x => x.world);
    const plan = cellSet({ week: { launch: week, world_end, batch: w!.spares_from ?? w!.batch }, worlds: ids, gbrain });
    const p = cellPlanProblems(plan, ids);
    if (p.length) refuse('WEEKLY_CELL_PLAN', p.slice(0, 5).join('; '));
    steps = weekSteps(plan);
    definitions = plan.definitions ?? null;
    body = { ...base, gbrain, comparators: plan.comparators, worlds: w!.worlds, cells: [...new Set(plan.cells.map(c => c.records ?? c.id))], rereads: plan.rereads.map(r => r.id), no_point: null };
  }
  const run = runIdentity(body);
  mkdirSync(o.dir, { recursive: true });
  writeJson(join(o.dir, RUN_FILE), run);
  writeJson(join(o.dir, PLAN_FILE), { run_id: run.run_id, steps });
  if (definitions) writeJson(join(o.dir, CELLS_FILE), { run_id: run.run_id, ...definitions });
  return { run, steps, frozen: false };
}

/** One particle-1 re-read as launch.json hands it over: the reread-cell.ts command inside the window, to which the host adds --source, --out and the lease flags. */
export interface LaunchReread { id: string; argv: string[] }
/** One split cell's merge as launch.json hands it over: the cell.ts merge command into the run directory, to which the host adds one --from per launch unit, in `units` order. */
export interface LaunchMerge { cell: string; units: string[]; argv: string[] }
export interface LaunchOrder {
  run_id: string; window: string; env: Record<string, string>; stages: Array<{ stage: Stage; units: string[] }>;
  /** With the week's cells.json: the window cap and its split (the re-reads' share, their plans' estimates, and the cells' campaign, the rest), the campaign manifest of the week's cells (CAMPAIGN_FILE) and the re-read commands. */
  cap_usd?: number; cells_cap_usd?: number; rereads_cap_usd?: number; campaign?: string; rereads?: LaunchReread[];
  /** The merges of cells split across VMs, each after all of its launch units. */
  merges?: LaunchMerge[];
}

/**
 * The unit order for the existing launch path, written to launch.json; refuses without a granted paid window, past the
 * clock, for a week with no point, or when the launch check refuses the week's cells. Launch and re-read stages list each
 * launch unit once; the judge stage lists every judged target. Starts nothing.
 *
 * A run planned from the wired cell set holds its cells.json (the launch check refuses a run without one), and its launch
 * also needs the window's cap (`capUsd`, --window-cap-usd). It writes the week's campaign manifest (campaign.json,
 * cell.ts weeklyCampaignManifest: each unit's command names `--manifest weekly` inside the window and exports the run id,
 * the cells.json SHA-256 and the world end, and its VM receives only its week's worlds and the cells.json), and `env` names
 * everything a weekly unit or re-read on the custody host reads: the run id, the cells.json and its SHA-256, the world end,
 * the Set W batch and the week's worlds as the loader's unit scope. The window's cap is split once, so the cells and the
 * re-reads can't together approve more than it: each re-read takes its own plan's estimate, rounded up to the cent (its
 * command's --window-cap-usd, which bounds its ledger cap), and the cells' campaign takes the rest (its cap_usd and every unit's
 * --window-cap-usd); a cap that leaves the cells nothing refuses.
 */
export function launchWeek(dir: string, window: string | undefined, deps: Pick<RunnerDeps, 'now' | 'launchCheck'>, capUsd?: number): LaunchOrder {
  const { run, steps } = loadRun(dir);
  if (!window) refuse('WEEKLY_NO_WINDOW', `week ${run.week}'s cells spend on providers, so they launch only inside a granted paid window; pass --window-granted <unit> once it is granted`);
  weekClock(run.week, deps.now());
  if (run.no_point) refuse('WEEKLY_NO_POINT', `week ${run.week} has no point (${run.no_point}), so nothing launches`);
  deps.launchCheck(dir, run);
  const stages = (['launch', 'merge', 'reread', 'judge'] as const).map(stage => ({ stage, units: [...new Set(steps.filter(s => s.stage === stage).map(s => (stage === 'judge' ? s.target : s.unit ?? s.target)))] }))
    .filter(s => s.stage !== 'merge' || s.units.length);
  const merges = steps.filter(s => s.stage === 'merge').map(s => ({ cell: s.unit!, units: steps.filter(p => s.after.includes(p.id)).map(p => p.unit!),
    argv: ['bun', 'eval/runner/q1/cell.ts', 'merge', '--cell', s.unit!, '--manifest', 'weekly', '--out', dir] }));
  let order: LaunchOrder = { run_id: run.run_id, window: window!, env: { [WEEKLY_RUN_ENV]: run.run_id }, stages, ...(merges.length ? { merges } : {}) };
  const cellsPath = join(dir, CELLS_FILE);
  if (existsSync(cellsPath)) {
    if (!(Number.isFinite(capUsd) && capUsd! > 0)) refuse('WEEKLY_NO_WINDOW', `week ${run.week}'s units carry the granted window's cap in every command; pass --window-cap-usd <the window's cap> with --window-granted`);
    const file = readJson(cellsPath) as WeeklyCellsFile;
    const week = file.cells[0].week!;
    const rereadCaps = file.rereads.map(r => Math.ceil(r.estimate.usd * 100) / 100);
    const rereadsCap = Math.round(rereadCaps.reduce((n, c) => n + c, 0) * 100) / 100;
    const cellsCap = Math.floor((capUsd! - rereadsCap) * 100) / 100;
    if (!(cellsCap > 0)) refuse('WEEKLY_NO_WINDOW', `week ${run.week}'s re-reads are estimated at ${rereadsCap}, which leaves the cells nothing of the window's cap ${capUsd}`);
    writeJson(join(dir, CAMPAIGN_FILE), weeklyCampaignManifest(file, { cellsPath, window: window!, cap_usd: cellsCap }));
    const flags = ['--manifest', 'weekly', '--paid-window', window!];
    order = { ...order, cap_usd: capUsd!, cells_cap_usd: cellsCap, rereads_cap_usd: rereadsCap, campaign: CAMPAIGN_FILE,
      env: { ...order.env, [WEEKLY_CELLS_ENV]: cellsPath, [WEEKLY_CELLS_SHA256_ENV]: sha256(readFileSync(cellsPath)), GBRAIN_EVALS_BG1_WORLD_END: week.world_end, GBRAIN_EVALS_BGW_BATCH: week.batch, GBRAIN_EVALS_BGW_UNIT: week.worlds.join(',') },
      rereads: file.rereads.map((r, i) => ({ id: r.id, argv: ['bun', 'eval/runner/q1/reread-cell.ts', '--cell', r.cell, '--arm', r.arm, '--reader', r.reader, ...flags, '--window-cap-usd', String(rereadCaps[i])] })) };
  }
  writeJson(join(dir, LAUNCH_FILE), order);
  return order;
}

/** Record a step as done or as a harness failure, after the steps it waits on; a done step is never re-marked, and nothing is marked once the week is settled. */
export function markStep(dir: string, stepId: string, status: Status): void {
  const { steps } = loadRun(dir);
  if (existsSync(join(dir, SETTLED_FILE))) refuse('WEEKLY_SETTLED', 'the week is already settled');
  const step = steps.find(s => s.id === stepId) ?? refuse('WEEKLY_STEP', `${stepId} is not a step of this run`);
  if (step.stage === 'aggregates') refuse('WEEKLY_STEP', 'the aggregates step is the aggregates writer, run after settle');
  const progress = progressOf(dir);
  if (progress.get(step.id) === 'done') refuse('WEEKLY_STEP', `${step.id} is already done`);
  const waiting = step.after.filter(a => !progress.has(a));
  if (waiting.length) refuse('WEEKLY_STEP', `${step.id} waits on ${waiting.join(', ')}`);
  appendFileSync(join(dir, PROGRESS_FILE), JSON.stringify({ step: step.id, status }) + '\n');
}

/**
 * Write the week's meta and its settled marker once every cell, re-read and judgment is done or a harness failure, or
 * for a week with no point; a week whose gbrain row failed to run settles as "no point: gbrain release failed to run".
 */
export function settleWeek(dir: string, o: { costs?: CostCell[]; gbrainFailed?: boolean } = {}): SettledMarker {
  const { run, steps } = loadRun(dir);
  if (existsSync(join(dir, SETTLED_FILE))) refuse('WEEKLY_SETTLED', 'the week is already settled');
  const progress = progressOf(dir);
  const work = steps.filter(s => s.stage !== 'aggregates');
  if (o.gbrainFailed && (run.no_point || !run.gbrain)) refuse('WEEKLY_NO_POINT', `week ${run.week} has no gbrain row to fail`);
  const pending = work.filter(s => !progress.has(s.id));
  if (pending.length && !o.gbrainFailed) refuse('WEEKLY_NOT_SETTLED', `${pending.length} of week ${run.week}'s ${work.length} cells, re-reads and judgments are not done or recorded as harness failures (first ${pending[0].id})`);
  const saved: CostCell[] = [];
  if (!run.no_point && !o.gbrainFailed) {
    const recordsOf = (s: Step) => run.rereads.includes(s.target) ? s.target : run.cells.find(id => s.target === id || s.target.startsWith(`${id}.`)) ?? s.target;
    const uncovered = work.filter(s => progress.get(s.id) === 'done').map(s => join('cells', recordsOf(s), s.stage === 'judge' ? 'judgments.ndjson' : 'answers.ndjson')).filter(f => !existsSync(join(dir, f)));
    if (uncovered.length) refuse('WEEKLY_RECORDS', `${uncovered.length} done step${uncovered.length === 1 ? ' has' : 's have'} no record file in the run directory, so nothing is settled (first ${uncovered[0]})`);
    const recs = existsSync(join(dir, 'cells')) ? readRecordDirs([dir]) : { answers: [], judgments: [] };
    const stamps = recordBindingProblems(run, recs.answers, recs.judgments);
    if (stamps.length) refuse('WEEKLY_RUN_IDENTITY', `week ${run.week}'s run directory holds records this run's cells did not write, so nothing is settled: ${stamps.slice(0, 3).join('; ')}`);
    const costs = o.costs ?? refuse('WEEKLY_COSTS', `week ${run.week} has a point, so settling it needs its metered spend for every row, reader and world (--costs)`);
    const key = (row: string, reader: string, world: string) => `${row}|${reader}|${world}`;
    if (!Array.isArray(costs)) refuse('WEEKLY_COSTS', `week ${run.week}'s spend must be a list of row, reader, world and usd entries`);
    const want = new Set(WL_ROWS.flatMap(row => WL_READER_KEYS.flatMap(reader => run.worlds.map(w => key(row, reader, w.world)))));
    const given = new Set<string>(), bad: string[] = [];
    for (const c of costs) {
      if (typeof c?.row !== 'string' || typeof c?.reader !== 'string' || typeof c?.world !== 'string') { bad.push(`${JSON.stringify(c)} does not name its row, reader and world as text`); continue; }
      const k = key(c.row, c.reader, c.world);
      if (!want.has(k)) bad.push(`${k} is not a row, reader and world of the week`);
      else if (given.has(k)) bad.push(`${k} is listed twice`);
      if (typeof c.usd !== 'number' || !Number.isFinite(c.usd) || c.usd < 0) bad.push(`${k} is not a finite number of at least 0`);
      given.add(k);
      saved.push({ row: c.row, reader: c.reader, world: c.world, usd: c.usd });
    }
    if (bad.length) refuse('WEEKLY_COSTS', `week ${run.week}'s spend list has ${bad.length} bad entr${bad.length === 1 ? 'y' : 'ies'}, so nothing is settled (first: ${bad[0]})`);
    const missing = [...want].filter(k => !given.has(k));
    if (missing.length) refuse('WEEKLY_COSTS', `week ${run.week}'s spend lacks ${missing.length} row, reader and world cell${missing.length === 1 ? '' : 's'} (first ${missing[0]})`);
  }
  const no_point: WlNoPoint | null = o.gbrainFailed ? 'gbrain release failed to run' : run.no_point;
  const worlds = no_point ? [] : run.worlds;
  const meta: WeekMeta = { week: run.week, run_id: run.run_id, gbrain: run.gbrain, comparators: run.comparators, worlds, costs: no_point ? [] : saved, no_point };
  const count = (stage: Stage) => work.filter(s => s.stage === stage && progress.has(s.id)).length;
  const split = new Set(work.filter(s => s.stage === 'merge').flatMap(s => s.after));
  const marker: SettledMarker = { schema: SETTLED_SCHEMA, run_id: run.run_id, week: run.week, no_point, gbrain: run.gbrain, worlds: worlds.map(w => w.world),
    steps: { cells: count('launch') - work.filter(s => split.has(s.id) && progress.has(s.id)).length + count('merge'), rereads: count('reread'), judgments: count('judge'), harness_failures: work.filter(s => progress.get(s.id) === 'harness_failure').length },
    records: recordDigests(dir) };
  writeJson(join(dir, META_FILE), meta);
  writeJson(join(dir, SETTLED_FILE), marker);
  return marker;
}

// ─── Counted block files ─────────────────────────────────────────────

export interface BlockWriter { build: typeof blockAggregates; write: typeof writeBlockFiles }
export const BLOCK_WRITER: BlockWriter = { build: blockAggregates, write: writeBlockFiles };

/** Synthetic values: two worlds where every other row trails gbrain by a different number of questions. */
function probeQuestions(worlds: readonly string[]): WlQuestion[] {
  const qs = plannedFor(worlds);
  for (const q of qs) {
    const i = worlds.indexOf(q.world), k = Number(q.id.split(':')[2]);
    for (const row of WL_ROWS) q.rows[row] = { 'claude-opus-5-5': { pass: k < (row === 'gbrain' ? 6 : 4 - i) ? 1 : 0, failure: null }, 'particle-1': { pass: k < (row === 'gbrain' ? 5 : 3 - i) ? 1 : 0, failure: null } };
  }
  return qs;
}

/**
 * Why the block writer may not write a counted block file: on synthetic values it must null every open comparison's
 * simultaneous interval and wild bootstrap (blocker 2), and refuse to write an open block over an ended one (blocker 3).
 */
export function blockWriterProblems(w: BlockWriter): string[] {
  const worlds = ['bgw-1001', 'bgw-1002'], questions = probeQuestions(worlds);
  const weeks = ['2026-01-06', '2026-01-13', '2026-01-20', '2026-01-27'];
  const gbrain = { release: 'v0.0.0.1', commit: '0'.repeat(40) };
  const comparators = { 'extract-first': { version: '1', fixed: '2026-01-01' }, 'memory-bank': { version: '1', fixed: '2026-01-01' } };
  const metas: WeekMeta[] = weeks.map((week, i) => ({ week, run_id: `wl-${week}-${'0'.repeat(12)}`, gbrain: i ? null : gbrain, comparators: i ? null : comparators,
    worlds: i ? [] : worlds.map(world => ({ world, seed_id: 'W1', phrasing_id: 'W1' })), no_point: i ? 'no worlds' : null }));
  const settled = metas.map((m, i): SettledMarker => ({ schema: SETTLED_SCHEMA, run_id: m.run_id, week: m.week, no_point: m.no_point ?? null, gbrain: m.gbrain, worlds: m.worlds.map(x => x.world),
    steps: i ? { cells: 0, rereads: 0, judgments: 0, harness_failures: 0 } : { cells: 5, rereads: 3, judgments: 8, harness_failures: 0 }, records: [] }));
  const p: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'weekly-line-guard-'));
  try {
    const ended = w.build(1, metas, questions, { settled, draws: 19 });
    const open = w.build(1, metas.slice(0, WL_WEEKS_PER_BLOCK - 1), questions, { settled: settled.slice(0, WL_WEEKS_PER_BLOCK - 1), draws: 19 });
    if (!ended.ended || open.ended) p.push('the block writer does not tell an ended block from an open one');
    const comps = Object.values(open.comparisons).flatMap(c => Object.values(c));
    if (comps.some(c => c.simultaneous !== null || c.wild !== null)) p.push("the block writer publishes an open block's simultaneous interval or wild bootstrap (#611 blocker 2)");
    w.write(dir, ended);
    let replaced = true;
    try { w.write(dir, open); } catch { replaced = false; }
    if (replaced) p.push('the block writer puts an open block over an ended block file (#611 blocker 3)');
  } catch (e) {
    p.push(`the block writer failed its guard probe: ${(e as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return p;
}

/** Write a counted block file from the settled runs of its weeks, only once the block writer passes its guard probe; a week still running refuses, so its records never reach the look. */
export function writeBlock(block: number, runs: readonly string[], out: string, w: BlockWriter = BLOCK_WRITER): string {
  const p = blockWriterProblems(w);
  if (p.length) refuse('WEEKLY_BLOCK_GUARDS', `no counted block file is written until the block writer passes its R113 guards: ${p.join('; ')}`);
  const open = runs.filter(d => !existsSync(join(d, SETTLED_FILE)));
  if (open.length) refuse('WEEKLY_NOT_SETTLED', `a block reads settled weeks only, and ${open[0]} is not settled${open.length > 1 ? ` (and ${open.length - 1} more)` : ''}`);
  const metas = runs.map(d => readJson(join(d, META_FILE)) as WeekMeta);
  const settled = runs.map(d => readJson(join(d, SETTLED_FILE)));
  const pointRuns = runs.filter((_, i) => !metas[i].no_point);
  const records = boundRecords(pointRuns, metas);
  const questions = questionsFromRecords(metas.filter(m => !m.no_point).flatMap(m => m.worlds.map(x => x.world)), records.answers, records.judgments);
  mkdirSync(out, { recursive: true });
  return w.write(out, w.build(block, metas, questions, { settled }));
}

// ─── The command line ────────────────────────────────────────────────

const flags = (argv: readonly string[], name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1] ?? refuse('USAGE', `${name} needs a value`)] : []));
const flag = (argv: readonly string[], name: string) => flags(argv, name).at(-1);
const need = (argv: readonly string[], name: string) => flag(argv, name) ?? refuse('USAGE', `pass ${name}`);
const batchSlot = (id: string) => bgwSlotOf(id) ?? refuse('USAGE', `${id} is not a Set W batch name (bgw- and four digits)`);
const manifestOf = (path: string, first: number) => {
  try { return readBg1Manifest(path, bgwSet(first)).manifest; } catch (e) { return refuse('WEEKLY_WORLDS', (e as Error).message); }
};

export function main(argv: readonly string[], deps: RunnerDeps = DEFAULT_DEPS, log: (s: string) => void = s => console.log(s)): number {
  const [mode, ...rest] = argv;
  if (mode === 'plan') {
    const first = batchSlot(need(rest, '--batch'));
    const manifestPath = flag(rest, '--manifest');
    if (!manifestPath === !rest.includes('--mint-failed')) refuse('USAGE', 'pass exactly one of --manifest <filled batch manifest> and --mint-failed');
    const sparesName = flag(rest, '--spares');
    const spares = sparesName ? { first: batchSlot(sparesName), manifest: manifestOf(need(rest, '--spare-manifest'), batchSlot(sparesName)) } : undefined;
    const noPoint = flag(rest, '--no-point') as PlanInput['noPoint'] | undefined;
    if (noPoint !== undefined && noPoint !== 'custody host offline') refuse('USAGE', `plan takes --no-point "custody host offline" only; a week without worlds records "no worlds" by itself, and a gbrain row that fails settles with --no-point "gbrain release failed to run"`);
    const r = planWeek({ dir: need(rest, '--out'), launch: need(rest, '--launch'), batch: { first, week1: need(rest, '--batch-week1'), manifest: manifestPath ? manifestOf(manifestPath, first) : null }, spares, noPoint }, deps);
    log(`${r.frozen ? 'kept the frozen' : 'planned'} run ${r.run.run_id}: week ${r.run.week}, world end ${r.run.world_end}, ${r.run.no_point ? `no point (${r.run.no_point})` : `gbrain ${r.run.gbrain!.release} (${r.run.gbrain!.commit.slice(0, 12)}), ${r.run.worlds.length} worlds${r.run.spares_from ? ` (spares of ${r.run.spares_from})` : ''}`}`);
    r.steps.forEach((s, i) => log(`${String(i + 1).padStart(3)}. ${s.id}${s.judge ? ` (judge ${s.judge})` : ''}`));
    return 0;
  }
  if (mode === 'launch') {
    const cap = flag(rest, '--window-cap-usd');
    const order = launchWeek(need(rest, '--run'), flag(rest, '--window-granted'), deps, cap === undefined ? undefined : Number(cap));
    log(`run ${order.run_id} under window ${order.window}: hand these units to the launch path in this order, each with ${Object.entries(order.env).map(([k, v]) => `${k}=${v}`).join(' ')}${order.campaign ? `; the cells' campaign manifest is ${join(need(rest, '--run'), order.campaign)}` : ''}`);
    for (const s of order.stages) log(`${s.stage}: ${s.units.join(' ')}`);
    return 0;
  }
  if (mode === 'mark') {
    const done = rest.includes('--done'), failed = rest.includes('--harness-failure');
    if (done === failed) refuse('USAGE', 'pass exactly one of --done and --harness-failure');
    markStep(need(rest, '--run'), need(rest, '--step'), done ? 'done' : 'harness_failure');
    return 0;
  }
  if (mode === 'settle') {
    const noPoint = flag(rest, '--no-point');
    if (noPoint !== undefined && noPoint !== 'gbrain release failed to run') refuse('USAGE', 'settle takes --no-point "gbrain release failed to run" only');
    const costsPath = flag(rest, '--costs');
    const m = settleWeek(need(rest, '--run'), { costs: costsPath ? readJson(costsPath) : undefined, gbrainFailed: noPoint !== undefined });
    log(`settled week ${m.week} (run ${m.run_id})${m.no_point ? `, no point: ${m.no_point}` : ''}`);
    return 0;
  }
  if (mode === 'block') {
    const runs = flags(rest, '--run');
    if (!runs.length) refuse('USAGE', 'pass --run <run dir> for each week of the block');
    log(`wrote ${writeBlock(Number(need(rest, '--block')), runs, need(rest, '--out'))}`);
    return 0;
  }
  return refuse('USAGE', 'the mode is plan, launch, mark, settle or block');
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error((e as Error).message); process.exit(2); }
}
