import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { configureGateway, diagnoseEmbedding, isAvailable, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { configPath as gbrainConfigPath, loadConfig } from 'gbrain/config';
import {
  loadCorpus, QUERIES, assertCorpusPremise, assertBoostPremise, scoreAdapter, computeVerdict13b,
  GBRAIN_SEARCH_CONFIG, TOP_K, PASS_TOP1, hashEmbed, type SwampResult,
} from './cat13b-source-swamp.ts';
import { GbrainInlineAdapter } from './adapters/gbrain-inline.ts';
import { sanitizePage, type Adapter, type AdapterConfig, type BrainState, type Page, type PublicQuery } from './types.ts';
import { Cat36Failure, validateCat36Profile, type Cat36Profile } from './cat36-associative-retrieval.ts';
import { assertCat36ProviderReadiness, buildProductionCueIndex, requireCueSupport } from './cat36-production.ts';
import { cat36Hash } from './cat36-corpus.ts';
import { observedSearchFailures, type SearchObservation } from './retrieval-pins.ts';
import { resolveRegressionProduct } from './situation-recall-provenance.ts';
import { executedCueLookup } from './situation-recall-observations.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, writeReceipt, type Receipt } from './receipt.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';

export const CAT13B_PILOT_CATEGORY = 'cat13b-situation-recall-pilot';
export const CAT13B_PILOT_TIMESTAMP = '2026-05-01T00:00:00.000Z';
type CueBuild = Awaited<ReturnType<typeof buildProductionCueIndex>>;
type InlineAdapter = Pick<GbrainInlineAdapter, 'name' | 'init' | 'query' | 'teardown' | 'engineOf' | 'resolvedConfig' | 'observedStats'>;

export interface Cat13bPilotDependencies {
  adapter: InlineAdapter;
  buildCueIndex?: typeof buildProductionCueIndex;
  score?: typeof scoreAdapter;
}

export interface Cat13bPilotOptions {
  profile: Cat36Profile;
  outputDir: string;
  execute?: boolean;
}

export function validateCat13bPilotProfile(profile: Cat36Profile): void {
  if (!profile || !['B', 'C0', 'C1'].includes(profile.arm) || profile.counterfactual || profile.required_operations) throw new Error('Cat13b pilot supports only the native B/C0/C1 cohort');
  validateCat36Profile(profile);
  for (const [key, value] of Object.entries(GBRAIN_SEARCH_CONFIG)) {
    if (key in profile.search_config && profile.search_config[key] !== value) throw new Error(`Cat13b native setting must remain ${key}=${value}`);
  }
  if (profile.search_config['search.contextual_retrieval'] !== 'none') throw new Error('Cat13b pilot does not change the native contextual-retrieval construction');
  if (profile.mode === 'offline' && (profile.embedding_model !== 'openai:text-embedding-3-large' || profile.embedding_dimensions !== 1536)) throw new Error('Offline native hash transport requires its original 1536-dimensional model configuration');
}

export function cat13bCueObservationFailures(result: SwampResult, arm: Cat36Profile['arm']): Array<{ query_id: string; reasons: string[] }> {
  const failures = observedSearchFailures(result.observed, QUERIES.length);
  const observations = (result.observed as { search_observations?: SearchObservation[] } | undefined)?.search_observations ?? [];
  const ids = observations.map(observation => observation.query_id);
  if (new Set(ids).size !== ids.length || QUERIES.some(query => !ids.includes(query.id)) || ids.some(id => !QUERIES.some(query => query.id === id))) failures.push({ query_id: 'unknown', reasons: ['query_observation_identity_mismatch'] });
  for (const observation of observations) {
    const cue = (observation.search_meta as unknown as { memory_cues?: { mode?: string; status?: string; reason?: string; candidates?: number; admitted?: number } } | null)?.memory_cues;
    const query = QUERIES.find(query => query.id === observation.query_id);
    const reasons: string[] = [];
    if (!query || query.text !== observation.query) reasons.push('query_observation_text_mismatch');
    if (arm === 'C1') {
      if (!cue || cue.mode !== 'on' || !executedCueLookup(cue.status, cue.reason)) reasons.push('cue_arm_unexercised');
      if (!Number.isInteger(cue?.candidates) || !Number.isInteger(cue?.admitted) || cue!.admitted! < 0 || cue!.candidates! < cue!.admitted!) reasons.push('cue_observation_counts_invalid');
    } else if (cue && (cue.mode !== 'off' || cue.admitted !== 0)) reasons.push('unexpected_cue_arm');
    if (reasons.length) failures.push({ query_id: observation.query_id ?? 'unknown', reasons });
  }
  return failures;
}

class PreparedCat13bAdapter implements Adapter {
  readonly name = 'gbrain';
  private state?: BrainState;

  constructor(private inner: InlineAdapter, private profile: Cat36Profile, private outputDir: string,
    private sourceHash: string, private enrich: typeof buildProductionCueIndex, private recordBuild: (build: Record<string, unknown>) => void) {}

  async init(pages: Page[], config: AdapterConfig): Promise<BrainState> {
    const state = await this.inner.init(pages.map(sanitizePage), config);
    this.state = state;
    const engine = this.inner.engineOf(state);
    const sourceIds = new Set<string>();
    for (const page of pages) {
      const stored = await engine.getPage(page.slug);
      if (!stored?.source_id) throw new Cat36Failure('native imported page has no source identity');
      sourceIds.add(stored.source_id);
      await engine.executeRaw('UPDATE pages SET created_at=$1,updated_at=$1 WHERE id=$2', [CAT13B_PILOT_TIMESTAMP, stored.id]);
    }
    const settings = { ...GBRAIN_SEARCH_CONFIG, 'search.tokenBudget': String(this.profile.token_budget),
      embedding_model: this.profile.embedding_model, embedding_dimensions: String(this.profile.embedding_dimensions),
      'memory.cues.generation_enabled': 'false', 'memory.cues.read': 'off', 'memory.cues.push': 'false' };
    for (const [key, value] of Object.entries(settings)) await engine.setConfig(key, value);
    const generation: CueBuild = this.profile.arm === 'C1'
      ? await this.enrich(engine, [...sourceIds].sort(), this.profile)
      : { complete: true, observed: false, families: [], receipt: { mode: 'off', provider_calls: 0 } };
    const resolved: Record<string, string | null> = {};
    for (const key of [...Object.keys(settings), 'memory.cues.sources', 'memory.cues.weight', 'memory.cues.min_similarity']) resolved[key] = await engine.getConfig(key);
    const build = { source_sha256: this.sourceHash, sources: [...sourceIds].sort(), generation, resolved_config: resolved,
      source_timestamp: CAT13B_PILOT_TIMESTAMP, frozen_at: new Date().toISOString(), queries_exposed: false };
    writeFileSync(join(this.outputDir, 'build.json'), JSON.stringify(build, null, 2) + '\n', { flag: 'wx' });
    this.recordBuild(build);
    if (!generation.complete || (this.profile.arm === 'C1' && (!generation.observed || [...generation.families].sort().join(',') !== 'horizon,scene'))) throw new Cat36Failure('Cat13b cue construction incomplete or unobserved', 'dependency');
    if (resolved['memory.cues.read'] !== (this.profile.arm === 'C1' ? 'on' : 'off')) throw new Cat36Failure('Cat13b resolved cue read mode does not match the arm', 'dependency');
    if (Object.entries(settings).some(([key, value]) => !key.startsWith('memory.cues.') && resolved[key] !== value)) throw new Cat36Failure('Cat13b resolved native search settings changed', 'dependency');
    if (this.profile.arm === 'C1') {
      const enrolled = JSON.parse(resolved['memory.cues.sources'] ?? 'null');
      if (!Array.isArray(enrolled) || JSON.stringify([...enrolled].sort()) !== JSON.stringify([...sourceIds].sort())
        || Number(resolved['memory.cues.weight']) !== this.profile.cue_weight
        || resolved['memory.cues.min_similarity'] === null || Number(resolved['memory.cues.min_similarity']) !== this.profile.cue_min_similarity) throw new Cat36Failure('Cat13b resolved cue scope/weight/threshold mismatch', 'dependency');
    }
    return state;
  }

  query(query: PublicQuery, state: BrainState) { return this.inner.query(query, state); }
  resolvedConfig(state: BrainState) { return this.inner.resolvedConfig(state); }
  observedStats(state: BrainState) { return this.inner.observedStats(state); }
  async teardown(state: BrainState): Promise<void> {
    try { await this.inner.teardown(state); }
    finally { this.state = undefined; }
  }
  async close(): Promise<void> { if (this.state !== undefined) await this.teardown(this.state); }
}

let active = false;
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'COHERE_API_KEY'];

