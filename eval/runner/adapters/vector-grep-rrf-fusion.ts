/**
 * BrainBench EXT-3: Vector-Grep-RRF-Fusion-without-graph adapter.
 *
 * Import and embed each page, then call the product's hybrid search. This
 * adapter disables auto_link and skips the separate extraction pass.
 *
 * The historical name is broader than the actual control: this does not
 * disable every graph-related search stage. Import can retain link metadata,
 * and this adapter's retrieval pool also differs from GbrainInlineAdapter's.
 * Treat its score as a comparison of these complete configurations. Use
 * relational-ab.ts to isolate the relational-retrieval switch on one index.
 */

import type { Adapter, AdapterConfig, BrainState, Page, Query, RankedDoc } from '../types.ts';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { hybridSearch } from 'gbrain/search/hybrid';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import type { HybridSearchMeta, SearchResult } from 'gbrain/types';
import { assertEvalAdapterConfig, type EvalAdapterConfig } from '../eval-adapter-config.ts';
import { gcNow } from './gbrain-inline.ts';
import { pagesInResultOrder } from './page-results.ts';
import { recordSearchObservation, searchObservation, type SearchObservedStats } from '../retrieval-pins.ts';

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
  observed: HybridNoGraphObserved;
}

/** Per-run observation counters (receipt echo; same shape as GbrainInlineAdapter's). */
export interface HybridNoGraphObserved extends SearchObservedStats {
  queries: number;
  rerank_scored_queries: number;
  /** Present only when the product reports a reranker fallback. */
  rerank_failed_queries?: number;
  rerank_failures?: Array<{ query_id: string; reasons: string[] }>;
  /** Phase E2: queries whose hybridSearch meta carried `keyword_arm_confidence`. */
  keyword_arm_confidence_stamped: number;
  /** Phase E2: queries where the keyword + title lists fused at half weight. */
  keyword_arm_confidence_downweighted: number;
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
    // Disable automatic linking and skip the extraction pass below.
    // The product's own search stages remain enabled unless explicitly pinned.
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
      let imported = 0;
      for (const p of rawPages) {
        const content = this.buildContentMarkdown(p);
        await importFromContent(engine, p.slug, content);
        // Same GC pacing as GbrainInlineAdapter: one PGLite brain inflates JSC's
        // collection trigger, so unpaced import garbage fragments the address space.
        if (++imported % 40 === 0) gcNow();
      }
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    // Skip the separate link/timeline extraction pass. Import's chunks,
    // embeddings, and any link metadata it retained remain available to search.
    return {
      engine,
      limit,
      resolvedConfig,
      observed: { queries: 0, rerank_scored_queries: 0, keyword_arm_confidence_stamped: 0, keyword_arm_confidence_downweighted: 0 },
    } satisfies HybridNoGraphState;
  }

  async teardown(state: BrainState): Promise<void> {
    const s = state as HybridNoGraphState;
    await s.engine.disconnect();
    // PGlite finalizes close one microtask later; yield, then return the
    // ~1 GB WebAssembly memory before the next brain is built.
    await new Promise<void>(r => setTimeout(r, 0));
    gcNow();
  }

  /** The setConfig entries init() actually applied — put these in the receipt. */
  resolvedConfig(state: BrainState): Record<string, string> {
    return { ...(state as HybridNoGraphState).resolvedConfig };
  }

  /** Query-time observations (rerank_score presence, keyword_arm_confidence counts) — the fail-closed checks for pinned cells. */
  observedStats(state: BrainState): HybridNoGraphObserved {
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

    // Preserve product ranking when collapsing chunks to pages. Scores can
    // describe the pre-rerank order and must not override the returned order.
    let meta: HybridSearchMeta | undefined;
    let relationalMeta: unknown;
    let chunkResults: SearchResult[] = [];
    let error: unknown;
    try {
      chunkResults = await hybridSearch(s.engine, q.text, {
        limit: limit * 3, onMeta: m => { meta = m; },
        onRelationalMeta: m => { relationalMeta = m; },
      });
    } catch (err) {
      error = err;
      throw err;
    } finally {
      recordSearchObservation(s.observed, searchObservation({
        query: q.text, queryId: q.id, results: chunkResults, meta, relationalMeta, error,
        expectedReranker: s.resolvedConfig['search.reranker.enabled'] === undefined ? undefined : s.resolvedConfig['search.reranker.enabled'] === 'true',
        expectedExpansion: s.resolvedConfig['search.expansion'] === undefined ? undefined : s.resolvedConfig['search.expansion'] === 'true',
      }));
    }

    return pagesInResultOrder(chunkResults, limit);
  }

  async snapshot(_state: BrainState): Promise<string> {
    return '';
  }
}

export function createHybridNoGraph(): HybridNoGraphAdapter {
  return new HybridNoGraphAdapter();
}
