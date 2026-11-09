/**
 * BG1's launch check (eval/runner/bg1/launch.ts): before a BG1 campaign's init and before any VM boots, its units'
 * leases sum to no more than the granted window cap, and every unit carries that cap. Keyless: no VM, no ledger, no
 * provider.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bg1LaunchProblems } from '../../eval/runner/bg1/launch.ts';
import { bg1CampaignManifest, loadCellManifest } from '../../eval/runner/q1/cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { runCells } from '../../eval/runner/scoreboard-cli.ts';
import type { CampaignManifest } from '../../eval/runner/shootout-cell.ts';

const REPO = resolve(import.meta.dir, '../..');
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'bg1-launch-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const UNITS = ['bg1.baseline-none.baseline.c0', 'bg1.baseline-none.baseline.c1', 'bg1.gbrain-defaults.rs1-stable.c0'];
/** A BG1 campaign over UNITS whose window cap is `cap` (null: exactly the units' summed leases), written with a ledger outside the checkout. */
function campaign(cap: number | null, edit: (m: CampaignManifest) => void = () => {}) {
  const m = loadCellManifest('bg1');
  const sel = (usd: number) => ({ campaign_id: 'q1-scoreboard-bg1-launch-t', cap_usd: usd, units: UNITS, paid_window: 'BG1-T' });
  const sum = bg1CampaignManifest(m, { units: sel(1000), worldEnd: '2026-11-15' }).cells.reduce((n, c) => n + c.lease_usd, 0);
  const dir = scratch();
  const manifest = { ...bg1CampaignManifest(m, { units: sel(cap ?? Math.round(sum * 100) / 100), worldEnd: '2026-11-15' }), ledger: join(dir, 'campaign.sqlite') } as unknown as CampaignManifest;
  edit(manifest);
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(manifest, null, 2));
  return { manifest, sum, file: join(dir, 'campaign.json'), state: join(dir, 'state'), dir };
}

describe('a BG1 campaign before any VM boots', () => {
  // Value: protects=a BG1 campaign's units fit their one granted window before the first VM boots, so it never launches partway and stops on the cap; fails_when=summed leases above the window cap, or a unit carrying another window cap, reach init, reserve or a boot; why_new=#398 open note 5 (the Captain's condition 2); seam=bg1CampaignManifest over the committed bg1-cells.json, runCells with a runner that records boots, shootout-cell.ts init and reserve; no_claim=the ledger's own cap, which still stops a reservation
  test('summed leases above the window cap, or a unit carrying another cap, refuse before init in run, init and reserve; leases at the cap pass', async () => {
    const fits = campaign(null);
    expect(fits.sum).toBeGreaterThan(0);
    expect(bg1LaunchProblems(fits.manifest)).toEqual([]);
    expect(bg1LaunchProblems({ ...fits.manifest, cells: fits.manifest.cells.map(c => ({ ...c, benchmark: 'beam-rs1' })), cap_usd: 1 })).toEqual([]);

    const over = campaign(Math.floor(fits.sum * 100) / 100 - 0.01);
    expect(bg1LaunchProblems(over.manifest)).toEqual([`the 3 unit leases sum to ${Math.round(fits.sum * 100) / 100}, above the window cap ${over.manifest.cap_usd}`]);
    const other = campaign(null, m => { m.cells[1].command = m.cells[1].command.replace(/--window-cap-usd \S+/, '--window-cap-usd 9999'); });
    expect(bg1LaunchProblems(other.manifest)).toEqual([`unit ${other.manifest.cells[1].id} carries --window-cap-usd 9999, not the campaign's cap_usd ${other.manifest.cap_usd}`]);
    const none = campaign(null, m => { m.cells[2].command = m.cells[2].command.replace(/ --window-cap-usd \S+/, ''); });
    expect(bg1LaunchProblems(none.manifest)).toEqual([`unit ${none.manifest.cells[2].id} carries --window-cap-usd nowhere, not the campaign's cap_usd ${none.manifest.cap_usd}`]);

    for (const c of [over, other]) {
      const boots: string[] = [];
      const e = await runCells(['--campaign', c.file, '--state', c.state, '--cells', UNITS.join(','), '--sealed'], { runner: async (_argv, ctx) => { boots.push(ctx.cell.id); throw new Error('no VM boots in this test'); } }).then(() => null, x => x);
      expect(e).toBeInstanceOf(ScoreboardError);
      expect((e as ScoreboardError).op).toMatchObject({ code: 'PREFLIGHT_FAILED', message: expect.stringContaining('refused before any VM boots') });
      expect(boots).toEqual([]);
      for (const cmd of [['init'], ['reserve', '--cell', UNITS[0]]]) {
        const r = spawnSync('bun', ['eval/runner/shootout-cell.ts', ...cmd, '--campaign', c.file, '--state', c.state], { cwd: REPO, encoding: 'utf8' });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('refused before any VM boots');
      }
      expect(existsSync(join(c.state, 'campaign.json'))).toBe(false);
      expect(readdirSync(c.dir).filter(f => f.startsWith('campaign.sqlite'))).toEqual([]);
    }
  }, 60_000);
});
