#!/usr/bin/env bun
/**
 * Scale-latency probe (GBEV-55 G5): p50 and p95 latency of gbrain's agent-facing
 * operations on a brain built by build.ts, and the count of keyword statement
 * timeouts that search fell open on.
 *
 *   bun eval/runner/predictive/scale-latency/probe.ts --database-url-env SCALE_LATENCY_DATABASE_URL \
 *     --checkpoint <dir>/checkpoint.json --out <dir>/scorecard.json [--n 200] [--sync-n 30] [--warmup 3]
 *   bun eval/runner/predictive/scale-latency/probe.ts --pglite --pages 500 --out <file>   (keyless smoke)
 *
 * Every call goes through gbrain's own MCP dispatcher (src/mcp/dispatch.ts,
 * dispatchToolCall), the path an agent's tool call takes: query, search,
 * get (get_page), entity, recall and remember as a remote stdio caller, and sync
 * (sync_brain, local only) as the local caller, in the source gbrain's stdio
 * server resolves (resolveMcpStdioSourceScope). Calls run inside gbrain's AI
 * invocation guard, which allows embedding and rerank calls only; build.ts's
 * in-process transports answer those, so the probe never reaches a provider and
 * its numbers carry no provider latency. A refused call kind is counted.
 *
 * Reads and remember interleave round-robin, n timed calls each after the warmup.
 * Sync times one incremental sync of one new note in a scratch git repository,
 * after an untimed first sync. Arguments come from the seeded page generator, so
 * a probe with the same seed asks the same questions.
 *
 * A statement-timeout fall-open is a retrieval meta degraded entry
 * keyword_arm_failed with reason timeout or skipped_after_timeout: gbrain's
 * Postgres keyword arm hit search.keyword_statement_timeout_ms (or skipped a
 * statement that recently did) and the search answered from the vector arm.
 *
 * The calibration block compares p50 and p95 with Wintermute's counted latencies
 * and says whether each is within a factor of 2. It is calibration only (gate
 * change D1): the predictive test is one preregistered held-out latency contrast.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Rng } from '../../../generators/seeded.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from '../../gbrain-under-test.ts';
import { withHermeticEnv } from '../../hermetic-env.ts';
import { percentile } from '../../metrics.ts';
import { DEFAULT_SEED, buildScaleBrain, flag, openScaleEngine, readCheckpoint, scalePage, seedOf, takeDatabaseUrl, useScaleTransports, type ScaleTransports } from './build.ts';

export const SCORECARD_SCHEMA = 'gbrain-evals/scale-latency-scorecard/v1';
export const OPS = ['query', 'search', 'get', 'entity', 'recall', 'remember', 'sync'] as const;
export type Op = (typeof OPS)[number];
const TOOL: Record<Op, string> = { query: 'query', search: 'search', get: 'get_page', entity: 'entity', recall: 'recall', remember: 'remember', sync: 'sync_brain' };
const ROUND_ROBIN: Op[] = ['query', 'search', 'get', 'entity', 'recall', 'remember'];

/** Wintermute's counted p50 and p95 per operation, in milliseconds (calibration reference; entity and recall have none). */
export const WINTERMUTE_COUNTED: Partial<Record<Op, { p50_ms: number; p95_ms: number }>> = {
  query: { p50_ms: 10_100, p95_ms: 30_100 },
  search: { p50_ms: 9_800, p95_ms: 30_400 },
  get: { p50_ms: 2_800, p95_ms: 10_900 },
  remember: { p50_ms: 8_200, p95_ms: 42_700 },
  sync: { p50_ms: 3_700, p95_ms: 120_000 },
};
export const CALIBRATION_FACTOR = 2;
const FALL_OPEN_REASONS = new Set(['timeout', 'skipped_after_timeout']);

