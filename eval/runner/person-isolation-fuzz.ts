/**
 * Per-person memory isolation fuzz (preregistration docs/benchmarks/2026-11-24-person-isolation-preregistration.md).
 *
 * Question: on a gbrain brain that serves several people, can anything one person saved, or anything only one person
 * may read, reach another person, or a caller acting for nobody, through any read path? The bar is zero.
 *
 * The world (eval/generators/person-isolation-gen.ts) holds six members and one who leaves. The brain is built through
 * the gbrain CLI as an operator would build it (members, links, personal sources, folder rules, pages, credentials);
 * the people's own writes (memory_write, remember, memory_propose) go through the transport under test. Then every
 * non-writing operation in gbrain's registry, plus write-shaped reads, is called as other people and as callers
 * acting for nobody, and every response is scanned for the target person's canaries and identifiers. A targeted probe
 * is compared with the same probe aimed at a never-written ghost of the same shape (existence oracle).
 *
 * Cells: transport mcp-dispatch (gbrain's MCP dispatch in process, provider-verified client-credentials tokens),
 * http (gbrain serve --http as a separate process, real requests with x-qm-actor) and cli (the thin-client CLI and
 * the host's --as preview against that server), each on PGLite and Postgres.
 *
 * Security: a leaking probe's arguments and response go only to the ignored eval/reports/ folder (leaks.jsonl). The
 * receipt and the console carry counts by cell, operation, caller and kind, never the arguments or the text.
 *
 * Usage: bun eval/runner/person-isolation-fuzz.ts [--profile full|ci|pilot] [--seeds 20261124,...]
 *          [--cells mcp-dispatch-pglite,http-pglite,cli-pglite,mcp-dispatch-postgres,http-postgres,cli-postgres]
 *          [--pg-url <admin url>] [--only op1,op2] [--output <dir>] [--attest <preregistration.md>] [--json]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import type { Operation } from 'gbrain/operations';
import { canariesOf, generatePersonWorld, PI_COUNTED_SEEDS, PI_DEFAULT_SEED, PI_GENERATOR_VERSION, type PIMember, type PIWorld } from '../generators/person-isolation-gen.ts';
import { gbrainSpecFrom, importGbrain, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { strippedKeysIn } from './hermetic-env.ts';
import { freePort } from './lifecycle/slice.ts';
import { attestPreregistration, type Attestation } from './prereg.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';

export const PI_CATEGORY = 'person-isolation-fuzz';
export const PI_PREREGISTRATION = 'docs/benchmarks/2026-11-24-person-isolation-preregistration.md';
export const MANDATORY_OPS = ['memory_recall', 'recall', 'query', 'search', 'get_page', 'get_chunks', 'entity', 'context_pack', 'delta', 'think', 'volunteer_context', 'whois', 'get_backlinks', 'get_timeline', 'list_write_requests', 'get_write_request'] as const;
export const MANDATORY_CLI = ['query', 'search', 'get_page', 'recall', 'think'] as const;
export type Transport = 'mcp-dispatch' | 'http' | 'cli';
export type EngineKind = 'pglite' | 'postgres';
export const CELLS = ['mcp-dispatch-pglite', 'http-pglite', 'cli-pglite', 'mcp-dispatch-postgres', 'http-postgres', 'cli-postgres'] as const;
export type CellId = (typeof CELLS)[number];
export type Profile = 'full' | 'ci' | 'pilot';
const TIMEOUT_MS: Record<Transport, number> = { 'mcp-dispatch': 10_000, http: 30_000, cli: 30_000 };
const MAX_HARNESS_ERRORS_PER_OP = 2;

// ─── Callers ───────────────────────────────────────────────────────────

export type CallerKind = 'attested-dm' | 'attested-room' | 'attested-variant' | 'member-key' | 'bare-attest' | 'unbound-unscoped' | 'unbound' | 'left' | 'host-as' | 'owner-attested' | 'owner-key';
export const PROBE_KINDS: readonly CallerKind[] = ['attested-dm', 'attested-room', 'attested-variant', 'member-key', 'bare-attest', 'unbound-unscoped', 'unbound', 'left', 'host-as'];
export interface Caller {
  kind: CallerKind;
  /** The member this caller reads as when it works as designed; null for callers acting for nobody. */
  as: string | null;
  client: string;
  actor?: string;
  acting_user?: string;
  /** Extra arguments the caller adds (attested-room names its source). */
  extra?: Record<string, unknown>;
  label: string;
}

