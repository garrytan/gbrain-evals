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
import { canariesOf, generatePersonWorld, PI_CHANNELS, PI_COUNTED_SEEDS, PI_DEFAULT_SEED, PI_GENERATOR_VERSION, type PIMember, type PIWorld } from '../generators/person-isolation-gen.ts';
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

export type StopCode = 'PI_LEAK' | 'PI_COVERAGE' | 'PI_CONTROL' | 'PI_PROVIDER_KEY_VISIBLE' | 'PI_WRITE_FAILED' | 'PI_HARNESS' | 'PI_POSTGRES_UNAVAILABLE';
export const STOP_EXIT: Record<StopCode, number> = { PI_LEAK: 1, PI_COVERAGE: 2, PI_CONTROL: 2, PI_PROVIDER_KEY_VISIBLE: 3, PI_WRITE_FAILED: 3, PI_HARNESS: 3, PI_POSTGRES_UNAVAILABLE: 69 };
/** Most severe first: a leak is never hidden behind a broken harness, and a broken harness never reads as a coverage gap. */
export const STOP_ORDER: readonly StopCode[] = ['PI_PROVIDER_KEY_VISIBLE', 'PI_POSTGRES_UNAVAILABLE', 'PI_LEAK', 'PI_WRITE_FAILED', 'PI_HARNESS', 'PI_CONTROL', 'PI_COVERAGE'];
export class StopError extends Error { constructor(readonly code: StopCode, message: string) { super(message); } }

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

/** One argument set aimed at a target, one value per role (slug, query, name), never a canary; widening flags are variants. */
export function argsFor(op: Pick<Operation, 'params'>, t: Target, sessionId: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const params = (op.params ?? {}) as Record<string, { type?: string; required?: boolean; enum?: unknown[]; items?: { type?: string } }>;
  const names = Object.keys(params);
  const first = (order: readonly string[]) => order.find(n => n in params);
  const asType = (name: string, v: string) => params[name]!.type === 'array' ? [v] : v;
  const slugP = t.slug ? first(['slug', 'page_slug', 'entity_slug', 'page', 'source_slug', 'target', 'from', 'to', 'anchor', 'since_slug', 'slugs', 'pages']) : undefined;
  if (slugP) args[slugP] = asType(slugP, t.slug!);
  const queryP = first(['query', 'question', 'q', 'topic', 'prompt', 'text', 'phrase', 'claim', 'turn_text', 'summary', 'prior_context', 'grep']);
  if (queryP && (params[queryP]!.required || !slugP)) args[queryP] = t.query;
  const nameP = first(['entity', 'name', 'person', 'who', 'symbol', 'entry_point', 'entities', 'names']);
  if (nameP && (params[nameP]!.required || !slugP || t.kind === 'colleague_page' || t.kind === 'company')) args[nameP] = asType(nameP, t.name ?? t.query);
  if ('window' in params) args.window = params.window!.type === 'array' ? [{ role: 'user', content: 'I am meeting ' + (t.name ?? t.query) + ' about the ' + t.query }] : 'user: I am meeting ' + (t.name ?? t.query) + ' about the ' + t.query;
  const factP = t.fact_id ? first(['fact_id', 'id', 'answer_id', 'ids']) : undefined;
  if (factP) args[factP] = factP === 'ids' ? [params.ids!.items?.type === 'string' ? t.fact_id : Number(t.fact_id)] : params[factP]!.type === 'number' ? Number(t.fact_id) : t.fact_id;
  if (t.request_id && 'request_id' in params) args.request_id = t.request_id;
  if (t.source_id && 'source_id' in params) args.source_id = t.source_id;
  if ('session_id' in params) args.session_id = sessionId;
  if ('since' in params && !params.since!.required && params.since!.type === 'string') args.since = '2000-01-01';
  if ('until' in params && params.until!.type === 'string') args.until = '2999-01-01';
  if ('limit' in params) args.limit = 50;
  for (const name of names) {
    const def = params[name]!;
    if (args[name] !== undefined || !def.required) continue;
    args[name] = def.enum?.length ? def.enum[0] : def.type === 'number' || def.type === 'integer' ? 1 : def.type === 'boolean' ? true : def.type === 'array' ? [] : def.type === 'object' ? {} : t.query;
  }
  return args;
}

/** One variant per widening boolean an operation takes, each alone (some combinations are refused as conflicting). */
export function wideningVariants(op: Pick<Operation, 'params'>, base: Record<string, unknown>): Array<{ id: string; args: Record<string, unknown> }> {
  const params = (op.params ?? {}) as Record<string, { type?: string }>;
  return Object.keys(params).filter(n => WIDENING.has(n) && params[n]!.type === 'boolean' && base[n] === undefined)
    .map(n => ({ id: n + '=true', args: { ...base, [n]: true, ...(n === 'all_sources' ? { source_id: undefined } : {}) } }))
    .map(v => ({ id: v.id, args: Object.fromEntries(Object.entries(v.args).filter(([, x]) => x !== undefined)) }));
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
  let t = text
    .replace(/\beyJ[A-Za-z0-9_+/-]+=*/g, tok => { try { const d = Buffer.from(tok.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); JSON.parse(d); return '<b64:' + d + '>'; } catch { return '<b64>'; } })
    .replace(/\[gbrain notice [^\]]*\][^\n]*(\n(why|fix|next|docs):[^\n]*)*/g, '<notice>')
    .replace(/"gbrain_notices"\s*:\s*\[(?:[^\[\]]|\[[^\]]*\])*\]\s*,?/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/"(\w*(?:_ms|ms|latency|elapsed|duration|took|took_ms|generated_at|served_at|now|at))"\s*:\s*-?\d+(?:\.\d+)?/gi, '"$1":<n>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/(session|request|trace|span)[_-]?id"\s*:\s*"[^"]*"/gi, '$1_id":"<id>"');
  for (const m of [...masks].filter(Boolean).sort((a, b) => b.length - a.length)) t = t.replace(new RegExp('(?<![A-Za-z0-9_/-])' + esc(m) + '(?![A-Za-z0-9_-])', 'g'), '<T>');
  return t.split('\n').filter(l => l.trim() !== '' && l.trim() !== '<notice>').join('\n');
}

// ─── Transports ────────────────────────────────────────────────────────

export interface Outcome { exposed: boolean; ok: boolean; error_code?: string; text: string; timed_out?: boolean; harness?: boolean }
type Call = (caller: Caller, op: string, args: Record<string, unknown>, session: string) => Promise<Outcome>;

