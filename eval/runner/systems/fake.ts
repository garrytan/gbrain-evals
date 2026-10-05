/**
 * Keyless reference system, equal in behavior to eval/systems/_fake/fake.py:
 * an in-memory keyword store, one `episode` item per ingested session, ranked
 * by the count of shared words longer than two characters (ties by source
 * id), `k` 5 by default and 20 under `fixed-evidence`. It proves the harness
 * plumbing; its scores say nothing about memory quality.
 *
 * `serveProtocol` exposes any `MemorySystem` over protocol v1 with the same
 * routing, validation and error shapes as eval/systems/_shim/shim.py, so the
 * conformance suite drives the TypeScript fake and a Python shim alike.
 */
import { checkItem, SystemError, type CapabilityRecord, type DeleteResult, type FinishResult, type IngestResult, type Item, type MemorySystem, type PublicQuestion, type RetrievalPolicy, type RetrieveResult, type SessionInput } from './types.ts';

const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length > 2));

export const FAKE_CAPABILITIES: CapabilityRecord = {
  system: 'fake', protocol: 1,
  versions: { package: 'in-repo', lock_sha256: null, image: null, vendor_benchmark_code: null },
  configs: { recipe: { model_roles: {}, notes: 'keyword overlap, no provider calls' }, common: { model_roles: {}, unsettable: ['extraction', 'embedder'] } },
  time: 'native', provenance: { status: 'exact', mechanism: 'one item per ingested session' }, delete: 'native', readiness: 'synchronous',
  namespace: 'in-memory dict key', parallel_namespaces: true, retrieval_policies: { 'vendor-default': { k: 5 }, 'fixed-evidence': { k: 20 } },
  streaming: 'disabled', telemetry_off: [], agent_surface: { kind: 'none' }, deviations_from_vendor_code: [],
};

export class FakeMemorySystem implements MemorySystem {
  readonly name = 'fake';
  private store = new Map<string, Map<string, { text: string; event_time: string | null; words: Set<string> }>>();

  async capabilities(): Promise<CapabilityRecord> { return structuredClone(FAKE_CAPABILITIES); }
  async reset(ns: string): Promise<void> { this.store.delete(ns); }

  async ingestSession(ns: string, session: SessionInput, event_time: string | null): Promise<IngestResult> {
    const text = session.turns.map(t => `${t.speaker}: ${t.content}`).join('\n');
    if (!this.store.has(ns)) this.store.set(ns, new Map());
    this.store.get(ns)!.set(session.source_id, { text, event_time, words: words(text) });
    return { items_created: 1, warnings: [], errors: [], completeness: 'known' };
  }

  async finishIngest(): Promise<FinishResult> { return { ready: true, waited_ms: 0, completeness: 'unknown' }; }

  async retrieve(ns: string, question: PublicQuestion, policy: RetrievalPolicy): Promise<RetrieveResult> {
    if (policy?.mode !== 'vendor-default' && policy?.mode !== 'fixed-evidence') throw new SystemError('invalid_request', 'policy.mode must be vendor-default or fixed-evidence', 400);
    const k = Number(policy.settings?.k || FAKE_CAPABILITIES.retrieval_policies[policy.mode].k);
    const q = words(question.text);
    const scored = [...(this.store.get(ns) ?? new Map()).entries()]
      .map(([src, s]) => ({ score: [...q].filter(w => s.words.has(w)).length, src, s }))
      .sort((a, b) => b.score - a.score || (a.src < b.src ? -1 : a.src > b.src ? 1 : 0));
    const items: Item[] = scored.slice(0, k).flatMap(({ score, src, s }, i) => score > 0
      ? [{ id: src, rank: i + 1, type: 'episode' as const, text: s.text, source_ids: [src], valid_from: s.event_time, valid_to: null, provenance_status: 'exact' as const }] : []);
    return { items, applied_settings: { k }, truncated: false };
  }

