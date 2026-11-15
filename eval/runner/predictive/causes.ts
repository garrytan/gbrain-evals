/**
 * Cause ids every predictive measure emits. They mirror GBEV-57's failure-cause
 * taxonomy (eval/runner/failure-causes/taxonomy.ts, TAXONOMY_VERSION 2026-11-11.2)
 * so the gap measures, the nightly loop and the weekly report count the same
 * causes. test/eval/predictive-core.test.ts compares this list with that module
 * whenever it is present.
 */

export const CAUSE_IDS = [
  'harness_error',
  'item_unsupported',
  'reader_budget',
  'operations',
  'ingest_gap',
  'privacy_hidden',
  'tool_contract',
  'write_integrity',
  'memory_not_consulted',
  'retrieval_miss',
  'partial_evidence',
  'wrong_ranking',
  'gold_unopened',
  'summary_loss',
  'stale_fact',
  'wrong_entity',
  'time_reasoning',
  'citation_abstention',
  'model_error',
  'timeout_latency',
  'unclassified',
] as const;
export type CauseId = (typeof CAUSE_IDS)[number];

/** Gap-map failure mode for each cause; harness_error, the suite causes and unclassified map to none. */
export const CAUSE_MODE: Record<CauseId, string | null> = {
  harness_error: null,
  item_unsupported: null,
  reader_budget: null,
  operations: 'F16',
  ingest_gap: 'F10',
  privacy_hidden: 'F8',
  tool_contract: 'F12',
  write_integrity: 'F9',
  memory_not_consulted: 'F13',
  retrieval_miss: 'F1',
  partial_evidence: 'F7',
  wrong_ranking: 'F1',
  gold_unopened: 'F13',
  summary_loss: 'F15',
  stale_fact: 'F3/F4',
  wrong_entity: 'F5',
  time_reasoning: 'F6',
  citation_abstention: 'F14',
  model_error: 'F2',
  timeout_latency: 'F11',
  unclassified: null,
};

/** Why gold was out of a caller's view. Counted, never judged: whether a hide is right is not decided here. */
export const PRIVACY_SUBCAUSES = ['direct_flag', 'alias_inheritance', 'derived_default'] as const;
export type PrivacySubcause = (typeof PRIVACY_SUBCAUSES)[number];

/** Tag carried with ingest_gap when the brain stores a wrong fact. */
export const WRONG_STORED_FACT = 'wrong_stored_fact';

export function isCauseId(value: unknown): value is CauseId {
  return typeof value === 'string' && (CAUSE_IDS as readonly string[]).includes(value);
}

export function countByCause(causes: Iterable<CauseId>): Record<CauseId, number> {
  const counts = Object.fromEntries(CAUSE_IDS.map((id) => [id, 0])) as Record<CauseId, number>;
  for (const cause of causes) counts[cause] += 1;
  return counts;
}
