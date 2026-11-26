#!/usr/bin/env bun
/**
 * Runner for the filtered vector search experiment
 * (docs/benchmarks/2026-11-26-filtered-vector-material-preregistration.md).
 *
 * It loads one corpus and size into a fresh Postgres database with gbrain's schema at the pin, then, for each attribute
 * mode, caller, filter and limit, runs both arms' searchVector on the same query vectors and the same database: the
 * exact oracle (gbrain's exactSql with an unbounded window), a plan capture pass (EXPLAIN ANALYZE of every vector attempt
 * inside the attempt's own transaction and settings), one untimed warm-up per query and arm, then the timed repeats in
 * alternating arm order. Cold cells restart Postgres, drop the page cache and open fresh engines before each timed
 * search. Raw rows go to JSONL under --out, held per cell until the cell finishes; recount.ts computes every number from
 * them. A cell already in cells-done.jsonl is skipped, so a stopped run resumes.
 *
 * --engine pglite runs the same grid on gbrain's PGLite engine in --data-dir: one database, with each arm's searchVector
 * (from its own gbrain tree) called on the same engine instance, and cold searches close and reopen the engine after
 * dropping the page cache.
 *
 * Corpus L (--corpus latent) is gbrain's latent generator and calls no provider. Corpus W (--corpus wiki --corpus-dir D)
 * reads D/pages.tsv, D/chunks.txt and D/vectors.f32 (embed-wiki.ts); query vectors it lacks are embedded with voyage-4
 * through the budget ledger (--budget-usd), and cached in D.
 *
 *   bun eval/runner/filtered-vector/run.ts --control ~/gbrain --treatment ~/gbrain-material-off \
 *     --pg-url postgresql://postgres:postgres@127.0.0.1:5434/postgres --pg-container fv-pg --label pg17-v087 \
 *     --chunks 15000 --queries 20 --out eval/reports/filtered-vector/pilot [--oracle-check]
 */
delete process.env.GBRAIN_SOURCE_BOOST;
delete process.env.GBRAIN_SEARCH_EXCLUDE;

import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ATTRIBUTES, CALLERS, callerOpts, callerSees, filters, hash32, lshProjections, MODES, pageAttributes, rng, SOURCES, attributeRanks,
  type Attribute, type Caller, type FilterSpec, type Mode, type PageAttributes,
} from './attributes.ts';
import { buildTreatment, sha256 } from './patch-arm.ts';
import { attemptKind, boostedSlug, firstSentence, queryPlan, type AttemptKind } from './harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function flag(name: string, fallback?: string): string {
  const i = process.argv.indexOf('--' + name);
  if (i > 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1]!;
  if (fallback === undefined) throw new Error('--' + name + ' is required');
  return fallback;
}
const list = (name: string, fallback: string) => flag(name, fallback).split(',').map(s => s.trim()).filter(Boolean);
const has = (name: string) => process.argv.includes('--' + name);

const CONTROL = resolve(flag('control'));
const TREATMENT = resolve(flag('treatment'));
const ENGINE = flag('engine', 'postgres') as 'postgres' | 'pglite';
const DATA_DIR = ENGINE === 'pglite' ? resolve(flag('data-dir')) : '';
const ADMIN_URL = ENGINE === 'postgres' ? flag('pg-url') : '';
const CONTAINER = flag('pg-container', 'fv-pg');
const LABEL = flag('label');
const CORPUS = flag('corpus', 'latent') as 'latent' | 'wiki';
const CORPUS_DIR = CORPUS === 'wiki' ? resolve(flag('corpus-dir')) : '';
const CHUNKS = Number(flag('chunks'));
const DIMS = Number(flag('dims', '1024'));
const SEED = Number(flag('seed', '9817'));
const ATTR_SEED = Number(flag('attr-seed', '9818'));
const QUERY_SEED = Number(flag('query-seed', '9819'));
const QUERIES = Number(flag('queries', '200'));
const REPEATS = Number(flag('repeats', '3'));
const CAPTURE = Number(flag('capture', '5'));
const RUN_MODES = list('modes', MODES.join(',')) as Mode[];
const RUN_CALLERS = list('callers', CALLERS.join(',')) as Caller[];
const LIMITS = list('limits', '20').map(Number);
const LIMIT50_MODES = list('limit50-modes', 'independent') as Mode[];
const FILTER_IDS = list('filters', 'all');
const COLD_FILTERS = list('cold-filters', 'type-1,type-20,date-1,date-20,where-1,where-20');
const COLD_QUERIES = Number(flag('cold-queries', '30'));
const WARM = !has('no-warm');
const OUT = resolve(flag('out'));
const WORKERS = Number(flag('workers', String(Math.max(1, cpus().length - 1))));
const EXACT_CONCURRENCY = Number(flag('exact-concurrency', String(Math.max(1, Math.floor(cpus().length / 2)))));
const ORACLE_CHECK = has('oracle-check');
const IMAGE = flag('image', '');
const KEEP = has('keep');

