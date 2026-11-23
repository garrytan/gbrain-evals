/**
 * The weekly held-out line's aggregates writer and scorecard (eval/runner/weekly-line/; preregistration
 * docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md) on synthetic values and synthetic cell records:
 * a hand-computed paired t interval and Holm step-down, the O'Brien-Fleming bounds per Holm step, every block word
 * (ahead, behind, level within 3 points, split by reader both ways, no measurable difference, ceiling, descriptive,
 * changed within the block, no verdict), the look and its early word naming only the first 16 worlds' releases, bounds
 * fixed when a block ends short, the per-comparison missing-data mask, weekly points with no word, the rolling display,
 * the regression flag and its seeded false-alarm rate, cost per correct answer, the grep agent's stops, the allow-list's
 * refusals (text smuggled into an allowed-looking field included), and one end-to-end run of the command line from record
 * files. Keyless and offline: nothing here builds a provider client, and fetch throws for the whole file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { obfBounds } from '../../eval/runner/bg1/confirm.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { answerId, type AnswerRecord, type JudgmentRecord } from '../../eval/runner/memory-qa/records.ts';
import { frontierInstrumentId } from '../../eval/runner/q1/cell.ts';
import { bg1JudgeOf, PER_READER_JUDGE_SETTINGS } from '../../eval/runner/q1/cells/definitions.ts';
import { aggregateProblems, assertAggregate, blockAggregates, main, WEEK_SCHEMA, weekAggregates, WeeklyAggregateError, writeAggregate, type WeekMeta } from '../../eval/runner/weekly-line/aggregates.ts';
import { plannedQuestions, WL_CLASSES, WL_COMPARISONS, WL_OBF_BOUNDS, WL_READER_KEYS, WL_READERS, WL_ROWS, WL_SYSTEMS, type WlClass, type WlReaderKey, type WlRow } from '../../eval/runner/weekly-line/design.ts';
import { plannedFor, questionsFromRecords, WeeklyRecordsError, type WlQuestion } from '../../eval/runner/weekly-line/records.ts';
import { renderBlock, renderWeek } from '../../eval/runner/weekly-line/scorecard.ts';
import { analyzeBlock, analyzeLook, compare, costPerCorrect, estimate, falseAlarmRate, grepStops, holmStepDown, regressionFlag, rolling, weeklySdd, type BlockWorld } from '../../eval/runner/weekly-line/stats.ts';

const tmp = mkdtempSync(join(tmpdir(), 'weekly-line-'));
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error('the weekly line tests are offline'); }) as unknown as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; rmSync(tmp, { recursive: true, force: true }); });

const A = 'v0.61.0.0', B = 'v0.61.1.0', COMMIT = 'c'.repeat(40);
const worldIds = (n: number, from = 1001) => Array.from({ length: n }, (_, i) => `bgw-${from + i}`);
const Q: Record<WlClass, number> = { now: 40, past: 24 };
const BASE: Record<WlClass, number> = { now: 20, past: 12 };

type Delta = (i: number, r: WlReaderKey) => number;
interface Synth { base?: Partial<Record<WlClass, number>>; drops?: Partial<Record<string, number>>; turnCaps?: number }

/** Synthetic values: gbrain passes the first base questions of each class; each other row passes base - delta(world, reader); drops put a harness failure on the other row's claude-opus-5-5 answer to the first k class questions. */
function synth(n: number, spec: Partial<Record<string, Delta>>, o: Synth = {}): { worlds: string[]; questions: WlQuestion[] } {
  const worlds = worldIds(n);
  const questions = plannedFor(worlds);
  worlds.forEach((w, i) => {
    for (const cls of ['now', 'past'] as WlClass[]) {
      const qs = questions.filter(q => q.world === w && q.cls === cls);
      const base = o.base?.[cls] ?? BASE[cls];
      for (const row of WL_ROWS) for (const r of WL_READER_KEYS) {
        const key = `${cls}|${row}`;
        const passes = row === 'gbrain' ? base : Math.max(0, Math.min(Q[cls], base - (spec[key]?.(i, r) ?? 0)));
        qs.forEach((q, k) => { (q.rows[row] ??= {})[r] = { pass: k < passes ? 1 : 0, failure: null }; });
        const drops = row !== 'gbrain' && r === 'claude-opus-5-5' ? o.drops?.[key] ?? 0 : 0;
        qs.slice(0, drops).forEach(q => { q.rows[row]![r] = { drop: 'reader_error' }; });
      }
    }
  });
  return { worlds, questions };
}
const counted = (worlds: readonly string[], releases: (i: number) => string = () => A): BlockWorld[] =>
  worlds.map((world, i) => ({ world, week: `2026-12-${String(1 + 7 * Math.floor(i / 8)).padStart(2, '0')}`, release: releases(i), commit: COMMIT }));
const alt = (a: number, b: number): Delta => i => (i % 2 ? b : a);
const halves = (first: Delta, second: Delta): Delta => (i, r) => (i < 16 ? first(i, r) : second(i, r));
const wordOf = (questions: WlQuestion[], worlds: string[], key: string, releases?: (i: number) => string) => analyzeBlock(questions, counted(worlds, releases), { ended: true, draws: 99 }).comparisons.find(c => c.key === key)!;

