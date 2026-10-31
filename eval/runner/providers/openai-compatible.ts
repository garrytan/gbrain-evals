/**
 * Transport facts for OpenAI-compatible providers other than OpenAI itself: the first piece of one provider client
 * (audit R1, plan GST-605 Phase 1). One row per provider in COMPAT_PROVIDERS; today one row, Particle AI.
 *
 * The module builds a request (`compatRequest`), sends it exactly once (`compatSend`), parses the response
 * (`parseCompatResponse`) and classifies an error (`classifyCompatError`, `compatError`). It never retries and
 * writes no receipts: each runner keeps its own retry loop, agent loop and receipts and calls these pieces inside
 * them. Existing OpenAI and Anthropic transports do not use it, so their requests are unchanged.
 *
 * Particle (docs.particle.ai and its /v1/models listing, checked 2026-10-31): Chat Completions at
 * https://api.particle.ai/v1 (https://us.api.particle.ai/v1 serves the same API from US-only GPUs) with the bearer
 * key PARTICLE_API_KEY. Requests name `particle-1`; responses name `particle-ai/particle-1`. It reasons unless
 * told not to and bills reasoning as output, so every request sends `reasoning_effort` and an output limit with
 * room for reasoning. It is never sent `temperature` or `seed` (Particle then samples with top_p 0.85), except by
 * the weight canary's explicit `canary` sampling mode. Its `/v1/responses` route is WebSocket-only (HTTP answers
 * 405), so nothing here calls it.
 *
 * Credit stop: Particle is prepaid, and an empty balance answers HTTP 402. Any 402 on a request here that carries
 * neither metering proxy's own marker is credit exhaustion and becomes `ParticleCreditExhausted`, which keeps
 * `BudgetExceededError`'s contract (its name, a message starting `budget:`, `status` 402), so every runner's
 * existing budget stop ends the run. The empty-balance body was never probed (that needs an empty account), so the
 * body is recorded, never required. A proxy's own 402 stays a plain budget stop.
 */
import { BudgetExceededError } from '../budget-ledger.ts';
import { responseMeta, type ReceiptRequest, type ResponseMeta } from '../usage-receipt.ts';

export interface CompatModel {
  /** The id a request sends. */
  request_id: string;
  /** The id responses report. */
  response_model: string;
  context_tokens: number;
  /** The largest output limit the provider accepts. */
  output_ceiling: number;
  /** The effort sent when the caller names none. */
  default_effort: string;
  /** The smallest output limit sent outside the canary, so reasoning cannot use up the answer's room. */
  output_floor: number;
  /** Every effort the provider lists, mapped to the level it runs at. */
  efforts: Readonly<Record<string, string>>;
}

export interface CompatProvider {
  /** The provider's name in messages. */
  label: string;
  base_url_env: string;
  base_url_default: string;
  /** Other documented base URLs for the same API. */
  base_url_alternates: readonly string[];
  key_env: string;
  output_limit_field: 'max_completion_tokens';
  /** Usage follows OpenAI Chat Completions (`openai-chat` in usage-receipt.ts). */
  usage: 'openai';
  /** Where these facts come from, and when they were checked. */
  source: string;
  models: Readonly<Record<string, CompatModel>>;
}