export interface OpStats { n: number; p50_ms: number | null; p95_ms: number | null; errors: number }
export interface CalibrationRow { ref_p50_ms: number; ref_p95_ms: number; p50_ratio: number | null; p95_ratio: number | null; within_factor: boolean | null }
export interface Calibration {
  role: 'calibration_only';
  reference: 'wintermute_counted';
  factor: number;
  provider_latency: 'not_included';
  ops: Record<Op, CalibrationRow | null>;
  within_factor_all: boolean | null;
}
export interface Scorecard {
  schema: typeof SCORECARD_SCHEMA;
  pages: number;
  chunks: number;
  embedding_dim: number;
  embedding_model: string;
  gbrain_version: string;
  engine: 'pglite' | 'postgres';
  search_config: { resolved_mode: string; reranker_enabled: boolean; reranker_model: string; expansion: boolean; keyword_statement_timeout_ms: number | null };
  transports: 'stub_in_process';
  seed: number;
  warmup: number;
  ops: Record<Op, OpStats>;
  statement_timeout_fall_opens: number;
  fall_opens_by_op: Partial<Record<Op, number>>;
  degraded_stages: Record<string, number>;
  ai_refused: Record<string, number>;
  calibration: Calibration;
}

/** Statement-timeout fall-opens in one call's retrieval meta. */
export function countFallOpens(meta: unknown): number {
  const degraded = (meta as { degraded?: Array<{ stage?: unknown; reason?: unknown }> } | null)?.degraded ?? [];
  return degraded.filter(d => d?.stage === 'keyword_arm_failed' && FALL_OPEN_REASONS.has(String(d.reason))).length;
}

export function opStats(samples: number[], errors: number): OpStats {
  const round = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
  return { n: samples.length, p50_ms: round(percentile(samples, 50)), p95_ms: round(percentile(samples, 95)), errors };
}

/** Compare each op's p50 and p95 with Wintermute's counted values; within means a ratio in [1/factor, factor]. */
export function calibrate(ops: Record<Op, OpStats>, factor = CALIBRATION_FACTOR): Calibration {
  const within = (r: number | null) => (r === null ? null : r >= 1 / factor && r <= factor);
  const rows = Object.fromEntries(OPS.map(op => {
    const ref = WINTERMUTE_COUNTED[op];
    if (!ref) return [op, null];
    const s = ops[op];
    const p50 = s.p50_ms === null ? null : s.p50_ms / ref.p50_ms;
    const p95 = s.p95_ms === null ? null : s.p95_ms / ref.p95_ms;
    const w50 = within(p50), w95 = within(p95);
    return [op, { ref_p50_ms: ref.p50_ms, ref_p95_ms: ref.p95_ms, p50_ratio: p50, p95_ratio: p95, within_factor: w50 === null || w95 === null ? null : w50 && w95 }];
  })) as Record<Op, CalibrationRow | null>;
  const verdicts = Object.values(rows).filter((r): r is CalibrationRow => r !== null).map(r => r.within_factor);
  return { role: 'calibration_only', reference: 'wintermute_counted', factor, provider_latency: 'not_included', ops: rows, within_factor_all: verdicts.includes(null) ? null : verdicts.every(Boolean) };
}

/** A person page among the first pagesLoaded, chosen by rng (falls back to page 0 after 200 draws). */
function personPage(rng: Rng, seed: number, pagesLoaded: number) {
  for (let tries = 0; tries < 200; tries++) {
    const p = scalePage(seed, rng.int(0, pagesLoaded - 1));
    if (p.type === 'person') return p;
  }
  return scalePage(seed, 0);
}

/** The arguments for call k of op: fictional, seeded, and naming pages the build loaded. */
export function probeArgs(op: Exclude<Op, 'sync'>, k: number, seed: number, pagesLoaded: number): Record<string, unknown> {
  const rng = new Rng(seedOf('probe', seed, op, k));
  const page = scalePage(seed, rng.int(0, pagesLoaded - 1));
  const words = page.markdown.split('\n---\n')[1].split(/[^A-Za-z]+/).filter(w => w.length > 3).map(w => w.toLowerCase());
  const w = () => words.length ? rng.pick(words) : 'note';
  switch (op) {
    case 'query': return { query: `What did ${page.title} say about ${w()} and ${w()}?` };
    case 'search': return { query: `${w()} ${w()}` };
    case 'get': return { slug: page.slug };
    case 'entity': return { name: personPage(rng, seed, pagesLoaded).title };
    case 'recall': return { entity: personPage(rng, seed, pagesLoaded).slug };
    case 'remember': {
      const person = personPage(rng, seed, pagesLoaded);
      return { fact: `${person.title} prefers ${w()} over ${w()} (probe note ${k}).`, entity: person.slug, provenance: 'scale-latency probe, synthetic' };
    }
  }
}

