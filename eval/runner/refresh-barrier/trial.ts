/**
 * One refresh-barrier trial: build a fresh synthetic brain, replay one seed's schedule with the barrier off or on, wait for
 * the brain to quiesce, then record ground truth (verify.ts). Postgres trials run every actor as its own OS process
 * (child.ts); PGLite trials run them as concurrent tasks in this process, because PGLite admits one process.
 *
 *   bun eval/runner/refresh-barrier/trial.ts --seed 7 --arm on --engine postgres --out <dir> --gbrain-root <copy>
 *     [--pg-admin <url> --template <db>] [--keep] [--quiet]
 *
 * --quiet runs the seed's quiet latency schedule (the same writers and writes, no refresh, push, sync or fault) and writes
 * its result under quiet/ instead of trials/.
 * The child environment is an explicit allowlist: no provider key reaches a trial, so the concurrency trials are keyless.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROVIDER_KEYS, brainPaths, countedRunIn, createRepos, gitHead, harnessDigest, hermeticGit, loadGbrain, registerBrain } from './fixture.ts';
import { KNOWN_SYNC_STATUSES, KNOWN_TICK_STATUSES, foreignCommit, jsonlLogger, logSwitch, pushTick, runConverge, runSync, runTick, runWriter, sleep, type Session } from './runtime.ts';
import { failureClasses } from './analyze.ts';
import { generateSchedule, type Engine, type TrialSchedule } from './schedule.ts';
import { readEvents, verifyTrial } from './verify.ts';

export const STARTUP_MS = 2_500;
export const QUIESCE_LIMIT_MS = 120_000;
const CONVERGE_LIMIT_MS = 150_000;
export const TICK_SLACK_MS = 120_000;
export const WRITER_OPS_LIMIT_MS = 270_000;
export const STOP_LIMIT_MS = 30_000;

export interface TrialArgs { seed: number; arm: 'off' | 'on'; engine: Engine; out: string; gbrainRoot: string; pgAdmin?: string; template?: string; keep?: boolean; quiet?: boolean }

export const READY_LIMIT_MS = 90_000;
export const READY_LEAD_MS = 500;
const ENGINES: Engine[] = ['postgres', 'pglite'];

/**
 * Checks a trial's or named case's common arguments before any work. A bad value prints the operation, the value and a
 * corrected command to stderr and exits 2, which run.ts records as a harness_error.
 */
export function checkCommonArgs(op: string, argv: string[], example: string): { get: (k: string) => string | undefined; arm: 'off' | 'on'; engine: Engine; out: string; gbrainRoot: string } {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const fail = (what: string, value: unknown): never => {
    process.stderr.write(`${op}: ${what} (got ${JSON.stringify(value ?? null)})\nexample: ${example}\n`);
    process.exit(2);
  };
  const arm = get('--arm');
  if (arm !== 'off' && arm !== 'on') fail('--arm must be off or on', arm);
  const engine = get('--engine') as Engine | undefined;
  if (!engine || !ENGINES.includes(engine)) fail('--engine must be postgres or pglite', engine);
  const out = get('--out'), root = get('--gbrain-root');
  if (!out || !existsSync(resolve(out))) fail('--out must name an existing directory', out);
  if (!root || !existsSync(join(resolve(root), 'src/cli.ts'))) fail('--gbrain-root must name a gbrain checkout (src/cli.ts)', root);
  if (engine === 'postgres' && (!get('--pg-admin') || !get('--template'))) fail('--pg-admin and --template are required with --engine postgres', { pgAdmin: get('--pg-admin'), template: get('--template') });
  return { get, arm: arm as 'off' | 'on', engine: engine!, out: resolve(out!), gbrainRoot: resolve(root!) };
}

export const integerArg = (op: string, name: string, value: string | undefined, example: string): number => {
  if (value === undefined || !/^\d+$/.test(value)) {
    process.stderr.write(`${op}: ${name} must be a non-negative integer (got ${JSON.stringify(value ?? null)})\nexample: ${example}\n`);
    process.exit(2);
  }
  return Number(value);
};

