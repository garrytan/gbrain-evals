import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { BrainEngine } from 'gbrain/engine';
import type { OperationContext } from 'gbrain/operations';
import type { HybridSearchMeta, ResolvedColumn, SearchResult } from 'gbrain/types';
import { cat36Hash, canonicalText, fixturePageId, type Cat36BuildSource } from './cat36-corpus.ts';
import { alignSourceChunks, type Cat36Chunk, type Cat36CueObservation } from './cat36-scorer.ts';
import { Cat36Failure, cueFamilies, validateCat36Profile, type Cat36Profile, type Cat36Runtime } from './cat36-associative-retrieval.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';
import { resolveRegressionProduct } from './situation-recall-provenance.ts';
import { searchObservation } from './retrieval-pins.ts';
import { EmbeddingCache, makeCachingTransport } from './longmemeval-cache.ts';
import { cat36SnapshotHash, copyCat36Snapshot, loadCat36FrozenConstruction, type Cat36IndexSnapshot } from './cat36-snapshot.ts';

const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'COHERE_API_KEY'];
let activeRuntime: symbol | null = null;
interface IndexedChunk {
  source: Cat36BuildSource;
  runtime_source_id?: string;
  page_id: number;
  chunk_id: number;
  chunk_index: number;
  text: string;
  start: number | null;
  end: number | null;
}
export interface EnrichmentResult {
  complete: boolean;
  observed: boolean;
  families: string[];
  receipt: Record<string, unknown>;
}
type PublicModule = Record<string, unknown>;
interface CueBuildOptions { sourceIds: string[]; pageLimit: number; windowLimit: number; includeBridge: boolean }
interface CuePreview {
  ready: boolean; reason?: string; eligiblePages: number; signature: string; embeddingColumn: ResolvedColumn; generationModel: string;
  costPreview: { maximumReservationUsdPerWindow: number | null; maximumReservationUsdPerPass: number | null };
}
interface CueStatus {
  supported: boolean; signature: string; reason?: string; windowsPending: number;
  settings: { generationEnabled: boolean; sourceIds: string[]; readMode: string; pushEnabled: boolean; minSimilarity: number | null; weight: number; families?: string[] };
  builds: Array<{ build_id: string; budget_owner_job_id: number; status: string; reason: string | null; max_usd: number; remaining_cents: number | null }>;
  coverage: Array<{ status: string; count: number }>;
}
interface CueApi {
  memoryCueColumn(engine: BrainEngine): Promise<ResolvedColumn>;
  previewMemoryCueBuild(engine: BrainEngine, options: CueBuildOptions): Promise<CuePreview>;
  submitMemoryCueBuild(engine: BrainEngine, options: CueBuildOptions & { trustedLocal: true; maxUsd: number }): Promise<{ buildId: string; jobId: number; budgetOwnerJobId: number; status: string }>;
  runMemoryCueBuild(engine: BrainEngine, options: { buildId: string; signal: AbortSignal }): Promise<{ status: string; windowsProcessed: number; reason?: string }>;
  getMemoryCueStatus(engine: BrainEngine, options: { sourceIds: string[]; buildId?: string }): Promise<CueStatus>;
  MEMORY_CUE_PROMPT_VERSION: string;
}

async function publicModule(specifier: string): Promise<PublicModule> {
  try { return await import(specifier); }
  catch { throw new Cat36Failure(`required public feature module unavailable: ${specifier}`, 'dependency'); }
}

export function cat36EmbeddingCacheKey(profile: Cat36Profile, sources: readonly Cat36BuildSource[]): string {
  return cat36Hash(JSON.stringify({ schema: 1, sources: cat36Hash(JSON.stringify(sources)), model: profile.embedding_model,
    dimensions: profile.embedding_dimensions, construction: profile.arm === 'B' || profile.arm === 'C0' ? 'off' : profile.arm === 'scene' || profile.arm === 'horizon' ? 'C1' : profile.arm,
    generation_model: profile.generation_model ?? null, contextual_retrieval: profile.search_config['search.contextual_retrieval'],
    normalization: 'nfc-lf-v1', transport: 'real-ai-sdk-embedMany' }));
}

export function cat36RuntimeSourceId(fixtureSourceId: string): string {
  return `c36-${cat36Hash(fixtureSourceId).slice(0, 28)}`;
}

export function assertCat36ProviderReadiness(profile: Cat36Profile, ready: { embedding: boolean; reranker: boolean; expansion: boolean; generation: boolean }): void {
  if (profile.mode === 'offline') return;
  if (!ready.embedding) throw new Cat36Failure('live embedding provider is not ready', 'dependency');
  if (profile.search_config['search.reranker.enabled'] === 'true' && !ready.reranker) throw new Cat36Failure('live reranker provider is not ready', 'dependency');
  if ((profile.search_config['search.expansion'] === 'true' || profile.required_operations?.includes('query')) && !ready.expansion) throw new Cat36Failure('live expansion provider is not ready', 'dependency');
  if ((profile.arm === 'C1' || profile.arm === 'scene-horizon-bridge' || profile.arm === 'summary') && !ready.generation) throw new Cat36Failure('live generation provider is not ready', 'dependency');
}

