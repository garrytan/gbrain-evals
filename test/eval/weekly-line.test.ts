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
import { aggregateProblems, assertAggregate, blockAggregates, FALSE_ALARM_RECEIPT_SCHEMA, falseAlarmPoolSha256, main, WEEK_SCHEMA, weekAggregates, WeeklyAggregateError, writeAggregate, writeBlockFiles, boundRecords, type WeekMeta } from '../../eval/runner/weekly-line/aggregates.ts';
import { BG1C_CAMPAIGN, BG1C_DATASET } from '../../eval/runner/memory-qa/bg1-names.ts';
import { plannedQuestions, WL_CLASSES, WL_COMPARISONS, WL_OBF_BOUNDS, WL_READER_KEYS, WL_READERS, WL_ROWS, WL_SYSTEMS, type WlClass, type WlReaderKey, type WlRow } from '../../eval/runner/weekly-line/design.ts';
import { plannedFor, questionsFromRecords, WeeklyRecordsError, type WlQuestion } from '../../eval/runner/weekly-line/records.ts';
import { renderBlock, renderWeek } from '../../eval/runner/weekly-line/scorecard.ts';
import { recordDigests, SETTLED_FILE, SETTLED_SCHEMA } from '../../eval/runner/weekly-line/settled.ts';
import { RUN_FILE, runIdentity, type RunIdentity } from '../../eval/runner/weekly-line/identity.ts';
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

/** BG1-C's custody receipt for a false-alarm pool. */
const receiptOf = (pool: Record<string, number[]>) => ({ schema: FALSE_ALARM_RECEIPT_SCHEMA, campaign: BG1C_CAMPAIGN, dataset: BG1C_DATASET, comparisons: Object.keys(pool), pool_sha256: falseAlarmPoolSha256(pool) });

/** The stamp a run's cells write into every record (memory-qa/records.ts weekly_run). */
const stampOf = (run: Pick<RunIdentity, 'run_id' | 'week'>) => ({ run_id: run.run_id, week: run.week });

/** The runner's settled marker for each week, agreeing with its meta. */
const settledOf = (metas: readonly WeekMeta[]) => metas.map(m => ({
  schema: SETTLED_SCHEMA, run_id: m.run_id, week: m.week, no_point: m.no_point ?? null, gbrain: m.gbrain, worlds: m.no_point ? [] : m.worlds.map(w => w.world),
  steps: m.no_point ? { cells: 0, rereads: 0, judgments: 0, harness_failures: 0 } : { cells: 5, rereads: 3, judgments: 8, harness_failures: 0 },
}));

function meta(week: string, worlds: readonly string[], release: string): WeekMeta {
  return {
    week, run_id: `wl-${week}-${'a'.repeat(12)}`, gbrain: { release, commit: COMMIT }, comparators: { 'extract-first': { version: '1.4.2', fixed: '2026-11-19' }, 'memory-bank': { version: '0.9.0', fixed: '2026-11-19' } },
    worlds: worlds.map(world => ({ world, seed_id: 'W1', phrasing_id: 'W1' })),
    costs: worlds.flatMap(world => WL_ROWS.flatMap(row => WL_READER_KEYS.map(reader => ({ row, reader, world, usd: 0.25 })))),
  };
}

