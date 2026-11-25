/**
 * Cat 40 Hard H4 section-delivery confirmation judge check (eval/runner/cat40/h4fix-judge-check.ts): each judge gets
 * 100 construction items on N1 in its graded readers' answer style, labels agree with the deterministic scorer, the
 * gates pass a judge that separates the classes and stop one that doesn't, and `run` refuses before any request
 * without a paid window. Hermetic: judges are fakes; no provider is reached.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateHardWorld } from '../../eval/generators/model-ladder-hard.ts';
import { HARD_SEEDS, validateKnobs } from '../../eval/generators/hard/schema.ts';
import type { Grade } from '../../eval/runner/cat40/judge-check-hard.ts';
import { checkReport, gradeItems, JUDGES, N1_SEED, planItems, STYLES_FOR, type Item } from '../../eval/runner/cat40/h4fix-judge-check.ts';
import { scoreHardTask } from '../../eval/runner/cat40/score-hard.ts';

const ROOT = resolve(import.meta.dir, '../..');
const knobs = validateKnobs(JSON.parse(readFileSync(join(ROOT, 'docs/benchmarks/cat40-hard/knobs.frozen.json'), 'utf8')));
const world = generateHardWorld(N1_SEED, knobs);
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'h4fix-judge-check-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const { items } = planItems(world, 1);
const grade = (i: Item, bad: boolean | null, judge = i.judge): Grade =>
  ({ item: i.id, judge, retried: false, claims: bad === null ? null : { claims: [], unsupported: 0, contradicted: bad ? 1 : 0, total: 1 } });

describe('construction items', () => {
  test('each judge gets 100 items, 20 per family, 50 good and 50 bad, deterministic', () => {
    for (const judge of JUDGES) {
      const mine = items.filter(i => i.judge === judge);
      expect(mine.length).toBe(100);
      for (const f of ['H1', 'H2', 'H3', 'H4', 'H5']) expect(mine.filter(i => i.family === f).length).toBe(20);
      expect(mine.filter(i => i.label === 'good').length).toBe(50);
    }
    expect(planItems(world, 1).items).toEqual(items);
    expect(planItems(world, 2).items.map(i => i.id)).not.toEqual(items.map(i => i.id));
  });
  test('every label agrees with the deterministic scorer', () => {
    const byId = new Map(world.tasks.map(t => [t.id, t]));
    for (const i of items) expect(scoreHardTask(world, byId.get(i.task)!, [{ final: i.final as never, stop: 'submitted' }]).success).toBe(i.label === 'good');
  });
  test('answers are in the graded readers\' style, and no judge sees its own family\'s style', () => {
    expect(new Set(items.filter(i => i.judge === 'gpt-6.2-sol').map(i => i.style))).toEqual(new Set(['opus']));
    expect(new Set(items.filter(i => i.judge === 'claude-opus-5-5').map(i => i.style))).toEqual(new Set(['sol', 'particle']));
    expect(JUDGES.some(j => j.startsWith('particle'))).toBe(false);
    expect(items.filter(i => i.style === 'particle').every(i => i.final.notes === undefined)).toBe(true);
    expect(items.filter(i => i.style === 'opus' && i.family === 'H4').every(i => /^1\) \S/.test(i.final.notes ?? ''))).toBe(true);
    expect(new Set(items.filter(i => i.label === 'bad').map(i => i.bad_kind))).toEqual(new Set(['listed_wrong', 'wrong_account', 'extra_account', 'count_changed']));
  });
  test('refuses any world but N1', () => {
    expect(() => planItems({ ...world, seed: HARD_SEEDS.calibration }, 1)).toThrow(/N1/);
  });
});

describe('gates', () => {
  const all = (f: (i: Item) => boolean | null) => items.map(i => grade(i, f(i)));
  test('a judge that separates the classes passes', () => {
    const r = checkReport(items, all(i => i.label === 'bad'));
    expect(r.passes).toBe(true);
    expect(r.judges.map(j => j.kappa)).toEqual([1, 1]);
    expect(r.judges.find(j => j.judge === 'claude-opus-5-5')!.by_style).toEqual({ sol: { graded: 50, missed_bad: 0, flagged_good: 0 }, particle: { graded: 50, missed_bad: 0, flagged_good: 0 } });
  });
  test('a judge that flags everything fails kappa, and errors are reported per style', () => {
    const r = checkReport(items, all(i => i.judge === 'gpt-6.2-sol' ? true : i.label === 'bad'));
    expect(r.passes).toBe(false);
    const g = r.judges.find(j => j.judge === 'gpt-6.2-sol')!;
    expect(g.failures.join()).toMatch(/kappa/);
    expect(g.by_style.opus.flagged_good).toBe(50);
  });
  test('a missing grade, a second malformed output, or a grade by the wrong judge fails', () => {
    const ok = all(i => i.label === 'bad');
    expect(checkReport(items, ok.slice(1)).passes).toBe(false);
    const twoMalformed = ok.map((g, n) => (n < 2 ? { ...g, claims: null } : g));
    expect(checkReport(items, twoMalformed).judges[0].failures.join()).toMatch(/malformed/);
    const wrongJudge = ok.map(g => (g.judge === 'gpt-6.2-sol' ? { ...g, judge: 'claude-opus-5-5' } : g));
    expect(checkReport(items, wrongJudge).judges.find(j => j.judge === 'gpt-6.2-sol')!.passes).toBe(false);
  });
  test('grading sends each judge only its own items and resumes', async () => {
    const out = tmp();
    const calls: string[] = [];
    const fake = async (model: string) => { calls.push(model); return { text: JSON.stringify({ claims: [{ claim: 'x', verdict: 'supported' }] }) }; };
    expect(await gradeItems(world, items.slice(0, 4).concat(items.slice(100, 104)), out, fake)).toBe(8);
    expect(calls.sort()).toEqual([...Array(4).fill('claude-opus-5-5'), ...Array(4).fill('gpt-6.2-sol')].sort());
    expect(await gradeItems(world, items.slice(0, 4).concat(items.slice(100, 104)), out, fake)).toBe(0);
  });
});

test('run refuses before any request without a paid window or with a budget above the cap', () => {
  const out = tmp(), wf = join(out, 'world.json');
  writeFileSync(wf, JSON.stringify(world));
  const env = { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', OPENAI_BASE_URL: 'http://127.0.0.1:9' };
  const run = (extra: string[]) => spawnSync('bun', ['eval/runner/cat40/h4fix-judge-check.ts', 'run', '--world', wf, '--out', out, ...extra], { cwd: ROOT, env, encoding: 'utf8' });
  const a = run(['--window-cap-usd', '5', '--budget-usd', '5']);
  expect(a.status).toBe(2);
  expect(a.stderr).toMatch(/paid-window/);
  const b = run(['--paid-window', 'u', '--window-cap-usd', '5', '--budget-usd', '6']);
  expect(b.status).toBe(2);
  expect(STYLES_FOR['gpt-6.2-sol']).toEqual(['opus']);
});
