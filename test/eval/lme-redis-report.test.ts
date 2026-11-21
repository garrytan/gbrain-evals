import { describe, expect, test } from 'bun:test';
import * as R from '../../eval/runner/batch/lme-redis-report.ts';

describe('LongMemEval on Redis harness: statistics', () => {
  test('McNemar counts the discordant pairs and gives the exact two-sided p', () => {
    const a = [1, 1, 1, 1, 0, 0, 1, 1, 0, 1] as (0 | 1)[];
    const b = [0, 0, 0, 1, 0, 1, 1, 1, 0, 0] as (0 | 1)[];
    const m = R.mcnemar(a, b);
    expect([m.b, m.c]).toEqual([4, 1]);
    expect(m.z).toBeCloseTo(3 / Math.sqrt(5), 10);
    expect(m.exact_p).toBeCloseTo(0.375, 10);
    expect(R.mcnemar([1, 0] as (0 | 1)[], [1, 0] as (0 | 1)[]).exact_p).toBe(1);
  });

  test('the paired bootstrap reproduces from its seed and brackets the estimate', () => {
    const a = Array.from({ length: 200 }, (_, i) => (i % 3 ? 1 : 0)) as (0 | 1)[];
    const b = Array.from({ length: 200 }, (_, i) => (i % 4 ? 1 : 0)) as (0 | 1)[];
    const one = R.pairedDiff(a, b, 7, 2000);
    expect(R.pairedDiff(a, b, 7, 2000)).toEqual(one);
    expect(one.ci95[0]).toBeLessThan(one.diff_points);
    expect(one.ci95[1]).toBeGreaterThan(one.diff_points);
  });

  test('Holm adjusts step-down and stays monotone', () => {
    expect(R.holm([0.01, 0.04, 0.03, 0.2])).toEqual([0.04, 0.09, 0.09, 0.2]);
  });

  test('Wilson and the smallest detectable difference match the preregistration\'s worked figures', () => {
    const [lo, hi] = R.wilson(450, 500);
    expect((hi - lo) / 2).toBeCloseTo(0.026, 2);
    expect(R.sdd(0.08)).toBeCloseTo(3.57, 2);
    expect(R.sdd(0.06)).toBeCloseTo(3.09, 2);
    expect(R.sdd(0.1)).toBeCloseTo(3.99, 2);
  });

  test('the interim look stops at |z| ≥ 2.80, stops for futility below 10% conditional power, else continues', () => {
    expect(R.interimDecision(2.9).decision).toBe('stop-difference');
    expect(R.interimDecision(-2.85).decision).toBe('stop-difference');
    expect(R.interimDecision(1.5).decision).toBe('continue');
    expect(R.conditionalPower(2.0)).toBeGreaterThan(R.conditionalPower(1.0));
    // Under the planned alternative in the observed direction, conditional power at half the units never falls below
    // about 21% (its value at z = 0), so the preregistered 10% futility stop cannot trigger at this look.
    const grid = Array.from({ length: 561 }, (_, i) => -2.8 + i * 0.01).map(z => R.conditionalPower(z));
    expect(Math.min(...grid)).toBeCloseTo(1 - R.normalCdf((1.98 - 2.82 * 0.5) / Math.sqrt(0.5)), 3);
    expect(Math.min(...grid)).toBeGreaterThan(0.2);
    expect(R.interimDecision(0).decision).toBe('continue');
    expect(R.interimDecision(0.0001).conditional_power).toBeCloseTo(R.interimDecision(-0.0001).conditional_power, 3);
  });

  test('kappa, raw agreement and the confusion matrix', () => {
    const pairs: [0 | 1, 0 | 1][] = [[1, 1], [1, 1], [1, 0], [0, 0], [0, 0], [0, 1], [1, 1], [0, 0]];
    const k = R.kappa(pairs);
    expect(k.matrix).toEqual({ yy: 3, yn: 1, ny: 1, nn: 3 });
    expect(k.agreement).toBe(0.75);
    expect(k.kappa).toBeCloseTo(0.5, 10);
  });

  test('task-averaged accuracy follows the vendored compute_metrics, counting only parsed verdicts', () => {
    const rows = [{ question_type: 'a', verdict: 1 }, { question_type: 'a', verdict: 0 }, { question_type: 'b', verdict: 1 }, { question_type: 'b', verdict: -1 }, { question_type: 'c', verdict: null }] as any;
    expect(R.taskAveraged(rows)).toBe(0.75);
    const [lo, hi] = R.stratifiedBootstrap(rows, 3, 500);
    expect(lo).toBeLessThanOrEqual(0.75);
    expect(hi).toBeGreaterThanOrEqual(0.75);
  });
});

