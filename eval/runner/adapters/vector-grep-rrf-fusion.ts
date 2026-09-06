/**
 * BrainBench EXT-3: Vector-Grep-RRF-Fusion-without-graph adapter.
 *
 * gbrain's full vector-grep-rrf-fusion search (vector + keyword + RRF fusion + dedup) but
 * with the knowledge-graph layer explicitly disabled. No auto_link, no
 * typed edges, no traverse_graph, no backlink boost. Just:
 *   - putPage each page
 *   - chunking + embedding (via existing put_page pipeline)
 *   - hybridSearch(engine, query) to answer queries
 *
 * This is the closest-to-gbrain external comparator. If gbrain beats
 * EXT-3 significantly, the delta MUST come from the graph layer (auto_link
 * typed edges + traversePaths + backlink boost), not from better vector
 * retrieval or vector-grep-rrf-fusion fusion.
 *
 * It's also the MOST HONEST baseline — "gbrain without the new knowledge
 * graph layer" answers the question "does the graph do useful work?"
 * directly. Critics can't dismiss this as "you disabled a feature you knew
 * they'd want." Everyone already knows vector+keyword vector-grep-rrf-fusion is strong.
 */

import type { Adapter, AdapterConfig, BrainState, Page, Query, RankedDoc } from '../types.ts';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { hybridSearch } from 'gbrain/search/hybrid';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { assertEvalAdapterConfig, type EvalAdapterConfig } from '../eval-adapter-config.ts';

// Known-safe config: auto_link OFF at the engine layer via direct setConfig
// call. Does NOT run `extract --source db`, so typed links stay empty even
// if auto_link flipped on during put_page (belt + suspenders).

interface HybridNoGraphState {
  engine: PGLiteEngine;
  /** Top-K resolved from HybridNoGraphConfig.limit at init (default 20).
   *  Stored in state so query() actually honors the knob — the old code
   *  documented the config field but hardcoded 20 in query(), so a caller
   *  passing { limit: 50 } silently got 20 (audit adapters-queries-04). */
  limit: number;
  /** Every engine.setConfig entry init() applied, last write wins (receipt echo). */
  resolvedConfig: Record<string, string>;
  observed: { queries: number; rerank_scored_queries: number };
}

interface HybridNoGraphConfig extends AdapterConfig {
  /** Top-K results requested from hybridSearch. Defaults to 20 so the
   *  scorer's k=5 slice has headroom. */
  limit?: number;
  /**
   * v0.35.1.0 embedder-shootout knob. When set, the adapter:
   *   - Calls configureGateway() with {embedding_model, embedding_dimensions}
   *     so embeds + hybridSearch route through the configured provider.
   *   - Threads reranker via engine.setConfig:
   *       search.reranker.enabled = (shootout.reranker is set)
   *       search.reranker.model   = shootout.reranker
   *   - Threads search.mode (default 'tokenmax' for the shootout).
   */
  shootout?: EvalAdapterConfig;
  /**
   * Explicit engine.setConfig pins applied AFTER the shootout block (so they
   * win) and before ingest — the same hook GbrainInlineAdapter exposes, so a
   * runner can pin search.mode / reranker / autocut identically on both
   * gbrain-backed arms and read them back via resolvedConfig().
   */
  searchConfig?: Record<string, string>;
}

export class HybridNoGraphAdapter implements Adapter {
  readonly name = 'vector-grep-rrf-fusion';

