/**
 * Which synthetic contrast each predictive measure (G1 to G6) is checked
 * against, and in which real reference. The lists are copied from the
 * preregistration's "Mapped contrasts and expected verdicts" section
 * (docs/benchmarks/2026-11-09-predictive-measures-preregistration.md); change
 * them only through a dated amendment there.
 *
 * A measure has one or more layers, each checked against one reference file in
 * eval/data/validity-references/ and read on its own by validity.ts's verdict().
 * Synthetic and reference contrast ids are the same wherever the synthetic run
 * scores the same comparison (G2 against live recall). For references still
 * pending, the ids below are the names the export must use when it lands; the
 * verdict reads NO_REFERENCE_YET for them until then.
 */

export const MEASURES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'] as const;
export type Measure = (typeof MEASURES)[number];

export interface MappedPair { synthetic: string; reference: string }

export interface Layer {
  id: string;
  /** A manifest id in eval/data/validity-references/manifest.json. */
  reference: string;
  pairs: MappedPair[];
  /** Reference orderings to report Kendall's tau over, never gating. */
  ordering_keys?: string[];
  /**
   * The live-recall protocol whose scorecard carries this layer. A live-recall
   * scorecard of another protocol does not carry it even where contrast ids
   * coincide: batch 3 repeats batch 2's secondaries over its own questions.
   */
  protocol?: 'batch2' | 'batch3';
  /** The one non-control scorecard this layer's counted verdict reads (preregistration, corrections of 2026-11-10). */
  counted?: CountedScorecard;
  note: string;
}

/** A synthetic live-recall scorecard's identity: the gbrain commit it loaded, its knobs and its question file. */
export interface CountedScorecard {
  gbrain_commit: string;
  knobs: { unembedded_chunk_share: number; synopsis_vectors_off: boolean; keyword_candidate_bound: number | null; shell_page_share: number };
  questions_sha256: string;
}

/** G2's batch 2 layer: the real condition (synopsis vectors off, 10% unembedded, half the pages that aren't gold as shells) at 0.60.593.0, batch 2's own gbrain. */
export const COUNTED_B2: CountedScorecard = {
  gbrain_commit: '27f8b9d6287c2ba635532c7d3bc015c50e1d769b',
  knobs: { unembedded_chunk_share: 0.1, synopsis_vectors_off: true, keyword_candidate_bound: null, shell_page_share: 0.5 },
  questions_sha256: '077569d730f9cff639cb21040e14635c034db19f19fd44b9e2c7460a7a5d2e89',
};
/** The batch 3 layers: the synthetic batch-3 brain (seed 20261110, 30 per type, Opus paraphrases) at 0.60.641.0, the version batch 3's counted run loads under the 2026-11-10 amendment (its freeze records 0.60.623.0). */
export const COUNTED_B3: CountedScorecard = {
  gbrain_commit: '2560ffddb85244b82f2b325ee2ddc846f77c3cac',
  knobs: { unembedded_chunk_share: 0, synopsis_vectors_off: false, keyword_candidate_bound: null, shell_page_share: 0 },
  questions_sha256: '3664863bc9916952ac987a225d4393013fed94c48e8de27a4dd78b0c9cd6f1f7',
};

const same = (...ids: string[]): MappedPair[] => ids.map(id => ({ synthetic: id, reference: id }));

/** Every success@5 contrast live recall batch 2 reports, in its scorecard's order (13 of 16 qualify). */
export const B2_CONTRASTS = [
  'p1_hybrid_vs_hybrid_lexical_paraphrase', 'p2_configured_vs_hybrid_lexical_paraphrase', 'batch1_p1_hybrid_vs_hybrid_lexical',
  'hybrid_lexical_vs_keyword', 'hybrid_vs_keyword', 'configured_vs_keyword_paraphrase', 'configured_vs_hybrid', 'vector_vs_keyword',
  'configured_vs_keyword_exact', 'hybrid_vs_keyword_paraphrase', 'window_vs_configured',
  'paraphrase_vs_exact_keyword', 'paraphrase_vs_exact_vector', 'paraphrase_vs_exact_hybrid_lexical', 'paraphrase_vs_exact_hybrid', 'paraphrase_vs_exact_configured',
] as const;
export const B3_FRESHNESS = ['p1_configured_vs_hybrid_lexical_freshness', 'hybrid_vs_hybrid_lexical_freshness', 'configured_vs_keyword_freshness'] as const;
export const B3_ENTITY = ['p2_configured_vs_hybrid_lexical_entity', 'hybrid_vs_hybrid_lexical_entity', 'configured_vs_keyword_entity'] as const;
/** Phase 2's arm B vs arm A contrast per model, and the model pair under arm B. */
export const PHASE2_AGENT = ['p1_b_vs_a_opus', 'p1_b_vs_a_particle', 'arm_b_opus_vs_particle'] as const;
/**
 * G3's contract causes (eval/generators/write-contract-gen.ts G3_CAUSES) compared with phase 2 arm B as refusal rates
 * given exposure. two_range_read is left out (preregistration amendment of 2026-11-09): arm B runs gbrain 0.60.570.0 or
 * later, which reads a two-selector get_page instead of refusing it (gbrain#8509), so its rate is zero by construction.
 */
