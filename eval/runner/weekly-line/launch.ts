/**
 * The weekly outcome line's launch check (docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md, harness items
 * 1 and 3): the weekly runner calls requireWeeklyLineLaunch on the custody host before any of a week's cells or
 * particle-1's re-reads starts. It lives apart from eval/runner/bg1/launch.ts so the cell VMs' file set is unchanged.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BGW_CAMPAIGN } from '../memory-qa/bg1-names.ts';
import { bareModelId, suspendedModelProblem } from '../model-defaults.ts';
import { OPUS, PARTICLE } from '../q1/cells/bg1.ts';
import { frontierJudgesFor, type CellDefinition } from '../q1/cells/definitions.ts';
import {
  WEEKLY_LINE_BUNDLE_LOCKS, WEEKLY_LINE_JUDGE_BY_READER, WEEKLY_LINE_MODELS, WEEKLY_LINE_READERS, WEEKLY_LINE_REGISTRY, WEEKLY_LINE_ROWS, weeklyLineBuildProblems, weeklyLineWeekProblems,
  type RegistryModel, type WeeklyLineGbrainBuild, type WeeklyLineRereadPlan,
} from '../q1/cells/weekly-line.ts';
import { refuse } from '../q1/scoreboard-errors.ts';
import { ripgrepVersion } from '../systems/file-agent.ts';

/**
 * Why a week may not launch; empty when it may. It refuses:
 *
 *   ripgrep   a week with the grep agent on a host where ripgrep can't run, because a missing rg would cripple that row;
 *   locks     a server cell whose committed bundle lockfiles (WEEKLY_LINE_BUNDLE_LOCKS: the pin table's and the shim's
 *             uv.lock) don't hash to #594's patched locks, extract-first 9c32b495 and memory-bank 29b875e0;
 *   rows      a week that doesn't hold each of the four preregistered rows exactly once, or holds another cell, or a cell
 *             whose arms aren't its row's one arm at the row's mode and reading budget (WEEKLY_LINE_ROWS), so a
 *             hand-edited 16,000-token read refuses;
 *   gbrain    a gbrain cell whose launch GBRAIN_SHA or recorded gbrain_build isn't the build the runner resolved and
 *             passed in (the newest release at launch);
 *   worlds    a cell outside Set W (set, benchmark or block), cells that don't share one week, a week whose launch, world
 *             end, batch or worlds weeklyLineWeekProblems rejects, or a re-read of another week's worlds;
 *   readers   an 8,000-token arm not read live by claude-opus-5-5 alone, a grep-agent arm not run by both readers, an
 *             8,000-token arm without exactly one particle-1 re-read, or a re-read by anything but particle-1;
 *   judges    a judge that isn't the reader's mapped one (gpt-6-astra for claude-opus-5-5, claude-opus-5-5 for particle-1),
 *             so particle-1 never judges and no model grades its own family, or a cell whose canonical judge would also
 *             grade every answer (descriptive_view not false);
 *   models    a suspended model (gpt-4o, gpt-4o-mini) as a reader or judge, a cell set whose models list disagrees with the
 *             registry entry's, a suspended model listed anywhere but as a compared system's system-internal model, or a
 *             model a cell or re-read can call (weeklyLineCalledModels) that the code's list (WEEKLY_LINE_MODELS) and the
 *             registry entry don't both name in that role.
 */
