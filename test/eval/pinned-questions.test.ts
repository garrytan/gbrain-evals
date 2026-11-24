import { describe, expect, test } from 'bun:test';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { AFFECTED, CLAIMS, MUTATION_CLASSES, generatePinnedQuestionsWorld, type PqCompany } from '../../eval/generators/pinned-questions-gen.ts';
import { answerMatches, claimOf, claimSentence, oracleChat, runPinnedQuestions } from '../../eval/runner/pinned-questions.ts';
import { gbrainSpecFrom, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { confusion, exactConformance, summarize, wilson, type QuestionRow, type SentenceRow } from '../../eval/runner/pinned-questions-score.ts';

describe('pinned-questions generator', () => {
  test('same seed, same ledger; another seed, another ledger', () => {
    expect(generatePinnedQuestionsWorld({ seed: 1 }).fingerprint).toBe(generatePinnedQuestionsWorld({ seed: 1 }).fingerprint);
    expect(generatePinnedQuestionsWorld({ seed: 1 }).fingerprint).not.toBe(generatePinnedQuestionsWorld({ seed: 2 }).fingerprint);
  });

  test('every change class appears equally often and its gold matches AFFECTED', () => {
    const w = generatePinnedQuestionsWorld({ seed: 3 });
    for (const m of MUTATION_CLASSES) expect(w.companies.filter(c => c.mutation === m)).toHaveLength(3);
    for (const c of w.companies) {
      expect(c.affected).toEqual(AFFECTED[c.mutation]);
      for (const claim of CLAIMS) expect(c.after[claim] !== c.before[claim]).toBe(c.affected.includes(claim));
    }
  });

  test('claim values are unique tokens and every question asks all four claims', () => {
    const w = generatePinnedQuestionsWorld({ seed: 2 });
    const tokens = w.companies.flatMap(c => [c.name, c.before.city, c.before.flagship, c.before.ceo]);
    expect(new Set(tokens.map(t => t.toLowerCase())).size).toBe(tokens.length);
    for (const c of w.companies) for (const claim of CLAIMS) expect(claimOf(c, claimSentence(c, claim, 'X'))).toBe(claim);
  });

  test('companies must be a multiple of the change classes', () => {
    expect(() => generatePinnedQuestionsWorld({ seed: 1, companies: 10 })).toThrow(/multiple/);
  });
});

describe('pinned-questions oracle', () => {
  const w = generatePinnedQuestionsWorld({ seed: 1, companies: 8 });
  const c = w.companies[0]!;
  const prompt = (lines: string[]) => [`Question: ${c.question}`, '', 'Evidence:', ...lines.map((l, i) => `E${i + 1}: ${l}`)].join('\n');

  test('cites every line that states the value and names the company, and leaves out what the evidence lacks', async () => {
    const other = w.companies[1]!;
    const res = await oracleChat(w, () => 'before', new Map())({ model: 'm', system: '', maxTokens: 1, user: prompt([
      `[page ${c.slug}] ${c.name} builds ${c.product} in ${c.before.city}.`,
      `[page notes/x] ${c.name} again builds in ${c.before.city}.`,
      `[page ${other.slug}] ${other.name} was founded in ${c.before.founded}.`,
    ]) });
    const body = JSON.parse(res.text) as { sentences: Array<{ text: string; cite: string[] }>; gaps: string[] };
    expect(body.sentences).toEqual([{ text: claimSentence(c, 'city', c.before.city), cite: ['E1', 'E2'] }]);
    expect(body.gaps).toEqual(['flagship', 'ceo', 'founded']);
  });

  test('policy one cites a single line, a fact row first', async () => {
    const res = await oracleChat(w, () => 'before', new Map(), 'one')({ model: 'm', system: '', maxTokens: 1, user: prompt([
      `[page ${c.slug}] ${c.name} was founded in ${c.before.founded}.`,
      `[fact about ${c.slug}, from 2026-01-01] ${c.name} was founded in ${c.before.founded}.`,
    ]) });
    expect((JSON.parse(res.text) as { sentences: Array<{ cite: string[] }> }).sentences[0]!.cite).toEqual(['E2']);
  });

  test('answerMatches wants the new value fresh and the old value gone', () => {
    const m = w.companies.find(x => x.mutation === 'edit_claim_page')!;
    const s = (claim: (typeof CLAIMS)[number], v: string, stale = false) => ({ id: claim, text: claimSentence(m, claim, v), origin: 'model', stale, reasons: [] });
    const right = CLAIMS.map(k => s(k, m.after[k]!));
    expect(answerMatches(m, right)).toBe(true);
    expect(answerMatches(m, right.map(x => ({ ...x, stale: true })))).toBe(false);
    expect(answerMatches(m, [...right, s('city', m.before.city)])).toBe(false);
    const removed = w.companies.find(x => x.mutation === 'remove_source_page')!;
    const keepCeo = CLAIMS.map(k => ({ id: k, text: claimSentence(removed, k, removed.before[k]), origin: 'model', stale: false, reasons: [] }));
    expect(answerMatches(removed, keepCeo)).toBe(false);
    expect(answerMatches(removed, keepCeo.filter(x => x.id !== 'ceo'))).toBe(true);
  });
});

function goldRows(companies: readonly PqCompany[]): { sentences: SentenceRow[]; questions: QuestionRow[] } {
  const sentences: SentenceRow[] = companies.flatMap(c => CLAIMS.map(claim => ({
    seed: 1, company: c.slug, mutation: c.mutation, claim, text: claimSentence(c, claim, c.before[claim]), cites: [],
    affected: c.affected.includes(claim), flagged: c.affected.includes(claim), reasons: [],
  })));
  const questions: QuestionRow[] = companies.map(c => ({
    seed: 1, company: c.slug, mutation: c.mutation, affected: [...c.affected], unanswered_at_pin: [], baseline_stale: 0,
    freshness: c.affected.length ? 'stale' : 'fresh', new_evidence: false, stale_sentences: c.affected.length,
    gold_signal: c.affected.length > 0, signalled: c.affected.length > 0, spillover: 0, cycles_to_correct: c.affected.length ? 1 : null, refreshes: 1,
  }));
  return { sentences, questions };
}

describe('pinned-questions scorer', () => {
  const w = generatePinnedQuestionsWorld({ seed: 1 });

  test('a hand-built perfect system conforms; a page-granularity system does not', () => {
    const { sentences, questions } = goldRows(w.companies);
    expect(exactConformance(sentences, questions).pass).toBe(true);
    const pageLevel = sentences.map(s => {
      const c = w.companies.find(x => x.slug === s.company)!;
      const pageEdited = c.mutation === 'edit_claim_page' || c.mutation === 'unrelated_edit_cited_page';
      return { ...s, flagged: s.flagged || (pageEdited && (s.claim === 'city' || s.claim === 'flagship')) };
    });
    const verdict = exactConformance(pageLevel, questions);
    expect(verdict.pass).toBe(false);
    expect(summarize(pageLevel, questions).by_class.unrelated_edit_cited_page!.flags.fp).toBe(6);
  });

  test('a broken adapter that never flags fails, and so does one that alarms other pins', () => {
    const { sentences, questions } = goldRows(w.companies);
    expect(exactConformance(sentences.map(s => ({ ...s, flagged: false })), questions.map(q => ({ ...q, signalled: false }))).pass).toBe(false);
    expect(exactConformance(sentences, questions.map((q, i) => (i === 0 ? { ...q, spillover: 3 } : q))).pass).toBe(false);
  });

  test('confusion, wilson and the class summary', () => {
    expect(confusion([{ affected: true, flagged: true }, { affected: false, flagged: true }, { affected: true, flagged: false }, { affected: false, flagged: false }]))
      .toEqual({ tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5, f1: 0.5, false_flag_rate: 0.5 });
    expect(wilson(0, 0)).toBeNull();
    const [lo, hi] = wilson(9, 10)!;
    expect(lo).toBeGreaterThan(0.59);
    expect(hi).toBeLessThan(0.99);
    const { sentences, questions } = goldRows(w.companies);
    const s = summarize(sentences, questions);
    expect(s.overall.flags.recall).toBe(1);
    expect(s.contradiction.tp).toBe(6);
    expect(s.by_class.edit_claim_page!.median_cycles_to_correct).toBe(1);
  });

  test('the scorer rejects the five fake systems', () => {
    const { sentences, questions } = goldRows(w.companies);
    const others = new Map(sentences.map((s, i) => [i, sentences.find(o => o.claim === s.claim && o.affected !== s.affected)?.affected]));
    assertScorerRejectsFakeSystems<number, boolean>({
      category: 'pinned-questions',
      probes: sentences.map((_, i) => i),
      space: {
        truth: i => sentences[i]!.affected,
        empty: () => false,
        everything: () => true,
        refusal: () => false,
        stale: () => false,
        wrongSource: i => others.get(i),
      },
      score: answers => exactConformance(sentences.map((s, i) => ({ ...s, flagged: answers[i]! })), questions),
    });
  });
});

describe('pinned-questions runner on the pinned gbrain', () => {
  test('one small seed runs end to end: every claim answered at pin, nothing flagged before a change, deletions flagged', async () => {
    const r = await runPinnedQuestions({ gut: resolveGbrainUnderTest(gbrainSpecFrom([])), seeds: [1], companies: 8, cycles: 2 });
    expect(r.harnessError).toBeNull();
    expect(r.questions).toHaveLength(8);
    const s = summarize(r.sentences, r.questions);
    expect(s.unanswered_at_pin).toBe(0);
    expect(s.baseline_false_flags).toBe(0);
    expect(s.by_class.remove_source_page!.flags.recall).toBe(1);
    expect(r.sentences).toHaveLength(32);
  }, 120_000);
});
