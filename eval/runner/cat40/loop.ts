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
 * Particle (`particle-1`): Chat Completions built, parsed and classified by the provider module
 * (eval/runner/providers/openai-compatible.ts) and sent through the same retry loop. It resends the whole transcript
 * each turn, so its input grows with the square of the turn count, where the OpenAI branch sends only new input after
 * `previous_response_id`; Particle caches repeated prefixes implicitly. Only this branch waits a provider's
 * Retry-After (capped at 120 s), and an empty Particle balance (HTTP 402) stops the run as a budget stop.
 */
import { createHash } from 'node:crypto';
import { CHAT_PRICE_OVERRIDES } from '../budget-ledger.ts';
import { assertMetered, classifyCompatError, compatError, compatRequest, parseCompatResponse, type CompatMessage, type CompatToolCall } from '../providers/openai-compatible.ts';
import { normalizeUsage, type NormalizedUsage } from '../q1/usage.ts';
import { normalizeFinish, normalizeUsage as receiptUsage, receipt, responseMeta, usageSourceOf, type ReceiptRequest, type UsageReceipt } from '../usage-receipt.ts';

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

/** Summed over the run's model calls, normalized by eval/runner/q1/usage.ts: `input` is uncached input for every provider. */
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
  /** Particle runs only: turns with at least one tool call whose arguments were not a JSON object (run with `{}`). */
  unparseable_tool_turns?: number;
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
  /** The answer tool; default `SUBMIT_TOOL`. It must be named `submit_answer`. */
  submitTool?: ToolSpec;
  /**
   * Reasoning effort: Anthropic `output_config.effort` (as memory-qa/qa-v2.ts sends it) and, on the OpenAI Responses API
   * this loop calls, `reasoning.effort` (the Responses form of Chat Completions' `reasoning_effort`). Absent, nothing is
   * added, so Cat 40's requests stay byte-identical. Particle always sends `reasoning_effort`: this value, else `high`.
   */
  effort?: string;
  /** Called once per provider attempt, retries included, with the parsed response or the error (for usage receipts). */
  onAttempt?: (a: ProviderAttempt) => void;
}

export interface ProviderAttempt {
  status: 'ok' | 'error';
  /** The parsed response; on a Particle 2xx without `choices[0].message` (an error attempt), the body, for its usage. */
  response: Record<string, unknown> | null;
  error: string | null;
  ms: number;
  /** The loop's turn, 1-based, when the attempt came from runAgent. */
  turn?: number;
  /** What the request sent that changes the answer (effort, output limit, sampling), when the attempt came from runAgent. */
  request?: ReceiptRequest;
  /** Particle only: the provider's Retry-After as milliseconds, capped at 120 s; the next attempt waits at least this and at least the backoff. Null when it sent none. */
  retry_after_ms?: number | null;
}

/** A scripted model returns the next tool call (or a final submit) given the transcript so far. */
export type ScriptedModel = (history: Array<{ name: string; args: Record<string, unknown>; result: string }>) => { name: string; args: Record<string, unknown> };

export const DEFAULT_MAX_TURNS = 16;
/** Sent once when a model stops without calling a tool; harnesses enforce structured output the same way. */
export const NUDGE = 'Please call submit_answer now with your final answer.';

export function provider(model: string): 'anthropic' | 'openai' | 'particle' {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || /^o\d/.test(model)) return 'openai';
  if (model.startsWith('particle-')) return 'particle';
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

/**
 * Up to 6 attempts with exponential backoff on retryable statuses. `compat` names an OpenAI-compatible provider
 * (Particle): its errors are classified by the provider module, a retry waits at least the Retry-After it sends (capped
 * at 120 s) and never less than the backoff, a credit or proxy 402 throws the budget stop after its attempt is recorded,
 * a network or body-read failure is recorded before it propagates, and a 2xx that is not JSON or has no
 * `choices[0].message` is retried as a server error. Without `compat` (Anthropic, OpenAI) attempts and waits are as
 * they always were.
 */
