#!/usr/bin/env bun
/**
 * Scale-latency builder (GBEV-55 G5): a synthetic gbrain brain of any size, built
 * for measuring latency at brain scale (the target is 300,000 pages).
 *
 *   bun eval/runner/predictive/scale-latency/build.ts --database-url-env SCALE_LATENCY_DATABASE_URL \
 *     --pages 300000 --checkpoint <dir>/checkpoint.json [--batch 1000] [--concurrency 8] [--seed 55]
 *
 * Every page is fictional and comes from a seeded generator (scalePage): people,
 * companies, projects, meetings and notes whose words follow a Zipf curve over an
 * invented vocabulary, so the commonest keyword terms match a large share of the
 * brain, as they do in a real one. Pages go in through gbrain's own importer
 * (importFromContent), so chunking, triggers and index writes are gbrain's. The
 * embedding transport is replaced in-process: each chunk gets a seeded random
 * unit vector at gbrain's default embedding width (DEFAULT_EMBEDDING_DIMENSIONS,
 * 1024 for voyage:voyage-4 at the pin), so no embedding provider is ever called.
 * The brain gets the real brain's search setting as live-recall batch 2's scorecard
 * records it (REAL_SEARCH_CONFIG: mode tokenmax, reranker voyage:rerank-2.5); the
 * rerank transport stays in-process.
 *
 * The load runs in batches. After each batch the checkpoint file names the last
 * finished batch, so a rerun with the same seed, size, batch size and width
 * continues from the next batch. The importer skips an unchanged page, so a batch
 * cut off half way is safe to run again.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Rng } from '../../../generators/seeded.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from '../../gbrain-under-test.ts';
import { withHermeticEnv } from '../../hermetic-env.ts';

export const BUILD_SCHEMA = 'gbrain-evals/scale-latency-checkpoint/v1';
export const DEFAULT_SEED = 55;
export const DEFAULT_PAGES = 300_000;
export const DEFAULT_BATCH = 1_000;
export const VOCABULARY_SIZE = 4_000;
export const PAGE_TYPES = ['person', 'company', 'project', 'meeting', 'note'] as const;
export type ScalePageType = (typeof PAGE_TYPES)[number];
const TYPE_DIR: Record<ScalePageType, string> = { person: 'people', company: 'companies', project: 'projects', meeting: 'meetings', note: 'notes' };
/** Share of pages per type, in PAGE_TYPES order. */
const TYPE_WEIGHTS = [0.2, 0.1, 0.1, 0.3, 0.3];

const ONSETS = ['b', 'br', 'c', 'd', 'dr', 'f', 'g', 'gr', 'h', 'k', 'l', 'm', 'n', 'p', 'qu', 'r', 's', 'st', 't', 'tr', 'v', 'w', 'z'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ai', 'ea', 'io', 'ou'];
const CODAS = ['', 'n', 'r', 'l', 'x', 'th', 'nd', 'sk', 'v', 'm'];
const COMPANY_SUFFIX = ['Labs', 'Works', 'Systems', 'Collective', 'Foundry', 'Partners'];

export interface ScalePage { index: number; slug: string; type: ScalePageType; title: string; markdown: string }

export function seedOf(...parts: Array<string | number>): number {
  return createHash('sha256').update(parts.join(':')).digest().readUInt32LE(0);
}

function word(rng: Rng, syllables: number): string {
  let w = '';
  for (let i = 0; i < syllables; i++) w += rng.pick(ONSETS) + rng.pick(VOWELS) + (i === syllables - 1 ? rng.pick(CODAS) : '');
  return w;
}

const capital = (w: string) => w[0].toUpperCase() + w.slice(1);
const vocabularies = new Map<number, { words: string[]; cumulative: number[] }>();

/** The invented vocabulary for a seed, with Zipf weights (rank r has weight 1/r). */
export function vocabulary(seed: number): { words: string[]; cumulative: number[] } {
  const cached = vocabularies.get(seed);
  if (cached) return cached;
  const rng = new Rng(seedOf('vocabulary', seed));
  const seen = new Set<string>();
  const words: string[] = [];
  while (words.length < VOCABULARY_SIZE) {
    const w = word(rng, rng.int(1, 3));
    if (w.length > 2 && !seen.has(w)) { seen.add(w); words.push(w); }
  }
  const cumulative: number[] = [];
  let total = 0;
  for (let r = 1; r <= words.length; r++) cumulative.push(total += 1 / r);
  const out = { words, cumulative: cumulative.map(c => c / total) };
  vocabularies.set(seed, out);
  return out;
}

/** One Zipf-distributed vocabulary word. */
export function zipfWord(rng: Rng, seed: number): string {
  const { words, cumulative } = vocabulary(seed);
  const u = rng.float();
  let lo = 0, hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < u) lo = mid + 1; else hi = mid;
  }
  return words[lo];
}

