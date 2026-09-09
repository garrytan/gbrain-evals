import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import type { HybridSearchMeta, SearchResult } from 'gbrain/types';
import { hybridSearch } from 'gbrain/search/hybrid';
import { pagesInResultOrder } from '../../eval/runner/adapters/page-results.ts';
import {
  parseRelationalArgs, RELATIONAL_EMBEDDER, RELATIONAL_LIMIT,
  runRelationalAB, scoreRelationalArm, searchRelationalPair, summarizeRelationalRows, vectorHash,
  type PairedRow, type RelationalSearch,
} from '../../eval/runner/relational-ab.ts';
import { validateReceipt } from '../../eval/runner/receipt.ts';

const row = (slug: string, score: number, chunk_id = 1): SearchResult => ({ slug, score, chunk_id } as SearchResult);
const metadata = (): HybridSearchMeta => ({ vector_enabled: true, detail_resolved: 'medium', expansion_applied: false, degraded: [] });
const query = { id: 'q-example', text: 'Who invested in Acme Example?' };
const vector = () => {
  const v = new Float32Array(RELATIONAL_EMBEDDER.dimensions);
  v[0] = 1;
  return v;
};

function observingSearch(results: SearchResult[]): RelationalSearch {
  return async (_engine, text, opts) => {
    await opts.queryEmbedFn!(text);
    opts.onMeta!(metadata());
    if (opts.relationalRetrieval) opts.onRelationalMeta!({ fired: true, kind: 'who_rel', seeds_resolved: 1, candidates: 1, errored: false, duration_ms: 0 });
    return results;
  };
}

describe('product result order', () => {
  test('a promoted low-score page stays first, including when another chunk has a higher old score', () => {
    const result = pagesInResultOrder([
      row('people/investor-example', 0.01),
      row('companies/noisy-example', 0.99),
      row('people/investor-example', 1.5, 2),
      row('companies/last-example', 0.5),
    ], 3);
    expect(result).toEqual([
      { page_id: 'people/investor-example', score: 0.01, rank: 1 },
      { page_id: 'companies/noisy-example', score: 0.99, rank: 2 },
      { page_id: 'companies/last-example', score: 0.5, rank: 3 },
    ]);
  });

  test('five chunks from two pages produce two pages, without refilling precision slots', async () => {
    const pair = await searchRelationalPair({} as PGLiteEngine, query, vector(), observingSearch([
      row('people/answer-example', 0.1, 1), row('people/answer-example', 0.9, 2),
      row('companies/other-example', 0.8, 3), row('companies/other-example', 0.7, 4), row('companies/other-example', 0.6, 5),
    ]));
    const scored = scoreRelationalArm(pair.on, new Set(['people/answer-example', 'people/missing-example']));
    expect(scored.pages).toEqual(['people/answer-example', 'companies/other-example']);
    expect(scored.metrics).toEqual({ precision_at_5: 0.2, recall_at_5: 0.5, hit_at_1: 1, hit_at_5: 1 });
    const empty = await searchRelationalPair({} as PGLiteEngine, query, vector(), observingSearch([]));
    expect(scoreRelationalArm(empty.off, new Set(['people/answer-example'])).metrics?.precision_at_5).toBe(0);
  });
});

