/**
 * One provider-normalized usage and answer receipt for every reading lane
 * (memory-qa reader, think and judge calls, the W10 batch rows, and the shape
 * the Q1 cells and the wave 1 pilot arms adopt). The note
 * docs/benchmarks/2026-10-08-usage-receipt.md documents the fields.
 *
 * Provider conventions this normalizes:
 *
 *   anthropic        `input_tokens` is the uncached input only; prompt-cache
 *                    reads (`cache_read_input_tokens`) and writes
 *                    (`cache_creation_input_tokens`) are separate buckets, so
 *                    the total is their sum. `output_tokens` includes
 *                    thinking (`output_tokens_details.thinking_tokens`).
 *   openai (chat)    `prompt_tokens` is already the total input; the cached
 *                    read (`prompt_tokens_details.cached_tokens`) and write
 *                    (`prompt_tokens_details.cache_write_tokens`) counts are
 *                    subsets of it and are never added on top.
 *                    `completion_tokens` includes
 *                    `completion_tokens_details.reasoning_tokens`.
 *   openai (responses) the same with `input_tokens`, `input_tokens_details`,
 *                    `output_tokens` and `output_tokens_details`.
 *   gbrain-think     gbrain's `think` returns `{ input_tokens, output_tokens }`
 *                    summed over its synthesis calls, with no cache split, so
 *                    the cache fields are null (not reported), never zero.
 *
 * One record is written per attempted invocation: a retried request leaves
 * one `error` record per failed attempt and one `ok` record, and each
 * replicate has its own records. A response served from the harness's local
 * response cache is marked `from_cache` (no provider call in this run).
 */

export const USAGE_RECEIPT_SCHEMA = 'usage-receipt/v1';

export type UsageSource = 'anthropic' | 'openai' | 'gbrain-think';

export interface NormalizedUsage {
  /** Which provider rule produced these numbers; `legacy-cache` is a cached response stored before raw usage was kept (totals only). */
  convention: 'anthropic' | 'openai-chat' | 'openai-responses' | 'gbrain-think' | 'legacy-cache';
  /** Every input token the provider processed: uncached + cache reads + cache writes. */
  input_total: number;
  /** Input neither read from nor written to the prompt cache; null when the source has no cache split. */
  input_uncached: number | null;
  cache_read: number | null;
  cache_write: number | null;
  /** Every output token, reasoning included. */
  output_total: number;
  /** Reasoning or thinking tokens, a subset of output_total; null when not reported. */
  reasoning: number | null;
}

export interface UsageReceipt {
  schema: typeof USAGE_RECEIPT_SCHEMA;
  /** Harness lane, e.g. `memory-qa`, `w10-batch`, `q1-cell`. */
  lane: string;
  role: 'reader' | 'think' | 'judge' | 'builder';
  question_id: string;
  replicate: number;
  /** 0-based provider attempt within this question, replicate and role. */
  attempt: number;
  /** Requested model, `provider:model`. */
  model: string;
  /** Model the provider reported, when it reported one. */
  response_model: string | null;
  status: 'ok' | 'error';
  error: string | null;
  /** Served from the harness's local response cache; usage is the original call's. */
  from_cache: boolean;
  /** Provider-neutral finish: stop, max_tokens, tool_use, refusal, or the raw value. */
  finish: string | null;
  finish_raw: string | null;
  /** The full answer text, never truncated. */
  answer: string;
  usage: NormalizedUsage | null;
  usage_raw: Record<string, unknown> | null;
  /** Tokens of the text delivered to the model, counted with one tokenizer across arms. */
  delivered: { tokenizer: string; tokens: number } | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

/** `provider:model` or a bare model id to the usage convention its responses follow. */
export function usageSourceOf(model: string): Exclude<UsageSource, 'gbrain-think'> {
  const [provider, name] = model.includes(':') ? [model.slice(0, model.indexOf(':')), model.slice(model.indexOf(':') + 1)] : ['', model];
  if (provider === 'anthropic' || (!provider && /^claude/.test(name))) return 'anthropic';
  if (provider === 'openai' || (!provider && /^(gpt|o\d|chatgpt)/.test(name))) return 'openai';
  throw new Error(`no usage convention for ${model}; add one to eval/runner/usage-receipt.ts`);
}

/** Normalize a provider's raw usage object. Null when the response carried no usage. */
export function normalizeUsage(source: UsageSource, raw: unknown): NormalizedUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  if (source === 'anthropic') {
    const uncached = num(u.input_tokens) ?? 0;
    const read = num(u.cache_read_input_tokens) ?? 0;
    const write = num(u.cache_creation_input_tokens) ?? 0;
    return {
      convention: 'anthropic', input_total: uncached + read + write, input_uncached: uncached, cache_read: read, cache_write: write,
      output_total: num(u.output_tokens) ?? 0, reasoning: num(obj(u.output_tokens_details).thinking_tokens),
    };
  }
  if (source === 'gbrain-think') {
    const input = num(u.input_tokens), output = num(u.output_tokens);
    if (input === null && output === null) return null;
    return { convention: 'gbrain-think', input_total: input ?? 0, input_uncached: null, cache_read: null, cache_write: null, output_total: output ?? 0, reasoning: null };
  }
  const chat = u.prompt_tokens !== undefined || u.completion_tokens !== undefined;
  const total = num(chat ? u.prompt_tokens : u.input_tokens) ?? 0;
  const inDetails = obj(chat ? u.prompt_tokens_details : u.input_tokens_details);
  const outDetails = obj(chat ? u.completion_tokens_details : u.output_tokens_details);
  const read = num(inDetails.cached_tokens) ?? 0;
  const write = num(inDetails.cache_write_tokens) ?? 0;
  return {
    convention: chat ? 'openai-chat' : 'openai-responses', input_total: total, input_uncached: Math.max(0, total - read - write), cache_read: read, cache_write: write,
    output_total: num(chat ? u.completion_tokens : u.output_tokens) ?? 0, reasoning: num(outDetails.reasoning_tokens),
  };
}