// ─── Hand-computed statistics ────────────────────────────────────────

describe('the paired t interval and Holm, by hand', () => {
  test('the paired t on N - 1 df matches a hand computation', () => {
    const { worlds, questions } = synth(4, { 'now|grep-agent': i => i + 1 });
    const c = compare(questions, { cls: 'now', other: 'grep-agent' }, worlds);
    expect(c.diffs.map(d => d.d)).toEqual([2.5, 5, 7.5, 10]);
    const sd = Math.sqrt((3.75 ** 2 * 2 + 1.25 ** 2 * 2) / 3), se = sd / 2, half = 3.182446305284263 * se;
    expect(c.pooled.mean).toBeCloseTo(6.25, 10);
    expect(c.pooled.sd!).toBeCloseTo(sd, 10);
    expect(c.pooled.df).toBe(3);
    expect(c.pooled.ci95![0]).toBeCloseTo(6.25 - half, 6);
    expect(c.pooled.ci95![1]).toBeCloseTo(6.25 + half, 6);
    expect(c.pooled.ci95![0]).toBeCloseTo(1.1144, 3);
  });

  test("Holm's two-sided step-down uses each step's bound and stops at the first miss", () => {
    expect(holmStepDown([3.3, -2.0], 'final')).toEqual({ passed: [true, true], step: [1, 2], bound: [2.25, 1.977] });
    expect(holmStepDown([2.2, 2.1], 'final').passed).toEqual([false, false]);
    expect(holmStepDown([1.0, -2.3], 'final')).toEqual({ passed: [false, true], step: [2, 1], bound: [1.977, 2.25] });
    const f2 = holmStepDown([3.0, -2.6, 2.3, 1.0], 'final');
    expect(f2.passed).toEqual([true, true, true, false]);
    expect(f2.bound).toEqual([2.502, 2.4, 2.25, 1.977]);
    expect(holmStepDown([3.0, -2.45, 2.3, 1.0], 'final').passed).toEqual([true, true, true, false]);
    expect(holmStepDown([3.0, -2.35, 2.3, 1.0], 'final').passed).toEqual([true, false, false, false]);
    expect(holmStepDown([2.9, 0.5], 'look').passed).toEqual([false, false]);
    expect(holmStepDown([3.2, 2.8], 'look')).toEqual({ passed: [true, true], step: [1, 2], bound: [3.183, 2.797] });
    expect(holmStepDown([null, 2.3], 'final')).toEqual({ passed: [false, true], step: [2, 1], bound: [1.977, 2.25] });
    expect(holmStepDown([null, 2.0], 'final').passed).toEqual([false, false]);
  });

  test("the listed O'Brien-Fleming bounds are BG1-C's two-look bounds at half each two-sided alpha", () => {
    for (const d of [1, 2, 3, 4] as const) {
      const b = obfBounds(0.05 / d / 2);
      expect(Math.abs(b.look - WL_OBF_BOUNDS[d].look)).toBeLessThan(0.0015);
      expect(Math.abs(b.final - WL_OBF_BOUNDS[d].final)).toBeLessThan(0.0015);
    }
  });

  test("the weekly smallest detectable difference reproduces the Power table's SD 9 and SD 4.5 columns", () => {
    expect(weeklySdd(1).toFixed(1)).toBe('11.9');
    expect(weeklySdd(2).toFixed(1)).toBe('13.5');
    expect(weeklySdd(1, 4.5).toFixed(1)).toBe('5.9');
    expect(weeklySdd(2, 4.5).toFixed(1)).toBe('6.7');
  });
});

// ─── Words ───────────────────────────────────────────────────────────

