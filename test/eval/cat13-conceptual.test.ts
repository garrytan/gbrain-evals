/**
 * Cat 13 conceptual recall — hermetic regression suite.
 *
 * No API keys, no network: embeds (where an arm needs them) go through the
 * runner's __setEmbedTransportForTests seam; the e2e case runs the grep-only
 * arm, which needs neither embeds nor PGLite.
 *
 * What this suite pins (audit findings retrieval-cats-08 / -13 / -17):
 *   1. -13: CAT13_PROBES='5oo' THROWS instead of silently producing a
 *      0-probe run scored 0.0%; a corpus with no concept pages also throws.
 *   2. -17: probe sampling is a seeded Fisher-Yates — unbiased, exactly
 *      n-1 rng draws (runtime-independent), deterministic across calls.
 *   3. -08: semantic-neighborhood probe texts are globally unique and
 *      self-grounded (the grade-3 target IS the concept named in the text);
 *      company-seeded probes are one-per-company with every listing concept
 *      graded 3 and no slug tails in the query text. The uniqueness
 *      assertion CAN fail (constructed duplicate) and passes on the real
 *      generator output.
 *   4. Probe accounting: an adapter that throws on query is a sut failure
 *      scored 0 and kept in the denominator.
 *   5. GOOD INPUT: the full runner path (probes → adapter → metrics →
 *      report + receipt) completes hermetically and writes a valid receipt
 *      whose verdict follows the documented policy.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveTargetProbes,
  seededShuffle,
  mulberry32,
  loadCorpus,
  buildProbes,
  assertUniqueProbeTexts,
  DuplicateProbeTextError,
  scoreAdapter,
  computeCat13Verdict,
  runCat13,
  TOP_K,
  type Probe,
  type RichPage,
} from '../../eval/runner/cat13-conceptual.ts';
import { ProbeAccounting } from '../../eval/runner/probe-accounting.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';
import type { Adapter, Query, RankedDoc } from '../../eval/runner/types.ts';

const CORPUS_DIR = join(import.meta.dir, '..', '..', 'eval', 'data', 'world-v1');

// ─── CAT13_PROBES guard (finding retrieval-cats-13) ──────────────────

describe('cat13 CAT13_PROBES guard', () => {
  test("the old NaN path can now fail: '5oo' throws", () => {
    expect(() => resolveTargetProbes('5oo')).toThrow(/CAT13_PROBES/);
  });

  test('zero and negative values throw', () => {
    expect(() => resolveTargetProbes('0')).toThrow(/CAT13_PROBES/);
    expect(() => resolveTargetProbes('-100')).toThrow(/CAT13_PROBES/);
    expect(() => resolveTargetProbes('NaN')).toThrow(/CAT13_PROBES/);
  });

  test('good input: unset defaults to 500, numeric strings parse', () => {
    expect(resolveTargetProbes(undefined)).toBe(500);
    expect(resolveTargetProbes('')).toBe(500);
    expect(resolveTargetProbes('250')).toBe(250);
    expect(resolveTargetProbes('1000')).toBe(1000);
  });

  test('a corpus with no concept pages aborts instead of scoring 0 probes', () => {
    expect(() => buildProbes([], 500)).toThrow(/0 probes/);
  });
});

// ─── Seeded Fisher-Yates (finding retrieval-cats-17) ─────────────────

describe('cat13 seeded shuffle', () => {
  test('is a permutation and is deterministic for a fixed seed', () => {
    const input = Array.from({ length: 40 }, (_, i) => i);
    const a = seededShuffle(input, mulberry32(7));
    const b = seededShuffle(input, mulberry32(7));
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(input);
    expect(a).not.toEqual(input); // astronomically unlikely to be identity
  });

  test('consumes exactly n-1 rng draws (runtime-independent, unlike a sort comparator)', () => {
    let draws = 0;
    const counting = () => { draws++; return 0.5; };
    seededShuffle(Array.from({ length: 25 }, (_, i) => i), counting);
    expect(draws).toBe(24);
    draws = 0;
    seededShuffle([], counting);
    expect(draws).toBe(0);
    draws = 0;
    seededShuffle(['x'], counting);
    expect(draws).toBe(0);
  });

  test('does not mutate its input', () => {
    const input = [1, 2, 3, 4, 5];
    seededShuffle(input, mulberry32(1));
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });
});

// ─── Probe-text uniqueness (finding retrieval-cats-08) ───────────────

function fakeProbe(id: string, text: string, target: string): Probe {
  const q: Query = {
    id,
    tier: 'fuzzy',
    text,
    expected_output_type: 'cited-source-pages',
    gold: { grades: { [target]: 3 }, relevant: [target] },
  };
  return { q, targetSlugs: [target], template: 'test' };
}

describe('cat13 probe-text uniqueness', () => {
  test('the check CAN fail: duplicate texts with conflicting golds throw', () => {
    const probes = [
      fakeProbe('a', 'concepts related to fine-tuning', 'concepts/foundation-models'),
      fakeProbe('b', 'concepts related to fine-tuning', 'concepts/inference-cost'),
    ];
    expect(() => assertUniqueProbeTexts(probes)).toThrow(DuplicateProbeTextError);
  });

  test('case/whitespace variants of the same text also throw', () => {
    const probes = [
      fakeProbe('a', 'What is PMF', 'concepts/product-market-fit'),
      fakeProbe('b', '  what is pmf ', 'concepts/plg-motion'),
    ];
    expect(() => assertUniqueProbeTexts(probes)).toThrow(DuplicateProbeTextError);
  });

  test('unique texts pass', () => {
    expect(() => assertUniqueProbeTexts([
      fakeProbe('a', 'alpha', 'concepts/a'),
      fakeProbe('b', 'beta', 'concepts/b'),
    ])).not.toThrow();
  });
});

// ─── Generator on the real corpus (finding retrieval-cats-08) ────────

describe('cat13 buildProbes on world-v1', () => {
  const pages = loadCorpus(CORPUS_DIR);
  const { probes, gradesByQuery } = buildProbes(pages, 500);
  const bySlug = new Map(pages.map(p => [p.slug, p]));

  test('emits probes and every text is globally unique', () => {
    expect(probes.length).toBeGreaterThan(100);
    expect(() => assertUniqueProbeTexts(probes)).not.toThrow();
  });

  test('the old collision shape is gone: each neighborhood text appears once, self-grounded', () => {
    const sn = probes.filter(p => p.template === 'semantic-neighborhood');
    expect(sn.length).toBeGreaterThan(0);
    for (const p of sn) {
      // Text is "concepts related to <target's own name>" — the grade-3
      // target IS the named concept, never a neighbor with a conflicting gold.
      expect(p.targetSlugs.length).toBe(1);
      const target = bySlug.get(p.targetSlugs[0]) as RichPage;
      const name = (target._facts.name ?? target.title).toLowerCase();
      expect(p.q.text).toBe(`concepts related to ${name}`);
      const grades = gradesByQuery.get(p.q.id)!;
      expect(grades.get(p.targetSlugs[0])).toBe(3);
    }
  });

  test('company probes: one per company, every listing concept graded 3, no slug tails in text', () => {
    const cn = probes.filter(p => p.template === 'company-neighborhood');
    expect(cn.length).toBeGreaterThan(0);
    for (const p of cn) {
      // Query text uses the company display name, never the slug tail
      // (the old generator emitted 'discussing apex-18').
      expect(p.q.text).not.toMatch(/\b[a-z][a-z0-9-]*-\d+\b/);
      const grades = gradesByQuery.get(p.q.id)!;
      for (const slug of p.targetSlugs) expect(grades.get(slug)).toBe(3);
      // The company page itself is on-topic (grade 1), so retrieving it is
      // not scored as a miss.
      const companySlug = [...grades.entries()].find(([slug, g]) => g === 1 && slug.startsWith('companies/'));
      expect(companySlug).toBeDefined();
    }
    // A company listed by >1 concept yields ONE probe with a multi-target
    // gold, not N conflicting probes.
    const multi = cn.filter(p => p.targetSlugs.length > 1);
    expect(multi.length).toBeGreaterThan(0);
  });

  test('rerun produces the identical probe set (cross-call determinism)', () => {
    const again = buildProbes(pages, 500);
    expect(JSON.stringify(again.probes.map(p => [p.q.text, p.targetSlugs, p.template])))
      .toBe(JSON.stringify(probes.map(p => [p.q.text, p.targetSlugs, p.template])));
  });
});

// ─── Scoring + probe accounting ──────────────────────────────────────

class FixedAdapter implements Adapter {
  readonly name = 'fixed';
  constructor(private rankings: Record<string, string[]>) {}
  async init(): Promise<unknown> { return {}; }
  async query(q: { id: string }): Promise<RankedDoc[]> {
    return (this.rankings[q.id] ?? []).map((slug, i) => ({ page_id: slug, score: 1 - i * 0.1, rank: i + 1 }));
  }
}

class ThrowingAdapter implements Adapter {
  readonly name = 'thrower';
  async init(): Promise<unknown> { return {}; }
  async query(): Promise<RankedDoc[]> { throw new Error('adapter exploded'); }
}

function syntheticProbes(): { probes: Probe[]; gradesByQuery: Map<string, Map<string, number>> } {
  const probes = [
    fakeProbe('p1', 'query one', 'concepts/a'),
    fakeProbe('p2', 'query two', 'concepts/b'),
  ];
  const gradesByQuery = new Map<string, Map<string, number>>([
    ['p1', new Map([['concepts/a', 3], ['concepts/n', 1]])],
    ['p2', new Map([['concepts/b', 3]])],
  ]);
  return { probes, gradesByQuery };
}

describe('cat13 scoreAdapter accounting', () => {
  const pages: RichPage[] = [];

  test('a perfect ranking scores nDCG=1, P@1=1', async () => {
    const { probes, gradesByQuery } = syntheticProbes();
    const acc = new ProbeAccounting(probes.length);
    const adapter = new FixedAdapter({
      p1: ['concepts/a', 'concepts/n'],
      p2: ['concepts/b'],
    });
    const r = await scoreAdapter(adapter, pages, probes, gradesByQuery, acc);
    expect(r.ndcg5).toBeCloseTo(1, 6);
    expect(r.p1_strict).toBe(1);
    const s = acc.summary();
    expect(s.n_scored).toBe(2);
    expect(s.errors.length).toBe(0);
  });

  test('a query that throws is a SUT failure: scored 0, kept in the denominator', async () => {
    const { probes, gradesByQuery } = syntheticProbes();
    const acc = new ProbeAccounting(probes.length);
    const r = await scoreAdapter(new ThrowingAdapter(), pages, probes, gradesByQuery, acc);
    expect(r.ndcg5).toBe(0);
    expect(r.p1_strict).toBe(0);
    const s = acc.summary();
    expect(s.errors.length).toBe(2);
    expect(s.errors.every(e => e.origin === 'sut')).toBe(true);
    // sut failures stay scored (as 0), so completion is intact.
    expect(s.n_scored).toBe(2);
    expect(s.run_invalid).toBe(false);
  });

  test('P@5 uses the shared /k denominator: one relevant doc is not P@5=1', async () => {
    const { probes, gradesByQuery } = syntheticProbes();
    const acc = new ProbeAccounting(probes.length);
    const adapter = new FixedAdapter({ p1: ['concepts/a'], p2: ['concepts/b'] });
    const r = await scoreAdapter(adapter, pages, probes, gradesByQuery, acc);
    // p1: 2 relevant available but only 1 returned → 1/5; p2: 1/5.
    expect(r.p5_graded).toBeCloseTo(1 / TOP_K, 6);
  });
});

// ─── Verdict policy ──────────────────────────────────────────────────

describe('cat13 verdict', () => {
  test('dead retrieval plumbing (gbrain nDCG 0.0) is a fail, never a pass', () => {
    expect(computeCat13Verdict([{ name: 'gbrain', ndcg5: 0 }], { stubEmbed: false, fullStandardRun: false })).toBe('fail');
    expect(computeCat13Verdict([], { stubEmbed: false, fullStandardRun: false })).toBe('fail');
  });

  test('stub or subset runs are partial; full live runs pass', () => {
    expect(computeCat13Verdict([{ name: 'gbrain', ndcg5: 0.4 }], { stubEmbed: true, fullStandardRun: true })).toBe('partial');
    expect(computeCat13Verdict([{ name: 'grep-only', ndcg5: 0.5 }], { stubEmbed: false, fullStandardRun: false })).toBe('partial');
    expect(computeCat13Verdict(
      [{ name: 'gbrain', ndcg5: 0.4 }, { name: 'grep-only', ndcg5: 0.5 }],
      { stubEmbed: false, fullStandardRun: true },
    )).toBe('pass');
  });
});

// ─── Good input: the real runner path, hermetic ──────────────────────

describe('cat13 runner e2e (hermetic, grep-only arm)', () => {
  test('completes, writes report + receipt, verdict partial for a subset run', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat13-'));
    const { receipt, results, exitCode } = await runCat13({
      stubEmbed: true,
      only: 'grep-only',
      targetProbes: 240,
      reportsDir,
      quiet: true,
    });
    expect(exitCode).toBe(0);
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('partial'); // stub + subset — never a publishable pass
    expect(receipt.publishable).toBe(false);
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('grep-only');
    expect(results[0].ndcg5).toBeGreaterThan(0); // grep retrieves SOMETHING on title paraphrases
    expect(receipt.n_total).toBe(results[0].probesScored);
    expect(receipt.n_scored).toBe(receipt.n_total);

    // Receipt on disk is valid per the shared validator.
    const onDisk = loadReceipt(join(reportsDir, 'cat13-conceptual', 'receipt.json'));
    expect(onDisk.category).toBe('cat13-conceptual');
    expect(onDisk.gbrain_version).not.toBe('unknown');
    expect(onDisk.gbrain_pin).not.toBe('unknown');

    const report = JSON.parse(readFileSync(join(reportsDir, 'cat13-conceptual', 'report.json'), 'utf8'));
    expect(report.results.length).toBe(1);
    expect(existsSync(join(reportsDir, 'cat13-conceptual', 'report.json'))).toBe(true);
  }, 120_000);
});
