import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cat36Hash, constructionSources, fixturePageId, loadCat36Corpus, loadCat36Counterfactual, loadCat36Sources, type Cat36BuildSource, type Cat36Domain, type Cat36Split } from './cat36-corpus.ts';
import { CAT36_SCORER, scoreCat36Probe, type Cat36Chunk, type Cat36CueObservation, type Cat36Score } from './cat36-scorer.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { executedCueLookup } from './situation-recall-observations.ts';
import type { Cat36IndexSnapshot } from './cat36-snapshot.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, receiptPath, writeReceipt, type FailureOrigin, type Receipt } from './receipt.ts';

export const CAT36_CATEGORY = 'cat36-associative-retrieval';
export type Cat36Arm = 'B' | 'C0' | 'C1' | 'scene' | 'horizon' | 'scene-horizon-bridge' | 'summary';
export interface Cat36Profile {
  id: string;
  mode: 'offline' | 'live';
  arm: Cat36Arm;
  split: Cat36Split;
  counterfactual?: string;
  required_operations?: Array<'search' | 'query' | 'recall'>;
  reuse_build_dir?: string;
  expected_product_sha?: string;
  expected_package_sha256?: string;
  embedding_model: string;
  embedding_dimensions: number;
  search_config: Record<string, string>;
  token_budget: number;
  cue_min_similarity?: number;
  cue_weight: number;
  generation_model?: string;
  expansion_model?: string;
  build_max_usd?: number;
  provider_budget?: { kind: 'isolated-provider-cap'; approval_id: string; max_usd: number };
}
export interface Cat36BuildReceipt {
  runtime_kind?: 'production' | 'test';
  construction_profile?: Cat36Profile;
  index_snapshot?: Cat36IndexSnapshot;
  mode: 'offline' | 'live';
  complete: boolean;
  feature_supported: boolean;
  generation_observed: boolean;
  families: string[];
  source_hash: string;
  resolved_config: Record<string, unknown>;
  provenance: Record<string, unknown>;
  mappings: Array<Record<string, unknown>>;
  generation: Record<string, unknown>;
}
export interface Cat36Runtime {
  readonly kind: 'production' | 'test';
  build(sources: readonly Cat36BuildSource[], profile: Cat36Profile): Promise<Cat36BuildReceipt>;
  operation?(surface: 'search' | 'query' | 'recall', text: string): Promise<unknown>;
  search(text: string, options: { limit: 5; tokenBudget: number }): Promise<{
    chunks: Cat36Chunk[];
    cue: Cat36CueObservation;
    failures: string[];
    metadata: unknown;
  }>;
  close(): Promise<void>;
}
export interface Cat36Row {
  probe_id: string;
  family_id: string;
  domain: Cat36Domain;
  split: Cat36Split;
  kind: 'indirect' | 'direct' | 'negative';
  tags: string[];
  metrics: Cat36Score | null;
  chunks: Cat36Chunk[];
  cue: Cat36CueObservation;
  latency_ms: number;
  observation_failures: string[];
  metadata: unknown;
  error?: { origin: FailureOrigin; message: string };
  failed_response?: unknown;
}

export class Cat36Failure extends Error {
  constructor(message: string, readonly origin: FailureOrigin = 'harness') { super(message); }
}

export function cueFamilies(arm: Cat36Arm): string[] {
  if (arm === 'scene') return ['scene'];
  if (arm === 'horizon') return ['horizon'];
  if (arm === 'scene-horizon-bridge') return ['scene', 'horizon', 'bridge'];
  if (arm === 'C1') return ['scene', 'horizon'];
  return [];
}

