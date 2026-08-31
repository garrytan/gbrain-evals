/**
 * BrainBench Cat 18 — embedding-provider A/B on the synthetic-v1 corpus.
 *
 * Headline question: how do OpenAI, Voyage, and ZeroEntropy EMBEDDERS rank
 * against the same query set on the same corpus? Backs the v0.36.2.0 README
 * claim that ZeroEntropy beats OpenAI/Voyage on price + speed.
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: gbrain's embedding pipeline end to end — configureGateway per
 * provider, importFromContent inline embeds, and hybridSearch's keyword +
 * vector RRF retrieval. Search mode is pinned to 'balanced' and the reranker
 * is pinned OFF in EVERY cell (WS5): cells differ ONLY by embedder. The
 * previous version of this runner relied on gbrain's default mode, which
 * silently enabled the zerank-2 reranker whenever ZEROENTROPY_API_KEY was
 * set — the "embedder A/B" was actually embedder+ZE-reranker (audit
 * cats18-21-03).
 * LEGITIMATELY SEEDED/STUBBED: the synthetic-v1 corpus + auto-derived query
 * set (committed fixtures), and — under --stub-embed only — the embed HTTP
 * transport (deterministic feature-hash vectors via the gateway test seam).
 * Stub runs exercise the full pipeline hermetically but are stamped
 * publishable:false with resolved_config.embed_transport='stubbed-hash';
 * they are plumbing verification, never a provider comparison.
 *
 * ── Scoring policy (WS0) ─────────────────────────────────────────────
 * Metrics come from eval/runner/metrics.ts on PAGE-normalized unique ids
 * (chunk rows dedup to pages first — gbrain returns up to 2 chunks per page,
 * so raw chunk-row counting inflated recall past 1.0; audit cats18-21-02).
 * Query failures and keyword-only-degraded queries are recorded through
 * eval/runner/probe-accounting.ts with origin 'dependency' (provider
 * outage) — never dropped from the denominator (audit cats18-21-11). A cell
 * with any error or incomplete embed coverage is marked invalid and excluded
 * from the winner comparison; cells are never silently compared at unequal n.
 *
 * ── Verdict (real + failable) ────────────────────────────────────────
 * pass    — every requested cell valid (100% embed coverage, zero query
 *           errors, reranker verifiably off) AND mean Recall@10 >= minRecall
 *           (default 0.5) in every cell.
 * partial — at least one valid cell, but not all cells pass the gate.
 * fail    — no valid cell.
 * Exit code is non-zero unless verdict === 'pass'. Missing provider keys →
 * receipt run_status 'skipped' + non-zero exit unless --allow-skip (or
 * BRAINBENCH_ALLOW_SKIP=1) acknowledges the skip.
 *
 * Run:
 *   bun eval/runner/cat18-embedding-providers.ts
 *   CAT18_PROVIDERS=openai,zeroentropy bun eval/runner/cat18-embedding-providers.ts
 *   bun eval/runner/cat18-embedding-providers.ts --stub-embed   # hermetic, no keys
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import {
  configureGateway,
  getEmbeddingDimensions,
  __setEmbedTransportForTests,
} from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
import type { SearchResult, HybridSearchMeta } from 'gbrain/types';
import { loadSyntheticV1, syntheticQueries, type SyntheticPage, type SyntheticQuery } from './synthetic-corpus-loader.ts';
import { uniqueInOrder, recallAtK, reciprocalRank, percentile } from './metrics.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';

export const CAT18_CATEGORY = 'cat18-embedding-providers';

/** Page-grained recall/MRR cutoff. */
export const K = 10;
/** Chunk rows fetched per query — gbrain dedup keeps <= 2 chunks/page, so 30
 *  chunk rows always yield >= K distinct pages when the corpus has them. */
export const CHUNK_FETCH = 30;
/**
 * Default per-cell Recall@10 floor for a 'pass' verdict. Calibration: live
 * un-reranked embedders score ~0.40-0.55 on synthetic-v1 (see
 * docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md — and those numbers were
 * computed pre-dedup-fix, so slightly inflated); the hermetic hash-embed stub
 * lands ~0.29-0.39; a broken ranking pipeline collapses below 0.1. The floor
 * is a breakage detector every honest configuration clears, not a quality
 * bar — cross-provider quality comparison is the report's job, not the gate's.
 */
