import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import {
  queryEvidence,
  recordQueryFailure,
  runCat18,
  scoreQuery,
  type ProviderCell,
  type QueryEvidence,
} from '../../eval/runner/cat18-embedding-providers.ts';
import { CELLS, runCat18b, type MatrixCell } from '../../eval/runner/cat18b-embedding-rerank-matrix.ts';
import {
  CAT24_PROBE_IDS,
  runCat24,
  type PathProbe,
  type PreservationProbeEvidence,
  type ProvenanceProbeEvidence,
  type SchemaProbeEvidence,
} from '../../eval/runner/cat24-capture-provenance.ts';
import { percentile } from '../../eval/runner/metrics.ts';
import { ProbeAccounting } from '../../eval/runner/probe-accounting.ts';
import { loadReceipt, type Receipt } from '../../eval/runner/receipt.ts';
import type { SyntheticPage, SyntheticQuery } from '../../eval/runner/synthetic-corpus-loader.ts';

const RUN_TIMEOUT = 240_000;
const PAGES: SyntheticPage[] = [
  { slug: 'companies/example-clinics', type: 'company', body: '# Example Clinics\n\nExample Clinics builds dental agents for clinics.' },
  { slug: 'concepts/payment-rails', type: 'concept', body: '# Payment rails\n\nPayment rails move money between banks for fintech companies.' },
];
const QUERIES: SyntheticQuery[] = [
  { id: 'dental', text: 'Example Clinics dental agents', relevant_slugs: ['companies/example-clinics', 'companies/missing-clinic', 'companies/example-clinics'] },
  { id: 'payments', text: 'fintech payment rails banks', relevant_slugs: ['concepts/payment-rails'] },
];
const OPENAI_PAIR = CELLS.filter(c => c.embedder === 'openai:text-embedding-3-large');
const ENV_KEYS = ['GBRAIN_HOME', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY'];
let savedEnv: Record<string, string | undefined>;
let reportsDir: string;
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  reportsDir = mkdtempSync(join(tmpdir(), 'native-evidence-18-24-'));
  network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in native evidence tests'));
});

afterEach(() => {
  const calls = network.mock.calls.length;
  network.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(reportsDir, { recursive: true, force: true });
  expect(calls).toBe(0);
});

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function verifyQueryEvidence(cell: ProviderCell | MatrixCell, queries: SyntheticQuery[], receipt: Receipt): QueryEvidence[] {
  expect(cell.per_query).toBeDefined();
  const rows = cell.per_query!;
  expect(rows.map(row => row.query_id)).toEqual(queries.map(query => query.id));
  expect(new Set(rows.map(row => row.probe_id)).size).toBe(queries.length);
  expect(rows.length).toBe(cell.queries_total);
  const scored = rows.filter(row => row.scored);
  expect(scored.length).toBe(cell.queries_scored);
  expect(rows.length - scored.length).toBe(cell.query_errors);
  for (const [index, row] of rows.entries()) {
    expect(row.probe_id).toBe(`${cell.cell}:${queries[index].id}`);
    expect(row.relevant_ids).toEqual([...new Set(queries[index].relevant_slugs)]);
    if (row.scored) {
      expect(row.status).toBe('scored');
      expect(row.error).toBeNull();
      const score = scoreQuery(row.ranked_ids!, queries[index].relevant_slugs, row.k);
      expect(row.ranked_ids).toEqual(score.page_ids);
      expect(row.recall_at_10).toBe(score.recall);
      expect(row.mrr).toBe(score.rr);
      expect(row.top1_hit_rate).toBe(score.top1 ? 1 : 0);
      expect(row.query_ms).toBeGreaterThanOrEqual(0);
    } else {
      expect(row.status).toBe('error');
      expect(row.recall_at_10).toBeNull();
      expect(row.mrr).toBeNull();
      expect(row.top1_hit_rate).toBeNull();
      expect(row.error).toEqual(receipt.errors.find(error => error.probe_id === row.probe_id)!);
    }
  }
  expect(cell.recall_at_10).toBe(mean(scored.map(row => row.recall_at_10!)));
  expect(cell.mrr).toBe(mean(scored.map(row => row.mrr!)));
  expect(cell.top1_hit_rate).toBe(mean(scored.map(row => row.top1_hit_rate!)));
  expect(cell.mean_query_ms).toBe(mean(scored.map(row => row.query_ms!)));
  expect(cell.p50_query_ms).toBe(scored.length ? percentile(scored.map(row => row.query_ms!), 50) : null);
  return rows;
}

