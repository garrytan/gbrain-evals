/**
 * eval/verify/judge-model-evidence.ts tests — keyless, $0.
 *
 * Model-id classification, the singleResolvedModel contract (mirrors
 * cat35-judges.ts), every receipt branch (snapshot; alias under the
 * contract with a good map / null key / mixed / absent; legacy alias with
 * and without a manifest note; undated), the real repo (zero failures;
 * the four Cat 35 receipts are legacy), and the CLI exit codes on a
 * fixture with one contract-violating receipt.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import {
  CONTRACT_DATE,
  checkJudgeModelEvidence,
  checkReceipt,
  classifyModelId,
  singleResolvedModel,
} from '../../eval/verify/judge-model-evidence.ts';
import { initRepo, put, commitAll, cleanup, at, severities, runCliFile } from './verify-fixtures.ts';

const SCRIPT = join(import.meta.dir, '../../eval/verify/judge-model-evidence.ts');

describe('classifyModelId', () => {
  test('dated suffix is a snapshot; anything else is an alias', () => {
    expect(classifyModelId('claude-haiku-4-5-20251001')).toBe('snapshot');
    expect(classifyModelId('claude-sonnet-4-6')).toBe('alias');
    expect(classifyModelId('claude-opus-4-1-20250805')).toBe('snapshot');
    expect(classifyModelId('claude-sonnet-4-6-2025')).toBe('alias');
  });
});

describe('singleResolvedModel', () => {
  test('exactly one real model with a positive integer count', () => {
    expect(singleResolvedModel({ 'claude-sonnet-4-6-20260115': 130 })).toBe('claude-sonnet-4-6-20260115');
  });
  test('rejects absent, empty, null-keyed, mixed, and non-count values', () => {
    expect(singleResolvedModel(undefined)).toBeNull();
    expect(singleResolvedModel({})).toBeNull();
    expect(singleResolvedModel({ null: 3 })).toBeNull();
    expect(singleResolvedModel({ a: 1, b: 2 })).toBeNull();
    expect(singleResolvedModel({ a: 0 })).toBeNull();
    expect(singleResolvedModel({ a: '1' })).toBeNull();
    expect(singleResolvedModel([1])).toBeNull();
  });
});

describe('checkReceipt', () => {
  const root = '/nonexistent-root';
  test('no judge_model → nothing', () => {
    expect(checkReceipt('x.json', { foo: 1 }, root, CONTRACT_DATE)).toEqual([]);
  });
  test('snapshot → info', () => {
    const f = checkReceipt('x.json', { judge_model: 'claude-haiku-4-5-20251001' }, root, CONTRACT_DATE);
    expect(f.map(x => x.severity)).toEqual(['info']);
  });
  test('alias under contract with a single resolved model → info', () => {
    const f = checkReceipt('x.json', { judge_model: 'claude-sonnet-4-6', timestamp: '2026-09-02T00:00:00Z', judge_models_resolved: { 'claude-sonnet-4-6-20260101': 12 } }, root, CONTRACT_DATE);
    expect(f[0].severity).toBe('info');
    expect(f[0].message).toContain('claude-sonnet-4-6-20260101');
  });
  test('alias under contract with a null-keyed / mixed / absent map → fail with the evidence', () => {
    for (const map of [{ null: 4 }, { a: 1, b: 1 }, undefined]) {
      const f = checkReceipt('x.json', { judge_model: 'claude-sonnet-4-6', timestamp: '2026-09-01T00:00:00Z', ...(map ? { judge_models_resolved: map } : {}) }, root, CONTRACT_DATE);
      expect(f).toHaveLength(1);
      expect(f[0].severity).toBe('fail');
      expect(f[0].message).toContain(map ? JSON.stringify(map) : 'absent');
    }
  });
  test('the contract boundary is inclusive of the contract instant and exclusive before it', () => {
    const before = checkReceipt('x.json', { judge_model: 'claude-sonnet-4-6', timestamp: '2026-08-31T23:59:59.999Z' }, root, CONTRACT_DATE);
    expect(before[0].severity).toBe('warn');
    const atInstant = checkReceipt('x.json', { judge_model: 'claude-sonnet-4-6', timestamp: '2026-09-01T00:00:00.000Z' }, root, CONTRACT_DATE);
    expect(atInstant[0].severity).toBe('fail');
  });
  test('legacy alias without a manifest note → warn; undated → treated as legacy', () => {
    const f = checkReceipt('x.json', { judge_model: 'claude-sonnet-4-6' }, root, CONTRACT_DATE);
    expect(f[0].severity).toBe('warn');
    expect(f[0].message).toContain('undated');
  });
});

describe('legacy receipts against a manifest note', () => {
  let root: string;
  beforeAll(() => {
    root = initRepo('verify-judge');
    put(root, 'docs/receipts-manifest.json', JSON.stringify({
      schema_version: 1,
      entries: [
        { claim_id: 'a', artifact_path: 'docs/benchmarks/a.json', note: 'judge_model records the movable alias claude-sonnet-4-6, not a dated snapshot' },
        { claim_id: 'b', artifact_path: 'docs/benchmarks/b.json', note: 'a note that says nothing about the model' },
      ],
    }));
    put(root, 'docs/benchmarks/a.json', JSON.stringify({ judge_model: 'claude-sonnet-4-6', timestamp: '2026-08-25T00:00:00Z' }));
    put(root, 'docs/benchmarks/b.json', JSON.stringify({ judge_model: 'claude-sonnet-4-6', timestamp: '2026-08-25T00:00:00Z' }));
    put(root, 'docs/benchmarks/c.json', JSON.stringify({ judge_model: 'claude-sonnet-4-6', timestamp: '2026-09-03T00:00:00Z' }));
    put(root, 'docs/benchmarks/d.json', JSON.stringify({ judge_model: 'claude-sonnet-4-6', timestamp: '2026-09-03T00:00:00Z', judge_models_resolved: { 'claude-sonnet-4-6-20260901': 3 } }));
    put(root, 'docs/benchmarks/broken.json', '{');
    commitAll(root);
  });
  afterAll(() => cleanup(root));

  test('manifest note naming the alias → info; note without → warn', () => {
    const r = checkJudgeModelEvidence({ root, skipInventory: true });
    expect(at(r, 'docs/benchmarks/a.json')[0].severity).toBe('info');
    expect(at(r, 'docs/benchmarks/b.json')[0].severity).toBe('warn');
  });
  test('contract receipts: missing map fails, good map passes; unparseable JSON is skipped here', () => {
    const r = checkJudgeModelEvidence({ root, skipInventory: true });
    expect(at(r, 'docs/benchmarks/c.json')[0].severity).toBe('fail');
    expect(at(r, 'docs/benchmarks/d.json')[0].severity).toBe('info');
    expect(at(r, 'broken.json')).toEqual([]);
    expect(severities(r).fail).toBe(1);
  });
  test('--contract-date moves the boundary', () => {
    const r = checkJudgeModelEvidence({ root, skipInventory: true, contractDate: '2027-01-01T00:00:00Z' });
    expect(severities(r).fail).toBe(0);
  });
  test('CLI exits 1 on the fixture and 0 with the boundary moved', () => {
    expect(runCliFile(SCRIPT, ['--root', root, '--quiet']).code).toBe(1);
    expect(runCliFile(SCRIPT, ['--root', root, '--quiet', '--contract-date', '2027-01-01T00:00:00Z']).code).toBe(0);
  });
});

describe('judge-model-evidence on this repo', () => {
  const report = checkJudgeModelEvidence();
  test('no failures on main', () => {
    expect(report.findings.filter(f => f.severity === 'fail')).toEqual([]);
  });
  test('the published Cat 35 receipts are legacy alias receipts with the caveat in the manifest', () => {
    for (const name of ['baseline-receipt.json', 'receipt-2026-08-31-prewave-baseline-aa820c7f.json', 'receipt-2026-08-31-v0.47.8.0-wave-079941d2.json']) {
      const f = at(report, name);
      expect(f).toHaveLength(1);
      expect(f[0].severity).toBe('info');
      expect(f[0].message).toMatch(/caveat disclosed/);
    }
  });
  test('the code inventory names both the snapshot and the alias judges', () => {
    expect(at(report, 'code:claude-haiku-4-5-20251001', 'info')).toHaveLength(1);
    expect(at(report, 'code:claude-sonnet-4-6', 'info')).toHaveLength(1);
  });
});
