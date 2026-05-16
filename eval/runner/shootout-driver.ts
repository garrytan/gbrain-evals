#!/usr/bin/env bun
/**
 * Single-cell BrainBench driver for the v0.35.1.0 embedder shootout.
 *
 * The existing multi-adapter.ts runner scores N adapters × N runs in
 * one pass; useful for cross-adapter comparisons. The shootout needs
 * the inverse: ONE adapter (HybridNoGraphAdapter) × ONE config × either
 * the relational corpus OR the Cat 13 conceptual subset. This driver
 * is that.
 *
 * Per cell, it emits a deterministic JSON receipt {cell, embedder, dim,
 * reranker, subset, queries, P@5, R@5, correct, total_expected,
 * wallclock_ms} so the writeup script can compare across cells without
 * re-running anything.
 *
 * Invoked by scripts/run-shootout-phase2.sh.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { HybridNoGraphAdapter } from './adapters/vector-grep-rrf-fusion.ts';
import type { Adapter, Page, Query, RankedDoc } from './types.ts';
import { precisionAtK, recallAtK, sanitizePage, sanitizeQuery } from './types.ts';
import type { EvalAdapterConfig } from './eval-adapter-config.ts';

const TOP_K = 5;
const CORPUS_DIR = 'eval/data/world-v1';

// ─── Args ──────────────────────────────────────────────────────────

interface ParsedArgs {
  help: boolean;
  embedder?: string;
  dim?: number;
  reranker?: string;
  subset?: string;
  output?: string;
  cell?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--embedder') out.embedder = argv[++i];
    else if (a === '--dim') out.dim = Number(argv[++i]);
    else if (a === '--reranker') out.reranker = argv[++i];
    else if (a === '--subset') out.subset = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--cell') out.cell = argv[++i];
  }
  return out;
}

function printHelp(): void {
  process.stderr.write(
    'shootout-driver — score one cell × one adapter × one query set\n\n' +
    'Required:\n' +
    '  --embedder <provider:model>     e.g. zeroentropyai:zembed-1\n' +
    '  --dim <N>                       Configured vector width\n' +
    '  --output <path>                 Output receipt JSON path\n\n' +
    'Optional:\n' +
    '  --reranker <provider:model>     e.g. zeroentropyai:zerank-2\n' +
    '  --subset <name>                 Load eval/data/gold/brainbench-<name>-subset.json\n' +
    '                                  instead of building relational queries\n' +
    '  --cell <label>                  Cell label (A0, B1, C2, ...) for the receipt\n',
  );
}

// ─── Corpus loader (replicated from multi-adapter.ts) ─────────────

interface RichPage extends Page {
  _facts: {
    type: string;
    role?: string;
    primary_affiliation?: string;
    secondary_affiliations?: string[];
    founders?: string[];
    employees?: string[];
    investors?: string[];
    advisors?: string[];
    attendees?: string[];
  };
}

function loadCorpus(dir: string): RichPage[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const out: RichPage[] = [];
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    if (Array.isArray(p.timeline)) p.timeline = p.timeline.join('\n');
    if (Array.isArray(p.compiled_truth)) p.compiled_truth = p.compiled_truth.join('\n\n');
    p.title = String(p.title ?? '');
    p.compiled_truth = String(p.compiled_truth ?? '');
    p.timeline = String(p.timeline ?? '');
    out.push(p as RichPage);
  }
  return out;
}

// ─── Relational queries (mirror multi-adapter.ts) ──────────────────

function buildRelationalQueries(pages: RichPage[]): Query[] {
  const existing = new Set(pages.map(p => p.slug));
  const filter = (slugs: string[]) => slugs.filter(s => existing.has(s));
  const queries: Query[] = [];
  let counter = 0;
  const nextId = () => `q-${String(++counter).padStart(4, '0')}`;

  for (const p of pages) {
    if (p._facts.type !== 'meeting') continue;
    const expected = filter(p._facts.attendees ?? []);
    if (expected.length === 0) continue;
    queries.push({
      id: nextId(), tier: 'medium', text: `Who attended ${p.title}?`,
      expected_output_type: 'cited-source-pages', gold: { relevant: expected },
    });
  }
  for (const p of pages) {
    if (p._facts.type !== 'company') continue;
    const expected = filter([...(p._facts.employees ?? []), ...(p._facts.founders ?? [])]);
    if (expected.length === 0) continue;
    queries.push({
      id: nextId(), tier: 'medium', text: `Who works at ${p.title}?`,
      expected_output_type: 'cited-source-pages', gold: { relevant: [...new Set(expected)] },
    });
  }
  return queries;
}

function loadSubset(name: string): Query[] {
  const path = `eval/data/gold/brainbench-${name}-subset.json`;
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.queries)) {
    throw new Error(`Subset ${path}: missing or malformed queries array`);
  }
  return parsed.queries.map((q: any): Query => ({
    id: q.id, tier: 'medium', text: q.text,
    expected_output_type: 'cited-source-pages',
    gold: { relevant: q.relevant_chunk_ids as string[] },
    tags: ['embedder-sensitive'],
  }));
}

// ─── Score one cell ─────────────────────────────────────────────────

interface CellReceipt {
  cell: string | null;
  embedder: string;
  dim: number;
  reranker: string | null;
  subset: string | null;
  queries: number;
  top_k: number;
  mean_precision_at_k: number;
  mean_recall_at_k: number;
  correct_in_top_k: number;
  total_expected: number;
  wallclock_ms: number;
  timestamp: string;
}

async function runCell(args: ParsedArgs): Promise<CellReceipt> {
  if (!args.embedder || !args.dim || !args.output) {
    printHelp();
    process.exit(1);
  }

  const shootout: EvalAdapterConfig = {
    embedder: args.embedder!,
    dim: args.dim!,
    reranker: args.reranker,
    searchMode: 'tokenmax',
    cell: args.cell,
  };

  process.stderr.write(`[shootout-driver] cell=${args.cell ?? '?'} embedder=${shootout.embedder} dim=${shootout.dim}${shootout.reranker ? ` reranker=${shootout.reranker}` : ''}${args.subset ? ` subset=${args.subset}` : ' subset=(relational)'}\n`);

  const pages = loadCorpus(CORPUS_DIR) as Page[];
  const queries = args.subset
    ? loadSubset(args.subset)
    : buildRelationalQueries(pages as RichPage[]);

  process.stderr.write(`[shootout-driver] corpus=${pages.length} pages, queries=${queries.length}\n`);

  const adapter: Adapter = new HybridNoGraphAdapter();

  const t0 = Date.now();
  const publicPages = pages.map(sanitizePage);
  const state = await adapter.init(publicPages, { name: adapter.name, shootout });

  let totalP = 0, totalR = 0, totalCorrect = 0, totalExpected = 0;
  for (const q of queries) {
    const publicQ = sanitizeQuery(q);
    const results: RankedDoc[] = await adapter.query(publicQ as unknown as Query, state);
    const relevant = new Set(q.gold.relevant ?? []);
    totalP += precisionAtK(results, relevant, TOP_K);
    totalR += recallAtK(results, relevant, TOP_K);
    const topK = results.slice(0, TOP_K);
    for (const r of topK) if (relevant.has(r.page_id)) totalCorrect++;
    totalExpected += relevant.size;
  }
  if (adapter.teardown) await adapter.teardown(state);
  const wallclock_ms = Date.now() - t0;

  const receipt: CellReceipt = {
    cell: args.cell ?? null,
    embedder: shootout.embedder,
    dim: shootout.dim,
    reranker: shootout.reranker ?? null,
    subset: args.subset ?? null,
    queries: queries.length,
    top_k: TOP_K,
    mean_precision_at_k: queries.length ? totalP / queries.length : 0,
    mean_recall_at_k: queries.length ? totalR / queries.length : 0,
    correct_in_top_k: totalCorrect,
    total_expected: totalExpected,
    wallclock_ms,
    timestamp: new Date().toISOString(),
  };

  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  process.stderr.write(
    `[shootout-driver] wrote ${args.output}: P@${TOP_K}=${(receipt.mean_precision_at_k * 100).toFixed(1)}%  R@${TOP_K}=${(receipt.mean_recall_at_k * 100).toFixed(1)}%  ${receipt.correct_in_top_k}/${receipt.total_expected} correct  ${wallclock_ms}ms\n`,
  );
  return receipt;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
await runCell(args);