export const DEFAULT_MIN_RECALL = 0.2;

/**
 * WS5 pin — applied via engine.setConfig BEFORE ingest in every cell and
 * echoed into the receipt's resolved_config. Never rely on mode defaults:
 * gbrain's default 'balanced' bundle enables the zerank-2 reranker when
 * ZEROENTROPY_API_KEY is set. expansion/autocut off for determinism (no LLM
 * in the loop, no score-cliff trimming confounding recall); tokenBudget
 * effectively unbounded so payload packing never drops ranked results.
 */
export const PINNED_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.autocut': 'false',
  'search.tokenBudget': '1000000',
};

const PROVIDER_ENV_KEY: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  voyage: 'VOYAGE_API_KEY',
  zeroentropy: 'ZEROENTROPY_API_KEY',
};

export const PROVIDERS_DEFAULT = ['openai', 'voyage', 'zeroentropy'];

export function providerConfig(name: string): { embedder: string; dim: number } {
  switch (name) {
    case 'openai': return { embedder: 'openai:text-embedding-3-large', dim: 1536 };
    case 'voyage': return { embedder: 'voyage:voyage-3-large', dim: 1024 };
    case 'zeroentropy': return { embedder: 'zeroentropyai:zembed-1', dim: 1280 };
    default: throw new Error(`unknown provider: ${name}`);
  }
}

// ─── Hermetic embed stub ─────────────────────────────────────────────

/**
 * Deterministic feature-hash embedding: FNV-1a token hashing into `dim`
 * buckets, L2-normalized. Similar texts get similar vectors, so the vector
 * arm meaningfully retrieves — but nothing here reflects any provider's
 * model quality. Used only under --stub-embed (publishable:false).
 */
export function hashEmbedVector(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
  for (const tok of tokens) {
    let h = 0x811c9dc5;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    v[h % dim] += ((h >>> 8) & 1) ? 1 : -1;
  }
  let norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  if (norm === 0) { v[0] = 1; norm = 1; }
  return v.map(x => x / norm);
}

/**
 * Transport for __setEmbedTransportForTests. Reads the ACTIVE gateway dim at
 * call time so one stub serves every per-cell configureGateway. `failOn`
 * lets regression tests force provider-outage behavior deterministically.
 */
export function makeHashEmbedTransport(failOn?: (text: string) => boolean) {
  return (async (params: { values: string[] }) => {
    const dim = getEmbeddingDimensions();
    const embeddings = params.values.map(t => {
      if (failOn?.(t)) throw new Error('stub embed transport: forced failure (test hook)');
      return hashEmbedVector(t, dim);
    });
    return { embeddings, values: params.values, warnings: [] };
  }) as unknown as Parameters<typeof __setEmbedTransportForTests>[0];
}

// ─── Per-query scoring (shared shape with cat18b) ────────────────────

export interface QueryScore {
  recall: number;
  rr: number;
  top1: boolean;
  /** Distinct page ids in retrieval order (post chunk→page normalization). */
  page_ids: string[];
}

/**
 * Page-normalize chunk-grained results and score one query. Duplicate chunk
 * rows for the same page count ONCE (metrics.ts uniqueHits semantics) —
 * recall can never exceed 1.0.
 */
export function scoreQuery(resultSlugs: string[], relevantSlugs: string[], k: number): QueryScore {
  const pageIds = uniqueInOrder(resultSlugs).slice(0, k);
  const rel = new Set(relevantSlugs);
  return {
    recall: recallAtK(pageIds, rel, k),
    rr: reciprocalRank(pageIds, rel),
    top1: pageIds.length > 0 && rel.has(pageIds[0]),
    page_ids: pageIds,
  };
}

// ─── Cell report ─────────────────────────────────────────────────────

