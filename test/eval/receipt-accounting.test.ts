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
import { execFileSync } from 'node:child_process';
import {
  BENCHMARK_VERSION,
  RECEIPT_SCHEMA_VERSION,
  validateReceipt,
  writeReceipt,
  loadReceipt,
  receiptPath,
  deriveAccounting,
  latencySummary,
  productIdentity,
  sourceTreeIdentity,
  upgradeReceipt,
  validateStoredReceipt,
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
      expect(loaded).toEqual(upgradeReceipt(receipt));
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

describe('receipt schema v2', () => {
  test('writeReceipt stores the executed source tree and loaded gbrain identity', () => {
    const upgraded = upgradeReceipt(makeReceipt());
    expect(upgraded.schema_version).toBe(2);
    const tree = upgraded.execution!.source_tree;
    expect(tree.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(tree.files).toBeGreaterThan(100);
    expect(typeof tree.dirty).toBe('boolean');
    const product = upgraded.execution!.product;
    expect(product.package).toBe('gbrain');
    expect(product.declared_pin).toBe(JSON.parse(readFileSync('package.json', 'utf8')).dependencies.gbrain);
    expect(product.declared_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(product.package_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validateStoredReceipt(upgraded)).toEqual([]);
    expect(upgradeReceipt(upgraded)).toEqual(upgraded);
  });

  test('the source-tree hash covers uncommitted edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'receipt-tree-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, 'a.ts'), 'one');
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x']);
      const clean = sourceTreeIdentity(root);
      expect(clean.dirty).toBe(false);
      writeFileSync(join(root, 'a.ts'), 'two');
      writeFileSync(join(root, 'b.ts'), 'new');
      const other = mkdtempSync(join(tmpdir(), 'receipt-tree-copy-'));
      execFileSync('cp', ['-r', `${root}/.`, other]);
      const dirty = sourceTreeIdentity(other);
      expect(dirty.dirty).toBe(true);
      expect(dirty.files).toBe(2);
      expect(dirty.sha256).not.toBe(clean.sha256);
      expect(dirty.git_head).toBe(clean.git_head);
      rmSync(other, { recursive: true, force: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('outside a git checkout the tree is reported unhashed, not faked', () => {
    const root = mkdtempSync(join(tmpdir(), 'receipt-nogit-'));
    try {
      const tree = sourceTreeIdentity(root);
      expect(tree.sha256).toBeNull();
      expect(tree.error).toContain('not a git checkout');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a cue receipt records the gbrain-cues package', () => {
    expect(productIdentity('gbrain-cues').declared_sha).toBe('939232f1746381b4e932d620d6c709e29198f14c');
    expect(upgradeReceipt(makeReceipt({ product_package: 'gbrain-cues' })).execution!.product.package).toBe('gbrain-cues');
  });

  test('errors stay separate from misses in derived accounting', () => {
    const accounting = deriveAccounting({ n_total: 10, n_scored: 7, errors: [
      { probe_id: 'q1', origin: 'dependency', message: 'x' }, { probe_id: 'q1', origin: 'judge', message: 'y' },
      { probe_id: 'q2', origin: 'harness', message: 'z' },
    ] });
    expect(accounting).toEqual({ planned: 10, attempted: 9, scored: 7, errors: 2, misses: null, source: 'derived' });
    const bad = upgradeReceipt(makeReceipt({ accounting: { planned: 10, attempted: 10, scored: 9, errors: 2, misses: null, source: 'runner' } }));
    expect(validateStoredReceipt(bad)).toContain('v2 accounting: scored + errors exceeds attempted');
    const tooManyMisses = upgradeReceipt(makeReceipt({ accounting: { planned: 10, attempted: 10, scored: 10, errors: 0, misses: 11, source: 'runner' } }));
    expect(validateStoredReceipt(tooManyMisses)).toContain('v2 accounting: misses exceed scored');
  });

  test('cost, latency and delivered tokens are null until measured, and validated when present', () => {
    const upgraded = upgradeReceipt(makeReceipt());
    expect([upgraded.cost, upgraded.latency_ms, upgraded.delivered_tokens]).toEqual([null, null, null]);
    expect(latencySummary([], 'x')).toBeNull();
    expect(latencySummary([5, 1, 3, 2, 4], 'per-query search')).toEqual({ p50: 3, p95: 5, n: 5, basis: 'per-query search' });
    const measured = upgradeReceipt(makeReceipt({ cost: { usd: 0.25, input_tokens: 1000, output_tokens: 50, basis: 'provider usage' },
      latency_ms: { p50: 10, p95: 40, n: 20, basis: 'per-query search' }, delivered_tokens: { tokens: 1000, basis: 'provider-reported input tokens' } }));
    expect(validateStoredReceipt(measured)).toEqual([]);
    expect(validateStoredReceipt({ ...measured, latency_ms: { p50: 50, p95: 40, n: 2, basis: 'x' } })).toContain('v2 latency_ms must be null or {p50 <= p95, n, basis}');
  });

  test('legacy v1 receipts stay readable', () => {
    const v1 = { ...makeReceipt(), schema_version: 1 };
    expect(validateStoredReceipt(v1)).toEqual([]);
  });
});

describe('ProbeAccounting merge (N9 seed workers)', () => {
  test('absorbing per-seed state equals recording everything in one accounting', () => {
    const one = new ProbeAccounting(4);
    one.score('1:q:off', 1); one.error('1:q:on', 'sut', 'boom'); one.score('2:q:off', 0.5); one.error('2:q:on', 'harness', 'down');
    const a = new ProbeAccounting(2); a.score('1:q:off', 1); a.error('1:q:on', 'sut', 'boom');
    const b = new ProbeAccounting(2); b.score('2:q:off', 0.5); b.error('2:q:on', 'harness', 'down');
    const merged = new ProbeAccounting(4);
    merged.absorb(JSON.parse(JSON.stringify(a.toJSON())));
    merged.absorb(JSON.parse(JSON.stringify(b.toJSON())));
    expect(merged.summary()).toEqual(one.summary());
    expect(merged.scoredValues()).toEqual(one.scoredValues());
  });
});
