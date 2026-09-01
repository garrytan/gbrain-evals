/**
 * longmemeval-validate-ndjson.ts tests — fixture-driven, keyless, $0.
 *
 * The validator is the integrity gate the erratum-resolution report cites:
 * exit 0 all-pass / exit 1 any-mismatch / exit 2 file-missing-or-unreadable,
 * no partial-success wording. These tests shell out to the real CLI over
 * tiny synthetic NDJSON + a mini dataset so the exit-code contract itself
 * is under test, not just the library functions.
 *
 * Covered: pass (with dataset gt validation + sha256 print), resume-duplicate
 * dedup preferring the non-error row, row-count mismatch, question-coverage
 * mismatch at equal counts, gt mismatch, wrong abstention count, adapter-set
 * mismatch, malformed line, missing NDJSON (exit 2), missing dataset (exit 2),
 * expected-dataset-sha mismatch.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

const VALIDATOR = join(import.meta.dir, '../../eval/runner/longmemeval-validate-ndjson.ts');

let dir: string;

interface RowOverrides {
  adapter: string;
  question_id: string;
  ground_truth?: string[];
  error?: string;
  retrieved?: string[];
}

function row(o: RowOverrides): string {
  return JSON.stringify({
    adapter: o.adapter,
    question_id: o.question_id,
    question_type: 'single-session-user',
    retrieved: o.retrieved ?? ['answer_s1'],
    ground_truth: o.ground_truth ?? ['answer_s1'],
    hit_at_k: true,
    num_haystack: 3,
    latency_ms: 10,
    ...(o.error !== undefined ? { error: o.error } : {}),
  });
}

/** 2 adapters x 3 questions (one _abs) — the smallest full-coverage stream. */
function goodLines(): string[] {
  const lines: string[] = [];
  for (const adapter of ['a', 'b']) {
    lines.push(row({ adapter, question_id: 'q1', ground_truth: ['answer_s1'] }));
    lines.push(row({ adapter, question_id: 'q2', ground_truth: ['answer_s2', 'answer_s3'] }));
    lines.push(row({ adapter, question_id: 'q9_abs', ground_truth: [] }));
  }
  return lines;
}

const DATASET = [
  { question_id: 'q1', question_type: 'single-session-user', answer_session_ids: ['answer_s1'] },
  // Dataset order differs from the row order — gt equality is set-based.
  { question_id: 'q2', question_type: 'multi-session', answer_session_ids: ['answer_s3', 'answer_s2'] },
  { question_id: 'q9_abs', question_type: 'single-session-user', answer_session_ids: [] },
];

