import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BrainEngine } from 'gbrain/engine';
import type { OperationContext } from 'gbrain/operations';
import type { HybridSearchMeta } from 'gbrain/types';
import { Cat36Failure, validateCat36Profile, type Cat36Profile } from './cat36-associative-retrieval.ts';
import { cat36Hash, canonicalText, constructionSources, fixturePageId, loadCat36Corpus, type Cat36BuildSource, type Cat36Corpus } from './cat36-corpus.ts';
import { assertCat36ProviderReadiness, buildProductionCueIndex, cat36RuntimeSourceId, requireCueSupport, validateCat36RerankerModel, type EnrichmentResult } from './cat36-production.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';
import { ndcgAtK, uniqueInOrder } from './metrics.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, writeReceipt, type Receipt } from './receipt.ts';
import { searchObservation } from './retrieval-pins.ts';
import { resolveRegressionProduct } from './situation-recall-provenance.ts';
import { executedCueLookup } from './situation-recall-observations.ts';

export const ASSOCIATIVE_CATEGORIES = ['cat22', 'cat23', 'cat27', 'cat34'] as const;
export type AssociativeCategory = typeof ASSOCIATIVE_CATEGORIES[number];
export const ASSOCIATIVE_FAMILIES = ['causal-context/ink-smear', 'preferences/tea-roast'] as const;
export const ASSOCIATIVE_RECIPE_VERSION = 'development-production-replay-v1';
export const UNSUPPORTED_DELIVERY_SURFACES = ['turn-context-ipc', 'claude-code-hook', 'codex-hook', 'openclaw-reflex'] as const;
export interface AssociativeProfile {
  id: string;
  category: AssociativeCategory;
  sut: Cat36Profile;
  push_min_similarity?: number;
  delivery_surface?: string;
  fixture_review?: { reviewer: string; recipe_sha256: string };
}
export interface PageRef { source_id: string; slug: string }
export interface AssociativeAction {
  kind: 'hybrid' | 'search-operation' | 'list' | 'get' | 'graph' | 'links' | 'volunteer';
  query?: string;
  source_ids: string[];
  slug?: string;
  graph_signals?: boolean;
  prior_context?: string;
  mutation?: { kind: 'withdraw' | 'private' | 'redirect'; page: PageRef; new_slug?: string };
}
export interface AssociativeProbe {
  id: string;
  slice: string;
  action: AssociativeAction;
  expected: PageRef[];
  forbidden: PageRef[];
  exact_set: boolean;
  situation_required: boolean;
  silence: boolean;
  cue_required: boolean;
}
export interface AssociativeFixture {
  sources: Cat36BuildSource[];
  links: Array<{ from: PageRef; to: PageRef }>;
  probes: AssociativeProbe[];
  corpus_hashes: Record<string, string>;
  recipe_sha256: string;
  corpus_reviewed: boolean;
}
export interface AssociativeObservation {
  pages: Array<PageRef & { text?: string; arm?: string; rationale?: string }>;
  cue?: { mode: string; status: string; reason?: string; admitted: number; candidates: number };
  failures: string[];
  denied?: string;
  raw: unknown;
}
export interface AssociativeBuild {
  complete: boolean;
  source_hash: string;
  enrichment: EnrichmentResult;
  provenance: Record<string, unknown>;
  resolved_config: Record<string, unknown>;
}
export interface AssociativeRuntime {
  kind: 'production' | 'hermetic';
  build(sources: readonly Cat36BuildSource[], links: AssociativeFixture['links'], profile: AssociativeProfile): Promise<AssociativeBuild>;
  execute(action: AssociativeAction): Promise<AssociativeObservation>;
  close(): Promise<void>;
}

export function validateAssociativeProfile(profile: AssociativeProfile): void {
  if (!profile || Object.keys(profile).some(k => !['id', 'category', 'sut', 'push_min_similarity', 'delivery_surface', 'fixture_review'].includes(k))) throw new Error('invalid associative profile fields');
  if (!ASSOCIATIVE_CATEGORIES.includes(profile.category) || profile.id !== `${profile.category}-associative-dev-v1`) throw new Error('unknown associative profile identity');
  validateCat36Profile(profile.sut);
  if (profile.sut.split !== 'dev' || profile.sut.counterfactual || profile.sut.reuse_build_dir || !['B', 'C0', 'C1'].includes(profile.sut.arm)) throw new Error('associative replay requires a fresh development-only B/C0/C1 profile');
  if (profile.sut.search_config['search.expansion'] !== 'false' || profile.sut.required_operations?.length) throw new Error('associative replay does not use query expansion or native query conformance');
  if (profile.fixture_review && (typeof profile.fixture_review.reviewer !== 'string' || !profile.fixture_review.reviewer.trim()
    || !/^[a-f0-9]{64}$/.test(profile.fixture_review.recipe_sha256) || Object.keys(profile.fixture_review).some(k => !['reviewer', 'recipe_sha256'].includes(k)))) throw new Error('invalid independent fixture review identity');
  if (profile.category === 'cat34') {
    if (!profile.delivery_surface) throw new Error('explicit delivery_surface required');
    if (profile.sut.arm === 'C1' && (!Number.isFinite(profile.push_min_similarity) || Math.abs(profile.push_min_similarity!) > 1)) throw new Error('explicit calibrated push threshold required');
  }
}

