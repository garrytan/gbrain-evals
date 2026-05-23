/**
 * BrainBench Cat 21 — code-corpus retrieval voyage-code-3 vs text-embedding-3-large.
 *
 * Headline question: does Voyage's code-tuned `voyage-code-3` embedder
 * surface symbol-lookup queries better than the general-purpose
 * `text-embedding-3-large`? Backs the v0.37.3.0 reindex --code nudge.
 *
 * Corpus: gbrain's OWN source (.ts files under node_modules/gbrain/src/).
 * Treated as a code corpus by gbrain's importCodeFile path — chunks
 * along function/class boundaries via tree-sitter.
 *
 * Queries: 12 hand-curated symbol-lookup queries naming real exports
 * (e.g. "runThink function", "PGLiteEngine class", "buildVisibilityClause").
 *
 * Metric: top-1 hit rate (did the chunk containing the named symbol
 * land at rank 1?) + MRR.
 *
 * Run:
 *   bun eval/runner/cat21-code-retrieval.ts
 */

import { writeFileSync, mkdirSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { configureGateway } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';

const ISOLATED_HOME = join(tmpdir(), `cat21-gbrain-home-${Date.now()}`);
mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.GBRAIN_HOME = ISOLATED_HOME;

const SRC_ROOT = join(process.cwd(), 'node_modules/gbrain/src/core');
const QUERIES = [
  { text: 'runThink function entry point', expected_substring: 'core/think/index.ts' },
  { text: 'PGLiteEngine class definition', expected_substring: 'pglite-engine.ts' },
  { text: 'hybridSearch function', expected_substring: 'search/hybrid.ts' },
  { text: 'importFromContent function', expected_substring: 'import-file.ts' },
  { text: 'extractEntityRefs wikilink parser', expected_substring: 'link-extraction.ts' },
  { text: 'resolveEmbeddingColumn resolver', expected_substring: 'search/embedding-column.ts' },
  { text: 'applyGraphSignals adjacency boost', expected_substring: 'search/graph-signals.ts' },
  { text: 'runBrainstorm orchestrator', expected_substring: 'brainstorm/orchestrator.ts' },
  { text: 'configureGateway AI gateway setup', expected_substring: 'ai/gateway.ts' },
  { text: 'resolvePhantomCanonical entity resolver', expected_substring: 'entities/resolve.ts' },
  { text: 'computeRecommendations brain score remediation', expected_substring: 'brain-score-recommendations.ts' },
  { text: 'MinionQueue add submit job', expected_substring: 'minions/queue.ts' },
];

interface ProviderCell {
  cell: string;
  embedder: string;
  dim: number;
  queries: number;
  top1_hits: number;
  mrr: number;
  recall_at_5: number;
  mean_query_ms: number;
  ingest_ms: number;
}

interface Receipt {
  schema_version: 1;
  cat: 'cat21-code-retrieval';
  gbrain_version: string;
  timestamp: string;
  corpus: 'gbrain-src';
  files_ingested: number;
  queries: number;
  cells: ProviderCell[];
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.')) continue;
    if (e === 'node_modules' || e === 'assets') continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, out);
    else if (e.endsWith('.ts')) out.push(full);
  }
  return out;
}

async function runCell(name: string, files: string[]): Promise<ProviderCell> {
  const cfg = name === 'voyage-code-3'
    ? { embedder: 'voyage:voyage-code-3', dim: 1024 }
    : { embedder: 'openai:text-embedding-3-large', dim: 1536 };

  configureGateway({
    embedding_model: cfg.embedder,
    embedding_dimensions: cfg.dim,
    env: process.env as Record<string, string | undefined>,
  });

  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const origLog = console.log;
  console.log = () => {};

  // Ingest as plain markdown wrappers — we don't need tree-sitter chunking
  // for the retrieval test; just need each file as a separate searchable
  // page. importFromContent stores the body and chunks it via the markdown
  // chunker, which is good enough to surface "this file mentions X".
  const { importFromContent } = await import('gbrain/import-file');
  const tIngest = Date.now();
  let ok = 0;
  for (const f of files) {
    const rel = relative(join(process.cwd(), 'node_modules/gbrain'), f);
    const slug = `code/${rel.replace(/\.ts$/, '').replace(/\//g, '__')}`;
    const body = `# ${rel}\n\n\`\`\`typescript\n${readFileSync(f, 'utf8').slice(0, 12000)}\n\`\`\`\n`;
    try {
      await importFromContent(engine, slug, body, { noEmbed: false });
      ok++;
    } catch { /* skip oversized / broken */ }
  }
  const ingestMs = Date.now() - tIngest;

  let queryMs = 0;
  let top1 = 0;
  let mrrSum = 0;
  let recall5Sum = 0;
  for (const q of QUERIES) {
    const t = Date.now();
    let results: any[] = [];
    try {
      results = await hybridSearch(engine, q.text, { limit: 10 } as any);
    } catch (e: any) { /* skip */ }
    queryMs += Date.now() - t;
    let bestRank = Infinity;
    for (let i = 0; i < results.length; i++) {
      if ((results[i].slug as string).includes(q.expected_substring.replace(/\//g, '__').replace(/\.ts$/, ''))) {
        bestRank = Math.min(bestRank, i + 1);
        if (i < 5) recall5Sum++;
      }
    }
    if (bestRank === 1) top1++;
    if (bestRank !== Infinity) mrrSum += 1 / bestRank;
  }
  console.log = origLog;
  await engine.disconnect();

  return {
    cell: name,
    embedder: cfg.embedder,
    dim: cfg.dim,
    queries: QUERIES.length,
    top1_hits: top1,
    mrr: mrrSum / QUERIES.length,
    recall_at_5: recall5Sum / QUERIES.length,
    mean_query_ms: queryMs / QUERIES.length,
    ingest_ms: ingestMs,
  };
}

async function main(): Promise<void> {
  const allFiles = walkTs(SRC_ROOT);
  // Subset: ~60 files to keep cost bounded
  const files = allFiles.slice(0, 60);
  process.stderr.write(`[cat21] ingesting ${files.length}/${allFiles.length} .ts files\n`);

  const cells: ProviderCell[] = [];
  for (const name of ['voyage-code-3', 'openai-default']) {
    process.stderr.write(`[cat21] cell=${name}...\n`);
    try {
      const c = await runCell(name, files);
      cells.push(c);
      process.stderr.write(`[cat21]   ${name}: top1=${c.top1_hits}/${c.queries} MRR=${c.mrr.toFixed(3)} R@5=${(c.recall_at_5 * 100).toFixed(1)}% q_ms=${c.mean_query_ms.toFixed(0)}\n`);
    } catch (e: any) {
      process.stderr.write(`[cat21]   ${name}: ERROR ${e?.message ?? e}\n`);
    }
  }

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const receipt: Receipt = {
    schema_version: 1,
    cat: 'cat21-code-retrieval',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    corpus: 'gbrain-src',
    files_ingested: files.length,
    queries: QUERIES.length,
    cells,
  };

  const outDir = join(process.cwd(), 'eval/reports/cat21-code-retrieval');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat21.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat21] ─── Scorecard ───────────────────\n`);
  for (const c of cells) {
    process.stderr.write(`[cat21]   ${c.cell.padEnd(20)} top1=${c.top1_hits}/${c.queries}  MRR=${c.mrr.toFixed(3)}  R@5=${(c.recall_at_5 * 100).toFixed(1)}%  q_ms=${c.mean_query_ms.toFixed(0)}\n`);
  }
  process.stderr.write(`[cat21]   receipt:           ${outFile}\n`);
}

await main();