function pickType(rng: Rng): ScalePageType {
  let u = rng.float();
  for (let i = 0; i < PAGE_TYPES.length; i++) if ((u -= TYPE_WEIGHTS[i]) < 0) return PAGE_TYPES[i];
  return PAGE_TYPES[PAGE_TYPES.length - 1];
}

function sentence(rng: Rng, seed: number): string {
  const words = Array.from({ length: rng.int(6, 16) }, () => zipfWord(rng, seed));
  return capital(words.join(' ')) + '.';
}

/** Page i of the brain for a seed: same seed and index, same page, on any machine. */
export function scalePage(seed: number, index: number): ScalePage {
  const rng = new Rng(seedOf('page', seed, index));
  const type = pickType(rng);
  const name = type === 'person' ? `${capital(word(rng, 2))} ${capital(word(rng, 2))}`
    : type === 'company' ? `${capital(word(rng, 2))} ${rng.pick(COMPANY_SUFFIX)}`
    : type === 'project' ? `Project ${capital(word(rng, 2))}`
    : type === 'meeting' ? `Meeting ${capital(word(rng, 1))} ${capital(word(rng, 2))}`
    : capital(`${zipfWord(rng, seed)} ${zipfWord(rng, seed)} ${zipfWord(rng, seed)}`);
  const slug = `${TYPE_DIR[type]}/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`;
  const paragraphs = Array.from({ length: rng.int(2, 10) }, () => Array.from({ length: rng.int(2, 6) }, () => sentence(rng, seed)).join(' '));
  const day = new Date(Date.UTC(2020, 0, 1) + rng.int(0, 6 * 365) * 86_400_000).toISOString().slice(0, 10);
  const markdown = `---\ntype: ${type}\ntitle: ${name}\ndate: ${day}\n---\n\n# ${name}\n\n${paragraphs.join('\n\n')}\n`;
  return { index, slug, type, title: name, markdown };
}

/** sha256 over the first n pages, pinned in the test so a generator change is visible. */
export function pagesDigest(seed: number, n: number): string {
  const h = createHash('sha256');
  for (let i = 0; i < n; i++) h.update(scalePage(seed, i).markdown);
  return h.digest('hex');
}

