/**
 * The weekly held-out line's runner (eval/runner/weekly-line/runner.ts; preregistration
 * docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md, "Harness" item 4 and "Dates") on synthetic
 * manifests, an injected cell set and an injected tag list: the week and world-end clock, the week's Set W worlds and
 * spares, gbrain's newest tag and its freeze, the launch order, the window refusal, the settled marker, the run
 * identity the aggregates score, and the refusal to write a counted block file without #611's fixes 2 and 3.
 * Keyless and offline: no test resolves a real tag or reaches a provider, and fetch throws for the whole file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bgwBatchDataset } from '../../eval/runner/memory-qa/bg1-names.ts';
import type { Bg1Manifest } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { answerId, answerProblems, RecordLog, WEEKLY_RUN_ENV, type AnswerRecord, type JudgmentRecord } from '../../eval/runner/memory-qa/records.ts';
import { frontierInstrumentId, weeklyRunStamp } from '../../eval/runner/q1/cell.ts';
import { bg1JudgeOf, PER_READER_JUDGE_SETTINGS } from '../../eval/runner/q1/cells/definitions.ts';
import { main as aggregatesMain, writeBlockFiles } from '../../eval/runner/weekly-line/aggregates.ts';
import { plannedQuestions, WL_READERS, WL_ROWS, WL_SYSTEMS, type WlRow } from '../../eval/runner/weekly-line/design.ts';
import { RUN_FILE, runBindingProblems, runIdOf } from '../../eval/runner/weekly-line/identity.ts';
import {
  BLOCK_WRITER, blockWriterProblems, cellPlanProblems, DEFAULT_DEPS, launchWeek, main, markStep, newestGbrainRelease, planWeek, progressOf, settleWeek, weekClock, weekSteps, weekWorlds,
  WIRED_CELL_SET, weeklyLaunchCheck, writeBlock, WeeklyRunnerError, type LaunchCheck, type RunnerDeps, type WeeklyCellPlan, type WeeklyCellSet,
} from '../../eval/runner/weekly-line/runner.ts';
import { generateWeeklyLineCells, WEEKLY_LINE_COMPARATORS, WEEKLY_LINE_MODELS } from '../../eval/runner/q1/cells/weekly-line.ts';
import { settledProblems } from '../../eval/runner/weekly-line/settled.ts';

const tmp = mkdtempSync(join(tmpdir(), 'weekly-line-runner-'));
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error('the weekly runner tests are offline'); }) as unknown as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; rmSync(tmp, { recursive: true, force: true }); });

const [OPUS, PARTICLE] = WL_READERS;
const at = (iso: string) => () => new Date(`${iso}T12:00:00Z`);
const ids = (n: number, from = 1001) => Array.from({ length: n }, (_, i) => `bgw-${from + i}`);
const manifestOf = (kept: string[], n_final?: number): Bg1Manifest => ({ dataset: bgwBatchDataset(1001), status: 'filled', layout: 'test', note: 'test', filled_at: '2026-11-30', kept,
  files: kept.flatMap(id => ['world.json', 'questions.json'].map(f => ({ path: `worlds/${id}/${f}`, sha256: 'a'.repeat(64) }))), ...(n_final === undefined ? {} : { n_final }) });
const FULL = manifestOf(ids(34), 34);
const C1 = '1'.repeat(40), C2 = '2'.repeat(40), C3 = '3'.repeat(40);
const TAGS = [`${C1}\trefs/tags/v0.61.9.0`, `${'4'.repeat(40)}\trefs/tags/v0.61.10.0`, `${C2}\trefs/tags/v0.61.10.0^{}`, `${C3}\trefs/tags/stable`, `${C3}\trefs/tags/latest-stable`, `${C3}\trefs/tags/v0.62.0.0-rc1`].join('\n');
const message = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } return ''; };

const cellSet: WeeklyCellSet = ({ worlds }) => ({
  cells: [
    { id: 'g8-opus', row: 'gbrain', reader: OPUS, worlds: [...worlds] },
    { id: 'fs-p1', row: 'grep-agent', reader: PARTICLE, worlds: [...worlds] },
    { id: 'fs-opus', row: 'grep-agent', reader: OPUS, worlds: [...worlds] },
    { id: 'mb-opus', row: 'memory-bank', reader: OPUS, worlds: [...worlds] },
    { id: 'ef-opus', row: 'extract-first', reader: OPUS, worlds: [...worlds] },
  ],
  rereads: [
    { id: 'mb-p1', row: 'memory-bank', from: 'mb-opus', reader: PARTICLE },
    { id: 'g8-p1', row: 'gbrain', from: 'g8-opus', reader: PARTICLE },
    { id: 'ef-p1', row: 'extract-first', from: 'ef-opus', reader: PARTICLE },
  ],
  comparators: { 'extract-first': { version: '1.4.2', fixed: '2026-11-19' }, 'memory-bank': { version: '0.9.0', fixed: '2026-11-19' } },
});
const deps = (now: string, tags = TAGS, cells: WeeklyCellSet | null = cellSet, launchCheck: LaunchCheck = () => {}): RunnerDeps => ({ now: at(now), lsRemote: () => tags, cellSet: cells, launchCheck });
const batch = (manifest: Bg1Manifest | null = FULL, first = 1001) => ({ first, week1: '2026-12-08', manifest });
/** Metered spend for every row, reader and world of a week. */
const costsFor = (worlds: readonly string[]) => WL_ROWS.flatMap(row => (['claude-opus-5-5', 'particle-1'] as const).flatMap(reader => worlds.map(world => ({ row, reader, world, usd: 0.25 }))));

// ─── Week and clock ──────────────────────────────────────────────────

describe('the week and its clock', () => {
  // Value: protects=a week is named by its Tuesday launch, its world end is the Sunday before, and the runner refuses once its clock passes that world end by 14 days or before it has passed; fails_when=a non-Tuesday gets a week, the world end is another day, or a plan or launch runs 15 days late; why_new=weekly-line preregistration "Dates"; seam=runner.ts weekClock over corpus.ts bgwWeekWorldEnd and bg1RunClock; no_claim=the cells' own clock check on the VM
  test('the world end is the Sunday before the Tuesday launch, and the clock refuses past 14 days', () => {
    expect(weekClock('2026-12-08', at('2026-12-08')())).toEqual({ week: '2026-12-08', world_end: '2026-12-06' });
    expect(weekClock('2026-12-29', at('2027-01-10')()).world_end).toBe('2026-12-27');
    expect(weekClock('2026-12-08', at('2026-12-20')()).world_end).toBe('2026-12-06');
    expect(message(() => weekClock('2026-12-08', at('2026-12-21')()))).toMatch(/^WEEKLY_CLOCK: .*more than 14 days past the world end 2026-12-06/);
    expect(message(() => weekClock('2026-12-08', at('2026-12-06')()))).toMatch(/^WEEKLY_CLOCK: .*is not after the world end/);
    expect(message(() => weekClock('2026-12-09', at('2026-12-09')()))).toMatch(/^WEEKLY_CLOCK: .*a Wednesday, not a Tuesday/);
  });
});

