/**
 * cat30-skillopt-improvement.ts regression tests (audit skillopt-cats-06/-08
 * + WS0 receipt/accounting conversion).
 *
 * Hermetic: no API keys leave the process. Gate-logic tests inject fake
 * runSkillOpt/scoreSkillOnTasks seams (no engine, no LLM). The end-to-end
 * test runs the REAL runSkillOpt + scoreSkillOnTasks against gbrain's
 * __setChatTransportForTests seam (cat30 --stub-llm path) with a real
 * PGLiteEngine (the skillopt DB lock needs engine.kind).
 *
 * Gates proven failable AND passing:
 *   - full-mode gate fails when the optimizer errors (sut origin recorded)
 *   - B-pre gate fails when the seed does NOT fail at baseline (>= 0.95)
 *   - B-pre gate fails on outcome 'errored' even when nothing throws
 *   - missing ANTHROPIC_API_KEY → run_status 'skipped' + non-zero exit
 *     unless allowSkip
 *   - receipt gbrain_version is a real semver, never 'unknown' (cats-06)
 *   - isolated GBRAIN_HOME temp dirs are cleaned up (cats-08)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runCat30,
  computeCat30Gate,
  CAT30_CATEGORY,
  type SeedResult,
} from '../../eval/runner/cat30-skillopt-improvement.ts';

const RUN_TIMEOUT = 180_000;

const savedKey = process.env.ANTHROPIC_API_KEY;
beforeAll(() => { process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'dummy-test-key'; });
afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat30-test-reports-'));
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

/** Fake seams: scoreFn scores by a marker in the skill text; runSkillOptFn appends it. */
const MARKER = 'STUB-OPTIMIZED-MARKER';
const goodRunSkillOpt = (async (opts: any) => ({
  outcome: 'accepted',
  finalText: `optimized skill\n${MARKER}\n(${opts.skillName})`,
  receipt: { best_sel_score: 1, baseline_sel_score: 0, final_cost_usd: 0.01 },
  mutatedSkillFile: true,
})) as any;
const scoreByMarker = (async (opts: any) => (opts.skillText.includes(MARKER) ? 0.9 : 0.1)) as any;

// ─── computeCat30Gate (pure) ─────────────────────────────────────────

describe('computeCat30Gate', () => {
  const ok = (seed: string, over: Partial<SeedResult> = {}): SeedResult => ({
    seed, baseline_heldout: 0.1, optimized_heldout: 0.9, delta: 0.8,
    outcome: 'accepted', improved: true, ...over,
  });

  test('B-pre fails when the optimizer errored (previously only cat33 was unfailable, keep cat30 pinned too)', () => {
    expect(computeCat30Gate([ok('s', { outcome: 'errored', error: 'boom', improved: false })], true)).toBe(false);
  });

  test('B-pre fails when the seed does not fail at baseline', () => {
    expect(computeCat30Gate([ok('s', { baseline_heldout: 0.96 })], true)).toBe(false);
    expect(computeCat30Gate([ok('s', { baseline_heldout: 0.5 })], true)).toBe(true);
  });

  test('full mode: dependency-errored seeds leave the denominator; sut-errored stay', () => {
    // 3 improved + 1 dependency-excluded = 3/3 scored → pass
    expect(computeCat30Gate([
      ok('a'), ok('b'), ok('c'),
      ok('d', { improved: false, error: 'x', error_origin: 'dependency' }),
    ], false)).toBe(true);
    // 3 improved + 1 sut-errored = 3/4 scored → ceil(0.75*4)=3 → pass; 2/4 → fail
    expect(computeCat30Gate([
      ok('a'), ok('b'), ok('c', { improved: false, error: 'x', error_origin: 'sut' }),
      ok('d', { improved: false, error: 'x', error_origin: 'sut' }),
    ], false)).toBe(false);
    expect(computeCat30Gate([], false)).toBe(false);
  });
});

// ─── Runner with injected seams (hermetic, no engine) ─────────────────