describe('LongMemEval on Redis harness: scoring rows', () => {
  const order = ['q1', 'q2', 'q3'];
  const line = (q: string, arm: string) => ({ question_id: q, question_type: 'multi-session', arm, messages: [], messages_sha256: '', context_sha256: `${arm}-${q}` });
  const lines = Object.fromEntries(['off', 'on', 'agent-default', 'full', 'oracle'].map(a => [a, new Map(order.map(q => [q, line(q, a)]))])) as any;
  const ok = (text: string) => ({ status: 'succeeded', text, finish: 'stop' }) as any;

  test('a reused answer takes its source arm\'s answer and both judgments', () => {
    const rows = R.scoreRows({
      order, types: new Map(order.map(q => [q, 'multi-session'])), lines,
      reuse: { opus: { on: { q1: 'off', q3: 'off' } } },
      answers: (reader, m) => new Map(order.map(q => [q, { answer: `${reader} ${m} ${q}`, truncated: false }])),
      judged: (arm, role) => new Map(order.map(q => [q, ok(arm.startsWith('opus--off') ? (q === 'q2' ? 'no' : 'Yes') : arm.startsWith('opus--on') ? 'yes' : role === 'protocol' ? 'yes' : 'No.')])),
    });
    const on = rows.filter(r => r.reader === 'opus' && r.memories === 'on');
    expect(on.map(r => [r.question_id, r.answered_by, r.answer, r.cross])).toEqual([['q1', 'off', 'opus off q1', 1], ['q2', 'on', 'opus on q2', 1], ['q3', 'off', 'opus off q3', 1]]);
    const c = R.compare(rows, 'opus', 'off', 'on');
    expect([c.b, c.c, c.scored, c.enough]).toEqual([0, 1, 3, true]);
    expect(R.compare(rows, 'opus', 'off', 'on', undefined, new Set(['q2'])).scored).toBe(2);
  });

  test('after a stop at the interim look, every on comparison and the on rows count only the on arm\'s questions', () => {
    const rows = R.scoreRows({
      order, types: new Map(order.map(q => [q, 'multi-session'])), lines,
      reuse: { opus: { on: { q3: 'off' } } },
      answers: (reader, m) => new Map(order.map(q => [q, { answer: `${reader} ${m} ${q}`, truncated: false }])),
      judged: () => new Map(order.map(q => [q, ok('yes')])),
    });
    const all = R.analyse(rows);
    const stopped = R.analyse(rows, undefined, new Set(), new Set(['q1', 'q2']));
    expect([all.primary.scored, 'passes_final_bound' in all.primary]).toEqual([3, true]);
    expect([stopped.primary.scored, (stopped.primary as any).stopped_at_interim_look, 'passes_final_bound' in stopped.primary]).toEqual([2, true, false]);
    expect(stopped.secondaries.slice(0, 3).map(s => s.scored)).toEqual([2, 2, 2]);
    expect(stopped.secondaries[3].scored).toBe(3);
    const onRow = stopped.accuracy.find(([c]) => c.reader === 'opus' && c.memories === 'on')!;
    expect(onRow[0].of).toBe(2);
  });

  test('an unparsable cross-family reply leaves the question unscored in the pair, and the 98% rule notices', () => {
    const rows = R.scoreRows({
      order, types: new Map(), lines, reuse: {},
      answers: () => new Map(order.map(q => [q, { answer: 'x', truncated: false }])),
      judged: arm => new Map(order.map(q => [q, ok(arm.includes('--off--') && q === 'q3' ? 'The answer is yes' : 'yes')])),
    });
    const c = R.compare(rows, 'sol', 'off', 'full');
    expect([c.scored, c.of, c.enough]).toEqual([2, 3, false]);
    expect(rows.find(r => r.reader === 'sol' && r.memories === 'off' && r.question_id === 'q3')!.cross_redis_parse).toBe(1);
  });
});
