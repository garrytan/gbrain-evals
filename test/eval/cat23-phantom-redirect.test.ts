/**
 * cat23-phantom-redirect.ts regression tests (audit cats22-25-05/06).
 *
 * Hermetic: no API keys. All imports are noEmbed; the resolver under test
 * (resolvePhantomCanonical + findPrefixCandidates) is SQL-only.
 *
 * Gates proven failable AND passing:
 *   - the designed bare-name prefix-expansion case is exercised and passes
 *     ('alice' → people/alice-okafor via `people/alice-%`)
 *   - the ambiguity gate refusal and the no-candidate refusal are asserted
 *     (fixtures that SHOULD fail redirect)
 *   - a constructed miss (expected redirect with no canonical page seeded)
 *     makes the verdict FAIL with a non-zero exit
 *   - resolver errors are distinct from genuine misses and can never count
 *     as a correct null (scorePhantomCase unit test)
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runCat23,
  scorePhantomCase,
  CAT23_CATEGORY,
  type PhantomExpectation,
} from '../../eval/runner/cat23-phantom-redirect.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';

const RUN_TIMEOUT = 300_000;

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat23-test-reports-'));
}

// ─── scorePhantomCase: error/miss/limitation semantics ───────────────

describe('scorePhantomCase', () => {
  const redirectExp: PhantomExpectation = {
    phantom_slug: 'alice', expected_decision: 'redirect', expected_canonical: 'people/alice-okafor',
  };

  test('correct redirect passes; wrong target fails', () => {
    expect(scorePhantomCase(redirectExp, 'redirect', 'people/alice-okafor')).toBe(true);
    expect(scorePhantomCase(redirectExp, 'redirect', 'people/alice-wrong')).toBe(false);
  });

  test('a resolver ERROR never counts as correct — even when null was expected (cats22-25-06)', () => {
    const nullExp: PhantomExpectation = { phantom_slug: 'team', expected_decision: 'no_canonical', expected_canonical: null };
    expect(scorePhantomCase(nullExp, 'error', null)).toBe(false);
    expect(scorePhantomCase(nullExp, 'no_canonical', null)).toBe(true);
  });

  test('expected ambiguous: refusal passes, a redirect fails', () => {
    const ambExp: PhantomExpectation = { phantom_slug: 'dan', expected_decision: 'ambiguous', expected_canonical: null };
    expect(scorePhantomCase(ambExp, 'ambiguous', 'people/dan-brown')).toBe(true);
    expect(scorePhantomCase(ambExp, 'redirect', 'people/dan-brown')).toBe(false);
  });

  test('known-limitation tail: no_canonical passes, exact-canonical redirect passes, any other redirect fails', () => {
    const tailExp: PhantomExpectation = {
      phantom_slug: 'bob-chen', expected_decision: 'no_canonical', expected_canonical: null,
      also_accept_redirect_to: 'people/bob-chen',
    };
    expect(scorePhantomCase(tailExp, 'no_canonical', null)).toBe(true);
    expect(scorePhantomCase(tailExp, 'redirect', 'people/bob-chen')).toBe(true);
    expect(scorePhantomCase(tailExp, 'redirect', 'people/bob-brown')).toBe(false);
  });
});

// ─── End to end: designed fixtures pass, constructed miss fails ──────

describe('runCat23 end to end (hermetic)', () => {
  test('default fixtures → verdict pass: bare names redirect, refusals detected', async () => {
    const reportsDir = tmpReports();
    const result = await runCat23({ reportsDir, quiet: true });
    expect(result.exitCode).toBe(0);
    expect(result.receipt.verdict).toBe('pass');
    // The designed bare-name prefix-expansion case (cats22-25-05).
    const alice = result.cases.find(c => c.phantom_slug === 'alice');
    expect(alice?.decision).toBe('redirect');
    expect(alice?.resolved_canonical).toBe('people/alice-okafor');
    // Ambiguity gate refusal (SHOULD-fail-redirect fixture) is exercised.
    const dan = result.cases.find(c => c.phantom_slug === 'dan');
    expect(dan?.decision).toBe('ambiguous');
    expect(dan?.prefix_candidates).toBeGreaterThan(1);
    // No-candidate refusal.
    const team = result.cases.find(c => c.phantom_slug === 'team');
    expect(team?.decision).toBe('no_canonical');
    // Receipt on disk validates.
    const receipt = loadReceipt(receiptPath(CAT23_CATEGORY, reportsDir));
    expect(receipt.verdict).toBe('pass');
    expect(receipt.n_scored).toBe(result.cases.length);
  }, RUN_TIMEOUT);

  test('constructed miss (expected redirect, canonical never seeded) → verdict fail + non-zero exit', async () => {
    const reportsDir = tmpReports();
    const result = await runCat23({
      reportsDir,
      quiet: true,
      canonicals: [{ slug: 'people/alice-okafor', body: '# Alice Okafor\n\nAlice Okafor is CEO of a company.' }],
      phantoms: [
        // Resolvable — proves the failing run is not failing for setup reasons.
        { phantom_slug: 'alice', expected_decision: 'redirect', expected_canonical: 'people/alice-okafor' },
        // Bad input: no people/zed-* page exists, so the resolver returns
        // no_canonical and the expectation must FAIL the run.
        { phantom_slug: 'zed', expected_decision: 'redirect', expected_canonical: 'people/zed-zeta' },
      ],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.receipt.verdict).toBe('fail');
    const alice = result.cases.find(c => c.phantom_slug === 'alice');
    expect(alice?.pass).toBe(true);
    const zed = result.cases.find(c => c.phantom_slug === 'zed');
    expect(zed?.pass).toBe(false);
    // The miss is recorded as a typed SUT error in the receipt.
    expect(result.receipt.errors.some(e => e.origin === 'sut' && e.probe_id === 'zed')).toBe(true);
    // A test-fixture run is never publishable.
    expect(result.receipt.publishable).toBe(false);
  }, RUN_TIMEOUT);
});
