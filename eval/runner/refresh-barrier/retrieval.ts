/**
 * Part B of the refresh-barrier validation (docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md, "Part B"): Cat 18
 * and Cat 26 at gbrain build G with the flag off and on, compared query by query.
 *
 * Both runners import the pinned \`gbrain\` package, so this builds a scratch gbrain-evals worktree at this checkout's HEAD whose
 * node_modules/gbrain is a git-archive copy of G with its own install (every other dependency is a link to this checkout's),
 * runs each runner there once per arm, keeps its reports, and applies the margin: in every cell and primary metric, the
 * lower bound of the paired 95% bootstrap interval over queries of on minus off is at least -0.01 with --stub-embed (B1)
 * and -0.02 with real embedders (B2). A query that errored scores 0 in its arm. B1 also gates search latency: in every
 * Cat 18 cell, the median query_ms on the on arm is at most 1.2 times the off arm's.
 *
 *   bun eval/runner/refresh-barrier/retrieval.ts --gbrain-root <G> --work <dir> --stub-embed [--label g|pin]
 *
 * Before each arm it resolves the switch through gbrain's own reader in that arm's environment and gbrain copy, and a gated
 * run refuses an arm that does not resolve to it. It refuses a reused worktree at another commit or with local edits.
 *
 * --label pin runs the same against the pinned gbrain (the descriptive comparator, never gated). B2 makes paid embedding
 * calls, which must go through the budget ledger; until that path lands this runner refuses to run without --stub-embed.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pairedBootstrap } from './analyze.ts';

/** The preregistered margins: B1 (stub embeddings, deterministic) and B2 (real embedders, provider noise). */
export const MARGIN = { b1: -0.01, b2: -0.02 } as const;
export const LATENCY_RATIO_MAX = 1.2;
const REPO = resolve(import.meta.dir, '../../..');
type Rec = Record<string, any>;

function prepare(work: string, gbrainRoot: string | null): string {
  const evals = join(work, 'evals');
  if (!existsSync(evals)) execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', evals, 'HEAD'], { stdio: 'ignore' });
  const head = (cwd: string) => execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head(evals) !== head(REPO)) throw new Error(`refusing to reuse ${evals}: it is at ${head(evals)}, not this checkout's HEAD ${head(REPO)}; remove it or use another --work`);
  if (execFileSync('git', ['-C', evals, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error(`refusing to reuse ${evals}: it has local edits; remove it or use another --work`);
  const nm = join(evals, 'node_modules');
  rmSync(nm, { recursive: true, force: true }); mkdirSync(nm);
  for (const entry of readdirSync(join(REPO, 'node_modules')).sort()) if (entry !== 'gbrain') symlinkSync(join(REPO, 'node_modules', entry), join(nm, entry));
  const dest = join(nm, 'gbrain');
  if (gbrainRoot) {
    mkdirSync(dest);
    execFileSync('sh', ['-c', 'git -C "$1" archive HEAD | tar -x -C "$2"', 'sh', gbrainRoot, dest]);
    execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: dest, stdio: 'ignore' });
  } else cpSync(join(REPO, 'node_modules', 'gbrain'), dest, { recursive: true });
  return evals;
}

/** The refresh_barrier value gbrain resolves for a fresh in-memory brain in one arm's environment and gbrain copy; null when the probe fails. */
function resolvedSwitch(evals: string, env: Record<string, string>): boolean | null {
  const core = join(evals, 'node_modules', 'gbrain', 'src', 'core');
  const script = `const { PGLiteEngine } = await import(${JSON.stringify(join(core, 'pglite-engine.ts'))}); const sw = await import(${JSON.stringify(join(core, 'persistence', 'switches.ts'))});
const e = new PGLiteEngine(); await e.connect({}); await e.initSchema(); const s = await sw.readWriteSwitches(sw.viewedEngine(e)); await e.disconnect(); console.log(JSON.stringify(s.refresh_barrier === true));`;
  try { return JSON.parse(execFileSync('bun', ['-e', script], { cwd: evals, env, encoding: 'utf8', timeout: 120_000 }).trim().split('\n').pop()!); } catch { return null; }
}

/** Runs both runners in one arm and keeps their reports; a gated run refuses an arm whose environment does not resolve the switch to that arm. */
function runArm(evals: string, arm: 'off' | 'on', stubEmbed: boolean, keep: string, gated: boolean): boolean | null {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'GBRAIN_REFRESH_BARRIER') env[k] = v;
  if (arm === 'on') env.GBRAIN_REFRESH_BARRIER = '1';
  env.CAT18_PROVIDERS = 'openai,voyage';
  const resolved = resolvedSwitch(evals, env);
  if (gated && resolved !== (arm === 'on')) throw new Error(`refusing to score the ${arm} arm: gbrain resolved refresh_barrier=${resolved} in its environment; redo the arm`);
  const reports = join(evals, 'eval', 'reports');
  rmSync(reports, { recursive: true, force: true });
  for (const runner of ['cat18-embedding-providers.ts', 'cat26-contextual-retrieval.ts']) {
    try { execFileSync('bun', [join('eval/runner', runner), ...(stubEmbed ? ['--stub-embed'] : [])], { cwd: evals, env, stdio: ['ignore', 'inherit', 'inherit'], timeout: 3_600_000 }); }
    catch (error) { console.error(`[retrieval] ${runner} ${arm} exited ${(error as { status?: number }).status ?? 'abnormally'}; its receipt keeps the reason`); }
  }
  rmSync(keep, { recursive: true, force: true });
  cpSync(reports, keep, { recursive: true });
  return resolved;
}

