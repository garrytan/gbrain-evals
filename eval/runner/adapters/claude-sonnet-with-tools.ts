/**
 * Agent adapter — Claude Sonnet driving gbrain tools.
 *
 * FEATURE BOUNDARY (what is under test vs what is seeded/stubbed):
 *   - UNDER TEST: the gbrain operations surface (12 read ops via
 *     `tool-bridge.ts`, dispatched to real gbrain handlers against a real
 *     PGLite engine) plus the agent's tool-use behavior around it.
 *   - SEEDED: the brain corpus (`rawPages` via `engine.putPage`) and the
 *     poison fixtures. The Sonnet driver model is the *subject* in live
 *     runs and a stub in hermetic tests — either way the loop mechanics
 *     (retry, error envelopes, ordering labels) are what this file owns.
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
 * retry with exponential backoff (up to `maxRetries` attempts per turn).
 * When the final attempt is still rate-limited the run ENDS GRACEFULLY with
 * stop_reason 'rate_limit_exhausted' — it never throws for rate limits, so
 * one throttled probe can no longer kill a whole Cat 8/9 run (audit findings
 * adapters-queries-01 / agentic-cats-07).
 *
 * Tool-error policy (audit finding agentic-cats-01): EVERY error thrown by
 * `executeTool` — including gbrain `OperationError`s like page_not_found or
 * invalid_params — is converted into an `is_error: true` tool_result the
 * agent can read and self-correct from. The ONLY rethrow is the
 * tool-bridge-internal contract-break Error (a programmer bug in the
 * harness, classified 'harness' by the callers' probe accounting).
 */

import Anthropic from '@anthropic-ai/sdk';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { OperationError } from 'gbrain/operations';
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
import type { FailureOrigin } from '../receipt.ts';

// ─── Types ────────────────────────────────────────────────────────────

export interface AgentAdapterState {
  engine: PGLiteEngine;
  poisonFixtures: PoisonFixture[];
  /**
   * WS5: the engine.setConfig entries pinned in init() BEFORE ingest
   * (search mode + reranker state). Cat 8/9 receipts record these so a run
   * can never silently depend on gbrain's default 'balanced' mode enabling
   * the zerank-2 reranker when ZEROENTROPY_API_KEY happens to be set.
   * Optional because tests may construct minimal states by hand.
   */
  resolved_search_config?: Record<string, string>;
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

/**
 * Cat 8 brain-first ordering label (audit findings adapters-queries-02 /
 * agentic-cats-06):
 *   - 'brain_before_answer'  — brain reads happened and the final answer came
 *                              after them, with no substantive answer text
 *                              emitted before the first brain read.
 *   - 'answer_before_brain'  — the agent emitted substantive answer text
 *                              BEFORE any brain read had executed (detected
 *                              from the transcript, not inferred from the
 *                              absence of a final answer).
 *   - 'no_brain_calls'       — the agent never read the brain.
 *   - 'no_answer'            — brain reads happened but the loop ended
 *                              (turn cap / rate limit) without any final
 *                              answer. Previously mislabeled
 *                              'answer_before_brain'.
 */
export type BrainFirstOrdering =
  | 'brain_before_answer'
  | 'answer_before_brain'
  | 'no_brain_calls'
  | 'no_answer';

export interface AgentRunResult {
  transcript: Transcript;
  /** Final answer text (empty string if turn cap exceeded with no final_answer). */
  final_answer: string;
  /** Slugs the agent cited in the final answer. */
  evidence_refs: string[];
  /** Structured summary from tool-bridge state. */
  tool_bridge_state: ToolBridgeState;
  /** Cat 8 metric — see BrainFirstOrdering. */
  brain_first_ordering: BrainFirstOrdering;
  /** Why the loop terminated. */
  stop_reason: 'end_turn' | 'turn_cap_exceeded' | 'agent_malformed' | 'rate_limit_exhausted';
  /** Accumulated tokens + cost for the whole run. */
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

// ─── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_AGENT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MODEL = DEFAULT_AGENT_MODEL;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TURN_CAP = 10;
const DEFAULT_MAX_RETRIES = 3;

/**
 * Minimum assistant-text length (chars) that counts as a "substantive answer"
 * for answer-before-brain detection. Matches Cat 8's citation-format gate:
 * short interjections ("Let me check the brain.") are not answers.
 */
export const SUBSTANTIVE_TEXT_MIN_CHARS = 80;

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

/**
 * Classify an error THROWN out of runAgentLoop for probe accounting.
 * After the tool-error-envelope fix, agent/SUT misbehavior never throws
 * (it becomes an is_error tool_result or a graceful stop_reason), so a
 * throw is always infra: Anthropic-API-shaped errors are 'dependency',
 * everything else (incl. the tool-bridge internal contract break) is
 * 'harness'. Shared by the Cat 8 and Cat 9 probe loops.
 */
export function classifyAgentError(err: unknown): Extract<FailureOrigin, 'dependency' | 'harness'> {
  if (isRateLimitError(err)) return 'dependency';
  if (err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number') {
    return 'dependency';
  }
  return 'harness';
}

/**
 * Serialize a tool-execution error into a tool_result content string the
 * agent can self-correct from. gbrain OperationError carries a structured
 * envelope (code / message / suggestion / docs) via toJSON — preserve it.
 */
function serializeToolError(err: unknown): string {
  if (err instanceof ForbiddenOpError || err instanceof UnknownToolError) {
    return JSON.stringify({ error: err.message, kind: err.kind });
  }
  const duck = err as { name?: unknown; toJSON?: unknown };
  if (
    err instanceof OperationError ||
    (duck && duck.name === 'OperationError' && typeof duck.toJSON === 'function')
  ) {
    return JSON.stringify((err as OperationError).toJSON());
  }
  if (err instanceof Error) {
    return JSON.stringify({ error: err.message, kind: 'tool_error' });
  }
  return JSON.stringify({ error: String(err), kind: 'tool_error' });
}

/** The tool-bridge internal contract-break Error is a harness programmer bug — the one rethrow. */
function isBridgeInternalError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('tool-bridge internal');
}

// ─── Adapter class ────────────────────────────────────────────────────

export class ClaudeSonnetWithToolsAdapter implements Adapter {
  readonly name = 'claude-sonnet-with-tools';

