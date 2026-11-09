/**
 * The paid-window guard (eval/runner/paid-arm.ts) and its command line (eval/runner/rs1/paid-window.ts), shared by
 * every entry point that can spend real keys, and the re-read's window flags (eval/runner/q1/reread-cell.ts): a run
 * that is neither keyless nor inside a granted window refuses, and so does one whose ledger cap or run budget is above
 * the window cap, with exit 2 before any provider client or output exists. Keyless: no key is set and nothing is sent.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { ledgerCaps, paidWindowArgs, requireRs1Window, WindowRefusal } from '../../eval/runner/paid-arm.ts';
import { loadManifest } from '../../eval/runner/q1/cells/definitions.ts';

const REPO = resolve(import.meta.dir, '../..');
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'paid-window-')); roots.push(d); return d; };
afterAll(() => { closeLedgers(); for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function run(args: string[]) {
  const r = spawnSync('bun', args, { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' }, timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
/** A ledger whose program cap and one open run's budget are the given amounts, with a closed run beside it. */
function ledger(cap: number, budget: number) {
  const path = join(scratch(), 'ledger.sqlite');
  initLedger({ ledgerPath: path, programCapUsd: cap, reason: 'test', log: () => {} });
  const closed = BudgetRun.open({ runner: 'window-test', budgetUsd: budget, ledgerPath: path, log: () => {} });
  closed.close();
  return { path, id: BudgetRun.open({ runner: 'window-test', budgetUsd: budget, ledgerPath: path, log: () => {} }).runId, closed: closed.runId };
}

describe('the guard', () => {
  // Value: protects=no entry point that can spend real keys runs outside a granted window or under a cap above it; fails_when=requireRs1Window passes a run with no window, half a window, an unknown cap or a cap above the window, or refuses a keyless run; why_new=the guard is new on main; seam=none; no_claim=which entry points call it
  test('a keyless run needs no window; otherwise both flags, and every cap known and at most the window cap', () => {
    expect(requireRs1Window([], { what: 'x', keyless: true, caps: () => [{ label: 'c', usd: null }] })).toBeNull();
    expect(() => requireRs1Window([], { what: 'x', keyless: false, caps: () => [] })).toThrow(/needs --paid-window <unit> and --window-cap-usd <n>/);
    for (const argv of [['--paid-window', 'U'], ['--window-cap-usd', '5'], ['--paid-window', 'a b', '--window-cap-usd', '5'], ['--paid-window', 'U', '--window-cap-usd', '0'], ['--paid-window', 'U', '--window-cap-usd', 'x']]) expect(() => paidWindowArgs(argv)).toThrow(WindowRefusal);
    expect(paidWindowArgs([])).toBeNull();
    const argv = ['--paid-window', 'TEST-WINDOW-1', '--window-cap-usd', '5'];
    expect(requireRs1Window(argv, { what: 'x', keyless: false, caps: () => [{ label: 'c', usd: 5 }] })).toEqual({ unit: 'TEST-WINDOW-1', cap_usd: 5 });
    expect(() => requireRs1Window(argv, { what: 'x', keyless: false, caps: () => [{ label: 'c', usd: 5.01 }] })).toThrow(/above paid window TEST-WINDOW-1's cap/);
    expect(() => requireRs1Window(argv, { what: 'x', keyless: false, caps: () => [{ label: 'c', usd: null }] })).toThrow(/is unknown/);
  });

  test('ledgerCaps reads the program cap and an open run\'s budget, and leaves a closed or missing run unknown', () => {
    const l = ledger(5, 4);
    expect(ledgerCaps(l.path, l.id).map(c => c.usd)).toEqual([5, 4]);
    expect(ledgerCaps(l.path, l.closed).map(c => c.usd)).toEqual([5, null]);
    expect(ledgerCaps(l.path, undefined).map(c => c.usd)).toEqual([5, null]);
    expect(ledgerCaps(join(scratch(), 'none.sqlite'), l.id).map(c => c.usd)).toEqual([null, null]);
  });

  test('the check CLI passes a ledger within the window and refuses one above it, a closed run and a missing ledger, printing no amount', () => {
    const l = ledger(5, 4);
    const check = (cap: string, id = l.id, path = l.path) => run(['eval/runner/rs1/paid-window.ts', 'check', '--paid-window', 'TEST-WINDOW-1', '--window-cap-usd', cap, '--budget-ledger', path, '--budget-run-id', id]);
    expect(check('5')).toMatchObject({ code: 0, out: 'rs1-window ok unit=TEST-WINDOW-1\n' });
    for (const r of [check('4.5'), check('5', l.closed), check('5', l.id, join(scratch(), 'none.sqlite')), run(['eval/runner/rs1/paid-window.ts', 'check', '--paid-window', 'TEST-WINDOW-1', '--window-cap-usd', '5'])]) {
      expect(r.code).toBe(2);
      expect(r.err).toStartWith('rs1-window refused: ');
      expect(r.out + r.err).not.toMatch(/\$\d/);
    }
  });
});

describe('the re-read\'s window flags', () => {
  // Value: protects=no re-read reaches a real provider outside a granted paid window; fails_when=reread-cell.ts without --keyless-upstream takes the paid branch with no window, or with a ledger cap above the window's; why_new=the re-read's window flags are new on main; seam=none; no_claim=the keyless branch's own run
  test('without --keyless-upstream it needs --paid-window and --window-cap-usd, and refuses a ledger cap above the window cap, before any lease or output', () => {
    const tmp = scratch();
    const cell = loadManifest().cells[0];
    const base = (out: string) => ['eval/runner/q1/reread-cell.ts', '--cell', cell.id, '--arm', cell.arms[0].id, '--source', join(tmp, 'missing'), '--reader', 'particle:particle-1',
      '--out', out, '--budget-ledger', join(out, 'ledger.sqlite'), '--run-id', 'guard', '--lease-usd', '1', '--ledger-cap-usd', '2'];
    const bare = join(tmp, 'bare'), half = join(tmp, 'half'), over = join(tmp, 'over');
    for (const r of [run(base(bare)), run([...base(half), '--paid-window', 'TEST-WINDOW-1'])]) {
      expect(r.code).toBe(2);
      expect(r.err).toContain('needs --paid-window <unit> and --window-cap-usd <n>');
    }
    const o = run([...base(over), '--paid-window', 'TEST-WINDOW-1', '--window-cap-usd', '1']);
    expect(o.code).toBe(2);
    expect(o.err).toContain("above the paid window's cap of 1");
    for (const d of [bare, half, over]) expect(existsSync(d)).toBe(false);
  });
});
