/**
 * The scratch brain and the writer processes of the multi-writer behavior suite (eval/runner/multi-writer-behavior.ts).
 *
 * A brain is created the way an operator creates one: a config file in a fresh GBRAIN_HOME, then
 * `gbrain init --migrate-only` through the gbrain under test. Every engine arm gets the same config apart from where the
 * store lives, so the embedding identity (embedding_disabled, gbrain's default width) and the schema pack are equal on
 * PGLite, Postgres and Rust. The child environment is built from nothing: no provider key, no operator config, and the
 * multi-user switch exactly as the run asked for it, so a test setup can never drop the switch silently.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SQL } from 'bun';
import { cliEngineConfig, rustAddonEnv, type EvalEngineKind } from '../eval-engine.ts';
import type { GbrainUnderTest } from '../gbrain-under-test.ts';
import type { OpLine, WorkerOp, WorkerPlan } from './worker.ts';

const WORKER = join(import.meta.dir, 'worker.ts');

/** How the run sets GBRAIN_RUST_MULTIUSER for every child: `on` is exactly `1`, `off` is exactly unset. */
export type SwitchSetting = 'on' | 'off';
export const RUST_MULTIUSER_ENV = 'GBRAIN_RUST_MULTIUSER';

/** The child environment: built from nothing, with the switch as asked and the Rust addon path when set. */
export function childEnv(o: { home: string; userHome: string; switchSetting: SwitchSetting; env?: Record<string, string | undefined> }): Record<string, string> {
  const env = o.env ?? process.env;
  const out: Record<string, string> = {
    PATH: env.PATH ?? '', HOME: o.userHome, GBRAIN_HOME: o.home, GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
    TMPDIR: env.TMPDIR ?? tmpdir(), GBRAIN_HTTP_RATE_LIMIT_IP: '100000000', GBRAIN_HTTP_RATE_LIMIT_TOKEN: '100000000',
    ...(rustAddonEnv(env) as Record<string, string>),
  };
  if (o.switchSetting === 'on') out[RUST_MULTIUSER_ENV] = '1';
  return out;
}

