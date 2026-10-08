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
 * Replicates: `replicate` enters every cache key, so ten replicates are ten
 * provider calls, never ten copies of one cached response. Answers and
 * rubrics stay on the evaluator side; the system under test only sees the
 * question.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { officialJudgePrompt } from '../evidence-delivery/calls.ts';
import { acceptsTemperature } from '../openai-judge-shim.ts';
import type { MemoryQuestion, Session } from './corpus.ts';
import { normalizeFinish, normalizeUsage, receipt, type UsageReceipt } from '../usage-receipt.ts';

export const READER_TEMPLATE = 'I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nHistory Chats:\n\n{history}\n\nCurrent Date: {date}\nQuestion: {question}\nAnswer (step by step):';

export const DEFAULT_READER: Record<string, string> = { 'lme-s': 'openai:gpt-4o-2024-08-06', custody: 'openai:gpt-4o-2024-08-06', locomo: 'openai:gpt-4o-mini', 'beam-100k': 'openai:gpt-4.1-mini', 'beam-500k': 'openai:gpt-4.1-mini', 'beam-1m': 'openai:gpt-4.1-mini', fixture: 'openai:gpt-4o-mini' };
export const DEFAULT_JUDGE: Record<string, string> = { 'lme-s': 'openai:gpt-4o-2024-08-06', custody: 'openai:gpt-4o-2024-08-06', locomo: 'openai:gpt-4o-2024-08-06', 'beam-100k': 'openai:gpt-4.1-mini', 'beam-500k': 'openai:gpt-4.1-mini', 'beam-1m': 'openai:gpt-4.1-mini', fixture: 'openai:gpt-4o-mini' };

export interface ChatResult {
  text: string;
  /** Total input (uncached + cache reads + cache writes) under the provider's convention; see usage-receipt.ts. */
  input_tokens: number;
  output_tokens: number;
  cached: boolean;
  /** Raw provider finish or stop reason; null for responses cached before it was recorded. */
  finish: string | null;
  /** Raw provider usage object; null for responses cached before it was recorded. */
  usage: Record<string, unknown> | null;
  response_model: string | null;
  /** One message per failed attempt before this response, in order. */
  attempt_errors: string[];
}

/** Approximate token count used for packing (4 characters per token). */
export const approxTokens = (s: string) => Math.ceil(s.length / 4);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * Sort key for a session date. BEAM dates sessions as `Month-DD-YYYY` ("March-05-2024"), which sorts alphabetically by
 * month name as a string, so it maps to `YYYY-MM-DD`. Every other format is its own key, as before.
 */
export function sessionDateKey(date: string | undefined): string {
  const m = /^([A-Za-z]+)-(\d{1,2})-(\d{4})$/.exec(date ?? '');
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return m && month >= 0 ? `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}` : date ?? '';
}

/** The conversation's latest session date as written, the reader's fallback "Current Date". */
export function latestDate(sessions: Session[]): string | undefined {
  return sessions.map(x => x.date ?? '').sort((a, b) => sessionDateKey(a).localeCompare(sessionDateKey(b))).pop() || undefined;
}

export function renderHistory(sessions: Session[]): string {
  const sorted = [...sessions].sort((a, b) => sessionDateKey(a.date).localeCompare(sessionDateKey(b.date)));
  return sorted.map((s, i) => `\n### Session ${i + 1}:\nSession Date: ${s.date ?? 'unknown'}\nSession Content:\n\n${JSON.stringify(s.turns.map(t => ({ role: t.speaker, content: t.content })))}\n`).join('');
}

/**
 * Sessions in retrieval order, cut to `maxSessions`, then packed whole into
 * `budgetTokens` (a session that does not fit ends the pack; it is not split).
 */
export function packSessions(ranked: Session[], maxSessions: number, budgetTokens: number | null): { sessions: Session[]; tokens: number } {
  const out: Session[] = [];
  let tokens = 0;
  for (const s of ranked.slice(0, maxSessions)) {
    const t = approxTokens(renderHistory([s]));
    if (budgetTokens !== null && tokens + t > budgetTokens) break;
    out.push(s);
    tokens += t;
  }
  return { sessions: out, tokens };
}

export function readerPrompt(q: MemoryQuestion, sessions: Session[], fallbackDate: string | undefined): string {
  return READER_TEMPLATE.replace('{history}', renderHistory(sessions)).replace('{date}', q.question_date ?? fallbackDate ?? 'unknown').replace('{question}', q.question);
}

export const FACTS_READER_TEMPLATE = 'I will give you facts a memory system saved from past chats between you and a user, each with the date the memory system recorded for it. Please answer the question based on these facts. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nSaved Facts:\n\n{facts}\n\nCurrent Date: {date}\nQuestion: {question}\nAnswer (step by step):';

export interface SavedFact { fact: string; valid_from: string | null }

