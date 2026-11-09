/**
 * What every nightly system smoke shares: a keyless environment, the gbrain CLI and server of one build, a scratch
 * Postgres database, a hermetic Git, and the result shape the nightly runner reads.
 *
 * Every gbrain process a smoke starts gets an explicit allowlist environment. No provider key or other secret-shaped
 * variable reaches it (`keylessEnv` refuses one, by the same rule as the refresh-barrier trials), every provider base
 * URL points at a dead loopback port, and HTTP proxies point there too, so a gbrain code path that tried to call a
 * model, an embedding API or the update check would fail at once instead of spending.
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PROVIDER_KEYS } from '../../refresh-barrier/fixture.ts';
import { generateBrain, writeBrain, type SeedBrain } from './brain.ts';

export { PROVIDER_KEYS };

export interface SmokeResult { id: string; pass: boolean; code: string; detail: string; ms: number }

export interface SmokeOptions {
  /** Tonight's gbrain (a verified overlay or checkout with src/cli.ts). */
  tonightRoot: string;
  /** The previous night's gbrain, for the upgrade smokes. */
  previousRoot: string;
  /** An old release before managed persistence (OLD_RELEASE), for upgrade-from-old. */
  oldRoot: string;
  /** Results and per-smoke logs land under this directory. */
  out: string;
  /** Admin URLs of the two Postgres servers (pgvector images); a smoke that needs one it lacks fails as a harness error. */
  postgres: { current?: string; pg15?: string };
}

export interface SmokeContext extends SmokeOptions {
  id: string;
  /** A fresh scratch directory for this smoke. */
  work: string;
  /** Appends one line to out/<id>/smoke.log. */
  log: (line: string) => void;
}

/** A smoke's verdict. Codes starting with harness_ mean the smoke could not run, never that gbrain failed. */
export class SmokeFail extends Error {
  constructor(readonly code: string, readonly detail: string) { super(`${code}: ${detail}`); }
}
export const fail = (code: string, detail: string): never => { throw new SmokeFail(code, detail); };
export const check = (ok: unknown, code: string, detail: string | (() => string)): void => {
  if (!ok) fail(code, typeof detail === 'function' ? detail() : detail);
};

export const DEAD_UPSTREAM = 'http://127.0.0.1:9';
export const BASE_URL_VARS = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GOOGLE_GENERATIVE_AI_BASE_URL', 'VOYAGE_BASE_URL', 'LITELLM_BASE_URL',
  'OLLAMA_BASE_URL', 'LMSTUDIO_BASE_URL', 'LLAMA_SERVER_BASE_URL', 'LLAMA_SERVER_RERANKER_BASE_URL', 'OPENROUTER_BASE_URL'] as const;

export interface BrainDirs { home: string; userHome: string; gitConfig: string }

/** A hermetic Git config: a fixed identity, no system file, hooks, signing or credential helper. */
export function hermeticGitConfig(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '[user]\n\tname = Example\n\temail = example@example.invalid\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\thooksPath = /dev/null\n[advice]\n\tdetachedHead = false\n');
  return path;
}

/** Fresh GBRAIN_HOME, HOME and Git config under `dir`. */
export function brainDirs(dir: string): BrainDirs {
  const d = { home: join(dir, 'gbrain-home'), userHome: join(dir, 'user-home'), gitConfig: join(dir, 'gitconfig') };
  mkdirSync(d.home, { recursive: true }); mkdirSync(d.userHome, { recursive: true });
  hermeticGitConfig(d.gitConfig);
  return d;
}

/**
 * The only environment a smoke's gbrain process sees. `extra` may add settings such as DATABASE_URL, never a key:
 * any name PROVIDER_KEYS matches is refused, and so is a base URL that does not point at the dead upstream.
 */
export function keylessEnv(d: BrainDirs, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: d.userHome, GBRAIN_HOME: d.home,
    GIT_CONFIG_GLOBAL: d.gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1',
    HTTP_PROXY: DEAD_UPSTREAM, HTTPS_PROXY: DEAD_UPSTREAM, ALL_PROXY: DEAD_UPSTREAM, http_proxy: DEAD_UPSTREAM, https_proxy: DEAD_UPSTREAM,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    ...Object.fromEntries(BASE_URL_VARS.map(k => [k, DEAD_UPSTREAM])),
    ...extra,
  };
  assertKeyless(env);
  return env;
}

