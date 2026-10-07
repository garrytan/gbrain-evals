/**
 * Whole-system arms that answer a question themselves instead of returning
 * evidence for a fixed reader: the file agent (`baseline-file-agent`) and the
 * agent runtime cell (`ext-agent-runtime`). Both keep the `MemorySystem`
 * lifecycle (reset, ingest, finish, delete) and add `answer`.
 */
import type { Outcome } from '../memory-qa/outcomes.ts';
import type { MemorySystem, PublicQuestion } from './types.ts';

export interface AnswerUsage { input: number; output: number; cache_read: number; cache_write: number }

export interface AgentAnswer {
  /** The full answer text, never truncated. */
  text: string;
  /** Why the agent stopped: `submitted`, `turn_cap`, `no_tool_call`, `context_overflow`, `provider_error`, ... */
  stop_reason: string;
  /** `scored`; a product failure (`retrieval_error`, scored 0) such as a turn-cap stop; or a harness failure (`reader_error`). */
  outcome: Outcome;
  usage: AnswerUsage;
  /** Input tokens the provider billed, cached and uncached together. */
  provider_input_tokens: number;
  latency_ms: number;
  turns: number;
  usd: number;
  /** Evaluator-side only: the ingested source ids whose files the agent read before answering. */
  opened_source_ids: string[];
  error?: string;
}

export interface AnswerOptions {
  /** Reader as `provider:model`, for example `anthropic:claude-opus-5-5`. */
  reader: string;
  replicate: number;
}

export interface AnsweringSystem extends MemorySystem {
  answer(ns: string, question: PublicQuestion, opts: AnswerOptions): Promise<AgentAnswer>;
}
