import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  inferAllEdges,
  score,
  type GoldEdge,
  type RichPage,
  type TypeAccuracyAttempt,
} from '../../eval/runner/type-accuracy.ts';
import {
  generateData,
  plannedProbeCount,
  runTemporal,
  temporalEventEvidence,
  type TemporalEvidenceRow,
  type TimelineEvent,
} from '../../eval/runner/temporal.ts';
import {
  aggregate,
  runCat6,
  scoreExtraction,
  type VariantCase,
  type VariantEvidenceRow,
} from '../../eval/runner/cat6-prose-scale.ts';
import { ProbeAccounting } from '../../eval/runner/probe-accounting.ts';

const sum = <T>(rows: T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);
const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : 0;
const nullableRatio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;

describe('Cat2 native edge evidence', () => {
  const edge = (from: string, to: string, type: string): GoldEdge => ({ from, to, type });

  test('pair rows reconstruct the existing confusion matrix, per-type counts and pooled metrics', () => {
    const gold = [edge('a', 'x', 'works_at'), edge('b', 'x', 'founded'), edge('c', 'x', 'advises')];
    const inferred = [
      edge('a', 'x', 'mentions'), edge('a', 'x', 'works_at'), edge('a', 'x', 'works_at'),
      edge('b', 'x', 'works_at'), edge('b', 'x', 'mentions'),
      edge('d', 'x', 'works_at'), edge('d', 'x', 'novel_type'),
    ];
    const native = score(gold, inferred);
    const rows = JSON.parse(JSON.stringify(native.rows)) as typeof native.rows;
    expect(rows.length).toBe(4);
    expect(new Set(rows.map(row => row.probe_id)).size).toBe(rows.length);
    expect(rows.map(row => row.classification)).toEqual(['correctly_typed', 'mistyped', 'missed', 'spurious']);
    expect(rows.find(row => row.from === 'a')!.inferredTypes).toEqual(['mentions', 'works_at']);
    expect(rows.find(row => row.from === 'b')!.inferredType).toBe('mentions');
    expect(rows.every(row => row.contributed)).toBe(true);

    const confusion: Record<string, Record<string, number>> = Object.fromEntries(native.perType.map(r => [r.linkType, {}]));
    confusion['(no-gold)'] = {};
    for (const row of rows) {
      const bucket = confusion[row.goldType ?? '(no-gold)'];
      for (const inferredType of row.goldType === null ? row.inferredTypes : [row.inferredType ?? '(missing)']) {
        bucket[inferredType] = (bucket[inferredType] ?? 0) + 1;
      }
    }
    expect(confusion).toEqual(native.confusion);
    for (const perType of native.perType) {
      const contributions = rows.flatMap(row => row.counts).filter(count => count.linkType === perType.linkType);
      for (const key of ['gold', 'correctly_typed', 'mistyped', 'missed', 'spurious'] as const) {
        expect(sum(contributions, count => count[key])).toBe(perType[key]);
      }
      expect(perType.recall).toBe(ratio(perType.correctly_typed, perType.gold));
      expect(perType.precision).toBe(ratio(perType.correctly_typed, perType.correctly_typed + perType.spurious));
    }
    const counts = rows.flatMap(row => row.counts);
    const correct = sum(counts, count => count.correctly_typed);
    const mistyped = sum(counts, count => count.mistyped);
    const missed = sum(counts, count => count.missed);
    const spurious = sum(counts, count => count.spurious);
    expect([correct, mistyped, missed, spurious]).toEqual([1, 1, 1, 3]);
    expect(native.overallTypeAccuracy).toBe(ratio(correct, correct + mistyped));
    expect(native.overallStrictF1).toBeCloseTo(ratio(2 * correct, 2 * correct + mistyped + missed + spurious), 14);
    expect(score(gold, [...inferred].reverse()).rows).toEqual(rows);
  });

  test('empty gold keeps every inferred-only type and zero-denominator policy', () => {
    const native = score([], [edge('a', 'b', 'mentions'), edge('a', 'b', 'works_at')]);
    expect(native.rows).toHaveLength(1);
    expect(native.rows[0].counts.map(count => count.spurious)).toEqual([1, 1]);
    expect(native.overallStrictF1).toBe(0);
    expect(native.overallTypeAccuracy).toBe(0);
    expect(score([], []).rows).toEqual([]);
    expect(score([], []).overallStrictF1).toBe(0);
  });

  test('extractor failures retain the successful and failed page attempts without a fake score', async () => {
    const pages: RichPage[] = ['a', 'b', 'c'].map(slug => ({
      slug, type: 'person', title: slug, compiled_truth: '', timeline: '', _facts: { type: 'person' },
    }));
    const attempts: TypeAccuracyAttempt[] = [];
    await expect(inferAllEdges(pages, attempts, async slug => {
      if (slug === 'b') throw new Error('injected extraction failure');
      return { candidates: [], unresolved: [] };
    })).rejects.toThrow('injected extraction failure');
    expect(attempts).toEqual([
      { probe_id: 'page:a', slug: 'a', status: 'completed', inferred: [] },
      { probe_id: 'page:b', slug: 'b', status: 'error', inferred: [], error: 'Error: injected extraction failure' },
    ]);
    expect(() => score([edge('a', 'b', 'works_at'), edge('a', 'b', 'founded')], [])).toThrow('gold carries two types');
  });
});

