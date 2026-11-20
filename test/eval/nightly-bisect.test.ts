/**
 * The nightly bisect (eval/runner/nightly/bisect.ts): binary search over first-parent commits for the first bad one, on a
 * fixture history with a merged branch, and the rule that decides whether a commit is bad.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bisect, firingItemsBad, firstParentCommits, stepFlags } from '../../eval/runner/nightly/bisect.ts';

const commits = Array.from({ length: 16 }, (_, i) => `c${String(i).padStart(2, '0')}`);

describe('bisect', () => {
  test('finds the first bad commit in at most 4 steps over a night of 16 commits, wherever it is', async () => {
    for (const firstBad of [0, 1, 7, 8, 14, 15]) {
      const tried: string[] = [];
      const r = await bisect(commits, async sha => { tried.push(sha); return commits.indexOf(sha) >= firstBad; });
      expect(r.first_bad).toBe(commits[firstBad]!);
      expect(r.steps.length).toBeLessThanOrEqual(4);
      expect(r.steps.map(s => s.sha)).toEqual(tried);
    }
    expect(await bisect([], async () => true)).toEqual({ first_bad: null, steps: [] });
  });

  test('a commit is bad when at least half of the firing items\' trials fail; harness rows do not count', () => {
    const rows = (passes: boolean[]) => passes.map((pass, i) => ({ item: i % 2 ? 'b' : 'a', pass, harness: null }));
    expect(firingItemsBad(rows([false, false, true, true]), ['a', 'b'])).toBe(true);
    expect(firingItemsBad(rows([false, true, true, true]), ['a', 'b'])).toBe(false);
    expect(firingItemsBad([...rows([true, true]), { item: 'a', pass: false, harness: { error: 'provider' } }], ['a', 'b'])).toBe(false);
    expect(() => firingItemsBad([{ item: 'a', pass: false, harness: { error: 'provider' } }], ['a'])).toThrow('no outcome for the firing items a');
  });

  test('skipped rows (items the step did not run) do not count, and a step whose firing items were all skipped stops the bisect', () => {
    const skipped = { item: 'a', pass: false, harness: null, skipped: 'gbrain predates the suite' };
    expect(firingItemsBad([{ item: 'a', pass: true, harness: null }, skipped], ['a'])).toBe(false);
    expect(() => firingItemsBad([skipped, skipped], ['a'])).toThrow('no outcome for the firing items a');
  });

  test('each step gets the paid flags, the reader and the settings a Cat 40 or Postgres suite needs', () => {
    const argv = ['--suite', 'cat40-hard-m', '--items', 'a,b', '--good', 'g', '--bad', 'b', '--gbrain-clone', '/g', '--out', '/o', '--paid', '--budget-run-id', 'nightly:x',
      '--budget-ledger', '/ledger.sqlite', '--cat40-slot-allowance-usd', '2', '--pg-admin', 'postgres://a', '--pg-template', 'tpl', '--pg15-admin', 'postgres://b', '--reader', 'gpt-6.1-sol'];
    expect(stepFlags(argv)).toEqual(['--paid', '--budget-run-id', 'nightly:x', '--budget-ledger', '/ledger.sqlite', '--cat40-slot-allowance-usd', '2', '--pg-admin', 'postgres://a',
      '--pg-template', 'tpl', '--pg15-admin', 'postgres://b', '--readers', 'gpt-6.1-sol']);
    expect(stepFlags(['--suite', 's', '--fake'])).toEqual(['--fake']);
  });

  test('the range is first-parent: a merged branch is the one commit that brought it in', () => {
    const repo = mkdtempSync(join(tmpdir(), 'nightly-bisect-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args], { encoding: 'utf8' }).trim();
    const commit = (name: string) => { writeFileSync(join(repo, name), name); git('add', name); git('commit', '-qm', name); return git('rev-parse', 'HEAD'); };
    git('init', '-q', '-b', 'master');
    const good = commit('base');
    const m1 = commit('m1');
    git('checkout', '-qb', 'topic');
    commit('t1');
    commit('t2');
    git('checkout', '-q', 'master');
    git('merge', '-q', '--no-ff', 'topic', '-m', 'merge topic');
    const merge = git('rev-parse', 'HEAD');
    const m2 = commit('m2');
    expect(firstParentCommits(repo, good, m2)).toEqual([m1, merge, m2]);
  });
});
