/**
 * Cat 13 — Phase E1 gap localization: WHICH hybrid stage moves the gold page
 * below where gbrain's own vector arm ranked it?
 *
 * The finding this answers (ranker wave, Phase E1): on the voyage-4 Cat 13
 * corpus, gbrain hybrid (balanced, reranker off, autocut off, boost gate `always`) trails bare
 * vector by ~7.5 nDCG@5 on the held-out concepts (E0-V1: 53.0 vs 60.5), yet
 * the E2 calibration shows 83% of non-gold-top tuning probes have an EMPTY
 * strict keyword arm. So for most probes hybrid fuses the vector list plus
 * (maybe) the title arm, then runs the cosine blend, the post-fusion boosts,
 * dedup, the slice and the token budget — and STILL reorders vector's
 * ranking. This script localizes the damage per probe, on the TUNING split
 * only (held-out concepts are never queried).
 *
 * What one run does (one PGLite brain, the E0-V1 pins plus
 * `search.metadata_boost_gate=always`, see step 2d):
 *   1. Same corpus, probe generator, seed and concept split as the runner.
 *      Tuning-subset probes only.
 *   2. Per probe, ONE query embedding (query-side, `embedQuery`) is shared by
 *      every arm via hybridSearch's `queryEmbedFn` seam, so "same embedding"
 *      is a fact, not an assumption:
 *        (a) gbrain's own vector arm: `engine.searchVector` with hybrid's exact
 *            SearchOpts (innerLimit, detail, embedding column) — already best-
 *            chunk-per-page, collapsed to a page ranking the way the gbrain
 *            adapter scores (best chunk score per slug);
 *        (b) live `hybridSearch(..., {limit: TOP_K*6})` → page ranking + the
 *            per-result stamps (base_score, cosine, every boost multiplier,
 *            keyword_hit / keyword_relaxed / alias_hit / exact_lookup /
 *            relational_*) + HybridSearchMeta (degraded, relaxed_dropped,
 *            keyword_arm_confidence, token_budget, detail_resolved, intent);
 *        (c) the strict keyword arm and the title arm (`engine.searchKeyword`,
 *            `engine.searchTitles`, same options hybrid passes) — strict vs
 *            AND→OR relaxed rows split by the `keyword_relaxed` stamp;
 *        (d) an OFFLINE RE-SIMULATION of hybrid's main path from (a)+(c)
 *            using the very same functions hybrid.ts calls
 *            (rrfFusionWeighted → cosineReScore → runPostFusionStages →
 *            exact-match boost → dedupResults → alias hop → exact-lookup tier
 *            → slice → enforceTokenBudget), validated against (b) on every
 *            probe (the live call pins `search.metadata_boost_gate=always`
 *            so both sides run the ungated pipeline this runner models),
 *            then re-run with ONE stage neutralized at a time (title
 *            arm, keyword arm, both, cosine blend, post-fusion boosts,
 *            compiled-truth 2x, dedup). A neutralization that restores the
 *            gold rank to <= its vector-arm rank "fixes" the probe.
 *   3. Optionally (default on) the E0 `vector` comparator is replicated on
 *      the same pages: one document-side vector per page (VectorOnlyAdapter
 *      init) scored with BOTH the document-side query embed the E0 adapter
 *      actually uses (`embed`) and the query-side embed gbrain uses
 *      (`embedQuery`). This separates "gbrain's vector substrate is weaker
 *      than the bare page-vector comparator" from "fusion damages the vector
 *      arm's order" — without it the localization could chase the wrong gap.
 *
 * Classification of every GAP probe (vector arm has gold in its top-5, hybrid
 * ranks it lower or drops it from the returned list), by the single stage
 * whose neutralization restores the gold rank (ties broken by a fixed
 * priority; stamps recorded alongside as evidence):
 *   1 title_arm_injection        2 post_fusion_boost_reorder (compiled-truth 2x
 *   as a sub-detail)             3 cosine_blend_reorder
 *   4 dedup_collapse             5 relaxed_keyword_fused (should be 0)
 *   6 other — named: keyword_arm_injection, lexical_arms_combined,
 *     vector_arm_mismatch, unexplained.
 *
 * Output: eval/reports/cat13-gap/localize.{json,md}. Run through the spend
 * guard for live embeds (cents: one ingest + ~2 tiny embeds per probe).
 *
 *   CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024 \
 *     bun eval/runner/cat13-gap-localize.ts
 *   CAT13_PROBES=60 bun eval/runner/cat13-gap-localize.ts --stub-embed --max-probes 8
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import { embed, embedQuery } from 'gbrain/embedding';
import { MAX_SEARCH_LIMIT } from 'gbrain/engine';
import {
  hybridSearch,
  PRE_FUSION_POOL_FLOOR,
  RRF_K,
  rrfFusionWeighted,
  cosineReScore,
  cosineSimilarity,
  shouldBoostCompiledTruth,
  runPostFusionStages,
  applyAliasHop,
  stampUnverifiedExtractions,
  type PostFusionOpts,
} from 'gbrain/search/hybrid';
import type { HybridSearchMeta, SearchResult, SearchOpts } from 'gbrain/types';
// Pure / engine-local helpers hybrid.ts imports itself but the package export
// map does not surface. Reached through the linked checkout's source tree; Bun
// resolves the symlink to the real path, so these are the SAME module
// instances the live hybridSearch uses (checked at write time).
import { dedupResults } from '../../node_modules/gbrain/src/core/search/dedup.ts';
import {
  weightsForIntent,
  effectiveRrfK,
  applyExactMatchBoost,
  type IntentWeights,
} from '../../node_modules/gbrain/src/core/search/intent-weights.ts';
import { classifyQueryWithBrainPatterns } from '../../node_modules/gbrain/src/core/search/query-intent.ts';
import { enforceTokenBudget } from '../../node_modules/gbrain/src/core/search/token-budget.ts';
import { applyExactLookupTier } from '../../node_modules/gbrain/src/core/search/exact-lookup.ts';
import { loadSearchModeConfig, resolveSearchMode } from '../../node_modules/gbrain/src/core/search/mode.ts';
import { GbrainInlineAdapter, gcNow } from './adapters/gbrain-inline.ts';
import { VectorOnlyAdapter } from './adapters/vector.ts';
import {
  TOP_K, PROBE_SEED, DEFAULT_TUNING_CONCEPTS, DEFAULT_HOLDOUT_CONCEPTS, CAT13_SEARCH_MODE,
  loadCorpus, buildProbes, splitConcepts, probeSubset,
  resolveEmbedder, ensureGateway, providerKeyEnv, pinnedSearchConfig, resolveTargetProbes,
  type Probe, type ConceptSplit, type EmbedderConfig,
} from './cat13-conceptual.ts';
import { sanitizePage } from './types.ts';
import { ndcgAtK } from './metrics.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

export const GAP_REPORT_DIR = 'cat13-gap';
/** Per-call limit — identical to GbrainInlineAdapter.query (TOP_K * 6). */
export const HYBRID_LIMIT = TOP_K * 6;
/** How many hybrid / vector pages a record keeps for the write-up. */
export const RECORD_TOP_N = 10;
/** Default E0-V1 receipt (the paired "before" numbers for the ladder). */
export const DEFAULT_E0_RECEIPT = join(homedir(), 'gbrain-lme-receipts', 'cat13', 'E0-V1', 'receipt.json');

// ─── Pure helpers ─────────────────────────────────────────────────

/** Chunk rows → page ranking: best chunk score per slug (the gbrain adapter's normalization). */
export function collapsePages(rows: readonly SearchResult[]): Array<{ slug: string; score: number }> {
  const best = new Map<string, number>();
  for (const r of rows) {
    const prev = best.get(r.slug);
    if (prev === undefined || r.score > prev) best.set(r.slug, r.score);
  }
  return [...best.entries()]
    .map(([slug, score]) => ({ slug, score }))
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

/** 1-based rank of the best-ranked grade-3 target; null when none is in the list. */
export function goldRank(pageOrder: readonly string[], targets: readonly string[]): number | null {
  let best: number | null = null;
  for (const t of targets) {
    const i = pageOrder.indexOf(t);
    if (i >= 0 && (best === null || i + 1 < best)) best = i + 1;
  }
  return best;
}

/** Attribution stamps hybridSearch's stages leave on a result (multipliers != 1 mean the stage fired). */
export const BOOST_STAMP_KEYS = [
  'backlink_boost', 'salience_boost', 'recency_boost', 'chronicle_boost', 'title_match_boost',
  'exact_match_boost', 'graph_adjacency_boost', 'graph_cross_source_boost', 'session_demote_factor',
  'alias_resolved_boost', 'supersede_penalty',
] as const;
export type BoostStampKey = (typeof BOOST_STAMP_KEYS)[number];

export type ArmName = 'vector' | 'keyword' | 'title';

export interface PageStamp {
  slug: string;
  rank: number;
  score: number;
  base_score: number | null;
  cosine: number | null;
  chunk_source: string;
  /** Which recall arms returned this page (membership in the re-fetched arm lists). */
  arms: ArmName[];
  /** Boost multipliers that fired on the page's best chunk (value != 1). */
  boosts: Partial<Record<BoostStampKey, number>>;
  keyword_hit: boolean;
  keyword_relaxed: boolean;
  alias_hit: boolean;
  exact_lookup: string | null;
  relational: boolean;
  evidence: string | null;
}

export function boostsOf(r: SearchResult): Partial<Record<BoostStampKey, number>> {
  const out: Partial<Record<BoostStampKey, number>> = {};
  for (const k of BOOST_STAMP_KEYS) {
    const v = (r as unknown as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v) && v !== 1) out[k] = v;
  }
  return out;
}

/** The best chunk per page (by post-boost score) with its stamps and arm membership. */
export function stampPages(
  rows: readonly SearchResult[],
  arms: { vector: ReadonlySet<string>; keyword: ReadonlySet<string>; title: ReadonlySet<string> },
  topN: number = Number.POSITIVE_INFINITY,
): PageStamp[] {
  const bestRow = new Map<string, SearchResult>();
  for (const r of rows) {
    const prev = bestRow.get(r.slug);
    if (!prev || r.score > prev.score) bestRow.set(r.slug, r);
  }
  const order = collapsePages(rows);
  return order.slice(0, topN).map(({ slug }, i) => {
    const r = bestRow.get(slug)!;
    const armList: ArmName[] = [];
    if (arms.vector.has(slug)) armList.push('vector');
    if (arms.keyword.has(slug)) armList.push('keyword');
    if (arms.title.has(slug)) armList.push('title');
    return {
      slug,
      rank: i + 1,
      score: r.score,
      base_score: typeof r.base_score === 'number' ? r.base_score : null,
      cosine: typeof r.cosine === 'number' ? r.cosine : null,
      chunk_source: r.chunk_source,
      arms: armList,
      boosts: boostsOf(r),
      keyword_hit: r.keyword_hit === true,
      keyword_relaxed: r.keyword_relaxed === true,
      alias_hit: r.alias_hit === true,
      exact_lookup: r.exact_lookup ?? null,
      relational: Array.isArray(r.relational_via_link_types) && r.relational_via_link_types.length > 0,
      evidence: r.evidence ?? null,
    };
  });
}

