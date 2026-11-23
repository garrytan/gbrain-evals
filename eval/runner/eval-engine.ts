/**
 * Which storage engine a keyless gate runner or the engine-bench runner opens.
 *
 * GBRAIN_EVAL_ENGINE=pglite|postgres|rust picks the engine; unset means the runner's own default, so a runner that
 * adopts this helper behaves exactly as before when the variable is absent. Only the engine-bench runner, the keyless
 * eval-gate runners (N1, N5, N6, N12, N14) and the gate suites gbrain's RUST_ENGINE.md names in "Eval gates" E1 to E3
 * (through gateRunnerContext below) read it. Frozen or counted runners never do.
 *
 * The Rust engine is gbrain's planned third BrainEngine (gbrain docs/designs/RUST_ENGINE.md): an in-process napi-rs
 * addon selected with engine "rust", loaded from GBRAIN_RUST_ENGINE_ADDON or the release's installed addon. Until the
 * gbrain build under test carries it, openEvalEngine refuses the rust arm with EvalEngineUnavailable and a reason, so
 * no Rust number can exist before a Rust build does. The Rust engine refuses raw SQL (executeRaw and friends throw
 * engine_capability_missing, reason raw_sql; plan decision D18), so a check that reads or writes the database with
 * raw SQL reports not_applicable on it (rawSqlNotApplicable) and counts as neither a pass nor a fail.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SQL } from 'bun';
import type { BrainEngine } from 'gbrain/engine';
import type { EngineConfig } from 'gbrain/types';
import { gbrainSpecFrom, importGbrain, overlaySummary, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';

export const EVAL_ENGINE_ENV = 'GBRAIN_EVAL_ENGINE';
export const EVAL_ENGINES = ['pglite', 'postgres', 'rust'] as const;
export type EvalEngineKind = (typeof EVAL_ENGINES)[number];

/** The engine named by GBRAIN_EVAL_ENGINE, else `fallback`. An unknown value throws instead of falling back. */
export function evalEngineKind(env: Record<string, string | undefined> = process.env, fallback: EvalEngineKind = 'pglite'): EvalEngineKind {
  const v = env[EVAL_ENGINE_ENV]?.trim();
  if (!v) return fallback;
  if (!(EVAL_ENGINES as readonly string[]).includes(v)) throw new Error(`${EVAL_ENGINE_ENV}=${v} is not an engine. Use one of ${EVAL_ENGINES.join(', ')}, or unset it for the runner's default.`);
  return v as EvalEngineKind;
}

/** True when GBRAIN_EVAL_ENGINE is set, so a runner can keep its own default engine list when it is not. */
export function evalEngineRequested(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env[EVAL_ENGINE_ENV]?.trim());
}

export type RustUnavailableReason =
  | 'rust_engine_not_in_build' | 'rust_kind_unsupported' | 'addon_unavailable' | 'rust_engine_addon_missing' | 'rust_engine_addon_mismatch'
  | 'rust_init_failed' | 'store_path_missing';

export type EvalEngineUnavailableReason = RustUnavailableReason | 'postgres_url_missing' | 'postgres_unreachable' | 'engine_not_supported_by_runner';

export class EvalEngineUnavailable extends Error {
  constructor(readonly kind: EvalEngineKind, readonly reason: EvalEngineUnavailableReason, message: string) {
    super(message);
    this.name = 'EvalEngineUnavailable';
  }
}

/** Where the Rust engine's TypeScript side lives in a gbrain build that carries it (RUST_ENGINE.md, "Binding"). */
export const RUST_ENGINE_DIR = 'src/core/rust-engine';

/**
 * GBRAIN_RUST_ENGINE_ADDON for a child environment built from nothing. gbrain's addon loader reads it before any
 * installed addon, and a locally built addon (`bun run rust:build`) is found only through it, so every gbrain child
 * the harness spawns, and the store this process opens, resolve the same addon file. Empty when unset.
 */
export function rustAddonEnv(env: Record<string, string | undefined> = process.env): { GBRAIN_RUST_ENGINE_ADDON?: string } {
  const path = env.GBRAIN_RUST_ENGINE_ADDON?.trim();
  return path ? { GBRAIN_RUST_ENGINE_ADDON: resolve(path) } : {};
}