export const COMPAT_PROVIDERS: Readonly<Record<string, CompatProvider>> = {
  particle: {
    label: 'Particle',
    base_url_env: 'PARTICLE_BASE_URL',
    base_url_default: 'https://api.particle.ai/v1',
    base_url_alternates: ['https://us.api.particle.ai/v1'],
    key_env: 'PARTICLE_API_KEY',
    output_limit_field: 'max_completion_tokens',
    usage: 'openai',
    source: 'docs.particle.ai and GET /v1/models, checked 2026-10-31',
    models: {
      'particle-1': {
        request_id: 'particle-1',
        response_model: 'particle-ai/particle-1',
        context_tokens: 1_048_576,
        output_ceiling: 131_072,
        default_effort: 'high',
        output_floor: 16_000,
        efforts: { none: 'none', minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max', ultra: 'max' },
      },
    },
  },
};

/** The models every model-comparison run includes (plan GST-605, decision B). A runner lists any it cannot route under `models_not_run`. */
export const PRIMARY_MODELS = ['anthropic:claude-opus-5-5', 'particle:particle-1'] as const;

export interface ModelNotRun { model: string; reason: string }

/** The primary models a lane has no route for, each with its reason, for that lane's manifest `models_not_run`. */
export function modelsNotRun(lane: string, hasRoute: (model: string) => boolean): ModelNotRun[] {
  return PRIMARY_MODELS.filter(model => !hasRoute(model)).map(model => ({ model, reason: `${lane} has no ${model.slice(0, model.indexOf(':'))}: route` }));
}

/** A provider's base URL, read from the passed environment when called (a metering proxy sets it per slot). */
export function compatBaseUrl(provider: string, env: Record<string, string | undefined> = process.env): string {
  const row = COMPAT_PROVIDERS[provider];
  if (!row) throw new Error(`no OpenAI-compatible provider ${JSON.stringify(provider)} in COMPAT_PROVIDERS (eval/runner/providers/openai-compatible.ts)`);
  return (env[row.base_url_env] || row.base_url_default).replace(/\/+$/, '');
}

export interface CompatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface CompatTool { type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } }
export interface CompatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: CompatToolCall[]; tool_call_id?: string }

/**
 * Sampling controls for scripts/particle-canary.ts only, which watches for silent weight changes. A counted caller
 * never sets them (test/eval/openai-compatible.test.ts checks every caller), and the mode refuses any effort but
 * `none` and any output limit above CANARY_MAX_OUTPUT_TOKENS, so a reader request cannot carry it.
 */
export interface CanarySampling { mode: 'canary'; temperature: number; seed: number; top_logprobs: number }
export const CANARY_MAX_OUTPUT_TOKENS = 64;

export interface CompatOptions {
  /** One of the model's listed efforts; the model's default (`high` for particle-1) when omitted. */
  effort?: string;
  /** Raised to the model's output floor outside the canary; refused above its output ceiling. */
  maxOutputTokens?: number;
  tools?: CompatTool[];
  /** Sent with `tools` only; `auto` when omitted. */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  promptCacheKey?: string;
  sampling?: CanarySampling;
}

export interface CompatRequest {
  /** The provider's key in COMPAT_PROVIDERS. */
  provider: string;
  /** `provider:model` as the caller named it. */
  model: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** What the request sends, for the receipt's `request` field. */
  sent: ReceiptRequest;
}

/**
 * One Chat Completions request for `provider:model`. Pure: the base URL and key come from `env` at call time, never
 * from module load, so a proxy slot's environment applies. Refuses a provider or model not in the table, a missing
 * key, an effort the provider does not list and an output limit above the model's ceiling.
 */
