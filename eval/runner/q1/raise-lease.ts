#!/usr/bin/env bun
/**
 * Raise a running Q1 lease in place. It lives outside the campaign's hashed
 * tree, so a frozen hash does not change, and it uses only what the A17 tree
 * already has, so it serves wave 1 (eefd1799) and every later freeze alike.
 *
 * Two ledgers hold the lease, and both grow by the same amount:
 *
 *   host  the campaign ledger's reservation for the lease (entries, runs and
 *         program committed), refused once the campaign run is closed or past
 *         the run budget, the campaign cap or the lease's block cap, in one
 *         BEGIN IMMEDIATE transaction
 *   VM    the lease ledger's run budget and its ledger cap, over `ubi-runner ssh`
 *         in one transaction, then read back
 *
 * The VM's metering proxy reads the run budget and the cap from its ledger
 * before every reservation, so the raise binds from the proxy's next call
 * without a restart. A VM step the lease ledger refuses, or one that fails
 * before its COMMIT, gives the host reservation back. A VM step that ends
 * without a result (a timeout, an ssh error, output that does not read back)
 * keeps it, records the raise with vm_result "unknown" so the campaign and its
 * block cap count it, and stops, because the VM may already hold the raise; a
 * person reconciles the two ledgers. A raise is refused when the state
 * directory belongs to another campaign or another freeze (its campaign_id or
 * manifest_sha256 differs from this checkout's campaign), or its lease's cell
 * is not in the manifest, so a block cap is never skipped. Every raise is
 * appended to <state>/raises.ndjson; leases.ndjson is left to the campaign's
 * own events.
 *
 * One raise runs at a time per freeze. A raise holds <state>/raise.lock (its
 * pid, host, start time and arguments) from reading the lease's amount until
 * its record is written, and a held lock refuses a second raise at once. A
 * raise whose record cannot be written keeps the lock. Nothing breaks the lock
 * automatically: after a crash it refuses every raise until the person running
 * the campaign compares the holder lease's amount with the VM's (`show`),
 * records a raise the VM holds but the campaign does not, and runs
 * `clear-stale-lock`, which refuses while the holder's pid is alive on this
 * host and needs the campaign id typed out (eval/RUNBOOK.md, "Raise a running
 * Q1 lease").
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
 *   bun eval/runner/q1/raise-lease.ts clear-stale-lock --campaign <manifest.json> --state <dir> --confirm <campaign id>
 */
import { Database } from 'bun:sqlite';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readLedger } from '../budget-ledger.ts';
import { Campaign, resolveRunner } from '../shootout-cell.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

export interface Raise { lease_id: string; cell: string; at: string; from_usd: number; to_usd: number; reason: string; host_entry: string; vm_ledger: string | null; vm_cap_usd: number | null; vm_result?: 'unknown' }
type Ssh = (vm: string, command: string) => { code: number | null; out: string; err: string };

