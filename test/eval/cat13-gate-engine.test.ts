/**
 * Cat 13 and Cat 13b as gbrain RUST_ENGINE.md E1 gate suites: the build and engine switches parse, and an engine run
 * writes its receipt to the per-engine directory with the engine and build recorded; Cat 13b's live path goes through
 * the budget ledger and the shared embed cache. Keyless: stub embeds or a stub behind the cache, no network. Postgres
 * and Rust join the cache test when LIFECYCLE_PG_URL, or GBRAIN_RUST_ENGINE_ADDON with GBRAIN_UNDER_TEST, are set.
 */

import { afterAll, describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseCat13Argv } from '../../eval/runner/cat13-conceptual.ts';
import { hashEmbed, runCat13b } from '../../eval/runner/cat13b-source-swamp.ts';
import { budgetOptionsFrom, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { gateRunnerContext } from '../../eval/runner/eval-engine.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { loadReceipt, type Receipt } from '../../eval/runner/receipt.ts';

describe('cat13 --gbrain', () => {
  test('the flag names the build, GBRAIN_UNDER_TEST fills it, and the flag wins', () => {
    expect(parseCat13Argv(['--gbrain', '/src/gbrain@abc123'], {}).gbrain).toBe('/src/gbrain@abc123');
    expect(parseCat13Argv(['--gbrain=/src/gbrain'], {}).gbrain).toBe('/src/gbrain');
    expect(parseCat13Argv([], { GBRAIN_UNDER_TEST: '/env/gbrain@def' }).gbrain).toBe('/env/gbrain@def');
    expect(parseCat13Argv(['--gbrain', '/flag'], { GBRAIN_UNDER_TEST: '/env' }).gbrain).toBe('/flag');
    expect(parseCat13Argv([], {}).gbrain).toBeUndefined();
    expect(() => parseCat13Argv(['--gbrain'], {})).toThrow(/requires a value/);
  });
});

describe('cat13b engine run', () => {
  test('GBRAIN_EVAL_ENGINE=pglite writes an engine-pglite receipt naming the engine and build', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat13b-engine-'));
    const gut = resolveGbrainUnderTest(null);
    const { receipt, results } = await runCat13b({ stubEmbed: true, only: 'gbrain', reportsDir, quiet: true, gate: { gut, kind: 'pglite', requested: 'pglite' } });
    expect(receipt.run_status).toBe('completed');
    expect(results.map(r => r.name)).toEqual(['gbrain']);
    expect(existsSync(join(reportsDir, 'cat13b-source-swamp', 'receipt.json'))).toBe(false);
    expect(existsSync(join(reportsDir, 'cat13b-source-swamp', 'engine-pglite', 'report.json'))).toBe(true);
    const onDisk = loadReceipt(join(reportsDir, 'cat13b-source-swamp', 'engine-pglite', 'receipt.json')) as unknown as Record<string, unknown>;
    expect(onDisk.engine).toBe('pglite');
    expect(onDisk.not_applicable).toEqual([]);
    const build = onDisk.gbrain_under_test as { version: string; rust_addon: unknown };
    expect(build.version).toBe(gut.version);
    expect(build.rust_addon).toBeNull();
    expect((receipt.resolved_config as Record<string, unknown>).engine_applies_to).toEqual(['gbrain', 'gbrain-no-source-boost']);
  }, 300_000);
});

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

function countingStub() {
  const calls = { n: 0 };
  const embedMany = async (p: { values: string[] }) => { calls.n++; return { embeddings: p.values.map(v => hashEmbed(v)), usage: { tokens: 0 } }; };
  return { calls, embedMany };
}

type CacheStats = { hits: number; misses: number; inserts: number };
const cacheOf = (receipt: Receipt) => (receipt.resolved_config as { embed_cache?: { cache_only: boolean; stats: CacheStats } }).embed_cache!;

/** Engines this machine can open besides the first run's PGLite: Postgres with LIFECYCLE_PG_URL, Rust with an addon and a --gbrain build. */
const otherEngines = (['postgres', 'rust'] as const).filter(k => k === 'postgres' ? !!process.env.LIFECYCLE_PG_URL : !!(process.env.GBRAIN_RUST_ENGINE_ADDON && process.env.GBRAIN_UNDER_TEST));
const gateFor = (kind: 'pglite' | 'postgres' | 'rust') => gateRunnerContext([], { ...process.env, GBRAIN_EVAL_ENGINE: kind });

