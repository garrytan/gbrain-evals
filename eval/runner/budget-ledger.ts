/**
 * Paid-run budget ledger.
 *
 * A durable SQLite ledger (bun:sqlite, WAL mode, synchronous=FULL) of every
 * paid request any runner makes. Before a request leaves the process, the
 * runner reserves its worst-case cost; after the response it reconciles the
 * reservation to the provider-reported usage. A reservation that cannot be
 * reconciled (no usage in the response, a network failure after send, a
 * crash) keeps its reserved amount, so the ledger can only overstate spend.
 *
 * Two caps apply to every reservation:
 *   program cap   recorded in the ledger itself when it is created (`init`,
 *                 default $500) and changed only by an explicit `set-cap`;
 *   run budget    --budget-usd (or BRAINBENCH_BUDGET_USD) for this run.
 * A reservation that would cross either cap throws BudgetExceededError and
 * the request is never sent. A run cannot open when its budget exceeds what
 * is left of the program cap. A caller that passes no cap (neither
 * --program-cap-usd nor BRAINBENCH_PROGRAM_CAP_USD) adopts the recorded cap;
 * an explicit cap that disagrees with the recorded one is refused.
 *
 * Every reserve and settle is one `BEGIN IMMEDIATE` transaction, so
 * concurrent runners and joined workers serialize on SQLite's own lock and
 * see each other's spending. The cost of a transaction does not grow with
 * the ledger: per-run and program totals are kept in their own rows. A write
 * that fails (disk full, I/O error, a failed fsync) makes this process refuse
 * all further spending until it restarts.
 *
 * installPaidRequestGuard wraps globalThis.fetch, so every request to a paid
 * provider host is reserved, including SDK retries (each retry is a fetch)
 * and calls gbrain makes internally (write-side extraction, synthesis,
 * embeddings). Cached work that never reaches fetch costs nothing and
 * reserves nothing. Reservations count tool schemas, OpenAI `instructions`,
 * the context an OpenAI `previous_response_id` carries, and the cache-write
 * premium when a request can write the provider's prompt cache.
 *
 * Ledger path: .budget/ledger.sqlite at the repository root (gitignored), or
 * --budget-ledger / BRAINBENCH_BUDGET_LEDGER. A path ending in `.json` means
 * its sibling `.sqlite` ledger. A legacy `ledger.json` (schema 1) beside the
 * ledger migrates once, under both its old lock and the ledger's creation
 * lock: the SQLite file is written and renamed into place, the legacy file is
 * copied to `ledger.json.migrated`, and a tombstone
 * `{"schema_version": 2, "migrated_to": ...}` replaces `ledger.json`, so
 * code from before this change refuses to spend against it.
 *
 * Runbook:
 *   both files present  a real legacy ledger.json beside the SQLite ledger is
 *                       an interrupted migration. If the totals match, run
 *                       `migrate --finish`; if the legacy file has spending
 *                       the SQLite ledger lacks, stop and ask the user.
 *   cap mismatch        unset the override (flag or env) to use the recorded
 *                       cap; run `set-cap` only with the user's authorization.
 * See docs/budget-ledger.md.
 *
 * Shared runs: a wrapper that starts several worker processes (for example
 * longmemeval-batch.sh) opens ONE run with `open` and passes its id to every
 * worker as --budget-run-id (or BRAINBENCH_BUDGET_RUN_ID). Each worker joins
 * that run instead of opening its own, so --budget-usd caps the workers
 * together, across restarted batches too. A joined worker's summary covers
 * only its own requests; only the opener closes the run.
 *
 *   bun eval/runner/budget-ledger.ts init --budget-ledger <path> [--program-cap-usd <n>] [--reason <text>]
 *   bun eval/runner/budget-ledger.ts status [--budget-ledger <path>] [--budget-run-id <id>]
 *   bun eval/runner/budget-ledger.ts verify --budget-ledger <path>
 *   bun eval/runner/budget-ledger.ts set-cap --budget-ledger <path> --program-cap-usd <n> --reason <text>
 *   bun eval/runner/budget-ledger.ts migrate --finish --budget-ledger <path>
 *   bun eval/runner/budget-ledger.ts open --runner <name> --budget-usd <n> [--estimate-usd <n>]
 *   bun eval/runner/budget-ledger.ts close --budget-run-id <id>
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { canonicalLookup } from 'gbrain/core/model-pricing';
import { lookupEmbeddingPrice } from '../../node_modules/gbrain/src/core/embedding-pricing.ts';

export const DEFAULT_PROGRAM_CAP_USD = 500;
export const DEFAULT_LEDGER_PATH = resolve(import.meta.dir, '../../.budget/ledger.sqlite');
const CLI = 'bun eval/runner/budget-ledger.ts';
const LEDGER_FORMAT = 'brainbench-budget-ledger';
const SCHEMA_VERSION = 2;
/** How long a writer waits for another process's transaction before refusing. */
const BUSY_TIMEOUT_MS = 20_000;
const LOCK_WAIT_MS = 60_000;
const LOCK_STALE_MS = 30_000;
/** Status hints at compaction above this size (TODOS.md: ledger compaction). */
const COMPACTION_HINT_BYTES = 100 * 1024 * 1024;

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** A caller mistake (settling an unknown or settled reservation); never a durability failure. */
class LedgerUsageError extends Error {}

export interface LedgerEntry {
  id: string;
  run_id: string;
  description: string;
  reserved_usd: number;
  /** Provider-reported cost; null while open. */
  actual_usd: number | null;
  status: 'reserved' | 'reconciled' | 'charged-reservation';
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  settled_at: string | null;
  /** Process that made the request, when several processes share one run. */
  participant?: string;
}

export interface LedgerRun {
  run_id: string;
  runner: string;
  budget_usd: number;
  estimate_usd: number | null;
  started_at: string;
  finished_at: string | null;
}

/** The pre-SQLite ledger.json (schema 1); read only to migrate it or by `status` before migration. */
export interface LegacyLedgerFile {
  schema_version: 1;
  program_cap_usd: number;
  runs: LedgerRun[];
  entries: LedgerEntry[];
}

/** A full read of the ledger: its recorded program cap, runs and entries. */
export interface LedgerSnapshot {
  program_cap_usd: number | null;
  runs: LedgerRun[];
  entries: LedgerEntry[];
}

/** Spend that counts against a cap: settled actual cost, or the full reservation while unsettled. */
const committed = (e: LedgerEntry) => e.actual_usd ?? e.reserved_usd;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const usd = (n: number) => `$${n.toFixed(2)}`;
const now = () => new Date().toISOString();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Test seams for crash, fault and interleaving tests. Production code never
 * sets them. `beforeCommit` runs inside every write transaction;
 * `afterCapCheck` runs inside `reserve` between the cap check and the write;
 * `migrationStep` runs after each durable migration step.
 */
export const ledgerTestHooks: {
  beforeCommit?: () => void;
  afterCapCheck?: () => void;
  migrationStep?: (step: 'ledger-written' | 'ledger-renamed' | 'legacy-copied' | 'tombstoned') => void;
} = {};

// ─── Paths, files and locks ─────────────────────────────────────────

export interface LedgerPaths {
  /** The SQLite ledger. */
  ledger: string;
  /** Where a pre-SQLite ledger.json would be. */
  legacy: string;
  /** True when the caller named the `.json` path and was mapped to its `.sqlite` sibling. */
  remapped: boolean;
}

export function ledgerPaths(path: string): LedgerPaths {
  const abs = resolve(path);
  if (abs.endsWith('.json')) return { ledger: `${abs.slice(0, -'.json'.length)}.sqlite`, legacy: abs, remapped: true };
  return { ledger: abs, legacy: `${abs.replace(/\.sqlite$/, '')}.json`, remapped: false };
}

const whoami = () => { try { return `${userInfo().username}@${hostname()}`; } catch { return `unknown@${hostname()}`; } };

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeFileDurably(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const fd = openSync(tmp, 'w');
  try {
    const bytes = Buffer.from(text);
    for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  fsyncPath(dirname(path));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

interface LockOwner { pid: number; host: string; nonce: string; created_at: string }
function lockOwner(lock: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(lock, 'utf8'));
    return typeof o?.nonce === 'string' && typeof o?.pid === 'number' ? o as LockOwner : null;
  } catch { return null; }
}

/**
 * An owner-checked lock file, used for ledger creation and migration (SQLite
 * serializes everything else). The file records {pid, host, nonce}. A waiter
 * takes it over only when its owner is a dead process on this host, or when
 * the same owner (same nonce, or for an ownerless lock written by older code,
 * the same mtime) has held it past the stale window. Release removes the lock
 * only while it still carries this holder's nonce.
 */
function withFileLock<T>(lock: string, fn: () => T): T {
  mkdirSync(dirname(lock), { recursive: true });
  const nonce = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  const seen = { key: '', since: 0 };
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      try { writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), nonce, created_at: now() })); fsyncSync(fd); }
      finally { closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = lockOwner(lock);
      let key: string;
      try { key = owner?.nonce ?? `mtime:${statSync(lock).mtimeMs}`; } catch { continue; }
      const deadOwner = owner !== null && owner.host === hostname() && !pidAlive(owner.pid);
      if (seen.key !== key) Object.assign(seen, { key, since: Date.now() });
      const stale = Date.now() - seen.since > LOCK_STALE_MS && !(owner && owner.host === hostname() && pidAlive(owner.pid));
      if (deadOwner || stale) {
        if ((lockOwner(lock)?.nonce ?? `mtime:${(() => { try { return statSync(lock).mtimeMs; } catch { return -1; } })()}`) === key) rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new BudgetExceededError(`budget ledger lock ${lock} has been held for over ${LOCK_WAIT_MS / 1000} s by ${owner ? `pid ${owner.pid} on ${owner.host}` : 'an unknown process'}; another process is creating or migrating the ledger. Retry when it finishes; if no such process exists, ask the user before deleting the lock.`);
      }
      sleepSync(25);
    }
  }
  try { return fn(); }
  finally { if (lockOwner(lock)?.nonce === nonce) rmSync(lock, { force: true }); }
}