export function associativeFixture(corpus: Cat36Corpus, category: AssociativeCategory): AssociativeFixture {
  for (const id of ASSOCIATIVE_FAMILIES) if (corpus.families.find(f => f.id === id)?.split !== 'dev') throw new Error(`replay family is not development: ${id}`);
  const selected = corpus.sources.filter(s => ASSOCIATIVE_FAMILIES.some(id => id === s.family_id));
  const sources = constructionSources(selected);
  const ink = selected.find(s => s.family_id === ASSOCIATIVE_FAMILIES[0] && s.role === 'evidence' && s.slug.endsWith('episode-1'))!;
  const next = selected.find(s => s.family_id === ASSOCIATIVE_FAMILIES[0] && s.role === 'evidence' && s.slug.endsWith('episode-2'))!;
  const foreign = selected.find(s => s.family_id === ASSOCIATIVE_FAMILIES[0] && s.role === 'distractor')!;
  const tea = selected.find(s => s.family_id === ASSOCIATIVE_FAMILIES[1] && s.role === 'evidence')!;
  const privatePage = selected.find(s => s.visibility === 'private')!;
  if (![ink, next, foreign, tea, privatePage].every(Boolean)) throw new Error('development replay source recipe no longer matches corpus');
  const ref = (s: PageRef): PageRef => ({ source_id: s.source_id, slug: s.slug });
  const [a, b, other, t, secret] = [ink, next, foreign, tea, privatePage].map(ref);
  const query = corpus.probes.find(p => p.family_id === ink.family_id && p.kind === 'indirect')!.text;
  const teaQuery = corpus.probes.find(p => p.family_id === tea.family_id && p.kind === 'indirect')!.text;
  const links = [{ from: a, to: b }, { from: a, to: other }];
  const probes: AssociativeProbe[] = [];
  const add = (id: string, action: AssociativeAction, expected: PageRef[], options: Partial<Pick<AssociativeProbe, 'slice' | 'forbidden' | 'exact_set' | 'situation_required' | 'silence'>> = {}) => {
    probes.push({ id: `${category}/${id}`, slice: id, action, expected, forbidden: [secret], exact_set: false, situation_required: false, silence: false,
      cue_required: action.kind === 'hybrid' && expected.length > 0, ...options });
  };
  if (category === 'cat22') {
    add('hybrid-scoped', { kind: 'hybrid', query, source_ids: [a.source_id] }, [a, b]);
    add('list-scoped', { kind: 'list', source_ids: [a.source_id] }, [a, b], { exact_set: true });
    add('get-scoped', { kind: 'get', slug: a.slug, source_ids: [a.source_id] }, [a], { exact_set: true });
    add('list-federated', { kind: 'list', source_ids: [a.source_id, other.source_id] }, [a, b, other], { exact_set: true });
    add('graph-scoped', { kind: 'graph', slug: a.slug, source_ids: [a.source_id] }, [a, b], { exact_set: true });
    add('hybrid-unscoped-control', { kind: 'hybrid', query: foreign.text, source_ids: [a.source_id, other.source_id] }, [other]);
    add('list-unscoped-control', { kind: 'list', source_ids: [a.source_id, other.source_id] }, [a, b, other], { exact_set: true });
    add('graph-unscoped-control', { kind: 'graph', slug: a.slug, source_ids: [a.source_id, other.source_id] }, [a, b, other], { exact_set: true });
    add('empty-source-scope', { kind: 'search-operation', query, source_ids: [] }, [], { exact_set: true });
    add('private-source', { kind: 'hybrid', query: privatePage.text, source_ids: [secret.source_id] }, [], { exact_set: true });
    add('private-after-generation', { kind: 'hybrid', query: teaQuery, source_ids: [t.source_id], mutation: { kind: 'private', page: t } }, [], { exact_set: true, forbidden: [secret, t] });
    add('withdrawn-source', { kind: 'hybrid', query, source_ids: [a.source_id], mutation: { kind: 'withdraw', page: b } }, [a], { forbidden: [secret, b] });
  } else if (category === 'cat23') {
    const renamed = { ...t, slug: `${t.slug}-canonical` };
    const teaOther = ref(selected.find(s => s.family_id === tea.family_id && s.visibility === 'public' && s.role === 'distractor')!);
    add('cue-before-redirect', { kind: 'hybrid', query: teaQuery, source_ids: [t.source_id] }, [t]);
    add('redirect-owner', { kind: 'get', slug: t.slug, source_ids: [t.source_id], mutation: { kind: 'redirect', page: t, new_slug: renamed.slug } }, [renamed], { exact_set: true });
    add('same-slug-other-source', { kind: 'get', slug: t.slug, source_ids: [teaOther.source_id] }, [teaOther], { exact_set: true });
    add('canonical-retrieval', { kind: 'hybrid', query: teaQuery, source_ids: [t.source_id] }, [renamed], { forbidden: [secret, t] });
    add('no-canonical', { kind: 'get', slug: 'missing/replay-reference', source_ids: [t.source_id] }, [], { exact_set: true });
    add('withdrawn-canonical', { kind: 'get', slug: t.slug, source_ids: [t.source_id], mutation: { kind: 'withdraw', page: renamed } }, [], { exact_set: true, forbidden: [t, renamed, secret] });
    add('withdrawn-cue-retrieval', { kind: 'hybrid', query: teaQuery, source_ids: [t.source_id] }, [], { exact_set: true, forbidden: [t, renamed, secret] });
  } else if (category === 'cat27') {
    add('exact-reference-scoped', { kind: 'links', slug: a.slug, source_ids: [a.source_id] }, [b], { exact_set: true });
    add('exact-reference-federated', { kind: 'links', slug: a.slug, source_ids: [a.source_id, other.source_id] }, [b, other], { exact_set: true });
    add('referenced-evidence', { kind: 'get', slug: b.slug, source_ids: [b.source_id] }, [b], { exact_set: true });
    add('graph-signals-off', { kind: 'hybrid', query, source_ids: [a.source_id], graph_signals: false }, [a, b]);
    add('graph-signals-on', { kind: 'hybrid', query, source_ids: [a.source_id], graph_signals: true }, [a, b]);
    add('graph-no-foreign-reference', { kind: 'links', slug: a.slug, source_ids: [a.source_id] }, [b], { exact_set: true });
  } else {
    add('semantic-reminder', { kind: 'volunteer', query: `user: ${teaQuery}`, source_ids: [t.source_id] }, [t], { situation_required: true });
    add('prior-context-suppression', { kind: 'volunteer', query: `user: ${teaQuery}`, source_ids: [t.source_id], prior_context: t.slug }, [], { exact_set: true, silence: true });
    add('unrelated-silence', { kind: 'volunteer', query: 'user: Thanks, that is all for now.', source_ids: [t.source_id] }, [], { exact_set: true, silence: true });
    add('private-silence', { kind: 'volunteer', query: `user: ${privatePage.text}`, source_ids: [secret.source_id] }, [], { exact_set: true, silence: true });
    add('withdrawn-silence', { kind: 'volunteer', query: `user: ${teaQuery}`, source_ids: [t.source_id], mutation: { kind: 'withdraw', page: t } }, [], { exact_set: true, silence: true, forbidden: [secret, t] });
  }
  const recipe_sha256 = cat36Hash(JSON.stringify({ version: ASSOCIATIVE_RECIPE_VERSION, category, sources, links, probes }));
  const review = corpus.manifest.review;
  return { sources, links, probes, recipe_sha256, corpus_hashes: { ...corpus.manifest.hashes }, corpus_reviewed: review.status === 'approved' && Boolean(review.reviewer)
    && Object.entries(corpus.manifest.hashes).every(([name, hash]) => review.reviewed_hashes?.[name] === hash) };
}

