/**
 * N6: visibility and access leak fuzz.
 *
 * Question: can an agent-facing caller read anything the brain marks as not
 * theirs? The runner enumerates gbrain's `operations` list at run time, so a
 * new read op is fuzzed the day it lands, and calls every read op as seven
 * callers (a trusted local CLI and six remote ones scoped to source `alpha`)
 * against a seeded brain holding protected content next to public twins:
 * `visibility: private` pages (body, tag and timeline markers), held Takes
 * rows, private Facts rows, derived atoms (private by default) and pages in
 * an ungranted source `beta`.
 *
 * Gold comes from the generator ledger (eval/generators/n6-visibility-gen.ts)
 * and from the visibility rules gbrain documents
 * (src/core/search/private-visibility.ts, resolveRequestedScope, the takes
 * holder allow-list): every remote caller here is scoped to `alpha` with the
 * default `['world']` holder list, so every protected marker is forbidden to
 * it. Nothing about what is protected is learned from gbrain output.
 *
 * Each targeted probe runs three times with the same op, caller and variant:
 *   protected  aimed at the protected target; scanned for forbidden markers
 *              (content leak) and forbidden slugs or `beta` rows in result
 *              fields it did not ask for (existence leak);
 *   ghost      aimed at values that were never written; if the protected and
 *              ghost responses differ after the target values are masked,
 *              the op is an existence oracle;
 *   twin       aimed at the public twin; must show the twin (presence
 *              control). A probe without a control is "no signal", never
 *              "no leak".
 * Listing probes (ops with nothing to aim) scan everything they return and
 * use any public twin as their control.
 *
 * Callers:
 *   local            dispatchToolCall, remote=false (positive controls only);
 *   stdio            dispatchToolCall as the stdio server calls it;
 *   http-read/-write serve-http's tools/call path replayed in process: the
 *                    operationScopesAllowed gate, then dispatchToolCall with
 *                    the OAuth client's auth, source grant and holder list;
 *   http-bound       an http-write client with a slug-prefix binding;
 *   subagent-remote  buildBrainTools for a remote-owned subagent job;
 *   subagent-local   buildBrainTools for a local subagent job.
 * The network layer and OAuth token verification are not exercised.
 *
 * Access gates: an http-read client calling a write/admin op, and any http
 * client calling a localOnly op, must be refused before the handler. Gates
 * are only probed on ops with a required parameter and with empty params,
 * so a broken gate surfaces as `invalid_params` instead of running a write.
 *
 * Evidence expansion: any read op param named `return_unit` is fuzzed over
 * every enum value like any other enum, and an `assemble_evidence` op (the
 * frozen-candidate entry point on gbrain branch capy/evidence-delivery) gets
 * hit lists naming the protected targets. The receipt reports these paths
 * separately.
 *
 * Hermetic: PGLite in memory, provider keys removed from the environment,
 * GBRAIN_HOME pointed at a temp dir. `--gbrain <checkout>[@ref]` runs a
 * copied overlay (eval/runner/gbrain-under-test.ts).
 *
 * Named window (2026-10-06): an op parameter named `window` gets a one-turn
 * window naming the target page by its capitalized title, so
 * volunteer_context resolves the page for the trusted caller and its probes
 * carry signal (docs/benchmarks/2026-10-06-n8-privacy-gate-preregistration.md).
 *
 * Usage: bun eval/runner/n6-visibility-fuzz.ts [--seed N] [--gbrain <path>[@ref]] [--output <dir>] [--only op1,op2] [--attest <preregistration.md>] [--json]
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Operation, OperationContext, AuthInfo, ParamDef } from 'gbrain/operations';
import { generateN6World, ledgerFingerprint, personIntro, N6_DEFAULT_SEED, N6_GENERATOR_VERSION, type N6ClassSpec, type N6Ledger, type N6Target } from '../generators/n6-visibility-gen.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { attestPreregistration, type Attestation } from './prereg.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';

export const N6_CATEGORY = 'n6-visibility-fuzz';
const CALL_TIMEOUT_MS = 10_000;
const MAX_TIMEOUTS_PER_OP = 2;

export type CallerId = 'local' | 'stdio' | 'http-read' | 'http-write' | 'http-bound' | 'subagent-remote' | 'subagent-local';
export const REMOTE_CALLERS: readonly CallerId[] = ['stdio', 'http-read', 'http-write', 'http-bound', 'subagent-remote', 'subagent-local'];

export interface CallOutcome {
  /** False when the caller cannot reach the op at all (not listed, not in the subagent registry, scope gate). */
  exposed: boolean;
  ok: boolean;
  error_code?: string;
  raw: string;
  data: unknown;
  timed_out?: boolean;
}

// ─── Parameter synthesis ───────────────────────────────────────────────

const SLUG_PARAMS = new Set(['slug', 'page_slug', 'entity_slug', 'since_slug']);
const QUERY_PARAMS = new Set(['query', 'question', 'topic', 'grep', 'prior_context', 'window', 'symbol', 'entry_point']);
const ENTITY_PARAMS = new Set(['entity', 'entities', 'name']);
const WIDENING_BOOLEANS = new Set(['include_private', 'include_deleted', 'include_expired', 'include_pending', 'include_quarantined', 'include_archived', 'all_sources', 'include_context', 'supersessions']);
const TARGET_PARAMS = new Set([...SLUG_PARAMS, ...QUERY_PARAMS, ...ENTITY_PARAMS, 'partial', 'id', 'holder', 'hits', 'date', 'tag', 'slugPrefix']);

export type ScopeVariant = 'ambient' | 'foreign' | 'all';

export interface Synthesized { params: Record<string, unknown>; unsupported?: undefined }
export interface Unsupported { params?: undefined; unsupported: string }

/**
 * A one-turn conversation window that names a page by its title, each word capitalized so gbrain's entity
 * extractor sees a name (lower-case titles and slugs resolve nothing). Preregistered 2026-10-06
 * (docs/benchmarks/2026-10-06-n8-privacy-gate-preregistration.md).
 */
export function namingWindow(title: string): string {
  return `user: I was just reading ${title.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ')} again.`;
}

/** Title of the ledger page a target names; for a never-written ghost, the protected title with its query word swapped. */
export function targetTitle(ledger: Pick<N6Ledger, 'pages'>, target: N6Target, protectedTwin?: N6Target): string | undefined {
  const page = ledger.pages.find(p => p.slug === target.slug && p.source_id === (target.source_id ?? 'alpha'));
  const title = page ? /^title:\s*(.+)$/m.exec(page.content)?.[1]?.trim() : undefined;
  if (title || !protectedTwin) return title;
  const base = targetTitle(ledger, protectedTwin);
  return base?.includes(protectedTwin.query) ? base.split(protectedTwin.query).join(target.query) : base;
}