// ─── Worlds ──────────────────────────────────────────────────────────

describe("the week's Set W worlds", () => {
  // Value: protects=a week reads its 8 Set W worlds in slot order from its month's batch, a mint still running refuses, and the previous batch's two spares fill the first week a final batch cannot reach; fails_when=a week reads another week's or a spare's worlds, runs before its batch is final, or the spares fill more than one week or come from a batch other than the one just before; why_new=weekly-line preregistration "Minting" and "When custody is down"; seam=runner.ts weekWorlds over corpus.ts bgwWeekWorlds and bg1Kept; no_claim=the mint's own drop rules
  test('week k of a batch reads kept worlds 8(k-1)+1 to 8k with their seed and phrasing ids', () => {
    const all = ids(34);
    for (const k of [1, 2, 3, 4]) {
      const w = weekWorlds(`2026-12-${String(8 + 7 * (k - 1)).padStart(2, '0')}`, batch());
      expect(w).toMatchObject({ batch: 'bgw-1001', week_of_batch: k, spares_from: null });
      expect(w.worlds.map(x => x.world)).toEqual(all.slice(8 * (k - 1), 8 * k));
    }
    expect(weekWorlds('2026-12-08', batch()).worlds[0]).toEqual({ world: 'bgw-1001', seed_id: 'W1', phrasing_id: 'W1' });
    expect(message(() => weekWorlds('2027-01-05', batch()))).toMatch(/^WEEKLY_NOT_IN_BATCH: week 2027-01-05 is not one of the 4 weeks of batch bgw-1001/);
    expect(message(() => weekWorlds('2026-12-01', batch()))).toMatch(/^WEEKLY_NOT_IN_BATCH/);
    expect(message(() => weekWorlds('2026-12-08', { ...batch(), week1: '2026-12-09' }))).toMatch(/not a Tuesday/);
  });

  test('a running mint refuses, a short final batch runs a partial week and then none, and the spares fill one week', () => {
    expect(message(() => weekWorlds('2026-12-22', batch(manifestOf(ids(20)))))).toMatch(/^WEEKLY_MINT_UNFINISHED: batch bgw-1001 keeps 20 worlds and is not final/);
    const short = batch(manifestOf(ids(20), 20));
    expect(weekWorlds('2026-12-22', short).worlds.map(x => x.world)).toEqual(ids(4, 1017));
    expect(weekWorlds('2026-12-29', short).worlds).toEqual([]);
    const failed = { first: 1035, week1: '2027-01-05', manifest: null };
    const spares = { first: 1001, manifest: FULL };
    const w1 = weekWorlds('2027-01-05', failed, spares);
    expect(w1).toMatchObject({ batch: 'bgw-1035', week_of_batch: 1, spares_from: 'bgw-1001' });
    expect(w1.worlds.map(x => x.world)).toEqual(['bgw-1033', 'bgw-1034']);
    expect(weekWorlds('2027-01-12', failed, spares).worlds).toEqual([]);
    expect(weekWorlds('2027-01-05', failed).worlds).toEqual([]);
    expect(message(() => weekWorlds('2027-01-05', { ...failed, first: 1057 }, { first: 1001, manifest: manifestOf(ids(32), 32) }))).toMatch(/has no final spares/);
    expect(message(() => weekWorlds('2026-12-08', batch(null), { first: 1001, manifest: FULL }))).toMatch(/spares come from the batch just before bgw-1001, and bgw-1001 ended at slot 1034, so the batch after it is bgw-1035/);
    expect(message(() => weekWorlds('2027-01-05', { first: 1057, week1: '2027-01-05', manifest: null }, spares))).toMatch(/^WEEKLY_WORLDS: spares come from the batch just before bgw-1057, and bgw-1001 ended at slot 1034, so the batch after it is bgw-1035/);
    expect(message(() => weekWorlds('2027-01-05', failed, { first: 1001, manifest: manifestOf([...ids(33), 'bgw-1040'], 34) }))).toMatch(/^WEEKLY_WORLDS: .* ended at slot 1040, so the batch after it is bgw-1041/);
  });
});

// ─── gbrain ──────────────────────────────────────────────────────────

describe("gbrain's newest release", () => {
  // Value: protects=the week measures the highest version tag, recorded with its commit (an annotated tag's peeled commit), and freezes it for the week; fails_when=a stable or rc tag wins, versions sort as text, the tag object's sha is recorded, or a second plan of the same run resolves a newer release; why_new=weekly-line preregistration "Systems" (newest release at launch, frozen for that week and recorded with its commit) and R100; seam=runner.ts newestGbrainRelease and planWeek; no_claim=reachability from master, which ls-remote cannot show
  test('the highest release tag with its peeled commit, ignoring stable and pre-release tags', () => {
    expect(newestGbrainRelease(TAGS)).toEqual({ release: 'v0.61.10.0', commit: C2 });
    expect(newestGbrainRelease(`${C1}\trefs/tags/v0.61.9.0`)).toEqual({ release: 'v0.61.9.0', commit: C1 });
    expect(message(() => newestGbrainRelease(`${C3}\trefs/tags/stable`))).toMatch(/^WEEKLY_GBRAIN: gbrain has no release tag/);
  });

  test('a planned run keeps its frozen build when planned again after a newer release', () => {
    const dir = join(tmp, 'frozen');
    const first = planWeek({ dir, launch: '2026-12-08', batch: batch() }, deps('2026-12-08'));
    expect([first.frozen, first.run.gbrain]).toEqual([false, { release: 'v0.61.10.0', commit: C2 }]);
    const newer = `${TAGS}\n${C3}\trefs/tags/v0.61.11.0`;
    const again = planWeek({ dir, launch: '2026-12-08', batch: batch() }, deps('2026-12-09', newer));
    expect([again.frozen, again.run.gbrain!.release, again.run.run_id]).toEqual([true, 'v0.61.10.0', first.run.run_id]);
    expect(message(() => planWeek({ dir, launch: '2026-12-15', batch: batch() }, deps('2026-12-15', newer)))).toMatch(/holds week 2026-12-08's run, not week 2026-12-15's/);
    expect(planWeek({ dir: join(tmp, 'fresh'), launch: '2026-12-08', batch: batch() }, deps('2026-12-08', newer)).run.gbrain!.release).toBe('v0.61.11.0');
  });
});

