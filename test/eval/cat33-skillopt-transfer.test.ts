/**
 * cat33-skillopt-transfer.ts regression tests (audit skillopt-cats-01/-03).
 *
 * Hermetic: gate-logic tests inject fake runSkillOpt/scoreSkillOnTasks seams;
 * the end-to-end test runs the REAL orchestrator over gbrain's
 * __setChatTransportForTests seam (--stub-llm path) with a real PGLiteEngine.
 *
 * Gates proven failable AND passing:
 *   - skillopt-cats-01: PairResult.error is now wired — an optimizeOn failure
 *     (throw OR outcome 'errored') fails the B-pre validity gate + exits 1
 *   - skillopt-cats-03: the documented "within a band of Y-optimized" clause
 *     is implemented — positive lift with ratio < 0.5 is NOT transferred;
 *     transfer_ratio is null (never ~500000) when the ceiling lift is inside
 *     noise
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runCat33,
  computeTransfer,
  computeCat33Gate,
  MARGIN,
  RATIO_BAND,
  type PairResult,
} from '../../eval/runner/cat33-skillopt-transfer.ts';

const RUN_TIMEOUT = 180_000;

const savedKey = process.env.ANTHROPIC_API_KEY;
beforeAll(() => { process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'dummy-test-key'; });
afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat33-test-reports-'));
}

function fakeEngine(): any {
  const configs: Record<string, string> = {};
  return {
    kind: 'pglite',
    connect: async () => {},
    initSchema: async () => {},
    setConfig: async (k: string, v: string) => { configs[k] = v; },
    getConfig: async (k: string) => configs[k] ?? null,
    disconnect: async () => {},
    __configs: configs,
  };
}

const MARKER = 'STUB-OPTIMIZED-MARKER';
const goodRunSkillOpt = (async (opts: any) => ({
  outcome: 'accepted',
  finalText: `optimized skill\n${MARKER}\n(target ${opts.targetModel})`,
  receipt: { best_sel_score: 1, final_cost_usd: 0.01 },
  mutatedSkillFile: true,
})) as any;
const scoreByMarker = (async (opts: any) => (opts.skillText.includes(MARKER) ? 0.9 : 0.1)) as any;

// ─── computeTransfer (skillopt-cats-03) ───────────────────────────────

describe('computeTransfer', () => {
  test('ratio is null (not ~500000) when the ceiling lift is inside noise', () => {
    // Old code: denom clamped to 1e-6 → ratio 0.5/1e-6 = 500000 in the receipt.
    const m = computeTransfer(0.4, 0.9, 0.4);
    expect(m.transfer_ratio).toBeNull();
    // Band falls back to the absolute check: X-opt at/above ceiling - MARGIN.
    expect(m.band_ok).toBe(true);
    expect(m.transferred).toBe(true);
  });

  test('flat ceiling + X-opt below it → not transferred', () => {
    const m = computeTransfer(0.4, 0.3, 0.44); // ceiling lift 0.04 <= MARGIN
    expect(m.transfer_ratio).toBeNull();
    expect(m.band_ok).toBe(false);
    expect(m.transferred).toBe(false);
  });

  test('documented band clause enforced: positive lift but ratio < band is NOT a transfer', () => {
    // Old gate: lift 0.3 > MARGIN → transferred. New: ratio 0.3 < 0.5 → not.
    const m = computeTransfer(0, 0.3, 1.0);
    expect(m.transfer_lift).toBeCloseTo(0.3, 6);
    expect(m.transfer_ratio).toBeCloseTo(0.3, 6);
    expect(m.band_ok).toBe(false);
    expect(m.transferred).toBe(false);
  });

  test('good transfer: lift over margin AND within the band of the ceiling', () => {
    const m = computeTransfer(0, 0.9, 1.0);
    expect(m.transfer_ratio).toBeCloseTo(0.9, 6);
    expect(m.band_ok).toBe(true);
    expect(m.transferred).toBe(true);
    expect(RATIO_BAND).toBeGreaterThan(0);
    expect(MARGIN).toBeGreaterThan(0);
  });
});

// ─── computeCat33Gate (skillopt-cats-01) ─────────────────────────────

describe('computeCat33Gate', () => {
  const pair = (over: Partial<PairResult> = {}): PairResult => ({
    seed: 's', x: 'mx', y: 'my', seed_on_y: 0.1, xopt_on_y: 0.9, yopt_on_y: 0.95,
    transfer_lift: 0.8, transfer_ratio: 0.94, band_ok: true, transferred: true,
    cost_usd: 0, x_outcome: 'accepted', y_outcome: 'accepted', ...over,
  });

  test('B-pre FAILS on error / errored / aborted outcomes (previously vacuously true)', () => {
    expect(computeCat33Gate([pair({ error: 'boom', error_origin: 'sut' })], true)).toBe(false);
    expect(computeCat33Gate([pair({ x_outcome: 'errored' })], true)).toBe(false);
    expect(computeCat33Gate([pair({ x_outcome: 'aborted' })], true)).toBe(false);
    expect(computeCat33Gate([pair({ y_outcome: 'errored' })], true)).toBe(false);
  });

  test('B-pre passes on clean outcomes (skipped_bpre ceiling allowed)', () => {
    expect(computeCat33Gate([pair()], true)).toBe(true);
    expect(computeCat33Gate([pair({ y_outcome: 'skipped_bpre' })], true)).toBe(true);
    expect(computeCat33Gate([], true)).toBe(false);
  });

  test('full mode: sut-errored pairs stay in the denominator as not-transferred', () => {
    expect(computeCat33Gate([
      pair(), pair(), pair(),
      pair({ transferred: false, error: 'x', error_origin: 'sut', x_outcome: 'errored' }),
    ], false)).toBe(true); // 3/4 >= ceil(0.75*4)=3
    expect(computeCat33Gate([
      pair(), pair(),
      pair({ transferred: false, error: 'x', error_origin: 'sut', x_outcome: 'errored' }),
      pair({ transferred: false, error: 'x', error_origin: 'sut', x_outcome: 'errored' }),
    ], false)).toBe(false); // 2/4 < 3
  });
});

// ─── Runner with injected seams (skillopt-cats-01 end-to-end wiring) ──

describe('runCat33 error propagation', () => {
  test('optimizeOn throw → PairResult.error set, sut origin recorded, B-pre gate FAILS, exit 1', async () => {
    const r = await runCat33({
      bpre: true,
      reportsDir: tmpReports(),
      quiet: true,
      engineFactory: async () => fakeEngine(),
      runSkillOptFn: (async () => { throw new Error('forced optimizer crash'); }) as any,
      scoreFn: scoreByMarker,
    });
    expect(r.exitCode).toBe(1);
    expect(r.receipt.verdict).toBe('fail');
    const p = r.results[0]!;
    expect(p.error).toContain('forced optimizer crash');
    expect(p.error_origin).toBe('sut');
    expect(p.x_outcome).toBe('errored');
    expect(r.receipt.errors.some((e) => e.origin === 'sut')).toBe(true);
  }, RUN_TIMEOUT);

  test('outcome errored (no throw) → B-pre gate FAILS too', async () => {
    const r = await runCat33({
      bpre: true,
      reportsDir: tmpReports(),
      quiet: true,
      engineFactory: async () => fakeEngine(),
      runSkillOptFn: (async (opts: any) => ({
        outcome: 'errored', finalText: undefined, receipt: {}, mutatedSkillFile: false, skillName: opts.skillName,
      })) as any,
      scoreFn: scoreByMarker,
    });
    expect(r.exitCode).toBe(1);
    expect(r.receipt.verdict).toBe('fail');
    expect(r.results[0]!.error).toBeTruthy();
  }, RUN_TIMEOUT);

  test('clean seams → B-pre gate passes, exit 0, transfer_ratio finite or null in receipt', async () => {
    const r = await runCat33({
      bpre: true,
      reportsDir: tmpReports(),
      quiet: true,
      engineFactory: async () => fakeEngine(),
      runSkillOptFn: goodRunSkillOpt,
      scoreFn: scoreByMarker,
    });
    expect(r.exitCode).toBe(0);
    expect(r.receipt.verdict).toBe('pass');
    const p = r.results[0]!;
    expect(p.error).toBeUndefined();
    if (p.transfer_ratio !== null) {
      expect(Math.abs(p.transfer_ratio)).toBeLessThan(100); // never a 1e-6-denominator artifact
    }
    expect(r.receipt.gbrain_version).toMatch(/^\d+\.\d+\.\d+/);
  }, RUN_TIMEOUT);

  test('scoring failure on Y → dependency origin, pair excluded from gate denominator', async () => {
    const r = await runCat33({
      bpre: false,
      seeds: ['seed-missing-structure'],
      pairs: [{ x: 'anthropic:claude-haiku-4-5', y: 'anthropic:claude-sonnet-4-6' }],
      reportsDir: tmpReports(),
      quiet: true,
      engineFactory: async () => fakeEngine(),
      runSkillOptFn: goodRunSkillOpt,
      scoreFn: (async () => { throw new Error('scoring outage'); }) as any,
    });
    expect(r.exitCode).toBe(1); // zero scored pairs = fail, never a silent pass
    expect(r.receipt.errors.some((e) => e.origin === 'dependency')).toBe(true);
    expect(r.receipt.n_scored).toBe(0);
    expect((r.receipt.data as any).pairs_scored).toBe(0);
  }, RUN_TIMEOUT);
});

// ─── End-to-end: REAL runSkillOpt over the stub transport ─────────────

describe('runCat33 end-to-end (stub transport, real orchestrator)', () => {
  test('B-pre stub run: optimize on X transfers to Y hermetically, gate passes', async () => {
    const r = await runCat33({
      bpre: true,
      stubLlm: true,
      reportsDir: tmpReports(),
      quiet: true,
    });
    expect(r.receipt.run_status).toBe('completed');
    expect(r.receipt.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.receipt.publishable).toBe(false);
    const p = r.results[0]!;
    expect(p.x_outcome).toBe('accepted');
    expect(p.y_outcome).toBe('skipped_bpre');
    expect(p.seed_on_y!).toBeLessThan(0.5);
    expect(p.xopt_on_y!).toBeGreaterThan(0.8);
  }, RUN_TIMEOUT);
});