describe('every block word', () => {
  test('ahead, early at the look, naming only the first 16 worlds\' releases', () => {
    const { worlds, questions } = synth(32, { 'now|grep-agent': alt(4, 5) });
    const c = wordOf(questions, worlds, 'now|grep-agent', i => (i < 16 ? A : B));
    expect(c.word).toBe('ahead');
    expect(c.early).not.toBeNull();
    expect(c.early!.word).toBe('ahead');
    expect(c.early!.releases).toEqual([A]);
    expect(wordOf(questions, worlds, 'past|grep-agent').word).toBe('level within 3 points');
  });

  test('ahead and behind at the end only, with no early word', () => {
    const up = synth(32, { 'now|extract-first': halves(alt(2, -1), alt(4, 3)) });
    const c = wordOf(up.questions, up.worlds, 'now|extract-first');
    expect(c.early).toBeNull();
    expect(c.word).toBe('ahead');
    expect(c.bound).toBe(2.502);
    const down = synth(32, { 'past|memory-bank': halves(alt(-1, 1), alt(-2, -3)) });
    const d = wordOf(down.questions, down.worlds, 'past|memory-bank');
    expect(d.early).toBeNull();
    expect(d.word).toBe('behind');
  });

  test('behind, early', () => {
    const { worlds, questions } = synth(32, { 'past|grep-agent': alt(-3, -4) });
    const c = wordOf(questions, worlds, 'past|grep-agent');
    expect([c.word, c.early?.word]).toEqual(['behind', 'behind']);
  });

  test('level within 3 points needs the simultaneous interval inside -3 to +3', () => {
    const { worlds, questions } = synth(32, { 'now|memory-bank': alt(1, -1) });
    const c = wordOf(questions, worlds, 'now|memory-bank');
    expect(c.word).toBe('level within 3 points');
    expect(c.simultaneous.level).toBe(0.9875);
    expect(c.simultaneous.ci![0]).toBeGreaterThan(-3);
    expect(c.simultaneous.ci![1]).toBeLessThan(3);
    expect(wordOf(questions, worlds, 'now|grep-agent').simultaneous.level).toBe(0.975);
  });

  test('split by reader when the readers disagree on an ahead, and on a level', () => {
    const crossed = synth(32, { 'now|extract-first': (i, r) => (r === 'claude-opus-5-5' ? 6 + (i % 2) : -2 + (i % 2)) });
    const c = wordOf(crossed.questions, crossed.worlds, 'now|extract-first');
    expect(c.crossed).toBe(true);
    expect(c.word).toBe('split by reader');
    expect(c.early).toBeNull();
    const look = analyzeLook(crossed.questions, counted(crossed.worlds))!.comparisons.find(x => x.key === 'now|extract-first')!;
    expect([look.crossed, look.withheld, look.early]).toEqual([true, 'split by reader', null]);
    const level = synth(32, { 'past|extract-first': (i, r) => (r === 'claude-opus-5-5' ? 2 : -2) });
    const l = wordOf(level.questions, level.worlds, 'past|extract-first');
    expect(l.pooled.mean).toBeCloseTo(0, 10);
    expect(l.word).toBe('split by reader');
  });

  test('no measurable difference at this sample size', () => {
    const { worlds, questions } = synth(32, { 'now|grep-agent': alt(6, -6) });
    expect(wordOf(questions, worlds, 'now|grep-agent').word).toBe('no measurable difference');
  });

  test('ceiling when both rows average at least 97 in the class', () => {
    const { worlds, questions } = synth(32, { 'now|grep-agent': alt(1, 0) }, { base: { now: 40 } });
    const c = wordOf(questions, worlds, 'now|grep-agent');
    expect(c.means.other).toBeCloseTo(98.75, 10);
    expect(c.word).toBe('ceiling');
    const below = synth(32, { 'now|grep-agent': () => 2 }, { base: { now: 40 } });
    expect(wordOf(below.questions, below.worlds, 'now|grep-agent').word).not.toBe('ceiling');
  });

  test('descriptive above 5% of the block\'s questions lost, not at exactly 5%', () => {
    const over = synth(32, {}, { drops: { 'now|memory-bank': 3 } });
    const c = wordOf(over.questions, over.worlds, 'now|memory-bank');
    expect(c.mask).toEqual({ planned: 1280, kept: 1184, lost: 96, share: 0.075 });
    expect(c.word).toBe('descriptive');
    const edge = synth(32, {}, { drops: { 'now|memory-bank': 2 } });
    expect(wordOf(edge.questions, edge.worlds, 'now|memory-bank').word).toBe('level within 3 points');
  });

  test('changed within the block when the full block has the opposite sign to the early word', () => {
    const { worlds, questions } = synth(32, { 'now|grep-agent': halves(alt(4, 5), alt(-8, -9)) });
    const c = wordOf(questions, worlds, 'now|grep-agent', i => (i < 16 ? A : B));
    expect(c.early!.word).toBe('ahead');
    expect(c.pooled.mean!).toBeLessThan(0);
    expect(c.word).toBe('changed within the block');
  });

  test('no verdict below 16 counted worlds, and no look', () => {
    const { worlds, questions } = synth(15, { 'now|grep-agent': alt(4, 5) });
    const r = analyzeBlock(questions, counted(worlds), { ended: true, draws: 99 });
    expect(r.look).toBeNull();
    expect(r.comparisons.every(c => c.word === 'no verdict')).toBe(true);
  });
});

// ─── The look ────────────────────────────────────────────────────────

describe('the look (R113)', () => {
  test('a block that ends short keeps both bounds as fixed', () => {
    const { worlds, questions } = synth(20, { 'now|grep-agent': halves(alt(2, -1), alt(5, 4)) });
    const r = analyzeBlock(questions, counted(worlds), { ended: true, draws: 99 });
    const c = r.comparisons.find(x => x.key === 'now|grep-agent')!;
    expect(c.pooled.df).toBe(19);
    expect(c.bound).toBe(2.25);
    expect(r.look!.comparisons.find(x => x.key === 'now|grep-agent')!.bound).toBe(3.183);
  });

  test('the look reads the first 16 counted worlds, skipping a week with no point', () => {
    const { worlds, questions } = synth(24, {});
    const metas = [meta('2026-12-01', worlds.slice(0, 8), A), { ...meta('2026-12-08', [], A), no_point: 'custody host offline' as const }, meta('2026-12-15', worlds.slice(8, 16), B), meta('2026-12-22', worlds.slice(16), B)];
    const b = blockAggregates(1, metas, questions, { draws: 99 });
    expect(b.counted_worlds).toBe(24);
    expect(b.look).toEqual({ worlds: 16, releases: [A, B] });
    expect(b.weeks[1]).toMatchObject({ no_point: 'custody host offline', worlds: 0 });
  });

  test('an early word is withheld when the first 16 worlds are descriptive or at the ceiling', () => {
    const d = synth(32, { 'now|grep-agent': alt(4, 5) }, { drops: { 'now|grep-agent': 3 } });
    const look = analyzeLook(d.questions, counted(d.worlds))!.comparisons.find(x => x.key === 'now|grep-agent')!;
    expect([look.crossed, look.withheld, look.early]).toEqual([true, 'descriptive', null]);
  });
});