mkdirSync(OUT, { recursive: true });
const log = (m: string) => console.error('[fv ' + new Date().toISOString().slice(11, 19) + '] ' + m);
const append = (file: string, row: unknown) => appendFileSync(join(OUT, file), JSON.stringify(row) + '\n');
/** A cell's rows are held until the cell finishes, so a stopped run leaves no partial cell behind. */
const pending = new Map<string, string[]>();
const stage = (file: string, row: unknown) => { const rows = pending.get(file) ?? []; rows.push(JSON.stringify(row)); pending.set(file, rows); };
function commitCell(cell: string) {
  for (const [file, rows] of pending) appendFileSync(join(OUT, file), rows.join('\n') + '\n');
  pending.clear();
  append('cells-done.jsonl', { cell, at: new Date().toISOString() });
}
const done = new Set<string>(existsSync(join(OUT, 'cells-done.jsonl')) ? readFileSync(join(OUT, 'cells-done.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).cell as string) : []);

// ---------------------------------------------------------------------------
// Arms: two module graphs, one per gbrain tree
// ---------------------------------------------------------------------------

if (!existsSync(join(TREATMENT, 'src/core/postgres-engine.ts')) || has('rebuild-treatment')) buildTreatment(CONTROL, TREATMENT);
const armFiles = ['src/core/postgres-engine.ts', 'src/core/pglite-engine.ts'].map(file => ({
  file, control_sha256: sha256(readFileSync(join(CONTROL, file), 'utf8')), treatment_sha256: sha256(readFileSync(join(TREATMENT, file), 'utf8')),
}));
if (armFiles.some(f => f.control_sha256 === f.treatment_sha256)) throw new Error('the treatment tree is not patched; rerun with --rebuild-treatment');

const MODEL = CORPUS === 'wiki' ? 'voyage:voyage-4' : 'bench:latent';
const column = { name: 'embedding', type: 'vector' as const, dimensions: DIMS, embeddingModel: MODEL };
const ARMS = ['C', 'T'] as const;
type Arm = (typeof ARMS)[number];
const trees: Record<Arm, string> = { C: CONTROL, T: TREATMENT };
const mods: Record<Arm, { Engine: Any }> = {} as Any;
for (const arm of ARMS) {
  const engineMod = await import(join(trees[arm], ENGINE === 'pglite' ? 'src/core/pglite-engine.ts' : 'src/core/postgres-engine.ts'));
  const gateway = await import(join(trees[arm], 'src/core/ai/gateway.ts'));
  gateway.configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'bench-stub-no-network' } });
  mods[arm] = { Engine: ENGINE === 'pglite' ? engineMod.PGLiteEngine : engineMod.PostgresEngine };
}
const latent: Any = await import(join(CONTROL, 'scripts/bench/hnsw-latent-corpus.ts'));
const vectorStatement: Any = await import(join(CONTROL, 'src/core/search/vector-statement.ts'));
const vectorIndex: Any = await import(join(CONTROL, 'src/core/vector-index.ts'));
const projectionStats: Any = await import(join(CONTROL, 'src/core/search/projection-statistics.ts'));
const sourceBoost: Any = await import(join(CONTROL, 'src/core/search/source-boost.ts'));
const postgres: Any = (await import(join(CONTROL, 'vendor/postgres/src/index.js'))).default;

// ---------------------------------------------------------------------------
// Corpus plan
// ---------------------------------------------------------------------------

interface Plan { count: number; chunkStart: Int32Array; chunkCount: Int32Array; topic: Int32Array; source: Uint8Array; vis: Float32Array }
const params = { ...latent.LATENT_DEFAULTS, chunks: CHUNKS, dims: DIMS, seed: SEED };
let plan: Plan;
let slugs: string[];
let basis: SharedArrayBuffer | null = null;
let wikiOffsets: Float64Array | null = null;
if (CORPUS === 'latent') {
  plan = latent.planPages(CHUNKS, SEED, params.sourceShares);
  basis = latent.buildBasis(params);
  slugs = Array.from({ length: plan.count }, (_, p) => latent.pageSlug(p));
} else {
  const lines = readFileSync(join(CORPUS_DIR, 'pages.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t'));
  const counts: number[] = [];
  slugs = [];
  let total = 0;
  for (const [, slug, count] of lines) { if (total >= CHUNKS) break; const c = Math.min(Number(count), CHUNKS - total); counts.push(c); slugs.push('bench/' + slug); total += c; }
  if (total !== CHUNKS) throw new Error(CORPUS_DIR + ' holds ' + total + ' chunks, fewer than --chunks ' + CHUNKS);
  const n = counts.length;
  plan = { count: n, chunkStart: new Int32Array(new SharedArrayBuffer(n * 4)), chunkCount: new Int32Array(new SharedArrayBuffer(n * 4)),
    topic: new Int32Array(new SharedArrayBuffer(n * 4)), source: new Uint8Array(new SharedArrayBuffer(n)), vis: new Float32Array(new SharedArrayBuffer(n * 4)) };
  for (let p = 0, c = 0; p < n; c += counts[p]!, p++) { plan.chunkStart[p] = c; plan.chunkCount[p] = counts[p]!; plan.vis[p] = new latent.Rng(latent.hashPage(SEED, p)).next(); }
  const text = readFileSync(join(CORPUS_DIR, 'chunks.txt'));
  wikiOffsets = new Float64Array(new SharedArrayBuffer((total + 1) * 8));
  for (let i = 0, pos = 0; i <= total; i++) { wikiOffsets[i] = pos; if (i < total) pos = text.indexOf(10, pos) + 1; }
  if (statSync(join(CORPUS_DIR, 'vectors.f32')).size < total * DIMS * 4) throw new Error(CORPUS_DIR + '/vectors.f32 holds fewer than ' + total + ' vectors; run embed-wiki.ts first');
}
const N = plan.count;
const pageIds = Int32Array.from({ length: N }, (_, p) => p + 1);

const boostMap = sourceBoost.resolveBoostMap(undefined, null) as Record<string, number>;
const hardExcludes = sourceBoost.resolveHardExcludes() as string[];
const boosted = slugs.find(s => boostedSlug(s, boostMap, hardExcludes));
if (boosted) throw new Error('slug ' + boosted + ' matches a source boost or hard exclude, so the oracle would not rank by pure cosine');

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const manifestPath = join(OUT, 'manifest.json');
const prior = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
const dbName: string = prior?.db ?? 'fv_' + CORPUS + '_' + CHUNKS + '_' + randomBytes(4).toString('hex');
const url = new URL(ADMIN_URL || 'postgresql://unused/');
url.pathname = '/' + dbName;
const admin = ENGINE === 'postgres' ? postgres(ADMIN_URL, { max: 1, prepare: false, onnotice: () => {} }) : null;

