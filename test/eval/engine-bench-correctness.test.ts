import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareCheck, correctnessChecks, parseRefusal, readRun, runCorrectness, runnerEnv, rustStageVerdict,
  type CheckSpec, type EngineRun,
} from '../../eval/runner/engine-bench/correctness.ts';
import { EvalEngineUnavailable, evalEngineRefusalMessage, rawSqlNotApplicable, type EvalEngineKind } from '../../eval/runner/eval-engine.ts';
import type { GbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { N6_SQL_CHECKS } from '../../eval/runner/n6-visibility-fuzz.ts';

const CHECK: CheckSpec = {
  id: 'fake', label: 'fake', script: 'fake.js', args: [],
  contracts: [
    { id: 'leaks', path: 'data.metrics.leaks' },
    { id: 'sealed', path: 'data.metrics.sealed', na_check: 'fake sealed check' },
  ],
};

const SEALED_NA = rawSqlNotApplicable('rust', 'fake sealed check', 'scan chunks')!;

function run(engine: EvalEngineKind, verdict: 'pass' | 'fail', metrics: Record<string, number>, notApplicable: unknown[] = []): EngineRun {
  return readRun(CHECK, { engine, exit_code: verdict === 'pass' ? 0 : 1, wall_ms: 1, log: 'x.log', receipt: 'r.json' }, { verdict, not_applicable: notApplicable, data: { metrics } });
}
const refused = (engine: EvalEngineKind, reason = 'rust_engine_not_in_build'): EngineRun =>
  readRun(CHECK, { engine, exit_code: 69, wall_ms: 1, log: 'x.log', refusal_reason: reason, refusal_message: 'm' }, null);

describe('correctness checks table', () => {
  test('six checks, each with contract counts, and the N6 sealed-chunk contract tied to its raw SQL check', () => {
    const checks = correctnessChecks();
    expect(checks.map(c => c.id)).toEqual(['n1', 'n5', 'n6', 'n6-http', 'n12', 'n14']);
    for (const c of checks) expect(c.contracts.length).toBeGreaterThan(0);
    const sealed = checks.find(c => c.id === 'n6')!.contracts.find(c => c.id === 'sealed_chunk_violations')!;
    expect(sealed.na_check).toBe(N6_SQL_CHECKS.sealed_chunks.check);
    expect(checks.find(c => c.id === 'n14')!.args).toEqual(['--tiers', '2mb']);
    expect(correctnessChecks({ n14Tiers: '2mb,8mb' }).find(c => c.id === 'n14')!.args).toEqual(['--tiers', '2mb,8mb']);
  });
});

describe('parseRefusal', () => {
  test('reads the reason from the line a runner prints before exit 69', () => {
    const line = evalEngineRefusalMessage(new EvalEngineUnavailable('rust', 'addon_unavailable', 'no addon.'), 'n6');
    expect(parseRefusal(`noise\n${line}\n`)).toEqual({ reason: 'addon_unavailable', message: line.slice('REFUSED: '.length) });
    expect(parseRefusal('nothing here')).toBeNull();
  });
});

describe('compareCheck', () => {
  test('rust passes when its verdict is pass and every count equals both TypeScript engines', () => {
    const { row, findings } = compareCheck(CHECK, [run('pglite', 'pass', { leaks: 0, sealed: 0 }), run('postgres', 'pass', { leaks: 0, sealed: 0 }), run('rust', 'pass', { leaks: 0, sealed: 0 })]);
    expect(row.rust).toEqual({ verdict: 'pass', reasons: [], gaps: [] });
    expect(findings).toEqual([]);
    expect(row.typescript.compared).toEqual(['pglite', 'postgres']);
  });
  test('rust fails on a count the TypeScript engines do not have, even with a pass verdict', () => {
    const { row } = compareCheck(CHECK, [run('pglite', 'pass', { leaks: 0, sealed: 0 }), run('postgres', 'pass', { leaks: 0, sealed: 0 }), run('rust', 'pass', { leaks: 1, sealed: 0 })]);
    expect(row.rust!.verdict).toBe('fail');
    expect(row.rust!.reasons[0]).toMatch(/leaks = 1 on rust/);
  });
  test('rust fails when its own verdict fails', () => {
    expect(compareCheck(CHECK, [run('pglite', 'pass', { leaks: 0, sealed: 0 }), run('rust', 'fail', { leaks: 0, sealed: 0 })]).row.rust!.verdict).toBe('fail');
  });
  test('a TypeScript contract failure is a gbrain finding and rust must match the better TypeScript engine', () => {
    const ts = [run('pglite', 'fail', { leaks: 2, sealed: 0 }), run('postgres', 'pass', { leaks: 0, sealed: 0 })];
    const worse = compareCheck(CHECK, [...ts, run('rust', 'pass', { leaks: 1, sealed: 0 })]);
    expect(worse.row.rust!.verdict).toBe('fail');
    expect(worse.findings.map(f => f.kind).sort()).toEqual(['typescript_contract_failure', 'typescript_engines_differ', 'typescript_verdict_fail']);
    expect(worse.row.typescript.differences).toEqual(['leaks: pglite 2, postgres 0']);
    expect(compareCheck(CHECK, [...ts, run('rust', 'pass', { leaks: 0, sealed: 0 })]).row.rust!.verdict).toBe('pass');
    const bothFail = [run('pglite', 'fail', { leaks: 2, sealed: 0 }), run('postgres', 'fail', { leaks: 2, sealed: 0 })];
    expect(compareCheck(CHECK, [...bothFail, run('rust', 'pass', { leaks: 2, sealed: 0 })]).row.rust!.verdict).toBe('pass');
    expect(compareCheck(CHECK, [...bothFail, run('rust', 'pass', { leaks: 3, sealed: 0 })]).row.rust!.verdict).toBe('fail');
  });
  test('a not_applicable contract on rust is carried with its reason and the rest still decide', () => {
    const r = run('rust', 'pass', { leaks: 0 }, [SEALED_NA]);
    expect(r.contracts.sealed).toEqual({ value: null, not_applicable: SEALED_NA });
    const { row } = compareCheck(CHECK, [run('pglite', 'pass', { leaks: 0, sealed: 0 }), run('postgres', 'pass', { leaks: 0, sealed: 0 }), r]);
    expect(row.engines.rust!.status).toBe('pass');
    expect(row.rust).toEqual({ verdict: 'pass', reasons: ['sealed not_applicable'], gaps: [SEALED_NA] });
    expect(row.engines.rust!.not_applicable).toEqual([SEALED_NA]);
  });
  test('a check whose every contract is not_applicable on rust is unmeasured', () => {
    const allNa: CheckSpec = { ...CHECK, contracts: [CHECK.contracts[1]!] };
    const r = readRun(allNa, { engine: 'rust', exit_code: 0, wall_ms: 1, log: 'x', receipt: 'r' }, { verdict: 'pass', not_applicable: [SEALED_NA], data: { metrics: {} } });
    const pg = readRun(allNa, { engine: 'pglite', exit_code: 0, wall_ms: 1, log: 'x', receipt: 'r' }, { verdict: 'pass', data: { metrics: { sealed: 0 } } });
    const { row } = compareCheck(allNa, [pg, r]);
    expect(row.engines.rust!.status).toBe('unmeasured');
    expect(row.rust!.verdict).toBe('unmeasured');
  });
  test('exit 69 is refused with its reason, never fail', () => {
    const { row } = compareCheck(CHECK, [run('pglite', 'pass', { leaks: 0, sealed: 0 }), refused('rust')]);
    expect(row.engines.rust!.status).toBe('refused');
    expect(row.rust).toEqual({ verdict: 'refused', reasons: ['refused (rust_engine_not_in_build)'], gaps: [] });
  });
  test('a rust runner error is a failure when a TypeScript engine measured the check', () => {
    const crashed = { engine: 'rust' as const, exit_code: 3, wall_ms: 1, log: 'x', error: 'exit 3, no receipt: crash' };
    const { row } = compareCheck(CHECK, [run('pglite', 'pass', { leaks: 0, sealed: 0 }), readRun(CHECK, crashed, null)]);
    expect(row.engines.rust!.status).toBe('error');
    expect(row.rust).toEqual({ verdict: 'fail', reasons: ['runner error: exit 3, no receipt: crash'], gaps: [] });
  });
  test('rust is unmeasured when no TypeScript engine measured the check', () => {
    const { row } = compareCheck(CHECK, [refused('pglite', 'engine_not_supported_by_runner'), run('rust', 'pass', { leaks: 0, sealed: 0 })]);
    expect(row.rust!.verdict).toBe('unmeasured');
    expect(row.engines.pglite!.status).toBe('refused');
  });
  test('without a rust arm there is no rust row, and a TypeScript difference is still a finding', () => {
    const { row, findings } = compareCheck(CHECK, [run('pglite', 'pass', { leaks: 0, sealed: 0 }), run('postgres', 'fail', { leaks: 0, sealed: 1 })]);
    expect(row.rust).toBeNull();
    expect(findings.filter(f => f.kind === 'typescript_engines_differ').map(f => f.contract)).toEqual(['sealed']);
  });
});

describe('rustStageVerdict', () => {
  const row = (v: 'pass' | 'fail' | 'unmeasured' | 'refused' | null) => ({ rust: v ? { verdict: v, reasons: [] } : null }) as never;
  test('fail beats everything, all refused is refused, all pass is pass, otherwise unmeasured', () => {
    expect(rustStageVerdict([row('pass'), row('fail'), row('refused')])).toBe('fail');
    expect(rustStageVerdict([row('refused'), row('refused')])).toBe('refused');
    expect(rustStageVerdict([row('pass'), row('pass')])).toBe('pass');
    expect(rustStageVerdict([row('pass'), row('refused')])).toBe('unmeasured');
    expect(rustStageVerdict([row('pass'), row('unmeasured')])).toBe('unmeasured');
    expect(rustStageVerdict([row(null)])).toBeNull();
  });
});

describe('runnerEnv', () => {
  test('drops provider keys and sets the engine and the shared Postgres URL', () => {
    const env = runnerEnv('rust', 'postgres://u@h:1/postgres', { PATH: '/bin', ZZ_FAKE_API_KEY: 'not-a-key', GBRAIN_EVAL_ENGINE: 'pglite' });
    expect(env).toEqual({ PATH: '/bin', GBRAIN_EVAL_ENGINE: 'rust', LIFECYCLE_PG_URL: 'postgres://u@h:1/postgres', N14_PG_ADMIN_URL: 'postgres://u@h:1/postgres' });
  });
});

describe('runCorrectness with fake runners', () => {
  // A fake runner reads its plan for the engine GBRAIN_EVAL_ENGINE names, records what it was given (names only,
  // never values) and either writes a receipt or exits like the real runners do.
  const FAKE = `
const fs = require('node:fs'); const path = require('node:path');
const argv = process.argv.slice(2);
const out = argv[argv.indexOf('--output') + 1];
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8'))[process.env.GBRAIN_EVAL_ENGINE];
fs.writeFileSync(path.join(out, 'seen.json'), JSON.stringify({ argv, pg: process.env.LIFECYCLE_PG_URL, n14: process.env.N14_PG_ADMIN_URL, key: 'ZZ_FAKE_API_KEY' in process.env }));
if (plan.refusal) { console.error(plan.refusal); process.exit(69); }
if (plan.receipt) fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(plan.receipt));
process.exit(plan.exit);
`;
  const gut: GbrainUnderTest = {
    root: mkdtempSync(join(tmpdir(), 'correctness-gut-')), version: '0.0.0-fake',
    overlay: { requested: 'gbrain@v0.0.0-fake', checkout: '/fake/gbrain', ref: 'v0.0.0-fake', checkout_dirty: false, build: { commit: 'c0ffee', tree: 't', version: '0.0.0-fake', verified: {} } as unknown as NonNullable<GbrainUnderTest['overlay']>['build'] },
  };
  const ran = { execution: { product: { loaded_git_head: 'c0ffee' } } };

  async function stage(plan: Record<string, unknown>, engines: EvalEngineKind[], seedWork?: (work: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'correctness-test-'));
    writeFileSync(join(dir, 'fake.js'), FAKE);
    seedWork?.(join(dir, 'work'));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
    const saved = { plan: process.env.FAKE_PLAN, key: process.env.ZZ_FAKE_API_KEY };
    process.env.FAKE_PLAN = join(dir, 'plan.json');
    process.env.ZZ_FAKE_API_KEY = 'not-a-key';
    try {
      const out = await runCorrectness({ gut, engines, postgresUrl: 'postgres://u@127.0.0.1:1/postgres', workDir: join(dir, 'work'), outDir: join(dir, 'out'), checks: [{ ...CHECK, script: join(dir, 'fake.js') }], cwd: dir });
      return { ...out, dir };
    } finally {
      if (saved.plan === undefined) delete process.env.FAKE_PLAN; else process.env.FAKE_PLAN = saved.plan;
      if (saved.key === undefined) delete process.env.ZZ_FAKE_API_KEY; else process.env.ZZ_FAKE_API_KEY = saved.key;
    }
  }
  const pass = (metrics: Record<string, number>, na: unknown[] = []) => ({ exit: 0, receipt: { verdict: 'pass', not_applicable: na, data: { metrics }, ...ran } });

  test('a reused work directory never lends an old receipt to a runner that exits before writing one', async () => {
    const { receipt } = await stage({ pglite: { exit: 1 } }, ['pglite'], work => {
      mkdirSync(join(work, 'fake-pglite'), { recursive: true });
      writeFileSync(join(work, 'fake-pglite', 'receipt.json'), JSON.stringify(pass({ leaks: 0, sealed: 0 }).receipt));
    });
    expect(receipt.checks[0]!.engines.pglite!.status).toBe('error');
    expect(receipt.summary.errored).toEqual(['fake:pglite']);
  });

  test('rust refusal, not_applicable carry-through and the stage receipt', async () => {
    const refusal = evalEngineRefusalMessage(new EvalEngineUnavailable('rust', 'rust_engine_not_in_build', 'not in this build.'), 'fake');
    const { receipt, file, dir } = await stage({ pglite: pass({ leaks: 0, sealed: 0 }), postgres: pass({ leaks: 0, sealed: 0 }), rust: { refusal } }, ['pglite', 'postgres', 'rust']);
    expect(JSON.parse(readFileSync(file!, 'utf8'))).toEqual(JSON.parse(JSON.stringify(receipt).replaceAll(`${tmpdir()}/`, '<tmp>/')));
    const row = receipt.checks[0]!;
    expect(row.engines.pglite!.status).toBe('pass');
    expect(row.engines.rust).toMatchObject({ status: 'refused', exit_code: 69, refusal_reason: 'rust_engine_not_in_build' });
    expect(receipt.summary.rust).toBe('refused');
    expect(receipt.summary.errored).toEqual([]);
    expect(receipt.findings).toEqual([]);
    expect(Object.keys(receipt.summary.wall_ms.fake!).sort()).toEqual(['pglite', 'postgres', 'rust']);
    expect(receipt.gbrain).toMatchObject({ version: '0.0.0-fake', spec: '/fake/gbrain@v0.0.0-fake', rust_engine_in_build: false });
    expect(receipt.keyless.child_env_stripped).toContain('ZZ_FAKE_API_KEY');
    const seen = JSON.parse(readFileSync(join(dir, 'work', 'fake-rust', 'seen.json'), 'utf8'));
    expect(seen).toEqual({ argv: ['--gbrain', '/fake/gbrain@v0.0.0-fake', '--output', join(dir, 'work', 'fake-rust')], pg: 'postgres://u@127.0.0.1:1/postgres', n14: 'postgres://u@127.0.0.1:1/postgres', key: false });
  });

  test('a runner whose receipt names no loaded gbrain commit is an error', async () => {
    const { receipt } = await stage({ pglite: pass({ leaks: 0, sealed: 0 }), postgres: { exit: 0, receipt: { verdict: 'pass', data: { metrics: { leaks: 0, sealed: 0 } } } } }, ['pglite', 'postgres']);
    expect(receipt.checks[0]!.engines.postgres).toMatchObject({ status: 'error', gbrain_commit: null, error: 'ran gbrain unknown, expected c0ffee' });
  });

  test('a runner that loaded a different gbrain commit than the stage is an error, and each run records the commit it loaded', async () => {
    const other = pass({ leaks: 0, sealed: 0 });
    const { receipt } = await stage({ pglite: pass({ leaks: 0, sealed: 0 }), postgres: { ...other, receipt: { ...other.receipt, execution: { product: { loaded_git_head: 'deadbeef' } } } } }, ['pglite', 'postgres']);
    const row = receipt.checks[0]!;
    expect(row.engines.pglite!.status).toBe('pass');
    expect(row.engines.postgres).toMatchObject({ status: 'error', gbrain_commit: 'deadbeef' });
    expect(row.engines.postgres!.error).toMatch(/^ran gbrain deadbeef, expected /);
    expect(receipt.summary.errored).toEqual(['fake:postgres']);
  });

  test('a rust run with a not_applicable contract passes on the rest; a harness error is reported as errored', async () => {
    const { receipt } = await stage({ pglite: pass({ leaks: 0, sealed: 0 }), postgres: { exit: 3 }, rust: pass({ leaks: 0 }, [SEALED_NA]) }, ['pglite', 'postgres', 'rust']);
    const row = receipt.checks[0]!;
    expect(row.engines.postgres!.status).toBe('error');
    expect(row.engines.postgres!.error).toMatch(/exit 3, no receipt/);
    expect(row.engines.rust!.contracts.sealed!.not_applicable!.reason).toMatch(/raw SQL/);
    expect(row.rust!.verdict).toBe('pass');
    expect(receipt.summary.errored).toEqual(['fake:postgres']);
  });

  test('without rust the stage compares PGLite and Postgres and reports the difference', async () => {
    const { receipt } = await stage({ pglite: pass({ leaks: 0, sealed: 0 }), postgres: { exit: 1, receipt: { verdict: 'fail', data: { metrics: { leaks: 3, sealed: 0 } }, ...ran } } }, ['pglite', 'postgres']);
    expect(receipt.summary.rust).toBeNull();
    expect(receipt.findings.map(f => `${f.kind}:${f.contract ?? ''}`).sort()).toEqual(['typescript_contract_failure:leaks', 'typescript_engines_differ:leaks', 'typescript_verdict_fail:']);
  });
});
