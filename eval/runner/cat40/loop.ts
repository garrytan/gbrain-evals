/**
 * Cat 40 agent loop: one provider-neutral tool loop for every memory arm.
 *
 * The arms differ only in the tools they offer. The loop, system prompt
 * frame, turn cap, output cap and the `submit_answer` tool are shared. Calls
 * go out through `fetch`, so the paid-request guard in budget-ledger.ts
 * reserves and caps every request, retries included. A refused reservation
 * propagates instead of being recorded as a model error.
 *
 * Anthropic: Messages API, prompt caching on the system prompt, tools and the
 * latest message (what Claude Code does). Native tools such as the memory
 * tool pass through as `native_anthropic` definitions.
 * OpenAI: Responses API with `previous_response_id`, automatic caching.
 */
import { CHAT_PRICE_OVERRIDES } from '../budget-ledger.ts';

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Arm {
  readonly name: string;
  /** One paragraph appended to the shared system prompt. */
  systemHint(): string;
  tools(): ToolSpec[];
  /** Changes when the tool list changes mid-run (an MCP server's tools/list_changed); the loops then resend tools(). */
  toolsVersion?(): number;
  /** Anthropic-native tool definitions used instead of a ToolSpec of the same name on Anthropic models. */
  nativeAnthropic?(): Array<{ type: string; name: string }>;
  call(name: string, args: Record<string, unknown>): Promise<string>;
  /** Names of tools that change stored knowledge. */
  writeTools(): string[];
}

export interface SubmitPayload {
  answer?: string;
  fields?: Record<string, string>;
  sources?: string[];
  notes?: string;
}

export interface ToolEvent { name: string; args: Record<string, unknown>; ms: number; chars: number; truncated: boolean; error?: string; result: string }

export interface Usage { input: number; output: number; cache_read: number; cache_write: number; requests: number }

/**
 * An infrastructure failure, not the agent's: a provider 5xx or 429 after
 * backoff, or a slot, server, restore or MCP transport failure. Arms throw it
 * instead of returning the failure to the agent as text. With
 * `classifyStops` (Hard runs) it ends the session as `harness_error`, the
 * only stop kind a Hard run retries.
 */
export class HarnessError extends Error {
  constructor(message: string) { super(message); this.name = 'HarnessError'; }
}

/** A provider's non-2xx answer, after backoff for retryable statuses. */
export class ProviderError extends Error {
  constructor(readonly status: number, readonly body: string) { super(`provider error ${status}: ${body.slice(0, 500)}`); this.name = 'ProviderError'; }
}

/** A provider 400 that says the request exceeds the model's context window. */
export function isContextOverflow(e: unknown): boolean {
  return e instanceof ProviderError && e.status === 400 && /context[_ ]length|context window|prompt is too long|too many tokens|maximum context|input is too long|exceeds the context/i.test(e.body);
}

export interface AgentRun {
  model: string;
  final: SubmitPayload | null;
  /** `context_overflow` and `harness_error` occur only with `classifyStops` (Hard runs); v1 runs record them as `error`. */
  stop: 'submitted' | 'turn_cap' | 'no_tool_call' | 'error' | 'context_overflow' | 'harness_error';
  error?: string;
  turns: number;
  tools: ToolEvent[];
  usage: Usage;
  usd: number;
  ms: number;
  model_ms: number;
  tool_ms: number;
  /** Final assistant text when the model ended without submitting. */
  text?: string;
}

export const SUBMIT_TOOL: ToolSpec = {
  name: 'submit_answer',
  description: 'Submit your final answer. Call this exactly once, when you are done.',
  input_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'The answer value only (a name, date, number, term or code), no explanation. Use NOT_ACCESSIBLE if the information is not available to the person you work for, UNKNOWN if the knowledge base does not contain it.' },
      fields: { type: 'object', description: 'For multi-part requests: one key per requested item, each a value only.', additionalProperties: { type: 'string' } },
      sources: { type: 'array', items: { type: 'string' }, description: 'Ids or paths of the documents you relied on.' },
      notes: { type: 'string', description: 'Optional brief explanation, caveats or conflicts you noticed.' },
    },
    required: ['sources'],
  },
};

