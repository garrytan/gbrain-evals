import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateRunnerContext } from '../../eval/runner/eval-engine.ts';
import { validateReceipt } from '../../eval/runner/receipt.ts';
import {
  conformanceVerdict, runMemoryVerbConformance, splitConformanceResults, summarizeConformance,
} from '../../eval/runner/memory-verb-conformance.ts';

const CASES = [{ name: 'a', verb: 'remember' }, { name: 'b', verb: 'recall' }, { name: 'c', verb: 'forget' }];

describe('memory-verb conformance scoring', () => {
  test('cases match by name in fixture order; tools/list checks stay separate; a missing case fails', () => {
    const { rows, listChecks } = splitConformanceResults(CASES, [
      { name: 'tools/list advertises recall', verb: 'recall', status: 'pass', detail: '' },
      { name: 'b', verb: 'recall', status: 'pass', detail: '' },
      { name: 'a', verb: 'remember', status: 'fail', detail: 'status missing' },
    ]);
    expect(rows.map(r => [r.case_id, r.index, r.status])).toEqual([['a', 0, 'fail'], ['b', 1, 'pass'], ['c', 2, 'missing']]);
    expect(listChecks.map(c => c.check)).toEqual(['tools/list advertises recall']);
    const s = summarizeConformance(rows, listChecks, 1);
    expect([s.cases_passed, s.cases_failed, s.cases_total]).toEqual([1, 2, 3]);
    expect(conformanceVerdict(s)).toBe('fail');
  });

  test('a skipped case or a failed tools/list check is not a pass; an empty run never passes', () => {
    const all = CASES.map(c => ({ ...c, status: 'pass' as const, detail: '' }));
    const ok = splitConformanceResults(CASES, all);
    expect(conformanceVerdict(summarizeConformance(ok.rows, ok.listChecks, 1))).toBe('pass');
    const skipped = splitConformanceResults(CASES, [...all.slice(0, 2), { ...all[2], status: 'skip' as const }]);
    expect(conformanceVerdict(summarizeConformance(skipped.rows, skipped.listChecks, 1))).toBe('fail');
    const listFail = splitConformanceResults(CASES, [...all, { name: 'synthesize is marked expensive', verb: 'synthesize', status: 'fail' as const, detail: '' }]);
    expect(conformanceVerdict(summarizeConformance(listFail.rows, listFail.listChecks, 1))).toBe('fail');
    expect(conformanceVerdict(summarizeConformance([], [], 1))).toBe('fail');
  });
});

describe('memory-verb conformance end to end on the pinned gbrain (in-memory PGLite, keyless)', () => {
  const ctx = gateRunnerContext(['bun', 'memory-verb-conformance.ts'], {});

  test('every case passes, no model transport is reached and the receipt is valid', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'mvc-test-'));
    try {
      const { receipt, exitCode } = await runMemoryVerbConformance({ ctx, reportsDir, quiet: true });
      const data = receipt.data as { summary: { cases_total: number; cases_passed: number }; rigged_transport_calls: { chat: number; embed: number } };
      expect(validateReceipt(receipt)).toEqual([]);
      expect(data.summary.cases_total).toBeGreaterThan(0);
      expect(data.summary.cases_passed).toBe(data.summary.cases_total);
      expect(data.rigged_transport_calls).toEqual({ chat: 0, embed: 0 });
      expect(receipt.verdict).toBe('pass');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(reportsDir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a lying server fails: remember without its required status field', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'mvc-test-'));
    try {
      const { receipt, exitCode } = await runMemoryVerbConformance({
        ctx, reportsDir, quiet: true,
        corruptResponse: (verb, body) => (verb === 'remember' ? (({ status: _s, ...rest }) => rest)(body) : body),
      });
      const cases = (receipt.data as { cases: Array<{ verb: string; status: string }> }).cases;
      expect(receipt.verdict).toBe('fail');
      expect(cases.some(c => c.verb === 'remember' && c.status === 'fail')).toBe(true);
      expect(exitCode).toBe(1);
    } finally {
      rmSync(reportsDir, { recursive: true, force: true });
    }
  }, 120_000);
});
