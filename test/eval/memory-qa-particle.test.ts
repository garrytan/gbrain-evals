/**
 * particle-1 in memory-qa (plan GST-605 Phase 1 items 2 and 3, unit U2): qa-v2's chat client sends an OpenAI-compatible
 * provider through eval/runner/providers inside its existing 5-attempt loop, its receipts record what each attempt sent
 * and what answered, and run.ts and run-systems.ts stop on a budget stop instead of reading on. Keyless: every provider
 * response is a recorded synthetic body served by a mocked fetch, and the Particle key is a placeholder.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { ChatClient, chatCacheKey, checkEffort, hasChatRoute, sendsTemperature } from '../../eval/runner/memory-qa/qa-v2.ts';
import { UPSTREAM_DEADLINE_MS } from '../../eval/runner/metering-proxy.ts';
import { parseRunArgs, readAndJudge, runArm, type MemoryQaRow, type RunArgs } from '../../eval/runner/memory-qa/run.ts';
import * as systems from '../../eval/runner/memory-qa/run-systems.ts';
import { sumUsage, type UsageReceipt } from '../../eval/runner/usage-receipt.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'memory-qa-particle-')); dirs.push(d); return d; };
const ENV = ['PARTICLE_API_KEY', 'PARTICLE_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GBRAIN_EVALS_QA_CACHE'] as const;
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
const realFetch = globalThis.fetch;
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { PARTICLE_API_KEY: 'test-key', OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test' });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  closeLedgers();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A particle-1 response in the shape api.particle.ai returned to the 2026-10-31 probes. */
const PARTICLE_OK = {
  id: 'chatcmpl-1', object: 'chat.completion', model: 'particle-ai/particle-1', service_tier: 'default', system_fingerprint: 'fp_1', metadata: { weight_version: 'default' },
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'In May 2023.', reasoning_content: 'The user said May.' } }],
  usage: { prompt_tokens: 330, completion_tokens: 86, total_tokens: 416, prompt_tokens_details: { cached_tokens: 256 }, completion_tokens_details: { reasoning_tokens: 49 } },
};
const JUDGE_YES = { model: 'gpt-4o-mini', choices: [{ finish_reason: 'stop', message: { content: 'yes' } }], usage: { prompt_tokens: 300, completion_tokens: 1 } };

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };
/** Mock fetch: Particle requests get `particle` in order, OpenAI requests get a judge "yes". Records every request. */
function serve(particle: Reply[]) {
  const seen: Array<{ host: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push({ host: url.hostname, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
    const r = url.hostname === 'api.particle.ai' ? particle.shift() : url.hostname === 'api.openai.com' ? { body: JUDGE_YES } : undefined;
    if (!r) throw new Error(`unexpected request to ${url.hostname}`);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  }) as typeof fetch;
  return { seen, particle: () => seen.filter(s => s.host === 'api.particle.ai'), openai: () => seen.filter(s => s.host === 'api.openai.com') };
}

const qa = (over: Partial<RunArgs['qa']> = {}): RunArgs['qa'] => ({ mode: 'reader', reader: 'particle:particle-1', judge: 'openai:gpt-4o-mini', runs: 1, sessions: 5, budgetTokens: null, thinkModel: 'anthropic:claude-sonnet-5-5', context: 'sessions', ...over });
const q = { id: 'q1', conversation: 'c1', question: 'When did I move?', category: 'temporal-reasoning', gold: ['s1'], abstention: false, answer: 'May 2023' } as never;
const SENT = { effort_sent: 'high', effort_effective: 'high', output_limit_field: 'max_completion_tokens', output_limit: 16_000, temperature_sent: null, seed_sent: null };
const NULL_META = { metadata: null, weight_version: null, service_tier: null, system_fingerprint: null, non_default_tier: null, truncated: null };

describe('Anthropic and OpenAI calls are unchanged', () => {
  test('one existing OpenAI cache key and one Anthropic cache key keep the values main computed', () => {
    expect(chatCacheKey('openai:gpt-4o-2024-08-06', 'READ', { maxTokens: 1024, replicate: 0 })).toBe('e1943250c2e464ce22d77602c0bddc508a35564be5e27594e106517413c740ac');
    expect(chatCacheKey('anthropic:claude-sonnet-5-5', 'READ', { maxTokens: 1024, replicate: 0 })).toBe('703e6ac8975fdef69bf0917bf16d381639c34179133298a53c1684eb9f86d46e');
  });

  test('request bodies through the client are byte-identical to main\'s, and their receipts gain no Particle fields', async () => {
    const sent: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push(`${url} ${String(init?.body)}`);
      return new Response(JSON.stringify(url.includes('anthropic') ? { content: [{ type: 'text', text: 'yes' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }
        : { choices: [{ message: { content: 'yes' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }) as typeof fetch;
    const c = new ChatClient(tmp(), () => 0);
    await c.chat('openai:gpt-4o-2024-08-06', 'READ', { maxTokens: 1024, replicate: 0 });
    await c.chat('openai:gpt-4o-mini', 'JUDGE', { maxTokens: 10, replicate: 0 });
    await c.chat('openai:gpt-6.1-sol', 'READ', { maxTokens: 1024, replicate: 1 });
    await c.chat('anthropic:claude-sonnet-5-5', 'READ', { maxTokens: 1024, replicate: 0 });
    await c.chat('anthropic:claude-sonnet-4-6', 'JUDGE', { maxTokens: 10, replicate: 0 });
    await c.chat('openai:gpt-6.1-sol', 'READ', { maxTokens: 2048, replicate: 0, effort: 'medium', system: 'SYS' });
    await c.chat('anthropic:claude-opus-5-5', 'JUDGE', { maxTokens: 10, replicate: 0, temperature: null });
    await c.chat('anthropic:claude-opus-5-5', 'READ', { maxTokens: 2048, replicate: 0, effort: 'low' });
    const out = await c.chat('openai:gpt-4.1-mini', 'JUDGE', { maxTokens: 1024, replicate: 0, temperature: 0, system: 'SYS', attempt: 1 });
    // Captured from main d8a01dfd (qa-v2 and qa.ts send the first five identically).
    expect(sent).toEqual([
      'https://api.openai.com/v1/chat/completions {"model":"gpt-4o-2024-08-06","messages":[{"role":"user","content":"READ"}],"n":1,"temperature":0,"max_tokens":1024}',
      'https://api.openai.com/v1/chat/completions {"model":"gpt-4o-mini","messages":[{"role":"user","content":"JUDGE"}],"n":1,"temperature":0,"max_tokens":10}',
      'https://api.openai.com/v1/chat/completions {"model":"gpt-6.1-sol","messages":[{"role":"user","content":"READ"}],"n":1,"max_completion_tokens":2000}',
      'https://api.anthropic.com/v1/messages {"model":"claude-sonnet-5-5","max_tokens":1024,"messages":[{"role":"user","content":"READ"}]}',
      'https://api.anthropic.com/v1/messages {"model":"claude-sonnet-4-6","max_tokens":10,"temperature":0,"messages":[{"role":"user","content":"JUDGE"}]}',
      'https://api.openai.com/v1/chat/completions {"model":"gpt-6.1-sol","messages":[{"role":"system","content":"SYS"},{"role":"user","content":"READ"}],"n":1,"max_completion_tokens":2048,"reasoning_effort":"medium"}',
      'https://api.anthropic.com/v1/messages {"model":"claude-opus-5-5","max_tokens":2000,"messages":[{"role":"user","content":"JUDGE"}]}',
      'https://api.anthropic.com/v1/messages {"model":"claude-opus-5-5","max_tokens":2048,"output_config":{"effort":"low"},"messages":[{"role":"user","content":"READ"}]}',
      'https://api.openai.com/v1/chat/completions {"model":"gpt-4.1-mini","messages":[{"role":"system","content":"SYS"},{"role":"user","content":"JUDGE"}],"n":1,"temperature":0,"max_tokens":1024}',
    ]);
    expect(['sent', 'response_meta', 'compat_attempts'].filter(k => k in out)).toEqual([]);
  });

  test('routes and temperature: Particle is routed and never sent a temperature; other providers keep qa.ts\'s rule', () => {
    expect(['anthropic:claude-opus-5-5', 'particle:particle-1', 'openai:gpt-6.1-sol', 'gemini:gemini-3.8-flash'].map(hasChatRoute)).toEqual([true, true, true, false]);
    expect(['particle:particle-1', 'openai:gpt-4o-mini', 'openai:gpt-6.1-sol', 'anthropic:claude-sonnet-4-6'].map(sendsTemperature)).toEqual([false, true, false, true]);
  });
});

describe('the particle route in qa-v2', () => {
  test('a particle cache key adds the effort and output limit sent, and needs no key', () => {
    delete process.env.PARTICLE_API_KEY;
    const key = (o: Record<string, unknown>) => createHash('sha256').update(JSON.stringify({ provider: 'particle', name: 'particle-1', prompt: 'READ', maxTokens: 1024, temperature: 0, replicate: 0, ...o })).digest('hex');
    expect(chatCacheKey('particle:particle-1', 'READ', { maxTokens: 1024, replicate: 0 })).toBe(key({ sent_effort: 'high', sent_output_limit: 16_000 }));
    expect(chatCacheKey('particle:particle-1', 'READ', { maxTokens: 1024, replicate: 0, effort: 'medium' })).toBe(key({ sent_effort: 'medium', sent_output_limit: 16_000, effort: 'medium' }));
    expect(() => chatCacheKey('particle:particle-1', 'READ', { maxTokens: 1024, replicate: 0, effort: 'turbo' })).toThrow('not one Particle lists');
  });

  test('a fake 429, 429, 200 leaves three receipts: each records what it sent, the first its Retry-After wait, the answer its identity', async () => {
    const mock = serve([{ status: 429, body: { error: 'slow down' }, headers: { 'Retry-After': '1' } }, { status: 429, body: { error: 'slow down' } }, { body: PARTICLE_OK }]);
    const dir = tmp();
    const t0 = performance.now();
    const row = await readAndJudge({ benchmark: 'lme-s', qa: qa(), q, chat: new ChatClient(dir, () => 0), think: null, prompt: 'P', countTokens: null });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(950);
    expect(mock.particle().map(s => s.body)).toEqual(Array(3).fill({ model: 'particle-1', messages: [{ role: 'user', content: 'P' }], reasoning_effort: 'high', max_completion_tokens: 16_000 }));
    expect(mock.particle()[0]!.headers.authorization).toBe('Bearer test-key');
    const readers = row.qa_receipts!.filter(r => r.role === 'reader');
    expect(readers.map(r => [r.attempt, r.status, r.retry_after_ms])).toEqual([[0, 'error', 1000], [1, 'error', undefined], [2, 'ok', undefined]]);
    expect(readers.every(r => JSON.stringify(r.request) === JSON.stringify(SENT))).toBe(true);
    expect(readers.slice(0, 2).map(r => r.response_meta)).toEqual([NULL_META, NULL_META]);
    expect(readers[2]).toMatchObject({ answer: 'In May 2023.', response_model: 'particle-ai/particle-1', finish: 'stop', response_meta: { weight_version: 'default', service_tier: 'default', system_fingerprint: 'fp_1', non_default_tier: false, truncated: false } });
    expect(sumUsage(readers)).toMatchObject({ records: 3, errors: 2, retries: 2, input_total: 330, cache_read: 256, output_total: 86, reasoning: 49 });
    const judge = row.qa_receipts!.find(r => r.role === 'judge')!;
    expect(['request', 'response_meta', 'retry_after_ms'].filter(k => k in judge)).toEqual([]);
    expect(row.qa_score).toBe(1);

    delete process.env.PARTICLE_API_KEY;
    const again = await readAndJudge({ benchmark: 'lme-s', qa: qa(), q, chat: new ChatClient(dir, () => 0), think: null, prompt: 'P', countTokens: null });
    expect(again.qa_receipts!.filter(r => r.role === 'reader').map(r => [r.from_cache, r.request?.effort_sent, r.response_meta?.weight_version])).toEqual([[true, 'high', 'default']]);
    expect(mock.particle()).toHaveLength(3);
  });

  test('a fifth failed attempt records no Retry-After wait and throws without waiting, since no attempt follows', async () => {
    const slow = { status: 429, body: { error: 'slow down' }, headers: { 'Retry-After': '0' } };
    const mock = serve([slow, slow, slow, slow, { ...slow, headers: { 'Retry-After': '1' } }]);
    const t0 = performance.now();
    const row = await readAndJudge({ benchmark: 'lme-s', qa: qa(), q, chat: new ChatClient(tmp(), () => 0), think: null, prompt: 'P', countTokens: null });
    expect(performance.now() - t0).toBeLessThan(900);
    expect(mock.particle()).toHaveLength(5);
    expect(row.qa_error).toStartWith('particle 429');
    expect(row.qa_receipts!.map(r => [r.attempt, r.status, r.retry_after_ms])).toEqual([[0, 'error', 0], [1, 'error', 0], [2, 'error', 0], [3, 'error', 0], [4, 'error', undefined]]);
  });

  // Value: protects=a particle reading answered 200 without a message is billed once (issue #280); fails_when=qa-v2's chat client retries it as the server error the provider module used to class it; why_new=compatSend marks a 2xx without a message not retryable and compatMayHaveBilled reads it as billed; seam=none; no_claim=whether Particle bills an answer without a message
  test('a 200 with no message is sent once, its usage on the failed attempt: Particle answered it, so it may have billed it (#280)', async () => {
    const mock = serve([{ body: { id: 'chatcmpl-0', model: 'particle-ai/particle-1', choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } } }, { body: PARTICLE_OK }]);
    const row = await readAndJudge({ benchmark: 'lme-s', qa: qa(), q, chat: new ChatClient(tmp(), () => 0), think: null, prompt: 'P', countTokens: null });
    expect(mock.particle()).toHaveLength(1);
    expect(row.qa_error).toContain('no choices[0].message');
    expect(row.qa_receipts!.filter(r => r.role === 'reader').map(r => [r.attempt, r.status, r.usage?.input_total, r.usage?.output_total])).toEqual([[0, 'error', 100, 50]]);
  });

  // Value: protects=a slow particle-1 answer is billed once (issue #250); fails_when=a timed-out attempt is sent again, or an attempt waits Bun's or compatSend's 300 s instead of the proxies' upstream deadline; why_new=the qa-v2 compat branch had no deadline and retried timeouts; seam=none; no_claim=Particle's billing of an aborted request
  test('a particle attempt that times out ends the loop after one request, sent with the proxies\' 900-second upstream deadline (issue #250)', async () => {
    const timeout = AbortSignal.timeout;
    const deadlines: number[] = [];
    AbortSignal.timeout = (ms: number) => { deadlines.push(ms); return timeout.call(AbortSignal, ms); };
    try {
      for (const name of ['TimeoutError', 'AbortError']) {
        let calls = 0;
        globalThis.fetch = (async () => { calls++; throw new DOMException('The operation timed out.', name); }) as unknown as typeof fetch;
        const row = await readAndJudge({ benchmark: 'lme-s', qa: qa(), q, chat: new ChatClient(tmp(), () => 0), think: null, prompt: 'P', countTokens: null });
        expect(calls).toBe(1);
        expect(row.qa_error).toContain('timed out');
        expect(row.qa_receipts!.filter(r => r.role === 'reader').map(r => [r.attempt, r.status, r.retry_after_ms])).toEqual([[0, 'error', undefined]]);
      }
    } finally { AbortSignal.timeout = timeout; }
    expect(deadlines).toEqual([UPSTREAM_DEADLINE_MS, UPSTREAM_DEADLINE_MS]);
  });

  // Value: protects=a particle reading through the lease proxy is never abandoned while the proxy still sends and bills it (issue #271); fails_when=an attempt on a loopback proxy slot waits only the 900 s upstream deadline, which the proxy's admission wait (up to 600 s) eats into; why_new=qa-v2's deadline follows the request's URL (compatDeadlineMs); seam=none; no_claim=a real 26-minute wait
  test('an attempt on a loopback proxy slot waits the proxy\'s longest admission wait plus its upstream deadline; a direct attempt waits the upstream deadline (#271)', async () => {
    const { PROXIED_DEADLINE_MS } = await import('../../eval/runner/metering-proxy.ts');
    const timeout = AbortSignal.timeout;
    const deadlines: number[] = [];
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => { urls.push(String(input)); return Response.json(PARTICLE_OK); }) as unknown as typeof fetch;
    AbortSignal.timeout = (ms: number) => { deadlines.push(ms); return timeout.call(AbortSignal, ms); };
    try {
      process.env.PARTICLE_BASE_URL = 'http://127.0.0.1:8787/harness/particle/v1';
      expect((await new ChatClient(tmp(), () => 0).chat('particle:particle-1', 'P', { maxTokens: 64, replicate: 0 })).text).toBe('In May 2023.');
      delete process.env.PARTICLE_BASE_URL;
      expect((await new ChatClient(tmp(), () => 0).chat('particle:particle-1', 'P', { maxTokens: 64, replicate: 0 })).text).toBe('In May 2023.');
    } finally { AbortSignal.timeout = timeout; }
    expect(urls).toEqual(['http://127.0.0.1:8787/harness/particle/v1/chat/completions', 'https://api.particle.ai/v1/chat/completions']);
    expect(deadlines).toEqual([PROXIED_DEADLINE_MS, UPSTREAM_DEADLINE_MS]);
  });

  // Value: protects=a particle request whose connection resets after it went out is billed once without the lease proxy; fails_when=qa-v2 retries the reset as a lost connection; why_new=the lease proxy already answers this reset 504 and never resends it, the direct client retried it; seam=a loopback socket that reads the request, then resets; no_claim=Particle's billing of a reset request
  test('a particle request whose connection resets after it went out ends the loop after one request, as a timeout does', async () => {
    let connections = 0;
    const server = createServer(socket => { connections++; socket.once('data', () => socket.resetAndDestroy()); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.PARTICLE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    try {
      const err = await new ChatClient(tmp(), () => 0).chat('particle:particle-1', 'P', { maxTokens: 64, replicate: 0 }).catch(e => e) as Error & { attempt_errors?: string[] };
      expect(connections).toBe(1);
      expect(err.attempt_errors).toHaveLength(1);
    } finally { server.close(); }
  });

  // Value: protects=a particle request that failed after it may have gone out is billed once without the lease proxy, whatever Bun names the failure (issue #288); fails_when=qa-v2 reads a malformed status line or a bad chunk as a failure that never reached Particle and sends it again; why_new=compatMayHaveBilled reads every transport failure not proven to happen before sending as billed; seam=a loopback socket that reads the request, then answers badly; no_claim=what Particle's edge sends when it fails
  test('a particle request answered with a malformed status line or a bad chunk ends the loop after one request (#288)', async () => {
    for (const reply of ['not http at all\r\n\r\n', 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\nzz\r\nhello\r\n0\r\n\r\n']) {
      let connections = 0;
      const server = createServer(socket => { connections++; socket.on('error', () => {}); socket.once('data', () => socket.end(reply)); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      process.env.PARTICLE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      try {
        const err = await new ChatClient(tmp(), () => 0).chat('particle:particle-1', 'P', { maxTokens: 64, replicate: 0 }).catch(e => e) as Error & { attempt_errors?: string[] };
        expect([reply.slice(0, 15), connections, err.attempt_errors?.length]).toEqual([reply.slice(0, 15), 1, 1]);
      } finally { server.close(); }
    }
  });

  test('a 429 whose body mentions a budget is retried like any 429; only a BudgetExceededError stops the loop', async () => {
    const mock = serve([{ status: 429, body: { error: { message: 'per-minute token budget exceeded' } } }, { body: PARTICLE_OK }]);
    const row = await readAndJudge({ benchmark: 'lme-s', qa: qa(), q, chat: new ChatClient(tmp(), () => 0), think: null, prompt: 'P', countTokens: null });
    expect(mock.particle()).toHaveLength(2);
    expect(row.qa_receipts!.filter(r => r.role === 'reader').map(r => [r.attempt, r.status])).toEqual([[0, 'error'], [1, 'ok']]);
    expect(row.qa_score).toBe(1);
  });

  test('a particle judge in run.ts records what each attempt sent, the answer\'s identity and the usage a failed attempt reported', async () => {
    const yes = { ...PARTICLE_OK, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'yes' } }] };
    const args: Omit<Parameters<typeof readAndJudge>[0], 'chat'> = { benchmark: 'lme-s', qa: qa({ reader: 'openai:gpt-4o-mini', judge: 'particle:particle-1' }), q, think: null, prompt: 'P', countTokens: null };
    const mock = serve([{ status: 503, body: { error: { message: 'overloaded' } } }, { body: yes }]);
    const row = await readAndJudge({ ...args, chat: new ChatClient(tmp(), () => 0) });
    expect(mock.particle()).toHaveLength(2);
    const judges = row.qa_receipts!.filter(r => r.role === 'judge');
    expect(judges.map(r => [r.attempt, r.status, r.request?.effort_sent, r.request?.output_limit])).toEqual([[0, 'error', 'high', 16_000], [1, 'ok', 'high', 16_000]]);
    expect(judges.map(r => r.response_meta?.weight_version ?? null)).toEqual([null, 'default']);
    expect(judges.map(r => [r.usage?.input_total, r.usage?.output_total])).toEqual([[undefined, undefined], [330, 86]]);
    expect(row.qa_score).toBe(1);
    const billed = serve([{ body: { id: 'chatcmpl-0', model: 'particle-ai/particle-1', choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } } }, { body: yes }]);
    const failed = await readAndJudge({ ...args, chat: new ChatClient(tmp(), () => 0) });
    expect(billed.particle()).toHaveLength(1);
    expect(failed.qa_receipts!.filter(r => r.role === 'judge').map(r => [r.attempt, r.status, r.request?.output_limit, r.usage?.input_total, r.usage?.output_total])).toEqual([[0, 'error', 16_000, 100, 50]]);
  });

  test('a credit 402 is one attempt: its receipt is written and the stop reaches the caller with the receipts gathered so far', async () => {
    const mock = serve([{ status: 402, body: { error: { message: 'insufficient balance' } } }]);
    const err = await readAndJudge({ benchmark: 'lme-s', qa: qa(), q, chat: new ChatClient(tmp(), () => 0), think: null, prompt: 'P', countTokens: null }).catch(e => e) as Error & { qa_receipts: UsageReceipt[] };
    expect(err.name).toBe('BudgetExceededError');
    expect(err.message).toStartWith('budget: Particle credit exhausted');
    expect(err.qa_receipts.map(r => [r.role, r.status, r.request?.output_limit])).toEqual([['reader', 'error', 16_000]]);
    expect(mock.particle()).toHaveLength(1);
    expect(mock.openai()).toHaveLength(0);
  });

  test('--reader-effort reaches the request; it is absent from the run config unless set; a missing key or an unlisted effort is refused before anything runs', async () => {
    const mock = serve([{ body: PARTICLE_OK }]);
    await readAndJudge({ benchmark: 'lme-s', qa: qa({ effort: 'none' }), q, chat: new ChatClient(tmp(), () => 0), think: null, prompt: 'P', countTokens: null });
    expect(mock.particle()[0]!.body.reasoning_effort).toBe('none');
    const argv = ['--benchmark', 'fixture', '--qa', 'reader', '--qa-context', 'oracle', '--reader', 'particle:particle-1', '--output', join(tmp(), 'out')];
    expect('effort' in parseRunArgs(argv).qa).toBe(false);
    expect(parseRunArgs([...argv, '--reader-effort', 'none']).qa.effort).toBe('none');
    await expect(runArm(parseRunArgs([...argv, '--reader-effort', 'turbo']))).rejects.toThrow('reasoning effort "turbo" is not one Particle lists');
    delete process.env.PARTICLE_API_KEY;
    await expect(runArm(parseRunArgs(argv))).rejects.toThrow('PARTICLE_API_KEY is not set');
    expect([mock.particle().length, mock.seen.length]).toEqual([1, 2]);
  });

  test('an effort the reader\'s provider does not list, any effort for an OpenAI model that does not reason, and --reader-effort without --qa reader are refused before anything runs', async () => {
    const mock = serve([]);
    const run = (reader: string, effort: string) => runArm(parseRunArgs(['--benchmark', 'fixture', '--qa', 'reader', '--qa-context', 'oracle', '--reader', reader, '--reader-effort', effort, '--output', join(tmp(), 'out')]));
    await expect(run('openai:gpt-4o-2024-08-06', 'high')).rejects.toThrow('openai:gpt-4o-2024-08-06 is not an OpenAI reasoning model, so it takes no reasoning effort');
    await expect(run('openai:gpt-6.1-sol', 'turbo')).rejects.toThrow('reasoning effort "turbo" is not one openai accepts (none, minimal, low, medium, high, xhigh, max)');
    await expect(run('anthropic:claude-sonnet-5-5', 'minimal')).rejects.toThrow('reasoning effort "minimal" is not one anthropic accepts (low, medium, high, xhigh, max)');
    await expect(runArm(parseRunArgs(['--benchmark', 'fixture', '--qa', 'think', '--reader-effort', 'high', '--output', join(tmp(), 'out')]))).rejects.toThrow('--reader-effort sets the reader\'s effort, so it needs --qa reader');
    expect(() => checkEffort('anthropic:claude-opus-5-5', 'xhigh')).not.toThrow();
    expect(() => checkEffort('openai:gpt-6.1-sol', 'none')).not.toThrow();
    expect(mock.seen).toHaveLength(0);
  });

  test('memory-system cells: every particle model the cell calls is checked before it ingests, a provider proxy refuses particle, and --reader-effort is refused', async () => {
    const mock = serve([]);
    const out = join(tmp(), 'systems');
    const cell = (...extra: string[]) => runArm(parseRunArgs(['--benchmark', 'fixture', '--system', 'fake', '--qa', 'reader', '--output', out, ...extra]));
    await expect(cell('--reader', 'particle:particle-1', '--provider-proxy', 'http://127.0.0.1:9')).rejects.toThrow('particle:particle-1 cannot run behind --provider-proxy yet');
    expect(() => parseRunArgs(['--benchmark', 'fixture', '--system', 'fake', '--reader', 'particle:particle-1', '--reader-effort', 'none', '--output', out])).toThrow('--reader-effort sets the reading lane\'s reader');
    delete process.env.PARTICLE_API_KEY;
    await expect(cell('--reader', 'particle:particle-1')).rejects.toThrow('PARTICLE_API_KEY is not set');
    await expect(cell('--reader', 'openai:gpt-4o-mini', '--judge', 'particle:particle-1')).rejects.toThrow('PARTICLE_API_KEY is not set');
    expect(existsSync(out)).toBe(false);
    expect(mock.seen).toHaveLength(0);
  });
});

/** A paid ledger run for one runArm call. */
function paidArgs(label: string) {
  const ledger = join(tmp(), `${label}.sqlite`);
  initLedger({ ledgerPath: ledger });
  const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, estimateUsd: 0.1, ledgerPath: ledger });
  return ['--paid', '--budget-run-id', run.runId, '--budget-ledger', ledger];
}

describe('the budget stop', () => {
  test('run.ts think lane: gbrain think answers llm_error when the ledger refuses its request, and that is a budget stop, not an empty answer judged', async () => {
    const mock = serve([]);
    const think = async () => ({ answer: '', synthesis_status: 'llm_error', usage: null, modelUsed: 'claude-sonnet-5-5' });
    const args = { benchmark: 'lme-s', qa: qa({ mode: 'think' }), q, chat: new ChatClient(tmp(), () => 0), think: { fn: think as never, engine: null }, prompt: null, countTokens: null };
    const err = await readAndJudge({ ...args, budgetExhausted: () => true }).catch(e => e) as Error & { qa_receipts: UsageReceipt[] };
    expect(err.name).toBe('BudgetExceededError');
    expect(err.message).toBe('budget: the ledger refused a request during gbrain think, which reported llm_error');
    expect(err.qa_receipts.map(r => [r.role, r.status, r.finish_raw, r.answer])).toEqual([['think', 'error', 'llm_error', '']]);
    expect(mock.openai()).toHaveLength(0);
    const row = await readAndJudge({ ...args, budgetExhausted: () => false });
    expect(row.qa_receipts!.map(r => [r.role, r.status])).toEqual([['think', 'ok'], ['judge', 'ok']]);
    expect(mock.openai()).toHaveLength(1);
  });

  test('run.ts: a credit 402 writes the question\'s row with its receipt, then no judge, no later question and no later conversation runs; the summary says stopped: budget', async () => {
    process.env.GBRAIN_EVALS_QA_CACHE = join(tmp(), 'qa-cache');
    const mock = serve([{ body: PARTICLE_OK }, { status: 402, body: { error: { message: 'insufficient balance' } } }]);
    const out = join(tmp(), 'run');
    const { receipt, rows } = await runArm(parseRunArgs(['--benchmark', 'fixture', '--qa', 'reader', '--qa-context', 'oracle', '--reader', 'particle:particle-1', '--judge', 'openai:gpt-4o-mini',
      ...paidArgs('run-stop'), '--output', out]));
    expect(mock.particle()).toHaveLength(2);
    expect(mock.openai()).toHaveLength(1);
    expect(rows.map(r => [r.id, typeof r.qa_score === 'number', r.error?.slice(0, 33) ?? null, r.error_origin ?? null])).toEqual([
      ['fx-00', true, null, null], ['fx-01', false, 'budget: Particle credit exhausted', 'harness'],
    ]);
    const stoppedRow = rows[1] as MemoryQaRow;
    expect(stoppedRow.qa_receipts!.map(r => [r.role, r.status, r.request?.effort_sent])).toEqual([['reader', 'error', 'high']]);
    expect(receipt.run_status).toBe('partial');
    expect(receipt.summary).toMatchObject({ stopped: 'budget', qa_rows: 1 });
    expect(receipt.models_not_run).toEqual([]);
    expect((receipt.qa as { temperature_sent: { reader: unknown } }).temperature_sent.reader).toBe('none (provider default)');
    expect((receipt.usage as { by_role: Record<string, { errors: number; records: number }> }).by_role.reader).toMatchObject({ records: 2, errors: 1 });
  }, 60_000);

  test('run.ts: a stop on the last question leaves the run partial, and the rerun that answers it reads complete although the stopped row stays in the file, counting each question once', async () => {
    process.env.GBRAIN_EVALS_QA_CACHE = join(tmp(), 'qa-cache');
    const out = join(tmp(), 'run');
    const argv = ['--benchmark', 'fixture', '--qa', 'reader', '--qa-context', 'oracle', '--reader', 'particle:particle-1', '--judge', 'openai:gpt-4o-mini', '--limit', '2', ...paidArgs('last-stop'), '--output', out];
    serve([{ body: PARTICLE_OK }, { status: 402, body: { error: { message: 'insufficient balance' } } }]);
    const first = await runArm(parseRunArgs(argv));
    expect([first.rows.length, first.receipt.run_status, (first.receipt.summary as { stopped?: string }).stopped]).toEqual([2, 'partial', 'budget']);
    serve([{ body: PARTICLE_OK }]);
    const second = await runArm(parseRunArgs(argv));
    expect([second.rows.length, second.receipt.run_status, 'stopped' in (second.receipt.summary as object)]).toEqual([3, 'complete', false]);
    expect(second.receipt.counts).toMatchObject({ rows: 2, errors: 0 });
    expect(second.receipt.summary).toMatchObject({ qa_rows: 2, qa_errors: 0 });
  }, 60_000);

  test('run-systems.ts: reader calls leave receipts, and a credit 402 ends the question as budget_not_run and stops the cell', async () => {
    process.env.GBRAIN_EVALS_QA_CACHE = join(tmp(), 'qa-cache');
    const mock = serve([{ body: PARTICLE_OK }, { status: 402, body: { error: { message: 'insufficient balance' } } }]);
    const { receipt, rows } = await systems.runArm(systems.parseRunArgs(['--benchmark', 'fixture', '--system', 'fake', '--qa', 'reader', '--reader', 'particle:particle-1', '--judge', 'openai:gpt-4o-mini',
      ...paidArgs('systems-stop'), '--output', join(tmp(), 'systems')]));
    expect(mock.particle()).toHaveLength(2);
    expect(mock.openai()).toHaveLength(1);
    expect(rows.map(r => [r.id, r.outcome])).toEqual([['fx-00', 'scored'], ['fx-01', 'budget_not_run']]);
    expect(rows[0]!.qa_receipts!.map(r => [r.role, r.status, r.response_meta?.weight_version])).toEqual([['reader', 'ok', 'default']]);
    expect(rows[1]!.qa_receipts!.map(r => [r.role, r.status, r.request?.output_limit])).toEqual([['reader', 'error', 16_000]]);
    expect(receipt.run_status).toBe('partial');
    expect(receipt.summary).toMatchObject({ stopped: 'budget' });
    expect(receipt.models_not_run).toEqual([]);
    expect((receipt.outcomes as Record<string, number>)).toMatchObject({ scored: 1, budget_not_run: 1 });
  }, 60_000);
});
