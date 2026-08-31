/**
 * receipt.ts + probe-accounting.ts tests — the WS0 contracts.
 *
 * The load-bearing regression here: a receipt with run_status 'skipped' can
 * never validate as a completed pass, and the scoring policy's origin split
 * (sut → miss, infra → excluded + capped) behaves exactly as specified.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  BENCHMARK_VERSION,
  RECEIPT_SCHEMA_VERSION,
  validateReceipt,
  writeReceipt,
  loadReceipt,
  receiptPath,
  type Receipt,
} from '../../eval/runner/receipt.ts';
import { ProbeAccounting } from '../../eval/runner/probe-accounting.ts';

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: 'cat-test',
    run_status: 'completed',
    verdict: 'pass',
    n_total: 10,
    n_scored: 10,
    completion_rate: 1,
    errors: [],
    publishable: true,
    gbrain_version: '0.47.6.0',
    gbrain_pin: 'github:garrytan/gbrain#7b7921d',
    started_at: '2026-08-31T00:00:00Z',
    finished_at: '2026-08-31T00:01:00Z',
    ...overrides,
  };
}

describe('validateReceipt', () => {
  test('valid completed receipt passes', () => {
    expect(validateReceipt(makeReceipt())).toEqual([]);
  });

  test('completed without verdict is invalid', () => {
    expect(validateReceipt(makeReceipt({ verdict: undefined }))).not.toEqual([]);
  });

  test('skipped receipt CANNOT carry a verdict — skipped can never read as pass', () => {
    const violations = validateReceipt(
      makeReceipt({ run_status: 'skipped', skip_reason: 'fixtures missing', verdict: 'pass' }),
    );
    expect(violations.some(v => v.includes('verdict only allowed'))).toBe(true);
  });

  test('skipped receipt requires skip_reason', () => {
    const violations = validateReceipt(makeReceipt({ run_status: 'skipped', verdict: undefined }));
    expect(violations.some(v => v.includes('skip_reason'))).toBe(true);
  });

  test('error entries require a typed failure origin', () => {
    const violations = validateReceipt(
      makeReceipt({ errors: [{ probe_id: 'p1', origin: 'oops' as never, message: 'x' }] }),
    );
    expect(violations.some(v => v.includes('origin'))).toBe(true);
  });

  test('rejects non-objects', () => {
    expect(validateReceipt(null)).not.toEqual([]);
    expect(validateReceipt('receipt')).not.toEqual([]);
  });
});

describe('writeReceipt / loadReceipt', () => {
  test('round-trips atomically and leaves no temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-test-'));
    try {
      const path = join(dir, 'sub', 'receipt.json');
      const receipt = makeReceipt();
      writeReceipt(path, receipt);
      const loaded = loadReceipt(path);
      expect(loaded).toEqual(receipt);
      expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to write an invalid receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-test-'));
    try {
      const bad = makeReceipt({ verdict: undefined });
      expect(() => writeReceipt(join(dir, 'receipt.json'), bad)).toThrow(/invalid receipt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadReceipt throws on a corrupt/truncated file instead of returning garbage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-test-'));
    try {
      const path = join(dir, 'receipt.json');
      writeFileSync(path, '{"schema_version": 1, "categ');
      expect(() => loadReceipt(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('receiptPath follows the eval/reports/<category>/receipt.json convention', () => {
    expect(receiptPath('cat18-embedding-providers', '/reports')).toBe(
      join('/reports', 'cat18-embedding-providers', 'receipt.json'),
    );
  });
});

describe('ProbeAccounting — WS0 scoring policy', () => {
  test('sut failure counts as a scored MISS, not an exclusion', () => {
    const acc = new ProbeAccounting(2);
    acc.score('p1', 1.0);
    acc.error('p2', 'sut', 'adapter returned garbage');
    // Excluding p2 would give mean 1.0 — rewarding the failure. Policy: 0.5.
    expect(acc.mean()).toBeCloseTo(0.5, 6);
    expect(acc.summary().n_scored).toBe(2);
  });

  test('harness failure is EXCLUDED from the mean', () => {
    const acc = new ProbeAccounting(2);
    acc.score('p1', 1.0);
    acc.error('p2', 'harness', 'our bug');
    expect(acc.mean()).toBeCloseTo(1.0, 6);
    expect(acc.summary().n_scored).toBe(1);
  });

  test('judge failure is excluded, never averaged in as 0', () => {
    const acc = new ProbeAccounting(2);
    acc.score('p1', 4.0);
    acc.error('p2', 'judge', 'judge_failed after retry');
    expect(acc.mean()).toBeCloseTo(4.0, 6);
  });

  test('>10% infra error rate invalidates a run with n_total >= 10', () => {
    const acc = new ProbeAccounting(10);
    for (let i = 0; i < 8; i++) acc.score(`p${i}`, 1);
    acc.error('p8', 'harness', 'x');
    acc.error('p9', 'dependency', 'y');
    const s = acc.summary();
    expect(s.infra_error_rate).toBeCloseTo(0.2, 6);
    expect(s.run_invalid).toBe(true);
    expect(s.publishable).toBe(false);
  });

  test('exactly 10% does not invalidate (boundary is strict >)', () => {
    const acc = new ProbeAccounting(10);
    for (let i = 0; i < 9; i++) acc.score(`p${i}`, 1);
    acc.error('p9', 'harness', 'x');
    const s = acc.summary();
    expect(s.run_invalid).toBe(false);
    expect(s.publishable).toBe(true);
  });

  test('smoke run (n_total < 10) with one infra error: NOT invalid, but NOT publishable', () => {
    // A --limit 1 smoke run must not be "invalid" over one flake (the 10%
    // rule would be pathological there), but it must never be published.
    const acc = new ProbeAccounting(1);
    acc.error('p0', 'harness', 'flake');
    const s = acc.summary();
    expect(s.run_invalid).toBe(false);
    expect(s.publishable).toBe(false);
  });

  test('sut failures alone never invalidate a run — they are scores', () => {
    const acc = new ProbeAccounting(10);
    for (let i = 0; i < 10; i++) acc.error(`p${i}`, 'sut', 'adapter failed probe');
    const s = acc.summary();
    expect(s.run_invalid).toBe(false);
    expect(s.publishable).toBe(true);
    expect(acc.mean()).toBe(0);
  });

  test('mean of nothing is NaN, not 0', () => {
    const acc = new ProbeAccounting(0);
    expect(Number.isNaN(acc.mean())).toBe(true);
  });

  test('completion rate counts never-attempted probes', () => {
    const acc = new ProbeAccounting(4);
    acc.score('p1', 1);
    const s = acc.summary();
    expect(s.completion_rate).toBeCloseTo(0.25, 6);
  });
});
