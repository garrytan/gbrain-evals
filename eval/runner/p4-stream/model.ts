/**
 * Provider-neutral chat with tools for the streaming harness. The whole
 * conversation is resent each call (compaction rewrites history, so no
 * server-side threading). Anthropic: Messages API with prompt caching on the
 * system prompt, the tools and a rolling breakpoint on the newest message,
 * as Claude Code does. OpenAI: Responses API with the full input each call
 * (automatic prefix caching); a reasoning model's own output items are
 * replayed verbatim. Calls go out through `fetch`, so the paid-request guard
 * in budget-ledger.ts reserves and caps each one.
 */
import { provider } from '../cat40/loop.ts';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; text: string };

export interface Msg { role: 'user' | 'assistant'; blocks: Block[]; raw?: unknown[] }
export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }
export interface CallUsage { input: number; cache_write: number; cache_read: number; output: number }
export interface Reply { blocks: Block[]; raw?: unknown[]; usage: CallUsage; contextTokens: number; stop: string }

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  let last = '';
  for (let attempt = 0; attempt < 7; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(600_000) });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    last = `${res.status}: ${text.slice(0, 600)}`;
    if (![408, 409, 429, 500, 502, 503, 504, 529].includes(res.status)) break;
    await new Promise(r => setTimeout(r, Math.min(90_000, 2000 * 2 ** attempt) + Math.random() * 1000));
  }
  throw new Error(`provider error ${last}`);
}

export interface CallOptions { model: string; system: string; tools: ToolDef[]; messages: Msg[]; maxOutput: number; noTools?: boolean; effort?: string }

export async function callModel(o: CallOptions): Promise<Reply> {
  return provider(o.model) === 'anthropic' ? anthropic(o) : openai(o);
}

async function anthropic(o: CallOptions): Promise<Reply> {
  const tools: Array<Record<string, unknown>> = o.noTools ? [] : o.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } };
  const messages = o.messages.map(m => ({
    role: m.role,
    content: m.blocks.filter(b => b.type !== 'text' || b.text.trim()).map(b => b.type === 'text' ? { type: 'text', text: b.text }
      : b.type === 'tool_call' ? { type: 'tool_use', id: b.id, name: b.name, input: b.args }
        : { type: 'tool_result', tool_use_id: b.id, content: b.text || '(empty)' }) as Array<Record<string, unknown>>,
  })).filter(m => m.content.length);
  const last = messages[messages.length - 1].content;
  last[last.length - 1] = { ...last[last.length - 1], cache_control: { type: 'ephemeral' } };
  const res = await postJson('https://api.anthropic.com/v1/messages', { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' }, {
    model: o.model, max_tokens: o.maxOutput, system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }],
    ...(tools.length ? { tools } : {}), messages,
  });
  const u = (res.usage ?? {}) as Record<string, number>;
  const usage = { input: u.input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 };
  const blocks: Block[] = [];
  for (const c of (res.content ?? []) as Array<Record<string, unknown>>) {
    if (c.type === 'text') blocks.push({ type: 'text', text: String(c.text ?? '') });
    else if (c.type === 'tool_use') blocks.push({ type: 'tool_call', id: String(c.id), name: String(c.name), args: (c.input ?? {}) as Record<string, unknown> });
  }
  return { blocks, usage, contextTokens: usage.input + usage.cache_write + usage.cache_read + usage.output, stop: String(res.stop_reason ?? '') };
}

async function openai(o: CallOptions): Promise<Reply> {
  const input: unknown[] = [];
  for (const m of o.messages) {
    if (m.role === 'assistant' && m.raw) { input.push(...m.raw); continue; }
    for (const b of m.blocks) {
      if (b.type === 'text') { if (b.text.trim()) input.push({ role: m.role, content: b.text }); }
      else if (b.type === 'tool_call') input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.args) });
      else input.push({ type: 'function_call_output', call_id: b.id, output: b.text || '(empty)' });
    }
  }
  const res = await postJson('https://api.openai.com/v1/responses', { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` }, {
    model: o.model, instructions: o.system, input, max_output_tokens: o.maxOutput,
    ...(o.noTools ? {} : { tools: o.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })) }),
    ...(o.effort ? { reasoning: { effort: o.effort } } : {}),
  });
  const u = (res.usage ?? {}) as Record<string, unknown>;
  const cached = ((u.input_tokens_details ?? {}) as Record<string, number>).cached_tokens ?? 0;
  const usage = { input: ((u.input_tokens as number) ?? 0) - cached, cache_write: 0, cache_read: cached, output: (u.output_tokens as number) ?? 0 };
  const raw = (res.output ?? []) as Array<Record<string, unknown>>;
  const blocks: Block[] = [];
  for (const it of raw) {
    if (it.type === 'message') for (const c of (it.content as Array<Record<string, unknown>>) ?? []) { if (c.type === 'output_text') blocks.push({ type: 'text', text: String(c.text ?? '') }); }
    else if (it.type === 'function_call') {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(it.arguments ?? '{}')); } catch { args = {}; }
      blocks.push({ type: 'tool_call', id: String(it.call_id), name: String(it.name), args });
    }
  }
  return { blocks, raw, usage, contextTokens: usage.input + usage.cache_read + usage.output, stop: String(res.status ?? '') };
}

export const textOf = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map(b => b.text).join('\n').trim();
