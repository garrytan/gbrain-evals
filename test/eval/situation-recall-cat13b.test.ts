import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configPath, loadConfig } from 'gbrain/config';
import { QUERIES, PASS_TOP1, computeVerdict13b, scoreAdapter, type SwampResult } from '../../eval/runner/cat13b-source-swamp.ts';
import { offlineCat36Profile, type Cat36Profile } from '../../eval/runner/cat36-associative-retrieval.ts';
import { cat13bCueObservationFailures, runSituationRecallCat13b, validateCat13bPilotProfile, CAT13B_PILOT_TIMESTAMP, type Cat13bPilotDependencies } from '../../eval/runner/situation-recall-cat13b.ts';
import type { SearchObservation } from '../../eval/runner/retrieval-pins.ts';
import type { Page } from '../../eval/runner/types.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function output(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cat13b-pilot-'));
  directories.push(directory);
  return join(directory, 'run');
}

function profile(arm: 'B' | 'C0' | 'C1' = 'B'): Cat36Profile {
  if (arm === 'B') return { ...offlineCat36Profile(), token_budget: 12000 };
  return { ...offlineCat36Profile(), id: `test-only-${arm}`, mode: 'live', arm, token_budget: 12000,
    expected_product_sha: 'a'.repeat(40), cue_min_similarity: 0.6, generation_model: 'anthropic:claude-haiku-4-5', build_max_usd: 1,
    provider_budget: { kind: 'isolated-provider-cap', approval_id: 'test-only-not-spend-authorization', max_usd: 2 } };
}

function observation(id: string, cue?: Record<string, unknown>): SearchObservation {
  const query = QUERIES.find(query => query.id === id)!;
  return { query_id: id, query: query.text, mode: 'hybrid', result_count: 6, rerank_scored: false,
    ranked_results: [{ slug: query.target, score: 0.9, rank: 1, chunk_id: 1 }],
    search_meta: { vector_enabled: true, expansion_applied: false, ...(cue ? { memory_cues: cue } : {}) } as SearchObservation['search_meta'],
    relational_meta: null, failures: [] };
}

function injected(options: { outputDir: string; arm?: 'B' | 'C0' | 'C1'; misses?: number; badCue?: boolean; cue?: Record<string, unknown>; embedding?: { model: string; dimensions: number } }) {
  const config = new Map<string, string>();
  const observations: SearchObservation[] = [];
  const captured: { pages: Page[]; timestamps: unknown[][]; builds: number; queries: number; teardown: number } = { pages: [], timestamps: [], builds: 0, queries: 0, teardown: 0 };
  const engine = {
    async getPage(slug: string) { return { slug, id: captured.pages.findIndex(page => page.slug === slug) + 1, source_id: 'default' }; },
    async executeRaw(_sql: string, params: unknown[]) { captured.timestamps.push(params); return []; },
    async setConfig(key: string, value: string) { config.set(key, value); },
    async getConfig(key: string) { return config.get(key) ?? null; },
  };
  const dependencies: Cat13bPilotDependencies = {
    adapter: {
      name: 'gbrain',
      async init(pages) {
        expect(process.env.GBRAIN_SOURCE_BOOST).toBeUndefined();
        expect(process.env.DATABASE_URL).toBeUndefined();
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
        expect(process.env.GBRAIN_HOME).toBe(join(options.outputDir, 'home'));
        expect(configPath()).toBe(join(options.outputDir, 'home', '.gbrain', 'config.json'));
        const effectiveConfig = loadConfig();
        expect(effectiveConfig?.embedding_model).toBe(options.embedding?.model ?? 'openai:text-embedding-3-large');
        expect(effectiveConfig?.embedding_dimensions).toBe(options.embedding?.dimensions ?? 1536);
        expect(effectiveConfig?.engine).toBe('pglite');
        captured.pages = pages;
        expect(pages).toHaveLength(20);
        expect(pages.every(page => !('_facts' in page) && !('frontmatter' in page))).toBe(true);
        return engine;
      },
      engineOf() { return engine as unknown as ReturnType<Cat13bPilotDependencies['adapter']['engineOf']>; },
      async query(query) {
        expect(existsSync(join(options.outputDir, 'build.json'))).toBe(true);
        expect('gold' in query).toBe(false);
        captured.queries++;
        const cue = options.arm === 'C1' ? options.cue ?? { mode: 'on', status: options.badCue ? 'skipped' : 'ready', candidates: 1, admitted: 1 } : undefined;
        const observed = observation(query.id, cue);
        const missed = captured.queries <= (options.misses ?? 0);
        if (missed) { observed.result_count = 0; observed.ranked_results = []; }
        observations.push(observed);
        if (missed) return [];
        return [{ page_id: QUERIES.find(value => value.id === query.id)!.target, score: 0.9, rank: 1 }];
      },
      resolvedConfig() { return Object.fromEntries(config); },
      observedStats() { return { queries: captured.queries, rerank_scored_queries: 0, keyword_arm_confidence_stamped: 0, keyword_arm_confidence_downweighted: 0, search_observations: observations }; },
      async teardown() { captured.teardown++; },
    },
    async buildCueIndex(actual, sources, settings) {
      expect(actual as unknown).toBe(engine);
      expect(sources).toEqual(['default']);
      expect(settings.arm).toBe('C1');
      expect(captured.queries).toBe(0);
      expect(captured.pages).toHaveLength(20);
      captured.builds++;
      await engine.setConfig('memory.cues.read', 'on');
      await engine.setConfig('memory.cues.generation_enabled', 'true');
      await engine.setConfig('memory.cues.sources', JSON.stringify(sources));
      await engine.setConfig('memory.cues.weight', String(settings.cue_weight));
      await engine.setConfig('memory.cues.min_similarity', String(settings.cue_min_similarity));
      return { complete: true, observed: true, families: ['scene', 'horizon'], receipt: { test_only: true } };
    },
  };
  return { dependencies, captured, config };
}

