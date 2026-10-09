/**
 * Shootout cell leases (eval/runner/shootout-cell.ts). Keyless: the VM runner
 * is a fake that writes what a pulled VM ledger would contain; no VM starts.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers, ledgerStatus } from '../../eval/runner/budget-ledger.ts';
import { Campaign, runRemote, type CampaignManifest } from '../../eval/runner/shootout-cell.ts';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'shootout-cell-'));
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); });
let n = 0;

function campaign(over: Partial<CampaignManifest> = {}, leases: number[] = [4, 4, 4]) {
  const dir = join(tmp, `c${++n}`);
  mkdirSync(dir, { recursive: true });
  const manifest: CampaignManifest = { kind: 'oss-shootout-campaign', schema_version: 1, campaign_id: `test-${n}`, cap_usd: 10, ledger: join(dir, 'campaign.sqlite'),
    cells: leases.map((usd, i) => ({ id: `cell-${i}`, system: 'fake', benchmark: 'fixture', config: 'common', lease_usd: usd, command: 'true' })), ...over };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { dir, manifestPath: join(dir, 'manifest.json'), state: join(dir, 'state') };
}

/** What the VM would leave behind: its own lease ledger with some spend. */
function vmSpends(c: Campaign, usd: number) {
  return async (argv: string[]) => {
    const l = c.leases().find(x => x.status === 'launched')!;
    expect(argv.join(' ')).toContain(l.lease_id);
    const lease = BudgetRun.openLease({ runId: l.lease_id, leaseUsd: l.usd, ledgerPath: join(c.resultsDir(l), 'lease.sqlite') });
    if (usd > 0) lease.settle(lease.reserve(usd, 'vm spend'), { usd });
    closeLedgers();
    return 0;
  };
}

