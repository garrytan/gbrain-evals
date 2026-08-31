/**
 * cat31-skillopt-ablation.ts regression tests (audit skillopt-cats-02/-05/-07).
 *
 * Hermetic: gate-logic tests inject fake runSkillOpt/scoreSkillOnTasks seams;
 * the end-to-end test runs the REAL orchestrator over gbrain's
 * __setChatTransportForTests seam (--stub-llm path) with a real PGLiteEngine.
 *
 * Gates proven failable AND passing:
 *   - skillopt-cats-02: an errored D_no_gate trial FAILS the gate instead of
 *     dragging D's mean to 0 and making `A >= D - eps` trivially true; errored
 *     trials are excluded from per-config means
 *   - skillopt-cats-05: the paired-bootstrap p-value is seeded/deterministic
 *   - the full gate still passes on clean, genuinely-lifting configs
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runCat31,
  computeCat31Gate,
  pairedBootstrapPValue,
  mulberry32,
  BOOTSTRAP_SEED,
  type TrialScore,
} from '../../eval/runner/cat31-skillopt-ablation.ts';

const RUN_TIMEOUT = 180_000;

const savedKey = process.env.ANTHROPIC_API_KEY;
beforeAll(() => { process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'dummy-test-key'; });
afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat31-test-reports-'));
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

const clean = (heldout: number, over: Partial<TrialScore> = {}): TrialScore =>
  ({ heldout, sel: 0.9, cost: 0.01, outcome: 'accepted', ...over });
const errored = (): TrialScore =>
  ({ heldout: null, sel: null, cost: 0, outcome: 'errored', error: 'boom', error_origin: 'sut' });

// ─── Seeded bootstrap (skillopt-cats-05) ─────────────────────────────

describe('pairedBootstrapPValue determinism', () => {
  test('same deltas + same seed → byte-identical p-value across runs', () => {
    const deltas = [0.1, -0.05, 0.2, 0.02, -0.01];
    const p1 = pairedBootstrapPValue(deltas, 2000, mulberry32(BOOTSTRAP_SEED));
    const p2 = pairedBootstrapPValue(deltas, 2000, mulberry32(BOOTSTRAP_SEED));
    expect(p1).toBe(p2);
  });

  test('mulberry32 stream is deterministic and seed-sensitive', () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });

  test('empty deltas → p=1 (never NaN)', () => {
    expect(pairedBootstrapPValue([], 100, mulberry32(1))).toBe(1);
  });
});

// ─── Gate (skillopt-cats-02) ─────────────────────────────────────────

describe('computeCat31Gate', () => {
  test('REGRESSION: an errored D_no_gate trial fails the gate (old code passed via D mean → 0)', () => {
    const byConfig = {
      A_full: [clean(0.9), clean(0.9)],
      B_single_reflect: [clean(0.85), clean(0.85)],
      C_one_shot: [clean(0.9), clean(0.9)],
      D_no_gate: [clean(0.9), errored()],
    };
    // Old behavior: errored → heldout 0 → mean D = 0.45 → A(0.9) >= 0.45 - 0.05
    // trivially true AND loopLifts true → PASS. New behavior: FAIL, named reason.
    const g = computeCat31Gate({ bpre: false, byConfig, seedHeldout: 0.1 });
    expect(g.gatePass).toBe(false);
    expect(g.reasons.some((r) => r.includes('D_no_gate') && r.includes('errored'))).toBe(true);
    // Errored trials are excluded from the clean means, not averaged as 0.
    expect(g.cleanMeans['D_no_gate']).toBeCloseTo(0.9, 6);
  });

  test('clean configs, real lift, gate free → pass', () => {
    const byConfig = {
      A_full: [clean(0.9), clean(0.9)],
      B_single_reflect: [clean(0.85), clean(0.85)],
      C_one_shot: [clean(0.9), clean(0.9)],
      D_no_gate: [clean(0.9), clean(0.88)],
    };
    const g = computeCat31Gate({ bpre: false, byConfig, seedHeldout: 0.1 });
    expect(g.gatePass).toBe(true);
    expect(g.reasons).toEqual([]);
  });

  test('gate still fails on the real conditions: no lift, or D beats A past epsilon', () => {
    const flat = {
      A_full: [clean(0.2)], B_single_reflect: [clean(0.2)],
      C_one_shot: [clean(0.2)], D_no_gate: [clean(0.2)],
    };
    expect(computeCat31Gate({ bpre: false, byConfig: flat, seedHeldout: 0.1 }).gatePass).toBe(false);
    const dWins = {
      A_full: [clean(0.6)], B_single_reflect: [clean(0.6)],
      C_one_shot: [clean(0.6)], D_no_gate: [clean(0.9)],
    };
    expect(computeCat31Gate({ bpre: false, byConfig: dWins, seedHeldout: 0.1 }).gatePass).toBe(false);
  });

  test('B-pre: errored/aborted A trial fails validity; clean passes', () => {
    expect(computeCat31Gate({ bpre: true, byConfig: { A_full: [errored()] }, seedHeldout: 0 }).gatePass).toBe(false);
    expect(computeCat31Gate({ bpre: true, byConfig: { A_full: [clean(0.9, { outcome: 'aborted' })] }, seedHeldout: 0 }).gatePass).toBe(false);
    expect(computeCat31Gate({ bpre: true, byConfig: { A_full: [clean(0.9)] }, seedHeldout: 0 }).gatePass).toBe(true);
    expect(computeCat31Gate({ bpre: true, byConfig: {}, seedHeldout: 0 }).gatePass).toBe(false);
  });
});

// ─── Runner with injected seams ───────────────────────────────────────

describe('runCat31 error accounting', () => {
  const MARKER = 'STUB-OPTIMIZED-MARKER';
  const scoreByMarker = (async (opts: any) => (opts.skillText.includes(MARKER) ? 0.9 : 0.1)) as any;
  const goodRunSkillOpt = (async () => ({
    outcome: 'accepted',
    finalText: `optimized\n${MARKER}`,
    receipt: { best_sel_score: 1, final_cost_usd: 0.01 },
    mutatedSkillFile: true,
  })) as any;

  test('runSkillOpt crash on the D_no_gate arm → sut error, verdict fail, exit 1', async () => {
    const failOnNoGate = (async (opts: any) => {
      if (opts.disableValidationGate === true) throw new Error('forced D crash');
      return goodRunSkillOpt(opts);
    }) as any;
    const r = await runCat31({
      bpre: false,
      trials: 1,
      reportsDir: tmpReports(),
      quiet: true,
      engineFactory: async () => fakeEngine(),
      runSkillOptFn: failOnNoGate,
      scoreFn: scoreByMarker,
    });
    expect(r.exitCode).toBe(1);
    expect(r.receipt.verdict).toBe('fail');
    expect(r.receipt.errors.some((e) => e.origin === 'sut' && e.probe_id.startsWith('D_no_gate'))).toBe(true);
    expect(r.byConfig['D_no_gate']![0]!.error).toContain('forced D crash');
    // A/B/C means are unaffected by the crash — no zeros averaged in anywhere.
    expect((r.receipt.data as any).configs['A_full'].mean_heldout_clean).toBeCloseTo(0.9, 6);
  }, RUN_TIMEOUT);

  test('clean seams → verdict pass, exit 0, bootstrap seed recorded in receipt', async () => {
    const r = await runCat31({
      bpre: false,
      trials: 1,
      reportsDir: tmpReports(),
      quiet: true,
      engineFactory: async () => fakeEngine(),
      runSkillOptFn: goodRunSkillOpt,
      scoreFn: scoreByMarker,
    });
    expect(r.exitCode).toBe(0);
    expect(r.receipt.verdict).toBe('pass');
    expect((r.receipt.resolved_config as any).bootstrap_seed).toBe(BOOTSTRAP_SEED);
    expect((r.receipt.data as any).paired_bootstrap_p_A_vs_C).toBeDefined();
    expect(r.receipt.gbrain_version).toMatch(/^\d+\.\d+\.\d+/);
  }, RUN_TIMEOUT);

  test('missing key → skipped receipt, exit 1 unless allowSkip', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r1 = await runCat31({ reportsDir: tmpReports(), quiet: true });
      expect(r1.receipt.run_status).toBe('skipped');
      expect(r1.exitCode).toBe(1);
      const r2 = await runCat31({ reportsDir: tmpReports(), quiet: true, allowSkip: true });
      expect(r2.exitCode).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  }, RUN_TIMEOUT);
});

// ─── End-to-end: REAL runSkillOpt over the stub transport ─────────────

describe('runCat31 end-to-end (stub transport, real orchestrator)', () => {
  test('B-pre stub run: config A runs end-to-end, gate passes, never publishable', async () => {
    const r = await runCat31({
      bpre: true,
      stubLlm: true,
      reportsDir: tmpReports(),
      quiet: true,
    });
    expect(r.receipt.run_status).toBe('completed');
    expect(r.receipt.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.receipt.publishable).toBe(false);
    const a = r.byConfig['A_full']![0]!;
    expect(a.outcome).toBe('accepted');
    expect(a.heldout!).toBeGreaterThan(0.8);
  }, RUN_TIMEOUT);
});
