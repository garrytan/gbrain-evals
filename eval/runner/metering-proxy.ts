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
 *     responses from their usage events (or charges the reservation), settles
 *     a 4xx answer without usage at $0 (providers do not bill rejected
 *     requests; a 5xx, a timeout or a lost connection keeps the reservation), refuses
 *     bodies carrying a forbidden marker (the sanitizer's leak tripwire), and
 *     appends one usage line per request (never a body or a key).
 *
 * Attribution across processes (lease mode): the harness binds a slot (the
 * path segment a shim's base URL carries) to a key around each question or
 * namespace ingest and reads the key's meter afterwards, through
 * `POST /__proxy/bind {slot, key}`, `POST /__proxy/unbind {slot}` and
 * `POST /__proxy/finalize {key}`. With `--control-token` (or
 * SHOOTOUT_PROXY_CONTROL_TOKEN) these need the `x-proxy-control` header, so a
 * vendor container cannot move charges.
 *
 * Standalone (lease mode):
 *   bun eval/runner/metering-proxy.ts --listen 0.0.0.0:8787 --budget-ledger <file> --lease-usd <n> --run-id <id>
 *     [--usage-log <file>] [--allow-models openai:gpt-4.1-mini,...] [--max-output-tokens 32768]
 *     [--forbidden-markers <file>] [--streaming meter|refuse] [--upstream openai=http://...] [--new-run] [--control-token <t>]
 *     [--cell-token <t> [--trust-local]] [--route-caps extraction=4096,reader=2048,judge=1024 --route-class harness=reader,judge=judge]
 *     [--admission openai=rpm:500,tpm:2000000,concurrency:16]... [--admission-max-wait-s 600]
 *   bun eval/runner/metering-proxy.ts summary --budget-ledger <file> --run-id <id> [--usage-log <file>]
 *
 * One lease ledger can hold a cell's reruns: each run id is its own lease, the
 * output cap is recorded with the lease, and `--new-run` closes a lease still
 * open in the file before opening the next one.
 *
 * Scoreboard metering (lease mode; the Q1 scoreboard, docs/scoreboard.md):
 *   cell token  With `--cell-token` a provider route answers only a request
 *     that presents the cell's token: as its credential (`Authorization:
 *     Bearer`, `x-api-key`, `api-key`), as `x-proxy-cell`, or as a `/_t/<token>`
 *     path prefix. `--trust-local` also admits requests from this machine
 *     (loopback and Docker bridge addresses, 172.16.0.0/12), so a harness and
 *     shims that still hold a fixed dummy key keep working while nothing off
 *     the VM can spend the lease.
 *   attribution  Every request gets a stable id (`<run>-<n>`, also returned as
 *     `x-proxy-request-id`), the slot it came in on, the brain and phase the
 *     harness bound (`/__proxy/bind {slot, key, brain?, phase?}`,
 *     `/__proxy/phase {slot, phase}`), and a bucket: `attributed`, or
 *     `unattributed-background` when no key was bound (late background work).
 *     Phases (`commit` during /ingest calls, `background` from the last /ingest
 *     to /finish ready, `query`) are labels; cost-speed.ts splits commit from
 *     background only for systems whose capability record says synchronous.
 *   route output caps  `--route-caps extraction=4096,reader=2048,judge=1024` with
 *     `--route-class harness=reader,judge=judge` (other slots use
 *     `--default-route-class`, extraction by default) replace the one output
 *     cap, so a 5xx keeps a small reservation instead of 32,768 tokens.
 *   billed and reserved  Meters, usage lines and the summary report billed
 *     dollars (usage the provider reported) apart from reserved-unsettled
 *     dollars (a 5xx, timeout, lost stream or missing usage charged at its
 *     reservation).
 *   admission  `--admission openai=rpm:500,tpm:2000000,concurrency:16` (one
 *     per provider) queues requests under requests per minute, tokens per
 *     minute (input bound plus output cap) and concurrency, and pauses a
 *     provider for its `retry-after` after a 429 or 503. One AdmissionController
 *     is shared by every cell a process serves; the campaign launcher gives
 *     each concurrent cell on one key its share of the key's limits. A 429
 *     counts as upstream trouble, so the harness retries it like a 5xx.
 */
import { timingSafeEqual } from 'node:crypto';
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
/** A provider call may run this long (Bun's own 300-second fetch timeout is off; long reasoning calls exceed it). */
export const UPSTREAM_DEADLINE_MS = 900_000;

export interface Meter {
  usd: number;
  requests: number;
  /** Requests whose cost came from their reservation because the response reported no usage (charged, not free). */
  unpriced: number;
  /** Requests still in flight when the meter was finalized after its timeout (their cost is missing here, not in the ledger). */
  undrained?: number;
  byModel: Record<string, { usd: number; requests: number }>;
  /** Lease mode: what the provider answered (HTTP status counts, connection failures, 200 bodies that were not JSON), so a report can tell provider outages from product bugs. */
  upstream?: { statuses: Record<string, number>; failed: number; unparseable: number };
  /** Dollars from usage the provider reported. */
  billed_usd?: number;
  /** Dollars charged at a reservation because no usage came back (a 5xx, a timeout, a lost stream). */
  reserved_unsettled_usd?: number;
}
export const newMeter = (): Meter => ({ usd: 0, requests: 0, unpriced: 0, byModel: {} });

/** True when the provider itself misbehaved during a meter's requests: a 429, a 5xx, a lost connection, or a 200 that was not JSON. */
export const upstreamTrouble = (m: Meter | null | undefined) => !!m?.upstream && (m.upstream.failed > 0 || m.upstream.unparseable > 0 || Object.keys(m.upstream.statuses).some(s => Number(s) >= 500 || Number(s) === 429));

/** Output-token caps by route class, and which slot belongs to which class. */
export interface RouteCaps { caps: Record<string, number>; slots: Record<string, string>; defaultClass: string }
export const DEFAULT_ROUTE_CAPS: Record<string, number> = { extraction: 4096, reader: 2048, judge: 1024 };

export type Phase = 'commit' | 'background' | 'query';
export const PHASES: readonly Phase[] = ['commit', 'background', 'query'];

export interface ProviderLimits { rpm?: number; tpm?: number; concurrency?: number }

/**
 * Shared provider admission: requests per minute, tokens per minute and
 * concurrency per provider, plus a pause after a 429 or 503 that names a
 * retry-after. Every cell a process serves shares one controller, so cells on
 * one key cannot jointly exceed its limits. A request that cannot be admitted
 * within `maxWaitMs` is refused with 429 before it reaches the provider.
 */
export class AdmissionController {
  private state = new Map<string, { inflight: number; window: Array<{ at: number; tokens: number }>; pausedUntil: number }>();
  readonly stats = { admitted: 0, waited_ms: 0, refused: 0, pauses: 0 };
  constructor(readonly limits: Partial<Record<ProviderName, ProviderLimits>>, private opts: { maxWaitMs?: number; now?: () => number; pollMs?: number } = {}) {}
  private now() { return this.opts.now ? this.opts.now() : Date.now(); }
  private s(p: string) { let x = this.state.get(p); if (!x) this.state.set(p, x = { inflight: 0, window: [], pausedUntil: 0 }); return x; }
  /** How long `provider` must wait before a request of `tokens` fits, 0 when it fits now. */
  waitFor(provider: string, tokens: number): number {
    const lim = this.limits[provider as ProviderName];
    const s = this.s(provider);
    const t = this.now();
    s.window = s.window.filter(e => e.at > t - 60_000);
    let wait = Math.max(0, s.pausedUntil - t);
    if (!lim) return wait;
    if (lim.concurrency && s.inflight >= lim.concurrency) wait = Math.max(wait, this.opts.pollMs ?? 25);
    if (lim.rpm && s.window.length >= lim.rpm) wait = Math.max(wait, s.window[s.window.length - lim.rpm].at + 60_000 - t);
    if (lim.tpm) {
      let used = s.window.reduce((n, e) => n + e.tokens, 0);
      if (used + tokens > lim.tpm && tokens <= lim.tpm) {
        for (const e of s.window) { used -= e.tokens; if (used + tokens <= lim.tpm) { wait = Math.max(wait, e.at + 60_000 - t); break; } }
      }
    }
    return wait;
  }
  /** Admit one request; resolves when it fits, with `release` to call when it finishes (with the tokens it really used). */
  async acquire(provider: string, tokens: number): Promise<{ waited_ms: number; release: (actualTokens?: number) => void }> {
    const started = this.now();
    const maxWait = this.opts.maxWaitMs ?? 600_000;
    for (;;) {
      const w = this.waitFor(provider, tokens);
      if (w <= 0) break;
      if (this.now() - started + w > maxWait) { this.stats.refused++; throw new AdmissionRefused(provider, w); }
      await Bun.sleep(Math.min(w, 1000));
    }
    const s = this.s(provider);
    const entry = { at: this.now(), tokens };
    s.window.push(entry);
    s.inflight++;
    const waited = this.now() - started;
    this.stats.admitted++;
    this.stats.waited_ms += waited;
    let done = false;
    return { waited_ms: waited, release: (actual?: number) => { if (done) return; done = true; s.inflight--; if (actual !== undefined && Number.isFinite(actual)) entry.tokens = actual; } };
  }
  /** Stop admitting `provider` for `ms` (a retry-after from the provider). */
  pause(provider: string, ms: number) {
    if (!(ms > 0)) return;
    const s = this.s(provider);
    s.pausedUntil = Math.max(s.pausedUntil, this.now() + Math.min(ms, 600_000));
    this.stats.pauses++;
  }
}

export class AdmissionRefused extends Error {
  constructor(readonly provider: string, readonly retryAfterMs: number) {
    super(`admission control: ${provider} is at its shared rate limit for longer than the wait bound (next slot in ${Math.ceil(retryAfterMs / 1000)} s)`);
    this.name = 'AdmissionRefused';
  }
}

/** A provider's retry hint in milliseconds: `retry-after-ms`, `retry-after` seconds, or an HTTP date. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') !== null && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** `openai=rpm:500,tpm:2000000,concurrency:16` (one provider per flag). */
export function parseAdmission(values: string[]): Partial<Record<ProviderName, ProviderLimits>> {
  const out: Partial<Record<ProviderName, ProviderLimits>> = {};
  for (const v of values) {
    const at = v.indexOf('=');
    const prov = v.slice(0, at) as ProviderName;
    if (at <= 0 || !(prov in UPSTREAM)) throw new Error(`--admission must look like openai=rpm:500,tpm:2000000,concurrency:16 (got ${JSON.stringify(v)})`);
    const lim: ProviderLimits = {};
    for (const part of v.slice(at + 1).split(',').filter(Boolean)) {
      const [k, n] = part.split(':');
      if (!['rpm', 'tpm', 'concurrency'].includes(k) || !(Number(n) > 0) || !Number.isInteger(Number(n))) throw new Error(`--admission ${prov}: ${part} must be rpm, tpm or concurrency with a positive whole number`);
      lim[k as keyof ProviderLimits] = Number(n);
    }
    out[prov] = lim;
  }
  return out;
}

const parseMap = (raw: string | undefined, flag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(',').map(x => x.trim()).filter(Boolean)) {
    const at = part.indexOf('=');
    if (at <= 0) throw new Error(`${flag} must look like a=b,c=d (got ${JSON.stringify(part)})`);
    out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
};

/** True for this machine's own addresses: loopback and Docker bridge networks (172.16.0.0/12). */
export function isLocalAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  if (a === '::1') return true;
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 127 || (x === 172 && y >= 16 && y <= 31);
}

const sameToken = (a: string | null | undefined, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface LeasePolicy {
  /** The lease this proxy spends; every request is reserved against it before it is forwarded. */
  lease: BudgetRun;
  /** Where real keys come from (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** When set, only these `provider:model` ids may be called (they must also be priced). */
  allowModels?: string[] | null;
  /** Output-token cap injected when a request names none; a request naming more is refused. */
  maxOutputTokens?: number;
  /** Per-route output caps; when set they replace `maxOutputTokens` by the slot's route class. */
  routeCaps?: RouteCaps;
  /** Shared provider admission (rate limits, concurrency, retry-after). */
  admission?: AdmissionController;
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
  /** Stable per-request id (`<run>-<n>`), the slot, the brain and phase bound when it arrived, and its bucket. */
  request_id?: string; slot?: string; brain?: string | null; phase?: Phase | null; bucket?: Bucket;
  route_class?: string; output_cap?: number; admission_wait_ms?: number; retry_after_ms?: number;
}

/** How one provider request is attributed: its stable id, the slot it came in on, the bound brain and phase, and its bucket. */
export interface RequestTag { request_id: string; slot: string; brain: string | null; phase: Phase | null; bucket: Bucket }
/** `harness`: the harness's own reader and judge slots, never background work. */
export type Bucket = 'attributed' | 'harness' | 'unattributed-background';
export const HARNESS_CLASSES = new Set(['reader', 'judge']);

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
  readonly counts = { forwarded: 0, refused: 0, failed: 0, tripwires: 0, unauthorized: 0 };
  /** Lease mode totals: billed (provider-reported usage) and reserved-unsettled dollars, and the unattributed-background bucket by slot. */
  readonly totals = { billed_usd: 0, reserved_unsettled_usd: 0 };
  readonly unattributed = new Map<string, { usd: number; requests: number }>();
  private bindings = new Map<string, { key: string; brain: string | null; phase: Phase | null }>();
  private phases = new Map<string, Phase>();
  private seq = 0;
  private inflight = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();
  constructor(private options: { fetchImpl?: typeof fetch; hostname?: string; port?: number; upstream?: Partial<Record<ProviderName, string>>; policy?: LeasePolicy; controlToken?: string | null;
    /** Provider routes answer only requests that present this token (credential, `x-proxy-cell` or a `/_t/<token>` prefix). */
    cellToken?: string | null;
    /** With a cell token: also admit requests from this machine (loopback, Docker bridges). */
    trustLocal?: boolean } = {}) {}
  get port(): number { return this.server!.port as number; }
  /** Charge the slot's provider requests to `key` (a cell id) from now on, labeled with the brain and phase when given. */
  bind(slot: string, key: string, tag: { brain?: string | null; phase?: Phase | null } = {}) { this.bindings.set(slot, { key, brain: tag.brain ?? null, phase: tag.phase ?? null }); }
  unbind(slot: string) { this.bindings.delete(slot); }
  /** Label the slot's later requests with a phase (commit, background, query) until it changes; a binding's own phase wins. */
  setPhase(slot: string, phase: Phase | null) { if (phase) this.phases.set(slot, phase); else this.phases.delete(slot); }
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
  /** The harness's reader and judge slots (by route class, else `harness` and `judge`). */
  private harnessSlot(slot: string): boolean {
    const rc = this.options.policy?.routeCaps;
    return rc ? HARNESS_CLASSES.has(rc.slots[slot] ?? rc.defaultClass) : slot === 'harness' || slot === 'judge';
  }
  /** True when the request may use a provider route: no cell token is set, it presents the token, or it is local and local callers are trusted. */
  private authorized(req: Request, pathToken: string | null, ip: string | null): boolean {
    const token = this.options.cellToken;
    if (!token) return true;
    const auth = req.headers.get('authorization');
    const presented = [pathToken, req.headers.get('x-proxy-cell'), auth?.replace(/^Bearer\s+/i, '') ?? null, req.headers.get('x-api-key'), req.headers.get('api-key')];
    if (presented.some(p => sameToken(p, token))) return true;
    return !!this.options.trustLocal && isLocalAddress(ip);
  }
  start() {
    const send: Send = this.options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.server = Bun.serve({
      port: this.options.port ?? 0, hostname: this.options.hostname ?? '127.0.0.1', idleTimeout: 0,
      fetch: async (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === '/__proxy/status' && req.method === 'GET') return Response.json(this.status());
        if (url.pathname.startsWith('/__proxy/') && req.method === 'POST') return this.control(url.pathname, req);
        const t = url.pathname.match(/^\/_t\/([^/]+)(\/.*)$/);
        const path = t ? t[2] : url.pathname;
        const m = path.match(/^\/(?:([^/]+)\/)?(anthropic|openai|voyage)(\/.*)$/);
        if (!m) return json(404, 'invalid_request', `no provider route ${t ? '/_t/<token>' + path : path}`);
        const [, slot = 'default', prov, rest] = m as unknown as [string, string | undefined, ProviderName, string];
        if (!this.authorized(req, t ? decodeURIComponent(t[1]) : null, server.requestIP(req)?.address ?? null)) {
          this.counts.unauthorized++;
          this.log({ at: new Date().toISOString(), key: `slot:${slot}`, provider: prov, route: rest, model: null, outcome: 'refused', reason: 'no cell token', status: 401, slot });
          return json(401, 'invalid_request', "provider routes need this cell's token (send it as the API key, as x-proxy-cell, or as a /_t/<token> path prefix); the proxy never forwards for a caller off the cell");
        }
        const bound = this.bindings.get(slot);
        const key = bound?.key ?? `slot:${slot}`;
        const tag: RequestTag = { request_id: `${this.options.policy?.lease.runId ?? 'proxy'}-${++this.seq}`, slot, brain: bound?.brain ?? req.headers.get('x-proxy-brain') ?? null,
          phase: bound?.phase ?? this.phases.get(slot) ?? null, bucket: bound ? 'attributed' : this.harnessSlot(slot) ? 'harness' : 'unattributed-background' };
        this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
        let streaming = false;
        try {
          const r = this.options.policy
            ? await this.forwardLeased(req, prov, rest, url.search, key, send, () => { streaming = true; return () => this.settled(key); }, tag)
            : await this.forwardInProcess(req, slot, prov, rest, url.search, key, send);
          r.headers.set('x-proxy-request-id', tag.request_id);
          return r;
        } finally { if (!streaming) this.settled(key); }
      },
    });
  }
  stop() { this.server?.stop(true); }

  status() {
    const p = this.options.policy;
    const run = p ? ledgerStatus({ ledgerPath: p.lease.ledgerPath, runId: p.lease.runId }).run : null;
    const unattributed = Object.fromEntries(this.unattributed);
    return { mode: p ? 'lease' : 'in-process', run_id: p?.lease.runId ?? null, lease_usd: p?.lease.budgetUsd ?? null, committed_usd: run?.committed_usd ?? null,
      max_output_tokens: p ? p.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS : null, ...this.counts,
      ...(p ? { billed_usd: this.totals.billed_usd, reserved_unsettled_usd: this.totals.reserved_unsettled_usd, unattributed_background: unattributed,
        route_caps: p.routeCaps ?? null, admission: p.admission ? { limits: p.admission.limits, ...p.admission.stats } : null, cell_token: !!this.options.cellToken, trust_local: !!this.options.trustLocal } : {}) };
  }

  private async control(path: string, req: Request): Promise<Response> {
    if (this.options.controlToken && req.headers.get('x-proxy-control') !== this.options.controlToken) return json(403, 'invalid_request', 'control endpoints need the x-proxy-control token');
    let body: { slot?: string; key?: string; timeout_ms?: number; brain?: string | null; phase?: Phase | null };
    try { body = await req.json() as typeof body; } catch { return json(400, 'invalid_request', 'control body is not JSON'); }
    if (body.phase !== undefined && body.phase !== null && !PHASES.includes(body.phase)) return json(400, 'invalid_request', `phase must be one of ${PHASES.join(', ')}`);
    if (path === '/__proxy/bind' && body.slot && body.key) { this.bind(body.slot, body.key, { brain: body.brain, phase: body.phase }); return Response.json({ ok: true }); }
    if (path === '/__proxy/unbind' && body.slot) { this.unbind(body.slot); return Response.json({ ok: true }); }
    if (path === '/__proxy/phase' && body.slot) { this.setPhase(body.slot, body.phase ?? null); return Response.json({ ok: true }); }
    if (path === '/__proxy/finalize' && body.key) return Response.json(await this.finalize(body.key, Math.min(Number(body.timeout_ms ?? 30_000), 120_000)));
    return json(404, 'invalid_request', `no control route ${path}`);
  }

  private observe(key: string, status: number | 'failed' | 'unparseable') {
    const m = this.meter(key);
    m.upstream ??= { statuses: {}, failed: 0, unparseable: 0 };
    if (status === 'failed') m.upstream.failed++;
    else if (status === 'unparseable') m.upstream.unparseable++;
    else m.upstream.statuses[String(status)] = (m.upstream.statuses[String(status)] ?? 0) + 1;
  }

  private charge(key: string, prov: string, model: string | null, usd: number, unpriced: boolean, tag?: RequestTag) {
    const meter = this.meter(key);
    meter.requests++;
    meter.usd += usd;
    if (unpriced) meter.unpriced++;
    if (model) { const k = `${prov}:${model}`; meter.byModel[k] ??= { usd: 0, requests: 0 }; meter.byModel[k].usd += usd; meter.byModel[k].requests++; }
    if (!this.options.policy) return;
    if (unpriced) { meter.reserved_unsettled_usd = (meter.reserved_unsettled_usd ?? 0) + usd; this.totals.reserved_unsettled_usd += usd; }
    else { meter.billed_usd = (meter.billed_usd ?? 0) + usd; this.totals.billed_usd += usd; }
    if (tag?.bucket === 'unattributed-background') {
      const b = this.unattributed.get(tag.slot) ?? { usd: 0, requests: 0 };
      b.usd += usd; b.requests++;
      this.unattributed.set(tag.slot, b);
    }
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
  private async forwardLeased(req: Request, prov: ProviderName, route: string, search: string, key: string, send: Send, beginStream: () => () => void, tag: RequestTag): Promise<Response> {
    const p = this.options.policy!;
    const at = new Date().toISOString();
    const routeClass = p.routeCaps ? p.routeCaps.slots[tag.slot] ?? p.routeCaps.defaultClass : undefined;
    const cap = routeClass !== undefined && p.routeCaps!.caps[routeClass] !== undefined ? p.routeCaps!.caps[routeClass] : p.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const tagged = { request_id: tag.request_id, slot: tag.slot, brain: tag.brain, phase: tag.phase, bucket: tag.bucket, ...(routeClass !== undefined ? { route_class: routeClass } : {}), output_cap: cap };
    const refuse = (status: number, kind: string, reason: string, model: string | null = null, extra: Record<string, string> = {}) => {
      this.log({ at, key, provider: prov, route, model, outcome: 'refused', reason, status, ...tagged });
      const r = json(status, kind, reason);
      for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
      return r;
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
    // Output caps bind only the harness's own calls (readers, judges). A system under test sends its requests as it
    // would in production: the proxy never rewrites or refuses them for their output allowance, because that would
    // change the system being measured. Its reservation is the allowance it states (budget-ledger priceRequest), and a
    // request that states none reserves the default allowance.
    if (field && body && this.harnessSlot(tag.slot)) {
      const stated = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens].filter((v): v is number => typeof v === 'number');
      if (stated.some(v => v > cap)) return refuse(400, 'invalid_request', `requested ${Math.max(...stated)} output tokens, above this cell's ${routeClass !== undefined ? `${routeClass} route ` : ''}cap of ${cap}`, model);
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
    let admitted: Awaited<ReturnType<AdmissionController['acquire']>> | null = null;
    if (p.admission) {
      try { admitted = await p.admission.acquire(prov, bounded ? bounded.inputTokens + bounded.maxOutputTokens : 0); }
      catch (e) {
        if (!(e instanceof AdmissionRefused)) throw e;
        return refuse(429, 'rate_limited', e.message, model, { 'retry-after': String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))) });
      }
    }
    let entry: string | null = null;
    if (bounded) {
      try { entry = p.lease.reserve(reserved, `${prov}:${bounded.model} ${bounded.kind} [${key}]`); }
      catch (e) { admitted?.release(0); return refuse(402, 'budget', (e as Error).message, model); }
    }
    const headers = new Headers(req.headers);
    for (const h of ['host', 'content-length', 'accept-encoding', 'connection', 'x-proxy-cell', 'x-proxy-brain', ...CREDENTIAL_HEADERS]) headers.delete(h);
    if (prov === 'anthropic') { headers.set('x-api-key', realKey); if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01'); }
    else headers.set('authorization', `Bearer ${realKey}`);
    if (outBody !== undefined) headers.set('content-type', 'application/json');
    const waitMs = admitted?.waited_ms;
    const settle = (cost: ReturnType<typeof usageCost>, status: number, isStream: boolean, retryAfter: number | null = null) => {
      if (entry) p.lease.settle(entry, cost);
      admitted?.release(cost ? cost.input_tokens + cost.output_tokens : undefined);
      const usd = cost ? cost.usd : reserved;
      this.charge(key, prov, bounded?.model ?? null, usd, !!bounded && !cost, tag);
      this.log({ at, key, provider: prov, route, model: bounded?.model ?? model, outcome: 'forwarded', status, reserved_usd: reserved, actual_usd: usd,
        input_tokens: cost?.input_tokens, output_tokens: cost?.output_tokens, charged_reservation: !!bounded && !cost, streamed: isStream, ...tagged,
        ...(waitMs ? { admission_wait_ms: waitMs } : {}), ...(retryAfter !== null ? { retry_after_ms: retryAfter } : {}) });
    };
    let res: Response;
    try { res = await send(target, { method: req.method, headers, body: outBody, timeout: false, signal: AbortSignal.timeout(UPSTREAM_DEADLINE_MS) } as RequestInit); }
    catch (e) {
      if (entry) p.lease.settle(entry, null);
      admitted?.release();
      this.charge(key, prov, bounded?.model ?? null, reserved, !!bounded, tag);
      this.observe(key, 'failed');
      this.log({ at, key, provider: prov, route, model, outcome: 'failed', reason: (e as Error).message.slice(0, 300), reserved_usd: reserved, actual_usd: reserved, charged_reservation: !!bounded, ...tagged });
      return json(502, 'product_error', `upstream failed: ${(e as Error).message}`);
    }
    const hint = res.status === 429 || res.status === 503 ? retryAfterMs(res.headers) : null;
    if (hint !== null) p.admission?.pause(prov, hint);
    const out = new Headers(res.headers);
    for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) out.delete(h);
    if ((res.headers.get('content-type') ?? '').includes('event-stream') && res.body) {
      const done = beginStream();
      const [client, meterBranch] = res.body.tee();
      this.observe(key, res.status);
      void new Response(meterBranch).text().then(
        text => { const u = sseUsage(text); settle(bounded && u ? usageCost(bounded, { usage: u }) : null, res.status, true, hint); },
        () => settle(null, res.status, true, hint),
      ).finally(done);
      return new Response(client, { status: res.status, headers: out });
    }
    const text = await res.text();
    let cost: ReturnType<typeof usageCost> = null;
    let parsed = true;
    try { JSON.parse(text); } catch { parsed = false; }
    this.observe(key, res.ok && !parsed ? 'unparseable' : res.status);
    if (bounded && parsed) cost = usageCost(bounded, JSON.parse(text));
    if (!cost && bounded && res.status >= 400 && res.status < 500) cost = { usd: 0, input_tokens: 0, output_tokens: 0 };
    settle(cost, res.status, false, hint);
    return new Response(text, { status: res.status, headers: out });
  }
}

