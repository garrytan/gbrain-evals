import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadReceipt } from './receipt.ts';
import {
  compareSituationRecall, effectiveRegressionConfig, profileBudget, regressionHash,
  validateRegressionCell, validateRegressionManifest,
  inspectRegressionRunnerTree,
  effectiveRegressionFileConfig,
} from './situation-recall-regression.ts';
import { resolveRegressionProduct } from './situation-recall-provenance.ts';
import type {
  RegressionCellResult, RegressionCellSpec, RegressionDecision, RegressionManifest, RegressionProfile,
} from './situation-recall-contract.ts';

export interface RegressionDriver {
  profile_id: string;
  argv: string[];
  receipt_relative_path: string;
  supports_strict_receipts: boolean;
  support_argv: string[];
  support_result_relative_path: string;
}

export interface RegressionBudgetAuthority {
  reserve(request: { idempotency_key: string; max_usd: number; expires_at: string }): Promise<{
    id: string;
    hard_limit_usd: number;
    expires_at: string;
    credentials: Record<string, string>;
  }>;
  verify(id: string, maxUsd: number): Promise<boolean>;
}

interface BudgetLedger {
  schema_version: 1;
  manifest_sha256: string;
  max_usd: number;
  reservations: Record<string, number>;
}

export const REGRESSION_PROVIDER_KEYS = new Set([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY',
  'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'COHERE_API_KEY',
  'DASHSCOPE_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY',
]);

function atomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

export function reserveRegressionBudget(path: string, manifest: RegressionManifest, cell: RegressionCellSpec): void {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let handle: number;
  try { handle = openSync(lock, 'wx', 0o600); }
  catch { throw new Error('budget ledger locked; admission blocked, no unsafe stale-lock recovery'); }
  try {
    const hash = regressionHash(manifest);
    const ledger: BudgetLedger = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
      schema_version: 1, manifest_sha256: hash, max_usd: manifest.max_usd, reservations: {},
    };
    if (ledger.schema_version !== 1 || ledger.manifest_sha256 !== hash || ledger.max_usd !== manifest.max_usd
      || !Object.values(ledger.reservations).every(n => Number.isFinite(n) && n >= 0)) throw new Error('budget ledger provenance invalid');
    if (Object.hasOwn(ledger.reservations, cell.id)) throw new Error('cell already admitted; uncertain spend stays reserved');
    const amount = profileBudget(manifest.profiles.find(p => p.id === cell.profile_id)!);
    const total = Object.values(ledger.reservations).reduce((sum, n) => sum + n, 0) + amount;
    if (!Number.isFinite(amount) || amount < 0 || total > manifest.max_usd) throw new Error('budget exhausted or unbounded');
    ledger.reservations[cell.id] = amount;
    atomic(path, ledger);
  } finally {
    closeSync(handle);
    rmSync(lock);
  }
}

export function isolatedRegressionEnvironment(cell: RegressionCellSpec, profile: RegressionProfile): Record<string, string> {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: cell.runtime.home,
    XDG_CONFIG_HOME: join(cell.runtime.home, '.config'),
    XDG_CACHE_HOME: join(cell.runtime.home, '.cache'),
    TMPDIR: join(cell.runtime.home, 'tmp'),
    LANG: 'C.UTF-8', TZ: 'UTC',
    GBRAIN_SRC: join(cell.runtime.product_root, 'src'),
    GBRAIN_REPO: cell.runtime.product_root,
    GBRAIN_HOME: cell.runtime.home,
    GBRAIN_DB_PATH: cell.runtime.database,
    GBRAIN_REPORTS_DIR: cell.runtime.output,
    GBRAIN_EVAL_CLOCK: profile.clock,
    SITUATION_RECALL_CELL: cell.id,
    SITUATION_RECALL_PROFILE: join(cell.runtime.output, 'profile.json'),
    BRAINBENCH_ALLOW_SKIP: '0',
  };
}

