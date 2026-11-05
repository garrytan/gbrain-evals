/**
 * GST-1365's decision rule (eval/runner/q1/rejudge-rule.ts) on invented per-question values: the views, one common
 * cohort and INCOMPLETE, the outcome classes, ranks and family verdicts, Wilson intervals, referee validity, control
 * accuracy and the which-judge verdict.
 */
import { describe, expect, test } from 'bun:test';
import { cohorts, contrast, controls, familyVerdict, judgeEffect, outcome, questionView, ranks, readerView, referee, whichJudge, wilson, type CellValues, type Interval, type RankedContrast, type ReaderValue } from '../../eval/runner/q1/rejudge-rule.ts';

const v = (M: number | null, F: number | null = M, R: number | null = null, M0: number | null = M): ReaderValue => ({ M, M0, F, R });
/** n questions over conversations of size per, each with one reader whose value comes from fn. */
function cell(n: number, per: number, fn: (i: number) => ReaderValue | null): CellValues {
  const m: CellValues = new Map();
  for (let i = 0; i < n; i++) { const x = fn(i); m.set(`q${i}`, { conversation: `c${Math.floor(i / per)}`, readers: x ? { r: x } : null }); }
  return m;
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `q${i}`);
const I = (delta: number, lo: number, hi: number): Interval => ({ delta, ci95: [lo, hi] });

describe('views and the common cohort', () => {
  // Value: protects=K takes the referee only where the canonical and frontier judges disagree, and a missing judgment never counts as a fail; fails_when=K reads the referee on agreeing answers or a null as 0; why_new=new; seam=readerView/questionView; no_claim=none
  test('K is the shared verdict where M0 and F agree and the referee where they disagree; any missing judge makes the question missing', () => {
    expect(readerView(v(1, 1, 0), 'K')).toBe(1);
    expect(readerView(v(0.2, 0.9, 1), 'K')).toBe(1);
    expect(readerView(v(0.2, 0.9, 0.4), 'K')).toBe(0);
    expect(readerView(v(0.2, 0.9, null), 'K')).toBeNull();
    expect(readerView(v(1, null), 'F')).toBeNull();
    const q = { conversation: 'c0', readers: { a: v(1, 1), b: v(0, null) } };
    expect([questionView(q, 'M', ['a', 'b']), questionView(q, 'F', ['a', 'b']), questionView(q, 'F', ['a'])]).toEqual([0.5, null, 1]);
  });

  // Value: protects=d3, every view of a contrast on one cohort, INCOMPLETE beyond 2% of questions or on a lost conversation; fails_when=Δ_F and Δ_M sit on different denominators or a contrast missing a conversation gets a class; why_new=autoplan finding F4; seam=cohorts; no_claim=none
  test('a contrast short of its published cohort by 2% is complete, by 3% or a whole conversation is INCOMPLETE', () => {
    const other = cell(100, 10, () => v(0));
    const missing = (gone: number[]) => cell(100, 10, i => (gone.includes(i) ? v(1, null) : v(1)));
    const two = cohorts(missing([3, 47]), other, ['r'], ids(100));
    expect([two.published.length, two.common.length, two.incomplete]).toEqual([100, 98, null]);
    expect(cohorts(missing([3, 47, 91]), other, ['r'], ids(100)).incomplete).toBe('3 of 100 published questions lack a score under every judge (tolerance 2%)');
    expect(cohorts(missing(ids(10).map((_, i) => i)), other, ['r'], ids(100)).incomplete).toBe('1 whole conversation(s) have no question every judge scored');
    const withoutReferee = cohorts(cell(100, 10, () => v(1)), other, ['r'], ids(100), true);
    expect([withoutReferee.common.length, withoutReferee.incomplete]).toEqual([100, null]);
    expect(cohorts(cell(10, 5, () => null), other, ['r'], ids(10)).incomplete).toBe('no published cohort');
  });

  // Value: protects=the signs of Δ and δ; fails_when=anchor and comparator swap, or δ is Δ_M0 − Δ_F; why_new=new; seam=contrast/judgeEffect over clusteredPairedDelta; no_claim=none
  test('Δ is anchor minus comparator and δ is Δ_F minus Δ_M0', () => {
    const anchor = cell(20, 5, i => v(1, i < 10 ? 0 : 1)), other = cell(20, 5, () => v(0));
    expect(contrast(anchor, other, ['r'], ids(20), 'M0')).toEqual({ delta: 1, ci95: [1, 1] });
    expect(contrast(anchor, other, ['r'], ids(20), 'F').delta).toBe(0.5);
    expect(judgeEffect(anchor, other, ['r'], ids(20)).delta).toBe(-0.5);
  });
});

