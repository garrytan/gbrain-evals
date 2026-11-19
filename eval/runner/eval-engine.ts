/**
 * Which storage engine a keyless gate runner or the engine-bench runner opens.
 *
 * GBRAIN_EVAL_ENGINE=pglite|postgres|rust picks the engine; unset means the runner's own default, so a runner that
 * adopts this helper behaves exactly as before when the variable is absent. Only the engine-bench runner and the
 * keyless eval-gate runners (N1, N5, N6, N12, N14) read it. Frozen or counted runners never do.
 *
 * The Rust engine is gbrain's planned third BrainEngine (gbrain docs/designs/RUST_ENGINE.md): an in-process napi-rs
 * addon selected with engine "rust", loaded from GBRAIN_RUST_ENGINE_ADDON or the release's installed addon. Until the
 * gbrain build under test carries it, openEvalEngine refuses the rust arm with EvalEngineUnavailable and a reason, so
 * no Rust number can exist before a Rust build does. The Rust engine refuses raw SQL (executeRaw and friends throw
 * engine_capability_missing, reason raw_sql; plan decision D18), so a check that reads or writes the database with
 * raw SQL reports not_applicable on it (rawSqlNotApplicable) and counts as neither a pass nor a fail.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import type { BrainEngine } from 'gbrain/engine';
import type { EngineConfig } from 'gbrain/types';
import { importGbrain, type GbrainUnderTest } from './gbrain-under-test.ts';

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
  if (kind === 'rust' && o.initSchema !== false) initRustBrain(o.gut, o.databasePath!);
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
 * second process on an open Rust store gets store_locked. The child environment carries no provider key.
 */
export function initRustBrain(gut: Pick<GbrainUnderTest, 'root' | 'version'>, databasePath: string): void {
  const home = mkdtempSync(join(tmpdir(), 'eval-engine-rust-init-'));
  try {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const config = { ...cliEngineConfig('rust', { databasePath }), embedding_disabled: true, schema_pack: 'gbrain-base-v2' };
    writeFileSync(join(home, '.gbrain', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    // GBRAIN_RUST_ENGINE_ADDON passes through: a locally built addon (`bun run rust:build`) is found only through it,
    // and the store this process opens next resolves the same addon.
    const addon = process.env.GBRAIN_RUST_ENGINE_ADDON;
    const env = { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', NO_COLOR: '1', ...(addon ? { GBRAIN_RUST_ENGINE_ADDON: addon } : {}) };
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
