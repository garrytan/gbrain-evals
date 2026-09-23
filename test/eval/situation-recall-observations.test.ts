import { expect, test } from 'bun:test';
import { searchObservation } from '../../eval/runner/retrieval-pins.ts';
import { executedCueLookup } from '../../eval/runner/situation-recall-observations.ts';
import type { HybridSearchMeta } from 'gbrain/types';

test('bounded ANN outcomes stay in quality denominators and preserve native metadata', () => {
  for (const reason of ['candidate_budget', 'iterative_scan_unavailable']) {
    const meta = { vector_enabled: true, degraded: [{ stage: 'vector_candidates_incomplete', reason }] } as unknown as HybridSearchMeta;
    const observation = searchObservation({ query: 'No matching source', results: [], meta });
    expect(observation.failures).toEqual([]);
    expect(observation.result_count).toBe(0);
    expect(observation.search_meta?.degraded).toEqual(meta.degraded);
    expect(executedCueLookup('degraded', reason)).toBe(true);
  }
});

test('deadline, schema, index and model failures never become bounded-search outcomes', () => {
  for (const reason of ['timeout', 'deadline', 'schema_missing', 'index_missing', 'unsupported_embedding_signature']) {
    const meta = { vector_enabled: true, degraded: [{ stage: 'vector_candidates_incomplete', reason }] } as unknown as HybridSearchMeta;
    expect(searchObservation({ query: 'A request', results: [], meta }).failures).toHaveLength(1);
    expect(executedCueLookup('degraded', reason)).toBe(false);
  }
});
