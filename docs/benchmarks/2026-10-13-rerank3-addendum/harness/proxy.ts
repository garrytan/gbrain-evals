// Metering, caching and cell-rewriting provider proxy for the GBRA-86 reranker-settings eval.
// gbrain's provider_base_urls point here as http://127.0.0.1:PORT/<worker>/{voyage/v1,anthropic,openai/v1}.
// Per worker the harness sets a mode through POST /control/<worker>:
//   build   : embeddings forwarded (cached by body); anthropic/openai refused and logged
//   capture : embeddings + anthropic forwarded and cached by body; rerank requests are frozen to disk and refused (400)
//   cell    : embeddings + anthropic served from cache only; rerank checked against the frozen list, cut to the
//             cell's candidate count, trimmed to the cell's token cap and sent with the cell's model (cached)
// Every upstream call is priced from the provider's usage counts into ledger.ndjson; a call that would pass CAP_USD
// is refused (402) before it leaves.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens } from '../gbrain/src/core/chunkers/token-estimate.ts';
import { truncateUtf8 } from '../gbrain/src/core/text-safe.ts';

const ROOT = process.env.EVAL_ROOT ?? (() => { throw new Error('set EVAL_ROOT to the run directory'); })();
const CAP_USD = Number(process.env.CAP_USD ?? '7.5');
const PORT = Number(process.env.PROXY_PORT ?? '8790');
for (const d of ['cache/body', 'cache/rerank', 'frozen']) mkdirSync(join(ROOT, d), { recursive: true });
const LEDGER = join(ROOT, process.env.LEDGER_FILE ?? 'ledger.ndjson');
const CELL_CALLS = join(ROOT, process.env.CELL_CALLS_FILE ?? 'cell-calls.ndjson');
const RERANK_TAG = process.env.RERANK_TAG ?? '';
const EVENTS = join(ROOT, 'proxy-events.ndjson');

const PRICE_PER_M: Record<string, number> = {
  'voyage-4': 0.06, 'rerank-2.5': 0.05, 'rerank-2.5-lite': 0.02, 'rerank-3': 0.05, 'rerank-3-lite': 0.02,
};
const HAIKU_IN = 1.0, HAIKU_OUT = 5.0;

let spent = 0;
if (existsSync(LEDGER)) for (const l of readFileSync(LEDGER, 'utf8').split('\n')) if (l) spent += JSON.parse(l).usd;

type Cell = { n: number; t: number; model: string; id: string };
type Control = { mode: 'install' | 'build' | 'capture' | 'cell'; key?: string; cell?: Cell; phase?: string };
const controls = new Map<string, Control>();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const event = (o: Record<string, unknown>) => appendFileSync(EVENTS, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function charge(worker: string, phase: string, provider: string, model: string, tin: number, tout: number, usd: number, key?: string) {
  spent += usd;
  appendFileSync(LEDGER, JSON.stringify({ t: new Date().toISOString(), worker, phase, provider, model, tin, tout, usd, key }) + '\n');
}

// rerank.ts's capRerankDoc with RERANK_MAX_DOC_TOKENS = cap (char pre-cap 6000 unchanged).
export function capDoc(text: string, cap: number): string {
  if (text.length <= cap) return text;
  let doc = truncateUtf8(text, 6000);
  for (let i = 0; i < 4; i++) {
    const tokens = estimateTokens(doc);
    if (tokens <= cap) break;
    doc = truncateUtf8(doc, Math.floor(doc.length * (cap / tokens) * 0.95));
  }
  return doc;
}

async function upstream(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string; attempts: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(120_000) });
      const text = await r.text();
      if ((r.status === 429 || r.status >= 500) && attempt < 4) { await Bun.sleep(1000 * 2 ** attempt); continue; }
      return { status: r.status, text, attempts: attempt + 1 };
    } catch (e) {
      if (attempt < 4) { await Bun.sleep(1000 * 2 ** attempt); continue; }
      return { status: 599, text: JSON.stringify({ error: String(e) }), attempts: attempt + 1 };
    }
  }
}

const voyageHeaders = () => ({ authorization: `Bearer ${process.env.VOYAGE_API_KEY}` });

