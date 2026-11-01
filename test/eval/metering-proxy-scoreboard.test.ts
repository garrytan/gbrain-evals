/**
 * Scoreboard metering in the lease proxy (eval/runner/metering-proxy.ts):
 * the cell token on provider routes, stable per-request attribution with an
 * unattributed-background bucket and phase labels, per-route output caps,
 * billed against reserved-unsettled dollars, shared admission control
 * (requests per minute, tokens per minute, concurrency, retry-after) and 429
 * as upstream trouble. Keyless: every upstream is a fake and every key a
 * placeholder.
 */
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers, ledgerStatus } from '../../eval/runner/budget-ledger.ts';
import { AdmissionController, AdmissionRefused, DEFAULT_ROUTE_CAPS, requestResetMs, isLocalAddress, MeteringProxy, parseAdmission, parseProxyArgs, ProxyControl, retryAfterMs, upstreamTrouble, usageSplit,
  type LeasePolicy, type UsageLine } from '../../eval/runner/metering-proxy.ts';

const tmp = mkdtempSync(join(tmpdir(), 'metering-proxy-scoreboard-'));
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); });
const FAKE_ENV = { OPENAI_API_KEY: 'placeholder-openai', ANTHROPIC_API_KEY: 'placeholder-anthropic', VOYAGE_API_KEY: 'placeholder-voyage' };
let n = 0;
const ledgerFile = () => join(tmp, `lease-${++n}.sqlite`);
const chat = (extra: Record<string, unknown> = {}) => ({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hello there' }], ...extra });

function upstream(respond: (body: any, headers: Headers) => Response | Promise<Response> = () => Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5 } })) {
  const seen: Array<{ url: string; headers: Headers; body: any }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const s = { url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(s);
    return respond(s.body, s.headers);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

function start(fetchImpl: typeof fetch, extra: Partial<LeasePolicy> = {}, opts: { cellToken?: string; trustLocal?: boolean; controlToken?: string } = {}) {
  const lease = BudgetRun.openLease({ runId: `lease-${n + 1}`, leaseUsd: 1, ledgerPath: ledgerFile() });
  const usageLog = join(tmp, `usage-${n}.ndjson`);
  const proxy = new MeteringProxy({ fetchImpl, policy: { lease, env: FAKE_ENV, usageLog, ...extra }, ...opts });
  proxy.start();
  const base = `http://127.0.0.1:${proxy.port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const lines = () => readFileSync(usageLog, 'utf8').trim().split('\n').map(l => JSON.parse(l) as UsageLine);
  return { proxy, base, post, lines, lease, usageLog };
}

describe('cell token', () => {
  beforeEach(() => closeLedgers());
  test('a provider request without the cell token is refused before it reaches the provider; the token as key, header or path prefix is accepted', async () => {
    const up = upstream();
    const { proxy, post, lines } = start(up.fetchImpl, {}, { cellToken: 'cell-token-123' });
    try {
      const refused = await post('/c/openai/v1/chat/completions', chat(), { authorization: 'Bearer sk-dummy-metering-proxy-injects-the-real-key' });
      expect(refused.status).toBe(401);
      expect((await refused.json() as any).error.message).toContain("this cell's token");
      expect((await post('/_t/wrong/c/openai/v1/chat/completions', chat())).status).toBe(401);
      expect(up.seen).toHaveLength(0);
      expect((await post('/c/openai/v1/chat/completions', chat(), { authorization: 'Bearer cell-token-123' })).status).toBe(200);
      expect((await post('/c/openai/v1/chat/completions', chat(), { 'x-proxy-cell': 'cell-token-123' })).status).toBe(200);
      expect((await post('/_t/cell-token-123/c/openai/v1/chat/completions', chat())).status).toBe(200);
      expect((await post('/c/anthropic/v1/messages', { model: 'claude-sonnet-5-5', max_tokens: 5, messages: [] }, { 'x-api-key': 'cell-token-123' })).status).toBe(200);
      expect(up.seen).toHaveLength(4);
      expect(up.seen.every(s => s.headers.get('x-proxy-cell') === null && !String(s.headers.get('authorization') ?? s.headers.get('x-api-key')).includes('cell-token'))).toBe(true);
      expect(proxy.status().unauthorized).toBe(2);
      expect(lines().filter(l => l.status === 401)).toHaveLength(2);
    } finally { proxy.stop(); }
  });

  test('trust-local admits this machine only: loopback and Docker bridges, never a public or other private address', async () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.17.0.2', '172.31.255.1', '::ffff:172.18.0.5']) expect(isLocalAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '10.0.0.5', '192.168.1.4', '172.32.0.1', '172.15.0.1', '2001:db8::1', '', null]) expect(isLocalAddress(a)).toBe(false);
    const up = upstream();
    const { proxy, post } = start(up.fetchImpl, {}, { cellToken: 'tok', trustLocal: true });
    try { expect((await post('/c/openai/v1/chat/completions', chat())).status).toBe(200); } finally { proxy.stop(); }
  });

  test('without a cell token the proxy behaves as before', async () => {
    const up = upstream();
    const { proxy, post } = start(up.fetchImpl);
    try { expect((await post('/c/openai/v1/chat/completions', chat())).status).toBe(200); } finally { proxy.stop(); }
  });

  test('the CLI reads --cell-token (or SHOOTOUT_CELL_TOKEN), --trust-local, --route-caps and --admission', () => {
    const a = parseProxyArgs(['--budget-ledger', 'x', '--lease-usd', '1', '--run-id', 'r', '--cell-token', 't', '--trust-local', '--route-caps', 'extraction=4096,reader=2048,judge=1024',
      '--route-class', 'harness=reader,judge=judge', '--admission', 'openai=rpm:500,tpm:2000000,concurrency:16', '--admission', 'anthropic=concurrency:4']);
    expect(a).toMatchObject({ cellToken: 't', trustLocal: true, routeCaps: { caps: { extraction: 4096, reader: 2048, judge: 1024 }, slots: { harness: 'reader', judge: 'judge' }, defaultClass: 'extraction' },
      admission: { openai: { rpm: 500, tpm: 2_000_000, concurrency: 16 }, anthropic: { concurrency: 4 } } });
    expect(() => parseProxyArgs(['--budget-ledger', 'x', '--lease-usd', '1', '--run-id', 'r', '--route-caps', 'reader=2048', '--route-class', 'harness=judge'])).toThrow(/no cap/);
    expect(() => parseAdmission(['openai=rpm:-1'])).toThrow(/positive whole number/);
  });
});

describe('attribution', () => {
  beforeEach(() => closeLedgers());
  test('every request has a stable id, its slot, the bound brain and phase, and a bucket; unbound system calls land in the unattributed-background bucket', async () => {
    const up = upstream();
    const { proxy, post, lines } = start(up.fetchImpl, {}, { controlToken: 'ctl' });
    try {
      const ctl = new ProxyControl(`http://127.0.0.1:${proxy.port}`, 'ctl');
      await ctl.bind('ext-extract-first', 'ingest:ns-a', { brain: 'ns-a', phase: 'commit' });
      const r1 = await post('/ext-extract-first/openai/v1/chat/completions', chat());
      expect(r1.headers.get('x-proxy-request-id')).toBe(`lease-${n}-1`);
      await ctl.bind('ext-extract-first', 'ingest:ns-a', { brain: 'ns-a', phase: 'background' });
      await post('/ext-extract-first/openai/v1/chat/completions', chat());
      await ctl.unbind('ext-extract-first');
      await ctl.phase('ext-extract-first', 'background');
      await post('/ext-extract-first/openai/v1/chat/completions', chat());
      await post('/harness/openai/v1/chat/completions', chat());
      const meter = await ctl.finalize('ingest:ns-a');
      expect(meter.requests).toBe(2);
      const ls = lines();
      expect(ls.map(l => [l.request_id, l.slot, l.brain, l.phase, l.bucket])).toEqual([
        [`lease-${n}-1`, 'ext-extract-first', 'ns-a', 'commit', 'attributed'],
        [`lease-${n}-2`, 'ext-extract-first', 'ns-a', 'background', 'attributed'],
        [`lease-${n}-3`, 'ext-extract-first', null, 'background', 'unattributed-background'],
        [`lease-${n}-4`, 'harness', null, null, 'harness'],
      ]);
      expect(proxy.status().unattributed_background as unknown).toEqual({ 'ext-extract-first': { usd: ls[2].actual_usd, requests: 1 } });
      expect((await fetch(`http://127.0.0.1:${proxy.port}/__proxy/phase`, { method: 'POST', body: JSON.stringify({ slot: 'x', phase: 'nap' }), headers: { 'x-proxy-control': 'ctl' } })).status).toBe(400);
    } finally { proxy.stop(); }
  });
});

