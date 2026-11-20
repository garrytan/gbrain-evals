/**
 * Cat 13 warm passes: a degraded repeat search never counts in warm latency.
 *
 * A warm pass (--warm-passes N) repeats every probe on the same brain to time
 * a warm cache. If gbrain answered one of those repeats on a fallback path
 * (vector arm off, reranker skipped, search threw), its latency describes a
 * different search path and must not sit inside warm p50/p95. These tests pin:
 *   1. a degraded warm search is flagged with its reason and left out of
 *      warm query_ms; `warm_excluded_degraded` counts it;
 *   2. a clean run flags nothing and excludes 0;
 *   3. the count is exact across passes, reasons and thrown searches;
 *   4. the scored (cold) pass gets the same per-search flag, and its latency
 *      rules do not change;
 *   5. the real gbrain adapter on PGLite reports the flag from gbrain's own
 *      search meta (hermetic: stub embeddings, injected vector outage).
 *
 * No keys, no network: fake adapters, or the gbrain adapter on the stub
 * embed transport.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import { __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { scoreAdapter, runCat13, ensureGateway, type Probe } from '../../eval/runner/cat13-conceptual.ts';
import { GbrainInlineAdapter } from '../../eval/runner/adapters/gbrain-inline.ts';
import { retrievalPins, type SearchObservation } from '../../eval/runner/retrieval-pins.ts';
import { ProbeAccounting } from '../../eval/runner/probe-accounting.ts';
import type { Adapter, Page, Query, RankedDoc } from '../../eval/runner/types.ts';

function fakeProbe(id: string, text: string, target: string): Probe {
  const q: Query = { id, tier: 'fuzzy', text, expected_output_type: 'cited-source-pages', gold: { grades: { [target]: 3 }, relevant: [target] } };
  return { q, targetSlugs: [target], template: 'test' };
}

function probesAndGold(): { probes: Probe[]; gradesByQuery: Map<string, Map<string, number>> } {
  return {
    probes: [fakeProbe('p1', 'query one', 'concepts/a'), fakeProbe('p2', 'query two', 'concepts/b')],
    gradesByQuery: new Map([['p1', new Map([['concepts/a', 3]])], ['p2', new Map([['concepts/b', 3]])]]),
  };
}

/** What one call of the fake does: answer clean, answer on a fallback path, throw, or skip its observation. */
type Plan = { failures?: string[]; throws?: boolean; sleepMs?: number; noObservation?: boolean };

/**
 * Records one SearchObservation per call the way GbrainInlineAdapter does
 * (failures empty on a clean search). `plans` is keyed by the 0-based call
 * index across the whole run: calls 0..probes-1 are the scored pass.
 */
class ObservingAdapter implements Adapter {
  readonly name = 'observing';
  calls = 0;
  constructor(private plans: Record<number, Plan> = {}) {}
  async init(): Promise<unknown> { return { observed: { queries: 0, rerank_scored_queries: 0 } }; }
  async query(q: Query, state: unknown): Promise<RankedDoc[]> {
    const plan = this.plans[this.calls++] ?? {};
    if (plan.sleepMs) await Bun.sleep(plan.sleepMs);
    const observed = (state as { observed: { queries: number; search_observations?: SearchObservation[] } }).observed;
    if (!plan.noObservation) {
      observed.queries += 1;
      (observed.search_observations ??= []).push({
        query_id: q.id, query: q.text, mode: 'hybrid', result_count: 1, rerank_scored: false, ranked_results: [],
        search_meta: null, relational_meta: null,
        failures: plan.throws ? ['search_threw'] : plan.failures ?? [],
      });
    }
    if (plan.throws) throw new Error('injected search failure');
    return [{ page_id: q.id === 'p1' ? 'concepts/a' : 'concepts/b', score: 1, rank: 1 }];
  }
  observedStats(state: unknown) { return { ...(state as { observed: object }).observed }; }
}