// ─── Order and the cell set ──────────────────────────────────────────

describe('the launch order and the cell set', () => {
  const plan = cellSet({ week: { launch: '2026-12-08', world_end: '2026-12-06', batch: 'bgw-1001' }, worlds: ids(8), gbrain: { release: 'v0.61.10.0', commit: C2 } });

  // Value: protects=the extract-first server launches first, then gbrain, the memory-bank server and the grep agent; particle-1's re-reads come after every cell, judging after every answer with the reader's preregistered judge, and the aggregates last; fails_when=the order changes, a re-read runs before its cell, or an answer is judged by its own family or particle-1; why_new=the plan's "Where it runs" order and harness PR (d)'s brief; seam=runner.ts weekSteps; no_claim=the launch path's own unit scheduling
  test('extract-first first, then gbrain, memory-bank and the grep agent; then re-reads, judging and the aggregates', () => {
    const steps = weekSteps(plan);
    expect(steps.map(s => s.id)).toEqual([
      'launch:ef-opus', 'launch:g8-opus', 'launch:mb-opus', 'launch:fs-opus', 'launch:fs-p1',
      'reread:ef-p1', 'reread:g8-p1', 'reread:mb-p1',
      'judge:ef-opus', 'judge:g8-opus', 'judge:mb-opus', 'judge:fs-opus', 'judge:fs-p1', 'judge:ef-p1', 'judge:g8-p1', 'judge:mb-p1',
      'aggregates:week',
    ]);
    const judge = Object.fromEntries(steps.filter(s => s.stage === 'judge').map(s => [s.target, s.judge]));
    expect(judge['fs-opus']).toBe('openai:gpt-6-astra');
    expect(judge['fs-p1']).toBe('anthropic:claude-opus-5-5');
    expect(judge['g8-p1']).toBe('anthropic:claude-opus-5-5');
    expect(steps.find(s => s.id === 'reread:g8-p1')!.after).toEqual(['launch:g8-opus']);
    expect(steps.at(-1)!.after).toHaveLength(8);
  });

  test("a cell set that is not the preregistered week refuses", () => {
    expect(cellPlanProblems(plan, ids(8))).toEqual([]);
    const bad = (f: (p: WeeklyCellPlan) => void) => { const p = structuredClone(plan); f(p); return cellPlanProblems(p, ids(8)).join('; '); };
    expect(bad(p => { p.cells = p.cells.filter(c => c.id !== 'fs-p1'); })).toContain('row grep-agent needs one cell read by particle:particle-1, and has 0');
    expect(bad(p => { p.cells.push({ id: 'g8-p1x', row: 'gbrain', reader: PARTICLE, worlds: ids(8) }); })).toContain('reads particle-1 as a re-read of the frozen contexts');
    expect(bad(p => { p.rereads[0].from = 'g8-opus'; })).toContain("does not re-read claude-opus-5-5's cell in its row");
    expect(bad(p => { p.rereads.push({ id: 'fs-p1-reread', row: 'grep-agent', from: 'fs-opus', reader: PARTICLE }); })).toContain('the grep agent has no re-read');
    expect(bad(p => { p.cells[0].worlds = ids(8).reverse(); })).toContain("does not run exactly the week's worlds in slot order");
    expect(bad(p => { p.cells[0].reader = 'openai:gpt-6.2-sol'; })).toContain('a reader outside the line');
    expect(bad(p => { p.rereads[0].id = 'g8-opus'; })).toContain('appears twice');
    expect(bad(p => { delete (p.comparators as Record<string, unknown>)['memory-bank']; })).toContain('no version and fixed date for the memory-bank server');
    expect(message(() => planWeek({ dir: join(tmp, 'bad-plan'), launch: '2026-12-08', batch: batch() }, deps('2026-12-08', TAGS, args => ({ ...cellSet(args), rereads: [] }))))).toMatch(/^WEEKLY_CELL_PLAN: /);
  });

  // Value: protects=until harness PR (c) wires its cell set, no week with a point can be planned; fails_when=a point week plans without a cell set; why_new=harness PR (d)'s brief (one wiring point, injected in tests); seam=runner.ts planWeek; no_claim=PR (c)'s cell definitions
  test('without a wired cell set a week with a point refuses, and a week without worlds still records no point', () => {
    expect(message(() => planWeek({ dir: join(tmp, 'unwired'), launch: '2026-12-08', batch: batch() }, deps('2026-12-08', TAGS, null)))).toMatch(/^WEEKLY_CELLS_NOT_WIRED: /);
    expect(existsSync(join(tmp, 'unwired', RUN_FILE))).toBe(false);
    const none = planWeek({ dir: join(tmp, 'none'), launch: '2026-12-29', batch: batch(manifestOf(ids(20), 20)) }, deps('2026-12-29', TAGS, null));
    expect([none.run.no_point, none.run.gbrain, none.steps]).toEqual(['no worlds', null, []]);
    const offline = planWeek({ dir: join(tmp, 'offline'), launch: '2026-12-08', batch: batch(), noPoint: 'custody host offline' }, deps('2026-12-08', TAGS, null));
    expect(offline.run.no_point).toBe('custody host offline');
  });
});

// ─── The wired cell set ──────────────────────────────────────────────