  async init(
    rawPages: Page[],
    config: AdapterConfig & { poisonFixtures?: PoisonFixture[]; searchConfig?: Record<string, string> },
  ): Promise<BrainState> {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    // WS5: pin search mode + reranker BEFORE ingest. gbrain's default
    // 'balanced' mode silently enables the zerank-2 reranker when
    // ZEROENTROPY_API_KEY is set — the agent's `search`/`query` tools would
    // then behave differently across machines. Never rely on defaults.
    // Keys verified against node_modules/gbrain/src/core/search/mode.ts.
    const searchConfig: Record<string, string> = {
      'search.mode': 'balanced',
      'search.reranker.enabled': 'false',
      ...(config.searchConfig ?? {}),
    };
    const resolvedSearchConfig: Record<string, string> = {};
    for (const [key, value] of Object.entries(searchConfig)) {
      await engine.setConfig(key, value);
      resolvedSearchConfig[key] = value;
    }
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
      resolved_search_config: resolvedSearchConfig,
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
  // True when the agent emitted substantive answer text BEFORE any brain
  // read had executed (real answer-before-brain, detected in trace order).
  let answeredBeforeBrain = false;

  for (let turn = 0; turn < turnCap; turn++) {
    // ── Sonnet call with retry on rate-limit ──
    // Rate-limit errors on the FINAL attempt fall through with response
    // still null so the run ends gracefully with stop_reason
    // 'rate_limit_exhausted' (the documented behavior — previously dead
    // code because the last attempt threw; audit adapters-queries-01).
    // Non-rate-limit errors still throw: callers classify them as infra
    // via classifyAgentError + probe accounting.
    let response: Anthropic.Messages.Message | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
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
        if (!isRateLimitError(err)) throw err;
        if (attempt < maxRetries - 1) {
          // Exponential backoff: 1s, 2s, 4s
          await sleep(1000 * Math.pow(2, attempt));
        }
      }
    }
    if (!response) {
      stopReason = 'rate_limit_exhausted';
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

    // Real answer-before-brain detection (audit adapters-queries-02 /
    // agentic-cats-06): substantive assistant text emitted while ZERO brain
    // reads have executed, in a turn that still issues tool calls, means the
    // agent wrote its answer before consulting the brain. Checked BEFORE this
    // turn's tools run so text alongside the first brain call still counts.
    const brainReadsSoFar = bridge.state.call_order.filter(n => BRAIN_READ_TOOLS.has(n)).length;
    if (
      toolUses.length > 0 &&
      brainReadsSoFar === 0 &&
      assistantText.trim().length >= SUBSTANTIVE_TEXT_MIN_CHARS
    ) {
      answeredBeforeBrain = true;
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
        // Audit agentic-cats-01: ALL tool-execution errors — gbrain
        // OperationError (page_not_found, invalid_params, permission_denied,
        // ...), ForbiddenOpError, UnknownToolError, plain handler Errors —
        // become is_error tool_results the agent can self-correct from.
        // Only the tool-bridge internal contract-break (harness programmer
        // bug) still rethrows; probe accounting types it 'harness'.
        if (isBridgeInternalError(err)) throw err;
        wasError = true;
        toolResult = {
          content: serializeToolError(err),
          truncated: false,
          matched_poison_fixture_ids: [],
        };
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

  const brain_first_ordering = computeBrainFirstOrdering(
    bridge.state,
    finalAnswerRecorded,
    answeredBeforeBrain,
  );

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

/** Read ops that go through the brain — shared by ordering + detection. */
const BRAIN_READ_TOOLS = new Set([
  'search', 'query', 'get_page', 'list_pages', 'get_backlinks',
  'get_links', 'get_timeline', 'get_tags', 'traverse_graph',
  'resolve_slugs', 'get_chunks', 'get_stats',
]);

/**
 * Cat 8 metric input: did the agent consult the brain BEFORE writing its
 * answer? Fixed per audit adapters-queries-02 / agentic-cats-06:
 *   - runs with NO final answer get their own honest label ('no_answer')
 *     instead of being mislabeled 'answer_before_brain';
 *   - real answer-before-brain is detected in the loop from trace order
 *     (substantive assistant text emitted before any brain read executed)
 *     and passed in as `answeredBeforeBrain`.
 */
function computeBrainFirstOrdering(
  state: ToolBridgeState,
  finalAnswerProduced: boolean,
  answeredBeforeBrain: boolean,
): BrainFirstOrdering {
  const brainCalls = state.call_order.filter(name => BRAIN_READ_TOOLS.has(name));
  if (brainCalls.length === 0) return 'no_brain_calls';
  if (answeredBeforeBrain) return 'answer_before_brain';
  if (!finalAnswerProduced) return 'no_answer';
  return 'brain_before_answer';
}
