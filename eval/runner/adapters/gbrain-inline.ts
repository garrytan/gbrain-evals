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
 */

import { PGLiteEngine } from 'gbrain/pglite-engine';
import { runExtract } from 'gbrain/extract';
import { hybridSearch } from 'gbrain/search/hybrid';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
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

interface InlineState {
  engine: PGLiteEngine;
  resolvedConfig: Record<string, string>;
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
    return { engine, resolvedConfig } satisfies InlineState;
  }

  async query(q: PublicQuery, state: BrainState): Promise<RankedDoc[]> {
    const { engine } = state as InlineState;
    const chunkResults = await hybridSearch(engine, q.text, { limit: this.opts.topK * 6 });
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

  async teardown(state: BrainState): Promise<void> {
    await (state as InlineState).engine.disconnect();
  }
}
