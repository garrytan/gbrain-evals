/**
 * Metering proxy: the only network exit for provider calls a memory system
 * (or a gbrain subprocess) makes. Requests arrive at
 * `/<slot>/<provider>/<path>` (or `/<provider>/<path>`, slot `default`) and
 * are forwarded to the provider after they are priced.
 *
 * Every mode fails closed on price: a request to a paid provider that the
 * budget ledger cannot price (unknown model, no model) is refused with HTTP
 * 402 and never forwarded.
 *
 * Two modes:
 *   in-process (Cat 40, chronicle, P4 stream, P8): the client is a gbrain
 *     child process of this harness. Its credentials are forwarded and the
 *     process-wide paid-request guard (or a slot allowance) reserves each
 *     request, as before the extraction.
 *   lease (the shootout cell, `policy` set): the proxy holds a lease run in
 *     its own ledger (`BudgetRun.openLease`) and enforces it itself. It strips
 *     inbound credentials and injects the real key from its own environment,
 *     allows only listed provider routes and priced models, bounds input
 *     tokens by request bytes (a token covers at least one byte), injects or
 *     enforces an output-token cap so the provider enforces the bound,
 *     reserves the worst case before forwarding (concurrent requests serialize
 *     on the ledger, so they cannot overspend the lease), meters streamed
 *     responses from their usage events (or charges the reservation), refuses
 *     bodies carrying a forbidden marker (the sanitizer's leak tripwire), and
 *     appends one usage line per request (never a body or a key).
 *
 * Standalone (lease mode):
 *   bun eval/runner/metering-proxy.ts --listen 0.0.0.0:8787 --budget-ledger <file> --lease-usd <n> --run-id <id>
 *     [--usage-log <file>] [--allow-models openai:gpt-4.1-mini,...] [--max-output-tokens 32768]
 *     [--forbidden-markers <file>] [--streaming meter|refuse] [--upstream openai=http://...]
 *   bun eval/runner/metering-proxy.ts summary --budget-ledger <file> --run-id <id>
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { BudgetExceededError, BudgetRun, ledgerStatus, priceRequest, reservationUsd, usageCost, type BudgetAllowance } from './budget-ledger.ts';
import { findLeaks } from './systems/sanitize.ts';

export const UPSTREAM: Record<string, string> = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com', voyage: 'https://api.voyageai.com' };
export type ProviderName = 'anthropic' | 'openai' | 'voyage';
type Send = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Lease mode forwards only these routes. GET model listings are free metadata reads. */
const ROUTES: Record<ProviderName, Array<{ method: string; path: RegExp }>> = {
  openai: [
    { method: 'POST', path: /^\/v1\/chat\/completions$/ }, { method: 'POST', path: /^\/v1\/responses$/ }, { method: 'POST', path: /^\/v1\/embeddings$/ },
    { method: 'GET', path: /^\/v1\/models(\/[^/]+)?$/ },
  ],
  anthropic: [{ method: 'POST', path: /^\/v1\/messages$/ }],
  voyage: [{ method: 'POST', path: /^\/v1\/embeddings$/ }, { method: 'POST', path: /^\/v1\/rerank$/ }],
};
const KEY_ENV: Record<ProviderName, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', voyage: 'VOYAGE_API_KEY' };
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'api-key', 'openai-organization', 'openai-project', 'cookie', 'proxy-authorization'];
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

export interface Meter {
  usd: number;
  requests: number;
  /** Requests whose cost came from their reservation because the response reported no usage (charged, not free). */
  unpriced: number;
  /** Requests still in flight when the meter was finalized after its timeout (their cost is missing here, not in the ledger). */
  undrained?: number;
  byModel: Record<string, { usd: number; requests: number }>;
}
export const newMeter = (): Meter => ({ usd: 0, requests: 0, unpriced: 0, byModel: {} });

export interface LeasePolicy {
  /** The lease this proxy spends; every request is reserved against it before it is forwarded. */
  lease: BudgetRun;
  /** Where real keys come from (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** When set, only these `provider:model` ids may be called (they must also be priced). */
  allowModels?: string[] | null;
  /** Output-token cap injected when a request names none; a request naming more is refused. */
  maxOutputTokens?: number;
  /** Strings that must never leave the cell (raw dataset ids, labels); a body containing one is refused. */
  forbiddenMarkers?: string[];
  streaming?: 'meter' | 'refuse';
  /** Append-only per-request usage log (ndjson). */
  usageLog?: string;
}

