/**
 * BrainBench Cat 18b — embedding × reranker matrix on synthetic-v1.
 *
 * Six cells: {OpenAI 1536d, Voyage 1024d, ZeroEntropy zembed-1 2560d} ×
 * {reranker off, zerank-2 on}. Cat 18 (parent) is the embedder-only
 * baseline; this matrix isolates what the cross-encoder reranker adds on
 * top of each embedder.
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: gbrain's config-resolved reranker path — search.mode is pinned
 * to 'balanced' in EVERY cell and the ± axis toggles ONLY
 * `search.reranker.enabled` / `search.reranker.model` (+ top_n_in sizing),
 * via engine.setConfig before ingest (WS5). The previous version switched
 * the whole mode bundle (balanced ↔ tokenmax), so the "± reranker" delta
 * also flipped query expansion, token budget, contextual-retrieval tier and
 * searchLimit (audit cats18-21-05) — that confound is gone.
 * RERANK FAIL-OPEN IS DETECTED, NOT TRUSTED: gbrain's applyReranker returns
 * input unchanged on ANY reranker error (auth, network, provider sunset).
 * Every '+rerank' query is checked for stamped rerank_score; a query where
 * the reranker verifiably did not run is recorded as a dependency failure
 * and the cell is marked invalid — a broken key can no longer publish
 * unreranked numbers under a '+rerank' label (audit cats18-21-06). Note:
 * zerank-2's hosted API sunsets 2026-09-04; live runs after that date will
 * correctly report every '+rerank' cell as degraded.
 * LEGITIMATELY SEEDED/STUBBED: the synthetic-v1 corpus + derived queries
 * (fixtures); under --stub, the embed transport (deterministic feature-hash
 * vectors) AND the rerank HTTP transport (deterministic token-overlap
 * scores) via gateway test seams. Stub runs exercise the full pipeline
 * hermetically and are stamped publishable:false.
 *
 * ── Scoring policy (WS0) ─────────────────────────────────────────────
 * Same as Cat 18: metrics.ts on page-normalized unique ids (no duplicate
 * chunk-row inflation — audit cats18-21-04), probe-accounting for every
 * failure (ingest and query errors are counted and typed, never swallowed
 * by a bare catch — audit cats18-21-06), embed-coverage evidence queried
 * from the engine, invalid cells excluded from winner_by_axis (never
 * compared at unequal n).
 *
 * ── Verdict (real + failable) ────────────────────────────────────────
 * pass    — every requested cell valid (full embed coverage, zero query
 *           errors, reranker verified fired in '+rerank' cells and verified
 *           silent in baseline cells) AND per-cell Recall@10 >= minRecall.
 * partial — at least one valid cell. fail — none. Non-pass exits non-zero.
 * Missing keys → receipt 'skipped' + non-zero exit unless --allow-skip.
 *
 * Run:
 *   bun eval/runner/cat18b-embedding-rerank-matrix.ts
 *   CAT18B_CELLS=openai-1536,openai-1536+rerank bun eval/runner/cat18b-embedding-rerank-matrix.ts
 *   bun eval/runner/cat18b-embedding-rerank-matrix.ts --stub   # hermetic, no keys
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import {
  configureGateway,
  __setEmbedTransportForTests,
  __setRerankTransportForTests,
} from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
import type { SearchResult, HybridSearchMeta } from 'gbrain/types';
import { loadSyntheticV1, syntheticQueries, type SyntheticPage, type SyntheticQuery } from './synthetic-corpus-loader.ts';
import { percentile } from './metrics.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';
import {
  scoreQuery,
  makeHashEmbedTransport,
  computeVerdict,
  K,
  CHUNK_FETCH,
  DEFAULT_MIN_RECALL,
} from './cat18-embedding-providers.ts';

export const CAT18B_CATEGORY = 'cat18b-embedding-rerank-matrix';

// Per-MTok pricing (USD) — sourced from each provider's public pricing page.
export const PRICING: Record<string, number> = {
  'openai:text-embedding-3-large': 0.13,
  'voyage:voyage-3-large': 0.18,
  'zeroentropyai:zembed-1': 0.05,
};

/**
 * WS5 pin — constant across ALL cells so the ± axis is the reranker alone.
 * expansion/autocut pinned off (autocut consumes rerank scores and trims the
 * ranked list; leaving it on would fold a second effect into the ± delta),
 * tokenBudget unbounded so packing never drops ranked results.
 */
