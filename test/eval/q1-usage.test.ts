/** One usage normalizer (eval/runner/q1/usage.ts): OpenAI counts cached tokens inside its input count, Anthropic beside it. */
import { expect, test } from 'bun:test';
import { answerUsage, normalizeUsage, readerConvention } from '../../eval/runner/q1/usage.ts';
import { runAgent, type Arm } from '../../eval/runner/cat40/loop.ts';
import { parseTranscript } from '../../eval/runner/systems/agent-runtime.ts';

test('OpenAI Chat Completions: a 100-token prompt with 60 cached is 100 in total, 40 uncached', () => {
  const u = normalizeUsage('openai', { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } });
  expect(u).toEqual({ uncached_input: 40, cache_read: 60, cache_write: 0, output: 7, total_input: 100 });
  expect(answerUsage(u)).toEqual({ input: 40, output: 7, cache_read: 60, cache_write: 0 });
});

test('OpenAI Responses API: input_tokens includes input_tokens_details.cached_tokens', () => {
  expect(normalizeUsage('openai', { input_tokens: 62_500, output_tokens: 1_500, input_tokens_details: { cached_tokens: 60_000 } }))
    .toEqual({ uncached_input: 2_500, cache_read: 60_000, cache_write: 0, output: 1_500, total_input: 62_500 });
});

test('Anthropic: input_tokens is uncached; cache reads and writes are separate buckets that add to the total', () => {
  expect(normalizeUsage('anthropic', { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }))
    .toEqual({ uncached_input: 40, cache_read: 50, cache_write: 10, output: 5, total_input: 100 });
});

test('a ChatResult keeps its provider\'s convention: the same buckets mean different totals', () => {
  const chat = { text: 'x', input_tokens: 100, output_tokens: 3, cache_read_tokens: 60, cache_write_tokens: 0, cached: false };
  expect(normalizeUsage(readerConvention('openai:gpt-6.1-sol'), chat).total_input).toBe(100);
  expect(normalizeUsage(readerConvention('anthropic:claude-opus-5-5'), chat).total_input).toBe(160);
  expect(readerConvention('gpt-4o')).toBe('openai');
});

test('missing usage is zero; an inclusive count smaller than its cached part never goes negative', () => {
  expect(normalizeUsage('openai', undefined)).toEqual({ uncached_input: 0, cache_read: 0, cache_write: 0, output: 0, total_input: 0 });
  expect(normalizeUsage('openai', { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 12 } }).uncached_input).toBe(0);
});

test('agent runtime: prompt_tokens includes cache reads and writes (26,122 in, 26,119 written)', () => {
  const t = parseTranscript(JSON.stringify({ type: 'result', subtype: 'success', result: 'Biscuit', usage: { prompt_tokens: 26_122, completion_tokens: 8, cached_input_tokens: 0, cache_write_tokens: 26_119 } }));
  expect(normalizeUsage('openai', t.usage)).toEqual({ uncached_input: 3, cache_read: 0, cache_write: 26_119, output: 8, total_input: 26_122 });
});

test('the agent loop (file agent) sums normalized usage per call on both APIs', async () => {
  const arm: Arm = { name: 'none', systemHint: () => '', tools: () => [], writeTools: () => [], call: async () => '' };
  const responses = (async () => Response.json({ id: 'r1', output: [{ type: 'function_call', name: 'submit_answer', call_id: 'c1', arguments: '{"answer":"x"}' }],
    usage: { input_tokens: 100, output_tokens: 4, input_tokens_details: { cached_tokens: 60 } } })) as unknown as typeof fetch;
  const o = await runAgent({ model: 'gpt-6.1-sol', system: 's', user: 'u', arm, fetchImpl: responses });
  expect(o.usage).toEqual({ input: 40, output: 4, cache_read: 60, cache_write: 0, requests: 1 });
  const messages = (async () => Response.json({ content: [{ type: 'tool_use', id: 't1', name: 'submit_answer', input: { answer: 'x' } }],
    usage: { input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } })) as unknown as typeof fetch;
  const a = await runAgent({ model: 'claude-sonnet-5-5', system: 's', user: 'u', arm, fetchImpl: messages });
  expect(a.usage).toEqual({ input: 40, output: 4, cache_read: 50, cache_write: 10, requests: 1 });
});