/** Near-miss ids for a target's external id: none of them is linked to the target. */
export function nearMisses(target: PIMember, world: PIWorld): Array<{ actor: string; label: string; reads_as: string | null }> {
  const linked = new Map(world.members.map(m => [m.ext, m.id]));
  const swapCase = target.ext.replace(/[a-z]/gi, ch => ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());
  const out = [
    { actor: swapCase, label: 'case-swapped' },
    { actor: ' ' + target.ext, label: 'leading-space' },
    { actor: target.ext + 'x', label: 'trailing-char' },
    { actor: target.ext.slice(0, -1), label: 'truncated' },
  ];
  return out.filter(v => v.actor !== target.ext).map(v => ({ ...v, reads_as: linked.get(v.actor) ?? null }));
}

/** The callers that probe one target person, none of them that person. Q rotates over the other people by index. */
export function callersFor(world: PIWorld, target: PIMember, rotation: number, transport: Transport): Caller[] {
  const others = world.members.filter(m => m.id !== target.id && m.role !== 'left');
  const q = others[rotation % others.length]!;
  const left = world.members.find(m => m.role === 'left')!;
  const out: Caller[] = [];
  if (transport !== 'cli') {
    out.push({ kind: 'attested-dm', as: q.id, client: 'qm-dm', actor: q.ext, label: 'attested-dm' });
    out.push({ kind: 'attested-room', as: q.id, client: 'qm-room', actor: q.ext, extra: { source_id: world.team_source }, label: 'attested-room' });
    for (const v of nearMisses(target, world)) out.push({ kind: 'attested-variant', as: v.reads_as, client: 'qm-dm', actor: v.actor, label: 'attested-variant:' + v.label });
    out.push({ kind: 'attested-variant', as: q.id, client: 'qm-dm', actor: q.ext, acting_user: target.ext, label: 'attested-variant:acting-user-mismatch' });
    out.push({ kind: 'bare-attest', as: null, client: 'qm-dm', label: 'bare-attest' });
    if (target.role !== 'left') out.push({ kind: 'left', as: null, client: 'qm-dm', actor: left.ext, label: 'left:attested' });
  } else {
    out.push({ kind: 'host-as', as: q.id, client: 'host', label: 'host-as' });
  }
  out.push({ kind: 'member-key', as: q.id, client: 'key:' + q.id, label: 'member-key' });
  out.push({ kind: 'unbound-unscoped', as: null, client: 'unscoped', label: 'unbound-unscoped' });
  out.push({ kind: 'unbound', as: null, client: 'unbound', label: 'unbound' });
  if (target.role !== 'left') out.push({ kind: 'left', as: null, client: 'key:' + left.id, label: 'left:key' });
  return out;
}

export function ownerControls(target: PIMember, transport: Transport): Caller[] {
  return transport === 'cli'
    ? [{ kind: 'owner-key', as: target.id, client: 'key:' + target.id, label: 'owner-key' }]
    : [{ kind: 'owner-attested', as: target.id, client: 'qm-dm', actor: target.ext, label: 'owner-attested' }, { kind: 'owner-key', as: target.id, client: 'key:' + target.id, label: 'owner-key' }];
}

// ─── Targets and arguments ─────────────────────────────────────────────

export type TargetKind = 'member_page' | 'readable_by' | 'folder' | 'dm_page' | 'colleague_page' | 'company' | 'fact' | 'write_request' | 'proposal' | 'query';
export interface Target { kind: TargetKind; slug?: string; source_id?: string; fact_id?: string; request_id?: string; name?: string; query: string }
export interface Fixture {
  world: PIWorld;
  facts: Map<string, string[]>;
  requests: Map<string, string[]>;
  proposals: Map<string, string[]>;
  idempotency: Map<string, string>;
  public_fact_id: string | null;
  max_fact_id: number;
}

