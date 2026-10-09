/**
 * The gbrain-query connector: gbrain's agent read path (`query`), called in
 * process as a trusted local caller, with every request frozen by name and
 * every delivery recorded by value.
 *
 * Plan: docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md, C0 ("One
 * frozen hit list per question, with a live parity check"). README.md beside
 * this file explains the wire requests and the records for other waves.
 *
 *   freeze    one chunk-unit `query` call: `return_unit: 'chunk'`, no
 *             `token_budget`, so the evidence plan resolves to null and no
 *             chunk budget applies; the ranked rows are the frozen hit list.
 *   deliver   `assembleEvidenceForHits` on the frozen list (or its first N
 *             hits) with an explicit `return_unit` and budget.
 *   live      one `query` call with `return_unit: 'auto'` and an explicit
 *             budget, compared with the assembled delivery on every field a
 *             reader consumes (`parity`).
 *
 * Settings reach gbrain through the brain's config table, the channel the
 * `query` handler reads; `checkPins` refuses a key gbrain does not register or
 * a value that did not land.
 */
import { createHash } from 'node:crypto';

export const CONNECTOR_VERSION = 'gbrain-query-connector-v1';

/** The query-path pins (plan C0 "settings"); applied on top of gbrain's `balanced` defaults. */
export const QUERY_PATH_PINS: Readonly<Record<string, string>> = Object.freeze({
  'search.cache.enabled': 'false',
  'decide.provider': 'none',
  'search.crag_escalation': 'false',
  'search.crag_think': 'false',
  'search.track_retrieval': 'false',
});

/**
 * The named wire requests. Each is the exact parameter object passed to the
 * `query` handler; nothing else is added on the way.
 *
 *   frozen-chunk    the frozen hit list (plan null, no budget)
 *   native-default  the agent's default call: neither return_unit nor token_budget
 *   auto-budget     return_unit 'auto' with an explicit token_budget
 *   live-parity     auto-budget plus use_cache false (the plan's live check)
 *   bare-budget     token_budget without return_unit: gbrain's legacyBudget
 *                   turns an implied auto into chunk (G7 record)
 */
export type WireName = 'frozen-chunk' | 'native-default' | 'auto-budget' | 'live-parity' | 'bare-budget';
export const WIRE_NAMES: readonly WireName[] = ['frozen-chunk', 'native-default', 'auto-budget', 'live-parity', 'bare-budget'];

export function wireRequest(name: WireName, query: string, opts: { limit: number; budget?: number }): Record<string, unknown> {
  const base = { query, limit: opts.limit, expand: false };
  const budget = () => {
    if (!(Number.isInteger(opts.budget) && (opts.budget as number) > 0)) throw new Error(`wire request ${name} needs a positive integer budget`);
    return opts.budget as number;
  };
  switch (name) {
    case 'frozen-chunk': return { ...base, return_unit: 'chunk' };
    case 'native-default': return { ...base };
    case 'auto-budget': return { ...base, return_unit: 'auto', token_budget: budget() };
    case 'live-parity': return { ...base, return_unit: 'auto', token_budget: budget(), use_cache: false };
    case 'bare-budget': return { ...base, token_budget: budget() };
  }
}

/** The `assembleEvidenceForHits` input for a delivery variant (`budget` null omits it: gbrain's own default applies). */
export function assembleRequest(hits: FrozenHit[], unit: ReturnUnit, budget: number | null): Record<string, unknown> {
  return { hits, return_unit: unit, ...(budget === null ? {} : { budget_tokens: budget }), caller: { remote: false } };
}

export type ReturnUnit = 'chunk' | 'window' | 'section' | 'page' | 'auto';
export interface FrozenHit { source_id: string; slug: string; chunk_id: number }

/** One row of the frozen ranked list, as the chunk-unit call returned it. */
export interface FrozenRow extends FrozenHit {
  rank: number;
  chunk_index: number;
  title: string;
  type: string | null;
  chunk_text: string;
  effective_date: string | null;
  rerank_score: number | null;
  score: number | null;
}

