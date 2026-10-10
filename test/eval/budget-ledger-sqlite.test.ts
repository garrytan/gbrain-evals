/**
 * The SQLite budget ledger (0.10.12): recorded program cap, creation and
 * migration rules, refusals an agent operator can act on, durability,
 * concurrency, conservative reservations, the event-loop lag monitor and
 * reserve/settle cost at scale.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BudgetExceededError, BudgetRun, LagMonitor, UNKNOWN_CHAIN_CONTEXT_TOKENS, budgetOptionsFrom, closeLedgers, finishMigration, initLedger,
  installPaidRequestGuard, ledgerPaths, ledgerStatus, ledgerTestHooks, priceRequest, readLedger, receiptCost, reservationUsd, setProgramCap,
  startPaidRun, usageCost, verifyLedger, type LegacyLedgerFile,
} from '../../eval/runner/budget-ledger.ts';
import { requirePaidArm } from '../../eval/runner/paid-arm.ts';
import { loadDecisionManifest } from '../../eval/runner/evidence-delivery/decision.ts';
import { Args, paidGuard } from '../../eval/runner/evidence-delivery.ts';

const ROOT = resolve(import.meta.dir, '../..');
const MODULE = join(ROOT, 'eval/runner/budget-ledger.ts');
const dirs: string[] = [];
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'ledger-sqlite-')); dirs.push(dir); return dir; };
/**
 * A directory on tmpfs (/dev/shm) where present. Tests that write hundreds of ledger entries use it: each reserve and
 * settle commits with `synchronous = FULL`, so on a disk the test's time is the runner's fsync latency (825 fsyncs for
 * 400 pairs), not the ledger's work. Forced probe: with fsync delayed 10 ms on a disk path, the 400-pair verify body
 * takes 10.1 s (over the 5 s test timeout); on tmpfs under the same delay it takes 0.7 s.
 */
