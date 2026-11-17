/**
 * Engine shootout: the same brain, the same queries, the same vectors, run
 * through each storage engine gbrain can use, so a reader can see which engine
 * is fastest, most accurate, smallest and cheapest to run.
 *
 * Engines in this PR (B1): PGLite (in-process WASM Postgres, on-disk) and
 * Postgres + pgvector (a local `pgvector/pgvector` Docker container).
 * The Rust engine joins later through the same `BrainEngine` interface. See
 * the ENGINES table and `createEngine` hook below; there is deliberately no
 * stub arm, so a Rust number can never appear before a Rust engine exists.
 *
 * No provider calls, no API keys. Embeddings come from `hashEmbed`, a seeded,
 * deterministic feature-hashing embedder defined in this file (the repo has no
 * committed vector fixtures; see the report for what that means for quality).
 *
 * Process layout (so peak memory and cold start are clean per engine):
 *   orchestrator (this file, no flags)
 *     -> per engine, a child process:   --child arm        (import + all single-engine measurements)
 *     -> per engine, cold-start reps:   --child coldstart  (open an existing store, answer one query)
 *     -> per non-reference engine:      --child paired     (both engines open at once; the same query is
 *                                       sent to both back to back in a seeded random order; then blocks of
 *                                       identical operations are timed on both for cost per operation)
 *   Children get a minimal environment (no API keys, a throwaway HOME).
 *
 * Counted and dev runs: with no `--dev` the run is a counted run. It refuses to start unless the
 * preregistration (PREREGISTRATION below) is committed, unchanged and on an origin branch, and
 * writes that attestation into the receipt. `--dev` skips the check, marks the receipt
 * `counted: false` and prefixes the file name with `dev-`.
 *
 * Usage:
 *   bun eval/runner/engine-shootout.ts [--scale 1000] [--engines pglite,postgres]
 *        [--seed 1337] [--iters 300] [--warmup 30] [--cold-reps 3]
 *        [--cost-blocks 20] [--block-size 50] [--out <dir>] [--dev]
 *        [--postgres-url <url>] [--pg-image pgvector/pgvector:pg16] [--keep-work]
 *
 * `--postgres-url` benchmarks an already-running server instead of starting a
 * container (server CPU and memory are then not measurable).
 */

import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { createServer } from 'net';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { cpus, platform, release, totalmem, tmpdir } from 'os';
import { join, relative, resolve } from 'path';
import { attestPreregistration, type Attestation } from './prereg.ts';
import { clusteredPairedDelta, holmAdjusted, type PairedDelta, type PairedItem } from './stats/paired.ts';
import type { BrainEngine } from 'gbrain/engine';
import type { ChunkInput, EngineConfig, SearchResult } from 'gbrain/types';

// ─── Constants ──────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;
export const EMBED_DIMS = 1024; // gbrain's default (voyage:voyage-4 at 1024d, src/core/ai/defaults.ts): content_chunks.embedding is vector(1024). A test checks this against the installed gbrain.
export const EMBED_MODEL = 'hash-embed-v1';
export const RRF_K = 60; // same constant as gbrain's hybridSearch
export const DEFAULT_PG_IMAGE = 'pgvector/pgvector:pg16';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const DATA_DIR = join(REPO_ROOT, 'eval/data');
const REPORT_DIR = join(REPO_ROOT, 'eval/reports/engine-shootout');
export const PREREGISTRATION = 'docs/benchmarks/2026-11-16-engine-shootout-preregistration.md';
/** The preregistered decision margins (see the preregistration, "Decision rule"). They are product assumptions chosen before any counted run, not findings. */
export const DECISION = { ratio_margin: 2.0, interactive_p95_ms: 100, bootstrap_draws: 10000 } as const;
export const PAIRED_OPS = ['get_page', 'search_keyword', 'search_vector', 'search_hybrid_rrf', 'search_keyword_filtered', 'search_vector_filtered', 'get_backlinks', 'list_pages', 'get_timeline'] as const;
export const COST_OPS = ['get_page', 'search_keyword', 'search_vector', 'search_hybrid_rrf'] as const;

/**
 * Price model. Every number here is a published list price, retrieved
 * 2026-11-16 from the AWS pricing pages (via web search, not the AWS price
 * API). They are assumptions for turning measured resource use into dollars,
 * not a quote. Change them and re-run `engine-shootout-chart.ts` or apply your
 * own prices to the measured inputs in the JSON.
 */
export const PRICE_MODEL = {
  as_of: '2026-11-16',
  compute: {
    label: 'AWS Fargate, Linux/x86, us-east-1, on-demand',
    usd_per_vcpu_hour: 0.04048,
    usd_per_gb_hour: 0.004445,
    source: 'https://aws.amazon.com/fargate/pricing/',
  },
  hosted_postgres: {
    label: 'Amazon RDS for PostgreSQL db.t4g.medium (2 vCPU, 4 GB), Single-AZ, us-east-1, on-demand',
    usd_per_hour: 0.065,
    vcpus: 2,
    memory_gb: 4,
    source: 'https://aws.amazon.com/rds/postgresql/pricing/',
    note: 'Instance only. Excludes storage, backups, data transfer and burst-credit charges.',
  },
  hours_per_month: 730,
} as const;

// ─── Small utilities ────────────────────────────────────────────────

/** Seeded PRNG (mulberry32). Same seed gives the same sequence on every machine. */
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

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // nearest-rank
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export interface LatencyStats {
  n: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  mean_ms: number;
  min_ms: number;
  max_ms: number;
}

export function summarize(samples: number[]): LatencyStats {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((x, y) => x + y, 0);
  return {
    n: s.length,
    p50_ms: percentile(s, 50),
    p95_ms: percentile(s, 95),
    p99_ms: percentile(s, 99),
    mean_ms: s.length ? sum / s.length : 0,
    min_ms: s[0] ?? 0,
    max_ms: s[s.length - 1] ?? 0,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
}

const IS_CHILD = process.argv.includes('--child');

/** Progress to stderr. Child lines carry a marker so the orchestrator can forward them and drop gbrain's migration chatter. */
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
 * Seeded feature-hashing embedder. Unigrams (weight 1) and bigrams (weight
 * 0.5) are hashed into EMBED_DIMS buckets with a hashed sign, 8 buckets per
 * feature, then L2-normalised. Deterministic, local, free. It captures word
 * overlap, not meaning, so vector-search quality here is a lexical-overlap
 * score. It is the same for every engine, which is what the comparison needs.
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
      const idx = h % dims;
      const sign = (h >>> 16) & 1 ? 1 : -1;
      v[idx] += sign * w;
    }
  }
  let n = 0;
  for (let i = 0; i < dims; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dims; i++) v[i] /= n;
  return v;
}

// ─── Metrics ────────────────────────────────────────────────────────

export function recallAtK(ranked: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((r) => top.has(r)).length / relevant.length;
}

