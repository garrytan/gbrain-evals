/**
 * Counted-run driver for the refresh-barrier validation (docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md).
 * Runs one block (an engine's concurrency trials, its named-case runs or its quiet latency runs) as child processes, a fixed
 * number at a time, and writes a receipt. Trials and named runs go in one shuffled order that interleaves arms and seeds; quiet
 * runs go seed by seed with the arms alternating (off first on even seeds), so each seed's two arms run back to back. A job whose result file exists is skipped, so
 * a restarted run resumes; a job that crashes or times out leaves a harness_error result, which counts as a failure.
 *
 *   bun eval/runner/refresh-barrier/run.ts --block trials|named|quiet --engine postgres|pglite --gbrain-root <G> --out <dir>
 *     [--seeds 1001-1500] [--reps 101-125] [--arms off,on] [--concurrency 6] [--pg-admin <url> --template <db>]
 *     [--prereg <path> --gbrain-sha <G> | --dry]
 *
 * It refuses a gbrain root with uncommitted changes, and a counted run refuses a root whose HEAD is not --gbrain-sha.
 * Every job runs as `bun --no-env-file` with provider keys removed from its environment.
 * --dry skips the preregistration attestation (development runs only; analyze.ts marks their receipts uncounted).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, type as osType } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { attestPreregistration } from '../prereg.ts';
import { PROVIDER_KEYS, harnessDigest, harnessFiles } from './fixture.ts';
import { B_KINDS } from './named-case.ts';
import { PARAMS, SCHEDULE_VERSION, rng, type Engine } from './schedule.ts';

export const PREREG = 'docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md';
// Above each job's own worst case: a trial's ready wait, tick line, settle, stop and convergence limits add up to about
// 1,100 s (about 840 s for a quiet run), so run.ts kills only a job that hung past every limit trial.ts enforces itself.
const JOB_TIMEOUT_MS = { trials: 1_800_000, named: 600_000, quiet: 1_200_000 } as const;
export const QUIET_SEEDS = '2001-2100';
const ORDER_SEED = 2026;
const HERE = import.meta.dir;
const REPO = resolve(HERE, '../../..');

export interface RunArgs {
  block: 'trials' | 'named' | 'quiet'; engine: Engine; gbrainRoot: string; out: string; seeds: [number, number]; reps: [number, number];
  arms: Array<'off' | 'on'>; concurrency: number; pgAdmin?: string; template?: string; prereg: string; dry: boolean; gbrainSha?: string;
}
export { B_KINDS };
export interface Job { id: string; script: string; args: string[]; result: string; meta: Record<string, unknown> }

const range = (s: string): [number, number] => { const [a, b] = s.split('-').map(Number); return [a!, b ?? a!]; };
const span = ([a, b]: [number, number]) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/**
 * The block's jobs in the preregistered order: every (seed or repetition, kind, arm) once, shuffled with seed 2026; quiet
 * jobs seed by seed with alternating arms, unshuffled.
 */
export function planJobs(a: RunArgs): Job[] {
  const common = ['--engine', a.engine, '--out', a.out, '--gbrain-root', a.gbrainRoot, ...(a.pgAdmin ? ['--pg-admin', a.pgAdmin] : []), ...(a.template ? ['--template', a.template] : [])];
  const jobs: Job[] = [];
  if (a.block === 'quiet') {
    for (const seed of span(a.seeds)) for (const arm of seed % 2 === 0 ? a.arms : [...a.arms].reverse()) jobs.push({ id: `quiet-${a.engine}-${arm}-${seed}`,
      script: join(HERE, 'trial.ts'), args: ['--seed', String(seed), '--arm', arm, '--quiet', ...common], result: join(a.out, 'quiet', a.engine, arm, `${seed}.json`), meta: { seed, arm, engine: a.engine, block: 'quiet' } });
    return jobs;
  }
  if (a.block === 'trials') {
    for (const seed of span(a.seeds)) for (const arm of a.arms) jobs.push({ id: `trial-${a.engine}-${arm}-${seed}`, script: join(HERE, 'trial.ts'),
      args: ['--seed', String(seed), '--arm', arm, ...common], result: join(a.out, 'trials', a.engine, arm, `${seed}.json`), meta: { seed, arm, engine: a.engine } });
  } else {
    for (const rep of span(a.reps)) for (const b of B_KINDS) for (const arm of a.arms) jobs.push({ id: `named-${a.engine}-${arm}-${b}-${rep}`, script: join(HERE, 'named-case.ts'),
      args: ['--b', b, '--rep', String(rep), '--arm', arm, ...common], result: join(a.out, 'named', a.engine, arm, `order-${b}-${rep}.json`), meta: { case: 'order', b, rep, arm, engine: a.engine } });
  }
  const r = rng(ORDER_SEED, `order-${a.block}-${a.engine}`);
  for (let i = jobs.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!]; }
  return jobs;
}

const gitInfo = (root: string) => {
  const run = (...args: string[]) => Bun.spawnSync(['git', '-C', root, ...args]).stdout.toString().trim();
  return { sha: run('rev-parse', 'HEAD'), dirty: run('status', '--porcelain', '--untracked-files=no').length > 0 };
};

