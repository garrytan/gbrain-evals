/**
 * Provider batch transports: OpenAI Batch (`/v1/files` + `/v1/batches`) and
 * Anthropic Message Batches (`/v1/messages/batches`), plus each provider's
 * free input-token count endpoint. Results are normalized to one shape so the
 * lane settles and scores them the same way.
 *
 * Every call goes through the `fetch` given (default `globalThis.fetch`, which
 * the paid-request guard wraps): control calls are on the guard's free
 * allow-list, and submissions pass only inside `runInBatchLane`.
 */
import type { Provider } from './manifest.ts';

export interface BatchStatus {
  id: string;
  provider: Provider;
  /** Provider status string (OpenAI `status`, Anthropic `processing_status`). */
  status: string;
  /** No further results will appear. */
  ended: boolean;
  created_at_ms: number;
  /** Requests in the batch, as the provider counts them. */
  total: number;
  metadata: Record<string, string> | null;
  /** OpenAI reports batch-level usage; null elsewhere. */
  usage: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

export type ResultStatus = 'succeeded' | 'errored' | 'expired' | 'canceled' | 'missing';

export interface NormalizedResult {
  custom_id: string;
  status: ResultStatus;
  text: string | null;
  /** `stop` for a natural end, `max_tokens` when the output limit cut it off, else the provider's reason. */
  finish: string | null;
  usage: Record<string, unknown> | null;
  response_model: string | null;
  service_tier: string | null;
  error: string | null;
}

export interface BatchRequest { custom_id: string; body: Record<string, unknown> }

export interface BatchTransport {
  readonly provider: Provider;
  /** Optional upload step before create (OpenAI's input file); returns an opaque handle. */
  prepare(requests: BatchRequest[]): Promise<string | null>;
  create(requests: BatchRequest[], handle: string | null, metadata: Record<string, string>): Promise<BatchStatus>;
  get(id: string): Promise<BatchStatus>;
  /** Batches created at or after `sinceMs`, newest first. */
  list(sinceMs: number): Promise<BatchStatus[]>;
  results(batch: BatchStatus): Promise<NormalizedResult[]>;
  countTokens(body: Record<string, unknown>): Promise<number>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function call(fetchImpl: FetchLike, url: string, init: RequestInit, what: string): Promise<Response> {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new Error(`${what} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

const parseJsonl = (text: string) => text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Record<string, any>);

// ─── OpenAI ─────────────────────────────────────────────────────────

const OPENAI_ENDED = new Set(['completed', 'failed', 'expired', 'cancelled']);

function openaiStatus(b: Record<string, any>): BatchStatus {
  return {
    id: b.id, provider: 'openai', status: b.status, ended: OPENAI_ENDED.has(b.status), created_at_ms: (b.created_at ?? 0) * 1000,
    total: b.request_counts?.total ?? 0, metadata: b.metadata ?? null, usage: b.usage ?? null, raw: b,
  };
}

/** Normalize one OpenAI batch output or error line. */
export function normalizeOpenAiLine(line: Record<string, any>): NormalizedResult {
  const body = line.response?.body;
  const base = { custom_id: String(line.custom_id), text: null, finish: null, usage: null, response_model: null, service_tier: null };
  if (line.response?.status_code === 200 && body && Array.isArray(body.choices)) {
    const choice = body.choices[0] ?? {};
    const finish = choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason ?? null;
    return {
      ...base, status: 'succeeded', text: typeof choice.message?.content === 'string' ? choice.message.content : '', finish,
      usage: body.usage && typeof body.usage === 'object' ? body.usage : null, response_model: body.model ?? null, service_tier: body.service_tier ?? null, error: null,
    };
  }
  const err = line.error ?? body?.error ?? line.response;
  const code = String(err?.code ?? '');
  return { ...base, status: code === 'batch_expired' ? 'expired' : code === 'batch_cancelled' ? 'canceled' : 'errored', error: JSON.stringify(err ?? null).slice(0, 500) };
}

export function openAiTransport(options: { fetchImpl?: FetchLike; apiKey?: string; endpoint?: string } = {}): BatchTransport {
  const f: FetchLike = options.fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  const key = () => options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const auth = () => ({ authorization: `Bearer ${key()}` });
  const endpoint = options.endpoint ?? '/v1/chat/completions';
  const base = 'https://api.openai.com/v1';
  return {
    provider: 'openai',
    async prepare(requests) {
      const jsonl = requests.map(r => JSON.stringify({ custom_id: r.custom_id, method: 'POST', url: endpoint, body: r.body })).join('\n') + '\n';
      const form = new FormData();
      form.append('purpose', 'batch');
      form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch-input.jsonl');
      const file = await (await call(f, `${base}/files`, { method: 'POST', headers: auth(), body: form }, 'openai file upload')).json() as { id: string };
      return file.id;
    },
    async create(_requests, handle, metadata) {
      if (!handle) throw new Error('openai batch needs an uploaded input file');
      const b = await (await call(f, `${base}/batches`, {
        method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ input_file_id: handle, endpoint, completion_window: '24h', metadata }),
      }, 'openai batch create')).json();
      return openaiStatus(b);
    },
    async get(id) { return openaiStatus(await (await call(f, `${base}/batches/${id}`, { headers: auth() }, 'openai batch get')).json()); },
    async list(sinceMs) {
      const out: BatchStatus[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await (await call(f, `${base}/batches?limit=100${after ? `&after=${after}` : ''}`, { headers: auth() }, 'openai batch list')).json() as { data: any[]; has_more: boolean; last_id?: string };
        for (const b of page.data) {
          const s = openaiStatus(b);
          if (s.created_at_ms < sinceMs) return out;
          out.push(s);
        }
        if (!page.has_more || !page.data.length) return out;
        after = page.last_id ?? page.data[page.data.length - 1].id;
      }
    },
    async results(batch) {
      const out: NormalizedResult[] = [];
      for (const key of ['output_file_id', 'error_file_id'] as const) {
        const id = batch.raw[key];
        if (typeof id !== 'string' || !id) continue;
        const text = await (await call(f, `${base}/files/${id}/content`, { headers: auth() }, 'openai file content')).text();
        out.push(...parseJsonl(text).map(normalizeOpenAiLine));
      }
      return out;
    },
    async countTokens(body) {
      const input = (body.messages as { role: string; content: string }[]).map(m => ({ role: m.role, content: m.content }));
      const r = await (await call(f, `${base}/responses/input_tokens`, {
        method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ model: body.model, input }),
      }, 'openai input token count')).json() as { input_tokens: number };
      if (typeof r.input_tokens !== 'number') throw new Error('openai input token count returned no input_tokens');
      return r.input_tokens;
    },
  };
}

// ─── Anthropic ──────────────────────────────────────────────────────

function anthropicStatus(b: Record<string, any>): BatchStatus {
  const c = b.request_counts ?? {};
  return {
    id: b.id, provider: 'anthropic', status: b.processing_status, ended: b.processing_status === 'ended', created_at_ms: Date.parse(b.created_at ?? '') || 0,
    total: (c.processing ?? 0) + (c.succeeded ?? 0) + (c.errored ?? 0) + (c.canceled ?? 0) + (c.expired ?? 0), metadata: null, usage: null, raw: b,
  };
}

/** Normalize one Anthropic Message Batches result line. */
export function normalizeAnthropicLine(line: Record<string, any>): NormalizedResult {
  const r = line.result ?? {};
  const base = { custom_id: String(line.custom_id), text: null, finish: null, usage: null, response_model: null, service_tier: null };
  if (r.type === 'succeeded' && r.message) {
    const m = r.message;
    const text = Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('') : '';
    const finish = m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence' ? 'stop' : m.stop_reason ?? null;
    return { ...base, status: 'succeeded', text, finish, usage: m.usage && typeof m.usage === 'object' ? m.usage : null, response_model: m.model ?? null, service_tier: m.usage?.service_tier ?? null, error: null };
  }
  const status: ResultStatus = r.type === 'expired' ? 'expired' : r.type === 'canceled' ? 'canceled' : 'errored';
  return { ...base, status, error: JSON.stringify(r.error ?? r).slice(0, 500) };
}

export function anthropicTransport(options: { fetchImpl?: FetchLike; apiKey?: string } = {}): BatchTransport {
  const f: FetchLike = options.fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  const headers = () => ({ 'x-api-key': options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' });
  const base = 'https://api.anthropic.com/v1/messages';
  return {
    provider: 'anthropic',
    async prepare() { return null; },
    async create(requests) {
      const b = await (await call(f, `${base}/batches`, {
        method: 'POST', headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ requests: requests.map(r => ({ custom_id: r.custom_id, params: r.body })) }),
      }, 'anthropic batch create')).json();
      return anthropicStatus(b);
    },
    async get(id) { return anthropicStatus(await (await call(f, `${base}/batches/${id}`, { headers: headers() }, 'anthropic batch get')).json()); },
    async list(sinceMs) {
      const out: BatchStatus[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await (await call(f, `${base}/batches?limit=100${after ? `&after_id=${after}` : ''}`, { headers: headers() }, 'anthropic batch list')).json() as { data: any[]; has_more: boolean; last_id?: string };
        let older = false;
        for (const b of page.data) {
          const s = anthropicStatus(b);
          if (s.created_at_ms < sinceMs) { older = true; continue; }
          out.push(s);
        }
        if (older || !page.has_more || !page.data.length) return out.sort((a, b) => b.created_at_ms - a.created_at_ms);
        after = page.last_id ?? page.data[page.data.length - 1].id;
      }
    },
    async results(batch) {
      const url = typeof batch.raw.results_url === 'string' && batch.raw.results_url ? batch.raw.results_url : `${base}/batches/${batch.id}/results`;
      const text = await (await call(f, url, { headers: headers() }, 'anthropic batch results')).text();
      return parseJsonl(text).map(normalizeAnthropicLine);
    },
    async countTokens(body) {
      const { model, system, messages, thinking, tools } = body as Record<string, unknown>;
      const r = await (await call(f, `${base}/count_tokens`, {
        method: 'POST', headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ model, system, messages, ...(thinking ? { thinking } : {}), ...(tools ? { tools } : {}) }),
      }, 'anthropic count_tokens')).json() as { input_tokens: number };
      if (typeof r.input_tokens !== 'number') throw new Error('anthropic count_tokens returned no input_tokens');
      return r.input_tokens;
    },
  };
}
