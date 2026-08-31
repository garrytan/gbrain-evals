/**
 * metrics.ts tests — the regression suite for audit findings
 * shared-infra-02 (recall > 1.0 via duplicate page_ids), shared-infra-03
 * (P@k divided by returned length), longmemeval-01 (any-hit presented as
 * recall_all), and the eng-review ndcg/percentile gaps.
 *
 * Every case here encodes a bug the 2026-08-31 audit found in a live
 * runner — do not weaken these to make a new adapter look better.
 */

import { describe, test, expect } from 'bun:test';
import {
  uniqueInOrder,
  uniqueHits,
  rankOfFirstHit,
  percentile,
  recallAtK,
  precisionAtK,
  reciprocalRank,
  recallAllAtK,
  recallAnyAtK,
  dcgAtK,
  ndcgAtK,
} from '../../eval/runner/metrics.ts';
import { recallAtK as recallDocs, precisionAtK as precisionDocs } from '../../eval/runner/types.ts';
import type { RankedDoc } from '../../eval/runner/types.ts';

const rel = (...ids: string[]) => new Set(ids);

describe('recallAtK — duplicate handling (the recall > 1.0 bug)', () => {
  test('duplicate relevant id in top-k counts ONCE — recall capped at 1.0', () => {
    // gbrain dedup keeps up to 2 chunks per page, so chunk-grained result
    // lists legitimately contain the same page twice. Old code: 2/1 = 2.0.
    expect(recallAtK(['a', 'a'], rel('a'), 5)).toBe(1.0);
  });

  test('fractional recall over the relevant set', () => {
    expect(recallAtK(['a', 'x', 'b'], rel('a', 'b', 'c'), 3)).toBeCloseTo(2 / 3, 6);
  });

  test('k cutoff applies before matching', () => {
    expect(recallAtK(['x', 'y', 'a'], rel('a'), 2)).toBe(0);
  });

  test('empty relevant set returns NaN (exclude from means), not 0', () => {
    expect(Number.isNaN(recallAtK(['a'], rel(), 5))).toBe(true);
  });
});

describe('precisionAtK — /k denominator (the short-list reward bug)', () => {
  test('adapter returning 1 relevant doc scores P@10 = 0.1, not 1.0', () => {
    expect(precisionAtK(['a'], rel('a'), 10)).toBeCloseTo(0.1, 6);
  });

  test('duplicate relevant id does not double-count in the numerator', () => {
    expect(precisionAtK(['a', 'a', 'x', 'y'], rel('a'), 4)).toBeCloseTo(0.25, 6);
  });

  test('full-precision list', () => {
    expect(precisionAtK(['a', 'b'], rel('a', 'b'), 2)).toBe(1.0);
  });

  test('k <= 0 returns NaN', () => {
    expect(Number.isNaN(precisionAtK(['a'], rel('a'), 0))).toBe(true);
  });
});

describe('types.ts RankedDoc wrappers delegate to the fixed implementations', () => {
  const docs = (...ids: string[]): RankedDoc[] => ids.map((id, i) => ({ page_id: id, score: 1, rank: i + 1 }));

  test('recallAtK on RankedDoc[] never exceeds 1.0 on duplicates', () => {
    expect(recallDocs(docs('a', 'a'), rel('a') as Set<string>, 5)).toBe(1.0);
  });

  test('precisionAtK on RankedDoc[] uses /k', () => {
    expect(precisionDocs(docs('a'), rel('a') as Set<string>, 10)).toBeCloseTo(0.1, 6);
  });
});

describe('recallAllAtK vs recallAnyAtK (the LongMemEval headline bug)', () => {
  test('2 ground-truth sessions, only 1 retrieved: any=1, all=0', () => {
    // This is the exact divergence that inflated the published multi-session
    // number: any-hit called this question recalled; the official metric
    // (all correct docs in top-k) does not.
    const retrieved = ['s1', 'x', 'y'];
    const gt = rel('s1', 's2');
    expect(recallAnyAtK(retrieved, gt, 5)).toBe(1);
    expect(recallAllAtK(retrieved, gt, 5)).toBe(0);
  });

  test('all ground-truth sessions in top-k: all=1', () => {
    expect(recallAllAtK(['s2', 'x', 's1'], rel('s1', 's2'), 5)).toBe(1);
  });

  test('all present but one falls outside k: all=0', () => {
    expect(recallAllAtK(['s1', 'x', 's2'], rel('s1', 's2'), 2)).toBe(0);
  });

  test('empty ground truth returns NaN for both', () => {
    expect(Number.isNaN(recallAllAtK(['a'], rel(), 5))).toBe(true);
    expect(Number.isNaN(recallAnyAtK(['a'], rel(), 5))).toBe(true);
  });
});

describe('ndcgAtK — hand-computed values', () => {
  test('perfect ordering scores 1.0', () => {
    const grades = new Map([['a', 3], ['b', 2], ['c', 1]]);
    expect(ndcgAtK(['a', 'b', 'c'], grades, 3)).toBeCloseTo(1.0, 6);
  });

  test('reversed ordering matches the hand-computed ratio', () => {
    const grades = new Map([['a', 3], ['b', 1]]);
    // DCG(['b','a']) = 1/log2(2) + 3/log2(3) = 1 + 1.892789...
    // IDCG          = 3/log2(2) + 1/log2(3) = 3 + 0.630929...
    const dcg = 1 / Math.log2(2) + 3 / Math.log2(3);
    const idcg = 3 / Math.log2(2) + 1 / Math.log2(3);
    expect(ndcgAtK(['b', 'a'], grades, 2)).toBeCloseTo(dcg / idcg, 6);
  });

  test('no relevant retrieved scores 0', () => {
    const grades = new Map([['a', 2]]);
    expect(ndcgAtK(['x', 'y'], grades, 2)).toBe(0);
  });

  test('no positive grades returns NaN', () => {
    expect(Number.isNaN(ndcgAtK(['a'], new Map(), 5))).toBe(true);
  });

  test('dcgAtK respects the k cutoff', () => {
    const grades = new Map([['a', 3]]);
    expect(dcgAtK(['x', 'a'], grades, 1)).toBe(0);
  });
});

describe('percentile — interpolated, defined index math', () => {
  test('p50 of odd-length list is the median element', () => {
    expect(percentile([3, 1, 2], 50)).toBe(2);
  });

  test('p50 of even-length list interpolates', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 6);
  });

  test('p99 of 1..100 interpolates near the top', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 99)).toBeCloseTo(99.01, 2);
  });

  test('p0 / p100 are min / max', () => {
    expect(percentile([5, 1, 9], 0)).toBe(1);
    expect(percentile([5, 1, 9], 100)).toBe(9);
  });

  test('empty input returns NaN, never a fake 0ms', () => {
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  test('does not mutate the input array', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('primitives', () => {
  test('uniqueInOrder preserves first-occurrence order', () => {
    expect(uniqueInOrder(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
  });

  test('uniqueHits counts distinct matches', () => {
    expect(uniqueHits(['a', 'a', 'b', 'x'], rel('a', 'b'))).toBe(2);
  });

  test('rankOfFirstHit is 1-based; Infinity when absent', () => {
    expect(rankOfFirstHit(['x', 'a'], rel('a'))).toBe(2);
    expect(rankOfFirstHit(['x'], rel('a'))).toBe(Infinity);
  });

  test('reciprocalRank', () => {
    expect(reciprocalRank(['x', 'a'], rel('a'))).toBeCloseTo(0.5, 6);
    expect(reciprocalRank(['x'], rel('a'))).toBe(0);
  });
});
