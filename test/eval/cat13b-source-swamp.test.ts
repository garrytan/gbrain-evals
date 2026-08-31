/**
 * Cat 13b source-swamp — hermetic regression suite.
 *
 * No API keys, no network: embeds go through the runner's
 * __setEmbedTransportForTests seam (deterministic hash embedding +
 * OPENAI_API_KEY=dummy).
 *
 * What this suite pins (audit findings retrieval-cats-07 / -09 / -16):
 *   1. -07: the boost-map premise check CAN fail — a map without the
 *      swamp prefix (the exact v0.24.0 wintermute→openclaw rename shape)
 *      throws — and passes against the real gbrain map. The corpus premise
 *      check fails on stale wintermute/ slugs and passes on the rebuilt
 *      openclaw/chat/ corpus.
 *   2. -09: the pass criterion (gbrain top1 >= 80%) drives the verdict:
 *      below-bar is 'fail', above-bar live is 'pass', above-bar stub is
 *      'partial', gbrain-not-run is 'partial'. The e2e run proves the
 *      receipt + report JSON land on disk and the exit code follows the
 *      verdict.
 *   3. -16: the ablation plumbing is real — GBRAIN_SOURCE_BOOST
 *      neutralization resolves every prefix to 1.0, the paired arm
 *      observably reranks queries on the real corpus, and identical arms
 *      (dead ablation) are detectable via ablationDivergence === 0.
 *   4. Probe accounting: a query that throws is a sut failure scored as a
 *      top-1 miss and kept in the denominator.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  TOP_K,
  PASS_TOP1,
  CURATED_PREFIX,
  SWAMP_PREFIX,
  QUERIES,
  loadCorpus,
  boostFactorFor,
  assertBoostPremise,
  BoostPremiseError,
  assertCorpusPremise,
  CorpusPremiseError,
  neutralBoostEnv,
  computeVerdict13b,
  ablationDivergence,
  scoreAdapter,
  runCat13b,
  type SwampResult,
} from '../../eval/runner/cat13b-source-swamp.ts';
import { resolveBoostMap } from '../../node_modules/gbrain/src/core/search/source-boost.ts';
import { ProbeAccounting } from '../../eval/runner/probe-accounting.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';
import type { Adapter, Page, RankedDoc } from '../../eval/runner/types.ts';

const CORPUS_DIR = join(import.meta.dir, '..', '..', 'eval', 'data', 'source-swamp-v1');

// ─── Boost-map premise (finding retrieval-cats-07) ───────────────────

describe('cat13b boost premise', () => {
  test('the check CAN fail: the v0.24.0 rename shape (no openclaw/chat/ key) throws', () => {
    // Exactly what gbrain v0.24.0 did to this eval: the swamp key renamed
    // away, unmatched prefixes fall to the ELSE 1.0 branch.
    expect(() => assertBoostPremise({ 'wintermute/chat/': 0.5, 'originals/': 1.5 }))
      .toThrow(BoostPremiseError);
  });

  test('a neutralized curated tier also throws', () => {
    expect(() => assertBoostPremise({ 'openclaw/chat/': 0.5, 'originals/': 1.0 }))
      .toThrow(BoostPremiseError);
  });

  test('good input: the REAL gbrain map demotes the swamp and boosts the curated tier', () => {
    const { curated_factor, swamp_factor } = assertBoostPremise();
    expect(swamp_factor).toBeLessThan(1.0);
    expect(curated_factor).toBeGreaterThan(1.0);
  });

  test('boostFactorFor uses longest-prefix-match like sql-ranking.ts', () => {
    const map = { 'media/': 0.9, 'media/articles/': 1.1 };
    expect(boostFactorFor('media/articles/x', map)).toBe(1.1);
    expect(boostFactorFor('media/x/y', map)).toBe(0.9);
    expect(boostFactorFor('unmapped/z', map)).toBe(1.0);
  });
});

// ─── Corpus premise (finding retrieval-cats-07) ──────────────────────

describe('cat13b corpus premise', () => {
  const pages = loadCorpus(CORPUS_DIR);

  test('good input: the rebuilt corpus passes (10 curated + 10 swamp, all qrels resolve)', () => {
    expect(pages.filter(p => p.slug.startsWith(CURATED_PREFIX)).length).toBe(10);
    expect(pages.filter(p => p.slug.startsWith(SWAMP_PREFIX)).length).toBe(10);
    expect(() => assertCorpusPremise(pages, QUERIES)).not.toThrow();
  });

  test('the check CAN fail: a stale wintermute/ slug (pre-rename corpus) throws', () => {
    const stale = pages.map(p => p.slug.startsWith(SWAMP_PREFIX)
      ? { ...p, slug: p.slug.replace(SWAMP_PREFIX, 'wintermute/chat/') }
      : p);
    expect(() => assertCorpusPremise(stale, QUERIES)).toThrow(CorpusPremiseError);
  });

  test('the check CAN fail: a qrel pointing at a missing page throws', () => {
    const q = [{ id: 'qx', text: 'x', target: 'originals/talks/article-outline-fat-code', competing: ['openclaw/chat/2099-01-01'] }];
    expect(() => assertCorpusPremise(pages, q)).toThrow(CorpusPremiseError);
  });

  test('every query names a curated target and swamp competitors', () => {
    for (const q of QUERIES) {
      expect(q.target.startsWith(CURATED_PREFIX)).toBe(true);
      expect(q.competing.length).toBeGreaterThan(0);
      for (const c of q.competing) expect(c.startsWith(SWAMP_PREFIX)).toBe(true);
    }
  });
});

// ─── Ablation plumbing (finding retrieval-cats-16) ───────────────────

describe('cat13b ablation plumbing', () => {
  test('neutralBoostEnv resolves EVERY prefix to 1.0 through gbrain\'s own parser', () => {
    const neutral = resolveBoostMap(neutralBoostEnv());
    expect(Object.keys(neutral).length).toBeGreaterThan(0);
    expect(Object.values(neutral).every(v => v === 1.0)).toBe(true);
  });

  function fakeResult(name: string, tops: Record<string, string[]>): SwampResult {
    return {
      name,
      top1_hit_rate: 0,
      top3_hit_rate: 0,
      swamp_at_top: 0,
      wallMs: 0,
      per_query: Object.entries(tops).map(([id, top_slugs]) => ({
        id, topSlug: top_slugs[0] ?? null, targetRank: -1, chatBeforeTarget: 0, top_slugs,
      })),
    };
  }

  test('a dead ablation (identical rankings everywhere) is detectable', () => {
    const a = fakeResult('gbrain', { q1: ['x', 'y'], q2: ['z'] });
    const b = fakeResult('gbrain-no-source-boost', { q1: ['x', 'y'], q2: ['z'] });
    expect(ablationDivergence(a, b)).toBe(0);
  });

  test('reranked queries are counted', () => {
    const a = fakeResult('gbrain', { q1: ['x', 'y'], q2: ['z'] });
    const b = fakeResult('gbrain-no-source-boost', { q1: ['y', 'x'], q2: ['z'] });
    expect(ablationDivergence(a, b)).toBe(1);
  });
});

// ─── Pass criterion drives the verdict (finding retrieval-cats-09) ───

describe('cat13b verdict', () => {
  test('below the 80% bar is FAIL — the gate can fail', () => {
    expect(computeVerdict13b({ top1_hit_rate: 0.79 }, false)).toEqual({ verdict: 'fail', gatePass: false });
    expect(computeVerdict13b({ top1_hit_rate: 0 }, true)).toEqual({ verdict: 'fail', gatePass: false });
  });

  test('at/above the bar: live pass, stub partial', () => {
    expect(computeVerdict13b({ top1_hit_rate: PASS_TOP1 }, false)).toEqual({ verdict: 'pass', gatePass: true });
    expect(computeVerdict13b({ top1_hit_rate: 0.93 }, true)).toEqual({ verdict: 'partial', gatePass: true });
  });

  test('gbrain arm absent: partial (the criterion cannot be evaluated)', () => {
    expect(computeVerdict13b(undefined, false)).toEqual({ verdict: 'partial', gatePass: false });
  });
});

// ─── Probe accounting on adapter failure ─────────────────────────────

class ThrowingAdapter implements Adapter {
  readonly name = 'thrower';
  async init(): Promise<unknown> { return {}; }
  async query(): Promise<RankedDoc[]> { throw new Error('adapter exploded'); }
}

class FixedAdapter implements Adapter {
  readonly name = 'fixed';
  constructor(private top: string) {}
  async init(): Promise<unknown> { return {}; }
  async query(): Promise<RankedDoc[]> {
    return [{ page_id: this.top, score: 1, rank: 1 }];
  }
}

describe('cat13b scoreAdapter accounting', () => {
  const pages: Page[] = [];
  const queries = QUERIES.slice(0, 3);

  test('a query that throws is a SUT failure: top-1 miss, kept in the denominator', async () => {
    const acc = new ProbeAccounting(queries.length);
    const r = await scoreAdapter(new ThrowingAdapter(), pages, queries, acc);
    expect(r.top1_hit_rate).toBe(0);
    expect(r.per_query.every(pq => pq.error !== undefined)).toBe(true);
    const s = acc.summary();
    expect(s.errors.length).toBe(3);
    expect(s.errors.every(e => e.origin === 'sut')).toBe(true);
    expect(s.n_scored).toBe(3); // scored as zeros, not dropped
  });

  test('a target-first ranking scores top1=1', async () => {
    const acc = new ProbeAccounting(1);
    const r = await scoreAdapter(new FixedAdapter(queries[0].target), pages, [queries[0]], acc);
    expect(r.top1_hit_rate).toBe(1);
    expect(r.per_query[0].targetRank).toBe(1);
  });
});

// ─── Good input: the full runner, hermetic ───────────────────────────

describe('cat13b runner e2e (stub embeds, all arms)', () => {
  test('completes, gate + ablation observable, receipt + report on disk, exit follows verdict', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat13b-'));
    const { receipt, results, exitCode } = await runCat13b({
      stubEmbed: true,
      reportsDir,
      quiet: true,
    });

    expect(receipt.run_status).toBe('completed');
    const names = results.map(r => r.name);
    expect(names).toContain('gbrain');
    expect(names).toContain('gbrain-no-source-boost');

    // The verdict on the receipt IS the pass criterion applied to the
    // measured gbrain arm (finding -09: the gate can no longer print-and-exit-0).
    const gbrain = results.find(r => r.name === 'gbrain')!;
    const { verdict } = computeVerdict13b(gbrain, true);
    expect(receipt.verdict).toBe(verdict);
    expect(exitCode).toBe(verdict === 'fail' ? 1 : 0);
    expect(receipt.publishable).toBe(false); // stub runs are never publishable

    // The ablation arm isolates the boost (finding -16): rankings observably
    // move when the boost is neutralized on the same pipeline.
    const effect = (receipt.data as Record<string, unknown>).source_boost_effect as { queries_reranked: number };
    expect(effect).toBeTruthy();
    expect(effect.queries_reranked).toBeGreaterThan(0);

    // Machine-readable artifacts (finding -09).
    const onDisk = loadReceipt(join(reportsDir, 'cat13b-source-swamp', 'receipt.json'));
    expect(onDisk.category).toBe('cat13b-source-swamp');
    expect(onDisk.gbrain_version).not.toBe('unknown');
    const report = JSON.parse(readFileSync(join(reportsDir, 'cat13b-source-swamp', 'report.json'), 'utf8'));
    expect(report.results.length).toBe(5);
    expect(report.results[0].per_query.length).toBe(QUERIES.length);
    expect(report.boost_factors.swamp_factor).toBeLessThan(1);

    // n_total = arms × queries; every probe accounted for.
    expect(receipt.n_total).toBe(5 * QUERIES.length);
    expect(receipt.completion_rate).toBeGreaterThan(0.9);
  }, 300_000);

  test('missing OPENAI_API_KEY without --stub-embed is a skipped receipt + non-zero exit', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const reportsDir = mkdtempSync(join(tmpdir(), 'cat13b-skip-'));
      const { receipt, exitCode } = await runCat13b({ stubEmbed: false, reportsDir, quiet: true });
      expect(receipt.run_status).toBe('skipped');
      expect(receipt.publishable).toBe(false);
      expect(exitCode).toBe(2);
      const allowed = await runCat13b({ stubEmbed: false, reportsDir, allowSkip: true, quiet: true });
      expect(allowed.exitCode).toBe(0);
      expect(allowed.receipt.run_status).toBe('skipped');
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
    }
  }, 60_000);
});