export const G3_PHASE2_CAUSES = ['source_changed', 'missing_provenance', 'ambiguous_entity', 'fact_and_items', 'scope_denied', 'commit_paths_invalid', 'sources_without_brain'] as const;

export const MAPPING: Record<Measure, { title: string; layers: Layer[] }> = {
  G1: {
    title: 'freshness across pages',
    layers: [
      { id: 'retrieval', reference: 'live-recall-b3', pairs: same(...B3_FRESHNESS), protocol: 'batch3', counted: COUNTED_B3, note: 'batch 3 freshness success@5; the stale-first rate is a direction check beside it and never gates' },
      { id: 'agent', reference: 'phase2-agent', pairs: same(...PHASE2_AGENT), note: 'arm B vs arm A, and model pairs, once phase 2 is counted' },
    ],
  },
  G2: {
    title: 'recall under real conditions',
    layers: [
      { id: 'b2', reference: 'live-recall-b2', pairs: same(...B2_CONTRASTS), ordering_keys: ['arms_exact', 'arms_paraphrase'], protocol: 'batch2', counted: COUNTED_B2, note: 'all 16 success@5 contrasts of live recall batch 2, id to id' },
      { id: 'b3', reference: 'live-recall-b3', pairs: same(...B3_FRESHNESS, ...B3_ENTITY), protocol: 'batch3', counted: COUNTED_B3, note: 'batch 3 freshness and entity success@5, once batch 3 lands' },
    ],
  },
  G3: {
    title: 'write landing and call contract',
    layers: [
      { id: 'replay', reference: 'replay-pins', pairs: same('read_refusal_rate_570_vs_549'), note: 'the replay version pair: 607 of 607 Sol page reads refused at 0.60.549.0, 435 of 436 two- or three-selector calls read at 0.60.570.0' },
      { id: 'phase2', reference: 'phase2-agent', pairs: G3_PHASE2_CAUSES.map(c => ({ synthetic: 'refusal_rate_' + c, reference: 'arm_b_refusal_rate_' + c })), note: 'phase 2 arm B refusal rates by cause given exposure; two_range_read is reported outside the test, because arm B\'s gbrain reads two-selector calls; matching the cause mix is not a criterion' },
    ],
  },
  G4: {
    title: 'wrong entity',
    layers: [
      { id: 'retrieval', reference: 'live-recall-b3', pairs: same(...B3_ENTITY), protocol: 'batch3', counted: COUNTED_B3, note: 'batch 3 entity success@5' },
      { id: 'agent', reference: 'phase2-agent', pairs: same(...PHASE2_AGENT), note: 'arm B vs arm A, and model pairs, once phase 2 is counted' },
    ],
  },
  G5: {
    title: 'latency at brain scale',
    layers: [
      { id: 'pins', reference: 'latency-pins', pairs: same('p95_query_570_vs_549', 'p95_search_570_vs_549', 'p95_get_570_vs_549'), note: 'p95 latency at pin 549 vs 570 for query, search and get; the match to Wintermute\'s counted p50 and p95 is calibration only' },
    ],
  },
  G6: {
    title: 'gold out of view, by cause',
    layers: [
      { id: 'freeze', reference: 'phase2-freeze-out-of-view', pairs: same('out_of_view_direct_flag', 'out_of_view_alias_inheritance', 'out_of_view_derived_default'), note: 'the phase-2 freeze\'s out-of-view counts by privacy sub-cause, if published as aggregates' },
    ],
  },
};

export function isMeasure(value: unknown): value is Measure {
  return typeof value === 'string' && (MEASURES as readonly string[]).includes(value);
}
