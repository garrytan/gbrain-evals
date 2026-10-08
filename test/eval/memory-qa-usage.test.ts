/**
 * A1: one provider-normalized usage and answer receipt (eval/runner/usage-receipt.ts)
 * for the memory-qa reader, think and judge calls and the W10 batch rows. Keyless:
 * every provider response here is a recorded synthetic body served by a mocked fetch,
 * or a committed W10 receipt row.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatClient, chatReceipts, chatWithReceipts, approxTokens } from '../../eval/runner/memory-qa/qa.ts';
import { readAndJudge, type RunArgs } from '../../eval/runner/memory-qa/run.ts';
import { normalizeFinish, normalizeUsage, sumUsage, usageSourceOf, type UsageReceipt } from '../../eval/runner/usage-receipt.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'memory-qa-usage-')); dirs.push(d); return d; };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A 100-token prompt of which 60 tokens were read from the prompt cache, 20 output tokens (5 of them reasoning), in each provider's own shape. */
const ANTHROPIC_MESSAGE = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Anthropic answer' }],
  usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 60, output_tokens: 20, output_tokens_details: { thinking_tokens: 5 } },
};
const OPENAI_CHAT = {
  id: 'chatcmpl_1', object: 'chat.completion', model: 'gpt-6.1-sol', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OpenAI answer' } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 5 } },
};
const OPENAI_RESPONSES_USAGE = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } };

type Reply = { status?: number; body: unknown };
/** Mock fetch that serves `replies` in order and records each request's host. */
function serve(replies: Reply[]) {
  const hosts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    hosts.push(new URL(input instanceof Request ? input.url : String(input)).hostname);
    const r = replies.shift();
    if (!r) throw new Error('unexpected provider call');
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return hosts;
}
const judgeYes = { body: { model: 'gpt-4o-mini', choices: [{ finish_reason: 'stop', message: { content: 'yes' } }], usage: { prompt_tokens: 300, completion_tokens: 1 } } };
const judgeNo = { body: { model: 'gpt-4o-mini', choices: [{ finish_reason: 'stop', message: { content: 'no' } }], usage: { prompt_tokens: 300, completion_tokens: 1 } } };

describe('provider conventions', () => {
  test('Anthropic separate cache buckets and OpenAI inclusive prompt_tokens normalize to the same totals', () => {
    const want = { input_total: 100, input_uncached: 40, cache_read: 60, cache_write: 0, output_total: 20, reasoning: 5 };
    expect(normalizeUsage('anthropic', ANTHROPIC_MESSAGE.usage)).toEqual({ convention: 'anthropic', ...want });
    expect(normalizeUsage('openai', OPENAI_CHAT.usage)).toEqual({ convention: 'openai-chat', ...want });
    expect(normalizeUsage('openai', OPENAI_RESPONSES_USAGE)).toEqual({ convention: 'openai-responses', ...want });
  });

  test('cached input is never added on top of an OpenAI prompt_tokens (the Q1 cell.ts double count gives 160)', () => {
    const doubleCounted = OPENAI_CHAT.usage.prompt_tokens + OPENAI_CHAT.usage.prompt_tokens_details.cached_tokens;
    expect(doubleCounted).toBe(160);
    expect(normalizeUsage('openai', OPENAI_CHAT.usage)!.input_total).toBe(100);
    // The same formula is right for Anthropic, whose buckets are separate.
    expect(ANTHROPIC_MESSAGE.usage.input_tokens + ANTHROPIC_MESSAGE.usage.cache_read_input_tokens).toBe(normalizeUsage('anthropic', ANTHROPIC_MESSAGE.usage)!.input_total);
  });

  test('cache writes: an Anthropic separate bucket, an OpenAI subset of prompt_tokens', () => {
    expect(normalizeUsage('anthropic', { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 0, output_tokens: 1 }))
      .toMatchObject({ input_total: 100, input_uncached: 10, cache_write: 90, cache_read: 0 });
    // A committed W10b gpt-6.1-sol row: 12,371 of its 12,374 prompt tokens were cache writes.
    expect(normalizeUsage('openai', { prompt_tokens: 12374, completion_tokens: 88, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 12371 }, completion_tokens_details: { reasoning_tokens: 52 } }))
      .toEqual({ convention: 'openai-chat', input_total: 12374, input_uncached: 3, cache_read: 0, cache_write: 12371, output_total: 88, reasoning: 52 });
  });

  test("gbrain think's usage has no cache split, so its cache fields are null, not zero; missing usage is null", () => {
    expect(normalizeUsage('gbrain-think', { input_tokens: 9000, output_tokens: 300 }))
      .toEqual({ convention: 'gbrain-think', input_total: 9000, input_uncached: null, cache_read: null, cache_write: null, output_total: 300, reasoning: null });
    expect(normalizeUsage('gbrain-think', null)).toBeNull();
    expect(normalizeUsage('anthropic', undefined)).toBeNull();
  });

  test('finish reasons share one vocabulary; model ids map to their convention', () => {
    expect(['end_turn', 'stop', 'length', 'max_tokens', 'tool_calls', 'content_filter', 'pause_turn'].map(normalizeFinish)).toEqual(['stop', 'stop', 'max_tokens', 'max_tokens', 'tool_use', 'refusal', 'pause_turn']);
    expect(usageSourceOf('claude-opus-5-5')).toBe('anthropic');
    expect(usageSourceOf('anthropic:claude-haiku-5-5')).toBe('anthropic');
    expect(usageSourceOf('gpt-6.1-sol')).toBe('openai');
    expect(() => usageSourceOf('voyage:rerank-2.5')).toThrow('no usage convention');
  });
});

