/**
 * BrainBench Cat 29 — `gbrain think` synthesis vs raw `search` quality.
 *
 * The headline product question: "Search gives you raw pages. Think gives
 * you the answer." This Cat measures whether the synthesis layer produces
 * better answers than the raw retrieved payload on multi-page relational
 * questions over the synthetic-v1 corpus — judged BLIND.
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: gbrain's runThink pipeline (gather → synthesis → citations,
 * via the published 'gbrain/think' export) head-to-head against the raw
 * hybridSearch payload an agent would otherwise dump into context. Search
 * mode + reranker are pinned (WS5) and the think model is pinned via
 * `models.think` config — never left to tier defaults (audit cats26-29-12:
 * the old runner silently ran Opus while claiming Sonnet). gbrain's think
 * sets no temperature, so live runs call the model through runThink's
 * `client` seam at temperature 0 (audit B-29-03), recorded in
 * resolved_config.
 * LEGITIMATELY SEEDED/STUBBED: the synthetic-v1 corpus (committed fixture,
 * deterministic seed). Under --stub (hermetic, no keys): the embed HTTP
 * transport (deterministic hash vectors), the think LLM (runThink's
 * stubResponse test seam — gather still runs against the real engine), and
 * the judge client. Stub runs verify the full plumbing + gates and are
 * stamped publishable:false; they are never a think-quality claim.
 *
 * ── Judging policy (WS0, audit cats26-29-10/11/18) ───────────────────
 * - BLIND: the judge never learns which answer came from think vs search.
 *   Both answers go into ONE pairwise prompt under neutral labels (Answer 1,
 *   Answer 2) with zero system identity. The judge scores each answer on
 *   the rubric (judge.ts rubric-coverage and weighting rules, temperature
 *   0) and states a preference.
 * - BOTH ORDERS: every question is judged twice with the two answers in
 *   opposite positions (first order fixed by a seed derived from the
 *   question id, so no unseeded randomness); per-answer scores are averaged
 *   across orders, and a pair whose preference flips with the order is
 *   reported as position-inconsistent (audit B-29-01: the old runner
 *   scored each answer alone, so "both orders" was a duplicate call).
 * - EXPECTED FACTS: every question carries expected_facts extracted from
 *   the committed corpus (real ARR readings, attendee slugs, link counts),
 *   passed to the judge as ground truth + rubric criteria — a hallucinated
 *   value can no longer score 10 (audit cats26-29-18). Ground-truth facts
 *   are NOT verdict labels; no "X should win" prior ever reaches the judge.
 * - Judge API failure / judge_failed => probe-accounting origin 'judge':
 *   the question is EXCLUDED from means and capped — never scored 0
 *   (audit cats26-29-11).
 *
 * ── Verdict (real + failable) ────────────────────────────────────────
 * pass    — every question judged AND think mean >= search mean.
 * partial — think mean >= search mean but some questions excluded (judge
 *           errors within the accounting cap).
 * fail    — think mean < search mean, or nothing judged.
 * Exit code is non-zero unless verdict === 'pass'. Missing keys without
 * --stub → receipt run_status 'skipped' + non-zero exit unless --allow-skip.
 *
 * Cost: live run ≈ $0.40, an unmeasured estimate (5 pinned-Sonnet think
 * calls + 10 pairwise Haiku judge calls, up to 20 with malformed-output
 * retries) plus one-time OpenAI embeds for 165 pages.
 * Stub run: $0, no keys.
 *
 * Run:
 *   bun eval/runner/cat29-think-vs-search.ts --stub        # hermetic
 *   bun eval/runner/cat29-think-vs-search.ts               # live (needs ANTHROPIC + OPENAI keys)
 *   CAT29_QUESTIONS=2 bun eval/runner/cat29-think-vs-search.ts --stub
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContentEmbedded } from './import-embedded.ts';
import { configureGateway, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
import { runThink, type ThinkLLMClient, type ThinkResponse } from 'gbrain/think';
import { loadSyntheticV1, type SyntheticPage } from './synthetic-corpus-loader.ts';
import {
  JUDGE_TEMPERATURE,
  UNTRUSTED_DATA_INSTRUCTION,
  escapeUntrusted,
  extractUntrusted,
  fenceUntrusted,
  newJudgeNonce,
  parseCriterionScores,
  priceOf,
  weightedMean,
  type GroundTruthPage,
  type JudgeConfig,
  type RubricCriterion,
} from './judge.ts';
import { getDefaultLlmBudget } from './llm-budget.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { assertCat29JudgeInput, assertCat29SutQuestion, CAT29_JUDGE_PAIR, CAT29_SUT_QUESTION, type Cat29JudgeInput } from './evaluator/judge-inputs.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';
import { installStubEmbed } from './cat27-graph-signals.ts';
import { acceptsTemperature, anthropicModelId, judgeClientFor, judgeTransport } from './openai-judge-shim.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun, type BudgetOptions } from './budget-ledger.ts';
import { attestPreregistration, type Attestation } from './prereg.ts';

export const CAT29_CATEGORY = 'cat29-think-vs-search';

/** Pinned think model — recorded in resolved_config; ThinkResult.modelUsed is echoed back. */
export const THINK_MODEL = 'anthropic:claude-sonnet-4-6';
export const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
/** v3 (2026-09-28): pairwise prompt, nonce-fenced answers (audit B-29-01, B-JDG-01). */
export const RUBRIC_VERSION = 'cat29-v3';
export const THINK_TEMPERATURE = 0;