// ─── Ablations ────────────────────────────────────────────────────

export const ABLATIONS = [
  'full',
  'no_title_arm',
  'no_keyword_arm',
  'no_lexical_arms',
  'no_cosine_blend',
  'no_post_fusion_boosts',
  'no_compiled_truth_boost',
  'no_backlink_boost',
  'no_graph_signals',
  'no_recency_boost',
  'no_salience_boost',
  'no_title_phrase_boost',
  'no_exact_match_boost',
  'no_dedup',
  'no_lexical_no_boosts',
  'vector_only',
] as const;
export type AblationName = (typeof ABLATIONS)[number];

/** Which stages run in a simulated pass. `full` mirrors the live pipeline. */
export interface StageFlags {
  titleArm: boolean;
  keywordArm: boolean;
  cosineBlend: boolean;
  /** The whole runPostFusionStages + exact-match block. */
  postFusionBoosts: boolean;
  compiledTruthBoost: boolean;
  dedup: boolean;
  /** Fine-grained post-fusion stages (consulted only while postFusionBoosts is true). */
  backlinkBoost: boolean;
  graphSignals: boolean;
  recencyBoost: boolean;
  salienceBoost: boolean;
  titlePhraseBoost: boolean;
  exactMatchBoost: boolean;
}

export function stageFlags(name: AblationName): StageFlags {
  const full: StageFlags = {
    titleArm: true, keywordArm: true, cosineBlend: true, postFusionBoosts: true, compiledTruthBoost: true, dedup: true,
    backlinkBoost: true, graphSignals: true, recencyBoost: true, salienceBoost: true, titlePhraseBoost: true, exactMatchBoost: true,
  };
  switch (name) {
    case 'full': return full;
    case 'no_title_arm': return { ...full, titleArm: false };
    case 'no_keyword_arm': return { ...full, keywordArm: false };
    case 'no_lexical_arms': return { ...full, titleArm: false, keywordArm: false };
    case 'no_cosine_blend': return { ...full, cosineBlend: false };
    case 'no_post_fusion_boosts': return { ...full, postFusionBoosts: false };
    case 'no_compiled_truth_boost': return { ...full, compiledTruthBoost: false };
    case 'no_backlink_boost': return { ...full, backlinkBoost: false };
    case 'no_graph_signals': return { ...full, graphSignals: false };
    case 'no_recency_boost': return { ...full, recencyBoost: false };
    case 'no_salience_boost': return { ...full, salienceBoost: false };
    case 'no_title_phrase_boost': return { ...full, titlePhraseBoost: false };
    case 'no_exact_match_boost': return { ...full, exactMatchBoost: false };
    case 'no_dedup': return { ...full, dedup: false };
    case 'no_lexical_no_boosts': return { ...full, titleArm: false, keywordArm: false, postFusionBoosts: false };
    case 'vector_only': return { ...full, titleArm: false, keywordArm: false, cosineBlend: false, postFusionBoosts: false, compiledTruthBoost: false };
  }
}

/** The fine-grained post-fusion ablations (each is a subset of no_post_fusion_boosts). */
export const FINE_BOOST_ABLATIONS: readonly AblationName[] = [
  'no_backlink_boost', 'no_graph_signals', 'no_recency_boost', 'no_salience_boost', 'no_title_phrase_boost', 'no_exact_match_boost',
];

/** The single-stage ablations that name a gap class when they fix a probe, in tie-break priority order. */
export const SINGLE_STAGE_ABLATIONS: readonly AblationName[] = [
  'no_title_arm', 'no_keyword_arm', 'no_post_fusion_boosts', 'no_compiled_truth_boost', 'no_cosine_blend', 'no_dedup',
];

export type GapClass =
  | 'title_arm_injection'          // 1
  | 'post_fusion_boost_reorder'    // 2 (compiled_truth 2x recorded as class_detail)
  | 'cosine_blend_reorder'         // 3
  | 'dedup_collapse'               // 4
  | 'relaxed_keyword_fused'        // 5
  | 'keyword_arm_injection'        // 6 (named)
  | 'lexical_arms_combined'        // 6 (named): title + keyword only jointly
  | 'vector_arm_mismatch'          // 6 (named): the re-simulated pure-vector pass disagrees with the live arm
  | 'unexplained';                 // 6

export const GAP_CLASS_NUMBER: Record<GapClass, string> = {
  title_arm_injection: '1',
  post_fusion_boost_reorder: '2',
  cosine_blend_reorder: '3',
  dedup_collapse: '4',
  relaxed_keyword_fused: '5',
  keyword_arm_injection: '6 (named)',
  lexical_arms_combined: '6 (named)',
  vector_arm_mismatch: '6 (named)',
  unexplained: '6',
};

const CLASS_FOR_ABLATION: Partial<Record<AblationName, GapClass>> = {
  no_title_arm: 'title_arm_injection',
  no_keyword_arm: 'keyword_arm_injection',
  no_post_fusion_boosts: 'post_fusion_boost_reorder',
  no_compiled_truth_boost: 'post_fusion_boost_reorder',
  no_cosine_blend: 'cosine_blend_reorder',
  no_dedup: 'dedup_collapse',
  no_lexical_arms: 'lexical_arms_combined',
};

// ─── Per-probe record ─────────────────────────────────────────────

export interface AblationOutcome {
  gold_rank: number | null;
  ndcg5: number;
}

export interface Intruder {
  slug: string;
  hybrid_rank: number;
  /** Rank in gbrain's vector arm (null = not in the arm's top innerLimit pages). */
  vector_rank: number | null;
  arms: ArmName[];
  boosts: Partial<Record<BoostStampKey, number>>;
  keyword_relaxed: boolean;
  exact_lookup: string | null;
  relational: boolean;
}

export interface ProbeGapRecord {
  probe_id: string;
  template: string;
  text: string;
  targets: string[];
  intent: string | null;
  detail_resolved: string | null;
  vector_enabled: boolean;
  /** Live gold ranks + nDCG@5 (TOP_K) for each ranking. */
  live: {
    vector_gold_rank: number | null;
    vector_ndcg5: number;
    hybrid_gold_rank: number | null;
    hybrid_ndcg5: number;
    /** E0 `vector` comparator replica (document-side query embed); null when not run. */
    page_vector_docside_gold_rank: number | null;
    page_vector_docside_ndcg5: number | null;
    /** Same page vectors, query-side query embed (gbrain's side). */
    page_vector_queryside_gold_rank: number | null;
    page_vector_queryside_ndcg5: number | null;
  };
  arms: {
    vector_rows: number;
    keyword_strict_rows: number;
    keyword_relaxed_rows: number;
    title_strict_rows: number;
    title_relaxed_rows: number;
    keyword_gold_rank: number | null;
    title_gold_rank: number | null;
    keyword_top_slug: string | null;
    title_top_slug: string | null;
  };
  meta: {
    degraded: string[];
    relaxed_dropped: number;
    token_budget_dropped: number;
    keyword_arm_margin: number | null;
    embedding_column: string | null;
    /** hybrid's metadata-boost-gate stamp for the live call (self-verifies the `always` pin: reason `gate_always`). */
    metadata_boost_gate?: { gate: string; lexical_voted: boolean; boosts_applied: boolean; reason: string } | null;
  };
  hybrid_top: PageStamp[];
  vector_top: string[];
  ablations: Record<AblationName, AblationOutcome>;
  /** Did the `full` re-simulation reproduce the live hybrid page order (top-5 / whole returned list)? */
  simulation: { top5_match: boolean; full_match: boolean; live_pages: number; sim_pages: number };
  gap: boolean;
  gain: boolean;
  intruders: Intruder[];
  gap_class: GapClass | null;
  class_detail: string | null;
  /** For unfixed gaps: the single-stage ablation that moved gold furthest up, if any. */
  best_partial: { ablation: AblationName; gold_rank: number } | null;
}

export interface ClassifyInput {
  vector_gold_rank: number | null;
  hybrid_gold_rank: number | null;
  ablations: Record<AblationName, Pick<AblationOutcome, 'gold_rank'>>;
  /** Any returned hybrid row carried keyword_relaxed (a relaxed row voted). */
  relaxed_rows_fused: boolean;
  detail_resolved: string | null;
  token_budget_dropped: number;
}

export function isGap(vectorRank: number | null, hybridRank: number | null, k: number = TOP_K): boolean {
  return vectorRank !== null && vectorRank <= k && (hybridRank === null || hybridRank > vectorRank);
}

export function isGain(vectorRank: number | null, hybridRank: number | null, k: number = TOP_K): boolean {
  return hybridRank !== null && hybridRank <= k && (vectorRank === null || hybridRank < vectorRank);
}

/**
 * The pure classifier. A stage "fixes" a gap probe when neutralizing it alone
 * puts gold at or above its vector-arm rank. Among fixing single stages the
 * one that lifts gold furthest wins; ties fall to SINGLE_STAGE_ABLATIONS order.
 */