describe('route output caps and billed versus reserved dollars', () => {
  beforeEach(() => closeLedgers());
  test('harness slots get their route class cap (injected when absent, refused when exceeded); a system slot is never rewritten or refused', async () => {
    const up = upstream();
    const { proxy, post, lines } = start(up.fetchImpl, { routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { harness: 'reader', judge: 'judge' }, defaultClass: 'extraction' } });
    try {
      await post('/ext-memory-bank/openai/v1/chat/completions', chat());
      await post('/harness/openai/v1/chat/completions', chat());
      await post('/judge/openai/v1/chat/completions', chat());
      expect(up.seen.map(s => s.body.max_completion_tokens)).toEqual([undefined, 2048, 2048]);
      const big = await post('/ext-memory-bank/openai/v1/chat/completions', chat({ max_completion_tokens: 64000 }));
      expect(big.status).toBe(200);
      expect(up.seen[3].body.max_completion_tokens).toBe(64000);
      // A19: a reasoning-model judge (gpt-6.1-sol) states 2,000 output tokens; the judge route admits it unchanged.
      const sol = await post('/judge/openai/v1/chat/completions', chat({ max_completion_tokens: 2000 }));
      expect(sol.status).toBe(200);
      expect(up.seen[4].body.max_completion_tokens).toBe(2000);
      const over = await post('/judge/openai/v1/chat/completions', chat({ max_completion_tokens: 2049 }));
      expect(over.status).toBe(400);
      expect((await over.json() as any).error.message).toContain('judge route cap of 2048');
      expect(lines().slice(0, 3).map(l => [l.route_class, l.output_cap])).toEqual([['extraction', 4096], ['reader', 2048], ['judge', 2048]]);
    } finally { proxy.stop(); }
  });

  test('the agent slot (the file agent\'s loop) takes its stated per-turn allowance up to the agent cap, not the reader cap', async () => {
    const up = upstream();
    const { proxy, post } = start(up.fetchImpl, { routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { harness: 'reader', judge: 'judge', agent: 'agent' }, defaultClass: 'extraction' } });
    try {
      expect((await post('/agent/openai/v1/chat/completions', chat({ max_completion_tokens: 16000 }))).status).toBe(200);
      expect((await post('/harness/openai/v1/chat/completions', chat({ max_completion_tokens: 16000 }))).status).toBe(400);
      expect((await post('/agent/openai/v1/chat/completions', chat({ max_completion_tokens: 16001 }))).status).toBe(400);
      expect(up.seen.map(s => s.body.max_completion_tokens)).toEqual([16000]);
    } finally { proxy.stop(); }
  });

  test('a 5xx keeps its reservation as reserved-unsettled, apart from billed usage; the summary splits them', async () => {
    let fail = false;
    const up = upstream(() => fail ? Response.json({ error: 'down' }, { status: 502 }) : Response.json({ usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    const { proxy, post, usageLog, lease } = start(up.fetchImpl, { routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: {}, defaultClass: 'extraction' } });
    try {
      await post('/s/openai/v1/chat/completions', chat());
      fail = true;
      await post('/s/openai/v1/chat/completions', chat());
      const st = proxy.status();
      expect(st.billed_usd).toBeCloseTo((100 * 0.4 + 10 * 1.6) / 1e6, 12);
      expect(st.reserved_unsettled_usd).toBeGreaterThan(0);
      const committed = ledgerStatus({ ledgerPath: lease.ledgerPath, runId: lease.runId }).run!.committed_usd;
      expect(st.billed_usd! + st.reserved_unsettled_usd!).toBeCloseTo(committed, 10);
      const split = usageSplit(usageLog);
      expect(split.billed_usd).toBeCloseTo(st.billed_usd!, 12);
      expect(split.reserved_unsettled_usd).toBeCloseTo(st.reserved_unsettled_usd!, 12);
      expect(split.unattributed_background_usd).toBeCloseTo(committed, 10);
      const m = proxy.meters.get('slot:s')!;
      expect([m.billed_usd! > 0, m.reserved_unsettled_usd! > 0]).toEqual([true, true]);
      expect(st.reserved_unsettled_usd!).toBeLessThan(4200 * 1.6 / 1e6 + 0.001);
    } finally { proxy.stop(); }
  });
});

