/**
 * BrainBench Cat 21 — code-corpus retrieval: voyage-code-3 vs
 * text-embedding-3-large on symbol-lookup queries.
 *
 * Headline question: does Voyage's code-tuned embedder surface
 * symbol-lookup queries better than the general-purpose OpenAI model?
 * Backs the v0.37.3.0 `reindex --code` nudge.
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: gbrain's embedding + hybridSearch pipeline over a code corpus
 * (gbrain's own src/core .ts files). Search mode is pinned to 'balanced'
 * and the reranker pinned OFF in EVERY cell (WS5): the previous version
 * relied on the default mode, whose zerank-2 reranker silently fires when
 * ZEROENTROPY_API_KEY is set — reshuffling exactly the top-1 metric under
 * comparison (audit cats18-21-07). Cells differ ONLY by embedder.
 * LEGITIMATELY SEEDED/STUBBED: files are ingested as markdown-wrapped
 * code bodies via importFromContent (NOT the tree-sitter importCodeFile
 * path the old header claimed — audit cats18-21-16), truncated to
 * MAX_FILE_CHARS = 36000. That cap covers every gold symbol's definition
 * site (max first-occurrence offset: 31.8k in pglite-engine.ts); the old
 * 12000 cap cut 3/12 gold symbols out of the corpus. Under --stub-embed
 * the embed transport is a deterministic hash (both cells identical —
 * plumbing check only, publishable:false).
 *
 * ── Corpus construction (audit cats18-21-01) ─────────────────────────
 * The old runner ingested `allFiles.slice(0, 60)` of 857 files, which
 * excluded 11 of 12 gold-target files — both cells were bounded near 1/12.
 * Now: the ingest set is ALL 12 gold files (resolved from the query list,
 * uniqueness asserted) + a deterministic FNV-hash-ordered distractor
 * sample. Before any query runs, every gold slug is asserted present in
 * the pages table; a missing gold slug aborts the cell.
 *
 * ── Scoring policy (WS0) ─────────────────────────────────────────────
 * Chunk rows page-normalize through metrics.ts uniqueInOrder before
 * scoring — the old per-chunk-row recall counting let one query contribute
 * more than 1 to recall@5 (gbrain returns up to 2 chunks/page; audit
 * cats18-21-13). Gold matching is exact slug equality, not substring.
 * Query failures / degraded-to-keyword results / pin violations go through
 * probe-accounting with typed origins, never dropped from denominators.
 *
 * ── Verdict (real + failable) ────────────────────────────────────────
 * pass    — every requested cell valid (all gold slugs indexed, zero query
 *           errors, mode + reranker pins verified per query) AND cell MRR
 *           >= the mode's floor. Live runs gate on embedder QUALITY
 *           (MRR >= 0.5). Stub runs gate on PLUMBING: MRR >= 0.2 AND every
 *           gold page retrieved at some rank — the hash stub is not any
 *           provider's model, so a quality floor there would grade the
 *           stub, not gbrain (measured stub MRR: 0.29-0.44).
 * partial — at least one valid cell, but not all cells pass the gate.
 * fail    — no valid cell, or a valid cell below the MRR floor, or (stub)
 *           a gold page nowhere in the top-30.
 * Exit non-zero unless verdict === 'pass'. Missing provider keys → receipt
 * run_status 'skipped' + non-zero exit unless --allow-skip.
 *
 * Run:
 *   bun eval/runner/cat21-code-retrieval.ts --stub-embed   # hermetic
 *   bun eval/runner/cat21-code-retrieval.ts                # live (keys required)
 */

import { writeFileSync, mkdirSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, relative, basename } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
import type { SearchResult, HybridSearchMeta } from 'gbrain/types';
import { makeHashEmbedTransport } from './cat18-embedding-providers.ts';
import { uniqueInOrder, reciprocalRank, recallAnyAtK, rankOfFirstHit, percentile } from './metrics.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';

export const CAT21_CATEGORY = 'cat21-code-retrieval';

const GBRAIN_ROOT = join(process.cwd(), 'node_modules/gbrain');
export const SRC_ROOT = join(GBRAIN_ROOT, 'src/core');

/** Uniform per-file body cap. Covers every gold symbol's first occurrence
 *  (max offset 31.8k); documented corpus construction, applied to gold and
 *  distractors alike. */
