import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExperimentManifest } from '../../eval/runner/cat40-model-ladder.ts';
import { countCells, declared, reuseVerdict } from '../../eval/runner/cat40/reuse-check.ts';

const PUB = 'docs/benchmarks/2026-10-14-cat40-next-confirm-public';
const manifest = (dir: string) => JSON.parse(readFileSync(join(PUB, dir, 'experiment.json'), 'utf8')) as ExperimentManifest;
const cellsOf = (dir: string, label: string) => countCells(readFileSync(join(PUB, dir, 'results.jsonl'), 'utf8').split('\n'), label);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('reuse-check: reusing a Cat 40 arm', () => {
  test('fs and oracle from a world are reusable by a new gbrain build on that world', () => {
    for (const arm of ['fs', 'oracle']) {
      const v = reuseVerdict(manifest(`p1/${arm}`), manifest('p1/wave'), arm, cellsOf(`p1/${arm}`, arm));
      expect(v.reasons).toEqual([]);
      expect(v.reusable).toBe(true);
      expect(v.cells.map(c => c.cells)).toEqual([100, 100, 100]);
    }
  });

  test('another world, another build or a changed evaluator is refused', () => {
    const fs = manifest('p1/fs'), cells = cellsOf('p1/fs', 'fs');
    expect(reuseVerdict(fs, manifest('p2/wave'), 'fs', cells).reasons.some(r => r.startsWith('world_digest'))).toBe(true);
    const gb = reuseVerdict(manifest('p1/baseline'), manifest('p1/wave'), 'gbrain', cellsOf('p1/baseline', 'gbrain-next-baseline'));
    expect(gb.reusable).toBe(false);
    expect(gb.reasons.some(r => r.startsWith('gbrain_commit'))).toBe(true);
    const judge = clone(manifest('p1/wave'));
    judge.hard!.judge = 'claude-opus-5-5';
    judge.flags['--judge'] = 'claude-opus-5-5';
    expect(reuseVerdict(fs, judge, 'fs', cells).reasons).toEqual(['hard: judge differ', 'flag --judge: prior "gpt-6.1-sol", planned "claude-opus-5-5"']);
    const code = clone(manifest('p1/wave'));
    code.hard!.code['eval/runner/cat40/score-hard.ts'] = 'f'.repeat(64);
    expect(reuseVerdict(fs, code, 'fs', cells).reasons).toEqual(['hard: code differ']);
    const turns = clone(manifest('p1/wave'));
    turns.flags['--max-turns'] = '20';
    expect(reuseVerdict(fs, turns, 'fs', cells).reasons).toEqual(['flag --max-turns: prior null, planned "20"']);
  });

  test('run-control flags and the runner commit may differ; models must have run, completely', () => {
    const fs = manifest('p1/fs'), cells = cellsOf('p1/fs', 'fs');
    const planned = clone(manifest('p1/wave'));
    Object.assign(planned.flags, { '--concurrency': '4', '--budget-ledger': '.budget/other.sqlite', '--out': 'elsewhere', '--accept-freeze-drift': 'other note' });
    planned.hard!.runner_commit = 'abc';
    expect(reuseVerdict(fs, planned, 'fs', cells).reusable).toBe(true);
    planned.models = ['claude-opus-5-5', 'gpt-6.2-new'];
    expect(reuseVerdict(fs, planned, 'fs', cells).reasons).toEqual(['planned models not in the prior run: gpt-6.2-new']);
    const partial = cells.map(c => (c.model === 'gpt-6.1-sol' ? { ...c, cells: 60 } : c));
    expect(reuseVerdict(fs, manifest('p1/wave'), 'fs', partial).reasons[0]).toContain('the prior run is partial');
    const errors = cells.map(c => (c.model === 'claude-opus-5-5' ? { ...c, harness_errors: 2 } : c));
    expect(reuseVerdict(fs, manifest('p1/wave'), 'fs', errors).reasons).toEqual(['claude-opus-5-5: 2 cells end in a harness error']);
    expect(reuseVerdict(fs, manifest('p1/wave'), 'wave', cells).reasons).toContain('unknown arm wave');
  });

  test('countCells keeps the last clean attempt and counts a trailing harness error', () => {
    const row = (model: string, task: string, stop: string) => JSON.stringify({ arm: 'fs', model, task, repeat: 0, stop });
    expect(countCells([row('a', 't1', 'harness_error'), row('a', 't1', 'submitted'), row('a', 't2', 'harness_error'), row('b', 't1', 'submitted'), JSON.stringify({ arm: 'oracle', model: 'a', task: 't3', stop: 'submitted' })], 'fs'))
      .toEqual([{ model: 'a', cells: 1, harness_errors: 1 }, { model: 'b', cells: 1, harness_errors: 0 }]);
  });

  test('the preregistration must name the prior budget run and the arm on one line', () => {
    const fs = manifest('p1/fs');
    expect(declared(`- Reuse: arm \`fs\` from budget run ${fs.budget_run_id}.`, fs, 'fs')).toBe(true);
    expect(declared(`- Reuse: arm fs-acl from budget run ${fs.budget_run_id}.`, fs, 'fs')).toBe(false);
    expect(declared(`- Reuse: arm fs.\n- budget run ${fs.budget_run_id}`, fs, 'fs')).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'reuse-check-'));
    writeFileSync(join(dir, 'prereg.md'), `Reuse \`fs\` cells from ${fs.budget_run_id} (p1).\n`);
    const cli = (prereg: string) => spawnSync('bun', ['eval/runner/cat40/reuse-check.ts', '--prior', join(PUB, 'p1/fs'), '--planned', join(PUB, 'p1/wave'), '--arm', 'fs', '--preregistration', prereg, '--json'], { encoding: 'utf8' });
    const ok = cli(join(dir, 'prereg.md'));
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).declared).toBe(true);
    writeFileSync(join(dir, 'none.md'), 'no reuse here\n');
    expect(cli(join(dir, 'none.md')).status).toBe(1);
  });
});

