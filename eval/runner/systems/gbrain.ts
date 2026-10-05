/**
 * gbrain behind the `MemorySystem` interface, in process.
 *
 * Two adapters with different contracts (engineering reviews T2 and Astra 11):
 *
 *   GbrainLegacySystem (`--system gbrain`, the default): memory-qa's existing
 *     path moved unchanged. One fresh PGLite brain recycled every 25
 *     namespaces and truncated between them, each session imported as a note
 *     page whose slug is the occurrence id and whose frontmatter carries the
 *     dataset's raw date, `hybridSearch` with expansion off at three times
 *     top-k, chunks reduced to distinct pages in rank order. The keyless
 *     golden (test/eval/memory-qa-golden.test.ts) pins its output; the
 *     decision kit (`eval:decide`) runs it.
 *
 *   GbrainShootoutSystem (`--system gbrain-shootout`): the shootout's
 *     separately named recipe. Pages are conversation pages dated with the
 *     ISO event time, retrieval is gbrain's hybrid search with the build's
 *     own defaults (no harness pins: `balanced` mode, Voyage reranker on), and
 *     items are the chunk text the read API returns (native context), each
 *     citing the page's source. On a cell VM its provider calls go through the
 *     lease proxy (memory-qa `--provider-proxy`).
 *
 *     Limits, frozen 2026-10-05 from a keyless check (30 LoCoMo dev questions,
 *     hash vectors, `--policy fixed-evidence` with limit 200): items average
 *     465 approximate tokens (median 530), an 8,000-token pack takes 14 to 22
 *     items, and gbrain returned 22 to 28 items under its own 12,000-token
 *     search budget, so no pack ran out of items. `vendor-default` passes no
 *     limit (the mode's own, 25 in `balanced`); `fixed-evidence` asks for 40,
 *     above every observed need.
 *
 * Both import gbrain only through the functions the caller loads with
 * `importGbrain`, so `--gbrain` really selects the build under test.
 */
import { renderSessionPage } from '../memory-qa/corpus.ts';
import { SystemError, type CapabilityRecord, type DeleteResult, type FinishResult, type IngestResult, type Item, type MemorySystem, type PublicQuestion, type RetrievalPolicy, type RetrieveResult, type SessionInput } from './types.ts';

export interface GbrainModules {
  PGLiteEngine: new () => any;
  importFromContent: (e: unknown, slug: string, content: string, o?: Record<string, unknown>) => Promise<{ embedding_deferred?: boolean }>;
  hybridSearch: (e: unknown, q: string, o?: Record<string, unknown>) => Promise<Array<{ slug: string; chunk_text?: string; rerank_score?: number }>>;
}

const RECYCLE_EVERY = 25;
const PRESERVE_TABLES = new Set(['sources', 'config', 'gbrain_cycle_locks', 'subagent_rate_leases']);
const slugOf = (sourceId: string) => `chat/${sourceId.replace(/^src-/, '')}`;
const sourceOfSlug = (slug: string) => /^chat\/[0-9a-f]{16}$/.test(slug) ? `src-${slug.slice(5)}` : null;

/** One brain, reused across namespaces the way memory-qa always did it. */
abstract class GbrainBrain implements MemorySystem {
  abstract readonly name: string;
  protected engine: any = null;
  private processed = 0;
  private current: string | null = null;
  readonly fidelity = { embedding_deferred_pages: 0, rerank_missing_queries: 0, reranked_queries: 0 };
  constructor(protected mods: GbrainModules, protected settings: Record<string, string>, readonly identity: Record<string, unknown>) {}

