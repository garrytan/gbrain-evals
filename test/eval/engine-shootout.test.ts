/**
 * engine-shootout.ts unit tests. No engines, no Docker, no network: these
 * cover the pure parts (dataset, embedder, metrics, cost model, CLI guards).
 */

import { describe, test, expect } from 'bun:test';
import {
  analyzeCost, analyzeLatency, analyzeQuality, applyDecisionRule, holmAcross, DECISION,
  ENGINES, EMBED_DIMS, PRICE_MODEL, buildDataset, computeAgreement, costPer1kQueries, hashEmbed,
  monthlyMemoryUsd, ndcgAtK, overlapAtK, parseArgs, percentile, recallAtK, rng, rrfFuse, summarize, toSlugs,
} from '../../eval/runner/engine-shootout.ts';

describe('stats', () => {
  test('percentile uses nearest rank', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 99)).toBe(99);
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 99)).toBe(7);
  });

  test('summarize sorts and reports n, mean, min, max', () => {
    const s = summarize([5, 1, 3]);
    expect(s.n).toBe(3);
    expect(s.min_ms).toBe(1);
    expect(s.max_ms).toBe(5);
    expect(s.mean_ms).toBeCloseTo(3);
    expect(s.p50_ms).toBe(3);
  });

  test('rng is deterministic per seed', () => {
    const a = rng(42), b = rng(42), c = rng(43);
    const xs = [a(), a(), a()];
    expect(xs).toEqual([b(), b(), b()]);
    expect(xs).not.toEqual([c(), c(), c()]);
  });
});

