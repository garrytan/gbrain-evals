import { percentile } from './metrics.ts';
import { scoreQuery, PROVIDERS_DEFAULT } from './cat18-embedding-providers.ts';
import { CELLS } from './cat18b-embedding-rerank-matrix.ts';
import { CAT24_PROBE_IDS, checkProvenance, type ProvenanceRow } from './cat24-capture-provenance.ts';
import type { ProbeError } from './receipt.ts';
import {
  nativeEvidenceObject, nativeEvidenceRows, nativeFinite, type NativeRegressionObservation,
} from './situation-recall-native.ts';

const CATEGORIES = {
  cat18: 'cat18-embedding-providers',
  cat18b: 'cat18b-embedding-rerank-matrix',
  cat24: 'cat24-capture-provenance',
};

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is not a native ID/string`);
  return value;
}

function ids(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} is missing native IDs`);
  const values = value.map(item => text(item, label));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate native IDs`);
  return values;
}

function count(value: unknown, label: string): number {
  const result = nativeFinite(value, label);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} is not a nonnegative native count`);
  return result;
}

function sameNumber(actual: unknown, expected: number | null, label: string): void {
  if (expected === null ? actual !== null : typeof actual !== 'number' || !Number.isFinite(actual)
    || Math.abs(actual - expected) > 1e-10 * Math.max(1, Math.abs(expected))) {
    throw new Error(`${label} disagrees with native observations`);
  }
}

