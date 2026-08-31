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
 * Relational queries come from the SHARED builder in
 * eval/runner/queries/relational.ts — the exact set multi-adapter.ts
 * scores. (The old private copy silently dropped the invested_in and
 * advises templates while reusing multi-adapter's metric field names,
 * so shootout relational cells were not comparable to published
 * multi-adapter numbers. Audit orchestrators-15.)
 *
 * Per cell, it emits a deterministic JSON receipt {cell, embedder, dim,
 * reranker, subset, query_set, queries, P@5, R@5, correct, total_expected,
 * wallclock_ms, gbrain_version, gbrain_pin} at --output so the writeup
 * script can compare across cells without re-running anything. It ALSO
 * writes the standard WS0 receipt at eval/reports/shootout-driver/
 * receipt.json (last cell wins; per-cell provenance lives in --output).
 *
 * Invoked by scripts/run-shootout-phase2.sh.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { HybridNoGraphAdapter } from './adapters/vector-grep-rrf-fusion.ts';
import type { Adapter, Page, Query, RankedDoc } from './types.ts';
import { precisionAtK, recallAtK, sanitizePage, sanitizeQuery } from './types.ts';
import type { EvalAdapterConfig } from './eval-adapter-config.ts';
import { buildRelationalQueries, loadWorldCorpus, type RichPage } from './queries/relational.ts';
import { writeReceipt, receiptPath, RECEIPT_SCHEMA_VERSION, BENCHMARK_VERSION } from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

const TOP_K = 5;
const DEFAULT_CORPUS_DIR = 'eval/data/world-v1';

// ─── Args ──────────────────────────────────────────────────────────

export interface ParsedArgs {
  help: boolean;
  embedder?: string;
  dim?: number;
  reranker?: string;
  subset?: string;
  output?: string;
  cell?: string;
  /** Corpus dir override (tests). Default eval/data/world-v1. */
  corpus?: string;
  /** Standard-receipt path override (tests). */
  receiptPathOverride?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
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
    else if (a === '--corpus') out.corpus = argv[++i];
    else if (a === '--receipt-path') out.receiptPathOverride = argv[++i];
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
    '  --cell <label>                  Cell label (A0, B1, C2, ...) for the receipt\n' +
    '  --corpus <dir>                  Corpus dir (default eval/data/world-v1)\n' +
    '  --receipt-path <path>           Standard WS0 receipt path override (tests)\n',
  );
}

// ─── Query loading ──────────────────────────────────────────────────

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

/**
 * The cell's query set: the curated subset when requested, otherwise the
 * SAME 4-template relational set multi-adapter.ts scores (shared builder —
 * regression anchor for audit orchestrators-15).
 */
export function buildCellQueries(pages: RichPage[], subset: string | undefined): Query[] {
  return subset ? loadSubset(subset) : buildRelationalQueries(pages);
}

// ─── Score one cell ─────────────────────────────────────────────────

export interface CellReceipt {
  cell: string | null;
  embedder: string;
  dim: number;
  reranker: string | null;
  subset: string | null;
  /** Which query set was scored — relational cells use the shared
   *  4-template builder, so they ARE comparable to multi-adapter's
   *  relational scorecard column. */
  query_set: string;
  queries: number;
  top_k: number;
  mean_precision_at_k: number;
  mean_recall_at_k: number;
  correct_in_top_k: number;
  total_expected: number;
  wallclock_ms: number;
  timestamp: string;
  gbrain_version: string;
  gbrain_pin: string;
}

export async function runCell(args: ParsedArgs): Promise<CellReceipt> {
  if (!args.embedder || !args.dim || !args.output) {
    printHelp();
    process.exit(1);
  }
  const startedAt = new Date().toISOString();

  const shootout: EvalAdapterConfig = {
    embedder: args.embedder!,
    dim: args.dim!,
    reranker: args.reranker,
    searchMode: 'tokenmax',
    cell: args.cell,
  };

  process.stderr.write(`[shootout-driver] cell=${args.cell ?? '?'} embedder=${shootout.embedder} dim=${shootout.dim}${shootout.reranker ? ` reranker=${shootout.reranker}` : ''}${args.subset ? ` subset=${args.subset}` : ' subset=(relational)'}\n`);

  const corpusDir = args.corpus ?? DEFAULT_CORPUS_DIR;
  const richPages = loadWorldCorpus(corpusDir);
  const pages = richPages as Page[];
  const queries = buildCellQueries(richPages, args.subset);

  process.stderr.write(`[shootout-driver] corpus=${pages.length} pages, queries=${queries.length}\n`);

  const adapter: Adapter = new HybridNoGraphAdapter();

  const t0 = Date.now();
  const publicPages = pages.map(sanitizePage);
  const state = await adapter.init(publicPages, { name: adapter.name, shootout });

  let totalP = 0, totalR = 0, totalCorrect = 0, totalExpected = 0, scored = 0;
  for (const q of queries) {
    const publicQ = sanitizeQuery(q);
    const results: RankedDoc[] = await adapter.query(publicQ, state);
    const relevant = new Set(q.gold.relevant ?? []);
    // Gold-less queries excluded from means (metrics return NaN on empty gold).
    if (relevant.size === 0) continue;
    scored++;
    totalP += precisionAtK(results, relevant, TOP_K);
    totalR += recallAtK(results, relevant, TOP_K);
    const topK = results.slice(0, TOP_K);
    const seen = new Set<string>();
    for (const r of topK) {
      if (relevant.has(r.page_id) && !seen.has(r.page_id)) {
        seen.add(r.page_id);
        totalCorrect++;
      }
    }
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
    query_set: args.subset
      ? `subset:${args.subset}`
      : 'relational (shared 4-template builder, queries/relational.ts)',
    queries: queries.length,
    top_k: TOP_K,
    mean_precision_at_k: scored ? totalP / scored : 0,
    mean_recall_at_k: scored ? totalR / scored : 0,
    correct_in_top_k: totalCorrect,
    total_expected: totalExpected,
    wallclock_ms,
    timestamp: new Date().toISOString(),
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
  };

  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  // Standard WS0 receipt (run provenance; last cell wins — the per-cell
  // record of truth is the --output file above).
  writeReceipt(args.receiptPathOverride ?? receiptPath('shootout-driver'), {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: 'shootout-driver',
    run_status: 'completed',
    verdict: scored > 0 ? 'pass' : 'fail',
    n_total: queries.length,
    n_scored: scored,
    completion_rate: queries.length > 0 ? scored / queries.length : 0,
    errors: [],
    publishable: scored > 0,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      cell: args.cell ?? null,
      embedder: shootout.embedder,
      dim: shootout.dim,
      reranker: shootout.reranker ?? null,
      search_mode: shootout.searchMode ?? null,
      subset: args.subset ?? null,
      corpus: corpusDir,
      relational_builder: 'eval/runner/queries/relational.ts buildRelationalQueries (shared with multi-adapter.ts)',
      output: args.output,
    },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: { cell_receipt: { ...receipt } },
  });

  process.stderr.write(
    `[shootout-driver] wrote ${args.output}: P@${TOP_K}=${(receipt.mean_precision_at_k * 100).toFixed(1)}%  R@${TOP_K}=${(receipt.mean_recall_at_k * 100).toFixed(1)}%  ${receipt.correct_in_top_k}/${receipt.total_expected} correct  ${wallclock_ms}ms\n`,
  );
  return receipt;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  runCell(args)
    .then(() => process.exit(0)) // explicit: PGLite's WASM runtime pollutes ambient process.exitCode
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
