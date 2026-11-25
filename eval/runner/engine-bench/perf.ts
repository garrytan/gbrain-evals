/**
 * engine-bench, speed stage: the same brain, the same operations and the same inputs through each gbrain storage
 * engine, so the Rust engine can be checked against "no slower than PGLite and Postgres on your workload".
 *
 * Engines: PGLite (in process, on-disk data directory), Postgres with pgvector (a local pgvector/pgvector container)
 * and Rust (gbrain's planned in-process engine). Every engine is opened through eval/runner/eval-engine.ts
 * (openEvalEngine), which refuses the rust arm until the gbrain build under test carries the engine and its addon loads.
 *
 * Writes go through gbrain's own import path (importFromContent: chunking, embedding, sealing) with a seeded local
 * embedder installed at gbrain's embed-transport seam, so no provider is ever called and every engine stores the same
 * vectors. Reads are the typed engine methods (getPage, searchKeyword, searchVector, getBacklinks, getTimeline,
 * listPages, traverseGraph) and gbrain's own hybridSearch with expansion and the reranker off.
 *
 * Built from the engine-shootout runner in garrytan/gbrain-evals#466 (its dataset, embedder, process layout and paired
 * analysis), extended with the Rust arm, graph walks, concurrent throughput, quantile ratios and the engine-bench
 * decision rule. Children get a minimal environment with no API keys.
 *
 * Process layout:
 *   orchestrator
 *     -> per engine: --child arm        import the corpus, single-engine latencies, rankings, memory
 *     -> per engine: --child coldstart  a fresh process opens the existing store and answers one query (x cold-reps)
 *     -> per pair:   --child paired     both engines open; each query runs on both back to back in a seeded random
 *                                       order (latency); then blocks of concurrent clients alternate between the
 *                                       two engines (throughput at 1, 4 and 16 clients)
 *
 * Usage:
 *   bun eval/runner/engine-bench/perf.ts --scale 10000 [--engines pglite,postgres,rust] [--gbrain <checkout>@<ref>]
 *        [--iters 2000] [--warmup 100] [--cold-reps 11] [--tp-reps 10] [--tp-seconds 5] [--seed 1337]
 *        [--out <dir>] [--dev | --prereg <path>] [--postgres-url <url>] [--pg-image pgvector/pgvector:pg16]
 *        [--keep-work]
 *
 * With no --dev the run is counted: it refuses to start unless --prereg names a committed, unchanged preregistration
 * that is on origin, and writes that attestation into the receipt.
 */

import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { createServer } from 'net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { cpus, loadavg, platform, release, tmpdir, totalmem } from 'os';
import { join, relative, resolve } from 'path';
import type { BrainEngine } from 'gbrain/engine';
import type { SearchResult } from 'gbrain/types';
import { redactUrlPasswords } from '../hermetic-env.ts';
import { writeScrubbedJson } from '../receipt.ts';
import { attestPreregistration, type Attestation } from '../prereg.ts';
import { clusteredPairedDelta, seededRandom, type PairedItem } from '../stats/paired.ts';
import { EvalEngineUnavailable, isCapabilityMissing, openEvalEngine, rustAddonIdentity, supportsRawSql, type EvalEngineKind } from '../eval-engine.ts';
import { freshPostgresDatabase } from './surface-parity.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';

// ─── Constants ──────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;
export const EMBED_DIMS = 1024;
export const EMBED_MODEL_PIN = 'voyage:voyage-4';
export const EMBED_MODEL = 'hash-embed-v1';
export const RRF_K = 60;
export const DEFAULT_PG_IMAGE = 'pgvector/pgvector:pg16';
export const POSTGRES_POOL_MAX = 24;

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const DATA_DIR = join(REPO_ROOT, 'eval/data');
const REPORT_DIR = join(REPO_ROOT, 'eval/reports/engine-bench');

/** gbrain's retrieval knobs pinned on every engine, so no run depends on mode-bundle defaults or which keys exist. */
export const PINNED_SEARCH_CONFIG: Readonly<Record<string, string>> = Object.freeze({
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.autocut': 'false',
  'search.expansion.enabled': 'false',
});

/** Operations timed per query on both engines of a pair. */
export const PAIRED_OPS = [
  'get_page', 'put_page', 'search_keyword', 'search_vector', 'search_hybrid', 'search_keyword_filtered',
  'search_vector_filtered', 'graph_walk_d1', 'graph_walk_d2', 'graph_walk_d3', 'get_backlinks', 'get_timeline', 'list_pages',
] as const;
export type PairedOp = (typeof PAIRED_OPS)[number];
/** The operations every gbrain session leans on. A loss here is never a named exception (see MARGINS). */
export const CORE_OPS: readonly PairedOp[] = ['get_page', 'put_page', 'search_keyword', 'search_vector', 'search_hybrid'];
export const THROUGHPUT_CLIENTS = [1, 4, 16] as const;
/** Read mix for concurrent clients, cycled per operation: 3 get, 2 keyword, 2 vector, 2 hybrid, 1 graph walk depth 2. */
export const READ_MIX = ['get_page', 'search_keyword', 'get_page', 'search_vector', 'search_hybrid', 'get_page', 'search_keyword', 'search_vector', 'search_hybrid', 'graph_walk_d2'] as const;

/**
 * "No slower" margins. Placeholders for the harness; the preregistration fixes the values used by counted runs and
 * the runner reads them from there (--margins), never from a result.
 */
export const DEFAULT_MARGINS = {
  /** Rust over TypeScript-engine latency ratio (p50 and p99): pass when the 95% interval's upper bound is at most this. */
  latency_ratio: 1.10,
  /** Rust over TypeScript-engine throughput ratio: pass when the 95% interval's lower bound is at least this. */
  throughput_ratio: 0.90,
  /** Cold start, import and RSS: one value per engine, pass when Rust is within this ratio. */
  point_ratio: 1.10,
  /** A named exception never exceeds this ratio on its point estimate. */
  exception_ratio: 1.5,
  bootstrap_draws: 10000,
  quantile_draws: 2000,
} as const;
export type Margins = { -readonly [K in keyof typeof DEFAULT_MARGINS]: number };

// ─── Small utilities ────────────────────────────────────────────────

/** Seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export interface LatencyStats { n: number; p50_ms: number; p95_ms: number; p99_ms: number; mean_ms: number; min_ms: number; max_ms: number }

export function summarize(samples: number[]): LatencyStats {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((x, y) => x + y, 0);
  return { n: s.length, p50_ms: percentile(s, 50), p95_ms: percentile(s, 95), p99_ms: percentile(s, 99), mean_ms: s.length ? sum / s.length : 0, min_ms: s[0] ?? 0, max_ms: s[s.length - 1] ?? 0 };
}

/** The command line a receipt records, with the password of any connection URL replaced. */
export function recordedCommand(argv: string[]): string {
  return `bun eval/runner/engine-bench/perf.ts ${argv.map(a => redactUrlPasswords(a)).join(' ')}`.trim();
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
}

const IS_CHILD = process.argv.includes('--child');
function log(msg: string): void {
  process.stderr.write(`${IS_CHILD ? '@@ ' : ''}${msg}\n`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Deterministic embedder ─────────────────────────────────────────

const STOPWORDS = new Set((
  'a an and are as at be but by for from has have he her his i in is it its of on or she that the their they this to was were will with who what which when where how did does do not been being into than then there these those you your our we us me my'
).split(' '));

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter((t) => !STOPWORDS.has(t));
}

/**
 * Seeded feature-hashing embedder: unigrams (weight 1) and bigrams (0.5) hashed into EMBED_DIMS buckets with a hashed
 * sign, 8 buckets per feature, L2-normalised. It captures word overlap, not meaning; it is the same for every engine,
 * which is what an engine comparison needs. It is a control, never a retrieval-quality claim.
 */
export function hashEmbed(text: string, dims = EMBED_DIMS): Float32Array {
  const v = new Float32Array(dims);
  const toks = tokenize(text);
  const feats: Array<[string, number]> = [];
  for (let i = 0; i < toks.length; i++) {
    feats.push([toks[i], 1]);
    if (i + 1 < toks.length) feats.push([`${toks[i]}_${toks[i + 1]}`, 0.5]);
  }
  for (const [f, w] of feats) {
    for (let j = 0; j < 8; j++) {
      const h = fnv1a(`${f}#${j}`);
      v[h % dims] += ((h >>> 16) & 1 ? 1 : -1) * w;
    }
  }
  let n = 0;
  for (let i = 0; i < dims; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dims; i++) v[i] /= n;
  return v;
}

// ─── Ranking metrics ────────────────────────────────────────────────

export function recallAtK(ranked: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((r) => top.has(r)).length / relevant.length;
}

export function ndcgAtK(ranked: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const rel = new Set(relevant);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (rel.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.length); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/** |A ∩ B| / max(|A|, |B|) over the top-k of two ranked lists; both empty counts as agreement. */
export function overlapAtK(a: string[], b: string[], k: number): number {
  const ta = a.slice(0, k);
  const tb = new Set(b.slice(0, k));
  if (ta.length === 0 && tb.size === 0) return 1;
  return ta.filter((x) => tb.has(x)).length / Math.max(ta.length, tb.size);
}

/** Collapse chunk-level results to a de-duplicated, ordered page-slug list. */
export function toSlugs(results: Array<{ slug: string }>, limit = 10): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (!out.includes(r.slug)) out.push(r.slug);
    if (out.length >= limit) break;
  }
  return out;
}

// ─── Dataset ────────────────────────────────────────────────────────

