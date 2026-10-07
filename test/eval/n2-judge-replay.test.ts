/**
 * W9: N2 judge replay helpers (capture verification, pair selection, scoring
 * with exact bounds, paired comparison) and the Clopper-Pearson helper.
 */
import { describe, expect, test } from 'bun:test';
import { binomialCdf, clopperPearson } from '../../eval/runner/stats/exact.ts';
import {
  FRESH_SIZE, SAMPLE_SIZE, judgmentClass, pairedVsReference, scoreModel, seededSample, selectPairs, verifyCapture,
  type Capture, type CapturedPair, type SelectedPair,
} from '../../eval/runner/n2-judge-replay.ts';

describe('clopperPearson', () => {
  test('matches published exact bounds', () => {
    expect(clopperPearson(5, 51).upper).toBeCloseTo(0.2141, 3);
    expect(clopperPearson(0, 51).upper).toBeCloseTo(0.0698, 3);
    expect(clopperPearson(0, 123).upper).toBeCloseTo(0.0295, 3);
    expect(clopperPearson(149, 150).lower).toBeCloseTo(0.9634, 3);
    expect(clopperPearson(0, 10).lower).toBe(0);
    expect(clopperPearson(10, 10).upper).toBe(1);
  });

  test('binomial cdf edges and argument checks', () => {
    expect(binomialCdf(-1, 5, 0.5)).toBe(0);
    expect(binomialCdf(5, 5, 0.5)).toBe(1);
    expect(binomialCdf(0, 2, 0.5)).toBeCloseTo(0.25, 10);
    expect(() => clopperPearson(3, 2)).toThrow();
  });
});

const pair = (item: string, a: string, b: string, cls: CapturedPair['gold_class']): CapturedPair => ({
  query: `q-${item}`, item, a: { slug: a, text: 'x' }, b: { slug: b, text: 'y' }, key: a < b ? `${a}|${b}` : `${b}|${a}`, gold_class: cls, gold_item: cls === 'unplanted' ? null : item,
});

describe('capture verification', () => {
  const cap = { world_fingerprint: 'f', pairs: [pair('i1', 'a', 'b', 'contradiction'), pair('i2', 'c', 'd', 'unplanted')] };

  test('matching triples (page order ignored), classes and fingerprint pass', () => {
    const r = verifyCapture(cap, { ledgerSha: 'f', judgments: [
      { q: 'i1', a: 'b', b: 'a', gold: 'i1:contradiction', verdict: 'contradiction', error: null },
      { q: 'i2', a: 'c', b: 'd', gold: 'unplanted', verdict: 'no_contradiction', error: null },
    ] });
    expect(r.ok).toBe(true);
  });

  test('a missing triple, an extra one, a class mismatch or another fingerprint fails', () => {
    expect(verifyCapture(cap, { ledgerSha: 'f', judgments: [{ q: 'i1', a: 'a', b: 'b', gold: 'i1:contradiction', verdict: null, error: null }] }).ok).toBe(false);
    expect(verifyCapture(cap, { ledgerSha: 'g', judgments: [
      { q: 'i1', a: 'a', b: 'b', gold: 'i1:contradiction', verdict: null, error: null }, { q: 'i2', a: 'c', b: 'd', gold: 'unplanted', verdict: null, error: null },
    ] }).ledger_sha_matches).toBe(false);
    const r = verifyCapture(cap, { ledgerSha: 'f', judgments: [
      { q: 'i1', a: 'a', b: 'b', gold: 'i1:compatible', verdict: null, error: null }, { q: 'i2', a: 'c', b: 'd', gold: 'unplanted', verdict: null, error: null },
    ] });
    expect(r.gold_class_mismatches).toBe(1);
    expect(r.ok).toBe(false);
  });

  test('a planted pair judged under another item counts as unplanted', () => {
    expect(judgmentClass({ planted: true, gold_class: 'contradiction', item: 'i1' }, 'i1')).toBe('contradiction');
    expect(judgmentClass({ planted: true, gold_class: 'contradiction', item: 'i1' }, 'i2')).toBe('unplanted');
    expect(judgmentClass({ planted: false, gold_class: 'compatible' }, 'i1')).toBe('unplanted');
  });
});

