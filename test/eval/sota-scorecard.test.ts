/**
 * The monthly SOTA scorecard (eval/runner/sota/scorecard.ts): D1a's status precedence at each interval edge, the
 * descriptive and sealed rows, the quarterly call against monthly trend, three takeaways, and the refusal to write the
 * scorecard into the repository. Keyless.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertOutsideRepo, main, MARGIN, renderScorecard, scorecard, scoreRow, status, type ScoreRow } from '../../eval/runner/sota/scorecard.ts';

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'sota-scorecard-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const iv = (lo: number, hi: number) => ({ estimate: (lo + hi) / 2, lo, hi });
const ROW: ScoreRow = {
  benchmark: 'beam-rs1', leader: 'grep-agent', source: 'custody rs1 2027-02', gbrain_pin: '0.60.700.0', date: '2027-02-01', readers: ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'],
  split: 'held_out', sealed_pending: false, gbrain_points: 61.2, leader_points: 63.0, delta: iv(-4, 0.4),
  gbrain_cost_per_correct: 0.021, leader_cost_per_correct: 0.913, gbrain_p50_s: 4.2, leader_p50_s: 38.5,
};
const TAKEAWAYS = ['We learned X. You should do X.', 'We learned Y.', 'We learned Z.'];

describe('status precedence at the interval edges', () => {
  test('ahead only when the lower bound is above 0', () => {
    expect(status(iv(0.01, 9))).toBe('ahead');
    expect(status(iv(0, 3))).toBe('at_parity');
    expect(status(iv(0, 9))).toBe('not_enough_data');
    expect(status(iv(5, 50))).toBe('ahead');
  });

  test('behind only when the upper bound is below 0', () => {
    expect(status(iv(-9, -0.01))).toBe('behind');
    expect(status(iv(-3, 0))).toBe('at_parity');
    expect(status(iv(-9, 0))).toBe('not_enough_data');
  });

  test('at parity when the interval holds 0 strictly inside the margin', () => {
    expect(MARGIN).toBe(3.5);
    expect(status(iv(-3.49, 3.49))).toBe('at_parity');
    expect(status(iv(-3.5, 1))).toBe('not_enough_data');
    expect(status(iv(-1, 3.5))).toBe('not_enough_data');
    expect(status(iv(0, 0))).toBe('at_parity');
    expect(status(iv(-20, 20))).toBe('not_enough_data');
    expect(status(null)).toBe('not_enough_data');
  });
});

describe('rows', () => {
  test('other readers and dev questions are descriptive, sealed rows wait for RS1', () => {
    expect(scoreRow({ ...ROW, readers: ['claude-sonnet-5-5'] }, { quarterCall: '2027-Q1', previous: [] })).toMatchObject({ status: 'descriptive', called: null });
    expect(scoreRow({ ...ROW, readers: ['claude-opus-5-5', 'gpt-6.1-sol'] }, { quarterCall: null, previous: [] }).status).toBe('descriptive');
    expect(scoreRow({ ...ROW, split: 'dev' }, { quarterCall: '2027-Q1', previous: [] })).toMatchObject({ status: 'descriptive', reason: 'dev questions: gbrain was tuned on them' });
    expect(scoreRow({ ...ROW, sealed_pending: true }, { quarterCall: '2027-Q1', previous: [] })).toMatchObject({ status: 'sealed_pending', reason: 'sealed, pending RS1 verdict' });
  });

  test('a monthly row shows the status as trend, a quarter call calls it, and the change since last month sits beside it', () => {
    const month = scorecard([ROW], { month: '2027-02', previous: { schema: 'sota-scorecard/1', month: '2027-01', quarter_call: null, takeaways: TAKEAWAYS, rows: [{ ...scoreRow({ ...ROW, delta: iv(-6, -1) }, { quarterCall: null, previous: [] }) }] }, takeaways: TAKEAWAYS });
    expect(month.rows[0]).toMatchObject({ status: 'not_enough_data', called: null, trend_points: 1.7 });
    const md = renderScorecard(month);
    expect(md).toContain('trend: not enough data');
    expect(md).toContain('| +1.7 |');
    expect(md).toContain('$0.021 / $0.913');
    expect(md).toContain('4.2 / 38.5');
    expect(md.split('\n').slice(2, 5)).toEqual(TAKEAWAYS.map((t, i) => `${i + 1}. ${t}`));
    const called = scorecard([{ ...ROW, delta: iv(-9, -1) }], { month: '2027-03', quarterCall: '2027-Q1', takeaways: TAKEAWAYS });
    expect(called.rows[0]).toMatchObject({ status: 'behind', called: '2027-Q1', trend_points: null });
    expect(renderScorecard(called)).toContain('behind (called 2027-Q1)');
  });

  test('three takeaways, no more and no fewer', () => {
    expect(() => scorecard([ROW], { month: '2027-02', takeaways: ['one', '', 'two'] })).toThrow('three plain takeaways; got 2');
    expect(() => scorecard([ROW], { month: '2027-02', takeaways: [...TAKEAWAYS, 'four'] })).toThrow('got 4');
  });
});

describe('the command', () => {
  test('writes the markdown and json outside the repository and refuses inside it', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'rows.json'), JSON.stringify({ rows: [ROW] }));
    writeFileSync(join(dir, 'takeaways.txt'), TAKEAWAYS.join('\n') + '\n');
    expect(main(['--rows', join(dir, 'rows.json'), '--takeaways', join(dir, 'takeaways.txt'), '--out', join(dir, 'scorecard.md')], () => {})).toBe(0);
    expect(readFileSync(join(dir, 'scorecard.md'), 'utf8')).toStartWith('# gbrain against the state of the art: 2027-02');
    expect(JSON.parse(readFileSync(join(dir, 'scorecard.json'), 'utf8'))).toMatchObject({ month: '2027-02', rows: [{ status: 'not_enough_data' }] });
    const inside = resolve(import.meta.dir, '../../scorecard-test.md');
    expect(() => main(['--rows', join(dir, 'rows.json'), '--takeaways', join(dir, 'takeaways.txt'), '--out', inside], () => {})).toThrow('SCORECARD_IN_REPO');
    expect(existsSync(inside)).toBe(false);
    expect(() => assertOutsideRepo(resolve(import.meta.dir, '../..'))).toThrow('SCORECARD_IN_REPO');
    expect(() => assertOutsideRepo(join(dir, 'x.md'))).not.toThrow();
  });
});
