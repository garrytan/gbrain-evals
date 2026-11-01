/**
 * Metering proxy: the one paid-request boundary for every process in a
 * harness cell (eval/harness-provider/CONTRACTS.md, "Metering proxy").
 *
 * The launcher starts it in-process on 127.0.0.1. Each child process gets a
 * proxy token per provider (`mpwp-<label>-<hex>`) and base URLs that point
 * here, never a real key. For every request the proxy
 *
 *   1. checks the token (Authorization Bearer, x-api-key, x-goog-api-key or
 *      ?key=); an unknown token answers 401 and nothing is sent;
 *   2. saves the exact request body to `bodiesDir/<sha256>.json`;
 *   3. prices it with the shared ledger's `priceRequest` and reserves the
 *      worst case on the cell's BudgetRun; a refused reservation, or a
 *      request that cannot be priced, answers HTTP 402 with
 *      `{"error":{"type":"mpw_budget_refused",...}}` and nothing is sent;
 *   4. swaps the token for the real key and forwards the request;
 *   5. streams the response back (server-sent events are teed, not
 *      buffered), decodes the provider's usage and settles the reservation.
 *
 * The Particle row comes from COMPAT_PROVIDERS (eval/runner/providers/openai-compatible.ts):
 * prefix `/particle`, upstream the origin of the table's default base URL,
 * the table's key variable, and children get `PARTICLE_BASE_URL=<proxy>/particle/v1`.
 *
 * Settlement: decoded usage reconciles the entry. A 4xx answer without usage
 * is a request the provider rejected before doing any work, so it settles at
 * $0. Anything else without decodable usage (a 5xx, a network failure after
 * sending, an unreadable stream) is charged at its reservation.
 *
 * Refusal messages never contain the substrings 429, 500, 502, 503, 504,
 * 529 or "rate": the harness's Gemini, OpenAI and Groq clients retry any
 * error whose text contains them. Where a value (a cap, a path, an id) would
 * contain one, a zero-width space is inserted; `lastRefusal` keeps the exact
 * text for the launcher.
 *
 * Every request appends one JSON line to `requestLogPath`. Beside the
 * pricing it records what the response says served it: the model it names,
 * its reasoning tokens and `response_meta` (raw `metadata` with any weight
 * version, `service_tier`, `system_fingerprint`), all null when the attempt
 * failed. The request side (effort sent and effective, output limit) is not
 * repeated in the log: `readRequestLog` joins it from the stored body by
 * `body_sha256`, so every particle request can be checked against bar 2 of
 * plan GST-605.
 *
 * CLI (a standalone proxy joined to an open budget run; prints nothing
 * secret, writes the child environments to the ready file with mode 0600):
 *
 *   bun eval/runner/metering-proxy.ts --budget-ledger <path> --budget-run-id <id> --cell-id <id> \
 *     --labels harness,gbrain --ready-file <json> [--request-log <jsonl>] [--bodies-dir <dir>] [--port <n>] \
 *     [--upstream <provider>=<url> ...]
 *
 * `--upstream` points a provider at a stub (tests); without it requests go
 * to the real provider with the key from this process's environment. An
 * upstream that is not loopback must be https, because the proxy sends the
 * real key there (issue #277).
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  BudgetExceededError, BudgetRun, ledgerStatus, priceRequest, reservationUsd, streamUsageCost, unguardedFetch, usageCost,
} from './budget-ledger.ts';
import { UPSTREAM_DEADLINE_MS } from './metering-proxy.ts';
import { carriesKeyInCleartext, COMPAT_PROVIDERS } from './providers/openai-compatible.ts';
import { normalizeUsage, responseMeta, type ResponseMeta } from './usage-receipt.ts';

export type MeteredProvider = 'openai' | 'anthropic' | 'gemini' | 'groq' | 'voyage' | 'particle';
type RequestPrice = NonNullable<ReturnType<typeof priceRequest>>;

const PARTICLE = COMPAT_PROVIDERS.particle;

/** Path prefix, real upstream and launcher key variables per provider (CONTRACTS.md table). */
export const METERED_PROVIDERS: Record<MeteredProvider, { prefix: string; upstream: string; keyEnv: string[] }> = {
  openai: { prefix: '/openai', upstream: 'https://api.openai.com', keyEnv: ['OPENAI_API_KEY'] },
  anthropic: { prefix: '/anthropic', upstream: 'https://api.anthropic.com', keyEnv: ['ANTHROPIC_API_KEY'] },
  gemini: { prefix: '/gemini', upstream: 'https://generativelanguage.googleapis.com', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] },
  groq: { prefix: '/groq', upstream: 'https://api.groq.com', keyEnv: ['GROQ_API_KEY'] },
  voyage: { prefix: '/voyage', upstream: 'https://api.voyageai.com', keyEnv: ['VOYAGE_API_KEY'] },
  particle: { prefix: '/particle', upstream: new URL(PARTICLE.base_url_default).origin, keyEnv: [PARTICLE.key_env] },
};
const PROVIDER_IDS = Object.keys(METERED_PROVIDERS) as MeteredProvider[];

