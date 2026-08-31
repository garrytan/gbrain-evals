/**
 * Cat 21 regression tests — the corpus contains the gold, the pins hold,
 * and the metrics can't double-count.
 *
 * Load-bearing regressions:
 *   - audit cats18-21-01: the old `allFiles.slice(0, 60)` excluded 11/12
 *     gold files and nothing asserted their presence. Now every gold slug
 *     is asserted in the index before querying; the `excludeGold` hook
 *     recreates the old bug and the run must FAIL (cells aborted).
 *   - audit cats18-21-13: recall was incremented once per matching CHUNK
 *     row (gbrain returns up to 2 chunks/page), so one query could
 *     contribute > 1. Scoring now page-normalizes via metrics.ts; per-cell
 *     recall_at_5 is provably <= 1.
 *   - audit cats18-21-07: search mode + reranker pinned per cell and
 *     recorded in the receipt; no result may carry a rerank_score even
 *     when ZEROENTROPY_API_KEY is set in the environment.
 *
 * Hermetic: hash-embed transport via gbrain's gateway test seam (installed
 * by the runner in stubEmbed mode). No API keys used.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runCat21,
  resolveGoldFiles,
  pickDistractors,
  walkTs,
  fileSlug,
  QUERIES,
  SRC_ROOT,
} from '../../eval/runner/cat21-code-retrieval.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';

const SMOKE_QUERIES = QUERIES.slice(0, 3);

describe('cat21 corpus construction (unit)', () => {
  test('every gold query suffix resolves to exactly one walked file', () => {
    const all = walkTs(SRC_ROOT);
    const gold = resolveGoldFiles(all, QUERIES);
    expect(gold.size).toBe(QUERIES.length);
    // Slug transform is stable and unique.
    const slugs = new Set([...gold.values()].map(fileSlug));
    expect(slugs.size).toBe(QUERIES.length);
  });

  test('distractor sample is deterministic and excludes gold', () => {
    const all = walkTs(SRC_ROOT);
    const gold = new Set(resolveGoldFiles(all, QUERIES).values());
    const a = pickDistractors(all, gold, 10);
    const b = pickDistractors(all, gold, 10);
    expect(a).toEqual(b);
    expect(a).toHaveLength(10);
    for (const f of a) expect(gold.has(f)).toBe(false);
  });
});

describe('cat21 runner', () => {
  test('gold files ingested + asserted, pins verified, metrics page-normalized', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat21-good-'));
    // ZE key present must NOT let the reranker touch results (cats18-21-07):
    // the per-cell pin turns it off and every query verifies no rerank_score.
    const hadZe = process.env.ZEROENTROPY_API_KEY;
    process.env.ZEROENTROPY_API_KEY = 'dummy-ze-key-for-pin-test';
    let result;
    try {
      result = await runCat21({
        stubEmbed: true,
        cells: ['openai-default'],
        queries: SMOKE_QUERIES,
        distractors: 3,
        quiet: true,
        reportsDir,
      });
    } finally {
      if (hadZe === undefined) delete process.env.ZEROENTROPY_API_KEY;
      else process.env.ZEROENTROPY_API_KEY = hadZe;
    }

    expect(result.exitCode).toBe(0);
    expect(result.receipt.verdict).toBe('pass');
    const cell = result.cells[0];
    expect(cell.gold_present).toBe(SMOKE_QUERIES.length);
    expect(cell.gold_missing).toHaveLength(0);
    expect(cell.queries_scored).toBe(SMOKE_QUERIES.length);
    expect(cell.files_ok).toBe(SMOKE_QUERIES.length + 3);

    // cats18-21-13: page-grained, can never exceed 1.
    expect(cell.recall_at_5).not.toBeNull();
    expect(cell.recall_at_5!).toBeLessThanOrEqual(1);
    expect(cell.top1_hits!).toBeLessThanOrEqual(SMOKE_QUERIES.length);

    // cats18-21-07: reranker pinned off, verified per query, recorded.
    expect(cell.rerank_scored_queries).toBe(0);
    const persisted = loadReceipt(result.receiptFile);
    const rc = persisted.resolved_config as Record<string, unknown>;
    expect(rc['reranker_enabled']).toBe(false);
    expect((rc['pinned_config'] as Record<string, string>)['search.reranker.enabled']).toBe('false');
    expect(rc['search_mode']).toBe('balanced');
    // Stub cells are never a provider comparison.
    expect(persisted.publishable).toBe(false);
  }, 300_000);

  test('the old slice bug (gold excluded) now ABORTS the cell and fails the run (cats18-21-01)', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat21-nogold-'));
    const result = await runCat21({
      stubEmbed: true,
      excludeGold: true,
      cells: ['openai-default'],
      queries: SMOKE_QUERIES,
      distractors: 3,
      quiet: true,
      reportsDir,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.receipt.verdict).toBe('fail');
    const cell = result.cells[0];
    expect(cell.valid).toBe(false);
    expect(cell.gold_missing).toHaveLength(SMOKE_QUERIES.length);
    // No query ran against a corpus that can't contain the answer.
    expect(cell.queries_scored).toBe(0);
    expect(result.receipt.errors.length).toBeGreaterThanOrEqual(SMOKE_QUERIES.length);
  }, 300_000);
});
