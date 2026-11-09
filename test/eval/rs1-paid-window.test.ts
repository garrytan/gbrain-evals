/**
 * RS1's paid-window guard (GST-1886): mint.sh, rs1_mint.py, validate.ts and `cell.ts run --manifest rs1` refuse a run
 * that is neither keyless nor inside a granted window, and one whose ledger cap, run budget or lease is above the window
 * cap, with exit 2 before any provider client exists. Paid minting and validation take Gemini's key only from
 * RS1_GEMINI_API_KEY. Keyless: every key here is a dummy, every refusal comes before any request, and the one upstream
 * named is a dead local port.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { campaignManifest, findCell, loadCellManifest, rs1CellWindow, type UnitSelection } from '../../eval/runner/q1/cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { paidWindowArgs, requireRs1Window, WindowRefusal } from '../../eval/runner/rs1/paid-window.ts';

const REPO = resolve(import.meta.dir, '../..');
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'rs1-window-')); roots.push(d); return d; };
afterAll(() => { closeLedgers(); for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const DUMMY = 'dummy-not-a-provider-key';
function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...env }, timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
/** A ledger whose program cap and one open run's budget are the given amounts. */
function ledger(cap: number, budget: number) {
  const path = join(scratch(), 'ledger.sqlite');
  initLedger({ ledgerPath: path, programCapUsd: cap, reason: 'test', log: () => {} });
  const r = BudgetRun.open({ runner: 'rs1-test', budgetUsd: budget, ledgerPath: path, log: () => {} });
  const id = r.runId;
  r.close();
  return { path, id: BudgetRun.open({ runner: 'rs1-test', budgetUsd: budget, ledgerPath: path, log: () => {} }).runId, closed: id };
}

