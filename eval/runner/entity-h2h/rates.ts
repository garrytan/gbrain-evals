/**
 * The rates the entity-dedupe head-to-head's spend rules depend on (preregistration, "Budget"), measured in the
 * 2026-11-17 smoke from the metering proxy's usage fields at list prices. Memory-system rates are per ingested page,
 * from the last third of the smoke (cost per page grows with the graph, so they are floors); matcher rates are per
 * candidate pair at default reasoning.
 *
 * The three memory systems re-pinned in Amendment 1 (ext-temporal-graph 0.31.2, ext-graph-pipeline 1.6.8,
 * ext-memory-bank 1.2.1) use their 2026-11-18 re-smoke's rate instead, as Amendment 1 requires: the mean metered cost
 * per page over the last third (pages 47 to 69) of the 69-page smoke world, from each run's usage fields
 * (run-attempt JSON, page sources only), to 7 significant figures. ext-extract-first was not re-pinned and keeps its
 * 2026-11-17 rate.
 *
 * Ledger stops: a memory-system run stops at STOP_MULTIPLIER (1.5) times its projected cost (rate times the world's
 * page count); a matcher run stops at its projected cost (rate times candidate pairs). At CHECKPOINT_PAGES (345) every
 * memory-system ingest re-measures its cost per page and pauses before the rest when that rate projects the run past
 * its stop.
 */
export const MEMORY_KINDS = ['ext-temporal-graph', 'ext-graph-pipeline', 'ext-extract-first', 'ext-memory-bank'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
export const MEMORY_USD_PER_PAGE: Record<MemoryKind, number> = { 'ext-temporal-graph': 0.03431286, 'ext-graph-pipeline': 0.00505538, 'ext-extract-first': 0.0045, 'ext-memory-bank': 0.002226643 };
/** The language model every memory system runs with (its default provider family's newest model). */
export const MEMORY_MODEL = 'openai:gpt-6.2-sol';

export const MATCHER_MODELS = ['anthropic:claude-opus-5-5', 'particle:particle-1', 'openai:gpt-6.2-sol'] as const;
export type MatcherModel = typeof MATCHER_MODELS[number];
export const MATCHER_USD_PER_PAIR: Record<MatcherModel, number> = { 'anthropic:claude-opus-5-5': 0.003, 'particle:particle-1': 0.00021, 'openai:gpt-6.2-sol': 0.00055 };

export const STOP_MULTIPLIER = 1.5;
export const CHECKPOINT_PAGES = 345;
/** Tuning: at most 4 settings per memory system, each on a slice of the held-out seed with 5 instances per family. */
export const TUNING_SETTINGS = 4;
export const TUNING_PER_FAMILY = 5;
/** A cell gets at most one restart after a crash; a second failure ends it as "failed (infrastructure)". */
export const MAX_ATTEMPTS = 2;

const cents = (n: number) => Math.ceil(n * 100 - 1e-9) / 100;
/** A memory-system run's projected cost and its ledger stop, in dollars (stop rounded up to a cent). */
export function memoryStop(kind: MemoryKind, pages: number): { projected_usd: number; stop_usd: number } {
  const projected = MEMORY_USD_PER_PAGE[kind] * pages;
  return { projected_usd: projected, stop_usd: cents(projected * STOP_MULTIPLIER) };
}
/** A matcher run's projected cost, which is also its ledger stop (rounded up to a cent). */
export function matcherStop(model: MatcherModel, pairs: number): { projected_usd: number; stop_usd: number } {
  const projected = MATCHER_USD_PER_PAIR[model] * pairs;
  return { projected_usd: projected, stop_usd: cents(projected) };
}