/** Per-attempt records: kinds always, and, while capture is set, the attempt's enable_material and its EXPLAIN ANALYZE. */
let capture: null | { cell: string; arm: Arm; q: number; attempts: Any[] } = null;
const attemptLog: Record<Arm, AttemptKind[]> = { C: [], T: [] };
/** The vector attempt hook shared by both engines: classify, and under capture read the setting and EXPLAIN ANALYZE first. */
async function seeAttempt(arm: Arm, sql: string, bound: unknown, run: (sql: string, bound?: unknown) => Promise<Any[]>): Promise<void> {
  if (!sql.includes('candidate_pool') || sql.trimStart().startsWith('EXPLAIN')) return;
  const kind = attemptKind(sql);
  attemptLog[arm].push(kind);
  if (!capture) return;
  const [setting] = await run("SELECT current_setting('enable_material') AS enable_material");
  const [row] = await run('EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ' + sql, bound);
  const plan = row?.['QUERY PLAN'];
  capture.attempts.push({ attempt: capture.attempts.length, kind, sql_sha256: sha256(sql), enable_material: setting?.enable_material, plan: Array.isArray(plan) ? plan[0] : typeof plan === 'string' ? JSON.parse(plan)[0] : plan });
}

/** PGLite runs every vector attempt in this.db.transaction(tx => tx.query(...)); one engine serves both arms. */
let pgliteArm: Arm = 'C';
function instrumentPglite(engine: Any): Any {
  const db = engine.db;
  const original = db.transaction.bind(db);
  db.transaction = (fn: Any, ...rest: unknown[]) => original((tx: Any) => fn(new Proxy(tx, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== 'query') return typeof value === 'function' ? value.bind(target) : value;
      return async (sql: string, bound?: unknown[], ...more: unknown[]) => {
        await seeAttempt(pgliteArm, sql, bound, async (q, b) => (await target.query(q, b ?? [])).rows);
        return target.query(sql, bound, ...more);
      };
    },
  })), ...rest);
  return engine;
}

function instrument(engine: Any, arm: Arm): Any {
  const scoped = engine.withScopedReadTransaction;
  if (typeof scoped !== 'function') throw new Error('gbrain at the pin has no withScopedReadTransaction; the harness cannot see vector attempts');
  engine.withScopedReadTransaction = function (sourceIds: Any, sourceId: Any, fn: Any, options: Any) {
    return scoped.call(this, sourceIds, sourceId, (tx: Any) => fn(new Proxy(tx, {
      get(target, key) {
        if (key !== 'unsafe') return Reflect.get(target, key);
        return async (sql: string, bound: unknown[], ...rest: unknown[]) => {
          await seeAttempt(arm, sql, bound, async (q, b) => Array.from(await target.unsafe(q, b as Any)));
          return target.unsafe(sql, bound, ...rest);
        };
      },
    })), options);
  };
  return engine;
}

async function connect(arm: Arm): Promise<Any> {
  const engine = new mods[arm].Engine();
  if (ENGINE === 'pglite') {
    await engine.connect({ engine: 'pglite', database_path: DATA_DIR });
    return instrumentPglite(engine);
  }
  await engine.connect({ database_url: url.toString(), poolSize: 2 });
  return instrument(engine, arm);
}
async function connectAll(): Promise<Record<Arm, Any>> {
  if (ENGINE === 'pglite') { const one = await connect('C'); return { C: one, T: one }; }
  return { C: await connect('C'), T: await connect('T') };
}
async function disconnectAll(): Promise<void> {
  await engines.C.disconnect();
  if (engines.T !== engines.C) await engines.T.disconnect();
}

const created = !prior;
if (created && admin) await admin.unsafe('CREATE DATABASE ' + dbName);
if (created && ENGINE === 'pglite') rmSync(DATA_DIR, { recursive: true, force: true });
let engines: Record<Arm, Any> = await connectAll();
const control = () => engines.C;

/** Raw SQL outside any engine helper: Postgres through a short-lived connection, PGLite through the engine's db. */
async function withRaw<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<Any[]>, copy: (sql: string, text: string) => Promise<void>, tx: <R>(body: (q: (sql: string) => Promise<Any[]>) => Promise<R>) => Promise<R>) => Promise<T>): Promise<T> {
  if (ENGINE === 'pglite') {
    const db = control().db;
    return fn(async (q, p) => (await db.query(q, p ?? [])).rows, async (q, text) => { await db.query(q.replace('FROM STDIN', "FROM '/dev/blob'"), [], { blob: new Blob([text]) }); },
      body => db.transaction((t: Any) => body(async (q: string) => (await t.query(q)).rows)));
  }
  const sql = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await fn(async (q, p) => Array.from(await sql.unsafe(q, p as Any)), async (q, text) => {
      const copy = await sql.unsafe(q).writable();
      const finished = new Promise<void>((res, rej) => { copy.on('finish', res); copy.on('error', rej); });
      for (let i = 0; i < text.length; i += 1 << 20) if (!copy.write(text.slice(i, i + (1 << 20)))) await new Promise(r => copy.once('drain', r));
      copy.end();
      await finished;
    }, body => sql.begin((t: Any) => body(async (q: string) => Array.from(await t.unsafe(q)))));
  } finally { await sql.end(); }
}
const copyEscape = (text: string) => text.replace(/\\/g, '\\\\').replace(/[\t\r\n]/g, ' ');