describe('admission control', () => {
  test('requests per minute, tokens per minute and concurrency queue requests; a retry-after pauses the provider', async () => {
    let t = 0;
    const ac = new AdmissionController({ openai: { rpm: 2, tpm: 1000, concurrency: 1 } }, { now: () => t, maxWaitMs: 120_000 });
    const a = await ac.acquire('openai', 100);
    expect(ac.waitFor('openai', 100)).toBeGreaterThan(0);
    a.release(100);
    expect(ac.waitFor('openai', 100)).toBe(0);
    const b = await ac.acquire('openai', 100); b.release();
    expect(ac.waitFor('openai', 1)).toBe(60_000);
    t = 60_001;
    expect(ac.waitFor('openai', 1)).toBe(0);
    expect(ac.waitFor('openai', 2000)).toBe(0);
    const c = await ac.acquire('openai', 900); c.release(950);
    expect(ac.waitFor('openai', 100)).toBe(60_000);
    t = 200_000;
    ac.pause('openai', 5000);
    expect(ac.waitFor('openai', 1)).toBe(5000);
    expect(ac.waitFor('anthropic', 1)).toBe(0);
    const strict = new AdmissionController({ openai: { rpm: 1 } }, { now: () => 0, maxWaitMs: 10 });
    (await strict.acquire('openai', 1)).release();
    await expect(strict.acquire('openai', 1)).rejects.toBeInstanceOf(AdmissionRefused);
    expect(strict.stats).toMatchObject({ admitted: 1, refused: 1 });
  });

  test('two cells on one key share one controller: concurrency holds across them, and a 429 with retry-after pauses both', async () => {
    let active = 0, peak = 0, calls = 0;
    const slow = upstream(async () => { active++; peak = Math.max(peak, active); calls++; await Bun.sleep(40); active--;
      return calls === 1 ? new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'retry-after': '0.3', 'content-type': 'application/json' } }) : Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5 } }); });
    const shared = new AdmissionController({ openai: { concurrency: 1 } });
    const one = start(slow.fetchImpl, { admission: shared });
    const two = start(slow.fetchImpl, { admission: shared });
    try {
      const first = await one.post('/a/openai/v1/chat/completions', chat());
      expect(first.status).toBe(429);
      const t0 = performance.now();
      const rs = await Promise.all([one.post('/a/openai/v1/chat/completions', chat()), two.post('/b/openai/v1/chat/completions', chat()), two.post('/b/openai/v1/chat/completions', chat())]);
      expect(rs.map(r => r.status)).toEqual([200, 200, 200]);
      expect(performance.now() - t0).toBeGreaterThan(250);
      expect(peak).toBe(1);
      expect(shared.stats.pauses).toBe(1);
      expect(one.lines()[0].retry_after_ms).toBe(300);
      expect(upstreamTrouble(one.proxy.meters.get('slot:a'))).toBe(true);
    } finally { one.proxy.stop(); two.proxy.stop(); }
  });

  test('a request that cannot be admitted within the wait bound is refused with 429 and a retry-after, before any reservation', async () => {
    const up = upstream();
    const { proxy, post, lease } = start(up.fetchImpl, { admission: new AdmissionController({ openai: { rpm: 1 } }, { maxWaitMs: 50 }) });
    try {
      expect((await post('/s/openai/v1/chat/completions', chat())).status).toBe(200);
      const before = ledgerStatus({ ledgerPath: lease.ledgerPath, runId: lease.runId }).run!.committed_usd;
      const r = await post('/s/openai/v1/chat/completions', chat());
      expect(r.status).toBe(429);
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(up.seen).toHaveLength(1);
      expect(ledgerStatus({ ledgerPath: lease.ledgerPath, runId: lease.runId }).run!.committed_usd).toBe(before);
      expect(new AdmissionRefused('openai', 1500).message).toContain('2 s');
    } finally { proxy.stop(); }
  });

  test('key headroom: a model whose remaining requests on the key fall to 5% waits for the reset the provider names; other models do not (A23)', () => {
    let t = 0;
    const ac = new AdmissionController({}, { now: () => t });
    const low = new Headers({ 'x-ratelimit-limit-requests': '10000', 'x-ratelimit-remaining-requests': '400', 'x-ratelimit-reset-requests': '8s' });
    ac.observe('openai', 'text-embedding-3-large', low);
    expect(ac.waitFor('openai', 1, 'text-embedding-3-large')).toBe(8000);
    expect(ac.waitFor('openai', 1, 'gpt-4.1-mini')).toBe(0);
    t = 8001;
    expect(ac.waitFor('openai', 1, 'text-embedding-3-large')).toBe(0);
    ac.observe('openai', 'text-embedding-3-large', new Headers({ 'x-ratelimit-limit-requests': '10000', 'x-ratelimit-remaining-requests': '501', 'x-ratelimit-reset-requests': '6ms' }));
    expect(ac.waitFor('openai', 1, 'text-embedding-3-large')).toBe(0);
    expect(requestResetMs(new Headers({ 'x-ratelimit-reset-requests': '1m30.5s' }))).toBe(90_500);
    expect(requestResetMs(new Headers({ 'anthropic-ratelimit-requests-reset': new Date(12_000).toISOString() }), 2000)).toBe(10_000);
    expect(requestResetMs(new Headers())).toBeNull();
  });

  test('key headroom through the proxy: the request after a response that reports the key near its limit waits for the reset (A23: RateLimitError on a shared embedding key)', async () => {
    let calls = 0;
    const up = upstream(() => { calls++; return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5 } }, { headers: calls === 1 ? { 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '2', 'x-ratelimit-reset-requests': '400ms' } : {} }); });
    const { proxy, post } = start(up.fetchImpl, { admission: new AdmissionController({}) });
    try {
      expect((await post('/s/openai/v1/chat/completions', chat())).status).toBe(200);
      const t0 = performance.now();
      expect((await post('/s/openai/v1/chat/completions', chat())).status).toBe(200);
      expect(performance.now() - t0).toBeGreaterThan(300);
    } finally { proxy.stop(); }
  });

  test('a connection that closes before the provider answers is sent again, each failed attempt charged at its reservation; a timeout is not (A23)', async () => {
    let calls = 0;
    const closed = Object.assign(new Error('The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'), { code: 'ECONNRESET' });
    const flaky = upstream(() => { if (++calls === 1) throw closed; return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5 } }); });
    const one = start(flaky.fetchImpl);
    try {
      expect((await one.post('/s/openai/v1/chat/completions', chat())).status).toBe(200);
      expect(flaky.seen).toHaveLength(2);
      const lines = one.lines();
      expect(lines.map(l => l.outcome)).toEqual(['failed', 'forwarded']);
      expect(lines[0].reason).toContain('(sent again)');
      expect(lines[0].charged_reservation).toBe(true);
      expect(lines[1].transport_retries).toBe(1);
    } finally { one.proxy.stop(); }
    const slow = upstream(() => { throw new DOMException('The operation timed out.', 'TimeoutError'); });
    const two = start(slow.fetchImpl);
    try {
      expect((await two.post('/s/openai/v1/chat/completions', chat())).status).toBe(504);
      expect(slow.seen).toHaveLength(1);
    } finally { two.proxy.stop(); }
  });

  test('retry hints: retry-after-ms, retry-after seconds and an HTTP date', () => {
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '250' }))).toBe(250);
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }))).toBe(2000);
    expect(retryAfterMs(new Headers({ 'retry-after': new Date(10_000).toUTCString() }), 4000)).toBe(6000);
    expect(retryAfterMs(new Headers())).toBeNull();
  });

  test('a 429 counts as upstream trouble, like a 5xx; a 400 does not', () => {
    expect(upstreamTrouble({ usd: 0, requests: 1, unpriced: 0, byModel: {}, upstream: { statuses: { '429': 1 }, failed: 0, unparseable: 0 } })).toBe(true);
    expect(upstreamTrouble({ usd: 0, requests: 1, unpriced: 0, byModel: {}, upstream: { statuses: { '400': 1 }, failed: 0, unparseable: 0 } })).toBe(false);
  });
});