export interface ProbeOptions {
  gut: GbrainUnderTest;
  engine: any;
  engineKind: 'pglite' | 'postgres';
  transports: ScaleTransports;
  pagesLoaded: number;
  seed?: number;
  /** Timed calls per operation (sync uses syncN). */
  n?: number;
  syncN?: number;
  /** Untimed calls per operation before timing starts. */
  warmup?: number;
}

export async function probeLatency(o: ProbeOptions): Promise<Scorecard> {
  const seed = o.seed ?? DEFAULT_SEED;
  const n = o.n ?? 50;
  const syncN = o.syncN ?? Math.min(n, 20);
  const warmup = o.warmup ?? 2;
  const [dispatch, invocation, mode, server] = await Promise.all([
    importGbrain<any>(o.gut, 'src/mcp/dispatch.ts'), importGbrain<any>(o.gut, 'src/core/ai/invocation-guard.ts'), importGbrain<any>(o.gut, 'src/core/search/mode.ts'), importGbrain<any>(o.gut, 'src/mcp/server.ts'),
  ]);
  const sourceId = String((await server.resolveMcpStdioSourceScope(o.engine))?.sourceId ?? 'default');
  const knobs = mode.resolveSearchMode(await mode.loadSearchModeConfig(o.engine));
  let keywordTimeout: number | null = null;
  if (o.engineKind === 'postgres') {
    const kst = await importGbrain<any>(o.gut, 'src/core/postgres-engine/keyword-statement-timeout.ts');
    keywordTimeout = Number(await o.engine.getConfig(kst.KEYWORD_STATEMENT_TIMEOUT_KEY)) || kst.KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS;
  }

  const samples = Object.fromEntries(OPS.map(op => [op, [] as number[]])) as Record<Op, number[]>;
  const errors = Object.fromEntries(OPS.map(op => [op, 0])) as Record<Op, number>;
  const fallOpensByOp: Partial<Record<Op, number>> = {};
  const degradedStages: Record<string, number> = {};
  const aiRefused: Record<string, number> = {};

  const call = async (op: Op, params: Record<string, unknown>, timed: boolean) => {
    let meta: unknown = null;
    const metaHook = async (_name: string, ctx: { emitResponseMeta?: (k: string, v: unknown) => void }) => {
      const previous = ctx.emitResponseMeta;
      ctx.emitResponseMeta = (k, v) => { if (k === 'retrieval') meta = v; previous?.(k, v); };
      return undefined;
    };
    const guard = async (c: { kind: string }) => {
      if (c.kind !== 'embedding' && c.kind !== 'rerank') { aiRefused[c.kind] = (aiRefused[c.kind] ?? 0) + 1; throw new Error('scale-latency probe refused a ' + c.kind + ' call'); }
      return { settle: async () => {} };
    };
    const remote = op !== 'sync';
    const t0 = performance.now();
    let failed: boolean;
    try {
      const r = await invocation.withAIInvocationGuard(guard, () => dispatch.dispatchToolCall(o.engine, TOOL[op], params, { remote, transport: 'stdio', sourceId, metaHook }));
      failed = r?.isError === true;
    } catch {
      failed = true;
    }
    const ms = performance.now() - t0;
    if (!timed) return;
    if (failed) errors[op]++;
    else samples[op].push(ms);
    for (const d of ((meta as { degraded?: Array<{ stage?: unknown }> } | null)?.degraded ?? [])) degradedStages[String(d?.stage)] = (degradedStages[String(d?.stage)] ?? 0) + 1;
    const f = countFallOpens(meta);
    if (f) fallOpensByOp[op] = (fallOpensByOp[op] ?? 0) + f;
  };

  for (let k = 0; k < warmup + n; k++) {
    for (const op of ROUND_ROBIN) await call(op, probeArgs(op as Exclude<Op, 'sync'>, k, seed, o.pagesLoaded), k >= warmup);
  }

  const repo = mkdtempSync(join(tmpdir(), 'scale-latency-sync-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const commitNote = (k: number) => {
      const page = scalePage(seed + 1, k);
      mkdirSync(join(repo, 'sync-probe'), { recursive: true });
      writeFileSync(join(repo, 'sync-probe', `note-${k}.md`), page.markdown.replace(/^type: \w+$/m, 'type: note'));
      git('add', '-A');
      git('-c', 'user.name=Scale Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', `note ${k}`);
    };
    git('init', '-q');
    commitNote(0);
    await call('sync', { repo, no_pull: true }, false);
    for (let k = 1; k <= warmup + syncN; k++) {
      commitNote(k);
      await call('sync', { repo, no_pull: true }, k > warmup);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  const [counts] = await o.engine.executeRaw('SELECT (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int AS pages, (SELECT count(*) FROM content_chunks)::int AS chunks');
  const ops = Object.fromEntries(OPS.map(op => [op, opStats(samples[op], errors[op])])) as Record<Op, OpStats>;
  return {
    schema: SCORECARD_SCHEMA,
    pages: Number(counts.pages),
    chunks: Number(counts.chunks),
    embedding_dim: o.transports.embedding_dim,
    embedding_model: o.transports.embedding_model,
    gbrain_version: o.gut.version,
    engine: o.engineKind,
    search_config: { resolved_mode: String(knobs.resolved_mode), reranker_enabled: Boolean(knobs.reranker_enabled), reranker_model: String(knobs.reranker_model), expansion: Boolean(knobs.expansion), keyword_statement_timeout_ms: keywordTimeout },
    transports: 'stub_in_process',
    seed,
    warmup,
    ops,
    statement_timeout_fall_opens: Object.values(fallOpensByOp).reduce((s, x) => s + (x ?? 0), 0),
    fall_opens_by_op: fallOpensByOp,
    degraded_stages: degradedStages,
    ai_refused: aiRefused,
    calibration: calibrate(ops),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const out = flag(argv, '--out');
  if (!out) throw new Error('--out <scorecard.json> is required');
  const pglite = argv.includes('--pglite');
  const url = pglite ? null : takeDatabaseUrl(argv);
  const n = Number(flag(argv, '--n') ?? 200);
  const syncN = Number(flag(argv, '--sync-n') ?? 30);
  const warmup = Number(flag(argv, '--warmup') ?? 3);
  const scorecard = await withHermeticEnv('scale-latency-probe', async () => {
    const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
    const transports = await useScaleTransports(gut);
    const engine = await openScaleEngine(gut, url ? { kind: 'postgres', url, poolMax: 4 } : { kind: 'pglite' });
    try {
      let pagesLoaded: number, seed: number;
      if (pglite) {
        pagesLoaded = Number(flag(argv, '--pages') ?? 500);
        seed = Number(flag(argv, '--seed') ?? DEFAULT_SEED);
        const checkpointPath = join(mkdtempSync(join(tmpdir(), 'scale-latency-')), 'checkpoint.json');
        await buildScaleBrain({ gut, engine, pages: pagesLoaded, seed, embeddingDim: transports.embedding_dim, checkpointPath, batchSize: 250 });
      } else {
        const checkpoint = readCheckpoint(flag(argv, '--checkpoint') ?? '');
        if (!checkpoint || checkpoint.pages_loaded < checkpoint.pages_target) throw new Error('--checkpoint must name a finished build (build.ts writes it); rerun build.ts to finish the load first');
        pagesLoaded = checkpoint.pages_loaded;
        seed = checkpoint.seed;
      }
      return await probeLatency({ gut, engine, engineKind: url ? 'postgres' : 'pglite', transports, pagesLoaded, seed, n, syncN, warmup });
    } finally {
      transports.reset();
      await engine.disconnect();
    }
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(scorecard, null, 2) + '\n');
  console.log(JSON.stringify({ out, pages: scorecard.pages, ops: scorecard.ops, statement_timeout_fall_opens: scorecard.statement_timeout_fall_opens }));
}