describe('the aggregates that leave custody', () => {
  const { worlds, questions } = synth(32, { 'now|grep-agent': alt(-3, -4), 'past|extract-first': alt(1, -1) });
  const metas = [0, 1, 2, 3].map(k => meta(`2026-12-${String(1 + 7 * k).padStart(2, '0')}`, worlds.slice(8 * k, 8 * k + 8), k < 2 ? A : B));
  const weeks: ReturnType<typeof weekAggregates>[] = [];
  for (const m of metas) weeks.push(weekAggregates(m, questions, { history: [...weeks] }));
  const block = blockAggregates(1, metas, questions, { draws: 199, settled: settledOf(metas) });

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

  // Value: protects=a W1-long world counts under its own seed id (W1-long, phrased from W1), and a week or block refuses a long world recorded as W1 or worlds of both lengths together, in its own worlds, its history or its previous block, so the 200,000-token line never pools or confuses a 1,000,000-token world; fails_when=the runner stamps long worlds W1, the aggregates' set id refuses W1-long, or a week or block counts both lengths; why_new=GBEV-3's follow-up to #625 (long worlds get their own seed_id so custody records can't confuse the two lengths); seam=aggregates.ts weekAggregates and blockAggregates over identity.ts worldSeedProblems; no_claim=the long worlds' own scores
  test('a long world counts as seed W1-long, and a week or block never mixes or confuses the two lengths', () => {
    const s = synth(8, {});
    const longIds = s.worlds.map(w => w.replace('bgw-10', 'bgw-20'));
    const longQs = JSON.parse(JSON.stringify(s.questions).replaceAll('bgw-10', 'bgw-20')) as WlQuestion[];
    const lm = { ...meta('2026-12-29', longIds, B), worlds: longIds.map(world => ({ world, seed_id: 'W1-long', phrasing_id: 'W1' })) };
    const wk = weekAggregates(lm, longQs);
    assertAggregate(wk, 'week');
    expect(wk.worlds.map(w => [w.seed_id, w.phrasing_id])).toEqual(longIds.map(() => ['W1-long', 'W1']));
    expect(() => weekAggregates(meta('2026-12-29', longIds, B), longQs)).toThrow("week 2026-12-29's worlds: bgw-2001 is seed set W1-long's world (phrasing W1), not seed W1 with phrasing W1");
    const mixed = { ...lm, worlds: [...lm.worlds.slice(0, 4), ...s.worlds.slice(4).map(world => ({ world, seed_id: 'W1', phrasing_id: 'W1' }))] };
    expect(() => weekAggregates(mixed, [...longQs, ...s.questions])).toThrow(/the worlds mix the long and standard lengths, which are never counted together/);
    const four = [...metas.slice(0, 3), { ...lm, week: metas[3].week, run_id: metas[3].run_id }];
    expect(() => blockAggregates(1, four, [...questions, ...longQs], { draws: 199, settled: settledOf(four) })).toThrow(/^block 1's worlds: the worlds mix the long and standard lengths/);
    expect(() => weekAggregates(lm, longQs, { history: weeks })).toThrow("week 2026-12-29 with its history and previous block: the worlds mix the long and standard lengths, which are never counted together");
    expect(() => weekAggregates(lm, longQs, { previousBlock: block })).toThrow(/^week 2026-12-29 with its history and previous block: the worlds mix the long and standard lengths/);
  });

  test('a week after a block reads the regression flag against that block', () => {
    const next = synth(40, { 'now|grep-agent': i => (i < 32 ? -3 - (i % 2) : 4) });
    const pool = { 'now|extract-first': [1, -1, 2, -2], 'now|memory-bank': [1, -1, 2, -2], 'past|extract-first': [1, -1, 2, -2], 'past|memory-bank': [1, -1, 2, -2] };
    const later = weekAggregates(meta('2027-01-05', next.worlds.slice(32), B), next.questions, { history: weeks, previousBlock: block, falseAlarmPool: pool, falseAlarmReceipt: receiptOf(pool) });
    assertAggregate(later, 'week');
    const f = later.regression!.now['grep-agent'];
    expect(f.flagged).toBe(true);
    expect(f.direction).toBe('above');
    expect(later.regression!.past['grep-agent'].flagged).toBe(false);
    expect(later.regression!.now['extract-first'].false_alarm_source).toBe('BG1-C pool');
    expect(() => weekAggregates(meta('2027-01-05', worlds.slice(0, 8), B), questions, { history: weeks })).toThrow(/exactly one week/);
    expect(() => weekAggregates(meta('2027-01-05', next.worlds.slice(32), B), next.questions, { history: [...weeks, weeks[0]] })).toThrow(/repeats a week or a world/);
    expect(() => weekAggregates(meta('2026-12-22', next.worlds.slice(32), B), next.questions, { history: weeks })).toThrow(/already holds week/);
  });

  test('the false-alarm rate comes only from BG1-C\'s pool, and the grep agent\'s is unavailable', () => {
    const next = synth(40, { 'now|grep-agent': i => (i < 32 ? -3 - (i % 2) : 4) });
    const pool = { 'now|extract-first': [1, -1, 2, -2], 'now|memory-bank': [1, -1, 2, -2], 'past|extract-first': [1, -1, 2, -2], 'past|memory-bank': [1, -1, 2, -2] };
    const at = (o: Parameters<typeof weekAggregates>[2]) => weekAggregates(meta('2027-01-05', next.worlds.slice(32), B), next.questions, { history: weeks, previousBlock: block, ...o });
    const ok = at({ falseAlarmPool: pool, falseAlarmReceipt: receiptOf(pool) }), g = ok.regression!.now['grep-agent'];
    expect([g.false_alarm_rate, g.false_alarm_source]).toEqual([null, 'unavailable']);
    expect(ok.regression!.now['extract-first'].false_alarm_source).toBe('BG1-C pool');
    expect(renderWeek(ok)).toContain('unavailable (no registered calibration)');
    const short = { ...pool, 'now|extract-first': [1] }, nan = { ...pool, 'now|extract-first': [1, Number.NaN] };
    expect(() => at({ falseAlarmPool: short, falseAlarmReceipt: receiptOf(short) })).toThrow(/at least two of BG1-C's per-world differences/);
    expect(() => at({ falseAlarmPool: nan, falseAlarmReceipt: receiptOf(nan) })).toThrow(/each a finite number/);
    expect(() => at({ falseAlarmPool: { ...pool, 'now|grep-agent': [1, -1] } })).toThrow(/never ran the grep agent/);
  }, 60_000);

  // Value: protects=no flag line publishes a false-alarm rate labelled BG1-C unless BG1-C's custody receipt vouches for the pool by its SHA-256; fails_when=a pool with no receipt, or with a receipt for other numbers, another campaign or other comparisons, publishes a rate (#611 read-only review blocker 4); why_new=GBEV-3 ruling on #611, 2026-11-23; seam=aggregates.ts weekAggregates over falseAlarmPoolProblems; no_claim=forged receipts with recomputed hashes, outside the crew's threat model
  test('without BG1-C\'s custody receipt for the pool, every false-alarm rate is unavailable', () => {
    const next = synth(40, { 'now|grep-agent': i => (i < 32 ? -3 - (i % 2) : 4) });
    const pool = { 'now|extract-first': [1, -1, 2, -2], 'now|memory-bank': [1, -1, 2, -2], 'past|extract-first': [1, -1, 2, -2], 'past|memory-bank': [1, -1, 2, -2] };
    const at = (o: Parameters<typeof weekAggregates>[2]) => weekAggregates(meta('2027-01-05', next.worlds.slice(32), B), next.questions, { history: weeks, previousBlock: block, ...o });
    const rates = (w: ReturnType<typeof at>) => WL_COMPARISONS.map(c => [w.regression![c.cls][c.other].false_alarm_rate, w.regression![c.cls][c.other].false_alarm_source]);
    const none = Array(6).fill([null, 'unavailable']);
    expect(rates(at({}))).toEqual(none);
    expect(rates(at({ falseAlarmPool: pool }))).toEqual(none);
    expect(rates(at({ falseAlarmPool: pool, falseAlarmReceipt: receiptOf(pool) })).filter(([, s]) => s === 'BG1-C pool')).toHaveLength(4);
    const other = { ...pool, 'now|extract-first': [9, -9, 9, -9] };
    expect(() => at({ falseAlarmPool: other, falseAlarmReceipt: receiptOf(pool) })).toThrow(/SHA-256 does not match its custody receipt/);
    expect(() => at({ falseAlarmPool: pool, falseAlarmReceipt: { ...receiptOf(pool), campaign: 'q1-scoreboard-bg1-changing-facts' } })).toThrow(/does not name BG1-C's campaign/);
    expect(() => at({ falseAlarmPool: pool, falseAlarmReceipt: { ...receiptOf(pool), comparisons: ['now|extract-first'] } })).toThrow(/other comparisons than the pool/);
    expect(() => at({ falseAlarmPool: pool, falseAlarmReceipt: { pool_sha256: falseAlarmPoolSha256(pool) } })).toThrow(/is not a gbrain-evals\/weekly-line-false-alarm-pool-receipt\/v1 receipt/);
    expect(() => at({ falseAlarmReceipt: receiptOf(pool) })).toThrow(/without its pool/);
  }, 60_000);

  test('a constant nonzero gap writes a null z beside its crossing', () => {
    const flat = synth(32, { 'now|grep-agent': () => 4 });
    const m4 = [0, 1, 2, 3].map(k => meta(`2026-12-${String(1 + 7 * k).padStart(2, '0')}`, flat.worlds.slice(8 * k, 8 * k + 8), A));
    const c = blockAggregates(1, m4, flat.questions, { draws: 99, settled: settledOf(m4) }).comparisons.now['grep-agent'];
    expect([c.look!.z, c.look!.crossed, c.final!.z, c.final!.crossed]).toEqual([null, true, null, true]);
  });

  test('a point week refuses a world with no answer records', () => {
    const bare = questions.map(q => (q.world === worlds[3] ? { ...q, rows: {} } : q));
    expect(() => weekAggregates(metas[0], bare)).toThrow(/a world with no answer records/);
    expect(() => blockAggregates(1, metas, bare, { draws: 99 })).toThrow(/a world with no answer records/);
  });

  test('a week refuses a repeated, stray or negative spend', () => {
    const m = metas[0], c0 = m.costs![0];
    expect(() => weekAggregates({ ...m, costs: [...m.costs!, c0] }, questions)).toThrow(/spend for one reader and world twice/);
    expect(() => weekAggregates({ ...m, costs: [...m.costs!.slice(1), { ...c0, usd: -1 }] }, questions)).toThrow(/finite number of at least 0/);
    expect(() => weekAggregates({ ...m, costs: [...m.costs!, { ...c0, world: worlds[8] }] }, questions)).toThrow(/a world outside the week/);
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
    const page = renderBlock(blockAggregates(2, m4, ahead.questions, { draws: 99, settled: settledOf(m4) }));
    expect(page).toContain(`gbrain (release ${A}) beats a grep agent on held-out questions about what is true now by`);
    expect(page).toContain('gbrain against the memory-bank server on questions about the past: no measurable difference at this sample size (claude-opus-5-5');
    expect(page).toContain('gbrain against the memory-bank server on what is true now: split by reader (claude-opus-5-5');
    const ceil = synth(32, {}, { base: { now: 40 } });
    const mc = m4.map((m, k) => ({ ...m, worlds: ceil.worlds.slice(8 * k, 8 * k + 8).map(world => ({ world, seed_id: 'W1', phrasing_id: 'W1' })) }));
    expect(renderBlock(blockAggregates(3, mc, ceil.questions, { draws: 99, settled: settledOf(mc) }))).toContain('gbrain against a grep agent on what is true now: ceiling');
  });
});

// ─── The end of a block ──────────────────────────────────────────────

describe('the end of a block', () => {
  const week = (k: number) => `2026-12-${String(1 + 7 * k).padStart(2, '0')}`;
  const { worlds, questions } = synth(24, { 'now|grep-agent': halves(alt(2, -1), alt(5, 4)), 'past|grep-agent': alt(4, 5) });
  const metas = [0, 1, 2].map(k => meta(week(k), worlds.slice(8 * k, 8 * k + 8), A));
  const open = blockAggregates(1, metas, questions, { draws: 99 });
  const four = [...metas, { ...meta(week(3), [], A), no_point: 'custody host offline' as const }];
  const done = blockAggregates(1, four, questions, { draws: 99, settled: settledOf(four) });

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

  test('before the end, a block file holds no per-kind rows or exposure and labels its estimate so far', () => {
    const exposure = blockAggregates(1, metas, questions, { draws: 99, exposure: {} }).exposure;
    expect([open.per_kind, exposure]).toEqual([null, null]);
    expect(done.per_kind).not.toBeNull();
    const page = renderBlock(open);
    expect(page).not.toContain('### Per kind');
    expect(page).toContain('early, at the 16th counted world. The block so far (');
    expect(renderBlock(done)).toContain('early, at the 16th counted world. The full block (');
  });

  // Value: protects=a block ends only when all four weeks carry the runner's settled marker, so a fourth week still running (one world with one record) never ends it; fails_when=ended reads only the number of week entries (#611 read-only review blocker 1, aggregates.ts:322), or a marker from another week, build or world list settles a week; why_new=GBEV-3 ruling on #611, 2026-11-23; seam=aggregates.ts blockAggregates over settled.ts settledProblems; no_claim=the runner writes the marker only when every step is done (weekly-line-runner.test.ts)
  test('a fourth week that is still running does not end the block, and a marker must agree with its week', () => {
    const { worlds: w4, questions: q4 } = synth(32, { 'now|grep-agent': alt(4, 5) });
    const m4 = [0, 1, 2, 3].map(k => meta(week(k), w4.slice(8 * k, 8 * k + 8), A));
    const partial = [...m4.slice(0, 3), meta(week(3), w4.slice(24, 25), A)];
    const oneRecord = q4.filter(q => q.world !== w4[24] || q.id === `${w4[24]}:s1_updated:0`);
    const running = blockAggregates(1, partial, oneRecord, { draws: 99, settled: settledOf(partial.slice(0, 3)) });
    expect(running.ended).toBe(false);
    expect(Object.values(running.comparisons).flatMap(c => Object.values(c)).every(c => c.final === null)).toBe(true);
    expect(blockAggregates(1, m4, q4, { draws: 99 }).ended).toBe(false);
    expect(blockAggregates(1, m4, q4, { draws: 99, settled: settledOf(m4) }).ended).toBe(true);
    const marks = settledOf(m4);
    expect(() => blockAggregates(1, m4, q4, { draws: 99, settled: [...marks.slice(0, 3), { ...marks[3], worlds: marks[3].worlds.slice(1) }] })).toThrow(/names other worlds than its meta/);
    expect(() => blockAggregates(1, m4, q4, { draws: 99, settled: [...marks.slice(0, 3), { ...marks[3], gbrain: { release: B, commit: COMMIT } }] })).toThrow(/another gbrain build/);
    expect(() => blockAggregates(1, m4, q4, { draws: 99, settled: [...marks, marks[3]] })).toThrow(/more than one settled marker/);
    expect(() => blockAggregates(1, m4.slice(0, 3), q4, { draws: 99, settled: marks })).toThrow(/a week outside the block/);
    expect(() => blockAggregates(1, m4, q4, { draws: 99, settled: [...marks.slice(0, 3), { ...marks[3], schema: 'other' }] })).toThrow(/is not a gbrain-evals\/weekly-line-settled\/v1 marker/);
    expect(() => blockAggregates(1, m4, q4, { draws: 99, settled: [...marks.slice(0, 3), { ...marks[3], steps: { cells: 0, rereads: 0, judgments: 0, harness_failures: 0 } }] })).toThrow(/no cells or judgments/);
  });

  // Value: protects=an open block publishes no simultaneous interval and no wild bootstrap p-value, which are end-of-block readings and would otherwise be an interim test outside the one look; fails_when=an open block file carries either (#611 read-only review blocker 2, aggregates.ts:342-343); why_new=GBEV-3 ruling on #611, 2026-11-23 (R113 integrity); seam=aggregates.ts blockAggregates; no_claim=the look's own z, which the look publishes by design
  test('before the end, a block file holds no simultaneous interval and no wild bootstrap', () => {
    const all = (b: typeof open) => Object.values(b.comparisons).flatMap(c => Object.values(c));
    expect(all(open).every(c => c.simultaneous === null && c.wild === null)).toBe(true);
    expect(all(done).every(c => c.simultaneous !== null)).toBe(true);
    expect(all(done).some(c => c.wild !== null)).toBe(true);
    assertAggregate(open, 'block');
    assertAggregate(done, 'block');
  });

  // Value: protects=an ended block-<n>.json is never replaced by an open one, so re-running a block on three of its weeks after the four-week write cannot erase its verdict; fails_when=the writer overwrites an ended file with an open block, or an unreadable existing file (#611 read-only review blocker 3); why_new=GBEV-3 ruling on #611, 2026-11-23 (R113 integrity); seam=aggregates.ts writeBlockFiles and main's block mode; no_claim=replacing one ended file with another ended file, which a corrected recount may need
  test('an ended block file is never replaced by an open one', () => {
    const out = mkdtempSync(join(tmp, 'ended-'));
    const path = writeBlockFiles(out, done);
    const before = readFileSync(path, 'utf8');
    expect(() => writeBlockFiles(out, open)).toThrow(/WEEKLY_BLOCK_ENDED/);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(writeBlockFiles(out, done)).toBe(path);
    const fresh = mkdtempSync(join(tmp, 'open-'));
    writeBlockFiles(fresh, open);
    expect(writeBlockFiles(fresh, done)).toBe(join(fresh, 'block-1.json'));
    const broken = mkdtempSync(join(tmp, 'broken-'));
    writeFileSync(join(broken, 'block-1.json'), '{');
    expect(() => writeBlockFiles(broken, open)).toThrow(/not readable JSON/);
  });

  test('a week refuses a previous block that has not ended', () => {
    expect(() => weekAggregates(metas[0], questions, { previousBlock: open })).toThrow(/previous block has not ended/);
  });

  test('before the end, no comparison carries a word the look did not give', () => {
    const r = analyzeBlock(questions, counted(worlds), { ended: false, draws: 99 });
    for (const c of r.comparisons) expect(c.word).toBe(c.early?.word ?? 'no verdict');
  });

  test('a block refuses a repeated or non-consecutive week', () => {
    const at = (m: WeekMeta, w: string): WeekMeta => ({ ...m, week: w, run_id: `wl-${w}-${'a'.repeat(12)}` });
    expect(() => blockAggregates(1, [metas[0], at(metas[1], week(0))], questions, { draws: 99 })).toThrow(/lists week 2026-12-01 twice/);
    expect(() => blockAggregates(1, [metas[0], metas[2]], questions, { draws: 99 })).toThrow(/consecutive, 7 days apart/);
    expect(() => blockAggregates(1, [metas[0], at(metas[1], '2026-12-09')], questions, { draws: 99 })).toThrow(/consecutive/);
    expect(() => blockAggregates(1, [metas[0], at(metas[1], '2026-13-01')], questions, { draws: 99 })).toThrow(/is not a date/);
    expect(() => blockAggregates(1, [at(metas[0], '2027-02-23'), at(metas[1], '2027-02-30')], questions, { draws: 99 })).toThrow(/2027-02-30 is not a date/);
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
    expect(() => questionsFromRecords(worlds, recs.answers, [...recs.judgments, recs.judgments[0]])).toThrow(/two gating judgments for one answer/);
    const reread = recs.answers.findIndex(a => a.system === SYSTEM_OF['memory-bank'] && a.reader === READER_OF['particle-1']);
    expect(() => questionsFromRecords(worlds, recs.answers.map((a, i) => (i === reread ? { ...a, context_sha256: '0'.repeat(64) } : a)), recs.judgments)).toThrow(/re-read in row memory-bank read a different context/);
    const grep = recs.answers.findIndex(a => a.system === SYSTEM_OF['grep-agent'] && a.reader === READER_OF['particle-1']);
    expect(() => questionsFromRecords(worlds, recs.answers.map((a, i) => (i === grep ? { ...a, context_sha256: '0'.repeat(64) } : a)), recs.judgments)).not.toThrow();
  });

  test('the command line writes a week, a second week with its rolling display, and the block from record files', () => {
    const big = synth(16, { 'now|grep-agent': alt(-3, -4) });
    const r = recordsOf(big.questions);
    const out = join(tmp, 'run');
    const runOf = (week: string, ws: readonly string[], release: string, k: number) => {
      const m = meta(week, ws, release);
      return runIdentity({ week, world_end: '2026-11-29', batch: 'bgw-1001', week_of_batch: k, spares_from: null, gbrain: m.gbrain, comparators: m.comparators, worlds: m.worlds, cells: WL_ROWS.map(row => `wl-${row}`), rereads: [], no_point: null });
    };
    const runs = [runOf('2026-12-01', big.worlds.slice(0, 8), A, 1), runOf('2026-12-08', big.worlds.slice(8), B, 2)];
    const dirs = [big.worlds.slice(0, 8), big.worlds.slice(8)].map((ws, k) => {
      const root = join(tmp, `records-w${k + 1}`);
      const stamp = (x: object) => JSON.stringify({ ...x, weekly_run: stampOf(runs[k]) });
      for (const row of WL_ROWS) {
        const dir = join(root, 'cells', `wl-${row}`);
        mkdirSync(dir, { recursive: true });
        const ans = r.answers.filter(a => a.cell_id === `wl-${row}` && ws.includes(a.conversation)), ids = new Set(ans.map(a => a.answer_id));
        writeFileSync(join(dir, 'answers.ndjson'), ans.map(stamp).join('\n') + '\n');
        writeFileSync(join(dir, 'judgments.ndjson'), r.judgments.filter(j => ids.has(j.answer_id)).map(stamp).join('\n') + '\n');
      }
      return root;
    });
    runs.forEach((run, k) => writeFileSync(join(dirs[k], RUN_FILE), JSON.stringify(run)));
    const m1 = join(tmp, 'w1.json'), m2 = join(tmp, 'w2.json'), s1 = join(tmp, 's1.json'), s2 = join(tmp, 's2.json');
    const metaObjs = [{ ...meta('2026-12-01', big.worlds.slice(0, 8), A), run_id: runs[0].run_id }, { ...meta('2026-12-08', big.worlds.slice(8), B), run_id: runs[1].run_id }];
    writeFileSync(m1, JSON.stringify(metaObjs[0]));
    writeFileSync(m2, JSON.stringify(metaObjs[1]));
    settledOf(metaObjs).forEach((s, k) => {
      const marker = JSON.stringify({ ...s, records: recordDigests(dirs[k]) });
      writeFileSync([s1, s2][k], marker);
      writeFileSync(join(dirs[k], SETTLED_FILE), marker);
    });
    expect(() => main(['week', '--meta', m1, '--records', dirs[0], '--records', dirs[1], '--out', out])).toThrow(/not the run of any week passed with --meta/);
    expect(main(['week', '--meta', m1, '--records', dirs[0], '--out', out])).toBe(0);
    expect(main(['week', '--meta', m2, '--records', dirs[1], '--history', join(out, 'week-2026-12-01.json'), '--out', out])).toBe(0);
    expect(() => main(['block', '--block', '1', '--meta', m1, '--meta', m2, '--records', dirs[0], '--records', dirs[1], '--settled', s1, '--out', out])).toThrow(/^WEEKLY_NOT_SETTLED: .*week 2026-12-08 has no settled marker/);
    expect(main(['block', '--block', '1', '--meta', m1, '--meta', m2, '--records', dirs[0], '--records', dirs[1], '--settled', s1, '--settled', s2, '--out', out])).toBe(0);
    expect(() => main(['week', '--meta', m1, '--meta', m2, '--records', dirs[0], '--out', out])).toThrow(/exactly one --meta/);
    expect(() => main(['month', '--meta', m1, '--records', dirs[0], '--out', out])).toThrow(/week or block/);
    expect(() => main(['week', '--meta', m1, '--records', dirs[0]])).toThrow(/--out/);
    expect(() => main(['week', '--meta', m2, '--records', join(tmp, 'w1.json'), '--out', out])).toThrow(/has no run\.json/);
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

  // Value: protects=the aggregates score exactly one week's run: its run id, week, frozen gbrain build and Set W world ids, and refuse records of any other run or week; fails_when=a record directory of another run or week, a record from a cell outside the run, an edited run identity, a meta naming another build or worlds, or a week whose run passed no records is scored; why_new=weekly-line preregistration "Harness" item 4 and harness PR (d)'s brief; seam=aggregates.ts boundRecords over identity.ts runBindingProblems and recordBindingProblems; no_claim=forged identities with recomputed ids, outside the crew's threat model
  test("the aggregates score exactly the week's run and refuse records of another run or week", () => {
    const small = synth(4, {});
    const recs = recordsOf(small.questions);
    const cells = WL_ROWS.map(row => `wl-${row}`);
    const runFor = (week: string, ws: readonly string[], release = A) => {
      const m = meta(week, ws, release);
      return { m, run: runIdentity({ week, world_end: '2026-11-29', batch: 'bgw-1001', week_of_batch: 1, spares_from: null, gbrain: m.gbrain, comparators: m.comparators, worlds: m.worlds, cells, rereads: [], no_point: null }) };
    };
    const dirFor = (name: string, run: object, ws: readonly string[], answers = recs.answers) => {
      const root = join(tmp, name);
      const stamp = (x: object) => JSON.stringify({ ...x, weekly_run: stampOf(run as RunIdentity) });
      for (const cell of new Set(answers.map(a => a.cell_id))) {
        const dir = join(root, 'cells', cell);
        mkdirSync(dir, { recursive: true });
        const ans = answers.filter(a => a.cell_id === cell && ws.includes(a.conversation)), ids = new Set(ans.map(a => a.answer_id));
        writeFileSync(join(dir, 'answers.ndjson'), ans.map(stamp).join('\n') + '\n');
        writeFileSync(join(dir, 'judgments.ndjson'), recs.judgments.filter(j => ids.has(j.answer_id)).map(stamp).join('\n') + '\n');
      }
      writeFileSync(join(root, RUN_FILE), JSON.stringify(run));
      const r = run as RunIdentity;
      writeFileSync(join(root, SETTLED_FILE), JSON.stringify({ schema: SETTLED_SCHEMA, run_id: r.run_id, week: r.week, no_point: null, gbrain: r.gbrain, worlds: r.worlds.map(w => w.world),
        steps: { cells: 4, rereads: 0, judgments: 4, harness_failures: 0 }, records: recordDigests(root) }));
      return root;
    };
    const ws1 = small.worlds.slice(0, 2), ws2 = small.worlds.slice(2);
    const w1 = runFor('2026-12-01', ws1), w2 = runFor('2026-12-08', ws2);
    const d1 = dirFor('bind-w1', w1.run, ws1), d2 = dirFor('bind-w2', w2.run, ws2);
    const m1 = { ...w1.m, run_id: w1.run.run_id }, m2 = { ...w2.m, run_id: w2.run.run_id };
    expect(boundRecords([d1], [m1]).answers.length).toBeGreaterThan(0);
    expect(() => boundRecords([d2], [m1])).toThrow(/not the run of any week passed with --meta/);
    expect(() => boundRecords([d1, d1], [m1])).toThrow(/passed twice/);
    expect(() => boundRecords([], [m1])).toThrow(/has no records passed with --records/);
    expect(() => boundRecords([d1], [{ ...m1, gbrain: { release: B, commit: COMMIT } }])).toThrow(/WEEKLY_RUN_IDENTITY: .*another gbrain build/);
    expect(() => boundRecords([d1], [{ ...m1, worlds: m1.worlds.slice(1) }])).toThrow(/not week 2026-12-01's Set W worlds/);
    const edited = dirFor('bind-edited', { ...w1.run, gbrain: { release: B, commit: COMMIT } }, ws1);
    expect(() => boundRecords([edited], [{ ...m1, gbrain: { release: B, commit: COMMIT } }])).toThrow(/does not match its own contents/);
    const stray = dirFor('bind-stray', w1.run, ws1, recs.answers.map(a => (a.cell_id === 'wl-gbrain' ? { ...a, cell_id: 'wl-gbrain-other-run', answer_id: answerId('wl-gbrain-other-run', a.question_id, a.reader, 0) } : a)));
    expect(() => boundRecords([stray], [m1])).toThrow(/1 cell in run .* is not among its cells and re-reads/);
    const wide = dirFor('bind-wide', w1.run, small.worlds);
    expect(() => boundRecords([wide], [m1])).toThrow(/on a world outside its week/);
    const both = boundRecords([d1, d2], [m1, m2]);
    expect(new Set(both.answers.map(a => a.conversation))).toEqual(new Set(small.worlds));
    expect(() => weekAggregates({ ...m1, run_id: 'wl-2026-12-08-aaaaaaaaaaaa' }, small.questions)).toThrow(/names no run of that week/);
    const wk = weekAggregates(m1, small.questions);
    expect(wk.run_id).toBe(w1.run.run_id);
    assertAggregate(wk, 'week');
    expect(blockAggregates(1, [m1, m2], small.questions, { draws: 19 }).weeks.map(w => w.run_id)).toEqual([w1.run.run_id, w2.run.run_id]);
    const marks = settledOf([m1, m2]);
    expect(() => blockAggregates(1, [m1, m2], small.questions, { draws: 19, settled: [marks[0], { ...marks[1], run_id: w1.run.run_id }] })).toThrow(/settles run .*, not the week's run/);
  });
});