export interface LoopConfig {
  model: string;
  system: string;
  user: string;
  arm: Arm;
  maxTurns?: number;
  /** Per-tool-result character cap; null or omitted passes every result through unmodified. */
  maxToolChars?: number | null;
  /** Output allowance per model call. */
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
  /** Test hook: replace the provider with a scripted model. */
  scripted?: ScriptedModel;
  /**
   * Hard runs: split failures into `context_overflow` (a provider context-length 400), `harness_error`
   * (HarnessError from an arm, or a provider 5xx/429 after backoff) and `error` (anything else, such as a
   * malformed tool call the provider rejects). Off, every failure is `error`, as v1 records it.
   */
  classifyStops?: boolean;
}

/** A scripted model returns the next tool call (or a final submit) given the transcript so far. */
export type ScriptedModel = (history: Array<{ name: string; args: Record<string, unknown>; result: string }>) => { name: string; args: Record<string, unknown> };

export const DEFAULT_MAX_TURNS = 16;
/** Sent once when a model stops without calling a tool; harnesses enforce structured output the same way. */
export const NUDGE = 'Please call submit_answer now with your final answer.';

export function provider(model: string): 'anthropic' | 'openai' {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || /^o\d/.test(model)) return 'openai';
  throw new Error(`no provider for model ${model}`);
}

export function priceUsage(model: string, u: Usage): number {
  const p = CHAT_PRICE_OVERRIDES[`${provider(model)}:${model}`];
  if (!p) throw new Error(`no verified price for ${model}; add it to CHAT_PRICE_OVERRIDES`);
  return (u.input * p.input + u.cache_read * (p.cache_read ?? p.input) + u.cache_write * (p.cache_write ?? p.input) + u.output * p.output) / 1e6;
}

