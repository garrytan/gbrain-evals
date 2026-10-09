/**
 * Metering proxy, stub upstream and the ledger's Gemini/Groq/SSE pricing.
 *
 * Every request in this file goes to a local stub. No proxy here holds a
 * real key: proxies get `realKeys: {}` or fake keys, and children get a
 * clean environment.
 *
 * The harness Python test needs the pinned harness venv (`bun run
 * harness:setup`). It runs when the venv is installed, fails when
 * MPW_REQUIRE_HARNESS=1 and the venv is missing (CI sets this), and is
 * skipped with a message otherwise.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BudgetRun, closeLedgers, initLedger, ledgerStatus, priceRequest, reservationUsd, streamUsageCost, usageCost,
} from '../../eval/runner/budget-ledger.ts';
import { REFUSAL_TYPE, retrySafe, startMeteringProxy, type RequestLogLine } from '../../eval/runner/harness-metering-proxy.ts';
import { assertZeroBalanceBlocks, createMeteredTestCell, waitFor, type MeteredTestCell } from '../../eval/runner/metering-proxy-testkit.ts';
import { hashVector, schemaInstance, startStubUpstream } from '../../eval/runner/stub-upstream.ts';
import { ensureHarness, harnessProcessEnv, type HarnessInstall } from '../../eval/runner/harness-env.ts';
import { strippedKeysIn } from '../../eval/runner/hermetic-env.ts';

const REPO = resolve(import.meta.dir, '../..');
const REAL_KEY_NAMES = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY', 'VOYAGE_API_KEY'];
const RETRY_TRIGGER = /429|500|502|503|504|529|rate/i;

const cells: MeteredTestCell[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of cells.splice(0)) await c.close();
  closeLedgers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function cell(options: Parameters<typeof createMeteredTestCell>[0]) {
  const c = await createMeteredTestCell(options);
  cells.push(c);
  return c;
}
const post = (url: string, headers: Record<string, string>, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─── Pricing ──────────────────────────────────────────────────────────

describe('Gemini and Groq pricing', () => {
  test('generateContent reads the model from the path and reserves the full output ceiling when no limit is set', () => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'x'.repeat(3000) }] }], systemInstruction: { parts: [{ text: 'judge' }] } };
    const p = priceRequest(`${GEMINI}/gemini-3.5-flash:generateContent`, body)!;
    expect(p).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash', kind: 'chat', input: 1.5, output: 9, maxOutputTokens: 65_536 });
    expect(p.inputTokens).toBe(Math.ceil((4 + 3000 + 5) / 3) + 16);
    expect(reservationUsd(p)).toBeCloseTo((p.inputTokens * 1.5 + 65_536 * 9) / 1e6, 12);
    const limited = priceRequest(`${GEMINI}/gemini-3.8-flash:streamGenerateContent?alt=sse`, { ...body, generationConfig: { maxOutputTokens: 1000, thinkingConfig: { thinkingBudget: 512 } } })!;
    expect(limited).toMatchObject({ model: 'gemini-3.8-flash', input: 0.75, output: 3.75, maxOutputTokens: 1512 });
  });

  test('response schemas and tools count as input', () => {
    const schema = { type: 'OBJECT', properties: { answer: { type: 'STRING', description: 'x'.repeat(300) } } };
    const plain = priceRequest(`${GEMINI}/gemini-3.5-flash:generateContent`, { contents: [] })!;
    const structured = priceRequest(`${GEMINI}/gemini-3.5-flash:generateContent`, { contents: [], generationConfig: { responseSchema: schema } })!;
    expect(structured.inputTokens - plain.inputTokens).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(schema)) / 3));
  });

  test('countTokens and model listings are free; embeddings price from gbrain\'s Google table', () => {
    expect(priceRequest(`${GEMINI}/gemini-3.5-flash:countTokens`, { contents: [] })).toBeNull();
    expect(priceRequest(`${GEMINI}`, undefined)).toBeNull();
    expect(priceRequest(`${GEMINI}/gemini-3.5-flash`, undefined)).toBeNull();
    const one = priceRequest(`${GEMINI}/gemini-embedding-2:embedContent`, { content: { parts: [{ text: 'abc' }] } })!;
    expect(one).toMatchObject({ provider: 'gemini', kind: 'embedding', input: 0.2, output: 0, inputTokens: 1 + 16 });
    const batch = priceRequest(`${GEMINI}/gemini-embedding-2:batchEmbedContents`, { requests: [{ content: { parts: [{ text: 'abcdef' }] } }, { content: { parts: [{ text: 'abc' }] } }] })!;
    expect(batch).toMatchObject({ kind: 'embedding', inputTokens: 3 + 16 });
  });

  test('an unpriced Gemini model or method is refused, never sent at an unknown cost', () => {
    expect(() => priceRequest(`${GEMINI}/gemini-9-ultra:generateContent`, { contents: [] })).toThrow('no chat price for gemini:gemini-9-ultra');
    expect(() => priceRequest(`${GEMINI}/gemini-embedding-9:embedContent`, { content: {} })).toThrow('no embedding price');
    expect(() => priceRequest(`${GEMINI}/gemini-3.5-flash:predictLongRunning`, {})).toThrow('cannot price the Gemini method');
    expect(() => priceRequest('https://generativelanguage.googleapis.com/v1beta/files', {})).toThrow('cannot price the Gemini request');
  });

  test('Gemini Pro switches to long-context prices above 200k prompt tokens, in the reservation and at settlement', () => {
    const short = priceRequest(`${GEMINI}/gemini-3.1-pro-preview:generateContent`, { contents: 'x'.repeat(30_000), generationConfig: { maxOutputTokens: 100 } })!;
    expect(reservationUsd(short)).toBeCloseTo((short.inputTokens * 2 + 100 * 12) / 1e6, 12);
    const long = priceRequest(`${GEMINI}/gemini-3.1-pro-preview:generateContent`, { contents: 'x'.repeat(700_000), generationConfig: { maxOutputTokens: 100 } })!;
    expect(long.inputTokens).toBeGreaterThan(200_000);
    expect(reservationUsd(long)).toBeCloseTo((long.inputTokens * 4 + 100 * 18) / 1e6, 12);
    expect(usageCost(short, { usageMetadata: { promptTokenCount: 250_000, candidatesTokenCount: 10 } })!.usd).toBeCloseTo((250_000 * 4 + 10 * 18) / 1e6, 12);
    expect(usageCost(short, { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 10 } })!.usd).toBeCloseTo((1000 * 2 + 10 * 12) / 1e6, 12);
  });

  test('Groq is OpenAI-compatible under /openai/v1 and reserves the model ceiling when no limit is set', () => {
    const p = priceRequest('https://api.groq.com/openai/v1/chat/completions', { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] })!;
    expect(p).toMatchObject({ provider: 'groq', model: 'openai/gpt-oss-120b', input: 0.15, output: 0.6, maxOutputTokens: 65_536 });
    const cost = usageCost(p, { usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } } })!;
    expect(cost.usd).toBeCloseTo((600 * 0.15 + 400 * 0.075 + 100 * 0.6) / 1e6, 12);
  });

  test('newest frontier rows are priced', () => {
    const chat = (host: string, path: string, model: string) => priceRequest(`https://${host}${path}`, { model, max_tokens: 10, messages: [] })!;
    expect(chat('api.openai.com', '/v1/chat/completions', 'gpt-6.1-sol')).toMatchObject({ input: 2, output: 10 });
    expect(chat('api.openai.com', '/v1/chat/completions', 'gpt-6-astra')).toMatchObject({ input: 10, output: 50 });
    expect(chat('api.openai.com', '/v1/chat/completions', 'gpt-6-luna')).toMatchObject({ input: 0.1, output: 0.5 });
    expect(chat('api.anthropic.com', '/v1/messages', 'claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10 });
    expect(chat('api.anthropic.com', '/v1/messages', 'claude-opus-5-5')).toMatchObject({ input: 4, output: 20 });
    expect(priceRequest('https://api.voyageai.com/v1/rerank', { model: 'rerank-3', query: 'q', documents: ['a'] })).toMatchObject({ kind: 'rerank', input: 0.05 });
    expect(priceRequest('https://api.voyageai.com/v1/embeddings', { model: 'voyage-4', input: ['a'] })).toMatchObject({ kind: 'embedding', input: 0.06 });
  });
});

describe('usage decoding', () => {
  const flash = priceRequest(`${GEMINI}/gemini-3.5-flash:generateContent`, { contents: [] })!;

  test('Gemini usageMetadata: cached prompt tokens at the cache price, tool-use prompt as input, thinking as output', () => {
    const cost = usageCost(flash, { usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, toolUsePromptTokenCount: 50, candidatesTokenCount: 20, thoughtsTokenCount: 300 } })!;
    expect(cost).toMatchObject({ input_tokens: 1050, output_tokens: 320 });
    expect(cost.usd).toBeCloseTo((450 * 1.5 + 600 * 0.15 + 320 * 9) / 1e6, 12);
    expect(usageCost(flash, { candidates: [] })).toBeNull();
    expect(usageCost(flash, [{ usageMetadata: { promptTokenCount: 10 } }, { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }])!.output_tokens).toBe(5);
  });

  test('SSE: OpenAI chat final usage chunk, Groq x_groq, responses API completed event', () => {
    const sol = priceRequest('https://api.openai.com/v1/chat/completions', { model: 'gpt-6.1-sol', max_tokens: 10, messages: [] })!;
    const chat = 'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\ndata: [DONE]\n\n';
    expect(streamUsageCost(sol, chat)).toMatchObject({ input_tokens: 100, output_tokens: 20, usd: (100 * 2 + 20 * 10) / 1e6 });
    const groq = priceRequest('https://api.groq.com/openai/v1/chat/completions', { model: 'openai/gpt-oss-120b', messages: [] })!;
    const groqSse = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"x_groq":{"id":"r","usage":{"prompt_tokens":10,"completion_tokens":4}}}\n\ndata: [DONE]\n';
    expect(streamUsageCost(groq, groqSse)).toMatchObject({ input_tokens: 10, output_tokens: 4 });
    const responses = 'event: response.created\ndata: {"type":"response.created","response":{"usage":null}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":7,"input_tokens_details":{"cached_tokens":10}}}}\n\n';
    expect(streamUsageCost(sol, responses)!.usd).toBeCloseTo((40 * 2 + 10 * 0.1 + 7 * 10) / 1e6, 12);
  });

  test('SSE: Anthropic message_start plus cumulative message_delta, cache tokens included', () => {
    const sonnet = priceRequest('https://api.anthropic.com/v1/messages', { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [] })!;
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"output_tokens":1}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":40}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].join('\n\n');
    const cost = streamUsageCost(sonnet, sse)!;
    expect(cost).toMatchObject({ input_tokens: 1300, output_tokens: 40 });
    expect(cost.usd).toBeCloseTo((100 * 2 + 1000 * 0.2 + 200 * 2.5 + 40 * 10) / 1e6, 12);
  });

  test('SSE: Gemini takes the last chunk\'s usageMetadata; undecodable streams return null', () => {
    const sse = 'data: {"candidates":[],"usageMetadata":{"promptTokenCount":10}}\r\n\r\ndata: {"candidates":[],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":2}}\r\n\r\n';
    expect(streamUsageCost(flash, sse)).toMatchObject({ input_tokens: 10, output_tokens: 5 });
    expect(streamUsageCost(flash, 'data: not json\n\n')).toBeNull();
    const sol = priceRequest('https://api.openai.com/v1/chat/completions', { model: 'gpt-6.1-sol', max_tokens: 10, messages: [] })!;
    expect(streamUsageCost(sol, 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n')).toBeNull();
  });
});

describe('retry-safe refusal text', () => {
  test('breaks every substring a client retries on, however it overlaps', () => {
    for (const s of ['cap $500.00', '50429', 'generate', 'RATE', '5029', 'run-2026-10-05T12-29-50-429Z', '/tmp/x504y/ledger.sqlite']) {
      const safe = retrySafe(s);
      expect(RETRY_TRIGGER.test(safe)).toBe(false);
      expect(safe.replaceAll('\u200b', '')).toBe(s);
    }
  });
});

// ─── Stub upstream ────────────────────────────────────────────────────

describe('stub upstream', () => {
  test('schema instances are minimal and schema-valid, including Gemini upper-case types and $ref', () => {
    expect(schemaInstance({ type: 'object', properties: { answer: { type: 'string' }, correct: { type: 'boolean' }, score: { type: 'integer', minimum: 1 }, tags: { type: 'array', items: { type: 'string' } }, kind: { enum: ['a', 'b'] } } }))
      .toEqual({ answer: 'stub-answer', correct: false, score: 1, tags: [], kind: 'a' });
    expect(schemaInstance({ type: 'OBJECT', properties: { reasoning: { type: 'STRING' } } })).toEqual({ reasoning: 'stub-reasoning' });
    expect(schemaInstance({ $defs: { R: { type: 'object', properties: { x: { type: ['number', 'null'] } } } }, type: 'object', properties: { r: { $ref: '#/$defs/R' } } })).toEqual({ r: { x: 0 } });
    const v = hashVector('hello', 8);
    expect(v).toHaveLength(8);
    expect(Math.hypot(...v)).toBeCloseTo(1, 9);
    expect(hashVector('hello', 8)).toEqual(v);
  });

  test('json_object requests that carry their schema in the prompt get a filled instance of it', async () => {
    const stub = await startStubUpstream();
    try {
      const schema = { $defs: { F: { type: 'object', properties: { what: { type: 'string' }, links: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }] } } } }, type: 'object', properties: { facts: { type: 'array', items: { $ref: '#/$defs/F' } } } };
      const ask = (content: string) => post(`${stub.url}/openai/v1/chat/completions`, {}, { model: 'gpt-4o-mini', response_format: { type: 'json_object' }, messages: [{ role: 'system', content }, { role: 'user', content: 'json please' }] }).then(r => r.json() as any);
      const filled = await ask(`Extract facts.\n\nYou must respond with valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`);
      expect(JSON.parse(filled.choices[0].message.content)).toEqual({ facts: [{ what: 'stub-what', links: null }] });
      const plain = await ask('no schema here');
      expect(plain.choices[0].message.content).toBe('stub answer from gpt-4o-mini');
    } finally {
      stub.close();
    }
  });

  test('serves every provider shape with usage, counts hits and lets a test choose the content', async () => {
    const stub = await startStubUpstream();
    try {
      const chat = await (await post(`${stub.url}/openai/v1/chat/completions`, {}, { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'q' }], response_format: { type: 'json_schema', json_schema: { name: 'r', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } } } })).json() as any;
      expect(JSON.parse(chat.choices[0].message.content)).toEqual({ answer: 'stub-answer' });
      expect(chat.usage.prompt_tokens).toBeGreaterThan(0);
      const msg = await (await post(`${stub.url}/anthropic/v1/messages`, {}, { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [], tools: [{ name: 'respond', input_schema: { type: 'object', properties: { answer: { type: 'string' } } } }], tool_choice: { type: 'tool', name: 'respond' } })).json() as any;
      expect(msg.content[0]).toMatchObject({ type: 'tool_use', name: 'respond', input: { answer: 'stub-answer' } });
      expect(msg.usage).toMatchObject({ input_tokens: expect.any(Number), output_tokens: expect.any(Number) });
      const gem = await (await post(`${stub.url}/gemini/v1beta/models/gemini-3.5-flash:generateContent`, {}, { contents: [{ parts: [{ text: 'q' }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { answer: { type: 'STRING' } } } } })).json() as any;
      expect(JSON.parse(gem.candidates[0].content.parts[0].text)).toEqual({ answer: 'stub-answer' });
      expect(gem.usageMetadata.promptTokenCount).toBeGreaterThan(0);
      const emb = await (await post(`${stub.url}/openai/v1/embeddings`, {}, { model: 'text-embedding-3-large', input: ['a', 'b'], dimensions: 256 })).json() as any;
      expect(emb.data.map((d: any) => d.embedding.length)).toEqual([256, 256]);
      const b64 = await (await post(`${stub.url}/openai/v1/embeddings`, {}, { model: 'text-embedding-3-small', input: 'a', encoding_format: 'base64' })).json() as any;
      expect(Buffer.from(b64.data[0].embedding, 'base64').length).toBe(1536 * 4);
      const voy = await (await post(`${stub.url}/voyage/v1/embeddings`, {}, { model: 'voyage-4', input: ['a'], output_dimension: 512 })).json() as any;
      expect(voy.data[0].embedding).toHaveLength(512);
      expect(voy.usage.total_tokens).toBeGreaterThan(0);
      const voyDefault = await (await post(`${stub.url}/voyage/v1/embeddings`, {}, { model: 'voyage-4', input: ['a'] })).json() as any;
      expect(voyDefault.data[0].embedding).toHaveLength(1024);
      const rr = await (await post(`${stub.url}/voyage/v1/rerank`, {}, { model: 'rerank-2.5', query: 'q', documents: ['a', 'b', 'c'], top_k: 2 })).json() as any;
      expect(rr.data).toHaveLength(2);
      const ge = await (await post(`${stub.url}/gemini/v1beta/models/gemini-embedding-2:batchEmbedContents`, {}, { requests: [{ content: { parts: [{ text: 'a' }] }, outputDimensionality: 64 }] })).json() as any;
      expect(ge.embeddings[0].values).toHaveLength(64);
      stub.respond('groq.chat', () => ({ json: { answer: 'chosen' } }));
      const groq = await (await post(`${stub.url}/groq/openai/v1/chat/completions`, {}, { model: 'openai/gpt-oss-120b', messages: [] })).json() as any;
      expect(JSON.parse(groq.choices[0].message.content)).toEqual({ answer: 'chosen' });
      expect(stub.hits.total).toBe(10);
      expect(stub.hits.byPath['/openai/v1/embeddings']).toBe(2);
    } finally { stub.close(); }
  });
});

// ─── Proxy ────────────────────────────────────────────────────────────

describe('metering proxy', () => {
  test('reserves, forwards with the real key, settles from usage, logs the request and saves its body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-keys-')); dirs.push(dir);
    const ledgerPath = join(dir, 'ledger.sqlite');
    initLedger({ ledgerPath });
    const run = BudgetRun.open({ runner: 'mp-test', budgetUsd: 1, ledgerPath });
    const stub = await startStubUpstream();
    const realKeys = { OPENAI_API_KEY: 'sk-test-openai', ANTHROPIC_API_KEY: 'sk-test-anthropic', GEMINI_API_KEY: 'test-gemini' };
    const proxy = await startMeteringProxy({ run, cellId: 'cell-keys', requestLogPath: join(dir, 'log.jsonl'), bodiesDir: join(dir, 'bodies'), labels: ['harness'], upstreams: { openai: stub.upstreams.openai, anthropic: stub.upstreams.anthropic, gemini: stub.upstreams.gemini }, realKeys });
    try {
      const env = proxy.envFor('harness');
      expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']);
      const token = proxy.tokens.harness;
      expect(token).toMatch(/^mpwp-harness-[0-9a-f]{48}$/);
      const body = { model: 'gpt-6.1-sol', max_tokens: 200, messages: [{ role: 'user', content: 'hello' }] };
      const r = await post(`${env.OPENAI_BASE_URL}/chat/completions`, { authorization: `Bearer ${token}`, 'x-mpw-tag': 'answer:q1' }, body);
      expect(r.status).toBe(200);
      await post(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { 'x-api-key': token }, { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
      await post(`${env.GOOGLE_GEMINI_BASE_URL}/v1beta/models/gemini-3.5-flash:generateContent?key=${token}`, {}, { contents: [{ parts: [{ text: 'x' }] }] });
      const [o, a, g] = stub.requests;
      expect(o.headers.get('authorization')).toBe('Bearer sk-test-openai');
      expect(o.headers.get('x-mpw-tag')).toBeNull();
      expect(a.headers.get('x-api-key')).toBe('sk-test-anthropic');
      expect(g.headers.get('x-goog-api-key')).toBe('test-gemini');
      for (const req of stub.requests) for (const [, v] of req.headers) expect(v).not.toContain(token);
      const log = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as RequestLogLine);
      expect(log[0]).toMatchObject({ cell_id: 'cell-keys', label: 'harness', tag: 'answer:q1', provider: 'openai', model: 'gpt-6.1-sol', kind: 'chat', path: '/v1/chat/completions', status: 200, refused: false, settlement: 'reconciled' });
      expect(log[0].reserved_usd).toBeGreaterThan(log[0].actual_usd!);
      expect(log[2]).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash', path: '/v1beta/models/gemini-3.5-flash:generateContent', settlement: 'reconciled' });
      expect(JSON.parse(readFileSync(join(dir, 'bodies', `${log[0].body_sha256}.json`), 'utf8'))).toEqual(body);
      const committed = ledgerStatus({ ledgerPath, runId: run.runId }).run!.committed_usd;
      expect(committed).toBeCloseTo(log.reduce((s, l) => s + (l.actual_usd ?? 0), 0), 12);
      expect(proxy.stats().byProvider.gemini.requests).toBe(1);
      expect(proxy.stats().byLabel.harness).toMatchObject({ requests: 3, refused: 0 });
    } finally { await proxy.close(); stub.close(); }
  });

  test('an unknown or missing token answers 401 and nothing is sent', async () => {
    const c = await cell({ labels: ['harness'] });
    const url = `${c.proxy.baseUrls.openai}/chat/completions`;
    const body = { model: 'gpt-6.1-sol', max_tokens: 5, messages: [] };
    expect((await post(url, { authorization: 'Bearer mpwp-harness-deadbeef' }, body)).status).toBe(401);
    expect((await post(url, {}, body)).status).toBe(401);
    expect((await post(`${c.proxy.baseUrls.gemini}/v1beta/models/gemini-3.5-flash:generateContent?key=sk-real-looking`, {}, { contents: [] })).status).toBe(401);
    expect(c.stub.hits.total).toBe(0);
    expect(c.committed().run).toBe(0);
    expect(c.log().every(l => l.status === 401 && l.label === null)).toBe(true);
  });

  test('a refused reservation answers 402 naming the cell, spend, cap and next step, with no retry trigger in the text', async () => {
    const c = await cell({ labels: ['harness'], drained: true, budgetUsd: 500, programCapUsd: 504, cellId: 'cell-a429-500', dirPrefix: 'mp-500-rate-' });
    const before = c.committed();
    const r = await post(`${c.proxy.baseUrls.gemini}/v1beta/models/gemini-3.5-flash:generateContent`, { 'x-goog-api-key': c.proxy.tokens.harness }, { contents: [{ parts: [{ text: 'q' }] }] });
    expect(r.status).toBe(402);
    const text = await r.text();
    expect(RETRY_TRIGGER.test(text)).toBe(false);
    const err = (JSON.parse(text) as { error: { type: string; message: string } }).error;
    expect(err.type).toBe(REFUSAL_TYPE);
    const message = err.message.replaceAll('\u200b', '');
    expect(message).toContain('cell cell-a429-500');
    expect(message).toContain('$500.00 of budget run');
    expect(message).toContain('of the $504.00 program cap');
    expect(message).toContain(`bun eval/runner/budget-ledger.ts status --budget-ledger ${c.ledgerPath}`);
    expect(c.proxy.lastRefusal).toBe(message);
    expect(c.proxy.exhausted).toBe(true);
    expect(c.stub.hits.total).toBe(0);
    expect(c.committed()).toEqual(before);
    expect(c.log()[0]).toMatchObject({ refused: true, status: 402, reserved_usd: 0, provider: 'gemini', model: 'gemini-3.5-flash' });
  });

  test('an unpriced model is refused with an instruction to register its price', async () => {
    const c = await cell({ labels: ['harness'] });
    const r = await post(`${c.proxy.baseUrls.openai}/chat/completions`, { authorization: `Bearer ${c.proxy.tokens.harness}` }, { model: 'gpt-99-nova', max_tokens: 5, messages: [] });
    expect(r.status).toBe(402);
    const message = ((await r.json()) as { error: { message: string } }).error.message.replaceAll('\u200b', '');
    expect(message).toContain('no chat price for openai:gpt-99-nova');
    expect(message).toContain('HARNESS_CHAT_PRICES in eval/runner/budget-ledger.ts');
    expect(c.stub.hits.total).toBe(0);
    expect(c.proxy.exhausted).toBe(true);
  });

  test('streams pass through unbuffered and settle from SSE usage; streams without usage charge the reservation', async () => {
    const c = await cell({ labels: ['harness'] });
    const auth = { 'x-api-key': c.proxy.tokens.harness };
    const r = await post(`${c.proxy.baseUrls.anthropic}/v1/messages`, auth, { model: 'claude-sonnet-5-5', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.headers.get('content-type')).toContain('event-stream');
    const text = await r.text();
    expect(text).toContain('message_delta');
    const openai = await post(`${c.proxy.baseUrls.openai}/chat/completions`, { authorization: `Bearer ${c.proxy.tokens.harness}` }, { model: 'gpt-6.1-sol', max_tokens: 50, stream: true, messages: [] });
    await openai.text();
    await waitFor(() => c.log().length === 2, 5000);
    const [anth, oai] = c.log();
    expect(anth).toMatchObject({ stream: true, settlement: 'reconciled', provider: 'anthropic' });
    expect(anth.output_tokens).toBeGreaterThan(0);
    expect(oai).toMatchObject({ stream: true, settlement: 'charged-reservation' });
    expect(oai.actual_usd).toBe(oai.reserved_usd);
    expect(c.committed().run).toBeCloseTo(anth.actual_usd! + oai.reserved_usd, 12);
  });

  test('the client receives each SSE chunk as the upstream sends it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const enc = new TextEncoder();
    const slow = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(new ReadableStream({
      async start(ctl) {
        ctl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
        await gate;
        ctl.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n'));
        ctl.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } }) });
    const dir = mkdtempSync(join(tmpdir(), 'mp-sse-')); dirs.push(dir);
    const ledgerPath = join(dir, 'ledger.sqlite');
    initLedger({ ledgerPath });
    const run = BudgetRun.open({ runner: 'mp-test', budgetUsd: 1, ledgerPath });
    const proxy = await startMeteringProxy({ run, cellId: 'c', requestLogPath: join(dir, 'l.jsonl'), bodiesDir: join(dir, 'b'), labels: ['harness'], realKeys: {}, upstreams: { openai: `http://127.0.0.1:${slow.port}` } });
    try {
      const r = await post(`${proxy.baseUrls.openai}/chat/completions`, { authorization: `Bearer ${proxy.tokens.harness}` }, { model: 'gpt-6.1-sol', max_tokens: 10, stream: true, messages: [] });
      const reader = r.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('first');
      release();
      let rest = '';
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
      expect(rest).toContain('[DONE]');
      await proxy.close();
      const line = JSON.parse(readFileSync(join(dir, 'l.jsonl'), 'utf8')) as RequestLogLine;
      expect(line).toMatchObject({ stream: true, settlement: 'reconciled', input_tokens: 5, output_tokens: 2 });
    } finally { release(); await proxy.close(); slow.stop(true); }
  });

  test('a 4xx without usage settles at $0; a 5xx is charged at its reservation', async () => {
    const c = await cell({ labels: ['harness'] });
    const auth = { authorization: `Bearer ${c.proxy.tokens.harness}` };
    const body = { model: 'gpt-6.1-sol', max_tokens: 50, messages: [] };
    c.stub.respond('openai.chat', () => ({ status: 400, body: { error: { message: 'bad request' } } }));
    expect((await post(`${c.proxy.baseUrls.openai}/chat/completions`, auth, body)).status).toBe(400);
    c.stub.respond('openai.chat', () => ({ status: 500, body: { error: { message: 'server' } } }));
    expect((await post(`${c.proxy.baseUrls.openai}/chat/completions`, auth, body)).status).toBe(500);
    const [rejected, failed] = c.log();
    expect(rejected).toMatchObject({ settlement: 'rejected-unbilled', actual_usd: 0 });
    expect(failed).toMatchObject({ settlement: 'charged-reservation' });
    expect(c.committed().run).toBeCloseTo(failed.reserved_usd, 12);
  });

  test('envFor offers only providers with a launcher key or an upstream override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-env-')); dirs.push(dir);
    const ledgerPath = join(dir, 'ledger.sqlite');
    initLedger({ ledgerPath });
    const run = BudgetRun.open({ runner: 'mp-test', budgetUsd: 1, ledgerPath });
    const proxy = await startMeteringProxy({ run, cellId: 'c', requestLogPath: join(dir, 'l.jsonl'), bodiesDir: join(dir, 'b'), labels: ['harness', 'gbrain'], realKeys: { GROQ_API_KEY: 'gsk-test' } });
    try {
      expect(proxy.envFor('harness')).toEqual({ GROQ_BASE_URL: `${proxy.url}/groq`, GROQ_API_KEY: proxy.tokens.harness });
      expect(proxy.envFor('gbrain').GROQ_API_KEY).toBe(proxy.tokens.gbrain);
      expect(proxy.tokens.harness).not.toBe(proxy.tokens.gbrain);
      expect(() => proxy.envFor('comparator')).toThrow('no token for label comparator');
    } finally { await proxy.close(); }
  });

  test('a child gets only proxy tokens, so a request that skips the proxy carries no real key', async () => {
    const c = await cell({ labels: ['harness'] });
    const env = { PATH: process.env.PATH!, HOME: c.dir, ...c.proxy.envFor('harness') };
    const script = `const r = await fetch(${JSON.stringify(`${c.stub.upstreams.openai}/v1/chat/completions`)}, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-sol', messages: [] }) }); console.log(JSON.stringify(process.env));`;
    const child = Bun.spawn(['bun', '-e', script], { env, stdout: 'pipe', stderr: 'pipe' });
    await child.exited;
    const childEnv = JSON.parse(await new Response(child.stdout).text()) as Record<string, string>;
    const realValues = REAL_KEY_NAMES.map(k => process.env[k]).filter((v): v is string => Boolean(v));
    for (const v of Object.values(childEnv)) for (const real of realValues) expect(v).not.toContain(real);
    for (const k of strippedKeysIn(childEnv).filter(k => k.endsWith('_KEY'))) expect(childEnv[k]).toBe(c.proxy.tokens.harness);
    expect(c.stub.requests[0].headers.get('authorization')).toBe(`Bearer ${c.proxy.tokens.harness}`);
  });

  test('two proxy processes reserving near the cap of one shared run never exceed it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-concurrent-')); dirs.push(dir);
    const ledgerPath = join(dir, 'ledger.sqlite');
    initLedger({ ledgerPath });
    const budget = 1;
    const run = BudgetRun.open({ runner: 'mp-concurrent', budgetUsd: budget, ledgerPath });
    const stub = await startStubUpstream();
    let inflight = 0;
    let peak = 0;
    stub.respond('openai.chat', async () => { inflight++; peak = Math.max(peak, inflight); await Bun.sleep(400); inflight--; return undefined; });
    const cleanEnv = { PATH: process.env.PATH!, HOME: dir };
    const procs = [0, 1].map(i => Bun.spawn(['bun', join(REPO, 'eval/runner/harness-metering-proxy.ts'), '--budget-ledger', ledgerPath, '--budget-run-id', run.runId, '--cell-id', `cell-${i}`,
      '--labels', 'harness', '--ready-file', join(dir, `ready-${i}.json`), '--upstream', `openai=${stub.upstreams.openai}`], { env: cleanEnv, stdout: 'pipe', stderr: 'pipe' }));
    try {
      expect(await waitFor(() => existsSync(join(dir, 'ready-0.json')) && existsSync(join(dir, 'ready-1.json')), 20_000)).toBe(true);
      const ready = [0, 1].map(i => JSON.parse(readFileSync(join(dir, `ready-${i}.json`), 'utf8')) as { url: string; env: Record<string, Record<string, string>> });
      expect(Object.keys(ready[0].env.harness)).toEqual(['OPENAI_BASE_URL', 'OPENAI_API_KEY']);
      const body = { model: 'gpt-6.1-sol', max_tokens: 15_000, messages: [{ role: 'user', content: 'q' }] };
      const reservation = reservationUsd(priceRequest('https://api.openai.com/v1/chat/completions', body)!);
      const statuses = await Promise.all(Array.from({ length: 24 }, (_, k) => {
        const e = ready[k % 2].env.harness;
        return post(`${e.OPENAI_BASE_URL}/chat/completions`, { authorization: `Bearer ${e.OPENAI_API_KEY}` }, body).then(r => r.status);
      }));
      const ok = statuses.filter(s => s === 200).length;
      const refused = statuses.filter(s => s === 402).length;
      expect(ok + refused).toBe(24);
      expect(refused).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(Math.floor(budget / reservation));
      expect(stub.hits.total).toBe(ok);
      const status = ledgerStatus({ ledgerPath, runId: run.runId });
      expect(status.run!.committed_usd).toBeLessThanOrEqual(budget);
    } finally {
      for (const p of procs) p.kill('SIGTERM');
      await Promise.all(procs.map(p => p.exited));
      stub.close();
    }
  }, 60_000);
});

// ─── Zero balance blocks dispatch from each process ──────────────────

const PAID_CALLS = (env: Record<string, string>) => [
  () => post(`${env.OPENAI_BASE_URL}/chat/completions`, { authorization: `Bearer ${env.OPENAI_API_KEY}` }, { model: 'gpt-6.1-sol', max_tokens: 20, messages: [{ role: 'user', content: 'q' }] }),
  () => post(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { 'x-api-key': env.ANTHROPIC_API_KEY }, { model: 'claude-opus-5-5', max_tokens: 20, messages: [{ role: 'user', content: 'q' }] }),
  () => post(`${env.GOOGLE_GEMINI_BASE_URL}/v1beta/models/gemini-3.5-flash:generateContent`, { 'x-goog-api-key': env.GEMINI_API_KEY }, { contents: [{ parts: [{ text: 'q' }] }] }),
  () => post(`${env.GROQ_BASE_URL}/openai/v1/chat/completions`, { authorization: `Bearer ${env.GROQ_API_KEY}` }, { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'q' }] }),
  () => post(`${env.OPENAI_BASE_URL.replace(/\/openai\/v1$/, '/voyage/v1')}/embeddings`, { authorization: `Bearer ${env.VOYAGE_API_KEY}` }, { model: 'voyage-4', input: ['q'] }),
];

describe('zero balance blocks dispatch', () => {
  test('(a) the launcher process', async () => {
    const statuses: number[][] = [];
    const { zero, positive } = await assertZeroBalanceBlocks<Record<string, string>>({
      label: 'harness',
      spawn: async env => env,
      trigger: async env => { statuses.push(await Promise.all(PAID_CALLS(env).map(call => call().then(r => r.status)))); },
    });
    expect(statuses[0]).toEqual([402, 402, 402, 402, 402]);
    expect(statuses[1]).toEqual([200, 200, 200, 200, 200]);
    expect(zero.refused).toBe(5);
    expect(positive.settled).toBe(5);
  }, 30_000);

  let install: HarnessInstall | null = null;
  let harnessSkip: string | null = null;
  try { install = ensureHarness({ checkOnly: true, log: () => {} }); } catch (error) { harnessSkip = (error as Error).message; }
  const requireHarness = process.env.MPW_REQUIRE_HARNESS === '1';
  if (!install && !requireHarness) console.warn(`[harness-metering-proxy.test] skipping the harness Python zero-balance test: ${harnessSkip}. Run \`bun run harness:setup\`, or set MPW_REQUIRE_HARNESS=1 to make this a failure.`);

  test.skipIf(!install && !requireHarness)('(b) a harness Python process using the pinned harness LLM clients and the Anthropic client', async () => {
    if (!install) throw new Error(`MPW_REQUIRE_HARNESS=1 but the harness venv is missing: ${harnessSkip}`);
    const outcomes: Array<Record<string, { ok: boolean; error?: string; result?: unknown; seconds: number }>> = [];
    const { zero, positive } = await assertZeroBalanceBlocks<Record<string, string>>({
      label: 'harness',
      timeoutMs: 60_000,
      spawn: async env => harnessProcessEnv(install!, env),
      trigger: async env => {
        const proc = Bun.spawn([install!.python, join(REPO, 'eval/harness-provider/tests/llm_probe.py'), 'gemini,openai,groq,anthropic'], { env, cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (proc.exitCode !== 0) throw new Error(`llm_probe.py exited ${proc.exitCode}: ${err.slice(-2000)}`);
        outcomes.push(JSON.parse(out.trim().split('\n').at(-1)!));
      },
    });
    const [blocked, allowed] = outcomes;
    for (const name of ['gemini', 'openai', 'groq', 'anthropic']) {
      expect(blocked[name].ok).toBe(false);
      expect(blocked[name].error).toContain(REFUSAL_TYPE);
      expect(blocked[name].seconds).toBeLessThan(4);
      expect(allowed[name]).toMatchObject({ ok: true, result: { answer: 'stub-answer' } });
    }
    expect(zero.refused).toBe(4);
    expect(new Set(zero.log.map(l => l.provider))).toEqual(new Set(['gemini', 'openai', 'groq', 'anthropic']));
    expect(positive.settled).toBe(4);
  }, 180_000);

  // A gbrain child needs Bun >= 1.4 and a PGLite init; the CI unit shards leave it to the harness job, which runs
  // this file with MPW_REQUIRE_HARNESS=1, so a slow init can never hold a 15-minute shard.
  test.skipIf(process.env.CI === 'true' && !requireHarness)('(c) a gbrain stdio MCP child embedding a page it writes', async () => {
    const results: string[] = [];
    await assertZeroBalanceBlocks<{ proc: ReturnType<typeof Bun.spawn>; rpc: (method: string, params: unknown) => Promise<any> }>({
      label: 'gbrain',
      timeoutMs: 60_000,
      spawn: async (proxyEnv, c) => {
        const home = join(c.dir, 'gbrain-home');
        mkdirSync(join(c.dir, 'gbrain-user'), { recursive: true });
        mkdirSync(home, { recursive: true });
        const openai = Object.fromEntries(Object.entries(proxyEnv).filter(([k]) => k.startsWith('OPENAI_')));
        const env: Record<string, string> = {
          PATH: process.env.PATH!, HOME: join(c.dir, 'gbrain-user'), GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_BACKUP_CHECK: 'off',
          GBRAIN_MODEL_DISCOVERY: 'off', TZ: 'UTC', NO_COLOR: '1', ...openai,
        };
        expect(strippedKeysIn(env)).toEqual(['OPENAI_API_KEY', 'OPENAI_BASE_URL']);
        const cli = join(REPO, 'node_modules/gbrain/src/cli.ts');
        const init = Bun.spawn(['bun', cli, 'init', '--pglite', '--path', join(home, 'brain.pglite'), '--embedding-model', 'openai:text-embedding-3-large', '--non-interactive', '--skip-embed-check'],
          { env, cwd: home, stdout: 'pipe', stderr: 'pipe', timeout: 90_000, killSignal: 'SIGKILL' });
        const [, initErr] = await Promise.all([new Response(init.stdout).text(), new Response(init.stderr).text(), init.exited]);
        if (init.exitCode !== 0) throw new Error(`gbrain init failed: ${initErr.slice(-2000)}`);
        if (c.stub.hits.total !== 0) throw new Error('gbrain init reached the stub');
        const proc = Bun.spawn(['bun', cli, 'serve'], { env, cwd: home, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
        const waiters = new Map<number, (m: any) => void>();
        void (async () => {
          let buf = '';
          const decoder = new TextDecoder();
          const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
          for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            buf += decoder.decode(chunk.value);
            for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
              const line = buf.slice(0, i); buf = buf.slice(i + 1);
              try { const m = JSON.parse(line); if (m.id != null) waiters.get(m.id)?.(m); } catch {}
            }
          }
        })();
        let id = 0;
        const stdin = proc.stdin as import('bun').FileSink;
        const rpc = (method: string, params: unknown) => new Promise<any>((res, rej) => {
          const n = ++id;
          const timer = setTimeout(() => rej(new Error(`gbrain MCP ${method} timed out`)), 60_000);
          waiters.set(n, m => { clearTimeout(timer); res(m); });
          stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
          stdin.flush();
        });
        await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'metering-proxy-test', version: '1' } });
        stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        stdin.flush();
        return { proc, rpc };
      },
      trigger: async child => {
        const r = await child.rpc('tools/call', { name: 'put_page', arguments: { slug: 'notes/alpha', content: '---\ntitle: Alpha\n---\nAlpha beta gamma delta, the quick brown fox jumps over the lazy dog.' } });
        results.push(JSON.stringify(r.result ?? r.error));
      },
      stop: async child => { child.proc.kill('SIGTERM'); await child.proc.exited; },
    });
    expect(results).toHaveLength(2);
    for (const r of results) expect(r).toContain('created_or_updated');
  }, 180_000);
});