async function runJob(job: Job, timeoutMs: number, logDir: string, log: (e: Record<string, unknown>) => void, dbPrefix: string): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PROVIDER_KEYS.test(k)) env[k] = v;
  env.RB_DB_PREFIX = dbPrefix;
  const fd = openSync(join(logDir, `${job.id}.log`), 'w');
  const started = Date.now();
  // Its own process group, so a timeout kills the trial's writer, tick and sync processes with it.
  const proc = spawn('bun', ['--no-env-file', job.script, ...job.args], { env, stdio: ['ignore', fd, fd], detached: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-proc.pid!, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } }, timeoutMs);
  const [code, signal] = await new Promise<[number | null, string | null]>(res => proc.on('exit', (c, s) => res([c, s])));
  clearTimeout(timer);
  const ms = Date.now() - started;
  if (!existsSync(job.result) || code !== 0) {
    const tail = readFileSync(join(logDir, `${job.id}.log`), 'utf8').split('\n').slice(-30).join('\n').slice(-3_000);
    mkdirSync(dirname(job.result), { recursive: true });
    const prior = existsSync(job.result) ? JSON.parse(readFileSync(job.result, 'utf8')) : { ...job.meta, ops: [] };
    writeFileSync(job.result, JSON.stringify({ ...prior, harness_error: { exit: code, signal, timed_out: timedOut, ms, log_tail: tail } }));
  }
  log({ ev: 'job', id: job.id, exit: code, signal, timed_out: timedOut, ms, result: existsSync(job.result) });
}

/** Drops the databases this block's trials left (`--keep` or a killed job), and only those: they all start with its prefix. */
async function dropTrialDatabases(gbrainRoot: string, pgAdmin: string, prefix: string): Promise<number> {
  const pg = (await import(join(gbrainRoot, 'vendor/postgres/src/index.js'))).default;
  const admin = pg(pgAdmin, { max: 1, prepare: false, onnotice: () => undefined });
  const rows = await admin.unsafe('SELECT datname FROM pg_database WHERE starts_with(datname, $1)', [prefix]);
  for (const { datname } of rows) await admin.unsafe(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
  await admin.end();
  return rows.length;
}

export async function runBlock(a: RunArgs): Promise<Record<string, unknown>> {
  const g = gitInfo(a.gbrainRoot);
  if (g.dirty) throw new Error(`refusing to run: the gbrain root ${a.gbrainRoot} has uncommitted changes`);
  if (!a.dry && !a.gbrainSha) throw new Error('a counted run needs --gbrain-sha <G>');
  if (a.gbrainSha && g.sha !== a.gbrainSha) throw new Error(`refusing to run: the gbrain root is at ${g.sha}, not --gbrain-sha ${a.gbrainSha}`);
  const attestation = a.dry ? null : attestPreregistration(a.prereg, REPO);
  const jobs = planJobs(a);
  const logDir = join(a.out, 'logs'); mkdirSync(logDir, { recursive: true });
  const logPath = join(a.out, `run-${a.block}-${a.engine}.jsonl`);
  const log = (e: Record<string, unknown>) => appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), ...e })}\n`);
  const startedAt = new Date().toISOString();
  const todo = jobs.filter(j => !existsSync(j.result));
  log({ ev: 'start', block: a.block, engine: a.engine, jobs: jobs.length, todo: todo.length, dry: a.dry });
  const dbPrefix = `rb_test_${a.block}_${process.pid}_`;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(a.concurrency, todo.length) }, async () => {
    while (next < todo.length) { const job = todo[next++]!; await runJob(job, JOB_TIMEOUT_MS[a.block], logDir, log, dbPrefix); }
  }));
  const droppedDatabases = a.engine === 'postgres' && a.pgAdmin ? await dropTrialDatabases(a.gbrainRoot, a.pgAdmin, dbPrefix) : 0;
  const harnessErrors = jobs.filter(j => existsSync(j.result) && JSON.parse(readFileSync(j.result, 'utf8')).harness_error).length;
  const files = harnessFiles();
  const receipt = {
    preregistration: a.prereg, attestation, counted: !a.dry, block: a.block, engine: a.engine, arms: a.arms,
    ...(a.block === 'named' ? { reps: a.reps, b_kinds: B_KINDS } : { seeds: a.seeds }), concurrency: a.concurrency, order_seed: ORDER_SEED,
    started_at: startedAt, finished_at: new Date().toISOString(),
    gbrain: { root: a.gbrainRoot, ...gitInfo(a.gbrainRoot) }, gbrain_evals: gitInfo(REPO), files, harness_digest: harnessDigest(), schedule_version: SCHEDULE_VERSION, params: PARAMS,
    host: { os: osType(), cpus: cpus().length, mem_gb: Math.round(totalmem() / 2 ** 30), bun: Bun.version },
    jobs: { total: jobs.length, skipped_existing: jobs.length - todo.length, ran: todo.length, harness_errors: harnessErrors }, dropped_databases: droppedDatabases,
  };
  writeFileSync(join(a.out, `receipt-${a.block}-${a.engine}.json`), JSON.stringify(receipt, null, 2));
  log({ ev: 'end', harness_errors: harnessErrors });
  return receipt;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const block = get('--block');
  if (block !== 'trials' && block !== 'named' && block !== 'quiet') throw new Error('--block trials|named|quiet is required');
  const a: RunArgs = {
    block, engine: (get('--engine') ?? 'postgres') as Engine, gbrainRoot: resolve(get('--gbrain-root')!), out: resolve(get('--out')!),
    seeds: range(get('--seeds') ?? (block === 'quiet' ? QUIET_SEEDS : '1001-1500')), reps: range(get('--reps') ?? '101-125'),
    arms: (get('--arms') ?? 'off,on').split(',') as Array<'off' | 'on'>, concurrency: Number(get('--concurrency') ?? 6),
    pgAdmin: get('--pg-admin'), template: get('--template'), prereg: get('--prereg') ?? PREREG, dry: argv.includes('--dry'), gbrainSha: get('--gbrain-sha'),
  };
  if (a.engine !== 'postgres' && a.engine !== 'pglite') throw new Error(`--engine must be postgres or pglite (got ${a.engine})`);
  const receipt = await runBlock(a);
  console.log(JSON.stringify({ block: receipt.block, engine: receipt.engine, jobs: receipt.jobs }));
}
