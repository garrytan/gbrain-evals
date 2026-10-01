/**
 * N2 contradiction surfacing: scorer tests with hand-built gold, the scorer
 * mutation suites, a broken system the category must fail, and a small
 * PGLite run through gbrain's real probe.
 */
import { describe, expect, test } from 'bun:test';
import { registryEntry } from '../../eval/registry.ts';
import { evaluatePromotion } from '../../eval/runner/promotion.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { generateN2World, n2Gold, pairKey, type N2Item } from '../../eval/generators/n2-contradiction-gen.ts';
import {
  oracleVerdict, proposalAcceptable, runHermetic, safetyFrom, scoreCandidates, scoreClassification, verdictClass,
  type Judgment, type Verdict,
} from '../../eval/runner/n2-contradiction-surfacing.ts';

const { ledger } = generateN2World();
const gold = n2Gold(ledger);
const rules = registryEntry('N2')!.promotion!;

function judgment(it: N2Item, verdict: Verdict | null, opts: { error?: string; kind?: string; command?: string } = {}): Judgment {
  return {
    query: it.query, query_item: it.id, a: it.a.slug, b: it.b.slug, key: pairKey(it.a.slug, it.b.slug),
    gold: gold({ slug: it.a.slug, text: it.a.body }, { slug: it.b.slug, text: it.b.body }),
    verdict, error: opts.error ?? null, dates_seen: [it.a.date, it.b.date],
    ...(opts.kind ? { resolution_kind: opts.kind, resolution_command: opts.command ?? '' } : {}),
  };
}
const truthVerdict = (it: N2Item): Verdict => oracleVerdict(gold({ slug: it.a.slug, text: it.a.body }, { slug: it.b.slug, text: it.b.body }), it);

describe('N2 classification scorer', () => {
  test('an oracle judge separates conflicts from dated changes; e2e recall counts every planted conflict', () => {
    const s = scoreClassification(ledger, ledger.items.map(it => judgment(it, truthVerdict(it))));
    expect(s.e2e_conflict_recall).toEqual({ n: 150, hits: 150, rate: 1 });
    expect(s.decision.separates).toBe(true);
  });

  test('missed pairs stay in the end-to-end denominator', () => {
    const half = ledger.items.filter((it, i) => it.gold_class !== 'contradiction' || i % 2 === 0);
    const s = scoreClassification(ledger, half.map(it => judgment(it, truthVerdict(it))));
    expect(s.e2e_conflict_recall.n).toBe(150);
    expect(s.e2e_conflict_recall.hits).toBe(75);
    expect(s.classification_recall_offered_conflicts.rate).toBe(1);
  });

  test('a judge that calls dated changes contradictions fails the decision rule (negative)', () => {
    const s = scoreClassification(ledger, ledger.items.map(it => judgment(it, it.gold_class === 'temporal' ? 'contradiction' : truthVerdict(it))));
    expect(s.decision.separates).toBe(false);
    expect(s.decision.failed_rules).toEqual(['false-contradiction rate on offered dated changes > 0.10']);
    expect(s.false_contradiction_dated_changes.rate).toBe(1);
  });

  test('judge errors are counted, never read as no contradiction', () => {
    const s = scoreClassification(ledger, ledger.items.map(it => judgment(it, null, { error: 'boom' })));
    expect(s.judge_errors.hits).toBe(270);
    expect(s.classification_recall_offered_conflicts.hits).toBe(0);
    expect(s.false_contradiction_compatible.hits).toBe(0);
  });

  test('verdict classes and proposal acceptability follow the preregistered rules', () => {
    expect(verdictClass('temporal_regression')).toBe('temporal');
    expect(verdictClass('negation_artifact')).toBe('not_contradiction');
    expect(proposalAcceptable('contradiction', 'manual_review', '# manual review: a vs b', null)).toBe(true);
    expect(proposalAcceptable('contradiction', 'temporal_supersede', '# temporal_supersession: a (2025-01-01) superseded by 2025-06-01', null)).toBe(false);
    expect(proposalAcceptable('temporal', 'temporal_supersede', '# temporal_supersession: notes/x (2025-01-01) superseded by 2025-06-01', 'notes/x')).toBe(true);
    expect(proposalAcceptable('temporal', 'temporal_supersede', '# temporal_supersession: notes/y (2025-01-01) superseded by 2025-06-01', 'notes/x')).toBe(false);
    expect(proposalAcceptable('temporal', 'temporal_supersede', '# temporal_supersession: notes/x vs notes/y (date order unclear)', 'notes/x')).toBe(false);
  });
});