type LegacyState =
  | { kind: 'absent' }
  | { kind: 'tombstone'; migrated_to: string }
  | { kind: 'ledger'; file: LegacyLedgerFile }
  | { kind: 'unrecognized'; detail: string };

function legacyState(path: string): LegacyState {
  if (!existsSync(path)) return { kind: 'absent' };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { return { kind: 'unrecognized', detail: `not valid JSON: ${(error as Error).message}` }; }
  if (parsed?.schema_version === SCHEMA_VERSION && typeof parsed.migrated_to === 'string') return { kind: 'tombstone', migrated_to: parsed.migrated_to };
  if (parsed?.schema_version === 1 && Array.isArray(parsed.runs) && Array.isArray(parsed.entries)) return { kind: 'ledger', file: parsed as unknown as LegacyLedgerFile };
  return { kind: 'unrecognized', detail: `schema_version ${JSON.stringify(parsed?.schema_version)}` };
}

function unrecognizedLegacy(paths: LedgerPaths, detail: string): BudgetExceededError {
  return new BudgetExceededError(`unreadable budget ledger at ${paths.legacy} (${detail}): it sits where a legacy ledger.json for ${paths.ledger} would be, and it is neither a schema-1 ledger nor a migration tombstone. Refusing to spend. Stop and ask the user what the file is before moving it.`);
}

const missingLedgerMessage = (ledger: string) =>
  `no budget ledger at ${ledger}. Create it with: ${CLI} init --budget-ledger ${ledger} --program-cap-usd <dollars> --reason "<why>" (ask the user for the cap if you do not know it)`;

// ─── SQLite storage ─────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE caps (seq INTEGER PRIMARY KEY AUTOINCREMENT, program_cap_usd REAL NOT NULL, kind TEXT NOT NULL, reason TEXT, by TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE runs (run_id TEXT PRIMARY KEY, runner TEXT NOT NULL, budget_usd REAL NOT NULL, estimate_usd REAL, started_at TEXT NOT NULL, finished_at TEXT,
  committed_usd REAL NOT NULL DEFAULT 0, overshoot_usd REAL NOT NULL DEFAULT 0);
CREATE TABLE entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, description TEXT NOT NULL,
  reserved_usd REAL NOT NULL, actual_usd REAL, status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
  created_at TEXT NOT NULL, settled_at TEXT, participant TEXT, legacy INTEGER NOT NULL DEFAULT 0);
CREATE INDEX entries_by_run ON entries (run_id, participant);
CREATE TABLE program (id INTEGER PRIMARY KEY CHECK (id = 1), committed_usd REAL NOT NULL, overshoot_usd REAL NOT NULL);
`;

interface Conn { db: Database; dev: number; ino: number }
const conns = new Map<string, Conn>();
/** Ledgers this process stopped spending against after a failed write. */
const failedWrites = new Map<string, string>();

function unreadable(ledger: string, detail: string): BudgetExceededError {
  return new BudgetExceededError(`unreadable budget ledger at ${ledger} (${detail}); refusing to spend without it. Inspect it with: ${CLI} verify --budget-ledger ${ledger} (recovery: docs/budget-ledger.md)`);
}

function checkFormat(db: Database, ledger: string): void {
  let format: { value: string } | null;
  try { format = db.query(`SELECT value FROM ledger_meta WHERE key = 'format'`).get() as { value: string } | null; }
  catch (error) {
    const message = (error as Error).message;
    throw unreadable(ledger, /no such table/.test(message) ? `not a ${LEDGER_FORMAT} file: ${message}` : message);
  }
  if (format?.value !== LEDGER_FORMAT) throw unreadable(ledger, `not a ${LEDGER_FORMAT} file`);
}

/** The process's connection to `ledger`, reopened when the file was replaced. Never creates the file. */
function connect(ledger: string): Conn {
  let st: ReturnType<typeof statSync>;
  try { st = statSync(ledger); }
  catch { conns.get(ledger)?.db.close(); conns.delete(ledger); throw new BudgetExceededError(missingLedgerMessage(ledger)); }
  const cached = conns.get(ledger);
  if (cached && cached.dev === st.dev && cached.ino === st.ino) return cached;
  if (cached) {
    // The file was replaced (restored or moved) under this process. SQLite does not remove the WAL of a moved
    // database on close, so the old WAL would be replayed into the new file: checkpoint it into the old file and
    // truncate it first.
    try { cached.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* the old file is gone; nothing to replay */ }
    cached.db.close();
  }
  conns.delete(ledger);
  let db: Database;
  try {
    db = new Database(ledger, { readwrite: true, create: false, strict: true });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
  } catch (error) { throw unreadable(ledger, (error as Error).message); }
  try { checkFormat(db, ledger); } catch (error) { db.close(); throw error; }
  const conn = { db, dev: st.dev, ino: st.ino };
  conns.set(ledger, conn);
  return conn;
}

/** Close this process's ledger connections (tests, and before a file is moved). */
export function closeLedgers(): void {
  for (const c of conns.values()) c.db.close();
  conns.clear();
  failedWrites.clear();
}

/** One BEGIN IMMEDIATE transaction. A failure other than a refusal stops this process's spending against the ledger. */
function write<T>(ledger: string, what: string, fn: (db: Database) => T): T {
  const failed = failedWrites.get(ledger);
  if (failed) throw new BudgetExceededError(`${what}: an earlier write to the budget ledger ${ledger} failed in this process (${failed}), so it refuses further spending. Restart the run after checking the ledger with: ${CLI} verify --budget-ledger ${ledger}`);
  const { db } = connect(ledger);
  try {
    return db.transaction(() => { const result = fn(db); ledgerTestHooks.beforeCommit?.(); return result; }).immediate();
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof LedgerUsageError) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'SQLITE_BUSY') {
      throw new BudgetExceededError(`${what}: the budget ledger ${ledger} stayed locked by another process for ${BUSY_TIMEOUT_MS / 1000} s; nothing was reserved. Check for a stuck runner (\`${CLI} status --budget-ledger ${ledger}\`) before retrying.`);
    }
    const detail = `${code ? `${code}: ` : ''}${(error as Error).message}`;
    failedWrites.set(ledger, detail);
    throw new BudgetExceededError(`${what}: writing the budget ledger ${ledger} failed (${detail}); this process refuses further spending. Check the ledger with: ${CLI} verify --budget-ledger ${ledger} before restarting.`);
  }
}

const currentCap = (db: Database) => (db.query('SELECT program_cap_usd FROM caps ORDER BY seq DESC LIMIT 1').get() as { program_cap_usd: number }).program_cap_usd;
const programRow = (db: Database) => db.query('SELECT committed_usd, overshoot_usd FROM program WHERE id = 1').get() as { committed_usd: number; overshoot_usd: number };

/**
 * Write a complete ledger file at `ledger`: build it at a temporary path,
 * fsync it, rename it into place and fsync the directory. A crash before the
 * rename leaves no ledger (and the legacy file, if any, untouched).
 */
