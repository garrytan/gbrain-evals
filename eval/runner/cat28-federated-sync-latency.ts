/**
 * BrainBench Cat 28 — federated import engine-overhead microbenchmark.
 *
 * HONEST SCOPE (audit cats26-29-07, pre-adjudicated relabel): this is a
 * SINGLE-THREAD serialization microbenchmark, NOT a worker-pool speedup
 * measurement. PGLite executes its WASM synchronously on the calling
 * thread, so the "concurrent" pass (N in-process engines driven via
 * Promise.all) interleaves CPU-bound work on ONE event-loop thread. The
 * ratio it reports measures per-engine setup amortization + event-loop
 * interleaving overhead of the N-engine topology — it says NOTHING about
 * the v0.40.6 worker pool, and 100%-linear-scaling framing would be a lie.
 * A real worker-thread benchmark is future work; until then the receipt
 * fields are named for what was measured.
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: gbrain's importFromContent write path (markdown parse, chunk,
 * page + chunk upserts) against PGLite, in two topologies: one shared
 * engine written serially vs N independent engines driven concurrently on
 * the same thread. Embeds are skipped (noEmbed: true) so the workload is
 * pure engine/serialization cost — no network, no keys, fully hermetic.
 * LEGITIMATELY SEEDED/STUBBED: the synthetic page bodies. Search is not
 * exercised at all, so WS5 search-mode pinning does not apply (recorded in
 * resolved_config as search: 'not exercised').
 *
 * ── Measurement discipline (audit cats26-29-08) ──────────────────────
 * - One warmup engine (connect + initSchema + a few imports) runs and is
 *   discarded BEFORE any timer starts, so WASM compile/JIT one-time costs
 *   never land in a measured pass.
 * - Each mode runs R repetitions (default 3, CAT28_REPS) with INTERLEAVED
 *   order (rep 0: serial→concurrent, rep 1: concurrent→serial, ...) so
 *   neither mode systematically runs first/warmer.
 * - Reported stats are median + p95 via metrics.ts percentile, never a
 *   single sample.
 * - Every pass verifies the imported page counts (audit cats26-29-09: the
 *   old runner discarded setup_ms and never checked the work happened);
 *   setup_ms per engine is recorded in the receipt.
 *
 * ── Verdict (real + failable) ────────────────────────────────────────
 * pass — every rep of both modes completed AND every pass's verified page
 *        count equals sources × pages_per_source.
 * fail — any pass errored or imported the wrong number of pages. Exit code
 *        is non-zero unless verdict === 'pass'.
 *
 * Run (no API keys needed):
 *   bun eval/runner/cat28-federated-sync-latency.ts
 *   CAT28_SOURCES=8 CAT28_PAGES=50 CAT28_REPS=5 bun eval/runner/cat28-federated-sync-latency.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { percentile } from './metrics.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';

export const CAT28_CATEGORY = 'cat28-federated-sync-latency';

export type Cat28Mode = 'serial' | 'concurrent_single_thread';

/** Injectable import for failability tests. Same shape as importFromContent's use here. */
export type ImportFn = (
  engine: any,
  slug: string,
  body: string,
  opts: { sourceId: string; noEmbed: boolean },
) => Promise<unknown>;

export interface PassResult {
  mode: Cat28Mode;
  rep: number;
  /** Position of this pass within its rep (0 = ran first). Interleaving evidence. */
  order_in_rep: number;
  wallclock_ms: number;
  per_source_ms: number[];
  /** Engine connect + initSchema (+ source registration) cost, one entry per engine. */
  setup_ms: number[];
  pages_verified: number;
  pages_expected: number;
  ok: boolean;
  error?: string;
}

export interface ModeStats {
  mode: Cat28Mode;
  reps: number;
  wallclock_ms_median: number;
  wallclock_ms_p95: number;
  wallclock_ms_all: number[];
  per_source_ms_p50: number;
  per_source_ms_p95: number;
  setup_ms_p50: number;
  setup_ms_p95: number;
}

async function makeEngine(sourceIds: string[]): Promise<{ engine: any; setup_ms: number }> {
  const tSetup = Date.now();
  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const s of sourceIds) {
    if (s === 'default') continue;
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [s],
    );
  }
  return { engine, setup_ms: Date.now() - tSetup };
}

async function syncSource(engine: any, sourceId: string, pages: number, importFn: ImportFn): Promise<number> {
  const t = Date.now();
  for (let i = 0; i < pages; i++) {
    const slug = `people/${sourceId}-p-${i}`;
    const body = `Person ${i} from source ${sourceId}. AI/ML researcher. Tags: ai, ml.`;
    await importFn(engine, slug, body, { sourceId, noEmbed: true });
  }
  return Date.now() - t;
}

async function countPages(engine: any): Promise<number> {
  const rows = await engine.executeRaw(`SELECT COUNT(*)::int AS n FROM pages`, []) as any[];
  return rows[0]?.n ?? 0;
}

