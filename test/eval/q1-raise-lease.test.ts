/**
 * eval/runner/q1/raise-lease.ts raises a running lease of a campaign frozen before
 * leases could be raised (A17) using only that tree's code: the host reservation
 * and the VM lease ledger grow together, the proxy's ledger admits the new lease
 * without reopening, and the frozen settle closes the raised lease.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers, ledgerStatus, verifyLedger } from '../../eval/runner/budget-ledger.ts';
import { Campaign, type CampaignManifest } from '../../eval/runner/shootout-cell.ts';
import { leaseUsd, raise, raises, settle } from '../../eval/runner/q1/raise-lease.ts';

const tmp = mkdtempSync(join(tmpdir(), 'raise-lease-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

function setup(Cls: typeof Campaign = Campaign) {
  const dir = join(tmp, `c${++n}`);
  mkdirSync(dir, { recursive: true });
  const manifest = { kind: 'oss-shootout-campaign', schema_version: 1, campaign_id: `raise-${n}`, cap_usd: 10, ledger: join(dir, 'campaign.sqlite'),
    blocks: { T1: { estimate_usd: 6, cap_usd: 9 } },
    cells: [0, 1].map(i => ({ id: `cell-${i}`, system: 'fake', benchmark: 'fixture', config: 'common', lease_usd: 4, command: 'true', block: 'T1' })) } as unknown as CampaignManifest;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const state = join(dir, 'state');
  const c = new Cls(join(dir, 'manifest.json'), state);
  c.init();
  const launch = (cell: string, vm: string) => {
    const l = c.reserve(cell);
    appendFileSync(join(state, 'leases.ndjson'), JSON.stringify({ event: 'launched', lease_id: l.lease_id, at: new Date().toISOString(), argv: [], vm }) + '\n');
    return l;
  };
  const home = join(dir, 'vm-home');
  const vmLedger = (lease: string) => join(home, 'custody', lease, 'proxy', 'lease.sqlite');
  const ssh = (_vm: string, command: string) => {
    const p = Bun.spawnSync(['bash', '-c', command], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  };
  const hostCommitted = () => ledgerStatus({ ledgerPath: manifest.ledger, runId: JSON.parse(readFileSync(join(state, 'campaign.json'), 'utf8')).run_id }).run!;
  return { c, state, launch, home, vmLedger, ssh, hostCommitted, ledger: manifest.ledger };
}

describe('raise-lease (A17 campaigns)', () => {
  beforeEach(() => closeLedgers());

  test('a running lease is raised on both ledgers, binds without reopening the proxy, and settles through the frozen settle', () => {
    const { c, state, launch, vmLedger, ssh, hostCommitted, ledger } = setup();
    const l = launch('cell-0', 'vm-0');
    mkdirSync(join(vmLedger(l.lease_id), '..'), { recursive: true });
    const proxy = BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: vmLedger(l.lease_id) });
    proxy.settle(proxy.reserve(3.5, 'ingest'), { usd: 3.5 });
    expect(() => proxy.reserve(1, 'ingest')).toThrow(/over its \$4.00 budget/);

    expect(() => raise(c, l.lease_id, 11, 'too much', ssh)).toThrow(/over its \$10.00 budget|over its \$10.00 cap/);
    expect(raise(c, l.lease_id, 5, 'preview', ssh, { dryRun: true })).toMatchObject({ dry_run: true, from_usd: 4, to_usd: 5, vm: { budget_usd: 4, committed_usd: 3.5 } });
    expect([hostCommitted().committed_usd, ledgerStatus({ ledgerPath: vmLedger(l.lease_id), runId: l.lease_id }).run!.budget_usd, raises(state).length]).toEqual([4, 4, 0]);

    const rec = raise(c, l.lease_id, 5, 'owner approved $5', ssh);
    expect(rec).toMatchObject({ from_usd: 4, to_usd: 5, vm_ledger: vmLedger(l.lease_id), vm_cap_usd: expect.any(Number) });
    expect(leaseUsd(c, l.lease_id)).toBe(5);
    expect(hostCommitted().committed_usd).toBe(5);
    expect(ledgerStatus({ ledgerPath: vmLedger(l.lease_id), runId: l.lease_id }).run!.budget_usd).toBe(5);
    proxy.settle(proxy.reserve(1.5, 'ingest'), { usd: 1.5 });
    expect(() => proxy.reserve(0.1, 'ingest')).toThrow(/over its \$5.00 budget/);
    expect(verifyLedger(vmLedger(l.lease_id)).ok).toBe(true);
    expect(verifyLedger(ledger).ok).toBe(true);

    expect(() => raise(c, l.lease_id, 5, 'again', ssh)).toThrow(/--usd must be above it/);
    expect(() => raise(c, l.lease_id, 6, 'vm gone', (vm, command) => command.includes("'show'") ? ssh(vm, command) : { code: 255, out: '', err: 'ssh: connect refused' })).toThrow(/was not raised.*back at \$5.00/);
    expect(hostCommitted().committed_usd).toBe(5);

    appendFileSync(join(state, 'leases.ndjson'), JSON.stringify({ event: 'finished', lease_id: l.lease_id, at: new Date().toISOString(), exit_code: 0 }) + '\n');
    mkdirSync(c.resultsDir(c.lease(l.lease_id)), { recursive: true });
    writeFileSync(join(c.resultsDir(c.lease(l.lease_id)), 'lease.sqlite'), '');
    expect(() => settle(c, l.lease_id)).toThrow(/was raised and its VM ledger was pulled/);
    rmSync(join(c.resultsDir(c.lease(l.lease_id)), 'lease.sqlite'));
    writeFileSync(join(c.resultsDir(c.lease(l.lease_id)), 'lease-summary.json'), JSON.stringify({ run_id: l.lease_id, lease_usd: 4, committed_usd: 5, requests: 2 }));
    expect(settle(c, l.lease_id)).toMatchObject({ status: 'settled', actual_usd: 5 });
    expect(hostCommitted()).toMatchObject({ committed_usd: 5, overshoot_usd: 0 });
  });

  test('a raise is refused past the block cap, counting earlier raises of running leases in the block', () => {
    const { c, launch, vmLedger, ssh, hostCommitted } = setup();
    const a = launch('cell-0', 'vm-0'), b = launch('cell-1', 'vm-1');
    for (const l of [a, b]) { mkdirSync(join(vmLedger(l.lease_id), '..'), { recursive: true }); BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: vmLedger(l.lease_id) }); }
    raise(c, a.lease_id, 4.5, 'first', ssh);
    expect(() => raise(c, b.lease_id, 5, 'second', ssh)).toThrow(/block T1 would hold \$9.50, over its \$9.00 cap/);
    expect(() => raise(c, b.lease_id, 5, 'second', ssh, { dryRun: true })).toThrow(/block T1 would hold \$9.50/);
    expect(raise(c, b.lease_id, 4.5, 'second', ssh)).toMatchObject({ to_usd: 4.5 });
    expect(hostCommitted().committed_usd).toBe(9);
  });

  test('only a launched lease with an open VM ledger at the expected amount is raised', () => {
    const { c, launch, vmLedger, ssh } = setup();
    const l = c.reserve('cell-0');
    expect(() => raise(c, l.lease_id, 5, 'x', ssh)).toThrow(/is reserved; only a running/);
    const m = launch('cell-1', 'vm-1');
    expect(() => raise(c, m.lease_id, 5, 'x', ssh)).toThrow(/could not be read/);
    mkdirSync(join(vmLedger(m.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: m.lease_id, leaseUsd: 3, ledgerPath: vmLedger(m.lease_id) });
    expect(() => raise(c, m.lease_id, 5, 'x', ssh)).toThrow(/holds lease 3 .*not an open \$4.00/);
    expect(() => raise(c, m.lease_id, 5, '  ', ssh)).toThrow(/needs --reason/);
  });

  test('a reserved lease cannot be settled and is abandoned at its full reservation; a finished lease is not raised', () => {
    const { c, state, launch, hostCommitted, ssh } = setup();
    const r = c.reserve('cell-0');
    expect(() => c.settle(r.lease_id)).toThrow(/was never launched; abandon it instead/);
    expect(c.abandon(r.lease_id, 'VM never came up')).toMatchObject({ status: 'abandoned', actual_usd: 4 });
    expect(hostCommitted().committed_usd).toBe(4);
    const f = launch('cell-1', 'vm-1');
    appendFileSync(join(state, 'leases.ndjson'), JSON.stringify({ event: 'finished', lease_id: f.lease_id, at: new Date().toISOString(), exit_code: 0 }) + '\n');
    expect(() => raise(c, f.lease_id, 5, 'late', ssh)).toThrow(/is finished; only a running \(launched\) lease is raised/);
    expect(hostCommitted().committed_usd).toBe(8);
  });

  test('an abandoned raised lease is charged its raised reservation in leases, block spend and status, as on the host ledger', () => {
    const { c, launch, vmLedger, ssh, hostCommitted } = setup();
    const l = launch('cell-0', 'vm-0');
    mkdirSync(join(vmLedger(l.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: vmLedger(l.lease_id) });
    raise(c, l.lease_id, 5, 'owner approved $5', ssh);
    expect([c.blockSpend('T1'), c.status().unsettled_usd]).toEqual([5, 5]);
    expect(c.abandon(l.lease_id, 'VM lost')).toMatchObject({ status: 'abandoned', actual_usd: 5, note: expect.stringContaining('full reservation of $5.00') });
    expect(hostCommitted().committed_usd).toBe(5);
    expect([c.blockSpend('T1'), c.status().unsettled_usd]).toEqual([5, 5]);
    const m = launch('cell-1', 'vm-1');
    mkdirSync(join(vmLedger(m.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: m.lease_id, leaseUsd: 4, ledgerPath: vmLedger(m.lease_id) });
    expect(() => raise(c, m.lease_id, 4.5, 'over the block', ssh)).toThrow(/block T1 would hold \$9.50, over its \$9.00 cap/);
  });

  test('paired with a frozen Campaign that predates raised_usd, raises still stop at the block cap and a second raise starts from the first', () => {
    class FrozenCampaign extends Campaign {
      override leases() { return super.leases().map(({ raised_usd: _raised, ...l }) => l.status === 'abandoned' && l.actual_usd !== 0 ? { ...l, actual_usd: l.usd } : l); }
    }
    const { c, launch, vmLedger, ssh, hostCommitted } = setup(FrozenCampaign);
    const a = launch('cell-0', 'vm-0'), b = launch('cell-1', 'vm-1');
    for (const l of [a, b]) { mkdirSync(join(vmLedger(l.lease_id), '..'), { recursive: true }); BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: vmLedger(l.lease_id) }); }
    raise(c, a.lease_id, 4.5, 'first', ssh);
    expect(() => raise(c, b.lease_id, 5, 'second', ssh)).toThrow(/block T1 would hold \$9.50, over its \$9.00 cap/);
    expect(raise(c, a.lease_id, 4.6, 'again', ssh)).toMatchObject({ from_usd: 4.5, to_usd: 4.6 });
    c.abandon(a.lease_id, 'VM lost');
    expect(hostCommitted().committed_usd).toBeCloseTo(8.6, 9);
    expect(() => raise(c, b.lease_id, 4.5, 'after abandon', ssh)).toThrow(/block T1 would hold \$9.10, over its \$9.00 cap/);
  });

  test('a raised lease whose launch never reached the cell command closes at $0 on the host ledger', () => {
    const { c, launch, vmLedger, ssh, hostCommitted } = setup();
    const l = launch('cell-0', 'vm-0');
    mkdirSync(join(vmLedger(l.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: vmLedger(l.lease_id) });
    raise(c, l.lease_id, 5, 'owner approved $5', ssh);
    expect(hostCommitted().committed_usd).toBe(5);
    const log = join(tmp, `launch-${l.lease_id}.log`);
    writeFileSync(log, 'ubi-runner: creating VM\nubi-runner: setup failed\n');
    expect(c.abandon(l.lease_id, 'setup failed', { log })).toMatchObject({ status: 'abandoned', actual_usd: 0 });
    expect(hostCommitted().committed_usd).toBe(0);
  });
});
