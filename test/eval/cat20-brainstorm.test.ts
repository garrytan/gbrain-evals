/**
 * Cat 20 regression tests — grounding is graded on what brainstorm ACTUALLY
 * produced, and brainstorm failures flow through probe accounting.
 *
 * Load-bearing regressions:
 *   - audit cats18-21-10: grounding used to be satisfied by construction
 *     (the runner injected close/far slugs into every judged line). Now an
 *     idea whose TEXT carries no citation scores 0 even though its
 *     close_slug/far_slug metadata exists — proven by the 'ungrounded' stub
 *     generator driving the run to verdict 'fail'.
 *   - audit cats18-21-12: a runBrainstorm failure is a typed 'sut' probe
 *     error (scored 0, kept in the denominator); the judge is never invoked
 *     on an empty ideas string.
 *
 * Hermetic: embed transport stubbed (hash vectors) + the orchestrator's
 * documented chatFn test seam carries canned generator/judge responses.
 * No API keys used.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCat20, gradeIdeaGrounding } from '../../eval/runner/cat20-brainstorm.ts';
import { loadSyntheticV1, type SyntheticPage } from '../../eval/runner/synthetic-corpus-loader.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';

/** Small multi-prefix corpus subset so fetchFar has a domain bank to stratify. */
function smallCorpus(): SyntheticPage[] {
  const all = loadSyntheticV1();
  const byPrefix = new Map<string, SyntheticPage[]>();
  for (const p of all) {
    const prefix = p.slug.split('/')[0];
    const bucket = byPrefix.get(prefix) ?? [];
    if (bucket.length < 6) {
      bucket.push(p);
      byPrefix.set(prefix, bucket);
    }
  }
  return [...byPrefix.values()].flat().slice(0, 30);
}

const QUESTION = ['What connects the companies and people captured in this brain?'];

describe('cat20 grounding metric (unit)', () => {
  const corpus = new Set(['companies/acme', 'people/jo']);

  test('an idea whose text cites both real slugs scores 1', () => {
    const g = gradeIdeaGrounding(
      { id: '01', text: 'Combine [companies/acme] with [people/jo] for a concrete step.', close_slug: 'companies/acme', far_slug: 'people/jo' },
      corpus,
    );
    expect(g.score).toBe(1);
  });

  test('citation metadata alone is NOT grounding: uncited text scores 0 (cats18-21-10)', () => {
    // close_slug/far_slug metadata exists on every BrainstormIdea by
    // construction — the old runner injected it into the judged text. The
    // metric must ignore metadata and read only the idea text.
    const g = gradeIdeaGrounding(
      { id: '01', text: 'A generic platitude with no citations.', close_slug: 'companies/acme', far_slug: 'people/jo' },
      corpus,
    );
    expect(g.score).toBe(0);
    expect(g.slugs_valid).toBe(true);
  });

  test('a fabricated slug zeroes the idea even when cited in text', () => {
    const g = gradeIdeaGrounding(
      { id: '01', text: 'See [companies/fake] and [people/jo].', close_slug: 'companies/fake', far_slug: 'people/jo' },
      corpus,
    );
    expect(g.slugs_valid).toBe(false);
    expect(g.score).toBe(0);
  });
});

describe('cat20 runner', () => {
  test('grounded generator passes the grounding gate', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat20-good-'));
    const result = await runCat20({
      stubLlm: true,
      stubChatKind: 'grounded',
      questions: QUESTION,
      pages: smallCorpus(),
      quiet: true,
      reportsDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.receipt.verdict).toBe('pass');
    expect(result.perQuestion[0].error).toBeNull();
    expect(result.perQuestion[0].idea_count).toBeGreaterThanOrEqual(3);
    expect(result.perQuestion[0].grounding).toBeGreaterThanOrEqual(0.5);
    // Stub runs are never publishable model-quality numbers.
    expect(result.receipt.publishable).toBe(false);
    const persisted = loadReceipt(result.receiptFile);
    expect((persisted.resolved_config as Record<string, unknown>)['reranker_enabled']).toBe(false);
  }, 240_000);

  test('ungrounded generator fails the grounding gate (no longer satisfied by construction)', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat20-ungrounded-'));
    const result = await runCat20({
      stubLlm: true,
      stubChatKind: 'ungrounded',
      questions: QUESTION,
      pages: smallCorpus(),
      quiet: true,
      reportsDir,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.receipt.verdict).toBe('fail');
    expect(result.perQuestion[0].grounding).toBe(0);
    const data = result.receipt.data as { verdict_reasons: string[] };
    expect(data.verdict_reasons.join(' ')).toContain('grounding');
  }, 240_000);

  test('brainstorm failure is a typed sut error; the judge never sees an empty ideas string (cats18-21-12)', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat20-throw-'));
    const result = await runCat20({
      stubLlm: true,
      stubChatKind: 'throw',
      questions: QUESTION,
      pages: smallCorpus(),
      quiet: true,
      reportsDir,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.receipt.verdict).toBe('fail');
    expect(result.perQuestion[0].error).not.toBeNull();
    expect(result.perQuestion[0].graded_set).toBe('none');
    // sut origin: scored 0, stays in the denominator.
    const sutErrors = result.receipt.errors.filter(e => e.origin === 'sut');
    expect(sutErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.receipt.n_scored).toBe(1); // the 0-scored sut probe
    expect((result.receipt.data as { mean_grounding: number | null }).mean_grounding).toBe(0);
  }, 240_000);
});
