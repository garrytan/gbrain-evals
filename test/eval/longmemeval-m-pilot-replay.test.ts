import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SearchResult } from 'gbrain/types';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { operationsByName } from 'gbrain/operations';
import { buildPilotIndex, configurePilotC1Gateway, PILOT_CUE_OFF_CONFIG, PILOT_SONNET_MODEL,
  readPilotResolvedConfig } from '../../eval/runner/longmemeval-m-pilot-build.ts';
import { developmentChatOptions } from '../../eval/runner/situation-recall-development.ts';
import { assertCompletePilotRows, loadPilotIndex, pilotQueryErrorDisposition, pilotSources, replayPilotCase, replayPilotQuestion, scorePilotResults } from '../../eval/runner/longmemeval-m-pilot-replay.ts';
import { loadLmeAnswerReplay } from '../../eval/runner/longmemeval-answers.ts';
import { regressionPackageHash } from '../../eval/runner/situation-recall-provenance.ts';
import { PINNED_SEARCH_CONFIG, type Question } from '../../eval/runner/longmemeval.ts';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const productRoot = resolve(import.meta.dir, '../../node_modules/gbrain');
const productHash = regressionPackageHash(productRoot);
const baseline604 = productHash === '78bbe78af2fac33a278740e84877e9c6c9f7a0f6a161113b1240549adf993b2b';
const productSha = baseline604 ? '6040075c6cb95be5881cc2e1b76ef7d71f4e5d29'
  : JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')).dependencies.gbrain.split('#')[1];
const turns = [{ role: 'user' as const, content: 'The sample project used a blue label.' },
  { role: 'assistant' as const, content: 'I will keep that detail in mind.' }];
const dates = ['2023/05/28 (Sun) 05:21', '2023/05/28 (Sun) 00:46'];
const question: Question = { question_id: 'pilot-test-1', question_type: 'single-session-user',
  question: 'Which label did the sample project use?', answer: 'blue', answer_session_ids: ['repeat-id'],
  haystack_session_ids: ['repeat-id', 'repeat-id'], haystack_dates: dates,
  haystack_sessions: [turns, turns] };

