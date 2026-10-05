/**
 * Install the pinned public agent-memory benchmark harness for gbrain-evals.
 *
 * The harness is a Python project locked with uv. This module fetches the
 * commit named in eval/harness-provider/harness.lock.json into
 * `.harness/src/<commit>`, exports its lockfile, drops the CUDA-only wheels
 * (nvidia-*, cuda-*, triton) and installs the rest into
 * `.harness/venv/<env-hash>` with `uv pip install --torch-backend cpu`, so torch
 * resolves to its CPU build. The harness package itself installs without
 * dependencies on top. `ready.json` in the venv records what was installed;
 * a venv whose ready.json does not match the lock is rebuilt.
 *
 * Nothing here reads a `.env` file. The harness CLI calls
 * `load_dotenv(..., override=True)`; the Python side (mpw/register.py)
 * replaces that call with a no-op and runners also set
 * PYTHON_DOTENV_DISABLED=1.
 *
 *   bun eval/runner/harness-env.ts            install (idempotent) and print the paths
 *   bun eval/runner/harness-env.ts --check    exit 1 unless the install matches the lock
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dir, '../..');
export const PROVIDER_DIR = join(REPO_ROOT, 'eval/harness-provider');
export const LOCK_PATH = join(PROVIDER_DIR, 'harness.lock.json');
export const HARNESS_HOME = join(REPO_ROOT, '.harness');

export interface HarnessLock {
  format: 'gbrain-evals-harness-lock';
  schema_version: 1;
  harness_repo: string;
  harness_commit: string;
  python: string;
  torch_backend: 'cpu';
  excluded_requirements: string[];
  extra_requirements: string[];
  comparator: { registry_key_sha256: string; [k: string]: unknown };
  /** Dataset files the harness loaders cannot fetch themselves, pinned by content hash. */
  datasets?: Record<string, { env: string; file: string; url: string; sha256: string; why?: string }>;
}

export interface HarnessInstall {
  lock: HarnessLock;
  /** sha256 of the lock file bytes. */
  lock_sha256: string;
  src: string;
  venv: string;
  python: string;
  /** PYTHONPATH that makes `python -m mpw` importable. */
  pythonpath: string;
  torch_version: string;
  /** Environment variables pointing the harness loaders at pinned dataset files. */
  dataset_env: Record<string, string>;
}

export function readLock(path = LOCK_PATH): { lock: HarnessLock; sha256: string } {
  const bytes = readFileSync(path);
  const lock = JSON.parse(bytes.toString('utf8')) as HarnessLock;
  if (lock.format !== 'gbrain-evals-harness-lock' || lock.schema_version !== 1) throw new Error(`${path} is not a schema 1 harness lock`);
  if (!/^[0-9a-f]{40}$/.test(lock.harness_commit)) throw new Error(`${path}: harness_commit must be a full 40-character sha`);
  return { lock, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): string {
  const proc = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed (exit ${proc.exitCode}): ${proc.stderr.toString().slice(-2000)}`);
  }
  return proc.stdout.toString();
}

/** Lines of `uv export` output with the CUDA-only wheels removed. */
export function cpuRequirements(exported: string, excluded: readonly string[]): string {
  return exported.split('\n')
    .filter(line => !excluded.some(prefix => line.trim().toLowerCase().startsWith(prefix)))
    .join('\n');
}

export function ensureHarnessSource(lock: HarnessLock, log: (l: string) => void = () => {}): string {
  const src = join(HARNESS_HOME, 'src', lock.harness_commit);
  const head = existsSync(join(src, '.git')) ? Bun.spawnSync(['git', '-C', src, 'rev-parse', 'HEAD']).stdout.toString().trim() : '';
  if (head === lock.harness_commit) return src;
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  log(`[harness] fetching ${lock.harness_commit.slice(0, 12)} into ${src}`);
  run(['git', 'init', '-q'], { cwd: src });
  run(['git', 'fetch', '-q', '--depth', '1', lock.harness_repo, lock.harness_commit], { cwd: src });
  run(['git', 'checkout', '-q', 'FETCH_HEAD'], { cwd: src });
  const got = run(['git', 'rev-parse', 'HEAD'], { cwd: src }).trim();
  if (got !== lock.harness_commit) throw new Error(`harness checkout is ${got}, expected ${lock.harness_commit}`);
  return src;
}

export function ensureHarness(options: { log?: (l: string) => void; checkOnly?: boolean } = {}): HarnessInstall {
  const log = options.log ?? (l => process.stderr.write(l + '\n'));
  const { lock, sha256 } = readLock();
  const envHash = sha256.slice(0, 16);
  const venv = join(HARNESS_HOME, 'venv', envHash);
  const python = join(venv, 'bin', 'python');
  const readyPath = join(venv, 'ready.json');
  const src = join(HARNESS_HOME, 'src', lock.harness_commit);
  const result = (torch: string): HarnessInstall => ({ lock, lock_sha256: sha256, src, venv, python, pythonpath: PROVIDER_DIR, torch_version: torch, dataset_env: options.checkOnly ? datasetEnv(lock) : ensureDatasets(lock, log) });
  if (existsSync(readyPath)) {
    const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as { lock_sha256: string; torch_version: string };
    if (ready.lock_sha256 === sha256 && existsSync(python)) return result(ready.torch_version);
  }
  if (options.checkOnly) throw new Error(`the harness venv for lock ${envHash} is not installed; run \`bun run harness:setup\``);
  ensureHarnessSource(lock, log);
  rmSync(venv, { recursive: true, force: true });
  mkdirSync(venv, { recursive: true });
  log(`[harness] exporting the harness lockfile and installing CPU-only wheels into ${venv}`);
  const exported = run(['uv', 'export', '--frozen', '--no-hashes', '--no-dev', '--no-emit-project'], { cwd: src });
  const reqPath = join(venv, 'requirements.cpu.txt');
  writeFileSync(reqPath, cpuRequirements(exported, lock.excluded_requirements) + '\n' + lock.extra_requirements.join('\n') + '\n');
  run(['uv', 'venv', '-q', '--allow-existing', '-p', lock.python, venv]);
  const env = { VIRTUAL_ENV: venv, UV_PYTHON: python };
  run(['uv', 'pip', 'install', '-q', '--torch-backend', lock.torch_backend, '-r', reqPath], { env });
  run(['uv', 'pip', 'install', '-q', '--no-deps', src], { env });
  const torch = run([python, '-c', 'import torch; print(torch.__version__)']).trim();
  if (!torch.endsWith('+cpu')) throw new Error(`torch installed as ${torch}, expected a +cpu build`);
  writeFileSync(readyPath, JSON.stringify({ lock_sha256: sha256, harness_commit: lock.harness_commit, torch_version: torch, installed_at: new Date().toISOString() }, null, 2) + '\n');
  return result(torch);
}

