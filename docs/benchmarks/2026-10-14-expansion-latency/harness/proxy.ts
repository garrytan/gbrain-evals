// Metering and freezing provider proxy for the GBRA-94 query-expansion eval.
// gbrain's provider_base_urls (and GOOGLE_GENERATIVE_AI_BASE_URL) point here as
// http://127.0.0.1:PORT/<worker>/{voyage/v1, anthropic, openai/v1, google/v1beta}.
//
// Freezing (only expansion varies between arms):
//   embeddings : cached per input text (key = request fields minus `input`, plus the text). A batch is answered from the
//                cache; only the missing texts go upstream, once. Every arm therefore sees identical vectors for a text.
//   rerank     : cached per (model, query, document) score. A request is answered from cached pair scores; only the
//                missing documents go upstream, once. Identical candidates get identical scores in every arm.
//   expansion  : the LLM call is never shared between arms. Within one arm a retried query reuses its own call.
// Modes per worker (POST /control/<worker>): install (everything forwarded), build (embeddings only; LLMs refused),
// arm (everything; LLM calls metered and timed).
// Every upstream call is priced from the provider's usage counts into ledger.ndjson; a call that would pass CAP_USD is
// refused (402) before it leaves.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.EVAL_ROOT ?? (() => { throw new Error('set EVAL_ROOT to the run directory'); })();
const CAP_USD = Number(process.env.CAP_USD ?? '4.75');
const PORT = Number(process.env.PROXY_PORT ?? '8790');
for (const d of ['cache/embed', 'cache/pair', 'cache/llm']) mkdirSync(join(ROOT, d), { recursive: true });
const LEDGER = join(ROOT, 'ledger.ndjson');
const CALLS = join(ROOT, 'calls.ndjson');
const EVENTS = join(ROOT, 'proxy-events.ndjson');

// List prices, USD per million tokens. [input, output]; output includes reasoning/thinking tokens.
const LLM_PRICE: Record<string, [number, number]> = {
  'claude-haiku-4-5-20251001': [1.0, 5.0],
  'claude-haiku-5-5': [0.10, 0.50],
  'gpt-6-luna': [0.10, 0.50],
  'gemini-3.8-flash': [0.75, 3.75],
};
const VOYAGE_PRICE: Record<string, number> = { 'voyage-4': 0.06, 'rerank-2.5': 0.05 };

let spent = 0;
if (existsSync(LEDGER)) for (const l of readFileSync(LEDGER, 'utf8').split('\n')) if (l) spent += JSON.parse(l).usd;

type Control = { mode: 'install' | 'build' | 'arm'; key?: string; arm?: string; phase?: string };
const controls = new Map<string, Control>();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const event = (o: Record<string, unknown>) => appendFileSync(EVENTS, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const callLog = (o: Record<string, unknown>) => appendFileSync(CALLS, JSON.stringify({ t: Date.now(), ...o }) + '\n');

function charge(worker: string, ctl: Control, provider: string, model: string, tin: number, tout: number, usd: number) {
  spent += usd;
  appendFileSync(LEDGER, JSON.stringify({ t: new Date().toISOString(), worker, phase: ctl.phase ?? ctl.mode, arm: ctl.arm, provider, model, tin, tout, usd, key: ctl.key }) + '\n');
}

async function upstream(url: string, init: { method?: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; text: string; attempts: number; ms: number }> {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    try {
      const r = await fetch(url, { method: init.method ?? 'POST', headers: { 'content-type': 'application/json', ...init.headers }, body: init.body, signal: AbortSignal.timeout(120_000) });
      const text = await r.text();
      const ms = performance.now() - t0;
      if ((r.status === 429 || r.status >= 500) && attempt < 4) { await Bun.sleep(1000 * 2 ** attempt); continue; }
      return { status: r.status, text, attempts: attempt + 1, ms };
    } catch (e) {
      if (attempt < 4) { await Bun.sleep(1000 * 2 ** attempt); continue; }
      return { status: 599, text: JSON.stringify({ error: String(e) }), attempts: attempt + 1, ms: performance.now() - t0 };
    }
  }
}
const voyageHeaders = () => ({ authorization: `Bearer ${process.env.VOYAGE_API_KEY}` });
const capRefusal = (worker: string, provider: string) => { event({ worker, kind: 'cap_refusal', provider, spent }); return json(402, { error: { message: 'gbra94 proxy: budget cap' } }); };

async function embeddings(worker: string, ctl: Control, body: string): Promise<Response> {
  const req = JSON.parse(body);
  const inputs: string[] = Array.isArray(req.input) ? req.input : [req.input];
  const { input: _drop, ...rest } = req;
  const base = JSON.stringify(rest);
  const keys = inputs.map(t => sha(base + '\0' + t));
  const missing = [...new Set(inputs.filter((_, i) => !existsSync(join(ROOT, 'cache/embed', keys[i] + '.json'))))];
  let upstreamMs = 0, billed = 0;
  if (missing.length) {
    const chars = missing.reduce((a, s) => a + s.length, 0);
    if (spent + chars / 3 * (VOYAGE_PRICE[req.model] ?? 0.12) / 1e6 > CAP_USD) return capRefusal(worker, 'voyage-embed');
    const r = await upstream('https://api.voyageai.com/v1/embeddings', { headers: voyageHeaders(), body: JSON.stringify({ ...rest, input: missing }) });
    upstreamMs = r.ms;
    if (r.status !== 200) { event({ worker, kind: 'upstream_error', provider: 'voyage-embed', status: r.status, body: r.text.slice(0, 300) }); return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } }); }
    const resp = JSON.parse(r.text);
    billed = resp.usage?.total_tokens ?? 0;
    charge(worker, ctl, 'voyage', req.model, billed, 0, billed * (VOYAGE_PRICE[req.model] ?? 0.12) / 1e6);
    for (const d of resp.data) writeFileSync(join(ROOT, 'cache/embed', sha(base + '\0' + missing[d.index]) + '.json'), JSON.stringify(d.embedding));
  }
  const data = keys.map((k, index) => ({ object: 'embedding', embedding: JSON.parse(readFileSync(join(ROOT, 'cache/embed', k + '.json'), 'utf8')), index }));
  if (ctl.mode === 'arm') callLog({ kind: 'embed', worker, arm: ctl.arm, key: ctl.key, n: inputs.length, missing: missing.length, upstream_ms: missing.length ? upstreamMs : null, billed });
  return json(200, { object: 'list', data, model: req.model, usage: { total_tokens: billed } });
}

