import { expect, test } from 'bun:test';
import { exactMcNemar, pairedBounds } from '../../docs/benchmarks/2026-11-18-entity-dedupe-h2h/analysis/analyze.ts';

test('exact McNemar uses discordant pairs only and doubles the smaller binomial tail', () => {
  expect(exactMcNemar(0, 0)).toBe(1);
  expect(exactMcNemar(3, 3)).toBe(1);
  expect(exactMcNemar(0, 7)).toBe(1 / 64);
  expect(exactMcNemar(7, 0)).toBe(1 / 64);
  expect(exactMcNemar(2, 5)).toBe(58 / 128);
});

test('a zero observed difference is not zero uncertainty', () => {
  const z2 = 1.6448536269514722 ** 2;
  const estimate = pairedBounds(188, 0, 0);
  expect(estimate.difference).toBe(0);
  expect(estimate.upper95).toBeCloseTo(z2 / (188 + z2), 9);
  expect(estimate.upper95).toBeGreaterThan(.01);
  expect(estimate.ci95[0]).toBeCloseTo(-estimate.ci95[1], 9);
});

test('swapping paired arms negates the estimate and reflects the two-sided interval', () => {
  const a = pairedBounds(488, 83, 1), b = pairedBounds(488, 1, 83);
  expect(a.difference).toBe(-b.difference);
  expect(a.ci95[0]).toBeCloseTo(-b.ci95[1], 9);
  expect(a.ci95[1]).toBeCloseTo(-b.ci95[0], 9);
  expect(a.ci95[0]).toBeGreaterThan(0);
  expect(a.upper95).toBeLessThan(a.ci95[1]);
});