const fastTmp = () => { const dir = mkdtempSync(join(existsSync('/dev/shm') ? '/dev/shm' : tmpdir(), 'ledger-sqlite-')); dirs.push(dir); return dir; };
afterEach(() => {
  for (const k of Object.keys(ledgerTestHooks) as Array<keyof typeof ledgerTestHooks>) delete ledgerTestHooks[k];
  closeLedgers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const withoutCapEnv = () => { const e = { ...process.env }; delete e.BRAINBENCH_PROGRAM_CAP_USD; delete e.BRAINBENCH_BUDGET_LEDGER; delete e.BRAINBENCH_BUDGET_RUN_ID; return e; };

function cli(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, MODULE, ...args], { cwd: ROOT, env: { ...withoutCapEnv(), ...env } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** Run a script in a child Bun process with the ledger module imported as `L`. */
function child(body: string, env: Record<string, string> = {}) {
  const script = `import * as L from ${JSON.stringify(MODULE)};\n${body}`;
  return Bun.spawn([process.execPath, '-e', script], { cwd: ROOT, env: { ...process.env, ...env } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
}

/** A v0.10.11-style ledger.json: an unfinished run with an open reservation and a joined participant, plus a finished run. */
function legacyFixture(): LegacyLedgerFile {
  const t = '2026-10-02T00:00:00.000Z';
  return {
    schema_version: 1, program_cap_usd: 2000,
    runs: [
      { run_id: 'cat40-old', runner: 'cat40-model-ladder', budget_usd: 100, estimate_usd: null, started_at: t, finished_at: t },
      { run_id: 'evidence-delivery-campaign-live', runner: 'evidence-delivery-campaign', budget_usd: 50, estimate_usd: 40, started_at: t, finished_at: null },
    ],
    entries: [
      { id: 'e1', run_id: 'cat40-old', description: 'openai:gpt-5.4 chat', reserved_usd: 0.5, actual_usd: 0.1234, status: 'reconciled', input_tokens: 1000, output_tokens: 100, created_at: t, settled_at: t },
      { id: 'e2', run_id: 'cat40-old', description: 'anthropic:claude-sonnet-4-6 chat', reserved_usd: 0.3, actual_usd: 0.3, status: 'charged-reservation', input_tokens: null, output_tokens: null, created_at: t, settled_at: t },
      { id: 'e3', run_id: 'evidence-delivery-campaign-live', description: 'openai:gpt-4o chat', reserved_usd: 0.25, actual_usd: 0.2, status: 'reconciled', input_tokens: 50, output_tokens: 5, created_at: t, settled_at: t, participant: '123-abcd' },
      { id: 'open-1', run_id: 'evidence-delivery-campaign-live', description: 'openai:gpt-4o chat', reserved_usd: 0.4, actual_usd: null, status: 'reserved', input_tokens: null, output_tokens: null, created_at: t, settled_at: null },
    ],
  };
}
const FIXTURE_COMMITTED = 0.1234 + 0.3 + 0.2 + 0.4;

function writeLegacy(dir: string, file = legacyFixture()) {
  const path = join(dir, 'ledger.json');
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
  return path;
}

/** v0.10.11's open path (withLock + readLedger), kept verbatim in spirit: code from before 0.10.12 that meets the tombstone. */
function oldCodeOpen(legacyPath: string) {
  if (!existsSync(legacyPath)) return { schema_version: 1, runs: [], entries: [] };
  const parsed = JSON.parse(readFileSync(legacyPath, 'utf8'));
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.runs) || !Array.isArray(parsed.entries)) {
    throw new Error(`unreadable budget ledger at ${legacyPath}; refusing to spend without it`);
  }
  return parsed;
}

describe('recorded program cap', () => {
  test('a runner with no cap flag adopts the ledger\'s $237 cap; status reports it', () => {
    const path = join(tmp(), 'cat40-followups.sqlite');
    initLedger({ ledgerPath: path, programCapUsd: 237, reason: '$2,000 authorization minus $1,763 spent' });
    const options = budgetOptionsFrom(['--budget-usd', '18', '--budget-ledger', path], {});
    expect(options.programCapUsd).toBeNull();
    const { run, guard } = startPaidRun('cat40-model-ladder', { ...options, estimateUsd: 16, log: () => {} });
    guard.uninstall();
    run.settle(run.reserve(1.5, 'x'), { usd: 1.25 });
    const summary = run.close();
    expect(summary.program_cap_usd).toBe(237);
    const status = ledgerStatus({ ledgerPath: path });
    expect(status.totals).toMatchObject({ program_cap_usd: 237, committed_usd: 1.25, remaining_usd: 235.75 });
    expect(status.last_cap_change).toMatchObject({ program_cap_usd: 237, kind: 'open', reason: '$2,000 authorization minus $1,763 spent' });
    expect(receiptCost(summary)).toMatchObject({ ledger: path, program_cap_usd: 237 });
  });

  test('an explicit cap that disagrees is refused, naming its source and the set-cap command', () => {
    const path = join(tmp(), 'l.sqlite');
    initLedger({ ledgerPath: path, programCapUsd: 237 });
    const viaFlag = budgetOptionsFrom(['--budget-usd', '5', '--budget-ledger', path, '--program-cap-usd', '500'], {});
    expect(() => startPaidRun('x', { ...viaFlag, estimateUsd: null, log: () => {} }))
      .toThrow(/records \$237\.00, but --program-cap-usd asks for \$500\.00\. Drop --program-cap-usd .*set-cap --budget-ledger .*l\.sqlite --program-cap-usd 500 --reason/);
    const viaEnv = budgetOptionsFrom(['--budget-usd', '5', '--budget-ledger', path], { BRAINBENCH_PROGRAM_CAP_USD: '500' });
    expect(() => startPaidRun('x', { ...viaEnv, estimateUsd: null, log: () => {} })).toThrow(/BRAINBENCH_PROGRAM_CAP_USD asks for \$500\.00\. Unset BRAINBENCH_PROGRAM_CAP_USD/);
    const matching = budgetOptionsFrom(['--budget-usd', '5', '--budget-ledger', path, '--program-cap-usd', '237'], {});
    const { run, guard } = startPaidRun('x', { ...matching, estimateUsd: null, log: () => {} });
    guard.uninstall();
    run.close();
  });

  test('a campaign manifest cap is an upper limit, not a value that must match', () => {
    const low = join(tmp(), 'low.sqlite');
    initLedger({ ledgerPath: low, programCapUsd: 237 });
    BudgetRun.open({ runner: 'campaign', budgetUsd: 10, ledgerPath: low, programCapMaxUsd: 400 }).close();
    const high = join(tmp(), 'high.sqlite');
    initLedger({ ledgerPath: high, programCapUsd: 2000 });
    expect(() => BudgetRun.open({ runner: 'campaign', budgetUsd: 10, ledgerPath: high, programCapMaxUsd: 400 })).toThrow('above this campaign\'s limit of $400.00');
    const created = join(tmp(), 'new.sqlite');
    BudgetRun.open({ runner: 'campaign', budgetUsd: 10, ledgerPath: created, programCapMaxUsd: 400 });
    expect(ledgerStatus({ ledgerPath: created }).totals.program_cap_usd).toBe(400);
  });

  test('set-cap records who and why, refuses a cap below committed spend, and later reserves use it', () => {
    const path = join(tmp(), 'l.sqlite');
    initLedger({ ledgerPath: path, programCapUsd: 10 });
    const run = BudgetRun.open({ runner: 'a', budgetUsd: 9, ledgerPath: path });
    run.reserve(8, 'big');
    expect(() => setProgramCap({ ledgerPath: path, programCapUsd: 5, reason: 'too low' })).toThrow('already committed $8.00');
    expect(() => setProgramCap({ ledgerPath: path, programCapUsd: 20, reason: '' })).toThrow('--reason');
    expect(() => BudgetRun.open({ runner: 'b', budgetUsd: 5, ledgerPath: path })).toThrow('program cap');
    expect(setProgramCap({ ledgerPath: path, programCapUsd: 20, reason: 'user approved $20' })).toMatchObject({ previous_cap_usd: 10, program_cap_usd: 20 });
    BudgetRun.open({ runner: 'b', budgetUsd: 5, ledgerPath: path });
    expect(ledgerStatus({ ledgerPath: path }).last_cap_change).toMatchObject({ kind: 'set_cap', reason: 'user approved $20', by: expect.stringContaining('@') });
  });
});

describe('creation rule', () => {
  test('open off the default path without a cap, join and reserve against a missing ledger refuse with the init command', () => {
    const path = join(tmp(), 'missing.sqlite');
    const init = `bun eval/runner/budget-ledger.ts init --budget-ledger ${path} --program-cap-usd <dollars>`;
    expect(() => BudgetRun.open({ runner: 'a', budgetUsd: 1, ledgerPath: path })).toThrow(init);
    expect(() => BudgetRun.join({ runId: 'x', ledgerPath: path })).toThrow(init);
    expect(existsSync(path)).toBe(false);
    BudgetRun.open({ runner: 'a', budgetUsd: 1, ledgerPath: path, programCapUsd: 50 });
    expect(ledgerStatus({ ledgerPath: path }).totals.program_cap_usd).toBe(50);
    const run = BudgetRun.open({ runner: 'b', budgetUsd: 1, ledgerPath: path });
    closeLedgers();
    rmSync(path);
    expect(() => run.reserve(0.1, 'after delete')).toThrow(init);
  });

  test('requirePaidArm and status read a missing ledger without creating it', () => {
    const path = join(tmp(), 'none.sqlite');
    expect(() => requirePaidArm([], { arm: 'cat x', estimateUsd: 1, ledgerPath: path })).toThrow('has no recorded program cap yet');
    const status = ledgerStatus({ ledgerPath: path });
    expect(status).toMatchObject({ state: 'missing', totals: { program_cap_usd: null, committed_usd: 0 } });
    expect(status.hints[0]).toContain('init --budget-ledger');
    expect(existsSync(path)).toBe(false);
  });

  test('requirePaidArm finds a run in the ledger named by --budget-ledger or BRAINBENCH_BUDGET_LEDGER, not only the default', () => {
    const path = join(tmp(), 'named.sqlite');
    initLedger({ ledgerPath: path, programCapUsd: 10 });
    const run = BudgetRun.open({ runner: 'named', budgetUsd: 2, ledgerPath: path });
    expect(requirePaidArm(['--paid', '--budget-run-id', run.runId, '--budget-ledger', path], { arm: 'cat x', estimateUsd: 1 }).budgetRunId).toBe(run.runId);
    const before = process.env.BRAINBENCH_BUDGET_LEDGER;
    process.env.BRAINBENCH_BUDGET_LEDGER = path;
    try { expect(requirePaidArm(['--paid', '--budget-run-id', run.runId], { arm: 'cat x', estimateUsd: 1 }).remainingUsd).toBe(2); }
    finally { if (before === undefined) delete process.env.BRAINBENCH_BUDGET_LEDGER; else process.env.BRAINBENCH_BUDGET_LEDGER = before; }
  });

  test('a .json path means its sibling .sqlite ledger', () => {
    const dir = tmp();
    expect(ledgerPaths(join(dir, 'ledger.json'))).toEqual({ ledger: join(dir, 'ledger.sqlite'), legacy: join(dir, 'ledger.json'), remapped: true });
    expect(budgetOptionsFrom(['--budget-ledger', join(dir, 'x.json')], {}).ledgerPath).toBe(join(dir, 'x.sqlite'));
    const run = BudgetRun.open({ runner: 'a', budgetUsd: 1, ledgerPath: join(dir, 'x.json'), programCapUsd: 5 });
    expect(run.ledgerPath).toBe(join(dir, 'x.sqlite'));
    expect(existsSync(join(dir, 'x.json'))).toBe(false);
  });
});

describe('legacy migration', () => {
  test('migrates runs, entries, open reservations and participants; totals match to the cent; leaves a tombstone and a .migrated copy', () => {
    const dir = tmp();
    const legacy = writeLegacy(dir);
    const original = readFileSync(legacy, 'utf8');
    const logs: string[] = [];
    const run = BudgetRun.join({ runId: 'evidence-delivery-campaign-live', ledgerPath: legacy, log: l => logs.push(l) });
    expect(logs[0]).toContain('migrated');
    const ledger = join(dir, 'ledger.sqlite');
    expect(run.ledgerPath).toBe(ledger);
    const status = ledgerStatus({ ledgerPath: ledger, runId: 'evidence-delivery-campaign-live' });
    expect(status.totals.committed_usd).toBeCloseTo(FIXTURE_COMMITTED, 2);
    expect(status.totals.requests).toBe(4);
    expect(status.totals.program_cap_usd).toBe(500);
    expect(status.run).toMatchObject({ runner: 'evidence-delivery-campaign', finished_at: null });
    expect(status.run!.committed_usd).toBeCloseTo(0.6, 9);
    const snap = readLedger(ledger);
    expect(snap.entries.find(e => e.id === 'e3')!.participant).toBe('123-abcd');
    expect(snap.runs.find(r => r.run_id === 'cat40-old')!.finished_at).not.toBeNull();
    expect(readFileSync(`${legacy}.migrated`, 'utf8')).toBe(original);
    const tombstone = JSON.parse(readFileSync(legacy, 'utf8'));
    expect(tombstone).toMatchObject({ schema_version: 2, migrated_to: ledger });
    const owner = BudgetRun.join({ runId: 'evidence-delivery-campaign-live', ledgerPath: ledger });
    (owner as unknown as { participant: null }).participant = null;
    owner.settle('open-1', { usd: 0.35 });
    expect(ledgerStatus({ ledgerPath: ledger }).totals.committed_usd).toBeCloseTo(FIXTURE_COMMITTED - 0.05, 9);
    expect(() => owner.settle('open-1', null)).toThrow('already settled');
    expect(verifyLedger(ledger)).toMatchObject({ ok: true });
  });

  test('the explicit cap, not the legacy file\'s last-writer cap, is recorded', () => {
    const dir = tmp();
    writeLegacy(dir);
    BudgetRun.open({ runner: 'a', budgetUsd: 1, ledgerPath: join(dir, 'ledger.sqlite'), programCapUsd: 237 });
    expect(ledgerStatus({ ledgerPath: join(dir, 'ledger.sqlite') }).totals.program_cap_usd).toBe(237);
  });

  test('code from before 0.10.12 refuses to spend against the tombstone', () => {
    const dir = tmp();
    const legacy = writeLegacy(dir);
    expect(oldCodeOpen(legacy).entries).toHaveLength(4);
    initLedger({ ledgerPath: legacy, programCapUsd: 300 });
    expect(() => oldCodeOpen(legacy)).toThrow('unreadable budget ledger');
  });

  test('status reads an unmigrated legacy file read-only', () => {
    const dir = tmp();
    const legacy = writeLegacy(dir);
    const before = statSync(legacy).mtimeMs;
    const status = ledgerStatus({ ledgerPath: legacy });
    expect(status.state).toBe('legacy');
    expect(status.totals.committed_usd).toBeCloseTo(FIXTURE_COMMITTED, 9);
    expect(status.totals.program_cap_usd).toBeNull();
    expect(status.hints[0]).toContain('unmigrated legacy ledger');
    expect(existsSync(join(dir, 'ledger.sqlite'))).toBe(false);
    expect(statSync(legacy).mtimeMs).toBe(before);
  });

  test('an unknown file at the legacy path, or a tombstone whose ledger is gone, refuses', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'ledger.json'), '{"schema_version": 9}');
    expect(() => BudgetRun.open({ runner: 'a', budgetUsd: 1, ledgerPath: join(dir, 'ledger.sqlite'), programCapUsd: 5 })).toThrow(/schema_version 9.*Stop and ask the user/);
    const other = tmp();
    writeLegacy(other);
    initLedger({ ledgerPath: join(other, 'ledger.sqlite') });
    closeLedgers();
    rmSync(join(other, 'ledger.sqlite'));
    expect(() => BudgetRun.open({ runner: 'a', budgetUsd: 1, ledgerPath: join(other, 'ledger.sqlite'), programCapUsd: 5 })).toThrow('stop and ask the user where the ledger went');
  });

  test('a legacy file with spending the SQLite ledger lacks stops spending and says to ask the user', () => {
    const dir = tmp();
    writeLegacy(dir);
    initLedger({ ledgerPath: join(dir, 'ledger.sqlite') });
    const legacy = legacyFixture();
    legacy.entries.push({ ...legacy.entries[0], id: 'newer', actual_usd: 3 });
    writeLegacy(dir, legacy);
    expect(() => BudgetRun.open({ runner: 'a', budgetUsd: 1, ledgerPath: join(dir, 'ledger.sqlite') })).toThrow('their totals differ');
    expect(() => finishMigration(join(dir, 'ledger.sqlite'))).toThrow('Stop and ask the user');
  });

  for (const step of ['ledger-written', 'ledger-renamed', 'legacy-copied', 'tombstoned'] as const) {
    test(`a crash after "${step}" recovers without losing spend`, async () => {
      const dir = tmp();
      const legacy = writeLegacy(dir);
      const ledger = join(dir, 'ledger.sqlite');
      const proc = child(`L.ledgerTestHooks.migrationStep = s => { if (s === ${JSON.stringify(step)}) process.exit(9); };
        L.BudgetRun.join({ runId: 'evidence-delivery-campaign-live', ledgerPath: ${JSON.stringify(legacy)}, log: () => {} });`);
      expect(await proc.exited).toBe(9);
      const legacyNow = JSON.parse(readFileSync(legacy, 'utf8'));
      if (step === 'ledger-written') {
        expect(existsSync(ledger)).toBe(false);
        expect(legacyNow.schema_version).toBe(1);
      } else if (step !== 'tombstoned') {
        expect(legacyNow.schema_version).toBe(1);
        expect(() => BudgetRun.join({ runId: 'evidence-delivery-campaign-live', ledgerPath: ledger }))
          .toThrow(`interrupted migration (totals match: $${FIXTURE_COMMITTED.toFixed(4)} in 4 requests). Finish it with: bun eval/runner/budget-ledger.ts migrate --finish --budget-ledger ${ledger}`);
        const finished = cli(['migrate', '--finish', '--budget-ledger', ledger]);
        expect(finished.code).toBe(0);
      }
      const run = BudgetRun.join({ runId: 'evidence-delivery-campaign-live', ledgerPath: ledger, log: () => {} });
      expect(ledgerStatus({ ledgerPath: ledger }).totals.committed_usd).toBeCloseTo(FIXTURE_COMMITTED, 2);
      expect(JSON.parse(readFileSync(legacy, 'utf8')).schema_version).toBe(2);
      expect(existsSync(`${legacy}.migrated`)).toBe(true);
      run.settle(run.reserve(0.1, 'after recovery'), { usd: 0.1 });
      expect(verifyLedger(ledger).ok).toBe(true);
    });
  }

  test('the evidence-delivery campaign joins a migrated ledger through the shared reader', () => {
    const { manifest } = loadDecisionManifest();
    const dir = tmp();
    const legacy = writeLegacy(dir);
    const { run, guard } = paidGuard(new Args(['--budget-run-id', 'evidence-delivery-campaign-live', '--budget-ledger', legacy]), manifest, 'e1', 1);
    guard.uninstall();
    expect(run.runId).toBe('evidence-delivery-campaign-live');
    expect(run.ledgerPath).toBe(join(dir, 'ledger.sqlite'));
    expect(ledgerStatus({ ledgerPath: run.ledgerPath }).totals.program_cap_usd).toBe(manifest.budget.program_cap_usd);
    run.close();
  });
});

