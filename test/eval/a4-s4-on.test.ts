/**
 * G8: the A4 S4-on arm (S4 verdicts gating the retrieved-arm reader), the
 * revised A4-4 abstention rule and the report-only threshold sweep.
 */
import { describe, expect, test } from 'bun:test';
import {
  ABSTAIN_RE, ABSTAIN_RE_V2, S4_CONFIG, armMetrics, s4OnOutcomes, s4Sweep, scoreAnswer, scoreAnswerV2,
  type AnswerRow, type Retrieval, type S4Row,
} from '../../eval/runner/a4-abstention.ts';

const q = { attribute: 'headcount', answer: null, sibling_value: '42 employees' } as never;
const values = { headcount: ['42 employees', '17 employees'] };

describe('A4-4 revised abstention rule', () => {
  test('a refusal that names another company only as context is an abstention under v2, wrong_source under the frozen rule', () => {
    const text = 'Final answer: The notes do not mention the headcount of Brightline; only Acme Example is listed, with 42 employees.';
    expect(scoreAnswer(q, text, values).outcome).toBe('wrong_source');
    expect(scoreAnswerV2(q, text, values).outcome).toBe('abstain');
  });

  test('"I don\'t have the information" is an abstention under v2 only', () => {
    const text = "Final answer: I don't have the information needed to answer this.";
    expect(ABSTAIN_RE.test(text)).toBe(false);
    expect(ABSTAIN_RE_V2.test(text)).toBe(true);
    expect(scoreAnswerV2(q, text, values).outcome).toBe('abstain');
  });

  test('a stated wrong value without an abstention stays wrong_source; a correct answer stays correct', () => {
    expect(scoreAnswerV2(q, 'Final answer: 42 employees.', values).outcome).toBe('wrong_source');
    const answerable = { attribute: 'headcount', answer: '17 employees', sibling_value: null } as never;
    expect(scoreAnswerV2(answerable, 'Final answer: 17 employees.', values).outcome).toBe('correct');
  });
});

describe('S4-on arm', () => {
  const answers: AnswerRow[] = [
    { id: 'a1', cls: 'answerable_profile', arm: 'retrieved', outcome: 'correct', outcome_v2: 'correct', final: '', hedged: false },
    { id: 'u1', cls: 'missing_attribute', arm: 'retrieved', outcome: 'wrong_source', outcome_v2: 'abstain', final: '', hedged: true },
    { id: 'u2', cls: 'absent_entity', arm: 'retrieved', outcome: 'wrong', outcome_v2: 'wrong', final: '', hedged: false },
    { id: 'u2', cls: 'absent_entity', arm: 'oracle', outcome: 'abstain', final: '', hedged: false },
  ];
  const s4: S4Row[] = [
    { id: 'a1', cls: 'answerable_profile', asked: true, k_used: 5, p: 0.9, verdict: 'pass' },
    { id: 'u1', cls: 'missing_attribute', asked: true, k_used: 5, p: 0.6, verdict: 'pass' },
    { id: 'u2', cls: 'absent_entity', asked: true, k_used: 5, p: 0.1, verdict: 'abstain' },
  ];

  test('S4 abstain replaces the retrieved answer; other verdicts keep it; the oracle arm is ignored', () => {
    expect(s4OnOutcomes(answers, s4, 'v2').map(o => o.outcome)).toEqual(['correct', 'abstain', 'abstain']);
    expect(s4OnOutcomes(answers, s4, 'v1').map(o => o.outcome)).toEqual(['correct', 'wrong_source', 'abstain']);
  });

  test('the sweep re-reduces recorded probabilities with the identity and strong-grade signals', () => {
    const rows = [
      { id: 'a1', cls: 'answerable_profile', evidence: [{}, {}, {}, {}, {}], s4: { asked: true, identity_hit: false, strong_grade: false } },
      { id: 'u1', cls: 'missing_attribute', evidence: [{}, {}, {}, {}, {}], s4: { asked: true, identity_hit: true, strong_grade: false } },
      { id: 'u2', cls: 'absent_entity', evidence: [{}, {}, {}, {}, {}], s4: { asked: true, identity_hit: false, strong_grade: false } },
    ] as unknown as Retrieval[];
    const [low, high] = s4Sweep(answers, s4, rows, [0.05, 0.99]);
    expect(low!.abstain_recall).toBe(armMetrics(s4OnOutcomes(answers, s4.map(r => ({ ...r, verdict: 'pass' as const })), 'v2')).abstain_recall);
    expect(high!.false_refusal_rate).toBe(1);
  });

  test('the decide config allows TypeSafe egress only for query and candidate text, with an explicit threshold and force_on', () => {
    expect(S4_CONFIG(0.5)).toMatchObject({ 'decide.slots.answerable.threshold': '0.5', 'decide.slots.answerable.force_on': 'true', 'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow' });
  });
});