async function rerank(worker: string, ctl: Control, body: string): Promise<Response> {
  const req = JSON.parse(body);
  const { query, documents, model } = req as { query: string; documents: string[]; model: string };
  const topKey = req.top_k !== undefined ? 'top_k' : req.top_n !== undefined ? 'top_n' : null;
  const pairFile = (d: string) => join(ROOT, 'cache/pair', sha(`${model}\0${query}\0${d}`) + '.json');
  const missing = [...new Set(documents.filter(d => !existsSync(pairFile(d))))];
  let upstreamMs = 0, billed = 0;
  if (missing.length) {
    const est = missing.reduce((a, d) => a + (d.length + query.length) / 3.5, 0) * 1.3 * (VOYAGE_PRICE[model] ?? 0.05) / 1e6;
    if (spent + est > CAP_USD) return capRefusal(worker, 'voyage-rerank');
    const r = await upstream('https://api.voyageai.com/v1/rerank', { headers: voyageHeaders(), body: JSON.stringify({ model, query, documents: missing }) });
    upstreamMs = r.ms;
    if (r.status !== 200) { event({ worker, kind: 'upstream_error', provider: 'voyage-rerank', status: r.status, body: r.text.slice(0, 300), key: ctl.key }); return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } }); }
    const resp = JSON.parse(r.text);
    billed = resp.usage?.total_tokens ?? 0;
    charge(worker, ctl, 'voyage', model, billed, 0, billed * (VOYAGE_PRICE[model] ?? 0.05) / 1e6);
    for (const it of resp.data ?? resp.results) writeFileSync(pairFile(missing[it.index]), JSON.stringify(it.relevance_score));
  }
  let data = documents.map((d, index) => ({ index, relevance_score: JSON.parse(readFileSync(pairFile(d), 'utf8')) as number }))
    .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
  if (topKey) data = data.slice(0, req[topKey]);
  if (ctl.mode === 'arm') callLog({ kind: 'rerank', worker, arm: ctl.arm, key: ctl.key, n: documents.length, missing: missing.length, upstream_ms: missing.length ? upstreamMs : null, billed });
  return json(200, { object: 'list', data, model, usage: { total_tokens: billed } });
}

