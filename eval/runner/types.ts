/**
 * BrainBench adapter interface (v1.1 Phase 2).
 *
 * Adapters are configs-under-test. Each one ingests the same raw pages,
 * answers the same queries, and emits ranked results. The runner treats
 * BrainState as opaque — it never inspects adapter internals.
 *
 * Ingestion boundary: the runner passes `rawPages: Page[]` in memory.
 * Adapters NEVER receive the `gold/` directory path. Gold is consumed only
 * by scorers, which the runner calls separately on adapter output. This is
 * structural enforcement of the "system-under-test gets only raw pages"
 * contract (eng pass 2 requirement).
 *
 * Precedence of adapter implementations (ships across Phase 2):
 *   GbrainAdapter       (configs A–F — existing gbrain wrapped in the interface)
 *   RipgrepBm25Adapter  (EXT-1 — strong grep-based baseline)
 *   VectorOnlyAdapter   (EXT-2 — commodity vector RAG, same embedder as gbrain)
 *   HybridNoGraphAdapter(EXT-3 — gbrain vector-grep-rrf-fusion with graph features disabled)
 */

// ─── Page ────────────────────────────────────────────────────────────

/**
 * A raw page as the adapter sees it. Slug is the stable ID;
 * compiled_truth + timeline are the prose the adapter indexes.
 * Frontmatter carries loosely-typed metadata (type, title, etc.).
 */
export interface Page {
  slug: string;
  // BrainBench v1 adds email | slack | calendar-event | note for the amara-life-v1
  // corpus (inbox/slack/calendar/notes ingestion). Existing categories unchanged.
  type: 'person' | 'company' | 'meeting' | 'concept' | 'deal' | 'project' | 'source' | 'media'
      | 'email' | 'slack' | 'calendar-event' | 'note';
  title: string;
  compiled_truth: string;
  timeline: string;
  /** Optional additional metadata. Adapters should NOT rely on _facts —
   *  that field is the gold canonical source, reserved for scorers. */
  frontmatter?: Record<string, unknown>;
}

/**
 * PublicPage — the shape adapters SEE at runtime (Day 9 sealed-qrels).
 *
 * Multi-adapter.ts calls `sanitizePage()` before passing the array to
 * `adapter.init()`. The sanitized copy has NO `_facts`, NO `frontmatter`,
 * NO arbitrary keys — only the five public fields below. Adapters that
 * try `(page as any)._facts` get `undefined` instead of the gold object.
 *
 * This is soft enforcement (a misbehaving adapter could still open
 * `eval/data/gold/*.json` from disk). Hard enforcement via process
 * isolation ships with BrainBench v2's Docker sandbox.
 */
export type PublicPage = Pick<Page, 'slug' | 'type' | 'title' | 'compiled_truth' | 'timeline'>;

export function sanitizePage(p: Page): PublicPage {
  return {
    slug: p.slug,
    type: p.type,
    title: p.title,
    compiled_truth: p.compiled_truth,
    timeline: p.timeline,
  };
}

// ─── Query ───────────────────────────────────────────────────────────

export type Tier =
  | 'easy'              // T1: single-page lookup
  | 'medium'            // T2: relational, graph-required
  | 'hard'              // T3: multi-hop + temporal
  | 'adversarial'       // T4: identity collisions, contradictions
  | 'fuzzy'             // T5: vague recall, "I know I mentioned it somewhere"
  | 'externally-authored'; // T5.5: outside-researcher queries

export type ExpectedOutputType =
  | 'answer-string'
  | 'canonical-entity-id'
  | 'cited-source-pages'
  | 'time-qualified-answer'
  | 'abstention'
  | 'contradiction-explanation'
  | 'poison-flag'
  | 'confidence-score';

/**
 * Gold shape varies by tier. Kept as an open-ended record; scorers
 * validate the tier-specific shape. Canonical gold for relational queries
 * lives under `relevant` (list of page slugs expected in top-K).
 */
export interface Gold {
  relevant?: string[];
  grades?: Record<string, number>;
  expected_answer?: string;
  expected_entity_id?: string;
  expected_citations?: string[];
  expected_abstention?: boolean;
  expected_as_of?: string;
  [key: string]: unknown;
}

export interface Query {
  id: string;                       // q-0001 … q-0350
  tier: Tier;
  text: string;                     // natural-language query
  expected_output_type: ExpectedOutputType;
  gold: Gold;
  /** Required for temporal queries — see eng pass 2 validator spec. */
  as_of_date?: string | 'corpus-end' | 'per-source';
  acceptable_variants?: string[];   // for LLM-judged outputs
  known_failure_modes?: string[];
  author?: string;                  // set for Tier 5.5 externally-authored
  tags?: string[];                  // 'identity-collision', 'contradiction', etc.
}

/**
 * PublicQuery — the shape adapters SEE at runtime (sealed-qrels, tightened
 * per audit finding shared-infra-04 + outside-voice round 2).
 *
 * The minimal operational surface: an adapter needs the query text, a stable
 * id, and (for temporal queries) the as-of date. EVERYTHING else on Query
 * leaks classification signal to the system under test:
 *   - gold / acceptable_variants / known_failure_modes — the answer itself
 *   - tier — announces "this is an adversarial/fuzzy trap"
 *   - tags — 'identity-collision', 'contradiction', poison markers
 *   - expected_output_type — reveals abstention/contradiction expectations
 *   - author — separates externally-authored probes
 * None of those are needed to rank documents. Scorers keep the full Query.
 */
export interface PublicQuery {
  id: string;
  text: string;
  as_of_date?: string | 'corpus-end' | 'per-source';
}