describe('campaign leases', () => {
  beforeEach(() => closeLedgers());
  test('the manifest is validated before anything is reserved', () => {
    const { manifestPath, state } = campaign({ cells: [{ id: 'a', system: 'x', benchmark: 'b', config: 'c', lease_usd: 0, command: '' }, { id: 'a', system: 'x', benchmark: 'b', config: 'c', lease_usd: 1, command: 'true' }] });
    expect(() => new Campaign(manifestPath, state)).toThrow(/lease_usd must be positive.*command is required.*duplicate cell a/);
  });

  test('reserve, launch, settle: the host lease settles to the VM ledger total and frees the rest', async () => {
    const { manifestPath, state } = campaign();
    const c = new Campaign(manifestPath, state);
    c.init();
    const l = c.reserve('cell-0');
    expect(c.status().committed_usd).toBe(4);
    const settled = await c.launch('cell-0', vmSpends(c, 1.25));
    expect(settled).toMatchObject({ status: 'settled', actual_usd: 1.25 });
    expect(c.status()).toMatchObject({ committed_usd: 1.25, remaining_usd: 8.75 });
    expect(() => c.settle(l.lease_id)).toThrow(/already settled/);
  });

  test('a cell cannot hold two leases, a launched lease is never launched again, and a lost VM keeps its reservation', async () => {
    const { manifestPath, state } = campaign();
    const c = new Campaign(manifestPath, state);
    c.init();
    const l = c.reserve('cell-1');
    expect(() => c.reserve('cell-1')).toThrow(/already holds lease/);
    await expect(c.launch('cell-1', async () => { throw new Error('ssh dropped'); })).rejects.toThrow(/ssh dropped/);
    expect(c.lease(l.lease_id).status).toBe('launched');
    await expect(c.launch('cell-1', vmSpends(c, 0))).rejects.toThrow(/already launched; a lease is used once/);
    expect(() => c.settle(l.lease_id)).toThrow(/keeps its full reservation/);
    expect(c.status().committed_usd).toBe(4);
    c.abandon(l.lease_id, 'VM lost after launch');
    expect(c.status().committed_usd).toBe(4);
    const retry = c.reserve('cell-1');
    expect(retry.attempt).toBe(2);
    expect(c.status().committed_usd).toBe(8);
  });

  test('a launch that died before the cell command closes at $0 only with a log that proves it', async () => {
    const { manifestPath, state } = campaign();
    const c = new Campaign(manifestPath, state);
    c.init();
    const l = c.reserve('cell-1');
    expect(() => c.abandon(l.lease_id, 'x', { log: '/dev/null' })).toThrow(/never launched/);
    await c.launch('cell-1', async () => 1);
    const ran = join(state, 'ran.log'), unstarted = join(state, 'sync.log');
    writeFileSync(ran, 'ubi-runner: ready: vm\nubi-runner: running on vm: bun eval/runner/shootout-cell.ts remote\n');
    writeFileSync(unstarted, 'ubi-runner: ready: vm\ntar: .git/objects: file changed as we read it\nubi-runner: destroyed vm\n');
    expect(() => c.abandon(l.lease_id, 'sync failed', { log: ran })).toThrow(/reached the cell command/);
    const closed = c.abandon(l.lease_id, 'sync failed', { log: unstarted });
    expect([closed.status, closed.actual_usd]).toEqual(['abandoned', 0]);
    expect(c.status().committed_usd).toBe(0);
    expect(readFileSync(join(state, 'evidence', `${l.lease_id}.log`), 'utf8')).toContain('file changed');
  });

  test('leases cannot pass the campaign cap, and a restarted host cannot replay one', () => {
    const { manifestPath, state } = campaign({}, [4, 4, 4]);
    const c = new Campaign(manifestPath, state);
    c.init();
    c.reserve('cell-0'); c.reserve('cell-1');
    expect(() => c.reserve('cell-2')).toThrow(/over its \$10\.00 budget/);
    closeLedgers();
    const again = new Campaign(manifestPath, state);
    expect(again.init().run_id).toBe(c.status().run_id);
    expect(() => again.reserve('cell-0')).toThrow(/already holds lease/);
    expect(again.status().committed_usd).toBe(8);
  });

  test('concurrent reserve processes cannot overspend the campaign cap', async () => {
    const leases = Array.from({ length: 12 }, () => 1);
    const { manifestPath, state } = campaign({ cap_usd: 5 }, leases);
    new Campaign(manifestPath, state).init();
    closeLedgers();
    const procs = leases.map((_, i) => Bun.spawn([process.execPath, 'eval/runner/shootout-cell.ts', 'reserve', '--campaign', manifestPath, '--state', state, '--cell', `cell-${i}`], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' }));
    const codes = await Promise.all(procs.map(p => p.exited));
    expect(codes.filter(x => x === 0)).toHaveLength(5);
    const s = new Campaign(manifestPath, state).status();
    expect(s.committed_usd).toBe(5);
    expect(s.leases).toHaveLength(5);
  }, 60_000);

  test('a pulled ledger for another lease or another amount is refused', async () => {
    const { manifestPath, state } = campaign();
    const c = new Campaign(manifestPath, state);
    c.init();
    const l = c.reserve('cell-0');
    await c.launch('cell-0', async () => {
      mkdirSync(c.resultsDir(l), { recursive: true });
      writeFileSync(join(c.resultsDir(l), 'lease-summary.json'), JSON.stringify({ run_id: 'someone-else', lease_usd: 4, committed_usd: 0.1, requests: 1 }));
      return 0;
    }).catch(e => expect(String(e)).toMatch(/not cell-0/));
    expect(c.lease(l.lease_id).status).toBe('finished');
    writeFileSync(join(c.resultsDir(l), 'lease-summary.json'), JSON.stringify({ run_id: l.lease_id, lease_usd: 9, committed_usd: 0.1, requests: 1 }));
    expect(() => c.settle(l.lease_id)).toThrow(/host reserved \$4/);
  });

  test('launch argv runs the cell remotely through ubi-runner and pulls its output', () => {
    const { manifestPath, state } = campaign({ cells: [{ id: 'extract-first-locomo', system: 'extract-first', benchmark: 'locomo', config: 'common', lease_usd: 2, command: 'echo hi', vm: { size: 'standard-4' }, pass: ['OPENAI_API_KEY'] }] });
    const c = new Campaign(manifestPath, state);
    c.init();
    const l = c.reserve('extract-first-locomo');
    const argv = c.launchArgv(l);
    expect(argv.slice(0, 7)).toEqual(['bash', expect.stringContaining('ubi-runner.sh'), 'run', '-s', 'standard-4', '-l', 'eu-central-h1']);
    expect(argv).toContain('--pass');
    expect(argv.join(' ')).not.toMatch(/sk-|placeholder/);
    expect(argv[argv.indexOf('--pull') + 1]).toBe(`work/gbrain-evals/eval/reports/shootout/extract-first-locomo/${l.lease_id}:${join(state, 'results', 'extract-first-locomo')}`);
    const payload = JSON.parse(Buffer.from(argv.at(-1)!.split('--cell-b64 ')[1], 'base64').toString('utf8'));
    expect(payload).toEqual({ lease_id: l.lease_id, lease_usd: 2, max_output_tokens: null, command: 'echo hi', out: `eval/reports/shootout/extract-first-locomo/${l.lease_id}` });
  });

  test('a sealed cell tells the remote side, so the proxy traces go to the custody root; other cells carry no flag', () => {
    const { manifestPath, state } = campaign({ cells: [{ id: 'extract-first-sealed', system: 'extract-first', benchmark: 'locomo', config: 'common', lease_usd: 2, command: 'echo hi', sealed: true }] });
    const c = new Campaign(manifestPath, state);
    c.init();
    const argv = c.launchArgv(c.reserve('extract-first-sealed'));
    expect(JSON.parse(Buffer.from(argv.at(-1)!.split('--cell-b64 ')[1], 'base64').toString('utf8')).sealed).toBe(true);
  });
});

describe('cell files and parameters', () => {
  test('a setup command becomes the --setup script, placeholders fill from parameters, and an unknown parameter is refused', () => {
    const dir = join(tmp, `files-${++n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cells.json'), JSON.stringify({ kind: 'oss-shootout-cells', schema_version: 1, system: 'extract-first', config: 'common', cells: [
      { id: 'extract-first-lme', lease_usd: 10, lease_scale: { param: 'n', base: 100 }, command: 'run --limit {{n}}', setup_command: 'bash eval/systems/bootstrap.sh setup --system extract-first' },
      { id: 'extract-first-off', lease_usd: 5, when: 'extra', command: 'x' }] }));
    writeFileSync(join(dir, 'campaign.json'), JSON.stringify({ kind: 'oss-shootout-campaign', schema_version: 1, campaign_id: `files-${n}`, cap_usd: 10, ledger: join(dir, 'l.sqlite'), parameters: { n: 50, extra: false }, cells_from: ['cells.json'], cells: [] }));
    const c = new Campaign(join(dir, 'campaign.json'), join(dir, 'state'));
    expect(c.manifest.cells.map(x => [x.id, x.system, x.lease_usd, x.command])).toEqual([['extract-first-lme', 'extract-first', 5, 'run --limit 50']]);
    c.init();
    const argv = c.launchArgv(c.reserve('extract-first-lme'));
    const script = argv[argv.indexOf('--setup') + 1];
    expect(readFileSync(script, 'utf8')).toBe('set -euo pipefail\nbash eval/systems/bootstrap.sh setup --system extract-first\n');
    writeFileSync(join(dir, 'campaign.json'), JSON.stringify({ kind: 'oss-shootout-campaign', schema_version: 1, campaign_id: 'x', cap_usd: 10, ledger: join(dir, 'l2.sqlite'), parameters: {}, cells_from: ['cells.json'], cells: [] }));
    expect(() => new Campaign(join(dir, 'campaign.json'), join(dir, 'state2'))).toThrow(/unknown parameter/);
  });
});

describe('remote cell', () => {
  test('starts the lease proxy, hands the cell dummy keys and proxy URLs, and writes the lease summary', async () => {
    const out = join(tmp, 'remote-out');
    const port = await freePort(0);
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'placeholder-real-key';
    try {
      const code = await runRemote({ lease_id: 'remote-lease-1', lease_usd: 0.5, max_output_tokens: 64000, out, command: `if [ "$OPENAI_API_KEY" = dummy-key-the-proxy-replaces ]; then k=dummy; else k=NOT-DUMMY; fi; echo "$k $OPENAI_BASE_URL" > "$SHOOTOUT_OUT/seen.txt"; curl -sf "$SHOOTOUT_PROXY/__proxy/status" > "$SHOOTOUT_OUT/status.json"` }, { port });
      expect(code).toBe(0);
    } finally { if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev; }
    expect(readFileSync(join(out, 'seen.txt'), 'utf8').trim()).toBe(`dummy http://127.0.0.1:${port}/cell/openai/v1`);
    expect(JSON.parse(readFileSync(join(out, 'status.json'), 'utf8'))).toMatchObject({ mode: 'lease', run_id: 'remote-lease-1', lease_usd: 0.5, max_output_tokens: 64000 });
    expect(JSON.parse(readFileSync(join(out, 'lease-summary.json'), 'utf8'))).toMatchObject({ run_id: 'remote-lease-1', lease_usd: 0.5, committed_usd: 0, requests: 0, max_output_tokens: 64000, cell_exit_code: 0 });
    closeLedgers();
    expect(ledgerStatus({ ledgerPath: join(out, 'lease.sqlite'), runId: 'remote-lease-1' }).run!.budget_usd).toBe(0.5);
  }, 30_000);
});
