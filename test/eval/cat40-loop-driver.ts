/**
 * A scripted provider for the Cat 40 agent loop (eval/runner/cat40/loop.ts): one conversation per provider that calls a
 * tool, answers once in plain text (so the loop nudges), then submits. It records every request the loop sends and
 * can queue HTTP faults before a turn's answer. test/eval/cat40-particle-loop.test.ts drives it, and its recorded
 * request bodies for claude-opus-5-5 and gpt-6.1-sol are the byte-identity fixture
 * (test/eval/fixtures/cat40-loop-bodies.json, captured from main before the particle branch landed).
 */
import { runAgent, type AgentRun, type Arm, type LoopConfig, type ProviderAttempt } from '../../eval/runner/cat40/loop.ts';

export type DriverProvider = 'anthropic' | 'openai' | 'particle';

export const DRIVER_ARM: Arm = {
  name: 'driver',
  systemHint: () => 'Use lookup to read a value.',
  tools: () => [{ name: 'lookup', description: 'Look up a key.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }],
  call: async (_name, args) => `value of ${String(args.key)}`,
  writeTools: () => [],
};

export interface DriverFault { status: number; body?: string; headers?: Record<string, string> }
export interface DriverRequest { url: string; headerNames: string[]; body: string }

/** The three turns' answers in each provider's wire format; `badArgs` makes the particle tool call's arguments unparseable. */
export function turnResponse(p: DriverProvider, turn: number, model: string, opts: { badArgs?: boolean } = {}): Record<string, unknown> {
  if (p === 'anthropic') {
    const usage = { input_tokens: 100 + turn, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 };
    if (turn === 1) return { id: 'msg_1', model, content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { key: 'a' } }], stop_reason: 'tool_use', usage };
    if (turn === 2) return { id: 'msg_2', model, content: [{ type: 'text', text: 'The value is known.' }], stop_reason: 'end_turn', usage };
    return { id: 'msg_3', model, content: [{ type: 'tool_use', id: 'toolu_3', name: 'submit_answer', input: { answer: '42', sources: ['a'] } }], stop_reason: 'tool_use', usage };
  }
  if (p === 'openai') {
    const usage = { input_tokens: 100 + turn, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } };
    if (turn === 1) return { id: 'resp_1', model, status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"key":"a"}' }], usage };
    if (turn === 2) return { id: 'resp_2', model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'The value is known.' }] }], usage };
    return { id: 'resp_3', model, status: 'completed', output: [{ type: 'function_call', call_id: 'call_3', name: 'submit_answer', arguments: '{"answer":"42","sources":["a"]}' }], usage };
  }
  const usage = { prompt_tokens: 1000 + turn, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 250 } };
  const base = { id: `chatcmpl-${turn}`, object: 'chat.completion', model: 'particle-ai/particle-1', service_tier: 'default', system_fingerprint: 'fp_driver', metadata: { weight_version: 'default' }, usage };
  const call = (id: string, name: string, args: string) => ({ id, type: 'function', function: { name, arguments: args } });
  if (turn === 1) return { ...base, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: 'Look it up.', tool_calls: [call('call_1', 'lookup', opts.badArgs ? '{"key": "a"' : '{"key":"a"}')] } }] };
  if (turn === 2) return { ...base, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'The value is known.', reasoning_content: 'Answer in text.' } }] };
  return { ...base, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call('call_3', 'submit_answer', '{"answer":"42","sources":["a"]}')] } }] };
}

/** A fetch that answers each turn of `p`'s conversation in order, after any queued faults; every request is recorded. */
export function scriptedFetch(p: DriverProvider, model: string, opts: { faults?: DriverFault[]; badArgs?: boolean } = {}) {
  const requests: DriverRequest[] = [];
  const faults = [...(opts.faults ?? [])];
  let turn = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headerNames: Object.keys((init?.headers ?? {}) as Record<string, string>).sort(), body: String(init?.body) });
    const fault = faults.shift();
    if (fault) return new Response(fault.body ?? JSON.stringify({ error: { message: `fault ${fault.status}` } }), { status: fault.status, headers: fault.headers });
    turn++;
    return new Response(JSON.stringify(turnResponse(p, turn, model, opts)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

/** One conversation through runAgent with the scripted provider; returns the run, the requests and every onAttempt call. */
export async function drive(p: DriverProvider, model: string, cfg: Partial<LoopConfig> = {}, opts: { faults?: DriverFault[]; badArgs?: boolean } = {}): Promise<{ run: AgentRun; requests: DriverRequest[]; attempts: ProviderAttempt[] }> {
  const { fetchImpl, requests } = scriptedFetch(p, model, opts);
  const attempts: ProviderAttempt[] = [];
  const run = await runAgent({ model, system: 'You answer from the knowledge base.', user: 'What is a?', arm: DRIVER_ARM, fetchImpl, onAttempt: a => attempts.push(a), ...cfg });
  return { run, requests, attempts };
}