/** Sent upstream in place of a key when a test points a provider at a stub and the launcher has no key for it. */
const STUB_CREDENTIAL = 'mpw-stub-upstream-no-key';
const STATUS_CLI = 'bun eval/runner/budget-ledger.ts status';

export const REFUSAL_TYPE = 'mpw_budget_refused';

export interface MeteringProxyOptions {
  run: BudgetRun;
  cellId: string;
  requestLogPath: string;
  bodiesDir: string;
  labels: string[];
  upstreams?: Partial<Record<MeteredProvider, string>>;
  realKeys?: Record<string, string | undefined>;
  port?: number;
}

export interface RequestLogLine {
  ts: string;
  cell_id: string;
  label: string | null;
  tag: string | null;
  provider: MeteredProvider;
  model: string | null;
  kind: string | null;
  method: string;
  path: string;
  body_sha256: string;
  stream: boolean;
  reserved_usd: number;
  actual_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** HTTP status returned to the client. */
  status: number;
  refused: boolean;
  /** free (not priced), reconciled, charged-reservation, rejected-unbilled, or null when nothing was reserved. */
  settlement: 'free' | 'reconciled' | 'charged-reservation' | 'rejected-unbilled' | null;
  error: string | null;
  /** The model the response named; null when it named none (a refusal, an error answer, a network failure). */
  response_model: string | null;
  /** Reasoning or thinking tokens, a subset of output_tokens; null when the response reported none. */
  reasoning_tokens: number | null;
  /** The response's raw metadata, weight version, service tier and system fingerprint; every field null when the attempt failed. */
  response_meta: ResponseMeta;
}

/** What a logged request sent that changes the answer, read from its stored body. */
export interface LoggedRequest {
  effort_sent: string | null;
  /** The level the provider runs the sent effort at, read from today's COMPAT_PROVIDERS table when the log is read; null outside that table. */
  effort_effective: string | null;
  /** The `source` (with its checked date) of the table row `effort_effective` came from; null when it is null. */
  effort_effective_source: string | null;
  output_limit_field: string | null;
  output_limit: number | null;
}

export interface ProxyTotals { requests: number; refused: number; reserved_usd: number; actual_usd: number; input_tokens: number; output_tokens: number }

export interface ProxyStats {
  total: ProxyTotals;
  byLabel: Record<string, ProxyTotals>;
  byProvider: Record<string, ProxyTotals>;
  exhausted: boolean;
}

export interface MeteringProxy {
  url: string;
  port: number;
  /** label -> proxy token. */
  tokens: Record<string, string>;
  /** Proxy base URL per provider, for config files (gbrain `provider_base_urls.voyage`). */
  baseUrls: Record<MeteredProvider, string>;
  /** Child environment variables for `label`: base URLs and that label's token, for providers with a key or an upstream override. */
  envFor(label: string): Record<string, string>;
  stats(): ProxyStats;
  /** True once any request was refused for budget or price. */
  readonly exhausted: boolean;
  /** The exact text of the latest refusal (no retry-safe escaping). */
  readonly lastRefusal: string | null;
  /** Wait for in-flight settlements, then stop listening. */
  close(): Promise<void>;
}

