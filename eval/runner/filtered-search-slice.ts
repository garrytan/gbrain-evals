#!/usr/bin/env bun
/**
 * Filtered-search slice: does a filtered search return the right pages, enough of them, and fast?
 *
 * A vector index (HNSW) finds the nearest chunks first and applies the WHERE filter afterwards. When the filter keeps
 * only a few percent of the brain, the index can hand back fewer than `limit` rows (the filter dropped most of what it
 * found), or the planner can switch to a slow exact path. This runner measures both on one engine per process.
 *
 * Corpus: world-v1 (240 pages) or any directory in its format (the nightly 10k slice). Every page gets a source, an
 * event date and a `tier` frontmatter value from a seeded hash of its slug, so each filter keeps a known share of the
 * pages. Page types are the corpus's own. Probes and graded gold are cat13's (buildProbes), so nDCG@5 matches cat13.
 *
 * Per filter cell it reports:
 *   - vector-arm recall@10: the vector arm hybridSearch actually ran (recorded by wrapping engine.searchVector), its
 *     first 10 distinct pages, against an exact filtered scan over the same stored vectors that applies the engine's
 *     own ranking rule to every chunk of the pages that pass the filter. PGLite and Postgres rank a candidate pool
 *     (the max(limit*5, 100) nearest chunks by cosine, then the slug-prefix boost, best chunk per page); the Rust store
 *     boosts every chunk and has no pool (rust/docs/store/vectors.md). So 1.0 means the index lost nothing.
 *     `recall10_vs_plain_cosine` is the same overlap against plain cosine (no boost, no pool), the same for every engine.
 *   - result counts: rows from the `query` op (limit 10) and distinct pages; a query with fewer than 10 rows when 10
 *     or more pages pass the filter is a short result. The vector arm's own row count is checked the same way.
 *   - wrong rows: returned pages that do not pass the filter.
 *   - nDCG@5 of the `query` op against cat13 gold restricted to pages that pass the filter (queries with no such gold
 *     are left out and counted).
 *   - p50 / p95 / max latency of the `query` op, and every query over 1 s.
 *   - with --exact-ref (PGLite / Postgres): the same `query` op rerun on the same brain with index scans disabled, so
 *     the vector arm is an exact scan. Hybrid recall@10 = overlap of the two top-10 lists (hybrid ground truth).
 * One brain, so one vector index, serves every cell of a run. A query whose vector arm never ran (its embedding was
 * not in the cache under --embed-cache-only) makes the run invalid (exit 3). When the `query` op refuses a cell with
 * engine_capability_missing (the Rust engine today), the cell is measured through hybridSearch directly, marked as a
 * diagnostic, and the refusal is recorded.
 *
 * Usage (one engine per process):
 *   GBRAIN_EVAL_ENGINE=pglite|postgres|rust bun eval/runner/filtered-search-slice.ts \
 *     --gbrain-root <gbrain checkout> --corpus-dir <dir> --embed-cache <sqlite> [--embed-cache-only] \
 *     [--max-embed-tokens N] [--pg-url <admin url>] [--probes N] [--cells a,b] [--exact-ref] [--import-concurrency N] --out <dir>
 * --exact-ref on Postgres sets enable_indexscan off server-wide (ALTER SYSTEM) for the reference pass and resets it
 * afterwards, so point --pg-url only at an isolated scratch server. Live embedding calls (cache misses) need
 * --max-embed-tokens and stop at that many tokens; --embed-cache-only makes no provider call at all.
 */

import { createRequire } from 'module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { buildProbes, loadCorpus, mulberry32, seededShuffle, pinnedSearchConfig, type RichPage } from './cat13-conceptual.ts';
import { EmbeddingCache, makeCachingTransport } from './longmemeval-cache.ts';
import { ndcgAtK } from './metrics.ts';
import { evalEngineKind, openScratchEvalEngine, supportsRawSql, type EvalEngineKind } from './eval-engine.ts';
import { importGbrain, type GbrainUnderTest } from './gbrain-under-test.ts';

// ─── Seeded page attributes ─────────────────────────────────────────

export const SLICE_SEED = 20261123;
/** Dates are laid out around a fixed anchor so the windows never move between runs. */
export const ANCHOR_DAY = '2026-06-30';
export const SOURCES = { small: 'src-small', large: 'src-large' } as const;

