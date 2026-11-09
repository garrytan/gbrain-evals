/**
 * A sealed BG1 launch unit's custody (eval/runner/shootout-cell.ts bg1CustodyPush): the custodian host pushes only the
 * unit's pinned worlds and the filled manifest, checked before any VM exists, names the unit's worlds in
 * GBRAIN_EVALS_BG1_UNIT, and the remote command wipes ~/custody/bg1 at teardown. Keyless: no VM, no provider, and the
 * world files are placeholder bytes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
import { bg1CampaignManifest, loadCellManifest } from '../../eval/runner/q1/cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { bg1CustodyPush, Campaign, runRemote, type CampaignManifest, type LeaseState } from '../../eval/runner/shootout-cell.ts';

const ROOT = resolve(import.meta.dir, '../..');
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'bg1-custody-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const caught = (fn: () => unknown): ScoreboardError => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e; throw e; } throw new Error('expected a ScoreboardError'); };

/** A custodian's BG1 set root: four kept worlds of placeholder bytes and a filled manifest pinning them. */
function custodySet() {
  const root = scratch();
  const ids = ['bg1-001', 'bg1-002', 'bg1-003', 'bg1-004'];
  const files = ids.flatMap(id => ['world.json', 'questions.json'].map(f => {
    const path = `worlds/${id}/${f}`;
    mkdirSync(join(root, 'worlds', id), { recursive: true });
    writeFileSync(join(root, path), `${id} ${f}`);
    return { path, sha256: sha(`${id} ${f}`) };
  }));
  const manifest = join(root, 'bg1-manifest.json');
  writeFileSync(manifest, JSON.stringify({ status: 'filled', files, kept: ids, n_final: null }));
  return { root, env: { GBRAIN_EVALS_BG1_SOURCE: root, GBRAIN_EVALS_BG1_MANIFEST: manifest } };
}