export async function validateCat36RerankerModel(profile: Cat36Profile): Promise<void> {
  if (profile.search_config['search.reranker.enabled'] !== 'true') return;
  const { validateModelId } = await import('gbrain/ai/gateway');
  const model = validateModelId(profile.search_config['search.reranker.model'], 'reranker');
  if (!model.ok) throw new Cat36Failure('unsupported configured reranker model', 'dependency');
  const supported = model.recipe.touchpoints.reranker?.models;
  if (!supported || (supported.length > 0 && !supported.includes(model.parsed.modelId))) throw new Cat36Failure('unsupported configured reranker model', 'dependency');
}

export async function requireCueSupport(): Promise<PublicModule> {
  const mod = await publicModule('gbrain/memory-cues');
  for (const name of ['loadMemoryCueSettings', 'memoryCueColumn', 'previewMemoryCueBuild', 'submitMemoryCueBuild', 'runMemoryCueBuild', 'getMemoryCueStatus']) {
    if (typeof mod[name] !== 'function') throw new Cat36Failure(`missing public memory-cues API: ${name}`, 'dependency');
  }
  return mod;
}

function verifyCueColumn(column: ResolvedColumn, profile: Cat36Profile): void {
  if (column.embeddingModel !== profile.embedding_model || column.dimensions !== profile.embedding_dimensions
    || !['vector', 'halfvec'].includes(column.type) || !column.name) throw new Cat36Failure('effective cue/query embedding column differs from the declared profile', 'dependency');
}

export function mapReturnedChunk(result: Pick<SearchResult, 'source_id' | 'slug' | 'page_id' | 'chunk_id' | 'chunk_index' | 'chunk_text'>, indexed: ReadonlyMap<number, IndexedChunk>, sourceIds?: ReadonlyMap<string, string>): Cat36Chunk {
  const original = indexed.get(result.chunk_id);
  const text = canonicalText(result.chunk_text);
  const ownsChunk = original?.page_id === result.page_id && original.source.slug === result.slug;
  const sourceId = result.source_id && sourceIds?.has(result.source_id) ? sourceIds.get(result.source_id)!
    : ownsChunk && original.runtime_source_id && result.source_id === original.runtime_source_id ? original.source.source_id
      : result.source_id ?? (ownsChunk ? original.source.source_id : 'unknown-source');
  const identityMatches = original && original.page_id === result.page_id && original.source.slug === result.slug && original.source.source_id === sourceId;
  const offset = identityMatches && text.length ? original.text.indexOf(text) : -1;
  const unique = offset >= 0 && original!.text.indexOf(text, offset + 1) < 0;
  const start = unique && original!.start !== null ? original!.start + offset : null;
  return { source_id: sourceId, slug: result.slug, page_id: result.page_id, chunk_id: result.chunk_id, chunk_index: result.chunk_index,
    ...(result.source_id ? { runtime_source_id: result.source_id } : {}), text, start, end: start === null ? null : start + text.length, token_count: Math.ceil(text.length / 4) };
}

