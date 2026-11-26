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
import { FRONTIER, JUDGE_FOR, NEWEST_WORLDS, halfTasks, pinnedBuild, worldPlan } from '../../eval/runner/cat40/newest-confirm.ts';
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
      expect(steps.slice(firstParticle).every(s => val(s.argv, '--paid-window') === '$PAID_WINDOW')).toBe(true);
      expect(steps.slice(0, firstParticle).some(s => s.argv.includes('particle-1') && s.argv.includes('--models'))).toBe(false);
    });
    test(`${w}: the oracle gate counts the frontier readers only; every gbrain step uses the pinned build`, () => {
      const gate = steps.find(s => s.id === 'oracle-gate')!;
      expect(val(gate.argv, '--models')).toBe(FRONTIER.join(','));
      for (const s of steps.filter(s => s.argv.includes('--gbrain-ref'))) expect(val(s.argv, '--gbrain-ref')).toBe(BUILD);
      expect(steps.map(s => s.id)).toContain('slots');
      expect(steps.findIndex(s => s.id === 'slots')).toBeLessThan(steps.findIndex(s => s.id === 'oracle-gate'));
      expect(steps.findIndex(s => s.id === 'oracle-gate')).toBeLessThan(steps.findIndex(s => s.id === 'gbrain-opus-a'));
    });
    test(`${w}: both arms pilot on both readers, then a hold, then half A, the one look and half B (R111, R113)`, () => {
      const at = (id: string) => steps.findIndex(s => s.id === id);
      for (const r of ['opus', 'sol']) {
        expect(at(`smoke-${r}`)).toBeLessThan(at('hold-record'));
        expect(at(`smoke-fs-${r}`)).toBeLessThan(at('hold-record'));
        expect(val(steps[at(`smoke-fs-${r}`)].argv, '--arms')).toBe('fs');
        for (const arm of ['gbrain', 'fs']) {
          expect(at('hold-record')).toBeLessThan(at(`${arm}-${r}-a`));
          expect(at(`${arm}-${r}-a`)).toBeLessThan(at('interim-look'));
          expect(at('interim-look')).toBeLessThan(at(`${arm}-${r}-b`));
          expect(val(steps[at(`${arm}-${r}-a`)].argv, '--tasks')).toBe(halfTasks('a').join(','));
          expect(val(steps[at(`${arm}-${r}-b`)].argv, '--tasks')).toBe(halfTasks('b').join(','));
        }
      }
      expect(steps.filter(s => s.hold).map(s => [s.id, s.hold, s.argv.length])).toEqual([['hold-record', 'record', 0], ['interim-look', 'look', 0]]);
      expect(steps.filter(s => s.paid_window).every(s => !s.argv.includes('--tasks'))).toBe(true);
    });
    test(`${w}: every ladder step, the slot build included, accepts the recorded freeze drift`, () => {
      const ladder = steps.filter(s => s.argv.includes('eval/runner/cat40-model-ladder.ts'));
      expect(ladder.map(s => s.id)).toContain('slots');
      for (const s of ladder) expect(val(s.argv, '--accept-freeze-drift')).toContain('accepted-drift.json');
    });
    test(`${w}: every cap is a placeholder, never a dollar figure (R79)`, () => {
      for (const s of steps) {
        if (s.argv.includes('--budget-usd')) expect(val(s.argv, '--budget-usd')).toMatch(/^\$CAP_[A-Z_]+$/);
        if (s.argv.includes('--program-cap-usd')) expect(val(s.argv, '--program-cap-usd')).toBe('$CAP_PROGRAM');
      }
    });
  }
  test('the two halves are disjoint, 50 tasks each, 10 per family, and together are every task', () => {
    const a = halfTasks('a'), b = halfTasks('b');
    expect([a.length, b.length]).toEqual([50, 50]);
    expect(a.filter(x => b.includes(x))).toEqual([]);
    expect([...a, ...b].sort()).toEqual(['H1', 'H2', 'H3', 'H4', 'H5'].flatMap(f => Array.from({ length: 20 }, (_, i) => `${f}-${String(i + 1).padStart(2, '0')}`)).sort());
    for (const f of ['H1', 'H2', 'H3', 'H4', 'H5']) expect(a.filter(x => x.startsWith(f))).toHaveLength(10);
  });
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
  function world(dir: string, name: string, gbrainOk: (i: number) => boolean, fsOk: (i: number) => boolean, drop?: string, keep: (i: number) => boolean = () => true) {
    const lines: string[] = [];
    for (const model of ['claude-opus-5-5', 'gpt-6.2-sol', 'particle-1']) for (const [arm, ok] of [['gbrain-newest', gbrainOk], ['fs', fsOk]] as const) tasks.forEach((t, i) => {
      if (drop === `${arm}|${model}|${t}` || !keep(i)) return;
      lines.push(JSON.stringify({ attempt_id: `${name}|${model}|${arm}|${t}#1`, arm, model, task: t, family: t.slice(0, 2), variant: '', stop: 'submitted', score: { success: ok(i), submitted: true, said_wrong: false }, total_usd: 0.1, judge_usd: 0.01 }));
    });
    const p = join(dir, `${name}.jsonl`);
    writeFileSync(p, lines.join('\n') + '\n');
    return `${name}=${p}`;
  }
  const analyse = (worlds: string[], extra: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'newest-analysis-'));
    const out = join(dir, 'out.json');
    const r = spawnSync('python3', [SCRIPT, ...worlds.flatMap(w => ['--world', w]), '--resamples', '1000', '--json', out, ...extra], { encoding: 'utf8' });
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
  test('an interval wholly below 0 reads "behind" and takes the lead-drops row', () => {
    const d = tmp();
    const h = analyse([world(d, 'N1', i => i >= 10, () => true), world(d, 'N2', i => i >= 10, () => true)]).json.headline;
    expect(h).toMatchObject({ delta_pp: -10, wording: 'behind', comparison: 'drops', outcome_row: 'drops' });
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
  test('the final headline wording reads the interval at the final bound, z 1.98', () => {
    const d = tmp();
    const h = analyse([world(d, 'N1', () => true, i => i >= 10), world(d, 'N2', () => true, i => i >= 10)]).json.headline;
    expect(h.interval_key).toBe('ci_z1.98');
    expect(h['ci_z1.98'][0]).toBeLessThanOrEqual(h.ci95[0]);
    expect(h['ci_z1.98'][1]).toBeGreaterThanOrEqual(h.ci95[1]);
  });
  describe('the one interim look at half A (R113)', () => {
    const half = (i: number) => i < 50;
    const look = (g: (i: number) => boolean, f: (i: number) => boolean, keep = half) => {
      const d = tmp();
      return analyse([world(d, 'N1', g, f, undefined, keep), world(d, 'N2', g, f, undefined, keep)], ['--look', 'interim']);
    };
    test('refuses anything but exactly half A', () => {
      expect(look(() => true, () => true, () => true)).toMatchObject({ code: 3 });
      expect(look(() => true, () => true, () => true).err).toContain('INTERIM_INCOMPLETE');
      expect(look(() => true, () => true, i => i < 45).code).toBe(3);
    });
    test('stops for a difference at |z| >= 2.80 either way and calls the estimate possibly overstated', () => {
      const up = look(() => true, i => i >= 15).json.headline;
      expect(up).toMatchObject({ delta_pp: 30, decision: 'stop: difference, gbrain ahead', stopped_early: true, possibly_overstated: true, interval_key: 'ci_z2.80' });
      expect(up.z).toBeGreaterThanOrEqual(2.8);
      const down = look(i => i >= 15, () => true).json.headline;
      expect(down).toMatchObject({ delta_pp: -30, decision: 'stop: difference, gbrain behind', possibly_overstated: true });
    });
    test('stops for futility when conditional power under the planned +5.4 is below 10%', () => {
      const h = look(i => i % 4 === 0, i => i % 4 === 1).json.headline;
      expect(h).toMatchObject({ delta_pp: 0, decision: 'stop: futility', stopped_early: true });
      expect(h.conditional_power).toBeLessThan(0.1);
    });
    test('continues between the bounds and reports no interval wording', () => {
      const h = look(i => i % 4 === 0 || i % 4 === 1 || i % 10 === 2, i => i % 4 === 0 || i % 4 === 1 || (i % 10 === 3 && i < 20)).json.headline;
      expect(h).toMatchObject({ delta_pp: 4, decision: 'continue', stopped_early: false });
      expect(Math.abs(h.z)).toBeLessThan(2.8);
      expect(h.conditional_power).toBeGreaterThanOrEqual(0.1);
      expect(h.wording).toBeUndefined();
    });
    test('conditional power matches the closed form', () => {
      const out = execFileSync('python3', ['-c', "import sys; sys.path.insert(0, 'eval/runner/cat40'); import newest_analysis as na; print(round(na.conditional_power(0.0, se_interim=7.0), 4), round(na.conditional_power(2.0, se_interim=2.0), 4))"], { encoding: 'utf8' });
      const [a, b] = out.trim().split(' ').map(Number);
      const phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
      expect(a).toBeCloseTo(1 - phi((1.98 - 0 - 5.4 / (7 * Math.SQRT1_2) * 0.5) / Math.SQRT1_2), 3);
      expect(b).toBeCloseTo(1 - phi((1.98 - 2 * Math.SQRT1_2 - 5.4 / (2 * Math.SQRT1_2) * 0.5) / Math.SQRT1_2), 3);
    });
  });
});

/** Abramowitz and Stegun 7.1.26, error below 1.5e-7. */
function erf(x: number) {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