export const MAX_FILE_CHARS = 36000;
/** Distractor files beyond the 12 gold targets (60 total by default). */
export const DEFAULT_DISTRACTORS = 48;
/** Chunk rows fetched per query; gbrain dedup keeps <= 2 chunks/page. */
export const CHUNK_FETCH = 30;
/** Per-cell MRR floor for a 'pass' verdict on LIVE embedders (quality gate). */
export const DEFAULT_MIN_MRR_LIVE = 0.5;
/** Stub-mode MRR floor (plumbing gate — the hash stub is not a provider). */
export const DEFAULT_MIN_MRR_STUB = 0.2;
export const K_RECALL = 5;

/** WS5 pin — engine.setConfig'd BEFORE ingest in every cell, echoed into the
 *  receipt. Reranker OFF: top-1 must reflect the embedder, not zerank-2. */
export const PINNED_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.autocut': 'false',
  'search.tokenBudget': '1000000',
};

export interface CodeQuery {
  id: string;
  text: string;
  /** Path suffix (relative to src/core walk) uniquely naming the gold file. */
  expected_file: string;
}

export const QUERIES: CodeQuery[] = [
  { id: 'q01', text: 'runThink function entry point', expected_file: 'think/index.ts' },
  { id: 'q02', text: 'PGLiteEngine class definition', expected_file: 'pglite-engine.ts' },
  { id: 'q03', text: 'hybridSearch function', expected_file: 'search/hybrid.ts' },
  { id: 'q04', text: 'importFromContent function', expected_file: 'import-file.ts' },
  { id: 'q05', text: 'extractEntityRefs wikilink parser', expected_file: 'link-extraction.ts' },
  { id: 'q06', text: 'resolveEmbeddingColumn resolver', expected_file: 'search/embedding-column.ts' },
  { id: 'q07', text: 'applyGraphSignals adjacency boost', expected_file: 'search/graph-signals.ts' },
  { id: 'q08', text: 'runBrainstorm orchestrator', expected_file: 'brainstorm/orchestrator.ts' },
  { id: 'q09', text: 'configureGateway AI gateway setup', expected_file: 'ai/gateway.ts' },
  { id: 'q10', text: 'resolvePhantomCanonical entity resolver', expected_file: 'entities/resolve.ts' },
  { id: 'q11', text: 'computeRecommendations brain score remediation', expected_file: 'brain-score-recommendations.ts' },
  { id: 'q12', text: 'MinionQueue add submit job', expected_file: 'minions/queue.ts' },
];

const PROVIDER_ENV_KEY: Record<string, string> = {
  'voyage-code-3': 'VOYAGE_API_KEY',
  'openai-default': 'OPENAI_API_KEY',
};

export const CELLS_DEFAULT = ['voyage-code-3', 'openai-default'];

export function cellConfig(name: string): { embedder: string; dim: number } {
  switch (name) {
    case 'voyage-code-3': return { embedder: 'voyage:voyage-code-3', dim: 1024 };
    case 'openai-default': return { embedder: 'openai:text-embedding-3-large', dim: 1536 };
    default: throw new Error(`unknown cell: ${name}`);
  }
}

// ─── Corpus construction ─────────────────────────────────────────────