/**
 * WS5 pin — applied via engine.setConfig BEFORE ingest and echoed into
 * resolved_config. Both systems (think's gather and the raw search arm)
 * retrieve under the identical pinned mode; the default 'balanced' bundle
 * would silently enable reranking when an ambient provider key is
 * set.
 */
export const PINNED_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.autocut': 'false',
  'search.cache.enabled': 'false',
};

// ─── Questions with corpus-extracted expected facts ────────────────────

export interface Cat29Question {
  id: string;
  text: string;
  /** Concrete ground-truth facts extracted from the committed corpus. */
  expected_facts: string[];
  /** Corpus pages handed to the judge as the world-of-facts. */
  gold_slugs: string[];
}

interface FactRow { since: string; claim: string }

/** Parse `| 2025-01-15 | ARR is $120K | arr | ... |` rows from a Facts fence. */
export function arrReadings(body: string): FactRow[] {
  const out: FactRow[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*arr\s*\|/);
    if (m) out.push({ since: m[1], claim: m[2] });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

function pageBySlug(pages: SyntheticPage[], slug: string): SyntheticPage | undefined {
  return pages.find(p => p.slug === slug);
}

function titleOf(p: SyntheticPage): string {
  return p.body.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? p.slug;
}

/**
 * Derive the question set (with expected facts) from the loaded corpus.
 * Extraction is deterministic — the corpus is a committed fixture generated
 * from a pinned seed, so facts can never drift from what was actually
 * seeded (audit cats26-29-18: the old golds described what a good answer
 * "should do" without ever stating the values, so a hallucinated ARR figure
 * could score 10). Questions whose entities are absent from `pages` (test
 * sub-corpora) are skipped.
 */
export function buildQuestions(pages: SyntheticPage[]): Cat29Question[] {
  const out: Cat29Question[] = [];

  // q1 — who works at Horizon TECH 6 (people pages linking the company).
  const horizon = pageBySlug(pages, 'companies/horizon-tech-6');
  if (horizon) {
    const linkers = pages
      .filter(p => p.slug.startsWith('people/') && p.body.includes('[[companies/horizon-tech-6]]'))
      .map(p => p.slug)
      .sort();
    if (linkers.length > 0) {
      out.push({
        id: 'q1-horizon-people',
        text: 'Who works at the Horizon TECH 6 company? What roles do they hold?',
        expected_facts: [
          `The people pages linking companies/horizon-tech-6 are: ${linkers.join(', ')}`,
          'Role information comes from those people pages (e.g. CEO / joined dates)',
        ],
        gold_slugs: ['companies/horizon-tech-6', ...linkers.slice(0, 5)],
      });
    }
  }

  // q2 — ARR trajectory of Acme CO 0 (real seeded readings, in date order).
  const acme = pageBySlug(pages, 'companies/acme-co-0');
  if (acme) {
    const readings = arrReadings(acme.body);
    if (readings.length >= 2) {
      out.push({
        id: 'q2-acme-arr-trajectory',
        text: 'Has the ARR of the Acme CO 0 company grown over time? What were the readings?',
        expected_facts: [
          ...readings.map(r => `${r.claim} as of ${r.since}`),
          'ARR grew across the readings, reported in date order',
        ],
        gold_slugs: ['companies/acme-co-0'],
      });
    }
  }

  // q3 — concepts most linked from company pages (counted from the corpus).
  const conceptCounts = new Map<string, number>();
  for (const p of pages.filter(p => p.slug.startsWith('companies/'))) {
    for (const m of p.body.matchAll(/\[\[(concepts\/[a-z0-9-]+)\]\]/g)) {
      conceptCounts.set(m[1], (conceptCounts.get(m[1]) ?? 0) + 1);
    }
  }
  const topConcepts = [...conceptCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  if (topConcepts.length > 0) {
    out.push({
      id: 'q3-top-concepts',
      text: 'Which concept pages do the largest number of company pages link to?',
      expected_facts: topConcepts.map(([slug, n]) => `${slug} is linked from ${n} company pages`),
      gold_slugs: topConcepts.map(([slug]) => slug).filter(s => pageBySlug(pages, s)),
    });
  }

  // q4 — attendees of the autonomous-picking meeting (extracted refs).
  const meeting = pages.find(p => p.slug.startsWith('meetings/') && p.slug.includes('autonomous-picking'));
  if (meeting) {
    const attendees = [...new Set([...meeting.body.matchAll(/\[\[(people\/[a-z0-9-]+)\]\]/g)].map(m => m[1]))].sort();
    if (attendees.length > 0) {
      out.push({
        id: 'q4-autonomous-picking-attendees',
        text: 'Who was at the autonomous-picking meeting? What did they discuss?',
        expected_facts: [
          `Attendees: ${attendees.join(', ')}`,
          'They discussed autonomous-picking (see the meeting notes)',
        ],
        gold_slugs: [meeting.slug, ...attendees],
      });
    }
  }

  // q5 — gap test: latest ARR of Cobalt Labs 16 vs an as-of date after it.
  const cobalt = pageBySlug(pages, 'companies/cobalt-labs-16');
  if (cobalt) {
    const readings = arrReadings(cobalt.body);
    const latest = readings[readings.length - 1];
    if (latest) {
      out.push({
        id: 'q5-cobalt-arr-gap',
        text: 'What is the current ARR of the Cobalt Labs 16 company as of May 2026?',
        expected_facts: [
          `The most recent seeded reading is "${latest.claim}" as of ${latest.since}`,
          'A correct answer reports that value AND/OR notes the reading predates May 2026 (data gap)',
        ],
        gold_slugs: ['companies/cobalt-labs-16'],
      });
    }
  }

  return out;
}

// ─── Blind pairwise judge (both answers in one prompt, both orders) ───

/** FNV-1a → deterministic coin per question id (rule: no unseeded randomness). */
export function seededCoin(id: string): boolean {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 1) === 1;
}

export function rubricFor(q: Cat29Question): RubricCriterion[] {
  return [
    { id: 'facts', weight: 2, criterion: `States the expected facts (see the _gold/expected-facts page): ${q.expected_facts.join('; ')}` },
    { id: 'grounded', weight: 1, criterion: 'Specific claims (numbers, dates, names) are supported by the ground-truth pages; invented values or invented slugs score 0' },
    { id: 'cites', weight: 1, criterion: 'Cites the relevant page slugs' },
    { id: 'direct', weight: 1, criterion: 'Directly answers the question asked; usable without reading the raw pages' },
  ];
}

/** Ground truth for the judge: gold pages plus the expected-facts digest. Never a verdict label. */
export function groundTruthFor(q: Cat29Question, pages: SyntheticPage[]): GroundTruthPage[] {
  const groundTruth = q.gold_slugs
    .map(slug => pageBySlug(pages, slug))
    .filter((p): p is SyntheticPage => p !== undefined)
    .map(p => ({ slug: p.slug, title: titleOf(p), content: p.body.slice(0, 1500) }));
  groundTruth.push({
    slug: '_gold/expected-facts',
    title: 'Expected facts',
    content: q.expected_facts.map(f => `- ${f}`).join('\n'),
  });
  return groundTruth;
}

export const PAIRWISE_JUDGE_SYSTEM_PROMPT = `You compare two candidate answers to the same question about a personal knowledge base. You see the question, the ground_truth_pages (the world of facts, including an expected-facts page), a rubric, and two answers labeled Answer 1 and Answer 2. You do not know which system produced which answer, and the order of presentation carries no information.

Score EACH answer on EVERY rubric criterion 0-5 where:
  5 = fully satisfied
  3-4 = mostly satisfied with minor gaps
  1-2 = partially satisfied, significant gaps or hedging
  0 = absent, contradicted by ground truth, or invented
Anything in an answer not grounded in ground_truth_pages is a hallucination and must lose points. Then state which answer is better overall, or tie when they are substantively equivalent.

Be terse: one sentence per rationale. Return your evaluation via the score_pair tool. Do not reply with plain text.

${UNTRUSTED_DATA_INSTRUCTION}`;

const SCORE_ITEMS = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      criterion_id: { type: 'string' },
      score: { type: 'number', minimum: 0, maximum: 5 },
      rationale: { type: 'string' },
    },
    required: ['criterion_id', 'score', 'rationale'],
  },
};

