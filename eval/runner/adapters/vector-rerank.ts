/**
 * Vector-only RAG plus the reranker gbrain uses (September 28 audit, B2).
 *
 * The concept comparison had gbrain with and without a reranker, but vectors
 * only without one, so the like-for-like reranked comparison was missing.
 * This adapter ranks pages exactly like VectorOnlyAdapter (one embedding per
 * page, cosine similarity), then sends the top pages through gbrain's own
 * `applyReranker` (src/core/search/rerank.ts): the same code path, the same
 * document cap, the same head-reranked / tail-appended ordering, with the
 * model, input depth and timeout of gbrain's `balanced` search mode unless
 * overridden. The document text is what the vector arm embedded (title,
 * compiled truth and timeline, capped at 8,000 characters before
 * `capRerankDoc`); gbrain's own arm reranks the matched chunk of each result
 * instead, a difference reported with the results.
 *
 * Every query records whether the reranker actually scored it. A skip (no
 * key), a provider failure or a pass-through is counted, and Cat 13 treats
 * any of them as a harness error on the whole arm, never a quiet
 * "reranked" row.
 */
import type { BrainState, Page, Query, RankedDoc } from '../types.ts';
import { VectorOnlyAdapter } from './vector.ts';
import { importGbrain, resolveGbrainUnderTest } from '../gbrain-under-test.ts';
import type { ObservedStats } from '../cat13-conceptual.ts';

type SearchResultLike = { slug: string; page_id: number; title: string; chunk_text: string; score: number; rerank_score?: number };
type ApplyReranker = (query: string, results: SearchResultLike[], opts: {
  enabled: boolean; topNIn: number; topNOut: number | null; model?: string; timeoutMs?: number;
  onSkip?: (reason: string) => void; onFailure?: (reason: string) => void; onPassThrough?: (reason: string) => void;
}) => Promise<SearchResultLike[]>;

export interface VectorRerankSettings { model: string; topNIn: number; timeoutMs: number }

interface VectorRerankState {
  inner: BrainState;
  text: Map<string, string>;
  applyReranker: ApplyReranker;
  settings: VectorRerankSettings;
  observed: ObservedStats & { rerank_failures: Array<{ query_id: string; reasons: string[] }> };
}

const MAX_CHARS = 8000;

export class VectorRerankAdapter {
  readonly name = 'vector-rerank';
  private vector = new VectorOnlyAdapter();

  constructor(private override: Partial<VectorRerankSettings> = {}) {}

  async init(rawPages: Page[], config: Parameters<VectorOnlyAdapter['init']>[1]): Promise<BrainState> {
    const inner = await this.vector.init(rawPages, config);
    const gut = resolveGbrainUnderTest(null);
    const { applyReranker } = await importGbrain<{ applyReranker: ApplyReranker }>(gut, 'src/core/search/rerank.ts');
    const { MODE_BUNDLES } = await importGbrain<{ MODE_BUNDLES: Record<string, { reranker_model: string; reranker_top_n_in: number; reranker_timeout_ms: number }> }>(gut, 'src/core/search/mode.ts');
    const balanced = MODE_BUNDLES.balanced;
    const settings: VectorRerankSettings = {
      model: this.override.model ?? balanced.reranker_model,
      topNIn: this.override.topNIn ?? balanced.reranker_top_n_in,
      timeoutMs: this.override.timeoutMs ?? balanced.reranker_timeout_ms,
    };
    const text = new Map(rawPages.map(p => [p.slug, `${p.title}\n\n${p.compiled_truth}\n\n${p.timeline}`.slice(0, MAX_CHARS)]));
    return { inner, text, applyReranker, settings, observed: { queries: 0, rerank_scored_queries: 0, rerank_failed_queries: 0, rerank_failures: [] } } satisfies VectorRerankState;
  }

  async query(q: Query, state: BrainState): Promise<RankedDoc[]> {
    const s = state as VectorRerankState;
    const ranked = await this.vector.query(q, s.inner);
    const candidates: SearchResultLike[] = ranked.map((r, i) => ({ slug: r.page_id, page_id: i, title: r.page_id, chunk_text: s.text.get(r.page_id) ?? '', score: r.score }));
    const reasons: string[] = [];
    const out = await s.applyReranker(q.text, candidates, {
      enabled: true, topNIn: s.settings.topNIn, topNOut: null, model: s.settings.model, timeoutMs: s.settings.timeoutMs,
      onSkip: r => reasons.push(`skipped:${r}`), onFailure: r => reasons.push(`failed:${r}`), onPassThrough: r => reasons.push(`passthrough:${r}`),
    });
    s.observed.queries += 1;
    const scored = out.slice(0, Math.min(s.settings.topNIn, out.length)).every(r => typeof r.rerank_score === 'number');
    if (scored && reasons.length === 0) s.observed.rerank_scored_queries += 1;
    else {
      s.observed.rerank_failed_queries = (s.observed.rerank_failed_queries ?? 0) + 1;
      s.observed.rerank_failures.push({ query_id: q.id, reasons: reasons.length ? reasons : ['unscored head'] });
    }
    return out.map((r, i) => ({ page_id: r.slug, score: r.rerank_score ?? r.score, rank: i + 1 }));
  }

  observedStats(state: unknown): ObservedStats {
    return (state as VectorRerankState).observed;
  }

  resolvedConfig(state: unknown): Record<string, string> {
    const { settings } = state as VectorRerankState;
    return { reranker_model: settings.model, reranker_top_n_in: String(settings.topNIn), reranker_timeout_ms: String(settings.timeoutMs), rerank_document: 'title + compiled_truth + timeline (first 8000 chars), then gbrain capRerankDoc' };
  }

  async snapshot(): Promise<string> {
    return '';
  }
}
