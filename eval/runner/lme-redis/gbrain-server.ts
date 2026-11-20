#!/usr/bin/env bun
/**
 * gbrain's side of the LongMemEval run on Redis's open harness (preregistration
 * docs/benchmarks/2026-11-20-longmemeval-redis-harness-preregistration.md).
 *
 *   GBRAIN_SRC=<gbrain checkout>/src bun eval/runner/lme-redis/gbrain-server.ts
 *
 * A local HTTP server, bound to 127.0.0.1, that holds one fresh in-memory PGLite brain per question. Each history
 * conversation is imported as one page through gbrain's normal import path (importFromContent), and retrieval is
 * gbrain's real `query` operation with an agent's stdio MCP context. The reranker is pinned to
 * voyage:rerank-3-lite on every brain, so a default change can't move it mid-run.
 *
 *   POST /ingest {brain_id, sessions: [{date, turns: [{role, content}]}]}  -> {pages}
 *   POST /query  {brain_id, question, params}                             -> {results, meta, op}
 *   POST /reset  {brain_id}                                               -> {ok}
 *   GET  /       -> {ok, brains, gbrain_version, reranker}
 *
 * Each result row carries the loader index of its conversation (`idx`), so the Python side renders whole
 * conversations with the harness's own session_text. `op` records the parameters sent, latency, model calls by
 * touchpoint, failed calls, the reranker that answered and every degraded stage.
 *
 * LME_REDIS_STUB_EMBED=1 replaces the embedding transport with a local hash (keyless tests); no other provider call is
 * stubbed, so a test runs with every key blanked and the reranker records itself as skipped.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RERANKER_MODEL = 'voyage:rerank-3-lite';

/**
 * Voyage is a paid provider, so gbrain may reach it only through a loopback host: the metering proxy
 * (eval/runner/harness-metering-proxy.ts), which reserves each request in the experiment's ledger, or a dead keyless
 * upstream in tests. The server refuses to start unless the brain config's `provider_base_urls.voyage` is one.
 */
export function voyageRoute(home: string | undefined): string {
  const path = join(home ?? '', '.gbrain', 'config.json');
  const url = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { provider_base_urls?: Record<string, string> }).provider_base_urls?.voyage : undefined;
  let host = '';
  try { host = url ? new URL(url).hostname : ''; } catch { host = ''; }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error(`refusing to start: provider_base_urls.voyage in ${path} must point at the metering proxy or a keyless fake on a loopback host (got ${url ?? 'none'})`);
  }
  return url!;
}
const voyage = voyageRoute(process.env.GBRAIN_HOME);

const G = process.env.GBRAIN_SRC;
if (!G) throw new Error('GBRAIN_SRC must name the src/ directory of the pinned gbrain checkout');
const gbrainVersion = (JSON.parse(readFileSync(join(G, '..', 'package.json'), 'utf8')) as { version: string }).version;
const { configureEvalGateway } = await import(G + '/eval/shared/gateway-bootstrap.ts');
const { createBenchmarkBrain } = await import(G + '/eval/longmemeval/harness.ts');
const { haystackToPages } = await import(G + '/eval/longmemeval/adapter.ts');
const { importFromContent } = await import(G + '/core/import-file.ts');
const { VIA_OPERATION_CONTEXT } = await import(G + '/eval/longmemeval/via-operation.ts');
const { operationsByName } = await import(G + '/core/operations.ts');
const { buildOperationContext } = await import(G + '/mcp/dispatch.ts');
const { BudgetTracker } = await import(G + '/core/budget/budget-tracker.ts');
const { withBudgetTracker, __setEmbedTransportForTests } = await import(G + '/core/ai/gateway.ts');

if (process.env.LME_REDIS_STUB_EMBED === '1') {
  const dims = Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS ?? 1024);
  const vec = (s: string) => {
    const v = new Array(dims).fill(0);
    for (let i = 0; i < s.length; i++) v[(s.charCodeAt(i) * 31 + i) % dims] += 1;
    const n = Math.hypot(...v) || 1;
    return v.map(x => x / n);
  };
  __setEmbedTransportForTests((async (o: { values: string[] }) => ({ embeddings: o.values.map(vec), usage: { tokens: 0 } })) as never);
}
configureEvalGateway();

type Brain = { engine: any; idxBySlug: Map<string, number> };
const brains = new Map<string, Brain>();
const auditDir = mkdtempSync(join(tmpdir(), 'lme-redis-op-'));

