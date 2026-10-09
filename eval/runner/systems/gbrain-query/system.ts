/**
 * GbrainQuerySystem (`--system gbrain-query`): gbrain behind the
 * `MemorySystem` interface through its agent read path, the `query`
 * operation, using the connector beside this file. Cell B of the budgeted
 * delivery plan (docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md, C0).
 *
 * Pages are the shootout's conversation pages (same ingest as
 * `gbrain-shootout`). The stage comes from the policy settings
 * (`--policy-setting stage=...`), so a readiness probe, which carries only
 * the capability record's settings, is a plain frozen-list call:
 *
 *   stage=freeze   the frozen hit list per question (one chunk-unit `query`
 *                  call); with `grid=<lo>:<hi>:<step>` also `auto` deliveries
 *                  on the list at every grid budget, handed to the runner's
 *                  sizing hook (`sizingDeliveries`), which renders them with
 *                  real session dates and keeps only token counts.
 *   stage=deliver  no new frozen call: the list comes from a finished freeze
 *                  cell (`--frozen-from <retrievals/rows.ndjson>`). Delivers
 *                  every preregistered variant through assembleEvidenceForHits
 *                  and makes one live `query` parity call at `b_native`.
 *
 * `variants=e2` selects the budgeted delivery E2 set instead (preregistration
 * docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2-preregistration.md),
 * which needs a gbrain with `search.auto_packing` (gbrain#6367):
 *
 *   stage=freeze   the frozen hit list alone (no grid);
 *   stage=size     no new frozen call: on the frozen list, the E2 sizing
 *                  deliveries at every budget of `grid` (the 8,000-token
 *                  renderings) and `grid16` (the 16,000-token sweep), for the
 *                  runner's sizing hook; `size_set=primary` keeps only the four
 *                  packings on the 8,000-token grid (the sets read only at
 *                  `b_pseudo`). Like deliver, it may import with hash vectors;
 *   stage=deliver  every E2 variant through assembleEvidenceForHits with the
 *                  per-call `auto_packing` (`deliver_set=primary`: only the
 *                  four packings at `b_pseudo`), plus the guard 1 record (no
 *                  budget, every packing, evidence bytes compared); no live
 *                  call, so it may import with hash vectors (delivery reads
 *                  no vector) once every frozen chunk's text is checked;
 *   stage=live     a fresh frozen list, then `live_reps` rounds of one live
 *                  `query` per packing at `b_pseudo` with `search.auto_packing`
 *                  switched through the config table, each compared with the
 *                  assembled delivery on the fresh and on the frozen list, with
 *                  handler and reranker time recorded (guard 9).
 *
 * Items are always the frozen list as chunk items (the `query-rehydrated`
 * recipe reads them); deliveries travel in the typed `accounting` record.
 * A missing rerank on a reranked build is retried up to `rerank_attempts`
 * times; a list still unreranked keeps gbrain's fallback and is counted.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderSessionPage } from '../../memory-qa/corpus.ts';
import { GbrainBrain, sourceOfSlug, type GbrainModules } from '../gbrain.ts';
import { SystemError, type CapabilityRecord, type Item, type PublicQuestion, type RetrievalPolicy, type RetrieveResult, type SessionInput } from '../types.ts';
import { AUTO_PACKINGS, CONNECTOR_VERSION, GbrainQueryConnector, parity, QUERY_PATH_PINS, type AutoPacking, type ConnectorModules, type Delivery, type FrozenRow, type PinCheck, type ReturnUnit } from './connector.ts';

export const QUERY_LIMIT = 25;
export const PREFIX_HITS = 5;

/** The delivery variants of the deliver stage, by name (plan E1 table). `budget` names a policy setting, or null for gbrain's default. */
export const DELIVERY_VARIANTS = {
  'auto-b_native': { unit: 'auto', budget: 'b_native', prefix: null },
  'auto-b_pseudo': { unit: 'auto', budget: 'b_pseudo', prefix: null },
  'auto-default': { unit: 'auto', budget: null, prefix: null },
  'auto-l5-b_pseudo': { unit: 'auto', budget: 'b_pseudo', prefix: PREFIX_HITS },
} as const;
export type DeliveryVariant = keyof typeof DELIVERY_VARIANTS;