/** Build arguments for one op aimed at one target. Returns why not when a required param has no rule. */
export function synthesizeParams(
  params: Record<string, ParamDef>,
  target: N6Target | null,
  opts: { scope?: ScopeVariant; enumOverride?: [string, string]; title?: string } = {},
): Synthesized | Unsupported {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(params)) {
    let value: unknown;
    if (target) {
      if (name === 'window' && opts.title) value = namingWindow(opts.title);
      else if (SLUG_PARAMS.has(name)) value = target.slug;
      else if (QUERY_PARAMS.has(name)) value = target.query;
      else if (ENTITY_PARAMS.has(name)) value = target.slug;
      else if (name === 'partial') value = target.slug;
      else if (name === 'id' && def.type === 'string') value = target.slug;
      else if (name === 'holder') value = target.holder;
      else if (name === 'tag') value = target.tag;
      else if (name === 'date') value = target.date ?? '2024-03-01';
      else if (name === 'slugPrefix') value = target.slug.split('/')[0] + '/';
      else if (name === 'hits' && def.type === 'array') value = [{ source_id: target.source_id ?? 'alpha', slug: target.slug, chunk_id: 0 }];
    }
    if (value === undefined) {
      if (name === 'source_id' && target?.source_id) value = target.source_id;
      else if (['since', 'after', 'updated_after'].includes(name) && def.type === 'string') value = '2000-01-01';
      else if (['until', 'before', 'asof'].includes(name) && def.type === 'string') value = '2100-01-01';
      else if (name === 'limit' && def.type === 'number') value = 50;
      else if (def.type === 'boolean' && WIDENING_BOOLEANS.has(name)) value = true;
      else if (name === 'type' && def.required) value = target?.type ?? 'note';
      else if (def.required && def.type === 'number') value = 10;
    }
    if (value === undefined && def.required) return { unsupported: `no synthesis rule for required ${def.type} param "${name}"` };
    if (value !== undefined) out[name] = value;
  }
  if (opts.scope === 'foreign' && 'source_id' in params) out.source_id = 'beta';
  if (opts.scope === 'all' && 'source_id' in params) out.source_id = '__all__';
  if (opts.enumOverride) out[opts.enumOverride[0]] = opts.enumOverride[1];
  return { params: out };
}

export function isTargeted(params: Record<string, ParamDef>): boolean {
  return Object.keys(params).some(p => TARGET_PARAMS.has(p));
}

/** Variants for one op: the base call, one per enum value, one per scope override. */
export function variantsFor(params: Record<string, ParamDef>): Array<{ id: string; scope: ScopeVariant; enumOverride?: [string, string] }> {
  const out: Array<{ id: string; scope: ScopeVariant; enumOverride?: [string, string] }> = [{ id: 'base', scope: 'ambient' }];
  for (const [name, def] of Object.entries(params)) {
    if (!def.enum) continue;
    for (const value of def.enum.slice(0, 8)) out.push({ id: `${name}=${value}`, scope: 'ambient', enumOverride: [name, value] });
  }
  if ('source_id' in params) {
    out.push({ id: 'source_id=beta', scope: 'foreign' });
    out.push({ id: 'source_id=__all__', scope: 'all' });
  }
  return out;
}

// ─── Scoring helpers ───────────────────────────────────────────────────

const SLUG_FIELDS = new Set(['slug', 'to_slug', 'from_slug', 'entity_slug', 'page_slug', 'target_slug', 'source_slug', 'resolved_slug', 'candidates', 'slugs']);
const VOLATILE_KEY = /^(id|page_id|chunk_id|fact_id|take_id|revision|knowledge_revision|request_id|job_id|session_id|score|rank_score|.*_at|.*_ms|took.*|elapsed.*|latency.*|duration.*|generated.*|now|timestamp)$/i;

/** Slugs named in slug-like result fields (strings or string arrays), at any depth. */
export function namedSlugs(data: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(data)) { for (const x of data) typeof x === 'string' ? out.add(x) : namedSlugs(x, out); return out; }
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (SLUG_FIELDS.has(k) && typeof v === 'string') out.add(v);
      else if (SLUG_FIELDS.has(k) && Array.isArray(v) && v.every(x => typeof x === 'string')) for (const s of v as string[]) out.add(s);
      else namedSlugs(v, out);
    }
  }
  return out;
}

/** True when any object in the response carries source_id equal to `source`. */
export function hasSourceRow(data: unknown, source: string): boolean {
  if (Array.isArray(data)) return data.some(x => hasSourceRow(x, source));
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if ((k === 'source_id' || k === 'source') && v === source) return true;
      if (hasSourceRow(v, source)) return true;
    }
  }
  return false;
}

/** Mask target values and drop volatile keys so a protected response can be compared with its ghost. */
export function normalizeForOracle(data: unknown, mask: readonly string[]): string {
  const needles = [...new Set(mask.filter(m => m && m.length >= 4))].sort((a, b) => b.length - a.length);
  const visit = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let s = v;
      for (const n of needles) s = s.split(n).join('<T>');
      return s;
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        if (VOLATILE_KEY.test(k)) continue;
        o[k] = visit((v as Record<string, unknown>)[k]);
      }
      return o;
    }
    return v;
  };
  return JSON.stringify(visit(data));
}

export function targetValues(t: N6Target): string[] {
  return [t.slug, t.query, t.holder ?? '', t.tag ?? '', t.date ?? '', t.slug.split('/').pop() ?? ''];
}

interface ProbeUnit { id: string; protected: N6Target | null; cls?: N6ClassSpec }

export interface ProbeFinding {
  probe_id: string;
  caller: CallerId;
  op: string;
  target: string;
  variant: string;
  params: Record<string, unknown>;
  kind: 'content' | 'existence' | 'oracle';
  evidence: string;
}