/** The Rust addon a run loaded: its file digest (engine_build hashes the Rust sources, not the file) and its exports. */
export interface RustAddonIdentity {
  sha256: string | null;
  bytes: number | null;
  /** Why the addon file could not be read; the receipt keeps the run instead of throwing. */
  read_error?: string;
  target?: string;
  engine_build?: string;
  engine_abi?: number;
  catalog_version?: number;
  format_versions?: unknown[];
  /** Why the exports could not be read; the digest still stands. */
  exports_error?: string;
}

/**
 * Identify the addon at GBRAIN_RUST_ENGINE_ADDON: its SHA-256, and the exports gbrain's own loader reads from it, read
 * in a child process with no provider key and only the addon path set. Null when the variable is unset.
 */
export function rustAddonIdentity(gut: Pick<GbrainUnderTest, 'root'>, env: Record<string, string | undefined> = process.env): RustAddonIdentity | null {
  const path = rustAddonEnv(env).GBRAIN_RUST_ENGINE_ADDON;
  if (!path) return null;
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch (e) { return { sha256: null, bytes: null, read_error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }; }
  const id: RustAddonIdentity = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  const loader = resolve(gut.root, RUST_ENGINE_DIR, 'addon-loader.ts');
  const script = `const a = await (await import(${JSON.stringify(loader)})).loadRustAddon(); console.log(JSON.stringify({ target: a.target, engine_build: a.engineBuild, engine_abi: a.engineAbi, catalog_version: a.catalogVersion, format_versions: a.formatVersions }));`;
  const home = mkdtempSync(join(tmpdir(), 'eval-engine-rust-addon-'));
  try {
    const r = spawnSync(process.execPath, ['-e', script], { env: { PATH: env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: path }, cwd: home, encoding: 'utf8', timeout: 60_000 });
    const line = (r.stdout ?? '').trim().split('\n').at(-1) ?? '';
    try { return { ...id, ...JSON.parse(line) }; } catch {
      const lines = (r.stderr ?? '').trim().split('\n');
      const why = lines.find(l => /^\s*(error|[A-Za-z]*Error)\b/.test(l)) ?? lines.at(-1) ?? '';
      return { ...id, exports_error: `exit ${r.status ?? r.signal}: ${why.trim().slice(0, 300)}` };
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Static check, no import: does the gbrain under test carry the Rust engine at all? */
export function rustEngineInBuild(gut: Pick<GbrainUnderTest, 'root'>): boolean {
  return existsSync(join(gut.root, RUST_ENGINE_DIR));
}

/** The config gbrain's own CLI reads from <home>/.gbrain/config.json for this engine, for runners that spawn the CLI. */
export function cliEngineConfig(kind: EvalEngineKind, where: { databasePath?: string; databaseUrl?: string }): Record<string, string> {
  if (kind === 'postgres') {
    if (!where.databaseUrl) throw new EvalEngineUnavailable(kind, 'postgres_url_missing', 'The postgres engine needs a database URL.');
    return { engine: 'postgres', database_url: where.databaseUrl };
  }
  if (!where.databasePath) throw new EvalEngineUnavailable(kind, 'store_path_missing', `The ${kind} engine needs a store path for the CLI config.`);
  return { engine: kind, database_path: where.databasePath };
}

export interface OpenEvalEngineOptions {
  gut: GbrainUnderTest;
  /** Defaults to evalEngineKind(). */
  kind?: EvalEngineKind;
  /** PGLite data directory (omit for an in-memory store) or the Rust store path (required for rust). */
  databasePath?: string;
  /** Postgres connection URL (required for postgres). */
  databaseUrl?: string;
  /** Postgres pool size; ignored by the embedded engines. */
  poolMax?: number;
  /** Bring the schema up: initSchema after connect on PGLite and Postgres, `gbrain init` before connect on Rust. Defaults to true. */
  initSchema?: boolean;
}

export interface EvalEngine {
  kind: EvalEngineKind;
  engine: BrainEngine;
  config: EngineConfig;
}

function engineConfigFor(o: OpenEvalEngineOptions, kind: EvalEngineKind): EngineConfig {
  if (kind === 'postgres') {
    if (!o.databaseUrl) throw new EvalEngineUnavailable(kind, 'postgres_url_missing', 'The postgres engine needs a database URL (a local pgvector container or --pg-url).');
    return { engine: 'postgres', database_url: o.databaseUrl, ...(o.poolMax ? { pool_max: o.poolMax } : {}) };
  }
  if (kind === 'rust') {
    if (!o.databasePath) throw new EvalEngineUnavailable(kind, 'store_path_missing', 'The rust engine needs a store path (database_path).');
    return { engine: 'rust', database_path: o.databasePath } as unknown as EngineConfig;
  }
  return o.databasePath ? { engine: 'pglite', database_path: o.databasePath } : {};
}

/**
 * Construct, connect and (by default) initialize the engine through the gbrain under test's own factory, so every
 * engine is opened the way gbrain opens it. The rust arm refuses with EvalEngineUnavailable until the build carries
 * the engine and its addon loads.
 */
export async function openEvalEngine(o: OpenEvalEngineOptions): Promise<EvalEngine> {
  const kind = o.kind ?? evalEngineKind();
  if (kind === 'rust' && !rustEngineInBuild(o.gut)) {
    throw new EvalEngineUnavailable(kind, 'rust_engine_not_in_build', `gbrain ${o.gut.version} has no Rust engine (${RUST_ENGINE_DIR} is missing), so the rust arm cannot run. Point --gbrain at a build that carries it.`);
  }
  const config = engineConfigFor(o, kind);
  const { constructEngine } = await importGbrain<{ constructEngine: (c: EngineConfig) => Promise<BrainEngine> }>(o.gut, 'src/core/engine-construct.ts');
  let engine: BrainEngine;
  try {
    engine = await constructEngine({ ...config, engine: (kind === 'pglite' ? 'pglite' : kind) } as EngineConfig);
  } catch (e) {
    if (kind === 'rust') throw rustAddonRefusal(e) ?? new EvalEngineUnavailable(kind, 'rust_kind_unsupported', `gbrain ${o.gut.version} does not construct a rust engine: ${(e as Error).message}`);
    throw e;
  }
  if (kind === 'rust' && o.initSchema !== false) initRustBrain(o.gut, o.databasePath!, await buildEmbeddingIdentity(o.gut));
  try {
    await engine.connect(config);
  } catch (e) {
    if (kind === 'rust') throw rustAddonRefusal(e) ?? e;
    throw e;
  }
  if (kind !== 'rust' && o.initSchema !== false) await engine.initSchema();
  return { kind, engine, config };
}

const RUST_ADDON_CODES = ['rust_engine_addon_missing', 'rust_engine_addon_mismatch'] as const;

/**
 * The refusal for a Rust engine whose native addon is absent or built for another ABI: gbrain's
 * rust_engine_addon_missing and rust_engine_addon_mismatch keep their own reasons, and the older engine_unavailable is
 * addon_unavailable. Null for any other error. A refusal is never a pass.
 */
export function rustAddonRefusal(e: unknown): EvalEngineUnavailable | null {
  const code = errorCode(e);
  const detail = (e as Error)?.message ?? String(e);
  if ((RUST_ADDON_CODES as readonly string[]).includes(code ?? '')) {
    return new EvalEngineUnavailable('rust', code as RustUnavailableReason, `The Rust engine addon did not load (${code}): ${detail}`);
  }
  if (code === 'engine_unavailable') {
    return new EvalEngineUnavailable('rust', 'addon_unavailable', `The Rust engine addon did not load (${String((e as { reason?: unknown }).reason ?? 'no reason given')}): ${detail}`);
  }
  return null;
}

/**
 * Create a Rust brain the way a user does: write a rust CLI config and run `gbrain init --migrate-only` through the
 * gbrain under test. The Rust engine refuses initSchema() (capability `schema`), and `gbrain init` has no rust flag,
 * so the config is written first, as lifecycle/slice.ts does. It runs before this process opens the store, because a
 * second process on an open Rust store gets store_locked. The child environment carries no provider key. With
 * `embedding`, the store's vector width is this process's embedder (what PGLite and Postgres size their column from);
 * without it, embeddings are disabled and the store takes gbrain's default width.
 */
export function initRustBrain(gut: Pick<GbrainUnderTest, 'root' | 'version'>, databasePath: string, embedding?: { model: string; dimensions: number }): void {
  const home = mkdtempSync(join(tmpdir(), 'eval-engine-rust-init-'));
  try {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const embed = embedding ? { embedding_model: embedding.model, embedding_dimensions: embedding.dimensions } : { embedding_disabled: true };
    const config = { ...cliEngineConfig('rust', { databasePath }), ...embed, schema_pack: 'gbrain-base-v2' };
    writeFileSync(join(home, '.gbrain', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    const env = { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', NO_COLOR: '1', ...rustAddonEnv() };
    const r = spawnSync(process.execPath, [join(gut.root, 'src/cli.ts'), 'init', '--migrate-only', '--non-interactive'], { env, cwd: home, encoding: 'utf8', timeout: 300_000 });
    if (r.status === 0) return;
    const out = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim();
    const tail = out.split('\n').slice(-6).join(' | ').slice(0, 600);
    const addonCode = RUST_ADDON_CODES.find(c => out.includes(c));
    if (addonCode) throw new EvalEngineUnavailable('rust', addonCode, `gbrain init on a rust config: the Rust engine addon did not load (${addonCode}): ${tail}`);
    throw new EvalEngineUnavailable('rust', 'rust_init_failed', `gbrain ${gut.version} init --migrate-only on a rust config exited ${r.status ?? r.signal}: ${tail}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The embedder this process configured on the build's gateway, or undefined when the build cannot say. */
async function buildEmbeddingIdentity(gut: Pick<GbrainUnderTest, 'root'>): Promise<{ model: string; dimensions: number } | undefined> {
  try {
    const gw = await importGbrain<{ getEmbeddingModel(): string; getEmbeddingDimensions(): number }>(gut as GbrainUnderTest, 'src/core/ai/gateway.ts');
    return { model: gw.getEmbeddingModel(), dimensions: gw.getEmbeddingDimensions() };
  } catch {
    return undefined;
  }
}

function errorCode(e: unknown): string | undefined {
  const x = e as { code?: unknown; canonical?: unknown } | null;
  return typeof x?.canonical === 'string' ? x.canonical : typeof x?.code === 'string' ? x.code : undefined;
}

/** True for gbrain's typed refusal of an operation the engine cannot do (the Rust engine's raw SQL refusal included). */
export function isCapabilityMissing(e: unknown): boolean {
  return errorCode(e) === 'engine_capability_missing';
}

/** Whether the engine accepts executeRaw and other raw-SQL entry points. */
export function supportsRawSql(kind: EvalEngineKind): boolean {
  return kind !== 'rust';
}

export interface NotApplicable {
  status: 'not_applicable';
  engine: EvalEngineKind;
  check: string;
  reason: string;
}

/**
 * The not_applicable record for a check that relies on raw SQL, or null when the engine accepts raw SQL and the check
 * runs. A not_applicable check is reported with its reason and counts as neither a pass nor a fail.
 */
export function rawSqlNotApplicable(kind: EvalEngineKind, check: string, usesSqlFor: string): NotApplicable | null {
  if (supportsRawSql(kind)) return null;
  return {
    status: 'not_applicable', engine: kind, check,
    reason: `${check} uses raw SQL to ${usesSqlFor}. The ${kind} engine has no SQL dialect and refuses executeRaw with engine_capability_missing (reason raw_sql; gbrain RUST_ENGINE.md decision D18), so the check cannot run on it.`,
  };
}

/** The engine GBRAIN_EVAL_ENGINE names, or null when it is unset and the runner keeps its own default. */
export function requestedEvalEngine(env: Record<string, string | undefined> = process.env): EvalEngineKind | null {
  return evalEngineRequested(env) ? evalEngineKind(env) : null;
}

/**
 * The receipt fields a runner adds when GBRAIN_EVAL_ENGINE is set: the engine kind and the checks that could not run
 * on it (empty when none). Nothing when the variable is unset, so a default receipt keeps its bytes.
 */
export function evalEngineReceiptFields(kind: EvalEngineKind | null, notApplicable: readonly NotApplicable[] = []): { engine?: EvalEngineKind; not_applicable?: NotApplicable[] } {
  return kind ? { engine: kind, not_applicable: [...notApplicable] } : {};
}

/**
 * Exit code of a runner that refused to run because the requested engine is unavailable (EvalEngineUnavailable). It
 * writes no receipt and no verdict. 69 is EX_UNAVAILABLE from sysexits.h, distinct from the runners' 0 (pass),
 * 1 (fail or error), 2 (paid-arm refusal) and 3 (harness error), so engine-bench can tell "refused" from "failed".
 */
export const EVAL_ENGINE_REFUSED_EXIT = 69;

export function evalEngineRefusalMessage(e: EvalEngineUnavailable, runner: string, o: { skippedReceipt?: string } = {}): string {
  const written = o.skippedReceipt ? `A skipped receipt was written to ${o.skippedReceipt}; no verdict was written` : 'No receipt or verdict was written';
  return `REFUSED: ${runner} did not run on engine ${e.kind}. EvalEngineUnavailable (${e.reason}): ${e.message} ${written} (exit ${EVAL_ENGINE_REFUSED_EXIT}).`;
}

/** Print the refusal and exit with EVAL_ENGINE_REFUSED_EXIT. */
export function refuseEvalEngine(e: EvalEngineUnavailable, runner: string): never {
  console.error(evalEngineRefusalMessage(e, runner));
  process.exit(EVAL_ENGINE_REFUSED_EXIT);
}

export interface ScratchEvalEngine extends EvalEngine {
  /** Disconnect and remove the throwaway store (the Rust directory or the Postgres database). */
  close(): Promise<void>;
}

/**
 * Open `kind` on a throwaway store: PGLite in memory, Postgres in a fresh database created through `pgAdminUrl` and
 * dropped on close, Rust in a fresh temp directory removed on close.
 */
export async function openScratchEvalEngine(o: { gut: GbrainUnderTest; kind: EvalEngineKind; label: string; pgAdminUrl?: string; initSchema?: boolean }): Promise<ScratchEvalEngine> {
  const disconnect = async (e: EvalEngine) => { await e.engine.disconnect?.().catch(() => {}); };
  if (o.kind === 'pglite') {
    const e = await openEvalEngine({ gut: o.gut, kind: 'pglite', initSchema: o.initSchema });
    return { ...e, close: () => disconnect(e) };
  }
  if (o.kind === 'rust') {
    const dir = mkdtempSync(join(tmpdir(), `${o.label}-rust-`));
    try {
      const e = await openEvalEngine({ gut: o.gut, kind: 'rust', databasePath: join(dir, 'brain.rust'), initSchema: o.initSchema });
      return { ...e, close: async () => { await disconnect(e); rmSync(dir, { recursive: true, force: true }); } };
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }
  if (!o.pgAdminUrl) throw new EvalEngineUnavailable('postgres', 'postgres_url_missing', 'The postgres engine needs an admin URL to create a scratch database (--pg-url or LIFECYCLE_PG_URL).');
  const db = `${o.label}_${process.pid}_${randomUUID().slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const admin = new SQL(o.pgAdminUrl);
  try {
    await admin.unsafe(`CREATE DATABASE ${db}`);
  } catch (err) {
    await admin.close().catch(() => {});
    throw new EvalEngineUnavailable('postgres', 'postgres_unreachable', `Could not create a scratch Postgres database: ${(err as Error).message}`);
  }
  const drop = async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.close().catch(() => {});
  };
  const url = new URL(o.pgAdminUrl);
  url.pathname = `/${db}`;
  try {
    const e = await openEvalEngine({ gut: o.gut, kind: 'postgres', databaseUrl: url.toString(), initSchema: o.initSchema });
    return { ...e, close: async () => { await disconnect(e); await drop(); } };
  } catch (err) {
    await drop();
    throw err;
  }
}

/**
 * Refuse before any work when the requested engine cannot run. For rust this opens and closes a scratch store, so a
 * build without the engine, a factory that does not know it and an addon that does not load all refuse up front.
 * PGLite and Postgres need no preflight here (each runner checks Postgres reachability its own way).
 */
export async function preflightEvalEngine(gut: GbrainUnderTest, kind: EvalEngineKind): Promise<void> {
  if (kind !== 'rust') return;
  const e = await openScratchEvalEngine({ gut, kind, label: 'preflight' });
  await e.close();
}

/** Env var naming the SHA-256 the Rust addon file must have; a gate runner refuses a different file before it opens anything. */
export const RUST_ADDON_SHA256_ENV = 'GBRAIN_RUST_ENGINE_ADDON_SHA256';

/**
 * A gate suite's gbrain and engine (gbrain docs/designs/RUST_ENGINE.md, "Eval gates" E1 to E3). `--gbrain
 * <checkout>[@ref]` (or GBRAIN_UNDER_TEST) picks the build, GBRAIN_EVAL_ENGINE the engine and `--pg-url` (or
 * LIFECYCLE_PG_URL) the Postgres admin URL. With none of them set, the runner opens the pinned gbrain's in-memory
 * PGLite as it always did, and its receipt keeps its bytes.
 */
export interface GateRunnerContext {
  gut: GbrainUnderTest;
  kind: EvalEngineKind;
  /** GBRAIN_EVAL_ENGINE, or null when unset. */
  requested: EvalEngineKind | null;
  pgAdminUrl?: string;
}

export function gateRunnerContext(argv: readonly string[], env: Record<string, string | undefined> = process.env): GateRunnerContext {
  const at = argv.indexOf('--pg-url');
  const flagged = at >= 0 ? argv[at + 1] : argv.find(a => a.startsWith('--pg-url='))?.slice('--pg-url='.length);
  if (at >= 0 && (!flagged || flagged.startsWith('--'))) throw new Error('--pg-url needs a Postgres admin URL');
  const pgAdminUrl = flagged || env.LIFECYCLE_PG_URL?.trim() || undefined;
  const requested = requestedEvalEngine(env);
  return { gut: resolveGbrainUnderTest(gbrainSpecFrom(argv, env)), kind: requested ?? 'pglite', requested, ...(pgAdminUrl ? { pgAdminUrl } : {}) };
}

/**
 * Refuse before any work when the context's engine cannot run: a Rust addon whose digest is not the one
 * GBRAIN_RUST_ENGINE_ADDON_SHA256 names (rust_engine_addon_mismatch), then preflightEvalEngine.
 */
export async function preflightGateEngine(ctx: GateRunnerContext, env: Record<string, string | undefined> = process.env): Promise<void> {
  if (ctx.kind === 'rust') {
    const want = env[RUST_ADDON_SHA256_ENV]?.trim().toLowerCase();
    const path = rustAddonEnv(env).GBRAIN_RUST_ENGINE_ADDON;
    if (want) {
      if (!path) throw new EvalEngineUnavailable('rust', 'rust_engine_addon_missing', `${RUST_ADDON_SHA256_ENV} is set but GBRAIN_RUST_ENGINE_ADDON names no addon file.`);
      let got: string;
      try { got = createHash('sha256').update(readFileSync(path)).digest('hex'); } catch (e) {
        throw new EvalEngineUnavailable('rust', 'rust_engine_addon_missing', `The Rust addon at GBRAIN_RUST_ENGINE_ADDON could not be read: ${(e as Error).message}`);
      }
      if (got !== want) throw new EvalEngineUnavailable('rust', 'rust_engine_addon_mismatch', `The Rust addon file's SHA-256 is ${got}, not the ${want} that ${RUST_ADDON_SHA256_ENV} names.`);
    }
  }
  if (ctx.kind === 'postgres' && !ctx.pgAdminUrl) throw new EvalEngineUnavailable('postgres', 'postgres_url_missing', 'The postgres engine needs an admin URL to create scratch databases (--pg-url or LIFECYCLE_PG_URL).');
  await preflightEvalEngine(ctx.gut, ctx.kind);
}

/** A throwaway brain on the context's engine, created the way gbrain creates one (see openScratchEvalEngine). */
export function openGateEngine(ctx: GateRunnerContext, label: string, o: { initSchema?: boolean } = {}): Promise<ScratchEvalEngine> {
  return openScratchEvalEngine({ gut: ctx.gut, kind: ctx.kind, label, pgAdminUrl: ctx.pgAdminUrl, initSchema: o.initSchema });
}

/** The receipt location: the runner's usual path, or a per-engine directory under it when GBRAIN_EVAL_ENGINE is set. */
export function gateReceiptPath(ctx: Pick<GateRunnerContext, 'requested'>, category: string, reportsDir = join(process.cwd(), 'eval/reports')): string {
  return ctx.requested ? join(reportsDir, category, `engine-${ctx.requested}`, 'receipt.json') : join(reportsDir, category, 'receipt.json');
}

/**
 * Receipt fields naming what ran: the engine, the checks it could not run, and the gbrain build with its Rust addon.
 * Nothing when neither GBRAIN_EVAL_ENGINE nor --gbrain was given, so a default receipt keeps its bytes.
 */
export function gateRunnerReceiptFields(ctx: GateRunnerContext, notApplicable: readonly NotApplicable[] = []): {
  engine?: EvalEngineKind; not_applicable?: NotApplicable[]; gbrain_under_test?: { version: string; overlay: Record<string, unknown> | null; rust_addon: RustAddonIdentity | null };
} {
  if (!ctx.requested && !ctx.gut.overlay) return {};
  return {
    ...evalEngineReceiptFields(ctx.kind, notApplicable),
    gbrain_under_test: { version: ctx.gut.version, overlay: overlaySummary(ctx.gut), rust_addon: ctx.kind === 'rust' ? rustAddonIdentity(ctx.gut) : null },
  };
}