export function walkTs(dir: string, out: string[] = []): string[] {
  // Sorted walk: readdirSync raw order is filesystem-dependent; the corpus
  // must be identical across machines (determinism rule).
  for (const e of readdirSync(dir).sort()) {
    if (e.startsWith('.')) continue;
    if (e === 'node_modules' || e === 'assets') continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, out);
    else if (e.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Slug for a file path, matching the ingest transform exactly. */
export function fileSlug(fullPath: string): string {
  const rel = relative(GBRAIN_ROOT, fullPath);
  return `code/${rel.replace(/\.ts$/, '').replace(/\//g, '__')}`;
}

/** Resolve each query's expected_file suffix to exactly one walked path.
 *  Ambiguity or absence is a harness bug — thrown, never silently scored. */
export function resolveGoldFiles(allFiles: string[], queries: CodeQuery[]): Map<string, string> {
  const goldByQueryId = new Map<string, string>();
  for (const q of queries) {
    const matches = allFiles.filter(f => {
      if (!f.endsWith(q.expected_file)) return false;
      // Bare filenames must match the basename exactly, not a longer suffix
      // (e.g. 'resolve.ts' must not match 'phantom-resolve.ts').
      if (!q.expected_file.includes('/')) return basename(f) === q.expected_file;
      return f.endsWith(`/${q.expected_file}`);
    });
    if (matches.length !== 1) {
      throw new Error(`gold resolution for ${q.id} (${q.expected_file}): expected exactly 1 match, got ${matches.length}: ${matches.map(m => relative(GBRAIN_ROOT, m)).join(', ')}`);
    }
    goldByQueryId.set(q.id, matches[0]);
  }
  return goldByQueryId;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic distractor sample: order all non-gold files by FNV-1a hash
 *  of their repo-relative path (ties by path), take the first n. No RNG. */
export function pickDistractors(allFiles: string[], goldPaths: ReadonlySet<string>, n: number): string[] {
  return allFiles
    .filter(f => !goldPaths.has(f))
    .map(f => ({ f, h: fnv1a(relative(GBRAIN_ROOT, f)) }))
    .sort((a, b) => a.h - b.h || (a.f < b.f ? -1 : 1))
    .slice(0, n)
    .map(x => x.f);
}

// ─── Per-cell run ────────────────────────────────────────────────────

export interface ProviderCell {
  cell: string;
  embedder: string;
  dim: number;
  files_planned: number;
  files_ok: number;
  files_failed: number;
  first_ingest_error: string | null;
  gold_present: number;
  gold_missing: string[];
  queries_total: number;
  queries_scored: number;
  query_errors: number;
  degraded_queries: number;
  rerank_scored_queries: number;
  top1_hits: number | null;
  mrr: number | null;
  recall_at_5: number | null;
  mean_query_ms: number | null;
  p50_query_ms: number | null;
  ingest_ms: number;
  valid: boolean;
  invalid_reasons: string[];
  per_query: Array<{ id: string; rank: number | null; top1: boolean; ms: number }>;
}

const DEGRADED_VECTOR_STAGES = new Set(['embed_unavailable', 'embed_timeout', 'vector_arm_failed', 'rescore_skipped']);

export interface RunCellArgs {
  name: string;
  files: string[];
  queries: CodeQuery[];
  goldSlugByQueryId: Map<string, string>;
  goldPathByQueryId: Map<string, string>;
  acc: ProbeAccounting;
  pinned?: Record<string, string>;
}

export async function runCell(args: RunCellArgs): Promise<ProviderCell> {
  const { name, files, queries, goldSlugByQueryId, goldPathByQueryId, acc } = args;
  const pinned = args.pinned ?? PINNED_CONFIG;
  const { embedder, dim } = cellConfig(name);
  const probeId = (q: CodeQuery): string => `${name}:${q.id}`;

  const cell: ProviderCell = {
    cell: name, embedder, dim,
    files_planned: files.length, files_ok: 0, files_failed: 0, first_ingest_error: null,
    gold_present: 0, gold_missing: [],
    queries_total: queries.length, queries_scored: 0, query_errors: 0,
    degraded_queries: 0, rerank_scored_queries: 0,
    top1_hits: null, mrr: null, recall_at_5: null,
    mean_query_ms: null, p50_query_ms: null, ingest_ms: 0,
    valid: false, invalid_reasons: [], per_query: [],
  };

  // Gateway BEFORE initSchema: schema creates vector(N) from the active dims.
  configureGateway({
    embedding_model: embedder,
    embedding_dimensions: dim,
    env: process.env as Record<string, string | undefined>,
  });

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const origLog = console.log;
  try {
    // WS5: pin mode + reranker per cell BEFORE ingest.
    for (const [k, v] of Object.entries(pinned)) await engine.setConfig(k, v);

    const ingestErrors = new Map<string, string>();
    console.log = () => {};
    const tIngest = Date.now();
    try {
      for (const f of files) {
        const rel = relative(GBRAIN_ROOT, f);
        const slug = fileSlug(f);
        const body = `# ${rel}\n\n\`\`\`typescript\n${readFileSync(f, 'utf8').slice(0, MAX_FILE_CHARS)}\n\`\`\`\n`;
        try {
          await importFromContent(engine, slug, body, { noEmbed: false });
          cell.files_ok++;
        } catch (e: any) {
          cell.files_failed++;
          const msg = String(e?.message ?? e).slice(0, 300);
          ingestErrors.set(f, msg);
          if (!cell.first_ingest_error) cell.first_ingest_error = `${rel}: ${msg}`;
        }
      }
    } finally {
      console.log = origLog;
    }
    cell.ingest_ms = Date.now() - tIngest;

    // Gold-presence assertion: every gold slug must be in the index BEFORE
    // any query runs; otherwise the cell measures nothing and is aborted
    // (audit cats18-21-01).
    for (const q of queries) {
      const slug = goldSlugByQueryId.get(q.id)!;
      const rows = await engine.executeRaw(`SELECT 1 AS one FROM pages WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`, [slug]) as unknown[];
      if (rows.length > 0) {
        cell.gold_present++;
      } else {
        cell.gold_missing.push(slug);
      }
    }
    if (cell.gold_missing.length > 0) {
      cell.invalid_reasons.push(`gold slugs missing from index: ${cell.gold_missing.join(', ')}`);
      for (const q of queries) {
        const goldPath = goldPathByQueryId.get(q.id)!;
        const importErr = ingestErrors.get(goldPath);
        // Gold file import threw → gbrain (SUT) failed on real input: scored
        // 0. Gold missing without an import error → our slug/corpus bug.
        if (cell.gold_missing.includes(goldSlugByQueryId.get(q.id)!) && importErr) {
          acc.error(probeId(q), 'sut', `cell ${name}: gold file failed to import: ${importErr}`);
        } else {
          acc.error(probeId(q), 'harness', `cell ${name}: cell aborted, gold slug(s) missing from index (${cell.gold_missing.length})`);
        }
      }
      cell.query_errors = queries.length;
      return cell;
    }

    const rrs: number[] = [];
    const top1s: boolean[] = [];
    const r5s: number[] = [];
    const latencies: number[] = [];

    for (const q of queries) {
      const goldSlug = goldSlugByQueryId.get(q.id)!;
      const gold = new Set([goldSlug]);
      let results: SearchResult[] = [];
      let meta: HybridSearchMeta | undefined;
      const t = Date.now();
      console.log = () => {};
      try {
        results = await hybridSearch(engine, q.text, {
          limit: CHUNK_FETCH,
          onMeta: (m: HybridSearchMeta) => { meta = m; },
        });
      } catch (e: any) {
        cell.query_errors++;
        acc.error(probeId(q), 'dependency', `cell ${name} query ${q.id}: hybridSearch failed: ${e?.message ?? e}`);
        continue;
      } finally {
        console.log = origLog;
      }
      const ms = Date.now() - t;

      // Pin verification per query: resolved mode must match; the reranker
      // must not have fired in an embedder-only comparison.
      if (meta?.mode && meta.mode !== pinned['search.mode']) {
        cell.query_errors++;
        cell.invalid_reasons.push(`mode pin failed on ${q.id}`);
        acc.error(probeId(q), 'harness', `cell ${name} query ${q.id}: resolved mode '${meta.mode}' != pinned '${pinned['search.mode']}'`);
        continue;
      }
      const rerankFired = results.some(r => typeof (r as { rerank_score?: number }).rerank_score === 'number');
      if (rerankFired) {
        cell.rerank_scored_queries++;
        cell.query_errors++;
        cell.invalid_reasons.push(`reranker pin failed on ${q.id}`);
        acc.error(probeId(q), 'harness', `cell ${name} query ${q.id}: reranker fired despite search.reranker.enabled=false pin`);
        continue;
      }
      const stages = (meta?.degraded ?? []).map(d => d.stage);
      const vectorDegraded = meta?.vector_enabled === false || stages.some(s => DEGRADED_VECTOR_STAGES.has(s));
      if (vectorDegraded) {
        cell.degraded_queries++;
        cell.query_errors++;
        acc.error(probeId(q), 'dependency', `cell ${name} query ${q.id}: vector arm degraded (${stages.join(',') || 'vector_enabled=false'}) — keyword-only under an embedder label`);
        continue;
      }

      // Chunk → page normalization, then exact-slug metrics (metrics.ts).
      const pageIds = uniqueInOrder(results.map(r => r.slug));
      const rank = rankOfFirstHit(pageIds, gold);
      const rr = reciprocalRank(pageIds, gold);
      const top1 = rank === 1;
      const r5 = recallAnyAtK(pageIds, gold, K_RECALL);
      acc.score(probeId(q), rr);
      cell.queries_scored++;
      rrs.push(rr);
      top1s.push(top1);
      r5s.push(r5);
      latencies.push(ms);
      cell.per_query.push({ id: q.id, rank: Number.isFinite(rank) ? rank : null, top1, ms });
    }

    if (rrs.length > 0) {
      cell.mrr = rrs.reduce((a, b) => a + b, 0) / rrs.length;
      cell.top1_hits = top1s.filter(Boolean).length;
      cell.recall_at_5 = r5s.reduce((a, b) => a + b, 0) / r5s.length;
      cell.mean_query_ms = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      cell.p50_query_ms = percentile(latencies, 50);
    }
    if (cell.query_errors > 0 && cell.invalid_reasons.length === 0) {
      cell.invalid_reasons.push(`${cell.query_errors} query error(s) (${cell.degraded_queries} degraded-to-keyword)`);
    }
    cell.valid = cell.query_errors === 0 && cell.queries_scored === queries.length && cell.gold_missing.length === 0;
    return cell;
  } finally {
    console.log = origLog;
    await engine.disconnect().catch(() => {});
  }
}

// ─── Verdict ─────────────────────────────────────────────────────────

export function computeVerdict(
  cells: ProviderCell[],
  requested: number,
  minMrr: number,
  opts: { requireGoldRetrieved?: boolean } = {},
): { verdict: 'pass' | 'partial' | 'fail'; reasons: string[] } {
  const valid = cells.filter(c => c.valid);
  if (valid.length === 0) {
    return { verdict: 'fail', reasons: ['no valid cell (gold missing, errors, or pins violated everywhere)'] };
  }
  if (cells.length < requested || valid.length < cells.length) {
    return {
      verdict: 'partial',
      reasons: [`${valid.length}/${requested} cells valid — invalid: ${cells.filter(c => !c.valid).map(c => `${c.cell} (${c.invalid_reasons.join('; ') || 'missing'})`).join(', ')}`],
    };
  }
  const below = valid.filter(c => (c.mrr ?? 0) < minMrr);
  if (below.length > 0) {
    return { verdict: 'fail', reasons: [`MRR below ${minMrr} floor: ${below.map(c => `${c.cell}=${(c.mrr ?? 0).toFixed(3)}`).join(', ')}`] };
  }
  if (opts.requireGoldRetrieved) {
    const unretrieved = valid.flatMap(c => c.per_query.filter(p => p.rank === null).map(p => `${c.cell}:${p.id}`));
    if (unretrieved.length > 0) {
      return { verdict: 'fail', reasons: [`gold page not retrieved at any rank (top-${CHUNK_FETCH}): ${unretrieved.join(', ')}`] };
    }
  }
  return { verdict: 'pass', reasons: [`all ${valid.length} cells valid with MRR >= ${minMrr}${opts.requireGoldRetrieved ? ' and every gold page retrieved' : ''}`] };
}

// ─── Full run ────────────────────────────────────────────────────────

export interface Cat21Options {
  cells?: string[];
  queries?: CodeQuery[];
  distractors?: number;
  /** Hermetic mode: deterministic hash-embed transport, no provider keys. */
  stubEmbed?: boolean;
  /** Test hook replicating the old slice(0,60) bug: ingest distractors only.
   *  The gold-presence assertion must abort every cell → verdict fail. */
  excludeGold?: boolean;
  allowSkip?: boolean;
  minMrr?: number;
  reportsDir?: string;
  quiet?: boolean;
}

export interface Cat21RunResult {
  receipt: Receipt;
  cells: ProviderCell[];
  exitCode: number;
  receiptFile: string;
}

export function optionsFromEnv(argv: string[] = process.argv.slice(2)): Cat21Options {
  return {
    cells: process.env.CAT21_CELLS ? process.env.CAT21_CELLS.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    stubEmbed: argv.includes('--stub-embed') || process.env.CAT21_STUB_EMBED === '1',
    allowSkip: argv.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    distractors: process.env.CAT21_DISTRACTORS ? parseInt(process.env.CAT21_DISTRACTORS, 10) : undefined,
    minMrr: process.env.CAT21_MIN_MRR ? parseFloat(process.env.CAT21_MIN_MRR) : undefined,
  };
}

export async function runCat21(options: Cat21Options = {}): Promise<Cat21RunResult> {
  const startedAt = new Date().toISOString();
  const cellNames = options.cells ?? CELLS_DEFAULT;
  const queries = options.queries ?? QUERIES;
  const nDistractors = options.distractors ?? DEFAULT_DISTRACTORS;
  // Mode-aware gate: live runs grade embedder quality; stub runs grade
  // plumbing (the hash transport is not any provider's model).
  const minMrr = options.minMrr ?? (options.stubEmbed ? DEFAULT_MIN_MRR_STUB : DEFAULT_MIN_MRR_LIVE);
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT21_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);

  const home = join(tmpdir(), `cat21-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env.GBRAIN_HOME = home;

  for (const c of cellNames) cellConfig(c); // fail fast on unknown cells

  const expected = cellNames.length * queries.length;
  const baseReceipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT21_CATEGORY,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
  } as const;

  if (!options.stubEmbed) {
    const missing = cellNames
      .map(c => PROVIDER_ENV_KEY[c])
      .filter((k): k is string => k !== undefined && !process.env[k]);
    if (missing.length > 0) {
      const receipt: Receipt = {
        ...baseReceipt,
        run_status: 'skipped',
        skip_reason: `missing provider keys: ${[...new Set(missing)].join(', ')} (run with --stub-embed for a hermetic plumbing check)`,
        n_total: expected,
        n_scored: 0,
        completion_rate: 0,
        errors: [],
        publishable: false,
        finished_at: new Date().toISOString(),
      };
      writeReceipt(receiptFile, receipt);
      log(`[cat21] SKIPPED: ${receipt.skip_reason}\n[cat21] receipt: ${receiptFile}\n`);
      return { receipt, cells: [], exitCode: options.allowSkip ? 0 : 1, receiptFile };
    }
  } else {
    for (const k of Object.values(PROVIDER_ENV_KEY)) {
      if (!process.env[k]) process.env[k] = 'dummy-stub-embed';
    }
    __setEmbedTransportForTests(makeHashEmbedTransport());
  }

  // Corpus: gold files (asserted unique) + deterministic distractors.
  const allFiles = walkTs(SRC_ROOT);
  const goldPathByQueryId = resolveGoldFiles(allFiles, queries);
  const goldSlugByQueryId = new Map([...goldPathByQueryId].map(([qid, p]) => [qid, fileSlug(p)]));
  const goldPaths = new Set(goldPathByQueryId.values());
  const distractors = pickDistractors(allFiles, goldPaths, nDistractors);
  const files = options.excludeGold ? distractors : [...goldPaths, ...distractors];
  log(`[cat21] corpus: ${files.length} files (${options.excludeGold ? 0 : goldPaths.size} gold + ${distractors.length} distractors of ${allFiles.length} walked)${options.stubEmbed ? ' [STUB EMBED — not a provider comparison]' : ''}\n`);

  const acc = new ProbeAccounting(expected);
  const cells: ProviderCell[] = [];
  try {
    for (const name of cellNames) {
      log(`[cat21] cell=${name}...\n`);
      try {
        const cell = await runCell({ name, files, queries, goldSlugByQueryId, goldPathByQueryId, acc });
        cells.push(cell);
        log(`[cat21]   ${name}: valid=${cell.valid} gold=${cell.gold_present}/${queries.length} top1=${cell.top1_hits ?? 'n/a'}/${cell.queries_scored} MRR=${cell.mrr?.toFixed(3) ?? 'n/a'} R@5=${cell.recall_at_5 !== null ? (cell.recall_at_5 * 100).toFixed(1) + '%' : 'n/a'} errors=${cell.query_errors}\n`);
      } catch (e: any) {
        for (const q of queries) acc.error(`${name}:${q.id}`, 'harness', `cell ${name} crashed: ${e?.message ?? e}`);
        const { embedder, dim } = cellConfig(name);
        cells.push({
          cell: name, embedder, dim,
          files_planned: files.length, files_ok: 0, files_failed: 0, first_ingest_error: null,
          gold_present: 0, gold_missing: [],
          queries_total: queries.length, queries_scored: 0, query_errors: queries.length,
          degraded_queries: 0, rerank_scored_queries: 0,
          top1_hits: null, mrr: null, recall_at_5: null,
          mean_query_ms: null, p50_query_ms: null, ingest_ms: 0,
          valid: false, invalid_reasons: [`cell crashed: ${String(e?.message ?? e).slice(0, 300)}`],
          per_query: [],
        });
        log(`[cat21]   ${name}: CRASH ${e?.message ?? e}\n`);
      }
    }
  } finally {
    if (options.stubEmbed) __setEmbedTransportForTests(null);
  }

  const summary = acc.summary();
  const validCells = cells.filter(c => c.valid);
  const comparisonValid = validCells.length === cellNames.length && validCells.length >= 2 && !options.stubEmbed;
  const bestMrr = comparisonValid ? validCells.reduce((a, b) => ((a.mrr ?? 0) >= (b.mrr ?? 0) ? a : b)).cell : null;

  const { verdict, reasons } = computeVerdict(cells, cellNames.length, minMrr, {
    requireGoldRetrieved: options.stubEmbed === true,
  });
  const runInvalid = summary.run_invalid;
  const publishable = summary.publishable
    && !options.stubEmbed
    && validCells.length === cellNames.length;

  const receipt: Receipt = {
    ...baseReceipt,
    run_status: runInvalid ? 'error' : 'completed',
    ...(runInvalid ? {} : { verdict }),
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable,
    resolved_config: {
      search_mode: PINNED_CONFIG['search.mode'],
      reranker_enabled: false,
      pinned_config: PINNED_CONFIG,
      embed_transport: options.stubEmbed ? 'stubbed-hash' : 'live',
      max_file_chars: MAX_FILE_CHARS,
      distractors: distractors.length,
      exclude_gold: options.excludeGold ?? false,
      chunk_fetch_limit: CHUNK_FETCH,
      min_mrr_gate: minMrr,
      min_mrr_gate_mode: options.stubEmbed ? 'stub-plumbing' : 'live-quality',
      cells: Object.fromEntries(cells.map(c => [c.cell, { embedder: c.embedder, dim: c.dim }])),
      corpus: 'gbrain-src-core',
    },
    finished_at: new Date().toISOString(),
    data: {
      cells,
      comparison: {
        valid: comparisonValid,
        over_cells: validCells.map(c => c.cell),
        best_by_mrr: bestMrr,
        note: options.stubEmbed ? 'stub transport is identical in both cells — never a provider comparison' : null,
      },
      verdict_reasons: reasons,
      queries: queries.length,
      infra_error_rate: summary.infra_error_rate,
    },
  };
  writeReceipt(receiptFile, receipt);

  const outDir = join(reportsDir, CAT21_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat21.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat21] ─── Scorecard ───────────────────\n`);
  for (const c of cells) {
    log(`[cat21]   ${c.cell.padEnd(16)} valid=${String(c.valid).padEnd(5)} gold=${c.gold_present}/${c.queries_total} top1=${c.top1_hits ?? 'n/a'}/${c.queries_scored}  MRR=${c.mrr?.toFixed(3) ?? '  n/a'}  R@5=${c.recall_at_5 !== null ? (c.recall_at_5 * 100).toFixed(1) + '%' : 'n/a'}  ingest=${c.files_ok}/${c.files_planned}\n`);
  }
  log(`[cat21]   run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'} publishable=${publishable}\n`);
  log(`[cat21]   receipt: ${receiptFile}\n`);

  const exitCode = runInvalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, cells, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat21(optionsFromEnv());
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT21_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT21_CATEGORY,
        run_status: 'error',
        n_total: 0,
        n_scored: 0,
        completion_rate: 0,
        errors: [{ probe_id: 'preflight', origin: 'harness', message: String(e?.message ?? e).slice(0, 500) }],
        publishable: false,
        gbrain_version: gbrainVersionResolved(),
        gbrain_pin: gbrainPin(),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });
    } catch { /* receipt write failed too — exit code carries the failure */ }
    process.stderr.write(`[cat21] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
