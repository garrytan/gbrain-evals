// Local stand-in for a model provider. It records every request body to a
// JSONL file and answers with a minimal canned reply in the wire format the
// caller asked for (Anthropic Messages, OpenAI Responses, OpenAI Chat
// Completions), so a harness finishes one turn without a paid model call.
//
// Usage: bun capture-server.ts <port> <out.jsonl>

import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 8787);
const out = process.argv[3] ?? "capture.jsonl";
const REPLY = "OK";

function sse(events: Array<[string | null, unknown]>): Response {
  const body = events
    .map(([event, data]) => (event ? `event: ${event}\n` : "") + `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function anthropic(body: any): Response {
  const model = body?.model ?? "model";
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id: "msg_capture", type: "message", role: "assistant", model, content: [] as any[], stop_reason: null, stop_sequence: null, usage };
  if (!body?.stream) {
    return Response.json({ ...message, content: [{ type: "text", text: REPLY }], stop_reason: "end_turn" });
  }
  return sse([
    ["message_start", { type: "message_start", message }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function responses(body: any): Response {
  const model = body?.model ?? "model";
  const item = { type: "message", id: "msg_capture", role: "assistant", status: "completed", content: [{ type: "output_text", text: REPLY, annotations: [] }] };
  const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
  const base = { id: "resp_capture", object: "response", created_at: 0, model, status: "in_progress", output: [] as any[] };
  const done = { ...base, status: "completed", output: [item], usage };
  if (!body?.stream) return Response.json(done);
  return sse([
    ["response.created", { type: "response.created", sequence_number: 0, response: base }],
    ["response.in_progress", { type: "response.in_progress", sequence_number: 1, response: base }],
    ["response.output_item.added", { type: "response.output_item.added", sequence_number: 2, output_index: 0, item: { ...item, status: "in_progress", content: [] } }],
    ["response.content_part.added", { type: "response.content_part.added", sequence_number: 3, item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }],
    ["response.output_text.delta", { type: "response.output_text.delta", sequence_number: 4, item_id: item.id, output_index: 0, content_index: 0, delta: REPLY }],
    ["response.output_text.done", { type: "response.output_text.done", sequence_number: 5, item_id: item.id, output_index: 0, content_index: 0, text: REPLY }],
    ["response.content_part.done", { type: "response.content_part.done", sequence_number: 6, item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] }],
    ["response.output_item.done", { type: "response.output_item.done", sequence_number: 7, output_index: 0, item }],
    ["response.completed", { type: "response.completed", sequence_number: 8, response: done }],
  ]);
}

function chat(body: any): Response {
  const model = body?.model ?? "model";
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (!body?.stream) {
    return Response.json({ id: "chatcmpl-capture", object: "chat.completion", created: 0, model, choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }], usage });
  }
  const chunk = (delta: any, finish: string | null, extra: any = {}) => ({ id: "chatcmpl-capture", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  return sse([
    [null, chunk({ role: "assistant", content: REPLY }, null)],
    [null, chunk({}, "stop", { usage })],
    [null, "[DONE]"],
  ]);
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const text = req.method === "GET" ? "" : await req.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { unparsed: text.slice(0, 2000) };
    }
    appendFileSync(out, JSON.stringify({ method: req.method, path: url.pathname, body }) + "\n");
    const p = url.pathname;
    if (p.endsWith("/messages/count_tokens")) return Response.json({ input_tokens: 1 });
    if (p.endsWith("/messages")) return anthropic(body);
    if (p.endsWith("/responses")) return responses(body);
    if (p.endsWith("/chat/completions")) return chat(body);
    if (p.endsWith("/models")) return Response.json({ object: "list", data: [] });
    return Response.json({}, { status: 404 });
  },
});
console.log(`capture-server listening on ${port}, writing ${out}`);