export function classifyGap(input: ClassifyInput): {
  gap_class: GapClass | null;
  class_detail: string | null;
  best_partial: { ablation: AblationName; gold_rank: number } | null;
} {
  const v = input.vector_gold_rank;
  const h = input.hybrid_gold_rank;
  if (!isGap(v, h)) return { gap_class: null, class_detail: null, best_partial: null };
  const target = v as number;
  if (input.relaxed_rows_fused) {
    return { gap_class: 'relaxed_keyword_fused', class_detail: 'a keyword_relaxed row was in the returned set', best_partial: null };
  }
  const fixes = (name: AblationName): boolean => {
    const g = input.ablations[name]?.gold_rank ?? null;
    return g !== null && g <= target;
  };
  let winner: AblationName | null = null;
  for (const name of SINGLE_STAGE_ABLATIONS) {
    if (!fixes(name)) continue;
    if (winner === null) { winner = name; continue; }
    const g = input.ablations[name].gold_rank as number;
    const w = input.ablations[winner].gold_rank as number;
    if (g < w) winner = name; // strictly better; ties keep the earlier (priority) stage
  }
  if (winner !== null) {
    const cls = CLASS_FOR_ABLATION[winner] as GapClass;
    const detail = winner === 'no_compiled_truth_boost'
      ? `compiled_truth 2x (detail_resolved=${input.detail_resolved ?? 'null'})`
      : winner === 'no_dedup' && input.token_budget_dropped > 0
        ? `dedup/slice/token budget (token_budget dropped ${input.token_budget_dropped})`
        : `neutralizing ${winner} puts gold at rank ${input.ablations[winner].gold_rank}`;
    return { gap_class: cls, class_detail: detail, best_partial: null };
  }
  if (fixes('no_lexical_arms')) {
    return {
      gap_class: 'lexical_arms_combined',
      class_detail: `only removing BOTH lexical arms restores gold (rank ${input.ablations.no_lexical_arms.gold_rank})`,
      best_partial: null,
    };
  }
  // Nothing single-stage fixes it. Did the pure-vector re-simulation even
  // agree with the live arm? If not, the disagreement is the story.
  const vo = input.ablations.vector_only?.gold_rank ?? null;
  let best: { ablation: AblationName; gold_rank: number } | null = null;
  for (const name of SINGLE_STAGE_ABLATIONS) {
    const g = input.ablations[name]?.gold_rank ?? null;
    if (g === null) continue;
    if (h === null || g < h) {
      if (best === null || g < best.gold_rank) best = { ablation: name, gold_rank: g };
    }
  }
  if (vo === null || vo > target) {
    return {
      gap_class: 'vector_arm_mismatch',
      class_detail: `vector_only re-simulation ranks gold at ${vo ?? 'absent'} vs live arm ${target}`,
      best_partial: best,
    };
  }
  return {
    gap_class: 'unexplained',
    class_detail: best
      ? `no single stage restores gold; best partial: ${best.ablation} → rank ${best.gold_rank} (live ${h ?? 'absent'})`
      : `no single stage moves gold above its live rank (${h ?? 'absent'})`,
    best_partial: best,
  };
}

/** Intruders: non-gold pages hybrid placed above gold that the vector arm did not rank above gold. */
export function findIntruders(
  hybridTop: readonly PageStamp[],
  vectorOrder: readonly string[],
  targets: readonly string[],
  hybridGoldRank: number | null,
  vectorGoldRank: number | null,
  k: number = TOP_K,
): Intruder[] {
  const cutoff = hybridGoldRank ?? k; // gold absent → everything in hybrid's top-k intrudes
  const out: Intruder[] = [];
  for (const p of hybridTop) {
    if (p.rank >= cutoff && hybridGoldRank !== null) break;
    if (p.rank > cutoff) break;
    if (targets.includes(p.slug)) continue;
    const vi = vectorOrder.indexOf(p.slug);
    const vRank = vi >= 0 ? vi + 1 : null;
    // The vector arm already had this page above gold → not hybrid's doing.
    if (vRank !== null && vectorGoldRank !== null && vRank < vectorGoldRank) continue;
    out.push({
      slug: p.slug,
      hybrid_rank: p.rank,
      vector_rank: vRank,
      arms: p.arms,
      boosts: p.boosts,
      keyword_relaxed: p.keyword_relaxed,
      exact_lookup: p.exact_lookup,
      relational: p.relational,
    });
  }
  return out;
}

// ─── Aggregates ───────────────────────────────────────────────────

export type DeltaBucket = 'improved' | 'same' | 'worse_in_top5' | 'pushed_out_of_top5' | 'vector_missed_top5' | 'both_outside_top5';

export function deltaBucket(vectorRank: number | null, hybridRank: number | null, k: number = TOP_K): DeltaBucket {
  const vIn = vectorRank !== null && vectorRank <= k;
  const hIn = hybridRank !== null && hybridRank <= k;
  if (vIn && !hIn) return 'pushed_out_of_top5';
  if (!vIn && hIn) return 'vector_missed_top5';
  if (!vIn && !hIn) return 'both_outside_top5';
  if ((hybridRank as number) < (vectorRank as number)) return 'improved';
  if ((hybridRank as number) > (vectorRank as number)) return 'worse_in_top5';
  return 'same';
}

export interface DeltaDistribution {
  probes: number;
  buckets: Record<DeltaBucket, number>;
  /** Histogram of (hybrid − vector) gold rank over probes where both ranks exist. */
  delta_hist: Record<string, number>;
  mean_delta_both_present: number | null;
  both_present: number;
  vector_ndcg5: number;
  hybrid_ndcg5: number;
}

const DELTA_BINS = ['<=-3', '-2', '-1', '0', '+1', '+2', '+3', '>=+4'] as const;
function deltaBin(d: number): string {
  if (d <= -3) return '<=-3';
  if (d >= 4) return '>=+4';
  return d > 0 ? `+${d}` : `${d}`;
}

export function deltaDistribution(records: readonly ProbeGapRecord[]): DeltaDistribution {
  const buckets: Record<DeltaBucket, number> = {
    improved: 0, same: 0, worse_in_top5: 0, pushed_out_of_top5: 0, vector_missed_top5: 0, both_outside_top5: 0,
  };
  const hist: Record<string, number> = Object.fromEntries(DELTA_BINS.map(b => [b, 0]));
  let sum = 0;
  let both = 0;
  let vN = 0;
  let hN = 0;
  for (const r of records) {
    buckets[deltaBucket(r.live.vector_gold_rank, r.live.hybrid_gold_rank)] += 1;
    if (r.live.vector_gold_rank !== null && r.live.hybrid_gold_rank !== null) {
      const d = r.live.hybrid_gold_rank - r.live.vector_gold_rank;
      hist[deltaBin(d)] += 1;
      sum += d;
      both += 1;
    }
    vN += r.live.vector_ndcg5;
    hN += r.live.hybrid_ndcg5;
  }
  const n = records.length;
  return {
    probes: n,
    buckets,
    delta_hist: hist,
    mean_delta_both_present: both > 0 ? sum / both : null,
    both_present: both,
    vector_ndcg5: n > 0 ? vN / n : 0,
    hybrid_ndcg5: n > 0 ? hN / n : 0,
  };
}

export interface ClassCounts {
  gap_probes: number;
  classes: Record<GapClass, number>;
}

export function countClasses(records: readonly ProbeGapRecord[]): ClassCounts {
  const classes = Object.fromEntries(
    (Object.keys(GAP_CLASS_NUMBER) as GapClass[]).map(c => [c, 0]),
  ) as Record<GapClass, number>;
  let gaps = 0;
  for (const r of records) {
    if (!r.gap || r.gap_class === null) continue;
    gaps += 1;
    classes[r.gap_class] += 1;
  }
  return { gap_probes: gaps, classes };
}

export interface IntruderRollup {
  slug: string;
  count: number;
  via_title_arm: number;
  via_keyword_arm: number;
  vector_only: number;
  boosted: number;
  boost_kinds: Record<string, number>;
  /** Probe templates this page intruded on. */
  templates: Record<string, number>;
}

export function topIntruders(records: readonly ProbeGapRecord[], n = 10): IntruderRollup[] {
  const by = new Map<string, IntruderRollup>();
  for (const r of records) {
    if (!r.gap) continue;
    for (const it of r.intruders) {
      let roll = by.get(it.slug);
      if (!roll) {
        roll = { slug: it.slug, count: 0, via_title_arm: 0, via_keyword_arm: 0, vector_only: 0, boosted: 0, boost_kinds: {}, templates: {} };
        by.set(it.slug, roll);
      }
      roll.count += 1;
      if (it.arms.includes('title')) roll.via_title_arm += 1;
      if (it.arms.includes('keyword')) roll.via_keyword_arm += 1;
      if (it.arms.length === 1 && it.arms[0] === 'vector') roll.vector_only += 1;
      const kinds = Object.keys(it.boosts);
      if (kinds.length > 0) roll.boosted += 1;
      for (const k of kinds) roll.boost_kinds[k] = (roll.boost_kinds[k] ?? 0) + 1;
      roll.templates[r.template] = (roll.templates[r.template] ?? 0) + 1;
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug)).slice(0, n);
}

export interface MechanismRow {
  ablation: AblationName;
  stage: string;
  proposal: string;
  /** Gap probes whose gold rank returns to <= its vector-arm rank under this ablation. */
  fixed: number;
  /** Gap probes whose gold moves up but not all the way. */
  improved_only: number;
  /** Gain probes (hybrid beat vector live) that lose the gain under this ablation. */
  collateral: number;
  net: number;
  tuning_ndcg5: number;
  ndcg5_delta_vs_live_hybrid: number;
}

export const MECHANISM_TEXT: Record<AblationName, { stage: string; proposal: string }> = {
  full: { stage: 'live pipeline (re-simulated)', proposal: '(reference)' },
  no_title_arm: {
    stage: 'title arm — page-grain FTS candidate generator (engine.searchTitles) fused at keywordK',
    proposal: 'title arm votes only when the vector arm also returned the page or the title-phrase matcher fires; otherwise keep it as exact-lookup input only (concept/paraphrase intent)',
  },
  no_keyword_arm: {
    stage: 'strict keyword arm (chunk-grain AND FTS) fused at keywordK',
    proposal: 'fuse the strict keyword arm at reduced weight when the vector arm voted and the keyword margin is weak (the kacf floor is the pre-registered knob)',
  },
  no_lexical_arms: {
    stage: 'both lexical arms together (keyword + title)',
    proposal: 'lexical arms as a tie-breaker only for concept intent: fuse both at half weight when a text vector arm voted',
  },
  no_cosine_blend: {
    stage: 'cosine re-score blend (0.7 · normalized RRF + 0.3 · raw query↔chunk cosine)',
    proposal: 'blend off (pure RRF order) for concept intent, or blend against the source-boosted vector score the arm ranked on instead of raw cosine',
  },
  no_post_fusion_boosts: {
    stage: 'post-fusion boosts (backlink / salience / recency / title-phrase 1.25x / graph signals / alias-resolved / exact-match)',
    proposal: 'skip the metadata boosts when the vector arm is the only voter (no strict lexical row in the pool) or for concept intent',
  },
  no_compiled_truth_boost: {
    stage: 'compiled-truth 2x after RRF normalization (detail=low only)',
    proposal: 'restrict the 2x authority boost to entity intent with a lexical hit',
  },
  no_backlink_boost: {
    stage: 'backlink boost alone (1 + 0.05·ln(1 + inbound links), applyBacklinkBoost)',
    proposal: 'do not apply the backlink boost when the page reached the pool through the vector arm only (no strict lexical row for it), or drop it for concept intent',
  },
  no_graph_signals: {
    stage: 'graph signals alone (adjacency-within-top-K 1.05x, cross-source 1.10x, session demote 0.95x)',
    proposal: 'graph_signals off for concept intent, or require a lexical hit before a top-K hub gets the adjacency bump',
  },
  no_recency_boost: {
    stage: 'recency boost alone (per-prefix half-life decay; fires on temporal intent)',
    proposal: 'recency tilt only when the query carries an explicit temporal bound, not on the intent classifier\'s guess',
  },
  no_salience_boost: {
    stage: 'salience boost alone (emotional_weight + take_count)',
    proposal: 'salience off unless the salience_on pattern bank fires',
  },
  no_title_phrase_boost: {
    stage: 'title-phrase boost alone (1.25x when the query is a token-run of the title)',
    proposal: 'keep — it is the named-thing correctness fix; only revisit if it shows up here',
  },
  no_exact_match_boost: {
    stage: 'intent exact-match boost alone (entity 1.25x / event 1.10x on slug or title equality)',
    proposal: 'keep — fires only on exact identity matches',
  },
  no_lexical_no_boosts: {
    stage: 'both lexical arms AND the post-fusion block together (vector arm + cosine blend + dedup only)',
    proposal: '(diagnostic: what remains once fusion inputs and boosts are both out of the picture)',
  },
  no_dedup: {
    stage: 'dedup / per-page collapse (type-diversity cap, compiled-truth swap) + slice + token budget',
    proposal: 'collapse to page grain before the type-diversity cap; never swap a page\'s only surviving chunk for a lower-scored compiled_truth chunk',
  },
  vector_only: { stage: 'vector arm alone (sanity: should equal the live arm order)', proposal: '(reference)' },
};

