/**
 * The three D1 controls of the open-source memory shootout, behind the same
 * `MemorySystem` interface as every product, so the same sanitizer, renderer,
 * packer and outcome accounting apply to them:
 *
 *   full-context  the whole namespace history, one item per session
 *                 (provenance exact), ranked most recent first so the packer
 *                 drops the earliest sessions first, like a chat window. The
 *                 reader sees the kept sessions in chronological order
 *                 (capability `presentation: event-time`); with no budget it
 *                 sees everything, where it fits.
 *                 Its rows carry no recall: returning everything is not a
 *                 ranking (capability `retrieval_metrics: not-applicable`).
 *   no-memory     stores nothing and returns no items: the reader answers
 *                 from the question alone. Its rows carry no recall either.
 *   plain-hybrid  the simplest search a team would build: one row per
 *                 session in Postgres (PGlite), full-text search
 *                 (`websearch_to_tsquery`, `ts_rank_cd`) and pgvector cosine
 *                 search over OpenAI `text-embedding-3-large` at 1,536
 *                 dimensions, fused by reciprocal rank (k = 60). It reuses the
 *                 Cat 40 `pg` arm's table and embedder (cat40/pg-arm.ts), which
 *                 sends embedding calls to OPENAI_BASE_URL, so a cell meters
 *                 them through its lease proxy. No gbrain code runs.
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { PG_EMBED_DIMS, PG_EMBED_MODEL, type Embedder } from '../cat40/pg-arm.ts';
import { SystemError, type CapabilityRecord, type DeleteResult, type FinishResult, type IngestResult, type Item, type MemorySystem, type PublicQuestion, type RetrievalPolicy, type RetrieveResult, type SessionInput } from './types.ts';

const sessionText = (s: SessionInput) => s.turns.map(t => `${t.speaker}: ${t.content}`).join('\n');
const record = (system: string, extra: Partial<CapabilityRecord>): CapabilityRecord => ({
  system, protocol: 1, versions: { package: 'in-repo', lock_sha256: null, image: null, vendor_benchmark_code: null },
  configs: { common: { model_roles: {}, notes: 'harness control' } }, time: 'in-text', provenance: { status: 'exact', mechanism: 'one item per ingested session' },
  delete: 'native', readiness: 'synchronous', namespace: 'in-process', parallel_namespaces: false, retrieval_policies: { 'vendor-default': {}, 'fixed-evidence': {} },
  streaming: 'disabled', telemetry_off: [], agent_surface: { kind: 'none' }, deviations_from_vendor_code: [], ...extra,
});
const checkMode = (p: RetrievalPolicy) => { if (p?.mode !== 'vendor-default' && p?.mode !== 'fixed-evidence') throw new SystemError('invalid_request', 'policy.mode must be vendor-default or fixed-evidence', 400); };

export class FullContextSystem implements MemorySystem {
  readonly name = 'full-context';
  private store = new Map<string, Array<{ src: string; text: string; event_time: string | null }>>();
  async capabilities() { return record('full-context', { readiness: 'synchronous; retrieval returns every ingested session, most recent first', retrieval_metrics: 'not-applicable', presentation: 'event-time' }); }
  async reset(ns: string) { this.store.delete(ns); }
  async ingestSession(ns: string, s: SessionInput, event_time: string | null): Promise<IngestResult> {
    const list = this.store.get(ns) ?? [];
    this.store.set(ns, [...list.filter(x => x.src !== s.source_id), { src: s.source_id, text: sessionText(s), event_time }]);
    return { items_created: 1, warnings: [], errors: [], completeness: 'known' };
  }
  async finishIngest(): Promise<FinishResult> { return { ready: true, waited_ms: 0, completeness: 'known' }; }
  async retrieve(ns: string, _q: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> {
    checkMode(policy);
    const items: Item[] = [...(this.store.get(ns) ?? [])].reverse().map((x, i) => ({ id: x.src, rank: i + 1, type: 'episode', text: x.text, source_ids: [x.src], valid_from: x.event_time, valid_to: null, provenance_status: 'exact' }));
    return { items, applied_settings: { order: 'most recent first', items: items.length }, truncated: false };
  }
  async deleteSource(ns: string, src: string): Promise<DeleteResult> {
    const list = this.store.get(ns) ?? [];
    this.store.set(ns, list.filter(x => x.src !== src));
    return { status: list.some(x => x.src === src) ? 'deleted' : 'partial', receipt: {} };
  }
}

export class NoMemorySystem implements MemorySystem {
  readonly name = 'no-memory';
  async capabilities() { return record('no-memory', { time: 'none', provenance: { status: 'unavailable', mechanism: 'stores nothing' }, delete: 'native', readiness: 'nothing to wait for', retrieval_metrics: 'not-applicable' }); }
  async reset(_ns: string) {}
  async ingestSession(_ns: string, _s: SessionInput, _event_time: string | null): Promise<IngestResult> { return { items_created: 0, warnings: [], errors: [], completeness: 'known' }; }
  async finishIngest(): Promise<FinishResult> { return { ready: true, waited_ms: 0, completeness: 'known' }; }
  async retrieve(_ns: string, _q: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> { checkMode(policy); return { items: [], applied_settings: {}, truncated: false }; }
  async deleteSource(_ns: string, _src: string): Promise<DeleteResult> { return { status: 'deleted', receipt: { stored: false } }; }
}

const lit = (v: number[]) => `[${v.join(',')}]`;

export class PlainHybridSystem implements MemorySystem {
  readonly name = 'plain-hybrid';
  static readonly POLICIES = { 'vendor-default': { k: 10 }, 'fixed-evidence': { k: 30 } } as const;
  static readonly POOL = 50;
  static readonly RRF_K = 60;
  private db: PGlite | null = null;
  constructor(private embed: Embedder, private embedderId = `openai:${PG_EMBED_MODEL}@${PG_EMBED_DIMS}`) {}

  async capabilities() {
    return record('plain-hybrid', {
      configs: { common: { model_roles: { embedder: this.embedderId, dims: PG_EMBED_DIMS }, notes: 'Postgres full-text plus pgvector cosine, reciprocal-rank fusion; whole sessions; embedding input cut at 24,000 characters' } },
      retrieval_policies: { ...PlainHybridSystem.POLICIES }, readiness: 'synchronous: a session is searchable once its row is written',
    });
  }

  private async open(): Promise<PGlite> {
    if (this.db) return this.db;
    const db = await PGlite.create({ extensions: { vector } });
    await db.exec(`CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE sessions (ns text NOT NULL, src text NOT NULL, body text NOT NULL, event_time text, tsv tsvector, embedding vector(${PG_EMBED_DIMS}), PRIMARY KEY (ns, src));
      CREATE INDEX sessions_tsv ON sessions USING gin(tsv);`);
    return this.db = db;
  }

  async reset(ns: string) { await (await this.open()).query('DELETE FROM sessions WHERE ns = $1', [ns]); }

  async ingestSession(ns: string, s: SessionInput, event_time: string | null): Promise<IngestResult> {
    const db = await this.open();
    const body = sessionText(s);
    const [v] = await this.embed([body]);
    await db.query(`INSERT INTO sessions (ns, src, body, event_time, tsv, embedding) VALUES ($1, $2, $3, $4, to_tsvector('english', $3), $5::vector)
      ON CONFLICT (ns, src) DO UPDATE SET body = EXCLUDED.body, event_time = EXCLUDED.event_time, tsv = EXCLUDED.tsv, embedding = EXCLUDED.embedding`, [ns, s.source_id, body, event_time, lit(v)]);
    return { items_created: 1, warnings: [], errors: [], completeness: 'known' };
  }

  async finishIngest(): Promise<FinishResult> { return { ready: true, waited_ms: 0, completeness: 'known' }; }

  async retrieve(ns: string, q: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> {
    checkMode(policy);
    const db = await this.open();
    const k = Number(policy.settings?.k ?? PlainHybridSystem.POLICIES[policy.mode].k);
    const t0 = performance.now();
    const [v] = await this.embed([q.text]);
    const kw = await db.query(`SELECT src FROM sessions, websearch_to_tsquery('english', $2) query WHERE ns = $1 AND tsv @@ query ORDER BY ts_rank_cd(tsv, query) DESC, src LIMIT ${PlainHybridSystem.POOL}`, [ns, q.text]);
    const vec = await db.query(`SELECT src FROM sessions WHERE ns = $1 ORDER BY embedding <=> $2::vector, src LIMIT ${PlainHybridSystem.POOL}`, [ns, lit(v)]);
    const score = new Map<string, number>();
    for (const list of [kw.rows, vec.rows] as Array<Array<{ src: string }>>) list.forEach((r, i) => score.set(r.src, (score.get(r.src) ?? 0) + 1 / (PlainHybridSystem.RRF_K + i + 1)));
    const top = [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([src]) => src);
    const rows = top.length ? (await db.query(`SELECT src, body, event_time FROM sessions WHERE ns = $1 AND src = ANY($2)`, [ns, top])).rows as Array<{ src: string; body: string; event_time: string | null }> : [];
    const bySrc = new Map(rows.map(r => [r.src, r]));
    const items: Item[] = top.map((src, i) => ({ id: src, rank: i + 1, type: 'episode', text: bySrc.get(src)!.body, source_ids: [src], valid_from: bySrc.get(src)!.event_time, valid_to: null, provenance_status: 'exact' }));
    return { items, applied_settings: { k, pool: PlainHybridSystem.POOL, rrf_k: PlainHybridSystem.RRF_K, embedder: this.embedderId }, truncated: false, service_ms: performance.now() - t0 };
  }

  async deleteSource(ns: string, src: string): Promise<DeleteResult> {
    const r = await (await this.open()).query('DELETE FROM sessions WHERE ns = $1 AND src = $2', [ns, src]);
    return { status: (r.affectedRows ?? 0) > 0 ? 'deleted' : 'partial', receipt: { rows: r.affectedRows ?? 0 } };
  }

  async close() { await this.db?.close(); this.db = null; }
}
