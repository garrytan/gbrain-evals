/**
 * BG1's launch check (eval/runner/bg1/launch.ts): before a BG1 campaign's init and before any VM boots, its units'
 * leases sum to no more than the granted window cap, and every unit carries that cap. Keyless: no VM, no ledger, no
 * provider.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { BudgetRun, closeLedgers, ledgerTestHooks, readLedger } from '../../eval/runner/budget-ledger.ts';
import { bg1LaunchProblems } from '../../eval/runner/bg1/launch.ts';
import { bg1CampaignManifest, loadCellManifest } from '../../eval/runner/q1/cell.ts';
import { raise } from '../../eval/runner/q1/raise-lease.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { runCells } from '../../eval/runner/scoreboard-cli.ts';
import { Campaign, type CampaignManifest, type LaunchContext } from '../../eval/runner/shootout-cell.ts';

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
/** A stage-1 BG1 campaign over one smoke unit at BG1-S1's cap, written with a ledger outside the checkout. */
function smokeCampaign(unit: string) {
  const m = loadCellManifest('bg1');
  const cap = m.blocks.find(b => b.id === 'BG1-S1')!.cap_usd;
  const dir = scratch();
  const manifest = { ...bg1CampaignManifest(m, { smoke: true, units: { campaign_id: 'q1-scoreboard-bg1-smoke-t', cap_usd: cap, units: [unit], paid_window: 'BG1-S1-T' }, worldEnd: '2026-11-15' }), ledger: join(dir, 'campaign.sqlite') } as unknown as CampaignManifest;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifest, unit, file: join(dir, 'manifest.json'), state: join(dir, 'state') };
}

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
    expect(caught(() => c.payload(l)).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining(`ledger entry ${l.entry_id} ("lease ${l.cell} attempt 1") has spend, and 0 reserved events in the lease log name it`) });
    expect(caught(() => c.reserve(c.manifest.cells[1].id)).op.code).toBe('CAMPAIGN_HASH_MISMATCH');
    const s = JSON.parse(readFileSync(join(w.state, 'campaign.json'), 'utf8')) as { run_id: string };
    expect(readLedger(w.manifest.ledger).entries.filter(e => e.run_id === s.run_id).map(e => e.reserved_usd)).toEqual([l.usd]);
  }, 60_000);

  // Value: protects=one ledger entry backs one BG1 lease, so one reservation never boots two VMs; fails_when=a reserved event forged into the lease log with its SHA-256 rewritten names another lease's still-open ledger entry, and launch boots a second VM on it; why_new=the Opus fix-check on 12256467..806fc1ba, finding 2 (its probe on bg1-dev3.gbrain-defaults.rs1-stable); seam=a stage-1 BG1 Campaign over a temporary ledger, launched locally with a runner that records boots; no_claim=a real VM or proxy
  test('a reserved event forged onto another lease\'s open ledger entry refuses in launch and payload, so no second VM boots on one entry', async () => {
    const w = smokeCampaign('bg1-dev3.gbrain-defaults.rs1-stable');
    const c = new Campaign(w.file, w.state);
    c.init();
    const first = c.reserve(w.unit);
    const boots: string[] = [];
    const runner = async (_argv: string[], ctx: LaunchContext) => { boots.push(ctx.lease.lease_id); return 0; };
    const local = { local: { port: 1 } };
    expect((await c.launch(w.unit, runner, local)).status).toBe('finished');
    expect(boots).toEqual([first.lease_id]);
    const log = join(w.state, 'leases.ndjson'), shaFile = join(w.state, 'leases.sha256'), text = readFileSync(log, 'utf8'), sha = readFileSync(shaFile, 'utf8');
    const forge = (leaseId: string, attempt: number) => {
      const t = text + JSON.stringify({ event: 'reserved', lease_id: leaseId, cell: w.unit, attempt, usd: first.usd, entry_id: first.entry_id, at: new Date().toISOString(), max_output_tokens: first.max_output_tokens }) + '\n';
      writeFileSync(log, t);
      writeFileSync(shaFile, createHash('sha256').update(t).digest('hex') + '\n');
      const l = c.leases().find(x => x.status === 'reserved');
      expect(l?.lease_id).toBe(leaseId);
      return l!;
    };
    const shared = `names ledger entry ${first.entry_id}, which 2 reserved events in the lease log name`;
    for (const [leaseId, attempt, why] of [
      [`${w.unit}-a2-${first.entry_id.slice(0, 8)}`, 2, `which the ledger holds for "lease ${w.unit} attempt 1", not "lease ${w.unit} attempt 2"`],
      [`${w.unit}-a1-forged00`, 1, shared],
      [first.lease_id, 1, shared],
    ] as const) {
      const forged = forge(leaseId, attempt);
      const launched = await c.launch(w.unit, runner, local).then(() => null, x => x);
      expect(boots).toEqual([first.lease_id]);
      expect(launched).toBeInstanceOf(ScoreboardError);
      expect((launched as ScoreboardError).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining(why) });
      expect(caught(() => c.payload(forged)).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining(shared) });
      writeFileSync(log, text);
      writeFileSync(shaFile, sha);
    }
    const s = JSON.parse(readFileSync(join(w.state, 'campaign.json'), 'utf8')) as { run_id: string };
    expect(readLedger(w.manifest.ledger).entries.filter(e => e.run_id === s.run_id).map(e => e.description)).toEqual([`lease ${w.unit} attempt 1`]);
    expect(c.leases().map(l => [l.lease_id, l.status])).toEqual([[first.lease_id, 'finished']]);
  }, 60_000);

  // Value: protects=every reservation the BG1 campaign run holds stays one lease in the log, so a unit is never reserved twice and blockSpend never undercounts; fails_when=a lease log emptied or cut down with its SHA-256 rewritten, or one naming an entry the run does not hold, still reaches reserve, payload, launch or resume, or a refused reserve leaves a reservation; why_new=the Opus fix-check on 12256467..806fc1ba, finding 3 (its probe: two "lease ...c0 attempt 1" entries in the ledger, blockSpend reading one); seam=a BG1 Campaign over a temporary ledger, launched locally with a runner that records boots; no_claim=a real VM or proxy
  test('a lease log emptied, cut down or naming an unheld entry, with its SHA-256 rewritten, refuses reserve, payload, launch and resume, and leaks no reservation', async () => {
    const w = campaign(null);
    const c = new Campaign(w.file, w.state);
    c.init();
    const a = c.reserve(UNITS[0]), b = c.reserve(UNITS[1]);
    const log = join(w.state, 'leases.ndjson'), shaFile = join(w.state, 'leases.sha256'), text = readFileSync(log, 'utf8'), sha = readFileSync(shaFile, 'utf8');
    const write = (t: string) => { writeFileSync(log, t); writeFileSync(shaFile, createHash('sha256').update(t).digest('hex') + '\n'); };
    const s = JSON.parse(readFileSync(join(w.state, 'campaign.json'), 'utf8')) as { run_id: string };
    const held = () => readLedger(w.manifest.ledger).entries.filter(e => e.run_id === s.run_id).map(e => e.description);
    const before = held();
    expect(before).toEqual([`lease ${UNITS[0]} attempt 1`, `lease ${UNITS[1]} attempt 1`]);
    const boots: string[] = [];
    const runner = async (_argv: string[], ctx: LaunchContext) => { boots.push(ctx.lease.lease_id); return 0; };
    const local = { local: { port: 1 } };
    const unnamed = (l: typeof a) => `ledger entry ${l.entry_id} ("lease ${l.cell} attempt 1") has spend, and 0 reserved events in the lease log name it`;
    const phantom = JSON.stringify({ event: 'reserved', lease_id: `${UNITS[2]}-a1-00000000`, cell: UNITS[2], attempt: 1, usd: a.usd, entry_id: '00000000-0000-4000-8000-000000000000', at: new Date().toISOString(), max_output_tokens: a.max_output_tokens }) + '\n';
    const cases: Array<[string, string, string]> = [
      ['', UNITS[0], unnamed(a)],
      [text.split('\n').filter(x => !x.includes(a.lease_id)).join('\n'), UNITS[0], unnamed(a)],
      [text + phantom, UNITS[2], `lease ${UNITS[2]}-a1-00000000 names ledger entry 00000000-0000-4000-8000-000000000000, which campaign run ${s.run_id} does not hold`],
    ];
    for (const [t, unit, why] of cases) {
      write(t);
      const reserved = (() => { try { return c.reserve(unit); } catch (e) { return e; } })();
      expect(held()).toEqual(before);
      expect(reserved).toBeInstanceOf(ScoreboardError);
      expect((reserved as ScoreboardError).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining(why) });
      const entryPoints: Array<() => Promise<unknown>> = [() => c.launch(UNITS[1], runner, local), () => c.resume(unit, runner, local)];
      for (const go of entryPoints) {
        const e = await go().then(() => null, x => x);
        expect(boots).toEqual([]);
        expect(e).toBeInstanceOf(ScoreboardError);
        expect((e as ScoreboardError).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining(why) });
      }
      expect(caught(() => c.payload(b)).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining(why) });
      expect(held()).toEqual(before);
    }
    writeFileSync(log, text);
    writeFileSync(shaFile, sha);
    expect(c.payload(b).lease_usd).toBe(b.usd);
    expect((await c.launch(UNITS[1], runner, local)).status).toBe('finished');
    expect(boots).toEqual([b.lease_id]);
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


  // Value: protects=one BG1 reservation boots one VM; fails_when=a lease launched once, its lease log and leases.sha256 put back to their post-reserve copies, launches again and boots a second VM on the same ledger entry; why_new=GBEV-3's fix set 3, item 2 (launch read the lease as reserved outside leases.lock, so only the log marked a lease used); seam=a stage-1 BG1 Campaign over a temporary ledger, launched locally with a runner that records boots; no_claim=a results directory removed by hand along with the log, or a real VM
  test('a lease launched once, with its log and SHA-256 restored to their post-reserve copies, refuses a second launch and boots nothing more', async () => {
    const w = smokeCampaign('bg1-dev3.gbrain-defaults.rs1-stable');
    const c = new Campaign(w.file, w.state);
    c.init();
    const l = c.reserve(w.unit);
    const log = join(w.state, 'leases.ndjson'), shaFile = join(w.state, 'leases.sha256'), text = readFileSync(log, 'utf8'), sha = readFileSync(shaFile, 'utf8');
    const boots: string[] = [], lockHeld: boolean[] = [];
    const runner = async (_argv: string[], ctx: LaunchContext) => { boots.push(ctx.lease.lease_id); lockHeld.push(existsSync(join(w.state, 'leases.lock'))); return 0; };
    const local = { local: { port: 1 } };
    expect((await c.launch(w.unit, runner, local)).status).toBe('finished');
    expect([boots, lockHeld]).toEqual([[l.lease_id], [false]]);
    writeFileSync(log, text);
    writeFileSync(shaFile, sha);
    expect(c.leases().map(x => [x.lease_id, x.status])).toEqual([[l.lease_id, 'reserved']]);
    const again = await c.launch(w.unit, runner, local).then(() => null, x => x);
    expect(boots).toEqual([l.lease_id]);
    expect(again).toBeInstanceOf(ScoreboardError);
    expect((again as ScoreboardError).op).toMatchObject({ code: 'LEASE_STATE', message: expect.stringContaining(`lease ${l.lease_id} (ledger entry ${l.entry_id}) already has a results directory`), fix: { next: 'ask_user' } });
    expect(readFileSync(log, 'utf8')).toBe(text);
  }, 60_000);

  // Value: protects=one BG1 reservation boots one VM when a unit is started twice at once; fails_when=two processes launching one lease both read it as reserved and both boot; why_new=GBEV-3's fix set 3, item 2; seam=two processes launching one stage-1 BG1 lease locally on one --state at the same instant, each with a runner that records its boot; no_claim=a real VM
  test('two processes launching one BG1 lease at once boot it once, and the other refuses', async () => {
    const w = smokeCampaign('bg1-dev3.gbrain-defaults.rs1-stable');
    const c = new Campaign(w.file, w.state);
    c.init();
    const l = c.reserve(w.unit);
    const bootsFile = join(dirname(w.state), 'boots.txt');
    const script = `const { Campaign } = await import(${JSON.stringify(join(REPO, 'eval/runner/shootout-cell.ts'))});
const { appendFileSync } = await import('node:fs');
const [file, state, unit, boots, start] = process.argv.slice(-5);
const c = new Campaign(file, state);
await Bun.sleep(Math.max(0, Number(start) - Date.now()));
try { await c.launch(unit, async (_argv, ctx) => { appendFileSync(boots, ctx.lease.lease_id + '\\n'); await Bun.sleep(1000); return 0; }, { local: { port: 1 } }); console.log('booted'); }
catch (e) { console.log('refused: ' + (e.op?.code ?? e.message)); }`;
    const start = String(Date.now() + 4000);
    const kids = [0, 1].map(() => Bun.spawn(['bun', '-e', script, w.file, w.state, w.unit, bootsFile, start], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' }));
    const outs = await Promise.all(kids.map(async k => ({ code: await k.exited, out: (await new Response(k.stdout).text()).trim(), err: await new Response(k.stderr).text() })));
    expect(outs.map(o => [o.code, o.err.split('\n').find(x => /^\w*Error: /.test(x)) ?? null])).toEqual([[0, null], [0, null]]);
    expect(outs.map(o => o.out.split(':')[0]).sort()).toEqual(['booted', 'refused']);
    expect(readFileSync(bootsFile, 'utf8')).toBe(`${l.lease_id}\n`);
    expect(c.leases().map(x => [x.lease_id, x.status])).toEqual([[l.lease_id, 'finished']]);
    expect(readFileSync(join(w.state, 'leases.ndjson'), 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x).event)).toEqual(['reserved', 'launched', 'finished']);
  }, 60_000);

  // Value: protects=the launch claim strands no BG1 lease; fails_when=a lease launched under it can no longer settle, abandon at its full charge or at 0, resume as a repeat, be raised in place, or be settled by reattach; why_new=GBEV-3's fix set 3, item 2; seam=a stage-1 BG1 Campaign over a temporary ledger, launched locally and on a named VM with runners that record boots, raise-lease against a VM ledger in a scratch home, reattach.ts --once with a scripted UBI_RUNNER; no_claim=a real VM, ssh or pull
  test('after a BG1 reserve and launch, settle, both kinds of abandon, resume (repeat), raise-lease and reattach still close leases', async () => {
    const w = smokeCampaign('bg1-dev3.gbrain-defaults.rs1-stable');
    const c = new Campaign(w.file, w.state);
    c.init();
    const root = dirname(w.state);
    const s = JSON.parse(readFileSync(join(w.state, 'campaign.json'), 'utf8')) as { run_id: string };
    const entry = (id: string) => readLedger(w.manifest.ledger).entries.find(e => e.id === id && e.run_id === s.run_id);
    const summary = (dir: string, leaseId: string, usd: number, spent: number) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'lease-summary.json'), JSON.stringify({ run_id: leaseId, lease_usd: usd, committed_usd: spent, requests: 3 })); };
    const boots: string[] = [];
    const exits = (code: number, during: (ctx: LaunchContext) => void = () => {}) => async (_argv: string[], ctx: LaunchContext) => { boots.push(ctx.lease.lease_id); during(ctx); return code; };
    const local = { local: { port: 1 } };

    const a = c.reserve(w.unit);
    expect(await c.launch(w.unit, exits(0, ctx => summary(ctx.resultsDir, a.lease_id, a.usd, 0.25)), local)).toMatchObject({ status: 'settled', actual_usd: 0.25 });
    expect(entry(a.entry_id)).toMatchObject({ actual_usd: 0.25, status: 'reconciled' });

    const b = c.reserve(w.unit);
    expect((await c.launch(w.unit, exits(1), local)).status).toBe('finished');
    expect(c.abandon(b.lease_id, 'VM lost')).toMatchObject({ status: 'abandoned', actual_usd: b.usd });
    expect(entry(b.entry_id)).toMatchObject({ actual_usd: b.usd, status: 'charged-reservation' });

    const resumed = await c.resume(w.unit, exits(1), local);
    expect([resumed.mode, resumed.lease.status]).toEqual(['repeat', 'finished']);
    const launchLog = join(root, 'launch.log');
    writeFileSync(launchLog, 'ubi-runner: provisioning\n');
    expect(c.abandon(resumed.lease.lease_id, 'died in setup', { log: launchLog })).toMatchObject({ status: 'abandoned', actual_usd: 0 });
    expect(entry(resumed.lease.entry_id)).toMatchObject({ actual_usd: 0 });

    const home = join(root, 'vm-home');
    const ssh = (_vm: string, command: string) => { const p = Bun.spawnSync(['bash', '-c', command], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' }); return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }; };
    const d = c.reserve(w.unit);
    const vmLedger = join(home, 'custody', d.lease_id, 'proxy', 'lease.sqlite');
    const owner = process.env.UBI_OWNER;
    process.env.UBI_OWNER = 'bg1test';
    try {
      expect(await c.launch(w.unit, exits(255, () => {
        mkdirSync(dirname(vmLedger), { recursive: true });
        BudgetRun.openLease({ runId: d.lease_id, leaseUsd: d.usd, ledgerPath: vmLedger });
        expect(raise(c, d.lease_id, d.usd + 0.5, 'owner approved', ssh)).toMatchObject({ from_usd: d.usd, to_usd: d.usd + 0.5, vm_ledger: vmLedger });
      }))).toMatchObject({ status: 'finished', exit_code: 255, raised_usd: d.usd + 0.5 });
    } finally { if (owner === undefined) delete process.env.UBI_OWNER; else process.env.UBI_OWNER = owner; }
    expect(entry(d.entry_id)).toMatchObject({ reserved_usd: d.usd + 0.5, actual_usd: null });

    const fake = join(root, 'ubi-runner.sh'), pulled = join(root, 'pulled-summary.json');
    writeFileSync(pulled, JSON.stringify({ run_id: d.lease_id, lease_usd: d.usd, committed_usd: 0.6, requests: 4 }));
    writeFileSync(fake, 'case "$1" in\n  ssh) echo "state 0 0 1 1 0" ;;\n  pull) mkdir -p "$4/$(basename "$3")" && cp "$BG1_TEST_SUMMARY" "$4/$(basename "$3")/lease-summary.json" ;;\n  down) ;;\n  *) exit 9 ;;\nesac\n');
    const re = spawnSync('bun', ['eval/runner/q1/reattach.ts', '--campaign', w.file, '--state', w.state, '--once'], { cwd: REPO, env: { ...process.env, UBI_RUNNER: fake, BG1_TEST_SUMMARY: pulled }, encoding: 'utf8' });
    expect([re.status, JSON.parse(re.stdout.trim().split('\n').pop() ?? '{}')[w.unit]]).toEqual([0, 'settled']);
    expect(c.lease(d.lease_id)).toMatchObject({ status: 'settled', actual_usd: 0.6 });
    expect(entry(d.entry_id)).toMatchObject({ reserved_usd: d.usd + 0.5, actual_usd: 0.6, status: 'reconciled' });
    expect(boots).toEqual([a.lease_id, b.lease_id, resumed.lease.lease_id, d.lease_id]);
    expect(c.reserve(w.unit).attempt).toBe(5);
  }, 60_000);


  // Value: protects=the lease log and the campaign ledger agree on which BG1 leases are closed and at what, and one lease_id is one lease; fails_when=a lease log edited with its SHA-256 rewritten (a settle or abandon forged or cut, a settled amount changed, a lease_id reused) still reaches reserve, launch, resume or payload; why_new=GBEV-3's fix set 3, item 3 (#398 non-blocking notes 2 and 7); seam=a BG1 Campaign over a temporary ledger, launched locally with a runner that records boots; no_claim=a ledger edited by hand
  test('a lease log whose closed or open leases disagree with the ledger, or that reuses a lease_id, refuses reserve, launch, resume and payload', async () => {
    const w = campaign(null);
    const c = new Campaign(w.file, w.state);
    c.init();
    const boots: string[] = [];
    const runner = async (_argv: string[], ctx: LaunchContext) => {
      boots.push(ctx.lease.lease_id);
      if (ctx.cell.id === UNITS[0]) writeFileSync(join(ctx.resultsDir, 'lease-summary.json'), JSON.stringify({ run_id: ctx.lease.lease_id, lease_usd: ctx.lease.usd, committed_usd: 0.25, requests: 2 }));
      return 0;
    };
    const local = { local: { port: 1 } };
    const a = c.reserve(UNITS[0]);
    expect((await c.launch(UNITS[0], runner, local)).status).toBe('settled');
    const b = c.reserve(UNITS[1]);
    expect((await c.launch(UNITS[1], runner, local)).status).toBe('finished');
    const d = c.reserve(UNITS[2]);
    const log = join(w.state, 'leases.ndjson'), shaFile = join(w.state, 'leases.sha256'), text = readFileSync(log, 'utf8'), sha = readFileSync(shaFile, 'utf8');
    const write = (t: string) => { expect(t).not.toBe(text); writeFileSync(log, t); writeFileSync(shaFile, createHash('sha256').update(t).digest('hex') + '\n'); };
    const s = JSON.parse(readFileSync(join(w.state, 'campaign.json'), 'utf8')) as { run_id: string };
    const held = () => readLedger(w.manifest.ledger).entries.filter(e => e.run_id === s.run_id).map(e => [e.description, e.actual_usd]);
    const before = held();
    expect(before).toEqual([[`lease ${UNITS[0]} attempt 1`, 0.25], [`lease ${UNITS[1]} attempt 1`, null], [`lease ${UNITS[2]} attempt 1`, null]]);
    const event = (e: object) => JSON.stringify({ ...e, at: new Date().toISOString() }) + '\n';
    const cases: Array<[string, string, string]> = [
      [text + event({ event: 'settled', lease_id: b.lease_id, actual_usd: 0.01, requests: 1, max_output_tokens: null }), UNITS[1],
        `lease ${b.lease_id} is settled at 0.01 in the lease log, and the ledger holds its entry ${b.entry_id} open`],
      [text.split('\n').filter(x => !(x.includes('"event":"settled"') && x.includes(a.lease_id))).join('\n'), UNITS[0],
        `lease ${a.lease_id} is finished in the lease log, and the ledger settled its entry ${a.entry_id} at 0.25`],
      [text.replace('"actual_usd":0.25', '"actual_usd":0.05'), UNITS[0],
        `lease ${a.lease_id} is settled at 0.05 in the lease log, and the ledger settled its entry ${a.entry_id} at 0.25`],
      [text + event({ event: 'abandoned', lease_id: b.lease_id, reason: 'forged' }), UNITS[1],
        `lease ${b.lease_id} is abandoned at ${b.usd} in the lease log, and the ledger holds its entry ${b.entry_id} open`],
      [text.replace(`"lease_id":"${d.lease_id}"`, `"lease_id":"${b.lease_id}"`), UNITS[1],
        `is not the id reserve() gives attempt 1 of unit ${UNITS[2]} on ledger entry ${d.entry_id}, ${d.lease_id}`],
      [text + text.split('\n').find(x => x.includes('"event":"reserved"') && x.includes(b.lease_id)) + '\n', UNITS[1],
        `lease ${b.lease_id} is reserved 2 times in the lease log`],
    ];
    for (const [t, unit, why] of cases) {
      write(t);
      const entryPoints: Array<() => Promise<unknown>> = [() => c.launch(UNITS[2], runner, local), () => c.resume(unit, runner, local), async () => c.reserve(unit)];
      for (const go of entryPoints) {
        const e = await go().then(() => null, x => x);
        expect(boots).toEqual([a.lease_id, b.lease_id]);
        expect(held()).toEqual(before);
        expect(e).toBeInstanceOf(ScoreboardError);
        expect((e as ScoreboardError).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining(why) });
      }
      expect(caught(() => c.payload(d)).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining(why) });
    }
    writeFileSync(log, text);
    writeFileSync(shaFile, sha);
    expect((await c.launch(UNITS[2], runner, local)).status).toBe('finished');
    expect(boots).toEqual([a.lease_id, b.lease_id, d.lease_id]);
  }, 60_000);


  // Value: protects=a BG1 refusal over a lease log never sends the operator to restore an older log or its SHA-256, or to a fresh --state, while leases may be live; fails_when=the hash, reconcile, lease-binding or init refusal advises restoring leases.ndjson or leases.sha256, or starting over in a fresh --state, instead of stopping to ask, or names no lease and ledger entry; why_new=GBEV-3's fix set 3, item 4; seam=a BG1 Campaign over a temporary ledger with its lease log edited; no_claim=what the owner then decides
  test('every BG1 lease-log refusal says to stop and ask, and names the open leases and their ledger entries', () => {
    const w = campaign(null);
    const c = new Campaign(w.file, w.state);
    c.init();
    const l = c.reserve(UNITS[0]);
    const named = `lease ${l.lease_id} (ledger entry ${l.entry_id})`;
    const log = join(w.state, 'leases.ndjson'), shaFile = join(w.state, 'leases.sha256'), text = readFileSync(log, 'utf8');
    const forge = (t: string) => { writeFileSync(log, t); writeFileSync(shaFile, createHash('sha256').update(t).digest('hex') + '\n'); };
    const asks = (e: ScoreboardError, what: string, open: string) => {
      const said = e.op.fix.user_message ?? '';
      expect([e.op.code, e.op.fix.next]).toEqual(['CAMPAIGN_HASH_MISMATCH', 'ask_user']);
      expect(said).toStartWith('Stop and ask the campaign owner before anything else runs on ');
      expect(said).toContain(what);
      expect(said).toContain(`Leases the campaign ledger still holds open: ${open}. Do not restore an older leases.ndjson or leases.sha256, edit either file, or start the campaign in a fresh --state`);
      expect(said).not.toMatch(/restore it|custody host's copy|initialise the BG1 campaign in a fresh/);
    };

    writeFileSync(log, text + '\n');
    asks(caught(() => c.leases()), 'leases.ndjson changed outside the campaign', named);
    forge('');
    asks(caught(() => c.reserve(UNITS[1])), `${l.entry_id} ("lease ${UNITS[0]} attempt 1") has spend, and 0 reserved events in the lease log name it`, named);
    forge(text.replace(`"usd":${l.usd}`, '"usd":399'));
    asks(caught(() => c.payload(c.leases()[0])), `leases.ndjson hands out lease ${l.lease_id} (ledger entry ${l.entry_id}), which is not the lease the campaign reserved`, named);

    const planted = campaign(null);
    mkdirSync(planted.state, { recursive: true });
    writeFileSync(join(planted.state, 'leases.ndjson'), text);
    asks(caught(() => new Campaign(planted.file, planted.state).init()), `it holds a lease log naming ${named} but no campaign.json`, 'none (this --state has no campaign.json)');
    expect(existsSync(join(planted.state, 'campaign.json'))).toBe(false);
  }, 60_000);


  // Value: protects=one BG1 ledger entry boots one VM even when the lease log renames its lease; fails_when=a post-reserve log with the lease's id renamed and its SHA-256 rewritten claims a fresh results directory and boots a second VM on an entry that already launched; why_new=fix-check 3's blocker B1 (launch-once was keyed on the editable lease_id); seam=a stage-1 BG1 Campaign over a temporary ledger, launched locally with a runner that records boots; no_claim=a real VM
  test('a launched lease renamed in a restored lease log, with its SHA-256 rewritten, refuses a second launch on the same ledger entry', async () => {
    const w = smokeCampaign('bg1-dev3.gbrain-defaults.rs1-stable');
    const c = new Campaign(w.file, w.state);
    c.init();
    const l = c.reserve(w.unit);
    const log = join(w.state, 'leases.ndjson'), shaFile = join(w.state, 'leases.sha256'), text = readFileSync(log, 'utf8');
    const boots: string[] = [];
    const runner = async (_argv: string[], ctx: LaunchContext) => { boots.push(`${ctx.lease.lease_id}@${ctx.lease.entry_id}`); return 0; };
    const local = { local: { port: 1 } };
    expect((await c.launch(w.unit, runner, local)).status).toBe('finished');
    const renamed = text.split(`"lease_id":"${l.lease_id}"`).join(`"lease_id":"${l.lease_id}-x"`);
    expect(renamed).not.toBe(text);
    writeFileSync(log, renamed);
    writeFileSync(shaFile, createHash('sha256').update(renamed).digest('hex') + '\n');
    expect(c.leases().map(x => [x.lease_id, x.status])).toEqual([[`${l.lease_id}-x`, 'reserved']]);
    const why = `is not the id reserve() gives attempt 1 of unit ${w.unit} on ledger entry ${l.entry_id}, ${l.lease_id}`;
    const again = await c.launch(w.unit, runner, local).then(() => null, x => x);
    expect(boots).toEqual([`${l.lease_id}@${l.entry_id}`]);
    expect(again).toBeInstanceOf(ScoreboardError);
    expect((again as ScoreboardError).op).toMatchObject({ code: 'CAMPAIGN_HASH_MISMATCH', message: expect.stringContaining(`lease ${l.lease_id}-x: ${why}`) });
    expect((again as ScoreboardError).op.fix.user_message).toStartWith('Stop and ask the campaign owner');
    expect(existsSync(join(w.state, 'results', w.unit, `${l.lease_id}-x`))).toBe(false);
    const resumed = await c.resume(w.unit, runner, local).then(() => null, x => x);
    expect(resumed).toBeInstanceOf(ScoreboardError);
    expect((resumed as ScoreboardError).op.message).toContain(why);
    for (const go of [() => c.payload(c.leases()[0]), () => c.reserve(w.unit)]) expect(caught(go).op.message).toContain(why);
    expect(boots).toHaveLength(1);
    expect(readFileSync(log, 'utf8')).toBe(renamed);
  }, 60_000);
});
