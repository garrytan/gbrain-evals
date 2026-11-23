/**
 * The weekly outcome line's launch check (docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md, harness items
 * 1 and 3): the weekly runner calls requireWeeklyLineLaunch on the custody host before any of a week's cells or
 * particle-1's re-reads starts. It lives apart from eval/runner/bg1/launch.ts so the cell VMs' file set is unchanged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BGW_CAMPAIGN } from '../memory-qa/bg1-names.ts';
import { bareModelId, suspendedModelProblem } from '../model-defaults.ts';
import { OPUS, PARTICLE } from '../q1/cells/bg1.ts';
import { frontierJudgesFor, type CellDefinition } from '../q1/cells/definitions.ts';
import {
  WEEKLY_LINE_JUDGE_BY_READER, WEEKLY_LINE_MODELS, WEEKLY_LINE_READERS, WEEKLY_LINE_REGISTRY, weeklyLineBuildProblems, weeklyLineWeekProblems,
  type RegistryModel, type WeeklyLineGbrainBuild, type WeeklyLineRereadPlan,
} from '../q1/cells/weekly-line.ts';
import { refuse } from '../q1/scoreboard-errors.ts';
import { ripgrepVersion } from '../systems/file-agent.ts';

/**
 * Why a week may not launch; empty when it may. It refuses:
 *
 *   ripgrep   a week with the grep agent on a host where ripgrep can't run, because a missing rg would cripple that row;
 *   gbrain    a gbrain cell whose launch GBRAIN_SHA or recorded gbrain_build isn't the build the runner resolved and
 *             passed in (the newest release at launch), or a week with no gbrain cell or more than one;
 *   worlds    a cell outside Set W (set, benchmark or block), cells that don't share one week, a week whose launch, world
 *             end, batch or worlds weeklyLineWeekProblems rejects, or a re-read of another week's worlds;
 *   readers   a reader outside claude-opus-5-5 and particle-1, a live 8,000-token arm read by anything but claude-opus-5-5,
 *             or a re-read by anything but particle-1;
 *   judges    a judge that isn't the reader's mapped one (gpt-6-astra for claude-opus-5-5, claude-opus-5-5 for particle-1),
 *             so particle-1 never judges and no model grades its own family;
 *   models    a suspended model (gpt-4o, gpt-4o-mini) as a reader or judge, a cell set whose models list disagrees with the
 *             registry entry's, or a suspended model listed anywhere but as a compared system's system-internal model.
 */
export function weeklyLineLaunchProblems(l: { gbrain: WeeklyLineGbrainBuild; cells: readonly CellDefinition[]; rereads: readonly WeeklyLineRereadPlan[] },
  deps: { ripgrep?: () => string | null; registry?: readonly RegistryModel[] } = {}): string[] {
  const p: string[] = [...weeklyLineBuildProblems(l.gbrain)];
  if (!l.cells.length) return [...p, 'the week has no cells'];
  const week = l.cells[0].week;
  for (const c of l.cells) {
    if (c.set !== 'BGW' || c.benchmark !== 'bgw' || c.block !== 'BGW') p.push(`cell ${c.id} runs set ${c.set} (${c.benchmark}), not Set W`);
    if (JSON.stringify(c.week) !== JSON.stringify(week)) p.push(`cell ${c.id} runs another week than ${l.cells[0].id}`);
  }
  if (!week) p.push(`cell ${l.cells[0].id} names no week`);
  else p.push(...weeklyLineWeekProblems(week, week.worlds));
  const gbrain = l.cells.filter(c => c.system === 'gbrain-defaults');
  if (gbrain.length !== 1) p.push(`the week has ${gbrain.length} gbrain cells, not one`);
  for (const c of gbrain) {
    if (c.launch?.env.GBRAIN_SHA !== l.gbrain.commit || JSON.stringify(c.gbrain_build) !== JSON.stringify({ release: l.gbrain.release, commit: l.gbrain.commit })) {
      p.push(`cell ${c.id} pins gbrain ${c.gbrain_build?.release ?? 'no release'} at ${c.launch?.env.GBRAIN_SHA ?? 'no commit'}, not ${l.gbrain.release} at ${l.gbrain.commit}, the build resolved at launch`);
    }
  }
  if (l.cells.some(c => c.system === 'baseline-file-agent') && (deps.ripgrep ?? ripgrepVersion)() === null) p.push('ripgrep (rg) can\'t run on this host, and the grep agent\'s cell needs it');
  const used = new Set<string>();
  const readerJudge = (where: string, reader: string, judges: readonly string[], allowed: readonly string[]) => {
    for (const m of [reader, ...judges]) used.add(m);
    if (!allowed.includes(reader)) p.push(`${where}: reader ${reader} is not one of ${allowed.join(', ')}`);
    const want = WEEKLY_LINE_JUDGE_BY_READER[reader];
    if (judges.length !== 1 || judges[0] !== want) p.push(`${where}: ${reader} is judged by ${judges.join(', ') || 'no judge'}, not ${want ?? 'a preregistered judge'}`);
  };
  for (const c of l.cells) for (const a of c.arms) {
    const allowed = a.mode === 'agent' ? [...WEEKLY_LINE_READERS] : [OPUS];
    for (const r of a.readers) readerJudge(`arm ${a.cell_id}`, r, a.frontier?.per_reader ? [a.frontier.judge_by_reader?.[r] ?? frontierJudgesFor(a, r)[0]] : a.frontier?.judges ?? [], allowed);
    for (const j of a.frontier?.judges ?? []) if (!Object.values(WEEKLY_LINE_JUDGE_BY_READER).includes(j)) p.push(`arm ${a.cell_id}: judge ${j} is not a preregistered judge`);
  }
  for (const r of l.rereads) {
    readerJudge(`re-read ${r.id}`, r.reader, r.judges, [PARTICLE]);
    if (!l.cells.some(c => c.id === r.cell && c.arms.some(a => a.cell_id === r.arm_cell_id && a.mode === 'packed'))) p.push(`re-read ${r.id} reads no 8,000-token arm of this week's cells`);
    if (JSON.stringify(r.worlds) !== JSON.stringify(week?.worlds)) p.push(`re-read ${r.id} reads worlds ${r.worlds.join(', ')}, not the week's`);
  }
  p.push(...[...used].flatMap(m => suspendedModelProblem(m) ?? []));
  p.push(...weeklyLineModelProblems(deps.registry ?? weeklyLineRegistryModels()));
  return [...new Set(p)];
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
