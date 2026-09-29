/**
 * Receipt architecture (BrainBench v0.5.0, WS0).
 *
 * Every category runner writes exactly one receipt JSON per run. The receipt
 * — not the exit code — is the source of truth the umbrella runner (all.ts)
 * aggregates. Exit codes remain only a crash backstop: a runner that dies
 * before writing a receipt is `not_run`; a runner that writes
 * `run_status: 'skipped'` can never be counted as pass (audit finding
 * retrieval-cats cat11: skipped modalities aggregated as PASS via exit 0).
 *
 * Outcome model is THREE dimensions, not one enum:
 *   run_status      — did it execute (completed | error | skipped | not_run)
 *   verdict         — benchmark semantics, only meaningful when completed
 *   failure_origin  — who broke (sut | harness | dependency | judge), typed
 *                     on every recorded error
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can never leave
 * a half-receipt that parses as a result. Readers validate before trusting.
 *
 * Schema v2 (2026-09-29, plan item 4) adds, on every written receipt:
 *   execution         the executed evals source tree (content hash of every
 *                     tracked and untracked non-ignored file as it sat on
 *                     disk, so dirty edits count) and the gbrain package
 *                     actually loaded (declared pin, version, content hash);
 *   accounting        planned / attempted / scored / errors / misses, with
 *                     errors kept apart from misses;
 *   cost              USD and tokens, or null when not measured;
 *   latency_ms        p50 / p95, or null when not measured;
 *   delivered_tokens  tokens actually sent to any model, or null when not
 *                     measured (0 only when the runner knows no model ran).
 * writeReceipt upgrades whatever a runner builds to v2. v1 files stay
 * readable: validateReceipt and loadReceipt accept both versions.
 *
 * Since 0.10.7 writeReceipt also rewrites machine-local paths in every
 * string (docs audit B11): paths under this checkout become repo-relative,
 * the home directory becomes `~` and the temp directory `<tmp>`, so a
 * committed receipt does not record the machine that produced it.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'path';
import { regressionPackageHash } from './situation-recall-provenance.ts';

export const BENCHMARK_VERSION = '0.5.0';
export const RECEIPT_SCHEMA_VERSION = 2;
export const LEGACY_RECEIPT_SCHEMA_VERSION = 1;

export type RunStatus = 'completed' | 'error' | 'skipped' | 'not_run';
export type ReceiptVerdict = 'pass' | 'partial' | 'fail';
export type FailureOrigin = 'sut' | 'harness' | 'dependency' | 'judge';

export interface ProbeError {
  probe_id: string;
  origin: FailureOrigin;
  message: string;
}

export interface JudgeProvenance {
  model: string;
  temperature: number;
  rubric_version?: string;
  seed?: number;
}

export interface SourceTreeIdentity {
  /** sha256 over (name, size, bytes) of every file in `git ls-files -co --exclude-standard`, read from disk. */
  sha256: string | null;
  files: number;
  git_head: string | null;
  /** True when the working tree differs from git_head; the hash covers the dirty content. */
  dirty: boolean | null;
  error?: string;
}

export interface ProductIdentity {
  /** Installed alias whose code the runner loaded. */
  package: 'gbrain' | 'gbrain-cues' | 'gbrain-reader';
  declared_pin: string | null;
  declared_sha: string | null;
  version: string | null;
  /** Content hash of the installed package directory (regressionPackageHash). */
  package_sha256: string | null;
  /** HEAD of the loaded package when it is a git checkout (bun link); null for a packaged install. */
  loaded_git_head: string | null;
  error?: string;
}

export interface ExecutionIdentity {
  source_tree: SourceTreeIdentity;
  product: ProductIdentity;
}

export interface RunAccounting {
  planned: number;
  attempted: number;
  scored: number;
  /** Probes that could not be scored (provider, harness, judge or product failure). Never counted as misses. */
  errors: number;
  /** Scored probes answered wrong; null when the runner does not classify misses. */
  misses: number | null;
  source: 'runner' | 'derived';
}

