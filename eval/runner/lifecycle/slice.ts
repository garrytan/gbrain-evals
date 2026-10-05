import { createServer, type AddressInfo } from 'node:net';
/**
 * A lifecycle slice cell for the eval-category wave (N1 knowledge update, N5
 * forgetting residue; amendment 5): one gbrain build, one engine, one
 * transport, set up the way `lifecycle-experiment.ts` sets up its cells.
 *
 * - The build is the pinned dependency or a copied `--gbrain` overlay
 *   (gbrain-under-test.ts); every process runs `<build>/src/cli.ts`.
 * - Keyless: the child environment is built from scratch (PATH, HOME, a
 *   fresh GBRAIN_HOME per cell, TZ=UTC), no provider key and no embedding
 *   model, so System One is off by construction. `decide status` is read
 *   once per cell and every slot must be effectively off (presence).
 * - A git vault is the default source, so page writes land as Markdown files
 *   and a full sync can reimport them.
 * - `primary` is the transport under test (trusted local CLI, stdio MCP or
 *   HTTP MCP with an OAuth client bound to the vault). `trusted()` runs reads
 *   as the trusted local CLI caller. A PGLite database admits one process,
 *   so on PGLite remote cells trusted reads and operator steps pause the
 *   server and start it again; Postgres needs no pause.
 * - Every primary call is recorded (op, ok, raw text, latency) so a category
 *   can scan remote responses for protected markers.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQL } from 'bun';
import { strippedKeysIn } from '../hermetic-env.ts';
import { CliDriver, McpHttpClient, McpHttpDriver, McpStdioDriver, runCli, type CallResult, type Driver, type RunEnv } from './drivers.ts';

export type Engine = 'pglite' | 'postgres';
export type Iface = 'cli' | 'mcp-stdio' | 'mcp-http';
export const ENGINES: readonly Engine[] = ['pglite', 'postgres'];
export const IFACES: readonly Iface[] = ['cli', 'mcp-stdio', 'mcp-http'];

export interface OperatorStep { step: string; args: string[]; code: number; ms: number; tail: string }
export interface RecordedCall { op: string; args: Record<string, unknown>; ok: boolean; error?: string; raw: string; ms: number; caller: 'primary' | 'trusted' | 'extra'; /** JSON of the MCP `_meta` block, when present. */ meta?: string }

export interface HttpClientSpec { name: string; scopes: string; source: string }

export interface SliceOptions {
  buildDir: string;
  engine: Engine;
  iface: Iface;
  work: string;
  label: string;
  pgAdminUrl: string;
  port: number;
  /** Extra git-vault sources besides `vault` (the default). */
  extraSources?: string[];
  /** Extra OAuth clients registered on mcp-http cells (authority probes). */
  extraClients?: HttpClientSpec[];
}

function git(dir: string, args: string[]) {
  execFileSync('git', ['-C', dir, '-c', 'user.name=slice-eval', '-c', 'user.email=slice-eval@example.invalid', ...args], { stdio: 'ignore' });
}

const redact = (t: string) => t.replace(/gbrain_cs_[0-9a-f]+/g, 'gbrain_cs_<redacted>').replace(/(postgres(?:ql)?:\/\/[^:/@\s]+):[^@\s]+@/g, '$1:<redacted>@');

/** Wraps a driver so every call is recorded. */
class RecordingDriver implements Driver {
  constructor(readonly inner: Driver, private sink: RecordedCall[], private caller: RecordedCall['caller']) {}
  get kind() { return this.inner.kind; }
  get remote() { return this.inner.remote; }
  start() { return this.inner.start(); }
  restart() { return this.inner.restart(); }
  close() { return this.inner.close(); }
  sessions() { return this.inner.sessions(); }
  async call(op: string, args: Record<string, unknown>): Promise<CallResult> {
    const r = await this.inner.call(op, args);
    this.sink.push({ op, args, ok: r.ok, ...(r.error ? { error: r.error.slice(0, 500) } : {}), raw: r.raw, ms: r.ms, caller: this.caller, ...(r.meta !== undefined ? { meta: JSON.stringify(r.meta) } : {}) });
    return r;
  }
}

export class SliceCell {
  readonly id: string;
  readonly dir: string;
  readonly home: string;
  readonly vaults: Record<string, string> = {};
  readonly run: RunEnv;
  readonly operatorLog: OperatorStep[] = [];
  readonly calls: RecordedCall[] = [];
  readonly decideOff: { ok: boolean; slots: Array<{ slot: string; effective: string }>; error?: string } = { ok: false, slots: [] };
  readonly childKeys: string[];
  primary!: Driver;
  private trustedDriver: Driver;
  private pgDb: string | null = null;
  private clients = new Map<string, { id: string; secret: string; scope: string }>();
  serverVersion = '';