export const SCORE_PAIR_TOOL = {
  name: 'score_pair',
  description: 'Score Answer 1 and Answer 2 on every rubric criterion (0-5, one terse rationale each) and state which answer is better overall.',
  input_schema: {
    type: 'object' as const,
    properties: {
      answer_1_scores: SCORE_ITEMS,
      answer_2_scores: SCORE_ITEMS,
      preferred: { type: 'string', enum: ['answer_1', 'answer_2', 'tie'] },
      rationale: { type: 'string' },
    },
    required: ['answer_1_scores', 'answer_2_scores', 'preferred', 'rationale'],
  },
};

const PAIR_MAX_TOKENS = 1200;
/** Shown in place of an answer whose system crashed; that side is scored 0 regardless. */
export const NO_ANSWER_TEXT = '(no answer: the system returned nothing)';

/**
 * BLIND pairwise judge prompt: both answers, neutral position labels, ground
 * truth and rubric. No system identity or expected verdict, ever. Answers
 * and page bodies are escaped and fenced with the per-call nonce.
 */
/**
 * The structured judge input: question, ground truth, rubric and two answers
 * under neutral labels. renderPairPrompt checks it against the input
 * allowlist (evaluator/judge-inputs.ts) and renders only these fields.
 */
export function pairJudgeInput(q: Cat29Question, answer1: string, answer2: string, pages: SyntheticPage[]): Cat29JudgeInput {
  return {
    question: { id: q.id, text: q.text },
    ground_truth: groundTruthFor(q, pages),
    rubric: rubricFor(q).map(c => ({ id: c.id, weight: c.weight, criterion: c.criterion })),
    answer_1: answer1,
    answer_2: answer2,
  };
}

export function renderPairPrompt(
  q: Cat29Question,
  answer1: string,
  answer2: string,
  pages: SyntheticPage[],
  nonce: string = newJudgeNonce(),
): string {
  const input = pairJudgeInput(q, answer1, answer2, pages);
  assertCat29JudgeInput(input);
  const lines: string[] = [];
  lines.push('<question>');
  lines.push(`  id: ${input.question.id}`);
  lines.push(`  text: ${JSON.stringify(input.question.text)}`);
  lines.push('</question>');
  lines.push('');
  lines.push('<ground_truth_pages>');
  for (const p of input.ground_truth) {
    lines.push(`  <page slug=${JSON.stringify(escapeUntrusted(p.slug))} title=${JSON.stringify(escapeUntrusted(p.title))}>`);
    lines.push(fenceUntrusted('untrusted_page', p.content, nonce));
    lines.push('  </page>');
  }
  lines.push('</ground_truth_pages>');
  lines.push('');
  lines.push('Answer 1:');
  lines.push(fenceUntrusted('untrusted_answer_1', input.answer_1, nonce));
  lines.push('');
  lines.push('Answer 2:');
  lines.push(fenceUntrusted('untrusted_answer_2', input.answer_2, nonce));
  lines.push('');
  lines.push('<rubric>');
  for (const c of input.rubric) lines.push(`  - id=${c.id} weight=${c.weight}: ${c.criterion}`);
  lines.push('</rubric>');
  lines.push('');
  lines.push('Score both answers on every rubric criterion and state your preference via the score_pair tool. No plain text reply.');
  return lines.join('\n');
}