export function verifyRegressionRuntime(manifest: RegressionManifest, cell: RegressionCellSpec): void {
  const inventoryErrors = inspectRegressionRunnerTree(cell.runtime.eval_root);
  if (inventoryErrors.length) throw new Error(inventoryErrors.join('; '));
  const p = manifest.profiles.find(p => p.id === cell.profile_id)!;
  const product = cell.arm === 'B' ? manifest.products.B : manifest.products.candidate;
  for (const path of [cell.runtime.root, cell.runtime.eval_root, cell.runtime.product_root]) {
    if (realpathSync(path) !== path) throw new Error('runtime root/checkouts must not alias another cell through symlinks');
  }
  const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (git(cell.runtime.eval_root, ['rev-parse', 'HEAD']) !== manifest.eval_sha || git(cell.runtime.eval_root, ['status', '--porcelain', '--untracked-files=all']) !== '') throw new Error('wrong or dirty isolated eval checkout');
  const identity = resolveRegressionProduct({
    evalRoot: cell.runtime.eval_root, expectedProductSha: product.sha, expectedProductTree: product.tree,
    expectedPackageSha256: product.package_sha256,
    requireClean: true, env: isolatedRegressionEnvironment(cell, p),
  });
  if (identity.package_path !== cell.runtime.product_root || identity.declared_pin !== p.declared_pin || identity.package_version !== p.package_versions[cell.arm]) throw new Error('runtime loaded package identity mismatch');
  const runner = resolve(cell.runtime.eval_root, p.prerequisites.runner);
  const rel = relative(cell.runtime.eval_root, runner);
  const realRunner = realpathSync(runner);
  const productRel = relative(cell.runtime.product_root, realRunner);
  const inProduct = productRel !== '' && !productRel.startsWith('..') && !isAbsolute(productRel);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || (realRunner !== runner && !inProduct)) throw new Error('runner must belong to the isolated eval or verified product checkout');
  if (createHash('sha256').update(readFileSync(realRunner)).digest('hex') !== p.hashes.runner) throw new Error('runner source hash mismatch');
  for (const path of [cell.runtime.home, cell.runtime.config, cell.runtime.database, cell.runtime.output]) {
    if (existsSync(path)) throw new Error(`runtime namespace is not fresh: ${path}`);
  }
}

function child(argv: string[], cwd: string, env: Record<string, string>, output: string, timeoutMs: number): Promise<number | null> {
  const args = regressionChildArguments(argv);
  return new Promise((resolveExit, reject) => {
    const log = openSync(output, 'wx', 0o600);
    const proc = spawn(argv[0], args, { cwd, env, stdio: ['ignore', log, log], detached: true });
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } }
    }, timeoutMs);
    proc.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); closeSync(log); reject(error); } });
    proc.once('close', code => { if (!settled) { settled = true; clearTimeout(timer); closeSync(log); resolveExit(timedOut ? null : code); } });
  });
}

export function regressionChildArguments(argv: string[]): string[] {
  if (argv.some(arg => arg === '--env-file' || arg.startsWith('--env-file='))) throw new Error('explicit dotenv loading is forbidden in isolated benchmark children');
  return ['--no-env-file', ...argv.slice(1)];
}

