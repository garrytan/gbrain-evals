/**
 * Claude 5 request contract (audit B1, 2026-10-31). $0: every client is a recording stub.
 *
 * claude-opus-5-5 and claude-sonnet-5-5 reject `temperature` and a forced `tool_choice` with HTTP 400, and
 * claude-haiku-5-5 rejects `temperature`. Each call site below must send neither to a Claude 5-family model
 * (a forced tool becomes `tool_choice: auto` plus an instruction to call it), and must send the same bytes
 * as before to older models so earlier receipts stay comparable.
 */
import { describe, test, expect } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { acceptsForcedToolChoice, fitAnthropicRequest, temperatureSent, toolChoiceSent, withThinkingRoom } from '../../eval/runner/anthropic-request.ts';
import { SCORE_ANSWER_TOOL, judgePrice, scoreAnswer, type JudgeEvidence } from '../../eval/runner/judge.ts';
import { CAT5_CATEGORY, classifyClaim, runCat5, type Claim } from '../../eval/runner/cat5-provenance.ts';
import { isClaude5Family, openAIMessagesShim } from '../../eval/runner/openai-judge-shim.ts';
import { usageCost } from '../../eval/runner/budget-ledger.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeLiveComplete } from '../../eval/runner/cat25-trajectory-routing.ts';
import { judgePair, makeStubJudgeClient, type Cat29Question } from '../../eval/runner/cat29-think-vs-search.ts';
import { scoreGrounding } from '../../eval/runner/cat35-judges.ts';
import { ClaudeSonnetWithToolsAdapter, runAgentLoop, type AgentAdapterState } from '../../eval/runner/adapters/claude-sonnet-with-tools.ts';
import type { SyntheticPage } from '../../eval/runner/synthetic-corpus-loader.ts';

