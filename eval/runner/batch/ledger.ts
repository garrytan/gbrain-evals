/**
 * Ledger arithmetic for the batch lane: worst-case reservations sized from
 * real token counts, settlement from provider usage, and the batch price
 * factor.
 *
 * A batch reserves the sum of its requests' worst cases: counted input tokens
 * at the input price (at the cache-write price where the ledger's pricing says
 * a request may write the cache) plus the full output limit at the output
 * price, times the batch factor. The factor is 1.0 (list price) for a
 * provider and model until a pilot billed through the batch endpoint confirms
 * the discount; settlement is provider usage at list price times the same
 * confirmed factor. A request whose usage is missing or malformed is charged
 * its worst case, so the ledger never undercounts.
 */
import { priceRequest, reservationUsd, usageCost, type RequestPrice } from '../budget-ledger.ts';
import type { Provider } from './manifest.ts';
import type { BatchStatus, NormalizedResult } from './transport.ts';

export const PROVIDER_URL: Record<Provider, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
};

/** Published batch discount per provider (OpenAI Batch API and Anthropic Message Batches: half of list price). */
export const DOCUMENTED_BATCH_FACTOR: Record<Provider, { factor: number; source: string }> = {
  openai: { factor: 0.5, source: 'https://platform.openai.com/docs/guides/batch (Batch API: 50% lower cost than synchronous requests)' },
  anthropic: { factor: 0.5, source: 'https://platform.claude.com/docs/en/build-with-claude/batch-processing (Message Batches are billed at 50% of standard API prices)' },
};

export function priceOf(provider: Provider, body: Record<string, unknown>): RequestPrice {
  const price = priceRequest(PROVIDER_URL[provider], body);
  if (!price) throw new Error(`${provider} request is not priced`);
  return price;
}

/** One request's worst case at list price, from its counted input tokens and its output limit. */
export function worstCaseListUsd(provider: Provider, body: Record<string, unknown>, inputTokens: number): number {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new Error(`invalid input token count ${inputTokens}`);
  return reservationUsd({ ...priceOf(provider, body), inputTokens });
}

/** The reservation for a batch: Σ per-request worst case × factor. */
export function batchReservationUsd(provider: Provider, requests: { body: Record<string, unknown>; inputTokens: number }[], factor: number): number {
  if (!(factor > 0 && factor <= 1)) throw new Error(`batch factor must be in (0, 1], got ${factor}`);
  return requests.reduce((s, r) => s + worstCaseListUsd(provider, r.body, r.inputTokens), 0) * factor;
}

export interface RowCost { list_usd: number; usd: number; input_tokens: number; output_tokens: number; basis: 'usage' | 'worst-case' | 'not-billed' }

/**
 * Cost of one result row. Succeeded rows with usable usage settle at list ×
 * factor. Succeeded rows without usable usage are charged their worst case.
 * Errored, expired, canceled and missing requests are not billed by either provider.
 */
export function rowCost(price: RequestPrice, worstListUsd: number, result: NormalizedResult, factor: number): RowCost {
  if (result.status !== 'succeeded') return { list_usd: 0, usd: 0, input_tokens: 0, output_tokens: 0, basis: 'not-billed' };
  const measured = result.usage ? usageCost(price, { usage: result.usage }) : null;
  if (!measured || !Number.isFinite(measured.usd) || measured.usd < 0) {
    return { list_usd: worstListUsd, usd: worstListUsd * factor, input_tokens: 0, output_tokens: 0, basis: 'worst-case' };
  }
  return { list_usd: measured.usd, usd: measured.usd * factor, input_tokens: measured.input_tokens, output_tokens: measured.output_tokens, basis: 'usage' };
}

export interface FactorEvidence {
  provider: Provider;
  model: string;
  factor: number;
  confirmed: boolean;
  basis: string;
  documented: { factor: number; source: string };
  checks: Record<string, unknown>;
}

/**
 * Decide the batch factor a pilot supports. Neither provider's billing API is
 * readable with a standard key, so a pilot confirms the documented discount
 * from what the provider reports about the requests themselves: Anthropic
 * labels every batch-billed message `usage.service_tier: "batch"`; OpenAI's
 * batch object reports usage that must equal the sum of its rows' usage
 * (requests accounted by the Batch API, not the synchronous endpoint). Any
 * failed check leaves the factor at 1.0.
 */
export function confirmFactor(provider: Provider, model: string, batch: BatchStatus, results: NormalizedResult[]): FactorEvidence {
  const documented = DOCUMENTED_BATCH_FACTOR[provider];
  const ok = results.filter(r => r.status === 'succeeded');
  const checks: Record<string, unknown> = { batch_id: batch.id, batch_status: batch.status, succeeded: ok.length, results: results.length };
  let confirmed = ok.length > 0;
  if (provider === 'anthropic') {
    const tiers = [...new Set(ok.map(r => r.service_tier))];
    checks.service_tiers = tiers;
    confirmed &&= tiers.length === 1 && tiers[0] === 'batch';
  } else {
    const sum = (k: string) => ok.reduce((s, r) => s + Number((r.usage as Record<string, unknown> | null)?.[k] ?? 0), 0);
    const rowsIn = sum('prompt_tokens');
    const rowsOut = sum('completion_tokens');
    const batchIn = Number(batch.usage?.input_tokens ?? NaN);
    const batchOut = Number(batch.usage?.output_tokens ?? NaN);
    Object.assign(checks, { rows_input_tokens: rowsIn, rows_output_tokens: rowsOut, batch_input_tokens: batchIn, batch_output_tokens: batchOut });
    confirmed &&= batch.status === 'completed' && rowsIn === batchIn && rowsOut === batchOut;
  }
  const models = [...new Set(ok.map(r => r.response_model ?? ''))];
  checks.response_models = models;
  return {
    provider, model, factor: confirmed ? documented.factor : 1, confirmed, documented, checks,
    basis: confirmed
      ? `documented ${documented.factor} batch factor confirmed by the provider's own accounting of the pilot (${provider === 'anthropic' ? 'every message billed at service_tier "batch"' : 'batch-object usage equals the rows\' usage'}); no invoice read: this key cannot read either provider's billing API`
      : 'pilot did not confirm batch billing; the lane stays at list price (factor 1.0)',
  };
}
