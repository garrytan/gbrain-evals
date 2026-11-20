/**
 * Cat 40 Hard claims-judge check (eval/runner/cat40/judge-check-hard.ts): construction items pass and fail the scorer
 * as labelled, grading resumes, the gates pass a judge that separates the classes and stop one that doesn't, and
 * `run` refuses before any request without a paid window. Hermetic: judges are fakes; no provider is reached.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateHardWorld } from '../../eval/generators/model-ladder-hard.ts';
import { HARD_SEEDS } from '../../eval/generators/hard/schema.ts';
import { cohenKappa, constructItems, gradeAll, realItems, report, type Grade } from '../../eval/runner/cat40/judge-check-hard.ts';
import { scoreHardTask } from '../../eval/runner/cat40/score-hard.ts';

const ROOT = resolve(import.meta.dir, '../..');
const world = generateHardWorld(HARD_SEEDS.calibration);
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cat40-judge-check-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const verdict = (bad: boolean) => JSON.stringify({ claims: [{ claim: 'x', verdict: bad ? 'contradicted' : 'supported' }] });

describe('construction items', () => {
  const { items } = constructItems(world, 1);
  test('six tasks per family, a good and a bad answer each, deterministic', () => {
    expect(items.length).toBe(60);
    for (const f of ['H1', 'H2', 'H3', 'H4', 'H5']) expect(items.filter(i => i.family === f).length).toBe(12);
    expect(constructItems(world, 1).items).toEqual(items);
    expect(constructItems(world, 2).items.map(i => i.id)).not.toEqual(items.map(i => i.id));
  });
  test('the scorer passes every good answer and fails every bad one', () => {
    const byId = new Map(world.tasks.map(t => [t.id, t]));
    for (const i of items) {
      const ok = scoreHardTask(world, byId.get(i.task)!, [{ final: i.final as never, stop: 'submitted' }]).success;
      expect(ok).toBe(i.label === 'good');
    }
  });
});

describe('grading and gates', () => {
  const { items } = constructItems(world, 1);
  const inOrder = () => { let i = 0; return async () => ({ text: verdict(items[i++ % items.length].label === 'bad') }); };
  test('a judge that separates the classes passes; grading resumes without new calls', async () => {
    const out = tmp();
    let calls = 0;
    const judge = inOrder();
    const call = async () => { calls++; return judge(); };
    expect(await gradeAll(world, items, ['gpt-6.1-sol'], out, call)).toBe(60);
    expect(await gradeAll(world, items, ['gpt-6.1-sol'], out, call)).toBe(0);
    expect(calls).toBe(60);
    const grades = readFileSync(join(out, 'grades.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Grade);
    const r = report(items, grades, ['gpt-6.1-sol']);
    expect(r.judges[0].kappa).toBe(1);
    expect(r.passes).toBe(true);
  });
  test('a judge that calls everything supported fails kappa; a malformed output is retried once then counted', async () => {
    const out = tmp();
    let n = 0;
    await gradeAll(world, items, ['claude-opus-5-5'], out, async () => ({ text: n++ === 0 ? 'not json' : verdict(false) }));
    const grades = readFileSync(join(out, 'grades.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Grade);
    expect(grades.filter(g => g.retried).length).toBe(1);
    const r = report(items, grades, ['claude-opus-5-5']);
    expect(r.passes).toBe(false);
    expect(r.judges[0].failures.join(' ')).toContain('kappa');
    expect(r.judges[0].malformed).toBe(0);
  });
  test('cohenKappa', () => {
    expect(cohenKappa([[true, true], [false, false]])).toBe(1);
    expect(cohenKappa([[true, false], [false, true]])).toBe(-1);
    expect(cohenKappa([])).toBeNull();
  });
  test('real items keep the recorded judgment', () => {
    const rows = world.tasks.slice(0, 50).flatMap(t => ['claude-opus-5-5', 'gpt-6.1-sol'].map(model => ({ model, task: t.id, family: t.family, stop: 'submitted', run: { final: { answer: 'x' } }, claims: { claims: [], unsupported: 1, contradicted: 0, total: 1 } })));
    const real = realItems(rows, 1);
    expect(real.every(i => i.recorded_bad === true && i.kind === 'real')).toBe(true);
  });
});

describe('paid window', () => {
  test('run refuses before any request without a paid window', () => {
    const out = tmp();
    writeFileSync(join(out, 'items.json'), JSON.stringify({ items: [] }));
    let code = 0, err = '';
    try {
      execFileSync('bun', ['eval/runner/cat40/judge-check-hard.ts', 'run', '--out', out, '--judges', 'gpt-6.1-sol', '--budget-usd', '1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    } catch (e) { const x = e as { status: number; stderr: Buffer }; code = x.status; err = String(x.stderr); }
    expect(code).toBe(2);
    expect(err).toContain('--paid-window');
  });
});