/** The harness side of cross-process attribution: bind a slot to a key around a question or an ingest, then read its meter. */
export class ProxyControl {
  constructor(private base: string, private token: string | null = process.env.SHOOTOUT_PROXY_CONTROL_TOKEN ?? null) {}
  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.base.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.token ? { 'x-proxy-control': this.token } : {}) }, body: JSON.stringify(body), keepalive: false });
    if (!res.ok) throw new Error(`metering proxy ${path}: HTTP ${res.status}`);
    return res.json();
  }
  bind(slot: string, key: string, tag: { brain?: string | null; phase?: Phase | null } = {}) { return this.post('/__proxy/bind', { slot, key, ...tag }); }
  unbind(slot: string) { return this.post('/__proxy/unbind', { slot }); }
  /** Label the slot's later requests with a phase: `commit` during /ingest calls, `background` from the last /ingest to /finish ready, `query`. */
  phase(slot: string, phase: Phase | null) { return this.post('/__proxy/phase', { slot, phase }); }
  finalize(key: string, timeoutMs = 30_000) { return this.post('/__proxy/finalize', { key, timeout_ms: timeoutMs }) as Promise<Meter>; }
  /** Run `fn` with the slot's provider calls charged to `key`; returns its result and the key's meter. */
  async around<T>(slot: string, key: string, fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; meter: Meter }> {
    await this.bind(slot, key);
    let value: T | undefined, error: unknown;
    try { value = await fn(); } catch (e) { error = e; }
    await this.unbind(slot);
    return { value, error, meter: await this.finalize(key) };
  }
}