interface E2Variant { unit: ReturnUnit; budget: 'b_pseudo' | 'b_native' | 'b16_pseudo'; prefix: number | null; packing: AutoPacking | null }
const capped = (budget: E2Variant['budget']): Record<string, E2Variant> =>
  Object.fromEntries(AUTO_PACKINGS.map(p => [`${p}-${budget}`, { unit: 'auto', budget, prefix: null, packing: p } as E2Variant]));
/**
 * The E2 delivery variants (preregistration, "Cells and calls"): the four packings on the 25-hit list at `b_pseudo`
 * (the primary), `b_native` (the slice link) and `b16_pseudo` (the 16,000-token sweep); `off` on the first five hits
 * and today's `window` unit at `b_pseudo` as existing-knob references. `off` is passed explicitly: the build's default
 * packing for an explicit budget is `cap_only`.
 */
export const E2_DELIVERY_VARIANTS: Readonly<Record<string, E2Variant>> = Object.freeze({
  ...capped('b_pseudo'),
  'off-l5-b_pseudo': { unit: 'auto', budget: 'b_pseudo', prefix: PREFIX_HITS, packing: 'off' },
  'window-b_pseudo': { unit: 'window', budget: 'b_pseudo', prefix: null, packing: null },
  ...capped('b_native'),
  ...capped('b16_pseudo'),
});
/** Sizing deliveries per E2 grid: the 8,000-token grid sizes `b_pseudo` and `b_native`, the 16,000-token grid `b16_pseudo`. */
export const E2_SIZING = {
  b8: { ...Object.fromEntries(AUTO_PACKINGS.map(p => [p, { unit: 'auto', prefix: null, packing: p }])), 'off-l5': { unit: 'auto', prefix: PREFIX_HITS, packing: 'off' }, window: { unit: 'window', prefix: null, packing: null } },
  b16: Object.fromEntries(AUTO_PACKINGS.map(p => [p, { unit: 'auto', prefix: null, packing: p }])),
} as Readonly<Record<'b8' | 'b16', Record<string, { unit: ReturnUnit; prefix: number | null; packing: AutoPacking | null }>>>;
export const LIVE_REPS = 3;

/**
 * The frozen-list memo key: the namespace's first ingested source id (opaque
 * source ids are stable across runs; namespaces are salted per run) plus the
 * question text and date, as the system sees them.
 */
export const memoKey = (anchor: string, q: PublicQuestion) => createHash('sha256').update(`${anchor}\u0000${q.text}\u0000${q.query_time ?? ''}`).digest('hex');

export interface FrozenRecord { memo_key: string; request: Record<string, unknown>; rows: FrozenRow[]; meta: Record<string, unknown>; rerank_present: boolean; rerank_attempts: number; hit_count: number; distinct_sessions: number }

/** A grid budget's raw deliveries, rendered and counted by the runner's sizing hook. */
export interface SizingDeliveries { budget: number; full: Delivery; prefix: Delivery }
/** An E2 grid budget's raw deliveries per sizing variant (E2_SIZING), rendered and counted by the runner's sizing hook. */
export interface SizingDeliveriesE2 { grid: 'b8' | 'b16'; budget: number; variants: Record<string, Delivery> }

export class GbrainQuerySystem extends GbrainBrain {
  readonly name = 'gbrain-query';
  private connector: GbrainQueryConnector | null = null;
  private pinChecks: PinCheck[] = [];
  private frozenMemo: Map<string, FrozenRecord> | null = null;
  private anchor: string | null = null;
  /** Raw grid deliveries of the last freeze-stage retrieval, for the runner's sizing hook (never written to rows). */
  lastSizing: SizingDeliveries[] | null = null;
  /** Raw E2 grid deliveries of the last freeze-stage retrieval (`variants=e2`), for the runner's sizing hook (never written to rows). */
  lastSizingE2: SizingDeliveriesE2[] | null = null;
  readonly fidelity = { embedding_deferred_pages: 0, rerank_missing_queries: 0, reranked_queries: 0 };

  constructor(mods: GbrainModules, private conn: ConnectorModules, settings: Record<string, string>, identity: Record<string, unknown>, private opts: { frozenFrom?: string | null; rerankExpected: boolean }) {
    super(mods, { ...settings, ...QUERY_PATH_PINS }, identity);
  }

