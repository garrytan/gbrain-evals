/**
 * cat18-embedding-providers.ts regression tests (audit cats18-21-02/03/11/14/18).
 *
 * Hermetic: no API keys. Embeds run through gbrain's __setEmbedTransportForTests
 * seam with a deterministic feature-hash transport (runner --stub-embed path).
 *
 * Gates proven failable AND passing:
 *   - recall can no longer exceed 1.0 on duplicate chunk rows (scoreQuery)
 *   - reranker/mode pinned per cell + echoed in resolved_config
 *   - failed/degraded queries stay in the accounting (dependency errors,
 *     n_scored < n_total, cell invalid, non-zero exit) instead of vanishing
 *   - incomplete embed coverage flags the cell (evidence fields recorded)
 *   - missing provider keys → receipt run_status 'skipped' + non-zero exit
 *     unless --allow-skip
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  hashEmbedVector,
  scoreQuery,
  computeVerdict,
  runCat18,
  PINNED_CONFIG,
  CAT18_CATEGORY,
  K,
  type ProviderCell,
} from '../../eval/runner/cat18-embedding-providers.ts';
import type { SyntheticPage, SyntheticQuery } from '../../eval/runner/synthetic-corpus-loader.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';

const RUN_TIMEOUT = 180_000;

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat18-test-reports-'));
}

const PAGES: SyntheticPage[] = [
  { slug: 'companies/acme-ai', type: 'company', body: '# Acme AI\n\nAcme AI builds vertical dental agents for clinics.' },
  { slug: 'people/alice-example', type: 'person', body: '# Alice Example\n\nAlice Example founded [[companies/acme-ai]] and works on dental agents daily.' },
  { slug: 'people/bob-example', type: 'person', body: '# Bob Example\n\nBob Example invests in fintech infrastructure and payment rails.' },
  { slug: 'concepts/payment-rails', type: 'concept', body: '# Payment rails\n\nPayment rails move money between banks for fintech companies.' },
];

const QUERIES: SyntheticQuery[] = [
  { id: 'q1', text: 'Who founded Acme AI dental agents?', relevant_slugs: ['people/alice-example', 'companies/acme-ai'] },
  { id: 'q2', text: 'Who invests in fintech payment rails?', relevant_slugs: ['people/bob-example'] },
];

// ─── hashEmbedVector (stub determinism) ──────────────────────────────

describe('hashEmbedVector', () => {
  test('deterministic, unit-norm, dim-sized', () => {
    const a1 = hashEmbedVector('dental agents for clinics', 64);
    const a2 = hashEmbedVector('dental agents for clinics', 64);
    expect(a1).toEqual(a2);
    expect(a1.length).toBe(64);
    const norm = Math.sqrt(a1.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  test('similar texts are closer than dissimilar texts', () => {
    const cos = (x: number[], y: number[]): number => x.reduce((s, v, i) => s + v * y[i], 0);
    const base = hashEmbedVector('alice founded acme dental agents', 256);
    const similar = hashEmbedVector('who founded acme dental agents', 256);
    const dissimilar = hashEmbedVector('payment rails move money between banks', 256);
    expect(cos(base, similar)).toBeGreaterThan(cos(base, dissimilar));
  });
});

// ─── scoreQuery: duplicate-chunk recall inflation (cats18-21-02) ─────

describe('scoreQuery page normalization', () => {
  test('duplicate chunk rows for one relevant page count once — recall never exceeds 1.0', () => {
    // gbrain dedup returns up to 2 chunks/page; the old counter incremented
    // per row, yielding 2/1 = 200% recall here.
    const s = scoreQuery(['a', 'a', 'x', 'b', 'b'], ['a'], 10);
    expect(s.recall).toBe(1);
    expect(s.recall).toBeLessThanOrEqual(1);
  });

  test('fractional recall over the distinct relevant set', () => {
    const s = scoreQuery(['a', 'a', 'x'], ['a', 'c'], 10);
    expect(s.recall).toBe(0.5);
  });

  test('rank metrics computed on page-normalized order within top-k', () => {
    const s = scoreQuery(['x', 'x', 'a'], ['a'], 10);
    // pages: x (rank 1), a (rank 2) → rr = 1/2
    expect(s.rr).toBe(0.5);
    expect(s.top1).toBe(false);
    // relevant page beyond k is a miss
    const far = scoreQuery(['p1', 'p2', 'p3', 'a'], ['a'], 3);
    expect(far.recall).toBe(0);
    expect(far.rr).toBe(0);
  });
});

// ─── computeVerdict is real + failable ───────────────────────────────

describe('computeVerdict', () => {
  const cell = (over: Partial<ProviderCell>): ProviderCell => ({
    cell: 'c', embedder: 'e', dim: 1,
    ingest_ok: 0, ingest_fail: 0, first_ingest_error: null,
    pages_total: 0, pages_embedded: 0, chunks_total: 0, chunks_embedded: 0,
    embedding_column: null,
    queries_total: 0, queries_scored: 0, query_errors: 0,
    degraded_queries: 0, rerank_scored_queries: 0,
    mrr: null, recall_at_10: null, top1_hit_rate: null,
    mean_query_ms: null, p50_query_ms: null, embed_ingest_ms: 0,
    valid: true, invalid_reasons: [],
    ...over,
  });

  test('pass requires every cell valid AND above the recall floor', () => {
    expect(computeVerdict([cell({ recall_at_10: 0.9 })], 1, 0.5).verdict).toBe('pass');
    expect(computeVerdict([cell({ recall_at_10: 0.4 })], 1, 0.5).verdict).toBe('fail');
    expect(computeVerdict([cell({ valid: false, invalid_reasons: ['x'] })], 1, 0.5).verdict).toBe('fail');
    expect(computeVerdict(
      [cell({ recall_at_10: 0.9 }), cell({ cell: 'c2', valid: false, invalid_reasons: ['broken'] })],
      2, 0.5,
    ).verdict).toBe('partial');
  });
});

// ─── Full hermetic runs ──────────────────────────────────────────────

describe('runCat18 (hermetic, stubbed embed transport)', () => {
  test('good input: completes, pins reranker off + mode balanced, full coverage, verdict pass, exit 0', async () => {
    const reportsDir = tmpReports();
    const r = await runCat18({
      providers: ['openai'],
      pages: PAGES,
      queries: QUERIES,
      stubEmbed: true,
      reportsDir,
      quiet: true,
    });
    expect(r.receipt.run_status).toBe('completed');
    expect(r.receipt.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    // WS5 pin recorded in resolved_config (cats18-21-03)
    const rc = r.receipt.resolved_config as Record<string, any>;
    expect(rc.search_mode).toBe('balanced');
    expect(rc.reranker_enabled).toBe(false);
    expect(rc.pinned_config).toEqual(PINNED_CONFIG);
    expect(rc.embed_transport).toBe('stubbed-hash');
    // Stub runs are never publishable as provider comparisons
    expect(r.receipt.publishable).toBe(false);
    // Denominators: every planned probe scored
    expect(r.receipt.n_total).toBe(QUERIES.length);
    expect(r.receipt.n_scored).toBe(QUERIES.length);
    expect(r.receipt.errors).toEqual([]);
    // Embed-coverage evidence queried from the engine (cats18-21-14)
    const c = r.cells[0];
    expect(c.chunks_total).toBeGreaterThan(0);
    expect(c.chunks_embedded).toBe(c.chunks_total);
    expect(c.pages_embedded).toBe(PAGES.length);
    expect(c.embedding_column).toBe('embedding');
    // Reranker verifiably silent in every query (embedder-only comparison)
    expect(c.rerank_scored_queries).toBe(0);
    // Recall sane: page-normalized, never above 1
    expect(c.recall_at_10).toBeGreaterThan(0);
    expect(c.recall_at_10!).toBeLessThanOrEqual(1);
    // gbrain_version provenance is real, not 'unknown' (cats18-21-18)
    expect(r.receipt.gbrain_version).not.toBe('unknown');
    expect(r.receipt.gbrain_pin).not.toBe('unknown');
    // Receipt on disk is valid + loadable at the canonical path
    const loaded = loadReceipt(receiptPath(CAT18_CATEGORY, reportsDir));
    expect(loaded.category).toBe(CAT18_CATEGORY);
  }, RUN_TIMEOUT);

  test('bad input (query-embed outage): probe stays in denominator as dependency error, cell invalid, non-zero exit', async () => {
    const reportsDir = tmpReports();
    const queries: SyntheticQuery[] = [
      ...QUERIES,
      { id: 'q3', text: 'zzfailquery what about dental clinics?', relevant_slugs: ['companies/acme-ai'] },
    ];
    const r = await runCat18({
      providers: ['openai'],
      pages: PAGES,
      queries,
      stubEmbed: true,
      stubFailOn: t => t.includes('zzfailquery'),
      reportsDir,
      quiet: true,
    });
    // The failed query did NOT vanish (old code `continue`d it away — cats18-21-11)
    expect(r.receipt.n_total).toBe(queries.length);
    expect(r.receipt.n_scored).toBe(queries.length - 1);
    const depErrors = r.receipt.errors.filter(e => e.origin === 'dependency');
    expect(depErrors.length).toBe(1);
    expect(depErrors[0].probe_id).toBe('openai:q3');
    // Keyword-only fallback detected, not published under the embedder label
    const c = r.cells[0];
    expect(c.degraded_queries).toBe(1);
    expect(c.valid).toBe(false);
    // A cell with errors can never be part of a passing comparison
    expect(r.receipt.verdict).not.toBe('pass');
    expect(r.exitCode).not.toBe(0);
    expect(r.receipt.publishable).toBe(false);
    const data = r.receipt.data as Record<string, any>;
    expect(data.comparison.valid).toBe(false);
    expect(data.comparison.excluded_cells).toContain('openai');
  }, RUN_TIMEOUT);

  test('bad input (ingest-embed outage): incomplete coverage flags the cell and errors every probe', async () => {
    const reportsDir = tmpReports();
    const pages: SyntheticPage[] = [
      ...PAGES,
      { slug: 'concepts/zzfaildoc', type: 'concept', body: '# Broken\n\nzzfaildoc this page cannot embed.' },
    ];
    const r = await runCat18({
      providers: ['openai'],
      pages,
      queries: QUERIES,
      stubEmbed: true,
      stubFailOn: t => t.includes('zzfaildoc'),
      reportsDir,
      quiet: true,
    });
    const c = r.cells[0];
    expect(c.ingest_fail).toBe(1);
    expect(c.first_ingest_error).toBeTruthy();
    expect(c.valid).toBe(false);
    expect(c.invalid_reasons.join(' ')).toContain('coverage');
    // Every planned probe recorded as dependency error, none silently dropped
    expect(r.receipt.errors.length).toBe(QUERIES.length);
    expect(r.receipt.errors.every(e => e.origin === 'dependency')).toBe(true);
    expect(r.receipt.n_scored).toBe(0);
    expect(r.exitCode).not.toBe(0);
  }, RUN_TIMEOUT);

  test('missing provider keys: receipt run_status skipped, non-zero exit unless allow-skip', async () => {
    const saved = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    try {
      const reportsDir = tmpReports();
      const r = await runCat18({
        providers: ['voyage'],
        pages: PAGES,
        queries: QUERIES,
        reportsDir,
        quiet: true,
      });
      expect(r.receipt.run_status).toBe('skipped');
      expect(r.receipt.skip_reason).toContain('VOYAGE_API_KEY');
      expect(r.receipt.publishable).toBe(false);
      expect(r.exitCode).toBe(1);

      const r2 = await runCat18({
        providers: ['voyage'],
        pages: PAGES,
        queries: QUERIES,
        reportsDir,
        allowSkip: true,
        quiet: true,
      });
      expect(r2.receipt.run_status).toBe('skipped');
      expect(r2.exitCode).toBe(0);
    } finally {
      if (saved !== undefined) process.env.VOYAGE_API_KEY = saved;
      else delete process.env.VOYAGE_API_KEY;
    }
  }, RUN_TIMEOUT);
});
