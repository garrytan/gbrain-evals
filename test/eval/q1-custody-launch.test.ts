/**
 * A17: sealed Q1 launches from the custodian host. A sealed cell's VM gets a custody root and the custody access log,
 * writes outside its checkout and is pulled only into the custodian's state directory; a sealed BEAM-10M cell gets the
 * custodian's files pushed before setup, checked against the manifest on both ends. Doctor fails on each defect.
 * Every BEAM-10M file here is a synthetic stand-in.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { beam10mCustodyPush, Campaign, runRemote, type CampaignManifest, type LaunchContext, type LeaseState, type RemotePayload } from '../../eval/runner/shootout-cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { sealedLaunchChecks } from '../../eval/runner/scoreboard-cli.ts';
import { verifyBeam10mCustody } from '../../eval/runner/memory-qa/corpus.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'q1-custody-'));
const inRepo = join(ROOT, 'test/eval/fixtures/scoreboard', `tmp-custody-${process.pid}-${Date.now()}`);
mkdirSync(inRepo, { recursive: true });
const ENV_KEYS = ['GBRAIN_EVALS_BEAM10M_SOURCE', 'GBRAIN_EVALS_BEAM10M_MANIFEST', 'GBRAIN_EVALS_BEAM10M_ROOT', 'UBI_OWNER'] as const;
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV_KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); rmSync(inRepo, { recursive: true, force: true }); });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const caught = (fn: () => unknown): ScoreboardError => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e; throw e; } throw new Error('expected a ScoreboardError'); };
const payloadOf = (argv: string[]) => JSON.parse(Buffer.from(argv.at(-1)!.split('--cell-b64 ').at(-1)!, 'base64').toString('utf8')) as RemotePayload;
const after = (argv: string[], flag: string) => argv.flatMap((x, i) => x === flag ? [argv[i + 1]] : []);

/** A synthetic BEAM-10M stand-in: two conversations in the committed layout and a filled manifest inside the root. */
function standIn(name: string) {
  const root = join(tmp, name);
  const conversations = ['10m-a', '10m-b'].map(id => {
    const chat = JSON.stringify([{ 'plan-1': [{ batch_number: 1, time_anchor: 'March-15-2024', turns: [[{ role: 'user', id: 0, content: `SYNTHETIC ${id}` }]] }] }]);
    const questions = JSON.stringify({ synthetic: id });
    const c = { conversation: id, chat_path: `beam-10m/9b20961/${id}/chat.json`, chat_sha256: sha(chat), questions_path: `beam-10m/9b20961/${id}/questions.json`, questions_sha256: sha(questions) };
    for (const [p, body] of [[c.chat_path, chat], [c.questions_path, questions]] as const) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
    return c;
  });
  const manifest = join(root, 'stand-in-manifest.json');
  writeFileSync(manifest, JSON.stringify({ dataset: 'BEAM-10M stand-in', status: 'filled', conversations }));
  return { root, manifest, conversations };
}

let n = 0;
function campaign(cells: CampaignManifest['cells']) {
  const dir = join(tmp, `c${++n}`);
  mkdirSync(dir, { recursive: true });
  const exec = join(inRepo, `adapter-${n}.ts`);
  writeFileSync(exec, `export const adapter = ${n};\n`);
  const manifest: CampaignManifest = { kind: 'q1-scoreboard-campaign', schema_version: 1, campaign_id: 'q1-scoreboard', cap_usd: 50, ledger: join(dir, 'campaign.sqlite'),
    executes: [exec.slice(ROOT.length + 1), 'bun.lock'], images: { 'gbrain-defaults': `sha256:${'a'.repeat(64)}` }, blocks: { T1: { estimate_usd: 20, cap_usd: 30 } }, cells };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifestPath: join(dir, 'manifest.json'), state: join(dir, 'state') };
}
const S1 = { id: 's1-c0', system: 'gbrain-defaults', benchmark: 'beam-10m', config: 'shipped-defaults', lease_usd: 5, command: 'true', block: 'T1', sealed: true, vm: { size: 'standard-4' }, restore_command: 'true' };
const LOCOMO = { id: 's3-c0', system: 'gbrain-defaults', benchmark: 'locomo', config: 'shipped-defaults', lease_usd: 5, command: 'true', block: 'T1', sealed: true, restore_command: 'true' };
const PUBLIC = { id: 'lme-c0', system: 'gbrain-defaults', benchmark: 'lme-s', config: 'shipped-defaults', lease_usd: 5, command: 'true', block: 'T1' };
const lease = (cell: string): LeaseState => ({ lease_id: `${cell}-a1-0000`, cell, attempt: 1, usd: 5, entry_id: 'e', max_output_tokens: null, status: 'reserved' });

