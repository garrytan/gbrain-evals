/**
 * Agent adapter — Claude Sonnet driving gbrain tools.
 *
 * Used exclusively by Cat 8 (skill compliance) and Cat 9 (end-to-end
 * workflows). **Not a retrieval adapter.** Its `query()` throws because the
 * agent loop emits a final-answer text, not a `RankedDoc[]` — forcing
 * apples-to-apples metrics on that would teach the wrong lesson.
 * Retrieval scorecards stay at 4 adapters (grep-only, vector,
 * vector-grep-rrf-fusion, gbrain).
 *
 * The agent loop (`runAgentLoop`):
 *   1. Spins up a PGLite engine seeded with `rawPages`.
 *   2. Calls Sonnet 4.6 with the 12 read + 3 dry_run tool defs from
 *      `tool-bridge.ts`. `operations.query` has `expand` stripped, so no
 *      hidden Haiku calls happen inside the trace.
 *   3. Loops tool_use → executeTool → tool_result up to `turnCap` (default 10).
 *   4. Returns `AgentRunResult` with full transcript (consumable by
 *      `recorder.ts`), evidence refs, tool-call summary, tokens, cost.
 *
 * Rate-limit handling: if Anthropic returns 429 or a rate-limit error, we
 * retry with exponential backoff (up to 3 attempts per turn).
 */

import Anthropic from '@anthropic-ai/sdk';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import type { Adapter, Page, Query, RankedDoc, BrainState, AdapterConfig } from '../types.ts';
import {
  createToolBridge,
  type PoisonFixture,
  type ToolBridgeState,
  type ToolResult,
  ForbiddenOpError,
  UnknownToolError,
} from '../tool-bridge.ts';
import type { Transcript, TranscriptTurn } from '../recorder.ts';

// ─── Types ────────────────────────────────────────────────────────────

export interface AgentAdapterState {
  engine: PGLiteEngine;
  poisonFixtures: PoisonFixture[];
}

export interface AgentRunConfig {
  /** Anthropic client. Default: lazy singleton from ANTHROPIC_API_KEY. */
  client?: Anthropic;
  /** Sonnet model id. Default: claude-sonnet-4-6. */
  model?: string;
  /** Max tokens per model call. Default 1024. */
  maxTokens?: number;
  /** Hard cap on conversation turns. Default 10. */
  turnCap?: number;
  /** System prompt. Default: brain-first iron-law + citation format + amara context. */
  systemPrompt?: string;
  /** Max retries per turn on transient errors. Default 3. */
  maxRetries?: number;
}

export interface AgentRunResult {
  transcript: Transcript;
  /** Final answer text (empty string if turn cap exceeded with no final_answer). */
  final_answer: string;
  /** Slugs the agent cited in the final answer. */
  evidence_refs: string[];
  /** Structured summary from tool-bridge state. */
  tool_bridge_state: ToolBridgeState;
  /** "brain_before_answer" | "answer_before_brain" | "no_brain_calls" — Cat 8 metric. */
  brain_first_ordering: 'brain_before_answer' | 'answer_before_brain' | 'no_brain_calls';
  /** Why the loop terminated. */
  stop_reason: 'end_turn' | 'turn_cap_exceeded' | 'agent_malformed' | 'rate_limit_exhausted';
  /** Accumulated tokens + cost for the whole run. */
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

// ─── Defaults ────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TURN_CAP = 10;
const DEFAULT_MAX_RETRIES = 3;

// Sonnet 4.6 pricing (2026-04 cents per 1M tokens).
const PRICE_INPUT_PER_M = 3.0;
const PRICE_OUTPUT_PER_M = 15.0;

export const DEFAULT_AGENT_SYSTEM_PROMPT = `You are an assistant with access to Amara Okafor's personal knowledge brain. Amara is a Partner at Halfway Capital (a fictional VC firm). Her pages live at slugs like \`user/amara-okafor\`, \`emails/em-NNNN\`, \`slack/sl-NNNN\`, \`meeting/mtg-NNNN\`, \`notes/YYYY-MM-DD-topic\`.

IRON LAW: Before answering anything about Amara, you MUST search the brain first. Call \`search\` or \`get_page\` before your final answer. Never guess from general knowledge.

Citations: every factual claim in your answer must be grounded in a page slug. Name slugs in your answer using \`people/foo\` / \`emails/em-0001\` format.

Writes: if the task asks you to update or create a brain page, use the \`dry_run_put_page\` / \`dry_run_add_link\` / \`dry_run_add_timeline_entry\` tools. These record your intent for scoring without mutating the brain. Every intended page write MUST include markdown back-links (\`[Name](people/slug)\`) to every entity you reference, and every timeline entry MUST use the exact format \`- **YYYY-MM-DD** | Source — Summary\`.

Be terse. Respect the user's time.`;

// ─── Client singleton ────────────────────────────────────────────────

let defaultClient: Anthropic | null = null;
function getDefaultClient(): Anthropic {
  if (!defaultClient) defaultClient = new Anthropic();
  return defaultClient;
}

function priceOf(input: number, output: number): number {
  return (input * PRICE_INPUT_PER_M + output * PRICE_OUTPUT_PER_M) / 1_000_000;
}

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; type?: string; error?: { type?: string } };
  if (e.status === 429 || e.status === 529) return true;
  if (e.type === 'rate_limit_error') return true;
  if (e.error?.type === 'rate_limit_error') return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Adapter class ────────────────────────────────────────────────────

