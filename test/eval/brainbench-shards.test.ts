import { describe, expect, test } from 'bun:test';
import { SHARD_SECONDS, boundUse, parseShard, selectCategories, shardPlan } from '../../eval/runner/all.ts';

const { dispatch } = selectCategories('offline');
const wall = (part: typeof dispatch, concurrency = 2) =>
  part.reduce((sum, c) => sum + (c.exclusive ? SHARD_SECONDS[c.id]! : SHARD_SECONDS[c.id]! / concurrency), 0);

describe('BrainBench offline shards (ci.yml brainbench job)', () => {
  test('every offline category has a measured weight, and every weight names an offline category', () => {
    expect(dispatch.filter(c => SHARD_SECONDS[c.id] === undefined).map(c => c.id)).toEqual([]);
    expect(Object.keys(SHARD_SECONDS).filter(id => !dispatch.some(c => c.id === id))).toEqual([]);
  });

  test('three shards cover the offline tier exactly once, the same way every time', () => {
    const parts = shardPlan(dispatch, 3, 2);
    expect(parts.flat().map(c => c.id).sort()).toEqual(dispatch.map(c => c.id).sort());
    expect(new Set(parts.flat()).size).toBe(dispatch.length);
    expect(shardPlan(dispatch, 3, 2).map(part => part.map(c => c.id))).toEqual(parts.map(part => part.map(c => c.id)));
  });

  test('each shard expects at most 40% of its 900 s bound, so a runner twice as slow still fits', () => {
    const walls = shardPlan(dispatch, 3, 2).map(part => wall(part));
    for (const w of walls) expect(w).toBeLessThanOrEqual(0.4 * 900);
    expect(wall(dispatch)).toBeGreaterThan(0.75 * 900);
  });

  test('an unmeasured category counts as the slowest measured one', () => {
    const items = [{ id: 'new' }, { id: 'a' }, { id: 'b' }];
    expect(shardPlan(items, 2, 1, { a: 10, b: 1 }).map(part => part.map(c => c.id))).toEqual([['a', 'b'], ['new']]);
  });

  test('--shard parses k/n and refuses anything else', () => {
    expect(parseShard(['--shard', '2/3'])).toEqual({ index: 2, count: 3 });
    expect(parseShard(['--shard=1/1'])).toEqual({ index: 1, count: 1 });
    expect(parseShard([])).toBeNull();
    for (const bad of ['0/3', '4/3', '3', 'a/b']) expect(() => parseShard(['--shard', bad])).toThrow(/--shard must be k\/n/);
  });

  test('the run reports its elapsed time as a share of its bound', () => {
    expect(boundUse('BrainBench offline shard 2/3', 270_400, 900)).toBe('BrainBench offline shard 2/3: 270 s of its 900 s bound (30%)\n');
  });
});
