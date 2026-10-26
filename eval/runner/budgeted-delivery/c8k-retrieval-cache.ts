/**
 * The 8k conversion freeze's retrieval response cache (preregistration spec change 6). Real embeddings and the Voyage
 * reranker do not return bit-identical floats on repeated identical requests, so without it the same A0 query scores
 * its rows differently on repeat, near-ties swap, and gate 1 (A0 byte-identical on repeat) fails on provider noise.
 *
 * Embeddings go through H1's cache, gbrain's `EmbeddingCache` + `installEmbedCache` (src/eval/shared/embed-cache.ts,
 * as the e2-parallel freeze ran it), keyed `provider:model@dims#query:sha256(text)`: one value of an embedding request.
 * Rerank calls go through gbrain's rerank transport seam into a table keyed sha256 of [provider, endpoint path, model,
 * full request body], storing the response's status, content type and bytes; only 2xx responses are stored. A hit
 * returns the first call's bytes, so every arm and the repeat of a cell see one set of vectors and rerank scores.
 *
 * The cache lives in one cell's directory inside the custody root (<cell>/cache/retrieval), is never shared between
 * the development and held-out cells and is never committed. Only the freeze installs it: chat (readers, judge) and
 * extraction calls stay uncached. Each freeze process appends its hit/miss counts to stats.ndjson there.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = Record<string, any>;
type Transport = (url: string, init: RequestInit) => Promise<Response>;
export interface RetrievalCacheModules {
  EmbeddingCache: new (path: string) => { open(): void; close(): void; stats(): Row; canonicalSha256(): string };
  installEmbedCache: (cache: unknown, opts: { realTransport?: unknown }) => { uninstall(): void; model: string; dims: number };
  setRerankTransport: (fn: Transport | null) => void;
}
export interface RerankCounts { hits: number; misses: number; bypassed: number; uncached_errors: number }

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

/** The rerank key: provider (the path segment before /v1, `voyage` behind the lease proxy), endpoint path, model, body. */
export function rerankKey(url: string, body: string): { key: string; provider: string; endpoint: string; model: string } {
  const u = new URL(url);
  const provider = /\/([^/]+)\/v\d+\//.exec(u.pathname)?.[1] ?? u.hostname;
  let model = '';
  try { model = String(JSON.parse(body)?.model ?? ''); } catch { model = ''; }
  return { key: sha256(JSON.stringify([provider, u.pathname, model, body])), provider, endpoint: u.pathname, model };
}

/** A rerank transport that serves identical requests from `db` and stores 2xx responses from `real`. */
export function cachingRerankTransport(db: Database, real: Transport, counts: RerankCounts): Transport {
  db.exec(`CREATE TABLE IF NOT EXISTS rerank_cache (key TEXT PRIMARY KEY, provider TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL,
    status INTEGER NOT NULL, content_type TEXT NOT NULL, body BLOB NOT NULL) WITHOUT ROWID`);
  return async (url, init) => {
    if (typeof init.body !== 'string') { counts.bypassed++; return real(url, init); }
    const k = rerankKey(url, init.body);
    const row = db.query<{ status: number; content_type: string; body: Uint8Array }, [string]>('SELECT status, content_type, body FROM rerank_cache WHERE key = ?').get(k.key);
    if (row) { counts.hits++; return new Response(row.body as unknown as BodyInit, { status: row.status, headers: { 'content-type': row.content_type } }); }
    counts.misses++;
    const res = await real(url, init);
    if (!res.ok) { counts.uncached_errors++; return res; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'application/json';
    db.query('INSERT OR REPLACE INTO rerank_cache (key, provider, endpoint, model, status, content_type, body) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(k.key, k.provider, k.endpoint, k.model, res.status, contentType, bytes);
    return new Response(bytes, { status: res.status, headers: { 'content-type': contentType } });
  };
}

/** Install both caches for one freeze process; `close` uninstalls them and appends this process's counts to stats.ndjson. */
export function installRetrievalCache(m: RetrievalCacheModules, dir: string, opts: { embedTransport?: unknown; fetchImpl?: Transport } = {}) {
  mkdirSync(dir, { recursive: true });
  const embed = new m.EmbeddingCache(join(dir, 'embed.sqlite'));
  const installed = m.installEmbedCache(embed, { realTransport: opts.embedTransport ?? null });
  const db = new Database(join(dir, 'rerank.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  const rerank: RerankCounts = { hits: 0, misses: 0, bypassed: 0, uncached_errors: 0 };
  m.setRerankTransport(cachingRerankTransport(db, opts.fetchImpl ?? ((u, init) => fetch(u, init)), rerank));
  return {
    close(): Row {
      const e = embed.stats();
      const line = { at: new Date().toISOString(), embed: { model: `${installed.model}@${installed.dims}`, hits: e.hits, misses: e.misses, bypassed: e.bypassed, infra_faults: e.infra_faults }, rerank: { ...rerank } };
      installed.uninstall();
      m.setRerankTransport(null);
      embed.close();
      db.close();
      appendFileSync(join(dir, 'stats.ndjson'), JSON.stringify(line) + '\n');
      return line;
    },
  };
}

/** The receipt: every freeze process's counts summed, and the cache files' content hashes (never their contents). */
export function retrievalCacheReceipt(m: RetrievalCacheModules, dir: string): Row {
  const lines = existsSync(join(dir, 'stats.ndjson')) ? readFileSync(join(dir, 'stats.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const sum = (part: 'embed' | 'rerank', f: string) => lines.reduce((n, l) => n + Number(l[part]?.[f] ?? 0), 0);
  const embed = new m.EmbeddingCache(join(dir, 'embed.sqlite'));
  embed.open();
  const embedSha = embed.canonicalSha256();
  embed.close();
  const db = new Database(join(dir, 'rerank.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS rerank_cache (key TEXT PRIMARY KEY, provider TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL,
    status INTEGER NOT NULL, content_type TEXT NOT NULL, body BLOB NOT NULL) WITHOUT ROWID`);
  const h = createHash('sha256');
  const rows = db.query<{ key: string; status: number; body: Uint8Array }, []>('SELECT key, status, body FROM rerank_cache ORDER BY key').all();
  for (const r of rows) h.update(`${r.key}\0${r.status}\0${sha256(r.body)}\n`);
  db.close();
  return {
    spec_change: 6, scope: 'this cell only (<cell>/cache/retrieval inside the custody root), never committed', processes: lines.length,
    embed: { cache: 'H1 EmbeddingCache (gbrain src/eval/shared/embed-cache.ts)', key: 'provider:model@dims#query:sha256(text)', models: [...new Set(lines.map(l => l.embed?.model))],
      hits: sum('embed', 'hits'), misses: sum('embed', 'misses'), bypassed: sum('embed', 'bypassed'), infra_faults: sum('embed', 'infra_faults'), canonical_sha256: embedSha },
    rerank: { key: 'sha256([provider, endpoint path, model, full request body])', hits: sum('rerank', 'hits'), misses: sum('rerank', 'misses'), bypassed: sum('rerank', 'bypassed'),
      uncached_errors: sum('rerank', 'uncached_errors'), rows: rows.length, canonical_sha256: h.digest('hex') },
    uncached: 'chat (readers, judge) and extraction calls',
  };
}