describe('ChatClient receipts', () => {
  const ctx = (model: string) => ({ role: 'reader' as const, question_id: 'q1', replicate: 0, model, delivered: null });

  test('both providers through the client: same input total, raw usage and finish kept, full answer', async () => {
    serve([{ body: ANTHROPIC_MESSAGE }, { body: OPENAI_CHAT }]);
    const c = new ChatClient(tmp(), () => 0);
    const a = await c.chat('anthropic:claude-sonnet-5-5', 'p', { maxTokens: 10, replicate: 0 });
    const o = await c.chat('openai:gpt-6.1-sol', 'p', { maxTokens: 10, replicate: 0 });
    expect([a.input_tokens, o.input_tokens]).toEqual([100, 100]);
    const [ra] = chatReceipts(ctx('anthropic:claude-sonnet-5-5'), a);
    const [ro] = chatReceipts(ctx('openai:gpt-6.1-sol'), o);
    expect(ra).toMatchObject({ schema: 'usage-receipt/v1', status: 'ok', attempt: 0, finish: 'stop', finish_raw: 'end_turn', answer: 'Anthropic answer', response_model: 'claude-sonnet-5-5', from_cache: false });
    expect(ro).toMatchObject({ status: 'ok', finish: 'stop', answer: 'OpenAI answer', response_model: 'gpt-6.1-sol' });
    expect(ra.usage_raw).toEqual(ANTHROPIC_MESSAGE.usage);
    const totals = sumUsage([ra, ro]);
    expect(totals).toMatchObject({ records: 2, provider_calls: 2, input_total: 200, input_uncached: 80, cache_read: 120, cache_write: 0, output_total: 40, reasoning: 10 });
  });

  test('retries: one error record per failed attempt, usage only from the response that arrived', async () => {
    serve([{ status: 500, body: { error: 'overloaded' } }, { status: 429, body: { error: 'rate' } }, { body: OPENAI_CHAT }]);
    const c = new ChatClient(tmp(), () => 0);
    const receipts: UsageReceipt[] = [];
    const out = await chatWithReceipts(c, ctx('openai:gpt-6.1-sol'), 'p', { maxTokens: 10, replicate: 0 }, receipts);
    expect(out.attempt_errors).toHaveLength(2);
    expect(receipts.map(r => [r.attempt, r.status])).toEqual([[0, 'error'], [1, 'error'], [2, 'ok']]);
    expect(receipts[0].error).toContain('openai 500');
    expect(sumUsage(receipts)).toMatchObject({ records: 3, provider_calls: 3, errors: 2, retries: 2, input_total: 100, output_total: 20 });
  });

  test('a request that fails every attempt leaves its error records and rethrows', async () => {
    serve([{ status: 400, body: { error: 'bad request' } }]);
    const c = new ChatClient(tmp(), () => 0);
    const receipts: UsageReceipt[] = [];
    await expect(chatWithReceipts(c, ctx('openai:gpt-6.1-sol'), 'p', { maxTokens: 10, replicate: 0 }, receipts)).rejects.toThrow('openai 400');
    expect(receipts.map(r => [r.attempt, r.status])).toEqual([[0, 'error']]);
    expect(sumUsage(receipts)).toMatchObject({ errors: 1, input_total: 0, usage_missing: 0 });
  });

  test('a local cache hit is a record but not a provider call, and keeps the original usage', async () => {
    serve([{ body: OPENAI_CHAT }]);
    const c = new ChatClient(tmp(), () => 0);
    const receipts: UsageReceipt[] = [];
    await chatWithReceipts(c, ctx('openai:gpt-6.1-sol'), 'p', { maxTokens: 10, replicate: 0 }, receipts);
    await chatWithReceipts(c, ctx('openai:gpt-6.1-sol'), 'p', { maxTokens: 10, replicate: 0 }, receipts);
    expect(receipts.map(r => r.from_cache)).toEqual([false, true]);
    expect(receipts[1].usage).toEqual(receipts[0].usage);
    expect(sumUsage(receipts)).toMatchObject({ records: 2, provider_calls: 1, cache_hits: 1 });
  });

  test('a response cached before raw usage was kept still reports its totals, with the cache split unknown', async () => {
    const dir = tmp();
    serve([{ body: OPENAI_CHAT }]);
    const c = new ChatClient(dir, () => 0);
    await c.chat('openai:gpt-6.1-sol', 'p', { maxTokens: 10, replicate: 0 });
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file), JSON.stringify({ text: 'old answer', input_tokens: 100, output_tokens: 20 }));
    const receipts: UsageReceipt[] = [];
    await chatWithReceipts(c, ctx('openai:gpt-6.1-sol'), 'p', { maxTokens: 10, replicate: 0 }, receipts);
    expect(receipts[0]).toMatchObject({ from_cache: true, answer: 'old answer', usage_raw: null, finish: null });
    expect(receipts[0].usage).toEqual({ convention: 'legacy-cache', input_total: 100, input_uncached: null, cache_read: null, cache_write: null, output_total: 20, reasoning: null });
  });
});