async function cachedBody(worker: string, ctl: Control, provider: string, url: string, headers: Record<string, string>, body: string, price: (resp: any, req: any) => { model: string; tin: number; tout: number; usd: number }, estimate: number) {
  const file = join(ROOT, 'cache/body', sha(provider + '\0' + body) + '.json');
  if (existsSync(file)) return new Response(readFileSync(file, 'utf8'), { headers: { 'content-type': 'application/json' } });
  if (ctl.mode === 'cell') { event({ worker, kind: 'cell_cache_miss', provider, key: ctl.key, cell: ctl.cell?.id }); return json(400, { error: { message: 'gbra86 proxy: cache miss in cell mode' } }); }
  if (spent + estimate > CAP_USD) { event({ worker, kind: 'cap_refusal', provider, spent }); return json(402, { error: { message: 'gbra86 proxy: budget cap' } }); }
  const r = await upstream(url, headers, body);
  if (r.status === 200) {
    const resp = JSON.parse(r.text);
    const p = price(resp, JSON.parse(body));
    charge(worker, ctl.phase ?? ctl.mode, provider, p.model, p.tin, p.tout, p.usd, ctl.key);
    writeFileSync(file, r.text);
  } else event({ worker, kind: 'upstream_error', provider, status: r.status, body: r.text.slice(0, 300) });
  return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } });
}

async function rerank(worker: string, ctl: Control, body: string): Promise<Response> {
  const req = JSON.parse(body);
  const query: string = req.query;
  const documents: string[] = req.documents;
  const listHash = sha(JSON.stringify({ query, documents }));
  if (!ctl.key) return json(400, { error: { message: 'gbra86 proxy: no query key set' } });
  const frozenFile = join(ROOT, 'frozen', ctl.key + '.json');
  if (ctl.mode === 'capture') {
    if (existsSync(frozenFile)) {
      const prev = JSON.parse(readFileSync(frozenFile, 'utf8'));
      if (prev.list_hash !== listHash) event({ worker, kind: 'capture_drift', key: ctl.key });
    } else writeFileSync(frozenFile, JSON.stringify({ key: ctl.key, list_hash: listHash, model: req.model, request_keys: Object.keys(req).sort(), query, documents }));
    return json(400, { error: { message: 'gbra86 proxy: candidates frozen; rerank deferred to offline cells' } });
  }
  if (ctl.mode !== 'cell' || !ctl.cell) return json(400, { error: { message: 'gbra86 proxy: rerank outside a cell' } });
  const frozen = existsSync(frozenFile) ? JSON.parse(readFileSync(frozenFile, 'utf8')) : null;
  const match = frozen?.list_hash === listHash;
  if (!match) event({ worker, kind: 'frozen_mismatch', key: ctl.key, cell: ctl.cell.id, frozen: !!frozen });
  const { n, t, model } = ctl.cell;
  const docs = documents.slice(0, n).map(d => capDoc(d, t));
  const out = { ...req, model, documents: docs, ...(req.top_k !== undefined ? { top_k: Math.min(req.top_k, docs.length) } : {}) };
  const outBody = JSON.stringify(out);
  const cacheFile = join(ROOT, 'cache/rerank', sha(RERANK_TAG + outBody) + '.json');
  let upstreamMs: number | null = null;
  let attempts = 0;
  let text: string;
  if (existsSync(cacheFile)) text = readFileSync(cacheFile, 'utf8');
  else {
    const est = (docs.reduce((a, d) => a + estimateTokens(d), 0) + estimateTokens(query) * docs.length) * 1.3 * PRICE_PER_M[model] / 1e6;
    if (spent + est > CAP_USD) { event({ worker, kind: 'cap_refusal', provider: 'voyage-rerank', spent }); return json(402, { error: { message: 'gbra86 proxy: budget cap' } }); }
    const t0 = performance.now();
    const r = await upstream('https://api.voyageai.com/v1/rerank', voyageHeaders(), outBody);
    upstreamMs = performance.now() - t0;
    attempts = r.attempts;
    if (r.status !== 200) { event({ worker, kind: 'upstream_error', provider: 'voyage-rerank', status: r.status, body: r.text.slice(0, 300), key: ctl.key, cell: ctl.cell.id }); return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } }); }
    text = r.text;
    const tokens = JSON.parse(text).usage?.total_tokens ?? 0;
    charge(worker, `cell:${ctl.cell.id}`, 'voyage', model, tokens, 0, tokens * PRICE_PER_M[model] / 1e6, ctl.key);
    writeFileSync(cacheFile, text);
  }
  const resp = JSON.parse(text);
  appendFileSync(CELL_CALLS, JSON.stringify({ key: ctl.key, cell: ctl.cell.id, match, upstream_ms: upstreamMs, attempts, docs: docs.length, billed_tokens: resp.usage?.total_tokens ?? null, doc_tokens_est: docs.reduce((a, d) => a + estimateTokens(d), 0) }) + '\n');
  return new Response(text, { headers: { 'content-type': 'application/json' } });
}

