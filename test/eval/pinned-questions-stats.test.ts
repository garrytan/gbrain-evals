import { describe, expect, test } from 'bun:test';
import { generatePinnedQuestionsWorld } from '../../eval/generators/pinned-questions-gen.ts';
import { refreshComparisons, type PaidRow } from '../../eval/runner/pinned-questions-paid.ts';
import { flagIntervals, pairedRecall, summarize, type SentenceRow } from '../../eval/runner/pinned-questions-score.ts';
import { clusterBootstrap, clustersBy, comparisonFamily, holm, mcnemarExact, pairedComparison } from '../../eval/runner/pinned-questions-stats.ts';

const width = (ci: [number, number] | null) => ci![1] - ci![0];

describe('pinned-questions analysis: tests and corrections', () => {
  test('exact McNemar matches the binomial tail', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(3, 3)).toBe(1);
    expect(mcnemarExact(0, 10)).toBeCloseTo(2 / 1024, 12);
    expect(mcnemarExact(2, 8)).toBeCloseTo(2 * 56 / 1024, 12);
    expect(mcnemarExact(8, 2)).toBe(mcnemarExact(2, 8));
  });

  test('Holm adjusts step-down and keeps the input order', () => {
    expect(holm([0.01, 0.04, 0.03]).map(p => Number(p.toFixed(10)))).toEqual([0.03, 0.06, 0.06]);
    expect(holm([0.5, 0.9])).toEqual([1, 1]);
  });
});

describe('pinned-questions analysis: cluster bootstrap', () => {
  test('is seeded, and resampling whole questions widens the interval when sentences in a question move together', () => {
    const clustered = Array.from({ length: 40 }, (_, i) => Array.from({ length: 4 }, () => i % 4 !== 0));
    const mean = (rows: readonly boolean[]) => (rows.length ? rows.filter(Boolean).length / rows.length : null);
    const a = clusterBootstrap(clustered, mean, 2000, 7), b = clusterBootstrap(clustered, mean, 2000, 7);
    expect(a).toEqual(b);
    const independent = clusterBootstrap(clustered.flat().map(x => [x]), mean, 2000, 7);
    expect(width(a)).toBeGreaterThan(1.5 * width(independent));
    expect(clusterBootstrap([], mean)).toBeNull();
    expect(clusterBootstrap([[true], [true]], mean, 100)).toEqual([1, 1]);
  });

  test('the K summary reports registered intervals per class and for the two families', () => {
    const w = generatePinnedQuestionsWorld({ seed: 1, companies: 8 });
    const sentences: SentenceRow[] = w.companies.flatMap((c, i) => (['city', 'flagship', 'ceo', 'founded'] as const).map(claim => ({
      seed: 1, company: c.slug, mutation: c.mutation, claim, text: '', cites: [], affected: c.affected.includes(claim), flagged: c.affected.includes(claim) ? i % 3 !== 0 : false, reasons: [],
    })));
    const s = summarize(sentences, []);
    expect(s.overall.flags_ci).toMatchObject({ clusters: 8, draws: 10_000 });
    expect(s.overall.recall_ci).toEqual(s.overall.flags_ci.recall);
    expect(s.overall.recall_ci![0]).toBeLessThan(s.overall.flags.recall!);
    expect(s.documented_ci.clusters + s.contradiction_ci.clusters).toBe(8);
    expect(flagIntervals(sentences.filter(x => x.mutation === w.companies[0]!.mutation)).clusters).toBeGreaterThan(0);
    expect(clustersBy(sentences, x => x.company)).toHaveLength(8);
  });
});

describe('pinned-questions analysis: paired comparisons', () => {
  test('a paired comparison gives the difference, its interval over pairs and McNemar on the discordant pairs', () => {
    const pairs = [...Array(30).fill({ a: true, b: true }), ...Array(10).fill({ a: false, b: false }), ...Array(2).fill({ a: true, b: false }), ...Array(8).fill({ a: false, b: true })];
    const c = pairedComparison(pairs, 2000);
    expect([c.pairs, c.only_a, c.only_b, c.rate_a, c.rate_b, c.difference]).toEqual([50, 2, 8, 0.64, 0.76, 0.12]);
    expect(c.mcnemar_p).toBeCloseTo(mcnemarExact(2, 8), 12);
    expect(c.difference_ci![0]).toBeLessThan(0.12);
    expect(c.difference_ci![1]).toBeGreaterThan(0.12);
  });

  test('a family is Holm-corrected, and non-inferiority reads the lower bound against -10 points', () => {
    const same = pairedComparison(Array(200).fill({ a: true, b: true }), 500);
    const worse = pairedComparison([...Array(100).fill({ a: true, b: false }), ...Array(100).fill({ a: true, b: true })], 500);
    const f = comparisonFamily({ same, worse });
    expect([f.same!.non_inferior, f.worse!.non_inferior]).toEqual([true, false]);
    expect(f.worse!.holm_p).toBeCloseTo(Math.min(1, 2 * worse.mcnemar_p), 12);
    expect(f.worse!.significant).toBe(true);
    expect(f.same!.significant).toBe(false);
  });

  test('P comparisons pair each model with Opus by question, leave out unscored questions, and need Opus to have run', () => {
    const row = (model: string, company: string, correct: boolean | null) => ({ model, seed: 11, company, correct }) as unknown as PaidRow;
    const rows = ['a', 'b', 'c', 'd'].flatMap((c, i) => [row('anthropic:claude-opus-5-5', c, i !== 3 ? true : null), row('particle:particle-1', c, i % 2 === 0), row('openai:gpt-6.2-sol', c, true)]);
    const cmp = refreshComparisons(rows) as Record<string, { pairs: number; only_a: number; difference: number }>;
    expect(Object.keys(cmp)).toEqual(['particle:particle-1', 'openai:gpt-6.2-sol']);
    expect([cmp['particle:particle-1']!.pairs, cmp['particle:particle-1']!.only_a]).toEqual([3, 1]);
    expect(cmp['openai:gpt-6.2-sol']!.difference).toBe(0);
    expect(refreshComparisons(rows.filter(r => r.model !== 'anthropic:claude-opus-5-5'))).toEqual({});
  });

  test('the fix build is paired with the baseline by sentence on the classes the decision rule names', () => {
    const s = (company: string, claim: 'city' | 'ceo', flagged: boolean, mutation: SentenceRow['mutation'] = 'edit_claim_page'): SentenceRow => ({ seed: 11, company, mutation, claim, text: '', cites: [], affected: true, flagged, reasons: [] });
    const base = [s('a', 'city', false), s('b', 'city', true), s('c', 'ceo', false, 'contradict_existing_page')];
    const fix = [s('a', 'city', true), s('b', 'city', true), s('c', 'ceo', true, 'contradict_existing_page')];
    const r = pairedRecall(base, fix, ['edit_claim_page', 'edit_claim_fact', 'remove_source_page']);
    expect([r.pairs, r.only_a, r.only_b, r.rate_a, r.rate_b]).toEqual([2, 0, 1, 0.5, 1]);
  });
});
