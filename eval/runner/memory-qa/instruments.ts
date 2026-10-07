/**
 * Benchmark judge instruments (Q1 PLAN §4.4, §4.8.11): one registry entry per
 * benchmark with its pinned prompts, response parser and score aggregation,
 * so every published number links to the benchmark's own measuring
 * instrument.
 *
 *   lme-s, lme-m  LongMemEval's official per-type prompts and the
 *                 unanswerable prompt for `_abs` questions, byte for byte
 *                 from `src/evaluation/evaluate_qa.py` at
 *                 xiaowu0162/LongMemEval@9e0b455 (`get_anscheck_prompt`);
 *                 judge gpt-4o-2024-08-06, temperature 0, max_tokens 10.
 *   locomo        the same prompts: temporal questions use the temporal
 *                 prompt (off-by-one tolerance), adversarial questions the
 *                 unanswerable prompt, every other category the base prompt.
 *   beam-*        BEAM's rubric judge from `src/evaluation/compute_metrics.py`
 *                 at mohammadtavakoli78/BEAM@b2da22e: each rubric item through
 *                 `unified_llm_judge_base_prompt` (its `<rubric_item>` and
 *                 `<llm_response>` replaced in that order, the question not
 *                 inserted, as BEAM does), a JSON `score` of 0, 0.5 or 1,
 *                 averaged over the rubric; event ordering scores BEAM's
 *                 reported `tau_norm` (`report_results.py`): the response's
 *                 lines aligned to the rubric list by BEAM's
 *                 `llm_equivalence` prompt, then Kendall tau-b, normalized
 *                 to (tau + 1) / 2. Judge gpt-4.1-mini, temperature 0.
 *
 * Parsing departs from the official code in one direction only: an output
 * the official code would read as "no" or crash on because it is empty or
 * says neither yes nor no (or carries no parseable score) is a malformed
 * judgment, which the caller retries and finally records as a judge
 * failure, never as a "no". Every well-formed output parses exactly as the
 * official code parses it (test/eval/q1-instruments.test.ts holds goldens
 * computed by running the pinned Python).
 *
 * `sha256` covers the prompt templates, parser and aggregation versions and
 * call settings; the judge model is recorded beside it, so the frontier-judge
 * column shares an instrument hash with the canonical judge.
 */
import { createHash } from 'node:crypto';
import type { MemoryQuestion } from './corpus.ts';

export type Parsed = { ok: true; value: number } | { ok: false; reason: string };

export interface JudgeCall {
  kind: 'verdict' | 'rubric' | 'equivalence';
  system?: string;
  prompt: string;
  max_tokens: number;
  parse: (raw: string) => Parsed;
}

/** Issue one judge call; resolves to the accepted raw output and its parsed value, or rejects after the caller's retries. */
export type Ask = (call: JudgeCall) => Promise<{ raw: string; value: number }>;

export interface InstrumentScore { score: number; detail?: Record<string, unknown> }

export interface Instrument {
  id: string;
  version: string;
  /** The benchmark's canonical judge model (`provider:model`). */
  canonical_judge: string;
  temperature: number;
  source: { repository: string; commit: string; files: string[] };
  templates: Record<string, string>;
  sha256: string;
  score(q: MemoryQuestion, response: string, ask: Ask): Promise<InstrumentScore>;
}

// ─── LongMemEval and LoCoMo ──────────────────────────────────────────

/** Python's `str.format` with positional `{}` fields only (the official templates use nothing else). */
export function pyFormat(template: string, ...args: Array<string | number>): string {
  const parts = template.split('{}');
  if (parts.length !== args.length + 1) throw new Error(`template has ${parts.length - 1} fields, got ${args.length} values`);
  return parts.reduce((out, p, i) => out + (i ? String(args[i - 1]) : '') + p, '');
}

export const LME_TEMPLATES: Record<string, string> = {
  base: "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
  'temporal-reasoning': "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
  'knowledge-update': "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
  'single-session-preference': "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
  abstention: "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.",
};

const LME_TYPE_TEMPLATE: Record<string, string> = {
  'single-session-user': 'base', 'single-session-assistant': 'base', 'multi-session': 'base',
  'temporal-reasoning': 'temporal-reasoning', 'knowledge-update': 'knowledge-update', 'single-session-preference': 'single-session-preference',
};

/**
 * The official verdict is `'yes' in reply.strip().lower()`. Kept exactly for
 * every reply that says yes or no; an empty reply or one with neither is
 * malformed instead of "no".
 */
