/**
 * An Anthropic-shaped `messages.create` that calls OpenAI's Responses API, so
 * a runner whose judge speaks the Anthropic SDK (forced tool use) can run an
 * OpenAI judge without a second code path (W8, 2026-10 follow-up round).
 *
 * Mapping: `system` -> `instructions`; user and assistant messages -> `input`
 * (text blocks joined, tool-use blocks as their JSON); a forced tool
 * (`tool_choice: {type:'tool'}`) -> a `json_schema` text format built from the
 * tool's `input_schema`, and the JSON reply comes back as a `tool_use` block.
 * `temperature` is not sent (OpenAI's reasoning models reject it). The output
 * limit is raised to at least `minOutputTokens`, since reasoning tokens count
 * against it, and reasoning effort is fixed per shim. A reply cut at the limit
 * returns `stop_reason: 'max_tokens'` with whatever text arrived.
 *
 * Requests go through `globalThis.fetch`, so the ledger's paid-request guard
 * reserves and settles them like any other provider call.
 */
import type Anthropic from '@anthropic-ai/sdk';

export const OPENAI_JUDGE_REASONING_EFFORT = 'low';
export const OPENAI_JUDGE_MIN_OUTPUT_TOKENS = 8000;

export function isOpenAIModel(model: string): boolean {
  return /^openai:/.test(model) || /^gpt-/.test(model) || /^o\d/.test(model);
}

type Block = { type: string; text?: string; input?: unknown };

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return (content as Block[]).map(b => b.type === 'text' ? b.text ?? '' : b.type === 'tool_use' ? JSON.stringify(b.input) : '').join('\n');
  return '';
}

export interface ShimOptions { apiKey?: string; reasoningEffort?: string; minOutputTokens?: number; fetchImpl?: typeof fetch }

export function openAIMessagesShim(options: ShimOptions = {}): Pick<Anthropic, 'messages'> {
  const create = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    const model = params.model.replace(/^openai:/, '');
    const forced = params.tool_choice && (params.tool_choice as { type: string }).type === 'tool'
      ? (params.tools ?? []).find(t => (t as { name: string }).name === (params.tool_choice as { name: string }).name) as { name: string; input_schema: unknown } | undefined
      : undefined;
    const body = {
      model,
      ...(params.system ? { instructions: text(params.system) } : {}),
      input: params.messages.map(m => ({ role: m.role, content: text(m.content) })),
      max_output_tokens: Math.max(params.max_tokens, options.minOutputTokens ?? OPENAI_JUDGE_MIN_OUTPUT_TOKENS),
      reasoning: { effort: options.reasoningEffort ?? OPENAI_JUDGE_REASONING_EFFORT },
      ...(forced ? { text: { format: { type: 'json_schema', name: forced.name, schema: forced.input_schema, strict: false } } } : {}),
    };
    const res = await (options.fetchImpl ?? globalThis.fetch)('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey ?? process.env.OPENAI_API_KEY ?? ''}` },
      body: JSON.stringify(body),
    });
    const json = await res.json() as {
      id?: string; model?: string; status?: string; error?: { message?: string };
      output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (!res.ok) throw Object.assign(new Error(`OpenAI ${res.status}: ${json.error?.message ?? 'request failed'}`), { status: res.status });
    const out = (json.output ?? []).filter(o => o.type === 'message').flatMap(o => o.content ?? []).filter(c => c.type === 'output_text').map(c => c.text ?? '').join('');
    const truncated = json.status === 'incomplete';
    let content: Anthropic.ContentBlock[] = [{ type: 'text', text: out, citations: null } as Anthropic.TextBlock];
    if (forced && !truncated) {
      try { content = [{ type: 'tool_use', id: `shim_${json.id ?? 'x'}`, name: forced.name, input: JSON.parse(out) } as Anthropic.ToolUseBlock]; } catch { /* malformed: left as text, the caller's retry handles it */ }
    }
    return {
      id: json.id ?? 'shim', type: 'message', role: 'assistant', model: json.model ?? model, content,
      stop_reason: truncated ? 'max_tokens' : content[0]!.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: json.usage?.input_tokens ?? 0, output_tokens: json.usage?.output_tokens ?? 0 },
    } as unknown as Anthropic.Message;
  };
  return { messages: { create } } as unknown as Pick<Anthropic, 'messages'>;
}

/** The judge client for a model: the shim for OpenAI models, otherwise the given Anthropic client. */
export function judgeClientFor<T>(model: string, anthropic: () => T): T {
  return isOpenAIModel(model) ? openAIMessagesShim() as unknown as T : anthropic();
}

/** Anthropic SDK model id: drops an `anthropic:` prefix. */
export function anthropicModelId(model: string): string {
  return model.replace(/^anthropic:/, '');
}

/** How a judge model is called, for receipts. */
export function judgeTransport(model: string): string {
  return isOpenAIModel(model)
    ? `OpenAI Responses API through openai-judge-shim: no temperature, reasoning effort ${OPENAI_JUDGE_REASONING_EFFORT}, max_output_tokens at least ${OPENAI_JUDGE_MIN_OUTPUT_TOKENS}`
    : 'Anthropic Messages API';
}

/**
 * Whether a model accepts a `temperature` parameter. Claude 5-family models
 * reject it ("temperature is deprecated for this model"), as do OpenAI
 * reasoning models; runners send it only where it is accepted and record
 * provider-default sampling otherwise.
 */
export function acceptsTemperature(model: string): boolean {
  if (isOpenAIModel(model)) return false;
  return !/(?:^|[:/])(?:anthropic[:/])?claude-[a-z]+-5(?:[.-]|$)/i.test(model);
}