describe('defect 2: the sealed Q1 payload', () => {
  test('a sealed Q1 cell carries sealed:true and writes under ~/custody/out; its rows are pulled only into the state directory', () => {
    const a = campaign([LOCOMO, PUBLIC]);
    const c = new Campaign(a.manifestPath, a.state);
    const argv = c.launchArgv(lease('s3-c0'), { vm: 'ubirun-test-1-abc' });
    const p = payloadOf(argv);
    expect(p).toMatchObject({ sealed: true, out: '~/custody/out/s3-c0/s3-c0-a1-0000', cell: 's3-c0' });
    expect(after(argv, '--pull')).toEqual([`custody/out/s3-c0/s3-c0-a1-0000:${join(a.state, 'results', 's3-c0')}`]);
    expect(after(argv, '--push')).toEqual([]);
    const pub = c.launchArgv(lease('lme-c0'), { vm: 'ubirun-test-1-abd' });
    expect(payloadOf(pub).sealed).toBeUndefined();
    expect(payloadOf(pub).out).toBe('eval/reports/shootout/lme-c0/lme-c0-a1-0000');
    expect(after(pub, '--pull')[0]).toMatch(/^work\/[^/]+\/eval\/reports\/shootout\/lme-c0\/lme-c0-a1-0000:/);
  });

  test('on the VM a sealed Q1 payload gets SHOOTOUT_CUSTODY and GBRAIN_EVALS_CUSTODY_LOG inside its out; pushed custody files are wiped at teardown', async () => {
    const base = join(tmp, 'vm-custody');
    const out = join(base, 'out', 's3-c0', 'lease-x');
    for (const d of ['datasets', 'restore']) { mkdirSync(join(base, d), { recursive: true }); writeFileSync(join(base, d, 'f'), 'x'); }
    const port = 24000 + Math.floor(Math.random() * 9000);
    const code = await runRemote({ lease_id: 'lease-x', lease_usd: 0.1, out, cell: 's3-c0', sealed: true,
      command: 'printf "%s\\n%s\\n" "$SHOOTOUT_CUSTODY" "$GBRAIN_EVALS_CUSTODY_LOG" > "$SHOOTOUT_OUT/env.txt"; [ -f "$SHOOTOUT_CUSTODY/../datasets/f" ] || exit 9' }, { port, custodyBase: base });
    expect(code).toBe(0);
    expect(readFileSync(join(out, 'env.txt'), 'utf8').trim().split('\n')).toEqual([join(base, 'lease-x'), join(out, 'access-log.jsonl')]);
    expect(existsSync(join(base, 'datasets'))).toBe(false);
    expect(existsSync(join(base, 'restore'))).toBe(false);
    expect(existsSync(join(base, 'lease-x', 'proxy', 'lease.sqlite'))).toBe(true);
  }, 30_000);

  test('a sealed launch refuses a state directory inside the repository; resume restores through the custody push, never the checkout', async () => {
    process.env.UBI_OWNER = 'q1test';
    const bad = campaign([LOCOMO]);
    const inside = new Campaign(bad.manifestPath, join(inRepo, 'state'));
    inside.init();
    inside.reserve('s3-c0');
    const e = await (async () => { try { await inside.launch('s3-c0', async () => 0); } catch (x) { return x as ScoreboardError; } throw new Error('expected a refusal'); })();
    expect(e.op.code).toBe('SEALED_CELL_LOCAL');

    const a = campaign([LOCOMO]);
    const c = new Campaign(a.manifestPath, a.state);
    c.init();
    c.reserve('s3-c0');
    const first = await c.launch('s3-c0', async (_argv: string[], ctx: LaunchContext) => {
      expect(ctx.remoteOut).toBe(`custody/out/s3-c0/${ctx.lease.lease_id}`);
      mkdirSync(join(ctx.resultsDir, 'realization', 'snapshot'), { recursive: true });
      writeFileSync(join(ctx.resultsDir, 'realization', 'snapshot', 'store.tar'), 'store bytes');
      writeFileSync(join(ctx.resultsDir, 'realization', 'realization.json'), JSON.stringify({ realization_id: 'real-s3-c0-0123456789abcdef', cell: 's3-c0', lease_id: ctx.lease.lease_id, campaign_sha256: null, created_at: '', trigger: 'first-row',
        files: [{ path: 'store.tar', sha256: sha('store bytes'), bytes: 11 }], status: 'complete' }));
      const l = BudgetRun.openLease({ runId: ctx.lease.lease_id, leaseUsd: ctx.lease.usd, ledgerPath: join(ctx.resultsDir, 'lease.sqlite') });
      l.settle(l.reserve(1, 'vm'), { usd: 1 });
      closeLedgers();
      writeFileSync(join(ctx.resultsDir, 'lease-summary.json'), JSON.stringify({ run_id: ctx.lease.lease_id, lease_usd: ctx.lease.usd, committed_usd: 1, requests: 1, cell_exit_code: 0 }));
      return 0;
    });
    expect(first.realization_id).toBe('real-s3-c0-0123456789abcdef');
    let pushed: string[] = [];
    const r = await c.resume('s3-c0', async (argv: string[], ctx: LaunchContext) => {
      const p = payloadOf(argv);
      expect(p.restore).toMatchObject({ realization_id: 'real-s3-c0-0123456789abcdef', dir: '~/custody/restore' });
      pushed = after(argv, '--push');
      const [from] = pushed[0].split(':');
      expect(from.startsWith(join(a.state, 'restore'))).toBe(true);
      expect(readFileSync(join(from, 'realization', 'snapshot', 'store.tar'), 'utf8')).toBe('store bytes');
      const repoStage = join(ROOT, '.scoreboard-restore');
      expect(existsSync(repoStage) && readdirSync(repoStage).some(x => x.startsWith('s3-c0'))).toBe(false);
      writeFileSync(join(ctx.resultsDir, 'lease-summary.json'), JSON.stringify({ run_id: ctx.lease.lease_id, lease_usd: ctx.lease.usd, committed_usd: 0, requests: 0, cell_exit_code: 0 }));
      return 0;
    });
    expect(r.mode).toBe('snapshot');
    expect(pushed).toHaveLength(1);
    expect(pushed[0].endsWith(':custody/restore')).toBe(true);
    expect(existsSync(pushed[0].split(':')[0])).toBe(false);
  });
});

