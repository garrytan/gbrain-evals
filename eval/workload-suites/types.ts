/**
 * Shared record shapes for the memory-proof-wave workload suites (B1 to B4).
 *
 * Every suite emits the same three record streams so the gbrain provider and
 * the comparator provider run from identical raw records:
 *
 *   documents.jsonl      HarnessDocument rows, the shape of the public
 *                        agent-memory benchmark harness's `Document`
 *                        dataclass (src/memory_bench/models.py at the pinned
 *                        commit): id, content, user_id, messages, timestamp,
 *                        context. Ids are opaque.
 *   queries.jsonl        HarnessQuery rows, the shape of the harness `Query`
 *                        dataclass: id, query, gold_ids, gold_answers,
 *                        user_id, meta. gold_ids and gold_answers stay inside
 *                        the harness scorer, as they do for the harness's own
 *                        datasets; meta carries only the query timestamp and
 *                        public category fields.
 *   scorer-labels.jsonl  ScorerLabel rows: the structured question, typed
 *                        gold, presence needles and distractors. Scorer-only;
 *                        never part of any model input.
 */

export type SuiteId = 'passing-details' | 'corrections' | 'time-relationships' | 'beliefs';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface HarnessDocument {
  id: string;
  /** Plain-text rendering of `messages`, one `role: text` line per turn. */
  content: string;
  /** Isolation unit. Providers may keep one store per unit. */
  user_id: string;
  /** ISO-8601 UTC time the conversation happened (observed session time). */
  timestamp: string;
  messages: ChatMessage[];
  /** Neutral provenance hint; never carries ids, labels or answers. */
  context: string;
}

export interface QueryMeta {
  /** ISO-8601 time the question is asked. */
  query_timestamp: string;
  /** Public question category (e.g. `pet`, `as_of_employer`). */
  category: string;
  [key: string]: string | number | boolean;
}

export interface HarnessQuery {
  id: string;
  query: string;
  gold_ids: string[];
  gold_answers: string[];
  user_id: string;
  meta: QueryMeta;
}

/** Text that must be stored for the question to be answerable. */
export interface Needle {
  doc_id: string;
  /** Exact substring of the document content. */
  text: string;
  /** The answer-bearing value inside `text`. */
  value: string;
}

/** A similar detail with a different value that a careless reader may return. */
export interface Distractor {
  doc_id: string;
  value: string;
  kind: string;
}

export type Gold =
  | { kind: 'value'; value: string; stale?: string[] }
  | { kind: 'set'; values: string[]; universe: string[] }
  | { kind: 'none' }
  | { kind: 'change'; from: string; to: string }
  | { kind: 'verdict'; verdict: 'yes' | 'no' | 'not yet' };

export interface ScorerLabel {
  query_id: string;
  suite: SuiteId;
  category: string;
  /** Structured form of the question (what is asked, never the answer). The stub reader receives it. */
  spec: Record<string, unknown>;
  gold: Gold;
  /** Documents the oracle memory delivers. */
  oracle_doc_ids: string[];
  needles: Needle[];
  distractors: Distractor[];
  /** True when the correct answer is "none" (no-memory may answer it correctly). */
  negative: boolean;
}

export interface SuiteBundle {
  suite: SuiteId;
  version: string;
  seed: number;
  smoke: boolean;
  documents: HarnessDocument[];
  queries: HarnessQuery[];
  labels: ScorerLabel[];
  /** Suite-specific extra streams, written as `<name>.json` or `<name>.jsonl`. */
  extra: Record<string, unknown>;
  /** What each document timestamp means (timestamp provenance, plan A0 step 7). */
  timestamp_provenance: string;
}

/** Typed outcome of scoring one answer. */
export type Outcome = 'correct' | 'wrong' | 'stale' | 'distractor' | 'abstain' | 'ambiguous';

export interface ScoreResult { outcome: Outcome; matched: string[] }

export interface SuiteDefinition {
  id: SuiteId;
  version: string;
  defaultSeed: number;
  describe: string;
  generate(opts: { seed: number; smoke: boolean }): SuiteBundle;
  /** Offline reader: answers from the context using the structured question only. */
  stubAnswer(label: ScorerLabel, context: string): string;
  score(label: ScorerLabel, answer: string): ScoreResult;
}
