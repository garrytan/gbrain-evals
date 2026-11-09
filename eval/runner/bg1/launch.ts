/**
 * BG1's launch check (#398 open note 5, the Captain's condition 2), run before a BG1 campaign's init and before any of
 * its VMs boots: by `scoreboard run` (runCells) and by shootout-cell.ts's init, reserve, launch and resume.
 *
 *   Window    every unit's command carries --window-cap-usd at the campaign's cap_usd, the granted window cap
 *             (bg1CampaignManifest writes both from the unit selection's cap_usd).
 *   Sum       the leases of every unit in the campaign sum to no more than that cap, so a campaign never boots some
 *             units and then stops on the cap partway.
 *
 * A campaign with no BG1 unit passes untouched.
 */
import { isBg1Benchmark } from '../q1/cells/definitions.ts';
import { refuse } from '../q1/scoreboard-errors.ts';
import type { CampaignManifest } from '../shootout-cell.ts';

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9;

/** Why a BG1 campaign may not boot a unit; empty when it may, or when the campaign has no BG1 unit. */
export function bg1LaunchProblems(m: Pick<CampaignManifest, 'cap_usd' | 'cells'>): string[] {
  if (!m.cells.some(c => isBg1Benchmark(c.benchmark))) return [];
  const problems = m.cells.flatMap(c => {
    const cap = /--window-cap-usd (\S+)/.exec(c.command)?.[1];
    return cap !== undefined && near(Number(cap), m.cap_usd) ? [] : [`unit ${c.id} carries --window-cap-usd ${cap ?? 'nowhere'}, not the campaign's cap_usd ${m.cap_usd}`];
  });
  const sum = m.cells.reduce((n, c) => n + c.lease_usd, 0);
  if (!(sum <= m.cap_usd + 1e-9)) problems.push(`the ${m.cells.length} unit leases sum to ${Math.round(sum * 100) / 100}, above the window cap ${m.cap_usd}`);
  return problems;
}

/** Refuse before init or any VM boots when a BG1 campaign's leases or window caps do not fit its granted window. */
export function requireBg1Launch(m: Pick<CampaignManifest, 'campaign_id' | 'cap_usd' | 'cells'>, manifestPath: string): void {
  const problems = bg1LaunchProblems(m);
  if (!problems.length) return;
  throw refuse({ code: 'PREFLIGHT_FAILED', message: `BG1 campaign ${m.campaign_id} refused before any VM boots: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`,
    why: 'every BG1 unit runs inside one granted paid window, so the campaign\'s leases together fit that window\'s cap before the first VM boots',
    fix: { next: 'ask_user', user_message: `plan the BG1 campaign again (bun eval/runner/q1/cell.ts plan --manifest bg1 --units <selection> --campaign-out ${manifestPath}) with fewer units or the granted window's cap` } });
}