/** Uniform [0,1) from a seeded hash of (axis, slug). */
export function unit(axis: string, slug: string, seed = SLICE_SEED): number {
  const h = createHash('sha256').update(`${seed}:${axis}:${slug}`).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

export interface PageAttrs { source: string; date: string; tier: 'gold' | 'silver' | 'bronze' }

function dayOffset(anchor: string, days: number): string {
  const d = new Date(`${anchor}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Source: 4% src-small, 60% src-large, 36% default. Date: 2% in the 7 days ending ANCHOR_DAY, 38% more in the
 * rest of the year ending ANCHOR_DAY, 60% one to three years before it. Tier: 10% gold, 30% silver, 60% bronze.
 */
export function pageAttrs(slug: string): PageAttrs {
  const s = unit('source', slug);
  const source = s < 0.04 ? SOURCES.small : s < 0.64 ? SOURCES.large : 'default';
  const d = unit('date', slug);
  const back = unit('date-offset', slug);
  const days = d < 0.02 ? Math.floor(back * 7) : d < 0.40 ? 7 + Math.floor(back * 358) : 366 + Math.floor(back * 730);
  const t = unit('tier', slug);
  return { source, date: dayOffset(ANCHOR_DAY, days), tier: t < 0.10 ? 'gold' : t < 0.40 ? 'silver' : 'bronze' };
}

// ─── Filter cells ───────────────────────────────────────────────────

export interface FilterCell {
  id: string;
  label: string;
  /** `query` op params. */
  params: Record<string, unknown>;
  /** Does a page pass this filter? */
  passes: (p: { source: string; type: string; date: string; tier: string }) => boolean;
}

const D7 = { since: dayOffset(ANCHOR_DAY, 6), until: ANCHOR_DAY };
const D365 = { since: dayOffset(ANCHOR_DAY, 364), until: ANCHOR_DAY };
const inWindow = (date: string, w: { since: string; until: string }) => date >= w.since && date <= w.until;

export const FILTER_CELLS: FilterCell[] = [
  { id: 'none', label: 'unfiltered', params: {}, passes: () => true },
  { id: 'source-small', label: `source ${SOURCES.small} (~4%)`, params: { source_id: SOURCES.small }, passes: p => p.source === SOURCES.small },
  { id: 'source-large', label: `source ${SOURCES.large} (~60%)`, params: { source_id: SOURCES.large }, passes: p => p.source === SOURCES.large },
  { id: 'type-one', label: 'type concept', params: { types: ['concept'] }, passes: p => p.type === 'concept' },
  { id: 'type-set', label: 'types meeting+concept', params: { types: ['meeting', 'concept'] }, passes: p => p.type === 'meeting' || p.type === 'concept' },
  { id: 'date-7d', label: `7-day window (~2%)`, params: { ...D7 }, passes: p => inWindow(p.date, D7) },
  { id: 'date-1y', label: `1-year window (~40%)`, params: { ...D365 }, passes: p => inWindow(p.date, D365) },
  { id: 'source-type', label: `${SOURCES.large} + type concept`, params: { source_id: SOURCES.large, types: ['concept'] }, passes: p => p.source === SOURCES.large && p.type === 'concept' },
  { id: 'where-tier', label: 'where tier=gold (~10%)', params: { where: { tier: 'gold' } }, passes: p => p.tier === 'gold' },
];

// ─── Small math ─────────────────────────────────────────────────────

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

function parseVector(v: unknown): Float32Array | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return Float32Array.from(v as number[]);
  if (typeof v === 'string') return Float32Array.from(JSON.parse(v) as number[]);
  return null;
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const pageKey = (source: string, slug: string) => `${source}::${slug}`;

// ─── Args ───────────────────────────────────────────────────────────

interface Opts {
  gbrainRoot: string; corpusDir: string; embedCache: string; embedCacheOnly: boolean; maxEmbedTokens: number | null;
  pgUrl?: string; probes: number | null; exactRef: boolean; importConcurrency: number; out: string; cells: string[] | null;
}

function parseArgv(argv: string[]): Opts {
  const o: Partial<Opts> = { embedCacheOnly: false, maxEmbedTokens: null, probes: null, exactRef: false, importConcurrency: 1, cells: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${a} needs a value`); return x; };
    switch (a) {
      case '--gbrain-root': o.gbrainRoot = v(); break;
      case '--corpus-dir': o.corpusDir = v(); break;
      case '--embed-cache': o.embedCache = v(); break;
      case '--embed-cache-only': o.embedCacheOnly = true; break;
      case '--max-embed-tokens': o.maxEmbedTokens = Number(v()); break;
      case '--pg-url': o.pgUrl = v(); break;
      case '--probes': o.probes = Number(v()); break;
      case '--exact-ref': o.exactRef = true; break;
      case '--import-concurrency': o.importConcurrency = Number(v()); break;
      case '--cells': o.cells = v().split(','); break;
      case '--out': o.out = v(); break;
      default: throw new Error(`unknown flag ${a}`);
    }
  }
  for (const k of ['gbrainRoot', 'corpusDir', 'embedCache', 'out'] as const) if (!o[k]) throw new Error(`--${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} is required`);
  if (!o.embedCacheOnly && (o.maxEmbedTokens === null || !(o.maxEmbedTokens! > 0))) {
    throw new Error('Without --embed-cache-only, pass --max-embed-tokens N: cache misses call the provider and the run stops once N tokens were embedded.');
  }
  return o as Opts;
}

