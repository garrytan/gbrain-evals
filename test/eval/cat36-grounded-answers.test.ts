import { afterEach, describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChatResult } from 'gbrain/ai/gateway';
import { offlineCat36Profile, runCat36, type Cat36Row } from '../../eval/runner/cat36-associative-retrieval.ts';
import { cat36Hash, loadCat36Corpus } from '../../eval/runner/cat36-corpus.ts';
import { GROUNDED_JUDGE_MODEL, loadGroundedReplay, runCat36GroundedAnswers, validateGroundedProfile, type AnswerInput, type GroundedProfile } from '../../eval/runner/cat36-grounded-answers.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';
import { regressionPackageHash, resolveRegressionProduct } from '../../eval/runner/situation-recall-provenance.ts';

const corpusDir = resolve('eval/data/associative-recall-v1');
const profile: GroundedProfile = { mode: 'offline', answer_model: 'test:answer', judge_model: GROUNDED_JUDGE_MODEL, answer_max_tokens: 128, judge_max_tokens: 128 };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function message(malformed = false): Anthropic.Messages.Message {
  return { id: 'judge-response', type: 'message', role: 'assistant', model: GROUNDED_JUDGE_MODEL,
    content: malformed ? [{ type: 'text', text: 'No structured scores.' }] : [{ type: 'tool_use', id: 'score', name: 'score_answer', input: {
      scores: ['grounded', 'complete_or_abstains'].map(criterion_id => ({ criterion_id, score: 5, rationale: 'Scripted plumbing result.' })),
      verdict: 'pass', overall_rationale: 'Not a model-quality result.',
    } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as Anthropic.Messages.Message;
}

function judgeClient(create = async (_request: unknown) => message()): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

function answer(text = 'There is insufficient evidence to answer.'): ChatResult {
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: profile.answer_model, providerId: 'test' };
}

async function fixture(goldChunk = true) {
  const root = mkdtempSync(join(tmpdir(), 'cat36-grounded-test-'));
  roots.push(root);
  const primaryDir = join(root, 'primary'), outputDir = join(root, 'secondary');
  const corpus = loadCat36Corpus(corpusDir);
  const span = corpus.spans[0];
  const source = corpus.sources.find(s => s.source_id === span.source_id && s.slug === span.slug)!;
  const start = goldChunk ? span.start : 0, end = goldChunk ? span.end : 10;
  await runCat36({ corpusDir, outputDir: primaryDir, profile: offlineCat36Profile(), smoke: true, runtime: {
    kind: 'test',
    async build(sources) { return { mode: 'offline', complete: true, feature_supported: false, generation_observed: false, families: [], source_hash: cat36Hash(JSON.stringify(sources)), resolved_config: {}, provenance: {}, mappings: [], generation: {} }; },
    async search() { return { chunks: [{ source_id: source.source_id, slug: source.slug, page_id: 1, chunk_id: 1, chunk_index: 0, start, end, text: source.text.slice(start, end), token_count: Math.ceil((end - start) / 4) }], cue: { mode: 'off', status: 'skipped', candidates: 0, admitted: 0 }, failures: [], metadata: { cue_text: 'HIDDEN_CUE_SENTINEL' } }; },
    async close() {},
  } });
  return { root, primaryDir, outputDir, corpusDir, profile, span, source };
}

function mutateRows(primaryDir: string, mutate: (row: Cat36Row) => void) {
  const receipt = loadReceipt(join(primaryDir, 'receipt.json'));
  const rows = receipt.data!.rows as Cat36Row[];
  rows.forEach(mutate);
  writeFileSync(join(primaryDir, 'probes.ndjson'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(primaryDir, 'receipt.json'), JSON.stringify(receipt));
}

describe('Cat36 grounded-answer secondary replay', () => {
  test('generation sees only frozen questions and actual returned excerpts, while the judge sees exact required evidence', async () => {
    const f = await fixture(false);
    const inputs: AnswerInput[] = [], judgeRequests: unknown[] = [];
    const original = ['receipt.json', 'build.json', 'probes.ndjson'].map(file => readFileSync(join(f.primaryDir, file), 'utf8'));
    const result = await runCat36GroundedAnswers({ ...f, testRuntime: { async generate(input) { inputs.push(input); return answer(); }, judgeClient: judgeClient(async request => { judgeRequests.push(request); return message(); }) } });
    expect(inputs).toHaveLength(4);
    expect(Object.keys(inputs[0]).sort()).toEqual(['chunks', 'question']);
    expect(Object.keys(inputs[0].chunks[0]).sort()).toEqual(['slug', 'source_id', 'text']);
    expect(inputs[0].chunks[0].text).toBe(f.source.text.slice(0, 10));
    expect(JSON.stringify(inputs)).not.toContain(f.span.text);
    expect(JSON.stringify(inputs)).not.toContain(f.span.id);
    expect(JSON.stringify(inputs)).not.toContain('required_span_ids');
    expect(JSON.stringify(inputs)).not.toContain('HIDDEN_CUE_SENTINEL');
    expect(JSON.stringify(judgeRequests[0])).toContain(f.span.text);
    const rows = result.data!.rows as Array<{ score: number; judge_outputs: unknown[]; answer: ChatResult; judge_evidence: { ground_truth_pages: unknown[]; rubric: unknown[] } }>;
    expect(rows.slice(0, 3).map(row => row.score)).toEqual([0, 0, 0]);
    expect(rows[3].judge_evidence.ground_truth_pages).toEqual([]);
    expect(JSON.stringify(rows[3].judge_evidence.rubric)).toContain('insufficient');
    expect(rows[0].answer.usage.input_tokens).toBe(12);
    expect(rows[0].judge_outputs).toEqual([message()]);
    expect(result.category).toBe('cat36-grounded-answers');
    expect(result.publishable).toBe(false);
    expect(result.hashes!['primary/receipt.json']).toBe(cat36Hash(original[0]));
    expect(['receipt.json', 'build.json', 'probes.ndjson'].map(file => readFileSync(join(f.primaryDir, file), 'utf8'))).toEqual(original);
    expect(loadReceipt(join(f.outputDir, 'receipt.json')).data!.answer_success).toEqual({ mean: 0.25, n: 4 });
  });

  test('generation failures are scored misses rather than dropped probes', async () => {
    const f = await fixture();
    let judgments = 0;
    const result = await runCat36GroundedAnswers({ ...f, testRuntime: { async generate() { throw new Error('SUT failed'); }, judgeClient: judgeClient(async () => { judgments++; return message(); }) } });
    expect(result.n_scored).toBe(4);
    expect(result.data!.answer_success).toEqual({ mean: 0, n: 4 });
    expect(result.errors.every(error => error.origin === 'sut')).toBe(true);
    expect(judgments).toBe(0);
  });

  test('replay uses a fresh namespace, strips ambient state and keys, and restores the environment after SUT failures', async () => {
    const f = await fixture();
    const originalEnv = { ...process.env };
    const envHash = () => cat36Hash(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))));
    Object.assign(process.env, { GBRAIN_SRC: f.root, GBRAIN_REPO: f.root, GBRAIN_DB_PATH: 'ambient-db', GBRAIN_CONFIG: 'ambient-config',
      DATABASE_URL: 'ambient-db-url', XDG_CONFIG_HOME: 'ambient-xdg', OPENAI_API_KEY: 'test-only', ANTHROPIC_API_KEY: 'test-only', UNAPPROVED_SERVICE_TOKEN: 'test-only' });
    const before = envHash();
    const observations: Array<{ paths: Record<string, string | undefined>; configPath: string; config: unknown; forbidden: string[] }> = [];
    try {
      const result = await runCat36GroundedAnswers({ ...f, testRuntime: { async generate() {
        const productConfig = await import('gbrain/config');
        const loaded = productConfig.loadConfig();
        observations.push({ paths: Object.fromEntries(['HOME', 'GBRAIN_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'].map(key => [key, process.env[key]])),
          configPath: productConfig.configPath(), config: { engine: loaded?.engine, database_path: loaded?.database_path, database_url: loaded?.database_url },
          forbidden: ['GBRAIN_SRC', 'GBRAIN_REPO', 'GBRAIN_CONFIG', 'GBRAIN_DB_PATH', 'DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'UNAPPROVED_SERVICE_TOKEN'].filter(name => name in process.env) });
        process.env.GROUNDED_INTRODUCED_STATE = 'remove-on-exit';
        throw new Error('SUT failure inside namespace');
      }, judgeClient: judgeClient() } });
      expect(result.n_scored).toBe(4);
      expect(observations).toHaveLength(4);
      for (const observed of observations) {
        expect(observed.paths).toEqual({ HOME: resolve(f.outputDir, 'runtime/home'), GBRAIN_HOME: resolve(f.outputDir, 'runtime/home'),
          XDG_CONFIG_HOME: resolve(f.outputDir, 'runtime/home/.config'), XDG_CACHE_HOME: resolve(f.outputDir, 'runtime/home/.cache'), XDG_STATE_HOME: resolve(f.outputDir, 'runtime/home/.local/state') });
        expect(observed.configPath).toBe(resolve(f.outputDir, 'runtime/home/.gbrain/config.json'));
        expect(observed.config).toEqual({ engine: 'pglite', database_path: resolve(f.outputDir, 'runtime/brain'), database_url: undefined });
        expect(observed.forbidden).toEqual([]);
      }
      expect(result.resolved_config!.isolated_runtime).toMatchObject({ home: resolve(f.outputDir, 'runtime/home'), config: resolve(f.outputDir, 'runtime/home/.gbrain/config.json'), database: resolve(f.outputDir, 'runtime/brain'), approved_provider_keys: [] });
      expect(envHash()).toBe(before);
      expect('GROUNDED_INTRODUCED_STATE' in process.env).toBe(false);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    }
  });

  test('concurrent replays cannot share and overwrite the process environment', async () => {
    const f = await fixture();
    const result = await runCat36GroundedAnswers({ ...f, testRuntime: { async generate() {
      await expect(runCat36GroundedAnswers({ ...f, outputDir: join(f.root, 'concurrent'), testRuntime: { async generate() { return answer(); }, judgeClient: judgeClient() } })).rejects.toThrow('separate processes');
      return answer();
    }, judgeClient: judgeClient() } });
    expect(result.n_scored).toBe(4);
    expect(result.errors).toEqual([]);
  });

  test('judge exceptions are excluded and preserve the original answers', async () => {
    const f = await fixture();
    const result = await runCat36GroundedAnswers({ ...f, testRuntime: { async generate() { return answer('RAW_ANSWER'); }, judgeClient: judgeClient(async () => { throw new Error('Judge unavailable'); }) } });
    expect(result.n_scored).toBe(0);
    expect(result.data!.answer_success).toEqual({ mean: null, n: 0 });
    expect(result.errors.every(error => error.origin === 'judge')).toBe(true);
    expect(result.publishable).toBe(false);
    expect(JSON.stringify(result.data!.rows)).toContain('RAW_ANSWER');
  });

  test('malformed judge retries retain both raw responses and remain excluded', async () => {
    const f = await fixture();
    const result = await runCat36GroundedAnswers({ ...f, testRuntime: { async generate() { return answer(); }, judgeClient: judgeClient(async () => message(true)) } });
    expect(result.n_scored).toBe(0);
    for (const row of result.data!.rows as Array<{ judge_outputs: unknown[]; judge_result: { verdict: string; attempts: number } }>) {
      expect(row.judge_outputs).toHaveLength(2);
      expect(row.judge_result.verdict).toBe('judge_failed');
      expect(row.judge_result.attempts).toBe(2);
    }
  });

  test('source or cue text not present at the returned original offsets is rejected before generation', async () => {
    const f = await fixture();
    mutateRows(f.primaryDir, row => { row.chunks[0].text = 'A fluent generated association, not original evidence.'; });
    let calls = 0;
    const result = await runCat36GroundedAnswers({ ...f, testRuntime: { async generate() { calls++; return answer('Fluent unsupported answer.'); }, judgeClient: judgeClient() } });
    expect(calls).toBe(0);
    expect(result.data!.answer_success).toEqual({ mean: 0, n: 4 });
    expect(result.verdict).toBe('fail');
    expect(result.errors[0].message).toContain('contamination');
  });

  test('private source excerpts cannot pass even when a judge stub would accept them', async () => {
    const f = await fixture();
    const privateSource = loadCat36Corpus(corpusDir).sources.find(s => s.visibility === 'private')!;
    mutateRows(f.primaryDir, row => { row.chunks[0] = { ...row.chunks[0], source_id: privateSource.source_id, slug: privateSource.slug, text: privateSource.text, start: 0, end: privateSource.text.length }; });
    const result = await runCat36GroundedAnswers({ ...f, testRuntime: { async generate() { throw new Error('must not reach generator'); }, judgeClient: judgeClient() } });
    expect(result.errors.every(error => error.message.includes('contamination'))).toBe(true);
    expect(result.verdict).toBe('fail');
  });

  test('frozen source hash, build bytes, corpus hashes, and raw rows are validated before any calls', async () => {
    const f = await fixture();
    const receipt = loadReceipt(join(f.primaryDir, 'receipt.json'));
    const build = JSON.parse(readFileSync(join(f.primaryDir, 'build.json'), 'utf8'));
    build.source_hash = '0'.repeat(64);
    (receipt.data!.build as { source_hash: string }).source_hash = build.source_hash;
    const bytes = JSON.stringify(build);
    writeFileSync(join(f.primaryDir, 'build.json'), bytes);
    receipt.hashes!.build = cat36Hash(bytes);
    writeFileSync(join(f.primaryDir, 'receipt.json'), JSON.stringify(receipt));
    expect(() => loadGroundedReplay(f.primaryDir, f.corpusDir)).toThrow('source hash');
    const other = await fixture();
    writeFileSync(join(other.primaryDir, 'probes.ndjson'), '{}\n');
    expect(() => loadGroundedReplay(other.primaryDir, other.corpusDir)).toThrow('raw rows');
  });

  test('live requires explicit models, separate budget approvals, exact identity, and rejects test injection', async () => {
    const live: GroundedProfile = { ...profile, mode: 'live', answer_model: 'openai:gpt-4.1-mini', expected_product_sha: 'a'.repeat(40) };
    expect(() => validateGroundedProfile(live)).toThrow('caps');
    live.answer_budget = { kind: 'isolated-provider-cap', approval_id: 'answer-approval', max_usd: 1 };
    live.judge_budget = { kind: 'isolated-provider-cap', approval_id: 'judge-approval', max_usd: 1 };
    expect(() => validateGroundedProfile(live)).not.toThrow();
    expect(() => validateGroundedProfile({ ...live, judge_model: 'unknown-pricing-model' })).toThrow('pricing');
    expect(() => validateGroundedProfile({ ...live, expected_product_sha: undefined })).toThrow('identity');
    expect(() => validateGroundedProfile({ ...live, answer_budget: { ...live.answer_budget!, max_usd: NaN } })).toThrow('caps');
    const f = await fixture();
    await expect(runCat36GroundedAnswers({ ...f, profile: live, testRuntime: { async generate() { return answer(); }, judgeClient: judgeClient() } })).rejects.toThrow('offline');
    const blocked = await runCat36GroundedAnswers({ ...f, profile: live });
    expect(blocked.run_status).toBe('error');
    expect(blocked.n_scored).toBe(0);
    expect(blocked.data!.blocked_reason).toContain('production live retrieval');
  });

  test('loaded product identity and both provider credentials are checked before live inference', async () => {
    const f = await fixture();
    const product = resolveRegressionProduct({ expectedPackageSha256: regressionPackageHash(resolve('node_modules/gbrain')) });
    const sha = product.product_sha ?? product.declared_pin.split('#')[1];
    const live: GroundedProfile = { ...profile, mode: 'live', answer_model: 'openai:gpt-4.1-mini', expected_product_sha: sha, expected_package_sha256: product.package_sha256,
      answer_budget: { kind: 'isolated-provider-cap', approval_id: 'answer-approval', max_usd: 1 }, judge_budget: { kind: 'isolated-provider-cap', approval_id: 'judge-approval', max_usd: 1 } };
    const receipt = loadReceipt(join(f.primaryDir, 'receipt.json'));
    const retrievalProfile = { ...offlineCat36Profile(), mode: 'live', expected_product_sha: sha, expected_package_sha256: product.package_sha256, provider_budget: live.answer_budget };
    receipt.resolved_config!.profile = retrievalProfile;
    receipt.data!.runtime_kind = 'production';
    const build = JSON.parse(readFileSync(join(f.primaryDir, 'build.json'), 'utf8'));
    build.mode = 'live'; build.provenance = product; build.profile_hash = cat36Hash(JSON.stringify(retrievalProfile));
    const { frozen_at: _frozen, profile_hash: _profileHash, ...originalBuild } = build;
    receipt.data!.build = originalBuild;
    const bytes = JSON.stringify(build);
    receipt.hashes!.build = cat36Hash(bytes); receipt.hashes!.profile = build.profile_hash;
    writeFileSync(join(f.primaryDir, 'build.json'), bytes);
    writeFileSync(join(f.primaryDir, 'receipt.json'), JSON.stringify(receipt));
    const mismatch = await runCat36GroundedAnswers({ ...f, profile: { ...live, expected_package_sha256: '0'.repeat(64) } });
    expect(mismatch.data!.blocked_reason).toContain('package content hash mismatch');
    expect(mismatch.n_scored).toBe(0);
    expect(mismatch.resolved_config!.isolated_runtime).toBeNull();
    const sourceBinding = process.env.GBRAIN_SRC;
    process.env.GBRAIN_SRC = f.root;
    try {
      const foreignBinding = await runCat36GroundedAnswers({ ...f, profile: live, outputDir: join(f.root, 'foreign-binding') });
      expect(foreignBinding.data!.blocked_reason).toContain('GBRAIN_SRC resolves to another product tree');
      expect(foreignBinding.resolved_config!.isolated_runtime).toBeNull();
      expect(process.env.GBRAIN_SRC).toBe(f.root);
    } finally { if (sourceBinding === undefined) delete process.env.GBRAIN_SRC; else process.env.GBRAIN_SRC = sourceBinding; }
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const home = process.env.HOME;
    try {
      const unavailable = await runCat36GroundedAnswers({ ...f, profile: live, outputDir: join(f.root, 'not-ready') });
      expect(unavailable.data!.blocked_reason).toContain('credentials are not ready');
      expect(unavailable.n_scored).toBe(0);
      expect(unavailable.publishable).toBe(false);
      expect(unavailable.resolved_config!.isolated_runtime).toMatchObject({ home: join(f.root, 'not-ready/runtime/home'), approved_provider_keys: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] });
      expect(process.env.HOME).toBe(home);
      expect('ANTHROPIC_API_KEY' in process.env).toBe(false);
    } finally { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
  });

  test('unknown answer usage and judge response identities cannot produce passing scores', async () => {
    const f = await fixture();
    const invalidAnswer = await runCat36GroundedAnswers({ ...f, testRuntime: { async generate() { return { ...answer(), usage: { ...answer().usage, input_tokens: NaN } }; }, judgeClient: judgeClient() } });
    expect(invalidAnswer.n_scored).toBe(4);
    expect(invalidAnswer.data!.answer_success).toEqual({ mean: 0, n: 4 });
    const invalidJudge = await runCat36GroundedAnswers({ ...f, outputDir: join(f.root, 'bad-judge'), testRuntime: { async generate() { return answer(); }, judgeClient: judgeClient(async () => ({ ...message(), model: 'unexpected-model' })) } });
    expect(invalidJudge.n_scored).toBe(0);
    expect((invalidJudge.data!.rows as Array<{ judge_outputs: unknown[] }>)[0].judge_outputs).toHaveLength(1);
  });

  test('output must be fresh and cannot replace a primary receipt', async () => {
    const f = await fixture();
    const original = readFileSync(join(f.primaryDir, 'receipt.json'), 'utf8');
    await expect(runCat36GroundedAnswers({ ...f, outputDir: f.primaryDir, testRuntime: { async generate() { return answer(); }, judgeClient: judgeClient() } })).rejects.toThrow('immutable');
    expect(readFileSync(join(f.primaryDir, 'receipt.json'), 'utf8')).toBe(original);
  });

  test('CLI defaults to validation only with no provider calls or output writes', async () => {
    const f = await fixture();
    const proc = Bun.spawnSync(['bun', 'eval/runner/cat36-grounded-answers.ts', '--input', f.primaryDir], { cwd: process.cwd(), env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString())).toMatchObject({ validation_only: true, provider_calls: 0, probes: 4 });
  });
});