function parseArgs(argv: string[]): TrialArgs {
  const example = 'bun eval/runner/refresh-barrier/trial.ts --seed 7 --arm on --engine postgres --out <dir> --gbrain-root <G> --pg-admin <url> --template <db>';
  const c = checkCommonArgs('trial', argv, example);
  return { seed: integerArg('trial', '--seed', c.get('--seed'), example), arm: c.arm, engine: c.engine, out: c.out, gbrainRoot: c.gbrainRoot,
    pgAdmin: c.get('--pg-admin'), template: c.get('--template'), keep: argv.includes('--keep'), quiet: argv.includes('--quiet') };
}

const QUIESCE_SQL = `SELECT
  (SELECT count(*) FROM persistence_requests WHERE state NOT IN ('committed','conflict','failed','cancelled'))::int AS open_requests,
  (SELECT count(*) FROM persistence_worktree_refreshes WHERE state IN ('draining','fenced','merged','syncing','recovery_required'))::int AS active_refreshes,
  (SELECT count(*) FROM persistence_effects WHERE kind='git' AND state IN ('queued','running'))::int AS open_effects,
  (SELECT count(*) FROM persistence_effects WHERE kind<>'git' AND state IN ('queued','running'))::int AS open_derived`;

/** The gbrain CLI the owner's publish child runs: bun with --no-env-file, as every trial process runs, so no .env file can put a key back. */
export const cliWrapperScript = (gbrainRoot: string) => `#!/bin/sh\nexec bun --no-env-file ${JSON.stringify(join(gbrainRoot, 'src/cli.ts'))} "$@"\n`;

export interface OpenBrain { g: Awaited<ReturnType<typeof loadGbrain>>; engine: any; paths: ReturnType<typeof brainPaths>; ids: Awaited<ReturnType<typeof registerBrain>>;
  dbUrl: string | null; dropDb: (() => Promise<void>) | null; cliWrapper: string; gitEnv: Record<string, string>; started: number; timings: Record<string, number> }

/**
 * A fresh synthetic brain in `dir` for one arm: keyless environment, the flag set for the arm, a new database (Postgres,
 * cloned from the template) or an in-memory PGLite, the three Git repositories and the registered sources.
 */
export async function openBrain(a: Pick<TrialArgs, 'arm' | 'engine' | 'gbrainRoot' | 'pgAdmin' | 'template'>, dir: string, dbTag: string): Promise<OpenBrain> {
  for (const k of Object.keys(process.env)) if (PROVIDER_KEYS.test(k)) delete process.env[k];
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const gitEnv = hermeticGit(join(dir, 'git'));
  const paths = brainPaths(dir);
  process.env.GBRAIN_HOME = paths.home;
  // The owner publishes over a moved remote through a child `gbrain git commit-push --push-only --keep-checkout`; it finds
  // that CLI through GBRAIN_JOB_CHILD_CLI when the process is not gbrain's own cli.ts.
  const cliWrapper = join(dir, 'gbrain-cli.sh');
  writeFileSync(cliWrapper, cliWrapperScript(a.gbrainRoot), { mode: 0o755 });
  process.env.GBRAIN_JOB_CHILD_CLI = cliWrapper;
  if (a.arm === 'on') process.env.GBRAIN_REFRESH_BARRIER = '1'; else delete process.env.GBRAIN_REFRESH_BARRIER;
  const g = await loadGbrain(a.gbrainRoot);
  g.switches.resetWriteSwitches();
  const timings: Record<string, number> = {};
  const started = Date.now();
  let engine: any, dbUrl: string | null = null, dropDb: (() => Promise<void>) | null = null;
  if (a.engine === 'postgres') {
    const pg = (await import(join(a.gbrainRoot, 'vendor/postgres/src/index.js'))).default;
    const admin = pg(a.pgAdmin!, { max: 1, prepare: false, onnotice: () => undefined });
    const db = `${process.env.RB_DB_PREFIX ?? 'rb_test_'}${dbTag}_${randomUUID().slice(0, 8)}`;
    for (let i = 0; ; i++) {
      try { await admin.unsafe(`CREATE DATABASE ${db} TEMPLATE ${a.template}`); break; }
      catch (error) { if (i >= 20 || !/being accessed by other users/.test(String(error))) throw error; await sleep(250 + Math.random() * 500); }
    }
    const url = new URL(a.pgAdmin!); url.pathname = `/${db}`; dbUrl = url.toString();
    dropDb = async () => { await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await admin.end(); };
    const { PostgresEngine } = await import(join(a.gbrainRoot, 'src/core/postgres-engine.ts'));
    engine = new PostgresEngine(); await engine.connect({ database_url: dbUrl, poolSize: 4 });
  } else {
    const { PGLiteEngine } = await import(join(a.gbrainRoot, 'src/core/pglite-engine.ts'));
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  }
  timings.engine_ms = Date.now() - started;
  createRepos(paths);
  const ids = await registerBrain(g, engine, paths);
  return { g, engine, paths, ids, dbUrl, dropDb, cliWrapper, gitEnv, started, timings };
}

