import { describe, expect, test } from 'bun:test';
import { compare } from '../../eval/runner/t0/paired.ts';

const cell = (persona: string, task: string, reader: string, repeat: number, failed: boolean, kinds: string[] = failed ? ['stale_date'] : []) =>
  ({ persona, task, reader, repeat, arm: 'baseline', score: { failed, kinds } });

describe('T0b paired comparison', () => {
  const readers = ['r1'];
  const base = [cell('p1', 'p1-t1', 'r1', 1, true), cell('p1', 'p1-t2', 'r1', 1, true), cell('p2', 'p2-t1', 'r1', 1, true), cell('p2', 'p2-t2', 'r1', 1, false), cell('p2', 'p2-t1', 'r1', 2, true)];
  test('pairs on task, reader and repeat and counts per persona cluster', () => {
    const cand = [cell('p1', 'p1-t1', 'r1', 1, false), cell('p1', 'p1-t2', 'r1', 1, true), cell('p2', 'p2-t1', 'r1', 1, false), cell('p2', 'p2-t2', 'r1', 1, false), cell('p2', 'p2-t1', 'r1', 2, false)];
    const [r1, pooled] = compare(base, cand, [1], readers);
    expect(r1.pairs).toBe(4);
    expect(r1.personas).toBe(2);
    expect(r1.baseline.failures).toBe(3);
    expect(r1.candidate.failures).toBe(1);
    expect(r1.ratio!.ratio).toBeCloseTo(1.5 / 3.5, 6);
    expect(pooled.scope).toBe('pooled');
    expect(compare(base, cand, [1, 2], readers)[0].pairs).toBe(5);
  });
  test('a baseline without failures is a ceiling, and unpaired candidate cells are ignored', () => {
    const clean = base.map(c => ({ ...c, score: { failed: false, kinds: [] } }));
    const cand = [cell('p1', 'p1-t1', 'r1', 1, true), cell('p9', 'p9-t1', 'r1', 1, true)];
    const [r1] = compare(clean, cand, [1], readers);
    expect(r1.verdict).toBe('ceiling');
    expect(r1.pairs).toBe(1);
  });
});
