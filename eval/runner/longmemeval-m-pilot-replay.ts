import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { hybridSearch } from 'gbrain/search/hybrid';
import { configureGateway } from 'gbrain/ai/gateway';
import type { SearchResult } from 'gbrain/types';
import { cat36SnapshotHash } from './cat36-snapshot.ts';
import { regressionPackageHash } from './situation-recall-provenance.ts';
import { longMemEvalSources } from './longmemeval-answers.ts';
import { PINNED_SEARCH_CONFIG, classifyErrorOrigin, scoreQuestion, type NdjsonRow, type Question } from './longmemeval.ts';
import { configurePilotC1Gateway, PILOT_CUE_OFF_CONFIG, PILOT_SONNET_MODEL,
  readPilotResolvedConfig, type PilotIndexManifest } from './longmemeval-m-pilot-build.ts';
import { developmentChatOptions } from './situation-recall-development.ts';
import { isDeepStrictEqual } from 'node:util';

const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const normalize = (text: string) => text.replace(/\r\n?/g, '\n').normalize('NFC');
export function pilotQueryErrorDisposition(message: string): 'sut-miss' | 'incomplete' {
  return /guard|budget|billing|approval|reservation|spend|cap.exceed/i.test(message)
    || classifyErrorOrigin(message) !== 'sut' ? 'incomplete' : 'sut-miss';
}
export const pilotSources = (question: Question) => longMemEvalSources(question).map((source, i) =>
  ({ ...source, slug: `${source.slug}-occ-${i}` }));

export interface PilotIndexedEvidence {
  schema_version: 2;
  provenance: 'indexed-projection';
  normalization: 'nfc-lf-v1';
  returned_chunks: Array<{ source_id: 'default'; slug: string; session_id: string; date: string;
    occurrence_index: number; chunk_id: number; chunk_source: string; text: string; text_sha256: string;
    source_sha256: string; raw_alignment: 'exact' | 'whitespace_reflow' | 'nonliteral' | 'ambiguous';
    start: number | null; end: number | null }>;
  strict_raw_grounding: { status: 'available' } | { status: 'unavailable'; reasons: string[] };
}
export type PilotRow = Omit<NdjsonRow, 'evidence'> & { indexed_evidence: PilotIndexedEvidence;
  latency_source: 'mock' | 'live_search' };

export interface PilotReplayOptions {
  indexDir: string;
  productRoot: string;
  expectedProductSha: string;
  expectedPackageSha256: string;
  expectedManifestSha256: string;
  expectedSourceSha256: string;
  workingDatabase: string;
  mode: 'offline' | 'live';
  preparedConfigPath?: string;
}

