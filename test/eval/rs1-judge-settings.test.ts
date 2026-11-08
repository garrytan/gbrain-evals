/**
 * RS1's pinned per-reader judges (GBEV-3's gate reply e1, 2026-11-08) and the judge cache: every gating judge call is
 * sent at medium effort with an 8,000-token output cap, a truncated reply is a judge_error, truncated and refused
 * replies never reach the cache, and each judgment records its settings, calls and cache hits. Judges without pinned
 * settings (the canonical gpt-4.1-mini, Q1, F6) send exactly what they sent before.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { ChatClient, judgeAnswer, type ChatLike, type ChatOptions, type ChatResultV2 } from '../../eval/runner/memory-qa/qa-v2.ts';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';

const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => { globalThis.fetch = realFetch; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'rs1-judge-')); dirs.push(d); return d; };

const BEAM = instrumentFor('beam-rs1');
const Q = { id: 'q1', conversation: 'c', question: 'Q?', category: 'information_extraction', gold: [], abstention: false, answer: 'A', rubric: ['r1', 'r2'] } as unknown as MemoryQuestion;
const SETTINGS = { effort: 'medium', max_tokens: 8000 };
const ASTRA = 'openai:gpt-6-astra';

/** A mocked OpenAI chat endpoint serving `replies` in order (the last repeats); returns the request bodies it saw. */
function serve(replies: Array<{ content: string; finish: string }>) {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const r = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return new Response(JSON.stringify({ model: 'gpt-6-astra-2026-10-01', choices: [{ message: { content: r.content }, finish_reason: r.finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return bodies;
}

/** A judge client that records each call's options and answers from a script of finishes and cache flags. */
function scripted(script: Array<{ finish?: string; cached?: boolean; text?: string }>): ChatLike & { opts: ChatOptions[] } {
  const opts: ChatOptions[] = [];
  return {
    opts,
    async chat(_model: string, _prompt: string, o: ChatOptions): Promise<ChatResultV2> {
      const s = script[Math.min(opts.length, script.length - 1)];
      opts.push(o);
      return { text: s.text ?? '{"score": 1.0, "reason": "ok"}', input_tokens: 1, output_tokens: 1, cached: s.cached ?? false, finish: s.finish ?? 'stop', usage: null, response_model: 'gpt-6-astra-2026-10-01', attempt_errors: [] } as ChatResultV2;
    },
  };
}

describe('the judge cache', () => {
  test('a reply whose finish is listed in uncachedFinishes is returned but never cached; the next call asks again', async () => {
    const bodies = serve([{ content: '{"score": 1', finish: 'length' }, { content: '{"score": 1.0}', finish: 'stop' }]);
    const root = tmp();
    const c = new ChatClient(root, () => 0);
    const o = { maxTokens: 8000, replicate: 0, effort: 'medium', uncachedFinishes: ['length', 'refusal'] };
    const first = await c.chat(ASTRA, 'p', o);
    expect([first.finish, first.cached]).toEqual(['length', false]);
    expect(readdirSync(root)).toEqual([]);
    const second = await c.chat(ASTRA, 'p', o);
    expect([second.finish, second.cached, bodies.length]).toEqual(['stop', false, 2]);
    expect(readdirSync(root)).toHaveLength(1);
    const third = await c.chat(ASTRA, 'p', o);
    expect([third.cached, bodies.length]).toEqual([true, 2]);
  });
});

describe('pinned judge settings', () => {
  test('a pinned judge sends every call at medium effort and an 8,000-token cap, keeps failures out of the cache and records settings, calls and hits', async () => {
    const judge = scripted([{ cached: true }, { cached: false }]);
    const j = await judgeAnswer(judge, BEAM, Q, 'answer', { judge: ASTRA, judgeReplicate: 0, settings: SETTINGS });
    expect(judge.opts.map(o => [o.maxTokens, o.effort])).toEqual([[8000, 'medium'], [8000, 'medium']]);
    for (const o of judge.opts) expect(o.uncachedFinishes).toEqual(['length', 'max_tokens', 'refusal', 'content_filter']);
    expect([j.outcome, j.score, j.settings, j.calls, j.cache_hits]).toEqual(['scored', 1, SETTINGS, 2, 1]);
  });

  test('a truncated reply from a pinned judge is a judge_error at once, not retried', async () => {
    for (const finish of ['length', 'max_tokens']) {
      const judge = scripted([{ finish, text: '{"score": 1.0' }]);
      const j = await judgeAnswer(judge, BEAM, Q, 'answer', { judge: ASTRA, judgeReplicate: 0, settings: SETTINGS, maxAttempts: 3 });
      expect([finish, j.outcome, j.score, j.calls, (j.detail as { truncated?: boolean }).truncated]).toEqual([finish, 'judge_error', null, 1, true]);
      expect(String((j.detail as { error: string }).error)).toContain('8000-token output cap');
    }
  });

  test('a judge without pinned settings sends what it sent before and records no settings', async () => {
    const judge = scripted([{ finish: 'length' }]);
    const j = await judgeAnswer(judge, BEAM, Q, 'answer', { judge: 'openai:gpt-4.1-mini', judgeReplicate: 0 });
    expect(judge.opts).toEqual([{ maxTokens: 1024, replicate: 0, temperature: 0 }, { maxTokens: 1024, replicate: 0, temperature: 0 }]);
    expect(j.outcome).toBe('scored');
    expect(['settings', 'calls', 'cache_hits'].filter(k => k in j)).toEqual([]);
  });

  test('through the chat client, a pinned judge\'s truncated reply is not cached, so a resume asks again', async () => {
    const bodies = serve([{ content: '{"score": 1.0', finish: 'length' }]);
    const root = tmp();
    const c = new ChatClient(root, () => 0);
    const j = await judgeAnswer(c, BEAM, Q, 'answer', { judge: ASTRA, judgeReplicate: 0, settings: SETTINGS });
    expect(j.outcome).toBe('judge_error');
    expect(readdirSync(root)).toEqual([]);
    expect(bodies[0]).toMatchObject({ model: 'gpt-6-astra', max_completion_tokens: 8000, reasoning_effort: 'medium' });
    await judgeAnswer(c, BEAM, Q, 'answer', { judge: ASTRA, judgeReplicate: 0, settings: SETTINGS });
    expect(bodies).toHaveLength(2);
  });
});
