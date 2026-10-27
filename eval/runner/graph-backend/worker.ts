/**
 * Runs one (arm, tier, pass) of the graph-backend benchmark and appends one
 * NDJSON row per call. Resumable: calls already recorded for the same
 * (arm, tier, pass) in the output file are skipped.
 *
 *   A   gbrain old CTE walks (GB_ENGINE_DIR = worktree at b1fdcb843), Postgres
 *   B   gbrain breadth-first walks (GB_ENGINE_DIR = worktree at fc1121cae58), Postgres
 *   BL  B on PGLite (--db pglite:<dir>)
 *   C   HydraDB adapter, hydrating from Postgres through B's engine
 *
 * Usage: bun worker.ts --arm B --tier team --pass warm --plan plan.json --out rows.ndjson
 *          [--db <url>] [--starts N] [--concurrency 1] [--strategy layer|perdepth|traverseGraph=perdepth,traversePaths=layer] [--calls calibration]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { cellOf, slugOf, type Call } from './generate.ts';
import { canonGraph, canonPaths } from './canon.ts';
import { HydraClient, HydraWalker, type PageMeta } from './hydra.ts';

const { values: a } = parseArgs({ options: {
  arm: { type: 'string' }, tier: { type: 'string' }, pass: { type: 'string' }, plan: { type: 'string' }, out: { type: 'string' },
  db: { type: 'string' }, starts: { type: 'string' }, concurrency: { type: 'string', default: '1' },
  strategy: { type: 'string', default: 'layer' }, calls: { type: 'string', default: 'counted' }, timeout: { type: 'string', default: '30000' },
} });
const arm = a.arm!; const tier = a.tier!; const pass = a.pass!; const out = a.out!;
const TIMEOUT = Number(a.timeout);
const BREAKER = 10;
const plan = JSON.parse(readFileSync(a.plan!, 'utf8')) as { starts: number[]; hubs: number[]; calls: Call[]; calibration_calls: Call[] };
const hubs = new Set(plan.hubs);
let calls = a.calls === 'calibration' ? plan.calibration_calls : plan.calls;
if (a.starts) { const keep = new Set(plan.starts.slice(0, Number(a.starts))); calls = calls.filter(c => keep.has(c.start)); }
const done = new Set<string>();
if (existsSync(out)) for (const line of readFileSync(out, 'utf8').split('\n')) {
  if (!line) continue;
  const r = JSON.parse(line);
  if (r.arm === arm && r.tier === tier && r.pass === pass) done.add(r.call_id);
}
const engineDir = process.env.GB_ENGINE_DIR!;
let engine: any;
if (a.db?.startsWith('pglite:')) {
  const { PGLiteEngine } = await import(`${engineDir}/src/core/pglite-engine.ts`);
  engine = new PGLiteEngine();
  await engine.connect({ database_path: a.db.slice('pglite:'.length) });
} else {
  const { PostgresEngine } = await import(`${engineDir}/src/core/postgres-engine.ts`);
  engine = new PostgresEngine();
  await engine.connect({ database_url: a.db });
}
let walkers: { traverseGraph: HydraWalker; traversePaths: HydraWalker } | undefined;
let hydra: HydraClient | undefined;
if (arm.startsWith('C') || arm.startsWith('D')) {
  hydra = new HydraClient({ url: process.env.HYDRA_URL ?? 'http://127.0.0.1:8443', token: process.env.HYDRA_TOKEN ?? 'local-development-token-32-bytes-xx', graph: 'default', namespace: 'default', cell: 'cell-0', concurrency: Number(process.env.HYDRA_CLIENT_CONCURRENCY ?? 8) });
  const hydrate = async (ids: number[]) => {
    const rows = await engine.executeRaw('SELECT id, slug, source_id, title, type FROM pages WHERE id = ANY($1::int[])', [ids]) as Array<PageMeta & { id: number }>;
    return new Map(rows.map(r => [Number(r.id), r]));
  };
  const pick = (kind: string) => {
    const spec = a.strategy!.split(',').map(x => x.split('='));
    return ((spec.find(([k]) => k === kind)?.[1] ?? spec.find(([k, v]) => v === undefined)?.[0]) ?? 'layer') as 'layer' | 'perdepth';
  };
  walkers = { traverseGraph: new HydraWalker(hydra, hydrate, pick('traverseGraph')), traversePaths: new HydraWalker(hydra, hydrate, pick('traversePaths')) };
}

async function run(c: Call, signal: AbortSignal) {
  const slug = slugOf(c.start);
  if (walkers) {
    return c.kind === 'traverseGraph' ? canonGraph(await walkers.traverseGraph.traverseGraph(c.start, c.depth, signal))
      : canonPaths(await walkers.traversePaths.traversePaths(c.start, c.depth, c.direction, c.linkType, signal));
  }
  return c.kind === 'traverseGraph' ? canonGraph(await engine.traverseGraph(slug, c.depth))
    : canonPaths(await engine.traversePathsDetailed(slug, { depth: c.depth, direction: c.direction, ...(c.linkType ? { linkType: c.linkType } : {}) }));
}

const timeoutsByCell = new Map<string, number>();
let failed = 0;
async function one(c: Call) {
  const cell = cellOf(c);
  const base = { arm, tier, pass, call_id: c.id, cell, start: c.start, hub: hubs.has(c.start), strategy: walkers ? walkers[c.kind].strategy : undefined };
  if (arm === 'A' && (timeoutsByCell.get(cell) ?? 0) >= BREAKER) {
    appendFileSync(out, JSON.stringify({ ...base, status: 'not_run_breaker' }) + '\n');
    return;
  }
  const ctl = new AbortController();
  const req0 = hydra?.requests ?? 0;
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      run(c, ctl.signal),
      new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(Object.assign(new Error('client timeout'), { code: 'CLIENT_TIMEOUT' })); }, TIMEOUT + (walkers ? 0 : 1000)); }),
    ]);
    const ms = performance.now() - t0;
    appendFileSync(out, JSON.stringify({ ...base, status: 'ok', ms: Math.round(ms * 1000) / 1000, ...res, requests: hydra ? hydra.requests - req0 : undefined }) + '\n');
  } catch (e) {
    const ms = performance.now() - t0;
    const err = e as { code?: string; message?: string; name?: string };
    const isTimeout = err.code === '57014' || err.code === 'CLIENT_TIMEOUT' || err.name === 'AbortError' || /statement timeout|canceling statement/i.test(String(err.message));
    if (isTimeout) timeoutsByCell.set(cell, (timeoutsByCell.get(cell) ?? 0) + 1); else failed++;
    appendFileSync(out, JSON.stringify({ ...base, status: isTimeout ? 'timeout' : 'error', ms: Math.round(ms * 1000) / 1000, error: String(err.message ?? e).slice(0, 500) }) + '\n');
  } finally {
    clearTimeout(timer);
  }
}

const todo = calls.filter(c => !done.has(c.id));
const t0 = performance.now();
const conc = Number(a.concurrency);
let next = 0;
await Promise.all(Array.from({ length: conc }, async () => { while (next < todo.length) await one(todo[next++]); }));
const wall = performance.now() - t0;
console.log(JSON.stringify({ arm, tier, pass, calls: todo.length, skipped: done.size, failed, wall_ms: Math.round(wall), calls_per_s: todo.length / (wall / 1000) }));
await engine.disconnect();
process.exit(0);
