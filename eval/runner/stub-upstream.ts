/**
 * Deterministic stand-in for the paid model providers, for keyless tests, the
 * harness mode smoke and the quickstart fixture.
 *
 * One Bun server answers under the same path prefixes the metering proxy uses:
 *
 *   /openai/v1/chat/completions | /responses | /embeddings
 *   /anthropic/v1/messages
 *   /gemini/v1beta/models/<model>:generateContent | :streamGenerateContent | :embedContent | :batchEmbedContents | :countTokens
 *   /groq/openai/v1/chat/completions
 *   /voyage/v1/embeddings | /rerank
 *
 * Structured output requests (OpenAI `response_format` json_schema, responses
 * `text.format`, an Anthropic forced tool call, Gemini `responseSchema` or
 * `responseJsonSchema`) get the smallest instance of the schema, with fixed
 * strings. Embeddings are unit vectors derived from a hash of the text,
 * honoring `dimensions` / `output_dimension` / `outputDimensionality`. Every
 * response carries a usage block in the provider's own shape (4 bytes per
 * token), and `stream: true` requests get server-sent events.
 *
 * The server counts requests per path, so a test can assert that nothing
 * reached it, and `respond(route, fn)` lets a test choose the content.
 *
 *   const stub = await startStubUpstream();
 *   startMeteringProxy({ ..., upstreams: stub.upstreams });
 *   stub.hits.total  // requests received
 */
import { createHash } from 'node:crypto';

export type StubProvider = 'openai' | 'anthropic' | 'gemini' | 'groq' | 'voyage';
export type StubRoute =
  | 'openai.chat' | 'openai.responses' | 'openai.embeddings'
  | 'anthropic.messages'
  | 'gemini.generateContent' | 'gemini.embedContent' | 'gemini.batchEmbedContents' | 'gemini.countTokens'
  | 'groq.chat'
  | 'voyage.embeddings' | 'voyage.rerank';

export interface StubRequest {
  route: StubRoute;
  provider: StubProvider;
  path: string;
  model: string;
  body: Record<string, any>;
  headers: Headers;
}

/**
 * What a responder returns: `text` replaces the generated text (for a forced
 * tool call or schema request it must be the JSON of the structured result),
 * `json` replaces the structured result, and `status` + `body` sends a raw
 * reply (for error paths). Returning undefined keeps the default reply.
 */
export type StubReply = { text: string } | { json: unknown } | { status: number; body: unknown };
export type StubResponder = (request: StubRequest) => StubReply | undefined | Promise<StubReply | undefined>;

export interface StubUpstream {
  url: string;
  port: number;
  /** Base URLs to pass as the metering proxy's `upstreams`. */
  upstreams: Record<StubProvider, string>;
  /** Requests received: `total` plus a count per path. */
  hits: { total: number; byPath: Record<string, number> };
  /** Every request received, in order (headers included, for credential checks). */
  requests: StubRequest[];
  respond(route: StubRoute, fn: StubResponder | null): void;
  reset(): void;
  close(): void;
}

const tokens = (value: unknown) => Math.max(1, Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? '')) / 4));
const digest = (text: string) => createHash('sha256').update(text).digest();

/** A deterministic unit vector for `text`. */
export function hashVector(text: string, dimensions: number): number[] {
  const out: number[] = [];
  for (let block = 0; out.length < dimensions; block++) {
    const bytes = digest(`${block}:${text}`);
    for (let i = 0; i + 1 < bytes.length && out.length < dimensions; i += 2) out.push(bytes.readUInt16LE(i) / 65535 - 0.5);
  }
  const norm = Math.sqrt(out.reduce((a, v) => a + v * v, 0)) || 1;
  return out.map(v => v / norm);
}

const base64Vector = (vector: number[]) => Buffer.from(new Float32Array(vector).buffer).toString('base64');

/**
 * The smallest instance of a JSON schema (OpenAPI-style Gemini schemas with
 * upper-case types included): every listed property, empty arrays unless
 * `minItems` asks for more, the first enum value, `stub-<property>` strings.
 */