/** The facts lane's reading prompt: saved fact text with its stored date, nothing from the raw sessions. */
export function factsReaderPrompt(q: MemoryQuestion, facts: SavedFact[], fallbackDate: string | undefined): string {
  const lines = facts.map(f => `- [${f.valid_from ? f.valid_from.slice(0, 10) : 'undated'}] ${f.fact}`).join('\n');
  return FACTS_READER_TEMPLATE.replace('{facts}', lines || '(none)').replace('{date}', q.question_date ?? fallbackDate ?? 'unknown').replace('{question}', q.question);
}

const RELATIVE_TIME = new RegExp([
  '\\b(?:yesterday|today|tonight|tomorrow|recently|lately|the other day|the day before|earlier today)\\b',
  '\\b(?:last|next|this|coming|past)\\s+(?:week|weekend|month|year|night|morning|evening|summer|winter|spring|fall|autumn|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b',
  '\\b(?:a|an|one|two|three|four|five|six|few|couple(?: of)?|several|\\d+)\\s+(?:days?|weeks?|months?|years?)\\s+(?:ago|from now|earlier|later|before)\\b',
  '\\bearlier this (?:week|month|year)\\b',
].join('|'), 'i');
const ABSOLUTE_DATE = /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

/**
 * Evaluator-side check: a saved fact still carries a relative time word
 * ("yesterday", "last week", "3 days ago") and no absolute date, so its
 * meaning depends on a moment the fact no longer records.
 */
export const unresolvedRelativeTime = (fact: string) => RELATIVE_TIME.test(fact) && !ABSOLUTE_DATE.test(fact);

export function judgePromptsFor(benchmark: string, q: MemoryQuestion, response: string): string[] {
  const answer = q.answer ?? '';
  if (benchmark === 'lme-s' || benchmark === 'custody') return [officialJudgePrompt(q.category, q.question, answer, response, q.abstention)];
  if (benchmark === 'locomo' || benchmark === 'fixture') {
    if (q.abstention) return [officialJudgePrompt('multi-session', q.question, answer, response, true)];
    return [officialJudgePrompt(q.category === 'temporal' ? 'temporal-reasoning' : 'multi-session', q.question, answer, response, false)];
  }
  const items = q.rubric?.length ? q.rubric : [answer];
  return items.map(item => `I will give you a question, one rubric item that a good response must satisfy, and a response from a model. Answer yes if the response satisfies the rubric item, otherwise answer no.\n\nQuestion: ${q.question}\n\nRubric item: ${item}\n\nModel Response: ${response}\n\nDoes the response satisfy the rubric item? Answer yes or no only.`);
}

export const judgeYes = (text: string) => /\byes\b/i.test(text.trim().split(/\s+/).slice(0, 3).join(' '));

/** True when an answer repeats the planted misleading answer of an adversarial question. */
export function repeatsTrap(response: string, trap: string | undefined): boolean {
  if (!trap) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const t = norm(trap);
  return t.length > 3 && norm(response).includes(t);
}

/**
 * Whether the reading lane sends `temperature` to a `provider:model`: not to OpenAI GPT-5-and-later or o-series reasoning
 * models, nor to Claude 5-family models, which reject it; those sample at the provider default.
 */
export function sendsTemperature(model: string): boolean {
  const [provider, name] = model.includes(':') ? [model.slice(0, model.indexOf(':')), model.slice(model.indexOf(':') + 1)] : ['openai', model];
  return provider === 'anthropic' ? acceptsTemperature(name) : !/^(gpt-[5-9]|o\d)/.test(name);
}

type ProviderReply = Omit<ChatResult, 'cached' | 'attempt_errors'>;

export class ChatClient {
  constructor(private cacheDir: string, private backoffMs: (attempt: number) => number = attempt => 2000 * 2 ** attempt) { mkdirSync(cacheDir, { recursive: true }); }

  /** A failure after retries throws the last error with `attempt_errors` (one message per attempt) attached. */
  async chat(model: string, prompt: string, opts: { maxTokens: number; replicate: number; temperature?: number }): Promise<ChatResult> {
    const [provider, name] = model.includes(':') ? [model.slice(0, model.indexOf(':')), model.slice(model.indexOf(':') + 1)] : ['openai', model];
    const key = createHash('sha256').update(JSON.stringify({ provider, name, prompt, maxTokens: opts.maxTokens, temperature: opts.temperature ?? 0, replicate: opts.replicate })).digest('hex');
    const path = join(this.cacheDir, `${key}.json`);
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
        await new Promise(res => setTimeout(res, this.backoffMs(attempt)));
      }
    }
    throw Object.assign(lastError as object, { attempt_errors: attemptErrors });
  }
}