export interface CostSummary {
  usd: number;
  input_tokens: number | null;
  output_tokens: number | null;
  basis: string;
}

export interface LatencySummary {
  p50: number;
  p95: number;
  n: number;
  /** What was timed, e.g. per-question import plus search wall time. */
  basis: string;
}

export interface DeliveredTokens {
  tokens: number;
  basis: string;
}

export interface Receipt {
  schema_version: typeof RECEIPT_SCHEMA_VERSION | typeof LEGACY_RECEIPT_SCHEMA_VERSION;
  benchmark_version: string;
  category: string;
  run_status: RunStatus;
  /** Only meaningful when run_status === 'completed'. */
  verdict?: ReceiptVerdict;
  skip_reason?: string;
  n_total: number;
  n_scored: number;
  completion_rate: number;
  errors: ProbeError[];
  /** False for smoke runs (n_total < 10) that recorded any harness error. */
  publishable: boolean;
  gbrain_version: string;
  gbrain_pin: string;
  resolved_config?: Record<string, unknown>;
  judge?: JudgeProvenance;
  /** Content hashes for provenance: corpus, qrels, evaluator, etc. */
  hashes?: Record<string, string>;
  started_at: string;
  finished_at: string;
  /** Category-specific payload (metric tables, per-probe rows). */
  data?: Record<string, unknown>;
  /** v2: which installed alias the runner measured. Default gbrain. */
  product_package?: ProductIdentity['package'];
  accounting?: RunAccounting;
  cost?: CostSummary | null;
  latency_ms?: LatencySummary | null;
  delivered_tokens?: DeliveredTokens | null;
  execution?: ExecutionIdentity;
}

const RUN_STATUSES: RunStatus[] = ['completed', 'error', 'skipped', 'not_run'];
const VERDICTS: ReceiptVerdict[] = ['pass', 'partial', 'fail'];
const ORIGINS: FailureOrigin[] = ['sut', 'harness', 'dependency', 'judge'];

/**
 * Structural validation. Returns a list of violations; empty list = valid.
 * all.ts refuses to aggregate a receipt with violations.
 */
export function validateReceipt(obj: unknown): string[] {
  const v: string[] = [];
  if (!obj || typeof obj !== 'object') return ['receipt is not an object'];
  const r = obj as Record<string, unknown>;
  if (r.schema_version !== RECEIPT_SCHEMA_VERSION && r.schema_version !== LEGACY_RECEIPT_SCHEMA_VERSION) {
    v.push(`schema_version must be ${LEGACY_RECEIPT_SCHEMA_VERSION} or ${RECEIPT_SCHEMA_VERSION}`);
  }
  if (typeof r.benchmark_version !== 'string') v.push('benchmark_version missing');
  if (typeof r.category !== 'string' || r.category === '') v.push('category missing');
  if (!RUN_STATUSES.includes(r.run_status as RunStatus)) v.push(`run_status must be one of ${RUN_STATUSES.join('|')}`);
  if (r.run_status === 'completed') {
    if (!VERDICTS.includes(r.verdict as ReceiptVerdict)) v.push('completed receipt requires verdict pass|partial|fail');
  } else if (r.verdict !== undefined) {
    v.push('verdict only allowed when run_status is completed');
  }
  if (r.run_status === 'skipped' && typeof r.skip_reason !== 'string') v.push('skipped receipt requires skip_reason');
  if (typeof r.n_total !== 'number' || r.n_total < 0) v.push('n_total must be a number >= 0');
  if (typeof r.n_scored !== 'number' || r.n_scored < 0) v.push('n_scored must be a number >= 0');
  if (typeof r.completion_rate !== 'number' || Number.isNaN(r.completion_rate)) v.push('completion_rate must be a number');
  if (typeof r.publishable !== 'boolean') v.push('publishable must be boolean');
  if (typeof r.gbrain_version !== 'string') v.push('gbrain_version missing');
  if (typeof r.gbrain_pin !== 'string') v.push('gbrain_pin missing');
  if (!Array.isArray(r.errors)) {
    v.push('errors must be an array');
  } else {
    for (const e of r.errors as unknown[]) {
      const err = e as Record<string, unknown>;
      if (!err || typeof err !== 'object' || typeof err.probe_id !== 'string'
        || !ORIGINS.includes(err.origin as FailureOrigin) || typeof err.message !== 'string') {
        v.push('errors[] entries require {probe_id, origin sut|harness|dependency|judge, message}');
        break;
      }
    }
  }
  if (typeof r.started_at !== 'string' || typeof r.finished_at !== 'string') v.push('started_at/finished_at missing');
  if (r.schema_version === RECEIPT_SCHEMA_VERSION) v.push(...validateV2(r, false));
  return v;
}

