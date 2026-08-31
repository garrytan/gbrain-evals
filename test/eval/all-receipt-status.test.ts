/**
 * all.ts receipt-driven status — the MANDATORY regression for the cat11
 * class (audit finding retrieval-cats-06: every modality skipped, exit 0,
 * all.ts recorded PASS while measuring nothing).
 *
 * Iron rule from the eng review: a category reporting run_status 'skipped'
 * can never aggregate as pass, no matter what the exit code says.
 */

import { describe, test, expect } from 'bun:test';
import { deriveStatusFromReceipt } from '../../eval/runner/all.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from '../../eval/runner/receipt.ts';

function receipt(overrides: Partial<Receipt>): Receipt {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: 'cat-test',
    run_status: 'completed',
    verdict: 'pass',
    n_total: 5,
    n_scored: 5,
    completion_rate: 1,
    errors: [],
    publishable: true,
    gbrain_version: 'x',
    gbrain_pin: 'y',
    started_at: 't0',
    finished_at: 't1',
    ...overrides,
  };
}

describe('deriveStatusFromReceipt', () => {
  test('REGRESSION: skipped receipt + exit 0 is SKIPPED, never pass', () => {
    const r = receipt({ run_status: 'skipped', skip_reason: 'fixtures missing', verdict: undefined });
    const derived = deriveStatusFromReceipt(r, 0);
    expect(derived.status).toBe('skipped');
    expect(derived.status).not.toBe('pass');
    expect(derived.statusSource).toBe('receipt');
    expect(derived.statusNote).toContain('fixtures missing');
  });

  test('completed + verdict pass → pass, even if exit code is nonzero noise', () => {
    const derived = deriveStatusFromReceipt(receipt({}), 1);
    expect(derived.status).toBe('pass');
    expect(derived.statusSource).toBe('receipt');
  });

  test('completed + verdict fail → fail even with exit 0', () => {
    const derived = deriveStatusFromReceipt(receipt({ verdict: 'fail' }), 0);
    expect(derived.status).toBe('fail');
  });

  test('completed + verdict partial does not meet the bar → fail', () => {
    const derived = deriveStatusFromReceipt(receipt({ verdict: 'partial' }), 0);
    expect(derived.status).toBe('fail');
  });

  test('run_status error → fail regardless of exit code', () => {
    const r = receipt({ run_status: 'error', verdict: undefined });
    expect(deriveStatusFromReceipt(r, 0).status).toBe('fail');
  });

  test('no receipt falls back to exit code with an explicit legacy note', () => {
    const ok = deriveStatusFromReceipt(null, 0);
    expect(ok.status).toBe('pass');
    expect(ok.statusSource).toBe('exit-code');
    expect(ok.statusNote).toContain('no fresh receipt');
    expect(deriveStatusFromReceipt(null, 1).status).toBe('fail');
  });

  test('unpublishable completed run is noted', () => {
    const derived = deriveStatusFromReceipt(receipt({ publishable: false }), 0);
    expect(derived.statusNote).toContain('not publishable');
  });
});