export function targetsFor(f: Fixture, target: PIMember): Array<{ protected: Target; ghost: Target | null; twin: Target }> {
  const w = f.world;
  const tw1 = w.topic.split(' ')[0]!;
  const ghost = w.members.find(m => m.id === w.ghost_member)!;
  const h = w.holdings.find(x => x.member === target.id)!;
  const q = w.topic + ' ' + target.name.split(' ')[0];
  const twinSlug: Target = { kind: 'readable_by', slug: 'notes/public-' + tw1, source_id: w.team_source, query: w.topic };
  const out: Array<{ protected: Target; ghost: Target | null; twin: Target }> = [
    { protected: { kind: 'member_page', slug: 'memory/members/' + target.id, source_id: w.team_source, query: q }, ghost: { kind: 'member_page', slug: 'memory/members/' + ghost.id, source_id: w.team_source, query: q }, twin: { ...twinSlug, kind: 'member_page' } },
    { protected: { kind: 'readable_by', slug: h.readable_by.slug, source_id: w.team_source, query: q }, ghost: { kind: 'readable_by', slug: 'notes/' + ghost.id + '-' + tw1, source_id: w.team_source, query: q }, twin: twinSlug },
    { protected: { kind: 'folder', slug: h.folder.slug, source_id: w.team_source, query: q }, ghost: { kind: 'folder', slug: ghost.folder + tw1 + '-plan', source_id: w.team_source, query: q }, twin: { ...twinSlug, kind: 'folder' } },
    { protected: { kind: 'dm_page', slug: h.dm_source.slug, source_id: target.dm_source, query: q }, ghost: { kind: 'dm_page', slug: h.dm_source.slug, source_id: ghost.dm_source, query: q }, twin: { ...twinSlug, kind: 'dm_page' } },
    { protected: { kind: 'colleague_page', slug: h.remember_about.entity, source_id: w.team_source, name: w.members.find(m => m.id === h.remember_about.colleague)!.name, query: w.topic }, ghost: null, twin: { kind: 'colleague_page', slug: 'people/' + ghost.id, source_id: w.team_source, name: ghost.name, query: w.topic } },
    { protected: { kind: 'company', slug: w.company.slug, source_id: w.team_source, name: w.company.name, query: w.topic + ' ' + w.company.name }, ghost: null, twin: { kind: 'company', slug: w.project.slug, source_id: w.team_source, name: w.project.name, query: w.topic } },
    { protected: { kind: 'query', query: q, name: target.name }, ghost: null, twin: { kind: 'query', query: w.topic, name: w.company.name } },
  ];
  const pubFact = f.public_fact_id ?? '1';
  (f.facts.get(target.id) ?? []).forEach((id, i) => out.push({ protected: { kind: 'fact', fact_id: id, query: q }, ghost: { kind: 'fact', fact_id: String(f.max_fact_id + 1000 + i), query: q }, twin: { kind: 'fact', fact_id: pubFact, query: w.topic } }));
  for (const id of f.requests.get(target.id) ?? []) out.push({ protected: { kind: 'write_request', request_id: id, query: q }, ghost: { kind: 'write_request', request_id: randomUUID(), query: q }, twin: { kind: 'write_request', request_id: randomUUID(), query: w.topic } });
  for (const id of f.proposals.get(target.id) ?? []) out.push({ protected: { kind: 'proposal', request_id: id, query: q }, ghost: { kind: 'proposal', request_id: randomUUID(), query: q }, twin: { kind: 'proposal', request_id: randomUUID(), query: w.topic } });
  return out;
}

const SLUG_PARAMS = new Set(['slug', 'page_slug', 'entity_slug', 'from', 'to', 'source_slug', 'page', 'anchor', 'since_slug', 'target']);
const SLUG_LIST_PARAMS = new Set(['slugs', 'pages']);
const QUERY_PARAMS = new Set(['query', 'q', 'question', 'topic', 'prompt', 'text', 'phrase', 'claim', 'grep', 'prior_context', 'turn_text', 'summary']);
const NAME_PARAMS = new Set(['entity', 'name', 'symbol', 'entry_point', 'person', 'who']);
const NAME_LIST_PARAMS = new Set(['entities', 'names']);
const FACT_PARAMS = new Set(['id', 'fact_id', 'answer_id']);
const REQUEST_PARAMS = new Set(['request_id']);
const WIDENING = new Set(['include_private', 'include_deleted', 'include_expired', 'include_pending', 'include_quarantined', 'include_archived', 'all_sources', 'include_context', 'supersessions', 'include_content', 'detail']);

/** Whether an op takes a parameter a target can aim at. */
export function targetKindsFor(op: Pick<Operation, 'params'>): Set<TargetKind> {
  const names = Object.keys(op.params ?? {});
  const kinds = new Set<TargetKind>();
  if (names.some(n => SLUG_PARAMS.has(n) || SLUG_LIST_PARAMS.has(n))) for (const k of ['member_page', 'readable_by', 'folder', 'dm_page', 'colleague_page', 'company'] as const) kinds.add(k);
  if (names.some(n => NAME_PARAMS.has(n) || NAME_LIST_PARAMS.has(n))) { kinds.add('colleague_page'); kinds.add('company'); kinds.add('query'); }
  if (names.some(n => FACT_PARAMS.has(n) || n === 'ids')) kinds.add('fact');
  if (names.some(n => REQUEST_PARAMS.has(n))) { kinds.add('write_request'); kinds.add('proposal'); }
  if (!kinds.size || names.some(n => QUERY_PARAMS.has(n) || n === 'window')) kinds.add('query');
  return kinds;
}

