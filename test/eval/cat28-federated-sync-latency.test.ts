/**
 * cat28-federated-sync-latency.ts regression tests (audit cats26-29-07/08/09).
 *
 * Hermetic: no API keys, no network (workload is importFromContent with
 * noEmbed: true).
 *
 * Gates proven failable AND passing:
 *   - the verdict can FAIL (import error / page-count mismatch) — the old
 *     runner had no verdict at all and always exited 0
 *   - the benchmark warms up, runs multiple repetitions, interleaves mode
 *     order, and reports percentile stats (metrics.ts) instead of a single
 *     serial-first sample
 *   - setup_ms is recorded per engine (the old runner measured then
 *     discarded it) and the receipt labels the measurement honestly as a
 *     single-thread microbenchmark, not worker-pool speedup
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CAT28_CATEGORY,
  computeVerdict,
  modeStats,
  runCat28,
  type PassResult,
} from '../../eval/runner/cat28-federated-sync-latency.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';

const RUN_TIMEOUT = 300_000;

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat28-test-reports-'));
}

function pass(overrides: Partial<PassResult> = {}): PassResult {
  return {
    mode: 'serial',
    rep: 0,
    order_in_rep: 0,
    wallclock_ms: 100,
    per_source_ms: [50, 50],
    setup_ms: [20],
    pages_verified: 4,
    pages_expected: 4,
    ok: true,
    ...overrides,
  };
}

// ─── Verdict: failable + passing ──────────────────────────────────────

describe('computeVerdict', () => {
  test('passes when every pass completed and verified its page count', () => {
    const passes = [pass(), pass({ mode: 'concurrent_single_thread', order_in_rep: 1 })];
    expect(computeVerdict(passes, 2)).toBe('pass');
  });

  test('FAILS on an errored pass (constructed bad input)', () => {
    const passes = [pass(), pass({ mode: 'concurrent_single_thread', ok: false, error: 'boom' })];
    expect(computeVerdict(passes, 2)).toBe('fail');
  });

  test('FAILS on a page-count mismatch even when the pass reported ok', () => {
    const passes = [pass({ pages_verified: 3, pages_expected: 4 })];
    expect(computeVerdict(passes, 1)).toBe('fail');
  });

  test('FAILS when planned passes are missing', () => {
    expect(computeVerdict([pass()], 4)).toBe('fail');
  });
});

// ─── Percentile stats over repetitions (cats26-29-08) ─────────────────

describe('modeStats', () => {
  test('median/p95 computed over ok passes only', () => {
    const passes = [
      pass({ wallclock_ms: 100 }),
      pass({ rep: 1, wallclock_ms: 300 }),
      pass({ rep: 2, wallclock_ms: 200 }),
      pass({ rep: 3, wallclock_ms: 99999, ok: false, error: 'excluded' }),
    ];
    const s = modeStats(passes, 'serial');
    expect(s.reps).toBe(3);
    expect(s.wallclock_ms_median).toBe(200);
    expect(s.wallclock_ms_p95).toBeLessThanOrEqual(300);
    expect(Number.isFinite(s.setup_ms_p50)).toBe(true);
  });

  test('empty mode yields NaN, never a fake 0', () => {
    expect(Number.isNaN(modeStats([], 'serial').wallclock_ms_median)).toBe(true);
  });
});

// ─── Hermetic end-to-end ──────────────────────────────────────────────

describe('runCat28 hermetic', () => {
  test('small run: warmup + interleaved reps + verified counts + valid receipt', async () => {
    const reportsDir = tmpReports();
    const r = await runCat28({ sources: 2, pagesPerSource: 2, reps: 2, reportsDir, quiet: true });

    expect(r.receipt.run_status).toBe('completed');
    expect(r.receipt.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.receipt.n_total).toBe(4); // 2 reps × 2 modes
    expect(r.receipt.n_scored).toBe(4);
    expect(r.receipt.errors).toEqual([]);

    // Interleaving: rep 0 runs serial first, rep 1 runs concurrent first.
    const rep0Serial = r.passes.find(p => p.rep === 0 && p.mode === 'serial');
    const rep1Serial = r.passes.find(p => p.rep === 1 && p.mode === 'serial');
    expect(rep0Serial?.order_in_rep).toBe(0);
    expect(rep1Serial?.order_in_rep).toBe(1);

    // Page counts verified per pass; setup_ms recorded (cats26-29-09).
    for (const p of r.passes) {
      expect(p.pages_verified).toBe(4);
      expect(p.setup_ms.length).toBeGreaterThan(0);
    }
    const concurrent = r.passes.filter(p => p.mode === 'concurrent_single_thread');
    expect(concurrent.every(p => p.setup_ms.length === 2)).toBe(true); // one engine per source

    // Honest labeling in the receipt (cats26-29-07 relabel).
    const data = r.receipt.data as Record<string, any>;
    expect(String(r.receipt.resolved_config?.threading)).toContain('single_event_loop_thread');
    expect(String(data.ratio_caveat)).toContain('not worker-pool speedup');
    expect(Number.isFinite(data.serial.wallclock_ms_median)).toBe(true);
    expect(Number.isFinite(data.concurrent_single_thread.wallclock_ms_median)).toBe(true);

    const loaded = loadReceipt(receiptPath(CAT28_CATEGORY, reportsDir));
    expect(loaded.category).toBe(CAT28_CATEGORY);
  }, RUN_TIMEOUT);

  test('import failure => sut error, verdict fail, non-zero exit (gate failable)', async () => {
    const reportsDir = tmpReports();
    const { importFromContent } = await import('gbrain/import-file');
    const r = await runCat28({
      sources: 2,
      pagesPerSource: 2,
      reps: 1,
      warmup: false,
      reportsDir,
      quiet: true,
      importFn: (engine, slug, body, opts) => {
        if (slug === 'people/src-1-p-1') throw new Error('forced import failure (test hook)');
        return importFromContent(engine, slug, body, opts);
      },
    });
    expect(r.receipt.verdict).toBe('fail');
    expect(r.exitCode).toBe(1);
    expect(r.receipt.errors.length).toBeGreaterThan(0);
    expect(r.receipt.errors.every(e => e.origin === 'sut')).toBe(true);
    expect(r.receipt.publishable).toBe(false); // injected importFn is never publishable
  }, RUN_TIMEOUT);
});
