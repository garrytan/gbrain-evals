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
  LR_NO_BARRIER: 'Make a copy with eval/runner/live-recall/snapshot.sh and connect to it on 127.0.0.1, or use a hot standby or a role without write privileges.',
  LR_READONLY_UNVERIFIED: 'The session did not report read-only, or the direct pool is active; rerun against the copy and report the detail.',
  LR_DIRECT_URL_OVERRIDE: 'Unset GBRAIN_DIRECT_DATABASE_URL in the shell that runs the runner.',
  LR_SCHEMA_MISMATCH: 'Run with --gbrain <checkout>@<commit> at the gbrain version that wrote the brain.',
  LR_QUESTIONS_INVALID: 'Fix the question file at the reported line and field, then rerun freeze.',
  LR_FREEZE_MISMATCH: 'Rerun freeze on this exact question file and send the new freeze numbers before the counted run. On a phase 2 --resume, resume with the first session\'s harness, gbrain, barrier kind, source, retrieval settings, models, arms, forms and tasks, or start a new run directory.',
  LR_COMPARE_CONTROL: 'One run directory is a --fixture control; compare or pool counted runs only.',
  LR_POOL_MISMATCH: 'Pool two counted runs made on different frozen question files with the same gbrain commit and search settings; the detail names what differs.',
  LR_GOLD_MISSING_CAP: 'More than 10% of questions name a gold page the brain does not hold; fix the gold slugs or use a fresher copy.',
  LR_RERANK_NEEDS_TYPESAFE: 'The configured reranker needs a TypeSafe key; ask GBEV-3 how to measure the configured arm.',
  LR_CUSTODY_LEAK: 'An output file would have carried private text; nothing was written. Report the field name to GBEV-3.',
  LR_EMBEDDING_UNAVAILABLE: 'Embedding the preflight query failed, at the start or when phase 2 resent it after an episode degraded (that episode has no record); export or top up the key for the brain\'s embedding provider (the same one gbrain uses on this box) and rerun, or continue a phase 2 run with --resume.',
  LR_ARM_PREFLIGHT: 'An arm failed on the public probe query before any question ran; the detail names the arm and gbrain\'s failure stage. title_arm_failed or keyword_arm_failed usually means the role lacks EXECUTE on one of gbrain\'s non-definer helper functions (RUN-KIT lists them); embed_* or rerank_* means the provider key or service. Phase 2 also resends the probe after an episode degrades, and that episode has no record. Fix it and rerun, or continue a phase 2 run with --resume.',
  LR_EMBEDDING_UNVERIFIED: 'gbrain found no explicit embedding model; run as the user whose ~/.gbrain/config.json serves this brain, or set GBRAIN_HOME to its parent directory.',
  LR_TASKS_INVALID: 'Fix the task file at the reported line and field, then freeze again.',
  LR_PRIVACY_RELAXED: 'The brain shows private pages to remote callers (search.remote_private_pages), at the start, before a task or after an episode; that episode has no record and no later task ran. GBEV-3 decides; the runner never relaxes it.',
  LR_CAP_STOP: 'The budget ledger refused a reservation at the cap, so the run is paused there, incomplete: ask GBEV-3 for an extension, then continue with --resume --window-note <extension id> --budget-usd <new cap> (tasks.ts judge takes the same two flags).',
  LR_CELL_INVALID: 'A cell passed its error or degraded-search cap; the scorecard reports it invalid (not an abort).',
  LR_JUDGE_ERROR: 'Judge output failed to parse twice; `tasks.ts judge <run dir>` re-judges those answers without re-answering.',
  LR_RESUME_NEEDS_WINDOW: 'A counted --resume needs --window-note <id> from GBEV-3\'s window note; ask GBEV-3 for one.',
  LR_COST_GATE: 'The projected counted cost breaks the cost gate (paraphrase pass over 75% of the cap, or the total over the cap); send the projection to GBEV-3 before any counted call.',
  LR_PROVIDER_REJECTED: 'A provider refused the key, the model or the account (401, 403, 404, another 4xx, a credit or billing 400, OpenAI\'s 429 insufficient_quota, or Particle\'s 402 for an empty prepaid balance); that episode has no record. Fix the key, model access or balance, then continue with --resume.',
  LR_GOLD_OUT_OF_SOURCE: 'A gold page lives only in a source other than the one the runner reads (the source `gbrain sources current` names from the repository root in this shell); nothing was written and no task was dropped. Send the detail line to GBEV-3, which decides between fixing the gold slug and reading another source.',
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

/**
 * Prove that the server, not this process, refuses writes. Throws LR_NO_BARRIER otherwise.
 * A copy counts only on a loopback URL (snapshot.sh publishes its container on
 * 127.0.0.1; the server itself sees the container's address, so the host is
 * read from the URL) and only when its marker carries the connected cluster's
 * system identifier, so a marker table restored into, or created on, another
 * cluster proves nothing.
 */