  constructor(readonly opts: SliceOptions) {
    this.id = `${opts.label}-${opts.engine}-${opts.iface}`;
    this.dir = join(opts.work, this.id);
    this.home = join(this.dir, 'gbrain-home');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: join(this.dir, 'user-home'), GBRAIN_HOME: this.home,
      GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
    };
    this.childKeys = strippedKeysIn(env);
    this.run = { buildDir: opts.buildDir, env };
    this.trustedDriver = new RecordingDriver(new CliDriver(this.run), this.calls, 'trusted');
  }

  get remote(): boolean { return this.opts.iface !== 'cli'; }
  /** PGLite admits one process: a live server must stop while the CLI opens the database. */
  private get mustPause(): boolean { return this.opts.engine === 'pglite' && this.remote; }

  async operator(step: string, args: string[], timeout = 600_000): Promise<{ code: number; stdout: string; stderr: string }> {
    const r = await runCli(this.run, args, timeout);
    const shown = args.map(redact);
    const lines = redact(r.stdout + '\n' + r.stderr).split('\n').filter(l => l.trim());
    this.operatorLog.push({ step, args: shown, code: r.code, ms: r.ms, tail: lines.slice(-8).join('\n') });
    appendFileSync(join(this.dir, 'operator.log'), `\n===== ${step} (exit ${r.code}, ${r.ms}ms): gbrain ${shown.join(' ')}\n${redact(r.stdout)}\n--- stderr ---\n${redact(r.stderr)}\n`);
    return r;
  }

  private async paused<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.mustPause) return fn();
    await this.primary.close();
    try { return await fn(); } finally { await this.primary.start(); }
  }

  /** Run reads as the trusted local CLI caller. On the CLI cell this is the primary itself. */
  async trusted<T>(fn: (d: Driver) => Promise<T>): Promise<T> {
    if (!this.remote) return fn(this.primary);
    return this.paused(() => fn(this.trustedDriver));
  }

  /** An operator step that opens the database (sync, extract): pauses the server on PGLite. */
  async maintenance(step: string, args: string[]) {
    return this.paused(() => this.operator(step, args));
  }

  async restart() { await this.primary.restart(); }

  commitVaults(message: string) {
    for (const v of Object.values(this.vaults)) {
      git(v, ['add', '-A']);
      git(v, ['commit', '-q', '--allow-empty', '-m', message]);
    }
  }

  /** A session as one of the extra OAuth clients against the running HTTP server, or null off mcp-http. */
  async extraClient(name: string): Promise<Driver | null> {
    const client = this.clients.get(name);
    if (!client || !(this.primary instanceof RecordingDriver) || !(this.primary.inner instanceof McpHttpDriver)) return null;
    const session = new McpHttpClient(this.primary.inner.port, client);
    const sink = this.calls;
    let ready: Promise<void> | null = null;
    const driver: Driver = {
      kind: 'mcp-http', remote: true,
      start: async () => { await session.initialize(); },
      restart: async () => { await session.initialize(); },
      close: async () => {},
      sessions: () => 0,
      call: async (op, args) => {
        ready ??= session.initialize();
        try { await ready; } catch (e) { const r = { ok: false, data: null, error: `client ${name} could not open a session: ${(e as Error).message}`, raw: '', ms: 0 }; sink.push({ op, args, ok: false, error: r.error, raw: '', ms: 0, caller: 'extra' }); return r; }
        const r = await session.call(op, args);
        sink.push({ op, args, ok: r.ok, ...(r.error ? { error: r.error.slice(0, 500) } : {}), raw: r.raw, ms: r.ms, caller: 'extra', ...(r.meta !== undefined ? { meta: JSON.stringify(r.meta) } : {}) });
        return r;
      },
    };
    return driver;
  }

  async setup(): Promise<void> {
    const { engine, iface } = this.opts;
    rmSync(this.dir, { recursive: true, force: true });
    for (const d of [this.home, this.run.env.HOME!]) mkdirSync(d, { recursive: true });
    if (this.childKeys.length) throw new Error(`child environment carries provider keys: ${this.childKeys.join(', ')}`);
    const dbArgs: string[] = [];
    if (engine === 'pglite') dbArgs.push('--pglite', '--path', join(this.home, 'brain.pglite'));
    else {
      this.pgDb = `sl_${this.id.replace(/[^a-z0-9]/g, '_')}_${process.pid}`;
      const admin = new SQL(this.opts.pgAdminUrl);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${this.pgDb}`);
      await admin.unsafe(`CREATE DATABASE ${this.pgDb}`);
      await admin.close();
      const u = new URL(this.opts.pgAdminUrl);
      u.pathname = `/${this.pgDb}`;
      dbArgs.push('--url', u.toString());
    }
    const init = await this.operator('init', ['init', ...dbArgs, '--no-embedding', '--non-interactive']);
    if (init.code !== 0) throw new Error(`init failed: ${this.operatorLog.at(-1)!.tail}`);

    for (const name of ['vault', ...(this.opts.extraSources ?? [])]) {
      const v = join(this.dir, `${name}-vault`);
      mkdirSync(v, { recursive: true });
      git(v, ['init', '-q']);
      writeFileSync(join(v, 'README.md'), `# ${name}\n\nA fictional vault for a gbrain-evals lifecycle slice.\n`);
      git(v, ['add', '-A']);
      git(v, ['commit', '-q', '-m', 'init']);
      this.vaults[name] = v;
      const add = await this.operator(`sources-add:${name}`, ['sources', 'add', name, '--path', v]);
      if (add.code !== 0) throw new Error(`sources add ${name} failed: ${this.operatorLog.at(-1)!.tail}`);
    }
    const def = await this.operator('sources-default', ['sources', 'default', 'vault']);
    if (def.code !== 0) throw new Error(`sources default failed: ${this.operatorLog.at(-1)!.tail}`);

    const decide = await this.operator('decide-status', ['decide', 'status', '--json']);
    try {
      const status = JSON.parse(decide.stdout) as { slots?: Array<{ slot: string; effective: string }> };
      const slots = (status.slots ?? []).map(s => ({ slot: s.slot, effective: s.effective }));
      Object.assign(this.decideOff, { ok: slots.length > 0 && slots.every(s => s.effective === 'off'), slots });
    } catch (e) {
      Object.assign(this.decideOff, { ok: false, error: `decide status did not return JSON: ${(e as Error).message}` });
    }

    let main = { id: '', secret: '' };
    if (iface === 'mcp-http') {
      const specs: HttpClientSpec[] = [{ name: 'main', scopes: 'read write', source: 'vault' }, ...(this.opts.extraClients ?? [])];
      for (const spec of specs) {
        const t = await this.operator(`auth-register-client:${spec.name}`, ['auth', 'register-client', `slice-${spec.name}`, '--grant-types', 'client_credentials', '--scopes', spec.scopes, '--source', spec.source]);
        const id = (t.stdout.match(/gbrain_cl_[0-9a-f]+/) ?? [''])[0];
        const secret = (t.stdout.match(/gbrain_cs_[0-9a-f]+/) ?? [''])[0];
        if (!id || !secret) throw new Error(`could not register OAuth client ${spec.name}: ${this.operatorLog.at(-1)!.tail}`);
        this.clients.set(spec.name, { id, secret, scope: spec.scopes });
      }
      main = this.clients.get('main')!;
    }
    const inner = iface === 'cli' ? new CliDriver(this.run) : iface === 'mcp-stdio' ? new McpStdioDriver(this.run) : new McpHttpDriver(this.run, this.opts.port, main);
    this.primary = new RecordingDriver(inner, this.calls, 'primary');
    await this.primary.start();
    if (inner instanceof McpStdioDriver || inner instanceof McpHttpDriver) this.serverVersion = inner.serverVersion;
  }

  stderrTail(): string[] {
    const inner = this.primary instanceof RecordingDriver ? this.primary.inner : null;
    return inner instanceof McpStdioDriver || inner instanceof McpHttpDriver ? inner.stderrTail.slice(-20) : [];
  }

  async close(): Promise<void> {
    await this.primary?.close().catch(() => {});
    if (this.pgDb) {
      try { const admin = new SQL(this.opts.pgAdminUrl); await admin.unsafe(`DROP DATABASE IF EXISTS ${this.pgDb} WITH (FORCE)`); await admin.close(); } catch { /* keep going */ }
    }
  }
}