type Cat24Data = {
  per_probe: ProvenanceProbeEvidence[];
  per_path: PathProbe[];
  schema_test: SchemaProbeEvidence;
  preservation_test: PreservationProbeEvidence;
  dedup_test: { before_rows: number; after_rows: number; distinct_page_ids: number; reimport_status: string };
};

function verifyProvenanceEvidence(receipt: Receipt): Cat24Data {
  const data = receipt.data as unknown as Cat24Data;
  expect(data.per_probe.map(row => row.probe_id)).toEqual([...CAT24_PROBE_IDS]);
  expect(new Set(data.per_probe.map(row => row.probe_id)).size).toBe(7);
  expect(receipt.n_total).toBe(7);
  expect(receipt.n_scored).toBe(data.per_probe.length);
  expect(receipt.completion_rate).toBe(1);
  expect(receipt.verdict).toBe(data.per_probe.every(row => row.score === 1) ? 'pass' : 'fail');
  for (const row of data.per_probe) {
    expect(row.pass).toBe(row.score === 1);
    if (row.pass) expect(row.error).toBeNull();
    else expect(row.error).toEqual(receipt.errors.find(error => error.probe_id === row.probe_id)!);
  }
  for (const path of data.per_path) {
    expect(data.per_probe.find(row => row.probe_id === path.probe_id)!.pass).toBe(path.pass);
  }
  for (const detail of [data.schema_test, data.preservation_test]) {
    const row = data.per_probe.find(row => row.probe_id === detail.probe_id)!;
    expect(detail.score).toBe(row.score);
    expect(detail.pass).toBe(row.pass);
    expect(detail.error).toEqual(row.error);
  }
  return data;
}