const CLAUDE_5 = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const OLDER = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
const TEXT_REPLY = { content: [{ type: 'text', text: 'no tool call' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' };

/** A client that records each request body as the SDK would serialize it, then answers with `reply`. */
function recording(reply: (params: any) => unknown = () => TEXT_REPLY) {
  const bodies: string[] = [];
  const client = { messages: { create: async (params: any) => { bodies.push(JSON.stringify(params)); return reply(params); } } };
  return { client: client as unknown as Anthropic, bodies, requests: () => bodies.map(b => JSON.parse(b) as Record<string, any>) };
}

/** No temperature, no forced tool choice; a request that forced `tool` ends with the instruction to call it. */
function expectClaude5Request(req: Record<string, any>, tool: string | null) {
  expect('temperature' in req).toBe(false);
  if (tool === null) {
    expect('tool_choice' in req).toBe(false);
    return;
  }
  expect(req.tool_choice).toEqual({ type: 'auto' });
  expect(req.messages.at(-1)).toEqual({ role: 'user', content: `Respond by calling the ${tool} tool.` });
}

function forcedRequest(model: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 800,
    temperature: 0,
    system: [{ type: 'text', text: 'Grade.', cache_control: { type: 'ephemeral' } }],
    tools: [SCORE_ANSWER_TOOL],
    tool_choice: { type: 'tool', name: 'score_answer' },
    messages: [{ role: 'user', content: 'Evidence.' }],
  };
}

describe('fitAnthropicRequest', () => {
  test('Claude 5 models get neither temperature nor a forced tool choice', () => {
    for (const model of [...CLAUDE_5, 'anthropic:claude-opus-5-5', 'claude-fable-5-1']) {
      const original = forcedRequest(model);
      const before = JSON.stringify(original);
      const fitted = fitAnthropicRequest(original);
      expectClaude5Request(JSON.parse(JSON.stringify(fitted)), 'score_answer');
      expect(fitted.messages.length).toBe(2);
      expect(JSON.stringify(original)).toBe(before);
    }
  });

  test('older models get the request byte for byte', () => {
    for (const model of OLDER) {
      const original = forcedRequest(model);
      expect(JSON.stringify(fitAnthropicRequest(original))).toBe(JSON.stringify(original));
    }
  });

  test('an OpenAI judge keeps the forced tool the shim turns into a JSON schema', () => {
    const fitted = fitAnthropicRequest(forcedRequest('openai:gpt-6.1-sol'));
    expect(fitted.tool_choice).toEqual({ type: 'tool', name: 'score_answer' });
    expect(fitted.messages.length).toBe(1);
  });

  test('receipt fields name what is sent', () => {
    expect(CLAUDE_5.map(m => [temperatureSent(m, 0), toolChoiceSent(m)])).toEqual(CLAUDE_5.map(() => [null, 'auto']));
    expect(OLDER.map(m => [temperatureSent(m, 0), toolChoiceSent(m)])).toEqual(OLDER.map(() => [0, 'tool']));
    expect([acceptsForcedToolChoice('anthropic:claude-sonnet-5-5'), acceptsForcedToolChoice('claude-haiku-4-5-20251001')]).toEqual([false, true]);
  });

  // Value: protects=one predicate decides the Claude 5 family for temperature, tool choice and output limit, Bedrock-style and later-generation ids included; fails_when=acceptsTemperature and the tool-choice rule disagree, or a Bedrock or claude-*-6 id is treated as an older model; why_new=two separate regexes matched only claude-<name>-5 after ^, : or /; seam=none; no_claim=ids only, no provider call
  test('Bedrock-style and later-generation Claude ids take the Claude 5 rule; older ids do not', () => {
    const newer = ['anthropic.claude-sonnet-5-5-v1:0', 'us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-6', 'anthropic:claude-haiku-6-1'];
    const older = ['claude-haiku-4-5-20251001', 'anthropic.claude-sonnet-4-6-v1:0', 'claude-3-5-sonnet-20241022'];
    const fields = (m: string) => [isClaude5Family(m), temperatureSent(m, 0), toolChoiceSent(m), withThinkingRoom(m, 700)];
    expect(newer.map(fields)).toEqual(newer.map(() => [true, null, 'auto', 4096]));
    expect(older.map(fields)).toEqual(older.map(() => [false, 0, 'tool', 700]));
  });

  test('a default output limit leaves Claude 5 room to think; other models keep theirs', () => {
    expect(CLAUDE_5.map(m => withThinkingRoom(m, 700))).toEqual([4096, 4096, 4096]);
    expect(withThinkingRoom('claude-opus-5-5', 8000)).toBe(8000);
    expect([...OLDER, 'openai:gpt-6.1-sol'].map(m => withThinkingRoom(m, 700))).toEqual([700, 700, 700]);
  });
});

const EVIDENCE: JudgeEvidence = {
  schema_version: 1,
  probe: { id: 'b1', text: 'What did Alice pay for the vet visit?', category: 9 },
  final_answer_text: 'Alice paid 85 dollars.',
  evidence_refs: ['people/alice'],
  tool_call_summary: { count_by_tool: {}, saw_poison_items: [], made_dry_run_writes: [] },
  ground_truth_pages: [{ slug: 'people/alice', title: 'Alice', content: 'The vet visit cost 85 dollars.' }],
  rubric: [{ id: 'correct', criterion: 'States the 85 dollar cost', weight: 1 }],
};
const SCORE_REPLY = {
  content: [{ type: 'tool_use', id: 't', name: 'score_answer', input: { scores: [{ criterion_id: 'correct', score: 5, rationale: 'ok' }], verdict: 'pass', overall_rationale: 'ok' } }],
  usage: { input_tokens: 1000, output_tokens: 100 },
  stop_reason: 'tool_use',
};

describe('judge.ts scoreAnswer', () => {
  test('claude-opus-5-5: no temperature, tool_choice auto, priced at Opus 5.5 rates, recorded in the result', async () => {
    const r = recording(() => SCORE_REPLY);
    const result = await scoreAnswer(EVIDENCE, { client: r.client, model: 'claude-opus-5-5' });
    expect(r.bodies.length).toBe(1);
    expectClaude5Request(r.requests()[0]!, 'score_answer');
    expect(r.requests()[0]!.max_tokens).toBe(4096);
    expect(result.verdict).toBe('pass');
    expect([result.temperature_sent, result.tool_choice_sent]).toEqual([null, 'auto']);
    expect(result.cost_usd).toBeCloseTo((1000 * 4 + 100 * 20) / 1e6, 12);
  });

  test('an explicit Haiku 4.5 judge gets the pre-B1 request and price', async () => {
    const r = recording(() => SCORE_REPLY);
    const result = await scoreAnswer(EVIDENCE, { client: r.client, model: 'claude-haiku-4-5-20251001' });
    const sent = r.requests()[0]!;
    const preB1 = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      temperature: 0,
      system: sent.system,
      tools: [SCORE_ANSWER_TOOL],
      tool_choice: { type: 'tool', name: 'score_answer' },
      messages: sent.messages,
    };
    expect(r.bodies[0]).toBe(JSON.stringify(preB1));
    expect(sent.messages.length).toBe(1);
    expect([result.temperature_sent, result.tool_choice_sent]).toEqual([0, 'tool']);
    expect(result.cost_usd).toBeCloseTo((1000 * 1 + 100 * 5) / 1e6, 12);
  });

  // Value: protects=scoreAnswer cost prices cache reads and writes at their own rates, not the input rate; fails_when=the cache terms are dropped from the judge cost or priced as plain input; why_new=the judge cost tests send usage with no cache fields; seam=none; no_claim=keyless stub usage, not a live provider bill (unit only)
  test('judge cost counts cache reads and writes at their own rates', async () => {
    const cached = { ...SCORE_REPLY, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 } };
    const r = recording(() => cached);
    const result = await scoreAnswer(EVIDENCE, { client: r.client, model: 'claude-opus-5-5' });
    expect(result.cost_usd).toBeCloseTo((1000 * 4 + 2000 * 0.2 + 500 * 5 + 100 * 20) / 1e6, 12);
  });

  // Value: protects=a cached OpenAI judge response through the shim costs what the ledger settles for the same upstream response; fails_when=the shim drops input_tokens_details, so cached input is priced at the uncached rate; why_new=the judge pricing tests used Anthropic usage only; seam=none; no_claim=stub fetch, no OpenAI request
  test('a cached OpenAI judge response through the shim costs what the ledger settles', async () => {
    const upstream = {
      id: 'resp_1', model: 'gpt-6.1-sol', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(SCORE_REPLY.content[0]!.input) }] }],
      usage: { input_tokens: 10_000, input_tokens_details: { cached_tokens: 9_000 }, output_tokens: 100 },
    };
    const fetchImpl = (async () => new Response(JSON.stringify(upstream), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const client = openAIMessagesShim({ apiKey: 'test-key-not-real', fetchImpl }) as unknown as Anthropic;
    const result = await scoreAnswer(EVIDENCE, { client, model: 'openai:gpt-6.1-sol' });
    expect(result.cost_usd).toBeCloseTo(usageCost(judgePrice('openai:gpt-6.1-sol'), upstream)!.usd, 12);
    expect(result.cost_usd).toBeCloseTo((1_000 * 2 + 9_000 * 0.1 + 100 * 10) / 1e6, 12);
  });

  test('the corrective retry to a Claude 5 judge also asks for the tool; an explicit limit is sent as given', async () => {
    const r = recording();
    const result = await scoreAnswer(EVIDENCE, { client: r.client, model: 'claude-sonnet-5-5', maxTokens: 900 });
    expect(result.verdict).toBe('judge_failed');
    expect(r.bodies.length).toBe(2);
    for (const req of r.requests()) {
      expectClaude5Request(req, 'score_answer');
      expect(req.max_tokens).toBe(900);
    }
  });

  test('an unpriced model is refused before any request', async () => {
    const r = recording(() => SCORE_REPLY);
    await expect(scoreAnswer(EVIDENCE, { client: r.client, model: 'claude-unlisted-9' })).rejects.toThrow('no chat price for anthropic:claude-unlisted-9');
    expect(r.bodies.length).toBe(0);
    expect(judgePrice('openai:gpt-6.1-sol').provider).toBe('openai');
  });
});