export function compatRequest(model: string, messages: CompatMessage[], opts: CompatOptions = {}, env: Record<string, string | undefined> = process.env): CompatRequest {
  const at = model.indexOf(':');
  const providerName = at > 0 ? model.slice(0, at) : '';
  const provider = COMPAT_PROVIDERS[providerName];
  if (!provider) throw new Error(`${model}: no OpenAI-compatible provider ${JSON.stringify(providerName)} in COMPAT_PROVIDERS (eval/runner/providers/openai-compatible.ts)`);
  const row = provider.models[model.slice(at + 1)];
  if (!row) throw new Error(`${model}: not a ${provider.label} model in COMPAT_PROVIDERS; add its row (context, output ceiling, efforts) from the provider's model list first`);
  const key = env[provider.key_env];
  if (!key) throw new Error(`${model}: ${provider.key_env} is not set`);
  const effort = opts.effort ?? row.default_effort;
  const effective = row.efforts[effort];
  if (effective === undefined) throw new Error(`${model}: reasoning effort ${JSON.stringify(effort)} is not one ${provider.label} lists (${Object.keys(row.efforts).join(', ')})`);
  if (opts.sampling && opts.sampling.mode !== 'canary') throw new Error(`${model}: unknown sampling mode ${JSON.stringify(opts.sampling.mode)}`);
  const canary = opts.sampling ?? null;
  const limit = canary ? opts.maxOutputTokens ?? CANARY_MAX_OUTPUT_TOKENS : Math.max(opts.maxOutputTokens ?? row.output_floor, row.output_floor);
  if (canary && (effort !== 'none' || limit > CANARY_MAX_OUTPUT_TOKENS)) throw new Error(`${model}: canary sampling runs only at effort none with at most ${CANARY_MAX_OUTPUT_TOKENS} output tokens`);
  if (!Number.isInteger(limit) || limit < 1 || limit > row.output_ceiling) throw new Error(`${model}: output limit ${limit} is outside 1 to ${row.output_ceiling}`);
  const body: Record<string, unknown> = {
    model: row.request_id, messages,
    ...(opts.tools ? { tools: opts.tools, tool_choice: opts.toolChoice ?? 'auto' } : {}),
    reasoning_effort: effort, [provider.output_limit_field]: limit,
    ...(opts.promptCacheKey !== undefined ? { prompt_cache_key: opts.promptCacheKey } : {}),
    ...(canary ? { temperature: canary.temperature, seed: canary.seed, logprobs: true, top_logprobs: canary.top_logprobs } : {}),
  };
  return {
    provider: providerName, model, url: `${compatBaseUrl(providerName, env)}/chat/completions`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body,
    sent: { effort_sent: effort, effort_effective: effective, output_limit_field: provider.output_limit_field, output_limit: limit, temperature_sent: canary?.temperature ?? null, seed_sent: canary?.seed ?? null },
  };
}

export interface CompatLogprob { token: string; logprob: number; top: Array<{ token: string; logprob: number }> }

export interface CompatResponse {
  id: string | null;
  /** The message content only, possibly empty when the model stopped at its output limit; reasoning text never fills it. */
  text: string;
  /** The raw finish reason (`stop`, `length`, `tool_calls`). */
  finish: string | null;
  /** The raw usage object (OpenAI chat convention: reasoning inside completion_tokens, cached reads inside prompt_tokens). */
  usage: Record<string, unknown> | null;
  response_model: string | null;
  tool_calls: CompatToolCall[];
  /** Per output token, when the request asked for log probabilities (the canary). */
  logprobs: CompatLogprob[] | null;
  meta: ResponseMeta;
}

export function parseCompatResponse(json: unknown): CompatResponse {
  const r = (json && typeof json === 'object' ? json : {}) as Record<string, any>;
  const choice = Array.isArray(r.choices) ? r.choices[0] ?? {} : {};
  const message = choice.message ?? {};
  const content = Array.isArray(choice.logprobs?.content) ? choice.logprobs.content as Array<Record<string, any>> : null;
  return {
    id: typeof r.id === 'string' ? r.id : null,
    text: typeof message.content === 'string' ? message.content : '',
    finish: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    usage: r.usage && typeof r.usage === 'object' ? r.usage : null,
    response_model: typeof r.model === 'string' ? r.model : null,
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    logprobs: content ? content.map(t => ({ token: String(t.token), logprob: Number(t.logprob), top: (t.top_logprobs ?? []).map((x: Record<string, unknown>) => ({ token: String(x.token), logprob: Number(x.logprob) })) })) : null,
    meta: responseMeta(json),
  };
}

/** The longest Retry-After any runner waits; a longer one is cut to this and the wait is recorded. */
export const RETRY_AFTER_CAP_MS = 120_000;