export interface Brain {
  kind: EvalEngineKind;
  work: string;
  home: string;
  env: Record<string, string>;
  databasePath?: string;
  databaseUrl?: string;
  config: Record<string, unknown>;
  cli(args: string[], o?: { input?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  close(): Promise<void>;
}

/** The config every arm gets; only the store location differs. */
export function brainConfig(kind: EvalEngineKind, where: { databasePath?: string; databaseUrl?: string }): Record<string, unknown> {
  return { ...cliEngineConfig(kind, where), embedding_disabled: true, schema_pack: 'gbrain-base-v2' };
}

export async function createBrain(o: { gut: GbrainUnderTest; kind: EvalEngineKind; switchSetting: SwitchSetting; pgAdminUrl?: string; label: string }): Promise<Brain> {
  const work = mkdtempSync(join(tmpdir(), `${o.label}-${o.kind}-`));
  const home = join(work, 'gbrain-home');
  const userHome = join(work, 'user-home');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(userHome, { recursive: true });
  const env = childEnv({ home, userHome, switchSetting: o.switchSetting });
  let databasePath: string | undefined;
  let databaseUrl: string | undefined;
  let dropDb: (() => Promise<void>) | null = null;
  if (o.kind === 'postgres') {
    if (!o.pgAdminUrl) throw new Error('the postgres arm needs --pg-url or LIFECYCLE_PG_URL (a local pgvector server)');
    const db = `${o.label}_${process.pid}_${randomUUID().slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const admin = new SQL(o.pgAdminUrl);
    await admin.unsafe(`CREATE DATABASE ${db}`);
    await admin.close();
    const u = new URL(o.pgAdminUrl);
    u.pathname = `/${db}`;
    databaseUrl = u.toString();
    dropDb = async () => {
      const a = new SQL(o.pgAdminUrl!);
      await a.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
      await a.close().catch(() => {});
    };
  } else {
    databasePath = join(work, o.kind === 'rust' ? 'brain.rust' : 'brain.pglite');
  }
  const config = brainConfig(o.kind, { databasePath, databaseUrl });
  writeFileSync(join(home, '.gbrain', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const cli = (args: string[], co: { input?: string; timeoutMs?: number } = {}) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [join(o.gut.root, 'src/cli.ts'), ...args], { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), co.timeoutMs ?? 300_000);
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.end(co.input ?? '');
  });
  const close = async () => { await dropDb?.(); rmSync(work, { recursive: true, force: true }); };
  const init = await cli(['init', '--migrate-only', '--non-interactive']);
  if (init.code !== 0) {
    await close();
    throw new Error(`gbrain init --migrate-only on a ${o.kind} config exited ${init.code}: ${(init.stderr + init.stdout).trim().split('\n').slice(-6).join(' | ').slice(0, 800)}`);
  }
  return { kind: o.kind, work, home, env, databasePath, databaseUrl, config, cli, close };
}

/** A running worker process: its ready line, its op lines as they arrive, and how to start, stop or kill it. */
export interface Worker {
  ready: Promise<Record<string, unknown>>;
  done: Promise<OpLine[]>;
  ops: OpLine[];
  onOp(fn: (l: OpLine) => void): void;
  go(): void;
  kill(): void;
  /** The last 4,000 characters the worker (and the gbrain code it runs) wrote to stderr. */
  stderr(): string;
  child: ChildProcess;
}

let planSeq = 0;

/** Kill a worker and every `gbrain` process it started (each worker leads its own process group). */
export function killGroup(child: ChildProcess): void {
  try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

export function startWorker(brain: Brain, gut: GbrainUnderTest, plan: Omit<WorkerPlan, 'root' | 'version' | 'kind' | 'databasePath' | 'databaseUrl'>): Worker {
  const full: WorkerPlan = { root: gut.root, version: gut.version, kind: brain.kind, databasePath: brain.databasePath, databaseUrl: brain.databaseUrl, ...plan };
  const file = join(brain.work, `plan-${process.pid}-${planSeq++}.json`);
  writeFileSync(file, JSON.stringify(full));
  const child = spawn(process.execPath, [WORKER, file], { env: brain.env, cwd: brain.home, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const ops: OpLine[] = [];
  const listeners: Array<(l: OpLine) => void> = [];
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', d => { stderr = (stderr + d).slice(-20000); });
  let onReady!: (l: Record<string, unknown>) => void;
  let onDone!: (l: OpLine[]) => void;
  let fail!: (e: Error) => void;
  let settled = false;
  const ready = new Promise<Record<string, unknown>>((res, rej) => { onReady = res; fail = rej; });
  const done = new Promise<OpLine[]>((res, rej) => {
    onDone = l => { settled = true; res(l); };
    const earlier = fail;
    fail = e => { earlier(e); if (!settled) { settled = true; rej(e); } };
  });
  ready.catch(() => {});
  done.catch(() => {});
  let buf = '';
  child.stdout!.setEncoding('utf8').on('data', chunk => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop()!;
    for (const part of parts) {
      if (!part.trim()) continue;
      let line: Record<string, unknown>;
      try { line = JSON.parse(part); } catch { continue; }
      if (line.kind === 'ready') onReady(line);
      else if (line.kind === 'fatal') fail(Object.assign(new Error(`worker fatal at ${String(line.stage)}: ${String(line.code)}: ${String(line.message)}`), { code: line.code, fatal: line }));
      else if (line.kind === 'op') { ops.push(line as unknown as OpLine); for (const f of listeners) f(line as unknown as OpLine); }
      else if (line.kind === 'done') { onDone(ops); if (!plan.hold) child.stdin!.end(); }
    }
  });
  child.on('close', code => fail(Object.assign(new Error(`worker exited ${code} before it finished: ${stderr.trim().split('\n').slice(-4).join(' | ').slice(0, 600)}`), { code: 'worker_exit', exit: code })));
  return {
    ready, done, ops, child,
    onOp: fn => { listeners.push(fn); },
    go: () => { child.stdin!.write('go\n'); },
    kill: () => { killGroup(child); },
    stderr: () => stderr,
  };
}

/**
 * Run writers together: every worker is started, all report ready, then all get `go` at once. Returns every op line,
 * and the ready lines, or the start failure of a worker that could not open the brain.
 */
export interface WritersRun { ops: Array<OpLine & { worker: number }>; ready: Array<Record<string, unknown>>; startErrors: Array<{ worker: number; code: string; message: string }>; workers: Worker[]; stderr: string }

export async function runWriters(brain: Brain, gut: GbrainUnderTest, plans: Array<Omit<WorkerPlan, 'root' | 'version' | 'kind' | 'databasePath' | 'databaseUrl'>>, o: { onOp?: (w: number, l: OpLine, all: Worker[]) => void; timeoutMs?: number } = {}): Promise<WritersRun> {
  const workers = plans.map(p => startWorker(brain, gut, p));
  const startErrors: Array<{ worker: number; code: string; message: string }> = [];
  const ready: Array<Record<string, unknown>> = [];
  const timeout = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${what} timed out after ${ms} ms`), { code: 'harness_timeout' })), ms))]);
  for (const [i, w] of workers.entries()) {
    try { ready[i] = await timeout(w.ready, o.timeoutMs ?? 180_000, `worker ${i} ready`); } catch (e) { startErrors.push({ worker: i, code: String((e as { code?: unknown }).code ?? 'start_failed'), message: String((e as Error).message).slice(0, 800) }); }
  }
  workers.forEach((w, i) => { if (o.onOp) w.onOp(l => o.onOp!(i, l, workers)); });
  for (const [i, w] of workers.entries()) if (ready[i]) w.go();
  const ops: Array<OpLine & { worker: number }> = [];
  for (const [i, w] of workers.entries()) {
    if (!ready[i]) { w.kill(); continue; }
    try { await timeout(w.done, o.timeoutMs ?? 600_000, `worker ${i} done`); } catch (e) {
      if (!plans[i]!.hold) startErrors.push({ worker: i, code: String((e as { code?: unknown }).code ?? 'worker_failed'), message: String((e as Error).message).slice(0, 800) });
    }
    for (const l of w.ops) ops.push({ ...l, worker: i });
    if (!plans[i]!.hold) w.kill();
  }
  return { ops, ready, startErrors, workers, stderr: workers.map(w => w.stderr()).join('\n') };
}

/** One operation, run alone in an engine-mode worker (the operator's read or write between phases). */
export async function operatorCall(brain: Brain, gut: GbrainUnderTest, op: string, params: Record<string, unknown>): Promise<OpLine> {
  const r = await runWriters(brain, gut, [{ mode: 'engine', lanes: [[{ op, params, tag: 'operator' } as WorkerOp]] }]);
  if (r.startErrors.length) return { kind: 'op', lane: 0, i: 0, op, tag: 'operator', ok: false, t0: 0, t1: 0, ms: 0, code: r.startErrors[0]!.code, message: r.startErrors[0]!.message };
  return r.ops[0]!;
}

/** Several operations in order, in one engine-mode worker with one lane. */
export async function operatorCalls(brain: Brain, gut: GbrainUnderTest, calls: WorkerOp[], o: { probe?: boolean } = {}): Promise<{ ops: OpLine[]; ready?: Record<string, unknown>; startError?: { code: string; message: string } }> {
  const r = await runWriters(brain, gut, [{ mode: 'engine', lanes: [calls], probe: o.probe }]);
  return { ops: r.ops, ready: r.ready[0], ...(r.startErrors.length ? { startError: { code: r.startErrors[0]!.code, message: r.startErrors[0]!.message } } : {}) };
}
