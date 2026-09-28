/**
 * Hermetic tests for eval/runner/longmemeval-batch.sh
 * (audit finding longmemeval-10).
 *
 * The old wrapper had no --dataset case (a user's `--dataset oracle` fell
 * into EXTRA_ARGS AFTER the wrapper's own `--dataset s`, and the runner's
 * first-occurrence arg() silently discarded it) and hardcoded
 * EXPECTED_QUESTIONS=500, so --limit/--stratify runs could never hit the
 * completion check and burned all 50 batches on no-op workers.
 *
 * These tests run the REAL wrapper with LME_RUNNER/LME_AGGREGATOR pointed at
 * recording stubs and a tiny temp dataset, proving:
 *   - --dataset reaches the worker exactly once (no duplicate flag);
 *   - the completion target derives from the dataset (with --limit and
 *     --stratify applied);
 *   - a zero-progress batch aborts non-zero instead of looping;
 *   - a missing dataset fails loudly;
 *   - completion counts only planned (adapter, question, run_config_hash)
 *     rows with exact equality, a stale or foreign NDJSON is refused, and the
 *     aggregator gets --expect-rows (PD-03).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = join(import.meta.dir, '../..');
const SCRIPT = join(REPO, 'eval/runner/longmemeval-batch.sh');

let sandbox: string;
let datasetPath: string;
let stubRunner: string;
let stubAggregator: string;
let recordDir: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'lme-batch-test-'));
  recordDir = join(sandbox, 'record');
  mkdirSync(recordDir, { recursive: true });

  // 4 questions across 2 types — small enough to assert exact totals.
  datasetPath = join(sandbox, 'longmemeval_tiny.json');
  writeFileSync(datasetPath, JSON.stringify([
    { question_id: 'q1', question_type: 'single-session-user' },
    { question_id: 'q2', question_type: 'single-session-user' },
    { question_id: 'q3', question_type: 'multi-session' },
    { question_id: 'q4', question_type: 'multi-session' },
  ]));

  // Stub runner: records argv. With --print-plan it prints the plan the real
  // runner prints (hash per adapter = "hash-<adapter>" unless STUB_HASH is
  // set); otherwise it appends one completed NDJSON row per
  // (adapter × question) pair, honoring --limit the way the real runner does.
  stubRunner = join(sandbox, 'stub-runner.ts');
  writeFileSync(stubRunner, `
    import { readFileSync, appendFileSync } from 'fs';
    const args = process.argv.slice(2);
    const arg = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
    appendFileSync(${JSON.stringify(join(recordDir, 'runner.argv'))}, args.join(' ') + '\\n');
    const qs = JSON.parse(readFileSync(arg('--path')!, 'utf8'));
    const limit = arg('--limit') ? Number(arg('--limit')) : qs.length;
    const adapters = (arg('--adapters') ?? 'keyword').split(',');
    const hash = (a: string) => process.env.STUB_HASH ?? 'hash-' + a;
    if (args.includes('--print-plan')) {
      console.log('gbrain chatter on stdout before the plan');
      console.log(JSON.stringify({ run_config_hashes: Object.fromEntries(adapters.map(a => [a, hash(a)])),
        question_ids: qs.slice(0, limit).map((q: { question_id: string }) => q.question_id), adapters_skipped: [] }));
      process.exit(0);
    }
    if (process.env.STUB_NO_PROGRESS === '1') process.exit(0);
    for (const a of adapters) {
      for (const q of qs.slice(0, limit)) {
        appendFileSync(arg('--ndjson')!, JSON.stringify({ adapter: a, question_id: q.question_id, run_config_hash: hash(a) }) + '\\n');
      }
    }
  `);

  stubAggregator = join(sandbox, 'stub-aggregator.ts');
  writeFileSync(stubAggregator, `
    import { appendFileSync } from 'fs';
    appendFileSync(${JSON.stringify(join(recordDir, 'aggregator.argv'))}, process.argv.slice(2).join(' ') + '\\n');
  `);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runBatch(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      LME_RUNNER: stubRunner,
      LME_AGGREGATOR: stubAggregator,
      ...extraEnv,
    },
  });
}

describe('longmemeval-batch.sh (longmemeval-10)', () => {
  test('--dataset is honored (reaches the worker exactly once) and the target derives from the dataset', () => {
    rmSync(join(recordDir, 'runner.argv'), { force: true });
    rmSync(join(recordDir, 'aggregator.argv'), { force: true });
    const ndjson = join(sandbox, 'run1.ndjson');
    const res = runBatch([
      '--dataset', 'oracle',
      '--path', datasetPath,
      '--adapters', 'keyword',
      '--workers', '1',
      '--budget', '5',
      '--ndjson', ndjson,
    ]);
    expect(res.status).toBe(0);
    // Completion target = 4 questions × 1 adapter, derived from the file.
    expect(res.stdout).toContain('expected=4 questions × 1 adapters = 4 pairs');
    const invocations = readFileSync(join(recordDir, 'runner.argv'), 'utf8').trim().split('\n');
    expect(invocations[0]).toContain('--print-plan');
    const argv = invocations[1];
    // The user's dataset choice reaches the worker...
    expect(argv).toContain('--dataset oracle');
    // ...exactly once — no wrapper-default duplicate ahead of it for the
    // runner's first-occurrence arg() to pick instead.
    expect(argv.split('--dataset').length - 1).toBe(1);
    expect(argv).not.toContain('--dataset s');
    // Completion detected → aggregator ran on the ndjson with the exact row count.
    expect(readFileSync(join(recordDir, 'aggregator.argv'), 'utf8')).toContain('run1.ndjson --expect-rows 4');
  }, 120_000);

  test('--limit shrinks the completion target instead of stranding it at the full count', () => {
    const ndjson = join(sandbox, 'run-limit.ndjson');
    const res = runBatch([
      '--path', datasetPath,
      '--adapters', 'keyword',
      '--workers', '1',
      '--budget', '5',
      '--limit', '2',
      '--ndjson', ndjson,
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('expected=2 questions × 1 adapters = 2 pairs');
  }, 120_000);

  test('--stratify derives min(perType, bucket) per question_type', () => {
    const ndjson = join(sandbox, 'run-strat.ndjson');
    const res = runBatch([
      '--path', datasetPath,
      '--adapters', 'keyword',
      '--workers', '1',
      '--budget', '5',
      '--stratify', '1',
      '--limit', '2', // stub honors --limit; 1/type × 2 types = 2 = limit
      '--ndjson', ndjson,
    ]);
    expect(res.status).toBe(0);
    // 2 types × min(1, bucket) = 2 questions.
    expect(res.stdout).toContain('expected=2 questions × 1 adapters = 2 pairs');
  }, 120_000);

  test('a batch that makes zero progress aborts non-zero and never aggregates', () => {
    rmSync(join(recordDir, 'aggregator.argv'), { force: true });
    const ndjson = join(sandbox, 'run-stall.ndjson');
    const res = runBatch(
      ['--path', datasetPath, '--adapters', 'keyword', '--workers', '1', '--budget', '5', '--ndjson', ndjson],
      { STUB_NO_PROGRESS: '1' },
    );
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toContain('zero progress');
    expect(existsSync(join(recordDir, 'aggregator.argv'))).toBe(false);
  }, 120_000);

  test('rows from another adapter never satisfy the requested adapter (PD-03)', () => {
    rmSync(join(recordDir, 'aggregator.argv'), { force: true });
    const ndjson = join(sandbox, 'run-other-adapter.ndjson');
    writeFileSync(ndjson, ['q1', 'q2', 'q3', 'q4'].map(q => JSON.stringify({ adapter: 'hybrid', question_id: q, run_config_hash: 'hash-hybrid' })).join('\n') + '\n');
    const res = runBatch(['--path', datasetPath, '--adapters', 'hybrid+rerank', '--workers', '1', '--budget', '5', '--ndjson', ndjson]);
    expect(res.status).not.toBe(0);
    expect(res.stdout).not.toContain('already complete');
    expect(res.stderr).toContain('4 row(s) outside this run');
    expect(existsSync(join(recordDir, 'aggregator.argv'))).toBe(false);
  }, 120_000);

  test('a complete stream from an earlier configuration is refused, not re-published (PD-03)', () => {
    rmSync(join(recordDir, 'aggregator.argv'), { force: true });
    const ndjson = join(sandbox, 'run-stale.ndjson');
    expect(runBatch(['--path', datasetPath, '--adapters', 'keyword', '--workers', '1', '--budget', '5', '--ndjson', ndjson], { STUB_HASH: 'old-config' }).status).toBe(0);
    rmSync(join(recordDir, 'aggregator.argv'), { force: true });
    const stale = runBatch(['--path', datasetPath, '--adapters', 'keyword', '--workers', '1', '--budget', '5', '--ndjson', ndjson], { STUB_HASH: 'new-config' });
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain('outside this run');
    expect(existsSync(join(recordDir, 'aggregator.argv'))).toBe(false);
    const again = runBatch(['--path', datasetPath, '--adapters', 'keyword', '--workers', '1', '--budget', '5', '--ndjson', ndjson], { STUB_HASH: 'old-config' });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('All 4 pairs already complete.');
  }, 120_000);

  test('--expected-questions must agree with the runner plan', () => {
    const res = runBatch(['--path', datasetPath, '--adapters', 'keyword', '--workers', '1', '--expected-questions', '5', '--ndjson', join(sandbox, 'run-expect.ndjson')]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('runner plans 4 questions');
  }, 120_000);

  test('missing dataset fails loudly with the download hint', () => {
    const res = runBatch(['--dataset', 'nonexistent-split']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('dataset not found');
    expect(res.stderr).toContain('longmemeval_nonexistent-split.json');
  }, 120_000);
});