export function schemaInstance(schema: any, root: any = schema, name = 'value', depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 32) return null;
  if (typeof schema.$ref === 'string') {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((node: any, key: string) => node?.[key], root);
    return schemaInstance(target, root, name, depth + 1);
  }
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  for (const key of ['anyOf', 'oneOf', 'any_of'] as const) {
    if (Array.isArray(schema[key]) && schema[key].length) {
      const pick = schema[key].find((s: any) => s?.type !== 'null' && s?.type !== 'NULL') ?? schema[key][0];
      return schemaInstance(pick, root, name, depth + 1);
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) return schemaInstance(Object.assign({}, ...schema.allOf), root, name, depth + 1);
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t: string) => String(t).toLowerCase() !== 'null') ?? type[0];
  type = typeof type === 'string' ? type.toLowerCase() : schema.properties ? 'object' : schema.items ? 'array' : 'string';
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(schema.properties ?? {})) out[key] = schemaInstance(sub, root, key, depth + 1);
      return out;
    }
    case 'array': {
      const n = Math.max(0, Number(schema.minItems ?? schema.min_items ?? 0));
      return Array.from({ length: n }, (_, i) => schemaInstance(schema.items, root, `${name}-${i}`, depth + 1));
    }
    case 'integer': return Math.max(0, Math.ceil(Number(schema.minimum ?? 0)));
    case 'number': return Math.max(0, Number(schema.minimum ?? 0));
    case 'boolean': return false;
    case 'null': return null;
    default: {
      if (schema.format === 'date-time') return '1970-01-01T00:00:00Z';
      if (schema.format === 'date') return '1970-01-01';
      const text = `stub-${name}`;
      const min = Number(schema.minLength ?? schema.min_length ?? 0);
      return text.length >= min ? text : text.padEnd(min, 'x');
    }
  }
}