export class ClaudeSonnetWithToolsAdapter implements Adapter {
  readonly name = 'claude-sonnet-with-tools';

  async init(rawPages: Page[], config: AdapterConfig & { poisonFixtures?: PoisonFixture[] }): Promise<BrainState> {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    for (const p of rawPages) {
      await engine.putPage(p.slug, {
        type: p.type,
        title: p.title,
        compiled_truth: p.compiled_truth,
        timeline: p.timeline,
      });
    }
    const state: AgentAdapterState = {
      engine,
      poisonFixtures: config.poisonFixtures ?? [],
    };
    return state;
  }

  async query(_q: Query, _state: BrainState): Promise<RankedDoc[]> {
    // Agent adapter scores on Cat 8 + Cat 9 rubrics ONLY. It emits a final
    // answer text, not a ranked document list. Trying to force retrieval
    // metrics on an agent loop produces apples-to-oranges scores that
    // teach the wrong lesson — see plan Revision 3, agent adapter scoring.
    throw new Error(
      'ClaudeSonnetWithToolsAdapter.query() is intentionally unsupported. This adapter participates in Cat 8/9 only, not the retrieval scorecard. Use runAgentLoop() instead.',
    );
  }

  async teardown(state: BrainState): Promise<void> {
    const s = state as AgentAdapterState;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyEngine = s.engine as any;
    if (typeof anyEngine.disconnect === 'function') {
      // Bounded: at gbrain v0.46.3 disconnect() can leave a never-resolving
      // promise after the ops-bridge path has run against the engine (an op
      // context handle survives; observed as bun test hanging forever on this
      // file — even --timeout can't interrupt it). Eval teardown must never
      // hang the suite on engine internals; bound then move on.
      // Promise.resolve().then(...) also swallows a SYNCHRONOUSLY-throwing or
      // non-promise-returning disconnect (a bare `.disconnect().catch()` would
      // throw before .catch attaches).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<void>((resolveP) => {
        timer = setTimeout(resolveP, teardownDisconnectBoundMs);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as unknown as { unref: () => void }).unref();
        }
      });
      const safeDisconnect = Promise.resolve()
        .then(() => anyEngine.disconnect())
        .catch(() => {});
      await Promise.race([safeDisconnect, bounded]);
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Teardown disconnect bound (ms). Tests inject a small value via
 * setTeardownDisconnectBoundMs so the never-resolving-disconnect case doesn't
 * cost a real 5s of wall clock per suite run.
 */
let teardownDisconnectBoundMs = 5000;
export function setTeardownDisconnectBoundMs(ms: number): void {
  teardownDisconnectBoundMs = ms;
}

// ─── Agent loop ───────────────────────────────────────────────────────