interface Client { id: string; secret: string }
interface Brain { home: string; env: NodeJS.ProcessEnv; work: string; dbUrl: string | null; pgPath: string | null; clients: Record<string, Client>; cli: (args: string[], input?: string, envOver?: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>; must: (step: string, args: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>; register: (name: string, extra?: string[]) => Promise<string>; unboundRefusal: string; drop: () => Promise<void> }

function withTimeout(p: Promise<Outcome>, ms: number): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<Outcome>(resolve => { timer = setTimeout(() => resolve({ exposed: true, ok: false, error_code: 'harness_timeout', text: '', timed_out: true, harness: true }), ms); });
  return Promise.race([p.catch(e => ({ exposed: true, ok: false, error_code: 'harness_exception', text: String(e instanceof Error ? e.message : e), harness: true })), t]).finally(() => clearTimeout(timer));
}

const DENIAL = /access_member_disabled|credential_scope_required|invalid_token|invalid_client|permission_denied|requester_scope_required|actor_not_attested|actor_unlinked|insufficient_scope|not_attested|unknown tool|tool not found|not_exposed|unauthori[sz]ed|forbidden|refused/i;

function toolResultText(result: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; _meta?: unknown; isError?: boolean }): Outcome {
  const text = (result.content ?? []).map(c => c.text ?? '').join('\n') + '\n' + JSON.stringify(result.structuredContent ?? null) + '\n' + JSON.stringify(result._meta ?? null);
  const ok = result.isError !== true;
  // memory_recall answers an unlinked actor with an empty success carrying the refusal code (documented), so that is a refusal too.
  const soft = ok && /"code"\s*:\s*"(actor_unlinked|requester_scope_required)"/.test(text);
  return { exposed: ok ? !soft : !DENIAL.test(text), ok, text, error_code: ok ? undefined : ((/"code"\s*:\s*"([a-z_]+)"/.exec(text)?.[1]) ?? 'error') };
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
    if (r.code !== 0) throw new StopError('PI_WRITE_FAILED', step + ' failed (exit ' + r.code + '): ' + (r.stdout + r.stderr).replace(/gbrain_[a-z]{2}_[0-9a-f]+/g, '<redacted>').slice(-500));
    return r;
  };
  let dbUrl: string | null = null;
  let dbName: string | null = null;
  if (engine === 'postgres') {
    if (!pgAdminUrl) throw new Error('postgres cells need --pg-url or PI_PG_URL');
    dbName = 'pi_' + process.pid + '_' + Date.now();
    const admin = new SQL(pgAdminUrl);
    try { await admin.unsafe('CREATE DATABASE ' + dbName); } catch (e) { throw new StopError('PI_POSTGRES_UNAVAILABLE', 'could not create a Postgres database: ' + (e instanceof Error ? e.message : String(e)).replace(/postgres(ql)?:\/\/[^\s]+/g, '<url>')); } finally { await admin.close().catch(() => {}); }
    const u = new URL(pgAdminUrl); u.pathname = '/' + dbName; dbUrl = u.toString();
    await must('init', ['init', '--url', dbUrl, '--no-embedding', '--non-interactive']);
  } else {
    await must('init', ['init', '--pglite', '--no-embedding', '--non-interactive']);
  }
  const t = world.team_source;
  await must('sources add ' + t, ['sources', 'add', t]);
  for (const m of world.members) await must('sources add ' + m.dm_source, ['sources', 'add', m.dm_source]);
  const clients: Record<string, Client> = {};
  const register = async (name: string, extra: string[] = []) => {
    const r = await must('register ' + name, ['auth', 'register-client', 'pi-' + name.replace(/[^a-z0-9-]/gi, '-'), '--grant-types', 'client_credentials', '--scopes', 'read write', '--source', t, ...extra]);
    const id = /gbrain_cl_[0-9a-f]+/.exec(r.stdout)?.[0];
    const secret = /gbrain_cs_[0-9a-f]+/.exec(r.stdout)?.[0];
    if (!id || !secret) throw new Error('could not parse OAuth client ' + name);
    clients[name] = { id, secret };
    return id;
  };
  for (const [i, m] of world.members.entries()) {
    // A client bound to nobody can only exist from before the brain served a second person (a brain that grew into a
    // shared one): gbrain refuses to create one after that, which is checked below.
    if (i === 1) await register('unbound');
    await must('member add', ['access', 'member', 'add', m.id, '--name', m.name, ...(m.groups.length ? ['--groups', m.groups.join(',')] : [])]);
    await must('member link', ['access', 'member', 'link', m.id, '--qm', m.ext]);
    await must('member source', ['access', 'member', 'source', 'add', m.id, m.dm_source]);
    await must('folder rule', ['access', 'rule', 'add', '--id', 'folder-' + m.id, '--prefix', m.folder, '--readers', 'member:' + m.id, '--source', t, '--yes']);
  }
  for (const p of world.pages) await must('put ' + p.slug, ['put', p.slug, '--source-id', p.source_id], p.content);
  await must('public fact', ['remember', world.public_fact.fact, '--entity', world.public_fact.entity, '--provenance', 'operator', '--source-id', t]);
  const refused = await cli(['auth', 'register-client', 'pi-unbound-late', '--grant-types', 'client_credentials', '--scopes', 'read write', '--source', t]);
  const unboundRefusal = refused.code !== 0 && /credential_scope_required/.test(refused.stdout + refused.stderr) ? 'credential_scope_required' : 'created';
  const everyone = world.members.map(m => m.id).join(',');
  const dms = world.members.map(m => m.dm_source);
  const dm = await register('qm-dm', ['--may-act-for', everyone]);
  await must('rescope qm-dm', ['auth', 'rescope', '--client', dm, '--sources', [t, ...dms].join(','), '--attest-actor', 'qm', '--attest-ops', attestOps.join(','), '--attest-read', 'person']);
  const room = await register('qm-room', ['--may-act-for', everyone]);
  await must('rescope qm-room', ['auth', 'rescope', '--client', room, '--sources', t, '--attest-actor', 'qm', '--attest-ops', attestOps.join(','), '--attest-read', 'scope']);
  for (const m of world.members) {
    const id = await register('key:' + m.id, ['--member', m.id]);
    await must('rescope key', ['auth', 'rescope', '--client', id, '--member', m.id, '--sources', [t, m.dm_source].join(',')]);
  }
  await register('unscoped', ['--reads-unscoped', '--yes']);
  log('[pi] ' + engine + ' brain built: ' + world.members.length + ' members, ' + world.pages.length + ' pages, ' + Object.keys(clients).length + ' clients');
  const drop = async () => {
    if (dbName && pgAdminUrl) { const admin = new SQL(pgAdminUrl); await admin.unsafe('DROP DATABASE IF EXISTS ' + dbName + ' WITH (FORCE)').catch(() => {}); await admin.close(); }
    rmSync(work, { recursive: true, force: true });
  };
  return { home, env, work, dbUrl, pgPath: engine === 'pglite' ? join(home, '.gbrain', 'brain.pglite') : null, clients, cli, must, register, unboundRefusal, drop };
}

// ─── Transport implementations ─────────────────────────────────────────

interface TransportHandle { call: Call; close: () => Promise<void>; suspend: () => Promise<void>; resume: () => Promise<void> }

async function openDispatch(gut: GbrainUnderTest, brain: Brain, engine: EngineKind): Promise<TransportHandle> {
  process.env.GBRAIN_HOME = brain.home;
  const [{ dispatchToolCall }, { GBrainOAuthProvider }, { sqlQueryForEngine }, { getBrainHotMemoryMeta }] = await Promise.all([
    importGbrain<any>(gut, 'src/mcp/dispatch.ts'), importGbrain<any>(gut, 'src/core/oauth-provider.ts'),
    importGbrain<any>(gut, 'src/core/sql-query.ts'), importGbrain<any>(gut, 'src/core/facts/meta-hook.ts'),
  ]);
  const { PGLiteEngine } = await importGbrain<any>(gut, 'src/core/pglite-engine.ts');
  const { PostgresEngine } = await importGbrain<any>(gut, 'src/core/postgres-engine.ts');
  let eng: any;
  const connect = async () => {
    eng = engine === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
    await eng.connect(engine === 'pglite' ? { engine: 'pglite', database_path: brain.pgPath } : { database_url: brain.dbUrl, poolSize: 8 });
  };
  await connect();
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(eng), transaction: (fn: any) => eng.transaction((tx: any) => fn(sqlQueryForEngine(tx))) });
  const tokens = new Map<string, string>();
  const token = async (client: string) => {
    if (!tokens.has(client)) { const c = brain.clients[client]!; tokens.set(client, (await provider().exchangeClientCredentials(c.id, c.secret)).access_token); }
    return tokens.get(client)!;
  };
  const call: Call = async (caller, op, args, session) => {
    let auth: any;
    try { auth = await provider().verifyAccessToken(await token(caller.client)); } catch (e) {
      const text = String(e instanceof Error ? e.message : e);
      if (DENIAL.test(text)) return { exposed: false, ok: false, error_code: /([a-z]+_[a-z_]+)/.exec(text)?.[1] ?? 'auth_refused', text };
      return { exposed: true, ok: false, error_code: 'harness_exception', text, harness: true };
    }
    const params = { ...args, ...(caller.extra ?? {}), ...(caller.acting_user ? { acting_user: caller.acting_user } : {}) };
    return withTimeout(dispatchToolCall(eng, op, params, {
      remote: true, transport: 'http', auth, sourceId: auth.sourceId, takesHoldersAllowList: auth.takesHoldersAllowList, sessionId: session, writeWaitMs: 30_000,
      ...(caller.actor !== undefined ? { actor: { header: caller.actor } } : {}),
      metaHook: (name: string, ctx: unknown) => getBrainHotMemoryMeta(name, ctx),
    }).then(toolResultText), TIMEOUT_MS['mcp-dispatch']);
  };
  const close = async () => { await eng.disconnect().catch(() => {}); };
  return { call, close, suspend: close, resume: async () => { await connect(); tokens.clear(); } };
}

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbrain-evals-person-isolation', version: '1' } };
let rpcId = 1;

async function startServer(gut: GbrainUnderTest, brain: Brain, fixedPort?: number): Promise<{ port: number; proc: ChildProcess; stop: () => Promise<void> }> {
  const port = fixedPort ?? await freePort(56600 + Math.floor(Math.random() * 300));
  const proc = spawn('bun', [join(gut.root, 'src/cli.ts'), 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), '--public-url', 'http://127.0.0.1:' + port], { env: brain.env, cwd: brain.home, stdio: ['ignore', 'pipe', 'pipe'] });
  const log: string[] = [];
  const keep = (d: Buffer) => { log.push(d.toString().replace(/gbrain_[a-z]{2}_[0-9a-f]+/g, '<redacted>')); if (log.length > 200) log.shift(); };
  proc.stdout?.on('data', keep); proc.stderr?.on('data', keep);
  for (const t0 = Date.now(); ;) {
    if (proc.exitCode !== null) throw new Error('serve --http exited: ' + log.slice(-5).join(' | '));
    try { const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2000) }); if (r.status < 500) break; } catch { /* not up */ }
    if (Date.now() - t0 > 120_000) throw new Error('serve --http did not come up: ' + log.slice(-5).join(' | '));
    await Bun.sleep(400);
  }
  const stop = async () => { proc.kill('SIGTERM'); for (let i = 0; i < 50 && proc.exitCode === null; i++) await Bun.sleep(100); if (proc.exitCode === null) proc.kill('SIGKILL'); await Bun.sleep(300); };
  return { port, proc, stop };
}

