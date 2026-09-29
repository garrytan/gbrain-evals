/**
 * Hermetic OpenAI-compatible embedding server for the lifecycle experiment.
 *
 * Vectors are hashed bags of words: deterministic, free and good enough to
 * prove the write path stored and embedded the text. They say nothing about
 * real retrieval quality. The evaluator flips `outage` to make every request
 * fail with HTTP 503, and keeps its own log of which canary tokens reached a
 * successful embedding response, so recovery is measured on the evaluator
 * side rather than from gbrain's own status.
 */
import { createHash } from 'node:crypto';

export interface FakeEmbedderStats {
  ok_requests: number;
  failed_requests: number;
  ok_inputs: number;
  failed_inputs: number;
}

export interface FakeEmbedder {
  url: string;
  port: number;
  dims: number;
  setOutage(on: boolean): void;
  outage(): boolean;
  stats(): FakeEmbedderStats;
  /** Canary tokens seen in successfully embedded inputs. */
  embeddedCanaries(): Set<string>;
  /** Inputs that were embedded successfully and contain `phrase`. */
  embeddedInputsWith(phrase: string): string[];
  /** Canary tokens seen in inputs refused during an outage. */
  refusedCanaries(): Set<string>;
  stop(): void;
}

const CANARY = /\bcnry[a-z0-9]{6,}\b/g;

export function hashEmbedding(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    const h = createHash('sha256').update(tok).digest();
    const idx = h.readUInt32BE(0) % dims;
    v[idx] += (h[4] & 1) === 0 ? 1 : -1;
  }
  let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) { v[0] = 1; norm = 1; }
  return v.map(x => x / norm);
}

function toBase64(vec: number[]): string {
  const buf = Buffer.alloc(vec.length * 4);
  vec.forEach((x, i) => buf.writeFloatLE(x, i * 4));
  return buf.toString('base64');
}

export function startFakeEmbedder(opts: { dims?: number; port?: number } = {}): FakeEmbedder {
  const dims = opts.dims ?? 64;
  let outage = false;
  const stats: FakeEmbedderStats = { ok_requests: 0, failed_requests: 0, ok_inputs: 0, failed_inputs: 0 };
  const embedded = new Set<string>();
  const refused = new Set<string>();
  const okInputs: string[] = [];
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: 'fake-embed', object: 'model' }] });
      }
      if (req.method !== 'POST' || !url.pathname.endsWith('/embeddings')) {
        return new Response('not found', { status: 404 });
      }
      const body = await req.json() as { input: string | string[]; encoding_format?: string; dimensions?: number };
      const inputs = Array.isArray(body.input) ? body.input.map(String) : [String(body.input)];
      if (outage) {
        stats.failed_requests++;
        stats.failed_inputs += inputs.length;
        for (const t of inputs) for (const c of t.match(CANARY) ?? []) refused.add(c);
        return Response.json({ error: { message: 'fake embedder outage (injected)', type: 'server_error' } }, { status: 503 });
      }
      stats.ok_requests++;
      stats.ok_inputs += inputs.length;
      for (const t of inputs) for (const c of t.match(CANARY) ?? []) embedded.add(c);
      okInputs.push(...inputs);
      const d = body.dimensions ?? dims;
      const data = inputs.map((t, index) => {
        const vec = hashEmbedding(t, d);
        return { object: 'embedding', index, embedding: body.encoding_format === 'base64' ? toBase64(vec) : vec };
      });
      const tokens = inputs.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
      return Response.json({ object: 'list', data, model: 'fake-embed', usage: { prompt_tokens: tokens, total_tokens: tokens } });
    },
  });
  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    dims,
    setOutage(on) { outage = on; },
    outage: () => outage,
    stats: () => ({ ...stats }),
    embeddedCanaries: () => new Set(embedded),
    refusedCanaries: () => new Set(refused),
    embeddedInputsWith: (phrase: string) => okInputs.filter(t => t.includes(phrase)),
    stop() { server.stop(true); },
  };
}

if (import.meta.main) {
  const e = startFakeEmbedder({ port: Number(process.env.PORT ?? 0) });
  console.log(e.url);
}
