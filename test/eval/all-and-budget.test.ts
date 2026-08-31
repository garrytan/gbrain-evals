/**
 * all.ts + llm-budget.ts tests — Day 10 of BrainBench v1 Complete.
 *
 * Covers:
 *   - CATEGORIES has every expected Cat number (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)
 *   - Subprocess vs programmatic classification matches the plan:
 *       subprocess: 1, 2, 3, 4, 6, 7, 10, 11, 12 (9 Cats)
 *       programmatic: 5, 8, 9 (3 Cats)
 *   - runConcurrently respects the concurrency cap (observable via peak in-flight count)
 *   - LlmBudget.acquireSlot blocks when at capacity, releases in order
 *   - LlmBudget.withLlmSlot always releases on success AND on throw
 *   - LlmBudget respects BRAINBENCH_LLM_CONCURRENCY env var
 *   - buildReport includes every Cat + programmatic-only section
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  CATEGORIES,
  runConcurrently,
  buildReport,
  type CategoryRun,
} from '../../eval/runner/all.ts';
import {
  LlmBudget,
  getDefaultLlmBudget,
  resetDefaultLlmBudget,
} from '../../eval/runner/llm-budget.ts';

// ─── CATEGORIES catalog shape ────────────────────────────────────────

describe('CATEGORIES catalog', () => {
  test('includes every expected Cat number in ascending order', () => {
    const nums = CATEGORIES.map(c => c.num);
    // Cat 34 (BrainBench memory conformance) joined the catalog in #16 —
    // this list is the drift tripwire, keep it exact (audit tests-audit-01).
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 34]);
  });

  test('subprocess Cats: 1, 2, 3, 4, 6, 7, 10, 11, 12, 34 (10 total)', () => {
    const subprocessNums = CATEGORIES.filter(c => c.kind === 'subprocess').map(c => c.num);
    expect(subprocessNums.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 7, 10, 11, 12, 34]);
  });

  test('programmatic Cats: 5, 8, 9 (3 total)', () => {
    const progNums = CATEGORIES.filter(c => c.kind === 'programmatic').map(c => c.num);
    expect(progNums.sort((a, b) => a - b)).toEqual([5, 8, 9]);
  });

  test('every subprocess Cat has a script + name', () => {
    for (const c of CATEGORIES) {
      if (c.kind === 'subprocess') {
        expect(c.script).toMatch(/^eval\/runner\/.*\.ts$/);
        expect(c.name.length).toBeGreaterThan(0);
      }
    }
  });

  test('every programmatic Cat has a non-empty reason', () => {
    for (const c of CATEGORIES) {
      if (c.kind === 'programmatic') {
        expect(c.reason.length).toBeGreaterThan(20);
      }
    }
  });
});

// ─── runConcurrently concurrency enforcement ─────────────────────────

describe('runConcurrently', () => {
  test('respects the concurrency cap (peak in-flight never exceeds)', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await runConcurrently(items, 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight--;
      return null;
    });
    expect(peak).toBe(3);
  });

  test('preserves input order in output (not completion order)', async () => {
    const items = [0, 1, 2, 3, 4];
    const results = await runConcurrently(items, 2, async n => {
      // Reverse delay: later items finish sooner
      await new Promise(r => setTimeout(r, (5 - n) * 5));
      return n * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40]);
  });

  test('handles empty input gracefully', async () => {
    const results = await runConcurrently<number, number>([], 4, async n => n);
    expect(results).toEqual([]);
  });

  test('concurrency=1 runs strictly sequentially', async () => {
    const order: number[] = [];
    await runConcurrently([0, 1, 2], 1, async n => {
      order.push(n);
      await new Promise(r => setTimeout(r, 5));
      return null;
    });
    expect(order).toEqual([0, 1, 2]);
  });
});

// ─── LlmBudget semaphore ─────────────────────────────────────────────

describe('LlmBudget', () => {
  afterEach(() => resetDefaultLlmBudget());

  test('respects maxConcurrent cap', async () => {
    const budget = new LlmBudget({ maxConcurrent: 2 });
    let active = 0;
    let peakActive = 0;
    const task = async () => {
      await budget.acquireSlot();
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      budget.releaseSlot();
    };
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peakActive).toBe(2);
  });

  test('exposes capacity, activeCount, waitingCount', () => {
    const budget = new LlmBudget({ maxConcurrent: 2 });
    expect(budget.capacity).toBe(2);
    expect(budget.activeCount).toBe(0);
    expect(budget.waitingCount).toBe(0);
  });

  test('activeCount and waitingCount track correctly under contention', async () => {
    const budget = new LlmBudget({ maxConcurrent: 1 });
    await budget.acquireSlot();
    expect(budget.activeCount).toBe(1);

    const waiter = budget.acquireSlot();
    // microtask flush
    await Promise.resolve();
    expect(budget.waitingCount).toBe(1);

    budget.releaseSlot();
    await waiter;
    expect(budget.activeCount).toBe(1);
    expect(budget.waitingCount).toBe(0);

    budget.releaseSlot();
  });

  test('withLlmSlot releases on success', async () => {
    const budget = new LlmBudget({ maxConcurrent: 1 });
    await budget.withLlmSlot(async () => 'done');
    expect(budget.activeCount).toBe(0);
  });

  test('withLlmSlot releases on throw', async () => {
    const budget = new LlmBudget({ maxConcurrent: 1 });
    let caught: unknown = null;
    try {
      await budget.withLlmSlot(async () => {
        throw new Error('boom');
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(budget.activeCount).toBe(0);
  });

  test('withLlmSlot returns the function result', async () => {
    const budget = new LlmBudget({ maxConcurrent: 2 });
    const result = await budget.withLlmSlot(async () => 42);
    expect(result).toBe(42);
  });

  test('enforces capacity ≥ 1 (rejects zero/negative)', () => {
    expect(new LlmBudget({ maxConcurrent: 0 }).capacity).toBe(1);
    expect(new LlmBudget({ maxConcurrent: -5 }).capacity).toBe(1);
  });

  test('default capacity is 4', () => {
    const budget = new LlmBudget();
    expect(budget.capacity).toBe(4);
  });

  test('double-release is a no-op (guard against bugs)', () => {
    const budget = new LlmBudget({ maxConcurrent: 1 });
    budget.releaseSlot(); // no prior acquire
    expect(budget.activeCount).toBe(0);
  });
});

describe('getDefaultLlmBudget', () => {
  afterEach(() => resetDefaultLlmBudget());

  test('returns a singleton across calls', () => {
    resetDefaultLlmBudget();
    const a = getDefaultLlmBudget();
    const b = getDefaultLlmBudget();
    expect(a).toBe(b);
  });

  test('honors BRAINBENCH_LLM_CONCURRENCY env var', () => {
    resetDefaultLlmBudget();
    const original = process.env.BRAINBENCH_LLM_CONCURRENCY;
    process.env.BRAINBENCH_LLM_CONCURRENCY = '8';
    try {
      const budget = getDefaultLlmBudget();
      expect(budget.capacity).toBe(8);
    } finally {
      if (original !== undefined) process.env.BRAINBENCH_LLM_CONCURRENCY = original;
      else delete process.env.BRAINBENCH_LLM_CONCURRENCY;
      resetDefaultLlmBudget();
    }
  });

  test('falls back to 4 on invalid env var', () => {
    resetDefaultLlmBudget();
    const original = process.env.BRAINBENCH_LLM_CONCURRENCY;
    process.env.BRAINBENCH_LLM_CONCURRENCY = 'garbage';
    try {
      const budget = getDefaultLlmBudget();
      // parseInt('garbage') → NaN → fallback to 4
      expect(budget.capacity).toBe(4);
    } finally {
      if (original !== undefined) process.env.BRAINBENCH_LLM_CONCURRENCY = original;
      else delete process.env.BRAINBENCH_LLM_CONCURRENCY;
      resetDefaultLlmBudget();
    }
  });
});

// ─── buildReport ──────────────────────────────────────────────────────

describe('buildReport', () => {
  test('includes every Cat + programmatic-only section', async () => {
    const runs: CategoryRun[] = [
      { num: 1, name: 'Cat 1', kind: 'subprocess', script: 'a.ts', status: 'pass', statusSource: 'exit-code', output: 'output1', exitCode: 0, elapsedMs: 1500 },
      { num: 5, name: 'Cat 5', kind: 'programmatic', status: 'programmatic', statusSource: 'n/a', output: 'Run via harness.', exitCode: 0, elapsedMs: 0 },
      { num: 6, name: 'Cat 6', kind: 'subprocess', script: 'cat6.ts', status: 'pass', statusSource: 'exit-code', output: 'output6', exitCode: 0, elapsedMs: 800 },
    ];
    const report = await buildReport(runs);
    expect(report).toContain('# BrainBench');
    expect(report).toContain('Cat 1');
    expect(report).toContain('Cat 5');
    expect(report).toContain('Cat 6');
    expect(report).toContain('Programmatic-only Cats');
    expect(report).toContain('Run via harness');
  });

  test('summary correctly counts passed/failed/programmatic', async () => {
    const runs: CategoryRun[] = [
      { num: 1, name: 'x', kind: 'subprocess', script: 'a.ts', status: 'pass', statusSource: 'exit-code', output: '', exitCode: 0, elapsedMs: 0 },
      { num: 2, name: 'x', kind: 'subprocess', script: 'a.ts', status: 'fail', statusSource: 'exit-code', output: '', exitCode: 1, elapsedMs: 0 },
      { num: 5, name: 'x', kind: 'programmatic', status: 'programmatic', statusSource: 'n/a', output: 'r', exitCode: 0, elapsedMs: 0 },
    ];
    const report = await buildReport(runs);
    expect(report).toContain('2 subprocess Cats ran. 1 passed, 1 failed, 0 SKIPPED');
  });

  test('strips migration noise from subprocess output', async () => {
    const runs: CategoryRun[] = [
      {
        num: 1,
        name: 'x',
        kind: 'subprocess',
        script: 'a.ts',
        status: 'pass',
        statusSource: 'exit-code',
        output: 'Migration 5 applied: foo\n12 migration(s) applied\nreal output line',
        exitCode: 0,
        elapsedMs: 0,
      },
    ];
    const report = await buildReport(runs);
    expect(report).not.toContain('Migration 5 applied');
    expect(report).not.toContain('12 migration(s) applied');
    expect(report).toContain('real output line');
  });
});