/** One argument set aimed at a target; never carries a canary. */
export function argsFor(op: Pick<Operation, 'params'>, t: Target, sessionId: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(op.params ?? {}) as Array<[string, { type?: string; required?: boolean; enum?: unknown[]; items?: { type?: string } }]>) {
    let v: unknown;
    if (SLUG_PARAMS.has(name) && t.slug) v = t.slug;
    else if (SLUG_LIST_PARAMS.has(name) && t.slug) v = [t.slug];
    else if (QUERY_PARAMS.has(name)) v = t.query;
    else if (name === 'window') v = def.type === 'array' ? [{ role: 'user', content: 'I am meeting ' + (t.name ?? t.query) + ' about the ' + t.query }] : 'user: I am meeting ' + (t.name ?? t.query) + ' about the ' + t.query;
    else if (NAME_PARAMS.has(name)) v = t.name ?? t.query;
    else if (NAME_LIST_PARAMS.has(name)) v = [t.name ?? t.query];
    else if (FACT_PARAMS.has(name) && t.fact_id) v = def.type === 'number' ? Number(t.fact_id) : t.fact_id;
    else if (name === 'ids' && t.fact_id) v = [def.items?.type === 'string' ? t.fact_id : Number(t.fact_id)];
    else if (REQUEST_PARAMS.has(name) && t.request_id) v = t.request_id;
    else if (name === 'source_id' && t.source_id) v = t.source_id;
    else if (name === 'session_id') v = sessionId;
    else if (name === 'since') v = '2000-01-01';
    else if (name === 'until') v = '2999-01-01';
    else if (name === 'limit') v = 50;
    else if (WIDENING.has(name) && def.type === 'boolean') v = true;
    else if (def.required) v = def.enum?.length ? def.enum[0] : def.type === 'number' ? 1 : def.type === 'boolean' ? true : def.type === 'array' ? [] : def.type === 'object' ? {} : t.query;
    if (v !== undefined) args[name] = v;
  }
  return args;
}

/** The base argument set plus one variant per value of each enum parameter the base set does not fix. */
export function variantsFor(op: Pick<Operation, 'params'>, base: Record<string, unknown>, cap: number): Array<{ id: string; args: Record<string, unknown> }> {
  const out = [{ id: 'base', args: base }];
  for (const [name, def] of Object.entries(op.params ?? {}) as Array<[string, { enum?: unknown[] }]>) {
    for (const value of def.enum ?? []) {
      if (base[name] === value || out.length >= cap) continue;
      out.push({ id: name + '=' + String(value), args: { ...base, [name]: value } });
    }
  }
  return out;
}

// ─── Scanning ──────────────────────────────────────────────────────────

export interface Gold { canaries: string[]; slugs: string[]; request_ids: string[]; fact_ids: string[] }

export function goldFor(f: Fixture, member: string): Gold {
  const w = f.world;
  const h = w.holdings.find(x => x.member === member);
  return {
    canaries: canariesOf(w, member),
    slugs: h ? ['memory/members/' + member, h.readable_by.slug, h.folder.slug] : [],
    request_ids: [...(f.requests.get(member) ?? []), ...(f.proposals.get(member) ?? [])],
    fact_ids: f.facts.get(member) ?? [],
  };
}

const esc = (s: string) => s.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
/** A slug as a whole token: not followed by another slug character, so memory/members/ann never matches ann-lee. */
export function containsSlug(text: string, slug: string): boolean {
  return new RegExp(esc(slug) + '(?![A-Za-z0-9_-])').test(text);
}

function factIdsIn(value: unknown, out: Set<string>, underFacts = false): void {
  if (Array.isArray(value)) { for (const v of value) factIdsIn(v, out, underFacts); return; }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if ((k === 'fact_id' || (k === 'id' && underFacts)) && (typeof v === 'string' || typeof v === 'number')) out.add(String(v));
    else if (k === 'fact_ids' && Array.isArray(v)) for (const x of v) out.add(String(x));
    else factIdsIn(v, out, k === 'facts' || k === 'results' && underFacts);
  }
}

