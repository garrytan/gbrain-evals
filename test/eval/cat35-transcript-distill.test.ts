/**
 * cat35-transcript-distill.ts runner tests: $0, no network.
 *
 * Covers the aggregation and receipt contract that the import.meta.main
 * guard makes importable:
 *   - JUDGE_FAILED rows are unknown, excluded from every coverage aggregate
 *     with the excluded count reported (audit PC-03)
 *   - the evidence-verified joint macro is reported next to the judge-only
 *     macro with the same seeded bootstrap interval (audit PC-01)
 *   - recomputation from the committed receipts reproduces the published
 *     judge-only macros and the audit's joint and exclusion numbers
 *   - the WS0 receipt: skipped + exit 0 on missing keys, publishable only in
 *     full mode (audit PC-09)
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  aggregateCoverage,
  completedWs0Receipt,
  errorWs0Receipt,
  skippedWs0Receipt,
  type PerItemRow,
} from '../../eval/runner/cat35-transcript-distill.ts';
import { bootstrapCI } from '../../eval/runner/cat35-checks.ts';
import { loadReceipt, validateReceipt } from '../../eval/runner/receipt.ts';

function item(transcript_id: string, lane: PerItemRow['lane'], status: PerItemRow['status'], joint: number | null, extra: Partial<PerItemRow> = {}): PerItemRow {
  return { transcript_id, lane, item_id: `${transcript_id}-${Math.random()}`, kind: 'fact', notability: 'high', depth_bucket: 'early', status, joint, ...extra };
}

describe('aggregateCoverage', () => {
  const rows: PerItemRow[] = [
    item('t1', 'dream', 'FULL', 1),
    item('t1', 'dream', 'PARTIAL', 0),
    item('t1', 'dream', 'JUDGE_FAILED', null, { kind: 'vibe' }),
    item('t2', 'dream', 'FULL', 1),
    item('t2', 'dream', 'ABSENT', 0),
    item('t3', 'dream', 'JUDGE_FAILED', null),
    item('t1', 'verbatim', 'FULL', null),
    item('t2', 'verbatim', 'JUDGE_FAILED', null),
  ];
  const agg = aggregateCoverage(rows, ['verbatim', 'dream'], ['t1', 't2', 't3']);

  test('JUDGE_FAILED rows leave numerator and denominator, and the excluded count is reported', () => {
    const dream = agg.coverage_by_lane.dream;
    // t1: (1 + 0.5) / 2 = 0.75; t2: (1 + 0) / 2 = 0.5; t3 has no judged row.
    expect(dream.macro).toBeCloseTo(0.625, 10);
    expect(dream.micro).toBeCloseTo(2.5 / 4, 10);
    expect(dream.strict).toBeCloseTo(2 / 4, 10);
    expect(dream.n_items).toBe(4);
    expect(dream.judge_failed_excluded).toBe(2);
    expect(agg.coverage_by_lane.verbatim.macro).toBe(1);
    expect(agg.coverage_by_lane.verbatim.judge_failed_excluded).toBe(1);
  });

  test('by-kind, notability and depth groups exclude JUDGE_FAILED rows too', () => {
    expect(agg.coverage_by_kind.vibe).toBeUndefined();
    expect(agg.coverage_by_kind.fact.dream).toBeCloseTo(2.5 / 4, 10);
    expect(agg.coverage_by_notability.high.verbatim).toBe(1);
    expect(agg.coverage_by_depth.early.dream).toBeCloseTo(2.5 / 4, 10);
  });

  test('joint macro sits next to the judge-only macro with the same seeded bootstrap interval', () => {
    const dream = agg.coverage_by_lane.dream;
    // t1: (1 + 0) / 2 = 0.5; t2: (1 + 0) / 2 = 0.5.
    expect(dream.joint_macro).toBeCloseTo(0.5, 10);
    const ci = bootstrapCI([0.5, 0.5], 35, 1000);
    expect([dream.joint_ci_lo, dream.joint_ci_hi]).toEqual([ci.lo, ci.hi]);
    expect(dream.joint_n_items).toBe(4);
    expect(dream.joint_excluded).toBe(2);
    expect(agg.coverage_by_lane.verbatim.joint_macro).toBeUndefined();
  });

  test('a failed joint-grounding check (joint null on a judged row) is excluded from joint only', () => {
    const a = aggregateCoverage([item('t1', 'dream', 'FULL', 1), item('t1', 'dream', 'FULL', null)], ['dream'], ['t1']);
    expect(a.coverage_by_lane.dream.macro).toBe(1);
    expect(a.coverage_by_lane.dream.joint_macro).toBe(1);
    expect(a.coverage_by_lane.dream.joint_excluded).toBe(1);
    expect(a.coverage_by_lane.dream.judge_failed_excluded).toBe(0);
  });

  test('a lane with no judged rows is omitted rather than reported as 0', () => {
    expect(aggregateCoverage([item('t1', 'facts', 'JUDGE_FAILED', null)], ['facts'], ['t1']).coverage_by_lane.facts).toBeUndefined();
  });
});

describe('recomputation from the committed Cat 35 receipts (dream lane, macro)', () => {
  const dir = join(import.meta.dir, '../../docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill');
  const recompute = (file: string) => {
    const r = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const tids = [...new Set((r.per_item as PerItemRow[]).map((x) => x.transcript_id))];
    return { published: r.coverage_by_lane, agg: aggregateCoverage(r.per_item, r.lanes, tids) };
  };

  test('post-change receipt: judge-only 88.1% unchanged, evidence-verified joint 74.9%', () => {
    const { published, agg } = recompute('receipt-2026-08-31-v0.47.8.0-wave-079941d2.json');
    expect(agg.coverage_by_lane.dream.macro).toBeCloseTo(published.dream.macro, 10);
    expect(agg.coverage_by_lane.dream.macro).toBeCloseTo(0.8814, 4);
    expect(agg.coverage_by_lane.dream.joint_macro!).toBeCloseTo(0.7492, 4);
    for (const lane of ['verbatim', 'facts']) {
      expect(agg.coverage_by_lane[lane].macro).toBeCloseTo(published[lane].macro, 10);
      expect([agg.coverage_by_lane[lane].ci_lo, agg.coverage_by_lane[lane].ci_hi]).toEqual([published[lane].ci_lo, published[lane].ci_hi]);
    }
  });

  test('pre-change receipt: judge-only 70.2%, joint 58.2%', () => {
    const { agg } = recompute('receipt-2026-08-31-prewave-baseline-aa820c7f.json');
    expect(agg.coverage_by_lane.dream.macro).toBeCloseTo(0.7017, 4);
    expect(agg.coverage_by_lane.dream.joint_macro!).toBeCloseTo(0.5818, 4);
  });

  test('Aug-25 baseline: excluding the 8 JUDGE_FAILED items moves 61.46% to 64.69%', () => {
    const { published, agg } = recompute('baseline-receipt.json');
    expect(published.dream.macro).toBeCloseTo(0.6146, 4);
    expect(agg.coverage_by_lane.dream.macro).toBeCloseTo(0.6469, 4);
    expect(agg.coverage_by_lane.dream.judge_failed_excluded).toBe(8);
  });
});

describe('WS0 receipt (PC-09)', () => {
  const base = {
    gatePass: true,
    perItem: [item('t1', 'dream', 'FULL', 1), item('t1', 'dream', 'JUDGE_FAILED', null)],
    errors: [],
    resolvedConfig: {},
    judge: { model: 'm', temperature: 0 },
    data: {},
    startedAt: '2026-09-28T00:00:00.000Z',
  };

  test('publishable only in full mode; verdict follows the gates; judge failures are not scored', () => {
    const full = completedWs0Receipt({ ...base, mode: 'full' });
    expect(validateReceipt(full)).toEqual([]);
    expect(full.publishable).toBe(true);
    expect(full.verdict).toBe('pass');
    expect([full.n_total, full.n_scored, full.completion_rate]).toEqual([2, 1, 0.5]);
    expect(completedWs0Receipt({ ...base, mode: 'partial' }).publishable).toBe(false);
    expect(completedWs0Receipt({ ...base, mode: 'b-pre-validity' }).publishable).toBe(false);
    expect(completedWs0Receipt({ ...base, mode: 'full', gatePass: false }).verdict).toBe('fail');
  });

  test('skipped and error receipts validate and are never publishable', () => {
    for (const r of [skippedWs0Receipt('missing keys: X', base.startedAt), errorWs0Receipt('boom', base.startedAt)]) {
      expect(validateReceipt(r)).toEqual([]);
      expect(r.publishable).toBe(false);
      expect(r.verdict).toBeUndefined();
    }
  });

  test('importing the runner has no side effects (import.meta.main guard)', () => {
    expect(process.env.GBRAIN_HOME ?? '').not.toContain('cat35-');
  });

  test('missing keys: the runner writes a skipped receipt and exits 0', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cat35-skip-'));
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    const proc = Bun.spawnSync(['bun', join(import.meta.dir, '../../eval/runner/cat35-transcript-distill.ts')], { cwd, env, stderr: 'pipe', stdout: 'pipe' });
    expect(proc.exitCode).toBe(0);
    const receipt = loadReceipt(join(cwd, 'eval/reports/cat35-transcript-distill/receipt.json'));
    expect(receipt.category).toBe('cat35-transcript-distill');
    expect(receipt.run_status).toBe('skipped');
    expect(receipt.skip_reason).toContain('ANTHROPIC_API_KEY');
    expect(receipt.skip_reason).toContain('OPENAI_API_KEY');
    expect(receipt.publishable).toBe(false);
  }, 60_000);
});
