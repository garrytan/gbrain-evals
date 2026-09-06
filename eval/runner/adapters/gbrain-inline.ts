/**
 * Shared inline gbrain adapter — the full gbrain pipeline (import + extract
 * + hybridSearch) wrapped in the BrainBench Adapter interface.
 *
 * This was duplicated verbatim inside cat13-conceptual.ts and
 * cat13b-source-swamp.ts, and BOTH copies crashed on init under gbrain
 * v0.40+ because neither called configureGateway before importFromContent's
 * inline embed (audit findings retrieval-cats-01/02: "the default full run
 * throws before any adapter scores"). One module, one gateway setup, no
 * drift.
 *
 * WS5 hook: `searchConfig` entries are engine.setConfig'd after initSchema
 * and echoed back via resolvedConfig() so receipts can prove which mode /
 * reranker state a cell actually ran with (a hidden default-mode reranker
 * confounded cat18/cat21 — never assume the default).
 *
 * Phase E2 hook: every query reads hybridSearch's `onMeta` and counts the
 * `keyword_arm_confidence` decision (stamped / down-weighted) into
 * observedStats(), so a `search.keyword_arm_confidence_floor` cell can prove
 * the knob reached the engine and how often it fired. `engineOf()` exposes
 * the engine for the calibration script (cat13-kacf-calibrate.ts), which
 * needs the raw keyword arm on the SAME brain the gbrain arm searches.
 */

import { PGLiteEngine } from 'gbrain/pglite-engine';
import { runExtract } from 'gbrain/extract';
import { hybridSearch } from 'gbrain/search/hybrid';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import type { HybridSearchMeta } from 'gbrain/types';
import type { Adapter, AdapterConfig, BrainState, Page, PublicQuery, RankedDoc } from '../types.ts';

export interface GbrainInlineOptions {
  /** Top-K page results returned per query. */
  topK: number;
  /** Run `extract links/timeline --source db` after import (graph features). Default true. */
  extract?: boolean;
  /** engine.setConfig entries applied before ingest (e.g. pin search.mode / reranker). */
  searchConfig?: Record<string, string>;
  /** Embedding model for the gateway. Defaults to the pre-v0.40 baseline behavior. */
  embeddingModel?: string;
  embeddingDimensions?: number;
}

/** Per-run observation counters, read back via observedStats() for receipts. */
export interface InlineObservedStats {
  /** Queries answered. */
  queries: number;
  /**
   * Queries whose hybridSearch result set carried a finite `rerank_score`.
   * gbrain's reranker is fail-open (a missing key silently measures plain
   * hybrid), so a reranker-pinned cell with 0 here did NOT measure reranking.
   */
  rerank_scored_queries: number;
  /** Queries whose hybridSearch meta carried `keyword_arm_confidence` (the fused path composed a decision). */
  keyword_arm_confidence_stamped: number;
  /** Queries where that decision was `downweighted: true` (keyword + title lists fused at half weight). */
  keyword_arm_confidence_downweighted: number;
}

interface InlineState {
  engine: PGLiteEngine;
  resolvedConfig: Record<string, string>;
  observed: InlineObservedStats;
}

export class GbrainInlineAdapter implements Adapter {
  readonly name: string;
  private opts: Required<Pick<GbrainInlineOptions, 'topK'>> & GbrainInlineOptions;

  constructor(opts: GbrainInlineOptions, name = 'gbrain') {
    this.name = name;
    this.opts = { extract: true, ...opts };
  }

  async init(rawPages: Page[], _config: AdapterConfig): Promise<BrainState> {
    // v0.40+ requires the gateway configured before any embed call —
    // importFromContent embeds inline and its failure PROPAGATES.
    configureGateway({
      embedding_model: this.opts.embeddingModel ?? 'openai:text-embedding-3-large',
      embedding_dimensions: this.opts.embeddingDimensions ?? 1536,
      env: process.env as Record<string, string | undefined>,
    });

    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    const resolvedConfig: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.opts.searchConfig ?? {})) {
      await engine.setConfig(key, value);
      resolvedConfig[key] = value;
    }

    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      for (const p of rawPages) {
        const fm: string[] = [
          `---`,
          `type: ${p.type}`,
          `title: ${JSON.stringify(p.title)}`,
          `---`,
          '',
          `# ${p.title}`,
          '',
          p.compiled_truth,
        ];
        if (p.timeline && p.timeline.trim().length > 0) {
          fm.push('', '## Timeline', '', p.timeline);
        }
        await importFromContent(engine, p.slug, fm.join('\n'));
      }
      if (this.opts.extract !== false) {
        await runExtract(engine, ['links', '--source', 'db']);
        await runExtract(engine, ['timeline', '--source', 'db']);
      }
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    return {
      engine,
      resolvedConfig,
      observed: { queries: 0, rerank_scored_queries: 0, keyword_arm_confidence_stamped: 0, keyword_arm_confidence_downweighted: 0 },
    } satisfies InlineState;
  }

  async query(q: PublicQuery, state: BrainState): Promise<RankedDoc[]> {
    const { engine, observed } = state as InlineState;
    let meta: HybridSearchMeta | undefined;
    const chunkResults = await hybridSearch(engine, q.text, { limit: this.opts.topK * 6, onMeta: (m) => { meta = m; } });
    observed.queries += 1;
    if (chunkResults.some(r => Number.isFinite(r.rerank_score))) observed.rerank_scored_queries += 1;
    const kacf = meta?.keyword_arm_confidence;
    if (kacf) {
      observed.keyword_arm_confidence_stamped += 1;
      if (kacf.downweighted) observed.keyword_arm_confidence_downweighted += 1;
    }
    // Chunk → page normalization: keep the best chunk score per page so
    // downstream metrics see page-grained, duplicate-free ids.
    const pageBest = new Map<string, number>();
    for (const r of chunkResults) {
      const existing = pageBest.get(r.slug);
      if (existing === undefined || r.score > existing) pageBest.set(r.slug, r.score);
    }
    return [...pageBest.entries()]
      .map(([slug, score]) => ({ slug, score }))
      .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
      .slice(0, this.opts.topK)
      .map((p, i) => ({ page_id: p.slug, score: p.score, rank: i + 1 }));
  }

  /** The setConfig entries this run actually applied — put these in the receipt. */
  resolvedConfig(state: BrainState): Record<string, string> {
    return (state as InlineState).resolvedConfig;
  }

  /** Query-time observations (rerank_score presence, keyword_arm_confidence counts) — the fail-closed checks for pinned cells. */
  observedStats(state: BrainState): InlineObservedStats {
    return { ...(state as InlineState).observed };
  }

  /** The live engine behind a BrainState — for calibration scripts that need the raw arms on the same brain. */
  engineOf(state: BrainState): PGLiteEngine {
    return (state as InlineState).engine;
  }

  async teardown(state: BrainState): Promise<void> {
    await (state as InlineState).engine.disconnect();
  }
}
