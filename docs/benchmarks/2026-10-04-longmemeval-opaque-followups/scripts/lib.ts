// Shared helpers for items 1b and 2 (2026-10-04): dataset access, NDJSON I/O, OpenAI Chat Completions with retry
// accounting, the verbatim official LongMemEval judge and gbrain's data-boundary judge. Copied from the
// 2026-09-29 opaque-qa lib.ts; gbrain modules come from the installed dependency (package.json pin).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { configureGateway, chat as gatewayChat } from '../../../../node_modules/gbrain/src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../../../../node_modules/gbrain/src/core/ai/build-gateway-config.ts';
import { judgeRow } from '../../../../node_modules/gbrain/src/eval/longmemeval/judge.ts';
import { BudgetLedger } from '../../../../node_modules/gbrain/src/eval/shared/judge-runner.ts';

configureGateway(buildGatewayConfig({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 } as any));

export interface Question { question_id: string; question_type: string; question: string; question_date: string; answer: string | number; answer_session_ids: string[] }
let _ds: Map<string, Question> | null = null;
export function dataset(): Map<string, Question> {
  if (!_ds) _ds = new Map((JSON.parse(readFileSync(process.env.LME_DATASET!, 'utf8')) as Question[]).map(q => [q.question_id, q]));
  return _ds;
}
export function readNdjson(path: string): any[] {
  if (!existsSync(path)) return [];
  const raw = path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8');
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}
export const appendNdjson = (path: string, rec: unknown) => appendFileSync(path, JSON.stringify(rec) + '\n');

export interface CallResult { text: string; usage: Record<string, unknown>; latency_ms: number; total_ms: number; attempts: number; failures: string[]; response_model: string | null; finish_reason: string | null }
export async function openaiChat(body: Record<string, unknown>, maxAttempts = 3): Promise<CallResult> {
  const failures: string[] = [];
  const tStart = performance.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = performance.now();
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(600_000),
      });
      const txt = await res.text();
      if (!res.ok) {
        failures.push(`http_${res.status}: ${txt.slice(0, 200)}`);
        if (res.status === 429 || res.status >= 500) { await Bun.sleep(Math.min(60_000, 2000 * 2 ** (attempt - 1))); continue; }
        throw new Error(`openai ${res.status}: ${txt.slice(0, 300)}`);
      }
      const j = JSON.parse(txt);
      return { text: String(j.choices?.[0]?.message?.content ?? '').trim(), usage: j.usage ?? {}, latency_ms: Math.round(performance.now() - t0),
        total_ms: Math.round(performance.now() - tStart), attempts: attempt, failures, response_model: j.model ?? null, finish_reason: j.choices?.[0]?.finish_reason ?? null };
    } catch (err: any) {
      if (String(err?.message).startsWith('openai ')) throw Object.assign(err, { failures });
      failures.push(`network: ${String(err?.message ?? err).slice(0, 200)}`);
      await Bun.sleep(Math.min(60_000, 2000 * 2 ** (attempt - 1)));
    }
  }
  throw Object.assign(new Error(`openai: exhausted ${maxAttempts} attempts`), { failures });
}

// Exact official LongMemEval evaluate_qa.py::get_anscheck_prompt (verbatim, as in the 2026-09-29 lib.ts).
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
    return { off_judge_correct: r.text.toLowerCase().includes('yes'), off_judge_raw: r.text, off_judge_usage: r.usage, off_judge_attempts: r.attempts, off_judge_failures: r.failures, off_judge_model: r.response_model };
  } catch (err: any) {
    return { off_judge_error: String(err?.message ?? err).slice(0, 300), off_judge_failures: err?.failures ?? [] };
  }
}

const ledger = new BudgetLedger(null, null);
/** gbrain's data-boundary judge (judgeRow) through the gateway, as the harness calls it; retries=2 (at most two retries). */
export async function gbrainJudge(q: Question, hypothesis: string, model: string) {
  let usage: any = null;
  const client = async (opts: any) => { const r = await gatewayChat(opts); usage = r.usage; return r; };
  const f = await judgeRow({ question_id: q.question_id, question_type: q.question_type, question: q.question, answer: String(q.answer ?? ''), hypothesis },
    { client: client as any, model, ledger, configHashFor: () => 'opaque-followups-2026-10-04', retries: 2 } as any);
  return { ...f, judge_usage: usage };
}

export async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