export interface DPage { slug: string; type: string; title: string; compiled_truth: string; timeline: string; base: boolean }
export interface DLink { from_slug: string; to_slug: string; link_type: string }
export interface DTimeline { slug: string; date: string; summary: string }
export interface QualityQuery { id: string; text: string; relevant: string[] }

export interface Dataset {
  pages: DPage[];
  links: DLink[];
  timeline: DTimeline[];
  qualityQueries: QualityQuery[];
  probes: string[];
  /** Pages with at least one inbound link (backlink probes). */
  linkedSlugs: string[];
  /** Pages with at least one outbound link (graph-walk starts). */
  walkSlugs: string[];
  fingerprint: string;
  counts: { pages: number; base_pages: number; filler_pages: number; links: number; timeline: number; quality_queries: number; probes: number };
}

function readJsonPages(dir: string): Array<Record<string, any>> {
  return readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir).sort()) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walkMarkdown(full, out);
    else if (full.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Paragraph pool for filler pages: synthetic-v1 and source-swamp-v1 prose, never world-v1, so filler never competes with the gold pages of the quality queries. */
export function loadFillerParagraphs(dataDir = DATA_DIR): string[] {
  const paras: string[] = [];
  const add = (text: string) => {
    for (const p of text.split(/\n{2,}/)) {
      const t = p.replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_m, s: string) => s.split('/').pop()!.replace(/-/g, ' ')).replace(/\]\([^)]*\)/g, ']').trim();
      if (t.length >= 60 && !t.startsWith('#') && !t.startsWith('---') && !t.startsWith('- **')) paras.push(t);
    }
  };
  for (const f of walkMarkdown(join(dataDir, 'synthetic-v1'))) add(readFileSync(f, 'utf-8').replace(/^---[\s\S]*?---\n/, ''));
  for (const p of readJsonPages(join(dataDir, 'source-swamp-v1'))) add(Array.isArray(p.compiled_truth) ? p.compiled_truth.join('\n\n') : String(p.compiled_truth ?? ''));
  return paras;
}

const FILLER_TYPES: Array<[string, string]> = [['person', 'people'], ['company', 'companies'], ['meeting', 'meetings'], ['concept', 'concepts']];
const LINK_RE = /\]\(([a-z][a-z-]*\/[a-z0-9-]+)\)/g;
const TL_RE = /^- \*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|\s*(.+)$/;

/** The page as gbrain markdown: frontmatter, compiled truth, then the timeline after gbrain's sentinel. */
export function pageMarkdown(p: DPage): string {
  const head = ['---', `type: ${p.type}`, `title: ${JSON.stringify(p.title)}`, '---', ''].join('\n');
  const body = p.compiled_truth.trim();
  return p.timeline.trim() ? `${head}\n${body}\n\n---\n\n## Timeline\n\n${p.timeline.trim()}\n` : `${head}\n${body}\n`;
}

/**
 * The synthetic corpus, deterministic for (scale, seed) and the committed files: the 240 world-v1 pages (which carry
 * the Tier 5 and 5.5 gold pages), then seeded filler pages recombined from other committed corpora up to the scale,
 * each with two outbound links to earlier pages and two to four dated timeline lines.
 */
export function buildDataset(scale: number, seed: number, dataDir = DATA_DIR, qualityQueries?: QualityQuery[]): Dataset {
  const r = rng(seed);
  const base = readJsonPages(join(dataDir, 'world-v1')).map((p): DPage => ({
    slug: String(p.slug), type: String(p.type), title: String(p.title ?? ''),
    compiled_truth: Array.isArray(p.compiled_truth) ? p.compiled_truth.join('\n\n') : String(p.compiled_truth ?? ''),
    timeline: Array.isArray(p.timeline) ? p.timeline.join('\n') : String(p.timeline ?? ''),
    base: true,
  }));
  const pages: DPage[] = base.slice(0, scale);
  const pool = loadFillerParagraphs(dataDir);
  const vocab = [...new Set(pool.flatMap((p) => tokenize(p)).filter((t) => t.length >= 5))].sort();
  const need = Math.max(0, scale - pages.length);
  for (let i = 0; i < need; i++) {
    const [type, dir] = FILLER_TYPES[Math.floor(r() * FILLER_TYPES.length)];
    const nPara = 3 + Math.floor(r() * 4);
    const paras: string[] = [];
    for (let j = 0; j < nPara; j++) paras.push(pool[Math.floor(r() * pool.length)]);
    const words = [0, 1, 2].map(() => vocab[Math.floor(r() * vocab.length)]);
    const id = String(i).padStart(6, '0');
    const targets = [0, 1].map(() => pages[Math.floor(r() * pages.length)].slug);
    paras.push(`See also [${targets[0]}](${targets[0]}) and [${targets[1]}](${targets[1]}).`);
    const tl: string[] = [];
    for (let j = 0, n = 2 + Math.floor(r() * 3); j < n; j++) {
      const y = 2021 + Math.floor(r() * 5), m = 1 + Math.floor(r() * 12), d = 1 + Math.floor(r() * 28);
      const evt = pool[Math.floor(r() * pool.length)].split(/(?<=\.)\s/)[0].slice(0, 140);
      tl.push(`- **${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}** | ${evt}`);
    }
    pages.push({ slug: `${dir}/filler-${id}`, type, title: `Archive ${id} ${words.join(' ')}`, compiled_truth: paras.join('\n\n'), timeline: tl.join('\n'), base: false });
  }

  const slugSet = new Set(pages.map((p) => p.slug));
  const links: DLink[] = [];
  const timeline: DTimeline[] = [];
  const inbound = new Set<string>();
  const outbound = new Set<string>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const m of `${p.compiled_truth}\n${p.timeline}`.matchAll(LINK_RE)) {
      const to = m[1];
      if (to !== p.slug && slugSet.has(to) && !seen.has(to)) {
        seen.add(to);
        links.push({ from_slug: p.slug, to_slug: to, link_type: 'mentions' });
        inbound.add(to);
        outbound.add(p.slug);
      }
    }
    for (const line of p.timeline.split('\n')) {
      const m = line.match(TL_RE);
      if (m) timeline.push({ slug: p.slug, date: m[1], summary: m[2].slice(0, 300) });
    }
  }

  const probes: string[] = [];
  while (probes.length < 400) {
    const p = pages[Math.floor(r() * pages.length)];
    const toks = tokenize(p.compiled_truth).filter((t) => t.length >= 4);
    if (toks.length < 4) continue;
    const at = Math.floor(r() * (toks.length - 3));
    probes.push(toks.slice(at, at + 2 + Math.floor(r() * 2)).join(' '));
  }
  const qq = (qualityQueries ?? []).filter((q) => q.relevant.length > 0 && q.relevant.every((s) => slugSet.has(s)));

  const h = createHash('sha256');
  h.update(`${EMBED_MODEL}:${EMBED_DIMS}\u0002`);
  for (const p of pages) h.update(`${p.slug}\u0000${p.type}\u0000${p.title}\u0000${p.compiled_truth}\u0000${p.timeline}\u0001`);
  for (const q of qq) h.update(`${q.id}\u0000${q.text}\u0000${q.relevant.join(',')}\u0001`);
  for (const p of probes) h.update(`${p}\u0001`);

  return {
    pages, links, timeline, qualityQueries: qq, probes,
    linkedSlugs: [...inbound].sort(), walkSlugs: [...outbound].sort(),
    fingerprint: h.digest('hex'),
    counts: { pages: pages.length, base_pages: pages.filter((p) => p.base).length, filler_pages: pages.filter((p) => !p.base).length, links: links.length, timeline: timeline.length, quality_queries: qq.length, probes: probes.length },
  };
}

async function loadQualityQueries(): Promise<QualityQuery[]> {
  const { getAllTierQueries } = await import('../queries/index.ts');
  return getAllTierQueries().filter((q) => q.gold?.relevant?.length).map((q) => ({ id: q.id, text: q.text, relevant: [...q.gold.relevant!] }));
}

// ─── Engine arms ────────────────────────────────────────────────────

/** Serializable description of how a child opens an engine and where its server-side resources can be read. */
export interface ArmRuntime {
  kind: EvalEngineKind;
  databasePath?: string;
  databaseUrl?: string;
  cgroupDir?: string;
  containerId?: string;
}

export interface ArmHandle {
  runtime: ArmRuntime;
  info: Record<string, unknown>;
  diskUsage(): Promise<DiskUsage>;
  teardown(): Promise<void>;
}

export interface ArmSpec {
  id: EvalEngineKind;
  label: string;
  kind: string;
  prepare(ctx: { workDir: string; opts: Options }): Promise<ArmHandle>;
}

/** A disk size, or null with the reason when no source could measure it: an unmeasured store never reads as 0 bytes. */
export interface DiskUsage { total_bytes: number | null; method: string }

type DuRun = (args: string[]) => { status: number | null; stdout: string | null };

/** The first field of a successful du answer, or null. */
function duField(r: ReturnType<DuRun>): number | null {
  const field = r.status === 0 ? r.stdout?.trim().split(/\s+/)[0] : undefined;
  return field && /^\d+$/.test(field) ? Number(field) : null;
}

/**
 * The store's size from `du -sb` (GNU du, apparent bytes). BSD du (macOS) has no -b, so it falls back to `du -sk`
 * (allocated 1 KiB blocks), named as a different method, and to null when neither answers.
 */
