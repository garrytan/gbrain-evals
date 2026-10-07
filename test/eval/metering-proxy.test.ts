/**
 * The extracted metering proxy (eval/runner/metering-proxy.ts). Keyless: every
 * upstream is a fake, and every "key" is a placeholder string.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetRun, closeLedgers, closeRun, ledgerStatus, priceRequest, reservationUsd } from '../../eval/runner/budget-ledger.ts';
import { MeteringProxy, parseProxyArgs, ProxyControl, sseUsage, upstreamTrouble, type LeasePolicy } from '../../eval/runner/metering-proxy.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'metering-proxy-'));
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); });
const FAKE_ENV = { OPENAI_API_KEY: 'placeholder-openai', ANTHROPIC_API_KEY: 'placeholder-anthropic', VOYAGE_API_KEY: 'placeholder-voyage' };
let n = 0;
const ledgerFile = () => join(tmp, `lease-${++n}.sqlite`);

interface Seen { url: string; headers: Headers; body: any }
function fakeUpstream(respond: (seen: Seen) => Response | Promise<Response> = () => Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5 } })) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const s = { url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(s);
    return respond(s);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

function leased(lease: BudgetRun, fetchImpl: typeof fetch, extra: Partial<LeasePolicy> = {}) {
  const usageLog = join(tmp, `usage-${n}.ndjson`);
  const proxy = new MeteringProxy({ fetchImpl, policy: { lease, env: FAKE_ENV, usageLog, ...extra } });
  proxy.start();
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${proxy.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { proxy, post, usageLog };
}

const chat = (model = 'gpt-4.1-mini', extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: 'user', content: 'hello there' }], max_completion_tokens: 100, ...extra });

describe('lease mode refuses before forwarding', () => {
  beforeEach(() => closeLedgers());
  test('an unpriced model, an unknown route and a missing model never reach the upstream', async () => {
    const lease = BudgetRun.openLease({ runId: 'lease-a', leaseUsd: 1, ledgerPath: ledgerFile() });
    const up = fakeUpstream();
    const { proxy, post, usageLog } = leased(lease, up.fetchImpl);
    try {
      const unpriced = await post('/c1/openai/v1/chat/completions', chat('mystery-model-9'));
      expect(unpriced.status).toBe(402);
      expect((await unpriced.json()).error.kind).toBe('budget');
      expect((await post('/c1/openai/v1/fine_tuning/jobs', { model: 'gpt-4.1-mini' })).status).toBe(403);
      expect((await post('/c1/openai/v1/chat/completions', { messages: [] })).status).toBe(402);
      expect((await fetch(`http://127.0.0.1:${proxy.port}/nowhere`)).status).toBe(404);
      expect(up.seen).toHaveLength(0);
      expect(ledgerStatus({ ledgerPath: lease.ledgerPath, runId: 'lease-a' }).run!.committed_usd).toBe(0);
      const lines = readFileSync(usageLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(lines.map(l => l.outcome)).toEqual(['refused', 'refused', 'refused']);
      expect(readFileSync(usageLog, 'utf8')).not.toContain('placeholder');
    } finally { proxy.stop(); }
  });

  test('a model off the allowlist, an output request above the cap, a disabled stream and a forbidden marker are refused', async () => {
    const lease = BudgetRun.openLease({ runId: 'lease-b', leaseUsd: 1, ledgerPath: ledgerFile() });
    const up = fakeUpstream();
    const { proxy, post } = leased(lease, up.fetchImpl, { allowModels: ['openai:gpt-4.1-mini'], maxOutputTokens: 1000, streaming: 'refuse', forbiddenMarkers: ['conv-26:q007'] });
    try {
      expect((await post('/c/openai/v1/chat/completions', chat('gpt-4o-mini'))).status).toBe(403);
      expect((await post('/c/openai/v1/chat/completions', chat('gpt-4.1-mini', { max_completion_tokens: 5000 }))).status).toBe(400);
      expect((await post('/c/openai/v1/chat/completions', chat('gpt-4.1-mini', { stream: true }))).status).toBe(400);
      const leak = await post('/c/openai/v1/chat/completions', chat('gpt-4.1-mini', { messages: [{ role: 'user', content: 'metadata conv-26:q007' }] }));
      expect(leak.status).toBe(403);
      expect(JSON.stringify(await leak.json())).not.toContain('conv-26:q007');
      expect(proxy.counts.tripwires).toBe(1);
      expect(up.seen).toHaveLength(0);
    } finally { proxy.stop(); }
  });

  test('a request that would pass the lease is refused and the ledger is unchanged', async () => {
    const lease = BudgetRun.openLease({ runId: 'lease-c', leaseUsd: 0.001, ledgerPath: ledgerFile() });
    const up = fakeUpstream();
    const { proxy, post } = leased(lease, up.fetchImpl);
    try {
      const res = await post('/c/openai/v1/chat/completions', chat('gpt-5.5', { max_completion_tokens: 30000 }));
      expect(res.status).toBe(402);
      expect(up.seen).toHaveLength(0);
      expect(ledgerStatus({ ledgerPath: lease.ledgerPath, runId: 'lease-c' }).run!.committed_usd).toBe(0);
    } finally { proxy.stop(); }
  });
});

describe('lease mode forwarding', () => {
  beforeEach(() => closeLedgers());
  test('inbound credentials are stripped, the proxy key is injected, the output cap is injected and usage settles the reservation', async () => {
    const lease = BudgetRun.openLease({ runId: 'lease-d', leaseUsd: 1, ledgerPath: ledgerFile() });
    const up = fakeUpstream();
    const { proxy, post } = leased(lease, up.fetchImpl, { maxOutputTokens: 2048 });
    try {
      const body = { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] };
      const res = await post('/c/openai/v1/chat/completions', body, { authorization: 'Bearer dummy-from-container', 'x-api-key': 'dummy2' });
      expect(res.status).toBe(200);
      expect(up.seen[0].headers.get('authorization')).toBe('Bearer placeholder-openai');
      expect(up.seen[0].headers.get('x-api-key')).toBeNull();
      expect(up.seen[0].body.max_completion_tokens).toBe(2048);
      expect(up.seen[0].url).toBe('https://api.openai.com/v1/chat/completions');
      const anth = await post('/c/anthropic/v1/messages', { model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': 'dummy' });
      expect(anth.status).toBe(200);
      expect(up.seen[1].headers.get('x-api-key')).toBe('placeholder-anthropic');
      expect(up.seen[1].headers.get('authorization')).toBeNull();
      const run = ledgerStatus({ ledgerPath: lease.ledgerPath, runId: 'lease-d' }).run!;
      expect(run.committed_usd).toBeCloseTo((10 * 0.4 + 5 * 1.6) / 1e6 + (10 * 2 + 5 * 10) / 1e6, 12);
    } finally { proxy.stop(); }
  });

  test('a 4xx without usage settles at $0; a 5xx without usage keeps its reservation', async () => {
    const lease = BudgetRun.openLease({ runId: 'lease-4xx', leaseUsd: 1, ledgerPath: ledgerFile() });
    let status = 400;
    const up = fakeUpstream(() => Response.json({ error: { message: 'bad request' } }, { status }));
    const { proxy, post, usageLog } = leased(lease, up.fetchImpl);
    try {
      expect((await post('/c/openai/v1/chat/completions', chat())).status).toBe(400);
      expect(ledgerStatus({ ledgerPath: lease.ledgerPath, runId: 'lease-4xx' }).run!.committed_usd).toBe(0);
      status = 503;
      expect((await post('/c/openai/v1/chat/completions', chat())).status).toBe(503);
      const lines = readFileSync(usageLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(lines.map(l => [l.status, l.actual_usd === 0, l.charged_reservation])).toEqual([[400, true, false], [503, false, true]]);
      expect(ledgerStatus({ ledgerPath: lease.ledgerPath, runId: 'lease-4xx' }).run!.committed_usd).toBeCloseTo(lines[1].reserved_usd, 12);
    } finally { proxy.stop(); }
  });

  test('the input reservation is bounded by request bytes, not bytes over three', async () => {
    const lease = BudgetRun.openLease({ runId: 'lease-e', leaseUsd: 1, ledgerPath: ledgerFile() });
    let reserved = 0;
    const up = fakeUpstream(() => new Response('no usage', { status: 200 }));
    const { proxy, post, usageLog } = leased(lease, up.fetchImpl);
    try {
      const body = chat('gpt-4.1-mini', { messages: [{ role: 'user', content: 'x'.repeat(30_000) }] });
      await post('/c/openai/v1/chat/completions', body);
      reserved = JSON.parse(readFileSync(usageLog, 'utf8').trim()).reserved_usd;
      const ledgerBound = reservationUsd(priceRequest('https://api.openai.com/v1/chat/completions', body)!);
      expect(reserved).toBeGreaterThan(ledgerBound * 2.5);
      expect(ledgerStatus({ ledgerPath: lease.ledgerPath, runId: 'lease-e' }).run!.committed_usd).toBeCloseTo(reserved, 12);
    } finally { proxy.stop(); }
  });

  test('concurrent requests cannot overspend the lease', async () => {
    const body = chat('gpt-4.1-mini', { max_completion_tokens: 1000 });
    const one = reservationUsd({ ...priceRequest('https://api.openai.com/v1/chat/completions', body)!, inputTokens: Buffer.byteLength(JSON.stringify(body)) + 64 });
    const leaseUsd = one * 7.5;
    const lease = BudgetRun.openLease({ runId: 'lease-f', leaseUsd, ledgerPath: ledgerFile() });
    const up = fakeUpstream(async () => { await Bun.sleep(20); return new Response('{}', { status: 200 }); });
    const { proxy, post } = leased(lease, up.fetchImpl);
    try {
      const statuses = await Promise.all(Array.from({ length: 40 }, () => post('/c/openai/v1/chat/completions', body).then(r => r.status)));
      expect(statuses.filter(s => s === 200)).toHaveLength(7);
      expect(statuses.filter(s => s === 402)).toHaveLength(33);
      expect(up.seen).toHaveLength(7);
      expect(ledgerStatus({ ledgerPath: lease.ledgerPath, runId: 'lease-f' }).run!.committed_usd).toBeLessThanOrEqual(leaseUsd + 1e-12);
    } finally { proxy.stop(); }
  });

  test('streams pass through and settle from their usage events, or at the reservation', async () => {
    const lease = BudgetRun.openLease({ runId: 'lease-g', leaseUsd: 1, ledgerPath: ledgerFile() });
    let withUsage = true;
    const up = fakeUpstream(seen => {
      const chunks = ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', ...(withUsage ? ['data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\n'] : []), 'data: [DONE]\n\n'];
      expect(seen.body.stream_options.include_usage).toBe(true);
      return new Response(chunks.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const { proxy, post, usageLog } = leased(lease, up.fetchImpl);
    try {
      const text = await (await post('/c/openai/v1/chat/completions', chat('gpt-4.1-mini', { stream: true }))).text();
      expect(text).toContain('[DONE]');
      withUsage = false;
      await (await post('/c/openai/v1/chat/completions', chat('gpt-4.1-mini', { stream: true }))).text();
      await proxy.finalize('slot:c', 5000);
      const lines = readFileSync(usageLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(lines[0]).toMatchObject({ streamed: true, charged_reservation: false, input_tokens: 100, output_tokens: 20 });
      expect(lines[1]).toMatchObject({ streamed: true, charged_reservation: true });
      expect(lines[1].actual_usd).toBe(lines[1].reserved_usd);
    } finally { proxy.stop(); }
  });

  test('Anthropic stream usage merges message_start input with message_delta output', () => {
    const sse = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n';
    expect(sseUsage(sse)).toEqual({ input_tokens: 50, output_tokens: 30 });
    expect(sseUsage('data: [DONE]\n')).toBeNull();
  });
});

describe('attribution across processes', () => {
  beforeEach(() => closeLedgers());
  test('the harness binds a slot to a question, and the meter shows what the provider answered', async () => {
    const lease = BudgetRun.openLease({ runId: 'lease-ctl', leaseUsd: 1, ledgerPath: ledgerFile() });
    let mode: 'ok' | '503' | 'garbled' = 'ok';
    const up = fakeUpstream(() => mode === '503' ? new Response('{"error":"overloaded"}', { status: 503 }) : mode === 'garbled' ? new Response('<html>oops</html>', { status: 200 }) : Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const proxy = new MeteringProxy({ fetchImpl: up.fetchImpl, controlToken: 'tok', policy: { lease, env: FAKE_ENV } });
    proxy.start();
    const base = `http://127.0.0.1:${proxy.port}`;
    const ctl = new ProxyControl(base, 'tok');
    const post = () => fetch(`${base}/ext-extract-first/openai/v1/chat/completions`, { method: 'POST', body: JSON.stringify(chat()) });
    try {
      expect((await fetch(`${base}/__proxy/bind`, { method: 'POST', body: JSON.stringify({ slot: 'ext-extract-first', key: 'x' }) })).status).toBe(403);
      const ok = await ctl.around('ext-extract-first', 'q:1', async () => { await post(); mode = '503'; await post(); return 'done'; });
      expect(ok.value).toBe('done');
      expect(ok.meter).toMatchObject({ requests: 2, upstream: { statuses: { '200': 1, '503': 1 }, failed: 0, unparseable: 0 } });
      expect(upstreamTrouble(ok.meter)).toBe(true);
      mode = 'garbled';
      const bad = await ctl.around('ext-extract-first', 'q:2', () => post());
      expect(bad.meter.upstream).toEqual({ statuses: {}, failed: 0, unparseable: 1 });
      mode = 'ok';
      const clean = await ctl.around('ext-extract-first', 'q:3', () => post());
      expect(upstreamTrouble(clean.meter)).toBe(false);
      await post();
      expect(proxy.meters.get('slot:ext-extract-first')!.requests).toBe(1);
    } finally { proxy.stop(); }
  });
});

describe('leases survive restarts without replay', () => {
  beforeEach(() => closeLedgers());
  test('reopening resumes committed spend; a closed lease, another amount or a second lease is refused', async () => {
    const path = ledgerFile();
    const first = BudgetRun.openLease({ runId: 'lease-h', leaseUsd: 0.5, ledgerPath: path });
    const id = first.reserve(0.4, 'spent before the crash');
    first.settle(id, null);
    closeLedgers();
    const again = BudgetRun.openLease({ runId: 'lease-h', leaseUsd: 0.5, ledgerPath: path });
    expect(() => again.reserve(0.2, 'after restart')).toThrow(/over its \$0\.50 budget/);
    expect(() => BudgetRun.openLease({ runId: 'lease-h', leaseUsd: 1, ledgerPath: path })).toThrow(/program cap mismatch|opened for/);
    expect(() => BudgetRun.openLease({ runId: 'lease-other', leaseUsd: 0.5, ledgerPath: path })).toThrow(/still holds open lease lease-h; pass --new-run/);
    closeRun(path, 'lease-h');
    expect(() => BudgetRun.openLease({ runId: 'lease-h', leaseUsd: 0.5, ledgerPath: path })).toThrow(/never reopened/);
  });

  test('one ledger holds a cell\'s reruns: --new-run closes the open lease, each lease keeps its own budget and output cap', () => {
    const path = ledgerFile();
    const a = BudgetRun.openLease({ runId: 'rerun-1', leaseUsd: 0.5, ledgerPath: path, maxOutputTokens: 64000 });
    a.settle(a.reserve(0.45, 'first run'), null);
    expect(() => BudgetRun.openLease({ runId: 'rerun-1', leaseUsd: 0.5, ledgerPath: path })).toThrow(/output cap of 64000, not the default/);
    const b = BudgetRun.openLease({ runId: 'rerun-2', leaseUsd: 0.5, ledgerPath: path, newRun: true });
    expect(ledgerStatus({ ledgerPath: path, runId: 'rerun-1' }).run!.finished_at).not.toBeNull();
    expect(() => BudgetRun.openLease({ runId: 'rerun-1', leaseUsd: 0.5, ledgerPath: path, maxOutputTokens: 64000 })).toThrow(/never reopened/);
    expect(() => b.reserve(0.49, 'second run')).not.toThrow();
    expect(() => b.reserve(0.02, 'over')).toThrow(/over its \$0\.50 budget/);
    expect(ledgerStatus({ ledgerPath: path }).totals.program_cap_usd).toBeCloseTo(1, 9);
    expect(BudgetRun.leaseMaxOutputTokens(path, 'rerun-1')).toBe(64000);
    expect(BudgetRun.leaseMaxOutputTokens(path, 'rerun-2')).toBeNull();
    expect(BudgetRun.runRequests(path, 'rerun-2')).toBe(1);
  });

  test('a ledger that is not a lease ledger is never used as one', () => {
    const path = ledgerFile();
    BudgetRun.open({ runner: 'some-runner', budgetUsd: 1, ledgerPath: path, programCapUsd: 5 });
    expect(() => BudgetRun.openLease({ runId: 'sneaky', leaseUsd: 1, ledgerPath: path })).toThrow(/not a lease ledger/);
  });

  test('the CLI proxy, restarted on the same lease, keeps refusing once the lease is spent', async () => {
    const path = ledgerFile();
    const seen: string[] = [];
    const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => { seen.push(req.headers.get('authorization') ?? ''); return Response.json({ id: 'no-usage' }); } });
    const body = chat('gpt-4.1-mini', { max_completion_tokens: 1000 });
    const one = reservationUsd({ ...priceRequest('https://api.openai.com/v1/chat/completions', body)!, inputTokens: Buffer.byteLength(JSON.stringify(body)) + 64 });
    const leaseUsd = (one * 2.5).toFixed(6);
    const start = async () => {
      const port = 20000 + Math.floor(Math.random() * 20000);
      const proc = Bun.spawn([process.execPath, 'eval/runner/metering-proxy.ts', '--listen', `127.0.0.1:${port}`, '--budget-ledger', path, '--lease-usd', leaseUsd, '--run-id', 'lease-cli',
        '--upstream', `openai=http://127.0.0.1:${upstream.port}`], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...FAKE_ENV }, stdout: 'pipe', stderr: 'pipe' });
      for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/__proxy/status`); return { proc, port }; } catch { await Bun.sleep(50); } }
      throw new Error(`proxy did not start: ${await new Response(proc.stderr).text()}`);
    };
    const call = (port: number) => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer container-dummy' } }).then(r => r.status);
    try {
      let p = await start();
      expect(await call(p.port)).toBe(200);
      p.proc.kill('SIGKILL'); await p.proc.exited;
      p = await start();
      const status = await (await fetch(`http://127.0.0.1:${p.port}/__proxy/status`)).json();
      expect(status.committed_usd).toBeGreaterThan(0);
      expect(await call(p.port)).toBe(200);
      expect(await call(p.port)).toBe(402);
      p.proc.kill('SIGTERM'); await p.proc.exited;
      expect(seen).toEqual(['Bearer placeholder-openai', 'Bearer placeholder-openai']);
      closeLedgers();
      const summary = Bun.spawnSync([process.execPath, 'eval/runner/metering-proxy.ts', 'summary', '--budget-ledger', path, '--run-id', 'lease-cli'], { cwd: ROOT });
      expect(JSON.parse(summary.stdout.toString())).toMatchObject({ run_id: 'lease-cli', lease_usd: Number(leaseUsd), max_output_tokens: 32768, requests: 2 });
    } finally { upstream.stop(true); }
  }, 30_000);

  test('the CLI refuses to start without a lease', () => {
    expect(() => parseProxyArgs(['--listen', '0.0.0.0:8787'])).toThrow(/never forwards without a lease/);
    expect(parseProxyArgs(['--listen', '0.0.0.0:9', '--budget-ledger', 'x', '--lease-usd', '2', '--run-id', 'r']).host).toBe('0.0.0.0');
  });
});

describe('in-process mode (Cat 40 callers)', () => {
  test('fails closed on an unpriced request instead of forwarding it free', async () => {
    const up = fakeUpstream();
    const proxy = new MeteringProxy({ fetchImpl: up.fetchImpl });
    proxy.start();
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/slot0/openai/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'unknown-model', messages: [] }) });
      expect(res.status).toBe(402);
      expect(up.seen).toHaveLength(0);
    } finally { proxy.stop(); }
  });
});