export class JudgeFailure extends Error {}

interface OrderVerdict {
  /** Weighted rubric mean (0-5) for the answer shown first / second. */
  first: number;
  second: number;
  preferred: 'first' | 'second' | 'tie';
}

function parsePairOutput(response: Anthropic.Messages.Message, rubric: RubricCriterion[]): { verdict: OrderVerdict | null; defect: string | null } {
  const block = response.content.find(b => b.type === 'tool_use' && b.name === SCORE_PAIR_TOOL.name) as Anthropic.Messages.ToolUseBlock | undefined;
  if (!block || !block.input || typeof block.input !== 'object') return { verdict: null, defect: 'no score_pair tool_use block in response' };
  const input = block.input as Record<string, unknown>;
  const one = parseCriterionScores(input.answer_1_scores, rubric);
  if (one.scores === null) return { verdict: null, defect: `answer_1_scores: ${one.defect}` };
  const two = parseCriterionScores(input.answer_2_scores, rubric);
  if (two.scores === null) return { verdict: null, defect: `answer_2_scores: ${two.defect}` };
  if (input.preferred !== 'answer_1' && input.preferred !== 'answer_2' && input.preferred !== 'tie') {
    return { verdict: null, defect: `preferred must be answer_1|answer_2|tie, got ${JSON.stringify(input.preferred)}` };
  }
  if (typeof input.rationale !== 'string') return { verdict: null, defect: 'rationale missing' };
  return {
    verdict: {
      first: weightedMean(one.scores, rubric),
      second: weightedMean(two.scores, rubric),
      preferred: input.preferred === 'answer_1' ? 'first' : input.preferred === 'answer_2' ? 'second' : 'tie',
    },
    defect: null,
  };
}

/**
 * One pairwise judge call for one presentation order, at temperature 0 under
 * the shared LLM budget. Malformed output gets one corrective retry (the
 * judge.ts policy); an API error or a second malformed output throws
 * JudgeFailure.
 */
async function judgeOrder(
  q: Cat29Question,
  answer1: string,
  answer2: string,
  pages: SyntheticPage[],
  judgeConfig: JudgeConfig,
): Promise<{ verdict: OrderVerdict; cost_usd: number }> {
  const client = judgeConfig.client ?? new Anthropic();
  const budget = judgeConfig.budget ?? getDefaultLlmBudget();
  const rubric = rubricFor(q);
  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: renderPairPrompt(q, answer1, answer2, pages) }];
  let cost = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let response: Anthropic.Messages.Message;
    try {
      response = await budget.withLlmSlot(() => client.messages.create({
        model: judgeConfig.model ?? JUDGE_MODEL,
        max_tokens: judgeConfig.maxTokens ?? PAIR_MAX_TOKENS,
        ...(acceptsTemperature(judgeConfig.model ?? JUDGE_MODEL) ? { temperature: JUDGE_TEMPERATURE } : {}),
        system: [{ type: 'text', text: PAIRWISE_JUDGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [SCORE_PAIR_TOOL],
        tool_choice: { type: 'tool', name: SCORE_PAIR_TOOL.name },
        messages,
      }));
    } catch (e: any) {
      throw new JudgeFailure(`judge call failed for ${q.id}: ${e?.message ?? e}`);
    }
    cost += priceOf(response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0);
    const parsed = parsePairOutput(response, rubric);
    if (parsed.verdict) return { verdict: parsed.verdict, cost_usd: cost };
    messages.splice(1, 1, {
      role: 'user',
      content: `Your previous response was malformed: ${parsed.defect}. Call score_pair again with complete score sets for both answers.`,
    });
  }
  throw new JudgeFailure(`judge_failed (malformed output after retry) for ${q.id}`);
}

type Side = 'a' | 'b';

export interface OrderRow {
  order: [Side, Side];
  a: number;
  b: number;
  preferred: Side | 'tie';
}

export interface PairScores {
  /** Mean rubric score (0-5) per side across both orders; a crashed side scores 0. */
  a: number;
  b: number;
  by_order: OrderRow[];
  /** Both orders preferred the same side (or both tie); null when no judge call ran. */
  position_consistent: boolean | null;
  preference: Side | 'tie' | 'inconsistent' | null;
  cost_usd: number;
}

/**
 * Judge two blind answers side by side in BOTH presentation orders (first
 * order fixed by a seed from the question id). Per-side scores average over
 * the orders, which cancels a constant position bias; a pair whose
 * preferred side flips with the order is reported as position-inconsistent.
 * Any judge failure throws JudgeFailure, and the caller excludes the question
 * via probe-accounting origin 'judge'. A null answer (its system crashed)
 * is a sut MISS: shown as NO_ANSWER_TEXT and scored 0.
 */