describe('arm_power.py: sizing one arm by simulation', () => {
  const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol'];
  const cell = (arm: string, model: string, task: string, success: boolean, wrong = false) =>
    JSON.stringify({ arm, model, task, family: 'H2', variant: 'x', stop: 'submitted', total_usd: 0.5, score: { success, submitted: true, said_wrong: wrong } });
  const world = (rule: (i: number) => [boolean, boolean]) => MODELS.flatMap(m => Array.from({ length: 40 }, (_, i) => {
    const [wave, fs] = rule(i);
    return [cell('gbrain-next-wave', m, `H2-${i}`, wave), cell('gbrain-next-baseline', m, `H2-${i}`, wave, !wave), cell('fs', m, `H2-${i}`, fs)];
  }).flat()).join('\n');
  const run = (rows: string, extra: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'arm-power-'));
    writeFileSync(join(dir, 'p1.jsonl'), rows);
    execFileSync('python3', ['eval/runner/cat40/arm_power.py', '--world', `P1=${join(dir, 'p1.jsonl')}`, '--arm', 'fs', '--draws', '5', '--resamples', '300', '--fractions', '0.25,0.5', '--json', join(dir, 'out.json'), ...extra], { encoding: 'utf8' });
    return JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
  };

  test('a large effect keeps its verdict at every fraction and reports the spend not made', () => {
    const out = run(world(() => [true, false]));
    expect(out.full['primary:public'].wording).toBe('ahead');
    expect(out.arm_usd).toBe(60);
    expect(out.fractions['0.5']).toMatchObject({ all_agree: true, usd_not_spent: 30 });
    expect(out.fractions['0.25'].agree['primary:public']).toBe('5/5');
    expect(out.fractions['0.25'].usd_not_spent).toBe(45);
  }, 120_000);

  test('a small effect loses its verdict when the arm shrinks', () => {
    const out = run(world(i => [i % 10 !== 0, i % 10 > 1 && i % 10 !== 9]));
    expect(out.full['primary:public'].wording).toBe('ahead');
    expect(out.fractions['0.25'].all_agree).toBe(false);
  }, 120_000);

  test('an arm with no cells is a usage error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arm-power-'));
    writeFileSync(join(dir, 'p1.jsonl'), world(() => [true, false]));
    const r = spawnSync('python3', ['eval/runner/cat40/arm_power.py', '--world', `P1=${join(dir, 'p1.jsonl')}`, '--arm', 'pg'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
