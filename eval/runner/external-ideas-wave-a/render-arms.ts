/**
 * External ideas wave A2 (GBRA-162): two eval-only rendering arms built from
 * the frozen product `auto` delivery, with no gbrain code change.
 *
 * - r1_rank_date: the same blocks, oldest observation date first (undated
 *   blocks last, in rank order), each labeled with its retrieval rank, under a
 *   one-line note (idea 5.4).
 * - r2_tail_trim: the top 3 blocks by rank kept untouched; a later block whose
 *   frozen hybrid hit score is below half of rank 1's is dropped, unless it
 *   holds an anchored match span of a kept chunk (idea 5.3, adapted to the
 *   top-5-hit depth of this delivery, where a top-5 guard would drop nothing).
 */
import type { Renderer } from '../evidence-delivery/arms.ts';
import { evidenceSha, type FrozenBlock, type FrozenQuestion } from '../evidence-delivery/store.ts';

export const RENDER_ARMS = ['r1_rank_date', 'r2_tail_trim'] as const;
export type RenderArm = typeof RENDER_ARMS[number];
export const isRenderArm = (arm: string): arm is RenderArm => (RENDER_ARMS as readonly string[]).includes(arm);

export const R1_NOTE = 'Blocks are in date order; rank shows retrieval relevance; a low-ranked block can still hold one item of a list or count.';
export const r1Label = (rank: number, total: number) => `[retrieval rank ${rank} of ${total}]`;
export const R2_PROTECTED = 3;
export const R2_SCORE_FRACTION = 0.5;
/** Used only when a question has no usable frozen score: blocks past this rank are dropped. */
export const R2_FALLBACK_RANK_CUT = 10;

export interface RankedBlock extends FrozenBlock { rank: number; date: string | null }

/** Blocks in delivery (rank) order, each with its rank and its page's observation date. */
export function rankedBlocks(q: Pick<FrozenQuestion, 'pages'>, blocks: FrozenBlock[]): RankedBlock[] {
  const dates = new Map(q.pages.map(p => [p.slug, p.date]));
  return blocks.map((b, i) => ({ ...b, rank: i + 1, date: dates.get(b.slug) ?? null }));
}

/** R1 order: dated blocks oldest first (ties by rank), then undated blocks in rank order. Dates are LongMemEval's sortable "YYYY/MM/DD (Day) HH:MM". */
export function r1Order(blocks: RankedBlock[]): RankedBlock[] {
  const dated = blocks.filter(b => b.date).sort((x, y) => (x.date! < y.date! ? -1 : x.date! > y.date! ? 1 : x.rank - y.rank));
  return [...dated, ...blocks.filter(b => !b.date)];
}

export interface DeliveredResult { slug: string; delivered?: { chunk_ids?: number[]; match_spans?: Array<{ chunk_id: number }> } }
export interface R2Trim {
  kept: RankedBlock[];
  dropped: Array<{ slug: string; rank: number; score: number | null }>;
  /** Blocks below the cut that were kept because they hold a match span of a kept chunk. */
  retained_by_span: number;
  score_source: 'hybrid_hit_score' | 'rank_fallback';
}

/** R2: protect the top 3; drop a later block scored below half of rank 1 (max frozen hybrid hit score per page). */
export function r2Trim(q: Pick<FrozenQuestion, 'hits5'>, blocks: RankedBlock[], results: DeliveredResult[]): R2Trim {
  const score = new Map<string, number>();
  for (const h of q.hits5) if (Number.isFinite(h.score)) score.set(h.slug, Math.max(score.get(h.slug) ?? -Infinity, h.score));
  const top = blocks.length ? score.get(blocks[0].slug) : undefined;
  const usable = top !== undefined && top > 0 && blocks.every(b => score.has(b.slug));
  const below = (b: RankedBlock) => (usable ? b.rank > R2_PROTECTED && score.get(b.slug)! < R2_SCORE_FRACTION * top! : b.rank > R2_FALLBACK_RANK_CUT);
  const candidates = new Set(blocks.filter(below).map(b => b.slug));
  const bySlug = new Map(results.map(r => [r.slug, r]));
  const keptChunks = new Set(blocks.filter(b => !candidates.has(b.slug)).flatMap(b => bySlug.get(b.slug)?.delivered?.chunk_ids ?? []));
  let retained = 0;
  for (const slug of [...candidates]) {
    const spans = bySlug.get(slug)?.delivered?.match_spans ?? [];
    if (spans.some(s => keptChunks.has(s.chunk_id))) { candidates.delete(slug); retained++; }
  }
  return {
    kept: blocks.filter(b => !candidates.has(b.slug)),
    dropped: blocks.filter(b => candidates.has(b.slug)).map(b => ({ slug: b.slug, rank: b.rank, score: score.get(b.slug) ?? null })),
    retained_by_span: retained,
    score_source: usable ? 'hybrid_hit_score' : 'rank_fallback',
  };
}

/** The renderer R1 reads through: the note line, then each block under its rank label. Session text and framing are the house renderer's. */
export function labeledRenderer(r: Renderer, rankBySession: Map<string, number>, total: number): Renderer {
  return {
    ...r,
    renderChatBlock: (sessions, o) => {
      const parts = sessions.map(s => ({ s, out: r.renderChatBlock([s], o) }));
      const body = parts.map(({ s, out }) => `${r1Label(rankBySession.get(s.session_id)!, total)}\n${out.rendered}`).join('\n\n');
      return { rendered: `${R1_NOTE}\n\n${body}`, truncatedCount: parts.reduce((n, p) => n + p.out.truncatedCount, 0) };
    },
  };
}

export interface RenderView { blocks: FrozenBlock[]; renderer: Renderer; evidence_sha256: string; r2: R2Trim | null }

/** A render arm's blocks and renderer, derived only from the frozen auto delivery. */
export function renderView(q: FrozenQuestion, arm: RenderArm, store: { get(hash: string): string }, r: Renderer): RenderView {
  const auto = q.arms.auto;
  if (!auto) throw new Error(`${q.question_id} has no frozen auto delivery`);
  const ranked = rankedBlocks(q, auto.blocks);
  if (arm === 'r1_rank_date') {
    const ordered = r1Order(ranked);
    const ranks = new Map(ranked.map(b => [r.sessionIdFromSlug(b.slug), b.rank]));
    const blocks = ordered.map(({ slug, text }) => ({ slug, text }));
    return { blocks, renderer: labeledRenderer(r, ranks, ranked.length), evidence_sha256: evidenceSha(blocks), r2: null };
  }
  const results = auto.results ? JSON.parse(store.get(auto.results)) as DeliveredResult[] : [];
  const trim = r2Trim(q, ranked, results);
  const blocks = trim.kept.map(({ slug, text }) => ({ slug, text }));
  return { blocks, renderer: r, evidence_sha256: evidenceSha(blocks), r2: trim };
}
