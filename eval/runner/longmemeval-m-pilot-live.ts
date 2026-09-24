import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { buildPilotIndex, PILOT_SONNET_MODEL, runPilotBoundedCueBuild } from './longmemeval-m-pilot-build.ts';
import { replayPilotCase } from './longmemeval-m-pilot-replay.ts';
import { writePilotCaseOutcome, type PilotCaseOutcome } from './longmemeval-m-pilot-outcomes.ts';
import { developmentChatOptions, startSourceOnlyDevelopmentGuard } from './situation-recall-development.ts';
import { resolveSourceOnlyDevelopmentPolicy, SOURCE_ONLY_EMBEDDING_MODEL, SOURCE_ONLY_REFERENCE_EXPERIMENT, SOURCE_ONLY_V5_EXPERIMENT,
  type SourceOnlyDevelopmentProfile } from './situation-recall-experiment-policy.ts';
import { regressionPackageHash } from './situation-recall-provenance.ts';
import type { BrainEngine } from 'gbrain/engine';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const BASELINE_SHA = '6040075c6cb95be5881cc2e1b76ef7d71f4e5d29';
const BASELINE_PACKAGE = '78bbe78af2fac33a278740e84877e9c6c9f7a0f6a161113b1240549adf993b2b';
const HISTORICAL_V2_SHA = '470ccc49c33b44c4a4be4e60bc606c0ad04a4427';
const HISTORICAL_V2_PACKAGE = 'b302290974571ae846e26587cd37ecf6299b74c3bfe0d401aa22935ca3a84c97';
const REFERENCE_PRODUCT_SHA = 'f3249d1703772573006141224a4d06d9b8df7b41';
const V5_PRODUCT_SHA = '939232f1746381b4e932d620d6c709e29198f14c';
const V5_PROMPT_SHA = '44506bb8d722adb75fd4a0b1ec3a3265d71bb77de7e9a2db07214caee97c94d0';

export function assertMatchedProductDeclaration(declared: unknown, productSha: string): void {
  if (declared !== `github:garrytan/gbrain#${productSha}`) throw new Error('matched C0/C1 declared product pin mismatch');
}

interface StageOptions {
  stage: 'construction' | 'replay';
  profilePath: string;
  selectionPath: string;
  sourceManifestPath: string;
  productRoot: string;
  leafLedgerEntryPath: string;
  stageDir: string;
  constructionReceiptPath?: string;
  selectedDatasetPath?: string;
}

interface StageReceipt {
  schema_version: 1;
  status: 'complete' | 'incomplete';
  transport: 'provider' | 'test-mock';
  profile: SourceOnlyDevelopmentProfile;
  profile_sha256: string;
  leaf_ledger_entry_sha256: string;
  runtime: { bun: string; binary_sha256: string };
  selected_dataset_sha256: string;
  source_sha256: string;
  indexed_manifest_sha256?: string;
  index_snapshot_sha256?: string;
  construction_receipt_sha256?: string;
  query_row_sha256?: string;
  cue_readback_status?: 'uncalibrated-diagnostic';
  prepared_gateway_config_sha256?: string;
  cue_submission_sha256?: string;
  cue_passes_sha256?: string;
  cue_build?: { build_id: string; budget_owner_job_id: number; preview_signature: string;
    passes_sha256: string; final_status: string; windows_pending: number; ready: number; empty: number };
  guard_journal_sha256?: string;
  guard?: ReturnType<Awaited<ReturnType<typeof startSourceOnlyDevelopmentGuard>>['snapshot']>;
  incomplete_phase?: string;
}

function writeSealed(path: string, value: unknown): string {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  return hash(bytes);
}

