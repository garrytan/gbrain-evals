/**
 * Q1 power simulation (eval/runner/q1/power.ts): dev inputs, the shrink rule,
 * the descriptive-only outcome, a small seeded simulation and the committed
 * power.json. The committed file uses the full counts (1,000 runs, 1,999
 * draws, about four minutes); these tests use small ones.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decide, DEFAULT_OUTPUT, DEFAULT_SIM, DESIGNS, devInputs, minimumDetectable, PUBLIC_10M_CONVERSATION_SD, READERS, readDevRows, scenarios, simulate, strongestDevRows, type PowerReport, type SimResult } from '../../eval/runner/q1/power.ts';

const ROOT = resolve(import.meta.dir, '../..');
const { rows, sources } = readDevRows();
const inputs = devInputs(rows, sources);

describe('dev inputs', () => {
  test('reads the graded starting-line rows of BEAM-1M dev (11 x 20) and BEAM-100K dev (6 x 20)', () => {
    expect(rows['beam-1m-qa-master'].length).toBe(220);
    expect(rows['beam-100k-qa-master'].length).toBe(120);
    expect(new Set(rows['beam-1m-qa-master'].map(r => r.conversation)).size).toBe(11);
    expect(Object.keys(inputs.pools).length).toBe(10);
    for (const r of Object.values(rows).flat()) { expect(r.score).toBeGreaterThanOrEqual(0); expect(r.score).toBeLessThanOrEqual(1); }
  });

  test('variance components are consistent: the public 10M spread is mostly question sampling', () => {
    expect(inputs.within_variance).toBeGreaterThan(0.1);
    expect(inputs.within_variance).toBeLessThan(0.2);
    expect(inputs.public_10m_tau).toBeLessThan(PUBLIC_10M_CONVERSATION_SD);
    expect(inputs.dev_tau).toBeLessThan(inputs.dev_conversation_mean_sd);
    const sc = scenarios(inputs);
    expect(sc.map(s => s.name)).toEqual(['optimistic', 'central', 'pessimistic']);
    expect(sc[2].tau_arm).toBe(PUBLIC_10M_CONVERSATION_SD);
  });
});

describe('rules', () => {
  test('minimum detectable difference interpolates the first crossing of 80%', () => {
    expect(minimumDetectable([{ delta_points: 0, power: 0.05 }, { delta_points: 10, power: 0.6 }, { delta_points: 20, power: 1 }])).toBe(15);
    expect(minimumDetectable([{ delta_points: 0, power: 0.05 }, { delta_points: 10, power: 0.5 }])).toBeNull();
  });

  test('the shrink rule keeps the four strongest dev rows, never gbrain itself, ties by kind id', () => {
    expect(strongestDevRows({ 'gbrain-defaults': 0.9, 'ext-a': 0.5, 'ext-b': 0.7, 'baseline-none': 0.1, 'ext-c': 0.7, 'baseline-hybrid': 0.6 })).toEqual(['ext-b', 'ext-c', 'baseline-hybrid', 'ext-a']);
  });

  const result = (design: string, mdd: number | null): SimResult => ({ design, scenario: 'central', comparisons: design === 'shrunk' ? 4 : 9, sims: 1, draws: 1, fwer: 0.05, coverage: 0.95, diff_sd: 0.3, power_single: [], power_all: [], mdd_points_single: mdd, mdd_points_all: mdd });

  test('full family when the detectable difference is at most 10 points', () => {
    expect(decide([result('balanced', 8), result('shrunk', 6)], null)).toMatchObject({ family1: 'full', shrunk_family: null, detectable_difference_points: 8 });
  });

  test('shrinks to four when the full family cannot detect 10 points but four can, and names them from dev means', () => {
    const d = decide([result('balanced', 12), result('shrunk', 9.5)], { 'ext-a': 0.6, 'ext-b': 0.5, 'ext-c': 0.4, 'ext-d': 0.3, 'baseline-none': 0.1 });
    expect(d).toMatchObject({ family1: 'shrunk', detectable_difference_points: 9.5, shrunk_comparators: ['ext-a', 'ext-b', 'ext-c', 'ext-d'] });
    expect(decide([result('balanced', 12), result('shrunk', 9.5)], null).shrunk_comparators).toBeNull();
  });

  test('descriptive only when even the shrunk family cannot detect 10 points', () => {
    expect(decide([result('balanced', 15), result('shrunk', 12)], null)).toMatchObject({ family1: 'descriptive', detectable_difference_points: 12 });
    expect(decide([result('balanced', null), result('shrunk', null)], null).family1).toBe('descriptive');
    expect(decide([result('balanced', 15), result('shrunk', 12)], { 'ext-a': 0.6, 'ext-b': 0.5, 'ext-c': 0.4, 'ext-d': 0.3, 'ext-e': 0.2 })).toMatchObject({ family1: 'descriptive', shrunk_comparators: ['ext-a', 'ext-b', 'ext-c', 'ext-d'] });
    expect(decide([result('balanced', 8), result('shrunk', 6)], { 'ext-a': 0.6 }).shrunk_comparators).toBeNull();
  });
});

describe('simulation', () => {
  const o = { sims: 40, draws: 399, seed: 3, deltas_points: [0, 10, 20, 30] };
  const central = scenarios(inputs)[1];

  test('is deterministic for a seed and keeps size near nominal on a tiny run', () => {
    const a = simulate(inputs, central, DESIGNS[0], o);
    expect(simulate(inputs, central, DESIGNS[0], o)).toEqual(a);
    expect(a.coverage).toBeGreaterThan(0.85);
    expect(a.power_single[0].power).toBeLessThanOrEqual(0.2);
    expect(a.power_single[3].power).toBeGreaterThanOrEqual(a.power_single[1].power);
    expect(a.power_all[3].power).toBeGreaterThan(0.8);
  });

  test('drops a whole conversation in the missing design', () => {
    const missing = DESIGNS.find(d => d.id === 'missing')!;
    expect(missing.drop_clusters).toBe(1);
    const r = simulate(inputs, central, missing, { ...o, sims: 10 });
    expect(r.design).toBe('missing');
  });
});

describe('committed power.json', () => {
  const report = JSON.parse(readFileSync(join(ROOT, DEFAULT_OUTPUT), 'utf8')) as PowerReport;

  test('was produced from the committed dev rows with the default counts', () => {
    expect(report.schema).toBe('gbrain-evals/q1-power/v1');
    expect(report.options).toMatchObject({ sims: DEFAULT_SIM.sims, draws: DEFAULT_SIM.draws, seed: DEFAULT_SIM.seed, weights: 'webb', readers: READERS });
    for (const s of report.inputs.sources) expect(createHash('sha256').update(readFileSync(join(ROOT, s.path))).digest('hex')).toBe(s.sha256);
    expect(report.results.length).toBe(DESIGNS.length * 3);
  });

  test('the method holds size and coverage at G = 10 across balanced, unequal and missing designs', () => {
    for (const r of report.results) {
      expect(r.fwer).toBeLessThan(0.075);
      expect(r.coverage).toBeGreaterThan(0.925);
      expect(r.coverage).toBeLessThan(0.97);
    }
  });

  test('records the preregistered decision', () => {
    const d = report.decision;
    expect(['full', 'shrunk', 'descriptive']).toContain(d.family1);
    expect(d.threshold_points).toBe(10);
    expect(d.family1).toBe('descriptive');
    expect(d.detectable_difference_points).toBeGreaterThan(10);
  });
});
