/**
 * BrainBench Cat 18b — embedding × reranker matrix on synthetic-v1.
 *
 * Fair-shake test of every provider in its INTENDED production configuration:
 *
 *   - OpenAI text-embedding-3-large @ 1536d  ± zerank-2 reranker
 *   - Voyage voyage-3-large       @ 1024d  ± zerank-2 reranker
 *   - ZeroEntropy zembed-1        @ 2560d  ± zerank-2 reranker  ← full Matryoshka
 *
 * Cat 18 (parent) ran the no-reranker baseline. Cat 18b adds zerank-2 on
 * top of each so the comparison reflects how gbrain v0.36.2+ ACTUALLY runs
 * by default. ZE's published claim ("reshuffles 60% of top-1 when used as
 * a second-pass reranker") only shows up when the rerank stage is active.
 *
 * Also reports cost + speed: per-1M-token ingest cost, per-query latency,
 * ingest wallclock — where ZE typically wins regardless of recall.
 *
 * Cost: ~$1.50 total (3 providers × ~$0.30 embed + 3 rerank passes × ~$0.10).
 *
 * Run:
 *   bun eval/runner/cat18b-embedding-rerank-matrix.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
import { loadSyntheticV1, syntheticQueries } from './synthetic-corpus-loader.ts';

// Isolate GBRAIN_HOME (registry-resolution fix from Cat 18 parent).
const ISOLATED_HOME = join(tmpdir(), `cat18b-gbrain-home-${Date.now()}`);
mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.GBRAIN_HOME = ISOLATED_HOME;

// Per-MTok pricing (USD) — sourced from each provider's public pricing page.
const PRICING = {
  'openai:text-embedding-3-large': 0.13,
  'voyage:voyage-3-large': 0.18,
  'zeroentropyai:zembed-1': 0.05,
} as const;

interface Cell {
  cell: string;
  embedder: string;
  embed_dim: number;
  reranker: string | null;
  mrr: number;
  recall_at_10: number;
  top1_hit_rate: number;
  mean_query_ms: number;
  ingest_ms: number;
  embed_cost_per_mtok: number;
  est_corpus_cost_usd: number;
}

interface Receipt {
  schema_version: 1;
  cat: 'cat18b-embedding-rerank-matrix';
  gbrain_version: string;
  timestamp: string;
  corpus: 'synthetic-v1';
  corpus_pages: number;
  total_chars: number;
  queries: number;
  cells: Cell[];
  winner_by_axis: {
    recall_at_10: string;
    mrr: string;
    top1: string;
    fastest_ingest: string;
    fastest_query: string;
    cheapest: string;
  };
}

interface ProviderSpec {
  name: string;
  embedder: string;
  embed_dim: number;
  reranker: string | null;
}

const CELLS: ProviderSpec[] = [
  { name: 'openai-1536',           embedder: 'openai:text-embedding-3-large', embed_dim: 1536, reranker: null },
  { name: 'openai-1536+rerank',    embedder: 'openai:text-embedding-3-large', embed_dim: 1536, reranker: 'zeroentropyai:zerank-2' },
  { name: 'voyage-1024',           embedder: 'voyage:voyage-3-large',         embed_dim: 1024, reranker: null },
  { name: 'voyage-1024+rerank',    embedder: 'voyage:voyage-3-large',         embed_dim: 1024, reranker: 'zeroentropyai:zerank-2' },
  { name: 'ze-2560',               embedder: 'zeroentropyai:zembed-1',        embed_dim: 2560, reranker: null },
  { name: 'ze-2560+rerank',        embedder: 'zeroentropyai:zembed-1',        embed_dim: 2560, reranker: 'zeroentropyai:zerank-2' },
];

async function runCell(spec: ProviderSpec, pages: ReturnType<typeof loadSyntheticV1>, queries: ReturnType<typeof syntheticQueries>): Promise<Cell> {
  configureGateway({
    embedding_model: spec.embedder,
    embedding_dimensions: spec.embed_dim,
    reranker_model: spec.reranker ?? undefined,
    env: process.env as Record<string, string | undefined>,
  });

  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const origLog = console.log;
  console.log = () => {};

  // Enable search_lite + reranker via DB config if reranker is set
  if (spec.reranker) {
    await engine.setConfig('search.mode', 'tokenmax');
    await engine.setConfig('search.reranker.enabled', 'true');
    await engine.setConfig('search.reranker.model', spec.reranker);
  } else {
    await engine.setConfig('search.mode', 'balanced');
    await engine.setConfig('search.reranker.enabled', 'false');
  }

  const tIngest = Date.now();
  let totalChars = 0;
  for (const p of pages) {
    totalChars += p.body.length;
    try { await importFromContent(engine, p.slug, p.body, { noEmbed: false }); }
    catch { /* skip */ }
  }
  const ingestMs = Date.now() - tIngest;

  let queryMs = 0;
  let top1 = 0;
  let mrrSum = 0;
  let foundAt10 = 0;
  let totalRelevant = 0;
  let queryCount = 0;
  for (const q of queries) {
    const t = Date.now();
    let results: any[] = [];
    try {
      results = await hybridSearch(engine, q.text, { limit: 10 } as any);
    } catch { /* skip */ }
    queryMs += Date.now() - t;
    queryCount++;
    const relSet = new Set(q.relevant_slugs);
    totalRelevant += relSet.size;
    let bestRank = Infinity;
    for (let i = 0; i < results.length; i++) {
      if (relSet.has(results[i].slug)) {
        bestRank = Math.min(bestRank, i + 1);
        foundAt10++;
      }
    }
    if (bestRank === 1) top1++;
    if (bestRank !== Infinity) mrrSum += 1 / bestRank;
  }
  console.log = origLog;
  await engine.disconnect();

  const pricePerMTok = (PRICING as any)[spec.embedder] ?? 0;
  // Rough char-to-token (3.5 chars/token average over English+code)
  const estTokens = totalChars / 3.5;
  const estCost = (estTokens / 1_000_000) * pricePerMTok;

  return {
    cell: spec.name,
    embedder: spec.embedder,
    embed_dim: spec.embed_dim,
    reranker: spec.reranker,
    mrr: queryCount > 0 ? mrrSum / queryCount : 0,
    recall_at_10: totalRelevant > 0 ? foundAt10 / totalRelevant : 0,
    top1_hit_rate: queryCount > 0 ? top1 / queryCount : 0,
    mean_query_ms: queryCount > 0 ? queryMs / queryCount : 0,
    ingest_ms: ingestMs,
    embed_cost_per_mtok: pricePerMTok,
    est_corpus_cost_usd: estCost,
  };
}