/** A seeded random unit vector for one chunk text: random at the real width, never a provider call. */
export function randomUnitVector(text: string, dim: number): number[] {
  const rng = new Rng(seedOf('vector', text));
  const v = Array.from({ length: dim }, () => rng.float() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

export interface ScaleTransports { embedding_model: string; embedding_dim: number; reranker_model: string; reset(): void }

/**
 * Point gbrain's gateway at in-process transports: seeded random embeddings at the
 * default width and the token-overlap reranker the live-recall fixture uses. The
 * gateway sees placeholder keys only, so key-aware defaults resolve as on a keyed
 * brain while every embed and rerank call stays in this process.
 */
export async function useScaleTransports(gut: GbrainUnderTest): Promise<ScaleTransports> {
  const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
  const defaults = await importGbrain<any>(gut, 'src/core/ai/defaults.ts');
  const { makeOverlapRerankTransport } = await import('../../cat18b-embedding-rerank-matrix.ts');
  const dim: number = defaults.DEFAULT_EMBEDDING_DIMENSIONS;
  gateway.configureGateway({ embedding_model: defaults.DEFAULT_EMBEDDING_MODEL, embedding_dimensions: dim, reranker_model: defaults.DEFAULT_RERANKER_MODEL, env: { VOYAGE_API_KEY: 'stub', OPENAI_API_KEY: 'stub' } });
  gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(t => randomUnitVector(t, dim)), values: params.values, warnings: [] }));
  gateway.__setRerankTransportForTests(makeOverlapRerankTransport());
  return {
    embedding_model: defaults.DEFAULT_EMBEDDING_MODEL,
    embedding_dim: dim,
    reranker_model: defaults.DEFAULT_RERANKER_MODEL,
    reset: () => {
      gateway.__setEmbedTransportForTests(null);
      gateway.__setRerankTransportForTests(null);
    },
  };
}

export type ScaleTarget = { kind: 'pglite' } | { kind: 'postgres'; url: string; poolMax?: number };

/** The search setting of the real brain, as live-recall batch 2's counted scorecard records it. */
export const REAL_SEARCH_CONFIG = { 'search.mode': 'tokenmax', 'search.reranker.model': 'voyage:rerank-2.5' } as const;

/** Connect, initialise the schema at the gateway's width and write REAL_SEARCH_CONFIG. Call useScaleTransports first. */
export async function openScaleEngine(gut: GbrainUnderTest, target: ScaleTarget): Promise<any> {
  let engine: any;
  if (target.kind === 'pglite') {
    const { PGLiteEngine } = await importGbrain<any>(gut, 'src/core/pglite-engine.ts');
    engine = new PGLiteEngine();
    await engine.connect({});
  } else {
    const { createEngine } = await importGbrain<any>(gut, 'src/core/engine-factory.ts');
    const config = { engine: 'postgres', database_url: target.url, pool_max: target.poolMax ?? 8 };
    engine = await createEngine(config);
    await engine.connect(config);
  }
  await engine.initSchema();
  for (const [key, value] of Object.entries(REAL_SEARCH_CONFIG)) await engine.setConfig(key, value);
  return engine;
}

export interface Checkpoint {
  schema: typeof BUILD_SCHEMA;
  seed: number;
  pages_target: number;
  batch_size: number;
  embedding_dim: number;
  gbrain_version: string;
  /** Index of the last batch fully loaded; -1 before the first. */
  last_batch: number;
  pages_loaded: number;
  updated_at: string;
}

export function readCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  const c = JSON.parse(readFileSync(path, 'utf8')) as Checkpoint;
  if (c.schema !== BUILD_SCHEMA || !Number.isInteger(c.last_batch)) throw new Error(`checkpoint ${path} is not a ${BUILD_SCHEMA} file; move it aside to start a new build`);
  return c;
}