export function measureDisk(path: string, label: string, run: DuRun = (args) => spawnSync('du', args, { encoding: 'utf-8' })): DiskUsage {
  if (!existsSync(path)) return { total_bytes: null, method: `not measured: the ${label} store is missing` };
  const bytes = duField(run(['-sb', path]));
  if (bytes !== null) return { total_bytes: bytes, method: `du -sb of the ${label} store after the engine closed` };
  const kib = duField(run(['-sk', path]));
  if (kib !== null) return { total_bytes: kib * 1024, method: `du -sk of the ${label} store after the engine closed (allocated 1 KiB blocks, not the apparent bytes du -sb reports)` };
  return { total_bytes: null, method: `not measurable on ${process.platform}: du -sb and du -sk both failed` };
}

function embeddedArm(id: 'pglite' | 'rust', label: string, kind: string, store: string): ArmSpec {
  return {
    id, label, kind,
    async prepare({ workDir }) {
      const path = join(workDir, store);
      return {
        runtime: { kind: id, databasePath: path },
        info: { store: `workdir/${store} (local disk)` },
        async diskUsage() { return measureDisk(path, label); },
        async teardown() { rmSync(path, { recursive: true, force: true }); },
      };
    },
  };
}

function docker(args: string[], opts: { timeout?: number } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: opts.timeout ?? 120_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => res(port)); });
    s.on('error', rej);
  });
}

const PG_SETTINGS = ['shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size', 'max_connections', 'max_wal_size', 'synchronous_commit', 'fsync', 'max_parallel_workers_per_gather', 'random_page_cost', 'server_version'];

