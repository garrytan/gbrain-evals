/**
 * Regression tests for perf.ts (audit misc-runners-08/-09/-11/-12/-13):
 *
 *   - -08: workload selection is seeded — buildSlugPlan is deterministic per
 *     seed, and perf.ts contains no unseeded Math.random.
 *   - -09: percentiles come from metrics.ts (linear interpolation); p95 of a
 *     20-sample set is no longer the maximum sample.
 *   - -11: --scale is validated — missing value, non-numeric, zero/negative
 *     all throw a usage error; --scale=N (equals form) is accepted instead of
 *     silently falling back to the defaults.
 *   - -12: timeMany runs discarded warmup iterations before sampling.
 *   - -13: the p95 threshold is an enforced gate — evaluateThresholds marks
 *     the breach that main() turns into verdict fail + exit 1.
 *
 * Hermetic: no engine, no network — pure helpers only. The full runner is
 * executed separately as a CLI smoke against in-memory PGLite.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parsePerfArgs,
  buildSlugPlan,
  timeMany,
  evaluateThresholds,
  perfOutcome,
  mulberry32,
  generateSeedData,
  WARMUP_RUNS,
  DEFAULT_SEED,
  type LatencySample,
} from '../../eval/runner/perf.ts';

// ─── misc-runners-11: --scale validation ──────────────────────────────

describe('parsePerfArgs', () => {
  test('defaults: scales [1000, 10000], seed 42', () => {
    expect(parsePerfArgs([])).toEqual({ scales: [1000, 10000], seed: DEFAULT_SEED, json: false });
  });

  test('space form and equals form both parse', () => {
    expect(parsePerfArgs(['--scale', '5000']).scales).toEqual([5000]);
    expect(parsePerfArgs(['--scale=5000']).scales).toEqual([5000]);
    expect(parsePerfArgs(['--seed=7', '--json'])).toEqual({ scales: [1000, 10000], seed: 7, json: true });
  });

  test('CAN FAIL: missing value throws instead of producing NaN pages', () => {
    expect(() => parsePerfArgs(['--scale'])).toThrow(/positive integer/);
    expect(() => parsePerfArgs(['--scale', '--json'])).toThrow(/positive integer/);
  });

  test('CAN FAIL: non-numeric / non-positive / fractional values throw', () => {
    expect(() => parsePerfArgs(['--scale', 'abc'])).toThrow(/positive integer/);
    expect(() => parsePerfArgs(['--scale', '0'])).toThrow(/positive integer/);
    expect(() => parsePerfArgs(['--scale', '-5'])).toThrow(/positive integer/);
    expect(() => parsePerfArgs(['--scale=1.5'])).toThrow(/positive integer/);
  });

  test('unknown args are rejected with usage', () => {
    expect(() => parsePerfArgs(['--wat'])).toThrow(/unknown arg/);
  });
});

// ─── misc-runners-08: seeded workload ─────────────────────────────────

describe('seeded workload (buildSlugPlan)', () => {
  const slugs = Array.from({ length: 100 }, (_, i) => `people/person-${i}`);

  test('same seed → identical plan; different seed → different plan', () => {
    const a = buildSlugPlan(slugs, 42, 50);
    const b = buildSlugPlan(slugs, 42, 50);
    const c = buildSlugPlan(slugs, 43, 50);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBe(50);
    for (const s of a) expect(slugs).toContain(s);
  });

  test('empty slug list throws instead of indexing undefined', () => {
    expect(() => buildSlugPlan([], 42, 10)).toThrow(/empty slug list/);
  });

  test('mulberry32 stream is deterministic and in [0, 1)', () => {
    const r1 = mulberry32(7);
    const r2 = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      expect(v).toBe(r2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('perf.ts contains no unseeded Math.random call', () => {
    // Invocation form only — the header comment may NAME Math.random when
    // describing the audit finding this fixed.
    const src = readFileSync(join(import.meta.dir, '../../eval/runner/perf.ts'), 'utf8');
    expect(src).not.toContain('Math.random(');
  });
});

// ─── misc-runners-09 / -12: percentiles + warmup in timeMany ──────────

describe('timeMany', () => {
  test('runs discarded warmup iterations before sampling (misc-runners-12)', async () => {
    let calls = 0;
    const sample = await timeMany('op', 1000, async () => { calls++; }, 10);
    expect(calls).toBe(WARMUP_RUNS + 10);
    expect(sample.count).toBe(10);
  });

  test('warmup can be overridden (0 for tests)', async () => {
    let calls = 0;
    await timeMany('op', 1000, async () => { calls++; }, 5, 0);
    expect(calls).toBe(5);
  });

  test('CAN FAIL differently now: p95 of 20 samples is NOT the maximum (misc-runners-09)', async () => {
    // One pathological 1000ms outlier among 20 calls. Under the old
    // floor((p/100)*n) index, p95 at n=20 hit index 19 = the max sample.
    // Linear interpolation lands between ranks 18 and 19 — strictly below
    // the outlier when the rest of the distribution is fast.
    let i = 0;
    const delays = Array.from({ length: 20 }, (_, k) => (k === 19 ? 60 : 1));
    const sample = await timeMany('op', 1000, async () => {
      const d = delays[i++ % delays.length];
      await new Promise(res => setTimeout(res, d));
    }, 20, 0);
    expect(sample.p95_ms).toBeLessThan(55); // old code reported ~60 (the max)
    expect(sample.p50_ms).toBeLessThan(20);
  });
});

// ─── misc-runners-13: enforced threshold gate ─────────────────────────

describe('evaluateThresholds', () => {
  const fast: LatencySample = { op: 'search_keyword', scale: 10000, p50_ms: 5, p95_ms: 50, p99_ms: 80, count: 30 };
  const slow: LatencySample = { ...fast, p95_ms: 900 };

  test('passes under the limit', () => {
    const r = evaluateThresholds([fast]);
    expect(r).toEqual([
      { op: 'search_keyword', scale: 10000, metric: 'p95_ms', limit_ms: 200, actual_ms: 50, pass: true },
    ]);
  });

  test('CAN FAIL: breach is marked pass:false (main turns this into exit 1 + verdict fail)', () => {
    const r = evaluateThresholds([slow]);
    expect(r[0].pass).toBe(false);
    expect(r[0].actual_ms).toBe(900);
  });

  test('scales without a defined threshold evaluate zero thresholds (recorded, not silently passed)', () => {
    const smallScale: LatencySample = { ...fast, scale: 1000 };
    expect(evaluateThresholds([smallScale])).toEqual([]);
  });

  test('CAN FAIL end to end: perfOutcome maps a breach to verdict fail + exit 1 (misc-runners-13)', () => {
    const breach = perfOutcome([slow]);
    expect(breach.verdict).toBe('fail');
    expect(breach.exitCode).toBe(1);
    expect(breach.breaches.length).toBe(1);

    const ok = perfOutcome([fast]);
    expect(ok.verdict).toBe('pass');
    expect(ok.exitCode).toBe(0);
  });
});

// ─── Seed data sanity ─────────────────────────────────────────────────

describe('generateSeedData', () => {
  test('small scale produces the 60/20/10/10 split and hub links', () => {
    const { pages, links } = generateSeedData(100);
    expect(pages.length).toBe(100);
    expect(pages.filter(p => p.slug.startsWith('people/')).length).toBe(60);
    expect(pages.filter(p => p.slug.startsWith('companies/')).length).toBe(20);
    expect(links.length).toBeGreaterThan(0);
  });
});
