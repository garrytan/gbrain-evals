/**
 * Memory proof wave A0.1: the non-inferiority statistics, the power
 * simulation and the committed inputs. Small seeded runs; the committed
 * report uses the full simulation counts.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../eval/runner/sealed-confirmation-lib.ts';
import { clusterSpread } from '../../eval/runner/memory-proof-wave/cluster-stats.ts';
import { betweenClusterSd, loadLock, providerLabel, type PowerInputs } from '../../eval/runner/memory-proof-wave/harness-inputs.ts';
import { BOUND_METHODS, decide, estimate, lowerBounds, prepare, studentTQuantile, wildRestrictedLowerBound, wildRestrictedP, type ClusterRow } from '../../eval/runner/memory-proof-wave/ni-stats.ts';
import { approximateMdm, coverage, GBRAIN_PAIRED_LME, interpolateDistance, minimumDetectableMargin, pairedVariance, poolStratum, powerAt, scenarios, simulate, summarize } from '../../eval/runner/memory-proof-wave/power.ts';
import { DEFAULT_INPUTS, DESIGNS, DISTANCES } from '../../eval/runner/memory-proof-wave-power.ts';

const ROOT = join(import.meta.dir, '../..');
const inputs = JSON.parse(readFileSync(join(ROOT, DEFAULT_INPUTS), 'utf8')) as PowerInputs;

function rowsFrom(values: number[][], strata: string[]): ClusterRow[] {
  return values.map((v, i) => ({ id: `c${i}`, stratum: strata[i], n: v.length, sum: v.reduce((s, x) => s + x, 0) }));
}

describe('non-inferiority statistics', () => {
  test('estimate is the question-weighted mean with the stratified CR1 standard error', () => {
    const rows: ClusterRow[] = [
      { id: 'a', stratum: 's1', n: 2, sum: 2 }, { id: 'b', stratum: 's1', n: 2, sum: -2 },
      { id: 'c', stratum: 's2', n: 4, sum: 8 }, { id: 'd', stratum: 's2', n: 4, sum: 0 },
    ];
    const { theta, se } = estimate(prepare(rows));
    expect(theta).toBeCloseTo(8 / 12, 12);
    // s1: mean 0, residuals 2 and -2; s2: mean 1, residuals 4 and -4; N = 12
    const v = (2 / 1) * (4 + 4) / 144 + (2 / 1) * (16 + 16) / 144;
    expect(se).toBeCloseTo(Math.sqrt(v), 12);
  });

  test('Student t quantiles match published values', () => {
    expect(studentTQuantile(0.95, 5)).toBeCloseTo(2.015048, 5);
    expect(studentTQuantile(0.95, 40)).toBeCloseTo(1.683851, 5);
    expect(studentTQuantile(0.8, 40)).toBeCloseTo(0.850700, 5);
    expect(studentTQuantile(0.05, 10)).toBeCloseTo(-1.812461, 5);
  });

  test('every bound method except the restricted wild test is location-equivariant', () => {
    const rng = (k: number) => Math.sin(k * 12.9898) * 43758.5453 % 1;
    const values = Array.from({ length: 12 }, (_, c) => Array.from({ length: 20 }, (_, q) => 100 * rng(c * 20 + q + 1)));
    const strata = values.map((_, c) => (c < 6 ? 'x' : 'y'));
    const shift = -3.25;
    const a = lowerBounds(prepare(rowsFrom(values, strata)), { alpha: 0.05, draws: 299, seed: 7 });
    const b = lowerBounds(prepare(rowsFrom(values.map(v => v.map(x => x + shift)), strata)), { alpha: 0.05, draws: 299, seed: 7 });
    for (const m of BOUND_METHODS) expect(b[m]).toBeCloseTo(a[m] + shift, 8);
    expect(b.theta).toBeCloseTo(a.theta + shift, 10);
  });

  test('the restricted wild test rejects a far null, keeps a null above the estimate, and its inverted bound sits near the others', () => {
    const values = Array.from({ length: 30 }, (_, c) => Array.from({ length: 20 }, (_, q) => ((c * 7 + q * 3) % 11) - 5 + (c % 3)));
    const p = prepare(rowsFrom(values, values.map((_, c) => (c % 2 ? 'x' : 'y'))));
    const { theta, se } = estimate(p);
    const [far, above] = wildRestrictedP(p, [theta - 10 * se, theta + se], { draws: 499, seed: 3, weights: 'webb' });
    expect(far).toBeLessThan(0.01);
    expect(above).toBeGreaterThan(0.5);
    const lb = wildRestrictedLowerBound(p, { alpha: 0.05, draws: 499, seed: 3, weights: 'rademacher' });
    const others = lowerBounds(p, { alpha: 0.05, draws: 499, seed: 3 });
    expect(Math.abs(lb - others.analytic)).toBeLessThan(0.5 * se);
  });

  test('decide maps bounds to the four preregistered outcomes and never to "tied"', () => {
    expect(decide(0.4, 3, 2)).toBe('ahead');
    expect(decide(-1.5, 1.2, 2)).toBe('non-inferior');
    expect(decide(-1.5, -0.2, 2)).toBe('non-inferior');
    expect(decide(-4, -0.5, 2)).toBe('behind');
    expect(decide(-2.5, 0.8, 2)).toBe('inconclusive');
    expect(decide(-2, 0.8, 2)).toBe('inconclusive');
    expect(() => decide(-1, 1, 0)).toThrow();
    expect(() => decide(1, -1, 2)).toThrow();
  });
});

describe('committed inputs from the pinned harness', () => {
  test('cluster counts match the datasets: 20 / 35 / 35 conversations, 20 personas over 37 histories, 10 users', () => {
    const s = (k: string) => clusterSpread(inputs.datasets[k].clusters);
    expect(s('beam/100k')).toMatchObject({ clusters: 20, questions: 400, questions_per_cluster: { min: 20, max: 20 } });
    expect(s('beam/500k')).toMatchObject({ clusters: 35, questions: 700, questions_per_cluster: { min: 20, max: 20 } });
    expect(s('beam/1m')).toMatchObject({ clusters: 35, questions: 700, questions_per_cluster: { min: 20, max: 20 } });
    expect(s('personamem/32k')).toMatchObject({ clusters: 20, histories: 37, questions: 589, histories_per_cluster: { min: 1, max: 2 } });
    expect(s('lifebench/en')).toMatchObject({ clusters: 10, histories: 10, questions: 2003 });
    for (const d of Object.values(inputs.datasets)) expect(d.provider).toBe('comparator');
  });

  test('graded BEAM scores stay in [0, 1] and binary datasets are 0/1', () => {
    for (const [k, d] of Object.entries(inputs.datasets)) {
      for (const c of d.clusters) for (const i of c.items) {
        expect(i.score).toBeGreaterThanOrEqual(0);
        expect(i.score).toBeLessThanOrEqual(1);
        if (d.metric === 'binary') expect([0, 1]).toContain(i.score);
      }
      expect(k.startsWith('beam/') ? d.metric : 'binary').toBe(d.metric);
    }
  });

  test('provider directories are labeled by name hash, so the lock and inputs never name a product', () => {
    const lock = { ...loadLock(join(ROOT, 'eval/data/memory-proof-wave/harness.lock.json')), comparator_output_dir_sha256: [sha256Hex('fixture-provider')] };
    expect(providerLabel('fixture-provider', lock)).toBe('comparator');
    expect(providerLabel('hybrid-search', lock)).toBe('baseline:hybrid-search');
    expect(providerLabel('someone-else', lock)).toBe(`other:${sha256Hex('someone-else').slice(0, 8)}`);
  });

  test('between-cluster SD is zero for identical clusters and recovers a planted spread', () => {
    const flat = Array.from({ length: 200 }, (_, i) => ({ cluster: `c${i % 10}`, d: Math.floor(i / 10) % 2 }));
    expect(betweenClusterSd(flat)).toBe(0);
    const planted = Array.from({ length: 2000 }, (_, i) => ({ cluster: `c${i % 10}`, d: (i % 10) < 5 ? 0.2 : -0.2 }));
    expect(betweenClusterSd(planted)).toBeCloseTo(100 * Math.sqrt(0.2 ** 2 * 10 / 9), 1);
    expect(betweenClusterSd(Array.from({ length: 5 }, (_, i) => ({ cluster: `q${i}`, d: 1 })))).toBeNull();
  });
});

describe('power simulation', () => {
  const sc = scenarios(inputs.analogs);

  test('the optimistic variance is gbrain\'s +23/-6 of 470 and the scenarios are ordered', () => {
    expect(GBRAIN_PAIRED_LME[0]).toMatchObject({ n: 470, plus: 23, minus: 6 });
    expect(sc.map(s => s.name)).toEqual(['optimistic', 'central', 'pessimistic']);
    expect(sc[0].diff_variance).toBeCloseTo(pairedVariance(470, 23, 6), 5);
    expect(sc[0].diff_variance).toBeLessThan(sc[1].diff_variance);
    expect(sc[1].diff_variance).toBeLessThan(sc[2].diff_variance);
    expect(sc[0].tau_points).toBe(0);
    expect(sc[1].tau_points).toBeLessThanOrEqual(sc[2].tau_points);
  });

  test('summary helpers', () => {
    const lbs = Float64Array.from([-3, -2.5, -1, -0.5, 0.5]);
    expect(coverage(lbs)).toBe(0.8);
    expect(powerAt(lbs, 0, 2)).toBe(0.6);
    expect(powerAt(lbs, 1, 2)).toBe(0.8);
    expect(minimumDetectableMargin(lbs, 0.8)).toBe(2.5);
    expect(interpolateDistance([0, 1, 2], [0.05, 0.5, 0.9], 0.8)).toBeCloseTo(1.75, 10);
    expect(interpolateDistance([0, 1], [0.05, 0.5], 0.8)).toBeNull();
  });

  test('a target variance above the independent-systems ceiling is capped and reported', () => {
    const d = DESIGNS[0];
    const pools = d.strata.map(s => poolStratum(inputs.datasets[s.key], s.key, s.sealed));
    const r = simulate(pools, { name: 'pessimistic', diff_variance: 0.5, tau_points: 0, source: 'test' }, d, { sims: 5, draws: 49, seed: 1, alpha: 0.05, distances: [0, 2], wild: [] });
    expect(r.capped_strata.sort()).toEqual(['beam/1m', 'beam/500k']);
    for (const p of pools) expect(r.effective_diff_variance[p.key]).toBeCloseTo(p.m2, 4);
  });

  test('the simulated standard error matches the closed form for the primary design', () => {
    const d = DESIGNS[0];
    const pools = d.strata.map(s => poolStratum(inputs.datasets[s.key], s.key, s.sealed));
    const central = sc[1];
    const r = simulate(pools, central, d, { sims: 300, draws: 99, seed: 11, alpha: 0.05, distances: [0], wild: [] });
    const mdm = minimumDetectableMargin(r.bounds.analytic);
    expect(Math.abs(mdm - approximateMdm(pools, central.diff_variance, central.tau_points)) / mdm).toBeLessThan(0.15);
  });

  // T-A2-3: one-sided 95% coverage of at least 93% at the real cluster counts.
  for (const id of ['lifebench-en-6', 'personamem-32k-12', 'beam-500k-21', 'beam-500k-1m-14-14-42']) {
    test(`coverage of the preregistered methods at ${id}`, () => {
      const d = DESIGNS.find(x => x.id === id)!;
      const pools = d.strata.map(s => poolStratum(inputs.datasets[s.key], s.key, s.sealed));
      const r = simulate(pools, sc[1], d, { sims: 400, draws: 199, seed: 20261005, alpha: 0.05, distances: DISTANCES, wild: ['webb'] });
      const s = summarize(r, d.label, [2], [0], DISTANCES);
      expect(s.methods.analytic.coverage).toBeGreaterThanOrEqual(0.93);
      expect(s.methods['wild-r-webb'].coverage).toBeGreaterThanOrEqual(0.93);
    }, 60_000);
  }
});

describe('name guard for this lane', () => {
  test('no word in the lane\'s files hashes to a comparator directory name', () => {
    const lock = loadLock(join(ROOT, 'eval/data/memory-proof-wave/harness.lock.json'));
    const banned = new Set(lock.comparator_output_dir_sha256);
    const files: string[] = [];
    const walk = (p: string) => { if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f)); else files.push(p); };
    for (const p of ['eval/runner/memory-proof-wave', 'eval/runner/memory-proof-wave-power.ts', 'eval/runner/memory-proof-wave-grouping.ts', 'eval/data/memory-proof-wave', 'docs/benchmarks/2026-10-05-memory-proof-wave-power', 'docs/benchmarks/2026-10-05-memory-proof-wave-power.md', 'docs/benchmarks/2026-10-05-memory-proof-wave-preregistration.md', 'test/eval/memory-proof-wave-power.test.ts', 'test/eval/memory-proof-wave-grouping.test.ts']) {
      try { walk(join(ROOT, p)); } catch { /* a file another lane has not written yet */ }
    }
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const words = new Set(readFileSync(f, 'utf8').toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []);
      for (const w of words) for (const part of [w, ...w.split('-')]) if (banned.has(sha256Hex(part))) throw new Error(`${f} contains a comparator product name`);
    }
  });
});