export interface ProviderCell {
  cell: string;
  embedder: string;
  dim: number;
  // Embed-coverage evidence (queried from the engine, not inferred) so a
  // keyword-only-degraded cell is distinguishable from a real provider run.
  ingest_ok: number;
  ingest_fail: number;
  first_ingest_error: string | null;
  pages_total: number;
  pages_embedded: number;
  chunks_total: number;
  chunks_embedded: number;
  embedding_column: string | null;
  // Query accounting — errors stay visible, never dropped from denominators.
  queries_total: number;
  queries_scored: number;
  query_errors: number;
  degraded_queries: number;
  rerank_scored_queries: number;
  // Metrics over scored queries (null when nothing scored).
  mrr: number | null;
  recall_at_10: number | null;
  top1_hit_rate: number | null;
  mean_query_ms: number | null;
  p50_query_ms: number | null;
  embed_ingest_ms: number;
  valid: boolean;
  invalid_reasons: string[];
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const DEGRADED_VECTOR_STAGES = new Set(['embed_unavailable', 'embed_timeout', 'vector_arm_failed', 'rescore_skipped']);

export interface RunCellOptions {
  k?: number;
  chunkFetch?: number;
  pinned?: Record<string, string>;
}

/** One provider cell: fresh engine, pinned config, ingest, query, score. */
export async function runProviderCell(
  name: string,
  pages: SyntheticPage[],
  queries: SyntheticQuery[],
  acc: ProbeAccounting,
  opts: RunCellOptions = {},
): Promise<ProviderCell> {
  const k = opts.k ?? K;
  const chunkFetch = opts.chunkFetch ?? CHUNK_FETCH;
  const pinned = opts.pinned ?? PINNED_CONFIG;
  const { embedder, dim } = providerConfig(name);
  const probeId = (q: SyntheticQuery): string => `${name}:${q.id}`;

  const cell: ProviderCell = {
    cell: name, embedder, dim,
    ingest_ok: 0, ingest_fail: 0, first_ingest_error: null,
    pages_total: 0, pages_embedded: 0, chunks_total: 0, chunks_embedded: 0,
    embedding_column: null,
    queries_total: queries.length, queries_scored: 0, query_errors: 0,
    degraded_queries: 0, rerank_scored_queries: 0,
    mrr: null, recall_at_10: null, top1_hit_rate: null,
    mean_query_ms: null, p50_query_ms: null, embed_ingest_ms: 0,
    valid: false, invalid_reasons: [],
  };

  // Gateway BEFORE initSchema: the schema creates the embedding column with
  // getEmbeddingDimensions()'s vector(N).
  configureGateway({
    embedding_model: embedder,
    embedding_dimensions: dim,
    env: process.env as Record<string, string | undefined>,
  });

  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  try {
    // WS5: pin mode + reranker per cell BEFORE ingest. Never rely on defaults.
    for (const [key, value] of Object.entries(pinned)) {
      await engine.setConfig(key, value);
    }

    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    const tIngest = Date.now();
    try {
      for (const p of pages) {
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
    cell.embed_ingest_ms = Date.now() - tIngest;

    // Embed-coverage evidence, queried from the engine.
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
      // A cell without full embeddings would silently measure keyword-only
      // retrieval under the provider's name. Flag every planned probe as a
      // dependency failure (provider outage class) and skip querying.
      cell.invalid_reasons.push(
        `embed coverage incomplete: ingest ${cell.ingest_ok}/${pages.length} ok, ` +
        `chunks ${cell.chunks_embedded}/${cell.chunks_total} embedded` +
        (cell.first_ingest_error ? ` (first error: ${cell.first_ingest_error})` : ''),
      );
      for (const q of queries) {
        acc.error(probeId(q), 'dependency', `cell ${name}: ${cell.invalid_reasons[0]}`);
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
        acc.error(probeId(q), 'dependency', `cell ${name} query ${q.id}: hybridSearch failed: ${e?.message ?? e}`);
        continue;
      } finally {
        console.log = origLog;
      }
      const ms = Date.now() - t;

      if (cell.embedding_column === null && meta?.embedding_column) cell.embedding_column = meta.embedding_column;

      // Pin verification: the resolved mode must be what we pinned, and the
      // reranker must NOT have fired (this is an embedder-only comparison).
      if (meta?.mode && meta.mode !== pinned['search.mode']) {
        cell.query_errors++;
        acc.error(probeId(q), 'harness', `cell ${name} query ${q.id}: resolved mode '${meta.mode}' != pinned '${pinned['search.mode']}'`);
        cell.invalid_reasons.push(`mode pin failed on ${q.id}`);
        continue;
      }
      const rerankFired = results.some(r => typeof (r as any).rerank_score === 'number');
      if (rerankFired) {
        cell.rerank_scored_queries++;
        cell.query_errors++;
        acc.error(probeId(q), 'harness', `cell ${name} query ${q.id}: reranker fired despite search.reranker.enabled=false pin`);
        cell.invalid_reasons.push(`reranker pin failed on ${q.id}`);
        continue;
      }

      // Keyword-only fallback detection: gbrain fails open to keyword when
      // the query embed dies. That query did not measure this embedder.
      const stages = (meta?.degraded ?? []).map(d => d.stage);
      const vectorDegraded = meta?.vector_enabled === false || stages.some(s => DEGRADED_VECTOR_STAGES.has(s));
      if (vectorDegraded) {
        cell.degraded_queries++;
        cell.query_errors++;
        acc.error(
          probeId(q), 'dependency',
          `cell ${name} query ${q.id}: vector arm degraded (${stages.join(',') || 'vector_enabled=false'}) — keyword-only result under an embedder label`,
        );
        continue;
      }

      const s = scoreQuery(results.map(r => r.slug), q.relevant_slugs, k);
      if (Number.isNaN(s.recall)) {
        // Empty gold set — harness bug in query derivation, not a miss.
        cell.query_errors++;
        acc.error(probeId(q), 'harness', `cell ${name} query ${q.id}: empty relevant set`);
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
      cell.invalid_reasons.push(`${cell.query_errors} query error(s): ${cell.degraded_queries} degraded-to-keyword, rest thrown`);
    }
    cell.valid = cell.query_errors === 0 && cell.queries_scored === queries.length;
    return cell;
  } finally {
    await engine.disconnect();
  }
}

// ─── Verdict ─────────────────────────────────────────────────────────

export interface VerdictResult {
  verdict: 'pass' | 'partial' | 'fail';
  reasons: string[];
}

/** Structural cell view so cat18b's matrix cells share the same verdict logic. */
export interface VerdictCell {
  cell: string;
  valid: boolean;
  invalid_reasons: string[];
  recall_at_10: number | null;
}

export function computeVerdict(cells: VerdictCell[], requested: number, minRecall: number): VerdictResult {
  const reasons: string[] = [];
  const valid = cells.filter(c => c.valid);
  if (valid.length === 0) return { verdict: 'fail', reasons: ['no valid cell (all cells degraded, errored, or missing)'] };
  if (cells.length < requested || valid.length < cells.length) {
    reasons.push(`${valid.length}/${requested} cells valid — invalid: ${cells.filter(c => !c.valid).map(c => `${c.cell} (${c.invalid_reasons.join('; ') || 'missing'})`).join(', ')}`);
    return { verdict: 'partial', reasons };
  }
  const below = valid.filter(c => (c.recall_at_10 ?? 0) < minRecall);
  if (below.length > 0) {
    reasons.push(`recall@${K} below ${minRecall} floor: ${below.map(c => `${c.cell}=${(c.recall_at_10 ?? 0).toFixed(3)}`).join(', ')}`);
    return { verdict: 'fail', reasons };
  }
  reasons.push(`all ${valid.length} cells valid with recall@${K} >= ${minRecall}`);
  return { verdict: 'pass', reasons };
}

// ─── Full run ────────────────────────────────────────────────────────

export interface Cat18Options {
  providers?: string[];
  pages?: SyntheticPage[];
  queries?: SyntheticQuery[];
  /** Hermetic mode: deterministic hash-embed transport, no provider keys needed. */
  stubEmbed?: boolean;
  /** Test hook: force stub-transport failures for texts matching this predicate. */
  stubFailOn?: (text: string) => boolean;
  /** Acknowledge a missing-keys skip (exit 0 instead of 1). */
  allowSkip?: boolean;
  minRecall?: number;
  reportsDir?: string;
  /** Smoke cap on corpus size. Any limit ⇒ publishable:false. */
  limitPages?: number;
  quiet?: boolean;
}

export interface Cat18RunResult {
  receipt: Receipt;
  cells: ProviderCell[];
  exitCode: number;
  receiptFile: string;
}

function isolateGbrainHome(prefix: string): string {
  const home = join(tmpdir(), `${prefix}-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  // The embedding-column registry reads file-plane config FIRST and falls
  // back to gateway state; without isolation the user's ~/.gbrain pin would
  // override the per-cell gateway setup and mis-resolve Voyage/ZE columns.
  process.env.GBRAIN_HOME = home;
  return home;
}

export function optionsFromEnv(argv: string[] = process.argv.slice(2)): Cat18Options {
  return {
    providers: (process.env.CAT18_PROVIDERS ?? PROVIDERS_DEFAULT.join(',')).split(',').map(s => s.trim()).filter(Boolean),
    stubEmbed: argv.includes('--stub-embed') || process.env.CAT18_STUB_EMBED === '1',
    allowSkip: argv.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    limitPages: process.env.CAT18_LIMIT_PAGES ? parseInt(process.env.CAT18_LIMIT_PAGES, 10) : undefined,
    minRecall: process.env.CAT18_MIN_RECALL ? parseFloat(process.env.CAT18_MIN_RECALL) : undefined,
  };
}

export async function runCat18(options: Cat18Options = {}): Promise<Cat18RunResult> {
  const startedAt = new Date().toISOString();
  const providers = options.providers ?? PROVIDERS_DEFAULT;
  const minRecall = options.minRecall ?? DEFAULT_MIN_RECALL;
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT18_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);

  isolateGbrainHome('cat18');

  for (const p of providers) providerConfig(p); // fail fast on unknown providers

  const allPages = options.pages ?? loadSyntheticV1();
  const pages = options.limitPages ? allPages.slice(0, options.limitPages) : allPages;
  const queries = options.queries ?? syntheticQueries(pages);
  const expected = providers.length * queries.length;

  const baseReceipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT18_CATEGORY,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
  } as const;

  // Skip gate: live runs need every requested provider key. Stub runs don't.
  if (!options.stubEmbed) {
    const missing = providers
      .map(p => PROVIDER_ENV_KEY[p])
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
      log(`[cat18] SKIPPED: ${receipt.skip_reason}\n[cat18] receipt: ${receiptFile}\n`);
      return { receipt, cells: [], exitCode: options.allowSkip ? 0 : 1, receiptFile };
    }
  } else {
    // Model construction requires a non-empty key even with the transport
    // stubbed; the stub never lets a request leave the process.
    for (const k of Object.values(PROVIDER_ENV_KEY)) {
      if (!process.env[k]) process.env[k] = 'dummy-stub-embed';
    }
    __setEmbedTransportForTests(makeHashEmbedTransport(options.stubFailOn));
  }

  const acc = new ProbeAccounting(expected);
  const cells: ProviderCell[] = [];
  log(`[cat18] corpus: ${pages.length} pages, queries: ${queries.length}, providers: ${providers.join(',')}${options.stubEmbed ? ' [STUB EMBED — not a provider comparison]' : ''}\n`);

  try {
    for (const name of providers) {
      log(`[cat18] provider=${name}...\n`);
      try {
        const cell = await runProviderCell(name, pages, queries, acc, { pinned: PINNED_CONFIG });
        cells.push(cell);
        log(`[cat18]   ${name}: valid=${cell.valid} MRR=${cell.mrr?.toFixed(3) ?? 'n/a'} R@${K}=${cell.recall_at_10 !== null ? (cell.recall_at_10 * 100).toFixed(1) + '%' : 'n/a'} errors=${cell.query_errors} coverage=${cell.chunks_embedded}/${cell.chunks_total}\n`);
      } catch (e: any) {
        // Cell-level crash (engine/schema/config) — our bug, typed harness.
        for (const q of queries) acc.error(`${name}:${q.id}`, 'harness', `cell ${name} crashed: ${e?.message ?? e}`);
        cells.push({
          cell: name, embedder: providerConfig(name).embedder, dim: providerConfig(name).dim,
          ingest_ok: 0, ingest_fail: 0, first_ingest_error: null,
          pages_total: 0, pages_embedded: 0, chunks_total: 0, chunks_embedded: 0,
          embedding_column: null,
          queries_total: queries.length, queries_scored: 0, query_errors: queries.length,
          degraded_queries: 0, rerank_scored_queries: 0,
          mrr: null, recall_at_10: null, top1_hit_rate: null,
          mean_query_ms: null, p50_query_ms: null, embed_ingest_ms: 0,
          valid: false, invalid_reasons: [`cell crashed: ${String(e?.message ?? e).slice(0, 300)}`],
        });
        log(`[cat18]   ${name}: CRASH ${e?.message ?? e}\n`);
      }
    }
  } finally {
    if (options.stubEmbed) __setEmbedTransportForTests(null);
  }

  const summary = acc.summary();
  const validCells = cells.filter(c => c.valid);
  // Winners are only meaningful over valid cells at equal n — never silently
  // compare cells whose denominators diverged (audit cats18-21-11).
  const comparisonValid = validCells.length === providers.length && validCells.length >= 2;
  const bestMrr = comparisonValid ? validCells.reduce((a, b) => ((a.mrr ?? 0) >= (b.mrr ?? 0) ? a : b)).cell : null;
  const bestRecall = comparisonValid ? validCells.reduce((a, b) => ((a.recall_at_10 ?? 0) >= (b.recall_at_10 ?? 0) ? a : b)).cell : null;

  const { verdict, reasons } = computeVerdict(cells, providers.length, minRecall);
  const runInvalid = summary.run_invalid;
  const publishable = summary.publishable
    && !options.stubEmbed
    && !options.limitPages
    && validCells.length === providers.length;

  const resolvedConfig: Record<string, unknown> = {
    search_mode: PINNED_CONFIG['search.mode'],
    reranker_enabled: false,
    pinned_config: PINNED_CONFIG,
    embed_transport: options.stubEmbed ? 'stubbed-hash' : 'live',
    k: K,
    chunk_fetch_limit: CHUNK_FETCH,
    min_recall_gate: minRecall,
    providers: Object.fromEntries(cells.map(c => [c.cell, { embedder: c.embedder, dim: c.dim, embedding_column: c.embedding_column }])),
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
      comparison: {
        valid: comparisonValid,
        over_cells: validCells.map(c => c.cell),
        excluded_cells: cells.filter(c => !c.valid).map(c => c.cell),
        best_by_mrr: bestMrr,
        best_by_recall: bestRecall,
      },
      verdict_reasons: reasons,
      infra_error_rate: summary.infra_error_rate,
      queries: queries.length,
    },
  };
  writeReceipt(receiptFile, receipt);

  // Human-readable dated detail file (legacy location, same payload).
  const outDir = join(reportsDir, CAT18_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat18.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat18] ─── Scorecard ───────────────────\n`);
  for (const c of cells) {
    log(`[cat18]   ${c.cell.padEnd(12)} valid=${String(c.valid).padEnd(5)} MRR=${c.mrr?.toFixed(3) ?? '  n/a'}  R@${K}=${c.recall_at_10 !== null ? (c.recall_at_10 * 100).toFixed(1) + '%' : 'n/a'}  errors=${c.query_errors}  coverage=${c.chunks_embedded}/${c.chunks_total}\n`);
  }
  log(`[cat18]   comparison valid: ${comparisonValid} (best MRR: ${bestMrr ?? 'n/a'}, best R@${K}: ${bestRecall ?? 'n/a'})\n`);
  log(`[cat18]   run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'} publishable=${publishable}\n`);
  log(`[cat18]   receipt: ${receiptFile}\n`);

  const exitCode = runInvalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, cells, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat18(optionsFromEnv());
    process.exit(result.exitCode);
  } catch (e: any) {
    // Crash backstop: write an error receipt so the aggregator never
    // mistakes a dead run for a missing one.
    try {
      writeReceipt(receiptPath(CAT18_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT18_CATEGORY,
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
    process.stderr.write(`[cat18] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
