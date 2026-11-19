/**
 * Cat 40 Hard newest-build re-measure program (eval/runner/cat40/newest-confirm.ts): every reader runs with the judge the
 * preregistration names, particle-1 steps come last inside the paid window, the oracle gate counts only the frontier
 * readers, both worlds use the pinned build, and no dollar figure is part of the plan. newest_analysis.py reproduces a
 * published interval and applies the preregistered thresholds, precedence and completeness rule. Keyless.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRONTIER, JUDGE_FOR, NEWEST_WORLDS, pinnedBuild, worldPlan } from '../../eval/runner/cat40/newest-confirm.ts';
import { HARD_SEEDS } from '../../eval/generators/hard/schema.ts';

const BUILD = 'a'.repeat(40);
const val = (argv: string[], f: string) => argv[argv.indexOf(f) + 1];

describe('newest-confirm plan', () => {
  for (const w of ['n1', 'n2'] as const) {
    const steps = worldPlan(w, BUILD, 'b'.repeat(40), '2026-11-19');
    test(`${w}: no family judges its own rows, and particle-1 never judges`, () => {
      for (const s of steps.filter(s => s.argv.includes('--judge'))) {
        const model = val(s.argv, '--models'), judge = val(s.argv, '--judge');
        expect(judge).toBe(JUDGE_FOR[model]);
        expect(judge.split('-')[0]).not.toBe(model.split('-')[0]);
        expect(judge).not.toContain('particle');
      }
      expect(JUDGE_FOR['gpt-6.2-sol']).toBe('claude-opus-5-5');
    });
    test(`${w}: particle-1 steps are the last ones and all sit in the paid window`, () => {
      const firstParticle = steps.findIndex(s => s.paid_window === 'particle');
      expect(firstParticle).toBeGreaterThan(0);
      expect(steps.slice(firstParticle).every(s => s.paid_window === 'particle' && val(s.argv, '--models') === 'particle-1')).toBe(true);
      expect(steps.slice(0, firstParticle).some(s => s.argv.includes('particle-1') && s.argv.includes('--models'))).toBe(false);
    });
    test(`${w}: the oracle gate counts the frontier readers only; every gbrain step uses the pinned build`, () => {
      const gate = steps.find(s => s.id === 'oracle-gate')!;
      expect(val(gate.argv, '--models')).toBe(FRONTIER.join(','));
      for (const s of steps.filter(s => s.argv.includes('--gbrain-ref'))) expect(val(s.argv, '--gbrain-ref')).toBe(BUILD);
      expect(steps.map(s => s.id)).toContain('slots');
      expect(steps.findIndex(s => s.id === 'slots')).toBeLessThan(steps.findIndex(s => s.id === 'oracle-gate'));
      expect(steps.findIndex(s => s.id === 'oracle-gate')).toBeLessThan(steps.findIndex(s => s.id === 'gbrain-opus'));
    });
    test(`${w}: every cap is a placeholder, never a dollar figure (R79)`, () => {
      for (const s of steps) {
        if (s.argv.includes('--budget-usd')) expect(val(s.argv, '--budget-usd')).toMatch(/^\$CAP_[A-Z_]+$/);
        if (s.argv.includes('--program-cap-usd')) expect(val(s.argv, '--program-cap-usd')).toBe('$CAP_PROGRAM');
      }
    });
  }
  test('worlds carry the preregistered seeds', () => {
    expect([NEWEST_WORLDS.n1.seed, NEWEST_WORLDS.n2.seed]).toEqual([...HARD_SEEDS.newest]);
  });
  test('pinnedBuild reads the 40-character commit and refuses anything else', () => {
    expect(pinnedBuild({ dependencies: { gbrain: `github:garrytan/gbrain#${BUILD}` } })).toBe(BUILD);
    expect(() => pinnedBuild({ dependencies: { gbrain: 'github:garrytan/gbrain#v0.60.742.0' } })).toThrow('no 40-character commit');
  });
});

describe('newest_analysis.py', () => {
  const SCRIPT = 'eval/runner/cat40/newest_analysis.py';
  const tasks = Array.from({ length: 100 }, (_, i) => `H${(i % 5) + 1}-${String(Math.floor(i / 5) + 1).padStart(2, '0')}`);
  /** One world's cells for every reader: gbrain and files succeed on the tasks their predicates pick. */
  function world(dir: string, name: string, gbrainOk: (i: number) => boolean, fsOk: (i: number) => boolean, drop?: string) {
    const lines: string[] = [];
    for (const model of ['claude-opus-5-5', 'gpt-6.2-sol', 'particle-1']) for (const [arm, ok] of [['gbrain-newest', gbrainOk], ['fs', fsOk]] as const) tasks.forEach((t, i) => {
      if (drop === `${arm}|${model}|${t}`) return;
      lines.push(JSON.stringify({ attempt_id: `${name}|${model}|${arm}|${t}#1`, arm, model, task: t, family: t.slice(0, 2), variant: '', stop: 'submitted', score: { success: ok(i), submitted: true, said_wrong: false }, total_usd: 0.1, judge_usd: 0.01 }));
    });
    const p = join(dir, `${name}.jsonl`);
    writeFileSync(p, lines.join('\n') + '\n');
    return `${name}=${p}`;
  }
  const analyse = (worlds: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'newest-analysis-'));
    const out = join(dir, 'out.json');
    const r = spawnSync('python3', [SCRIPT, ...worlds.flatMap(w => ['--world', w]), '--resamples', '1000', '--json', out], { encoding: 'utf8' });
    const json = r.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null;
    rmSync(dir, { recursive: true, force: true });
    return { code: r.status, json, err: r.stderr };
  };
  const tmp = () => mkdtempSync(join(tmpdir(), 'newest-worlds-'));

  test('reproduces the published world M lead (+7.67, 2.67 to 12.67) with the preregistered bootstrap', () => {
    const out = execFileSync('python3', ['-c', "import sys; sys.path.insert(0, 'eval/runner/cat40'); import newest_analysis as na; c, _ = na.load(['docs/benchmarks/2026-10-10-model-ladder-hard-confirmation/main-cells/results.jsonl']); print(na.Comparison({'M': c}, 'gbrain-hard', 'fs', 'success', ['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6.1-sol']).run(10000, 1))"], { encoding: 'utf8' });
    expect(out).toContain("'delta_pp': 7.67, 'ci95': [2.67, 12.67]");
  });
  test('a lead of +10 holds, +20 rises and +2 drops', () => {
    const d = tmp();
    expect(analyse([world(d, 'N1', () => true, i => i >= 10), world(d, 'N2', () => true, i => i >= 10)]).json.headline).toMatchObject({ delta_pp: 10, wording: 'ahead', comparison: 'holds', outcome_row: 'holds' });
    expect(analyse([world(d, 'N1', () => true, i => i >= 20), world(d, 'N2', () => true, i => i >= 20)]).json.headline).toMatchObject({ delta_pp: 20, comparison: 'rises', outcome_row: 'rises' });
    expect(analyse([world(d, 'N1', () => true, i => i >= 2), world(d, 'N2', () => true, i => i >= 2)]).json.headline).toMatchObject({ delta_pp: 2, comparison: 'drops', outcome_row: 'drops' });
  });
  test('a point estimate at or above +5.3 whose interval reaches below -3 takes the "not distinguishable" row', () => {
    const d = tmp();
    const g = (i: number) => i < 40, f = (i: number) => i >= 40 && i < 74;
    const h = analyse([world(d, 'N1', g, f), world(d, 'N2', g, f)]).json.headline;
    expect(h.delta_pp).toBe(6);
    expect(h.comparison).toBe('holds');
    expect(h.wording).toBe('not distinguishable');
    expect(h.outcome_row).toBe('not distinguishable from 0');
  });
  test('a missing frontier cell refuses the headline; a missing particle-1 cell leaves only its row incomplete', () => {
    const d = tmp();
    const r = analyse([world(d, 'N1', () => true, i => i >= 10, 'fs|gpt-6.2-sol|H3-04'), world(d, 'N2', () => true, i => i >= 10)]);
    expect(r.code).toBe(3);
    expect(r.err).toContain('HEADLINE_INCOMPLETE');
    const p = analyse([world(d, 'N1', () => true, i => i >= 10, 'gbrain-newest|particle-1|H3-04'), world(d, 'N2', () => true, i => i >= 10)]);
    expect(p.code).toBe(0);
    expect(p.json.per_reader['particle-1'].incomplete).toEqual({ 'N1|gbrain-newest|particle-1': 1 });
  });
  test('H4 is level or behind when its lower bound is at or below 0; cost per correct answer counts every attempt', () => {
    const d = tmp();
    const j = analyse([world(d, 'N1', i => !(i % 5 === 3), i => !(i % 5 === 3)), world(d, 'N2', i => !(i % 5 === 3), i => !(i % 5 === 3))]).json;
    expect(j.per_family.H4.level_or_behind).toBe(true);
    expect(j.first_table['gbrain-newest|claude-opus-5-5']).toEqual({ successes: 160, cost_per_correct_usd: 0.1375 });
  });
});