/** Run on the VM: the lease ledger's run budget and cap grow by the same amount in one transaction, or nothing changes. A refusal, or any failure before the COMMIT, rolls back and exits VM_REFUSED, having changed nothing. */
const VM_REFUSED = 3;
const VM_LEDGER = `
import glob, json, os, sqlite3, sys, datetime, getpass, socket
mode, lease = sys.argv[1], sys.argv[2]
def refuse(why): print(why, file=sys.stderr); sys.exit(${VM_REFUSED})
home = os.path.expanduser('~')
found = glob.glob(f'{home}/custody/{lease}/proxy/lease.sqlite') + glob.glob(f'{home}/work/*/eval/reports/shootout/*/{lease}/lease.sqlite')
if len(found) != 1: refuse(f'expected one lease ledger for {lease}, found {found}')
c = sqlite3.connect(found[0], timeout=60, isolation_level=None)
c.execute('PRAGMA busy_timeout = 60000')
def state():
    run = c.execute('SELECT budget_usd, committed_usd, finished_at FROM runs WHERE run_id = ?', (lease,)).fetchone()
    cap = c.execute('SELECT program_cap_usd FROM caps ORDER BY seq DESC LIMIT 1').fetchone()[0]
    return {'ledger': found[0], 'budget_usd': run[0] if run else None, 'committed_usd': run[1] if run else None, 'finished': bool(run and run[2]), 'cap_usd': cap}
if mode == 'show': print(json.dumps(state())); sys.exit(0)
frm, to, reason = float(sys.argv[3]), float(sys.argv[4]), ' '.join(sys.argv[5:])
try:
    c.execute('BEGIN IMMEDIATE')
    row = c.execute('SELECT budget_usd, finished_at FROM runs WHERE run_id = ?', (lease,)).fetchone()
    if not row or row[1] is not None: c.execute('ROLLBACK'); refuse(f'lease {lease} is not open in {found[0]}')
    if abs(row[0] - frm) > 1e-6: c.execute('ROLLBACK'); refuse(f'lease {lease} is {row[0]} on the VM, not {frm}')
    cap = c.execute('SELECT program_cap_usd FROM caps ORDER BY seq DESC LIMIT 1').fetchone()[0]
    c.execute('UPDATE runs SET budget_usd = ? WHERE run_id = ?', (to, lease))
    c.execute('INSERT INTO caps (program_cap_usd, kind, reason, by, at) VALUES (?, ?, ?, ?, ?)', (round(cap + to - frm, 6), 'set_cap', f'raise lease {lease} to {to}: {reason}', f'{getpass.getuser()}@{socket.gethostname()}', datetime.datetime.now(datetime.timezone.utc).isoformat()))
except Exception as e:
    if c.in_transaction: c.execute('ROLLBACK')
    refuse(f'lease {lease} was not raised, rolled back before COMMIT: {e!r}')
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

interface Holder { pid: number; host: string; started_at: string; lease_id: string; to_usd: number; reason: string; dry_run: boolean }
const lockPath = (c: Campaign) => join(c.stateDir, 'raise.lock');
const holderOf = (path: string) => { try { return JSON.parse(readFileSync(path, 'utf8')) as Holder; } catch { return null; } };

/**
 * What a stale-lock hint states about a lease, read as the hint is printed and never written: the host ledger's
 * reservation for the lease's entry, and whether it is settled, beside the lease's launch amount plus its recorded
 * raises, each rounded to the cent as resizeHost reserved it and a confirming copy counted once.
 */
function measured(c: Campaign, lease: string): string {
  try {
    const l = c.lease(lease);
    const s = JSON.parse(readFileSync(join(c.stateDir, 'campaign.json'), 'utf8')) as { run_id: string; ledger: string };
    const legacy = isAbsolute(s.ledger) && !existsSync(s.ledger) && s.ledger.endsWith(`/${c.manifest.ledger}`);
    const e = readLedger(legacy ? c.ledger : resolve(REPO_ROOT, s.ledger)).entries.find(x => x.id === l.entry_id && x.run_id === s.run_id);
    if (!e) throw new Error(`campaign run ${s.run_id} holds no ledger entry ${l.entry_id}`);
    const same = (a: Raise, b: Raise) => Math.abs(a.from_usd - b.from_usd) <= 1e-9 && Math.abs(a.to_usd - b.to_usd) <= 1e-9;
    const counted = raises(c.stateDir).filter(r => r.lease_id === lease).filter((r, i, mine) => !(i > 0 && same(mine[i - 1], r)));
    const recorded = counted.reduce((n, r) => n + Math.round((r.to_usd - r.from_usd) * 100) / 100, l.usd);
    const diff = e.reserved_usd - recorded;
    return `As read when this was printed: the host ledger reserves ${usd(e.reserved_usd)} for lease ${lease} (ledger entry ${e.id}, ${e.actual_usd === null ? 'still open' : `settled at ${usd(e.actual_usd)}`}), and the lease's launch amount of ${usd(l.usd)} plus its ${counted.length} recorded raise${counted.length === 1 ? '' : 's'} comes to ${usd(recorded)}, so the host holds ${Math.abs(diff) <= 1e-9 ? 'the same' : `${usd(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'}`}`;
  } catch (e) { return `The host ledger's reservation for lease ${lease} could not be read when this was printed (${(e as Error).message})`; }
}

/** The operating rule a held lock refuses with: one raise at a time per freeze, who clears a stale lock, and how. */
const lockRule = (c: Campaign, lease: string) => `One raise runs at a time per freeze, and nothing breaks a held lock. If that raise is still running, let it finish. If it is not, the person running the campaign first runs \`bun eval/runner/q1/raise-lease.ts show --campaign ${c.manifestPath} --state ${c.stateDir} --lease ${lease}\` and compares its lease_usd with the VM's budget_usd. Only if the VM holds more, the raise reached the VM without a record: they append a record for that lease to ${join(c.stateDir, 'raises.ndjson')} from lease_usd to the VM's amount. Otherwise (the VM holds the old amount, or show reads no VM because the lease has closed), they compare the host ledger with the lease. ${measured(c, lease)}. If the host holds more or less than the lease and its recorded raises, or that could not be read, a crash may have left a raise on the host ledger that never reached the VM: they stop there, leave the ledger, raises.ndjson and this lock as they are, and bring these amounts to the campaign owner (GBEV-3 for BG1). Otherwise they change nothing, and an unknown raise stands until the lease settles. Then they clear the lock with \`bun eval/runner/q1/raise-lease.ts clear-stale-lock --campaign ${c.manifestPath} --state ${c.stateDir} --confirm ${c.manifest.campaign_id}\` (eval/RUNBOOK.md, "Raise a running Q1 lease")`;

