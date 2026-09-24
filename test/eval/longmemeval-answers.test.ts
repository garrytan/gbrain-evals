import { afterEach, describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SearchResult } from 'gbrain/types';
import type { ChatResult } from 'gbrain/ai/gateway';
import { ADAPTER_SPECS, buildRunConfigPreimage, normalizeSessions, parseOpts, renderSession, run, runConfigHash, scoreQuestion, summarizeAdapterRows, type NdjsonRow, type Question } from '../../eval/runner/longmemeval.ts';
import { createLmeCapture, lmeArtifactHash, loadLmeAnswerReplay, longMemEvalSources, retainLmeEvidence, runLongMemEvalAnswers, validateLmeAnswerProfile, type LmeAnswerInput, type LmeAnswerProfile, type LmeAnswerQuestion } from '../../eval/runner/longmemeval-answers.ts';
import { BENCHMARK_VERSION, loadReceipt, writeReceipt } from '../../eval/runner/receipt.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

test('retained-evidence CLI rejection never overwrites an existing receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'lme-existing-receipt-')); roots.push(root);
  const reports = join(root, 'reports');
  mkdirSync(join(reports, 'longmemeval'), { recursive: true });
  const path = join(reports, 'longmemeval', 'receipt.json');
  const original = '{"sentinel":"existing measurement must survive"}\n';
  writeFileSync(path, original);
  const child = Bun.spawnSync([process.execPath, 'eval/runner/longmemeval.ts', '--retain-evidence',
    '--path', join(root, 'absent-dataset.json'), '--ndjson', join(root, 'rows.ndjson'),
    '--output', join(root, 'result.json'), '--reports-dir', reports],
  { cwd: process.cwd(), timeout: 15000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain('fresh, distinct');
  expect(child.stderr.toString()).toContain('existing receipt preserved');
  expect(readFileSync(path, 'utf8')).toBe(original);
});
const questions: LmeAnswerQuestion[] = [
  { question_id: 'synthetic-location', question_type: 'single-session-user', question: 'Where did the volunteer put the blue umbrella?', answer: 'In the hall cupboard. REFERENCE_ONLY_SENTINEL',
    haystack_session_ids: ['Session_One', 'Session_Two'], haystack_dates: ['2025-01-01', '2025-01-02'],
    haystack_sessions: [[{ role: 'user', content: '☂️ Café notes. The blue umbrella is in the hallway closet.', has_answer: true }], [{ role: 'user', content: 'UNRETURNED_SESSION_SENTINEL: The red umbrella was donated.' }]] as Question['haystack_sessions'], answer_session_ids: ['Session_One'] },
  { question_id: 'synthetic-color_abs', question_type: 'single-session-user', question: 'What color was the volunteer bicycle?', answer: 'The bicycle color was never stated.',
    haystack_sessions: [{ session_id: 'other-conversation', turns: [{ role: 'user', content: 'The volunteer repaired an umbrella.' }] }], answer_session_ids: ['removed-session'] },
  { question_id: 'synthetic-count', question_type: 'multi-session', question: 'How many cartons did the helper carry?', answer: 7,
    haystack_sessions: [{ session_id: 'cartons', turns: [{ role: 'user', content: 'The helper carried seven cartons.' }] }], answer_session_ids: ['cartons'] },
];
const questionData = JSON.stringify(questions);
const config = buildRunConfigPreimage(ADAPTER_SPECS.keyword, { datasetName: 'synthetic-test', topK: 1, overfetchFactor: 3 }, { embeddingModel: null, embeddingDims: null, expansionModel: null });

function searchResult(q: LmeAnswerQuestion): SearchResult {
  const source = longMemEvalSources(q)[0];
  const text = q.question_id === 'synthetic-location' ? 'The blue umbrella is in the hallway closet.' : source.text.slice(source.text.indexOf('**user:**'));
  return { source_id: 'default', slug: source.slug, chunk_text: text, chunk_index: 0, chunk_id: 1, page_id: 1, score: 1 } as SearchResult;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lme-answer-test-')); roots.push(root);
  const datasetPath = join(root, 'dataset.json'), rowsPath = join(root, 'rows.ndjson'), receiptPath = join(root, 'primary.json');
  writeFileSync(datasetPath, questionData);
  const capture = createLmeCapture(Buffer.from(questionData), questions as Question[], ['gbrain-keyword']);
  capture.run_config_preimages = { 'gbrain-keyword': config };
  const rows: NdjsonRow[] = questions.map(q => {
    const result = searchResult(q), retrieved = [result.slug.slice(5)];
    const m = scoreQuestion(retrieved, q.answer_session_ids, 1);
    return { adapter: 'gbrain-keyword', question_id: q.question_id, question_type: q.question_type, retrieved, ground_truth: q.answer_session_ids, hit_at_k: m.recall_any === 1,
      num_haystack: q.haystack_sessions.length, latency_ms: 1, top_k: 1, dataset: 'synthetic-test', run_config_hash: runConfigHash(config),
      evidence: retainLmeEvidence(q as Question, [result], ADAPTER_SPECS.keyword, 1, retrieved) };
  });
  const bytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n'; writeFileSync(rowsPath, bytes);
  writeReceipt(receiptPath, { schema_version: 1, benchmark_version: BENCHMARK_VERSION, category: 'longmemeval', run_status: 'completed', verdict: 'pass', n_total: 3, n_scored: 3, completion_rate: 1,
    errors: [], publishable: false, gbrain_pin: capture.product.declared_pin, gbrain_version: capture.product.package_version, started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z',
    hashes: { dataset: digest(questionData), evidence_rows: digest(bytes) }, resolved_config: { evidence_capture: capture } });
  const profile: LmeAnswerProfile = { mode: 'offline', adapter: 'gbrain-keyword', dataset_sha256: capture.dataset_sha256, rows_sha256: digest(bytes), source_manifest_sha256: capture.source_manifest_sha256,
    retrieval_config_sha256: runConfigHash(config), answer_model: 'test:answer', judge_model: 'claude-haiku-4-5-20251001', answer_max_tokens: 128, judge_max_tokens: 128 };
  return { root, datasetPath, rowsPath, receiptPath, profile, outputDir: join(root, 'answer-output') };
}

function answer(): ChatResult {
  return { text: 'SCRIPTED_ANSWER', blocks: [{ type: 'text', text: 'SCRIPTED_ANSWER' }], model: 'test:answer', providerId: 'test', stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 } };
}
function judgeResponse(malformed = false): Anthropic.Messages.Message {
  return { id: 'synthetic-judge', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_reason: 'tool_use', stop_sequence: null,
    content: malformed ? [{ type: 'text', text: 'Malformed output' }] : [{ type: 'tool_use', id: 'score', name: 'score_answer', input: { verdict: 'pass', overall_rationale: 'Scripted plumbing result only.',
      scores: ['grounding', 'answer_or_abstention'].map(criterion_id => ({ criterion_id, score: 5, rationale: 'Synthetic stub, not relevance evidence.' })) } }],
    usage: { input_tokens: 10, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as Anthropic.Messages.Message;
}
const client = (create = async (_request: unknown) => judgeResponse()) => ({ messages: { create } }) as unknown as Anthropic;

function changeRows(f: ReturnType<typeof fixture>, edit: (rows: NdjsonRow[]) => void) {
  const rows = readFileSync(f.rowsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as NdjsonRow); edit(rows);
  const bytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n'; writeFileSync(f.rowsPath, bytes);
  const receipt = loadReceipt(f.receiptPath); receipt.hashes!.evidence_rows = digest(bytes); writeReceipt(f.receiptPath, receipt);
  f.profile.rows_sha256 = digest(bytes);
}

describe('LongMemEval retained evidence and secondary grounding', () => {
  test('source rendering matches the existing producer and drops per-turn answer labels', () => {
    for (const q of questions) expect(longMemEvalSources(q).map(s => s.text)).toEqual(normalizeSessions(q as Question).map(s => renderSession(s).replace(/\r\n?/g, '\n').normalize('NFC')));
    expect(JSON.stringify(longMemEvalSources(questions[0]))).not.toContain('has_answer');
    expect(parseOpts([]).retainEvidence).toBeUndefined();
    expect(parseOpts(['--retain-evidence']).retainEvidence).toBe(true);
  });

  test('session diversity retains native chunks but gives the reader only one actually returned chunk per selected session', () => {
    const q = questions[0] as Question, first = searchResult(questions[0]), source2 = longMemEvalSources(q)[1];
    const results = [first, { ...first, chunk_id: 2 }, { ...first, slug: source2.slug, chunk_id: 3, chunk_text: source2.text }];
    const captured = retainLmeEvidence(q, results, { sessdiv: true }, 2, ['session_one', 'session_two']);
    expect(captured.returned_chunks).toHaveLength(3);
    expect(captured.answer_chunk_indices).toEqual([0, 2]);
    expect(captured.returned_chunks[0].text).toBe(first.chunk_text);
    expect(captured.returned_chunks[0].text).not.toBe(longMemEvalSources(q)[0].text);
    expect(retainLmeEvidence(q, results.slice(0, 2), { sessdiv: false }, 2, ['session_one']).answer_chunk_indices).toEqual([0, 1]);
  });

  test('generation sees only actual excerpts; reference and session labels reach only the judge', async () => {
    const f = fixture(), inputs: LmeAnswerInput[] = [], judgeInputs: unknown[] = [];
    const before = [f.datasetPath, f.rowsPath, f.receiptPath].map(path => digest(readFileSync(path)));
    const result = await runLongMemEvalAnswers({ ...f, testRuntime: { async generate(input) { inputs.push(input); return answer(); }, judgeClient: client(async request => { judgeInputs.push(request); return judgeResponse(); }) } });
    expect(inputs).toHaveLength(3);
    expect(Object.keys(inputs[0]).sort()).toEqual(['evidence', 'question']);
    expect(Object.keys(inputs[0].evidence[0]).sort()).toEqual(['slug', 'source_id', 'text']);
    expect(inputs[0].evidence[0].text).toBe(searchResult(questions[0]).chunk_text);
    for (const sentinel of ['REFERENCE_ONLY_SENTINEL', 'UNRETURNED_SESSION_SENTINEL', 'answer_session_ids', 'question_type', 'has_answer']) expect(JSON.stringify(inputs)).not.toContain(sentinel);
    expect(JSON.stringify(judgeInputs[0])).toContain('REFERENCE_ONLY_SENTINEL');
    expect(JSON.stringify(judgeInputs[1])).toContain('do not guess');
    expect((result.data!.rows as Array<{ judge_evidence: { ground_truth_pages: Array<{ content: string }> } }>)[2].judge_evidence.ground_truth_pages[0].content).toBe('7');
    expect(result.category).toBe('longmemeval-answers'); expect(result.publishable).toBe(false);
    expect(result.resolved_config!.methodology).toContain('not official');
    expect(result.data!.grounding_success).toEqual({ mean: 1, n: 3 });
    expect([f.datasetPath, f.rowsPath, f.receiptPath].map(path => digest(readFileSync(path)))).toEqual(before);
    expect((result.data!.rows as Array<{ judge_outputs: unknown[] }>)[0].judge_outputs).toEqual([judgeResponse()]);
  });

  test('generation failures count as misses, while judge failures are excluded and retain both malformed replies', async () => {
    const f = fixture();
    const sut = await runLongMemEvalAnswers({ ...f, testRuntime: { async generate() { throw new Error('generation failed'); }, judgeClient: client() } });
    expect(sut.n_scored).toBe(3); expect(sut.data!.grounding_success).toEqual({ mean: 0, n: 3 });
    const judge = await runLongMemEvalAnswers({ ...f, outputDir: join(f.root, 'judge-failure'), testRuntime: { async generate() { return answer(); }, judgeClient: client(async () => judgeResponse(true)) } });
    expect(judge.n_scored).toBe(0); expect(judge.data!.grounding_success).toEqual({ mean: null, n: 0 });
    expect(judge.errors.every(error => error.origin === 'judge')).toBe(true);
    for (const row of judge.data!.rows as Array<{ answer: ChatResult; judge_outputs: unknown[] }>) { expect(row.answer.text).toBe('SCRIPTED_ANSWER'); expect(row.judge_outputs).toHaveLength(2); }
  });

  test('source contamination is a miss without exposing it to generation', async () => {
    const f = fixture(); changeRows(f, rows => { for (const row of rows) row.evidence!.returned_chunks[0].text = 'CUE_ONLY_SENTINEL'; });
    let calls = 0;
    const result = await runLongMemEvalAnswers({ ...f, testRuntime: { async generate() { calls++; return answer(); }, judgeClient: client() } });
    expect(calls).toBe(0); expect(result.n_scored).toBe(3); expect(result.data!.grounding_success).toEqual({ mean: 0, n: 3 }); expect(result.verdict).toBe('fail');
  });

  test('legacy, partial, expanded, wrong-model, and changed-dataset artifacts cannot enter paid replay', async () => {
    const f = fixture();
    const original = readFileSync(f.rowsPath, 'utf8');
    changeRows(f, rows => { delete rows[0].evidence; });
    expect(() => loadLmeAnswerReplay({ ...f, adapter: f.profile.adapter })).toThrow('evidence contract');
    writeFileSync(f.rowsPath, original); changeRows(f, rows => rows.splice(1));
    expect(() => loadLmeAnswerReplay({ ...f, adapter: f.profile.adapter })).toThrow('incomplete');
    writeFileSync(f.rowsPath, original); changeRows(f, rows => { rows[0].evidence!.answer_chunk_indices.push(1); });
    expect(() => loadLmeAnswerReplay({ ...f, adapter: f.profile.adapter })).toThrow('expanded');
    writeFileSync(f.rowsPath, original); changeRows(f, rows => { rows[0].run_config_hash = '0'.repeat(64); });
    expect(() => loadLmeAnswerReplay({ ...f, adapter: f.profile.adapter })).toThrow('configuration');
    writeFileSync(f.rowsPath, original); changeRows(f, () => {}); writeFileSync(f.datasetPath, questionData + '\n');
    expect(() => loadLmeAnswerReplay({ ...f, adapter: f.profile.adapter })).toThrow('dataset');
  });

  test('retained retrieval SUT errors remain misses and infrastructure errors remain excluded', async () => {
    const f = fixture(); changeRows(f, rows => { rows.forEach((row, i) => { row.error = 'synthetic original failure'; row.error_origin = i === 0 ? 'sut' : 'dependency'; row.retrieved = []; row.evidence!.returned_chunks = []; row.evidence!.answer_chunk_indices = []; }); });
    let calls = 0;
    const result = await runLongMemEvalAnswers({ ...f, testRuntime: { async generate() { calls++; return answer(); }, judgeClient: client() } });
    expect(calls).toBe(0); expect(result.n_scored).toBe(1); expect(result.data!.grounding_success).toEqual({ mean: 0, n: 1 }); expect(result.publishable).toBe(false);
  });

  test('execution has a fresh namespace and restores ambient state after generation and judge errors', async () => {
    const f = fixture(), original = { ...process.env }, observations: Array<{ home: string | undefined; gbrainHome: string | undefined; configPath: string; config: unknown; forbidden: string[] }> = [];
    Object.assign(process.env, { GBRAIN_SRC: f.root, GBRAIN_REPO: f.root, GBRAIN_CONFIG: 'ambient-config', GBRAIN_DB_PATH: 'ambient-db', DATABASE_URL: 'test-only', ANTHROPIC_API_KEY: 'test-only', EXTRA_API_KEY: 'test-only' });
    try {
      const before = digest(JSON.stringify(Object.entries(process.env).sort()));
      const result = await runLongMemEvalAnswers({ ...f, testRuntime: { async generate() {
        const productConfig = await import('gbrain/config');
        const loaded = productConfig.loadConfig();
        observations.push({ home: process.env.HOME, gbrainHome: process.env.GBRAIN_HOME, configPath: productConfig.configPath(),
          config: { engine: loaded?.engine, database_path: loaded?.database_path, database_url: loaded?.database_url },
          forbidden: ['GBRAIN_SRC', 'GBRAIN_REPO', 'GBRAIN_CONFIG', 'GBRAIN_DB_PATH', 'DATABASE_URL', 'ANTHROPIC_API_KEY', 'EXTRA_API_KEY'].filter(key => key in process.env) });
        return answer();
      }, judgeClient: client(async () => { throw new Error('judge failure'); }) } });
      expect(result.n_scored).toBe(0); expect(observations).toHaveLength(3);
      for (const observed of observations) expect(observed).toEqual({ home: resolve(f.outputDir, 'runtime/home'), gbrainHome: resolve(f.outputDir, 'runtime/home'), configPath: resolve(f.outputDir, 'runtime/home/.gbrain/config.json'),
        config: { engine: 'pglite', database_path: resolve(f.outputDir, 'runtime/brain'), database_url: undefined }, forbidden: [] });
      expect(result.resolved_config!.isolated_runtime).toMatchObject({ config: resolve(f.outputDir, 'runtime/home/.gbrain/config.json'), database: resolve(f.outputDir, 'runtime/brain') });
      expect(digest(JSON.stringify(Object.entries(process.env).sort()))).toBe(before);
    } finally { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, original); }
  });

  test('live admission rejects missing caps, unverified hashes, and injected clients; CLI defaults to no calls', async () => {
    const f = fixture();
    expect(() => validateLmeAnswerProfile({ ...f.profile, dataset_sha256: '' })).toThrow('hashes');
    const live: LmeAnswerProfile = { ...f.profile, mode: 'live', answer_model: 'openai:gpt-4.1-mini', expected_product_sha: 'a'.repeat(40) };
    expect(() => validateLmeAnswerProfile(live)).toThrow('caps');
    live.answer_budget = { kind: 'isolated-provider-cap', approval_id: 'answer', max_usd: 1 }; live.judge_budget = { kind: 'isolated-provider-cap', approval_id: 'judge', max_usd: 1 };
    expect(() => validateLmeAnswerProfile(live)).not.toThrow();
    await expect(runLongMemEvalAnswers({ ...f, profile: live, testRuntime: { async generate() { return answer(); }, judgeClient: client() } })).rejects.toThrow('injected');
    await expect(runLongMemEvalAnswers({ ...f, profile: { ...f.profile, retrieval_config_sha256: '0'.repeat(64) }, testRuntime: { async generate() { return answer(); }, judgeClient: client() } })).rejects.toThrow('preregistered');
    const proc = Bun.spawnSync(['bun', 'eval/runner/longmemeval-answers.ts', '--dataset', f.datasetPath, '--rows', f.rowsPath, '--receipt', f.receiptPath, '--adapter', f.profile.adapter], { env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
    expect(proc.exitCode).toBe(0); expect(JSON.parse(proc.stdout.toString())).toMatchObject({ validation_only: true, provider_calls: 0, rows: 3 });
  });

  test('live checks product bindings before stripping the environment and restores it when provider keys are missing', async () => {
    const f = fixture(), capture = loadLmeAnswerReplay({ ...f, adapter: f.profile.adapter }).capture;
    const p: LmeAnswerProfile = { ...f.profile, mode: 'live', answer_model: 'openai:gpt-4.1-mini', expected_product_sha: capture.product.product_sha ?? capture.product.declared_pin.split('#')[1], expected_package_sha256: capture.product.package_sha256,
      answer_budget: { kind: 'isolated-provider-cap', approval_id: 'answer', max_usd: 1 }, judge_budget: { kind: 'isolated-provider-cap', approval_id: 'judge', max_usd: 1 } };
    const original = { ...process.env };
    try {
      process.env.GBRAIN_SRC = f.root;
      const binding = await runLongMemEvalAnswers({ ...f, profile: p });
      expect(binding.data!.blocked_reason).toContain('GBRAIN_SRC resolves to another product tree');
      expect(binding.resolved_config!.isolated_runtime).toBeNull(); expect(process.env.GBRAIN_SRC).toBe(f.root);
      if (original.GBRAIN_SRC === undefined) delete process.env.GBRAIN_SRC; else process.env.GBRAIN_SRC = original.GBRAIN_SRC;
      delete process.env.ANTHROPIC_API_KEY;
      const home = process.env.HOME;
      const readiness = await runLongMemEvalAnswers({ ...f, profile: p, outputDir: join(f.root, 'not-ready') });
      expect(readiness.data!.blocked_reason).toContain('credentials are not ready'); expect(readiness.n_scored).toBe(0);
      expect(readiness.resolved_config!.isolated_runtime).toMatchObject({ approved_provider_keys: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] });
      expect(process.env.HOME).toBe(home); expect('ANTHROPIC_API_KEY' in process.env).toBe(false);
    } finally { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, original); }
  });

  test('secondary output cannot replace the primary evidence directory', async () => {
    const f = fixture(), before = digest(readFileSync(f.receiptPath));
    await expect(runLongMemEvalAnswers({ ...f, outputDir: f.root, testRuntime: { async generate() { return answer(); }, judgeClient: client() } })).rejects.toThrow('immutable');
    expect(digest(readFileSync(f.receiptPath))).toBe(before);
  });

  test('producer opt-in retains actual keyless search output without changing retrieval results or formulas', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lme-retention-e2e-')); roots.push(root);
    const datasetPath = join(root, 'dataset.json'); writeFileSync(datasetPath, JSON.stringify(questions.map((q, i) => ({ ...q, question: ['umbrella', 'bicycle', 'cartons'][i] }))));
    const opts = { ...parseOpts([]), datasetPath, datasetName: 'synthetic-test', adapters: ['keyword'], keywordOnly: true, topK: 1, noCache: true, minRecallAll: 0,
      output: join(root, 'plain.json'), ndjsonPath: join(root, 'plain.ndjson'), reportsDir: join(root, 'plain-reports') };
    const plain = await run(opts);
    const retained = await run({ ...opts, retainEvidence: true, output: join(root, 'retained.json'), ndjsonPath: join(root, 'retained.ndjson'), reportsDir: join(root, 'retained-reports') });
    const legacyRows = readFileSync(opts.ndjsonPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as NdjsonRow);
    const newRows = readFileSync(join(root, 'retained.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as NdjsonRow);
    expect(legacyRows.every(row => row.evidence === undefined)).toBe(true);
    expect(newRows.every(row => row.evidence !== undefined)).toBe(true);
    expect(newRows.some(row => row.evidence!.returned_chunks.length > 0)).toBe(true);
    expect(newRows.map(row => [row.retrieved, row.hit_at_k, row.recall_all, row.recall_any, row.ndcg_any, row.abs_noise])).toEqual(legacyRows.map(row => [row.retrieved, row.hit_at_k, row.recall_all, row.recall_any, row.ndcg_any, row.abs_noise]));
    const stripTiming = (summary: ReturnType<typeof summarizeAdapterRows>) => { const { avg_latency_ms: _a, p50_latency_ms: _b, p99_latency_ms: _c, total_seconds: _d, ...metrics } = summary; return metrics; };
    expect(stripTiming(retained.summaries[0])).toEqual(stripTiming(plain.summaries[0]));
    const loaded = loadLmeAnswerReplay({ datasetPath, rowsPath: join(root, 'retained.ndjson'), receiptPath: retained.receiptFile, adapter: 'gbrain-keyword' });
    expect(loaded.rows).toHaveLength(3); expect(loaded.rows.every(row => row.safety.length === 0)).toBe(true);
    await expect(run({ ...opts, retainEvidence: true })).rejects.toThrow('fresh');
    await expect(run({ ...opts, retainEvidence: true, output: join(root, 'collision.json'), ndjsonPath: join(root, 'collision.json'), reportsDir: join(root, 'collision-reports') })).rejects.toThrow('distinct');
  }, 30000);
});
