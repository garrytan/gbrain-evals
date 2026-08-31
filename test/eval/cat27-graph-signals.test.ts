/**
 * cat27-graph-signals.ts regression tests (audit cats26-29-03/04/05/06/17).
 *
 * Hermetic: no API keys. Embeds run through gbrain's
 * __setEmbedTransportForTests seam with a deterministic feature-hash
 * transport + dummy OPENAI_API_KEY (the runner installs both itself).
 *
 * Gates proven failable AND passing:
 *   - the verdict/exit gate can FAIL (regressing aggregate, sut errors,
 *     empty scorecard) — the pre-audit runner always exited 0, even when
 *     every probe crashed into an empty scorecard
 *   - probe errors land in the receipt via probe-accounting (origin 'sut',
 *     scored 0, kept in the denominator) instead of vanishing
 *   - nDCG is computed on page-normalized unique slug lists (duplicate
 *     chunk rows can no longer push nDCG past 1.0)
 *   - a keyless end-to-end run completes with every probe scored (the old
 *     header claimed hermetic while requiring OPENAI_API_KEY)
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  PROBES,
  PINNED_CONFIG,
  CAT27_CATEGORY,
  scoreSlugs,
  aggregate,
  computeVerdict,
  runCat27,
  type ProbeResult,
} from '../../eval/runner/cat27-graph-signals.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';

const RUN_TIMEOUT = 240_000;

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat27-test-reports-'));
}

function probeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    probe_id: 'p',
    family: 'adjacency',
    query: 'q',
    top1_baseline: 'a',
    top1_with_signals: 'a',
    top1_correct_baseline: true,
    top1_correct_with_signals: true,
    ndcg10_baseline: 1,
    ndcg10_with_signals: 1,
    ndcg_delta: 0,
    ...overrides,
  };
}

// ─── nDCG duplicate-chunk normalization (cats26-29-04) ────────────────

describe('scoreSlugs', () => {
  test('duplicate slugs collapse to first occurrence — nDCG cannot exceed 1.0', () => {
    // gbrain dedup allows up to 2 chunks/page: a gold page at raw ranks 1
    // AND 2 scored dcg([1,1])/dcg([1]) = 1.63 under the old local nDCG.
    const s = scoreSlugs(['gold', 'gold', 'x'], ['gold']);
    expect(s.ndcg10).toBe(1);
    expect(s.top1).toBe('gold');
  });

  test('miss scores 0, later hit is discounted', () => {
    expect(scoreSlugs(['x', 'y'], ['gold']).ndcg10).toBe(0);
    const second = scoreSlugs(['x', 'gold'], ['gold']).ndcg10;
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(1);
  });
});

// ─── Verdict gate: failable + passing (cats26-29-03/05) ───────────────

describe('computeVerdict', () => {
  test('passes on non-regressing aggregates with all probes scored', () => {
    const rows = [probeResult(), probeResult({ probe_id: 'p2', ndcg_delta: 0.2, ndcg10_baseline: 0.5, ndcg10_with_signals: 0.7 })];
    expect(computeVerdict(aggregate(rows), 0, 2)).toBe('pass');
  });

  test('FAILS when the wave regresses mean nDCG (constructed bad input)', () => {
    const rows = [probeResult({ ndcg10_baseline: 1, ndcg10_with_signals: 0.5, ndcg_delta: -0.5 })];
    expect(computeVerdict(aggregate(rows), 0, 1)).toBe('fail');
  });

  test('FAILS when the wave regresses top-1 hit rate', () => {
    const rows = [probeResult({ top1_correct_baseline: true, top1_correct_with_signals: false })];
    expect(computeVerdict(aggregate(rows), 0, 1)).toBe('fail');
  });

  test('FAILS on sut errors even when scored probes look fine', () => {
    expect(computeVerdict(aggregate([probeResult()]), 1, 2)).toBe('fail');
  });

  test('FAILS on an empty scorecard (the pre-audit always-exit-0 case)', () => {
    expect(computeVerdict(aggregate([]), 0, 4)).toBe('fail');
  });

  test('FAILS when fewer probes scored than planned', () => {
    expect(computeVerdict(aggregate([probeResult()]), 0, 4)).toBe('fail');
  });
});

// ─── Per-family breakdown (cats26-29-17) ──────────────────────────────

describe('aggregate by_family', () => {
  test('groups probes per signal family so one family cannot mask another', () => {
    const rows = [
      probeResult({ probe_id: 'a1', family: 'adjacency', ndcg10_with_signals: 1 }),
      probeResult({ probe_id: 's1', family: 'session', top1_correct_with_signals: false, ndcg10_with_signals: 0.3, ndcg10_baseline: 0.5, ndcg_delta: -0.2 }),
    ];
    const agg = aggregate(rows);
    const session = agg.by_family.find(f => f.family === 'session');
    expect(agg.by_family.length).toBe(2);
    expect(session?.top1_hits_with_signals).toBe(0);
    expect(session?.mean_ndcg10_with_signals).toBeCloseTo(0.3, 6);
  });
});

// ─── Hermetic end-to-end (cats26-29-03/05/06) ─────────────────────────

describe('runCat27 hermetic', () => {
  test('keyless run scores every probe and writes a valid receipt with pinned config', async () => {
    const reportsDir = tmpReports();
    const subset = PROBES.filter(p =>
      p.id === 'adjacency-close-hub-foundry' || p.id === 'session-demote-chat-spam');
    const r = await runCat27({ probes: subset, reportsDir, quiet: true });

    expect(r.receipt.run_status).toBe('completed');
    expect(r.receipt.n_total).toBe(2);
    expect(r.receipt.n_scored).toBe(2);
    expect(r.receipt.errors).toEqual([]);
    // WS5 pins echoed into resolved_config
    for (const [k, v] of Object.entries(PINNED_CONFIG)) {
      expect(r.receipt.resolved_config?.[k]).toBe(v);
    }
    expect(r.receipt.resolved_config?.embed_transport).toBe('stubbed-hash');
    // exit code is consistent with the verdict
    expect(r.exitCode).toBe(r.receipt.verdict === 'pass' ? 0 : 1);
    // receipt on disk round-trips validation
    const loaded = loadReceipt(receiptPath(CAT27_CATEGORY, reportsDir));
    expect(loaded.category).toBe(CAT27_CATEGORY);
    // subset run is never publishable
    expect(r.receipt.publishable).toBe(false);
    // scores are sane
    for (const row of r.results) {
      expect(row.ndcg10_baseline).toBeGreaterThanOrEqual(0);
      expect(row.ndcg10_baseline).toBeLessThanOrEqual(1);
      expect(row.ndcg10_with_signals).toBeLessThanOrEqual(1);
    }
  }, RUN_TIMEOUT);

  test('embed failure => sut errors in receipt, verdict fail, non-zero exit (gate failable)', async () => {
    const reportsDir = tmpReports();
    const subset = PROBES.filter(p => p.id === 'session-demote-chat-spam');
    const r = await runCat27({
      probes: subset,
      reportsDir,
      quiet: true,
      stubFailOn: () => true, // every embed call blows up ⇒ seedBrain throws
    });
    expect(r.receipt.run_status).toBe('completed');
    expect(r.receipt.verdict).toBe('fail');
    expect(r.exitCode).toBe(1);
    expect(r.receipt.errors.length).toBe(1);
    expect(r.receipt.errors[0].origin).toBe('sut');
    // sut failure stays in the denominator (scored 0), never dropped
    expect(r.receipt.n_total).toBe(1);
    expect(r.receipt.n_scored).toBe(1);
    expect(r.receipt.publishable).toBe(false);
  }, RUN_TIMEOUT);
});