export function weeklyLineLaunchProblems(l: { gbrain: WeeklyLineGbrainBuild; cells: readonly CellDefinition[]; rereads: readonly WeeklyLineRereadPlan[] },
  deps: { ripgrep?: () => string | null; registry?: readonly RegistryModel[]; lockSha256?: (file: string) => string | null } = {}): string[] {
  const p: string[] = [...weeklyLineBuildProblems(l.gbrain)];
  if (!l.cells.length) return [...p, 'the week has no cells'];
  const week = l.cells[0].week;
  for (const c of l.cells) {
    if (c.set !== 'BGW' || c.benchmark !== 'bgw' || c.block !== 'BGW') p.push(`cell ${c.id} runs set ${c.set} (${c.benchmark}), not Set W`);
    if (JSON.stringify(c.week) !== JSON.stringify(week)) p.push(`cell ${c.id} runs another week than ${l.cells[0].id}`);
    if (c.descriptive_view !== false) p.push(`cell ${c.id} would add its instrument's canonical judge to every answer (descriptive_view is not false)`);
  }
  for (const [row, { system, configuration }] of Object.entries(WEEKLY_LINE_ROWS)) {
    const n = l.cells.filter(c => c.system === system && c.configuration === configuration).length;
    if (n !== 1) p.push(`the week has ${n} ${row} cells (${system}.${configuration}), not one`);
  }
  for (const c of l.cells) {
    const row = Object.values(WEEKLY_LINE_ROWS).find(r => r.system === c.system && r.configuration === c.configuration);
    if (!row) { p.push(`cell ${c.id} is not one of the preregistered rows`); continue; }
    if (c.arms.length !== 1) p.push(`cell ${c.id} has ${c.arms.length} arms, not its row's one`);
    for (const a of c.arms) if (a.mode !== row.mode || (a.budget ?? null) !== row.budget) p.push(`arm ${a.cell_id} reads in mode ${a.mode} at ${a.budget ?? 'no'} token budget, not its row's ${row.mode} at ${row.budget ?? 'no'} token budget`);
  }
  if (!week) p.push(`cell ${l.cells[0].id} names no week`);
  else p.push(...weeklyLineWeekProblems(week, week.worlds));
  for (const c of l.cells.filter(c => c.system === 'gbrain-defaults')) {
    if (c.launch?.env.GBRAIN_SHA !== l.gbrain.commit || JSON.stringify(c.gbrain_build) !== JSON.stringify({ release: l.gbrain.release, commit: l.gbrain.commit })) {
      p.push(`cell ${c.id} pins gbrain ${c.gbrain_build?.release ?? 'no release'} at ${c.launch?.env.GBRAIN_SHA ?? 'no commit'}, not ${l.gbrain.release} at ${l.gbrain.commit}, the build resolved at launch`);
    }
  }
  if (l.cells.some(c => c.system === 'baseline-file-agent') && (deps.ripgrep ?? ripgrepVersion)() === null) p.push('ripgrep (rg) can\'t run on this host, and the grep agent\'s cell needs it');
  for (const [system, lock] of Object.entries(WEEKLY_LINE_BUNDLE_LOCKS)) {
    if (!l.cells.some(c => c.system === system)) continue;
    for (const file of lock.files) {
      const got = (deps.lockSha256 ?? committedLockSha256)(file);
      if (got !== lock.sha256) p.push(`${system}'s bundle lock ${file} ${got === null ? 'is missing' : `hashes to ${got.slice(0, 8)}`}, not the patched lock ${lock.sha256.slice(0, 8)} the line runs on`);
    }
  }
  const used = new Set<string>();
  const readerJudge = (where: string, reader: string, judges: readonly string[]) => {
    for (const m of [reader, ...judges]) used.add(m);
    const want = WEEKLY_LINE_JUDGE_BY_READER[reader];
    if (judges.length !== 1 || judges[0] !== want) p.push(`${where}: ${reader} is judged by ${judges.join(', ') || 'no judge'}, not ${want ?? 'a preregistered judge'}`);
  };
  for (const c of l.cells) for (const a of c.arms) {
    const readers = a.mode === 'agent' ? [...WEEKLY_LINE_READERS] : [OPUS];
    if (JSON.stringify(a.readers) !== JSON.stringify(readers)) p.push(`arm ${a.cell_id} is read by ${a.readers.join(', ') || 'nobody'}, not ${readers.join(', ')}`);
    if (a.mode === 'packed') {
      const n = l.rereads.filter(r => r.arm_cell_id === a.cell_id).length;
      if (n !== 1) p.push(`arm ${a.cell_id} has ${n} particle-1 re-reads, not one`);
    }
    for (const r of a.readers) readerJudge(`arm ${a.cell_id}`, r, a.frontier?.per_reader ? [a.frontier.judge_by_reader?.[r] ?? frontierJudgesFor(a, r)[0]] : a.frontier?.judges ?? []);
    for (const j of a.frontier?.judges ?? []) if (!Object.values(WEEKLY_LINE_JUDGE_BY_READER).includes(j)) p.push(`arm ${a.cell_id}: judge ${j} is not a preregistered judge`);
  }
  for (const r of l.rereads) {
    if (r.reader !== PARTICLE) p.push(`re-read ${r.id} is read by ${r.reader}, not ${PARTICLE}`);
    readerJudge(`re-read ${r.id}`, r.reader, r.judges);
    if (!l.cells.some(c => c.id === r.cell && c.arms.some(a => a.cell_id === r.arm_cell_id && a.mode === 'packed'))) p.push(`re-read ${r.id} reads no 8,000-token arm of this week's cells`);
    if (JSON.stringify(r.worlds) !== JSON.stringify(week?.worlds)) p.push(`re-read ${r.id} reads worlds ${r.worlds.join(', ')}, not the week's`);
  }
  p.push(...[...used].flatMap(m => suspendedModelProblem(m) ?? []));
  const registry = deps.registry ?? weeklyLineRegistryModels();
  p.push(...weeklyLineModelProblems(registry));
  const key = (m: RegistryModel) => `${bareModelId(m.model)} as ${m.role}`;
  const listed = new Set(WEEKLY_LINE_MODELS.map(key)), registered = new Set(registry.map(key));
  for (const m of weeklyLineCalledModels(l.cells, l.rereads)) {
    if (!listed.has(key(m))) p.push(`a weekly cell can call ${key(m)}, which WEEKLY_LINE_MODELS doesn't name`);
    if (!registered.has(key(m))) p.push(`a weekly cell can call ${key(m)}, which the registry entry (${WEEKLY_LINE_REGISTRY}) doesn't list`);
  }
  return [...new Set(p)];
}