  abstract capabilities(): Promise<CapabilityRecord>;
  protected abstract page(session: SessionInput, eventTime: string | null): string;
  abstract retrieve(ns: string, question: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult>;

  /** The open brain, for gbrain-only lanes (conversation facts, think) that read it directly. */
  get brain(): any { return this.engine; }

  private async open() {
    const e = new this.mods.PGLiteEngine();
    await e.connect({});
    await e.initSchema();
    for (const [k, v] of Object.entries(this.settings)) await e.setConfig(k, v);
    return e;
  }

  async reset(ns: string): Promise<void> {
    if (!this.engine) this.engine = await this.open();
    else if (this.processed > 0 && this.processed % RECYCLE_EVERY === 0) { try { await this.engine.disconnect(); } catch { /* ignore */ } this.engine = await this.open(); }
    else if (this.processed > 0) {
      const rows = await this.engine.executeRaw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`) as Array<{ tablename: string }>;
      const targets = rows.map(r => r.tablename).filter(t => !PRESERVE_TABLES.has(t));
      if (targets.length) await this.engine.executeRaw(`TRUNCATE ${targets.map(t => `"${t.replace(/"/g, '""')}"`).join(', ')} RESTART IDENTITY CASCADE`);
    }
    this.processed++;
    this.current = ns;
  }

  private live(ns: string) { if (!this.engine || this.current !== ns) throw new SystemError('invalid_request', 'gbrain holds one namespace at a time: reset(ns) first'); }

  async ingestSession(ns: string, session: SessionInput, eventTime: string | null): Promise<IngestResult> {
    this.live(ns);
    const res = await this.mods.importFromContent(this.engine, slugOf(session.source_id), this.page(session, eventTime), {});
    if (res?.embedding_deferred) this.fidelity.embedding_deferred_pages++;
    return { items_created: 1, warnings: res?.embedding_deferred ? ['embedding_deferred'] : [], errors: [], completeness: 'known' };
  }

  async finishIngest(ns: string): Promise<FinishResult> { this.live(ns); return { ready: true, waited_ms: 0, completeness: 'known' }; }

  protected async search(ns: string, text: string, opts: Record<string, unknown>, rerankPinned: boolean) {
    this.live(ns);
    const t0 = performance.now();
    const results = await this.mods.hybridSearch(this.engine, text, opts);
    const service_ms = performance.now() - t0;
    if (rerankPinned && results.length) {
      if (results.some(r => r.rerank_score !== undefined)) this.fidelity.reranked_queries++;
      else this.fidelity.rerank_missing_queries++;
    }
    return { results, service_ms };
  }

  async deleteSource(ns: string, sourceId: string): Promise<DeleteResult> {
    this.live(ns);
    await this.engine.deletePage(slugOf(sourceId));
    return { status: 'deleted', receipt: { page: 'deleted through BrainEngine.deletePage' } };
  }

  async close(): Promise<void> { try { await this.engine?.disconnect(); } catch { /* ignore */ } this.engine = null; }
}

const baseCapabilities = (system: string, identity: Record<string, unknown>, extra: Partial<CapabilityRecord>): CapabilityRecord => ({
  system, protocol: 1, versions: { package: String(identity.version ?? 'unknown'), commit: String(identity.commit ?? 'unknown'), image: null, lock_sha256: null, vendor_benchmark_code: null },
  configs: {}, time: 'none', provenance: { status: 'exact', mechanism: 'one page per session; the page slug is the occurrence id' }, delete: 'native',
  readiness: 'synchronous: import returns after the page and its vectors are written', namespace: 'one in-memory PGLite brain per namespace (truncated between namespaces)',
  parallel_namespaces: false, retrieval_policies: {}, streaming: 'disabled', telemetry_off: [], agent_surface: { kind: 'none' }, deviations_from_vendor_code: [], ...extra,
});

export class GbrainLegacySystem extends GbrainBrain {
  readonly name = 'gbrain';
  constructor(mods: GbrainModules, settings: Record<string, string>, identity: Record<string, unknown>, private opts: { topK: number; as: 'note' | 'conversation'; rerankPinned: boolean }) { super(mods, settings, identity); }

  async capabilities(): Promise<CapabilityRecord> {
    return baseCapabilities('gbrain', this.identity, {
      configs: { legacy: { model_roles: {}, notes: 'memory-qa legacy path: harness pins, hybridSearch expansion off, chunks reduced to pages' } },
      time: 'in-text', retrieval_policies: { 'vendor-default': { settings: { limit: this.opts.topK * 3, expansion: false }, pins: this.settings } },
    });
  }

  /** The page memory-qa always wrote: raw dataset date in the frontmatter (the caller passes it as the event time). */
  protected page(session: SessionInput, eventTime: string | null): string {
    return renderSessionPage({ id: session.source_id, date: eventTime ?? undefined, turns: session.turns.map(t => ({ speaker: t.speaker, content: t.content })) }, { as: this.opts.as });
  }

  /** One item per distinct page in rank order; a page outside this brain's sessions keeps its slug as id and cites nothing. */
  async retrieve(ns: string, question: PublicQuestion, _policy: RetrievalPolicy): Promise<RetrieveResult> {
    const { results, service_ms } = await this.search(ns, question.text, { limit: this.opts.topK * 3, expansion: false }, this.opts.rerankPinned);
    const items: Item[] = [];
    for (const r of results) {
      if (items.some(i => i.id === r.slug)) continue;
      const src = sourceOfSlug(r.slug);
      items.push({ id: r.slug, rank: items.length + 1, type: 'page', text: r.chunk_text ?? '', source_ids: src ? [src] : [], valid_from: null, valid_to: null, provenance_status: src ? 'exact' : 'unavailable' });
    }
    return { items, applied_settings: { limit: this.opts.topK * 3, expansion: false }, truncated: false, service_ms };
  }
}

/** gbrain's shootout recipe: native chunk items from the build's own search defaults. */
export class GbrainShootoutSystem extends GbrainBrain {
  readonly name = 'gbrain-shootout';
  static readonly POLICIES: Record<'vendor-default' | 'fixed-evidence', { limit?: number }> = { 'vendor-default': {}, 'fixed-evidence': { limit: 40 } };

  async capabilities(): Promise<CapabilityRecord> {
    return baseCapabilities('gbrain-shootout', this.identity, {
      configs: { recipe: { model_roles: {}, notes: 'gbrain init defaults for search; embedder from the run' }, common: { model_roles: { embedder: 'openai:text-embedding-3-large', dims: 1536 }, unsettable: ['extraction'] } },
      time: 'native', retrieval_policies: { 'vendor-default': { settings: { ...GbrainShootoutSystem.POLICIES['vendor-default'] } }, 'fixed-evidence': { settings: { ...GbrainShootoutSystem.POLICIES['fixed-evidence'] } } }, provenance: { status: 'exact', mechanism: 'each chunk cites its page; one page per session' },
      deviations_from_vendor_code: ['retrieval limits frozen from a keyless LoCoMo check (see eval/runner/systems/gbrain.ts)'],
    });
  }

  protected page(session: SessionInput, eventTime: string | null): string {
    return renderSessionPage({ id: session.source_id, date: eventTime ?? undefined, turns: session.turns.map(t => ({ speaker: t.speaker, content: t.content })) }, { as: 'conversation' });
  }

  async retrieve(ns: string, question: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> {
    if (policy.mode !== 'vendor-default' && policy.mode !== 'fixed-evidence') throw new SystemError('invalid_request', 'policy.mode must be vendor-default or fixed-evidence');
    const raw = policy.settings?.limit ?? GbrainShootoutSystem.POLICIES[policy.mode].limit;
    const limit = raw === undefined ? undefined : Number(raw);
    const { results, service_ms } = await this.search(ns, question.text, limit === undefined ? {} : { limit }, false);
    const items: Item[] = results.map((r, i) => {
      const src = sourceOfSlug(r.slug);
      return { id: `${r.slug}#${i}`, rank: i + 1, type: 'chunk', text: r.chunk_text ?? '', source_ids: src ? [src] : [], valid_from: null, valid_to: null, provenance_status: src ? 'exact' : 'unavailable' };
    });
    return { items, applied_settings: { limit: limit ?? 'search mode default' }, truncated: false, service_ms };
  }
}