/** The gbrain modules the connector calls; load them with `loadConnectorModules` so `--gbrain` selects the build. */
export interface ConnectorModules {
  operations: Array<{ name: string; handler: (ctx: unknown, p: Record<string, unknown>) => Promise<unknown> }>;
  assembleEvidenceForHits: (engine: unknown, input: Record<string, unknown>) => Promise<{ results: DeliveredRow[]; delivery: DeliveryMeta | null; unresolved: number[] }>;
  evidenceFingerprint: (rows: DeliveredRow[]) => string;
  knownConfigKeys: readonly string[];
  decideConfigKeys: readonly string[];
  semanticResultCacheAvailable: () => boolean;
}

export async function loadConnectorModules(load: <T>(rel: string) => Promise<T>): Promise<ConnectorModules> {
  const [ops, ev, cfg, dcfg, qc] = await Promise.all([
    load<{ operations: ConnectorModules['operations'] }>('src/core/operations.ts'),
    load<{ assembleEvidenceForHits: ConnectorModules['assembleEvidenceForHits']; evidenceFingerprint: ConnectorModules['evidenceFingerprint'] }>('src/core/search/evidence-delivery.ts'),
    load<{ KNOWN_CONFIG_KEYS: readonly string[] }>('src/core/config.ts'),
    load<{ DECIDE_CONFIG_KEYS: readonly string[] }>('src/core/ai/decide/config.ts'),
    load<{ semanticResultCacheAvailable: () => boolean }>('src/core/search/query-cache.ts'),
  ]);
  return { operations: ops.operations, assembleEvidenceForHits: ev.assembleEvidenceForHits, evidenceFingerprint: ev.evidenceFingerprint,
    knownConfigKeys: cfg.KNOWN_CONFIG_KEYS, decideConfigKeys: dcfg.DECIDE_CONFIG_KEYS, semanticResultCacheAvailable: qc.semanticResultCacheAvailable };
}

export interface DeliveredEvidence { unit: string; chunk_ids: number[]; match_spans: Array<{ chunk_id: number; start: number; end: number }>; tokens: number; truncated: boolean; fallback_reason?: string; reason?: string; unmapped_chunk_ids?: number[] }
export interface DeliveredRow { slug: string; source_id?: string; title?: string; type?: string | null; chunk_text: string; chunk_id: number; chunk_index?: number; effective_date?: string | Date | null; rerank_score?: number; score?: number; delivered?: DeliveredEvidence }
export interface DeliveryMeta { requested_unit: string; applied_unit: string; return_window: number; budget_tokens: number; budget_used: number; tokens_delivered: number; tokenizer: string; blocks: number; dropped: number; dropped_reasons: Record<string, number>; fallbacks: string[]; budget_clamped?: unknown }

/** A pinned key's check: registered in gbrain and read back equal from the brain the handler reads. */
export interface PinCheck { key: string; value: string; registered: 'known' | 'decide' | 'unknown'; read_back: string | null; applied: boolean }

/** What a delivery handed over, by value: the GBRA-60 record (unit per block, budget, overrun, spill) plus the evidence bytes. */
export interface DeliveryRecord {
  source: 'assemble' | 'query';
  request: Record<string, unknown>;
  requested_unit: string | null;
  applied_unit: string | null;
  budget_tokens: number | null;
  budget_explicit: boolean;
  budget_used: number | null;
  tokens_delivered: number | null;
  tokenizer: string | null;
  overrun_tokens: number;
  over_budget: boolean;
  blocks: number;
  units: Record<string, number>;
  reasons: Record<string, number>;
  spilled_blocks: number;
  spilled_pages: number;
  passthrough_blocks: number;
  dropped: number;
  dropped_reasons: Record<string, number>;
  fallbacks: string[];
  unresolved: number;
  hit_count: number;
  distinct_sessions_in: number;
  distinct_sessions_out: number;
  fingerprint: string;
  evidence_chars: number;
  evidence_utf8_bytes: number;
  evidence_sha256: string;
  per_block: Array<{ slug: string; unit: string; reason: string | null; tokens: number; truncated: boolean; fallback_reason: string | null; chunk_ids: number[]; effective_date: string | null }>;
}

/** A delivered block in the shape the harness renders. */
export interface Block { rank: number; slug: string; source_id: string; title: string; text: string; unit: string; chunk_ids: number[]; effective_date: string | null }