function sse(events: Array<{ event?: string; data: unknown }>, init: ResponseInit = {}): Response {
  const text = events.map(e => `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`).join('');
  return new Response(text, { ...init, headers: { 'content-type': 'text/event-stream' } });
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

function promptText(body: Record<string, any>): unknown {
  return [body.system, body.instructions, body.messages, body.input, body.prompt, body.contents, body.systemInstruction, body.tools];
}

function openaiSchema(body: Record<string, any>): any {
  const format = body.response_format ?? body.text?.format;
  if (format?.type !== 'json_schema') return null;
  return format.json_schema?.schema ?? format.schema ?? {};
}

export async function startStubUpstream(options: { port?: number } = {}): Promise<StubUpstream> {
  const responders = new Map<StubRoute, StubResponder>();
  const hits = { total: 0, byPath: {} as Record<string, number> };
  const requests: StubRequest[] = [];
  let seq = 0;

  /** Generated text or structured result for a request, after any responder. */
  async function content(request: StubRequest, schema: any): Promise<{ text: string; structured: unknown } | Response> {
    const reply = await responders.get(request.route)?.(request);
    if (reply && 'status' in reply) return json(reply.body, reply.status);
    if (reply && 'json' in reply) return { text: JSON.stringify(reply.json), structured: reply.json };
    if (reply && 'text' in reply) {
      let structured: unknown = null;
      try { structured = JSON.parse(reply.text); } catch {}
      return { text: reply.text, structured };
    }
    if (schema) {
      const structured = schemaInstance(schema);
      return { text: JSON.stringify(structured), structured };
    }
    return { text: `stub answer from ${request.model || request.provider}`, structured: null };
  }

  async function openaiChat(request: StubRequest, groq: boolean): Promise<Response> {
    const { body } = request;
    const result = await content(request, openaiSchema(body));
    if (result instanceof Response) return result;
    const usage = { prompt_tokens: tokens(promptText(body)), completion_tokens: tokens(result.text), total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const id = `chatcmpl-stub-${++seq}`;
    const created = 1_700_000_000;
    if (body.stream) {
      const chunk = (delta: unknown, finish: string | null, extra: Record<string, unknown> = {}) => ({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
      const events: Array<{ data: unknown }> = [
        { data: chunk({ role: 'assistant', content: '' }, null) },
        { data: chunk({ content: result.text }, null) },
        { data: chunk({}, 'stop', groq ? { x_groq: { id, usage } } : {}) },
      ];
      if (!groq && body.stream_options?.include_usage) events.push({ data: { id, object: 'chat.completion.chunk', created, model: request.model, choices: [], usage } });
      events.push({ data: '[DONE]' });
      return sse(events);
    }
    return json({ id, object: 'chat.completion', created, model: request.model, choices: [{ index: 0, message: { role: 'assistant', content: result.text, refusal: null }, finish_reason: 'stop', logprobs: null }], usage });
  }

  async function openaiResponses(request: StubRequest): Promise<Response> {
    const { body } = request;
    const result = await content(request, openaiSchema(body));
    if (result instanceof Response) return result;
    const usage = { input_tokens: tokens(promptText(body)), input_tokens_details: { cached_tokens: 0 }, output_tokens: tokens(result.text), output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
    const id = `resp_stub_${++seq}`;
    const message = { id: `msg_stub_${seq}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: result.text, annotations: [] }] };
    const response = { id, object: 'response', created_at: 1_700_000_000, status: 'completed', model: request.model, output: [message], output_text: result.text, usage };
    if (body.stream) {
      return sse([
        { event: 'response.created', data: { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } } },
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: result.text } },
        { event: 'response.completed', data: { type: 'response.completed', response } },
      ]);
    }
    return json(response);
  }

  async function embeddings(request: StubRequest, provider: 'openai' | 'voyage'): Promise<Response> {
    const { body } = request;
    const reply = await responders.get(request.route)?.(request);
    if (reply && 'status' in reply) return json(reply.body, reply.status);
    const inputs: string[] = (Array.isArray(body.input) ? body.input : [body.input]).map((v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)));
    const dims = Number(body.dimensions ?? body.output_dimension ?? (/small|ada/.test(request.model) ? 1536 : provider === 'voyage' ? 1024 : 3072));
    const base64 = body.encoding_format === 'base64';
    const data = inputs.map((text, index) => {
      const vector = hashVector(text, dims);
      return { object: 'embedding', index, embedding: base64 ? base64Vector(vector) : vector };
    });
    const total = inputs.reduce((a, t) => a + tokens(t), 0);
    const usage = provider === 'voyage' ? { total_tokens: total } : { prompt_tokens: total, total_tokens: total };
    return json({ object: 'list', data, model: request.model, usage });
  }

  async function voyageRerank(request: StubRequest): Promise<Response> {
    const { body } = request;
    const reply = await responders.get(request.route)?.(request);
    if (reply && 'status' in reply) return json(reply.body, reply.status);
    const documents: string[] = Array.isArray(body.documents) ? body.documents : [];
    const scored = documents.map((doc, index) => ({ index, relevance_score: digest(`${body.query}\u0000${doc}`).readUInt16LE(0) / 65535 }))
      .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
      .slice(0, typeof body.top_k === 'number' ? body.top_k : documents.length);
    return json({ object: 'list', data: scored, model: request.model, usage: { total_tokens: tokens(body.query) * Math.max(1, documents.length) + tokens(documents) } });
  }

  async function anthropicMessages(request: StubRequest): Promise<Response> {
    const { body } = request;
    const choice = body.tool_choice;
    const forced = (choice?.type === 'tool' ? (body.tools ?? []).find((t: any) => t.name === choice.name)
      : choice?.type === 'any' ? body.tools?.[0] : undefined) as { name: string; input_schema?: unknown } | undefined;
    const result = await content(request, forced ? forced.input_schema ?? { type: 'object' } : null);
    if (result instanceof Response) return result;
    const id = `msg_stub_${++seq}`;
    const block = forced
      ? { type: 'tool_use', id: `toolu_stub_${seq}`, name: forced.name, input: result.structured ?? {} }
      : { type: 'text', text: result.text };
    const usage = { input_tokens: tokens(promptText(body)), output_tokens: tokens(result.text), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const stopReason = forced ? 'tool_use' : 'end_turn';
    const message = { id, type: 'message', role: 'assistant', model: request.model, content: [block], stop_reason: stopReason, stop_sequence: null, usage };
    if (body.stream) {
      const start = block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' };
      const delta = block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: result.text };
      return sse([
        { event: 'message_start', data: { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: start } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]);
    }
    return json(message);
  }

  async function gemini(request: StubRequest, method: string, url: URL): Promise<Response> {
    const { body } = request;
    if (method === 'countTokens') return json({ totalTokens: tokens(promptText(body)) });
    if (method === 'embedContent' || method === 'batchEmbedContents') {
      const reply = await responders.get(request.route)?.(request);
      if (reply && 'status' in reply) return json(reply.body, reply.status);
      const embed = (req: any) => {
        const text = (req?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('');
        return { values: hashVector(text, Number(req?.outputDimensionality ?? req?.output_dimensionality ?? 3072)) };
      };
      return method === 'embedContent' ? json({ embedding: embed(body) }) : json({ embeddings: (body.requests ?? []).map(embed) });
    }
    const gen = body.generationConfig ?? body.generation_config ?? {};
    const schema = gen.responseJsonSchema ?? gen.response_json_schema ?? gen.responseSchema ?? gen.response_schema ?? null;
    const result = await content(request, schema);
    if (result instanceof Response) return result;
    const usageMetadata = { promptTokenCount: tokens(promptText(body)), candidatesTokenCount: tokens(result.text), thoughtsTokenCount: 0, totalTokenCount: 0 };
    usageMetadata.totalTokenCount = usageMetadata.promptTokenCount + usageMetadata.candidatesTokenCount;
    const candidate = (text: string, finish?: string) => ({ content: { role: 'model', parts: [{ text }] }, index: 0, ...(finish ? { finishReason: finish } : {}) });
    const full = { candidates: [candidate(result.text, 'STOP')], usageMetadata, modelVersion: request.model, responseId: `stub-${++seq}` };
    if (method === 'streamGenerateContent') {
      const partial = { candidates: [candidate('')], usageMetadata: { promptTokenCount: usageMetadata.promptTokenCount, totalTokenCount: usageMetadata.promptTokenCount }, modelVersion: request.model };
      if (url.searchParams.get('alt') === 'sse') return sse([{ data: partial }, { data: full }]);
      return json([partial, full]);
    }
    return json(full);
  }

  const routes: Array<[RegExp, StubProvider, (m: RegExpMatchArray) => StubRoute]> = [
    [/^\/openai\/v1\/chat\/completions$/, 'openai', () => 'openai.chat'],
    [/^\/openai\/v1\/responses$/, 'openai', () => 'openai.responses'],
    [/^\/openai\/v1\/embeddings$/, 'openai', () => 'openai.embeddings'],
    [/^\/anthropic\/v1\/messages$/, 'anthropic', () => 'anthropic.messages'],
    [/^\/gemini\/v1(?:beta|alpha)?\/models\/([^/:]+):(generateContent|streamGenerateContent|embedContent|batchEmbedContents|countTokens)$/, 'gemini',
      m => (m[2] === 'streamGenerateContent' ? 'gemini.generateContent' : `gemini.${m[2]}`) as StubRoute],
    [/^\/groq\/openai\/v1\/chat\/completions$/, 'groq', () => 'groq.chat'],
    [/^\/voyage\/v1\/embeddings$/, 'voyage', () => 'voyage.embeddings'],
    [/^\/voyage\/v1\/rerank$/, 'voyage', () => 'voyage.rerank'],
  ];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      hits.total++;
      hits.byPath[url.pathname] = (hits.byPath[url.pathname] ?? 0) + 1;
      let body: Record<string, any> = {};
      if (req.method === 'POST') {
        try { body = await req.json() as Record<string, any>; } catch { return json({ error: { message: 'stub upstream: request body is not JSON' } }, 400); }
      }
      for (const [pattern, provider, routeOf] of routes) {
        const m = url.pathname.match(pattern);
        if (!m) continue;
        const route = routeOf(m);
        const model = provider === 'gemini' ? m[1] : String(body.model ?? '');
        const request: StubRequest = { route, provider, path: url.pathname, model, body, headers: req.headers };
        requests.push(request);
        switch (route) {
          case 'openai.chat': return openaiChat(request, false);
          case 'groq.chat': return openaiChat(request, true);
          case 'openai.responses': return openaiResponses(request);
          case 'openai.embeddings': return embeddings(request, 'openai');
          case 'voyage.embeddings': return embeddings(request, 'voyage');
          case 'voyage.rerank': return voyageRerank(request);
          case 'anthropic.messages': return anthropicMessages(request);
          default: return gemini(request, m[2], url);
        }
      }
      if (req.method === 'GET' && /^\/(openai|groq\/openai)\/v1\/models\/?$/.test(url.pathname)) return json({ object: 'list', data: [] });
      return json({ error: { message: `stub upstream has no route for ${req.method} ${url.pathname}` } }, 404);
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    port: server.port as number,
    upstreams: { openai: `${url}/openai`, anthropic: `${url}/anthropic`, gemini: `${url}/gemini`, groq: `${url}/groq`, voyage: `${url}/voyage` },
    hits,
    requests,
    respond(route, fn) { if (fn) responders.set(route, fn); else responders.delete(route); },
    reset() { hits.total = 0; hits.byPath = {}; requests.length = 0; },
    close() { server.stop(true); },
  };
}

if (import.meta.main) {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 0);
  const stub = await startStubUpstream({ port: process.argv.includes('--port') ? port : 0 });
  console.log(JSON.stringify({ url: stub.url, upstreams: stub.upstreams }));
}
