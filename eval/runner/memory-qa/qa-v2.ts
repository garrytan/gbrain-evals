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
 * `judgeResponse` above is the decision kit's frozen judging path. Q1 judges
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
import { normalizeUsage, type UsageReceipt } from '../usage-receipt.ts';
import { ChatClient as BaseChatClient, sendsTemperature, chatReceipts, type ChatResult } from './qa.ts';

type ProviderReply = Omit<ChatResult, 'cached' | 'attempt_errors'>;
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

export interface ChatLike { chat(model: string, prompt: string, opts: ChatOptions): Promise<ChatResult> }

/**
 * Anthropic `max_tokens` as sent. Claude models that take only their default temperature think adaptively and cannot
 * turn it off; the thinking shares max_tokens, so a 10-token verdict call can end before any text. Verdict calls
 * (under 1,024 tokens) get the 2,000-token floor OpenAI's reasoning models get; the 1,024-token rubric and 2,048-token
 * reader calls, which already finish, are sent as asked (A19).
 */
export const anthropicMaxTokens = (name: string, maxTokens: number) => !sendsTemperature(`anthropic:${name}`) && maxTokens < 1024 ? 2000 : maxTokens;

/** The cache key of one call. */
export function chatCacheKey(model: string, prompt: string, opts: ChatOptions): string {
  const [provider, name] = model.includes(':') ? [model.slice(0, model.indexOf(':')), model.slice(model.indexOf(':') + 1)] : ['openai', model];
  return createHash('sha256').update(JSON.stringify({ provider, name, prompt, maxTokens: opts.maxTokens, temperature: opts.temperature === null ? 'default' : opts.temperature ?? 0, replicate: opts.replicate,
    ...(provider === 'anthropic' && anthropicMaxTokens(name, opts.maxTokens) !== opts.maxTokens ? { sent_max_tokens: anthropicMaxTokens(name, opts.maxTokens) } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}), ...(opts.system !== undefined ? { system: opts.system } : {}), ...(opts.attempt ? { attempt: opts.attempt } : {}) })).digest('hex');
}

export class ChatClient extends BaseChatClient implements ChatLike {
  constructor(private cacheRoot: string, private retryDelayMs: (attempt: number) => number = attempt => 2000 * 2 ** attempt) { super(cacheRoot, retryDelayMs); }

  /** A failure after retries throws the last error with `attempt_errors` (one message per attempt) attached. */
  async chat(model: string, prompt: string, opts: ChatOptions): Promise<ChatResult> {
    const [provider, name] = model.includes(':') ? [model.slice(0, model.indexOf(':')), model.slice(model.indexOf(':') + 1)] : ['openai', model];
    const path = join(this.cacheRoot, `${chatCacheKey(model, prompt, opts)}.json`);
    if (existsSync(path)) return { finish: null, usage: null, response_model: null, ...JSON.parse(readFileSync(path, 'utf8')), cached: true, attempt_errors: [] };
    let lastError: unknown = null;
    const attemptErrors: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = provider === 'anthropic' ? await anthropicChat(name, prompt, opts) : await openaiChat(name, prompt, opts);
        writeFileSync(path, JSON.stringify(r));
        return { ...r, cached: false, attempt_errors: attemptErrors };
      } catch (e) {
        lastError = e;
        attemptErrors.push(String((e as Error).message ?? e).slice(0, 300));
        const status = (e as { status?: number }).status;
        if (/budget|BudgetExceeded/i.test(String((e as Error).message)) || (status !== undefined && status < 500 && status !== 429)) break;
        await new Promise(res => setTimeout(res, this.retryDelayMs(attempt)));
      }
    }
    throw Object.assign(lastError as object, { attempt_errors: attemptErrors });
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
export async function chatWithReceipts(client: ChatLike, ctx: ReceiptContext, prompt: string, opts: ChatOptions, into: UsageReceipt[]): Promise<ChatResult> {
  try {
    const out = await client.chat(ctx.model, prompt, opts);
    into.push(...chatReceipts(ctx, out));
    return out;
  } catch (e) {
    into.push(...chatReceipts(ctx, e as { attempt_errors?: string[] }));
    throw e;
  }
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
