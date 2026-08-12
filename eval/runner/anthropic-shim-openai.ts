/**
 * Minimal OpenAI → Anthropic client shim so gbrain-evals programmatic runners
 * can use OPENAI_API_KEY when the Anthropic key has model-access issues.
 *
 * Maps Anthropic `messages.create` shape to `https://api.openai.com/v1/chat/completions`
 * and back. Supports tool_calls / function results.
 */

export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean } | AnthropicToolUseBlock>;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AnthropicToolChoice {
  type: 'tool';
  name: string;
}

export interface AnthropicMessageOptions {
  model?: string;
  max_tokens?: number;
  system?: Array<{ type: 'text'; text: string }>;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  messages: AnthropicMessageParam[];
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  name: string;
  id: string;
  input: Record<string, unknown>;
}

export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<AnthropicToolUseBlock | { type: 'text'; text: string }>;
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | string;
  usage: { input_tokens: number; output_tokens: number };
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function anthropicToolsToOpenAI(tools?: AnthropicTool[]) {
  if (!tools) return undefined;
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema,
    },
  }));
}

function blockToText(block: any): string {
  if (typeof block === 'string') return block;
  if (block && block.type === 'text') return block.text ?? '';
  return '';
}

function buildOpenAIMessages(opts: AnthropicMessageOptions) {
  const messages: any[] = [];
  const systemParts = (opts.system ?? []).map(s => s.text).join('\n');
  if (systemParts) {
    messages.push({ role: 'system', content: systemParts });
  }
  for (const m of opts.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) {
      messages.push({ role: m.role, content: String(m.content ?? '') });
      continue;
    }

    if (m.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: any[] = [];
      for (const block of m.content) {
        if (block && block.type === 'text') {
          textParts.push(block.text ?? '');
        } else if (block && block.type === 'tool_use') {
          toolCalls.push({
            id: block.id ?? makeId(),
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      const out: any = { role: 'assistant' };
      const text = textParts.join('\n');
      if (text.trim()) out.content = text;
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
      continue;
    }

    // user message containing tool_result blocks -> one OpenAI tool message per result
    if (m.role === 'user') {
      for (const block of m.content) {
        if (block && block.type === 'tool_result') {
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: String(block.content ?? ''),
          });
        } else if (block && block.type === 'text') {
          messages.push({ role: 'user', content: block.text ?? '' });
        } else {
          messages.push({ role: 'user', content: blockToText(block) });
        }
      }
      continue;
    }
  }
  return messages;
}

function buildToolChoice(opts: AnthropicMessageOptions) {
  if (!opts.tool_choice) return undefined;
  return { type: 'function' as const, function: { name: opts.tool_choice.name } };
}

function openAIResponseToAnthropic(json: any, requestOpts: AnthropicMessageOptions): AnthropicMessage {
  const choice = json.choices?.[0];
  const msg = choice?.message ?? {};
  const content: AnthropicMessage['content'] = [];

  if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
    content.push({ type: 'text', text: msg.content });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.type !== 'function') continue;
      const args = JSON.parse(tc.function?.arguments ?? '{}');
      content.push({ type: 'tool_use', name: tc.function.name, id: tc.id ?? makeId(), input: args });
    }
  }

  const usage = json.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const stop = choice?.finish_reason ?? 'end_turn';
  return {
    id: json.id ?? makeId(),
    type: 'message',
    role: 'assistant',
    content,
    model: json.model ?? requestOpts.model ?? 'openai-shim',
    stop_reason: stop === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
  };
}

export function createOpenAIAnthropicShim(opts: { apiKey?: string; baseUrl?: string; defaultModel?: string } = {}) {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
  const defaultModel = opts.defaultModel ?? 'gpt-4o-mini';

  return {
    messages: {
      create: async (params: AnthropicMessageOptions): Promise<AnthropicMessage> => {
        const body = {
          model: params.model ?? defaultModel,
          max_tokens: params.max_tokens ?? 1024,
          messages: buildOpenAIMessages(params),
          tools: anthropicToolsToOpenAI(params.tools),
          tool_choice: buildToolChoice(params),
        };

        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });

        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(`OpenAI shim error: ${res.status} ${JSON.stringify(json)}`);
        }
        return openAIResponseToAnthropic(json, params);
      },
    },
  };
}