describe('defect 1: the BEAM-10M custody push', () => {
  test('the launcher checks every file against the manifest before any VM and pushes the list to ~/custody/datasets', () => {
    const s = standIn('push-ok');
    process.env.GBRAIN_EVALS_BEAM10M_SOURCE = s.root;
    process.env.GBRAIN_EVALS_BEAM10M_MANIFEST = s.manifest;
    const a = campaign([S1]);
    const c = new Campaign(a.manifestPath, a.state);
    const argv = c.launchArgv(lease('s1-c0'), { vm: 'ubirun-test-1-abc' });
    const [push] = after(argv, '--push');
    const [from, to, list] = push.split(':');
    expect([from, to]).toEqual([s.root, 'custody/datasets']);
    expect(readFileSync(list, 'utf8').trim().split('\n')).toEqual([...s.conversations.flatMap(x => [x.chat_path, x.questions_path]), 'stand-in-manifest.json']);
    expect(after(argv, '--env')).toEqual(['GBRAIN_EVALS_BEAM10M_ROOT=~/custody/datasets', 'GBRAIN_EVALS_BEAM10M_MANIFEST=~/custody/datasets/stand-in-manifest.json']);
    expect(argv.indexOf('--push')).toBeLessThan(argv.indexOf('--'));
  });

  test('a missing source, a source inside the repository, a missing file or one changed byte refuses before any VM', () => {
    const s = standIn('push-bad');
    expect(caught(() => beam10mCustodyPush({})).op.code).toBe('CUSTODY_REQUIRED');
    expect(caught(() => beam10mCustodyPush({ GBRAIN_EVALS_BEAM10M_SOURCE: inRepo, GBRAIN_EVALS_BEAM10M_MANIFEST: s.manifest })).op.message).toMatch(/inside the repository/);
    expect(beam10mCustodyPush({ GBRAIN_EVALS_BEAM10M_SOURCE: s.root, GBRAIN_EVALS_BEAM10M_MANIFEST: s.manifest }).list).toHaveLength(5);
    writeFileSync(join(s.root, s.conversations[1].chat_path), readFileSync(join(s.root, s.conversations[1].chat_path), 'utf8') + ' ');
    expect(caught(() => beam10mCustodyPush({ GBRAIN_EVALS_BEAM10M_SOURCE: s.root, GBRAIN_EVALS_BEAM10M_MANIFEST: s.manifest })).op.message).toMatch(/10m-b\/chat\.json .*not the pinned bytes/);
    rmSync(join(s.root, s.conversations[0].questions_path));
    expect(caught(() => beam10mCustodyPush({ GBRAIN_EVALS_BEAM10M_SOURCE: s.root, GBRAIN_EVALS_BEAM10M_MANIFEST: s.manifest })).op.message).toMatch(/10m-a\/questions\.json .*missing/);
  });

  test('on the VM, setup\'s fetch verifies the pushed files against the manifest and refuses on a mismatch; without a custody root BEAM-10M stays custody-only', () => {
    const s = standIn('vm-fetch');
    delete process.env.GBRAIN_EVALS_BEAM10M_ROOT;
    expect(() => verifyBeam10mCustody(() => {})).toThrow(/CUSTODY_MISSING/);
    process.env.GBRAIN_EVALS_BEAM10M_ROOT = s.root;
    process.env.GBRAIN_EVALS_BEAM10M_MANIFEST = s.manifest;
    const logs: string[] = [];
    expect(verifyBeam10mCustody(l => logs.push(l))).toBe(4);
    expect(logs.join('\n')).toMatch(/4 file\(s\) match their pinned sha256 under the custody root/);
    const f = join(s.root, s.conversations[0].chat_path);
    writeFileSync(f, readFileSync(f, 'utf8').replace('SYNTHETIC', 'SYNTHETIc'));
    expect(() => verifyBeam10mCustody(() => {})).toThrow(/DATASET_HASH_MISMATCH/);
    rmSync(f);
    expect(() => verifyBeam10mCustody(() => {})).toThrow(/DATASET_MISSING/);
  });
});