async function openHttp(gut: GbrainUnderTest, brain: Brain): Promise<TransportHandle & { port: () => number }> {
  let server = await startServer(gut, brain);
  const tokens = new Map<string, string>();
  const sessions = new Map<string, string>();
  const token = async (client: string) => {
    if (tokens.has(client)) return tokens.get(client)!;
    const c = brain.clients[client]!;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret, scope: 'read write', resource: 'http://127.0.0.1:' + server.port + '/mcp' });
    const res = await fetch('http://127.0.0.1:' + server.port + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000) });
    const raw = await res.text();
    let json: { access_token?: string } = {};
    try { json = JSON.parse(raw); } catch { /* not JSON */ }
    if (!json.access_token) throw new Error('token endpoint HTTP ' + res.status + ' for ' + client + ': ' + raw.replace(/gbrain_[a-z]{2}_[0-9a-f]+/g, '<redacted>').slice(0, 300));
    tokens.set(client, json.access_token);
    return json.access_token;
  };
  const post = async (bearer: string, headers: Record<string, string>, body: Record<string, unknown>, sid?: string) => {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + bearer, ...headers };
    if (sid) h['mcp-session-id'] = sid;
    const res = await fetch('http://127.0.0.1:' + server.port + '/mcp', { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS.http) });
    const text = await res.text();
    const hdrs = [...res.headers.entries()].map(([k, v]) => k + ': ' + v).join('\n');
    let msg: any = null;
    if ('id' in body) {
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        for (const d of text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())) { try { const m = JSON.parse(d); if (m.id === body.id) { msg = m; break; } } catch { /* skip */ } }
      } else { try { msg = JSON.parse(text); } catch { /* not JSON */ } }
    }
    return { status: res.status, text, hdrs, msg, sid: res.headers.get('mcp-session-id') };
  };
  const session = async (bearer: string, headers: Record<string, string>, key: string | null) => {
    if (key && sessions.has(key)) return sessions.get(key)!;
    const init = await post(bearer, headers, { jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: INIT });
    const sid = init.sid ?? '';
    if (init.msg?.result) await post(bearer, headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid || undefined);
    if (key) sessions.set(key, sid);
    return sid;
  };
  const call: Call = async (caller, op, args, sess) => withTimeout((async () => {
    let bearer: string;
    try { bearer = await token(caller.client); } catch (e) {
      const text = String(e instanceof Error ? e.message : e);
      return /HTTP 4\d\d/.test(text) ? { exposed: false, ok: false, error_code: 'token_refused', text } : { exposed: true, ok: false, error_code: 'harness_exception', text, harness: true };
    }
    const headers: Record<string, string> = caller.actor !== undefined ? { 'x-qm-actor': caller.actor } : {};
    const sid = await session(bearer, headers, sess.startsWith('cold:') ? null : caller.client + '|' + sess);
    const params = { ...args, ...(caller.extra ?? {}), ...(caller.acting_user ? { acting_user: caller.acting_user } : {}) };
    const r = await post(bearer, headers, { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: op, arguments: params } }, sid || undefined);
    const all = r.hdrs + '\n' + r.text;
    if (r.status === 429 || r.status >= 500) return { exposed: true, ok: false, error_code: 'harness_http_' + r.status, text: all, harness: true };
    if (!r.msg) return { exposed: !(r.status === 401 || r.status === 403), ok: false, error_code: 'http_' + r.status, text: all };
    if (r.msg.error) return { exposed: !/unknown tool|not found|method not found/i.test(JSON.stringify(r.msg.error)), ok: false, error_code: 'rpc_error', text: all };
    const o = toolResultText(r.msg.result ?? {});
    return { ...o, text: all };
  })(), TIMEOUT_MS.http);
  return {
    call, port: () => server.port,
    close: async () => { await server.stop(); },
    suspend: async () => { await server.stop(); },
    resume: async () => { server = await startServer(gut, brain, server.port); tokens.clear(); sessions.clear(); },
  };
}

