/**
 * N6 on the production path: Postgres over the real HTTP transport (W12 of
 * the 2026-10 follow-up round; preregistration
 * docs/benchmarks/2026-10-06-n6-postgres-http-preregistration.md).
 *
 * The world, targets, parameter synthesis and leak scanners are N6's
 * (eval/runner/n6-visibility-fuzz.ts). What changes is the path:
 *
 *   engine     a fresh Postgres database (localhost only), initialised by the
 *              gbrain CLI and seeded through gbrain's own write path by a
 *              trusted local caller in process;
 *   transport  `gbrain serve --http --bind 127.0.0.1` as a separate process,
 *              every probe a real HTTP request with its own MCP session;
 *   principals none, invalid-token, expired-token (refused principals),
 *              scoped (OAuth read client on source alpha) and owner (OAuth
 *              read/write/admin client federated over alpha and beta);
 *   conditions warm caches (owner first, then owner and scoped interleaved,
 *              then scoped again) and pooled connections (GBRAIN_POOL_SIZE=8,
 *              8 requests in flight, pg_stat_activity sampled).
 *
 * The trusted local control runs in process on the same database before the
 * server starts serving probes, so every server connection seen during the
 * interleaved phase belongs to the server.
 *
 * Usage:
 *   bun eval/runner/n6-postgres-http.ts [--pg-url <admin url>] [--output <dir>] [--attest <prereg.md>] [--concurrency 8] [--only op1,op2] [--gbrain <checkout>[@ref]]
 *   bun eval/runner/n6-postgres-http.ts rescore <receipt.json>     # keyless, recomputes the verdict from the stored cells
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import type { Operation, OperationContext } from 'gbrain/operations';
import { generateN6World, ledgerFingerprint, N6_DEFAULT_SEED, N6_GENERATOR_VERSION, type N6ClassSpec, type N6Ledger, type N6Target } from '../generators/n6-visibility-gen.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, strippedKeysIn, withHermeticEnv } from './hermetic-env.ts';
import { freePort } from './lifecycle/slice.ts';
import { runCli, type RunEnv } from './lifecycle/drivers.ts';
import {
  controlSeen, echoCredit, isDenial, isTargeted, loadGbrain, makeCallers, normalizeForOracle, oracleView, parseToolResult, presence,
  scanLeaks, seed, synthesizeParams, targetTitle, variantsFor, type CallOutcome,
} from './n6-visibility-fuzz.ts';
import { attestPreregistration, type Attestation } from './prereg.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';

export const CATEGORY = 'n6-postgres-http';
export const PREREGISTRATION = 'docs/benchmarks/2026-10-06-n6-postgres-http-preregistration.md';

/** The 31 read ops N6 covered at c5fb0201 on PGLite (W2 receipt), frozen by the preregistration. */
export const MANDATORY_OPS = [
  'entity', 'get_page', 'list_pages', 'fetch', 'search', 'query', 'assemble_evidence', 'get_tags', 'get_links', 'get_backlinks',
  'traverse_graph', 'get_timeline', 'get_versions', 'get_raw_data', 'resolve_slugs', 'get_chunks', 'find_orphans', 'takes_list',
  'takes_search', 'think', 'get_recent_salience', 'chronicle_day', 'chronicle_since', 'chronicle_last_seen', 'ontology_get',
  'volunteer_chronicle', 'volunteer_context', 'recall', 'context_pack', 'delta', 'find_trajectory',
] as const;

/** Optional cells named in advance; each needs its own seeded surface. */
export const OPTIONAL_OPS: Readonly<Record<string, string>> = {
  get_active_schema_pack: 'schema-pack', list_schema_packs: 'schema-pack', schema_stats: 'schema-pack', schema_lint: 'schema-pack',
  schema_graph: 'schema-pack', schema_explain_type: 'schema-pack', schema_review_orphans: 'schema-pack',
  takes_scorecard: 'aggregate', takes_calibration: 'aggregate', get_calibration_profile: 'aggregate', find_anomalies: 'aggregate', find_experts: 'aggregate',
  open_loops: 'open-loop',
};

export type Principal = 'none' | 'invalid-token' | 'expired-token' | 'scoped' | 'owner';
export const REFUSED: readonly Principal[] = ['none', 'invalid-token', 'expired-token'];
export const PROBING: readonly Principal[] = ['scoped', 'owner'];
export const PRINCIPALS: readonly Principal[] = [...REFUSED, ...PROBING];
export type Phase = 'warm-owner' | 'interleaved' | 'scoped-again';

// ─── Gold per principal ────────────────────────────────────────────────

/** Classes whose protected content a principal must never read. The owner is granted `beta`, so foreign_source is not protected from it. */
export function protectedClasses(ledger: Pick<N6Ledger, 'classes'>, p: Principal): N6ClassSpec[] {
  return ledger.classes.filter(c => p !== 'owner' || c.class !== 'foreign_source');
}

export function forbiddenFor(ledger: Pick<N6Ledger, 'classes'>, p: Principal): { markers: string[]; slugs: string[]; betaForbidden: boolean } {
  const cls = protectedClasses(ledger, p);
  return { markers: cls.flatMap(c => c.protected_markers), slugs: cls.flatMap(c => c.protected_slugs), betaForbidden: p !== 'owner' };
}