function buildLedgerFile(ledger: string, cap: { usd: number; kind: 'open' | 'migration'; reason: string }, legacy: LegacyLedgerFile | null, migratedFrom: string | null): void {
  mkdirSync(dirname(ledger), { recursive: true });
  for (const f of readdirSync(dirname(ledger)).sort()) if (f.startsWith(`${basename(ledger)}.building-`)) rmSync(join(dirname(ledger), f), { force: true });
  const tmp = `${ledger}.building-${process.pid}-${randomUUID().slice(0, 8)}`;
  const db = new Database(tmp, { create: true, strict: true });
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA synchronous = FULL');
    db.transaction(() => {
      db.exec(SCHEMA);
      const meta = db.query('INSERT INTO ledger_meta (key, value) VALUES (?, ?)');
      meta.run('format', LEDGER_FORMAT);
      meta.run('schema_version', String(SCHEMA_VERSION));
      meta.run('created_at', now());
      if (migratedFrom) meta.run('migrated_from', migratedFrom);
      db.query('INSERT INTO caps (program_cap_usd, kind, reason, by, at) VALUES (?, ?, ?, ?, ?)').run(cap.usd, cap.kind, cap.reason, whoami(), now());
      const runs = legacy?.runs ?? [];
      const entries = legacy?.entries ?? [];
      const insertRun = db.query('INSERT INTO runs (run_id, runner, budget_usd, estimate_usd, started_at, finished_at, committed_usd, overshoot_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of runs) {
        const mine = entries.filter(e => e.run_id === r.run_id);
        insertRun.run(r.run_id, r.runner, r.budget_usd, r.estimate_usd ?? null, r.started_at, r.finished_at ?? null,
          sum(mine.map(committed)), sum(mine.map(e => Math.max(0, committed(e) - e.reserved_usd))));
      }
      const insertEntry = db.query(`INSERT INTO entries (id, run_id, description, reserved_usd, actual_usd, status, input_tokens, output_tokens, created_at, settled_at, participant, legacy)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
      for (const e of entries) {
        insertEntry.run(e.id, e.run_id, e.description, e.reserved_usd, e.actual_usd, e.status, e.input_tokens ?? null, e.output_tokens ?? null,
          e.created_at, e.settled_at ?? null, e.participant ?? null);
      }
      db.query('INSERT INTO program (id, committed_usd, overshoot_usd) VALUES (1, ?, ?)').run(sum(entries.map(committed)), sum(entries.map(e => Math.max(0, committed(e) - e.reserved_usd))));
    })();
  } finally { db.close(); }
  fsyncPath(tmp);
  ledgerTestHooks.migrationStep?.('ledger-written');
  renameSync(tmp, ledger);
  fsyncPath(dirname(ledger));
}

/** Create a fresh ledger under its creation lock; a no-op when another process created it first. */
function createLedger(paths: LedgerPaths, capUsd: number, reason: string): void {
  withFileLock(`${paths.ledger}.lock`, () => {
    if (existsSync(paths.ledger)) return;
    buildLedgerFile(paths.ledger, { usd: capUsd, kind: 'open', reason }, null, null);
  });
}

function legacyTotals(file: LegacyLedgerFile) {
  return { committed_usd: sum(file.entries.map(committed)), requests: file.entries.length };
}

function sqliteTotals(ledger: string) {
  const { db } = connect(ledger);
  const row = db.query('SELECT COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) AS committed_usd, COUNT(*) AS requests FROM entries').get() as { committed_usd: number; requests: number };
  return row;
}

/** The DX-6 message for a real legacy ledger beside the SQLite ledger. */
function bothPresentMessage(paths: LedgerPaths, file: LegacyLedgerFile): { message: string; totalsMatch: boolean } {
  const legacy = legacyTotals(file);
  const current = sqliteTotals(paths.ledger);
  const totalsMatch = Math.abs(legacy.committed_usd - current.committed_usd) < 0.005 && legacy.requests === current.requests;
  return {
    totalsMatch,
    message: totalsMatch
      ? `both a legacy ledger ${paths.legacy} and the SQLite ledger ${paths.ledger} are present: an interrupted migration (totals match: $${current.committed_usd.toFixed(4)} in ${current.requests} requests). Finish it with: ${CLI} migrate --finish --budget-ledger ${paths.ledger}`
      : `both a legacy ledger ${paths.legacy} ($${legacy.committed_usd.toFixed(4)} in ${legacy.requests} requests) and the SQLite ledger ${paths.ledger} ($${current.committed_usd.toFixed(4)} in ${current.requests} requests) are present and their totals differ: the legacy file has spending the SQLite ledger lacks, or the reverse. Refusing to spend. Stop and ask the user; do not delete or rename either file.`,
  };
}

/** Copy the legacy file to `.migrated`, then atomically replace it with a tombstone (the legacy path is never missing). */
function tombstoneLegacy(paths: LedgerPaths): void {
  const migrated = `${paths.legacy}.migrated`;
  const tmp = `${migrated}.tmp-${process.pid}`;
  copyFileSync(paths.legacy, tmp);
  fsyncPath(tmp);
  renameSync(tmp, migrated);
  fsyncPath(dirname(migrated));
  ledgerTestHooks.migrationStep?.('legacy-copied');
  writeFileDurably(paths.legacy, JSON.stringify({ schema_version: SCHEMA_VERSION, migrated_to: paths.ledger, migrated_at: now(),
    note: 'This ledger moved to SQLite. Use gbrain-evals 0.10.12 or later; see docs/budget-ledger.md.' }, null, 2) + '\n');
  ledgerTestHooks.migrationStep?.('tombstoned');
}

/**
 * Migrate a legacy ledger.json into a new SQLite ledger. Holds the legacy
 * file's lock (the one older code takes) and the ledger's creation lock.
 * The legacy file's program_cap_usd only recorded its last writer's flag, so
 * the migrated ledger records `capUsd` instead.
 */
function migrateLegacy(paths: LedgerPaths, capUsd: number, log: (line: string) => void): void {
  withFileLock(`${paths.legacy}.lock`, () => withFileLock(`${paths.ledger}.lock`, () => {
    const state = legacyState(paths.legacy);
    if (state.kind !== 'ledger') return;
    if (existsSync(paths.ledger)) throw new BudgetExceededError(bothPresentMessage(paths, state.file).message);
    buildLedgerFile(paths.ledger, { usd: capUsd, kind: 'migration', reason: `migrated from ${paths.legacy} (${state.file.entries.length} entries)` }, state.file, paths.legacy);
    ledgerTestHooks.migrationStep?.('ledger-renamed');
    tombstoneLegacy(paths);
    log(`[budget] migrated ${paths.legacy} to ${paths.ledger} (program cap $${capUsd.toFixed(2)}); the old file is kept as ${paths.legacy}.migrated`);
  }));
}

/** Finish an interrupted migration whose totals match (CLI `migrate --finish`). */
export function finishMigration(ledgerPath: string): { ledger: string; legacy: string; migrated: string } {
  const paths = ledgerPaths(ledgerPath);
  withFileLock(`${paths.legacy}.lock`, () => withFileLock(`${paths.ledger}.lock`, () => {
    const state = legacyState(paths.legacy);
    if (state.kind === 'tombstone' || state.kind === 'absent') throw new BudgetExceededError(`nothing to finish: ${paths.legacy} is ${state.kind === 'absent' ? 'absent' : 'already a migration tombstone'}`);
    if (state.kind === 'unrecognized') throw unrecognizedLegacy(paths, state.detail);
    if (!existsSync(paths.ledger)) throw new BudgetExceededError(`nothing to finish: ${paths.ledger} does not exist yet; the next paid run (or \`${CLI} init --budget-ledger ${paths.ledger}\`) migrates ${paths.legacy}`);
    const both = bothPresentMessage(paths, state.file);
    if (!both.totalsMatch) throw new BudgetExceededError(both.message);
    tombstoneLegacy(paths);
  }));
  return { ledger: paths.ledger, legacy: paths.legacy, migrated: `${paths.legacy}.migrated` };
}

/**
 * Make sure the SQLite ledger exists and may be spent against: migrate a
 * legacy file, refuse conflicting or unknown files, and create a missing
 * ledger only when `create` is given.
 */
function ensureLedger(paths: LedgerPaths, options: { migrateCapUsd: number; create: { capUsd: number; reason: string } | null; log?: (line: string) => void }): void {
  const state = legacyState(paths.legacy);
  if (state.kind === 'unrecognized') throw unrecognizedLegacy(paths, state.detail);
  if (existsSync(paths.ledger)) {
    if (state.kind === 'ledger') throw new BudgetExceededError(bothPresentMessage(paths, state.file).message);
    connect(paths.ledger);
    return;
  }
  if (state.kind === 'ledger') { migrateLegacy(paths, options.migrateCapUsd, options.log ?? (l => process.stderr.write(l + '\n'))); connect(paths.ledger); return; }
  if (state.kind === 'tombstone') {
    throw new BudgetExceededError(`${paths.legacy} records that its ledger moved to ${state.migrated_to}, but ${paths.ledger} does not exist. Spending is refused so the recorded spending is not forgotten: stop and ask the user where the ledger went.`);
  }
  if (!options.create) throw new BudgetExceededError(missingLedgerMessage(paths.ledger));
  createLedger(paths, options.create.capUsd, options.create.reason);
  connect(paths.ledger);
}

/** Create a ledger with a recorded program cap, or migrate the legacy file at its path (CLI `init`). */
export function initLedger(options: { ledgerPath: string; programCapUsd?: number | null; reason?: string | null; log?: (line: string) => void }): { ledger: string; created: boolean; migrated: boolean; program_cap_usd: number } {
  const paths = ledgerPaths(options.ledgerPath);
  const capUsd = options.programCapUsd ?? DEFAULT_PROGRAM_CAP_USD;
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new BudgetExceededError('--program-cap-usd must be a positive number of dollars');
  if (existsSync(paths.ledger)) {
    throw new BudgetExceededError(`a budget ledger already exists at ${paths.ledger} (program cap $${currentCap(connect(paths.ledger).db).toFixed(2)}); \`init\` never changes it. See \`${CLI} status --budget-ledger ${paths.ledger}\`; change the cap only with set-cap after the user approves.`);
  }
  const migrating = legacyState(paths.legacy).kind === 'ledger';
  ensureLedger(paths, { migrateCapUsd: capUsd, create: { capUsd, reason: options.reason ?? 'init' }, log: options.log });
  return { ledger: paths.ledger, created: true, migrated: migrating, program_cap_usd: currentCap(connect(paths.ledger).db) };
}

/** Record a new program cap (CLI `set-cap`); refuses a cap below committed spend. */
export function setProgramCap(options: { ledgerPath: string; programCapUsd: number; reason: string }): { ledger: string; program_cap_usd: number; previous_cap_usd: number; committed_usd: number } {
  const paths = ledgerPaths(options.ledgerPath);
  if (!Number.isFinite(options.programCapUsd) || options.programCapUsd <= 0) throw new BudgetExceededError('--program-cap-usd must be a positive number of dollars');
  if (!options.reason?.trim()) throw new BudgetExceededError('set-cap needs --reason "<why the user approved this cap>"');
  const state = legacyState(paths.legacy);
  if (state.kind === 'ledger' && existsSync(paths.ledger)) throw new BudgetExceededError(bothPresentMessage(paths, state.file).message);
  if (!existsSync(paths.ledger)) throw new BudgetExceededError(missingLedgerMessage(paths.ledger));
  return write(paths.ledger, 'set-cap', db => {
    const previous = currentCap(db);
    const program = programRow(db);
    if (options.programCapUsd < program.committed_usd) {
      throw new BudgetExceededError(`refusing a program cap of $${options.programCapUsd.toFixed(2)}: the ledger ${paths.ledger} has already committed $${program.committed_usd.toFixed(2)}`);
    }
    db.query('INSERT INTO caps (program_cap_usd, kind, reason, by, at) VALUES (?, ?, ?, ?, ?)').run(options.programCapUsd, 'set_cap', options.reason, whoami(), now());
    return { ledger: paths.ledger, program_cap_usd: options.programCapUsd, previous_cap_usd: previous, committed_usd: program.committed_usd };
  });
}

// ─── Readers ────────────────────────────────────────────────────────

const ENTRY_COLUMNS = 'id, run_id, description, reserved_usd, actual_usd, status, input_tokens, output_tokens, created_at, settled_at, participant';
const RUN_COLUMNS = 'run_id, runner, budget_usd, estimate_usd, started_at, finished_at';

