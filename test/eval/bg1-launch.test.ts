/**
 * BG1's launch check (eval/runner/bg1/launch.ts): before a BG1 campaign's init and before any VM boots, its units'
 * leases sum to no more than the granted window cap, and every unit carries that cap. Keyless: no VM, no ledger, no
 * provider.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { bg1LaunchProblems } from '../../eval/runner/bg1/launch.ts';
import { bg1CampaignManifest, loadCellManifest } from '../../eval/runner/q1/cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { runCells } from '../../eval/runner/scoreboard-cli.ts';
import { Campaign, type CampaignManifest } from '../../eval/runner/shootout-cell.ts';

const REPO = resolve(import.meta.dir, '../..');
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'bg1-launch-')); roots.push(d); return d; };
afterAll(() => { closeLedgers(); for (const d of roots) rmSync(d, { recursive: true, force: true }); });
const caught = (fn: () => unknown): ScoreboardError => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e; throw e; } throw new Error('expected a ScoreboardError'); };

const UNITS = ['bg1.baseline-none.baseline.c0', 'bg1.baseline-none.baseline.c1', 'bg1.gbrain-defaults.rs1-stable.c0'];
/** A BG1 campaign over UNITS whose window cap is `cap` (null: exactly the units' summed leases), written with a ledger outside the checkout. */
function campaign(cap: number | null, edit: (m: CampaignManifest) => void = () => {}) {
  const m = loadCellManifest('bg1');
  const sel = (usd: number) => ({ campaign_id: 'q1-scoreboard-bg1-launch-t', cap_usd: usd, units: UNITS, paid_window: 'BG1-T' });
  const sum = bg1CampaignManifest(m, { units: sel(1000), worldEnd: '2026-11-15' }).cells.reduce((n, c) => n + c.lease_usd, 0);
  const dir = scratch();
  const manifest = { ...bg1CampaignManifest(m, { units: sel(cap ?? Math.round(sum * 100) / 100), worldEnd: '2026-11-15' }), ledger: join(dir, 'campaign.sqlite') } as unknown as CampaignManifest;
  edit(manifest);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifest, sum, file: join(dir, 'manifest.json'), state: join(dir, 'state'), dir };
}
type Written = ReturnType<typeof campaign>;

/** run, init and reserve all refuse the campaign before init: no boot, no campaign.json, no ledger. */
async function refusedEverywhere(c: Written) {
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

    for (const c of [over, other]) await refusedEverywhere(c);
  }, 60_000);

  // Value: protects=a BG1 unit's lease can only be the one pricing.ts gave it in bg1-cells.json; fails_when=a lease edited, added or missing in the campaign manifest before init freezes and reaches a unit; why_new=#398 open note 6 (the Captain's conditions 1 and 3; the fix-check's probe froze a lease edited to 399 before init); seam=bg1CampaignManifest over the committed bg1-cells.json, runCells, shootout-cell.ts init and reserve; no_claim=bg1-cells.json's own prices
  test('a lease edited, added or missing in the campaign manifest before init refuses in run, init and reserve; the priced leases pass', async () => {
    const priced = campaign(1000);
    expect(bg1LaunchProblems(priced.manifest)).toEqual([]);
    const id = priced.manifest.cells[0].id, lease = priced.manifest.cells[0].lease_usd;
    const edited = campaign(1000, m => { m.cells[0].lease_usd = 399; });
    expect(bg1LaunchProblems(edited.manifest)).toEqual([`unit ${id} leases 399, not the ${lease} bg1-cells.json prices it at`]);
    const added = campaign(1000, m => { m.cells.push({ ...m.cells[0], id: 'bg1.invented.c0' }); });
    expect(bg1LaunchProblems(added.manifest)).toEqual(['unit bg1.invented.c0 is not a unit of the committed bg1-cells.json']);
    const missing = campaign(1000, m => { delete (m.cells[0] as { lease_usd?: number }).lease_usd; });
    expect(bg1LaunchProblems(missing.manifest)).toContain(`unit ${id} leases undefined, not the ${lease} bg1-cells.json prices it at`);
    await refusedEverywhere(edited);
  }, 60_000);

  // Value: protects=a BG1 unit's proxy spends only the lease the ledger reserved for it; fails_when=a lease log edited after a reserve, or one planted before init, is read; why_new=#398 open note 6 (no hash covered leases.ndjson); seam=a BG1 Campaign over a temporary ledger; no_claim=a VM's own ledger
  test('a BG1 campaign keeps its lease log\'s SHA-256: a log edited after a reserve, a log gone, or one already there at init refuses', () => {
    const w = campaign(null);
    const c = new Campaign(w.file, w.state);
    c.init();
    const l = c.reserve(c.manifest.cells[0].id);
    expect(c.leases()).toEqual([l]);
    const log = join(w.state, 'leases.ndjson'), text = readFileSync(log, 'utf8'), forged = text.replace(`"usd":${l.usd}`, '"usd":399');
    expect(forged).not.toBe(text);
    writeFileSync(log, forged);
    expect(caught(() => c.leases()).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining('is not the lease log campaign') });
    expect(caught(() => c.reserve(c.manifest.cells[1].id)).op.code).toBe('CAMPAIGN_HASH_MISMATCH');
    writeFileSync(log, text);
    expect(c.leases()).toEqual([l]);
    rmSync(log);
    expect(caught(() => c.leases()).op.code).toBe('CAMPAIGN_HASH_MISMATCH');

    const planted = campaign(null);
    mkdirSync(planted.state, { recursive: true });
    writeFileSync(join(planted.state, 'leases.ndjson'), forged);
    expect(caught(() => new Campaign(planted.file, planted.state).init()).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining('holds a lease log before campaign') });
    expect(existsSync(join(planted.state, 'campaign.json'))).toBe(false);
  }, 60_000);
});