// ─── Missing data, weekly points and beside the verdict ──────────────

describe('missing data', () => {
  test('one common set per comparison: a harness failure leaves the question out of that comparison only, for both rows and readers; a product failure scores 0', () => {
    const { worlds, questions } = synth(1, {});
    const q0 = questions.find(q => q.id === 'bgw-1001:s1_updated:0')!;
    q0.rows['grep-agent']!['particle-1'] = { drop: 'reader_error' };
    const q1 = questions.find(q => q.id === 'bgw-1001:s1_updated:1')!;
    q1.rows['memory-bank']!['claude-opus-5-5'] = { pass: 0, failure: 'retrieval_error' };
    const grep = compare(questions, { cls: 'now', other: 'grep-agent' }, worlds);
    expect(grep.mask).toMatchObject({ planned: 40, kept: 39, lost: 1 });
    expect(grep.diffs[0].d).toBeCloseTo(100 * (19 / 39) - 100 * (19 / 39), 10);
    const mb = compare(questions, { cls: 'now', other: 'memory-bank' }, worlds);
    expect(mb.mask.kept).toBe(40);
    expect(mb.diffs[0].readers['claude-opus-5-5']).toBeCloseTo(2.5, 10);
    expect(mb.diffs[0].readers['particle-1']).toBeCloseTo(0, 10);
    expect(mb.diffs[0].d).toBeCloseTo(1.25, 10);
    q0.rows.gbrain!['claude-opus-5-5'] = { drop: 'judge_error' };
    expect(compare(questions, { cls: 'now', other: 'memory-bank' }, worlds).mask.kept).toBe(39);
    expect(compare(questions, { cls: 'now', other: 'extract-first' }, worlds).mask.kept).toBe(39);
  });

  test("the grep agent's turn-cap and context-overflow rates", () => {
    const { worlds, questions } = synth(1, {});
    const qs = questions.filter(q => q.cls === 'now');
    qs[0].rows['grep-agent']!['particle-1'] = { pass: 0, failure: 'turn_cap' };
    qs[1].rows['grep-agent']!['particle-1'] = { pass: 0, failure: 'context_overflow' };
    qs[2].rows['grep-agent']!['particle-1'] = { drop: 'reader_error' };
    const s = grepStops(questions, worlds);
    expect(s['particle-1']).toEqual({ answers: 63, turn_cap: 1, context_overflow: 1, turn_cap_rate: 1 / 63, context_overflow_rate: 1 / 63 });
    expect(s['claude-opus-5-5'].turn_cap).toBe(0);
  });
});

describe('beside the verdict', () => {
  test('cost per correct answer per reader and row, null when a world has no meter', () => {
    const { worlds, questions } = synth(2, { 'now|grep-agent': () => 4 });
    const costs = worlds.flatMap(world => WL_ROWS.flatMap(row => WL_READER_KEYS.map(reader => ({ row, reader, world, usd: 0.5 }))));
    const c = costPerCorrect(questions, worlds, costs);
    expect(c['claude-opus-5-5'].gbrain).toBeCloseTo(1 / 64, 12);
    expect(c['particle-1']['grep-agent']).toBeCloseTo(1 / 56, 12);
    expect(costPerCorrect(questions, worlds, costs.slice(1))['claude-opus-5-5'].gbrain).toBeNull();
  });

  test('the regression flag fires outside the previous interval by more than the weekly smallest detectable difference, on either side', () => {
    expect(regressionFlag(-10, [1, 5], 11.9)).toEqual({ flagged: false, direction: null });
    expect(regressionFlag(-11, [1, 5], 11.9)).toEqual({ flagged: true, direction: 'below' });
    expect(regressionFlag(17, [1, 5], 11.9)).toEqual({ flagged: true, direction: 'above' });
    expect(regressionFlag(null, [1, 5], 11.9).flagged).toBe(false);
    expect(regressionFlag(-40, null, 11.9).flagged).toBe(false);
  });

  test('the false-alarm rate is seeded and deterministic', () => {
    const pool = Array.from({ length: 32 }, (_, i) => ((i * 37) % 23) - 11);
    const a = falseAlarmRate(pool, weeklySdd(1), { sims: 2000 }), b = falseAlarmRate(pool, weeklySdd(1), { sims: 2000 });
    expect(a).toBe(b);
    expect(a!).toBeGreaterThanOrEqual(0);
    expect(a!).toBeLessThan(0.05);
    expect(falseAlarmRate(pool, 0, { sims: 2000 })!).toBeGreaterThan(a!);
    expect(falseAlarmRate([1], 5)).toBeNull();
  });

  test('the rolling display pools the last four weekly points and names their builds', () => {
    const p = (week: string, release: string, d: number) => ({ week, release, diffs: Object.fromEntries(WL_COMPARISONS.map(c => [c.key, [0, 1].map(k => ({ world: `bgw-${week.slice(-2)}${k}`, d: d + k, readers: { 'claude-opus-5-5': d, 'particle-1': d + 2 * k } }))])) });
    const r = rolling([p('2026-12-01', A, 100), p('2026-12-08', A, 1), p('2026-12-15', B, 2), p('2026-12-22', B, 3), p('2026-12-29', B, 4)]);
    expect(r.weeks).toEqual(['2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29']);
    expect(r.builds).toEqual([A, B]);
    const c = r.comparisons[0];
    expect(c.pooled.worlds).toBe(8);
    expect(c.pooled.mean).toBeCloseTo(3, 10);
    expect(estimate([1, 2]).ci95).not.toBeNull();
  });
});