describe('CLI', () => {
  test('init, status, set-cap and --help', () => {
    const path = join(tmp(), 'cat40-followups.sqlite');
    const missing = cli(['status', '--budget-ledger', path]);
    expect(missing.code).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ state: 'missing', totals: { program_cap_usd: null } });
    expect(existsSync(path)).toBe(false);
    const init = cli(['init', '--budget-ledger', path, '--program-cap-usd', '237', '--reason', 'remaining authorization']);
    expect(init.code).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({ program_cap_usd: 237, status: { totals: { program_cap_usd: 237, remaining_usd: 237 } } });
    const again = cli(['init', '--budget-ledger', path]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already exists');
    const status = JSON.parse(cli(['status', '--budget-ledger', path]).stdout);
    expect(status).toMatchObject({ ledger: path, state: 'sqlite', totals: { program_cap_usd: 237 } });
    expect(status.hints.some((h: string) => h.startsWith('both files present'))).toBe(true);
    expect(status.hints.some((h: string) => h.startsWith('cap mismatch'))).toBe(true);
    expect(cli(['set-cap', '--budget-ledger', path, '--program-cap-usd', '300']).stderr).toContain('--reason');
    expect(JSON.parse(cli(['set-cap', '--budget-ledger', path, '--program-cap-usd', '300', '--reason', 'approved']).stdout)).toMatchObject({ program_cap_usd: 300 });
    const help = cli(['--help']);
    expect(help.code).toBe(0);
    for (const c of ['init', 'status', 'verify', 'set-cap', 'migrate   --finish']) expect(help.stdout).toContain(c);
  });

  test('open adopts the recorded cap and close prints the run total', () => {
    const path = join(tmp(), 'l.sqlite');
    expect(cli(['init', '--budget-ledger', path, '--program-cap-usd', '40']).code).toBe(0);
    const open = cli(['open', '--runner', 'batch', '--budget-usd', '3', '--budget-ledger', path]);
    expect(open.code).toBe(0);
    const runId = open.stdout.trim();
    const close = cli(['close', '--budget-run-id', runId, '--budget-ledger', path]);
    expect(JSON.parse(close.stdout)).toEqual({ run_id: runId, budget_usd: 3, requests: 0, actual_usd: 0 });
    expect(ledgerStatus({ ledgerPath: path, runId }).run!.finished_at).not.toBeNull();
  });

  test('verify passes a healthy ledger and reports a corrupted page with the recovery pointer', () => {
    const path = join(fastTmp(), 'l.sqlite');
    initLedger({ ledgerPath: path });
    const run = BudgetRun.open({ runner: 'a', budgetUsd: 100, ledgerPath: path });
    for (let i = 0; i < 400; i++) run.settle(run.reserve(0.01, `request ${i} ${'x'.repeat(200)}`), { usd: 0.005 });
    closeLedgers();
    expect(cli(['verify', '--budget-ledger', path]).code).toBe(0);
    const bytes = readFileSync(path);
    expect(bytes.length).toBeGreaterThan(8 * 4096);
    bytes.fill(0x5a, 3 * 4096, 3 * 4096 + 200);
    writeFileSync(path, bytes);
    const bad = cli(['verify', '--budget-ledger', path]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout).ok).toBe(false);
    expect(bad.stderr).toContain('failed verification');
    expect(bad.stderr).toContain('docs/budget-ledger.md');
  });

  test('a file that is not a ledger refuses spending and names the verify command', () => {
    const path = join(tmp(), 'l.sqlite');
    writeFileSync(path, 'not sqlite '.repeat(200));
    expect(() => BudgetRun.open({ runner: 'a', budgetUsd: 1, ledgerPath: path, programCapUsd: 5 })).toThrow(`verify --budget-ledger ${path}`);
    const foreign = join(tmp(), 'f.sqlite');
    new Database(foreign, { create: true }).exec('CREATE TABLE t (x)');
    expect(() => BudgetRun.open({ runner: 'a', budgetUsd: 1, ledgerPath: foreign, programCapUsd: 5 })).toThrow('not a brainbench-budget-ledger file');
  });
});

