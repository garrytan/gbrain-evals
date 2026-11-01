/**
 * The reading lane of memory-qa: turn retrieved evidence into an answer and
 * judge it against the reference.
 *
 * Two answer paths:
 *   reader  a fixed reader model reads the top distinct sessions gbrain
 *           retrieved (LongMemEval's step-by-step reading prompt, sessions in
 *           date order) — measures what the retrieved evidence supports;
 *   think   gbrain's own `think` synthesis on the same brain — measures the
 *           product's answer path end to end.
 *
 * Judging, per benchmark:
 *   lme-s   LongMemEval's official per-type prompts (abstention items use the
 *           unanswerable prompt);
 *   locomo  the same strict base prompt (temporal questions use the
 *           off-by-one temporal prompt); adversarial questions use the
 *           unanswerable prompt, and the row also records whether the answer
 *           repeats the planted misleading answer (`qa_trap`);
 *   beam    each rubric item judged yes/no; the score is the fraction met.
 *
 * qa.ts's `judgeResponse` is the decision kit's frozen judging path; this
 * module's sends the same prompts and records an OpenAI-compatible judge's
 * receipts as it records a reader's. Q1 judges
 * through `judgeAnswer`: the benchmark's registered instrument
 * (instruments.ts), with a malformed or empty judgment retried as a fresh
 * call and finally recorded as a judge failure, never as a "no".
 *
 * Reasoning effort (`effort`) is part of the request and of the cache key,
 * so answers at one effort never reuse another's cache.
 *
 * Replicates: `replicate` enters every cache key, so ten replicates are ten
 * provider calls, never ten copies of one cached response. Answers and
 * rubrics stay on the evaluator side; the system under test only sees the
 * question.
 *
 * Provider endpoints honor OPENAI_BASE_URL and ANTHROPIC_BASE_URL, so a
 * shootout cell's reader and judge calls go through its metering proxy.
 *
 * OpenAI-compatible providers (COMPAT_PROVIDERS in
 * eval/runner/providers/openai-compatible.ts, today `particle:particle-1`)
 * are built and sent by that module, once per attempt of the same 5-attempt
 * loop, and never sent a temperature. A Retry-After they send replaces the
 * backoff before the next attempt (capped at 120 seconds) and is recorded on
 * that attempt's receipt; Particle's credit 402 is a budget stop that ends
 * the loop at once. Their receipts also record what the request sent and the
 * response's identity fields; their cache key adds the effort and output
 * limit sent. Anthropic and OpenAI requests, receipts and cache keys are
 * unchanged.
 *
 * This module is the Q1 chat client (reasoning effort, system messages,
 * judgment retries) and instrument judging. Every export it does not redefine
 * is qa.ts's, re-exported unchanged: qa.ts keeps the bytes the budgeted
 * delivery H1 decision recorded.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryQuestion } from './corpus.ts';
import type { Instrument, JudgeCall } from './instruments.ts';
import { rawSha256, type JudgmentRecord } from './records.ts';
import { normalizeUsage, responseMeta, usageSourceOf, type ReceiptRequest, type ResponseMeta, type UsageReceipt } from '../usage-receipt.ts';
import { COMPAT_PROVIDERS, compatRequest, compatSend, type CompatRequest } from '../providers/openai-compatible.ts';
import { ChatClient as BaseChatClient, sendsTemperature as baseSendsTemperature, chatReceipts, judgePromptsFor, judgeYes, type ChatResult } from './qa.ts';

type ProviderReply = Omit<ChatResultV2, 'cached' | 'attempt_errors' | 'compat_attempts'>;
interface ReceiptContext { role: UsageReceipt['role']; question_id: string; replicate: number; model: string; delivered: UsageReceipt['delivered'] }

export * from './qa.ts';


/** Chat options. `effort`, `system` and `attempt` enter the cache key only when set, so earlier caches stay valid. */
export interface ChatOptions {
  maxTokens: number;
  replicate: number;
  /** 0 by default; null sends no temperature (a judge that accepts only its default). */
  temperature?: number | null;
  /** Reasoning effort, sent as OpenAI `reasoning_effort` or Anthropic `output_config.effort`. */
  effort?: string;
  /** A system message (BEAM's equivalence judge sends one). */
  system?: string;
  /** Retry of a malformed judgment: a fresh call, never the cached malformed reply. */
  attempt?: number;
}

/** One failed attempt to an OpenAI-compatible provider, in attempt order. */
export interface CompatAttempt {
  /** The provider's Retry-After (capped at 120 s) waited before the next attempt; null when it sent none or no attempt followed. */
  retry_after_ms: number | null;
  /** Usage a 2xx answer without a message still reported (the provider may have billed it). */
  usage: Record<string, unknown> | null;
}