async function postJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown, onAttempt?: (a: ProviderAttempt) => void, compat?: string): Promise<Record<string, unknown>> {
  let last: ProviderError | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const t = Date.now();
    let res: Response;
    try { res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); }
    catch (e) {
      if (compat) onAttempt?.({ status: 'error', response: null, error: `network: ${(e as Error).message.slice(0, 500)}`, ms: Date.now() - t, retry_after_ms: null });
      throw e;
    }
    let text: string;
    try { text = await res.text(); }
    catch (e) {
      if (compat) onAttempt?.({ status: 'error', response: null, error: `network: reading the ${res.status} body failed: ${(e as Error).message.slice(0, 500)}`, ms: Date.now() - t, retry_after_ms: null });
      throw e;
    }
    if (res.ok) {
      let json: Record<string, unknown> | null = null;
      let parsed = true;
      try { json = JSON.parse(text) as Record<string, unknown>; }
      catch (e) { if (!compat) throw e; parsed = false; }
      const choices = (compat && !json ? undefined : json!.choices) as Array<{ message?: unknown }> | undefined;
      if (!compat || (Array.isArray(choices) && choices[0]?.message)) {
        onAttempt?.({ status: 'ok', response: json, error: null, ms: Date.now() - t });
        return json!;
      }
      last = new ProviderError(502, `${compat} answered ${res.status} ${parsed ? 'without choices[0].message' : 'with a body that is not JSON'}: ${text.slice(0, 300)}`);
      onAttempt?.({ status: 'error', response: json, error: last.message, ms: Date.now() - t, retry_after_ms: null });
      await new Promise(r => setTimeout(r, Math.min(60_000, 2000 * 2 ** attempt) + Math.random() * 1000));
      continue;
    }
    last = new ProviderError(res.status, text);
    const info = compat ? classifyCompatError(compat, res.status, text, res.headers) : null;
    onAttempt?.({ status: 'error', response: null, error: `${res.status}: ${text.slice(0, 500)}`, ms: Date.now() - t, ...(info ? { retry_after_ms: info.retryAfterMs } : {}) });
    if (info?.kind === 'credit_exhausted' || info?.kind === 'proxy_budget') throw compatError(info);
    if (!RETRYABLE_STATUS.includes(res.status)) break;
    await new Promise(r => setTimeout(r, Math.max(info?.retryAfterMs ?? 0, Math.min(60_000, 2000 * 2 ** attempt) + Math.random() * 1000)));
  }
  throw last!;
}