export function assertKeyless(env: Record<string, string | undefined>): void {
  const baseUrl = (k: string) => (BASE_URL_VARS as readonly string[]).includes(k);
  const secretish = Object.keys(env).filter(k => PROVIDER_KEYS.test(k) && !baseUrl(k));
  if (secretish.length) throw new SmokeFail('harness_env_not_keyless', `refusing to start gbrain with ${secretish.join(', ')} in its environment`);
  const live = BASE_URL_VARS.filter(k => env[k] !== undefined && !env[k]!.startsWith('http://127.0.0.1:'));
  if (live.length) throw new SmokeFail('harness_env_not_keyless', `${live.join(', ')} must point at a loopback port`);
}

export interface Run { code: number; stdout: string; stderr: string; ms: number }

/**
 * Run one gbrain build's CLI by absolute path (bun --no-env-file, so no .env file can add a key back). Aborting
 * `interrupt` sends the process SIGINT, gbrain's graceful cancel (the path Ctrl-C and `sync --timeout` take).
 */
export function gbrain(root: string, args: string[], o: { env: Record<string, string>; cwd?: string; input?: string; timeoutMs?: number; log?: (l: string) => void; interrupt?: AbortSignal }): Promise<Run> {
  assertKeyless(o.env);
  const t0 = Date.now();
  return new Promise(resolve => {
    const proc = spawn('bun', ['--no-env-file', join(root, 'src/cli.ts'), ...args], { env: o.env, cwd: o.cwd ?? o.env.GBRAIN_HOME });
    let stdout = '', stderr = '';
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (c: string) => { if (stdout.length < 4_000_000) stdout += c; });
    proc.stderr.on('data', (c: string) => { if (stderr.length < 4_000_000) stderr += c; });
    proc.stdin.end(o.input ?? '');
    o.interrupt?.addEventListener('abort', () => proc.kill('SIGINT'), { once: true });
    const timer = setTimeout(() => { stderr += `\n[smoke] killed after ${o.timeoutMs ?? 300_000} ms`; proc.kill('SIGKILL'); }, o.timeoutMs ?? 300_000);
    const done = (code: number) => {
      clearTimeout(timer);
      const r = { code, stdout, stderr, ms: Date.now() - t0 };
      o.log?.(`$ gbrain ${args.join(' ').slice(0, 300)}  [exit ${code}, ${r.ms} ms]\n${tail(stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ''), 40)}`);
      resolve(r);
    };
    proc.on('close', c => done(c ?? -1));
    proc.on('error', e => { stderr += `\n${e.message}`; done(-1); });
  });
}

export const tail = (text: string, lines: number) => text.split('\n').filter(l => l.trim()).slice(-lines).join('\n');

/** The first JSON value in a CLI's stdout (gbrain prints notices around --json output on some releases). */
export function jsonOut<T = any>(r: Run): T | null {
  const t = r.stdout.trim();
  try { return JSON.parse(t) as T; } catch { /* look for the first object */ }
  for (const open of ['{', '[']) {
    const at = t.indexOf(open);
    if (at < 0) continue;
    try { return JSON.parse(t.slice(at)) as T; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * A directory holding a `gbrain` script that runs `root`'s CLI (bun --no-env-file), for a step that shells out to
 * `gbrain` on PATH the way an installed release does (older migrations run `gbrain jobs smoke`). Put it on PATH only for
 * that step; the script inherits the calling gbrain's keyless environment.
 */
export function gbrainOnPath(dir: string, root: string): string {
  const bin = join(dir, 'gbrain-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nexec bun --no-env-file '${join(root, 'src/cli.ts')}' "$@"\n`, { mode: 0o755 });
  return bin;
}

/** Plain git with the hermetic config. */
export function git(cwd: string, d: BrainDirs, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: d.userHome, GIT_CONFIG_GLOBAL: d.gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
}

/** A TCP port nothing listens on right now. */
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}

export interface Server { port: number; url: string; output: () => string; stop: () => Promise<void> }

/** `gbrain serve --http` from one build, ready once GET /health answers 200. */
export async function serveHttp(root: string, o: { env: Record<string, string>; cwd: string; args?: string[]; readyMs?: number; log?: (l: string) => void }): Promise<Server> {
  assertKeyless(o.env);
  const port = await freePort();
  const proc = spawn('bun', ['--no-env-file', join(root, 'src/cli.ts'), 'serve', '--http', '--port', String(port), ...(o.args ?? [])], { env: o.env, cwd: o.cwd });
  let out = '';
  const keep = (c: Buffer) => { out += c.toString('utf8'); if (out.length > 2_000_000) out = out.slice(-1_000_000); };
  proc.stdout.on('data', keep); proc.stderr.on('data', keep);
  const url = `http://127.0.0.1:${port}`;
  const stop = () => new Promise<void>(resolve => {
    if (proc.exitCode !== null) return resolve();
    const t = setTimeout(() => { proc.kill('SIGKILL'); }, 15_000);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
    proc.kill('SIGTERM');
  });
  const deadline = Date.now() + (o.readyMs ?? 120_000);
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })).status === 200) { o.log?.(`serve --http ready on ${port}`); return { port, url, output: () => out, stop }; } } catch { /* not up yet */ }
    await Bun.sleep(300);
  }
  await stop();
  o.log?.(`serve --http never answered /health:\n${tail(out, 30)}`);
  return fail('harness_serve_not_ready', `gbrain serve --http (${root}) never answered GET /health: ${tail(out, 5)}`);
}