describe('memory-qa reading lane (readAndJudge)', () => {
  const qa = (over: Partial<RunArgs['qa']> = {}): RunArgs['qa'] => ({ mode: 'reader', reader: 'anthropic:claude-sonnet-5-5', judge: 'openai:gpt-4o-mini', runs: 1, sessions: 5, budgetTokens: null, thinkModel: 'anthropic:claude-sonnet-5-5', context: 'sessions', ...over });
  const q = { id: 'q1', conversation: 'c1', question: 'When did I move?', category: 'temporal-reasoning', gold: ['s1'], abstention: false, answer: 'May 2023' } as never;

  test("think rows record think's returned usage, not the question's length", async () => {
    serve([judgeYes]);
    const think = async () => ({ answer: 'You moved in May 2023.', synthesis_status: 'ok', modelUsed: 'anthropic:claude-sonnet-5-5', usage: { input_tokens: 9000, output_tokens: 300 }, evidence_delivery: { tokens_delivered: 8200, tokenizer: 'cl100k' } });
    const row = await readAndJudge({ benchmark: 'lme-s', qa: qa({ mode: 'think' }), q, chat: new ChatClient(tmp(), () => 0), think: { fn: think, engine: null }, prompt: null, countTokens: null });
    expect(row.qa_input_tokens).toBe(9000);
    expect(row.qa_input_tokens).not.toBe(approxTokens('When did I move?'));
    expect(row.qa_output_tokens).toBe(300);
    expect(row.qa_delivered_tokens).toBe(8200);
    const [t, j] = row.qa_receipts!;
    expect(t).toMatchObject({ role: 'think', finish: 'stop', finish_raw: 'ok', usage: { convention: 'gbrain-think', input_total: 9000 }, delivered: { tokenizer: 'cl100k', tokens: 8200 } });
    expect(j).toMatchObject({ role: 'judge', status: 'ok', usage: { input_total: 300 } });
    expect(row.qa_score).toBe(1);
  });

  test('think without usage reports the gap instead of a token count', async () => {
    serve([judgeYes]);
    const think = async () => ({ answer: 'May 2023', synthesis_status: 'ok', usage: null });
    const row = await readAndJudge({ benchmark: 'lme-s', qa: qa({ mode: 'think' }), q, chat: new ChatClient(tmp(), () => 0), think: { fn: think, engine: null }, prompt: null, countTokens: null });
    expect(row.qa_usage_missing).toBe(1);
    expect(row.qa_input_tokens).toBeUndefined();
    expect(sumUsage(row.qa_receipts!.filter(r => r.role === 'think'))).toMatchObject({ usage_missing: 1, input_total: 0 });
  });

  test('every replicate keeps its full answer (no 2,000-character cut), with per-replicate usage', async () => {
    const long = 'step '.repeat(1000) + 'Answer: May 2023';
    expect(long.length).toBeGreaterThan(2000);
    const reply = (text: string, input: number) => ({ body: { ...ANTHROPIC_MESSAGE, content: [{ type: 'text', text }], usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } } });
    serve([reply(long, 1000), judgeYes, reply('I do not know.', 1200), judgeNo]);
    const row = await readAndJudge({ benchmark: 'lme-s', qa: qa({ runs: 2 }), q, chat: new ChatClient(tmp(), () => 0), think: null, prompt: 'PROMPT TEXT', countTokens: s => s.length });
    const readers = row.qa_receipts!.filter(r => r.role === 'reader');
    expect(readers.map(r => [r.replicate, r.answer.length])).toEqual([[0, long.length], [1, 'I do not know.'.length]]);
    expect(row.qa_answer).toBe('I do not know.');
    expect(row.qa_scores).toEqual([1, 0]);
    expect(row.qa_input_tokens).toBe(1100);
    expect(row.qa_delivered_tokens).toBe('PROMPT TEXT'.length);
    expect(readers[0].delivered).toEqual({ tokenizer: 'cl100k', tokens: 'PROMPT TEXT'.length });
  });

  test('a reader retry counts once in the token mean and twice in the receipts', async () => {
    serve([{ status: 503, body: { error: 'unavailable' } }, { body: ANTHROPIC_MESSAGE }, judgeYes]);
    const row = await readAndJudge({ benchmark: 'lme-s', qa: qa(), q, chat: new ChatClient(tmp(), () => 0), think: null, prompt: 'P', countTokens: null });
    expect(row.qa_input_tokens).toBe(100);
    const readers = row.qa_receipts!.filter(r => r.role === 'reader');
    expect(readers.map(r => r.status)).toEqual(['error', 'ok']);
    expect(sumUsage(readers)).toMatchObject({ retries: 1, errors: 1, input_total: 100, cache_read: 60 });
  });

  test('a failed reader leaves qa_error and the receipts gathered so far', async () => {
    serve([{ status: 401, body: { error: 'no key' } }]);
    const row = await readAndJudge({ benchmark: 'lme-s', qa: qa(), q, chat: new ChatClient(tmp(), () => 0), think: null, prompt: 'P', countTokens: null });
    expect(row.qa_error).toContain('anthropic 401');
    expect(row.qa_receipts!.map(r => [r.role, r.status])).toEqual([['reader', 'error']]);
  });

  test('a think lane total mixed with cache-split totals reports the split as unknown, never as a partial sum', () => {
    const base = { schema: 'usage-receipt/v1' as const, lane: 'memory-qa', question_id: 'q', replicate: 0, attempt: 0, model: 'm', response_model: null, status: 'ok' as const, error: null, from_cache: false, finish: 'stop', finish_raw: 'stop', answer: 'a', usage_raw: null, delivered: null };
    const totals = sumUsage([
      { ...base, role: 'think', usage: normalizeUsage('gbrain-think', { input_tokens: 10, output_tokens: 1 }) },
      { ...base, role: 'reader', usage: normalizeUsage('anthropic', ANTHROPIC_MESSAGE.usage) },
    ]);
    expect(totals).toMatchObject({ input_total: 110, input_uncached: null, cache_read: null, cache_write: null, output_total: 21 });
  });
});

