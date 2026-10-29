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
 * gbrain's conversation fact extraction (a system prompt and a `<turn>` user
 * message, the 8k conversion dry run) is answered with deterministic facts:
 * each first-person sentence of the turn (one that starts with "I " or
 * contains " I ", up to four) becomes an `event` fact, so the facts block and
 * fact source pages have saved facts to find.
 *
 *   bun eval/runner/budgeted-delivery/stub-proxy.ts [--port 8799] [--vary]
 */
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] || 8799);
const vary = argv.includes('--vary');
let calls = 0, extractions = 0;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** A message's text, whether its content is a string or a list of content blocks. */
const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(c => typeof c === 'string' ? c : String((c as { text?: unknown })?.text ?? '')).join('') : String(content ?? '');

/** The deterministic facts for one extraction turn: first-person sentences, in order, at most four. */
export function stubFacts(turn: string): Array<Record<string, unknown>> {
  const sentences = turn.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => /^I\s|\sI\s/.test(s) && s.length < 300);
  return sentences.slice(0, 4).map(s => ({ fact: s.replace(/^I\s/, 'The user ').replace(/\sI\s/g, ' the user '), kind: 'event', entity: null, confidence: 0.9, notability: 'high', metric: null, value: null, unit: null, period: null }));
}

if (import.meta.main) Bun.serve({ port, hostname: '127.0.0.1', fetch: async req => {
  const path = new URL(req.url).pathname;
  const body = await req.json().catch(() => ({})) as { system?: unknown; messages?: Array<{ role?: string; content?: unknown }>; input?: Array<{ content?: unknown }> };
  if (path === '/__proxy/bind' || path === '/__proxy/unbind') return Response.json({ ok: true });
  if (path === '/__proxy/finalize') return Response.json({ usd: 0, requests: 0, unpriced: 0, byModel: {} });
  if (path === '/__proxy/status') return Response.json({ ok: true, calls, extractions });
  const system = textOf(body.system) || textOf(body.messages?.find(m => m.role === 'system')?.content);
  const prompt = textOf(body.messages?.find(m => m.role !== 'system')?.content ?? body.input?.[0]?.content);
  const turn = /<turn>\n?([\s\S]*?)\n?<\/turn>/.exec(prompt)?.[1];
  const extraction = !!system && turn !== undefined;
  const judge = /Is the model response correct|Answer yes or no|I will give you (a|an unanswerable) question/.test(prompt);
  const text = extraction ? JSON.stringify({ facts: stubFacts(turn!) })
    : !vary ? (judge ? 'yes' : 'stub answer') : judge ? (parseInt(sha(prompt)[0], 16) < 8 ? 'yes' : 'no') : `stub answer ${sha(prompt).slice(0, 8)}`;
  calls++;
  if (extraction) extractions++;
  const inTokens = Math.ceil((system.length + prompt.length) / 4);
  if (path.endsWith('/chat/completions')) return Response.json({ id: `stub-${calls}`, object: 'chat.completion', created: 0, model: 'stub', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: inTokens, completion_tokens: 2, total_tokens: inTokens + 2 } });
  if (path.endsWith('/v1/messages') || path.endsWith('/messages')) return Response.json({ id: `stub-${calls}`, type: 'message', role: 'assistant', model: 'stub', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: inTokens, output_tokens: 2 } });
  if (path.endsWith('/responses')) return Response.json({ id: `stub-${calls}`, status: 'completed', model: 'stub', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: inTokens, output_tokens: 2 } });
  return Response.json({ error: 'no route' }, { status: 404 });
} });
if (import.meta.main) console.error(`[stub-proxy] listening on http://127.0.0.1:${port}`);
