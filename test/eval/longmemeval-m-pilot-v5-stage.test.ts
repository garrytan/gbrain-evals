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
const productSha = '939232f1746381b4e932d620d6c709e29198f14c';
const packageSha = '74974a32d4bfa34f26ed7e15d5eb3c301cb9000d8e90a1667041cbbde8587aa0';
const promptSha = '44506bb8d722adb75fd4a0b1ec3a3265d71bb77de7e9a2db07214caee97c94d0';

test('current v5 consumer is the exact Git-installed 939 package, not the archive or old control', () => {
  const declared = JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')).dependencies.gbrain;
  expect(declared).toBe(`github:garrytan/gbrain#${productSha}`);
  expect(regressionPackageHash(productRoot)).toBe(packageSha);
  expect(() => assertMatchedProductDeclaration(declared, productSha)).not.toThrow();
  expect(() => assertMatchedProductDeclaration('github:garrytan/gbrain#f3249d1703772573006141224a4d06d9b8df7b41', productSha)).toThrow();
  expect(() => assertMatchedProductDeclaration('file:./vendor/gbrain', productSha)).toThrow();
});

test.each(['C0', 'C1'] as const)('current v5 %s public construction closes a snapshot before separate embedding-only replay', async arm => {
  const folder = mkdtempSync(join(tmpdir(), 'lme-v5-public-'));
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
  expect(hash(CUE_SYSTEM_PROMPT)).toBe(promptSha);
  expect(Buffer.byteLength(CUE_SYSTEM_PROMPT)).toBe(1822);
  const inputs = (stage: 'construction' | 'replay', constructionReceiptSha?: string) => {
    const p = { schema_version: 1, kind: 'source-only-development', experiment: 'longmemeval-m-source-only-dev-v3',
      question_id: questionId, attempt_id: 'synthetic-1', registration_sha256: hash(readFileSync(selectionPath)),
      source_manifest_sha256: hash(readFileSync(sourceManifestPath)), expected_product_sha: productSha,
      expected_package_sha256: packageSha, allocation: { id: `${arm}-${questionId}-${stage}`,
        usd: stage === 'construction' ? arm === 'C1' ? 95 : 9 : arm === 'C1' ? 5 : 1 }, arm,
      ...(arm === 'C1' ? { cue_mode: 'on', cue_pipeline_version: 'situation-v5', cue_prompt_sha256: promptSha } : { cue_mode: 'off' }),
      stage, ...(constructionReceiptSha ? { construction_receipt_sha256: constructionReceiptSha } : {}) };
    const profilePath = join(folder, `${stage}-profile.json`);
    const leafLedgerEntryPath = join(folder, `${stage}-ledger.json`);
    writeFileSync(profilePath, JSON.stringify(p));
    writeFileSync(leafLedgerEntryPath, JSON.stringify({ schema_version: 1, question_id: questionId,
      attempt_id: p.attempt_id, arm, stage, profile_sha256: hash(readFileSync(profilePath)), allocation: p.allocation }));
    return { stage, profilePath, leafLedgerEntryPath, selectionPath, sourceManifestPath, productRoot, stageDir: join(folder, stage) };
  };
  const wire: string[] = [];
  let replaying = false;
  process.env.OPENROUTER_API_KEY = 'synthetic-v5-only';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input as Request, init);
    const body = await request.json() as Record<string, any>;
    const path = new URL(request.url).pathname;
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-v5-only');
    wire.push(path);
    if (path === '/api/v1/embeddings') {
      expect(body.model).toBe('openai/text-embedding-3-large');
      expect(body.dimensions).toBe(1536);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ object: 'list', model: 'text-embedding-3-large',
        data: inputs.map((_: unknown, index: number) => ({ object: 'embedding', index,
          embedding: Array.from({ length: 1536 }, (__, i) => i === 0 ? 1 : 0) })),
        usage: { prompt_tokens: 1, total_tokens: 1, cost: 0.00000013, is_byok: false } });
    }
    expect(arm).toBe('C1');
    expect(replaying).toBe(false);
    expect(path).toBe('/api/v1/chat/completions');
    expect(body.model).toBe('anthropic/claude-sonnet-4.6');
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.provider).toEqual(developmentChatOptions(model)[model].provider);
    expect(body.max_tokens).toBe(1200);
    expect(body.messages[0].content).toBe(CUE_SYSTEM_PROMPT);
    const content = JSON.parse(body.messages[1].content);
    expect(content.includeBridge).toBe(false);
    expect(content.evidence[0].id).toBe(1);
    return Response.json({ id: 'synthetic-v5-chat', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ scene: { evidence_ref: 1,
        text: 'When choosing packaging for the fictional project, its stated blue label matters.' },
        association_1: null, association_2: null, association_3: null }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22, cost: 0.00009, is_byok: false } });
  }) as typeof fetch;
  try {
    const construction = inputs('construction');
    const originalProfile = readFileSync(construction.profilePath);
    for (const expected_product_sha of ['f3249d1703772573006141224a4d06d9b8df7b41', '1def241df4a10bcbe2563113dbdc3cb601d588ee']) {
      writeFileSync(construction.profilePath, JSON.stringify({ ...JSON.parse(originalProfile.toString()), expected_product_sha }));
      await expect(runPilotLiveStage(construction, true)).rejects.toThrow('matched arm');
      expect(existsSync(construction.stageDir)).toBe(false);
      expect(wire).toHaveLength(0);
    }
    writeFileSync(construction.profilePath, originalProfile);
    const built = await runPilotLiveStage(construction, true);
    expect(built.status).toBe('complete');
    expect(built.transport).toBe('test-mock');
    expect(built.guard?.chat_sealed).toBe(true);
    expect(built.guard?.failed_or_unreported_requests).toBe(0);
    expect(built.guard?.reserved_usd).toBe(0);
    expect(built.guard?.known_attributed_usd).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(join(construction.stageDir, 'indexed/index-manifest.json'), 'utf8'));
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.sources[0].chunks.length).toBeGreaterThan(0);
    expect(manifest.cue_mode).toBe(arm === 'C1' ? 'on' : 'off');
    if (arm === 'C1') {
      expect(built.cue_build?.final_status).toBe('complete');
      expect(built.cue_build?.windows_pending).toBe(0);
      expect(built.cue_build?.ready).toBeGreaterThan(0);
      expect(built.cue_build?.empty).toBe(0);
      const submission = JSON.parse(readFileSync(join(construction.stageDir, 'cue-submission.json'), 'utf8'));
      expect(submission.build_id).toBe(built.cue_build?.build_id);
      expect(submission.budget_owner_job_id).toBe(built.cue_build?.budget_owner_job_id);
      expect(readFileSync(join(construction.stageDir, 'cue-passes.ndjson'), 'utf8')).toContain('"event":"readback"');
      expect(manifest.cue_readback.status).toBe('uncalibrated-diagnostic');
      expect(manifest.resolved_config.cues.readMode).toBe('on');
      expect(manifest.resolved_config.cues.generationEnabled).toBe(false);
      expect(manifest.resolved_config.cues.pushEnabled).toBe(false);
      expect(manifest.resolved_config.cues.minSimilarity).toBe(-1);
      expect(manifest.resolved_config.cues.weight).toBe(0.25);
      expect(manifest.resolved_config.provider_chat_options).toEqual(developmentChatOptions(model));
      const persisted = JSON.parse(readFileSync(join(construction.stageDir, 'c1-home/.gbrain/config.json'), 'utf8'));
      expect(persisted.provider_chat_options).toEqual(developmentChatOptions(model));
    } else expect(built.cue_build).toBeUndefined();
    const constructionReceiptPath = join(construction.stageDir, 'stage-receipt.json');
    const replay = inputs('replay', hash(readFileSync(constructionReceiptPath)));
    replaying = true;
    const result = await runPilotLiveStage({ ...replay, constructionReceiptPath, selectedDatasetPath: questionsPath }, true);
    expect(result.status).toBe('complete');
    expect(result.index_snapshot_sha256).toBe(built.index_snapshot_sha256);
    const row = JSON.parse(readFileSync(join(replay.stageDir, 'query-row.json'), 'utf8'));
    expect(row.top_k).toBe(5);
    expect(row.retrieved).toEqual(['fictional-demo']);
    expect(row.indexed_evidence.returned_chunks.length).toBeLessThanOrEqual(5);
    expect(existsSync(join(replay.stageDir, 'case-outcome.json'))).toBe(false);
    expect(wire.filter(path => path === '/api/v1/chat/completions')).toHaveLength(arm === 'C1' ? 1 : 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    rmSync(folder, { recursive: true, force: true });
  }
}, 120_000);