export async function judgePair(
  q: Cat29Question,
  answers: { a: string | null; b: string | null },
  pages: SyntheticPage[],
  judgeConfig: JudgeConfig,
): Promise<PairScores> {
  if (answers.a === null && answers.b === null) {
    return { a: 0, b: 0, by_order: [], position_consistent: null, preference: null, cost_usd: 0 };
  }
  const text = (side: Side) => answers[side] ?? NO_ANSWER_TEXT;
  const orders: Array<[Side, Side]> = seededCoin(q.id) ? [['b', 'a'], ['a', 'b']] : [['a', 'b'], ['b', 'a']];
  const byOrder: OrderRow[] = [];
  let cost = 0;
  for (const [first, second] of orders) {
    const { verdict, cost_usd } = await judgeOrder(q, text(first), text(second), pages, judgeConfig);
    cost += cost_usd;
    const score = { [first]: verdict.first, [second]: verdict.second } as Record<Side, number>;
    byOrder.push({
      order: [first, second],
      a: answers.a === null ? 0 : score.a,
      b: answers.b === null ? 0 : score.b,
      preferred: verdict.preferred === 'first' ? first : verdict.preferred === 'second' ? second : 'tie',
    });
  }
  const consistent = byOrder[0].preferred === byOrder[1].preferred;
  return {
    a: (byOrder[0].a + byOrder[1].a) / 2,
    b: (byOrder[0].b + byOrder[1].b) / 2,
    by_order: byOrder,
    position_consistent: consistent,
    preference: consistent ? byOrder[0].preferred : 'inconsistent',
    cost_usd: cost,
  };
}

// ─── Think LLM client (temperature pinned) ───────────────────────────────

/** runThink client seam: forwards gbrain's request to Anthropic at THINK_TEMPERATURE. */
export function makeThinkClient(anthropic: Pick<Anthropic, 'messages'>): ThinkLLMClient {
  return {
    create: (params: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }) => anthropic.messages.create(
      { ...params, model: String(params.model).replace(/^anthropic[:/]/, ''), ...(acceptsTemperature(String(params.model)) ? { temperature: THINK_TEMPERATURE } : {}) },
      opts,
    ),
  } as unknown as ThinkLLMClient;
}

// ─── Hermetic stubs (plumbing verification, publishable:false) ─────────

/** Default stub think response: expected facts + citations (a "good" synthesis). */
export function defaultStubThinkResponse(q: Cat29Question): ThinkResponse {
  return {
    answer: `${q.expected_facts.join('. ')}. (see ${q.gold_slugs.join(', ')})`,
    citations: q.gold_slugs.map(slug => ({ page_slug: slug, row_num: null })),
    gaps: [],
  };
}

/**
 * Deterministic pairwise judge client for --stub runs: scores each answer's
 * `facts` criterion by expected-fact substring coverage, `cites` by slug
 * presence, fixed midpoints elsewhere, and prefers the higher total. It
 * reads both answers and the expected facts from their nonce-fenced blocks.
 * `prefer` overrides the preference (tests use it to simulate a
 * position-biased judge). Injected through JudgeConfig.client; rubric
 * coverage, weighting and order bookkeeping still run through the real code.
 */
export function makeStubJudgeClient(hooks?: {
  failOn?: (userContent: string) => boolean;
  onRequest?: (userContent: string) => void;
  prefer?: (userContent: string) => 'answer_1' | 'answer_2' | 'tie';
}): { messages: { create: (params: any) => Promise<any> } } {
  return {
    messages: {
      create: async (params: any) => {
        const userContent = String(params?.messages?.[0]?.content ?? '');
        hooks?.onRequest?.(userContent);
        if (hooks?.failOn?.(userContent)) throw new Error('stub judge: forced failure (test hook)');
        const rubricIds = [...userContent.matchAll(/- id=(\S+) weight=/g)].map(m => m[1]);
        const factsBlock = extractUntrusted(userContent.split('title="Expected facts"')[1] ?? '', 'untrusted_page') ?? '';
        const facts = factsBlock.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2));
        const scoresFor = (answer: string) => {
          const factScore = facts.length === 0 ? 0
            : Math.round((facts.filter(f => answer.includes(f.slice(0, Math.min(40, f.length)))).length / facts.length) * 5);
          const hasCite = /\b(?:people|companies|concepts|meetings|deal)\//.test(answer);
          return rubricIds.map(id => ({
            criterion_id: id,
            score: id === 'facts' ? factScore : id === 'cites' ? (hasCite ? 5 : 0) : 3,
            rationale: 'stub judge (deterministic substring coverage)',
          }));
        };
        const one = scoresFor(extractUntrusted(userContent, 'untrusted_answer_1') ?? '');
        const two = scoresFor(extractUntrusted(userContent, 'untrusted_answer_2') ?? '');
        const total = (xs: Array<{ score: number }>) => xs.reduce((a, x) => a + x.score, 0);
        const preferred = hooks?.prefer?.(userContent)
          ?? (total(one) > total(two) ? 'answer_1' : total(two) > total(one) ? 'answer_2' : 'tie');
        return {
          content: [{ type: 'tool_use', id: 'stub', name: 'score_pair', input: { answer_1_scores: one, answer_2_scores: two, preferred, rationale: 'stub judge' } }],
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    },
  };
}

// ─── Aggregation + verdict ─────────────────────────────────────────────

export interface QuestionResult {
  question_id: string;
  question_text: string;
  expected_facts: string[];
  search_answer: string | null;
  think_answer: string | null;
  /** Mean rubric score (0-5) across both orders; null when the question was judge-excluded. */
  search_score: number | null;
  think_score: number | null;
  think_wins: boolean | null;
  judge_excluded: boolean;
  sut_errors: string[];
  /** Pairwise preference; 'inconsistent' when it flipped with the presentation order. */
  judge_preference: 'search' | 'think' | 'tie' | 'inconsistent' | null;
  position_consistent: boolean | null;
  judge_orders: Array<{ first: 'search' | 'think'; search_score: number; think_score: number; preferred: 'search' | 'think' | 'tie' }>;
}

