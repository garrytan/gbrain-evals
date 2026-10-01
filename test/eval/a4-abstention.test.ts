/**
 * A4 abstention: answer-scorer tests with hand-built answers, the scorer
 * mutation suites, broken retrieval the category must fail, and a small
 * PGLite run through the query operation.
 */
import { describe, expect, test } from 'bun:test';
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
