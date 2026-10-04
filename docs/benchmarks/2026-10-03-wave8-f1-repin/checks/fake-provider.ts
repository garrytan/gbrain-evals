// A scripted OpenAI-compatible provider on 127.0.0.1 for keyless checks: chat completions return a fixed
// facts reply, embeddings return constant vectors of the requested width. Nothing leaves the machine; cost is $0.
export interface FakeProvider { url: string; chatCalls: number; embedCalls: number; embeddedTexts: number; stop(): void }

export function startFakeProvider(opts: { dims?: number; embedDelayMs?: number } = {}): FakeProvider {
  const dims = opts.dims ?? 8;
  const state = { chatCalls: 0, embedCalls: 0, embeddedTexts: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) as Record<string, any> : {};
      if (path.endsWith('/chat/completions')) {
        state.chatCalls++;
        const content = JSON.stringify({ facts: [{ fact: 'the example rollout is complete', kind: 'event', entity: null, confidence: 1, notability: 'high' }] });
        return Response.json({
          id: `chatcmpl-${state.chatCalls}`, object: 'chat.completion', created: 1_790_000_000, model: body.model ?? 'custom-chat',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        });
      }
      if (path.endsWith('/embeddings')) {
        state.embedCalls++;
        const input: string[] = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
        state.embeddedTexts += input.length;
        if (opts.embedDelayMs) await Bun.sleep(opts.embedDelayMs);
        const width = typeof body.dimensions === 'number' ? body.dimensions : dims;
        return Response.json({
          object: 'list', model: body.model ?? 'fake-embed',
          data: input.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: width }, (_, i) => ((i % 7) + 1) / 10) })),
          usage: { prompt_tokens: input.length * 10, total_tokens: input.length * 10 },
        });
      }
      if (path.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'custom-chat', object: 'model' }] });
      return new Response('not found', { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    get chatCalls() { return state.chatCalls; },
    get embedCalls() { return state.embedCalls; },
    get embeddedTexts() { return state.embeddedTexts; },
    stop() { server.stop(true); },
  };
}
