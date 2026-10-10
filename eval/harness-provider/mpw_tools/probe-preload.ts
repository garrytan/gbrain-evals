/**
 * Bun preload for equivalence replays (`harness:cell replay --probe`): records, per gbrain process, every `query`
 * operation and the engine searches it makes, without changing what gbrain returns.
 *
 *   MPW_PROBE_ROOT  the gbrain checkout the process runs (its src/ is patched in place, in memory)
 *   MPW_PROBE_LOG   JSONL file; one line per event, appended
 *
 * Events:
 *   query   params (query, limit, token_budget, return_unit, expand, every other key named), the returned rows
 *           (slug, result_type, ids, trust fields, sha256 and cl100k-free length of the row text) and the raw
 *           `retrieval.delivery` block
 *   vector  embedding column, sha256 of the query vector, the opts keys that are set, source scope and trust floor, result chunk ids
 *           in order, and the vector-pool meta gbrain reports (underfilled, escalations)
 *   keyword the keyword text, opts keys, source scope, result chunk ids in order
 * The MCP child serves one request at a time, so engine events between two query events belong to the first.
 */
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const root = process.env.MPW_PROBE_ROOT;
const logPath = process.env.MPW_PROBE_LOG;
if (root && logPath && process.argv.includes('serve')) {
  const als = new AsyncLocalStorage<{ q: number }>();
  let seq = 0;
  const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16);
  const log = (e: Record<string, unknown>) => appendFileSync(logPath, JSON.stringify({ pid: process.pid, t: Date.now(), q: als.getStore()?.q ?? null, ...e }) + '\n');
  const scope = (o: Record<string, unknown> = {}) => ({
    opts: Object.keys(o).filter(k => o[k] !== undefined).sort(), source_id: o.sourceId ?? null, source_ids: o.sourceIds ?? null,
    min_trust: o.minTrust ?? null, limit: o.limit ?? null,
  });
  const ids = (rs: Array<Record<string, unknown>>) => rs.map(r => String(r.chunk_id ?? r.id ?? r.slug));

  const { PGLiteEngine } = await import(`${root}/src/core/pglite-engine.ts`);
  const vector = PGLiteEngine.prototype.searchVector;
  PGLiteEngine.prototype.searchVector = async function (emb: Float32Array, opts: Record<string, unknown> = {}) {
    let pool: unknown = null;
    const inner = opts.onVectorPoolMeta as ((i: unknown) => void) | undefined;
    const o = { ...opts, onVectorPoolMeta: (i: unknown) => { pool = i; inner?.(i); } };
    const rs = await vector.call(this, emb, o);
    log({ ev: 'vector', column: typeof opts.embeddingColumn === 'object' && opts.embeddingColumn ? (opts.embeddingColumn as { name?: string }).name : opts.embeddingColumn ?? 'embedding', vec: sha(new Uint8Array(emb.buffer, emb.byteOffset, emb.byteLength)), ...scope(opts), ids: ids(rs), pool });
    return rs;
  };
  const keyword = PGLiteEngine.prototype.searchKeyword;
  PGLiteEngine.prototype.searchKeyword = async function (query: string, opts: Record<string, unknown> = {}) {
    const rs = await keyword.call(this, query, opts);
    log({ ev: 'keyword', query, ...scope(opts), ids: ids(rs) });
    return rs;
  };

  const { operations } = await import(`${root}/src/core/operations.ts`);
  const op = (operations as Array<{ name: string; handler: (ctx: unknown, p: Record<string, unknown>) => Promise<unknown> }>).find(o => o.name === 'query');
  if (op) {
    const handler = op.handler;
    op.handler = async (ctx, p) => {
      const q = ++seq;
      return als.run({ q }, async () => {
        const c = ctx as { emitResponseMeta?: (k: string, m: unknown) => void };
        let meta: Record<string, unknown> | undefined;
        const emit = c.emitResponseMeta;
        const wrapped = Object.create(c, { emitResponseMeta: { value: (k: string, m: unknown) => { if (k === 'retrieval') meta = m as Record<string, unknown>; emit?.call(c, k, m); } } });
        const out = await handler(emit ? wrapped : ctx, p) as Record<string, unknown> | unknown[];
        const rows = (Array.isArray(out) ? out : (out as Record<string, unknown>)?.results ?? []) as Array<Record<string, unknown>>;
        log({
          ev: 'query', params: { query: p.query, keys: Object.keys(p).sort(), limit: p.limit ?? null, token_budget: p.token_budget ?? null, return_unit: p.return_unit ?? null, expand: p.expand ?? null, min_trust: p.min_trust ?? null },
          rows: rows.map(r => {
            const text = String(r.chunk_text ?? r.text ?? '');
            return { slug: r.slug, result_type: r.result_type ?? null, chunk_id: r.chunk_id ?? null, fact_id: r.fact_id ?? null,
              trust_tier: r.trust_tier ?? null, origin: r.origin ?? null, unconfirmed: r.unconfirmed ?? null, text_sha: sha(text), text_len: text.length };
          }),
          delivery: meta?.delivery ?? null, degraded: meta?.degraded ?? null, expansion_applied: meta?.expansion_applied ?? null,
          shape: Array.isArray(out) ? 'array' : Object.keys(out ?? {}).sort(),
        });
        return out;
      });
    };
  }
}
