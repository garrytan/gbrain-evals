/**
 * Anthropic Messages request fields fitted to the model (audit B1, 2026-10-31).
 *
 * Runners write a judge or agent request the way older Claude models take it: `temperature: 0` so
 * verdicts and transcripts are reproducible and, for structured output, a forced
 * `tool_choice: {type: 'tool'}`. Claude 5-family models reject `temperature` ("temperature is
 * deprecated for this model"), and claude-opus-5-5 and claude-sonnet-5-5 also reject a forced tool
 * choice ("tool_choice: type tool and any are not supported for this model"). `fitAnthropicRequest`
 * drops `temperature` where the model rejects it and, for the Claude 5 family, sends
 * `tool_choice: {type: 'auto'}` with a trailing user message telling the model to call the tool;
 * every caller already retries a response with no tool_use block. claude-haiku-5-5 accepts a forced
 * tool choice (probe 2026-10-31) but takes the family rule, which every model accepts.
 *
 * Claude 5-family models also think before they answer, and thinking counts toward `max_tokens`.
 * At Cat 14's 700-token judge limit claude-opus-5-5 spent every token thinking and never called the
 * tool; with room, the same judge call used 647 to 1,325 output tokens across the three Claude 5
 * models (2026-10-31). So where a runner sets its own default limit, `withThinkingRoom` raises it
 * to at least 4,096 for this family, about the limit Cat 40's Opus-tested claims judge (4,000) and the
 * W10 Sonnet 5.5 and Opus 5.5 readers (4,096) use. A limit the caller passes explicitly is sent as given, so a
 * runner that takes an explicit judge limit from a profile checks it with `assertJudgeThinkingRoom` first.
 *
 * A request for any other model comes back unchanged, key order included, so older-model requests
 * stay byte-identical and their receipts stay comparable. A Claude 5 judge is a new judge identity:
 * never pool its verdicts with Haiku 4.5 verdicts.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { acceptsTemperature, isClaude5Family } from './openai-judge-shim.ts';

/** Whether a model accepts a forced `tool_choice`; the Claude 5 family gets `auto` and an instruction instead. */
export function acceptsForcedToolChoice(model: string): boolean {
  return !isClaude5Family(model);
}

/** The least output limit a Claude 5-family request gets, because the model thinks inside it. */
export const CLAUDE5_THINKING_FLOOR = 4096;

/** A runner's default output limit for a model: at least CLAUDE5_THINKING_FLOOR tokens for the Claude 5 family. */
export function withThinkingRoom(model: string, maxTokens: number): number {
  return isClaude5Family(model) ? Math.max(maxTokens, CLAUDE5_THINKING_FLOOR) : maxTokens;
}

/** Refuses an explicit judge limit a Claude 5-family judge would spend thinking, before any paid call; explicit limits are sent as given. */
export function assertJudgeThinkingRoom(model: string, maxTokens: number): void {
  if (withThinkingRoom(model, maxTokens) !== maxTokens) throw new Error(`judge_max_tokens ${maxTokens} is below the Claude 5 thinking floor (${CLAUDE5_THINKING_FLOOR}) for ${model}`);
}

/** The temperature a fitted request sends, for receipts: null when the model rejects it. */
export function temperatureSent(model: string, temperature: number): number | null {
  return acceptsTemperature(model) ? temperature : null;
}

/** The `tool_choice` type a fitted request sends where the runner forces a tool, for receipts. */
export function toolChoiceSent(model: string): 'tool' | 'auto' {
  return acceptsForcedToolChoice(model) ? 'tool' : 'auto';
}

/** The request as the model accepts it; unchanged for a model that takes `temperature` and a forced tool choice. */
export function fitAnthropicRequest(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.MessageCreateParamsNonStreaming {
  const fitted = { ...params };
  if (fitted.temperature !== undefined && temperatureSent(fitted.model, fitted.temperature) === null) delete fitted.temperature;
  const forced = fitted.tool_choice?.type === 'tool' ? fitted.tool_choice.name : null;
  if (forced !== null && !acceptsForcedToolChoice(fitted.model)) {
    fitted.tool_choice = { type: 'auto' };
    fitted.messages = [...fitted.messages, { role: 'user', content: `Respond by calling the ${forced} tool.` }];
  }
  return fitted;
}
