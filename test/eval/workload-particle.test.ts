/**
 * Workload suites on particle-1 (plan GST-605, Phase 2 items 4 and 5): the reader route in bench-infra.ts, its
 * per-attempt usage receipts and credit stop, the output floor in bench.ts, the run config's particle entry and
 * models_not_run, and the request-log fields bar 2 reads from the harness metering proxy.
 *
 * Particle requests go through the real harness metering proxy to the keyless fake provider
 * (eval/systems/_shim/fake_provider.py) on loopback; OpenAI and Anthropic requests go to the stub upstream. No real
 * key is used: the proxy holds a placeholder Particle key and the fake never checks it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers, initLedger, ledgerStatus } from '../../eval/runner/budget-ledger.ts';
import { readRequestLog, startMeteringProxy, type MeteringProxy } from '../../eval/runner/harness-metering-proxy.ts';
import { createMeteredTestCell, type MeteredTestCell } from '../../eval/runner/metering-proxy-testkit.ts';
import { COMPAT_PROVIDERS, ParticleCreditExhausted } from '../../eval/runner/providers/openai-compatible.ts';
import type { UsageReceipt } from '../../eval/runner/usage-receipt.ts';
import { callModel, modelCaller, type Bench } from '../../eval/workload-suites/bench-infra.ts';
import { answerOne, maxTokensFor, pool, readerPrompt, score } from '../../eval/workload-suites/bench.ts';
import { SUITES, runSuite } from '../../eval/workload-suites/cli.ts';
import { MODEL_CONFIG, ROUTED_PROVIDERS, modelRuleViolations, workloadModelsNotRun } from '../../eval/workload-suites/run-config.ts';

const ROOT = resolve(import.meta.dir, '../..');
const NULL_META = { metadata: null, weight_version: null, service_tier: null, system_fingerprint: null, non_default_tier: null, truncated: null };
const SENT = { effort_sent: 'high', effort_effective: 'high', output_limit_field: 'max_completion_tokens', output_limit: 16_000, temperature_sent: null, seed_sent: null };

let fake: ReturnType<typeof Bun.spawn>;
let fakeRoot = '';
const fakeLog = join(mkdtempSync(join(tmpdir(), 'wl-fake-particle-')), 'log.jsonl');
const fakeLines = () => (existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) : []);
const faults = async (list: unknown[]) => { await fetch(`${fakeRoot}/__fake/particle/faults`, { method: 'POST', body: JSON.stringify({ faults: list }), keepalive: false }); };

beforeAll(async () => {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port as number;
  probe.stop(true);
  fake = Bun.spawn(['python3', 'eval/systems/_shim/fake_provider.py', '--port', String(port), '--log', fakeLog], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
  fakeRoot = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) { try { await fetch(`${fakeRoot}/particle/v1/models`, { keepalive: false }); return; } catch { await Bun.sleep(50); } }
  fake.kill();
  throw new Error(`fake provider never answered on port ${port}: ${await new Response(fake.stderr as ReadableStream).text()}`);
}, 20_000);
afterAll(() => fake?.kill());

const proxies: MeteringProxy[] = [];
const cells: MeteredTestCell[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await faults([]);
  for (const p of proxies.splice(0)) await p.close();
  for (const c of cells.splice(0)) await c.close();
  closeLedgers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workload bench's proxy (its four labels) on a fresh ledger, with Particle pointed at the fake provider. */
