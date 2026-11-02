/**
 * The OpenAI-compatible provider module (eval/runner/providers/openai-compatible.ts, plan GST-605 Phase 1) and the
 * receipt fields it feeds (eval/runner/usage-receipt.ts). Keyless: responses come from a mocked fetch or from the
 * fake provider (eval/systems/_shim/fake_provider.py) on loopback.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { BudgetExceededError, chatPrice, priceRequest } from '../../eval/runner/budget-ledger.ts';
import { REFUSAL_TYPE } from '../../eval/runner/harness-metering-proxy.ts';
import {
  CANARY_MAX_OUTPUT_TOKENS, COMPAT_PROVIDERS, CompatHttpError, PRIMARY_MODELS, ParticleCreditExhausted, RETRY_AFTER_CAP_MS,
  assertMetered, classifyCompatError, compatError, compatMayHaveBilled, compatRequest, compatSend, modelsNotRun, parseCompatResponse, type CanarySampling,
} from '../../eval/runner/providers/openai-compatible.ts';
import { normalizeUsage, receipt, responseMeta, usageSourceOf } from '../../eval/runner/usage-receipt.ts';

const ROOT = resolve(import.meta.dir, '../..');
const KEYED = { PARTICLE_API_KEY: 'test-key' };
/** A metering proxy's particle slot: compatSend refuses an unpriced Particle host, never a proxy slot. */
const SLOT = { ...KEYED, PARTICLE_BASE_URL: 'http://127.0.0.1:8787/slot-1/particle/v1' };
const ASK = [{ role: 'user' as const, content: 'When did I move to Lisbon?' }];

/** A particle-1 response in the shape api.particle.ai returned to the 2026-10-31 probes (usage numbers from the live memory-qa smoke). */
const PARTICLE_OK = {
  id: 'chatcmpl-1', object: 'chat.completion', model: 'particle-ai/particle-1', service_tier: 'default', system_fingerprint: 'fp_1', metadata: { weight_version: 'default' },
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'In May 2023.', reasoning_content: 'The user said they moved in May.' } }],
  usage: { prompt_tokens: 330, completion_tokens: 86, total_tokens: 416, prompt_tokens_details: { cached_tokens: 256 }, completion_tokens_details: { reasoning_tokens: 49 } },
};

function mockFetch(replies: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = replies.shift();
    if (!r) throw new Error('unexpected request');
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  }) as typeof fetch;
  return { impl, calls };
}