  protected async opened(engine: any): Promise<void> {
    const c = new GbrainQueryConnector(this.conn, engine);
    this.pinChecks = await c.checkPins({ ...QUERY_PATH_PINS });
    this.connector = c;
  }

  async capabilities(): Promise<CapabilityRecord> {
    return {
      system: 'gbrain-query', protocol: 1, versions: { package: String(this.identity.version ?? 'unknown'), commit: String(this.identity.commit ?? 'unknown'), image: null, lock_sha256: null, vendor_benchmark_code: null, connector: CONNECTOR_VERSION },
      configs: { common: { model_roles: { embedder: 'openai:text-embedding-3-large', dims: 1536 }, notes: 'gbrain balanced defaults plus the query-path pins' } },
      time: 'native', provenance: { status: 'exact', mechanism: 'each block cites its page; one page per session' }, delete: 'native',
      readiness: 'synchronous: import returns after the page and its vectors are written', namespace: 'one in-memory PGLite brain per namespace (truncated between namespaces)',
      parallel_namespaces: false, streaming: 'disabled', telemetry_off: [], agent_surface: { kind: 'none' },
      retrieval_policies: { 'fixed-evidence': { settings: { limit: QUERY_LIMIT } }, 'vendor-default': { settings: { limit: QUERY_LIMIT } } },
      query_path_pins: { ...QUERY_PATH_PINS }, measured_path: 'trusted local caller (remote: false); remote lean rows and safe-chunk rules are not exercised',
      deviations_from_vendor_code: ['expand: false (agent default true), matching the shootout retrieval'],
    };
  }

  async reset(ns: string): Promise<void> { this.anchor = null; await super.reset(ns); }

  async ingestSession(ns: string, session: SessionInput, eventTime: string | null) {
    this.anchor ??= session.source_id;
    return super.ingestSession(ns, session, eventTime);
  }

  private key(q: PublicQuestion): string {
    if (!this.anchor) throw new SystemError('invalid_request', 'gbrain-query needs an ingested namespace before retrieval');
    return memoKey(this.anchor, q);
  }

  protected page(session: SessionInput, eventTime: string | null): string {
    return renderSessionPage({ id: session.source_id, date: eventTime ?? undefined, turns: session.turns.map(t => ({ speaker: t.speaker, content: t.content })) }, { as: 'conversation' });
  }