/**
 * Validation for a receipt on disk: a v2 file must carry every v2 block.
 * validateReceipt alone checks a runner-built receipt, whose missing v2
 * blocks writeReceipt fills in.
 */
export function validateStoredReceipt(obj: unknown): string[] {
  const v = validateReceipt(obj);
  const r = obj as Record<string, unknown> | null;
  if (v.length === 0 && r?.schema_version === RECEIPT_SCHEMA_VERSION) v.push(...validateV2(r, true));
  return v;
}

const nonNegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nullableString = (value: unknown) => value === null || typeof value === 'string';

function validateV2(r: Record<string, unknown>, requireAll: boolean): string[] {
  const v: string[] = [];
  const check = (key: string) => requireAll || r[key] !== undefined;
  const execution = r.execution as Record<string, Record<string, unknown>> | undefined;
  const tree = execution?.source_tree;
  const product = execution?.product;
  if (check('execution') && (!tree || !nullableString(tree.sha256) || !nonNegative(tree.files) || !nullableString(tree.git_head)
    || !(tree.dirty === null || typeof tree.dirty === 'boolean'))) v.push('v2 execution.source_tree requires sha256, files, git_head, dirty');
  if (check('execution') && (!product || !['gbrain', 'gbrain-cues', 'gbrain-reader'].includes(product.package as string) || !nullableString(product.declared_pin)
    || !nullableString(product.declared_sha) || !nullableString(product.version) || !nullableString(product.package_sha256)
    || !nullableString(product.loaded_git_head))) v.push('v2 execution.product requires package, declared_pin, declared_sha, version, package_sha256, loaded_git_head');
  const a = r.accounting as Record<string, unknown> | undefined;
  if (check('accounting') && (!a || !['planned', 'attempted', 'scored', 'errors'].every(k => nonNegative(a[k])) || !(a.misses === null || nonNegative(a.misses))
    || !['runner', 'derived'].includes(a.source as string))) {
    v.push('v2 accounting requires planned, attempted, scored, errors (numbers), misses (number or null), source');
  } else if (a) {
    if ((a.attempted as number) > (a.planned as number)) v.push('v2 accounting: attempted exceeds planned');
    if ((a.scored as number) + (a.errors as number) > (a.attempted as number)) v.push('v2 accounting: scored + errors exceeds attempted');
    if (a.misses !== null && (a.misses as number) > (a.scored as number)) v.push('v2 accounting: misses exceed scored');
  }
  const cost = r.cost as Record<string, unknown> | null | undefined;
  if (check('cost') && (cost === undefined || (cost !== null && (!nonNegative(cost.usd) || !(cost.input_tokens === null || nonNegative(cost.input_tokens))
    || !(cost.output_tokens === null || nonNegative(cost.output_tokens)) || typeof cost.basis !== 'string')))) v.push('v2 cost must be null or {usd, input_tokens, output_tokens, basis}');
  const latency = r.latency_ms as Record<string, unknown> | null | undefined;
  if (check('latency_ms') && (latency === undefined || (latency !== null && (!nonNegative(latency.p50) || !nonNegative(latency.p95) || !nonNegative(latency.n)
    || (latency.p95 as number) < (latency.p50 as number) || typeof latency.basis !== 'string')))) v.push('v2 latency_ms must be null or {p50 <= p95, n, basis}');
  const delivered = r.delivered_tokens as Record<string, unknown> | null | undefined;
  if (check('delivered_tokens') && (delivered === undefined || (delivered !== null && (!nonNegative(delivered.tokens) || typeof delivered.basis !== 'string')))) {
    v.push('v2 delivered_tokens must be null or {tokens, basis}');
  }
  return v;
}