export async function runAgentLoop(
  probeId: string,
  probeText: string,
  state: AgentAdapterState,
  config: AgentRunConfig = {},
): Promise<AgentRunResult> {
  const client = config.client ?? getDefaultClient();
  const model = config.model ?? DEFAULT_MODEL;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const turnCap = config.turnCap ?? DEFAULT_TURN_CAP;
  const systemPrompt = config.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

  const bridge = createToolBridge({
    engine: state.engine,
    poisonFixtures: state.poisonFixtures,
  });

  const turns: TranscriptTurn[] = [];
  const startedAt = new Date();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: Array<{ role: 'user' | 'assistant'; content: any }> = [
    { role: 'user', content: probeText },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let finalAnswerText = '';
  let evidenceRefs: string[] = [];
  let stopReason: AgentRunResult['stop_reason'] = 'turn_cap_exceeded';
  let turnIndex = 0;
  let finalAnswerRecorded = false;

  for (let turn = 0; turn < turnCap; turn++) {
    // ── Sonnet call with retry on rate-limit ──
    let response: Anthropic.Messages.Message | null = null;
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt < maxRetries) {
      try {
        response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
          ],
          tools: bridge.toolDefs,
          messages,
        });
        break;
      } catch (err) {
        lastErr = err;
        if (isRateLimitError(err) && attempt < maxRetries - 1) {
          // Exponential backoff: 1s, 2s, 4s
          await sleep(1000 * Math.pow(2, attempt));
          attempt++;
          continue;
        }
        throw err;
      }
    }
    if (!response) {
      stopReason = 'rate_limit_exhausted';
      void lastErr;
      break;
    }

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    totalCost += priceOf(response.usage.input_tokens, response.usage.output_tokens);

    turns.push({
      turn_index: turnIndex++,
      kind: 'model_call',
      model_call: {
        model_id: model,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        stop_reason: response.stop_reason ?? undefined,
      },
    });

    // Append assistant message to conversation history
    messages.push({ role: 'assistant', content: response.content });

    // Collect tool_use blocks; extract text for final answer if end_turn.
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let assistantText = '';
    for (const block of response.content) {
      if (block.type === 'text') assistantText += block.text;
      if (block.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    if (response.stop_reason === 'end_turn' || toolUses.length === 0) {
      // No tool calls → this is the final answer.
      finalAnswerText = assistantText.trim();
      evidenceRefs = extractSlugs(finalAnswerText);
      turns.push({
        turn_index: turnIndex++,
        kind: 'final_answer',
        final_answer: { text: finalAnswerText, evidence_refs: evidenceRefs },
      });
      finalAnswerRecorded = true;
      stopReason = 'end_turn';
      break;
    }

    // ── Execute all tool calls from this turn, accumulate tool_result blocks ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResultsForNextTurn: any[] = [];
    for (const call of toolUses) {
      turns.push({
        turn_index: turnIndex++,
        kind: 'tool_call',
        tool_call: { tool_name: call.name, tool_input: call.input },
      });

      let toolResult: ToolResult;
      let wasError = false;
      try {
        toolResult = await bridge.executeTool(call.name, call.input);
      } catch (err) {
        wasError = true;
        if (err instanceof ForbiddenOpError || err instanceof UnknownToolError) {
          toolResult = {
            content: JSON.stringify({ error: err.message, kind: err.kind }),
            truncated: false,
            matched_poison_fixture_ids: [],
          };
        } else {
          throw err;
        }
      }

      turns.push({
        turn_index: turnIndex++,
        kind: 'tool_result',
        tool_result: {
          tool_name: call.name,
          content: toolResult.content,
          truncated: toolResult.truncated,
          matched_poison_fixture_ids: toolResult.matched_poison_fixture_ids,
        },
      });

      toolResultsForNextTurn.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: toolResult.content,
        is_error: wasError || undefined,
      });
    }

    messages.push({ role: 'user', content: toolResultsForNextTurn });
  }

  // If loop exhausted without a final_answer, emit an explicit partial turn.
  if (!finalAnswerRecorded) {
    turns.push({
      turn_index: turnIndex++,
      kind: 'final_answer',
      final_answer: { text: '', evidence_refs: [] },
    });
  }

  const endedAt = new Date();

  const transcript: Transcript = {
    schema_version: 1,
    probe_id: probeId,
    adapter: { name: 'claude-sonnet-with-tools', stack_id: 'gbrain' },
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    turns,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    elapsed_ms: endedAt.getTime() - startedAt.getTime(),
  };

  const brain_first_ordering = computeBrainFirstOrdering(bridge.state, finalAnswerRecorded);

  return {
    transcript,
    final_answer: finalAnswerText,
    evidence_refs: evidenceRefs,
    tool_bridge_state: bridge.state,
    brain_first_ordering,
    stop_reason: stopReason,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    total_cost_usd: totalCost,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract page slugs from the final answer text. Matches markdown-style
 * `[Name](dir/slug)` references and bare `dir/slug` identifiers.
 */
export function extractSlugs(text: string): string[] {
  const slugs = new Set<string>();
  // Markdown links: [text](dir/slug)
  const mdRe = /\[[^\]]+\]\(([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(text)) !== null) slugs.add(m[1]);
  // Bare backtick slugs: `dir/slug`
  const bareRe = /`([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)`/gi;
  while ((m = bareRe.exec(text)) !== null) slugs.add(m[1]);
  return Array.from(slugs);
}

/**
 * Cat 8 metric input: did the agent call search/get_page BEFORE producing
 * its final answer? This measures brain-first compliance — an agent that
 * answers from general knowledge without consulting the brain should fail.
 *
 * The final_answer turn is always the last turn. We look at the preceding
 * tool-calls for any of the read ops that go through the brain (search,
 * query, get_page, list_pages, get_backlinks, get_links, get_timeline,
 * get_tags, traverse_graph, resolve_slugs, get_chunks, get_stats).
 */
function computeBrainFirstOrdering(
  state: ToolBridgeState,
  finalAnswerProduced: boolean,
): 'brain_before_answer' | 'answer_before_brain' | 'no_brain_calls' {
  const BRAIN_READ_TOOLS = new Set([
    'search', 'query', 'get_page', 'list_pages', 'get_backlinks',
    'get_links', 'get_timeline', 'get_tags', 'traverse_graph',
    'resolve_slugs', 'get_chunks', 'get_stats',
  ]);
  const brainCalls = state.call_order.filter(name => BRAIN_READ_TOOLS.has(name));
  if (brainCalls.length === 0) return 'no_brain_calls';
  // If the agent produced an answer, it happened AFTER the tool calls in
  // the trace (we only break out of the loop on end_turn + no tool_uses).
  // So brain_calls > 0 + finalAnswerProduced = brain_before_answer.
  if (finalAnswerProduced) return 'brain_before_answer';
  return 'answer_before_brain';
}