async function main(): Promise<void> {
  const pages = loadSyntheticV1();
  const queries = syntheticQueries(pages);
  const totalChars = pages.reduce((a, p) => a + p.body.length, 0);
  process.stderr.write(`[cat18b] corpus: ${pages.length} pages, ${totalChars} chars (~${Math.round(totalChars / 3.5).toLocaleString()} tokens), queries: ${queries.length}\n`);

  const cells: Cell[] = [];
  for (const spec of CELLS) {
    process.stderr.write(`[cat18b] cell=${spec.name}...\n`);
    try {
      const c = await runCell(spec, pages, queries);
      cells.push(c);
      process.stderr.write(`[cat18b]   ${spec.name.padEnd(28)} MRR=${c.mrr.toFixed(3)}  R@10=${(c.recall_at_10 * 100).toFixed(1)}%  top1=${(c.top1_hit_rate * 100).toFixed(1)}%  q_ms=${c.mean_query_ms.toFixed(0)}  ingest=${c.ingest_ms}ms  cost=$${c.est_corpus_cost_usd.toFixed(4)}\n`);
    } catch (e: any) {
      process.stderr.write(`[cat18b]   ${spec.name}: ERROR ${e?.message ?? e}\n`);
    }
  }

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const bestBy = (key: keyof Cell, dir: 'max' | 'min'): string => {
    if (cells.length === 0) return 'n/a';
    return cells.reduce((a, b) => {
      const va = a[key] as number;
      const vb = b[key] as number;
      return dir === 'max' ? (va >= vb ? a : b) : (va <= vb ? a : b);
    }).cell;
  };

  const winner = {
    recall_at_10: bestBy('recall_at_10', 'max'),
    mrr: bestBy('mrr', 'max'),
    top1: bestBy('top1_hit_rate', 'max'),
    fastest_ingest: bestBy('ingest_ms', 'min'),
    fastest_query: bestBy('mean_query_ms', 'min'),
    cheapest: bestBy('est_corpus_cost_usd', 'min'),
  };

  const receipt: Receipt = {
    schema_version: 1,
    cat: 'cat18b-embedding-rerank-matrix',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    corpus: 'synthetic-v1',
    corpus_pages: pages.length,
    total_chars: totalChars,
    queries: queries.length,
    cells,
    winner_by_axis: winner,
  };

  const outDir = join(process.cwd(), 'eval/reports/cat18b-embedding-rerank-matrix');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat18b.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat18b] ─── Scorecard ───────────────────\n`);
  process.stderr.write(`[cat18b]   cell                          MRR    R@10   top1    q_ms  ingest_ms  cost\n`);
  for (const c of cells) {
    process.stderr.write(`[cat18b]   ${c.cell.padEnd(28)} ${c.mrr.toFixed(3)}  ${(c.recall_at_10 * 100).toFixed(1)}%  ${(c.top1_hit_rate * 100).toFixed(1)}%  ${String(c.mean_query_ms.toFixed(0)).padStart(5)}  ${String(c.ingest_ms).padStart(7)}  $${c.est_corpus_cost_usd.toFixed(4)}\n`);
  }
  process.stderr.write(`\n[cat18b]   Winners by axis:\n`);
  process.stderr.write(`[cat18b]     R@10:           ${winner.recall_at_10}\n`);
  process.stderr.write(`[cat18b]     MRR:            ${winner.mrr}\n`);
  process.stderr.write(`[cat18b]     top-1:          ${winner.top1}\n`);
  process.stderr.write(`[cat18b]     fastest ingest: ${winner.fastest_ingest}\n`);
  process.stderr.write(`[cat18b]     fastest query:  ${winner.fastest_query}\n`);
  process.stderr.write(`[cat18b]     cheapest embed: ${winner.cheapest}\n`);
  process.stderr.write(`[cat18b]   receipt:           ${outFile}\n`);
}

await main();