describe('paid-window.ts', () => {
  test('a keyless run needs no window; otherwise both flags, and every cap known and at most the window cap', () => {
    expect(requireRs1Window([], { what: 'x', keyless: true, caps: () => [{ label: 'c', usd: null }] })).toBeNull();
    expect(() => requireRs1Window([], { what: 'x', keyless: false, caps: () => [] })).toThrow(/needs --paid-window <unit> and --window-cap-usd <n>/);
    for (const argv of [['--paid-window', 'U'], ['--window-cap-usd', '5'], ['--paid-window', 'a b', '--window-cap-usd', '5'], ['--paid-window', 'U', '--window-cap-usd', '0'], ['--paid-window', 'U', '--window-cap-usd', 'x']]) expect(() => paidWindowArgs(argv)).toThrow(WindowRefusal);
    const argv = ['--paid-window', 'RS1-MINT-1', '--window-cap-usd', '5'];
    expect(requireRs1Window(argv, { what: 'x', keyless: false, caps: () => [{ label: 'c', usd: 5 }] })).toEqual({ unit: 'RS1-MINT-1', cap_usd: 5 });
    expect(() => requireRs1Window(argv, { what: 'x', keyless: false, caps: () => [{ label: 'c', usd: 5.01 }] })).toThrow(/above paid window RS1-MINT-1's cap/);
    expect(() => requireRs1Window(argv, { what: 'x', keyless: false, caps: () => [{ label: 'c', usd: null }] })).toThrow(/is unknown/);
  });

  test('the check CLI passes a ledger within the window and refuses one above it, a closed run and a missing ledger, printing no amount', () => {
    const l = ledger(5, 4);
    const check = (cap: string, id = l.id, path = l.path) => run('bun', ['eval/runner/rs1/paid-window.ts', 'check', '--paid-window', 'RS1-MINT-1', '--window-cap-usd', cap, '--budget-ledger', path, '--budget-run-id', id]);
    expect(check('5')).toMatchObject({ code: 0, out: 'rs1-window ok unit=RS1-MINT-1\n' });
    for (const r of [check('4.5'), check('5', l.closed), check('5', l.id, join(scratch(), 'none.sqlite'))]) {
      expect(r.code).toBe(2);
      expect(r.err).toStartWith('rs1-window refused: ');
      expect(r.out + r.err).not.toMatch(/\$\d/);
    }
  });
});

describe('mint.sh and rs1_mint.py real mode', () => {
  const mint = (extra: string[], env: Record<string, string>) => {
    const dir = scratch(), out = join(dir, 'rs1-custody');
    return { ...run('bash', ['eval/custody/rs1/mint.sh', '--out', out, '--seed-file', join(dir, 'k.rs1-seed'), '--count', '1', ...extra], env), outExists: existsSync(out) };
  };
  const keys = { RS1_GEMINI_API_KEY: DUMMY, OPENAI_API_KEY: DUMMY };

  test('refuses without the window, with a ledger above it, and with no RS1_GEMINI_API_KEY, before anything is fetched or written', () => {
    const l = ledger(10, 10);
    const ledgerArgs = ['--budget-ledger', l.path, '--budget-run-id', l.id];
    const cases: Array<[string[], Record<string, string>, RegExp]> = [
      [ledgerArgs, keys, /real mode spends real keys, so it needs --paid-window <unit> and --window-cap-usd <n>/],
      [[...ledgerArgs, '--paid-window', 'RS1-MINT-1'], keys, /needs --paid-window <unit> and --window-cap-usd/],
      [[...ledgerArgs, '--paid-window', 'RS1-MINT-1', '--window-cap-usd', '5'], keys, /rs1-window refused: this run: the ledger's program cap .* is above paid window RS1-MINT-1's cap/],
      [['--paid-window', 'RS1-MINT-1', '--window-cap-usd', '10'], keys, /needs --budget-ledger and --budget-run-id/],
    ];
    for (const [args, env, want] of cases) {
      const r = mint(args, env);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(want);
      expect(r.outExists).toBe(false);
      expect(r.out + r.err).not.toContain(DUMMY);
    }
  });

  test('a paid mint refuses when only GEMINI_API_KEY is set: it never falls back to it', () => {
    const l = ledger(10, 10);
    const r = mint(['--budget-ledger', l.path, '--budget-run-id', l.id, '--paid-window', 'RS1-MINT-1', '--window-cap-usd', '10'], { GEMINI_API_KEY: DUMMY, OPENAI_API_KEY: DUMMY });
    expect([r.code, r.err]).toEqual([2, 'rs1-mint refused: RS1_GEMINI_API_KEY is not set; real mode takes Gemini\'s key only from it, never from GEMINI_API_KEY\n']);
    expect(r.outExists).toBe(false);
  });

  test('mint.sh hands the window and ledger to every real step, and gives the proxy RS1_GEMINI_API_KEY\'s value as GEMINI_API_KEY', () => {
    const src = require('node:fs').readFileSync(join(REPO, 'eval/custody/rs1/mint.sh'), 'utf8') as string;
    expect(src).toContain('[ "$MODE" != real ] || args+=(--paid-window "$WINDOW" --window-cap-usd "$WINDOW_CAP" --budget-ledger "$LEDGER" --budget-run-id "$RUN_ID")');
    expect(src).toContain('GEMINI_API_KEY="$RS1_GEMINI_API_KEY"');
    expect(src).not.toMatch(/\$\{GEMINI_API_KEY/);
  });

  test('a real rs1_mint.py step refuses without the window or with a ledger above it, before it reads anything', () => {
    const dir = scratch();
    const l = ledger(10, 8);
    const step = (extra: string[]) => run('python3', ['eval/custody/rs1/rs1_mint.py', 'step', '--out', join(dir, 'rs1-custody'), '--conv-index', '1', '--step', 'plan', '--seed-file', join(dir, 'missing.rs1-seed'), '--mode', 'real', '--beam-dir', dir, ...extra], { PYTHONDONTWRITEBYTECODE: '1' });
    const window = (cap: string) => ['--paid-window', 'RS1-MINT-1', '--window-cap-usd', cap];
    const cases: Array<[string[], string]> = [
      [[], 'a real step spends real keys, so it needs --paid-window <unit> and --window-cap-usd <n> from the granted paid window'],
      [window('10'), 'a real step needs --budget-ledger and --budget-run-id naming its open ledger run'],
      [[...window('9'), '--budget-ledger', l.path, '--budget-run-id', l.id], 'the ledger\'s program cap or the run\'s budget is above paid window RS1-MINT-1\'s cap; a run\'s cap never exceeds its window'],
      [[...window('10'), '--budget-ledger', l.path, '--budget-run-id', l.closed], 'the ledger has no program cap or no open run with that id'],
    ];
    for (const [extra, why] of cases) expect(step(extra)).toMatchObject({ code: 2, out: '', err: `rs1-mint refused: ${why}\n` });
    const passes = step([...window('10'), '--budget-ledger', l.path, '--budget-run-id', l.id]);
    expect(passes.code).toBe(1);
    expect(passes.err).not.toContain('paid window');
    expect(existsSync(join(dir, 'rs1-custody'))).toBe(false);
  });
});

describe('validate.ts --paid', () => {
  const validate = (extra: string[], env: Record<string, string>) => run('bun', ['eval/custody/rs1/validate.ts', '--set', join(scratch(), 'set'), '--beam-dir', scratch(), '--report', join(scratch(), 'report.json'), '--paid', ...extra], env);

  test('refuses without the window, with a ledger above it, and with only GEMINI_API_KEY, before any client exists', () => {
    const l = ledger(10, 10);
    const ledgerArgs = ['--budget-ledger', l.path, '--budget-run-id', l.id];
    const both = { RS1_GEMINI_API_KEY: DUMMY, GEMINI_API_KEY: DUMMY, ANTHROPIC_API_KEY: DUMMY };
    const cases: Array<[string[], Record<string, string>, RegExp]> = [
      [ledgerArgs, both, /^rs1-validate refused: paid validation spends real keys, so it needs --paid-window <unit> and --window-cap-usd <n>/],
      [[...ledgerArgs, '--paid-window', 'RS1-MINT-1', '--window-cap-usd', '9.99'], both, /^rs1-validate refused: paid validation: the ledger's program cap .* is above paid window RS1-MINT-1's cap/],
      [['--paid-window', 'RS1-MINT-1', '--window-cap-usd', '10', '--budget-run-id', 'nope', '--budget-ledger', l.path], both, /^rs1-validate refused: paid validation: budget run nope is unknown/],
      [[...ledgerArgs, '--paid-window', 'RS1-MINT-1', '--window-cap-usd', '10'], { GEMINI_API_KEY: DUMMY, ANTHROPIC_API_KEY: DUMMY }, /^rs1-validate refused: paid validation needs RS1_GEMINI_API_KEY, the dedicated paid-tier Gemini key; GEMINI_API_KEY is never used\n$/],
    ];
    for (const [args, env, want] of cases) {
      const r = validate(args, env);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(want);
      expect(r.out + r.err).not.toContain(DUMMY);
    }
    const inWindow = validate([...ledgerArgs, '--paid-window', 'RS1-MINT-1', '--window-cap-usd', '10'], both);
    expect([inWindow.code, inWindow.err]).toEqual([2, expect.stringMatching(/holds no conversations\/\n$/)]);
  });
});

describe('cell.ts run --manifest rs1', () => {
  const def = findCell('rs1.baseline-none.baseline', undefined, 'rs1');
  const window = ['--paid-window', 'RS1-WA-CELLS', '--window-cap-usd', '50'];
  const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; } return null; };
  const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };

  test('refuses a run without the window, before any provider client, and a keyless lease proxy needs none', () => {
    withEnv({ SHOOTOUT_KEYLESS_UPSTREAM: undefined, SHOOTOUT_LEASE_USD: undefined }, () => {
      expect(refusal(() => rs1CellWindow([], def, null))).toMatchObject({ code: 'PAID_FLAGS_MISSING', message: expect.stringContaining('needs --paid-window <unit> and --window-cap-usd <n>'), fix: { next: 'run' } });
      expect(refusal(() => rs1CellWindow([], def, 'http://127.0.0.1:9'))?.code).toBe('PAID_FLAGS_MISSING');
    });
    withEnv({ SHOOTOUT_KEYLESS_UPSTREAM: 'http://127.0.0.1:9', SHOOTOUT_LEASE_USD: undefined }, () => {
      expect(refusal(() => rs1CellWindow([], def, 'http://127.0.0.1:9'))).toBeNull();
      expect(refusal(() => rs1CellWindow([], def, null))?.code).toBe('PAID_FLAGS_MISSING');
    });
  });

  test('under a lease proxy the lease, and without one the ledger cap and run budget, may not exceed the window cap', () => {
    withEnv({ SHOOTOUT_KEYLESS_UPSTREAM: undefined, SHOOTOUT_LEASE_USD: '50' }, () => expect(refusal(() => rs1CellWindow(window, def, 'http://127.0.0.1:9'))).toBeNull());
    withEnv({ SHOOTOUT_KEYLESS_UPSTREAM: undefined, SHOOTOUT_LEASE_USD: '50.5' }, () => expect(refusal(() => rs1CellWindow(window, def, 'http://127.0.0.1:9'))?.message).toContain('the campaign lease (SHOOTOUT_LEASE_USD) is above paid window RS1-WA-CELLS\'s cap'));
    withEnv({ SHOOTOUT_KEYLESS_UPSTREAM: undefined, SHOOTOUT_LEASE_USD: undefined }, () => {
      expect(refusal(() => rs1CellWindow(window, def, 'http://127.0.0.1:9'))?.message).toContain('the campaign lease (SHOOTOUT_LEASE_USD) is unknown');
      const ok = ledger(50, 40), over = ledger(60, 40);
      expect(refusal(() => rs1CellWindow([...window, '--budget-ledger', ok.path, '--budget-run-id', ok.id], def, null))).toBeNull();
      expect(refusal(() => rs1CellWindow([...window, '--budget-ledger', over.path, '--budget-run-id', over.id], def, null))?.message).toContain('the ledger\'s program cap');
    });
  });

  test('the CLI exits 2 with the refusal, for RS1 cells only', () => {
    const env = { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', BRAINBENCH_BUDGET_LEDGER: join(scratch(), 'ledger.sqlite') };
    const rs1 = run('bun', ['eval/runner/q1/cell.ts', 'run', '--cell', 'rs1.baseline-none.baseline', '--manifest', 'rs1', '--shard', '0/7', '--out', join(scratch(), 'out')], env);
    expect(rs1.code).toBe(2);
    expect(rs1.err).toContain('PAID_FLAGS_MISSING');
    expect(rs1.err).toContain('--paid-window');
    const q1 = run('bun', ['eval/runner/q1/cell.ts', 'run', '--cell', findCell(loadCellManifest().cells[0].id).id, '--out', join(scratch(), 'q1')], env);
    expect(q1.err).not.toContain('paid window');
  });

  test('an RS1 campaign names its paid window in every unit\'s command and needs one', () => {
    const m = loadCellManifest('rs1');
    const sel: UnitSelection = { campaign_id: 'q1-scoreboard-rs1-narrow-wave-a', cap_usd: 625.56, units: ['rs1.baseline-none.baseline.c0', 'rs1.gbrain-defaults.rs1-stable.c1'], cell_manifest: 'rs1', paid_window: 'RS1-WA-CELLS' };
    const c = campaignManifest(m, { units: sel });
    expect(c.cap_usd).toBe(625.56);
    for (const cell of c.cells) expect(cell.command).toMatch(new RegExp(`--manifest rs1 --shard ${cell.id.at(-1)}/7 (--system-url \\S+ )?--paid-window RS1-WA-CELLS --window-cap-usd 625\\.56 --out "\\$SHOOTOUT_OUT"`));
    const { paid_window: _, ...bare } = sel;
    for (const bad of [bare, { ...sel, paid_window: 'a b' }]) expect(() => campaignManifest(m, { units: bad })).toThrow(/an RS1 campaign needs a unit selection naming its granted paid window/);
    expect(() => campaignManifest(m)).toThrow(/an RS1 campaign needs/);
    for (const cell of campaignManifest(loadCellManifest()).cells) expect(cell.command).not.toContain('--paid-window');
  });
});