describe('durability and concurrency', () => {
  test('a failed write records nothing, sends nothing, and stops this process spending', async () => {
    const path = join(tmp(), 'l.sqlite');
    initLedger({ ledgerPath: path });
    const run = BudgetRun.open({ runner: 'a', budgetUsd: 5, ledgerPath: path });
    ledgerTestHooks.beforeCommit = () => { throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_FSYNC' }); };
    let sent = 0;
    const guard = installPaidRequestGuard(run, { fetchImpl: (async () => { sent++; return Response.json({}); }) as unknown as typeof fetch });
    try {
      await expect(fetch('https://api.openai.com/v1/embeddings', { method: 'POST', body: JSON.stringify({ model: 'text-embedding-3-large', input: 'x' }) }))
        .rejects.toThrow('SQLITE_IOERR_FSYNC: disk I/O error); this process refuses further spending');
      delete ledgerTestHooks.beforeCommit;
      await expect(fetch('https://api.openai.com/v1/embeddings', { method: 'POST', body: JSON.stringify({ model: 'text-embedding-3-large', input: 'x' }) }))
        .rejects.toThrow('an earlier write to the budget ledger');
      expect(guard.exhausted).toBe(true);
    } finally { guard.uninstall(); }
    expect(sent).toBe(0);
    expect(readLedger(path).entries).toHaveLength(0);
  });

  test('a ledger file replaced under a live process is reopened, not written through the stale handle', async () => {
    const dir = tmp();
    const path = join(dir, 'l.sqlite');
    initLedger({ ledgerPath: path, programCapUsd: 10 });
    const run = BudgetRun.open({ runner: 'a', budgetUsd: 5, ledgerPath: path });
    run.reserve(1, 'before');
    const replacement = join(dir, 'restored.sqlite');
    const proc = child(`L.initLedger({ ledgerPath: ${JSON.stringify(replacement)}, programCapUsd: 10 }); L.BudgetRun.open({ runner: 'b', budgetUsd: 5, ledgerPath: ${JSON.stringify(replacement)} }).reserve(2, 'x'); L.closeLedgers();`);
    expect(await proc.exited).toBe(0);
    require('node:fs').renameSync(replacement, path);
    expect(() => run.reserve(1, 'after replace')).toThrow(`budget run ${run.runId} is not in`);
    expect(ledgerStatus({ ledgerPath: path }).totals.committed_usd).toBe(2);
  });

  test('4 processes x 500 reserves under a tight cap never overshoot', async () => {
    const path = join(tmp(), 'l.sqlite');
    initLedger({ ledgerPath: path, programCapUsd: 1000 });
    const owner = BudgetRun.open({ runner: 'race', budgetUsd: 7.5, ledgerPath: path });
    const procs = Array.from({ length: 4 }, () => child(`
      const run = L.BudgetRun.join({ runId: ${JSON.stringify(owner.runId)}, ledgerPath: ${JSON.stringify(path)} });
      let ok = 0, refused = 0;
      for (let i = 0; i < 500; i++) { try { run.reserve(0.01, 'r'); ok++; } catch (e) { if (e.name !== 'BudgetExceededError') throw e; refused++; } }
      console.log(JSON.stringify({ ok, refused }));`));
    const results = await Promise.all(procs.map(async p => { expect(await p.exited).toBe(0); return JSON.parse(await new Response(p.stdout).text()); }));
    expect(results.reduce((s, r) => s + r.ok, 0)).toBe(750);
    expect(results.reduce((s, r) => s + r.ok + r.refused, 0)).toBe(2000);
    const status = ledgerStatus({ ledgerPath: path, runId: owner.runId });
    expect(status.run!.committed_usd).toBeLessThanOrEqual(7.5 + 1e-9);
    expect(status.totals.requests).toBe(750);
    expect(verifyLedger(path).ok).toBe(true);
  }, 60_000);

  test('a writer paused between its cap check and its write cannot be overtaken', async () => {
    const path = join(tmp(), 'l.sqlite');
    initLedger({ ledgerPath: path, programCapUsd: 1000 });
    const owner = BudgetRun.open({ runner: 'pause', budgetUsd: 1, ledgerPath: path });
    const paused = child(`
      const run = L.BudgetRun.join({ runId: ${JSON.stringify(owner.runId)}, ledgerPath: ${JSON.stringify(path)} });
      L.ledgerTestHooks.afterCapCheck = () => { console.log('checked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); };
      run.reserve(0.7, 'paused writer');`);
    const reader = paused.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('checked');
    const t0 = Date.now();
    expect(() => owner.reserve(0.5, 'second writer')).toThrow('over its $1.00 budget');
    expect(Date.now() - t0).toBeGreaterThan(500);
    expect(await paused.exited).toBe(0);
    expect(ledgerStatus({ ledgerPath: path, runId: owner.runId }).run!.committed_usd).toBeCloseTo(0.7, 9);
  });
});

describe('conservative reservations', () => {
  const tools = Array.from({ length: 33 }, (_, i) => ({ name: `tool_${i}`, description: 'd'.repeat(1200), input_schema: { type: 'object', properties: { query: { type: 'string', description: 'p'.repeat(200) } }, required: ['query'] } }));

  test('an Anthropic request with tools and cache_control reserves for its schemas at the cache-write price', async () => {
    const body = { model: 'claude-sonnet-4-6', max_tokens: 1000, system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], tools, messages: [{ role: 'user', content: 'hi' }] };
    const price = priceRequest('https://api.anthropic.com/v1/messages', body)!;
    expect(price.cacheWritePremium).toBe(true);
    const schemaTokens = Math.ceil(Buffer.byteLength(JSON.stringify(tools)) / 4);
    const reported = { usage: { input_tokens: 10, cache_creation_input_tokens: schemaTokens, cache_read_input_tokens: 0, output_tokens: 1000 } };
    const actual = usageCost(price, reported)!.usd;
    expect(reservationUsd(price)).toBeGreaterThanOrEqual(actual);
    const withoutTools = priceRequest('https://api.anthropic.com/v1/messages', { ...body, tools: undefined })!;
    expect(reservationUsd(withoutTools)).toBeLessThan(actual);
    const path = join(tmp(), 'l.sqlite');
    initLedger({ ledgerPath: path });
    const run = BudgetRun.open({ runner: 'a', budgetUsd: 5, ledgerPath: path });
    const guard = installPaidRequestGuard(run, { fetchImpl: (async () => Response.json(reported)) as unknown as typeof fetch });
    try { await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify(body) }); }
    finally { guard.uninstall(); }
    expect(run.close().overshoot_usd).toBe(0);
  });

  test('an OpenAI continuation reserves the context its previous_response_id carries; an unknown id reserves a full window', async () => {
    const path = join(tmp(), 'l.sqlite');
    initLedger({ ledgerPath: path });
    const run = BudgetRun.open({ runner: 'a', budgetUsd: 20, ledgerPath: path });
    const turns = [
      { id: 'resp_1', usage: { input_tokens: 60_000, output_tokens: 2_000, input_tokens_details: { cached_tokens: 0 } } },
      { id: 'resp_2', usage: { input_tokens: 62_500, output_tokens: 1_500, input_tokens_details: { cached_tokens: 60_000 } } },
    ];
    let turn = 0;
    const guard = installPaidRequestGuard(run, { fetchImpl: (async () => Response.json(turns[turn++])) as unknown as typeof fetch });
    const send = (extra: Record<string, unknown>) => fetch('https://api.openai.com/v1/responses', { method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.4', instructions: 'i'.repeat(4000), tools, input: [{ role: 'user', content: 'q' }], max_output_tokens: 16_000, ...extra }) });
    try {
      await send({});
      await send({ previous_response_id: 'resp_1', input: [{ type: 'function_call_output', call_id: 'c', output: 'r'.repeat(1000) }] });
    } finally { guard.uninstall(); }
    const [first, second] = readLedger(path).entries;
    expect(second.reserved_usd).toBeGreaterThan(first.reserved_usd);
    expect(second.actual_usd!).toBeLessThanOrEqual(second.reserved_usd);
    expect(run.close().overshoot_usd).toBe(0);
    const unknown = priceRequest('https://api.openai.com/v1/responses', { model: 'gpt-5.4', previous_response_id: 'resp_elsewhere', input: 'x' })!;
    expect(unknown.inputTokens).toBeGreaterThan(UNKNOWN_CHAIN_CONTEXT_TOKENS);
  });

  test('a settled cost above its reservation is recorded as overshoot and counts against the next reserve', () => {
    const path = join(tmp(), 'l.sqlite');
    initLedger({ ledgerPath: path });
    const run = BudgetRun.open({ runner: 'a', budgetUsd: 1, ledgerPath: path });
    run.settle(run.reserve(0.2, 'undercounted'), { usd: 0.9 });
    expect(run.summary().overshoot_usd).toBeCloseTo(0.7, 9);
    expect(ledgerStatus({ ledgerPath: path }).totals.overshoot_usd).toBeCloseTo(0.7, 9);
    expect(() => run.reserve(0.2, 'next')).toThrow('over its $1.00 budget');
  });

  test('the cache-write premium applies to OpenAI models with a cache-write price, and to Anthropic only with cache_control', () => {
    expect(priceRequest('https://api.openai.com/v1/responses', { model: 'gpt-6.1-sol', input: 'x' })!.cacheWritePremium).toBe(true);
    expect(priceRequest('https://api.openai.com/v1/responses', { model: 'gpt-5.4', input: 'x' })!.cacheWritePremium).toBe(false);
    expect(priceRequest('https://api.anthropic.com/v1/messages', { model: 'claude-haiku-4-5', messages: [] })!.cacheWritePremium).toBe(false);
  });
});

