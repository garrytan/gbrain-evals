/**
 * Scoreboard metering in the lease proxy (eval/runner/metering-proxy.ts):
 * the cell token on provider routes, stable per-request attribution with an
 * unattributed-background bucket and phase labels, per-route output caps,
 * billed against reserved-unsettled dollars, shared admission control
 * (requests per minute, tokens per minute, concurrency, retry-after) and 429
 * as upstream trouble. Keyless: every upstream is a fake and every key a
 * placeholder.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers, ledgerStatus } from '../../eval/runner/budget-ledger.ts';
import { AdmissionController, AdmissionRefused, DEFAULT_ROUTE_CAPS, isLocalAddress, MeteringProxy, parseAdmission, parseProxyArgs, ProxyControl, retryAfterMs, upstreamTrouble, usageSplit,
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
      expect(up.seen.map(s => s.body.max_completion_tokens)).toEqual([undefined, 2048, 1024]);
      const big = await post('/ext-memory-bank/openai/v1/chat/completions', chat({ max_completion_tokens: 64000 }));
      expect(big.status).toBe(200);
      expect(up.seen[3].body.max_completion_tokens).toBe(64000);
      const over = await post('/judge/openai/v1/chat/completions', chat({ max_completion_tokens: 2000 }));
      expect(over.status).toBe(400);
      expect((await over.json() as any).error.message).toContain('judge route cap of 1024');
      expect(lines().slice(0, 3).map(l => [l.route_class, l.output_cap])).toEqual([['extraction', 4096], ['reader', 2048], ['judge', 1024]]);
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