// ─── The aggregates and their allow-list ─────────────────────────────

function meta(week: string, worlds: readonly string[], release: string): WeekMeta {
  return {
    week, gbrain: { release, commit: COMMIT }, comparators: { 'extract-first': { version: '1.4.2', fixed: '2026-11-19' }, 'memory-bank': { version: '0.9.0', fixed: '2026-11-19' } },
    worlds: worlds.map(world => ({ world, seed_id: 'W1', phrasing_id: 'W1' })),
    costs: worlds.flatMap(world => WL_ROWS.flatMap(row => WL_READER_KEYS.map(reader => ({ row, reader, world, usd: 0.25 })))),
  };
}

describe('the aggregates that leave custody', () => {
  const { worlds, questions } = synth(32, { 'now|grep-agent': alt(-3, -4), 'past|extract-first': alt(1, -1) });
  const metas = [0, 1, 2, 3].map(k => meta(`2026-12-${String(1 + 7 * k).padStart(2, '0')}`, worlds.slice(8 * k, 8 * k + 8), k < 2 ? A : B));
  const weeks: ReturnType<typeof weekAggregates>[] = [];
  for (const m of metas) weeks.push(weekAggregates(m, questions, { history: [...weeks] }));
  const block = blockAggregates(1, metas, questions, { draws: 199 });

  test('weekly and block aggregates pass their allow-lists, and a week carries no verdict word', () => {
    for (const w of weeks) assertAggregate(w, 'week');
    assertAggregate(block, 'block');
    const text = JSON.stringify(weeks);
    for (const word of ['"ahead"', '"behind"', 'level within', 'split by reader', 'no measurable']) expect(text).not.toContain(word);
    expect(weeks[3].rolling!.weeks).toHaveLength(4);
    expect(weeks[3].rolling!.builds).toEqual([A, B]);
    expect(weeks[3].rolling!.differences.now['grep-agent'].pooled.worlds).toBe(32);
    expect(block.comparisons.now['grep-agent'].word).toBe('behind');
    expect(block.comparisons.past['extract-first'].word).toBe('level within 3 points');
    expect(block.leading_competitor).toEqual({ now: 'extract-first', past: 'extract-first' });
  });

  test('a week after a block reads the regression flag against that block', () => {
    const next = synth(40, { 'now|grep-agent': i => (i < 32 ? -3 - (i % 2) : 4) });
    const later = weekAggregates(meta('2027-01-05', next.worlds.slice(32), B), next.questions, { history: weeks, previousBlock: block });
    assertAggregate(later, 'week');
    const f = later.regression!.now['grep-agent'];
    expect(f.flagged).toBe(true);
    expect(f.direction).toBe('above');
    expect(f.false_alarm_source).toBe('previous block');
    expect(later.regression!.past['grep-agent'].flagged).toBe(false);
    const supplied = weekAggregates(meta('2027-01-05', next.worlds.slice(32), B), next.questions, { history: weeks, previousBlock: block, falseAlarmPool: { 'now|grep-agent': [1, -1, 2, -2] } });
    expect(supplied.regression!.now['grep-agent'].false_alarm_source).toBe('supplied pool');
    expect(() => weekAggregates(meta('2027-01-05', worlds.slice(0, 8), B), questions, { history: weeks })).toThrow(/exactly one week/);
    expect(() => weekAggregates(meta('2027-01-05', next.worlds.slice(32), B), next.questions, { history: [...weeks, weeks[0]] })).toThrow(/repeats a week or a world/);
    expect(() => weekAggregates(meta('2026-12-22', next.worlds.slice(32), B), next.questions, { history: weeks })).toThrow(/already holds week/);
  });

  test('the writer refuses a field that could carry text, naming neither the value nor the key', () => {
    const smuggle = (f: (x: any) => void) => { const x = structuredClone(weeks[0]) as any; f(x); return x; };
    const secret = 'What city does Ana Ruiz live in now';
    const cases = [
      smuggle(x => { x.worlds[0].seed_id = secret; }),
      smuggle(x => { x.worlds[0].seed_id = 'Lisbon'; }),
      smuggle(x => { x.gbrain.release = 'v0.61.0.0 Lisbon'; }),
      smuggle(x => { x.comparators['memory-bank'].version = '1.0-Lisbon'; }),
      smuggle(x => { x.worlds[0].world = 'Ana Ruiz'; }),
      smuggle(x => { x.classes.now.means.gbrain.pooled = secret; }),
      smuggle(x => { x.worlds[0][secret] = 1; }),
      smuggle(x => { x.classes.now.differences['grep-agent'].question = secret; }),
      smuggle(x => { x.classes.now.differences['grep-agent'].word = 'ahead'; }),
      smuggle(x => { x.worlds[0].classes.now.differences['grep-agent'].pooled = Number.NaN; }),
    ];
    for (const c of cases) {
      expect(aggregateProblems(c, WEEK_SCHEMA).length).toBeGreaterThan(0);
      let message = '';
      try { assertAggregate(c, 'week'); } catch (e) { expect(e).toBeInstanceOf(WeeklyAggregateError); message = (e as Error).message; }
      expect(message).toStartWith('WEEKLY_AGGREGATE_FIELD:');
      expect(message).not.toContain('Lisbon');
      expect(message).not.toContain('Ana');
    }
    const path = join(tmp, 'refused.json');
    expect(() => writeAggregate(path, cases[0], 'week')).toThrow(WeeklyAggregateError);
    expect(existsSync(path)).toBe(false);
    const blockSmuggle = structuredClone(block) as any;
    blockSmuggle.comparisons.now['grep-agent'].per_world[0].world = 'bgw-1001:s1_updated:0';
    expect(() => assertAggregate(blockSmuggle, 'block')).toThrow(WeeklyAggregateError);
  });

  test('the scorecard and the block section render from the aggregates, in the outcome table\'s wording', () => {
    const md = renderWeek(weeks[3]);
    expect(md).toContain('# Weekly held-out line: week of 2026-12-22');
    expect(md).toContain('A weekly point carries no verdict word');
    expect(md).toContain(`gbrain ${A}, ${B}`.replace(`gbrain ${A}`, 'gbrain releases ' + A));
    expect(md).toContain('measures particle-1 as an agent');
    for (const word of ['ahead', 'behind', 'level within', 'split by reader']) expect(md).not.toContain(word);
    const page = renderBlock(block);
    expect(page).toContain(`32 counted worlds on gbrain releases ${A}, ${B}`);
    expect(page).toContain(`The look came at the 16th counted world (release ${A})`);
    expect(page).toMatch(new RegExp(`gbrain \\(release ${A.replace(/\./g, '\\.')}\\) is behind a grep agent on what is true now by 8\\.8 points \\(95% interval -\\d+\\.\\d to -\\d+\\.\\d\\), early, at the 16th counted world`));
    expect(page).toContain(`gbrain (releases ${A}, ${B}) is level with the extract-first server within 3 points on questions about the past`);
    expect(page).toContain('claude-opus-5-5');
    expect(page).toContain('particle-1');
    expect(renderWeek(weekAggregates({ ...meta('2026-12-29', [], B), no_point: 'no worlds' }, questions))).toContain('No point: no worlds.');
  });

  test('the block section words each outcome', () => {
    const ahead = synth(32, { 'now|grep-agent': alt(4, 5), 'past|memory-bank': alt(6, -6), 'now|memory-bank': (i, r) => (r === 'claude-opus-5-5' ? 6 + (i % 2) : -2 + (i % 2)) }, { base: { past: 12 } });
    const m4 = [0, 1, 2, 3].map(k => meta(`2026-12-${String(1 + 7 * k).padStart(2, '0')}`, ahead.worlds.slice(8 * k, 8 * k + 8), A));
    const page = renderBlock(blockAggregates(2, m4, ahead.questions, { draws: 99 }));
    expect(page).toContain(`gbrain (release ${A}) beats a grep agent on held-out questions about what is true now by`);
    expect(page).toContain('gbrain against the memory-bank server on questions about the past: no measurable difference at this sample size (claude-opus-5-5');
    expect(page).toContain('gbrain against the memory-bank server on what is true now: split by reader (claude-opus-5-5');
    const ceil = synth(32, {}, { base: { now: 40 } });
    expect(renderBlock(blockAggregates(3, m4.map((m, k) => ({ ...m, worlds: ceil.worlds.slice(8 * k, 8 * k + 8).map(world => ({ world, seed_id: 'W1', phrasing_id: 'W1' })) })), ceil.questions, { draws: 99 }))).toContain('gbrain against a grep agent on what is true now: ceiling');
  });
});