/** CLI command and argv for an op, from its registry CLI hints; null when the CLI does not serve it. */
export function cliArgv(op: Operation, args: Record<string, unknown>): string[] | null {
  const hints = (op as { cliHints?: { name?: string; positional?: string[] } }).cliHints;
  if (!hints?.name || (op as { localOnly?: boolean }).localOnly) return null;
  const argv = [hints.name];
  const positional = hints.positional ?? [];
  for (const p of positional) if (args[p] !== undefined) argv.push(String(args[p]));
  for (const [k, v] of Object.entries(args)) {
    if (positional.includes(k) || v === undefined) continue;
    const flag = '--' + k.replace(/_/g, '-');
    if (typeof v === 'boolean') { if (v) argv.push(flag); }
    else argv.push(flag, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return [...argv, '--json'];
}

async function openCli(gut: GbrainUnderTest, brain: Brain, http: TransportHandle & { port: () => number }): Promise<TransportHandle> {
  const homes = new Map<string, NodeJS.ProcessEnv>();
  const thin = async (client: string): Promise<NodeJS.ProcessEnv> => {
    if (homes.has(client)) return homes.get(client)!;
    const dir = mkdtempSync(join(brain.work, 'thin-'));
    mkdirSync(join(dir, 'home'), { recursive: true });
    const env = { ...brain.env, GBRAIN_HOME: dir, HOME: join(dir, 'home') };
    const c = brain.clients[client]!;
    const base = 'http://127.0.0.1:' + http.port();
    const r = await brain.cli(['init', '--mcp-only', '--issuer-url', base, '--mcp-url', base + '/mcp', '--oauth-client-id', c.id, '--oauth-client-secret', c.secret, '--non-interactive'], undefined, env);
    if (r.code !== 0) throw new Error('thin-client init failed for ' + client + ': ' + (r.stdout + r.stderr).replace(/gbrain_[a-z]{2}_[0-9a-f]+/g, '<redacted>').slice(-400));
    homes.set(client, env);
    return env;
  };
  const ops = new Map<string, Operation>();
  const { operations } = await importGbrain<{ operations: Operation[] }>(gut, 'src/core/operations.ts');
  for (const o of operations) ops.set(o.name, o);
  const call: Call = async (caller, op, args) => withTimeout((async () => {
    const argv = cliArgv(ops.get(op)!, args);
    if (!argv) return { exposed: false, ok: false, error_code: 'not_cli', text: '' };
    const r = caller.client === 'host'
      ? await brain.cli([...argv, '--as', caller.as!])
      : await brain.cli(argv, undefined, await thin(caller.client));
    const text = r.stdout + '\n' + r.stderr;
    return { exposed: !DENIAL.test(text) || r.code === 0, ok: r.code === 0, error_code: r.code === 0 ? undefined : 'exit_' + r.code, text };
  })(), TIMEOUT_MS.cli);
  return { call, close: async () => {}, suspend: http.suspend, resume: http.resume };
}


// ─── People's writes ───────────────────────────────────────────────────

const WRITE_OK = /"status"\s*:\s*"(inserted|committed|applied|accepted|queued|pending|merged|duplicate|created|proposed|awaiting_owner)"/;

/** Fact ids and a request id from a write's response. */
export function writeIdsIn(text: string): { fact_ids: string[]; request_id: string | null } {
  const ids = new Set(factIdsInText(text));
  for (const m of text.matchAll(/"fact_ids"\s*:\s*\[([^\]]*)\]/g)) for (const x of m[1]!.split(',')) { const v = x.trim().replace(/"/g, ''); if (v) ids.add(v); }
  for (const m of text.matchAll(/"fact_id"\s*:\s*"?(\d+)/g)) ids.add(m[1]!);
  return { fact_ids: [...ids], request_id: /"request_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null };
}

export interface WriteRow { member: string; channel: string; ok: boolean; code?: string; sample?: string }
const ownerAttested = (m: PIMember, client = 'qm-dm'): Caller => ({ kind: 'owner-attested', as: m.id, client, actor: m.ext, label: 'owner-attested' });
const ownerKey = (m: PIMember): Caller => ({ kind: 'owner-key', as: m.id, client: 'key:' + m.id, label: 'owner-key' });

async function seedPeople(call: Call, world: PIWorld): Promise<{ fixture: Fixture; writes: WriteRow[] }> {
  const fixture: Fixture = { world, facts: new Map(), requests: new Map(), proposals: new Map(), idempotency: new Map(), public_fact_id: null, max_fact_id: 0 };
  const writes: WriteRow[] = [];
  const record = (m: PIMember, channel: string, o: Outcome) => {
    const ok = o.ok && WRITE_OK.test(o.text);
    writes.push({ member: m.id, channel, ok, ...(ok ? {} : { code: o.error_code ?? 'no_status', sample: o.text.slice(0, 600) }) });
    return writeIdsIn(o.text);
  };
  for (const m of world.members.filter(x => x.writes)) {
    const h = world.holdings.find(x => x.member === m.id)!;
    const key = randomUUID();
    fixture.idempotency.set(m.id, key);
    const mw = record(m, 'memory_write', await call(ownerAttested(m), 'memory_write', { facts: h.memory_write, idempotency_key: key }, 'seed'));
    const rk = record(m, 'remember_key', await call(ownerKey(m), 'remember', { fact: h.remember_key.fact, entity: h.remember_key.entity, provenance: 'member key' }, 'seed'));
    const ra = record(m, 'remember_about', await call(ownerAttested(m), 'remember', { fact: h.remember_about.fact, entity: h.remember_about.entity, provenance: 'attested' }, 'seed'));
    const pr = record(m, 'proposal', await call(ownerAttested(m), 'memory_propose', { kind: 'timeline', target: h.proposal.target, date: h.proposal.date, summary: h.proposal.summary, idempotency_key: randomUUID() }, 'seed'));
    fixture.facts.set(m.id, [...mw.fact_ids, ...rk.fact_ids, ...ra.fact_ids]);
    fixture.requests.set(m.id, [mw.request_id, rk.request_id, ra.request_id].filter((x): x is string => !!x));
    fixture.proposals.set(m.id, pr.request_id ? [pr.request_id] : []);
  }
  fixture.max_fact_id = Math.max(0, ...[...fixture.facts.values()].flat().map(Number).filter(Number.isFinite));
  return { fixture, writes };
}

/** Each person's channels as their owner reads them right after seeding: which canaries came back. */
async function readBack(call: Call, f: Fixture): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const m of f.world.members.filter(x => x.writes)) {
    const h = f.world.holdings.find(x => x.member === m.id)!;
    const seen = new Set<string>();
    const look = (o: Outcome) => { for (const [ch, c] of Object.entries(h.canaries)) if (o.text.includes(c)) seen.add(ch); };
    look(await call(ownerKey(m), 'get_page', { slug: 'memory/members/' + m.id }, 'readback'));
    look(await call(ownerKey(m), 'get_page', { slug: h.readable_by.slug }, 'readback'));
    look(await call(ownerKey(m), 'get_page', { slug: h.folder.slug }, 'readback'));
    look(await call(ownerKey(m), 'get_page', { slug: h.dm_source.slug, source_id: m.dm_source }, 'readback'));
    for (const id of f.proposals.get(m.id) ?? []) look(await call(ownerAttested(m), 'get_write_request', { request_id: id }, 'readback'));
    look(await call(ownerKey(m), 'get_timeline', { slug: h.proposal.target }, 'readback'));
    out.set(m.id, seen);
  }
  return out;
}

// ─── Probing ───────────────────────────────────────────────────────────

export type Condition = 'warm' | 'cold-concurrent' | 'after-cycle';
export interface Tally { probes: number; content: number; identifier: number; oracle: number; slip: number; write_slip: number; harness: number; signal: number; owner_hits: number; public_hits: number; refusals: number }
const zeroTally = (): Tally => ({ probes: 0, content: 0, identifier: 0, oracle: 0, slip: 0, write_slip: 0, harness: 0, signal: 0, owner_hits: 0, public_hits: 0, refusals: 0 });
export const gateTotal = (t: Tally) => t.content + t.identifier + t.oracle + t.slip + t.write_slip;

/** Callers with nobody to read as, whose every answer must be a refusal. */
export function mustRefuse(c: Caller): boolean {
  return c.kind === 'unbound' || c.kind === 'left' || (c.kind === 'attested-variant' && c.as === null) || c.label === 'attested-variant:acting-user-mismatch';
}

function ownerFor(c: Caller, p: PIMember): Caller {
  if (c.client === 'host') return { kind: 'owner-key', as: p.id, client: 'host', label: 'owner-host-as' };
  if (c.client === 'qm-dm' || c.client === 'qm-room') return { ...ownerAttested(p, c.client), ...(c.extra ? { extra: c.extra } : {}) };
  return ownerKey(p);
}

interface ProbeSpec { op: Operation; target: PIMember; kind: TargetKind; variant: string; args: Record<string, unknown>; ghost: Record<string, unknown> | null; twin: Record<string, unknown>; masks: string[]; caller: Caller }

const hash32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

/** Every probe for one cell and seed under a profile. */
export function planProbes(f: Fixture, ops: Operation[], transport: Transport, profile: Profile): ProbeSpec[] {
  const w = f.world;
  const targets = w.members.filter(m => m.writes);
  const out: ProbeSpec[] = [];
  const firstSeen = new Set<string>();
  ops.forEach((op, oi) => {
    const kinds = targetKindsFor(op);
    const people = profile === 'ci' ? [targets[oi % targets.length]!] : targets;
    for (const [pi, p] of people.entries()) {
      let tks = targetsFor(f, p).filter(t => kinds.has(t.protected.kind));
      if (profile === 'ci') tks = tks.slice(0, 1);
      const callers = callersFor(w, p, oi + pi, transport);
      for (const tk of tks) {
        const sid = 'probe';
        const base = argsFor(op, tk.protected, sid);
        const extra: Array<{ id: string; args: Record<string, unknown> }> = [];
        if ('source_id' in (op.params ?? {})) for (const s of [p.dm_source, '__all__']) if (base.source_id !== s) extra.push({ id: 'source_id=' + s, args: { ...base, source_id: s } });
        const variants = profile === 'ci' ? [{ id: 'base', args: base }] : [...variantsFor(op, base, 4), ...wideningVariants(op, base), ...extra];
        const ghostBase = tk.ghost ? argsFor(op, tk.ghost, sid) : null;
        const twinBase = argsFor(op, tk.twin, sid);
        for (const v of variants) {
          const over = Object.fromEntries(Object.entries(v.args).filter(([k, x]) => base[k] !== x && k !== 'source_id'));
          const srcOver = v.id.startsWith('source_id=') ? { source_id: v.args.source_id } : {};
          const dropped = Object.keys(base).filter(k => !(k in v.args));
          const apply = (a: Record<string, unknown>) => Object.fromEntries(Object.entries({ ...a, ...over, ...srcOver }).filter(([k]) => !dropped.includes(k)));
          const masks = [tk.protected.slug, tk.protected.fact_id, tk.protected.request_id, tk.protected.source_id, tk.ghost?.slug, tk.ghost?.fact_id, tk.ghost?.request_id, tk.ghost?.source_id, p.dm_source, w.members.find(m => m.id === w.ghost_member)!.dm_source].filter((x): x is string => !!x);
          const seenCallerKinds = new Set<CallerKind>();
          for (const caller of callers) {
            if (profile === 'ci' && seenCallerKinds.has(caller.kind)) continue;
            seenCallerKinds.add(caller.kind);
            const spec: ProbeSpec = { op, target: p, kind: tk.protected.kind, variant: v.id, args: v.args, ghost: ghostBase ? apply(ghostBase) : null, twin: apply(twinBase), masks, caller };
            if (profile === 'pilot') {
              const strat = op.name + '|' + caller.kind;
              const keep = !firstSeen.has(strat) || hash32(op.name + p.id + tk.protected.kind + v.id + caller.label) % 10 === 0;
              firstSeen.add(strat);
              if (!keep) continue;
            }
            out.push(spec);
          }
        }
      }
    }
  });
  return out;
}

export interface LeakRecord { cell: string; seed: number; condition: Condition; op: string; caller: string; target: string; kind: string; variant: string; contract: string; detail: string[]; args: Record<string, unknown>; response: string }

interface CellState {
  cell: CellId; seed: number; transport: Transport;
  total: Tally; byOp: Map<string, Tally>; byCaller: Map<string, Tally>; byCondition: Map<string, Tally>;
  served: Map<string, Map<string, Map<string, number>>>;
  ownerChannels: Map<string, Set<string>>;
  harnessByOp: Map<string, number>;
  leaks: LeakRecord[];
  golds: Map<string, Gold>;
  channelOf: Map<string, string>;
  publicMarkers: string[];
  ghostMember: string;
  /** Operations gbrain answers for a caller bound to nobody by design (requester-scope exempt); scanned, never slips. */
  scopeExempt: Set<string>;
}

function bump(s: CellState, op: string, caller: Caller, cond: Condition, k: keyof Tally, n = 1) {
  for (const [m, key] of [[s.byOp, op], [s.byCaller, caller.kind], [s.byCondition, cond]] as const) {
    if (!m.has(key)) m.set(key, zeroTally());
    m.get(key)![k] += n;
  }
  s.total[k] += n;
}

function noteServed(s: CellState, op: string, caller: Caller, o: Outcome) {
  const code = o.ok ? 'served' : o.exposed ? 'error:' + (o.error_code ?? 'error') : 'refused:' + (o.error_code ?? 'refused');
  if (!s.served.has(op)) s.served.set(op, new Map());
  const byKind = s.served.get(op)!;
  if (!byKind.has(caller.kind)) byKind.set(caller.kind, new Map());
  const m = byKind.get(caller.kind)!;
  m.set(code, (m.get(code) ?? 0) + 1);
}

/** Scan one response as read by a caller: every other person's canaries and identifiers. */
function scanAs(s: CellState, caller: Caller, sent: string, o: Outcome): { content: string[]; identifier: string[] } {
  const content: string[] = [], identifier: string[] = [];
  for (const [member, gold] of s.golds) {
    if (member === caller.as) continue;
    const hits = scan(o.text, gold, sent);
    for (const c of hits.content) content.push(member + ':' + (s.channelOf.get(c) ?? 'canary'));
    for (const i of hits.identifier) identifier.push(member + ':' + i);
  }
  return { content, identifier };
}


function account(s: CellState, spec: Pick<ProbeSpec, 'op' | 'target' | 'kind' | 'variant'>, caller: Caller, cond: Condition, args: Record<string, unknown>, o: Outcome, leakFile: string): { leaked: boolean } {
  const op = spec.op.name;
  bump(s, op, caller, cond, 'probes');
  noteServed(s, op, caller, o);
  if (o.harness) { bump(s, op, caller, cond, 'harness'); s.harnessByOp.set(op, (s.harnessByOp.get(op) ?? 0) + 1); return { leaked: false }; }
  const sent = JSON.stringify(args) + '|' + (caller.actor ?? '') + '|' + (caller.acting_user ?? '');
  const hits = scanAs(s, caller, sent, o);
  const record = (contract: string, detail: string[]) => {
    const r: LeakRecord = { cell: s.cell, seed: s.seed, condition: cond, op, caller: caller.label, target: spec.target.id, kind: spec.kind, variant: spec.variant, contract, detail, args, response: o.text.slice(0, 20_000) };
    s.leaks.push(r);
    appendFileSync(leakFile, JSON.stringify(r) + '\n');
  };
  if (hits.content.length) { bump(s, op, caller, cond, 'content'); record('content', hits.content); }
  if (hits.identifier.length) { bump(s, op, caller, cond, 'identifier'); record('identifier', hits.identifier); }
  if (mustRefuse(caller) && o.ok && o.exposed && !s.scopeExempt.has(op)) { bump(s, op, caller, cond, 'slip'); record('identity_slip', [o.error_code ?? 'answered']); }
  return { leaked: hits.content.length + hits.identifier.length > 0 };
}

const specKey = (p: ProbeSpec) => [p.op.name, p.target.id, p.kind, p.variant, p.caller.label].join('|');

async function runProbe(s: CellState, call: Call, p: ProbeSpec, cond: Condition, ctx: { leakFile: string; signalled: Set<string>; twins: Map<string, boolean> }): Promise<void> {
  const { caller, target } = p;
  const cold = cond === 'cold-concurrent';
  const session = cold ? 'cold:' + randomUUID() : cond + ':' + target.id + ':' + caller.client;
  let ownerHit = false;
  if (!cold && target.role !== 'left') {
    const owner = ownerFor(caller, target);
    const o = await call(owner, p.op.name, p.args, session);
    account(s, p, owner, cond, p.args, o, ctx.leakFile);
    const gold = s.golds.get(target.id)!;
    for (const c of gold.canaries) if (o.text.includes(c)) { ownerHit = true; s.ownerChannels.get(target.id)?.add(s.channelOf.get(c)!); }
    if (ownerHit) bump(s, p.op.name, caller, cond, 'owner_hits');
  }
  const o = await call(caller, p.op.name, p.args, session);
  account(s, p, caller, cond, p.args, o, ctx.leakFile);
  if (o.harness) return;
  const refused = !o.exposed;
  if (refused) bump(s, p.op.name, caller, cond, 'refusals');
  if (p.ghost && caller.as !== s.ghostMember) {
    const g = await call(caller, p.op.name, p.ghost, session);
    if (!g.harness && normalizeForOracle(o.text, p.masks) !== normalizeForOracle(g.text, p.masks)) {
      bump(s, p.op.name, caller, cond, 'oracle');
      const r: LeakRecord = { cell: s.cell, seed: s.seed, condition: cond, op: p.op.name, caller: caller.label, target: target.id, kind: p.kind, variant: p.variant, contract: 'existence_oracle', detail: [], args: { protected: p.args, ghost: p.ghost }, response: (o.text.slice(0, 10_000) + '\n<<<ghost>>>\n' + g.text.slice(0, 10_000)) };
      s.leaks.push(r); appendFileSync(ctx.leakFile, JSON.stringify(r) + '\n');
    }
  }
  const twinKey = [p.op.name, p.variant, caller.label, caller.as ?? '-', p.kind].join('|');
  let publicHit = ctx.twins.get(twinKey);
  if (publicHit === undefined && !cold) {
    const t = await call(caller, p.op.name, p.twin, session);
    account(s, p, caller, cond, p.twin, t, ctx.leakFile);
    publicHit = !t.harness && s.publicMarkers.some(m => t.text.includes(m));
    ctx.twins.set(twinKey, publicHit);
  }
  if (publicHit) bump(s, p.op.name, caller, cond, 'public_hits');
  const key = specKey(p);
  const signal = cold ? ctx.signalled.has(key) : ownerHit && (mustRefuse(caller) ? refused : !!publicHit);
  if (signal) { bump(s, p.op.name, caller, cond, 'signal'); ctx.signalled.add(key); }
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>, stop: () => boolean): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && !stop()) { const t = items[i++]!; await fn(t); } }));
}

