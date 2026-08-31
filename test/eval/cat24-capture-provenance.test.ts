/**
 * cat24-capture-provenance.ts regression tests (audit cats22-25-04/10).
 *
 * Hermetic: no API keys. Gateway env is sanitized by the runner; all writes
 * are noEmbed / deferEmbeds.
 *
 * Gates proven failable AND passing:
 *   - the runner drives genuinely distinct ingestion paths (content import,
 *     file import, put_page op local, put_page op remote) instead of five
 *     labels on one function — asserted via the per-path expectations that
 *     DIFFER between paths (file import NULL provenance vs op-layer stamps)
 *   - the remote spoof-override probe FAILS when the trust gate is bypassed
 *     (simulateBrokenTrustGate routes the spoofed write through a trusted
 *     ctx, so the spoofed 'capture-cli' lands and the assertion trips)
 *   - checkProvenance detects every field drift (unit tests)
 *   - dedup asserts the before-state (a failed first import can no longer
 *     make distinct_page_ids===1 pass vacuously)
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runCat24,
  checkProvenance,
  CAT24_CATEGORY,
  type ProvenanceRow,
} from '../../eval/runner/cat24-capture-provenance.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';

const RUN_TIMEOUT = 300_000;

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat24-test-reports-'));
}

// ─── checkProvenance: field-drift detection ──────────────────────────

describe('checkProvenance', () => {
  const row: ProvenanceRow = {
    source_kind: 'capture-cli',
    source_uri: 'stdin',
    ingested_via: 'capture-cli',
    ingested_at: new Date('2026-05-23T00:00:00Z'),
    source_path: null,
  };

  test('exact match passes', () => {
    expect(checkProvenance(row, { source_kind: 'capture-cli', source_uri: 'stdin', ingested_via: 'capture-cli', ingested_at_null: false })).toBeNull();
  });

  test('missing row fails', () => {
    expect(checkProvenance(null, { source_kind: 'capture-cli', source_uri: 'stdin', ingested_via: 'capture-cli', ingested_at_null: false })).toContain('not found');
  });

  test('each field drift is detected', () => {
    expect(checkProvenance(row, { source_kind: 'mcp:put_page', source_uri: 'stdin', ingested_via: 'capture-cli', ingested_at_null: false })).toContain('source_kind');
    expect(checkProvenance(row, { source_kind: 'capture-cli', source_uri: null, ingested_via: 'capture-cli', ingested_at_null: false })).toContain('source_uri');
    expect(checkProvenance(row, { source_kind: 'capture-cli', source_uri: 'stdin', ingested_via: 'mcp:put_page', ingested_at_null: false })).toContain('ingested_via');
    expect(checkProvenance(row, { source_kind: 'capture-cli', source_uri: 'stdin', ingested_via: 'capture-cli', ingested_at_null: true })).toContain('ingested_at');
  });

  test('expected-NULL row passes only when actually NULL (file-import boundary)', () => {
    const nullRow: ProvenanceRow = { source_kind: null, source_uri: null, ingested_via: null, ingested_at: null, source_path: 'inbox/x.md' };
    expect(checkProvenance(nullRow, { source_kind: null, source_uri: null, ingested_via: null, ingested_at_null: true })).toBeNull();
    expect(checkProvenance(row, { source_kind: null, source_uri: null, ingested_via: null, ingested_at_null: true })).toContain('source_kind');
  });
});

// ─── End to end: distinct paths pass; broken trust gate fails ────────

describe('runCat24 end to end (hermetic)', () => {
  test('real ingestion paths → verdict pass with path-specific provenance', async () => {
    const reportsDir = tmpReports();
    const result = await runCat24({ reportsDir, quiet: true });
    expect(result.exitCode).toBe(0);
    expect(result.receipt.verdict).toBe('pass');

    // The paths are genuinely distinct: their observed provenance DIFFERS.
    const byId = new Map(result.probes.map(p => [p.probe_id, p]));
    expect(byId.get('content-import')?.actual?.source_kind).toBe('capture-cli');
    // File import: no channel provenance by design; source_path carries it.
    const fileProbe = byId.get('file-import-no-channel-provenance');
    expect(fileProbe?.actual?.source_kind).toBeNull();
    expect(fileProbe?.actual?.ingested_at).toBeNull();
    // Op layer, trusted local: client values land.
    expect(byId.get('op-put-page-local-trusted')?.actual?.source_kind).toBe('capture-cli');
    // Op layer, remote: the CV6 trust gate server-stamps despite the spoof.
    const remote = byId.get('op-put-page-remote-spoof-override');
    expect(remote?.actual?.source_kind).toBe('mcp:put_page');
    expect(remote?.actual?.source_uri).toBeNull();
    expect(remote?.actual?.ingested_via).toBe('mcp:put_page');

    // Receipt on disk validates and carries the honest path inventory.
    const receipt = loadReceipt(receiptPath(CAT24_CATEGORY, reportsDir));
    expect(receipt.verdict).toBe('pass');
    const rc = receipt.resolved_config as Record<string, unknown>;
    expect(Array.isArray(rc.distinct_ingestion_paths)).toBe(true);
    expect((rc.distinct_ingestion_paths as string[]).length).toBe(4);
    expect(String(rc.out_of_scope)).toContain('ingestion daemon');
  }, RUN_TIMEOUT);

  test('bypassed trust gate → spoofed provenance lands → verdict fail + non-zero exit', async () => {
    const reportsDir = tmpReports();
    const result = await runCat24({ reportsDir, quiet: true, simulateBrokenTrustGate: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.receipt.verdict).toBe('fail');
    const remote = result.probes.find(p => p.probe_id === 'op-put-page-remote-spoof-override');
    expect(remote?.pass).toBe(false);
    // The spoofed client value landed — exactly the regression the probe exists to catch.
    expect(remote?.actual?.source_kind).toBe('capture-cli');
    expect(result.receipt.errors.some(e => e.origin === 'sut' && e.probe_id === 'op-put-page-remote-spoof-override')).toBe(true);
    // A gate-bypass simulation is never publishable.
    expect(result.receipt.publishable).toBe(false);
  }, RUN_TIMEOUT);
});
