/**
 * Regression tests for temporal.ts (audit misc-runners-06 / misc-runners-07):
 *
 *   - misc-runners-06: the as-of gold now derives from a forward job-state
 *     machine over the SEEDED events, and the prediction side runs a
 *     different computation (filter+parse over the retrieved timeline). A
 *     storage lie — dropped, re-dated, or mangled job-change entry — makes
 *     the prediction diverge from gold. Previously gold and prediction were
 *     the identical algorithm, so the metric could only ever be 100%.
 *
 *   - misc-runners-07: every query range must contain expected events;
 *     scoreRange THROWS on an empty range instead of macro-averaging a
 *     vacuous 100%. Losing a whole populated quarter now costs the full
 *     quarter, not 75%-floored-at-25%-free.
 *
 * Hermetic: pure functions only (no PGLite, no network). The full runner is
 * executed separately as a CLI smoke (it seeds an in-memory PGLite).
 */

import { describe, test, expect } from 'bun:test';
import {
  generateData,
  scoreRange,
  predictCompanyAsOf,
  jobChangeCompany,
  dateKey,
  temporalVerdict,
  plannedProbeCount,
  RANGES,
  type TimelineEvent,
} from '../../eval/runner/temporal.ts';

describe('generateData', () => {
  const { events, asOfQueries } = generateData();

  test('deterministic and within the documented span (2021 → late 2025, no 2026 events)', () => {
    expect(events.length).toBeGreaterThan(500);
    const dates = events.map(e => e.date).sort();
    expect(dates[0] >= '2021-01-01').toBe(true);
    expect(dates[dates.length - 1] < '2026-01-01').toBe(true);
    expect(generateData().events).toEqual(events);
  });

  test('every declared range contains expected events (misc-runners-07 guard is satisfiable)', () => {
    for (const r of RANGES) {
      const n = events.filter(e => e.date >= r.from && e.date <= r.to).length;
      expect(n).toBeGreaterThan(0);
    }
  });

  test('as-of gold matches the independent brute-force ground truth over seeded events', () => {
    // Independent check: the LAST job-change event on or before asOfDate.
    // The generator derives gold via a forward state machine; this test
    // re-derives it a third way so a generator bug cannot hide.
    expect(asOfQueries.length).toBe(50);
    for (const q of asOfQueries) {
      const jobChanges = events
        .filter(e => e.slug === q.slug && jobChangeCompany(e.summary) !== null && e.date <= q.asOfDate)
        .sort((a, b) => a.date.localeCompare(b.date));
      const truth = jobChanges.length > 0
        ? jobChangeCompany(jobChanges[jobChanges.length - 1].summary)
        : null;
      expect(q.expectedCompany).toBe(truth as string);
    }
  });
});

describe('scoreRange (misc-runners-07)', () => {
  const range = { from: '2024-01-01', to: '2024-03-31', label: 'Q1 2024' };
  const ev = (slug: string, date: string, summary: string): TimelineEvent => ({ slug, date, summary });
  const expected = [
    ev('people/p1', '2024-01-05', 'joined startup-1'),
    ev('people/p2', '2024-02-10', 'spoke at startup-3'),
  ];

  test('faithful storage scores recall=1, precision=1', () => {
    const s = scoreRange(range, expected, [...expected]);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
  });

  test('CAN FAIL: losing the quarter scores 0, not a vacuous 1', () => {
    const s = scoreRange(range, expected, []);
    expect(s.recall).toBe(0);
    expect(s.precision).toBe(0);
  });

  test('CAN FAIL: invented entries cost precision', () => {
    const s = scoreRange(range, expected, [
      ...expected,
      ev('people/p9', '2024-03-01', 'phantom event'),
    ]);
    expect(s.recall).toBe(1);
    expect(s.precision).toBeCloseTo(2 / 3, 10);
  });

  test('empty expected set throws (vacuous ranges cannot dilute the macro average)', () => {
    expect(() => scoreRange({ from: '2030-01-01', to: '2030-12-31', label: 'empty' }, [], []))
      .toThrow(/zero expected events/);
  });
});

describe('predictCompanyAsOf vs independent gold (misc-runners-06)', () => {
  const timeline = [
    { date: '2021-03-01', summary: 'joined startup-0' },
    { date: '2022-06-15', summary: 'announced startup-1' }, // not a job change
    { date: '2023-01-10', summary: 'hired by startup-3' },
    { date: '2025-02-01', summary: 'joined startup-4' }, // after as-of date
  ];

  test('faithful timeline reproduces the gold', () => {
    expect(predictCompanyAsOf(timeline, '2024-06-15')).toBe('startup-3');
  });

  test('CAN FAIL: storage dropping the latest job change diverges from gold', () => {
    const lossy = timeline.filter(t => t.summary !== 'hired by startup-3');
    expect(predictCompanyAsOf(lossy, '2024-06-15')).toBe('startup-0'); // ≠ gold 'startup-3'
  });

  test('CAN FAIL: storage corrupting a date diverges from gold', () => {
    const redated = timeline.map(t =>
      t.summary === 'hired by startup-3' ? { ...t, date: '2025-01-10' } : t);
    expect(predictCompanyAsOf(redated, '2024-06-15')).toBe('startup-0');
  });

  test('CAN FAIL: storage mangling a summary diverges from gold', () => {
    const mangled = timeline.map(t =>
      t.summary === 'hired by startup-3' ? { ...t, summary: 'hired by ???' } : t);
    expect(predictCompanyAsOf(mangled, '2024-06-15')).toBe('startup-0');
  });

  test('accepts Date objects from PGLite date columns', () => {
    const asDates = timeline.map(t => ({ ...t, date: new Date(`${t.date}T00:00:00Z`) }));
    expect(predictCompanyAsOf(asDates, '2024-06-15')).toBe('startup-3');
    expect(dateKey(new Date('2023-01-10T00:00:00Z'))).toBe('2023-01-10');
  });

  test('no job change on or before the date → null', () => {
    expect(predictCompanyAsOf(timeline, '2021-01-01')).toBe(null);
  });
});

describe('verdict + accounting', () => {
  test('verdict passes only when every metric is perfect', () => {
    const perfect = {
      pointRecall: 1, pointPrecision: 1, rangeRecall: 1, rangePrecision: 1,
      rangeScores: [], recencyAcc: 1, asOfAcc: 1,
    };
    expect(temporalVerdict(perfect)).toBe('pass');
    expect(temporalVerdict({ ...perfect, asOfAcc: 0.98 })).toBe('fail');
    expect(temporalVerdict({ ...perfect, rangeRecall: 0.75 })).toBe('fail');
  });

  test('planned probe count covers point + range + recency + as-of', () => {
    expect(plannedProbeCount(50)).toBe(30 + RANGES.length + 30 + 50);
  });
});
