/**
 * A keyless stand-in for the metering proxy, for the budgeted delivery E1
 * accounting gate: it answers the proxy's control routes and every reader and
 * judge call with canned text (OpenAI chat completions and responses, and
 * Anthropic messages), so the gate builds every arm's frozen context and
 * counts every packer cut without a provider key. Its scores mean nothing.
 *
 * `--vary` (the H1 keyless dry run) makes the canned text depend on the
 * prompt: a reader answer carries the first eight hex digits of the prompt's
 * SHA-256, and a judge says yes when the first hex digit of its prompt's
 * SHA-256 is below 8. Arms with different contexts then get different
 * verdicts, so the comparison and decision code run on non-degenerate
 * (and still meaningless) rows.
 *
 *   bun eval/runner/budgeted-delivery/stub-proxy.ts [--port 8799] [--vary]
 */
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] || 8799);
const vary = argv.includes('--vary');
let calls = 0;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
Bun.serve({ port, hostname: '127.0.0.1', fetch: async req => {
  const path = new URL(req.url).pathname;
  const body = await req.json().catch(() => ({})) as { messages?: Array<{ content?: unknown }>; input?: Array<{ content?: unknown }> };
  if (path === '/__proxy/bind' || path === '/__proxy/unbind') return Response.json({ ok: true });
  if (path === '/__proxy/finalize') return Response.json({ usd: 0, requests: 0, unpriced: 0, byModel: {} });
  if (path === '/__proxy/status') return Response.json({ ok: true, calls });
  const prompt = String(body.messages?.[0]?.content ?? body.input?.[0]?.content ?? '');
  const judge = /Is the model response correct|Answer yes or no|I will give you (a|an unanswerable) question/.test(prompt);
  const text = !vary ? (judge ? 'yes' : 'stub answer') : judge ? (parseInt(sha(prompt)[0], 16) < 8 ? 'yes' : 'no') : `stub answer ${sha(prompt).slice(0, 8)}`;
  calls++;
  if (path.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: text } }], usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 2 } });
  if (path.endsWith('/v1/messages')) return Response.json({ content: [{ type: 'text', text }], usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 2 } });
  if (path.endsWith('/responses')) return Response.json({ id: `stub-${calls}`, status: 'completed', model: 'stub', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 2 } });
  return Response.json({ error: 'no route' }, { status: 404 });
} });
console.error(`[stub-proxy] listening on http://127.0.0.1:${port}`);
