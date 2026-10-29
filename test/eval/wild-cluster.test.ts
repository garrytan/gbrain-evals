/**
 * Restricted wild cluster bootstrap-t (eval/runner/stats/wild-cluster.ts):
 * parity with the proof wave's original on shared inputs, the two-sided test
 * and its inverted interval, and size at ten clusters.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seededRandom } from '../../eval/runner/stats/paired.ts';
import { estimate, prepare, wildRestrictedInterval, wildRestrictedP, wildTest, type ClusterRow } from '../../eval/runner/stats/wild-cluster.ts';

const parity = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/wild-cluster/proof-wave-parity.json'), 'utf8')) as {
  draws: number; seed: number;
  cases: Record<string, { rows: ClusterRow[]; theta: number; se: number; theta0s: number[]; p: { webb: number[]; rademacher: number[] } }>;
};

describe('parity with the proof wave original', () => {
  for (const [name, c] of Object.entries(parity.cases)) {
    test(`${name}: estimate and one-sided restricted p-values are identical`, () => {
      const p = prepare(c.rows);
      const e = estimate(p);
      expect(e.theta).toBe(c.theta);
      expect(e.se).toBe(c.se);
      for (const weights of ['webb', 'rademacher'] as const) {
        expect(wildRestrictedP(p, c.theta0s, { draws: parity.draws, seed: parity.seed, weights, alternative: 'greater' })).toEqual(c.p[weights]);
      }
    });
  }
});

describe('two-sided superiority test', () => {
  const rows = parity.cases['ten-balanced-graded'].rows;

  test('the two-sided p-value is at least each one-sided tail and at most twice the smaller one plus Monte Carlo slack', () => {
    const p = prepare(rows);
    const o = { draws: 1999, seed: 5, weights: 'webb' as const };
    const [two] = wildRestrictedP(p, [0], { ...o, alternative: 'two-sided' });
    const [hi] = wildRestrictedP(p, [0], { ...o, alternative: 'greater' });
    const [lo] = wildRestrictedP(p, [0], { ...o, alternative: 'less' });
    expect(two).toBeGreaterThanOrEqual(Math.min(hi, lo));
    expect(two).toBeLessThanOrEqual(Math.min(1, 2 * Math.min(hi, lo) + 0.05));
  });

  test('the inverted interval contains the estimate, excludes far nulls and is not rejected at its own edges', () => {
    const p = prepare(rows);
    const { theta, se } = estimate(p);
    const o = { draws: 999, seed: 9, weights: 'webb' as const, alpha: 0.05 };
    const [lo, hi] = wildRestrictedInterval(p, o);
    expect(lo).toBeLessThan(theta);
    expect(hi).toBeGreaterThan(theta);
    expect(hi - lo).toBeGreaterThan(2 * se);
    expect(hi - lo).toBeLessThan(8 * se);
    const [atLo, atHi, far] = wildRestrictedP(p, [lo, hi, theta + 6 * se], { ...o, alternative: 'two-sided' });
    expect(atLo).toBeGreaterThan(0.05);
    expect(atHi).toBeGreaterThan(0.05);
    expect(far).toBeLessThanOrEqual(0.05);
  });

  test('wildTest is deterministic for a seed and antisymmetric when the arms swap', () => {
    const a = wildTest(rows, { draws: 999, seed: 3 });
    const b = wildTest(rows, { draws: 999, seed: 3 });
    expect(b).toEqual(a);
    const swapped = wildTest(rows.map(r => ({ ...r, sum: -r.sum })), { draws: 999, seed: 3 });
    expect(swapped.theta).toBeCloseTo(-a.theta, 12);
    expect(swapped.p).toBeCloseTo(a.p, 12);
    expect(swapped.ci95[0]).toBeCloseTo(-a.ci95[1], 6);
    expect(swapped.ci95[1]).toBeCloseTo(-a.ci95[0], 6);
  });

  test('identical differences in every question give a degenerate interval, not a crash', () => {
    const flat = Array.from({ length: 10 }, (_, c) => ({ id: `c${c}`, stratum: 's', n: 20, sum: 20 * 0.1 }));
    const t = wildTest(flat, { draws: 199, seed: 1 });
    expect(t.se).toBeCloseTo(0, 12);
    expect(t.ci95[0]).toBeCloseTo(0.1, 12);
    expect(t.ci95[1]).toBeCloseTo(0.1, 12);
  });

  test('refuses a cluster without questions', () => {
    expect(() => prepare([{ id: 'a', stratum: 's', n: 0, sum: 0 }, { id: 'b', stratum: 's', n: 1, sum: 0 }])).toThrow();
  });

  test('at ten clusters the two-sided test rejects a true null near 5% of the time with Webb weights', () => {
    const rng = seededRandom(2026);
    const normal = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    const sims = 600;
    let rejects = 0;
    for (let s = 0; s < sims; s++) {
      const sim: ClusterRow[] = Array.from({ length: 10 }, (_, c) => {
        const u = 0.05 * normal();
        let sum = 0;
        for (let q = 0; q < 20; q++) sum += u + 0.4 * normal();
        return { id: `c${c}`, stratum: 's', n: 20, sum };
      });
      const [pv] = wildRestrictedP(prepare(sim), [0], { draws: 199, seed: s + 1, weights: 'webb', alternative: 'two-sided' });
      if (pv <= 0.05) rejects++;
    }
    expect(rejects / sims).toBeGreaterThan(0.02);
    expect(rejects / sims).toBeLessThan(0.09);
  });
});