describe('the wired cell set', () => {
  const G8 = 'bgw.gbrain-defaults.rs1-stable', FS = 'bgw.baseline-file-agent.baseline', EF = 'bgw.ext-extract-first.common', MB = 'bgw.ext-memory-bank.recipe';
  const RR = (cell: string) => `${cell}.reread-particle-particle-1`;
  const ok = weeklyLaunchCheck({ ripgrep: () => 'ripgrep 14.1.1', registry: WEEKLY_LINE_MODELS });

  // Value: protects=a week with a point is planned from harness PR (c)'s cell set at the week, its worlds and the frozen gbrain build, and launch hands the launch path the week's cell definitions only after the launch check passes on them; fails_when=the runner plans from no cell set, from cells of another build or week, or launches cells the launch check refuses or that are not the run's; why_new=the wiring PR's brief, part A (replace the wiring point with generateWeeklyLineCells, weeklyLineRereadPlans and requireWeeklyLineLaunch); seam=runner.ts WIRED_CELL_SET, planWeek, weeklyLaunchCheck and launchWeek; no_claim=the launch path's own window and lease checks, and running any cell
  test('plans the week from generateWeeklyLineCells and launches only through the launch check', () => {
    expect(DEFAULT_DEPS.cellSet).toBe(WIRED_CELL_SET);
    const dir = join(tmp, 'wired');
    const { run, steps } = planWeek({ dir, launch: '2026-12-08', batch: batch() }, deps('2026-12-08', TAGS, WIRED_CELL_SET, ok));
    const defs = JSON.parse(readFileSync(join(dir, 'cells.json'), 'utf8'));
    const want = generateWeeklyLineCells({ week: { launch: '2026-12-08', world_end: '2026-12-06', batch: 'bgw-1001' }, worlds: ids(8), gbrain: { release: 'v0.61.10.0', commit: C2 } });
    expect(defs).toEqual(JSON.parse(JSON.stringify({ run_id: run.run_id, cells: want, rereads: defs.rereads })));
    expect(defs.rereads.map((r: { id: string }) => r.id)).toEqual([RR(`${G8}.p`), RR(`${EF}.component-b8000`), RR(`${MB}.component-b8000`)]);
    expect([run.gbrain, run.comparators]).toEqual([{ release: 'v0.61.10.0', commit: C2 }, WEEKLY_LINE_COMPARATORS]);
    expect(run.cells).toEqual([`${G8}.p`, `${FS}.whole-agent`, `${EF}.component-b8000`, `${MB}.component-b8000`]);
    expect(steps.filter(s => s.stage === 'launch').map(s => [s.target, s.unit, s.reader])).toEqual([
      [`${EF}.component-b8000`, EF, OPUS], [`${G8}.p`, G8, OPUS], [`${MB}.component-b8000`, MB, OPUS],
      [`${FS}.whole-agent.anthropic-claude-opus-5-5`, FS, OPUS], [`${FS}.whole-agent.particle-particle-1`, FS, PARTICLE],
    ]);
    expect(steps.find(s => s.id === `reread:${RR(`${G8}.p`)}`)!.after).toEqual([`launch:${G8}.p`]);
    const order = launchWeek(dir, 'weekly-line-2026-12-08', deps('2026-12-08', TAGS, WIRED_CELL_SET, ok));
    expect(order.stages.slice(0, 2).map(s => s.units)).toEqual([[EF, G8, MB, FS], [RR(`${EF}.component-b8000`), RR(`${G8}.p`), RR(`${MB}.component-b8000`)]]);
    rmSync(join(dir, 'launch.json'));
    const noRg = weeklyLaunchCheck({ ripgrep: () => null, registry: WEEKLY_LINE_MODELS });
    expect(message(() => launchWeek(dir, 'w', deps('2026-12-08', TAGS, WIRED_CELL_SET, noRg)))).toMatch(/refused before any cell starts: .*ripgrep/);
    const cells = JSON.parse(readFileSync(join(dir, 'cells.json'), 'utf8'));
    writeFileSync(join(dir, 'cells.json'), JSON.stringify({ ...cells, cells: cells.cells.slice(1) }));
    expect(message(() => launchWeek(dir, 'w', deps('2026-12-08', TAGS, WIRED_CELL_SET, ok)))).toMatch(/^WEEKLY_LAUNCH_CHECK: .*does not hold run/);
    rmSync(join(dir, 'cells.json'));
    expect(message(() => launchWeek(dir, 'w', deps('2026-12-08', TAGS, WIRED_CELL_SET, ok)))).toMatch(/^WEEKLY_LAUNCH_CHECK: .*has no cells\.json/);
    expect(existsSync(join(dir, 'launch.json'))).toBe(false);
  });
});

// ─── Launch, progress and the settled marker ─────────────────────────