async function copyPages(): Promise<void> {
  const rows: string[] = [];
  for (let p = 0; p < N; p++) rows.push((p + 1) + '\t' + slugs[p] + '\tfv-s50\tnote\tPage ' + p + '\tSynthetic page ' + p + '.\t{}\t00000000-0000-4000-8000-000000000001\t00000000-0000-4000-8000-000000000001\t4\n');
  await withRaw(async (q, copy) => {
    await copy('COPY pages (id, slug, source_id, type, title, compiled_truth, frontmatter, knowledge_revision, text_projection_revision, chunker_version) FROM STDIN', rows.join(''));
    await q("SELECT setval(pg_get_serial_sequence('pages', 'id'), " + N + ')');
  });
}

// ---------------------------------------------------------------------------
// Vectors: generated (L) or read from vectors.f32 (W)
// ---------------------------------------------------------------------------

const gen = basis ? new latent.Generator(params, basis) : null;
const vectorFd = CORPUS === 'wiki' ? openSync(join(CORPUS_DIR, 'vectors.f32'), 'r') : null;
function chunkVector(page: number, chunk: number): Float32Array {
  if (gen) {
    let out: Float32Array | undefined;
    gen.page(page, chunk + 1, (ci: number, v: Float32Array) => { if (ci === chunk) out = Float32Array.from(v); });
    return out!;
  }
  const buf = Buffer.allocUnsafe(DIMS * 4);
  readSync(vectorFd!, buf, 0, buf.length, (plan.chunkStart[page]! + chunk) * DIMS * 4);
  return new Float32Array(buf.buffer, buf.byteOffset, DIMS).slice();
}
function pageVectors(page: number): Float32Array[] {
  const count = plan.chunkCount[page]!;
  if (!gen) return Array.from({ length: count }, (_, c) => chunkVector(page, c));
  const out: Float32Array[] = [];
  gen.page(page, count, (_ci: number, v: Float32Array) => { out.push(Float32Array.from(v)); });
  return out;
}

/** PGLite has no worker COPY loader: chunks go in through text COPY in batches, vectors from the generator or vectors.f32. */
async function copyChunksPglite(): Promise<void> {
  const text = CORPUS === 'wiki' ? readFileSync(join(CORPUS_DIR, 'chunks.txt')) : null;
  let batch: string[] = [];
  const flush = async () => { if (!batch.length) return; const body = batch.join(''); batch = []; await withRaw((_q, copy) => copy('COPY content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding) FROM STDIN', body)); };
  for (let p = 0; p < N; p++) {
    const vectors = pageVectors(p);
    for (let c = 0; c < plan.chunkCount[p]!; c++) {
      const value = text ? text.toString('utf8', wikiOffsets![plan.chunkStart[p]! + c]!, wikiOffsets![plan.chunkStart[p]! + c + 1]! - 1) : latent.chunkText(params.seed, p, c, plan.topic[p]!) as string;
      batch.push((p + 1) + '\t' + c + '\t' + copyEscape(value) + '\tcompiled_truth\t' + MODEL + '\t' + createHash('md5').update(value).digest('hex') + '\t[' + Array.from(vectors[c]!).join(',') + ']\n');
    }
    if (batch.length >= 2000) await flush();
    if (p % 5000 === 0) log('pglite chunks: page ' + p + ' of ' + N);
  }
  await flush();
}

