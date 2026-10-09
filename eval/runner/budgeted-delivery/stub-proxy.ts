/**
 * A keyless stand-in for the metering proxy, for the budgeted delivery E1
 * accounting gate: it answers the proxy's control routes and every reader and
 * judge call with canned text (OpenAI chat completions and Anthropic
 * messages), so the gate builds every arm's frozen context and counts every
 * packer cut without a provider key. Its scores mean nothing.
 *
 *   bun eval/runner/budgeted-delivery/stub-proxy.ts [--port 8799]
 */
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] || 8799);
let calls = 0;
Bun.serve({ port, hostname: '127.0.0.1', fetch: async req => {
  const path = new URL(req.url).pathname;
  const body = await req.json().catch(() => ({})) as { messages?: Array<{ content?: unknown }> };
  if (path === '/__proxy/bind' || path === '/__proxy/unbind') return Response.json({ ok: true });
  if (path === '/__proxy/finalize') return Response.json({ usd: 0, requests: 0, unpriced: 0, byModel: {} });
  if (path === '/__proxy/status') return Response.json({ ok: true, calls });
  const prompt = String(body.messages?.[0]?.content ?? '');
  const judge = /Is the model response correct|Answer yes or no|I will give you (a|an unanswerable) question/.test(prompt);
  const text = judge ? 'yes' : 'stub answer';
  calls++;
  if (path.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: text } }], usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 2 } });
  if (path.endsWith('/v1/messages')) return Response.json({ content: [{ type: 'text', text }], usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 2 } });
  return Response.json({ error: 'no route' }, { status: 404 });
} });
console.error(`[stub-proxy] listening on http://127.0.0.1:${port}`);