/** Fact ids a response carries in fact-shaped places (fact_id, fact_ids, or id inside a facts list). */
export function factIdsInText(text: string): Set<string> {
  const out = new Set<string>();
  for (const chunk of text.split('\n')) {
    const t = chunk.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) continue;
    try { factIdsIn(JSON.parse(t), out); } catch { /* not JSON */ }
  }
  return out;
}

export interface LeakHits { content: string[]; identifier: string[] }

/** What a response gives away about a member: canaries, and identifiers the probe did not send. */
export function scan(text: string, gold: Gold, sent: string): LeakHits {
  const content = gold.canaries.filter(c => text.includes(c) && !sent.includes(c));
  const identifier: string[] = [];
  for (const s of gold.slugs) if (!containsSlug(sent, s) && containsSlug(text, s)) identifier.push('slug');
  for (const id of gold.request_ids) if (!sent.includes(id) && text.includes(id)) identifier.push('request_id');
  const ids = factIdsInText(text);
  for (const id of gold.fact_ids) if (ids.has(id) && !sent.includes('"' + id + '"') && !new RegExp('[:\\[,]\\s*' + id + '(?![0-9])').test(sent)) identifier.push('fact_id');
  return { content, identifier };
}

/** A response with target values and volatile fields masked, for the protected-versus-ghost comparison. */
export function normalizeForOracle(text: string, masks: readonly string[]): string {
  let t = text;
  for (const m of [...masks].filter(Boolean).sort((a, b) => b.length - a.length)) t = t.split(m).join('<T>');
  return t
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/"(\w*(?:_ms|ms|latency|elapsed|duration|took|took_ms|generated_at|served_at|now|at))"\s*:\s*-?\d+(?:\.\d+)?/gi, '"$1":<n>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/(session|request|trace|span)[_-]?id"\s*:\s*"[^"]*"/gi, '$1_id":"<id>"');
}

// ─── Transports ────────────────────────────────────────────────────────

export interface Outcome { exposed: boolean; ok: boolean; error_code?: string; text: string; timed_out?: boolean; harness?: boolean }
type Call = (caller: Caller, op: string, args: Record<string, unknown>, session: string) => Promise<Outcome>;

interface Client { id: string; secret: string }
interface Brain { home: string; env: NodeJS.ProcessEnv; work: string; dbUrl: string | null; pgPath: string | null; clients: Record<string, Client>; cli: (args: string[], input?: string, envOver?: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>; drop: () => Promise<void> }

function withTimeout(p: Promise<Outcome>, ms: number): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<Outcome>(resolve => { timer = setTimeout(() => resolve({ exposed: true, ok: false, error_code: 'harness_timeout', text: '', timed_out: true, harness: true }), ms); });
  return Promise.race([p.catch(e => ({ exposed: true, ok: false, error_code: 'harness_exception', text: String(e instanceof Error ? e.message : e), harness: true })), t]).finally(() => clearTimeout(timer));
}

const DENIAL = /permission_denied|requester_scope_required|actor_not_attested|actor_unlinked|insufficient_scope|not_attested|unknown tool|tool not found|not_exposed|unauthori[sz]ed|forbidden|refused/i;

function toolResultText(result: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; _meta?: unknown; isError?: boolean }): Outcome {
  const text = (result.content ?? []).map(c => c.text ?? '').join('\n') + '\n' + JSON.stringify(result.structuredContent ?? null) + '\n' + JSON.stringify(result._meta ?? null);
  const ok = result.isError !== true;
  return { exposed: ok || !DENIAL.test(text), ok, text, error_code: ok ? undefined : ((/"code"\s*:\s*"([a-z_]+)"/.exec(text)?.[1]) ?? 'error') };
}