export interface UsageLine {
  at: string; key: string; provider: string; route: string; model: string | null;
  outcome: 'forwarded' | 'refused' | 'failed';
  reason?: string; status?: number; reserved_usd?: number; actual_usd?: number; input_tokens?: number; output_tokens?: number; charged_reservation?: boolean; streamed?: boolean;
}

const json = (status: number, kind: string, message: string) =>
  new Response(JSON.stringify({ error: { kind, type: kind, message: `metering proxy: ${message}` } }), { status, headers: { 'content-type': 'application/json' } });

/** Provider usage from a server-sent-events body: OpenAI `usage` chunks and `response.completed`, Anthropic `message_start` and `message_delta`. */
export function sseUsage(text: string): Record<string, unknown> | null {
  const merged: Record<string, unknown> = {};
  let found = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let obj: any;
    try { obj = JSON.parse(data); } catch { continue; }
    for (const u of [obj?.usage, obj?.response?.usage, obj?.message?.usage]) {
      if (!u || typeof u !== 'object') continue;
      for (const [k, v] of Object.entries(u)) if (typeof v === 'number' || (v && typeof v === 'object')) { merged[k] = v; found = true; }
    }
  }
  return found ? merged : null;
}

/** The output-token field a request uses, by provider and route. */
function outputField(provider: ProviderName, route: string): string | null {
  if (provider === 'anthropic') return 'max_tokens';
  if (provider === 'openai' && route === '/v1/chat/completions') return 'max_completion_tokens';
  if (provider === 'openai' && route === '/v1/responses') return 'max_output_tokens';
  return null;
}

/**
 * Forwards provider requests (each slot's base URL names the slot) and meters
 * them. A request is charged to the cell bound to its slot when it arrives, so
 * a request that finishes after the cell moved on still lands on the right
 * cell; `finalize` waits for a cell's in-flight requests to drain. Requests
 * with no bound cell are metered under `slot:<id>`.
 */
export class MeteringProxy {
  private server: ReturnType<typeof Bun.serve> | null = null;
  readonly meters = new Map<string, Meter>();
  /** Slots whose provider requests are charged to a ledger allowance (slot builds), not one ledger entry each. */
  readonly allowances = new Map<string, BudgetAllowance>();
  readonly counts = { forwarded: 0, refused: 0, failed: 0, tripwires: 0 };
  private bindings = new Map<string, string>();
  private inflight = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();
  constructor(private options: { fetchImpl?: typeof fetch; hostname?: string; port?: number; upstream?: Partial<Record<ProviderName, string>>; policy?: LeasePolicy } = {}) {}
  get port(): number { return this.server!.port as number; }
  /** Charge the slot's provider requests to `key` (a cell id) from now on. */
  bind(slot: string, key: string) { this.bindings.set(slot, key); }
  unbind(slot: string) { this.bindings.delete(slot); }
  private meter(key: string): Meter { let m = this.meters.get(key); if (!m) this.meters.set(key, m = newMeter()); return m; }
  private settled(key: string) {
    const n = (this.inflight.get(key) ?? 1) - 1;
    if (n > 0) { this.inflight.set(key, n); return; }
    this.inflight.delete(key);
    for (const w of this.waiters.get(key) ?? []) w();
    this.waiters.delete(key);
  }
  /** Wait for `key`'s in-flight requests (at most `timeoutMs`), then remove and return its meter. */
  async finalize(key: string, timeoutMs = 120_000): Promise<Meter> {
    if (this.inflight.get(key)) {
      await Promise.race([new Promise<void>(r => { const list = this.waiters.get(key) ?? []; list.push(r); this.waiters.set(key, list); }), Bun.sleep(timeoutMs)]);
    }
    const m = this.meters.get(key) ?? newMeter();
    this.meters.delete(key);
    if (this.inflight.get(key)) m.undrained = this.inflight.get(key);
    return m;
  }
  private log(line: UsageLine) {
    if (line.outcome === 'refused') this.counts.refused++; else if (line.outcome === 'failed') this.counts.failed++; else this.counts.forwarded++;
    if (this.options.policy?.usageLog) appendFileSync(this.options.policy.usageLog, JSON.stringify(line) + '\n');
  }
  start() {
    const send: Send = this.options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.server = Bun.serve({
      port: this.options.port ?? 0, hostname: this.options.hostname ?? '127.0.0.1', idleTimeout: 255,
      fetch: async req => {
        const url = new URL(req.url);
        if (url.pathname === '/__proxy/status' && req.method === 'GET') return Response.json(this.status());
        const m = url.pathname.match(/^\/(?:([^/]+)\/)?(anthropic|openai|voyage)(\/.*)$/);
        if (!m) return json(404, 'invalid_request', `no provider route ${url.pathname}`);
        const [, slot = 'default', prov, rest] = m as unknown as [string, string | undefined, ProviderName, string];
        const key = this.bindings.get(slot) ?? `slot:${slot}`;
        this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
        let streaming = false;
        try {
          const r = this.options.policy
            ? await this.forwardLeased(req, prov, rest, url.search, key, send, () => { streaming = true; return () => this.settled(key); })
            : await this.forwardInProcess(req, slot, prov, rest, url.search, key, send);
          return r;
        } finally { if (!streaming) this.settled(key); }
      },
    });
  }
  stop() { this.server?.stop(true); }