/** A gain probe loses its gain when gold no longer beats its vector-arm rank (or leaves the top-K when vector missed). */
export function lostGain(r: Pick<ProbeGapRecord, 'live'>, goldRank: number | null): boolean {
  const v = r.live.vector_gold_rank;
  return goldRank === null || (v !== null && goldRank >= v) || (v === null && goldRank > TOP_K);
}

/**
 * Ablations eligible to be named THE single mechanism: one stage each. The
 * post-fusion block and the two lexical combos are compounds (reported as
 * ceilings, never proposed); `full` / `vector_only` are references.
 */
export const PROPOSAL_CANDIDATES: readonly AblationName[] = [
  ...FINE_BOOST_ABLATIONS, 'no_title_arm', 'no_keyword_arm', 'no_cosine_blend', 'no_compiled_truth_boost', 'no_dedup',
];

export interface PolicyProjection {
  policy: string;
  description: string;
  /** Probes the gate would change (condition true). */
  applies_to_probes: number;
  fixed: number;
  improved_only: number;
  collateral: number;
  net: number;
  tuning_ndcg5: number;
  ndcg5_delta_vs_live_hybrid: number;
}

/**
 * Implementable gates projected EXACTLY from the recorded ablations: where the
 * gate's condition holds the probe takes the ablated outcome, elsewhere the
 * live one. No re-run, no new assumptions.
 */
export function policyProjections(records: readonly ProbeGapRecord[]): PolicyProjection[] {
  const n = records.length;
  const liveHybrid = n > 0 ? records.reduce((x, r) => x + r.live.hybrid_ndcg5, 0) / n : 0;
  const lexEmpty = (r: ProbeGapRecord) => r.arms.keyword_strict_rows === 0 && r.arms.title_strict_rows === 0;
  const nonEntity = (r: ProbeGapRecord) => r.intent !== 'entity';
  const defs: Array<{ policy: string; description: string; ablation: AblationName; cond: (r: ProbeGapRecord) => boolean }> = [
    { policy: 'skip_metadata_boosts_when_vector_only', description: 'run runPostFusionStages only when a strict lexical row (keyword or title arm) is in the fused pool; a vector-only pool keeps RRF + cosine order', ablation: 'no_post_fusion_boosts', cond: lexEmpty },
    { policy: 'skip_backlink_boost_when_vector_only', description: 'same gate, backlink stage only (other metadata boosts still run)', ablation: 'no_backlink_boost', cond: lexEmpty },
    { policy: 'skip_metadata_boosts_unless_entity_intent', description: 'run the metadata boosts only for entity intent (the "who is X" case they were tuned for)', ablation: 'no_post_fusion_boosts', cond: nonEntity },
    { policy: 'skip_backlink_boost_unless_entity_intent', description: 'same intent gate, backlink stage only', ablation: 'no_backlink_boost', cond: nonEntity },
    { policy: 'skip_metadata_boosts_always', description: 'ceiling: the whole block off for every query (== no_post_fusion_boosts)', ablation: 'no_post_fusion_boosts', cond: () => true },
  ];
  return defs.map(d => {
    let applies = 0; let fixed = 0; let improved = 0; let collateral = 0; let nd = 0;
    for (const r of records) {
      const use = d.cond(r);
      const gr = use ? r.ablations[d.ablation].gold_rank : r.live.hybrid_gold_rank;
      nd += use ? r.ablations[d.ablation].ndcg5 : r.live.hybrid_ndcg5;
      if (use) applies += 1;
      if (r.gap) {
        const v = r.live.vector_gold_rank as number;
        const h = r.live.hybrid_gold_rank;
        if (gr !== null && gr <= v) fixed += 1;
        else if (gr !== null && (h === null || gr < h)) improved += 1;
      } else if (r.gain && use && lostGain(r, gr)) {
        collateral += 1;
      }
    }
    return {
      policy: d.policy, description: d.description, applies_to_probes: applies, fixed, improved_only: improved, collateral,
      net: fixed - collateral, tuning_ndcg5: n > 0 ? nd / n : 0, ndcg5_delta_vs_live_hybrid: n > 0 ? nd / n - liveHybrid : 0,
    };
  }).sort((a, b) => b.net - a.net || b.tuning_ndcg5 - a.tuning_ndcg5);
}

export function rankMechanisms(records: readonly ProbeGapRecord[]): MechanismRow[] {
  const n = records.length;
  const liveHybrid = n > 0 ? records.reduce((s, r) => s + r.live.hybrid_ndcg5, 0) / n : 0;
  const rows: MechanismRow[] = [];
  for (const name of ABLATIONS) {
    if (name === 'full' || name === 'vector_only') continue;
    let fixed = 0;
    let improvedOnly = 0;
    let collateral = 0;
    let nd = 0;
    for (const r of records) {
      const a = r.ablations[name];
      nd += a.ndcg5;
      const v = r.live.vector_gold_rank;
      const h = r.live.hybrid_gold_rank;
      if (r.gap) {
        if (a.gold_rank !== null && a.gold_rank <= (v as number)) fixed += 1;
        else if (a.gold_rank !== null && (h === null || a.gold_rank < h)) improvedOnly += 1;
      } else if (r.gain && lostGain(r, a.gold_rank)) {
        collateral += 1;
      }
    }
    const t = MECHANISM_TEXT[name];
    rows.push({
      ablation: name,
      stage: t.stage,
      proposal: t.proposal,
      fixed,
      improved_only: improvedOnly,
      collateral,
      net: fixed - collateral,
      tuning_ndcg5: n > 0 ? nd / n : 0,
      ndcg5_delta_vs_live_hybrid: n > 0 ? nd / n - liveHybrid : 0,
    });
  }
  return rows.sort((a, b) => b.fixed - a.fixed || b.net - a.net || b.tuning_ndcg5 - a.tuning_ndcg5);
}

// ─── Engine-bound measurement ─────────────────────────────────────

/** Resolved once per run: the balanced-bundle knobs the live search used, as hybrid.ts resolves them. */
export interface RunKnobs {
  limit: number;
  innerLimit: number;
  intentWeighting: boolean;
  keywordOrFallback: boolean;
  tokenBudget: number | undefined;
  titleBoost: number | undefined;
  graphSignals: boolean;
  floorRatio: number | undefined;
  mode: string;
}

export async function resolveRunKnobs(engine: PGLiteEngine, limit: number = HYBRID_LIMIT): Promise<RunKnobs> {
  const modeInput = await loadSearchModeConfig(engine);
  const m = resolveSearchMode({ mode: modeInput.mode, overrides: modeInput.overrides, perCall: { searchLimit: limit } });
  const innerLimit = Math.min(Math.max(limit * 2, PRE_FUSION_POOL_FLOOR, limit), MAX_SEARCH_LIMIT);
  return {
    limit,
    innerLimit,
    intentWeighting: m.intentWeighting,
    keywordOrFallback: m.keywordOrFallback,
    tokenBudget: m.tokenBudget,
    titleBoost: m.title_boost,
    graphSignals: m.graph_signals,
    floorRatio: m.floor_ratio,
    mode: m.resolved_mode,
  };
}

interface SimInputs {
  query: string;
  queryEmbedding: Float32Array;
  column: string;
  detail: 'low' | 'medium' | 'high' | undefined;
  intentWeights: IntentWeights;
  vectorList: SearchResult[];
  keywordStrict: SearchResult[];
  titleStrict: SearchResult[];
  /** Full title arm output (incl. relaxed rows) — hybrid hands this to the exact-lookup tier. */
  titleAll: SearchResult[];
  postFusionOpts: PostFusionOpts;
  knobs: RunKnobs;
}

/**
 * Re-run hybrid's main RRF path from the arm lists with the SAME functions
 * hybrid.ts calls, honoring the stage flags. Returns the returned rows the
 * live call would have produced (post slice + token budget).
 */
async function simulate(engine: PGLiteEngine, inp: SimInputs, flags: StageFlags): Promise<SearchResult[]> {
  const iw = inp.intentWeights;
  const keywordK = effectiveRrfK(RRF_K, iw.keywordWeight);
  const vectorK = effectiveRrfK(RRF_K, iw.vectorWeight);
  const lists: Array<{ list: SearchResult[]; k: number }> = [{ list: inp.vectorList, k: vectorK }];
  const kw = flags.keywordArm ? inp.keywordStrict : [];
  lists.push({ list: kw, k: keywordK }); // hybrid always pushes the keyword list (empty is a no-op)
  if (flags.titleArm && inp.titleStrict.length > 0) lists.push({ list: inp.titleStrict, k: keywordK });
  await stampUnverifiedExtractions(engine, lists.flatMap(l => l.list));
  let fused = rrfFusionWeighted(lists, flags.compiledTruthBoost && shouldBoostCompiledTruth(inp.detail));
  if (flags.cosineBlend) fused = await cosineReScore(engine, fused, inp.queryEmbedding, inp.column);
  if (fused.length > 0) {
    if (flags.postFusionBoosts) {
      const base = inp.postFusionOpts;
      const pfo: PostFusionOpts = {
        ...base,
        applyBacklinks: base.applyBacklinks && flags.backlinkBoost,
        graphSignalsEnabled: (base.graphSignalsEnabled ?? false) && flags.graphSignals,
        recency: flags.recencyBoost ? base.recency : 'off',
        salience: flags.salienceBoost ? base.salience : 'off',
        titleBoost: flags.titlePhraseBoost ? base.titleBoost : undefined,
      };
      await runPostFusionStages(engine, fused, pfo);
      if (flags.exactMatchBoost && iw.exactMatchBoost !== 1.0) applyExactMatchBoost(fused, inp.query, iw);
    }
    fused.sort((a, b) => b.score - a.score);
  }
  const deduped = flags.dedup ? dedupResults(fused) : fused;
  const hopped = await applyAliasHop(engine, deduped, inp.query, {});
  const tiered = await applyExactLookupTier(engine, hopped, inp.query, { titleCandidates: inp.titleAll });
  const sliced = tiered.slice(0, inp.knobs.limit);
  return enforceTokenBudget(sliced, inp.knobs.tokenBudget).results;
}

