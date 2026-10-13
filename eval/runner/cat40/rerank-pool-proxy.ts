/**
 * Provider proxy for the Cat 40 rerank-pool replay (rerank-pool-replay.ts).
 *
 * The replayed gbrain server sends its query embeddings and reranks here
 * (`/<slot>/openai/...`, `/<slot>/voyage/...`, the same URL shape as
 * MeteringProxy, so GbrainSlot works unchanged). For each replayed call the
 * runner binds the slot to a key; every provider request made during the call
 * is captured under that key: rerank query, the SHA-256 of each document in
 * the order gbrain sent it (the fused pool), the provider status, the billed
 * tokens, and whether the answer was reused.
 *
 * Two upstreams:
 *   forward  requests go to the real provider through the process's fetch, which
 *            the budget ledger's paid-request guard wraps (startPaidRun), so each
 *            one is reserved before it leaves and a refused reservation never sends.
 *   stub     keyless: deterministic hashed bag-of-words embeddings and a lexical
 *            overlap reranker, or a reranker that answers HTTP 500 (the failure
 *            fixture). Nothing leaves the process.
 *
 * Two reuses, both checked rather than assumed:
 *   - Query embeddings are cached by request body, so the second arm sends the
 *     reranker the same fused order only because it saw byte-identical query
 *     vectors. Whether the 25 pool really is a prefix of the 50 pool is then
 *     verified per call from the captured document hashes.
 *   - A 25-document rerank whose documents equal the first 25 of a captured
 *     50-document rerank of the same query and model can be answered from that
 *     response (a cross-encoder scores each query-document pair on its own).
 *     The first `reuseAuditCalls` such requests also go to the provider and
 *     the two orders are compared; one disagreement turns reuse off for the
 *     rest of the run. Reused answers bill no tokens and are marked.
 *
 * Any other route (chat, expansion) is refused with HTTP 403 and captured, so
 * a replay that unexpectedly calls an LLM shows up in the receipts.
 */
import { createHash } from 'node:crypto';
import { UPSTREAM, type ProviderName } from '../metering-proxy.ts';

export type StubRerank = 'lexical' | 'fail';

export interface RerankCapture {
  kind: 'rerank';
  model: string;
  query: string;
  /** SHA-256 (hex, first 16) of each document, in the order gbrain sent them. */
  doc_sha: string[];
  status: number;
  /** Billed tokens the provider reported (0 for a reused answer). */
  tokens: number;
  /** Tokens this request would bill if sent: query tokens times documents plus document tokens, at 4 characters per token. */
  est_tokens: number;
  reused: boolean;
  /** Reuse audit: the request was answerable from cache and was also sent; whether the orders agreed. */
  audit?: { agreed: boolean; max_abs_score_diff: number };
  /** Indices in relevance order, as answered to gbrain. */
  order: number[];
  error?: string;
}
export interface EmbeddingCapture { kind: 'embedding'; model: string; inputs: number; status: number; tokens: number; cached: boolean; error?: string }
export interface OtherCapture { kind: 'refused'; provider: string; path: string }
export type Capture = RerankCapture | EmbeddingCapture | OtherCapture;

