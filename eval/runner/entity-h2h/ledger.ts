/**
 * Cell state, the one-writer lock and the ledger reconcile for paid entity-dedupe head-to-head cells (preregistration,
 * "Spend and safety": ledger stops, crash and resume, runner refusals).
 *
 * A paid cell is one folder (--output). cell.json records the cell (system, config, model, world, stop) and every
 * attempt: its namespace or pairs, the paid run that paid for it (budget ledger, run id, usage log, relative to the
 * cell folder when inside it), its status and its spend. The metering proxy is the one ledger writer while an attempt
 * runs; the runner only reads the ledger then. reconcile runs once the proxy is down: it closes any reservation the
 * proxy left open (a crash between reserve and settle) at its full reservation, which is what the ledger already
 * charged against the stop, then checks that every ledger entry of the run has its line in the proxy's usage log and
 * records reconcile.json with a fingerprint of the run's entries. A restart, resume or continue refuses
 * (LEDGER_UNRECONCILED) until every earlier attempt's run has a reconcile record whose fingerprint still matches.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { BudgetRun, readLedger, type LedgerEntry } from '../budget-ledger.ts';
import { RunnerRefusal } from '../runner-refusal.ts';
import type { StackSetting } from './tuning.ts';
import { readUsage } from './world.ts';

export const CELL_FILE = 'cell.json';
export const LOCK_FILE = 'cell.lock';

export type AttemptStatus = 'running' | 'complete' | 'paused' | 'crashed' | 'import_incomplete';
export interface PaidRun { budget_ledger: string; run_id: string; usage_log: string }
export interface Attempt {
  n: number;
  kind: 'first' | 'restart' | 'continue' | 'resume';
  status: AttemptStatus;
  pid: number;
  started_at: string;
  finished_at: string | null;
  paid: PaidRun;
  /** Memory systems: the fresh namespace this attempt ingested into. */
  ns?: string;
  /** Pages (memory systems) or pairs (matcher) this attempt finished. */
  done: number;
  /** Why it stopped: a checkpoint or ledger-stop pause, an error. */
  reason: string | null;
  checkpoint?: { pages: number; usd: number; usd_per_page: number; projected_usd: number; stop_usd: number } | null;
}
export interface CellState {
  cell: 'entity-h2h';
  system: string;
  config: string;
  model: string | null;
  world_dir: string;
  world: { seed: number; per_family: number; pages: number; people_ledger_sha256: string; company_ledger_sha256: string; smoke?: true };
  projected_usd: number;
  stop_usd: number;
  /** complete, failed (infrastructure) after a second failure, or open while attempts may still run. */
  status: 'open' | 'complete' | 'failed (infrastructure)';
  attempts: Attempt[];
  /** gbrain cells: the identity line of the schema pack that declared the person id field. */
  schema_pack?: string;
  /** Memory-system cells: the exact setting the stack must run (tuning.ts); its shim reports it back before each attempt. */
  stack?: StackSetting;
}

export function readCell(dir: string): CellState | null {
  const f = join(dir, CELL_FILE);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as CellState : null;
}
export function writeCell(dir: string, s: CellState): void {
  const f = join(dir, CELL_FILE);
  writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2) + '\n');
  renameSync(`${f}.tmp`, f);
}

/** Paths stored relative to the cell folder, so a cell pulled back from a VM with its state folder still resolves them. */
export const storePath = (dir: string, p: string) => relative(resolve(dir), resolve(p)) || '.';
export const loadPath = (dir: string, p: string) => (isAbsolute(p) ? p : join(dir, p));

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** Takes the cell's one-runner lock; a lock left by a process that is gone is taken over. Returns the release function. */
export function lockCell(dir: string): () => void {
  const f = join(dir, LOCK_FILE);
  if (existsSync(f)) {
    const pid = Number(readFileSync(f, 'utf8').trim());
    if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) throw new Error(`entity-h2h: another runner (pid ${pid}) holds ${f}; a second runner on one cell would be a second spender on its ledger`);
    unlinkSync(f);
  }
  writeFileSync(f, `${process.pid}\n`, { flag: 'wx' });
  return () => { try { if (readFileSync(f, 'utf8').trim() === String(process.pid)) unlinkSync(f); } catch { /* already gone */ } };
}

/** An attempt still marked running whose process is gone crashed; mark it so. */
export function markCrashed(s: CellState): boolean {
  let changed = false;
  for (const a of s.attempts) if (a.status === 'running' && a.pid !== process.pid && !alive(a.pid)) {
    a.status = 'crashed'; a.reason ??= 'the runner process is gone (crash, kill or machine loss)'; a.finished_at ??= new Date().toISOString(); changed = true;
  }
  return changed;
}

const canonicalEntries = (es: LedgerEntry[]) => createHash('sha256').update(JSON.stringify(es.map(e => [e.id, e.reserved_usd, e.actual_usd, e.status]).sort())).digest('hex');