export function loadPilotIndex(options: PilotReplayOptions): PilotIndexManifest {
  if (!/^[a-f0-9]{40}$/.test(options.expectedProductSha) || !/^[a-f0-9]{64}$/.test(options.expectedPackageSha256)
    || !/^[a-f0-9]{64}$/.test(options.expectedManifestSha256)
    || !/^[a-f0-9]{64}$/.test(options.expectedSourceSha256)) throw new Error('invalid pilot replay identity');
  const root = realpathSync(options.indexDir);
  const bytes = readFileSync(join(root, 'index-manifest.json'));
  if (hash(bytes) !== options.expectedManifestSha256) throw new Error('frozen indexed-projection manifest changed');
  const manifest = JSON.parse(bytes.toString()) as PilotIndexManifest;
  if (manifest.schema_version !== 2 || manifest.evidence_protocol !== 'indexed-projection-v2'
    || manifest.source_sha256 !== options.expectedSourceSha256
    || manifest.product_sha !== options.expectedProductSha || manifest.product_package_sha256 !== options.expectedPackageSha256
    || manifest.embedding_model !== 'openrouter:openai/text-embedding-3-large' || manifest.embedding_dimensions !== 1536
    || JSON.stringify(manifest.search_config) !== JSON.stringify(PINNED_SEARCH_CONFIG)
    || !['off', 'on'].includes(manifest.cue_mode)
    || (manifest.cue_mode === 'off' && (JSON.stringify(manifest.cue_config) !== JSON.stringify(PILOT_CUE_OFF_CONFIG)
      || manifest.cue_hook !== 'off' || manifest.cue_readback !== undefined))
    || (manifest.cue_mode === 'on' && (manifest.cue_hook !== 'external-reviewed'
      || manifest.cue_readback?.status !== 'uncalibrated-diagnostic'
      || manifest.cue_readback.min_similarity !== -1 || manifest.cue_readback.weight !== 0.25
      || !manifest.cue_readback.embedding_signature
      || JSON.stringify(manifest.cue_config) !== JSON.stringify({ ...PILOT_CUE_OFF_CONFIG,
        'memory.cues.read': 'on', 'memory.cues.sources': '["default"]', 'memory.cues.families': '["horizon","scene"]',
        'memory.cues.min_similarity': '-1', 'memory.cues.weight': '0.25',
        'memory.cues.read_calibration_signature': manifest.cue_readback.embedding_signature })))
    || (manifest.cue_mode === 'on' && (manifest.resolved_config?.chat_model !== PILOT_SONNET_MODEL
      || !isDeepStrictEqual(manifest.resolved_config.provider_chat_options, developmentChatOptions(PILOT_SONNET_MODEL))))
    || (manifest.cue_mode === 'on' && !options.preparedConfigPath)
    || (manifest.cue_mode === 'off' && options.preparedConfigPath !== undefined)
    || !manifest.resolved_config
    || manifest.mode !== options.mode || manifest.index_snapshot.path !== 'index') {
    throw new Error('pilot source, product, configuration or cue-mode mismatch');
  }
  const product = realpathSync(resolve(options.productRoot));
  if (regressionPackageHash(product) !== manifest.product_package_sha256
    || ['gbrain/pglite-engine', 'gbrain/search/hybrid', 'gbrain/ai/gateway'].some(specifier =>
      !realpathSync(fileURLToPath(import.meta.resolve(specifier))).startsWith(product + '/'))) {
    throw new Error('loaded product changed or resolves outside verified package');
  }
  const index = realpathSync(join(root, manifest.index_snapshot.path));
  if (!index.startsWith(root + '/') || cat36SnapshotHash(index) !== manifest.index_snapshot.sha256) throw new Error('frozen pilot index changed');
  if (!Array.isArray(manifest.sources) || !manifest.sources.length || new Set(manifest.sources.map(s => s.slug)).size !== manifest.sources.length) {
    throw new Error('ambiguous pilot source mapping');
  }
  const ids = manifest.sources.flatMap(source => source.chunks.map(chunk => chunk.id));
  if (new Set(ids).size !== ids.length) throw new Error('ambiguous pilot chunk mapping');
  return manifest;
}

export function validatePilotSourceMap(question: Question, manifest: PilotIndexManifest): void {
  const sources = pilotSources(question);
  if (sources.length !== manifest.sources.length) throw new Error('question history differs from frozen index');
  const ids = new Set<number>();
  for (const [i, source] of sources.entries()) {
    const frozen = manifest.sources[i];
    if (!frozen || frozen.slug !== source.slug || frozen.session_id !== source.session_id
      || frozen.date !== question.haystack_dates?.[i] || frozen.occurrence_index !== i || frozen.text_sha256 !== hash(source.text)) {
      throw new Error('question source occurrence, date or content differs from frozen index');
    }
    const collapsed = source.text.replace(/\s+/g, ' ');
    for (const chunk of frozen.chunks) {
      if (!Number.isInteger(chunk.id) || ids.has(chunk.id) || typeof chunk.text !== 'string' || !chunk.text
        || chunk.text !== normalize(chunk.text) || hash(chunk.text) !== chunk.text_sha256
        || !['compiled_truth', 'timeline', 'fenced_code'].includes(chunk.chunk_source)) throw new Error('unverifiable frozen indexed chunk');
      ids.add(chunk.id);
      const first = source.text.indexOf(chunk.text);
      const expected = first >= 0 ? source.text.indexOf(chunk.text, first + 1) < 0 ? 'exact' : 'ambiguous'
        : collapsed.includes(chunk.text.replace(/\s+/g, ' ')) ? 'whitespace_reflow' : 'nonliteral';
      if (chunk.raw_alignment !== expected || chunk.start !== (expected === 'exact' ? first : null)
        || chunk.end !== (expected === 'exact' ? first + chunk.text.length : null)) {
        throw new Error('invented raw source offset or alignment');
      }
    }
  }
}

