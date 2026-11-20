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
 * A campaign with no BG1 unit passes untouched.
 */
import { campaignCells, loadCellManifest } from '../q1/cell.ts';
import { isBg1Benchmark } from '../q1/cells/definitions.ts';
import { refuse } from '../q1/scoreboard-errors.ts';
import type { CampaignManifest } from '../shootout-cell.ts';

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9;

/** Why a BG1 campaign may not boot a unit; empty when it may, or when the campaign has no BG1 unit. */
export function bg1LaunchProblems(m: Pick<CampaignManifest, 'cap_usd' | 'cells' | 'blocks'>): string[] {
  if (!m.cells.some(c => isBg1Benchmark(c.benchmark))) return [];
  const priced = new Map(campaignCells(loadCellManifest('bg1'), { smoke: true, addons: true }).map(c => [c.id, c.lease_usd]));
  const problems = m.cells.flatMap(c => {
    const lease = priced.get(c.id), cap = /--window-cap-usd (\S+)/.exec(c.command)?.[1];
    return [
      ...(lease === undefined ? [`unit ${c.id} is not a unit of the committed bg1-cells.json`] : near(c.lease_usd, lease) ? [] : [`unit ${c.id} leases ${c.lease_usd}, not the ${lease} bg1-cells.json prices it at`]),
      ...(cap !== undefined && near(Number(cap), m.cap_usd) ? [] : [`unit ${c.id} carries --window-cap-usd ${cap ?? 'nowhere'}, not the campaign's cap_usd ${m.cap_usd}`]),
    ];
  });
  const sum = m.cells.reduce((n, c) => n + c.lease_usd, 0);
  if (!(sum <= m.cap_usd + 1e-9)) problems.push(`the ${m.cells.length} unit leases sum to ${Math.round(sum * 100) / 100}, above the window cap ${m.cap_usd}`);
  for (const [block, { cap_usd }] of Object.entries(m.blocks ?? {})) {
    const units = m.cells.filter(c => c.block === block);
    const held = units.reduce((n, c) => n + c.lease_usd, 0);
    if (!(held <= cap_usd + 1e-9)) problems.push(`the ${units.length} unit leases of block ${block} sum to ${Math.round(held * 100) / 100}, above its cap_usd ${cap_usd}`);
  }
  return problems;
}

/** Refuse before init or any VM boots when a BG1 campaign's leases or window caps do not fit its granted window or its block caps. */
export function requireBg1Launch(m: Pick<CampaignManifest, 'campaign_id' | 'cap_usd' | 'cells' | 'blocks'>, manifestPath: string): void {
  const problems = bg1LaunchProblems(m);
  if (!problems.length) return;
  throw refuse({ code: 'PREFLIGHT_FAILED', message: `BG1 campaign ${m.campaign_id} refused before any VM boots: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`,
    why: 'every BG1 unit runs inside one granted paid window on the lease pricing.ts gave it, so each lease is the priced one and together they fit that window\'s cap before the first VM boots',
    fix: { next: 'ask_user', user_message: `plan the BG1 campaign again (bun eval/runner/q1/cell.ts plan --manifest bg1 --units <selection> --campaign-out ${manifestPath}) with fewer units or the granted window's cap` } });
}