async function drop(id: string) {
  const old = brains.get(id);
  if (!old) return;
  brains.delete(id);
  await old.engine.disconnect();
}

async function ingest(body: { brain_id: string; sessions: Array<{ date: string; turns: Array<{ role: string; content: string }> }> }) {
  await drop(body.brain_id);
  const engine = await createBenchmarkBrain();
  await engine.setConfig('search.reranker.model', RERANKER_MODEL);
  await engine.setConfig('search.reranker.enabled', 'true');
  const q = {
    question_id: body.brain_id, question_type: '', question: '', answer: '', answer_session_ids: [],
    haystack_sessions: body.sessions.map((s, i) => ({ session_id: 's' + i, turns: s.turns })),
    haystack_dates: body.sessions.map(s => s.date),
  };
  const pages = haystackToPages(q as never) as Array<{ slug: string; content: string }>;
  if (pages.length !== body.sessions.length) {
    await engine.disconnect();
    throw new Error(`${body.brain_id}: gbrain rendered ${pages.length} pages from ${body.sessions.length} conversations`);
  }
  const idxBySlug = new Map<string, number>();
  for (let i = 0; i < pages.length; i++) {
    await importFromContent(engine, pages[i].slug, pages[i].content, {});
    idxBySlug.set(pages[i].slug, i);
  }
  brains.set(body.brain_id, { engine, idxBySlug });
  return { pages: pages.length };
}

async function query(body: { brain_id: string; question: string; params?: Record<string, unknown> }) {
  const b = brains.get(body.brain_id);
  if (!b) throw new Error('no brain ' + body.brain_id);
  const params = body.params ?? {};
  let meta: Record<string, any> = {};
  const ctx = buildOperationContext(b.engine, {}, {
    remote: VIA_OPERATION_CONTEXT.remote, transport: VIA_OPERATION_CONTEXT.transport, sourceId: VIA_OPERATION_CONTEXT.source_id,
    config: { engine: 'pglite' } as never,
  });
  ctx.emitResponseMeta = (k: string, v: unknown) => { if (k === 'retrieval' && v && typeof v === 'object') meta = v as Record<string, any>; };
  const tracker = new BudgetTracker({ label: 'lme-redis.query', auditPath: join(auditDir, 'budget.jsonl') });
  const t0 = performance.now();
  const rows = await withBudgetTracker(tracker, () => operationsByName.query.handler(ctx, { query: body.question, ...params }));
  const latency_ms = Math.round(performance.now() - t0);
  const model_calls: Record<string, number> = {};
  let failed_model_calls = 0;
  let reranked: string | null = null;
  for (const m of tracker.snapshot().models) {
    model_calls[m.touchpoint] = (model_calls[m.touchpoint] ?? 0) + m.calls;
    failed_model_calls += m.failed_calls;
    if (m.touchpoint === 'rerank' && m.calls > m.failed_calls) reranked = m.model;
  }
  const results = (Array.isArray(rows) ? rows : []).map((r: any) => {
    const idx = b.idxBySlug.get(r.slug);
    if (idx === undefined) throw new Error(`${body.brain_id}: result slug ${r.slug} is no imported conversation`);
    return { slug: r.slug, idx, score: r.score, chunk_text: String(r.chunk_text ?? '') };
  });
  const { timings: _t, ...kept } = meta;
  return {
    results,
    meta: kept,
    op: {
      params, latency_ms, model_calls, failed_model_calls,
      reranker: meta.crag?.top_rerank_score === undefined ? null : reranked,
      degraded: Array.isArray(meta.degraded) ? meta.degraded : [],
    },
  };
}

async function reset(body: { brain_id: string }) {
  await drop(body.brain_id);
  return { ok: true };
}

const routes: Record<string, (b: any) => Promise<unknown>> = { '/ingest': ingest, '/query': query, '/reset': reset };
const server = Bun.serve({
  port: Number(process.env.LME_REDIS_PORT ?? 8787), hostname: '127.0.0.1', idleTimeout: 255,
  async fetch(req) {
    const fn = routes[new URL(req.url).pathname];
    if (!fn) return Response.json({ ok: true, brains: brains.size, gbrain_version: gbrainVersion, reranker: RERANKER_MODEL, voyage_route: voyage });
    try { return Response.json(await fn(await req.json())); }
    catch (e) { return Response.json({ error: String((e as Error)?.stack ?? e) }, { status: 500 }); }
  },
});
console.error(`gbrain adapter up on ${server.port} (gbrain ${gbrainVersion}, reranker ${RERANKER_MODEL})`);