/** nDCG@k with binary relevance. */
export function ndcgAtK(ranked: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const rel = new Set(relevant);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (rel.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.length); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/** |A ∩ B| / k over the top-k of two ranked lists. Both empty counts as full agreement. */
export function overlapAtK(a: string[], b: string[], k: number): number {
  const ta = a.slice(0, k);
  const tb = new Set(b.slice(0, k));
  if (ta.length === 0 && tb.size === 0) return 1;
  const denom = Math.max(ta.length, tb.size);
  return ta.filter((x) => tb.has(x)).length / denom;
}

/** Reciprocal rank fusion over ranked chunk-id lists (gbrain uses k=60). */
export function rrfFuse<T extends { chunk_id: number }>(lists: T[][], k = RRF_K): T[] {
  const score = new Map<number, number>();
  const item = new Map<number, T>();
  for (const list of lists) {
    list.forEach((r, i) => {
      score.set(r.chunk_id, (score.get(r.chunk_id) ?? 0) + 1 / (k + i + 1));
      if (!item.has(r.chunk_id)) item.set(r.chunk_id, r);
    });
  }
  return [...score.entries()]
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .map(([id]) => item.get(id)!);
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

// ─── Cost model ─────────────────────────────────────────────────────

export interface CostInputs {
  /** CPU seconds consumed per 1,000 queries (client + server). */
  cpu_seconds_per_1k: number;
  /** Memory held while serving, in GB (peak client RSS + server working set). */
  memory_gb: number;
  /** Wall seconds to serve 1,000 queries one at a time. */
  wall_seconds_per_1k: number;
}

export function costPer1kQueries(c: CostInputs, price = PRICE_MODEL) {
  const cpu = (c.cpu_seconds_per_1k / 3600) * price.compute.usd_per_vcpu_hour;
  const mem = (c.memory_gb * c.wall_seconds_per_1k / 3600) * price.compute.usd_per_gb_hour;
  return { cpu_usd: cpu, memory_usd: mem, total_usd: cpu + mem };
}

/** Always-on monthly cost of holding this engine resident at its measured memory (memory line only, plus one vCPU floor is NOT assumed). */
export function monthlyMemoryUsd(memory_gb: number, price = PRICE_MODEL): number {
  return memory_gb * price.hours_per_month * price.compute.usd_per_gb_hour;
}

// ─── Dataset ────────────────────────────────────────────────────────

export interface DPage {
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  base: boolean; // from the committed world-v1 corpus (has qrels); false = generated filler
}
export interface DLink { from_slug: string; to_slug: string; link_type: string }
export interface DTimeline { slug: string; date: string; summary: string }
export interface QualityQuery { id: string; text: string; relevant: string[] }
export interface Probe { text: string; embedding: Float32Array }

export interface Dataset {
  pages: DPage[];
  links: DLink[];
  timeline: DTimeline[];
  chunks: Map<string, ChunkInput[]>;
  qualityQueries: QualityQuery[];
  probes: Probe[];
  linkedSlugs: string[]; // pages with >=1 inbound link
  hubSlug: string;
  fingerprint: string;
  counts: { pages: number; base_pages: number; filler_pages: number; chunks: number; links: number; timeline: number; quality_queries: number; probes: number };
}

function readJsonPages(dir: string): Array<Record<string, any>> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir).sort()) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walkMarkdown(full, out);
    else if (full.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Paragraph pool for filler pages: synthetic-v1 + source-swamp-v1 prose. Never world-v1, so filler cannot compete with the qrels' relevant pages. */
export function loadFillerParagraphs(dataDir = DATA_DIR): string[] {
  const paras: string[] = [];
  const add = (text: string) => {
    for (const p of text.split(/\n{2,}/)) {
      const t = p
        .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_m, s: string) => s.split('/').pop()!.replace(/-/g, ' '))
        .replace(/\]\([^)]*\)/g, ']')
        .trim();
      if (t.length >= 60 && !t.startsWith('#') && !t.startsWith('---') && !t.startsWith('- **')) paras.push(t);
    }
  };
  for (const f of walkMarkdown(join(dataDir, 'synthetic-v1'))) {
    add(readFileSync(f, 'utf-8').replace(/^---[\s\S]*?---\n/, ''));
  }
  for (const p of readJsonPages(join(dataDir, 'source-swamp-v1'))) {
    const ct = Array.isArray(p.compiled_truth) ? p.compiled_truth.join('\n\n') : String(p.compiled_truth ?? '');
    add(ct);
  }
  return paras;
}

const FILLER_TYPES: Array<[string, string]> = [
  ['person', 'people'], ['company', 'companies'], ['meeting', 'meetings'], ['concept', 'concepts'],
];

export function chunkPage(p: { compiled_truth: string; timeline: string }, embed: (t: string) => Float32Array): ChunkInput[] {
  const out: ChunkInput[] = [];
  const paras = p.compiled_truth.split(/\n{2,}/).filter((x) => x.trim());
  let buf = '';
  const flush = () => {
    if (!buf.trim()) return;
    out.push({
      chunk_index: out.length, chunk_text: buf.trim(), chunk_source: 'compiled_truth',
      embedding: embed(buf), model: EMBED_MODEL, token_count: Math.ceil(buf.length / 4),
    });
    buf = '';
  };
  for (const para of paras) {
    if (buf && buf.length + para.length > 1200) flush();
    buf += (buf ? '\n\n' : '') + para;
  }
  flush();
  if (p.timeline.trim()) {
    out.push({
      chunk_index: out.length, chunk_text: p.timeline.trim(), chunk_source: 'timeline',
      embedding: embed(p.timeline), model: EMBED_MODEL, token_count: Math.ceil(p.timeline.length / 4),
    });
  }
  return out;
}

const LINK_RE = /\]\(([a-z][a-z-]*\/[a-z0-9-]+)\)/g;
const TL_RE = /^- \*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|\s*(.+)$/;

/**
 * Build the benchmark dataset. Deterministic for a given (scale, seed) and the
 * committed corpus files.
 *
 * - Base pages: the committed world-v1 corpus (240 pages), which carries the
 *   committed qrels (Tier 5 + 5.5 query sets, 70 queries with gold pages).
 * - Filler pages up to `scale`: seeded recombinations of paragraphs from other
 *   committed corpora. They add realistic bulk and distractors.
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
    const slug = `${dir}/filler-${String(i).padStart(5, '0')}`;
    // Two outbound markdown links to earlier pages (base or filler) give the graph some backlinks.
    const targets = [0, 1].map(() => pages[Math.floor(r() * pages.length)].slug);
    paras.push(`See also [${targets[0]}](${targets[0]}) and [${targets[1]}](${targets[1]}).`);
    const nTl = 2 + Math.floor(r() * 3);
    const tl: string[] = [];
    for (let j = 0; j < nTl; j++) {
      const y = 2021 + Math.floor(r() * 5);
      const m = 1 + Math.floor(r() * 12);
      const d = 1 + Math.floor(r() * 28);
      const evt = pool[Math.floor(r() * pool.length)].split(/(?<=\.)\s/)[0].slice(0, 140);
      tl.push(`- **${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}** | ${evt}`);
    }
    pages.push({
      slug, type, title: `Archive ${String(i).padStart(5, '0')} ${words.join(' ')}`,
      compiled_truth: paras.join('\n\n'), timeline: tl.join('\n'), base: false,
    });
  }

  const slugSet = new Set(pages.map((p) => p.slug));
  const links: DLink[] = [];
  const timeline: DTimeline[] = [];
  const inbound = new Map<string, number>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const m of `${p.compiled_truth}\n${p.timeline}`.matchAll(LINK_RE)) {
      const to = m[1];
      if (to !== p.slug && slugSet.has(to) && !seen.has(to)) {
        seen.add(to);
        links.push({ from_slug: p.slug, to_slug: to, link_type: 'mentions' });
        inbound.set(to, (inbound.get(to) ?? 0) + 1);
      }
    }
    for (const line of p.timeline.split('\n')) {
      const m = line.match(TL_RE);
      if (m) timeline.push({ slug: p.slug, date: m[1], summary: m[2].slice(0, 300) });
    }
  }
  const linkedSlugs = [...inbound.keys()].sort();
  const hubSlug = [...inbound.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? pages[0].slug;

  const chunks = new Map<string, ChunkInput[]>();
  let nChunks = 0;
  for (const p of pages) {
    const c = chunkPage(p, hashEmbed);
    chunks.set(p.slug, c);
    nChunks += c.length;
  }

  // Probes: 2-3 adjacent content words from a random page. Keyword probes are
  // guaranteed to match at least one page; the vector probe is their hashEmbed.
  const probes: Probe[] = [];
  for (let i = 0; i < 400; i++) {
    const p = pages[Math.floor(r() * pages.length)];
    const toks = tokenize(p.compiled_truth).filter((t) => t.length >= 4);
    if (toks.length < 4) { i--; continue; }
    const at = Math.floor(r() * (toks.length - 3));
    const text = toks.slice(at, at + 2 + Math.floor(r() * 2)).join(' ');
    probes.push({ text, embedding: hashEmbed(text) });
  }

  const qq = (qualityQueries ?? []).filter((q) => q.relevant.length > 0 && q.relevant.every((s) => slugSet.has(s)));

  const h = createHash('sha256');
  for (const p of pages) {
    h.update(`${p.slug}\u0000${p.type}\u0000${p.title}\u0000${p.compiled_truth}\u0000${p.timeline}\u0001`);
    for (const c of chunks.get(p.slug)!) {
      h.update(c.chunk_text);
      h.update(Buffer.from(c.embedding!.buffer, c.embedding!.byteOffset, c.embedding!.byteLength));
    }
  }
  for (const q of qq) h.update(`${q.id}\u0000${q.text}\u0000${q.relevant.join(',')}`);
  for (const p of probes) h.update(p.text);

  return {
    pages, links, timeline, chunks, qualityQueries: qq, probes, linkedSlugs, hubSlug,
    fingerprint: h.digest('hex'),
    counts: {
      pages: pages.length, base_pages: pages.filter((p) => p.base).length,
      filler_pages: pages.filter((p) => !p.base).length, chunks: nChunks, links: links.length,
      timeline: timeline.length, quality_queries: qq.length, probes: probes.length,
    },
  };
}

async function loadQualityQueries(): Promise<QualityQuery[]> {
  const { getAllTierQueries } = await import('./queries/index.ts');
  return getAllTierQueries()
    .filter((q) => q.gold?.relevant?.length)
    .map((q) => ({ id: q.id, text: q.text, relevant: [...q.gold.relevant!] }));
}

// ─── Engine arms ────────────────────────────────────────────────────

/**
 * Serializable description of how a child process opens an engine and where
 * its server-side resources can be read from.
 */