/** A fresh, empty database on a Postgres server; drop() removes it. */
export async function scratchDatabase(adminUrl: string, tag: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const { SQL } = await import('bun');
  const name = `smk_${tag.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${process.pid}_${Math.floor(Math.random() * 1e6)}`.slice(0, 60);
  const admin = new SQL(adminUrl);
  try { await admin.unsafe(`CREATE DATABASE ${name}`); } finally { await admin.close(); }
  const u = new URL(adminUrl); u.pathname = `/${name}`;
  return {
    url: u.toString(),
    drop: async () => { const a = new SQL(adminUrl); try { await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await a.close(); } },
  };
}

/** Runs SQL against a database URL and returns the rows. */
export async function sql<T = Record<string, unknown>>(url: string, text: string, params: unknown[] = []): Promise<T[]> {
  const { SQL } = await import('bun');
  const db = new SQL(url);
  try { return await db.unsafe(text, params as any[]) as unknown as T[]; } finally { await db.close(); }
}

/** The commit a gbrain root was built from: an overlay's stamp, else its Git HEAD. */
export function rootCommit(root: string): string {
  const stamp = join(root, '.lifecycle-build.json');
  if (existsSync(stamp)) return JSON.parse(readFileSync(stamp, 'utf8')).commit as string;
  if (existsSync(join(root, '.git'))) return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return fail('harness_root_commit_unknown', `${root} is neither a copied overlay (.lifecycle-build.json) nor a Git checkout, so its commit is unknown`);
}

export const rootVersion = (root: string) => readFileSync(join(root, 'VERSION'), 'utf8').trim();