const SYSTEM_OF: Record<'a' | 'b', 'search' | 'think'> = { a: 'search', b: 'think' };

export function computeVerdict(rows: QuestionResult[], nTotal: number): 'pass' | 'partial' | 'fail' {
  const judged = rows.filter(r => !r.judge_excluded && r.search_score !== null && r.think_score !== null);
  if (judged.length === 0) return 'fail';
  const mean = (key: 'search_score' | 'think_score') =>
    judged.reduce((a, r) => a + (r[key] as number), 0) / judged.length;
  if (mean('think_score') < mean('search_score')) return 'fail';
  return judged.length === nTotal ? 'pass' : 'partial';
}

// ─── Entry point ───────────────────────────────────────────────────────

export interface Cat29Options {
  /** Hermetic mode: stub embeds + stub think + stub judge, no keys. */
  stub?: boolean;
  allowSkip?: boolean;
  pages?: SyntheticPage[];
  questions?: Cat29Question[];
  questionLimit?: number;
  reportsDir?: string;
  quiet?: boolean;
  /** Injected judge client (tests). Defaults: stub client under --stub, real Haiku otherwise. */
  judgeClient?: JudgeConfig['client'];
  /** Injected stub think response builder (tests / --stub). */
  thinkResponseFor?: (q: Cat29Question) => ThinkResponse;
  /** Injected Anthropic client for the think LLM (tests). Default: stub response under --stub, a real client live. */
  thinkAnthropic?: Pick<Anthropic, 'messages'>;
  /** Think model (`provider:model`); default unchanged. */
  model?: string;
  /** Judge model; an OpenAI id runs through the Responses shim. Default unchanged. */
  judgeModel?: string;
  /** Negative-control arm: `hash` swaps live embeddings for deterministic hash vectors while think and the judge stay live. */
  embedMode?: 'real' | 'hash';
  budget?: BudgetOptions;
  preregistration?: string;
  /** Pre-run estimate for the budget run (default $0.40, the header's live estimate). */
  estimateUsd?: number;
}

export interface Cat29RunResult {
  receipt: Receipt;
  rows: QuestionResult[];
  exitCode: number;
  receiptFile: string;
}

export function optionsFromEnv(argv: string[] = process.argv.slice(2)): Cat29Options {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const embedMode = flag('--embed-mode');
  if (embedMode !== undefined && embedMode !== 'real' && embedMode !== 'hash') throw new Error(`--embed-mode must be real or hash (got ${embedMode})`);
  return {
    model: flag('--model'),
    judgeModel: flag('--judge-model'),
    embedMode: embedMode as 'real' | 'hash' | undefined,
    budget: budgetOptionsFrom(argv),
    preregistration: flag('--preregistration'),
    estimateUsd: flag('--estimate-usd') === undefined ? undefined : Number(flag('--estimate-usd')),
    stub: argv.includes('--stub') || process.env.CAT29_STUB === '1',
    allowSkip: argv.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    questionLimit: process.env.CAT29_QUESTIONS ? parseInt(process.env.CAT29_QUESTIONS, 10) : undefined,
  };
}