/** qa.ts's ChatResult plus what a call to an OpenAI-compatible provider records on its receipts; Anthropic and OpenAI results carry none of it. */
export interface ChatResultV2 extends ChatResult {
  /** What the request sent: effort sent and effective, output limit, sampling. */
  sent?: ReceiptRequest;
  /** The response's identity fields (raw metadata, weight version, service tier, fingerprint, truncation). */
  response_meta?: ResponseMeta;
  /** One entry per failed attempt, aligned with `attempt_errors`. */
  compat_attempts?: CompatAttempt[];
}

export interface ChatLike { chat(model: string, prompt: string, opts: ChatOptions): Promise<ChatResultV2> }

/** True for a `provider:model` whose provider is in COMPAT_PROVIDERS. */
export const isCompatModel = (model: string) => model.includes(':') && Object.hasOwn(COMPAT_PROVIDERS, model.slice(0, model.indexOf(':')));

/** Whether ChatClient has a transport for `provider:model`: Anthropic, OpenAI, or a provider in COMPAT_PROVIDERS. */
export const hasChatRoute = (model: string) => model.startsWith('anthropic:') || model.startsWith('openai:') || isCompatModel(model);

/** qa.ts's rule, except that an OpenAI-compatible provider is never sent a temperature (it samples at its own default). */
export const sendsTemperature = (model: string) => !isCompatModel(model) && baseSendsTemperature(model);

/** The request a compat provider gets for one call; refuses a missing key, an unknown model or an unlisted effort before anything is sent. */
const compatCall = (model: string, prompt: string, opts: ChatOptions, env: Record<string, string | undefined> = process.env): CompatRequest =>
  compatRequest(model, [...(opts.system !== undefined ? [{ role: 'system' as const, content: opts.system }] : []), { role: 'user' as const, content: prompt }], { effort: opts.effort, maxOutputTokens: opts.maxTokens }, env);

/**
 * Anthropic `max_tokens` as sent. Claude models that take only their default temperature think adaptively and cannot
 * turn it off; the thinking shares max_tokens, so a 10-token verdict call can end before any text. Verdict calls
 * (under 1,024 tokens) get the 2,000-token floor OpenAI's reasoning models get; the 1,024-token rubric and 2,048-token
 * reader calls, which already finish, are sent as asked (A19).
 */
export const anthropicMaxTokens = (name: string, maxTokens: number) => !sendsTemperature(`anthropic:${name}`) && maxTokens < 1024 ? 2000 : maxTokens;

/**
 * The cache key of one call. An OpenAI-compatible provider's key also holds the effort and output limit sent, which its
 * default effort and output floor decide; they are computed with a placeholder key, so a cached answer replays without one.
 */
export function chatCacheKey(model: string, prompt: string, opts: ChatOptions): string {
  const [provider, name] = model.includes(':') ? [model.slice(0, model.indexOf(':')), model.slice(model.indexOf(':') + 1)] : ['openai', model];
  const sent = isCompatModel(model) ? compatCall(model, prompt, opts, { [COMPAT_PROVIDERS[provider].key_env]: 'cache-key' }).sent : null;
  return createHash('sha256').update(JSON.stringify({ provider, name, prompt, maxTokens: opts.maxTokens, temperature: opts.temperature === null ? 'default' : opts.temperature ?? 0, replicate: opts.replicate,
    ...(provider === 'anthropic' && anthropicMaxTokens(name, opts.maxTokens) !== opts.maxTokens ? { sent_max_tokens: anthropicMaxTokens(name, opts.maxTokens) } : {}),
    ...(sent ? { sent_effort: sent.effort_sent, sent_output_limit: sent.output_limit } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}), ...(opts.system !== undefined ? { system: opts.system } : {}), ...(opts.attempt ? { attempt: opts.attempt } : {}) })).digest('hex');
}

export class ChatClient extends BaseChatClient implements ChatLike {
  constructor(private cacheRoot: string, private retryDelayMs: (attempt: number) => number = attempt => 2000 * 2 ** attempt) { super(cacheRoot, retryDelayMs); }