describe('the particle request (compatRequest)', () => {
  test('URL, key header, explicit effort, max_completion_tokens at the 16,000 floor, and no temperature or seed', () => {
    const req = compatRequest('particle:particle-1', ASK, { maxOutputTokens: 2048 }, KEYED);
    expect(req.url).toBe('https://api.particle.ai/v1/chat/completions');
    expect(req.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer test-key' });
    expect(req.body).toEqual({ model: 'particle-1', messages: ASK, reasoning_effort: 'high', max_completion_tokens: 16_000 });
    expect(req.sent).toEqual({ effort_sent: 'high', effort_effective: 'high', output_limit_field: 'max_completion_tokens', output_limit: 16_000, temperature_sent: null, seed_sent: null });
    expect(compatRequest('particle:particle-1', ASK, { maxOutputTokens: 40_000 }, KEYED).body.max_completion_tokens).toBe(40_000);
  });

  test('every listed effort is sent as asked and recorded with the level Particle runs it at (Q1\'s medium runs as high)', () => {
    const effective = (effort: string) => compatRequest('particle:particle-1', ASK, { effort }, KEYED).sent;
    expect(effective('medium')).toMatchObject({ effort_sent: 'medium', effort_effective: 'high' });
    expect(effective('minimal')).toMatchObject({ effort_sent: 'minimal', effort_effective: 'low' });
    expect(effective('ultra')).toMatchObject({ effort_sent: 'ultra', effort_effective: 'max' });
    expect(effective('none')).toMatchObject({ effort_sent: 'none', effort_effective: 'none' });
    expect(compatRequest('particle:particle-1', ASK, { effort: 'none' }, KEYED).body.reasoning_effort).toBe('none');
  });

  test('the base URL and key are read when the request is built, so a proxy slot set after import still applies', () => {
    const before = { url: process.env.PARTICLE_BASE_URL, key: process.env.PARTICLE_API_KEY };
    try {
      process.env.PARTICLE_API_KEY = 'dummy-slot-key';
      process.env.PARTICLE_BASE_URL = 'http://127.0.0.1:9100/slot-3/particle/v1/';
      const req = compatRequest('particle:particle-1', ASK);
      expect(req.url).toBe('http://127.0.0.1:9100/slot-3/particle/v1/chat/completions');
      expect(req.headers.authorization).toBe('Bearer dummy-slot-key');
      process.env.PARTICLE_BASE_URL = 'https://us.api.particle.ai/v1';
      expect(compatRequest('particle:particle-1', ASK).url).toBe('https://us.api.particle.ai/v1/chat/completions');
      expect(compatRequest('particle:particle-1', ASK, {}, { ...KEYED, PARTICLE_BASE_URL: 'http://localhost:8787/particle/v1' }).url).toBe('http://localhost:8787/particle/v1/chat/completions');
    } finally {
      for (const [k, v] of [['PARTICLE_BASE_URL', before.url], ['PARTICLE_API_KEY', before.key]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test('tools, tool_choice and prompt_cache_key pass through; extra sampling fields a caller slips in are never sent', () => {
    const tools = [{ type: 'function' as const, function: { name: 'search', parameters: { type: 'object' } } }];
    expect(compatRequest('particle:particle-1', ASK, { tools, promptCacheKey: 'conv-7' }, KEYED).body).toMatchObject({ tools, tool_choice: 'auto', prompt_cache_key: 'conv-7' });
    const sneaky = { temperature: 0, seed: 1, logprobs: true, top_p: 0.1 } as unknown as Parameters<typeof compatRequest>[2];
    const body = compatRequest('particle:particle-1', ASK, sneaky, KEYED).body;
    for (const k of ['temperature', 'seed', 'logprobs', 'top_logprobs', 'top_p']) expect(body).not.toHaveProperty(k);
  });

  test('refuses a missing key, an unknown model or provider, an unlisted effort and an output limit above the ceiling', () => {
    expect(() => compatRequest('particle:particle-1', ASK, {}, {})).toThrow('PARTICLE_API_KEY is not set');
    expect(() => compatRequest('particle:particle-2', ASK, {}, KEYED)).toThrow('not a Particle model in COMPAT_PROVIDERS');
    expect(() => compatRequest('particle-1', ASK, {}, KEYED)).toThrow('no OpenAI-compatible provider ""');
    expect(() => compatRequest('openai:gpt-6.1-sol', ASK, {}, KEYED)).toThrow('no OpenAI-compatible provider "openai"');
    expect(() => compatRequest('particle:particle-1', ASK, { effort: 'turbo' }, KEYED)).toThrow('reasoning effort "turbo" is not one Particle lists');
    expect(() => compatRequest('toString:x', ASK, {}, KEYED)).toThrow('no OpenAI-compatible provider "toString"');
    expect(() => compatRequest('particle:toString', ASK, {}, KEYED)).toThrow('not a Particle model in COMPAT_PROVIDERS');
    expect(() => compatRequest('particle:particle-1', ASK, { effort: 'toString' }, KEYED)).toThrow('reasoning effort "toString" is not one Particle lists');
    expect(() => compatRequest('particle:particle-1', ASK, { maxOutputTokens: 131_073 }, KEYED)).toThrow('outside 1 to 131072');
  });
});

describe('canary sampling mode', () => {
  const CANARY: CanarySampling = { mode: 'canary', temperature: 0, seed: 7, top_logprobs: 5 };

  test('only the canary mode sends temperature, seed and log probabilities, at effort none and at most 64 output tokens', () => {
    const req = compatRequest('particle:particle-1', ASK, { effort: 'none', sampling: CANARY }, KEYED);
    expect(req.body).toMatchObject({ reasoning_effort: 'none', max_completion_tokens: CANARY_MAX_OUTPUT_TOKENS, temperature: 0, seed: 7, logprobs: true, top_logprobs: 5 });
    expect(req.sent).toMatchObject({ temperature_sent: 0, seed_sent: 7, output_limit: 64 });
    // A counted reader's settings cannot carry it: any reasoning effort, or room for reasoning, is refused.
    expect(() => compatRequest('particle:particle-1', ASK, { sampling: CANARY }, KEYED)).toThrow('canary sampling runs only at effort none');
    expect(() => compatRequest('particle:particle-1', ASK, { effort: 'none', maxOutputTokens: 16_000, sampling: CANARY }, KEYED)).toThrow('canary sampling runs only at effort none');
    expect(() => compatRequest('particle:particle-1', ASK, { sampling: { ...CANARY, mode: 'counted' } as unknown as CanarySampling }, KEYED)).toThrow('unknown sampling mode');
  });

  test('no counted caller can reach it: outside the module that defines it, only scripts/particle-canary.ts sets the mode, and nothing imports that script', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== 'reports') walk(p); }
        else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) files.push(relative(ROOT, p));
      }
    };
    for (const dir of ['eval', 'scripts']) walk(join(ROOT, dir));
    expect(files.length).toBeGreaterThan(100);
    const setsMode = files.filter(f => f !== 'eval/runner/providers/openai-compatible.ts' && /mode:\s*['"]canary['"]/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(setsMode).toEqual(['scripts/particle-canary.ts']);
    const importsCanary = files.filter(f => /from\s+['"][^'"]*particle-canary(\.ts)?['"]/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(importsCanary).toEqual([]);
  });
});

describe('errors and the credit stop', () => {
  test('a particle 402 without a proxy marker is credit exhaustion, whatever its body, and keeps BudgetExceededError\'s contract', () => {
    for (const body of ['{"error":{"message":"Insufficient credits","type":"insufficient_credits"}}', 'payment required', '']) {
      const info = classifyCompatError('particle', 402, body);
      expect(info).toMatchObject({ kind: 'credit_exhausted', retryable: false, status: 402 });
      const e = compatError(info);
      expect(e).toBeInstanceOf(ParticleCreditExhausted);
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect(e.name).toBe('BudgetExceededError');
      expect(e.message.startsWith('budget: Particle credit exhausted')).toBe(true);
      expect((e as ParticleCreditExhausted).status).toBe(402);
      expect((e as ParticleCreditExhausted).body).toBe(body);
      // The stop checks runners already have: memory-qa's message pattern (run.ts) and Cat 40's name check (cat40/loop.ts).
      expect(/budget|BudgetExceeded/i.test(e.message)).toBe(true);
    }
  });

  test('a 402 carrying either metering proxy\'s marker stays a budget stop, never credit exhaustion', () => {
    const lease = JSON.stringify({ error: { kind: 'budget', type: 'budget', message: 'metering proxy: refused before forwarding: lease exhausted' } });
    const harness = JSON.stringify({ type: 'error', error: { type: REFUSAL_TYPE, code: 402, status: REFUSAL_TYPE.toUpperCase(), message: 'run budget exhausted' } });
    for (const body of [lease, harness]) {
      const info = classifyCompatError('particle', 402, body);
      expect(info.kind).toBe('proxy_budget');
      const e = compatError(info);
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect(e).not.toBeInstanceOf(ParticleCreditExhausted);
      expect(e.name).toBe('BudgetExceededError');
      expect(e.message.startsWith('budget: the metering proxy refused')).toBe(true);
      expect((e as unknown as { status: number }).status).toBe(402);
    }
  });

  test('the markers are the ones the proxies send', () => {
    expect(REFUSAL_TYPE).toBe('mpw_budget_refused');
    expect(readFileSync(join(ROOT, 'eval/runner/metering-proxy.ts'), 'utf8')).toContain("message: `metering proxy: ${message}`");
  });

  test('Retry-After is read in seconds or as a date and capped at 120 seconds; context overflow, 5xx and other 4xx are told apart', () => {
    expect(classifyCompatError('particle', 429, '', { 'Retry-After': '7' })).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterMs: 7000 });
    expect(classifyCompatError('particle', 429, '', new Headers({ 'retry-after': '600' })).retryAfterMs).toBe(RETRY_AFTER_CAP_MS);
    const soon = classifyCompatError('particle', 429, '', { 'retry-after': new Date(Date.now() + 30_000).toUTCString() }).retryAfterMs!;
    expect(soon).toBeGreaterThan(25_000);
    expect(soon).toBeLessThanOrEqual(30_000);
    expect(classifyCompatError('particle', 429, '').retryAfterMs).toBeNull();
    expect(classifyCompatError('particle', 400, '{"error":{"message":"This model\'s maximum context length is 1048576 tokens"}}')).toMatchObject({ kind: 'context_overflow', retryable: false });
    expect(classifyCompatError('particle', 503, 'busy')).toMatchObject({ kind: 'server', retryable: true });
    const bad = compatError(classifyCompatError('particle', 400, 'bad request'));
    expect(bad).toBeInstanceOf(CompatHttpError);
    expect(bad).toMatchObject({ status: 400, kind: 'client', retryable: false });
    expect(bad.message).toBe('particle 400: bad request');
  });
});

describe('compatSend and parseCompatResponse', () => {
  test('one request per call, never retried; a 429 throws with its capped wait for the caller\'s own loop', async () => {
    const m = mockFetch([{ status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '3' } }]);
    const req = compatRequest('particle:particle-1', ASK, {}, SLOT);
    const e = await compatSend(req, { fetchImpl: m.impl }).catch(x => x);
    expect(e).toBeInstanceOf(CompatHttpError);
    expect(e).toMatchObject({ status: 429, retryable: true, retryAfterMs: 3000 });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url).toBe('http://127.0.0.1:8787/slot-1/particle/v1/chat/completions');
    expect(JSON.parse(String(m.calls[0]!.init.body))).toEqual(req.body);
  });

  test('a request straight to a Particle host the ledger cannot price is refused before it is sent', async () => {
    for (const base of ['https://api.particle.ai./v1', 'https://eu.api.particle.ai/v1']) {
      const m = mockFetch([]);
      const e = await compatSend(compatRequest('particle:particle-1', ASK, {}, { ...KEYED, PARTICLE_BASE_URL: base }), { fetchImpl: m.impl }).catch(x => x);
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect(e.message).toStartWith(`budget: the ledger cannot price ${new URL(base).hostname.replace(/\.$/, '')}`);
      expect(m.calls).toHaveLength(0);
    }
  });

  test('an unpriced request to any host but loopback is refused before it is sent; loopback hosts go through', async () => {
    for (const base of ['http://203.0.113.7:8787/particle/v1', 'https://particle-proxy.example.com/v1', 'http://localhost.:8787/v1']) {
      const m = mockFetch([]);
      const e = await compatSend(compatRequest('particle:particle-1', ASK, {}, { ...KEYED, PARTICLE_BASE_URL: base }), { fetchImpl: m.impl }).catch(x => x);
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect(e.message).toStartWith(`budget: the ledger cannot price ${new URL(base).hostname.replace(/\.$/, '')}, so this Particle request`);
      expect(m.calls).toHaveLength(0);
    }
    for (const base of ['http://localhost:9/v1', 'http://[::1]:9/v1', 'http://127.0.0.2:9/v1']) {
      const m = mockFetch([{ body: PARTICLE_OK }]);
      expect((await compatSend(compatRequest('particle:particle-1', ASK, {}, { ...KEYED, PARTICLE_BASE_URL: base }), { fetchImpl: m.impl })).text).toBe('In May 2023.');
      expect(m.calls).toHaveLength(1);
    }
    const stray = { ...compatRequest('particle:particle-1', ASK, {}, SLOT), provider: 'unlisted', url: 'https://llm.example.com/v1/chat/completions' };
    expect(() => assertMetered(stray)).toThrow('so this unlisted request would spend unmetered');
  });

  // Value: protects=the Particle key never leaves in cleartext (issue #277); fails_when=an http:// base URL on a Particle API host the ledger prices passes the host check and the bearer key is sent; why_new=assertMetered read only the hostname; seam=none; no_claim=TLS certificate checks
  test('an http:// base URL on a Particle API host is refused before it is sent, so the key never leaves in cleartext; loopback stays plain http (#277)', async () => {
    for (const base of ['http://api.particle.ai/v1', 'http://us.api.particle.ai/v1', 'HTTP://API.PARTICLE.AI/v1']) {
      const m = mockFetch([]);
      const req = compatRequest('particle:particle-1', ASK, {}, { ...KEYED, PARTICLE_BASE_URL: base });
      const e = await compatSend(req, { fetchImpl: m.impl }).catch(x => x);
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect(e.message).toBe(`budget: http://${new URL(base).hostname} would carry the Particle key in cleartext; a host that is not loopback is reached only over https`);
      expect(m.calls).toHaveLength(0);
      expect(() => assertMetered(req)).toThrow('in cleartext');
    }
    const m = mockFetch([{ body: PARTICLE_OK }]);
    expect((await compatSend(compatRequest('particle:particle-1', ASK, {}, SLOT), { fetchImpl: m.impl })).text).toBe('In May 2023.');
    expect(m.calls.map(c => c.url)).toEqual(['http://127.0.0.1:8787/slot-1/particle/v1/chat/completions']);
  });

  test('a 2xx answer without choices[0].message keeps the usage it reported, for the attempt\'s receipt', async () => {
    const usage = { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 };
    const e = await compatSend(compatRequest('particle:particle-1', ASK, {}, SLOT), { fetchImpl: mockFetch([{ body: { choices: [], usage } }]).impl }).catch(x => x);
    expect(e).toBeInstanceOf(CompatHttpError);
    expect(e.usage).toEqual(usage);
    expect((await compatSend(compatRequest('particle:particle-1', ASK, {}, SLOT), { fetchImpl: mockFetch([{ body: {} }]).impl }).catch(x => x)).usage).toBeNull();
  });

  // Value: protects=no caller of compatSend sends a 2xx answer again (issue #280); fails_when=a 2xx without a message is retryable, or compatMayHaveBilled does not read it as billed, so qa-v2, the full-context reader, the workload route or the canary resend it; why_new=compatSend marks it not retryable and compatMayHaveBilled reads its 2xx status; seam=none; no_claim=whether Particle bills an answer without a message
  test('a 2xx answer without choices[0].message, or whose body is not JSON, is an error that is not retryable and that compatMayHaveBilled reads as billed, never an empty answer (#280)', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ finish_reason: 'stop' }] }, '<html>ok</html>']) {
      const e = await compatSend(compatRequest('particle:particle-1', ASK, {}, SLOT), { fetchImpl: mockFetch([{ body }]).impl }).catch(x => x);
      expect(e).toBeInstanceOf(CompatHttpError);
      expect(e).toMatchObject({ status: 200, kind: 'server', retryable: false });
      expect(e.message).toContain(typeof body === 'string' ? 'response body is not JSON' : 'no choices[0].message');
      expect(compatMayHaveBilled(e)).toBe(true);
    }
    const read = (status: number) => compatMayHaveBilled(new CompatHttpError(classifyCompatError('particle', status, 'x')));
    expect([read(429), read(500), read(502), read(503), read(504)]).toEqual([false, false, false, false, true]);
  });

  test('a credit 402 rejects with ParticleCreditExhausted', async () => {
    const m = mockFetch([{ status: 402, body: 'no balance' }]);
    await expect(compatSend(compatRequest('particle:particle-1', ASK, {}, SLOT), { fetchImpl: m.impl })).rejects.toBeInstanceOf(ParticleCreditExhausted);
  });

  test('the parsed response keeps the answer, finish, usage, response model and the identity metadata', async () => {
    const res = await compatSend(compatRequest('particle:particle-1', ASK, {}, SLOT), { fetchImpl: mockFetch([{ body: PARTICLE_OK }]).impl });
    expect(res).toMatchObject({ id: 'chatcmpl-1', text: 'In May 2023.', finish: 'stop', response_model: 'particle-ai/particle-1', usage: PARTICLE_OK.usage, tool_calls: [], logprobs: null });
    expect(res.meta).toEqual({ metadata: { weight_version: 'default' }, weight_version: 'default', service_tier: 'default', system_fingerprint: 'fp_1', non_default_tier: false, truncated: false });
    expect(normalizeUsage(usageSourceOf('particle:particle-1'), res.usage)).toEqual({ convention: 'openai-chat', input_total: 330, input_uncached: 74, cache_read: 256, cache_write: 0, output_total: 86, reasoning: 49 });
  });

  test('content sent as a list of parts keeps its text parts, in order', () => {
    const res = parseCompatResponse({ ...PARTICLE_OK, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: 'In May ' }, { type: 'image_url', image_url: {} }, { type: 'text', text: '2023.' }] } }] });
    expect(res.text).toBe('In May 2023.');
  });

  test('a truncated response keeps its empty answer: reasoning text never fills it', () => {
    const res = parseCompatResponse({ ...PARTICLE_OK, choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: 'Half a thought about rent' } }] });
    expect(res.text).toBe('');
    expect(res.finish).toBe('length');
    expect(res.meta.truncated).toBe(true);
    expect(parseCompatResponse({ choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'x' } }] }).text).toBe('');
  });

  test('a non-default service tier is flagged; a per-span metadata list is kept raw with no weight version', () => {
    expect(parseCompatResponse({ ...PARTICLE_OK, service_tier: 'flex' }).meta.non_default_tier).toBe(true);
    const spans = [{ span: [0, 40], weight_version: 'w1' }, { span: [40, 86], weight_version: 'w2' }];
    const meta = parseCompatResponse({ ...PARTICLE_OK, metadata: spans, service_tier: undefined, system_fingerprint: undefined }).meta;
    expect(meta).toEqual({ metadata: spans, weight_version: null, service_tier: null, system_fingerprint: null, non_default_tier: null, truncated: false });
  });

  test('tool calls and log probabilities are parsed', () => {
    const call = { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"query":"Lisbon"}' } };
    const res = parseCompatResponse({ ...PARTICLE_OK, choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [call] },
      logprobs: { content: [{ token: 'ok', logprob: -0.1, top_logprobs: [{ token: 'ok', logprob: -0.1 }, { token: 'OK', logprob: -2.5 }] }] } }] });
    expect(res.tool_calls).toEqual([call] as never);
    expect(res.text).toBe('');
    expect(res.logprobs).toEqual([{ token: 'ok', logprob: -0.1, top: [{ token: 'ok', logprob: -0.1 }, { token: 'OK', logprob: -2.5 }] }]);
  });

  // Value: protects=a billed 2xx answer with a malformed log-probability or tool-call list keeps its answer and usage (issue #276); fails_when=parseCompatResponse throws a TypeError, so the answer is recorded as failed with usage_raw null; why_new=the canary reads logprobs from every answer; seam=none; no_claim=what Particle sends in these fields today
  test('a malformed log-probability or tool-call entry in a billed answer is dropped, never thrown: the answer and its usage are kept (#276)', async () => {
    const shapes = [[null], ['ok'], [{ token: 'ok', logprob: -0.1, top_logprobs: {} }], [{ token: 'ok', logprob: -0.1, top_logprobs: 'ok' }], [{ token: 'ok', logprob: -0.1, top_logprobs: [null] }]];
    for (const content of shapes) {
      const body = { ...PARTICLE_OK, choices: [{ ...PARTICLE_OK.choices[0], logprobs: { content } }] };
      const res = await compatSend(compatRequest('particle:particle-1', ASK, {}, SLOT), { fetchImpl: mockFetch([{ body }]).impl });
      expect([res.text, res.usage, res.logprobs]).toEqual(['In May 2023.', PARTICLE_OK.usage, null]);
    }
    const call = { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } };
    const res = parseCompatResponse({ ...PARTICLE_OK, choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [null, 'search', call] } }] });
    expect([res.tool_calls, res.usage]).toEqual([[call] as never, PARTICLE_OK.usage]);
    expect(parseCompatResponse({ ...PARTICLE_OK, choices: [{ ...PARTICLE_OK.choices[0], logprobs: { content: [{ token: 'ok', logprob: -0.1 }, { token: '.', logprob: -0.2, top_logprobs: null }] } }] }).logprobs)
      .toEqual([{ token: 'ok', logprob: -0.1, top: [] }, { token: '.', logprob: -0.2, top: [] }]);
  });
});