  status() {
    const p = this.options.policy;
    const run = p ? ledgerStatus({ ledgerPath: p.lease.ledgerPath, runId: p.lease.runId }).run : null;
    return { mode: p ? 'lease' : 'in-process', run_id: p?.lease.runId ?? null, lease_usd: p?.lease.budgetUsd ?? null, committed_usd: run?.committed_usd ?? null, ...this.counts };
  }

  private charge(key: string, prov: string, model: string | null, usd: number, unpriced: boolean) {
    const meter = this.meter(key);
    meter.requests++;
    meter.usd += usd;
    if (unpriced) meter.unpriced++;
    if (model) { const k = `${prov}:${model}`; meter.byModel[k] ??= { usd: 0, requests: 0 }; meter.byModel[k].usd += usd; meter.byModel[k].requests++; }
  }

  /** In-process mode: the client is this harness's own gbrain child; its credentials are forwarded and the paid-request guard or a slot allowance reserves. */
  private async forwardInProcess(req: Request, slot: string, prov: ProviderName, rest: string, search: string, key: string, send: Send): Promise<Response> {
    const target = `${this.options.upstream?.[prov] ?? UPSTREAM[prov]}${rest}${search}`;
    const headers = new Headers(req.headers);
    for (const h of ['host', 'content-length', 'accept-encoding', 'connection']) headers.delete(h);
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
    let price: ReturnType<typeof priceRequest>;
    try { price = priceRequest(`${UPSTREAM[prov]}${rest}${search}`, body ? JSON.parse(body) : undefined); }
    catch (e) { return json(402, 'budget', `refused before forwarding: ${(e as Error).message}`); }
    let res: Response;
    const allowance = this.allowances.get(slot);
    const forward = () => send(target, { method: req.method, headers, body });
    try { res = await (allowance ? allowance.run(forward) : forward()); }
    catch (e) {
      // A refused reservation never left the process; any other failure after sending is charged at its reservation, as the ledger does.
      if ((e as Error).name !== 'BudgetExceededError' && price) this.charge(key, prov, price.model, reservationUsd(price), true);
      return json(502, (e as Error).name === 'BudgetExceededError' ? 'budget' : 'product_error', (e as Error).message);
    }
    const text = await res.text();
    if (price) {
      let cost: ReturnType<typeof usageCost> = null;
      try { cost = usageCost(price, JSON.parse(text)); } catch { cost = null; }
      this.charge(key, prov, price.model, cost ? cost.usd : reservationUsd(price), !cost);
    } else this.charge(key, prov, null, 0, false);
    const out = new Headers(res.headers);
    for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) out.delete(h);
    return new Response(text, { status: res.status, headers: out });
  }

  /** Lease mode: allowlist, tripwire, output cap, price, reserve, inject the key, forward, settle. Every refusal happens before forwarding. */
  private async forwardLeased(req: Request, prov: ProviderName, route: string, search: string, key: string, send: Send, beginStream: () => () => void): Promise<Response> {
    const p = this.options.policy!;
    const at = new Date().toISOString();
    const refuse = (status: number, kind: string, reason: string, model: string | null = null) => {
      this.log({ at, key, provider: prov, route, model, outcome: 'refused', reason, status });
      return json(status, kind, reason);
    };
    if (!ROUTES[prov].some(r => r.method === req.method && r.path.test(route))) return refuse(403, 'invalid_request', `route ${req.method} /${prov}${route} is not allowlisted`);
    const realKey = (p.env ?? process.env)[KEY_ENV[prov]];
    if (!realKey) return refuse(503, 'budget', `${KEY_ENV[prov]} is not set in the proxy's environment`);
    const raw = req.method === 'GET' ? undefined : await req.text();
    const markers = p.forbiddenMarkers ?? [];
    if (raw && markers.length) {
      const leaks = findLeaks(raw, markers);
      if (leaks.length) { this.counts.tripwires++; return refuse(403, 'invalid_request', `tripwire: the request body carries ${leaks.length} forbidden marker(s); the cell is invalid`); }
    }
    let body: Record<string, any> | undefined;
    if (raw !== undefined) {
      try { body = JSON.parse(raw); } catch { return refuse(400, 'invalid_request', 'request body is not JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(400, 'invalid_request', 'request body must be a JSON object');
    }
    const model = typeof body?.model === 'string' ? body.model : null;
    const streamed = body?.stream === true;
    if (streamed && (p.streaming ?? 'meter') === 'refuse') return refuse(400, 'invalid_request', 'streaming is disabled for this cell', model);
    if (streamed && prov === 'openai' && route === '/v1/chat/completions') body!.stream_options = { ...(body!.stream_options ?? {}), include_usage: true };
    const field = body ? outputField(prov, route) : null;
    const cap = p.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (field && body) {
      const stated = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens].filter((v): v is number => typeof v === 'number');
      if (stated.some(v => v > cap)) return refuse(400, 'invalid_request', `requested ${Math.max(...stated)} output tokens, above this cell's cap of ${cap}`, model);
      if (!stated.length) body[field] = cap;
    }
    const target = `${this.options.upstream?.[prov] ?? UPSTREAM[prov]}${route}${search}`;
    const outBody = body === undefined ? undefined : JSON.stringify(body);
    let price: ReturnType<typeof priceRequest>;
    try { price = priceRequest(`${UPSTREAM[prov]}${route}${search}`, body); }
    catch (e) { return refuse(402, 'budget', `unpriced request refused: ${(e as Error).message}`, model); }
    if (price && p.allowModels && !p.allowModels.includes(`${prov}:${price.model}`)) return refuse(403, 'budget', `${prov}:${price.model} is not on this cell's model allowlist`, model);
    const bounded = price ? { ...price, inputTokens: Math.max(price.inputTokens, Buffer.byteLength(outBody ?? '') + 64) } : null;
    const reserved = bounded ? reservationUsd(bounded) : 0;
    let entry: string | null = null;
    if (bounded) {
      try { entry = p.lease.reserve(reserved, `${prov}:${bounded.model} ${bounded.kind} [${key}]`); }
      catch (e) { return refuse(402, 'budget', (e as Error).message, model); }
    }
    const headers = new Headers(req.headers);
    for (const h of ['host', 'content-length', 'accept-encoding', 'connection', ...CREDENTIAL_HEADERS]) headers.delete(h);
    if (prov === 'anthropic') { headers.set('x-api-key', realKey); if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01'); }
    else headers.set('authorization', `Bearer ${realKey}`);
    if (outBody !== undefined) headers.set('content-type', 'application/json');
    const settle = (cost: ReturnType<typeof usageCost>, status: number, isStream: boolean) => {
      if (entry) p.lease.settle(entry, cost);
      const usd = cost ? cost.usd : reserved;
      this.charge(key, prov, bounded?.model ?? null, usd, !!bounded && !cost);
      this.log({ at, key, provider: prov, route, model: bounded?.model ?? model, outcome: 'forwarded', status, reserved_usd: reserved, actual_usd: usd,
        input_tokens: cost?.input_tokens, output_tokens: cost?.output_tokens, charged_reservation: !!bounded && !cost, streamed: isStream });
    };
    let res: Response;
    try { res = await send(target, { method: req.method, headers, body: outBody }); }
    catch (e) {
      if (entry) p.lease.settle(entry, null);
      this.charge(key, prov, bounded?.model ?? null, reserved, !!bounded);
      this.log({ at, key, provider: prov, route, model, outcome: 'failed', reason: (e as Error).message.slice(0, 300), reserved_usd: reserved, actual_usd: reserved, charged_reservation: !!bounded });
      return json(502, 'product_error', `upstream failed: ${(e as Error).message}`);
    }
    const out = new Headers(res.headers);
    for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) out.delete(h);
    if ((res.headers.get('content-type') ?? '').includes('event-stream') && res.body) {
      const done = beginStream();
      const [client, meterBranch] = res.body.tee();
      void new Response(meterBranch).text().then(
        text => { const u = sseUsage(text); settle(bounded && u ? usageCost(bounded, { usage: u }) : null, res.status, true); },
        () => settle(null, res.status, true),
      ).finally(done);
      return new Response(client, { status: res.status, headers: out });
    }
    const text = await res.text();
    let cost: ReturnType<typeof usageCost> = null;
    if (bounded) { try { cost = usageCost(bounded, JSON.parse(text)); } catch { cost = null; } }
    settle(cost, res.status, false);
    return new Response(text, { status: res.status, headers: out });
  }
}