export function scoreAssociativeProbe(probe: AssociativeProbe, observation: AssociativeObservation): Record<string, number> {
  const pages = observation.pages;
  const ids = pages.map(fixturePageId);
  const expected = new Set(probe.expected.map(fixturePageId));
  const forbidden = new Set(probe.forbidden.map(fixturePageId));
  const missing_source_id = pages.filter(p => typeof p.source_id !== 'string' || !p.source_id).length;
  const source_isolation_violations = pages.filter(p => !probe.action.source_ids.includes(p.source_id)).length;
  const unsafe_results = ids.filter(id => forbidden.has(id)).length;
  const present = [...expected].filter(id => ids.includes(id)).length;
  const exact_reference_recall = expected.size ? present / expected.size : Number(pages.length === 0);
  const extra = probe.exact_set && ids.some(id => !expected.has(id));
  const situation_recall = Number(pages.some(p => expected.has(fixturePageId(p)) && p.arm === 'situation' && p.rationale === 'related situation'));
  const denialRequired = probe.action.kind === 'search-operation' && probe.action.source_ids.length === 0;
  const probe_success = Number(!missing_source_id && !source_isolation_violations && !unsafe_results && exact_reference_recall === 1 && !extra
    && (!probe.situation_required || situation_recall === 1) && (!denialRequired || observation.denied === 'permission_denied'));
  return { probe_success, ...(expected.size ? { exact_reference_recall } : { empty_result_correct: Number(pages.length === 0) }), source_isolation_violations, missing_source_id, unsafe_results, returned_count: pages.length,
    ...(probe.action.kind === 'hybrid' && expected.size > 0 ? { ndcg_at5: ndcgAtK(uniqueInOrder(ids), new Map([...expected].map(id => [id, 1])), 5), top1_correct: Number(expected.has(ids[0])) } : {}),
    ...(denialRequired ? { scope_denial_correct: Number(observation.denied === 'permission_denied') } : {}),
    ...(probe.situation_required ? { situation_recall } : {}), ...(probe.silence ? { false_fire: Number(pages.length > 0) } : {}) };
}