const LOAD_SETTINGS = { synchronous_commit: 'off', max_wal_size: "'32GB'", checkpoint_timeout: "'30min'" };
if (created) {
  const t0 = performance.now();
  if (admin) {
    for (const [k, v] of Object.entries(LOAD_SETTINGS)) await admin.unsafe('ALTER SYSTEM SET ' + k + ' = ' + v);
    await admin.unsafe('SELECT pg_reload_conf()');
  }
  await control().initSchema();
  await control().executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
  await control().executeRaw('INSERT INTO sources (id, name) VALUES ' + SOURCES.map(s => "('" + s + "', '" + s + "')").join(', ') + ' ON CONFLICT DO NOTHING');
  for (const t of ['content_chunks', 'pages', 'sources']) await control().executeRaw('ALTER TABLE ' + t + ' SET (autovacuum_enabled = off, toast.autovacuum_enabled = off)');
  await copyPages();
  log('pages: ' + N + '; streaming ' + CHUNKS + ' chunks with ' + WORKERS + ' workers');
  if (ENGINE === 'pglite') await copyChunksPglite();
  else await latent.loadLatentCorpus({ params, plan, basis, queries: [], url: url.toString(), model: MODEL, workers: WORKERS, log,
    ...(wikiOffsets ? { file: { dir: CORPUS_DIR, offsets: wikiOffsets.buffer as SharedArrayBuffer } } : {}) });
  const loadSeconds = (performance.now() - t0) / 1000;
  const t1 = performance.now();
  const buildSql = vectorIndex.chunkEmbeddingIndexSql(DIMS);
  const mwm = ENGINE === 'pglite' ? flag('pglite-maintenance-work-mem', '1GB') : Math.max(1, Math.floor(totalmem() / 4 / 2 ** 30)) + 'GB';
  await withRaw(async q => {
    await q("SET maintenance_work_mem = '" + mwm + "'");
    if (ENGINE === 'postgres') await q('SET max_parallel_maintenance_workers = ' + Math.max(0, cpus().length - 1));
    await q('SET statement_timeout = 0');
    await q(buildSql);
  });
  const buildSeconds = (performance.now() - t1) / 1000;
  for (const t of ['content_chunks', 'pages', 'sources']) await control().executeRaw('VACUUM ANALYZE ' + t);
  await projectionStats.refreshProjectionStatistics(control());
  if (admin) {
    for (const k of Object.keys(LOAD_SETTINGS)) await admin.unsafe('ALTER SYSTEM RESET ' + k);
    await admin.unsafe('SELECT pg_reload_conf()');
    await admin.unsafe('CHECKPOINT');
  } else await control().executeRaw('CHECKPOINT');
  const [boostConfig] = await control().executeRaw("SELECT value FROM config WHERE key = 'search.source_boosts'");
  if (boostConfig) throw new Error('the brain sets search.source_boosts, so the oracle would not rank by pure cosine');
  const [env] = await control().executeRaw("SELECT version() AS server, current_setting('server_version_num') AS server_num," +
    " (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector," +
    " current_setting('shared_buffers') AS shared_buffers, current_setting('effective_cache_size') AS effective_cache_size," +
    " current_setting('work_mem') AS work_mem, current_setting('random_page_cost') AS random_page_cost," +
    " current_setting('effective_io_concurrency') AS effective_io_concurrency, current_setting('synchronous_commit') AS synchronous_commit," +
    " current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather, current_setting('jit') AS jit," +
    " pg_relation_size('idx_chunks_embedding')::float8 AS index_bytes, (SELECT count(*) FROM content_chunks)::int AS chunks, (SELECT count(*) FROM pages)::int AS pages");
  if (Number(env.chunks) !== CHUNKS || Number(env.pages) !== N) throw new Error('loaded ' + env.chunks + ' chunks and ' + env.pages + ' pages, expected ' + CHUNKS + ' and ' + N);
  const gbrainCommit = execFileSync('git', ['-C', CONTROL, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  let harnessCommit = '';
  try { harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  const corpusFiles = CORPUS === 'wiki' ? Object.fromEntries(['pages.tsv', 'chunks.txt', 'vectors.f32'].map(f => [f, execFileSync('sha256sum', [join(CORPUS_DIR, f)], { encoding: 'utf8' }).split(' ')[0]])) : null;
  writeFileSync(manifestPath, JSON.stringify({
    db: ENGINE === 'pglite' ? DATA_DIR : dbName, label: LABEL, engine: ENGINE, image: IMAGE, corpus: CORPUS, corpus_files: corpusFiles, chunks: CHUNKS, dims: DIMS, seed: SEED, attr_seed: ATTR_SEED, query_seed: QUERY_SEED,
    latent: CORPUS === 'latent' ? params : null, pages: N, gbrain_commit: gbrainCommit, harness_commit: harnessCommit, arm_files: armFiles, index_sql: buildSql,
    load_seconds: loadSeconds, index_build_seconds: buildSeconds, maintenance_work_mem: mwm, env, machine: { cpus: cpus().length, mem_gb: Math.round(totalmem() / 2 ** 30) },
    boost_map: boostMap, hard_excludes: hardExcludes, queries: QUERIES, repeats: REPEATS, capture: CAPTURE, started: new Date().toISOString(),
  }, null, 2));
  log('loaded in ' + loadSeconds.toFixed(0) + ' s, index built in ' + buildSeconds.toFixed(0) + ' s');
}


/** Each page's locality-sensitive bucket: signs of the first chunk's inner products with seeded projections. */
async function pageBuckets(): Promise<Int32Array> {
  const projections = lshProjections(ATTR_SEED, DIMS);
  const cols = projections.map((_, i) => '(embedding <#> $' + (i + 1) + '::vector) < 0 AS b' + i).join(', ');
  const rows: Any[] = await control().executeRaw('SELECT page_id, ' + cols + ' FROM content_chunks WHERE chunk_index = 0', projections.map(v => JSON.stringify(v)));
  const out = new Int32Array(N);
  for (const row of rows) {
    let b = 0;
    projections.forEach((_, i) => { if (row['b' + i]) b |= 1 << i; });
    out[Number(row.page_id) - 1] = b;
  }
  return out;
}

const buckets = await pageBuckets();
const attrsByMode = new Map<Mode, PageAttributes[]>();
function attributesFor(mode: Mode): PageAttributes[] {
  const cached = attrsByMode.get(mode);
  if (cached) return cached;
  const ranks = Object.fromEntries(ATTRIBUTES.map(a => [a, attributeRanks(pageIds, mode === 'clustered' ? buckets : null, ATTR_SEED, a)])) as Record<Attribute, Float64Array>;
  const out = Array.from({ length: N }, (_, p) => pageAttributes({ type: ranks.type[p]!, tag: ranks.tag[p]!, date: ranks.date[p]!, source: ranks.source[p]! }, plan.vis[p]!));
  attrsByMode.set(mode, out);
  return out;
}

async function applyAttributes(mode: Mode): Promise<void> {
  const attrs = attributesFor(mode);
  const rows = attrs.map((a, p) => (p + 1) + '\t' + a.type + '\t' + a.tag + '\t' + a.date + '\t' + a.source + '\t' + (a.private ? 't' : 'f') + '\n');
  await withRaw(async (q, copy, tx) => {
    await q('DROP TABLE IF EXISTS fv_attr');
    await q('CREATE TEMP TABLE fv_attr (id int, type text, tag text, date timestamptz, source text, private boolean)');
    await copy('COPY fv_attr FROM STDIN', rows.join(''));
    await tx(async t => {
      await t('SET LOCAL session_replication_role = replica');
      await t("UPDATE pages p SET type = a.type, source_id = a.source, effective_date = a.date, effective_date_source = 'frontmatter'," +
        " frontmatter = jsonb_build_object('fv_tag', a.tag, 'fv_mode', '" + mode + "') || CASE WHEN a.private THEN '{\"visibility\":\"private\"}'::jsonb ELSE '{}'::jsonb END" +
        ' FROM fv_attr a WHERE p.id = a.id');
    });
    await q('DROP TABLE fv_attr');
  });
  await control().executeRaw('VACUUM ANALYZE pages');
  await projectionStats.refreshProjectionStatistics(control());
  const [check] = await control().executeRaw("SELECT count(*) FILTER (WHERE frontmatter->>'fv_mode' = '" + mode + "')::int AS n," +
    " count(*) FILTER (WHERE frontmatter->>'visibility' = 'private')::int AS private FROM pages");
  if (Number(check.n) !== N) throw new Error('attribute mode ' + mode + ' reached ' + check.n + ' of ' + N + ' pages');
  if (Number(check.private) !== attrs.filter(a => a.private).length) throw new Error('private pages ' + check.private + ' differ from the plan');
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface QuerySpec { q: number; page: number; chunk: number; inside: boolean | null }
interface Query extends QuerySpec { vector: Float32Array; set: string }

/** W query vectors: the first sentence of the source chunk, embedded with voyage-4 as a query, cached by chunk index. */
const queryCacheFile = CORPUS === 'wiki' ? join(CORPUS_DIR, 'fv-query-vectors.jsonl') : '';
const queryCache = new Map<number, Float32Array>();
if (queryCacheFile && existsSync(queryCacheFile)) {
  for (const line of readFileSync(queryCacheFile, 'utf8').split('\n')) if (line) { const r = JSON.parse(line); queryCache.set(r.chunk, Float32Array.from(r.v)); }
}
let paid: null | { run: Any; guard: Any } = null;
async function embedQueries(chunks: number[]): Promise<void> {
  const missing = [...new Set(chunks)].filter(c => !queryCache.has(c));
  if (!missing.length) return;
  if (!paid) {
    const ledger: Any = await import('../budget-ledger.ts');
    paid = ledger.startPaidRun('filtered-vector-queries', { ...ledger.budgetOptionsFrom(process.argv), estimateUsd: 0.05, log });
  }
  if (!process.env.VOYAGE_API_KEY) throw new Error('W query vectors are missing and VOYAGE_API_KEY is not set');
  const text = readFileSync(join(CORPUS_DIR, 'chunks.txt'));
  for (let i = 0; i < missing.length; i += 128) {
    const batch = missing.slice(i, i + 128);
    const texts = batch.map(c => firstSentence(text.toString('utf8', wikiOffsets![c]!, wikiOffsets![c + 1]! - 1)));
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.VOYAGE_API_KEY },
      body: JSON.stringify({ model: 'voyage-4', input: texts, input_type: 'query', output_dimension: DIMS }),
    });
    if (!res.ok) throw new Error('voyage ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const body = await res.json() as { data: Array<{ embedding: number[] }> };
    body.data.forEach((d, j) => {
      const v = Float32Array.from(d.embedding);
      let n = 0;
      for (const x of v) n += x * x;
      for (let k = 0; k < v.length; k++) v[k]! /= Math.sqrt(n);
      queryCache.set(batch[j]!, v);
      appendFileSync(queryCacheFile, JSON.stringify({ chunk: batch[j], v: Array.from(v) }) + '\n');
    });
  }
}

async function materialize(specs: QuerySpec[], set: string): Promise<Query[]> {
  if (CORPUS === 'wiki') {
    await embedQueries(specs.map(s => plan.chunkStart[s.page]! + s.chunk));
    return specs.map(s => ({ ...s, set, vector: queryCache.get(plan.chunkStart[s.page]! + s.chunk)! }));
  }
  return specs.map(s => {
    let coef: Float64Array | undefined;
    gen!.page(s.page, s.chunk + 1, (ci: number, _v: Float32Array, k: Float64Array) => { if (ci === s.chunk) coef = Float64Array.from(k); });
    const vector = new Float32Array(DIMS);
    gen!.query(plan.topic[s.page]!, coef!, new latent.Rng(hash32(QUERY_SEED, s.page, s.chunk, s.q)), vector);
    return { ...s, set, vector };
  });
}

function randomSpecs(n: number): QuerySpec[] {
  const next = rng(hash32(QUERY_SEED, CHUNKS, 0));
  return Array.from({ length: n }, (_, q) => {
    const chunk = Math.floor(next() * CHUNKS);
    let lo = 0, hi = N - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (plan.chunkStart[mid]! <= chunk) lo = mid; else hi = mid - 1; }
    return { q, page: lo, chunk: chunk - plan.chunkStart[lo]!, inside: null };
  });
}

function stratifiedSpecs(n: number, inPages: number[], outPages: number[], f: FilterSpec, caller: Caller): QuerySpec[] {
  const next = rng(hash32(QUERY_SEED, CHUNKS, ...[...f.id].map(ch => ch.charCodeAt(0)), caller === 'untrusted' ? 1 : 0));
  return Array.from({ length: n }, (_, q) => {
    const inside = q < n / 2;
    const pool = inside ? inPages : outPages;
    const page = pool[Math.floor(next() * pool.length)]!;
    return { q, page, chunk: Math.floor(next() * plan.chunkCount[page]!), inside };
  });
}

const independent = await materialize(randomSpecs(QUERIES), 'independent');
if (!existsSync(join(OUT, 'queries.jsonl'))) for (const q of independent) append('queries.jsonl', { set: 'independent', q: q.q, page: q.page + 1, chunk: q.chunk });

async function queriesFor(mode: Mode, f: FilterSpec, caller: Caller): Promise<Query[]> {
  const attrs = attributesFor(mode);
  const inPages: number[] = [], outPages: number[] = [];
  attrs.forEach((a, p) => (f.matches(a) && callerSees(caller, a) ? inPages : outPages).push(p));
  if (queryPlan(mode, f.kind, inPages.length, outPages.length) === 'independent') return independent;
  return materialize(stratifiedSpecs(QUERIES, inPages, outPages, f, caller), 'stratified:' + f.id + ':' + caller);
}

// ---------------------------------------------------------------------------
// Searches
// ---------------------------------------------------------------------------

function searchOpts(f: FilterSpec, caller: Caller, limit: number): Any {
  return { ...f.opts, ...callerOpts(caller), limit, embeddingColumn: column };
}

/** gbrain's exactSql for the same statement, its candidate window unbounded (null bound), JIT off, own transaction. */
async function exact(q: Query, opts: Any, k: number): Promise<{ pages: number[]; scores: number[]; ms: number }> {
  const stmt = vectorStatement.buildVectorSearchStatement({ dialect: ENGINE, embedding: q.vector, limit: k, offset: 0, opts });
  const t0 = performance.now();
  const rows: Any[] = await control().transaction(async (tx: Any) => {
    await tx.executeRaw("SET LOCAL statement_timeout = '1800s'");
    await tx.executeRaw('SET LOCAL jit = off');
    const bound = [...stmt.params];
    bound[stmt.innerLimitIdx] = null;
    return tx.executeRaw(stmt.exactSql, bound);
  });
  const hits = rows.filter(r => r.page_id != null).slice(0, k);
  return { pages: hits.map(r => Number(r.page_id)), scores: hits.map(r => Number(r.score)), ms: performance.now() - t0 };
}

/** The exact top pages per query at the largest limit, shared by every limit and both arms (a top 20 is the top 50's prefix). */
async function exactAll(queries: Query[], f: FilterSpec, caller: Caller, k: number) {
  const out: Array<{ pages: number[]; scores: number[]; ms: number }> = new Array(queries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(EXACT_CONCURRENCY, queries.length) }, async () => {
    for (let i = next++; i < queries.length; i = next++) out[i] = await exact(queries[i]!, searchOpts(f, caller, k), k);
  }));
  return out;
}

