import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cat36SnapshotHash } from './cat36-snapshot.ts';
import { regressionPackageHash } from './situation-recall-provenance.ts';
import { renderSession, PINNED_SEARCH_CONFIG } from './longmemeval.ts';
import { developmentChatOptions } from './situation-recall-development.ts';

const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export interface PilotSource {
  occurrence_index: number;
  session_id: string;
  date: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface PilotIndexManifest {
  schema_version: 2;
  evidence_protocol: 'indexed-projection-v2';
  source_sha256: string;
  product_sha: string;
  product_package_sha256: string;
  product_version: string;
  embedding_model: string;
  embedding_dimensions: number;
  search_config: Record<string, string>;
  cue_config: Record<string, string>;
  resolved_config: { search: Record<string, unknown>; cues: Record<string, unknown>; embedding_model: string; embedding_dimensions: number;
    chat_model?: string; provider_chat_options?: Record<string, unknown> };
  mode: 'offline' | 'live';
  cue_mode: 'off' | 'on';
  cue_hook: 'off' | 'external-reviewed';
  cue_readback?: { status: 'uncalibrated-diagnostic'; embedding_signature: string; min_similarity: -1; weight: 0.25 };
  index_snapshot: { path: 'index'; sha256: string };
  construction_ms: number;
  sources: Array<{ slug: string; session_id: string; date: string; occurrence_index: number; text_sha256: string;
    chunks: Array<{ id: number; text: string; text_sha256: string; chunk_source: string;
      raw_alignment: 'exact' | 'whitespace_reflow' | 'nonliteral' | 'ambiguous'; start: number | null; end: number | null }> }>;
}

export interface PilotBuildOptions {
  sourcePath: string;
  expectedSourceSha256: string;
  productRoot: string;
  expectedProductSha: string;
  expectedPackageSha256: string;
  embeddingModel: string;
  embeddingDimensions: number;
  outputDir: string;
  mode: 'offline' | 'live';
  cueMode?: 'off' | 'on';
  preparedConfigPath?: string;
}

export const PILOT_CUE_OFF_CONFIG = Object.freeze({ 'memory.cues.generation_enabled': 'false',
  'memory.cues.read': 'off', 'memory.cues.push': 'false' });
const BASELINE_604_PACKAGE_SHA256 = '78bbe78af2fac33a278740e84877e9c6c9f7a0f6a161113b1240549adf993b2b';
export const PILOT_SONNET_MODEL = 'openrouter:anthropic/claude-sonnet-4.6';
const RESUMABLE_CUE_FAILURES = new Set(['invalid_output', 'unsupported_cue', 'unsupported_relation', 'incomplete_output']);

export async function configurePilotC1Gateway(gateway: Pick<typeof import('gbrain/ai/gateway'),
  'configureGateway' | 'requireConfig' | 'getChatModel'>, productRoot: string,
  preparedConfigPath: string, env: NodeJS.ProcessEnv) {
  const productConfig = await import(pathToFileURL(join(productRoot, 'src/core/config.ts')).href);
  if (realpathSync(productConfig.configPath()) !== realpathSync(preparedConfigPath)) {
    throw new Error('C1 gateway resolves outside its prepared isolated config');
  }
  const expected = developmentChatOptions(PILOT_SONNET_MODEL);
  const prepared = JSON.parse(readFileSync(preparedConfigPath, 'utf8'));
  const effective = productConfig.loadConfig();
  if (prepared.engine !== 'pglite' || prepared.embedding_model !== 'openrouter:openai/text-embedding-3-large'
    || prepared.embedding_dimensions !== 1536 || prepared.chat_model !== PILOT_SONNET_MODEL
    || !isDeepStrictEqual(prepared.provider_chat_options, expected)
    || effective?.embedding_model !== prepared.embedding_model || effective?.embedding_dimensions !== 1536
    || effective?.chat_model !== PILOT_SONNET_MODEL || !isDeepStrictEqual(effective.provider_chat_options, expected)) {
    throw new Error('C1 prepared gateway config or public resolver differs from frozen Sonnet options');
  }
  gateway.configureGateway({ embedding_model: prepared.embedding_model, embedding_dimensions: 1536,
    chat_model: PILOT_SONNET_MODEL, provider_chat_options: expected, env });
  if (gateway.getChatModel() !== PILOT_SONNET_MODEL
    || !isDeepStrictEqual(gateway.requireConfig().provider_chat_options, expected)) {
    throw new Error('C1 resolved gateway lost its frozen provider chat options');
  }
  return { provider_chat_options: expected, prepared_config_sha256: hash(readFileSync(preparedConfigPath)) };
}

export async function runPilotBoundedCueBuild(options: {
  run(): Promise<{ status: string; windowsProcessed: number; reason?: string }>;
  assertCertain(): Promise<void>;
  record(result: { status: string; windowsProcessed: number; reason?: string }, attemptAtWindow: number): Promise<void>;
}) {
  let failuresAtWindow = 0;
  for (;;) {
    await options.assertCertain();
    const result = await options.run();
    if (!Number.isInteger(result.windowsProcessed) || result.windowsProcessed < 0) throw new Error('invalid cue build progress');
    if (result.windowsProcessed > 0) failuresAtWindow = 0;
    if (result.status === 'failed' && RESUMABLE_CUE_FAILURES.has(result.reason ?? '')) failuresAtWindow++;
    await options.record(result, failuresAtWindow);
    await options.assertCertain();
    if (result.status === 'complete') return;
    if (result.status === 'partial' && result.windowsProcessed > 0) continue;
    if (result.status === 'failed' && RESUMABLE_CUE_FAILURES.has(result.reason ?? '') && failuresAtWindow <= 2) continue;
    throw new Error(`cue construction incomplete: ${result.status}/${result.reason ?? 'unknown'}`);
  }
}

export async function readPilotResolvedConfig(engine: { getConfig(key: string): Promise<string | null> }, productRoot: string,
  cueMode: 'off' | 'on' = 'off', cueReadback?: PilotIndexManifest['cue_readback']) {
  const cueConfig = cueMode === 'on'
    ? { ...PILOT_CUE_OFF_CONFIG, 'memory.cues.read': 'on', 'memory.cues.sources': '["default"]',
      'memory.cues.families': '["horizon","scene"]', 'memory.cues.min_similarity': '-1', 'memory.cues.weight': '0.25',
      'memory.cues.read_calibration_signature': cueReadback?.embedding_signature ?? '' }
    : PILOT_CUE_OFF_CONFIG;
  if (cueMode === 'on' && (cueReadback?.status !== 'uncalibrated-diagnostic'
    || cueReadback.min_similarity !== -1 || cueReadback.weight !== 0.25 || !cueReadback.embedding_signature)) {
    throw new Error('C1 frozen uncalibrated diagnostic read setting required before readback');
  }
  const pinned = { ...PINNED_SEARCH_CONFIG, ...cueConfig,
    embedding_model: 'openrouter:openai/text-embedding-3-large', embedding_dimensions: '1536' };
  for (const [key, value] of Object.entries(pinned)) if (await engine.getConfig(key) !== value) throw new Error(`pilot config readback differs: ${key}`);
  const modes = await import(pathToFileURL(join(productRoot, 'src/core/search/mode.ts')).href);
  const search = modes.resolveSearchMode(await modes.loadSearchModeConfig(engine));
  if (search.resolved_mode !== 'balanced' || search.reranker_enabled !== false || search.autocut !== false) {
    throw new Error('resolved pilot search mode is not balanced with reranking and autocut off');
  }
  const cueModule = join(productRoot, 'src/core/memory-cues/settings.ts');
  if (!existsSync(cueModule)) {
    if (cueMode !== 'off') throw new Error('C1 cue module missing');
    if (regressionPackageHash(productRoot) !== BASELINE_604_PACKAGE_SHA256) throw new Error('unrecognized product without cue settings');
    return { search, cues: { capability: 'absent-in-verified-baseline-604' },
      embedding_model: pinned.embedding_model, embedding_dimensions: 1536 };
  }
  const cues = await import(pathToFileURL(cueModule).href);
  const cueSettings = await cues.loadMemoryCueSettings(engine);
  if (cueSettings.generationEnabled || cueSettings.pushEnabled
    || (cueMode === 'off' ? cueSettings.readMode !== 'off'
      : cueSettings.readMode !== 'on' || cueSettings.minSimilarity !== -1 || cueSettings.weight !== 0.25
        || JSON.stringify(cueSettings.sourceIds) !== '["default"]'
        || JSON.stringify(cueSettings.families) !== '["horizon","scene"]')) {
    throw new Error('resolved pilot cue mode or frozen C1 diagnostic readback changed');
  }
  if (cueMode === 'on') {
    const productConfig = await import(pathToFileURL(join(productRoot, 'src/core/config.ts')).href);
    const gateway = await import(pathToFileURL(join(productRoot, 'src/core/ai/gateway.ts')).href);
    const expected = developmentChatOptions(PILOT_SONNET_MODEL);
    const prepared = JSON.parse(readFileSync(productConfig.configPath(), 'utf8'));
    const loaded = productConfig.loadConfig();
    if (await engine.getConfig('chat_model') !== PILOT_SONNET_MODEL
      || Object.keys(prepared).sort().join(',') !== 'chat_model,database_path,embedding_dimensions,embedding_model,engine,provider_chat_options'
      || prepared.chat_model !== PILOT_SONNET_MODEL || !isDeepStrictEqual(prepared.provider_chat_options, expected)
      || loaded?.chat_model !== PILOT_SONNET_MODEL || !isDeepStrictEqual(loaded.provider_chat_options, expected)
      || gateway.getChatModel() !== PILOT_SONNET_MODEL
      || !isDeepStrictEqual(gateway.requireConfig().provider_chat_options, expected)) {
      throw new Error('C1 persisted config, resolved gateway or DB chat mode differs from frozen Sonnet options');
    }
    return { search, cues: cueSettings, embedding_model: pinned.embedding_model, embedding_dimensions: 1536,
      chat_model: PILOT_SONNET_MODEL, provider_chat_options: expected };
  }
  return { search, cues: cueSettings, embedding_model: pinned.embedding_model, embedding_dimensions: 1536 };
}

export async function buildPilotIndex(options: PilotBuildOptions, admission?: {
  assertAuthorized(): Promise<void>;
  buildCues?(engine: unknown, sourceIds: readonly string[], expectedPages: number): Promise<{ embedding_signature: string }>;
}): Promise<PilotIndexManifest> {
  if (!/^[a-f0-9]{64}$/.test(options.expectedSourceSha256) || !/^[a-f0-9]{64}$/.test(options.expectedPackageSha256)
    || !/^[a-f0-9]{40}$/.test(options.expectedProductSha) || options.embeddingModel !== 'openrouter:openai/text-embedding-3-large'
    || options.embeddingDimensions !== 1536 || !['offline', 'live'].includes(options.mode)) throw new Error('invalid frozen pilot build identity');
  if (options.mode === 'live' && !admission) throw new Error('live pilot build requires root-owned financial admission');
  const cueMode = options.cueMode ?? 'off';
  if (cueMode === 'on' ? options.mode !== 'live' || !admission?.buildCues || !options.preparedConfigPath
    : Boolean(admission?.buildCues || options.preparedConfigPath)) {
    throw new Error('C1 cue build requires live guarded construction and frozen diagnostic read setting');
  }
  await admission?.assertAuthorized();
  const productRoot = resolve(options.productRoot);
  if (regressionPackageHash(productRoot) !== options.expectedPackageSha256) throw new Error('product package hash mismatch');
  const product = JSON.parse(readFileSync(join(productRoot, 'package.json'), 'utf8'));
  if (product.name !== 'gbrain' || !product.version) throw new Error('invalid product package');
  const raw = readFileSync(options.sourcePath);
  if (hash(raw) !== options.expectedSourceSha256) throw new Error('source-only bytes changed');
  const sources = JSON.parse(raw.toString()) as PilotSource[];
  if (!Array.isArray(sources) || !sources.length) throw new Error('empty source history');
  const outputDir = resolve(options.outputDir);
  if (existsSync(outputDir)) throw new Error('pilot build requires a fresh output directory');
  const constructionStarted = performance.now();
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const importModule = await import(pathToFileURL(join(productRoot, 'src/core/import-file.ts')).href);
  const engineModule = await import(pathToFileURL(join(productRoot, 'src/core/pglite-engine.ts')).href);
  const gateway = await import(pathToFileURL(join(productRoot, 'src/core/ai/gateway.ts')).href);
  if (cueMode === 'on') await configurePilotC1Gateway(gateway, productRoot, options.preparedConfigPath!, process.env);
  else gateway.configureGateway({ embedding_model: options.embeddingModel, embedding_dimensions: options.embeddingDimensions,
    env: options.mode === 'offline' ? {} : process.env });
  const engine = new engineModule.PGLiteEngine();
  await engine.connect({ database_path: join(outputDir, 'index') });
  await engine.initSchema();
  const mappings: PilotIndexManifest['sources'] = [];
  let resolvedConfig: PilotIndexManifest['resolved_config'] | null = null;
  let cueReadback: PilotIndexManifest['cue_readback'];
  try {
    for (const [key, value] of Object.entries(PINNED_SEARCH_CONFIG)) await engine.setConfig(key, value);
    for (const [key, value] of Object.entries(PILOT_CUE_OFF_CONFIG)) await engine.setConfig(key, value);
    await engine.setConfig('embedding_model', options.embeddingModel);
    await engine.setConfig('embedding_dimensions', String(options.embeddingDimensions));
    for (const [index, source] of sources.entries()) {
      if (source.occurrence_index !== index || !source.session_id || typeof source.date !== 'string'
        || Object.keys(source).sort().join(',') !== 'date,occurrence_index,session_id,turns'
        || !Array.isArray(source.turns) || source.turns.some(turn => !['user', 'assistant'].includes(turn.role)
          || typeof turn.content !== 'string' || Object.keys(turn).sort().join(',') !== 'content,role')) {
        throw new Error('invalid source-only occurrence');
      }
      const slug = `chat/${source.session_id}-occ-${index}`.toLowerCase();
      const text = renderSession(source);
      const canonical = text.replace(/\r\n?/g, '\n').normalize('NFC');
      const result = await importModule.importFromContent(engine, slug, text, { noEmbed: options.mode === 'offline' });
      if (result.status === 'error') throw new Error(`source import rejected occurrence ${index}`);
      const chunks = await engine.getChunks(slug);
      const mapped = chunks.map((chunk: { id: number; chunk_text: string; chunk_source: string }) => {
        const chunkText = chunk.chunk_text.replace(/\r\n?/g, '\n').normalize('NFC');
        const first = canonical.indexOf(chunkText);
        const rawAlignment = first >= 0
          ? canonical.indexOf(chunkText, first + 1) < 0 ? 'exact' : 'ambiguous'
          : canonical.replace(/\s+/g, ' ').includes(chunkText.replace(/\s+/g, ' ')) ? 'whitespace_reflow' : 'nonliteral';
        return { id: chunk.id, text: chunkText, text_sha256: hash(chunkText), chunk_source: chunk.chunk_source,
          raw_alignment: rawAlignment, start: rawAlignment === 'exact' ? first : null,
          end: rawAlignment === 'exact' ? first + chunkText.length : null };
      });
      mappings.push({ slug, session_id: source.session_id.toLowerCase(), date: source.date, occurrence_index: index,
        text_sha256: hash(canonical), chunks: mapped });
    }
    if (admission?.buildCues) {
      const built = await admission.buildCues(engine, ['default'], mappings.length);
      cueReadback = { status: 'uncalibrated-diagnostic', embedding_signature: built.embedding_signature, min_similarity: -1, weight: 0.25 };
    }
    resolvedConfig = await readPilotResolvedConfig(engine, productRoot, cueMode, cueReadback);
  } finally {
    await engine.disconnect();
  }
  const manifest: PilotIndexManifest = { schema_version: 2, evidence_protocol: 'indexed-projection-v2', source_sha256: options.expectedSourceSha256,
    product_sha: options.expectedProductSha, product_package_sha256: options.expectedPackageSha256, product_version: product.version,
    embedding_model: options.embeddingModel, embedding_dimensions: options.embeddingDimensions,
    search_config: { ...PINNED_SEARCH_CONFIG }, cue_config: cueMode === 'on'
      ? { ...PILOT_CUE_OFF_CONFIG, 'memory.cues.read': 'on', 'memory.cues.sources': '["default"]',
        'memory.cues.families': '["horizon","scene"]', 'memory.cues.min_similarity': '-1', 'memory.cues.weight': '0.25',
        'memory.cues.read_calibration_signature': cueReadback!.embedding_signature }
      : { ...PILOT_CUE_OFF_CONFIG }, resolved_config: resolvedConfig!, mode: options.mode, cue_mode: cueMode,
    cue_hook: admission?.buildCues ? 'external-reviewed' : 'off', index_snapshot: { path: 'index', sha256: cat36SnapshotHash(join(outputDir, 'index')) },
    ...(cueReadback ? { cue_readback: cueReadback } : {}),
    construction_ms: performance.now() - constructionStarted,
    sources: mappings };
  writeFileSync(join(outputDir, 'index-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}

if (import.meta.main) {
  const [sourcePath, expectedSourceSha256, productRoot, expectedProductSha, expectedPackageSha256, outputDir] = process.argv.slice(2);
  if (process.argv.length !== 8) throw new Error('usage: bun eval/runner/longmemeval-m-pilot-build.ts <source-only.json> <source-sha256> <product-root> <product-sha> <package-sha256> <new-output-dir>');
  const result = await buildPilotIndex({ sourcePath, expectedSourceSha256, productRoot, expectedProductSha, expectedPackageSha256,
    outputDir, embeddingModel: 'openrouter:openai/text-embedding-3-large', embeddingDimensions: 1536, mode: 'offline' });
  console.log(JSON.stringify({ source_sha256: result.source_sha256, snapshot_sha256: result.index_snapshot.sha256,
    manifest_sha256: hash(readFileSync(join(outputDir, 'index-manifest.json'))),
    product_sha: result.product_sha, product_package_sha256: result.product_package_sha256, sessions: result.sources.length,
    chunks: result.sources.reduce((n, source) => n + source.chunks.length, 0), mode: result.mode }));
}