const RETRY_TRIGGERS = /429|50[0234]|529|rate/i;

/**
 * Break every substring a client's retry check looks for (429, 500, 502,
 * 503, 504, 529, "rate") with a zero-width space, so a refusal is final.
 */
export function retrySafe(text: string): string {
  let out = text;
  while (RETRY_TRIGGERS.test(out)) out = out.replace(new RegExp(RETRY_TRIGGERS.source, 'gi'), m => `${m[0]}\u200b${m.slice(1)}`);
  return out;
}

const usd = (n: number) => `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 6 : 2)}`;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const emptyTotals = (): ProxyTotals => ({ requests: 0, refused: 0, reserved_usd: 0, actual_usd: 0, input_tokens: 0, output_tokens: 0 });

function bearer(header: string | null): string | null {
  const m = header?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, any> : {});
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * What a decoded response says served it; every field null for a body that is not a model response. A JSON array
 * (Gemini's streamGenerateContent without alt=sse) is read as its chunks merged, the last value of each field winning.
 */
function responseFields(provider: MeteredProvider, decoded: unknown): Pick<RequestLogLine, 'response_model' | 'reasoning_tokens' | 'response_meta'> {
  const response = Array.isArray(decoded) ? Object.assign({}, ...decoded.map(obj)) : decoded;
  const r = obj(response);
  const model = typeof r.model === 'string' ? r.model : typeof r.modelVersion === 'string' ? r.modelVersion : null;
  const reasoning = provider === 'gemini' ? num(obj(r.usageMetadata).thoughtsTokenCount)
    : provider === 'voyage' ? null
    : normalizeUsage(provider === 'anthropic' ? 'anthropic' : 'openai', r.usage)?.reasoning ?? null;
  return { response_model: model, reasoning_tokens: reasoning, response_meta: responseMeta(response ?? null) };
}

/**
 * The response-side fields of a server-sent-events body, last value wins: Chat Completions chunks, Anthropic
 * `message_start` and `message_delta` (usage merged), Responses API events and Gemini chunks.
 */
function streamResponse(sse: string): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    let event: unknown;
    try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
    const e = obj(event);
    const body = obj(e.response ?? e.message ?? e);
    for (const key of ['model', 'modelVersion', 'metadata', 'service_tier', 'system_fingerprint', 'usageMetadata']) if (body[key] !== undefined && body[key] !== null) out[key] = body[key];
    const usage = body.usage ?? e.usage ?? obj(e.x_groq).usage;
    if (usage && typeof usage === 'object') out.usage = { ...obj(out.usage), ...usage };
    const finish = Array.isArray(body.choices) ? obj(body.choices[0]).finish_reason : undefined;
    if (typeof finish === 'string') out.choices = [{ finish_reason: finish }];
  }
  return out;
}

function loggedRequest(provider: MeteredProvider, body: unknown): LoggedRequest {
  const b = obj(body);
  const effort = typeof b.reasoning_effort === 'string' ? b.reasoning_effort : typeof obj(b.reasoning).effort === 'string' ? obj(b.reasoning).effort as string : null;
  const field = ['max_completion_tokens', 'max_tokens', 'max_output_tokens'].find(k => typeof b[k] === 'number') ?? null;
  const row = Object.hasOwn(COMPAT_PROVIDERS, provider) && Object.hasOwn(COMPAT_PROVIDERS[provider].models, String(b.model)) ? COMPAT_PROVIDERS[provider].models[String(b.model)] : null;
  const effective = effort !== null && row && Object.hasOwn(row.efforts, effort) ? row.efforts[effort] : null;
  return {
    effort_sent: effort,
    effort_effective: effective,
    effort_effective_source: effective === null ? null : COMPAT_PROVIDERS[provider].source,
    output_limit_field: field,
    output_limit: field ? b[field] as number : null,
  };
}