/** hybrid.ts resolveEffectiveRecency for a call with no per-call recency opts. */
function effectiveRecency(
  suggestions: { intent: IntentWeights extends never ? never : Parameters<typeof weightsForIntent>[0]; suggestedRecency: 'off' | 'on' | 'strong' },
  intentWeightingOn: boolean,
): 'off' | 'on' | 'strong' {
  const intentRecency = intentWeightingOn ? (weightsForIntent(suggestions.intent).suggestedRecency ?? null) : null;
  return suggestions.suggestedRecency !== 'off'
    ? suggestions.suggestedRecency
    : (intentRecency ?? suggestions.suggestedRecency);
}

export interface PageVectorRef {
  /** slug → document-side page vector (VectorOnlyAdapter init). */
  vectors: Map<string, Float32Array>;
}

function rankPageVectors(ref: PageVectorRef, q: Float32Array): string[] {
  const scored: Array<{ id: string; score: number }> = [];
  for (const [slug, v] of ref.vectors) {
    const sim = cosineSimilarity(q, v);
    if (sim > 0) scored.push({ id: slug, score: sim });
  }
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(s => s.id);
}

export interface MeasureContext {
  knobs: RunKnobs;
  grades: ReadonlyMap<string, number>;
  pageVectors: PageVectorRef | null;
}

/** One probe end to end. Exported for the hermetic test. */
export async function measureProbe(engine: PGLiteEngine, probe: Probe, ctx: MeasureContext): Promise<ProbeGapRecord> {
  const text = probe.q.text;
  const targets = [...probe.targetSlugs];
  const { knobs } = ctx;

  // ONE query-side embedding for every arm (hybrid consumes it via queryEmbedFn).
  const qEmb = await embedQuery(text);

  let meta: HybridSearchMeta | undefined;
  const liveRows = await hybridSearch(engine, text, {
    limit: knobs.limit,
    onMeta: (m) => { meta = m; },
    queryEmbedFn: () => qEmb,
  });
  const column = meta?.embedding_column ?? 'embedding';
  const detail = (meta?.detail_resolved ?? undefined) as 'low' | 'medium' | 'high' | undefined;

  // The arms, with hybrid's exact SearchOpts shape for each.
  const armOpts: SearchOpts = { limit: knobs.innerLimit, detail, orFallback: knobs.keywordOrFallback };
  const vectorList = await engine.searchVector(qEmb, { ...armOpts, embeddingColumn: column });
  const keywordAll = await engine.searchKeyword(text, armOpts);
  const titleAll = await engine.searchTitles(text, armOpts);
  for (const r of keywordAll) r.keyword_hit = true;   // markKeywordHits (pre-fusion stamp)
  for (const r of titleAll) r.keyword_hit = true;
  const keywordStrict = keywordAll.filter(r => !r.keyword_relaxed);
  const titleStrict = titleAll.filter(r => !r.keyword_relaxed);

  const vectorOrder = collapsePages(vectorList).map(p => p.slug);
  const liveOrder = collapsePages(liveRows).map(p => p.slug);
  const kwOrder = collapsePages(keywordStrict).map(p => p.slug);
  const titleOrder = collapsePages(titleStrict).map(p => p.slug);

  // Intent + post-fusion opts exactly as hybrid resolves them for this call.
  const suggestions = await classifyQueryWithBrainPatterns(engine, text);
  const intentWeights = knobs.intentWeighting ? weightsForIntent(suggestions.intent) : weightsForIntent('general');
  const postFusionOpts: PostFusionOpts = {
    applyBacklinks: true,
    salience: suggestions.suggestedSalience,
    recency: effectiveRecency(suggestions, knobs.intentWeighting),
    floorRatio: knobs.floorRatio,
    graphSignalsEnabled: knobs.graphSignals,
    query: text,
    titleBoost: knobs.titleBoost,
  };
  const sim: SimInputs = {
    query: text, queryEmbedding: qEmb, column, detail, intentWeights,
    vectorList, keywordStrict, titleStrict, titleAll, postFusionOpts, knobs,
  };

  const ablations = {} as Record<AblationName, AblationOutcome>;
  let simFullOrder: string[] = [];
  for (const name of ABLATIONS) {
    const rows = await simulate(engine, sim, stageFlags(name));
    const order = collapsePages(rows).map(p => p.slug);
    if (name === 'full') simFullOrder = order;
    ablations[name] = { gold_rank: goldRank(order, targets), ndcg5: safeNdcg(order, ctx.grades) };
  }

  const armSets = { vector: new Set(vectorOrder), keyword: new Set(kwOrder), title: new Set(titleOrder) };
  const hybridTop = stampPages(liveRows, armSets, RECORD_TOP_N);
  const vRank = goldRank(vectorOrder, targets);
  const hRank = goldRank(liveOrder, targets);
  const relaxedFused = liveRows.some(r => r.keyword_relaxed === true);
  const tokenDropped = meta?.token_budget?.dropped ?? 0;
  const gap = isGap(vRank, hRank);
  const gain = isGain(vRank, hRank);
  const cls = classifyGap({
    vector_gold_rank: vRank,
    hybrid_gold_rank: hRank,
    ablations,
    relaxed_rows_fused: relaxedFused,
    detail_resolved: meta?.detail_resolved ?? null,
    token_budget_dropped: tokenDropped,
  });

  let pvDoc: string[] | null = null;
  let pvQuery: string[] | null = null;
  if (ctx.pageVectors) {
    const docSideQ = await embed(text); // what the E0 `vector` adapter does (document-side)
    pvDoc = rankPageVectors(ctx.pageVectors, docSideQ);
    pvQuery = rankPageVectors(ctx.pageVectors, qEmb);
  }

  const top5 = (a: string[]) => a.slice(0, TOP_K).join('|');
  return {
    probe_id: probe.q.id,
    template: probe.template,
    text,
    targets,
    intent: meta?.intent ?? null,
    detail_resolved: meta?.detail_resolved ?? null,
    vector_enabled: meta?.vector_enabled ?? false,
    live: {
      vector_gold_rank: vRank,
      vector_ndcg5: safeNdcg(vectorOrder, ctx.grades),
      hybrid_gold_rank: hRank,
      hybrid_ndcg5: safeNdcg(liveOrder, ctx.grades),
      page_vector_docside_gold_rank: pvDoc ? goldRank(pvDoc, targets) : null,
      page_vector_docside_ndcg5: pvDoc ? safeNdcg(pvDoc, ctx.grades) : null,
      page_vector_queryside_gold_rank: pvQuery ? goldRank(pvQuery, targets) : null,
      page_vector_queryside_ndcg5: pvQuery ? safeNdcg(pvQuery, ctx.grades) : null,
    },
    arms: {
      vector_rows: vectorList.length,
      keyword_strict_rows: keywordStrict.length,
      keyword_relaxed_rows: keywordAll.length - keywordStrict.length,
      title_strict_rows: titleStrict.length,
      title_relaxed_rows: titleAll.length - titleStrict.length,
      keyword_gold_rank: goldRank(kwOrder, targets),
      title_gold_rank: goldRank(titleOrder, targets),
      keyword_top_slug: kwOrder[0] ?? null,
      title_top_slug: titleOrder[0] ?? null,
    },
    meta: {
      degraded: (meta?.degraded ?? []).map(d => (d.reason ? `${d.stage}:${d.reason}` : d.stage)),
      relaxed_dropped: meta?.relaxed_dropped ?? 0,
      token_budget_dropped: tokenDropped,
      keyword_arm_margin: meta?.keyword_arm_confidence?.margin_ratio ?? null,
      embedding_column: meta?.embedding_column ?? null,
      metadata_boost_gate: meta?.metadata_boost_gate ?? null,
    },
    hybrid_top: hybridTop,
    vector_top: vectorOrder.slice(0, RECORD_TOP_N),
    ablations,
    simulation: {
      top5_match: top5(simFullOrder) === top5(liveOrder),
      full_match: simFullOrder.join('|') === liveOrder.join('|'),
      live_pages: liveOrder.length,
      sim_pages: simFullOrder.length,
    },
    gap,
    gain,
    intruders: gap ? findIntruders(hybridTop, vectorOrder, targets, hRank, vRank) : [],
    gap_class: cls.gap_class,
    class_detail: cls.class_detail,
    best_partial: cls.best_partial,
  };
}

function safeNdcg(order: readonly string[], grades: ReadonlyMap<string, number>): number {
  const v = ndcgAtK(order, grades, TOP_K);
  return Number.isNaN(v) ? 0 : v;
}

// ─── CLI / options ────────────────────────────────────────────────

export interface LocalizeOptions {
  stubEmbed?: boolean;
  embeddingModel?: string;
  embeddingDims?: string | number;
  tuningConcepts?: number;
  holdoutConcepts?: number;
  seed?: number;
  targetProbes?: number;
  /** Cap on tuning probes measured (generation order) — smoke runs only; the report flags it. */
  maxProbes?: number;
  reportsDir?: string;
  /** Skip the page-vector comparator replica (saves 240 page embeds + 1 embed per probe). */
  noPageVector?: boolean;
  /** E0-V1 receipt path for the ladder's paired "before" rows; missing file → omitted. */
  e0Receipt?: string;
  /** Recompute the summary + markdown from an existing localize.json (no brain, no embeds). */
  rerender?: string;
  quiet?: boolean;
}

function parseNonNegativeInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer, got '${raw}'`);
  return n;
}

export function parseLocalizeArgv(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): LocalizeOptions {
  const opts: LocalizeOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      i += 1;
      return v;
    };
    switch (flag) {
      case '--stub-embed': opts.stubEmbed = true; break;
      case '--no-page-vector': opts.noPageVector = true; break;
      case '--embedding-model': opts.embeddingModel = value(); break;
      case '--embedding-dims': opts.embeddingDims = value(); break;
      case '--tuning-concepts': opts.tuningConcepts = parseNonNegativeInt(value(), '--tuning-concepts'); break;
      case '--holdout-concepts': opts.holdoutConcepts = parseNonNegativeInt(value(), '--holdout-concepts'); break;
      case '--seed': opts.seed = parseNonNegativeInt(value(), '--seed'); break;
      case '--max-probes': {
        const n = parseNonNegativeInt(value(), '--max-probes');
        if (n === 0) throw new Error('--max-probes must be >= 1');
        opts.maxProbes = n;
        break;
      }
      case '--reports-dir': opts.reportsDir = value(); break;
      case '--e0-receipt': opts.e0Receipt = value(); break;
      case '--rerender': opts.rerender = value(); break;
      default:
        throw new Error(
          `unknown argument '${arg}'. Known: --stub-embed --no-page-vector --embedding-model <provider:model> `
          + `--embedding-dims <N> --tuning-concepts <N> --holdout-concepts <M> --seed <N> --max-probes <N> `
          + `--reports-dir <dir> --e0-receipt <path> --rerender <localize.json>`,
        );
    }
  }
  if (env.CAT13_STUB_EMBED === '1') opts.stubEmbed = true;
  return opts;
}

// ─── Report ───────────────────────────────────────────────────────

export interface LadderRow {
  ranking: string;
  tuning_ndcg5: number | null;
  p1_strict: number | null;
  note: string;
}

export interface LocalizeReport {
  generated_at: string;
  gbrain_version: string;
  gbrain_pin: string;
  stub_embed: boolean;
  embedder: EmbedderConfig;
  embedding_transport: string;
  search_pins: Record<string, string>;
  knobs: RunKnobs;
  concept_split: { seed: number; tuning_n: number; holdout_n: number; tuning: string[]; holdout: string[] };
  probes: { generated: number; tuning: number; measured: number; max_probes: number | null };
  e0_receipt: { path: string; vector_tuning_ndcg5: number; gbrain_tuning_ndcg5: number; vector_tuning_p1: number; gbrain_tuning_p1: number } | null;
  summary: {
    ladder: LadderRow[];
    gap_probes: number;
    gain_probes: number;
    neutral_probes: number;
    simulation: { probes: number; top5_mismatches: number; full_mismatches: number; mismatched_probe_ids: string[] };
    classes: ClassCounts;
    classes_by_template: Record<string, ClassCounts>;
    delta_by_template: Record<string, DeltaDistribution>;
    delta_all: DeltaDistribution;
    arm_presence: {
      keyword_strict_nonempty: number;
      title_strict_nonempty: number;
      either_lexical_nonempty: number;
      gap_with_empty_lexical_arms: number;
      relaxed_rows_fused: number;
      detail_low: number;
      intents: Record<string, number>;
      degraded_stages: Record<string, number>;
    };
    /** Gap probes with >= 1 intruder carrying each boost stamp, and gap probes by intent. */
    boost_breakdown: { gap_probes_with_intruder_stamp: Record<string, number>; gap_probes_by_intent: Record<string, number>; gap_probes_with_any_intruder_boost: number };
    top_intruders: IntruderRollup[];
    mechanisms: MechanismRow[];
    policies: PolicyProjection[];
    proposal: {
      ablation: AblationName; stage: string; proposal: string; fixed: number; collateral: number; tuning_ndcg5: number;
      /** The compound post-fusion block, reported as the ceiling the single stage sits under. */
      block: { fixed: number; collateral: number; tuning_ndcg5: number } | null;
      /** The best implementable gate by net fixes. */
      best_policy: PolicyProjection | null;
    } | null;
  };
  /** Set when the summary was recomputed from recorded records (--rerender). */
  rerendered_at?: string;
  records: ProbeGapRecord[];
}

const pct = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}`);
const num = (x: number | null | undefined, dp = 3): string => (x === null || x === undefined ? 'n/a' : x.toFixed(dp));

