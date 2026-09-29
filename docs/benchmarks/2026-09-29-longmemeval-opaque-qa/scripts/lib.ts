// Shared helpers for the M6 arms: paid-call logging, direct OpenAI calls with
// retry accounting, the exact official LongMemEval judge, gbrain's framed judge,
// and dataset access. No gbrain source is modified; gbrain modules are imported.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { configureGateway, chat as gatewayChat } from 'GBRAIN_DIR/src/core/ai/gateway.ts';
import { buildGatewayConfig } from 'GBRAIN_DIR/src/core/ai/build-gateway-config.ts';
import { judgeRow } from 'GBRAIN_DIR/src/eval/longmemeval/judge.ts';
import { BudgetLedger } from 'GBRAIN_DIR/src/eval/shared/judge-runner.ts';

configureGateway(buildGatewayConfig({
  embedding_model: process.env.GBRAIN_EMBEDDING_MODEL ?? 'openai:text-embedding-3-large',
  embedding_dimensions: Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS ?? 1536),
} as any));

export const M6 = process.env.M6_DIR ?? process.cwd();

export interface Turn { role: string; content: string; has_answer?: boolean }
export interface Question {
  question_id: string; question_type: string; question: string; question_date: string;
  answer: string | number; answer_session_ids: string[]; haystack_dates: string[];
  haystack_session_ids: string[]; haystack_sessions: Turn[][];
}

let _ds: Map<string, Question> | null = null;
export function dataset(): Map<string, Question> {
  if (!_ds) {
    const arr: Question[] = JSON.parse(readFileSync(`${M6}/data/longmemeval_s_cleaned.json`, 'utf8'));
    _ds = new Map(arr.map(q => [q.question_id, q]));
  }
  return _ds;
}

export function readNdjson(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}
export const appendNdjson = (path: string, rec: unknown) => appendFileSync(path, JSON.stringify(rec) + '\n');

/** Distinct raw session ids among the row's retrieved chunk rows, first-occurrence (rank) order. */
export function distinctSessions(row: any, k = 5): string[] {
  const out: string[] = [];
  for (const r of row.retrieved as any[]) {
    if (r.rank > k) continue;
    if (!out.includes(r.session_id)) out.push(r.session_id);
  }
  return out;
}

/** Python json.dumps(obj) with default separators and ensure_ascii=True. */
export function pyDumps(v: unknown): string {
  const esc = (s: string) => JSON.stringify(s).replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (typeof v === 'string') return esc(v);
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => `${esc(k)}: ${pyDumps(x)}`).join(', ') + '}';
  return JSON.stringify(v);
}

export interface CallResult { text: string; usage: { input_tokens: number; output_tokens: number }; latency_ms: number; total_ms: number; attempts: number; failures: string[]; response_model: string | null; finish_reason: string | null }

/** OpenAI chat.completions with explicit retry accounting (429 / 5xx / network / timeout). */
export async function openaiChat(body: Record<string, unknown>, maxAttempts = 6): Promise<CallResult> {
  const failures: string[] = [];
  const tStart = performance.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = performance.now();
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      const txt = await res.text();
      if (!res.ok) {
        failures.push(`http_${res.status}: ${txt.slice(0, 200)}`);
        if (res.status === 429 || res.status >= 500) { await Bun.sleep(Math.min(60_000, 2000 * 2 ** (attempt - 1))); continue; }
        throw new Error(`openai ${res.status}: ${txt.slice(0, 300)}`);
      }
      const j = JSON.parse(txt);
      return {
        text: String(j.choices?.[0]?.message?.content ?? '').trim(),
        usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 },
        latency_ms: Math.round(performance.now() - t0), total_ms: Math.round(performance.now() - tStart),
        attempts: attempt, failures, response_model: j.model ?? null, finish_reason: j.choices?.[0]?.finish_reason ?? null,
      };
    } catch (err: any) {
      if (String(err?.message).startsWith('openai ')) throw Object.assign(err, { failures });
      failures.push(`network: ${String(err?.message ?? err).slice(0, 200)}`);
      await Bun.sleep(Math.min(60_000, 2000 * 2 ** (attempt - 1)));
    }
  }
  throw Object.assign(new Error(`openai: exhausted ${maxAttempts} attempts`), { failures });
}

