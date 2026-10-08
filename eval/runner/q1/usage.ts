/**
 * One place that turns a provider's reported usage into the answer record's buckets.
 *
 * Providers disagree on what their input count holds:
 *   anthropic  `input_tokens` is the uncached input only; `cache_read_input_tokens` and
 *              `cache_creation_input_tokens` are separate buckets beside it.
 *   openai     the input count already includes cached tokens: Chat Completions `prompt_tokens` includes
 *              `prompt_tokens_details.cached_tokens`, and the Responses API's `input_tokens` includes
 *              `input_tokens_details.cached_tokens`. Every other source that reports an inclusive prompt count
 *              (the agent runtime's `prompt_tokens`, which includes `cached_input_tokens` and `cache_write_tokens`)
 *              follows this convention.
 *
 * `raw` may be a provider's `usage` object or a `ChatResult` (eval/runner/memory-qa/qa.ts), whose `input_tokens`
 * keeps the provider's own convention.
 */
import type { Usage } from '../memory-qa/records.ts';

export type UsageConvention = 'anthropic' | 'openai';

export interface NormalizedUsage { uncached_input: number; cache_read: number; cache_write: number; output: number; total_input: number }

const first = (...values: unknown[]) => values.find((v): v is number => typeof v === 'number' && Number.isFinite(v)) ?? 0;

export function normalizeUsage(provider: UsageConvention, raw: object | null | undefined): NormalizedUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? u.input_tokens_details ?? {}) as Record<string, unknown>;
  const input = first(u.prompt_tokens, u.input_tokens);
  const cache_read = first(details.cached_tokens, u.cache_read_input_tokens, u.cache_read_tokens, u.cached_input_tokens);
  const cache_write = first(u.cache_creation_input_tokens, u.cache_write_tokens);
  const output = first(u.completion_tokens, u.output_tokens);
  const uncached_input = provider === 'anthropic' ? input : Math.max(0, input - cache_read - cache_write);
  return { uncached_input, cache_read, cache_write, output, total_input: uncached_input + cache_read + cache_write };
}

/** The convention of a `provider:model` reader id; bare ids are OpenAI models. */
export const readerConvention = (reader: string): UsageConvention => reader.startsWith('anthropic:') ? 'anthropic' : 'openai';

/** The answer record's `usage` (input = uncached input) from normalized usage. */
export const answerUsage = (n: NormalizedUsage): Usage => ({ input: n.uncached_input, output: n.output, cache_read: n.cache_read, cache_write: n.cache_write });
