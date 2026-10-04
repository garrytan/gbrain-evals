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
import type { MemoryQuestion, Session } from './corpus.ts';

export const READER_TEMPLATE = 'I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nHistory Chats:\n\n{history}\n\nCurrent Date: {date}\nQuestion: {question}\nAnswer (step by step):';

export const DEFAULT_READER: Record<string, string> = { 'lme-s': 'openai:gpt-4o-2024-08-06', locomo: 'openai:gpt-4o-mini', 'beam-100k': 'openai:gpt-4.1-mini', 'beam-500k': 'openai:gpt-4.1-mini', 'beam-1m': 'openai:gpt-4.1-mini', fixture: 'openai:gpt-4o-mini' };
export const DEFAULT_JUDGE: Record<string, string> = { 'lme-s': 'openai:gpt-4o-2024-08-06', locomo: 'openai:gpt-4o-2024-08-06', 'beam-100k': 'openai:gpt-4.1-mini', 'beam-500k': 'openai:gpt-4.1-mini', 'beam-1m': 'openai:gpt-4.1-mini', fixture: 'openai:gpt-4o-mini' };

export interface ChatResult { text: string; input_tokens: number; output_tokens: number; cached: boolean }

/** Approximate token count used for packing (4 characters per token). */
export const approxTokens = (s: string) => Math.ceil(s.length / 4);

export function renderHistory(sessions: Session[]): string {
  const sorted = [...sessions].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
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

export function judgePromptsFor(benchmark: string, q: MemoryQuestion, response: string): string[] {
  const answer = q.answer ?? '';
  if (benchmark === 'lme-s') return [officialJudgePrompt(q.category, q.question, answer, response, q.abstention)];
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

export class ChatClient {
  constructor(private cacheDir: string) { mkdirSync(cacheDir, { recursive: true }); }

  async chat(model: string, prompt: string, opts: { maxTokens: number; replicate: number; temperature?: number }): Promise<ChatResult> {
    const [provider, name] = model.includes(':') ? [model.slice(0, model.indexOf(':')), model.slice(model.indexOf(':') + 1)] : ['openai', model];
    const key = createHash('sha256').update(JSON.stringify({ provider, name, prompt, maxTokens: opts.maxTokens, temperature: opts.temperature ?? 0, replicate: opts.replicate })).digest('hex');
    const path = join(this.cacheDir, `${key}.json`);
    if (existsSync(path)) return { ...JSON.parse(readFileSync(path, 'utf8')), cached: true };
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = provider === 'anthropic' ? await anthropicChat(name, prompt, opts) : await openaiChat(name, prompt, opts);
        writeFileSync(path, JSON.stringify(r));
        return { ...r, cached: false };
      } catch (e) {
        lastError = e;
        const status = (e as { status?: number }).status;
        if (/budget|BudgetExceeded/i.test(String((e as Error).message)) || (status !== undefined && status < 500 && status !== 429)) break;
        await new Promise(res => setTimeout(res, 2000 * 2 ** attempt));
      }
    }
    throw lastError;
  }
}

async function openaiChat(model: string, prompt: string, opts: { maxTokens: number; temperature?: number }): Promise<Omit<ChatResult, 'cached'>> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], n: 1, temperature: opts.temperature ?? 0, max_tokens: opts.maxTokens }),
    signal: AbortSignal.timeout(300_000),
  });
  const json = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(`openai ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`), { status: res.status });
  return { text: String(json.choices?.[0]?.message?.content ?? ''), input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0 };
}

async function anthropicChat(model: string, prompt: string, opts: { maxTokens: number; temperature?: number }): Promise<Omit<ChatResult, 'cached'>> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: opts.maxTokens, temperature: opts.temperature ?? 0, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(300_000),
  });
  const json = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(`anthropic ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`), { status: res.status });
  return { text: (json.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''), input_tokens: json.usage?.input_tokens ?? 0, output_tokens: json.usage?.output_tokens ?? 0 };
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

/** Judge one response N times is not useful at temperature 0; replicates re-answer AND re-judge. */
export async function judgeResponse(client: ChatClient, benchmark: string, judgeModel: string, q: MemoryQuestion, response: string, replicate: number): Promise<number> {
  const prompts = judgePromptsFor(benchmark, q, response);
  let yes = 0;
  for (const p of prompts) if (judgeYes((await client.chat(judgeModel, p, { maxTokens: 10, replicate })).text)) yes++;
  return yes / prompts.length;
}
