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
import { CONNECTOR_VERSION, GbrainQueryConnector, parity, QUERY_PATH_PINS, type ConnectorModules, type Delivery, type FrozenRow, type PinCheck } from './connector.ts';

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

/**
 * The frozen-list memo key: the namespace's first ingested source id (opaque
 * source ids are stable across runs; namespaces are salted per run) plus the
 * question text and date, as the system sees them.
 */
export const memoKey = (anchor: string, q: PublicQuestion) => createHash('sha256').update(`${anchor}\u0000${q.text}\u0000${q.query_time ?? ''}`).digest('hex');

export interface FrozenRecord { memo_key: string; request: Record<string, unknown>; rows: FrozenRow[]; meta: Record<string, unknown>; rerank_present: boolean; rerank_attempts: number; hit_count: number; distinct_sessions: number }

/** A grid budget's raw deliveries, rendered and counted by the runner's sizing hook. */
export interface SizingDeliveries { budget: number; full: Delivery; prefix: Delivery }

export class GbrainQuerySystem extends GbrainBrain {
  readonly name = 'gbrain-query';
  private connector: GbrainQueryConnector | null = null;
  private pinChecks: PinCheck[] = [];
  private frozenMemo: Map<string, FrozenRecord> | null = null;
  private anchor: string | null = null;
  /** Raw grid deliveries of the last freeze-stage retrieval, for the runner's sizing hook (never written to rows). */
  lastSizing: SizingDeliveries[] | null = null;
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

  /** Re-resolve frozen chunk ids in this brain by (slug, chunk_index), so a re-ingested brain with different serial ids still delivers the frozen chunks. */
  private async remap(rows: readonly FrozenRow[]): Promise<{ rows: FrozenRow[]; remapped: number; missing: number }> {
    const slugs = [...new Set(rows.map(r => r.slug))];
    const found = await this.engine.executeRaw(`SELECT p.slug, c.id AS chunk_id, c.chunk_index FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = ANY($1::text[])`, [slugs]) as Array<{ slug: string; chunk_id: number; chunk_index: number }>;
    const byKey = new Map(found.map(f => [`${f.slug}\u0000${f.chunk_index}`, Number(f.chunk_id)]));
    let remapped = 0, missing = 0;
    const out = rows.map(r => {
      const id = byKey.get(`${r.slug}\u0000${r.chunk_index}`);
      if (id === undefined) { missing++; return r; }
      if (id !== r.chunk_id) remapped++;
      return { ...r, chunk_id: id };
    });
    return { rows: out, remapped, missing };
  }

  async retrieve(ns: string, question: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> {
    this.live(ns);
    const s = policy.settings ?? {};
    const limit = Number(s.limit ?? QUERY_LIMIT);
    if (!Number.isInteger(limit) || limit < 1) throw new SystemError('invalid_request', 'limit must be a positive integer');
    const stage = s.stage === undefined ? null : String(s.stage);
    const attempts = Number(s.rerank_attempts ?? 3);
    const base = { kind: 'gbrain-query', version: 1, connector: CONNECTOR_VERSION, stage, pins: this.pinChecks, cache_status: this.connector!.cacheStatus() };
    this.lastSizing = null;

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
}

/** `lo:hi:step`, inclusive, positive integers. */
export function parseGrid(spec: string): number[] {
  const [lo, hi, step] = spec.split(':').map(Number);
  if (![lo, hi, step].every(n => Number.isInteger(n) && n > 0) || lo > hi) throw new SystemError('invalid_request', `grid must be lo:hi:step positive integers (got ${spec})`);
  const out: number[] = [];
  for (let b = lo; b <= hi; b += step) out.push(b);
  return out;
}