interface SearchRow { ms: number; pages: number[]; attempts: AttemptKind[]; joined: boolean; incomplete: boolean; error?: string }
async function search(arm: Arm, q: Query, opts: Any): Promise<SearchRow> {
  let incomplete = false;
  const before = attemptLog[arm].length;
  const t0 = performance.now();
  try {
    const callOpts = { ...opts, onVectorPoolMeta: (m: Any) => { if (m.incomplete) incomplete = true; } };
    pgliteArm = arm;
    const hits: Any[] = ENGINE === 'pglite' ? await mods[arm].Engine.prototype.searchVector.call(engines.C, q.vector, callOpts) : await engines[arm].searchVector(q.vector, callOpts);
    const ms = performance.now() - t0;
    const attempts = attemptLog[arm].splice(before);
    return { ms, pages: hits.map(h => Number(h.page_id)), attempts, joined: attempts.includes('joined'), incomplete };
  } catch (error) {
    const ms = performance.now() - t0;
    const attempts = attemptLog[arm].splice(before);
    return { ms, pages: [], attempts, joined: attempts.includes('joined'), incomplete, error: String((error as Error)?.message ?? error).slice(0, 300) };
  }
}

/** Arm order for query q and repeat r: AB, BA, AB for even queries; BA, AB, BA for odd ones. */
const order = (q: number, r: number): Arm[] => ((q + r) % 2 === 0 ? ['C', 'T'] : ['T', 'C']);

