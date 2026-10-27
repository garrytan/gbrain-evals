/**
 * The wave 1 architecture pilot's arms (10x memory advantage plan, A4): pure
 * definitions of every cell, the request bodies each sends, the FALLBACK
 * routing rule, the DIGEST assembly and the dollar arithmetic. The paid
 * driver (run.ts) and the keyless tests use the same functions.
 *
 *   A0          frontier reader on the raw whole sessions (the captured request, byte for byte)
 *   DIRECT      cheap model reads the same captured request
 *   FALLBACK    DIRECT's answer, replaced by A0's when the cheap answer errs, abstains or hedges
 *   BRIEF@B     cheap builder writes a question-aware brief (evidence-brief-v1), frontier reader reads it
 *   DIGEST@B    question-independent per-session digests (B/5 tokens each), written once per session
 *   CACHE       A0's request with provider prompt caching on the whole prefix
 *   TRUNC@B     whole sessions in rank order while they fit B (cl100k), else the top session's head
 */
import { chatPrice } from '../budget-ledger.ts';
import { readerBody } from '../batch/sources.ts';
import type { NormalizedUsage } from '../usage-receipt.ts';
import type { CommitmentLabel } from '../outcomes/v3.ts';

export const BUDGETS = [1000, 2000, 4000, 7000] as const;
export type Budget = typeof BUDGETS[number];
export const CHEAP = ['gpt-6-luna', 'claude-haiku-5-5'] as const;
export const FRONTIER = ['claude-sonnet-5-5', 'gpt-6.1-sol'] as const;
export const OPUS = 'claude-opus-5-5';
export type Cheap = typeof CHEAP[number];
export type Reader = typeof FRONTIER[number] | typeof OPUS;
export const SESSIONS_PER_QUESTION = 5;

/** Reader output limits: Sonnet 5.5 at W10a's preregistered 3,500 (so A0 is W10a's body byte for byte); the others at their table value. */
export const READER_MAX_OUTPUT: Record<string, number | undefined> = { 'claude-sonnet-5-5': 3500 };

export function frontierBody(model: string, text: { system: string; user: string }): Record<string, unknown> {
  const max = READER_MAX_OUTPUT[model];
  return max ? readerBody(model, text, max, max) : readerBody(model, text);
}

/** CACHE: the A0 body with the whole system+user prefix marked cacheable (Anthropic) or keyed for prefix caching (OpenAI). */
export function cacheBody(model: string, text: { system: string; user: string }, cacheKey: string): Record<string, unknown> {
  const body = frontierBody(model, text);
  if (String(model).startsWith('claude')) {
    return { ...body, system: [{ type: 'text', text: text.system }], messages: [{ role: 'user', content: [{ type: 'text', text: text.user, cache_control: { type: 'ephemeral' } }] }] };
  }
  return { ...body, prompt_cache_key: cacheKey };
}

export const cellId = {
  a0: (r: Reader) => `a0:${r}`,
  direct: (c: Cheap) => `direct:${c}`,
  fallback: (c: Cheap, r: Reader) => `fallback:${c}>${r}`,
  brief: (b: Budget, c: Cheap, r: Reader) => `brief@${b}:${c}:${r}`,
  digest: (b: Budget, c: Cheap, r: Reader) => `digest@${b}:${c}:${r}`,
  trunc: (b: Budget, r: Reader) => `trunc@${b}:${r}`,
  cache: (r: Reader) => `cache:${r}`,
};

/** Every quality cell with Sonnet 5.5 and gpt-6.1-sol readers (Opus cells are added after the Sonnet/sol stage picks the two leading arms). */
export function qualityCells(): string[] {
  const out: string[] = [];
  for (const r of FRONTIER) out.push(cellId.a0(r), cellId.cache(r));
  for (const c of CHEAP) out.push(cellId.direct(c));
  for (const c of CHEAP) for (const r of FRONTIER) out.push(cellId.fallback(c, r));
  for (const b of BUDGETS) {
    for (const r of FRONTIER) out.push(cellId.trunc(b, r));
    for (const c of CHEAP) for (const r of FRONTIER) out.push(cellId.brief(b, c, r), cellId.digest(b, c, r));
  }
  return out;
}

/**
 * FALLBACK's frozen routing rule: escalate to the frontier reader's A0 answer
 * when the cheap answer is an execution error, or its commitment label
 * (judged-hedge-label-v1) is `abstain` or `hedged`, or the label is missing.
 */
export function escalate(cheap: { error: string | null; label: CommitmentLabel | null }): boolean {
  return cheap.error !== null || cheap.label === null || cheap.label === 'abstain' || cheap.label === 'hedged';
}

/** List-price dollars of one call from its normalized usage (cache reads and writes at their own rates; long-prompt tier when crossed). */
export function listUsd(model: string, usage: NormalizedUsage | null, provider = model.startsWith('claude') ? 'anthropic' : 'openai'): number {
  if (!usage) return 0;
  const price = chatPrice(`${provider}:${model}`);
  if (!price) throw new Error(`no price for ${provider}:${model}`);
  const rates = price.long && usage.input_total > price.long.above_input_tokens ? price.long : price;
  const uncached = usage.input_uncached ?? usage.input_total;
  return (uncached * rates.input + (usage.cache_read ?? 0) * (rates.cache_read ?? rates.input) + (usage.cache_write ?? 0) * (rates.cache_write ?? rates.input) + usage.output_total * rates.output) / 1e6;
}

/** CACHE dollars per read when one prefix serves `reads` reads inside the provider TTL: one write, then reads at the cache-read rate. */
export function cachedUsdPerRead(model: string, cold: NormalizedUsage, warm: NormalizedUsage, reads: number): number {
  return (listUsd(model, cold) + (reads - 1) * listUsd(model, warm)) / reads;
}

/** Per-session digest budget for DIGEST@B. */
export const digestBudget = (b: Budget) => Math.floor(b / SESSIONS_PER_QUESTION);