function cap(text: string, max: number | null): { text: string; truncated: boolean } {
  if (max === null || text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…[truncated: ${text.length - max} more characters]`, truncated: true };
}

export const RETRYABLE_STATUS = [429, 500, 502, 503, 504, 529];

async function postJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  let last: ProviderError | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    last = new ProviderError(res.status, text);
    if (!RETRYABLE_STATUS.includes(res.status)) break;
    await new Promise(r => setTimeout(r, Math.min(60_000, 2000 * 2 ** attempt) + Math.random() * 1000));
  }
  throw last!;
}

export async function runAgent(cfg: LoopConfig): Promise<AgentRun> {
  const t0 = Date.now();
  const maxTurns = cfg.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxChars = cfg.maxToolChars ?? null;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const run: AgentRun = { model: cfg.model, final: null, stop: 'turn_cap', turns: 0, tools: [], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, requests: 0 }, usd: 0, ms: 0, model_ms: 0, tool_ms: 0 };
  const specs = (): ToolSpec[] => [...cfg.arm.tools(), SUBMIT_TOOL];

  const execute = async (name: string, args: Record<string, unknown>): Promise<{ text: string; submitted: boolean }> => {
    if (name === 'submit_answer') {
      run.final = args as SubmitPayload;
      return { text: 'Answer submitted.', submitted: true };
    }
    const s = Date.now();
    let result: string;
    let error: string | undefined;
    try { result = await cfg.arm.call(name, args); }
    catch (e) {
      if (cfg.classifyStops && e instanceof HarnessError) throw e;
      error = (e as Error).message; result = `Error: ${error}`;
    }
    const ms = Date.now() - s;
    run.tool_ms += ms;
    const capped = cap(result, maxChars);
    run.tools.push({ name, args, ms, chars: result.length, truncated: capped.truncated, error, result: capped.text });
    return { text: capped.text, submitted: false };
  };

  try {
    if (cfg.scripted) {
      const history: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];
      for (let turn = 0; turn < maxTurns; turn++) {
        run.turns++;
        const next = cfg.scripted(history);
        const r = await execute(next.name, next.args);
        history.push({ ...next, result: r.text });
        if (r.submitted) { run.stop = 'submitted'; break; }
      }
    } else if (provider(cfg.model) === 'anthropic') {
      await anthropicLoop(cfg, run, specs, execute, maxTurns, fetchImpl);
    } else {
      await openaiLoop(cfg, run, specs, execute, maxTurns, fetchImpl);
    }
  } catch (e) {
    if ((e as Error).name === 'BudgetExceededError') throw e;
    run.stop = !cfg.classifyStops ? 'error'
      : isContextOverflow(e) ? 'context_overflow'
      : e instanceof HarnessError || (e instanceof ProviderError && RETRYABLE_STATUS.includes(e.status)) ? 'harness_error'
      : 'error';
    run.error = (e as Error).message;
  }
  run.ms = Date.now() - t0;
  run.usd = cfg.scripted ? 0 : priceUsage(cfg.model, run.usage);
  return run;
}

type Exec = (name: string, args: Record<string, unknown>) => Promise<{ text: string; submitted: boolean }>;

/** Rebuilds the provider tool list when the arm's tools changed since the last turn. */
function toolList<T>(cfg: LoopConfig, build: () => T): () => T {
  let version = cfg.arm.toolsVersion?.();
  let tools = build();
  return () => {
    const now = cfg.arm.toolsVersion?.();
    if (now !== version) { version = now; tools = build(); }
    return tools;
  };
}

async function anthropicLoop(cfg: LoopConfig, run: AgentRun, specs: () => ToolSpec[], execute: Exec, maxTurns: number, fetchImpl: typeof fetch) {
  const native = cfg.arm.nativeAnthropic?.() ?? [];
  const nativeNames = new Set(native.map(n => n.name));
  const currentTools = toolList(cfg, () => {
    const tools: Array<Record<string, unknown>> = [
      ...native,
      ...specs().filter(s => !nativeNames.has(s.name)).map(s => ({ name: s.name, description: s.description, input_schema: s.input_schema })),
    ];
    tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } };
    return tools;
  });
  const messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [{ role: 'user', content: [{ type: 'text', text: cfg.user }] }];
  const headers: Record<string, string> = { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' };
  let nudged = false;
  for (let turn = 0; turn < maxTurns; turn++) {
    run.turns++;
    // Rolling cache breakpoint on the newest message; older breakpoints are removed (at most 4 allowed).
    for (const m of messages) for (const c of m.content) delete c.cache_control;
    const last = messages[messages.length - 1].content;
    last[last.length - 1].cache_control = { type: 'ephemeral' };
    const s = Date.now();
    const res = await postJson(fetchImpl, 'https://api.anthropic.com/v1/messages', headers, {
      model: cfg.model, max_tokens: cfg.maxOutputTokens ?? 8192,
      system: [{ type: 'text', text: cfg.system, cache_control: { type: 'ephemeral' } }], tools: currentTools(), messages,
    });
    run.model_ms += Date.now() - s;
    const u = (res.usage ?? {}) as Record<string, number>;
    run.usage.input += u.input_tokens ?? 0; run.usage.output += u.output_tokens ?? 0;
    run.usage.cache_read += u.cache_read_input_tokens ?? 0; run.usage.cache_write += u.cache_creation_input_tokens ?? 0;
    run.usage.requests++;
    const content = (res.content ?? []) as Array<Record<string, unknown>>;
    messages.push({ role: 'assistant', content });
    const calls = content.filter(c => c.type === 'tool_use');
    if (!calls.length) {
      run.text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (nudged) { run.stop = 'no_tool_call'; return; }
      nudged = true;
      messages.push({ role: 'user', content: [{ type: 'text', text: NUDGE }] });
      continue;
    }
    const results: Array<Record<string, unknown>> = [];
    let submitted = false;
    for (const c of calls) {
      const r = await execute(String(c.name), (c.input ?? {}) as Record<string, unknown>);
      results.push({ type: 'tool_result', tool_use_id: c.id, content: r.text });
      submitted ||= r.submitted;
    }
    if (submitted) { run.stop = 'submitted'; return; }
    messages.push({ role: 'user', content: results });
  }
}

async function openaiLoop(cfg: LoopConfig, run: AgentRun, specs: () => ToolSpec[], execute: Exec, maxTurns: number, fetchImpl: typeof fetch) {
  const currentTools = toolList(cfg, () => specs().map(s => ({ type: 'function', name: s.name, description: s.description, parameters: s.input_schema, strict: false })));
  const headers = { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` };
  let input: unknown[] = [{ role: 'user', content: cfg.user }];
  let previous: string | undefined;
  let nudged = false;
  for (let turn = 0; turn < maxTurns; turn++) {
    run.turns++;
    const s = Date.now();
    const res = await postJson(fetchImpl, 'https://api.openai.com/v1/responses', headers, {
      model: cfg.model, instructions: cfg.system, input, tools: currentTools(), max_output_tokens: cfg.maxOutputTokens ?? 16_000,
      ...(previous ? { previous_response_id: previous } : {}),
    });
    run.model_ms += Date.now() - s;
    const u = (res.usage ?? {}) as Record<string, unknown>;
    const cached = ((u.input_tokens_details ?? {}) as Record<string, number>).cached_tokens ?? 0;
    run.usage.input += ((u.input_tokens as number) ?? 0) - cached; run.usage.cache_read += cached;
    run.usage.output += (u.output_tokens as number) ?? 0;
    run.usage.requests++;
    previous = String(res.id);
    const output = (res.output ?? []) as Array<Record<string, unknown>>;
    const calls = output.filter(o => o.type === 'function_call');
    if (!calls.length) {
      run.text = output.filter(o => o.type === 'message').flatMap(o => (o.content as Array<Record<string, unknown>>) ?? []).map(c => c.text).join('\n');
      if (nudged) { run.stop = 'no_tool_call'; return; }
      nudged = true;
      input = [{ role: 'user', content: NUDGE }];
      continue;
    }
    const outputs: unknown[] = [];
    let submitted = false;
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(c.arguments ?? '{}')); } catch { args = {}; }
      const r = await execute(String(c.name), args);
      outputs.push({ type: 'function_call_output', call_id: c.call_id, output: r.text });
      submitted ||= r.submitted;
    }
    if (submitted) { run.stop = 'submitted'; return; }
    input = outputs;
  }
}

/** One plain text completion (the claims judges), priced like an agent call. */
export async function runAgentText(model: string, system: string, user: string): Promise<{ text: string; usd: number }> {
  if (provider(model) === 'openai') {
    const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, instructions: system, input: user, max_output_tokens: 8000, reasoning: { effort: 'low' } }) });
    const j = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(`judge error ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const text = ((j.output ?? []) as Array<Record<string, unknown>>).filter(o => o.type === 'message').flatMap(o => (o.content as Array<Record<string, unknown>>) ?? []).map(c => String(c.text ?? '')).join('\n');
    const u = j.usage as Record<string, unknown>;
    const cached = ((u.input_tokens_details ?? {}) as Record<string, number>).cached_tokens ?? 0;
    return { text, usd: priceUsage(model, { input: (u.input_tokens as number) - cached, cache_read: cached, cache_write: 0, output: u.output_tokens as number, requests: 1 }) };
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }) });
  const j = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`judge error ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const text = ((j.content ?? []) as Array<Record<string, unknown>>).filter(c => c.type === 'text').map(c => String(c.text)).join('\n');
  const u = j.usage as Record<string, number>;
  return { text, usd: priceUsage(model, { input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, requests: 1 }) };
}
