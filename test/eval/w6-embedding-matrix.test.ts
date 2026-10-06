/**
 * W6 additions: per-cell cost and latency from the ledger in Cat 18b and
 * Cat 13, Cat 13's --preregistration flag, and the local Ollama cell's
 * 4,096-dimension index running hermetically.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CELLS, runMatrixCell } from '../../eval/runner/cat18b-embedding-rerank-matrix.ts';
import { makeHashEmbedTransport } from '../../eval/runner/cat18-embedding-providers.ts';
import { parseCat13Argv, phaseStats } from '../../eval/runner/cat13-conceptual.ts';
import { ProbeAccounting } from '../../eval/runner/probe-accounting.ts';
import { __setEmbedTransportForTests } from 'gbrain/ai/gateway';

describe('cat13 phase stats', () => {
  test('splits ingest from query spend and reports latency percentiles', () => {
    const s = phaseStats([10, 30, 20, 40], { start: 1, afterInit: 1.5, end: 1.9 }, 4);
    expect(s.ingest_cost_usd).toBeCloseTo(0.5, 10);
    expect(s.query_cost_usd).toBeCloseTo(0.4, 10);
    expect(s.cost_per_1000_queries_usd).toBeCloseTo(100, 8);
    expect(s.query_ms).toEqual({ mean: 25, p50: 20, p95: 40 });
  });

  test('without a ledger the costs are null, never zero', () => {
    const s = phaseStats([], { start: null, afterInit: null, end: null }, 10);
    expect(s).toEqual({ ingest_cost_usd: null, query_cost_usd: null, cost_per_1000_queries_usd: null, query_ms: null });
  });

  test('--preregistration is parsed', () => {
    expect(parseCat13Argv(['--preregistration', 'docs/x.md'], {}).preregistration).toBe('docs/x.md');
  });
});

describe('cat18b per-cell cost and the local cell', () => {
  test('a 4,096-dimension local cell indexes and scores hermetically, with ledger deltas per phase', async () => {
    process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'w6-home-'));
    __setEmbedTransportForTests(makeHashEmbedTransport());
    let spent = 0;
    const spentUsd = () => { spent += 0.25; return spent; };
    try {
      const spec = CELLS.find(c => c.name === 'qwen3-local')!;
      const pages = [
        { slug: 'concepts/payment-rails', type: 'concept', body: '# Payment rails\n\nPayment rails move money between banks for fintech companies.' },
        { slug: 'people/alice-example', type: 'person', body: '# Alice Example\n\nAlice Example builds dental agents for clinics every day.' },
      ];
      const queries = [{ id: 'q1', text: 'money between banks', relevant_slugs: ['concepts/payment-rails'] }];
      const cell = await runMatrixCell(spec, pages as never, queries, new ProbeAccounting(1), { spentUsd });
      expect(cell.embed_dim).toBe(4096);
      expect(cell.valid).toBe(true);
      expect(cell.data_egress).toMatch(/^local embedding: no text leaves/);
      expect(cell.ingest_cost_usd).toBeCloseTo(0.25, 10);
      expect(cell.query_cost_usd).toBeCloseTo(0.25, 10);
      expect(cell.cost_per_1000_queries_usd).toBeCloseTo(250, 8);
      expect(cell.p95_query_ms).not.toBeNull();
    } finally {
      __setEmbedTransportForTests(null);
    }
  }, 120_000);
});

describe('w6 keyless summary', () => {
  const { cellFrom, compare, egressFor, summarize } = require('../../eval/runner/w6-embedding-matrix.ts') as typeof import('../../eval/runner/w6-embedding-matrix.ts');
  const receipt = (model: string, firsts: number[], scored: number) => ({
    resolved_config: { embedder: { model, dims: 1024 }, observed_by_adapter: { gbrain: { rerank_scored_queries: scored, queries: firsts.length } } },
    data: {
      scorecard: [{ name: 'gbrain', ndcg5: 0.5, p1_strict: 0.5, phase: { cost_per_1000_queries_usd: 0.5, query_cost_usd: 0.01, ingest_cost_usd: 0.02, query_ms: { mean: 100, p50: 90, p95: 200 } } }],
      per_query: { gbrain: firsts.map((p, i) => ({ id: `q${i}`, subset: i < firsts.length - 1 ? 'holdout' : 'tuning', p1_strict: p, ndcg5: p, cluster_id: `c${i % 4}` })) },
    },
    cost: { usd: 0.03 },
  });

  test('a reranked run is invalid unless every query was reranked', () => {
    expect(cellFrom('cat13-voyage-4-rerank-on.receipt.json', receipt('voyage:voyage-4', [1, 0, 1], 3) as never).valid).toBe(true);
    const bad = cellFrom('cat13-voyage-4-rerank-on.receipt.json', receipt('voyage:voyage-4', [1, 0, 1], 2) as never);
    expect(bad.valid).toBe(false);
    expect(bad.invalid_reason).toBe('reranker scored 2 of 3 queries');
    expect(cellFrom('cat13-voyage-4-rerank-off.receipt.json', receipt('voyage:voyage-4', [1, 0, 1], 0) as never).valid).toBe(true);
  });

  test('held-out counts exclude tuning questions, and names normalize', () => {
    const c = cellFrom('cat13-openai-1536-rerank-off.receipt.json', receipt('openai:text-embedding-3-large', [1, 1, 0, 1], 0) as never);
    expect(c.embedder).toBe('openai-1536');
    expect(c.heldout_first).toBe(2);
    expect(c.heldout_n).toBe(3);
    expect(cellFrom('cat13-qwen3-local-rerank-off.receipt.json', receipt('ollama:qwen3-embedding:8b', [1, 0], 0) as never).embedder).toBe('qwen3-local');
  });

  test('egress labels and paired comparison', () => {
    expect(egressFor('ollama:qwen3-embedding:8b', true)).toBe('local embedding, hosted reranking');
    expect(egressFor('ollama:qwen3-embedding:8b', false)).toMatch(/^local:/);
    const firsts = Array.from({ length: 41 }, (_, i) => (i % 2));
    const a = cellFrom('cat13-voyage-4-rerank-on.receipt.json', receipt('voyage:voyage-4', firsts, 41) as never);
    const b = cellFrom('cat13-voyage-4-large-rerank-on.receipt.json', receipt('voyage:voyage-4-large', firsts.map(() => 1), 41) as never);
    const r = compare(a, b);
    expect(r.delta).toBeCloseTo(0.5, 8);
    expect(r.mcnemar.gained).toBe(20);
    const s = summarize([a, b]);
    expect(s.families[0]!.comparisons).toHaveLength(1);
    expect(s.cells[0]).not.toHaveProperty('rows');
  });
});