type Usage = { model: string; tin: number; tout: number };
async function llm(worker: string, ctl: Control, provider: string, url: string, headers: Record<string, string>, body: string, usage: (resp: any, req: any) => Usage, maxOut: number): Promise<Response> {
  const req = JSON.parse(body);
  if (ctl.mode === 'build') { event({ worker, kind: 'llm_refused_build', provider }); return json(400, { error: { type: 'invalid_request_error', message: 'gbra94 proxy: LLM refused during build' } }); }
  const cacheFile = join(ROOT, 'cache/llm', sha(`${ctl.arm}\0${ctl.key}\0${provider}\0${url}\0${body}`) + '.json');
  if (ctl.mode === 'arm' && existsSync(cacheFile)) {
    callLog({ kind: 'llm', worker, arm: ctl.arm, key: ctl.key, provider, cached: true });
    return new Response(readFileSync(cacheFile, 'utf8'), { headers: { 'content-type': 'application/json' } });
  }
  const modelGuess = String(req.model ?? url.match(/models\/([^:]+):/)?.[1] ?? '');
  const price = LLM_PRICE[modelGuess] ?? [5, 25];
  if (spent + (body.length / 3 * price[0] + maxOut * price[1]) / 1e6 > CAP_USD) return capRefusal(worker, provider);
  const r = await upstream(url, { headers, body });
  if (r.status !== 200) {
    event({ worker, kind: 'upstream_error', provider, status: r.status, body: r.text.slice(0, 400), key: ctl.key, arm: ctl.arm });
    callLog({ kind: 'llm', worker, arm: ctl.arm, key: ctl.key, provider, status: r.status, upstream_ms: r.ms, attempts: r.attempts });
    return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } });
  }
  const resp = JSON.parse(r.text);
  const u = usage(resp, req);
  const p = LLM_PRICE[u.model] ?? LLM_PRICE[modelGuess] ?? [5, 25];
  if (!LLM_PRICE[u.model] && !LLM_PRICE[modelGuess]) event({ worker, kind: 'unpriced_model', provider, model: u.model });
  const usd = (u.tin * p[0] + u.tout * p[1]) / 1e6;
  charge(worker, ctl, provider, u.model, u.tin, u.tout, usd);
  if (ctl.mode === 'arm') { writeFileSync(cacheFile, r.text); callLog({ kind: 'llm', worker, arm: ctl.arm, key: ctl.key, provider, model: u.model, status: 200, upstream_ms: r.ms, attempts: r.attempts, tin: u.tin, tout: u.tout, usd }); }
  return new Response(r.text, { headers: { 'content-type': 'application/json' } });
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
      if (path.endsWith('/embeddings')) return embeddings(worker, ctl, body);
      event({ worker, kind: 'unknown_route', provider, path });
      return json(400, { error: { message: `gbra94 proxy: unsupported voyage route ${path}` } });
    }
    if (provider === 'anthropic') {
      const headers: Record<string, string> = { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': request.headers.get('anthropic-version') ?? '2023-06-01' };
      const beta = request.headers.get('anthropic-beta'); if (beta) headers['anthropic-beta'] = beta;
      if (request.method !== 'POST') { const r = await upstream(`https://api.anthropic.com${path}${url.search}`, { method: 'GET', headers }); return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } }); }
      return llm(worker, ctl, 'anthropic', `https://api.anthropic.com${path}`, headers, body,
        (resp, req) => { const u = resp.usage ?? {}; return { model: resp.model ?? req.model, tin: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), tout: u.output_tokens ?? 0 }; }, 1000);
    }
    if (provider === 'openai') {
      const headers = { authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
      if (request.method !== 'POST') { const r = await upstream(`https://api.openai.com${path}${url.search}`, { method: 'GET', headers }); return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } }); }
      return llm(worker, ctl, 'openai', `https://api.openai.com${path}`, headers, body,
        (resp, req) => { const u = resp.usage ?? {}; return { model: String(req.model ?? resp.model), tin: u.prompt_tokens ?? u.input_tokens ?? 0, tout: u.completion_tokens ?? u.output_tokens ?? 0 }; }, 2000);
    }
    if (provider === 'google') {
      const headers = { 'x-goog-api-key': process.env.GEMINI_API_KEY! };
      if (request.method !== 'POST') { const r = await upstream(`https://generativelanguage.googleapis.com${path}`, { method: 'GET', headers }); return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } }); }
      return llm(worker, ctl, 'google', `https://generativelanguage.googleapis.com${path}`, headers, body,
        (resp) => { const u = resp.usageMetadata ?? {}; return { model: String(resp.modelVersion ?? path.match(/models\/([^:]+):/)?.[1]), tin: u.promptTokenCount ?? 0, tout: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) }; }, 4000);
    }
    event({ worker, kind: 'refused_provider', provider, path, mode: ctl.mode });
    return json(400, { error: { message: `gbra94 proxy: provider ${provider} refused` } });
  },
});
console.log(`gbra94 proxy on ${PORT}, spent so far $${spent.toFixed(4)} of $${CAP_USD}`);