/** A fresh ledger with a $5 program cap and a $1 run budget; no request in these tests is paid. */
function testBudget(dir: string) {
  const ledger = join(dir, 'ledger.sqlite');
  initLedger({ ledgerPath: ledger, programCapUsd: 5, reason: 'cat13b keyless test' });
  return budgetOptionsFrom(['--budget-usd', '1', '--budget-ledger', ledger], {});
}

describe('cat13b paid path: budget ledger and embed cache', () => {
  afterAll(() => closeLedgers());

  test('live embeds without --budget-usd are refused before any request, with or without the cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat13b-budget-'));
    const stub = countingStub();
    const { result, requests } = await withoutNetwork(() => runCat13b({ stubEmbed: false, only: 'gbrain', reportsDir: dir, quiet: true,
      embedCache: join(dir, 'cache.sqlite'), embedMany: stub.embedMany, budget: budgetOptionsFrom(['--budget-ledger', join(dir, 'ledger.json')], {}) }));
    expect(requests).toBe(0);
    expect(stub.calls.n).toBe(0);
    expect(result.receipt.run_status).toBe('skipped');
    expect(result.receipt.skip_reason).toContain('--budget-usd');
    expect(result.exitCode).toBe(2);
    expect(existsSync(join(dir, 'ledger.sqlite'))).toBe(false);
  }, 60_000);

  test('--embed-cache refuses the stub, and --embed-cache-only needs a cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat13b-cache-'));
    await expect(runCat13b({ stubEmbed: true, embedCache: join(dir, 'c.sqlite'), reportsDir: dir, quiet: true })).rejects.toThrow(/does not apply to --stub-embed/);
    await expect(runCat13b({ stubEmbed: true, embedCacheOnly: true, reportsDir: dir, quiet: true })).rejects.toThrow(/needs --embed-cache/);
  });

  test('a first run fills the cache through the ledger; a cache-only run on another engine reads it with zero misses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat13b-cache-'));
    const cache = join(dir, 'cache.sqlite');
    const budget = testBudget(dir);
    const fill = countingStub();
    const first = await withoutNetwork(() => runCat13b({ stubEmbed: false, only: 'gbrain', reportsDir: join(dir, 'fill'), quiet: true,
      gate: gateFor('pglite'), embedCache: cache, embedMany: fill.embedMany, budget }));
    expect(first.requests).toBe(0);
    expect(first.result.receipt.run_status).toBe('completed');
    expect(fill.calls.n).toBeGreaterThan(0);
    expect(cacheOf(first.result.receipt).stats.inserts).toBeGreaterThan(0);
    expect(first.result.receipt.cost?.usd).toBe(0);

    for (const kind of otherEngines.length ? otherEngines : ['pglite' as const]) {
      const reread = countingStub();
      const second = await withoutNetwork(() => runCat13b({ stubEmbed: false, only: 'gbrain', reportsDir: join(dir, kind), quiet: true,
        gate: gateFor(kind), embedCache: cache, embedCacheOnly: true, embedMany: reread.embedMany, budget }));
      expect(second.requests).toBe(0);
      expect(reread.calls.n).toBe(0);
      expect(second.result.receipt.run_status).toBe('completed');
      const used = cacheOf(second.result.receipt);
      expect(used.cache_only).toBe(true);
      expect(used.stats.misses).toBe(0);
      expect(used.stats.hits).toBeGreaterThan(0);
      expect(second.result.receipt.cost?.usd).toBe(0);
    }
  }, 600_000);

  test('--embed-cache-only on an empty cache fails the run instead of calling the provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat13b-cache-'));
    const stub = countingStub();
    const { result, requests } = await withoutNetwork(() => runCat13b({ stubEmbed: false, only: 'gbrain', reportsDir: dir, quiet: true,
      embedCache: join(dir, 'empty.sqlite'), embedCacheOnly: true, embedMany: stub.embedMany,
      budget: testBudget(dir) }));
    expect(requests).toBe(0);
    expect(stub.calls.n).toBe(0);
    expect(result.receipt.run_status).toBe('error');
    expect(result.exitCode).toBe(3);
    expect(cacheOf(result.receipt).stats.misses).toBeGreaterThan(0);
  }, 300_000);
});