export interface ProbeRow {
  probe_id: string;
  caller: CallerId;
  op: string;
  target: string;
  variant: string;
  status: 'leak' | 'oracle' | 'clean' | 'no_signal' | 'not_exposed' | 'harness_error';
  /** local_replay_detected and (twin_seen, or a source override that has no twin). */
  control: boolean;
  /** The trusted local caller, given the same arguments, reads a protected marker: the probe aims at real protected content. */
  local_replay_detected?: boolean;
  /** This caller sees the public twin through the op. */
  twin_seen?: boolean;
  /** Expansion probes only: the return_unit requested (`default` for assemble_evidence without one). */
  expansion_unit?: string;
  /** A response carried a `delivered` block whose unit is window, section or page: the stage actually expanded. */
  expansion_applied?: boolean;
  /** Fence classes: the twin response carried the person page's intro and its public Facts row, so the delivered text spans the fences the protected rows were stripped from. */
  fence_neighbor_reached?: boolean;
  protected_error?: string;
  twin_error?: string;
}

/**
 * Forbidden markers and slugs in a response. `permitted` credits echoes: a marker the probe itself sent may
 * appear as often as the ghost probe's counterpart value appears in the ghost response (the op echoing its
 * input), and no more.
 */
export function scanLeaks(outcome: CallOutcome, forbiddenMarkers: readonly string[], forbiddenSlugs: readonly string[], askedFor: readonly string[], permitted: ReadonlyMap<string, number> = new Map()): { content: string | null; existence: string | null } {
  if (!outcome.exposed) return { content: null, existence: null };
  const marker = forbiddenMarkers.find(m => countOccurrences(outcome.raw, m) > (permitted.get(m) ?? 0)) ?? null;
  let existence: string | null = null;
  if (outcome.ok) {
    const named = namedSlugs(outcome.data);
    const slug = forbiddenSlugs.find(s => named.has(s) && !askedFor.includes(s));
    if (slug) existence = `slug field names ${slug}`;
    else if (hasSourceRow(outcome.data, 'beta')) existence = 'a result row carries source_id beta';
  }
  return { content: marker ? `marker ${marker}: ${excerpt(outcome.raw, marker)}` : null, existence };
}

export function controlSeen(outcome: CallOutcome, markers: readonly string[], slugs: readonly string[]): boolean {
  if (!outcome.exposed || !outcome.ok) return false;
  const lower = outcome.raw.toLowerCase();
  if (markers.some(m => lower.includes(m.toLowerCase()))) return true;
  const named = namedSlugs(outcome.data);
  return slugs.some(s => named.has(s));
}

export function countOccurrences(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  for (let at = h.indexOf(n); n && at >= 0; at = h.indexOf(n, at + n.length)) count++;
  return count;
}

/** Echo credit for each forbidden marker the protected arguments carry, measured on the ghost call. */
export function echoCredit(protParams: Record<string, unknown>, ghostParams: Record<string, unknown> | undefined, ghostRaw: string | undefined, markers: readonly string[]): Map<string, number> {
  const credit = new Map<string, number>();
  if (!ghostParams || ghostRaw === undefined) return credit;
  for (const [key, value] of Object.entries(protParams)) {
    const counterpart = ghostParams[key];
    if (typeof value !== 'string' || typeof counterpart !== 'string' || !markers.includes(value)) continue;
    credit.set(value, (credit.get(value) ?? 0) + countOccurrences(ghostRaw, counterpart));
  }
  return credit;
}

function excerpt(raw: string, needle: string): string {
  const i = raw.toLowerCase().indexOf(needle.toLowerCase());
  return i < 0 ? raw.slice(0, 240) : raw.slice(Math.max(0, i - 120), i + 120);
}

// ─── gbrain wiring ─────────────────────────────────────────────────────

interface Gbrain {
  operations: Operation[];
  PGLiteEngine: new () => { connect(c: unknown): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void>; executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> };
  dispatchToolCall: (engine: unknown, name: string, params: Record<string, unknown> | undefined, opts: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  operationScopesAllowed: (scopes: readonly string[], op: Operation) => boolean;
  buildBrainTools: (opts: Record<string, unknown>) => Array<{ name: string; execute(input: unknown, ctx: unknown): Promise<unknown> }>;
}

async function loadGbrain(gut: GbrainUnderTest): Promise<Gbrain> {
  const [ops, pglite, dispatch, scope, tools] = await Promise.all([
    importGbrain<{ operations: Operation[] }>(gut, 'src/core/operations.ts'),
    importGbrain<{ PGLiteEngine: Gbrain['PGLiteEngine'] }>(gut, 'src/core/pglite-engine.ts'),
    importGbrain<{ dispatchToolCall: Gbrain['dispatchToolCall'] }>(gut, 'src/mcp/dispatch.ts'),
    importGbrain<{ operationScopesAllowed: Gbrain['operationScopesAllowed'] }>(gut, 'src/core/scope.ts'),
    importGbrain<{ buildBrainTools: Gbrain['buildBrainTools'] }>(gut, 'src/core/minions/tools/brain-allowlist.ts'),
  ]);
  return { operations: ops.operations, PGLiteEngine: pglite.PGLiteEngine, dispatchToolCall: dispatch.dispatchToolCall, operationScopesAllowed: scope.operationScopesAllowed, buildBrainTools: tools.buildBrainTools };
}

const CONFIG = { engine: 'pglite', database_path: ':memory:' } as OperationContext['config'];
const QUIET = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function parseToolResult(result: { content: { text: string }[]; isError?: boolean }): CallOutcome {
  const raw = result.content.map(c => c.text).join('\n');
  let data: unknown = raw;
  try { data = JSON.parse(raw); } catch { /* plain text */ }
  const code = data && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, unknown>).error === 'string'
    ? String((data as Record<string, unknown>).error) : undefined;
  return { exposed: true, ok: !result.isError, raw, data, ...(result.isError ? { error_code: code ?? 'error' } : {}) };
}

const DENIAL_CODES = new Set(['insufficient_scope', 'permission_denied', 'unknown_tool', 'unknown_operation', 'scope_denied', 'not_exposed']);
const isDenial = (o: CallOutcome) => !o.exposed || DENIAL_CODES.has(o.error_code ?? '') || /unknown tool|not (available|found) in this surface/i.test(o.raw);

type Caller = (op: Operation, params: Record<string, unknown>) => Promise<CallOutcome>;

function authFor(clientId: string, scopes: string[], extra: Partial<AuthInfo> = {}): AuthInfo {
  return { token: `n6-${clientId}`, clientId, principal: { kind: 'oauth_client', id: clientId }, scopes, sourceId: 'alpha', allowedSources: ['alpha'], hasSourceGrant: true, ...extra };
}

