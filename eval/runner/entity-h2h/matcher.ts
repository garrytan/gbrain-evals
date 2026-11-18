/**
 * Entity-dedupe head-to-head, language-model matcher baseline: the frozen blocker (blocker.ts) gives candidate pairs,
 * and one call per pair asks the model, with the frozen prompt in matcher-prompt.md, whether both pages describe the
 * same person or company. `yes` pairs are the auto tier and `unsure` pairs the proposed tier; the scorer closes both.
 *
 * Models: claude-opus-5-5, particle-1 and gpt-6.2-sol, each at its default reasoning (particle-1's default, high, is
 * sent explicitly), with an output cap of 4,096 tokens (particle-1: its provider row's floor). Every call goes to the metering proxy (eval/runner/metering-proxy.ts), which holds the keys,
 * reserves each request against the run's lease before sending and logs one usage line per request. Each request
 * carries `x-proxy-brain: pair:<a>|<b>`, so the usage log names the pair it paid for.
 *
 * Outcomes per pair: a verdict (yes, no, unsure), an answer with no verdict (unparsed, reported, never guessed), a
 * safety-filter stop (its own outcome, never a model failure: OpenAI-style finish_reason content_filter, Anthropic
 * stop_reason refusal, or a provider error that names a content or safety policy), a budget refusal from the proxy
 * (the run's ledger stop: the run pauses, asking no further pair) or an error.
 *
 * Resume (preregistration, "Crash and resume"): after the reconcile, a resumed run asks only pairs with no request
 * on the proxy log; a pair whose request was sent but got no verdict is asked again at most once, counted twice in
 * spend, and reported. A pair still without a verdict after that is reported as having none.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compatRequest } from '../providers/openai-compatible.ts';
import { normalizeUsage, type NormalizedUsage } from '../usage-receipt.ts';

export const MATCHER_PROMPT_FILE = join(import.meta.dir, 'matcher-prompt.md');
export const MATCHER_VERSION = 'entity-h2h matcher v1';
/** Output caps (reasoning included) that keep each request's ledger reservation near its real cost; a one-word verdict and a line of reasons fit far inside them, and the reasoning effort stays each model's default. particle-1 takes its provider row's output floor. */
const ANTHROPIC_MAX_TOKENS = 4096;
const OPENAI_MAX_COMPLETION_TOKENS = 4096;
const PROXY_HOLDS_KEY = 'dummy-key-the-proxy-injects-the-real-one';

/** The frozen prompt: the whole of matcher-prompt.md, with {{page_a}} and {{page_b}} replaced by the two pages. */
export function matcherPrompt(): { template: string; sha256: string } {
  const template = readFileSync(MATCHER_PROMPT_FILE, 'utf8');
  if (!template.includes('{{page_a}}') || !template.includes('{{page_b}}')) throw new Error(`entity-h2h: ${MATCHER_PROMPT_FILE} must hold {{page_a}} and {{page_b}}`);
  return { template, sha256: createHash('sha256').update(template).digest('hex') };
}

export const pairPrompt = (template: string, a: string, b: string) => template.replace('{{page_a}}', () => a).replace('{{page_b}}', () => b);
export const pairBrain = (a: string, b: string) => `pair:${a}|${b}`;

/** yes, no or unsure from the first word of an answer; null when it opens with none of them. */
export function verdictOf(text: string): 'yes' | 'no' | 'unsure' | null {
  const first = text.trim().replace(/^[^a-zA-Z]+/, '').split(/[^a-zA-Z]/)[0]?.toLowerCase();
  return first === 'yes' || first === 'no' || first === 'unsure' ? first : null;
}

export type Outcome = 'answer' | 'safety_stop' | 'budget_refused' | 'error';
export interface Answer { outcome: Outcome; text: string; verdict: 'yes' | 'no' | 'unsure' | null; usage: NormalizedUsage | null; model: string | null; status: number | null; detail: string | null }

const SAFETY_WORDS = /content[ _-]?(?:filter|policy|management)|safety|flagged|cyber_policy|usage polic/i;