/** N6's scanner, minus the beta-row existence rule for a principal granted beta. */
export function scanFor(outcome: CallOutcome, gold: ReturnType<typeof forbiddenFor>, askedFor: readonly string[], permitted?: ReadonlyMap<string, number>) {
  const r = scanLeaks(outcome, gold.markers, gold.slugs, askedFor, permitted);
  if (!gold.betaForbidden && r.existence === 'a result row carries source_id beta') r.existence = null;
  return r;
}

// ─── Rows, cells and the verdict ───────────────────────────────────────

export interface ProbeRow {
  phase: Phase;
  principal: Principal;
  op: string;
  target: string;
  variant: string;
  status: 'leak' | 'oracle' | 'clean' | 'no_signal' | 'not_exposed' | 'harness_error';
  control: boolean;
  evidence?: string;
  error?: string;
}

export interface RefusalRow {
  principal: Principal;
  op: string;
  http_status: number;
  refused: boolean;
  canary: string | null;
  detail: string;
}

export interface CellSummary {
  principal: Principal;
  op: string;
  mandatory: boolean;
  probes: number;
  signal: number;
  signal_by_phase: Partial<Record<Phase, number>>;
  leaks: number;
  oracles: number;
  errors: number;
  refusals?: number;
  accepted?: number;
  covered: boolean;
  status: 'Complete' | 'Failed' | 'Not covered';
  reason?: string;
}

export function summarizeCells(ops: readonly string[], rows: readonly ProbeRow[], refusals: readonly RefusalRow[], opts: { poolConditionMet: boolean; mandatory: (op: string) => boolean }): CellSummary[] {
  const out: CellSummary[] = [];
  for (const principal of PRINCIPALS) {
    for (const op of ops) {
      const mandatory = opts.mandatory(op);
      if (REFUSED.includes(principal)) {
        const rs = refusals.filter(r => r.principal === principal && r.op === op);
        const accepted = rs.filter(r => !r.refused).length;
        const canaries = rs.filter(r => r.canary).length;
        const covered = rs.length > 0 && accepted === 0;
        const leaks = accepted + canaries;
        out.push({ principal, op, mandatory, probes: rs.length, signal: rs.length, signal_by_phase: {}, leaks, oracles: 0, errors: 0, refusals: rs.length - accepted, accepted, covered,
          status: leaks ? 'Failed' : covered ? 'Complete' : 'Not covered', ...(covered ? {} : { reason: rs.length ? 'request accepted' : 'no refused call recorded' }) });
        continue;
      }
      const rs = rows.filter(r => r.principal === principal && r.op === op && r.status !== 'not_exposed');
      const byPhase: Partial<Record<Phase, number>> = {};
      for (const r of rs) if (r.control) byPhase[r.phase] = (byPhase[r.phase] ?? 0) + 1;
      const leaks = rs.filter(r => r.status === 'leak').length;
      const oracles = rs.filter(r => r.status === 'oracle').length;
      const signal = rs.filter(r => r.control).length;
      const phasesOk = principal === 'scoped' ? !!byPhase.interleaved && !!byPhase['scoped-again'] : signal > 0;
      const covered = signal > 0 && phasesOk && opts.poolConditionMet;
      const reason = !rs.length ? 'not exposed over HTTP to this principal'
        : !signal ? 'no signal-bearing probe (the trusted control never read protected content, or the principal never saw the twin)'
        : !phasesOk ? 'signal missing in one of the interleaved and scoped-again phases'
        : !opts.poolConditionMet ? 'pooled-connection condition not met (fewer than 2 concurrent server connections)' : undefined;
      out.push({ principal, op, mandatory, probes: rs.length, signal, signal_by_phase: byPhase, leaks, oracles, errors: rs.filter(r => r.status === 'harness_error').length, covered,
        status: leaks || oracles ? 'Failed' : covered ? 'Complete' : 'Not covered', ...(reason && !covered ? { reason } : {}) });
    }
  }
  return out;
}

export interface Verdict { pass: boolean; failures: string[]; leaks: number; oracles: number; accepted: number; mandatory_cells: number; mandatory_covered: number; missing_mandatory: string[]; harness_error_rate: number }

/** The preregistered decision rule, from cells and call accounting alone. */
export function verdictFor(cells: readonly CellSummary[], calls: { total: number; harness_errors: number }): Verdict {
  const leaks = cells.reduce((n, c) => n + (REFUSED.includes(c.principal) ? 0 : c.leaks), 0);
  const oracles = cells.reduce((n, c) => n + c.oracles, 0);
  const accepted = cells.reduce((n, c) => n + (c.accepted ?? 0), 0);
  const refusedCanaries = cells.reduce((n, c) => n + (REFUSED.includes(c.principal) ? c.leaks - (c.accepted ?? 0) : 0), 0);
  const mandatory = cells.filter(c => c.mandatory);
  const missing = mandatory.filter(c => !c.covered).map(c => `${c.principal}:${c.op}`);
  const rate = calls.total ? calls.harness_errors / calls.total : 0;
  const failures: string[] = [];
  if (leaks + refusedCanaries) failures.push(`${leaks + refusedCanaries} leaking probes or refusals carrying a canary`);
  if (oracles) failures.push(`${oracles} existence-oracle probes`);
  if (accepted) failures.push(`${accepted} requests accepted from an unauthenticated or invalid principal`);
  if (missing.length) failures.push(`${missing.length} mandatory cells not covered`);
  if (!(rate < 0.02)) failures.push(`harness errors ${(rate * 100).toFixed(2)}% of calls (limit 2%)`);
  if (mandatory.length === 0) failures.push('no mandatory cell');
  return { pass: failures.length === 0, failures, leaks: leaks + refusedCanaries, oracles, accepted, mandatory_cells: mandatory.length, mandatory_covered: mandatory.length - missing.length, missing_mandatory: missing, harness_error_rate: rate };
}

