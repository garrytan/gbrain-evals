/**
 * Opening a brain for the live-recall runner without ever writing to it.
 *
 * The guarantee is server-side. gbrain on Postgres opens every transaction that
 * is not marked readOnly as BEGIN READ WRITE, and executeRaw re-runs a statement
 * the server refused with SQLSTATE 25006 inside BEGIN READ WRITE
 * (postgres-engine.ts and postgres-engine/read-write-transactions.ts), so a
 * default_transaction_read_only session protects nothing on its own. The runner
 * therefore refuses to run unless the database itself proves one barrier:
 * a disposable copy (the marker table only snapshot.sh creates), a hot standby,
 * or a role with no write privilege anywhere and no CREATE on any schema.
 *
 * The client guards below are a second layer and keep the measurement honest on
 * a copy: every transaction is forced read-only, raw SQL passes an allowlist,
 * the direct pool is disabled, and the session default is set on Postgres.
 * Code that writes through a tagged template outside these seams is not
 * intercepted; the server barrier is what stops it.
 */
import { importGbrain, type GbrainUnderTest } from '../gbrain-under-test.ts';

export const COPY_MARKER_TABLE = 'gbrain_evals_live_recall_copy';

export const ABORT_CODES = {
  LR_NO_DATABASE_URL: 'Set the env var named by --database-url-env to the copy, standby or read-only-role URL.',
  LR_NO_BARRIER: 'Make a copy with eval/runner/live-recall/snapshot.sh, or use a hot standby or a role without write privileges.',
  LR_READONLY_UNVERIFIED: 'The session did not report read-only, or the direct pool is active; rerun against the copy and report the detail.',
  LR_DIRECT_URL_OVERRIDE: 'Unset GBRAIN_DIRECT_DATABASE_URL in the shell that runs the runner.',
  LR_SCHEMA_MISMATCH: 'Run with --gbrain <checkout>@<commit> at the gbrain version that wrote the brain.',
  LR_QUESTIONS_INVALID: 'Fix the question file at the reported line and field, then rerun freeze.',
  LR_FREEZE_MISMATCH: 'Rerun freeze on this exact question file and send the new freeze numbers before the counted run.',
  LR_GOLD_MISSING_CAP: 'More than 10% of gold pages are absent from the brain; fix the gold slugs or use a fresher copy.',
  LR_RERANK_NEEDS_TYPESAFE: 'The configured reranker needs a TypeSafe key; ask GBEV-3 how to measure the configured arm.',
  LR_CUSTODY_LEAK: 'An output file would have carried private text; nothing was written. Report the field name to GBEV-3.',
  LR_EMBEDDING_UNAVAILABLE: 'Embedding the preflight query failed; export the key for the brain\'s embedding provider (the same one gbrain uses on this box) and rerun.',
  LR_EMBEDDING_UNVERIFIED: 'gbrain found no explicit embedding model; run as the user whose ~/.gbrain/config.json serves this brain, or set GBRAIN_HOME to its parent directory.',
} as const;
export type AbortCode = keyof typeof ABORT_CODES;

/** A refusal whose detail is built only from field names, line numbers and counts, never from private text. */
export class LiveRecallAbort extends Error {
  constructor(readonly code: AbortCode, readonly detail: string) {
    super(code + ': ' + detail);
    this.name = 'LiveRecallAbort';
  }
}

export type BarrierKind = 'copy' | 'standby' | 'no_write_privilege';
type Raw = (sql: string) => Promise<Array<Record<string, unknown>>>;

/** Prove that the server, not this process, refuses writes. Throws LR_NO_BARRIER otherwise. */
export async function proveBarrier(raw: Raw): Promise<BarrierKind> {
  const [marker] = await raw("SELECT to_regclass('public." + COPY_MARKER_TABLE + "') IS NOT NULL AS present");
  if (marker?.present === true) return 'copy';
  const [standby] = await raw('SELECT pg_is_in_recovery() AS standby');
  if (standby?.standby === true) return 'standby';
  const [role] = await raw('SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user');
  if (role && role.superuser === false) {
    const [writable] = await raw(
      "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace " +
      "WHERE c.relkind IN ('r', 'p') AND s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname NOT LIKE 'pg_toast%' " +
      "AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))",
    );
    const [creatable] = await raw(
      "SELECT count(*)::int AS n FROM pg_namespace s WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname NOT LIKE 'pg_%' AND has_schema_privilege(s.oid, 'CREATE')",
    );
    if (Number(writable?.n) === 0 && Number(creatable?.n) === 0) return 'no_write_privilege';
  }
  throw new LiveRecallAbort('LR_NO_BARRIER', 'no copy marker, not a standby, and the role can write');
}