/** Gateway chat (the path gbrain's harness uses) with retry accounting. */
export async function gatewayCall(opts: { model: string; system?: string; user: string; maxTokens: number; temperature?: number }, maxAttempts = 5): Promise<CallResult> {
  const failures: string[] = [];
  const tStart = performance.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = performance.now();
    try {
      const r = await gatewayChat({ model: opts.model, system: opts.system, messages: [{ role: 'user', content: opts.user }], maxTokens: opts.maxTokens, ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) });
      return {
        text: r.text.trim(), usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens },
        latency_ms: Math.round(performance.now() - t0), total_ms: Math.round(performance.now() - tStart), attempts: attempt, failures,
        response_model: r.responseModel ?? r.model, finish_reason: r.stopReason,
      };
    } catch (err: any) {
      failures.push(String(err?.message ?? err).slice(0, 200));
      await Bun.sleep(Math.min(60_000, 3000 * 2 ** (attempt - 1)));
    }
  }
  throw Object.assign(new Error(`gateway: exhausted ${maxAttempts} attempts`), { failures });
}

// Exact official LongMemEval evaluate_qa.py::get_anscheck_prompt (verbatim).
export function officialJudgePrompt(task: string, question: string, answer: string | number, response: string, abstention: boolean): string {
  const a = String(answer);
  if (!abstention) {
    if (['single-session-user', 'single-session-assistant', 'multi-session'].includes(task))
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${a}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    if (task === 'temporal-reasoning')
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${a}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    if (task === 'knowledge-update')
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${a}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    if (task === 'single-session-preference')
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${a}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    throw new Error(`unknown task ${task}`);
  }
  return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${a}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
}

/** Official judge: gpt-4o-2024-08-06, chat.completions, temperature 0, max_tokens 10, verdict = 'yes' in lower(). */
export async function officialJudge(q: Question, hypothesis: string) {
  const prompt = officialJudgePrompt(q.question_type, q.question, q.answer, hypothesis, q.question_id.includes('_abs'));
  try {
    const r = await openaiChat({ model: 'gpt-4o-2024-08-06', messages: [{ role: 'user', content: prompt }], n: 1, temperature: 0, max_tokens: 10 });
    return { off_judge_correct: r.text.toLowerCase().includes('yes'), off_judge_raw: r.text, off_judge_usage: r.usage, off_judge_latency_ms: r.latency_ms, off_judge_attempts: r.attempts, off_judge_failures: r.failures, off_judge_model: r.response_model, off_judge_prompt: prompt };
  } catch (err: any) {
    return { off_judge_error: String(err?.message ?? err).slice(0, 300), off_judge_failures: err?.failures ?? [], off_judge_prompt: prompt };
  }
}

const ledger = new BudgetLedger(null, null);
/** gbrain's framed judge (src/eval/longmemeval/judge.ts judgeRow) through the gateway, exactly as the harness calls it. */
export async function gbrainJudge(q: Question, hypothesis: string) {
  let usage: any = null;
  const client = async (opts: any) => { const r = await gatewayChat(opts); usage = r.usage; return r; };
  const f = await judgeRow({ question_id: q.question_id, question_type: q.question_type, question: q.question, answer: String(q.answer ?? ''), hypothesis },
    { client: client as any, model: 'openai:gpt-4o', ledger, configHashFor: () => 'm6' });
  return { ...f, judge_usage: usage };
}

// USD per token, list prices on 2026-09-29 for the models used.
export const PRICE: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3e-6, out: 15e-6 },
  'gpt-4o': { in: 2.5e-6, out: 10e-6 },
  'text-embedding-3-large': { in: 0.13e-6, out: 0 },
};

export async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