describe('launch, progress and the settled marker', () => {
  // Value: protects=launch hands the launch path its unit order only under a granted paid window and inside the clock, and starts nothing itself; fails_when=launch writes an order with no window, after the clock, or for a week with no point; why_new=harness PR (d)'s brief (the paid launch refuses without a granted window); seam=runner.ts launchWeek; no_claim=the launch path's own window and lease checks (bg1/launch.ts)
  test('launch refuses without a granted window and writes the unit order in launch order', () => {
    const dir = join(tmp, 'launch');
    planWeek({ dir, launch: '2026-12-08', batch: batch() }, deps('2026-12-08'));
    expect(message(() => launchWeek(dir, undefined, deps('2026-12-08')))).toMatch(/^WEEKLY_NO_WINDOW: /);
    expect(existsSync(join(dir, 'launch.json'))).toBe(false);
    expect(message(() => launchWeek(dir, 'weekly-line-2026-12-08', deps('2026-12-21')))).toMatch(/^WEEKLY_CLOCK: /);
    const order = launchWeek(dir, 'weekly-line-2026-12-08', deps('2026-12-08'));
    expect(order.stages.map(s => [s.stage, s.units])).toEqual([
      ['launch', ['ef-opus', 'g8-opus', 'mb-opus', 'fs-opus', 'fs-p1']], ['reread', ['ef-p1', 'g8-p1', 'mb-p1']],
      ['judge', ['ef-opus', 'g8-opus', 'mb-opus', 'fs-opus', 'fs-p1', 'ef-p1', 'g8-p1', 'mb-p1']],
    ]);
    expect(JSON.parse(readFileSync(join(dir, 'launch.json'), 'utf8')).window).toBe('weekly-line-2026-12-08');
    const none = join(tmp, 'launch-none');
    planWeek({ dir: none, launch: '2026-12-29', batch: batch(manifestOf(ids(20), 20)) }, deps('2026-12-29'));
    expect(message(() => launchWeek(none, 'w', deps('2026-12-29')))).toMatch(/^WEEKLY_NO_POINT: /);
  });

  // Value: protects=the settled marker is written only when every cell, re-read and judgment of the week is done or a harness failure, in order, and agrees with the week's meta; fails_when=settle writes a marker with a step pending or a point week's spend incomplete, a step is marked before what it waits on, a done step is re-marked, or anything changes after settling; why_new=harness PR (d)'s brief item 5, which #611 blocker 1's fix reads; seam=runner.ts markStep and settleWeek over settled.ts; no_claim=the cells' own completion records
  test('settle waits for every cell, re-read and judgment, in order, and its marker settles the meta', () => {
    const dir = join(tmp, 'settle');
    const { steps } = planWeek({ dir, launch: '2026-12-08', batch: batch() }, deps('2026-12-08'));
    expect(message(() => settleWeek(dir))).toMatch(/^WEEKLY_NOT_SETTLED: 16 of week 2026-12-08's 16 cells, re-reads and judgments/);
    expect(message(() => markStep(dir, 'reread:g8-p1', 'done'))).toMatch(/waits on launch:g8-opus/);
    expect(message(() => markStep(dir, 'judge:g8-opus', 'done'))).toMatch(/waits on launch:g8-opus/);
    expect(message(() => markStep(dir, 'aggregates:week', 'done'))).toMatch(/run after settle/);
    expect(message(() => markStep(dir, 'launch:nope', 'done'))).toMatch(/not a step of this run/);
    markStep(dir, 'launch:g8-opus', 'harness_failure');
    markStep(dir, 'launch:g8-opus', 'done');
    expect(message(() => markStep(dir, 'launch:g8-opus', 'done'))).toMatch(/already done/);
    const work = steps.filter(s => s.stage !== 'aggregates' && s.id !== 'launch:g8-opus');
    for (const s of work.slice(0, -1)) markStep(dir, s.id, s.id === 'judge:fs-p1' ? 'harness_failure' : 'done');
    expect(message(() => settleWeek(dir))).toMatch(/1 of week 2026-12-08's 16 .*first judge:mb-p1/);
    markStep(dir, work.at(-1)!.id, 'done');
    expect(progressOf(dir).get('judge:fs-p1')).toBe('harness_failure');
    expect(message(() => settleWeek(dir))).toMatch(/^WEEKLY_COSTS: week 2026-12-08 has a point, so settling it needs its metered spend/);
    expect(message(() => settleWeek(dir, { costs: costsFor(ids(8)).slice(1) }))).toMatch(/^WEEKLY_COSTS: .*lacks 1 row, reader and world cell .*first gbrain\|claude-opus-5-5\|bgw-1001/);
    expect(message(() => settleWeek(dir, { costs: costsFor(ids(8)).map((c, i) => (i ? c : { ...c, usd: -1 })) }))).toMatch(/^WEEKLY_COSTS: /);
    expect(existsSync(join(dir, 'settled.json'))).toBe(false);
    const marker = settleWeek(dir, { costs: costsFor(ids(8)) });
    expect(marker.steps).toEqual({ cells: 5, rereads: 3, judgments: 8, harness_failures: 1 });
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    expect(settledProblems(marker, meta)).toEqual([]);
    expect(meta.costs).toHaveLength(64);
    expect(message(() => settleWeek(dir))).toMatch(/^WEEKLY_SETTLED: /);
    expect(message(() => markStep(dir, 'judge:mb-p1', 'done'))).toMatch(/^WEEKLY_SETTLED: /);
  });

  // Value: protects=settle validates the whole spend list before it writes anything: no row, reader and world twice, none outside the week, every value a finite number of at least 0; fails_when=settle writes a meta whose cost list holds a duplicate, an out-of-week cell or a non-finite or negative value beside a complete set of valid entries; why_new=GBEV-3 ruling on #616, finding 4 (runner.ts:315); seam=runner.ts settleWeek; no_claim=the metered spend's own correctness
  test('settle refuses a spend list with a duplicate, an out-of-week cell or a bad value, and writes nothing', () => {
    const dir = join(tmp, 'settle-costs');
    const { steps } = planWeek({ dir, launch: '2026-12-08', batch: batch() }, deps('2026-12-08'));
    for (const s of steps) if (s.stage !== 'aggregates') markStep(dir, s.id, 'done');
    const full = costsFor(ids(8));
    const refused = (costs: unknown[]) => { const m = message(() => settleWeek(dir, { costs: costs as typeof full })); expect(existsSync(join(dir, 'settled.json'))).toBe(false); expect(existsSync(join(dir, 'meta.json'))).toBe(false); return m; };
    expect(refused([...full, full[0]])).toMatch(/^WEEKLY_COSTS: .*bad entry.*gbrain\|claude-opus-5-5\|bgw-1001 is listed twice/);
    expect(refused([...full, { ...full[0], world: 'bgw-1999' }])).toMatch(/^WEEKLY_COSTS: .*gbrain\|claude-opus-5-5\|bgw-1999 is not a row, reader and world of the week/);
    expect(refused([...full, { ...full[0], row: 'hybrid' }])).toMatch(/^WEEKLY_COSTS: .*hybrid\|claude-opus-5-5\|bgw-1001 is not a row/);
    expect(refused([...full, { ...full[0], usd: Number.NaN }])).toMatch(/^WEEKLY_COSTS: .*bad entries/);
    expect(refused(full.map((c, i) => (i === 3 ? { ...c, usd: Number.POSITIVE_INFINITY } : c)))).toMatch(/^WEEKLY_COSTS: .*is not a finite number of at least 0/);
    expect(refused(full.map((c, i) => (i === 3 ? { ...c, usd: -0.5 } : c)))).toMatch(/^WEEKLY_COSTS: .*is not a finite number of at least 0/);
    settleWeek(dir, { costs: full });
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).costs).toEqual(full);
  });

  test('a week with no point settles at once, and a gbrain row that failed settles as no point with its build', () => {
    const none = join(tmp, 'settle-none');
    planWeek({ dir: none, launch: '2026-12-29', batch: batch(manifestOf(ids(20), 20)) }, deps('2026-12-29'));
    expect(settleWeek(none)).toMatchObject({ no_point: 'no worlds', worlds: [], steps: { cells: 0, rereads: 0, judgments: 0, harness_failures: 0 } });
    const failed = join(tmp, 'settle-failed');
    planWeek({ dir: failed, launch: '2026-12-08', batch: batch() }, deps('2026-12-08'));
    const m = settleWeek(failed, { gbrainFailed: true });
    expect([m.no_point, m.gbrain!.release, m.worlds]).toEqual(['gbrain release failed to run', 'v0.61.10.0', []]);
    expect(message(() => settleWeek(none, { gbrainFailed: true }))).toMatch(/^WEEKLY_SETTLED: /);
  });

  test('the command line plans, refuses to launch without a window, marks and settles', () => {
    const dir = join(tmp, 'cli');
    const manifest = join(tmp, 'bgw-1001-manifest.json');
    writeFileSync(manifest, JSON.stringify(FULL));
    const lines: string[] = [];
    const d = deps('2026-12-08');
    expect(main(['plan', '--launch', '2026-12-08', '--out', dir, '--batch', 'bgw-1001', '--batch-week1', '2026-12-08', '--manifest', manifest], d, s => lines.push(s))).toBe(0);
    expect(lines[0]).toMatch(/^planned run wl-2026-12-08-[0-9a-f]{12}: week 2026-12-08, world end 2026-12-06, gbrain v0\.61\.10\.0 \(222222222222\), 8 worlds$/);
    expect(lines[1]).toBe('  1. launch:ef-opus');
    expect(lines.at(-1)).toBe(' 17. aggregates:week');
    expect(() => main(['launch', '--run', dir], d)).toThrow(/^WEEKLY_NO_WINDOW/);
    expect(() => main(['plan', '--launch', '2026-12-08', '--out', dir, '--batch', 'bgw-1001', '--batch-week1', '2026-12-08'], d)).toThrow(/exactly one of --manifest/);
    expect(() => main(['plan', '--launch', '2026-12-08', '--out', dir, '--batch', 'bgw-1001', '--batch-week1', '2026-12-08', '--manifest', manifest, '--no-point', 'no worlds'], d)).toThrow(/custody host offline" only/);
    expect(() => main(['mark', '--run', dir, '--step', 'launch:ef-opus'], d)).toThrow(/exactly one of --done and --harness-failure/);
    expect(main(['mark', '--run', dir, '--step', 'launch:ef-opus', '--done'], d)).toBe(0);
    expect(() => main(['settle', '--run', dir], d)).toThrow(/^WEEKLY_NOT_SETTLED/);
    expect(() => main(['go'], d)).toThrow(/plan, launch, mark, settle or block/);
    expect(() => main(['plan', '--launch', '2026-12-08', '--out', join(tmp, 'cli-old'), '--batch', 'bgw-1001', '--batch-week1', '2026-12-08', '--manifest', manifest], deps('2026-12-22'))).toThrow(/^WEEKLY_CLOCK/);
  });
});

// ─── Records, the aggregates and the block ───────────────────────────

const INSTRUMENT = instrumentFor('bg1');
const SYSTEM_OF = Object.fromEntries(Object.entries(WL_SYSTEMS).map(([s, r]) => [r, s])) as Record<WlRow, string>;
const CELL_OF: Record<WlRow, Record<string, string>> = {
  gbrain: { [OPUS]: 'g8-opus', [PARTICLE]: 'g8-p1' }, 'grep-agent': { [OPUS]: 'fs-opus', [PARTICLE]: 'fs-p1' },
  'extract-first': { [OPUS]: 'ef-opus', [PARTICLE]: 'ef-p1' }, 'memory-bank': { [OPUS]: 'mb-opus', [PARTICLE]: 'mb-p1' },
};

/** Synthetic cell records in the run directory, stamped with its run (or `stamp`): gbrain passes the first 5 questions of each kind, every other row the first 4. */
function writeRecords(dir: string, worlds: readonly string[], stamp?: { run_id: string; week: string }): void {
  const run = JSON.parse(readFileSync(join(dir, RUN_FILE), 'utf8'));
  const weekly_run = stamp ?? { run_id: run.run_id, week: run.week };
  const by = new Map<string, { answers: AnswerRecord[]; judgments: JudgmentRecord[] }>();
  for (const world of worlds) for (const q of plannedQuestions(world)) for (const row of WL_ROWS) for (const reader of WL_READERS) {
    const cell_id = CELL_OF[row][reader], k = Number(q.id.split(':')[2]);
    const a: AnswerRecord = { answer_id: answerId(cell_id, q.id, reader, 0), cell_id, realization_id: 'r0', question_id: q.id, conversation: world, system: SYSTEM_OF[row], arm: row, reader, replicate: 0, effort: 'medium', context_sha256: 'f'.repeat(64), text: 'synthetic', usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, provider_input_tokens: 1, latency_ms: 1, outcome: 'scored', weekly_run };
    const judge = bg1JudgeOf(reader);
    const j: JudgmentRecord = { answer_id: a.answer_id, instrument_id: frontierInstrumentId(INSTRUMENT.id, judge), instrument_sha256: INSTRUMENT.sha256, judge, judge_replicate: 0, temperature: null, score: k < (row === 'gbrain' ? 5 : 4) ? 1 : 0, parse_ok: true, raw_sha256: 'e'.repeat(64), outcome: 'scored', settings: { ...PER_READER_JUDGE_SETTINGS }, view: 'gating', judge_versions: ['synthetic-1'], weekly_run };
    const c = by.get(cell_id) ?? { answers: [], judgments: [] };
    c.answers.push(a); c.judgments.push(j); by.set(cell_id, c);
  }
  for (const [cell, c] of by) {
    const d = join(dir, 'cells', cell);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'answers.ndjson'), c.answers.map(x => JSON.stringify(x)).join('\n') + '\n');
    writeFileSync(join(d, 'judgments.ndjson'), c.judgments.map(x => JSON.stringify(x)).join('\n') + '\n');
  }
}

