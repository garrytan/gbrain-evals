/**
 * The nightly's content-addressed caches (eval/runner/nightly/judge-cache.ts): one judgment per judge key, with a changed
 * verdict for the same key reported as judge drift, and one reader answer per context digest.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextDigest, judgeKey, NightlyCache, qaPromptVersion } from '../../eval/runner/nightly/judge-cache.ts';

const cache = () => new NightlyCache(mkdtempSync(join(tmpdir(), 'nightly-cache-')));
const key = { judge: 'openai:gpt-6-astra', promptVersion: 'p1', questionId: 'q1', gold: { answer: 'Paris', rubric: null }, answer: 'Paris.' };

describe('the nightly caches', () => {
  test('judge keys cover the judge, prompt version, question, gold and answer, and ignore key order inside the gold', () => {
    expect(judgeKey(key)).toBe(judgeKey({ ...key, gold: { rubric: null, answer: 'Paris' } }));
    for (const change of [{ judge: 'anthropic:claude-opus-5-5' }, { promptVersion: 'p2' }, { questionId: 'q2' }, { gold: { answer: 'Lyon', rubric: null } }, { answer: 'Lyon.' }]) {
      expect(judgeKey({ ...key, ...change })).not.toBe(judgeKey(key));
    }
    expect(qaPromptVersion()).toMatch(/^[0-9a-f]{16}$/);
  });

  test('a judgment is stored once; the same verdict later is quiet, a different one is judge drift and keeps the first', () => {
    const c = cache();
    expect(c.putJudgment(key, { score: 1, night: '2026-11-08' })).toBeNull();
    expect(c.putJudgment(key, { score: 1, night: '2026-11-09' })).toBeNull();
    expect(c.putJudgment(key, { score: 0, night: '2026-11-10' })).toEqual({ score: 1, night: '2026-11-08' });
    expect(c.getJudgment(key)).toEqual({ score: 1, night: '2026-11-08' });
  });

  test('a context entry is keyed by the exact context: byte-identical context finds the earlier night, any change misses', () => {
    const c = cache();
    const k = { reader: 'gpt-6.1-sol', judge: 'anthropic:claude-opus-5-5', promptVersion: 'p1', questionId: 'q1', contextDigest: contextDigest('["s1","s2"]') };
    c.putContext(k, { answer: 'Paris', score: 1, night: '2026-11-08', row: {} });
    expect(c.getContext(k)).toMatchObject({ answer: 'Paris', night: '2026-11-08' });
    expect(c.getContext({ ...k, contextDigest: contextDigest('["s2","s1"]') })).toBeNull();
    expect(c.chatDir.endsWith('/chat')).toBe(true);
  });
});