/**
 * Every model a week's cells and re-reads can call, with its role: each arm's and re-read's readers (under-test) and
 * judges (judge), and the shipped models of each cell's system (system-internal, as WEEKLY_LINE_MODELS names them by
 * system). The shipped models come from that hand-kept list, not from the servers' own configuration, so a shipped model
 * missing from WEEKLY_LINE_MODELS passes; the registry comparison is what this check adds for them.
 */
export function weeklyLineCalledModels(cells: readonly CellDefinition[], rereads: readonly WeeklyLineRereadPlan[]): RegistryModel[] {
  const out: RegistryModel[] = [];
  for (const c of cells) {
    for (const a of c.arms) {
      out.push(...a.readers.map(model => ({ model, role: 'under-test' })));
      out.push(...[...(a.frontier?.judges ?? []), ...Object.values(a.frontier?.judge_by_reader ?? {})].map(model => ({ model, role: 'judge' })));
    }
    out.push(...WEEKLY_LINE_MODELS.filter(m => m.role === 'system-internal' && m.system === c.system));
  }
  for (const r of rereads) out.push({ model: r.reader, role: 'under-test' }, ...r.judges.map(model => ({ model, role: 'judge' })));
  return out;
}

/** The SHA-256 of a committed file's bytes, by its path from the repository root, as #594's relock hashed each uv.lock; null when it is missing. */
export function committedLockSha256(file: string): string | null {
  const path = join(import.meta.dir, '../../..', file);
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

/** The weekly line registry entry's models list (WEEKLY_LINE_REGISTRY). */
export function weeklyLineRegistryModels(): RegistryModel[] {
  const reg = JSON.parse(readFileSync(join(import.meta.dir, '../../..', WEEKLY_LINE_REGISTRY), 'utf8')) as { experiments: Array<{ id: string; models?: RegistryModel[] }> };
  return reg.experiments.find(e => e.id === BGW_CAMPAIGN)?.models ?? [];
}

/** Refuse before any of a week's cells or re-reads starts when weeklyLineLaunchProblems finds a problem. */
export function requireWeeklyLineLaunch(l: Parameters<typeof weeklyLineLaunchProblems>[0], deps: Parameters<typeof weeklyLineLaunchProblems>[1] = {}): void {
  const problems = weeklyLineLaunchProblems(l, deps);
  if (!problems.length) return;
  throw refuse({ code: 'PREFLIGHT_FAILED', message: `weekly line week ${l.cells[0]?.week?.launch ?? '(no week)'} refused before any cell starts: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`,
    why: 'each week runs gbrain\'s newest release, the grep agent with ripgrep, the two servers and both readers with their preregistered judges on its own Set W worlds, and no suspended model in a role we choose',
    fix: { next: 'ask_user', user_message: 'regenerate the week\'s cells with generateWeeklyLineCells and weeklyLineRereadPlans from the resolved gbrain build, the week and its worlds, on a host with ripgrep installed' } });
}

/**
 * Why the cell set's models and the registry entry's disagree, compared by bare model id and role, with the registry's
 * simulators (the mint's) left out, and any suspended model in a role other than system-internal on either side. Empty
 * when they agree.
 */
export function weeklyLineModelProblems(registry: readonly RegistryModel[], models: readonly RegistryModel[] = WEEKLY_LINE_MODELS): string[] {
  const key = (m: RegistryModel) => `${bareModelId(m.model)} as ${m.role}`;
  const ours = new Set(models.map(key)), theirs = new Set(registry.filter(m => m.role !== 'simulator').map(key));
  return [
    ...[...ours].filter(k => !theirs.has(k)).map(k => `the cell set calls ${k}, which the registry entry (${WEEKLY_LINE_REGISTRY}) doesn't list`),
    ...[...theirs].filter(k => !ours.has(k)).map(k => `the registry entry lists ${k}, which the cell set doesn't call`),
    ...[...models, ...registry].filter(m => m.role !== 'system-internal').flatMap(m => suspendedModelProblem(m.model) ?? []),
  ];
}
