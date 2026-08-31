/**
 * cat22-source-isolation.ts regression tests (audit cats22-25-03/07/08).
 *
 * Hermetic: no API keys. Every import is noEmbed; hybridSearch runs its
 * documented no-provider keyword-only path (the runner strips provider keys
 * from the gateway env).
 *
 * Gates proven failable AND passing:
 *   - empty result sets / missing source_id / hardcoded totals can no longer
 *     produce isolation_clean=true (probeResult unit tests + the
 *     empty-source end-to-end run must FAIL)
 *   - the good-fixture run passes with non-vacuous totals, the traverseGraph
 *     surface actually probed, and the negative controls detecting leakage
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  probeResult,
  runCat22,
  CAT22_CATEGORY,
} from '../../eval/runner/cat22-source-isolation.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';

const RUN_TIMEOUT = 300_000;

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat22-test-reports-'));
}

// ─── probeResult: the vacuous-pass fixes, unit-level ─────────────────

describe('probeResult', () => {
  const allowed = new Set(['alpha']);

  test('clean scoped rows meeting the expected count pass', () => {
    const p = probeResult('listPages', 'alpha', 2, [
      { slug: 'people/p-0', source_id: 'alpha' },
      { slug: 'people/p-1', source_id: 'alpha' },
    ], allowed);
    expect(p.pass).toBe(true);
    expect(p.leaked_results).toBe(0);
  });

  test('EMPTY result set fails as vacuous (the old always-pass case)', () => {
    const p = probeResult('listPages', 'alpha', 2, [], allowed);
    expect(p.pass).toBe(false);
    expect(p.fail_reason).toContain('vacuous');
  });

  test('a row with missing source_id is a violation, not a skip', () => {
    const p = probeResult('hybridSearch', 'alpha', 1, [
      { slug: 'people/p-0', source_id: undefined },
    ], allowed);
    expect(p.pass).toBe(false);
    expect(p.missing_source_id).toBe(1);
    expect(p.fail_reason).toContain('missing source_id');
  });

  test('a leaked cross-source row fails with a sample', () => {
    const p = probeResult('listPages', 'alpha', 1, [
      { slug: 'people/p-0', source_id: 'alpha' },
      { slug: 'people/p-1', source_id: 'beta' },
    ], allowed);
    expect(p.pass).toBe(false);
    expect(p.leaked_results).toBe(1);
    expect(p.leak_sample).toContain('people/p-1@beta');
  });
});

// ─── End to end: good corpus passes, empty scope fails ───────────────

describe('runCat22 end to end (hermetic)', () => {
  test('good corpus → verdict pass, exit 0, non-vacuous totals, controls detect leaks', async () => {
    const reportsDir = tmpReports();
    const result = await runCat22({ reportsDir, quiet: true });
    expect(result.exitCode).toBe(0);
    expect(result.receipt.run_status).toBe('completed');
    expect(result.receipt.verdict).toBe('pass');
    // All 5 scoped surfaces probed — including traverseGraph (cats22-25-07).
    expect(result.probes.map(p => p.surface).sort()).toEqual(
      ['getPage', 'hybridSearch', 'listPages', 'listPages-federated', 'traverseGraph'].sort(),
    );
    for (const p of result.probes) {
      expect(p.total_results).toBeGreaterThan(0); // never vacuous
      expect(p.pass).toBe(true);
    }
    // Negative controls: isolation OFF must observe cross-source rows.
    expect(result.controls.length).toBe(3);
    for (const c of result.controls) expect(c.detected_leak).toBe(true);
    // WS5: pinned search config echoed in the receipt.
    const rc = result.receipt.resolved_config as Record<string, unknown>;
    expect(rc.search_mode).toBe('balanced');
    expect(rc.reranker_enabled).toBe(false);
    // Receipt on disk validates.
    const receipt = loadReceipt(receiptPath(CAT22_CATEGORY, reportsDir));
    expect(receipt.verdict).toBe('pass');
  }, RUN_TIMEOUT);

  test('scoped source with zero rows → verdict fail + non-zero exit (gate is failable)', async () => {
    const reportsDir = tmpReports();
    // Deleting every alpha row reconstructs the regression the audit called
    // out: scoped reads return nothing. The old runner declared that
    // "provably clean"; the fixed runner must fail it.
    const result = await runCat22({ reportsDir, quiet: true, skipSeedSources: ['alpha'] });
    expect(result.exitCode).not.toBe(0);
    expect(result.receipt.verdict).toBe('fail');
    const failing = result.probes.filter(p => !p.pass);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.some(p => (p.fail_reason ?? '').includes('vacuous') || (p.fail_reason ?? '').includes('mismatch'))).toBe(true);
    // The receipt records typed SUT errors, not silence.
    expect(result.receipt.errors.some(e => e.origin === 'sut')).toBe(true);
  }, RUN_TIMEOUT);
});