// ─── Write-shaped reads ────────────────────────────────────────────────

/** A write's outcome as the plan compares it: accepted or refused, its status and its error code; fresh ids may differ. */
export function outcomeOf(o: Outcome): string {
  return [o.ok ? 'ok' : 'refused', /"status"\s*:\s*"([a-z_]+)"/.exec(o.text)?.[1] ?? '-', o.ok ? '-' : o.error_code ?? '-'].join('|');
}

async function hostEngine(gut: GbrainUnderTest, brain: Brain, engine: EngineKind): Promise<any> {
  const mod = await importGbrain<any>(gut, engine === 'pglite' ? 'src/core/pglite-engine.ts' : 'src/core/postgres-engine.ts');
  const eng = engine === 'pglite' ? new mod.PGLiteEngine() : new mod.PostgresEngine();
  await eng.connect(engine === 'pglite' ? { engine: 'pglite', database_path: brain.pgPath } : { database_url: brain.dbUrl, poolSize: 2 });
  return eng;
}

/** P's rows as the brain holds them: their pages, read on the host, volatile fields masked. */
async function snapshotRows(eng: any, f: Fixture, member: string): Promise<string> {
  {
    const m = f.world.members.find(x => x.id === member)!;
    const h = f.world.holdings.find(x => x.member === m.id)!;
    const rows = await eng.executeRaw('SELECT source_id, slug, compiled_truth, timeline, frontmatter::text AS fm, deleted_at FROM pages WHERE slug = ANY($1) ORDER BY source_id, slug', [['memory/members/' + m.id, h.readable_by.slug, h.folder.slug, h.dm_source.slug, h.proposal.target]]);
    const jobs = await eng.executeRaw('SELECT id::text AS id, status FROM minion_jobs WHERE id::text = ANY($1) ORDER BY id', [[...(f.requests.get(m.id) ?? []), ...(f.proposals.get(m.id) ?? [])]]).catch(() => []);
    return normalizeForOracle(JSON.stringify([rows, jobs]), []);
  }
}

