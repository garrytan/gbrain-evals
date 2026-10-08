/**
 * The scoreboard front door (eval/runner/scoreboard-cli.ts): the $0 fixture
 * end to end, delegation to the generator and judge-repeat tools (and the
 * operator message when one is missing), doctor (keys by presence only,
 * unpriced models refused before any lease, the executor resolved explicitly),
 * plan (cells, waves, blocks, commands), run's custody and local refusals,
 * dry run, and a launcher that exits non-zero on a failed cell and 4 on a cap.
 * Keyless: no provider, Docker or VM is contacted.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { doctor, plan, priceProbe, runCells } from '../../eval/runner/scoreboard-cli.ts';
import { answerId } from '../../eval/runner/scoreboard.ts';
import { exitCodeOf, ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import type { LaunchContext } from '../../eval/runner/shootout-cell.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'scoreboard-cli-'));
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); });
const MISSING = join(tmp, 'not-landed.ts');
const cli = (args: string[], env: Record<string, string | undefined> = {}) => {
  const p = Bun.spawnSync([process.execPath, 'eval/runner/scoreboard-cli.ts', ...args], { cwd: ROOT, env: { ...process.env, ...env } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const op = (s: string) => JSON.parse(s.slice(s.indexOf('{')));
let n = 0;
const rejected = async (p: Promise<unknown>): Promise<ScoreboardError> => { try { await p; } catch (e) { if (e instanceof ScoreboardError) return e; throw e; } throw new Error('expected a ScoreboardError'); };

function campaign(cells: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  const dir = join(tmp, `c${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'm.json'), JSON.stringify({ kind: 'q1-scoreboard-campaign', schema_version: 1, campaign_id: 'q1-scoreboard', cap_usd: 10, ledger: join(dir, 'l.sqlite'), executes: ['bun.lock'],
    blocks: { T1: { estimate_usd: 6, cap_usd: 9 } }, models: ['anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol'], cells, ...over }));
  return { manifest: join(dir, 'm.json'), state: join(dir, 'state'), dir };
}
const cell = (id: string, over: Record<string, unknown> = {}) => ({ id, system: 'ext-markdown-kb', benchmark: 'locomo', config: 'recipe', lease_usd: 2, command: 'true', block: 'T1', vm: { size: 'standard-4' }, ...over });

describe('fixture', () => {
  test('runs the fake system end to end through shim, proxy, packer, reader stub, judge stub, cost-speed and generator in well under 5 minutes, keyless', () => {
    const out = join(tmp, 'fixture-out');
    const r = cli(['fixture', '--json', '--stub', 'generator,judge-repeat', '--out', out], { OPENAI_API_KEY: 'sk-planted-must-not-leave-1234567890', SCOREBOARD_GENERATOR: MISSING, SCOREBOARD_JUDGE_REPEAT: MISSING });
    expect(r.code, r.err).toBe(0);
    const res = JSON.parse(r.out);
    expect(res).toMatchObject({ ok: true, rows: 8, stubbed: ['generator', 'judge-repeat'], proxy: { refused: 0, unauthorized: 0, reserved_unsettled_usd: 0 } });
    expect(res.seconds).toBeLessThan(300);
    expect(res.proxy.forwarded).toBeGreaterThan(0);
    expect(res.stages.map((s: { stage: string }) => s.stage)).toEqual(expect.arrayContaining([expect.stringContaining('shim'), expect.stringContaining('metering proxy'), expect.stringContaining('packer'), 'cost and speed']));
    const usage = readFileSync(join(out, 'usage.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(usage.every(u => typeof u.request_id === 'string' && u.output_cap <= 2048 && u.route_class === 'reader')).toBe(true);
    const answers = readFileSync(join(out, 'answers.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(answers).toHaveLength(8);
    expect(answers[0].answer_id).toBe(answerId('fixture-cell', answers[0].question_id, answers[0].reader, 0));
    expect(Object.keys(answers[0]).sort()).toEqual(['answer_id', 'arm', 'cell_id', 'context_sha256', 'conversation', 'latency_ms', 'outcome', 'provider_input_tokens', 'question_id', 'reader', 'realization_id', 'replicate', 'system', 'text', 'usage']);
    expect(readFileSync(join(out, 'scoreboard.md'), 'utf8')).toContain('| fake |');
    expect(JSON.parse(readFileSync(join(out, 'cost-speed.json'), 'utf8')).questions).toBe(8);
    const provider = readFileSync(join(out, 'fake-provider.jsonl'), 'utf8');
    expect(provider).not.toContain('sk-planted');
    for (const f of ['usage.ndjson', 'answers.ndjson', 'cost-speed.json', 'harness.log']) expect(readFileSync(join(out, f), 'utf8')).not.toContain('sk-planted');
  }, 300_000);

  test('with the generator in the checkout, the fixture renders and checks the synthetic receipt through eval/runner/scoreboard.ts', () => {
    const out = join(tmp, 'fixture-generator');
    const r = cli(['fixture', '--json', '--stub', 'judge-repeat', '--out', out], { SCOREBOARD_JUDGE_REPEAT: MISSING });
    expect(r.code, r.err).toBe(0);
    const res = JSON.parse(r.out);
    expect(res.stubbed).toEqual(['judge-repeat']);
    expect(res.stages.map((s: { stage: string }) => s.stage)).toContain('generator (eval/runner/scoreboard.ts render and check on the synthetic receipt)');
    expect(readFileSync(join(out, 'receipt', 'scoreboard.md'), 'utf8').length).toBeGreaterThan(0);
    expect(existsSync(join(out, 'receipt', 'scoreboard.json'))).toBe(true);
  }, 300_000);

  test('a part another lane owns that is not in the checkout is an operator message naming the --stub to add, never a silent skip', () => {
    const r = cli(['fixture', '--json'], { SCOREBOARD_GENERATOR: MISSING, SCOREBOARD_JUDGE_REPEAT: MISSING });
    expect(r.code).toBe(2);
    expect(op(r.err)).toMatchObject({ code: 'NOT_YET_AVAILABLE', fix: { next: 'run', argv: ['bun', 'run', 'eval:scoreboard', 'fixture', '--stub', 'generator,judge-repeat'] } });
    expect(op(cli(['fixture', '--json', '--stub', 'packer']).err).code).toBe('USAGE');
  });
});

describe('delegation', () => {
  test('check, explain and render call `bun eval/runner/scoreboard.ts <sub>`; judge calls judge-repeat; exit codes pass through', () => {
    const stub = join(tmp, 'generator-stub.ts');
    writeFileSync(stub, "console.log(JSON.stringify(process.argv.slice(2))); process.exit(process.argv.includes('--partial') ? 4 : 0);\n");
    const env = { SCOREBOARD_GENERATOR: stub, SCOREBOARD_JUDGE_REPEAT: stub };
    expect(cli(['check', '--receipts', 'x'], env)).toMatchObject({ code: 0, out: '["check","--receipts","x"]\n' });
    expect(cli(['explain', 'gbrain-defaults', 'beam-10m-8k'], env).out).toBe('["explain","gbrain-defaults","beam-10m-8k"]\n');
    expect(cli(['render', '--partial'], env).code).toBe(4);
    expect(cli(['judge', '--answers', 'a.ndjson'], env).out).toBe('["--answers","a.ndjson"]\n');
    expect(op(cli(['explain', 'only-row', '--json'], env).err).code).toBe('USAGE');
  });

  test('a missing generator is NOT_YET_AVAILABLE (exit 2), not a pass', () => {
    for (const sub of ['check', 'render']) {
      const r = cli([sub, '--json'], { SCOREBOARD_GENERATOR: MISSING });
      expect(r.code).toBe(2);
      expect(op(r.err)).toMatchObject({ code: 'NOT_YET_AVAILABLE', fix: { verify: ['ls', MISSING] } });
    }
  });

  test('render checks the campaign freeze first', () => {
    const c = campaign([cell('a')], { executes: ['bun.lock'] });
    const dir = join(tmp, 'freeze-exec');
    mkdirSync(join(ROOT, 'test/eval/fixtures/scoreboard'), { recursive: true });
    const exec = join(ROOT, 'test/eval/fixtures/scoreboard', `render-${process.pid}.ts`);
    writeFileSync(exec, 'export const a = 1;\n');
    try {
      const m = JSON.parse(readFileSync(c.manifest, 'utf8'));
      m.executes = [exec.slice(ROOT.length + 1)];
      writeFileSync(c.manifest, JSON.stringify(m));
      expect(cli(['run', '--campaign', c.manifest, '--state', c.state, '--cell', 'a', '--dry-run', '--json']).code).toBe(0);
      Bun.spawnSync([process.execPath, 'eval/runner/shootout-cell.ts', 'init', '--campaign', c.manifest, '--state', c.state], { cwd: ROOT });
      writeFileSync(exec, 'export const a = 2;\n');
      const r = cli(['render', '--campaign', c.manifest, '--state', c.state, '--json'], { SCOREBOARD_GENERATOR: MISSING });
      expect(r.code).toBe(3);
      expect(op(r.err).code).toBe('CAMPAIGN_HASH_MISMATCH');
    } finally { rmSync(exec, { force: true }); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('doctor', () => {
  test('reports which keys are present, never their values', () => {
    const planted = 'sk-planted-value-0123456789abcdef';
    const r = cli(['doctor', '--json'], { OPENAI_API_KEY: planted, ANTHROPIC_API_KEY: '', VOYAGE_API_KEY: planted });
    expect(r.out + r.err).not.toContain(planted);
    const res = JSON.parse(r.out);
    expect(res.checks.find((c: { id: string }) => c.id === 'keys').detail).toMatch(/^present: OPENAI_API_KEY, VOYAGE_API_KEY/);
    expect(res.checks.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(['bun', 'python3', 'docker', 'architecture', 'disk', 'keys']));
  });

  test('an unpriced resolved model refuses before any lease, exit 2, telling the agent to look up the rate and register it', () => {
    const c = campaign([cell('a')], { models: ['anthropic:claude-sonnet-5-5', 'anthropic:claude-opus-4-7', 'voyage:voyage-4', 'voyage:rerank-2.5', 'openai:gpt-9-unreleased'] });
    const r = cli(['run', '--campaign', c.manifest, '--state', c.state, '--cell', 'a', '--json'], { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', VOYAGE_API_KEY: 'x', UBICLOUD_API_TOKEN: 'x', UBI_OWNER: 'gbra49' });
    expect(r.code).toBe(2);
    const m = op(r.err);
    expect(m.code).toBe('MODEL_UNPRICED');
    expect(m.message).toContain('price:openai:gpt-9-unreleased');
    expect(m.message).toContain('CHAT_PRICE_OVERRIDES');
    expect(m.fix.user_message).toContain('register it in CHAT_PRICE_OVERRIDES');
    expect(m.message).not.toContain('price:anthropic:claude-opus-4-7');
    expect(existsSync(c.state) && existsSync(join(c.state, 'leases.ndjson'))).toBe(false);
    expect(existsSync(join(c.dir, 'l.sqlite'))).toBe(false);
  });

  test('a run resolves the executor explicitly, needs an owner tag and a Ubicloud token, and never accepts a shared drive runner', async () => {
    const drive = join(tmp, '.capy/drive/x/ubi-runner.sh');
    mkdirSync(join(tmp, '.capy/drive/x'), { recursive: true });
    writeFileSync(drive, '');
    const r = await doctor(['--for', 'run'], { UBI_RUNNER: drive, OPENAI_API_KEY: 'x' });
    const by = Object.fromEntries(r.checks.map(c => [c.id, c]));
    expect(r.ok).toBe(false);
    expect(by.executor).toMatchObject({ ok: false, code: 'RUNNER_UNRESOLVED' });
    expect(by['ubi-owner']).toMatchObject({ ok: false, code: 'OWNER_UNSET' });
    expect(by['ubicloud-token']).toMatchObject({ ok: false });
    const ok = await doctor(['--for', 'run'], { OPENAI_API_KEY: 'x', UBI_OWNER: 'gbra49', UBICLOUD_API_TOKEN: 'x' });
    expect(Object.fromEntries(ok.checks.map(c => [c.id, c])).executor).toMatchObject({ ok: true, detail: expect.stringContaining('scripts/ubicloud/ubi-runner.sh') });
    expect(priceProbe('voyage:rerank-2.5').url).toContain('/rerank');
  });

  test('dataset checks cover only the named cells, and a dev smoke only its own conversations\' files', async () => {
    const empty = join(tmp, 'no-datasets');
    mkdirSync(empty, { recursive: true });
    const c = campaign([cell('smoke', { benchmark: 'beam-1m', conversations: ['1m-16'], smoke: true }), cell('sealed', { benchmark: 'beam-100k', sealed: true })]);
    const p = Bun.spawnSync([process.execPath, 'eval/runner/scoreboard-cli.ts', 'doctor', '--campaign', c.manifest, '--cell', 'smoke', '--for', 'local', '--json'], { cwd: ROOT, env: { ...process.env, GBRAIN_EVALS_DATASETS: empty } });
    const checks = JSON.parse(p.stdout.toString()).checks as Array<{ id: string; detail: string; fix?: { argv?: string[] } }>;
    expect(checks.map(x => x.id).filter(id => id.startsWith('dataset:'))).toEqual(['dataset:beam-1m']);
    const beam = checks.find(x => x.id === 'dataset:beam-1m')!;
    expect(beam.detail).toContain('2 of 2 files');
    expect(beam.fix?.argv).toEqual(['bun', 'run', 'eval:decide', 'fetch', '--benchmark', 'beam-1m', '--conversations', '1m-16']);
  });

  test('sealed preflight needs the custodian host', async () => {
    const r = await doctor(['--for', 'sealed'], { GBRAIN_EVALS_CUSTODY_LOG: '/nope/custody.log' });
    expect(r.checks.find(c => c.id === 'custody')).toMatchObject({ ok: false, code: 'CUSTODY_REQUIRED' });
  });
});

describe('plan', () => {
  test('prints the cell manifest, waves with vCPU, blocks against their caps and the exact commands', () => {
    const cells = Array.from({ length: 5 }, (_, i) => cell(`c${i}`, { vm: { size: 'standard-16' }, expected_hours: 10 + i, ...(i === 0 ? { smoke: true } : {}) }));
    const c = campaign(cells, { schedule: { vcpu_cap_day: 32 } });
    const p = plan(c.manifest, c.state);
    expect(p.schedule.waves.map(w => [w.wave, w.cells, w.vcpu])).toEqual([[1, 2, 32], [2, 2, 32], [3, 1, 16]]);
    expect(p.blocks).toEqual([{ block: 'T1', estimate_usd: 6, cap_usd: 9, leases_usd: 10 }]);
    expect(p).toMatchObject({ leases_usd: 10, cap_usd: 10, over_cap: false });
    expect(p.cells[0]).toMatchObject({ id: 'c0', vcpu: 16, wave: 1, command: `bun run eval:scoreboard run --campaign ${c.manifest} --state ${c.state} --cell c0` });
    expect(p.commands).toContain(`bun run eval:scoreboard smoke --campaign ${c.manifest} --state ${c.state} --cell c0`);
    expect(p.commands).toContain(`bun run eval:scoreboard run --campaign ${c.manifest} --state ${c.state} --wave 3`);
    const r = cli(['plan', '--campaign', c.manifest]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('| 1 | 2 | 32 | 11 |');
  });
});

describe('run', () => {
  const saved: Record<string, string | undefined> = {};
  const set = { OPENAI_API_KEY: 'placeholder', ANTHROPIC_API_KEY: 'placeholder', UBICLOUD_API_TOKEN: 'placeholder', UBI_OWNER: 'gbra49test' } as Record<string, string>;
  beforeEach(() => { closeLedgers(); for (const k of Object.keys(set)) { saved[k] = process.env[k]; process.env[k] = set[k]; } });
  afterEach(() => { for (const k of Object.keys(set)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('sealed cells: --local is refused, and a sealed launch needs --sealed on the custodian host', () => {
    const c = campaign([cell('s1', { benchmark: 'beam-10m', sealed: true })]);
    const local = cli(['run', '--campaign', c.manifest, '--state', c.state, '--cell', 's1', '--local', '--json']);
    expect([local.code, op(local.err).code]).toEqual([3, 'SEALED_CELL_LOCAL']);
    const implicit = cli(['run', '--campaign', c.manifest, '--state', c.state, '--cell', 's1', '--json']);
    expect([implicit.code, op(implicit.err).code]).toEqual([3, 'CUSTODY_REQUIRED']);
    const here = cli(['run', '--campaign', c.manifest, '--state', c.state, '--cell', 's1', '--sealed', '--json'], { ...set, GBRAIN_EVALS_CUSTODY_LOG: '' });
    expect([here.code, op(here.err).code]).toEqual([3, 'CUSTODY_REQUIRED']);
    expect(existsSync(join(c.state, 'leases.ndjson'))).toBe(false);
  });

  test('--dry-run shows the launcher host, where rows land and how the VM is torn down, and reserves nothing', () => {
    const c = campaign([cell('a', { timeout_hours: 6 })]);
    const r = cli(['run', '--campaign', c.manifest, '--state', c.state, '--cell', 'a', '--dry-run', '--json'], set);
    expect(r.code, r.err).toBe(0);
    const res = JSON.parse(r.out);
    expect(res).toMatchObject({ dry_run: true, executor: expect.stringContaining('scripts/ubicloud/ubi-runner.sh'), cells: [{ cell: 'a', checkpoints_every_rows: 20, timeout_hours: 6, teardown: expect.stringContaining('destroys the VM') }] });
    expect(res.launcher_host).toBeTruthy();
    expect(existsSync(join(c.state, 'leases.ndjson'))).toBe(false);
  });

  const vm = (exit: number, usd = 0.5) => async (_argv: string[], ctx: LaunchContext) => {
    mkdirSync(ctx.resultsDir, { recursive: true });
    const lease = BudgetRun.openLease({ runId: ctx.lease.lease_id, leaseUsd: ctx.lease.usd, ledgerPath: join(ctx.resultsDir, 'lease.sqlite') });
    lease.settle(lease.reserve(usd, 'vm'), { usd });
    closeLedgers();
    writeFileSync(join(ctx.resultsDir, 'lease-summary.json'), JSON.stringify({ run_id: ctx.lease.lease_id, lease_usd: ctx.lease.usd, committed_usd: usd, requests: 1, cell_exit_code: exit }));
    return exit;
  };

  test('a failed child cell makes the launcher fail (exit 2) after the other cells ran', async () => {
    const c = campaign([cell('a'), cell('b')]);
    let calls = 0;
    const e = await rejected(runCells(['--campaign', c.manifest, '--state', c.state, '--cells', 'a,b'], { runner: async (argv, ctx) => vm(++calls === 1 ? 7 : 0)(argv, ctx) }));
    expect(e).toBeInstanceOf(ScoreboardError);
    expect([e.op.code, exitCodeOf(e.op)]).toEqual(['CELL_FAILED', 2]);
    expect(e.op.message).toContain('a (settled, exit 7)');
    expect((e.op.state as { results: Array<{ cell: string; ok: boolean }> }).results.map(r => [r.cell, r.ok])).toEqual([['a', false], ['b', true]]);
  });

  test('cap exhaustion is a partial result (exit 4) that states the charged reservation', async () => {
    const c = campaign([cell('a', { lease_usd: 4 }), cell('b', { lease_usd: 4 }), cell('c', { lease_usd: 4 })], { blocks: undefined, cap_usd: 8 });
    const lost = async () => 1;
    const e = await rejected(runCells(['--campaign', c.manifest, '--state', c.state, '--cells', 'a,b,c'], { runner: async (argv, ctx) => ctx.cell.id === 'a' ? lost() : vm(0, 1)(argv, ctx) }));
    expect([e.op.code, e.op.partial, exitCodeOf(e.op)]).toEqual(['BUDGET_CAP', true, 4]);
    expect(e.op.message).toContain('2 of 3 cell(s) ran');
    expect(e.op.state).toMatchObject({ charged_reservations_usd: 4 });
  });

  test('smoke runs only smoke cells, through the runner UBI_RUNNER names; a VM run that brings back no ledger is a failure, not a success', async () => {
    const runner = join(tmp, 'ok-runner.sh');
    writeFileSync(runner, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(runner, 0o755);
    const c = campaign([cell('a', { smoke: true }), cell('b')]);
    const notSmoke = await rejected(runCells(['--campaign', c.manifest, '--state', c.state, '--cell', 'b'], { smoke: true }));
    expect(notSmoke.op.code).toBe('USAGE');
    const r = cli(['smoke', '--campaign', c.manifest, '--state', c.state, '--json'], { ...set, UBI_RUNNER: runner });
    expect(r.code).toBe(2);
    expect(op(r.err)).toMatchObject({ code: 'CELL_FAILED', state: { results: [{ cell: 'a', status: 'finished', exit_code: 0 }] } });
  });

  test('status and dispute', () => {
    const c = campaign([cell('a')]);
    expect(op(cli(['status', '--campaign', c.manifest, '--state', c.state, '--json']).err).code).toBe('CAMPAIGN_STATE_MISSING');
    Bun.spawnSync([process.execPath, 'eval/runner/shootout-cell.ts', 'init', '--campaign', c.manifest, '--state', c.state], { cwd: ROOT });
    const s = cli(['status', '--campaign', c.manifest, '--state', c.state, '--json']);
    expect(JSON.parse(s.out)).toMatchObject({ campaign_id: 'q1-scoreboard', kind: 'q1-scoreboard-campaign', frozen: true });
    const d = JSON.parse(cli(['dispute', '--json']).out);
    expect(d).toMatchObject({ template: '.github/ISSUE_TEMPLATE/scoreboard-dispute.md', response_target_days: 7 });
    expect(existsSync(join(ROOT, d.template))).toBe(true);
    expect(op(cli(['nope', '--json']).err).code).toBe('USAGE');
  });
});
