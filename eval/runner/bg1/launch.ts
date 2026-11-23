/**
 * BG1's launch check (#398 open notes 5 and 6, the Captain's conditions 1 to 3), run before a BG1 campaign's init and
 * before any of its VMs boots: by `scoreboard run` (runCells) and by shootout-cell.ts's init, reserve, launch and resume.
 *
 *   Lease     every unit's lease_usd is the lease campaignCells prices for it from the committed bg1-cells.json
 *             (bg1Lease's override or the estimate per shard; twice the estimate for a smoke unit), so a lease edited,
 *             missing or added in the campaign manifest before init refuses. After init the frozen campaign hash
 *             refuses any edit, and the Campaign keeps leases.ndjson's SHA-256 beside it (shootout-cell.ts).
 *   Window    every unit's command carries --window-cap-usd at the campaign's cap_usd, the granted window cap
 *             (bg1CampaignManifest writes both from the unit selection's cap_usd).
 *   Sum       the leases of every unit in the campaign sum to no more than that cap, so a campaign never boots some
 *             units and then stops on the cap partway.
 *   Blocks    the leases of each block's units sum to no more than that block's cap_usd in the campaign manifest,
 *             the cap shootout-cell.ts reserve() also stops at, so a window granted above a block's cap never boots
 *             some of the block's units and then stops on the block cap partway.
 *
 * A BG1-C campaign (its units are bg1c-cells.json's) takes the same checks against bg1c-cells.json, and two more: it
 * holds no BG1 unit, since each set runs in its own campaign under its own manifest, and no unit passes BG1's Gemini
 * key or names Gemini as a provider, since no BG1-C answer gets the Gemini view.
 *
 * A campaign with no BG1 unit passes untouched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BGW_CAMPAIGN } from '../memory-qa/bg1-names.ts';
import { suspendedModelProblem } from '../model-defaults.ts';
import { BG1_GEMINI_KEY_ENV, campaignCells, loadCellManifest } from '../q1/cell.ts';
import { OPUS, PARTICLE } from '../q1/cells/bg1.ts';
import { frontierJudgesFor, isBg1Benchmark, type CellDefinition } from '../q1/cells/definitions.ts';
import {
  WEEKLY_LINE_JUDGE_BY_READER, WEEKLY_LINE_READERS, WEEKLY_LINE_REGISTRY, weeklyLineBuildProblems, weeklyLineModelProblems, weeklyLineWeekProblems,
  type RegistryModel, type WeeklyLineGbrainBuild, type WeeklyLineRereadPlan,
} from '../q1/cells/weekly-line.ts';
import { refuse } from '../q1/scoreboard-errors.ts';
import { ripgrepVersion } from '../systems/file-agent.ts';
import type { CampaignManifest } from '../shootout-cell.ts';

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
const SETS = { bg1: { label: 'BG1', file: 'bg1-cells.json' }, bg1c: { label: 'BG1-C', file: 'bg1c-cells.json' } } as const;
type SetId = keyof typeof SETS;
const priced = (which: SetId) => new Map(campaignCells(loadCellManifest(which), { smoke: true, addons: true }).map(c => [c.id, c.lease_usd]));

/** The set a campaign's units come from: BG1-C when any unit is one of bg1c-cells.json's, else BG1. */
function setOf(m: Pick<CampaignManifest, 'cells'>, prices: Record<SetId, Map<string, number>>): SetId {
  return m.cells.some(c => prices.bg1c.has(c.id)) ? 'bg1c' : 'bg1';
}

/** Why a BG1 or BG1-C campaign may not boot a unit; empty when it may, or when the campaign has no BG1 unit. */
export function bg1LaunchProblems(m: Pick<CampaignManifest, 'cap_usd' | 'cells' | 'blocks'>): string[] {
  if (!m.cells.some(c => isBg1Benchmark(c.benchmark))) return [];
  const prices = { bg1: priced('bg1'), bg1c: priced('bg1c') };
  const which = setOf(m, prices), { file } = SETS[which];
  const others = which === 'bg1c' ? m.cells.filter(c => prices.bg1.has(c.id)) : [];
  const problems = others.length ? [`the campaign holds BG1-C units and ${others.length} BG1 unit(s) (${others.map(c => c.id).slice(0, 3).join(', ')}); each set runs in its own campaign`] : [];
  problems.push(...m.cells.flatMap(c => {
    const lease = prices[which].get(c.id), cap = /--window-cap-usd (\S+)/.exec(c.command)?.[1];
    return [
      ...(others.includes(c) ? [] : lease === undefined ? [`unit ${c.id} is not a unit of the committed ${file}`] : near(c.lease_usd, lease) ? [] : [`unit ${c.id} leases ${c.lease_usd}, not the ${lease} ${file} prices it at`]),
      ...(cap !== undefined && near(Number(cap), m.cap_usd) ? [] : [`unit ${c.id} carries --window-cap-usd ${cap ?? 'nowhere'}, not the campaign's cap_usd ${m.cap_usd}`]),
      ...(which === 'bg1c' && (c.providers?.includes('gemini') || c.pass?.includes(BG1_GEMINI_KEY_ENV) || c.gemini_key_env !== undefined) ? [`unit ${c.id} is given Gemini (provider, ${BG1_GEMINI_KEY_ENV} or gemini_key_env), which no BG1-C unit calls`] : []),
    ];
  }));
  const sum = m.cells.reduce((n, c) => n + c.lease_usd, 0);
  if (!(sum <= m.cap_usd + 1e-9)) problems.push(`the ${m.cells.length} unit leases sum to ${Math.round(sum * 100) / 100}, above the window cap ${m.cap_usd}`);
  for (const [block, { cap_usd }] of Object.entries(m.blocks ?? {})) {
    const units = m.cells.filter(c => c.block === block);
    const held = units.reduce((n, c) => n + c.lease_usd, 0);
    if (!(held <= cap_usd + 1e-9)) problems.push(`the ${units.length} unit leases of block ${block} sum to ${Math.round(held * 100) / 100}, above its cap_usd ${cap_usd}`);
  }
  return problems;
}

/** Refuse before init or any VM boots when a BG1 or BG1-C campaign's leases or window caps do not fit its granted window or its block caps. */
export function requireBg1Launch(m: Pick<CampaignManifest, 'campaign_id' | 'cap_usd' | 'cells' | 'blocks'>, manifestPath: string): void {
  const problems = bg1LaunchProblems(m);
  if (!problems.length) return;
  const which = setOf(m, { bg1: priced('bg1'), bg1c: priced('bg1c') }), { label } = SETS[which];
  throw refuse({ code: 'PREFLIGHT_FAILED', message: `${label} campaign ${m.campaign_id} refused before any VM boots: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`,
    why: `every ${label} unit runs inside one granted paid window on the lease pricing.ts gave it, so each lease is the priced one and together they fit that window's cap before the first VM boots`,
    fix: { next: 'ask_user', user_message: `plan the ${label} campaign again (bun eval/runner/q1/cell.ts plan --manifest ${which} --units <selection> --campaign-out ${manifestPath}) with fewer units or the granted window's cap` } });
}

/**
 * The weekly outcome line's launch check (docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md, harness
 * items 1 and 3), run by the weekly runner before any of a week's cells or re-reads starts. It refuses:
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