/** Calls that write but answer with data, made as Q on P's ids and on ghost ids; each pair must answer alike. */
async function writeShaped(s: CellState, call: Call, f: Fixture, leakFile: string, snap: (member: string) => Promise<string>): Promise<{ pairs: number; changed: string[] }> {
  const changed: string[] = [];
  const w = f.world;
  const decoy = (nonce: string) => [{ fact: 'Decoy note ' + nonce + ' about the ' + w.topic + ' for the replay check', provenance: 'decoy' }];
  let pairs = 0;
  for (const [ti, p] of w.members.filter(m => m.writes).entries()) {
    const qs = w.members.filter(m => m.id !== p.id && m.role !== 'left' && m.id !== w.ghost_member);
    const q = qs[ti % qs.length]!;
    const h = w.holdings.find(x => x.member === p.id)!;
    const ghost = w.members.find(m => m.id === w.ghost_member)!;
    const facts = f.facts.get(p.id) ?? [];
    const reqs = [...(f.requests.get(p.id) ?? []), ...(f.proposals.get(p.id) ?? [])];
    const before = await snap(p.id);
    type Pair = [string, Record<string, unknown>, Record<string, unknown>, string[]];
    const casesFor = (na: string, nb: string): Pair[] => [
      ['memory_write', { facts: decoy(na), idempotency_key: f.idempotency.get(p.id)! }, { facts: decoy(nb), idempotency_key: randomUUID() }, [na, nb]],
      ...facts.map((id, i) => ['forget_fact', { id: Number(id), request_id: randomUUID() }, { id: f.max_fact_id + 1000 + i, request_id: randomUUID() }, [id, String(f.max_fact_id + 1000 + i)]] as Pair),
      ...facts.map((id, i) => ['forget', { id }, { id: String(f.max_fact_id + 1000 + i) }, [id, String(f.max_fact_id + 1000 + i)]] as Pair),
      ...reqs.flatMap(id => { const g = randomUUID(); return [['get_write_request', { request_id: id }, { request_id: g }, [id, g]], ['cancel_write_request', { request_id: id }, { request_id: g }, [id, g]]] as Pair[]; }),
      ...[[h.readable_by.slug, 'notes/' + ghost.id + '-' + w.topic.split(' ')[0]], [h.folder.slug, ghost.folder + w.topic.split(' ')[0] + '-plan'], ['memory/members/' + p.id, 'memory/members/' + ghost.id]].map(([a, b]) =>
        ['memory_propose', { kind: 'timeline', target: a, date: '2026-10-09', summary: 'Decoy checkpoint for the ' + w.topic, idempotency_key: randomUUID() }, { kind: 'timeline', target: b, date: '2026-10-09', summary: 'Decoy checkpoint for the ' + w.topic, idempotency_key: randomUUID() }, [a!, b!]] as Pair),
    ];
    for (const caller of [{ kind: 'attested-dm', as: q.id, client: 'qm-dm', actor: q.ext, label: 'attested-dm' }, { kind: 'member-key', as: q.id, client: 'key:' + q.id, label: 'member-key' }] as Caller[]) {
      for (const [opName, a, b, masks] of casesFor(randomUUID().slice(0, 8), randomUUID().slice(0, 8))) {
        const spec = { op: { name: opName } as Operation, target: p, kind: 'write_shaped' as TargetKind, variant: 'base' };
        const sess = 'write-shaped:' + caller.client;
        const oa = await call(caller, opName, a, sess);
        account(s, spec, caller, 'warm', a, oa, leakFile);
        const ob = await call(caller, opName, b, sess);
        account(s, spec, caller, 'warm', b, ob, leakFile);
        pairs++;
        if (oa.harness || ob.harness) continue;
        if (outcomeOf(oa) !== outcomeOf(ob)) {
          bump(s, opName, caller, 'warm', 'write_slip');
          const r: LeakRecord = { cell: s.cell, seed: s.seed, condition: 'warm', op: opName, caller: caller.label, target: p.id, kind: 'write_shaped', variant: 'base', contract: 'write_shaped_slip', detail: [], args: { protected: a, ghost: b }, response: oa.text.slice(0, 10_000) + '\n<<<ghost>>>\n' + ob.text.slice(0, 10_000) };
          s.leaks.push(r); appendFileSync(leakFile, JSON.stringify(r) + '\n');
        }
      }
    }
    const after = await snap(p.id);
    if (after !== before) { changed.push(p.id); s.total.write_slip++; appendFileSync(leakFile, JSON.stringify({ cell: s.cell, seed: s.seed, contract: 'rows_changed', target: p.id, before, after }) + '\n'); }
  }
  return { pairs, changed };
}


// ─── One cell ──────────────────────────────────────────────────────────

const WRITE_READS = ['think'];
const ATTEST_WRITES = ['think', 'memory_write', 'remember', 'memory_propose', 'forget_fact', 'forget', 'cancel_write_request'];
const CAP_MS: Record<Profile, Record<Transport, number>> = {
  full: { 'mcp-dispatch': 30 * 60_000, http: 60 * 60_000, cli: 60 * 60_000 },
  pilot: { 'mcp-dispatch': 30 * 60_000, http: 60 * 60_000, cli: 60 * 60_000 },
  ci: { 'mcp-dispatch': 12 * 60_000, http: 12 * 60_000, cli: 12 * 60_000 },
};

export interface ControlResult { probes: number; caught: number }
export interface CellResult {
  cell: CellId; seed: number; stops: StopCode[]; stop_detail: string[];
  total: Tally; by_op: Record<string, Tally>; by_caller: Record<string, Tally>; by_condition: Record<string, Tally>;
  served: Record<string, Record<string, Record<string, number>>>;
  writes: WriteRow[]; channels_read_back: Record<string, string[]>; channels_missing: string[];
  mandatory_without_signal: string[]; ops_planned: number; probes_planned: number; write_shaped_pairs: number;
  rows_changed: string[]; cycle: { exit: number | null; pages_with_canaries_elsewhere: number; not_covered: string[] };
  controls: { planted: ControlResult; misgrant: ControlResult };
  cap_reached: boolean; elapsed_ms: number; leaks: number; late_unbound_client: string; scope_exempt_ops: string[];
}

interface CellOptions { profile: Profile; pgAdminUrl: string | null; only: string[] | null; outDir: string; log: (s: string) => void }

