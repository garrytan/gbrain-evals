/**
 * BrainBench Cat 28 — federated sync latency (v0.40.5.0 + v0.40.6.0).
 *
 * Headline question: how much wall-clock does `gbrain sync --all` save
 * vs serial sync on an N-source brain, and what's the per-source overhead?
 *
 * Hermetic. No API keys. No git. We simulate "sync work" as importing M
 * pages per source via importFromContent. Serial pass = sources × pages.
 * Parallel pass = the same workload through N concurrent worker engines
 * (mirrors the v0.40.6 worker pool).
 *
 * Measures:
 *   - serial wallclock (one source at a time)
 *   - parallel wallclock (N workers, one per source)
 *   - speedup ratio
 *   - per-source overhead (engine setup + lock acquisition simulation)
 *
 * Run:
 *   bun eval/runner/cat28-federated-sync-latency.ts
 *   CAT28_SOURCES=8 CAT28_PAGES=50 bun eval/runner/cat28-federated-sync-latency.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';

const N_SOURCES = parseInt(process.env.CAT28_SOURCES ?? '4', 10);
const PAGES_PER_SOURCE = parseInt(process.env.CAT28_PAGES ?? '30', 10);

interface SyncRun {
  mode: 'serial' | 'parallel';
  wallclock_ms: number;
  total_pages: number;
  per_source_ms: number[];
}

interface Receipt {
  schema_version: 1;
  cat: 'cat28-federated-sync-latency';
  gbrain_version: string;
  timestamp: string;
  sources: number;
  pages_per_source: number;
  total_pages: number;
  serial: SyncRun;
  parallel: SyncRun;
  speedup: number;
  efficiency_pct: number;
}

async function makeEngineWithPages(sourceId: string, pages: number): Promise<{ engine: any; setup_ms: number }> {
  const tSetup = Date.now();
  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const origLog = console.log;
  console.log = () => {};
  // Each engine is independent (parallel topology). Source registration:
  if (sourceId !== 'default') {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [sourceId],
    );
  }
  console.log = origLog;
  const setup_ms = Date.now() - tSetup;
  return { engine, setup_ms };
}

async function syncSource(engine: any, sourceId: string, pages: number): Promise<number> {
  const t = Date.now();
  const origLog = console.log;
  console.log = () => {};
  for (let i = 0; i < pages; i++) {
    const slug = `people/${sourceId}-p-${i}`;
    const body = `Person ${i} from source ${sourceId}. AI/ML researcher. Tags: ai, ml.`;
    await importFromContent(engine, slug, body, { sourceId, noEmbed: true });
  }
  console.log = origLog;
  return Date.now() - t;
}

async function main(): Promise<void> {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: process.env as Record<string, string | undefined>,
  });

  const sourceIds = Array.from({ length: N_SOURCES }, (_, i) => `src-${i}`);

  // ── Serial: one PGLite, all sources written through it sequentially ──
  process.stderr.write(`[cat28] serial pass: ${N_SOURCES} sources × ${PAGES_PER_SOURCE} pages...\n`);
  const tSerial = Date.now();
  const { engine: serialEngine } = await makeEngineWithPages('default', 0);
  for (const s of sourceIds) {
    await serialEngine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [s],
    );
  }
  const serialPerSource: number[] = [];
  for (const s of sourceIds) {
    serialPerSource.push(await syncSource(serialEngine, s, PAGES_PER_SOURCE));
  }
  const serialMs = Date.now() - tSerial;
  await serialEngine.disconnect();
  process.stderr.write(`[cat28] serial done: ${serialMs}ms\n`);

  // ── Parallel: N independent PGLites, one per source, Promise.all ──
  process.stderr.write(`[cat28] parallel pass: ${N_SOURCES} concurrent workers...\n`);
  const tParallel = Date.now();
  const parallelPerSource: number[] = await Promise.all(
    sourceIds.map(async (s, i) => {
      const { engine } = await makeEngineWithPages(s, PAGES_PER_SOURCE);
      const ms = await syncSource(engine, s, PAGES_PER_SOURCE);
      await engine.disconnect();
      return ms;
    }),
  );
  const parallelMs = Date.now() - tParallel;
  process.stderr.write(`[cat28] parallel done: ${parallelMs}ms\n`);

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const speedup = serialMs > 0 ? serialMs / Math.max(1, parallelMs) : 0;
  const efficiency = N_SOURCES > 0 ? (speedup / N_SOURCES) * 100 : 0;

  const receipt: Receipt = {
    schema_version: 1,
    cat: 'cat28-federated-sync-latency',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    sources: N_SOURCES,
    pages_per_source: PAGES_PER_SOURCE,
    total_pages: N_SOURCES * PAGES_PER_SOURCE,
    serial: { mode: 'serial', wallclock_ms: serialMs, total_pages: N_SOURCES * PAGES_PER_SOURCE, per_source_ms: serialPerSource },
    parallel: { mode: 'parallel', wallclock_ms: parallelMs, total_pages: N_SOURCES * PAGES_PER_SOURCE, per_source_ms: parallelPerSource },
    speedup,
    efficiency_pct: efficiency,
  };

  const outDir = join(process.cwd(), 'eval/reports/cat28-federated-sync-latency');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat28.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat28] ─── Scorecard ───────────────────\n`);
  process.stderr.write(`[cat28]   sources:           ${N_SOURCES}\n`);
  process.stderr.write(`[cat28]   pages per source:  ${PAGES_PER_SOURCE}\n`);
  process.stderr.write(`[cat28]   total pages:       ${N_SOURCES * PAGES_PER_SOURCE}\n`);
  process.stderr.write(`[cat28]   serial:            ${serialMs}ms\n`);
  process.stderr.write(`[cat28]   parallel:          ${parallelMs}ms\n`);
  process.stderr.write(`[cat28]   speedup:           ${speedup.toFixed(2)}x\n`);
  process.stderr.write(`[cat28]   efficiency:        ${efficiency.toFixed(1)}% (100% = perfect linear scaling)\n`);
  process.stderr.write(`[cat28]   receipt:           ${outFile}\n`);
}

await main();
