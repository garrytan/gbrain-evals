/**
 * outcome-v3 (A10): axes, derived categories, the three preregistered
 * mutation properties, and the immutability of the historical A4 scorers
 * (every committed A4 receipt rescores identically under scoreAnswer and
 * scoreAnswerV2).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateA4World, isAnswerable, type A4Question } from '../../eval/generators/a4-abstention-gen.ts';
import { scoreAnswer, scoreAnswerV2, type AnswerRow } from '../../eval/runner/a4-abstention.ts';
import {
  axes, axesFromJudged, category, labelAgreement, parseJudgedLabel, passesHedgeBar, scoreA4V3, summarize, v2CategoryOf,
  type Commitment, type Correctness, type OutcomeAxes,
} from '../../eval/runner/outcomes/v3.ts';

const ROOT = join(import.meta.dir, '../..');
const { ledger } = generateA4World();
const headcount = ledger.questions.find(q => q.cls === 'answerable_profile' && q.attribute === 'headcount')!;
const missing = ledger.questions.find(q => q.cls === 'missing_attribute' && q.attribute === 'headcount') ?? ledger.questions.find(q => q.cls === 'missing_attribute')!;
const wrongHeadcount = (q: A4Question) => ledger.values.headcount.find(v => v !== q.answer)!;
const IDK = "The information is not available in the retrieved sessions; I don't know.";

const all: OutcomeAxes[] = [];
for (const answerable of [true, false]) for (const commitment of ['committed', 'abstained', null] as (Commitment | null)[]) for (const correctness of ['correct', 'incorrect', null] as (Correctness | null)[]) for (const hedge of [true, false, null]) for (const err of [null, 'reader_failed']) all.push(axes({ answerable, commitment, correctness, hedge, executionError: err }));

describe('derived categories', () => {
  test('the four categories', () => {
    expect(category(axes({ answerable: true, commitment: 'committed', correctness: 'correct', hedge: false }))).toBe('correct');
    expect(category(axes({ answerable: true, commitment: 'committed', correctness: 'incorrect', hedge: true }))).toBe('committed_wrong');
    expect(category(axes({ answerable: true, commitment: 'abstained', correctness: 'incorrect', hedge: false }))).toBe('abstained');
    expect(category(axes({ answerable: false, commitment: 'abstained', correctness: 'correct' }))).toBe('correct');
    expect(category(axes({ answerable: false, commitment: 'committed', correctness: 'incorrect', hedge: true }))).toBe('committed_wrong');
    expect(category(axes({ answerable: true, executionError: 'reader_max_tokens' }))).toBe('execution_error');
  });

  test('an answerable wrong answer with no commitment label counts committed-wrong, never abstained', () => {
    expect(category(axes({ answerable: true, commitment: null, correctness: 'incorrect' }))).toBe('committed_wrong');
    expect(summarize([axes({ answerable: true, commitment: null, correctness: 'incorrect' })]).unlabeled_wrong).toBe(1);
  });

  test('judged axes: a judge error is an execution error', () => {
    expect(category(axesFromJudged({ answerable: true, judgeCorrect: null, label: 'confident' }))).toBe('execution_error');
    expect(category(axesFromJudged({ answerable: true, judgeCorrect: false, label: 'hedged' }))).toBe('committed_wrong');
    expect(category(axesFromJudged({ answerable: true, judgeCorrect: false, label: 'abstain' }))).toBe('abstained');
  });
});

describe('mutation properties', () => {
  test('adding a hedge cannot improve a wrong committed answer', () => {
    for (const a of all) {
      if (category(a) !== 'committed_wrong') continue;
      expect(category({ ...a, hedge: true })).toBe('committed_wrong');
      expect(summarize([{ ...a, hedge: true }]).failure_rate).toBe(summarize([a]).failure_rate);
    }
    const wrong = `Final answer: ${wrongHeadcount(headcount)}`;
    for (const hedged of [`I don't know for sure, but ${wrongHeadcount(headcount)}.`, `${wrong}, though I'm not sure.`, `It is probably ${wrongHeadcount(headcount)}.`]) {
      const v3 = scoreA4V3(headcount, hedged, ledger.values, true);
      expect(category(v3)).toBe('committed_wrong');
      expect(v3.hedge).toBe(true);
    }
    expect(scoreAnswerV2(headcount, `I don't know for sure, but ${wrongHeadcount(headcount)}.`, ledger.values).outcome).toBe('abstain');
    const rejected = `I don't know. ${wrongHeadcount(headcount)} belongs to Other Example, not ${headcount.entity}.`;
    expect(category(scoreA4V3(headcount, rejected, ledger.values, true))).toBe('abstained');
  });

  test('appending a wrong action cannot preserve a pure abstention', () => {
    expect(category(scoreA4V3(headcount, IDK, ledger.values, true))).toBe('abstained');
    expect(category(scoreA4V3(missing, IDK, ledger.values, false))).toBe('correct');
    const appended = `${IDK} Anyway, the answer is ${wrongHeadcount(headcount)}.`;
    expect(category(scoreA4V3(headcount, appended, ledger.values, true))).toBe('committed_wrong');
    expect(category(scoreA4V3(missing, `${IDK} Anyway, ${wrongHeadcount(headcount)}.`, ledger.values, false))).toBe('committed_wrong');
    for (const a of all.filter(x => category(x) === 'abstained')) {
      expect(category({ ...a, commitment: 'committed' })).toBe('committed_wrong');
    }
  });

  test('execution errors cannot improve the failure rate and stay in the denominator', () => {
    const base = all.filter(a => !a.execution_error);
    const s0 = summarize(base);
    expect(s0.n).toBe(base.length);
    for (let i = 0; i < base.length; i++) {
      const mutated = base.map((a, k) => (k === i ? axes({ answerable: a.answerable, executionError: 'reader_failed' }) : a));
      const s1 = summarize(mutated);
      expect(s1.n).toBe(s0.n);
      expect(s1.failure_rate).toBeGreaterThanOrEqual(s0.failure_rate);
      expect(s1.correct).toBeLessThanOrEqual(s0.correct);
    }
  });

  test('the hedge axis reports nothing until validated', () => {
    const rows = [axes({ answerable: true, commitment: 'committed', correctness: 'correct', hedge: true }), axes({ answerable: true, commitment: 'committed', correctness: 'incorrect', hedge: true })];
    expect(summarize(rows).hedged_wrong).toBeNull();
    expect(summarize(rows).hedge_among_correct).toBeNull();
    expect(summarize(rows, true).hedged_wrong).toBe(1);
    expect(summarize(rows, true).hedge_among_correct).toBe(1);
  });
});

describe('historical scorers are immutable', () => {
  const source = readFileSync(join(ROOT, 'eval/runner/a4-abstention.ts'), 'utf8');
  const fnSha = (name: string) => {
    const start = source.indexOf(`export function ${name}(`);
    return createHash('sha256').update(source.slice(start, source.indexOf('\n}\n', start) + 3)).digest('hex');
  };
  test('scoreAnswer, scoreAnswerV2 and their patterns are pinned', () => {
    expect(fnSha('scoreAnswer')).toBe(PINNED.scoreAnswer);
    expect(fnSha('scoreAnswerV2')).toBe(PINNED.scoreAnswerV2);
    expect(fnSha('states')).toBe(PINNED.states);
    expect(fnSha('finalAnswer')).toBe(PINNED.finalAnswer);
    const region = source.slice(source.indexOf('export type Outcome'), source.indexOf('\n}\n', source.indexOf('export function scoreAnswerV2(')) + 3);
    expect(createHash('sha256').update(region).digest('hex')).toBe(PINNED.region);
  });

  const receipts = [
    'docs/benchmarks/2026-10-01-a4-abstention/receipt-paid-3a284ae.json',
    'docs/benchmarks/2026-10-06-a4-s4-on/receipt.json',
  ];
  for (const path of receipts) {
    test(`${path} rescores identically under the frozen rules`, () => {
      const r = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
      const world = generateA4World({ seed: r.resolved_config.seed }).ledger;
      const byId = new Map(world.questions.map(q => [q.id, q]));
      const answers: AnswerRow[] = r.data.paid.answers;
      expect(answers.length).toBeGreaterThan(0);
      const changes: string[] = [];
      for (const a of answers) {
        if (a.outcome === 'error') continue;
        const q = byId.get(a.id)!;
        expect(scoreAnswer(q, a.final, world.values).outcome).toBe(a.outcome);
        if (a.outcome_v2) expect(scoreAnswerV2(q, a.final, world.values).outcome).toBe(a.outcome_v2);
        const v3 = category(scoreA4V3(q, a.final, world.values, isAnswerable(q.cls)));
        const v2 = scoreAnswerV2(q, a.final, world.values).outcome;
        if (v3 !== v2CategoryOf(v2, isAnswerable(q.cls))) changes.push(`${v2}->${v3}`);
      }
      expect(changes.every(c => c === 'unscorable->correct')).toBe(true);
    });
  }
});

describe('judged label helpers', () => {
  test('parse and agreement', () => {
    expect(parseJudgedLabel('hedged')).toBe('hedged');
    expect(parseJudgedLabel('Label: Abstain.')).toBe('abstain');
    expect(parseJudgedLabel('no idea')).toBeNull();
    const pairs = [
      ...Array.from({ length: 9 }, () => ({ label: 'hedged' as const, predicted: 'hedged' as const })),
      { label: 'confident' as const, predicted: 'hedged' as const },
      ...Array.from({ length: 10 }, () => ({ label: 'abstain' as const, predicted: 'abstain' as const })),
    ];
    const ag = labelAgreement(pairs);
    expect(ag.per_class.hedged.precision).toBe(0.9);
    expect(passesHedgeBar(ag)).toBe(true);
    expect(passesHedgeBar(labelAgreement([...pairs, { label: 'confident', predicted: 'hedged' }]))).toBe(false);
  });
});

/** sha256 of the frozen source text (a4-abstention.ts); changing any of it changes how historical receipts score. */
const PINNED = {
  scoreAnswer: 'f59595765ae22c739fda4938b2e9cadce3f5ecc7764263e7ba4d92f798609b71',
  scoreAnswerV2: '3cac8eb25f5e9edd85ef967d8b72e59176854f07b1dd439f9408dc149a09172c',
  states: 'eb58f60d589b9b934ec88a489692574b1a26ea2b0283b2645350f529e4340ebf',
  finalAnswer: '6bdfb05d49ed1693477d79fb6cd6724ce41a21319ab0f4a6387e71e59e8d926c',
  region: '215eacbd04c0dc4ee0affb7ee993c8c5f66fdcbcd82cd1226f61e7bc9fc940d8',
};
