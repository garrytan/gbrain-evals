/**
 * Normalize Claude Code `--output-format stream-json` and Codex `exec --json`
 * transcripts into one event list. Unknown lines are ignored, so a harness
 * upgrade that adds event types does not break scoring; one that renames the
 * ones used here shows up as runs with no events (scored as a harness crash).
 */
import type { Harness, NEvent } from './types.ts';

export interface ParsedSession {
  events: NEvent[];
  finalText: string;
  sessionId: string | null;
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  /** MCP servers the harness reported at start, with status (Claude Code only). */
  mcpServers: Array<{ name: string; status: string }>;
  /** Tool names the harness offered the model (Claude Code only). */
  toolNames: string[];
  harnessError: string | null;
}

function lines(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of raw.split('\n')) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch { /* partial line */ }
  }
  return out;
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string') ? (x as { text: string }).text : '').join('\n');
  if (c && typeof c === 'object') return JSON.stringify(c);
  return '';
}

/** `mcp__gbrain__recall` -> `recall`; other names unchanged. */
export function mcpToolName(name: string): { server: string; tool: string } | null {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  return m ? { server: m[1], tool: m[2] } : null;
}

export function parseClaude(raw: string, session: number): ParsedSession {
  const out: ParsedSession = { events: [], finalText: '', sessionId: null, model: null, costUsd: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, mcpServers: [], toolNames: [], harnessError: null };
  const pending = new Map<string, NEvent>();
  let lastText = '';
  for (const ev of lines(raw)) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      out.sessionId = String(ev.session_id ?? '') || null;
      out.model = String(ev.model ?? '') || null;
      out.mcpServers = ((ev.mcp_servers ?? []) as Array<{ name: string; status: string }>).map(s => ({ name: s.name, status: s.status }));
      out.toolNames = (ev.tools ?? []) as string[];
    } else if (ev.type === 'assistant') {
      const content = ((ev.message as { content?: unknown[] } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
      for (const b of content) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          lastText = b.text;
          out.events.push({ kind: 'text', name: 'assistant', output: b.text, session });
        } else if (b.type === 'tool_use') {
          const name = String(b.name);
          const mcp = mcpToolName(name);
          const input = b.input as Record<string, unknown> | undefined;
          let e: NEvent;
          if (mcp) e = { kind: 'mcp', name: mcp.tool, input: { server: mcp.server, arguments: input }, session };
          else if (name === 'Bash') e = { kind: 'shell', name: String(input?.command ?? ''), input, session };
          else if (name === 'WebFetch' || name === 'WebSearch') e = { kind: 'web', name, input, session };
          else e = { kind: 'other', name, input, session };
          out.events.push(e);
          pending.set(String(b.id), e);
        }
      }
    } else if (ev.type === 'user') {
      const content = ((ev.message as { content?: unknown[] } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const e = pending.get(String(b.tool_use_id));
        if (!e) continue;
        e.output = contentText(b.content);
        e.is_error = b.is_error === true;
        if (e.kind === 'shell') { const m = e.output.match(/exit code (\d+)/i); e.exit_code = e.is_error ? (m ? Number(m[1]) : 1) : 0; }
      }
    } else if (ev.type === 'result') {
      out.finalText = typeof ev.result === 'string' ? ev.result : lastText;
      out.costUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null;
      const u = (ev.usage ?? {}) as Record<string, number>;
      out.inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      out.cachedInputTokens = u.cache_read_input_tokens ?? null;
      out.outputTokens = u.output_tokens ?? null;
      if (ev.is_error === true) out.harnessError = String(ev.result ?? ev.subtype ?? 'error');
    }
  }
  if (!out.finalText) out.finalText = lastText;
  return out;
}

export function parseCodex(raw: string, session: number): ParsedSession {
  const out: ParsedSession = { events: [], finalText: '', sessionId: null, model: null, costUsd: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, mcpServers: [], toolNames: [], harnessError: null };
  let inTok = 0, cached = 0, outTok = 0, turns = 0;
  for (const ev of lines(raw)) {
    if (ev.type === 'thread.started') out.sessionId = String(ev.thread_id ?? '') || null;
    else if (ev.type === 'turn.completed') {
      const u = (ev.usage ?? {}) as Record<string, number>;
      inTok += u.input_tokens ?? 0; cached += u.cached_input_tokens ?? 0; outTok += (u.output_tokens ?? 0); turns++;
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      out.harnessError = JSON.stringify(ev.error ?? ev.message ?? ev).slice(0, 500);
    } else if (ev.type === 'item.completed') {
      const it = (ev.item ?? {}) as Record<string, unknown>;
      if (it.type === 'agent_message' && typeof it.text === 'string') {
        out.finalText = it.text;
        out.events.push({ kind: 'text', name: 'assistant', output: it.text, session });
      } else if (it.type === 'command_execution') {
        out.events.push({ kind: 'shell', name: String(it.command ?? ''), output: String(it.aggregated_output ?? ''), exit_code: typeof it.exit_code === 'number' ? it.exit_code : null, is_error: it.status === 'failed', session });
      } else if (it.type === 'mcp_tool_call') {
        const result = it.result as { content?: unknown; is_error?: boolean; isError?: boolean } | null | undefined;
        const err = it.error ? contentText((it.error as { message?: unknown }).message ?? it.error) : '';
        out.events.push({
          kind: 'mcp', name: String(it.tool ?? ''), input: { server: it.server, arguments: it.arguments },
          output: result ? contentText(result.content) : err,
          is_error: it.status === 'failed' || !!it.error || result?.is_error === true || result?.isError === true, session,
        });
      } else if (it.type === 'web_search') {
        out.events.push({ kind: 'web', name: 'web_search', input: { query: it.query }, session });
      } else if (typeof it.type === 'string' && it.type !== 'reasoning') {
        out.events.push({ kind: 'other', name: it.type, input: it, session });
      }
    }
  }
  if (turns) { out.inputTokens = inTok; out.cachedInputTokens = cached; out.outputTokens = outTok; }
  return out;
}

export function parseSession(harness: Harness, raw: string, session: number): ParsedSession {
  return harness === 'claude' ? parseClaude(raw, session) : parseCodex(raw, session);
}
