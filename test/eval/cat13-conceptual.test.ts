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
  // Phase E0
  resolveEmbedder,
  hashEmbed,
  providerKeyEnv,
  parseOnOff,
  pinnedSearchConfig,
  buildAdapters,
  GBRAIN_BACKED_ADAPTERS,
  splitConcepts,
  probeSubset,
  parseCat13Argv,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBED_DIMS,
  CAT13_RERANK_MODEL_PIN,
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

// ─── Phase E0: embedder resolution ───────────────────────────────────

describe('cat13 embedder resolution (Phase E0)', () => {
  test('defaults to the historical OpenAI space when nothing is set', () => {
    expect(resolveEmbedder({}, {})).toEqual({ model: DEFAULT_EMBEDDING_MODEL, dims: DEFAULT_EMBED_DIMS });
    expect(resolveEmbedder({}, { CAT13_EMBEDDING_MODEL: '', CAT13_EMBED_DIMS: ' ' })).toEqual({ model: DEFAULT_EMBEDDING_MODEL, dims: DEFAULT_EMBED_DIMS });
  });

  test('env overrides the default; an explicit (CLI) override beats env', () => {
    const env = { CAT13_EMBEDDING_MODEL: 'voyage:voyage-4', CAT13_EMBED_DIMS: '1024' };
    expect(resolveEmbedder({}, env)).toEqual({ model: 'voyage:voyage-4', dims: 1024 });
    expect(resolveEmbedder({ model: 'openai:text-embedding-3-small', dims: '512' }, env))
      .toEqual({ model: 'openai:text-embedding-3-small', dims: 512 });
    expect(resolveEmbedder({ dims: 256 }, env)).toEqual({ model: 'voyage:voyage-4', dims: 256 });
  });

  test('malformed values throw instead of silently falling back', () => {
    expect(() => resolveEmbedder({}, { CAT13_EMBEDDING_MODEL: 'voyage-4' })).toThrow(/provider:model/);
    expect(() => resolveEmbedder({}, { CAT13_EMBED_DIMS: '1o24' })).toThrow(/positive integer/);
    expect(() => resolveEmbedder({}, { CAT13_EMBED_DIMS: '0' })).toThrow(/positive integer/);
    expect(() => resolveEmbedder({ dims: '1.5' }, {})).toThrow(/positive integer/);
  });

  test('the hash-embed stub produces deterministic unit vectors of the configured width', () => {
    expect(hashEmbed('unit economics').length).toBe(DEFAULT_EMBED_DIMS);
    const v = hashEmbed('unit economics', 1024);
    expect(v.length).toBe(1024);
    expect(Math.sqrt(v.reduce((a, b) => a + b * b, 0))).toBeCloseTo(1, 6);
    expect(hashEmbed('unit economics', 1024)).toEqual(v);
  });

  test('the provider key env derives from the model prefix', () => {
    expect(providerKeyEnv('openai:text-embedding-3-large')).toBe('OPENAI_API_KEY');
    expect(providerKeyEnv('voyage:voyage-4')).toBe('VOYAGE_API_KEY');
    expect(providerKeyEnv(CAT13_RERANK_MODEL_PIN)).toBe('VOYAGE_API_KEY');
    expect(providerKeyEnv('acme-ai:foo')).toBe('ACME_AI_API_KEY');
  });
});

// ─── Phase E0: search pins ───────────────────────────────────────────