function timelineEngine(transform: (slug: string, events: TimelineEvent[]) => Array<{ date: unknown; summary: string }>) {
  const stored = new Map<string, TimelineEvent[]>();
  return {
    putPage: async (slug: string) => { stored.set(slug, []); },
    addTimelineEntry: async (slug: string, event: { date: string; summary: string }) => {
      stored.get(slug)!.push({ slug, ...event });
    },
    getTimeline: async (slug: string) => transform(slug, stored.get(slug)!),
  } as unknown as Parameters<typeof runTemporal>[0];
}

describe('Cat4 native temporal evidence', () => {
  test.each(['faithful', 'lossy', 'empty'] as const)('%s rows reproduce all six native aggregates', async mode => {
    const acc = new ProbeAccounting(plannedProbeCount(50));
    const engine = timelineEngine((_slug, events) => {
      if (mode === 'empty') return [];
      if (mode === 'faithful') return events;
      const selected = events.filter((_, i) => i % 3 === 0);
      return [...selected, ...selected].map(event => ({ ...event, date: new Date(event.date) }));
    });
    const native = await runTemporal(engine, acc);
    const rows = JSON.parse(JSON.stringify(native.rows)) as TemporalEvidenceRow[];
    expect(rows).toHaveLength(114);
    expect(new Set(rows.map(row => row.probe_id)).size).toBe(114);
    expect(acc.summary().n_scored).toBe(114);
    const eventRows = rows.filter((row): row is Extract<TemporalEvidenceRow, { hits: number }> => row.status === 'scored' && row.kind !== 'asof');
    const points = eventRows.filter(row => row.kind === 'point');
    const ranges = eventRows.filter(row => row.kind === 'range');
    const recency = eventRows.filter(row => row.kind === 'recency');
    const asof = rows.filter(row => row.status === 'scored' && row.kind === 'asof');
    expect(native.pointRecall).toBe(sum(points, row => row.hits) / sum(points, row => row.expected));
    expect(native.pointPrecision).toBe(ratio(sum(points, row => row.hits), sum(points, row => row.returned)));
    expect(native.rangeRecall).toBe(sum(ranges, row => row.recall) / ranges.length);
    expect(native.rangePrecision).toBe(sum(ranges, row => row.precision!) / ranges.length);
    expect(native.recencyAcc).toBe(sum(recency, row => row.hits) / sum(recency, row => row.expected));
    expect(native.asOfAcc).toBe(sum(asof, row => Number(row.correct)) / asof.length);
    expect(ranges.map(row => ({
      label: row.label, expected: row.expected, returned: row.returned, recall: row.recall, precision: row.precision,
    }))).toEqual(native.rangeScores);
    for (const row of [...points, ...ranges]) {
      expect(row.returnedIds.length).toBe(row.returned);
      expect(row.expectedIds.length).toBe(row.expected);
      expect(new Set(row.returnedIds.filter(id => row.expectedIds.includes(id))).size).toBe(row.hits);
    }
    for (const row of recency) {
      expect(row.selectedIds.length).toBe(row.returned);
      expect(row.expectedIds.filter(id => row.selectedIds.includes(id)).length).toBe(row.hits);
      expect(row.returnedIds.length).toBeGreaterThanOrEqual(row.selectedIds.length);
    }
    for (const row of asof) {
      expect(row.probe_id).toBe(`asof:${row.slug}`);
      expect(row.asOfDate).toStartWith('2024-06-');
      expect(row.correct).toBe(row.expectedCompany === row.predictedCompany);
      expect(row.selectedIds.length).toBe(row.predictedCompany === null ? 0 : 1);
      expect(row.selectedIds.every(id => row.returnedIds.includes(id))).toBe(true);
    }
  });

  test('empty-gold observations retain zero counts rather than invented hits', () => {
    expect(temporalEventEvidence([], [])).toEqual({
      expectedIds: [], returnedIds: [], selectedIds: [], hits: 0, expected: 0, returned: 0,
    });
  });

  test('mid-probe failure retains earlier scored rows and the exact failed probe ID', async () => {
    const dates = [...new Set(generateData().events.map(event => event.date))].sort();
    const failedDate = dates[Math.floor(dates.length / 30)];
    const rows: TemporalEvidenceRow[] = [];
    const acc = new ProbeAccounting(plannedProbeCount(50));
    const engine = timelineEngine((_slug, events) => events.map(event => ({
      date: event.date,
      get summary() {
        if (event.date === failedDate) throw new Error('injected timeline failure');
        return event.summary;
      },
    })));
    await expect(runTemporal(engine, acc, () => {}, rows)).rejects.toThrow('injected timeline failure');
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('scored');
    expect(rows[1]).toEqual({
      probe_id: `point:${failedDate}`, kind: 'point', status: 'error', contributed: false,
      error: 'Error: injected timeline failure',
    });
    expect(acc.summary().n_scored).toBe(1);
    expect(new Set(rows.map(row => row.probe_id)).size).toBe(2);
  });

  test('retrieval failure is retained without a scored temporal contribution', async () => {
    const rows: TemporalEvidenceRow[] = [];
    const engine = timelineEngine(() => { throw new Error('storage unavailable'); });
    await expect(runTemporal(engine, new ProbeAccounting(114), () => {}, rows)).rejects.toThrow('storage unavailable');
    expect(rows).toEqual([{
      probe_id: 'timeline:people/p0', kind: 'setup', status: 'error', contributed: false,
      error: 'Error: storage unavailable',
    }]);
  });
});