export interface ReplayProxyOptions {
  upstream: 'forward' | 'stub';
  stubRerank?: StubRerank;
  /** Answer a 25-document rerank from a captured 50-document one when its documents are a verified prefix. */
  reuseRerank?: boolean;
  /** Reusable requests also sent for real and compared before reuse is trusted. */
  reuseAuditCalls?: number;
  /** Test seam: the fetch used for forward mode (defaults to globalThis.fetch, which the paid guard wraps). */
  fetchImpl?: typeof fetch;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
export const docSha = sha;

/** Tokens a rerank request bills: query tokens per document plus document tokens (Voyage counts both), at 4 characters per token. */
export function rerankTokenEstimate(query: string, documents: string[]): number {
  const t = (s: string) => Math.ceil(s.length / 4);
  return t(query) * documents.length + documents.reduce((n, d) => n + t(d), 0);
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Deterministic hashed bag-of-words embedding, L2-normalized (keyless stand-in; scores are not search quality). */
export function stubEmbedding(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const w of words(text)) {
    const h = createHash('sha256').update(w).digest();
    v[h.readUInt32LE(0) % dims] += h[4] & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

/** Deterministic lexical reranker: share of query words in the document, ties broken by a hash of the document. */
export function stubRerankScores(query: string, documents: string[]): Array<{ index: number; relevance_score: number }> {
  const q = new Set(words(query));
  return documents.map((d, index) => {
    const dw = new Set(words(d));
    let hit = 0;
    for (const w of q) if (dw.has(w)) hit++;
    const tie = parseInt(sha(d).slice(0, 6), 16) / 0xffffff / 1000;
    return { index, relevance_score: Number(((q.size ? hit / q.size : 0) * 0.99 + tie).toFixed(6)) };
  }).sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
}

/** The stub provider's answer to one request, or null for a route it does not serve. */
export function stubProviderResponse(provider: ProviderName, path: string, body: Record<string, any>, stubRerank: StubRerank = 'lexical'): Response | null {
  if (provider === 'openai' && /\/embeddings$/.test(path)) {
    const inputs: string[] = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? '')];
    const dims = typeof body.dimensions === 'number' ? body.dimensions : /3-large/.test(String(body.model)) ? 3072 : 1536;
    const tokens = inputs.reduce((n, s) => n + Math.ceil(s.length / 4), 0);
    const data = inputs.map((s, index) => {
      const e = stubEmbedding(s, dims);
      return { object: 'embedding', index, embedding: body.encoding_format === 'base64' ? Buffer.from(new Float32Array(e).buffer).toString('base64') : e };
    });
    return Response.json({ object: 'list', data, model: body.model, usage: { prompt_tokens: tokens, total_tokens: tokens } });
  }
  if (provider === 'voyage' && /\/rerank$/.test(path)) {
    if (stubRerank === 'fail') return Response.json({ detail: 'stub reranker failure fixture' }, { status: 500 });
    const documents: string[] = (body.documents ?? []).map(String);
    return Response.json({ object: 'list', data: stubRerankScores(String(body.query ?? ''), documents), model: body.model, usage: { total_tokens: rerankTokenEstimate(String(body.query ?? ''), documents) } });
  }
  return null;
}

interface CachedRerank { model: string; query: string; doc_sha: string[]; data: Array<{ index: number; relevance_score: number }> }

/** Agreement of a reused answer with the provider's own: identical index order and the largest score difference. */
export function compareRerank(reused: Array<{ index: number; relevance_score: number }>, real: Array<{ index: number; relevance_score: number }>): { agreed: boolean; max_abs_score_diff: number } {
  const byIndex = new Map(real.map(r => [r.index, r.relevance_score]));
  let diff = 0;
  for (const r of reused) diff = Math.max(diff, Math.abs(r.relevance_score - (byIndex.get(r.index) ?? Number.POSITIVE_INFINITY)));
  const sameOrder = reused.length === real.length && reused.every((r, i) => r.index === real[i].index);
  return { agreed: sameOrder, max_abs_score_diff: Number(diff.toFixed(6)) };
}

export class RerankPoolProxy {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private bindings = new Map<string, string>();
  private captures = new Map<string, Capture[]>();
  private embedCache = new Map<string, string>();
  private rerankCache = new Map<string, CachedRerank[]>();
  private auditsLeft: number;
  /** Reuse state for the receipt: whether it is still on and every audit made. */
  readonly reuse: { enabled: boolean; audits: Array<{ key: string; agreed: boolean; max_abs_score_diff: number }>; reused: number; disabled_reason: string | null };
  constructor(private options: ReplayProxyOptions) {
    this.auditsLeft = options.reuseAuditCalls ?? 20;
    this.reuse = { enabled: options.reuseRerank !== false, audits: [], reused: 0, disabled_reason: null };
  }
  get port(): number { return this.server!.port as number; }
  /** Stub upstream only: switch the reranker between the lexical scorer and the failure fixture (per arm). */
  setStubRerank(mode: StubRerank) { this.options.stubRerank = mode; }
  bind(slot: string, key: string) { this.bindings.set(slot, key); }
  unbind(slot: string) { this.bindings.delete(slot); }
  /** Remove and return the requests captured under `key`. */
  take(key: string): Capture[] { const c = this.captures.get(key) ?? []; this.captures.delete(key); return c; }
  private record(key: string, c: Capture) { const list = this.captures.get(key) ?? []; list.push(c); this.captures.set(key, list); }

  start() {
    this.server = Bun.serve({
      port: 0, hostname: '127.0.0.1', idleTimeout: 0,
      fetch: async req => {
        const url = new URL(req.url);
        const m = url.pathname.match(/^\/(?:([^/]+)\/)?(anthropic|openai|voyage)(\/.*)$/);
        const slot = m?.[1] ?? 'default';
        const key = this.bindings.get(slot) ?? `slot:${slot}`;
        if (!m) return Response.json({ error: { message: `rerank-pool proxy: no route ${url.pathname}` } }, { status: 404 });
        const provider = m[2] as ProviderName, path = m[3];
        const raw = req.method === 'GET' ? '' : await req.text();
        let body: Record<string, any> = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON bodies are refused below */ }
        if (provider === 'openai' && /\/embeddings$/.test(path)) return this.embedding(key, path, raw, body, req.headers);
        if (provider === 'voyage' && /\/rerank$/.test(path)) return this.rerank(key, path, raw, body, req.headers);
        this.record(key, { kind: 'refused', provider, path });
        return Response.json({ error: { type: 'invalid_request', message: `rerank-pool proxy: ${provider}${path} is not part of a rerank replay` } }, { status: 403 });
      },
    });
  }
  stop() { this.server?.stop(true); }

