/**
 * BrainBench Cat 18 — embedding-provider A/B on the synthetic-v1 corpus.
 *
 * Headline question: how do OpenAI, Voyage, and ZeroEntropy rank against
 * the same query set on the same corpus? Backs the v0.36.2.0 README claim
 * that ZeroEntropy beats OpenAI/Voyage on price + speed.
 *
 * Hermetic-ish (cheap-paid): embeds the synthetic-v1 corpus (164 pages,
 * ~150K chars) with each provider. ~$0.30 total ($0.05 ZE + $0.15 OpenAI +
 * $0.10 Voyage). Per-query cost is symmetric across providers.
 *
 * Metrics per cell: MRR (mean reciprocal rank), Recall@10, mean latency
 * per query embed.
 *
 * Run:
 *   bun eval/runner/cat18-embedding-providers.ts
 *   CAT18_PROVIDERS=openai,zeroentropy bun eval/runner/cat18-embedding-providers.ts
 */

import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
import { loadSyntheticV1, syntheticQueries } from './synthetic-corpus-loader.ts';

// Pre-flight: isolate GBRAIN_HOME so the user's ~/.gbrain/config.json
// embedding_model pin doesn't override the per-cell gateway/registry
// setup. The embedding-column registry reads file-plane cfg FIRST and
// falls back to gateway state; without this isolation, every cell
// inherits the user's real OpenAI pin and Voyage/ZE columns mis-resolve.
const ISOLATED_HOME = join(tmpdir(), `cat18-gbrain-home-${Date.now()}`);
mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.GBRAIN_HOME = ISOLATED_HOME;

interface ProviderCell {
  cell: string;
  embedder: string;
  dim: number;
  queries: number;
  total_relevant: number;
  found_relevant_at_10: number;
  mrr: number;
  recall_at_10: number;
  mean_query_ms: number;
  embed_ingest_ms: number;
}

interface Receipt {
  schema_version: 1;
  cat: 'cat18-embedding-providers';
  gbrain_version: string;
  timestamp: string;
  corpus: 'synthetic-v1';
  corpus_pages: number;
  queries: number;
  cells: ProviderCell[];
  best_by_mrr: string;
  best_by_recall: string;
}

const PROVIDERS_DEFAULT = ['openai', 'voyage', 'zeroentropy'];
const PROVIDERS = (process.env.CAT18_PROVIDERS ?? PROVIDERS_DEFAULT.join(',')).split(',');

function providerConfig(name: string): { embedder: string; dim: number } {
  switch (name) {
    case 'openai': return { embedder: 'openai:text-embedding-3-large', dim: 1536 };
    case 'voyage': return { embedder: 'voyage:voyage-3-large', dim: 1024 };
    case 'zeroentropy': return { embedder: 'zeroentropyai:zembed-1', dim: 1280 };
    default: throw new Error(`unknown provider: ${name}`);
  }
}

