import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { betaQuantile, decide, ratioInterval, riskDifference, clusteredRate, simulate, SCENARIOS, tQuantile, chooseMethod, type ClusterTotals } from '../../eval/runner/power/risk-ratio.ts';
import { contrastInterval, simulateSize, SIZE_SCENARIOS } from '../../eval/runner/power/size-contrast.ts';
import { DEFAULT_OUTPUT, PW_VERSION, T0_DEV_DESIGN } from '../../eval/runner/power/validate.ts';

const totals = (rows: Array<[number, number, number]>): ClusterTotals[] => rows.map(([n, baseline, candidate]) => ({ n, baseline, candidate }));

describe('PW numeric helpers', () => {
  test('t and beta quantiles match reference values', () => {
    expect(tQuantile(0.975, 7)).toBeCloseTo(2.364624, 5);
    expect(tQuantile(0.975, 1)).toBeCloseTo(12.7062, 3);
    expect(tQuantile(0.975, 1000)).toBeCloseTo(1.962339, 5);
    // Clopper-Pearson upper bound for 0 of 10: 1 - 0.025^(1/10).
    expect(betaQuantile(0.975, 1, 10)).toBeCloseTo(1 - 0.025 ** 0.1, 6);
  });
});

describe('clustered paired failure-risk ratio', () => {
  test('zero candidate failures give a finite positive ratio and an honest, exact-style bound', () => {
    const c = totals([[24, 7, 0], [24, 8, 0], [24, 6, 0], [24, 9, 0]]);
    const e = ratioInterval(c, 'cond-binomial');
    expect(e.ratio).toBeCloseTo(0.5 / 30.5, 10);
    expect(e.lower).toBe(0);
    // 0 candidate failures out of 30 total: the upper bound for pi is 1 - 0.025^(1/30), about 0.116.
    expect(e.upper).toBeCloseTo((1 - 0.025 ** (1 / 30)) / (0.025 ** (1 / 30)), 3);
    expect(decide(c, 'cond-binomial', { lossTolerance: 0.03 }).verdict).toBe('improvement');
  });

  test('verdicts: ceiling, 10x, improvement, worse, inconclusive', () => {
    expect(decide(totals([[10, 0, 1], [10, 0, 0]]), 'cond-binomial', { lossTolerance: 0.03 }).verdict).toBe('ceiling');
    const big = totals(Array.from({ length: 16 }, () => [24, 8, 0] as [number, number, number]));
    expect(decide(big, 'cond-binomial', { lossTolerance: 0.03 }).verdict).toBe('10x');
    expect(decide(totals([[24, 8, 2], [24, 9, 3], [24, 7, 2], [24, 8, 1]]), 'cond-binomial', { lossTolerance: 0.03 }).verdict).toBe('improvement');
    expect(decide(totals([[24, 2, 9], [24, 3, 10], [24, 2, 8], [24, 1, 9]]), 'cond-binomial', { lossTolerance: 0.03 }).verdict).toBe('worse');
    expect(decide(totals([[24, 5, 5], [24, 4, 6], [24, 6, 4]]), 'cond-binomial', { lossTolerance: 0.03 }).verdict).toBe('inconclusive');
  });

  test('the loss tolerance is a clustered risk-difference bound; a clustered rate stays in [0, 1]', () => {
    const same = totals([[24, 5, 5], [24, 4, 4], [24, 6, 6]]);
    expect(riskDifference(same)).toMatchObject({ diff: 0 });
    expect(decide(same, 'cond-binomial', { lossTolerance: 0.03 }).non_inferior).toBe(true);
    expect(decide(totals([[24, 2, 6], [24, 1, 5], [24, 2, 7]]), 'cond-binomial', { lossTolerance: 0.03 }).non_inferior).toBe(false);
    const r = clusteredRate([{ n: 4, failures: 0 }, { n: 4, failures: 4 }]);
    expect(r.lower).toBeGreaterThanOrEqual(0);
    expect(r.upper).toBeLessThanOrEqual(1);
  });

  test('the frozen method holds coverage and makes no false 10x at the boundary (small simulation)', () => {
    for (const name of ['null-central', 'null-heterogeneous', 'tenfold-boundary', 'tenfold-sparse']) {
      const s = SCENARIOS.find(x => x.name === name)!;
      const r = simulate(s, T0_DEV_DESIGN, 'cond-binomial', { sims: 200, seed: 5 });
      expect([name, r.coverage! >= 0.93]).toEqual([name, true]);
      expect([name, r.verdicts['10x'] <= 0.05]).toEqual([name, true]);
    }
    const zero = simulate(SCENARIOS.find(x => x.name === 'ceiling-zero-candidate')!, T0_DEV_DESIGN, 'cond-binomial', { sims: 100, seed: 5 });
    expect(zero.coverage).toBeNull();
  });

  test('the committed validation report chose the conditional-binomial interval by the frozen rule', () => {
    expect(existsSync(DEFAULT_OUTPUT)).toBe(true);
    const report = JSON.parse(readFileSync(DEFAULT_OUTPUT, 'utf8'));
    expect(report.version).toBe(PW_VERSION);
    expect(chooseMethod(report.risk_ratio.validation).method).toBe('cond-binomial');
    expect(report.risk_ratio.method.method).toBe('cond-binomial');
  });
});

describe('within-persona size contrast', () => {
  test('the persona t interval is centered and has the right width', () => {
    const ci = contrastInterval([1, 2, 3, 4, 5]);
    expect(ci.mean).toBe(3);
    expect(ci.upper - ci.mean).toBeCloseTo(tQuantile(0.975, 4) * Math.sqrt(2.5) / Math.sqrt(5), 8);
  });

  test('false-positive rate under no contrast stays near 5% (small simulation)', () => {
    for (const s of SIZE_SCENARIOS) {
      const r = simulateSize(s, { personas: 8, questions: 30, readers: 2, missing: 1 }, 0, { sims: 200, seed: 9 });
      expect([s.name, r.reject_rate <= 0.1]).toEqual([s.name, true]);
    }
  });
});

describe('PW sample-size rule', () => {
  test('a frequent-failure baseline needs fewer personas than a rare one; the search stops at its cap', async () => {
    const { personasForTenfold } = await import('../../eval/runner/power/validate.ts');
    const common = personasForTenfold(0.5, { maxPersonas: 64, sims: 150 });
    expect(common.personas).not.toBeNull();
    expect(personasForTenfold(0.02, { maxPersonas: 16, sims: 100 }).personas).toBeNull();
  });
});