/**
 * Read-only snapshot of the ledger at `ledgerPath`. Before migration it reads
 * the legacy ledger.json (with no recorded cap); a missing ledger reads as
 * empty. It never creates or migrates anything.
 */
export function readLedger(ledgerPath: string = DEFAULT_LEDGER_PATH): LedgerSnapshot {
  const paths = ledgerPaths(ledgerPath);
  if (!existsSync(paths.ledger)) {
    const state = legacyState(paths.legacy);
    if (state.kind === 'ledger') return { program_cap_usd: null, runs: state.file.runs, entries: state.file.entries };
    return { program_cap_usd: null, runs: [], entries: [] };
  }
  const { db } = connect(paths.ledger);
  const entries = (db.query(`SELECT ${ENTRY_COLUMNS} FROM entries ORDER BY seq`).all() as Array<LedgerEntry & { participant: string | null }>)
    .map(({ participant, ...e }) => (participant === null ? e : { ...e, participant }));
  return { program_cap_usd: currentCap(db), runs: db.query(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY rowid`).all() as LedgerRun[], entries };
}

export interface LedgerTotals {
  /** The recorded program cap; null before the ledger exists (or before a legacy file migrates). */
  program_cap_usd: number | null;
  committed_usd: number;
  reconciled_usd: number;
  open_reservations_usd: number;
  remaining_usd: number | null;
  requests: number;
  /** Settled cost above the reservation, summed over requests (see priceRequest). */
  overshoot_usd: number;
}

export function ledgerTotals(ledger: LedgerSnapshot): LedgerTotals {
  const committedUsd = sum(ledger.entries.map(committed));
  return {
    program_cap_usd: ledger.program_cap_usd,
    committed_usd: committedUsd,
    reconciled_usd: sum(ledger.entries.filter(e => e.actual_usd !== null).map(e => e.actual_usd!)),
    open_reservations_usd: sum(ledger.entries.filter(e => e.actual_usd === null).map(e => e.reserved_usd)),
    remaining_usd: ledger.program_cap_usd === null ? null : ledger.program_cap_usd - committedUsd,
    requests: ledger.entries.length,
    overshoot_usd: sum(ledger.entries.map(e => Math.max(0, committed(e) - e.reserved_usd))),
  };
}

export type LedgerRunStatus = LedgerRun & { committed_usd: number; remaining_usd: number; overshoot_usd: number };

export interface LedgerStatus {
  ledger: string;
  /** sqlite: the ledger exists; legacy: only an unmigrated ledger.json; conflict: both; missing: neither. */
  state: 'sqlite' | 'legacy' | 'conflict' | 'missing';
  totals: LedgerTotals;
  run: LedgerRunStatus | null;
  runs: number;
  open_runs: number;
  last_cap_change: { program_cap_usd: number; kind: string; reason: string | null; by: string; at: string } | null;
  size_bytes: number | null;
  read_ms: number;
  hints: string[];
}

const RUNBOOK_HINTS = [
  'both files present: a real legacy ledger.json beside the SQLite ledger is an interrupted migration; if the totals match run `migrate --finish`, otherwise stop and ask the user',
  'cap mismatch: unset --program-cap-usd / BRAINBENCH_PROGRAM_CAP_USD to use the recorded cap; run `set-cap` only with the user\'s authorization',
];

/** Read-only status of the ledger at `ledgerPath`, plus one run when `runId` names it. Never creates or migrates. */
export function ledgerStatus(options: { ledgerPath?: string; runId?: string | null } = {}): LedgerStatus {
  const t0 = performance.now();
  const paths = ledgerPaths(options.ledgerPath ?? DEFAULT_LEDGER_PATH);
  const legacy = legacyState(paths.legacy);
  const exists = existsSync(paths.ledger);
  const hints: string[] = [];
  let state: LedgerStatus['state'];
  let snapshotRuns: LedgerRun[] = [];
  let totals: LedgerTotals;
  let lastCap: LedgerStatus['last_cap_change'] = null;
  let run: LedgerRunStatus | null = null;
  if (exists) {
    state = legacy.kind === 'ledger' ? 'conflict' : 'sqlite';
    if (legacy.kind === 'ledger') hints.push(bothPresentMessage(paths, legacy.file).message);
    if (legacy.kind === 'unrecognized') hints.push(unrecognizedLegacy(paths, legacy.detail).message);
    const { db } = connect(paths.ledger);
    const cap = currentCap(db);
    const agg = db.query(`SELECT COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) AS committed_usd, COALESCE(SUM(actual_usd), 0) AS reconciled_usd,
      COALESCE(SUM(CASE WHEN actual_usd IS NULL THEN reserved_usd ELSE 0 END), 0) AS open_usd, COUNT(*) AS requests FROM entries`).get() as { committed_usd: number; reconciled_usd: number; open_usd: number; requests: number };
    const program = programRow(db);
    totals = { program_cap_usd: cap, committed_usd: agg.committed_usd, reconciled_usd: agg.reconciled_usd, open_reservations_usd: agg.open_usd,
      remaining_usd: cap - agg.committed_usd, requests: agg.requests, overshoot_usd: program.overshoot_usd };
    snapshotRuns = db.query(`SELECT ${RUN_COLUMNS} FROM runs`).all() as LedgerRun[];
    lastCap = db.query('SELECT program_cap_usd, kind, reason, by, at FROM caps ORDER BY seq DESC LIMIT 1').get() as LedgerStatus['last_cap_change'];
    if (options.runId) {
      const r = db.query(`SELECT ${RUN_COLUMNS}, committed_usd, overshoot_usd FROM runs WHERE run_id = ?`).get(options.runId) as (LedgerRun & { committed_usd: number; overshoot_usd: number }) | null;
      if (r) run = { ...r, remaining_usd: r.budget_usd - r.committed_usd };
    }
  } else {
    if (legacy.kind === 'ledger') {
      state = 'legacy';
      hints.push(`only an unmigrated legacy ledger exists at ${paths.legacy}; the next paid run, or \`${CLI} init --budget-ledger ${paths.ledger} --program-cap-usd <dollars>\`, migrates it and records the cap (the legacy file's own cap is not carried over)`);
    } else {
      state = 'missing';
      hints.push(legacy.kind === 'tombstone'
        ? `${paths.legacy} says the ledger moved to ${legacy.migrated_to}, which does not exist: stop and ask the user`
        : legacy.kind === 'unrecognized' ? unrecognizedLegacy(paths, legacy.detail).message : missingLedgerMessage(paths.ledger));
    }
    const snapshot = readLedger(paths.ledger);
    snapshotRuns = snapshot.runs;
    totals = ledgerTotals(snapshot);
    const r = options.runId ? snapshot.runs.find(x => x.run_id === options.runId) : undefined;
    if (r) {
      const mine = snapshot.entries.filter(e => e.run_id === r.run_id);
      const c = sum(mine.map(committed));
      run = { ...r, committed_usd: c, remaining_usd: r.budget_usd - c, overshoot_usd: sum(mine.map(e => Math.max(0, committed(e) - e.reserved_usd))) };
    }
  }
  const size = exists ? statSync(paths.ledger).size + (existsSync(`${paths.ledger}-wal`) ? statSync(`${paths.ledger}-wal`).size : 0) : null;
  if (size !== null && size > COMPACTION_HINT_BYTES) hints.push(`the ledger is ${(size / 1e6).toFixed(0)} MB; compaction is not implemented yet (TODOS.md), but reads stay constant-time`);
  return {
    ledger: paths.ledger, state, totals, run, runs: snapshotRuns.length, open_runs: snapshotRuns.filter(r => r.finished_at === null).length,
    last_cap_change: lastCap, size_bytes: size, read_ms: Number((performance.now() - t0).toFixed(2)), hints: [...hints, ...RUNBOOK_HINTS],
  };
}

export interface VerifyReport {
  ledger: string;
  ok: boolean;
  problems: string[];
  totals: { committed_usd: number; requests: number; program_cap_usd: number | null } | null;
}

/**
 * Read-only check (CLI `verify`): SQLite's integrity check, the format
 * marker, and that the stored per-run and program totals equal the sums of
 * their entries. Recovery: docs/budget-ledger.md.
 */