const postgresArm: ArmSpec = {
  id: 'postgres',
  label: 'Postgres + pgvector',
  kind: 'PostgreSQL server with pgvector in a local Docker container, stock configuration, reached over loopback TCP',
  async prepare({ opts }) {
    if (opts.postgresUrl) {
      const db = await freshPostgresDatabase(opts.postgresUrl, `engine_bench_perf_${process.pid}_${Date.now()}`);
      return {
        runtime: { kind: 'postgres', databaseUrl: db.url },
        info: { mode: 'scratch database on an external server (--postgres-url); server CPU and memory not measured' },
        async diskUsage() { return { total_bytes: null, method: 'not measured for an external server' }; },
        async teardown() { await db.drop(); },
      };
    }
    const runId = `${process.pid}-${Date.now()}`;
    const name = `gbrain-engine-bench-${runId}`;
    const port = await freePort();
    const password = createHash('sha256').update(`${runId}${Math.random()}`).digest('hex').slice(0, 24);
    const run = docker(['run', '-d', '--name', name, '--label', `gbrain-evals.engine-bench=${runId}`, '-e', `POSTGRES_PASSWORD=${password}`, '-p', `127.0.0.1:${port}:5432`, opts.pgImage, '-c', 'max_connections=200']);
    if (run.code !== 0) throw new Error(`docker run failed: ${run.err}`);
    const id = run.out.split('\n').pop()!.trim();
    log(`[postgres] started container ${name} on 127.0.0.1:${port}`);
    let removed = false;
    const remove = () => { if (removed) return; removed = true; docker(['rm', '-f', '-v', id]); log(`[postgres] removed container ${name}`); };
    const onSig = () => { remove(); process.exit(130); };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
    process.once('exit', remove);
    try {
      const t0 = Date.now();
      for (;;) {
        const r = docker(['exec', id, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-Atc', 'select 1']);
        if (r.code === 0 && r.out === '1') break;
        if (Date.now() - t0 > 90_000) throw new Error('postgres container did not become ready in 90s');
        await sleep(250);
      }
    } catch (e) { remove(); throw e; }
    const fullId = docker(['inspect', '--format', '{{.Id}}', id]).out;
    const cgroupDir = `/sys/fs/cgroup/system.slice/docker-${fullId}.scope`;
    const haveCgroup = existsSync(join(cgroupDir, 'memory.current'));
    const settings: Record<string, string> = {};
    const q = docker(['exec', id, 'psql', '-U', 'postgres', '-Atc', `select name||'='||setting||coalesce(unit,'') from pg_settings where name in (${PG_SETTINGS.map((s) => `'${s}'`).join(',')})`]);
    for (const line of q.out.split('\n')) { const [k, v] = line.split('='); if (k) settings[k] = v; }
    const info: Record<string, unknown> = {
      image: opts.pgImage, image_digest: docker(['image', 'inspect', '--format', '{{index .RepoDigests 0}}', opts.pgImage]).out, settings,
      resource_limits: 'none (the container can use every host CPU and all memory)',
      server_stats: haveCgroup ? 'host cgroup v2 files of the container' : 'unavailable (cgroup path not readable)',
      pool_max: POSTGRES_POOL_MAX,
    };
    return {
      runtime: { kind: 'postgres', databaseUrl: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`, cgroupDir: haveCgroup ? cgroupDir : undefined, containerId: id },
      info,
      async diskUsage() {
        info.pgvector_extension_version = docker(['exec', id, 'psql', '-U', 'postgres', '-Atc', "select extversion from pg_extension where extname='vector'"]).out || 'not installed';
        docker(['exec', id, 'psql', '-U', 'postgres', '-Atc', 'CHECKPOINT']);
        const bytes = duField({ status: 0, stdout: docker(['exec', id, 'du', '-sb', '/var/lib/postgresql/data']).out });
        return { total_bytes: bytes, method: bytes === null ? 'not measurable: du -sb of PGDATA inside the container failed' : 'du -sb of PGDATA inside the container after CHECKPOINT' };
      },
      async teardown() { remove(); process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig); },
    };
  },
};

/**
 * Engine table. Every measurement goes through BrainEngine and gbrain's own import and search code; nothing below is
 * engine specific except how the store is created and read for disk size. The rust arm opens through openEvalEngine,
 * which refuses (EvalEngineUnavailable) until the gbrain build under test carries the Rust engine and its addon loads.
 */
export const ENGINES: Record<EvalEngineKind, ArmSpec> = {
  pglite: embeddedArm('pglite', 'PGLite', 'in-process WASM Postgres with pgvector, on-disk data directory', 'pglite-data'),
  postgres: postgresArm,
  rust: embeddedArm('rust', 'Rust', 'gbrain Rust engine, in-process napi-rs addon, on-disk store', 'brain.rust'),
};

// ─── Measurement helpers (children) ─────────────────────────────────

const RSS_SPAN = 'Baseline is RSS after the dataset is built and before the engine opens; engine RSS is that value minus baseline. Steady is RSS after 2,000 mixed reads that follow the import.';

/** How the benchmark reads its own resident memory. A read that fails is null, a skipped sample; `hwmKb` is the kernel's high-water mark. */
export interface RssSource { method: string; rssKb(): number | null; hwmKb(): number | null }

/**
 * /proc/self/status (VmRSS and VmHWM) on Linux. Where /proc is missing (macOS), process.memoryUsage().rss, sampled, under
 * its own method name. Null when neither answers, so the receipt records no memory instead of 0 bytes.
 */
export function rssSource(readStatus = () => readFileSync('/proc/self/status', 'utf-8'), rssBytes = () => process.memoryUsage().rss): RssSource | null {
  const field = (key: string) => {
    const m = readStatus().match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    if (!m) throw new Error(`/proc/self/status has no ${key}`);
    return Number(m[1]);
  };
  const orNull = (read: () => number) => () => { try { return read(); } catch { return null; } };
  try {
    field('VmRSS');
    field('VmHWM');
    return { method: `VmHWM and VmRSS of the benchmark process from /proc/self/status (includes the WASM heap for PGLite and the addon for Rust). ${RSS_SPAN}`, rssKb: orNull(() => field('VmRSS')), hwmKb: orNull(() => field('VmHWM')) };
  } catch { /* no usable /proc: try the runtime's own reading */ }
  try {
    if (!(rssBytes() > 0)) return null;
    return { method: `process.memoryUsage().rss of the benchmark process, sampled every 100 ms, because /proc/self/status with VmRSS and VmHWM is not available on ${process.platform}. There is no kernel high-water mark, so a peak between samples is missed and the numbers are not comparable with VmHWM. ${RSS_SPAN}`, rssKb: orNull(() => Math.round(rssBytes() / 1024)), hwmKb: () => null };
  } catch { return null; }
}

/** Engine-attributable bytes from KiB readings, null when memory was not measurable. */
const engineKbToBytes = (kb: number | null, baselineKb: number | null) => (kb === null || baselineKb === null ? null : Math.max(0, kb - baselineKb) * 1024);

function cgroupWorkingSetBytes(dir?: string): number | null {
  if (!dir) return null;
  try {
    const cur = Number(readFileSync(join(dir, 'memory.current'), 'utf-8'));
    const inactive = Number(readFileSync(join(dir, 'memory.stat'), 'utf-8').match(/^inactive_file (\d+)/m)?.[1] ?? 0);
    return Number.isFinite(cur - inactive) ? cur - inactive : null;
  } catch { return null; }
}

/** Peak RSS of the run in KiB: null unless a reading taken after the baseline answered, so a baseline alone never reads as a peak. */
export function clientPeakKb(laterKb: Array<number | null>, baselineKb: number | null): number | null {
  const later = laterKb.filter((kb): kb is number => kb !== null);
  return later.length ? Math.max(...later, baselineKb ?? 0) : null;
}

export class MemSampler {
  peakServerWs: number | null = null;
  peakRssKb: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private cgroupDir?: string, private rss: RssSource | null = null) {}
  start() {
    const tick = () => {
      const kb = this.rss?.rssKb() ?? null;
      if (kb !== null) this.peakRssKb = Math.max(this.peakRssKb ?? kb, kb);
      const ws = cgroupWorkingSetBytes(this.cgroupDir);
      if (ws !== null) this.peakServerWs = Math.max(this.peakServerWs ?? ws, ws);
    };
    tick();
    this.timer = setInterval(tick, 100);
  }
  stop() { if (this.timer) clearInterval(this.timer); }
}

async function timeOp<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, performance.now() - t0];
}

interface GbrainCode {
  importFromContent: (engine: BrainEngine, slug: string, content: string, opts?: Record<string, unknown>) => Promise<{ embedding_deferred?: boolean }>;
  hybridSearch: (engine: BrainEngine, query: string, opts?: Record<string, unknown>) => Promise<SearchResult[]>;
}

let gbrainCode: GbrainCode | null = null;

/**
 * Load gbrain's import and search code from the build under test, and install the seeded embedder at gbrain's
 * embed-transport seam. The gateway is configured with gbrain's default embedding model and width, a placeholder key
 * and no base URL; children run with no real keys, so a broken seam fails instead of reaching a provider.
 */
async function loadGbrainCode(gut: GbrainUnderTest): Promise<GbrainCode> {
  if (gbrainCode) return gbrainCode;
  const gateway = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; __setEmbedTransportForTests: (fn: unknown) => void }>(gut, 'src/core/ai/gateway.ts');
  gateway.configureGateway({ embedding_model: EMBED_MODEL_PIN, embedding_dimensions: EMBED_DIMS, env: { VOYAGE_API_KEY: 'engine-bench-hash-embed-no-provider-call' } });
  gateway.__setEmbedTransportForTests(async (p: { values: string[] }) => ({ embeddings: p.values.map((v) => Array.from(hashEmbed(v))), values: p.values, warnings: [], usage: { tokens: 0 } }));
  const imp = await importGbrain<Pick<GbrainCode, 'importFromContent'>>(gut, 'src/core/import-file.ts');
  const hyb = await importGbrain<Pick<GbrainCode, 'hybridSearch'>>(gut, 'src/core/search/hybrid.ts');
  gbrainCode = { importFromContent: imp.importFromContent, hybridSearch: hyb.hybridSearch };
  return gbrainCode;
}

async function openArm(gut: GbrainUnderTest, rt: ArmRuntime): Promise<BrainEngine> {
  const { engine } = await openEvalEngine({ gut, kind: rt.kind, databasePath: rt.databasePath, databaseUrl: rt.databaseUrl, poolMax: rt.kind === 'postgres' ? POSTGRES_POOL_MAX : undefined });
  return engine;
}

/** One page written the way gbrain writes it: importFromContent (chunk, embed, seal). Throws if the vectors were deferred. */
async function writePage(code: GbrainCode, engine: BrainEngine, slug: string, markdown: string): Promise<void> {
  const res = await code.importFromContent(engine, slug, markdown, {});
  if (res?.embedding_deferred) throw new Error(`embedding deferred for ${slug}: the seeded embedder did not run`);
}

type Ops = Record<PairedOp, (e: BrainEngine, i: number) => Promise<unknown>>;

/**
 * The timed operations for one dataset. `writeSlug(i)` names the page a put writes, so both engines of a pair write
 * the same new pages; those pages are deleted after the phase (untimed).
 */
function makeOps(code: GbrainCode, ds: Dataset, seed: number, total: number, writeSlug: (i: number) => string): Ops {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const pageSlugs = Array.from({ length: total }, () => pick(ds.pages).slug);
  const linked = Array.from({ length: total }, () => pick(ds.linkedSlugs));
  const walks = Array.from({ length: total }, () => pick(ds.walkSlugs));
  const writes = Array.from({ length: total }, () => pick(ds.pages));
  const P = (i: number) => ds.probes[i % ds.probes.length];
  const V = new Map<string, Float32Array>();
  const vec = (t: string) => { let v = V.get(t); if (!v) { v = hashEmbed(t); V.set(t, v); } return v; };
  const kw = (e: BrainEngine, t: string, o: Record<string, unknown> = {}) => e.searchKeyword(t, { limit: 20, ...o } as never);
  const vs = (e: BrainEngine, t: string, o: Record<string, unknown> = {}) => e.searchVector(vec(t), { limit: 20, ...o } as never);
  return {
    get_page: (e, i) => e.getPage(pageSlugs[i % total]),
    put_page: (e, i) => { const p = writes[i % total]; return writePage(code, e, writeSlug(i), pageMarkdown({ ...p, slug: writeSlug(i), title: `${p.title} (write ${i})` })); },
    search_keyword: (e, i) => kw(e, P(i)),
    search_vector: (e, i) => vs(e, P(i)),
    search_hybrid: (e, i) => code.hybridSearch(e, P(i), { limit: 20, expansion: false }),
    search_keyword_filtered: (e, i) => kw(e, P(i), { type: 'person' }),
    search_vector_filtered: (e, i) => vs(e, P(i), { type: 'person' }),
    graph_walk_d1: (e, i) => e.traverseGraph(walks[i % total], 1),
    graph_walk_d2: (e, i) => e.traverseGraph(walks[i % total], 2),
    graph_walk_d3: (e, i) => e.traverseGraph(walks[i % total], 3),
    get_backlinks: (e, i) => e.getBacklinks(linked[i % total]),
    get_timeline: (e, i) => e.getTimeline(pageSlugs[i % total]),
    list_pages: (e) => e.listPages({ limit: 50 }),
  };
}

async function deletePages(engine: BrainEngine, slugs: string[]): Promise<void> {
  for (const s of slugs) await engine.deletePage(s).catch(() => {});
}

/**
 * Operations an engine refuses with gbrain's typed engine_capability_missing error (the Rust engine refuses each
 * operation it does not implement yet). Each read operation is tried once; a refused operation is reported as missing
 * and never timed. Any other error is a real failure and propagates.
 */
async function missingOps(ops: Ops, engines: BrainEngine[], names: readonly PairedOp[]): Promise<Record<string, string>> {
  const missing: Record<string, string> = {};
  for (const op of names) {
    if (op === 'put_page') continue;
    for (const e of engines) {
      try { await ops[op](e, 0); } catch (err) {
        if (!isCapabilityMissing(err)) throw err;
        missing[op] = (err as Error).message.slice(0, 300);
      }
    }
  }
  return missing;
}

const availableMix = (missing: Record<string, string>) => READ_MIX.filter((op) => !missing[op]);

// ─── Child: one engine ──────────────────────────────────────────────

interface ChildOpts { scale: number; seed: number; iters: number; coreIters: number; warmup: number; coldReps: number; tpReps: number; tpSeconds: number }
interface ChildInput { armId: EvalEngineKind; runtime: ArmRuntime; gbrain: { root: string; version: string }; opts: ChildOpts }
type Rankings = { keyword: string[][]; vector: string[][]; hybrid: string[][] };

const asGut = (g: { root: string; version: string }): GbrainUnderTest => ({ root: g.root, version: g.version, overlay: null });

async function pinSearch(engine: BrainEngine): Promise<void> {
  for (const [k, v] of Object.entries(PINNED_SEARCH_CONFIG)) await engine.setConfig(k, v);
}

async function runArmChild(input: ChildInput) {
  const { runtime, opts } = input;
  const gut = asGut(input.gbrain);
  const code = await loadGbrainCode(gut);
  const ds = buildDataset(opts.scale, opts.seed, DATA_DIR, await loadQualityQueries());
  log(`[${input.armId}] dataset ${JSON.stringify(ds.counts)} fingerprint ${ds.fingerprint.slice(0, 12)}`);
  const result: Record<string, any> = { dataset: ds.counts, dataset_fingerprint: ds.fingerprint };
  const rss = rssSource();
  const mem = new MemSampler(runtime.cgroupDir, rss);
  const baselineRssKb = rss?.rssKb() ?? null;
  const t0open = performance.now();
  const engine = await openArm(gut, runtime);
  result.open_and_init_schema_ms = performance.now() - t0open;
  await pinSearch(engine);
  mem.start();

  log(`[${input.armId}] importing ${ds.pages.length} pages`);
  const putMs: number[] = [];
  const cpu0 = process.cpuUsage();
  const tImport = performance.now();
  for (let i = 0; i < ds.pages.length; i++) {
    const p = ds.pages[i];
    if (i === 0) {
      try { await writePage(code, engine, p.slug, pageMarkdown(p)); } catch (err) {
        if (!isCapabilityMissing(err)) throw err;
        await engine.disconnect().catch(() => {});
        return { unavailable: { stage: 'import', reason: (err as Error).message.slice(0, 300) } };
      }
      await engine.deletePage(p.slug);
    }
    const [, ms] = await timeOp(() => writePage(code, engine, p.slug, pageMarkdown(p)));
    putMs.push(ms);
    if ((i + 1) % 5000 === 0) {
      const last = putMs.slice(-5000);
      log(`[${input.armId}] imported ${i + 1} in ${((performance.now() - tImport) / 1000).toFixed(0)}s; last 5000 at ${(5000 / (last.reduce((a, b) => a + b, 0) / 1000)).toFixed(1)} pages/s, p50 ${summarize(last).p50_ms.toFixed(1)} ms`);
    }
  }
  const pagesSec = (performance.now() - tImport) / 1000;
  const tLinks = performance.now();
  let linkRows = 0;
  for (let i = 0; i < ds.links.length; i += 500) linkRows += await engine.addLinksBatch(ds.links.slice(i, i + 500) as never);
  const linksSec = (performance.now() - tLinks) / 1000;
  const tTl = performance.now();
  let tlRows = 0;
  for (let i = 0; i < ds.timeline.length; i += 500) tlRows += await engine.addTimelineEntriesBatch(ds.timeline.slice(i, i + 500).map((t) => ({ ...t, source: 'engine-bench' })) as never);
  const tlSec = (performance.now() - tTl) / 1000;
  let analyzeSec: number | null = null;
  if (supportsRawSql(input.armId)) {
    const tAn = performance.now();
    await engine.executeRaw('ANALYZE');
    analyzeSec = (performance.now() - tAn) / 1000;
  }
  const totalSec = pagesSec + linksSec + tlSec + (analyzeSec ?? 0);
  const importCpu = process.cpuUsage(cpu0);
  result.import = {
    pages: ds.pages.length,
    pages_per_sec: ds.pages.length / pagesSec,
    page_import_seconds: pagesSec,
    links: { rows_requested: ds.links.length, rows_written: linkRows, seconds: linksSec },
    timeline_entries: { rows_requested: ds.timeline.length, rows_written: tlRows, seconds: tlSec },
    analyze_seconds: analyzeSec,
    analyze_note: supportsRawSql(input.armId) ? 'ANALYZE after import, counted in total_seconds, so the planner has statistics as a maintained brain would' : 'no ANALYZE: the engine has no SQL planner',
    total_seconds: totalSec,
    corpus_pages_per_sec: ds.pages.length / totalSec,
    client_cpu_seconds: (importCpu.user + importCpu.system) / 1e6,
    put_page_during_import: summarize(putMs),
  };

  log(`[${input.armId}] rankings and steady-state reads`);
  const rankMissing: Record<string, string> = {};
  const ranked = async (mode: keyof Rankings, fn: () => Promise<SearchResult[]>): Promise<string[]> => {
    if (rankMissing[mode]) return [];
    try { return toSlugs(await fn()); } catch (err) {
      if (!isCapabilityMissing(err)) throw err;
      rankMissing[mode] = (err as Error).message.slice(0, 300);
      return [];
    }
  };
  const rank = async (texts: string[]): Promise<Rankings> => {
    const out: Rankings = { keyword: [], vector: [], hybrid: [] };
    for (const t of texts) {
      out.keyword.push(await ranked('keyword', () => engine.searchKeyword(t, { limit: 30 } as never)));
      out.vector.push(await ranked('vector', () => engine.searchVector(hashEmbed(t), { limit: 30 } as never)));
      out.hybrid.push(await ranked('hybrid', () => code.hybridSearch(engine, t, { limit: 30, expansion: false })));
    }
    return out;
  };
  const qRank = await rank(ds.qualityQueries.map((q) => q.text));
  const pRank = await rank(ds.probes.slice(0, 200));
  const qual: Record<string, unknown> = {};
  const avg = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);
  for (const mode of ['keyword', 'vector', 'hybrid'] as const) {
    const lists = qRank[mode];
    qual[mode] = {
      recall_at_5: avg(ds.qualityQueries.map((q, i) => recallAtK(lists[i], q.relevant, 5))),
      ndcg_at_10: avg(ds.qualityQueries.map((q, i) => ndcgAtK(lists[i], q.relevant, 10))),
      n_queries: ds.qualityQueries.length,
      empty_result_rate: lists.filter((l) => l.length === 0).length / Math.max(1, lists.length),
    };
  }
  result.quality_control = { note: 'hash embeddings: an engine-to-engine control, not a retrieval-quality claim', ...qual };
  result.rankings = { quality: qRank, probes: pRank, quality_ids: ds.qualityQueries.map((q) => q.id) };
  result.rankings_missing = rankMissing;

  const ops = makeOps(code, ds, opts.seed ^ 0x5eed, 2000, () => { throw new Error('no writes in the steady-state window'); });
  const mix = availableMix(await missingOps(ops, [engine], [...new Set(READ_MIX)]));
  result.steady_read_mix = mix;
  for (let i = 0; i < 2000 && mix.length; i++) await ops[mix[i % mix.length]](engine, i);
  const steadyRssKb = rss?.rssKb() ?? null;
  mem.stop();
  const stats = await engine.getStats() as unknown as Record<string, unknown>;
  result.stats = { page_count: stats.page_count, chunk_count: stats.chunk_count, embedded_count: stats.embedded_count };
  await engine.disconnect();
  const peakRssKb = clientPeakKb([mem.peakRssKb, steadyRssKb, rss?.hwmKb() ?? null], baselineRssKb);
  const server = runtime.kind === 'postgres' ? mem.peakServerWs : null;
  const bytes = (kb: number | null) => (kb === null ? null : kb * 1024);
  result.memory = {
    client_peak_rss_bytes: bytes(peakRssKb),
    client_steady_rss_bytes: bytes(steadyRssKb),
    client_baseline_rss_bytes: bytes(baselineRssKb),
    client_engine_peak_rss_bytes: engineKbToBytes(peakRssKb, baselineRssKb),
    client_engine_steady_rss_bytes: engineKbToBytes(steadyRssKb, baselineRssKb),
    method: rss?.method ?? `not measurable on ${process.platform}: neither /proc/self/status nor process.memoryUsage() answered`,
    server_peak_working_set_bytes: server,
    server_method: runtime.kind !== 'postgres' ? 'no server process'
      : server !== null ? 'container cgroup memory.current minus inactive_file (the docker stats definition), sampled every 100 ms'
        : runtime.cgroupDir ? 'not measurable: every read of the container cgroup memory files failed'
          : runtime.containerId ? 'not measurable: the container cgroup memory files are not readable on this host'
            : 'not measured for an external server',
  };
  return result;
}

async function runColdStartChild(input: ChildInput) {
  const gut = asGut(input.gbrain);
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const engine = await openArm(gut, input.runtime);
  const tOpen = performance.now();
  const page = await engine.listPages({ limit: 1 });
  const res = await engine.searchKeyword('founder', { limit: 5 } as never);
  const t1 = performance.now();
  await engine.disconnect();
  const c = process.cpuUsage(cpu0);
  return { open_ms: tOpen - t0, first_answer_ms: t1 - tOpen, total_ms: t1 - t0, first_rows: page.length + res.length, client_cpu_ms: (c.user + c.system) / 1000 };
}

// ─── Child: a pair of engines ───────────────────────────────────────

interface PairedInput { tag: string; ref: { armId: EvalEngineKind; runtime: ArmRuntime }; other: { armId: EvalEngineKind; runtime: ArmRuntime }; gbrain: { root: string; version: string }; opts: ChildOpts }
export interface PairedRow { q: number; ref_ms: number; other_ms: number; other_first: boolean }
export interface ThroughputRow { clients: number; rep: number; kind: 'read' | 'write'; ref_ops_per_sec: number; other_ops_per_sec: number; other_first: boolean }

async function throughputWindow(clients: number, seconds: number, op: (w: number, k: number) => Promise<unknown>): Promise<number> {
  let ops = 0;
  const t0 = performance.now();
  const deadline = t0 + seconds * 1000;
  await Promise.all(Array.from({ length: clients }, async (_, w) => {
    for (let k = 0; performance.now() < deadline; k++) { await op(w, k); ops++; }
  }));
  return ops / ((performance.now() - t0) / 1000);
}

/**
 * Latency: each query runs on both engines back to back in a seeded random order, so machine drift lands on both
 * alike. Throughput: for each client count and repetition, a read window and a write window run on each engine in a
 * seeded random order; pages written in a window are deleted afterwards (untimed) so both stores stay the same size.
 */
async function runPairedChild(input: PairedInput) {
  const { opts } = input;
  const gut = asGut(input.gbrain);
  const code = await loadGbrainCode(gut);
  const ds = buildDataset(opts.scale, opts.seed, DATA_DIR, await loadQualityQueries());
  const ref = await openArm(gut, input.ref.runtime);
  const other = await openArm(gut, input.other.runtime);
  await pinSearch(ref);
  await pinSearch(other);
  const r = rng(opts.seed ^ 0xa11ce);
  const total = opts.warmup + Math.max(opts.iters, opts.coreIters);
  const putSlug = (i: number) => `bench/put-${input.tag}-${String(i).padStart(6, '0')}`;
  const ops = makeOps(code, ds, opts.seed ^ 0xa11ce, total, putSlug);
  const missing = await missingOps(ops, [ref, other], PAIRED_OPS);
  const mix = availableMix(missing);

  const latency: Record<string, PairedRow[]> = {};
  for (const op of PAIRED_OPS) {
    if (missing[op]) { log(`[paired ${input.tag}] ${op} missing: ${missing[op]}`); continue; }
    const fn = ops[op];
    if (op === 'put_page') {
      try { await fn(other, total + 1); await fn(ref, total + 1); } catch (err) {
        if (!isCapabilityMissing(err)) throw err;
        missing[op] = (err as Error).message.slice(0, 300);
        continue;
      }
      await deletePages(ref, [putSlug(total + 1)]);
      await deletePages(other, [putSlug(total + 1)]);
    }
    const n = CORE_OPS.includes(op) ? opts.coreIters : opts.iters;
    for (let i = 0; i < opts.warmup; i++) { await fn(ref, i); await fn(other, i); }
    const rows: PairedRow[] = [];
    for (let i = 0; i < n; i++) {
      const qi = opts.warmup + i;
      const otherFirst = r() < 0.5;
      let refMs = 0, otherMs = 0;
      if (otherFirst) { [, otherMs] = await timeOp(() => fn(other, qi)); [, refMs] = await timeOp(() => fn(ref, qi)); }
      else { [, refMs] = await timeOp(() => fn(ref, qi)); [, otherMs] = await timeOp(() => fn(other, qi)); }
      rows.push({ q: i, ref_ms: refMs, other_ms: otherMs, other_first: otherFirst });
    }
    latency[op] = rows;
    if (op === 'put_page') {
      const slugs = Array.from({ length: total }, (_, i) => putSlug(i));
      await deletePages(ref, slugs);
      await deletePages(other, slugs);
    }
    log(`[paired ${input.tag}] ${op.padEnd(24)} median ${input.ref.armId} ${median(rows.map((x) => x.ref_ms)).toFixed(2)} ms, ${input.other.armId} ${median(rows.map((x) => x.other_ms)).toFixed(2)} ms (n=${rows.length})`);
  }

  const throughput: ThroughputRow[] = [];
  for (const clients of THROUGHPUT_CLIENTS) {
    for (let rep = 0; rep < opts.tpReps; rep++) {
      for (const kind of ['read', 'write'] as const) {
        if ((kind === 'read' && !mix.length) || (kind === 'write' && missing.put_page)) continue;
        const written = new Map<BrainEngine, string[]>([[ref, []], [other, []]]);
        const opFor = (e: BrainEngine) => kind === 'read'
          ? (w: number, k: number) => ops[mix[(k + w) % mix.length]](e, w * 100_003 + k)
          : (w: number, k: number) => {
            const slug = `bench/tp-${input.tag}-${clients}-${rep}-${w}-${k}`;
            written.get(e)!.push(slug);
            const p = ds.pages[(w * 7919 + k) % ds.pages.length];
            return writePage(code, e, slug, pageMarkdown({ ...p, slug, title: `${p.title} (tp ${clients}/${rep}/${w}/${k})` }));
          };
        const otherFirst = r() < 0.5;
        let refRate = 0, otherRate = 0;
        if (otherFirst) { otherRate = await throughputWindow(clients, opts.tpSeconds, opFor(other)); refRate = await throughputWindow(clients, opts.tpSeconds, opFor(ref)); }
        else { refRate = await throughputWindow(clients, opts.tpSeconds, opFor(ref)); otherRate = await throughputWindow(clients, opts.tpSeconds, opFor(other)); }
        if (kind === 'write') {
          await deletePages(ref, written.get(ref)!);
          await deletePages(other, written.get(other)!);
        }
        throughput.push({ clients, rep, kind, ref_ops_per_sec: refRate, other_ops_per_sec: otherRate, other_first: otherFirst });
      }
    }
    const sel = throughput.filter((t) => t.clients === clients);
    log(`[paired ${input.tag}] ${clients} clients: read ${median(sel.filter((t) => t.kind === 'read').map((t) => t.ref_ops_per_sec)).toFixed(0)} vs ${median(sel.filter((t) => t.kind === 'read').map((t) => t.other_ops_per_sec)).toFixed(0)} ops/s; write ${median(sel.filter((t) => t.kind === 'write').map((t) => t.ref_ops_per_sec)).toFixed(0)} vs ${median(sel.filter((t) => t.kind === 'write').map((t) => t.other_ops_per_sec)).toFixed(0)} pages/s`);
  }
  await other.disconnect();
  await ref.disconnect();
  return { latency, throughput, missing, read_mix: mix };
}

// ─── Paired analysis ────────────────────────────────────────────────

type CI = [number, number] | null;
export interface Ratio { ratio: number; ci95: CI }

export interface LatencyPairSummary {
  n: number;
  ref: LatencyStats;
  other: LatencyStats;
  /** exp(mean of per-query ln(other/ref)): "other takes this many times as long", per query. */
  geo_mean_ratio: Ratio;
  /** other p50 over ref p50, with a paired bootstrap interval over queries. */
  p50_ratio: Ratio;
  /** other p99 over ref p99, with a paired bootstrap interval over queries. */
  p99_ratio: Ratio;
  diff_ms: { delta: number; ci95: CI };
  by_order: { ref_first: { n: number; mean_diff_ms: number | null }; other_first: { n: number; mean_diff_ms: number | null } };
}

const meanOf = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);

/** Ratio of the q-th percentiles (other over ref) with a paired percentile bootstrap that resamples queries. */
export function quantileRatio(rows: PairedRow[], q: number, seed: number, draws: number): Ratio {
  const pct = (xs: number[]) => percentile([...xs].sort((a, b) => a - b), q);
  const point = pct(rows.map((x) => x.other_ms)) / Math.max(pct(rows.map((x) => x.ref_ms)), 1e-9);
  if (rows.length < 2) return { ratio: point, ci95: null };
  const rand = seededRandom(seed);
  const n = rows.length;
  const a = new Float64Array(n), b = new Float64Array(n);
  const ratios: number[] = [];
  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < n; i++) { const j = Math.floor(rand() * n); a[i] = rows[j].ref_ms; b[i] = rows[j].other_ms; }
    a.sort(); b.sort();
    const k = Math.min(n - 1, Math.max(0, Math.ceil((q / 100) * n) - 1));
    ratios.push(b[k] / Math.max(a[k], 1e-9));
  }
  ratios.sort((x, y) => x - y);
  return { ratio: point, ci95: [percentile(ratios, 2.5), percentile(ratios, 97.5)] };
}

export function analyzeLatency(rows: PairedRow[], seed: number, m: Margins): LatencyPairSummary {
  const cluster = (q: number) => String(q).padStart(7, '0');
  const ms: PairedItem[] = rows.map((x) => ({ id: String(x.q), cluster: cluster(x.q), a: x.ref_ms, b: x.other_ms }));
  const logs: PairedItem[] = rows.map((x) => ({ id: String(x.q), cluster: cluster(x.q), a: Math.log(Math.max(x.ref_ms, 1e-6)), b: Math.log(Math.max(x.other_ms, 1e-6)) }));
  const d = clusteredPairedDelta(ms, { seed, draws: m.bootstrap_draws });
  const l = clusteredPairedDelta(logs, { seed, draws: m.bootstrap_draws });
  const byOrder = (first: boolean) => {
    const sel = rows.filter((x) => x.other_first === first);
    return { n: sel.length, mean_diff_ms: sel.length ? meanOf(sel.map((x) => x.other_ms - x.ref_ms)) : null };
  };
  return {
    n: rows.length,
    ref: summarize(rows.map((x) => x.ref_ms)),
    other: summarize(rows.map((x) => x.other_ms)),
    geo_mean_ratio: { ratio: Math.exp(l.delta), ci95: l.ci95 ? [Math.exp(l.ci95[0]), Math.exp(l.ci95[1])] : null },
    p50_ratio: quantileRatio(rows, 50, seed, m.quantile_draws),
    p99_ratio: quantileRatio(rows, 99, seed, m.quantile_draws),
    diff_ms: { delta: d.delta, ci95: d.ci95 },
    by_order: { ref_first: byOrder(false), other_first: byOrder(true) },
  };
}

export interface ThroughputSummary { clients: number; kind: 'read' | 'write'; reps: number; ref_median_ops_per_sec: number; other_median_ops_per_sec: number; ratio: Ratio }

/** Geometric-mean throughput ratio (other over ref) across repetitions, each repetition its own cluster. */
export function analyzeThroughput(rows: ThroughputRow[], clients: number, kind: 'read' | 'write', seed: number, m: Margins): ThroughputSummary {
  const sel = rows.filter((x) => x.clients === clients && x.kind === kind);
  const items: PairedItem[] = sel.map((x) => ({ id: String(x.rep), cluster: String(x.rep).padStart(4, '0'), a: Math.log(Math.max(x.ref_ops_per_sec, 1e-9)), b: Math.log(Math.max(x.other_ops_per_sec, 1e-9)) }));
  const d = items.length ? clusteredPairedDelta(items, { seed, draws: m.bootstrap_draws }) : null;
  return {
    clients, kind, reps: sel.length,
    ref_median_ops_per_sec: median(sel.map((x) => x.ref_ops_per_sec)),
    other_median_ops_per_sec: median(sel.map((x) => x.other_ops_per_sec)),
    ratio: d ? { ratio: Math.exp(d.delta), ci95: d.ci95 ? [Math.exp(d.ci95[0]), Math.exp(d.ci95[1])] : null } : { ratio: NaN, ci95: null },
  };
}

/** Ratio of medians (other over ref) of two independent samples, with an unpaired percentile bootstrap. */
export function medianRatio(ref: number[], other: number[], seed: number, draws: number): Ratio {
  const point = median(other) / Math.max(median(ref), 1e-9);
  if (ref.length < 2 || other.length < 2) return { ratio: point, ci95: null };
  const rand = seededRandom(seed);
  const res = (xs: number[]) => median(Array.from({ length: xs.length }, () => xs[Math.floor(rand() * xs.length)]));
  const ratios = Array.from({ length: draws }, () => res(other) / Math.max(res(ref), 1e-9)).sort((a, b) => a - b);
  return { ratio: point, ci95: [percentile(ratios, 2.5), percentile(ratios, 97.5)] };
}

// ─── Decision rule (speed) ──────────────────────────────────────────

/** `missing`: the engine refuses the operation (engine_capability_missing), so it cannot be timed. */
export type MetricStatus = 'pass' | 'fail' | 'inconclusive' | 'missing';
export interface MetricVerdict { metric: string; against: EvalEngineKind; direction: 'lower_is_better' | 'higher_is_better'; ratio: number; ci95: CI; margin: number; status: MetricStatus; core: boolean }

/** Lower-is-better ratios (latency, cold start, RSS) pass when the interval's upper bound is within the margin. */
export function lowerIsBetter(metric: string, against: EvalEngineKind, r: Ratio, margin: number, core: boolean): MetricVerdict {
  const hi = r.ci95 ? r.ci95[1] : r.ratio;
  const lo = r.ci95 ? r.ci95[0] : r.ratio;
  const status: MetricStatus = hi <= margin ? 'pass' : lo > margin ? 'fail' : 'inconclusive';
  return { metric, against, direction: 'lower_is_better', ratio: r.ratio, ci95: r.ci95, margin, status, core };
}

/** Higher-is-better ratios (throughput, import) pass when the interval's lower bound is at least the margin. */
export function higherIsBetter(metric: string, against: EvalEngineKind, r: Ratio, margin: number, core: boolean): MetricVerdict {
  const hi = r.ci95 ? r.ci95[1] : r.ratio;
  const lo = r.ci95 ? r.ci95[0] : r.ratio;
  const status: MetricStatus = lo >= margin ? 'pass' : hi < margin ? 'fail' : 'inconclusive';
  return { metric, against, direction: 'higher_is_better', ratio: r.ratio, ci95: r.ci95, margin, status, core };
}

/** A metric the engine cannot be measured on because it refuses the operation: a blocker for a core operation, a named exception otherwise. */
export function missingMetric(metric: string, against: EvalEngineKind, direction: MetricVerdict['direction'], core: boolean): MetricVerdict {
  return { metric, against, direction, ratio: NaN, ci95: null, margin: NaN, status: 'missing', core };
}

export type SpeedVerdict = 'no_slower' | 'no_slower_with_exceptions' | 'not_shown' | 'slower';

/**
 * The engine-bench speed rule for one scale, applied mechanically to Rust's metrics against both TypeScript engines:
 * - no_slower: every metric passes.
 * - no_slower_with_exceptions: every core-operation metric passes, and each other metric that does not pass is within
 *   the exception ratio on its point estimate; each is listed by name.
 * - not_shown: no metric fails outright beyond those limits, but a core-operation metric is inconclusive.
 * - slower: a core-operation metric fails, or a non-core metric is outside the exception ratio.
 */
export function speedVerdict(metrics: MetricVerdict[], m: Margins): { verdict: SpeedVerdict; exceptions: MetricVerdict[]; blockers: MetricVerdict[]; unresolved: MetricVerdict[] } {
  const notPass = metrics.filter((x) => x.status !== 'pass');
  const beyond = (x: MetricVerdict) => (x.direction === 'lower_is_better' ? x.ratio > m.exception_ratio : x.ratio < 1 / m.exception_ratio);
  const blockers = notPass.filter((x) => (x.core && (x.status === 'fail' || x.status === 'missing')) || (!x.core && x.status !== 'missing' && beyond(x)));
  const unresolved = notPass.filter((x) => x.core && x.status === 'inconclusive');
  const exceptions = notPass.filter((x) => !x.core && (x.status === 'missing' || !beyond(x)));
  if (blockers.length) return { verdict: 'slower', exceptions, blockers, unresolved };
  if (unresolved.length) return { verdict: 'not_shown', exceptions, blockers, unresolved };
  if (exceptions.length) return { verdict: 'no_slower_with_exceptions', exceptions, blockers, unresolved };
  return { verdict: 'no_slower', exceptions, blockers, unresolved };
}

/** Margins from the preregistration's fenced `json engine-bench-margins` block, so a counted run never takes them from a flag. */
export function marginsFromPrereg(text: string): Margins {
  const m = text.match(/```json engine-bench-margins\n([\s\S]*?)\n```/);
  if (!m) throw new Error('the preregistration has no ```json engine-bench-margins block');
  const parsed = JSON.parse(m[1]) as Partial<Margins>;
  const out = { ...DEFAULT_MARGINS } as Margins;
  for (const k of Object.keys(DEFAULT_MARGINS) as Array<keyof Margins>) {
    if (typeof parsed[k] !== 'number' || !Number.isFinite(parsed[k])) throw new Error(`engine-bench-margins is missing a number for ${k}`);
    out[k] = parsed[k] as number;
  }
  return out;
}

// ─── Orchestrator ───────────────────────────────────────────────────

export interface Options {
  scale: number; seed: number; iters: number; coreIters: number; warmup: number; coldReps: number; tpReps: number; tpSeconds: number;
  dev: boolean; prereg?: string; outDir?: string; engines: EvalEngineKind[]; postgresUrl?: string; pgImage: string; keepWork: boolean;
}

export function parseArgs(argv: string[]): Options {
  const get = (f: string) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
  const o: Options = {
    scale: Number(get('--scale') ?? 10000),
    seed: Number(get('--seed') ?? 1337),
    iters: Number(get('--iters') ?? 2000),
    warmup: Number(get('--warmup') ?? 100),
    coreIters: Number(get('--core-iters') ?? 10000),
    coldReps: Number(get('--cold-reps') ?? 11),
    tpReps: Number(get('--tp-reps') ?? 10),
    tpSeconds: Number(get('--tp-seconds') ?? 5),
    dev: argv.includes('--dev'),
    prereg: get('--prereg'),
    outDir: get('--out') ? resolve(get('--out')!) : undefined,
    engines: (get('--engines') ?? 'pglite,postgres,rust').split(',').map((s) => s.trim()).filter(Boolean) as EvalEngineKind[],
    postgresUrl: get('--postgres-url'),
    pgImage: get('--pg-image') ?? DEFAULT_PG_IMAGE,
    keepWork: argv.includes('--keep-work'),
  };
  if (!Number.isFinite(o.scale) || o.scale < 10) throw new Error('--scale must be a number >= 10');
  for (const e of o.engines) if (!ENGINES[e]) throw new Error(`Unknown engine "${e}". Available: ${Object.keys(ENGINES).join(', ')}`);
  if (!o.dev && !o.prereg) throw new Error('A counted run needs --prereg <committed preregistration>; pass --dev for an uncounted run.');
  return o;
}

function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), NO_COLOR: '1' };
  if (process.env.GBRAIN_RUST_ENGINE_ADDON) env.GBRAIN_RUST_ENGINE_ADDON = process.env.GBRAIN_RUST_ENGINE_ADDON;
  return env;
}

function runChild(kind: 'arm' | 'coldstart' | 'paired', input: ChildInput | PairedInput, workDir: string, tag: string): Promise<any> {
  const inFile = join(workDir, `${tag}.in.json`);
  const outFile = join(workDir, `${tag}.out.json`);
  writeFileSync(inFile, JSON.stringify(input));
  const home = join(workDir, 'home');
  mkdirSync(home, { recursive: true });
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [import.meta.path, '--child', kind, '--in', inFile, '--out', outFile], { env: childEnv(home), stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT });
    let buf = '';
    const all: Buffer[] = [];
    p.stdout!.on('data', (d: Buffer) => all.push(d));
    p.stderr!.on('data', (d: Buffer) => {
      all.push(d);
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.startsWith('@@ ')) process.stderr.write(`${l.slice(3)}\n`);
    });
    p.on('exit', (code) => {
      writeFileSync(join(workDir, `${tag}.log`), Buffer.concat(all));
      if (code !== 0) process.stderr.write(Buffer.concat(all).toString().split('\n').slice(-25).join('\n') + '\n');
      if (code === 0 && existsSync(outFile)) res(JSON.parse(readFileSync(outFile, 'utf-8')));
      else rej(new Error(`child ${kind}/${tag} exited with code ${code}`));
    });
  });
}