const CLAIM: Claim = { id: 'c1', source_page: 'people/alice', claim_text: 'The vet visit cost 85 dollars.', expected_label: 'supported', expected_evidence: ['people/alice'] };

describe('the other call sites', () => {
  test('cat5 classifyClaim', async () => {
    for (const model of CLAUDE_5) {
      const r = recording();
      await classifyClaim(CLAIM, EVIDENCE.ground_truth_pages, { client: r.client, model });
      for (const req of r.requests()) {
        expectClaude5Request(req, 'classify_claim');
        expect(req.max_tokens).toBe(4096);
      }
    }
    const old = recording();
    await classifyClaim(CLAIM, EVIDENCE.ground_truth_pages, { client: old.client, model: 'claude-haiku-4-5-20251001' });
    expect(old.requests().map(q => [q.max_tokens, q.temperature, q.tool_choice])).toEqual([[400, 0, { type: 'tool', name: 'classify_claim' }], [400, 0, { type: 'tool', name: 'classify_claim' }]]);
  });

  test('cat5 prices each classifier model at its own rate', async () => {
    const opus = await classifyClaim(CLAIM, EVIDENCE.ground_truth_pages, { client: recording().client, model: 'claude-opus-5-5' });
    expect(opus.cost_usd).toBeCloseTo(2 * (10 * 4 + 5 * 20) / 1e6, 12);
    const haiku = await classifyClaim(CLAIM, EVIDENCE.ground_truth_pages, { client: recording().client, model: 'claude-haiku-4-5-20251001' });
    expect(haiku.cost_usd).toBeCloseTo(2 * (10 * 1 + 5 * 5) / 1e6, 12);
    const unpriced = recording();
    await expect(classifyClaim(CLAIM, EVIDENCE.ground_truth_pages, { client: unpriced.client, model: 'claude-unlisted-1' })).rejects.toThrow('no chat price');
    expect(unpriced.bodies.length).toBe(0);
  });

  // Value: protects=a Cat 5 run with an unpriced model fails once as a config error before any claim, and receipt tokens include cache reads and writes like the cost does; fails_when=the price lookup moves back inside the per-claim try/catch or cache tokens drop out of input_tokens; why_new=an unpriced model became one dependency error per claim; seam=none; no_claim=stub client
  test('cat5 refuses an unpriced model once and counts cache tokens with the cost', async () => {
    const pagesBySlug = new Map(EVIDENCE.ground_truth_pages.map(p => [p.slug, p]));
    const unpriced = recording();
    await expect(runCat5({ claims: [CLAIM, { ...CLAIM, id: 'c2' }], pagesBySlug, client: unpriced.client, model: 'claude-unlisted-1' })).rejects.toThrow('no chat price');
    expect(unpriced.bodies.length).toBe(0);
    const cached = recording(() => ({ ...TEXT_REPLY, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } }));
    const score = await classifyClaim(CLAIM, EVIDENCE.ground_truth_pages, { client: cached.client, model: 'claude-haiku-4-5-20251001' });
    expect(score.input_tokens).toBe(2 * 350);
    expect(score.cost_usd).toBeCloseTo(2 * (10 * 1 + 300 * 0.1 + 40 * 1.25 + 5 * 5) / 1e6, 12);
  });

  // Value: protects=a Cat 5 receipt's judge.temperature is what was sent, null for a Claude 5 classifier; fails_when=the receipt writes the configured 0 beside temperature_sent null; why_new=judge.temperature was a constant 0; seam=none; no_claim=stub client
  test('cat5 receipt judge temperature is what was sent', async () => {
    const pagesBySlug = new Map(EVIDENCE.ground_truth_pages.map(p => [p.slug, p]));
    const reportsRoot = mkdtempSync(join(tmpdir(), 'cat5-receipt-'));
    await runCat5({ claims: [CLAIM], pagesBySlug, client: recording().client, model: 'claude-haiku-5-5', reportsRoot });
    expect(loadReceipt(receiptPath(CAT5_CATEGORY, reportsRoot)).judge).toEqual({ model: 'claude-haiku-5-5', temperature: null });
  });

  test('cat25 think completion', async () => {
    const r = recording();
    const complete = makeLiveComplete(r.client);
    const params = (model: string): Anthropic.MessageCreateParamsNonStreaming => ({ model, max_tokens: 100, messages: [{ role: 'user', content: 'q' }] });
    await complete(params('anthropic:claude-opus-5-5'), { system: '', user: 'q' });
    await complete(params('claude-sonnet-4-6'), { system: '', user: 'q' });
    const [claude5, older] = r.requests();
    expectClaude5Request(claude5!, null);
    expect(older!.temperature).toBe(0);
  });

  test('cat29 pairwise judge', async () => {
    const pages: SyntheticPage[] = [{ slug: 'companies/acme', type: 'company', body: '---\ntype: company\ntitle: Acme\n---\n\n# Acme\n\nARR is $120K.' }];
    const q: Cat29Question = { id: 'b1-acme', text: 'What is the ARR of Acme?', expected_facts: ['ARR is $120K'], gold_slugs: ['companies/acme'] };
    const stub = makeStubJudgeClient();
    for (const [model, check] of [
      ['claude-opus-5-5', (req: Record<string, any>) => expectClaude5Request(req, 'score_pair')],
      ['claude-haiku-4-5-20251001', (req: Record<string, any>) => expect([req.temperature, req.tool_choice]).toEqual([0, { type: 'tool', name: 'score_pair' }])],
    ] as const) {
      const r = recording(params => stub.messages.create(params));
      await judgePair(q, { a: 'ARR is $120K', b: 'unknown' }, pages, { client: r.client, model });
      expect(r.bodies.length).toBe(2);
      for (const req of r.requests()) check(req);
    }
  });

  test('cat35 batched judge', async () => {
    for (const model of CLAUDE_5) {
      const r = recording();
      await scoreGrounding({ label: 'x', claims: ['a claim'], transcript: 't' }, { client: r.client, model });
      expect(r.bodies.length).toBe(2);
      for (const req of r.requests()) expectClaude5Request(req, 'grade_claims');
    }
  });

  // Value: protects=Cat 35 judge cost uses each model's ledger price, and an unpriced judge is refused before any request; fails_when=the substring price table comes back (Opus 5.5 at Sonnet rates, Haiku 5.5 at Haiku 4.5 rates); why_new=the batched-judge test checks requests only; seam=none; no_claim=stub client
  test('cat35 judges price each model at its own rate', async () => {
    const cost = async (model?: string) => (await scoreGrounding({ label: 'x', claims: ['a claim'], transcript: 't' }, { client: recording().client, model })).cost_usd;
    expect(await cost('claude-opus-5-5')).toBeCloseTo(2 * (10 * 4 + 5 * 20) / 1e6, 12);
    expect(await cost('claude-haiku-5-5')).toBeCloseTo(2 * (10 * 0.1 + 5 * 0.5) / 1e6, 12);
    expect(await cost('claude-haiku-4-5-20251001')).toBeCloseTo(2 * (10 * 1 + 5 * 5) / 1e6, 12);
    const unpriced = recording();
    await expect(scoreGrounding({ label: 'x', claims: ['a claim'], transcript: 't' }, { client: unpriced.client, model: 'claude-unlisted-1' })).rejects.toThrow('no chat price');
    expect(unpriced.bodies.length).toBe(0);
  });

  test('Cat 8/9 agent loop', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init([{ slug: 'people/alice', type: 'person', title: 'Alice', compiled_truth: 'Alice has a cat.', timeline: '' }], { name: 'b1' })) as AgentAdapterState;
    try {
      const r = recording();
      await runAgentLoop('b1', 'Who is Alice?', state, { client: r.client, model: 'claude-opus-5-5', maxRetries: 1 });
      await runAgentLoop('b1', 'Who is Alice?', state, { client: r.client, model: 'claude-sonnet-4-6', maxRetries: 1 });
      const [claude5, older] = r.requests();
      expectClaude5Request(claude5!, null);
      expect([claude5!.max_tokens, older!.max_tokens]).toEqual([4096, 1024]);
      expect([older!.model, older!.temperature]).toEqual(['claude-sonnet-4-6', 0]);
    } finally {
      await adapter.teardown?.(state);
    }
  });

  // Value: protects=the Cat 8/9 agent loop prices each model at its ledger rate instead of Sonnet 4.6's; fails_when=the fixed Sonnet 4.6 price comes back; why_new=the agent-loop test checks requests only; seam=none; no_claim=stub client, one end_turn reply per run
  test('the Cat 8/9 agent loop prices each model at its own rate', async () => {
    const adapter = new ClaudeSonnetWithToolsAdapter();
    const state = (await adapter.init([{ slug: 'people/alice', type: 'person', title: 'Alice', compiled_truth: 'Alice has a cat.', timeline: '' }], { name: 'b1' })) as AgentAdapterState;
    try {
      const opus = await runAgentLoop('b1', 'Who is Alice?', state, { client: recording().client, model: 'claude-opus-5-5', maxRetries: 1 });
      const sonnet = await runAgentLoop('b1', 'Who is Alice?', state, { client: recording().client, model: 'claude-sonnet-4-6', maxRetries: 1 });
      expect(opus.total_cost_usd).toBeCloseTo((10 * 4 + 5 * 20) / 1e6, 12);
      expect(sonnet.total_cost_usd).toBeCloseTo((10 * 3 + 5 * 15) / 1e6, 12);
    } finally {
      await adapter.teardown?.(state);
    }
  }, 30_000);
});