/** The metering proxies' own refusals: the lease proxy's `metering proxy:` messages and the harness proxy's `mpw_budget_refused` type. */
export const PROXY_REFUSAL_MARKERS = ['metering proxy:', 'mpw_budget_refused'] as const;

export type CompatErrorKind = 'credit_exhausted' | 'proxy_budget' | 'context_overflow' | 'rate_limited' | 'server' | 'client';

export interface CompatErrorInfo {
  provider: string;
  status: number;
  kind: CompatErrorKind;
  /** 429 and 5xx: worth another attempt under the runner's own retry rules. */
  retryable: boolean;
  /** The provider's Retry-After as milliseconds, capped at RETRY_AFTER_CAP_MS; null when it sent none. */
  retryAfterMs: number | null;
  body: string;
}

function retryAfter(value: string | null | undefined): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value.trim());
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(0, Math.round(ms)), RETRY_AFTER_CAP_MS) : null;
}

/** Classify a non-2xx answer to a request built here, from its status, body text and headers. */
export function classifyCompatError(provider: string, status: number, body: string, headers?: Headers | Record<string, string | undefined>): CompatErrorInfo {
  const header = headers instanceof Headers ? headers.get('retry-after') : Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
  const kind: CompatErrorKind = status === 402 ? (PROXY_REFUSAL_MARKERS.some(m => body.includes(m)) ? 'proxy_budget' : 'credit_exhausted')
    : status === 429 ? 'rate_limited'
    : status >= 500 ? 'server'
    : status === 400 && /context[_ ]length|context window|prompt is too long|too many tokens|maximum context|input is too long|exceeds the context/i.test(body) ? 'context_overflow'
    : 'client';
  return { provider, status, kind, retryable: kind === 'rate_limited' || kind === 'server', retryAfterMs: retryAfter(header), body };
}

/** A non-2xx answer that is not a budget stop. */
export class CompatHttpError extends Error {
  readonly status: number;
  readonly kind: CompatErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly body: string;
  constructor(info: CompatErrorInfo) {
    super(`${info.provider} ${info.status}: ${info.body.slice(0, 300)}`);
    this.name = 'CompatHttpError';
    this.status = info.status;
    this.kind = info.kind;
    this.retryable = info.retryable;
    this.retryAfterMs = info.retryAfterMs;
    this.body = info.body;
  }
}

/** Particle answered 402 without a proxy's marker: the prepaid balance is empty. Throw it after the failing attempt's receipt is written. */
export class ParticleCreditExhausted extends BudgetExceededError {
  readonly status = 402;
  constructor(readonly body: string) {
    super(`budget: Particle credit exhausted (HTTP 402); top up the balance at platform.particle.ai before rerunning. Body: ${body.slice(0, 300)}`);
  }
}

/** The error to throw for a classified answer: the credit stop, a proxy's budget stop, or a CompatHttpError. */
export function compatError(info: CompatErrorInfo): Error {
  if (info.kind === 'credit_exhausted') return new ParticleCreditExhausted(info.body);
  if (info.kind === 'proxy_budget') return Object.assign(new BudgetExceededError(`budget: the metering proxy refused the ${info.provider} request (HTTP 402): ${info.body.slice(0, 300)}`), { status: 402, body: info.body });
  return new CompatHttpError(info);
}

/** Send one request, once. A non-2xx answer throws `compatError`'s error; the caller's own loop decides any retry. */
export async function compatSend(req: CompatRequest, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<CompatResponse> {
  const res = await (opts.fetchImpl ?? fetch)(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000) });
  const text = await res.text();
  if (!res.ok) throw compatError(classifyCompatError(req.provider, res.status, text, res.headers));
  let json: unknown;
  try { json = JSON.parse(text); }
  catch { throw new CompatHttpError({ provider: req.provider, status: res.status, kind: 'server', retryable: true, retryAfterMs: null, body: `response body is not JSON: ${text.slice(0, 200)}` }); }
  return parseCompatResponse(json);
}
