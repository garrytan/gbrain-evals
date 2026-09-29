/**
 * The paid runners wired to the budget ledger refuse to start without an
 * authorized budget, before any provider request (plan item 11).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom } from '../../eval/runner/budget-ledger.ts';
import { parseCat13Argv, runCat13 } from '../../eval/runner/cat13-conceptual.ts';

async function withoutNetwork<T>(fn: () => Promise<T>): Promise<{ result: T; requests: number }> {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.OPENAI_API_KEY;
  let requests = 0;
  process.env.OPENAI_API_KEY = 'dummy-never-sent';
  globalThis.fetch = (async () => { requests++; throw new Error('network forbidden'); }) as unknown as typeof fetch;
  try { return { result: await fn(), requests }; }
  finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
  }
}

describe('Cat13 budget', () => {
  test('budget flags parse; unknown flags still fail', () => {
    const opts = parseCat13Argv(['--budget-usd', '4', '--budget-ledger', '/tmp/x.json', '--program-cap-usd=100'], {});
    expect(opts.budget).toMatchObject({ budgetUsd: 4, ledgerPath: '/tmp/x.json', programCapUsd: 100 });
    expect(() => parseCat13Argv(['--budget'], {})).toThrow('unknown argument');
  });

  test('live embeds without --budget-usd are refused before any request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat13-budget-'));
    const { result, requests } = await withoutNetwork(() => runCat13({ only: 'grep-only', targetProbes: 30, reportsDir: dir, quiet: true,
      budget: budgetOptionsFrom(['--budget-ledger', join(dir, 'ledger.json')], {}) }));
    expect(requests).toBe(0);
    expect(result.receipt.run_status).toBe('skipped');
    expect(result.receipt.skip_reason).toContain('--budget-usd');
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(dir, 'ledger.json'))).toBe(false);
  });

  test('a budget below the registry estimate is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat13-budget-'));
    const { result, requests } = await withoutNetwork(() => runCat13({ only: 'grep-only', targetProbes: 30, reportsDir: dir, quiet: true,
      budget: budgetOptionsFrom(['--budget-usd', '1', '--budget-ledger', join(dir, 'ledger.json')], {}) }));
    expect(requests).toBe(0);
    expect(result.receipt.skip_reason).toContain('estimated cost $3.00 exceeds --budget-usd $1.00');
  });
});

describe('Cat35 budget', () => {
  test('a full run without --budget-usd writes a refusal receipt and exits non-zero, before any request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat35-budget-'));
    const root = resolve(import.meta.dir, '../..');
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: dir, ANTHROPIC_API_KEY: 'dummy-never-sent', OPENAI_API_KEY: 'dummy-never-sent',
      BRAINBENCH_BUDGET_LEDGER: join(dir, 'ledger.json'), HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' };
    const proc = Bun.spawnSync(['bun', '--no-env-file', join(root, 'eval/runner/cat35-transcript-distill.ts'), '--lanes', 'facts', '--limit', '1'],
      { cwd: root, env, stderr: 'pipe', stdout: 'pipe', timeout: 60_000 });
    const stderr = proc.stderr.toString();
    expect(proc.exitCode).toBe(1);
    expect(stderr).toContain('[budget] cat35-transcript-distill: estimated cost $');
    expect(stderr).toContain('--budget-usd');
    const receipt = JSON.parse(readFileSync(join(root, 'eval/reports/cat35-transcript-distill/receipt.json'), 'utf8'));
    expect(receipt.run_status).toBe('skipped');
    expect(receipt.skip_reason).toContain('budget:');
    expect(existsSync(join(dir, 'ledger.json'))).toBe(false);
  }, 60_000);
});