export interface ProxyCliArgs {
  host: string; port: number; ledger: string; leaseUsd: number; runId: string; usageLog: string | null;
  allowModels: string[] | null; maxOutputTokens: number; forbiddenMarkers: string[]; streaming: 'meter' | 'refuse'; upstream: Partial<Record<ProviderName, string>>;
}

export function parseProxyArgs(argv: string[]): ProxyCliArgs {
  const one = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const listen = one('--listen') ?? '127.0.0.1:8787';
  const at = listen.lastIndexOf(':');
  const port = Number(listen.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--listen must look like host:port');
  const ledger = one('--budget-ledger'), runId = one('--run-id'), lease = one('--lease-usd');
  if (!ledger || !runId || !lease) throw new Error('the proxy needs --budget-ledger <file>, --lease-usd <n> and --run-id <id>; it never forwards without a lease');
  const streaming = (one('--streaming') ?? 'meter') as 'meter' | 'refuse';
  if (!['meter', 'refuse'].includes(streaming)) throw new Error('--streaming must be meter or refuse');
  const upstream: Partial<Record<ProviderName, string>> = {};
  argv.forEach((a, i) => {
    if (a !== '--upstream') return;
    const [prov, base] = [argv[i + 1].slice(0, argv[i + 1].indexOf('=')), argv[i + 1].slice(argv[i + 1].indexOf('=') + 1)];
    if (!(prov in UPSTREAM) || !/^https?:\/\//.test(base)) throw new Error('--upstream must look like openai=http://host:port');
    upstream[prov as ProviderName] = base.replace(/\/$/, '');
  });
  const markersFile = one('--forbidden-markers');
  return {
    host: listen.slice(0, at), port, ledger, leaseUsd: Number(lease), runId, usageLog: one('--usage-log') ?? null,
    allowModels: one('--allow-models') ? one('--allow-models')!.split(',').map(s => s.trim()).filter(Boolean) : null,
    maxOutputTokens: Number(one('--max-output-tokens') ?? DEFAULT_MAX_OUTPUT_TOKENS),
    forbiddenMarkers: markersFile ? readFileSync(markersFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : [],
    streaming, upstream,
  };
}

export function startLeaseProxy(a: ProxyCliArgs, env: Record<string, string | undefined> = process.env): MeteringProxy {
  const lease = BudgetRun.openLease({ runId: a.runId, leaseUsd: a.leaseUsd, ledgerPath: a.ledger, runner: 'metering-proxy' });
  const proxy = new MeteringProxy({ hostname: a.host, port: a.port, upstream: a.upstream,
    policy: { lease, env, allowModels: a.allowModels, maxOutputTokens: a.maxOutputTokens, forbiddenMarkers: a.forbiddenMarkers, streaming: a.streaming, usageLog: a.usageLog ?? `${lease.ledgerPath}.usage.ndjson` } });
  proxy.start();
  return proxy;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === 'summary') {
      const one = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
      const s = ledgerStatus({ ledgerPath: one('--budget-ledger'), runId: one('--run-id') });
      if (!s.run) throw new Error(`no lease ${one('--run-id')} in ${s.ledger}`);
      console.log(JSON.stringify({ run_id: s.run.run_id, lease_usd: s.run.budget_usd, committed_usd: s.run.committed_usd, overshoot_usd: s.run.overshoot_usd, requests: s.totals.requests, finished_at: s.run.finished_at }));
    } else {
      const a = parseProxyArgs(argv);
      const proxy = startLeaseProxy(a);
      const keys = (Object.keys(KEY_ENV) as ProviderName[]).filter(p => process.env[KEY_ENV[p]]);
      process.stderr.write(`[metering-proxy] lease ${a.runId} $${a.leaseUsd.toFixed(2)} on ${a.host}:${proxy.port}; providers with keys: ${keys.join(', ') || 'none'}; ledger ${a.ledger}\n`);
      const stop = () => { proxy.stop(); process.stderr.write(`[metering-proxy] stopped: ${JSON.stringify(proxy.status())}\n`); process.exit(0); };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    }
  } catch (e) {
    process.stderr.write(`[metering-proxy] ${(e as Error).message}\n`);
    process.exit(e instanceof BudgetExceededError ? 3 : 2);
  }
}