describe('event-loop lag', () => {
  test('a deliberate 100 ms synchronous block registers at least 80 ms', async () => {
    const m = new LagMonitor().start();
    await Bun.sleep(60);
    const t = performance.now();
    while (performance.now() - t < 100) { /* block the loop */ }
    await Bun.sleep(60);
    m.stop();
    const s = m.stats()!;
    expect(s.max).toBeGreaterThanOrEqual(80);
    expect(s.p50).toBeLessThan(20);
  });

  test('startPaidRun records lag in the summary and receipt; a run without the monitor says why', async () => {
    const path = join(tmp(), 'l.sqlite');
    initLedger({ ledgerPath: path });
    const { run, guard } = startPaidRun('lag', { ...budgetOptionsFrom(['--budget-usd', '1', '--budget-ledger', path], {}), estimateUsd: null, log: () => {} });
    guard.uninstall();
    await Bun.sleep(50);
    const cost = receiptCost(run.close());
    expect(cost.event_loop_lag_ms).toMatchObject({ p50: expect.any(Number), p99: expect.any(Number), max: expect.any(Number) });
    const plain = BudgetRun.open({ runner: 'x', budgetUsd: 1, ledgerPath: path });
    expect(receiptCost(plain.close())).toMatchObject({ event_loop_lag_ms: null, event_loop_lag_unavailable: expect.stringContaining('startPaidRun') });
  });

  test('a refused start stops its monitor (no timer keeps the process alive)', () => {
    const before = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.().filter(x => x === 'Timeout').length ?? 0;
    expect(() => startPaidRun('x', { ...budgetOptionsFrom(['--budget-ledger', join(tmp(), 'none.sqlite')], {}), estimateUsd: null, log: () => {} })).toThrow('--budget-usd');
    const after = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.().filter(x => x === 'Timeout').length ?? 0;
    expect(after).toBe(before);
  });
});