export function scorePilotResults(question: Question, manifest: PilotIndexManifest, results: SearchResult[]): PilotRow {
  validatePilotSourceMap(question, manifest);
  if (results.length > 5) throw new Error('pilot retrieval expanded beyond native five chunks');
  const bySlug = new Map(manifest.sources.map(s => [s.slug, s]));
  const returned = results.map(result => {
    const source = bySlug.get(result.slug);
    const chunk = source?.chunks.find(c => c.id === result.chunk_id);
    const text = normalize(result.chunk_text);
    if ((result.source_id ?? 'default') !== 'default' || !source || !chunk || text !== chunk.text
      || hash(text) !== chunk.text_sha256 || result.chunk_source !== chunk.chunk_source) {
      throw new Error('foreign or altered chunk returned by pilot retrieval');
    }
    return { source_id: 'default' as const, slug: source.slug, session_id: source.session_id, date: source.date,
      occurrence_index: source.occurrence_index, chunk_id: chunk.id, chunk_source: chunk.chunk_source,
      text: chunk.text, text_sha256: chunk.text_sha256, source_sha256: source.text_sha256,
      raw_alignment: chunk.raw_alignment, start: chunk.start, end: chunk.end };
  });
  const retrieved = [...new Set(returned.map(chunk => chunk.session_id))];
  const metrics = scoreQuestion(retrieved, question.answer_session_ids, 5);
  const abs = question.question_id.includes('_abs');
  return { adapter: 'gbrain-hybrid', question_id: question.question_id, question_type: question.question_type, retrieved,
    ground_truth: question.answer_session_ids, hit_at_k: metrics.recall_any === 1,
    ...(abs ? { is_abs: true, abs_noise: metrics.abs_noise }
      : { recall_all: metrics.recall_all, recall_any: metrics.recall_any, ndcg_any: metrics.ndcg_any }),
    num_haystack: manifest.sources.length, latency_ms: 0, latency_source: 'mock', top_k: 5, dataset: 'm-cleaned-pilot',
    indexed_evidence: { schema_version: 2, provenance: 'indexed-projection', normalization: 'nfc-lf-v1', returned_chunks: returned,
      strict_raw_grounding: returned.every(chunk => chunk.raw_alignment === 'exact')
        ? { status: 'available' } : { status: 'unavailable', reasons: [...new Set(returned.filter(chunk => chunk.raw_alignment !== 'exact')
          .map(chunk => chunk.raw_alignment))] } } };
}

export function assertCompletePilotRows(rows: PilotRow[], selectedIds: readonly string[], allowMock = false): void {
  if (selectedIds.length !== 28 || new Set(selectedIds).size !== 28 || rows.length !== 28
    || new Set(rows.map(row => row.question_id)).size !== 28
    || rows.some(row => !selectedIds.includes(row.question_id) || row.adapter !== 'gbrain-hybrid' || row.top_k !== 5
      || row.error_origin === 'harness' || row.error_origin === 'dependency'
      || row.indexed_evidence?.schema_version !== 2 || row.indexed_evidence.returned_chunks.length > 5
      || (!allowMock && (row.latency_source !== 'live_search' || !Number.isFinite(row.latency_ms) || row.latency_ms < 0)))) {
    throw new Error('pilot cell incomplete or infrastructure-excluded; no successful-subset comparison');
  }
}