function sameCount(actual: unknown, expected: number, label: string): void {
  if (count(actual, label) !== expected) throw new Error(`${label} disagrees with native observations`);
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sameIds(left: string[], right: string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((id, index) => id === sortedRight[index]);
}

function readError(value: unknown, label: string): ProbeError {
  const error = nativeEvidenceObject(value, label);
  if (typeof error.origin !== 'string' || !['sut', 'harness', 'dependency', 'judge'].includes(error.origin) || typeof error.message !== 'string') {
    throw new Error(`${label} lacks a typed native error`);
  }
  return { probe_id: text(error.probe_id, label), origin: error.origin as ProbeError['origin'], message: error.message };
}

function matchingError(value: unknown, probeId: string, errors: Map<string, ProbeError>): ProbeError | undefined {
  const recorded = errors.get(probeId);
  if (value === null && !recorded) return undefined;
  const error = readError(value, probeId);
  if (error.probe_id !== probeId || !recorded || error.origin !== recorded.origin || error.message !== recorded.message) {
    throw new Error(`native error identity/content mismatch: ${probeId}`);
  }
  return error;
}

type CollectedCell = {
  raw: Record<string, unknown>;
  id: string;
  queries: Map<string, { raw: Record<string, unknown>; row: NativeRegressionObservation }>;
};

function queryCells(category: 'cat18' | 'cat18b', data: Record<string, unknown>, errors: Map<string, ProbeError>): NativeRegressionObservation[] {
  const cells: CollectedCell[] = [];
  const knownCells = category === 'cat18' ? PROVIDERS_DEFAULT : CELLS.map(cell => cell.name);
  for (const cell of nativeEvidenceRows(data.cells, `${category}.cells`)) {
    const id = text(cell.cell, 'cell');
    if (!knownCells.includes(id) || cells.some(existing => existing.id === id)) throw new Error(`unknown/duplicate native cell: ${id}`);
    text(cell.embedder, `${id}.embedder`);
    if (count(category === 'cat18' ? cell.dim : cell.embed_dim, `${id}.embedding dimensions`) === 0) throw new Error(`missing native embedding dimensions: ${id}`);
    if (category === 'cat18b' && (id.endsWith('+rerank') ? typeof cell.reranker !== 'string' || !cell.reranker : cell.reranker !== null)) throw new Error(`native reranker axis mismatch: ${id}`);
    const queries: CollectedCell['queries'] = new Map();
    for (const query of nativeEvidenceRows(cell.per_query, `${id}.per_query`)) {
      const queryId = text(query.query_id, `${id}.query_id`);
      const probeId = text(query.probe_id, `${id}.probe_id`);
      if (probeId !== `${id}:${queryId}` || queries.has(queryId)) throw new Error(`duplicate/mismatched native query ID: ${probeId}`);
      const gold = ids(query.relevant_ids, `${probeId}.relevant_ids`);
      const ranked = query.ranked_ids === null ? null : ids(query.ranked_ids, `${probeId}.ranked_ids`);
      const k = count(query.k, `${probeId}.k`);
      if (k !== 10 || (ranked && ranked.length > k)) throw new Error(`native top-k mismatch: ${probeId}`);
      const latency = query.query_ms === null ? null : count(query.query_ms, `${probeId}.query_ms`);
      const error = matchingError(query.error, probeId, errors);
      const row: NativeRegressionObservation = { probe_id: probeId, slices: [id], metrics: {}, contributed: query.scored === true, ...(error ? { error } : {}) };
      if (query.scored === true) {
        if (query.status !== 'scored' || error || !ranked || latency === null || gold.length === 0) throw new Error(`missing successful query evidence: ${probeId}`);
        const score = scoreQuery(ranked, gold, k);
        sameNumber(query.recall_at_10, score.recall, `${probeId}.recall_at_10`);
        sameNumber(query.mrr, score.rr, `${probeId}.mrr`);
        sameCount(query.top1_hit_rate, Number(score.top1), `${probeId}.top1_hit_rate`);
        row.metrics = { recall_at_10: score.recall, mrr: score.rr, top1_hit_rate: Number(score.top1), mean_query_ms: latency, p50_query_ms: latency };
      } else {
        if (query.scored !== false || query.status !== 'error' || !error || error.origin === 'sut') throw new Error(`excluded query lacks native execution failure: ${probeId}`);
        for (const metric of ['recall_at_10', 'mrr', 'top1_hit_rate']) sameNumber(query[metric], null, `${probeId}.${metric}`);
        if (ranked !== null && latency === null) throw new Error(`ranked query lacks measured latency: ${probeId}`);
      }
      queries.set(queryId, { raw: query, row });
    }
    const scored = [...queries.values()].filter(query => query.row.contributed);
    sameCount(cell.queries_total, queries.size, `${id}.queries_total`);
    sameCount(cell.queries_scored, scored.length, `${id}.queries_scored`);
    sameCount(cell.query_errors, queries.size - scored.length, `${id}.query_errors`);
    if (cell.valid !== (scored.length === queries.size)) throw new Error(`native cell validity mismatch: ${id}`);
    for (const metric of ['recall_at_10', 'mrr', 'top1_hit_rate', 'mean_query_ms']) {
      sameNumber(cell[metric], mean(scored.map(query => query.row.metrics[metric] as number)), `${id}.${metric}`);
    }
    sameNumber(cell.p50_query_ms, scored.length ? percentile(scored.map(query => query.raw.query_ms as number), 50) : null, `${id}.p50_query_ms`);
    if (cells.length) {
      const first = cells[0];
      if (!sameIds([...queries.keys()], [...first.queries.keys()])) throw new Error(`native query catalog differs between ${first.id} and ${id}`);
      for (const [queryId, query] of queries) {
        if (!sameIds(query.raw.relevant_ids as string[], first.queries.get(queryId)!.raw.relevant_ids as string[])) throw new Error(`native gold differs across cells: ${queryId}`);
      }
    }
    cells.push({ raw: cell, id, queries });
  }
  if (!cells.length) throw new Error(`${category} has no native cell evidence`);
  sameCount(data.queries, cells[0].queries.size, `${category}.queries`);
  if (category === 'cat18b') {
    const pairs = nativeEvidenceRows(data.pairs, 'cat18b.pairs');
    const paired = new Set<string>();
    for (const pair of pairs) {
      const base = cells.find(cell => cell.id === pair.baseline);
      const reranked = cells.find(cell => cell.id === pair.rerank);
      if (!base || !reranked || base.raw.reranker !== null || typeof reranked.raw.reranker !== 'string'
        || !reranked.id.endsWith('+rerank') || reranked.id !== `${base.id}+rerank` || paired.has(reranked.id)
        || pair.embedder !== base.raw.embedder || base.raw.embedder !== reranked.raw.embedder || base.raw.embed_dim !== reranked.raw.embed_dim) {
        throw new Error('broken or duplicate native reranker pair lookup');
      }
      paired.add(reranked.id);
      for (const [delta, metric] of [['recall_delta', 'recall_at_10'], ['mrr_delta', 'mrr'], ['top1_delta', 'top1_hit_rate']] as const) {
        if (!base.raw.valid || !reranked.raw.valid) {
          sameNumber(pair[delta], null, `${reranked.id}.${delta}`);
          continue;
        }
        const deltas: number[] = [];
        for (const [queryId, query] of reranked.queries) {
          const baseline = base.queries.get(queryId);
          if (!baseline?.row.contributed || !query.row.contributed) throw new Error(`broken native paired query lookup: ${queryId}`);
          const value = (query.row.metrics[metric] as number) - (baseline.row.metrics[metric] as number);
          query.row.metrics[delta] = value;
          deltas.push(value);
        }
        sameNumber(pair[delta], mean(deltas), `${reranked.id}.${delta}`);
      }
    }
    for (const cell of cells) {
      if (cell.raw.reranker !== null && !paired.has(cell.id)) throw new Error(`missing native reranker pair: ${cell.id}`);
    }
  }
  return cells.flatMap(cell => [...cell.queries.values()].map(query => query.row));
}

const PATHS: Record<string, { slug: string; expected: Parameters<typeof checkProvenance>[1] }> = {
  'content-import': { slug: 'inbox/2026-05-23-content-import', expected: { source_kind: 'capture-cli', source_uri: 'file:///tmp/probe.md', ingested_via: 'capture-cli', ingested_at_null: false } },
  'file-import-no-channel-provenance': { slug: 'inbox/2026-05-23-file-import', expected: { source_kind: null, source_uri: null, ingested_via: null, ingested_at_null: true } },
  'op-put-page-local-trusted': { slug: 'inbox/2026-05-23-op-local', expected: { source_kind: 'capture-cli', source_uri: 'stdin', ingested_via: 'capture-cli', ingested_at_null: false } },
  'op-put-page-remote-spoof-override': { slug: 'inbox/2026-05-23-op-remote', expected: { source_kind: 'mcp:put_page', source_uri: null, ingested_via: 'mcp:put_page', ingested_at_null: false } },
};

function provenance(value: unknown, label: string): ProvenanceRow | null {
  if (value === null) return null;
  const row = nativeEvidenceObject(value, label);
  for (const key of ['source_kind', 'source_uri', 'ingested_via', 'source_path']) {
    if (row[key] !== null && typeof row[key] !== 'string') throw new Error(`${label}.${key} missing from provenance snapshot`);
  }
  if (row.ingested_at !== null && !(row.ingested_at instanceof Date) && typeof row.ingested_at !== 'string') throw new Error(`${label}.ingested_at missing from provenance snapshot`);
  return row as unknown as ProvenanceRow;
}

function stamp(row: ProvenanceRow): string {
  return row.ingested_at instanceof Date ? row.ingested_at.toISOString() : String(row.ingested_at);
}

function provenanceRows(data: Record<string, unknown>, errors: Map<string, ProbeError>): NativeRegressionObservation[] {
  const rows = new Map<string, NativeRegressionObservation>();
  const outcomes = new Map<string, Record<string, unknown>>();
  for (const outcome of nativeEvidenceRows(data.per_probe, 'cat24.per_probe')) {
    const id = text(outcome.probe_id, 'cat24.probe_id');
    if (!(CAT24_PROBE_IDS as readonly string[]).includes(id) || rows.has(id)) throw new Error(`unknown/duplicate Cat24 probe: ${id}`);
    const error = matchingError(outcome.error, id, errors);
    if (![0, 1].includes(outcome.score as number) || outcome.pass !== (outcome.score === 1)
      || (outcome.pass ? error !== undefined : error?.origin !== 'sut')) throw new Error(`inconsistent Cat24 outcome: ${id}`);
    rows.set(id, { probe_id: id, slices: Object.hasOwn(PATHS, id) ? [id] : [], metrics: {}, contributed: true, ...(error ? { error } : {}) });
    outcomes.set(id, outcome);
  }
  if (rows.size !== CAT24_PROBE_IDS.length) throw new Error('Cat24 requires all seven recorded probe outcomes');
  const detail = (value: unknown, id: string): Record<string, unknown> => {
    const record = nativeEvidenceObject(value, id);
    const outcome = outcomes.get(id)!;
    if (record.probe_id !== id || record.score !== outcome.score || record.pass !== outcome.pass) throw new Error(`Cat24 detail/outcome mismatch: ${id}`);
    matchingError(record.error, id, errors);
    return record;
  };
  const schemaId = 'provenance-columns-present';
  const schema = detail(data.schema_test, schemaId);
  if (!sameIds(ids(schema.selected_columns, 'schema columns'), ['source_kind', 'source_uri', 'ingested_via', 'ingested_at'])
    || schema.select_succeeded !== schema.pass) throw new Error('Cat24 schema SELECT evidence mismatch');
  rows.get(schemaId)!.metrics.provenance_columns_present = schema.score as number;
  const paths = nativeEvidenceRows(data.per_path, 'cat24.per_path');
  const seenPaths = new Set<string>();
  for (const path of paths) {
    const id = text(path.probe_id, 'path probe');
    if (!Object.hasOwn(PATHS, id) || seenPaths.has(id)) throw new Error(`unknown/duplicate Cat24 path: ${id}`);
    seenPaths.add(id);
    const fixture = PATHS[id];
    const expected = nativeEvidenceObject(path.expected, `${id}.expected`);
    if (path.slug !== fixture.slug || Object.entries(fixture.expected).some(([key, value]) => expected[key] !== value)) throw new Error(`Cat24 path fixture mismatch: ${id}`);
    const actual = provenance(path.actual, `${id}.actual`);
    const pass = checkProvenance(actual, fixture.expected) === null
      && (id !== 'file-import-no-channel-provenance' || actual?.source_path === `${fixture.slug}.md`);
    if (path.pass !== pass || outcomes.get(id)!.pass !== pass || (pass ? path.fail_reason !== null : typeof path.fail_reason !== 'string')) throw new Error(`Cat24 stored provenance contradicts path outcome: ${id}`);
    rows.get(id)!.metrics.provenance_fields_correct = Number(pass);
  }
  if (schema.pass && seenPaths.size !== Object.keys(PATHS).length) throw new Error('Cat24 is missing an observed ingestion path');
  if (!schema.pass) {
    if (paths.length || [...outcomes.values()].some(outcome => outcome.pass)) throw new Error('Cat24 failed schema cannot have successful downstream probes');
    for (const id of Object.keys(PATHS)) rows.get(id)!.metrics.provenance_fields_correct = outcomes.get(id)!.score as number;
  }
  const preservationId = 'provenance-preserved-on-reimport';
  const preservation = detail(data.preservation_test, preservationId);
  const before = provenance(preservation.before, 'preservation.before');
  const after = provenance(preservation.after, 'preservation.after');
  if ((before ? preservation.at_before !== stamp(before) : preservation.at_before !== null)
    || (after ? preservation.at_after !== stamp(after) : ![null, 'undefined'].includes(preservation.at_after as null | string))) throw new Error('Cat24 preservation timestamp/snapshot mismatch');
  const preserved = !!before && before.source_kind === 'capture-cli' && checkProvenance(after, PATHS['content-import'].expected) === null
    && preservation.at_before === preservation.at_after;
  if (preservation.pass !== preserved) throw new Error('Cat24 stored rewrite snapshots contradict preservation outcome');
  rows.get(preservationId)!.metrics.provenance_preserved_on_reimport = preservation.score as number;
  const dedup = nativeEvidenceObject(data.dedup_test, 'cat24.dedup_test');
  const dedupId = 'dedup-hash-short-circuit';
  const dedupRow = rows.get(dedupId)!;
  for (const [native, metric] of [['before_rows', 'before_rows'], ['after_rows', 'after_rows'], ['distinct_page_ids', 'dedup_distinct_page_ids']]) {
    if (dedup[native] === -1 && dedupRow.error) dedupRow.contributed = false;
    else dedupRow.metrics[metric] = count(dedup[native], `dedup.${native}`);
  }
  if (outcomes.get(dedupId)!.pass !== (dedup.before_rows === 1 && dedup.after_rows === 1 && dedup.distinct_page_ids === 1)) throw new Error('Cat24 stored dedup counts contradict outcome');
  return CAT24_PROBE_IDS.map(id => rows.get(id)!);
}

export function collectNativeRows1824(category: 'cat18' | 'cat18b' | 'cat24', artifact: unknown): NativeRegressionObservation[] {
  const receipt = nativeEvidenceObject(artifact, category);
  if (receipt.category !== CATEGORIES[category] || (receipt.run_status !== 'completed' && receipt.run_status !== 'error')) throw new Error(`missing/wrong native receipt for ${category}`);
  const data = nativeEvidenceObject(receipt.data, `${category}.data`);
  const errors = new Map<string, ProbeError>();
  for (const raw of nativeEvidenceRows(receipt.errors, `${category}.errors`)) {
    const error = readError(raw, `${category}.errors`);
    if (errors.has(error.probe_id)) throw new Error(`duplicate native error: ${error.probe_id}`);
    errors.set(error.probe_id, error);
  }
  const rows = category === 'cat24' ? provenanceRows(data, errors) : queryCells(category, data, errors);
  if ([...errors.keys()].some(id => !rows.some(row => row.probe_id === id))) throw new Error('unknown native error probe');
  const scored = category === 'cat24' ? rows.length : rows.filter(row => row.contributed).length;
  sameCount(receipt.n_total, rows.length, `${category}.n_total`);
  sameCount(receipt.n_scored, scored, `${category}.n_scored`);
  sameNumber(receipt.completion_rate, rows.length ? scored / rows.length : 0, `${category}.completion_rate`);
  return rows;
}