describe('particle-1 through the lease proxy (plan GST-605 Phase 2)', () => {
  beforeEach(() => closeLedgers());
  const PARTICLE_ENV = { ...FAKE_ENV, PARTICLE_API_KEY: 'placeholder-particle' };
  const harness = { routeCaps: { caps: { ...DEFAULT_ROUTE_CAPS }, slots: { harness: 'reader', judge: 'judge', agent: 'agent' }, defaultClass: 'extraction' }, env: PARTICLE_ENV };
  const particleChat = (extra: Record<string, unknown> = {}) => ({ model: 'particle-1', messages: [{ role: 'user', content: 'hello there' }], reasoning_effort: 'medium', max_completion_tokens: 16000, ...extra });
  const particleReply = () => Response.json({ id: 'chatcmpl-1', model: 'particle-ai/particle-1', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 150 } } });

  // Value: protects=every particle request is metered by the lease that pays for it; fails_when=a particle request is refused as an unknown route, forwarded with the cell's dummy key, or charged to no model; why_new=the lease proxy gains its first OpenAI-compatible upstream; seam=none; no_claim=keyless (a fake upstream), Particle's real billing
  test('a particle chat on a slot goes to api.particle.ai with the proxy\'s key, is priced at particle-1\'s rates and charged to particle; only the listed routes pass', async () => {
    const up = upstream(particleReply);
    const { proxy, post, lines } = start(up.fetchImpl, harness);
    try {
      expect((await post('/harness/particle/v1/chat/completions', particleChat(), { authorization: 'Bearer dummy-key-the-proxy-replaces' })).status).toBe(200);
      expect(up.seen.map(s => [s.url, s.headers.get('authorization')])).toEqual([['https://api.particle.ai/v1/chat/completions', 'Bearer placeholder-particle']]);
      expect((await fetch(`http://127.0.0.1:${proxy.port}/harness/particle/v1/models`)).status).toBe(200);
      expect((await post('/harness/particle/v1/responses', particleChat())).status).toBe(403);
      const forwarded = lines().filter(l => l.outcome === 'forwarded');
      expect(forwarded.map(l => [l.provider, l.slot, l.route, l.model])).toEqual([['particle', 'harness', '/v1/chat/completions', 'particle-1'], ['particle', 'harness', '/v1/models', null]]);
      expect(forwarded[0].actual_usd).toBeCloseTo((1000 * 0.25 + 200 * 1.0) / 1e6, 12);
      expect(proxy.meters.get('slot:harness')!.byModel).toEqual({ 'particle:particle-1': { usd: forwarded[0].actual_usd!, requests: 1 } });
    } finally { proxy.stop(); }
    const keyless = start(upstream(particleReply).fetchImpl, { ...harness, env: FAKE_ENV });
    try {
      const res = await keyless.post('/harness/particle/v1/chat/completions', particleChat());
      expect(res.status).toBe(503);
      expect((await res.json() as any).error.message).toContain('PARTICLE_API_KEY is not set');
    } finally { keyless.proxy.stop(); }
  });

  // Value: protects=particle-1 reads at its 16,000-token output floor while every other reader keeps the 2,048 cap; fails_when=the per-model key is ignored (particle refused) or widens the class (Opus admitted at 16,000); why_new=RouteCaps gains its first per-model key; seam=none; no_claim=other route classes
  test('on the same reader slot particle-1 passes at 16,000 output tokens and Opus at 16,000 is refused; particle stays capped above 16,000 and on the judge slot', async () => {
    const up = upstream(particleReply);
    const { proxy, post, lines } = start(up.fetchImpl, harness);
    try {
      expect((await post('/harness/particle/v1/chat/completions', particleChat())).status).toBe(200);
      const opus = await post('/harness/anthropic/v1/messages', { model: 'claude-opus-5-5', max_tokens: 16000, messages: [{ role: 'user', content: 'hi' }] });
      expect(opus.status).toBe(400);
      expect((await opus.json() as any).error.message).toContain('reader route cap of 2048');
      const over = await post('/harness/particle/v1/chat/completions', particleChat({ max_completion_tokens: 16001 }));
      expect(over.status).toBe(400);
      expect((await over.json() as any).error.message).toContain('reader route cap of 16000 for particle:particle-1');
      expect((await post('/judge/particle/v1/chat/completions', particleChat())).status).toBe(400);
      expect((await post('/harness/particle/v1/chat/completions', particleChat({ max_completion_tokens: undefined }))).status).toBe(200);
      expect(up.seen.map(s => s.body.max_completion_tokens)).toEqual([16000, 16000]);
      expect(lines().map(l => [l.model, l.route_class, l.output_cap, l.status])).toEqual([
        ['particle-1', 'reader', 16000, 200], ['claude-opus-5-5', 'reader', 2048, 400], ['particle-1', 'reader', 16000, 400], ['particle-1', 'judge', 2048, 400], ['particle-1', 'reader', 16000, 200],
      ]);
    } finally { proxy.stop(); }
  });

  // Value: protects=a request that passed the proxy's upstream deadline is never resent by a client (issue #250); fails_when=the proxy answers its own upstream timeout with the retryable 502 a lost connection gets; why_new=compatTimedOut reads a 504 as a timeout; seam=none; no_claim=Particle's own 504
  test('an upstream request that times out at the proxy is answered 504, which compatTimedOut reads as a timeout; any other upstream failure stays a 502', async () => {
    const { compatTimedOut, classifyCompatError, CompatHttpError } = await import('../../eval/runner/providers/openai-compatible.ts');
    for (const [name, status] of [['TimeoutError', 504], ['TypeError', 502]] as const) {
      const lease = BudgetRun.openLease({ runId: `particle-upstream-${name}`, leaseUsd: 1, ledgerPath: ledgerFile() });
      const failing = (async () => { throw name === 'TimeoutError' ? new DOMException('The operation timed out.', 'TimeoutError') : new TypeError('fetch failed: certificate has expired'); }) as unknown as typeof fetch;
      const proxy = new MeteringProxy({ fetchImpl: failing, policy: { lease, usageLog: join(tmp, `particle-upstream-${name}.ndjson`), ...harness } });
      proxy.start();
      try {
        const res = await fetch(`http://127.0.0.1:${proxy.port}/harness/particle/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(particleChat()) });
        expect([name, res.status]).toEqual([name, status]);
        expect(compatTimedOut(new CompatHttpError(classifyCompatError('particle', res.status, await res.text())))).toBe(status === 504);
      } finally { proxy.stop(); }
    }
    expect([compatTimedOut(new DOMException('x', 'AbortError')), compatTimedOut(new Error('fetch failed')), compatTimedOut(null)]).toEqual([true, false, false]);
  });

  // Value: protects=an exhausted lease stops particle before any spend; fails_when=a reservation over the lease is forwarded, or its refusal reads to the provider module as Particle's own credit stop; why_new=particle requests reserve 16,000 output tokens each; seam=none; no_claim=Particle's own 402
  test('a lease that cannot cover the reservation refuses before forwarding, with the marker the provider module reads as a proxy budget stop', async () => {
    const { classifyCompatError } = await import('../../eval/runner/providers/openai-compatible.ts');
    const up = upstream(particleReply);
    const lease = BudgetRun.openLease({ runId: 'particle-exhausted', leaseUsd: 0.01, ledgerPath: ledgerFile() });
    const proxy = new MeteringProxy({ fetchImpl: up.fetchImpl, policy: { lease, usageLog: join(tmp, 'particle-exhausted.ndjson'), ...harness } });
    proxy.start();
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/harness/particle/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(particleChat()) });
      expect(res.status).toBe(402);
      expect(classifyCompatError('particle', 402, await res.text()).kind).toBe('proxy_budget');
      expect(up.seen).toHaveLength(0);
    } finally { proxy.stop(); }
  });

  // Value: protects=every lease-proxy budget refusal stops a particle reader at once (issue #254); fails_when=the 503 for a missing PARTICLE_API_KEY or the 403 for a model off the allowlist reads as a retryable server error or a client error; why_new=a compat budget stop is read by its error name, which only a 402 got; seam=none; no_claim=the harness proxy's refusals
  test('the lease proxy\'s 503 for a missing key and 403 for a model off the allowlist are budget stops; its other refusals are not', async () => {
    const { classifyCompatError, compatError } = await import('../../eval/runner/providers/openai-compatible.ts');
    const missing = start(upstream(particleReply).fetchImpl, { ...harness, env: FAKE_ENV });
    const offList = start(upstream(particleReply).fetchImpl, { ...harness, allowModels: ['openai:gpt-6.1-sol'] });
    try {
      const answers = [await missing.post('/harness/particle/v1/chat/completions', particleChat()), await offList.post('/harness/particle/v1/chat/completions', particleChat()), await offList.post('/harness/particle/v1/responses', particleChat())];
      const read = await Promise.all(answers.map(async res => {
        const info = classifyCompatError('particle', res.status, await res.text());
        const e = compatError(info) as Error & { status?: number };
        return [res.status, info.kind, e.name, e.status];
      }));
      expect(read).toEqual([[503, 'proxy_budget', 'BudgetExceededError', 503], [403, 'proxy_budget', 'BudgetExceededError', 403], [403, 'client', 'CompatHttpError', 403]]);
    } finally { missing.proxy.stop(); offList.proxy.stop(); }
  });

  // Value: protects=a particle request whose connection dropped after it reached Particle is never sent again (issue #250's billing risk); fails_when=the proxy's transport retry resends a reset particle request, or answers it with a 502 a client retries; why_new=particle joins the lease proxy's A23 transport retry; seam=none; no_claim=whether Particle bills a dropped request
  test('a reset particle connection is answered 504 and sent once; a refused one is sent again, like any provider', async () => {
    const { compatTimedOut, classifyCompatError, CompatHttpError } = await import('../../eval/runner/providers/openai-compatible.ts');
    const reset = upstream(() => { throw Object.assign(new Error('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' }); });
    const one = start(reset.fetchImpl, harness);
    try {
      const res = await one.post('/harness/particle/v1/chat/completions', particleChat());
      expect(res.status).toBe(504);
      expect(compatTimedOut(new CompatHttpError(classifyCompatError('particle', res.status, await res.text())))).toBe(true);
      expect(reset.seen).toHaveLength(1);
      expect(one.lines().map(l => [l.outcome, l.charged_reservation])).toEqual([['failed', true]]);
    } finally { one.proxy.stop(); }
    let calls = 0;
    const refused = upstream(() => { if (++calls === 1) throw Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ECONNREFUSED' }); return particleReply(); });
    const two = start(refused.fetchImpl, harness);
    try {
      expect((await two.post('/harness/particle/v1/chat/completions', particleChat())).status).toBe(200);
      expect(refused.seen).toHaveLength(2);
    } finally { two.proxy.stop(); }
  });

  // Value: protects=a response body that fails after the headers settles its lease entry, frees its admission slot and leaves a failed usage line, and a particle client never sends it again (issue #270); fails_when=the body read throws outside the send's catch, so the reservation stays open, the admission slot stays held, no usage line is written and the client gets a 500 it retries; why_new=only the send had a catch; seam=a fake upstream whose body stream errors after the headers; no_claim=whether Particle bills a dropped body
  test('a body that fails after the headers settles its reservation, frees its admission slot and logs a failed line; particle is answered 504, another provider 502 unless it timed out (#270)', async () => {
    const { compatTimedOut, classifyCompatError, CompatHttpError } = await import('../../eval/runner/providers/openai-compatible.ts');
    const reset = Object.assign(new Error('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' });
    for (const [prov, body, error, status] of [
      ['particle', particleChat(), reset, 504],
      ['openai', chat(), reset, 502],
      ['openai', chat(), new DOMException('The operation timed out.', 'TimeoutError'), 504],
    ] as const) {
      const broken = upstream(() => new Response(new ReadableStream({ start(c) { c.error(error); } }), { status: 200, headers: { 'content-type': 'application/json' } }));
      const admission = new AdmissionController({ [prov]: { concurrency: 1 } }, { maxWaitMs: 100 });
      const { proxy, post, lines, lease } = start(broken.fetchImpl, { ...harness, admission });
      try {
        const res = await post(`/harness/${prov}/v1/chat/completions`, body);
        expect([prov, error.name, res.status]).toEqual([prov, error.name, status]);
        expect(compatTimedOut(new CompatHttpError(classifyCompatError(prov, res.status, await res.text())))).toBe(status === 504);
        expect(broken.seen).toHaveLength(1);
        expect(lines().map(l => [l.outcome, l.status, l.charged_reservation, l.actual_usd === l.reserved_usd && l.actual_usd! > 0])).toEqual([['failed', 200, true, true]]);
        const ledger = ledgerStatus({ ledgerPath: lease.ledgerPath, runId: lease.runId });
        expect([ledger.totals.open_reservations_usd, ledger.run!.committed_usd]).toEqual([0, lines()[0].reserved_usd!]);
        expect(admission.waitFor(prov, 1)).toBe(0);
      } finally { proxy.stop(); }
    }
  });

  // Value: protects=a particle body that fails after the headers is answered 504 and frees its admission slot even when the ledger cannot record it, so no client sends it again (issue #270); fails_when=a settle that throws escapes the catch and Bun answers 500, which particle clients retry; why_new=the body-read catch settles the ledger first; seam=a lease whose settle throws; no_claim=SQLite's own busy handling
  test('a particle body failure is still answered 504 with its admission slot freed when the ledger cannot settle it (#270)', async () => {
    const reset = Object.assign(new Error('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' });
    const broken = upstream(() => new Response(new ReadableStream({ start(c) { c.error(reset); } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const admission = new AdmissionController({ particle: { concurrency: 1 } }, { maxWaitMs: 100 });
    const { proxy, post, lease } = start(broken.fetchImpl, { ...harness, admission });
    lease.settle = () => { throw new Error('SQLITE_BUSY: database is locked'); };
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await post('/harness/particle/v1/chat/completions', particleChat())).status).toBe(504);
      expect(broken.seen).toHaveLength(1);
      expect(admission.waitFor('particle', 1)).toBe(0);
      expect(String(logged.mock.calls[0]?.[0])).toContain('so its reservation stays open: SQLITE_BUSY');
    } finally { logged.mockRestore(); proxy.stop(); }
  });

  // Value: protects=a proxied client always outwaits the lease proxy, so the proxy never sends and bills a request its client gave up on (issue #271); fails_when=an admission wait can exceed the 600 s a proxied client's deadline counts, from the constructor or from --admission-max-wait-s; why_new=clients of a loopback proxy wait PROXIED_DEADLINE_MS, which assumes this bound; seam=a fake clock; no_claim=a real 26-minute wait
  test('admission waits at most ADMISSION_MAX_WAIT_MS, which the deadline a proxied client waits covers with the upstream deadline (#271)', async () => {
    const { ADMISSION_MAX_WAIT_MS, PROXIED_DEADLINE_MS, UPSTREAM_DEADLINE_MS, compatDeadlineMs } = await import('../../eval/runner/metering-proxy.ts');
    const ac = new AdmissionController({}, { now: () => 0, maxWaitMs: 3_600_000 });
    ac.observe('particle', 'particle-1', new Headers({ 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '1', 'x-ratelimit-reset-requests': '15m' }));
    expect(ac.waitFor('particle', 1, 'particle-1')).toBe(900_000);
    const outcome = await Promise.race([ac.acquire('particle', 1, 'particle-1').then(() => 'admitted', e => (e as Error).name), Bun.sleep(300).then(() => 'still waiting')]);
    expect(outcome).toBe('AdmissionRefused');
    const lease = ['--budget-ledger', 'x', '--lease-usd', '1', '--run-id', 'r'];
    expect(() => parseProxyArgs([...lease, '--admission-max-wait-s', '3600'])).toThrow('--admission-max-wait-s must be a positive number of seconds up to 600');
    expect(parseProxyArgs([...lease, '--admission-max-wait-s', '600']).admissionMaxWaitMs).toBe(600_000);
    expect(ADMISSION_MAX_WAIT_MS).toBe(600_000);
    expect(PROXIED_DEADLINE_MS).toBeGreaterThan(ADMISSION_MAX_WAIT_MS + UPSTREAM_DEADLINE_MS);
    expect([compatDeadlineMs('http://127.0.0.1:8787/harness/particle/v1/chat/completions'), compatDeadlineMs('https://api.particle.ai/v1/chat/completions')]).toEqual([PROXIED_DEADLINE_MS, UPSTREAM_DEADLINE_MS]);
  });

  // Value: protects=a request's transport retries and its body share one upstream deadline, so a refused-then-slow request ends inside the time a proxied client waits (issues #270, #271); fails_when=the proxy makes a new AbortSignal.timeout per send again; why_new=PROXIED_DEADLINE_MS counts one upstream deadline per request; seam=a stubbed AbortSignal.timeout and a fake upstream that refuses once; no_claim=a real 900 s wait
  test('a request sent again after a refused connection keeps the one upstream deadline it started with (#270, #271)', async () => {
    const { UPSTREAM_DEADLINE_MS } = await import('../../eval/runner/metering-proxy.ts');
    const signals: Array<AbortSignal | null | undefined> = [];
    let calls = 0;
    const refusedOnce = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      if (++calls === 1) throw Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ECONNREFUSED' });
      return particleReply();
    }) as unknown as typeof fetch;
    const timeout = AbortSignal.timeout;
    const made: number[] = [];
    AbortSignal.timeout = (ms: number) => { made.push(ms); return timeout.call(AbortSignal, ms); };
    const { proxy, post } = start(refusedOnce, harness);
    try {
      expect((await post('/harness/particle/v1/chat/completions', particleChat())).status).toBe(200);
    } finally { AbortSignal.timeout = timeout; proxy.stop(); }
    expect(made.filter(ms => ms === UPSTREAM_DEADLINE_MS)).toHaveLength(1);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
  });

  // Value: protects=the lease proxy never sends a provider's real key over http to a host that is not loopback (issue #277); fails_when=an --upstream or a constructor upstream with an http URL that is not loopback is accepted; why_new=assertMetered guards clients only, and the proxy swaps in the real key itself; seam=none; no_claim=TLS certificate checks
  test('an upstream that is not loopback must be https, because the proxy sends the real key there (#277)', () => {
    expect(() => new MeteringProxy({ upstream: { particle: 'http://api.particle.ai' } })).toThrow('upstream particle=http://api.particle.ai would carry the particle key in cleartext');
    expect(() => new MeteringProxy({ upstream: { openai: 'http://10.0.0.5:8080' } })).toThrow('cleartext');
    expect(() => new MeteringProxy({ upstream: { particle: 'https://api.particle.ai', openai: 'http://127.0.0.1:9', voyage: 'http://localhost:9' } })).not.toThrow();
  });

  test('the CLI takes a per-model route cap and a particle upstream', () => {
    const a = parseProxyArgs(['--budget-ledger', 'x', '--lease-usd', '1', '--run-id', 'r', '--route-caps', 'extraction=4096,reader=2048,reader@particle:particle-1=16000,judge=2048', '--route-class', 'harness=reader,judge=judge', '--upstream', 'particle=http://127.0.0.1:9']);
    expect(a.routeCaps!.caps).toEqual({ extraction: 4096, reader: 2048, 'reader@particle:particle-1': 16000, judge: 2048 });
    expect(a.upstream).toEqual({ particle: 'http://127.0.0.1:9' });
    expect(DEFAULT_ROUTE_CAPS).toMatchObject({ reader: 2048, 'reader@particle:particle-1': 16000 });
  });
});