export async function replayPilotQuestion(question: Question, options: PilotReplayOptions, runtime?: {
  search?(question: string): Promise<SearchResult[]>;
  assertAuthorized?(): Promise<void>;
}): Promise<PilotRow> {
  const manifest = loadPilotIndex(options);
  validatePilotSourceMap(question, manifest);
  if (existsSync(options.workingDatabase)) throw new Error('query database must start fresh');
  const snapshot = join(realpathSync(options.indexDir), 'index');
  cpSync(snapshot, options.workingDatabase, { recursive: true, errorOnExist: true, force: false });
  if (cat36SnapshotHash(options.workingDatabase) !== manifest.index_snapshot.sha256) throw new Error('query database copy changed');
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: options.workingDatabase });
  try {
    if (manifest.cue_mode === 'on') await configurePilotC1Gateway(await import('gbrain/ai/gateway'),
      realpathSync(resolve(options.productRoot)), options.preparedConfigPath!, process.env);
    const resolved = await readPilotResolvedConfig(engine, realpathSync(resolve(options.productRoot)), manifest.cue_mode, manifest.cue_readback);
    if (JSON.stringify(resolved) !== JSON.stringify(manifest.resolved_config)) throw new Error('query resolved configuration differs from frozen construction');
    if (runtime?.search && options.mode !== 'offline') throw new Error('mock retrieval cannot satisfy a live pilot case');
    if (runtime?.search) return scorePilotResults(question, manifest, await runtime.search(question.question));
    if (options.mode !== 'live' || !runtime?.assertAuthorized) throw new Error('live query requires root-owned financial admission');
    await runtime.assertAuthorized();
    if (manifest.cue_mode === 'off') configureGateway({ embedding_model: manifest.embedding_model,
      embedding_dimensions: manifest.embedding_dimensions, env: process.env });
    const started = performance.now();
    let results: SearchResult[];
    try { results = await hybridSearch(engine, question.question, { limit: 5, expansion: false }); }
    catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (pilotQueryErrorDisposition(message) !== 'sut-miss') throw error;
      const abs = question.question_id.includes('_abs');
      return { adapter: 'gbrain-hybrid', question_id: question.question_id, question_type: question.question_type,
        retrieved: [], ground_truth: question.answer_session_ids, hit_at_k: false,
        ...(abs ? { is_abs: true, abs_noise: 0 } : { recall_all: 0, recall_any: 0, ndcg_any: 0 }),
        num_haystack: manifest.sources.length, latency_ms: performance.now() - started, latency_source: 'live_search',
        top_k: 5, dataset: 'm-cleaned-pilot', error: message, error_origin: 'sut',
        indexed_evidence: { schema_version: 2, provenance: 'indexed-projection', normalization: 'nfc-lf-v1', returned_chunks: [],
          strict_raw_grounding: { status: 'unavailable', reasons: ['query-error'] } } };
    }
    const row = scorePilotResults(question, manifest, results);
    row.latency_ms = performance.now() - started;
    row.latency_source = 'live_search';
    return row;
  } finally {
    await engine.disconnect();
  }
}

export async function replayPilotCase(options: PilotReplayOptions & { selectedDatasetPath: string; selectionManifestPath: string;
  questionId: string }, runtime?: Parameters<typeof replayPilotQuestion>[2]): Promise<PilotRow> {
  loadPilotIndex(options);
  const selection = JSON.parse(readFileSync(options.selectionManifestPath, 'utf8'));
  if (!Array.isArray(selection.selected_ids) || selection.selected_ids.length !== 28
    || new Set(selection.selected_ids).size !== 28 || !selection.selected_ids.includes(options.questionId)
    || selection.selected_source_details?.[options.questionId]?.source_sha256 !== options.expectedSourceSha256) {
    throw new Error('case differs from frozen pilot selection');
  }
  const datasetBytes = readFileSync(options.selectedDatasetPath);
  if (hash(datasetBytes) !== selection.selected_dataset?.sha256) throw new Error('selected question artifact changed');
  const questions = JSON.parse(datasetBytes.toString()) as Question[];
  if (!Array.isArray(questions) || questions.length !== 28
    || questions.some((q, i) => q.question_id !== selection.selected_ids[i])) throw new Error('selected question order or count changed');
  return replayPilotQuestion(questions.find(q => q.question_id === options.questionId)!, options, runtime);
}