// ─── Main ───────────────────────────────────────────────────────────

type SearchRow = { slug: string; source_id?: string; score?: number; chunk_id?: number; type?: string };
type Engine = Record<string, any>;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const opts = parseArgv(argv);
  // A private GBRAIN_HOME: the operator's ~/.gbrain/config.json (e.g. a keyless `embedding_disabled` brain) must not
  // decide whether this scratch brain embeds.
  const home = mkdtempSync(join(tmpdir(), 'fss-home-'));
  process.env.GBRAIN_HOME = home;
  const kind: EvalEngineKind = evalEngineKind();
  const gut: GbrainUnderTest = { root: opts.gbrainRoot, version: JSON.parse(readFileSync(join(opts.gbrainRoot, 'package.json'), 'utf8')).version, overlay: null };
  mkdirSync(opts.out, { recursive: true });
  const perQueryFile = join(opts.out, 'per-query.jsonl');
  writeFileSync(perQueryFile, '');
  writeFileSync(join(opts.out, 'run.log'), '');
  const log = (s: string) => { console.error(s); appendFileSync(join(opts.out, 'run.log'), `${s}\n`); };
  const started = Date.now();

  // Gateway: the gbrain under test's own module, with the cached transport (cat13's arrangement).
  const embedding = { model: 'openai:text-embedding-3-large', dimensions: 1536 };
  const gateway = await importGbrain<Record<string, any>>(gut, 'src/core/ai/gateway.ts');
  gateway.configureGateway({ embedding_model: embedding.model, embedding_dimensions: embedding.dimensions, env: process.env });
  const { embedMany } = await import(createRequire(join(gut.root, 'package.json')).resolve('ai')) as { embedMany: (p: unknown) => Promise<{ embeddings: number[][]; usage?: { tokens?: number } }> };
  const cache = new EmbeddingCache(opts.embedCache, `${embedding.model}@${embedding.dimensions}`);
  let paidTokens = 0;
  let paidRequests = 0;
  const live = async (p: unknown) => {
    if (opts.embedCacheOnly) throw new Error('--embed-cache-only: an embedding was not in the cache');
    if (paidTokens >= opts.maxEmbedTokens!) throw new Error(`embedding token cap reached (${paidTokens} tokens)`);
    const r = await embedMany(p);
    paidRequests += 1;
    paidTokens += r.usage?.tokens ?? 0;
    return r;
  };
  gateway.__setEmbedTransportForTests(makeCachingTransport(live as never, cache));

  // Corpus, attributes, probes.
  const pages: RichPage[] = loadCorpus(opts.corpusDir);
  const attrs = new Map<string, PageAttrs & { type: string }>();
  for (const p of pages) attrs.set(p.slug, { ...pageAttrs(p.slug), type: String(p.type) });
  const built = buildProbes(pages);
  let probes = built.probes;
  if (opts.probes !== null && opts.probes < probes.length) probes = seededShuffle(probes, mulberry32(SLICE_SEED)).slice(0, opts.probes);
  const cells = opts.cells ? FILTER_CELLS.filter(c => opts.cells!.includes(c.id)) : FILTER_CELLS;
  const passingPages: Record<string, number> = {};
  for (const c of cells) passingPages[c.id] = [...attrs.values()].filter(a => c.passes(a)).length;
  log(`engine=${kind} gbrain=${gut.version} root=${gut.root} pages=${pages.length} probes=${probes.length}/${built.probes.length}`);
  log(`passing pages per cell: ${JSON.stringify(passingPages)}`);

  // Brain.
  const scratch = await openScratchEvalEngine({ gut, kind, label: 'fss', pgAdminUrl: opts.pgUrl, embedding });
  const engine = scratch.engine as unknown as Engine;
  const summary: Record<string, unknown> = { engine: kind, gbrain_version: gut.version, gbrain_root: gut.root, corpus_dir: opts.corpusDir, pages: pages.length, probes: probes.length, probes_total: built.probes.length, seed: SLICE_SEED, anchor_day: ANCHOR_DAY, passing_pages: passingPages, cells: {} as Record<string, unknown> };
  try {
    const searchConfig = pinnedSearchConfig({ reranker: 'off', autocut: 'off' });
    for (const [k, v] of Object.entries(searchConfig)) await engine.setConfig(k, v);
    summary.search_config = searchConfig;
    // A typed insertSource where the build has one (rust-engine/main); the release's own SQL otherwise (sources-ops.ts).
    for (const id of [SOURCES.small, SOURCES.large]) {
      if (typeof engine.insertSource === 'function') await engine.insertSource({ id, name: id, local_path: null, config: {} });
      else await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, NULL, $3::text::jsonb)', [id, id, '{}']);
    }

    const { importFromContent } = await importGbrain<Record<string, any>>(gut, 'src/core/import-file.ts');
    const { runExtract } = await importGbrain<Record<string, any>>(gut, 'src/commands/extract.ts');
    const tImport = Date.now();
    const origLog = console.log; const origErr = console.error;
    console.log = () => {};
    let done = 0;
    const queue = [...pages];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const a = attrs.get(p.slug)!;
        const body = ['---', `type: ${p.type}`, `title: ${JSON.stringify(p.title)}`, `event_date: ${a.date}`, `tier: ${a.tier}`, '---', '', `# ${p.title}`, '', p.compiled_truth];
        if (p.timeline && p.timeline.trim()) body.push('', '## Timeline', '', p.timeline);
        const r = await importFromContent(engine, p.slug, body.join('\n'), { sourceId: a.source });
        if (r?.status === 'skipped' || r?.error || r?.embedding_deferred) throw new Error(`import ${p.slug}: ${JSON.stringify(r).slice(0, 400)}`);
        done += 1;
        if (done % 1000 === 0) origErr(`  imported ${done}/${pages.length} (${Math.round((Date.now() - tImport) / 1000)} s, paid tokens ${paidTokens})`);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.max(1, opts.importConcurrency) }, worker));
      // cat13's import step: links and timeline from the stored pages (the relational arm reads the links).
      await runExtract(engine, ['links', '--source', 'db']).catch((e: Error) => origErr(`extract links: ${e.message}`));
      await runExtract(engine, ['timeline', '--source', 'db']).catch((e: Error) => origErr(`extract timeline: ${e.message}`));
    } finally { console.log = origLog; console.error = origErr; }
    summary.import_seconds = Math.round((Date.now() - tImport) / 1000);
    log(`imported ${pages.length} pages in ${summary.import_seconds} s (paid requests ${paidRequests}, paid tokens ${paidTokens}, cache ${JSON.stringify(cache.stats)})`);

    // Stored chunks + vectors for the exact scan. PGLite/Postgres: SQL. Rust: typed getChunks per page.
    const chunks: Array<{ key: string; v: Float32Array; src: string }> = [];
    const pageSource = new Map<string, string>();
    if (supportsRawSql(kind)) {
      const rows = await engine.executeRaw(`SELECT p.slug, p.source_id, cc.chunk_source, cc.embedding::text AS e FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE cc.embedding IS NOT NULL AND p.deleted_at IS NULL`);
      for (const r of rows as Array<{ slug: string; source_id: string; chunk_source: string; e: string }>) {
        chunks.push({ key: pageKey(r.source_id, r.slug), v: normalize(parseVector(r.e)!), src: String(r.chunk_source) });
        pageSource.set(r.slug, r.source_id);
      }
    } else {
      for (const p of pages) {
        const src = attrs.get(p.slug)!.source;
        const cs = typeof engine.getChunksWithEmbeddings === 'function'
          ? await engine.getChunksWithEmbeddings(p.slug, { sourceId: src })
          : await engine.getChunks(p.slug, { sourceId: src, includeEmbedding: true });
        for (const c of cs as Array<{ embedding?: unknown; chunk_source?: string }>) {
          const v = parseVector(c.embedding);
          if (v) chunks.push({ key: pageKey(src, p.slug), v: normalize(v), src: String(c.chunk_source) });
        }
        pageSource.set(p.slug, src);
      }
    }
    const pagesWithVectors = new Set(chunks.map(c => c.key)).size;
    log(`exact-scan set: ${chunks.length} embedded chunks over ${pagesWithVectors} pages`);
    summary.embedded_chunks = chunks.length;
    summary.pages_with_vectors = pagesWithVectors;
    if (chunks.length === 0) throw new Error('no stored vectors could be read for the exact scan');
    const attrOfKey = (key: string) => {
      const slug = key.slice(key.indexOf('::') + 2);
      const a = attrs.get(slug);
      return a ? { ...a, source: key.slice(0, key.indexOf('::')) } : null;
    };

    // The vector arm's own ranking (vector-statement.ts): the `innerLimit` nearest chunks by cosine, each scored
    // cosine x the slug-prefix boost (longest prefix wins), best chunk per page. The exact scan applies the same steps
    // to every chunk that passes the filter, so it differs from the arm only where the index missed a chunk.
    const { resolveBoostMap } = await importGbrain<{ resolveBoostMap: (a?: unknown, b?: unknown) => Record<string, number> }>(gut, 'src/core/search/source-boost.ts');
    const boostEntries = Object.entries(resolveBoostMap(undefined, await engine.getConfig('search.source_boosts')))
      .filter(([k, f]) => k.length > 0 && Number.isFinite(f) && f >= 0).sort((a, b) => b[0].length - a[0].length);
    const boostOf = (slug: string) => boostEntries.find(([k]) => slug.startsWith(k))?.[1] ?? 1;
    summary.vector_boosts = Object.fromEntries(boostEntries);
    // detail 'high' turns the boost off (buildSourceFactorCase returns 1.0); an explicit 'low' keeps compiled-truth chunks only.
    const exactArm = (q: Float32Array, cell: FilterCell, armLimit: number, detail?: string) => {
      const scored: Array<{ key: string; cos: number }> = [];
      for (const c of chunks) { if (detail === 'low' && c.src !== 'compiled_truth') continue; const a = attrOfKey(c.key); if (a && cell.passes(a)) scored.push({ key: c.key, cos: dot(q, c.v) }); }
      scored.sort((x, y) => y.cos - x.cos);
      const best = new Map<string, number>();
      // PGLite/Postgres rank a candidate pool: the max(limit*5, 100) nearest chunks by plain cosine, then the boost.
      // The Rust store scores every chunk with the boost and has no pool (rust/docs/store/vectors.md).
      for (const c of (kind === 'rust' ? scored : scored.slice(0, Math.max(armLimit * 5, 100)))) {
        const s = c.cos * (detail === 'high' ? 1 : boostOf(c.key.slice(c.key.indexOf('::') + 2)));
        if ((best.get(c.key) ?? -Infinity) < s) best.set(c.key, s);
      }
      return [...best.entries()].sort((x, y) => y[1] - x[1]).map(e => e[0]);
    };

    // Engine-neutral reference: plain cosine, best chunk per page, no boost and no pool.
    const exactCosine = (q: Float32Array, cell: FilterCell, detail?: string) => {
      const best = new Map<string, number>();
      for (const c of chunks) {
        if (detail === 'low' && c.src !== 'compiled_truth') continue;
        const a = attrOfKey(c.key); if (!a || !cell.passes(a)) continue;
        const s = dot(q, c.v); if ((best.get(c.key) ?? -Infinity) < s) best.set(c.key, s);
      }
      return [...best.entries()].sort((x, y) => y[1] - x[1]).map(e => e[0]);
    };

    // Record the vector arm hybridSearch runs.
    let armCalls: Array<{ emb: Float32Array; limit: number; detail?: string; rows: SearchRow[] }> = [];
    const origSearchVector = engine.searchVector.bind(engine);
    engine.searchVector = async (emb: Float32Array, o: Record<string, unknown>) => {
      const rows = await origSearchVector(emb, o);
      armCalls.push({ emb, limit: Number(o?.limit ?? 0), detail: typeof o?.detail === 'string' ? o.detail : undefined, rows });
      return rows;
    };

    const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: (ctx: unknown, p: unknown) => Promise<unknown> }> }>(gut, 'src/core/operations.ts');
    const queryOp = operations.find(o => o.name === 'query')!;
    const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const makeCtx = (eng: Engine) => ({ engine: eng, config: scratch.config, logger: silent, dryRun: false, remote: false, emitNotice: () => {}, emitResponseMeta: () => {} });
    const pagesOf = (rows: SearchRow[], k: number) => {
      const out: string[] = [];
      for (const r of rows) {
        const key = pageKey(String(r.source_id ?? pageSource.get(r.slug) ?? 'default'), r.slug);
        if (!out.includes(key)) out.push(key);
        if (out.length >= k) break;
      }
      return out;
    };
    const runQuery = async (eng: Engine, text: string, params: Record<string, unknown>) => {
      armCalls = [];
      const t0 = performance.now();
      const res = await queryOp.handler(makeCtx(eng), { query: text, limit: 10, ...params }) as SearchRow[];
      return { rows: Array.isArray(res) ? res : [], ms: performance.now() - t0, arm: armCalls };
    };
    // Diagnostic path for a cell the `query` op refuses (the Rust engine's raw-SQL refusals): the same filter straight
    // into hybridSearch, which is what the op calls after its scope checks. Reported apart, never as the op's result.
    const { hybridSearch } = await importGbrain<{ hybridSearch: (e: unknown, q: string, o: Record<string, unknown>) => Promise<SearchRow[]> }>(gut, 'src/core/search/hybrid.ts');
    const { parseFrontmatterWhere } = await importGbrain<{ parseFrontmatterWhere: (w: unknown) => unknown }>(gut, 'src/core/search/frontmatter-where.ts');
    const runHybridDirect = async (eng: Engine, text: string, params: Record<string, unknown>) => {
      armCalls = [];
      const o: Record<string, unknown> = { limit: 10 };
      if (params.source_id) o.sourceId = params.source_id;
      if (params.types) o.types = params.types;
      if (params.since) o.since = params.since;
      if (params.until) o.until = params.until;
      if (params.where) o.where = parseFrontmatterWhere(params.where); // the op's own normalization (scalar -> list)
      const t0 = performance.now();
      const res = await hybridSearch(eng, text, o);
      return { rows: Array.isArray(res) ? res : [], ms: performance.now() - t0, arm: armCalls };
    };
    const isCapabilityRefusal = (e: unknown) => { const x = e as { code?: string; canonical?: string }; return (x?.canonical ?? x?.code) === 'engine_capability_missing'; };

    // Warm-up (unscored): 20 unfiltered queries.
    for (const p of probes.slice(0, 20)) await runQuery(engine, p.q.text, {});

    const byCell: Record<string, { top10: Map<string, string[]> }> = {};
    const invalid: string[] = [];
    summary.invalid = invalid;
    for (const cell of cells) {
      const lat: number[] = []; const slow: Array<{ id: string; ms: number }> = [];
      const counts: number[] = []; const armCounts: number[] = []; const recalls: number[] = []; const cosineRecalls: number[] = []; const ndcgs: number[] = [];
      let direct = false; let refusal: { code: string; message: string; at: string[] } | null = null;
      let wrong = 0; let armWrong = 0; let short = 0; let armShort = 0; let armShortAtLimit = 0; const rowCounts: number[] = []; let errors = 0; let noGold = 0; let noArm = 0;
      const top10 = new Map<string, string[]>();
      const passingWithVectors = new Set(chunks.filter(c => { const a = attrOfKey(c.key); return a && cell.passes(a); }).map(c => c.key)).size;
      const expectFull = Math.min(10, passingPages[cell.id]);
      for (const probe of probes) {
        let r: Awaited<ReturnType<typeof runQuery>>;
        try {
          r = direct ? await runHybridDirect(engine, probe.q.text, cell.params) : await runQuery(engine, probe.q.text, cell.params);
        } catch (e) {
          if (!direct && isCapabilityRefusal(e)) {
            refusal = { code: 'engine_capability_missing', message: String((e as Error).message).slice(0, 300), at: String((e as Error)?.stack ?? '').split('\n').slice(1, 5).map(l => l.trim()) };
            direct = true;
            log(`  ${cell.id}: the query op refused (${refusal.at[2] ?? refusal.at[0]}); measuring hybridSearch directly as a diagnostic`);
            try { r = await runHybridDirect(engine, probe.q.text, cell.params); } catch (e2) { e = e2; r = undefined as never; }
            if (r) { /* fall through to scoring */ } else { errors += 1; continue; }
          } else {
          errors += 1;
          appendFileSync(perQueryFile, `${JSON.stringify({ cell: cell.id, id: probe.q.id, error: String((e as Error)?.message ?? e).slice(0, 400), code: (e as { code?: string })?.code, at: String((e as Error)?.stack ?? '').split('\n').slice(1, 7).map(l => l.trim()) })}\n`);
          continue;
          }
        }
        lat.push(r.ms);
        if (r.ms > 1000) slow.push({ id: probe.q.id, ms: Math.round(r.ms) });
        const got = pagesOf(r.rows, 10);
        top10.set(probe.q.id, got);
        counts.push(got.length);
        rowCounts.push(r.rows.length);
        if (r.rows.length < expectFull) short += 1;
        const bad = got.filter(k => { const a = attrOfKey(k); return !a || !cell.passes(a); });
        wrong += bad.length;
        // nDCG@5 against gold restricted to pages that pass the filter (gold is keyed by slug).
        const grades = new Map<string, number>();
        for (const [slug, g] of built.gradesByQuery.get(probe.q.id) ?? new Map()) { const a = attrs.get(slug); if (a && cell.passes(a)) grades.set(slug, g); }
        if (grades.size === 0) noGold += 1; else ndcgs.push(ndcgAtK(got.map(k => k.slice(k.indexOf('::') + 2)), grades, 5));
        // Vector arm: the first text-arm call; exact filtered scan with its own query vector.
        const call = r.arm[0];
        let recall: number | null = null; let armGot: string[] = []; let exact: string[] = []; let cosine: string[] = [];
        if (!call) noArm += 1; else {
          armGot = pagesOf(call.rows, 10);
          armCounts.push(armGot.length);
          if (armGot.length < Math.min(10, passingWithVectors)) armShort += 1;
          armWrong += armGot.filter(k => { const a = attrOfKey(k); return !a || !cell.passes(a); }).length;
          const exactAll = exactArm(normalize(call.emb), cell, call.limit || 10, call.detail);
          exact = exactAll.slice(0, 10);
          cosine = exactCosine(normalize(call.emb), cell, call.detail).slice(0, 10);
          const cd = Math.min(10, cosine.length);
          if (cd > 0) cosineRecalls.push(armGot.filter(k => cosine.includes(k)).length / cd);
          const armAll = pagesOf(call.rows, call.limit || 10);
          if (armAll.length < Math.min(call.limit || 10, exactAll.length)) armShortAtLimit += 1;
          const denom = Math.min(10, exact.length);
          recall = denom === 0 ? null : armGot.filter(k => exact.includes(k)).length / denom;
          if (recall !== null) recalls.push(recall);
        }
        appendFileSync(perQueryFile, `${JSON.stringify({ cell: cell.id, id: probe.q.id, path: direct ? 'hybrid-direct' : 'op', ms: Math.round(r.ms * 10) / 10, rows: r.rows.length, count: got.length, wrong: bad.length, top10: got, arm_limit: call?.limit ?? null, arm_detail: call?.detail ?? null, arm_count: armGot.length, arm_calls: r.arm.length, arm_top10: armGot, exact_top10: exact, cosine_top10: cosine, arm_recall10: recall, ndcg5: grades.size ? ndcgs[ndcgs.length - 1] : null })}\n`);
      }
      const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
      const res = {
        label: cell.label, params: cell.params, path: direct ? 'hybridSearch (diagnostic: query op refused)' : 'query op', op_refusal: refusal, passing_pages: passingPages[cell.id], passing_pages_with_vectors: passingWithVectors,
        queries: probes.length, errors, latency_ms: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95), max: Math.max(...lat), over_1s: slow.length, slow: slow.slice(0, 50) },
        count: { rows_mean: mean(rowCounts), rows_min: Math.min(...rowCounts), pages_mean: mean(counts), pages_min: Math.min(...counts), short_queries: short, expected_full: expectFull },
        wrong_rows: wrong,
        vector_arm: { recall10_vs_plain_cosine: mean(cosineRecalls), recall10_mean: mean(recalls), recall10_min: recalls.length ? Math.min(...recalls) : NaN, scored: recalls.length, count_mean: mean(armCounts), count_min: armCounts.length ? Math.min(...armCounts) : NaN, short_queries: armShort, short_at_arm_limit: armShortAtLimit, wrong_rows: armWrong, queries_without_arm: noArm },
        ndcg5: { mean: mean(ndcgs), scored: ndcgs.length, queries_without_gold_in_filter: noGold },
      };
      // A query whose vector arm never ran (the query embed failed, e.g. a cache miss under --embed-cache-only) was
      // answered keyword-only: the cell does not measure filtered vector search, so the run is invalid.
      if (noArm > 0) { invalid.push(`${cell.id}: ${noArm} queries ran no vector arm`); log(`  RUN INVALID: ${cell.id}: ${noArm}/${probes.length} queries ran no vector arm (keyword-only)`); }
      (summary.cells as Record<string, unknown>)[cell.id] = res;
      byCell[cell.id] = { top10 };
      log(`${cell.id.padEnd(13)}${direct ? '*' : ' '}pass=${String(passingPages[cell.id]).padStart(5)} armR@10=${res.vector_arm.recall10_mean.toFixed(3)} cosR@10=${res.vector_arm.recall10_vs_plain_cosine.toFixed(3)} min=${res.vector_arm.recall10_min} armCountMin=${res.vector_arm.count_min} armShort=${armShort}/${armShortAtLimit} | rows mean=${res.count.rows_mean.toFixed(2)} min=${res.count.rows_min} pages min=${res.count.pages_min} short=${short} wrong=${wrong} err=${errors} | nDCG@5=${(res.ndcg5.mean * 100).toFixed(1)} (n=${ndcgs.length}) | p50=${res.latency_ms.p50.toFixed(0)} p95=${res.latency_ms.p95.toFixed(0)} max=${res.latency_ms.max.toFixed(0)} >1s=${slow.length}`);
    }

    // Exact reference: the same op with index scans off, on the same brain.
    if (opts.exactRef && supportsRawSql(kind)) {
      let refEngine: Engine = engine;
      let closeRef: (() => Promise<void>) | null = null;
      if (kind === 'postgres') {
        // Server-wide on the isolated scratch server (gbrain's pool keeps its connections, so a per-database setting
        // would not reach them); reset in finally. Reload is asynchronous, so wait until the pool sees it.
        await engine.executeRaw(`ALTER SYSTEM SET enable_indexscan = off`);
        await engine.executeRaw(`SELECT pg_reload_conf()`);
        for (let i = 0; i < 50; i++) {
          const r = await engine.executeRaw(`SHOW enable_indexscan`) as Array<{ enable_indexscan: string }>;
          if (r[0]?.enable_indexscan === 'off') break;
          await new Promise(res => setTimeout(res, 200));
        }
        closeRef = async () => { await engine.executeRaw(`ALTER SYSTEM RESET enable_indexscan`); await engine.executeRaw(`SELECT pg_reload_conf()`); };
      } else {
        await engine.executeRaw('SET enable_indexscan = off');
        closeRef = async () => { await engine.executeRaw('RESET enable_indexscan'); };
      }
      const shown = await refEngine.executeRaw(`SHOW enable_indexscan`);
      log(`exact reference: enable_indexscan=${JSON.stringify(shown)}`);
      try {
        for (const cell of cells) {
          const recalls: number[] = []; const lat: number[] = [];
          for (const probe of probes) {
            const mine = byCell[cell.id].top10.get(probe.q.id);
            if (!mine) continue;
            const r = await runQuery(refEngine, probe.q.text, cell.params).catch(() => null);
            if (!r) continue;
            lat.push(r.ms);
            const ref = pagesOf(r.rows, 10);
            const denom = Math.min(10, ref.length);
            if (denom > 0) recalls.push(mine.filter(k => ref.includes(k)).length / denom);
            appendFileSync(perQueryFile, `${JSON.stringify({ cell: cell.id, id: probe.q.id, exact_ref_top10: ref, exact_ref_ms: Math.round(r.ms) })}\n`);
          }
          const c = (summary.cells as Record<string, Record<string, unknown>>)[cell.id];
          c.hybrid_recall10_vs_exact_ref = { mean: recalls.reduce((a, b) => a + b, 0) / Math.max(1, recalls.length), min: Math.min(...recalls), scored: recalls.length, exact_ref_p50_ms: quantile(lat, 0.5) };
          log(`exact-ref ${cell.id.padEnd(13)} hybridR@10=${(c.hybrid_recall10_vs_exact_ref as { mean: number }).mean.toFixed(3)} refP50=${quantile(lat, 0.5).toFixed(0)}`);
        }
      } finally { await closeRef?.(); }
    }
  } finally {
    summary.paid_embedding = { requests: paidRequests, tokens: paidTokens };
    summary.embed_cache = cache.stats;
    summary.wall_seconds = Math.round((Date.now() - started) / 1000);
    writeFileSync(join(opts.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    cache.close();
    await scratch.close();
    rmSync(home, { recursive: true, force: true });
  }
  log(`done in ${summary.wall_seconds} s; paid requests ${paidRequests}, tokens ${paidTokens}`);
  const bad = summary.invalid as string[] | undefined;
  if (bad?.length) { log(`RUN INVALID (exit 3): ${bad.join('; ')}`); return 3; }
  return 0;
}

if (import.meta.main) {
  main().then(code => process.exit(code), e => { console.error(e?.stack ?? String(e)); process.exit(1); });
}