function machine() {
  const c = cpus();
  return { cpu_model: c[0]?.model ?? 'unknown', logical_cpus: c.length, memory_gb: Math.round((totalmem() / 2 ** 30) * 10) / 10, os: `${platform()} ${release()}`, bun: Bun.version, docker: docker(['--version']).out || 'not installed', load_average_at_launch: loadavg() };
}

export function computeAgreement(a: Rankings, b: Rankings) {
  const out: Record<string, { identical_top10: number; overlap_at_5: number; top1_match: number; n: number }> = {};
  for (const mode of ['keyword', 'vector', 'hybrid'] as const) {
    const n = Math.min(a[mode].length, b[mode].length);
    let same = 0, ov = 0, t1 = 0;
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(a[mode][i]) === JSON.stringify(b[mode][i])) same++;
      ov += overlapAtK(a[mode][i], b[mode][i], 5);
      if ((a[mode][i][0] ?? null) === (b[mode][i][0] ?? null)) t1++;
    }
    out[mode] = { identical_top10: n ? same / n : 0, overlap_at_5: n ? ov / n : 0, top1_match: n ? t1 / n : 0, n };
  }
  return out;
}

/** Engine RSS a user pays for: the client's engine-attributable peak plus, for Postgres, the server's peak working set. Null when either part was not measured. */
export function engineRss(run: Record<string, any>, kind: EvalEngineKind): number | null {
  const client = run.memory.client_engine_peak_rss_bytes;
  if (client == null) return null;
  if (kind !== 'postgres') return client;
  const server = run.memory.server_peak_working_set_bytes;
  return server == null ? null : client + server;
}

