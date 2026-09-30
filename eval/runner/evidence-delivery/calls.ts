/**
 * Paid calls for the evidence-delivery study: the reader (through gbrain's
 * gateway, as R1), the agent-fetch loop, gbrain's framed judge (primary) and
 * the verbatim official LongMemEval judge (confirmation). Every request
 * leaves through fetch, so the budget ledger's paid-request guard reserves
 * and reconciles it; nothing here bypasses the ledger.
 */
import { GET_PAGE_TOOL, getPageResult, type ReaderRequest, type ReaderSessionBlock, type Renderer } from './arms.ts';
import type { GbrainModules } from './gbrain.ts';

export interface Usage { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }
export interface ReaderResult { text: string; usage: Usage; latency_ms: number; total_ms: number; attempts: number; failures: string[]; response_model: string | null; finish_reason: string | null; turns?: number; tool_calls?: number; fetched?: string[] }

/** Provider-reported complete reader input: fresh input plus cache reads and writes. */
export const providerInputTokens = (u: Usage) => u.input_tokens + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const isBudget = (e: any) => e?.name === 'BudgetExceededError';

function usageOf(r: any): Usage {
  return { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0, cache_read_tokens: r.usage?.cache_read_tokens ?? 0, cache_creation_tokens: r.usage?.cache_creation_tokens ?? 0 };
}

/** One reader request through the gateway, retried on provider failures; a budget refusal is never retried. */
export async function readerCall(g: GbrainModules, req: ReaderRequest, maxAttempts = 5): Promise<ReaderResult> {
  const failures: string[] = [];
  const tStart = performance.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = performance.now();
    try {
      const r = await g.gateway.chat({ model: req.model, system: req.system, messages: req.messages, maxTokens: req.max_tokens });
      return { text: String(r.text ?? '').trim(), usage: usageOf(r), latency_ms: Math.round(performance.now() - t0), total_ms: Math.round(performance.now() - tStart), attempts: attempt, failures, response_model: r.responseModel ?? r.model ?? null, finish_reason: r.stopReason ?? null };
    } catch (err: any) {
      if (isBudget(err)) throw err;
      failures.push(String(err?.message ?? err).slice(0, 200));
      if (attempt < maxAttempts) await sleep(Math.min(60_000, 3000 * 2 ** (attempt - 1)));
    }
  }
  throw Object.assign(new Error(`reader: exhausted ${maxAttempts} attempts`), { failures });
}

/**
 * E1b: the chunk arm's request plus a get_page tool, at most `maxFetches`
 * fetches and `maxTurns` model turns. Usage is summed over every turn.
 */
export async function agentFetchCall(g: GbrainModules, req: ReaderRequest, pages: Map<string, ReaderSessionBlock>, r: Renderer, caps: { maxFetches: number; maxTurns: number }): Promise<ReaderResult> {
  const messages: any[] = [...req.messages];
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const failures: string[] = [];
  const fetched: string[] = [];
  const tStart = performance.now();
  let toolCalls = 0, attempts = 0, last: any = null;
  for (let turn = 1; turn <= caps.maxTurns; turn++) {
    let resp: any = null;
    for (let attempt = 1; attempt <= 5 && !resp; attempt++) {
      attempts++;
      try { resp = await g.gateway.chat({ model: req.model, system: req.system, messages, tools: [GET_PAGE_TOOL], maxTokens: req.max_tokens }); }
      catch (err: any) {
        if (isBudget(err)) throw err;
        failures.push(String(err?.message ?? err).slice(0, 200));
        if (attempt === 5) throw Object.assign(new Error('agent: exhausted 5 attempts'), { failures });
        await sleep(Math.min(60_000, 3000 * 2 ** (attempt - 1)));
      }
    }
    last = resp;
    const u = usageOf(resp);
    for (const k of Object.keys(usage) as Array<keyof Usage>) usage[k] += u[k];
    const calls = (resp.blocks ?? []).filter((b: any) => b.type === 'tool-call');
    if (!calls.length) {
      return { text: String(resp.text ?? '').trim(), usage, latency_ms: Math.round(performance.now() - tStart), total_ms: Math.round(performance.now() - tStart), attempts, failures, response_model: resp.responseModel ?? resp.model ?? null, finish_reason: resp.stopReason ?? null, turns: turn, tool_calls: toolCalls, fetched };
    }
    messages.push({ role: 'assistant', content: resp.blocks });
    const results = calls.map((c: any) => {
      toolCalls++;
      if (c.toolName !== GET_PAGE_TOOL.name) return { type: 'tool-result', toolCallId: c.toolCallId, toolName: c.toolName, output: `Unknown tool ${c.toolName}.`, isError: true };
      if (fetched.length >= caps.maxFetches) return { type: 'tool-result', toolCallId: c.toolCallId, toolName: c.toolName, output: `Fetch limit of ${caps.maxFetches} reached. Answer now from what you have.`, isError: true };
      const out = getPageResult((c.input as any)?.session_id, pages, r);
      if (!out.isError) fetched.push(String((c.input as any).session_id));
      return { type: 'tool-result', toolCallId: c.toolCallId, toolName: c.toolName, output: out.text, isError: out.isError };
    });
    messages.push({ role: 'user', content: results });
  }
  throw Object.assign(new Error(`agent: no final answer within ${caps.maxTurns} turns`), { failures, partial: { usage, turns: caps.maxTurns, tool_calls: toolCalls, fetched, text: String(last?.text ?? '') } });
}