describe('outcomes, ranks and family verdicts', () => {
  const sep = I(0.05, 0.01, 0.09), level = I(0.02, -0.02, 0.06), none = I(0, -0.01, 0.01);
  // Value: protects=section 5's outcome classes exactly as preregistered; fails_when=a class fires on the wrong interval, size rule or reader; why_new=new; seam=outcome; no_claim=none
  test('HOLDS, SIZE CHANGED, WEAKENED (interval or one reader), REVERSED and INCOMPLETE', () => {
    const o = (canonical: Interval, F: Interval, effect = none, perReader: Record<string, Interval> = {}, incomplete: string | null = null) => outcome({ canonical, F, effect, perReader, incomplete });
    expect(o(sep, sep)).toEqual({ outcome: 'HOLDS', separated: true, reasons: [] });
    expect(o(sep, I(0.12, 0.08, 0.16), I(0.07, 0.03, 0.11)).outcome).toBe('SIZE CHANGED');
    expect(o(sep, I(0.06, 0.02, 0.1), I(0.02, 0.005, 0.035)).outcome).toBe('HOLDS');
    expect(o(sep, I(0.02, -0.01, 0.05))).toEqual({ outcome: 'WEAKENED', separated: true, reasons: ['the three-reader Δ_F interval includes 0'] });
    expect(o(sep, sep, none, { x: I(-0.05, -0.09, -0.01), y: sep })).toEqual({ outcome: 'WEAKENED', separated: true, reasons: ['confident reversal for x'] });
    expect(o(sep, I(-0.05, -0.09, -0.01)).outcome).toBe('REVERSED');
    expect(o(level, I(-0.01, -0.04, 0.02))).toEqual({ outcome: 'HOLDS', separated: false, reasons: [] });
    expect(o(level, I(-0.05, -0.08, -0.02)).outcome).toBe('REVERSED');
    expect(o(sep, sep, none, {}, '4 of 100 published questions lack a score')).toEqual({ outcome: 'INCOMPLETE', separated: true, reasons: ['4 of 100 published questions lack a score'] });
  });

  // Value: protects=the family verdict lines, including a rank change on S1 or S2b failing the family; fails_when=a verdict ignores a REVERSED contrast, a rank change, a partial stratum or a cut; why_new=new; seam=ranks/familyVerdict; no_claim=none
  test('family verdicts: HOLDS, SIZE RESTATED, WEAKENED, FAILS on REVERSED or an S1/S2b rank change, INCOMPLETE and NOT RUN', () => {
    const r = (set: string, canonical: Interval, F: Interval | null, outcome: RankedContrast['outcome']): RankedContrast => ({ set, canonical, F, outcome });
    const holds = [r('S1', sep, sep, 'HOLDS'), r('S2b', level, level, 'HOLDS')];
    expect(familyVerdict(holds)).toBe('HOLDS');
    expect(familyVerdict([...holds, r('S1', sep, I(0.12, 0.08, 0.16), 'SIZE CHANGED')])).toBe('HOLDS IN SIGN AND RANK, SIZE RESTATED');
    expect(familyVerdict([...holds, r('D8', sep, level, 'WEAKENED')])).toBe('WEAKENED');
    expect(ranks([r('D8', sep, level, 'WEAKENED')])).toEqual({ D8: { holds: false, changed: 1 } });
    expect(familyVerdict([...holds, r('S1', sep, level, 'WEAKENED')])).toBe('FAILS');
    expect(familyVerdict([...holds, r('S2b', level, I(-0.05, -0.08, -0.02), 'REVERSED')])).toBe('FAILS');
    expect(familyVerdict([...holds, r('S1', sep, null, 'INCOMPLETE')])).toBe('INCOMPLETE');
    expect(familyVerdict(holds, { partial: true })).toBe('INCOMPLETE');
    expect(familyVerdict(holds, { cut: true })).toBe('NOT RUN (CUT ORDER)');
  });
});