export async function createCat36ProductionRuntime(profile: Cat36Profile, options: {
  artifactDir?: string;
  namespace?: { home: string; config: string; database: string };
} = {}): Promise<Cat36Runtime> {
  validateCat36Profile(profile);
  if (options.namespace && (Object.values(options.namespace).some(path => !isAbsolute(path)) || basename(options.namespace.config) !== 'config.json'
    || options.namespace.config !== join(options.namespace.home, '.gbrain', 'config.json'))) throw new Error('runtime namespace requires absolute paths and HOME/.gbrain/config.json');
  profile = structuredClone(profile);
  const runtimeId = Symbol('cat36-production');
  let constructionStarted = false;
  let engine: BrainEngine | undefined;
  let hybrid: typeof import('gbrain/search/hybrid').hybridSearch;
  let scratch: string | undefined;
  let originalEnv: NodeJS.ProcessEnv | undefined;
  let operationContext: OperationContext | undefined;
  let operationsByName: typeof import('gbrain/operations').operationsByName;
  let cache: EmbeddingCache | undefined;
  let resetTransport: (() => void) | undefined;
  const indexed = new Map<number, IndexedChunk>();
  const runtimeSourceIds = new Map<string, string>();
  return {
    kind: 'production',
    async build(sources, settings) {
      validateCat36Profile(settings);
      if (constructionStarted) throw new Cat36Failure('cannot rebuild a Cat36 runtime');
      constructionStarted = true;
      const { required_operations: requestedOperations, ...requestedProfile } = settings;
      const { required_operations: frozenOperations, ...frozenProfile } = profile;
      if (JSON.stringify(requestedProfile) !== JSON.stringify(frozenProfile)
        || (frozenOperations && JSON.stringify(requestedOperations) !== JSON.stringify(frozenOperations))) throw new Cat36Failure('runtime profile changed before construction');
      profile = structuredClone(settings);
      const provenance = settings.mode === 'live'
        ? resolveRegressionProduct({ expectedProductSha: settings.expected_product_sha, expectedPackageSha256: settings.expected_package_sha256 })
        : { declared_pin: gbrainPin(), package_version: gbrainVersion(), verified_live_identity: false };
      if (settings.mode === 'live' && !options.artifactDir) throw new Cat36Failure('live construction requires a fresh persistent artifact directory');
      const reused = settings.reuse_build_dir ? loadCat36FrozenConstruction(settings.reuse_build_dir, settings, cat36Hash(JSON.stringify(sources)),
        'package_sha256' in provenance ? provenance.package_sha256 : undefined) : undefined;
      if (settings.search_config['search.expansion'] === 'true') throw new Cat36Failure('raw-chunk expansion profile blocked: the public expander does not distinguish completed no-op output from provider fallback', 'dependency');
      if (activeRuntime) throw new Cat36Failure('Cat36 production profiles require separate processes, not concurrent gateway/environment state');
      activeRuntime = runtimeId;
      originalEnv = { ...process.env };
      scratch = options.artifactDir ? resolve(options.artifactDir) : mkdtempSync(join(tmpdir(), 'cat36-isolated-'));
      if (options.artifactDir) mkdirSync(scratch);
      const home = options.namespace?.home ?? join(scratch, 'home');
      const configPath = options.namespace?.config ?? join(home, '.gbrain', 'config.json');
      const databasePath = options.namespace?.database ?? (options.artifactDir ? join(scratch, 'working-db') : undefined);
      if (databasePath && existsSync(databasePath)) throw new Cat36Failure('production database namespace is not fresh');
      mkdirSync(home, { recursive: true });
      const inherited = Object.fromEntries(['PATH', 'LANG', 'TZ', ...(settings.mode === 'live' ? PROVIDER_KEYS : [])]
        .filter(key => originalEnv![key] !== undefined).map(key => [key, originalEnv![key]!]));
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, inherited);
      process.env.HOME = home;
      process.env.GBRAIN_HOME = home;
      process.env.XDG_CONFIG_HOME = join(home, '.config');
      const productConfig = await import('gbrain/config');
      if (productConfig.configPath() !== configPath) throw new Cat36Failure('product resolved another file-plane configuration path');
      mkdirSync(dirname(configPath), { recursive: true });
      const fileConfig = JSON.parse(JSON.stringify({ engine: 'pglite', embedding_model: settings.embedding_model,
        embedding_dimensions: settings.embedding_dimensions, ...(settings.mode === 'offline' ? { embedding_disabled: true } : {}),
        chat_model: settings.generation_model, expansion_model: settings.expansion_model, ...(databasePath ? { database_path: databasePath } : {}) }));
      if (existsSync(configPath)) {
        const actual = JSON.parse(readFileSync(configPath, 'utf8'));
        if (Object.keys(actual).length !== Object.keys(fileConfig).length || Object.entries(fileConfig).some(([key, value]) => actual[key] !== value)) throw new Cat36Failure('prepared file-plane config differs from the profile');
      } else writeFileSync(configPath, JSON.stringify(fileConfig) + '\n', { flag: 'wx' });
      const families = cueFamilies(settings.arm);
      let feature: PublicModule | undefined;
      if (families.length) feature = await requireCueSupport();
      if (settings.arm === 'summary') await publicModule('gbrain/contextual-retrieval');
      const operations = await import('gbrain/operations');
      operationsByName = operations.operationsByName;
      for (const surface of settings.required_operations ?? []) {
        if (!operationsByName[surface]?.params.query) throw new Cat36Failure(`native ${surface} query operation unsupported`, 'dependency');
      }
      const admin = operations.operationsByName.memory_cues;
      if (families.length && (!admin || admin.localOnly !== true || admin.scope !== 'admin')) throw new Cat36Failure('trusted memory_cues admin operation unavailable', 'dependency');
      if (feature && typeof feature.runMemoryCueBuild !== 'function') throw new Cat36Failure('public durable cue build execution API unavailable', 'dependency');
      if (families.length === 1 && !admin.params.families) throw new Cat36Failure('production Scene-only/Horizon-only family selection unavailable', 'dependency');
      const [{ PGLiteEngine }, gateway, importer, search] = await Promise.all([
        import('gbrain/pglite-engine'), import('gbrain/ai/gateway'), import('gbrain/import-file'), import('gbrain/search/hybrid'),
      ]);
      hybrid = search.hybridSearch;
      gateway.__setEmbedTransportForTests(null);
      gateway.__setChatTransportForTests(null);
      gateway.__setRerankTransportForTests(null);
      gateway.__setGenerateTextTransportForTests(null);
      gateway.__setGenerateObjectTransportForTests(null);
      gateway.__setSunsetClockForTests(null);
      const providerEnv = settings.mode === 'live' ? Object.fromEntries(PROVIDER_KEYS.filter(k => process.env[k]).map(k => [k, process.env[k]])) : {};
      gateway.configureGateway({ embedding_model: settings.embedding_model, embedding_dimensions: settings.embedding_dimensions,
        chat_model: settings.generation_model, expansion_model: settings.expansion_model,
        reranker_model: settings.search_config['search.reranker.model'], env: providerEnv });
      const embeddingDiagnosis = gateway.diagnoseEmbedding();
      assertCat36ProviderReadiness(settings, { embedding: embeddingDiagnosis.ok,
        reranker: gateway.isAvailable('reranker', settings.search_config['search.reranker.model']),
        expansion: gateway.isAvailable('expansion', settings.expansion_model), generation: gateway.isAvailable('chat', settings.generation_model) });
      await validateCat36RerankerModel(settings);
      let cacheProvenance: Record<string, unknown> = { enabled: false };
      if (settings.mode === 'live') {
        const { embedMany } = await import('ai');
        const key = cat36EmbeddingCacheKey(settings, sources);
        const cachePath = resolve('eval/reports/cat36-associative-retrieval/embed-cache', `${key}.sqlite`);
        cache = new EmbeddingCache(cachePath, `${settings.embedding_model}@${settings.embedding_dimensions}:${key}`);
        cacheProvenance = { enabled: true, key, path: cachePath, initial_entries: cache.size(), transport: 'real ai-sdk embedMany; not deterministic stub', side_aware: true };
        const transport = makeCachingTransport(async params => embedMany(params as Parameters<typeof embedMany>[0]), cache);
        const checked = async (params: { values: string[] } & Record<string, unknown>) => {
          const result = await transport(params);
          if (result.embeddings.length !== params.values.length || result.embeddings.some(v => v.length !== settings.embedding_dimensions || v.some(n => !Number.isFinite(n)))) {
            throw new Cat36Failure('invalid provider/cache embedding dimensions or values', 'dependency');
          }
          return result;
        };
        gateway.__setEmbedTransportForTests(checked as unknown as Parameters<typeof gateway.__setEmbedTransportForTests>[0]);
        resetTransport = () => gateway.__setEmbedTransportForTests(null);
      }
      engine = new PGLiteEngine();
      if (reused) copyCat36Snapshot(reused.index_snapshot!, databasePath!);
      await engine.connect(databasePath ? { database_path: databasePath } : {});
      if (!reused) await engine.initSchema();
      for (const [key, value] of Object.entries(settings.search_config)) await engine.setConfig(key, value);
      await engine.setConfig('embedding_model', settings.embedding_model);
      await engine.setConfig('embedding_dimensions', String(settings.embedding_dimensions));
      if (settings.generation_model) await engine.setConfig('chat_model', settings.generation_model);
      await engine.setConfig('memory.cues.generation_enabled', 'false');
      await engine.setConfig('memory.cues.read', 'off');
      await engine.setConfig('memory.cues.push', 'false');
      const fixtureSourceIds = [...new Set(sources.map(s => s.source_id))];
      const allSourceIds = fixtureSourceIds.map(cat36RuntimeSourceId);
      fixtureSourceIds.forEach((id, i) => runtimeSourceIds.set(allSourceIds[i], id));
      if (new Set(allSourceIds).size !== fixtureSourceIds.length) throw new Cat36Failure('runtime source identity collision');
      const sourceIds = [...new Set(sources.filter(s => s.visibility === 'public').map(s => cat36RuntimeSourceId(s.source_id)))];
      for (const id of reused ? [] : allSourceIds) {
        await engine.executeRaw("INSERT INTO sources (id,name,config) VALUES ($1,$1,'{}'::jsonb) ON CONFLICT (id) DO NOTHING", [id]);
      }
      if (feature) {
        verifyCueColumn(await (feature as unknown as CueApi).memoryCueColumn(engine), settings);
        await admin.handler({ engine, config: { engine: 'pglite', embedding_model: settings.embedding_model, embedding_dimensions: settings.embedding_dimensions },
          sourceId: sourceIds[0] ?? 'default', remote: false, dryRun: true, logger: { info() {}, warn() {}, error() {} } },
        { action: 'configure', source_ids: sourceIds, generation_enabled: !reused, read_mode: 'on', push_enabled: false,
          min_similarity: settings.cue_min_similarity, weight: settings.cue_weight, ...(admin.params.families ? { families } : {}) });
      }
      const mappings: Array<Record<string, unknown>> = reused ? structuredClone(reused.mappings) : [];
      for (const source of reused ? [] : sources) {
        const runtimeSourceId = cat36RuntimeSourceId(source.source_id);
        const content = `---\ntype: note\ntitle: ${JSON.stringify(source.title)}\nvisibility: ${source.visibility === 'private' ? 'private' : 'world'}\n---\n\n${source.text}`;
        const result = await importer.importFromContent(engine, source.slug, content, { sourceId: runtimeSourceId, noEmbed: settings.mode === 'offline' });
        if (result.status === 'error') throw new Cat36Failure(`source import failed: ${fixturePageId(source)}`, 'sut');
        const page = await engine.getPage(source.slug, { sourceId: runtimeSourceId });
        if (!page || canonicalText(page.compiled_truth).trim() !== source.text.trim()) throw new Cat36Failure(`canonical text changed on import: ${fixturePageId(source)}`);
        await engine.executeRaw('UPDATE pages SET created_at=$1,updated_at=$2 WHERE id=$3', [source.created_at, source.updated_at, page.id]);
        const chunks = await engine.getChunks(source.slug, { sourceId: runtimeSourceId });
        const offsets = alignSourceChunks(source.text, chunks.map(c => ({ chunk_id: c.id, text: c.chunk_text })));
        for (const c of chunks) {
          const range = offsets.get(c.id);
          indexed.set(c.id, { source, runtime_source_id: runtimeSourceId, page_id: page.id, chunk_id: c.id, chunk_index: c.chunk_index,
            text: canonicalText(c.chunk_text), start: range?.start ?? null, end: range?.end ?? null });
        }
        mappings.push({ fixture_source_id: source.source_id, runtime_source_id: runtimeSourceId, fixture_slug: source.slug, page_id: page.id,
          canonical_sha256: cat36Hash(source.text), chunks: chunks.map(c => ({ chunk_id: c.id, chunk_index: c.chunk_index, range: offsets.get(c.id) })) });
        if (source.visibility === 'withdrawn') await engine.softDeletePage(source.slug, { sourceId: runtimeSourceId });
        if (mappings.length % 20 === 0 && typeof Bun !== 'undefined') Bun.gc(true);
      }
      let enrichment: EnrichmentResult = { complete: true, observed: false, families: [], receipt: { mode: 'none', provider_calls: 0 } };
      const ctx: OperationContext = { engine, config: { engine: 'pglite', embedding_model: settings.embedding_model, embedding_dimensions: settings.embedding_dimensions },
        remote: false, dryRun: false, sourceId: allSourceIds[0] ?? 'default', localFederatedSourceIds: allSourceIds, logger: { info() {}, warn() {}, error() {} } };
      operationContext = { ...ctx, remote: true };
      try {
        if (reused) {
          await admin.handler(ctx, { action: 'configure', source_ids: sourceIds, generation_enabled: false, read_mode: 'on', push_enabled: false,
            min_similarity: settings.cue_min_similarity, weight: settings.cue_weight, families, apply: true });
          const originalAdmission = reused.generation.admission as { buildId?: string } | undefined;
          const originalStatus = reused.generation.final_status as CueStatus | undefined;
          if (!originalAdmission?.buildId || !originalStatus) throw new Cat36Failure('frozen C1 build lacks durable generation observations');
          const readback = await (feature as unknown as CueApi).getMemoryCueStatus(engine, { sourceIds, buildId: originalAdmission.buildId });
          const selected = readback.settings.families;
          enrichment = { complete: readback.supported && !readback.settings.generationEnabled && readback.settings.readMode === 'on'
            && readback.signature === originalStatus.signature && readback.windowsPending === 0
            && readback.builds.some(b => b.build_id === originalAdmission.buildId && b.status === 'complete')
            && JSON.stringify([...readback.coverage].sort((a, b) => a.status.localeCompare(b.status))) === JSON.stringify([...originalStatus.coverage].sort((a, b) => a.status.localeCompare(b.status)))
            && JSON.stringify(selected?.slice().sort()) === JSON.stringify([...families].sort()), observed: reused.generation_observed, families,
            receipt: { ...structuredClone(reused.generation), construction_families: ['scene', 'horizon'], read_families: families,
              reused_build_dir: resolve(settings.reuse_build_dir!), reused_index_sha256: reused.index_snapshot!.sha256,
              new_generation_calls: 0, readback } };
        } else if (families.length) enrichment = await buildCues(feature!, admin, ctx, sourceIds, settings);
        if (settings.arm === 'summary') enrichment = await buildProductionSummaryIndex(engine, sources, settings);
      } catch (error) {
        enrichment = { complete: false, observed: false, families, receipt: { failure: String(error), stage: 'enrichment', provider_mode: 'production gateway defaults; no injected providers' } };
      }
      for (const source of sources.filter(s => s.visibility === 'public')) {
        const runtimeSourceId = cat36RuntimeSourceId(source.source_id);
        const page = await engine.getPage(source.slug, { sourceId: runtimeSourceId });
        if (!page || canonicalText(page.compiled_truth).trim() !== source.text.trim()) {
          enrichment.complete = false;
          enrichment.receipt.canonical_source_changed = fixturePageId(source);
          continue;
        }
        if (new Date(page.created_at).getTime() !== Date.parse(source.created_at) || new Date(page.updated_at).getTime() !== Date.parse(source.updated_at)) {
          enrichment.complete = false;
          enrichment.receipt.source_timestamp_changed = fixturePageId(source);
        }
        const chunks = await engine.getChunks(source.slug, { sourceId: runtimeSourceId });
        const offsets = alignSourceChunks(source.text, chunks.map(c => ({ chunk_id: c.id, text: c.chunk_text })));
        for (const [id, existing] of indexed) if (existing.page_id === page.id) indexed.delete(id);
        for (const c of chunks) indexed.set(c.id, { source, runtime_source_id: runtimeSourceId, page_id: page.id, chunk_id: c.id, chunk_index: c.chunk_index,
          text: canonicalText(c.chunk_text), start: offsets.get(c.id)?.start ?? null, end: offsets.get(c.id)?.end ?? null });
        const mapping = mappings.find(m => m.fixture_source_id === source.source_id && m.fixture_slug === source.slug);
        if (!mapping || mapping.runtime_source_id !== runtimeSourceId || mapping.canonical_sha256 !== cat36Hash(source.text)) throw new Cat36Failure('frozen source mapping differs from current fixture');
        mapping.chunks = chunks.map(c => ({ chunk_id: c.id, chunk_index: c.chunk_index, range: offsets.get(c.id) }));
      }
      let snapshot: Cat36IndexSnapshot | undefined;
      if (databasePath) {
        await engine.disconnect();
        const frozenPath = join(scratch, 'frozen-db');
        cpSync(databasePath, frozenPath, { recursive: true, errorOnExist: true, force: false });
        snapshot = { path: relative(resolve(scratch, '..'), frozenPath), sha256: cat36SnapshotHash(frozenPath) };
        await engine.connect({ database_path: databasePath });
      }
      const resolved: Record<string, unknown> = {};
      for (const key of [...Object.keys(settings.search_config), 'embedding_model', 'embedding_dimensions', 'chat_model', 'memory.cues.generation_enabled', 'memory.cues.sources',
        'memory.cues.read', 'memory.cues.push', 'memory.cues.families', 'memory.cues.min_similarity', 'memory.cues.weight', 'memory.cues.read_calibration_signature']) {
        resolved[key] = await engine.getConfig(key);
      }
      resolved.expansion_model = gateway.getExpansionModel();
      resolved.generation_model = gateway.getChatModel();
      return { runtime_kind: 'production', construction_profile: structuredClone(settings), ...(snapshot ? { index_snapshot: snapshot } : {}),
        mode: settings.mode, complete: enrichment.complete, feature_supported: Boolean(feature), generation_observed: enrichment.observed,
        families: enrichment.families, source_hash: cat36Hash(JSON.stringify(sources)), resolved_config: resolved,
        provenance: { ...provenance, embedding: embeddingDiagnosis, isolated_home: home, database: databasePath ?? 'fresh in-memory PGLite', fixed_source_timestamps: true,
          file_config: { path: configPath, values: JSON.parse(readFileSync(configPath, 'utf8')) },
          embedding_cache: { ...cacheProvenance, after_build: cache ? { ...cache.stats } : null }, withdrawal_mechanism: 'production softDeletePage',
          runtime_source_mapping: 'c36-sha256-prefix28-v1; one-to-one; fixture IDs remain the scoring identity', generation_scope: 'public fixture sources only' },
        mappings, generation: enrichment.receipt };
    },
    async search(text, options) {
      if (!engine || !hybrid) throw new Cat36Failure('search before frozen construction');
      let meta: HybridSearchMeta | undefined;
      const results = await hybrid(engine, text, { limit: options.limit, tokenBudget: options.tokenBudget, excludePrivate: true, requireSafeChunks: true,
        expansion: false,
        recencyBoost: profile.search_config['search.recency_boost'] === 'false' ? 0 : 1, onMeta: value => { meta = value; } });
      const observed = searchObservation({ query: text, results, meta, mode: profile.mode === 'offline' ? 'keyword' : 'hybrid',
        expectedReranker: profile.search_config['search.reranker.enabled'] === 'true', expectedExpansion: profile.search_config['search.expansion'] === 'true' });
      const cue = (meta as HybridSearchMeta & { memory_cues?: Cat36CueObservation } | undefined)?.memory_cues;
      if (cueFamilies(profile.arm).length && !cue) observed.failures.push('cue_metadata_missing');
      return { chunks: results.map(r => mapReturnedChunk(r, indexed, runtimeSourceIds)), cue: cue ?? { mode: 'off', status: 'skipped', reason: 'disabled', candidates: 0, admitted: 0 },
        failures: observed.failures, metadata: { ...observed, embedding_cache: cache ? { ...cache.stats } : null } };
    },
    async operation(surface, text) {
      if (!operationContext) throw new Cat36Failure('operation before construction');
      const op = operationsByName[surface];
      if (!op || !op.params.query) throw new Cat36Failure(`native ${surface} query operation unsupported`, 'dependency');
      const params: Record<string, unknown> = { query: text };
      if (profile.mode === 'offline' && surface === 'query') params.expand = false;
      return await op.handler(operationContext, params);
    },
    async close() {
      try { await engine?.disconnect(); }
      finally {
        try {
          resetTransport?.();
          cache?.close();
        } finally {
          try {
            if (originalEnv) {
              for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
              Object.assign(process.env, originalEnv);
            }
            if (scratch && !options.artifactDir) rmSync(scratch, { recursive: true, force: true });
          } finally { if (activeRuntime === runtimeId) activeRuntime = null; }
        }
      }
    },
  };
}

