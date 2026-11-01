/**
 * A4 abstention: answer-scorer tests with hand-built answers, the scorer
 * mutation suites, broken retrieval the category must fail, and a small
 * PGLite run through the query operation.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { registryEntry } from '../../eval/registry.ts';
import { evaluatePromotion } from '../../eval/runner/promotion.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { generateA4World, isAnswerable, type A4Question } from '../../eval/generators/a4-abstention-gen.ts';
import {
  abstainsUsefully, armMetrics, cragSummary, finalAnswer, gated, retrieveAll, s4Summary, scoreAnswer, states,
  type AnswerRow, type Retrieval,
} from '../../eval/runner/a4-abstention.ts';

const { ledger } = generateA4World();
const rules = registryEntry('A4')!.promotion!;
const IDK = 'The information is not available in the retrieved sessions; I don\'t know.';
const otherValue = (q: A4Question) => q.sibling_value ?? ledger.values[q.attribute].find(v => v !== q.answer)!;

describe('A4 answer scorer', () => {
  const q = (id: string) => ledger.questions.find(x => x.id === id)!;
  const answerable = ledger.questions.find(x => x.cls === 'answerable_profile' && x.attribute === 'headcount')!;
  const sibling = ledger.questions.find(x => x.cls === 'sibling_attribute')!;

  test('final answer is taken after the last marker, else the last paragraph', () => {
    expect(finalAnswer('Notes: X has 5 employees.\n\nFinal answer: 7 employees')).toBe('7 employees');
    expect(finalAnswer('notes line\n\nThe answer is 12.')).toBe('The answer is 12.');
  });

  test('numbers match with thousands separators and units; another company\'s value is wrong-source', () => {
    const n = answerable.answer!.replace(' employees', '');
    const withComma = n.length > 3 ? `${n.slice(0, -3)},${n.slice(-3)}` : n;
    expect(scoreAnswer(answerable, `Final answer: ${withComma} employees`, ledger.values).outcome).toBe('correct');
    expect(states(`about ${n} people`, 'headcount', answerable.answer!)).toBe(true);
    expect(scoreAnswer(sibling, `Final answer: ${sibling.sibling_value}`, ledger.values).outcome).toBe('wrong_source');
    expect(scoreAnswer(answerable, 'Final answer: 99999 employees', ledger.values).outcome).toBe('wrong');
  });

  test('an abstention with no value is abstain; a hedged guess with a value counts as an answer (negative)', () => {
    expect(scoreAnswer(sibling, IDK, ledger.values).outcome).toBe('abstain');
    const hedged = scoreAnswer(sibling, `I don't know for sure, but probably ${sibling.sibling_value}.`, ledger.values);
    expect(hedged).toMatchObject({ outcome: 'wrong_source', hedged: true });
    expect(scoreAnswer(q('q001'), 'Final answer: somewhere nice', ledger.values).outcome).toBe('unscorable');
  });

  test('metrics follow the preregistered denominators; risk is null at zero coverage', () => {
    const allIdk = armMetrics(ledger.questions.map(x => ({ cls: x.cls, outcome: 'abstain' as const })));
    expect(allIdk.coverage).toBe(0);
    expect(allIdk.risk).toBeNull();
    expect(allIdk.false_refusal_rate).toBe(1);
    expect(abstainsUsefully(allIdk).pass).toBe(false);
  });

  test('the CRAG-gated reader abstains below the gate level', () => {
    const answers: AnswerRow[] = [{ id: 'q001', cls: 'answerable_profile', arm: 'retrieved', outcome: 'correct', final: '', hedged: false }];
    const rs = [{ id: 'q001', grade: 'moderate' }] as Retrieval[];
    expect(gated(answers, rs, 'strong')[0].outcome).toBe('abstain');
    expect(gated(answers, rs, 'moderate')[0].outcome).toBe('correct');
  });
});

describe('A4 scorer mutation suites', () => {
  test('answer decision rule rejects empty, answer-everything, refuse-everything and wrong-company readers', () => {
    assertScorerRejectsFakeSystems<A4Question, string>({
      category: 'A4 answers',
      probes: ledger.questions,
      space: {
        truth: x => (x.answer ? `Notes.\n\nFinal answer: ${x.answer}` : IDK),
        empty: () => '',
        everything: x => `Final answer: ${x.answer ?? otherValue(x)}`,
        refusal: () => IDK,
        wrongSource: x => `Final answer: ${otherValue(x)}`,
      },
      notApplicable: { stale: 'A4 facts have no history, so there is no earlier value to answer with' },
      score: answers => {
        const m = armMetrics(ledger.questions.map((x, i) => ({ cls: x.cls, outcome: scoreAnswer(x, answers[i], ledger.values).outcome })));
        const d = abstainsUsefully(m);
        return { pass: d.pass, detail: d.failed.join('; ') || 'abstains usefully' };
      },
    });
  });

  test('hermetic gate rejects retrieval that returns nothing or the wrong company\'s page', () => {
    const answerable = ledger.questions.filter(x => isAnswerable(x.cls));
    const body = (slug: string) => ledger.pages.find(p => p.slug === slug)!.body;
    const wrongPage = (x: A4Question) => ledger.pages.find(p => p.entity !== x.entity && p.facts.some(f => f.attribute === x.attribute))!.body;
    assertScorerRejectsFakeSystems<A4Question, string[]>({
      category: 'A4 hermetic gate',
      probes: answerable,
      space: { truth: x => [body(x.answer_slug!)], empty: () => [], everything: x => [body(x.answer_slug!)], refusal: () => [], wrongSource: x => [wrongPage(x)] },
      notApplicable: {
        'always-positive': 'the floor bounds utility only; the query operation returns at most five results, so it cannot return every page, and retrieval precision is not a contract the grade or the op states',
        stale: 'A4 facts have no history',
      },
      score: answers => {
        const rows: Retrieval[] = answerable.map((x, i) => ({ id: x.id, cls: x.cls, grade: answers[i].length ? 'moderate' : 'weak', reason: null, slugs: [], texts: answers[i], sufficient: answers[i].some(t => t.includes(x.answer!)), s4: { asked: answers[i].length > 0, identity_hit: false, strong_grade: false } }));
        const o = evaluatePromotion(rules, { data: { crag: cragSummary(rows) } });
        return { pass: o.pass, detail: JSON.stringify(o.failures.map(f => f.id)) };
      },
    });
  });
});

describe('A4 broken retrieval fails the floor; a missing grade fails the meta contract', () => {
  const base = (over: Partial<Retrieval>): Retrieval => ({ id: 'x', cls: 'answerable_profile', grade: 'moderate', reason: null, slugs: [], texts: [], sufficient: true, s4: { asked: true, identity_hit: false, strong_grade: false }, ...over });
  test('no answer text in results', () => {
    expect(evaluatePromotion(rules, { data: { crag: cragSummary([base({ sufficient: false })]) } }).failures.map(f => f.id)).toEqual(['answerable-evidence-floor']);
  });
  test('a response without a crag block', () => {
    expect(evaluatePromotion(rules, { data: { crag: cragSummary([base({ grade: null })]) } }).failures.map(f => f.id)).toEqual(['crag-meta-every-call']);
  });
  test('S4 is blocked by an identity hit or a strong grade, and never asked without evidence', () => {
    const s = s4Summary([base({ cls: 'missing_attribute', s4: { asked: true, identity_hit: false, strong_grade: true } }), base({ cls: 'absent_entity', s4: { asked: false, identity_hit: false, strong_grade: false } })]);
    expect([s.blocked_from_abstaining, s.not_asked_no_evidence]).toEqual([1, 1]);
  });
});

describe('A4 on PGLite through the query operation (small world)', () => {
  test('every call carries a grade and answerable questions retrieve their answer', async () => {
    const small = generateA4World({ seed: 5, counts: { answerable_profile: 3, answerable_note: 3, missing_attribute: 2, sibling_attribute: 2, absent_entity: 2 } }).ledger;
    const r = await retrieveAll(resolveGbrainUnderTest(null), small, () => {});
    expect(r.presence.every(p => p.ok)).toBe(true);
    const c = cragSummary(r.rows);
    expect(c.meta_coverage).toBe(1);
    expect(c.answerable_evidence_rate).toBeGreaterThan(0);
    expect(r.rows.find(x => x.cls === 'missing_attribute')!.lookup!.grade).toBe('strong');
  }, 120_000);
});

describe('A4 reader stop reasons (#238)', () => {
  const missing = ledger.questions.find(x => x.cls === 'missing_attribute')!;
  const answerable = ledger.questions.find(x => x.cls === 'answerable_profile' && x.attribute === 'headcount')!;
  // A Sonnet 5.5 answer cut off at the 1,024-token limit while it was still reading the evidence.
  const cutOff = `Looking at the retrieved notes, the profile for ${missing.entity} does not mention its ${missing.attribute}. Let me check whether a later session`;

  test('a finished answer keeps its stop reason; its abstention is an abstention', async () => {
    const { scoreReaderAnswer } = await import('../../eval/runner/a4-abstention.ts');
    expect(scoreReaderAnswer(missing, IDK, 'end', ledger.values)).toMatchObject({ outcome: 'abstain', outcome_v2: 'abstain', stop_reason: 'end', truncated: false });
  });

  test('an answer cut off at its output limit is scored as the model\'s answer and flagged; a cut-off abstention is not a deliberate abstention', async () => {
    const { scoreReaderAnswer } = await import('../../eval/runner/a4-abstention.ts');
    expect(scoreAnswer(missing, cutOff, ledger.values).outcome).toBe('abstain');
    expect(scoreReaderAnswer(missing, cutOff, 'length', ledger.values)).toMatchObject({ outcome: 'unscorable', outcome_v2: 'unscorable', stop_reason: 'length', truncated: true });
    expect(scoreReaderAnswer(answerable, `Final answer: ${answerable.answer}`, 'length', ledger.values)).toMatchObject({ outcome: 'correct', truncated: true });
    expect(scoreReaderAnswer(answerable, '', 'length', ledger.values)).toMatchObject({ outcome: 'unscorable', truncated: true });
  });

  test('the paid summary counts truncations and stop reasons per arm', async () => {
    const { paidSummary } = await import('../../eval/runner/a4-abstention.ts');
    const row = (arm: 'retrieved' | 'oracle', stop_reason: string): AnswerRow => ({ id: answerable.id, cls: answerable.cls, arm, outcome: 'unscorable', final: '', hedged: false, stop_reason, truncated: stop_reason === 'length' });
    const s = paidSummary([row('retrieved', 'length'), row('retrieved', 'end'), row('oracle', 'end')], []);
    expect(s.truncated).toEqual({ retrieved: 1, oracle: 0 });
    expect(s.stop_reasons).toEqual({ retrieved: { length: 1, end: 1 }, oracle: { end: 1 } });
  });

  test('a smoke reads the first questions of every class', async () => {
    const { paidQuestions } = await import('../../eval/runner/a4-abstention.ts');
    expect(paidQuestions(ledger, null)).toHaveLength(ledger.questions.length);
    const smoke = paidQuestions(ledger, 1);
    expect(smoke.map(x => x.cls).sort()).toEqual(['absent_entity', 'answerable_note', 'answerable_profile', 'missing_attribute', 'sibling_attribute']);
    expect(smoke.every(x => ledger.questions.find(y => y.cls === x.cls) === x)).toBe(true);
  });

  test('--smoke needs a number of questions per class and the paid reader, refused before any request', () => {
    const a4 = (...args: string[]) => spawnSync('bun', [join(import.meta.dir, '../../eval/runner/a4-abstention.ts'), ...args], { encoding: 'utf8', timeout: 60_000 });
    const bare = a4('--paid', '--smoke');
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain('--smoke needs a positive number of questions per class');
    const keyless = a4('--smoke', '2');
    expect(keyless.status).not.toBe(0);
    expect(keyless.stderr).toContain('pass it with --paid');
  });

  test('outcome-v3 rescoring reads a cut-off answer as an execution error, and the frozen check accepts its stored outcome', async () => {
    const { rescoreA4Receipt } = await import('../../eval/runner/outcomes/rescore-a4.ts');
    const answers: AnswerRow[] = [
      { id: missing.id, cls: missing.cls, arm: 'retrieved', outcome: 'unscorable', outcome_v2: 'unscorable', final: cutOff, hedged: false, stop_reason: 'length', truncated: true },
      { id: missing.id, cls: missing.cls, arm: 'oracle', outcome: 'abstain', outcome_v2: 'abstain', final: IDK, hedged: false, stop_reason: 'end', truncated: false },
    ];
    const out = rescoreA4Receipt({ resolved_config: { seed: 20261001 }, data: { paid: { answers } } });
    expect(out.retrieved.v3.execution_errors).toBe(1);
    expect(out.oracle.v3.execution_errors).toBe(0);
  });
});
