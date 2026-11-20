/**
 * Keys and paid flags in the nightly runner: the launcher environment of keyless suites holds no key-like variable and
 * points every provider at a dead loopback port; a paid child gets only the keys it names; and run.ts refuses any night
 * that would call a model without --fake or --paid with a ledger run.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, initLedger, ledgerStatus } from '../../eval/runner/budget-ledger.ts';
import { PaidArmRefusal } from '../../eval/runner/paid-arm.ts';
import { envFor, runChild } from '../../eval/runner/nightly/adapters.ts';
import { loadDevSet } from '../../eval/runner/nightly/devset.ts';
import { BASE_URL_VARS, DEAD_UPSTREAM, keyLikeVariables, keylessEnv, paidEnv, stripKeys } from '../../eval/runner/nightly/keyless.ts';
import { closeNightRun, openNightRun } from '../../eval/runner/nightly/ledger.ts';
import { paidGate, parseArgs, planSuites } from '../../eval/runner/nightly/run.ts';

const ROOT = resolve(import.meta.dir, '../..');
const FIXTURE_ENV = { PATH: '/usr/bin:/bin', HOME: '/home/example', OPENAI_API_KEY: 'sk-fixture', ANTHROPIC_API_KEY: 'fixture', UBICLOUD_API_KEY: 'fixture',
  GITHUB_TOKEN: 'fixture', PG_PASSWORD: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture', OPENAI_BASE_URL: 'https://api.openai.com/v1', TYPESAFE_KEY: 'fixture' };
const tmp = () => mkdtempSync(join(tmpdir(), 'nightly-keys-'));

describe('the keyless launcher environment', () => {
  test('no key-like variable survives; every provider base URL is the dead loopback port; ordinary variables stay', () => {
    const env = keylessEnv(FIXTURE_ENV);
    expect(keyLikeVariables(env).filter(k => !(BASE_URL_VARS as readonly string[]).includes(k))).toEqual([]);
    for (const k of BASE_URL_VARS) expect(env[k]).toBe(DEAD_UPSTREAM);
    expect(env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/home/example', GBRAIN_MODEL_DISCOVERY: 'off' });
    expect(Object.values(env)).not.toContain('fixture');
    expect(Object.values(env)).not.toContain('sk-fixture');
  });

  test('no child starts once the night is aborted', async () => {
    const dir = tmp();
    const marker = join(dir, 'started');
    const abort = new AbortController();
    abort.abort();
    const r = await runChild({ cmd: ['bun', '--no-env-file', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], env: keylessEnv(), log: join(dir, 'child.log'), signal: abort.signal });
    expect(r.code).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  test('a child launched with it sees no key, even when the parent holds one', async () => {
    const dir = tmp();
    const r = await runChild({ cmd: ['bun', '--no-env-file', '-e', 'console.log(JSON.stringify(Object.entries(process.env).filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k) || v === "sk-fixture").map(([k]) => k)))'],
      env: keylessEnv({ ...process.env, ...FIXTURE_ENV, PATH: process.env.PATH }), log: join(dir, 'child.log') });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'child.log'), 'utf8').trim())).toEqual([]);
  });

  test('nothing listens on the dead upstream, so a provider call fails at once', async () => {
    await expect(fetch(`${DEAD_UPSTREAM}/v1/models`)).rejects.toThrow();
  });

  test('a paid child gets only the keys it names, and a missing key refuses', () => {
    const env = paidEnv(['openai'], FIXTURE_ENV);
    expect(keyLikeVariables(env)).toEqual(['OPENAI_API_KEY']);
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(() => paidEnv(['voyage'], FIXTURE_ENV)).toThrow('VOYAGE_API_KEY is not set');
  });

  test('envFor: keyless on a fake night and for keyless suites; the named keys only for a model suite on a paid night', () => {
    const paidNight = { fake: false, paid: { runId: 'r', ledger: '/l' } };
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { ANTHROPIC_API_KEY: 'fixture', OPENAI_API_KEY: 'sk-fixture' });
      expect(keyLikeVariables(envFor({ fake: true, paid: null }, { kind: 'agent' }, ['anthropic'])).filter(k => !k.endsWith('_BASE_URL'))).toEqual([]);
      expect(keyLikeVariables(envFor(paidNight, { kind: 'replay' }, ['anthropic'])).filter(k => !k.endsWith('_BASE_URL'))).toEqual([]);
      expect(keyLikeVariables(envFor(paidNight, { kind: 'agent' }, ['anthropic']))).toEqual(['ANTHROPIC_API_KEY']);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  test('stripKeys removes every key-like variable from an environment', () => {
    const env: Record<string, string | undefined> = { ...FIXTURE_ENV };
    stripKeys(env);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
  });
});

describe('paid flags without a ledger run are refused', () => {
  const devset = loadDevSet();
  const gate = (...argv: string[]) => { const a = parseArgs(['--out', tmp(), ...argv]); return paidGate(a, planSuites(devset, a)); };
  const ledger = () => { const p = join(tmp(), 'ledger.sqlite'); initLedger({ ledgerPath: p, programCapUsd: 100, reason: 'nightly test' }); return p; };

  test('a night with model suites and neither --fake nor --paid', () => {
    expect(() => gate('--tier', 'nightly')).toThrow(PaidArmRefusal);
    expect(() => gate('--tier', 'nightly')).toThrow('refresh-barrier-agents, refused-write-agents calls models: pass --fake for a keyless run');
  });

  test('--paid without a ledger, without a run, or with a run the ledger does not hold; a run id without --paid; --fake with --paid', () => {
    const l = ledger();
    expect(() => gate('--paid')).toThrow(PaidArmRefusal);
    expect(() => gate('--paid', '--budget-ledger', l)).toThrow("--paid needs the night's ledger run");
    expect(() => gate('--budget-run-id', 'nightly:x', '--budget-ledger', l)).toThrow(PaidArmRefusal);
    expect(() => gate('--paid', '--budget-ledger', l, '--budget-run-id', 'no-such-run')).toThrow('budget run no-such-run is not in the ledger');
    expect(() => gate('--fake', '--paid')).toThrow('--fake makes no paid call');
  });

  test('keyless suites need no flag; --fake needs none; caps open the night\'s run under the nightly prefix', () => {
    expect(gate('--suites', 'tool-contract-replay,concurrent-writers')).toBeNull();
    expect(gate('--tier', 'matrix', '--fake')).toBeNull();
    const l = ledger();
    const run = gate('--paid', '--budget-ledger', l, '--night', '2026-11-09', '--night-cap-usd', '3', '--month-cap-usd', '5')!;
    expect(run.runId.startsWith('nightly:2026-11-09:master-')).toBe(true);
    expect(ledgerStatus({ ledgerPath: l, runId: run.runId }).run).toMatchObject({ budget_usd: 3, finished_at: null });
  });

  test('a --budget-run-id from another runner is refused', () => {
    const l = ledger();
    const other = BudgetRun.open({ runner: 'another-eval', budgetUsd: 10, ledgerPath: l });
    expect(() => gate('--paid', '--budget-ledger', l, '--budget-run-id', other.runId)).toThrow(PaidArmRefusal);
    expect(() => gate('--paid', '--budget-ledger', l, '--budget-run-id', other.runId)).toThrow('belongs to another-eval, not to a nightly run');
  });

  test('a --budget-run-id of a closed nightly run is refused', () => {
    const l = ledger();
    const closed = openNightRun({ ledgerPath: l, night: '2026-11-08', ref: 'master', nightCapUsd: 3, monthCapUsd: 50 }).runId;
    closeNightRun(l, closed);
    expect(() => gate('--paid', '--budget-ledger', l, '--budget-run-id', closed)).toThrow('is a closed nightly run');
  });

  test('the gate says whether the night opened its ledger run itself', () => {
    const l = ledger();
    const given = openNightRun({ ledgerPath: l, night: '2026-11-09', ref: 'matrix', nightCapUsd: 3, monthCapUsd: 50 }).runId;
    expect(gate('--paid', '--budget-ledger', l, '--budget-run-id', given)).toMatchObject({ runId: given, opened: false });
    expect(gate('--paid', '--budget-ledger', l, '--night', '2026-11-10', '--night-cap-usd', '3', '--month-cap-usd', '50')).toMatchObject({ opened: true });
  });

  test('run.ts refuses before it builds anything (exit 2)', () => {
    const clone = tmp();
    execFileSync('git', ['-C', clone, 'init', '-q']);
    writeFileSync(join(clone, 'README'), 'fixture\n');
    execFileSync('git', ['-C', clone, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qam', 'fixture', '--allow-empty']);
    execFileSync('git', ['-C', clone, 'add', 'README']);
    execFileSync('git', ['-C', clone, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'readme']);
    const r = spawnSync('bun', ['--no-env-file', join(ROOT, 'eval/runner/nightly/run.ts'), '--ref', 'HEAD', '--tier', 'nightly', '--out', tmp(), '--gbrain-clone', clone],
      { cwd: ROOT, env: keylessEnv(), encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('calls models: pass --fake for a keyless run, or --paid --budget-ledger <path>');
  }, 60_000);
});