export async function proveBarrier(raw: Raw, loopback: boolean): Promise<BarrierKind> {
  const [marker] = await raw("SELECT to_regclass('public." + COPY_MARKER_TABLE + "') IS NOT NULL AS present");
  if (marker?.present === true && loopback) {
    const [copy] = await raw(
      "SELECT (SELECT copy_system_identifier FROM public." + COPY_MARKER_TABLE + " LIMIT 1) = (SELECT system_identifier::text FROM pg_control_system()) AS same_cluster",
    ).catch(() => []);
    if (copy?.same_cluster === true) return 'copy';
  }
  const [standby] = await raw('SELECT pg_is_in_recovery() AS standby');
  if (standby?.standby === true) return 'standby';
  const [role] = await raw('SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user');
  if (role && role.superuser === false) {
    const [writable] = await raw(
      "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace " +
      "WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname NOT LIKE 'pg_toast%' " +
      "AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE') " +
      "OR has_any_column_privilege(c.oid, 'INSERT') OR has_any_column_privilege(c.oid, 'UPDATE'))",
    );
    const [creatable] = await raw(
      "SELECT count(*)::int AS n FROM pg_namespace s WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname NOT LIKE 'pg_%' AND has_schema_privilege(s.oid, 'CREATE')",
    );
    const [other] = await raw(
      "SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE c.relkind = 'S' AND s.nspname NOT IN ('pg_catalog', 'information_schema') " +
      "AND (has_sequence_privilege(c.oid, 'UPDATE') OR has_sequence_privilege(c.oid, 'USAGE'))) AS sequences, " +
      "has_database_privilege(current_database(), 'CREATE') AS create_db, " +
      "(SELECT count(*)::int FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE p.prosecdef AND s.nspname = 'public' AND has_function_privilege(p.oid, 'EXECUTE')) AS definer_functions",
    );
    if (Number(writable?.n) === 0 && Number(creatable?.n) === 0 && Number(other?.sequences) === 0 && other?.create_db === false && Number(other?.definer_functions) === 0) return 'no_write_privilege';
  }
  throw new LiveRecallAbort('LR_NO_BARRIER', 'no copy marker, not a standby, and the role can write');
}

/**
 * Reduce SQL to its structure in one left-to-right pass, the way Postgres's
 * lexer reads it: comments (nested block comments included) become a space,
 * string literals ('', E'' with backslash escapes, dollar quotes) become '',
 * a quoted identifier keeps its name when quoting changes nothing ("set_config"
 * is set_config) and otherwise becomes ident. Keyword checks then see only
 * structure. With keepNames, a literal or quoted name shaped like a setting
 * name keeps its text, so the setting a statement names can be read.
 */
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

const NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function structure(sql: string, keepNames = false): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      out += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++;
      }
      out += ' ';
    } else if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? '');
      const start = ++i;
      while (i < sql.length) {
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") { i++; break; } else i++;
      }
      const body = sql.slice(start, i - 1);
      out += keepNames && NAME.test(body) ? "'" + body + "'" : "''";
    } else if (c === '"') {
      const start = ++i;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') { i++; break; } else i++;
      }
      const name = sql.slice(start, i - 1);
      out += /^[a-z_][a-z0-9_]*$/.test(name) || (keepNames && NAME.test(name)) ? name : 'ident';
    } else if (c === '$' && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '') && DOLLAR_TAG.test(sql.slice(i, i + 66))) {
      const tag = sql.slice(i, i + 66).match(DOLLAR_TAG)![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
      out += "''";
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The top-level arguments of each set_config( ... ) call, after structure(). */
function setConfigCalls(statement: string): string[][] {
  const calls: string[][] = [];
  for (const m of statement.matchAll(/\bset_config\s*\(/g)) {
    const args: string[] = [];
    let depth = 1, i = m.index! + m[0].length, start = i;
    for (; i < statement.length && depth > 0; i++) {
      const ch = statement[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) args.push(statement.slice(start, i).trim()); }
      else if (ch === ',' && depth === 1) { args.push(statement.slice(start, i).trim()); start = i + 1; }
    }
    calls.push(args);
  }
  return calls;
}

/** Settings no statement may change, even for one transaction, and the verb each refusal counts under. */
const PROTECTED_SETTINGS: Record<string, string> = { role: 'set_role', session_authorization: 'set_role', default_transaction_read_only: 'read_only_setting', transaction_read_only: 'read_only_setting' };

const READ_LEADS = new Set(['select', 'with', 'values', 'show', 'explain', 'table']);
const TX_CONTROL = new Set(['commit', 'rollback', 'end', 'savepoint', 'release']);
const DATA_MODIFYING = /\b(insert\s+into|update\s+(only\s+)?[a-z0-9_."]+(\s*\*)?(\s+(as\s+)?[a-z0-9_]+)?\s+set|delete\s+from|merge\s+into|truncate)\b/;
const WRITE_FUNCTIONS = /\b(nextval|setval|lo_[a-z_]+|dblink[a-z_]*|pg_file_write|pg_terminate_backend|pg_cancel_backend|pg_reload_conf)\s*\(/;

export type SqlVerdict = { ok: true } | { ok: false; verb: string };

/** gbrain's search path flushes per-query counters into this table; the guard names it so a refusal count reads plainly. */
const TELEMETRY_WRITE = /^(insert into|update|delete from) (public\.)?search_telemetry\b/;

/**
 * The executeRaw allowlist: reads, transaction-local settings and transaction
 * control only. SET LOCAL passes only as `set local <plain name> = | to …`
 * for an unprotected name, and SQL with a Unicode escape (U&) is refused. Keyword checks read the structure with every literal blanked;
 * setting names are read from a second pass that keeps name-shaped literals and
 * quoted names, because set_config and SET name the setting there.
 */
export function classifySql(sql: string): SqlVerdict {
  if (/u&['"]/i.test(sql)) return { ok: false, verb: 'unicode_escape' };
  return classifyStructure(structure(sql), structure(sql, true));
}

/** classifySql on the two structure passes; passes that split into different statements are refused. */
export function classifyStructure(plain: string, withNamesKept: string): SqlVerdict {
  const statements = (s: string) => s.split(';').map(x => x.trim()).filter(Boolean);
  const named = statements(withNamesKept);
  const plainStatements = statements(plain);
  if (named.length !== plainStatements.length) return { ok: false, verb: 'unparsed' };
  for (const [k, statement] of plainStatements.entries()) {
    const withNames = named[k]!;
    if (/\b(default_transaction_read_only|transaction_read_only|session characteristics)\b/.test(statement)) return { ok: false, verb: 'read_only_setting' };
    const lead = statement.split(' ')[0]!;
    if (READ_LEADS.has(lead)) {
      if (DATA_MODIFYING.test(statement)) return { ok: false, verb: 'data_modifying_cte' };
      if (/\binto\b/.test(statement)) return { ok: false, verb: 'select_into' };
      if (WRITE_FUNCTIONS.test(statement)) return { ok: false, verb: 'write_function' };
      for (const args of setConfigCalls(withNames)) {
        const name = /^e?'([a-z_][a-z0-9_.]*)'$/.exec(args[0] ?? '')?.[1];
        if (!name) return { ok: false, verb: 'set_config_dynamic' };
        if (PROTECTED_SETTINGS[name]) return { ok: false, verb: PROTECTED_SETTINGS[name]! };
        if (args.at(-1) !== 'true') return { ok: false, verb: 'set_config_session' };
      }
      continue;
    }
    if (lead === 'set') {
      const [, scope, ...rest] = withNames.split(' ');
      if (scope !== 'local') return { ok: false, verb: 'set_session' };
      const setting = rest.join(' ');
      const name = /^[a-z_][a-z0-9_.]*/.exec(setting)?.[0] ?? '';
      if (name === 'session') return { ok: false, verb: 'set_role' };
      if (PROTECTED_SETTINGS[name]) return { ok: false, verb: PROTECTED_SETTINGS[name]! };
      if (!/^[a-z_][a-z0-9_.]* ?(=|to\b)/.test(setting)) return { ok: false, verb: 'set_local_other' };
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
export function readOnlyUrl(url: string): { url: string; connection: 'session_pooler' | 'transaction_pooler_rewritten' | 'direct_or_local'; loopback: boolean } {
  const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
  const scheme = url.slice(0, url.indexOf('://'));
  let connection: 'session_pooler' | 'transaction_pooler_rewritten' | 'direct_or_local' = parsed.hostname.includes('pooler.') ? 'session_pooler' : 'direct_or_local';
  if (parsed.port === '6543') {
    parsed.port = '5432';
    connection = 'transaction_pooler_rewritten';
  }
  parsed.searchParams.delete('pgbouncer');
  parsed.searchParams.set('default_transaction_read_only', 'on');
  const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(parsed.hostname) && !parsed.searchParams.has('host') && !parsed.searchParams.has('hostaddr');
  return { url: scheme + '://' + parsed.toString().slice('http://'.length), connection, loopback };
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

  const { url, connection, loopback } = readOnlyUrl(source);
  const config = { ...(loadConfig() ?? {}), engine: 'postgres', database_url: url };
  if (BLANKED_ENV.some(key => process.env[key] !== '')) throw new LiveRecallAbort('LR_DIRECT_URL_OVERRIDE', 'a blanked database variable was set again while loading gbrain config');
  configureGateway(buildGatewayConfig(config));
  const engineConfig = { ...toEngineConfig(config), pool_max: 2 };
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    const raw: Raw = sql => engine.executeRaw(sql);
    const barrier = await proveBarrier(raw, loopback);
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