async function runSerialPass(sourceIds: string[], pagesPerSource: number, importFn: ImportFn): Promise<Omit<PassResult, 'rep' | 'order_in_rep' | 'ok' | 'error'>> {
  const expected = sourceIds.length * pagesPerSource;
  const t = Date.now();
  const { engine, setup_ms } = await makeEngine(sourceIds);
  try {
    const perSource: number[] = [];
    for (const s of sourceIds) {
      perSource.push(await syncSource(engine, s, pagesPerSource, importFn));
    }
    const wallclock = Date.now() - t;
    const verified = await countPages(engine);
    return {
      mode: 'serial',
      wallclock_ms: wallclock,
      per_source_ms: perSource,
      setup_ms: [setup_ms],
      pages_verified: verified,
      pages_expected: expected,
    };
  } finally {
    try { await engine.disconnect(); } catch { /* already dead */ }
  }
}

async function runConcurrentPass(sourceIds: string[], pagesPerSource: number, importFn: ImportFn): Promise<Omit<PassResult, 'rep' | 'order_in_rep' | 'ok' | 'error'>> {
  const expected = sourceIds.length * pagesPerSource;
  const t = Date.now();
  const cells = await Promise.all(
    sourceIds.map(async (s) => {
      const { engine, setup_ms } = await makeEngine([s]);
      try {
        const ms = await syncSource(engine, s, pagesPerSource, importFn);
        const verified = await countPages(engine);
        return { ms, setup_ms, verified };
      } finally {
        try { await engine.disconnect(); } catch { /* already dead */ }
      }
    }),
  );
  const wallclock = Date.now() - t;
  return {
    mode: 'concurrent_single_thread',
    wallclock_ms: wallclock,
    per_source_ms: cells.map(c => c.ms),
    setup_ms: cells.map(c => c.setup_ms),
    pages_verified: cells.reduce((a, c) => a + c.verified, 0),
    pages_expected: expected,
  };
}

export function modeStats(passes: PassResult[], mode: Cat28Mode): ModeStats {
  const rows = passes.filter(p => p.mode === mode && p.ok);
  const wall = rows.map(p => p.wallclock_ms);
  const perSource = rows.flatMap(p => p.per_source_ms);
  const setup = rows.flatMap(p => p.setup_ms);
  return {
    mode,
    reps: rows.length,
    wallclock_ms_median: percentile(wall, 50),
    wallclock_ms_p95: percentile(wall, 95),
    wallclock_ms_all: wall,
    per_source_ms_p50: percentile(perSource, 50),
    per_source_ms_p95: percentile(perSource, 95),
    setup_ms_p50: percentile(setup, 50),
    setup_ms_p95: percentile(setup, 95),
  };
}

/**
 * The gate: every planned pass completed and verified its page count.
 * Failable — an import error or a wrong page count in ANY pass fails the run.
 */
export function computeVerdict(passes: PassResult[], expectedPasses: number): 'pass' | 'fail' {
  if (passes.length < expectedPasses) return 'fail';
  return passes.every(p => p.ok && p.pages_verified === p.pages_expected) ? 'pass' : 'fail';
}

export interface Cat28Options {
  sources?: number;
  pagesPerSource?: number;
  reps?: number;
  warmup?: boolean;
  reportsDir?: string;
  quiet?: boolean;
  /** Failability hook: replace importFromContent (e.g. throw on a chosen slug). */
  importFn?: ImportFn;
}

export interface Cat28RunResult {
  receipt: Receipt;
  passes: PassResult[];
  exitCode: number;
  receiptFile: string;
}

export function optionsFromEnv(): Cat28Options {
  return {
    sources: parseInt(process.env.CAT28_SOURCES ?? '4', 10),
    pagesPerSource: parseInt(process.env.CAT28_PAGES ?? '30', 10),
    reps: parseInt(process.env.CAT28_REPS ?? '3', 10),
  };
}