describe('a sealed BG1 unit\'s custody', () => {
  // Value: protects=a sealed BG1 counted unit's VM receives exactly its own unit's pinned worlds; fails_when=custodyPush has no BG1 branch (the VM gets no worlds), pushes other units' worlds, or pushes bytes the manifest does not pin; why_new=core review of #398 (custodyPush had no bg1 branch); seam=bg1CustodyPush and Campaign.custodyPush; no_claim=ubi-runner's push itself
  test('pushes only its unit\'s pinned worlds and the manifest, names them in GBRAIN_EVALS_BG1_UNIT, and refuses before any VM otherwise', () => {
    const s = custodySet();
    const unit3 = ['worlds/bg1-003/world.json', 'worlds/bg1-003/questions.json', 'worlds/bg1-004/world.json', 'worlds/bg1-004/questions.json'];
    expect(bg1CustodyPush(s.env, 'c', { index: 1, size: 2 })).toEqual({ source: s.root, dest: 'custody/bg1', list: [...unit3, 'bg1-manifest.json'],
      env: ['GBRAIN_EVALS_BG1_SOURCE=~/custody/bg1', 'GBRAIN_EVALS_BG1_MANIFEST=~/custody/bg1/bg1-manifest.json', 'GBRAIN_EVALS_BG1_UNIT=bg1-003,bg1-004'] });
    expect(bg1CustodyPush(s.env, 'c').list).toHaveLength(9);
    expect(caught(() => bg1CustodyPush({})).op).toMatchObject({ code: 'CUSTODY_REQUIRED', message: expect.stringMatching(/GBRAIN_EVALS_BG1_SOURCE is not set/) });
    expect(caught(() => bg1CustodyPush({ ...s.env, GBRAIN_EVALS_BG1_SOURCE: join(ROOT, 'eval') })).op.message).toMatch(/inside the repository/);
    expect(caught(() => bg1CustodyPush({ GBRAIN_EVALS_BG1_SOURCE: s.root })).op.message).toMatch(/GBRAIN_EVALS_BG1_MANIFEST is not set/);
    writeFileSync(join(s.root, 'worlds/bg1-001/world.json'), 'tampered');
    expect(bg1CustodyPush(s.env, 'c', { index: 1, size: 2 }).list).toEqual([...unit3, 'bg1-manifest.json']);
    expect(caught(() => bg1CustodyPush(s.env, 'c', { index: 0, size: 2 })).op.message).toMatch(/worlds\/bg1-001\/world\.json .*not the pinned bytes/);
    rmSync(join(s.root, 'worlds/bg1-004/questions.json'));
    expect(caught(() => bg1CustodyPush(s.env, 'c', { index: 1, size: 2 })).op.message).toMatch(/worlds\/bg1-004\/questions\.json .*missing/);
  });

  // Value: protects=the campaign tells the custodian which unit a sealed BG1 VM runs, so its push holds that unit's worlds; fails_when=a sealed unit has no bg1_unit, a dev unit gets one, or launchArgv pushes nothing; why_new=core review of #398; seam=bg1CampaignManifest and Campaign.launchArgv; no_claim=the VM side's verifyBg1Custody
  test('every sealed BG1 campaign unit carries its unit, and the campaign pushes its worlds to the VM', () => {
    const m = loadCellManifest('bg1');
    const sel = { campaign_id: 'q1-scoreboard-bg1-wave-a', cap_usd: 400, units: ['bg1.baseline-none.baseline.c0', 'bg1.gbrain-defaults.rs1-stable.c1'], paid_window: 'BG1-WA-CELLS' };
    const size = m.cells.find(c => c.id === 'bg1.baseline-none.baseline')!.kept_units!;
    const cells = bg1CampaignManifest(m, { units: sel, worldEnd: '2026-11-15' }).cells;
    expect(cells.map(c => [c.id, c.sealed, c.bg1_unit]).sort()).toEqual([['bg1.baseline-none.baseline.c0', true, { index: 0, size }], ['bg1.gbrain-defaults.rs1-stable.c1', true, { index: 1, size }]]);
    const dev = bg1CampaignManifest(m, { smoke: true, worldEnd: '2026-11-15', units: { ...sel, campaign_id: 'q1-scoreboard-bg1-stage1', units: ['bg1-dev3.baseline-none.baseline'] } }).cells;
    expect(dev.map(c => [c.sealed, c.bg1_unit])).toEqual([[false, undefined]]);

    const s = custodySet();
    const dir = scratch();
    const cell = { id: 'bg1.x.c1', system: 'baseline-none', benchmark: 'bg1', config: 'baseline', lease_usd: 5, command: 'true', block: 'BG1', sealed: true, vm: { size: 'standard-4' }, bg1_unit: { index: 1, size: 2 } };
    const manifest = { kind: 'q1-scoreboard-campaign', schema_version: 1, campaign_id: 'q1-scoreboard-bg1-t', cap_usd: 50, ledger: join(dir, 'campaign.sqlite'), executes: ['bun.lock'], images: {}, blocks: { BG1: { estimate_usd: 20, cap_usd: 30 } }, cells: [cell] } as unknown as CampaignManifest;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const c = new Campaign(join(dir, 'manifest.json'), join(dir, 'state'));
    expect(c.custodyPush('bg1.x.c1', s.env)).toEqual(bg1CustodyPush(s.env, join(dir, 'manifest.json'), { index: 1, size: 2 }));
    const saved = { ...process.env };
    Object.assign(process.env, s.env);
    try {
      const l: LeaseState = { lease_id: 'bg1.x.c1-a1-0000', cell: 'bg1.x.c1', attempt: 1, usd: 5, entry_id: 'e', max_output_tokens: null, status: 'reserved' };
      const argv = c.launchArgv(l, { vm: 'ubirun-test-1-abc' });
      const push = argv[argv.indexOf('--push') + 1];
      expect(push.startsWith(`${s.root}:custody/bg1:`)).toBe(true);
      expect(readFileSync(push.split(':').at(-1)!, 'utf8').trim().split('\n')).toEqual(bg1CustodyPush(s.env, 'c', { index: 1, size: 2 }).list);
      expect(argv.flatMap((x, i) => (x === '--env' ? [argv[i + 1]] : []))).toContain('GBRAIN_EVALS_BG1_UNIT=bg1-003,bg1-004');
    } finally { for (const k of Object.keys(s.env)) if (!(k in saved)) delete process.env[k]; }
  });

  // Value: protects=a sealed BG1 VM holds no worlds after its cell ends; fails_when=the teardown wipe leaves ~/custody/bg1; why_new=core review of #398; seam=runRemote's teardown; no_claim=VM deletion
  test('the remote command wipes the pushed ~/custody/bg1 at teardown', async () => {
    const base = scratch();
    const out = join(base, 'out', 'bg1.x.c1', 'lease-b');
    mkdirSync(join(base, 'bg1'), { recursive: true });
    writeFileSync(join(base, 'bg1', 'f'), 'x');
    const exit = await runRemote({ lease_id: 'lease-b', lease_usd: 0.1, out, cell: 'bg1.x.c1', sealed: true, command: '[ -f "$SHOOTOUT_CUSTODY/../bg1/f" ] || exit 9' }, { port: await freePort(0), custodyBase: base });
    expect(exit).toBe(0);
    expect(existsSync(join(base, 'bg1'))).toBe(false);
  }, 30_000);
});