export interface Delivery { record: DeliveryRecord; blocks: Block[]; rows: DeliveredRow[] }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const dateOf = (v: unknown): string | null => v == null ? null : v instanceof Date ? v.toISOString() : String(v);
const count = (xs: Array<string | null | undefined>) => xs.reduce<Record<string, number>>((m, x) => { const k = x ?? 'none'; m[k] = (m[k] ?? 0) + 1; return m; }, {});

/** The bytes of the delivered evidence a reader would see (titles and text, in order). */
export function evidenceBytes(rows: readonly { title?: string; chunk_text: string }[]): { chars: number; utf8_bytes: number; sha256: string } {
  const text = rows.map(r => `${r.title ?? ''}\n${r.chunk_text}`).join('\n\n');
  return { chars: text.length, utf8_bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) };
}

/** The final reader prompt's bytes (recorded per row beside the prompt hash). */
export function readerBytes(prompt: string): { chars: number; utf8_bytes: number; sha256: string } {
  return { chars: prompt.length, utf8_bytes: Buffer.byteLength(prompt, 'utf8'), sha256: sha256(prompt) };
}

export function deliveryRecord(source: DeliveryRecord['source'], request: Record<string, unknown>, rows: DeliveredRow[], meta: DeliveryMeta | null, fingerprint: string, extra: { unresolved?: number; hits: readonly { slug: string }[] }): DeliveryRecord {
  const budgetParam = source === 'assemble' ? request.budget_tokens : request.token_budget;
  const per_block = rows.map(r => ({ slug: r.slug, unit: r.delivered?.unit ?? 'chunk', reason: r.delivered?.reason ?? null, tokens: r.delivered?.tokens ?? 0, truncated: r.delivered?.truncated ?? false,
    fallback_reason: r.delivered?.fallback_reason ?? null, chunk_ids: r.delivered?.chunk_ids ?? [r.chunk_id], effective_date: dateOf(r.effective_date) }));
  const spilled = per_block.filter(b => b.reason === 'conversation_over_budget');
  const used = meta?.budget_used ?? null, budget = meta?.budget_tokens ?? null;
  const bytes = evidenceBytes(rows);
  return {
    source, request: stripHits(request), requested_unit: meta?.requested_unit ?? null, applied_unit: meta?.applied_unit ?? null, budget_tokens: budget, budget_explicit: typeof budgetParam === 'number',
    budget_used: used, tokens_delivered: meta?.tokens_delivered ?? null, tokenizer: meta?.tokenizer ?? null,
    overrun_tokens: used !== null && budget !== null ? Math.max(0, used - budget) : 0, over_budget: used !== null && budget !== null && used > budget,
    blocks: rows.length, units: count(per_block.map(b => b.unit)), reasons: count(per_block.map(b => b.reason)),
    spilled_blocks: spilled.length, spilled_pages: new Set(spilled.map(b => b.slug)).size, passthrough_blocks: per_block.filter(b => b.reason === 'not_conversation').length,
    dropped: meta?.dropped ?? 0, dropped_reasons: meta?.dropped_reasons ?? {}, fallbacks: meta?.fallbacks ?? [], unresolved: extra.unresolved ?? 0,
    hit_count: extra.hits.length, distinct_sessions_in: new Set(extra.hits.map(h => h.slug)).size, distinct_sessions_out: new Set(rows.map(r => r.slug)).size,
    fingerprint, evidence_chars: bytes.chars, evidence_utf8_bytes: bytes.utf8_bytes, evidence_sha256: bytes.sha256, per_block,
  };
}

/** Hits are recorded once per row (the frozen list); a request record keeps their count, not a second copy. */
function stripHits(request: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(request.hits)) return request;
  const { hits, ...rest } = request;
  return { ...rest, hits: { count: (hits as unknown[]).length } };
}

export function toBlocks(rows: DeliveredRow[]): Block[] {
  return rows.map((r, i) => ({ rank: i + 1, slug: r.slug, source_id: r.source_id ?? 'default', title: r.title ?? '', text: r.chunk_text ?? '', unit: r.delivered?.unit ?? 'chunk',
    chunk_ids: r.delivered?.chunk_ids ?? [r.chunk_id], effective_date: dateOf(r.effective_date) }));
}

