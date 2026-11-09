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
import { createHash } from 'node:crypto';
import { closeLedgers, ledgerTestHooks, readLedger } from '../../eval/runner/budget-ledger.ts';
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

  // Value: protects=a BG1 campaign's units fit each block's cap before the first VM boots, so a window granted above a block's cap never launches partway and stops on the block cap; fails_when=a block's units lease more than its cap_usd and still reach init, reserve or a boot; why_new=GBEV-3's reading of bg1LaunchProblems (it summed leases against the window cap only, while reserve() also stops at a block's cap_usd); seam=bg1CampaignManifest over the committed bg1-cells.json with the campaign's block cap edited, runCells, shootout-cell.ts init and reserve; no_claim=bg1-cells.json's own block caps
  test('a block whose units lease more than its cap_usd refuses before init in run, init and reserve; leases at the block cap pass', async () => {
    const at = campaign(1000, m => { m.blocks!.BG1.cap_usd = Math.round(m.cells.reduce((n, c) => n + c.lease_usd, 0) * 100) / 100; });
    expect(bg1LaunchProblems(at.manifest)).toEqual([]);
    const over = campaign(1000, m => { m.blocks!.BG1.cap_usd = Math.round(m.cells.reduce((n, c) => n + c.lease_usd, 0) * 100) / 100 - 0.01; });
    expect(over.manifest.cap_usd).toBeGreaterThan(over.sum);
    expect(bg1LaunchProblems(over.manifest)).toEqual([`the 3 unit leases of block BG1 sum to ${Math.round(over.sum * 100) / 100}, above its cap_usd ${over.manifest.blocks!.BG1.cap_usd}`]);
    await refusedEverywhere(over);
  }, 60_000);

  // Value: protects=stage 1 can launch: its seven smoke units' leases fit BG1-S1's cap in the launch check; fails_when=the committed stage 1 cap sits below the leases campaignCells prices for its smoke units (twice each estimate), so the check refuses stage 1 before any unit boots; why_new=the preregistration's Amendment 1 (stage 1's cap); seam=bg1CampaignManifest over the committed bg1-cells.json's smoke units at BG1-S1's cap; no_claim=what stage 1 spends
  test('stage 1\'s seven smoke units, at BG1-S1\'s cap, pass the launch check', () => {
    const m = loadCellManifest('bg1');
    const units = (m.smoke_cells ?? []).map(c => c.id);
    const cap = m.blocks.find(b => b.id === 'BG1-S1')!.cap_usd;
    const stage1 = bg1CampaignManifest(m, { smoke: true, units: { campaign_id: 'q1-scoreboard-bg1-stage1-t', cap_usd: cap, units, paid_window: 'BG1-S1-T' }, worldEnd: '2026-11-15' }) as unknown as CampaignManifest;
    expect(units).toHaveLength(7);
    expect(stage1.cells.map(c => c.id).sort()).toEqual([...units].sort());
    expect(stage1.cells.every(c => c.block === 'BG1-S1')).toBe(true);
    expect(stage1.blocks!['BG1-S1'].cap_usd).toBeGreaterThanOrEqual(stage1.cells.reduce((n, c) => n + c.lease_usd, 0));
    expect(bg1LaunchProblems(stage1)).toEqual([]);
  });

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

  // Value: protects=a BG1 unit's proxy is handed only the lease the frozen campaign prices and the ledger reserved; fails_when=a reserved event forged with its leases.sha256 rewritten reaches payload or launch, or a lease log deleted with its SHA-256 reads as no leases while the ledger holds one; why_new=the exception-14 reader's finding 2 (it forged a reserved event's usd, rewrote the SHA-256, and payload().lease_usd came back forged; deleting both files went unnoticed); seam=a BG1 Campaign over a temporary ledger; no_claim=the frozen campaign hash, which already refuses an edited manifest
  test('a BG1 lease forged together with its SHA-256 refuses in payload and launch, and a lease log deleted with it refuses while the ledger holds a reservation', async () => {
    const w = campaign(null);
    const c = new Campaign(w.file, w.state);
    c.init();
    const l = c.reserve(c.manifest.cells[0].id);
    const log = join(w.state, 'leases.ndjson'), shaFile = join(w.state, 'leases.sha256'), text = readFileSync(log, 'utf8'), sha = readFileSync(shaFile, 'utf8');
    const forge = (from: string, to: string) => { const t = text.replace(from, to); expect(t).not.toBe(text); writeFileSync(log, t); writeFileSync(shaFile, createHash('sha256').update(t).digest('hex') + '\n'); return c.leases()[0]; };
    const boots: string[] = [];
    const runner = async () => { boots.push('booted'); return 0; };

    const usd = forge(`"usd":${l.usd}`, '"usd":399');
    expect(usd.usd).toBe(399);
    expect(caught(() => c.payload(usd)).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining(`leases 399, and the frozen campaign gives unit ${l.cell} ${l.usd}`) });
    const launched = await c.launch(l.cell, runner).then(() => null, x => x);
    expect(launched).toBeInstanceOf(ScoreboardError);
    expect((launched as ScoreboardError).op.code).toBe('CAMPAIGN_HASH_MISMATCH');
    expect(caught(() => c.payload(forge('"max_output_tokens":null', '"max_output_tokens":999999'))).op.message).toContain('caps output at 999999');
    expect(caught(() => c.payload(forge(`"entry_id":"${l.entry_id}"`, '"entry_id":"00000000-0000-4000-8000-000000000000"'))).op.message).toContain('names ledger entry 00000000-0000-4000-8000-000000000000');
    expect(boots).toEqual([]);
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x).event)).toEqual(['reserved']);

    writeFileSync(log, text);
    writeFileSync(shaFile, sha);
    expect(c.payload(c.leases()[0]).lease_usd).toBe(l.usd);
    rmSync(log);
    rmSync(shaFile);
    expect(caught(() => c.leases()).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining('is missing, and the campaign ledger holds 1 reservation(s)') });
    expect(caught(() => c.reserve(c.manifest.cells[1].id)).op.code).toBe('CAMPAIGN_HASH_MISMATCH');
    const s = JSON.parse(readFileSync(join(w.state, 'campaign.json'), 'utf8')) as { run_id: string };
    expect(readLedger(w.manifest.ledger).entries.filter(e => e.run_id === s.run_id).map(e => e.reserved_usd)).toEqual([l.usd]);
  }, 60_000);

  // Value: protects=a refused BG1 reserve leaves no ledger reservation the lease log does not name; fails_when=the lease log changes between reserve's read and its append, the append refuses, and the lease-sized ledger reservation stays charged; why_new=the exception-14 reader's finding 2 (reserve() refuses after this.run().reserve() succeeds); seam=ledgerTestHooks.afterCapCheck, inside the ledger's reserve, edits the log as an outside writer would; no_claim=a ledger the process cannot write
  test('a BG1 reserve whose append refuses gives its ledger reservation back', () => {
    const w = campaign(null);
    const c = new Campaign(w.file, w.state);
    c.init();
    const first = c.reserve(c.manifest.cells[0].id);
    const log = join(w.state, 'leases.ndjson'), text = readFileSync(log, 'utf8');
    ledgerTestHooks.afterCapCheck = () => writeFileSync(log, text + '\n');
    try { expect(caught(() => c.reserve(c.manifest.cells[1].id)).op.code).toBe('CAMPAIGN_HASH_MISMATCH'); }
    finally { delete ledgerTestHooks.afterCapCheck; }
    writeFileSync(log, text);
    const s = JSON.parse(readFileSync(join(w.state, 'campaign.json'), 'utf8')) as { run_id: string };
    const held = readLedger(w.manifest.ledger).entries.filter(e => e.run_id === s.run_id).reduce((n, e) => n + (e.actual_usd ?? e.reserved_usd), 0);
    expect(Math.round(held * 100) / 100).toBe(first.usd);
    expect(c.leases()).toEqual([first]);
  }, 60_000);

  // Value: protects=units the custodian runs in parallel on one --state never refuse each other's lease log or leave a stale SHA-256; fails_when=append's check, append, re-read and SHA-256 write interleave across processes with no lock; why_new=the exception-14 reader's finding 2 (the race, read from code: one detached run --cell per unit on one --state); seam=three processes reserving and abandoning their own unit on one BG1 campaign; no_claim=the ledger's own serialisation, which already holds
  test('parallel BG1 reserves on one --state keep the lease log, its SHA-256 and the ledger in step', async () => {
    const w = campaign(100_000);
    new Campaign(w.file, w.state).init();
    const perRound = w.manifest.cells.reduce((n, c) => n + c.lease_usd, 0);
    const rounds = Math.min(25, Math.floor(w.manifest.blocks!.BG1.cap_usd / perRound));
    expect(rounds).toBeGreaterThanOrEqual(10);
    // Each process starts its rounds at the same instant and reads the lease log between its reserve and its abandon, as a status poll would.
    const script = `const { Campaign } = await import(${JSON.stringify(join(REPO, 'eval/runner/shootout-cell.ts'))});
const [file, state, unit, start] = process.argv.slice(-4);
const c = new Campaign(file, state);
await Bun.sleep(Math.max(0, Number(start) - Date.now()));
for (let i = 0; i < ${rounds}; i++) { const l = c.reserve(unit); for (let k = 0; k < 10; k++) c.leases(); c.abandon(l.lease_id, 'race test'); }`;
    const start = String(Date.now() + 4000);
    const kids = UNITS.map(id => Bun.spawn(['bun', '-e', script, w.file, w.state, id, start], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(kids.map(async k => ({ code: await k.exited, err: await new Response(k.stderr).text() })));
    expect(results.filter(r => r.code !== 0).map(r => r.err.split('\n').find(x => /^\w*Error: /.test(x)) ?? r.err.slice(-300))).toEqual([]);
    const c = new Campaign(w.file, w.state);
    const leases = c.leases();
    expect(leases.length).toBe(UNITS.length * rounds);
    expect(leases.every(l => l.status === 'abandoned')).toBe(true);
    const s = JSON.parse(readFileSync(join(w.state, 'campaign.json'), 'utf8')) as { run_id: string };
    const entries = readLedger(w.manifest.ledger).entries.filter(e => e.run_id === s.run_id);
    expect(entries.length).toBe(leases.length);
    expect(Math.round(entries.reduce((n, e) => n + (e.actual_usd ?? e.reserved_usd), 0) * 100)).toBe(Math.round(leases.reduce((n, l) => n + l.usd, 0) * 100));
  }, 60_000);
});
