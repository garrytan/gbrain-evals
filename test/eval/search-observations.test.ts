import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HybridSearchMeta } from 'gbrain/types';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import type { Page, Query } from '../../eval/runner/types.ts';
import { resetGateway } from 'gbrain/ai/gateway';
import { GbrainInlineAdapter, type InlineObservedStats } from '../../eval/runner/adapters/gbrain-inline.ts';
import { HybridNoGraphAdapter } from '../../eval/runner/adapters/vector-grep-rrf-fusion.ts';
import { ensureGateway, runCat13 } from '../../eval/runner/cat13-conceptual.ts';
import { GbrainBeliefAdapter } from '../../eval/precisionmembench/gbrainAdapter.ts';
import { coerceBelief } from '../../eval/precisionmembench/scorer/runCases.ts';
import { parseOpts } from '../../eval/runner/precisionmembench.ts';
import {
  observedSearchFailures, recordSearchObservation, retrievalPins, searchObservation,
} from '../../eval/runner/retrieval-pins.ts';

const cleanMeta = (): HybridSearchMeta => ({ vector_enabled: true, detail_resolved: 'medium', expansion_applied: false, degraded: [] });
const ranked = [{ slug: 'concepts/redis-example', score: 0.2 }, { slug: 'concepts/noise-example', score: 0.9 }];

describe('search execution receipts', () => {
  test('a successful empty search is valid, including an empty reranker pool', () => {
    expect(searchObservation({ query: 'unknown thing', results: [], meta: cleanMeta(), requireReranker: true }).failures).toEqual([]);
    expect(searchObservation({ query: ' ', emptyQuerySkipped: true }).failures).toEqual([]);
    expect(searchObservation({ query: 'unknown thing', mode: 'keyword', results: [] }).failures).toEqual([]);
    expect(searchObservation({ query: 'unknown thing', results: [] }).failures).toEqual(['search_meta_missing']);
  });

  test('no matches and configured clipping remain measured product behavior', () => {
    for (const stage of ['keyword_zero', 'keyword_relaxed_carried', 'budget_dropped_all', 'budget_truncated'] as const) {
      const observation = searchObservation({ query: 'query', results: [], meta: { ...cleanMeta(), degraded: [{ stage }] } });
      expect(observation.search_meta?.degraded).toEqual([{ stage }]);
      expect(observation.failures).toEqual([]);
    }
  });

  test('vector fallback is invalid even when the result set is empty', () => {
    const observation = searchObservation({ query: 'query', results: [], meta: {
      ...cleanMeta(), vector_enabled: false, degraded: [{ stage: 'embed_timeout', reason: 'timeout' }, { stage: 'keyword_zero' }],
    } });
    expect(observation.failures).toEqual(['vector_not_enabled', 'embed_timeout:timeout']);
    for (const stage of ['vector_arm_failed', 'expansion_partial', 'rescore_skipped', 'cache_prestamp'] as const) {
      expect(searchObservation({ query: 'query', results: ranked, meta: { ...cleanMeta(), degraded: [{ stage }] } }).failures).toEqual([`${stage}:unknown`]);
    }
  });

  test('one failed rerank cannot hide behind another successful query', () => {
    const stats = { queries: 0, rerank_scored_queries: 0, keyword_arm_confidence_stamped: 0, keyword_arm_confidence_downweighted: 0 };
    recordSearchObservation(stats, searchObservation({ queryId: 'good', query: 'query', results: [{ ...ranked[0], rerank_score: 0.8 }], meta: cleanMeta(), requireReranker: true }));
    recordSearchObservation(stats, searchObservation({ queryId: 'bad', query: 'query', results: ranked, meta: { ...cleanMeta(), degraded: [{ stage: 'rerank_passthrough', reason: 'empty_result_set' }] }, requireReranker: true }));
    expect(stats.rerank_scored_queries).toBe(1);
    expect(observedSearchFailures(stats, 2)).toEqual([{ query_id: 'bad', reasons: ['rerank_passthrough:empty_result_set', 'rerank_scores_missing'] }]);
    expect(observedSearchFailures(stats, 3).at(-1)?.reasons).toEqual(['search_observation_count:2/3']);
  });

  test('metadata is snapshotted, keeps product order, and records relational fail-open', () => {
    const meta = cleanMeta();
    const observation = searchObservation({ query: 'query', results: ranked, meta, relationalMeta: { errored: true, candidates: 0 } });
    meta.degraded!.push({ stage: 'embed_timeout' });
    expect(observation.search_meta?.degraded).toEqual([]);
    expect(observation.ranked_results.map(r => r.slug)).toEqual(ranked.map(r => r.slug));
    expect(observation.failures).toEqual(['relational_arm_failed']);
    expect(observedSearchFailures(undefined, 1)[0].reasons).toEqual(['search_observation_count:0/1']);
  });

  test('zero adaptive caps are rejected before an engine or provider is opened', () => {
    for (const flag of ['--entity-max', '--other-max', '--min-keep']) {
      expect(() => parseOpts([flag, '0'])).toThrow('integer >= 1');
      expect(() => parseOpts([flag, '1'])).not.toThrow();
    }
  });
});