  /**
   * A failure after retries throws the last error with `attempt_errors` (one message per attempt) attached, and for an
   * OpenAI-compatible provider also `sent` and `compat_attempts`.
   */
  async chat(model: string, prompt: string, opts: ChatOptions): Promise<ChatResultV2> {
    const [provider, name] = model.includes(':') ? [model.slice(0, model.indexOf(':')), model.slice(model.indexOf(':') + 1)] : ['openai', model];
    const path = join(this.cacheRoot, `${chatCacheKey(model, prompt, opts)}.json`);
    if (existsSync(path)) return { finish: null, usage: null, response_model: null, ...JSON.parse(readFileSync(path, 'utf8')), cached: true, attempt_errors: [] };
    const compat = isCompatModel(model) ? compatCall(model, prompt, opts) : null;
    let lastError: unknown = null;
    const attemptErrors: string[] = [];
    const compatAttempts: CompatAttempt[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = compat ? await compatChat(compat) : provider === 'anthropic' ? await anthropicChat(name, prompt, opts) : await openaiChat(name, prompt, opts);
        writeFileSync(path, JSON.stringify(r));
        return { ...r, cached: false, attempt_errors: attemptErrors, ...(compat ? { compat_attempts: compatAttempts } : {}) };
      } catch (e) {
        lastError = e;
        attemptErrors.push(String((e as Error).message ?? e).slice(0, 300));
        const status = (e as { status?: number }).status;
        const retryable = compat ? (e as { retryable?: boolean }).retryable !== false : status === undefined || status >= 500 || status === 429;
        const budget = compat ? (e as Error).name === 'BudgetExceededError' : /budget|BudgetExceeded/i.test(String((e as Error).message));
        const stop = budget || !retryable || attempt === 4;
        const retryAfterMs = compat && !stop ? (e as { retryAfterMs?: number | null }).retryAfterMs ?? null : null;
        if (compat) compatAttempts.push({ retry_after_ms: retryAfterMs, usage: (e as { usage?: Record<string, unknown> | null }).usage ?? null });
        if (stop) break;
        await new Promise(res => setTimeout(res, retryAfterMs ?? this.retryDelayMs(attempt)));
      }
    }
    throw Object.assign(lastError as object, { attempt_errors: attemptErrors, ...(compat ? { sent: compat.sent, compat_attempts: compatAttempts } : {}) });
  }
}

async function openaiChat(model: string, prompt: string, opts: ChatOptions): Promise<ProviderReply> {
  const messages = [...(opts.system !== undefined ? [{ role: 'system', content: opts.system }] : []), { role: 'user', content: prompt }];
  const effort = opts.effort !== undefined ? { reasoning_effort: opts.effort } : {};
  const res = await fetch(`${(process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    // GPT-5 and later reasoning models take max_completion_tokens and only their default temperature.
    body: JSON.stringify(!sendsTemperature(`openai:${model}`)
      ? { model, messages, n: 1, max_completion_tokens: Math.max(opts.maxTokens, 2000), ...effort }
      : { model, messages, n: 1, ...(opts.temperature === null ? {} : { temperature: opts.temperature ?? 0 }), max_tokens: opts.maxTokens, ...effort }),
    signal: AbortSignal.timeout(300_000),
  });
  const json = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(`openai ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`), { status: res.status });
  const usage = normalizeUsage('openai', json.usage);
  return { text: String(json.choices?.[0]?.message?.content ?? ''), input_tokens: usage?.input_total ?? 0, output_tokens: usage?.output_total ?? 0,
    finish: json.choices?.[0]?.finish_reason ?? null, usage: json.usage ?? null, response_model: json.model ?? null };
}

/** One attempt to an OpenAI-compatible provider: one HTTP request through the provider module, never retried there. */
async function compatChat(req: CompatRequest): Promise<ProviderReply> {
  const res = await compatSend(req);
  const usage = normalizeUsage(usageSourceOf(req.model), res.usage);
  return { text: res.text, input_tokens: usage?.input_total ?? 0, output_tokens: usage?.output_total ?? 0, finish: res.finish, usage: res.usage, response_model: res.response_model,
    sent: req.sent, response_meta: res.meta };
}

async function anthropicChat(model: string, prompt: string, opts: ChatOptions): Promise<ProviderReply> {
  const res = await fetch(`${(process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: anthropicMaxTokens(model, opts.maxTokens), ...(opts.temperature === null || !sendsTemperature(`anthropic:${model}`) ? {} : { temperature: opts.temperature ?? 0 }), ...(opts.system !== undefined ? { system: opts.system } : {}),
      ...(opts.effort !== undefined ? { output_config: { effort: opts.effort } } : {}), messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(300_000),
  });
  const json = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(`anthropic ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`), { status: res.status });
  const usage = normalizeUsage('anthropic', json.usage);
  return { text: (json.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''), input_tokens: usage?.input_total ?? 0, output_tokens: usage?.output_total ?? 0,
    finish: json.stop_reason ?? null, usage: json.usage ?? null, response_model: json.model ?? null };
}

/** One chat call that appends its receipts to `into`, failed attempts included. */
export async function chatWithReceipts(client: ChatLike, ctx: ReceiptContext, prompt: string, opts: ChatOptions, into: UsageReceipt[]): Promise<ChatResultV2> {
  try {
    const out = await client.chat(ctx.model, prompt, opts);
    into.push(...compatReceipts(chatReceipts(ctx, out), out));
    return out;
  } catch (e) {
    into.push(...compatReceipts(chatReceipts(ctx, e as { attempt_errors?: string[] }), e as Omit<ChatResultV2, keyof ChatResult>));
    throw e;
  }
}

