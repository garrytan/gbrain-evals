/**
 * eval/runner/q1/raise-lease.ts raises a running lease of a campaign frozen before
 * leases could be raised (A17) using only that tree's code: the host reservation
 * and the VM lease ledger grow together, the proxy's ledger admits the new lease
 * without reopening, and the frozen settle closes the raised lease.
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BudgetRun, closeLedgers, closeRun, ledgerStatus, verifyLedger } from '../../eval/runner/budget-ledger.ts';
import { Campaign, type CampaignManifest } from '../../eval/runner/shootout-cell.ts';
import { clearStaleLock, leaseUsd, raise, raises, settle } from '../../eval/runner/q1/raise-lease.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'raise-lease-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

function setup(Cls: typeof Campaign = Campaign, ledgerIn = (dir: string) => join(dir, 'campaign.sqlite')) {
  const dir = join(tmp, `c${++n}`);
  mkdirSync(dir, { recursive: true });
  const manifest = { kind: 'oss-shootout-campaign', schema_version: 1, campaign_id: `raise-${n}`, cap_usd: 10, ledger: ledgerIn(dir),
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
  const ledger = resolve(ROOT, manifest.ledger);
  const hostCommitted = () => ledgerStatus({ ledgerPath: ledger, runId: JSON.parse(readFileSync(join(state, 'campaign.json'), 'utf8')).run_id }).run!;
  return { c, state, launch, home, vmLedger, ssh, hostCommitted, ledger };
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
    expect(() => raise(c, l.lease_id, 6, 'vm closed', (vm, command) => { if (command.includes("'raise'")) closeRun(vmLedger(l.lease_id), l.lease_id); return ssh(vm, command); })).toThrow(/was not raised.*back at \$5.00/);
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

  test('a raise is refused once the campaign run is closed and leaves both ledgers as they were (#319)', () => {
    const { c, state, launch, vmLedger, ssh, hostCommitted, ledger } = setup();
    const l = launch('cell-0', 'vm-0');
    mkdirSync(join(vmLedger(l.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: vmLedger(l.lease_id) });
    expect(raise(c, l.lease_id, 4.5, 'owner approved $4.50', ssh)).toMatchObject({ from_usd: 4, to_usd: 4.5 });
    expect(hostCommitted().committed_usd).toBe(4.5);

    closeRun(ledger, JSON.parse(readFileSync(join(state, 'campaign.json'), 'utf8')).run_id);
    expect(() => raise(c, l.lease_id, 5, 'after close', ssh)).toThrow(/raise .* from \$4.50 to \$5.00: budget run .* already finished/);
    expect(hostCommitted()).toMatchObject({ committed_usd: 4.5, finished_at: expect.any(String) });
    expect(ledgerStatus({ ledgerPath: vmLedger(l.lease_id), runId: l.lease_id }).run!.budget_usd).toBe(4.5);
    expect([leaseUsd(c, l.lease_id), raises(state).length]).toEqual([4.5, 1]);
    expect(verifyLedger(ledger).ok).toBe(true);
  });

  test('a raise whose VM step fails after the campaign run closed still gives the host reservation back (#319)', () => {
    const { c, state, launch, vmLedger, ssh, hostCommitted, ledger } = setup();
    const l = launch('cell-0', 'vm-0');
    mkdirSync(join(vmLedger(l.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: vmLedger(l.lease_id) });
    const runId = JSON.parse(readFileSync(join(state, 'campaign.json'), 'utf8')).run_id;
    const closedMidRaise = (vm: string, command: string) => {
      if (!command.includes("'raise'")) return ssh(vm, command);
      closeRun(ledger, runId);
      closeRun(vmLedger(l.lease_id), l.lease_id);
      return ssh(vm, command);
    };

    expect(() => raise(c, l.lease_id, 5, 'closed mid-raise', closedMidRaise)).toThrow(/was not raised.*back at \$4.00/);
    expect(hostCommitted()).toMatchObject({ committed_usd: 4, finished_at: expect.any(String) });
    expect(ledgerStatus({ ledgerPath: vmLedger(l.lease_id), runId: l.lease_id }).run!.budget_usd).toBe(4);
    expect([leaseUsd(c, l.lease_id), raises(state).length]).toEqual([4, 0]);
    expect(verifyLedger(ledger).ok).toBe(true);
  });

  test('another campaign\'s manifest, another freeze\'s state directory, or a lease whose cell is not in the manifest refuses the raise instead of skipping the block cap (#330)', () => {
    const { c, state, launch, vmLedger, ssh, hostCommitted, ledger } = setup();
    const a = launch('cell-0', 'vm-0'), b = launch('cell-1', 'vm-1');
    for (const l of [a, b]) { mkdirSync(join(vmLedger(l.lease_id), '..'), { recursive: true }); BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: vmLedger(l.lease_id) }); }
    const raw = JSON.parse(readFileSync(join(dirname(ledger), 'manifest.json'), 'utf8')) as { campaign_id: string; cells: { id: string }[] };
    const paired = (file: string, campaignId: string) => {
      writeFileSync(join(dirname(ledger), file), JSON.stringify({ ...raw, campaign_id: campaignId, cells: raw.cells.map(x => ({ ...x, id: `other-${x.id}` })) }));
      return new Campaign(join(dirname(ledger), file), state);
    };
    expect(() => raise(c, b.lease_id, 5.5, 'over the block', ssh)).toThrow(/block T1 would hold \$9.50, over its \$9.00 cap/);

    const other = paired('other.json', `${raw.campaign_id}-other`);
    for (const dryRun of [true, false]) expect(() => raise(other, b.lease_id, 5.5, 'mismatched pair', ssh, { dryRun })).toThrow(`belongs to campaign ${raw.campaign_id}, not ${raw.campaign_id}-other`);
    writeFileSync(join(dirname(ledger), 'refrozen.json'), JSON.stringify({ ...raw, blocks: { T1: { estimate_usd: 8, cap_usd: 12 } } }));
    const refrozen = new Campaign(join(dirname(ledger), 'refrozen.json'), state);
    for (const dryRun of [true, false]) expect(() => raise(refrozen, b.lease_id, 5.5, 'state of an earlier freeze', ssh, { dryRun })).toThrow(`${state} was frozen at ${c.sha256.slice(0, 12)}, but campaign ${raw.campaign_id} hashes to ${refrozen.sha256.slice(0, 12)} in this checkout`);
    expect(() => raise(paired('renamed.json', raw.campaign_id), b.lease_id, 5.5, 'cells renamed', ssh)).toThrow(/was frozen at/);

    const ghost = 'ghost-a1-0';
    appendFileSync(join(state, 'leases.ndjson'), [{ event: 'reserved', lease_id: ghost, cell: 'ghost', attempt: 1, usd: 4, entry_id: b.entry_id, at: new Date().toISOString(), max_output_tokens: null }, { event: 'launched', lease_id: ghost, at: new Date().toISOString(), argv: [], vm: 'vm-1' }].map(x => JSON.stringify(x) + '\n').join(''));
    mkdirSync(join(vmLedger(ghost), '..'), { recursive: true });
    BudgetRun.openLease({ runId: ghost, leaseUsd: 4, ledgerPath: vmLedger(ghost) });
    expect(() => raise(c, ghost, 4.5, 'cell not in the manifest', ssh)).toThrow(`no cell ghost in campaign ${raw.campaign_id}`);
    expect([hostCommitted().committed_usd, ledgerStatus({ ledgerPath: vmLedger(b.lease_id), runId: b.lease_id }).run!.budget_usd, raises(state).length, existsSync(join(state, 'raise.lock'))]).toEqual([8, 4, 0, false]);
  });

  /** One launched $4 lease with an open VM ledger, raised to $5 through a VM step that `step` replaces; `run` runs the real one. */
  function vmStep(step: (run: () => { code: number | null; out: string; err: string }, vm: { ledger: string; lease: string }) => { code: number | null; out: string; err: string }) {
    const s = setup();
    const l = s.launch('cell-0', 'vm-0');
    mkdirSync(join(s.vmLedger(l.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: s.vmLedger(l.lease_id) });
    const raiseTo5 = () => raise(s.c, l.lease_id, 5, 'owner approved $5', (vm, command) => command.includes("'raise'") ? step(() => s.ssh(vm, command), { ledger: s.vmLedger(l.lease_id), lease: l.lease_id }) : s.ssh(vm, command));
    const ledgers = () => [s.hostCommitted().committed_usd, ledgerStatus({ ledgerPath: s.vmLedger(l.lease_id), runId: l.lease_id }).run!.budget_usd, raises(s.state).map(r => r.vm_result ?? 'confirmed')];
    return { ...s, l, raiseTo5, ledgers };
  }

  test('a VM step that ends without a result keeps the host reservation, records the raise as unknown and says so (#329)', () => {
    const dropped = vmStep(run => { run(); return { code: 255, out: '', err: 'Connection to vm-0 closed by remote host.' }; });
    expect(dropped.raiseTo5).toThrow(/ended without a result \(exit 255\): Connection to vm-0 closed.*the host reservation stays at \$5.00 and the raise is recorded with vm_result "unknown".*raise-lease.ts show/);
    expect(dropped.ledgers()).toEqual([5, 5, ['unknown']]);
    expect(raises(dropped.state)[0]).toMatchObject({ from_usd: 4, to_usd: 5, vm_ledger: null, vm_cap_usd: null });
    const timedOut = vmStep(() => ({ code: null, out: '', err: '' }));
    expect(timedOut.raiseTo5).toThrow(/ended without a result \(exit null\).*stays at \$5.00/);
    expect(timedOut.ledgers()).toEqual([5, 4, ['unknown']]);
    const unread = vmStep(run => ({ ...run(), out: 'Welcome to Ubuntu' }));
    expect(unread.raiseTo5).toThrow(/ended without a result \(exit 0\).*stays at \$5.00/);
    expect(unread.ledgers()).toEqual([5, 5, ['unknown']]);
  });

  test('a raise with an unknown VM result counts against its block and stops a retry until the ledgers are reconciled (#329)', () => {
    const s = vmStep(run => { run(); return { code: null, out: '', err: '' }; });
    expect(s.raiseTo5).toThrow(/ended without a result/);
    expect([s.c.lease(s.l.lease_id).raised_usd, s.c.blockSpend('T1'), leaseUsd(s.c, s.l.lease_id)]).toEqual([5, 5, 5]);
    const m = s.launch('cell-1', 'vm-1');
    mkdirSync(join(s.vmLedger(m.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: m.lease_id, leaseUsd: 4, ledgerPath: s.vmLedger(m.lease_id) });
    expect(() => raise(s.c, m.lease_id, 4.5, 'past the block', s.ssh)).toThrow(/block T1 would hold \$9.50, over its \$9.00 cap/);

    const timedOut = vmStep(() => ({ code: null, out: '', err: '' }));
    expect(timedOut.raiseTo5).toThrow(/ended without a result/);
    expect(() => raise(timedOut.c, timedOut.l.lease_id, 6, 'retry', timedOut.ssh)).toThrow(/the VM ledger holds lease 4 \(finished: false\), not an open \$5.00/);
    expect(timedOut.ledgers()).toEqual([5, 4, ['unknown']]);
  });

  test('a VM step the lease ledger refuses gives the host reservation back (#329)', () => {
    const refused = vmStep((run, vm) => { closeRun(vm.ledger, vm.lease); return run(); });
    expect(refused.raiseTo5).toThrow(/was not raised \(exit 3\): lease .* is not open in .*; the host reservation is back at \$4.00/);
    expect(refused.ledgers()).toEqual([4, 4, []]);
  });

  test('a VM step that fails before its COMMIT rolls back and counts as a refusal, giving the host reservation back', () => {
    const failed = vmStep((run, vm) => {
      const db = new Database(vm.ledger);
      db.exec("CREATE TRIGGER no_caps BEFORE INSERT ON caps BEGIN SELECT RAISE(ABORT, 'caps are read-only'); END");
      db.close();
      return run();
    });
    expect(failed.raiseTo5).toThrow(/was not raised \(exit 3\): lease .* was not raised, rolled back before COMMIT: .*caps are read-only.*; the host reservation is back at \$4.00/);
    expect(failed.ledgers()).toEqual([4, 4, []]);
  });

  test('a VM refusal whose give-back fails names both errors and the host amount it leaves', () => {
    let saved = '';
    const s = vmStep((run, vm) => {
      closeRun(vm.ledger, vm.lease);
      saved = readFileSync(join(s.state, 'campaign.json'), 'utf8');
      writeFileSync(join(s.state, 'campaign.json'), JSON.stringify({ ...JSON.parse(saved), ledger: 'gone/campaign.sqlite' }));
      return run();
    });
    expect(s.raiseTo5).toThrow(/was not raised \(exit 3\): lease .* is not open in .*; giving the host reservation back then failed: .*; the host reservation stays at \$5.00 with no raise recorded, so give the \$1.00 back on the host ledger by hand/);
    writeFileSync(join(s.state, 'campaign.json'), saved);
    expect(s.ledgers()).toEqual([5, 4, []]);
    expect(existsSync(join(s.state, 'raise.lock'))).toBe(false);
  });

  test('a raise whose record cannot be written keeps the raise lock, so no later raise runs on an undercounted block', () => {
    const s = vmStep(run => {
      mkdirSync(join(s.state, 'raises.ndjson'));
      run();
      return { code: 255, out: '', err: 'Connection reset' };
    });
    expect(s.raiseTo5).toThrow(/ended without a result \(exit 255\), but the raise could not be recorded in .*raises.ndjson: .*; the host reservation stays at \$5.00 and .*raise.lock stays held\. One raise runs at a time per freeze/);
    rmSync(join(s.state, 'raises.ndjson'), { recursive: true });
    expect([s.hostCommitted().committed_usd, ledgerStatus({ ledgerPath: s.vmLedger(s.l.lease_id), runId: s.l.lease_id }).run!.budget_usd, leaseUsd(s.c, s.l.lease_id), existsSync(join(s.state, 'raise.lock'))]).toEqual([5, 5, 4, true]);
    const m = s.launch('cell-1', 'vm-1');
    mkdirSync(join(s.vmLedger(m.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: m.lease_id, leaseUsd: 4, ledgerPath: s.vmLedger(m.lease_id) });
    expect(() => raise(s.c, m.lease_id, 4.5, 'while unrecorded', s.ssh)).toThrow(/another raise holds .*raise.lock/);
    expect(s.hostCommitted().committed_usd).toBe(9);
  });

  test('one raise runs at a time per freeze: a raise that overlaps another is refused at once, so a lost reply cannot lower the lease or pass the block cap', () => {
    const { c, state, launch, vmLedger, ssh, hostCommitted } = setup();
    const a = launch('cell-0', 'vm-0'), b = launch('cell-1', 'vm-1');
    for (const l of [a, b]) { mkdirSync(join(vmLedger(l.lease_id), '..'), { recursive: true }); BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: vmLedger(l.lease_id) }); }
    let overlap = '', reached = 0;
    const lostReply = (vm: string, command: string) => { reached++; ssh(vm, command); return { code: 255, out: '', err: 'Connection reset' }; };
    const first = (vm: string, command: string) => {
      if (command.includes("'raise'")) try { raise(c, a.lease_id, 4.5, 'operator B', lostReply); } catch (e) { overlap = (e as Error).message; }
      return ssh(vm, command);
    };
    expect(raise(c, a.lease_id, 5, 'operator A', first)).toMatchObject({ from_usd: 4, to_usd: 5, vm_cap_usd: expect.any(Number) });
    expect(overlap).toMatch(new RegExp(`raise ${a.lease_id} refused: another raise holds ${join(state, 'raise.lock')} \\(pid ${process.pid} on ${hostname()} since .*, raising ${a.lease_id} to \\$5.00\\)\\. One raise runs at a time per freeze`));
    expect(reached).toBe(0);
    expect([leaseUsd(c, a.lease_id), ledgerStatus({ ledgerPath: vmLedger(a.lease_id), runId: a.lease_id }).run!.budget_usd, hostCommitted().committed_usd, raises(state).map(r => r.vm_result ?? 'confirmed')]).toEqual([5, 5, 9, ['confirmed']]);
    expect(() => raise(c, b.lease_id, 4.5, 'past the block', ssh)).toThrow(/block T1 would hold \$9.50, over its \$9.00 cap/);
    expect(existsSync(join(state, 'raise.lock'))).toBe(false);
  });

  test('a held raise lock refuses every raise and is never broken automatically; clear-stale-lock clears it only once its holder is gone and the campaign id is typed out', () => {
    const { c, state, launch, vmLedger, ssh, hostCommitted } = setup();
    const l = launch('cell-0', 'vm-0');
    mkdirSync(join(vmLedger(l.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: vmLedger(l.lease_id) });
    const lockFile = join(state, 'raise.lock');
    const hold = (pid: number) => writeFileSync(lockFile, JSON.stringify({ pid, host: hostname(), started_at: '2026-11-03T00:00:00.000Z', lease_id: l.lease_id, to_usd: 6, reason: 'crashed', dry_run: false }) + '\n');
    const cli = (...args: string[]) => {
      const p = Bun.spawnSync([process.execPath, join(ROOT, 'eval/runner/q1/raise-lease.ts'), 'clear-stale-lock', '--campaign', c.manifestPath, '--state', state, ...args], { stdout: 'pipe', stderr: 'pipe' });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };

    hold(process.pid);
    for (const dryRun of [true, false]) expect(() => raise(c, l.lease_id, 5, 'while held', ssh, { dryRun })).toThrow(/another raise holds .*raise.lock \(pid \d+ on .* since 2026-11-03T00:00:00.000Z, raising .* to \$6.00\)\. One raise runs at a time per freeze, and nothing breaks a held lock\..*the person running the campaign first runs `bun eval\/runner\/q1\/raise-lease.ts show .*` and compares its lease_usd with the VM's budget_usd\. Only if the VM holds more, .*from lease_usd to the VM's amount\. Otherwise the VM does not hold the raise, and they check the host ledger\. It should reserve the lease's usd from show plus each raise of that lease in raises\.ndjson \(to_usd minus from_usd, rounded to the cent; a confirming copy counts once\).*`sqlite3 <ledger> "SELECT reserved_usd FROM entries WHERE id = '<entry_id>'"`.*Only if the host reserves more, a crash left the raise reserved on the host without reaching the VM: they give the difference back on the host ledger in one transaction with `sqlite3 <ledger> "BEGIN IMMEDIATE; UPDATE entries SET reserved_usd = reserved_usd - <difference> WHERE id = '<entry_id>'; .*COMMIT;"`, which changes nothing if it fails\. Otherwise they change nothing, and an unknown raise stands until the lease settles\..*`bun eval\/runner\/q1\/raise-lease.ts clear-stale-lock --campaign .* --confirm raise-\d+`/);
    expect(() => clearStaleLock(c, c.manifest.campaign_id)).toThrow(/held by pid \d+, which is still running on this host/);

    const gone = Bun.spawnSync(['true']).pid;
    hold(gone);
    expect(() => raise(c, l.lease_id, 5, 'stale', ssh)).toThrow(/nothing breaks a held lock/);
    expect(cli('--confirm', 'raise')).toMatchObject({ code: 1, err: expect.stringMatching(/needs --confirm with the campaign id typed out; "raise" is not raise-\d+/) });
    expect(existsSync(lockFile)).toBe(true);
    const cleared = cli('--confirm', c.manifest.campaign_id);
    expect(cleared.code).toBe(0);
    expect(JSON.parse(cleared.out)).toMatchObject({ cleared: lockFile, holder: { pid: gone, lease_id: l.lease_id } });
    expect(() => clearStaleLock(c, c.manifest.campaign_id)).toThrow(/holds no raise lock/);
    expect([hostCommitted().committed_usd, raises(state).length]).toEqual([4, 0]);
    expect(raise(c, l.lease_id, 5, 'after the clear', ssh)).toMatchObject({ from_usd: 4, to_usd: 5 });
    expect(existsSync(lockFile)).toBe(false);
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

  /** A raise during the run, then a final pull that fails: the runner returns and the lease is finished, raised and unsettled. */
  function finishedRaised() {
    const s = setup();
    const l = s.launch('cell-0', 'vm-0');
    mkdirSync(join(s.vmLedger(l.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: s.vmLedger(l.lease_id) });
    raise(s.c, l.lease_id, 4.5, 'owner approved $4.50', s.ssh);
    appendFileSync(join(s.state, 'leases.ndjson'), JSON.stringify({ event: 'finished', lease_id: l.lease_id, at: new Date().toISOString(), exit_code: 253 }) + '\n');
    expect(s.c.lease(l.lease_id)).toMatchObject({ status: 'finished', raised_usd: 4.5 });
    expect([s.c.blockSpend('T1'), s.c.status().unsettled_usd, s.hostCommitted().committed_usd]).toEqual([4.5, 4.5, 4.5]);
    return { ...s, l };
  }

  test('a finished raised lease is abandoned at its raised reservation in leases, block spend and status, as on the host ledger (#196)', () => {
    const { c, l, hostCommitted } = finishedRaised();
    expect(c.abandon(l.lease_id, 'final pull failed')).toMatchObject({ status: 'abandoned', actual_usd: 4.5, note: expect.stringContaining('full reservation of $4.50') });
    expect([c.blockSpend('T1'), c.status().unsettled_usd, hostCommitted().committed_usd]).toEqual([4.5, 4.5, 4.5]);
    expect(() => c.abandon(l.lease_id, 'again')).toThrow(/is already abandoned/);
  });

  test('a finished raised lease closes at $0 only when its launch log shows the cell command never started (#197)', () => {
    const { c, state, l, hostCommitted } = finishedRaised();
    const ran = join(tmp, `launch-ran-${l.lease_id}.log`);
    writeFileSync(ran, 'ubi-runner: creating VM\nubi-runner: running on vm-0\nubi-runner: final pull failed\n');
    expect(() => c.abandon(l.lease_id, 'final pull failed', { log: ran })).toThrow(/shows ubi-runner reached the cell command; the lease cannot be closed at \$0/);
    expect(c.lease(l.lease_id)).toMatchObject({ status: 'finished', raised_usd: 4.5 });
    expect([c.blockSpend('T1'), c.status().unsettled_usd, hostCommitted().committed_usd]).toEqual([4.5, 4.5, 4.5]);
    const never = join(tmp, `launch-never-${l.lease_id}.log`);
    writeFileSync(never, 'ubi-runner: creating VM\nubi-runner: setup failed\n');
    expect(c.abandon(l.lease_id, 'setup failed', { log: never })).toMatchObject({ status: 'abandoned', actual_usd: 0 });
    expect([c.blockSpend('T1'), c.status().unsettled_usd, hostCommitted().committed_usd]).toEqual([0, 0, 0]);
    expect(readFileSync(join(state, 'evidence', `${l.lease_id}.log`), 'utf8')).toBe(readFileSync(never, 'utf8'));
  });
});

describe('raise-lease run from outside the checkout (#326)', () => {
  beforeEach(() => closeLedgers());

  /** The CLI as an operator runs it, from a directory outside the checkout and deeper than it, over a fake ubi-runner whose ssh runs the command in the test's VM home. */
  function fromElsewhere(s: ReturnType<typeof setup>, lease: string) {
    const away = join(tmp, ...ROOT.split(sep).filter(Boolean), 'away');
    mkdirSync(away, { recursive: true });
    expect(relative(ROOT, away).startsWith('..')).toBe(true);
    const runner = join(dirname(s.ledger), 'ubi-runner.sh');
    writeFileSync(runner, `[ "$1" = ssh ] || exit 2\nHOME='${s.home}' exec bash -c "$3"\n`);
    mkdirSync(join(s.vmLedger(lease), '..'), { recursive: true });
    BudgetRun.openLease({ runId: lease, leaseUsd: 4, ledgerPath: s.vmLedger(lease) });
    const run = (usd: string) => {
      const p = Bun.spawnSync([process.execPath, join(ROOT, 'eval/runner/q1/raise-lease.ts'), 'raise', '--campaign', join(dirname(s.ledger), 'manifest.json'), '--state', s.state, '--lease', lease, '--usd', usd, '--reason', 'owner approved'],
        { cwd: away, env: { ...process.env, UBI_RUNNER: runner }, stdout: 'pipe', stderr: 'pipe' });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const record = (ledger: string) => {
      const p = join(s.state, 'campaign.json');
      writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), ledger }, null, 2) + '\n');
    };
    return { away, run, record };
  }

  test('a relative ledger path resolves against the checkout, not the working directory', () => {
    const s = setup();
    const l = s.launch('cell-0', 'vm-0');
    const { away, run } = fromElsewhere(s, l.lease_id);
    const recorded = JSON.parse(readFileSync(join(s.state, 'campaign.json'), 'utf8')).ledger as string;
    expect([isAbsolute(recorded), resolve(ROOT, recorded)]).toEqual([false, s.ledger]);
    expect(existsSync(resolve(away, recorded))).toBe(false);

    const r = run('5');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ lease_id: l.lease_id, from_usd: 4, to_usd: 5 });
    expect(s.hostCommitted().committed_usd).toBe(5);
    expect(ledgerStatus({ ledgerPath: s.vmLedger(l.lease_id), runId: l.lease_id }).run!.budget_usd).toBe(5);
    expect(verifyLedger(s.ledger).ok).toBe(true);
  });

  test('an absolute ledger path is opened as written', () => {
    const s = setup();
    const l = s.launch('cell-0', 'vm-0');
    const { run, record } = fromElsewhere(s, l.lease_id);
    record(s.ledger);

    const r = run('4.5');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ from_usd: 4, to_usd: 4.5 });
    expect(s.hostCommitted().committed_usd).toBe(4.5);
    expect(JSON.parse(readFileSync(join(s.state, 'campaign.json'), 'utf8')).ledger).toBe(s.ledger);
  });

  test('a missing ledger, relative or absolute, refuses the raise and is never created', () => {
    const s = setup();
    const l = s.launch('cell-0', 'vm-0');
    const { away, run, record } = fromElsewhere(s, l.lease_id);
    const gone = join(dirname(s.ledger), 'moved', 'campaign.sqlite');
    for (const recorded of [relative(ROOT, gone), gone]) {
      record(recorded);
      const r = run('5');
      expect(r.code).toBe(1);
      expect(r.err).toContain('raise-lease: unable to open database file');
      expect([existsSync(gone), existsSync(resolve(away, recorded))]).toEqual([false, false]);
    }
    expect(s.hostCommitted().committed_usd).toBe(4);
    expect(ledgerStatus({ ledgerPath: s.vmLedger(l.lease_id), runId: l.lease_id }).run!.budget_usd).toBe(4);
    expect(raises(s.state)).toEqual([]);
  });

  test('a pre-A23 absolute ledger path that is gone from this host resolves to the manifest ledger, as Campaign does', () => {
    const s = setup(Campaign, dir => relative(ROOT, join(dir, 'campaign.sqlite')));
    const l = s.launch('cell-0', 'vm-0');
    mkdirSync(join(s.vmLedger(l.lease_id), '..'), { recursive: true });
    BudgetRun.openLease({ runId: l.lease_id, leaseUsd: 4, ledgerPath: s.vmLedger(l.lease_id) });
    const statePath = join(s.state, 'campaign.json');
    const oldHost = `${join('/old-host', ...ROOT.split(sep).filter(Boolean))}/${s.c.manifest.ledger}`;
    expect(existsSync(oldHost)).toBe(false);
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), ledger: oldHost }, null, 2) + '\n');

    expect(s.c.status().committed_usd).toBe(4);
    expect(raise(s.c, l.lease_id, 5, 'owner approved $5', s.ssh)).toMatchObject({ from_usd: 4, to_usd: 5 });
    expect([s.hostCommitted().committed_usd, s.c.status().committed_usd]).toEqual([5, 5]);
    expect(ledgerStatus({ ledgerPath: s.vmLedger(l.lease_id), runId: l.lease_id }).run!.budget_usd).toBe(5);
  });
});