const DATASET_DIR = join(HARNESS_HOME, 'datasets');

function datasetEnv(lock: HarnessLock): Record<string, string> {
  return Object.fromEntries(Object.values(lock.datasets ?? {}).map(d => [d.env, join(DATASET_DIR, d.file)]));
}

/** Download each pinned dataset file once and verify its sha256. */
export function ensureDatasets(lock: HarnessLock, log: (l: string) => void = () => {}): Record<string, string> {
  mkdirSync(DATASET_DIR, { recursive: true });
  for (const [name, d] of Object.entries(lock.datasets ?? {})) {
    const path = join(DATASET_DIR, d.file);
    const ok = () => existsSync(path) && createHash('sha256').update(readFileSync(path)).digest('hex') === d.sha256;
    if (ok()) continue;
    log(`[harness] downloading the pinned ${name} file`);
    run(['curl', '-sSfL', '-o', path, d.url]);
    if (!ok()) throw new Error(`${name}: ${d.url} does not match the pinned sha256 ${d.sha256.slice(0, 12)}`);
  }
  return datasetEnv(lock);
}

/**
 * Environment for a harness Python process: the venv's python first on PATH,
 * mpw importable, dotenv disabled, unbuffered output. Callers add the cell's
 * declared credentials (proxy tokens) and nothing else.
 */
export function harnessProcessEnv(install: HarnessInstall, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    PATH: `${join(install.venv, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: process.env.HOME ?? '/tmp',
    PYTHONPATH: install.pythonpath,
    PYTHON_DOTENV_DISABLED: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    VIRTUAL_ENV: install.venv,
    HF_HUB_DISABLE_TELEMETRY: '1',
    TOKENIZERS_PARALLELISM: 'false',
    MPW_DATASET_CACHE: join(DATASET_DIR, 'cache'),
  };
  for (const k of ['LANG', 'LC_ALL', 'TMPDIR', 'HF_HOME', 'XDG_CACHE_HOME']) if (process.env[k]) base[k] = process.env[k]!;
  return { ...base, ...install.dataset_env, ...extra };
}

if (import.meta.main) {
  const install = ensureHarness({ checkOnly: process.argv.includes('--check') });
  console.log(JSON.stringify({ src: install.src, venv: install.venv, python: install.python, torch: install.torch_version, lock_sha256: install.lock_sha256 }, null, 2));
}