export interface ArmRuntime {
  engineConfig: EngineConfig & { engine: string };
  cgroupDir?: string;       // host cgroup dir of the server container (CPU + memory)
  storePath?: string;       // on-disk store (PGLite data dir)
  containerId?: string;
}

export interface ArmHandle {
  runtime: ArmRuntime;
  info: Record<string, unknown>;
  /** Called before each cold-start rep, outside the timed window. Returns a function that starts the server side (timed). */
  prepareColdStart(): Promise<() => Promise<void>>;
  /** Post-run store size (bytes), after a checkpoint. */
  diskUsage(): Promise<{ total_bytes: number; wal_bytes: number; excl_wal_bytes: number; method: string }>;
  teardown(): Promise<void>;
}

export interface ArmSpec {
  id: string;
  label: string;
  /** Short description for the report. */
  kind: string;
  prepare(ctx: { workDir: string; opts: Options }): Promise<ArmHandle>;
}

function duBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const out = spawnSync('du', ['-sb', path], { encoding: 'utf-8' });
  return Number(out.stdout.split(/\s+/)[0]) || 0;
}

const pgliteArm: ArmSpec = {
  id: 'pglite',
  label: 'PGLite',
  kind: 'in-process WASM Postgres with pgvector, on-disk data directory',
  async prepare({ workDir }) {
    const dataDir = join(workDir, 'pglite-data');
    return {
      runtime: { engineConfig: { engine: 'pglite', database_path: dataDir }, storePath: dataDir },
      info: { data_dir: 'workdir/pglite-data (on local disk)' },
      async prepareColdStart() { return async () => {}; },
      async diskUsage() {
        const total = duBytes(dataDir);
        const wal = duBytes(join(dataDir, 'pg_wal'));
        return { total_bytes: total, wal_bytes: wal, excl_wal_bytes: total - wal, method: 'du -sb of the PGLite data directory after the engine is closed (clean shutdown checkpoints)' };
      },
      async teardown() { rmSync(dataDir, { recursive: true, force: true }); },
    };
  },
};

