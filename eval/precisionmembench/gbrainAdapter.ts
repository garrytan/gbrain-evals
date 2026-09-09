/**
 * gbrainAdapter.ts — gbrain-backed PrecisionMemBench provider.
 *
 * Extends the vendored upstream BaseAdapter and overrides ONLY `searchText`
 * (the single provider-dependent method). Everything the scorer actually
 * reads through — `buildContext`, `listPinnedFacts`, `listPinnedOpenQuestions`,
 * `expandRelationParticipants`, the projection helpers — runs verbatim from
 * the parent against the in-memory `seedIndex`. So gbrain is measured on
 * exactly the `searchText` categories (alias, scope, fuzzy, supersession,
 * ranking); the structural categories are harness-computed, identical for
 * every provider (stated plainly in the teardown).
 *
 * `seed()` (the HTTP /reset+/add path) is NOT used — the runner ingests into
 * an in-memory PGLite engine via seed.ts, then calls `loadFixture()` to
 * populate `seedIndex` (which buildContext + the id→belief mapping need).
 */

import type { BrainEngine } from 'gbrain/engine';
import { hybridSearch } from 'gbrain/search/hybrid';
import type { HybridSearchMeta, SearchResult } from 'gbrain/types';
import type { Belief } from './scorer/belief.ts';
import { BaseAdapter } from './scorer/baseAdapter.ts';
import { federatedSourceIds } from './scope.ts';
import { applyReturnPolicy, type ReturnPolicy, type Scored } from './gate-proto.ts';
import { searchObservation, type SearchObservation } from '../runner/retrieval-pins.ts';
import { classifyQueryIntent } from '../../node_modules/gbrain/src/core/search/query-intent.ts';

export type GbrainSearchMode = 'hybrid' | 'keyword';

/**
 * Intent-aware policy (A1 + the A5 finding that a cliff gap doesn't
 * discriminate). gbrain's existing intent classifier picks which sub-policy
 * applies: `entity` queries are treated as single-answer lookups, everything
 * else as potential enumeration. Intent is the PRIOR; the sub-policy does the
 * sizing.
 */
export type AdapterReturnPolicy =
  | ReturnPolicy
  | { kind: 'intent'; single: ReturnPolicy; multi: ReturnPolicy };

export interface GbrainAdapterOpts {
  /** Record an execution failure if a nonempty answer bypassed the requested reranker. */
  requireReranker?: boolean;
  /** Return-sizing policy (default topk = gbrain's current behavior). */
  returnPolicy?: AdapterReturnPolicy;
  /** Instrumentation hook: per-query ordering-driving scores (desc) + decision. */
  onScores?: (info: { query: string; scope?: string; scores: number[]; keptIds: string[] }) => void;
  /**
   * Pass-through opts merged into the real `hybridSearch` call. Used to drive
   * gbrain's REAL adaptive-return core feature (`adaptiveReturn: {...}`) so the
   * benchmark measures the shipped feature, not the adapter-side prototype.
   * When set, leave `returnPolicy` at the default 'topk' to avoid double-trim.
   */
  extraHybridOpts?: Record<string, unknown>;
}

export class GbrainBeliefAdapter extends BaseAdapter {
  readonly observations: Array<SearchObservation & { case_id?: string; scope?: string; ranked_ids: string[]; kept_ids: string[] }> = [];
  private readonly requireReranker: boolean;
  private readonly returnPolicy: AdapterReturnPolicy;
  private readonly onScores?: GbrainAdapterOpts['onScores'];
  private readonly extraHybridOpts: Record<string, unknown>;

  constructor(
    private readonly engine: BrainEngine,
    private readonly mode: GbrainSearchMode = 'hybrid',
    opts: GbrainAdapterOpts = {},
  ) {
    super('gbrain');
    this.returnPolicy = opts.returnPolicy ?? { kind: 'topk' };
    this.onScores = opts.onScores;
    this.extraHybridOpts = opts.extraHybridOpts ?? {};
    this.requireReranker = opts.requireReranker ?? false;
  }