export function parseYesNo(raw: string): Parsed {
  const s = raw.trim().toLowerCase();
  if (!s) return { ok: false, reason: 'empty judgment' };
  if (s.includes('yes')) return { ok: true, value: 1 };
  if (/\bno\b/.test(s)) return { ok: true, value: 0 };
  return { ok: false, reason: 'judgment says neither yes nor no' };
}

/** The template key a LongMemEval-style question uses. */
export function lmeTemplateKey(benchmark: 'lme' | 'locomo', q: MemoryQuestion): string {
  if (q.abstention) return 'abstention';
  if (benchmark === 'locomo') return q.category === 'temporal' ? 'temporal-reasoning' : 'base';
  const key = LME_TYPE_TEMPLATE[q.category];
  if (!key) throw new Error(`LongMemEval has no judge prompt for question type ${q.category}`);
  return key;
}

function yesNoInstrument(id: string, family: 'lme' | 'locomo'): Instrument {
  const settings = { max_tokens: 10, parser: 'yes-no-v1', aggregation: 'single-verdict' };
  const base = {
    id, version: 'v1', canonical_judge: 'openai:gpt-4o-2024-08-06', temperature: 0,
    source: { repository: 'https://github.com/xiaowu0162/LongMemEval', commit: '9e0b455f4ef0e2ab8f2e582289761153549043fc', files: ['src/evaluation/evaluate_qa.py'] },
    templates: LME_TEMPLATES,
  };
  return {
    ...base, sha256: instrumentHash({ ...base, family, ...settings }),
    async score(q, response, ask) {
      const key = lmeTemplateKey(family, q);
      const { value } = await ask({ kind: 'verdict', prompt: pyFormat(LME_TEMPLATES[key], q.question, q.answer ?? '', response), max_tokens: settings.max_tokens, parse: parseYesNo });
      return { score: value, detail: { template: key } };
    },
  };
}

// ─── BEAM ────────────────────────────────────────────────────────────

export const BEAM_UNIFIED_JUDGE_PROMPT = "\nYou are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.\n\n## EVALUATION INPUTS\n- RUBRIC CRITERION (what to check): <rubric_item>\n- RESPONSE TO EVALUATE: <llm_response>\n\n## EVALUATION RUBRIC:\nThe rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate. \n\n**IMPORTANT**: Pay careful attention to whether the rubric specifies:\n- **Positive requirements** (things the response SHOULD include/do)\n- **Negative constraints** (things the response SHOULD NOT include/do, often indicated by \"no\", \"not\", \"avoid\", \"absent\")\n\n## RESPONSIVENESS REQUIREMENT\nA compliant response must be **on-topic** and attempt to answer it.\n- If the response does not address the QUESTION, score **0.0** and stop.\n- For negative constraints, both must hold: (a) the response is responsive to the QUESTION, and (b) the prohibited element is absent.\n\n## SEMANTIC TOLERANCE RULES:\nJudge by meaning, not exact wording.\n- Accept **paraphrases** and **synonyms** that preserve intent.\n- **Case/punctuation/whitespace** differences must be ignored.\n- **Numbers/currencies/dates** may appear in equivalent forms (e.g., “$68,000”, “68k”, “68,000 USD”, or “sixty-eight thousand dollars”). Treat them as equal when numerically equivalent.\n- If the rubric expects a number or duration, prefer **normalized comparison** (extract and compare values) over string matching.\n\n## STYLE NEUTRALITY (prevents style contamination):\nIgnore tone, politeness, length, and flourish unless the rubric explicitly requires a format/structure (e.g., “itemized list”, “no citations”, “one sentence”).\n- Do **not** penalize hedging, voice, or verbosity if content satisfies the rubric.\n- Only evaluate format when the rubric **explicitly** mandates it.\n\n## SCORING SCALE:\n- **1.0 (Complete Compliance)**: Fully complies with the rubric criterion.\n  - Positive: required element present, accurate, properly executed (allowing semantic equivalents).\n  - Negative: prohibited element **absent** AND response is **responsive**.\n  \n- **0.5 (Partial Compliance)**: Partially complies.\n  - Positive: element present but minor inaccuracies/incomplete execution.\n  - Negative: generally responsive and mostly avoids the prohibited element but with minor/edge violations.\n  \n- **0.0 (No Compliance)**: Fails to comply.\n  - Positive: required element missing or incorrect.\n  - Negative: prohibited element present **or** response is non-responsive/evasive even if the element is absent.\n\n## EVALUATION INSTRUCTIONS:\n1. **Understand the Requirement**: Determine if the rubric is asking for something to be present (positive) or absent (negative/constraint).\n\n2. **Parse Compound Statements**: If the rubric contains multiple elements connected by \"and\" or commas, evaluate whether:\n   - **All elements** must be present for full compliance (1.0)\n   - **Some elements** present indicates partial compliance (0.5)\n   - **No elements** present indicates no compliance (0.0)\n   \n3. **Check Compliance**: \n   - For positive requirements: Look for the presence and quality of the required element\n   - For negative constraints: Look for the absence of the prohibited element\n\n4. **Assign Score**: Based on compliance with the specific rubric criterion according to the scoring scale above.\n\n5. **Provide Reasoning**: Explain whether the rubric criterion was satisfied and justify the score.\n\n## OUTPUT FORMAT:\nReturn your evaluation in JSON format with two fields:\n\n{\n   \"score\": [your score: 1.0, 0.5, or 0.0],\n   \"reason\": \"[detailed explanation of whether the rubric criterion was satisfied and why this justified the assigned score]\"\n}\n\nNOTE: ONLY output the json object, without any explanation before or after that\n";

