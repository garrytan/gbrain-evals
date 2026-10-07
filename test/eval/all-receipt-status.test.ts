/**
 * all.ts receipt-driven status — the MANDATORY regression for the cat11
 * class (audit finding retrieval-cats-06: every modality skipped, exit 0,
 * all.ts recorded PASS while measuring nothing).
 *
 * Iron rule from the eng review: a category reporting run_status 'skipped'
 * can never aggregate as pass, no matter what the exit code says.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deriveStatus, loadFreshReceipt } from '../../eval/runner/all.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, upgradeReceipt, type Receipt } from '../../eval/runner/receipt.ts';

const ok = (r: Receipt) => deriveStatus({ kind: 'ok', receipt: r });

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

describe('deriveStatus', () => {
  test('REGRESSION: skipped receipt is SKIPPED, never pass', () => {
    const derived = ok(receipt({ run_status: 'skipped', skip_reason: 'fixtures missing', verdict: undefined }));
    expect(derived.status).toBe('skipped');
    expect(derived.statusSource).toBe('receipt');
    expect(derived.statusNote).toContain('fixtures missing');
  });

  test('completed + verdict pass → pass', () => {
    expect(ok(receipt({})).status).toBe('pass');
  });

  test('completed + verdict fail → fail', () => {
    expect(ok(receipt({ verdict: 'fail' })).status).toBe('fail');
  });

  test('completed + verdict partial does not meet the bar → fail', () => {
    expect(ok(receipt({ verdict: 'partial' })).status).toBe('fail');
  });

  test('run_status error → fail', () => {
    expect(ok(receipt({ run_status: 'error', verdict: undefined })).status).toBe('fail');
  });

  test('C-06: no receipt is a FAIL, never an exit-code pass', () => {
    const derived = deriveStatus({ kind: 'missing' });
    expect(derived.status).toBe('fail');
    expect(derived.statusSource).toBe('no-receipt');
    expect(deriveStatus({ kind: 'stale', mtime: 't' }).status).toBe('fail');
  });

  test('C-07: an invalid receipt is a FAIL with the reason', () => {
    const derived = deriveStatus({ kind: 'invalid', reason: 'completed receipt requires verdict pass|partial|fail' });
    expect(derived.status).toBe('fail');
    expect(derived.statusNote).toContain('invalid receipt');
    expect(derived.statusNote).toContain('requires verdict');
  });

  test('report-only: a completed non-pass verdict is REPORTED, never pass and never fail', () => {
    const reportOnly = (r: Receipt) => deriveStatus({ kind: 'ok', receipt: r }, 'report-only');
    expect(reportOnly(receipt({ verdict: 'fail' })).status).toBe('reported');
    expect(reportOnly(receipt({ verdict: 'partial' })).status).toBe('reported');
    expect(reportOnly(receipt({})).status).toBe('pass');
  });

  test('report-only never softens a broken run: error, missing, stale and invalid receipts still fail', () => {
    expect(deriveStatus({ kind: 'ok', receipt: receipt({ run_status: 'error', verdict: undefined }) }, 'report-only').status).toBe('fail');
    expect(deriveStatus({ kind: 'missing' }, 'report-only').status).toBe('fail');
    expect(deriveStatus({ kind: 'stale', mtime: 't' }, 'report-only').status).toBe('fail');
    expect(deriveStatus({ kind: 'invalid', reason: 'x' }, 'report-only').status).toBe('fail');
    expect(deriveStatus({ kind: 'ok', receipt: receipt({ run_status: 'skipped', skip_reason: 'no key', verdict: undefined }) }, 'report-only').status).toBe('skipped');
  });

  test('unpublishable completed run is noted', () => {
    expect(ok(receipt({ publishable: false })).statusNote).toContain('not publishable');
  });
});

describe('loadFreshReceipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'all-receipt-'));
  const path = join(dir, 'receipt.json');

  test('missing file is missing', () => {
    expect(loadFreshReceipt(join(dir, 'nope.json'), 0).kind).toBe('missing');
  });

  test('C-07: a malformed receipt is invalid, not missing', () => {
    writeFileSync(path, JSON.stringify({ ...receipt({}), verdict: undefined }));
    const load = loadFreshReceipt(path, 0);
    expect(load.kind).toBe('invalid');
    writeFileSync(path, '{not json');
    expect(loadFreshReceipt(path, 0).kind).toBe('invalid');
  });

  test('a receipt older than the run start is stale', () => {
    writeFileSync(path, JSON.stringify(receipt({})));
    utimesSync(path, new Date(1000), new Date(1000));
    expect(loadFreshReceipt(path, Date.now()).kind).toBe('stale');
  });

  test('a fresh valid receipt loads, in schema v2 or legacy v1', () => {
    // A stated execution block keeps upgradeReceipt from hashing the source tree and the installed package (about
    // 1 s idle, over 5 s under four concurrent test shards), which this test does not exercise.
    const execution = {
      source_tree: { sha256: null, files: 0, git_head: null, dirty: null, error: 'not hashed in this test' },
      product: { package: 'gbrain', declared_pin: null, declared_sha: null, version: null, package_sha256: null, loaded_git_head: null, error: 'not hashed in this test' },
    };
    writeFileSync(path, JSON.stringify(upgradeReceipt({ ...receipt({}), execution } as never)));
    expect(loadFreshReceipt(path, Date.now() - 60_000).kind).toBe('ok');
    writeFileSync(path, JSON.stringify({ ...receipt({}), schema_version: 1 }));
    expect(loadFreshReceipt(path, Date.now() - 60_000).kind).toBe('ok');
  });

  test('a v2 receipt on disk without its v2 blocks is invalid', () => {
    writeFileSync(path, JSON.stringify(receipt({})));
    expect(loadFreshReceipt(path, Date.now() - 60_000).kind).toBe('invalid');
    rmSync(dir, { recursive: true, force: true });
  });
});