// ---------------------------------------------------------------------------
// Oracle check: gbrain's exactSql against a float64 brute force over the corpus vectors
// ---------------------------------------------------------------------------

let allVectors: Float32Array | null = null;
const pageBestCache = new Map<string, Float64Array>();
function pageBest(q: Query): Float64Array {
  const key = q.set === 'independent' ? 'i' + q.q : q.page + ':' + q.chunk + ':' + q.q;
  const hit = pageBestCache.get(key);
  if (hit) return hit;
  if (!allVectors) {
    allVectors = new Float32Array(CHUNKS * DIMS);
    if (gen) { let o = 0; for (let p = 0; p < N; p++) gen.page(p, plan.chunkCount[p]!, (_c: number, v: Float32Array) => { allVectors!.set(v, o); o += DIMS; }); }
    else { const buf = Buffer.from(allVectors.buffer); readSync(vectorFd!, buf, 0, buf.length, 0); }
  }
  const best = new Float64Array(N);
  for (let p = 0, i = 0; p < N; p++) {
    let b = -Infinity;
    for (let c = 0; c < plan.chunkCount[p]!; c++, i++) {
      let dot = 0;
      const o = i * DIMS;
      for (let d = 0; d < DIMS; d++) dot += allVectors[o + d]! * q.vector[d]!;
      if (dot > b) b = dot;
    }
    best[p] = b;
  }
  if (pageBestCache.size > 2000) pageBestCache.clear();
  pageBestCache.set(key, best);
  return best;
}