/** Every field a reader consumes, block by block, then the totals. `dates` compares effective_date too (off at c5fb0201, whose assembly drops it). */
export function parity(live: Delivery, assembled: Delivery, opts: { dates?: boolean } = {}): { equal: boolean; fingerprint_equal: boolean; mismatches: string[]; live_dated_blocks: number; assembled_dated_blocks: number } {
  const mismatches: string[] = [];
  const a = live.rows, b = assembled.rows;
  if (a.length !== b.length) mismatches.push(`blocks ${a.length} != ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    const fields: Array<[string, unknown, unknown]> = [
      ['slug', x.slug, y.slug], ['title', x.title ?? '', y.title ?? ''], ['text', x.chunk_text, y.chunk_text], ['unit', x.delivered?.unit, y.delivered?.unit],
      ['chunk_ids', x.delivered?.chunk_ids, y.delivered?.chunk_ids], ['spans', x.delivered?.match_spans, y.delivered?.match_spans], ['tokens', x.delivered?.tokens, y.delivered?.tokens],
      ['truncated', x.delivered?.truncated, y.delivered?.truncated], ['fallback', x.delivered?.fallback_reason ?? null, y.delivered?.fallback_reason ?? null], ['reason', x.delivered?.reason ?? null, y.delivered?.reason ?? null],
      ...(opts.dates ? [['effective_date', dateOf(x.effective_date), dateOf(y.effective_date)] as [string, unknown, unknown]] : []),
    ];
    for (const [k, u, v] of fields) if (JSON.stringify(u) !== JSON.stringify(v)) mismatches.push(`block ${i + 1} ${k}`);
  }
  for (const k of ['budget_used', 'tokens_delivered', 'budget_tokens', 'applied_unit', 'requested_unit'] as const) if (live.record[k] !== assembled.record[k]) mismatches.push(`total ${k}`);
  if (JSON.stringify(live.record.fallbacks) !== JSON.stringify(assembled.record.fallbacks)) mismatches.push('total fallbacks');
  return { equal: mismatches.length === 0, fingerprint_equal: live.record.fingerprint === assembled.record.fingerprint, mismatches,
    live_dated_blocks: a.filter(r => r.effective_date != null).length, assembled_dated_blocks: b.filter(r => r.effective_date != null).length };
}

/** Response meta the query handler emitted on its retrieval channel, reduced to the fields a receipt keeps. */
export function retrievalMetaRecord(meta: Record<string, unknown> | null): Record<string, unknown> {
  if (!meta) return { present: false };
  const pick = (k: string) => (k in meta ? { [k]: meta[k] } : {});
  return { present: true, ...pick('decide'), ...pick('crag'), ...pick('degraded'), ...pick('cache'), ...pick('delivery'), ...pick('vector_enabled'), ...pick('expansion_applied'), ...pick('retrieved_count'), ...pick('autocut'), ...pick('token_budget') };
}

/**
 * One brain, one local operation context. Methods never mutate gbrain config
 * after `checkPins`; every call records its request object as sent.
 */
export class GbrainQueryConnector {
  private lastMeta: Record<string, unknown> | null = null;
  private readonly ctx: Record<string, unknown>;
  constructor(readonly mods: ConnectorModules, readonly engine: any) {
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    this.ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger, dryRun: false, remote: false, sourceId: 'default',
      emitResponseMeta: (k: string, m: Record<string, unknown>) => { if (k === 'retrieval') this.lastMeta = m; } };
  }

  /** Each pin must be a key gbrain registers (KNOWN_CONFIG_KEYS, or a decide.* key in DECIDE_CONFIG_KEYS) and must read back equal. */
  async checkPins(pins: Record<string, string>): Promise<PinCheck[]> {
    const out: PinCheck[] = [];
    for (const [key, value] of Object.entries(pins)) {
      const registered = this.mods.knownConfigKeys.includes(key) ? 'known' : key.startsWith('decide.') && this.mods.decideConfigKeys.includes(key) ? 'decide' : 'unknown';
      let read_back: string | null = null;
      try { read_back = (await this.engine.getConfig(key)) ?? null; } catch { read_back = null; }
      out.push({ key, value, registered, read_back, applied: read_back === value });
    }
    const bad = out.filter(p => p.registered === 'unknown' || !p.applied);
    if (bad.length) throw new Error(`query-path pins refused: ${bad.map(p => `${p.key}=${p.value} (${p.registered === 'unknown' ? 'not a registered gbrain key' : `read back ${JSON.stringify(p.read_back)}`})`).join('; ')}`);
    return out;
  }

  /** gbrain's semantic result cache at runtime: `disabled` in every build in scope (query-cache.ts). */
  cacheStatus(): 'disabled' | 'available' { return this.mods.semanticResultCacheAvailable() ? 'available' : 'disabled'; }

  async query(params: Record<string, unknown>): Promise<{ rows: DeliveredRow[]; meta: Record<string, unknown> | null; service_ms: number }> {
    const op = this.mods.operations.find(o => o.name === 'query');
    if (!op) throw new Error('this gbrain build has no query operation');
    this.lastMeta = null;
    const t0 = performance.now();
    const rows = await op.handler(this.ctx, params) as DeliveredRow[];
    return { rows, meta: this.lastMeta, service_ms: performance.now() - t0 };
  }

  /** The frozen hit list. Refuses when the response carries a delivery (the plan was not null) or the request named a budget. */
  async freeze(query: string, limit: number): Promise<{ request: Record<string, unknown>; rows: FrozenRow[]; meta: Record<string, unknown>; service_ms: number; rerank_present: boolean }> {
    const request = wireRequest('frozen-chunk', query, { limit });
    if ('token_budget' in request) throw new Error('the frozen-list request must not carry a token_budget');
    const res = await this.query(request);
    if (res.meta && 'delivery' in res.meta) throw new Error('the chunk-unit query resolved an evidence plan (delivery meta present); the frozen list would not be the ranked hits');
    if (res.rows.some(r => r.delivered)) throw new Error('the chunk-unit query returned delivered blocks; the frozen list would not be the ranked hits');
    const rows: FrozenRow[] = res.rows.map((r, i) => ({ rank: i + 1, source_id: r.source_id ?? 'default', slug: r.slug, chunk_id: r.chunk_id, chunk_index: r.chunk_index ?? 0, title: r.title ?? '',
      type: r.type ?? null, chunk_text: r.chunk_text ?? '', effective_date: dateOf(r.effective_date), rerank_score: typeof r.rerank_score === 'number' ? r.rerank_score : null, score: typeof r.score === 'number' ? r.score : null }));
    return { request, rows, meta: retrievalMetaRecord(res.meta), service_ms: res.service_ms, rerank_present: rows.some(r => r.rerank_score !== null) };
  }

  /** Delivery on frozen hits through assembleEvidenceForHits (gbrain's documented seam for a frozen candidate list). */
  async deliver(hits: readonly FrozenRow[], unit: ReturnUnit, budget: number | null): Promise<Delivery> {
    const frozen: FrozenHit[] = hits.map(h => ({ source_id: h.source_id, slug: h.slug, chunk_id: h.chunk_id }));
    const request = assembleRequest(frozen, unit, budget);
    const out = await this.mods.assembleEvidenceForHits(this.engine, request);
    const record = deliveryRecord('assemble', request, out.results, out.delivery, this.mods.evidenceFingerprint(out.results), { unresolved: out.unresolved.length, hits });
    return { record, blocks: toBlocks(out.results), rows: out.results };
  }

  /** A live `query` call under a named wire request, recorded the same way as an assembled delivery. */
  async live(name: WireName, query: string, limit: number, budget?: number): Promise<Delivery & { meta: Record<string, unknown>; service_ms: number }> {
    const request = wireRequest(name, query, { limit, budget });
    const res = await this.query(request);
    const delivery = (res.meta?.delivery ?? null) as DeliveryMeta | null;
    const record = deliveryRecord('query', request, res.rows, delivery, this.mods.evidenceFingerprint(res.rows), { hits: res.rows });
    return { record, blocks: toBlocks(res.rows), rows: res.rows, meta: retrievalMetaRecord(res.meta), service_ms: res.service_ms };
  }
}
