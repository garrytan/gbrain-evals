/**
 * cat18b-embedding-rerank-matrix.ts regression tests (audit cats18-21-04/05/06).
 *
 * Hermetic: no API keys. Embeds via __setEmbedTransportForTests (feature-hash
 * vectors); reranks via __setRerankTransportForTests (deterministic
 * token-overlap scores) — both wired through the runner's --stub path.
 *
 * Gates proven failable AND passing:
 *   - the ± axis differs ONLY in search.reranker.* keys; search.mode is
 *     'balanced' in every cell (no more balanced↔tokenmax bundle confound)
 *   - a '+rerank' cell where the reranker fails open (401) is detected,
 *     marked invalid, and excluded from winner_by_axis — never published as
 *     a reranked result
 *   - ingest/query failures are typed probe errors, never bare-catch zeros
 *   - missing keys → skipped receipt + non-zero exit unless allow-skip
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CELLS,
  PINNED_BASE,
  rerankAxisConfig,
  makeOverlapRerankTransport,
  runCat18b,
  CAT18B_CATEGORY,
  type ProviderSpec,
} from '../../eval/runner/cat18b-embedding-rerank-matrix.ts';
import type { SyntheticPage, SyntheticQuery } from '../../eval/runner/synthetic-corpus-loader.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';

const RUN_TIMEOUT = 240_000;

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat18b-test-reports-'));
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

const OPENAI_PAIR: ProviderSpec[] = CELLS.filter(c => c.embedder === 'openai:text-embedding-3-large');

// ─── The ± axis is minimal (cats18-21-05) ────────────────────────────

describe('reranker axis config', () => {
  test('± pairs differ ONLY in search.reranker.* keys; mode constant', () => {
    for (const base of CELLS.filter(c => c.reranker === null)) {
      const plus = CELLS.find(c => c.embedder === base.embedder && c.reranker !== null)!;
      const basePin = { ...PINNED_BASE, ...rerankAxisConfig(base) };
      const plusPin = { ...PINNED_BASE, ...rerankAxisConfig(plus) };
      const allKeys = new Set([...Object.keys(basePin), ...Object.keys(plusPin)]);
      const differing = [...allKeys].filter(k => basePin[k] !== plusPin[k]);
      expect(differing.every(k => k.startsWith('search.reranker.'))).toBe(true);
      expect(basePin['search.mode']).toBe('balanced');
      expect(plusPin['search.mode']).toBe('balanced');
    }
  });

  test('every cell pins the reranker explicitly — no default-mode reliance', () => {
    for (const spec of CELLS) {
      const pin = rerankAxisConfig(spec);
      expect(pin['search.reranker.enabled']).toBe(spec.reranker ? 'true' : 'false');
    }
  });
});

// ─── Stub rerank transport ───────────────────────────────────────────

describe('makeOverlapRerankTransport', () => {
  test('deterministic overlap scoring in ZE response dialect', async () => {
    const transport = makeOverlapRerankTransport() as unknown as (u: string, init: { body: string }) => Promise<Response>;
    const body = JSON.stringify({
      query: 'dental agents',
      documents: ['payment rails move money', 'dental agents for clinics', 'dental things'],
    });
    const resp = await transport('http://stub.invalid/models/rerank', { body });
    expect(resp.status).toBe(200);
    const json = await resp.json() as { results: Array<{ index: number; relevance_score: number }> };
    expect(json.results[0].index).toBe(1); // both query tokens overlap
    expect(json.results[0].relevance_score).toBe(1);
    const again = await (makeOverlapRerankTransport() as any)('http://stub.invalid/x', { body });
    expect(await again.json()).toEqual(json);
  });
});

// ─── Full hermetic matrix runs ───────────────────────────────────────

describe('runCat18b (hermetic, stubbed embed + rerank transports)', () => {
  test('good input: reranker verifiably fires in +rerank cell only, mode constant, verdict pass', async () => {
    const reportsDir = tmpReports();
    const r = await runCat18b({
      cells: OPENAI_PAIR,
      pages: PAGES,
      queries: QUERIES,
      stub: true,
      reportsDir,
      quiet: true,
    });
    expect(r.receipt.run_status).toBe('completed');
    expect(r.receipt.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.receipt.n_total).toBe(OPENAI_PAIR.length * QUERIES.length);
    expect(r.receipt.n_scored).toBe(r.receipt.n_total);
    expect(r.receipt.errors).toEqual([]);
    expect(r.receipt.publishable).toBe(false); // stub runs never publishable

    const base = r.cells.find(c => c.reranker === null)!;
    const plus = r.cells.find(c => c.reranker !== null)!;
    // Rerank-fired evidence, both directions (directive e)
    expect(plus.rerank_scored_queries).toBe(QUERIES.length);
    expect(plus.rerank_failopen_queries).toBe(0);
    expect(base.rerank_scored_queries).toBe(0);
    // Mode held constant across the ± pair (cats18-21-05)
    expect(base.pinned_config['search.mode']).toBe('balanced');
    expect(plus.pinned_config['search.mode']).toBe('balanced');
    // Coverage evidence present in both cells (cats18-21-06)
    for (const c of r.cells) {
      expect(c.chunks_total).toBeGreaterThan(0);
      expect(c.chunks_embedded).toBe(c.chunks_total);
      expect(c.recall_at_10!).toBeLessThanOrEqual(1); // page-normalized (cats18-21-04)
    }
    // resolved_config records the reranker state per cell
    const rc = r.receipt.resolved_config as Record<string, any>;
    expect(rc.search_mode).toBe('balanced');
    expect(rc.reranker_axis[plus.cell].enabled).toBe(true);
    expect(rc.reranker_axis[plus.cell].verified_fired_queries).toBe(QUERIES.length);
    expect(rc.reranker_axis[base.cell].enabled).toBe(false);
    // ± pair delta computed over two valid cells
    const data = r.receipt.data as Record<string, any>;
    expect(data.pairs.length).toBe(1);
    expect(data.pairs[0].recall_delta).not.toBeNull();
    expect(data.comparison.valid).toBe(true);
    const loaded = loadReceipt(receiptPath(CAT18B_CATEGORY, reportsDir));
    expect(loaded.category).toBe(CAT18B_CATEGORY);
  }, RUN_TIMEOUT);

  test('bad input (reranker 401 fail-open): +rerank cell detected as degraded, excluded from winners, non-zero exit', async () => {
    const reportsDir = tmpReports();
    const r = await runCat18b({
      cells: OPENAI_PAIR,
      pages: PAGES,
      queries: QUERIES,
      stub: true,
      stubRerankRespondWith: () => new Response('unauthorized', { status: 401 }),
      reportsDir,
      quiet: true,
    });
    const base = r.cells.find(c => c.reranker === null)!;
    const plus = r.cells.find(c => c.reranker !== null)!;
    // gbrain fails open silently; the runner must NOT publish the unreranked
    // numbers under the '+rerank' label (cats18-21-06 / directive e)
    expect(plus.rerank_failopen_queries).toBe(QUERIES.length);
    expect(plus.valid).toBe(false);
    expect(base.valid).toBe(true);
    const depErrors = r.receipt.errors.filter(e => e.origin === 'dependency');
    expect(depErrors.length).toBe(QUERIES.length);
    expect(depErrors.every(e => e.message.includes('fail-open'))).toBe(true);
    // Probes stayed in the denominator; nothing silently compared at unequal n
    expect(r.receipt.n_total).toBe(OPENAI_PAIR.length * QUERIES.length);
    expect(r.receipt.n_scored).toBe(QUERIES.length); // only the baseline cell scored
    const data = r.receipt.data as Record<string, any>;
    expect(data.comparison.valid).toBe(false);
    expect(data.comparison.excluded_cells).toContain(plus.cell);
    expect(data.comparison.winner_by_axis.recall_at_10).toBeNull();
    expect(data.pairs[0].recall_delta).toBeNull();
    expect(r.receipt.verdict).toBe('partial');
    expect(r.exitCode).not.toBe(0);
    expect(r.receipt.publishable).toBe(false);
  }, RUN_TIMEOUT);

  test('missing provider keys: skipped receipt, non-zero exit unless allow-skip', async () => {
    const savedZe = process.env.ZEROENTROPY_API_KEY;
    const savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.ZEROENTROPY_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const reportsDir = tmpReports();
      const r = await runCat18b({
        cells: OPENAI_PAIR,
        pages: PAGES,
        queries: QUERIES,
        reportsDir,
        quiet: true,
      });
      expect(r.receipt.run_status).toBe('skipped');
      expect(r.receipt.skip_reason).toContain('OPENAI_API_KEY');
      expect(r.receipt.skip_reason).toContain('ZEROENTROPY_API_KEY');
      expect(r.exitCode).toBe(1);

      const r2 = await runCat18b({
        cells: OPENAI_PAIR,
        pages: PAGES,
        queries: QUERIES,
        reportsDir,
        allowSkip: true,
        quiet: true,
      });
      expect(r2.exitCode).toBe(0);
      expect(r2.receipt.run_status).toBe('skipped');
    } finally {
      if (savedZe !== undefined) process.env.ZEROENTROPY_API_KEY = savedZe;
      else delete process.env.ZEROENTROPY_API_KEY;
      if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
      else delete process.env.OPENAI_API_KEY;
    }
  }, RUN_TIMEOUT);
});