Bun.serve({
  port: PORT, hostname: '127.0.0.1', idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'control') {
      if (request.method === 'GET') return json(200, { spent, cap: CAP_USD, controls: Object.fromEntries(controls) });
      controls.set(parts[1], await request.json() as Control);
      return json(200, { ok: true, spent });
    }
    const [worker, provider, ...rest] = parts;
    const ctl = controls.get(worker) ?? { mode: 'build' as const };
    const path = '/' + rest.join('/');
    const body = request.method === 'POST' ? await request.text() : '';
    if (provider === 'voyage') {
      if (path.endsWith('/rerank')) return rerank(worker, ctl, body);
      if (path.endsWith('/embeddings')) {
        const req = JSON.parse(body);
        const chars = (Array.isArray(req.input) ? req.input : [req.input]).reduce((a: number, s: string) => a + String(s).length, 0);
        return cachedBody(worker, ctl, 'voyage-embed', `https://api.voyageai.com${path.replace(/^\/v1/, '/v1')}`, voyageHeaders(), body,
          (resp) => { const t = resp.usage?.total_tokens ?? 0; return { model: req.model, tin: t, tout: 0, usd: t * (PRICE_PER_M[req.model] ?? 0.12) / 1e6 }; }, chars / 3 * 0.12 / 1e6);
      }
      event({ worker, kind: 'unknown_route', provider, path });
      return json(400, { error: { message: `gbra86 proxy: unsupported voyage route ${path}` } });
    }
    if (provider === 'anthropic') {
      const req = body ? JSON.parse(body) : {};
      event({ worker, kind: 'anthropic_call', mode: ctl.mode, path, model: req.model, key: ctl.key, max_tokens: req.max_tokens });
      if (ctl.mode === 'build') return json(400, { error: { type: 'invalid_request_error', message: 'gbra86 proxy: anthropic refused during build' } });
      const headers: Record<string, string> = { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': request.headers.get('anthropic-version') ?? '2023-06-01' };
      const beta = request.headers.get('anthropic-beta'); if (beta) headers['anthropic-beta'] = beta;
      return cachedBody(worker, ctl, 'anthropic', `https://api.anthropic.com${path}`, headers, body,
        (resp) => { const u = resp.usage ?? {}; const tin = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0); return { model: req.model, tin, tout: u.output_tokens ?? 0, usd: (tin * HAIKU_IN + (u.output_tokens ?? 0) * HAIKU_OUT) / 1e6 }; },
        (body.length / 3 * HAIKU_IN + (req.max_tokens ?? 1000) * HAIKU_OUT) / 1e6);
    }
    if (provider === 'openai' && ctl.mode === 'install') {
      event({ worker, kind: 'openai_call', mode: ctl.mode, path, bytes: body.length });
      if (request.method !== 'POST') { const r = await fetch(`https://api.openai.com${path}`, { headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }); return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } }); }
      const r = await upstream(`https://api.openai.com${path}`, { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body);
      try { const u = JSON.parse(r.text).usage ?? {}; const t = (u.total_tokens ?? u.prompt_tokens ?? 0); if (t) charge(worker, 'install', 'openai', 'openai', t, 0, t * 0.15 / 1e6); } catch {}
      return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } });
    }
    event({ worker, kind: 'refused_provider', provider, path, mode: ctl.mode });
    return json(400, { error: { message: `gbra86 proxy: provider ${provider} refused` } });
  },
});
console.log(`gbra86 proxy on ${PORT}, spent so far $${spent.toFixed(4)} of $${CAP_USD}`);