export function validateCat36Profile(p: Cat36Profile): void {
  const allowed = new Set(['id', 'mode', 'arm', 'split', 'counterfactual', 'required_operations', 'reuse_build_dir', 'expected_product_sha', 'expected_package_sha256', 'embedding_model', 'embedding_dimensions', 'search_config', 'token_budget', 'cue_min_similarity', 'cue_weight', 'generation_model', 'expansion_model', 'build_max_usd', 'provider_budget']);
  if (!p || Object.keys(p).some(k => !allowed.has(k))) throw new Error('unknown Cat36 profile field');
  if (!p.id || !['offline', 'live'].includes(p.mode) || !['B', 'C0', 'C1', 'scene', 'horizon', 'scene-horizon-bridge', 'summary'].includes(p.arm)
    || !['dev', 'holdout'].includes(p.split)) throw new Error('invalid Cat36 profile identity');
  if (p.counterfactual !== undefined && (typeof p.counterfactual !== 'string' || !p.counterfactual)) throw new Error('invalid counterfactual identity');
  if (p.required_operations !== undefined && (!Array.isArray(p.required_operations) || !p.required_operations.length
    || p.required_operations.some(s => !['search', 'query', 'recall'].includes(s)) || new Set(p.required_operations).size !== p.required_operations.length)) throw new Error('invalid operation surface list');
  const readOnlyAblation = p.arm === 'scene' || p.arm === 'horizon';
  if (readOnlyAblation && (typeof p.reuse_build_dir !== 'string' || !p.reuse_build_dir || p.build_max_usd !== undefined)) throw new Error('Scene/Horizon ablations require frozen C1 construction and no new build allowance');
  if (!readOnlyAblation && p.reuse_build_dir !== undefined) throw new Error('only Scene/Horizon read-time ablations may reuse a cue index');
  if (!Number.isInteger(p.embedding_dimensions) || p.embedding_dimensions <= 0 || !p.embedding_model.includes(':')
    || !Number.isInteger(p.token_budget) || p.token_budget < 1 || !Number.isFinite(p.cue_weight) || p.cue_weight <= 0 || p.cue_weight > 0.5) throw new Error('invalid Cat36 numeric configuration');
  const keys = ['search.mode', 'search.reranker.enabled', 'search.reranker.model', 'search.expansion', 'search.autocut', 'search.cache.enabled', 'search.adaptive_return', 'search.contextual_retrieval', 'search.recency_boost'];
  if (!p.search_config || Object.keys(p.search_config).some(k => !keys.includes(k)) || keys.some(k => typeof p.search_config[k] !== 'string')) throw new Error('explicit allowlisted search configuration required');
  if (!['balanced', 'conservative', 'tokenmax'].includes(p.search_config['search.mode'])) throw new Error('invalid search mode');
  if (!['none', 'title', 'per_chunk_synopsis'].includes(p.search_config['search.contextual_retrieval'])
    || !p.search_config['search.reranker.model'].includes(':')) throw new Error('invalid contextual retrieval or reranker model');
  if (p.search_config['search.cache.enabled'] !== 'false') throw new Error('semantic result caching is not exercised by the raw production profile');
  for (const key of keys.filter(k => !['search.mode', 'search.reranker.model', 'search.contextual_retrieval'].includes(k))) {
    if (!['true', 'false'].includes(p.search_config[key])) throw new Error(`invalid boolean setting ${key}`);
  }
  if (p.mode === 'offline' && (p.arm !== 'B' || p.search_config['search.reranker.enabled'] !== 'false' || p.search_config['search.expansion'] !== 'false')) throw new Error('offline profile is keyless baseline plumbing only');
  if (p.mode === 'live') {
    if (!/^[a-f0-9]{40}$/.test(p.expected_product_sha ?? '')) throw new Error('live profile needs exact product SHA');
    if (p.expected_package_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(p.expected_package_sha256)) throw new Error('invalid package content hash');
    if ((p.search_config['search.expansion'] === 'true' || p.required_operations?.includes('query')) && !p.expansion_model?.includes(':')) throw new Error('live expansion requires an explicit model');
    const b = p.provider_budget;
    if (!b || b.kind !== 'isolated-provider-cap' || !b.approval_id || !Number.isFinite(b.max_usd) || b.max_usd <= 0
      || Object.keys(b).some(k => !['kind', 'approval_id', 'max_usd'].includes(k))) throw new Error('live work requires approved isolated provider cap, not a concurrency limit');
    if (readOnlyAblation && !p.generation_model?.includes(':')) throw new Error('read-time ablation must name the original generation model');
    if ((!readOnlyAblation && cueFamilies(p.arm).length) || p.arm === 'summary') {
      if (!p.generation_model?.includes(':') || !Number.isFinite(p.build_max_usd) || p.build_max_usd! < 0.01 || p.build_max_usd! > 10000 || p.build_max_usd! > b.max_usd) throw new Error('invalid generation budget/model');
    }
    if (cueFamilies(p.arm).length && (!Number.isFinite(p.cue_min_similarity) || Math.abs(p.cue_min_similarity!) > 1)) throw new Error('explicit encoder-calibrated cue threshold required');
    if (p.arm === 'summary' && (b.max_usd !== p.build_max_usd || p.search_config['search.contextual_retrieval'] !== 'per_chunk_synopsis')) throw new Error('summary requires explicit per_chunk_synopsis and equal externally enforced whole-cell/build ceilings');
  }
}