export const BEAM_EQUIVALENCE_SYSTEM = "\n            You are a binary classifier.\n            If the TWO snippets describe the SAME event/fact, reply **YES**\n            Otherwise reply **NO**. No extra words.\n            DO NOT provide any exaplanation.\n        ";
export const BEAM_EQUIVALENCE_USER = 'First snippet: {} \n\n                       Second snippet: {}\n                    ';

/** Python's `str.replace` (every occurrence, no pattern syntax). */
const pyReplace = (s: string, from: string, to: string) => s.split(from).join(to);

export const beamRubricPrompt = (rubricItem: string, response: string) => pyReplace(pyReplace(BEAM_UNIFIED_JUDGE_PROMPT, '<rubric_item>', rubricItem), '<llm_response>', response);

/**
 * BEAM's `parse_json_response` then `float(response['score'])`. Where BEAM
 * falls back to `json_repair`, this reads a leading `"score": <number>` (the
 * truncated-output case). No score, a non-numeric score or one outside 0..1
 * is malformed.
 */
export function parseBeamScore(raw: string): Parsed {
  let s = raw.trim();
  if (!s) return { ok: false, reason: 'empty judgment' };
  if (s.startsWith('```')) {
    const m = /```(?:json)?\s*(\[.*\]|\{.*\})\s*```/s.exec(s);
    if (m) s = m[1].trim();
  }
  let obj: unknown;
  try { obj = JSON.parse(s); } catch {
    const m = /(\{.*?\}|\[.*?\])/s.exec(s);
    if (m) { try { obj = JSON.parse(m[1]); } catch { /* fall through to the repair read */ } }
    if (obj === undefined) {
      const score = /"score"\s*:\s*"?(-?\d+(?:\.\d+)?)/.exec(s);
      if (!score) return { ok: false, reason: 'no JSON score in judgment' };
      obj = { score: Number(score[1]) };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !('score' in obj)) return { ok: false, reason: 'judgment JSON has no score' };
  const raw_score = (obj as { score: unknown }).score;
  const value = typeof raw_score === 'number' ? raw_score : typeof raw_score === 'string' && raw_score.trim() !== '' ? Number(raw_score) : NaN;
  if (!Number.isFinite(value) || value < 0 || value > 1) return { ok: false, reason: `judgment score ${JSON.stringify(raw_score)} is not a number in 0..1` };
  return { ok: true, value };
}

/** BEAM's `llm_equivalence` verdict is `"yes" in reply.lower()`; the same yes/no reading, malformed when neither. */
export const parseEquivalence = parseYesNo;

/** scipy `kendalltau(x, y, variant='b')`; NaN when either ranking is constant. */
export function kendallTauB(x: readonly number[], y: readonly number[]): number {
  let concordant = 0, discordant = 0, tiesX = 0, tiesY = 0;
  for (let i = 0; i < x.length; i++) for (let j = i + 1; j < x.length; j++) {
    const dx = Math.sign(x[i] - x[j]), dy = Math.sign(y[i] - y[j]);
    if (dx === 0 && dy === 0) continue;
    if (dx === 0) tiesX++;
    else if (dy === 0) tiesY++;
    else if (dx === dy) concordant++;
    else discordant++;
  }
  const denom = Math.sqrt((concordant + discordant + tiesX) * (concordant + discordant + tiesY));
  return denom === 0 ? NaN : (concordant - discordant) / denom;
}

/** BEAM's `event_ordering_score` with `align_type="llm"`: align, rank over the union, tau-b, normalized. */
export async function beamEventOrdering(reference: readonly string[], response: string, ask: Ask): Promise<{ tau_norm: number; tau_b: number | null; aligned: string[] }> {
  const system = response.split('\n');
  const used = new Set<number>();
  const aligned: string[] = [];
  for (const s of system) {
    let matched: number | null = null;
    for (let index = 0; index < reference.length; index++) {
      if (used.has(index)) continue;
      const { value } = await ask({ kind: 'equivalence', system: BEAM_EQUIVALENCE_SYSTEM, prompt: pyFormat(BEAM_EQUIVALENCE_USER, reference[index], s), max_tokens: 10, parse: parseEquivalence });
      if (value === 1) { matched = index; break; }
    }
    if (matched !== null) { aligned.push(reference[matched]); used.add(matched); } else aligned.push(s);
  }
  const union = [...new Set([...reference, ...aligned])];
  const rank = (seq: readonly string[]) => { const r = new Map<string, number>(); seq.forEach((item, i) => r.set(item, i + 1)); return union.map(u => r.get(u) ?? union.length + 1); };
  const tau = kendallTauB(rank(reference), rank(aligned));
  return { tau_norm: Number.isNaN(tau) ? 0 : (tau + 1) / 2, tau_b: Number.isNaN(tau) ? null : tau, aligned };
}

function beamInstrument(id: string): Instrument {
  const settings = { rubric_max_tokens: 1024, equivalence_max_tokens: 10, parser: 'beam-json-score-v1', equivalence_parser: 'yes-no-v1', aggregation: 'beam-report-v1: mean rubric score; event_ordering tau_norm' };
  const base = {
    id, version: 'v1', canonical_judge: 'openai:gpt-4.1-mini', temperature: 0,
    source: { repository: 'https://github.com/mohammadtavakoli78/BEAM', commit: 'b2da22eac88bb0874c64665f13457eb99835774a', files: ['src/prompts.py', 'src/evaluation/compute_metrics.py', 'src/evaluation/report_results.py'] },
    templates: { rubric: BEAM_UNIFIED_JUDGE_PROMPT, equivalence_system: BEAM_EQUIVALENCE_SYSTEM, equivalence_user: BEAM_EQUIVALENCE_USER },
  };
  return {
    ...base, sha256: instrumentHash({ ...base, ...settings }),
    async score(q, response, ask) {
      const rubric = q.rubric?.length ? q.rubric : [q.answer ?? ''];
      const items: number[] = [];
      for (const item of rubric) items.push((await ask({ kind: 'rubric', prompt: beamRubricPrompt(item, response), max_tokens: settings.rubric_max_tokens, parse: parseBeamScore })).value);
      const llm_judge_score = items.reduce((a, b) => a + b, 0) / items.length;
      if (q.category !== 'event_ordering') return { score: llm_judge_score, detail: { rubric_scores: items, rubric_fallback: !q.rubric?.length } };
      const order = await beamEventOrdering(rubric, response, ask);
      return { score: order.tau_norm, detail: { rubric_scores: items, llm_judge_score, tau_b: order.tau_b, tau_nan_as_zero: order.tau_b === null } };
    },
  };
}

const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;

function instrumentHash(def: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical(def))).digest('hex');
}

// ─── Registry ────────────────────────────────────────────────────────

export const INSTRUMENTS: Readonly<Record<string, Instrument>> = Object.freeze({
  'lme-s': yesNoInstrument('lme-s', 'lme'),
  'lme-m': yesNoInstrument('lme-m', 'lme'),
  locomo: yesNoInstrument('locomo', 'locomo'),
  'beam-100k': beamInstrument('beam-100k'),
  'beam-500k': beamInstrument('beam-500k'),
  'beam-1m': beamInstrument('beam-1m'),
  'beam-10m': beamInstrument('beam-10m'),
});

/** The instrument for a benchmark; explicit per benchmark, no prefix guessing. */
export function instrumentFor(benchmark: string): Instrument {
  const i = INSTRUMENTS[benchmark];
  if (!i) throw new Error(`no judge instrument is registered for benchmark ${benchmark}; registered: ${Object.keys(INSTRUMENTS).join(', ')}`);
  return i;
}