const settleAll = (dir: string) => {
  for (const s of JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')).steps) if (s.stage !== 'aggregates') markStep(dir, s.id, 'done');
  const run = JSON.parse(readFileSync(join(dir, RUN_FILE), 'utf8'));
  return settleWeek(dir, run.no_point ? {} : { costs: costsFor(run.worlds.map((w: { world: string }) => w.world)) });
};

describe('a run end to end', () => {
  const short = manifestOf(ids(8), 8);
  const weeks = ['2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29'];
  const root = join(tmp, 'e2e');
  const dirs = weeks.map(w => join(root, w));
  beforeAll(() => {
    weeks.forEach((w, i) => planWeek({ dir: dirs[i], launch: w, batch: batch(short) }, deps(w)));
    writeRecords(dirs[0], ids(8));
  });

  // Value: protects=the aggregates writer scores exactly the runner's run of the week, and a record directory of another week's run refuses; fails_when=the meta and run.json the runner writes do not bind, or another run's records are scored; why_new=harness PR (d)'s brief item 4; seam=runner.ts settleWeek writing meta.json and run.json, read by aggregates.ts main; no_claim=the record files' own contents
  test("the aggregates score the runner's week from its run directory and refuse another run's records", () => {
    settleAll(dirs[0]);
    const run = JSON.parse(readFileSync(join(dirs[0], RUN_FILE), 'utf8'));
    expect(run.run_id).toBe(runIdOf((({ schema: _s, run_id: _r, ...b }) => b)(run)));
    expect(runBindingProblems(run, JSON.parse(readFileSync(join(dirs[0], 'meta.json'), 'utf8')))).toEqual([]);
    const out = join(root, 'out');
    expect(aggregatesMain(['week', '--meta', join(dirs[0], 'meta.json'), '--records', dirs[0], '--out', out])).toBe(0);
    const week = JSON.parse(readFileSync(join(out, 'week-2026-12-08.json'), 'utf8'));
    expect([week.run_id, week.gbrain.release, week.worlds.length]).toEqual([run.run_id, 'v0.61.10.0', 8]);
    const other = join(root, 'other');
    planWeek({ dir: other, launch: '2026-12-08', batch: batch(short) }, deps('2026-12-08', `${TAGS}\n${C3}\trefs/tags/v0.61.11.0`));
    writeRecords(other, ids(8));
    expect(() => aggregatesMain(['week', '--meta', join(dirs[0], 'meta.json'), '--records', other, '--out', out])).toThrow(/not the run of any week passed with --meta/);
  });

  // Value: protects=a counted block file is written only through a block writer that passes #611 fixes 2 and 3, the block ends only when all four weeks are settled, and an ended file is never replaced by an open re-run; fails_when=the runner writes a block file with a writer that publishes an open block's simultaneous interval or wild bootstrap, or that overwrites an ended block with an open one, or reads a week still running into the look; why_new=GBEV-3 ruling on #611, 2026-11-23 (the runner must refuse to write any counted block file until fixes 2 and 3 are in); seam=runner.ts blockWriterProblems and writeBlock; no_claim=the statistics inside the block
  test('the block ends only when all four weeks settle, and an open re-run never replaces it', () => {
    const out = join(root, 'blocks');
    expect(message(() => writeBlock(1, dirs.slice(0, 2), out))).toMatch(/^WEEKLY_NOT_SETTLED: a block reads settled weeks only, and .*2026-12-15 is not settled/);
    expect(existsSync(join(out, 'block-1.json'))).toBe(false);
    for (const d of dirs.slice(1)) settleAll(d);
    const open = writeBlock(1, dirs.slice(0, 3), out);
    expect(JSON.parse(readFileSync(open, 'utf8')).ended).toBe(false);
    const path = writeBlock(1, dirs, out);
    const ended = readFileSync(path, 'utf8');
    expect(JSON.parse(ended).ended).toBe(true);
    expect(() => writeBlock(1, dirs.slice(0, 3), out)).toThrow(/WEEKLY_BLOCK_ENDED/);
    expect(readFileSync(path, 'utf8')).toBe(ended);
  }, 60_000);

  // Value: protects=every record a weekly cell writes carries the run id and week it ran under, and the aggregates refuse any answer or judgment in a run directory that this run's cells did not write, even with the run's own cell ids and worlds; fails_when=another run's records (same week, cells and worlds) or unstamped ones left in a run directory are scored, a weekly cell runs without its week's run id, or a record log mixes runs; why_new=GBEV-3 ruling on #616, finding 3 (aggregates.ts:459); seam=memory-qa/records.ts RecordLog stamp, q1/cell.ts weeklyRunStamp, identity.ts recordBindingProblems, aggregates.ts boundRecords; no_claim=records forged with a recomputed stamp, outside the crew's threat model
  test("records carry their run's stamp, and the aggregates refuse records another run's cells wrote", () => {
    const mine = join(root, 'stamp-mine'), theirs = join(root, 'stamp-theirs'), out = join(root, 'stamp-out');
    const a = planWeek({ dir: mine, launch: '2026-12-08', batch: batch(short) }, deps('2026-12-08')).run;
    const b = planWeek({ dir: theirs, launch: '2026-12-08', batch: batch(short) }, deps('2026-12-08', `${TAGS}\n${C3}\trefs/tags/v0.61.11.0`)).run;
    expect([a.week, a.cells, a.worlds]).toEqual([b.week, b.cells, b.worlds]);
    expect(a.run_id).not.toBe(b.run_id);
    writeRecords(mine, ids(8), { run_id: b.run_id, week: b.week });
    settleAll(mine);
    expect(() => aggregatesMain(['week', '--meta', join(mine, 'meta.json'), '--records', mine, '--out', out])).toThrow(/^WEEKLY_RUN_IDENTITY: .*8192 records in run .* were not written by this run's cells/);

    const stamp = weeklyRunStamp({ id: 'bgw.x', week: { launch: '2026-12-08', world_end: '2026-12-06', batch: 'bgw-1001', worlds: ids(8) } }, { [WEEKLY_RUN_ENV]: a.run_id });
    expect(stamp).toEqual({ run_id: a.run_id, week: '2026-12-08' });
    const weekly = { id: 'bgw.x', week: { launch: '2026-12-15', world_end: '2026-12-13', batch: 'bgw-1001', worlds: ids(8) } };
    expect(message(() => weeklyRunStamp(weekly, {}))).toMatch(/is a weekly-line cell of week 2026-12-15, so it runs only under one of that week's run ids in GBRAIN_EVALS_WEEKLY_RUN/);
    expect(message(() => weeklyRunStamp(weekly, { [WEEKLY_RUN_ENV]: a.run_id }))).toMatch(/weekly-line cell of week 2026-12-15/);
    expect(weeklyRunStamp({ id: 'q1.x' }, { [WEEKLY_RUN_ENV]: a.run_id })).toBeUndefined();

    const log = join(root, 'stamp-log', 'answers.ndjson');
    const rec = JSON.parse(readFileSync(join(mine, 'cells', 'g8-opus', 'answers.ndjson'), 'utf8').split('\n')[0]);
    const { weekly_run: _w, ...bare } = rec;
    new RecordLog(log, 'answer', stamp).append(bare);
    expect(JSON.parse(readFileSync(log, 'utf8')).weekly_run).toEqual(stamp);
    expect(() => new RecordLog(log, 'answer', { run_id: b.run_id, week: b.week })).toThrow(/refusing a answer of weekly run .* in weekly run/);
    expect(() => new RecordLog(join(root, 'stamp-log2', 'answers.ndjson'), 'answer', stamp).append({ ...bare, weekly_run: { run_id: b.run_id, week: b.week } })).toThrow(/refusing a answer of weekly run/);
    expect(answerProblems({ ...bare, weekly_run: { run_id: a.run_id, week: '2026-12-15' } })).toContain('answer.weekly_run is missing or invalid');
  });

  // Value: protects=settle records the SHA-256 of every answer and judgment file it settles, and the aggregates refuse a run whose record files changed, appeared or went missing since; fails_when=a judgment rewritten, a cell's files added or removed after settle is scored by the week or block aggregates; why_new=GBEV-3 ruling on #616, finding 2 (runner.ts:325); seam=runner.ts settleWeek over settled.ts recordDigests, read by aggregates.ts boundRecords; no_claim=deliberate forgery that rewrites settled.json too, outside the crew's threat model
  test('settle digests the record files, and the aggregates refuse any that changed after it', () => {
    const dir = join(root, 'digests'), out = join(root, 'digests-out');
    planWeek({ dir, launch: '2026-12-08', batch: batch(short) }, deps('2026-12-08'));
    writeRecords(dir, ids(8));
    const marker = settleAll(dir);
    expect(marker.records.map(r => r.file)).toEqual(Object.values(CELL_OF).flatMap(c => Object.values(c)).sort().flatMap(c => [`cells/${c}/answers.ndjson`, `cells/${c}/judgments.ndjson`]));
    expect(marker.records.every(r => /^[0-9a-f]{64}$/.test(r.sha256))).toBe(true);
    const week = () => aggregatesMain(['week', '--meta', join(dir, 'meta.json'), '--records', dir, '--out', out]);
    expect(week()).toBe(0);
    const judgments = join(dir, 'cells', 'g8-opus', 'judgments.ndjson'), kept = readFileSync(judgments, 'utf8');
    writeFileSync(judgments, kept.replace('"score":0', '"score":1'));
    expect(week).toThrow(/^WEEKLY_SETTLED_RECORDS: .*1 record file changed since the week settled \(first cells\/g8-opus\/judgments\.ndjson\)/);
    writeFileSync(judgments, kept);
    expect(week()).toBe(0);
    const extra = join(dir, 'cells', 'g8-opus-old');
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, 'answers.ndjson'), '');
    expect(week).toThrow(/^WEEKLY_SETTLED_RECORDS: .*appeared since the week settled \(first cells\/g8-opus-old\/answers\.ndjson\)/);
    rmSync(extra, { recursive: true });
    rmSync(join(dir, 'cells', 'mb-p1', 'judgments.ndjson'));
    expect(week).toThrow(/^WEEKLY_SETTLED_RECORDS: .*is missing \(first cells\/mb-p1\/judgments\.ndjson\)/);
    const unsettled = join(root, 'digests-unsettled');
    planWeek({ dir: unsettled, launch: '2026-12-08', batch: batch(short) }, deps('2026-12-08'));
    writeRecords(unsettled, ids(8));
    writeFileSync(join(unsettled, 'meta.json'), readFileSync(join(dir, 'meta.json')));
    expect(() => aggregatesMain(['week', '--meta', join(unsettled, 'meta.json'), '--records', unsettled, '--out', out])).toThrow(/^WEEKLY_NOT_SETTLED: .*has no settled\.json/);
  });

  // Value: protects=the standalone aggregates block command reads settled weeks only, refusing any week passed without its settled marker before it computes the look, as the runner's block does; fails_when=aggregates.ts block computes a block, its look or its file from a week with no settled marker; why_new=GBEV-3 ruling on #616, finding 1 (aggregates.ts:383); seam=aggregates.ts main block; no_claim=the marker's agreement with its meta (blockAggregates, weekly-line.test.ts)
  test('the aggregates block command refuses a week without its settled marker before computing anything', () => {
    const out = join(root, 'standalone');
    const metas = dirs.flatMap(d => ['--meta', join(d, 'meta.json')]);
    const marks = dirs.map(d => join(d, 'settled.json'));
    expect(() => aggregatesMain(['block', '--block', '1', ...metas, '--records', dirs[0], ...marks.slice(0, 3).flatMap(s => ['--settled', s]), '--out', out])).toThrow(/^WEEKLY_NOT_SETTLED: .*week 2026-12-29 has no settled marker/);
    expect(() => aggregatesMain(['block', '--block', '1', ...metas, '--records', dirs[0], '--out', out])).toThrow(/^WEEKLY_NOT_SETTLED: .*week 2026-12-08 \(and 3 more\) has no settled marker/);
    expect(existsSync(join(out, 'block-1.json'))).toBe(false);
    expect(aggregatesMain(['block', '--block', '1', ...metas, '--records', dirs[0], ...marks.flatMap(s => ['--settled', s]), '--out', out])).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'block-1.json'), 'utf8')).ended).toBe(true);
  });

  test('the runner refuses to write a counted block file through a block writer without fixes 2 and 3', () => {
    expect(blockWriterProblems(BLOCK_WRITER)).toEqual([]);
    const leaky = { ...BLOCK_WRITER, build: ((...args: Parameters<typeof BLOCK_WRITER.build>) => {
      const a = BLOCK_WRITER.build(...args);
      for (const c of Object.values(a.comparisons).flatMap(x => Object.values(x))) c.simultaneous ??= { level: 0.975, ci: [-1, 1] };
      return a;
    }) as typeof BLOCK_WRITER.build };
    const overwriting = { ...BLOCK_WRITER, write: ((out: string, a: Parameters<typeof writeBlockFiles>[1]) => { const p = join(out, `block-${a.block}.json`); rmSync(p, { force: true }); return writeBlockFiles(out, a); }) as typeof writeBlockFiles };
    expect(blockWriterProblems(leaky).join('; ')).toContain("publishes an open block's simultaneous interval or wild bootstrap");
    expect(blockWriterProblems(overwriting).join('; ')).toContain('puts an open block over an ended block file');
    const out = join(root, 'guarded');
    for (const w of [leaky, overwriting]) {
      expect(message(() => writeBlock(1, dirs, out, w))).toMatch(/^WEEKLY_BLOCK_GUARDS: no counted block file is written/);
      expect(existsSync(join(out, 'block-1.json'))).toBe(false);
    }
    expect(new WeeklyRunnerError('x')).toBeInstanceOf(Error);
  });
});