export function sanitizeQuery(q: Query): PublicQuery {
  // Build a new object with explicit enumeration — never spread + delete —
  // so no hidden field or shared reference survives the boundary.
  const out: PublicQuery = {
    id: q.id,
    text: q.text,
  };
  if (q.as_of_date !== undefined) out.as_of_date = q.as_of_date;
  return out;
}

// ─── RankedDoc ──────────────────────────────────────────────────────

/**
 * Adapter output per query: a ranked list of pages the adapter believes
 * are relevant. Score semantics are adapter-specific; only RANK matters
 * for top-K metrics. Scorers never compare scores across adapters.
 */
export interface RankedDoc {
  page_id: string;   // page slug
  score: number;     // adapter-internal relevance score (not comparable across adapters)
  rank: number;      // 1-based rank within this query's result list
  /** Optional snippet of supporting text. Useful for citation scoring. */
  snippet?: string;
}

// ─── PoisonDisposition ──────────────────────────────────────────────

/**
 * Per eng pass 2 spec. Each poison item in the corpus is tagged with an
 * `expected_behavior` in gold; the adapter reports which behavior it
 * chose via getPoisonDisposition(). Scorer matches adapter disposition
 * against expected to compute poison_resistance.
 */
export type PoisonDisposition =
  | 'exclude'        // never ingested; page not in index
  | 'quarantine'     // ingested but tagged; not returned in normal queries
  | 'warn'           // retrievable with a warning flag on results
  | 'ignore'         // indexed but not used for factual answers
  | 'mark-untrusted';// provenance metadata flags source as untrusted

// ─── AdapterConfig ──────────────────────────────────────────────────

/**
 * Per-adapter configuration knobs. Adapter implementations extend this
 * with their own fields (e.g. GbrainAdapter takes `config: 'A' | ... | 'F'`).
 */
export interface AdapterConfig {
  /** Human-readable adapter name (shown in scorecards). */
  name: string;
  /** Top-K truncation the scorer uses (adapter is free to return more). */
  k?: number;
  /** Adapter-specific options. */
  [key: string]: unknown;
}

// ─── BrainState ─────────────────────────────────────────────────────

/**
 * OPAQUE to the runner. Each adapter internally defines its own shape:
 *   RipgrepBm25Adapter BrainState = an in-memory inverted index + doc-length table
 *   GbrainAdapter BrainState      = a PGLite engine handle + .db file path
 *   VectorOnlyAdapter BrainState  = embedding index + cached vectors
 *
 * The runner only uses it as an adapter-internal state handle. Never
 * inspected, serialized, or cross-type-checked. This is the structural
 * boundary that prevents a runner bug from leaking implementation details
 * across adapters.
 */
export type BrainState = unknown;

// ─── Adapter interface ──────────────────────────────────────────────

export interface Adapter {
  /** The registered adapter name, e.g. "gbrain-a" | "grep-only". */
  readonly name: string;

  /**
   * Ingest the raw pages and build internal state. Called ONCE per
   * benchmark run. Adapters that need warming (embeddings, indexes) do
   * that work here.
   */
  init(rawPages: Page[], config: AdapterConfig): Promise<BrainState>;

  /**
   * Answer a single query. Adapters return their top results in rank
   * order. The scorer applies the query's `k` cutoff; adapters are free
   * to return fewer than k (with a shorter list) — precision@k still
   * divides by k, so short lists are not rewarded.
   *
   * Takes PublicQuery, not Query: the compiler enforces the sealed-qrels
   * boundary — an adapter cannot even name `q.gold` or `q.tier`.
   */
  query(q: PublicQuery, state: BrainState): Promise<RankedDoc[]>;

  /**
   * Persist the brain state to a filesystem path (for reproducibility +
   * cross-task state sharing). Returns the path. Optional — adapters
   * that don't support snapshotting can return an empty string.
   */
  snapshot?(state: BrainState): Promise<string>;

  /**
   * Per-page poison disposition: what did the adapter do with each
   * poison item? Scorer compares to gold's `expected_behavior`.
   * Adapters that don't have a poison path return an empty map.
   */
  getPoisonDisposition?(state: BrainState): Record<string, PoisonDisposition>;

  /**
   * Release any resources held by `state` (DB connections, file locks,
   * worker threads). Called once per run after scoring completes.
   * Adapters that hold no resources can omit this. Without it, PGLite-backed
   * adapters leak engine workers and Bun exits 99 at the end of the run.
   */
  teardown?(state: BrainState): Promise<void>;
}

// ─── Scorer helpers ─────────────────────────────────────────────────
//
// The metric implementations live in eval/runner/metrics.ts (one denominator
// policy, one place to test). These RankedDoc[] wrappers exist for
// back-compat with existing scorer call sites; they normalize to id lists
// and delegate. Audit findings shared-infra-02/03: the previous inline
// implementations double-counted duplicate page_ids (recall could exceed
// 1.0 on chunk-grained results) and divided precision by the returned-list
// length instead of k (rewarding adapters that return fewer docs).

import * as metrics from './metrics.ts';

/** Standard top-K slice; helper since every scorer needs it. */
export function topK(docs: RankedDoc[], k: number): RankedDoc[] {
  return docs.slice(0, k);
}

/** Precision@k with the standard /k denominator, counting each relevant id once. */
export function precisionAtK(docs: RankedDoc[], relevant: Set<string>, k: number): number {
  return metrics.precisionAtK(docs.map(d => d.page_id), relevant, k);
}

/**
 * Recall@k counting each relevant id at most once (never exceeds 1.0).
 * Returns NaN for an empty relevant set — callers exclude such queries from
 * means instead of averaging in a fake 0.
 */
export function recallAtK(docs: RankedDoc[], relevant: Set<string>, k: number): number {
  return metrics.recallAtK(docs.map(d => d.page_id), relevant, k);
}