function oracleRows(cell: string, mode: Mode, caller: Caller, f: FilterSpec, queries: Query[], ex: Array<{ pages: number[]; scores: number[] }>, k: number) {
  const attrs = attributesFor(mode);
  const eligible: number[] = [];
  for (let p = 0; p < N; p++) if (f.matches(attrs[p]!) && callerSees(caller, attrs[p]!)) eligible.push(p);
  let agree = 0;
  queries.forEach((q, i) => {
    const best = pageBest(q);
    const ranked = [...eligible].sort((a, b) => best[b]! - best[a]! || a - b).slice(0, k);
    const brute = ranked.map(p => p + 1);
    const bruteScores = ranked.map(p => best[p]!);
    const e = ex[i]!;
    const kth = bruteScores[bruteScores.length - 1] ?? 0;
    const exactSet = new Set(e.pages.slice(0, k));
    const scoreOf = new Map(e.pages.map((p, j) => [p, e.scores[j]!]));
    const ok = brute.length === Math.min(k, e.pages.length) && e.pages.length >= brute.length
      && brute.every(p => (exactSet.has(p) && Math.abs(best[p - 1]! - scoreOf.get(p)!) < 1e-5) || Math.abs(best[p - 1]! - kth) < 1e-6)
      && e.pages.slice(0, k).every(p => Math.abs(best[p - 1]! - (scoreOf.get(p) ?? NaN)) < 1e-5);
    if (ok) agree++;
    stage('oracle-check.jsonl', { cell, q: q.q, k, ok, brute, brute_scores: bruteScores, exact: e.pages.slice(0, k), exact_scores: e.scores.slice(0, k) });
  });
  return agree;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function describeCell(id: string, mode: Mode, caller: Caller, f: FilterSpec, limit: number, cache: 'warm' | 'cold', queries: Query[]) {
  const attrs = attributesFor(mode);
  return {
    cell: id, label: LABEL, engine: ENGINE, corpus: CORPUS, chunks: CHUNKS, pages: N, mode, caller, filter: f.id, kind: f.kind,
    affected: f.affected, share_nominal: f.share, share_measured: attrs.filter(a => f.matches(a)).length / N,
    eligible_pages: attrs.filter(a => f.matches(a) && callerSees(caller, a)).length, limit, cache, queries: queries.length,
    query_set: queries[0]?.set ?? 'none', inside: queries.filter(q => q.inside === true).length, query_seed: QUERY_SEED,
  };
}

async function runCell(id: string, mode: Mode, caller: Caller, f: FilterSpec, limit: number, cache: 'warm' | 'cold', queries: Query[], ex: Array<{ pages: number[]; scores: number[]; ms: number }>) {
  if (done.has(id)) return;
  const opts = searchOpts(f, caller, limit);
  stage('cells.jsonl', describeCell(id, mode, caller, f, limit, cache, queries));
  queries.forEach((q, i) => stage('exact.jsonl', { cell: id, q: q.q, page: q.page + 1, chunk: q.chunk, inside: q.inside, pages: ex[i]!.pages.slice(0, limit), scores: ex[i]!.scores.slice(0, limit), ms: ex[i]!.ms }));
  if (ORACLE_CHECK) {
    const agree = oracleRows(id, mode, caller, f, queries, ex, limit);
    log(id + ': oracle agrees on ' + agree + ' of ' + queries.length);
  }
  if (cache === 'warm') {
    for (const q of queries.slice(0, CAPTURE)) {
      for (const arm of ARMS) {
        capture = { cell: id, arm, q: q.q, attempts: [] };
        await search(arm, q, opts);
        stage('plans.jsonl', capture);
        capture = null;
      }
    }
    for (const q of queries) for (const arm of order(q.q, 0)) await search(arm, q, opts);
    for (let rep = 0; rep < REPEATS; rep++) {
      for (const q of queries) {
        for (const arm of order(q.q, rep)) stage('searches.jsonl', { cell: id, arm, q: q.q, rep, ...(await search(arm, q, opts)) });
      }
    }
  } else {
    for (const q of queries) {
      for (const arm of order(q.q, 0)) {
        await restartCold();
        engines = await connectAll();
        stage('searches.jsonl', { cell: id, arm, q: q.q, rep: 0, ...(await search(arm, q, opts)) });
      }
    }
  }
  commitCell(id);
  log(id + ' done');
}

function sh(cmd: string, args: string[]) { execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] }); }
async function restartCold(): Promise<void> {
  await disconnectAll();
  if (ENGINE === 'pglite') { sh('sudo', ['sh', '-c', 'sync; echo 3 > /proc/sys/vm/drop_caches']); return; }
  sh('docker', ['restart', CONTAINER]);
  for (let i = 0; ; i++) {
    try { execFileSync('docker', ['exec', CONTAINER, 'pg_isready', '-q', '-U', 'postgres'], { stdio: 'ignore' }); await admin!.unsafe('SELECT 1'); break; }
    catch { if (i > 240) throw new Error('Postgres did not come back'); await new Promise(r => setTimeout(r, 500)); }
  }
  sh('sudo', ['sh', '-c', 'sync; echo 3 > /proc/sys/vm/drop_caches']);
}

const specs = filters().filter(f => FILTER_IDS.includes('all') || FILTER_IDS.includes(f.id));
const cellId = (mode: Mode, caller: Caller, f: FilterSpec, limit: number, cache: string) => [LABEL, CORPUS, CHUNKS, mode, caller, f.id, 'k' + limit, cache, 'qs' + QUERY_SEED].join('|');
for (const mode of RUN_MODES) {
  let applied = false;
  for (const caller of RUN_CALLERS) {
    for (const f of specs) {
      const limits = LIMITS.filter(k => k === 20 || LIMIT50_MODES.includes(mode));
      const ids = limits.map(k => cellId(mode, caller, f, k, 'warm'));
      if (!WARM || ids.every(id => done.has(id))) continue;
      if (!applied) { await applyAttributes(mode); applied = true; log('attributes: ' + mode); }
      const queries = await queriesFor(mode, f, caller);
      const ex = await exactAll(queries, f, caller, Math.max(...limits));
      for (const [j, k] of limits.entries()) await runCell(ids[j]!, mode, caller, f, k, 'warm', queries, ex);
    }
  }
  if (mode === 'independent' && RUN_CALLERS.includes('untrusted') && COLD_QUERIES > 0) {
    for (const f of specs.filter(s => COLD_FILTERS.includes(s.id))) {
      const id = cellId(mode, 'untrusted', f, 20, 'cold');
      if (done.has(id)) continue;
      if (!applied) { await applyAttributes(mode); applied = true; }
      const queries = independent.slice(0, COLD_QUERIES);
      await runCell(id, mode, 'untrusted', f, 20, 'cold', queries, await exactAll(queries, f, 'untrusted', 20));
    }
    await disconnectAll();
    engines = await connectAll();
  }
}

await disconnectAll();
const paidRun = paid as null | { run: Any; guard: Any };
if (paidRun) { paidRun.guard.uninstall(); append('paid-queries.jsonl', { at: new Date().toISOString(), summary: paidRun.run.close() }); }
if (vectorFd !== null) closeSync(vectorFd);
if (!KEEP && admin) await admin.unsafe('DROP DATABASE IF EXISTS ' + dbName + ' WITH (FORCE)');
if (!KEEP && ENGINE === 'pglite') rmSync(DATA_DIR, { recursive: true, force: true });
await admin?.end();
log('finished');