async function buildPilotC1Cues(engine: BrainEngine, productRoot: string, profile: SourceOnlyDevelopmentProfile & { arm: 'C1' },
  sourcePath: string, sourceSha: string, expectedPages: number, passPath: string,
  assertCertain: () => Promise<void>, usage: () => NonNullable<StageReceipt['guard']>): Promise<NonNullable<StageReceipt['cue_build']>> {
  const cue = await import(pathToFileURL(join(productRoot, 'src/core/memory-cues/index.ts')).href);
  const { CUE_SYSTEM_PROMPT } = await import(pathToFileURL(join(productRoot, 'src/core/memory-cues/providers.ts')).href);
  const gateway = await import(pathToFileURL(join(productRoot, 'src/core/ai/gateway.ts')).href);
  const productConfig = await import(pathToFileURL(join(productRoot, 'src/core/config.ts')).href);
  const { operationsByName } = await import(pathToFileURL(join(productRoot, 'src/core/operations.ts')).href);
  if (cue.MEMORY_CUE_PROMPT_VERSION !== profile.cue_pipeline_version || hash(CUE_SYSTEM_PROMPT) !== profile.cue_prompt_sha256
    || !operationsByName.memory_cues?.localOnly) throw new Error('exact public cue API or prompt unavailable');
  const assertPreparedChat = async () => {
    await assertCertain();
    const expected = developmentChatOptions(PILOT_SONNET_MODEL);
    if (gateway.getChatModel() !== PILOT_SONNET_MODEL
      || !isDeepStrictEqual(gateway.requireConfig().provider_chat_options, expected)
      || !isDeepStrictEqual(productConfig.loadConfig()?.provider_chat_options, expected)) {
      throw new Error('C1 public build lost frozen Sonnet provider options before dispatch');
    }
  };
  await assertPreparedChat();
  const signature = cue.cueSignature(await cue.memoryCueColumn(engine));
  await engine.setConfig('chat_model', 'openrouter:anthropic/claude-sonnet-4.6');
  const context = { engine, config: { engine: 'pglite', embedding_model: SOURCE_ONLY_EMBEDDING_MODEL, embedding_dimensions: 1536 },
    sourceId: 'default', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  await operationsByName.memory_cues.handler(context, { action: 'configure', source_ids: ['default'], generation_enabled: true,
    read_mode: 'off', push_enabled: false, families: ['scene', 'horizon'], apply: true });
  const options = { sourceIds: ['default'], pageLimit: 1000, windowLimit: 8, includeBridge: false };
  const before = await cue.getMemoryCueStatus(engine, { sourceIds: ['default'] });
  if (before.builds.length || before.coverage.length || before.windowsPending || before.signature !== signature) {
    throw new Error('C1 cue construction requires a fresh source-only index');
  }
  const preview = await cue.previewMemoryCueBuild(engine, options);
  if (!preview.ready || preview.signature !== signature || preview.generationModel !== 'openrouter:anthropic/claude-sonnet-4.6'
    || preview.eligiblePages !== expectedPages || preview.eligiblePages < 1
    || preview.embeddingColumn?.embeddingModel !== SOURCE_ONLY_EMBEDDING_MODEL || preview.embeddingColumn?.dimensions !== 1536
    || !Number.isFinite(preview.costPreview?.maximumReservationUsdPerWindow)
    || preview.costPreview.maximumReservationUsdPerWindow <= 0
    || preview.costPreview.maximumReservationUsdPerWindow > profile.allocation.usd) {
    throw new Error('C1 source-only cue preview or bounded cost differs');
  }
  await assertPreparedChat();
  const admission = await cue.submitMemoryCueBuild(engine, { ...options, trustedLocal: true, maxUsd: profile.allocation.usd });
  writeSealed(join(dirname(passPath), 'cue-submission.json'), { build_id: admission.buildId,
    budget_owner_job_id: admission.budgetOwnerJobId, preview_signature: signature,
    expected_pages: expectedPages, frozen_source_sha256: sourceSha, allocation_id: profile.allocation.id,
    allocation_usd: profile.allocation.usd });
  const signal = AbortSignal.timeout(90 * 60_000);
  let lastRemaining = profile.allocation.usd * 100;
  let lastStatus: Awaited<ReturnType<typeof cue.getMemoryCueStatus>> | undefined;
  const readStatus = async () => {
    const status = await cue.getMemoryCueStatus(engine, { sourceIds: ['default'], buildId: admission.buildId });
    const owner = status.builds.find((item: { build_id: string }) => item.build_id === admission.buildId);
    if (!owner || owner.budget_owner_job_id !== admission.budgetOwnerJobId || owner.max_usd !== profile.allocation.usd
      || !Number.isFinite(owner.remaining_cents) || owner.remaining_cents > lastRemaining
      || !status.supported || status.signature !== signature || status.generationModel !== preview.generationModel
      || hash(readFileSync(sourcePath)) !== sourceSha) throw new Error('C1 build owner, accounting or frozen inputs changed');
    lastRemaining = owner.remaining_cents;
    lastStatus = status;
    return status;
  };
  await runPilotBoundedCueBuild({
    run: () => cue.runMemoryCueBuild(engine, { buildId: admission.buildId, signal }),
    assertCertain: async () => { await assertPreparedChat(); if (signal.aborted) throw new Error('C1 stage deadline exceeded');
      if (lastStatus) await readStatus(); },
    record: async (pass, attemptAtWindow) => {
      const accounting = usage();
      const text = JSON.stringify({ event: 'pass', build_id: admission.buildId, budget_owner_job_id: admission.budgetOwnerJobId,
        pass, attempt_at_window: attemptAtWindow, known_attributed_usd: accounting.known_attributed_usd,
        reserved_usd: accounting.reserved_usd, dispatched_requests: accounting.dispatched_requests,
        failed_or_unreported_requests: accounting.failed_or_unreported_requests }) + '\n';
      const fd = openSync(passPath, 'a', 0o600);
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      const status = await readStatus();
      const second = openSync(passPath, 'a', 0o600);
      try { writeFileSync(second, JSON.stringify({ event: 'readback', build_id: admission.buildId,
        windows_pending: status.windowsPending, owner_remaining_cents: lastRemaining }) + '\n'); fsyncSync(second); }
      finally { closeSync(second); }
    },
  });
  const complete = await readStatus();
  const owner = complete.builds.find((item: { build_id: string }) => item.build_id === admission.buildId);
  if (owner?.status !== 'complete' || complete.windowsPending !== 0 || complete.coverage.length === 0
    || complete.coverage.some((item: { status: string }) => !['ready', 'empty'].includes(item.status))) {
    throw new Error('C1 public cue build incomplete; no query admitted');
  }
  await operationsByName.memory_cues.handler(context, { action: 'configure', source_ids: ['default'], generation_enabled: false,
    read_mode: 'on', push_enabled: false, families: ['scene', 'horizon'],
    min_similarity: -1, weight: 0.25, apply: true });
  const readback = await cue.getMemoryCueStatus(engine, { sourceIds: ['default'], buildId: admission.buildId });
  if (readback.signature !== signature || readback.settings.generationEnabled || readback.settings.readMode !== 'on'
    || readback.settings.minSimilarity !== -1 || readback.settings.weight !== 0.25 || readback.settings.pushEnabled
    || JSON.stringify(readback.settings.sourceIds) !== '["default"]'
    || JSON.stringify(readback.settings.families) !== '["horizon","scene"]'
    || readback.windowsPending !== 0 || readback.builds.find((item: { build_id: string }) => item.build_id === admission.buildId)?.status !== 'complete') {
    throw new Error('C1 current encoder diagnostic readback failed before snapshot');
  }
  return { build_id: admission.buildId, budget_owner_job_id: admission.budgetOwnerJobId,
    preview_signature: signature, passes_sha256: hash(readFileSync(passPath)), final_status: owner.status,
    windows_pending: complete.windowsPending,
    ready: complete.coverage.filter((item: { status: string }) => item.status === 'ready').reduce((n: number, item: { count: number }) => n + item.count, 0),
    empty: complete.coverage.filter((item: { status: string }) => item.status === 'empty').reduce((n: number, item: { count: number }) => n + item.count, 0) };
}

export async function runPilotLiveStage(options: StageOptions, testOnlyMockTransport = false) {
  const profileBytes = readFileSync(options.profilePath);
  const profile = JSON.parse(profileBytes.toString()) as SourceOnlyDevelopmentProfile;
  resolveSourceOnlyDevelopmentPolicy(profile);
  const productSha = profile.arm === 'B' ? BASELINE_SHA : profile.expected_product_sha;
  const packageSha = profile.arm === 'B' ? BASELINE_PACKAGE : profile.expected_package_sha256;
  const reference = profile.experiment === SOURCE_ONLY_REFERENCE_EXPERIMENT;
  const v5 = profile.experiment === SOURCE_ONLY_V5_EXPERIMENT;
  if ((reference && profile.arm !== 'B' && productSha !== REFERENCE_PRODUCT_SHA)
    || (v5 && (profile.arm === 'B' || productSha !== V5_PRODUCT_SHA
      || profile.arm === 'C1' && profile.cue_prompt_sha256 !== V5_PROMPT_SHA))
    || (profile.arm !== 'B' && ([BASELINE_SHA, HISTORICAL_V2_SHA].includes(productSha)
      || [BASELINE_PACKAGE, HISTORICAL_V2_PACKAGE].includes(packageSha)))
    || profile.stage !== options.stage
    || profile.expected_product_sha !== productSha || profile.expected_package_sha256 !== packageSha
    || (options.stage === 'construction' && (options.selectedDatasetPath || options.constructionReceiptPath))
    || (options.stage === 'replay' && (!options.selectedDatasetPath || !options.constructionReceiptPath))) {
    throw new Error('matched arm, exact v3 product or source-only process boundary mismatch');
  }
  const registration = readFileSync(options.selectionPath);
  const selection = JSON.parse(registration.toString());
  const manifestBytes = readFileSync(options.sourceManifestPath);
  const sourceManifest = JSON.parse(manifestBytes.toString());
  const source = sourceManifest.selected_source_details?.[profile.question_id];
  if (hash(registration) !== profile.registration_sha256 || hash(manifestBytes) !== profile.source_manifest_sha256
    || !Array.isArray(selection.selected_ids) || selection.selected_ids.length !== 28
    || new Set(selection.selected_ids).size !== 28 || !selection.selected_ids.includes(profile.question_id)
    || JSON.stringify(selection.selected_ids) !== JSON.stringify(sourceManifest.selected_ids)
    || source?.source_sha256 !== selection.selected_source_details?.[profile.question_id]?.source_sha256
    || !source?.source_file || hash(readFileSync(source.source_file)) !== source.source_sha256
    || !existsSync(options.productRoot) || regressionPackageHash(realpathSync(options.productRoot)) !== packageSha) {
    throw new Error('frozen registration, source-only history or selected product package mismatch');
  }
  if (profile.arm !== 'B') {
    const declared = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')).dependencies?.gbrain;
    const root = realpathSync(options.productRoot);
    const { MEMORY_CUE_PROMPT_VERSION } = await import(pathToFileURL(join(root, 'src/core/memory-cues/types.ts')).href);
    const { buildCueWindows } = await import(pathToFileURL(join(root, 'src/core/memory-cues/windows.ts')).href);
    const probe = buildCueWindows([{ id: 1, chunk_text: 'x'.repeat(7800), modality: 'text' }]);
    assertMatchedProductDeclaration(declared, productSha);
    const { CUE_SYSTEM_PROMPT } = await import(pathToFileURL(join(root, 'src/core/memory-cues/providers.ts')).href);
    if (MEMORY_CUE_PROMPT_VERSION !== (v5 ? 'situation-v5' : reference ? 'situation-v4' : 'situation-v3')
      || (v5 && (hash(CUE_SYSTEM_PROMPT) !== V5_PROMPT_SHA || Buffer.byteLength(CUE_SYSTEM_PROMPT) !== 1822))
      || probe.length !== 1 || Buffer.byteLength(probe[0].text) !== 7800) {
      throw new Error(v5 ? 'matched C0/C1 require verified 939 v5 product, prompt and 8192-byte windows'
        : reference ? 'matched C0/C1 require verified f324 v4 product and 8192-byte windows'
        : 'matched C0/C1 require the same newly pinned 8192-byte v3 product, not historical 470');
    }
  }
  const ledgerBytes = readFileSync(options.leafLedgerEntryPath);
  const allocation = JSON.parse(ledgerBytes.toString());
  if (allocation.schema_version !== 1 || allocation.question_id !== profile.question_id
      || allocation.attempt_id !== profile.attempt_id || allocation.arm !== profile.arm || allocation.stage !== profile.stage
    || allocation.profile_sha256 !== hash(profileBytes)
    || allocation.allocation?.id !== profile.allocation.id || allocation.allocation.usd !== profile.allocation.usd
    || Object.keys(allocation).sort().join(',') !== 'allocation,arm,attempt_id,profile_sha256,question_id,schema_version,stage') {
    throw new Error('operator leaf ledger entry does not match sealed stage profile');
  }
  let construction: StageReceipt | undefined;
  let constructionSha: string | undefined;
  if (profile.stage === 'replay') {
    const bytes = readFileSync(options.constructionReceiptPath!);
    constructionSha = hash(bytes);
    construction = JSON.parse(bytes.toString()) as StageReceipt;
    if (constructionSha !== profile.construction_receipt_sha256 || construction.status !== 'complete'
      || construction.transport !== (testOnlyMockTransport ? 'test-mock' : 'provider') || construction.profile.stage !== 'construction'
      || construction.profile.arm !== profile.arm || construction.profile.question_id !== profile.question_id
      || construction.profile.attempt_id !== profile.attempt_id
      || construction.profile.experiment !== profile.experiment
      || construction.profile.registration_sha256 !== profile.registration_sha256
      || construction.profile.source_manifest_sha256 !== profile.source_manifest_sha256
      || construction.profile.expected_product_sha !== profile.expected_product_sha
      || construction.profile.expected_package_sha256 !== profile.expected_package_sha256
      || construction.source_sha256 !== source.source_sha256
      || (profile.arm === 'C1' && (construction.cue_readback_status !== 'uncalibrated-diagnostic'
        || construction.profile.arm !== 'C1' || construction.profile.cue_pipeline_version !== profile.cue_pipeline_version
        || construction.profile.cue_prompt_sha256 !== profile.cue_prompt_sha256
        || construction.cue_build?.final_status !== 'complete'
        || construction.cue_build.windows_pending !== 0))
      || !construction.indexed_manifest_sha256 || !construction.index_snapshot_sha256) {
      throw new Error('replay is not linked to a completed matching provider construction receipt');
    }
  }
  const directory = resolve(options.stageDir);
  if (existsSync(directory)) throw new Error('stage directory must be new; an attempt cannot overwrite earlier receipts');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const journalPath = join(directory, 'guard.ndjson');
  const result: StageReceipt = { schema_version: 1, status: 'incomplete', transport: testOnlyMockTransport ? 'test-mock' : 'provider',
    profile, profile_sha256: hash(profileBytes), leaf_ledger_entry_sha256: hash(ledgerBytes),
    runtime: { bun: Bun.version, binary_sha256: hash(readFileSync(process.execPath)) },
    selected_dataset_sha256: selection.selected_dataset.sha256, source_sha256: source.source_sha256,
    ...(profile.arm === 'C1' ? { cue_readback_status: 'uncalibrated-diagnostic' as const } : {}),
    ...(constructionSha ? { construction_receipt_sha256: constructionSha } : {}) };
  let phase = 'guard_start';
  let guard: Awaited<ReturnType<typeof startSourceOnlyDevelopmentGuard>> | undefined;
  let preparedConfigPath: string | undefined;
  const previousNamespace = { HOME: process.env.HOME, GBRAIN_HOME: process.env.GBRAIN_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  try {
    if (profile.arm === 'C1') {
      phase = 'prepared_config';
      const home = join(directory, 'c1-home');
      mkdirSync(home, { mode: 0o700 });
      process.env.HOME = home;
      process.env.GBRAIN_HOME = home;
      process.env.XDG_CONFIG_HOME = join(home, '.config');
      const productConfig = await import(pathToFileURL(join(realpathSync(options.productRoot), 'src/core/config.ts')).href);
      preparedConfigPath = productConfig.configPath();
      if (preparedConfigPath !== join(home, '.gbrain', 'config.json')) throw new Error('C1 config resolves outside isolated stage');
      mkdirSync(dirname(preparedConfigPath), { recursive: true, mode: 0o700 });
      result.prepared_gateway_config_sha256 = writeSealed(preparedConfigPath, { engine: 'pglite',
        embedding_model: SOURCE_ONLY_EMBEDDING_MODEL, embedding_dimensions: 1536,
        chat_model: PILOT_SONNET_MODEL, provider_chat_options: developmentChatOptions(PILOT_SONNET_MODEL),
        database_path: options.stage === 'construction' ? join(directory, 'indexed', 'index') : join(directory, 'query-db') });
    }
    phase = 'guard_start';
    guard = await startSourceOnlyDevelopmentGuard(profile, { journalPath, verifiedPackagePath: options.productRoot });
    const assertGuard = async () => {
      const snapshot = guard!.snapshot();
      const guardedProfile = snapshot.policy_context?.profile as SourceOnlyDevelopmentProfile | undefined;
      if (guardedProfile?.question_id !== profile.question_id
        || guardedProfile.stage !== profile.stage || snapshot.limits.max_usd !== profile.allocation.usd
        || snapshot.stage_deadline_exceeded || snapshot.failed_or_unreported_requests !== 0
        || snapshot.reserved_usd !== 0 || snapshot.requests_with_unknown_byok_status !== 0
        || snapshot.requests_with_unreported_byok_cost !== 0 || snapshot.rejected_requests !== 0
        || (preparedConfigPath && hash(readFileSync(preparedConfigPath)) !== result.prepared_gateway_config_sha256)) {
        throw new Error('source-only guard inactive or uncertain');
      }
    };
    phase = options.stage;
    const gateway = await import(pathToFileURL(join(realpathSync(options.productRoot), 'src/core/ai/gateway.ts')).href);
    gateway.resetGateway();
    if (options.stage === 'construction') {
      const indexed = join(directory, 'indexed');
      const built = await buildPilotIndex({ sourcePath: source.source_file, expectedSourceSha256: source.source_sha256,
        productRoot: options.productRoot, expectedProductSha: productSha, expectedPackageSha256: packageSha,
        embeddingModel: SOURCE_ONLY_EMBEDDING_MODEL, embeddingDimensions: 1536, outputDir: indexed, mode: 'live',
        cueMode: profile.arm === 'C1' ? 'on' : 'off', ...(preparedConfigPath ? { preparedConfigPath } : {}) },
      { assertAuthorized: assertGuard, ...(profile.arm === 'C1' ? { buildCues: async (engine: unknown, _sourceIds: readonly string[], expectedPages: number) => {
        result.cue_build = await buildPilotC1Cues(engine as BrainEngine, options.productRoot, profile,
          source.source_file, source.source_sha256, expectedPages, join(directory, 'cue-passes.ndjson'), assertGuard,
          () => guard!.snapshot());
        guard!.sealConstruction();
        return { embedding_signature: result.cue_build.preview_signature };
      } } : {}) });
      result.indexed_manifest_sha256 = hash(readFileSync(join(indexed, 'index-manifest.json')));
      result.index_snapshot_sha256 = built.index_snapshot.sha256;
    } else {
      const indexDir = dirname(options.constructionReceiptPath!);
      const indexed = join(indexDir, 'indexed');
      if (profile.arm === 'C1') {
        const indexManifest = JSON.parse(readFileSync(join(indexed, 'index-manifest.json'), 'utf8'));
        if (hash(readFileSync(join(indexed, 'index-manifest.json'))) !== construction!.indexed_manifest_sha256
          || indexManifest.cue_mode !== 'on' || indexManifest.cue_readback?.status !== 'uncalibrated-diagnostic'
          || indexManifest.cue_readback.embedding_signature !== construction!.cue_build?.preview_signature) {
          throw new Error('C1 frozen uncalibrated readback differs from completed source-only build');
        }
      }
      const row = await replayPilotCase({ indexDir: indexed, productRoot: options.productRoot,
        expectedProductSha: productSha, expectedPackageSha256: packageSha,
        expectedManifestSha256: construction!.indexed_manifest_sha256!, expectedSourceSha256: source.source_sha256,
        workingDatabase: join(directory, 'query-db'), mode: 'live', selectedDatasetPath: options.selectedDatasetPath!,
        selectionManifestPath: options.selectionPath, questionId: profile.question_id,
        ...(preparedConfigPath ? { preparedConfigPath } : {}) }, { assertAuthorized: assertGuard });
      result.indexed_manifest_sha256 = construction!.indexed_manifest_sha256;
      result.index_snapshot_sha256 = construction!.index_snapshot_sha256;
      result.query_row_sha256 = writeSealed(join(directory, 'query-row.json'), row);
    }
    const snapshot = guard.snapshot();
    if (snapshot.stage_deadline_exceeded || snapshot.failed_or_unreported_requests !== 0 || snapshot.reserved_usd !== 0
      || snapshot.requests_with_unknown_byok_status !== 0 || snapshot.requests_with_unreported_byok_cost !== 0
      || snapshot.rejected_requests !== 0) throw new Error('guard accounting incomplete; case remains incomplete');
    result.status = 'complete';
  } catch {
    result.incomplete_phase = phase;
    throw new Error(`pilot ${phase} incomplete; stage receipt retained`);
  } finally {
    if (guard) { result.guard = guard.snapshot(); guard.restore(); }
    for (const [key, value] of Object.entries(previousNamespace)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (existsSync(journalPath)) result.guard_journal_sha256 = hash(readFileSync(journalPath));
    const submissionPath = join(directory, 'cue-submission.json');
    const passesPath = join(directory, 'cue-passes.ndjson');
    if (existsSync(submissionPath)) result.cue_submission_sha256 = hash(readFileSync(submissionPath));
    if (existsSync(passesPath)) result.cue_passes_sha256 = hash(readFileSync(passesPath));
    writeSealed(join(directory, 'stage-receipt.json'), result);
  }
  if (options.stage === 'replay' && !testOnlyMockTransport) {
    const row = JSON.parse(readFileSync(join(directory, 'query-row.json'), 'utf8'));
    const outcome: PilotCaseOutcome = { schema_version: 2, arm: profile.arm, mode: 'live', question_id: profile.question_id,
      selected_dataset_sha256: selection.selected_dataset.sha256, source_sha256: source.source_sha256,
      indexed_manifest_sha256: construction!.indexed_manifest_sha256!, index_snapshot_sha256: construction!.index_snapshot_sha256!,
      product_sha: productSha, product_package_sha256: packageSha,
      construction_stage_receipt_path: options.constructionReceiptPath, replay_stage_receipt_path: join(directory, 'stage-receipt.json'),
      build_guard_receipt_sha256: constructionSha, replay_guard_receipt_sha256: hash(readFileSync(join(directory, 'stage-receipt.json'))), row };
    writePilotCaseOutcome(join(directory, 'case-outcome.json'), outcome);
  }
  return result;
}

if (import.meta.main) {
  const [stage, ...args] = process.argv.slice(2);
  if (stage !== 'construction' && stage !== 'replay' || args.length % 2 !== 0) throw new Error('usage: construction|replay --profile <path> --selection <path> --source-manifest <path> --product-root <path> --leaf-ledger-entry <path> --stage-dir <new-dir> [--construction-receipt <path> --selected-dataset <path>]');
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !args[i + 1] || flags.has(args[i])) throw new Error('duplicate or invalid pilot CLI flag');
    flags.set(args[i], args[i + 1]);
  }
  const required = ['--profile', '--selection', '--source-manifest', '--product-root', '--leaf-ledger-entry', '--stage-dir'];
  const mandatory = stage === 'replay' ? [...required, '--construction-receipt', '--selected-dataset'] : required;
  if (mandatory.some(key => !flags.has(key)) || [...flags.keys()].some(key => !mandatory.includes(key))) throw new Error('pilot stage missing or unknown required flags');
  const result = await runPilotLiveStage({ stage, profilePath: flags.get('--profile')!, selectionPath: flags.get('--selection')!,
    sourceManifestPath: flags.get('--source-manifest')!, productRoot: flags.get('--product-root')!,
    leafLedgerEntryPath: flags.get('--leaf-ledger-entry')!,
    stageDir: flags.get('--stage-dir')!, ...(stage === 'replay' ? { constructionReceiptPath: flags.get('--construction-receipt')!,
      selectedDatasetPath: flags.get('--selected-dataset')! } : {}) });
  console.log(JSON.stringify({ status: result.status, arm: result.profile.arm, stage: result.profile.stage,
    question_id: result.profile.question_id, indexed_manifest_sha256: result.indexed_manifest_sha256,
    guard_journal_sha256: result.guard_journal_sha256 }));
}