export const PINNED_BASE: Record<string, string> = {
  'search.mode': 'balanced',
  'search.expansion': 'false',
  'search.autocut': 'false',
  'search.tokenBudget': '1000000',
};

export interface ProviderSpec {
  name: string;
  embedder: string;
  embed_dim: number;
  reranker: string | null;
}

export const CELLS: ProviderSpec[] = [
  { name: 'openai-1536',        embedder: 'openai:text-embedding-3-large', embed_dim: 1536, reranker: null },
  { name: 'openai-1536+rerank', embedder: 'openai:text-embedding-3-large', embed_dim: 1536, reranker: 'zeroentropyai:zerank-2' },
  { name: 'voyage-1024',        embedder: 'voyage:voyage-3-large',         embed_dim: 1024, reranker: null },
  { name: 'voyage-1024+rerank', embedder: 'voyage:voyage-3-large',         embed_dim: 1024, reranker: 'zeroentropyai:zerank-2' },
  { name: 'ze-2560',            embedder: 'zeroentropyai:zembed-1',        embed_dim: 2560, reranker: null },
  { name: 'ze-2560+rerank',     embedder: 'zeroentropyai:zembed-1',        embed_dim: 2560, reranker: 'zeroentropyai:zerank-2' },
];

/** The reranker-axis keys — the ONLY config that differs between ± pairs. */
export function rerankAxisConfig(spec: ProviderSpec): Record<string, string> {
  if (!spec.reranker) return { 'search.reranker.enabled': 'false' };
  return {
    'search.reranker.enabled': 'true',
    'search.reranker.model': spec.reranker,
    // Size the rerank window to the chunk fetch so the cross-encoder scores
    // the full candidate pool we measure over.
    'search.reranker.top_n_in': String(CHUNK_FETCH),
  };
}

const EMBEDDER_ENV_KEY: Record<string, string> = {
  'openai:text-embedding-3-large': 'OPENAI_API_KEY',
  'voyage:voyage-3-large': 'VOYAGE_API_KEY',
  'zeroentropyai:zembed-1': 'ZEROENTROPY_API_KEY',
};

// ─── Hermetic rerank stub ────────────────────────────────────────────

/**
 * Deterministic rerank transport for __setRerankTransportForTests: scores
 * each document by unique-token overlap with the query. Exercises the REAL
 * config-resolution → applyReranker → gateway.rerank wire path (auth header
 * assembly, payload cap, response parsing) without HTTP. `respondWith` lets
 * regression tests force fail-open (e.g. a 401 Response).
 */