  /**
   * The only provider-dependent override. Maps the case's single `scope`
   * string to federated source ids, runs gbrain retrieval, and maps the
   * returned page slugs back to fixture beliefs (slug === beliefId by seed
   * construction). Dedup + excludeIds mirror the upstream HTTP searchText.
   */
  override async searchText(
    _userId: string,
    query: string,
    opts?: { limit?: number; excludeIds?: Set<string>; scope?: string },
  ): Promise<Belief[]> {
    if (!query.trim()) {
      this.observations.push({
        ...searchObservation({ query, mode: this.mode, emptyQuerySkipped: true }),
        scope: opts?.scope, ranked_ids: [], kept_ids: [],
      });
      return [];
    }

    const limit = opts?.limit ?? 20;
    const sourceIds = federatedSourceIds(opts?.scope);

    let results: SearchResult[] = [];
    let searchMeta: HybridSearchMeta | undefined;
    let relationalMeta: unknown;
    let error: unknown;
    let observation: (typeof this.observations)[number];
    try {
      if (this.mode === 'keyword') {
        // The keyword comparison intentionally uses FTS alone.
        results = await this.engine.searchKeyword(query, { limit, sourceIds });
      } else {
        // gbrain's real retrieval path (vector + keyword + RRF). Disable
        // cache reuse so one scope cannot inherit another scope's result.
        results = await hybridSearch(this.engine, query, {
          limit,
          sourceIds,
          expansion: false,
          useCache: false,
          ...this.extraHybridOpts,
          onMeta: (meta) => { searchMeta = meta; },
          onRelationalMeta: meta => { relationalMeta = meta; },
        });
      }
    } catch (err) {
      error = err;
      throw err;
    } finally {
      observation = {
        ...searchObservation({
          query, mode: this.mode, results, meta: searchMeta, relationalMeta, error,
          requireReranker: this.requireReranker,
          expectedExpansion: this.extraHybridOpts.expansion === undefined ? false : undefined,
        }),
        scope: opts?.scope, ranked_ids: results.map(r => r.slug), kept_ids: [],
      };
      this.observations.push(observation);
    }

    // Dedup by slug, preserve gbrain's final ranked order, drop excludeIds.
    // Gap score is the ordering-driving value: rerank_score when reranked,
    // else score (reranker is off in the default bench config, so score is
    // authoritative here — see codex score-scale finding).
    const seen = new Set<string>();
    const scored: Scored[] = [];
    for (const r of results) {
      const beliefId = r.slug;
      if (!beliefId || seen.has(beliefId)) continue;
      seen.add(beliefId);
      if (opts?.excludeIds?.has(beliefId)) continue;
      if (!this.seedIndex.has(beliefId)) continue;
      const s = (r as unknown as { rerank_score?: number }).rerank_score ?? r.score;
      scored.push({ id: beliefId, score: typeof s === 'number' ? s : 0 });
    }

    // Resolve intent-aware policy to a concrete sub-policy (A1: intent is the
    // prior, the sub-policy does the sizing).
    let effective: ReturnPolicy;
    if (this.returnPolicy.kind === 'intent') {
      const intent = classifyQueryIntent(query);
      effective = intent === 'entity' ? this.returnPolicy.single : this.returnPolicy.multi;
    } else {
      effective = this.returnPolicy;
    }

    const { kept } = applyReturnPolicy(scored, effective);
    observation.kept_ids = kept.map(k => k.id);
    if (this.onScores) {
      this.onScores({
        query,
        scope: opts?.scope,
        scores: scored.map((s) => s.score),
        keptIds: kept.map((k) => k.id),
      });
    }

    const out: Belief[] = [];
    for (const k of kept) {
      const belief = this.seedIndex.get(k.id);
      if (belief) out.push(belief);
    }
    return out;
  }
}