export async function orchestrateSituationRecall(options: {
  manifest: RegressionManifest;
  drivers: RegressionDriver[];
  ledger_path: string;
  results_path: string;
  budget_authority?: RegressionBudgetAuthority;
}): Promise<{ decision: RegressionDecision; results: RegressionCellResult[] }> {
  const { manifest } = options;
  const errors = validateRegressionManifest(manifest);
  if (!process.versions.bun) errors.push('isolated benchmark orchestration requires the Bun runtime');
  const results: RegressionCellResult[] = [];
  const now = Date.now();
  if (now < Date.parse(manifest.registered_at) || now > Date.parse(manifest.expires_at)) errors.push('run outside preregistered time window');
  if (new Set(options.drivers.map(d => d.profile_id)).size !== options.drivers.length) errors.push('duplicate driver registration');
  for (const profile of manifest.profiles) {
    const driver = options.drivers.find(d => d.profile_id === profile.id);
    if (!driver || !driver.supports_strict_receipts) errors.push(`${profile.id}: unsupported strict-receipt driver prerequisite`);
    if (profileBudget(profile) > 0 && !options.budget_authority) errors.push(`${profile.id}: isolated enforceable provider budget unavailable`);
    if (driver && (driver.argv[0] !== process.execPath || driver.argv[1] !== profile.prerequisites.runner
      || driver.support_argv[0] !== process.execPath || driver.support_argv[1] !== profile.prerequisites.runner)) errors.push(`${profile.id}: driver/preflight must execute the hashed registered runner with the current Bun binary`);
  }
  if (existsSync(options.results_path)) errors.push('results path already exists; refusing to overwrite evidence');
  if (errors.length) return { decision: { status: 'blocked', reasons: errors, coverage: manifest.profiles.map(p => ({ profile_id: p.id, status: 'blocked', reasons: errors.filter(e => e.startsWith(`${p.id}:`)) })), comparisons: [] }, results };
  let blocked: string | null = null;
  for (const profile of manifest.profiles) {
    const driver = options.drivers.find(d => d.profile_id === profile.id)!;
    for (const cell of manifest.cells.filter(c => c.profile_id === profile.id)) {
      const started = new Date().toISOString();
      try {
        verifyRegressionRuntime(manifest, cell);
        const env = isolatedRegressionEnvironment(cell, profile);
        for (const path of [cell.runtime.home, join(cell.runtime.home, 'tmp'), cell.runtime.output]) mkdirSync(path, { recursive: true });
        mkdirSync(dirname(cell.runtime.config), { recursive: true });
        mkdirSync(dirname(cell.runtime.database), { recursive: true });
        atomic(cell.runtime.config, effectiveRegressionFileConfig(profile, cell));
        atomic(env.SITUATION_RECALL_PROFILE, { manifest_sha256: regressionHash(manifest), run_id: manifest.run_id, cell, profile, enforcement_id: null });
        const supportRelative = driver.support_result_relative_path;
        if (!supportRelative || isAbsolute(supportRelative) || supportRelative.split(/[\\/]/).includes('..')) throw new Error('unsafe preflight result path');
        const supportFile = join(cell.runtime.eval_root, supportRelative);
        if (existsSync(supportFile)) throw new Error('stale preflight evidence');
        const supportExit = await child(driver.support_argv, cell.runtime.eval_root, env, join(cell.runtime.output, 'preflight.log'), Math.min(profile.timeout_ms, 60000));
        if (supportExit !== 0 || !existsSync(supportFile) || realpathSync(supportFile) !== supportFile) throw new Error('keyless support preflight failed');
        const readiness = JSON.parse(readFileSync(supportFile, 'utf8')) as { supported: boolean; run_id: string; cell_id: string; reason?: string; file_config_path: string; file_config: unknown; resolved_config: unknown };
        if (readiness.supported !== true || readiness.run_id !== manifest.run_id || readiness.cell_id !== cell.id) throw new Error(`unsupported prerequisite before paid admission: ${readiness.reason ?? 'unknown'}`);
        if (readiness.file_config_path !== cell.runtime.config || regressionHash(readiness.file_config) !== regressionHash(effectiveRegressionFileConfig(profile, cell))
          || regressionHash(readiness.resolved_config) !== regressionHash(effectiveRegressionConfig(profile, cell.arm))) throw new Error('driver did not verify actual product file/DB settings before paid admission');
        const amount = profileBudget(profile);
        reserveRegressionBudget(options.ledger_path, manifest, cell);
        let enforcementId: string | null = null;
        if (amount > 0) {
          const allowance = await options.budget_authority!.reserve({ idempotency_key: `${manifest.run_id}:${cell.id}`, max_usd: amount, expires_at: manifest.expires_at });
          if (!allowance.id || !Number.isFinite(allowance.hard_limit_usd) || allowance.hard_limit_usd !== amount
            || !Number.isFinite(Date.parse(allowance.expires_at)) || Date.parse(allowance.expires_at) < Date.parse(manifest.expires_at) || !await options.budget_authority!.verify(allowance.id, amount)
            || !Object.keys(allowance.credentials).length || Object.entries(allowance.credentials).some(([key, value]) => !REGRESSION_PROVIDER_KEYS.has(key) || !value)) throw new Error('provider allowance did not verify a scoped hard limit');
          Object.assign(env, allowance.credentials);
          enforcementId = allowance.id;
        }
        atomic(env.SITUATION_RECALL_PROFILE, { manifest_sha256: regressionHash(manifest), run_id: manifest.run_id, cell, profile, enforcement_id: enforcementId });
        const relativeReceipt = driver.receipt_relative_path;
        if (!relativeReceipt || isAbsolute(relativeReceipt) || relativeReceipt.split(/[\\/]/).includes('..')) throw new Error('unsafe receipt path');
        const receiptFile = join(cell.runtime.eval_root, relativeReceipt);
        if (existsSync(receiptFile)) throw new Error('stale receipt exists before child starts');
        const childStarted = new Date().toISOString();
        const exit = await child(driver.argv, cell.runtime.eval_root, env, join(cell.runtime.output, 'child.log'), profile.timeout_ms);
        const result: RegressionCellResult = { cell_id: cell.id, exit_code: exit, started_at: childStarted, finished_at: new Date().toISOString(), receipt: existsSync(receiptFile) ? loadReceipt(receiptFile) : null };
        if (result.receipt && realpathSync(receiptFile) !== receiptFile) throw new Error('receipt is an aliased stale file');
        results.push(result);
        atomic(options.results_path, results);
        const violations = validateRegressionCell(manifest, cell, result);
        if (violations.length) throw new Error(violations.join('; '));
      } catch (error) {
        if (!results.some(r => r.cell_id === cell.id)) results.push({ cell_id: cell.id, exit_code: null, started_at: started, finished_at: new Date().toISOString(), receipt: null });
        blocked = `${cell.id}: ${String(error)}`;
        atomic(options.results_path, results);
        break;
      }
    }
    if (blocked) break;
    const partial = compareSituationRecall(manifest, results);
    if (partial.coverage.some(c => c.status === 'regressed')) break;
  }
  const decision = compareSituationRecall(manifest, results);
  if (blocked) { decision.status = 'blocked'; decision.reasons.push(blocked); }
  return { decision, results };
}