export async function runCat29(options: Cat29Options = {}): Promise<Cat29RunResult> {
  const startedAt = new Date().toISOString();
  const stub = options.stub === true;
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT29_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);

  // Isolate GBRAIN_HOME so the user's config can't override models/search.
  const home = join(tmpdir(), `cat29-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env.GBRAIN_HOME = home;

  // ── Key preflight: live mode needs both providers; never pretend to pass ──
  if (!stub) {
    const missing = [
      ...(!process.env.ANTHROPIC_API_KEY ? ['ANTHROPIC_API_KEY'] : []),
      ...(!process.env.OPENAI_API_KEY ? ['OPENAI_API_KEY'] : []),
    ];
    if (missing.length > 0) {
      const receipt: Receipt = {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT29_CATEGORY,
        run_status: 'skipped',
        skip_reason: `missing keys: ${missing.join(', ')} (run with --stub for a hermetic plumbing check)`,
        n_total: 0,
        n_scored: 0,
        completion_rate: 0,
        errors: [],
        publishable: false,
        gbrain_version: gbrainVersionResolved(),
        gbrain_pin: gbrainPin(),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      };
      writeReceipt(receiptFile, receipt);
      log(`[cat29] SKIPPED: ${receipt.skip_reason}\n`);
      return { receipt, rows: [], exitCode: options.allowSkip ? 0 : 1, receiptFile };
    }
  }

  const thinkModel = options.model ?? THINK_MODEL;
  const judgeModel = options.judgeModel ?? JUDGE_MODEL;
  const hashEmbeds = stub || options.embedMode === 'hash';
  let attestation: Attestation | null = null;
  // The guard goes in before any SDK client is built, so the clients fetch through it.
  const paid = !stub && options.budget?.budgetUsd != null
    ? (options.preregistration ? (attestation = attestPreregistration(options.preregistration)) : null, startPaidRun(CAT29_CATEGORY, { ...options.budget, estimateUsd: options.estimateUsd ?? 0.4 }))
    : null;

  if (hashEmbeds) {
    installStubEmbed(); // hash-embed transport (import AND query sides); keeps a real OPENAI key when present
  } else {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: process.env as Record<string, string | undefined>,
    });
  }

  const judgeConfig: JudgeConfig = {
    client: options.judgeClient ?? (stub ? makeStubJudgeClient() as unknown as JudgeConfig['client'] : judgeClientFor(judgeModel, () => new Anthropic()) as unknown as JudgeConfig['client']),
    model: anthropicModelId(judgeModel),
  };
  const thinkResponseFor = options.thinkResponseFor ?? (stub && !options.thinkAnthropic ? defaultStubThinkResponse : undefined);
  const thinkClient = thinkResponseFor ? undefined : makeThinkClient(options.thinkAnthropic ?? new Anthropic());

  // ── Seed one brain with the corpus (pinned config BEFORE ingest) ──
  const pages = options.pages ?? loadSyntheticV1();
  const engine: any = new PGLiteEngine();
  const origLog = console.log;
  console.log = () => {};
  let thinkModelUsed: string | null = null;
  const rows: QuestionResult[] = [];
  let questions: Cat29Question[] = [];
  let judgeCost = 0;
  let acc: ProbeAccounting;
  try {
    await engine.connect({});
    await engine.initSchema();
    for (const [key, value] of Object.entries(PINNED_CONFIG)) await engine.setConfig(key, value);
    await engine.setConfig('models.think', thinkModel);
    for (const p of pages) {
      await importFromContentEmbedded(engine, p.slug, p.body, { noEmbed: false });
    }
    console.log = origLog;
    log(`[cat29] seeded ${pages.length} pages${stub ? ' [STUB — hash embeds, stub think, stub judge]' : ''}\n`);

    questions = options.questions ?? buildQuestions(pages);
    const limit = options.questionLimit ?? questions.length;
    questions = questions.slice(0, Math.max(0, limit));
    if (questions.length === 0) throw new Error('no questions derivable from the provided corpus');
    acc = new ProbeAccounting(questions.length);

    for (const q of questions) {
      log(`[cat29] running ${q.id}...\n`);
      const sutErrors: string[] = [];
      // Input allowlist: both systems get the question text only, never the
      // expected facts or gold slugs. A violation is a harness bug and aborts.
      assertCat29SutQuestion(q.text, q.expected_facts, q.gold_slugs);

      // SEARCH side: raw retrieved payload (what an agent would dump).
      let searchAns: string | null = null;
      try {
        const results = await hybridSearch(engine, q.text, { limit: 5 } as any);
        searchAns = results.length === 0
          ? '(no results)'
          : `Top retrieved pages:\n${(results as any[]).slice(0, 5).map((r: any, i: number) => {
              const body = String(r.chunk_text ?? '').slice(0, 200).replace(/\s+/g, ' ').trim();
              return `${i + 1}. ${r.slug} — ${body}`;
            }).join('\n')}`;
      } catch (e: any) {
        sutErrors.push(`search: ${e?.message ?? e}`);
        acc.error(q.id, 'sut', `search failed: ${e?.message ?? e}`);
      }

      // THINK side: full synthesis pipeline (gather runs against the real
      // engine even under --stub; only the LLM call is stubbed).
      let thinkAns: string | null = null;
      try {
        const r = await runThink(engine, {
          question: q.text,
          remote: false,
          ...(thinkResponseFor ? { stubResponse: thinkResponseFor(q) } : { client: thinkClient }),
        });
        thinkModelUsed = thinkModelUsed ?? r.modelUsed;
        thinkAns = r.answer && r.answer.trim().length > 0 ? r.answer : null;
        if (thinkAns === null) {
          sutErrors.push(`think: empty answer (synthesis_status=${r.synthesis_status ?? 'unknown'})`);
          acc.error(q.id, 'sut', `think produced no answer (${r.synthesis_status ?? 'unknown'})`);
        }
      } catch (e: any) {
        sutErrors.push(`think: ${e?.message ?? e}`);
        acc.error(q.id, 'sut', `think failed: ${e?.message ?? e}`);
      }

      // BLIND pairwise judging, both orders. 'a' = search, 'b' = think; the
      // labels never reach the judge and the mapping exists only in this runner.
      try {
        const pair = await judgePair(q, { a: searchAns, b: thinkAns }, pages, judgeConfig);
        judgeCost += pair.cost_usd;
        rows.push({
          question_id: q.id,
          question_text: q.text,
          expected_facts: q.expected_facts,
          search_answer: searchAns?.slice(0, 500) ?? null,
          think_answer: thinkAns?.slice(0, 500) ?? null,
          search_score: pair.a,
          think_score: pair.b,
          think_wins: pair.b > pair.a,
          judge_excluded: false,
          sut_errors: sutErrors,
          judge_preference: pair.preference === null || pair.preference === 'tie' || pair.preference === 'inconsistent'
            ? pair.preference
            : SYSTEM_OF[pair.preference],
          position_consistent: pair.position_consistent,
          judge_orders: pair.by_order.map(o => ({
            first: SYSTEM_OF[o.order[0]],
            search_score: o.a,
            think_score: o.b,
            preferred: o.preferred === 'tie' ? 'tie' : SYSTEM_OF[o.preferred],
          })),
        });
        // Probe score = think - search delta on the 0-5 judge scale. A side
        // that crashed already recorded a sut error (scored 0); do not
        // overwrite it with a delta (audit B-29-04).
        if (sutErrors.length === 0) acc.score(q.id, pair.b - pair.a);
        log(`[cat29]   ${q.id}: search=${pair.a.toFixed(2)} think=${pair.b.toFixed(2)} Δ=${(pair.b - pair.a).toFixed(2)} preference=${pair.preference ?? 'n/a'}\n`);
      } catch (e: any) {
        if (e instanceof JudgeFailure) {
          // Judge infra failure: EXCLUDED from means, recorded, capped —
          // never folded in as 0 (audit cats26-29-11).
          acc.error(q.id, 'judge', e.message);
          rows.push({
            question_id: q.id,
            question_text: q.text,
            expected_facts: q.expected_facts,
            search_answer: searchAns?.slice(0, 500) ?? null,
            think_answer: thinkAns?.slice(0, 500) ?? null,
            search_score: null,
            think_score: null,
            think_wins: null,
            judge_excluded: true,
            sut_errors: sutErrors,
            judge_preference: null,
            position_consistent: null,
            judge_orders: [],
          });
          log(`[cat29]   ${q.id}: JUDGE EXCLUDED (${e.message})\n`);
        } else {
          throw e;
        }
      }
    }
  } finally {
    console.log = origLog;
    if (hashEmbeds) __setEmbedTransportForTests(null);
    try { await engine.disconnect(); } catch { /* already dead */ }
    paid?.guard.uninstall();
  }
  const paidCost = paid ? receiptCost(paid.run.close()) : null;

  const judged = rows.filter(r => !r.judge_excluded);
  const mean = (key: 'search_score' | 'think_score') =>
    judged.length === 0 ? NaN : judged.reduce((a, r) => a + (r[key] ?? 0), 0) / judged.length;
  const sMean = mean('search_score');
  const tMean = mean('think_score');
  // A stub run checks plumbing: never a pass (audit B-29-04), like Cats 25 and 26.
  const measured = computeVerdict(rows, questions.length);
  const verdict = stub && measured === 'pass' ? 'partial' : measured;
  const inconsistent = judged.filter(r => r.position_consistent === false);
  const summary = acc.summary();

  const receipt: Receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT29_CATEGORY,
    run_status: 'completed',
    verdict,
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable && !stub && !options.questions && !options.pages
      && (options.questionLimit === undefined),
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      ...PINNED_CONFIG,
      input_allowlist: [CAT29_SUT_QUESTION.name, CAT29_JUDGE_PAIR.name],
      'models.think': thinkModel,
      think_model_used: thinkModelUsed,
      embed_transport: hashEmbeds ? 'stubbed-hash' : 'live',
      embed_mode: options.embedMode ?? 'real',
      judge_transport: judgeTransport(judgeModel),
      temperature_sent: { think: acceptsTemperature(thinkModel), judge: acceptsTemperature(judgeModel) },
      think_llm: thinkResponseFor ? 'stubbed' : options.thinkAnthropic ? 'injected' : 'live',
      think_temperature: THINK_TEMPERATURE,
      judge_mode: options.judgeClient || stub ? 'injected/stub' : 'live',
      judge_blind: true,
      judge_pairwise: true,
      judge_both_orders: true,
    },
    judge: { model: stub ? 'stub-judge' : judgeModel, temperature: JUDGE_TEMPERATURE, rubric_version: RUBRIC_VERSION },
    ...(attestation ? { preregistration_attestation: attestation } : {}),
    ...(paidCost ? { cost: paidCost } : {}),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      corpus: 'synthetic-v1',
      corpus_pages: pages.length,
      questions: questions.length,
      questions_judged: judged.length,
      search_mean_score_0to5: Number.isNaN(sMean) ? null : sMean,
      think_mean_score_0to5: Number.isNaN(tMean) ? null : tMean,
      think_wins: judged.filter(r => (r.think_score ?? 0) > (r.search_score ?? 0)).length,
      search_wins: judged.filter(r => (r.search_score ?? 0) > (r.think_score ?? 0)).length,
      ties: judged.filter(r => r.search_score === r.think_score).length,
      position_inconsistent: inconsistent.length,
      position_inconsistent_question_ids: inconsistent.map(r => r.question_id),
      judge_cost_usd: judgeCost,
      per_question: rows,
    },
  };
  writeReceipt(receiptFile, receipt);

  const outDir = join(reportsDir, CAT29_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat29.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat29] ─── Scorecard ───────────────────\n`);
  log(`[cat29]   corpus:           synthetic-v1 (${pages.length} pages)\n`);
  log(`[cat29]   questions:        ${questions.length} (${judged.length} judged, ${rows.length - judged.length} judge-excluded)\n`);
  log(`[cat29]   search mean:      ${Number.isNaN(sMean) ? 'n/a' : sMean.toFixed(2)}/5\n`);
  log(`[cat29]   think mean:       ${Number.isNaN(tMean) ? 'n/a' : tMean.toFixed(2)}/5\n`);
  log(`[cat29]   think model:      ${thinkModelUsed ?? 'n/a'} (pinned ${thinkModel})\n`);
  log(`[cat29]   position flips:   ${inconsistent.length}/${judged.length} judged pairs\n`);
  log(`[cat29]   verdict:          ${verdict} (run_invalid=${summary.run_invalid}, publishable=${receipt.publishable})\n`);
  log(`[cat29]   receipt:          ${receiptFile}\n`);

  // A stub run whose gate held exits 0: plumbing verified, reported as partial.
  const exitCode = summary.run_invalid ? 1 : (measured === 'pass' ? 0 : 1);
  return { receipt, rows, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat29(optionsFromEnv());
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT29_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT29_CATEGORY,
        run_status: 'error',
        n_total: 0,
        n_scored: 0,
        completion_rate: 0,
        errors: [{ probe_id: 'preflight', origin: 'harness', message: String(e?.message ?? e).slice(0, 500) }],
        publishable: false,
        gbrain_version: gbrainVersionResolved(),
        gbrain_pin: gbrainPin(),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });
    } catch { /* receipt write failed too — exit code carries the failure */ }
    process.stderr.write(`[cat29] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