export interface ProxyCliArgs {
  host: string; port: number; ledger: string; leaseUsd: number; runId: string; usageLog: string | null;
  allowModels: string[] | null; maxOutputTokens: number | null; forbiddenMarkers: string[]; streaming: 'meter' | 'refuse'; upstream: Partial<Record<ProviderName, string>>; newRun: boolean;
  controlToken: string | null;
  cellToken: string | null; trustLocal: boolean; routeCaps: RouteCaps | null; admission: Partial<Record<ProviderName, ProviderLimits>> | null; admissionMaxWaitMs: number | null;
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
    maxOutputTokens: one('--max-output-tokens') ? Number(one('--max-output-tokens')) : null,
    forbiddenMarkers: markersFile ? readFileSync(markersFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : [],
    streaming, upstream, newRun: argv.includes('--new-run'), controlToken: one('--control-token') ?? process.env.SHOOTOUT_PROXY_CONTROL_TOKEN ?? null,
    cellToken: one('--cell-token') ?? process.env.SHOOTOUT_CELL_TOKEN ?? null, trustLocal: argv.includes('--trust-local'), routeCaps: parseRouteCaps(argv),
    admission: argv.includes('--admission') ? parseAdmission(argv.flatMap((x, i) => x === '--admission' ? [argv[i + 1]] : [])) : null,
    admissionMaxWaitMs: one('--admission-max-wait-s') ? Number(one('--admission-max-wait-s')) * 1000 : null,
  };
}