// ─── The end of a block ──────────────────────────────────────────────

describe('the end of a block', () => {
  const week = (k: number) => `2026-12-${String(1 + 7 * k).padStart(2, '0')}`;
  const { worlds, questions } = synth(24, { 'now|grep-agent': halves(alt(2, -1), alt(5, 4)), 'past|grep-agent': alt(4, 5) });
  const metas = [0, 1, 2].map(k => meta(week(k), worlds.slice(8 * k, 8 * k + 8), A));
  const open = blockAggregates(1, metas, questions, { draws: 99 });
  const done = blockAggregates(1, [...metas, { ...meta(week(3), [], A), no_point: 'custody host offline' as const }], questions, { draws: 99 });

  test('a block written after the look but before its fourth week entry gives only early words', () => {
    expect([open.ended, done.ended]).toEqual([false, true]);
    assertAggregate(open, 'block');
    const late = open.comparisons.now['grep-agent'], early = open.comparisons.past['grep-agent'];
    expect([late.look!.crossed, late.word, late.final]).toEqual([false, 'no verdict', null]);
    expect([early.early!.word, early.word]).toEqual(['ahead', 'ahead']);
    expect(done.comparisons.now['grep-agent'].final!.crossed).toBe(true);
    expect(done.comparisons.now['grep-agent'].word).toBe('ahead');
    const page = renderBlock(open);
    expect(page).toContain('gbrain against a grep agent on what is true now: no verdict, because the block has not ended.');
    expect(page).toContain('The block has not ended (3 of 4 weeks), so only early words stand.');
  });

  test('before the end, no comparison carries a word the look did not give', () => {
    const r = analyzeBlock(questions, counted(worlds), { ended: false, draws: 99 });
    for (const c of r.comparisons) expect(c.word).toBe(c.early?.word ?? 'no verdict');
  });

  test('a block refuses a repeated or non-consecutive week', () => {
    expect(() => blockAggregates(1, [metas[0], { ...metas[1], week: week(0) }], questions, { draws: 99 })).toThrow(/lists week 2026-12-01 twice/);
    expect(() => blockAggregates(1, [metas[0], metas[2]], questions, { draws: 99 })).toThrow(/consecutive, 7 days apart/);
    expect(() => blockAggregates(1, [metas[0], { ...metas[1], week: '2026-12-09' }], questions, { draws: 99 })).toThrow(/consecutive/);
  });
});