describe('committed W10 receipts through the normalizer', () => {
  const rows = (path: string) => readFileSync(new URL(`../../docs/benchmarks/${path}/rows.ndjson`, import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { model: string; usage: Record<string, any> });
  const meanInput = (rs: ReturnType<typeof rows>) => Math.round(rs.reduce((s, r) => s + normalizeUsage(usageSourceOf(r.model), r.usage)!.input_total, 0) / rs.length);

  test('rescoring W10a reproduces its 22,167 mean Claude input tokens', () => {
    const w10a = rows('2026-10-07-longmemeval-w10a-current-pin/arms/w10a-sonnet55-notes');
    expect(w10a).toHaveLength(500);
    expect(meanInput(w10a)).toBe(22167);
  });

  test('W10b: Opus 5.5 22,077 Claude tokens and gpt-6.1-sol 13,695 GPT tokens on the same text', () => {
    expect(meanInput(rows('2026-10-07-longmemeval-w10b-reader-replay/arms/w10b-opus55-notes'))).toBe(22077);
    expect(meanInput(rows('2026-10-07-longmemeval-w10b-reader-replay/arms/w10b-sol-notes'))).toBe(13695);
  });

  test('W10b gpt-5.4: 1.27M cached tokens already inside prompt_tokens; adding them would report 17,004, not 14,458', () => {
    const r = rows('2026-10-07-longmemeval-w10b-reader-replay/arms/w10b-gpt54-official');
    const cached = r.reduce((s, x) => s + (x.usage.prompt_tokens_details?.cached_tokens ?? 0), 0);
    expect(cached).toBe(1272832);
    expect(meanInput(r)).toBe(14458);
    expect(Math.round(r.reduce((s, x) => s + x.usage.prompt_tokens + (x.usage.prompt_tokens_details?.cached_tokens ?? 0), 0) / r.length)).toBe(17004);
  });
});