describe('Cat13b pilot admission and protocol', () => {
  test('preserves native settings and rejects unrelated arms or unbounded profiles', () => {
    expect(() => validateCat13bPilotProfile(profile())).not.toThrow();
    expect(() => validateCat13bPilotProfile({ ...profile('C1'), provider_budget: undefined })).toThrow('provider cap');
    expect(() => validateCat13bPilotProfile({ ...profile('C1'), build_max_usd: 10 })).toThrow('budget');
    expect(() => validateCat13bPilotProfile({ ...profile('C1'), arm: 'horizon' })).toThrow('native B/C0/C1');
    expect(() => validateCat13bPilotProfile({ ...profile(), search_config: { ...profile().search_config, 'search.mode': 'conservative' } })).toThrow('native setting');
  });

  test('default validation does not initialize the adapter or run any query', async () => {
    const outputDir = output();
    const fake = injected({ outputDir });
    const receipt = await runSituationRecallCat13b({ profile: profile(), outputDir }, fake.dependencies);
    expect(receipt.run_status).toBe('skipped');
    expect(receipt.publishable).toBe(false);
    expect(receipt.n_total).toBe(30);
    expect(fake.captured.pages).toEqual([]);
    expect(fake.captured.queries).toBe(0);
    expect(existsSync(join(outputDir, 'build.json'))).toBe(false);
  });

  test('B and C0 retain native scorer accounting and never build cues', async () => {
    for (const arm of ['B', 'C0'] as const) {
      const outputDir = output();
      const fake = injected({ outputDir, arm });
      const receipt = await runSituationRecallCat13b({ profile: profile(arm), outputDir, execute: true }, fake.dependencies);
      expect(receipt.run_status).toBe('completed');
      expect(receipt.verdict).toBe('partial');
      expect(receipt.n_scored).toBe(30);
      expect(fake.captured.builds).toBe(0);
      expect(fake.captured.teardown).toBe(1);
      expect(fake.captured.timestamps).toHaveLength(20);
      expect(fake.captured.timestamps.every(params => params[0] === CAT13B_PILOT_TIMESTAMP)).toBe(true);
      expect(fake.config.get('search.tokenBudget')).toBe('12000');
      expect(fake.config.get('embedding_model')).toBe('openai:text-embedding-3-large');
      expect(fake.config.get('embedding_dimensions')).toBe('1536');
      expect(receipt.resolved_config?.native_requested_chunks).toBe(30);
      expect(receipt.resolved_config?.native_top_k_pages).toBe(5);
      expect(receipt.data?.release_coverage).toBe(false);
      expect(receipt.publishable).toBe(false);
      expect((receipt.data?.result as SwampResult).per_query[0].search_observation?.ranked_results[0].chunk_id).toBe(1);
    }
  });

  test('C1 builds only source state and freezes its receipt before native queries', async () => {
    const outputDir = output();
    const fake = injected({ outputDir, arm: 'C1' });
    const receipt = await runSituationRecallCat13b({ profile: profile('C1'), outputDir, execute: true }, fake.dependencies);
    expect(fake.captured.builds).toBe(1);
    expect(fake.captured.queries).toBe(30);
    expect(receipt.n_scored).toBe(30);
    expect(receipt.errors).toEqual([]);
    expect(receipt.hashes?.build).toMatch(/^[a-f0-9]{64}$/);
    const build = JSON.parse(readFileSync(join(outputDir, 'build.json'), 'utf8'));
    expect(build.generation.observed).toBe(true);
    expect(build.queries_exposed).toBe(false);
    expect(receipt.publishable).toBe(false);
    expect((receipt.data?.result as SwampResult).per_query).toHaveLength(30);
  });

  test('explicit encoder changes reach the real file plane before init and the database before queries', async () => {
    const outputDir = output();
    const embedding = { model: 'openai:text-embedding-3-small', dimensions: 512 };
    const fake = injected({ outputDir, arm: 'C0', embedding });
    const selected = { ...profile('C0'), embedding_model: embedding.model, embedding_dimensions: embedding.dimensions };
    const receipt = await runSituationRecallCat13b({ profile: selected, outputDir, execute: true }, fake.dependencies);
    expect(receipt.run_status).toBe('completed');
    expect(fake.config.get('embedding_model')).toBe(embedding.model);
    expect(fake.config.get('embedding_dimensions')).toBe(String(embedding.dimensions));
    expect(receipt.resolved_config?.config_path).toBe(join(outputDir, 'home', '.gbrain', 'config.json'));
    expect(receipt.hashes?.config).toMatch(/^[a-f0-9]{64}$/);
    const build = JSON.parse(readFileSync(join(outputDir, 'build.json'), 'utf8'));
    expect(build.resolved_config.embedding_model).toBe(embedding.model);
    expect(build.resolved_config.embedding_dimensions).toBe(String(embedding.dimensions));
    expect(receipt.publishable).toBe(false);
  });

  test('requested-on but unobserved generation cannot expose any query', async () => {
    const outputDir = output();
    const fake = injected({ outputDir, arm: 'C1' });
    fake.dependencies.buildCueIndex = async () => ({ complete: true, observed: false, families: ['scene', 'horizon'], receipt: { test_only: true } });
    const receipt = await runSituationRecallCat13b({ profile: profile('C1'), outputDir, execute: true }, fake.dependencies);
    expect(receipt.run_status).toBe('error');
    expect(receipt.errors[0].origin).toBe('dependency');
    expect(fake.captured.queries).toBe(0);
    expect(fake.captured.teardown).toBe(1);
    expect(existsSync(join(outputDir, 'build.json'))).toBe(true);
  });

  test('a successful cue build without observed per-query admission remains incomplete', async () => {
    const outputDir = output();
    const fake = injected({ outputDir, arm: 'C1', badCue: true });
    const receipt = await runSituationRecallCat13b({ profile: profile('C1'), outputDir, execute: true }, fake.dependencies);
    expect(receipt.errors).toHaveLength(30);
    expect(receipt.errors.every(error => error.message.includes('unexercised'))).toBe(true);
    expect(receipt.publishable).toBe(false);
  });

  test.each(['candidate_budget', 'iterative_scan_unavailable', 'evidence_budget_incomplete'])('bounded no-hit cue lookup %s keeps all thirty native misses scored', async reason => {
    const outputDir = output();
    const fake = injected({ outputDir, arm: 'C1', misses: 30, cue: { mode: 'on', status: 'degraded', reason, candidates: 0, admitted: 0 } });
    const receipt = await runSituationRecallCat13b({ profile: profile('C1'), outputDir, execute: true }, fake.dependencies);
    const result = receipt.data?.result as SwampResult;
    expect(receipt.run_status).toBe('completed');
    expect(receipt.n_total).toBe(30);
    expect(receipt.n_scored).toBe(30);
    expect(receipt.completion_rate).toBe(1);
    expect(receipt.errors).toEqual([]);
    expect(receipt.verdict).toBe('fail');
    expect(result.top1_hit_rate).toBe(0);
    expect(result.per_query.every(row => row.targetRank === -1 && row.top_slugs.length === 0)).toBe(true);
    expect(cat13bCueObservationFailures(result, 'C1')).toEqual([]);
  });

  test.each(['missing_provider', 'missing_index', 'missing_schema', 'model_mismatch', 'deadline'])('unavailable cue prerequisite %s remains blocked', reason => {
    for (const status of ['ready', 'degraded']) {
      const search_observations = QUERIES.map(query => observation(query.id, { mode: 'on', status, reason, candidates: 0, admitted: 0 }));
      const result = { observed: { search_observations } } as unknown as SwampResult;
      const failures = cat13bCueObservationFailures(result, 'C1');
      expect(failures).toHaveLength(30);
      expect(failures.every(failure => failure.reasons.includes('cue_arm_unexercised'))).toBe(true);
    }
  });

  test('native 80% top-one floor is unchanged, including exact boundary', async () => {
    expect(PASS_TOP1).toBe(0.8);
    for (const [misses, verdict] of [[6, 'partial'], [7, 'fail']] as const) {
      const outputDir = output();
      const fake = injected({ outputDir, misses });
      const receipt = await runSituationRecallCat13b({ profile: profile(), outputDir, execute: true }, fake.dependencies);
      expect(receipt.verdict).toBe(verdict);
      const result = receipt.data?.result as SwampResult;
      expect(result.top1_hit_rate).toBe((30 - misses) / 30);
      expect(computeVerdict13b(result, true).verdict).toBe(verdict);
      expect(receipt.n_scored).toBe(30);
    }
  });

  test('restores ambient environment after injected execution', async () => {
    const previous = { GBRAIN_SOURCE_BOOST: process.env.GBRAIN_SOURCE_BOOST, DATABASE_URL: process.env.DATABASE_URL, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
    Object.assign(process.env, { GBRAIN_SOURCE_BOOST: 'originals/:0.1', DATABASE_URL: 'not-a-real-db', OPENAI_API_KEY: 'offline-test-placeholder' });
    try {
      const outputDir = output();
      await runSituationRecallCat13b({ profile: profile(), outputDir, execute: true }, injected({ outputDir }).dependencies);
      expect(process.env.GBRAIN_SOURCE_BOOST).toBe('originals/:0.1');
      expect(process.env.DATABASE_URL).toBe('not-a-real-db');
      expect(process.env.OPENAI_API_KEY).toBe('offline-test-placeholder');
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  test('rejects partial or duplicated native observations', () => {
    const observations = QUERIES.map(query => observation(query.id));
    const result = { observed: { search_observations: observations } } as unknown as SwampResult;
    expect(cat13bCueObservationFailures(result, 'B')).toEqual([]);
    observations[1] = observations[0];
    expect(cat13bCueObservationFailures(result, 'B').some(f => f.reasons.includes('query_observation_identity_mismatch'))).toBe(true);
    expect(cat13bCueObservationFailures({ observed: {} } as SwampResult, 'C1').length).toBeGreaterThan(0);
  });

  test('injected C1 cannot accidentally fall back to the live cue builder', async () => {
    const outputDir = output();
    const fake = injected({ outputDir, arm: 'C1' });
    delete fake.dependencies.buildCueIndex;
    const receipt = await runSituationRecallCat13b({ profile: profile('C1'), outputDir, execute: true }, fake.dependencies);
    expect(receipt.run_status).toBe('error');
    expect(fake.captured.pages).toHaveLength(0);
  });

  test('native scorer injection remains explicitly nonpublishable', async () => {
    const outputDir = output();
    const fake = injected({ outputDir });
    let scoreCalls = 0;
    fake.dependencies.score = async (...args) => { scoreCalls++; return scoreAdapter(...args); };
    const receipt = await runSituationRecallCat13b({ profile: profile(), outputDir, execute: true }, fake.dependencies);
    expect(scoreCalls).toBe(1);
    expect(receipt.publishable).toBe(false);
  });

  test('native query exceptions remain SUT misses in all thirty denominators', async () => {
    const outputDir = output();
    const fake = injected({ outputDir });
    const query = fake.dependencies.adapter.query;
    fake.dependencies.adapter.query = async (value, state) => {
      if (value.id === 'q01') throw new Error('fixture SUT failure');
      return query(value, state);
    };
    const receipt = await runSituationRecallCat13b({ profile: profile(), outputDir, execute: true }, fake.dependencies);
    const result = receipt.data?.result as SwampResult;
    expect(receipt.n_scored).toBe(30);
    expect(result.top1_hit_rate).toBe(29 / 30);
    expect(result.per_query[0].targetRank).toBe(-1);
    expect(receipt.errors.some(error => error.origin === 'sut' && error.probe_id === 'gbrain:q01')).toBe(true);
    expect(receipt.publishable).toBe(false);
  });

  test('a duplicate native scored row blocks instead of replacing a missing query', async () => {
    const outputDir = output();
    const fake = injected({ outputDir });
    fake.dependencies.score = async (...args) => {
      const result = await scoreAdapter(...args);
      result.per_query[1] = result.per_query[0];
      return result;
    };
    const receipt = await runSituationRecallCat13b({ profile: profile(), outputDir, execute: true }, fake.dependencies);
    expect(receipt.run_status).toBe('error');
    expect(receipt.data?.blocked_reason).toContain('duplicate query');
    expect(receipt.publishable).toBe(false);
  });

  test('refuses to reuse an existing output directory before adapter initialization', async () => {
    const outputDir = output();
    const fake = injected({ outputDir });
    await runSituationRecallCat13b({ profile: profile(), outputDir }, fake.dependencies);
    await expect(runSituationRecallCat13b({ profile: profile(), outputDir, execute: true }, fake.dependencies)).rejects.toThrow();
    expect(fake.captured.pages).toEqual([]);
  });

  test('CLI requires explicit execution and surfaces validation-only receipt', () => {
    const outputDir = output();
    const profilePath = join(dirname(outputDir), 'profile.json');
    writeFileSync(profilePath, JSON.stringify(profile()));
    const child = Bun.spawnSync([process.execPath, 'eval/runner/situation-recall-cat13b.ts', '--profile', profilePath, '--output', outputDir], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    expect(child.exitCode).toBe(2);
    expect(loadReceipt(join(outputDir, 'receipt.json')).run_status).toBe('skipped');
    expect(existsSync(join(outputDir, 'build.json'))).toBe(false);
  });
});

test('real native Cat13b baseline plumbing makes zero network calls', () => {
  const outputDir = output();
  const script = `
    import { runSituationRecallCat13b } from './eval/runner/situation-recall-cat13b.ts';
    let networkCalls=0;
    globalThis.fetch=async()=>{networkCalls++;throw new Error('Network prohibited in offline pilot');};
    const receipt=await runSituationRecallCat13b({profile:${JSON.stringify(profile())},outputDir:${JSON.stringify(outputDir)},execute:true});
    if(receipt.run_status!=='completed'||receipt.n_scored!==30||networkCalls!==0||receipt.publishable!==false)throw new Error(JSON.stringify({errors:receipt.errors,networkCalls,n_scored:receipt.n_scored}));
    console.log(JSON.stringify({networkCalls,n:receipt.n_scored,publishable:receipt.publishable,verdict:receipt.verdict}));
  `;
  const child = Bun.spawnSync([process.execPath, '-e', script], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 120_000 });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!);
  expect(result.networkCalls).toBe(0);
  expect(result.n).toBe(30);
  expect(result.publishable).toBe(false);
}, 130_000);