async function particleBench(budgetUsd = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'wl-particle-')); dirs.push(dir);
  const ledgerPath = join(dir, 'ledger.sqlite');
  initLedger({ ledgerPath, programCapUsd: 10, reason: 'workload particle test' });
  const run = BudgetRun.open({ runner: 'workload-particle-test', budgetUsd, ledgerPath });
  const log = join(dir, 'proxy', 'requests.jsonl');
  const bodies = join(dir, 'proxy', 'bodies');
  const proxy = await startMeteringProxy({
    run, cellId: 'workload-particle-test', requestLogPath: log, bodiesDir: bodies, labels: ['gbrain', 'comparator', 'reader', 'judge'],
    upstreams: { particle: `${fakeRoot}/particle` }, realKeys: { PARTICLE_API_KEY: 'pk-placeholder-particle' },
  });
  proxies.push(proxy);
  const attempts = () => (existsSync(join(dir, 'attempts.ndjson')) ? readFileSync(join(dir, 'attempts.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as UsageReceipt) : []);
  return { dir, ledgerPath, run, proxy, log: () => (existsSync(log) ? readRequestLog(log, bodies) : []), bodies, attempts, model: modelCaller(proxy, dir) };
}

const passing = SUITES['passing-details'].generate({ seed: SUITES['passing-details'].defaultSeed, smoke: true });

describe('a workload-suite question read by particle-1', () => {
  test('goes through the harness proxy under its own prefix and model, is charged to particle, and leaves one receipt with bar 2\'s fields', async () => {
    const b = await particleBench();
    const q = passing.queries[0]!;
    const context = passing.documents.filter(d => d.user_id === q.user_id).slice(0, 2).map(d => d.content).join('\n\n');
    const prompt = readerPrompt(q, context);
    const tag = `passing-details/gbrain-raw/reader/${q.id}`;
    const before = fakeLines().length;
    const reply = await b.model('particle:particle-1', prompt, { tag, maxTokens: maxTokensFor('particle:particle-1') });
    expect(reply).toEqual({ text: 'ok', input_tokens: expect.any(Number), output_tokens: expect.any(Number), cached: false, model: 'particle:particle-1', finish_reason: 'stop', truncated: false });

    const [line, ...rest] = b.log();
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ label: 'reader', tag, provider: 'particle', model: 'particle-1', kind: 'chat', method: 'POST', path: '/v1/chat/completions', status: 200, refused: false, settlement: 'reconciled', response_model: 'particle-ai/particle-1' });
    expect(line!.reasoning_tokens).toBeGreaterThan(0);
    expect(line!.response_meta).toMatchObject({ weight_version: 'default', service_tier: 'default', non_default_tier: false, truncated: false });
    expect(line!.request).toEqual({ effort_sent: 'high', effort_effective: 'high', effort_effective_source: 'docs.particle.ai and GET /v1/models, checked 2026-10-31', output_limit_field: 'max_completion_tokens', output_limit: 16_000 });
    expect(JSON.parse(readFileSync(join(b.bodies, `${line!.body_sha256}.json`), 'utf8'))).toEqual({ model: 'particle-1', messages: [{ role: 'user', content: prompt }], reasoning_effort: 'high', max_completion_tokens: 16_000 });
    expect(Object.keys(b.proxy.stats().byProvider)).toEqual(['particle']);

    const sent = fakeLines().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ route: 'chat', path: '/particle/v1/chat/completions', model: 'particle-1', effort: 'high', max_completion_tokens: 16_000, auth_present: true });

    const [attempt, ...more] = b.attempts();
    expect(more).toEqual([]);
    expect(attempt).toMatchObject({
      schema: 'usage-receipt/v1', lane: 'workload-suites', role: 'reader', question_id: tag, replicate: 0, attempt: 0, model: 'particle:particle-1',
      response_model: 'particle-ai/particle-1', status: 'ok', error: null, from_cache: false, finish: 'stop', finish_raw: 'stop', answer: 'ok', request: SENT,
    });
    expect(attempt!.response_meta).toMatchObject({ weight_version: 'default', service_tier: 'default', system_fingerprint: 'fp_fake_particle' });
    expect(attempt!.usage!.reasoning).toBe(line!.reasoning_tokens);
    const { input_total, cache_read, output_total } = attempt!.usage!;
    expect(line!.actual_usd).toBeCloseTo(((input_total - cache_read!) * 0.25 + cache_read! * 0.03 + output_total * 1.0) / 1e6, 12);
    expect(ledgerStatus({ ledgerPath: b.ledgerPath, runId: b.run.runId }).run!.committed_usd).toBeCloseTo(line!.actual_usd!, 12);

    const again = await b.model('particle:particle-1', prompt, { tag, maxTokens: maxTokensFor('particle:particle-1') });
    expect(again).toMatchObject({ text: 'ok', cached: true });
    expect(b.log()).toHaveLength(1);
    expect(b.attempts()).toHaveLength(1);
  });

  test('429 with Retry-After, 429, then 200: three receipts and three log lines, failed attempts with null response fields', async () => {
    const b = await particleBench();
    await faults([{ status: 429, retry_after: '0' }, { status: 429, retry_after: '0' }]);
    const reply = await b.model('particle:particle-1', 'Answer: ?', { tag: 'beliefs/gbrain-combined/reader/q-retry', maxTokens: maxTokensFor('particle:particle-1') });
    expect(reply).toMatchObject({ text: 'ok', cached: false });
    const receipts = b.attempts();
    expect(receipts.map(r => [r.attempt, r.status])).toEqual([[0, 'error'], [1, 'error'], [2, 'ok']]);
    for (const failed of receipts.slice(0, 2)) {
      expect(failed).toMatchObject({ response_model: null, finish: null, usage: null, usage_raw: null, answer: '', request: SENT, response_meta: NULL_META });
      expect(failed.error).toContain('particle 429');
      expect(failed.error).toContain('retrying in 0 ms (Retry-After)');
    }
    expect(receipts[2]).toMatchObject({ response_model: 'particle-ai/particle-1', request: SENT });
    const lines = b.log();
    expect(lines.map(l => [l.status, l.settlement])).toEqual([[429, 'rejected-unbilled'], [429, 'rejected-unbilled'], [200, 'reconciled']]);
    for (const l of lines.slice(0, 2)) expect(l).toMatchObject({ response_model: null, reasoning_tokens: null, response_meta: NULL_META, request: { effort_sent: 'high', output_limit: 16_000 } });
  });

  test('a Particle credit 402 writes its receipt, then stops every later reader and judge call without sending', async () => {
    const b = await particleBench();
    await faults([{ status: 402, body: 'balance empty, not the documented body' }]);
    const before = fakeLines().length;
    const error = await b.model('particle:particle-1', 'Answer: ?', { tag: 'beliefs/gbrain-combined/reader/q-credit', maxTokens: 16_000 }).catch(e => e);
    expect(error).toBeInstanceOf(ParticleCreditExhausted);
    expect(error).toMatchObject({ name: 'BudgetExceededError', status: 402 });
    expect(error.message).toStartWith('budget: Particle credit exhausted');
    const [receipt] = b.attempts();
    expect(receipt).toMatchObject({ status: 'error', response_model: null, usage: null, request: SENT, response_meta: NULL_META });
    expect(receipt!.error).toStartWith('budget: Particle credit exhausted');
    expect(b.log()).toHaveLength(1);
    expect(b.log()[0]).toMatchObject({ status: 402, refused: false, response_model: null });

    await expect(b.model('particle:particle-1', 'Another question', { tag: 'beliefs/gbrain-combined/reader/q-next', maxTokens: 16_000 })).rejects.toBeInstanceOf(ParticleCreditExhausted);
    await expect(b.model('openai:gpt-6.1-sol', 'Grade it', { tag: 'beliefs/gbrain-combined/judge/q-credit', maxTokens: 2000 })).rejects.toBeInstanceOf(ParticleCreditExhausted);
    expect(fakeLines().length - before).toBe(1);
    expect(b.log()).toHaveLength(1);
    expect(b.attempts()).toHaveLength(1);
  });

  test('the sweep pool lets calls in flight finish before it throws the first error, and starts no call after it', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let settled = false;
    const run = pool([1, 2, 3, 4, 5, 6], 3, async n => {
      started.push(n);
      if (n === 1) throw new Error('credit stop');
      await gate;
      finished.push(n);
    }).finally(() => { settled = true; });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    release();
    expect(await run.catch(e => e)).toMatchObject({ message: 'credit stop' });
    expect(started).toEqual([1, 2, 3]);
    expect(finished).toEqual([2, 3]);
  });

  test('a proxy budget refusal stays a budget refusal: an error reply, no credit stop, nothing sent', async () => {
    const b = await particleBench(0.01);
    const before = fakeLines().length;
    const reply = await b.model('particle:particle-1', 'Answer: ?', { tag: 'beliefs/gbrain-combined/reader/q-cap', maxTokens: 16_000 });
    expect(reply.error).toStartWith('budget refused: ');
    expect(reply.error).toContain('mpw_budget_refused');
    expect(b.proxy.exhausted).toBe(true);
    expect(fakeLines().length).toBe(before);
    expect(b.attempts()).toEqual([expect.objectContaining({ status: 'error', request: SENT, response_meta: NULL_META })]);
    expect(b.log()).toEqual([expect.objectContaining({ refused: true, status: 402, response_model: null })]);
    expect((await b.model('particle:particle-1', 'Next', { tag: 'beliefs/gbrain-combined/reader/q-cap2', maxTokens: 16_000 })).error).toStartWith('budget refused: ');
  });

  test('a streamed answer through the proxy logs its response model, reasoning tokens and metadata', async () => {
    const b = await particleBench();
    const env = b.proxy.envFor('reader');
    const res = await fetch(`${env.PARTICLE_BASE_URL}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.PARTICLE_API_KEY}` },
      body: JSON.stringify({ model: 'particle-1', messages: [{ role: 'user', content: 'q' }], reasoning_effort: 'high', max_completion_tokens: 16_000, stream: true }),
    });
    expect(res.headers.get('content-type')).toContain('event-stream');
    await res.text();
    await b.proxy.close();
    const [line] = b.log();
    expect(line).toMatchObject({ stream: true, status: 200, settlement: 'reconciled', response_model: 'particle-ai/particle-1' });
    expect(line!.reasoning_tokens).toBeGreaterThan(0);
    expect(line!.response_meta).toMatchObject({ weight_version: 'default', service_tier: 'default', truncated: false });
  });

  test('a particle request that outlasts its deadline leaves one receipt and is never sent again', async () => {
    let hits = 0;
    const slow = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() { hits++; await Bun.sleep(1500); return Response.json({}); } });
    try {
      const seen: UsageReceipt[] = [];
      const env = { PARTICLE_BASE_URL: `http://127.0.0.1:${slow.port}/particle/v1`, PARTICLE_API_KEY: 'pk-placeholder-particle' };
      const reply = await callModel(env, 'particle:particle-1', 'Q?', 'beliefs/gbrain-combined/reader/q-slow', 16_000, r => seen.push(r), 200);
      expect(reply.error).toStartWith('network: ');
      expect(hits).toBe(1);
      expect(seen.map(r => r.status)).toEqual(['error']);
    } finally { slow.stop(true); }
  });

  test('a cached particle answer is keyed on the effort it was read at', async () => {
    const b = await particleBench();
    const ask = () => b.model('particle:particle-1', 'Answer: cached?', { tag: 'beliefs/gbrain-combined/reader/q-cache', maxTokens: 16_000 });
    expect((await ask()).cached).toBe(false);
    expect((await ask()).cached).toBe(true);
    const row = COMPAT_PROVIDERS.particle.models['particle-1'] as { default_effort: string };
    const was = row.default_effort;
    row.default_effort = 'medium';
    try { expect((await ask()).cached).toBe(false); } finally { row.default_effort = was; }
  });

  test('an answer cut off at its output limit is the model\'s answer: scored as is, recorded as truncated with its finish reason, counted per arm and never asked again', async () => {
    const b = await particleBench();
    const cutOff = { id: 'chatcmpl-cut', object: 'chat.completion', model: 'particle-ai/particle-1', service_tier: 'default', choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'Answer: the code you set is' } }], usage: { prompt_tokens: 700, completion_tokens: 16_000, total_tokens: 16_700, completion_tokens_details: { reasoning_tokens: 15_990 } } };
    await faults([{ status: 200, body: JSON.stringify(cutOff) }]);
    const q = passing.queries[0]!;
    const context = passing.documents.filter(d => d.user_id === q.user_id).slice(0, 2).map(d => d.content).join('\n\n');
    const bench = { model: b.model } as unknown as Bench;
    const before = fakeLines().length;
    const answered = await answerOne(bench, passing, b.dir, 'gbrain-raw', 'particle:particle-1', q, context, null, []);
    expect(answered).toMatchObject({ answer_raw: 'Answer: the code you set is', error: null, finish_reason: 'length', truncated: true });
    expect(await answerOne(bench, passing, b.dir, 'gbrain-raw', 'particle:particle-1', q, context, null, [])).toEqual(answered);
    expect(fakeLines().length - before).toBe(1);
    expect(b.attempts().map(a => [a.status, a.finish, a.finish_raw])).toEqual([['ok', 'max_tokens', 'length']]);

    await score(null, passing, b.dir, () => {});
    const result = JSON.parse(readFileSync(join(b.dir, 'results.json'), 'utf8')).results['gbrain-raw']['particle:particle-1'];
    expect(result).toMatchObject({ n: 1, correct: 0, truncated: 1 });
    expect(result.rows).toEqual([expect.objectContaining({ query_id: q.id, correct: false, truncated: true, finish_reason: 'length' })]);
    expect(result.rows[0].outcome).not.toBe('error');
  });

  test('a reply or answer recorded before finish reasons were kept reads as unknown, so its arm\'s truncation count is unknown, not zero', async () => {
    const b = await particleBench();
    const q = passing.queries[0]!;
    const opts = { tag: `passing-details/gbrain-raw/reader/${q.id}`, maxTokens: maxTokensFor('particle:particle-1') };
    expect(await b.model('particle:particle-1', 'Q legacy?', opts)).toMatchObject({ finish_reason: 'stop', truncated: false });
    const cacheDir = join(b.dir, 'model-cache');
    for (const f of readdirSync(cacheDir)) {
      const { finish_reason, truncated, ...legacy } = JSON.parse(readFileSync(join(cacheDir, f), 'utf8'));
      writeFileSync(join(cacheDir, f), JSON.stringify(legacy));
    }
    expect(await b.model('particle:particle-1', 'Q legacy?', opts)).toMatchObject({ cached: true, finish_reason: null, truncated: null });

    const bench = { model: b.model } as unknown as Bench;
    const context = passing.documents.filter(d => d.user_id === q.user_id).slice(0, 2).map(d => d.content).join('\n\n');
    await answerOne(bench, passing, b.dir, 'gbrain-raw', 'particle:particle-1', q, context, null, []);
    const receiptFile = join(b.dir, 'answers', 'gbrain-raw', 'particle_particle-1', `${q.id}.json`);
    const { finish_reason, truncated, ...legacy } = JSON.parse(readFileSync(receiptFile, 'utf8'));
    expect([finish_reason, truncated]).toEqual(['stop', false]);
    writeFileSync(receiptFile, JSON.stringify(legacy));
    await score(null, passing, b.dir, () => {});
    const result = JSON.parse(readFileSync(join(b.dir, 'results.json'), 'utf8')).results['gbrain-raw']['particle:particle-1'];
    expect(result.truncated).toBeNull();
    expect(result.rows[0]).toMatchObject({ truncated: null, finish_reason: null });
  });

  test('a smoke-only reader\'s answers are scored only when the scoring run is a labeled smoke run', async () => {
    const b = await particleBench();
    const q = passing.queries[0]!;
    const context = passing.documents.filter(d => d.user_id === q.user_id).slice(0, 2).map(d => d.content).join('\n\n');
    const particle = await answerOne({ model: b.model } as unknown as Bench, passing, b.dir, 'gbrain-raw', 'particle:particle-1', q, context, null, []);
    const fable = 'anthropic:claude-fable-5-1';
    mkdirSync(join(b.dir, 'answers', 'gbrain-raw', 'anthropic_claude-fable-5-1'), { recursive: true });
    writeFileSync(join(b.dir, 'answers', 'gbrain-raw', 'anthropic_claude-fable-5-1', `${q.id}.json`), JSON.stringify({ ...particle, model: fable }));
    const scored = async (smokeRun: boolean) => { await score(null, passing, b.dir, () => {}, smokeRun); return Object.keys(JSON.parse(readFileSync(join(b.dir, 'results.json'), 'utf8')).results['gbrain-raw']); };
    expect(await scored(false)).toEqual(['particle:particle-1']);
    expect(await scored(true)).toEqual(['particle:particle-1', fable]);
  });
});