describe('native query observations retain the original denominators', () => {
  test('query rows retain distinct IDs, fractional scoring, zero misses, and accounting error truncation', () => {
    const first = scoreQuery(['hit', 'hit', 'other'], ['hit', 'missing', 'hit'], 10);
    const query = { id: 'fractional', text: 'fixture query', relevant_slugs: ['hit', 'missing', 'hit'] };
    const row = queryEvidence('fixture', query, 10, ['hit', 'hit', 'other'], 12, first);
    expect(row.ranked_ids).toEqual(['hit', 'other']);
    expect(row.relevant_ids).toEqual(['hit', 'missing']);
    expect(row.recall_at_10).toBe(0.5);
    const miss = queryEvidence('fixture', query, 10, [], 3, scoreQuery([], query.relevant_slugs, 10));
    expect(miss.scored).toBe(true);
    expect([miss.recall_at_10, miss.mrr, miss.top1_hit_rate]).toEqual([0, 0, 0]);
    const acc = new ProbeAccounting(1);
    const failed = recordQueryFailure(acc, 'fixture', query, 10, 'dependency', 'x'.repeat(600));
    expect(failed.error).toEqual(acc.summary().errors[0]);
    expect(failed.error!.message.length).toBe(501);
    expect(failed.scored).toBe(false);
    expect(failed.recall_at_10).toBeNull();
    expect(acc.summary().n_total).toBe(1);
    expect(acc.summary().n_scored).toBe(0);
  });

  test('Cat18 preserves successful, missed, degraded, and empty-gold queries without scoring failures', async () => {
    const queries = [
      ...QUERIES,
      { id: 'miss', text: 'dental agents for clinics', relevant_slugs: ['companies/not-in-corpus'] },
      { id: 'empty-gold', text: 'payment rails infrastructure', relevant_slugs: [] },
      { id: 'outage', text: 'zzfailquery dental agents clinics', relevant_slugs: ['companies/example-clinics'] },
    ];
    const result = await runCat18({ providers: ['openai'], pages: PAGES, queries, stubEmbed: true, stubFailOn: text => text.includes('zzfailquery'), reportsDir, quiet: true });
    const receipt = loadReceipt(result.receiptFile);
    const cells = receipt.data!.cells as ProviderCell[];
    const rows = verifyQueryEvidence(cells[0], queries, receipt);
    expect(receipt.n_total).toBe(5);
    expect(receipt.n_scored).toBe(3);
    expect(rows.find(row => row.query_id === 'miss')!.recall_at_10).toBe(0);
    expect(rows.find(row => row.query_id === 'empty-gold')!.error!.origin).toBe('harness');
    const outage = rows.find(row => row.query_id === 'outage')!;
    expect(outage.error!.origin).toBe('dependency');
    expect(outage.ranked_ids!.length).toBeGreaterThan(0);
    expect(outage.query_ms).toBeGreaterThanOrEqual(0);
    expect(cells[0].valid).toBe(false);
    expect(receipt.publishable).toBe(false);
  }, RUN_TIMEOUT);

  test('Cat18b successful cell means and pair deltas equal the retained per-query observations', async () => {
    const result = await runCat18b({ cells: OPENAI_PAIR, pages: PAGES, queries: QUERIES, stub: true, reportsDir, quiet: true });
    const receipt = loadReceipt(result.receiptFile);
    const cells = receipt.data!.cells as MatrixCell[];
    const [base, reranked] = cells.map(cell => verifyQueryEvidence(cell, QUERIES, receipt));
    const pairs = receipt.data!.pairs as Array<{ recall_delta: number; mrr_delta: number; top1_delta: number }>;
    expect(pairs[0].recall_delta).toBeCloseTo(mean(reranked.map((row, i) => row.recall_at_10! - base[i].recall_at_10!))!, 12);
    expect(pairs[0].mrr_delta).toBeCloseTo(mean(reranked.map((row, i) => row.mrr! - base[i].mrr!))!, 12);
    expect(pairs[0].top1_delta).toBeCloseTo(mean(reranked.map((row, i) => row.top1_hit_rate! - base[i].top1_hit_rate!))!, 12);
    expect(receipt.n_scored).toBe(4);
    expect(receipt.errors).toEqual([]);
    expect(cells.every(cell => cell.valid)).toBe(true);
  }, RUN_TIMEOUT);

  test('Cat18b retains fail-open rankings and errors but excludes their metrics and pair deltas', async () => {
    const result = await runCat18b({ cells: OPENAI_PAIR, pages: PAGES, queries: QUERIES, stub: true, stubRerankRespondWith: () => new Response('unauthorized', { status: 401 }), reportsDir, quiet: true });
    const receipt = loadReceipt(result.receiptFile);
    const cells = receipt.data!.cells as MatrixCell[];
    for (const cell of cells) verifyQueryEvidence(cell, QUERIES, receipt);
    const reranked = cells.find(cell => cell.reranker !== null)!;
    expect(reranked.per_query!.every(row => !row.scored && row.error!.message.includes('fail-open'))).toBe(true);
    expect(reranked.per_query!.every(row => row.ranked_ids!.length > 0 && row.query_ms! >= 0)).toBe(true);
    expect(receipt.n_total).toBe(4);
    expect(receipt.n_scored).toBe(2);
    expect((receipt.data!.pairs as Array<{ recall_delta: number | null }>)[0].recall_delta).toBeNull();
  }, RUN_TIMEOUT);

  for (const category of ['cat18', 'cat18b'] as const) {
    test(`${category} incomplete ingestion retains every planned query as an unexecuted dependency failure`, async () => {
      const pages = [...PAGES, { slug: 'concepts/broken', type: 'concept', body: '# Broken\n\nzzfaildoc cannot embed.' }];
      const result = category === 'cat18'
        ? await runCat18({ providers: ['openai'], pages, queries: QUERIES, stubEmbed: true, stubFailOn: text => text.includes('zzfaildoc'), reportsDir, quiet: true })
        : await runCat18b({ cells: [OPENAI_PAIR[0]], pages, queries: QUERIES, stub: true, stubEmbedFailOn: text => text.includes('zzfaildoc'), reportsDir, quiet: true });
      const receipt = loadReceipt(result.receiptFile);
      const cell = (receipt.data!.cells as Array<ProviderCell | MatrixCell>)[0];
      const rows = verifyQueryEvidence(cell, QUERIES, receipt);
      expect(rows.every(row => row.ranked_ids === null && row.query_ms === null && row.error!.origin === 'dependency')).toBe(true);
      expect(receipt.n_scored).toBe(0);
      expect(receipt.n_total).toBe(QUERIES.length);
    }, RUN_TIMEOUT);

    test(`${category} cell setup failure retains every query and the original harness error`, async () => {
      const setConfig = PGLiteEngine.prototype.setConfig;
      const setup = spyOn(PGLiteEngine.prototype, 'setConfig').mockImplementation(async function (this: PGLiteEngine, key, value) {
        if (key === 'search.mode') throw new Error('forced cell setup failure');
        return setConfig.call(this, key, value);
      });
      try {
        const result = category === 'cat18'
          ? await runCat18({ providers: ['openai'], pages: PAGES, queries: QUERIES, stubEmbed: true, reportsDir, quiet: true })
          : await runCat18b({ cells: [OPENAI_PAIR[0]], pages: PAGES, queries: QUERIES, stub: true, reportsDir, quiet: true });
        const receipt = loadReceipt(result.receiptFile);
        const cell = (receipt.data!.cells as Array<ProviderCell | MatrixCell>)[0];
        const rows = verifyQueryEvidence(cell, QUERIES, receipt);
        expect(rows.every(row => row.error!.origin === 'harness' && row.error!.message.includes('forced cell setup failure'))).toBe(true);
        expect(rows.every(row => row.ranked_ids === null && row.query_ms === null)).toBe(true);
        expect(receipt.n_scored).toBe(0);
      } finally {
        setup.mockRestore();
      }
    }, RUN_TIMEOUT);
  }
});