export async function runAssociativeReplay(options: {
  profile: AssociativeProfile; corpusDir: string; outputDir: string; mode?: 'validate' | 'offline' | 'live';
  allowPaid?: boolean; runtime?: AssociativeRuntime;
}): Promise<Receipt> {
  validateAssociativeProfile(options.profile);
  const profile = structuredClone(options.profile);
  const mode = options.mode ?? 'validate';
  const fixture = associativeFixture(loadCat36Corpus(options.corpusDir), profile.category);
  mkdirSync(options.outputDir, { recursive: true });
  if (readdirSync(options.outputDir).length) throw new Error('associative output directory must be empty');
  const started_at = new Date().toISOString();
  const accounting = new ProbeAccounting(fixture.probes.length);
  const currentSources = new Map(fixture.sources.map(source => [fixturePageId(source), { ...source }]));
  const rows: Array<Record<string, unknown>> = [];
  let build: AssociativeBuild | undefined;
  let blocked: string | undefined;
  let runtime = options.runtime;
  try {
    if (profile.category === 'cat34' && profile.delivery_surface !== 'public-volunteer-context') throw new Cat36Failure(`unsupported delivery surface: ${profile.delivery_surface}`, 'dependency');
    if (mode !== 'validate') {
      if (mode === 'live' && (!options.allowPaid || profile.sut.mode !== 'live' || !profile.sut.provider_budget)) throw new Cat36Failure('live replay requires explicit paid admission and isolated provider budget', 'dependency');
      if (mode === 'live' && runtime) throw new Cat36Failure('injected runtimes cannot produce live evidence', 'dependency');
      if (mode === 'offline' && runtime?.kind !== 'hermetic') throw new Cat36Failure('offline replay requires an explicitly injected hermetic runtime', 'dependency');
      runtime ??= await createAssociativeProductionRuntime(join(options.outputDir, 'runtime'));
      build = await runtime.build(fixture.sources, fixture.links, profile);
      writeFileSync(join(options.outputDir, 'build.json'), JSON.stringify({ ...build, frozen_at: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
      if (!build.complete || build.source_hash !== cat36Hash(JSON.stringify(fixture.sources))) throw new Cat36Failure('incomplete or mismatched source-only construction', 'dependency');
      if (profile.sut.arm === 'C1' && (!build.enrichment.complete || !build.enrichment.observed || build.enrichment.families.slice().sort().join(',') !== 'horizon,scene')) throw new Cat36Failure('production cue generation unobserved', 'dependency');
      for (const probe of fixture.probes) {
        const started = performance.now();
        try {
          const observation = await runtime.execute(structuredClone(probe.action));
          const mutation = probe.action.mutation;
          if (mutation) {
            const source = currentSources.get(fixturePageId(mutation.page));
            if (source && mutation.kind === 'redirect') {
              currentSources.delete(fixturePageId(mutation.page));
              currentSources.set(fixturePageId({ ...mutation.page, slug: mutation.new_slug! }), { ...source, slug: mutation.new_slug! });
            } else if (source) source.visibility = mutation.kind === 'private' ? 'private' : 'withdrawn';
          }
          const failures = [...observation.failures];
          if (probe.cue_required && profile.sut.arm === 'C1' && (!observation.cue || observation.cue.mode !== 'on' || !executedCueLookup(observation.cue.status, observation.cue.reason))) failures.push('cue_arm_unobserved');
          if (probe.action.kind === 'hybrid' && profile.sut.arm !== 'C1' && observation.cue && (observation.cue.mode !== 'off' || observation.cue.admitted !== 0)) failures.push('unexpected_cue_arm');
          if (probe.action.kind === 'hybrid' && observation.pages.length > 5) failures.push('raw_chunk_limit_exceeded');
          const metrics: Record<string, number> = scoreAssociativeProbe(probe, observation);
          if (probe.action.kind === 'hybrid' || probe.action.kind === 'get') {
            metrics.original_text_violations = observation.pages.filter(page => {
              const source = currentSources.get(fixturePageId(page));
              return !source || source.visibility !== 'public' || !page.text || !source.text.includes(canonicalText(page.text));
            }).length;
            if (metrics.original_text_violations) metrics.probe_success = 0;
          }
          if (profile.category === 'cat27' && probe.slice === 'graph-signals-on') {
            const baseline = rows.find(row => row.slice === 'graph-signals-off');
            const baselineMetrics = baseline?.metrics as Record<string, number> | undefined;
            if (baseline?.error || (baseline?.observation_failures as string[] | undefined)?.length || !Number.isFinite(baselineMetrics?.ndcg_at5)) failures.push('graph_baseline_unavailable');
            else { metrics.ndcg_delta = metrics.ndcg_at5 - baselineMetrics!.ndcg_at5; metrics.top1_delta = metrics.top1_correct - baselineMetrics!.top1_correct; }
          }
          rows.push({ probe_id: probe.id, slice: probe.slice, action: probe.action, cue_required: probe.cue_required, metrics, observation, latency_ms: performance.now() - started, observation_failures: failures });
          if (failures.length) accounting.error(probe.id, 'dependency', failures.join('; '));
          else accounting.score(probe.id, metrics.probe_success);
        } catch (error) {
          const origin = error instanceof Cat36Failure ? error.origin : 'sut';
          accounting.error(probe.id, origin, String(error));
          rows.push({ probe_id: probe.id, slice: probe.slice, action: probe.action, metrics: { probe_success: 0 }, error: { origin, message: String(error) }, latency_ms: performance.now() - started });
        }
      }
    }
  } catch (error) { blocked = String(error); accounting.error('readiness', error instanceof Cat36Failure ? error.origin : 'harness', blocked); }
  finally { try { await runtime?.close(); } catch (error) { blocked = String(error); accounting.error('cleanup', 'harness', blocked); } }
  const summary = accounting.summary();
  const completed = mode !== 'validate' && !blocked && summary.n_scored === summary.n_total && summary.errors.every(e => e.origin === 'sut');
  const pass = completed && accounting.scoredValues().every(value => value === 1);
  const reviewed = fixture.corpus_reviewed && Boolean(profile.fixture_review?.reviewer) && profile.fixture_review?.recipe_sha256 === fixture.recipe_sha256;
  const safe = rows.every(row => { const metrics = row.metrics as Record<string, number>; return !metrics.unsafe_results && !metrics.source_isolation_violations && !metrics.missing_source_id && !metrics.original_text_violations; });
  const receipt: Receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION, benchmark_version: BENCHMARK_VERSION, category: `${profile.category}-associative-replay`,
    run_status: blocked ? 'error' : mode === 'validate' ? 'not_run' : 'completed', ...(mode !== 'validate' && !blocked ? { verdict: completed ? pass ? 'pass' as const : 'fail' as const : 'partial' as const } : {}),
    n_total: summary.n_total, n_scored: summary.n_scored, completion_rate: summary.completion_rate, errors: summary.errors,
    publishable: mode === 'live' && runtime?.kind === 'production' && completed && reviewed && safe,
    gbrain_pin: gbrainPin(), gbrain_version: gbrainVersion(), started_at, finished_at: new Date().toISOString(),
    hashes: { ...fixture.corpus_hashes, recipe: fixture.recipe_sha256, sources: cat36Hash(JSON.stringify(fixture.sources)), profile: cat36Hash(JSON.stringify(profile)), runner: cat36Hash(readFileSync(import.meta.path)) },
    resolved_config: { profile, runtime: build?.resolved_config ?? null, raw_chunk_limit: 5, split: 'dev' },
    data: { mode, status: blocked ? 'blocked' : mode === 'validate' ? 'validated' : completed ? 'completed' : 'incomplete', blocked_reason: blocked ?? null,
      runtime_kind: runtime?.kind ?? null, independent_relevance_review_approved: reviewed, families: ASSOCIATIVE_FAMILIES,
      coverage: profile.category === 'cat34' ? { surface: 'public-volunteer-context', untested_required_surfaces: UNSUPPORTED_DELIVERY_SURFACES, transport_release_ready: false }
        : { surface: 'production-api-replay', native_compatibility_profile_replaced: false },
      construction: build ?? null, probe_ids: fixture.probes.map(p => p.id), rows,
      fixture_recipe: { version: ASSOCIATIVE_RECIPE_VERSION, links: fixture.links, probes: fixture.probes },
      metric_definitions: {
        probe_success: 'All declared reference, scope, policy and arm-attribution assertions passed for this probe; not answer accuracy.',
        exact_reference_recall: 'Fraction of required distinct (fixture_source_id, slug) references returned; omitted for empty expectations. Not exact-span recall.',
        ndcg_at5: 'Binary page relevance after deduplicating only the five actual returned chunks; no refill. Omitted for empty expectations.',
        original_text_violations: 'Returned hybrid/get_page bodies missing from the current canonical public source.',
        situation_recall: 'Expected source pointer returned by public volunteer_context with arm=situation and the fixed rationale.',
        false_fire: 'Any public volunteer pointer returned on a declared silence probe.',
      },
      metric_summary: { probe_success: { mean: summary.n_scored ? accounting.mean() : null, n: summary.n_scored } },
      label: mode === 'live' ? 'development-only supplementary production replay; not native category or transport coverage' : 'plumbing-only; not semantic capability evidence' },
  };
  writeFileSync(join(options.outputDir, 'probes.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx' });
  writeReceipt(join(options.outputDir, 'receipt.json'), receipt);
  return receipt;
}

type Gateway = typeof import('gbrain/ai/gateway');
let active = false;
export async function createAssociativeProductionRuntime(root: string, testProviders?: (gateway: Gateway) => Promise<() => void>): Promise<AssociativeRuntime> {
  let engine: BrainEngine | undefined;
  let profile: AssociativeProfile;
  let sources: Cat36BuildSource[] = [];
  let env: NodeJS.ProcessEnv | undefined;
  let cleanupProviders: (() => void) | undefined;
  let hybrid: typeof import('gbrain/search/hybrid').hybridSearch;
  let operations: typeof import('gbrain/operations').operationsByName;
  let gateway: Gateway;
  const providerEvents: Array<{ ok: boolean; values: number }> = [];
  const runtimeIds = new Map<string, string>();
  const fixtureIds = new Map<string, string>();
  const runtimeRef = (ref: PageRef) => ({ source_id: runtimeIds.get(ref.source_id)!, slug: ref.slug });
  const context = (ids: string[], trusted = false): OperationContext => ({ engine: engine!, config: { engine: 'pglite', embedding_model: profile.sut.embedding_model, embedding_dimensions: profile.sut.embedding_dimensions },
    sourceId: ids[0], auth: { token: 'synthetic-replay-not-a-token', clientId: 'associative-replay', scopes: ['read'], allowedSources: ids }, remote: !trusted, dryRun: false, logger: { info() {}, warn() {}, error() {} } });
  const project = (row: Record<string, unknown>): AssociativeObservation['pages'][number] => ({
    source_id: typeof row.source_id === 'string' ? fixtureIds.get(row.source_id) ?? row.source_id : '', slug: typeof row.slug === 'string' ? row.slug : '',
    ...(typeof row.chunk_text === 'string' ? { text: canonicalText(row.chunk_text) } : typeof row.compiled_truth === 'string' ? { text: canonicalText(row.compiled_truth) } : {}),
    ...(typeof row.arm === 'string' ? { arm: row.arm } : {}), ...(typeof row.rationale === 'string' ? { rationale: row.rationale } : {}),
  });
  return {
    kind: testProviders ? 'hermetic' : 'production',
    async build(input, links, settings) {
      validateAssociativeProfile(settings);
      if (active || engine || env) throw new Cat36Failure('associative runtime requires a fresh isolated process');
      active = true;
      env = { ...process.env };
      profile = structuredClone(settings);
      sources = structuredClone([...input]);
      const provenance = testProviders ? { test_providers: true, verified_live_identity: false } : resolveRegressionProduct({ expectedProductSha: profile.sut.expected_product_sha, expectedPackageSha256: profile.sut.expected_package_sha256 });
      mkdirSync(root, { recursive: true });
      const home = join(resolve(root), 'home');
      const configPath = join(home, '.gbrain', 'config.json');
      mkdirSync(dirname(configPath), { recursive: true });
      const providerKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'COHERE_API_KEY'];
      const inherited = Object.fromEntries(['PATH', 'LANG', 'TZ', ...(testProviders ? [] : providerKeys)].filter(k => env![k] !== undefined).map(k => [k, env![k]! ]));
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, inherited, { HOME: home, GBRAIN_HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
      const productConfig = await import('gbrain/config');
      if (productConfig.configPath() !== configPath) throw new Cat36Failure('product resolved another file-plane configuration path');
      const fileConfig = { engine: 'pglite', embedding_model: profile.sut.embedding_model, embedding_dimensions: profile.sut.embedding_dimensions, chat_model: profile.sut.generation_model };
      writeFileSync(configPath, JSON.stringify(fileConfig), { flag: 'wx' });
      const loadedConfig = productConfig.loadConfig();
      if (!loadedConfig || loadedConfig.engine !== fileConfig.engine || loadedConfig.embedding_model !== fileConfig.embedding_model
        || loadedConfig.embedding_dimensions !== fileConfig.embedding_dimensions || (fileConfig.chat_model !== undefined && loadedConfig.chat_model !== fileConfig.chat_model)) throw new Cat36Failure('product file-plane model or dimensions differ from the declared profile');
      const loaded = await Promise.all([import('gbrain/pglite-engine'), import('gbrain/ai/gateway'), import('gbrain/import-file'), import('gbrain/search/hybrid'), import('gbrain/operations')]);
      const [{ PGLiteEngine }, gw, importer, search, ops] = loaded;
      gateway = gw; hybrid = search.hybridSearch; operations = ops.operationsByName;
      if (profile.sut.arm === 'C1') {
        const api = await requireCueSupport();
        if (profile.category === 'cat34' && typeof api.recallMemoryCues !== 'function') throw new Cat36Failure('public push recall diagnostic unsupported', 'dependency');
      }
      if (profile.category === 'cat34' && !operations.volunteer_context?.params.window) throw new Cat36Failure('public volunteer_context unsupported', 'dependency');
      if (profile.category === 'cat22' && !operations.search?.params.query) throw new Cat36Failure('public search operation unsupported', 'dependency');
      gateway.resetGateway();
      gateway.configureGateway({ embedding_model: profile.sut.embedding_model, embedding_dimensions: profile.sut.embedding_dimensions, chat_model: profile.sut.generation_model,
        reranker_model: profile.sut.search_config['search.reranker.model'], env: Object.fromEntries(providerKeys.filter(k => process.env[k]).map(k => [k, process.env[k]])) });
      const embeddingDiagnosis = gateway.diagnoseEmbedding();
      if (testProviders) cleanupProviders = await testProviders(gateway);
      else {
        assertCat36ProviderReadiness(profile.sut, { embedding: embeddingDiagnosis.ok, generation: gateway.isAvailable('chat', profile.sut.generation_model),
          reranker: gateway.isAvailable('reranker', profile.sut.search_config['search.reranker.model']), expansion: false });
        await validateCat36RerankerModel(profile.sut);
        const { embedMany } = await import('ai');
        gateway.__setEmbedTransportForTests((async params => {
          try { const result = await embedMany(params as unknown as Parameters<typeof embedMany>[0]); providerEvents.push({ ok: true, values: params.values.length }); return result; }
          catch (error) { providerEvents.push({ ok: false, values: params.values.length }); throw error; }
        }) as Parameters<Gateway['__setEmbedTransportForTests']>[0]);
      }
      engine = new PGLiteEngine();
      await engine.connect({}); await engine.initSchema();
      for (const [key, value] of Object.entries(profile.sut.search_config)) await engine.setConfig(key, value);
      for (const [key, value] of Object.entries({ embedding_model: profile.sut.embedding_model, embedding_dimensions: String(profile.sut.embedding_dimensions),
        'memory.cues.generation_enabled': 'false', 'memory.cues.read': 'off', 'memory.cues.push': 'false', 'search.relational_retrieval': 'false', 'search.metadata_boost_gate': 'always' })) await engine.setConfig(key, value);
      for (const source of sources) {
        const id = cat36RuntimeSourceId(source.source_id); runtimeIds.set(source.source_id, id); fixtureIds.set(id, source.source_id);
        await engine.executeRaw("INSERT INTO sources (id,name,config) VALUES ($1,$1,'{}'::jsonb) ON CONFLICT (id) DO NOTHING", [id]);
        const content = `---\ntype: note\ntitle: ${JSON.stringify(source.title)}\nvisibility: ${source.visibility === 'private' ? 'private' : 'world'}\n---\n\n${source.text}`;
        const result = await importer.importFromContent(engine, source.slug, content, { sourceId: id });
        if (result.status === 'error') throw new Cat36Failure('source import failed', 'sut');
        const page = await engine.getPage(source.slug, { sourceId: id });
        if (!page || canonicalText(page.compiled_truth).trim() !== source.text.trim()) throw new Cat36Failure('canonical replay source changed during import');
        await engine.executeRaw('UPDATE pages SET created_at=$1,updated_at=$2 WHERE id=$3', [source.created_at, source.updated_at, page.id]);
        if (source.visibility === 'withdrawn') await engine.softDeletePage(source.slug, { sourceId: id });
      }
      for (const link of links) await engine.addLink(link.from.slug, link.to.slug, 'development replay exact source reference', 'mentions', 'manual', undefined, undefined,
        { fromSourceId: runtimeIds.get(link.from.source_id), toSourceId: runtimeIds.get(link.to.source_id) });
      const enrolled = [...new Set(sources.filter(s => s.visibility === 'public').map(s => runtimeIds.get(s.source_id)!))];
      const enrichment = profile.sut.arm === 'C1' ? await buildProductionCueIndex(engine, enrolled, profile.sut)
        : { complete: true, observed: false, families: [], receipt: { mode: 'disabled', provider_calls: 0 } };
      if (testProviders) enrichment.receipt.provider_mode = 'injected hermetic providers; not live capability evidence';
      if (profile.sut.arm === 'C1') {
        await operations.memory_cues.handler(context(enrolled, true), { action: 'configure', generation_enabled: false, apply: true,
          ...(profile.category === 'cat34' ? { push_enabled: true, push_min_similarity: profile.push_min_similarity } : {}) });
      }
      const mappings: Array<Record<string, unknown>> = [];
      for (const source of sources) {
        const id = runtimeIds.get(source.source_id)!;
        const page = await engine.getPage(source.slug, { sourceId: id, includeDeleted: true });
        if (!page || canonicalText(page.compiled_truth).trim() !== source.text.trim()
          || new Date(page.created_at).getTime() !== Date.parse(source.created_at) || new Date(page.updated_at).getTime() !== Date.parse(source.updated_at)) throw new Cat36Failure('source content or timestamp changed during construction');
        mappings.push({ fixture_source_id: source.source_id, slug: source.slug, runtime_source_id: id, page_id: page.id, source_sha256: cat36Hash(source.text) });
      }
      const resolved: Record<string, unknown> = {};
      for (const key of [...Object.keys(profile.sut.search_config), 'memory.cues.sources', 'memory.cues.read', 'memory.cues.push', 'memory.cues.min_similarity', 'memory.cues.push_min_similarity']) resolved[key] = await engine.getConfig(key);
      return { complete: enrichment.complete, source_hash: cat36Hash(JSON.stringify(input)), enrichment,
        provenance: { ...provenance, file_config: { path: configPath, values: JSON.parse(readFileSync(configPath, 'utf8')) }, source_mapping: Object.fromEntries(runtimeIds), mappings, embedding: embeddingDiagnosis, runtime: 'fresh in-memory PGLite', provider_mode: testProviders ? 'hermetic' : 'real ai-sdk; no cache' }, resolved_config: resolved };
    },
    async execute(action) {
      if (!engine) throw new Cat36Failure('replay before construction');
      const ids = action.source_ids.map(id => runtimeIds.get(id) ?? id);
      const scope = { sourceIds: ids, excludePrivate: true };
      if (action.mutation) {
        const mutation = action.mutation, page = runtimeRef(mutation.page);
        if (mutation.kind === 'withdraw') await engine.softDeletePage(page.slug, { sourceId: page.source_id });
        else if (mutation.kind === 'private') {
          const source = sources.find(s => fixturePageId(s) === fixturePageId(mutation.page));
          if (!source) throw new Cat36Failure('private mutation names an unknown fixture source');
          const { importFromContent } = await import('gbrain/import-file');
          const result = await importFromContent(engine, source.slug, `---\ntype: note\ntitle: ${JSON.stringify(source.title)}\nvisibility: private\n---\n\n${source.text}`, { sourceId: page.source_id });
          if (result.status === 'error') throw new Cat36Failure('private transition failed', 'sut');
        }
        else {
          if (!mutation.new_slug || await engine.updateSlug(page.slug, mutation.new_slug, { sourceId: page.source_id }) !== 1) throw new Cat36Failure('redirect source mutation did not move exactly one page');
          await engine.executeRaw('INSERT INTO slug_aliases (source_id,alias_slug,canonical_slug) VALUES ($1,$2,$3)', [page.source_id, page.slug, mutation.new_slug]);
        }
      }
      if (action.kind === 'hybrid') {
        let meta: HybridSearchMeta | undefined;
        const result = await hybrid(engine, action.query!, { ...scope, limit: 5, tokenBudget: profile.sut.token_budget, requireSafeChunks: true, expansion: false, recencyBoost: 0,
          ...(action.graph_signals === undefined ? {} : { graph_signals: action.graph_signals }), onMeta: value => { meta = value; } });
        const observed = searchObservation({ query: action.query!, results: result, meta, expectedExpansion: false, expectedReranker: profile.sut.search_config['search.reranker.enabled'] === 'true' });
        const cue = (meta as HybridSearchMeta & { memory_cues?: AssociativeObservation['cue'] } | undefined)?.memory_cues;
        return { pages: result.map(r => project(r as unknown as Record<string, unknown>)), cue, failures: observed.failures, raw: { results: result, metadata: observed } };
      }
      if (action.kind === 'search-operation') {
        try {
          const result = await operations.search.handler(context(ids), { query: action.query, limit: 5 });
          if (!Array.isArray(result)) throw new Cat36Failure('invalid native search output', 'sut');
          return { pages: result.map(project), failures: [], raw: result };
        } catch (error) {
          if ((error as { code?: string }).code === 'permission_denied') return { pages: [], denied: 'permission_denied', failures: [], raw: { code: 'permission_denied' } };
          throw error;
        }
      }
      if (action.kind === 'list') { const result = await engine.listPages({ ...scope, limit: 100 }); return { pages: result.map(r => project(r as unknown as Record<string, unknown>)), failures: [], raw: result }; }
      if (action.kind === 'graph') {
        const result = await engine.traverseGraph(action.slug!, 2, scope);
        const pages = result.map(r => project(r as unknown as Record<string, unknown>));
        return { pages, failures: pages.some(p => !p.source_id) ? ['public_graph_nodes_lack_source_identity'] : [], raw: result };
      }
      if (action.kind === 'links') {
        const result = await engine.getLinks(action.slug!, scope);
        return { pages: result.map(r => project({ slug: r.to_slug, source_id: r.to_source_id })), failures: [], raw: result };
      }
      if (action.kind === 'get') {
        try { const result = await operations.get_page.handler(context(ids), { slug: action.slug }); return { pages: [project(result as Record<string, unknown>)], failures: [], raw: result }; }
        catch (error) { if ((error as { code?: string }).code === 'page_not_found') return { pages: [], failures: [], raw: { code: 'page_not_found' } }; throw error; }
      }
      const before = providerEvents.length;
      const result = await operations.volunteer_context.handler(context(ids), { window: action.query, prior_context: action.prior_context, max_pages: 1, min_confidence: 1 });
      const output = result as { pages?: Array<Record<string, unknown>> };
      if (!Array.isArray(output.pages)) throw new Cat36Failure('invalid volunteer_context output', 'sut');
      const events = providerEvents.slice(before);
      const failures: string[] = [];
      let diagnostic: unknown = null;
      if (profile.sut.arm === 'C1') {
        const api = await requireCueSupport();
        const { embedQuery } = await import('gbrain/embedding');
        let embedding: Float32Array;
        try { embedding = await embedQuery(action.query!); }
        catch (error) { throw new Cat36Failure(`push diagnostic embedding failed: ${String(error)}`, 'dependency'); }
        const recall = api.recallMemoryCues as (engine: BrainEngine, vector: Float32Array, options: Record<string, unknown>) => Promise<{ status: string; reason?: string; candidates: unknown[] }>;
        const column = await (api.memoryCueColumn as (engine: BrainEngine) => Promise<unknown>)(engine);
        const recalled = await recall(engine, embedding, { ...scope, requireSafeChunks: true, purpose: 'push', embeddingColumn: column, minSimilarity: profile.push_min_similarity, limit: 5 });
        diagnostic = { status: recalled.status, reason: recalled.reason, candidates: recalled.candidates.length, separate_from_operation: true };
        if (!executedCueLookup(recalled.status, recalled.reason)) failures.push('push_recall_diagnostic_unavailable');
        const enrolled = action.source_ids.some(id => sources.some(s => s.source_id === id && s.visibility === 'public'));
        if (!testProviders && enrolled && (!events.length || events.some(e => !e.ok))) failures.push('volunteer_embedding_unobserved_or_failed');
      }
      return { pages: output.pages.map(project), failures, raw: { operation: result, embedding_events: events, recall_diagnostic: diagnostic, surface: 'public-volunteer-context' } };
    },
    async close() {
      if (!env) return;
      try { await engine?.disconnect(); }
      finally {
        try { cleanupProviders?.(); gateway?.resetGateway(); }
        finally { for (const name of Object.keys(process.env)) delete process.env[name]; Object.assign(process.env, env); env = undefined; active = false; }
      }
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let live = false, allowPaid = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live') live = true;
    else if (arg === '--allow-paid') allowPaid = true;
    else if (['--profile', '--output', '--corpus'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--') && !values.has(arg)) values.set(arg, args[++i]);
    else throw new Error(`unknown, duplicate or incomplete option: ${arg}`);
  }
  if (!values.has('--profile') || !values.has('--output') || (allowPaid && !live)) throw new Error('Use --profile <json> --output <fresh-directory>; validation only by default. Live requires --live --allow-paid and an externally enforced profile budget.');
  const receipt = await runAssociativeReplay({ profile: JSON.parse(readFileSync(resolve(values.get('--profile')!), 'utf8')),
    outputDir: resolve(values.get('--output')!), corpusDir: resolve(values.get('--corpus') ?? 'eval/data/associative-recall-v1'), mode: live ? 'live' : 'validate', allowPaid });
  console.log(JSON.stringify({ status: receipt.data?.status, receipt: join(resolve(values.get('--output')!), 'receipt.json'), publishable: receipt.publishable }));
  if (receipt.run_status === 'error' || (live && receipt.verdict !== 'pass')) process.exitCode = 1;
}
