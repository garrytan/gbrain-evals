/**
 * gpt-6.2-sol answers any chat request that carries `n` with a 400 (unsupported_parameter), so qa-v2's OpenAI request
 * omits it for every model (n defaults to 1). Keyless: a local server stands in for OpenAI and records each body.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatClient } from '../../eval/runner/memory-qa/qa-v2.ts';

const tmp = mkdtempSync(join(tmpdir(), 'openai-no-n-'));
const bodies: Array<Record<string, unknown>> = [];
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  bodies.push(await req.json() as Record<string, unknown>);
  return Response.json({ id: 'x', model: 'gpt-6.2-sol', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
} });
const saved = { url: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY };
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
process.env.OPENAI_API_KEY = 'keyless-test';
afterAll(() => {
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
  if (saved.url === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = saved.url;
  if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
});

test('no OpenAI chat request carries n, for a reasoning model or a temperature model', async () => {
  const client = new ChatClient(join(tmp, 'cache'), () => 0);
  await client.chat('openai:gpt-6.2-sol', 'Say ok.', { maxTokens: 100, effort: 'medium', replicate: 0 });
  await client.chat('openai:gpt-4.1-mini', 'Say ok.', { maxTokens: 100, replicate: 0 });
  expect(bodies.map(b => b.model)).toEqual(['gpt-6.2-sol', 'gpt-4.1-mini']);
  for (const b of bodies) expect('n' in b).toBe(false);
});