async function buildCues(module: PublicModule, admin: typeof import('gbrain/operations').operationsByName[string], ctx: OperationContext, sourceIds: string[], profile: Cat36Profile): Promise<EnrichmentResult> {
  const api = module as unknown as CueApi;
  const families = cueFamilies(profile.arm);
  if (profile.mode !== 'live' || !families.length) throw new Cat36Failure('production cue construction requires a live cue-enabled profile');
  if (families.length === 1) throw new Cat36Failure('Scene/Horizon read-time ablations must reuse frozen C1 construction, never regenerate');
  const column = await api.memoryCueColumn(ctx.engine);
  verifyCueColumn(column, profile);
  const initial = await api.getMemoryCueStatus(ctx.engine, { sourceIds });
  if (initial.builds.length || initial.coverage.some(row => row.count > 0) || initial.windowsPending > 0) throw new Cat36Failure('cue construction requires a fresh index, not accumulated generations', 'dependency');
  await ctx.engine.setConfig('chat_model', profile.generation_model!);
  await admin.handler(ctx, { action: 'configure', source_ids: sourceIds, generation_enabled: true, read_mode: 'on', push_enabled: false,
    min_similarity: profile.cue_min_similarity, weight: profile.cue_weight, ...(admin.params.families ? { families } : {}), apply: true });
  const options: CueBuildOptions = { sourceIds, pageLimit: 1000, windowLimit: 8, includeBridge: families.includes('bridge') };
  const pages = await ctx.engine.listPages({ sourceIds, excludePrivate: true, limit: 1001 });
  if (pages.length > options.pageLimit) throw new Cat36Failure('source population exceeds the production build page limit', 'dependency');
  const preview = await api.previewMemoryCueBuild(ctx.engine, options);
  if (!preview.ready || preview.generationModel !== profile.generation_model) throw new Cat36Failure(`cue build readiness/model mismatch: ${preview.reason ?? 'generation_model'}`, 'dependency');
  verifyCueColumn(preview.embeddingColumn, profile);
  const perWindow = preview.costPreview.maximumReservationUsdPerWindow;
  if (!Number.isFinite(perWindow) || perWindow! <= 0 || perWindow! > profile.build_max_usd!) throw new Cat36Failure('unknown or insufficient bounded cue-generation allowance', 'dependency');
  if (typeof api.MEMORY_CUE_PROMPT_VERSION !== 'string' || !api.MEMORY_CUE_PROMPT_VERSION) throw new Cat36Failure('public cue prompt identity unavailable', 'dependency');
  const admission = await api.submitMemoryCueBuild(ctx.engine, { ...options, trustedLocal: true, maxUsd: profile.build_max_usd! });
  const passes: Array<{ status: string; windowsProcessed: number; reason?: string }> = [];
  const signal = AbortSignal.timeout(600_000);
  let executionError: string | null = null;
  try {
    for (let pass = 0; pass < 1000; pass++) {
      const result = await api.runMemoryCueBuild(ctx.engine, { buildId: admission.buildId, signal });
      passes.push(result);
      if (result.status !== 'partial' || result.windowsProcessed <= 0 || signal.aborted) break;
    }
  } catch (error) { executionError = String(error); }
  let status: CueStatus;
  try { status = await api.getMemoryCueStatus(ctx.engine, { sourceIds, buildId: admission.buildId }); }
  catch (error) {
    return { complete: false, observed: false, families, receipt: { admission, preview, passes, execution_error: executionError,
      status_error: String(error), final_status: null, coverage_known: false, provider_mode: 'production gateway defaults; no injected providers' } };
  }
  const owner = status.builds.find(b => b.build_id === admission.buildId);
  const coverageValid = Array.isArray(status.coverage) && status.coverage.every(c => Number.isInteger(c.count) && c.count >= 0);
  const readback = status.settings.generationEnabled && status.settings.readMode === 'on' && !status.settings.pushEnabled
    && status.settings.minSimilarity === profile.cue_min_similarity && status.settings.weight === profile.cue_weight
    && JSON.stringify([...status.settings.sourceIds].sort()) === JSON.stringify([...sourceIds].sort())
    && (!admin.params.families || JSON.stringify(status.settings.families?.slice().sort()) === JSON.stringify([...families].sort()));
  const complete = Boolean(!executionError && owner?.status === 'complete' && status.supported && status.signature === preview.signature && status.windowsPending === 0
    && coverageValid && readback && status.coverage.every(c => ['ready', 'empty'].includes(c.status)));
  const count = (kind: string) => status.coverage.filter(c => c.status === kind).reduce((n, c) => n + c.count, 0);
  return { complete, observed: coverageValid && count('ready') + count('empty') > 0, families,
    receipt: { admission, preview, passes, final_status: status, embedding_column: column, generation_model: preview.generationModel,
      prompt_version: api.MEMORY_CUE_PROMPT_VERSION, generated: coverageValid ? count('ready') : 0, generated_unit: 'completed nonempty windows, not cue count',
      empty_windows: coverageValid ? count('empty') : 0, rejected_windows: passes.filter(p => ['invalid_output', 'unsupported_cue', 'unsupported_relation', 'provider_refusal', 'incomplete_output'].includes(p.reason ?? '')).length,
      construction_families: families, read_families: families, covered_sources: complete ? [...sourceIds] : [], max_usd: profile.build_max_usd, remaining_cents: owner?.remaining_cents ?? null,
      budget_accounting: 'remaining durable allowance includes charged or reserved work; not an invoice', wall_timeout_ms: 600_000, maximum_passes: 1000,
      execution_error: executionError, provider_mode: 'production gateway defaults; no injected providers' } };
}

