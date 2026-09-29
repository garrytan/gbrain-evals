import { describe, expect, test } from 'bun:test';
import { topKPrecision } from '../../eval/runner/before-after.ts';
import { precisionAtK } from '../../eval/runner/metrics.ts';

describe('Cat 1 top-K precision denominators (C-04)', () => {
  test('standard precision charges empty slots; legacy divides by min(k, returned)', () => {
    const rows = [
      { foundAtK: 1, returned: 1, expected: 1 },
      { foundAtK: 2, returned: 5, expected: 3 },
    ];
    const p = topKPrecision(rows, 5);
    expect(p.standard).toBeCloseTo(3 / 10, 12);
    expect(p.legacy).toBeCloseTo(3 / 6, 12);
    expect(p.ceiling).toBeCloseTo(4 / 10, 12);
  });

  test('standard matches metrics.precisionAtK averaged per query', () => {
    const rel = new Set(['a', 'b', 'c']);
    const lists = [['a'], ['x', 'b', 'y', 'c', 'z']];
    const perQuery = lists.map(l => precisionAtK(l, rel, 5));
    const p = topKPrecision([{ foundAtK: 1, returned: 1, expected: 3 }, { foundAtK: 2, returned: 5, expected: 3 }], 5);
    expect(p.standard).toBeCloseTo((perQuery[0] + perQuery[1]) / 2, 12);
  });

  test('empty input is 0, not NaN', () => {
    expect(topKPrecision([], 5)).toEqual({ standard: 0, legacy: 0, ceiling: 0 });
  });
});