const REPO_ROOT = resolve(import.meta.dir, '../..');
const identityCache = new Map<string, unknown>();

function gitText(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

/** Hash the evals tree as it sits on disk: tracked plus untracked non-ignored files, dirty edits included. */
export function sourceTreeIdentity(root = REPO_ROOT): SourceTreeIdentity {
  const key = `tree:${root}`;
  if (identityCache.has(key)) return identityCache.get(key) as SourceTreeIdentity;
  let identity: SourceTreeIdentity;
  const listing = gitText(root, ['ls-files', '-z', '-co', '--exclude-standard']);
  if (listing === null) {
    identity = { sha256: null, files: 0, git_head: null, dirty: null, error: 'not a git checkout; source tree not hashed' };
  } else {
    const hash = createHash('sha256');
    const files = [...new Set(listing.split('\0').filter(Boolean))].sort();
    for (const name of files) {
      const path = join(root, name);
      if (!existsSync(path) || !lstatSync(path).isFile()) { hash.update(`${Buffer.byteLength(name)}:${name}:deleted:`); continue; }
      const bytes = readFileSync(path);
      hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`);
      hash.update(bytes);
    }
    const status = gitText(root, ['status', '--porcelain', '--untracked-files=normal']);
    identity = { sha256: hash.digest('hex'), files: files.length, git_head: gitText(root, ['rev-parse', 'HEAD']), dirty: status === null ? null : status !== '' };
  }
  identityCache.set(key, identity);
  return identity;
}

/** Identity of an installed gbrain alias: declared pin, version and content hash of what is on disk. */
export function productIdentity(pkg: ProductIdentity['package'] = 'gbrain', root = REPO_ROOT): ProductIdentity {
  const key = `product:${root}:${pkg}`;
  if (identityCache.has(key)) return identityCache.get(key) as ProductIdentity;
  const identity: ProductIdentity = { package: pkg, declared_pin: null, declared_sha: null, version: null, package_sha256: null, loaded_git_head: null };
  const errors: string[] = [];
  try {
    identity.declared_pin = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies?.[pkg] ?? null;
    identity.declared_sha = /#([a-f0-9]{40})$/.exec(identity.declared_pin ?? '')?.[1] ?? null;
  } catch (error) { errors.push(`declared pin unreadable: ${String(error)}`); }
  const packagePath = join(root, 'node_modules', pkg);
  try {
    identity.version = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8')).version ?? null;
    const top = gitText(packagePath, ['rev-parse', '--show-toplevel']);
    if (top !== null && resolve(top) === resolve(packagePath)) identity.loaded_git_head = gitText(packagePath, ['rev-parse', 'HEAD']);
  } catch (error) { errors.push(`package unreadable: ${String(error)}`); }
  try { identity.package_sha256 = regressionPackageHash(packagePath); }
  catch (error) { errors.push(`package not hashed: ${String(error)}`); }
  if (errors.length) identity.error = errors.join('; ');
  identityCache.set(key, identity);
  return identity;
}

/**
 * v2 cost and delivered-token blocks for a run the runner KNOWS sent no paid
 * request and ran no model (hermetic runners, stub transports). Measured
 * zero, not unknown: use null when spend was possible but not recorded.
 */
export function noModelSpend(basis: string): { cost: CostSummary; delivered_tokens: DeliveredTokens } {
  return { cost: { usd: 0, input_tokens: 0, output_tokens: 0, basis }, delivered_tokens: { tokens: 0, basis } };
}

/**
 * A gate override from the environment: a number in (0, 1], or undefined when
 * unset. Anything else throws, so `CAT18_MIN_RECALL=abc` can no longer become
 * NaN and pass every comparison (audit A-23).
 */
export function gateFromEnv(name: string, env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${name} must be a number in (0, 1], got ${JSON.stringify(raw)}`);
  return value;
}

/** Nearest-rank percentile summary; null for an empty sample. */
export function latencySummary(samplesMs: readonly number[], basis: string): LatencySummary | null {
  const sorted = samplesMs.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return { p50: rank(0.5), p95: rank(0.95), n: sorted.length, basis };
}

/** Default accounting from the v1 core: every distinct errored probe counts once, never as a miss. */
export function deriveAccounting(receipt: Pick<Receipt, 'n_total' | 'n_scored' | 'errors'>): RunAccounting {
  const errors = new Set(receipt.errors.map(e => e.probe_id)).size;
  const attempted = Math.min(receipt.n_total, receipt.n_scored + errors);
  return { planned: receipt.n_total, attempted, scored: receipt.n_scored, errors: Math.min(errors, attempted - receipt.n_scored), misses: null, source: 'derived' };
}

/** Fill every v2 block a runner did not supply. Idempotent on a v2 receipt. */
export function upgradeReceipt(input: Receipt): Receipt {
  return {
    ...input,
    schema_version: RECEIPT_SCHEMA_VERSION,
    accounting: input.accounting ?? deriveAccounting(input),
    cost: input.cost ?? null,
    latency_ms: input.latency_ms ?? null,
    delivered_tokens: input.delivered_tokens ?? null,
    execution: input.execution ?? { source_tree: sourceTreeIdentity(), product: productIdentity(input.product_package ?? 'gbrain') },
  };
}

/** Canonical receipt location for a category run. */
export function receiptPath(category: string, reportsDir = join(process.cwd(), 'eval/reports')): string {
  return join(reportsDir, category, 'receipt.json');
}

/** Machine-local path prefixes a committed receipt must not carry. */
export const MACHINE_LOCAL_PATH = /(?:^|[\s"'=(:,\[])(?:\/home\/[^/\s"']+\/|\/Users\/[^/\s"']+\/|\/root\/|\/private\/var\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\Users\\)/;

function scrubString(value: string, prefixes: ReadonlyArray<readonly [string, string]>): string {
  let out = value;
  for (const [prefix, replacement] of prefixes) out = out.split(prefix).join(replacement);
  return out;
}

/** Rewrite checkout, home and temp paths in every string of a JSON value. */
export function scrubMachinePaths<T>(value: T, root = REPO_ROOT, home = homedir(), tmp = tmpdir()): T {
  const prefixes = ([[`${root}/`, ''], [root, '.'], [`${tmp}/`, '<tmp>/'], ['/tmp/', '<tmp>/'], [`${home}/`, '~/']] as const)
    .filter(([prefix]) => prefix.length > 1);
  const visit = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubString(v, prefixes);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, visit(child)]));
    return v;
  };
  return visit(value) as T;
}

/** Atomic write: upgrade to v2, scrub machine-local paths, validate, write temp file in the same dir, rename over target. */
export function writeReceipt(path: string, input: Receipt): void {
  const receipt = scrubMachinePaths(upgradeReceipt(input));
  const violations = validateStoredReceipt(receipt);
  if (violations.length > 0) {
    throw new Error(`refusing to write invalid receipt (${receipt.category}): ${violations.join('; ')}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Read + validate. Throws with the violation list on an invalid receipt. */
export function loadReceipt(path: string): Receipt {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const violations = validateStoredReceipt(parsed);
  if (violations.length > 0) throw new Error(`invalid receipt at ${path}: ${violations.join('; ')}`);
  return parsed as Receipt;
}