describe('which judge is right', () => {
  // Value: protects=the Wilson interval p_F and referee validity use; fails_when=the interval is off or an empty group gets a share; why_new=new; seam=wilson; no_claim=none
  test('Wilson 95% intervals', () => {
    expect(wilson(0, 0)).toEqual({ share: null, ci95: null });
    const w = wilson(85, 100);
    expect(w.share).toBe(0.85);
    expect(w.ci95![0]).toBeCloseTo(0.7672, 3);
    expect(w.ci95![1]).toBeCloseTo(0.9069, 3);
    expect(wilson(10, 10).ci95![1]).toBe(1);
  });

  // Value: protects=the referee counts only when it matches the unanimous verdict on 85% of the agreement sample, and p_F splits by group, category and direction; fails_when=an invalid referee is used, or p_F counts the canonical side; why_new=new; seam=referee; no_claim=none
  test('referee validity at 85%, p_F pooled, by group, by category and by direction', () => {
    const agree = (k: number) => Array.from({ length: 100 }, (_, i) => ({ group: 'g', m: true, f: true, r: i < k }));
    const dis = [{ group: 'Claude rows|a', category: 'x', m: true, f: false, r: false }, { group: 'Claude rows|a', category: 'y', m: false, f: true, r: true }, { group: 'Sol rows|b', category: 'x', m: false, f: true, r: true }, { group: 'Sol rows|b', category: 'x', m: true, f: false, r: true }];
    expect(referee(agree(85), dis).valid).toBe(true);
    expect(referee(agree(84), dis).valid).toBe(false);
    const res = referee(agree(90), dis);
    expect([res.disagreements, res.p_F.share, res.by_group['Claude rows|a'].share, res.by_group['Sol rows|b'].share]).toEqual([4, 0.75, 1, 0.5]);
    expect([res.by_direction.frontier_stricter.share, res.by_direction.frontier_more_lenient.share]).toEqual([0.5, 1]);
    expect(res.by_category.x.share).toBeCloseTo(2 / 3, 3);
    expect(res.by_category.y.share).toBe(1);
  });

  // Value: protects=a judge is more accurate on known answers only by 3 points with a paired interval excluding 0; fails_when=a small or noisy difference crowns a judge, or the pair key or sign flips; why_new=new; seam=controls; no_claim=none
  test('control error rates per judge and control, and the paired more-accurate call', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ question: `q${Math.floor(i / 4)}`, control: `C${(i % 4) + 1}`, correct: { a: true, b: i % 10 !== 0, c: i % 100 !== 0 } }));
    const res = controls(rows, ['a', 'b', 'c']);
    expect([res.error_rates.a.total.error, res.error_rates.b.total.error, res.error_rates.c.total.error]).toEqual([0, 0.1, 0.01]);
    expect(res.paired['a minus b'].more_accurate).toBe('a');
    expect(res.paired['a minus b'].delta).toBeCloseTo(-0.1, 6);
    expect(res.paired['a minus c'].more_accurate).toBeNull();
    expect(res.paired['b minus c'].more_accurate).toBe('c');
  });

  // Value: protects=section 4's which-judge rule; fails_when=a verdict is given with an invalid referee, an interval touching 0.5, or controls pointing the other way; why_new=new; seam=whichJudge; no_claim=none
  test('frontier, canonical or unsettled', () => {
    const w = (valid: boolean, lo: number, hi: number, canonicalMoreAccurate = false, frontierMoreAccurate = false) => whichJudge({ valid, pF: { ci95: [lo, hi] }, canonicalMoreAccurate, frontierMoreAccurate });
    expect(w(true, 0.6, 0.7)).toBe('frontier');
    expect(w(true, 0.6, 0.7, true)).toBe('unsettled');
    expect(w(true, 0.3, 0.4)).toBe('canonical');
    expect(w(true, 0.3, 0.4, false, true)).toBe('unsettled');
    expect(w(true, 0.45, 0.6)).toBe('unsettled');
    expect(w(false, 0.6, 0.7)).toBe('unsettled');
    expect(whichJudge({ valid: true, pF: { ci95: null }, canonicalMoreAccurate: false, frontierMoreAccurate: false })).toBe('unsettled');
  });
});
