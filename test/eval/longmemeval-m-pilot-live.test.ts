import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPilotLiveStage } from '../../eval/runner/longmemeval-m-pilot-live.ts';
import { regressionPackageHash } from '../../eval/runner/situation-recall-provenance.ts';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const productRoot = realpathSync(resolve(import.meta.dir, '../../node_modules/gbrain'));
const packageSha = regressionPackageHash(productRoot);
const baseline = packageSha === '78bbe78af2fac33a278740e84877e9c6c9f7a0f6a161113b1240549adf993b2b';
const reference = packageSha === '7fc21cee0cc08169c2bbbbb05e137b5b26e885beb24fd9f6275808d2cf162e67';
const candidate = reference || !baseline && packageSha !== 'b302290974571ae846e26587cd37ecf6299b74c3bfe0d401aa22935ca3a84c97'
  && readFileSync(join(productRoot, 'src/core/memory-cues/types.ts'), 'utf8').includes("MEMORY_CUE_PROMPT_VERSION = 'situation-v3'");
const arm = baseline ? 'B' : 'C0';

describe.skipIf(!baseline && !candidate)('matched B/C0 construction and replay with mocked HTTP', () => {
  const folder = mkdtempSync(join(tmpdir(), 'lme-m-live-'));
  const questionId = 'c960da58';
  const selected = JSON.parse(readFileSync(resolve(import.meta.dir, '../../eval/data/longmemeval-m-pilot-selection.json'), 'utf8'));
  const sourcePath = join(folder, 'source-only.json');
  const selectionPath = join(folder, 'selection.json');
  const sourceManifestPath = join(folder, 'source-manifest.json');
  const selectedDatasetPath = join(folder, 'questions.json');
  const source = [{ occurrence_index: 0, session_id: 'public-demo', date: '2023/05/28 (Sun) 05:21',
    turns: [{ role: 'user', content: 'The sample project uses a blue label.' }] }];
  writeFileSync(sourcePath, JSON.stringify(source) + '\n');
  const sourceSha = hash(readFileSync(sourcePath));
  const questions = selected.selected_ids.map((id: string) => ({ question_id: id, question_type: 'single-session-user',
    question: 'Which label did the sample project use?', answer: 'blue', answer_session_ids: ['public-demo'],
    haystack_session_ids: ['public-demo'], haystack_dates: ['2023/05/28 (Sun) 05:21'],
    haystack_sessions: [[{ role: 'user', content: 'The sample project uses a blue label.' }]] }));
  writeFileSync(selectedDatasetPath, JSON.stringify(questions) + '\n');
  selected.selected_dataset.sha256 = hash(readFileSync(selectedDatasetPath));
  selected.selected_source_details[questionId].source_sha256 = sourceSha;
  writeFileSync(selectionPath, JSON.stringify(selected) + '\n');
  writeFileSync(sourceManifestPath, JSON.stringify({ selected_ids: selected.selected_ids,
    selected_source_details: { [questionId]: { source_file: sourcePath, source_sha256: sourceSha } } }) + '\n');
  const registrationSha = hash(readFileSync(selectionPath));
  const sourceManifestSha = hash(readFileSync(sourceManifestPath));
  const profile = (stage: 'construction' | 'replay', constructionReceiptSha?: string) => ({
    schema_version: 1, kind: 'source-only-development', experiment: reference ? 'longmemeval-m-source-only-dev-v2' : 'longmemeval-m-source-only-dev-v1',
    question_id: questionId, attempt_id: 'attempt-1', registration_sha256: registrationSha,
    source_manifest_sha256: sourceManifestSha,
    expected_product_sha: baseline ? '6040075c6cb95be5881cc2e1b76ef7d71f4e5d29'
      : JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')).dependencies.gbrain.split('#')[1],
    expected_package_sha256: packageSha,
    allocation: { id: `${arm}-${questionId}-attempt-1-${stage}`, usd: stage === 'construction' ? 9 : 1 },
    arm, cue_mode: 'off', stage, ...(constructionReceiptSha ? { construction_receipt_sha256: constructionReceiptSha } : {}),
  });
  const inputs = (stage: 'construction' | 'replay', receiptSha?: string) => {
    const p = profile(stage, receiptSha);
    const prefix = join(folder, `${stage}-${crypto.randomUUID()}`);
    const profilePath = `${prefix}-profile.json`, leafLedgerEntryPath = `${prefix}-ledger.json`;
    writeFileSync(profilePath, JSON.stringify(p));
    writeFileSync(leafLedgerEntryPath, JSON.stringify({ schema_version: 1, question_id: p.question_id,
      attempt_id: p.attempt_id, arm: p.arm, stage: p.stage,
      profile_sha256: hash(readFileSync(profilePath)), allocation: p.allocation }));
    return { stage, profilePath, leafLedgerEntryPath,
      stageDir: `${prefix}-output`, selectionPath, sourceManifestPath, productRoot };
  };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let calls = 0;
  beforeAll(() => {
    process.env.OPENROUTER_API_KEY = 'synthetic-openrouter-only';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input as Request, init), body = await request.json() as { input: string | string[] };
      if (new URL(request.url).pathname !== '/api/v1/embeddings') throw new Error('chat route forbidden in B/C0');
      calls++;
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ object: 'list', model: 'text-embedding-3-large',
        data: inputs.map((_: unknown, index: number) => ({ object: 'embedding', index,
          embedding: Array.from({ length: 1536 }, (__, i) => i === 0 ? 1 : 0) })),
        usage: { prompt_tokens: 1, total_tokens: 1, cost: 0.00000013, is_byok: false } });
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    rmSync(folder, { recursive: true, force: true });
  });

  test('operator leaf mismatch fails before creating a stage or making HTTP requests', async () => {
    const options = inputs('construction');
    writeFileSync(options.leafLedgerEntryPath, JSON.stringify({ ...JSON.parse(readFileSync(options.leafLedgerEntryPath, 'utf8')),
      profile_sha256: '0'.repeat(64) }));
    await expect(runPilotLiveStage(options, true)).rejects.toThrow('operator leaf');
    expect(existsSync(options.stageDir)).toBe(false);
    expect(calls).toBe(0);
  });

  test('closes a guarded source-only snapshot before separate query replay and never emits mock outcome', async () => {
    const construction = inputs('construction');
    const built = await runPilotLiveStage(construction, true);
    expect(built.status).toBe('complete');
    expect(built.transport).toBe('test-mock');
    expect(built.guard?.dispatched_requests).toBeGreaterThan(0);
    expect(built.guard?.chat_sealed).toBe(true);
    const cues = JSON.parse(readFileSync(join(construction.stageDir, 'indexed/index-manifest.json'), 'utf8')).resolved_config.cues;
    if (baseline) expect(cues).toEqual({ capability: 'absent-in-verified-baseline-604' });
    else expect(cues.readMode).toBe('off');
    const receiptPath = join(construction.stageDir, 'stage-receipt.json');
    const replay = inputs('replay', hash(readFileSync(receiptPath)));
    const result = await runPilotLiveStage({ ...replay, constructionReceiptPath: receiptPath, selectedDatasetPath }, true);
    expect(result.status).toBe('complete');
    expect(result.construction_receipt_sha256).toBe(hash(readFileSync(receiptPath)));
    expect(result.guard?.chat_sealed).toBe(true);
    expect(JSON.parse(readFileSync(join(replay.stageDir, 'query-row.json'), 'utf8')).latency_source).toBe('live_search');
    expect(existsSync(join(replay.stageDir, 'case-outcome.json'))).toBe(false);
    expect(calls).toBeGreaterThan(1);
    const tampered = inputs('replay', 'f'.repeat(64));
    await expect(runPilotLiveStage({ ...tampered, constructionReceiptPath: receiptPath, selectedDatasetPath }, true))
      .rejects.toThrow('linked');
    expect(existsSync(tampered.stageDir)).toBe(false);
  }, 120_000);

  test('uncertain provider billing retains an incomplete stage and blocks replay', async () => {
    const usualMock = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input as Request, init);
      return Response.json({ object: 'list', model: 'text-embedding-3-large',
        data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 1536 }, (__, i) => i === 0 ? 1 : 0) }],
        usage: { prompt_tokens: 1, total_tokens: 1 } });
    }) as typeof fetch;
    try {
      const construction = inputs('construction');
      await expect(runPilotLiveStage(construction, true)).rejects.toThrow('incomplete');
      const receiptPath = join(construction.stageDir, 'stage-receipt.json');
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      expect(receipt.status).toBe('incomplete');
      expect(receipt.transport).toBe('test-mock');
      expect(receipt.guard.failed_or_unreported_requests).toBeGreaterThan(0);
      expect(receipt.guard_journal_sha256).toMatch(/^[a-f0-9]{64}$/);
      const replay = inputs('replay', hash(readFileSync(receiptPath)));
      await expect(runPilotLiveStage({ ...replay, constructionReceiptPath: receiptPath, selectedDatasetPath }, true))
        .rejects.toThrow('completed matching provider construction');
      expect(existsSync(replay.stageDir)).toBe(false);
    } finally { globalThis.fetch = usualMock; }
  }, 120_000);
});

