#!/usr/bin/env bun
/**
 * Raise a running Q1 lease in place. It lives outside the campaign's hashed
 * tree, so a frozen hash does not change, and it uses only what the A17 tree
 * already has, so it serves wave 1 (eefd1799) and every later freeze alike.
 *
 * Two ledgers hold the lease, and both grow by the same amount:
 *
 *   host  the campaign ledger's reservation for the lease (entries, runs and
 *         program committed), refused past the run budget, the campaign cap or
 *         the lease's block cap, in one BEGIN IMMEDIATE transaction
 *   VM    the lease ledger's run budget and its ledger cap, over `ubi-runner ssh`
 *         in one transaction, then read back
 *
 * The VM's metering proxy reads the run budget and the cap from its ledger
 * before every reservation, so the raise binds from the proxy's next call
 * without a restart. A VM step that fails gives the host reservation back.
 * Every raise is appended to <state>/raises.ndjson; leases.ndjson is left to
 * the campaign's own events.
 *
 * Settling needs nothing new for a sealed lease: its VM ledger stays in custody,
 * the pulled lease summary carries the lease as launched, and `settle` settles
 * the grown reservation at the measured spend. `settle` here refuses the one
 * case that would differ (a pulled VM ledger, which carries the raised lease)
 * and otherwise runs the campaign's own settle.
 *
 *   bun eval/runner/q1/raise-lease.ts raise  --campaign <manifest.json> --state <dir> --lease <id> --usd <new lease> --reason "<who approved it and why>" [--dry-run]
 *   bun eval/runner/q1/raise-lease.ts show   --campaign <manifest.json> --state <dir> --lease <id>
 *   bun eval/runner/q1/raise-lease.ts settle --campaign <manifest.json> --state <dir> --lease <id>
 */
import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Campaign, resolveRunner } from '../shootout-cell.ts';

export interface Raise { lease_id: string; cell: string; at: string; from_usd: number; to_usd: number; reason: string; host_entry: string; vm_ledger: string; vm_cap_usd: number }
type Ssh = (vm: string, command: string) => { code: number | null; out: string; err: string };

/** Run on the VM: the lease ledger's run budget and cap grow by the same amount in one transaction, or nothing changes. */
const VM_LEDGER = `
import glob, json, os, sqlite3, sys, datetime, getpass, socket
mode, lease = sys.argv[1], sys.argv[2]
home = os.path.expanduser('~')
found = glob.glob(f'{home}/custody/{lease}/proxy/lease.sqlite') + glob.glob(f'{home}/work/*/eval/reports/shootout/*/{lease}/lease.sqlite')
if len(found) != 1: sys.exit(f'expected one lease ledger for {lease}, found {found}')
c = sqlite3.connect(found[0], timeout=60, isolation_level=None)
c.execute('PRAGMA busy_timeout = 60000')
def state():
    run = c.execute('SELECT budget_usd, committed_usd, finished_at FROM runs WHERE run_id = ?', (lease,)).fetchone()
    cap = c.execute('SELECT program_cap_usd FROM caps ORDER BY seq DESC LIMIT 1').fetchone()[0]
    return {'ledger': found[0], 'budget_usd': run[0] if run else None, 'committed_usd': run[1] if run else None, 'finished': bool(run and run[2]), 'cap_usd': cap}
if mode == 'show': print(json.dumps(state())); sys.exit(0)
frm, to, reason = float(sys.argv[3]), float(sys.argv[4]), ' '.join(sys.argv[5:])
c.execute('BEGIN IMMEDIATE')
row = c.execute('SELECT budget_usd, finished_at FROM runs WHERE run_id = ?', (lease,)).fetchone()
if not row or row[1] is not None: c.execute('ROLLBACK'); sys.exit(f'lease {lease} is not open in {found[0]}')
if abs(row[0] - frm) > 1e-6: c.execute('ROLLBACK'); sys.exit(f'lease {lease} is {row[0]} on the VM, not {frm}')
cap = c.execute('SELECT program_cap_usd FROM caps ORDER BY seq DESC LIMIT 1').fetchone()[0]
c.execute('UPDATE runs SET budget_usd = ? WHERE run_id = ?', (to, lease))
c.execute('INSERT INTO caps (program_cap_usd, kind, reason, by, at) VALUES (?, ?, ?, ?, ?)', (round(cap + to - frm, 6), 'set_cap', f'raise lease {lease} to {to}: {reason}', f'{getpass.getuser()}@{socket.gethostname()}', datetime.datetime.now(datetime.timezone.utc).isoformat()))
c.execute('COMMIT')
print(json.dumps(state()))
`;