// ─── Records and the command line ────────────────────────────────────

const INSTRUMENT = instrumentFor('bg1');
const SYSTEM_OF = Object.fromEntries(Object.entries(WL_SYSTEMS).map(([s, r]) => [r, s])) as Record<WlRow, string>;
const READER_OF = Object.fromEntries(WL_READER_KEYS.map((k, i) => [k, WL_READERS[i]])) as Record<WlReaderKey, string>;

/** Answer and judgment records for synthetic values, one cell per row (particle-1 answers in the same cell, as a re-read's records read alike). */
function recordsOf(questions: readonly WlQuestion[]): { answers: AnswerRecord[]; judgments: JudgmentRecord[] } {
  const answers: AnswerRecord[] = [], judgments: JudgmentRecord[] = [];
  for (const q of questions) for (const row of WL_ROWS) for (const r of WL_READER_KEYS) {
    const c = q.rows[row]?.[r];
    if (!c) continue;
    const cell_id = `wl-${row}`, reader = READER_OF[r];
    const outcome = 'drop' in c ? c.drop : c.failure ?? 'scored';
    const a: AnswerRecord = { answer_id: answerId(cell_id, q.id, reader, 0), cell_id, realization_id: 'r0', question_id: q.id, conversation: q.world, system: SYSTEM_OF[row], arm: row, reader, replicate: 0, effort: 'medium', context_sha256: 'f'.repeat(64), text: 'synthetic', usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, provider_input_tokens: 1, latency_ms: 1, outcome: outcome as AnswerRecord['outcome'] };
    answers.push(a);
    if ('drop' in c || c.failure) continue;
    const judge = bg1JudgeOf(reader);
    judgments.push({ answer_id: a.answer_id, instrument_id: frontierInstrumentId(INSTRUMENT.id, judge), instrument_sha256: INSTRUMENT.sha256, judge, judge_replicate: 0, temperature: null, score: c.pass, parse_ok: true, raw_sha256: 'e'.repeat(64), outcome: 'scored', settings: { ...PER_READER_JUDGE_SETTINGS }, view: 'gating', judge_versions: ['synthetic-1'] });
  }
  return { answers, judgments };
}