function docker(args: string[], opts: { input?: string; timeout?: number } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf-8', input: opts.input, timeout: opts.timeout ?? 120_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

const PG_SETTINGS = [
  'shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size', 'max_connections',
  'max_wal_size', 'synchronous_commit', 'fsync', 'wal_level', 'max_parallel_workers_per_gather',
  'random_page_cost', 'server_version',
];

const postgresArm: ArmSpec = {
  id: 'postgres',
  label: 'Postgres + pgvector',
  kind: 'PostgreSQL server with pgvector, local Docker container, stock configuration',
  async prepare({ opts }) {
    if (opts.postgresUrl) {
      return {
        runtime: { engineConfig: { engine: 'postgres', database_url: opts.postgresUrl } },
        info: { mode: 'external server (--postgres-url); server CPU and memory not measured' },
        async prepareColdStart() { return async () => {}; },
        async diskUsage() { return { total_bytes: 0, wal_bytes: 0, excl_wal_bytes: 0, method: 'not measured for an external server' }; },
        async teardown() {},
      };
    }
    const image = opts.pgImage;
    const runId = `${process.pid}-${Date.now()}`;
    const name = `gbrain-shootout-${runId}`;
    const port = await freePort();
    // A throwaway password for a container that is bound to 127.0.0.1 and removed at the end of the run.
    const password = createHash('sha256').update(`${runId}${Math.random()}`).digest('hex').slice(0, 24);
    const run = docker([
      'run', '-d', '--name', name, '--label', `gbrain-evals.engine-shootout=${runId}`,
      '-e', `POSTGRES_PASSWORD=${password}`, '-p', `127.0.0.1:${port}:5432`, image,
    ]);
    if (run.code !== 0) throw new Error(`docker run failed: ${run.err}`);
    const id = run.out.split('\n').pop()!.trim();
    log(`[postgres] started container ${name} (${id.slice(0, 12)}) on 127.0.0.1:${port}`);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      docker(['rm', '-f', '-v', id]);
      log(`[postgres] removed container ${name}`);
    };
    const onSig = () => { remove(); process.exit(130); };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
    process.once('exit', remove);

    const waitReady = async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 90_000) {
        // Over TCP: the image's init phase only listens on the unix socket, so this skips it.
        const r = docker(['exec', id, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-Atc', 'select 1']);
        if (r.code === 0 && r.out === '1') return;
        await sleep(250);
      }
      throw new Error('postgres container did not become ready in 90s');
    };
    try { await waitReady(); } catch (e) { remove(); throw e; }

    const fullId = docker(['inspect', '--format', '{{.Id}}', id]).out;
    const cgroupDir = `/sys/fs/cgroup/system.slice/docker-${fullId}.scope`;
    const haveCgroup = existsSync(join(cgroupDir, 'cpu.stat'));
    const settings: Record<string, string> = {};
    const q = docker(['exec', id, 'psql', '-U', 'postgres', '-Atc',
      `select name||'='||setting||coalesce(unit,'') from pg_settings where name in (${PG_SETTINGS.map((s) => `'${s}'`).join(',')})`]);
    for (const line of q.out.split('\n')) { const [k, v] = line.split('='); if (k) settings[k] = v; }
    const digest = docker(['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image]).out;
    const url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;

    const info: Record<string, unknown> = {
        image, image_digest: digest, container: name, settings,
        resource_limits: 'none (container can use all host CPUs and memory)',
        server_stats: haveCgroup ? 'host cgroup v2 files of the container' : 'unavailable (cgroup path not readable)',
    };
    return {
      runtime: { engineConfig: { engine: 'postgres', database_url: url }, cgroupDir: haveCgroup ? cgroupDir : undefined, containerId: id },
      info,
      async prepareColdStart() {
        docker(['stop', '-t', '15', id]);
        return async () => { docker(['start', id]); };
      },
      async diskUsage() {
        const ext = docker(['exec', id, 'psql', '-U', 'postgres', '-Atc', "select extversion from pg_extension where extname='vector'"]);
        (info as Record<string, unknown>).pgvector_extension_version = ext.out || 'not installed';
        docker(['exec', id, 'psql', '-U', 'postgres', '-Atc', 'CHECKPOINT']);
        const du = (p: string) => Number(docker(['exec', id, 'du', '-sb', p]).out.split(/\s+/)[0]) || 0;
        const total = du('/var/lib/postgresql/data');
        const wal = du('/var/lib/postgresql/data/pg_wal');
        return { total_bytes: total, wal_bytes: wal, excl_wal_bytes: total - wal, method: 'du -sb of PGDATA inside the container after CHECKPOINT' };
      },
      async teardown() {
        remove();
        process.removeListener('SIGINT', onSig);
        process.removeListener('SIGTERM', onSig);
      },
    };
  },
};

/**
 * Engine table. To add the Rust engine (benchmark PR B3, after the Rust
 * engine passes its search-parity gates): add an ArmSpec whose
 * `engineConfig.engine` is 'rust' and whose store is its data directory, and
 * make `createEngine` (gbrain/engine-factory) return it. Nothing else in this
 * file is engine specific; every measurement goes through `BrainEngine`.
 */
export const ENGINES: Record<string, ArmSpec> = {
  pglite: pgliteArm,
  postgres: postgresArm,
};

// ─── Child: measure one engine ──────────────────────────────────────

function readProcStatusKb(key: string): number {
  try {
    const m = readFileSync('/proc/self/status', 'utf-8').match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

function cgroupCpuUsec(dir?: string): number | null {
  if (!dir) return null;
  try { return Number(readFileSync(join(dir, 'cpu.stat'), 'utf-8').match(/^usage_usec (\d+)/m)![1]); } catch { return null; }
}

function cgroupWorkingSetBytes(dir?: string): number | null {
  if (!dir) return null;
  try {
    const cur = Number(readFileSync(join(dir, 'memory.current'), 'utf-8'));
    const inactive = Number(readFileSync(join(dir, 'memory.stat'), 'utf-8').match(/^inactive_file (\d+)/m)?.[1] ?? 0);
    return cur - inactive; // same definition `docker stats` uses
  } catch { return null; }
}

function cgroupPeakBytes(dir?: string): number | null {
  if (!dir) return null;
  try { return Number(readFileSync(join(dir, 'memory.peak'), 'utf-8')); } catch { return null; }
}

class MemSampler {
  peakServerWs = 0;
  peakRssKb = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private cgroupDir?: string) {}
  start() {
    const tick = () => {
      this.peakRssKb = Math.max(this.peakRssKb, readProcStatusKb('VmRSS'));
      const ws = cgroupWorkingSetBytes(this.cgroupDir);
      if (ws !== null) this.peakServerWs = Math.max(this.peakServerWs, ws);
    };
    tick();
    this.timer = setInterval(tick, 100);
  }
  stop() { if (this.timer) clearInterval(this.timer); }
}

async function openEngine(config: ArmRuntime['engineConfig']): Promise<BrainEngine> {
  // The hook for future engines: gbrain's factory is the only place that knows engine kinds.
  const { createEngine } = await import('gbrain/engine-factory');
  const engine = await createEngine(config as EngineConfig);
  await engine.connect(config as EngineConfig);
  return engine;
}

async function timeOp<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, performance.now() - t0];
}

interface ChildInput {
  armId: string;
  runtime: ArmRuntime;
  opts: Pick<Options, 'scale' | 'seed' | 'iters' | 'warmup' | 'queries1k' | 'costBlocks' | 'blockSize'>;
}

type Rankings = { keyword: string[][]; vector: string[][]; hybrid: string[][] };

/**
 * Since gbrain v0.60 search serves a page only once its text projection is
 * sealed (`text_projection_revision = knowledge_revision`), which gbrain's own
 * import path does after chunking. This harness writes pages with `putPage` and
 * `upsertChunks` (so it can supply its own vectors with no provider call), then
 * calls gbrain's `sealPageTextProjection` on the page, the same function the
 * import path uses. The import resolves by file path because gbrain does not
 * export it; a future gbrain that moves it fails here, loudly.
 */
let sealFn: ((e: BrainEngine, slug: string, sourceId: string) => Promise<void>) | null = null;
async function seal(engine: BrainEngine, slug: string): Promise<void> {
  if (!sealFn) {
    const mod = await import(join(REPO_ROOT, 'node_modules/gbrain/src/core/page-state/projections.ts'));
    sealFn = mod.sealPageTextProjection;
  }
  await sealFn!(engine, slug, 'default');
}

async function runArmChild(input: ChildInput) {
  const { runtime, opts } = input;
  const qualityQueries = await loadQualityQueries();
  const ds = buildDataset(opts.scale, opts.seed, DATA_DIR, qualityQueries);
  log(`[${input.armId}] dataset ${JSON.stringify(ds.counts)} fingerprint ${ds.fingerprint.slice(0, 12)}`);

  const mem = new MemSampler(runtime.cgroupDir);
  const result: Record<string, any> = { dataset: ds.counts, dataset_fingerprint: ds.fingerprint };

  const baselineRssKb = readProcStatusKb('VmRSS'); // harness only: runtime + dataset in memory, before any engine is opened
  const t0open = performance.now();
  const engine = await openEngine(runtime.engineConfig);
  await engine.initSchema();
  result.open_and_init_schema_ms = performance.now() - t0open;
  mem.start();

  const cpu0 = process.cpuUsage();
  const srv0 = cgroupCpuUsec(runtime.cgroupDir);

  // ── Bulk import ──
  log(`[${input.armId}] importing ${ds.pages.length} pages`);
  const putMs: number[] = [];
  const chunkMs: number[] = [];
  const sealMs: number[] = [];
  let chunkCount = 0;
  const tImport = performance.now();
  for (const p of ds.pages) {
    const [, a] = await timeOp(() => engine.putPage(p.slug, { type: p.type, title: p.title, compiled_truth: p.compiled_truth, timeline: p.timeline }));
    putMs.push(a);
    const chunks = ds.chunks.get(p.slug)!;
    const [, b] = await timeOp(() => engine.upsertChunks(p.slug, chunks));
    chunkMs.push(b);
    chunkCount += chunks.length;
    const [, c] = await timeOp(() => seal(engine, p.slug));
    sealMs.push(c);
  }
  const pagesSec = (performance.now() - tImport) / 1000;
  const tLinks = performance.now();
  let linkRows = 0;
  for (let i = 0; i < ds.links.length; i += 500) linkRows += await engine.addLinksBatch(ds.links.slice(i, i + 500));
  const linksSec = (performance.now() - tLinks) / 1000;
  const tTl = performance.now();
  let tlRows = 0;
  for (let i = 0; i < ds.timeline.length; i += 500) {
    tlRows += await engine.addTimelineEntriesBatch(ds.timeline.slice(i, i + 500).map((t) => ({ slug: t.slug, date: t.date, summary: t.summary, source: 'shootout' })));
  }
  const tlSec = (performance.now() - tTl) / 1000;
  const tAn = performance.now();
  await engine.executeRaw('ANALYZE');
  const analyzeSec = (performance.now() - tAn) / 1000;
  const importCpu = process.cpuUsage(cpu0);
  const srv1 = cgroupCpuUsec(runtime.cgroupDir);
  const skip = Math.min(25, Math.floor(putMs.length / 4));
  result.import = {
    pages: ds.pages.length,
    chunks: chunkCount,
    pages_per_sec: ds.pages.length / pagesSec,
    chunk_upserts_per_sec: chunkCount / (chunkMs.reduce((x, y) => x + y, 0) / 1000),
    page_import_seconds: pagesSec,
    links: { rows_requested: ds.links.length, rows_written: linkRows, seconds: linksSec, per_sec: ds.links.length / linksSec },
    timeline_entries: { rows_requested: ds.timeline.length, rows_written: tlRows, seconds: tlSec, per_sec: ds.timeline.length / tlSec },
    analyze_seconds: analyzeSec,
    cpu_seconds: {
      client: (importCpu.user + importCpu.system) / 1e6,
      server: srv1 !== null && srv0 !== null ? (srv1 - srv0) / 1e6 : null,
    },
    note: `putPage/upsertChunks latency percentiles exclude the first ${skip} samples (warm-up); throughput counts every page`,
  };
  const latency: Record<string, LatencyStats> = {
    put_page: summarize(putMs.slice(skip)),
    upsert_chunks: summarize(chunkMs.slice(skip)),
    seal_text_projection: summarize(sealMs.slice(skip)),
  };

  // ── Read latency ──
  const r = rng(opts.seed ^ 0x5eed);
  const warm = opts.warmup;
  const iters = opts.iters;
  const slugs = ds.pages.map((p) => p.slug);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];

  async function measure(name: string, n: number, fn: (i: number) => Promise<unknown>) {
    for (let i = 0; i < warm; i++) await fn(i); // discarded
    const s: number[] = [];
    for (let i = 0; i < n; i++) { const [, ms] = await timeOp(() => fn(warm + i)); s.push(ms); }
    latency[name] = summarize(s);
    log(`[${input.armId}] ${name.padEnd(26)} p50 ${latency[name].p50_ms.toFixed(2)}  p95 ${latency[name].p95_ms.toFixed(2)}  p99 ${latency[name].p99_ms.toFixed(2)} ms (n=${n})`);
  }

  const probes = ds.probes;
  const P = (i: number) => probes[i % probes.length];
  const kw = (text: string, o: Record<string, unknown> = {}) => engine.searchKeyword(text, { limit: 20, ...o } as any);
  const vec = (e: Float32Array, o: Record<string, unknown> = {}) => engine.searchVector(e, { limit: 20, ...o } as any);
  const hyb = async (pr: Probe) => {
    const a = await kw(pr.text);
    const b = await vec(pr.embedding);
    return rrfFuse<SearchResult>([a, b]);
  };
  const pageSlugs = Array.from({ length: warm + iters }, () => pick(slugs));
  const linkedSlugs = Array.from({ length: warm + iters }, () => pick(ds.linkedSlugs));

  await measure('get_page', iters, (i) => engine.getPage(pageSlugs[i]));
  await measure('search_keyword', iters, (i) => kw(P(i).text));
  await measure('search_vector', iters, (i) => vec(P(i).embedding));
  await measure('search_hybrid_rrf', iters, (i) => hyb(P(i)));
  await measure('search_keyword_filtered', iters, (i) => kw(P(i).text, { type: 'person' }));
  await measure('search_vector_filtered', iters, (i) => vec(P(i).embedding, { type: 'person' }));
  await measure('get_backlinks', iters, (i) => engine.getBacklinks(linkedSlugs[i]));
  await measure('get_backlinks_hub', Math.min(iters, 100), () => engine.getBacklinks(ds.hubSlug));
  await measure('list_pages', iters, () => engine.listPages({ limit: 50 }));
  await measure('list_pages_filtered', iters, () => engine.listPages({ limit: 50, type: 'meeting' } as any));
  await measure('get_timeline', iters, (i) => engine.getTimeline(pageSlugs[i]));

  // ── Quality + rankings for cross-engine agreement ──
  const rank = async (texts: Array<{ text: string; embedding: Float32Array }>): Promise<Rankings> => {
    const out: Rankings = { keyword: [], vector: [], hybrid: [] };
    for (const q of texts) {
      const a = await kw(q.text, { limit: 30 });
      const b = await vec(q.embedding, { limit: 30 });
      out.keyword.push(toSlugs(a));
      out.vector.push(toSlugs(b));
      out.hybrid.push(toSlugs(rrfFuse<SearchResult>([a, b])));
    }
    return out;
  };
  const qRank = await rank(ds.qualityQueries.map((q) => ({ text: q.text, embedding: hashEmbed(q.text) })));
  const pRank = await rank(probes.slice(0, 200));
  const qual: Record<string, any> = {};
  for (const mode of ['keyword', 'vector', 'hybrid'] as const) {
    const lists = qRank[mode];
    const rec = ds.qualityQueries.map((q, i) => recallAtK(lists[i], q.relevant, 5));
    const ndcg = ds.qualityQueries.map((q, i) => ndcgAtK(lists[i], q.relevant, 10));
    const avg = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);
    qual[mode] = {
      recall_at_5: avg(rec), ndcg_at_10: avg(ndcg), n_queries: ds.qualityQueries.length,
      empty_result_rate: lists.filter((l) => l.length === 0).length / Math.max(1, lists.length),
    };
  }
  result.quality = qual;
  result.rankings = { quality: qRank, probes: pRank, quality_ids: ds.qualityQueries.map((q) => q.id) };

  // ── 1,000-query cost window: 400 keyword, 300 vector, 300 hybrid, one client ──
  const cpuA = process.cpuUsage();
  const srvA = cgroupCpuUsec(runtime.cgroupDir);
  const tA = performance.now();
  for (let i = 0; i < opts.queries1k; i++) {
    const pr = P(i + 7);
    const m = i % 10;
    if (m < 4) await kw(pr.text);
    else if (m < 7) await vec(pr.embedding);
    else await hyb(pr);
  }
  const wall = (performance.now() - tA) / 1000;
  const cpuB = process.cpuUsage(cpuA);
  const srvB = cgroupCpuUsec(runtime.cgroupDir);
  const scale1k = 1000 / opts.queries1k;
  const clientCpu = ((cpuB.user + cpuB.system) / 1e6) * scale1k;
  const serverCpu = srvA !== null && srvB !== null ? ((srvB - srvA) / 1e6) * scale1k : null;
  result.cost_window = {
    queries: opts.queries1k, mix: '40% keyword, 30% vector, 30% hybrid (RRF)',
    wall_seconds_per_1k: wall * scale1k,
    client_cpu_seconds_per_1k: clientCpu,
    server_cpu_seconds_per_1k: serverCpu,
    cpu_seconds_per_1k: clientCpu + (serverCpu ?? 0),
    qps_single_client: opts.queries1k / wall,
  };

  // ── Write latency on existing pages (last, because it changes data) ──
  const upd: number[] = [];
  for (let i = 0; i < 100; i++) {
    const p = ds.pages[(i * 7) % ds.pages.length];
    const [, ms] = await timeOp(async () => {
      await engine.putPage(p.slug, { type: p.type, title: p.title, compiled_truth: p.compiled_truth, timeline: `${p.timeline}\n- **2026-11-16** | shootout update ${i}` });
      await seal(engine, p.slug); // a body write unseals the page; the real write path seals it again
    });
    upd.push(ms);
  }
  latency.put_page_update = summarize(upd.slice(5));

  // ── Memory ──
  mem.stop();
  const stats = await engine.getStats();
  result.stats = { page_count: (stats as any).page_count, chunk_count: (stats as any).chunk_count, embedded_count: (stats as any).embedded_count };
  await engine.disconnect();
  const peakRssKb = Math.max(mem.peakRssKb, readProcStatusKb('VmHWM'));
  result.memory = {
    client_peak_rss_bytes: peakRssKb * 1024,
    client_baseline_rss_bytes: baselineRssKb * 1024,
    client_engine_rss_bytes: Math.max(0, peakRssKb - baselineRssKb) * 1024,
    client_peak_rss_method: '/proc/self/status VmHWM of the benchmark process (includes the WASM heap for PGLite). Baseline is VmRSS after the dataset is built and before the engine opens; engine RSS is peak minus baseline.',
    server_peak_working_set_bytes: runtime.cgroupDir ? mem.peakServerWs : null,
    server_peak_working_set_method: runtime.cgroupDir ? 'container cgroup memory.current minus inactive_file (the docker stats definition), sampled every 100 ms' : 'not measurable',
    server_cgroup_memory_peak_bytes_incl_page_cache: cgroupPeakBytes(runtime.cgroupDir),
  };
  result.latency = latency;
  return result;
}