/** Provider stop or finish reasons in one vocabulary; anything unrecognised passes through. */
export function normalizeFinish(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const map: Record<string, string> = {
    end_turn: 'stop', stop_sequence: 'stop', stop: 'stop', end: 'stop',
    max_tokens: 'max_tokens', length: 'max_tokens', model_context_window_exceeded: 'max_tokens',
    tool_use: 'tool_use', tool_calls: 'tool_use', refusal: 'refusal', content_filter: 'refusal',
  };
  return map[raw] ?? raw;
}

/** gbrain `think`'s synthesis status as a finish reason. */
export function thinkFinish(status: string | undefined): string | null {
  if (status === undefined) return null;
  return status === 'ok' ? 'stop' : status === 'output_truncated' ? 'max_tokens' : status;
}

export function receipt(fields: Omit<UsageReceipt, 'schema'>): UsageReceipt {
  return { schema: USAGE_RECEIPT_SCHEMA, ...fields };
}

export interface UsageTotals {
  /** Every record: provider attempts plus local cache hits. */
  records: number;
  provider_calls: number;
  cache_hits: number;
  errors: number;
  /** Records after the first attempt of their question, replicate and role. */
  retries: number;
  /** Successful records whose response carried no usage. */
  usage_missing: number;
  input_total: number;
  /** Null as soon as one counted record has no cache split (think). */
  input_uncached: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output_total: number;
  reasoning: number | null;
}

/** Sum receipts. Cache-split sums become null when any counted record lacks the split, so a partial sum is never reported as complete. */
export function sumUsage(receipts: UsageReceipt[]): UsageTotals {
  const counted = receipts.filter(r => r.status === 'ok' && r.usage);
  const sumOrNull = (k: 'input_uncached' | 'cache_read' | 'cache_write' | 'reasoning') =>
    counted.some(r => r.usage![k] === null) ? null : counted.reduce((s, r) => s + (r.usage![k] ?? 0), 0);
  return {
    records: receipts.length,
    provider_calls: receipts.filter(r => !r.from_cache).length,
    cache_hits: receipts.filter(r => r.from_cache).length,
    errors: receipts.filter(r => r.status === 'error').length,
    retries: receipts.filter(r => r.attempt > 0).length,
    usage_missing: receipts.filter(r => r.status === 'ok' && !r.usage).length,
    input_total: counted.reduce((s, r) => s + r.usage!.input_total, 0),
    input_uncached: sumOrNull('input_uncached'),
    cache_read: sumOrNull('cache_read'),
    cache_write: sumOrNull('cache_write'),
    output_total: counted.reduce((s, r) => s + r.usage!.output_total, 0),
    reasoning: sumOrNull('reasoning'),
  };
}