describe('cat13 search pins (Phase E0)', () => {
  test('the default cell is balanced / reranker off / autocut off and nothing else', () => {
    expect(pinnedSearchConfig({ reranker: 'off', autocut: 'off' })).toEqual({
      'search.mode': 'balanced',
      'search.reranker.enabled': 'false',
      'search.autocut': 'false',
    });
  });

  test('reranker on pins the model by name; autocut on flips only autocut', () => {
    expect(pinnedSearchConfig({ reranker: 'on', autocut: 'off' })).toEqual({
      'search.mode': 'balanced',
      'search.reranker.enabled': 'true',
      'search.reranker.model': CAT13_RERANK_MODEL_PIN,
      'search.autocut': 'false',
    });
    const ac = pinnedSearchConfig({ reranker: 'off', autocut: 'on' });
    expect(ac['search.autocut']).toBe('true');
    expect(ac['search.reranker.enabled']).toBe('false');
    expect('search.reranker.model' in ac).toBe(false);
  });

  test('expansion_variant_budget is set ONLY when given, as a pass-through string', () => {
    expect('search.expansion_variant_budget' in pinnedSearchConfig({ reranker: 'off', autocut: 'off' })).toBe(false);
    expect(pinnedSearchConfig({ reranker: 'off', autocut: 'off', expansionVariantBudget: '1.0' })['search.expansion_variant_budget']).toBe('1.0');
    expect(pinnedSearchConfig({ reranker: 'off', autocut: 'off', expansionVariantBudget: 'legacy' })['search.expansion_variant_budget']).toBe('legacy');
    expect(() => pinnedSearchConfig({ reranker: 'off', autocut: 'off', expansionVariantBudget: ' ' })).toThrow(/non-empty/);
  });

  test('on|off parsing is strict', () => {
    expect(parseOnOff(undefined, '--reranker')).toBe('off');
    expect(parseOnOff('ON', '--reranker')).toBe('on');
    expect(() => parseOnOff('true', '--reranker')).toThrow(/--reranker must be 'on' or 'off'/);
  });

  test('both gbrain-backed adapters get the same pins; every embedding arm gets the run embedder', () => {
    const embedder = { model: 'voyage:voyage-4', dims: 1024 };
    const searchConfig = pinnedSearchConfig({ reranker: 'off', autocut: 'on' });
    const plans = buildAdapters({ embedder, searchConfig });
    expect(plans.map(p => p.adapter.name)).toEqual(['gbrain', 'vector-grep-rrf-fusion', 'grep-only', 'vector']);
    const byName = Object.fromEntries(plans.map(p => [p.adapter.name, p.initConfig]));
    expect(byName['vector-grep-rrf-fusion'].searchConfig).toEqual(searchConfig);
    expect(byName['vector-grep-rrf-fusion'].shootout).toMatchObject({ embedder: 'voyage:voyage-4', dim: 1024, searchMode: 'balanced' });
    expect(byName['vector'].shootout).toMatchObject({ embedder: 'voyage:voyage-4', dim: 1024 });
    expect(byName['grep-only']).toEqual({});
    for (const n of GBRAIN_BACKED_ADAPTERS) expect(plans.some(p => p.adapter.name === n)).toBe(true);
  });
});

// ─── Phase E0: seeded concept split ──────────────────────────────────

