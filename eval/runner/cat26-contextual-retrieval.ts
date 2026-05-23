/**
 * BrainBench Cat 26 — contextual retrieval modes A/B (v0.40.3.0).
 *
 * Headline question: does Anthropic-style contextual retrieval
 * (`title` wrap or `per_chunk_synopsis`) actually improve recall on
 * cross-chunk queries?
 *
 * Hermetic. Default mode uses noEmbed=false but skips paid synopsis
 * generation (`per_chunk_synopsis` falls back to `title` in inline path).
 *
 * Flow:
 *   1. Same corpus (10 long pages, each chunked to 5+ chunks).
 *   2. Three modes: none, title, per_chunk_synopsis (falls back to title inline).
 *   3. 10 queries targeting facts that only appear mid-chunk.
 *   4. For each (mode, query) measure Recall@10.
 *   5. Report mode-vs-mode delta.
 *
 * Run:
 *   bun eval/runner/cat26-contextual-retrieval.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';

// Long pages where the gold sentence is buried in the middle of the body.
// The page title doesn't mention the fact; cross-chunk retrieval should
// surface the chunk by combining title context with chunk content.
const PAGES = [
  {
    slug: 'companies/acme-ai',
    title: 'Acme AI',
    body: `Acme AI was founded in 2024. The CEO is Alice Okafor.

Acme AI's headquarters are in San Francisco.

The company raised a $30M Series A in March 2026 led by Fund X. The lead partner was Erin Yu.

Acme AI's primary product is an inference platform for autonomous picking robotics. The platform supports both GPU and TPU backends.

Engineering is led by Bob Chen (CTO) and Carol Singh (VP Eng). The team is 28 people as of May 2026.`,
    gold_query: 'who led the Series A round for the inference platform',
  },
  {
    slug: 'companies/foundry-labs',
    title: 'Foundry Labs',
    body: `Foundry Labs is a robotics startup. Based in Pittsburgh.

The team consists of 12 engineers and 3 researchers as of April 2026.

Their main product is an autonomous picking system for warehouses. The system uses a custom transformer architecture trained on 50TB of bin-picking demonstrations.

Foundry's CFO Maria Lopez previously ran finance at SpaceX. She joined in January 2026.

Their fundraising history: $2M pre-seed in 2023, $8M seed in 2024, $25M Series A in 2025.`,
    gold_query: 'who is the CFO of the warehouse robotics company',
  },
  {
    slug: 'people/erin-yu',
    title: 'Erin Yu',
    body: `Erin Yu is a partner at Fund X. She joined in 2022.

Background: Stanford CS PhD, ex-OpenAI research engineer.

Erin focuses on early-stage robotics and ML infrastructure investments. She led the seed in Foundry Labs and the Series A in Acme AI.

She sits on the board of Acme AI as the lead investor representative.`,
    gold_query: 'who led the seed round for the warehouse robotics company',
  },
];

const QUERIES = PAGES.map(p => ({
  query: p.gold_query,
  relevant_slugs: [p.slug],
}));

type Mode = 'none' | 'title' | 'per_chunk_synopsis';

interface ModeResult {
  mode: Mode;
  per_query_recall: number[];
  mean_recall_at_10: number;
}

interface Receipt {
  schema_version: 1;
  cat: 'cat26-contextual-retrieval';
  gbrain_version: string;
  timestamp: string;
  corpus_pages: number;
  queries: number;
  modes: ModeResult[];
  best_mode: Mode;
  none_vs_title_delta: number;
  none_vs_synopsis_delta: number;
}

async function runMode(mode: Mode): Promise<ModeResult> {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: process.env as Record<string, string | undefined>,
  });

  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const origLog = console.log;
  console.log = () => {};

  // Set global contextual_retrieval knob
  await engine.setConfig('contextual_retrieval', mode);

  for (const p of PAGES) {
    const body = `# ${p.title}\n\n${p.body}\n`;
    await importFromContent(engine, p.slug, body, { noEmbed: false });
  }

  const perQ: number[] = [];
  for (const q of QUERIES) {
    const results = await hybridSearch(engine, q.query, { limit: 10 } as any);
    const slugs = new Set(results.map((r: any) => r.slug as string));
    const rel = q.relevant_slugs.filter(s => slugs.has(s)).length;
    perQ.push(rel / q.relevant_slugs.length);
  }
  console.log = origLog;
  await engine.disconnect();

  return {
    mode,
    per_query_recall: perQ,
    mean_recall_at_10: perQ.reduce((a, b) => a + b, 0) / Math.max(1, perQ.length),
  };
}

async function main(): Promise<void> {
  process.stderr.write(`[cat26] testing ${PAGES.length} pages × ${QUERIES.length} queries × 3 modes...\n`);
  const modes: Mode[] = ['none', 'title', 'per_chunk_synopsis'];
  const results: ModeResult[] = [];
  for (const mode of modes) {
    process.stderr.write(`[cat26]   mode=${mode}...\n`);
    const r = await runMode(mode);
    results.push(r);
    process.stderr.write(`[cat26]   mode=${mode} mean R@10=${(r.mean_recall_at_10 * 100).toFixed(1)}%\n`);
  }

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const bestMode = results.reduce((a, b) => a.mean_recall_at_10 >= b.mean_recall_at_10 ? a : b).mode;
  const noneR = results.find(r => r.mode === 'none')!.mean_recall_at_10;
  const titleR = results.find(r => r.mode === 'title')!.mean_recall_at_10;
  const synR = results.find(r => r.mode === 'per_chunk_synopsis')!.mean_recall_at_10;

  const receipt: Receipt = {
    schema_version: 1,
    cat: 'cat26-contextual-retrieval',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    corpus_pages: PAGES.length,
    queries: QUERIES.length,
    modes: results,
    best_mode: bestMode,
    none_vs_title_delta: titleR - noneR,
    none_vs_synopsis_delta: synR - noneR,
  };

  const outDir = join(process.cwd(), 'eval/reports/cat26-contextual-retrieval');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat26.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat26] ─── Scorecard ───────────────────\n`);
  for (const r of results) {
    process.stderr.write(`[cat26]   mode=${r.mode.padEnd(22)} R@10=${(r.mean_recall_at_10 * 100).toFixed(1)}%\n`);
  }
  process.stderr.write(`[cat26]   best mode:           ${bestMode}\n`);
  process.stderr.write(`[cat26]   none → title:        ${(receipt.none_vs_title_delta * 100).toFixed(1)}pt\n`);
  process.stderr.write(`[cat26]   none → synopsis:     ${(receipt.none_vs_synopsis_delta * 100).toFixed(1)}pt\n`);
  process.stderr.write(`[cat26]   receipt:             ${outFile}\n`);
}

await main();