async function runProvider(name: string, pages: ReturnType<typeof loadSyntheticV1>, queries: ReturnType<typeof syntheticQueries>): Promise<ProviderCell> {
  const { embedder, dim } = providerConfig(name);
  // CRITICAL: configure gateway BEFORE engine.initSchema() so the schema
  // creates the `embedding` column with the right vector(N) dim. PGLite
  // engine reads dim via `getEmbeddingDimensions()` from the gateway at
  // initSchema time.
  configureGateway({
    embedding_model: embedder,
    embedding_dimensions: dim,
    env: process.env as Record<string, string | undefined>,
  });

  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const origLog = console.log;
  console.log = () => {};

  // Sanity check the resolved column dim
  try {
    const r = await engine.executeRaw(
      `SELECT atttypmod FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`,
      [],
    ) as any[];
    // pgvector stores dim in atttypmod - 4 (or directly; depending on PG version)
    const dimReported = r[0]?.atttypmod;
    process.stderr.write(`[cat18:${name}]   schema embedding col reported dim: ${dimReported} (expected ${dim})\n`);
  } catch (e: any) {
    process.stderr.write(`[cat18:${name}]   schema dim probe failed: ${e?.message}\n`);
  }

  // Ingest with embeddings
  const tIngest = Date.now();
  let ingestOk = 0;
  let ingestFail = 0;
  let firstErr: string | undefined;
  for (const p of pages) {
    try {
      await importFromContent(engine, p.slug, p.body, { noEmbed: false });
      ingestOk++;
    } catch (e: any) {
      ingestFail++;
      if (!firstErr) firstErr = e?.message ?? String(e);
    }
  }
  const ingestMs = Date.now() - tIngest;
  process.stderr.write(`[cat18:${name}]   ingest ok=${ingestOk} fail=${ingestFail}${firstErr ? ` firstErr=${firstErr.slice(0, 100)}` : ''}\n`);
  // Check chunk count + embedding fill
  const cc = await engine.executeRaw(
    `SELECT COUNT(*)::int AS total, COUNT(embedding)::int AS filled FROM content_chunks`,
    [],
  ) as any[];
  process.stderr.write(`[cat18:${name}]   chunks=${cc[0]?.total ?? 0}  embedded=${cc[0]?.filled ?? 0}\n`);

  // Run each query, capture rank of relevant slugs
  let mrrSum = 0;
  let foundRelAt10 = 0;
  let totalRelevant = 0;
  let queryMsTotal = 0;
  let queryCount = 0;
  let firstResultSample = '';
  for (const q of queries) {
    const t = Date.now();
    let results: any[] = [];
    try {
      results = await hybridSearch(engine, q.text, { limit: 10 } as any);
    } catch (e: any) {
      console.log = origLog;
      process.stderr.write(`[cat18:${name}]   query "${q.text.slice(0, 40)}" failed: ${e?.message}\n`);
      console.log = () => {};
      continue;
    }
    queryMsTotal += Date.now() - t;
    queryCount++;
    if (queryCount === 1) {
      firstResultSample = `query="${q.text.slice(0, 50)}" results=${results.length} top3=${results.slice(0, 3).map((r: any) => r.slug).join(',')} expected_one_of=${q.relevant_slugs.slice(0, 3).join(',')}`;
    }
    const relSet = new Set(q.relevant_slugs);
    totalRelevant += relSet.size;
    let bestRank = Infinity;
    for (let i = 0; i < results.length; i++) {
      const slug = results[i].slug;
      if (relSet.has(slug)) {
        bestRank = Math.min(bestRank, i + 1);
        foundRelAt10++;
      }
    }
    if (bestRank !== Infinity) mrrSum += 1 / bestRank;
  }
  if (firstResultSample) process.stderr.write(`[cat18:${name}]   debug q0: ${firstResultSample}\n`);
  console.log = origLog;
  await engine.disconnect();

  return {
    cell: name,
    embedder,
    dim,
    queries: queryCount,
    total_relevant: totalRelevant,
    found_relevant_at_10: foundRelAt10,
    mrr: queryCount > 0 ? mrrSum / queryCount : 0,
    recall_at_10: totalRelevant > 0 ? foundRelAt10 / totalRelevant : 0,
    mean_query_ms: queryCount > 0 ? queryMsTotal / queryCount : 0,
    embed_ingest_ms: ingestMs,
  };
}

async function main(): Promise<void> {
  const pages = loadSyntheticV1();
  const queries = syntheticQueries(pages);
  process.stderr.write(`[cat18] corpus: ${pages.length} pages, queries: ${queries.length}\n`);

  const cells: ProviderCell[] = [];
  for (const p of PROVIDERS) {
    process.stderr.write(`[cat18] provider=${p}...\n`);
    try {
      const cell = await runProvider(p, pages, queries);
      cells.push(cell);
      process.stderr.write(`[cat18]   ${p}: MRR=${cell.mrr.toFixed(3)} R@10=${(cell.recall_at_10 * 100).toFixed(1)}% q_ms=${cell.mean_query_ms.toFixed(0)} ingest_ms=${cell.embed_ingest_ms}\n`);
    } catch (e: any) {
      process.stderr.write(`[cat18]   ${p}: ERROR ${e?.message ?? e}\n`);
    }
  }

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const bestMrr = cells.reduce((a, b) => a.mrr >= b.mrr ? a : b, cells[0]);
  const bestRecall = cells.reduce((a, b) => a.recall_at_10 >= b.recall_at_10 ? a : b, cells[0]);

  const receipt: Receipt = {
    schema_version: 1,
    cat: 'cat18-embedding-providers',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    corpus: 'synthetic-v1',
    corpus_pages: pages.length,
    queries: queries.length,
    cells,
    best_by_mrr: bestMrr?.cell ?? 'n/a',
    best_by_recall: bestRecall?.cell ?? 'n/a',
  };

  const outDir = join(process.cwd(), 'eval/reports/cat18-embedding-providers');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat18.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat18] ─── Scorecard ───────────────────\n`);
  for (const c of cells) {
    process.stderr.write(`[cat18]   ${c.cell.padEnd(12)} MRR=${c.mrr.toFixed(3)}  R@10=${(c.recall_at_10 * 100).toFixed(1)}%  q_ms=${c.mean_query_ms.toFixed(0)}  ingest=${c.embed_ingest_ms}ms\n`);
  }
  process.stderr.write(`[cat18]   best MRR:     ${bestMrr?.cell}\n`);
  process.stderr.write(`[cat18]   best Recall:  ${bestRecall?.cell}\n`);
  process.stderr.write(`[cat18]   receipt:      ${outFile}\n`);
}

await main();