describe('source-only LongMemEval-M pilot snapshot and replay', () => {
  let directory: string;
  let sourceHash: string;
  let manifestHash: string;
  let previousFetch: typeof globalThis.fetch;
  let manifest: Awaited<ReturnType<typeof buildPilotIndex>>;
  const options = () => ({ indexDir: join(directory, 'build'), productRoot, expectedProductSha: productSha,
    expectedPackageSha256: productHash, expectedSourceSha256: sourceHash, expectedManifestSha256: manifestHash,
    workingDatabase: join(directory, `replay-${crypto.randomUUID()}`), mode: 'offline' as const });
  const result = () => {
    const source = pilotSources(question)[1];
    const chunk = manifest.sources[1].chunks[0];
    return [{ source_id: 'default', slug: source.slug, chunk_id: chunk.id,
      chunk_source: chunk.chunk_source, chunk_text: chunk.text } as SearchResult];
  };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'lme-m-pilot-'));
    const source = dates.map((date, occurrence_index) => ({ occurrence_index, session_id: 'repeat-id', date, turns }));
    const path = join(directory, 'source-only.json');
    writeFileSync(path, JSON.stringify(source) + '\n');
    sourceHash = hash(readFileSync(path));
    previousFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('network forbidden in keyless pilot test'); }) as unknown as typeof fetch;
    manifest = await buildPilotIndex({ sourcePath: path, expectedSourceSha256: sourceHash, productRoot,
      expectedProductSha: productSha, expectedPackageSha256: productHash,
      embeddingModel: 'openrouter:openai/text-embedding-3-large', embeddingDimensions: 1536,
      outputDir: join(directory, 'build'), mode: 'offline' });
    manifestHash = hash(readFileSync(join(directory, 'build/index-manifest.json')));
  });
  afterAll(() => { globalThis.fetch = previousFetch; if (directory) rmSync(directory, { recursive: true, force: true }); });

  test('seals two dated occurrences with distinct slugs before reading a question', async () => {
    expect(manifest.sources).toHaveLength(2);
    expect(manifest.sources.map(s => s.slug)).toEqual(['chat/repeat-id-occ-0', 'chat/repeat-id-occ-1']);
    expect(manifest.sources.map(s => s.date)).toEqual(dates);
    expect(manifest.cue_hook).toBe('off');
    expect(loadPilotIndex(options()).index_snapshot.sha256).toBe(manifest.index_snapshot.sha256);
    const row = await replayPilotQuestion(question, options(), { search: async () => result() });
    expect(row.recall_all).toBe(1);
    expect(row.retrieved).toEqual(['repeat-id']);
    expect(row.indexed_evidence.returned_chunks[0].slug).toBe('chat/repeat-id-occ-1');
    expect(row.indexed_evidence.returned_chunks[0].session_id).toBe('repeat-id');
    expect(row.indexed_evidence.returned_chunks[0].start).toBeGreaterThanOrEqual(0);
    expect(row.latency_source).toBe('mock');
    expect(row.latency_ms).toBe(0);
    expect(manifest.construction_ms).toBeGreaterThan(0);
    if (baseline604) {
      expect(manifest.resolved_config.cues).toEqual({ capability: 'absent-in-verified-baseline-604' });
    } else {
      expect(manifest.resolved_config.cues.readMode).toBe('off');
    }
    expect(manifest.resolved_config.search.reranker_enabled).toBe(false);
    const first = manifest.sources[0].chunks[0];
    const repeated = scorePilotResults(question, manifest, [{ ...result()[0], slug: manifest.sources[0].slug, chunk_id: first.id,
      chunk_source: first.chunk_source as SearchResult['chunk_source'], chunk_text: first.text }, ...result()]);
    expect(repeated.retrieved).toEqual(['repeat-id']);
    expect(repeated.indexed_evidence.returned_chunks).toHaveLength(2);
  });

  test('rejects foreign, altered and over-five results before scoring', () => {
    expect(() => scorePilotResults(question, manifest, [{ ...result()[0], slug: 'chat/unknown' }])).toThrow();
    expect(() => scorePilotResults(question, manifest, [{ ...result()[0], chunk_id: -1 }])).toThrow();
    expect(() => scorePilotResults(question, manifest, [{ ...result()[0], source_id: 'foreign' }])).toThrow();
    expect(() => scorePilotResults(question, manifest, [{ ...result()[0], chunk_text: 'invented evidence' }])).toThrow();
    expect(() => scorePilotResults(question, manifest, Array.from({ length: 6 }, () => result()[0]))).toThrow();
    expect(() => scorePilotResults({ ...question, haystack_dates: [...dates].reverse() }, manifest, result())).toThrow();
    expect(scorePilotResults({ ...question, answer_session_ids: ['missing'] }, manifest, result()).recall_all).toBe(0);
  });

  test('retains all four indexed alignment classes and blocks strict raw grounding on nulls', () => {
    const q: Question = { ...question, haystack_session_ids: ['sample'], haystack_dates: [dates[0]],
      haystack_sessions: [[{ role: 'user', content: 'alpha \n beta alpha' }]], answer_session_ids: ['sample'] };
    const source = pilotSources(q)[0];
    const values = [
      { text: 'beta', raw_alignment: 'exact' as const, start: source.text.indexOf('beta'), end: source.text.indexOf('beta') + 4 },
      { text: 'alpha beta', raw_alignment: 'whitespace_reflow' as const, start: null, end: null },
      { text: 'structured header alpha', raw_alignment: 'nonliteral' as const, start: null, end: null },
      { text: 'alpha', raw_alignment: 'ambiguous' as const, start: null, end: null },
    ];
    const chunks = values.map((v, i) => ({ ...v, id: i + 1, text_sha256: hash(v.text), chunk_source: 'compiled_truth' as const }));
    const frozen = { ...manifest, sources: [{ slug: source.slug, session_id: source.session_id, date: dates[0],
      occurrence_index: 0, text_sha256: hash(source.text), chunks }] };
    const results = chunks.map(chunk => ({ source_id: 'default', slug: source.slug, chunk_id: chunk.id,
      chunk_source: 'compiled_truth', chunk_text: chunk.text } as SearchResult));
    const row = scorePilotResults(q, frozen, results);
    expect(row.recall_all).toBe(1);
    expect(row.indexed_evidence.returned_chunks.map(chunk => chunk.raw_alignment)).toEqual(values.map(v => v.raw_alignment));
    expect(row.indexed_evidence.returned_chunks.map(chunk => chunk.start)).toEqual([values[0].start, null, null, null]);
    expect(row.indexed_evidence.strict_raw_grounding).toEqual({ status: 'unavailable', reasons: ['whitespace_reflow', 'nonliteral', 'ambiguous'] });
    expect(scorePilotResults(q, frozen, results.slice(0, 1)).indexed_evidence.strict_raw_grounding).toEqual({ status: 'available' });
    expect(() => scorePilotResults(q, { ...frozen, sources: [{ ...frozen.sources[0], chunks: chunks.map((c, i) => i ? c : { ...c, start: 0 }) }] }, results)).toThrow();
  });

  test('rejects changed source, product, configuration and closed snapshot', async () => {
    expect(() => loadPilotIndex({ ...options(), expectedSourceSha256: '0'.repeat(64) })).toThrow();
    expect(() => loadPilotIndex({ ...options(), expectedPackageSha256: '0'.repeat(64) })).toThrow();
    const path = join(directory, 'build/index-manifest.json');
    const original = readFileSync(path);
    try {
      writeFileSync(path, JSON.stringify({ ...manifest, embedding_dimensions: 1024 }));
      expect(() => loadPilotIndex(options())).toThrow();
    } finally { writeFileSync(path, original); }
    try {
      const duplicate = { ...manifest, sources: [{ ...manifest.sources[0] }, { ...manifest.sources[1], slug: manifest.sources[0].slug }] };
      writeFileSync(path, JSON.stringify(duplicate));
      expect(() => loadPilotIndex({ ...options(), expectedManifestSha256: hash(readFileSync(path)) })).toThrow('ambiguous pilot source mapping');
    } finally { writeFileSync(path, original); }
    const indexPath = join(directory, 'build/index');
    writeFileSync(join(indexPath, 'tampered'), 'changed');
    expect(() => loadPilotIndex(options())).toThrow();
    rmSync(join(indexPath, 'tampered'));
    expect(() => loadPilotIndex({ ...options(), expectedManifestSha256: '0'.repeat(64) })).toThrow();
    try {
      writeFileSync(path, JSON.stringify({ ...manifest, resolved_config: { ...manifest.resolved_config,
        search: { ...manifest.resolved_config.search, reranker_enabled: true } } }));
      const changed = { ...options(), expectedManifestSha256: hash(readFileSync(path)) };
      await expect(replayPilotQuestion(question, changed, { search: async () => result() })).rejects.toThrow('query resolved configuration differs');
    } finally { writeFileSync(path, original); }
  });

  test('C1 cannot claim a cue-on snapshot without a complete guarded build', async () => {
    const path = join(directory, 'build/index-manifest.json');
    const original = readFileSync(path);
    try {
      writeFileSync(path, JSON.stringify({ ...manifest, cue_mode: 'on', cue_hook: 'external-reviewed' }));
      expect(() => loadPilotIndex({ ...options(), expectedManifestSha256: hash(readFileSync(path)) })).toThrow();
    } finally { writeFileSync(path, original); }
    await expect(readPilotResolvedConfig({ getConfig: async () => null }, productRoot, 'on'))
      .rejects.toThrow('uncalibrated diagnostic');
    await expect(buildPilotIndex({ sourcePath: join(directory, 'source-only.json'), expectedSourceSha256: sourceHash,
      productRoot, expectedProductSha: productSha, expectedPackageSha256: productHash,
      embeddingModel: 'openrouter:openai/text-embedding-3-large', embeddingDimensions: 1536,
      outputDir: join(directory, 'unadmitted-c1'), mode: 'offline', cueMode: 'on' }))
      .rejects.toThrow('live guarded construction');
  });

  test.skipIf(baseline604)('uncalibrated cue-on diagnostic still requires current product embedding signature', async () => {
    const previous = { HOME: process.env.HOME, GBRAIN_HOME: process.env.GBRAIN_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    const home = join(directory, 'cue-config-home');
    process.env.HOME = home; process.env.GBRAIN_HOME = home; process.env.XDG_CONFIG_HOME = join(home, '.config');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const preparedConfigPath = join(home, '.gbrain', 'config.json');
    writeFileSync(preparedConfigPath, JSON.stringify({ engine: 'pglite', embedding_model: 'openrouter:openai/text-embedding-3-large',
      embedding_dimensions: 1536, chat_model: PILOT_SONNET_MODEL,
      provider_chat_options: developmentChatOptions(PILOT_SONNET_MODEL), database_path: join(directory, 'cue-config-test') }) + '\n');
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: join(directory, 'cue-config-test') });
    try {
      await configurePilotC1Gateway(await import('gbrain/ai/gateway'), productRoot, preparedConfigPath, process.env);
      await engine.initSchema();
      for (const [key, value] of Object.entries({ ...PINNED_SEARCH_CONFIG, ...PILOT_CUE_OFF_CONFIG,
        embedding_model: 'openrouter:openai/text-embedding-3-large', embedding_dimensions: '1536' })) await engine.setConfig(key, value);
      await engine.setConfig('chat_model', PILOT_SONNET_MODEL);
      const { cueSignature, memoryCueColumn } = await import('gbrain/memory-cues');
      const signature = cueSignature(await memoryCueColumn(engine));
      await operationsByName.memory_cues.handler({ engine, config: { engine: 'pglite', embedding_model: 'openrouter:openai/text-embedding-3-large',
        embedding_dimensions: 1536 }, sourceId: 'default', remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } }, { action: 'configure', source_ids: ['default'], generation_enabled: false,
        read_mode: 'on', push_enabled: false, families: ['scene', 'horizon'], min_similarity: -1, weight: 0.25, apply: true });
      const resolved = await readPilotResolvedConfig(engine, productRoot, 'on', {
        status: 'uncalibrated-diagnostic', min_similarity: -1, weight: 0.25, embedding_signature: signature });
      expect(resolved.cues.readMode).toBe('on');
      expect(resolved.cues.minSimilarity).toBe(-1);
      expect(await engine.getConfig('memory.cues.families')).toBe('["horizon","scene"]');
      await engine.setConfig('memory.cues.read_calibration_signature', 'stale');
      await expect(readPilotResolvedConfig(engine, productRoot, 'on', {
        status: 'uncalibrated-diagnostic', min_similarity: -1, weight: 0.25, embedding_signature: signature })).rejects.toThrow();
    } finally {
      await engine.disconnect();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('requires all 28 distinct outcomes and does not pass infra exclusions', () => {
    const ids = Array.from({ length: 28 }, (_, i) => `id-${i}`);
    const rows = ids.map(question_id => ({ ...scorePilotResults(question, manifest, result()), question_id }));
    expect(() => assertCompletePilotRows(rows, ids)).toThrow('incomplete');
    expect(() => assertCompletePilotRows(rows, ids, true)).not.toThrow();
    const unavailable = rows.map((row, i) => i ? row : { ...row, indexed_evidence: {
      ...row.indexed_evidence, returned_chunks: row.indexed_evidence.returned_chunks.map(chunk => ({ ...chunk,
        raw_alignment: 'nonliteral' as const, start: null, end: null })),
      strict_raw_grounding: { status: 'unavailable' as const, reasons: ['nonliteral'] } } });
    expect(() => assertCompletePilotRows(unavailable, ids, true)).not.toThrow();
    expect(() => assertCompletePilotRows(rows.slice(1), ids, true)).toThrow();
    expect(() => assertCompletePilotRows([...rows.slice(1), rows[1]], ids, true)).toThrow();
    expect(() => assertCompletePilotRows(rows.map((row, i) => i ? row : { ...row, error_origin: 'harness' as const }), ids, true)).toThrow();
    expect(() => assertCompletePilotRows(rows.map((row, i) => i ? row : { ...row, indexed_evidence: undefined as any }), ids, true)).toThrow();
  });

  test('types attempted SUT failures as misses, but guard and dependency failures as incomplete', () => {
    expect(pilotQueryErrorDisposition('PGLite query failed: missing relation')).toBe('sut-miss');
    expect(pilotQueryErrorDisposition('guard budget exhausted')).toBe('incomplete');
    expect(pilotQueryErrorDisposition('provider HTTP 429')).toBe('incomplete');
  });

  test('checks the closed snapshot before reading the 28-case question artifact', async () => {
    const selected = Array.from({ length: 28 }, (_, i) => ({ ...question, question_id: `pilot-${i}` }));
    const datasetPath = join(directory, 'selected.json');
    writeFileSync(datasetPath, JSON.stringify(selected));
    const ids = selected.map(q => q.question_id);
    const selectionPath = join(directory, 'selection.json');
    writeFileSync(selectionPath, JSON.stringify({ selected_ids: ids,
      selected_dataset: { sha256: hash(readFileSync(datasetPath)) },
      selected_source_details: Object.fromEntries(ids.map(id => [id, { source_sha256: sourceHash }])) }));
    const caseOptions = { ...options(), selectedDatasetPath: datasetPath, selectionManifestPath: selectionPath, questionId: 'pilot-0' };
    const row = await replayPilotCase(caseOptions, { search: async () => result() });
    expect(row.question_id).toBe('pilot-0');
    expect(row.recall_all).toBe(1);
    const badIndex = { ...caseOptions, indexDir: join(directory, 'absent-index'), selectedDatasetPath: join(directory, 'absent-questions') };
    await expect(replayPilotCase(badIndex, { search: async () => result() })).rejects.toThrow('ENOENT');
  });

  test('source builder rejects scoring labels and unguarded live work', async () => {
    const path = join(directory, 'poisoned.json');
    const original = JSON.parse(readFileSync(join(directory, 'source-only.json'), 'utf8'));
    original[0].turns[0].has_answer = true;
    writeFileSync(path, JSON.stringify(original) + '\n');
    const base = { sourcePath: path, expectedSourceSha256: hash(readFileSync(path)), productRoot,
      expectedProductSha: 'e51e21c076dd63e6e5948303eb2c355ddba21da4', expectedPackageSha256: productHash,
      embeddingModel: 'openrouter:openai/text-embedding-3-large', embeddingDimensions: 1536 };
    await expect(buildPilotIndex({ ...base, outputDir: join(directory, 'poisoned-build'), mode: 'offline' })).rejects.toThrow('invalid source-only occurrence');
    await expect(buildPilotIndex({ ...base, outputDir: join(directory, 'unguarded-build'), mode: 'live' })).rejects.toThrow('financial admission');
  });

  test('v1 strict answer loader rejects indexed-projection capture', () => {
    const datasetPath = join(directory, 'legacy-dataset.json'), rowsPath = join(directory, 'indexed-row.ndjson'), receiptPath = join(directory, 'indexed-receipt.json');
    writeFileSync(datasetPath, JSON.stringify([question]));
    writeFileSync(rowsPath, JSON.stringify(scorePilotResults(question, manifest, result())) + '\n');
    const timestamp = new Date().toISOString();
    writeFileSync(receiptPath, JSON.stringify({ schema_version: 1, benchmark_version: '0.5.0', category: 'longmemeval',
      run_status: 'completed', verdict: 'pass', n_total: 1, n_scored: 1, completion_rate: 1,
      publishable: false, gbrain_version: 'test', gbrain_pin: 'test', errors: [], started_at: timestamp, finished_at: timestamp,
      resolved_config: { evidence_capture: { schema_version: 2, provenance: 'indexed-projection' } } }));
    expect(() => loadLmeAnswerReplay({ datasetPath, rowsPath, receiptPath, adapter: 'gbrain-hybrid' })).toThrow('retained native evidence is required');
  });
});