describe('selection', () => {
  const capture = (seed: number, pairs: CapturedPair[]): Capture => ({ seed, generator_version: 'g', world_fingerprint: `f${seed}`, gbrain: null, prompt_version: '4', offered: pairs.length, pairs });
  const main = capture(1, [
    pair('i1', 'a', 'b', 'contradiction'), pair('i2', 'c', 'd', 'compatible'),
    ...Array.from({ length: 400 }, (_, k) => pair(`u${k}`, `x${k}`, `y${k}`, 'unplanted')),
  ]);
  const fresh = Array.from({ length: 5 }, (_, s) => capture(10 + s, Array.from({ length: 50 }, (_, k) => pair(`c${k}`, `p${s}-${k}`, `q${s}-${k}`, 'compatible'))));

  test('all planted, a seeded sample of the rest, and the first fresh compatible negatives', () => {
    const sel = selectPairs(main, fresh);
    expect(sel.filter(p => p.split === 'planted')).toHaveLength(2);
    expect(sel.filter(p => p.split === 'sample')).toHaveLength(SAMPLE_SIZE);
    expect(sel.filter(p => p.split === 'fresh')).toHaveLength(FRESH_SIZE);
    expect(sel.filter(p => p.split === 'sample').every(p => p.gold_class === 'unplanted')).toBe(true);
    expect(new Set(sel.map(p => p.id)).size).toBe(sel.length);
    expect(selectPairs(main, fresh).map(p => p.id)).toEqual(sel.map(p => p.id));
  });

  test('too few fresh compatible pairs is refused', () => {
    expect(() => selectPairs(main, fresh.slice(0, 2))).toThrow(/need 200/);
  });

  test('seededSample draws without replacement, deterministically', () => {
    const s = seededSample([1, 2, 3, 4, 5, 6], 4, 7);
    expect(new Set(s).size).toBe(4);
    expect(seededSample([1, 2, 3, 4, 5, 6], 4, 7)).toEqual(s);
  });
});

describe('scoring', () => {
  const mk = (id: string, split: SelectedPair['split'], cls: CapturedPair['gold_class']): SelectedPair => ({ ...pair(id, `${id}a`, `${id}b`, cls), split, seed: 1, id });
  const pairs: SelectedPair[] = [
    ...Array.from({ length: 10 }, (_, i) => mk(`c${i}`, 'planted', 'contradiction')),
    ...Array.from({ length: 10 }, (_, i) => mk(`t${i}`, 'planted', 'temporal')),
    ...Array.from({ length: 51 }, (_, i) => mk(`n${i}`, 'planted', 'compatible')),
    ...Array.from({ length: 200 }, (_, i) => mk(`f${i}`, 'fresh', 'compatible')),
    ...Array.from({ length: 20 }, (_, i) => mk(`u${i}`, 'sample', 'unplanted')),
  ];
  const verdicts = (alertCompat: number, alertSample: number, errors = 0) => new Map(pairs.map((p, k) => {
    if (p.gold_class === 'contradiction') return [p.id, { verdict: k < errors ? null : 'contradiction', error: k < errors ? 'truncated at the 1024-token output limit' : null }];
    if (p.split === 'planted' && p.gold_class === 'compatible') return [p.id, { verdict: Number(p.id.slice(1)) < alertCompat ? 'contradiction' : 'no_contradiction', error: null }];
    if (p.split === 'sample') return [p.id, { verdict: Number(p.id.slice(1)) < alertSample ? 'contradiction' : 'no_contradiction', error: null }];
    return [p.id, { verdict: 'no_contradiction', error: null }];
  }));

  test('passes only when the pooled compatible upper bound is under 10%', () => {
    const ok = scoreModel('m', pairs, verdicts(0, 0), { offeredTotal: 1000, othersTotal: 900, pooled: true });
    expect(ok.false_compatible_pooled!.n).toBe(251);
    expect(ok.passes).toBe(true);
    const bad = scoreModel('m', pairs, verdicts(20, 0), { offeredTotal: 1000, othersTotal: 900, pooled: true });
    expect(bad.passes).toBe(false);
    expect(bad.failed_rules.join()).toMatch(/upper 95% bound/);
  });

  test('without the fresh split the decision rests on the original 51', () => {
    const s = scoreModel('haiku', pairs.filter(p => p.split !== 'fresh'), verdicts(5, 0), { offeredTotal: 1000, othersTotal: 900, pooled: false });
    expect(s.false_compatible_pooled).toBeNull();
    expect(s.false_compatible_original.upper95).toBeCloseTo(0.2141, 3);
    expect(s.passes).toBe(false);
  });

  test('truncations are judge errors and count as misses on conflicts', () => {
    const s = scoreModel('m', pairs, verdicts(0, 0, 3), { offeredTotal: 1000, othersTotal: 900, pooled: true });
    expect(s.truncations).toBe(3);
    expect(s.judge_errors).toBe(3);
    expect(s.recall_conflicts.hits).toBe(7);
    expect(s.failed_rules).toContain('classification recall on offered conflicts < 0.80');
  });

  test('false alerts per 1,000 candidates weight the sample back to its population', () => {
    const s = scoreModel('m', pairs, verdicts(0, 2), { offeredTotal: 1000, othersTotal: 900, pooled: true });
    expect(s.false_alerts_per_1000_candidates).toBeCloseTo((2 / 20) * 900 / 1000 * 1000, 8);
  });

  test('paired McNemar on correctness against the reference', () => {
    const ref = verdicts(5, 0);
    const mine = verdicts(0, 0);
    const r = pairedVsReference(pairs.filter(p => p.split !== 'fresh'), mine, ref);
    expect(r.wins).toBe(5);
    expect(r.losses).toBe(0);
  });
});
