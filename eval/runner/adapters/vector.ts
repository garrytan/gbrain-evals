/**
 * BrainBench EXT-2: Vector-only RAG adapter.
 *
 * Commodity vector RAG: embed every page once, embed the query, rank by
 * cosine similarity. No graph, no keyword fallback, no Grep-only — the opposite
 * end of the baseline spectrum from EXT-1.
 *
 * Uses the SAME embedding model gbrain uses internally (text-embedding-3-large
 * via src/core/embedding.ts). Apples-to-apples on the embedding layer: any
 * lead gbrain has over vector must come from the graph + vector-grep-rrf-fusion fusion,
 * not from a better embedder. This is the honest external comparator.
 *
 * Cost: ~$0.02 per run on the 240-page corpus (embed 240 pages once, embed
 * each query once, ~120K total tokens at $0.13/M).
 *
 * Design:
 *   1. init(): embed each page's title + compiled_truth + timeline as ONE
 *              vector per page. Store in memory.
 *   2. query(): embed query text, compute cosine similarity against every
 *               page vector, rank descending.
 *
 * Notes:
 *   - No chunking. One vector per page. Real vector RAG in production
 *     chunks long docs; we intentionally don't here so the comparison
 *     against gbrain's chunked vector-grep-rrf-fusion is fair at the retrieval granularity.
 *     If a future BrainBench iteration wants to test chunked vector RAG,
 *     that's a separate adapter (EXT-2b maybe).
 *   - No keyword fallback. Pure vector similarity. An agent that wanted
 *     vector+keyword would use EXT-3 vector-grep-rrf-fusion-without-graph.
 */

import type { Adapter, AdapterConfig, BrainState, Page, Query, RankedDoc } from '../types.ts';
import { embed, embedBatch } from 'gbrain/embedding';
import { configureGateway } from 'gbrain/ai/gateway';
import { assertEvalAdapterConfig, type EvalAdapterConfig } from '../eval-adapter-config.ts';

// ─── Vector math ────────────────────────────────────────────────────

/**
 * Cosine similarity between two dense vectors. Assumes equal length;
 * callers upstream ensure embedder returned consistent-dim vectors.
 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Adapter state ──────────────────────────────────────────────────

interface VectorOnlyState {
  /** docId -> its embedding vector. */
  vectors: Map<string, Float32Array>;
  /** docId -> original Page. */
  docs: Map<string, Page>;
  /** Embedding model used (for scorecard reproducibility card). */
  embeddingModel: string;
}

// ─── Adapter implementation ────────────────────────────────────────

interface VectorOnlyConfig extends AdapterConfig {
  /** Chunk size in chars for page content sent to embedder.
   *  Default: unchunked (single vector per page). Capped at 8K chars
   *  to stay within embedding model input limits. */
  maxChars?: number;
  /** Max parallel embedding requests during init (the embedBatch helper
   *  chunks internally; this throttles if upstream rate-limits). */
  batchSize?: number;
  /**
   * v0.35.1.0 embedder-shootout knob. When set, the adapter calls
   * configureGateway() at the top of init() so every downstream embed
   * call routes through the configured (provider, model, dim) tuple
   * instead of the OpenAI defaults baked into gbrain/embedding's
   * re-exports.
   */
  shootout?: EvalAdapterConfig;
}

export class VectorOnlyAdapter implements Adapter {
  readonly name = 'vector';

  async init(rawPages: Page[], config: VectorOnlyConfig): Promise<BrainState> {
    const maxChars = config.maxChars ?? 8000;
    const batchSize = config.batchSize ?? 50;

    // v0.35.1.0: per-cell embedder swap. Fail-loud at init time so a typo
    // in {embedder, dim, reranker} surfaces BEFORE we embed 240 pages.
    if (config.shootout) {
      assertEvalAdapterConfig(config.shootout);
      configureGateway({
        embedding_model: config.shootout.embedder,
        embedding_dimensions: config.shootout.dim,
        env: process.env as Record<string, string | undefined>,
      });
    } else {
      // v0.40+ requires explicit gateway configuration. Default to OpenAI
      // text-embedding-3-large so the EXT-2 baseline keeps its historical
      // shape.
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: 1536,
        env: process.env as Record<string, string | undefined>,
      });
    }

    const docs = new Map<string, Page>();
    const contents: string[] = [];
    const slugOrder: string[] = [];
    for (const p of rawPages) {
      docs.set(p.slug, p);
      const combined = `${p.title}\n\n${p.compiled_truth}\n\n${p.timeline}`
        .slice(0, maxChars);
      contents.push(combined);
      slugOrder.push(p.slug);
    }

    // Embed in batches to respect rate limits. embedBatch handles the
    // OpenAI API call pattern (retry + backoff) per src/core/embedding.ts.
    const vectors = new Map<string, Float32Array>();
    for (let i = 0; i < contents.length; i += batchSize) {
      const batch = contents.slice(i, i + batchSize);
      const slugs = slugOrder.slice(i, i + batchSize);
      const embeddings = await embedBatch(batch);
      for (let j = 0; j < embeddings.length; j++) {
        vectors.set(slugs[j], embeddings[j]);
      }
    }

    // Embedder identity for the receipt:
    //   - shootout mode: prefer the explicitly-configured embedder string.
    //   - default mode: fall back to gbrain's EMBEDDING_MODEL constant.
    let embeddingModel: string;
    if (config.shootout) {
      embeddingModel = config.shootout.embedder;
    } else {
      const { EMBEDDING_MODEL } = await import('gbrain/embedding');
      embeddingModel = EMBEDDING_MODEL;
    }
    return {
      vectors,
      docs,
      embeddingModel,
    } satisfies VectorOnlyState;
  }

  async query(q: Query, state: BrainState): Promise<RankedDoc[]> {
    const s = state as VectorOnlyState;
    const queryVec = await embed(q.text);

    const scored: { id: string; score: number }[] = [];
    for (const [docId, docVec] of s.vectors) {
      const sim = cosine(queryVec, docVec);
      if (sim > 0) scored.push({ id: docId, score: sim });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    return scored.map((s, i) => ({
      page_id: s.id,
      score: s.score,
      rank: i + 1,
    }));
  }

  async snapshot(_state: BrainState): Promise<string> {
    // Vector state is in-memory only for v1.1. Persisted vector DBs are
    // a separate future comparison (EXT-2b).
    return '';
  }
}

export function createVectorOnly(): VectorOnlyAdapter {
  return new VectorOnlyAdapter();
}

/**
 * Test helper: cosine similarity exposed for unit tests. Not for public API.
 * @internal
 */
export { cosine as _cosine };