export interface ReconcileRecord {
  run_id: string; at: string; entries: number; log_lines: number; ledger_usd: number; log_usd: number;
  closed_open: Array<{ id: string; reserved_usd: number }>;
  entries_sha256: string;
}
export const reconcilePath = (dir: string, runId: string) => join(dir, `reconcile-${runId.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);

/** The run's entries and the usage-log lines its proxy wrote (request ids `<run>-<n>`; refusals have no entry). */
function runState(paid: PaidRun, dir: string) {
  const entries = readLedger(loadPath(dir, paid.budget_ledger)).entries.filter(e => e.run_id === paid.run_id);
  const lines = readUsage(loadPath(dir, paid.usage_log)).filter(u => u.request_id?.startsWith(`${paid.run_id}-`) && u.outcome !== 'refused');
  return { entries, lines };
}

/**
 * Reconciles one paid run against its proxy's usage log. Refuses while the proxy still answers (it is the run's
 * ledger writer). Open reservations are closed at their full reservation. Throws LEDGER_UNRECONCILED when the usage
 * log holds spend the ledger does not, or more lines than entries.
 */
export async function reconcileRun(dir: string, paid: PaidRun, proxyUrl: string | null): Promise<ReconcileRecord> {
  if (proxyUrl) {
    const up = await fetch(`${proxyUrl.replace(/\/$/, '')}/__proxy/status`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false);
    if (up) throw new Error(`entity-h2h: the metering proxy at ${proxyUrl} still answers; it is the ledger's writer while it runs, so stop it before reconciling`);
  }
  let { entries, lines } = runState(paid, dir);
  const open = entries.filter(e => e.actual_usd === null);
  if (open.length) {
    const run = BudgetRun.join({ runId: paid.run_id, ledgerPath: loadPath(dir, paid.budget_ledger) });
    for (const e of open) run.settle(e.id, null);
    ({ entries, lines } = runState(paid, dir));
  }
  const ledgerUsd = entries.reduce((s, e) => s + (e.actual_usd ?? e.reserved_usd), 0);
  const logUsd = lines.reduce((s, u) => s + (u.actual_usd ?? 0), 0);
  const fix = `run: bun eval/runner/entity-h2h/run.ts reconcile --output ${dir}, after checking the usage log ${paid.usage_log} belongs to run ${paid.run_id}`;
  if (lines.length > entries.length || logUsd > ledgerUsd + 1e-6) {
    throw new RunnerRefusal('LEDGER_UNRECONCILED', `entity-h2h: the usage log holds more than run ${paid.run_id}'s ledger entries`, { ledger_entries: entries.length, log_lines: lines.length, ledger_microusd: Math.round(ledgerUsd * 1e6), log_microusd: Math.round(logUsd * 1e6) }, fix);
  }
  const rec: ReconcileRecord = { run_id: paid.run_id, at: new Date().toISOString(), entries: entries.length, log_lines: lines.length, ledger_usd: ledgerUsd, log_usd: logUsd, closed_open: open.map(e => ({ id: e.id, reserved_usd: e.reserved_usd })), entries_sha256: canonicalEntries(entries) };
  writeFileSync(reconcilePath(dir, paid.run_id), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

/** Refuses (LEDGER_UNRECONCILED) unless every attempt's paid run has a reconcile record that still matches its ledger. Returns their total spend. */
export function requireReconciled(dir: string, s: CellState): number {
  let total = 0;
  const stale: string[] = [];
  for (const a of s.attempts) {
    const f = reconcilePath(dir, a.paid.run_id);
    if (!existsSync(f)) { stale.push(`attempt ${a.n} (run ${a.paid.run_id}) has no reconcile record`); continue; }
    const rec = JSON.parse(readFileSync(f, 'utf8')) as ReconcileRecord;
    const { entries } = runState(a.paid, dir);
    if (entries.some(e => e.actual_usd === null) || canonicalEntries(entries) !== rec.entries_sha256) { stale.push(`attempt ${a.n} (run ${a.paid.run_id}) changed after its reconcile`); continue; }
    total += rec.ledger_usd;
  }
  if (stale.length) throw new RunnerRefusal('LEDGER_UNRECONCILED', `entity-h2h: ${stale.join('; ')}`, { attempts: s.attempts.length, unreconciled: stale.length }, `stop the proxy, then run: bun eval/runner/entity-h2h/run.ts reconcile --output ${dir}`);
  return total;
}

/** Spend of a run so far, read from its ledger (settled cost, else the open reservation). */
export function runSpend(dir: string, paid: PaidRun): number {
  return runState(paid, dir).entries.reduce((s, e) => s + (e.actual_usd ?? e.reserved_usd), 0);
}

/** The budget a run's lease holds in its ledger. */
export function runBudget(dir: string, paid: PaidRun): number {
  const run = readLedger(loadPath(dir, paid.budget_ledger)).runs.find(r => r.run_id === paid.run_id);
  if (!run) throw new Error(`entity-h2h: no paid run ${paid.run_id} in ${paid.budget_ledger}; open the lease first (the metering proxy's --run-id and --lease-usd)`);
  return run.budget_usd;
}