describe('cat13 warm passes leave degraded searches out of warm latency', () => {
  test('a degraded warm search is flagged with its reason and left out of warm p50/p95', async () => {
    const { probes, gradesByQuery } = probesAndGold();
    // Call 2 is the first warm search (probe p1, warm pass 0): a slow keyword-only fallback.
    const adapter = new ObservingAdapter({ 2: { failures: ['vector_not_enabled'], sleepMs: 60 } });
    const r = await scoreAdapter(adapter, [], probes, gradesByQuery, new ProbeAccounting(probes.length), { warmPasses: 2 });

    const flagged = r.per_query[0]!.warm_searches![0]!;
    expect(flagged).toMatchObject({ pass: 0, degraded: true, degraded_reason: 'vector_not_enabled' });
    expect(flagged.latency_ms!).toBeGreaterThanOrEqual(50);
    expect(r.per_query.flatMap(q => q.warm_searches!).filter(s => s.degraded)).toHaveLength(1);
    expect(r.per_query.every(q => q.warm_searches!.length === 2)).toBe(true);

    expect(r.warm).toMatchObject({
      passes: 2, searches: 4, clean_searches: 3, warm_excluded_degraded: 1, failures: 0,
      degraded_signal: 'search_observation', degraded_reasons: { vector_not_enabled: 1 },
    });
    // Only the three clean repeats are in warm latency; the 60 ms fallback is not.
    expect(r.warm!.query_ms!.p95).toBeLessThan(50);
    // The raw per-probe timings keep every timed repeat, degraded ones included.
    expect(r.per_query[0]!.warm_latency_ms).toHaveLength(2);
    expect(r.per_query[0]!.warm_latency_ms![0]!).toBeGreaterThanOrEqual(50);
    // The scored pass was clean.
    expect(r.per_query.every(q => q.degraded === false && q.degraded_reason === undefined)).toBe(true);
    expect(r.degraded_signal).toBe('search_observation');
  });

  test('a clean run flags nothing and excludes 0', async () => {
    const { probes, gradesByQuery } = probesAndGold();
    const r = await scoreAdapter(new ObservingAdapter(), [], probes, gradesByQuery, new ProbeAccounting(probes.length), { warmPasses: 3 });
    expect(r.warm).toMatchObject({ searches: 6, clean_searches: 6, warm_excluded_degraded: 0, failures: 0, degraded_reasons: {} });
    expect(r.warm!.query_ms).not.toBeNull();
    expect(r.per_query.flatMap(q => [q.degraded, ...q.warm_searches!.map(s => s.degraded)]).every(d => d === false)).toBe(true);
  });

  test('the excluded count is exact across passes, reasons, a thrown search and a missing observation', async () => {
    const { probes, gradesByQuery } = probesAndGold();
    // Warm calls are 2..7 (3 passes x 2 probes).
    const adapter = new ObservingAdapter({
      2: { failures: ['vector_not_enabled', 'original_embed_failed'] },
      4: { failures: ['reranker_skipped:no_key'] },
      5: { throws: true },
      7: { noObservation: true },
    });
    const r = await scoreAdapter(adapter, [], probes, gradesByQuery, new ProbeAccounting(probes.length), { warmPasses: 3 });
    expect(r.warm).toMatchObject({
      searches: 6, clean_searches: 2, warm_excluded_degraded: 4, failures: 1,
      degraded_reasons: { vector_not_enabled: 1, original_embed_failed: 1, 'reranker_skipped:no_key': 1, search_threw: 1, search_observation_missing: 1 },
    });
    const thrown = r.per_query[1]!.warm_searches![1]!;
    expect(thrown).toEqual({ pass: 1, degraded: true, degraded_reason: 'search_threw' });
    expect(r.per_query[0]!.warm_searches![0]!.degraded_reason).toBe('vector_not_enabled,original_embed_failed');
    expect(r.per_query[1]!.warm_searches![2]!.degraded_reason).toBe('search_observation_missing');
  });

  test('the scored pass flags a degraded search on its row; its latency rules do not change', async () => {
    const { probes, gradesByQuery } = probesAndGold();
    const r = await scoreAdapter(new ObservingAdapter({ 0: { failures: ['vector_not_enabled'], sleepMs: 60 } }), [], probes, gradesByQuery, new ProbeAccounting(probes.length));
    expect(r.per_query[0]).toMatchObject({ degraded: true, degraded_reason: 'vector_not_enabled' });
    expect(r.per_query[1]).toMatchObject({ degraded: false });
    // First-pass latency still includes every timed search (a degraded scored
    // search already makes a gbrain-backed run incomplete in runCat13).
    expect(r.phase!.query_ms!.p95).toBeGreaterThanOrEqual(50);
    expect(r.warm).toBeUndefined();
  });

  test('an adapter with no per-search observations is flagged only when its query throws', async () => {
    const { probes, gradesByQuery } = probesAndGold();
    let calls = 0;
    const plain: Adapter = {
      name: 'plain', async init() { return {}; },
      async query() { if (calls++ === 3) throw new Error('boom'); return []; },
    };
    const r = await scoreAdapter(plain, [], probes, gradesByQuery, new ProbeAccounting(probes.length), { warmPasses: 1 });
    expect(r.degraded_signal).toBe('query_error_only');
    expect(r.warm).toMatchObject({ searches: 2, clean_searches: 1, warm_excluded_degraded: 1, failures: 1, degraded_signal: 'query_error_only', degraded_reasons: { query_error: 1 } });
  });

  test('a reranker adapter flags a warm search whose rerank was skipped', async () => {
    const { probes, gradesByQuery } = probesAndGold();
    let calls = 0;
    const rerank: Adapter & { observedStats(s: unknown): unknown } = {
      name: 'rerank', async init() { return { observed: { queries: 0, rerank_scored_queries: 0, rerank_failures: [] as Array<{ query_id: string; reasons: string[] }> } }; },
      async query(q, state) {
        const o = (state as { observed: { queries: number; rerank_failures: Array<{ query_id: string; reasons: string[] }> } }).observed;
        o.queries += 1;
        if (calls++ === 2) o.rerank_failures.push({ query_id: q.id, reasons: ['skipped:no_key'] });
        return [];
      },
      observedStats(state) { return (state as { observed: unknown }).observed; },
    };
    const r = await scoreAdapter(rerank, [], probes, gradesByQuery, new ProbeAccounting(probes.length), { warmPasses: 1 });
    expect(r.degraded_signal).toBe('rerank_observation');
    expect(r.warm).toMatchObject({ warm_excluded_degraded: 1, degraded_reasons: { 'rerank:skipped:no_key': 1 } });
  });
});