describe('N2 scorer mutation suites', () => {
  const other = (it: N2Item) => ledger.items.find(x => x.gold_class !== it.gold_class)!;
  test('classification: the decision rule rejects empty, always-contradiction, never-contradiction, date-blind and wrong-item judges', () => {
    assertScorerRejectsFakeSystems<N2Item, Verdict | null>({
      category: 'N2 classification',
      probes: ledger.items,
      space: {
        truth: truthVerdict,
        empty: () => null,
        everything: () => 'contradiction',
        refusal: () => 'no_contradiction',
        stale: it => (it.gold_class === 'temporal' ? 'contradiction' : undefined),
        wrongSource: it => truthVerdict(other(it)),
      },
      score: answers => {
        const s = scoreClassification(ledger, ledger.items.map((it, i) => (answers[i] === null ? judgment(it, null, { error: 'no answer' }) : judgment(it, answers[i]))));
        return { pass: s.decision.separates, detail: s.decision.failed_rules.join('; ') || 'separates' };
      },
    });
  });

  test('candidate gate: the preregistered rules reject a probe that offers nothing or the wrong pairs', () => {
    const conflicts = ledger.items.filter(i => i.gold_class === 'contradiction');
    assertScorerRejectsFakeSystems<N2Item, 'own' | 'none' | 'other'>({
      category: 'N2 candidate gate',
      probes: conflicts,
      space: { truth: () => 'own', empty: () => 'none', everything: () => 'own', refusal: () => 'none', wrongSource: () => 'other' },
      notApplicable: {
        'always-positive': 'offering every pair is what an ideal candidate stage does; the floor bounds utility, and false contradictions are scored in the classification stage',
        stale: 'the candidate stage has no time axis',
      },
      score: answers => {
        const judgments: Judgment[] = [];
        conflicts.forEach((it, i) => {
          if (answers[i] === 'own') judgments.push(judgment(it, 'no_contradiction'));
          if (answers[i] === 'other') { const x = ledger.items.find(y => y.gold_class === 'compatible')!; judgments.push({ ...judgment(x, 'no_contradiction'), query_item: it.id }); }
        });
        const receipt = { data: { candidate: scoreCandidates(ledger, new Map(), judgments), safety: safetyFrom({ offered: 1, judge_errors: 1, verdicts: 0, findings: 0 }, []) } };
        const o = evaluatePromotion(rules, receipt);
        return { pass: o.pass, detail: `recall ${receipt.data.candidate.conflict_recall}` };
      },
    });
  });
});

describe('N2 broken systems fail the safety contracts', () => {
  const okCandidate = scoreCandidates(ledger, new Map(), ledger.items.map(it => judgment(it, 'no_contradiction')));
  test('a probe that changes a page fails probe-never-mutates', () => {
    const o = evaluatePromotion(rules, { data: { candidate: okCandidate, safety: safetyFrom({ offered: 10, judge_errors: 10, verdicts: 0, findings: 0 }, ['notes/n2-i001-a']) } });
    expect(o.failures.map(f => f.id)).toEqual(['probe-never-mutates']);
  });
  test('a runner that turns a judge exception into no_contradiction fails judge-error-not-a-verdict', () => {
    const o = evaluatePromotion(rules, { data: { candidate: okCandidate, safety: safetyFrom({ offered: 10, judge_errors: 7, verdicts: 3, findings: 0 }, []) } });
    expect(o.failures.map(f => f.id)).toEqual(['judge-error-not-a-verdict']);
  });
  test('the honest controls pass every rule', () => {
    expect(evaluatePromotion(rules, { data: { candidate: okCandidate, safety: safetyFrom({ offered: 10, judge_errors: 10, verdicts: 0, findings: 0 }, []) } }).pass).toBe(true);
  });
});

describe('N2 on PGLite through gbrain\'s probe (small world)', () => {
  test('presence holds, nothing is mutated, judge errors stay errors, undated pages reach the judge with a date', async () => {
    const world = generateN2World({ seed: 11, counts: { same_time_conflict: 6, dated_change: 3, holder_opinion: 1, agreement: 1, namesake: 1, negation: 1 } });
    const r = await runHermetic(resolveGbrainUnderTest(null), world, { amara: false });
    expect(r.harness_error).toBeNull();
    expect(r.presence.every(p => p.ok)).toBe(true);
    expect(r.safety!.applied_mutations).toBe(0);
    expect(r.safety!.judge_errors_counted_as_verdicts).toBe(0);
    expect(r.candidate!.conflicts_total).toBe(6);
    expect(r.find_contradictions!.local_default_scope_cli).toMatchObject({ returned: 0 });
    expect((r.date_signal as { undated_shown_with_a_date: number }).undated_shown_with_a_date).toBeGreaterThan(0);
  }, 120_000);
});

