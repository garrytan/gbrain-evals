/**
 * Cat 40's particle-1 branch (eval/runner/cat40/loop.ts particleLoop; plan GST-605 Phase 3, unit U8), keyless: the
 * scripted provider in cat40-loop-driver.ts answers every request, and no test reaches a network.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptReceipt, priceUsage, provider, runAgentText, type ProviderAttempt } from '../../eval/runner/cat40/loop.ts';
import { PROSE_ANSWER_TOOL } from '../../eval/runner/systems/file-agent.ts';
import { drive, type DriverFault, type DriverRequest } from './cat40-loop-driver.ts';

const ROOT = join(import.meta.dir, '../..');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test/eval/fixtures/cat40-loop-bodies.json'), 'utf8')) as Record<string, DriverRequest[]>;
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PARTICLE_API_KEY', 'PARTICLE_BASE_URL'] as const;
let saved: Record<string, string | undefined> = {};
let delays: number[] = [];
const realSetTimeout = globalThis.setTimeout;
const realRandom = Math.random;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', PARTICLE_API_KEY: 'test-key' });
  delete process.env.PARTICLE_BASE_URL;
  delays = [];
  // Record every backoff wait and run it at once; a fixed jitter makes the default backoff exact.
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { delays.push(ms ?? 0); fn(); return 0; }) as unknown as typeof setTimeout;
  Math.random = () => 0.5;
});
afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  Math.random = realRandom;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const bodies = (requests: DriverRequest[]) => requests.map(r => JSON.parse(r.body) as Record<string, any>);
const rateLimited = (headers?: Record<string, string>): DriverFault => ({ status: 429, headers });

describe('Anthropic and OpenAI loops are unchanged', () => {
  test('claude-opus-5-5 and gpt-6.1-sol request bodies are byte-identical to main\'s, with and without the file agent\'s effort', async () => {
    for (const [name, p, model, cfg] of [
      ['anthropic', 'anthropic', 'claude-opus-5-5', {}],
      ['openai', 'openai', 'gpt-6.1-sol', {}],
      ['anthropic-file-agent', 'anthropic', 'claude-opus-5-5', { effort: 'medium', submitTool: PROSE_ANSWER_TOOL, maxToolChars: null }],
      ['openai-file-agent', 'openai', 'gpt-6.1-sol', { effort: 'medium', submitTool: PROSE_ANSWER_TOOL, maxToolChars: null }],
    ] as const) {
      const { run, requests } = await drive(p, model, cfg);
      expect(run.stop).toBe('submitted');
      expect(requests).toEqual(FIXTURE[name]);
    }
  });

  test('their retry timing is the exponential backoff, and a Retry-After header does not change it', async () => {
    for (const [p, model] of [['anthropic', 'claude-opus-5-5'], ['openai', 'gpt-6.1-sol']] as const) {
      delays = [];
      const { run, attempts } = await drive(p, model, {}, { faults: [rateLimited({ 'retry-after': '30' }), { status: 503 }] });
      expect(run.stop).toBe('submitted');
      expect(delays).toEqual([2000 + 500, 4000 + 500]);
      expect(attempts.map(a => a.status)).toEqual(['error', 'error', 'ok', 'ok', 'ok']);
      expect(attempts.every(a => a.retry_after_ms === undefined)).toBe(true);
    }
  });

  test('a non-retryable status ends the run after one attempt, as before', async () => {
    const { run, attempts } = await drive('anthropic', 'claude-opus-5-5', {}, { faults: [{ status: 400, body: 'bad request' }] });
    expect(run.stop).toBe('error');
    expect(run.error).toContain('provider error 400');
    expect(attempts).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  test('every attempt carries its turn and what the request sent', async () => {
    const { attempts } = await drive('openai', 'gpt-6.1-sol', { effort: 'medium' });
    expect(attempts.map(a => a.turn)).toEqual([1, 2, 3]);
    expect(attempts[0].request).toEqual({ effort_sent: 'medium', effort_effective: 'medium', output_limit_field: 'max_output_tokens', output_limit: 16_000, temperature_sent: null, seed_sent: null });
    const a = await drive('anthropic', 'claude-opus-5-5');
    expect(a.attempts[0].request).toMatchObject({ effort_sent: null, output_limit_field: 'max_tokens', output_limit: 8192 });
  });
});

describe('particleLoop', () => {
  test('provider() routes particle-1, and its usage is priced at the ledger\'s Particle rates', () => {
    expect(provider('particle-1')).toBe('particle');
    expect(priceUsage('particle-1', { input: 1_000_000, cache_read: 1_000_000, cache_write: 0, output: 1_000_000, requests: 1 })).toBeCloseTo(0.25 + 0.03 + 1.0, 10);
  });

  test('Chat Completions with tools, the nudge, tool results and one prompt cache key per conversation', async () => {
    process.env.PARTICLE_BASE_URL = 'http://127.0.0.1:9/slot-1/particle/v1';
    const { run, requests, attempts } = await drive('particle', 'particle-1');
    expect(run.stop).toBe('submitted');
    expect(run.final?.answer).toBe('42');
    expect(run.turns).toBe(3);
    expect(requests.map(r => r.url)).toEqual(Array(3).fill('http://127.0.0.1:9/slot-1/particle/v1/chat/completions'));
    expect(requests[0].headerNames).toEqual(['authorization', 'content-type']);
    const [b1, b2, b3] = bodies(requests);
    expect(Object.keys(b1)).toEqual(['model', 'messages', 'tools', 'tool_choice', 'reasoning_effort', 'max_completion_tokens', 'prompt_cache_key']);
    expect(b1).toMatchObject({ model: 'particle-1', tool_choice: 'auto', reasoning_effort: 'high', max_completion_tokens: 16_000 });
    expect(b1.temperature).toBeUndefined();
    expect(b1.seed).toBeUndefined();
    expect(b1.messages).toEqual([{ role: 'system', content: 'You answer from the knowledge base.' }, { role: 'user', content: 'What is a?' }]);
    expect(b1.tools.map((t: any) => t.function.name)).toEqual(['lookup', 'submit_answer']);
    expect(b1.tools[0]).toEqual({ type: 'function', function: { name: 'lookup', description: 'Look up a key.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } });
    const key = createHash('sha256').update('cat40\u0000particle-1\u0000You answer from the knowledge base.\u0000What is a?').digest('hex').slice(0, 32);
    expect([b1, b2, b3].map(b => b.prompt_cache_key)).toEqual([key, key, key]);
    expect(b2.messages.slice(2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"key":"a"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'value of a' },
    ]);
    expect(b3.messages.slice(4)).toEqual([{ role: 'assistant', content: 'The value is known.' }, { role: 'user', content: 'Please call submit_answer now with your final answer.' }]);
    expect(JSON.stringify(b3)).not.toContain('reasoning_content');
    expect(run.usage).toEqual({ input: 3 * 200 + 6, output: 900, cache_read: 2400, cache_write: 0, requests: 3 });
    expect(run.usd).toBeCloseTo(priceUsage('particle-1', run.usage), 12);
    expect(run.unparseable_tool_turns).toBeUndefined();
    expect(attempts.map(a => a.turn)).toEqual([1, 2, 3]);
    expect(attempts[0].request).toEqual({ effort_sent: 'high', effort_effective: 'high', output_limit_field: 'max_completion_tokens', output_limit: 16_000, temperature_sent: null, seed_sent: null });
  });

  test('a passed effort and output limit are sent, and the effective level is recorded', async () => {
    const { requests, attempts } = await drive('particle', 'particle-1', { effort: 'medium', maxOutputTokens: 20_000 });
    expect(bodies(requests)[0]).toMatchObject({ reasoning_effort: 'medium', max_completion_tokens: 20_000 });
    expect(attempts[0].request).toMatchObject({ effort_sent: 'medium', effort_effective: 'high', output_limit: 20_000 });
  });

  test('a fake 429, 429, 200 gives three onAttempt calls; Retry-After is waited, capped at 120 s, and recorded', async () => {
    const { run, attempts } = await drive('particle', 'particle-1', {}, { faults: [rateLimited({ 'retry-after': '0' }), rateLimited({ 'retry-after': '600' })] });
    expect(run.stop).toBe('submitted');
    const turn1 = attempts.filter(a => a.turn === 1);
    expect(turn1.map(a => a.status)).toEqual(['error', 'error', 'ok']);
    expect(turn1.map(a => a.retry_after_ms)).toEqual([0, 120_000, undefined]);
    expect(delays).toEqual([0, 120_000]);
  });

  test('without a Retry-After header the backoff is the other branches\'', async () => {
    await drive('particle', 'particle-1', {}, { faults: [{ status: 503 }] });
    expect(delays).toEqual([2500]);
  });

  test('a credit 402 records its attempt, then stops the run with the budget stop', async () => {
    const attempts: ProviderAttempt[] = [];
    const err = await drive('particle', 'particle-1', { onAttempt: a => attempts.push(a) }, { faults: [{ status: 402, body: '{"error":{"message":"Insufficient credits"}}' }] }).then(() => null, e => e);
    expect(err?.name).toBe('BudgetExceededError');
    expect(err?.message).toStartWith('budget: Particle credit exhausted');
    expect(err?.status).toBe(402);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'error', response: null, turn: 1, retry_after_ms: null });
    expect(delays).toEqual([]);
  });

  test('a metering proxy\'s 402 stays a budget stop, not credit exhaustion', async () => {
    const err = await drive('particle', 'particle-1', {}, { faults: [{ status: 402, body: '{"error":"metering proxy: lease exhausted"}' }] }).then(() => null, e => e);
    expect(err?.name).toBe('BudgetExceededError');
    expect(err?.message).toStartWith('budget: the metering proxy refused');
  });

  test('a context-length 400 is a context overflow on Hard runs', async () => {
    const { run } = await drive('particle', 'particle-1', { classifyStops: true }, { faults: [{ status: 400, body: '{"error":{"message":"This model\'s maximum context length is 1048576 tokens"}}' }] });
    expect(run.stop).toBe('context_overflow');
  });

  test('a 2xx without choices[0].message is retried, its usage kept on the error attempt', async () => {
    const empty = { id: 'x', model: 'particle-ai/particle-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const { run, attempts } = await drive('particle', 'particle-1', {}, { faults: [{ status: 200, body: JSON.stringify(empty) }] });
    expect(run.stop).toBe('submitted');
    expect(attempts[0]).toMatchObject({ status: 'error', response: empty, turn: 1 });
    expect(attempts[0].error).toContain('without choices[0].message');
    expect(delays).toEqual([2500]);
  });

  test('a network failure is recorded as an attempt and ends the run as an error', async () => {
    const attempts: ProviderAttempt[] = [];
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const { run } = await drive('particle', 'particle-1', { fetchImpl, onAttempt: a => attempts.push(a) });
    expect(run.stop).toBe('error');
    expect(attempts).toEqual([expect.objectContaining({ status: 'error', response: null, error: 'network: fetch failed', retry_after_ms: null, turn: 1 })]);
  });

  test('a tool call whose arguments do not parse runs with {} and its turn is counted', async () => {
    const { run, requests } = await drive('particle', 'particle-1', {}, { badArgs: true });
    expect(run.stop).toBe('submitted');
    expect(run.unparseable_tool_turns).toBe(1);
    expect(bodies(requests)[1].messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'value of undefined' });
  });

  test('a missing key or an unlisted host refuses before any request', async () => {
    delete process.env.PARTICLE_API_KEY;
    const missing = await drive('particle', 'particle-1');
    expect(missing.run.stop).toBe('error');
    expect(missing.run.error).toContain('PARTICLE_API_KEY is not set');
    expect(missing.requests).toHaveLength(0);
    process.env.PARTICLE_API_KEY = 'test-key';
    process.env.PARTICLE_BASE_URL = 'https://particle.example.com/v1';
    const err = await drive('particle', 'particle-1').then(() => null, e => e);
    expect(err?.name).toBe('BudgetExceededError');
    expect(err?.message).toContain('cannot price particle.example.com');
  });

  test('runAgentText refuses particle-1: it never judges', async () => {
    await expect(runAgentText('particle-1', 's', 'u')).rejects.toThrow('never judges');
  });
});

describe('attemptReceipt', () => {
  test('one usage receipt per attempt for every provider, with Particle\'s request and response metadata', async () => {
    const ids = { lane: 'test', role: 'reader' as const, question_id: 'q', replicate: 0, attempt: 0 };
    const particle = await drive('particle', 'particle-1', {}, { faults: [rateLimited({ 'retry-after': '1' })] });
    const [fail, ok] = particle.attempts.map((a, i) => attemptReceipt('particle-1', a, { ...ids, attempt: i }));
    expect(fail).toMatchObject({ schema: 'usage-receipt/v1', model: 'particle:particle-1', status: 'error', response_model: null, usage: null, usage_raw: null, turn: 1, retry_after_ms: 1000 });
    expect(fail.request).toMatchObject({ effort_sent: 'high', output_limit: 16_000 });
    expect(fail.response_meta).toEqual({ metadata: null, weight_version: null, service_tier: null, system_fingerprint: null, non_default_tier: null, truncated: null });
    expect(ok).toMatchObject({ status: 'ok', response_model: 'particle-ai/particle-1', finish: 'tool_use', finish_raw: 'tool_calls', answer: '[tool_use lookup] {"key":"a"}', turn: 1 });
    expect(ok.usage).toEqual({ convention: 'openai-chat', input_total: 1001, input_uncached: 201, cache_read: 800, cache_write: 0, output_total: 300, reasoning: 250 });
    expect(ok.response_meta).toMatchObject({ weight_version: 'default', service_tier: 'default', system_fingerprint: 'fp_driver', non_default_tier: false, truncated: false });
    const anthropic = (await drive('anthropic', 'claude-opus-5-5')).attempts.map(a => attemptReceipt('claude-opus-5-5', a, ids));
    expect(anthropic[0]).toMatchObject({ model: 'anthropic:claude-opus-5-5', response_model: 'claude-opus-5-5', finish: 'tool_use', answer: '[tool_use lookup] {"key":"a"}', retry_after_ms: null });
    expect(anthropic[0].usage).toMatchObject({ convention: 'anthropic', input_total: 171, cache_read: 50, cache_write: 20 });
    expect(anthropic[0].response_meta).toBeUndefined();
    const openai = (await drive('openai', 'gpt-6.1-sol')).attempts.map(a => attemptReceipt('gpt-6.1-sol', a, ids));
    expect(openai[1]).toMatchObject({ model: 'openai:gpt-6.1-sol', finish_raw: 'completed', answer: 'The value is known.' });
    expect(openai[1].usage).toMatchObject({ convention: 'openai-responses', input_total: 102, cache_read: 40 });
  });
});
