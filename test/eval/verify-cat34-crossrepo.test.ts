/**
 * eval/verify/cat34-crossrepo.ts tests — keyless, $0.
 *
 * The pure comparison over synthetic receipt/baseline pairs (identical;
 * one metric drifted; a cell missing from the baseline; a baseline cell
 * the receipt does not cover; fixtures-hash mismatch; pin mismatch; no
 * SHA), the UNAVAILABLE path when gbrain is not installed, and the real
 * pair when node_modules/gbrain is present: with the receipt at the
 * package.json pin, 12 cells digit-for-digit; with the pin moved past the
 * receipt (v0.6.1 → v0.48.2.0), the check must say so — the gap it exists
 * to catch, never a silent pass.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_BASELINE, DEFAULT_RECEIPT, checkCat34CrossRepo, compareCat34 } from '../../eval/verify/cat34-crossrepo.ts';
import { initRepo, put, commitAll, cleanup, at, severities, runCliFile } from './verify-fixtures.ts';

const SCRIPT = join(import.meta.dir, '../../eval/verify/cat34-crossrepo.ts');
const SHA = '2a56b51236850f6abcbf2f1ea71981bb9630f6fe';
const FIX = 'f'.repeat(64);

function receipt(over: Record<string, unknown> = {}) {
  return {
    gbrain_pin: `github:garrytan/gbrain#${SHA}`,
    hashes: { fixtures: FIX },
    data: {
      cells: [
        { cell: 'claude-code/push', metrics: { push_precision: 1, push_recall: 0.9063 } },
        { cell: 'codex/push', metrics: { push_precision: 1, push_recall: 0.5521 } },
      ],
    },
    ...over,
  };
}
function baseline(over: Record<string, unknown> = {}) {
  return {
    fixtures_hash: FIX,
    cells: {
      'claude-code/push': { push_precision: 1, push_recall: 0.9063 },
      'codex/push': { push_precision: 1, push_recall: 0.5521 },
    },
    ...over,
  };
}

describe('compareCat34', () => {
  test('identical pair: no failures, metrics counted', () => {
    const f = compareCat34(receipt(), baseline(), SHA, 'r.json');
    expect(f.filter(x => x.severity === 'fail')).toEqual([]);
    expect(f[f.length - 1].message).toMatch(/4 metric\(s\) compared/);
  });
  test('one drifted metric fails with both values', () => {
    const b = baseline();
    (b.cells['codex/push'] as Record<string, unknown>).push_recall = 0.5522;
    const f = compareCat34(receipt(), b, SHA, 'r.json').filter(x => x.severity === 'fail');
    expect(f).toHaveLength(1);
    expect(f[0].where).toBe('codex/push.push_recall');
    expect(f[0].message).toContain('0.5521');
    expect(f[0].message).toContain('0.5522');
  });
  test('receipt cell missing from the baseline fails; extra baseline cell warns', () => {
    const b = baseline({ cells: { 'claude-code/push': { push_precision: 1, push_recall: 0.9063 }, 'openclaw/push': { push_recall: 1 } } });
    const f = compareCat34(receipt(), b, SHA, 'r.json');
    expect(at({ check: 'x', findings: f }, 'codex/push', 'fail')).toHaveLength(1);
    expect(at({ check: 'x', findings: f }, 'openclaw/push', 'warn')).toHaveLength(1);
  });
  test('metric present in receipt but absent from the baseline cell fails', () => {
    const b = baseline({ cells: { 'claude-code/push': { push_precision: 1 }, 'codex/push': { push_precision: 1, push_recall: 0.5521 } } });
    const f = compareCat34(receipt(), b, SHA, 'r.json').filter(x => x.severity === 'fail');
    expect(f[0].where).toBe('claude-code/push.push_recall');
  });
  test('fixtures hash mismatch and pin mismatch fail; missing SHA fails', () => {
    expect(at({ check: 'x', findings: compareCat34(receipt(), baseline({ fixtures_hash: 'e'.repeat(64) }), SHA, 'r.json') }, 'fixtures_hash', 'fail')).toHaveLength(1);
    expect(at({ check: 'x', findings: compareCat34(receipt(), baseline(), 'a'.repeat(40), 'r.json') }, 'gbrain_pin', 'fail')).toHaveLength(1);
    expect(at({ check: 'x', findings: compareCat34(receipt({ gbrain_pin: 'github:garrytan/gbrain' }), baseline(), SHA, 'r.json') }, 'gbrain_pin', 'fail')).toHaveLength(1);
  });
  test('an empty cell list fails', () => {
    const f = compareCat34(receipt({ data: { cells: [] } }), baseline(), SHA, 'r.json');
    expect(at({ check: 'x', findings: f }, 'data.cells', 'fail')).toHaveLength(1);
  });
});

describe('checkCat34CrossRepo on fixtures', () => {
  test('no installed gbrain → UNAVAILABLE (exit 2), never a silent pass', () => {
    const root = initRepo('verify-cat34-noinstall');
    put(root, 'package.json', JSON.stringify({ dependencies: { gbrain: `github:garrytan/gbrain#${SHA}` } }));
    put(root, 'docs/benchmarks/r.json', JSON.stringify(receipt()));
    commitAll(root);
    const r = checkCat34CrossRepo({ root, receipt: 'docs/benchmarks/r.json' });
    expect(r.unavailable).toMatch(/bun install/);
    expect(runCliFile(SCRIPT, ['--root', root, '--receipt', 'docs/benchmarks/r.json']).code).toBe(2);
    cleanup(root);
  });
  test('installed fixture: identical → 0, drifted → 1', () => {
    const root = initRepo('verify-cat34-install');
    put(root, 'package.json', JSON.stringify({ dependencies: { gbrain: `github:garrytan/gbrain#${SHA}` } }));
    put(root, 'docs/benchmarks/r.json', JSON.stringify(receipt()));
    put(root, DEFAULT_BASELINE, JSON.stringify(baseline()));
    expect(runCliFile(SCRIPT, ['--root', root, '--receipt', 'docs/benchmarks/r.json', '--quiet']).code).toBe(0);
    const b = baseline();
    (b.cells['claude-code/push'] as Record<string, unknown>).push_recall = 0.9;
    put(root, DEFAULT_BASELINE, JSON.stringify(b));
    const r = runCliFile(SCRIPT, ['--root', root, '--receipt', 'docs/benchmarks/r.json', '--quiet']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/claude-code\/push\.push_recall/);
    cleanup(root);
  });
});

describe('cat34-crossrepo on this repo', () => {
  const REPO = join(import.meta.dir, '../..');
  const installed = existsSync(join(REPO, DEFAULT_BASELINE));
  const pkgPin = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies.gbrain.match(/#([0-9a-f]{40})$/)?.[1];
  const receiptPin = (JSON.parse(readFileSync(join(REPO, DEFAULT_RECEIPT), 'utf8')) as { gbrain_pin?: string }).gbrain_pin?.match(/#([0-9a-f]+)$/)?.[1];
  const atPin = pkgPin !== undefined && pkgPin === receiptPin;
  test.if(installed && atPin)('receipt at the package.json pin: reproduces gbrain\'s baseline, every cell', () => {
    const r = checkCat34CrossRepo();
    expect(r.unavailable).toBeUndefined();
    expect(severities(r).fail).toBe(0);
    expect(severities(r).warn).toBe(0);
    expect(r.findings[r.findings.length - 1].where).toMatch(/12 cell\(s\)/);
    expect(r.findings[r.findings.length - 1].message).toMatch(/39 metric\(s\)/);
  });
  test.if(installed && !atPin)('package.json pin moved past the receipt: the check fails on the pin and names every drifted metric', () => {
    const r = checkCat34CrossRepo();
    expect(r.unavailable).toBeUndefined();
    expect(at(r, 'gbrain_pin', 'fail')).toHaveLength(1);
    expect(at(r, 'gbrain_pin', 'fail')[0].message).toContain('"at the pin" is not true');
    expect(severities(r).fail).toBeGreaterThanOrEqual(1);
    expect(r.findings[r.findings.length - 1].message).toMatch(/metric\(s\) compared digit-for-digit/);
  });
  test.if(!installed)('gbrain not installed here: the check reports UNAVAILABLE', () => {
    expect(checkCat34CrossRepo().unavailable).toBeDefined();
  });
});