export async function runSituationRecallCat13b(options: Cat13bPilotOptions, dependencies?: Cat13bPilotDependencies): Promise<Receipt> {
  if (active) throw new Error('Cat13b pilot executions require separate processes');
  validateCat13bPilotProfile(options.profile);
  const profile = options.profile;
  const outputDir = resolve(options.outputDir);
  mkdirSync(dirname(outputDir), { recursive: true });
  mkdirSync(outputDir);
  const started = new Date().toISOString();
  const offline = profile.mode === 'offline' || dependencies !== undefined;
  const acc = new ProbeAccounting(QUERIES.length);
  let build: Record<string, unknown> | undefined;
  let result: SwampResult | undefined;
  let blocked: string | undefined;
  let identity: unknown = { verified: false, reason: 'validation-only or offline' };
  let wrapper: PreparedCat13bAdapter | undefined;
  let originalEnv: NodeJS.ProcessEnv | undefined;
  let factors: ReturnType<typeof assertBoostPremise> | undefined;
  const hashes: Record<string, string> = {
    driver: cat36Hash(readFileSync(import.meta.path)), native_runner: cat36Hash(readFileSync(join(import.meta.dir, 'cat13b-source-swamp.ts'))),
    profile: cat36Hash(JSON.stringify(profile)), gold: cat36Hash(JSON.stringify(QUERIES)),
  };
  try {
    const pages = loadCorpus(resolve(import.meta.dir, '../data/source-swamp-v1'));
    assertCorpusPremise(pages, QUERIES);
    if (pages.length !== 20 || QUERIES.length !== 30 || new Set(pages.map(page => page.slug)).size !== 20) throw new Error('native Cat13b pilot requires the unchanged 20-page/30-query cohort');
    hashes.corpus = cat36Hash(JSON.stringify(pages.map(sanitizePage)));
    if (options.execute) {
      if (!offline) identity = resolveRegressionProduct({ evalRoot: resolve(import.meta.dir, '../..'), expectedProductSha: profile.expected_product_sha, expectedPackageSha256: profile.expected_package_sha256, importerPath: import.meta.path });
      originalEnv = { ...process.env };
      active = true;
      const preserved = Object.fromEntries(['PATH', 'LANG', 'TZ', ...(!offline ? PROVIDER_KEYS : [])].filter(key => originalEnv![key]).map(key => [key, originalEnv![key]!]));
      for (const key of Object.keys(process.env)) delete process.env[key];
      const home = join(outputDir, 'home');
      mkdirSync(home);
      const configPath = join(home, '.gbrain', 'config.json');
      Object.assign(process.env, preserved, { HOME: home, GBRAIN_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GBRAIN_CONFIG: configPath, GBRAIN_DB_PATH: join(outputDir, 'brain') });
      mkdirSync(dirname(configPath));
      writeFileSync(configPath, JSON.stringify({ engine: 'pglite', embedding_model: profile.embedding_model,
        embedding_dimensions: profile.embedding_dimensions, chat_model: profile.generation_model }) + '\n', { flag: 'wx', mode: 0o600 });
      const loadedConfig = loadConfig();
      if (gbrainConfigPath() !== configPath || loadedConfig?.embedding_model !== profile.embedding_model
        || loadedConfig.embedding_dimensions !== profile.embedding_dimensions) throw new Cat36Failure('public config resolver did not load the pilot embedding profile', 'harness');
      hashes.config = cat36Hash(readFileSync(configPath));
      factors = assertBoostPremise();
      if (!dependencies) {
        configureGateway({ embedding_model: profile.embedding_model, embedding_dimensions: profile.embedding_dimensions, chat_model: profile.generation_model, env: process.env });
        if (offline) {
          process.env.OPENAI_API_KEY = 'dummy-embed-transport-stubbed';
          __setEmbedTransportForTests(async params => ({ embeddings: params.values.map(hashEmbed), values: params.values, warnings: [], usage: { tokens: 0 } }));
        } else {
          __setEmbedTransportForTests(null);
          assertCat36ProviderReadiness(profile, { embedding: diagnoseEmbedding().ok, reranker: true, expansion: true, generation: isAvailable('chat', profile.generation_model) });
        }
        if (profile.arm === 'C1') {
          const feature = await requireCueSupport();
          if (typeof feature.runMemoryCueBuild !== 'function') throw new Cat36Failure('public durable cue execution unavailable before source import', 'dependency');
          const admin = (await import('gbrain/operations')).operationsByName.memory_cues;
          if (!admin || admin.localOnly !== true || admin.scope !== 'admin') throw new Cat36Failure('trusted cue enrollment operation unavailable before source import', 'dependency');
        }
      } else if (profile.arm === 'C1' && !dependencies.buildCueIndex) throw new Cat36Failure('injected C1 requires an injected cue builder; no live fallback', 'harness');
      const inner = dependencies?.adapter ?? new GbrainInlineAdapter({ topK: TOP_K, searchConfig: { ...GBRAIN_SEARCH_CONFIG, 'search.tokenBudget': String(profile.token_budget),
        embedding_model: profile.embedding_model, embedding_dimensions: String(profile.embedding_dimensions),
        'memory.cues.generation_enabled': 'false', 'memory.cues.read': 'off', 'memory.cues.push': 'false' },
        embeddingModel: profile.embedding_model, embeddingDimensions: profile.embedding_dimensions, expectStubTransport: offline });
      if (inner.name !== 'gbrain') throw new Error('pilot must retain the native gbrain adapter identity');
      wrapper = new PreparedCat13bAdapter(inner, profile, outputDir, hashes.corpus, dependencies?.buildCueIndex ?? (async (engine, sourceIds, settings) => {
        configureGateway({ embedding_model: settings.embedding_model, embedding_dimensions: settings.embedding_dimensions, chat_model: settings.generation_model, env: process.env });
        return buildProductionCueIndex(engine, sourceIds, settings);
      }), value => { build = value; });
      result = await (dependencies?.score ?? scoreAdapter)(wrapper, pages, QUERIES, acc);
      const ids = result.per_query.map(row => row.id);
      if (ids.length !== QUERIES.length || new Set(ids).size !== ids.length || QUERIES.some(query => !ids.includes(query.id))) throw new Error('native scorer returned incomplete or duplicate query rows');
      for (const failure of cat13bCueObservationFailures(result, profile.arm)) acc.error(`gbrain:${failure.query_id}`, 'dependency', failure.reasons.join('; '));
    }
  } catch (error) {
    blocked = String(error);
    acc.error('pilot', error instanceof Cat36Failure ? error.origin : 'harness', blocked);
  } finally {
    try { await wrapper?.close(); }
    catch (error) { blocked = `native adapter teardown failed: ${String(error)}`; acc.error('cleanup', 'harness', blocked); }
    if (!dependencies && options.execute) __setEmbedTransportForTests(null);
    if (originalEnv) {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      active = false;
    }
  }
  if (build) hashes.build = cat36Hash(readFileSync(join(outputDir, 'build.json')));
  const summary = acc.summary();
  const nativeVerdict = computeVerdict13b(result, offline);
  const complete = Boolean(build && result && summary.n_total === summary.n_scored && !summary.errors.length);
  const receipt: Receipt = {
    schema_version: 1, benchmark_version: BENCHMARK_VERSION, category: CAT13B_PILOT_CATEGORY,
    run_status: blocked ? 'error' : !options.execute ? 'skipped' : 'completed',
    ...(!options.execute && !blocked ? { skip_reason: 'validation only; --execute is required' } : {}),
    ...(!blocked && options.execute ? { verdict: !complete && nativeVerdict.verdict === 'pass' ? 'partial' as const : nativeVerdict.verdict } : {}),
    n_total: summary.n_total, n_scored: summary.n_scored, completion_rate: summary.completion_rate, errors: summary.errors,
    publishable: !offline && complete && !blocked, gbrain_pin: gbrainPin(), gbrain_version: gbrainVersion(), started_at: started, finished_at: new Date().toISOString(), hashes,
    resolved_config: { profile, cohort: 'native gbrain only; 20 pages / 30 queries', native_top_k_pages: TOP_K, native_requested_chunks: TOP_K * 6,
      native_floor: { top1_hit_rate: PASS_TOP1 }, source_timestamp: CAT13B_PILOT_TIMESTAMP, query_recency: 'native automatic behavior; source timestamps fixed, wall clock not frozen',
      split: 'native 30-query catalog; Cat36 family split does not apply', embedding_cache: 'no pilot-level cache; native import runs for every cell',
      search_config: { ...GBRAIN_SEARCH_CONFIG, 'search.tokenBudget': String(profile.token_budget) }, source_boost_premise: factors,
      execution_mode: offline ? 'offline-plumbing' : 'live', isolated_home: options.execute ? join(outputDir, 'home') : null,
      config_path: options.execute ? join(outputDir, 'home', '.gbrain', 'config.json') : null,
      budget_enforcement: 'operator-provided isolated provider cap; no driver dollar limiter', product_identity: identity },
    data: { label: 'Cat13b gbrain pilot cohort; not full all-adapter Cat13b release coverage', release_coverage: false,
      blocked_reason: blocked ?? null, build: build ?? null, result: result ?? null, native_gate_pass: nativeVerdict.gatePass,
      receipt_path: join(outputDir, 'receipt.json'), result_path: join(outputDir, 'result.json') },
  };
  writeFileSync(join(outputDir, 'result.json'), JSON.stringify({ profile, build: build ?? null, result: result ?? null, publishable: receipt.publishable, release_coverage: false }, null, 2) + '\n', { flag: 'wx' });
  writeReceipt(join(outputDir, 'receipt.json'), receipt);
  return receipt;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let execute = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute' && !execute) execute = true;
    else if (['--profile', '--output'].includes(args[i]) && !values.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) values.set(args[i], args[++i]);
    else throw new Error(`invalid or duplicate option ${args[i]}`);
  }
  if (!values.has('--profile') || !values.has('--output')) throw new Error('Usage: bun eval/runner/situation-recall-cat13b.ts --profile <Cat36Profile.json> --output <new-directory> [--execute]');
  const receipt = await runSituationRecallCat13b({ profile: JSON.parse(readFileSync(values.get('--profile')!, 'utf8')), outputDir: values.get('--output')!, execute });
  console.log(JSON.stringify({ receipt: receipt.data?.receipt_path, status: receipt.run_status, publishable: receipt.publishable, release_coverage: false }));
  if (receipt.run_status === 'completed' && receipt.verdict === 'fail') process.exitCode = 1;
  else if (receipt.run_status !== 'completed' || receipt.verdict !== 'pass' || !receipt.publishable) process.exitCode = 2;
}
