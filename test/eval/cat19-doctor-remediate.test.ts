/**
 * Cat 19 regression tests — the doctor/remediate gates are real and failable.
 *
 * Load-bearing regressions:
 *   - audit cats18-21-09: the runner used to have NO assertion and exited 0
 *     unconditionally. Now a run whose remediation steps never execute must
 *     produce verdict 'fail' and a non-zero exit code, while the real
 *     remediation path (extract links + embed --stale) must pass.
 *   - audit cats18-21-08: link_count/chunk_count come from SQL, not from
 *     nonexistent BrainHealth fields — the before/after link delta must be
 *     REAL (0 -> >= 20), never 0 -> 0.
 *
 * Hermetic: embed transport stubbed via gbrain's gateway test seam (the
 * runner installs it itself in stubEmbed mode); no API keys used.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCat19, DEFAULT_MIN_LINKS_INSERTED } from '../../eval/runner/cat19-doctor-remediate.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';

describe('cat19 doctor-remediate', () => {
  test('real remediation path passes: plan emitted, embeddings converge, links inserted, score climbs', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat19-good-'));
    const result = await runCat19({ stubEmbed: true, quiet: true, reportsDir });

    expect(result.exitCode).toBe(0);
    expect(result.receipt.run_status).toBe('completed');
    expect(result.receipt.verdict).toBe('pass');
    expect(result.receipt.n_scored).toBe(5);
    expect(result.receipt.errors).toHaveLength(0);

    // cats18-21-08: the link metric measures something real now.
    expect(result.baseline?.link_count).toBe(0);
    expect(result.baseline?.missing_embeddings).toBeGreaterThan(0);
    expect((result.achieved?.link_count ?? 0) - (result.baseline?.link_count ?? 0))
      .toBeGreaterThanOrEqual(DEFAULT_MIN_LINKS_INSERTED);
    expect(result.achieved?.missing_embeddings).toBe(0);
    expect(result.achieved!.brain_score).toBeGreaterThan(result.baseline!.brain_score);

    // The doctor planner (computeRecommendations) actually ran.
    const data = result.receipt.data as { doctor_plan_ids: string[]; brain_score_delta: number };
    expect(data.doctor_plan_ids).toContain('embed.stale');
    expect(data.brain_score_delta).toBeGreaterThanOrEqual(15);

    // Receipt on disk validates.
    const persisted = loadReceipt(result.receiptFile);
    expect(persisted.category).toBe('cat19-doctor-remediate');
    expect(persisted.verdict).toBe('pass');
  }, 180_000);

  test('gate failability: a run whose remediation never executes fails with non-zero exit', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat19-bad-'));
    const result = await runCat19({ stubEmbed: true, skipRemediation: true, quiet: true, reportsDir });

    expect(result.exitCode).not.toBe(0);
    expect(result.receipt.run_status).toBe('completed');
    expect(result.receipt.verdict).toBe('fail');

    // Nothing converged: the gates saw it.
    expect(result.achieved?.missing_embeddings).toBeGreaterThan(0);
    expect(result.achieved?.link_count).toBe(0);
    const persisted = loadReceipt(result.receiptFile);
    expect(persisted.verdict).toBe('fail');
  }, 180_000);
});