export function offlineCat36Profile(): Cat36Profile {
  return {
    id: 'offline-keyword-plumbing', mode: 'offline', arm: 'B', split: 'dev',
    embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    token_budget: 4096, cue_weight: 0.25,
    search_config: {
      'search.mode': 'balanced', 'search.reranker.enabled': 'false', 'search.reranker.model': 'voyage:rerank-2.5',
      'search.expansion': 'false', 'search.autocut': 'false', 'search.cache.enabled': 'false',
      'search.adaptive_return': 'false', 'search.contextual_retrieval': 'none', 'search.recency_boost': 'false',
    },
  };
}

function summarize(rows: Cat36Row[]): Record<string, unknown> {
  const rollup = (subset: Cat36Row[]) => {
    const metrics: Record<string, { mean: number | null; n: number }> = {};
    for (const key of ['all_evidence_in_top5_chunks', 'page_recall_at5', 'page_precision_at5', 'page_mrr', 'page_ndcg_at5', 'associative_false_fire', 'negative_result_count', 'returned_evidence_tokens', 'safety_violations'] as const) {
      const values = subset.filter(r => !r.error || r.error.origin === 'sut').map(r => r.metrics?.[key]).filter((v): v is number => typeof v === 'number');
      metrics[key] = { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, n: values.length };
    }
    return metrics;
  };
  return {
    all: rollup(rows),
    by_kind: Object.fromEntries(['indirect', 'direct', 'negative'].map(kind => [kind, rollup(rows.filter(r => r.kind === kind))])),
    by_domain: Object.fromEntries([...new Set(rows.map(r => r.domain))].map(domain => [domain, rollup(rows.filter(r => r.domain === domain))])),
    multi_evidence: rollup(rows.filter(r => r.tags.includes('multi-evidence'))),
  };
}

