import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import inventory from '../../eval/regression/situation-recall-v1.json';
import { queryEvidence, scoreQuery, type QueryEvidence } from '../../eval/runner/cat18-embedding-providers.ts';
import { CAT24_PROBE_IDS, type PathProbe, type PreservationProbeEvidence, type ProvenanceProbeEvidence, type SchemaProbeEvidence } from '../../eval/runner/cat24-capture-provenance.ts';
import { percentile } from '../../eval/runner/metrics.ts';
import type { ProbeError, Receipt } from '../../eval/runner/receipt.ts';
import type { RegressionMetricSpec, RegressionProfile } from '../../eval/runner/situation-recall-contract.ts';
import { collectNativeRows1824 } from '../../eval/runner/situation-recall-native-18-24.ts';
import { collectSituationNativeRows, materializeNativeRegressionRows } from '../../eval/runner/situation-recall-native.ts';
import { loadSyntheticV1, syntheticQueries } from '../../eval/runner/synthetic-corpus-loader.ts';

const QUERIES = syntheticQueries(loadSyntheticV1()).slice(0, 3);
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
beforeEach(() => { network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in pure collector tests')); });
afterEach(() => {
  const calls = network.mock.calls.length;
  network.mockRestore();
  expect(calls).toBe(0);
});

type CellFixture = {
  cell: string; embedder: string; dim?: number; embed_dim?: number; reranker?: string | null;
  per_query: QueryEvidence[]; queries_total: number; queries_scored: number; query_errors: number; valid: boolean;
  recall_at_10: number | null; mrr: number | null; top1_hit_rate: number | null; mean_query_ms: number | null; p50_query_ms: number | null;
};
type PairFixture = { embedder: string; baseline: string; rerank: string; recall_delta: number | null; mrr_delta: number | null; top1_delta: number | null };
type QueryReceipt = Receipt & { data: { cells: CellFixture[]; queries: number; pairs: PairFixture[] } };
type ProvenanceReceipt = Receipt & { data: {
  per_probe: ProvenanceProbeEvidence[]; per_path: PathProbe[]; schema_test: SchemaProbeEvidence; preservation_test: PreservationProbeEvidence;
  dedup_test: { before_rows: number; after_rows: number; distinct_page_ids: number; reimport_status: string };
} };

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function envelope(category: string): Receipt {
  return { schema_version: 1, benchmark_version: 'fixture-only', category, run_status: 'completed', verdict: 'pass', n_total: 0,
    n_scored: 0, completion_rate: 0, errors: [], publishable: false, gbrain_version: 'fixture-only', gbrain_pin: 'fixture-only',
    started_at: '2026-09-23T00:00:00.000Z', finished_at: '2026-09-23T00:00:01.000Z' };
}

function refresh(receipt: QueryReceipt): void {
  for (const cell of receipt.data.cells) {
    const scored = cell.per_query.filter(row => row.scored);
    cell.queries_total = cell.per_query.length;
    cell.queries_scored = scored.length;
    cell.query_errors = cell.per_query.length - scored.length;
    cell.valid = cell.query_errors === 0;
    cell.recall_at_10 = mean(scored.map(row => row.recall_at_10!));
    cell.mrr = mean(scored.map(row => row.mrr!));
    cell.top1_hit_rate = mean(scored.map(row => row.top1_hit_rate!));
    cell.mean_query_ms = mean(scored.map(row => row.query_ms!));
    cell.p50_query_ms = scored.length ? percentile(scored.map(row => row.query_ms!), 50) : null;
  }
  receipt.n_total = receipt.data.cells.reduce((sum, cell) => sum + cell.queries_total, 0);
  receipt.n_scored = receipt.data.cells.reduce((sum, cell) => sum + cell.queries_scored, 0);
  receipt.completion_rate = receipt.n_scored / receipt.n_total;
  receipt.errors = receipt.data.cells.flatMap(cell => cell.per_query.flatMap(row => row.error ? [row.error] : []));
  for (const pair of receipt.data.pairs) {
    const base = receipt.data.cells.find(cell => cell.cell === pair.baseline)!;
    const rerank = receipt.data.cells.find(cell => cell.cell === pair.rerank)!;
    pair.recall_delta = base.valid && rerank.valid ? rerank.recall_at_10! - base.recall_at_10! : null;
    pair.mrr_delta = base.valid && rerank.valid ? rerank.mrr! - base.mrr! : null;
    pair.top1_delta = base.valid && rerank.valid ? rerank.top1_hit_rate! - base.top1_hit_rate! : null;
  }
}

function queryReceipt(category: 'cat18' | 'cat18b'): QueryReceipt {
  const names = category === 'cat18' ? ['openai'] : ['openai-1536', 'openai-1536+rerank'];
  const cells: CellFixture[] = names.map((name, index) => ({
    cell: name, embedder: 'openai:text-embedding-3-large',
    ...(category === 'cat18' ? { dim: 1536 } : { embed_dim: 1536, reranker: index ? 'zeroentropyai:zerank-2' : null }),
    per_query: QUERIES.map((query, i) => {
      const ranked = index ? [...query.relevant_slugs] : ['fixture/unrelated', query.relevant_slugs[0]];
      return queryEvidence(name, query, 10, ranked, [11, 31, 101][i] + index, scoreQuery(ranked, query.relevant_slugs, 10));
    }),
    queries_total: 0, queries_scored: 0, query_errors: 0, valid: false,
    recall_at_10: null, mrr: null, top1_hit_rate: null, mean_query_ms: null, p50_query_ms: null,
  }));
  const receipt: QueryReceipt = { ...envelope(category === 'cat18' ? 'cat18-embedding-providers' : 'cat18b-embedding-rerank-matrix'), data: {
    cells, queries: QUERIES.length, pairs: category === 'cat18' ? [] : [{ embedder: cells[0].embedder, baseline: names[0], rerank: names[1], recall_delta: null, mrr_delta: null, top1_delta: null }],
  } };
  refresh(receipt);
  return receipt;
}

function failQuery(receipt: QueryReceipt, cellIndex: number, queryIndex: number, origin: 'harness' | 'dependency' = 'dependency'): void {
  const query = receipt.data.cells[cellIndex].per_query[queryIndex];
  Object.assign(query, { scored: false, status: 'error', recall_at_10: null, mrr: null, top1_hit_rate: null,
    error: { probe_id: query.probe_id, origin, message: 'recorded fixture execution failure' } });
  refresh(receipt);
}

function provenanceReceipt(): ProvenanceReceipt {
  const stamp = '2026-09-23T00:00:00.000Z';
  const per_probe: ProvenanceProbeEvidence[] = CAT24_PROBE_IDS.map(probe_id => ({ probe_id, score: 1, pass: true, error: null }));
  const content = { source_kind: 'capture-cli', source_uri: 'file:///tmp/probe.md', ingested_via: 'capture-cli', ingested_at: stamp, source_path: null };
  const per_path: PathProbe[] = [
    { probe_id: 'content-import', path: 'fixture content', slug: 'inbox/2026-05-23-content-import', expected: { source_kind: 'capture-cli', source_uri: 'file:///tmp/probe.md', ingested_via: 'capture-cli', ingested_at_null: false }, actual: { ...content }, pass: true, fail_reason: null },
    { probe_id: 'file-import-no-channel-provenance', path: 'fixture file', slug: 'inbox/2026-05-23-file-import', expected: { source_kind: null, source_uri: null, ingested_via: null, ingested_at_null: true }, actual: { source_kind: null, source_uri: null, ingested_via: null, ingested_at: null, source_path: 'inbox/2026-05-23-file-import.md' }, pass: true, fail_reason: null },
    { probe_id: 'op-put-page-local-trusted', path: 'fixture local', slug: 'inbox/2026-05-23-op-local', expected: { source_kind: 'capture-cli', source_uri: 'stdin', ingested_via: 'capture-cli', ingested_at_null: false }, actual: { ...content, source_uri: 'stdin' }, pass: true, fail_reason: null },
    { probe_id: 'op-put-page-remote-spoof-override', path: 'fixture remote', slug: 'inbox/2026-05-23-op-remote', expected: { source_kind: 'mcp:put_page', source_uri: null, ingested_via: 'mcp:put_page', ingested_at_null: false }, actual: { ...content, source_kind: 'mcp:put_page', source_uri: null, ingested_via: 'mcp:put_page' }, pass: true, fail_reason: null },
  ];
  return { ...envelope('cat24-capture-provenance'), n_total: 7, n_scored: 7, completion_rate: 1, data: {
    per_probe, per_path,
    schema_test: { ...per_probe[0], selected_columns: ['source_kind', 'source_uri', 'ingested_via', 'ingested_at'], select_succeeded: true },
    preservation_test: { ...per_probe[6], before: { ...content }, after: { ...content }, at_before: stamp, at_after: stamp },
    dedup_test: { before_rows: 1, after_rows: 1, distinct_page_ids: 1, reimport_status: 'unchanged' },
  } };
}

function failProbe(receipt: ProvenanceReceipt, id: string): void {
  const outcome = receipt.data.per_probe.find(row => row.probe_id === id)!;
  const error: ProbeError = { probe_id: id, origin: 'sut', message: 'recorded fixture SUT failure' };
  Object.assign(outcome, { pass: false, score: 0, error });
  for (const detail of [receipt.data.schema_test, receipt.data.preservation_test]) {
    if (detail.probe_id === id) Object.assign(detail, outcome);
  }
  receipt.errors.push(error);
  receipt.verdict = 'fail';
}

function profile(category: 'cat18' | 'cat18b' | 'cat24'): RegressionProfile {
  const contract = inventory.native_contracts[category === 'cat24' ? 'cat24' : category === 'cat18' ? 'cat18-primary' : 'cat18b-primary'];
  const cells = category === 'cat18' ? ['openai'] : ['openai-1536', 'openai-1536+rerank'];
  const probes = category === 'cat24'
    ? CAT24_PROBE_IDS.map((probe_id, i) => ({ probe_id, family_id: probe_id, slices: i > 0 && i < 5 ? [probe_id] : [], critical: true, no_gold_metrics: [] }))
    : cells.flatMap(cell => QUERIES.map(query => ({ probe_id: `${cell}:${query.id}`, family_id: query.id, slices: [cell], critical: false, no_gold_metrics: [] })));
  return { id: `fixture-${category}`, category, probes, metrics: contract.metrics as RegressionMetricSpec[], required_slices: contract.required_slices } as unknown as RegressionProfile;
}

describe('Cat18/18b native collection and frozen materialization', () => {
  test('per-query retrieval and latency measurements materialize under the frozen IDs and provider slices', async () => {
    const receipt = queryReceipt('cat18');
    const observations = collectNativeRows1824('cat18', receipt);
    const rows = materializeNativeRegressionRows(profile('cat18'), observations);
    expect(rows.map(row => row.probe_id)).toEqual(QUERIES.map(query => `openai:${query.id}`));
    expect(observations.every(row => row.contributed && row.slices.join() === 'openai')).toBe(true);
    expect(rows.map(row => row.metrics.mean_query_ms)).toEqual([11, 31, 101]);
    expect(rows.map(row => row.metrics.p50_query_ms)).toEqual([11, 31, 101]);
    expect(receipt.data.cells[0].p50_query_ms).toBe(31);
    expect(await collectSituationNativeRows(profile('cat18'), receipt)).toEqual(rows);
  });

  test('paired deltas appear only on matching +rerank query rows', () => {
    const receipt = queryReceipt('cat18b');
    const observations = collectNativeRows1824('cat18b', receipt);
    const rows = materializeNativeRegressionRows(profile('cat18b'), observations);
    const base = rows.slice(0, QUERIES.length);
    const reranked = rows.slice(QUERIES.length);
    for (const [i, row] of reranked.entries()) {
      expect(row.metrics.recall_delta).toBe((row.metrics.recall_at_10 as number) - (base[i].metrics.recall_at_10 as number));
      expect(row.metrics.mrr_delta).toBe(0.5);
      expect(row.metrics.top1_delta).toBe(1);
      expect(base[i].metrics.recall_delta).toEqual({ not_applicable: 'outside_metric_slice' });
      expect(observations[i].metrics.recall_delta).toBeUndefined();
    }
    expect(mean(reranked.map(row => row.metrics.recall_delta as number))).toBeCloseTo(receipt.data.pairs[0].recall_delta!, 12);
  });

  test('dependency and harness errors remain excluded, typed, and absent from primary measurements', () => {
    const receipt = queryReceipt('cat18');
    failQuery(receipt, 0, 0, 'dependency');
    failQuery(receipt, 0, 1, 'harness');
    const observations = collectNativeRows1824('cat18', receipt);
    const rows = materializeNativeRegressionRows(profile('cat18'), observations);
    expect(observations.map(row => row.contributed)).toEqual([false, false, true]);
    expect(rows[0].metrics).toEqual({});
    expect(rows[1].metrics).toEqual({});
    expect(rows[0].error).toEqual(receipt.errors[0]);
    expect(rows[1].error).toEqual(receipt.errors[1]);
    expect(receipt.data.cells[0].mean_query_ms).toBe(101);
    expect(receipt.n_total).toBe(3);
    expect(receipt.n_scored).toBe(1);
  });

  test('complete reranker fail-open preserves all errors without inventing pair deltas', () => {
    const receipt = queryReceipt('cat18b');
    for (let i = 0; i < QUERIES.length; i++) failQuery(receipt, 1, i);
    const observations = collectNativeRows1824('cat18b', receipt);
    const rows = materializeNativeRegressionRows(profile('cat18b'), observations);
    for (const row of rows.slice(QUERIES.length)) {
      expect(row.metrics).toEqual({});
      expect(row.error!.origin).toBe('dependency');
    }
    expect(receipt.data.pairs[0].recall_delta).toBeNull();
  });

  test('a partially invalid pair cannot become a complete paired comparison', () => {
    const receipt = queryReceipt('cat18b');
    failQuery(receipt, 0, 0);
    const observations = collectNativeRows1824('cat18b', receipt);
    expect(observations[0].error!.origin).toBe('dependency');
    expect(observations[QUERIES.length].metrics.recall_at_10).toBeDefined();
    expect(observations[QUERIES.length].metrics.recall_delta).toBeUndefined();
    expect(() => materializeNativeRegressionRows(profile('cat18b'), observations)).toThrow('native metric evidence missing');
  });

  for (const field of ['queries_scored', 'queries_total', 'query_errors', 'recall_at_10', 'mrr', 'top1_hit_rate', 'mean_query_ms', 'p50_query_ms'] as const) {
    test(`rejects a native cell ${field} that disagrees with its observed denominator`, () => {
      const receipt = queryReceipt('cat18');
      receipt.data.cells[0][field] = 999;
      expect(() => collectNativeRows1824('cat18', receipt)).toThrow('disagrees');
    });
  }

  test('rejects manufactured query scores even if aggregates were adjusted to match', () => {
    const receipt = queryReceipt('cat18');
    receipt.data.cells[0].per_query[0].recall_at_10 = 0.12345;
    refresh(receipt);
    expect(() => collectNativeRows1824('cat18', receipt)).toThrow('recall_at_10 disagrees');
  });

  test('rejects missing execution evidence, fractional counts, and fake failure zeros', () => {
    const ranking = queryReceipt('cat18');
    ranking.data.cells[0].per_query[0].ranked_ids = null;
    expect(() => collectNativeRows1824('cat18', ranking)).toThrow('missing successful query evidence');
    const latency = queryReceipt('cat18');
    latency.data.cells[0].per_query[0].query_ms = null;
    expect(() => collectNativeRows1824('cat18', latency)).toThrow('missing successful query evidence');
    const fractionalCount = queryReceipt('cat18');
    fractionalCount.n_total += 1e-11;
    expect(() => collectNativeRows1824('cat18', fractionalCount)).toThrow('native count');
    const failed = queryReceipt('cat18');
    failQuery(failed, 0, 0);
    failed.data.cells[0].per_query[0].recall_at_10 = 0;
    expect(() => collectNativeRows1824('cat18', failed)).toThrow('recall_at_10 disagrees');
    const skipped = queryReceipt('cat18');
    skipped.run_status = 'skipped';
    expect(() => collectNativeRows1824('cat18', skipped)).toThrow('native receipt');
  });

  test('an empty native query catalog stays empty and cannot satisfy frozen nonempty IDs', () => {
    const receipt = queryReceipt('cat18');
    receipt.data.cells[0].per_query = [];
    receipt.data.queries = 0;
    refresh(receipt);
    receipt.completion_rate = 0;
    expect(receipt.data.cells[0].recall_at_10).toBeNull();
    const observations = collectNativeRows1824('cat18', receipt);
    expect(observations).toEqual([]);
    expect(() => materializeNativeRegressionRows(profile('cat18'), observations)).toThrow('registered probe IDs');
  });

  test('rejects duplicate, missing, and unknown identities and mismatched frozen slices', () => {
    const duplicate = queryReceipt('cat18');
    duplicate.data.cells[0].per_query.push(duplicate.data.cells[0].per_query[0]);
    expect(() => collectNativeRows1824('cat18', duplicate)).toThrow('duplicate');
    const missing = queryReceipt('cat18');
    missing.data.cells[0].per_query.pop();
    expect(() => collectNativeRows1824('cat18', missing)).toThrow('queries_total');
    const unknown = queryReceipt('cat18');
    unknown.data.cells[0].per_query[0].query_id = 'unknown';
    unknown.data.cells[0].per_query[0].probe_id = 'openai:unknown';
    expect(() => materializeNativeRegressionRows(profile('cat18'), collectNativeRows1824('cat18', unknown))).toThrow('registered probe IDs');
    const wrongSlice = profile('cat18');
    wrongSlice.probes[0].slices = ['voyage'];
    expect(() => materializeNativeRegressionRows(wrongSlice, collectNativeRows1824('cat18', queryReceipt('cat18')))).toThrow('slice identity');
    const unknownCell = queryReceipt('cat18');
    unknownCell.data.cells[0].cell = 'unknown';
    expect(() => collectNativeRows1824('cat18', unknownCell)).toThrow('unknown/duplicate native cell');
  });

  test('rejects broken pairs, cross-cell gold drift, and fabricated error rows', () => {
    const pair = queryReceipt('cat18b');
    pair.data.pairs[0].baseline = 'missing';
    expect(() => collectNativeRows1824('cat18b', pair)).toThrow('pair lookup');
    const duplicate = queryReceipt('cat18b');
    duplicate.data.pairs.push({ ...duplicate.data.pairs[0] });
    expect(() => collectNativeRows1824('cat18b', duplicate)).toThrow('pair lookup');
    const missingPair = queryReceipt('cat18b');
    missingPair.data.pairs = [];
    expect(() => collectNativeRows1824('cat18b', missingPair)).toThrow('missing native reranker pair');
    const delta = queryReceipt('cat18b');
    delta.data.pairs[0].mrr_delta = 0.12345;
    expect(() => collectNativeRows1824('cat18b', delta)).toThrow('mrr_delta disagrees');
    const gold = queryReceipt('cat18b');
    failQuery(gold, 1, 0);
    gold.data.cells[1].per_query[0].relevant_ids = ['different-gold'];
    expect(() => collectNativeRows1824('cat18b', gold)).toThrow('native gold differs');
    const error = queryReceipt('cat18');
    failQuery(error, 0, 0);
    error.data.cells[0].per_query[0].error = { ...error.errors[0], message: 'not the recorded error' };
    expect(() => collectNativeRows1824('cat18', error)).toThrow('error identity/content');
  });
});

describe('Cat24 collection uses seven recorded outcomes and actual snapshots', () => {
  test('materializes exactly the native inventory metrics under the four path slices', async () => {
    const receipt = provenanceReceipt();
    const observations = collectNativeRows1824('cat24', receipt);
    const rows = materializeNativeRegressionRows(profile('cat24'), observations);
    expect(rows.map(row => row.probe_id)).toEqual([...CAT24_PROBE_IDS]);
    expect(observations.map(row => row.slices)).toEqual([[], ...CAT24_PROBE_IDS.slice(1, 5).map(id => [id]), [], []]);
    expect(observations[0].metrics).toEqual({ provenance_columns_present: 1 });
    expect(observations[1].metrics).toEqual({ provenance_fields_correct: 1 });
    expect(observations[5].metrics).toEqual({ before_rows: 1, after_rows: 1, dedup_distinct_page_ids: 1 });
    expect(observations[6].metrics).toEqual({ provenance_preserved_on_reimport: 1 });
    expect(rows[0].metrics.provenance_fields_correct).toEqual({ not_applicable: 'outside_metric_slice' });
    expect(await collectSituationNativeRows(profile('cat24'), receipt)).toEqual(rows);
  });

  test('spoofed provenance and timestamp drift remain scored native SUT failures', () => {
    const receipt = provenanceReceipt();
    const remote = receipt.data.per_path[3];
    remote.actual!.source_kind = 'capture-cli';
    remote.pass = false;
    remote.fail_reason = 'source_kind drift';
    failProbe(receipt, remote.probe_id);
    receipt.data.preservation_test.after!.ingested_at = '2026-09-23T00:00:01.000Z';
    receipt.data.preservation_test.at_after = '2026-09-23T00:00:01.000Z';
    failProbe(receipt, 'provenance-preserved-on-reimport');
    const observations = collectNativeRows1824('cat24', receipt);
    const rows = materializeNativeRegressionRows(profile('cat24'), observations);
    expect(observations.every(row => row.contributed)).toBe(true);
    expect(rows[4].metrics.provenance_fields_correct).toBe(0);
    expect(rows[6].metrics.provenance_preserved_on_reimport).toBe(0);
    expect(rows[4].error).toEqual(receipt.errors[0]);
    expect(rows[6].error).toEqual(receipt.errors[1]);
  });

  test('schema failure preserves all errors and does not turn missing dedup counts into zeros', () => {
    const receipt = provenanceReceipt();
    for (const id of CAT24_PROBE_IDS) failProbe(receipt, id);
    receipt.data.schema_test.select_succeeded = false;
    receipt.data.per_path = [];
    Object.assign(receipt.data.preservation_test, { before: null, after: null, at_before: null, at_after: null });
    Object.assign(receipt.data.dedup_test, { before_rows: -1, after_rows: -1, distinct_page_ids: -1, reimport_status: '' });
    const observations = collectNativeRows1824('cat24', receipt);
    const rows = materializeNativeRegressionRows(profile('cat24'), observations);
    expect(rows.every(row => row.error?.origin === 'sut')).toBe(true);
    expect(rows[0].metrics.provenance_columns_present).toBe(0);
    expect(rows[1].metrics.provenance_fields_correct).toBe(0);
    expect(rows[6].metrics.provenance_preserved_on_reimport).toBe(0);
    expect(observations[5].contributed).toBe(false);
    expect(rows[5].metrics.before_rows).toBeUndefined();
    expect(rows[5].metrics.after_rows).toBeUndefined();
    expect(rows[5].metrics.dedup_distinct_page_ids).toBeUndefined();
  });

  test('measured dedup failures keep real counts instead of a binary replacement', () => {
    const receipt = provenanceReceipt();
    receipt.data.dedup_test.after_rows = 2;
    receipt.data.dedup_test.distinct_page_ids = 2;
    failProbe(receipt, 'dedup-hash-short-circuit');
    const row = collectNativeRows1824('cat24', receipt)[5];
    expect(row.contributed).toBe(true);
    expect(row.metrics).toEqual({ before_rows: 1, after_rows: 2, dedup_distinct_page_ids: 2 });
    expect(row.error!.origin).toBe('sut');
  });

  test('does not infer success from missing schema, rewrite, or outcome evidence', () => {
    for (const missing of ['schema_test', 'preservation_test', 'per_probe']) {
      const receipt = provenanceReceipt();
      delete (receipt.data as Record<string, unknown>)[missing];
      expect(() => collectNativeRows1824('cat24', receipt)).toThrow();
    }
    const partial = provenanceReceipt();
    partial.data.per_probe.pop();
    expect(() => collectNativeRows1824('cat24', partial)).toThrow('all seven');
    const duplicate = provenanceReceipt();
    duplicate.data.per_probe.push(duplicate.data.per_probe[0]);
    expect(() => collectNativeRows1824('cat24', duplicate)).toThrow('duplicate');
    const unknown = provenanceReceipt();
    unknown.data.per_probe[0].probe_id = 'unknown';
    expect(() => collectNativeRows1824('cat24', unknown)).toThrow('unknown');
  });

  test('rejects contradictory schema, stored path, timestamp, and dedup observations', () => {
    const schema = provenanceReceipt();
    schema.data.schema_test.select_succeeded = false;
    expect(() => collectNativeRows1824('cat24', schema)).toThrow('schema SELECT');
    const source = provenanceReceipt();
    source.data.per_path[1].actual!.source_path = 'wrong.md';
    expect(() => collectNativeRows1824('cat24', source)).toThrow('stored provenance');
    const rewrite = provenanceReceipt();
    rewrite.data.preservation_test.after!.source_uri = 'changed';
    expect(() => collectNativeRows1824('cat24', rewrite)).toThrow('stored rewrite snapshots');
    const timestamp = provenanceReceipt();
    timestamp.data.preservation_test.at_after = 'changed';
    expect(() => collectNativeRows1824('cat24', timestamp)).toThrow('timestamp/snapshot');
    const dedup = provenanceReceipt();
    dedup.data.dedup_test.before_rows = 0;
    expect(() => collectNativeRows1824('cat24', dedup)).toThrow('stored dedup counts');
  });
});