function mean(xs: readonly (number | null)[]): number | null {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function summarize(records: readonly ProbeGapRecord[], e0: LocalizeReport['e0_receipt']): LocalizeReport['summary'] {
  const n = records.length;
  const p1 = (get: (r: ProbeGapRecord) => number | null): number | null => {
    const v = records.map(get).filter((x): x is number | null => x !== undefined);
    if (v.every(x => x === null)) return null;
    return v.filter(x => x === 1).length / n;
  };
  const ladder: LadderRow[] = [];
  if (e0) {
    ladder.push({ ranking: 'E0-V1 `vector` adapter (receipt, tuning)', tuning_ndcg5: e0.vector_tuning_ndcg5, p1_strict: e0.vector_tuning_p1, note: 'one document-side vector per page; document-side query embed; no source factor' });
  }
  const pvDoc = mean(records.map(r => r.live.page_vector_docside_ndcg5));
  if (pvDoc !== null) ladder.push({ ranking: 'page-vector replica, document-side query embed (this run)', tuning_ndcg5: pvDoc, p1_strict: p1(r => r.live.page_vector_docside_gold_rank), note: 'replicates the E0 `vector` adapter on the same pages' });
  const pvQ = mean(records.map(r => r.live.page_vector_queryside_ndcg5));
  if (pvQ !== null) ladder.push({ ranking: 'page-vector replica, query-side query embed (this run)', tuning_ndcg5: pvQ, p1_strict: p1(r => r.live.page_vector_queryside_gold_rank), note: 'same page vectors, gbrain\'s query-side embed' });
  ladder.push({ ranking: 'gbrain vector arm — engine.searchVector, page-collapsed (this run)', tuning_ndcg5: mean(records.map(r => r.live.vector_ndcg5)), p1_strict: p1(r => r.live.vector_gold_rank), note: 'chunk-grain HNSW, best chunk per page, source factor applied; the arm hybrid fuses' });
  for (const name of ['vector_only', 'no_lexical_no_boosts', 'no_lexical_arms', 'no_title_arm', 'no_keyword_arm', 'no_cosine_blend', 'no_post_fusion_boosts', 'no_backlink_boost', 'no_graph_signals', 'no_recency_boost', 'no_salience_boost', 'no_title_phrase_boost', 'no_exact_match_boost', 'no_compiled_truth_boost', 'no_dedup', 'full'] as AblationName[]) {
    ladder.push({ ranking: `re-simulated: ${name}`, tuning_ndcg5: mean(records.map(r => r.ablations[name].ndcg5)), p1_strict: p1(r => r.ablations[name].gold_rank), note: MECHANISM_TEXT[name].stage });
  }
  ladder.push({ ranking: 'gbrain hybrid live (this run)', tuning_ndcg5: mean(records.map(r => r.live.hybrid_ndcg5)), p1_strict: p1(r => r.live.hybrid_gold_rank), note: 'hybridSearch, balanced, reranker off, autocut off, metadata_boost_gate=always (ungated, as re-simulated), limit 30' });
  if (e0) ladder.push({ ranking: 'E0-V1 `gbrain` adapter (receipt, tuning)', tuning_ndcg5: e0.gbrain_tuning_ndcg5, p1_strict: e0.gbrain_tuning_p1, note: 'should match the live row above within embedding noise' });

  const templates = [...new Set(records.map(r => r.template))].sort();
  const classesByTemplate: Record<string, ClassCounts> = {};
  const deltaByTemplate: Record<string, DeltaDistribution> = {};
  for (const t of templates) {
    const rs = records.filter(r => r.template === t);
    classesByTemplate[t] = countClasses(rs);
    deltaByTemplate[t] = deltaDistribution(rs);
  }
  const intents: Record<string, number> = {};
  const degraded: Record<string, number> = {};
  for (const r of records) {
    const k = r.intent ?? 'null';
    intents[k] = (intents[k] ?? 0) + 1;
    for (const d of r.meta.degraded) degraded[d] = (degraded[d] ?? 0) + 1;
  }
  const mismatched = records.filter(r => !r.simulation.top5_match).map(r => r.probe_id);
  const stampCounts: Record<string, number> = {};
  const gapIntents: Record<string, number> = {};
  let anyBoost = 0;
  for (const r of records) {
    if (!r.gap) continue;
    const gi = r.intent ?? 'null';
    gapIntents[gi] = (gapIntents[gi] ?? 0) + 1;
    const kinds = new Set(r.intruders.flatMap(i => Object.keys(i.boosts)));
    if (kinds.size > 0) anyBoost += 1;
    for (const k of kinds) stampCounts[k] = (stampCounts[k] ?? 0) + 1;
  }
  const mechanisms = rankMechanisms(records);
  const policies = policyProjections(records);
  const top = mechanisms.find(m => PROPOSAL_CANDIDATES.includes(m.ablation));
  const block = mechanisms.find(m => m.ablation === 'no_post_fusion_boosts');
  return {
    ladder,
    gap_probes: records.filter(r => r.gap).length,
    gain_probes: records.filter(r => r.gain).length,
    neutral_probes: records.filter(r => !r.gap && !r.gain).length,
    simulation: {
      probes: n,
      top5_mismatches: mismatched.length,
      full_mismatches: records.filter(r => !r.simulation.full_match).length,
      mismatched_probe_ids: mismatched.slice(0, 25),
    },
    classes: countClasses(records),
    classes_by_template: classesByTemplate,
    delta_by_template: deltaByTemplate,
    delta_all: deltaDistribution(records),
    arm_presence: {
      keyword_strict_nonempty: records.filter(r => r.arms.keyword_strict_rows > 0).length,
      title_strict_nonempty: records.filter(r => r.arms.title_strict_rows > 0).length,
      either_lexical_nonempty: records.filter(r => r.arms.keyword_strict_rows > 0 || r.arms.title_strict_rows > 0).length,
      gap_with_empty_lexical_arms: records.filter(r => r.gap && r.arms.keyword_strict_rows === 0 && r.arms.title_strict_rows === 0).length,
      relaxed_rows_fused: records.filter(r => r.hybrid_top.some(p => p.keyword_relaxed)).length,
      detail_low: records.filter(r => r.detail_resolved === 'low').length,
      intents,
      degraded_stages: degraded,
    },
    boost_breakdown: { gap_probes_with_intruder_stamp: stampCounts, gap_probes_by_intent: gapIntents, gap_probes_with_any_intruder_boost: anyBoost },
    top_intruders: topIntruders(records, 10),
    mechanisms,
    policies,
    proposal: top && top.fixed > 0
      ? {
        ablation: top.ablation, stage: top.stage, proposal: top.proposal, fixed: top.fixed, collateral: top.collateral, tuning_ndcg5: top.tuning_ndcg5,
        block: block ? { fixed: block.fixed, collateral: block.collateral, tuning_ndcg5: block.tuning_ndcg5 } : null,
        best_policy: policies[0] ?? null,
      }
      : null,
  };
}

export function renderMarkdown(report: LocalizeReport): string {
  const s = report.summary;
  const L: string[] = [];
  L.push(`# Cat 13 — Phase E1 gap localization (tuning split)`);
  L.push('');
  L.push(`Generated: ${report.generated_at} · gbrain ${report.gbrain_version} (pin ${report.gbrain_pin})`);
  L.push(`Embeds: ${report.embedding_transport}`);
  L.push(`Search pins: ${Object.entries(report.search_pins).map(([k, v]) => `${k}=${v}`).join(' ')} · resolved mode=${report.knobs.mode} limit=${report.knobs.limit} innerLimit=${report.knobs.innerLimit} tokenBudget=${report.knobs.tokenBudget ?? 'off'} title_boost=${report.knobs.titleBoost ?? 'off'} graph_signals=${report.knobs.graphSignals} intentWeighting=${report.knobs.intentWeighting} keywordOrFallback=${report.knobs.keywordOrFallback}`);
  L.push(`Concept split: seed=${report.concept_split.seed}, ${report.concept_split.tuning_n} tuning / ${report.concept_split.holdout_n} held-out (held-out never queried)`);
  L.push(`Probes: ${report.probes.generated} generated, ${report.probes.tuning} tuning-subset, ${report.probes.measured} measured${report.probes.max_probes !== null ? ` (CAPPED by --max-probes ${report.probes.max_probes}: smoke run, not a localization)` : ''}`);
  if (report.stub_embed) L.push(`**STUB EMBEDDINGS — plumbing check only; the classes below mean nothing.**`);
  L.push('');
  L.push(`One query-side embedding per probe is shared by every arm (hybridSearch \`queryEmbedFn\`), so the vector-arm ranking and hybrid's vector list are the same list by construction.`);
  L.push('');
  L.push(`## Ladder — tuning nDCG@5 (×100) by ranking`);
  L.push('');
  L.push(`| ranking | nDCG@5 | P@1 | what it is |`);
  L.push(`|---|---|---|---|`);
  for (const row of s.ladder) L.push(`| ${row.ranking} | ${pct(row.tuning_ndcg5)} | ${pct(row.p1_strict)} | ${row.note} |`);
  L.push('');
  L.push(`## Simulation fidelity`);
  L.push('');
  L.push(`The \`full\` re-simulation (same functions hybrid.ts calls, fed the re-fetched arm lists) reproduced the live hybrid page order on ${s.simulation.probes - s.simulation.top5_mismatches} / ${s.simulation.probes} probes at top-5 (${s.simulation.probes - s.simulation.full_mismatches} / ${s.simulation.probes} over the whole returned list). Ablation numbers are only as trustworthy as this row.${s.simulation.mismatched_probe_ids.length > 0 ? ` Top-5 mismatches: ${s.simulation.mismatched_probe_ids.join(', ')}.` : ''}`);
  L.push('');
  L.push(`## Gap / gain overview`);
  L.push('');
  L.push(`- gap probes (vector arm has gold in top-5, hybrid ranks it lower or drops it): **${s.gap_probes}**`);
  L.push(`- gain probes (hybrid ranks gold above its vector-arm rank, within top-5): ${s.gain_probes}`);
  L.push(`- neutral: ${s.neutral_probes}`);
  L.push(`- strict keyword arm non-empty: ${s.arm_presence.keyword_strict_nonempty} / ${s.simulation.probes}; title arm non-empty: ${s.arm_presence.title_strict_nonempty}; either lexical arm non-empty: ${s.arm_presence.either_lexical_nonempty}`);
  L.push(`- gap probes with BOTH lexical arms empty (only the vector list + post-fusion stages could have moved gold): ${s.arm_presence.gap_with_empty_lexical_arms}`);
  L.push(`- probes with a relaxed (AND→OR) row in the returned set: ${s.arm_presence.relaxed_rows_fused}; detail_resolved=low (compiled-truth 2x active): ${s.arm_presence.detail_low}`);
  L.push(`- intents: ${Object.entries(s.arm_presence.intents).map(([k, v]) => `${k}=${v}`).join(', ')}; degraded stages: ${Object.keys(s.arm_presence.degraded_stages).length === 0 ? 'none' : Object.entries(s.arm_presence.degraded_stages).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  L.push('');
  L.push(`## Gap classes (single stage whose neutralization restores gold to <= its vector-arm rank)`);
  L.push('');
  const classNames = Object.keys(GAP_CLASS_NUMBER) as GapClass[];
  const templates = Object.keys(s.classes_by_template).sort();
  L.push(`| class | # | overall | ${templates.join(' | ')} |`);
  L.push(`|---|---|---|${templates.map(() => '---').join('|')}|`);
  for (const c of classNames) {
    L.push(`| ${c} | ${GAP_CLASS_NUMBER[c]} | ${s.classes.classes[c]} | ${templates.map(t => s.classes_by_template[t].classes[c]).join(' | ')} |`);
  }
  L.push(`| **gap probes** | | **${s.classes.gap_probes}** | ${templates.map(t => s.classes_by_template[t].gap_probes).join(' | ')} |`);
  L.push('');
  L.push(`## Gold-rank delta (hybrid − vector arm) per template`);
  L.push('');
  L.push(`| template | probes | vector nDCG@5 | hybrid nDCG@5 | improved | same | worse in top-5 | pushed out of top-5 | vector missed top-5 | both outside | mean Δ (both present) | ${DELTA_BINS.join(' | ')} |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|${DELTA_BINS.map(() => '---').join('|')}|`);
  const deltaRow = (name: string, d: DeltaDistribution) =>
    `| ${name} | ${d.probes} | ${pct(d.vector_ndcg5)} | ${pct(d.hybrid_ndcg5)} | ${d.buckets.improved} | ${d.buckets.same} | ${d.buckets.worse_in_top5} | ${d.buckets.pushed_out_of_top5} | ${d.buckets.vector_missed_top5} | ${d.buckets.both_outside_top5} | ${num(d.mean_delta_both_present, 2)} (n=${d.both_present}) | ${DELTA_BINS.map(b => d.delta_hist[b]).join(' | ')} |`;
  for (const t of templates) L.push(deltaRow(t, s.delta_by_template[t]));
  L.push(deltaRow('**all**', s.delta_all));
  L.push('');
  L.push(`## Which boost stamps ride on the intruders (gap probes)`);
  L.push('');
  L.push(`Gap probes with at least one intruder carrying a boost: ${s.boost_breakdown.gap_probes_with_any_intruder_boost} / ${s.gap_probes}. By stamp (a probe counts once per stamp kind): ${Object.entries(s.boost_breakdown.gap_probes_with_intruder_stamp).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}. Gap probes by intent: ${Object.entries(s.boost_breakdown.gap_probes_by_intent).map(([k, v]) => `${k}=${v}`).join(', ')}.`);
  L.push('');
  L.push(`## Top-10 non-gold pages hybrid promotes above gold (gap probes)`);
  L.push('');
  L.push(`| page | times | via title arm | via keyword arm | vector-only | carried a boost | boost stamps | templates |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  for (const it of s.top_intruders) {
    L.push(`| ${it.slug} | ${it.count} | ${it.via_title_arm} | ${it.via_keyword_arm} | ${it.vector_only} | ${it.boosted} | ${Object.entries(it.boost_kinds).map(([k, v]) => `${k}×${v}`).join(', ') || '—'} | ${Object.entries(it.templates).map(([k, v]) => `${k}:${v}`).join(', ')} |`);
  }
  L.push('');
  L.push(`## Mechanisms ranked by probes fixed when the stage is neutralized`);
  L.push('');
  L.push(`| ablation | fixed | improved only | collateral (gains lost) | net | tuning nDCG@5 | Δ vs live hybrid | stage |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  for (const m of s.mechanisms) {
    L.push(`| ${m.ablation} | ${m.fixed} | ${m.improved_only} | ${m.collateral} | ${m.net} | ${pct(m.tuning_ndcg5)} | ${m.ndcg5_delta_vs_live_hybrid >= 0 ? '+' : ''}${pct(m.ndcg5_delta_vs_live_hybrid)} | ${m.stage} |`);
  }
  L.push('');
  L.push(`## Implementable gates, projected from the recorded ablations`);
  L.push('');
  L.push(`Where the gate's condition holds the probe takes the ablated outcome, elsewhere the live one — exact, no re-run.`);
  L.push('');
  L.push(`| policy | applies to | fixed | improved only | collateral | net | tuning nDCG@5 | Δ vs live hybrid | what it does |`);
  L.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const p of s.policies) {
    L.push(`| ${p.policy} | ${p.applies_to_probes} / ${s.simulation.probes} | ${p.fixed} | ${p.improved_only} | ${p.collateral} | ${p.net} | ${pct(p.tuning_ndcg5)} | ${p.ndcg5_delta_vs_live_hybrid >= 0 ? '+' : ''}${pct(p.ndcg5_delta_vs_live_hybrid)} | ${p.description} |`);
  }
  L.push('');
  L.push(`## Proposed single mechanism`);
  L.push('');
  if (s.proposal) {
    L.push(`**Single stage: ${s.proposal.stage}.** Neutralizing it alone fixes ${s.proposal.fixed} of ${s.gap_probes} gap probes on the tuning split, costs ${s.proposal.collateral} gain probes, tuning nDCG@5 ${pct(s.proposal.tuning_ndcg5)} (live hybrid ${pct(s.delta_all.hybrid_ndcg5)}, vector arm ${pct(s.delta_all.vector_ndcg5)}).${s.proposal.block ? ` The whole post-fusion metadata block is the ceiling: ${s.proposal.block.fixed} fixed, ${s.proposal.block.collateral} collateral, nDCG@5 ${pct(s.proposal.block.tuning_ndcg5)}.` : ''}`);
    L.push('');
    L.push(`Stage-level change: ${s.proposal.proposal}.`);
    if (s.proposal.best_policy) {
      const bp = s.proposal.best_policy;
      L.push('');
      L.push(`Best implementable gate by net fixes: **${bp.policy}** — ${bp.description}; applies to ${bp.applies_to_probes} probes, fixes ${bp.fixed}, collateral ${bp.collateral}, tuning nDCG@5 ${pct(bp.tuning_ndcg5)} (${bp.ndcg5_delta_vs_live_hybrid >= 0 ? '+' : ''}${pct(bp.ndcg5_delta_vs_live_hybrid)}).`);
    }
  } else {
    L.push(`_No single-stage neutralization fixes any gap probe; see the classes table (vector_arm_mismatch / unexplained) and the ladder — the gap is not in fusion._`);
  }
  L.push('');
  L.push(`## Sample gap probes`);
  L.push('');
  L.push(`| probe | template | class | vector rank | hybrid rank | fixed by | intruders (arms; boosts) |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const r of report.records.filter(x => x.gap).slice(0, 25)) {
    const fixedBy = SINGLE_STAGE_ABLATIONS.filter(a => r.ablations[a].gold_rank !== null && (r.ablations[a].gold_rank as number) <= (r.live.vector_gold_rank as number)).join(', ') || (r.ablations.no_lexical_arms.gold_rank !== null && (r.ablations.no_lexical_arms.gold_rank as number) <= (r.live.vector_gold_rank as number) ? 'no_lexical_arms' : '—');
    const intr = r.intruders.slice(0, 3).map(i => `${i.slug} (${i.arms.join('+') || 'none'}${Object.keys(i.boosts).length ? '; ' + Object.entries(i.boosts).map(([k, v]) => `${k}=${(v as number).toFixed(3)}`).join(',') : ''})`).join('; ');
    L.push(`| ${r.probe_id} "${r.text}" | ${r.template} | ${r.gap_class} | ${r.live.vector_gold_rank} | ${r.live.hybrid_gold_rank ?? 'absent'} | ${fixedBy} | ${intr} |`);
  }
  L.push('');
  L.push(`## Caveats`);
  L.push('');
  L.push(`- Tuning split only; nothing here is a held-out decision. The proposal is a hypothesis for the E2-style held-out arm.`);
  L.push(`- "Vector arm" is gbrain's own chunk-grain HNSW arm (best chunk per page, source-prefix factor applied), not the E0 \`vector\` adapter; the ladder's page-vector rows measure that substrate difference separately.`);
  L.push(`- The E0 \`vector\` adapter embeds the QUERY document-side (\`embed\`), gbrain embeds it query-side (\`embedQuery\`); both page-vector replica rows are reported so the input_type effect is visible.`);
  L.push(`- Ablations are offline re-simulations validated against the live order (see Simulation fidelity); the relational arm is not re-simulated (rows carrying relational stamps would show up as mismatches).`);
  return L.join('\n');
}

// ─── Runner ───────────────────────────────────────────────────────

export interface LocalizeRunResult {
  report: LocalizeReport;
  files: { json: string; md: string };
}

function readE0Receipt(path: string | undefined): LocalizeReport['e0_receipt'] {
  const p = path ?? DEFAULT_E0_RECEIPT;
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { data?: { scorecard?: Array<{ name: string; tuning?: { ndcg5: number; p1_strict: number } }> } };
    const sc = j.data?.scorecard ?? [];
    const v = sc.find(a => a.name === 'vector')?.tuning;
    const g = sc.find(a => a.name === 'gbrain')?.tuning;
    if (!v || !g) return null;
    return { path: p, vector_tuning_ndcg5: v.ndcg5, gbrain_tuning_ndcg5: g.ndcg5, vector_tuning_p1: v.p1_strict, gbrain_tuning_p1: g.p1_strict };
  } catch {
    return null;
  }
}

export async function runLocalize(opts: LocalizeOptions = {}): Promise<LocalizeRunResult> {
  const stubEmbed = opts.stubEmbed ?? false;
  const log = opts.quiet ? (_: string) => {} : (s: string) => console.log(s);
  const reportsDir = opts.reportsDir ?? join(process.cwd(), 'eval/reports');

  const embedder = resolveEmbedder({ model: opts.embeddingModel, dims: opts.embeddingDims });
  // The E0-V1 cell, plus the metadata boost gate pinned to `always`: this
  // runner re-simulates the UNGATED boost pipeline stage by stage (the gate is
  // the mechanism E1 motivated, and `lexical` is now the shipped default), so
  // the live call must run ungated for the sim-vs-live parity check to hold.
  const searchPins = pinnedSearchConfig({
    reranker: 'off', autocut: 'off',
    searchPins: { 'search.metadata_boost_gate': 'always' },
  });
  const embedKeyEnv = providerKeyEnv(embedder.model);
  if (!stubEmbed && !process.env[embedKeyEnv]) {
    throw new Error(`${embedKeyEnv} required for live embeds with ${embedder.model} (run with --stub-embed for the hermetic plumbing run)`);
  }

  const targetProbes = opts.targetProbes ?? resolveTargetProbes();
  const corpusDir = join(import.meta.dir, '..', 'data', 'world-v1');
  const pages = loadCorpus(corpusDir);
  const { probes, gradesByQuery } = buildProbes(pages, targetProbes);
  const conceptSlugs = pages.filter(p => p.slug.startsWith('concepts/')).map(p => p.slug);
  const split: ConceptSplit = splitConcepts(
    conceptSlugs,
    opts.tuningConcepts ?? DEFAULT_TUNING_CONCEPTS,
    opts.holdoutConcepts ?? DEFAULT_HOLDOUT_CONCEPTS,
    opts.seed ?? PROBE_SEED,
  );
  const tuningProbes = probes.filter(p => probeSubset(p, split) === 'tuning');
  const measured = opts.maxProbes !== undefined ? tuningProbes.slice(0, opts.maxProbes) : tuningProbes;
  if (measured.length === 0) throw new Error('no tuning-subset probes to measure (split too small?)');

  ensureGateway(stubEmbed, embedder);

  log(`# Cat 13 gap localization (Phase E1)`);
  log(`Embeds: ${stubEmbed ? 'stubbed deterministic hash (hermetic)' : 'live'} — ${embedder.model} @ ${embedder.dims}d`);
  log(`Search pins: ${Object.entries(searchPins).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  log(`Concept split: seed=${split.seed} tuning=${split.tuning.length} held-out=${split.holdout.length}; probes generated=${probes.length} tuning=${tuningProbes.length} measured=${measured.length}`);
  log(`Building one gbrain brain (${pages.length} pages) ...`);

  const adapter = new GbrainInlineAdapter({
    topK: TOP_K,
    searchConfig: searchPins,
    embeddingModel: embedder.model,
    embeddingDimensions: embedder.dims,
  });
  const publicPages = pages.map(sanitizePage);
  const t0 = Date.now();
  const state = await adapter.init(publicPages, { name: adapter.name });
  const engine = adapter.engineOf(state);
  log(`  brain ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  let pageVectors: PageVectorRef | null = null;
  if (!opts.noPageVector) {
    log(`Embedding one document-side vector per page for the E0 \`vector\` replica ...`);
    const pv = new VectorOnlyAdapter();
    const pvState = await pv.init(publicPages, {
      name: pv.name,
      shootout: { embedder: embedder.model, dim: embedder.dims, searchMode: CAT13_SEARCH_MODE },
    } as never);
    pageVectors = { vectors: (pvState as { vectors: Map<string, Float32Array> }).vectors };
    log(`  ${pageVectors.vectors.size} page vectors`);
  }

  const knobs = await resolveRunKnobs(engine, HYBRID_LIMIT);
  log(`Resolved knobs: mode=${knobs.mode} limit=${knobs.limit} innerLimit=${knobs.innerLimit} tokenBudget=${knobs.tokenBudget} title_boost=${knobs.titleBoost} graph_signals=${knobs.graphSignals}`);

  const records: ProbeGapRecord[] = [];
  try {
    let i = 0;
    for (const probe of measured) {
      const grades = gradesByQuery.get(probe.q.id) ?? new Map<string, number>();
      records.push(await measureProbe(engine, probe, { knobs, grades, pageVectors }));
      i += 1;
      // Direct-engine loop (bypasses adapter.query; ~12 ablation re-simulations
      // per probe): pace the GC the same way the adapter does.
      if (i % 25 === 0) gcNow();
      if (i % 25 === 0) log(`  ${i}/${measured.length} probes`);
    }
  } finally {
    await adapter.teardown(state);
  }

  const e0 = readE0Receipt(opts.e0Receipt);
  const report: LocalizeReport = {
    generated_at: new Date().toISOString(),
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    stub_embed: stubEmbed,
    embedder,
    embedding_transport: stubEmbed
      ? `stubbed deterministic hash-embed (__setEmbedTransportForTests), ${embedder.dims}d`
      : `live ${embedder.model} @ ${embedder.dims}d`,
    search_pins: searchPins,
    knobs,
    concept_split: { seed: split.seed, tuning_n: split.tuning.length, holdout_n: split.holdout.length, tuning: split.tuning, holdout: split.holdout },
    probes: { generated: probes.length, tuning: tuningProbes.length, measured: measured.length, max_probes: opts.maxProbes ?? null },
    e0_receipt: e0,
    summary: summarize(records, e0),
    records,
  };

  const outDir = join(reportsDir, GAP_REPORT_DIR);
  mkdirSync(outDir, { recursive: true });
  const jsonFile = join(outDir, 'localize.json');
  const mdFile = join(outDir, 'localize.md');
  writeFileSync(jsonFile, JSON.stringify(report, null, 2) + '\n');
  const md = renderMarkdown(report);
  writeFileSync(mdFile, md + '\n');
  log('');
  log(md);
  log(`[cat13-gap] wrote ${jsonFile} and ${mdFile}`);
  return { report, files: { json: jsonFile, md: mdFile } };
}

/**
 * Re-summarize + re-render from a recorded localize.json. The per-probe
 * records carry every ablation outcome, so a classifier / projection change
 * re-reads them instead of paying for another run. Writes next to the input
 * unless `outDir` is given.
 */
export function rerenderReport(jsonPath: string, outDir?: string): LocalizeRunResult {
  const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as LocalizeReport;
  for (const r of report.records) {
    for (const a of ABLATIONS) {
      if (!r.ablations[a]) throw new Error(`${jsonPath}: probe ${r.probe_id} lacks ablation '${a}' — recorded by an older localizer; re-run live`);
    }
  }
  report.summary = summarize(report.records, report.e0_receipt);
  report.rerendered_at = new Date().toISOString();
  const dir = outDir ?? join(jsonPath, '..');
  mkdirSync(dir, { recursive: true });
  const jsonFile = join(dir, 'localize.json');
  const mdFile = join(dir, 'localize.md');
  writeFileSync(jsonFile, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(mdFile, renderMarkdown(report) + '\n');
  return { report, files: { json: jsonFile, md: mdFile } };
}

if (import.meta.main) {
  const cli = parseLocalizeArgv(process.argv.slice(2));
  if (cli.rerender) {
    try {
      const { files, report } = rerenderReport(cli.rerender, cli.reportsDir ? join(cli.reportsDir, GAP_REPORT_DIR) : undefined);
      console.log(renderMarkdown(report));
      console.log(`[cat13-gap] re-rendered ${files.json} and ${files.md}`);
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(3);
    }
  }
  runLocalize(cli)
    .then(() => process.exit(0)) // explicit: PGLite's WASM runtime pollutes ambient process.exitCode
    .catch(err => {
      console.error(err);
      process.exit(3);
    });
}
