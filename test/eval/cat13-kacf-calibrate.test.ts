/**
 * Cat 13 Phase E2 — hermetic pins for the kacf floor calibration
 * (eval/runner/cat13-kacf-calibrate.ts).
 *
 * The pure parts carry the pre-registered rule, so they are pinned exactly:
 *   1. median: standard (mean of the two middle values for even n).
 *   2. eligibility: keyword top hit NOT gold AND 0 < margin_ratio < 1 —
 *      gold-top, single-row (1.0), empty (0) and unstamped probes are all
 *      excluded from the floor.
 *   3. collateral: gold-top probes strictly below the floor (over contested
 *      and over all non-empty gold-top), non-gold-top single/empty fractions.
 *   4. histogram: 10 bins over [0,1], 1.0 lands in the last (closed) bin,
 *      unstamped probes are skipped.
 *   5. CLI parse + the E2 command string + markdown rendering.
 *   6. GOOD INPUT: the engine-bound path (one PGLite brain, stub embeds,
 *      hybridSearch meta + searchKeyword) completes and every measured probe
 *      carries a stamped margin — proves the linked gbrain emits
 *      `keyword_arm_confidence` with the floor off.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  median,
  marginClass,
  isFloorEligible,
  computeFloor,
  collateral,
  histogram,
  calibrate,
  parseCalibrateArgv,
  e2Command,
  renderMarkdown,
  runCalibration,
  HISTOGRAM_BINS,
  KEYWORD_PROBE_LIMIT,
  type ProbeMarginRecord,
  type CalibrationReport,
} from '../../eval/runner/cat13-kacf-calibrate.ts';

let counter = 0;
function rec(o: { margin: number | null; gold: boolean; rows?: number; template?: string }): ProbeMarginRecord {
  counter += 1;
  const cls = marginClass(o.margin);
  const rows = o.rows ?? (cls === 'contested' ? 2 : cls === 'single' ? 1 : 0);
  return {
    probe_id: `t-${counter}`,
    template: o.template ?? 'synonym',
    text: `probe ${counter}`,
    targets: ['concepts/gold'],
    margin_ratio: o.margin,
    top_score: o.margin === null ? null : 0.1,
    keyword_rows: rows,
    keyword_rows_relaxed: 0,
    keyword_top_slug: rows > 0 ? (o.gold ? 'concepts/gold' : 'concepts/noise') : null,
    keyword_top_is_gold: o.gold && rows > 0,
    vector_enabled: o.margin !== null,
    intent: 'concept',
    hybrid_top_slug: 'concepts/gold',
    hybrid_top_is_gold: true,
  };
}

describe('kacf median', () => {
  test('empty is null; odd picks the middle; even averages the two middles; input order is irrelevant', () => {
    expect(median([])).toBeNull();
    expect(median([0.7])).toBe(0.7);
    expect(median([0.9, 0.1, 0.5])).toBe(0.5);
    expect(median([0.8, 0.2, 0.6, 0.4])).toBeCloseTo(0.5, 12);
    expect(median([0.4, 0.6])).toBeCloseTo(0.5, 12);
  });
});

describe('kacf margin classes + eligibility', () => {
  test('0 is empty, 1 is single, strictly inside is contested, null/NaN is unstamped', () => {
    expect(marginClass(0)).toBe('empty');
    expect(marginClass(-0.1)).toBe('empty');
    expect(marginClass(1)).toBe('single');
    expect(marginClass(1.2)).toBe('single');
    expect(marginClass(0.5)).toBe('contested');
    expect(marginClass(0.999)).toBe('contested');
    expect(marginClass(null)).toBe('unstamped');
    expect(marginClass(Number.NaN)).toBe('unstamped');
  });

  test('only non-gold contested probes are eligible for the floor', () => {
    expect(isFloorEligible(rec({ margin: 0.6, gold: false }))).toBe(true);
    expect(isFloorEligible(rec({ margin: 0.6, gold: true }))).toBe(false);   // gold-top excluded
    expect(isFloorEligible(rec({ margin: 1, gold: false }))).toBe(false);    // single-row excluded
    expect(isFloorEligible(rec({ margin: 0, gold: false }))).toBe(false);    // empty arm excluded
    expect(isFloorEligible(rec({ margin: null, gold: false }))).toBe(false); // unstamped excluded
  });
});

describe('kacf computeFloor', () => {
  test('the floor is the median over eligible probes only', () => {
    const records = [
      rec({ margin: 0.55, gold: false }),
      rec({ margin: 0.75, gold: false }),
      rec({ margin: 0.65, gold: false }),
      rec({ margin: 0.51, gold: true }),   // gold-top: excluded even though contested
      rec({ margin: 1, gold: false }),     // single-row: excluded
      rec({ margin: 0, gold: false }),     // empty: excluded
      rec({ margin: null, gold: false }),  // unstamped: excluded
    ];
    const f = computeFloor(records);
    expect(f.eligible_n).toBe(3);
    expect(f.floor).toBeCloseTo(0.65, 12);
    expect(f.floor_cli).toBe('0.6500');
    expect(f.eligible_margins_sorted).toEqual([0.55, 0.65, 0.75]);
  });

  test('even eligible count averages the two middle margins; no eligible probe yields null', () => {
    const f = computeFloor([rec({ margin: 0.6, gold: false }), rec({ margin: 0.8, gold: false })]);
    expect(f.floor).toBeCloseTo(0.7, 12);
    expect(f.floor_cli).toBe('0.7000');
    const none = computeFloor([rec({ margin: 0.6, gold: true }), rec({ margin: 1, gold: false })]);
    expect(none.floor).toBeNull();
    expect(none.floor_cli).toBeNull();
    expect(none.eligible_n).toBe(0);
  });

  test('the CLI string round-trips into (0, 1]', () => {
    const f = computeFloor([rec({ margin: 0.123456789, gold: false })]);
    const parsed = Number(f.floor_cli);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(1);
    expect(Math.abs(parsed - (f.floor as number))).toBeLessThan(0.00005);
  });
});

describe('kacf collateral', () => {
  const records = [
    // gold-top: two contested (one below the floor, one above), one single.
    // (An EMPTY gold-top record cannot exist: no rows means no top slug.)
    rec({ margin: 0.52, gold: true }),
    rec({ margin: 0.9, gold: true }),
    rec({ margin: 1, gold: true }),
    // non-gold-top: contested ×3 (median 0.6), single ×2, empty ×1, unstamped ×1
    rec({ margin: 0.5, gold: false }),
    rec({ margin: 0.6, gold: false }),
    rec({ margin: 0.7, gold: false }),
    rec({ margin: 1, gold: false }),
    rec({ margin: 1, gold: false }),
    rec({ margin: 0, gold: false }),
    rec({ margin: null, gold: false }),
  ];

  test('gold-top probes strictly below the floor are counted over contested AND over non-empty', () => {
    const floor = computeFloor(records).floor;
    expect(floor).toBeCloseTo(0.6, 12);
    const c = collateral(records, floor);
    expect(c.gold_top_below_floor).toBe(1);           // 0.52 only (1.0 and 0 can never be below)
    expect(c.gold_top_contested).toBe(2);
    expect(c.gold_top_below_floor_frac_of_contested).toBeCloseTo(0.5, 12);
    expect(c.gold_top_nonempty).toBe(3);              // 0.52, 0.9, 1.0
    expect(c.gold_top_below_floor_frac_of_nonempty).toBeCloseTo(1 / 3, 12);
  });

  test('non-gold-top single-row / empty fractions use the stamped non-gold denominator', () => {
    const c = collateral(records, 0.6);
    expect(c.non_gold_top_stamped).toBe(6);           // unstamped excluded
    expect(c.non_gold_top_single).toBe(2);
    expect(c.non_gold_top_single_frac).toBeCloseTo(2 / 6, 12);
    expect(c.non_gold_top_empty).toBe(1);
    expect(c.non_gold_top_empty_frac).toBeCloseTo(1 / 6, 12);
    // margins 0.6 and 0.7 are NOT strictly below 0.6 → left at full weight
    expect(c.non_gold_top_contested_not_below).toBe(2);
  });

  test('a null floor down-weights nothing', () => {
    const c = collateral(records, null);
    expect(c.gold_top_below_floor).toBe(0);
    expect(c.gold_top_below_floor_frac_of_contested).toBe(0);
    expect(c.non_gold_top_contested_not_below).toBe(3);
    expect(collateral([], null).gold_top_below_floor_frac_of_contested).toBeNull();
  });
});

describe('kacf histogram', () => {
  test('10 bins over [0,1]; 0 in the first, 1.0 in the last (closed) bin; split by gold-top; unstamped skipped', () => {
    const h = histogram([
      rec({ margin: 0, gold: false }),
      rec({ margin: 0.05, gold: true }),
      rec({ margin: 0.5, gold: false }),
      rec({ margin: 0.5, gold: true }),
      rec({ margin: 0.95, gold: false }),
      rec({ margin: 1, gold: false }),
      rec({ margin: 1, gold: true }),
      rec({ margin: null, gold: false }),
    ]);
    expect(h.bins).toBe(HISTOGRAM_BINS);
    expect(h.edges.length).toBe(11);
    expect(h.edges[0]).toBe(0);
    expect(h.edges[10]).toBe(1);
    expect(h.non_gold_top).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 2]);
    expect(h.gold_top).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(h.gold_top.reduce((a, b) => a + b, 0) + h.non_gold_top.reduce((a, b) => a + b, 0)).toBe(7);
  });

  test('bin boundaries are left-closed: 0.1 lands in bin 1, not bin 0', () => {
    const h = histogram([rec({ margin: 0.1, gold: false })]);
    expect(h.non_gold_top[1]).toBe(1);
    expect(h.non_gold_top[0]).toBe(0);
  });

  test('bins must be a positive integer', () => {
    expect(() => histogram([], 0)).toThrow(/positive integer/);
    expect(() => histogram([], 2.5)).toThrow(/positive integer/);
  });
});

describe('kacf calibrate (aggregate)', () => {
  test('per-template rollups and row-count disagreements', () => {
    const records = [
      rec({ margin: 0.6, gold: false, template: 'synonym' }),
      rec({ margin: 0.8, gold: false, template: 'synonym' }),
      rec({ margin: 0.7, gold: true, template: 'synonym' }),
      rec({ margin: 1, gold: false, template: 'body-fuzzy', rows: 2 }), // 2 rows but margin 1.0 (second score 0): disagreement
      rec({ margin: 0.4, gold: false, template: 'body-fuzzy', rows: 1 }), // contested with 1 row: disagreement
    ];
    const s = calibrate(records);
    expect(s.floor.eligible_n).toBe(3);
    expect(s.floor.floor).toBeCloseTo(0.6, 12);
    expect(s.by_template.synonym).toEqual({ probes: 3, eligible: 2, gold_top: 1, median_margin_non_gold: 0.7 });
    expect(s.by_template['body-fuzzy'].eligible).toBe(1);
    expect(s.by_template['body-fuzzy'].median_margin_non_gold).toBe(0.4);
    expect(s.row_count_disagreements).toBe(2);
    expect(s.classes.all).toEqual({ total: 5, empty: 0, single: 1, contested: 4, unstamped: 0 });
    expect(s.classes.gold_top.total).toBe(1);
    expect(s.classes.non_gold_top.total).toBe(4);
  });
});

describe('kacf CLI parsing + report strings', () => {
  test('flags map in both forms; unknown flags and bad values throw', () => {
    expect(parseCalibrateArgv([
      '--stub-embed', '--embedding-model=voyage:voyage-4', '--embedding-dims', '1024',
      '--tuning-concepts', '20', '--holdout-concepts=10', '--seed', '42', '--max-probes', '25', '--reports-dir', '/tmp/x',
    ], {})).toEqual({
      stubEmbed: true, embeddingModel: 'voyage:voyage-4', embeddingDims: '1024',
      tuningConcepts: 20, holdoutConcepts: 10, seed: 42, maxProbes: 25, reportsDir: '/tmp/x',
    });
    expect(() => parseCalibrateArgv(['--reranker', 'off'], {})).toThrow(/unknown argument/);
    expect(() => parseCalibrateArgv(['--max-probes', '0'], {})).toThrow(/>= 1/);
    expect(() => parseCalibrateArgv(['--max-probes', 'x'], {})).toThrow(/non-negative integer/);
    expect(() => parseCalibrateArgv(['--embedding-model'], {})).toThrow(/requires a value/);
    expect(parseCalibrateArgv([], { CAT13_STUB_EMBED: '1' }).stubEmbed).toBe(true);
  });

  test('the E2 command carries the embedder env, the E0-V1 pins and the 4dp floor; null without a floor', () => {
    const summary = calibrate([rec({ margin: 0.6, gold: false }), rec({ margin: 0.7, gold: false })]);
    const cmd = e2Command({ embedder: { model: 'voyage:voyage-4', dims: 1024 }, summary });
    expect(cmd).toBe(
      'CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024 '
      + 'bun eval/runner/cat13-conceptual.ts --reranker off --autocut off --keyword-arm-confidence-floor 0.6500',
    );
    expect(e2Command({ embedder: { model: 'voyage:voyage-4', dims: 1024 }, summary: calibrate([]) })).toBeNull();
  });

  test('markdown names the floor, the stub banner and the split', () => {
    const records = [rec({ margin: 0.6, gold: false }), rec({ margin: 0.9, gold: true })];
    const summary = calibrate(records);
    const report: CalibrationReport = {
      generated_at: 'now', gbrain_version: 'x', gbrain_pin: 'y', stub_embed: true,
      embedder: { model: 'voyage:voyage-4', dims: 1024 }, embedding_transport: 'stub',
      search_pins: { 'search.mode': 'balanced' }, per_call: { limit: 30, keywordArmConfidenceFloor: null },
      keyword_probe_limit: KEYWORD_PROBE_LIMIT,
      concept_split: { seed: 42, tuning_n: 20, holdout_n: 10, tuning: [], holdout: [] },
      probes: { generated: 2, tuning: 2, measured: 2, max_probes: null },
      summary, e2_command: null, records,
    };
    report.e2_command = e2Command(report);
    const md = renderMarkdown(report);
    expect(md).toContain('**floor = 0.6000**');
    expect(md).toContain('STUB EMBEDDINGS');
    expect(md).toContain('20 tuning / 10 held-out');
    expect(md).toContain('--keyword-arm-confidence-floor 0.6000');
  });
});

// ─── Good input: the engine-bound path, hermetic ─────────────────────

describe('kacf calibration e2e (hermetic, stub embeds, one PGLite brain)', () => {
  test('every measured tuning probe carries a stamped margin with the floor off; report files land', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat13-kacf-'));
    const { report, files, exitCode } = await runCalibration({
      stubEmbed: true,
      embeddingModel: 'voyage:voyage-4',
      embeddingDims: 1024,
      targetProbes: 60,
      maxProbes: 8,
      reportsDir,
      quiet: true,
    });
    expect(exitCode).toBe(0);
    expect(existsSync(files.json)).toBe(true);
    expect(existsSync(files.md)).toBe(true);
    expect(report.stub_embed).toBe(true);
    expect(report.embedder).toEqual({ model: 'voyage:voyage-4', dims: 1024 });
    expect(report.search_pins).toEqual({ 'search.mode': 'balanced', 'search.reranker.enabled': 'false', 'search.autocut': 'false' });
    expect(report.per_call).toEqual({ limit: 30, keywordArmConfidenceFloor: null });
    expect(report.concept_split).toMatchObject({ seed: 42, tuning_n: 20, holdout_n: 10 });
    expect(report.probes.measured).toBe(8);
    expect(report.probes.max_probes).toBe(8);
    expect(report.records.length).toBe(8);
    for (const r of report.records) {
      // The linked gbrain stamps keyword_arm_confidence even with the floor off.
      expect(r.margin_ratio).not.toBeNull();
      expect(r.margin_ratio as number).toBeGreaterThanOrEqual(0);
      expect(r.margin_ratio as number).toBeLessThanOrEqual(1);
      expect(r.vector_enabled).toBe(true);
      expect(r.keyword_rows).toBeLessThanOrEqual(KEYWORD_PROBE_LIMIT);
      expect(r.keyword_top_is_gold).toBe(r.keyword_top_slug !== null && r.targets.includes(r.keyword_top_slug));
      // The plan's exclusions hold structurally: single-row ⇔ margin 1, empty ⇔ margin 0.
      if (r.keyword_rows === 0) expect(r.margin_ratio).toBe(0);
      if (r.keyword_rows === 1) expect(r.margin_ratio).toBe(1);
    }
    expect(report.summary.classes.all.unstamped).toBe(0);
    expect(report.e2_command === null).toBe(report.summary.floor.floor === null);
    const onDisk = JSON.parse(readFileSync(files.json, 'utf8'));
    expect(onDisk.records.length).toBe(8);
    expect(readFileSync(files.md, 'utf8')).toContain('CAPPED by --max-probes 8');
  }, 300_000);
});