async function runColdStartChild(input: ChildInput) {
  const { runtime } = input;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let engine: BrainEngine | null = null;
  // The server may still be starting (Postgres arm): retry the open inside the timed window.
  for (;;) {
    try {
      engine = await openEngine(runtime.engineConfig);
      await engine.initSchema();
      break;
    } catch (e) {
      if (performance.now() - t0 > 90_000) throw e;
      try { await engine?.disconnect(); } catch { /* ignore */ }
      await sleep(25);
    }
  }
  const tOpen = performance.now();
  const res = await engine.searchKeyword('founder', { limit: 5 } as any);
  const t1 = performance.now();
  await engine.disconnect();
  const c = process.cpuUsage(cpu0);
  return { open_ms: tOpen - t0, first_query_ms: t1 - tOpen, total_ms: t1 - t0, first_query_rows: res.length, client_cpu_ms: (c.user + c.system) / 1000 };
}

// ─── Child: paired measurements (both engines open at once) ─────────

interface PairedInput {
  ref: { armId: string; runtime: ArmRuntime };
  other: { armId: string; runtime: ArmRuntime };
  opts: ChildInput['opts'];
}

export interface PairedRow { q: number; ref_ms: number; other_ms: number; other_first: boolean }
export interface CostBlockSide { wall_s: number; client_cpu_s: number; server_cpu_s: number | null }
export interface CostBlockRow { block: number; ops: number; ref: CostBlockSide; other: CostBlockSide; other_first: boolean }

/**
 * Same query on both engines, back to back, in a seeded random order per
 * query, so drift in the machine (thermal state, a noisy neighbour, background
 * work) lands on both engines alike. Latency pairs are per query; cost pairs
 * are per block of `blockSize` identical operations, because CPU is read from
 * counters that tick too coarsely for one operation.
 *
 * Both stores must already hold the dataset (the arm children built them).
 * Memory is not measured here: two engines in one process would mix.
 */