async function runCell(gut: GbrainUnderTest, world: PIWorld, cell: CellId, o: CellOptions): Promise<CellResult> {
  const t0 = Date.now();
  const transport = cell.replace(/-(pglite|postgres)$/, '') as Transport;
  const engine: EngineKind = cell.endsWith('postgres') ? 'postgres' : 'pglite';
  const leakFile = join(o.outDir, 'leaks.jsonl');
  const { operations } = await importGbrain<{ operations: Operation[] }>(gut, 'src/core/operations.ts');
  const { attestableOp } = await importGbrain<{ attestableOp: (name: string, op: Operation) => boolean }>(gut, 'src/core/access/actor.ts');
  const { requiresRequesterScope } = await importGbrain<{ requiresRequesterScope: (op: Operation, auth: { scopes: string[] }) => boolean }>(gut, 'src/core/access/requester-scope.ts');
  const attestOps = operations.filter(op => attestableOp(op.name, op) && (!(op as { mutating?: boolean }).mutating || ATTEST_WRITES.includes(op.name))).map(op => op.name);
  const brain = await buildBrain(gut, world, engine, o.pgAdminUrl, attestOps, o.log);
  {
    // The brain has served several people for longer than the 14-day grace, and the unbound client predates that, so its
    // reads are refused (requester_scope_required) as on a long-running shared brain.
    const eng = await hostEngine(gut, brain, engine);
    try {
      const now = Math.floor(Date.now() / 1000);
      await eng.executeRaw("UPDATE config SET value = $1 WHERE key = 'access.serves_since'", [new Date((now - 15 * 86_400) * 1000).toISOString()]);
      await eng.executeRaw('UPDATE oauth_clients SET client_id_issued_at = $1 WHERE client_id = $2', [now - 16 * 86_400, brain.clients.unbound!.id]);
    } finally { await eng.disconnect().catch(() => {}); }
  }
  const handles: TransportHandle[] = [];
  const result: CellResult = {
    cell, seed: world.seed, stops: [], stop_detail: [], total: zeroTally(), by_op: {}, by_caller: {}, by_condition: {}, served: {}, writes: [], channels_read_back: {}, channels_missing: [],
    mandatory_without_signal: [], ops_planned: 0, probes_planned: 0, write_shaped_pairs: 0, rows_changed: [], cycle: { exit: null, pages_with_canaries_elsewhere: 0, not_covered: ['synthesize'] },
    controls: { planted: { probes: 0, caught: 0 }, misgrant: { probes: 0, caught: 0 } }, cap_reached: false, elapsed_ms: 0, leaks: 0, late_unbound_client: brain.unboundRefusal, scope_exempt_ops: [],
  };
  const stop = (code: StopCode, detail: string) => { if (!result.stops.includes(code)) result.stops.push(code); result.stop_detail.push(code + ': ' + detail); };
  try {
    let probe: TransportHandle, seedVia: TransportHandle;
    if (transport === 'mcp-dispatch') { probe = seedVia = await openDispatch(gut, brain, engine); handles.push(probe); }
    else {
      const http = await openHttp(gut, brain); handles.push(http); seedVia = http;
      probe = transport === 'http' ? http : await openCli(gut, brain, http);
    }
    const host = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (engine === 'postgres') return fn();
      await seedVia.suspend();
      try { return await fn(); } finally { await seedVia.resume(); }
    };
    const seeded = await seedPeople(seedVia.call, world);
    result.writes = seeded.writes;
    const f = seeded.fixture;
    if (seeded.writes.some(w => !w.ok)) { stop('PI_WRITE_FAILED', seeded.writes.filter(w => !w.ok).map(w => w.channel + '=' + w.code).join(', ')); return result; }
    const readback = await readBack(seedVia.call, f);
    // A pending proposal's text is shown only to the brain owner, on the host (gbrain memory-proposals show).
    await host(async () => {
      for (const m of world.members.filter(x => x.writes)) {
        const c = world.holdings.find(h => h.member === m.id)!.canaries.proposal;
        for (const id of f.proposals.get(m.id) ?? []) if ((await brain.cli(['memory-proposals', 'show', id])).stdout.includes(c)) readback.get(m.id)?.add('proposal');
      }
    });
    const left = world.members.find(m => m.role === 'left')!;
    await host(() => brain.must('member disable', ['access', 'member', 'disable', left.id]));

    const s: CellState = {
      cell, seed: world.seed, transport, total: result.total, byOp: new Map(), byCaller: new Map(), byCondition: new Map(), served: new Map(),
      ownerChannels: new Map(world.members.filter(m => m.writes).map(m => [m.id, new Set(readback.get(m.id) ?? [])])), harnessByOp: new Map(), leaks: [],
      golds: new Map(world.members.filter(m => m.writes).map(m => [m.id, goldFor(f, m.id)])),
      channelOf: new Map(world.holdings.flatMap(h => Object.entries(h.canaries).map(([ch, c]) => [c, ch] as [string, string]))),
      publicMarkers: world.public_markers, ghostMember: world.ghost_member,
      scopeExempt: new Set(operations.filter(op => !requiresRequesterScope(op, { scopes: ['read', 'write'] })).map(op => op.name)),
    };
    result.scope_exempt_ops = [...s.scopeExempt].sort();
    const readOps = operations.filter(op => !(op as { mutating?: boolean }).mutating || WRITE_READS.includes(op.name));
    let ops = transport === 'cli' ? readOps.filter(op => (MANDATORY_CLI as readonly string[]).includes(op.name) && cliArgv(op, {}) !== null) : readOps;
    if (o.only) ops = ops.filter(op => o.only!.includes(op.name));
    result.ops_planned = ops.length;
    const deadline = t0 + CAP_MS[o.profile][transport];
    const late = () => { if (Date.now() > deadline) result.cap_reached = true; return result.cap_reached; };
    const ctx = { leakFile, signalled: new Set<string>(), twins: new Map<string, boolean>() };
    const specs = planProbes(f, ops, transport, o.profile);
    result.probes_planned = specs.length;
    o.log('[pi] ' + cell + ' seed ' + world.seed + ': ' + ops.length + ' operations, ' + specs.length + ' probes planned');
    const remote = specs.filter(p => p.caller.client !== 'host');
    for (const p of remote) { if (late()) break; await runProbe(s, probe.call, p, 'warm', ctx); }
    const hostAs = specs.filter(p => p.caller.client === 'host');
    if (hostAs.length && !late()) await host(async () => { for (const p of hostAs) { if (late()) break; await runProbe(s, probe.call, p, 'warm', ctx); } });
    if (transport !== 'cli' && o.profile !== 'ci' && !late()) {
      const mixed = [...remote].sort((a, b) => hash32(specKey(a)) - hash32(specKey(b)));
      await pool(mixed, 8, p => runProbe(s, probe.call, p, 'cold-concurrent', ctx), late);
    }
    if (transport !== 'cli' && !late()) {
      const snap = (member: string) => host(async () => { const eng = await hostEngine(gut, brain, engine); try { return await snapshotRows(eng, f, member); } finally { await eng.disconnect().catch(() => {}); } });
      const ws = await writeShaped(s, seedVia.call, f, leakFile, snap);
      result.write_shaped_pairs = ws.pairs;
      result.rows_changed = ws.changed;
    }
    if (!late()) {
      const elsewhere: Array<{ member: string; slug: string; source_id: string }> = [];
      await host(async () => {
        const d = await brain.cli(['dream', '--json']);
        result.cycle.exit = d.code;
        const eng = await hostEngine(gut, brain, engine);
        try {
          for (const m of world.members.filter(x => x.writes)) {
            const h = world.holdings.find(x => x.member === m.id)!;
            const own = new Set(['memory/members/' + m.id, h.readable_by.slug, h.folder.slug, m.dm_source + '|' + h.dm_source.slug]);
            for (const c of Object.values(h.canaries)) {
              const rows = await eng.executeRaw('SELECT source_id, slug FROM pages WHERE deleted_at IS NULL AND (position($1 in compiled_truth) > 0 OR position($1 in timeline) > 0 OR position($1 in frontmatter::text) > 0)', [c]) as Array<{ source_id: string; slug: string }>;
              for (const row of rows) if (!own.has(row.slug) && !own.has(row.source_id + '|' + row.slug)) elsewhere.push({ member: m.id, slug: row.slug, source_id: row.source_id });
            }
          }
        } finally { await eng.disconnect().catch(() => {}); }
      });
      result.cycle.pages_with_canaries_elsewhere = elsewhere.length;
      const mandatory = ops.filter(op => (transport === 'cli' ? MANDATORY_CLI : MANDATORY_OPS as readonly string[]).includes(op.name));
      for (const p of planProbes(f, mandatory, transport, 'ci')) { if (late()) break; if (p.caller.client === 'host') continue; await runProbe(s, probe.call, p, 'after-cycle', ctx); }
      const getPage = operations.find(op => op.name === 'get_page')!;
      for (const e of elsewhere) {
        const owner = world.members.find(m => m.id === e.member)!;
        for (const q of world.members.filter(m => m.id !== e.member && m.role !== 'left')) {
          for (const c of (transport === 'cli' ? [ownerKey(q)] : [ownerKey(q), ownerAttested(q)]).map(c => ({ ...c, kind: c.kind === 'owner-key' ? 'member-key' : 'attested-dm', label: 'cycle-page:' + c.kind } as Caller))) {
            const args = { slug: e.slug, source_id: e.source_id };
            account(s, { op: getPage, target: owner, kind: 'cycle_page' as TargetKind, variant: 'base' }, c, 'after-cycle', args, await probe.call(c, 'get_page', args, 'after-cycle'), leakFile);
          }
        }
      }
    }
    // Must-fail controls, after every counted probe.
    const p1 = world.members.find(m => m.role === 'p1')!;
    const h1 = world.holdings.find(h => h.member === p1.id)!;
    const gold1 = s.golds.get(p1.id)!;
    const caught = (c: Caller, t: Outcome) => c.as !== p1.id && gold1.canaries.some(x => t.text.includes(x));
    const tw1 = world.topic.split(' ')[0]!;
    const planted = 'notes/planted-' + tw1;
    await host(() => brain.must('plant control page', ['put', planted, '--source-id', world.team_source], '---\ntype: note\ntitle: Planted ' + tw1 + '\n---\n# Planted ' + tw1 + '\n\nPlanted control note about the ' + world.topic + ' ' + h1.canaries.folder + '.\n'));
    for (const c of callersFor(world, p1, 0, transport).filter(c => !mustRefuse(c) && c.client !== 'host')) {
      for (const [op, args] of [['get_page', { slug: planted }], ['search', { query: 'planted ' + tw1 }]] as Array<[string, Record<string, unknown>]>) {
        const t = await probe.call(c, op, args, 'control');
        result.controls.planted.probes++;
        if (caught(c, t)) result.controls.planted.caught++;
      }
    }
    const q = world.members.find(m => m.role === 'p3')!;
    await host(async () => {
      const id = await brain.register('misgrant', ['--member', q.id]);
      await brain.must('rescope misgrant', ['auth', 'rescope', '--client', id, '--member', q.id, '--sources', [world.team_source, p1.dm_source].join(',')]);
    });
    const mis: Caller = { kind: 'member-key', as: q.id, client: 'misgrant', label: 'control:misgrant' };
    for (const args of [{ slug: h1.dm_source.slug, source_id: p1.dm_source }, { slug: h1.dm_source.slug }]) {
      const t = await probe.call(mis, 'get_page', args, 'control');
      result.controls.misgrant.probes++;
      if (caught(mis, t)) result.controls.misgrant.caught++;
    }
    // Verdicts.
    result.by_op = Object.fromEntries(s.byOp); result.by_caller = Object.fromEntries(s.byCaller); result.by_condition = Object.fromEntries(s.byCondition);
    result.served = Object.fromEntries([...s.served].map(([op, m]) => [op, Object.fromEntries([...m].map(([k, v]) => [k, Object.fromEntries(v)]))]));
    result.leaks = s.leaks.length;
    for (const [m, chs] of s.ownerChannels) { result.channels_read_back[m] = [...chs].sort(); for (const ch of PI_CHANNELS) if (!chs.has(ch)) result.channels_missing.push(m + ':' + ch); }
    const mandatory = transport === 'cli' ? MANDATORY_CLI as readonly string[] : MANDATORY_OPS as readonly string[];
    result.mandatory_without_signal = mandatory.filter(op => ops.some(x => x.name === op) && !(s.byOp.get(op)?.signal));
    if (gateTotal(result.total) > 0) stop('PI_LEAK', 'gate total ' + gateTotal(result.total));
    if ([...s.harnessByOp.values()].some(n => n > MAX_HARNESS_ERRORS_PER_OP)) stop('PI_HARNESS', 'more than ' + MAX_HARNESS_ERRORS_PER_OP + ' harness errors on an operation');
    if (result.cap_reached) stop('PI_HARNESS', 'profile time cap reached');
    if (!result.controls.planted.caught) stop('PI_CONTROL', 'planted canary not caught');
    if (!result.controls.misgrant.caught) stop('PI_CONTROL', 'operator misgrant not caught');
    if (result.mandatory_without_signal.length || result.channels_missing.length) stop('PI_COVERAGE', result.mandatory_without_signal.length + ' mandatory operations without signal, ' + result.channels_missing.length + ' channels not read back');
    return result;
  } catch (e) {
    if (e instanceof StopError) stop(e.code, e.message); else stop('PI_HARNESS', (e instanceof Error ? e.message : String(e)).replace(/gbrain_[a-z]{2}_[0-9a-f]+/g, '<redacted>').slice(0, 400));
    return result;
  } finally {
    for (const h of handles.reverse()) await h.close().catch(() => {});
    await brain.drop().catch(() => {});
    result.elapsed_ms = Date.now() - t0;
  }
}


