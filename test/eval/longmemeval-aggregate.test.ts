/**
 * longmemeval-aggregate.ts completeness and version provenance (PD-01, PD-02).
 *
 * Keyless: the CLI runs over slices of a committed NDJSON stream and small
 * synthetic rows, with cwd in a temp dir so receipts never touch eval/reports.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkCompleteness, rowGbrainIdentity } from '../../eval/runner/longmemeval-aggregate.ts';
import { gbrainPin, gbrainVersion } from '../../eval/runner/gbrain-version.ts';
import type { NdjsonRow } from '../../eval/runner/longmemeval.ts';

const SCRIPT = join(import.meta.dir, '../../eval/runner/longmemeval-aggregate.ts');
const BRACKET = join(import.meta.dir, '../../docs/benchmarks/2026-05-07-longmemeval-s/prefix-bracket-2a56b512-v0.47.8.0.ndjson');
const TMP = mkdtempSync(join(tmpdir(), 'lme-aggregate-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function row(adapter: string, qid: string, extra: Partial<NdjsonRow> = {}): NdjsonRow {
  return { adapter, question_id: qid, question_type: 'single-session-user', retrieved: ['g'], ground_truth: ['g'], hit_at_k: true,
    recall_all: 1, recall_any: 1, ndcg_any: 1, num_haystack: 1, latency_ms: 1, top_k: 5, dataset: 'synthetic', ...extra };
}

function aggregate(name: string, lines: string[], args: string[] = []) {
  const input = join(TMP, `${name}.ndjson`);
  writeFileSync(input, lines.join('\n') + '\n');
  const proc = Bun.spawnSync(['bun', SCRIPT, input, '--min-recall-all', '0', ...args], { cwd: TMP });
  const receipt = JSON.parse(readFileSync(join(TMP, 'eval/reports/longmemeval-aggregate/receipt.json'), 'utf8'));
  const output = proc.exitCode === 0 ? JSON.parse(readFileSync(join(TMP, `${name}.json`), 'utf8')) : null;
  return { code: proc.exitCode, stderr: proc.stderr.toString(), receipt, output };
}

describe('completeness (PD-01)', () => {
  test('checkCompleteness requires the exact expected count for every adapter', () => {
    const rows = [row('a', 'q1'), row('a', 'q2'), row('b', 'q1')];
    expect(checkCompleteness(rows, 2)).toMatchObject({ complete: false, rows_by_adapter: { a: 2, b: 1 } });
    expect(checkCompleteness(rows, 2).reason).toContain('b has 1');
    expect(checkCompleteness(rows.slice(0, 2), 2).complete).toBe(true);
    expect(checkCompleteness(rows, null)).toMatchObject({ complete: false, expected_rows_per_adapter: null });
  });

  test('the committed 8-row sessdiv slice of a 500-question split is partial and not publishable', () => {
    const lines = readFileSync(BRACKET, 'utf8').split('\n').filter(l => l.includes('"adapter":"gbrain-hybrid-sessdiv"'));
    expect(lines).toHaveLength(8);
    const r = aggregate('bracket-sessdiv', lines);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('NOT publishable');
    expect(r.receipt).toMatchObject({ run_status: 'completed', verdict: 'partial', publishable: false, n_total: 500, n_scored: 8 });
    expect(r.receipt.completion_rate).toBeCloseTo(8 / 500);
    expect(r.receipt.resolved_config.completeness).toMatchObject({ expected_rows_per_adapter: 500, rows_by_adapter: { 'gbrain-hybrid-sessdiv': 8 } });
  }, 30_000);

  test('a complete run is publishable; an unsized dataset needs --expect-rows or --path', () => {
    const lines = ['q1', 'q2'].map(q => JSON.stringify(row('a', q)));
    const unsized = aggregate('unsized', lines);
    expect(unsized.receipt).toMatchObject({ verdict: 'partial', publishable: false });
    expect(unsized.stderr).toContain('expected row count unknown');
    expect(aggregate('sized', lines, ['--expect-rows', '2']).receipt).toMatchObject({ verdict: 'pass', publishable: true, n_total: 2 });
    writeFileSync(join(TMP, 'dataset.json'), JSON.stringify([{ question_id: 'q1' }, { question_id: 'q2' }, { question_id: 'q3' }]));
    expect(aggregate('from-path', lines, ['--path', join(TMP, 'dataset.json')]).receipt).toMatchObject({ verdict: 'partial', publishable: false, n_total: 3 });
    expect(aggregate('strict', lines, ['--expect-rows', '3']).code).toBe(1);
  }, 30_000);
});

describe('version provenance (PD-02)', () => {
  test('rowGbrainIdentity copies the row stamp, reports unknown for unstamped rows, and refuses a mix', () => {
    const stamped = { gbrain_version: '0.1.0.0', gbrain_pin: 'github:example/gbrain#abc' };
    expect(rowGbrainIdentity([row('a', 'q1', stamped), row('a', 'q2', stamped)])).toEqual(stamped);
    expect(rowGbrainIdentity([row('a', 'q1')])).toEqual({ gbrain_version: 'unknown', gbrain_pin: 'unknown' });
    expect(() => rowGbrainIdentity([row('a', 'q1', stamped), row('a', 'q2')])).toThrow(/mixed gbrain_version/);
  });

  test('legacy rows are stamped unknown and the local install is labeled as the aggregator', () => {
    const lines = readFileSync(BRACKET, 'utf8').split('\n').filter(l => l.includes('"adapter":"gbrain-hybrid-sessdiv"'));
    const r = aggregate('legacy-version', lines);
    expect(r.receipt).toMatchObject({ gbrain_version: 'unknown', gbrain_pin: 'unknown' });
    expect(r.receipt.resolved_config).toMatchObject({ aggregator_gbrain_version: gbrainVersion(), aggregator_gbrain_pin: gbrainPin() });
    expect(r.output.resolved).toMatchObject({ gbrain_version: 'unknown', gbrain_pin: 'unknown', aggregator_gbrain_version: gbrainVersion() });
  }, 30_000);

  test('stamped rows carry their producer version; mixed versions fail', () => {
    const stamped = { gbrain_version: '0.1.0.0', gbrain_pin: 'github:example/gbrain#abc' };
    const r = aggregate('stamped', ['q1', 'q2'].map(q => JSON.stringify(row('a', q, stamped))), ['--expect-rows', '2']);
    expect(r.receipt).toMatchObject(stamped);
    expect(r.output.resolved).toMatchObject(stamped);
    const mixed = aggregate('mixed-version', [JSON.stringify(row('a', 'q1', stamped)), JSON.stringify(row('a', 'q2', { ...stamped, gbrain_version: '0.2.0.0' }))]);
    expect(mixed.code).toBe(1);
    expect(mixed.stderr).toContain('mixed gbrain_version');
    expect(mixed.receipt).toMatchObject({ run_status: 'error', gbrain_version: 'unknown' });
  }, 30_000);
});