const vmCommand = (args: string[]) => `python3 -c "$(echo ${Buffer.from(VM_LEDGER).toString('base64')} | base64 -d)" ${args.map(a => `'${a.replace(/'/g, '')}'`).join(' ')}`;
const lastJson = (s: string) => { try { return JSON.parse(s.split('\n').filter(Boolean).pop() ?? ''); } catch { return null; } };
const usd = (n: number) => `$${n.toFixed(2)}`;

export function raises(stateDir: string): Raise[] {
  const p = join(stateDir, 'raises.ndjson');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Raise) : [];
}

/** The lease's current amount: the last raise, or the amount it launched with. */
export function leaseUsd(c: Campaign, leaseId: string): number {
  return raises(c.stateDir).filter(r => r.lease_id === leaseId).pop()?.to_usd ?? c.lease(leaseId).usd;
}

/** Grow (or, with a negative delta, give back) the host reservation of a lease, checked as a reservation is. */
function resizeHost(c: Campaign, entryId: string, delta: number, block: { name: string; cap: number; held: number } | null, what: string) {
  const s = JSON.parse(readFileSync(join(c.stateDir, 'campaign.json'), 'utf8')) as { run_id: string; ledger: string };
  const db = new Database(s.ledger, { readwrite: true, create: false, strict: true });
  try {
    db.exec('PRAGMA busy_timeout = 60000');
    db.transaction(() => {
      const entry = db.query('SELECT reserved_usd, actual_usd FROM entries WHERE id = ? AND run_id = ?').get(entryId, s.run_id) as { reserved_usd: number; actual_usd: number | null } | null;
      if (!entry) throw new Error(`${what}: no reservation ${entryId} in ${s.ledger}`);
      if (entry.actual_usd !== null) throw new Error(`${what}: reservation ${entryId} is already settled`);
      if (delta > 0) {
        const run = db.query('SELECT budget_usd, committed_usd FROM runs WHERE run_id = ?').get(s.run_id) as { budget_usd: number; committed_usd: number };
        const cap = (db.query('SELECT program_cap_usd FROM caps ORDER BY seq DESC LIMIT 1').get() as { program_cap_usd: number }).program_cap_usd;
        const program = (db.query('SELECT committed_usd FROM program WHERE id = 1').get() as { committed_usd: number }).committed_usd;
        if (run.committed_usd + delta > run.budget_usd + 1e-9) throw new Error(`${what}: the campaign would hold ${usd(run.committed_usd + delta)}, over its ${usd(run.budget_usd)} budget`);
        if (program + delta > cap + 1e-9) throw new Error(`${what}: the campaign ledger would hold ${usd(program + delta)}, over its ${usd(cap)} cap`);
        if (block && block.held + delta > block.cap + 1e-9) throw new Error(`${what}: block ${block.name} would hold ${usd(block.held + delta)}, over its ${usd(block.cap)} cap`);
      }
      db.query('UPDATE entries SET reserved_usd = reserved_usd + ? WHERE id = ?').run(delta, entryId);
      db.query('UPDATE runs SET committed_usd = committed_usd + ? WHERE run_id = ?').run(delta, s.run_id);
      db.query('UPDATE program SET committed_usd = committed_usd + ? WHERE id = 1').run(delta);
    }).immediate();
  } finally { db.close(); }
}