async function runPairedChild(input: PairedInput) {
  const { opts } = input;
  const qualityQueries = await loadQualityQueries();
  const ds = buildDataset(opts.scale, opts.seed, DATA_DIR, qualityQueries);
  const ref = await openEngine(input.ref.runtime.engineConfig);
  await ref.initSchema();
  const other = await openEngine(input.other.runtime.engineConfig);
  await other.initSchema();

  const r = rng(opts.seed ^ 0xa11ce);
  const total = opts.warmup + opts.iters;
  const slugs = ds.pages.map((p) => p.slug);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const pageSlugs = Array.from({ length: total }, () => pick(slugs));
  const linkedSlugs = Array.from({ length: total }, () => pick(ds.linkedSlugs));
  const P = (i: number) => ds.probes[i % ds.probes.length];
  const kw = (e: BrainEngine, text: string, o: Record<string, unknown> = {}) => e.searchKeyword(text, { limit: 20, ...o } as any);
  const vec = (e: BrainEngine, v: Float32Array, o: Record<string, unknown> = {}) => e.searchVector(v, { limit: 20, ...o } as any);
  const ops: Record<string, (e: BrainEngine, i: number) => Promise<unknown>> = {
    get_page: (e, i) => e.getPage(pageSlugs[i]),
    search_keyword: (e, i) => kw(e, P(i).text),
    search_vector: (e, i) => vec(e, P(i).embedding),
    search_hybrid_rrf: async (e, i) => rrfFuse<SearchResult>([await kw(e, P(i).text), await vec(e, P(i).embedding)]),
    search_keyword_filtered: (e, i) => kw(e, P(i).text, { type: 'person' }),
    search_vector_filtered: (e, i) => vec(e, P(i).embedding, { type: 'person' }),
    get_backlinks: (e, i) => e.getBacklinks(linkedSlugs[i]),
    list_pages: (e) => e.listPages({ limit: 50 }),
    get_timeline: (e, i) => e.getTimeline(pageSlugs[i]),
  };

  const latency: Record<string, PairedRow[]> = {};
  for (const op of PAIRED_OPS) {
    const fn = ops[op];
    for (let i = 0; i < opts.warmup; i++) { await fn(ref, i); await fn(other, i); } // discarded
    const rows: PairedRow[] = [];
    for (let i = 0; i < opts.iters; i++) {
      const qi = opts.warmup + i;
      const otherFirst = r() < 0.5;
      let refMs = 0, otherMs = 0;
      if (otherFirst) { [, otherMs] = await timeOp(() => fn(other, qi)); [, refMs] = await timeOp(() => fn(ref, qi)); }
      else { [, refMs] = await timeOp(() => fn(ref, qi)); [, otherMs] = await timeOp(() => fn(other, qi)); }
      rows.push({ q: i, ref_ms: refMs, other_ms: otherMs, other_first: otherFirst });
    }
    latency[op] = rows;
    log(`[paired] ${op.padEnd(26)} median ref ${median(rows.map((x) => x.ref_ms)).toFixed(2)} ms, other ${median(rows.map((x) => x.other_ms)).toFixed(2)} ms (n=${rows.length})`);
  }

  const side = async (e: BrainEngine, rt: ArmRuntime, fn: (e: BrainEngine, i: number) => Promise<unknown>, first: number, n: number): Promise<CostBlockSide> => {
    const cpu0 = process.cpuUsage();
    const srv0 = cgroupCpuUsec(rt.cgroupDir);
    const t0 = performance.now();
    for (let j = 0; j < n; j++) await fn(e, (first + j) % total); // wrap: the per-index slug lists have `total` entries
    const wall = (performance.now() - t0) / 1000;
    const c = process.cpuUsage(cpu0);
    const srv1 = cgroupCpuUsec(rt.cgroupDir);
    return { wall_s: wall, client_cpu_s: (c.user + c.system) / 1e6, server_cpu_s: srv0 !== null && srv1 !== null ? (srv1 - srv0) / 1e6 : null };
  };
  const costBlocks: Record<string, CostBlockRow[]> = {};
  for (const op of COST_OPS) {
    const rows: CostBlockRow[] = [];
    for (let b = 0; b < opts.costBlocks; b++) {
      const otherFirst = r() < 0.5;
      const first = (b * opts.blockSize) % Math.max(1, total);
      const run = (which: 'ref' | 'other') => which === 'ref'
        ? side(ref, input.ref.runtime, ops[op], first, opts.blockSize)
        : side(other, input.other.runtime, ops[op], first, opts.blockSize);
      let a: CostBlockSide, c: CostBlockSide;
      if (otherFirst) { c = await run('other'); a = await run('ref'); } else { a = await run('ref'); c = await run('other'); }
      rows.push({ block: b, ops: opts.blockSize, ref: a, other: c, other_first: otherFirst });
    }
    costBlocks[op] = rows;
    log(`[paired] cost blocks ${op}: ${rows.length} x ${opts.blockSize} ops`);
  }
  await other.disconnect();
  await ref.disconnect();
  return { latency, cost_blocks: costBlocks };
}

// ─── Orchestrator ───────────────────────────────────────────────────

export interface Options {
  scale: number;
  seed: number;
  iters: number;
  warmup: number;
  coldReps: number;
  queries1k: number;
  costBlocks: number;
  blockSize: number;
  dev: boolean;
  outDir?: string;
  engines: string[];
  postgresUrl?: string;
  pgImage: string;
  keepWork: boolean;
}

export function parseArgs(argv: string[]): Options {
  const get = (f: string) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
  const o: Options = {
    scale: Number(get('--scale') ?? 1000),
    seed: Number(get('--seed') ?? 1337),
    iters: Number(get('--iters') ?? 300),
    warmup: Number(get('--warmup') ?? 30),
    coldReps: Number(get('--cold-reps') ?? 3),
    queries1k: Number(get('--queries') ?? 1000),
    costBlocks: Number(get('--cost-blocks') ?? 20),
    blockSize: Number(get('--block-size') ?? 50),
    dev: argv.includes('--dev'),
    outDir: get('--out') ? resolve(get('--out')!) : undefined,
    engines: (get('--engines') ?? 'pglite,postgres').split(',').map((s) => s.trim()).filter(Boolean),
    postgresUrl: get('--postgres-url'),
    pgImage: get('--pg-image') ?? DEFAULT_PG_IMAGE,
    keepWork: argv.includes('--keep-work'),
  };
  if (!Number.isFinite(o.scale) || o.scale < 10) throw new Error('--scale must be a number >= 10');
  for (const e of o.engines) {
    if (e === 'rust') throw new Error('The rust engine is not available yet. It joins this benchmark after it passes the search-parity gates (see the ENGINES table).');
    if (!ENGINES[e]) throw new Error(`Unknown engine "${e}". Available: ${Object.keys(ENGINES).join(', ')}`);
  }
  return o;
}

function childEnv(home: string): Record<string, string> {
  // Minimal environment on purpose: no API keys, no user brain config.
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(), NO_COLOR: '1' };
}

function runChild(kind: 'arm' | 'coldstart' | 'paired', input: ChildInput | PairedInput, workDir: string, tag: string): Promise<any> {
  const inFile = join(workDir, `${tag}.in.json`);
  const outFile = join(workDir, `${tag}.out.json`);
  writeFileSync(inFile, JSON.stringify(input));
  const home = join(workDir, 'home');
  mkdirSync(home, { recursive: true });
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [import.meta.path, '--child', kind, '--in', inFile, '--out', outFile], {
      env: childEnv(home), stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT,
    });
    const logFile = join(workDir, `${tag}.log`);
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.startsWith('@@ ')) process.stderr.write(`${l.slice(3)}\n`);
    };
    const all: Buffer[] = [];
    p.stdout!.on('data', (d: Buffer) => all.push(d));
    p.stderr!.on('data', (d: Buffer) => { all.push(d); onData(d); });
    p.on('exit', (code) => {
      writeFileSync(logFile, Buffer.concat(all));
      if (code !== 0) process.stderr.write(Buffer.concat(all).toString().split('\n').slice(-25).join('\n') + '\n');
      if (code === 0 && existsSync(outFile)) res(JSON.parse(readFileSync(outFile, 'utf-8')));
      else rej(new Error(`child ${kind}/${tag} exited with code ${code}`));
    });
  });
}

function gbrainCommit(): string {
  try {
    const lock = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf-8');
    return lock.match(/gbrain@github:garrytan\/gbrain#([0-9a-f]+)/)?.[1] ?? 'unknown';
  } catch { return 'unknown'; }
}

function machine() {
  const c = cpus();
  return {
    cpu_model: c[0]?.model ?? 'unknown', logical_cpus: c.length, memory_gb: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    os: `${platform()} ${release()}`, bun: Bun.version, docker: docker(['--version']).out || 'not installed',
  };
}

export interface ArmReport {
  id: string; label: string; kind: string; info: Record<string, unknown>;
  run: Record<string, any>;
  cold_start: { reps: any[]; median_total_ms: number; median_server_to_answer_ms: number | null; method: string };
  disk: { total_bytes: number; wal_bytes: number; excl_wal_bytes: number; method: string };
  cost: Record<string, any>;
}

export function computeCost(run: Record<string, any>, mem: { client: number; server: number | null }) {
  const cw = run.cost_window;
  const memoryGb = (mem.client + (mem.server ?? 0)) / 2 ** 30;
  const per1k = costPer1kQueries({ cpu_seconds_per_1k: cw.cpu_seconds_per_1k, memory_gb: memoryGb, wall_seconds_per_1k: cw.wall_seconds_per_1k });
  return {
    inputs: {
      cpu_seconds_per_1k_queries: cw.cpu_seconds_per_1k,
      client_cpu_seconds_per_1k: cw.client_cpu_seconds_per_1k,
      server_cpu_seconds_per_1k: cw.server_cpu_seconds_per_1k,
      memory_gb: memoryGb,
      memory_basis: 'engine-attributable client RSS (peak minus harness baseline) + peak server working set',
      wall_seconds_per_1k_queries: cw.wall_seconds_per_1k,
    },
    price_model: PRICE_MODEL,
    usd_per_1k_queries: per1k,
    usd_per_month_memory_resident: monthlyMemoryUsd(memoryGb),
    hosted_postgres_usd_per_month: PRICE_MODEL.hosted_postgres.usd_per_hour * PRICE_MODEL.hours_per_month,
  };
}

export function computeAgreement(a: Rankings, b: Rankings): Record<string, { overlap_at_5: number; top1_match: number; n: number }> {
  const out: Record<string, { overlap_at_5: number; top1_match: number; n: number }> = {};
  for (const mode of ['keyword', 'vector', 'hybrid'] as const) {
    const n = Math.min(a[mode].length, b[mode].length);
    let ov = 0, t1 = 0;
    for (let i = 0; i < n; i++) {
      ov += overlapAtK(a[mode][i], b[mode][i], 5);
      if ((a[mode][i][0] ?? null) === (b[mode][i][0] ?? null)) t1++;
    }
    out[mode] = { overlap_at_5: n ? ov / n : 0, top1_match: n ? t1 / n : 0, n };
  }
  return out;
}

// ─── Paired analysis ────────────────────────────────────────────────

const ci = (d: PairedDelta) => d.ci95;

export interface LatencyPairSummary {
  n: number;
  ref_p50_ms: number; other_p50_ms: number;
  ref_p95_ms: number; other_p95_ms: number;
  ref_p99_ms: number; other_p99_ms: number;
  /** other minus reference, milliseconds, mean of per-query differences. */
  diff_ms: { delta: number; ci95: [number, number] | null };
  /** exp(mean of per-query ln(other/reference)): "other takes this many times as long". */
  geo_mean_ratio: { ratio: number; ci95: [number, number] | null };
  p_two_sided: number;
  p_holm: number | null;
  /** Diagnostic: does running first or second change the answer? */
  by_order: { ref_first: { n: number; mean_diff_ms: number | null }; other_first: { n: number; mean_diff_ms: number | null } };
}

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);