describe('Cat24 records all seven observed probe outcomes', () => {
  test('success includes actual schema completion and both rewrite snapshots and timestamps', async () => {
    const result = await runCat24({ reportsDir, quiet: true });
    const receipt = loadReceipt(result.receiptFile);
    const data = verifyProvenanceEvidence(receipt);
    expect(receipt.errors).toEqual([]);
    expect(data.per_probe.every(row => row.score === 1)).toBe(true);
    expect(data.schema_test.select_succeeded).toBe(true);
    expect(data.schema_test.selected_columns).toEqual(['source_kind', 'source_uri', 'ingested_via', 'ingested_at']);
    expect(data.per_path.length).toBe(4);
    expect(data.dedup_test.before_rows).toBe(1);
    expect(data.dedup_test.after_rows).toBe(1);
    expect(data.dedup_test.distinct_page_ids).toBe(1);
    const rewrite = data.preservation_test;
    expect(rewrite.before).toEqual(rewrite.after);
    expect(rewrite.before!.source_kind).toBe('capture-cli');
    expect(rewrite.at_before).toBe(rewrite.before!.ingested_at as string);
    expect(rewrite.at_after).toBe(rewrite.after!.ingested_at as string);
    expect(Number.isFinite(Date.parse(rewrite.at_before!))).toBe(true);
    expect(rewrite.at_after).toBe(rewrite.at_before);
  }, RUN_TIMEOUT);

  test('a spoofed provenance failure is a scored zero, not a missing or successful row', async () => {
    const result = await runCat24({ reportsDir, quiet: true, simulateBrokenTrustGate: true });
    const data = verifyProvenanceEvidence(loadReceipt(result.receiptFile));
    const row = data.per_probe.find(probe => probe.probe_id === 'op-put-page-remote-spoof-override')!;
    expect(row.score).toBe(0);
    expect(row.error!.origin).toBe('sut');
    expect(data.per_probe.filter(probe => probe.pass).length).toBe(6);
  }, RUN_TIMEOUT);

  test('a failed schema SELECT records all seven failures without inferring downstream success', async () => {
    const executeRaw = PGLiteEngine.prototype.executeRaw;
    const schemaFailure = spyOn(PGLiteEngine.prototype, 'executeRaw').mockImplementation(async function<T>(this: PGLiteEngine, sql: string, params?: unknown[], opts?: { signal?: AbortSignal }): Promise<T[]> {
      if (sql.includes('SELECT source_kind, source_uri, ingested_via, ingested_at FROM pages LIMIT 0')) {
        throw new Error('forced missing provenance column');
      }
      return executeRaw.call(this, sql, params, opts) as Promise<T[]>;
    });
    try {
      const result = await runCat24({ reportsDir, quiet: true });
      const receipt = loadReceipt(result.receiptFile);
      const data = verifyProvenanceEvidence(receipt);
      expect(receipt.errors.length).toBe(7);
      expect(data.per_probe.every(row => row.score === 0 && row.error!.origin === 'sut')).toBe(true);
      expect(data.schema_test.select_succeeded).toBe(false);
      expect(data.schema_test.error!.message).toContain('forced missing provenance column');
      expect(data.per_path).toEqual([]);
      expect(data.preservation_test.before).toBeNull();
      expect(data.preservation_test.after).toBeNull();
      expect(data.preservation_test.at_before).toBeNull();
      expect(data.preservation_test.at_after).toBeNull();
    } finally {
      schemaFailure.mockRestore();
    }
  }, RUN_TIMEOUT);

  test('rewrite timestamp drift retains both observed stamps and its scored failure', async () => {
    const executeRaw = PGLiteEngine.prototype.executeRaw;
    let contentReads = 0;
    const timestampDrift = spyOn(PGLiteEngine.prototype, 'executeRaw').mockImplementation(async function<T>(this: PGLiteEngine, sql: string, params?: unknown[], opts?: { signal?: AbortSignal }): Promise<T[]> {
      const rows = await executeRaw.call(this, sql, params, opts);
      if (sql.includes('SELECT source_kind, source_uri, ingested_via, ingested_at, source_path') && params?.[0] === 'inbox/2026-05-23-content-import') {
        contentReads++;
        if (contentReads === 3) {
          const row = rows[0] as { ingested_at: string | Date };
          rows[0] = { ...row, ingested_at: new Date(new Date(row.ingested_at).getTime() + 1000) };
        }
      }
      return rows as T[];
    });
    try {
      const result = await runCat24({ reportsDir, quiet: true });
      const data = verifyProvenanceEvidence(loadReceipt(result.receiptFile));
      const rewrite = data.preservation_test;
      expect(contentReads).toBe(3);
      expect(rewrite.score).toBe(0);
      expect(rewrite.error!.origin).toBe('sut');
      expect(rewrite.error!.message).toContain('ingested_at drifted');
      expect(rewrite.before!.ingested_at).not.toBe(rewrite.after!.ingested_at);
      expect(rewrite.at_before).toBe(rewrite.before!.ingested_at as string);
      expect(rewrite.at_after).toBe(rewrite.after!.ingested_at as string);
      expect(Date.parse(rewrite.at_after!) - Date.parse(rewrite.at_before!)).toBe(1000);
      expect(data.per_probe.filter(row => row.pass).length).toBe(6);
    } finally {
      timestampDrift.mockRestore();
    }
  }, RUN_TIMEOUT);
});