describe('real adapter fail-open observations with local hash embeddings', () => {
  test('a single fallback invalidates the conceptual receipt even below the general error-rate cap', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'search-failure-receipt-'));
    let injectFailure = true;
    const querySpy = spyOn(GbrainInlineAdapter.prototype, 'query').mockImplementation(async (query, state) => {
      const observed = (state as { observed: InlineObservedStats }).observed;
      const meta = cleanMeta();
      if (injectFailure && observed.queries === 0) {
        meta.vector_enabled = false;
        meta.degraded = [{ stage: 'embed_timeout', reason: 'timeout' }];
      }
      recordSearchObservation(observed, searchObservation({ query: query.text, queryId: query.id, results: [], meta }));
      return [];
    });
    try {
      const failed = await runCat13({ stubEmbed: true, only: 'gbrain', targetProbes: 1, reportsDir: join(directory, 'failed'), quiet: true });
      expect(failed.receipt.run_status).toBe('error');
      expect(failed.receipt.publishable).toBe(false);
      expect(failed.exitCode).toBe(3);
      expect(failed.receipt.errors).toHaveLength(1);
      expect(failed.receipt.errors.length / failed.receipt.n_total).toBeLessThan(0.1);
      expect(failed.results[0].per_query[0].search_observation?.failures).toContain('vector_not_enabled');

      // The same zero retrieval score with complete execution is a measured
      // quality failure, not an invalid execution or a missing query.
      injectFailure = false;
      const empty = await runCat13({ stubEmbed: true, only: 'gbrain', targetProbes: 1, reportsDir: join(directory, 'empty'), quiet: true });
      expect(empty.receipt.run_status).toBe('completed');
      expect(empty.receipt.verdict).toBe('fail');
      expect(empty.exitCode).toBe(1);
      expect(empty.receipt.errors).toEqual([]);
      expect(empty.results[0].ndcg5).toBe(0);
      expect(empty.receipt.n_scored).toBe(empty.receipt.n_total);
    } finally {
      querySpy.mockRestore();
      resetGateway();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  for (const kind of ['inline', 'no-extract'] as const) {
    test(`${kind}: every vector failure is retained with the returned fallback ranking`, async () => {
      // The explicit stub guard and local transport prevent live provider calls.
      ensureGateway(true, { model: 'openai:text-embedding-3-large', dims: 1536 });
      const pins = retrievalPins();
      const adapter = kind === 'inline'
        ? new GbrainInlineAdapter({ topK: 5, searchConfig: pins, expectStubTransport: true })
        : new HybridNoGraphAdapter();
      const pages: Page[] = [{ slug: 'concepts/redis-example', type: 'concept', title: 'Redis Example', compiled_truth: 'Redis Example provides a fast cache for application data.', timeline: '' }];
      const state = await adapter.init(pages, { name: adapter.name, searchConfig: pins });
      const engine = (state as { engine: PGLiteEngine }).engine;
      const originalVector = engine.searchVector.bind(engine);
      try {
        const query: Query = { id: 'clean', text: 'Redis Example cache', tier: 'fuzzy', expected_output_type: 'cited-source-pages', gold: { relevant: [] }, tags: [] };
        await adapter.query(query, state);
        expect(observedSearchFailures(adapter.observedStats(state), 1)).toEqual([]);
        engine.searchVector = async () => { throw new Error('injected vector outage'); };
        const fallback = await adapter.query({ ...query, id: 'fallback' }, state);
        expect(fallback.length).toBeGreaterThan(0); // The product fails open; the experiment does not.
        const observed = adapter.observedStats(state);
        const failed = observed.search_observations![1];
        expect(failed.query_id).toBe('fallback');
        expect(failed.search_meta?.vector_enabled).toBe(false);
        expect(failed.failures).toContain('vector_arm_failed:provider_error');
        expect(failed.ranked_results.map(r => r.slug)).toContain('concepts/redis-example');
        expect(observedSearchFailures(observed, 2)).toHaveLength(1);

        // Precision uses the same public search path and must keep its own
        // receipt before mapping/filtering the ranked page IDs to beliefs.
        const precision = new GbrainBeliefAdapter(engine, 'hybrid', { extraHybridOpts: { sourceIds: ['default'] } });
        precision.loadFixture([coerceBelief({ _id: pages[0].slug, user_id: 'example-user', type: 'entity', canonical_name: 'Redis Example', content: pages[0].compiled_truth, scope: [], pinned: false })]);
        await precision.searchText('example-user', query.text);
        expect(precision.observations[0].failures).toContain('vector_not_enabled');
        expect(precision.observations[0].ranked_ids).toContain(pages[0].slug);
        expect(precision.observations[0].search_meta?.degraded?.some(d => d.stage === 'vector_arm_failed')).toBe(true);

        // A real, successful searchVector returning [] still reports enabled.
        engine.searchVector = async () => [];
        await adapter.query({ ...query, id: 'empty-vector-pool' }, state);
        expect(adapter.observedStats(state).search_observations![2].failures).toEqual([]);
      } finally {
        engine.searchVector = originalVector;
        await adapter.teardown!(state);
        resetGateway();
      }
    }, 60_000);
  }

  test('Precision records a thrown search and a valid blank-query skip separately', async () => {
    const engine = { searchKeyword: async () => { throw new Error('injected database outage'); } } as unknown as PGLiteEngine;
    const adapter = new GbrainBeliefAdapter(engine, 'keyword');
    await expect(adapter.searchText('example-user', 'cache')).rejects.toThrow('injected database outage');
    expect(adapter.observations[0].failures).toEqual(['search_threw']);
    expect(adapter.observations[0].error).toContain('injected database outage');
    expect(await adapter.searchText('example-user', '   ')).toEqual([]);
    expect(adapter.observations[1].empty_query_skipped).toBe(true);
    expect(adapter.observations[1].failures).toEqual([]);
  });
});