// ─── Judges ─────────────────────────────────────────────────────────

export interface JudgeQuestion { question_id: string; question_type: string; question: string; answer: string | number }

/** gbrain's framed judge (src/eval/longmemeval/judge.ts judgeRow), exactly as the harness calls it. */
export async function gbrainJudge(g: GbrainModules, q: JudgeQuestion, hypothesis: string) {
  let usage: any = null;
  const client = async (opts: any) => { const r = await g.gateway.chat(opts); usage = r.usage; return r; };
  const ledger = new g.judgeRunner.BudgetLedger(null, null);
  const f = await g.judge.judgeRow({ question_id: q.question_id, question_type: q.question_type, question: q.question, answer: String(q.answer ?? ''), hypothesis },
    { client, model: 'openai:gpt-4o', ledger, configHashFor: () => 'evidence-delivery' });
  return { ...f, judge_usage: usage };
}

/** Verbatim LongMemEval evaluate_qa.py get_anscheck_prompt (same text as the 2026-09-29 component study's lib.ts). */
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

/** Official judge: gpt-4o-2024-08-06 chat.completions, temperature 0, max_tokens 10, verdict = 'yes' in the lowercased reply. */
export async function officialJudge(q: JudgeQuestion, hypothesis: string, fetchImpl: typeof fetch = fetch) {
  const prompt = officialJudgePrompt(q.question_type, q.question, q.answer, hypothesis, q.question_id.includes('_abs'));
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-2024-08-06', messages: [{ role: 'user', content: prompt }], n: 1, temperature: 0, max_tokens: 10 }),
        signal: AbortSignal.timeout(180_000),
      });
      const txt = await res.text();
      if (!res.ok) {
        failures.push(`http_${res.status}: ${txt.slice(0, 200)}`);
        if (res.status === 429 || res.status >= 500) { await sleep(Math.min(60_000, 2000 * 2 ** (attempt - 1))); continue; }
        break;
      }
      const j = JSON.parse(txt);
      const text = String(j.choices?.[0]?.message?.content ?? '').trim();
      return { off_judge_correct: text.toLowerCase().includes('yes'), off_judge_raw: text, off_judge_usage: j.usage ?? null, off_judge_attempts: attempt, off_judge_failures: failures, off_judge_model: j.model ?? null };
    } catch (err: any) {
      if (isBudget(err)) throw err;
      failures.push(`network: ${String(err?.message ?? err).slice(0, 200)}`);
      await sleep(Math.min(60_000, 2000 * 2 ** (attempt - 1)));
    }
  }
  return { off_judge_error: failures.at(-1) ?? 'failed', off_judge_failures: failures };
}