/** Per-query paired latency comparison: clustered bootstrap (each query is its own cluster) with a sign-flip test. */
export function analyzeLatency(rows: PairedRow[], seed: number, draws: number = DECISION.bootstrap_draws): LatencyPairSummary {
  const ms: PairedItem[] = rows.map((x) => ({ id: String(x.q), cluster: String(x.q).padStart(6, '0'), a: x.ref_ms, b: x.other_ms }));
  const logs: PairedItem[] = rows.map((x) => ({ id: String(x.q), cluster: String(x.q).padStart(6, '0'), a: Math.log(Math.max(x.ref_ms, 1e-6)), b: Math.log(Math.max(x.other_ms, 1e-6)) }));
  const d = clusteredPairedDelta(ms, { seed, draws });
  const l = clusteredPairedDelta(logs, { seed, draws });
  const ref = rows.map((x) => x.ref_ms).sort((a, b) => a - b), oth = rows.map((x) => x.other_ms).sort((a, b) => a - b);
  const byOrder = (first: boolean) => {
    const sel = rows.filter((x) => x.other_first === first);
    return { n: sel.length, mean_diff_ms: sel.length ? mean(sel.map((x) => x.other_ms - x.ref_ms)) : null };
  };
  return {
    n: rows.length,
    ref_p50_ms: percentile(ref, 50), other_p50_ms: percentile(oth, 50),
    ref_p95_ms: percentile(ref, 95), other_p95_ms: percentile(oth, 95),
    ref_p99_ms: percentile(ref, 99), other_p99_ms: percentile(oth, 99),
    diff_ms: { delta: d.delta, ci95: ci(d) },
    geo_mean_ratio: { ratio: Math.exp(l.delta), ci95: l.ci95 ? [Math.exp(l.ci95[0]), Math.exp(l.ci95[1])] : null },
    p_two_sided: d.p_two_sided,
    p_holm: null,
    by_order: { ref_first: byOrder(false), other_first: byOrder(true) },
  };
}

/** Holm-adjust the two-sided p-values across the listed operations, in place. */
export function holmAcross(summaries: Record<string, LatencyPairSummary>): void {
  const keys = Object.keys(summaries);
  if (!keys.length) return;
  const adj = holmAdjusted(keys.map((k) => summaries[k].p_two_sided));
  keys.forEach((k, i) => { summaries[k].p_holm = adj[i]; });
}

export interface CostPairSummary {
  blocks: number;
  ops_per_block: number;
  ref_usd_per_1k_ops: number; other_usd_per_1k_ops: number;
  ref_cpu_s_per_1k_ops: number; other_cpu_s_per_1k_ops: number;
  /** other minus reference, USD per 1,000 operations. */
  diff_usd_per_1k_ops: { delta: number; ci95: [number, number] | null };
  diff_cpu_s_per_1k_ops: { delta: number; ci95: [number, number] | null };
  p_two_sided: number;
}

/** Per-block resource use turned into dollars with the price model, paired by block. Memory is each engine's measured memory held for the block's wall time. */
export function analyzeCost(rows: CostBlockRow[], memGb: { ref: number; other: number }, seed: number, draws: number = DECISION.bootstrap_draws): CostPairSummary {
  const cpu = (s: CostBlockSide) => s.client_cpu_s + (s.server_cpu_s ?? 0);
  const usd = (s: CostBlockSide, ops: number, gb: number) => costPer1kQueries({ cpu_seconds_per_1k: (cpu(s) / ops) * 1000, memory_gb: gb, wall_seconds_per_1k: (s.wall_s / ops) * 1000 }).total_usd;
  const items = (f: (r: CostBlockRow, side: 'ref' | 'other') => number): PairedItem[] =>
    rows.map((r) => ({ id: String(r.block), cluster: String(r.block).padStart(6, '0'), a: f(r, 'ref'), b: f(r, 'other') }));
  const usdItems = items((r, k) => usd(r[k], r.ops, k === 'ref' ? memGb.ref : memGb.other));
  const cpuItems = items((r, k) => (cpu(r[k]) / r.ops) * 1000);
  const u = clusteredPairedDelta(usdItems, { seed, draws });
  const c = clusteredPairedDelta(cpuItems, { seed, draws });
  return {
    blocks: rows.length, ops_per_block: rows[0]?.ops ?? 0,
    ref_usd_per_1k_ops: u.mean_a, other_usd_per_1k_ops: u.mean_b,
    ref_cpu_s_per_1k_ops: c.mean_a, other_cpu_s_per_1k_ops: c.mean_b,
    diff_usd_per_1k_ops: { delta: u.delta, ci95: ci(u) },
    diff_cpu_s_per_1k_ops: { delta: c.delta, ci95: ci(c) },
    p_two_sided: u.p_two_sided,
  };
}

export interface QualityPairSummary {
  n_queries: number;
  ref_mean: number; other_mean: number;
  diff: { delta: number; ci95: [number, number] | null };
  queries_that_differ: number;
}

/** Paired per-query quality (same query, both engines). Gold pages come from the committed Tier 5 / 5.5 sets. */
export function analyzeQuality(
  ref: string[][], other: string[][], relevant: string[][], metric: 'recall_at_5' | 'ndcg_at_10', seed: number, draws: number = DECISION.bootstrap_draws,
): QualityPairSummary {
  const f = (list: string[], rel: string[]) => (metric === 'recall_at_5' ? recallAtK(list, rel, 5) : ndcgAtK(list, rel, 10));
  const items: PairedItem[] = relevant.map((rel, i) => ({ id: String(i), cluster: String(i).padStart(6, '0'), a: f(ref[i], rel), b: f(other[i], rel) }));
  const d = clusteredPairedDelta(items, { seed, draws });
  return { n_queries: items.length, ref_mean: d.mean_a, other_mean: d.mean_b, diff: { delta: d.delta, ci95: ci(d) }, queries_that_differ: items.filter((x) => x.a !== x.b).length };
}

export type DecisionOutcome = 'pglite_adequate' | 'postgres_recommended' | 'no_clear_call' | 'withheld_quality_differs';

/**
 * The preregistered decision rule for one scale, applied mechanically.
 * Primary endpoint: the paired geometric-mean latency ratio (PGLite over
 * Postgres) on hybrid search.
 */
export function applyDecisionRule(input: {
  hybrid: LatencyPairSummary;
  quality: { recall_at_5: QualityPairSummary; ndcg_at_10: QualityPairSummary };
}): { outcome: DecisionOutcome; reasons: string[] } {
  const reasons: string[] = [];
  const excludesZero = (q: QualityPairSummary) => !!q.diff.ci95 && (q.diff.ci95[0] > 0 || q.diff.ci95[1] < 0);
  if (excludesZero(input.quality.recall_at_5) || excludesZero(input.quality.ndcg_at_10)) {
    reasons.push('hybrid quality differs between the engines (paired interval excludes zero); latency does not decide anything until that is understood');
    return { outcome: 'withheld_quality_differs', reasons };
  }
  const h = input.hybrid;
  const ci95 = h.geo_mean_ratio.ci95;
  const upper = ci95 ? ci95[1] : Infinity;
  const lower = ci95 ? ci95[0] : 0;
  const p95 = h.other_p95_ms;
  reasons.push(`hybrid ratio ${h.geo_mean_ratio.ratio.toFixed(2)} (95% interval ${ci95 ? `${ci95[0].toFixed(2)} to ${ci95[1].toFixed(2)}` : 'n/a'}), margin ${DECISION.ratio_margin}`);
  reasons.push(`PGLite hybrid p95 ${p95.toFixed(1)} ms, interactive limit ${DECISION.interactive_p95_ms} ms`);
  if (upper <= DECISION.ratio_margin && p95 <= DECISION.interactive_p95_ms) return { outcome: 'pglite_adequate', reasons };
  if (lower > DECISION.ratio_margin || p95 > DECISION.interactive_p95_ms) return { outcome: 'postgres_recommended', reasons };
  return { outcome: 'no_clear_call', reasons };
}