const workName = (a: TrialArgs) => `${a.engine}-${a.arm}-${a.seed}${a.quiet ? '-quiet' : ''}`;

export async function runTrial(a: TrialArgs): Promise<Record<string, unknown>> {
  const schedule: TrialSchedule = generateSchedule(a.seed, a.engine, a.quiet);
  const dir = join(a.out, 'work', workName(a));
  const { g, engine, paths, ids, dbUrl, dropDb, cliWrapper, gitEnv, started, timings } = await openBrain(a, dir, `${a.arm}_${a.seed}`);
  const flags: Record<string, unknown> = {};
  // Every refresh tick, resume and sync as [start, end] epoch ms: the write-latency gate counts only writes issued outside them.
  const refreshWindows: Array<[number, number]> = [];
  const timed = async <T>(work: () => Promise<T>): Promise<T> => { const start = Date.now(); try { return await work(); } finally { refreshWindows.push([start, Date.now()]); } };
  if (schedule.max_wait_ms !== null) {
    await engine.executeRaw(`INSERT INTO config(key,value) VALUES ('persistence.refresh_barrier_max_wait_ms',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [String(schedule.max_wait_ms)]);
  }
  timings.fixture_ms = Date.now() - started - timings.engine_ms;
  let t0 = Date.now() + STARTUP_MS;
  writeFileSync(join(dir, 'schedule.json'), JSON.stringify(schedule));
  writeFileSync(join(dir, 'brain.json'), JSON.stringify({ paths, ids }));
  const log = jsonlLogger(join(dir, 'events-parent.jsonl'));
  const stopFile = join(dir, 'stop');

  if (a.engine === 'postgres') {
    await g.service.disposePersistenceConsumer(engine);
    const childEnv: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8', TMPDIR: process.env.TMPDIR ?? '/tmp',
      GBRAIN_HOME: paths.home, GBRAIN_JOB_CHILD_CLI: cliWrapper, RB_DIR: dir, RB_GBRAIN_ROOT: a.gbrainRoot, RB_DB_URL: dbUrl!, ...gitEnv, ...(a.arm === 'on' ? { GBRAIN_REFRESH_BARRIER: '1' } : {}) };
    const childPath = join(import.meta.dir, 'child.ts');
    const children: Array<{ tag: string; proc: ChildProcess; exit: Promise<number | null> }> = [];
    const childExits: Record<string, number | null> = {};
    const spawnChild = (tag: string, args: string[]) => {
      const fd = openSync(join(dir, `${tag}.log`), 'a');
      const proc = spawn('bun', ['--no-env-file', childPath, ...args], { env: childEnv, stdio: ['ignore', fd, fd] });
      const exit = new Promise<number | null>(res => proc.on('exit', (code, signal) => res(signal ? -1 : code)));
      const c = { tag, proc, exit }; children.push(c); return c;
    };
    const withDeadline = async (c: { tag: string; proc: ChildProcess; exit: Promise<number | null> }, ms: number) => {
      const r = await Promise.race([c.exit, sleep(ms).then(() => 'deadline' as const)]);
      if (r === 'deadline') { flags[`${c.tag}_hang`] = true; c.proc.kill('SIGKILL'); await c.exit; }
      childExits[c.tag] = r === 'deadline' ? null : r;
      return r;
    };
    const writers = schedule.writers.map(w => spawnChild(`w${w.index}`, ['writer', String(w.index)]));
    // t0 starts once every writer has loaded gbrain and connected, so a slow cold start cannot shift a writer's schedule.
    const readyStart = Date.now();
    while (!schedule.writers.every(w => existsSync(join(dir, `w${w.index}.ready`))) && Date.now() - readyStart < READY_LIMIT_MS) await sleep(50);
    if (!schedule.writers.every(w => existsSync(join(dir, `w${w.index}.ready`)))) flags.writers_not_ready = true;
    timings.ready_ms = Date.now() - readyStart;
    t0 = Date.now() + READY_LEAD_MS;
    writeFileSync(join(dir, 't0.json.tmp'), JSON.stringify({ t0 }));
    renameSync(join(dir, 't0.json.tmp'), join(dir, 't0.json'));
    const pushLine = upstreamLine(schedule, paths, t0, log);
    const tickLine = (async () => {
      for (const tick of schedule.ticks) {
        await sleep(t0 + tick.at_ms - Date.now());
        log({ ev: 'tick_spawn', tick: tick.index });
        await timed(() => withDeadline(spawnChild(`tick${tick.index}`, ['tick', String(tick.index), 'tick']), tick.pause_ms + TICK_SLACK_MS));
        if (tick.crash) {
          await sleep(tick.resume_after_ms ?? 0);
          log({ ev: 'resume_spawn', tick: tick.index });
          await timed(() => withDeadline(spawnChild(`tick${tick.index}-resume`, ['tick', String(tick.index), 'resume']), TICK_SLACK_MS));
        }
      }
    })();
    const foreignLine = Promise.all(schedule.foreign.map(async (f, i) => {
      await sleep(t0 + f.at_ms - Date.now());
      try { log({ ev: 'foreign_commit', index: i, ...await foreignCommit(paths, f) }); } catch (error) { log({ ev: 'foreign_commit_error', index: i, message: String(error).slice(0, 400) }); }
      await sleep(f.sync_after_ms);
      await timed(() => withDeadline(spawnChild(`sync${i}`, ['sync', 'alpha']), TICK_SLACK_MS));
    }));
    const opsDone = Promise.all(schedule.writers.map(async (w, i) => {
      const deadline = t0 + schedule.ops_window_ms + WRITER_OPS_LIMIT_MS;
      while (!existsSync(join(dir, `w${w.index}.ops-done`)) && Date.now() < deadline) {
        if (await Promise.race([writers[i]!.exit.then(() => true), sleep(250).then(() => false)])) break;
      }
      if (Date.now() >= deadline) flags[`w${w.index}_ops_hang`] = true;
    }));
    await Promise.all([pushLine, tickLine, foreignLine, opsDone]);
    timings.schedule_ms = Date.now() - t0;
    // With one writer and that writer killed, no live process holds a consumer for its accepted writes; a deployment's
    // resident consumer (`gbrain serve`) would, so the parent starts one for the settle phase.
    if (schedule.strata.writer_kill && schedule.writers.length === 1) { g.service.startPersistenceConsumer(engine, { engine: engine.kind }); flags.settle_consumer = true; }
    flags.quiesce = await quiesce(engine, { derived: true });
    timings.quiesce_ms = Date.now() - t0 - timings.schedule_ms;
    writeFileSync(stopFile, '');
    await Promise.all(writers.map(w => withDeadline(w, STOP_LIMIT_MS)));
    flags.writer_exits = Object.fromEntries(await Promise.all(writers.map(async w => [w.tag, await w.exit])));
    const convergeStart = Date.now();
    if (await withDeadline(spawnChild('converge', ['converge']), CONVERGE_LIMIT_MS) === 'deadline') flags.converge_hang = true;
    flags.quiesce_final = await quiesce(engine);
    timings.converge_ms = Date.now() - convergeStart;
    // child.ts exits 0 after a result or a caught refusal, so any other exit of a tick, resume, sync or converge process is
    // a crash the schedule did not plan, except the planned SIGKILL (-1) of a crash tick.
    const plannedKill = new Set(schedule.ticks.filter(t => t.crash).map(t => `tick${t.index}`));
    flags.child_exits = childExits;
    flags.unplanned_child_exits = Object.entries(childExits).filter(([tag, code]) => !/^w\d+$/.test(tag) && code !== null && code !== 0 && !(code === -1 && plannedKill.has(tag))).length;
  } else {
    const session: Session = { g, engine, ids, paths, log, stopped: () => existsSync(stopFile) };
    await logSwitch(session, 'parent');
    const opsDone = Promise.all(schedule.writers.map(w => runWriter({ ...session, log: jsonlLogger(join(dir, `events-w${w.index}.jsonl`)) }, w.index, w.ops, t0)
      .catch(error => log({ ev: 'writer_error', writer: w.index, message: String(error).slice(0, 400) }))));
    const pushLine = upstreamLine(schedule, paths, t0, log);
    const tickLine = (async () => {
      for (const tick of schedule.ticks) {
        await sleep(t0 + tick.at_ms - Date.now());
        const tStart = Date.now();
        try {
          const result = await timed(() => runTick({ ...session, log: jsonlLogger(join(dir, `events-tick${tick.index}-tick.jsonl`)) }, tick, 'tick'));
          log({ ev: 'tick_result', tick: tick.index, status: result.status ?? null, ms: Date.now() - tStart, attempts: (result as any).attempts, paused: (result as any).paused });
        } catch (error) { log({ ev: 'child_error', role: 'tick', arg: tick.index, code: (error as any)?.code ?? null, attempts: (error as any)?.attempts ?? null, paused: (error as any)?.paused ?? null, message: String((error as any)?.message ?? error).slice(0, 400) }); }
      }
    })();
    const foreignLine = Promise.all(schedule.foreign.map(async (f, i) => {
      await sleep(t0 + f.at_ms - Date.now());
      try { log({ ev: 'foreign_commit', index: i, ...await foreignCommit(paths, f) }); } catch (error) { log({ ev: 'foreign_commit_error', index: i, message: String(error).slice(0, 400) }); }
      await sleep(f.sync_after_ms);
      try { const r = await timed(() => runSync(session, 'alpha')); log({ ev: 'sync_result', status: (r as any).status ?? null }); }
      catch (error) { log({ ev: 'child_error', role: 'sync', code: (error as any)?.code ?? null, message: String((error as any)?.message ?? error).slice(0, 400) }); }
    }));
    const deadline = sleep(schedule.ops_window_ms + WRITER_OPS_LIMIT_MS + STARTUP_MS).then(() => 'deadline' as const);
    if (await Promise.race([Promise.all([opsDone, pushLine, tickLine, foreignLine]), deadline]) === 'deadline') flags.inprocess_hang = true;
    timings.schedule_ms = Date.now() - t0;
    flags.quiesce = await quiesce(engine, { derived: true });
    timings.quiesce_ms = Date.now() - t0 - timings.schedule_ms;
    const convergeStart = Date.now();
    const converge = await Promise.race([runConverge(session).then(r => { log({ ev: 'converge_result', ...r }); return 'done' as const; }),
      sleep(CONVERGE_LIMIT_MS).then(() => 'deadline' as const)]);
    if (converge === 'deadline') flags.converge_hang = true;
    flags.quiesce_final = await quiesce(engine, { derived: true });
    timings.converge_ms = Date.now() - convergeStart;
    writeFileSync(stopFile, '');
  }

  const deadlocks = a.engine === 'postgres'
    ? Number((await engine.executeRaw('SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname=current_database()'))[0]?.n ?? 0) : 0;
  const verdict = await verifyTrial(engine, schedule, paths, ids, dir);
  const events = readEvents(dir);
  const childErrors = events.filter(e => e.ev === 'child_error' || e.ev === 'writer_error');
  const ticks = events.filter(e => e.ev === 'tick_result' || (e.ev === 'child_error' && e.role === 'tick'));
  const convergeEv = events.find(e => e.ev === 'converge_result');
  flags.converge = convergeEv ? { ok: convergeEv.ok, sources: convergeEv.sources } : { ok: false, missing: true };
  const deadlockMentions = events.filter(e => /deadlock/i.test(String(e.message ?? '')) || e.code === '40P01').length;
  const refreshRows = await engine.executeRaw('SELECT state, count(*)::int AS n FROM persistence_worktree_refreshes GROUP BY state');
  const switches = events.filter(e => e.ev === 'switch').map(e => ({ role: e.role, refresh_barrier: e.refresh_barrier }));
  const unknown_statuses = [
    ...events.filter(e => e.ev === 'tick_result' && !KNOWN_TICK_STATUSES.has(String(e.status))).map(e => `tick:${e.status}`),
    ...events.filter(e => e.ev === 'sync_result' && !KNOWN_SYNC_STATUSES.has(String(e.status))).map(e => `sync:${e.status}`),
  ];
  // A planned pause that never fired on a tick that did a refresh means the boundary hook no longer matches G; a tick that
  // found the checkout already current never reaches a boundary, so it is counted apart.
  const paused = new Set(events.filter(e => e.ev === 'tick_paused').map(e => e.tick));
  let pausesPlanned = 0, pauseMisses = 0, pauseSkippedCurrent = 0;
  for (const tick of schedule.ticks) {
    if (tick.boundary === 'none') continue;
    pausesPlanned++;
    if (paused.has(tick.index)) continue;
    const r = events.find(e => e.ev === 'tick_result' && e.tick === tick.index && e.mode !== 'resume');
    if (!r) continue;
    if (r.status === 'already_current') pauseSkippedCurrent++; else pauseMisses++;
  }
  const logText = readdirSync(dir).sort().filter(f => f.endsWith('.log')).map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
  flags.too_many_clients = events.filter(e => /too many clients/i.test(String(e.message ?? ''))).length + (logText.match(/too many clients/gi)?.length ?? 0);
  const server = a.engine === 'postgres'
    ? (await engine.executeRaw("SELECT current_setting('max_connections') AS max_connections, current_setting('server_version') AS server_version"))[0] : null;
  const effects = await engine.executeRaw(`SELECT kind, state, error_code, (data ? 'parked') AS parked, outcome->>'push' AS push, count(*)::int AS n
    FROM persistence_effects GROUP BY 1,2,3,4,5 ORDER BY 1,2,3`);
  const openEffects = (flags.quiesce as { ok?: boolean })?.ok ? [] : await engine.executeRaw(`SELECT e.state, e.kind, left(coalesce(e.data::text,''),300) AS data,
    left(row_to_json(e)::text, 1200) AS row FROM persistence_effects e WHERE e.state IN ('queued','running') ORDER BY e.id LIMIT 5`).catch((error: unknown) => [{ error: String(error) }]);
  const result = {
    seed: a.seed, arm: a.arm, engine: a.engine, block: a.quiet ? 'quiet' : 'trials', provenance: { gbrain_sha: gitHead(a.gbrainRoot), harness_digest: harnessDigest() },
    faults: { tick_killed: events.filter(e => e.ev === 'tick_killed').length, writer_killed: events.filter(e => e.ev === 'writer_killed').length },
    schedule_version: schedule.version, strata: schedule.strata, server, switches, unknown_statuses,
    pauses_planned: pausesPlanned, pause_misses: pauseMisses, pause_skipped_current: pauseSkippedCurrent, refresh_windows: refreshWindows,
    writers: schedule.writers.length, ticks_planned: schedule.ticks.length, max_wait_ms: schedule.max_wait_ms,
    flags: { ...flags, deadlocks, deadlock_mentions: deadlockMentions, child_errors: childErrors.length,
      push_errors: events.filter(e => e.ev === 'push_error').length, foreign_commit_errors: events.filter(e => e.ev === 'foreign_commit_error').length },
    child_errors: childErrors.slice(0, 20).map(e => ({ role: e.role, code: e.code, message: String(e.message ?? '').slice(0, 300) })),
    ticks, pauses: events.filter(e => e.ev === 'tick_paused').map(e => ({ tick: e.tick, t: e.t, point: e.point, pause_ms: e.pause_ms })),
    refresh_rows: refreshRows, effects, open_effects: openEffects, upstream: verdict.upstream, ledger_present: verdict.ledger_present,
    timings: { ...timings, total_ms: Date.now() - started }, ops: verdict.ops,
  };
  if (a.engine === 'postgres') { await engine.disconnect(); if (!a.keep) await dropDb?.(); }
  else { await g.service.disposePersistenceConsumer(engine); await engine.disconnect(); }
  return result;
}

/** Another machine pushes each tick's files push_lead_ms before the tick runs. */
function upstreamLine(schedule: TrialSchedule, paths: ReturnType<typeof brainPaths>, t0: number, log: (e: Record<string, unknown>) => void): Promise<void> {
  return (async () => {
    for (const tick of schedule.ticks) {
      await sleep(t0 + tick.at_ms - tick.push_lead_ms - Date.now());
      try { log({ ev: 'tick_pushed', tick: tick.index, head: pushTick(paths, tick) }); }
      catch (error) { log({ ev: 'push_error', tick: tick.index, message: String(error).slice(0, 400) }); }
    }
  })();
}

/**
 * Waits up to QUIESCE_LIMIT_MS for every request, refresh and Git effect to settle, and with derived also for non-Git effects
 * (links, facts-backstop) while a consumer is still alive to run their retries. Only requests, refreshes and Git effects
 * decide ok; a non-Git effect still open at the limit is reported (analyze.ts residual_recovery_required), never a failure.
 */
export async function quiesce(engine: any, opts: { derived?: boolean } = {}): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let last: Record<string, number> = {};
  const settled = () => !last.open_requests && !last.active_refreshes && !last.open_effects;
  while (Date.now() - startedAt < QUIESCE_LIMIT_MS) {
    last = (await engine.executeRaw(QUIESCE_SQL))[0];
    if (settled() && (!opts.derived || !last.open_derived)) return { ok: true, ms: Date.now() - startedAt };
    await sleep(500);
  }
  return { ok: settled(), ms: Date.now() - startedAt, ...last };
}

if (import.meta.main) {
  const a = parseArgs(process.argv.slice(2));
  const outDir = join(a.out, a.quiet ? 'quiet' : 'trials', a.engine, a.arm);
  const resultPath = join(outDir, `${a.seed}.json`);
  if (process.argv.includes('--replace') && countedRunIn(a.out)) {
    process.stderr.write(`trial: --replace refuses inside ${a.out}, which holds a counted run; replay into another --out\n`);
    process.exit(2);
  }
  if (existsSync(resultPath) && !process.argv.includes('--replace')) {
    process.stderr.write(`trial: ${resultPath} already holds a result, which a replay must not overwrite; use another --out (or --replace in a development directory)\n`);
    process.exit(2);
  }
  const result = await runTrial(a);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resultPath, JSON.stringify(result), { flag: process.argv.includes('--replace') ? 'w' : 'wx' });
  if (!a.keep && failureClasses(result, 'trial').length === 0) rmSync(join(a.out, 'work', workName(a)), { recursive: true, force: true });
  process.exit(0);
}