function checkCat6Rows(report: ReturnType<typeof aggregate>) {
  const rows = JSON.parse(JSON.stringify(report.rows)) as VariantEvidenceRow[];
  expect(rows).toHaveLength(report.variants);
  expect(new Set(rows.map(row => row.probe_id)).size).toBe(rows.length);
  for (const row of rows) expect(row.probe_id).toBe(row.variantId);
  for (const kind of report.per_kind) {
    const selected = rows.filter(row => row.kind === kind.kind);
    const matched = sum(selected, row => row.matched);
    const must = sum(selected, row => row.goldDelta.must_extract.length);
    const mustNot = sum(selected, row => row.goldDelta.must_not_extract.length);
    const mistyped = sum(selected, row => row.mistyped.length);
    const missed = sum(selected, row => row.missed.length);
    const fp = sum(selected, row => row.false_positives.length);
    expect(kind).toEqual({
      kind: kind.kind, variants: selected.length,
      total_must_extract: must, total_matched: matched, total_mistyped: mistyped,
      total_missed: missed, total_must_not: mustNot, total_false_positives: fp,
      precision: nullableRatio(matched, matched + mistyped + fp),
      recall: nullableRatio(matched, must),
      type_match_rate: nullableRatio(matched, matched + mistyped),
      false_positive_rate: nullableRatio(fp, mustNot),
    });
  }
  const matched = sum(rows, row => row.matched);
  const must = sum(rows, row => row.goldDelta.must_extract.length);
  const precision = nullableRatio(matched, matched + sum(rows, row => row.mistyped.length + row.false_positives.length));
  const recall = nullableRatio(matched, must);
  expect(report.overall.link_precision).toBe(precision);
  expect(report.overall.link_recall).toBe(recall);
  expect(report.overall.link_f1).toBe(precision === null || recall === null ? null
    : precision + recall ? 2 * precision * recall / (precision + recall) : 0);
  expect(report.overall.pages_with_links_coverage).toBe(ratio(rows.filter(row => row.extracted.length > 0).length, rows.length));
  expect(report.overall.mean_links_per_page).toBe(ratio(sum(rows, row => row.extracted.length), rows.length));
  for (const [kind, metric] of [
    ['code_fence_leak', 'code_fence_leak_rate'],
    ['inline_code_slug', 'inline_code_leak_rate'],
    ['substring_collision', 'substring_fp_rate'],
  ] as const) {
    const selected = rows.filter(row => row.kind === kind);
    expect(report.overall[metric]).toBe(nullableRatio(sum(selected, row => row.false_positives.length), sum(selected, row => row.goldDelta.must_not_extract.length)));
  }
  const roles = rows.filter(row => row.kind === 'ambiguous_role');
  expect(report.overall.ambiguous_role_type_match_rate).toBe(nullableRatio(sum(roles, row => row.matched), sum(roles, row => row.matched + row.mistyped.length)));
}