describe('cat13 concept split (Phase E0)', () => {
  const pages = loadCorpus(CORPUS_DIR);
  const concepts = pages.filter(p => p.slug.startsWith('concepts/')).map(p => p.slug);

  test('default 20/10 over the 30 concepts is disjoint, exhaustive, seed-deterministic and order-independent', () => {
    expect(concepts.length).toBe(30);
    const a = splitConcepts(concepts, 20, 10, 42);
    const b = splitConcepts([...concepts].reverse(), 20, 10, 42);
    expect(a).toEqual(b);
    expect(a.tuning.length).toBe(20);
    expect(a.holdout.length).toBe(10);
    expect(new Set([...a.tuning, ...a.holdout]).size).toBe(30);
    expect(splitConcepts(concepts, 20, 10, 7).holdout).not.toEqual(a.holdout);
  });

  test('sizes over the concept count, negatives, fractions and bad seeds throw', () => {
    expect(() => splitConcepts(concepts, 25, 10, 42)).toThrow(/exceeds/);
    expect(() => splitConcepts(concepts, -1, 10, 42)).toThrow(/non-negative/);
    expect(() => splitConcepts(concepts, 20, 1.5, 42)).toThrow(/non-negative integer/);
    expect(() => splitConcepts(concepts, 20, 10, -1)).toThrow(/--seed/);
  });

  test('the split does not perturb the probe generator (separate rng stream)', () => {
    const before = buildProbes(pages, 500);
    splitConcepts(concepts, 20, 10, 42);
    const after = buildProbes(pages, 500);
    expect(JSON.stringify(after.probes.map(p => p.q.text))).toBe(JSON.stringify(before.probes.map(p => p.q.text)));
  });

  test('probe membership: every target in one set, else mixed / unassigned', () => {
    const split = { seed: 1, tuning: ['concepts/a', 'concepts/b'], holdout: ['concepts/c'] };
    expect(probeSubset({ targetSlugs: ['concepts/a'] }, split)).toBe('tuning');
    expect(probeSubset({ targetSlugs: ['concepts/a', 'concepts/b'] }, split)).toBe('tuning');
    expect(probeSubset({ targetSlugs: ['concepts/c'] }, split)).toBe('holdout');
    expect(probeSubset({ targetSlugs: ['concepts/a', 'concepts/c'] }, split)).toBe('mixed');
    expect(probeSubset({ targetSlugs: ['concepts/c', 'concepts/z'] }, split)).toBe('mixed');
    expect(probeSubset({ targetSlugs: ['concepts/z'] }, split)).toBe('unassigned');
  });

  test('on the real probes only company-neighborhood probes can be mixed, and every other probe lands in a subset', () => {
    const { probes } = buildProbes(pages, 500);
    const split = splitConcepts(concepts, 20, 10, 42);
    for (const p of probes) {
      const s = probeSubset(p, split);
      expect(s).not.toBe('unassigned');
      if (s === 'mixed') expect(p.template).toBe('company-neighborhood');
    }
  });

  test('scoreAdapter reports tuning / held-out rollups that partition the scored probes', async () => {
    const { probes, gradesByQuery } = syntheticProbes(); // p1 → concepts/a, p2 → concepts/b
    const split = { seed: 1, tuning: ['concepts/a'], holdout: ['concepts/b'] };
    const acc = new ProbeAccounting(probes.length);
    const adapter = new FixedAdapter({ p1: ['concepts/a', 'concepts/n'], p2: ['concepts/x'] });
    const r = await scoreAdapter(adapter, [], probes, gradesByQuery, acc, { split });
    expect(r.splits?.seed).toBe(1);
    expect(r.splits?.tuning.count).toBe(1);
    expect(r.splits?.tuning.ndcg5).toBeCloseTo(1, 6);
    expect(r.splits?.tuning.p1_strict).toBe(1);
    expect(r.splits?.tuning.byTemplate.test.count).toBe(1);
    expect(r.splits?.holdout.count).toBe(1);
    expect(r.splits?.holdout.ndcg5).toBe(0);
    expect(r.splits?.holdout.p1_strict).toBe(0);
    expect(r.splits?.mixed).toBe(0);
    expect(r.ndcg5).toBeCloseTo(0.5, 6); // overall is unchanged by the split
  });
});

// ─── Phase E0: CLI parsing ───────────────────────────────────────────

describe('cat13 CLI parsing (Phase E0)', () => {
  test('flags map to options in both --flag value and --flag=value forms', () => {
    const o = parseCat13Argv([
      '--stub-embed', '--adapter', 'gbrain', '--embedding-model=voyage:voyage-4', '--embedding-dims', '1024',
      '--reranker', 'on', '--autocut=off', '--expansion-variant-budget', '1.0',
      '--tuning-concepts', '20', '--holdout-concepts=10', '--seed', '7', '--allow-skip',
    ], {});
    expect(o).toEqual({
      stubEmbed: true, allowSkip: true, only: 'gbrain',
      embeddingModel: 'voyage:voyage-4', embeddingDims: '1024',
      reranker: 'on', autocut: 'off', expansionVariantBudget: '1.0',
      tuningConcepts: 20, holdoutConcepts: 10, seed: 7,
    });
  });

  test('unknown flags, bad on/off values and missing values throw (no silent default cell)', () => {
    expect(() => parseCat13Argv(['--rerankr', 'on'], {})).toThrow(/unknown argument/);
    expect(() => parseCat13Argv(['--reranker', 'yes'], {})).toThrow(/on' or 'off/);
    expect(() => parseCat13Argv(['--adapter'], {})).toThrow(/requires a value/);
    expect(() => parseCat13Argv(['--adapter', '--stub-embed'], {})).toThrow(/requires a value/);
    expect(() => parseCat13Argv(['--tuning-concepts', 'x'], {})).toThrow(/non-negative integer/);
  });

  test('CAT13_STUB_EMBED=1 still forces the stub transport', () => {
    expect(parseCat13Argv([], { CAT13_STUB_EMBED: '1' }).stubEmbed).toBe(true);
    expect(parseCat13Argv([], {}).stubEmbed).toBeUndefined();
  });
});