/**
 * Throwaway TLS material for the transport tests, made with the openssl CLI in a temp dir at test time (never committed,
 * never a real key): a self-signed localhost certificate, a test CA, and localhost certificates that CA signed, valid,
 * for another host name, expired, not yet valid and with a broken signature.
 */
function tlsFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'compat-tls-'));
  const openssl = (...args: string[]) => {
    const r = Bun.spawnSync(['openssl', ...args], { cwd: dir, stdout: 'ignore', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr.toString()}`);
  };
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  openssl('req', '-x509', ...ec, '-keyout', 'self.key', '-out', 'self.pem', '-days', '30', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost');
  openssl('req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30', '-subj', '/CN=compat-test-ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  writeFileSync(join(dir, 'index.txt'), '');
  writeFileSync(join(dir, 'serial'), '1000\n');
  writeFileSync(join(dir, 'ca.cnf'), ['[ca]', 'default_ca = test', '[test]', 'dir = .', 'database = index.txt', 'serial = serial', 'new_certs_dir = .', 'certificate = ca.pem',
    'private_key = ca.key', 'default_md = sha256', 'policy = any', 'unique_subject = no', 'email_in_dn = no', '[any]', 'commonName = supplied', '[localhost]', 'subjectAltName = DNS:localhost', '[other]', 'subjectAltName = DNS:other.test', ''].join('\n'));
  const sign = (name: string, ext: string, start: string, end: string) => {
    openssl('req', ...ec, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', '/CN=localhost');
    openssl('ca', '-batch', '-notext', '-config', 'ca.cnf', '-extensions', ext, '-in', `${name}.csr`, '-out', `${name}.pem`, '-startdate', start, '-enddate', end);
  };
  sign('leaf', 'localhost', '20260101000000Z', '20991231000000Z');
  sign('other', 'other', '20260101000000Z', '20991231000000Z');
  sign('expired', 'localhost', '20200101000000Z', '20200102000000Z');
  sign('future', 'localhost', '20990101000000Z', '20990102000000Z');
  const der = Buffer.from(readFileSync(join(dir, 'leaf.pem'), 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64');
  der[der.length - 4] ^= 0xff;
  writeFileSync(join(dir, 'badsig.pem'), `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END CERTIFICATE-----\n`);
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  return { dir, read, ca: read('ca.pem') };
}

/** A loopback TLS server that answers 200 once it has read a request, and counts the request bytes it decrypted. */
async function tlsServer(cert: string, key: string) {
  let bytes = 0;
  const server = createTlsServer({ cert, key }, s => {
    s.on('error', () => {});
    s.on('data', d => { bytes += d.length; if (d.toString().includes('\r\n\r\n')) s.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}'); });
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, bytes: () => bytes, close: () => server.close() };
}

/** A loopback socket server that reads a request, counts its bytes, and then does what `answer` says. */
async function rawServer(answer: (s: Socket) => void) {
  let bytes = 0;
  const server = createServer(s => {
    s.on('error', () => {});
    let answered = false;
    s.on('data', d => { bytes += d.length; if (!answered && d.toString().includes('\r\n\r\n')) { answered = true; answer(s); } });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, bytes: () => bytes, close: () => server.close() };
}

const reject = async (send: () => Promise<unknown>) => {
  try { await send(); } catch (e) { return e as Error & { code?: unknown }; }
  throw new Error('the request did not fail');
};

describe('which particle transport failures may be sent again (#288)', () => {
  const fx = tlsFixtures();
  afterAll(() => rmSync(fx.dir, { recursive: true, force: true }));
  const particleAt = (base: string) => compatRequest('particle:particle-1', ASK, {}, { ...KEYED, PARTICLE_BASE_URL: base });

  // Value: protects=a particle request is sent again only after a failure that happened before any byte of it was sent (issue #288); fails_when=a code on the allowlist is one Bun gives after the request went out, or Bun 1.4.4 names one of these failures differently so the allowlist no longer matches it; why_new=COMPAT_PRE_SEND_CODES replaces the after-send denylist; seam=loopback servers, a closed port, an .invalid host, a multicast address and openssl-made certificates; no_claim=EAI_AGAIN and EADDRNOTAVAIL, which need a host with no network
  test('Bun gives each code on COMPAT_PRE_SEND_CODES before a byte of the request is sent, and compatMayHaveBilled reads none of them as billed', async () => {
    const compat = await import('../../eval/runner/providers/openai-compatible.ts') as Record<string, unknown>;
    const codes = compat.COMPAT_PRE_SEND_CODES as ReadonlySet<string> | undefined;
    const seen: Array<[string, unknown, number]> = [];
    const closed = createServer();
    await new Promise<void>(r => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>(r => closed.close(() => r()));
    for (const [name, url] of [['refused', `http://127.0.0.1:${port}/v1`], ['dns', 'http://particle-288.invalid/v1'], ['no route', 'http://224.0.0.1:80/v1'], ['bad url', 'http://exa mple.test/v1']] as const) {
      const e = await reject(() => fetch(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(10_000) }));
      seen.push([name, e.code, 0]);
      expect([name, compatMayHaveBilled(e)]).toEqual([name, false]);
    }
    for (const [name, cert, key, tls] of [
      ['self-signed', fx.read('self.pem'), fx.read('self.key'), {}],
      ['untrusted chain', fx.read('leaf.pem') + fx.ca, fx.read('leaf.key'), {}],
      ['untrusted leaf', fx.read('leaf.pem'), fx.read('leaf.key'), {}],
      ['other host', fx.read('other.pem'), fx.read('other.key'), { ca: fx.ca }],
      ['expired', fx.read('expired.pem'), fx.read('expired.key'), { ca: fx.ca }],
      ['not yet valid', fx.read('future.pem'), fx.read('future.key'), { ca: fx.ca }],
      ['bad signature', fx.read('badsig.pem'), fx.read('leaf.key'), { ca: fx.ca }],
    ] as const) {
      const server = await tlsServer(cert, key);
      try {
        const e = await reject(() => compatSend(particleAt(`https://localhost:${server.port}/v1`), { fetchImpl: ((url: string, init: RequestInit) => fetch(url, { ...init, tls } as RequestInit)) as unknown as typeof fetch }));
        seen.push([name, e.code, server.bytes()]);
        expect([name, compatMayHaveBilled(e)]).toEqual([name, false]);
      } finally { server.close(); }
    }
    const observed = seen.map(([name, code, bytes]) => [name, name === 'dns' && code === 'EAI_AGAIN' ? 'ENOTFOUND' : code, bytes] as const);
    expect(observed).toEqual([
      ['refused', 'ECONNREFUSED', 0], ['dns', 'ENOTFOUND', 0], ['no route', 'ENETUNREACH', 0], ['bad url', 'ERR_INVALID_URL', 0],
      ['self-signed', 'DEPTH_ZERO_SELF_SIGNED_CERT', 0], ['untrusted chain', 'SELF_SIGNED_CERT_IN_CHAIN', 0], ['untrusted leaf', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 0],
      ['other host', 'ERR_TLS_CERT_ALTNAME_INVALID', 0], ['expired', 'CERT_HAS_EXPIRED', 0], ['not yet valid', 'CERT_NOT_YET_VALID', 0], ['bad signature', 'CERT_SIGNATURE_FAILURE', 0],
    ]);
    expect([...(codes ?? [])].sort()).toEqual([...observed.map(([, code]) => String(code)), 'EAI_AGAIN', 'EADDRNOTAVAIL'].sort());
  }, 30_000);

  // Value: protects=a particle request that failed after it went out is never sent again, whatever Bun names the failure (issue #288); fails_when=compatMayHaveBilled reads a malformed status line, a bad Content-Length, a bad chunk, a body that fails to decompress, a TLS record corrupted after the request or an unnamed failure as one that never reached Particle, so qa-v2, readCompat, callCompat and both proxies send it again; why_new=only failures proven to happen before sending are resendable; seam=loopback servers that read the request and then answer badly; no_claim=what Particle's edge sends when it fails
  test('a failure after the request went out is read as billed, whatever code Bun gives it, and only a failure proven before sending is not', async () => {
    const answers: Array<[string, string, (s: Socket) => void]> = [
      ['garbage status line', 'Malformed_HTTP_Response', s => s.end('not http at all\r\n\r\n')],
      ['malformed header', 'Malformed_HTTP_Response', s => s.end('HTTP/1.1 200 OK\r\nbad header line\r\ncontent-length: 2\r\n\r\n{}')],
      ['bad content-length', 'InvalidContentLength', s => s.end('HTTP/1.1 200 OK\r\ncontent-length: abc\r\n\r\n{}')],
      ['bad chunk', 'InvalidHTTPResponse', s => s.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\nzz\r\nhello\r\n0\r\n\r\n')],
      ['gzip', 'ZlibError', s => s.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-encoding: gzip\r\ncontent-length: 10\r\n\r\nnotgzip!!!')],
      ['brotli', 'BrotliDecompressionError', s => s.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-encoding: br\r\ncontent-length: 10\r\n\r\nnotbrotli!')],
      ['reset', 'ECONNRESET', s => s.resetAndDestroy()],
    ];
    for (const [name, code, answer] of answers) {
      const server = await rawServer(answer);
      try {
        const e = await reject(() => compatSend(particleAt(`http://127.0.0.1:${server.port}/v1`)));
        expect([name, e.code, server.bytes() > 0, compatMayHaveBilled(e)]).toEqual([name, code, true, true]);
      } finally { server.close(); }
    }
    let read = 0;
    const corrupt = createServer(raw => {
      const t = new TLSSocket(raw, { isServer: true, cert: fx.read('leaf.pem'), key: fx.read('leaf.key') });
      t.on('error', () => {}); raw.on('error', () => {});
      t.on('data', d => { read += d.length; if (d.toString().includes('\r\n\r\n')) raw.write(Buffer.from('17030300ff' + 'ab'.repeat(255), 'hex')); });
    });
    await new Promise<void>(r => corrupt.listen(0, '127.0.0.1', r));
    try {
      const e = await reject(() => compatSend(particleAt(`https://localhost:${(corrupt.address() as AddressInfo).port}/v1`), { fetchImpl: ((url: string, init: RequestInit) => fetch(url, { ...init, tls: { ca: fx.ca } } as RequestInit)) as unknown as typeof fetch }));
      expect(['tls record after the request', e.code, read > 0, compatMayHaveBilled(e)]).toEqual(['tls record after the request', 'EPROTO', true, true]);
    } finally { corrupt.close(); }
    expect(compatMayHaveBilled(new TypeError('fetch failed'))).toBe(true);
    expect(compatMayHaveBilled(Object.assign(new TypeError('FailedToOpenSocket: Was there a typo in the url or port?'), { code: 'FailedToOpenSocket' }))).toBe(true);
    const budget = await reject(() => compatSend(compatRequest('particle:particle-1', ASK, {}, { ...KEYED, PARTICLE_BASE_URL: 'https://particle-288.example/v1' })));
    expect([budget.name, compatMayHaveBilled(budget)]).toEqual(['BudgetExceededError', false]);
    for (const status of [402, 429, 500, 503]) expect([status, compatMayHaveBilled(compatError(classifyCompatError('particle', status, '{}')))]).toEqual([status, false]);
    expect(compatMayHaveBilled(null)).toBe(false);
  }, 30_000);
});

describe('receipts', () => {
  test('every provider in the table follows the usage convention usage-receipt.ts gives it', () => {
    for (const [provider, row] of Object.entries(COMPAT_PROVIDERS)) for (const model of Object.keys(row.models)) expect(usageSourceOf(`${provider}:${model}`)).toBe(row.usage);
  });

  test('a receipt carries request and response_meta; a failed attempt\'s response_meta is all null', () => {
    const req = compatRequest('particle:particle-1', ASK, { effort: 'medium' }, KEYED);
    const res = parseCompatResponse(PARTICLE_OK);
    const ok = receipt({ lane: 'memory-qa', role: 'reader', question_id: 'q1', replicate: 0, attempt: 1, model: 'particle:particle-1', response_model: res.response_model, status: 'ok', error: null, from_cache: false,
      finish: 'stop', finish_raw: res.finish, answer: res.text, usage: normalizeUsage('openai', res.usage), usage_raw: res.usage, delivered: null, request: req.sent, response_meta: res.meta });
    expect(ok.request).toEqual({ effort_sent: 'medium', effort_effective: 'high', output_limit_field: 'max_completion_tokens', output_limit: 16_000, temperature_sent: null, seed_sent: null });
    expect(ok.response_meta?.weight_version).toBe('default');
    expect(responseMeta(null)).toEqual({ metadata: null, weight_version: null, service_tier: null, system_fingerprint: null, non_default_tier: null, truncated: null });
  });
});

describe('the budget ledger prices every table host', () => {
  test('each base URL host of each row, and each of its models, has a ledger price', () => {
    for (const [provider, row] of Object.entries(COMPAT_PROVIDERS)) {
      for (const base of [row.base_url_default, ...row.base_url_alternates]) {
        for (const [name, m] of Object.entries(row.models)) {
          const req = compatRequest(`${provider}:${name}`, ASK, {}, { [row.key_env]: 'k', [row.base_url_env]: base });
          expect(priceRequest(req.url, req.body)).toMatchObject({ provider, model: m.request_id, kind: 'chat', maxOutputTokens: m.output_floor });
          expect(chatPrice(`${provider}:${m.request_id}`)).toBeDefined();
        }
      }
    }
  });
});

describe('PRIMARY_MODELS and models_not_run', () => {
  test('the primary models are claude-opus-5-5 and particle-1', () => {
    expect([...PRIMARY_MODELS]).toEqual(['anthropic:claude-opus-5-5', 'particle:particle-1']);
  });

  test('a lane lists each primary model it cannot route, with the reason, and nothing when it routes both', () => {
    expect(modelsNotRun('workload-suites', m => m.startsWith('anthropic:'))).toEqual([{ model: 'particle:particle-1', reason: 'workload-suites has no particle: route' }]);
    expect(modelsNotRun('memory-qa', () => true)).toEqual([]);
  });
});

describe('the fake provider serves Particle', () => {
  let proc: ReturnType<typeof Bun.spawn>;
  let base = '';
  const log = join(mkdtempSync(join(tmpdir(), 'fake-particle-')), 'log.jsonl');
  const env = () => ({ ...KEYED, PARTICLE_BASE_URL: base });
  const faults = (list: unknown[]) => fetch(`${base.replace(/\/slot-1\/particle\/v1$/, '')}/__fake/particle/faults`, { method: 'POST', body: JSON.stringify({ faults: list }), keepalive: false });

  beforeAll(async () => {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = probe.port as number;
    probe.stop(true);
    proc = Bun.spawn(['python3', 'eval/systems/_shim/fake_provider.py', '--port', String(port), '--log', log], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
    base = `http://127.0.0.1:${port}/slot-1/particle/v1`;
    for (let i = 0; i < 200; i++) { try { await fetch(`${base}/models`, { keepalive: false }); break; } catch { await Bun.sleep(50); } }
  });
  afterAll(() => proc?.kill());

  test('a particle-1 answer with its response model, reasoning tokens and identity fields', async () => {
    const res = await compatSend(compatRequest('particle:particle-1', ASK, {}, env()));
    expect(res).toMatchObject({ text: 'ok', finish: 'stop', response_model: 'particle-ai/particle-1' });
    expect(res.meta).toMatchObject({ weight_version: 'default', service_tier: 'default', system_fingerprint: 'fp_fake_particle', non_default_tier: false });
    expect(normalizeUsage('openai', res.usage)!.reasoning).toBeGreaterThan(0);
    const line = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
    expect(line).toMatchObject({ route: 'chat', model: 'particle-1', effort: 'high', max_completion_tokens: 16_000, auth_present: true });
    expect(readFileSync(log, 'utf8')).not.toContain('test-key');
  });

  test('effort none leaves no reasoning; a limit below the reasoning returns an empty answer and finish length', async () => {
    const none = await compatSend(compatRequest('particle:particle-1', ASK, { effort: 'none' }, env()));
    expect(normalizeUsage('openai', none.usage)!.reasoning).toBe(0);
    const raw = await fetch(`${base}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'particle-1', messages: ASK, reasoning_effort: 'high', max_completion_tokens: 8 }), keepalive: false });
    const res = parseCompatResponse(await raw.json());
    expect(res).toMatchObject({ text: '', finish: 'length' });
    expect(res.meta.truncated).toBe(true);
  });

  test('tool_choice auto calls a tool, then submit_answer once a tool result is in the conversation', async () => {
    const tools = ['search', 'submit_answer'].map(name => ({ type: 'function' as const, function: { name, parameters: { type: 'object', properties: { query: { type: 'string' } } } } }));
    const first = await compatSend(compatRequest('particle:particle-1', ASK, { tools }, env()));
    expect(first.finish).toBe('tool_calls');
    expect(first.tool_calls[0]!.function.name).toBe('search');
    const turn2 = [...ASK, { role: 'assistant' as const, content: null, tool_calls: first.tool_calls }, { role: 'tool' as const, content: 'moved 2023-05', tool_call_id: first.tool_calls[0]!.id }];
    expect((await compatSend(compatRequest('particle:particle-1', turn2, { tools }, env()))).tool_calls[0]!.function.name).toBe('submit_answer');
  });

  test('queued faults: 429 with Retry-After, 429, then 200; a credit 402; a context-length 400', async () => {
    await faults([{ status: 429, retry_after: '1' }, { status: 429 }, { status: 402 }, { status: 400 }, { status: 402, body: 'out of credit, not the documented body' }]);
    const req = compatRequest('particle:particle-1', ASK, {}, env());
    expect(await compatSend(req).catch(e => e)).toMatchObject({ status: 429, retryAfterMs: 1000 });
    expect(await compatSend(req).catch(e => e)).toMatchObject({ status: 429, retryAfterMs: null });
    expect(await compatSend(req).catch(e => e)).toBeInstanceOf(ParticleCreditExhausted);
    expect(await compatSend(req).catch(e => e)).toMatchObject({ status: 400, kind: 'context_overflow' });
    expect(await compatSend(req).catch(e => e)).toBeInstanceOf(ParticleCreditExhausted);
    expect((await compatSend(req)).text).toBe('ok');
  });

  test('the Responses route answers 405, and the model list has particle-1 at the default and flex tiers', async () => {
    expect((await fetch(`${base}/responses`, { method: 'POST', body: '{}', keepalive: false })).status).toBe(405);
    const listed = (await (await fetch(`${base}/models`, { keepalive: false })).json()) as { data: Array<{ id: string; service_tier?: string }> };
    expect(listed.data.map(m => [m.id, m.service_tier ?? 'default'])).toEqual([['particle-ai/particle-1', 'default'], ['particle-ai/particle-1', 'flex']]);
  });
});