describe('runCat30 gate wiring', () => {
  test('optimizer throw → sut error recorded, verdict fail, exit 1', async () => {
    const r = await runCat30({
      seeds: ['seed-missing-structure'],
      reportsDir: tmpReports(),
      quiet: true,
      engineFactory: async () => fakeEngine(),
      runSkillOptFn: (async () => { throw new Error('forced optimizer crash'); }) as any,
      scoreFn: scoreByMarker,
    });
    expect(r.exitCode).toBe(1);
    expect(r.receipt.run_status).toBe('completed');
    expect(r.receipt.verdict).toBe('fail');
    expect(r.receipt.errors.some((e) => e.origin === 'sut' && e.message.includes('forced optimizer crash'))).toBe(true);
    // SUT failure stays in the denominator, scored 0.
    expect(r.receipt.n_scored).toBe(1);
  }, RUN_TIMEOUT);

  test('good seams → verdict pass, exit 0, receipt carries pinned config + semver gbrain_version', async () => {
    const engine = fakeEngine();
    const r = await runCat30({
      seeds: ['seed-missing-structure'],
      reportsDir: tmpReports(),
      quiet: true,
      engineFactory: async () => engine,
      runSkillOptFn: goodRunSkillOpt,
      scoreFn: scoreByMarker,
    });
    expect(r.exitCode).toBe(0);
    expect(r.receipt.verdict).toBe('pass');
    expect(r.results[0]!.improved).toBe(true);
    // skillopt-cats-06: never 'unknown' again.
    expect(r.receipt.gbrain_version).toMatch(/^\d+\.\d+\.\d+/);
    // WS5 pin applied via engine.setConfig BEFORE any rollout + echoed.
    expect(engine.__configs['search.mode']).toBe('balanced');
    expect(engine.__configs['search.reranker.enabled']).toBe('false');
    const rc = r.receipt.resolved_config as any;
    expect(rc.search_mode).toBe('balanced');
    expect(rc.reranker_enabled).toBe(false);
  }, RUN_TIMEOUT);

  test('skillopt-cats-08: isolated GBRAIN_HOME temp dir is removed after the run', async () => {
    await runCat30({
      seeds: ['seed-missing-structure'],
      reportsDir: tmpReports(),
      quiet: true,
      engineFactory: async () => fakeEngine(),
      runSkillOptFn: goodRunSkillOpt,
      scoreFn: scoreByMarker,
    });
    const leftovers = readdirSync(tmpdir()).filter((d) => d.startsWith('cat30-gbrain-home-'));
    expect(leftovers).toEqual([]);
  }, RUN_TIMEOUT);

  test('missing key → skipped receipt, exit 1 (0 only with allowSkip)', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r1 = await runCat30({ reportsDir: tmpReports(), quiet: true });
      expect(r1.receipt.run_status).toBe('skipped');
      expect(r1.receipt.skip_reason).toContain('ANTHROPIC_API_KEY');
      expect(r1.exitCode).toBe(1);
      const r2 = await runCat30({ reportsDir: tmpReports(), quiet: true, allowSkip: true });
      expect(r2.exitCode).toBe(0);
      expect(r2.receipt.run_status).toBe('skipped');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  }, RUN_TIMEOUT);
});

// ─── End-to-end: REAL runSkillOpt + scoreSkillOnTasks over the stub transport ─

describe('runCat30 end-to-end (stub transport, real orchestrator)', () => {
  test('B-pre stub run: pipeline improves the seed and the gate passes; stub runs are never publishable', async () => {
    const r = await runCat30({
      bpre: true,
      stubLlm: true,
      reportsDir: tmpReports(),
      quiet: true,
    });
    expect(r.receipt.run_status).toBe('completed');
    expect(r.receipt.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.receipt.publishable).toBe(false);
    expect((r.receipt.resolved_config as any).llm_transport).toBe('stubbed-obedient');
    expect(r.receipt.category).toBe(CAT30_CATEGORY);
    const seed = r.results[0]!;
    // The deficient seed FAILS at baseline and the real optimizer loop fixes it
    // (degraded configuration <= 0.5x the optimized one on the fixed corpus).
    expect(seed.baseline_heldout!).toBeLessThan(0.5);
    expect(seed.optimized_heldout!).toBeGreaterThan(0.8);
    expect(seed.baseline_heldout!).toBeLessThanOrEqual(0.5 * seed.optimized_heldout!);
    expect(seed.outcome).toBe('accepted');
  }, RUN_TIMEOUT);

  test('B-pre stub run with failing rollouts: gate FAILS (proves B-pre is failable end-to-end)', async () => {
    const r = await runCat30({
      bpre: true,
      stubLlm: true,
      stubBehavior: { failRollouts: true },
      reportsDir: tmpReports(),
      quiet: true,
    });
    expect(r.receipt.verdict).toBe('fail');
    expect(r.exitCode).toBe(1);
    // Must-abort rollout failure surfaces via scoreSkillOnTasks → dependency origin.
    expect(r.receipt.errors.length).toBeGreaterThan(0);
    expect(r.results[0]!.error).toBeTruthy();
  }, RUN_TIMEOUT);
});
