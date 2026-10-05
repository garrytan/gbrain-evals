/**
 * all.ts + llm-budget.ts tests.
 *
 * Covers:
 *   - CATEGORIES lists every category in the repository, each with a tier
 *     and either a dispatchable script or a stated reason (C-09)
 *   - offline and paid tiers partition the dispatched categories, and every
 *     category not run is reported with a reason
 *   - runConcurrently respects the concurrency cap
 *   - runSchedule never overlaps an exclusive latency category with any
 *     other category (C-11)
 *   - LlmBudget semaphore behavior
 *   - buildReport renders all three statuses and the not-run list
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import {
  CATEGORIES,
  parseTier,
  printNotRun,
  runConcurrently,
  runSchedule,
  selectCategories,
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
  test('lists every category in the repository (drift tripwire, audit tests-audit-01 and C-09)', () => {
    expect(CATEGORIES.map(c => c.id)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '13b', '13b-sit', '14', '15', '18', '18b',
      '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30-33', '34', '35', '36', '36-live', 'N3', 'temporal-edges', 'P1-E2', 'P1-E3', 'P5-H1', 'P5-H2', 'P5-H4', 'P5-H5a', 'P8-quotes', 'P8-write-cost', 'N4', 'N6', 'N12', 'N13', 'N7', 'N8', 'N2', 'A4', 'SO', 'SO-live',
      'multi-adapter', 'relational-ab', 'constrained-relational', 'N9', 'N9-paid', 'precisionmembench', 'longmemeval', 'longmemeval-answers',
      'longmemeval-m-pilot', 'reading-notes', 'lifecycle', '40', '41', 'N1', 'N5', 'N1-ci', 'N5-ci', 'evidence-delivery', 'sealed-confirmation', 'situation-recall', 'shootout', 'qrels',
    ]);
  });

  test('every category runner script in eval/runner is listed', () => {
    const referenced = new Set(CATEGORIES.flatMap(c => c.kind === 'dispatched' ? [c.script] : (c.command?.match(/eval\/runner\/[\w.-]+\.ts/g) ?? [])));
    const helpers = new Set([
      'cat13-gap-localize.ts', 'cat13-kacf-calibrate.ts', 'cat35-checks.ts', 'cat35-judges.ts', 'cat35-transcript-distill-chart.ts',
      'cat36-corpus.ts', 'cat36-scorer.ts', 'cat36-production.ts', 'cat36-snapshot.ts', 'cat36-grounded-answers.ts', 'cat36-operation-conformance.ts',
      // Listed without a command: not implemented (5, 8, 9) or run by run-skillopt-cats.sh (30-33).
      'cat5-provenance.ts', 'cat8-skill-compliance.ts', 'cat9-workflows.ts',
      'cat30-skillopt-improvement.ts', 'cat31-skillopt-ablation.ts', 'cat32-skillopt-reward-hacking.ts', 'cat33-skillopt-transfer.ts',
    ]);
    const runners = readdirSync('eval/runner').filter(f => /^cat\d+b?-.*\.ts$/.test(f) && !helpers.has(f)).sort();
    expect(runners.length).toBeGreaterThan(20);
    for (const f of runners) expect([f, referenced.has(`eval/runner/${f}`)]).toEqual([f, true]);
  });

  test('dispatched entries point at real scripts; listed entries give a reason', () => {
    for (const c of CATEGORIES) {
      expect(c.name.length).toBeGreaterThan(0);
      if (c.kind === 'dispatched') {
        expect(c.script).toMatch(/^eval\/runner\/.*\.ts$/);
        expect(existsSync(c.script)).toBe(true);
      } else {
        expect(c.reason.length).toBeGreaterThan(20);
        const script = c.command?.match(/(eval\/runner|scripts)\/[\w.-]+/)?.[0];
        if (script) expect(existsSync(script)).toBe(true);
      }
    }
  });

  test('Cat36 explicitly runs bounded offline smoke with a fresh receipt path', () => {
    const cat = CATEGORIES.find(c => c.id === '36');
    if (!cat || cat.kind !== 'dispatched') throw new Error('Cat36 registration missing');
    expect(cat.tier).toBe('offline');
    expect(cat.args).toEqual(['--offline', '--smoke']);
    expect(cat.outputFlag).toBe('--output');
    expect(cat.timeoutMs).toBe(180_000);
    expect(cat.name).toContain('plumbing');
  });

  test('perf and sync-latency runners are exclusive (C-11)', () => {
    const exclusive = CATEGORIES.filter(c => c.kind === 'dispatched' && c.exclusive).map(c => c.id);
    expect(exclusive).toEqual(['7', '28']);
  });

  test('Cat 35 runs only in the paid tier, in full mode', () => {
    const cat = CATEGORIES.find(c => c.id === '35');
    if (!cat || cat.kind !== 'dispatched') throw new Error('Cat35 registration missing');
    expect(cat.tier).toBe('paid');
    expect(cat.env).toEqual({ CAT35_FULL: '1' });
  });
});

describe('tiers', () => {
  test('default tier is offline; bad values are rejected', () => {
    expect(parseTier([])).toBe('offline');
    expect(parseTier(['--tier', 'paid'])).toBe('paid');
    expect(parseTier(['--tier', 'all'])).toBe('all');
    expect(() => parseTier(['--tier', 'published'])).toThrow('--tier');
  });

  test('offline and paid partition the dispatched categories; every other category is reported as not run', () => {
    const offline = selectCategories('offline');
    const paid = selectCategories('paid');
    const all = selectCategories('all');
    expect(offline.dispatch.every(c => c.tier === 'offline')).toBe(true);
    expect(paid.dispatch.every(c => c.tier === 'paid')).toBe(true);
    expect(offline.dispatch.length + paid.dispatch.length).toBe(all.dispatch.length);
    for (const sel of [offline, paid, all]) {
      expect(sel.dispatch.length + sel.notRun.length).toBe(CATEGORIES.length);
      expect(sel.notRun.every(n => n.reason.length > 0)).toBe(true);
    }
    expect(offline.notRun.find(n => n.id === '13')?.reason).toBe('tier P not selected');
    expect(paid.notRun.find(n => n.id === '2')?.reason).toBe('tier H not selected');
    expect(offline.dispatch.map(c => c.id)).toEqual(['1', '2', '3', '4', '6', '7', '10', '11', '12', '19', '22', '23', '24', '27', '28', '34', '36', 'N3', 'temporal-edges', 'N4', 'N6', 'N12', 'N13', 'N7', 'N8', 'N2', 'A4', 'SO', 'N9', 'N1-ci', 'N5-ci']);
  });

  test('the not-run list is printed with every category and its reason', () => {
    const lines: string[] = [];
    const { notRun } = selectCategories('offline');
    printNotRun(notRun, l => lines.push(l));
    expect(lines[0]).toBe(`Not run in this invocation (${notRun.length}):`);
    expect(lines).toHaveLength(notRun.length + 1);
    expect(lines.some(l => l.includes('Cat 5') && l.includes('not implemented'))).toBe(true);
    expect(lines.some(l => l.includes('Cat 18b') && l.includes('tier P not selected'))).toBe(true);
  });

  test('package.json has no fake N=10 published script (C-08)', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    expect(scripts['eval:brainbench:published']).toBeUndefined();
    for (const cmd of Object.values(scripts)) {
      if (cmd.includes('all.ts')) expect(cmd).not.toContain('BRAINBENCH_N');
    }
    expect(scripts['eval:brainbench']).toBe('bun eval/runner/all.ts --tier offline');
    expect(scripts['eval:brainbench:paid']).toBe('bun eval/runner/all.ts --tier paid');
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

describe('runSchedule (C-11)', () => {
  test('an exclusive item never runs while another item is in flight', async () => {
    let inFlight = 0;
    const overlaps: string[] = [];
    const items = [
      { id: 'a' }, { id: 'perf', exclusive: true }, { id: 'b' }, { id: 'c' }, { id: 'lat', exclusive: true }, { id: 'd' },
    ];
    const out = await runSchedule(items, 3, async item => {
      inFlight++;
      if (item.exclusive && inFlight > 1) overlaps.push(item.id);
      await new Promise(r => setTimeout(r, 5));
      if (item.exclusive && inFlight > 1) overlaps.push(item.id);
      inFlight--;
      return item.id;
    });
    expect(overlaps).toEqual([]);
    expect(out).toEqual(['a', 'perf', 'b', 'c', 'lat', 'd']);
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
  const run = (over: Partial<CategoryRun>): CategoryRun => ({
    id: '1', name: 'x', tier: 'offline', script: 'a.ts', status: 'pass', statusSource: 'receipt', output: '', exitCode: 0, elapsedMs: 0, ...over,
  });

  test('renders pass, fail and skipped distinctly (C-18) and lists categories not run', () => {
    const report = buildReport('offline', [
      run({ id: '1', status: 'pass' }),
      run({ id: '2', status: 'fail', statusSource: 'no-receipt', statusNote: 'no receipt written by this run' }),
      run({ id: '3', status: 'skipped', statusNote: 'fixtures missing' }),
    ], [{ id: '13', name: 'Conceptual', tier: 'paid', reason: 'tier paid not selected', command: 'bun eval/runner/cat13-conceptual.ts' }]);
    expect(report).toContain('# BrainBench');
    expect(report).toContain('**Tier:** offline');
    expect(report).toContain('1 passed, 1 failed, 1 skipped');
    expect(report).toContain('**Status:** ⤼ SKIPPED');
    expect(report).toContain('**Status:** ✗ FAIL');
    expect(report).toContain('**Status:** ✓ PASS');
    expect(report).toContain('## Not run in this invocation');
    expect(report).toContain('| 13 | Conceptual | paid | tier paid not selected |');
    expect(report).toContain('read only by multi-adapter.ts');
    expect(report).not.toContain('~$200');
  });

  test('strips migration noise from subprocess output', () => {
    const report = buildReport('offline', [run({ output: 'Migration 5 applied: foo\n12 migration(s) applied\nreal output line' })], []);
    expect(report).not.toContain('Migration 5 applied');
    expect(report).not.toContain('12 migration(s) applied');
    expect(report).toContain('real output line');
  });
});
