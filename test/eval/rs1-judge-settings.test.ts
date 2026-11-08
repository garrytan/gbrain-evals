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
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { DEFAULT_ROUTE_CAPS, MeteringProxy } from '../../eval/runner/metering-proxy.ts';
import { campaignManifest } from '../../eval/runner/q1/cell.ts';
import { loadManifest, pinnedJudgeRouteCaps } from '../../eval/runner/q1/cells/definitions.ts';
import { loadF6Manifest } from '../../eval/runner/q1/cells/f6.ts';
import { loadRS1Manifest, RS1_JUDGE_BY_READER } from '../../eval/runner/q1/cells/rs1.ts';

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

  test('an RS1 judgment records its view and the model versions the provider returned', async () => {
    const gating = await judgeAnswer(scripted([{}]), BEAM, Q, 'answer', { judge: ASTRA, judgeReplicate: 0, settings: SETTINGS, view: 'gating' });
    expect([gating.view, gating.judge_versions, gating.judge]).toEqual(['gating', ['gpt-6-astra-2026-10-01'], ASTRA]);
    const bridge = await judgeAnswer(scripted([{}]), BEAM, Q, 'answer', { judge: 'openai:gpt-4.1-mini', judgeReplicate: 0, view: 'descriptive' });
    expect([bridge.view, bridge.judge_versions, 'settings' in bridge]).toEqual(['descriptive', ['gpt-6-astra-2026-10-01'], false]);
  });

  test('a judge without pinned settings sends what it sent before and records no settings', async () => {
    const judge = scripted([{ finish: 'length' }]);
    const j = await judgeAnswer(judge, BEAM, Q, 'answer', { judge: 'openai:gpt-4.1-mini', judgeReplicate: 0 });
    expect(judge.opts).toEqual([{ maxTokens: 1024, replicate: 0, temperature: 0 }, { maxTokens: 1024, replicate: 0, temperature: 0 }]);
    expect(j.outcome).toBe('scored');
    expect(['settings', 'calls', 'cache_hits', 'view', 'judge_versions'].filter(k => k in j)).toEqual([]);
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


describe('the judge route admits the pinned cap', () => {
  const caps = (m: Parameters<typeof campaignManifest>[0]) => campaignManifest(m).output_caps!;
  async function admitted(outputCaps: Record<string, number>) {
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => { seen.push(JSON.parse(String(init?.body))); return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5, input_tokens: 10, output_tokens: 5 } }); }) as unknown as typeof fetch;
    const lease = BudgetRun.openLease({ runId: 'judge-cap', leaseUsd: 5, ledgerPath: join(tmp(), 'lease.sqlite') });
    const proxy = new MeteringProxy({ fetchImpl, policy: { lease, env: { OPENAI_API_KEY: 'placeholder-openai', ANTHROPIC_API_KEY: 'placeholder-anthropic' }, usageLog: join(tmp(), 'usage.ndjson'),
      routeCaps: { caps: outputCaps, slots: { judge: 'judge' }, defaultClass: 'extraction' } } });
    proxy.start();
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${proxy.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const astra = await post('/judge/openai/v1/chat/completions', { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'grade' }], max_completion_tokens: 8000, reasoning_effort: 'medium' });
      const opus = await post('/judge/anthropic/v1/messages', { model: 'claude-opus-5-5', max_tokens: 8000, output_config: { effort: 'medium' }, messages: [{ role: 'user', content: 'grade' }] });
      const bridge = await post('/judge/openai/v1/chat/completions', { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'grade' }], max_tokens: 8000 });
      return { astra: astra.status, opus: opus.status, bridge: bridge.status, forwarded: seen.length };
    } finally { proxy.stop(); closeLedgers(); }
  }

  test('an RS1 campaign admits each gating judge at its pinned 8,000-token cap, and only those judges', async () => {
    const rs1 = caps(loadRS1Manifest());
    expect(Object.fromEntries(Object.entries(rs1).filter(([k]) => k.startsWith('judge@')))).toEqual({ 'judge@anthropic:claude-opus-5-5': 8000, 'judge@openai:gpt-6-astra': 8000 });
    expect(await admitted(rs1)).toEqual({ astra: 200, opus: 200, bridge: 400, forwarded: 2 });
  });

  test('Q1 and F6 campaigns keep the default caps, under which a pinned judge call is refused before it is sent', async () => {
    expect(caps(loadManifest())).toEqual({ ...DEFAULT_ROUTE_CAPS });
    expect(caps(loadF6Manifest())).toEqual({ ...DEFAULT_ROUTE_CAPS });
    expect(await admitted({ ...DEFAULT_ROUTE_CAPS })).toEqual({ astra: 400, opus: 400, bridge: 400, forwarded: 0 });
  });

  test('the caps follow the arms: one entry per pinned judge at its pinned output cap, none for arms without pinned settings', () => {
    const rs1 = loadRS1Manifest();
    expect(pinnedJudgeRouteCaps([...rs1.cells, ...rs1.smoke_cells].flatMap(c => c.arms))).toEqual(Object.fromEntries([...new Set(Object.values(RS1_JUDGE_BY_READER))].map(j => ['judge@' + j, 8000])));
    expect(pinnedJudgeRouteCaps(loadManifest().cells.flatMap(c => c.arms))).toEqual({});
  });
});