function makeCallers(g: Gbrain, engine: unknown): Record<CallerId, Caller> {
  // Each probe call gets its own session id. gbrain v0.60.46.0 dedupes agent notices per (transport, principal,
  // session); with no session id every call of a caller shares one ledger, so the first of two otherwise identical
  // calls carried a notice the second lacked and the protected-before-ghost order read as an existence oracle.
  const viaDispatch = (opts: Record<string, unknown>): Caller => async (op, params) =>
    parseToolResult(await g.dispatchToolCall(engine, op.name, params, { config: CONFIG, logger: QUIET, sessionId: `n6-${randomUUID()}`, ...opts }));
  const viaServeHttp = (auth: AuthInfo): Caller => async (op, params) => {
    if (!g.operationScopesAllowed(auth.scopes, op)) return { exposed: false, ok: false, error_code: 'insufficient_scope', raw: '', data: null };
    return viaDispatch({ remote: true, transport: 'http', takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'], sourceId: auth.sourceId ?? 'default', auth })(op, params);
  };
  const viaSubagent = (delegated: boolean): Caller => {
    const registry = g.buildBrainTools({
      engine, config: CONFIG, subagentId: 6, jobId: 6, sourceId: 'alpha',
      ...(delegated ? { delegatedAuth: { clientId: 'n6-subagent', scopes: ['read'], sourceId: 'alpha', allowedSources: ['alpha'] } } : {}),
    });
    const byOp = new Map(registry.map(t => [t.name.replace(/^brain_/, ''), t]));
    return async (op, params) => {
      const tool = byOp.get(op.name);
      if (!tool) return { exposed: false, ok: false, error_code: 'not_exposed', raw: '', data: null };
      try {
        const out = await tool.execute(params, { engine, jobId: 6, remote: true });
        const raw = JSON.stringify(out) ?? 'null';
        return { exposed: true, ok: true, raw, data: out };
      } catch (err) {
        const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        return { exposed: true, ok: false, error_code: (err as { code?: string }).code ?? 'error', raw, data: null };
      }
    };
  };
  return {
    local: viaDispatch({ remote: false, sourceId: 'alpha' }),
    stdio: viaDispatch({ remote: true, transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'alpha' }),
    'http-read': viaServeHttp(authFor('n6-read', ['read'])),
    'http-write': viaServeHttp(authFor('n6-write', ['read', 'write'])),
    'http-bound': viaServeHttp(authFor('n6-bound', ['read', 'write'], { boundSlugPrefixes: ['notes/'], boundSourceId: 'alpha' })),
    'subagent-remote': viaSubagent(true),
    'subagent-local': viaSubagent(false),
  };
}

async function withTimeout(p: Promise<CallOutcome>): Promise<CallOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CallOutcome>(resolve => {
    timer = setTimeout(() => resolve({ exposed: true, ok: false, error_code: 'harness_timeout', raw: '', data: null, timed_out: true }), CALL_TIMEOUT_MS);
  });
  try { return await Promise.race([p.catch(err => ({ exposed: true, ok: false, error_code: 'thrown', raw: String(err instanceof Error ? err.stack ?? err.message : err), data: null })), timeout]); }
  finally { clearTimeout(timer); }
}

// ─── Seeding and presence ──────────────────────────────────────────────

async function seed(g: Gbrain, engine: Awaited<ReturnType<typeof newEngine>>, ledger: N6Ledger): Promise<string[]> {
  const errors: string[] = [];
  for (const s of ledger.sources) {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`, [s]);
  }
  const putPage = g.operations.find(o => o.name === 'put_page')!;
  const local = makeCallers(g, engine).local;
  // Hub first so links resolve; then everything else in ledger order.
  const ordered = [...ledger.pages.filter(p => p.slug === ledger.hub_slug), ...ledger.pages.filter(p => p.slug !== ledger.hub_slug)];
  // Two writes per page, so version history exists for get_versions to expose (or not).
  const revised = (content: string) => content.replace(/^(---\n[\s\S]*?\n---\n)/, '$1Revised once.\n');
  const revisions = new Map<string, string>();
  for (const write of [(c: string) => c, revised]) {
    for (const page of ordered) {
      const key = `${page.source_id}/${page.slug}`;
      const args = { slug: page.slug, content: write(page.content), ...(revisions.has(key) ? { expected_revision: revisions.get(key) } : {}) };
      const r = page.source_id === 'alpha'
        ? await local(putPage, args)
        : parseToolResult(await g.dispatchToolCall(engine, 'put_page', args, { config: CONFIG, logger: QUIET, remote: false, sourceId: page.source_id }));
      if (!r.ok) errors.push(`put_page ${key}: ${r.raw.slice(0, 200)}`);
      const revision = (r.data as { revision?: unknown } | null)?.revision;
      if (typeof revision === 'string') revisions.set(key, revision);
    }
  }
  // Surfaces outside page bodies (generator v2), written by the trusted local caller.
  const byName = (name: string) => g.operations.find(o => o.name === name)!;
  for (const o of ledger.side_writes.ontology) {
    const r = await local(byName('ontology_propose'), { entity: o.entity, dimension: o.dimension, value: o.value, visibility: o.visibility, valid_from: o.valid_from, confidence: 0.9, source: 'n6-fixture' });
    if (!r.ok) errors.push(`ontology_propose ${o.entity} ${o.dimension}: ${r.raw.slice(0, 200)}`);
  }
  for (const d of ledger.side_writes.raw_data) {
    const r = await local(byName('put_raw_data'), { slug: d.slug, source: d.source, data: d.data });
    if (!r.ok) errors.push(`put_raw_data ${d.slug}: ${r.raw.slice(0, 200)}`);
  }
  return errors;
}

/** The trusted local read that must show a class's protected markers (the positive control). Page-borne classes use get_page. */
const CONTROL_READ: Partial<Record<N6ClassSpec['class'], (t: N6Target) => [string, Record<string, unknown>]>> = {
  private_ontology: t => ['ontology_get', { entity: t.slug }],
  private_raw_data: t => ['get_raw_data', { slug: t.slug }],
};

async function newEngine(g: Gbrain) {
  const engine = new g.PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}

export interface PresenceResult { name: string; pass: boolean; detail: string }

async function presence(engine: Awaited<ReturnType<typeof newEngine>>, ledger: N6Ledger, local: Caller, getPage: Operation, opByName: (name: string) => Operation): Promise<{ checks: PresenceResult[]; sealed_chunk_violations: string[] }> {
  const checks: PresenceResult[] = [];
  const count = async (sql: string, params: unknown[]) => Number((await engine.executeRaw<{ n: number }>(sql, params))[0]?.n ?? 0);
  let found = 0;
  for (const p of ledger.pages) found += await count('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [p.source_id, p.slug]);
  checks.push({ name: 'every ledger page stored in its source', pass: found === ledger.pages.length, detail: `${found}/${ledger.pages.length}` });
  const take = ledger.classes.find(c => c.class === 'private_take')!;
  const fact = ledger.classes.find(c => c.class === 'private_fact')!;
  const page = ledger.classes.find(c => c.class === 'private_page')!;
  const takes = await count(`SELECT count(*)::int AS n FROM takes WHERE holder=$1 AND claim LIKE '%' || $2 || '%'`, [take.protected.holder, take.protected.query]);
  checks.push({ name: 'held take row indexed', pass: takes === 1, detail: `${takes} row(s)` });
  const facts = await count(`SELECT count(*)::int AS n FROM facts WHERE visibility='private' AND fact LIKE '%' || $1 || '%'`, [fact.protected.query]);
  checks.push({ name: 'private fact row indexed', pass: facts === 1, detail: `${facts} row(s)` });
  const tl = await count(`SELECT count(*)::int AS n FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1`, [page.protected.slug]);
  checks.push({ name: 'private page timeline indexed', pass: tl >= 1, detail: `${tl} entr(ies)` });
  const links = await count(`SELECT count(*)::int AS n FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug=$1 AND t.slug=$2`, [page.protected.slug, ledger.hub_slug]);
  checks.push({ name: 'private page links to the public hub', pass: links >= 1, detail: `${links} link(s)` });
  // Positive controls: the trusted local caller can read every protected marker, so a remote miss means filtering, not absence.
  for (const c of ledger.classes) {
    const [opName, params] = CONTROL_READ[c.class]?.(c.protected) ?? ['get_page', { slug: c.protected.slug, ...(c.protected.source_id ? { source_id: c.protected.source_id } : {}) }];
    const r = await local(opName === 'get_page' ? getPage : opByName(opName), params);
    const seen = c.protected_markers.filter(m => r.raw.includes(m));
    checks.push({ name: `local ${opName} reads ${c.class} markers`, pass: seen.length > 0, detail: `${seen.length}/${c.protected_markers.length} markers${r.ok ? '' : `; ${r.raw.slice(0, 160)}`}` });
  }
  const sealed: string[] = [];
  for (const m of [take.protected.query, fact.protected.query]) {
    const n = await count(`SELECT count(*)::int AS n FROM content_chunks WHERE chunk_text LIKE '%' || $1 || '%'`, [m]);
    if (n) sealed.push(`${n} content_chunks row(s) contain protected fence marker ${m}`);
  }
  return { checks, sealed_chunk_violations: sealed };
}

const EXPANDED_UNITS = new Set(['window', 'section', 'page']);
const FENCE_CLASSES = new Set(['private_take', 'private_fact']);

/** Every `delivered.unit` in a response (the evidence-delivery stage's per-result block). */
export function deliveredUnits(data: unknown, out: string[] = []): string[] {
  if (Array.isArray(data)) { for (const x of data) deliveredUnits(x, out); return out; }
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (k === 'delivered' && v && typeof v === 'object' && typeof (v as { unit?: unknown }).unit === 'string') out.push((v as { unit: string }).unit);
      else deliveredUnits(v, out);
    }
  }
  return out;
}

/** Why an op produced no signal-bearing probe, from its rows. */
export function uncoveredReason(s: OpSummary, rows: readonly ProbeRow[]): string {
  if (s.unsupported) return s.unsupported;
  const exposed = rows.filter(r => r.status !== 'not_exposed');
  if (!exposed.length) return 'not exposed to any remote caller';
  if (!exposed.some(r => r.local_replay_detected)) {
    const err = exposed.find(r => r.protected_error)?.protected_error;
    return `returns no protected content even to the trusted local caller for any synthesized target${err ? ` (e.g. ${err.slice(0, 120)})` : ''}`;
  }
  const err = exposed.find(r => r.twin_error)?.twin_error;
  return `remote callers never saw the public twin${err ? ` (e.g. ${err.slice(0, 120)})` : ''}`;
}

// ─── Main run ──────────────────────────────────────────────────────────

export interface N6Options { seed?: number; gbrainSpec?: string | null; only?: string[]; reportsDir?: string; outputDir?: string; quiet?: boolean; attestation?: Attestation | null }

export interface OpSummary {
  op: string;
  kind: 'targeted' | 'listing';
  probes: number;
  signal: number;
  leaks: number;
  oracles: number;
  exposed_to: CallerId[];
  unsupported?: string;
  expansion: boolean;
}

/** Hermetic environment for the run (eval/runner/hermetic-env.ts), restored afterwards. */
export async function runN6(options: N6Options = {}) {
  return withHermeticEnv('n6', () => runN6Hermetic(options));
}

async function runN6Hermetic(options: N6Options) {
  const log = options.quiet ? () => {} : (s: string) => console.log(s);
  const startedAt = new Date().toISOString();
  const seedValue = options.seed ?? N6_DEFAULT_SEED;
  const ledger = generateN6World(seedValue);
  const gut = resolveGbrainUnderTest(options.gbrainSpec ?? null);
  const g = await loadGbrain(gut);
  const engine = await newEngine(g);
  const callers = makeCallers(g, engine);
  const getPage = g.operations.find(o => o.name === 'get_page')!;

  const seedErrors = await seed(g, engine, ledger);
  const pres = await presence(engine, ledger, callers.local, getPage, name => g.operations.find(o => o.name === name)!);
  const presenceOk = seedErrors.length === 0 && pres.checks.every(c => c.pass);

  const forbiddenMarkers = ledger.classes.flatMap(c => c.protected_markers);
  const forbiddenSlugs = ledger.classes.flatMap(c => c.protected_slugs);
  const twinMarkers = ledger.classes.flatMap(c => c.twin_markers);
  const twinSlugs = [...new Set(ledger.classes.map(c => c.twin.slug))];

  const readOps = g.operations.filter(o => (o.scope ?? 'read') === 'read' && !o.localOnly && (!options.only || options.only.includes(o.name)));
  const findings: ProbeFinding[] = [];
  const rows: ProbeRow[] = [];
  const opSummaries: OpSummary[] = [];
  const timeoutsByOp = new Map<string, number>();

  const call = async (caller: CallerId, op: Operation, params: Record<string, unknown>) => {
    if ((timeoutsByOp.get(op.name) ?? 0) >= MAX_TIMEOUTS_PER_OP) return { exposed: true, ok: false, error_code: 'harness_skipped_after_timeouts', raw: '', data: null, timed_out: true } as CallOutcome;
    const r = await withTimeout(callers[caller](op, structuredClone(params)));
    if (r.timed_out) timeoutsByOp.set(op.name, (timeoutsByOp.get(op.name) ?? 0) + 1);
    return r;
  };

  log(`[n6] gbrain ${gut.version}${gut.overlay ? ` (overlay ${gut.overlay.build.commit.slice(0, 12)})` : ' (pinned)'}; ${g.operations.length} operations, ${readOps.length} read ops fuzzed; presence ${presenceOk ? 'ok' : 'FAILED'}`);

  const hubTarget: N6Target = { slug: ledger.hub_slug, query: 'offsite planning', type: 'note', date: ledger.classes[0].twin.date };
  const unitTitles = (unit: ProbeUnit) => unit.cls
    ? { protected: targetTitle(ledger, unit.cls.protected), twin: targetTitle(ledger, unit.cls.twin), ghost: targetTitle(ledger, unit.cls.ghost, unit.cls.protected) }
    : { protected: unit.protected ? targetTitle(ledger, unit.protected) : undefined, twin: undefined, ghost: undefined };
  const localReplay = new Map<string, boolean>();
  let localOraclePairs = 0;
  let localOracleDiffs = 0;
  if (presenceOk) {
    for (const op of readOps) {
      const targeted = isTargeted(op.params);
      const summary: OpSummary = { op: op.name, kind: targeted ? 'targeted' : 'listing', probes: 0, signal: 0, leaks: 0, oracles: 0, exposed_to: [], expansion: 'return_unit' in op.params || op.name === 'assemble_evidence' };
      const variants = variantsFor(op.params);
      const exposed = new Set<CallerId>();
      const unsupported = new Set<string>();
      const units: ProbeUnit[] = targeted
        ? [...ledger.classes.map(cls => ({ id: cls.class, protected: cls.protected, cls })), { id: 'hub', protected: hubTarget }]
        : [{ id: 'listing', protected: null }];
      for (const caller of REMOTE_CALLERS) {
        for (const unit of units) {
          for (const v of variants) {
            const titles = unitTitles(unit);
            const prot = synthesizeParams(op.params, unit.protected, { ...v, title: titles.protected });
            if (!prot.params) { unsupported.add(prot.unsupported); continue; }
            const protParams = prot.params;
            const probe_id = `${caller}:${op.name}:${unit.id}:${v.id}`;
            const base = { probe_id, caller, op: op.name, target: unit.id, variant: v.id };
            const replayKey = `${op.name}:${unit.id}:${v.id}`;
            const gh = unit.cls ? synthesizeParams(op.params, unit.cls.ghost, { ...v, title: titles.ghost }) : null;
            if (!localReplay.has(replayKey)) {
              const lr = await call('local', op, protParams);
              const lg = gh?.params ? await call('local', op, gh.params) : null;
              const hit = scanLeaks(lr, forbiddenMarkers, forbiddenSlugs, [], echoCredit(protParams, gh?.params, lg?.raw, forbiddenMarkers));
              localReplay.set(replayKey, !!(hit.content || hit.existence));
              if (lg && unit.cls) {
                const mask = [...targetValues(unit.cls.protected), ...targetValues(unit.cls.ghost)];
                localOraclePairs++;
                if (normalizeForOracle(lr.ok ? lr.data : { error: lr.error_code }, mask) !== normalizeForOracle(lg.ok ? lg.data : { error: lg.error_code }, mask)) localOracleDiffs++;
              }
            }
            const pr = await call(caller, op, protParams);
            summary.probes++;
            if (!pr.exposed) { rows.push({ ...base, status: 'not_exposed', control: false }); continue; }
            exposed.add(caller);
            if (pr.timed_out) { rows.push({ ...base, status: 'harness_error', control: false, protected_error: pr.error_code }); continue; }
            const gr = gh?.params ? await call(caller, op, gh.params) : null;
            const asked = Object.values(protParams).filter((x): x is string => typeof x === 'string');
            const leak = scanLeaks(pr, forbiddenMarkers, forbiddenSlugs, asked, echoCredit(protParams, gh?.params, gr?.raw, forbiddenMarkers));
            let twinSeen: boolean;
            const expansionUnit = v.enumOverride?.[0] === 'return_unit' ? v.enumOverride[1] : op.name === 'assemble_evidence' ? 'default' : undefined;
            let expansionApplied = expansionUnit ? deliveredUnits(pr.data).some(u => EXPANDED_UNITS.has(u)) : false;
            let fenceNeighbor: boolean | undefined;
            let oracle: string | null = null;
            let twinError: string | undefined;
            if (unit.cls) {
              const cls = unit.cls;
              const tw = synthesizeParams(op.params, cls.twin, { ...v, title: titles.twin });
              const tr = tw.params ? await call(caller, op, tw.params) : null;
              twinSeen = tr ? controlSeen(tr, cls.twin_markers, [cls.twin.slug]) : false;
              if (tr && !tr.ok) twinError = `${tr.error_code}: ${tr.raw.slice(0, 160)}`;
              // The twin and ghost responses are scanned too: a public hit expanded to its page must not carry the private rows beside it.
              for (const [label, out, args] of [['twin', tr, tw.params], ['ghost', gr, gh?.params]] as const) {
                if (!out || !args) continue;
                const extra = scanLeaks(out, forbiddenMarkers, forbiddenSlugs, Object.values(args).filter((x): x is string => typeof x === 'string'));
                if (extra.content) leak.content ??= `${label} call: ${extra.content}`;
                if (extra.existence) leak.existence ??= `${label} call: ${extra.existence}`;
              }
              if (gr && !gr.timed_out && !leak.content && !leak.existence) {
                const mask = [...targetValues(cls.protected), ...targetValues(cls.ghost)];
                const a = normalizeForOracle(pr.ok ? pr.data : { error: pr.error_code }, mask);
                const b = normalizeForOracle(gr.ok ? gr.data : { error: gr.error_code }, mask);
                if (a !== b) oracle = `protected: ${a.slice(0, 300)} | ghost: ${b.slice(0, 300)}`;
              }
              if (expansionUnit && tr) {
                expansionApplied ||= deliveredUnits(tr.data).some(u => EXPANDED_UNITS.has(u));
                // The person page's intro sits above the Takes fence and the public Facts row inside the Facts fence, so a
                // delivered block carrying both spans the rows the protected Take and Fact were stripped from.
                if (FENCE_CLASSES.has(cls.class)) {
                  const factTwin = ledger.classes.find(c => c.class === 'private_fact')!.twin_markers;
                  fenceNeighbor = tr.raw.includes(personIntro(cls.protected.slug)) && factTwin.some(m => tr.raw.includes(m));
                }
              }
            } else {
              twinSeen = controlSeen(pr, twinMarkers, twinSlugs);
            }
            // Signal: the same arguments reach protected content for the trusted local caller, and this
            // caller can use the op at all (it sees a public twin; a source override has no twin to see).
            const control = localReplay.get(replayKey)! && (twinSeen || v.scope !== 'ambient');
            if (leak.content) findings.push({ ...base, params: protParams, kind: 'content', evidence: leak.content });
            if (leak.existence) findings.push({ ...base, params: protParams, kind: 'existence', evidence: leak.existence });
            if (oracle) findings.push({ ...base, params: protParams, kind: 'oracle', evidence: oracle });
            const status: ProbeRow['status'] = leak.content || leak.existence ? 'leak' : oracle ? 'oracle' : control ? 'clean' : 'no_signal';
            if (status === 'leak') summary.leaks++;
            if (status === 'oracle') summary.oracles++;
            if (control) summary.signal++;
            rows.push({ ...base, status, control, local_replay_detected: localReplay.get(replayKey)!, twin_seen: twinSeen, ...(pr.ok ? {} : { protected_error: `${pr.error_code}: ${pr.raw.slice(0, 160)}` }), ...(twinError ? { twin_error: twinError } : {}), ...(expansionUnit ? { expansion_unit: expansionUnit, expansion_applied: expansionApplied, ...(fenceNeighbor !== undefined ? { fence_neighbor_reached: fenceNeighbor } : {}) } : {}) });
          }
        }
      }
      summary.exposed_to = REMOTE_CALLERS.filter(c => exposed.has(c));
      if (unsupported.size && summary.probes === 0) summary.unsupported = [...unsupported].join('; ');
      opSummaries.push(summary);
      log(`[n6] ${op.name.padEnd(28)} probes=${summary.probes} signal=${summary.signal} leaks=${summary.leaks} oracles=${summary.oracles}${summary.unsupported ? ` unsupported: ${summary.unsupported}` : ''}`);
    }
  }

  // Access gates, after every read probe so a broken gate cannot disturb them.
  const gates: Array<{ caller: CallerId; op: string; kind: 'scope' | 'local_only'; outcome: 'denied' | 'bypass' | 'skipped_no_required_param'; detail: string }> = [];
  if (presenceOk && !options.only) {
    const hasRequired = (op: Operation) => Object.values(op.params).some(d => d.required);
    for (const op of g.operations) {
      const writeLike = (op.scope ?? 'read') !== 'read';
      const checks: Array<[CallerId, 'scope' | 'local_only']> = [];
      if (op.localOnly) for (const c of ['http-read', 'http-write', 'http-bound'] as CallerId[]) checks.push([c, 'local_only']);
      else if (writeLike) checks.push(['http-read', 'scope']);
      for (const [caller, kind] of checks) {
        if (!hasRequired(op)) {
          // Without a required param a bypass would run the handler. The scope gate is a pure predicate, so
          // evaluate serve-http's check directly; the localOnly check lives inside dispatch and is skipped.
          if (kind === 'scope') gates.push({ caller, op: op.name, kind, outcome: g.operationScopesAllowed(['read'], op) ? 'bypass' : 'denied', detail: 'operationScopesAllowed evaluated without calling the op' });
          else gates.push({ caller, op: op.name, kind, outcome: 'skipped_no_required_param', detail: 'not called: a bypass would run the handler' });
          continue;
        }
        const r = await call(caller, op, {});
        gates.push({ caller, op: op.name, kind, outcome: isDenial(r) ? 'denied' : 'bypass', detail: `${r.error_code ?? 'ok'}: ${r.raw.slice(0, 160)}` });
      }
    }
  }
  await engine.disconnect();

  // Accounting: one scored unit per exposed protected probe and per executed gate.
  const exposedRows = rows.filter(r => r.status !== 'not_exposed');
  const executedGates = gates.filter(x => x.outcome !== 'skipped_no_required_param');
  const acct = new ProbeAccounting(presenceOk ? exposedRows.length + executedGates.length : 1);
  if (!presenceOk) acct.error('presence', 'harness', `presence failed: ${[...seedErrors, ...pres.checks.filter(c => !c.pass).map(c => `${c.name} (${c.detail})`)].join('; ')}`);
  for (const r of exposedRows) {
    if (r.status === 'harness_error') acct.error(r.probe_id, 'harness', r.protected_error ?? 'timeout');
    else if (r.status === 'leak' || r.status === 'oracle') acct.error(r.probe_id, 'sut', `${r.status} on ${r.op} as ${r.caller} (${r.target}, ${r.variant})`);
    else acct.score(r.probe_id, 1);
  }
  for (const x of executedGates) {
    const id = `gate:${x.caller}:${x.op}`;
    if (x.outcome === 'bypass') acct.error(id, 'sut', `${x.kind} gate bypass: ${x.detail}`);
    else acct.score(id, 1);
  }
  const summary = acct.summary();

  const covered = opSummaries.filter(s => s.signal > 0).length;
  const reachable = new Set(rows.filter(r => r.local_replay_detected).map(r => r.op));
  const count = (k: ProbeFinding['kind']) => new Set(findings.filter(f => f.kind === k).map(f => f.probe_id)).size;
  const byCaller = Object.fromEntries(REMOTE_CALLERS.map(c => [c, {
    probes: exposedRows.filter(r => r.caller === c).length,
    signal: exposedRows.filter(r => r.caller === c && r.control).length,
    leaks: exposedRows.filter(r => r.caller === c && r.status === 'leak').length,
    oracles: exposedRows.filter(r => r.caller === c && r.status === 'oracle').length,
  }]));
  const expansionOps = opSummaries.filter(s => s.expansion).map(s => s.op);
  // gbrain branch capy/evidence-delivery documents the expansion surface in docs/evidence-delivery.md;
  // when the build under test carries that doc, every documented entry point must exist to be fuzzed.
  const expansionDocumented = existsSync(join(gut.root, 'docs/evidence-delivery.md'));
  const expansionMissing = expansionDocumented
    ? [...['search', 'query', 'recall'].filter(n => !('return_unit' in (g.operations.find(o => o.name === n)?.params ?? {}))).map(n => `${n}.return_unit`),
      ...(g.operations.some(o => o.name === 'assemble_evidence') ? [] : ['assemble_evidence'])]
    : [];
  // Per op and requested unit. `applied` counts probes whose response shows an expanded block; `fence_probes` /
  // `fence_neighbor_reached` count Takes/Facts twin probes and those whose delivered text reached the public rows
  // beside the protected ones (the presence control for fenced rows, which sealed chunks keep out for every caller).
  const perUnit: Record<string, { probes: number; signal: number; applied: number; fence_probes: number; fence_neighbor_reached: number; leaks: number; oracles: number }> = {};
  for (const r of exposedRows) {
    if (!r.expansion_unit) continue;
    const key = `${r.op}:${r.expansion_unit}`;
    perUnit[key] ??= { probes: 0, signal: 0, applied: 0, fence_probes: 0, fence_neighbor_reached: 0, leaks: 0, oracles: 0 };
    const u = perUnit[key];
    u.probes++;
    if (r.control) u.signal++;
    if (r.expansion_applied) u.applied++;
    if (r.fence_neighbor_reached !== undefined) u.fence_probes++;
    if (r.fence_neighbor_reached) u.fence_neighbor_reached++;
    if (r.status === 'leak') u.leaks++;
    if (r.status === 'oracle') u.oracles++;
  }
  const metrics = {
    read_ops_total: readOps.length,
    read_ops_covered: covered,
    op_coverage: readOps.length ? covered / readOps.length : 0,
    // Read ops that return protected content to the trusted local caller for at least one synthesized probe:
    // the ops that could leak in this world. Coverage of these is the meaningful share.
    read_ops_content_reachable: reachable.size,
    content_reachable_coverage: reachable.size ? opSummaries.filter(s => s.signal > 0 && reachable.has(s.op)).length / reachable.size : 0,
    probes_exposed: exposedRows.length,
    probes_with_signal: exposedRows.filter(r => r.control).length,
    probes_no_signal: exposedRows.filter(r => r.status === 'no_signal').length,
    named_window_probes_with_signal: exposedRows.filter(r => r.control && 'window' in (readOps.find(o => o.name === r.op)?.params ?? {})).length,
    content_leak_probes: count('content'),
    existence_leak_probes: count('existence'),
    oracle_probes: count('oracle'),
    gates_executed: executedGates.length,
    gate_bypasses: executedGates.filter(x => x.outcome === 'bypass').length,
    sealed_chunk_violations: pres.sealed_chunk_violations.length,
    // Detector controls on the trusted local caller, who may read everything: the scanners must fire there.
    local_replays: localReplay.size,
    local_replay_detections: [...localReplay.values()].filter(Boolean).length,
    local_oracle_pairs: localOraclePairs,
    local_oracle_differences: localOracleDiffs,
  };
  const leakFree = metrics.content_leak_probes === 0 && metrics.existence_leak_probes === 0 && metrics.oracle_probes === 0 && metrics.gate_bypasses === 0 && metrics.sealed_chunk_violations === 0;

  const receipt: Receipt = {
    ...noModelSpend('hermetic: no model and no paid request (provider keys removed from the environment)'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: N6_CATEGORY,
    run_status: presenceOk ? 'completed' : 'error',
    ...(presenceOk ? { verdict: leakFree && !summary.run_invalid ? 'pass' as const : 'fail' as const } : {}),
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable && presenceOk,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    accounting: {
      planned: summary.n_total,
      attempted: summary.n_total,
      scored: summary.n_scored,
      errors: new Set(summary.errors.filter(e => e.origin !== 'sut').map(e => e.probe_id)).size,
      misses: new Set(summary.errors.filter(e => e.origin === 'sut').map(e => e.probe_id)).size,
      source: 'runner',
    },
    resolved_config: {
      engine: 'pglite (in-memory)',
      decide: DECIDE_OFF,
      seed: seedValue,
      generator_version: N6_GENERATOR_VERSION,
      callers: REMOTE_CALLERS,
      granted_source: ledger.granted_source,
      holder_allow_list: ['world'],
      call_timeout_ms: CALL_TIMEOUT_MS,
      only: options.only ?? null,
      gbrain_overlay: overlaySummary(gut),
      not_exercised: ['network transport and OAuth token verification (serve-http tools/call replayed in process)', 'Postgres engine', 'write ops executed by write-scoped callers', 'gates on ops without a required param (safety)'],
    },
    hashes: { ledger_sha256: ledgerFingerprint(ledger) },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      metrics,
      presence: { seed_errors: seedErrors, checks: pres.checks, sealed_chunk_violations: pres.sealed_chunk_violations },
      by_caller: byCaller,
      expansion_paths: { documented: expansionDocumented, present: expansionOps.length > 0, ops: expansionOps, documented_but_missing: expansionMissing, per_unit: perUnit,
        not_applied: exposedRows.filter(r => r.expansion_unit && !['chunk', 'default'].includes(r.expansion_unit) && !r.expansion_applied).map(r => r.probe_id) },
      ops: opSummaries,
      uncovered_ops: opSummaries.filter(s => s.signal === 0).map(s => ({ op: s.op, reason: uncoveredReason(s, rows.filter(r => r.op === s.op)) })),
      findings: findings.slice(0, 400),
      findings_total: findings.length,
      gates,
      no_signal_samples: exposedRows.filter(r => r.status === 'no_signal').slice(0, 60),
    },
  };
  const file = options.outputDir ? join(options.outputDir, 'receipt.json') : receiptPath(N6_CATEGORY, options.reportsDir);
  writeReceipt(file, (options.attestation ? { ...receipt, preregistration_attestation: options.attestation } : receipt) as Receipt);
  log(`[n6] coverage ${covered}/${readOps.length} read ops; content leaks ${metrics.content_leak_probes}, existence ${metrics.existence_leak_probes}, oracles ${metrics.oracle_probes}, gate bypasses ${metrics.gate_bypasses}; receipt ${file}`);
  return { receipt, file };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const seedArg = flag('--seed');
  const only = flag('--only');
  const attest = flag('--attest');
  runN6({ seed: seedArg ? Number(seedArg) : undefined, gbrainSpec: gbrainSpecFrom(argv), only: only ? only.split(',') : undefined, outputDir: flag('--output'), attestation: attest ? attestPreregistration(attest) : null })
    .then(({ receipt }) => {
      if (argv.includes('--json')) console.log(JSON.stringify(receipt.data, null, 2));
      process.exit(receipt.run_status === 'completed' ? 0 : 1);
    })
    .catch(err => { console.error(err); process.exit(1); });
}