describe('paired retrieval boundary', () => {
  test('ordinary empty arms and configured token clipping remain valid measured outcomes', async () => {
    const pair = await searchRelationalPair({} as PGLiteEngine, query, vector(), async (_engine, text, opts) => {
      await opts.queryEmbedFn!(text);
      opts.onMeta!({ ...metadata(), degraded: [{ stage: 'keyword_relaxed_carried' }, { stage: 'budget_truncated' }] });
      if (opts.relationalRetrieval) opts.onRelationalMeta!({ fired: false, kind: null, seeds_resolved: 0, candidates: 0, errored: false, duration_ms: 0 });
      return [];
    });
    expect(pair.off.error).toBeUndefined();
    expect(pair.on.error).toBeUndefined();
    expect(scoreRelationalArm(pair.off, new Set(['people/example'])).metrics?.recall_at_5).toBe(0);
    expect(pair.off.search_meta?.degraded).toHaveLength(2);
  });

  test('same engine, query vector bytes and limits; only the relational switch differs', async () => {
    const engine = {} as PGLiteEngine;
    const shared = vector();
    const calls: Array<{ engine: PGLiteEngine; text: string; config: unknown; vector: Float32Array }> = [];
    const pair = await searchRelationalPair(engine, query, shared, async (receivedEngine, text, opts) => {
      const embedded = await opts.queryEmbedFn!(text);
      const { relationalRetrieval, queryEmbedFn, onMeta, onRelationalMeta, ...config } = opts;
      calls.push({ engine: receivedEngine, text, config, vector: embedded });
      expect(relationalRetrieval).toBe(calls.length === 2);
      onMeta!(metadata());
      if (relationalRetrieval) onRelationalMeta!({ fired: true, kind: 'who_rel', seeds_resolved: 1, candidates: 1, errored: false, duration_ms: 0 });
      return [row('people/investor-example', 0.01), row('companies/distractor-example', 0.99)];
    });
    expect(calls).toHaveLength(2);
    expect(calls.every(c => c.engine === engine && c.text === query.text)).toBe(true);
    expect(calls[0].config).toEqual(calls[1].config);
    expect((calls[0].config as { limit: number }).limit).toBe(RELATIONAL_LIMIT);
    expect(calls[0].vector).not.toBe(calls[1].vector);
    expect(vectorHash(calls[0].vector)).toBe(vectorHash(calls[1].vector));
    expect(pair.off.query_vector_sha256).toBe(pair.on.query_vector_sha256);
    expect(pair.off.pages).toEqual(['people/investor-example', 'companies/distractor-example']);
    expect(pair.off.error).toBeUndefined();
    expect(pair.on.error).toBeUndefined();
  });

  test('a fail-open relational error is a scored system failure, not an ordinary empty arm', async () => {
    const pair = await searchRelationalPair({} as PGLiteEngine, query, vector(), async (_engine, text, opts) => {
      await opts.queryEmbedFn!(text);
      opts.onMeta!(metadata());
      if (opts.relationalRetrieval) opts.onRelationalMeta!({ fired: false, kind: 'who_rel', seeds_resolved: 1, candidates: 0, errored: true, duration_ms: 0 });
      return [row('people/answer-example', 1)];
    });
    const relevant = new Set(['people/answer-example']);
    expect(pair.on.error?.origin).toBe('sut');
    expect(scoreRelationalArm(pair.on, relevant).metrics?.recall_at_5).toBe(0);
    const summary = summarizeRelationalRows([{
      seed: 1, index_id: 'shared', query_id: query.id, text: query.text, template: 'invested_in', relevant: [...relevant],
      off: scoreRelationalArm(pair.off, relevant), on: scoreRelationalArm(pair.on, relevant),
    }]);
    expect(summary.paired.recall_at_5.losses).toBe(1);
  });

  test('missing relational observations and a disabled vector arm invalidate the cell', async () => {
    const missing = await searchRelationalPair({} as PGLiteEngine, query, vector(), async (_engine, text, opts) => {
      await opts.queryEmbedFn!(text); opts.onMeta!(metadata()); return [];
    });
    expect(missing.on.error?.origin).toBe('harness');
    expect(scoreRelationalArm(missing.on, new Set(['people/example'])).metrics).toBeNull();
    const fallback = await searchRelationalPair({} as PGLiteEngine, query, vector(), async (_engine, text, opts) => {
      await opts.queryEmbedFn!(text);
      opts.onMeta!({ ...metadata(), vector_enabled: false });
      return [];
    });
    expect(fallback.off.error?.origin).toBe('harness');
    expect(fallback.on.error?.origin).toBe('harness');
  });

  test('invalid vectors and misspelled CLI options fail before search', async () => {
    await expect(searchRelationalPair({} as PGLiteEngine, query, new Float32Array(3), observingSearch([]))).rejects.toThrow('invalid shared query vector');
    expect(() => parseRelationalArgs(['--seeds', '1,1'])).toThrow('distinct');
    expect(() => parseRelationalArgs(['--limit', '0'])).toThrow('positive');
    expect(() => parseRelationalArgs(['--relatonal-off'])).toThrow('unknown');
    expect(parseRelationalArgs(['--reports-dir', '/tmp/report-example', '--seeds', '1,2,3'])).toEqual({ reportsDir: '/tmp/report-example', seeds: [1, 2, 3] });
  });
});