async function buildBrain(gut: GbrainUnderTest, world: PIWorld, engine: EngineKind, pgAdminUrl: string | null, attestOps: string[], log: (s: string) => void): Promise<Brain> {
  const work = mkdtempSync(join(tmpdir(), 'pi-'));
  const home = join(work, 'gbrain-home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(work, 'user-home'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(work, 'user-home'), GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
    GBRAIN_HTTP_RATE_LIMIT_IP: '100000000', GBRAIN_HTTP_RATE_LIMIT_TOKEN: '100000000',
  };
  const keys = strippedKeysIn(env);
  if (keys.length) throw new Error('child environment carries provider keys: ' + keys.join(', '));
  const cli = (args: string[], input?: string, envOver?: NodeJS.ProcessEnv) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const child = spawn('bun', [join(gut.root, 'src/cli.ts'), ...args], { env: envOver ?? env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS.cli * 10);
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
  const must = async (step: string, args: string[], input?: string) => {
    const r = await cli(args, input);
    if (r.code !== 0) throw new Error(step + ' failed (exit ' + r.code + '): ' + (r.stdout + r.stderr).replace(/gbrain_[a-z]{2}_[0-9a-f]+/g, '<redacted>').slice(-500));
    return r;
  };
  let dbUrl: string | null = null;
  let dbName: string | null = null;
  if (engine === 'postgres') {
    if (!pgAdminUrl) throw new Error('postgres cells need --pg-url or PI_PG_URL');
    dbName = 'pi_' + process.pid + '_' + Date.now();
    const admin = new SQL(pgAdminUrl);
    await admin.unsafe('CREATE DATABASE ' + dbName);
    await admin.close();
    const u = new URL(pgAdminUrl); u.pathname = '/' + dbName; dbUrl = u.toString();
    await must('init', ['init', '--url', dbUrl, '--no-embedding', '--non-interactive']);
  } else {
    await must('init', ['init', '--pglite', '--no-embedding', '--non-interactive']);
  }
  const t = world.team_source;
  await must('sources add ' + t, ['sources', 'add', t]);
  for (const m of world.members) await must('sources add ' + m.dm_source, ['sources', 'add', m.dm_source]);
  for (const m of world.members) {
    await must('member add', ['access', 'member', 'add', m.id, '--name', m.name, ...(m.groups.length ? ['--groups', m.groups.join(',')] : [])]);
    await must('member link', ['access', 'member', 'link', m.id, '--qm', m.ext]);
    await must('member source', ['access', 'member', 'source', 'add', m.id, m.dm_source]);
    await must('folder rule', ['access', 'rule', 'add', '--id', 'folder-' + m.id, '--prefix', m.folder, '--readers', 'member:' + m.id, '--source', t, '--yes']);
  }
  for (const p of world.pages) await must('put ' + p.slug, ['put', p.slug, '--source-id', p.source_id], p.content);
  await must('public fact', ['remember', world.public_fact.fact, '--entity', world.public_fact.entity, '--provenance', 'operator', '--source-id', t]);
  const clients: Record<string, Client> = {};
  const register = async (name: string, extra: string[] = []) => {
    const r = await must('register ' + name, ['auth', 'register-client', 'pi-' + name.replace(/[^a-z0-9-]/gi, '-'), '--grant-types', 'client_credentials', '--scopes', 'read write', '--source', t, ...extra]);
    const id = /gbrain_cl_[0-9a-f]+/.exec(r.stdout)?.[0];
    const secret = /gbrain_cs_[0-9a-f]+/.exec(r.stdout)?.[0];
    if (!id || !secret) throw new Error('could not parse OAuth client ' + name);
    clients[name] = { id, secret };
    return id;
  };
  const dms = world.members.map(m => m.dm_source);
  const dm = await register('qm-dm');
  await must('rescope qm-dm', ['auth', 'rescope', '--client', dm, '--sources', [t, ...dms].join(','), '--attest-actor', 'qm', '--attest-ops', attestOps.join(','), '--attest-read', 'person', '--yes']);
  const room = await register('qm-room');
  await must('rescope qm-room', ['auth', 'rescope', '--client', room, '--sources', t, '--attest-actor', 'qm', '--attest-ops', attestOps.join(','), '--attest-read', 'scope', '--yes']);
  for (const m of world.members) {
    const id = await register('key:' + m.id);
    await must('rescope key', ['auth', 'rescope', '--client', id, '--member', m.id, '--sources', [t, m.dm_source].join(','), '--yes']);
  }
  const unscoped = await register('unscoped');
  await must('rescope unscoped', ['auth', 'rescope', '--client', unscoped, '--reads-unscoped', '--yes']);
  await register('unbound');
  log('[pi] ' + engine + ' brain built: ' + world.members.length + ' members, ' + world.pages.length + ' pages, ' + Object.keys(clients).length + ' clients');
  const drop = async () => {
    if (dbName && pgAdminUrl) { const admin = new SQL(pgAdminUrl); await admin.unsafe('DROP DATABASE IF EXISTS ' + dbName + ' WITH (FORCE)').catch(() => {}); await admin.close(); }
    rmSync(work, { recursive: true, force: true });
  };
  return { home, env, work, dbUrl, pgPath: engine === 'pglite' ? join(home, '.gbrain', 'brain.pglite') : null, clients, cli, drop };
}