describe('cost at scale', () => {
  /**
   * Fill the ledger with `n` settled entries the way months of runs would, then time reserve+settle pairs.
   * The ledger lives on tmpfs (/dev/shm) and the seeding writes are checkpointed before timing, so the clock
   * measures the ledger's own work per pair. On a disk, every pair waits for two `synchronous = FULL` commit
   * fsyncs whose latency is set by whatever else is writing to the runner's disk, not by the ledger's size.
   */
  function timePairs(n: number, pairs: number) {
    const dir = mkdtempSync(join(existsSync('/dev/shm') ? '/dev/shm' : tmpdir(), 'ledger-scale-'));
    dirs.push(dir);
    const path = join(dir, `scale-${n}.sqlite`);
    initLedger({ ledgerPath: path, programCapUsd: 1e9 });
    const run = BudgetRun.open({ runner: 'scale', budgetUsd: 1e8, ledgerPath: path });
    const db = new Database(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.transaction(() => {
      const ins = db.query(`INSERT INTO entries (id, run_id, description, reserved_usd, actual_usd, status, input_tokens, output_tokens, created_at, settled_at, participant)
        VALUES (?, ?, 'openai:gpt-5.4 chat', 0.05, 0.01, 'reconciled', 1000, 100, '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z', NULL)`);
      for (let i = 0; i < n; i++) ins.run(`seed-${i}`, run.runId);
      db.query('UPDATE runs SET committed_usd = committed_usd + ? WHERE run_id = ?').run(n * 0.01, run.runId);
      db.query('UPDATE program SET committed_usd = committed_usd + ? WHERE id = 1').run(n * 0.01);
    })();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const times: number[] = [];
    for (let i = 0; i < pairs; i++) {
      const t = performance.now();
      run.settle(run.reserve(0.05, 'openai:gpt-5.4 chat'), { usd: 0.01, input_tokens: 1000, output_tokens: 100 });
      times.push(performance.now() - t);
    }
    expect(verifyLedger(path).ok).toBe(true);
    const sorted = [...times].sort((a, b) => a - b);
    return { mean: times.reduce((a, b) => a + b, 0) / times.length, median: sorted[sorted.length >> 1] };
  }

  /** Record every SQL statement reserve+settle prepares, by wrapping Database.prototype.query for one pair. */
  function capturePairSql(path: string) {
    const run = BudgetRun.open({ runner: 'plan', budgetUsd: 1e8, ledgerPath: path });
    const seen: string[] = [];
    const proto = Database.prototype as unknown as { query: (sql: string) => unknown };
    const original = proto.query;
    proto.query = function (this: Database, sql: string) { seen.push(sql); return original.call(this, sql); };
    try { run.settle(run.reserve(0.05, 'openai:gpt-5.4 chat'), { usd: 0.01, input_tokens: 1000, output_tokens: 100 }); }
    finally { proto.query = original; }
    return [...new Set(seen)];
  }

  /** EXPLAIN QUERY PLAN detail rows for `sql` (parameters bound to NULL, which leaves the plan unchanged). */
  function planOf(db: Database, sql: string): string[] {
    const params = (sql.match(/\?/g) ?? []).map(() => null);
    return (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(r => r.detail);
  }

  test('reserve+settle never scans the entries table: every statement that reads it uses an index', () => {
    const path = join(tmp(), 'plan.sqlite');
    initLedger({ ledgerPath: path, programCapUsd: 1e9 });
    const statements = capturePairSql(path).filter(sql => /\bentries\b/.test(sql) && !/^\s*INSERT\b/i.test(sql));
    expect(statements.length).toBeGreaterThan(0);
    const db = new Database(path);
    try {
      for (const sql of statements) {
        const plan = planOf(db, sql);
        expect({ sql, scans: plan.filter(d => /^SCAN entries\b/.test(d)) }).toEqual({ sql, scans: [] });
        expect(plan.some(d => /^SEARCH entries USING (COVERING )?INDEX\b/.test(d))).toBe(true);
      }
      // The assertion bites: an unindexed predicate on entries plans as a SCAN.
      expect(planOf(db, 'SELECT reserved_usd FROM entries WHERE description = ?').some(d => /^SCAN entries\b/.test(d))).toBe(true);
    } finally { db.close(); }
  });

  test('reserve+settle median stays under 5 ms on a 200k-entry ledger, and does not grow with the ledger', () => {
    const small = timePairs(1_000, 200);
    const large = timePairs(200_000, 200);
    console.log(`[perf] reserve+settle per pair: 1k entries mean ${small.mean.toFixed(3)} ms (median ${small.median.toFixed(3)}); 200k entries mean ${large.mean.toFixed(3)} ms (median ${large.median.toFixed(3)})`);
    expect(large.median).toBeLessThan(5);
    expect(large.median).toBeLessThan(Math.max(2 * small.median, small.median + 1));
  }, 120_000);
});