  async deleteSource(ns: string, sourceId: string): Promise<DeleteResult> {
    const removed = this.store.get(ns)?.delete(sourceId) ?? false;
    return { status: removed ? 'deleted' : 'partial', receipt: { removed } };
  }
}

const err = (kind: string, message: string, status: number) => ({ status, out: { error: { kind, message } } as Record<string, unknown> });

/** Serve a `MemorySystem` over protocol v1 (mirrors shim.py `dispatch`). */
export function serveProtocol(system: MemorySystem, opts: { port?: number; hostname?: string } = {}): { port: number; url: string; stop: () => void } {
  const server = Bun.serve({
    port: opts.port ?? 0, hostname: opts.hostname ?? '127.0.0.1',
    fetch: async req => {
      const start = performance.now();
      const path = new URL(req.url).pathname;
      let body: any = {};
      let result: { status: number; out: Record<string, unknown> };
      const raw = req.method === 'POST' ? await req.text() : '';
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = null; }
      const need = (...keys: string[]) => { const missing = keys.filter(k => !(k in body)); if (missing.length) throw new SystemError('invalid_request', `missing fields: ${missing.join(', ')}`, 400); };
      try {
        if (body === null) throw new SystemError('invalid_request', 'body is not JSON', 400);
        if (req.method === 'GET' && path === '/health') result = { status: 200, out: { ok: true } };
        else if (req.method === 'GET' && path === '/capabilities') result = { status: 200, out: { ...(await system.capabilities()), protocol: 1 } };
        else if (req.method === 'POST' && path === '/reset') { need('ns'); await system.reset(body.ns); result = { status: 200, out: { ok: true } }; }
        else if (req.method === 'POST' && path === '/ingest') {
          need('ns', 'session');
          const s = body.session;
          if (!s || typeof s !== 'object') throw new SystemError('invalid_request', 'session must be an object', 400);
          const missing = ['source_id', 'event_time', 'turns'].filter(k => !(k in s));
          if (missing.length) throw new SystemError('invalid_request', `missing fields: ${missing.join(', ')}`, 400);
          if (!String(s.source_id).startsWith('src-')) throw new SystemError('invalid_request', 'source_id must be opaque (src-...)', 400);
          for (const t of s.turns) if (!t || !['role', 'speaker', 'content'].every(k => k in t)) throw new SystemError('invalid_request', 'missing fields: role, speaker, content', 400);
          const out = await system.ingestSession(body.ns, { source_id: s.source_id, turns: s.turns }, s.event_time);
          if (!['known', 'unknown', 'degraded'].includes(out.completeness)) throw new SystemError('product_error', 'ingest must report completeness', 500);
          result = { status: 200, out: { ...out } };
        } else if (req.method === 'POST' && path === '/finish') { need('ns'); result = { status: 200, out: { ...(await system.finishIngest(body.ns, Number(body.timeout_s ?? 600))) } }; }
        else if (req.method === 'POST' && path === '/retrieve') {
          need('ns', 'question', 'policy');
          const out = await system.retrieve(body.ns, { text: body.question, query_time: body.query_time ?? null }, body.policy);
          result = { status: 200, out: { ...out, items: out.items.map((i, k) => checkItem(i, k)), applied_settings: out.applied_settings ?? {}, truncated: out.truncated ?? false } };
        } else if (req.method === 'POST' && path === '/delete_source') { need('ns', 'source_id'); result = { status: 200, out: { ...(await system.deleteSource(body.ns, body.source_id)) } }; }
        else throw new SystemError('invalid_request', `no route ${req.method} ${path}`, 404);
      } catch (e) {
        result = e instanceof SystemError ? err(e.kind, e.message, e.status ?? 500) : err('product_error', `${(e as Error).name}: ${(e as Error).message}`, 500);
      }
      result.out.service_ms = Math.round((performance.now() - start) * 1000) / 1000;
      return Response.json(result.out, { status: result.status });
    },
  });
  return { port: server.port as number, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
