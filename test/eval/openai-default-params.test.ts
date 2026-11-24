/** The fetch that drops OpenAI's default `n` (eval/runner/providers/openai-default-params.ts), keyless with a recording stub. */
import { describe, expect, test } from 'bun:test';
import { withoutDefaultN } from '../../eval/runner/providers/openai-default-params.ts';

function recorder() {
  const bodies: Array<string | undefined> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => { bodies.push(init?.body as string | undefined); return new Response('{}'); }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

describe('withoutDefaultN', () => {
  test('drops n: 1 from a Chat Completions body and keeps every other field in order', async () => {
    const { bodies, fetchImpl } = recorder();
    await withoutDefaultN(fetchImpl)('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-6.2-sol', messages: [], n: 1, max_completion_tokens: 2000 }) });
    expect(bodies).toEqual([JSON.stringify({ model: 'gpt-6.2-sol', messages: [], max_completion_tokens: 2000 })]);
  });

  test('sends any other n, any other route and a body without n unchanged', async () => {
    const { bodies, fetchImpl } = recorder();
    const send = withoutDefaultN(fetchImpl);
    const two = JSON.stringify({ model: 'gpt-6.2-sol', n: 2 });
    const messages = JSON.stringify({ model: 'claude-opus-5-5', n: 1 });
    const plain = JSON.stringify({ model: 'gpt-6.2-sol', messages: [{ role: 'user', content: 'say "n":1' }] });
    await send('https://api.openai.com/v1/chat/completions', { method: 'POST', body: two });
    await send('https://api.anthropic.com/v1/messages', { method: 'POST', body: messages });
    await send('http://127.0.0.1:9/v1/chat/completions', { method: 'POST', body: plain });
    expect(bodies).toEqual([two, messages, plain]);
  });
});