export function verifyLedger(ledgerPath: string): VerifyReport {
  const paths = ledgerPaths(ledgerPath);
  const problems: string[] = [];
  if (!existsSync(paths.ledger)) return { ledger: paths.ledger, ok: false, problems: [missingLedgerMessage(paths.ledger)], totals: null };
  let db: Database | null = null;
  try {
    db = new Database(paths.ledger, { readonly: true, strict: true });
    const integrity = (db.query('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map(r => r.integrity_check);
    if (!(integrity.length === 1 && integrity[0] === 'ok')) problems.push(...integrity.slice(0, 20).map(x => `integrity: ${x}`));
    const format = db.query(`SELECT value FROM ledger_meta WHERE key = 'format'`).get() as { value: string } | null;
    if (format?.value !== LEDGER_FORMAT) problems.push(`not a ${LEDGER_FORMAT} file`);
    const runs = db.query(`SELECT r.run_id, r.committed_usd AS stored, COALESCE(SUM(COALESCE(e.actual_usd, e.reserved_usd)), 0) AS summed
      FROM runs r LEFT JOIN entries e ON e.run_id = r.run_id GROUP BY r.run_id`).all() as Array<{ run_id: string; stored: number; summed: number }>;
    for (const r of runs) if (Math.abs(r.stored - r.summed) > 1e-6) problems.push(`run ${r.run_id}: stored committed $${r.stored.toFixed(6)} but its entries sum to $${r.summed.toFixed(6)}`);
    const totals = db.query('SELECT COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) AS committed_usd, COUNT(*) AS requests FROM entries').get() as { committed_usd: number; requests: number };
    const program = db.query('SELECT committed_usd FROM program WHERE id = 1').get() as { committed_usd: number } | null;
    if (!program || Math.abs(program.committed_usd - totals.committed_usd) > 1e-6) problems.push(`program total $${program?.committed_usd ?? 'missing'} differs from the entries' $${totals.committed_usd.toFixed(6)}`);
    const orphans = (db.query('SELECT COUNT(*) AS n FROM entries WHERE run_id NOT IN (SELECT run_id FROM runs)').get() as { n: number }).n;
    if (orphans) problems.push(`${orphans} entries name no run`);
    const cap = db.query('SELECT program_cap_usd FROM caps ORDER BY seq DESC LIMIT 1').get() as { program_cap_usd: number } | null;
    if (!cap) problems.push('no recorded program cap');
    return { ledger: paths.ledger, ok: problems.length === 0, problems, totals: { ...totals, program_cap_usd: cap?.program_cap_usd ?? null } };
  } catch (error) {
    problems.push(`${(error as { code?: string }).code ?? 'error'}: ${(error as Error).message}`);
    return { ledger: paths.ledger, ok: false, problems, totals: null };
  } finally { db?.close(); }
}

// ─── Event-loop lag ─────────────────────────────────────────────────

export interface LagStats { p50: number; p99: number; max: number }

/**
 * Samples event-loop lag: a timer that should fire every `intervalMs`
 * records how late it fired. A synchronous stall on the loop (a ledger
 * write, a tar extraction) shows up as one late tick. One-millisecond
 * buckets up to 60 s keep memory constant over a long run.
 */
export class LagMonitor {
  private buckets = new Uint32Array(60_001);
  private samples = 0;
  private max = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private expected = 0;
  constructor(readonly intervalMs = 10) {}
  start(): this {
    this.expected = performance.now() + this.intervalMs;
    this.timer = setInterval(() => {
      const t = performance.now();
      const lag = Math.max(0, t - this.expected);
      this.buckets[Math.min(this.buckets.length - 1, Math.floor(lag))]++;
      this.samples++;
      this.max = Math.max(this.max, lag);
      this.expected = t + this.intervalMs;
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    return this;
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  stats(): LagStats | null {
    if (this.samples === 0) return null;
    const at = (q: number) => {
      const target = Math.ceil(q * this.samples);
      let seen = 0;
      for (let i = 0; i < this.buckets.length; i++) { seen += this.buckets[i]; if (seen >= target) return i; }
      return this.buckets.length - 1;
    };
    return { p50: at(0.5), p99: at(0.99), max: Number(this.max.toFixed(1)) };
  }
}

// ─── Runs ───────────────────────────────────────────────────────────

export interface RunSummary {
  run_id: string;
  budget_usd: number;
  reserved_usd: number;
  actual_usd: number;
  /** Requests whose cost was charged at the reservation because usage was unavailable. */
  charged_reservations: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  /** Settled cost above the reservation (a reservation that undercounted); already counted in actual_usd. */
  overshoot_usd: number;
  ledger_path: string;
  program_cap_usd: number;
  /** This process's event-loop lag while the run was open; null with a reason when it was not measured. */
  event_loop_lag_ms: LagStats | null;
  event_loop_lag_unavailable?: string;
  /** Set when closing the run failed; the summary is still a read of the ledger. */
  close_error?: string;
}

/** Where a requested program cap came from, for refusal messages. */
export type CapSource = '--program-cap-usd' | 'BRAINBENCH_PROGRAM_CAP_USD' | 'the caller';

interface CapOptions {
  /** An explicit cap that must equal the recorded one; null adopts the recorded cap. */
  programCapUsd?: number | null;
  programCapSource?: CapSource | null;
  /** An upper limit (a campaign manifest's cap): refuse when the recorded cap is higher. */
  programCapMaxUsd?: number | null;
}

function checkCap(db: Database, ledger: string, options: CapOptions): void {
  const recorded = currentCap(db);
  const requested = options.programCapUsd ?? null;
  if (requested !== null && Math.abs(requested - recorded) > 1e-9) {
    const source = options.programCapSource ?? 'the caller';
    const fix = source === 'BRAINBENCH_PROGRAM_CAP_USD'
      ? 'Unset BRAINBENCH_PROGRAM_CAP_USD (with no cap given, the recorded cap applies)'
      : source === '--program-cap-usd' ? 'Drop --program-cap-usd (with no cap given, the recorded cap applies)' : 'Pass no program cap to use the recorded one';
    throw new BudgetExceededError(`program cap mismatch for ${ledger}: the ledger records $${recorded.toFixed(2)}, but ${source} asks for $${requested.toFixed(2)}. ${fix}, or, only after the user approves the new cap, run: ${CLI} set-cap --budget-ledger ${ledger} --program-cap-usd ${requested} --reason "<why>"`);
  }
  if (options.programCapMaxUsd != null && recorded > options.programCapMaxUsd + 1e-9) {
    throw new BudgetExceededError(`the ledger ${ledger} records a program cap of $${recorded.toFixed(2)}, above this campaign's limit of $${options.programCapMaxUsd.toFixed(2)}. Use a ledger whose cap is within the limit (\`${CLI} init --budget-ledger <new path> --program-cap-usd ${options.programCapMaxUsd}\`), or ask the user.`);
  }
}

export class BudgetRun {
  private lag: LagMonitor | null = null;
  private constructor(
    readonly runId: string,
    readonly budgetUsd: number,
    /** The resolved SQLite ledger path. */
    readonly ledgerPath: string,
    /** Set when this process joined a run another process opened. */
    readonly participant: string | null = null,
  ) {}

  /** The program cap recorded in the ledger now. */
  get programCapUsd(): number { return currentCap(connect(this.ledgerPath).db); }

  /** Join an open run another process started; reservations count against that run's budget. */
  static join(options: { runId: string; ledgerPath?: string; log?: (line: string) => void } & CapOptions): BudgetRun {
    const paths = ledgerPaths(options.ledgerPath ?? DEFAULT_LEDGER_PATH);
    ensureLedger(paths, { migrateCapUsd: options.programCapUsd ?? options.programCapMaxUsd ?? DEFAULT_PROGRAM_CAP_USD, create: null, log: options.log });
    const { db } = connect(paths.ledger);
    checkCap(db, paths.ledger, options);
    const run = db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`).get(options.runId) as LedgerRun | null;
    if (!run) throw new BudgetExceededError(`no budget run ${options.runId} in ${paths.ledger}`);
    if (run.finished_at !== null) throw new BudgetExceededError(`budget run ${options.runId} already finished`);
    return new BudgetRun(run.run_id, run.budget_usd, paths.ledger, `${process.pid}-${randomUUID().slice(0, 8)}`);
  }

  /**
   * Open a run, refusing when its budget exceeds what is left of the program
   * cap. A missing ledger is created only with an explicit cap (or a
   * campaign limit), or at the default path with the $500 default.
   */
  static open(options: { runner: string; budgetUsd: number; estimateUsd?: number | null; ledgerPath?: string; log?: (line: string) => void } & CapOptions): BudgetRun {
    const paths = ledgerPaths(options.ledgerPath ?? DEFAULT_LEDGER_PATH);
    if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) throw new BudgetExceededError('--budget-usd must be a positive number of dollars');
    if (options.estimateUsd != null && options.estimateUsd > options.budgetUsd) {
      throw new BudgetExceededError(`estimated cost $${options.estimateUsd.toFixed(2)} exceeds --budget-usd $${options.budgetUsd.toFixed(2)}`);
    }
    const explicitCap = options.programCapUsd ?? options.programCapMaxUsd ?? null;
    const createCap = explicitCap ?? (paths.ledger === DEFAULT_LEDGER_PATH ? DEFAULT_PROGRAM_CAP_USD : null);
    ensureLedger(paths, {
      migrateCapUsd: explicitCap ?? DEFAULT_PROGRAM_CAP_USD,
      create: createCap === null ? null : { capUsd: createCap, reason: `created by ${options.runner}` },
      log: options.log,
    });
    const runId = `${options.runner}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    write(paths.ledger, `open ${options.runner}`, db => {
      checkCap(db, paths.ledger, options);
      const cap = currentCap(db);
      const remaining = cap - programRow(db).committed_usd;
      if (options.budgetUsd > remaining) {
        throw new BudgetExceededError(`run budget $${options.budgetUsd.toFixed(2)} exceeds the $${remaining.toFixed(2)} left of the $${cap.toFixed(2)} program cap (${paths.ledger})`);
      }
      db.query(`INSERT INTO runs (${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, NULL)`).run(runId, options.runner, options.budgetUsd, options.estimateUsd ?? null, now());
    });
    return new BudgetRun(runId, options.budgetUsd, paths.ledger);
  }

  /** Measure this process's event-loop lag for the run's summary; close() stops it. */
  attachLagMonitor(monitor: LagMonitor): void { this.lag = monitor; }

  /** Reserve before sending. Throws BudgetExceededError, and records nothing, when either cap would be crossed. */
  reserve(usd: number, description: string): string {
    if (!Number.isFinite(usd) || usd < 0) throw new BudgetExceededError(`cannot reserve a non-finite or negative cost for ${description}`);
    const id = randomUUID();
    write(this.ledgerPath, description, db => {
      const run = db.query('SELECT budget_usd, committed_usd FROM runs WHERE run_id = ?').get(this.runId) as { budget_usd: number; committed_usd: number } | null;
      if (!run) throw new BudgetExceededError(`${description}: budget run ${this.runId} is not in ${this.ledgerPath}`);
      const cap = currentCap(db);
      const programCommitted = programRow(db).committed_usd;
      ledgerTestHooks.afterCapCheck?.();
      if (run.committed_usd + usd > run.budget_usd) {
        throw new BudgetExceededError(`${description}: reserving $${usd.toFixed(4)} would take this run to $${(run.committed_usd + usd).toFixed(4)}, over its $${run.budget_usd.toFixed(2)} budget`);
      }
      if (programCommitted + usd > cap) {
        throw new BudgetExceededError(`${description}: reserving $${usd.toFixed(4)} would take the program to $${(programCommitted + usd).toFixed(4)}, over its $${cap.toFixed(2)} cap (${this.ledgerPath})`);
      }
      db.query(`INSERT INTO entries (id, run_id, description, reserved_usd, actual_usd, status, input_tokens, output_tokens, created_at, settled_at, participant)
        VALUES (?, ?, ?, ?, NULL, 'reserved', NULL, NULL, ?, NULL, ?)`).run(id, this.runId, description, usd, now(), this.participant);
      db.query('UPDATE runs SET committed_usd = committed_usd + ? WHERE run_id = ?').run(usd, this.runId);
      db.query('UPDATE program SET committed_usd = committed_usd + ? WHERE id = 1').run(usd);
    });
    return id;
  }

  /**
   * Settle a reservation. With a measured cost the entry is reconciled; with
   * null the reservation itself is charged (usage unknown: never undercount).
   * A measured cost above the reservation is recorded as overshoot.
   */
  settle(id: string, actual: { usd: number; input_tokens?: number | null; output_tokens?: number | null } | null): void {
    write(this.ledgerPath, `settle ${id}`, db => {
      const entry = db.query('SELECT reserved_usd, actual_usd FROM entries WHERE id = ? AND run_id = ?').get(id, this.runId) as { reserved_usd: number; actual_usd: number | null } | null;
      if (!entry) throw new LedgerUsageError(`unknown budget reservation ${id}`);
      if (entry.actual_usd !== null) throw new LedgerUsageError(`budget reservation ${id} already settled`);
      const cost = actual ? actual.usd : entry.reserved_usd;
      const delta = cost - entry.reserved_usd;
      const over = Math.max(0, delta);
      db.query('UPDATE entries SET actual_usd = ?, status = ?, input_tokens = ?, output_tokens = ?, settled_at = ? WHERE id = ?')
        .run(cost, actual ? 'reconciled' : 'charged-reservation', actual?.input_tokens ?? null, actual?.output_tokens ?? null, now(), id);
      db.query('UPDATE runs SET committed_usd = committed_usd + ?, overshoot_usd = overshoot_usd + ? WHERE run_id = ?').run(delta, over, this.runId);
      db.query('UPDATE program SET committed_usd = committed_usd + ?, overshoot_usd = overshoot_usd + ? WHERE id = 1').run(delta, over);
    });
  }

  /** Reserve an allowance for many small requests at once; see BudgetAllowance. */
  allowance(usd: number, description: string): BudgetAllowance {
    return new BudgetAllowance(this, this.reserve(usd, `${description} (allowance)`), usd, description);
  }

  summary(): RunSummary {
    const { db } = connect(this.ledgerPath);
    const where = this.participant === null ? 'run_id = ?' : 'run_id = ? AND participant = ?';
    const row = db.query(`SELECT COALESCE(SUM(reserved_usd), 0) AS reserved_usd, COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) AS actual_usd,
      COALESCE(SUM(CASE WHEN status = 'reconciled' THEN 0 ELSE 1 END), 0) AS charged_reservations, COUNT(*) AS requests,
      COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS input_tokens, COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens,
      COALESCE(SUM(MAX(0, COALESCE(actual_usd, reserved_usd) - reserved_usd)), 0) AS overshoot_usd FROM entries WHERE ${where}`)
      .get(...(this.participant === null ? [this.runId] : [this.runId, this.participant])) as Omit<RunSummary, 'run_id' | 'budget_usd' | 'ledger_path' | 'program_cap_usd' | 'event_loop_lag_ms'>;
    const lag = this.lag?.stats() ?? null;
    return {
      run_id: this.runId, budget_usd: this.budgetUsd, ...row, ledger_path: this.ledgerPath, program_cap_usd: currentCap(db),
      event_loop_lag_ms: lag,
      ...(lag ? {} : { event_loop_lag_unavailable: this.lag ? 'no lag samples were taken (the run closed within one sampling interval)' : 'no lag monitor: the run was not started through startPaidRun' }),
    };
  }

  /**
   * Stop the lag monitor and summarize. The opener also marks the run
   * finished; `finish: false` leaves it open for a resume to join, and
   * `finish: true` lets a joined process that completed the work finish it.
   */
  close(options: { finish?: boolean } = {}): RunSummary {
    let closeError: string | null = null;
    try {
      if (options.finish ?? this.participant === null) closeRun(this.ledgerPath, this.runId);
    } catch (error) { closeError = (error as Error).message; }
    finally { this.lag?.stop(); }
    const summary = this.summary();
    return closeError ? { ...summary, close_error: closeError } : summary;
  }
}

/** Mark a run finished (idempotent). */
export function closeRun(ledgerPath: string, runId: string): void {
  write(ledgerPaths(ledgerPath).ledger, `close ${runId}`, db => { db.query('UPDATE runs SET finished_at = COALESCE(finished_at, ?) WHERE run_id = ?').run(now(), runId); });
}

/**
 * One ledger reservation that covers many requests. Requests made inside
 * `allowance.run(fn)` are charged against the allowance in memory instead of
 * one ledger transaction each: a request whose reservation would take the
 * allowance past its amount throws BudgetExceededError and is not sent, so
 * spending stays inside a sum the ledger already checked against both caps.
 * `close()` settles the ledger entry with the measured total (requests
 * without usage count at their reservation).
 */
export class BudgetAllowance {
  spent_usd = 0;
  private pending_usd = 0;
  requests = 0;
  charged_reservations = 0;
  input_tokens = 0;
  output_tokens = 0;
  private closed = false;
  constructor(readonly budget: BudgetRun, readonly id: string, readonly usd: number, readonly description: string) {}
  /** Run `fn` with its paid requests charged to this allowance. */
  run<T>(fn: () => Promise<T>): Promise<T> { return allowanceScope.run(this, fn); }
  hold(usd: number, what: string) {
    if (this.closed) throw new BudgetExceededError(`${what}: allowance ${this.description} is closed`);
    if (this.spent_usd + this.pending_usd + usd > this.usd) throw new BudgetExceededError(`${what}: reserving $${usd.toFixed(6)} would take allowance ${this.description} past its $${this.usd.toFixed(2)}`);
    this.pending_usd += usd;
  }
  charge(held: number, cost: { usd: number; input_tokens?: number | null; output_tokens?: number | null } | null) {
    this.pending_usd -= held;
    this.requests++;
    if (!cost) { this.charged_reservations++; this.spent_usd += held; return; }
    this.spent_usd += cost.usd;
    this.input_tokens += cost.input_tokens ?? 0;
    this.output_tokens += cost.output_tokens ?? 0;
  }
  close(): { usd: number; requests: number; charged_reservations: number } {
    if (!this.closed) { this.closed = true; this.budget.settle(this.id, { usd: this.spent_usd + this.pending_usd, input_tokens: this.input_tokens, output_tokens: this.output_tokens }); }
    return { usd: this.spent_usd, requests: this.requests, charged_reservations: this.charged_reservations };
  }
}
const allowanceScope = new AsyncLocalStorage<BudgetAllowance>();

// ─── Request pricing ────────────────────────────────────────────────

/** Hosts whose requests cost money. */
const PAID_HOSTS: Record<string, 'openai' | 'anthropic' | 'voyage' | 'openrouter' | 'typesafe'> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'api.voyageai.com': 'voyage',
  'openrouter.ai': 'openrouter',
  'api.typesafe.ai': 'typesafe',
};

/** Output-token allowance for a chat request that names no limit. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Input tokens reserved for an OpenAI `previous_response_id` this process has
 * not seen (its chain started elsewhere): the largest context window among
 * the priced OpenAI models (gpt-5.4, 1,050,000 tokens).
 */
export const UNKNOWN_CHAIN_CONTEXT_TOKENS = 1_050_000;

/** Reranker list prices, USD per 1M tokens (voyageai.com/pricing, checked 2026-09-30). */
const RERANK_PRICES: Record<string, number> = {
  'voyage:rerank-2.5': 0.05,
  'voyage:rerank-2.5-lite': 0.02,
};

/**
 * Chat list prices, USD per 1M tokens, checked against the providers' pricing
 * pages on 2026-10-02. They take precedence over the pinned gbrain table,
 * which lacks newer models and lists stale prices for some (gpt-5.5, gpt-5.2).
 * Cache prices apply when the response reports cached tokens.
 */
export const CHAT_PRICE_OVERRIDES: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }> = {
  'anthropic:claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  'anthropic:claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'anthropic:claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'anthropic:claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'anthropic:claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'anthropic:claude-opus-4-6': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'anthropic:claude-opus-5': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'anthropic:claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'anthropic:claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  'openai:gpt-5.2': { input: 1.75, output: 14, cache_read: 0.175 },
  'openai:gpt-5.4': { input: 2.5, output: 15, cache_read: 0.25 },
  'openai:gpt-5.4-mini': { input: 0.75, output: 4.5, cache_read: 0.075 },
  'openai:gpt-5.5': { input: 5, output: 30, cache_read: 0.5 },
  'openai:gpt-6-sol': { input: 2, output: 10, cache_read: 0.2 },
  'openai:gpt-6.1-sol': { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
  'openai:gpt-6-astra': { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
};

/** A dated API snapshot (`gpt-4o-2024-08-06`) is billed at its family's list price. */
const chatPrice = (id: string) => {
  const undated = id.replace(/-\d{4}-?\d{2}-?\d{2}$/, '');
  return CHAT_PRICE_OVERRIDES[id] ?? CHAT_PRICE_OVERRIDES[undated] ?? canonicalLookup(id) ?? canonicalLookup(undated);
};

interface RequestPrice {
  provider: string;
  model: string;
  kind: 'chat' | 'embedding' | 'rerank';
  /** USD per 1M tokens. */
  input: number;
  output: number;
  /** USD per 1M cached input tokens read / written, when the provider reports them. */
  cache_read?: number;
  cache_write?: number;
  /** True when the request may write the prompt cache at a price above `input`; the reservation then prices all input at `cache_write`. */
  cacheWritePremium?: boolean;
  /** Conservative input-token estimate (3 bytes per token), including tool schemas and continuation context. */
  inputTokens: number;
  maxOutputTokens: number;
}

function textBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Array.isArray(value)) return sum(value.map(textBytes));
  if (value && typeof value === 'object') return sum(Object.values(value).map(textBytes));
  return 0;
}

export interface PriceOptions {
  /** Context tokens a known OpenAI response carries into a request that continues it (`previous_response_id`). */
  chainContextTokens?: (responseId: string) => number | undefined;
}

/** Price a request from its URL and JSON body. Returns null for a free host; throws for an unpriceable paid request. */
export function priceRequest(url: string, body: unknown, options: PriceOptions = {}): RequestPrice | null {
  const provider = PAID_HOSTS[new URL(url).hostname];
  if (!provider) return null;
  // Model listings are free metadata reads (providers' key probes use them).
  if (/\/models(\/[^/]+)?\/?$/.test(new URL(url).pathname) && (body === undefined || body === null)) return null;
  const b = (body ?? {}) as Record<string, unknown>;
  const model = typeof b.model === 'string' ? b.model : '';
  if (!model) throw new BudgetExceededError(`paid request to ${url} names no model; cannot reserve its cost`);
  const path = new URL(url).pathname;
  if (provider === 'typesafe') {
    // System One and the Jev reranker bill input tokens only, at gbrain's own TypeSafe price (embedding-pricing.ts).
    const price = lookupEmbeddingPrice(`typesafe:${model}`);
    if (price.kind !== 'known') throw new BudgetExceededError(`no TypeSafe price for ${model}; cannot reserve its cost`);
    const { model: _model, ...payload } = b;
    return { provider, model, kind: /\/rerank/.test(path) ? 'rerank' : 'chat', input: price.pricePerMTok, output: 0, inputTokens: Math.ceil(textBytes(payload) / 3) + 16, maxOutputTokens: 0 };
  }
  if (/\/rerank/.test(path)) {
    const perMTok = RERANK_PRICES[`${provider}:${model}`];
    if (perMTok === undefined) throw new BudgetExceededError(`no rerank price for ${provider}:${model}; cannot reserve its cost`);
    const documents = Array.isArray(b.documents) ? b.documents : [];
    const inputTokens = Math.ceil((textBytes(b.query) * Math.max(1, documents.length) + textBytes(documents)) / 3) + 16;
    return { provider, model, kind: 'rerank', input: perMTok, output: 0, inputTokens, maxOutputTokens: 0 };
  }
  const embedding = /embeddings|\/embed/.test(path);
  if (embedding) {
    const price = lookupEmbeddingPrice(`${provider}:${model}`);
    if (price.kind !== 'known') throw new BudgetExceededError(`no embedding price for ${provider}:${model}; cannot reserve its cost`);
    return { provider, model, kind: 'embedding', input: price.pricePerMTok, output: 0, inputTokens: Math.ceil(textBytes(b.input ?? b.texts) / 3) + 16, maxOutputTokens: 0 };
  }
  // Tool schemas are billed as input, keys and punctuation included, so they count by their JSON size.
  const toolBytes = b.tools === undefined ? 0 : Buffer.byteLength(JSON.stringify(b.tools));
  const chained = typeof b.previous_response_id === 'string'
    ? options.chainContextTokens?.(b.previous_response_id) ?? UNKNOWN_CHAIN_CONTEXT_TOKENS : 0;
  const inputTokens = Math.ceil((textBytes([b.system, b.instructions, b.messages, b.prompt, b.input]) + toolBytes) / 3) + 16 + chained;
  const maxOutputTokens = [b.max_tokens, b.max_completion_tokens, b.max_output_tokens].find(v => typeof v === 'number') as number | undefined ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (provider === 'openrouter') {
    const maxPrice = (b.provider as { max_price?: { prompt?: number; completion?: number } } | undefined)?.max_price;
    if (typeof maxPrice?.prompt !== 'number' || typeof maxPrice.completion !== 'number') {
      throw new BudgetExceededError(`OpenRouter request for ${model} sets no provider.max_price; cannot bound its cost`);
    }
    return { provider, model, kind: 'chat', input: maxPrice.prompt, output: maxPrice.completion, inputTokens, maxOutputTokens };
  }
  const price = chatPrice(`${provider}:${model}`);
  if (!price) throw new BudgetExceededError(`no chat price for ${provider}:${model}; cannot reserve its cost`);
  // OpenAI caches automatically; Anthropic writes its cache only where a request sets cache_control.
  const cacheWritePremium = price.cache_write !== undefined && price.cache_write > price.input
    && (provider !== 'anthropic' || JSON.stringify(b).includes('"cache_control"'));
  return { provider, model, kind: 'chat', input: price.input, output: price.output, cache_read: price.cache_read, cache_write: price.cache_write, cacheWritePremium, inputTokens, maxOutputTokens };
}

/** Worst-case reservation: input estimate (at the cache-write price when it applies) plus the full output allowance. */
export function reservationUsd(price: RequestPrice): number {
  const inputPrice = price.cacheWritePremium ? Math.max(price.input, price.cache_write ?? 0) : price.input;
  return (price.inputTokens * inputPrice + price.maxOutputTokens * price.output) / 1e6;
}

/** Cost from provider-reported usage, or null when the response carries none. */
export function usageCost(price: RequestPrice, responseBody: unknown): { usd: number; input_tokens: number; output_tokens: number } | null {
  const usage = (responseBody as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const n = (key: string) => (typeof usage[key] === 'number' ? usage[key] as number : 0);
  const inputTokens = n('input_tokens') + n('prompt_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens')
    + (usage.input_tokens === undefined && usage.prompt_tokens === undefined ? n('total_tokens') : 0);
  const outputTokens = n('output_tokens') + n('completion_tokens');
  if (inputTokens === 0 && outputTokens === 0) return null;
  const reported = price.provider === 'openrouter' && typeof usage.cost === 'number' ? usage.cost as number : null;
  if (reported !== null) return { usd: reported, input_tokens: inputTokens, output_tokens: outputTokens };
  // Cached input: Anthropic reports reads and writes beside input_tokens; OpenAI counts cached tokens inside input_tokens.
  const details = (usage.input_tokens_details ?? usage.prompt_tokens_details) as Record<string, unknown> | undefined;
  const openaiCached = typeof details?.cached_tokens === 'number' ? details.cached_tokens as number : 0;
  const cacheRead = n('cache_read_input_tokens') + openaiCached;
  const cacheWrite = n('cache_creation_input_tokens');
  const usd = ((inputTokens - cacheRead - cacheWrite) * price.input + cacheRead * (price.cache_read ?? price.input)
    + cacheWrite * (price.cache_write ?? price.input) + outputTokens * price.output) / 1e6;
  return { usd, input_tokens: inputTokens, output_tokens: outputTokens };
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (typeof raw !== 'string') return raw === undefined ? undefined : null;
  try { return JSON.parse(raw); } catch { return null; }
}

export interface PaidRequestGuard {
  uninstall(): void;
  /** Set once a reservation is refused; runners stop scheduling paid work. */
  readonly exhausted: boolean;
}

/**
 * Provider SDKs capture `fetch` when they are imported or constructed (the
 * Anthropic SDKs do; the AI SDK reads globalThis.fetch per request). A guard
 * installed later would never see their requests. So this module replaces
 * globalThis.fetch with a delegating fetch as soon as it is evaluated, and a
 * guard only switches the delegate. Runners import this module before any
 * gbrain or SDK module so every captured reference is the delegate.
 */
const baseFetch = globalThis.fetch;
let active: { handle: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } | null = null;
const delegatingFetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => (active ? active.handle(input, init) : baseFetch(input, init)),
  { preconnect: baseFetch.preconnect?.bind(baseFetch) },
) as typeof fetch;
globalThis.fetch = delegatingFetch;

/** Most recent OpenAI responses remembered for continuation pricing. */
const CHAIN_MEMORY = 100_000;

/**
 * Route every fetch to a paid host through the ledger: price, reserve, send,
 * then reconcile from the response usage. A refused reservation rejects the
 * fetch with BudgetExceededError before anything is sent. One guard at a time.
 */
export function installPaidRequestGuard(run: BudgetRun, options: { fetchImpl?: typeof fetch } = {}): PaidRequestGuard {
  if (active) throw new Error('a paid-request guard is already installed in this process');
  const previous = globalThis.fetch;
  const send = options.fetchImpl ?? (previous === delegatingFetch ? baseFetch : previous);
  const state = { exhausted: false };
  /** OpenAI response id -> input plus output tokens it reported: the context a continuation re-sends. */
  const chain = new Map<string, number>();
  const pricing: PriceOptions = { chainContextTokens: id => chain.get(id) };
  const measure = async (price: RequestPrice, response: Response) => {
    if ((response.headers.get('content-type') ?? '').includes('event-stream')) return null;
    let parsed: unknown;
    try { parsed = await response.clone().json(); } catch { return null; }
    const cost = usageCost(price, parsed);
    const id = (parsed as { id?: unknown } | null)?.id;
    if (cost && price.provider === 'openai' && typeof id === 'string') {
      chain.set(id, cost.input_tokens + cost.output_tokens);
      if (chain.size > CHAIN_MEMORY) chain.delete(chain.keys().next().value!);
    }
    return cost;
  };
  const handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = await requestBody(input, init);
    let price: RequestPrice | null;
    let id: string;
    try {
      price = priceRequest(url, body, pricing);
      if (!price) return send(input, init);
      const allowance = allowanceScope.getStore();
      if (allowance) {
        if (allowance.budget !== run) throw new BudgetExceededError(`allowance ${allowance.description} belongs to another budget run`);
        const held = reservationUsd(price);
        allowance.hold(held, `${price.provider}:${price.model} ${price.kind}`);
        let res: Response;
        try { res = await send(input, init); }
        catch (error) { allowance.charge(held, null); throw error; }
        allowance.charge(held, await measure(price, res));
        return res;
      }
      id = run.reserve(reservationUsd(price), `${price.provider}:${price.model} ${price.kind}`);
    } catch (error) {
      if (error instanceof BudgetExceededError) state.exhausted = true;
      throw error;
    }
    let response: Response;
    try { response = await send(input, init); }
    catch (error) { run.settle(id, null); throw error; }
    run.settle(id, await measure(price, response));
    return response;
  };
  const guard = { handle };
  active = guard;
  globalThis.fetch = delegatingFetch;
  return {
    uninstall() {
      if (active !== guard) return;
      active = null;
      globalThis.fetch = previous;
    },
    get exhausted() { return state.exhausted; },
  };
}

// ─── Runner flags ───────────────────────────────────────────────────

export interface BudgetOptions {
  budgetUsd: number | null;
  /** The resolved SQLite ledger path. */
  ledgerPath: string;
  /** An explicit program cap that must match the recorded one; null adopts the recorded cap. */
  programCapUsd: number | null;
  programCapSource?: CapSource | null;
  /** An upper limit on the recorded cap (a campaign manifest's cap). */
  programCapMaxUsd?: number | null;
  /** Join this already-open run instead of opening one (--budget-run-id / BRAINBENCH_BUDGET_RUN_ID). */
  runId?: string | null;
}

/** Read --budget-usd, --budget-ledger and --program-cap-usd, falling back to BRAINBENCH_* env vars. */
export function budgetOptionsFrom(argv: readonly string[], env: Record<string, string | undefined> = process.env): BudgetOptions {
  const flag = (name: string) => {
    const eq = argv.find(a => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const number = (raw: string | undefined, name: string) => {
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of dollars (got ${JSON.stringify(raw)})`);
    return value;
  };
  const capFlag = flag('--program-cap-usd');
  const named = flag('--budget-ledger') ?? env.BRAINBENCH_BUDGET_LEDGER;
  const paths = ledgerPaths(named ?? DEFAULT_LEDGER_PATH);
  if (named !== undefined && paths.remapped) process.stderr.write(`[budget] ${paths.legacy} names a legacy JSON ledger; using the SQLite ledger ${paths.ledger} (the JSON file migrates to it on first use)\n`);
  const programCapUsd = number(capFlag ?? env.BRAINBENCH_PROGRAM_CAP_USD, '--program-cap-usd');
  return {
    budgetUsd: number(flag('--budget-usd') ?? env.BRAINBENCH_BUDGET_USD, '--budget-usd'),
    ledgerPath: paths.ledger,
    programCapUsd,
    programCapSource: programCapUsd === null ? null : capFlag !== undefined ? '--program-cap-usd' : 'BRAINBENCH_PROGRAM_CAP_USD',
    runId: flag('--budget-run-id') ?? env.BRAINBENCH_BUDGET_RUN_ID ?? null,
  };
}

/**
 * Start guarded paid work for a runner: print the estimate, refuse without
 * --budget-usd, open (or join) the run, start the event-loop lag monitor and
 * install the fetch guard. The run's close() stops the monitor.
 */
export function startPaidRun(runner: string, options: BudgetOptions & { estimateUsd: number | null; log?: (line: string) => void }): { run: BudgetRun; guard: PaidRequestGuard } {
  const log = options.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const ledgerPath = ledgerPaths(options.ledgerPath).ledger;
  log(`[budget] ${runner}: estimated cost ${options.estimateUsd === null ? 'unmeasured' : `$${options.estimateUsd.toFixed(2)}`}; ledger ${ledgerPath}`);
  const caps = { programCapUsd: options.programCapUsd, programCapSource: options.programCapSource, programCapMaxUsd: options.programCapMaxUsd };
  const lag = new LagMonitor().start();
  try {
    let run: BudgetRun;
    if (options.runId) {
      run = BudgetRun.join({ runId: options.runId, ledgerPath, log, ...caps });
      log(`[budget] ${runner}: joined shared run ${run.runId} ($${run.budgetUsd.toFixed(2)} across all of its workers)`);
    } else {
      if (options.budgetUsd === null) throw new BudgetExceededError(`${runner} makes paid requests; pass --budget-usd <dollars> (or BRAINBENCH_BUDGET_USD) to authorize a cap`);
      run = BudgetRun.open({ runner, budgetUsd: options.budgetUsd, estimateUsd: options.estimateUsd, ledgerPath, log, ...caps });
    }
    run.attachLagMonitor(lag);
    return { run, guard: installPaidRequestGuard(run) };
  } catch (error) {
    lag.stop();
    throw error;
  }
}

/** Receipt v2 cost block from a closed run, with the ledger it came from and the event-loop lag the run saw. */
export function receiptCost(summary: RunSummary): {
  usd: number; input_tokens: number; output_tokens: number; basis: string;
  ledger: string; program_cap_usd: number; overshoot_usd: number; event_loop_lag_ms: LagStats | null; event_loop_lag_unavailable?: string;
} {
  return {
    usd: Number(summary.actual_usd.toFixed(6)), input_tokens: summary.input_tokens, output_tokens: summary.output_tokens,
    basis: `budget ledger ${summary.run_id}: ${summary.requests} paid requests, ${summary.charged_reservations} charged at their reservation because usage was unavailable`,
    ledger: summary.ledger_path, program_cap_usd: summary.program_cap_usd, overshoot_usd: Number(summary.overshoot_usd.toFixed(6)),
    event_loop_lag_ms: summary.event_loop_lag_ms,
    ...(summary.event_loop_lag_unavailable ? { event_loop_lag_unavailable: summary.event_loop_lag_unavailable } : {}),
  };
}

export const USAGE = `usage: ${CLI} <command> [--budget-ledger <path>]

  init      --budget-ledger <path> [--program-cap-usd <n>] [--reason <text>]
            create a ledger with a recorded program cap (default $${DEFAULT_PROGRAM_CAP_USD}), or migrate the legacy JSON ledger at that path
  status    [--budget-run-id <id>]           read-only JSON: recorded cap, committed, remaining, hints
  verify                                      read-only integrity and totals check; exit 1 on a problem
  set-cap   --program-cap-usd <n> --reason <text>
            record a new program cap; only with the user's authorization; refuses a cap below committed spend
  migrate   --finish                          finish an interrupted migration whose totals match
  open      --runner <name> --budget-usd <n> [--estimate-usd <n>] [--program-cap-usd <n>]
  close     --budget-run-id <id>

Paths ending in .json mean their sibling .sqlite ledger. Docs: docs/budget-ledger.md`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const [command] = argv;
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const fail = (message: string, code = 1): never => { console.error(message); process.exit(code); };
  if (!command || command === '--help' || command === 'help' || argv.includes('--help')) {
    console.log(USAGE);
    process.exit(command ? 0 : 2);
  }
  try {
    const options = budgetOptionsFrom(argv);
    if (command === 'init') {
      print({ ...initLedger({ ledgerPath: options.ledgerPath, programCapUsd: options.programCapUsd, reason: flag('--reason') ?? null }), status: ledgerStatus({ ledgerPath: options.ledgerPath }) });
    } else if (command === 'status') {
      print(ledgerStatus({ ledgerPath: options.ledgerPath, runId: options.runId }));
    } else if (command === 'verify') {
      const report = verifyLedger(options.ledgerPath);
      print(report);
      if (!report.ok) fail(`budget ledger ${report.ledger} failed verification: ${report.problems[0]}. Do not spend against it; follow the recovery steps in docs/budget-ledger.md and ask the user.`);
    } else if (command === 'set-cap') {
      if (options.programCapUsd === null) fail(`set-cap needs --program-cap-usd <dollars>\n\n${USAGE}`, 2);
      print(setProgramCap({ ledgerPath: options.ledgerPath, programCapUsd: options.programCapUsd!, reason: flag('--reason') ?? '' }));
    } else if (command === 'migrate' && argv.includes('--finish')) {
      print(finishMigration(options.ledgerPath));
    } else if (command === 'open' && flag('--runner') && options.budgetUsd !== null) {
      const estimate = flag('--estimate-usd');
      const run = BudgetRun.open({ runner: flag('--runner')!, budgetUsd: options.budgetUsd, estimateUsd: estimate === undefined ? null : Number(estimate), ledgerPath: options.ledgerPath,
        programCapUsd: options.programCapUsd, programCapSource: options.programCapSource });
      console.log(run.runId);
    } else if (command === 'close' && options.runId) {
      const before = ledgerStatus({ ledgerPath: options.ledgerPath, runId: options.runId });
      if (!before.run) fail(`no budget run ${options.runId} in ${before.ledger}`);
      closeRun(before.ledger, options.runId);
      const after = ledgerStatus({ ledgerPath: options.ledgerPath, runId: options.runId }).run!;
      const requests = (connect(before.ledger).db.query('SELECT COUNT(*) AS n FROM entries WHERE run_id = ?').get(options.runId) as { n: number }).n;
      console.log(JSON.stringify({ run_id: options.runId, budget_usd: after.budget_usd, requests, actual_usd: after.committed_usd }));
    } else {
      fail(USAGE, 2);
    }
  } catch (error) {
    fail((error as Error).message);
  }
}
