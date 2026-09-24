import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertMatchedProductDeclaration, runPilotLiveStage } from '../../eval/runner/longmemeval-m-pilot-live.ts';
import { developmentChatOptions } from '../../eval/runner/situation-recall-development.ts';
import { regressionPackageHash } from '../../eval/runner/situation-recall-provenance.ts';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const productRoot = realpathSync(resolve(import.meta.dir, '../../node_modules/gbrain'));
const packageSha = regressionPackageHash(productRoot);
const productSha = 'f3249d1703772573006141224a4d06d9b8df7b41';
const expectedPackageSha = '7fc21cee0cc08169c2bbbbb05e137b5b26e885beb24fd9f6275808d2cf162e67';

test('v4 rejects a historical or otherwise wrong declared pin before admission', () => {
  const declared = JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')).dependencies.gbrain;
  expect(declared).toBe(`github:garrytan/gbrain#${productSha}`);
  expect(() => assertMatchedProductDeclaration(declared, productSha)).not.toThrow();
  expect(() => assertMatchedProductDeclaration('github:garrytan/gbrain#470ccc49c33b44c4a4be4e60bc606c0ad04a4427', productSha))
    .toThrow('declared product pin mismatch');
  expect(() => assertMatchedProductDeclaration('github:other/gbrain#f3249d1703772573006141224a4d06d9b8df7b41', productSha))
    .toThrow('declared product pin mismatch');
});