describe('real import, extraction and receipt (hash embeddings, no provider)', () => {
  let temp: string;
  let corpus: string;
  beforeAll(() => {
    temp = mkdtempSync(join(tmpdir(), 'relational-ab-'));
    corpus = join(temp, 'corpus');
    mkdirSync(corpus);
    const pages = [
      { slug: 'companies/acme-example', type: 'company', title: 'Acme Example', compiled_truth: 'Acme Example builds payment software.', _facts: { type: 'company', investors: ['people/investor-example'] } },
      { slug: 'people/investor-example', type: 'person', title: 'Investor Example', compiled_truth: 'Investor Example invested in [Acme Example](companies/acme-example).', _facts: { type: 'person' } },
      ...Array.from({ length: 5 }, (_, i) => ({ slug: `concepts/filler-example-${i}`, type: 'concept', title: `Filler Example ${i}`, compiled_truth: `Payment software research notes and venture funding overview ${i}.`, _facts: { type: 'concept' } })),
    ];
    for (const [i, page] of pages.entries()) writeFileSync(join(corpus, `${i}.json`), JSON.stringify({ ...page, timeline: '' }));
  });
  afterAll(() => { rmSync(temp, { recursive: true, force: true }); });

  test('one extracted index serves both arms, reports live product telemetry, and never publishes hash scores', async () => {
    const reportsDir = join(temp, 'good');
    let nonrelational: Awaited<ReturnType<typeof searchRelationalPair>> | undefined;
    const { receipt, exitCode } = await runRelationalAB({ corpusDir: corpus, reportsDir, seeds: [1], stubEmbed: true, quiet: true }, async (engine, text, opts) => {
      const results = await hybridSearch(engine, text, opts);
      if (opts.relationalRetrieval) {
        nonrelational = await searchRelationalPair(engine, { id: 'content-example', text: 'payment software research notes' }, vector());
      }
      return results;
    });
    expect(exitCode).toBe(0);
    expect(receipt.errors).toEqual([]);
    expect(validateReceipt(receipt)).toEqual([]);
    expect(receipt.verdict).toBe('partial');
    expect(receipt.publishable).toBe(false);
    const rows = receipt.data!.per_query as PairedRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].off.query_vector_sha256).toBe(rows[0].on.query_vector_sha256);
    expect(rows[0].off.relational_meta).toEqual([]);
    expect(rows[0].on.relational_meta.some(m => m.fired && m.candidates > 0)).toBe(true);
    expect(rows[0].on.pages).toContain('people/investor-example');
    expect(receipt.data!.indices).toHaveLength(1);
    expect(nonrelational).toBeDefined();
    expect(nonrelational!.off.error).toBeUndefined();
    expect(nonrelational!.on.error).toBeUndefined();
    expect(nonrelational!.off.pages).toEqual(nonrelational!.on.pages);
    expect(nonrelational!.on.relational_meta.every(m => m.kind === null && !m.fired)).toBe(true);
    const report = JSON.parse(readFileSync(join(reportsDir, 'relational-ab/report.json'), 'utf8'));
    expect(report.per_query[0].index_id).toBe(rows[0].index_id);
  }, 120_000);

  test('a fail-open ON query leaves an invalid receipt instead of a plausible comparison', async () => {
    const { receipt, exitCode } = await runRelationalAB({ corpusDir: corpus, outputDir: join(temp, 'failed'), seeds: [1], stubEmbed: true, quiet: true }, async (_engine, text, opts) => {
      await opts.queryEmbedFn!(text); opts.onMeta!(metadata());
      if (opts.relationalRetrieval) opts.onRelationalMeta!({ fired: false, kind: 'who_rel', seeds_resolved: 1, candidates: 0, errored: true, duration_ms: 0 });
      return [];
    });
    expect(exitCode).toBe(1);
    expect(receipt.run_status).toBe('error');
    expect(receipt.publishable).toBe(false);
    expect(receipt.n_scored).toBe(2); // SUT failure stays in the denominator.
    expect(receipt.errors).toHaveLength(1);
    expect(receipt.errors[0].origin).toBe('sut');
    expect(validateReceipt(receipt)).toEqual([]);
  }, 120_000);
});
