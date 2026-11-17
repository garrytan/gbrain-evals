/**
 * engine-shootout-chart.ts unit tests: a synthetic receipt in the runner's
 * shape goes in, valid SVG and a summary table come out. No engines.
 */
import { describe, test, expect } from 'bun:test';
import { costSvg, fmt, footprintSvg, latencySvg, pairedLatencySvg, qualitySvg, scalingSvg, summaryMarkdown, usd, type Receipt } from '../../eval/runner/engine-shootout-chart.ts';

const lat = (ratio: number, ci: [number, number]) => ({
  n: 50, ref_p50_ms: 2, other_p50_ms: 2 * ratio, ref_p95_ms: 3, other_p95_ms: 3 * ratio, ref_p99_ms: 4, other_p99_ms: 4 * ratio,
  diff_ms: { delta: 2 * (ratio - 1), ci95: [1, 3] as [number, number] }, geo_mean_ratio: { ratio, ci95: ci },
  p_two_sided: 0.001, p_holm: 0.01, by_order: { ref_first: { n: 25, mean_diff_ms: 1 }, other_first: { n: 25, mean_diff_ms: 1.1 } },
});
const cost = { blocks: 10, ops_per_block: 20, ref_usd_per_1k_ops: 1e-5, other_usd_per_1k_ops: 2e-5, ref_cpu_s_per_1k_ops: 0.5, other_cpu_s_per_1k_ops: 1, diff_usd_per_1k_ops: { delta: 1e-5, ci95: [5e-6, 1.5e-5] as [number, number] }, diff_cpu_s_per_1k_ops: { delta: 0.5, ci95: [0.2, 0.8] as [number, number] } };
const pq = { n_queries: 71, ref_mean: 0.3, other_mean: 0.3, diff: { delta: 0, ci95: [-0.01, 0.01] as [number, number] }, queries_that_differ: 0 };
const arm = (id: string, label: string, server: number | null): Receipt['arms'][string] => ({
  id, label,
  run: {
    import: { pages: 1000, pages_per_sec: 50, chunk_upserts_per_sec: 200, cpu_seconds: { client: 10, server } },
    quality: { keyword: { recall_at_5: 0.2, ndcg_at_10: 0.2, empty_result_rate: 0.1 }, vector: { recall_at_5: 0.3, ndcg_at_10: 0.3, empty_result_rate: 0 }, hybrid: { recall_at_5: 0.35, ndcg_at_10: 0.33, empty_result_rate: 0 } },
    cost_window: { cpu_seconds_per_1k: 5, wall_seconds_per_1k: 6, qps_single_client: 150 },
    memory: { client_engine_rss_bytes: 2 ** 30, server_peak_working_set_bytes: server },
    latency: {},
  },
  cold_start: { median_total_ms: 800, median_server_to_answer_ms: null },
  disk: { excl_wal_bytes: 5 * 2 ** 20, total_bytes: 9 * 2 ** 20 },
  cost: { usd_per_1k_queries: { cpu_usd: 1e-5, memory_usd: 1e-6, total_usd: 1.1e-5 }, inputs: { memory_gb: 1 } },
});
const receipt = (scale: number, ratio = 1.5): Receipt => ({
  generated_at: '2026-11-16T00:00:00Z', counted: false, options: { scale },
  arms: { postgres: arm('postgres', 'Postgres + pgvector', 1e8), pglite: arm('pglite', 'PGLite', null) },
  paired: {
    pglite_vs_postgres: {
      reference: 'postgres', other: 'pglite',
      latency: { get_page: lat(1, [0.9, 1.1]), search_hybrid_rrf: lat(ratio, [ratio - 0.1, ratio + 0.1]) },
      cost_per_op: { get_page: cost, search_hybrid_rrf: cost },
      quality: { keyword: { recall_at_5: pq, ndcg_at_10: pq }, vector: { recall_at_5: pq, ndcg_at_10: pq }, hybrid: { recall_at_5: pq, ndcg_at_10: pq } },
      decision: { outcome: 'pglite_adequate', reasons: ['x'] },
    },
  },
  price_model: { as_of: '2026-11-16', hosted_postgres: { usd_per_hour: 0.065, label: 'RDS' }, hours_per_month: 730 },
  decision_rule: { ratio_margin: 2, interactive_p95_ms: 100 },
});

describe('engine-shootout chart', () => {
  test('every chart is a well-formed SVG that names both engines', () => {
    const r = receipt(1000);
    for (const svg of [pairedLatencySvg(r), latencySvg(r), footprintSvg(r), qualitySvg(r), costSvg(r)]) {
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
      expect(svg).toContain('PGLite');
      expect(svg).not.toContain('NaN');
      expect(svg).not.toContain('undefined');
    }
  });

  test('scaling chart needs several sizes and stays finite', () => {
    const svg = scalingSvg([receipt(1000, 1.5), receipt(10000, 3)]);
    expect(svg).toContain('10,000 pages');
    expect(svg).not.toContain('NaN');
  });

  test('summary has one section per size and every operation', () => {
    const md = summaryMarkdown([receipt(10000, 3), receipt(1000)]);
    expect(md.indexOf('## 1,000 pages')).toBeLessThan(md.indexOf('## 10,000 pages'));
    expect(md).toContain('| search_hybrid_rrf |');
    expect(md).toContain('pglite_adequate');
  });

  test('number formatting', () => {
    expect(fmt(1234.5)).toBe('1,235');
    expect(fmt(null)).toBe('n/a');
    expect(usd(-2.5e-6)).toBe('-$2.50e-6');
  });
});