// ─── Phase E0: fail-closed reranker + receipt echo (hermetic) ────────

describe('cat13 Phase E0 receipt (hermetic)', () => {
  test('--reranker on under --stub-embed is refused: the fail-open reranker would mislabel the cell', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat13-'));
    await expect(runCat13({ stubEmbed: true, only: 'grep-only', targetProbes: 30, reranker: 'on', reportsDir, quiet: true }))
      .rejects.toThrow(/--reranker on cannot run under --stub-embed/);
  });

  test('a live reranker-on cell without the provider key is a skipped receipt (exit 2), never a run', async () => {
    const saved = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    try {
      const reportsDir = mkdtempSync(join(tmpdir(), 'cat13-'));
      const { receipt, results, exitCode } = await runCat13({
        stubEmbed: false, only: 'grep-only', targetProbes: 30, reranker: 'on', reportsDir, quiet: true,
      });
      expect(exitCode).toBe(2);
      expect(results.length).toBe(0);
      expect(receipt.run_status).toBe('skipped');
      expect(receipt.skip_reason).toMatch(/VOYAGE_API_KEY/);
      const rc = receipt.resolved_config as Record<string, any>;
      expect(rc.search_pins['search.reranker.enabled']).toBe('true');
      expect(rc.search_pins['search.reranker.model']).toBe(CAT13_RERANK_MODEL_PIN);
    } finally {
      if (saved !== undefined) process.env.VOYAGE_API_KEY = saved;
    }
  });

  test('gbrain arm at voyage:voyage-4 @ 1024d (stub): the receipt echoes embedder, per-adapter pins, gateway state and the split', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat13-'));
    const { receipt, results, exitCode } = await runCat13({
      stubEmbed: true,
      only: 'gbrain',
      targetProbes: 30,
      embeddingModel: 'voyage:voyage-4',
      embeddingDims: 1024,
      autocut: 'on',
      expansionVariantBudget: '1.0',
      reportsDir,
      quiet: true,
    });
    expect(exitCode).toBe(0);
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('partial');
    expect(results.length).toBe(1);
    expect(results[0].ndcg5).toBeGreaterThan(0);

    const rc = receipt.resolved_config as Record<string, any>;
    expect(rc.embedder).toEqual({ model: 'voyage:voyage-4', dims: 1024 });
    expect(rc.embedding_transport).toMatch(/1024d/);
    expect(rc.pins).toEqual({ reranker: 'off', autocut: 'on', expansion_variant_budget: '1.0' });
    expect(rc.search_pins).toEqual({
      'search.mode': 'balanced',
      'search.reranker.enabled': 'false',
      'search.autocut': 'true',
      'search.expansion_variant_budget': '1.0',
    });
    expect(rc.search_config_by_adapter.gbrain).toEqual(rc.search_pins);
    expect(rc.gateway_after_init_by_adapter.gbrain).toEqual({ model: 'voyage:voyage-4', dims: 1024 });
    expect(rc.observed_by_adapter.gbrain.queries).toBe(results[0].probesScored);
    expect(rc.observed_by_adapter.gbrain.rerank_scored_queries).toBe(0);
    expect(rc.concept_split).toMatchObject({ seed: 42, tuning_n: 20, holdout_n: 10 });
    expect(rc.concept_split.tuning.length).toBe(20);
    expect(rc.concept_split.holdout.length).toBe(10);

    const s = results[0].splits!;
    expect(s.tuning.count + s.holdout.count + s.mixed + s.unassigned).toBe(results[0].probesScored);
    expect(s.unassigned).toBe(0);
    const row = (receipt.data as Record<string, any>).scorecard[0];
    expect(row.tuning.count).toBe(s.tuning.count);
    expect(row.holdout.count).toBe(s.holdout.count);
    expect((receipt.data as Record<string, any>).per_template.gbrain.holdout).toEqual(s.holdout.byTemplate);

    const report = JSON.parse(readFileSync(join(reportsDir, 'cat13-conceptual', 'report.json'), 'utf8'));
    expect(report.embedder).toEqual({ model: 'voyage:voyage-4', dims: 1024 });
    expect(report.search_pins).toEqual(rc.search_pins);
    expect(report.concept_split.holdout_n).toBe(10);
  }, 240_000);
});