/** Take the campaign's raise lock, or refuse at once when another raise holds it. Returns its release. */
function lock(c: Campaign, raise: Omit<Holder, 'pid' | 'host' | 'started_at'>): () => void {
  const path = lockPath(c);
  let fd: number;
  try { fd = openSync(path, 'wx'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const h = holderOf(path);
    throw new Error(`raise ${raise.lease_id} refused: another raise holds ${path} (${h ? `pid ${h.pid} on ${h.host} since ${h.started_at}, raising ${h.lease_id} to ${usd(h.to_usd)}` : 'its holder is unreadable'}). ${lockRule(c, h?.lease_id ?? '<the holder lease>')}`);
  }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date().toISOString(), ...raise }) + '\n'); } finally { closeSync(fd); }
  return () => unlinkSync(path);
}

/** Clear a raise lock its holder left behind: refused while the holder's pid is alive on this host, and only with the campaign id typed out. */
export function clearStaleLock(c: Campaign, confirm: string) {
  const owner = (JSON.parse(readFileSync(join(c.stateDir, 'campaign.json'), 'utf8')) as { campaign_id: string }).campaign_id;
  if (confirm !== c.manifest.campaign_id || confirm !== owner) throw new Error(`clear-stale-lock needs --confirm with the campaign id typed out; ${JSON.stringify(confirm)} is not ${owner === c.manifest.campaign_id ? owner : `both ${c.manifest.campaign_id} and ${owner}`}`);
  const path = lockPath(c);
  if (!existsSync(path)) throw new Error(`${c.stateDir} holds no raise lock`);
  const h = holderOf(path);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
  if (h && h.host === hostname() && alive(h.pid)) throw new Error(`${path} is held by pid ${h.pid}, which is still running on this host; let that raise finish`);
  unlinkSync(path);
  return { cleared: path, holder: h };
}