/** `--route-caps extraction=4096,reader=2048,judge=1024 --route-class harness=reader,judge=judge [--default-route-class extraction]`; null without --route-caps. */
export function parseRouteCaps(argv: string[]): RouteCaps | null {
  const one = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (!argv.includes('--route-caps')) return null;
  const caps: Record<string, number> = {};
  for (const [k, v] of Object.entries(parseMap(one('--route-caps'), '--route-caps'))) {
    if (!(Number(v) > 0) || !Number.isInteger(Number(v))) throw new Error(`--route-caps ${k}: ${v} must be a positive whole number of output tokens`);
    caps[k] = Number(v);
  }
  const slots = parseMap(one('--route-class'), '--route-class');
  const defaultClass = one('--default-route-class') ?? 'extraction';
  for (const c of [...Object.values(slots), defaultClass]) if (!(c in caps)) throw new Error(`route class ${c} has no cap in --route-caps`);
  return { caps, slots, defaultClass };
}

/** Billed against reserved-unsettled dollars, and the unattributed-background bucket, from a usage log. */
export function usageSplit(usageLog: string): { billed_usd: number; reserved_unsettled_usd: number; unattributed_background_usd: number; requests: number; refused: number; unauthorized: number } {
  const out = { billed_usd: 0, reserved_unsettled_usd: 0, unattributed_background_usd: 0, requests: 0, refused: 0, unauthorized: 0 };
  for (const line of readFileSync(usageLog, 'utf8').split('\n').filter(Boolean)) {
    const u = JSON.parse(line) as UsageLine;
    if (u.outcome === 'refused') { out.refused++; if (u.status === 401) out.unauthorized++; continue; }
    out.requests++;
    const usd = u.actual_usd ?? 0;
    if (u.charged_reservation) out.reserved_unsettled_usd += usd; else out.billed_usd += usd;
    if (u.bucket === 'unattributed-background') out.unattributed_background_usd += usd;
  }
  return out;
}