/** Is an HTTP reply a refusal of an unauthenticated or invalid principal? */
export function isRefusal(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status >= 200 && status < 300) {
    try {
      const m = JSON.parse(body) as { error?: { message?: string } };
      return !!m.error && /auth|token|unauthori[sz]ed|forbidden/i.test(m.error.message ?? '');
    } catch { return false; }
  }
  return false;
}

// ─── HTTP ──────────────────────────────────────────────────────────────

interface HttpReply { status: number; headers: string; text: string; msg: Record<string, unknown> | null; sid: string | null }

async function post(port: number, auth: string | null, body: Record<string, unknown>, sid?: string): Promise<HttpReply> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (auth !== null) headers.authorization = `Bearer ${auth}`;
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  const hdrs = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
  let msg: Record<string, unknown> | null = null;
  if ('id' in body) {
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const d of text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())) {
        try { const m = JSON.parse(d); if (m.id === body.id) { msg = m; break; } } catch { /* ignore */ }
      }
    } else {
      try { msg = JSON.parse(text); } catch { /* not JSON */ }
    }
  }
  return { status: res.status, headers: hdrs, text, msg, sid: res.headers.get('mcp-session-id') };
}

async function fetchToken(port: number, client: { id: string; secret: string; scope: string }): Promise<{ token: string; expires_in: number | null; issued_at: number }> {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: client.id, client_secret: client.secret, scope: client.scope, resource: `http://localhost:${port}/mcp` });
  const issued_at = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  const json = (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })();
  if (!res.ok || typeof json.access_token !== 'string') throw new Error(`token endpoint HTTP ${res.status}: ${text.slice(0, 300)}`);
  return { token: json.access_token, expires_in: typeof json.expires_in === 'number' ? json.expires_in : null, issued_at };
}

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbrain-evals-n6-postgres-http', version: '1' } };
let rpcId = 1;
/** Whether the server issued MCP session ids (stateful) or answered each request alone (stateless). */
export const sessionModes = new Set<'stateful' | 'stateless'>();

/** One tools/call in a fresh MCP session. */
async function callInSession(port: number, token: string, op: string, args: Record<string, unknown>): Promise<CallOutcome & { http_status?: number }> {
  let sid: string | null = null;
  try {
    const init = await post(port, token, { jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: INIT });
    if (!init.msg?.result) return { exposed: true, ok: false, error_code: 'harness_session', raw: `${init.status} ${init.text.slice(0, 300)}`, data: null, timed_out: true, http_status: init.status };
    sid = init.sid;
    sessionModes.add(sid ? 'stateful' : 'stateless');
    await post(port, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid ?? undefined);
    const r = await post(port, token, { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: op, arguments: args } }, sid ?? undefined);
    if (r.status === 429) return { exposed: true, ok: false, error_code: 'harness_rate_limited', raw: r.text.slice(0, 300), data: null, timed_out: true, http_status: r.status };
    if (!r.msg) return { exposed: true, ok: false, error_code: 'harness_no_reply', raw: `${r.status} ${r.text.slice(0, 300)}`, data: null, timed_out: true, http_status: r.status };
    if (r.msg.error) {
      const raw = JSON.stringify(r.msg.error);
      const o: CallOutcome = { exposed: true, ok: false, error_code: 'rpc_error', raw, data: r.msg.error };
      return { ...o, exposed: !/unknown tool|not found|method not found/i.test(raw), http_status: r.status };
    }
    const result = r.msg.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const o = parseToolResult({ content: (result.content ?? []).filter(c => c.type === 'text').map(c => ({ text: c.text ?? '' })), isError: result.isError });
    return { ...o, exposed: o.exposed && !isDenial(o), http_status: r.status };
  } catch (e) {
    return { exposed: true, ok: false, error_code: 'harness_exception', raw: String((e as Error).message), data: null, timed_out: true };
  } finally {
    if (sid) await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sid }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }
}

// ─── Run ───────────────────────────────────────────────────────────────

export interface PgHttpOptions { pgAdminUrl: string; outputDir: string; concurrency: number; only?: string[]; gbrainSpec: string | null; attestation: Attestation | null; log: (s: string) => void }

interface Task { principal: Principal; op: Operation; unit: { id: string; protected: N6Target | null; cls?: N6ClassSpec }; variantId: string; scope: string; prot: Record<string, unknown>; ghost?: Record<string, unknown>; twin?: Record<string, unknown>; replayKey: string }

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (next < items.length) await fn(items[next++]); }));
}