  async init(rawPages: Page[], _config: HybridNoGraphConfig): Promise<BrainState> {
    // Resolve the top-K knob up front. Invalid values (NaN, 0, negatives)
    // fall back to the documented default of 20.
    const limit = typeof _config.limit === 'number' && Number.isFinite(_config.limit) && _config.limit >= 1
      ? Math.floor(_config.limit)
      : 20;

    // v0.35.1.0 shootout: validate and apply the per-cell provider config
    // BEFORE spinning up the engine so configureGateway is in effect when
    // importFromContent first calls embed().
    if (_config.shootout) {
      assertEvalAdapterConfig(_config.shootout);
      configureGateway({
        embedding_model: _config.shootout.embedder,
        embedding_dimensions: _config.shootout.dim,
        reranker_model: _config.shootout.reranker,
        env: process.env as Record<string, string | undefined>,
      });
    } else {
      // v0.40+ requires the gateway to be explicitly configured before any
      // embed call. Default to gbrain's pre-v0.40 OpenAI-compatible behavior
      // so existing baseline scorecards stay reproducible.
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: 1536,
        env: process.env as Record<string, string | undefined>,
      });
    }

    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    // Every setConfig this init applies is recorded (last write wins) so the
    // receipt echoes what the engine actually ran with, not what was intended.
    const resolvedConfig: Record<string, string> = {};
    const pin = async (key: string, value: string): Promise<void> => {
      await engine.setConfig(key, value);
      resolvedConfig[key] = value;
    };
    // Belt: turn off auto_link at the engine config level. Suspenders below:
    // we also skip extract --source db, so even if auto_link did fire, no
    // typed edges would exist in the graph layer. This adapter doesn't call
    // traversePaths at all, so graph state is doubly-ignored.
    await pin('auto_link', 'false');

    // v0.35.1.0 shootout: thread reranker + search-lite mode through engine
    // config so hybridSearch picks them up via the normal resolution chain.
    if (_config.shootout) {
      const mode = _config.shootout.searchMode ?? 'tokenmax';
      await pin('search.mode', mode);
      if (_config.shootout.reranker) {
        await pin('search.reranker.enabled', 'true');
        await pin('search.reranker.model', _config.shootout.reranker);
      } else {
        // Explicit disable so the tokenmax mode bundle's default reranker=on
        // doesn't silently fire for "no-rerank" cells.
        await pin('search.reranker.enabled', 'false');
      }
    }

    // Explicit pins win over the shootout defaults above.
    for (const [key, value] of Object.entries(_config.searchConfig ?? {})) {
      await pin(key, value);
    }

    // importFromContent does the chunking + embedding that hybridSearch needs.
    // Plain putPage() just writes the page row without any search infra; that's
    // fine for graph-based adapters but leaves hybridSearch with nothing to
    // rank. Silence its stdout noise during benchmark runs.
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      for (const p of rawPages) {
        const content = this.buildContentMarkdown(p);
        await importFromContent(engine, p.slug, content);
      }
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    // INTENTIONALLY do NOT call runExtract — that's what populates typed
    // links + timeline for the graph layer. Without it, traversePaths
    // would return empty. hybridSearch works entirely off chunks +
    // embeddings, which importFromContent just populated.
    return {
      engine,
      limit,
      resolvedConfig,
      observed: { queries: 0, rerank_scored_queries: 0 },
    } satisfies HybridNoGraphState;
  }

  async teardown(state: BrainState): Promise<void> {
    const s = state as HybridNoGraphState;
    await s.engine.disconnect();
  }

  /** The setConfig entries init() actually applied — put these in the receipt. */
  resolvedConfig(state: BrainState): Record<string, string> {
    return { ...(state as HybridNoGraphState).resolvedConfig };
  }

  /** Query-time observations (rerank_score presence) — the fail-closed check for reranker-pinned cells. */
  observedStats(state: BrainState): { queries: number; rerank_scored_queries: number } {
    return { ...(state as HybridNoGraphState).observed };
  }

  /** Build a markdown string importFromContent can parse.
   *  Format: YAML frontmatter then body; matches what gbrain import expects. */
  private buildContentMarkdown(p: Page): string {
    const fm: string[] = [];
    fm.push(`---`);
    fm.push(`type: ${p.type}`);
    fm.push(`title: ${JSON.stringify(p.title)}`);
    fm.push(`---`);
    fm.push('');
    fm.push(`# ${p.title}`);
    fm.push('');
    fm.push(p.compiled_truth);
    if (p.timeline && p.timeline.trim().length > 0) {
      fm.push('');
      fm.push('## Timeline');
      fm.push('');
      fm.push(p.timeline);
    }
    return fm.join('\n');
  }

  async query(q: Query, state: BrainState): Promise<RankedDoc[]> {
    const s = state as HybridNoGraphState;
    const limit = s.limit;

    // hybridSearch returns chunks with scores. We aggregate to page-level
    // by taking each page's BEST chunk score and ranking pages by that.
    const chunkResults = await hybridSearch(s.engine, q.text, { limit: limit * 3 });
    s.observed.queries += 1;
    if (chunkResults.some(r => Number.isFinite(r.rerank_score))) s.observed.rerank_scored_queries += 1;

    const pageBest = new Map<string, number>();
    for (const r of chunkResults) {
      const existing = pageBest.get(r.slug);
      if (existing === undefined || r.score > existing) {
        pageBest.set(r.slug, r.score);
      }
    }
    const pageScored = Array.from(pageBest.entries())
      .map(([slug, score]) => ({ slug, score }))
      .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
      .slice(0, limit);

    return pageScored.map((p, i) => ({
      page_id: p.slug,
      score: p.score,
      rank: i + 1,
    }));
  }

  async snapshot(_state: BrainState): Promise<string> {
    return '';
  }
}

export function createHybridNoGraph(): HybridNoGraphAdapter {
  return new HybridNoGraphAdapter();
}