/**
 * The receipts of a call to an OpenAI-compatible provider gain what the request sent and the response's identity (all
 * null on a failed attempt); a failed attempt also gains the Retry-After it waited and any usage it reported.
 */
function compatReceipts(receipts: UsageReceipt[], out: Omit<ChatResultV2, keyof ChatResult>): UsageReceipt[] {
  if (!out.sent) return receipts;
  return receipts.map((r, i) => {
    if (r.status === 'ok') return { ...r, request: out.sent, response_meta: out.response_meta ?? responseMeta(null) };
    const a = out.compat_attempts?.[i];
    return { ...r, request: out.sent, response_meta: responseMeta(null), ...(a?.retry_after_ms != null ? { retry_after_ms: a.retry_after_ms } : {}),
      ...(a?.usage ? { usage: normalizeUsage(usageSourceOf(r.model), a.usage), usage_raw: a.usage } : {}) };
  });
}

/**
 * qa.ts's `judgeResponse` (the same prompts, output limit and verdict) recording through this module's
 * `chatWithReceipts`, so an OpenAI-compatible judge's receipts carry what each attempt sent, the response's identity
 * and the usage a failed attempt reported. An Anthropic or OpenAI judge's requests and receipts are qa.ts's.
 */
export async function judgeResponse(client: ChatLike, benchmark: string, judgeModel: string, q: MemoryQuestion, response: string, replicate: number, receipts?: UsageReceipt[]): Promise<number> {
  const prompts = judgePromptsFor(benchmark, q, response);
  let yes = 0;
  for (const p of prompts) {
    const ctx = { role: 'judge' as const, question_id: q.id, replicate, model: judgeModel, delivered: null };
    const out = receipts ? await chatWithReceipts(client, ctx, p, { maxTokens: 10, replicate }, receipts) : await client.chat(judgeModel, p, { maxTokens: 10, replicate });
    if (judgeYes(out.text)) yes++;
  }
  return yes / prompts.length;
}

/** A judge call whose output stayed malformed through every attempt. */
export class MalformedJudgment extends Error {
  constructor(readonly raws: string[], reason: string) { super(`malformed judgment after ${raws.length} attempt(s): ${reason}`); this.name = 'MalformedJudgment'; }
}

/** The temperature a judge is sent: the instrument's, or null for a judge that accepts only its default. */
export const judgeTemperature = (judge: string, instrument: Pick<Instrument, 'temperature'>): number | null => sendsTemperature(judge) ? instrument.temperature : null;

/**
 * Judge one fixed answer with a registered instrument. Each judge call is
 * retried as a fresh call (`attempt` in the cache key) while its output is
 * malformed; after `maxAttempts` the judgment is a `judge_error` with a null
 * score. Provider errors propagate, so the caller records nothing and a
 * restart retries the call.
 */
export async function judgeAnswer(client: ChatLike, instrument: Instrument, q: MemoryQuestion, response: string,
  opts: { judge?: string; judgeReplicate: number; maxAttempts?: number }): Promise<Omit<JudgmentRecord, 'answer_id'>> {
  const judge = opts.judge ?? instrument.canonical_judge;
  const temperature = judgeTemperature(judge, instrument);
  const maxAttempts = opts.maxAttempts ?? 3;
  const raw: string[] = [];
  const ask = async (call: JudgeCall) => {
    const tries: string[] = [];
    let reason = '';
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await client.chat(judge, call.prompt, { maxTokens: call.max_tokens, replicate: opts.judgeReplicate, temperature, ...(call.system !== undefined ? { system: call.system } : {}), ...(attempt ? { attempt } : {}) });
      tries.push(res.text);
      const parsed = call.parse(res.text);
      if (parsed.ok) { raw.push(res.text); return { raw: res.text, value: parsed.value }; }
      reason = parsed.reason;
    }
    raw.push(...tries);
    throw new MalformedJudgment(tries, reason);
  };
  const base = { instrument_id: instrument.id, instrument_sha256: instrument.sha256, judge, judge_replicate: opts.judgeReplicate, temperature };
  try {
    const r = await instrument.score(q, response, ask);
    return { ...base, score: r.score, parse_ok: true, raw_sha256: rawSha256(raw), outcome: 'scored', raw, ...(r.detail ? { detail: r.detail } : {}) };
  } catch (e) {
    if (!(e instanceof MalformedJudgment)) throw e;
    return { ...base, score: null, parse_ok: false, raw_sha256: rawSha256(raw), outcome: 'judge_error', raw, detail: { error: e.message } };
  }
}