export function raise(c: Campaign, leaseId: string, toUsd: number, reason: string, ssh: Ssh, opts: { dryRun?: boolean } = {}): Raise | { dry_run: true; lease_id: string; from_usd: number; to_usd: number; vm: unknown } {
  const l = c.lease(leaseId);
  if (l.status !== 'launched') throw new Error(`lease ${leaseId} is ${l.status}; only a running (launched) lease is raised in place`);
  if (!l.vm) throw new Error(`lease ${leaseId} has no recorded VM`);
  if (!reason.trim()) throw new Error('raise needs --reason "<who approved it and why>"');
  const from = leaseUsd(c, leaseId);
  const delta = Math.round((toUsd - from) * 100) / 100;
  if (!Number.isFinite(toUsd) || !(delta > 0)) throw new Error(`lease ${leaseId} is ${usd(from)}; --usd must be above it`);
  const what = `raise ${leaseId} from ${usd(from)} to ${usd(toUsd)}`;
  const shown = lastJson(ssh(l.vm, vmCommand(['show', leaseId])).out) as { budget_usd: number | null; finished: boolean } | null;
  if (!shown) throw new Error(`${what}: the VM ledger on ${l.vm} could not be read`);
  if (shown.finished || shown.budget_usd === null || Math.abs(shown.budget_usd - from) > 1e-6) throw new Error(`${what}: the VM ledger holds lease ${shown.budget_usd} (finished: ${shown.finished}), not an open ${usd(from)}`);
  const blockOf = (cellId: string) => (c.manifest.cells.find(x => x.id === cellId) as { block?: string } | undefined)?.block;
  const name = blockOf(l.cell), cap = name ? (c.manifest as { blocks?: Record<string, { cap_usd: number }> }).blocks?.[name]?.cap_usd : undefined;
  const block = name && cap !== undefined ? { name, cap, held: c.blockSpend(name) + raises(c.stateDir).filter(r => blockOf(r.cell) === name && !['settled', 'abandoned'].includes(c.lease(r.lease_id).status)).reduce((n, r) => n + r.to_usd - r.from_usd, 0) } : null;
  if (opts.dryRun) {
    if (block && block.held + delta > block.cap + 1e-9) throw new Error(`${what}: block ${block.name} would hold ${usd(block.held + delta)}, over its ${usd(block.cap)} cap`);
    return { dry_run: true, lease_id: leaseId, from_usd: from, to_usd: toUsd, vm: shown };
  }
  resizeHost(c, l.entry_id, delta, block, what);
  const r = ssh(l.vm, vmCommand(['raise', leaseId, String(from), String(toUsd), reason]));
  const done = r.code === 0 ? lastJson(r.out) as { ledger: string; budget_usd: number; cap_usd: number } | null : null;
  if (!done || Math.abs(done.budget_usd - toUsd) > 1e-6) {
    resizeHost(c, l.entry_id, -delta, null, `give back ${what}`);
    throw new Error(`${what}: the VM ledger on ${l.vm} was not raised (exit ${r.code}): ${(r.err || r.out).slice(-400)}; the host reservation is back at ${usd(from)}`);
  }
  const rec: Raise = { lease_id: leaseId, cell: l.cell, at: new Date().toISOString(), from_usd: from, to_usd: toUsd, reason, host_entry: l.entry_id, vm_ledger: done.ledger, vm_cap_usd: done.cap_usd };
  appendFileSync(join(c.stateDir, 'raises.ndjson'), JSON.stringify(rec) + '\n');
  return rec;
}

/** The campaign's own settle, refused when a pulled VM ledger carries a raised lease the frozen settle would reject. */
export function settle(c: Campaign, leaseId: string) {
  const l = c.lease(leaseId);
  const raised = raises(c.stateDir).some(r => r.lease_id === leaseId);
  if (raised && existsSync(join(c.resultsDir(l), 'lease.sqlite'))) throw new Error(`lease ${leaseId} was raised and its VM ledger was pulled into ${c.resultsDir(l)}; the frozen settle compares that ledger's raised lease with the launch amount. Move lease.sqlite aside (the lease summary settles it) and rerun`);
  return c.settle(leaseId);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const cmd = argv[0], manifest = one('--campaign'), state = one('--state'), lease = one('--lease');
  try {
    if (!manifest || !state || !lease || !['raise', 'show', 'settle'].includes(cmd)) throw new Error('usage: see the header of eval/runner/q1/raise-lease.ts');
    const c = new Campaign(manifest, resolve(state));
    const runner = resolveRunner();
    const ssh: Ssh = (vm, command) => {
      const p = Bun.spawnSync(['bash', runner, 'ssh', vm, command], { stdout: 'pipe', stderr: 'pipe', env: process.env, timeout: 120_000 });
      return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
    };
    let out: unknown;
    if (cmd === 'raise') out = raise(c, lease, Number(one('--usd')), one('--reason') ?? '', ssh, { dryRun: argv.includes('--dry-run') });
    else if (cmd === 'settle') out = settle(c, lease);
    else {
      const l = c.lease(lease);
      out = { lease: l, lease_usd: leaseUsd(c, lease), raises: raises(c.stateDir).filter(r => r.lease_id === lease), vm: l.vm && l.status === 'launched' ? lastJson(ssh(l.vm, vmCommand(['show', lease])).out) : null };
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(`raise-lease: ${(e as Error).message}`);
    process.exit(1);
  }
}
