/**
 * Judge instruments (Q1 PLAN §4.8.11) against goldens computed by running the
 * pinned official Python (test/eval/fixtures/q1-instrument-golden.json):
 * prompt bytes, verdict parsing, BEAM's JSON score parsing including
 * truncated output, Kendall tau-b, and BEAM's event-ordering score.
 * Malformed or empty judgments are retryable failures, never a "no".
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { BEAM_UNIFIED_JUDGE_PROMPT, INSTRUMENTS, beamEventOrdering, beamRubricPrompt, instrumentFor, kendallTauB, lmeTemplateKey, parseBeamScore, parseYesNo, pyFormat, LME_TEMPLATES, type Ask, type JudgeCall } from '../../eval/runner/memory-qa/instruments.ts';
import { officialJudgePrompt } from '../../eval/runner/evidence-delivery/calls.ts';

const golden = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/q1-instrument-golden.json'), 'utf8'));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const question = (extra: Partial<MemoryQuestion>): MemoryQuestion => ({ id: 'q1', conversation: 'c', question: 'How many days did the trip last?', category: 'multi-session', gold: [], abstention: false, answer: '18', ...extra });

/** The same equivalence oracle the golden generator used in place of the judge model. */
const oracleAsk = (calls: JudgeCall[]): Ask => async call => {
  calls.push(call);
  const m = /^First snippet: (.*) \n\n {23}Second snippet: (.*)\n {20}$/s.exec(call.prompt)!;
  const norm = (s: string) => s.replace(/^\s*(?:\d+[.)]\s*|[-*]\s*)/, '').trim().toLowerCase();
  const raw = norm(m[1]) && norm(m[1]) === norm(m[2]) ? 'YES' : 'NO';
  const p = call.parse(raw);
  if (!p.ok) throw new Error(p.reason);
  return { raw, value: p.value };
};

describe('LongMemEval and LoCoMo instruments', () => {
  test('prompt bytes equal the official get_anscheck_prompt for every question type and abstention', () => {
    for (const g of golden.lme_prompts) {
      const key = lmeTemplateKey('lme', question({ category: g.task, abstention: g.abstention }));
      expect(sha(pyFormat(LME_TEMPLATES[key], g.question, g.answer, g.response))).toBe(g.sha256);
      expect(sha(officialJudgePrompt(g.task, g.question, g.answer, g.response, g.abstention))).toBe(g.sha256);
    }
  });

  test('every well-formed verdict parses as the official label; empty or neither-yes-nor-no is malformed', () => {
    const malformed = new Set(['', '   ', 'Correct', 'nope', 'The model response correctly identifies the']);
    for (const g of golden.lme_parse) {
      const p = parseYesNo(g.raw);
      if (malformed.has(g.raw)) { expect(p.ok).toBe(false); expect(g.official_label).toBe(false); }
      else expect(p).toEqual({ ok: true, value: g.official_label ? 1 : 0 });
    }
  });

  test('LoCoMo dispatch: temporal off-by-one prompt, adversarial unanswerable prompt, base otherwise; LME-M dispatches explicitly', () => {
    expect(lmeTemplateKey('locomo', question({ category: 'temporal' }))).toBe('temporal-reasoning');
    expect(lmeTemplateKey('locomo', question({ category: 'adversarial', abstention: true }))).toBe('abstention');
    expect(lmeTemplateKey('locomo', question({ category: 'single-hop' }))).toBe('base');
    expect(lmeTemplateKey('lme', question({ category: 'knowledge-update' }))).toBe('knowledge-update');
    expect(() => lmeTemplateKey('lme', question({ category: 'single-hop' }))).toThrow(/no judge prompt/);
    expect(instrumentFor('lme-m').id).toBe('lme-m');
    expect(instrumentFor('lme-m').sha256).not.toBe(instrumentFor('lme-s').sha256);
    expect(() => instrumentFor('beam')).toThrow(/no judge instrument/);
  });
});

describe('BEAM instrument', () => {
  test('the rubric prompt is BEAM unified_llm_judge_base_prompt with BEAM\'s replace order', () => {
    expect(sha(BEAM_UNIFIED_JUDGE_PROMPT)).toBe(golden.beam_rubric_prompt.template_sha256);
    expect(sha(beamRubricPrompt(golden.beam_rubric_prompt.rubric_item, golden.beam_rubric_prompt.response))).toBe(golden.beam_rubric_prompt.sha256);
  });

  test('scores parse as BEAM parses them, truncated output included; what BEAM crashes on is malformed', () => {
    for (const g of golden.beam_parse) {
      const p = parseBeamScore(g.raw);
      if ('value' in g) expect(p).toEqual({ ok: true, value: g.value });
      else expect(p.ok).toBe(false);
    }
  });

  test('Kendall tau-b matches scipy, NaN for a constant ranking', () => {
    for (const g of golden.kendall_tau_b) {
      const t = kendallTauB(g.x, g.y);
      if (g.tau_b === null) expect(Number.isNaN(t)).toBe(true);
      else expect(t).toBeCloseTo(g.tau_b, 12);
    }
  });

  test('event ordering reproduces BEAM tau_norm and its equivalence call count', async () => {
    for (const g of golden.event_ordering) {
      const calls: JudgeCall[] = [];
      const r = await beamEventOrdering(g.reference, g.response, oracleAsk(calls));
      expect(r.tau_norm).toBeCloseTo(g.tau_norm, 12);
      expect(calls.length).toBe(g.equivalence_calls);
    }
  });

  test('partial rubrics average; event ordering reports tau_norm with the rubric mean beside it', async () => {
    const replies = ['{"score": 1.0, "reason": "a"}', '```json\n{"score": 0.5}\n```', '{\n "score": 0.0,\n "reason": "trunc'];
    let k = 0;
    const ask: Ask = async call => { const raw = call.kind === 'rubric' ? replies[k++ % 3] : 'NO'; const p = call.parse(raw); if (!p.ok) throw new Error(p.reason); return { raw, value: p.value }; };
    const beam = INSTRUMENTS['beam-10m'];
    expect((await beam.score(question({ category: 'information_extraction', rubric: ['a', 'b', 'c'] }), 'resp', ask)).score).toBeCloseTo(0.5, 12);
    const eo = await beam.score(question({ category: 'event_ordering', rubric: ['x', 'y', 'z'] }), 'z\ny', ask);
    expect(eo.detail).toMatchObject({ llm_judge_score: 0.5 });
    expect(eo.score).toBeGreaterThanOrEqual(0);
  });

  test('every instrument hash is stable and differs across benchmarks that differ', () => {
    const shas = Object.fromEntries(Object.entries(INSTRUMENTS).map(([k, v]) => [k, v.sha256]));
    for (const v of Object.values(shas)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(Object.values(shas)).size).toBe(Object.keys(shas).length);
    expect(INSTRUMENTS['beam-1m'].canonical_judge).toBe('openai:gpt-4.1-mini');
    expect(INSTRUMENTS.locomo.canonical_judge).toBe('openai:gpt-4o-2024-08-06');
  });
});