export async function runAgent(cfg: LoopConfig): Promise<AgentRun> {
  const t0 = Date.now();
  const maxTurns = cfg.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxChars = cfg.maxToolChars ?? null;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const run: AgentRun = { model: cfg.model, final: null, stop: 'turn_cap', turns: 0, tools: [], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, requests: 0 }, usd: 0, ms: 0, model_ms: 0, tool_ms: 0 };
  const submitTool = cfg.submitTool ?? SUBMIT_TOOL;
  if (submitTool.name !== SUBMIT_TOOL.name) throw new Error(`submitTool must be named ${SUBMIT_TOOL.name}`);
  const specs = (): ToolSpec[] => [...cfg.arm.tools(), submitTool];

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
    } else if (provider(cfg.model) === 'particle') {
      await particleLoop(cfg, run, specs, execute, maxTurns, fetchImpl);
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

function addUsage(run: AgentRun, u: NormalizedUsage) {
  run.usage.input += u.uncached_input; run.usage.output += u.output;
  run.usage.cache_read += u.cache_read; run.usage.cache_write += u.cache_write;
  run.usage.requests++;
}

type Exec = (name: string, args: Record<string, unknown>) => Promise<{ text: string; submitted: boolean }>;

/** cfg.onAttempt with the loop's turn and what the request sent added to every attempt. */
function attemptHook(cfg: LoopConfig, run: AgentRun, request: () => ReceiptRequest): ((a: ProviderAttempt) => void) | undefined {
  return cfg.onAttempt && (a => cfg.onAttempt!({ ...a, turn: run.turns, request: request() }));
}

/** What an Anthropic or OpenAI request sent: the effort exactly as passed (these providers run the level they are sent) and the output limit. */
const sentRequest = (effort: string | undefined, field: string, limit: number): ReceiptRequest =>
  ({ effort_sent: effort ?? null, effort_effective: effort ?? null, output_limit_field: field, output_limit: limit, temperature_sent: null, seed_sent: null });

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
  const request = sentRequest(cfg.effort, 'max_tokens', cfg.maxOutputTokens ?? 8192);
  const onAttempt = attemptHook(cfg, run, () => request);
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
      ...(cfg.effort !== undefined ? { output_config: { effort: cfg.effort } } : {}),
    }, onAttempt);
    run.model_ms += Date.now() - s;
    addUsage(run, normalizeUsage('anthropic', res.usage as object | undefined));
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
  const request = sentRequest(cfg.effort, 'max_output_tokens', cfg.maxOutputTokens ?? 16_000);
  const onAttempt = attemptHook(cfg, run, () => request);
  let input: unknown[] = [{ role: 'user', content: cfg.user }];
  let previous: string | undefined;
  let nudged = false;
  for (let turn = 0; turn < maxTurns; turn++) {
    run.turns++;
    const s = Date.now();
    const res = await postJson(fetchImpl, 'https://api.openai.com/v1/responses', headers, {
      model: cfg.model, instructions: cfg.system, input, tools: currentTools(), max_output_tokens: cfg.maxOutputTokens ?? 16_000,
      ...(previous ? { previous_response_id: previous } : {}), ...(cfg.effort !== undefined ? { reasoning: { effort: cfg.effort } } : {}),
    }, onAttempt);
    run.model_ms += Date.now() - s;
    addUsage(run, normalizeUsage('openai', res.usage as object | undefined));
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

/**
 * Particle: Chat Completions with tools as functions and `tool_choice: auto`, the system prompt as the first message,
 * assistant tool-call turns echoed without their `reasoning_content`, tool results as `role: tool`, and one
 * `prompt_cache_key` per conversation (the hash of its system prompt and first user message). The turn cap, nudge,
 * retries and stop rules are the other branches'. A tool call whose arguments are not a JSON object runs with `{}`, as
 * the OpenAI branch does, and its turn is counted in `unparseable_tool_turns`.
 */
async function particleLoop(cfg: LoopConfig, run: AgentRun, specs: () => ToolSpec[], execute: Exec, maxTurns: number, fetchImpl: typeof fetch) {
  const currentTools = toolList(cfg, () => specs().map(s => ({ type: 'function' as const, function: { name: s.name, description: s.description, parameters: s.input_schema } })));
  const messages: CompatMessage[] = [{ role: 'system', content: cfg.system }, { role: 'user', content: cfg.user }];
  const promptCacheKey = createHash('sha256').update(`cat40\u0000${cfg.model}\u0000${cfg.system}\u0000${cfg.user}`).digest('hex').slice(0, 32);
  let nudged = false;
  for (let turn = 0; turn < maxTurns; turn++) {
    run.turns++;
    const req = compatRequest(`particle:${cfg.model}`, messages, { effort: cfg.effort ?? 'high', maxOutputTokens: cfg.maxOutputTokens ?? 16_000, tools: currentTools(), toolChoice: 'auto', promptCacheKey });
    assertMetered(req);
    const s = Date.now();
    const res = parseCompatResponse(await postJson(fetchImpl, req.url, req.headers, req.body, attemptHook(cfg, run, () => req.sent), req.provider));
    run.model_ms += Date.now() - s;
    addUsage(run, normalizeUsage('openai', res.usage ?? undefined));
    const calls: CompatToolCall[] = res.tool_calls.map(c => ({ id: String(c.id), type: 'function', function: { name: String(c.function?.name), arguments: String(c.function?.arguments ?? '') } }));
    messages.push({ role: 'assistant', content: calls.length ? res.text || null : res.text, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      run.text = res.text;
      if (nudged) { run.stop = 'no_tool_call'; return; }
      nudged = true;
      messages.push({ role: 'user', content: NUDGE });
      continue;
    }
    let submitted = false;
    let unparseable = false;
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(c.function.arguments || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        else unparseable = true;
      } catch { unparseable = true; }
      const r = await execute(c.function.name, args);
      messages.push({ role: 'tool', tool_call_id: c.id, content: r.text });
      submitted ||= r.submitted;
    }
    if (unparseable) run.unparseable_tool_turns = (run.unparseable_tool_turns ?? 0) + 1;
    if (submitted) { run.stop = 'submitted'; return; }
  }
}

/**
 * One usage receipt (eval/runner/usage-receipt.ts) for a provider attempt of `model`: the turn's text with its tool
 * calls, the finish, usage, what the request sent and, for Particle, the response metadata (null fields on a failed
 * attempt). The caller names the lane and the question; `turn`, `ms` and `retry_after_ms` come from the attempt.
 */
export function attemptReceipt(model: string, a: ProviderAttempt, ids: Pick<UsageReceipt, 'lane' | 'role' | 'question_id' | 'replicate' | 'attempt'>): UsageReceipt & { turn: number | null; ms: number; retry_after_ms: number | null } {
  const p = provider(model);
  const r = a.response ?? {};
  const parts = (p === 'anthropic' ? (r.content ?? []) as Array<Record<string, unknown>> : p === 'openai' ? (r.output ?? []) as Array<Record<string, unknown>> : [])
    .flatMap(c => c.type === 'text' ? [String(c.text)] : c.type === 'tool_use' ? [`[tool_use ${String(c.name)}] ${JSON.stringify(c.input)}`]
      : c.type === 'message' ? ((c.content as Array<Record<string, unknown>>) ?? []).map(x => String(x.text ?? '')) : c.type === 'function_call' ? [`[tool_use ${String(c.name)}] ${String(c.arguments)}`] : []);
  const compat = p === 'particle' && a.response ? parseCompatResponse(a.response) : null;
  if (compat) parts.push(...(compat.text ? [compat.text] : []), ...compat.tool_calls.map(c => `[tool_use ${String(c.function?.name)}] ${String(c.function?.arguments)}`));
  const finishRaw = p === 'anthropic' ? (typeof r.stop_reason === 'string' ? r.stop_reason : null) : p === 'openai' ? (typeof r.status === 'string' ? r.status : null) : compat?.finish ?? null;
  return {
    ...receipt({
      ...ids, model: `${p}:${model}`, response_model: typeof r.model === 'string' ? r.model : null, status: a.status, error: a.error, from_cache: false,
      finish: normalizeFinish(finishRaw), finish_raw: finishRaw, answer: parts.join('\n'), usage: a.response ? receiptUsage(usageSourceOf(`${p}:${model}`), r.usage) : null,
      usage_raw: r.usage && typeof r.usage === 'object' ? r.usage as Record<string, unknown> : null, delivered: null,
      ...(a.request ? { request: a.request } : {}), ...(p === 'particle' ? { response_meta: responseMeta(a.response) } : {}),
    }),
    turn: a.turn ?? null, ms: a.ms, retry_after_ms: a.retry_after_ms ?? null,
  };
}

/** One plain text completion (the claims judges), priced like an agent call. particle-1 never judges, so it is refused. */
export async function runAgentText(model: string, system: string, user: string): Promise<{ text: string; usd: number }> {
  if (provider(model) === 'particle') throw new Error(`${model} never judges (plan GST-605: particle-1 answers and acts, it does not grade); pass a judge such as gpt-6.1-sol`);
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