export function startLeaseProxy(a: ProxyCliArgs, env: Record<string, string | undefined> = process.env): MeteringProxy {
  const lease = BudgetRun.openLease({ runId: a.runId, leaseUsd: a.leaseUsd, ledgerPath: a.ledger, runner: 'metering-proxy', maxOutputTokens: a.maxOutputTokens, newRun: a.newRun });
  const proxy = new MeteringProxy({ hostname: a.host, port: a.port, upstream: a.upstream, controlToken: a.controlToken, cellToken: a.cellToken, trustLocal: a.trustLocal,
    policy: { lease, env, allowModels: a.allowModels, maxOutputTokens: a.maxOutputTokens ?? undefined, forbiddenMarkers: a.forbiddenMarkers, streaming: a.streaming, usageLog: a.usageLog ?? `${lease.ledgerPath}.usage.ndjson`,
      ...(a.routeCaps ? { routeCaps: a.routeCaps } : {}), ...(a.admission ? { admission: new AdmissionController(a.admission, { maxWaitMs: a.admissionMaxWaitMs ?? undefined }) } : {}) } });
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
      const requests = BudgetRun.runRequests(s.ledger, s.run.run_id);
      const usage = one('--usage-log') ? usageSplit(one('--usage-log')!) : null;
      console.log(JSON.stringify({ run_id: s.run.run_id, lease_usd: s.run.budget_usd, committed_usd: s.run.committed_usd, overshoot_usd: s.run.overshoot_usd, requests,
        max_output_tokens: BudgetRun.leaseMaxOutputTokens(s.ledger, s.run.run_id) ?? DEFAULT_MAX_OUTPUT_TOKENS, finished_at: s.run.finished_at, ...(usage ? { usage } : {}) }));
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
