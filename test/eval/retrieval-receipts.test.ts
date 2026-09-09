import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { RipgrepBm25Adapter } from '../../eval/runner/adapters/grep-only.ts';
import { main as multiAdapterMain } from '../../eval/runner/multi-adapter.ts';
import { main as precisionMain, parseOpts } from '../../eval/runner/precisionmembench.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';

describe('retrieval runner failure receipts', () => {
  test('think rejects unobservable ON controls while preserving its default and explicit OFF settings', () => {
    for (const flag of ['--reranker', '--autocut']) {
      expect(() => parseOpts(['--mode', 'gbrain-think', flag, 'on'])).toThrow('gbrain-think supports only --reranker off --autocut off');
    }
    expect(parseOpts(['--mode', 'gbrain-think'])).toMatchObject({ mode: 'gbrain-think', reranker: 'off', autocut: 'off' });
    expect(parseOpts(['--mode', 'gbrain-think', '--reranker', 'off', '--autocut', 'off'])).toMatchObject({ mode: 'gbrain-think', reranker: 'off', autocut: 'off' });
  });

  test('multi-adapter retains query results in a valid error receipt after one query throws', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multi-failure-receipt-'));
    const receiptFile = join(directory, 'receipt.json');
    const savedRuns = process.env.BRAINBENCH_N;
    process.env.BRAINBENCH_N = '1';
    const originalQuery = RipgrepBm25Adapter.prototype.query;
    let calls = 0;
    const querySpy = spyOn(RipgrepBm25Adapter.prototype, 'query').mockImplementation(async function (this: RipgrepBm25Adapter, query, state) {
      if (calls++ === 0) throw new Error('injected query failure');
      return originalQuery.call(this, query, state);
    });
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await multiAdapterMain(['--adapter', 'grep-only', '--queries', 'relational', '--json', '--receipt-path', receiptFile]);
      expect(code).toBe(1);
      const receipt = loadReceipt(receiptFile);
      expect(receipt.run_status).toBe('error');
      expect(receipt.verdict).toBeUndefined();
      expect(receipt.publishable).toBe(false);
      expect(receipt.n_scored).toBe(receipt.n_total);
      expect(receipt.errors).toHaveLength(1);
      expect(receipt.errors[0].message).toContain('injected query failure');
      const runs = (receipt.data!.runs_by_adapter as Record<string, Array<{ perQuery: Array<{ error?: string; ranked: unknown[] }> }>>)['grep-only'];
      expect(runs).toHaveLength(1);
      expect(runs[0].perQuery).toHaveLength(receipt.n_total);
      expect(runs[0].perQuery[0].error).toContain('injected query failure');
      expect(runs[0].perQuery.slice(1).some(row => row.ranked.length > 0)).toBe(true);

      // A subsequent complete run replaces the failed receipt and retains its verdict.
      querySpy.mockRestore();
      expect(await multiAdapterMain(['--adapter', 'grep-only', '--queries', 'relational', '--json', '--receipt-path', receiptFile])).toBe(0);
      const completed = loadReceipt(receiptFile);
      expect(completed.run_status).toBe('completed');
      expect(completed.verdict).toBe('pass');
      expect(completed.errors).toEqual([]);
    } finally {
      querySpy.mockRestore();
      logSpy.mockRestore();
      if (savedRuns === undefined) delete process.env.BRAINBENCH_N;
      else process.env.BRAINBENCH_N = savedRuns;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('Precision retains its report and search observations when execution is incomplete', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'precision-failure-receipt-'));
    const receiptFile = join(directory, 'receipt.json');
    const querySpy = spyOn(PGLiteEngine.prototype, 'searchKeyword').mockRejectedValue(new Error('injected database outage'));
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Keyword mode seeds without embeddings and never opens a provider.
      const code = await precisionMain(['--mode', 'gbrain-keyword', '--limit', '1', '--report-dir', directory, '--receipt-path', receiptFile]);
      expect(code).toBe(3);
      const receipt = loadReceipt(receiptFile);
      expect(receipt.run_status).toBe('error');
      expect(receipt.verdict).toBeUndefined();
      expect(receipt.publishable).toBe(false);
      expect(receipt.resolved_config!.execution_incomplete).toBe(true);
      expect(receipt.errors.some(error => error.origin === 'harness')).toBe(false);
      expect(receipt.data!.search_failed_queries).toBe(1);
      const report = JSON.parse(readFileSync(receipt.data!.report_path as string, 'utf8'));
      expect(report.search_observations[0].failures).toEqual(['search_threw']);
      expect(report.search_observations[0].error).toContain('injected database outage');
      expect(report.search_observations[0].case_id).toBeDefined();

      querySpy.mockRestore();
      expect(await precisionMain(['--mode', 'gbrain-keyword', '--limit', '1', '--report-dir', directory, '--receipt-path', receiptFile])).toBe(0);
      const completed = loadReceipt(receiptFile);
      expect(completed.run_status).toBe('completed');
      expect(completed.verdict).toBe('partial');
      expect(completed.errors).toEqual([]);
      expect(completed.data!.search_failed_queries).toBe(0);
    } finally {
      querySpy.mockRestore();
      logSpy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