export function makeOverlapRerankTransport(respondWith?: () => Response | null) {
  return (async (_url: string, init: { body?: unknown }) => {
    const forced = respondWith?.();
    if (forced) return forced;
    const body = JSON.parse(String(init.body ?? '{}')) as { query?: string; documents?: string[] };
    const qToks = new Set((body.query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1));
    const results = (body.documents ?? [])
      .map((d, index) => {
        const dToks = new Set(d.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1));
        let overlap = 0;
        for (const t of dToks) if (qToks.has(t)) overlap++;
        return { index, relevance_score: qToks.size > 0 ? overlap / qToks.size : 0 };
      })
      .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
    return new Response(JSON.stringify({ results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as Parameters<typeof __setRerankTransportForTests>[0];
}

// ─── Cell report ─────────────────────────────────────────────────────

export interface MatrixCell {
  cell: string;
  embedder: string;
  embed_dim: number;
  reranker: string | null;
  pinned_config: Record<string, string>;
  // Embed-coverage evidence (queried from the engine).
  ingest_ok: number;
  ingest_fail: number;
  first_ingest_error: string | null;
  pages_total: number;
  pages_embedded: number;
  chunks_total: number;
  chunks_embedded: number;
  embedding_column: string | null;
  // Query accounting.
  queries_total: number;
  queries_scored: number;
  query_errors: number;
  degraded_queries: number;
  /** Queries where >=1 result carried a rerank_score (reranker verifiably ran). */
  rerank_scored_queries: number;
  /** '+rerank' queries where the reranker verifiably did NOT run (fail-open). */
  rerank_failopen_queries: number;
  // Metrics over scored queries.
  mrr: number | null;
  recall_at_10: number | null;
  top1_hit_rate: number | null;
  mean_query_ms: number | null;
  p50_query_ms: number | null;
  ingest_ms: number;
  embed_cost_per_mtok: number;
  est_corpus_cost_usd: number;
  valid: boolean;
  invalid_reasons: string[];
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const DEGRADED_VECTOR_STAGES = new Set(['embed_unavailable', 'embed_timeout', 'vector_arm_failed', 'rescore_skipped']);

export interface RunMatrixCellOptions {
  k?: number;
  chunkFetch?: number;
  /** Stub mode: suppress the zerank-2 sunset short-circuit via base_urls so
   *  hermetic runs stay stable past the provider's shutdown date. */
  stub?: boolean;
}

export async function runMatrixCell(
  spec: ProviderSpec,
  pages: SyntheticPage[],
  queries: SyntheticQuery[],
  acc: ProbeAccounting,
  opts: RunMatrixCellOptions = {},
): Promise<MatrixCell> {
  const k = opts.k ?? K;
  const chunkFetch = opts.chunkFetch ?? CHUNK_FETCH;
  const pinned = { ...PINNED_BASE, ...rerankAxisConfig(spec) };
  const expectRerank = spec.reranker !== null;
  const probeId = (q: SyntheticQuery): string => `${spec.name}:${q.id}`;
  const pricePerMTok = PRICING[spec.embedder] ?? 0;

  const cell: MatrixCell = {
    cell: spec.name, embedder: spec.embedder, embed_dim: spec.embed_dim, reranker: spec.reranker,
    pinned_config: pinned,
    ingest_ok: 0, ingest_fail: 0, first_ingest_error: null,
    pages_total: 0, pages_embedded: 0, chunks_total: 0, chunks_embedded: 0,
    embedding_column: null,
    queries_total: queries.length, queries_scored: 0, query_errors: 0,
    degraded_queries: 0, rerank_scored_queries: 0, rerank_failopen_queries: 0,
    mrr: null, recall_at_10: null, top1_hit_rate: null,
    mean_query_ms: null, p50_query_ms: null, ingest_ms: 0,
    embed_cost_per_mtok: pricePerMTok, est_corpus_cost_usd: 0,
    valid: false, invalid_reasons: [],
  };

  configureGateway({
    embedding_model: spec.embedder,
    embedding_dimensions: spec.embed_dim,
    reranker_model: spec.reranker ?? undefined,
    // Stub runs set a base-URL override for the reranker recipe: the rerank
    // transport is stubbed (never fetches), and the override suppresses the
    // post-sunset short-circuit so hermetic runs don't start failing on
    // 2026-09-04. Live runs keep real sunset behavior (detected as fail-open).
    ...(opts.stub ? { base_urls: { zeroentropyai: 'http://cat18b-stub.invalid' } } : {}),
    env: process.env as Record<string, string | undefined>,
  });

  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  try {
    // WS5: pin the full search config per cell BEFORE ingest.
    for (const [key, value] of Object.entries(pinned)) {
      await engine.setConfig(key, value);
    }

    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    const tIngest = Date.now();
    let totalChars = 0;
    try {
      for (const p of pages) {
        totalChars += p.body.length;
        try {
          await importFromContent(engine, p.slug, p.body, { noEmbed: false });
          cell.ingest_ok++;
        } catch (e: any) {
          cell.ingest_fail++;
          if (!cell.first_ingest_error) cell.first_ingest_error = String(e?.message ?? e).slice(0, 300);
        }
      }
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    cell.ingest_ms = Date.now() - tIngest;
    cell.est_corpus_cost_usd = (totalChars / 3.5 / 1_000_000) * pricePerMTok;

    const cov = await engine.executeRaw(
      `SELECT (SELECT COUNT(*)::int FROM pages) AS pages_total,
              (SELECT COUNT(DISTINCT page_id)::int FROM content_chunks WHERE embedding IS NOT NULL) AS pages_embedded,
              (SELECT COUNT(*)::int FROM content_chunks) AS chunks_total,
              (SELECT COUNT(embedding)::int FROM content_chunks) AS chunks_embedded`,
      [],
    ) as Array<{ pages_total: number; pages_embedded: number; chunks_total: number; chunks_embedded: number }>;
    cell.pages_total = cov[0]?.pages_total ?? 0;
    cell.pages_embedded = cov[0]?.pages_embedded ?? 0;
    cell.chunks_total = cov[0]?.chunks_total ?? 0;
    cell.chunks_embedded = cov[0]?.chunks_embedded ?? 0;

    const coverageComplete = cell.ingest_fail === 0
      && cell.chunks_total > 0
      && cell.chunks_embedded === cell.chunks_total;
    if (!coverageComplete) {
      cell.invalid_reasons.push(
        `embed coverage incomplete: ingest ${cell.ingest_ok}/${pages.length} ok, ` +
        `chunks ${cell.chunks_embedded}/${cell.chunks_total} embedded` +
        (cell.first_ingest_error ? ` (first error: ${cell.first_ingest_error})` : ''),
      );
      for (const q of queries) {
        acc.error(probeId(q), 'dependency', `cell ${spec.name}: ${cell.invalid_reasons[0]}`);
      }
      cell.query_errors = queries.length;
      return cell;
    }

    const recalls: number[] = [];
    const rrs: number[] = [];
    const top1s: boolean[] = [];
    const latencies: number[] = [];

    for (const q of queries) {
      let results: SearchResult[] = [];
      let meta: HybridSearchMeta | undefined;
      const t = Date.now();
      console.log = () => {};
      try {
        results = await hybridSearch(engine, q.text, {
          limit: chunkFetch,
          onMeta: (m: HybridSearchMeta) => { meta = m; },
        });
      } catch (e: any) {
        cell.query_errors++;
        acc.error(probeId(q), 'dependency', `cell ${spec.name} query ${q.id}: hybridSearch failed: ${e?.message ?? e}`);
        continue;
      } finally {
        console.log = origLog;
      }
      const ms = Date.now() - t;

      if (cell.embedding_column === null && meta?.embedding_column) cell.embedding_column = meta.embedding_column;

      if (meta?.mode && meta.mode !== pinned['search.mode']) {
        cell.query_errors++;
        acc.error(probeId(q), 'harness', `cell ${spec.name} query ${q.id}: resolved mode '${meta.mode}' != pinned '${pinned['search.mode']}'`);
        cell.invalid_reasons.push(`mode pin failed on ${q.id}`);
        continue;
      }

      // Reranker verification — both directions. gbrain stamps rerank_score
      // on results the cross-encoder actually scored; fail-open leaves the
      // RRF order unstamped.
      const rerankFired = results.some(r => typeof (r as any).rerank_score === 'number');
      if (rerankFired) cell.rerank_scored_queries++;
      if (expectRerank && results.length > 0 && !rerankFired) {
        cell.rerank_failopen_queries++;
        cell.query_errors++;
        acc.error(
          probeId(q), 'dependency',
          `cell ${spec.name} query ${q.id}: reranker did not run (fail-open) — unreranked result under a '+rerank' label`,
        );
        continue;
      }
      if (!expectRerank && rerankFired) {
        cell.query_errors++;
        acc.error(probeId(q), 'harness', `cell ${spec.name} query ${q.id}: reranker fired despite search.reranker.enabled=false pin`);
        cell.invalid_reasons.push(`reranker pin failed on ${q.id}`);
        continue;
      }

      const stages = (meta?.degraded ?? []).map(d => d.stage);
      const vectorDegraded = meta?.vector_enabled === false || stages.some(s => DEGRADED_VECTOR_STAGES.has(s));
      if (vectorDegraded) {
        cell.degraded_queries++;
        cell.query_errors++;
        acc.error(
          probeId(q), 'dependency',
          `cell ${spec.name} query ${q.id}: vector arm degraded (${stages.join(',') || 'vector_enabled=false'}) — keyword-only result under an embedder label`,
        );
        continue;
      }

      const s = scoreQuery(results.map(r => r.slug), q.relevant_slugs, k);
      if (Number.isNaN(s.recall)) {
        cell.query_errors++;
        acc.error(probeId(q), 'harness', `cell ${spec.name} query ${q.id}: empty relevant set`);
        continue;
      }
      acc.score(probeId(q), s.recall);
      cell.queries_scored++;
      recalls.push(s.recall);
      rrs.push(s.rr);
      top1s.push(s.top1);
      latencies.push(ms);
    }

    cell.recall_at_10 = mean(recalls);
    cell.mrr = mean(rrs);
    cell.top1_hit_rate = top1s.length > 0 ? top1s.filter(Boolean).length / top1s.length : null;
    cell.mean_query_ms = mean(latencies);
    cell.p50_query_ms = latencies.length > 0 ? percentile(latencies, 50) : null;
    if (cell.query_errors > 0 && cell.invalid_reasons.length === 0) {
      cell.invalid_reasons.push(
        `${cell.query_errors} query error(s): ${cell.degraded_queries} degraded-to-keyword, ` +
        `${cell.rerank_failopen_queries} rerank fail-open, rest thrown`,
      );
    }
    cell.valid = cell.query_errors === 0 && cell.queries_scored === queries.length;
    return cell;
  } finally {
    await engine.disconnect();
  }
}

// ─── Full run ────────────────────────────────────────────────────────

export interface Cat18bOptions {
  cells?: ProviderSpec[];
  pages?: SyntheticPage[];
  queries?: SyntheticQuery[];
  /** Hermetic mode: stub embed + rerank transports, no provider keys needed. */
  stub?: boolean;
  /** Test hook: force embed-transport failures. */
  stubEmbedFailOn?: (text: string) => boolean;
  /** Test hook: force the rerank transport's next responses (e.g. a 401). */
  stubRerankRespondWith?: () => Response | null;
  allowSkip?: boolean;
  minRecall?: number;
  reportsDir?: string;
  limitPages?: number;
  quiet?: boolean;
}

export interface Cat18bRunResult {
  receipt: Receipt;
  cells: MatrixCell[];
  exitCode: number;
  receiptFile: string;
}

export function optionsFromEnv(argv: string[] = process.argv.slice(2)): Cat18bOptions {
  const filter = process.env.CAT18B_CELLS?.split(',').map(s => s.trim()).filter(Boolean);
  return {
    cells: filter ? CELLS.filter(c => filter.includes(c.name)) : undefined,
    stub: argv.includes('--stub') || process.env.CAT18B_STUB === '1',
    allowSkip: argv.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    limitPages: process.env.CAT18B_LIMIT_PAGES ? parseInt(process.env.CAT18B_LIMIT_PAGES, 10) : undefined,
    minRecall: process.env.CAT18B_MIN_RECALL ? parseFloat(process.env.CAT18B_MIN_RECALL) : undefined,
  };
}

export async function runCat18b(options: Cat18bOptions = {}): Promise<Cat18bRunResult> {
  const startedAt = new Date().toISOString();
  const specs = options.cells ?? CELLS;
  const minRecall = options.minRecall ?? DEFAULT_MIN_RECALL;
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT18B_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);

  // Isolate GBRAIN_HOME so the user's file-plane embedding pin can't
  // override per-cell gateway/registry resolution.
  const home = join(tmpdir(), `cat18b-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env.GBRAIN_HOME = home;

  const allPages = options.pages ?? loadSyntheticV1();
  const pages = options.limitPages ? allPages.slice(0, options.limitPages) : allPages;
  const queries = options.queries ?? syntheticQueries(pages);
  const totalChars = pages.reduce((a, p) => a + p.body.length, 0);
  const expected = specs.length * queries.length;

  const baseReceipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT18B_CATEGORY,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
  } as const;

  if (!options.stub) {
    const needed = new Set<string>();
    for (const s of specs) {
      const embedKey = EMBEDDER_ENV_KEY[s.embedder];
      if (embedKey) needed.add(embedKey);
      if (s.reranker?.startsWith('zeroentropyai:')) needed.add('ZEROENTROPY_API_KEY');
      if (s.reranker?.startsWith('voyage:')) needed.add('VOYAGE_API_KEY');
    }
    const missing = [...needed].filter(k => !process.env[k]);
    if (missing.length > 0) {
      const receipt: Receipt = {
        ...baseReceipt,
        run_status: 'skipped',
        skip_reason: `missing provider keys: ${missing.join(', ')} (run with --stub for a hermetic plumbing check)`,
        n_total: expected,
        n_scored: 0,
        completion_rate: 0,
        errors: [],
        publishable: false,
        finished_at: new Date().toISOString(),
      };
      writeReceipt(receiptFile, receipt);
      log(`[cat18b] SKIPPED: ${receipt.skip_reason}\n[cat18b] receipt: ${receiptFile}\n`);
      return { receipt, cells: [], exitCode: options.allowSkip ? 0 : 1, receiptFile };
    }
  } else {
    for (const k of ['OPENAI_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY']) {
      if (!process.env[k]) process.env[k] = 'dummy-stub';
    }
    __setEmbedTransportForTests(makeHashEmbedTransport(options.stubEmbedFailOn));
    __setRerankTransportForTests(makeOverlapRerankTransport(options.stubRerankRespondWith));
  }

  const acc = new ProbeAccounting(expected);
  const cells: MatrixCell[] = [];
  log(`[cat18b] corpus: ${pages.length} pages, ${totalChars} chars, queries: ${queries.length}, cells: ${specs.map(s => s.name).join(',')}${options.stub ? ' [STUB TRANSPORTS — not a provider comparison]' : ''}\n`);

  try {
    for (const spec of specs) {
      log(`[cat18b] cell=${spec.name}...\n`);
      try {
        const c = await runMatrixCell(spec, pages, queries, acc, { stub: options.stub });
        cells.push(c);
        log(`[cat18b]   ${spec.name.padEnd(22)} valid=${c.valid} MRR=${c.mrr?.toFixed(3) ?? 'n/a'} R@${K}=${c.recall_at_10 !== null ? (c.recall_at_10 * 100).toFixed(1) + '%' : 'n/a'} rerank_fired=${c.rerank_scored_queries}/${c.queries_total} errors=${c.query_errors}\n`);
      } catch (e: any) {
        for (const q of queries) acc.error(`${spec.name}:${q.id}`, 'harness', `cell ${spec.name} crashed: ${e?.message ?? e}`);
        cells.push({
          cell: spec.name, embedder: spec.embedder, embed_dim: spec.embed_dim, reranker: spec.reranker,
          pinned_config: { ...PINNED_BASE, ...rerankAxisConfig(spec) },
          ingest_ok: 0, ingest_fail: 0, first_ingest_error: null,
          pages_total: 0, pages_embedded: 0, chunks_total: 0, chunks_embedded: 0,
          embedding_column: null,
          queries_total: queries.length, queries_scored: 0, query_errors: queries.length,
          degraded_queries: 0, rerank_scored_queries: 0, rerank_failopen_queries: 0,
          mrr: null, recall_at_10: null, top1_hit_rate: null,
          mean_query_ms: null, p50_query_ms: null, ingest_ms: 0,
          embed_cost_per_mtok: PRICING[spec.embedder] ?? 0, est_corpus_cost_usd: 0,
          valid: false, invalid_reasons: [`cell crashed: ${String(e?.message ?? e).slice(0, 300)}`],
        });
        log(`[cat18b]   ${spec.name}: CRASH ${e?.message ?? e}\n`);
      }
    }
  } finally {
    if (options.stub) {
      __setEmbedTransportForTests(null);
      __setRerankTransportForTests(null);
    }
  }

  const summary = acc.summary();
  const validCells = cells.filter(c => c.valid);
  const comparisonValid = validCells.length === specs.length && validCells.length >= 2;

  const bestBy = (get: (c: MatrixCell) => number | null, dir: 'max' | 'min'): string | null => {
    if (!comparisonValid) return null;
    return validCells.reduce((a, b) => {
      const va = get(a) ?? (dir === 'max' ? -Infinity : Infinity);
      const vb = get(b) ?? (dir === 'max' ? -Infinity : Infinity);
      return dir === 'max' ? (va >= vb ? a : b) : (va <= vb ? a : b);
    }).cell;
  };
  const winner = {
    recall_at_10: bestBy(c => c.recall_at_10, 'max'),
    mrr: bestBy(c => c.mrr, 'max'),
    top1: bestBy(c => c.top1_hit_rate, 'max'),
    fastest_ingest: bestBy(c => c.ingest_ms, 'min'),
    fastest_query: bestBy(c => c.mean_query_ms, 'min'),
    cheapest: bestBy(c => c.est_corpus_cost_usd, 'min'),
  };

  // ± pair deltas: reranker effect per embedder, only when BOTH sides are
  // valid (same n by construction — invalid cells never enter a pair).
  const pairs: Array<{ embedder: string; baseline: string; rerank: string; recall_delta: number | null; mrr_delta: number | null; top1_delta: number | null }> = [];
  for (const base of cells.filter(c => c.reranker === null)) {
    const rr = cells.find(c => c.embedder === base.embedder && c.reranker !== null);
    if (!rr) continue;
    const bothValid = base.valid && rr.valid;
    pairs.push({
      embedder: base.embedder,
      baseline: base.cell,
      rerank: rr.cell,
      recall_delta: bothValid && base.recall_at_10 !== null && rr.recall_at_10 !== null ? rr.recall_at_10 - base.recall_at_10 : null,
      mrr_delta: bothValid && base.mrr !== null && rr.mrr !== null ? rr.mrr - base.mrr : null,
      top1_delta: bothValid && base.top1_hit_rate !== null && rr.top1_hit_rate !== null ? rr.top1_hit_rate - base.top1_hit_rate : null,
    });
  }

  const { verdict, reasons } = computeVerdict(cells, specs.length, minRecall);
  const runInvalid = summary.run_invalid;
  const publishable = summary.publishable
    && !options.stub
    && !options.limitPages
    && validCells.length === specs.length;

  const resolvedConfig: Record<string, unknown> = {
    search_mode: PINNED_BASE['search.mode'],
    pinned_base: PINNED_BASE,
    reranker_axis: Object.fromEntries(cells.map(c => [c.cell, {
      enabled: c.reranker !== null,
      model: c.reranker,
      verified_fired_queries: c.rerank_scored_queries,
      failopen_queries: c.rerank_failopen_queries,
    }])),
    embed_transport: options.stub ? 'stubbed-hash' : 'live',
    rerank_transport: options.stub ? 'stubbed-overlap' : 'live',
    k: K,
    chunk_fetch_limit: CHUNK_FETCH,
    min_recall_gate: minRecall,
    corpus: 'synthetic-v1',
    corpus_pages: pages.length,
    limit_pages: options.limitPages ?? null,
  };

  const receipt: Receipt = {
    ...baseReceipt,
    run_status: runInvalid ? 'error' : 'completed',
    ...(runInvalid ? {} : { verdict }),
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable,
    resolved_config: resolvedConfig,
    finished_at: new Date().toISOString(),
    data: {
      cells,
      pairs,
      comparison: {
        valid: comparisonValid,
        over_cells: validCells.map(c => c.cell),
        excluded_cells: cells.filter(c => !c.valid).map(c => c.cell),
        winner_by_axis: winner,
      },
      verdict_reasons: reasons,
      infra_error_rate: summary.infra_error_rate,
      total_chars: totalChars,
      queries: queries.length,
    },
  };
  writeReceipt(receiptFile, receipt);

  const outDir = join(reportsDir, CAT18B_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat18b.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat18b] ─── Scorecard ───────────────────\n`);
  log(`[cat18b]   cell                    valid  MRR    R@${K}    top1   rerank_fired  errors  cost\n`);
  for (const c of cells) {
    log(`[cat18b]   ${c.cell.padEnd(22)} ${String(c.valid).padEnd(5)}  ${c.mrr?.toFixed(3) ?? ' n/a '}  ${c.recall_at_10 !== null ? (c.recall_at_10 * 100).toFixed(1) + '%' : ' n/a '}  ${c.top1_hit_rate !== null ? (c.top1_hit_rate * 100).toFixed(1) + '%' : ' n/a '}  ${String(c.rerank_scored_queries).padStart(3)}/${c.queries_total}  ${String(c.query_errors).padStart(4)}  $${c.est_corpus_cost_usd.toFixed(4)}\n`);
  }
  log(`[cat18b]   comparison valid: ${comparisonValid}${comparisonValid ? ` — R@${K}: ${winner.recall_at_10}, MRR: ${winner.mrr}, cheapest: ${winner.cheapest}` : ` (excluded: ${cells.filter(c => !c.valid).map(c => c.cell).join(',') || 'none'})`}\n`);
  log(`[cat18b]   run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'} publishable=${publishable}\n`);
  log(`[cat18b]   receipt: ${receiptFile}\n`);

  const exitCode = runInvalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, cells, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat18b(optionsFromEnv());
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT18B_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT18B_CATEGORY,
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
    process.stderr.write(`[cat18b] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