/** Replace string literals, dollar quotes and comments so keyword checks see only SQL structure. */
function structure(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, 'ident')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const READ_LEADS = new Set(['select', 'with', 'values', 'show', 'explain', 'table']);
const TX_CONTROL = new Set(['commit', 'rollback', 'end', 'savepoint', 'release']);
const DATA_MODIFYING = /\b(insert\s+into|update\s+[a-z_."]+(\s+[a-z_]+)?\s+set|delete\s+from|merge\s+into|truncate)\b/;
const WRITE_FUNCTIONS = /\b(nextval|setval|lo_[a-z_]+|dblink[a-z_]*|pg_file_write|pg_terminate_backend|pg_cancel_backend|pg_reload_conf)\s*\(/;

export type SqlVerdict = { ok: true } | { ok: false; verb: string };

/** gbrain's search path flushes per-query counters into this table; the guard names it so a refusal count reads plainly. */
const TELEMETRY_WRITE = /^(insert into|update|delete from) (public\.)?search_telemetry\b/;

/** The executeRaw allowlist: reads, transaction-local settings and transaction control only. */
export function classifySql(sql: string): SqlVerdict {
  for (const statement of structure(sql).split(';').map(s => s.trim()).filter(Boolean)) {
    if (/\b(default_transaction_read_only|transaction_read_only|session characteristics)\b/.test(statement)) return { ok: false, verb: 'read_only_setting' };
    const lead = statement.split(' ')[0]!;
    if (READ_LEADS.has(lead)) {
      if (DATA_MODIFYING.test(statement)) return { ok: false, verb: 'data_modifying_cte' };
      if (WRITE_FUNCTIONS.test(statement)) return { ok: false, verb: 'write_function' };
      for (const call of statement.matchAll(/\bset_config\s*\(([^()]*)\)/g)) {
        if (call[1]!.split(',').at(-1)!.trim() !== 'true') return { ok: false, verb: 'set_config_session' };
      }
      continue;
    }
    if (lead === 'set') {
      if (statement.split(' ')[1] !== 'local') return { ok: false, verb: 'set_session' };
      continue;
    }
    if (lead === 'begin' || lead === 'start') {
      if (/\bread write\b/.test(statement)) return { ok: false, verb: 'begin_read_write' };
      continue;
    }
    if (TX_CONTROL.has(lead)) continue;
    if (TELEMETRY_WRITE.test(statement)) return { ok: false, verb: 'telemetry_write' };
    return { ok: false, verb: /^[a-z_]+$/.test(lead) ? lead : 'other' };
  }
  return { ok: true };
}

export class GuardRefusal extends Error {
  constructor(readonly verb: string) {
    super('live-recall guard refused a ' + verb + ' statement');
    this.name = 'GuardRefusal';
  }
}

export interface GuardCounters { refusals: Record<string, number> }

/** Force read-only transactions and put the allowlist in front of every raw-SQL seam the engine exposes. */
export function installGuards(engine: any, counters: GuardCounters): void {
  for (const name of ['executeRaw', 'executeRawDirect']) {
    const original = engine[name];
    if (typeof original !== 'function') continue;
    engine[name] = function (this: unknown, sql: string, ...rest: unknown[]) {
      const verdict = classifySql(sql);
      if (!verdict.ok) {
        counters.refusals[verdict.verb] = (counters.refusals[verdict.verb] ?? 0) + 1;
        return Promise.reject(new GuardRefusal(verdict.verb));
      }
      return original.call(this, sql, ...rest);
    };
  }
  for (const name of ['transaction', 'transactionDirect']) {
    const original = engine[name];
    if (typeof original !== 'function') continue;
    engine[name] = function (this: unknown, fn: unknown, opts?: Record<string, unknown>) {
      return original.call(this, fn, { ...opts, readOnly: true });
    };
  }
}

/** Both checks must hold on the connection the engine routes reads through. */
export async function verifyReadOnly(engine: any): Promise<void> {
  const [row] = await engine.executeRaw("SELECT current_setting('transaction_read_only') AS ro, current_setting('default_transaction_read_only') AS dro");
  if (row?.ro !== 'on' || row?.dro !== 'on') throw new LiveRecallAbort('LR_READONLY_UNVERIFIED', 'transaction_read_only=' + (row?.ro === 'on' ? 'on' : 'off'));
  const mode = engine.connectionManager?.describeMode?.().mode;
  if (typeof mode === 'string' && !mode.startsWith('single')) throw new LiveRecallAbort('LR_READONLY_UNVERIFIED', 'direct pool active');
}

/** A Supabase transaction-pooler URL becomes the session pooler; the read-only startup parameter is appended. */
export function readOnlyUrl(url: string): { url: string; connection: 'session_pooler' | 'transaction_pooler_rewritten' | 'direct_or_local' } {
  const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
  const scheme = url.slice(0, url.indexOf('://'));
  let connection: 'session_pooler' | 'transaction_pooler_rewritten' | 'direct_or_local' = parsed.hostname.includes('pooler.') ? 'session_pooler' : 'direct_or_local';
  if (parsed.port === '6543') {
    parsed.port = '5432';
    connection = 'transaction_pooler_rewritten';
  }
  parsed.searchParams.delete('pgbouncer');
  parsed.searchParams.set('default_transaction_read_only', 'on');
  return { url: scheme + '://' + parsed.toString().slice('http://'.length), connection };
}

export interface OpenedBrain {
  engine: any;
  barrier: BarrierKind;
  connection: string;
  schema_version: number;
  code_schema_version: number;
  close(): Promise<void>;
}

/** Refuse a brain whose schema differs from the gbrain code loaded; the runner never migrates. */
export async function checkSchema(engine: any, gut: GbrainUnderTest): Promise<{ schema_version: number; code_schema_version: number }> {
  const { LATEST_VERSION } = await importGbrain<{ LATEST_VERSION: number }>(gut, 'src/core/migrate.ts');
  const schema_version = Number(await engine.getConfig('version'));
  if (schema_version !== LATEST_VERSION) throw new LiveRecallAbort('LR_SCHEMA_MISMATCH', 'brain schema ' + schema_version + ', loaded gbrain expects ' + LATEST_VERSION);
  return { schema_version, code_schema_version: LATEST_VERSION };
}

/**
 * Database URLs and keys gbrain must not see. They are set to the empty string,
 * not deleted, because gbrain's config loader fills any absent variable from
 * ~/.gbrain/.env, which on a brain's own box names the live database.
 */
const BLANKED_ENV = ['GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_DIRECT_DATABASE_URL', 'TYPESAFE_API_KEY', 'JEV_TYPESAFE_API_KEY', 'GBRAIN_DECIDE_SLOTS'];

/**
 * Open a Postgres brain: env hygiene, barrier proof, guards, verification and
 * the schema check, in that order. Nothing is searched before all of them pass.
 */
export async function openPostgresBrain(gut: GbrainUnderTest, databaseUrlEnv: string, counters: GuardCounters): Promise<OpenedBrain> {
  const source = process.env[databaseUrlEnv];
  if (!source) throw new LiveRecallAbort('LR_NO_DATABASE_URL', 'env ' + (/^[A-Z0-9_]+$/.test(databaseUrlEnv) ? databaseUrlEnv : 'var') + ' is empty');
  if (process.env.GBRAIN_DIRECT_DATABASE_URL) throw new LiveRecallAbort('LR_DIRECT_URL_OVERRIDE', 'GBRAIN_DIRECT_DATABASE_URL is set');
  delete process.env[databaseUrlEnv];
  for (const key of BLANKED_ENV) process.env[key] = '';
  process.env.GBRAIN_DISABLE_DIRECT_POOL = '1';

  const { loadConfig, toEngineConfig, loadConfigWithEngine } = await importGbrain<any>(gut, 'src/core/config.ts');
  const { buildGatewayConfig } = await importGbrain<any>(gut, 'src/core/ai/build-gateway-config.ts');
  const { configureGateway } = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
  const { createEngine } = await importGbrain<any>(gut, 'src/core/engine-factory.ts');

  const { url, connection } = readOnlyUrl(source);
  const config = { ...(loadConfig() ?? {}), engine: 'postgres', database_url: url };
  if (BLANKED_ENV.some(key => process.env[key] !== '')) throw new LiveRecallAbort('LR_DIRECT_URL_OVERRIDE', 'a blanked database variable was set again while loading gbrain config');
  configureGateway(buildGatewayConfig(config));
  const engineConfig = { ...toEngineConfig(config), pool_max: 2 };
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    const raw: Raw = sql => engine.executeRaw(sql);
    const barrier = await proveBarrier(raw);
    installGuards(engine, counters);
    await verifyReadOnly(engine);
    const schema = await checkSchema(engine, gut);
    configureGateway(buildGatewayConfig(await loadConfigWithEngine(engine, config)));
    return { engine, barrier, connection, ...schema, close: () => engine.disconnect() };
  } catch (error) {
    await engine.disconnect().catch(() => {});
    throw error;
  }
}
