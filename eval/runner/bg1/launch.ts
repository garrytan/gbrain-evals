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
 * A weekly-line campaign (its units run Set W, bgw; cell.ts weeklyCampaignManifest) takes the same checks against the
 * running week's cells.json (cell.ts loadWeeklyCells, so it refuses where that file can't be read), holds no unit of another
 * set, and gives no unit Gemini.
 *
 * A weekly-line pilot campaign (its units are the pilot's or the judge check's, blocks BGW-pilot and BGW-judge; cell.ts
 * weeklyPilotCampaignManifest) takes the same checks against the pilot manifest at the gbrain build its commands export
 * (cell.ts loadWeeklyPilotManifest, so it refuses where the units name none or disagree), holds no unit of another set, and gives no
 * unit Gemini.
 *
 * A campaign with no BG1, BG1-C or weekly-line unit passes untouched.
 */
import { BG1_GEMINI_KEY_ENV, campaignCells, loadCellManifest } from '../q1/cell.ts';
import { isWindowedBenchmark, WEEKLY_PILOT_BLOCK_IDS } from '../q1/cells/definitions.ts';
import { WEEKLY_PILOT_GBRAIN_ENV } from '../q1/cells/weekly-line.ts';
import { refuse } from '../q1/scoreboard-errors.ts';
import type { CampaignManifest } from '../shootout-cell.ts';

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
const SETS = { bg1: { label: 'BG1', file: 'bg1-cells.json' }, bg1c: { label: 'BG1-C', file: 'bg1c-cells.json' }, weekly: { label: 'Set W', file: "the week's cells.json" }, 'weekly-pilot': { label: 'weekly pilot', file: 'the weekly pilot manifest' } } as const;
type SetId = keyof typeof SETS;
/** Each set's unit leases as campaignCells prices them; the weekly line's from the running week's cells.json (cell.ts loadWeeklyCells), so a weekly campaign refuses where that file cannot be read. */
const priced = (which: SetId, env: Record<string, string | undefined> = process.env) => new Map(campaignCells(loadCellManifest(which, env), { smoke: true, addons: true }).map(c => [c.id, c.lease_usd]));
/** The gbrain build every pilot unit's command exports (WEEKLY_PILOT_GBRAIN_ENV); empty, so the pilot manifest refuses, when the units name none or disagree. */
function pilotBuildEnv(m: Pick<CampaignManifest, 'cells'>): Record<string, string> {
  const builds = new Set(m.cells.filter(inPilot).map(c => new RegExp(`export ${WEEKLY_PILOT_GBRAIN_ENV}=(\\S+?);`).exec(c.command)?.[1] ?? ''));
  return { [WEEKLY_PILOT_GBRAIN_ENV]: builds.size === 1 ? [...builds][0] : '' };
}

const inPilot = (c: Pick<CampaignManifest['cells'][number], 'block'>) => (WEEKLY_PILOT_BLOCK_IDS as readonly string[]).includes(c.block ?? '');
/** The set a campaign's units come from: Set W when any unit runs bgw, the weekly pilot when any unit is in its blocks, BG1-C when any unit is one of bg1c-cells.json's, else BG1. */
function setOf(m: Pick<CampaignManifest, 'cells'>, prices: Pick<Record<SetId, Map<string, number>>, 'bg1c'>): SetId {
  return m.cells.some(c => c.benchmark === 'bgw') ? 'weekly' : m.cells.some(inPilot) ? 'weekly-pilot' : m.cells.some(c => prices.bg1c.has(c.id)) ? 'bg1c' : 'bg1';
}

/** Why a BG1 or BG1-C campaign may not boot a unit; empty when it may, or when the campaign has no BG1 unit. */
export function bg1LaunchProblems(m: Pick<CampaignManifest, 'cap_usd' | 'cells' | 'blocks'>): string[] {
  if (!m.cells.some(c => isWindowedBenchmark(c.benchmark))) return [];
  const prices = { bg1: priced('bg1'), bg1c: priced('bg1c') };
  const which = setOf(m, prices), { file } = SETS[which];
  const own = which === 'weekly' ? priced(which) : which === 'weekly-pilot' ? priced(which, pilotBuildEnv(m)) : prices[which];
  const others = which === 'bg1c' ? m.cells.filter(c => prices.bg1.has(c.id)) : which === 'weekly' ? m.cells.filter(c => c.benchmark !== 'bgw') : which === 'weekly-pilot' ? m.cells.filter(c => !inPilot(c)) : [];
  const problems = others.length ? [`the campaign holds ${SETS[which].label} units and ${others.length} ${which === 'bg1c' ? 'BG1 unit(s)' : 'unit(s) of another set'} (${others.map(c => c.id).slice(0, 3).join(', ')}); each set runs in its own campaign`] : [];
  problems.push(...m.cells.flatMap(c => {
    const lease = own.get(c.id), cap = /--window-cap-usd (\S+)/.exec(c.command)?.[1];
    return [
      ...(others.includes(c) ? [] : lease === undefined ? [`unit ${c.id} is not a unit of the committed ${file}`] : near(c.lease_usd, lease) ? [] : [`unit ${c.id} leases ${c.lease_usd}, not the ${lease} ${file} prices it at`]),
      ...(cap !== undefined && near(Number(cap), m.cap_usd) ? [] : [`unit ${c.id} carries --window-cap-usd ${cap ?? 'nowhere'}, not the campaign's cap_usd ${m.cap_usd}`]),
      ...(which !== 'bg1' && (c.providers?.includes('gemini') || c.pass?.includes(BG1_GEMINI_KEY_ENV) || c.gemini_key_env !== undefined) ? [`unit ${c.id} is given Gemini (provider, ${BG1_GEMINI_KEY_ENV} or gemini_key_env), which no ${SETS[which].label} unit calls`] : []),
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
  const which = setOf(m, { bg1c: priced('bg1c') }), { label } = SETS[which];
  throw refuse({ code: 'PREFLIGHT_FAILED', message: `${label} campaign ${m.campaign_id} refused before any VM boots: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`,
    why: `every ${label} unit runs inside one granted paid window on the lease pricing.ts gave it, so each lease is the priced one and together they fit that window's cap before the first VM boots`,
    fix: { next: 'ask_user', user_message: `plan the ${label} campaign again (bun eval/runner/q1/cell.ts plan --manifest ${which} --units <selection> --campaign-out ${manifestPath}) with fewer units or the granted window's cap` } });
}