/** A smoke's scratch directory and logger. */
export function smokeContext(opts: SmokeOptions, id: string): SmokeContext {
  const dir = join(opts.out, id);
  const work = join(dir, 'work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const logPath = join(dir, 'smoke.log');
  writeFileSync(logPath, '');
  return { ...opts, id, work, log: line => appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`) };
}

export interface SeededBrain {
  dirs: BrainDirs;
  env: Record<string, string>;
  /** The source's Git checkout (a clone of `remote` when one was asked for). */
  repo: string;
  /** A bare repository the checkout tracks, when `remote` was set. */
  remote: string | null;
  source: string;
  seed: SeedBrain;
  /** Runs a gbrain CLI from `root` against this brain, logging to the smoke log. */
  cli: (root: string, args: string[], o?: { input?: string; timeoutMs?: number; cwd?: string; interrupt?: AbortSignal }) => Promise<Run>;
  /** Plain git in the checkout. */
  git: (...args: string[]) => string;
}

/**
 * The seeded brain on one gbrain build: the generated pages committed to a Git checkout (optionally a clone of a bare
 * remote), a keyword-only brain (PGLite, or a fresh database at `databaseUrl`), the checkout registered as a source and
 * synced once. Any step that fails is a gbrain failure named `seed_<step>`. With `subdir`, the pages go under that
 * directory of the checkout and the directory is the source. `brain` replaces generateBrain(seed) (for example
 * archiveBrain), and `beforeInit` runs in the checkout after the seed commit and before `gbrain init`, so a smoke can leave
 * uncommitted changes there for the first sync. `migrate` runs the build's own `gbrain apply-migrations --yes` right after
 * init, with that build's gbrain on PATH, as its install's postinstall and every `gbrain upgrade` do, so a brain an older
 * release wrote carries that release's migration history.
 */
export async function seedBrain(ctx: SmokeContext, root: string, o: { name?: string; seed?: number; databaseUrl?: string; remote?: boolean; source?: string;
  subdir?: string; filter?: (path: string) => boolean; env?: Record<string, string>; brain?: SeedBrain; beforeInit?: (repo: string) => void; migrate?: boolean } = {}): Promise<SeededBrain> {
  const dir = join(ctx.work, o.name ?? 'brain');
  const dirs = brainDirs(dir);
  const repo = join(dir, 'repo');
  const remote = o.remote ? join(dir, 'origin.git') : null;
  const g = (cwd: string, ...args: string[]) => git(cwd, dirs, ...args);
  if (remote) {
    mkdirSync(remote, { recursive: true });
    g(remote, 'init', '-q', '--bare', '-b', 'main');
    g(dir, 'clone', '-q', remote, repo);
    g(repo, 'checkout', '-q', '-B', 'main');
  } else {
    mkdirSync(repo, { recursive: true });
    g(repo, 'init', '-q', '-b', 'main');
  }
  const seed = o.brain ?? generateBrain(o.seed ?? 1);
  const sourceDir = o.subdir ? join(repo, o.subdir) : repo;
  writeBrain(sourceDir, seed, o.filter);
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'seed brain');
  if (remote) g(repo, 'push', '-q', '-u', 'origin', 'main');
  o.beforeInit?.(repo);
  const env = keylessEnv(dirs, o.env);
  const cli = (r: string, args: string[], x: { input?: string; timeoutMs?: number; cwd?: string; interrupt?: AbortSignal } = {}) => gbrain(r, args, { env, log: ctx.log, cwd: x.cwd ?? dir, ...x });
  const source = o.source ?? 'vault';
  const steps: Array<[string, string[]]> = [
    ['init', ['init', ...(o.databaseUrl ? ['--url', o.databaseUrl] : ['--pglite', '--path', join(dirs.home, 'brain.pglite')]), '--no-embedding', '--non-interactive']],
    ...(o.migrate ? [['migrate', ['apply-migrations', '--yes', '--non-interactive', '--no-autopilot-install']] as [string, string[]]] : []),
    ['sources_add', ['sources', 'add', source, '--path', sourceDir]],
    ['sync', ['sync', '--source', source, '--no-pull']],
  ];
  for (const [step, args] of steps) {
    const r = step === 'migrate'
      ? await gbrain(root, args, { env: { ...env, PATH: `${gbrainOnPath(dir, root)}:${env.PATH}` }, log: ctx.log, cwd: dir, timeoutMs: 600_000 })
      : await cli(root, args, { timeoutMs: 600_000 });
    check(r.code === 0, `seed_${step}`, () => `gbrain ${args[0]} exited ${r.code} on ${rootVersion(root)}: ${tail(r.stdout + '\n' + r.stderr, 6)}`);
  }
  return { dirs, env, repo, remote, source, seed, cli, git: (...args: string[]) => g(repo, ...args) };
}

/**
 * Upgrades a brain in place to `root`'s build the way `gbrain upgrade` does once the new build is installed: its
 * post-upgrade step runs `apply-migrations --yes --non-interactive`, here as its own command with autopilot installation
 * off, so a failed migration fails the smoke instead of becoming the warning post-upgrade prints. Same GBRAIN_HOME, same
 * database; a nonzero exit is the gbrain failure `upgrade_migrations_failed`.
 */
export async function upgradeBrain(b: SeededBrain, root: string): Promise<Run> {
  const r = await b.cli(root, ['apply-migrations', '--yes', '--non-interactive', '--no-autopilot-install'], { timeoutMs: 600_000 });
  check(r.code === 0, 'upgrade_migrations_failed', () => `gbrain ${rootVersion(root)} apply-migrations exited ${r.code}: ${tail(r.stdout + '\n' + r.stderr, 6)}`);
  return r;
}
