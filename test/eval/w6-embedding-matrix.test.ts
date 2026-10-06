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