describe('doctor --for sealed', () => {
  const byId = (checks: ReturnType<typeof sealedLaunchChecks>) => Object.fromEntries(checks.map(c => [c.id, c]));

  test('s1-corpus fails without the custodian\'s source and on a stand-in manifest; sealed-payload and sealed-out pass on this tree', () => {
    const a = campaign([S1, LOCOMO, PUBLIC]);
    const none = byId(sealedLaunchChecks(a.manifestPath, a.state, [], {}));
    expect(none['s1-corpus']).toMatchObject({ ok: false, code: 'CUSTODY_REQUIRED' });
    expect(none['s1-corpus'].detail).toMatch(/GBRAIN_EVALS_BEAM10M_SOURCE is not set/);
    expect(none['sealed-payload']).toMatchObject({ ok: true });
    expect(none['sealed-out']).toMatchObject({ ok: true });
    const s = standIn('doctor');
    const stand = byId(sealedLaunchChecks(a.manifestPath, a.state, [], { GBRAIN_EVALS_BEAM10M_SOURCE: s.root, GBRAIN_EVALS_BEAM10M_MANIFEST: s.manifest }));
    expect(stand['s1-corpus'].ok).toBe(false);
    expect(stand['s1-corpus'].detail).toMatch(/stand-in manifest/);
    expect(byId(sealedLaunchChecks(a.manifestPath, a.state, ['s3-c0'], {}))['s1-corpus']).toBeUndefined();
  });

  test('each check fails on its defect: no push (defect 1), no custody payload (defect 2), output in the checkout or rows pulled into the repository', () => {
    const a = campaign([S1, LOCOMO]);
    const s = standIn('doctor-defects');
    const env = { GBRAIN_EVALS_BEAM10M_SOURCE: s.root };
    const proto = Campaign.prototype as unknown as Record<string, unknown>;
    const orig = { custodyPush: proto.custodyPush, payload: proto.payload, remotePath: proto.remotePath };
    try {
      proto.custodyPush = () => null;
      expect(byId(sealedLaunchChecks(a.manifestPath, a.state, [], env))['s1-corpus']).toMatchObject({ ok: false, detail: expect.stringMatching(/pushes no BEAM-10M files/) });
      proto.custodyPush = orig.custodyPush;
      proto.payload = function (this: Campaign, l: LeaseState) { const p = (orig.payload as (l: LeaseState) => RemotePayload).call(this, l); return { ...p, sealed: undefined, out: `eval/reports/shootout/${l.cell}/${l.lease_id}` }; };
      proto.remotePath = function (this: Campaign, l: LeaseState) { return `work/gbrain-evals/eval/reports/shootout/${l.cell}/${l.lease_id}`; };
      const pre = byId(sealedLaunchChecks(a.manifestPath, a.state, [], env));
      expect(pre['sealed-payload']).toMatchObject({ ok: false, code: 'SEALED_CELL_LOCAL', detail: expect.stringMatching(/2 of 2 sealed cell\(s\) would launch without a custody root/) });
      expect(pre['sealed-out']).toMatchObject({ ok: false, detail: expect.stringMatching(/inside the VM's checkout/) });
    } finally { Object.assign(proto, orig); }
    expect(byId(sealedLaunchChecks(a.manifestPath, join(inRepo, 'doctor-state'), [], env))['sealed-out']).toMatchObject({ ok: false, detail: expect.stringMatching(/inside the repository/) });
  });
});