describe('cat13 warm degraded flag on the real gbrain adapter (hermetic PGLite)', () => {
  test('a vector-arm outage during one warm search is flagged from gbrain\'s own search meta and excluded', async () => {
    ensureGateway(true, { model: 'openai:text-embedding-3-large', dims: 1536 });
    const pins = retrievalPins();
    const inner = new GbrainInlineAdapter({ topK: 5, searchConfig: pins, expectStubTransport: true });
    let calls = 0;
    // Delegates to the real adapter; on the first warm search the engine's vector arm throws, the way a provider outage would.
    const outage: Adapter = {
      name: 'gbrain',
      init: (pages, config) => inner.init(pages, config),
      async query(q, state) {
        const engine = (state as { engine: PGLiteEngine }).engine;
        const original = engine.searchVector.bind(engine);
        if (calls++ === 2) engine.searchVector = async () => { throw new Error('injected vector outage'); };
        try { return await inner.query(q, state); } finally { engine.searchVector = original; }
      },
      teardown: state => inner.teardown(state),
    };
    Object.assign(outage, { observedStats: (s: unknown) => inner.observedStats(s), resolvedConfig: (s: unknown) => inner.resolvedConfig(s) });
    const pages: Page[] = [
      { slug: 'concepts/a', type: 'concept', title: 'Cache Warmup', compiled_truth: 'Cache warmup keeps repeat queries fast.', timeline: '' },
      { slug: 'concepts/b', type: 'concept', title: 'Index Rebuild', compiled_truth: 'An index rebuild refreshes stale search entries.', timeline: '' },
    ];
    const probes = [fakeProbe('p1', 'cache warmup', 'concepts/a'), fakeProbe('p2', 'index rebuild', 'concepts/b')];
    const gradesByQuery = new Map([['p1', new Map([['concepts/a', 3]])], ['p2', new Map([['concepts/b', 3]])]]);
    try {
      const r = await scoreAdapter(outage, pages, probes, gradesByQuery, new ProbeAccounting(probes.length), { initConfig: { searchConfig: pins }, warmPasses: 1 });
      expect(r.degraded_signal).toBe('search_observation');
      expect(r.per_query.every(q => q.degraded === false)).toBe(true);
      const flagged = r.per_query[0]!.warm_searches![0]!;
      expect(flagged.degraded).toBe(true);
      // gbrain fails open to keyword-only and says so in its meta; the reason is its code, never the error text.
      expect(flagged.degraded_reason).toContain('vector_not_enabled');
      expect(flagged.degraded_reason).not.toContain('injected');
      expect(r.per_query[1]!.warm_searches![0]!.degraded).toBe(false);
      expect(r.warm).toMatchObject({ searches: 2, clean_searches: 1, warm_excluded_degraded: 1, failures: 0 });
      // The scored-pass observations stay a first-pass snapshot.
      expect(r.observed!.search_observations).toHaveLength(2);
    } finally {
      __setEmbedTransportForTests(null);
    }
  }, 120_000);

  test('a clean warm run through runCat13 writes the flag and a zero excluded count into the receipt', async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'cat13-warm-'));
    const { receipt, exitCode } = await runCat13({ stubEmbed: true, only: 'gbrain', targetProbes: 30, warmPasses: 1, reportsDir, quiet: true });
    expect(exitCode).toBe(0);
    const data = receipt.data as { scorecard: Array<Record<string, any>>; per_query: Record<string, Array<Record<string, any>>> };
    const row = data.scorecard.find(s => s.name === 'gbrain')!;
    expect(row.degraded_signal).toBe('search_observation');
    expect(row.warm).toMatchObject({ passes: 1, warm_excluded_degraded: 0, failures: 0, degraded_reasons: {} });
    expect(row.warm.searches).toBe(row.warm.clean_searches);
    const rows = data.per_query.gbrain!;
    expect(rows.length).toBeGreaterThan(0);
    expect(row.warm.searches).toBe(rows.length);
    expect(rows.every(q => q.degraded === false && q.warm_searches.length === 1 && q.warm_searches[0].degraded === false)).toBe(true);
  }, 300_000);
});
