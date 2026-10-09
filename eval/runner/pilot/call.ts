/**
 * Synchronous provider calls for the wave 1 pilot: one request body (the
 * batch lane's body shape from batch/sources.ts) sent to Anthropic Messages
 * or OpenAI Chat Completions through `globalThis.fetch`, which the budget
 * ledger's paid-request guard wraps, with a wall-clock timer and one
 * usage-receipt/v1 record per attempt. No local answer cache exists here, so
 * every call is a provider call.
 */
import { normalizeAnthropicLine, normalizeOpenAiLine, type NormalizedResult } from '../batch/transport.ts';
import { providerOf } from '../batch/sources.ts';
import { normalizeFinish, normalizeUsage, receipt, usageSourceOf, type UsageReceipt } from '../usage-receipt.ts';

export interface CallResult extends NormalizedResult {
  latency_ms: number;
  attempts: number;
  receipts: UsageReceipt[];
}

export interface CallContext { lane: string; role: UsageReceipt['role']; question_id: string; replicate?: number; delivered?: { tokenizer: string; tokens: number } | null }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const RETRYABLE = /\b(429|500|502|503|504|529|overloaded|timeout|ECONNRESET|socket)\b/i;

async function once(body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<NormalizedResult> {
  const model = String(body.model);
  if (providerOf(model) === 'anthropic') {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null) as Record<string, any> | null;
    if (!res.ok || !json) return { custom_id: '', status: 'errored', text: null, finish: null, usage: null, response_model: null, service_tier: null, error: `${res.status} ${JSON.stringify(json?.error ?? json).slice(0, 300)}` };
    return normalizeAnthropicLine({ custom_id: '', result: { type: 'succeeded', message: json } });
  }
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null) as Record<string, any> | null;
  return normalizeOpenAiLine({ custom_id: '', response: { status_code: res.ok ? 200 : res.status, body: json }, ...(res.ok ? {} : { error: { code: String(res.status), message: JSON.stringify(json?.error ?? json).slice(0, 300) } }) });
}

/** Send one body, retrying transient failures up to `retries` times; the timer covers the successful attempt only. */
export async function callModel(body: Record<string, unknown>, ctx: CallContext, opts: { retries?: number; fetchImpl?: typeof fetch } = {}): Promise<CallResult> {
  const retries = opts.retries ?? 2;
  const fetchImpl = opts.fetchImpl ?? ((u, i) => globalThis.fetch(u, i)) as typeof fetch;
  const model = String(body.model);
  const source = usageSourceOf(model.includes(':') ? model : `${providerOf(model)}:${model}`);
  const receipts: UsageReceipt[] = [];
  let last: NormalizedResult | null = null;
  let latency = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = performance.now();
    let r: NormalizedResult;
    try { r = await once(body, fetchImpl); }
    catch (e) { r = { custom_id: '', status: 'errored', text: null, finish: null, usage: null, response_model: null, service_tier: null, error: e instanceof Error ? e.message : String(e) }; }
    latency = performance.now() - t0;
    receipts.push(receipt({
      lane: ctx.lane, role: ctx.role, question_id: ctx.question_id, replicate: ctx.replicate ?? 0, attempt, model: `${providerOf(model)}:${model}`,
      response_model: r.response_model, status: r.status === 'succeeded' ? 'ok' : 'error', error: r.error, from_cache: false,
      finish: normalizeFinish(r.finish), finish_raw: r.finish, answer: r.text ?? '', usage: normalizeUsage(source, r.usage), usage_raw: r.usage, delivered: ctx.delivered ?? null,
    }));
    last = r;
    if (r.status === 'succeeded' || !RETRYABLE.test(r.error ?? '') || attempt === retries) break;
    await sleep(2000 * (attempt + 1));
  }
  return { ...last!, latency_ms: Math.round(latency), attempts: receipts.length, receipts };
}

/** Run `fn` over items with bounded concurrency, preserving order. */
export async function pool<T, R>(items: readonly T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }));
  return out;
}