export async function runPgHttp(opts: PgHttpOptions) {
  return withHermeticEnv('n6pg', () => runPgHttpHermetic(opts));
}

async function runPgHttpHermetic(opts: PgHttpOptions) {
  const { log } = opts;
  const startedAt = new Date().toISOString();
  const ledger = generateN6World(N6_DEFAULT_SEED);
  const gut = resolveGbrainUnderTest(opts.gbrainSpec);
  const g = await loadGbrain(gut);
  const { PostgresEngine } = await importGbrain<{ PostgresEngine: new () => { connect(c: unknown): Promise<void>; disconnect(): Promise<void>; executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> } }>(gut, 'src/core/postgres-engine.ts');
  const work = mkdtempSync(join(tmpdir(), 'n6pg-'));
  const home = join(work, 'gbrain-home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(work, 'user-home'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(work, 'user-home'), GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
    GBRAIN_POOL_SIZE: '8', GBRAIN_HTTP_RATE_LIMIT_IP: '100000000', GBRAIN_HTTP_RATE_LIMIT_TOKEN: '100000000',
  };
  const childKeys = strippedKeysIn(env);
  if (childKeys.length) throw new Error(`child environment carries provider keys: ${childKeys.join(', ')}`);
  const run: RunEnv = { buildDir: gut.root, env };
  const operator: Array<{ step: string; code: number; ms: number }> = [];
  const cli = async (step: string, args: string[]) => {
    const r = await runCli(run, args, 300_000);
    operator.push({ step, code: r.code, ms: r.ms });
    if (r.code !== 0) throw new Error(`${step} failed (exit ${r.code}): ${(r.stdout + r.stderr).replace(/gbrain_cs_[0-9a-f]+/g, 'gbrain_cs_<redacted>').slice(-600)}`);
    return r;
  };

  const db = `n6pg_${process.pid}_${Date.now()}`;
  const admin = new SQL(opts.pgAdminUrl);
  await admin.unsafe(`CREATE DATABASE ${db}`);
  const dbUrl = (() => { const u = new URL(opts.pgAdminUrl); u.pathname = `/${db}`; return u.toString(); })();
  const pgVersion = String((await admin.unsafe('SELECT version() AS v'))[0]?.v ?? '');
  let server: ChildProcess | null = null;
  const serverLog: string[] = [];
  try {
    await cli('init', ['init', '--url', dbUrl, '--no-embedding', '--non-interactive']);
    // Postgres guards source topology (writer administration), so sources are added through the CLI as git vaults.
    for (const s of ledger.sources) {
      const vault = join(work, `${s}-vault`);
      mkdirSync(vault, { recursive: true });
      const git = (args: string[]) => Bun.spawnSync(['git', '-C', vault, '-c', 'user.name=n6pg', '-c', 'user.email=n6pg@example.invalid', ...args]);
      git(['init', '-q']);
      Bun.write(join(vault, 'README.md'), `# ${s}\n\nA fictional vault for the N6 Postgres/HTTP run.\n`);
      await Bun.sleep(50);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'init']);
      await cli(`sources-add:${s}`, ['sources', 'add', s, '--path', vault]);
    }
    const clients: Record<'scoped' | 'owner' | 'expiring', { id: string; secret: string; scope: string }> = {} as never;
    for (const [name, args, scope] of [
      ['scoped', ['--scopes', 'read', '--source', 'alpha'], 'read'],
      ['owner', ['--scopes', 'read write admin', '--source', 'alpha', '--federated-read', 'alpha,beta'], 'read write admin'],
      ['expiring', ['--scopes', 'read', '--source', 'alpha', '--token-ttl', '60'], 'read'],
    ] as const) {
      const r = await cli(`register-client:${name}`, ['auth', 'register-client', `n6pg-${name}`, '--grant-types', 'client_credentials', ...args]);
      const id = (r.stdout.match(/gbrain_cl_[0-9a-f]+/) ?? [''])[0];
      const secret = (r.stdout.match(/gbrain_cs_[0-9a-f]+/) ?? [''])[0];
      if (!id || !secret) throw new Error(`could not parse OAuth client ${name}`);
      clients[name] = { id, secret, scope };
    }

    const port = await freePort(56400);
    server = spawn('bun', [join(gut.root, 'src/cli.ts'), 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port)], { env, cwd: home });
    server.stderr?.setEncoding('utf8'); server.stdout?.setEncoding('utf8');
    const keep = (c: string) => { serverLog.push(...c.split('\n').filter(Boolean).map(l => l.replace(/gbrain_[a-z]{2}_[0-9a-f]+/g, '<redacted>'))); if (serverLog.length > 400) serverLog.splice(0, serverLog.length - 400); };
    server.stderr?.on('data', keep); server.stdout?.on('data', keep);
    const tokens: Partial<Record<Principal, string>> = {};
    for (let t = Date.now(); ; ) {
      if (server.exitCode !== null) throw new Error(`serve --http exited: ${serverLog.slice(-5).join(' | ')}`);
      try { tokens.scoped = (await fetchToken(port, clients.scoped)).token; break; } catch (e) { if (Date.now() - t > 120_000) throw e; await Bun.sleep(500); }
    }
    // gbrain journals Postgres writes and the server's persistence consumer drains them, so seeding runs once the server is up.
    const engine = new PostgresEngine();
    await engine.connect({ database_url: dbUrl, poolSize: 4 });
    const config = { engine: 'postgres', database_url: dbUrl } as unknown as OperationContext['config'];
    const seedErrors = await seed(g, engine, ledger, config);
    const local = makeCallers(g, engine, config).local;
    const opByName = (n: string) => g.operations.find(o => o.name === n)!;
    const pres = await presence(engine, ledger, local, opByName('get_page'), opByName);
    const presenceOk = seedErrors.length === 0 && pres.checks.every(c => c.pass);
    log(`[n6pg] postgres ${db}; seeded ${ledger.pages.length} pages; presence ${presenceOk ? 'ok' : 'FAILED'}`);
    if (!presenceOk) throw new Error(`presence failed: ${[...seedErrors, ...pres.checks.filter(c => !c.pass).map(c => `${c.name} (${c.detail})`)].join('; ')}`);

    let expiring: Awaited<ReturnType<typeof fetchToken>> | null = null;
    tokens.owner = (await fetchToken(port, clients.owner)).token;
    expiring = await fetchToken(port, clients.expiring);
    const expiringControl = await post(port, expiring.token, { jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: INIT });
    const expiringValidBefore = !!expiringControl.msg?.result;
    tokens['invalid-token'] = `${tokens.scoped.split('_').slice(0, -1).join('_') || 'gbrain_at'}_${randomBytes(24).toString('hex')}`;
    log(`[n6pg] serve --http on 127.0.0.1:${port}; tokens issued (expiring token ttl ${expiring.expires_in}s, valid before expiry: ${expiringValidBefore})`);

    // Ops: the frozen list plus any optional op present; unknown names are recorded as missing.
    const wanted = opts.only ?? [...MANDATORY_OPS, ...Object.keys(OPTIONAL_OPS)];
    const ops = wanted.map(n => g.operations.find(o => o.name === n)).filter((o): o is Operation => !!o);
    const missingOps = wanted.filter(n => !g.operations.some(o => o.name === n));

    // Owner authority control: the federated grant really reaches beta.
    const betaOnly = ledger.classes.find(c => c.class === 'foreign_source')!;
    const ownerBeta = await callInSession(port, tokens.owner, 'get_page', { slug: betaOnly.protected.slug, source_id: 'beta' });
    const ownerBetaSeen = ownerBeta.ok && betaOnly.protected_markers.some(m => ownerBeta.raw.includes(m));

    // Tasks and the trusted local replays (in process, before any probe reaches the server).
    const hubTarget: N6Target = { slug: ledger.hub_slug, query: 'offsite planning', type: 'note', date: ledger.classes[0].twin.date };
    const tasks: Task[] = [];
    const unsupported: Record<string, string> = {};
    for (const principal of PROBING) {
      for (const op of ops) {
        const units = isTargeted(op.params)
          ? [...protectedClasses(ledger, principal).map(cls => ({ id: cls.class, protected: cls.protected, cls })), { id: 'hub', protected: hubTarget }]
          : [{ id: 'listing', protected: null }];
        for (const unit of units) {
          const titles = 'cls' in unit && unit.cls ? { p: targetTitle(ledger, unit.cls.protected), t: targetTitle(ledger, unit.cls.twin), g: targetTitle(ledger, unit.cls.ghost, unit.cls.protected) } : { p: unit.protected ? targetTitle(ledger, unit.protected) : undefined, t: undefined, g: undefined };
          for (const v of variantsFor(op.params)) {
            const prot = synthesizeParams(op.params, unit.protected, { ...v, title: titles.p });
            if (!prot.params) { unsupported[op.name] = prot.unsupported; continue; }
            const cls = 'cls' in unit ? unit.cls : undefined;
            const gh = cls ? synthesizeParams(op.params, cls.ghost, { ...v, title: titles.g }).params : undefined;
            const tw = cls ? synthesizeParams(op.params, cls.twin, { ...v, title: titles.t }).params : undefined;
            tasks.push({ principal, op, unit, variantId: v.id, scope: v.scope, prot: prot.params, ghost: gh, twin: tw, replayKey: `${op.name}:${unit.id}:${v.id}` });
          }
        }
      }
    }
    const localOut = new Map<string, { prot: CallOutcome; ghost: CallOutcome | null }>();
    for (const t of tasks) {
      if (localOut.has(t.replayKey)) continue;
      localOut.set(t.replayKey, { prot: await local(t.op, structuredClone(t.prot)), ghost: t.ghost ? await local(t.op, structuredClone(t.ghost)) : null });
    }
    await engine.disconnect();
    log(`[n6pg] ${ops.length} ops (${missingOps.length} named ops absent), ${tasks.length} probe tasks, ${localOut.size} trusted local replays`);

    // Probe phases.
    const rows: ProbeRow[] = [];
    let calls = 0;
    let harnessErrors = 0;
    const firstFinding: Record<string, string> = {};
    const http = async (principal: Principal, op: string, args: Record<string, unknown> | undefined) => {
      if (!args) return null;
      calls++;
      const r = await callInSession(port, tokens[principal]!, op, args);
      if (r.timed_out) harnessErrors++;
      return r;
    };
    const probe = async (phase: Phase, t: Task) => {
      const gold = forbiddenFor(ledger, t.principal);
      const lo = localOut.get(t.replayKey)!;
      const localHit = scanFor(lo.prot, gold, [], echoCredit(t.prot, t.ghost, lo.ghost?.raw, gold.markers));
      const localDetected = !!(localHit.content || localHit.existence);
      const pr = (await http(t.principal, t.op.name, t.prot))!;
      const base = { phase, principal: t.principal, op: t.op.name, target: t.unit.id, variant: t.variantId };
      if (!pr.exposed) { rows.push({ ...base, status: 'not_exposed', control: false }); return; }
      if (pr.timed_out) { rows.push({ ...base, status: 'harness_error', control: false, error: `${pr.error_code}: ${pr.raw.slice(0, 160)}` }); return; }
      const gr = await http(t.principal, t.op.name, t.ghost);
      const asked = Object.values(t.prot).filter((x): x is string => typeof x === 'string');
      const leak = scanFor(pr, gold, asked, echoCredit(t.prot, t.ghost, gr?.raw, gold.markers));
      let twinSeen = false;
      let oracle: string | null = null;
      const cls = t.unit.cls;
      if (cls) {
        const tr = await http(t.principal, t.op.name, t.twin);
        twinSeen = tr ? controlSeen(tr, cls.twin_markers, [cls.twin.slug]) : false;
        for (const [label, out, args] of [['twin', tr, t.twin], ['ghost', gr, t.ghost]] as const) {
          if (!out || !args) continue;
          const extra = scanFor(out, gold, Object.values(args).filter((x): x is string => typeof x === 'string'));
          if (extra.content) leak.content ??= `${label} call: ${extra.content}`;
          if (extra.existence) leak.existence ??= `${label} call: ${extra.existence}`;
        }
        if (gr && !gr.timed_out && !leak.content && !leak.existence) {
          const mask = [cls.protected, cls.ghost].flatMap(x => [x.slug, x.query, x.holder ?? '', x.tag ?? '', x.date ?? '', x.slug.split('/').pop() ?? '']);
          const a = normalizeForOracle(oracleView(pr), mask);
          const b = normalizeForOracle(oracleView(gr), mask);
          if (a !== b) oracle = `protected: ${a.slice(0, 400)} | ghost: ${b.slice(0, 400)}`;
        }
      } else {
        const twins = ledger.classes.flatMap(c => c.twin_markers);
        twinSeen = controlSeen(pr, twins, [...new Set(ledger.classes.map(c => c.twin.slug))]);
      }
      const control = localDetected && (twinSeen || t.scope !== 'ambient');
      const evidence = leak.content ?? leak.existence ?? oracle ?? undefined;
      const status: ProbeRow['status'] = leak.content || leak.existence ? 'leak' : oracle ? 'oracle' : control ? 'clean' : 'no_signal';
      if (evidence) firstFinding[`${t.principal}:${t.op.name}:${t.unit.id}:${t.variantId}:${phase}`] ??= evidence.slice(0, 600);
      rows.push({ ...base, status, control, ...(evidence ? { evidence: evidence.slice(0, 600) } : {}) });
    };

    const owners = tasks.filter(t => t.principal === 'owner');
    const scoped = tasks.filter(t => t.principal === 'scoped');
    const phaseTimes: Record<string, number> = {};
    const timed = async (name: Phase, list: Task[]) => { const t0 = Date.now(); await pool(list, opts.concurrency, t => probe(name, t)); phaseTimes[name] = Date.now() - t0; log(`[n6pg] phase ${name}: ${list.length} probes in ${Math.round(phaseTimes[name] / 1000)}s`); };
    await timed('warm-owner', owners);
    const interleaved: Task[] = [];
    for (let i = 0; i < Math.max(owners.length, scoped.length); i++) { if (scoped[i]) interleaved.push(scoped[i]); if (owners[i]) interleaved.push(owners[i]); }
    const samples: Array<{ total: number; active: number }> = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          const r = await admin.unsafe(`SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'active')::int AS active FROM pg_stat_activity WHERE datname = $1`, [db]);
          samples.push({ total: Number(r[0]?.total ?? 0), active: Number(r[0]?.active ?? 0) });
        } catch { /* keep sampling */ }
        await Bun.sleep(250);
      }
    })();
    await timed('interleaved', interleaved);
    sampling = false;
    await sampler;
    await timed('scoped-again', scoped);
    const maxConnections = Math.max(0, ...samples.map(s => s.total));
    const maxActive = Math.max(0, ...samples.map(s => s.active));
    const poolConditionMet = maxConnections >= 2;

    // Refused principals, after the probe phases so the expiring token has expired.
    if (expiring.expires_in !== null) {
      const wait = expiring.issued_at + expiring.expires_in * 1000 + 5000 - Date.now();
      if (wait > 0) { log(`[n6pg] waiting ${Math.ceil(wait / 1000)}s for the expiring token`); await Bun.sleep(wait); }
    }
    tokens['expired-token'] = expiring.token;
    const strict = forbiddenFor(ledger, 'scoped');
    const refusals: RefusalRow[] = [];
    const privatePage = ledger.classes.find(c => c.class === 'private_page')!;
    const refuse = async (principal: Principal, op: string, body: Record<string, unknown>) => {
      calls++;
      const auth = principal === 'none' ? null : tokens[principal]!;
      try {
        const r = await post(port, auth, body);
        const all = `${r.status}\n${r.headers}\n${r.text}`;
        const canary = strict.markers.find(m => all.toLowerCase().includes(m.toLowerCase())) ?? strict.slugs.find(s => all.includes(s)) ?? null;
        refusals.push({ principal, op, http_status: r.status, refused: isRefusal(r.status, r.text), canary, detail: r.text.slice(0, 200) });
      } catch (e) {
        harnessErrors++;
        refusals.push({ principal, op, http_status: 0, refused: false, canary: null, detail: `harness: ${(e as Error).message}` });
      }
    };
    for (const principal of REFUSED) {
      await refuse(principal, '(initialize)', { jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: INIT });
      await refuse(principal, '(tools/list)', { jsonrpc: '2.0', id: rpcId++, method: 'tools/list', params: {} });
      for (const op of ops) {
        const target = isTargeted(op.params) ? privatePage.protected : null;
        const args = synthesizeParams(op.params, target, { title: target ? targetTitle(ledger, target) : undefined }).params ?? {};
        await refuse(principal, op.name, { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: op.name, arguments: args } });
      }
    }

    const opNames = ops.map(o => o.name);
    const cells = summarizeCells(opNames, rows, refusals.filter(r => !r.op.startsWith('(')), { poolConditionMet, mandatory: op => (MANDATORY_OPS as readonly string[]).includes(op) });
    for (const name of missingOps) for (const principal of PRINCIPALS) cells.push({ principal, op: name, mandatory: (MANDATORY_OPS as readonly string[]).includes(name), probes: 0, signal: 0, signal_by_phase: {}, leaks: 0, oracles: 0, errors: 0, covered: false, status: 'Not covered', reason: 'op absent from gbrain operations at this build' });
    const handshakeRefusals = refusals.filter(r => r.op.startsWith('('));
    const handshakeAccepted = handshakeRefusals.filter(r => !r.refused || r.canary);
    const verdict = verdictFor(cells, { total: calls, harness_errors: harnessErrors });
    if (handshakeAccepted.length) { verdict.pass = false; verdict.failures.push(`${handshakeAccepted.length} handshake requests (initialize, tools/list) accepted or carrying a canary`); }
    if (!expiringValidBefore) { verdict.pass = false; verdict.failures.push('the expiring token never worked before expiry, so its refusal proves nothing'); }

    const optional = Object.entries(OPTIONAL_OPS).map(([op, surface]) => {
      const cs = cells.filter(c => c.op === op);
      const leaky = cs.some(c => c.status === 'Failed');
      const probing = cs.filter(c => PROBING.includes(c.principal));
      return { op, surface, status: leaky ? 'Failed' : probing.length && probing.every(c => c.covered) ? 'Complete' : 'Not covered',
        reason: leaky ? 'leak' : probing.every(c => c.covered) ? undefined : (probing.find(c => !c.covered)?.reason ?? 'not run') + '; N6 seeds no protected content for this surface' };
    });

    const imageDigest = (() => { try { return Bun.spawnSync(['docker', 'inspect', '--format', '{{index .RepoDigests 0}}', 'pgvector/pgvector:pg16']).stdout.toString().trim(); } catch { return ''; } })();
    const receipt: Receipt = {
      ...noModelSpend('no model and no paid request: provider keys removed from every process'),
      schema_version: RECEIPT_SCHEMA_VERSION,
      benchmark_version: BENCHMARK_VERSION,
      category: CATEGORY,
      run_status: 'completed',
      verdict: verdict.pass ? 'pass' : 'fail',
      n_total: calls,
      n_scored: calls - harnessErrors,
      completion_rate: calls ? (calls - harnessErrors) / calls : 0,
      errors: [],
      publishable: true,
      gbrain_version: gut.version,
      gbrain_pin: gbrainPin(),
      execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
      resolved_config: {
        engine: 'postgres', postgres_version: pgVersion, postgres_image: imageDigest || 'pgvector/pgvector:pg16', bind: '127.0.0.1',
        transport: `gbrain serve --http --bind 127.0.0.1 (separate process), GBRAIN_POOL_SIZE=8, rate limits raised (GBRAIN_HTTP_RATE_LIMIT_IP and _TOKEN = 100000000) so the probe load is not throttled`,
        decide: DECIDE_OFF, seed: N6_DEFAULT_SEED, generator_version: N6_GENERATOR_VERSION, concurrency: opts.concurrency, only: opts.only ?? null,
        principals: {
          none: 'no Authorization header', 'invalid-token': 'a well-formed bearer token the server never issued', 'expired-token': `client_credentials token from a client with --token-ttl 60, used after expires_in (${expiring.expires_in}s) plus 5 s`,
          scoped: 'OAuth client_credentials, scope read, source alpha', owner: 'OAuth client_credentials, scopes read write admin, source alpha, federated read alpha,beta',
        },
        trusted_control: 'dispatchToolCall in process (remote: false, source alpha) on the same Postgres database, run before the probe phases',
        phases: ['warm-owner', 'interleaved', 'scoped-again'], operator, mcp_session_modes: [...sessionModes],
        gbrain_overlay: overlaySummary(gut),
      },
      hashes: { ledger_sha256: ledgerFingerprint(ledger) },
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      data: {
        verdict,
        metrics: {
          ops: opNames.length, mandatory_ops: MANDATORY_OPS.length, calls, harness_errors: harnessErrors,
          probes: rows.length, probes_exposed: rows.filter(r => r.status !== 'not_exposed').length, probes_with_signal: rows.filter(r => r.control).length,
          leaks: rows.filter(r => r.status === 'leak').length, oracles: rows.filter(r => r.status === 'oracle').length,
          refused_calls: refusals.filter(r => r.refused).length, refusal_calls: refusals.length,
          pool: { samples: samples.length, max_server_connections: maxConnections, max_active: maxActive, condition_met: poolConditionMet },
          phase_ms: phaseTimes,
        },
        controls: { owner_reads_beta_only_page: ownerBetaSeen, expiring_token_valid_before_expiry: expiringValidBefore, presence: pres.checks },
        cells,
        optional_cells: optional,
        missing_ops: missingOps,
        unsupported_ops: unsupported,
        handshake: handshakeRefusals,
        refusals: refusals.filter(r => !r.refused || r.canary).slice(0, 200),
        refusal_status_codes: Object.fromEntries([...new Set(refusals.map(r => r.http_status))].map(s => [String(s), refusals.filter(r => r.http_status === s).length])),
        findings: Object.entries(firstFinding).slice(0, 200).map(([k, v]) => ({ probe: k, evidence: v })),
        harness_error_samples: rows.filter(r => r.status === 'harness_error').slice(0, 10).map(r => `${r.principal}:${r.op}:${r.target}:${r.variant}: ${r.error}`),
        no_signal_by_cell: Object.fromEntries(cells.filter(c => !c.covered && c.reason).map(c => [`${c.principal}:${c.op}`, c.reason])),
        server_log_tail: serverLog.slice(-40),
      },
    };
    const file = join(opts.outputDir, 'receipt.json');
    writeReceipt(file, (opts.attestation ? { ...receipt, preregistration_attestation: opts.attestation } : receipt) as Receipt);
    log(`[n6pg] verdict ${verdict.pass ? 'pass' : 'fail'}: mandatory ${verdict.mandatory_covered}/${verdict.mandatory_cells} covered, leaks ${verdict.leaks}, oracles ${verdict.oracles}, accepted ${verdict.accepted}; pool max ${maxConnections} connections; receipt ${file}`);
    for (const f of verdict.failures) log(`[n6pg]   ${f}`);
    return { receipt, file, verdict };
  } finally {
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await Bun.sleep(500); if (server.exitCode === null) server.kill('SIGKILL'); }
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); } catch { /* keep going */ }
    await admin.close();
    rmSync(work, { recursive: true, force: true });
  }
}