describe('the existing reader routes', () => {
  test('OpenAI and Anthropic request bodies are byte-identical to main\'s, and each attempt leaves a receipt', async () => {
    const c = await createMeteredTestCell({ labels: ['reader', 'judge'] });
    cells.push(c);
    const env = c.proxy.envFor('reader');
    const seen: UsageReceipt[] = [];
    const tag = 'beliefs/gbrain-combined/reader/q1';
    const anthropic = await callModel(env, 'anthropic:claude-sonnet-5-5', 'Q? "quoted" \u00e9', tag, 400, r => seen.push(r));
    const openai = await callModel(env, 'openai:gpt-6.1-sol', 'Q? "quoted" \u00e9', tag, 4000, r => seen.push(r));
    expect(anthropic.error).toBeUndefined();
    expect(openai.error).toBeUndefined();
    const lines = c.log();
    expect(lines.map(l => [l.provider, l.tag])).toEqual([['anthropic', tag], ['openai', tag]]);
    expect(lines.map(l => readFileSync(join(c.bodiesDir, `${l.body_sha256}.json`), 'utf8'))).toEqual([
      '{"model":"claude-sonnet-5-5","max_tokens":400,"messages":[{"role":"user","content":"Q? \\"quoted\\" \u00e9"}]}',
      '{"model":"gpt-6.1-sol","max_completion_tokens":4000,"reasoning_effort":"low","messages":[{"role":"user","content":"Q? \\"quoted\\" \u00e9"}]}',
    ]);
    expect(c.stub.requests[0]!.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(seen.map(r => [r.model, r.status, r.attempt, r.role, r.question_id])).toEqual([['anthropic:claude-sonnet-5-5', 'ok', 0, 'reader', tag], ['openai:gpt-6.1-sol', 'ok', 0, 'reader', tag]]);
    expect(seen[0]!.usage).toMatchObject({ convention: 'anthropic' });
    expect(seen[1]!.usage).toMatchObject({ convention: 'openai-chat' });
    for (const r of seen) expect('request' in r || 'response_meta' in r).toBe(false);
    expect(await callModel(env, 'gemini:gemini-3.8-flash', 'Q?', tag, 400, r => seen.push(r))).toMatchObject({ error: 'unsupported reader provider gemini' });
    expect(seen).toHaveLength(2);
  });

  test('an Anthropic or OpenAI reply cut off at its output limit is marked truncated with its finish reason, not as an error', async () => {
    const c = await createMeteredTestCell({ labels: ['reader', 'judge'] });
    cells.push(c);
    const env = c.proxy.envFor('reader');
    const usage = { input_tokens: 10, output_tokens: 400 };
    c.stub.respond('anthropic.messages', () => ({ status: 200, body: { id: 'msg_cut', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Answer: the' }], stop_reason: 'max_tokens', stop_sequence: null, usage } }));
    c.stub.respond('openai.chat', () => ({ status: 200, body: { id: 'chatcmpl-cut', object: 'chat.completion', model: 'gpt-6.1-sol', choices: [{ index: 0, message: { role: 'assistant', content: 'Answer: the' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 4000, total_tokens: 4010 } } }));
    const tag = 'beliefs/gbrain-combined/reader/q-cut';
    expect(await callModel(env, 'anthropic:claude-sonnet-5-5', 'Q?', tag, 400)).toMatchObject({ text: 'Answer: the', finish_reason: 'max_tokens', truncated: true });
    expect(await callModel(env, 'openai:gpt-6.1-sol', 'Q?', tag, 4000)).toMatchObject({ text: 'Answer: the', finish_reason: 'length', truncated: true });
    c.stub.respond('anthropic.messages', null);
    expect(await callModel(env, 'anthropic:claude-sonnet-5-5', 'Q2?', tag, 400)).toMatchObject({ finish_reason: 'end_turn', truncated: false });
  });

  test('a receipt that cannot be written stops the call; the answered request is never sent again', async () => {
    const c = await createMeteredTestCell({ labels: ['reader', 'judge'] });
    cells.push(c);
    const env = c.proxy.envFor('reader');
    const failsOnce = () => {
      let failed = false;
      return (r: UsageReceipt) => { if (r.status === 'ok' && !failed) { failed = true; throw new Error('ENOSPC: receipt not written'); } };
    };
    for (const model of ['anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol']) {
      expect(await callModel(env, model, 'Q?', 'beliefs/gbrain-combined/reader/q-disk', 400, failsOnce()).catch(e => e)).toMatchObject({ message: 'ENOSPC: receipt not written' });
    }
    expect(c.stub.requests).toHaveLength(2);
    const b = await particleBench();
    const before = fakeLines().length;
    expect(await callModel(b.proxy.envFor('reader'), 'particle:particle-1', 'Q?', 'beliefs/gbrain-combined/reader/q-disk', 16_000, failsOnce()).catch(e => e)).toMatchObject({ message: 'ENOSPC: receipt not written' });
    expect(fakeLines().length - before).toBe(1);
  });

  test('the reader output limit: particle-1 gets its 16,000-token floor, OpenAI 4,000, Anthropic the shared 400', () => {
    expect(maxTokensFor('particle:particle-1')).toBe(16_000);
    expect(maxTokensFor('openai:gpt-6.1-sol')).toBe(4000);
    expect(maxTokensFor('anthropic:claude-sonnet-5-5')).toBe(MODEL_CONFIG.reader.max_output_tokens);
  });
});

describe('the run config', () => {
  test('particle-1 joins the frontier sweep as its own family, never as the judge, and models_not_run lists a primary model with no route', async () => {
    expect(MODEL_CONFIG.frontier_sweep).toContainEqual({ id: 'particle:particle-1', family: 'particle' });
    expect(modelRuleViolations()).toEqual([]);
    expect(modelRuleViolations({ ...MODEL_CONFIG, judge: { id: 'particle:particle-1', family: 'particle' } })).toEqual(['particle:particle-1 never judges a counted cell']);
    expect(ROUTED_PROVIDERS).toEqual(['anthropic', 'openai', 'particle']);
    expect(MODEL_CONFIG.models_not_run).toEqual([]);
    expect(workloadModelsNotRun(['anthropic', 'openai'])).toEqual([{ model: 'particle:particle-1', reason: 'workload-suites has no particle: route' }]);
    const out = mkdtempSync(join(tmpdir(), 'wl-check-')); dirs.push(out);
    await runSuite(SUITES.beliefs, { smoke: true, output: out });
    expect(JSON.parse(readFileSync(join(out, 'check-receipt.json'), 'utf8')).models.models_not_run).toEqual([]);
  });
});