describe('hashEmbed', () => {
  test('is deterministic, unit length, and the configured size', () => {
    const a = hashEmbed('founder mode reality check');
    const b = hashEmbed('founder mode reality check');
    expect(a.length).toBe(EMBED_DIMS);
    expect(Array.from(a)).toEqual(Array.from(b));
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 4);
  });

  test('overlapping text is closer than unrelated text', () => {
    const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i], 0);
    const q = hashEmbed('robotics warehouse picking startup');
    const near = hashEmbed('a robotics startup building warehouse picking robots');
    const far = hashEmbed('quarterly revenue retention pricing discount');
    expect(dot(q, near)).toBeGreaterThan(dot(q, far));
  });

  test('empty text does not produce NaN', () => {
    const v = hashEmbed('');
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe('ranking metrics', () => {
  test('recall@k', () => {
    expect(recallAtK(['a', 'b', 'c'], ['a', 'c'], 2)).toBe(0.5);
    expect(recallAtK(['a', 'b', 'c'], ['a', 'c'], 3)).toBe(1);
    expect(recallAtK([], ['a'], 5)).toBe(0);
    expect(recallAtK(['a'], [], 5)).toBe(0);
  });

  test('nDCG@k is 1 for ideal order and lower when the hit is late', () => {
    expect(ndcgAtK(['a', 'x', 'y'], ['a'], 10)).toBeCloseTo(1);
    const late = ndcgAtK(['x', 'y', 'a'], ['a'], 10);
    expect(late).toBeCloseTo(1 / Math.log2(4));
    expect(late).toBeLessThan(1);
    expect(ndcgAtK(['x'], ['a'], 10)).toBe(0);
  });

  test('overlap@k', () => {
    expect(overlapAtK(['a', 'b', 'c'], ['c', 'b', 'a'], 3)).toBe(1);
    expect(overlapAtK(['a', 'b'], ['c', 'd'], 2)).toBe(0);
    expect(overlapAtK([], [], 5)).toBe(1);
    expect(overlapAtK(['a', 'b', 'c', 'd'], ['a', 'b'], 4)).toBe(0.5);
  });

  test('rrfFuse rewards items that appear in both lists', () => {
    const k = (id: number) => ({ chunk_id: id });
    const fused = rrfFuse([[k(1), k(2), k(3)], [k(3), k(4)]]);
    expect(fused[0].chunk_id).toBe(3);
    expect(fused.map((x) => x.chunk_id).sort()).toEqual([1, 2, 3, 4]);
  });

  test('toSlugs de-duplicates chunks of the same page, keeping order', () => {
    expect(toSlugs([{ slug: 'a' }, { slug: 'a' }, { slug: 'b' }, { slug: 'c' }], 2)).toEqual(['a', 'b']);
  });

  test('computeAgreement compares per mode', () => {
    const a = { keyword: [['x', 'y']], vector: [['p', 'q']], hybrid: [['m']] };
    const b = { keyword: [['x', 'y']], vector: [['q', 'z']], hybrid: [['n']] };
    const r = computeAgreement(a, b);
    expect(r.keyword.overlap_at_5).toBe(1);
    expect(r.keyword.top1_match).toBe(1);
    expect(r.vector.overlap_at_5).toBe(0.5);
    expect(r.vector.top1_match).toBe(0);
    expect(r.hybrid.overlap_at_5).toBe(0);
  });
});

describe('cost model', () => {
  test('cpu and memory dollars follow the stated prices', () => {
    const c = costPer1kQueries({ cpu_seconds_per_1k: 3600, memory_gb: 1, wall_seconds_per_1k: 3600 });
    expect(c.cpu_usd).toBeCloseTo(PRICE_MODEL.compute.usd_per_vcpu_hour);
    expect(c.memory_usd).toBeCloseTo(PRICE_MODEL.compute.usd_per_gb_hour);
    expect(c.total_usd).toBeCloseTo(c.cpu_usd + c.memory_usd);
  });

  test('price model is dated and cites a source', () => {
    expect(PRICE_MODEL.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICE_MODEL.compute.source).toMatch(/^https:\/\//);
    expect(PRICE_MODEL.hosted_postgres.source).toMatch(/^https:\/\//);
  });

  test('monthly memory cost scales with memory', () => {
    expect(monthlyMemoryUsd(2)).toBeCloseTo(2 * monthlyMemoryUsd(1));
  });
});

describe('dataset', () => {
  const qs = [
    { id: 'q1', text: 'who is there', relevant: ['people/does-not-exist'] },
    { id: 'q2', text: 'empty', relevant: [] as string[] },
  ];

  test('same seed gives the same fingerprint, different seed does not', () => {
    const a = buildDataset(260, 1);
    const b = buildDataset(260, 1);
    const c = buildDataset(260, 2);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  test('scale is exact, base pages come first, filler is flagged and uniquely named', () => {
    const d = buildDataset(260, 1);
    expect(d.pages.length).toBe(260);
    expect(d.counts.base_pages).toBe(240);
    expect(d.counts.filler_pages).toBe(20);
    expect(new Set(d.pages.map((p) => p.slug)).size).toBe(260);
    expect(d.pages.filter((p) => !p.base).every((p) => p.slug.includes('/filler-'))).toBe(true);
  });

  test('smaller scale trims the base corpus', () => {
    expect(buildDataset(50, 1).pages.length).toBe(50);
  });

  test('every chunk has a unit-length embedding and chunk indexes are sequential', () => {
    const d = buildDataset(30, 1);
    for (const [, chunks] of d.chunks) {
      chunks.forEach((c, i) => {
        expect(c.chunk_index).toBe(i);
        expect(c.embedding!.length).toBe(EMBED_DIMS);
      });
    }
  });

  test('links point at pages that exist and the hub has inbound links', () => {
    const d = buildDataset(260, 1);
    const slugs = new Set(d.pages.map((p) => p.slug));
    expect(d.links.length).toBeGreaterThan(0);
    expect(d.links.every((l) => slugs.has(l.from_slug) && slugs.has(l.to_slug) && l.from_slug !== l.to_slug)).toBe(true);
    expect(d.links.some((l) => l.to_slug === d.hubSlug)).toBe(true);
  });

  test('timeline entries parse into dated rows', () => {
    const d = buildDataset(60, 1);
    expect(d.timeline.length).toBeGreaterThan(0);
    expect(d.timeline.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date))).toBe(true);
  });

  test('quality queries are kept only when all gold pages are in the corpus', () => {
    const d = buildDataset(30, 1, undefined, qs);
    expect(d.qualityQueries.length).toBe(0);
  });

  test('filler never reuses text from the qrels corpus', () => {
    const d = buildDataset(260, 1);
    const baseText = new Set(d.pages.filter((p) => p.base).flatMap((p) => p.compiled_truth.split(/\n{2,}/)));
    const fillerParas = d.pages.filter((p) => !p.base).flatMap((p) => p.compiled_truth.split(/\n{2,}/));
    expect(fillerParas.some((x) => baseText.has(x))).toBe(false);
  });
});

describe('cli guards', () => {
  test('defaults', () => {
    const o = parseArgs([]);
    expect(o.scale).toBe(1000);
    expect(o.engines).toEqual(['pglite', 'postgres']);
  });

  test('the rust engine is refused until it exists', () => {
    expect(() => parseArgs(['--engines', 'pglite,rust'])).toThrow(/not available yet/);
    expect(Object.keys(ENGINES)).not.toContain('rust');
  });

  test('unknown engines are refused', () => {
    expect(() => parseArgs(['--engines', 'sqlite'])).toThrow(/Unknown engine/);
  });

  test('tiny scales are refused', () => {
    expect(() => parseArgs(['--scale', '3'])).toThrow();
  });
});

describe('gbrain schema match', () => {
  test('EMBED_DIMS equals the embedding width gbrain creates a new brain with', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('node_modules/gbrain/src/core/ai/defaults.ts', 'utf-8');
    const m = src.match(/export const DEFAULT_EMBEDDING_DIMENSIONS = (\d+)/);
    expect(m).not.toBeNull();
    expect(EMBED_DIMS).toBe(Number(m![1]));
  });
});

describe('paired analysis', () => {
  const rows = (n: number, ratio: number) =>
    Array.from({ length: n }, (_, q) => ({ q, ref_ms: 2 + (q % 5) * 0.1, other_ms: (2 + (q % 5) * 0.1) * ratio, other_first: q % 2 === 0 }));

  test('latency: a 2x slower engine gives ratio 2 and an interval around it', () => {
    const a = analyzeLatency(rows(60, 2), 7, 1000);
    expect(a.n).toBe(60);
    expect(a.geo_mean_ratio.ratio).toBeCloseTo(2, 5);
    expect(a.geo_mean_ratio.ci95![0]).toBeLessThanOrEqual(2.0000001);
    expect(a.geo_mean_ratio.ci95![1]).toBeGreaterThanOrEqual(1.9999999);
    expect(a.diff_ms.delta).toBeGreaterThan(0);
    expect(a.by_order.ref_first.n + a.by_order.other_first.n).toBe(60);
  });

  test('latency: same seed gives the same interval', () => {
    const r = rows(40, 1.3).map((x, i) => ({ ...x, other_ms: x.other_ms * (1 + ((i * 7) % 5) / 20) }));
    expect(analyzeLatency(r, 11, 1000)).toEqual(analyzeLatency(r, 11, 1000));
  });

  test('holm adjusts in place and never lowers a p-value', () => {
    const s = { a: analyzeLatency(rows(30, 2), 1, 1000), b: analyzeLatency(rows(30, 1), 1, 1000) };
    const raw = { a: s.a.p_two_sided, b: s.b.p_two_sided };
    holmAcross(s);
    expect(s.a.p_holm).toBeGreaterThanOrEqual(raw.a);
    expect(s.b.p_holm).toBeGreaterThanOrEqual(raw.b);
  });

  test('cost: pairs by block and reports dollars and CPU seconds per 1,000 ops', () => {
    const blocks = Array.from({ length: 8 }, (_, b) => ({
      block: b, ops: 50, other_first: b % 2 === 0,
      ref: { wall_s: 1, client_cpu_s: 0.2, server_cpu_s: 0.3 },
      other: { wall_s: 2, client_cpu_s: 1, server_cpu_s: null },
    }));
    const c = analyzeCost(blocks, { ref: 0.2, other: 1.5 }, 3, 1000);
    expect(c.blocks).toBe(8);
    expect(c.ref_cpu_s_per_1k_ops).toBeCloseTo(10, 6);
    expect(c.other_cpu_s_per_1k_ops).toBeCloseTo(20, 6);
    expect(c.diff_usd_per_1k_ops.delta).toBeGreaterThan(0);
  });

  test('quality: identical rankings give a zero difference and no differing queries', () => {
    const rel = [['a'], ['b'], ['c']];
    const rk = [['a', 'x'], ['x', 'b'], ['c']];
    const q = analyzeQuality(rk, rk, rel, 'recall_at_5', 5, 1000);
    expect(q.diff.delta).toBe(0);
    expect(q.queries_that_differ).toBe(0);
    expect(q.n_queries).toBe(3);
  });

  describe('decision rule', () => {
    const lat = (ratio: number, lo: number, hi: number, p95: number) => ({
      ...analyzeLatency(rows(20, 1), 1, 1000), other_p95_ms: p95, geo_mean_ratio: { ratio, ci95: [lo, hi] as [number, number] },
    });
    const same = { diff: { delta: 0, ci95: [-0.1, 0.1] as [number, number] }, n_queries: 71, ref_mean: 0.3, other_mean: 0.3, queries_that_differ: 0 };
    const quality = { recall_at_5: same, ndcg_at_10: same };

    test('adequate when the whole interval is under the margin and p95 is interactive', () => {
      expect(applyDecisionRule({ hybrid: lat(1.5, 1.4, 1.6, 40), quality }).outcome).toBe('pglite_adequate');
    });
    test('postgres when the interval is entirely above the margin', () => {
      expect(applyDecisionRule({ hybrid: lat(3, 2.5, 3.5, 40), quality }).outcome).toBe('postgres_recommended');
    });
    test('postgres when PGLite p95 is over the interactive limit', () => {
      expect(applyDecisionRule({ hybrid: lat(1.2, 1.1, 1.3, DECISION.interactive_p95_ms + 1), quality }).outcome).toBe('postgres_recommended');
    });
    test('no clear call when the interval straddles the margin', () => {
      expect(applyDecisionRule({ hybrid: lat(1.9, 1.5, 2.6, 40), quality }).outcome).toBe('no_clear_call');
    });
    test('withheld when paired hybrid quality differs', () => {
      const worse = { ...same, diff: { delta: -0.05, ci95: [-0.09, -0.01] as [number, number] } };
      expect(applyDecisionRule({ hybrid: lat(1.1, 1.0, 1.2, 10), quality: { recall_at_5: worse, ndcg_at_10: same } }).outcome).toBe('withheld_quality_differs');
    });
  });
});

describe('cli flags for counted and dev runs', () => {
  test('dev, out and cost flags parse', () => {
    const o = parseArgs(['--dev', '--out', '/tmp/x', '--cost-blocks', '3', '--block-size', '7']);
    expect(o.dev).toBe(true);
    expect(o.outDir).toBe('/tmp/x');
    expect(o.costBlocks).toBe(3);
    expect(o.blockSize).toBe(7);
  });
  test('a run is counted unless --dev is passed', () => {
    expect(parseArgs([]).dev).toBe(false);
  });
});