async function openaiChat(model: string, prompt: string, opts: { maxTokens: number; temperature?: number }): Promise<ProviderReply> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    // GPT-5 and later reasoning models take max_completion_tokens and only their default temperature.
    body: JSON.stringify(!sendsTemperature(`openai:${model}`)
      ? { model, messages: [{ role: 'user', content: prompt }], n: 1, max_completion_tokens: Math.max(opts.maxTokens, 2000) }
      : { model, messages: [{ role: 'user', content: prompt }], n: 1, temperature: opts.temperature ?? 0, max_tokens: opts.maxTokens }),
    signal: AbortSignal.timeout(300_000),
  });
  const json = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(`openai ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`), { status: res.status });
  const usage = normalizeUsage('openai', json.usage);
  return { text: String(json.choices?.[0]?.message?.content ?? ''), input_tokens: usage?.input_total ?? 0, output_tokens: usage?.output_total ?? 0,
    finish: json.choices?.[0]?.finish_reason ?? null, usage: json.usage ?? null, response_model: json.model ?? null };
}

async function anthropicChat(model: string, prompt: string, opts: { maxTokens: number; temperature?: number }): Promise<ProviderReply> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: opts.maxTokens, ...(sendsTemperature(`anthropic:${model}`) ? { temperature: opts.temperature ?? 0 } : {}), messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(300_000),
  });
  const json = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(`anthropic ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`), { status: res.status });
  const usage = normalizeUsage('anthropic', json.usage);
  return { text: (json.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''), input_tokens: usage?.input_total ?? 0, output_tokens: usage?.output_total ?? 0,
    finish: json.stop_reason ?? null, usage: json.usage ?? null, response_model: json.model ?? null };
}

export interface QaOutcome {
  qa_score: number;
  qa_runs: number;
  qa_scores: number[];
  qa_trap?: number;
  qa_input_tokens: number;
  qa_output_tokens: number;
  qa_answer: string;
  qa_sessions?: number;
  qa_context_tokens?: number;
}

interface ReceiptContext { role: UsageReceipt['role']; question_id: string; replicate: number; model: string; delivered: UsageReceipt['delivered'] }

/** Usage receipts for one chat call: an `error` record per failed attempt, then the response (or nothing more when every attempt failed). Routing matches ChatClient: an unprefixed model is OpenAI. */
export function chatReceipts(ctx: ReceiptContext, outcome: ChatResult | { attempt_errors?: string[] }): UsageReceipt[] {
  const source = ctx.model.startsWith('anthropic:') ? 'anthropic' : 'openai';
  const base = { lane: 'memory-qa', role: ctx.role, question_id: ctx.question_id, replicate: ctx.replicate, model: ctx.model, delivered: ctx.delivered };
  const errors = outcome.attempt_errors ?? [];
  const out = errors.map((error, attempt) => receipt({ ...base, attempt, response_model: null, status: 'error', error, from_cache: false, finish: null, finish_raw: null, answer: '', usage: null, usage_raw: null }));
  if (!('text' in outcome)) return out;
  return [...out, receipt({
    ...base, attempt: errors.length, response_model: outcome.response_model, status: 'ok', error: null, from_cache: outcome.cached,
    finish: normalizeFinish(outcome.finish), finish_raw: outcome.finish, answer: outcome.text, usage_raw: outcome.usage,
    // A response cached before raw usage was kept still carries its input and output totals (memory-qa never set cache_control, so no cache split was lost).
    usage: outcome.usage ? normalizeUsage(source, outcome.usage) : outcome.cached
      ? { convention: 'legacy-cache', input_total: outcome.input_tokens, input_uncached: null, cache_read: null, cache_write: null, output_total: outcome.output_tokens, reasoning: null } : null,
  })];
}

/** One chat call that appends its receipts to `into`, failed attempts included. */
export async function chatWithReceipts(client: ChatClient, ctx: ReceiptContext, prompt: string, opts: { maxTokens: number; replicate: number }, into: UsageReceipt[]): Promise<ChatResult> {
  try {
    const out = await client.chat(ctx.model, prompt, opts);
    into.push(...chatReceipts(ctx, out));
    return out;
  } catch (e) {
    into.push(...chatReceipts(ctx, e as { attempt_errors?: string[] }));
    throw e;
  }
}

/** Judge one response N times is not useful at temperature 0; replicates re-answer AND re-judge. Pass `receipts` to record each judge call. */
export async function judgeResponse(client: ChatClient, benchmark: string, judgeModel: string, q: MemoryQuestion, response: string, replicate: number, receipts?: UsageReceipt[]): Promise<number> {
  const prompts = judgePromptsFor(benchmark, q, response);
  let yes = 0;
  for (const p of prompts) {
    const ctx = { role: 'judge' as const, question_id: q.id, replicate, model: judgeModel, delivered: null };
    const out = receipts ? await chatWithReceipts(client, ctx, p, { maxTokens: 10, replicate }, receipts) : await client.chat(judgeModel, p, { maxTokens: 10, replicate });
    if (judgeYes(out.text)) yes++;
  }
  return yes / prompts.length;
}