export async function runCat36(options: { corpusDir: string; outputDir: string; profile: Cat36Profile; runtime: Cat36Runtime; smoke?: boolean }): Promise<Receipt> {
  const { corpusDir, outputDir, profile, runtime } = options;
  validateCat36Profile(profile);
  mkdirSync(outputDir, { recursive: true });
  if (readdirSync(outputDir).length) throw new Error('Cat36 output directory must be empty; previous receipts are immutable');
  const started = new Date().toISOString();
  let accounting = new ProbeAccounting(profile.counterfactual ? 1 : options.smoke ? 4 : profile.split === 'dev' ? 160 : 320);
  const rows: Cat36Row[] = [];
  let build: Cat36BuildReceipt | undefined;
  let blocked: string | undefined;
  let hashes: Record<string, string> = {};
  let reviewed = false;
  try {
    const sourceFile = loadCat36Sources(corpusDir);
    const variant = profile.counterfactual ? loadCat36Counterfactual(corpusDir, profile.counterfactual) : undefined;
    const sourceInput = constructionSources(sourceFile.sources.map(s => variant && fixturePageId(s) === fixturePageId(variant) ? { ...s, text: variant.replacement_text } : s));
    hashes = {
      ...sourceFile.manifest.hashes,
      profile: cat36Hash(JSON.stringify(profile)),
      runner: cat36Hash(readFileSync(import.meta.path)),
      runtime: cat36Hash(readFileSync(join(import.meta.dir, 'cat36-production.ts'))),
      corpus_loader: cat36Hash(readFileSync(join(import.meta.dir, 'cat36-corpus.ts'))),
      scorer: cat36Hash(readFileSync(join(import.meta.dir, 'cat36-scorer.ts'))),
      models: cat36Hash(JSON.stringify({ embedding: profile.embedding_model, dimensions: profile.embedding_dimensions,
        reranker: profile.search_config['search.reranker.model'], generation: profile.generation_model ?? null, expansion: profile.expansion_model ?? null })),
      prompts: cat36Hash(JSON.stringify({ protocol: 'source-only-build-raw-probe-query-v1', build_input: 'canonical source text only', query_input: 'unchanged probe.text', product_generation_prompt: 'recorded separately in build.generation' })),
      source_timestamps: cat36Hash(JSON.stringify(sourceInput.map(s => [s.source_id, s.slug, s.created_at, s.updated_at]))),
    };
    build = { ...await runtime.build(sourceInput, profile), runtime_kind: runtime.kind, construction_profile: structuredClone(profile) };
    if (build.source_hash !== cat36Hash(JSON.stringify(sourceInput)) || build.mode !== profile.mode) throw new Cat36Failure('build source/mode mismatch');
    writeFileSync(join(outputDir, 'build.json'), JSON.stringify({ ...build, frozen_at: new Date().toISOString(), profile_hash: hashes.profile }, null, 2) + '\n', { flag: 'wx' });
    hashes.build = cat36Hash(readFileSync(join(outputDir, 'build.json')));
    if (!build.complete) throw new Cat36Failure('construction incomplete', 'dependency');
    const expectedFamilies = cueFamilies(profile.arm);
    if (expectedFamilies.length && (!build.feature_supported || !build.generation_observed
      || [...build.families].sort().join(',') !== [...expectedFamilies].sort().join(','))) throw new Cat36Failure('requested cue construction unexercised', 'dependency');
    if (profile.arm === 'summary' && !build.generation_observed) throw new Cat36Failure('real contextual-summary generation unexercised', 'dependency');
    const corpus = loadCat36Corpus(corpusDir);
    if (Object.entries(hashes).some(([name, hash]) => name in corpus.manifest.hashes && corpus.manifest.hashes[name] !== hash)) throw new Cat36Failure('corpus changed after construction');
    reviewed = corpus.manifest.review.status === 'approved' && Boolean(corpus.manifest.review.reviewer)
      && Object.entries(corpus.manifest.hashes).every(([name, hash]) => corpus.manifest.review.reviewed_hashes?.[name] === hash);
    const familyMap = new Map(corpus.families.map(f => [f.id, f]));
    const selected = corpus.probes.filter(p => familyMap.get(p.family_id)?.split === profile.split);
    let probes = options.smoke ? selected.filter(p => p.family_id === selected[0].family_id) : selected;
    if (variant) {
      const base = selected.find(p => p.id === variant.base_probe_id && p.family_id === variant.family_id && p.kind !== 'negative');
      if (!base) throw new Cat36Failure('counterfactual base probe is missing or crosses family/split');
      const originalGold = corpus.spans.filter(s => base.required_span_ids.includes(s.id) && fixturePageId(s) !== fixturePageId(variant)).map(s => s.id);
      const replacement = variant.required_spans.map(s => ({ ...s, source_id: variant.source_id, slug: variant.slug, family_id: variant.family_id }));
      if (replacement.some(s => corpus.spans.some(old => old.id === s.id))) throw new Cat36Failure('counterfactual span identity collision');
      corpus.sources = corpus.sources.map(s => fixturePageId(s) === fixturePageId(variant) ? { ...s, text: variant.replacement_text } : s);
      corpus.spans.push(...replacement);
      probes = [{ ...base, required_span_ids: [...originalGold, ...replacement.map(s => s.id)], tags: [...base.tags, 'counterfactual'] }];
    }
    accounting = new ProbeAccounting(probes.length);
    for (const probe of probes) {
      const start = performance.now();
      let rawResult: Awaited<ReturnType<Cat36Runtime['search']>> | undefined;
      let budgetViolation = false;
      try {
        const result = rawResult = await runtime.search(probe.text, { limit: 5, tokenBudget: profile.token_budget });
        budgetViolation = result.chunks.length > 5 || result.chunks.reduce((n, c) => n + Math.ceil(c.text.length / 4), 0) > profile.token_budget;
        if (budgetViolation) throw new Cat36Failure('production exceeded the declared five-chunk/token output budget', 'sut');
        if (result.chunks.some(c => c.token_count !== Math.ceil(c.text.length / 4))) throw new Cat36Failure('returned evidence token accounting differs from the declared estimator');
        const failures = [...result.failures];
        if (expectedFamilies.length && (result.cue.mode !== 'on' || !executedCueLookup(result.cue.status, result.cue.reason))) failures.push('cue_arm_unexercised');
        if (!expectedFamilies.length && (result.cue.mode !== 'off' || result.cue.admitted !== 0)) failures.push('unexpected_cue_arm');
        const metrics = scoreCat36Probe(probe, result.chunks, corpus.spans, corpus.sources, result.cue);
        const row: Cat36Row = {
          probe_id: probe.id, family_id: probe.family_id, domain: familyMap.get(probe.family_id)!.domain,
          split: profile.split, kind: probe.kind, tags: [...probe.tags], metrics, chunks: result.chunks,
          cue: result.cue, latency_ms: performance.now() - start, observation_failures: failures, metadata: result.metadata,
          ...(failures.length ? { error: { origin: 'dependency' as const, message: failures.join('; ') } } : {}),
        };
        rows.push(row);
        if (failures.length) accounting.error(probe.id, 'dependency', failures.join('; '));
        else accounting.score(probe.id, typeof metrics.all_evidence_in_top5_chunks === 'number' ? metrics.all_evidence_in_top5_chunks : 1 - Number(metrics.associative_false_fire));
      } catch (error) {
        const origin = error instanceof Cat36Failure ? error.origin : 'sut';
        accounting.error(probe.id, origin, String(error));
        if (origin === 'sut') {
          const cue: Cat36CueObservation = { mode: expectedFamilies.length ? 'on' : 'off', status: 'degraded', reason: 'sut_error', candidates: 0, admitted: 0 };
          const metrics = scoreCat36Probe(probe, [], corpus.spans, corpus.sources, cue);
          if (probe.kind === 'negative') metrics.associative_false_fire = 1;
          rows.push({ probe_id: probe.id, family_id: probe.family_id, domain: familyMap.get(probe.family_id)!.domain, split: profile.split,
            kind: probe.kind, tags: [...probe.tags], metrics, chunks: [], cue, latency_ms: performance.now() - start,
            observation_failures: ['sut_error', ...(budgetViolation ? ['output_budget_violation'] : [])], metadata: null,
            error: { origin, message: String(error) }, ...(rawResult ? { failed_response: rawResult } : {}) });
        } else {
          rows.push({ probe_id: probe.id, family_id: probe.family_id, domain: familyMap.get(probe.family_id)!.domain, split: profile.split,
            kind: probe.kind, tags: [...probe.tags], metrics: null, chunks: [],
            cue: rawResult?.cue ?? { mode: expectedFamilies.length ? 'on' : 'off', status: 'degraded', reason: `${origin}_error`, candidates: 0, admitted: 0 },
            latency_ms: performance.now() - start, observation_failures: [`${origin}_error`], metadata: rawResult?.metadata ?? null,
            error: { origin, message: String(error) }, ...(rawResult ? { failed_response: rawResult } : {}) });
        }
      }
    }
  } catch (error) {
    blocked = String(error);
    accounting.error('construction', error instanceof Cat36Failure ? error.origin : 'harness', blocked);
  } finally {
    try { await runtime.close(); } catch (error) { blocked = `runtime close failed: ${String(error)}`; accounting.error('cleanup', 'harness', blocked); }
  }
  const summary = accounting.summary();
  const complete = !blocked && summary.n_total === summary.n_scored && rows.length === summary.n_total && summary.errors.every(e => e.origin === 'sut');
  const safe = rows.every(r => r.metrics?.safety_violations === 0 && !r.observation_failures.includes('output_budget_violation'));
  const receipt: Receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: CAT36_CATEGORY,
    run_status: blocked ? 'error' : 'completed', ...(!blocked ? { verdict: complete ? safe ? 'pass' as const : 'fail' as const : 'partial' as const } : {}),
    n_total: summary.n_total, n_scored: summary.n_scored, completion_rate: summary.completion_rate, errors: summary.errors,
    publishable: runtime.kind === 'production' && profile.mode === 'live' && !options.smoke && !profile.counterfactual && complete && safe && reviewed,
    gbrain_version: gbrainVersion(), gbrain_pin: gbrainPin(), started_at: started, finished_at: new Date().toISOString(),
    resolved_config: { profile, scorer: CAT36_SCORER, raw_chunk_limit: 5, evidence_token_estimator: 'ceil(original_text_utf16_length/4)', construction: build?.resolved_config }, hashes,
    data: { mode: profile.mode, runtime_kind: runtime.kind, counterfactual: profile.counterfactual ?? null,
      label: profile.mode === 'offline' || runtime.kind !== 'production' ? 'plumbing-only; not semantic retrieval evidence' : profile.counterfactual ? 'supplementary same-query counterfactual; not primary release evidence' : 'live capability measurement',
      blocked_reason: blocked ?? null, relevance_review_approved: reviewed, build: build ?? null, rows, summary: summarize(rows) },
  };
  writeFileSync(join(outputDir, 'probes.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx' });
  writeReceipt(join(outputDir, 'receipt.json'), receipt);
  return receipt;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const allowed = new Set(['--offline', '--smoke', '--profile', '--output']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`unknown option ${args[i]}`);
    if (args[i] === '--profile' || args[i] === '--output') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`missing value ${args[i]}`);
      i++;
    }
  }
  if (args.includes('--offline') && value('--profile')) throw new Error('choose --offline or --profile');
  const profile: Cat36Profile = value('--profile') ? JSON.parse(readFileSync(value('--profile')!, 'utf8')) : offlineCat36Profile();
  validateCat36Profile(profile);
  const { createCat36ProductionRuntime } = await import(pathToFileURL(join(import.meta.dir, 'cat36-production.ts')).href);
  const outputDir = resolve(value('--output') ?? `eval/reports/${CAT36_CATEGORY}/${Date.now()}-${process.pid}`);
  const receipt = await runCat36({ corpusDir: resolve('eval/data/associative-recall-v1'), outputDir, profile,
    runtime: await createCat36ProductionRuntime(profile, profile.mode === 'live' ? { artifactDir: join(outputDir, 'runtime') } : {}), smoke: args.includes('--smoke') });
  if (!value('--output')) writeReceipt(receiptPath(CAT36_CATEGORY), receipt);
  console.log(JSON.stringify({ receipt: join(outputDir, 'receipt.json'), status: receipt.run_status, publishable: receipt.publishable }));
  if (receipt.run_status !== 'completed' || receipt.verdict !== 'pass') process.exitCode = 1;
}