/**
 * The request log with each line's request side joined from its stored body by `body_sha256`; `request` is null
 * for a request whose body the proxy did not store (a GET, an unknown token) or that is not JSON. A last line with
 * no newline is an append cut off when the proxy died and is left out; any other line that is not JSON throws.
 */
export function readRequestLog(requestLogPath: string, bodiesDir: string): Array<RequestLogLine & { request: LoggedRequest | null }> {
  const log = readFileSync(requestLogPath, 'utf8');
  return log.slice(0, log.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(text => {
    const line = JSON.parse(text) as RequestLogLine;
    const path = join(bodiesDir, `${line.body_sha256}.json`);
    let body: unknown = null;
    if (existsSync(path)) { try { body = JSON.parse(readFileSync(path, 'utf8')); } catch {} }
    return { ...line, request: body && typeof body === 'object' ? loggedRequest(line.provider, body) : null };
  });
}

export async function startMeteringProxy(options: MeteringProxyOptions): Promise<MeteringProxy> {
  const { run, cellId } = options;
  const realKeys = options.realKeys ?? process.env;
  const upstreams = options.upstreams ?? {};
  for (const [provider, base] of Object.entries(upstreams)) {
    if (base && carriesKeyInCleartext(base)) throw new Error(`upstream ${provider}=${base} would carry the ${provider} key in cleartext; a host that is not loopback is reached only over https`);
  }
  mkdirSync(dirname(resolve(options.requestLogPath)), { recursive: true });
  mkdirSync(options.bodiesDir, { recursive: true });

  const tokens: Record<string, string> = {};
  const labelOf = new Map<string, string>();
  for (const label of options.labels) {
    if (!/^[a-z0-9][a-z0-9_.]*$/.test(label)) throw new Error(`metering proxy label ${JSON.stringify(label)} must be lower-case letters, digits, '_' or '.'`);
    const token = `mpwp-${label}-${randomBytes(24).toString('hex')}`;
    tokens[label] = token;
    labelOf.set(token, label);
  }
  const keyFor = (provider: MeteredProvider) => METERED_PROVIDERS[provider].keyEnv.map(k => realKeys[k]).find(v => typeof v === 'string' && v.length > 0);
  const served = (provider: MeteredProvider) => Boolean(keyFor(provider) || upstreams[provider]);

  const totals = emptyTotals();
  const byLabel: Record<string, ProxyTotals> = {};
  const byProvider: Record<string, ProxyTotals> = {};
  const pending = new Set<Promise<void>>();
  let exhausted = false;
  let lastRefusal: string | null = null;

  function record(line: RequestLogLine): void {
    appendFileSync(options.requestLogPath, JSON.stringify(line) + '\n');
    for (const t of [totals, byLabel[line.label ?? '(unknown)'] ??= emptyTotals(), byProvider[line.provider] ??= emptyTotals()]) {
      t.requests++;
      if (line.refused) t.refused++;
      t.reserved_usd += line.reserved_usd;
      t.actual_usd += line.actual_usd ?? 0;
      t.input_tokens += line.input_tokens ?? 0;
      t.output_tokens += line.output_tokens ?? 0;
    }
  }

  function errorResponse(status: number, type: string, message: string): Response {
    const safe = retrySafe(message);
    return Response.json({ type: 'error', error: { type, code: status, status: type.toUpperCase(), message: safe } }, { status });
  }

  function refusal(what: string, label: string, reason: string): { response: Response; message: string } {
    exhausted = true;
    const status = ledgerStatus({ ledgerPath: run.ledgerPath, runId: run.runId });
    const r = status.run;
    const message = `metering proxy refused ${what} for cell ${cellId} (process ${label}): ${reason}. `
      + `Committed spend: ${r ? `${usd(r.committed_usd)} of budget run ${run.runId}'s ${usd(r.budget_usd)} budget` : `budget run ${run.runId} not found`}; `
      + `${usd(status.totals.committed_usd)} of the ${status.totals.program_cap_usd === null ? 'unrecorded' : usd(status.totals.program_cap_usd)} program cap. Nothing was sent upstream. `
      + `Next step, which spends nothing: ${STATUS_CLI} --budget-ledger ${run.ledgerPath}. `
      + 'Stop scheduling paid work for this cell; a larger budget or cap needs the user\'s approval.';
    lastRefusal = message;
    return { response: errorResponse(402, REFUSAL_TYPE, message), message };
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const provider = PROVIDER_IDS.find(p => url.pathname === METERED_PROVIDERS[p].prefix || url.pathname.startsWith(`${METERED_PROVIDERS[p].prefix}/`));
    if (!provider) return errorResponse(404, 'mpw_proxy_no_route', `metering proxy: no provider is mounted at ${url.pathname}; use one of ${PROVIDER_IDS.map(p => METERED_PROVIDERS[p].prefix).join(', ')}`);
    const rest = url.pathname.slice(METERED_PROVIDERS[provider].prefix.length) || '/';
    const presented = bearer(req.headers.get('authorization')) ?? req.headers.get('x-api-key') ?? req.headers.get('x-goog-api-key') ?? url.searchParams.get('key');
    const label = presented ? labelOf.get(presented) ?? null : null;
    const tag = req.headers.get('x-mpw-tag');
    const raw: Uint8Array<ArrayBuffer> = req.method === 'GET' || req.method === 'HEAD' ? new Uint8Array() : new Uint8Array(await req.arrayBuffer());
    const bodySha = sha256(raw);
    const query = new URLSearchParams(url.searchParams);
    query.delete('key');
    const search = query.size ? `?${query}` : '';
    const line: RequestLogLine = {
      ts: new Date().toISOString(), cell_id: cellId, label, tag, provider, model: null, kind: null, method: req.method, path: rest, body_sha256: bodySha,
      stream: false, reserved_usd: 0, actual_usd: null, input_tokens: null, output_tokens: null, status: 0, refused: false, settlement: null, error: null,
      response_model: null, reasoning_tokens: null, response_meta: responseMeta(null),
    };
    const finish = (response: Response, patch: Partial<RequestLogLine> = {}) => { record({ ...line, ...patch, status: response.status }); return response; };

    if (!label) {
      return finish(errorResponse(401, 'mpw_proxy_unknown_token', `metering proxy: the request to ${provider} carries no proxy token this cell issued. Use the credentials the launcher put in this process's environment; nothing was sent upstream.`),
        { error: 'unknown or missing proxy token' });
    }
    if (raw.length) {
      const bodyPath = join(options.bodiesDir, `${bodySha}.json`);
      if (!existsSync(bodyPath)) writeFileSync(bodyPath, raw);
    }
    if (!served(provider)) {
      return finish(errorResponse(401, 'mpw_proxy_no_key', `metering proxy: the launcher has no ${METERED_PROVIDERS[provider].keyEnv[0]} for ${provider}, so this cell cannot call it. Declare the key for the cell or use another provider.`),
        { error: 'no launcher key for provider' });
    }
    let body: unknown;
    if (raw.length) { try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { body = null; } }
    const canonical = `${METERED_PROVIDERS[provider].upstream}${rest}${search}`;

    let price: RequestPrice | null;
    try {
      price = priceRequest(canonical, body);
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      const model = typeof (body as { model?: unknown } | null)?.model === 'string' ? String((body as { model: string }).model) : rest;
      const { response, message } = refusal(`${provider} ${model}`, label,
        `${error.message}. If this is a new or unpriced model, look up its current list price (USD per 1M input and output tokens) on the provider's pricing page and register it, with the date checked, in HARNESS_CHAT_PRICES in eval/runner/budget-ledger.ts, then resume the cell`);
      return finish(response, { refused: true, error: message });
    }
    line.model = price?.model ?? null;
    line.kind = price?.kind ?? null;
    let id: string | null = null;
    if (price) {
      line.reserved_usd = reservationUsd(price);
      try {
        id = run.reserve(line.reserved_usd, `${price.provider}:${price.model} ${price.kind} (proxy ${cellId}/${label})`);
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        const { response, message } = refusal(`${price.provider}:${price.model} ${price.kind}`, label, error.message);
        return finish(response, { refused: true, reserved_usd: 0, error: message });
      }
    }

    const headers = new Headers(req.headers);
    for (const h of ['host', 'content-length', 'connection', 'accept-encoding', 'x-mpw-tag', 'authorization', 'x-api-key', 'x-goog-api-key']) headers.delete(h);
    const credential = keyFor(provider) ?? STUB_CREDENTIAL;
    if (provider === 'anthropic') headers.set('x-api-key', credential);
    else if (provider === 'gemini') headers.set('x-goog-api-key', credential);
    else headers.set('authorization', `Bearer ${credential}`);
    const target = `${upstreams[provider] ?? METERED_PROVIDERS[provider].upstream}${rest}${search}`;

    const settle = (cost: { usd: number; input_tokens: number; output_tokens: number } | null, status: number, error: string | null) => {
      if (!price || id === null) return { settlement: 'free' as const };
      if (cost) { run.settle(id, cost); return { settlement: 'reconciled' as const, actual_usd: cost.usd, input_tokens: cost.input_tokens, output_tokens: cost.output_tokens }; }
      if (status >= 400 && status < 500 && !error) { run.settle(id, { usd: 0, input_tokens: 0, output_tokens: 0 }); return { settlement: 'rejected-unbilled' as const, actual_usd: 0 }; }
      run.settle(id, null);
      return { settlement: 'charged-reservation' as const, actual_usd: line.reserved_usd };
    };

    let upstream: Response;
    try {
      upstream = await unguardedFetch(target, { method: req.method, headers, body: raw.length ? raw : undefined, redirect: 'manual', timeout: false, signal: AbortSignal.timeout(UPSTREAM_DEADLINE_MS) } as RequestInit);
    } catch (error) {
      const message = `metering proxy could not reach ${provider}: ${(error as Error).message}`;
      return finish(errorResponse(502, 'mpw_proxy_upstream_unreachable', message), { ...settle(null, 0, message), error: message });
    }
    const outHeaders = new Headers(upstream.headers);
    for (const h of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) outHeaders.delete(h);
    const isStream = (upstream.headers.get('content-type') ?? '').includes('event-stream');

    if (!isStream || !upstream.body) {
      let bytes: Uint8Array<ArrayBuffer>;
      try { bytes = new Uint8Array(await upstream.arrayBuffer()); } catch (error) {
        const message = `metering proxy lost the ${provider} response: ${(error as Error).message}`;
        return finish(errorResponse(502, 'mpw_proxy_upstream_unreachable', message), { ...settle(null, upstream.status, message), error: message });
      }
      let parsed: unknown = null;
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch {}
      const cost = price && parsed !== null ? usageCost(price, parsed) : null;
      return finish(new Response(bytes, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders }), { ...settle(cost, upstream.status, null), ...responseFields(provider, parsed) });
    }

    const [toClient, toMeter] = upstream.body.tee();
    const status = upstream.status;
    const metering = (async () => {
      let patch: Partial<RequestLogLine>;
      try {
        const text = await new Response(toMeter).text();
        patch = { ...settle(price ? streamUsageCost(price, text) : null, status, null), ...responseFields(provider, streamResponse(text)) };
      } catch (error) {
        const message = `stream from ${provider} ended early: ${(error as Error).message}`;
        patch = { ...settle(null, status, message), error: message };
      }
      record({ ...line, ...patch, stream: true, status });
    })();
    pending.add(metering);
    void metering.finally(() => pending.delete(metering));
    return new Response(toClient, { status, statusText: upstream.statusText, headers: outHeaders });
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    idleTimeout: 0,
    async fetch(req) {
      try { return await handle(req); } catch (error) {
        return Response.json({ type: 'error', error: { type: 'mpw_proxy_error', message: retrySafe(`metering proxy error: ${(error as Error).message}`) } }, { status: 400 });
      }
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const baseUrls: Record<MeteredProvider, string> = {
    openai: `${url}/openai/v1`, anthropic: `${url}/anthropic`, gemini: `${url}/gemini`, groq: `${url}/groq`, voyage: `${url}/voyage/v1`, particle: `${url}/particle/v1`,
  };
  return {
    url,
    port: server.port as number,
    tokens,
    baseUrls,
    envFor(label) {
      const token = tokens[label];
      if (!token) throw new Error(`metering proxy has no token for label ${label}; labels: ${options.labels.join(', ')}`);
      const env: Record<string, string> = {};
      if (served('openai')) Object.assign(env, { OPENAI_BASE_URL: baseUrls.openai, OPENAI_API_KEY: token });
      if (served('anthropic')) Object.assign(env, { ANTHROPIC_BASE_URL: baseUrls.anthropic, ANTHROPIC_API_KEY: token });
      if (served('gemini')) Object.assign(env, { GOOGLE_GEMINI_BASE_URL: baseUrls.gemini, GEMINI_API_KEY: token, GOOGLE_GENERATIVE_AI_API_KEY: token });
      if (served('groq')) Object.assign(env, { GROQ_BASE_URL: baseUrls.groq, GROQ_API_KEY: token });
      if (served('voyage')) Object.assign(env, { VOYAGE_API_KEY: token });
      if (served('particle')) Object.assign(env, { [PARTICLE.base_url_env]: baseUrls.particle, [PARTICLE.key_env]: token });
      return env;
    },
    stats() {
      const copy = (t: ProxyTotals) => ({ ...t });
      return {
        total: copy(totals),
        byLabel: Object.fromEntries(Object.entries(byLabel).map(([k, v]) => [k, copy(v)])),
        byProvider: Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, copy(v)])),
        exhausted,
      };
    },
    get exhausted() { return exhausted; },
    get lastRefusal() { return lastRefusal; },
    async close() {
      await Promise.allSettled([...pending]);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const need = (name: string) => flag(name) ?? (console.error(`metering-proxy: ${name} is required\n\nusage: bun eval/runner/metering-proxy.ts --budget-ledger <path> --budget-run-id <id> --cell-id <id> --labels a,b --ready-file <json> [--request-log <jsonl>] [--bodies-dir <dir>] [--port <n>] [--upstream <provider>=<url> ...]`), process.exit(2));
  const readyFile = resolve(need('--ready-file'));
  const run = BudgetRun.join({ runId: need('--budget-run-id'), ledgerPath: need('--budget-ledger') });
  const proxy = await startMeteringProxy({
    run,
    cellId: need('--cell-id'),
    labels: need('--labels').split(',').map(s => s.trim()).filter(Boolean),
    requestLogPath: resolve(flag('--request-log') ?? join(dirname(readyFile), 'proxy-requests.jsonl')),
    bodiesDir: resolve(flag('--bodies-dir') ?? join(dirname(readyFile), 'proxy-bodies')),
    port: flag('--port') ? Number(flag('--port')) : 0,
    upstreams: Object.fromEntries(argv.flatMap((a, i) => (a === '--upstream' ? [argv[i + 1].split(/=(.*)/s).slice(0, 2)] : []))),
  });
  mkdirSync(dirname(readyFile), { recursive: true });
  const ready = { url: proxy.url, port: proxy.port, pid: process.pid, base_urls: proxy.baseUrls, env: Object.fromEntries(Object.keys(proxy.tokens).map(l => [l, proxy.envFor(l)])) };
  writeFileSync(`${readyFile}.tmp`, JSON.stringify(ready, null, 2), { mode: 0o600 });
  chmodSync(`${readyFile}.tmp`, 0o600);
  renameSync(`${readyFile}.tmp`, readyFile);
  console.error(`[metering-proxy] listening on ${proxy.url}; child environments in ${readyFile}`);
  const stop = async () => { await proxy.close(); console.log(JSON.stringify(proxy.stats())); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