export async function runCat28(options: Cat28Options = {}): Promise<Cat28RunResult> {
  const startedAt = new Date().toISOString();
  const nSources = options.sources ?? 4;
  const pagesPerSource = options.pagesPerSource ?? 30;
  const reps = Math.max(1, options.reps ?? 3);
  const doWarmup = options.warmup !== false;
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT28_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);
  const importFn: ImportFn = options.importFn
    ?? ((engine, slug, body, opts) => importFromContent(engine, slug, body, opts));

  // initSchema resolves embedding dims through the gateway even when the
  // workload never embeds (noEmbed: true) — configure it with env passthrough.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: process.env as Record<string, string | undefined>,
  });

  const sourceIds = Array.from({ length: nSources }, (_, i) => `src-${i}`);

  const origLog = console.log;
  console.log = () => {}; // initSchema/import are chatty
  const passes: PassResult[] = [];
  // Each mode-rep is one accounting probe.
  const acc = new ProbeAccounting(reps * 2);
  try {
    // ── Warmup: absorb WASM instantiation + first-initSchema + JIT costs ──
    if (doWarmup) {
      log(`[cat28] warmup engine (untimed)...\n`);
      const warm = await runSerialPass(['src-warmup'], Math.min(3, pagesPerSource), importFn);
      log(`[cat28] warmup done (${warm.wallclock_ms}ms, discarded)\n`);
    }

    for (let rep = 0; rep < reps; rep++) {
      // Interleave: even reps run serial first, odd reps concurrent first,
      // so neither mode systematically benefits from running second/warmer.
      const order: Cat28Mode[] = rep % 2 === 0
        ? ['serial', 'concurrent_single_thread']
        : ['concurrent_single_thread', 'serial'];
      for (let pos = 0; pos < order.length; pos++) {
        const mode = order[pos];
        const probeId = `${mode}-rep${rep}`;
        log(`[cat28] rep ${rep + 1}/${reps} ${mode}: ${nSources} sources × ${pagesPerSource} pages...\n`);
        try {
          const r = mode === 'serial'
            ? await runSerialPass(sourceIds, pagesPerSource, importFn)
            : await runConcurrentPass(sourceIds, pagesPerSource, importFn);
          const ok = r.pages_verified === r.pages_expected;
          passes.push({ ...r, rep, order_in_rep: pos, ok, ...(ok ? {} : { error: `page count mismatch: ${r.pages_verified} != ${r.pages_expected}` }) });
          if (ok) {
            acc.score(probeId, 1);
          } else {
            acc.error(probeId, 'sut', `page count mismatch: ${r.pages_verified} != ${r.pages_expected}`);
          }
          log(`[cat28]   ${r.wallclock_ms}ms (${r.pages_verified}/${r.pages_expected} pages verified)\n`);
        } catch (e: any) {
          acc.error(probeId, 'sut', String(e?.message ?? e));
          passes.push({
            mode, rep, order_in_rep: pos, wallclock_ms: -1, per_source_ms: [], setup_ms: [],
            pages_verified: 0, pages_expected: nSources * pagesPerSource, ok: false,
            error: String(e?.message ?? e),
          });
          log(`[cat28]   ERROR (sut): ${e?.message ?? e}\n`);
        }
      }
    }
  } finally {
    console.log = origLog;
  }

  const serial = modeStats(passes, 'serial');
  const concurrent = modeStats(passes, 'concurrent_single_thread');
  // Honest name: single-thread interleaving ratio, NOT worker-pool speedup.
  // > 1 means the N-engine concurrent topology finished faster than one
  // shared engine written serially (setup amortization + I/O interleaving);
  // it does NOT indicate parallel CPU execution.
  const interleavingRatio = Number.isFinite(serial.wallclock_ms_median) && Number.isFinite(concurrent.wallclock_ms_median) && concurrent.wallclock_ms_median > 0
    ? serial.wallclock_ms_median / concurrent.wallclock_ms_median
    : NaN;

  const verdict = computeVerdict(passes, reps * 2);
  const summary = acc.summary();

  const receipt: Receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT28_CATEGORY,
    run_status: 'completed',
    verdict,
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable && !options.importFn,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      workload: 'importFromContent noEmbed:true (engine write path only)',
      threading: 'single_event_loop_thread (PGLite WASM runs on the calling thread; NOT a worker pool)',
      search: 'not exercised',
      sources: nSources,
      pages_per_source: pagesPerSource,
      reps,
      warmup: doWarmup,
      order_interleaved: true,
    },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      passes,
      serial,
      concurrent_single_thread: concurrent,
      single_thread_interleaving_ratio: Number.isFinite(interleavingRatio) ? interleavingRatio : null,
      ratio_caveat: 'serial_median / concurrent_median on ONE thread — engine-overhead microbenchmark, not worker-pool speedup',
    },
  };
  writeReceipt(receiptFile, receipt);

  const outDir = join(reportsDir, CAT28_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat28.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat28] ─── Scorecard (single-thread microbenchmark) ───\n`);
  log(`[cat28]   sources × pages:   ${nSources} × ${pagesPerSource}, reps=${reps}, warmup=${doWarmup}\n`);
  log(`[cat28]   serial:            median ${serial.wallclock_ms_median}ms  p95 ${serial.wallclock_ms_p95}ms  (all: ${serial.wallclock_ms_all.join(', ')})\n`);
  log(`[cat28]   concurrent (1 thread): median ${concurrent.wallclock_ms_median}ms  p95 ${concurrent.wallclock_ms_p95}ms  (all: ${concurrent.wallclock_ms_all.join(', ')})\n`);
  log(`[cat28]   interleaving ratio: ${Number.isFinite(interleavingRatio) ? interleavingRatio.toFixed(2) : 'n/a'}x (NOT worker-pool speedup)\n`);
  log(`[cat28]   setup p50/p95:     serial ${serial.setup_ms_p50}/${serial.setup_ms_p95}ms, concurrent ${concurrent.setup_ms_p50}/${concurrent.setup_ms_p95}ms per engine\n`);
  log(`[cat28]   verdict:           ${verdict}\n`);
  log(`[cat28]   receipt:           ${receiptFile}\n`);

  const exitCode = summary.run_invalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, passes, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat28(optionsFromEnv());
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT28_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT28_CATEGORY,
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
    process.stderr.write(`[cat28] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