// ─── Run, receipt and exit ─────────────────────────────────────────────

export interface RunOptions { profile: Profile; seeds: number[]; cells: CellId[]; pgAdminUrl: string | null; only: string[] | null; outDir: string; attestation: Attestation | null; gbrainSpec: string | null; log?: (s: string) => void }

/** The stop codes a set of cells raises, most severe first. */
export function runStops(cells: Pick<CellResult, 'stops'>[]): StopCode[] {
  const all = new Set(cells.flatMap(c => c.stops));
  return STOP_ORDER.filter(c => all.has(c));
}

/** What a failing run may say in public: the total and FAIL, nothing about where. */
export function publicData(cells: CellResult[], stops: StopCode[]): Record<string, unknown> {
  const gate = cells.reduce((n, c) => n + gateTotal(c.total), 0);
  if (stops.includes('PI_LEAK')) return { verdict: 'fail', gate_total: gate };
  const rule3 = (n: number) => (n ? Math.round((3 / n) * 1e6) / 1e6 : null);
  return {
    gate_total: gate,
    stops,
    cells: cells.map(c => ({
      cell: c.cell, seed: c.seed, stops: c.stops, stop_detail: c.stop_detail, probes: c.total.probes, probes_planned: c.probes_planned, ops: c.ops_planned, elapsed_ms: c.elapsed_ms, cap_reached: c.cap_reached,
      tally: c.total, by_caller: c.by_caller, by_condition: c.by_condition,
      ops_with_signal: Object.entries(c.by_op).filter(([, t]) => t.signal > 0).map(([op]) => op).sort(),
      ops_without_signal: Object.entries(c.by_op).filter(([, t]) => t.signal === 0).map(([op]) => op).sort(),
      mandatory: Object.fromEntries((c.cell.startsWith('cli') ? MANDATORY_CLI as readonly string[] : MANDATORY_OPS as readonly string[]).map(op => [op, { probes: c.by_op[op]?.probes ?? 0, signal: c.by_op[op]?.signal ?? 0, rule_of_three: rule3(c.by_op[op]?.probes ?? 0) }])),
      mandatory_without_signal: c.mandatory_without_signal, channels_missing: c.channels_missing, writes_failed: c.writes.filter(w => !w.ok).length,
      late_unbound_client: c.late_unbound_client, write_shaped_pairs: c.write_shaped_pairs, rows_changed: c.rows_changed.length, cycle: c.cycle, controls: c.controls, served: c.served,
    })),
  };
}

export async function runPersonIsolation(o: RunOptions): Promise<{ receipt: Receipt; file: string; stops: StopCode[]; cells: CellResult[] }> {
  const log = o.log ?? ((s: string) => console.error(s));
  const startedAt = new Date().toISOString();
  mkdirSync(o.outDir, { recursive: true });
  writeFileSync(join(o.outDir, 'leaks.jsonl'), '');
  const gut = resolveGbrainUnderTest(o.gbrainSpec);
  const cells: CellResult[] = [];
  for (const seed of o.seeds) {
    const world = generatePersonWorld(seed);
    for (const cell of o.cells) {
      const r = await runCell(gut, world, cell, { profile: o.profile, pgAdminUrl: o.pgAdminUrl, only: o.only, outDir: o.outDir, log });
      cells.push(r);
      log('[pi] ' + cell + ' seed ' + seed + ': ' + (r.stops.includes('PI_LEAK') ? 'FAIL' : r.total.probes + ' probes, ' + (r.stops.length ? r.stops.join(',') : 'ok')) + ' in ' + Math.round(r.elapsed_ms / 1000) + 's');
    }
  }
  const stops = runStops(cells);
  writeFileSync(join(o.outDir, 'detail.json'), JSON.stringify({ profile: o.profile, seeds: o.seeds, cells }, null, 2));
  const probes = cells.reduce((n, c) => n + c.total.probes, 0);
  const harness = cells.reduce((n, c) => n + c.total.harness, 0);
  const valid = !stops.some(s => STOP_EXIT[s] === 3 || s === 'PI_POSTGRES_UNAVAILABLE' || s === 'PI_CONTROL');
  const receipt: Receipt = {
    ...noModelSpend('keyless: no model and no paid request (no provider key in any process)'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: PI_CATEGORY,
    run_status: valid ? 'completed' : 'error',
    ...(valid ? { verdict: stops.length === 0 ? 'pass' as const : 'fail' as const } : {}),
    n_total: probes,
    n_scored: probes - harness,
    completion_rate: probes ? (probes - harness) / probes : 0,
    errors: [],
    publishable: valid && o.profile === 'full' && !!o.attestation,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    accounting: { planned: probes, attempted: probes, scored: probes - harness, errors: harness, misses: 0, source: 'runner' },
    resolved_config: { profile: o.profile, seeds: o.seeds, cells: o.cells, generator_version: PI_GENERATOR_VERSION, preregistration: PI_PREREGISTRATION, only: o.only, timeouts_ms: TIMEOUT_MS, not_covered: ['synthesize', 'vector and hybrid search (keyless)'] },
    hashes: Object.fromEntries(o.seeds.map(s => ['world_' + s, generatePersonWorld(s).ledger_hash])),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: publicData(cells, stops),
  };
  const file = join(o.outDir, 'receipt.json');
  writeReceipt(file, (o.attestation ? { ...receipt, preregistration_attestation: o.attestation } : receipt) as Receipt);
  return { receipt, file, stops, cells };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const fail = (code: StopCode, line: string) => { console.error(code + ': ' + line); process.exit(STOP_EXIT[code]); };
  const visible = strippedKeysIn(process.env);
  if (visible.length) fail('PI_PROVIDER_KEY_VISIBLE', 'unset ' + visible.join(', ') + '; the run is keyless');
  const profile = (flag('--profile') ?? 'pilot') as Profile;
  if (!['full', 'pilot', 'ci'].includes(profile)) { console.error('--profile must be full, pilot or ci'); process.exit(64); }
  const seeds = flag('--seeds')?.split(',').map(Number) ?? (profile === 'full' ? [...PI_COUNTED_SEEDS] : [PI_DEFAULT_SEED]);
  const cells = (flag('--cells')?.split(',') ?? (profile === 'ci' ? ['mcp-dispatch-pglite', 'http-pglite'] : [...CELLS])) as CellId[];
  const unknown = cells.filter(c => !(CELLS as readonly string[]).includes(c));
  if (unknown.length) { console.error('unknown cells: ' + unknown.join(', ')); process.exit(64); }
  const pgAdminUrl = flag('--pg-url') ?? process.env.PI_PG_URL ?? null;
  if (cells.some(c => c.endsWith('postgres')) && !pgAdminUrl) fail('PI_POSTGRES_UNAVAILABLE', 'start Postgres on 127.0.0.1 and pass --pg-url');
  const attest = flag('--attest');
  const outDir = flag('--output') ?? join(process.cwd(), 'eval/reports', PI_CATEGORY, new Date().toISOString().replace(/[:.]/g, '-'));
  runPersonIsolation({ profile, seeds, cells, pgAdminUrl, only: flag('--only')?.split(',') ?? null, outDir, attestation: attest ? attestPreregistration(attest) : null, gbrainSpec: gbrainSpecFrom(argv) })
    .then(({ receipt, file, stops }) => {
      if (stops.includes('PI_LEAK')) { console.error('PI_LEAK: gate total ' + (receipt.data as { gate_total: number }).gate_total + ': FAIL'); process.exit(STOP_EXIT.PI_LEAK); }
      if (argv.includes('--json')) console.log(JSON.stringify(receipt.data, null, 2));
      console.error('[pi] receipt ' + file + (stops.length ? '; ' + stops.join(', ') : '; pass'));
      process.exit(stops.length ? STOP_EXIT[stops[0]!] : 0);
    })
    .catch(err => { console.error('PI_HARNESS: ' + String(err instanceof Error ? err.message : err).replace(/gbrain_[a-z]{2}_[0-9a-f]+/g, '<redacted>').slice(0, 500)); process.exit(STOP_EXIT.PI_HARNESS); });
}