/**
 * The preferred port when nothing listens on it, else one the OS assigns: concurrent runs (both arms of a decision,
 * N1 beside N5) never collide on a fixed base port.
 */
export async function freePort(preferred: number): Promise<number> {
  const tryListen = (port: number) => new Promise<number | null>(done => {
    const srv = createServer();
    srv.once('error', () => done(null));
    srv.listen(port, '127.0.0.1', () => { const got = (srv.address() as AddressInfo).port; srv.close(() => done(got)); });
  });
  return (await tryListen(preferred)) ?? (await tryListen(0))!;
}

/** Run `fn` over every engine x interface cell with bounded concurrency; results keep matrix order. */
export async function runMatrix<T>(
  engines: readonly Engine[], ifaces: readonly Iface[], concurrency: number, basePort: number,
  fn: (engine: Engine, iface: Iface, port: number) => Promise<T>,
): Promise<T[]> {
  const cells = engines.flatMap(e => ifaces.map(i => [e, i] as const));
  const out: T[] = new Array(cells.length);
  let next = 0;
  const worker = async () => {
    while (next < cells.length) {
      const k = next++;
      out[k] = await fn(cells[k][0], cells[k][1], await freePort(basePort + k));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, cells.length)) }, worker));
  return out;
}

/** Postgres reachable at `url`? Used to report Postgres cells as skipped (with the reason) rather than crash. */
export async function postgresReachable(url: string): Promise<string | null> {
  try {
    const sql = new SQL(url);
    await sql.unsafe('SELECT 1');
    await sql.close();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Collect `key` string values anywhere in a JSON value. */
export function collectStrings(obj: unknown, key: string, out: string[] = []): string[] {
  if (Array.isArray(obj)) { for (const x of obj) collectStrings(x, key, out); return out; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === key && typeof v === 'string') out.push(v);
      else collectStrings(v, key, out);
    }
  }
  return out;
}

export function asRows(data: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}
