import { describe, expect, test } from 'bun:test';
import { countNames, loadBaseline, scan, violations } from '../../eval/runner/name-guard.ts';

describe('name guard', () => {
  test('no file outside docs/comparison-systems adds an external product name', () => {
    expect(violations(scan(), loadBaseline())).toEqual([]);
  });
  test('matches whole words and package forms, not the ordinary English word', () => {
    expect(countNames('in hindsight the plan was fine')).toBe(0);
    // Assembled from fragments so this test file does not itself trip the guard.
    const j = (...p: string[]) => p.join('');
    expect(countNames([j('Hind', 'sight'), j('hind', 'sight-client'), j('mem', '0ai'), j('graph', 'iti-core'), j('Basic ', 'Memory')].join(', '))).toBe(5);
    expect(countNames('memo0 and zeppelin and lettable')).toBe(0);
  });
  test('a grown count is a violation; a lowered count is not', () => {
    expect(violations(new Map([['a.md', 3], ['b.md', 1]]), { 'a.md': 2, 'b.md': 4 })).toEqual([{ file: 'a.md', count: 3, allowed: 2 }]);
    expect(violations(new Map([['new.ts', 1]]), {})).toEqual([{ file: 'new.ts', count: 1, allowed: 0 }]);
  });
});