export async function orchestrate(opts: Options, argv: string[]) {
  const started = Date.now();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  let attestation: Attestation | null = null;
  let margins: Margins = { ...DEFAULT_MARGINS };
  if (!opts.dev) {
    attestation = attestPreregistration(opts.prereg!, REPO_ROOT);
    margins = marginsFromPrereg(readFileSync(join(REPO_ROOT, opts.prereg!), 'utf-8'));
    const load = loadavg()[0];
    if (load > 2) throw new Error(`load average ${load.toFixed(2)} is above 2 at launch; a counted run needs the machine to itself`);
  }
  if (opts.engines.includes('rust')) {
    const { preflightEvalEngine } = await import('../eval-engine.ts');
    await preflightEvalEngine(gut, 'rust');
  }
  mkdirSync(REPORT_DIR, { recursive: true });
  const workDir = mkdtempSync(join(REPORT_DIR, '.work-'));
  const gbrain = { root: gut.root, version: gut.version };
  const childOpts: ChildOpts = { scale: opts.scale, seed: opts.seed, iters: opts.iters, coreIters: opts.coreIters, warmup: opts.warmup, coldReps: opts.coldReps, tpReps: opts.tpReps, tpSeconds: opts.tpSeconds };
  const arms: Record<string, any> = {};
  const rankings: Record<string, Rankings & { quality_ids: string[] }> = {};
  const handles: Partial<Record<EvalEngineKind, ArmHandle>> = {};
  const pairs: Record<string, any> = {};
  try {
    for (const id of opts.engines) {
      const spec = ENGINES[id];
      log(`\n== ${spec.label} ==`);
      const handle = await spec.prepare({ workDir, opts });
      handles[id] = handle;
      const input: ChildInput = { armId: id, runtime: handle.runtime, gbrain, opts: childOpts };
      const run = await runChild('arm', input, workDir, `${id}-run`);
      if (run.unavailable) {
        log(`[${id}] unavailable at ${run.unavailable.stage}: ${run.unavailable.reason}`);
        arms[id] = { id, label: spec.label, kind: spec.kind, info: handle.info, unavailable: run.unavailable };
        continue;
      }
      rankings[id] = { ...run.rankings.quality, quality_ids: run.rankings.quality_ids, probes: run.rankings.probes } as never;
      const probeRankings = run.rankings.probes as Rankings;
      delete run.rankings;
      const disk = await handle.diskUsage();
      log(`[${id}] cold start x${opts.coldReps}`);
      const reps: any[] = [];
      for (let i = 0; i < opts.coldReps; i++) reps.push(await runChild('coldstart', input, workDir, `${id}-cold-${i}`));
      arms[id] = {
        id, label: spec.label, kind: spec.kind, info: handle.info, run, disk,
        engine_rss_bytes: engineRss(run, id),
        cold_start: { reps, median_total_ms: median(reps.map((x) => x.total_ms)), method: 'each rep: a fresh process opens the existing store (connect and initSchema) and answers listPages and one keyword query. For Postgres the server keeps running, so this is a gbrain process start against a warm server. Module load is excluded; the OS file cache is warm.' },
      };
      (arms[id] as any)._probes = probeRankings;
    }

    const has = (k: EvalEngineKind) => Boolean(arms[k]) && !arms[k].unavailable;
    const plan: Array<[EvalEngineKind, EvalEngineKind]> = [];
    if (has('rust') && has('pglite')) plan.push(['pglite', 'rust']);
    if (has('rust') && has('postgres')) plan.push(['postgres', 'rust']);
    if (has('pglite') && has('postgres')) plan.push(['postgres', 'pglite']);
    for (const [refId, otherId] of plan) {
      const tag = `${otherId}-vs-${refId}`;
      log(`\n== Paired: ${arms[otherId].label} vs ${arms[refId].label} ==`);
      const raw = await runChild('paired', { tag, ref: { armId: refId, runtime: handles[refId]!.runtime }, other: { armId: otherId, runtime: handles[otherId]!.runtime }, gbrain, opts: childOpts }, workDir, `paired-${tag}`);
      const latency: Record<string, LatencyPairSummary> = {};
      for (const op of PAIRED_OPS) if (raw.latency[op]) latency[op] = analyzeLatency(raw.latency[op], opts.seed, margins);
      const throughput: ThroughputSummary[] = [];
      for (const c of THROUGHPUT_CLIENTS) for (const k of ['read', 'write'] as const) if (raw.throughput.some((t: ThroughputRow) => t.clients === c && t.kind === k)) throughput.push(analyzeThroughput(raw.throughput, c, k, opts.seed, margins));
      const cold = medianRatio(arms[refId].cold_start.reps.map((x: any) => x.total_ms), arms[otherId].cold_start.reps.map((x: any) => x.total_ms), opts.seed, margins.bootstrap_draws);
      const importRatio: Ratio = { ratio: arms[otherId].run.import.corpus_pages_per_sec / arms[refId].run.import.corpus_pages_per_sec, ci95: null };
      const rssMeasured = arms[otherId].engine_rss_bytes !== null && arms[refId].engine_rss_bytes !== null;
      const rssRatio: Ratio | null = rssMeasured ? { ratio: arms[otherId].engine_rss_bytes / Math.max(arms[refId].engine_rss_bytes, 1), ci95: null } : null;
      const metrics: MetricVerdict[] = [];
      for (const op of PAIRED_OPS) {
        for (const q of ['p50', 'p99'] as const) {
          metrics.push(latency[op]
            ? lowerIsBetter(`${op} ${q}`, refId, latency[op][`${q}_ratio`], margins.latency_ratio, CORE_OPS.includes(op))
            : missingMetric(`${op} ${q}`, refId, 'lower_is_better', CORE_OPS.includes(op)));
        }
      }
      for (const c of THROUGHPUT_CLIENTS) {
        for (const k of ['read', 'write'] as const) {
          const name = `${k} throughput at ${c} client${c === 1 ? '' : 's'}`;
          const t = throughput.find((x) => x.clients === c && x.kind === k);
          metrics.push(t ? higherIsBetter(name, refId, t.ratio, margins.throughput_ratio, false) : missingMetric(name, refId, 'higher_is_better', false));
        }
      }
      metrics.push(lowerIsBetter('cold start', refId, cold, margins.point_ratio, false));
      metrics.push(higherIsBetter('corpus import', refId, importRatio, margins.throughput_ratio, false));
      metrics.push(rssRatio ? lowerIsBetter('peak RSS', refId, rssRatio, margins.point_ratio, false) : missingMetric('peak RSS', refId, 'lower_is_better', false));
      pairs[tag] = {
        reference: refId, other: otherId,
        direction: 'ratios are other over reference: below 1 means other is faster or smaller for latency, cold start and RSS; above 1 means other is faster for throughput and import',
        missing: raw.missing, read_mix: raw.read_mix,
        latency, throughput, cold_start_ratio: cold, import_ratio: importRatio, rss_ratio: rssRatio, metrics,
        agreement: { quality_queries: computeAgreement(rankings[otherId], rankings[refId]), probes: computeAgreement(arms[otherId]._probes, arms[refId]._probes) },
        rows: raw,
      };
    }
  } finally {
    for (const h of Object.values(handles)) await h!.teardown();
    if (!opts.keepWork) rmSync(workDir, { recursive: true, force: true });
  }
  for (const a of Object.values(arms)) delete (a as any)._probes;

  const rustMetrics = Object.values(pairs).filter((p: any) => p.other === 'rust').flatMap((p: any) => p.metrics as MetricVerdict[]);
  const rustUnavailable = arms.rust?.unavailable;
  const speed = rustUnavailable
    ? { applies: true, verdict: 'slower' as SpeedVerdict, reason: `the Rust engine refused ${rustUnavailable.stage}, so no operation could be measured: ${rustUnavailable.reason}`, exceptions: [], unresolved: [], blockers: [missingMetric('put_page p50', 'pglite', 'lower_is_better', true)] }
    : rustMetrics.length
      ? { applies: true, against: Object.values(pairs).filter((p: any) => p.other === 'rust').map((p: any) => p.reference), ...speedVerdict(rustMetrics, margins) }
      : { applies: false, reason: 'no Rust arm in this run; the speed rule decides only Rust against the TypeScript engines' };

  const out = {
    schema_version: SCHEMA_VERSION,
    benchmark: 'engine-bench',
    stage: 'speed',
    counted: !opts.dev,
    preregistration_attestation: attestation,
    generated_at: new Date().toISOString(),
    run_seconds: (Date.now() - started) / 1000,
    command: recordedCommand(argv),
    options: childOpts,
    gbrain: { product: productIdentityFor(gut), overlay: overlaySummary(gut), version: gut.version, rust_addon: opts.engines.includes('rust') ? rustAddonIdentity(gut) : null },
    evals_commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' }).stdout.trim(),
    machine: machine(),
    embedder: { model: EMBED_MODEL, dims: EMBED_DIMS, installed_as: EMBED_MODEL_PIN, note: 'seeded feature hashing at gbrain embed-transport seam; no provider calls' },
    search_config: PINNED_SEARCH_CONFIG,
    margins,
    core_ops: CORE_OPS,
    speed,
    arms,
    pairs,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = opts.outDir ?? REPORT_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${opts.dev ? 'dev-' : ''}speed-${stamp}-${opts.scale}.json`);
  writeScrubbedJson(file, out);
  log(`\nwrote ${relative(REPO_ROOT, file)} (${out.run_seconds.toFixed(0)}s)`);
  return { file, out };
}

async function main() {
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--child');
  if (ci !== -1) {
    const kind = argv[ci + 1];
    const raw = JSON.parse(readFileSync(argv[argv.indexOf('--in') + 1], 'utf-8'));
    const res = kind === 'arm' ? await runArmChild(raw) : kind === 'coldstart' ? await runColdStartChild(raw) : await runPairedChild(raw);
    writeFileSync(argv[argv.indexOf('--out') + 1], JSON.stringify(res));
    process.exit(0);
  }
  try {
    const { file } = await orchestrate(parseArgs(argv), argv);
    console.log(file);
  } catch (e) {
    if (e instanceof EvalEngineUnavailable) {
      console.error(`engine-bench refused: ${e.reason}: ${e.message}`);
      process.exit(3);
    }
    throw e;
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('engine-bench error:', e);
    process.exit(1);
  });
}