/** Per cell and metric: query id to score, from one arm's kept reports. */
export function readScores(dir: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const c18 = join(dir, 'cat18-embedding-providers', 'receipt.json');
  if (existsSync(c18)) for (const cell of (JSON.parse(readFileSync(c18, 'utf8')).data?.cells ?? []) as Rec[]) {
    out[`cat18/${cell.cell}/recall_at_10`] = Object.fromEntries((cell.per_query ?? []).map((q: Rec) => [q.query_id, q.status === 'scored' ? Number(q.recall_at_10 ?? 0) : 0]));
  }
  const c26dir = join(dir, 'cat26-contextual-retrieval');
  const dump = existsSync(c26dir) ? readdirSync(c26dir).filter(f => /-cat26\.json$/.test(f)).sort().pop() : undefined;
  if (dump) for (const m of (JSON.parse(readFileSync(join(c26dir, dump), 'utf8')).per_mode ?? []) as Rec[]) {
    const mode = m.config?.mode_requested;
    out[`cat26/${mode}/r_at_3`] = Object.fromEntries((m.per_query ?? []).map((q: Rec) => [q.query_id, q.error ? 0 : Number(q.recall_at_k ?? 0)]));
    out[`cat26/${mode}/mrr`] = Object.fromEntries((m.per_query ?? []).map((q: Rec) => [q.query_id, q.error ? 0 : Number(q.reciprocal_rank ?? 0)]));
  }
  return out;
}

/** Per Cat 18 cell: every scored query's query_ms, from one arm's kept reports. */
export function readLatency(dir: string): Record<string, number[]> {
  const c18 = join(dir, 'cat18-embedding-providers', 'receipt.json');
  if (!existsSync(c18)) return {};
  return Object.fromEntries(((JSON.parse(readFileSync(c18, 'utf8')).data?.cells ?? []) as Rec[])
    .map(cell => [String(cell.cell), (cell.per_query ?? []).map((q: Rec) => q.query_ms).filter((x: unknown): x is number => typeof x === 'number')]));
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/** The latency check: per Cat 18 cell, median on-arm query_ms over median off-arm query_ms, at most LATENCY_RATIO_MAX. */
export function compareLatency(off: Record<string, number[]>, on: Record<string, number[]>): Rec {
  const cells: Rec = {};
  for (const key of new Set([...Object.keys(off), ...Object.keys(on)])) {
    const a = median(off[key] ?? []), b = median(on[key] ?? []);
    const ratio = a && b !== null ? b / a : null;
    cells[key] = { off_p50_ms: a, on_p50_ms: b, ratio, pass: ratio !== null && ratio <= LATENCY_RATIO_MAX };
  }
  return { max_ratio: LATENCY_RATIO_MAX, pass: Object.values(cells).length > 0 && Object.values(cells).every((c: any) => c.pass), cells };
}

/** The preregistered Part B cells: Cat 18's two providers and Cat 26's three modes, per metric. */
export const CELLS = ['cat18/openai/recall_at_10', 'cat18/voyage/recall_at_10', ...['none', 'title', 'per_chunk_synopsis'].flatMap(m => [`cat26/${m}/r_at_3`, `cat26/${m}/mrr`])];

/** The margin check per cell: paired over the queries both arms scored, a query missing from one arm scoring 0 there; a preregistered cell missing from either arm fails. */
export function compare(off: Record<string, Record<string, number>>, on: Record<string, Record<string, number>>, margin: number = MARGIN.b1): Rec {
  const cells: Rec = {};
  for (const key of new Set([...CELLS, ...Object.keys(off), ...Object.keys(on)])) {
    const a = off[key] ?? {}, b = on[key] ?? {};
    const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    const mean = (m: Record<string, number>) => ids.length ? ids.reduce((s, id) => s + (m[id] ?? 0), 0) / ids.length : null;
    const diff = pairedBootstrap(ids.map(id => (b[id] ?? 0) - (a[id] ?? 0)));
    cells[key] = { queries: ids.length, off: mean(a), on: mean(b), diff, identical: ids.every(id => a[id] === b[id]),
      pass: ids.length > 0 && key in off && key in on && diff.lo !== null && diff.lo >= margin };
  }
  return { margin, pass: Object.values(cells).length > 0 && Object.values(cells).every((c: any) => c.pass), cells };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const label = get('--label') ?? 'g';
  const work = resolve(get('--work')!);
  const gbrainRoot = label === 'pin' ? null : resolve(get('--gbrain-root')!);
  const stubEmbed = argv.includes('--stub-embed');
  if (!stubEmbed) {
    process.stderr.write('retrieval: B2 (real embedders) makes paid calls, which go through the budget ledger; that path is not in this runner yet, so run B1 with --stub-embed\n');
    process.exit(2);
  }
  const evals = prepare(work, gbrainRoot);
  const kept = (arm: string) => join(work, 'out', label, arm);
  const switches = Object.fromEntries((['off', 'on'] as const).map(arm => [arm, runArm(evals, arm, stubEmbed, kept(arm), label === 'g')]));
  const scores = compare(readScores(kept('off')), readScores(kept('on')), stubEmbed ? MARGIN.b1 : MARGIN.b2);
  const latency = stubEmbed ? compareLatency(readLatency(kept('off')), readLatency(kept('on'))) : null;
  const result = { label, stub_embed: stubEmbed, gbrain: gbrainRoot ? execFileSync('git', ['-C', gbrainRoot, 'rev-parse', 'HEAD']).toString().trim() : 'pin',
    switches, pass: scores.pass && (latency === null || latency.pass), scores, latency };
  writeFileSync(join(work, 'out', label, 'retrieval.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ label, pass: result.pass, latency: latency?.cells ?? null,
    cells: Object.fromEntries(Object.entries(scores.cells as Rec).map(([k, c]: [string, any]) => [k, { off: c.off, on: c.on, lo: c.diff.lo, pass: c.pass }])) }));
}