describe('Cat6 native variant evidence', () => {
  test('mixed outcomes retain labels and reproduce the unchanged pooled counts, rates and diagnostics', async () => {
    let index = 0;
    const outcome = await runCat6({ perKind: 3 }, [], async variant => {
      const mode = index++ % 3;
      const must = mode === 0 ? [] : variant.goldDelta.must_extract.map(gold => ({
        targetSlug: gold.slug, linkType: mode === 1 ? gold.type : 'deliberately_wrong',
      }));
      return [...must, ...variant.goldDelta.must_not_extract.map(gold => ({ targetSlug: gold.slug, linkType: 'mentions' })),
        { targetSlug: 'unlabeled/noise', linkType: 'mentions' }];
    });
    checkCat6Rows(outcome.report);
    expect(outcome.report.rows.some(row => row.missed.length > 0)).toBe(true);
    expect(outcome.report.rows.some(row => row.mistyped.length > 0)).toBe(true);
    expect(outcome.report.rows.some(row => row.false_positives.length > 0)).toBe(true);
    expect(outcome.report.rows.some(row => row.matched > 0)).toBe(true);
  });

  test('SUT exceptions keep all attempted variants, their labels, errors, and native scored-miss contributions', async () => {
    const attempted: VariantEvidenceRow[] = [];
    const outcome = await runCat6({ perKind: 2 }, attempted, async () => { throw new Error('extractor unavailable'); });
    checkCat6Rows(outcome.report);
    expect(attempted).toEqual(outcome.report.rows);
    expect(outcome.accounting.errors).toHaveLength(10);
    expect(outcome.accounting.n_scored).toBe(10);
    expect(outcome.report.rows.every(row => row.contributed && row.sut_error === 'Error: extractor unavailable')).toBe(true);
    expect(outcome.report.rows.every(row => row.matched === 0 && row.missed.length === row.goldDelta.must_extract.length)).toBe(true);
    expect(outcome.report.overall.link_recall).toBe(0);
    expect(outcome.report.overall.link_precision).toBeNull();
    expect(outcome.report.overall.link_f1).toBeNull();
  });

  test('empty-gold variants stay present with null label-based rates and finite diagnostics', () => {
    const variant: VariantCase = {
      variantId: 'empty-gold', baseSlug: 'people/example', baseType: 'person', kind: 'multi_entity_sentence',
      content: '', goldDelta: { must_extract: [], must_not_extract: [], note: 'Empty gold fixture' },
    };
    const report = aggregate([variant], [scoreExtraction(variant, [])]);
    checkCat6Rows(report);
    expect(report.rows[0].goldDelta).toEqual(variant.goldDelta);
    expect(report.overall.link_precision).toBeNull();
    expect(report.overall.link_recall).toBeNull();
    expect(report.overall.link_f1).toBeNull();
    expect(report.overall.pages_with_links_coverage).toBe(0);
    checkCat6Rows(aggregate([], []));
  });
});

test('native CLI outputs persist the same rows in stdout and receipt/report artifacts', () => {
  const root = resolve(import.meta.dir, '../..');
  const output = mkdtempSync(join(tmpdir(), 'native-evidence-2-4-6-'));
  const run = (runner: string, args: string[]) => {
    const result = Bun.spawnSync([process.execPath, join(root, 'eval/runner', runner), ...args], { cwd: output });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  try {
    const cat2 = run('type-accuracy.ts', ['--json', `--dir=${join(root, 'eval/data/world-v1')}`]);
    expect(cat2.rows.length).toBeGreaterThan(0);
    expect(cat2.attempts.every((attempt: TypeAccuracyAttempt) => attempt.status === 'completed')).toBe(true);
    expect(score(cat2.goldEdges, cat2.inferredEdges).rows).toEqual(cat2.rows);

    const cat4 = run('temporal.ts', ['--json']);
    const temporalReceipt = JSON.parse(readFileSync(join(output, 'eval/reports/temporal/receipt.json'), 'utf8'));
    expect(cat4.rows).toHaveLength(114);
    expect(temporalReceipt.data.rows).toEqual(cat4.rows);

    const cat6 = run('cat6-prose-scale.ts', [
      '--corpus-dir', join(root, 'eval/data/world-v1'),
      '--receipt-path', join(output, 'cat6.receipt.json'),
      '--report-path', join(output, 'cat6.report.json'),
    ]);
    const cat6Receipt = JSON.parse(readFileSync(join(output, 'cat6.receipt.json'), 'utf8'));
    const cat6Report = JSON.parse(readFileSync(join(output, 'cat6.report.json'), 'utf8'));
    expect(cat6.rows).toHaveLength(250);
    expect(cat6Receipt.data.rows).toEqual(cat6.rows);
    expect(cat6Report.rows).toEqual(cat6.rows);
    checkCat6Rows(cat6Report);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 30_000);