describe('records', () => {
  const { worlds, questions } = synth(2, { 'past|grep-agent': () => 2 });
  const qs0 = questions.filter(q => q.world === worlds[0] && q.cls === 'now');
  qs0[0].rows['grep-agent']!['claude-opus-5-5'] = { pass: 0, failure: 'turn_cap' };
  qs0[1].rows['memory-bank']!['particle-1'] = { drop: 'reader_error' };
  const recs = recordsOf(questions);

  test("the cells' records give back the same values, with product failures 0 and harness failures and missing judgments dropped", () => {
    const back = questionsFromRecords(worlds, recs.answers, recs.judgments);
    expect(back).toEqual(questions);
    const missing = recs.judgments.filter(j => j.answer_id !== recs.answers.find(a => a.question_id === qs0[2].id && a.system === 'ext-extract-first' && a.reader === READER_OF['particle-1'])!.answer_id);
    expect(questionsFromRecords(worlds, recs.answers, missing).find(q => q.id === qs0[2].id)!.rows['extract-first']!['particle-1']).toEqual({ drop: 'judgment_missing' });
    expect(questionsFromRecords(worlds, [], []).every(q => Object.keys(q.rows).length === 0)).toBe(true);
    expect(plannedQuestions('bgw-1001')).toHaveLength(64);
  });

  test('refuses records outside the design', () => {
    const a0 = recs.answers[0];
    expect(() => questionsFromRecords(worlds, [{ ...a0, system: 'baseline-hybrid' }], [])).toThrow(WeeklyRecordsError);
    expect(() => questionsFromRecords(worlds, [{ ...a0, reader: 'openai:gpt-6.2-sol' }], [])).toThrow(/not one of the weekly line's readers/);
    expect(() => questionsFromRecords(worlds.slice(1), [a0], [])).toThrow(/outside the given worlds/);
    expect(() => questionsFromRecords(worlds, [{ ...a0, question_id: `${a0.conversation}:s1_updated:9` }], [])).toThrow(/not a planned question/);
    expect(() => questionsFromRecords(worlds, [a0, { ...a0, answer_id: 'd'.repeat(64) }], [])).toThrow(/two answers/);
    const own = recs.judgments.find(j => j.answer_id === recs.answers.find(a => a.reader === READER_OF['particle-1'] && a.outcome === 'scored')!.answer_id)!;
    expect(() => questionsFromRecords(worlds, recs.answers, [{ ...own, judge: 'particle:particle-1', instrument_id: frontierInstrumentId(INSTRUMENT.id, 'particle:particle-1') }])).toThrow(/gating judgment problem/);
    expect(() => questionsFromRecords(worlds, recs.answers, recs.judgments.map((j, i) => (i ? j : { ...j, score: 0.5 })))).toThrow(/pass \(1\) or fail \(0\)/);
  });

  test('the command line writes a week, a second week with its rolling display, and the block from record files', () => {
    const big = synth(16, { 'now|grep-agent': alt(-3, -4) });
    const r = recordsOf(big.questions);
    const out = join(tmp, 'run');
    const dirs = [big.worlds.slice(0, 8), big.worlds.slice(8)].map((ws, k) => {
      const root = join(tmp, `records-w${k + 1}`);
      for (const row of WL_ROWS) {
        const dir = join(root, 'cells', `wl-${row}`);
        mkdirSync(dir, { recursive: true });
        const ans = r.answers.filter(a => a.cell_id === `wl-${row}` && ws.includes(a.conversation)), ids = new Set(ans.map(a => a.answer_id));
        writeFileSync(join(dir, 'answers.ndjson'), ans.map(a => JSON.stringify(a)).join('\n') + '\n');
        writeFileSync(join(dir, 'judgments.ndjson'), r.judgments.filter(j => ids.has(j.answer_id)).map(j => JSON.stringify(j)).join('\n') + '\n');
      }
      return root;
    });
    const m1 = join(tmp, 'w1.json'), m2 = join(tmp, 'w2.json');
    writeFileSync(m1, JSON.stringify(meta('2026-12-01', big.worlds.slice(0, 8), A)));
    writeFileSync(m2, JSON.stringify(meta('2026-12-08', big.worlds.slice(8), B)));
    expect(() => main(['week', '--meta', m1, '--records', dirs[0], '--records', dirs[1], '--out', out])).toThrow(/outside the given worlds/);
    expect(main(['week', '--meta', m1, '--records', dirs[0], '--out', out])).toBe(0);
    expect(main(['week', '--meta', m2, '--records', dirs[1], '--history', join(out, 'week-2026-12-01.json'), '--out', out])).toBe(0);
    expect(main(['block', '--block', '1', '--meta', m1, '--meta', m2, '--records', dirs[0], '--records', dirs[1], '--out', out])).toBe(0);
    expect(() => main(['week', '--meta', m1, '--meta', m2, '--records', dirs[0], '--out', out])).toThrow(/exactly one --meta/);
    expect(() => main(['month', '--meta', m1, '--records', dirs[0], '--out', out])).toThrow(/week or block/);
    expect(() => main(['week', '--meta', m1, '--records', dirs[0]])).toThrow(/--out/);
    expect(() => main(['week', '--meta', m2, '--records', join(tmp, 'w1.json'), '--out', out])).toThrow(/no cells\/ directory/);
    const badPool = join(tmp, 'pool.json');
    writeFileSync(badPool, JSON.stringify({ 'now|grep-agent': ['Lisbon'] }));
    expect(() => main(['week', '--meta', m2, '--records', dirs[1], '--false-alarm-pool', badPool, '--out', out])).toThrow(/comparison keys to lists/);
    const badBlock = join(tmp, 'bad-block.json');
    writeFileSync(badBlock, JSON.stringify({ schema: 'gbrain-evals/weekly-line-block/v1', note: 'Lisbon' }));
    expect(() => main(['week', '--meta', m2, '--records', dirs[1], '--previous-block', badBlock, '--out', out])).toThrow(WeeklyAggregateError);
    const w2 = JSON.parse(readFileSync(join(out, 'week-2026-12-08.json'), 'utf8'));
    expect(w2.rolling.builds).toEqual([A, B]);
    const b = JSON.parse(readFileSync(join(out, 'block-1.json'), 'utf8'));
    expect(b.comparisons.now['grep-agent'].word).toBe('behind');
    expect(b.comparisons.now['grep-agent'].early.releases).toEqual([A, B]);
    expect(readFileSync(join(out, 'block-1.md'), 'utf8')).toContain('## Block 1 (weeks 2026-12-01 to 2026-12-08)');
    expect(readFileSync(join(out, 'week-2026-12-08.md'), 'utf8')).toContain(`gbrain ${B} (commit ${COMMIT.slice(0, 12)})`);
  });
});