test('v4 C1 public cue construction and separate replay retain a grounded cue', async () => {
  expect(packageSha).toBe(expectedPackageSha);
  const folder = mkdtempSync(join(tmpdir(), 'lme-c1-public-stage-'));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const questionId = 'c960da58';
  const model = 'openrouter:anthropic/claude-sonnet-4.6';
  const selected = JSON.parse(readFileSync(resolve(import.meta.dir, '../../eval/data/longmemeval-m-pilot-selection.json'), 'utf8'));
  const sourcePath = join(folder, 'source-only.json');
  const source = [{ occurrence_index: 0, session_id: 'fictional-demo', date: '2023/05/28 (Sun) 05:21',
    turns: [{ role: 'user', content: 'The fictional project uses a blue label on its packaging.' }] }];
  writeFileSync(sourcePath, JSON.stringify(source) + '\n');
  const sourceSha = hash(readFileSync(sourcePath));
  const questionsPath = join(folder, 'questions.json');
  const questions = selected.selected_ids.map((id: string) => ({ question_id: id, question_type: 'single-session-user',
    question: 'What label does the fictional project use?', answer: 'blue', answer_session_ids: ['fictional-demo'],
    haystack_session_ids: ['fictional-demo'], haystack_dates: ['2023/05/28 (Sun) 05:21'],
    haystack_sessions: [[{ role: 'user', content: source[0].turns[0].content }]] }));
  writeFileSync(questionsPath, JSON.stringify(questions) + '\n');
  selected.selected_dataset.sha256 = hash(readFileSync(questionsPath));
  selected.selected_source_details[questionId].source_sha256 = sourceSha;
  const selectionPath = join(folder, 'selection.json');
  writeFileSync(selectionPath, JSON.stringify(selected) + '\n');
  const sourceManifestPath = join(folder, 'source-manifest.json');
  writeFileSync(sourceManifestPath, JSON.stringify({ selected_ids: selected.selected_ids,
    selected_source_details: { [questionId]: { source_file: sourcePath, source_sha256: sourceSha } } }) + '\n');
  const { CUE_SYSTEM_PROMPT } = await import(pathToFileURL(join(productRoot, 'src/core/memory-cues/providers.ts')).href);
  const promptSha = hash(CUE_SYSTEM_PROMPT);
  const profile = (stage: 'construction' | 'replay', constructionReceiptSha?: string) => ({
    schema_version: 1, kind: 'source-only-development', experiment: 'longmemeval-m-source-only-dev-v2',
    question_id: questionId, attempt_id: 'synthetic-1', registration_sha256: hash(readFileSync(selectionPath)),
    source_manifest_sha256: hash(readFileSync(sourceManifestPath)), expected_product_sha: productSha,
    expected_package_sha256: expectedPackageSha, allocation: { id: `C1-${questionId}-${stage}`, usd: stage === 'construction' ? 95 : 5 },
    arm: 'C1', cue_mode: 'on', cue_pipeline_version: 'situation-v4', cue_prompt_sha256: promptSha,
    stage, ...(constructionReceiptSha ? { construction_receipt_sha256: constructionReceiptSha } : {}),
  });
  const inputs = (stage: 'construction' | 'replay', constructionReceiptSha?: string) => {
    const p = profile(stage, constructionReceiptSha);
    const profilePath = join(folder, `${stage}-profile.json`);
    const leafLedgerEntryPath = join(folder, `${stage}-ledger.json`);
    writeFileSync(profilePath, JSON.stringify(p));
    writeFileSync(leafLedgerEntryPath, JSON.stringify({ schema_version: 1, question_id: questionId,
      attempt_id: p.attempt_id, arm: 'C1', stage, profile_sha256: hash(readFileSync(profilePath)), allocation: p.allocation }));
    return { stage, profilePath, leafLedgerEntryPath, selectionPath, sourceManifestPath, productRoot,
      stageDir: join(folder, stage) };
  };
  const wire: Array<{ path: string; model: string }> = [];
  process.env.OPENROUTER_API_KEY = 'synthetic-openrouter-only';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input as Request, init);
    const body = await request.json() as Record<string, any>;
    const path = new URL(request.url).pathname;
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-openrouter-only');
    wire.push({ path, model: body.model });
    if (path === '/api/v1/embeddings') {
      expect(body.model).toBe('openai/text-embedding-3-large');
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ object: 'list', model: 'text-embedding-3-large',
        data: inputs.map((_: unknown, index: number) => ({ object: 'embedding', index,
          embedding: Array.from({ length: 1536 }, (__, i) => i === 0 ? 1 : 0) })),
        usage: { prompt_tokens: 1, total_tokens: 1, cost: 0.00000013, is_byok: false } });
    }
    expect(path).toBe('/api/v1/chat/completions');
    expect(body.model).toBe('anthropic/claude-sonnet-4.6');
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.provider).toEqual(developmentChatOptions(model)[model].provider);
    expect(body.max_tokens).toBe(1200);
    const cost = 0.00009;
    return Response.json({ id: 'synthetic-chat', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify([
        { family: 'scene', relation: 'situation_description', evidence_ref: 1,
          text: 'When choosing packaging for the fictional project, its stated blue label matters.' },
      ]) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22, cost, is_byok: false,
        cost_details: { upstream_inference_cost: cost } } });
  }) as typeof fetch;
  try {
    const construction = inputs('construction');
    const built = await runPilotLiveStage(construction, true);
    expect(built.status).toBe('complete');
    expect(built.transport).toBe('test-mock');
    expect(built.cue_build?.final_status).toBe('complete');
    expect(built.cue_build?.windows_pending).toBe(0);
    expect(built.cue_build?.ready).toBeGreaterThan(0);
    expect(built.cue_build?.empty).toBe(0);
    expect(built.guard?.chat_sealed).toBe(true);
    expect(built.guard?.failed_or_unreported_requests).toBe(0);
    expect(built.guard?.known_attributed_usd).toBeGreaterThan(0);
    expect(wire.filter(request => request.path === '/api/v1/chat/completions')).toHaveLength(1);
    const submission = JSON.parse(readFileSync(join(construction.stageDir, 'cue-submission.json'), 'utf8'));
    expect(submission.build_id).toBe(built.cue_build?.build_id);
    expect(submission.budget_owner_job_id).toBe(built.cue_build?.budget_owner_job_id);
    const passes = readFileSync(join(construction.stageDir, 'cue-passes.ndjson'), 'utf8');
    expect(passes).toContain('"event":"pass"');
    expect(passes).toContain('"event":"readback"');
    const manifest = JSON.parse(readFileSync(join(construction.stageDir, 'indexed/index-manifest.json'), 'utf8'));
    expect(manifest.cue_readback.status).toBe('uncalibrated-diagnostic');
    expect(manifest.cue_readback.embedding_signature).toBe(built.cue_build?.preview_signature);
    expect(manifest.resolved_config.cues.readMode).toBe('on');
    expect(manifest.resolved_config.cues.generationEnabled).toBe(false);
    expect(manifest.resolved_config.cues.pushEnabled).toBe(false);
    expect(manifest.resolved_config.cues.minSimilarity).toBe(-1);
    expect(manifest.resolved_config.cues.weight).toBe(0.25);
    expect(manifest.resolved_config.provider_chat_options).toEqual(developmentChatOptions(model));
    const constructionReceiptPath = join(construction.stageDir, 'stage-receipt.json');
    const replay = inputs('replay', hash(readFileSync(constructionReceiptPath)));
    const result = await runPilotLiveStage({ ...replay, constructionReceiptPath, selectedDatasetPath: questionsPath }, true);
    expect(result.status).toBe('complete');
    expect(result.transport).toBe('test-mock');
    expect(result.index_snapshot_sha256).toBe(built.index_snapshot_sha256);
    expect(JSON.parse(readFileSync(join(replay.stageDir, 'query-row.json'), 'utf8')).top_k).toBe(5);
    expect(existsSync(join(replay.stageDir, 'case-outcome.json'))).toBe(false);
    expect(wire.filter(request => request.path === '/api/v1/chat/completions')).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    rmSync(folder, { recursive: true, force: true });
  }
}, 120_000);
