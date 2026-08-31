/**
 * claude-sonnet-with-tools adapter + runAgentLoop tests — Day 5.
 *
 * Uses a stubbed Anthropic client (no real LLM calls) + an in-process
 * PGLite engine (fast, no network). Covers:
 *   - Adapter.query() throws (by design)
 *   - Adapter.init() seeds PGLite with rawPages + pins search config (WS5)
 *   - runAgentLoop: tool_use → tool_result → end_turn happy path
 *   - runAgentLoop: turn cap reached without end_turn
 *   - runAgentLoop: ForbiddenOpError (agent tried a mutating op) → tool_result is_error
 *   - runAgentLoop: gbrain OperationError → is_error tool_result the agent
 *     self-corrects from (regression for audit agentic-cats-01: previously
 *     rethrown, killing the whole Cat 8/9 run)
 *   - rate-limit exhaustion → stop_reason 'rate_limit_exhausted', no throw
 *     (regression for audit adapters-queries-01 / agentic-cats-07)
 *   - brain_first_ordering classification incl. 'no_answer' + real
 *     answer-before-brain detection (regression for adapters-queries-02 /
 *     agentic-cats-06)
 *   - extractSlugs regex
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import {
  ClaudeSonnetWithToolsAdapter,
  runAgentLoop,
  extractSlugs,
  classifyAgentError,
  setTeardownDisconnectBoundMs,
  type AgentAdapterState,
} from '../../eval/runner/adapters/claude-sonnet-with-tools.ts';
import type { Page } from '../../eval/runner/types.ts';

// ─── Stub Anthropic client ────────────────────────────────────────────

type StubContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

type StubResponse = {
  content: StubContent[];
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
};

function stubClient(responses: StubResponse[]): Anthropic {
  let i = 0;
  return {
    messages: {
      create: async () => {
        if (i >= responses.length) {
          throw new Error(`Stub: out of responses (consumed ${i})`);
        }
        return responses[i++] as Anthropic.Messages.Message;
      },
    },
  } as unknown as Anthropic;
}

function textResp(text: string): StubResponse {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 50 },
    stop_reason: 'end_turn',
  };
}

function toolResp(toolName: string, input: unknown, id: string = 'tool-1'): StubResponse {
  return {
    content: [{ type: 'tool_use', id, name: toolName, input }],
    usage: { input_tokens: 100, output_tokens: 30 },
    stop_reason: 'tool_use',
  };
}

// ─── Test fixtures ────────────────────────────────────────────────────

const SAMPLE_PAGES: Page[] = [
  {
    slug: 'people/amara',
    type: 'person',
    title: 'Amara Okafor',
    compiled_truth: 'Amara is a Partner at [Halfway](companies/halfway). Focus: climate + AI infra.',
    timeline: '',
  },
  {
    slug: 'companies/halfway',
    type: 'company',
    title: 'Halfway Capital',
    compiled_truth: 'Halfway Capital is a fictional VC firm.',
    timeline: '',
  },
];

// ─── Adapter interface conformance ────────────────────────────────────

describe('ClaudeSonnetWithToolsAdapter — Adapter interface', () => {
  test('has the canonical name', () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    expect(adapter.name).toBe('claude-sonnet-with-tools');
  });

  test('init() seeds PGLite engine with rawPages', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;
    expect(state.engine).toBeDefined();
    const page = await state.engine.getPage('people/amara');
    expect(page?.title).toBe('Amara Okafor');
    // teardown skipped: at the pinned gbrain (v0.46.3) PGLiteEngine.disconnect()
    // after ops-layer use enters a sync WASM spin that freezes the bun test
    // runner (even un-awaited). Per-test engines die with the process. See
    // TODOS.md (gbrain upstream) — restore teardown when the pin moves past it.
  });

  test('init() pins search mode + reranker BEFORE ingest and records them (WS5)', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;
    // Never rely on gbrain defaults: 'balanced' silently enables the
    // zerank-2 reranker when ZEROENTROPY_API_KEY is set.
    expect(state.resolved_search_config).toEqual({
      'search.mode': 'balanced',
      'search.reranker.enabled': 'false',
    });
    await adapter.teardown?.(state);
  });

  test('query() throws — agent adapter does not participate in retrieval scorecard', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = await adapter.init(SAMPLE_PAGES, { name: 'test' });
    let err: unknown = null;
    try {
      await adapter.query(
        { id: 'q', tier: 'easy', text: 'x', expected_output_type: 'answer-string', gold: {} },
        state,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('intentionally unsupported');
    // teardown skipped: at the pinned gbrain (v0.46.3) PGLiteEngine.disconnect()
    // after ops-layer use enters a sync WASM spin that freezes the bun test
    // runner (even un-awaited). Per-test engines die with the process. See
    // TODOS.md (gbrain upstream) — restore teardown when the pin moves past it.
  });
});

// ─── runAgentLoop ─────────────────────────────────────────────────────

describe('runAgentLoop — happy path', () => {
  test('tool_use → tool_result → end_turn records full transcript', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;

    const client = stubClient([
      // Turn 1: agent calls get_page to look up Amara
      toolResp('get_page', { slug: 'people/amara' }, 'tool-1'),
      // Turn 2: agent produces final answer
      {
        content: [
          {
            type: 'text',
            text: 'Amara Okafor is a Partner at [Halfway Capital](companies/halfway). Source: people/amara.',
          },
        ],
        usage: { input_tokens: 200, output_tokens: 40 },
        stop_reason: 'end_turn',
      },
    ]);

    const result = await runAgentLoop('q-0001', 'Who is Amara?', state, {
      client,
      maxRetries: 1, // no real retries in test
    });

    expect(result.stop_reason).toBe('end_turn');
    expect(result.final_answer).toContain('Amara Okafor');
    expect(result.evidence_refs).toContain('companies/halfway');
    expect(result.brain_first_ordering).toBe('brain_before_answer');
    // Turns: model_call, tool_call, tool_result, model_call, final_answer
    expect(result.transcript.turns.length).toBe(5);
    expect(result.transcript.turns[0].kind).toBe('model_call');
    expect(result.transcript.turns[1].kind).toBe('tool_call');
    expect(result.transcript.turns[2].kind).toBe('tool_result');
    expect(result.transcript.turns[3].kind).toBe('model_call');
    expect(result.transcript.turns[4].kind).toBe('final_answer');

    // Token + cost accumulation
    expect(result.total_input_tokens).toBe(300);
    expect(result.total_output_tokens).toBe(70);
    expect(result.total_cost_usd).toBeGreaterThan(0);

    // teardown skipped: at the pinned gbrain (v0.46.3) PGLiteEngine.disconnect()
    // after ops-layer use enters a sync WASM spin that freezes the bun test
    // runner (even un-awaited). Per-test engines die with the process. See
    // TODOS.md (gbrain upstream) — restore teardown when the pin moves past it.
  });

  test('immediate end_turn (no tool calls) → no_brain_calls ordering', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;

    const client = stubClient([
      textResp('I do not know who Amara is without checking the brain.'),
    ]);

    const result = await runAgentLoop('q-0002', 'Who is Amara?', state, {
      client,
      maxRetries: 1,
    });

    expect(result.stop_reason).toBe('end_turn');
    expect(result.brain_first_ordering).toBe('no_brain_calls');
    expect(result.evidence_refs).toEqual([]);
    // teardown skipped: at the pinned gbrain (v0.46.3) PGLiteEngine.disconnect()
    // after ops-layer use enters a sync WASM spin that freezes the bun test
    // runner (even un-awaited). Per-test engines die with the process. See
    // TODOS.md (gbrain upstream) — restore teardown when the pin moves past it.
  });
});

describe('runAgentLoop — turn cap + error paths', () => {
  test('hits turn cap and records empty final_answer', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;

    // Client keeps returning tool calls forever — use a generator that repeats
    const manyTools: StubResponse[] = [];
    for (let i = 0; i < 10; i++) {
      manyTools.push(toolResp('get_page', { slug: 'people/amara' }, `tool-${i}`));
    }
    const client = stubClient(manyTools);

    const result = await runAgentLoop('q-0003', 'loop me forever', state, {
      client,
      turnCap: 3,
      maxRetries: 1,
    });

    expect(result.stop_reason).toBe('turn_cap_exceeded');
    expect(result.final_answer).toBe('');
    // Last turn is the synthesized final_answer with empty text
    const lastTurn = result.transcript.turns[result.transcript.turns.length - 1];
    expect(lastTurn.kind).toBe('final_answer');
    expect(lastTurn.final_answer?.text).toBe('');

    // teardown skipped: at the pinned gbrain (v0.46.3) PGLiteEngine.disconnect()
    // after ops-layer use enters a sync WASM spin that freezes the bun test
    // runner (even un-awaited). Per-test engines die with the process. See
    // TODOS.md (gbrain upstream) — restore teardown when the pin moves past it.
  });

  test('agent attempts a mutating op → tool_result records is_error', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;

    const client = stubClient([
      toolResp('put_page', { slug: 'x/y', type: 'person', title: 't', compiled_truth: '' }, 'tool-mut'),
      textResp('Sorry, I cannot do that.'),
    ]);

    const result = await runAgentLoop('q-0004', 'make a page', state, {
      client,
      maxRetries: 1,
    });

    // Find the tool_result turn
    const toolResultTurn = result.transcript.turns.find(t => t.kind === 'tool_result');
    expect(toolResultTurn).toBeDefined();
    const content = toolResultTurn!.tool_result!.content;
    expect(content).toContain('forbidden_op');
    // Loop continues; final answer eventually happens
    expect(result.stop_reason).toBe('end_turn');

    // teardown skipped: at the pinned gbrain (v0.46.3) PGLiteEngine.disconnect()
    // after ops-layer use enters a sync WASM spin that freezes the bun test
    // runner (even un-awaited). Per-test engines die with the process. See
    // TODOS.md (gbrain upstream) — restore teardown when the pin moves past it.
  });
});

// ─── OperationError → is_error tool_result (agentic-cats-01) ─────────

describe('runAgentLoop — gbrain OperationError becomes a self-correctable tool_result', () => {
  test('get_page on a missing slug does NOT throw; agent sees the error envelope and recovers', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;

    const client = stubClient([
      // Turn 1: agent asks for a page that does not exist → gbrain throws
      // OperationError('page_not_found', ...) inside the handler.
      toolResp('get_page', { slug: 'people/does-not-exist' }, 'tool-miss'),
      // Turn 2: agent self-corrects with the right slug.
      toolResp('get_page', { slug: 'people/amara' }, 'tool-hit'),
      // Turn 3: final answer.
      textResp('Amara Okafor is a Partner. Source: `people/amara`.'),
    ]);

    const result = await runAgentLoop('q-op-err', 'Who is Amara?', state, {
      client,
      maxRetries: 1,
    });

    // The run completed instead of crashing the whole category.
    expect(result.stop_reason).toBe('end_turn');
    // The failed call produced a structured error envelope in the trace.
    const toolResults = result.transcript.turns.filter(t => t.kind === 'tool_result');
    expect(toolResults.length).toBe(2);
    expect(toolResults[0].tool_result!.content).toContain('page_not_found');
    // Ordering still counts the recovered brain read.
    expect(result.brain_first_ordering).toBe('brain_before_answer');

    await adapter.teardown?.(state);
  });
});

// ─── Rate-limit exhaustion (adapters-queries-01 / agentic-cats-07) ────

function rateLimitError(): Error & { status: number } {
  const err = new Error('rate limited') as Error & { status: number };
  err.status = 429;
  return err;
}

describe('runAgentLoop — rate-limit exhaustion ends gracefully', () => {
  test('sustained 429s produce stop_reason rate_limit_exhausted instead of throwing', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;

    const client = {
      messages: {
        create: async () => {
          throw rateLimitError();
        },
      },
    } as unknown as Anthropic;

    // maxRetries=1 → the single (final) attempt fails rate-limited with no
    // backoff sleep, so this test is fast AND exercises the exhaustion path.
    const result = await runAgentLoop('q-429', 'Who is Amara?', state, {
      client,
      maxRetries: 1,
    });

    expect(result.stop_reason).toBe('rate_limit_exhausted');
    expect(result.final_answer).toBe('');
    expect(result.brain_first_ordering).toBe('no_brain_calls');

    await adapter.teardown?.(state);
  });

  test('non-rate-limit API errors still throw (typed dependency/harness by callers)', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;

    const client = {
      messages: {
        create: async () => {
          throw new Error('boom: not a rate limit');
        },
      },
    } as unknown as Anthropic;

    let err: unknown = null;
    try {
      await runAgentLoop('q-boom', 'Who is Amara?', state, { client, maxRetries: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('boom');

    await adapter.teardown?.(state);
  });

  test('classifyAgentError types API-shaped errors dependency, everything else harness', () => {
    expect(classifyAgentError(rateLimitError())).toBe('dependency');
    expect(classifyAgentError(Object.assign(new Error('overloaded'), { status: 529 }))).toBe('dependency');
    expect(classifyAgentError(new Error('tool-bridge internal: contract break'))).toBe('harness');
    expect(classifyAgentError(new Error('anything else'))).toBe('harness');
  });
});

// ─── brain_first_ordering labels (adapters-queries-02 / agentic-cats-06) ──

describe('runAgentLoop — brain_first_ordering', () => {
  test("turn-cap run with brain calls but no answer is 'no_answer', NOT 'answer_before_brain'", async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;

    const manyTools: StubResponse[] = [];
    for (let i = 0; i < 3; i++) {
      manyTools.push(toolResp('get_page', { slug: 'people/amara' }, `tool-${i}`));
    }
    const client = stubClient(manyTools);

    const result = await runAgentLoop('q-no-answer', 'loop forever', state, {
      client,
      turnCap: 3,
      maxRetries: 1,
    });

    expect(result.stop_reason).toBe('turn_cap_exceeded');
    expect(result.brain_first_ordering).toBe('no_answer');

    await adapter.teardown?.(state);
  });

  test('substantive answer text emitted BEFORE the first brain read is answer_before_brain', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;

    const preWrittenAnswer =
      'Amara Okafor is a Partner at Halfway Capital focused on climate and AI infrastructure ' +
      'investments at the seed and Series A stages. Let me verify that in the brain.';
    const client = stubClient([
      // Turn 1: full answer as text ALONGSIDE a throwaway brain call.
      {
        content: [
          { type: 'text', text: preWrittenAnswer },
          { type: 'tool_use', id: 'tool-1', name: 'get_page', input: { slug: 'people/amara' } },
        ],
        usage: { input_tokens: 100, output_tokens: 80 },
        stop_reason: 'tool_use',
      },
      // Turn 2: final answer.
      textResp('Confirmed: Amara is a Partner. Source: `people/amara`.'),
    ]);

    const result = await runAgentLoop('q-cheat', 'Who is Amara?', state, {
      client,
      maxRetries: 1,
    });

    expect(result.stop_reason).toBe('end_turn');
    // Previously classified 'brain_before_answer' — the pre-written answer
    // was invisible because only the final no-tool turn's text was inspected.
    expect(result.brain_first_ordering).toBe('answer_before_brain');

    await adapter.teardown?.(state);
  });

  test('short interjection text alongside the first brain call stays brain_before_answer', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init(SAMPLE_PAGES, { name: 'test' })) as AgentAdapterState;

    const client = stubClient([
      {
        content: [
          { type: 'text', text: 'Let me check the brain.' },
          { type: 'tool_use', id: 'tool-1', name: 'get_page', input: { slug: 'people/amara' } },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
        stop_reason: 'tool_use',
      },
      textResp('Amara is a Partner at Halfway. Source: `people/amara`.'),
    ]);

    const result = await runAgentLoop('q-honest', 'Who is Amara?', state, {
      client,
      maxRetries: 1,
    });

    expect(result.brain_first_ordering).toBe('brain_before_answer');

    await adapter.teardown?.(state);
  });
});

// ─── extractSlugs ─────────────────────────────────────────────────────

describe('extractSlugs', () => {
  test('extracts markdown-style [text](slug) links', () => {
    const slugs = extractSlugs('See [Amara](people/amara) at [Halfway](companies/halfway).');
    expect(slugs).toEqual(['people/amara', 'companies/halfway']);
  });

  test('extracts backtick-wrapped slugs', () => {
    const slugs = extractSlugs('Refer to `people/amara` and `emails/em-0001`.');
    expect(slugs).toEqual(['people/amara', 'emails/em-0001']);
  });

  test('deduplicates across both syntaxes', () => {
    const slugs = extractSlugs('See [X](people/amara) and `people/amara`.');
    expect(slugs).toEqual(['people/amara']);
  });

  test('does not extract bare text that looks like slugs', () => {
    const slugs = extractSlugs('I talked to people/amara in passing.');
    // Bare slug (no brackets or backticks) is NOT extracted
    expect(slugs).not.toContain('people/amara');
  });

  test('handles the one-slash slug rule — does not match multi-slash paths', () => {
    const slugs = extractSlugs('Path: [thing](path/to/thing).');
    // "path/to/thing" has two slashes, doesn't match the single-slash regex
    expect(slugs).toEqual([]);
  });
});

// ─── teardown — bounded disconnect ────────────────────────────────────
//
// The real-PGLite teardown path can't run here (see the "teardown skipped"
// notes above), so these tests pin the bounded-race semantics with a
// CONSTRUCTED stub engine object (the tool-bridge.test.ts fake-engine
// convention — never a monkeypatched real engine). This is the behavior the
// 2026-08 diff changed: a wedged disconnect() must not hang eval teardown.

describe('ClaudeSonnetWithToolsAdapter — teardown bounded disconnect', () => {
  const adapter = new ClaudeSonnetWithToolsAdapter();
  const stateWith = (engine: unknown) =>
    ({ engine, poisonFixtures: [] }) as unknown as AgentAdapterState;

  // Inject a small bound so the never-resolving case doesn't cost a real 5s
  // per suite run (and so assertions aren't load-sensitive wall-clock windows).
  beforeAll(() => setTeardownDisconnectBoundMs(50));
  afterAll(() => setTeardownDisconnectBoundMs(5000));

  test('resolving disconnect() completes teardown promptly and is awaited', async () => {
    let calls = 0;
    await adapter.teardown(stateWith({ disconnect: async () => { calls++; } }));
    expect(calls).toBe(1);
  });

  test('rejecting disconnect() is swallowed — teardown resolves, never throws', async () => {
    let threw = false;
    try {
      await adapter.teardown(
        stateWith({ disconnect: () => Promise.reject(new Error('op context handle survives')) }),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test('never-resolving disconnect() is bounded — cannot hang the suite', async () => {
    // With the 50ms injected bound this completes near-instantly; the only
    // assertion that matters is that it completes at all.
    await adapter.teardown(stateWith({ disconnect: () => new Promise(() => {}) }));
  }, 5_000);

  test('synchronously-throwing disconnect() is swallowed', async () => {
    let threw = false;
    try {
      await adapter.teardown(
        stateWith({
          disconnect: () => {
            throw new Error('sync wedge');
          },
        }),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test('non-promise-returning disconnect() does not reject teardown', async () => {
    let threw = false;
    try {
      await adapter.teardown(stateWith({ disconnect: () => undefined }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