for (const selectedArm of ['C0', 'C1'] as const) test.skipIf(
  packageSha !== 'b302290974571ae846e26587cd37ecf6299b74c3bfe0d401aa22935ca3a84c97')(
  `historical 470 cannot enter matched v3 ${selectedArm} before dispatch`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'lme-historical-c0-'));
    try {
      const profilePath = join(folder, 'profile.json');
      writeFileSync(profilePath, JSON.stringify({ schema_version: 1, kind: 'source-only-development',
        experiment: 'longmemeval-m-source-only-dev-v1', question_id: 'c960da58', attempt_id: 'attempt-1',
        registration_sha256: '1'.repeat(64), source_manifest_sha256: '2'.repeat(64),
        expected_product_sha: '470ccc49c33b44c4a4be4e60bc606c0ad04a4427',
        expected_package_sha256: packageSha, allocation: { id: `${selectedArm}:first:attempt-1:construction`, usd: selectedArm === 'C1' ? 95 : 9 },
        arm: selectedArm, cue_mode: selectedArm === 'C1' ? 'on' : 'off', stage: 'construction',
        ...(selectedArm === 'C1' ? { cue_pipeline_version: 'situation-v3', cue_prompt_sha256: '3'.repeat(64) } : {}) }));
      const stageDir = join(folder, 'stage');
      await expect(runPilotLiveStage({ stage: 'construction', profilePath, stageDir, productRoot,
        selectionPath: join(folder, 'absent-selection'), sourceManifestPath: join(folder, 'absent-manifest'),
        leafLedgerEntryPath: join(folder, 'absent-ledger') }, true)).rejects.toThrow('matched arm');
      expect(existsSync(stageDir)).toBe(false);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
