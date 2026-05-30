/**
 * Semantic-parity guard for the de-ava'd PrecisionMemBench scorer.
 *
 * The scoring math (precision/recall/pinnedCoverage + the mustInclude/
 * mustExclude/shouldOnlyInclude/maxCount assertions) was lifted verbatim from
 * upstream's `retrieval.external.eval.test.ts`. This test pins that the
 * de-ava'ing did not change the math: a controlled adapter returns known sets
 * through `scoreCases` and we assert the exact precision/recall/passed values.
 *
 * See eval/precisionmembench/ATTRIBUTION.md (faithfulness invariant: semantic
 * parity, timings normalized out).
 */

import { describe, expect, test } from 'bun:test';
import { BaseAdapter } from '../../eval/precisionmembench/scorer/baseAdapter.ts';
import { scoreCases, pinnedInSeedSet, coerceBelief, type RetrievalCase } from '../../eval/precisionmembench/scorer/runCases.ts';
import type { Belief } from '../../eval/precisionmembench/scorer/belief.ts';

// Minimal belief corpus (domain:code scope, none pinned so buildContext's
// pinned/relation/question paths stay empty and we isolate searchText scoring).
const RAW: Record<string, unknown>[] = [
  { _id: 'b1', user_id: 'test-user', type: 'entity', canonical_name: 'redis', aliases: ['cache'], content: 'redis cache', why_it_matters: '', scope: ['domain:code'], pinned: false, superseded_by: null },
  { _id: 'b2', user_id: 'test-user', type: 'entity', canonical_name: 'kubernetes', aliases: ['k8s'], content: 'k8s', why_it_matters: '', scope: ['domain:code'], pinned: false, superseded_by: null },
  { _id: 'b3', user_id: 'test-user', type: 'entity', canonical_name: 'postgres', aliases: ['pg'], content: 'pg', why_it_matters: '', scope: ['domain:code'], pinned: false, superseded_by: null },
];
const BELIEFS: Belief[] = RAW.map(coerceBelief);

/** Adapter whose searchText returns a fixed belief-id list per query. */
class StubAdapter extends BaseAdapter {
  constructor(private readonly returns: Record<string, string[]>) {
    super('gbrain');
  }
  override async searchText(
    _userId: string,
    query: string,
    opts?: { excludeIds?: Set<string> },
  ): Promise<Belief[]> {
    const ids = this.returns[query] ?? [];
    const out: Belief[] = [];
    for (const id of ids) {
      if (opts?.excludeIds?.has(id)) continue;
      const b = this.seedIndex.get(id);
      if (b) out.push(b);
    }
    return out;
  }
}

function run(returns: Record<string, string[]>, cases: RetrievalCase[]) {
  const adapter = new StubAdapter(returns);
  adapter.loadFixture(BELIEFS);
  return scoreCases(adapter, cases, pinnedInSeedSet(BELIEFS));
}

describe('scoreCases semantic parity', () => {
  test('shouldOnlyInclude exact match → precision 1.0, recall 1.0, pass', async () => {
    const [r] = await run(
      { 'redis?': ['b1'] },
      [{ caseId: 'c1', category: 'Alias resolution', description: '', scope: ['domain:code'], query: 'redis?', expect: { relevantBeliefs: { shouldOnlyInclude: ['b1'] } } }],
    );
    expect(r.retrievalPrecision).toBe(1);
    expect(r.retrievalRecall).toBe(1);
    expect(r.passed).toBe(true);
  });

  test('extra belief beyond shouldOnlyInclude → precision 0.5 AND fail', async () => {
    const [r] = await run(
      { q: ['b1', 'b2'] },
      [{ caseId: 'c2', category: 'Alias resolution', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { shouldOnlyInclude: ['b1'] } } }],
    );
    expect(r.retrievalPrecision).toBe(0.5); // 1 hit / 2 returned
    expect(r.retrievalRecall).toBe(1); // 1 hit / 1 expected
    expect(r.passed).toBe(false); // unexpected belief b2
    expect(r.failures.some((f) => f.includes('b2'))).toBe(true);
  });

  test('two expected, one returned → precision 1.0, recall 0.5, pass (no shouldOnly)', async () => {
    const [r] = await run(
      { q: ['b1'] },
      [{ caseId: 'c3', category: 'Alias resolution', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { mustInclude: ['b1', 'b2'] } } }],
    );
    // mustInclude b2 missing → fail; precision = 1 returned hit / 1 returned;
    // recall = 1 hit / 2 expected.
    expect(r.retrievalPrecision).toBe(1);
    expect(r.retrievalRecall).toBe(0.5);
    expect(r.passed).toBe(false);
  });

  test('empty-expected + empty-returned → precision null, recall null, pass', async () => {
    const [r] = await run(
      { q: [] },
      [{ caseId: 'c4', category: 'Type routing and open questions', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { shouldOnlyInclude: [] } } }],
    );
    expect(r.retrievalPrecision).toBeNull();
    expect(r.retrievalRecall).toBeNull();
    expect(r.passed).toBe(true);
  });

  test('empty-expected + non-empty-returned → precision 0.0, pass=false', async () => {
    const [r] = await run(
      { q: ['b1'] },
      [{ caseId: 'c5', category: 'Type routing and open questions', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { shouldOnlyInclude: [] } } }],
    );
    expect(r.retrievalPrecision).toBe(0); // 0 hits / 1 returned
    expect(r.passed).toBe(false); // b1 unexpected
  });

  test('mustExclude violation fails the case', async () => {
    const [r] = await run(
      { q: ['b1', 'b3'] },
      [{ caseId: 'c6', category: 'Scope disambiguation', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { mustInclude: ['b1'], mustExclude: ['b3'] } } }],
    );
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.includes('b3'))).toBe(true);
  });

  test('maxCount violation fails', async () => {
    const [r] = await run(
      { q: ['b1', 'b2', 'b3'] },
      [{ caseId: 'c7', category: 'Budget eviction and capacity', description: '', scope: ['domain:code'], query: 'q', expect: { relevantBeliefs: { maxCount: 2 } } }],
    );
    expect(r.passed).toBe(false);
    expect(r.relevantBeliefs.length).toBe(3);
  });
});