const BASE_ARGS = ['--expected-rows', '3', '--expected-abs', '1', '--adapters', 'a,b'];

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bun', VALIDATOR, ...args], { cwd: dir });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function writeFixture(name: string, lines: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lme-validate-'));
  writeFileSync(join(dir, 'dataset.json'), JSON.stringify(DATASET));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('longmemeval-validate-ndjson CLI', () => {
  test('clean stream + matching dataset → exit 0, gt reported N/N, sha printed', () => {
    const p = writeFixture('pass.ndjson', goodLines());
    const r = run([p, ...BASE_ARGS, '--path', 'dataset.json']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('6/6 rows match');
    expect(r.stdout).toContain('OK');
    const sha = createHash('sha256').update(JSON.stringify(DATASET)).digest('hex');
    expect(r.stdout).toContain(`dataset sha256=${sha}`);
  });

  test('--expected-dataset-sha: match passes, mismatch exits 1', () => {
    const p = writeFixture('sha.ndjson', goodLines());
    const sha = createHash('sha256').update(JSON.stringify(DATASET)).digest('hex');
    expect(run([p, ...BASE_ARGS, '--path', 'dataset.json', '--expected-dataset-sha', sha]).code).toBe(0);
    const bad = run([p, ...BASE_ARGS, '--path', 'dataset.json', '--expected-dataset-sha', 'deadbeef']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('dataset sha256 mismatch');
  });

  test('resume duplicates dedup cleanly: non-error row supersedes an earlier error row', () => {
    // a::q1 appears twice — first as a transient error, then clean. Mirrors
    // the aggregator's dedup (longmemeval-03): count once, prefer the success.
    const lines = [
      row({ adapter: 'a', question_id: 'q1', error: 'ETIMEDOUT transient' }),
      ...goodLines(),
    ];
    const p = writeFixture('dupes.ndjson', lines);
    const r = run([p, ...BASE_ARGS, '--path', 'dataset.json']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('dupes deduped=1');
    expect(r.stdout).toContain('6/6 rows match');
  });

  test('missing question → per-adapter row-count mismatch, exit 1 with counts', () => {
    const lines = goodLines().filter(l => !(l.includes('"adapter":"b"') && l.includes('"q2"')));
    const p = writeFixture('missing.ndjson', lines);
    const r = run([p, ...BASE_ARGS]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('b: 2 unique (adapter, question_id) rows after dedup, expected 3');
    expect(r.stderr).toContain('FAIL');
    // No partial-success wording on failure.
    expect(r.stdout).not.toContain('OK');
  });

  test('same counts but different question ids → coverage mismatch, exit 1', () => {
    const lines = goodLines().map(l =>
      l.includes('"adapter":"b"') && l.includes('"q2"') ? row({ adapter: 'b', question_id: 'q3' }) : l,
    );
    const p = writeFixture('coverage.ndjson', lines);
    const r = run([p, ...BASE_ARGS]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('question_id coverage differs');
  });

  test('ground truth deviating from the dataset → exit 1 with the failing rows counted', () => {
    const lines = goodLines().map(l =>
      l.includes('"adapter":"a"') && l.includes('"q1"')
        ? row({ adapter: 'a', question_id: 'q1', ground_truth: ['answer_WRONG'] })
        : l,
    );
    const p = writeFixture('gt.ndjson', lines);
    const r = run([p, ...BASE_ARGS, '--path', 'dataset.json']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('5/6 rows match');
    expect(r.stderr).toContain('ground_truth mismatch on 1/6 rows');
    expect(r.stderr).toContain('a::q1');
  });

  test('wrong abstention count → exit 1', () => {
    const p = writeFixture('abs.ndjson', goodLines());
    const r = run([p, '--expected-rows', '3', '--expected-abs', '2', '--adapters', 'a,b']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('1 abstention (_abs) questions, expected 2');
  });

  test('unexpected adapter set → exit 1', () => {
    const lines = [...goodLines(), row({ adapter: 'c', question_id: 'q1' })];
    const p = writeFixture('adapters.ndjson', lines);
    const r = run([p, ...BASE_ARGS]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('adapter set mismatch');
  });

  test('malformed line → exit 1 (a committed stream must parse 100%)', () => {
    const p = writeFixture('parse.ndjson', [...goodLines(), '{truncated']);
    const r = run([p, ...BASE_ARGS]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('malformed/truncated');
  });

  test('NDJSON file missing → exit 2', () => {
    const r = run([join(dir, 'nope.ndjson'), ...BASE_ARGS]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('NDJSON unreadable');
  });

  test('dataset file missing → exit 2', () => {
    const p = writeFixture('ds-missing.ndjson', goodLines());
    const r = run([p, ...BASE_ARGS, '--path', 'nope-dataset.json']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('dataset unreadable');
  });

  test('dataset with the wrong shape → exit 2, not a soft mismatch', () => {
    writeFileSync(join(dir, 'bad-dataset.json'), JSON.stringify({ not: 'questions' }));
    const p = writeFixture('ds-shape.ndjson', goodLines());
    const r = run([p, ...BASE_ARGS, '--path', 'bad-dataset.json']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('dataset unreadable');
  });

  test('no positional NDJSON arg → usage on exit 2', () => {
    const r = run(['--expected-rows', '3']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage:');
  });
});