function writeCheckpoint(path: string, c: Checkpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(c, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}

export interface BuildOptions {
  gut: GbrainUnderTest;
  engine: any;
  pages: number;
  embeddingDim: number;
  checkpointPath: string;
  seed?: number;
  batchSize?: number;
  /** Pages imported at once inside a batch; keep 1 on PGLite (one connection). */
  concurrency?: number;
  /** Stop after this many batches in this call (tests use it to cut a build short). */
  maxBatches?: number;
  log?: (line: string) => void;
}

export interface BuildResult { pages_loaded: number; batches_run: number; resumed_from_batch: number; complete: boolean; ms: number }

/** Load pages [0, pages) in batches, resuming after the checkpoint's last batch. */
export async function buildScaleBrain(o: BuildOptions): Promise<BuildResult> {
  const seed = o.seed ?? DEFAULT_SEED;
  const batchSize = o.batchSize ?? DEFAULT_BATCH;
  const concurrency = Math.max(1, o.concurrency ?? 1);
  const started = performance.now();
  const { importFromContent } = await importGbrain<any>(o.gut, 'src/core/import-file.ts');
  const { assertEmbedded } = await import('../../import-embedded.ts');
  const previous = readCheckpoint(o.checkpointPath);
  if (previous && (previous.seed !== seed || previous.pages_target !== o.pages || previous.batch_size !== batchSize || previous.embedding_dim !== o.embeddingDim)) {
    throw new Error(`checkpoint ${o.checkpointPath} is for seed ${previous.seed}, ${previous.pages_target} pages, batch ${previous.batch_size}, width ${previous.embedding_dim}; this build asks for seed ${seed}, ${o.pages} pages, batch ${batchSize}, width ${o.embeddingDim}. Rerun with its settings or move it aside.`);
  }
  const batches = Math.ceil(o.pages / batchSize);
  const first = (previous?.last_batch ?? -1) + 1;
  let run = 0;
  for (let b = first; b < batches && (o.maxBatches === undefined || run < o.maxBatches); b++, run++) {
    const end = Math.min(o.pages, (b + 1) * batchSize);
    for (let i = b * batchSize; i < end; i += concurrency) {
      await Promise.all(Array.from({ length: Math.min(concurrency, end - i) }, async (_, k) => {
        const page = scalePage(seed, i + k);
        assertEmbedded(await importFromContent(o.engine, page.slug, page.markdown, { noEmbed: false }), page.slug);
      }));
    }
    writeCheckpoint(o.checkpointPath, { schema: BUILD_SCHEMA, seed, pages_target: o.pages, batch_size: batchSize, embedding_dim: o.embeddingDim, gbrain_version: o.gut.version, last_batch: b, pages_loaded: end, updated_at: new Date().toISOString() });
    o.log?.(`batch ${b + 1}/${batches}: ${end} pages loaded`);
  }
  const done = readCheckpoint(o.checkpointPath);
  return { pages_loaded: done?.pages_loaded ?? 0, batches_run: run, resumed_from_batch: first, complete: (done?.last_batch ?? -1) === batches - 1, ms: Math.round(performance.now() - started) };
}

export function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The Postgres URL named by --database-url-env, read once and removed from the environment. */
export function takeDatabaseUrl(argv: readonly string[]): string {
  const name = flag(argv, '--database-url-env') ?? 'SCALE_LATENCY_DATABASE_URL';
  const url = process.env[name];
  if (!url) throw new Error(`--database-url-env names ${/^[A-Z0-9_]+$/.test(name) ? name : 'a variable'}, which is empty; set it to a scratch Postgres database with pgvector`);
  delete process.env[name];
  return url;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const url = takeDatabaseUrl(argv);
  const checkpointPath = flag(argv, '--checkpoint');
  if (!checkpointPath) throw new Error('--checkpoint <path> is required, so a rerun can resume');
  const concurrency = Number(flag(argv, '--concurrency') ?? 8);
  const result = await withHermeticEnv('scale-latency-build', async () => {
    const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
    const transports = await useScaleTransports(gut);
    const engine = await openScaleEngine(gut, { kind: 'postgres', url, poolMax: concurrency + 2 });
    try {
      return await buildScaleBrain({
        gut, engine, checkpointPath, concurrency,
        pages: Number(flag(argv, '--pages') ?? DEFAULT_PAGES),
        embeddingDim: transports.embedding_dim,
        seed: Number(flag(argv, '--seed') ?? DEFAULT_SEED),
        batchSize: Number(flag(argv, '--batch') ?? DEFAULT_BATCH),
        log: line => process.stderr.write(`scale-latency build: ${line}\n`),
      });
    } finally {
      transports.reset();
      await engine.disconnect();
    }
  });
  console.log(JSON.stringify(result));
}
