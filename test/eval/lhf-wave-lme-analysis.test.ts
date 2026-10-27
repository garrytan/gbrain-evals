import { describe, expect, test } from 'bun:test';
import { answerable, checkArm, decide, MARGIN, pairedLowerBound, readRows, type Row } from '../../docs/benchmarks/2026-10-12-lhf-wave/scripts/analyze-lme.ts';

const N = 470;
const row = (id: string, hit: boolean, extra: Partial<Row> = {}): Row => ({ question_id: id, abstention: false, recall_all_hit: hit, search_meta: { degraded: [] }, via_operation: { expansion: { expected: false, outcome: 'not_expected' }, failed_model_calls: 0, model_calls: { embedding: 1, rerank: 1 } }, ...extra });
const arm = (hits: (i: number) => boolean, extra: (i: number) => Partial<Row> = () => ({})) => answerable(Array.from({ length: N }, (_, i) => row(`q${i}`, hits(i), extra(i))));
const opts = { treatmentExpects: false, controlExpects: false, questions: N };

describe('lhf-wave LongMemEval decision rule', () => {
  test('identical arms pass with estimate 0 and lower bound 0', () => {
    const a = arm(i => i % 10 !== 0);
    const v = decide(a, arm(i => i % 10 !== 0), opts);
    expect(v.verdict).toBe('pass');
    expect(v.estimate).toBe(0);
    expect(v.lower).toBe(0);
  });

  test('a uniform loss of exactly the margin fails (strictly above is required)', () => {
    // 47 of 470 lost questions would be -0.1; a constant -0.01 difference needs fractional pairs, so check the bound directly.
    const diffs = Array.from({ length: 100 }, () => MARGIN);
    expect(pairedLowerBound(diffs)).toBeCloseTo(MARGIN, 12);
    expect(pairedLowerBound(diffs) > MARGIN).toBe(false);
  });

  test('five lost questions (estimate -1.06 points) fails; two lost with two won passes', () => {
    const control = arm(() => true);
    expect(decide(arm(i => i >= 5), control, opts).verdict).toBe('fail');
    const mixedControl = arm(i => i >= 2);
    const v = decide(arm(i => i < 2 || i >= 4), mixedControl, opts);
    expect(v.wins).toBe(2);
    expect(v.losses).toBe(2);
    expect(v.estimate).toBe(0);
    expect(v.verdict).toBe('pass');
  });

  test('one lost question passes only if the bootstrap bound clears -1 point', () => {
    const v = decide(arm(i => i !== 0), arm(() => true), opts);
    expect(v.estimate).toBeCloseTo(-1 / N, 12);
    expect(v.lower!).toBeGreaterThan(MARGIN);
    expect(v.verdict).toBe('pass');
  });

  test('the bootstrap is deterministic for a seed', () => {
    const diffs: number[] = Array.from({ length: N }, (_, i) => (i % 7 === 0 ? -1 : i % 11 === 0 ? 1 : 0));
    expect(pairedLowerBound(diffs)).toBe(pairedLowerBound(diffs));
    const estimate = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    expect(pairedLowerBound(diffs)).toBeLessThan(estimate);
  });

  test('a missing pair invalidates the comparison', () => {
    const t = arm(() => true);
    t.delete('q3');
    const v = decide(t, arm(() => true), opts);
    expect(v.verdict).toBe('invalid');
    expect(v.missing_pairs).toBe(1);
  });

  test('any rerank or embedding degradation invalidates its arm', () => {
    for (const stage of ['rerank_failed', 'embed_timeout', 'vector_unavailable']) {
      const t = arm(() => true, i => (i === 7 ? { search_meta: { degraded: [{ stage }] } } : {}));
      const v = decide(t, arm(() => true), opts);
      expect(v.verdict).toBe('invalid');
      expect(v.treatment.reasons[0]).toContain(stage);
    }
  });

  test('an expansion arm is invalid when any question failed or did not attempt expansion', () => {
    const exp = (outcome: string) => (i: number) => ({ via_operation: { expansion: { expected: true, outcome: i === 9 ? outcome : 'applied' }, failed_model_calls: 0, model_calls: { rerank: 1 } } });
    for (const outcome of ['failed', 'not_attempted']) {
      expect(checkArm(arm(() => true, exp(outcome)), { expectExpansion: true, questions: N }).valid).toBe(false);
    }
    const nv = checkArm(arm(() => true, exp('no_variants')), { expectExpansion: true, questions: N });
    expect(nv.valid).toBe(true);
    expect(nv.no_variants).toBe(1);
    expect(checkArm(arm(() => true, exp('applied')), { expectExpansion: true, questions: N }).valid).toBe(true);
  });

  test('a row without a rerank call invalidates its arm', () => {
    const t = arm(() => true, i => (i === 4 ? { via_operation: { expansion: { expected: false, outcome: 'not_expected' }, failed_model_calls: 0, model_calls: { embedding: 1 } } } : {}));
    const c = checkArm(t, { expectExpansion: false, questions: N });
    expect(c.valid).toBe(false);
    expect(c.reasons[0]).toContain('no rerank call');
  });

  test('an expansion-off arm that expanded is invalid', () => {
    const t = arm(() => true, i => (i === 1 ? { via_operation: { expansion: { expected: false, outcome: 'applied' }, failed_model_calls: 0, model_calls: { rerank: 1 } } } : {}));
    expect(checkArm(t, { expectExpansion: false, questions: N }).valid).toBe(false);
  });

  test('abstention rows are excluded and duplicates refuse', () => {
    const rows = [row('a', true), row('b_abs', false, { abstention: true }), row('c', true)];
    expect([...answerable(rows).keys()]).toEqual(['a', 'c']);
    expect(() => answerable([row('a', true), row('a', false)])).toThrow('duplicate');
  });

  test('a short arm is invalid', () => {
    const t = arm(() => true);
    const c = arm(() => true);
    t.delete('q0');
    c.delete('q0');
    expect(decide(t, c, opts).verdict).toBe('invalid');
  });
});

describe('lhf-wave baseline reproduction against a published direct-harness receipt', () => {
  test('the published FINAL receipt is a valid direct control with 451/470', () => {
    const rows = answerable(readRows('docs/benchmarks/2026-10-04-longmemeval-opaque-followups/1a-harness/FINAL/rows.ndjson.gz'));
    const c = checkArm(rows, { expectExpansion: false, questions: N, direct: true });
    expect(c.valid).toBe(true);
    expect(c.hits).toBe(451);
    expect(checkArm(rows, { expectExpansion: false, questions: N }).valid).toBe(false);
  });
});