/** Grow (or, with a negative delta, give back) the host reservation of a lease, checked as a reservation is. */
function resizeHost(c: Campaign, entryId: string, delta: number, block: { name: string; cap: number; held: number } | null, what: string) {
  const s = JSON.parse(readFileSync(join(c.stateDir, 'campaign.json'), 'utf8')) as { run_id: string; ledger: string };
  const legacy = isAbsolute(s.ledger) && !existsSync(s.ledger) && s.ledger.endsWith(`/${c.manifest.ledger}`);
  const ledger = legacy ? c.ledger : resolve(REPO_ROOT, s.ledger);
  const db = new Database(ledger, { readwrite: true, create: false, strict: true });
  try {
    db.exec('PRAGMA busy_timeout = 60000');
    db.transaction(() => {
      const entry = db.query('SELECT reserved_usd, actual_usd FROM entries WHERE id = ? AND run_id = ?').get(entryId, s.run_id) as { reserved_usd: number; actual_usd: number | null } | null;
      if (!entry) throw new Error(`${what}: no reservation ${entryId} in ${ledger}`);
      if (entry.actual_usd !== null) throw new Error(`${what}: reservation ${entryId} is already settled`);
      if (delta > 0) {
        const run = db.query('SELECT budget_usd, committed_usd, finished_at FROM runs WHERE run_id = ?').get(s.run_id) as { budget_usd: number; committed_usd: number; finished_at: string | null };
        if (run.finished_at !== null) throw new Error(`${what}: budget run ${s.run_id} already finished`);
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
  const s = JSON.parse(readFileSync(join(c.stateDir, 'campaign.json'), 'utf8')) as { campaign_id: string; manifest_sha256?: string };
  if (s.campaign_id !== c.manifest.campaign_id) throw new Error(`${c.stateDir} belongs to campaign ${s.campaign_id}, not ${c.manifest.campaign_id}; pass one campaign's manifest and state directory`);
  if (s.manifest_sha256 !== c.sha256) throw new Error(`${c.stateDir} was frozen at ${String(s.manifest_sha256).slice(0, 12)}, but campaign ${c.manifest.campaign_id} hashes to ${c.sha256.slice(0, 12)} in this checkout; raise from the freeze's own checkout with that freeze's state directory`);
  const release = lock(c, { lease_id: leaseId, to_usd: toUsd, reason, dry_run: opts.dryRun === true });
  let unrecorded = false;
  try {
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
    const name = c.cell(l.cell).block, cap = name ? (c.manifest as { blocks?: Record<string, { cap_usd: number }> }).blocks?.[name]?.cap_usd : undefined;
    const pending = (r: Raise) => { const x = c.lease(r.lease_id); return x.raised_usd === undefined && x.status !== 'settled' && !(x.status === 'abandoned' && x.actual_usd === 0); };
    const block = name && cap !== undefined ? { name, cap, held: c.blockSpend(name) + raises(c.stateDir).filter(r => blockOf(r.cell) === name && pending(r)).reduce((n, r) => n + r.to_usd - r.from_usd, 0) } : null;
    if (opts.dryRun) {
      if (block && block.held + delta > block.cap + 1e-9) throw new Error(`${what}: block ${block.name} would hold ${usd(block.held + delta)}, over its ${usd(block.cap)} cap`);
      return { dry_run: true, lease_id: leaseId, from_usd: from, to_usd: toUsd, vm: shown };
    }
    resizeHost(c, l.entry_id, delta, block, what);
    const r = ssh(l.vm, vmCommand(['raise', leaseId, String(from), String(toUsd), reason]));
    if (r.code === VM_REFUSED) {
      const refused = `${what}: the VM ledger on ${l.vm} was not raised (exit ${r.code}): ${(r.err || r.out).slice(-400)}`;
      try { resizeHost(c, l.entry_id, -delta, null, `give back ${what}`); } catch (e) {
        throw new Error(`${refused}; giving the host reservation back then failed: ${(e as Error).message}; the host reservation stays at ${usd(toUsd)} with no raise recorded, ${usd(delta)} above the lease's ${usd(from)}, and no raise lock is held. The person running the campaign stops there: they leave the ledger and raises.ndjson as they are, raise this lease no further, and bring these amounts to the campaign owner (GBEV-3 for BG1) (eval/RUNBOOK.md, "Raise a running Q1 lease")`);
      }
      throw new Error(`${refused}; the host reservation is back at ${usd(from)}`);
    }
    const out = r.code === 0 ? lastJson(r.out) as { ledger: string; budget_usd: number; cap_usd: number } | null : null;
    const done = out && Math.abs(out.budget_usd - toUsd) <= 1e-6 ? out : null;
    const rec: Raise = { lease_id: leaseId, cell: l.cell, at: new Date().toISOString(), from_usd: from, to_usd: toUsd, reason, host_entry: l.entry_id, vm_ledger: done?.ledger ?? null, vm_cap_usd: done?.cap_usd ?? null, ...(done ? {} : { vm_result: 'unknown' as const }) };
    try { appendFileSync(join(c.stateDir, 'raises.ndjson'), JSON.stringify(rec) + '\n'); } catch (e) {
      unrecorded = true;
      throw new Error(`${what}: ${done ? `the VM ledger on ${l.vm} was raised` : `the VM step on ${l.vm} ended without a result (exit ${r.code})`}, but the raise could not be recorded in ${join(c.stateDir, 'raises.ndjson')}: ${(e as Error).message}; the host reservation stays at ${usd(toUsd)} and ${lockPath(c)} stays held. ${lockRule(c, leaseId)}`);
    }
    if (!done) throw new Error(`${what}: the VM step on ${l.vm} ended without a result (exit ${r.code}): ${(r.err || r.out).slice(-400)}; the VM ledger may hold either amount, so the host reservation stays at ${usd(toUsd)} and the raise is recorded with vm_result "unknown", which the campaign and its block cap count at ${usd(toUsd)}. Read the VM ledger with \`raise-lease.ts show\` and reconcile the two ledgers by hand before this lease is raised, settled or abandoned (eval/RUNBOOK.md, "Raise a running Q1 lease")`);
    return rec;
  } finally { if (!unrecorded) release(); }
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
  const cmd = argv[0], manifest = one('--campaign'), state = one('--state'), lease = one('--lease') ?? '';
  try {
    if (!manifest || !state || !(cmd === 'clear-stale-lock' || (lease && ['raise', 'show', 'settle'].includes(cmd)))) throw new Error('usage: see the header of eval/runner/q1/raise-lease.ts');
    const c = new Campaign(manifest, resolve(state));
    const runner = resolveRunner();
    const ssh: Ssh = (vm, command) => {
      const p = Bun.spawnSync(['bash', runner, 'ssh', vm, command], { stdout: 'pipe', stderr: 'pipe', env: process.env, timeout: 120_000 });
      return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
    };
    let out: unknown;
    if (cmd === 'clear-stale-lock') out = clearStaleLock(c, one('--confirm') ?? '');
    else if (cmd === 'raise') out = raise(c, lease, Number(one('--usd')), one('--reason') ?? '', ssh, { dryRun: argv.includes('--dry-run') });
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