export async function buildProductionCueIndex(engine: BrainEngine, sourceIds: string[], profile: Cat36Profile): Promise<EnrichmentResult> {
  validateCat36Profile(profile);
  const module = await requireCueSupport();
  const { operationsByName } = await import('gbrain/operations');
  const admin = operationsByName.memory_cues;
  if (!admin || admin.localOnly !== true || admin.scope !== 'admin') throw new Cat36Failure('trusted memory_cues admin operation unavailable', 'dependency');
  const ctx: OperationContext = { engine, config: { engine: 'pglite', embedding_model: profile.embedding_model, embedding_dimensions: profile.embedding_dimensions },
    sourceId: sourceIds[0] ?? 'default', localFederatedSourceIds: sourceIds, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  return await buildCues(module, admin, ctx, sourceIds, profile);
}

export async function buildProductionSummaryIndex(engine: BrainEngine, sources: readonly Cat36BuildSource[], profile: Cat36Profile): Promise<EnrichmentResult> {
  validateCat36Profile(profile);
  if (profile.arm !== 'summary' || profile.mode !== 'live') throw new Cat36Failure('real summary construction requires the explicit live summary arm');
  const module = await publicModule('gbrain/contextual-retrieval');
  if (typeof module.reembedPageWithContextualRetrieval !== 'function') throw new Cat36Failure('public real contextual-summary service unavailable', 'dependency');
  if (profile.provider_budget?.max_usd !== profile.build_max_usd) throw new Cat36Failure('summary control requires its external whole-cell hard cap to equal the build allowance', 'dependency');
  if (profile.search_config['search.contextual_retrieval'] !== 'per_chunk_synopsis') throw new Cat36Failure('summary control must explicitly select per_chunk_synopsis', 'dependency');
  const reembed = module.reembedPageWithContextualRetrieval as (args: {
    engine: BrainEngine; pageSlug: string; sourceId: string; globalMode: 'per_chunk_synopsis'; synopsisModel: string;
    synopsisMaxTokens: number; chunkConcurrency: number; abortSignal: AbortSignal;
  }) => Promise<{ kind: string; mode_applied?: string; chunks_embedded?: number; corpus_generation?: string; reason?: string }>;
  const results: Array<{ source_id: string; slug: string; result: unknown }> = [];
  let complete = true;
  let generatedChunks = 0;
  const signal = AbortSignal.timeout(600_000);
  for (const source of sources.filter(s => s.visibility === 'public')) {
    try {
      const result = await reembed({ engine, pageSlug: source.slug, sourceId: cat36RuntimeSourceId(source.source_id), globalMode: 'per_chunk_synopsis',
        synopsisModel: profile.generation_model!, synopsisMaxTokens: 200, chunkConcurrency: 1, abortSignal: signal });
      results.push({ source_id: source.source_id, slug: source.slug, result });
      if (result.kind !== 'success' || result.mode_applied !== 'per_chunk_synopsis' || !Number.isInteger(result.chunks_embedded)
        || result.chunks_embedded! <= 0 || !result.corpus_generation) { complete = false; break; }
      generatedChunks += result.chunks_embedded!;
    } catch (error) {
      complete = false;
      results.push({ source_id: source.source_id, slug: source.slug, result: { error: String(error) } });
      break;
    }
  }
  return { complete, observed: generatedChunks > 0, families: [], receipt: { mode: 'real per-chunk synopsis service', generated_chunks: generatedChunks,
    model: profile.generation_model, results, max_usd: profile.build_max_usd, budget_enforcement: 'external isolated whole-cell cap; includes import/search, no separate local synopsis dollar meter',
    synopsis_max_tokens: 200, chunk_concurrency: 1, wall_timeout_ms: 600_000, provider_mode: 'production gateway defaults; no title fallback accepted' } };
}