/** One call through the metering proxy's slot for this model. The proxy injects the key; the request carries none. */
export async function ask(model: string, prompt: string, proxy: string, slot: string, brain: string, fetchImpl: typeof fetch = fetch): Promise<Answer> {
  const base = `${proxy.replace(/\/$/, '')}/${slot}`;
  const provider = model.slice(0, model.indexOf(':')), id = model.slice(model.indexOf(':') + 1);
  const anthropic = provider === 'anthropic';
  let url: string, headers: Record<string, string>, body: Record<string, unknown>;
  if (provider === 'particle') {
    const req = compatRequest(model, [{ role: 'user', content: prompt }], {}, { PARTICLE_BASE_URL: `${base}/particle/v1`, PARTICLE_API_KEY: PROXY_HOLDS_KEY });
    ({ url, headers, body } = req);
  } else if (anthropic || provider === 'openai') {
    url = anthropic ? `${base}/anthropic/v1/messages` : `${base}/openai/v1/chat/completions`;
    headers = { 'content-type': 'application/json', ...(anthropic ? { 'anthropic-version': '2023-06-01', 'x-api-key': PROXY_HOLDS_KEY } : { authorization: `Bearer ${PROXY_HOLDS_KEY}` }) };
    body = anthropic ? { model: id, max_tokens: ANTHROPIC_MAX_TOKENS, messages: [{ role: 'user', content: prompt }] } : { model: id, max_completion_tokens: OPENAI_MAX_COMPLETION_TOKENS, messages: [{ role: 'user', content: prompt }] };
  } else throw new Error(`matcher: no route for ${model}`);
  const none = { text: '', verdict: null, usage: null, model: null } as const;
  let res: Response;
  try { res = await fetchImpl(url, { method: 'POST', headers: { ...headers, 'x-proxy-brain': brain }, body: JSON.stringify(body) }); }
  catch (e) { return { ...none, outcome: 'error', status: null, detail: String((e as Error).message).slice(0, 300) }; }
  const raw = await res.text();
  let json: Record<string, any> | null = null;
  try { json = JSON.parse(raw); } catch { json = null; }
  if (!res.ok) {
    const err = json?.error ?? {};
    const detail = `HTTP ${res.status} ${String(err.message ?? raw).slice(0, 300)}`;
    if (res.status === 402 && (err.kind === 'budget' || err.type === 'budget')) return { ...none, outcome: 'budget_refused', status: 402, detail };
    if (res.status === 400 && SAFETY_WORDS.test(`${err.code ?? ''} ${err.type ?? ''} ${err.message ?? ''}`)) return { ...none, outcome: 'safety_stop', status: 400, detail };
    return { ...none, outcome: 'error', status: res.status, detail };
  }
  if (!json) return { ...none, outcome: 'error', status: res.status, detail: 'response is not JSON' };
  if (anthropic) {
    const text = (json.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('');
    const usage = normalizeUsage('anthropic', json.usage);
    if (json.stop_reason === 'refusal') return { outcome: 'safety_stop', text, verdict: null, usage, model: json.model ?? null, status: res.status, detail: 'stop_reason refusal' };
    return { outcome: 'answer', text, verdict: verdictOf(text), usage, model: json.model ?? null, status: res.status, detail: null };
  }
  const choice = json.choices?.[0] ?? {};
  const text = typeof choice.message?.content === 'string' ? choice.message.content : '';
  const usage = normalizeUsage('openai', json.usage);
  if (choice.finish_reason === 'content_filter' || choice.message?.refusal) return { outcome: 'safety_stop', text, verdict: null, usage, model: json.model ?? null, status: res.status, detail: `finish_reason ${choice.finish_reason}` };
  return { outcome: 'answer', text, verdict: verdictOf(text), usage, model: json.model ?? null, status: res.status, detail: null };
}

export interface CallEvent { a: string; b: string; attempt: number; reask: boolean; outcome: Outcome | 'pending'; verdict: 'yes' | 'no' | 'unsure' | null; status: number | null; detail: string | null; answer: string; usage: NormalizedUsage | null; response_model: string | null; ms: number }

export interface PairPlan { ask: Array<{ a: string; b: string; reask: boolean }>; settled: number; no_verdict: Array<{ a: string; b: string; why: string }> }

/**
 * Which pairs a run asks. A pair is settled by an answer (a verdict, or an answer with none) or a safety stop. On a
 * resume, an unsettled pair with no request on the proxy log is asked; one that has a request there is asked again
 * once (reask); one already asked again is left with no verdict.
 */
export function planPairs(pairs: ReadonlyArray<readonly [string, string]>, events: readonly CallEvent[], logged: ReadonlySet<string>): PairPlan {
  const last = new Map<string, CallEvent[]>();
  for (const e of events) last.set(pairBrain(e.a, e.b), [...(last.get(pairBrain(e.a, e.b)) ?? []), e]);
  const plan: PairPlan = { ask: [], settled: 0, no_verdict: [] };
  for (const [a, b] of pairs) {
    const es = last.get(pairBrain(a, b)) ?? [];
    if (es.some(e => e.outcome === 'answer' || e.outcome === 'safety_stop')) { plan.settled++; continue; }
    if (!logged.has(pairBrain(a, b))) { plan.ask.push({ a, b, reask: false }); continue; }
    const orphan = es.some(p => p.reask && p.outcome === 'pending' && !es.some(x => x.reask && x.outcome !== 'pending' && x.attempt === p.attempt));
    if (orphan || es.some(e => e.reask && e.outcome !== 'budget_refused' && e.outcome !== 'pending')) { plan.no_verdict.push({ a, b, why: es.at(-1)?.detail ?? 'sent, no verdict, already asked again once' }); continue; }
    plan.ask.push({ a, b, reask: true });
  }
  return plan;
}