  private async send(provider: ProviderName, path: string, raw: string, body: Record<string, any>, headers: Headers): Promise<Response> {
    if (this.options.upstream === 'stub') return stubProviderResponse(provider, path, body, this.options.stubRerank)!;
    const out = new Headers(headers);
    for (const h of ['host', 'content-length', 'accept-encoding', 'connection']) out.delete(h);
    return (this.options.fetchImpl ?? globalThis.fetch)(`${UPSTREAM[provider]}${path}`, { method: 'POST', headers: out, body: raw });
  }

  private async embedding(key: string, path: string, raw: string, body: Record<string, any>, headers: Headers): Promise<Response> {
    const inputs = Array.isArray(body.input) ? body.input.length : 1;
    const cacheKey = sha(`${path}\u0000${raw}`);
    const hit = this.embedCache.get(cacheKey);
    if (hit) {
      this.record(key, { kind: 'embedding', model: String(body.model ?? ''), inputs, status: 200, tokens: 0, cached: true });
      return new Response(hit, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    let res: Response;
    try { res = await this.send('openai', path, raw, body, headers); }
    catch (e) {
      this.record(key, { kind: 'embedding', model: String(body.model ?? ''), inputs, status: 0, tokens: 0, cached: false, error: (e as Error).message.slice(0, 300) });
      return Response.json({ error: { message: `rerank-pool proxy: ${(e as Error).message}` } }, { status: 502 });
    }
    const text = await res.text();
    let tokens = 0;
    try { tokens = Number(JSON.parse(text)?.usage?.total_tokens ?? 0); } catch { /* reported as 0 */ }
    if (res.ok) this.embedCache.set(cacheKey, text);
    this.record(key, { kind: 'embedding', model: String(body.model ?? ''), inputs, status: res.status, tokens, cached: false, ...(res.ok ? {} : { error: text.slice(0, 300) }) });
    return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
  }

  private reusable(model: string, query: string, docSha: string[]): CachedRerank | null {
    for (const c of this.rerankCache.get(`${model}\u0000${query}`) ?? []) {
      if (c.doc_sha.length > docSha.length && docSha.every((h, i) => c.doc_sha[i] === h)) return c;
    }
    return null;
  }

  private async rerank(key: string, path: string, raw: string, body: Record<string, any>, headers: Headers): Promise<Response> {
    const model = String(body.model ?? ''), query = String(body.query ?? '');
    const documents: string[] = (body.documents ?? []).map(String);
    const doc_sha = documents.map(sha);
    const base = { kind: 'rerank' as const, model, query, doc_sha, est_tokens: rerankTokenEstimate(query, documents) };
    const cached = this.reuse.enabled ? this.reusable(model, query, doc_sha) : null;
    const fromCache = cached ? cached.data.filter(r => r.index < documents.length) : null;
    if (fromCache && this.auditsLeft <= 0) {
      this.reuse.reused++;
      this.record(key, { ...base, status: 200, tokens: 0, reused: true, order: fromCache.map(r => r.index) });
      return Response.json({ object: 'list', data: fromCache, model, usage: { total_tokens: 0 } });
    }
    let res: Response;
    try { res = await this.send('voyage', path, raw, body, headers); }
    catch (e) {
      this.record(key, { ...base, status: 0, tokens: 0, reused: false, order: [], error: (e as Error).message.slice(0, 300) });
      return Response.json({ error: { message: `rerank-pool proxy: ${(e as Error).message}` } }, { status: 502 });
    }
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* recorded below */ }
    const data: Array<{ index: number; relevance_score: number }> | null = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.results) ? parsed.results : null;
    const ok = res.ok && !!data && data.length > 0;
    let audit: RerankCapture['audit'];
    if (fromCache && ok) {
      this.auditsLeft--;
      audit = compareRerank(fromCache, data!);
      this.reuse.audits.push({ key, ...audit });
      if (!audit.agreed) { this.reuse.enabled = false; this.reuse.disabled_reason = `audit ${key}: a reused 25-document answer ordered documents differently from the provider's own answer`; }
    }
    if (ok && !cached) (this.rerankCache.get(`${model}\u0000${query}`) ?? this.rerankCache.set(`${model}\u0000${query}`, []).get(`${model}\u0000${query}`)!).push({ model, query, doc_sha, data: data! });
    this.record(key, { ...base, status: res.status, tokens: Number(parsed?.usage?.total_tokens ?? 0), reused: false, order: ok ? data!.map(r => r.index) : [], ...(audit ? { audit } : {}), ...(ok ? {} : { error: text.slice(0, 300) }) });
    return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
  }
}