  private memo(): Map<string, FrozenRecord> {
    if (this.frozenMemo) return this.frozenMemo;
    if (!this.opts.frozenFrom) throw new SystemError('invalid_request', 'stage=deliver needs --frozen-from <freeze cell retrievals/rows.ndjson>');
    const m = new Map<string, FrozenRecord>();
    for (const line of readFileSync(this.opts.frozenFrom, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { accounting?: { frozen?: FrozenRecord } };
      const f = row.accounting?.frozen;
      if (f?.memo_key) m.set(f.memo_key, f);
    }
    this.frozenMemo = m;
    return m;
  }

  /** The frozen list, retried while a reranked build returns no rerank score. */
  private async freezeOnce(q: PublicQuestion, limit: number, attempts: number): Promise<{ frozen: FrozenRecord; service_ms: number }> {
    let last: Awaited<ReturnType<GbrainQueryConnector['freeze']>> | null = null;
    let n = 0, ms = 0;
    for (; n < attempts; n++) {
      last = await this.connector!.freeze(q.text, limit);
      ms += last.service_ms;
      if (!this.opts.rerankExpected || !last.rows.length || last.rerank_present) break;
    }
    if (this.opts.rerankExpected && last!.rows.length) last!.rerank_present ? this.fidelity.reranked_queries++ : this.fidelity.rerank_missing_queries++;
    const rows = last!.rows;
    return { service_ms: ms, frozen: { memo_key: this.key(q), request: last!.request, rows, meta: last!.meta, rerank_present: last!.rerank_present, rerank_attempts: Math.min(n + 1, attempts),
      hit_count: rows.length, distinct_sessions: new Set(rows.map(r => r.slug)).size } };
  }

  private items(rows: readonly FrozenRow[]): Item[] {
    return rows.map((r, i) => {
      const src = sourceOfSlug(r.slug);
      return { id: `${r.slug}#${r.chunk_id}`, rank: i + 1, type: 'chunk', text: r.chunk_text, source_ids: src ? [src] : [], valid_from: null, valid_to: null, provenance_status: src ? 'exact' : 'unavailable' };
    });
  }

  /**
   * Re-resolve frozen chunk ids in this brain by (slug, chunk_index), so a re-ingested brain with different serial ids
   * still delivers the frozen chunks; `text_mismatch` counts re-resolved chunks whose text differs from the frozen row's
   * outside gbrain's output redaction (`redacted` counts those equal once redacted spans are allowed).
   */
  private async remap(rows: readonly FrozenRow[]): Promise<{ rows: FrozenRow[]; remapped: number; missing: number; text_mismatch: number; redacted: number }> {
    const slugs = [...new Set(rows.map(r => r.slug))];
    const found = await this.engine.executeRaw(`SELECT p.slug, c.id AS chunk_id, c.chunk_index, c.chunk_text FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = ANY($1::text[])`, [slugs]) as Array<{ slug: string; chunk_id: number; chunk_index: number; chunk_text: string }>;
    const byKey = new Map(found.map(f => [`${f.slug}\u0000${f.chunk_index}`, f]));
    let remapped = 0, missing = 0, text_mismatch = 0, redacted = 0;
    const out = rows.map(r => {
      const f = byKey.get(`${r.slug}\u0000${r.chunk_index}`);
      if (f === undefined) { missing++; return r; }
      const id = Number(f.chunk_id);
      if (id !== r.chunk_id) remapped++;
      if (f.chunk_text !== r.chunk_text) redactedMatch(r.chunk_text, f.chunk_text) ? redacted++ : text_mismatch++;
      return { ...r, chunk_id: id };
    });
    return { rows: out, remapped, missing, text_mismatch, redacted };
  }

  async retrieve(ns: string, question: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> {
    this.live(ns);
    const s = policy.settings ?? {};
    const limit = Number(s.limit ?? QUERY_LIMIT);
    if (!Number.isInteger(limit) || limit < 1) throw new SystemError('invalid_request', 'limit must be a positive integer');
    const stage = s.stage === undefined ? null : String(s.stage);
    const attempts = Number(s.rerank_attempts ?? 3);
    const e2 = s.variants === 'e2';
    if (s.variants !== undefined && !e2 && s.variants !== 'e1') throw new SystemError('invalid_request', `variants must be e1 or e2 (got ${s.variants})`);
    const base = { kind: 'gbrain-query', version: 1, connector: CONNECTOR_VERSION, stage, ...(e2 ? { variants: 'e2' } : {}), pins: this.pinChecks, cache_status: this.connector!.cacheStatus() };
    this.lastSizing = null;
    this.lastSizingE2 = null;

    if (e2 && stage === 'freeze') {
      if (s.grid || s.grid16) throw new SystemError('invalid_request', 'variants=e2 sizes on the frozen list (stage=size), not in the freeze');
      const { frozen, service_ms } = await this.freezeOnce(question, limit, attempts);
      return { items: this.items(frozen.rows), applied_settings: { call: frozen.request, stage }, truncated: false, service_ms, accounting: { ...base, frozen } };
    }
    if (e2 && stage === 'size') {
      const { frozen, rows, remapped, redacted } = await this.frozenFor(question);
      const primary = s.size_set === 'primary';
      if (s.size_set !== undefined && !primary && s.size_set !== 'all') throw new SystemError('invalid_request', `size_set must be all or primary (got ${s.size_set})`);
      const t0 = performance.now();
      const sizing: SizingDeliveriesE2[] = [];
      for (const [grid, spec] of [['b8', s.grid], ['b16', primary ? undefined : s.grid16]] as const) {
        if (!spec) continue;
        for (const b of parseGrid(String(spec))) {
          const variants: Record<string, Delivery> = {};
          for (const [name, v] of Object.entries(E2_SIZING[grid])) {
            if (primary && !(AUTO_PACKINGS as readonly string[]).includes(name)) continue;
            variants[name] = await this.connector!.deliver(v.prefix === null ? rows : rows.slice(0, v.prefix), v.unit, b, v.packing);
          }
          sizing.push({ grid, budget: b, variants });
        }
      }
      if (!sizing.length) throw new SystemError('invalid_request', 'stage=size needs grid (and grid16 for the sweep)');
      this.lastSizingE2 = sizing;
      return { items: this.items(frozen.rows), applied_settings: { stage, variants: 'e2', grid: s.grid ?? null, grid16: primary ? null : s.grid16 ?? null, size_set: primary ? 'primary' : 'all' }, truncated: false,
        service_ms: performance.now() - t0, accounting: { ...base, frozen, remapped_chunk_ids: remapped, redacted_chunks: redacted } };
    }
    if (e2 && stage === 'deliver') return this.deliverE2(question, s, limit, base);
    if (e2 && stage === 'live') return this.liveE2(question, s, limit, attempts, base);
    if (stage === 'live') throw new SystemError('invalid_request', 'stage=live needs variants=e2');

    if (stage === null || stage === 'freeze') {
      const { frozen, service_ms } = await this.freezeOnce(question, limit, stage === null ? 1 : attempts);
      const grid = stage === 'freeze' && s.grid ? parseGrid(String(s.grid)) : [];
      if (grid.length) {
        const sizing: SizingDeliveries[] = [];
        for (const b of grid) sizing.push({ budget: b, full: await this.connector!.deliver(frozen.rows, 'auto', b), prefix: await this.connector!.deliver(frozen.rows.slice(0, PREFIX_HITS), 'auto', b) });
        this.lastSizing = sizing;
      }
      return { items: this.items(frozen.rows), applied_settings: { call: frozen.request, stage: stage ?? 'probe' }, truncated: false, service_ms, accounting: { ...base, frozen } };
    }

    if (stage !== 'deliver') throw new SystemError('invalid_request', `stage must be freeze or deliver (got ${stage})`);
    const frozen = this.memo().get(this.key(question));
    if (!frozen) throw new SystemError('invalid_request', 'no frozen list for this question in --frozen-from; the deliver stage never makes a new frozen call');
    const budgets: Record<string, number> = {};
    for (const k of ['b_native', 'b_pseudo'] as const) {
      const v = Number(s[k]);
      if (!Number.isInteger(v) || v <= 0) throw new SystemError('invalid_request', `stage=deliver needs ${k} (the preregistered budget)`);
      budgets[k] = v;
    }
    const mapped = await this.remap(frozen.rows);
    if (mapped.missing) throw new SystemError('invalid_request', `${mapped.missing} frozen chunks are not in this brain; the re-ingest differs from the freeze`);
    const deliveries: Record<string, Delivery & { variant: Record<string, unknown> }> = {};
    for (const [name, v] of Object.entries(DELIVERY_VARIANTS)) {
      const hits = v.prefix === null ? mapped.rows : mapped.rows.slice(0, v.prefix);
      const b = v.budget === null ? null : budgets[v.budget];
      deliveries[name] = { ...await this.connector!.deliver(hits, v.unit, b), variant: { ...v, budget_value: b } };
    }
    const t0 = performance.now();
    const live = await this.connector!.live('live-parity', question.text, limit, budgets.b_native);
    const service_ms = performance.now() - t0;
    const check = parity(live, deliveries['auto-b_native']);
    return { items: this.items(frozen.rows), applied_settings: { stage, budgets, live_call: live.record.request }, truncated: false, service_ms,
      accounting: { ...base, frozen, remapped_chunk_ids: mapped.remapped, budgets,
        deliveries: Object.fromEntries(Object.entries(deliveries).map(([k, d]) => [k, { variant: d.variant, record: d.record, blocks: d.blocks }])),
        live: { record: live.record, meta: live.meta, parity: check, effective_dates: live.rows.map(r => r.effective_date == null ? null : String(r.effective_date instanceof Date ? r.effective_date.toISOString() : r.effective_date)) } } };
  }

  /** The frozen list of a question from `--frozen-from`, re-resolved in this brain; refuses missing chunks and chunk text that differs from the freeze. */
  private async frozenFor(question: PublicQuestion): Promise<{ frozen: FrozenRecord; rows: FrozenRow[]; remapped: number; redacted: number }> {
    const frozen = this.memo().get(this.key(question));
    if (!frozen) throw new SystemError('invalid_request', 'no frozen list for this question in --frozen-from; this stage never makes a new frozen call for the frozen list');
    const mapped = await this.remap(frozen.rows);
    if (mapped.missing) throw new SystemError('invalid_request', `${mapped.missing} frozen chunks are not in this brain; the re-ingest differs from the freeze`);
    if (mapped.text_mismatch) throw new SystemError('invalid_request', `${mapped.text_mismatch} re-resolved chunks differ in text from the freeze; the re-ingest differs from the freeze`);
    return { frozen, rows: mapped.rows, remapped: mapped.remapped, redacted: mapped.redacted };
  }

  /** E2 deliver stage: every E2 variant on the frozen list, and the guard 1 record (no budget, each packing, bytes compared). */
  private async deliverE2(question: PublicQuestion, s: Record<string, unknown>, limit: number, base: { kind: string; version: number } & Record<string, unknown>): Promise<RetrieveResult> {
    const primary = s.deliver_set === 'primary';
    if (s.deliver_set !== undefined && !primary && s.deliver_set !== 'all') throw new SystemError('invalid_request', `deliver_set must be all or primary (got ${s.deliver_set})`);
    const budgets: Partial<Record<E2Variant['budget'], number>> = primary ? { b_pseudo: budgetSetting(s, 'b_pseudo') }
      : { b_pseudo: budgetSetting(s, 'b_pseudo'), b_native: budgetSetting(s, 'b_native'), b16_pseudo: budgetSetting(s, 'b16_pseudo') };
    const { frozen, rows, remapped, redacted } = await this.frozenFor(question);
    const t0 = performance.now();
    const deliveries: Record<string, { variant: Record<string, unknown>; record: Delivery['record']; blocks: Delivery['blocks'] }> = {};
    for (const [name, v] of Object.entries(E2_DELIVERY_VARIANTS)) {
      if (primary && !(v.budget === 'b_pseudo' && v.prefix === null && v.packing !== null)) continue;
      const b = budgets[v.budget]!;
      const d = await this.connector!.deliver(v.prefix === null ? rows : rows.slice(0, v.prefix), v.unit, b, v.packing);
      deliveries[name] = { variant: { ...v, budget_value: b }, record: d.record, blocks: d.blocks };
    }
    const unbudgeted: Record<string, Record<string, unknown>> = {};
    for (const p of AUTO_PACKINGS) {
      const d = await this.connector!.deliver(rows, 'auto', null, p);
      unbudgeted[p] = { evidence_sha256: d.record.evidence_sha256, fingerprint: d.record.fingerprint, budget_tokens: d.record.budget_tokens, budget_used: d.record.budget_used, blocks: d.record.blocks, auto_packing: d.record.auto_packing };
    }
    const guard1 = { packings: unbudgeted, equal: AUTO_PACKINGS.every(p => unbudgeted[p].evidence_sha256 === unbudgeted.off.evidence_sha256 && unbudgeted[p].fingerprint === unbudgeted.off.fingerprint) };
    return { items: this.items(frozen.rows), applied_settings: { stage: 'deliver', variants: 'e2', deliver_set: primary ? 'primary' : 'all', budgets, limit }, truncated: false, service_ms: performance.now() - t0,
      accounting: { ...base, frozen, remapped_chunk_ids: remapped, redacted_chunks: redacted, budgets, deliveries, guard1 } };
  }

  /**
   * E2 live stage (the slice): a fresh frozen list, the assembled delivery of each packing at `b_pseudo` on the fresh
   * and on the frozen list, then `live_reps` rounds of one live `query` per packing (order rotated each round) with
   * `search.auto_packing` written and read back first. Each call records handler time, reranker time and calls, the
   * packing gbrain reports, and parity against both assembled deliveries on every consumed field, dates included.
   */
  private async liveE2(question: PublicQuestion, s: Record<string, unknown>, limit: number, attempts: number, base: { kind: string; version: number } & Record<string, unknown>): Promise<RetrieveResult> {
    const budget = budgetSetting(s, 'b_pseudo');
    const reps = s.live_reps === undefined ? LIVE_REPS : Number(s.live_reps);
    if (!Number.isInteger(reps) || reps < 1) throw new SystemError('invalid_request', 'live_reps must be a positive integer');
    const { frozen: old, rows: frozenRows } = await this.frozenFor(question);
    const { frozen: fresh, service_ms } = await this.freezeOnce(question, limit, attempts);
    const sameList = fresh.rows.length === old.rows.length && fresh.rows.every((r, i) => r.slug === old.rows[i].slug && r.chunk_index === old.rows[i].chunk_index);
    const onFresh: Record<string, Delivery> = {}, onFrozen: Record<string, Delivery> = {};
    for (const p of AUTO_PACKINGS) {
      onFresh[p] = await this.connector!.deliver(fresh.rows, 'auto', budget, p);
      onFrozen[p] = await this.connector!.deliver(frozenRows, 'auto', budget, p);
    }
    const calls: Array<Record<string, unknown>> = [];
    for (let rep = 0; rep < reps; rep++) {
      for (let k = 0; k < AUTO_PACKINGS.length; k++) {
        const p = AUTO_PACKINGS[(k + rep) % AUTO_PACKINGS.length];
        const config = await this.connector!.setPacking(p);
        const live = await this.connector!.live('live-parity', question.text, limit, budget);
        const pf = parity(live, onFresh[p], { dates: true }), pz = parity(live, onFrozen[p], { dates: true });
        calls.push({ rep, packing: p, config_read_back: config.read_back, auto_packing_reported: live.record.auto_packing, service_ms: Math.round(live.service_ms * 10) / 10,
          rerank: live.rerank, handler_minus_rerank_ms: Math.round((live.service_ms - live.rerank.ms) * 10) / 10, budget_used: live.record.budget_used, over_budget: live.record.over_budget,
          evidence_sha256: live.record.evidence_sha256, parity_fresh: { equal: pf.equal, mismatches: pf.mismatches.slice(0, 20) }, parity_frozen: { equal: pz.equal, mismatches: pz.mismatches.slice(0, 20) } });
      }
    }
    const assembled = (d: Record<string, Delivery>) => Object.fromEntries(AUTO_PACKINGS.map(p => [p, { evidence_sha256: d[p].record.evidence_sha256, budget_used: d[p].record.budget_used, over_budget: d[p].record.over_budget, auto_packing: d[p].record.auto_packing, blocks: d[p].record.blocks }]));
    return { items: this.items(fresh.rows), applied_settings: { stage: 'live', variants: 'e2', b_pseudo: budget, live_reps: reps, limit }, truncated: false, service_ms,
      accounting: { ...base, frozen: fresh, frozen_list_equal: sameList, budgets: { b_pseudo: budget }, assembled_fresh: assembled(onFresh), assembled_frozen: assembled(onFrozen), live_checks: calls } };
  }
}

/**
 * True when `stored` equals `frozen` except where `frozen` carries gbrain's output-redaction tokens
 * (`<REDACTED:kind>`, output-redaction.ts): the frozen list holds the redacted text `query` returned, the brain the raw.
 */
export function redactedMatch(frozen: string, stored: string): boolean {
  const parts = frozen.split(/<REDACTED:[a-z_]+>/);
  if (parts.length < 2) return false;
  return new RegExp(`^${parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]+?')}$`).test(stored);
}

/** A positive integer budget from the policy settings, else a harness refusal naming it. */
function budgetSetting(s: Record<string, unknown>, k: string): number {
  const v = Number(s[k]);
  if (!Number.isInteger(v) || v <= 0) throw new SystemError('invalid_request', `this stage needs ${k} (the preregistered budget)`);
  return v;
}

/** `lo:hi:step`, inclusive, positive integers. */
export function parseGrid(spec: string): number[] {
  const [lo, hi, step] = spec.split(':').map(Number);
  if (![lo, hi, step].every(n => Number.isInteger(n) && n > 0) || lo > hi) throw new SystemError('invalid_request', `grid must be lo:hi:step positive integers (got ${spec})`);
  const out: number[] = [];
  for (let b = lo; b <= hi; b += step) out.push(b);
  return out;
}