async function orchestrate(opts: Options) {
  const started = Date.now();
  // A counted run first proves the preregistration is committed, unchanged and on origin. --dev skips that and marks the output uncounted.
  const attestation: Attestation | null = opts.dev ? null : attestPreregistration(PREREGISTRATION, REPO_ROOT);
  mkdirSync(REPORT_DIR, { recursive: true });
  const workDir = mkdtempSync(join(REPORT_DIR, '.work-'));
  const arms: Record<string, ArmReport> = {};
  const rankings: Record<string, any> = {};
  const handles: Record<string, ArmHandle> = {};
  const inputs: Record<string, ChildInput> = {};
  let paired: Record<string, any> = {};
  try {
    for (const id of opts.engines) {
      const spec = ENGINES[id];
      log(`\n== ${spec.label} ==`);
      const handle = await spec.prepare({ workDir, opts });
      handles[id] = handle;
      const input: ChildInput = {
        armId: id, runtime: handle.runtime,
        opts: { scale: opts.scale, seed: opts.seed, iters: opts.iters, warmup: opts.warmup, queries1k: opts.queries1k, costBlocks: opts.costBlocks, blockSize: opts.blockSize },
      };
      inputs[id] = input;
      const run = await runChild('arm', input, workDir, `${id}-run`);
      rankings[id] = run.rankings;
      delete run.rankings; // kept only for agreement and paired quality, not in the per-arm output
      const disk = await handle.diskUsage();

      log(`[${id}] cold start x${opts.coldReps}`);
      const reps: any[] = [];
      const serverToAnswer: number[] = [];
      for (let i = 0; i < opts.coldReps; i++) {
        const start = await handle.prepareColdStart();
        const t0 = performance.now();
        await start();
        const rep = await runChild('coldstart', input, workDir, `${id}-cold-${i}`);
        rep.orchestrator_start_to_answer_ms = performance.now() - t0;
        reps.push(rep);
        serverToAnswer.push(rep.orchestrator_start_to_answer_ms);
      }
      const cold = {
        reps,
        median_total_ms: median(reps.map((x) => x.total_ms)),
        median_server_to_answer_ms: id === 'postgres' && !opts.postgresUrl ? median(serverToAnswer) : null,
        method: id === 'postgres'
          ? 'each rep: stop the server container (not timed), start it (timed), then a fresh client process connects, runs initSchema and answers one keyword query. total_ms is client-side; median_server_to_answer_ms covers server start too. OS file cache is warm.'
          : 'each rep: a fresh process opens the existing on-disk data directory, runs initSchema and answers one keyword query. Module load is excluded; OS file cache is warm.',
      };
      const memory = run.memory;
      const cost = computeCost(run, { client: memory.client_engine_rss_bytes, server: memory.server_peak_working_set_bytes });
      arms[id] = { id, label: spec.label, kind: spec.kind, info: handle.info, run, cold_start: cold, disk, cost };
    }

    // ── Paired phase: every other engine against the reference, same queries, interleaved ──
    const ids = Object.keys(arms);
    const ref = ids.includes('postgres') ? 'postgres' : ids[0];
    const qualityQueries = await loadQualityQueries();
    for (const id of ids.filter((x) => x !== ref)) {
      log(`\n== Paired: ${arms[id].label} vs ${arms[ref].label} ==`);
      const pi: PairedInput = { ref: { armId: ref, runtime: handles[ref].runtime }, other: { armId: id, runtime: handles[id].runtime }, opts: inputs[id].opts };
      const raw = await runChild('paired', pi, workDir, `paired-${id}-vs-${ref}`);
      const seed = opts.seed;
      const latency: Record<string, LatencyPairSummary> = {};
      for (const op of PAIRED_OPS) latency[op] = analyzeLatency(raw.latency[op], seed);
      holmAcross(latency);
      const memGb = { ref: arms[ref].cost.inputs.memory_gb as number, other: arms[id].cost.inputs.memory_gb as number };
      const costPerOp: Record<string, CostPairSummary> = {};
      for (const op of COST_OPS) costPerOp[op] = analyzeCost(raw.cost_blocks[op], memGb, seed);
      const qids: string[] = rankings[ref].quality_ids;
      const byId = new Map(qualityQueries.map((q) => [q.id, q] as const));
      const relevant = qids.map((q) => byId.get(q)!.relevant);
      const quality: Record<string, { recall_at_5: QualityPairSummary; ndcg_at_10: QualityPairSummary }> = {};
      for (const mode of ['keyword', 'vector', 'hybrid'] as const) {
        quality[mode] = {
          recall_at_5: analyzeQuality(rankings[ref].quality[mode], rankings[id].quality[mode], relevant, 'recall_at_5', seed),
          ndcg_at_10: analyzeQuality(rankings[ref].quality[mode], rankings[id].quality[mode], relevant, 'ndcg_at_10', seed),
        };
      }
      const decision = applyDecisionRule({ hybrid: latency.search_hybrid_rrf, quality: quality.hybrid });
      paired[`${id}_vs_${ref}`] = {
        reference: ref, other: id,
        direction: 'differences are other minus reference; ratios are other over reference',
        method: 'per query (latency, quality) or per block of identical operations (cost): same input on both engines, back to back, in a seeded random order. Clustered paired bootstrap, 95% percentile interval, '
          + `${DECISION.bootstrap_draws} draws, seed ${seed}; sign-flip p-values, Holm-adjusted across the ${PAIRED_OPS.length} latency operations. Each query (or block) is its own cluster.`,
        latency, cost_per_op: costPerOp, quality, decision,
        rows: { latency: raw.latency, cost_blocks: raw.cost_blocks },
      };
    }
  } finally {
    for (const h of Object.values(handles)) await h.teardown();
    if (!opts.keepWork) rmSync(workDir, { recursive: true, force: true });
  }

  const ids = Object.keys(arms);
  const agreement: Record<string, any> = {};
  const ref = ids.includes('postgres') ? 'postgres' : ids[0];
  for (const id of ids) {
    if (id === ref) continue;
    agreement[`${id}_vs_${ref}`] = {
      quality_queries: computeAgreement(rankings[id].quality, rankings[ref].quality),
      probe_queries: computeAgreement(rankings[id].probes, rankings[ref].probes),
    };
  }

  const out = {
    schema_version: SCHEMA_VERSION,
    benchmark: 'engine-shootout',
    counted: !opts.dev,
    preregistration_attestation: attestation,
    generated_at: new Date().toISOString(),
    run_seconds: (Date.now() - started) / 1000,
    command: `bun eval/runner/engine-shootout.ts ${process.argv.slice(2).join(' ')}`.trim(),
    options: { scale: opts.scale, seed: opts.seed, iters: opts.iters, warmup: opts.warmup, cold_reps: opts.coldReps, queries_for_cost: opts.queries1k, cost_blocks: opts.costBlocks, block_size: opts.blockSize },
    gbrain_commit: gbrainCommit(),
    evals_commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' }).stdout.trim(),
    machine: machine(),
    embedder: { model: EMBED_MODEL, dims: EMBED_DIMS, note: 'seeded feature hashing, no provider calls' },
    price_model: PRICE_MODEL,
    decision_rule: DECISION,
    arms,
    paired,
    agreement,
    agreement_reference: ref,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = join(opts.outDir ?? REPORT_DIR, `${opts.dev ? 'dev-' : ''}${stamp}-${opts.scale}.json`);
  mkdirSync(opts.outDir ?? REPORT_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  log(`\nwrote ${relative(REPO_ROOT, file)} (${out.run_seconds.toFixed(0)}s)`);
  return { file, out };
}

async function main() {
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--child');
  if (ci !== -1) {
    const kind = argv[ci + 1] as 'arm' | 'coldstart' | 'paired';
    const raw = JSON.parse(readFileSync(argv[argv.indexOf('--in') + 1], 'utf-8'));
    const res = kind === 'arm' ? await runArmChild(raw as ChildInput) : kind === 'coldstart' ? await runColdStartChild(raw as ChildInput) : await runPairedChild(raw as PairedInput);
    writeFileSync(argv[argv.indexOf('--out') + 1], JSON.stringify(res));
    process.exit(0);
  }
  const opts = parseArgs(argv);
  const { file } = await orchestrate(opts);
  console.log(file);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('engine-shootout error:', e);
    process.exit(1);
  });
}