/** Keyless re-score: recompute the verdict from the receipt's stored cells and call counts. */
export function rescore(receipt: { data?: { cells?: CellSummary[]; metrics?: { calls?: number; harness_errors?: number }; handshake?: RefusalRow[]; controls?: { expiring_token_valid_before_expiry?: boolean } } }): Verdict {
  const d = receipt.data ?? {};
  const v = verdictFor(d.cells ?? [], { total: d.metrics?.calls ?? 0, harness_errors: d.metrics?.harness_errors ?? 0 });
  const hs = (d.handshake ?? []).filter(r => !r.refused || r.canary);
  if (hs.length) { v.pass = false; v.failures.push(`${hs.length} handshake requests (initialize, tools/list) accepted or carrying a canary`); }
  if (d.controls?.expiring_token_valid_before_expiry === false) { v.pass = false; v.failures.push('the expiring token never worked before expiry, so its refusal proves nothing'); }
  return v;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] === 'rescore') {
    const v = rescore(JSON.parse(readFileSync(argv[1], 'utf8')));
    console.log(`n6-postgres-http: ${v.pass ? 'pass' : 'fail'}; mandatory cells ${v.mandatory_covered}/${v.mandatory_cells} covered; leaks ${v.leaks}; oracles ${v.oracles}; accepted ${v.accepted}${v.failures.length ? `; ${v.failures.join('; ')}` : ''}`);
    process.exit(v.pass ? 0 : 1);
  }
  const attest = flag('--attest');
  const only = flag('--only');
  const outputDir = flag('--output') ?? join('eval/reports', CATEGORY, randomUUID().slice(0, 8));
  runPgHttp({
    pgAdminUrl: flag('--pg-url') ?? process.env.LIFECYCLE_PG_URL ?? 'postgres://postgres@127.0.0.1:55442/postgres',
    outputDir, concurrency: Number(flag('--concurrency') ?? 8), only: only ? only.split(',') : undefined,
    gbrainSpec: gbrainSpecFrom(argv), attestation: attest ? attestPreregistration(attest) : null, log: s => console.log(s),
  }).then(r => process.exit(r.verdict.pass ? 0 : 1)).catch(e => { console.error(e); process.exit(3); });
}
