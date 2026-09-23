import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cat36Hash, canonicalText, constructionSources, fixturePageId, loadCat36Corpus, loadCat36Sources, type Cat36Source } from './cat36-corpus.ts';
import { Cat36Failure, cueFamilies, offlineCat36Profile, validateCat36Profile, type Cat36BuildReceipt, type Cat36Profile, type Cat36Runtime } from './cat36-associative-retrieval.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, writeReceipt, type FailureOrigin, type Receipt } from './receipt.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';

export const CAT36_OPERATION_CATEGORY = 'cat36-operation-conformance';
export const CAT36_OPERATION_SURFACES = ['search', 'query', 'recall'] as const;
export type Cat36OperationSurface = typeof CAT36_OPERATION_SURFACES[number];

export interface OperationConformanceRow {
  id: string;
  probe_id: string;
  surface: Cat36OperationSurface;
  response?: unknown;
  violations: string[];
  error?: { origin: FailureOrigin; message: string };
}

export function operationSerializationViolations(response: unknown, sources: readonly Cat36Source[], cueOnlySentinels: readonly string[] = []): string[] {
  const violations = new Set<string>();
  if (!response || typeof response !== 'object') violations.add('missing_native_response');
  const byIdentity = new Map(sources.map(source => [fixturePageId(source), source]));
  const visit = (value: unknown, inherited?: Cat36Source): void => {
    if (typeof value === 'string') {
      const text = canonicalText(value);
      for (const sentinel of cueOnlySentinels) if (sentinel && text.includes(canonicalText(sentinel))) violations.add('cue_only_sentinel_serialized');
      for (const source of sources) {
        if (source.visibility !== 'public' && text.includes(canonicalText(source.text))
          && !sources.some(publicSource => publicSource.visibility === 'public' && canonicalText(publicSource.text).includes(canonicalText(source.text)))) violations.add('unavailable_source_text_serialized');
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inherited);
      return;
    }
    const record = value as Record<string, unknown>;
    let source = inherited;
    const slug = record.slug ?? record.page_slug;
    const sourceId = record.source_id ?? record.sourceId;
    if (typeof slug === 'string') {
      if (typeof sourceId === 'string') source = byIdentity.get(fixturePageId({ source_id: sourceId, slug }));
      else {
        const matches = sources.filter(s => s.slug === slug);
        source = matches.length === 1 ? matches[0] : undefined;
      }
      if (!source) violations.add('unknown_or_unqualified_source_reference');
      else if (source.visibility !== 'public') violations.add('unavailable_source_reference');
    }
    if ('chunk_text' in record) {
      if (!source || typeof record.chunk_text !== 'string'
        || !canonicalText(source.text).includes(canonicalText(record.chunk_text))) violations.add('chunk_text_not_original_source');
    }
    for (const [key, item] of Object.entries(record)) {
      if (['cue_text', 'cueText', 'generated_cue', 'generatedCue', 'retrieval_cue_text'].includes(key)) violations.add('cue_prose_field_serialized');
      visit(item, source);
    }
  };
  visit(response);
  return [...violations].sort();
}

export async function runCat36OperationConformance(options: {
  corpusDir: string;
  outputDir: string;
  profile: Cat36Profile;
  runtime: Cat36Runtime;
  surfaces?: readonly Cat36OperationSurface[];
  smoke?: boolean;
  cueOnlySentinels?: readonly string[];
}): Promise<Receipt> {
  const surfaces = options.surfaces ?? CAT36_OPERATION_SURFACES;
  if (!surfaces.length || new Set(surfaces).size !== surfaces.length || surfaces.some(s => !CAT36_OPERATION_SURFACES.includes(s))) throw new Error('surfaces must be a nonempty unique subset of search,query,recall');
  const profile = { ...options.profile, required_operations: [...surfaces] };
  validateCat36Profile(profile);
  if (['build.json', 'operations.ndjson', 'receipt.json'].some(file => existsSync(join(options.outputDir, file)))) throw new Error('operation output already contains artifacts; use a fresh directory');
  mkdirSync(options.outputDir, { recursive: true });
  const startedAt = new Date().toISOString();
  let accounting = new ProbeAccounting((options.smoke ? 4 : profile.split === 'dev' ? 160 : 320) * surfaces.length);
  const rows: OperationConformanceRow[] = [];
  let build: Cat36BuildReceipt | undefined;
  let blocked: string | undefined;
  let reviewed = false;
  let hashes: Record<string, string> = { runner: cat36Hash(readFileSync(import.meta.path)), profile: cat36Hash(JSON.stringify(profile)) };
  try {
    if (!options.runtime.operation) throw new Cat36Failure('Native operation runtime unavailable', 'dependency');
    const sourceFile = loadCat36Sources(options.corpusDir);
    hashes = { ...hashes, ...sourceFile.manifest.hashes };
    const sourceInput = constructionSources(sourceFile.sources);
    build = await options.runtime.build(sourceInput, profile);
    if (build.mode !== profile.mode || build.source_hash !== cat36Hash(JSON.stringify(sourceInput))) throw new Cat36Failure('operation build source/mode mismatch');
    writeFileSync(join(options.outputDir, 'build.json'), JSON.stringify({ ...build, profile, frozen_at: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
    hashes.build = cat36Hash(readFileSync(join(options.outputDir, 'build.json')));
    if (!build.complete) throw new Cat36Failure('operation construction incomplete', 'dependency');
    const families = cueFamilies(profile.arm);
    if (families.length && (!build.feature_supported || !build.generation_observed || [...build.families].sort().join(',') !== [...families].sort().join(','))) throw new Cat36Failure('requested cue generation unexercised', 'dependency');
    if (profile.arm === 'summary' && !build.generation_observed) throw new Cat36Failure('real summary generation unexercised', 'dependency');
    const corpus = loadCat36Corpus(options.corpusDir);
    if (Object.entries(sourceFile.manifest.hashes).some(([file, digest]) => corpus.manifest.hashes[file] !== digest)) throw new Cat36Failure('corpus changed after operation build');
    reviewed = corpus.manifest.review.status === 'approved' && Boolean(corpus.manifest.review.reviewer)
      && Object.entries(corpus.manifest.hashes).every(([file, digest]) => corpus.manifest.review.reviewed_hashes?.[file] === digest);
    const nativeSources = corpus.sources.map(source => {
      const mapping = build!.mappings.find(m => m.fixture_source_id === source.source_id && m.fixture_slug === source.slug);
      return { ...source, source_id: typeof mapping?.runtime_source_id === 'string' ? mapping.runtime_source_id : source.source_id };
    });
    const selected = corpus.probes.filter(probe => corpus.families.find(family => family.id === probe.family_id)?.split === profile.split);
    const probes = options.smoke ? selected.filter(probe => probe.family_id === selected[0].family_id) : selected;
    accounting = new ProbeAccounting(probes.length * surfaces.length);
    for (const probe of probes) for (const surface of surfaces) {
      const id = `${surface}:${probe.id}`;
      try {
        const native = await options.runtime.operation(surface, probe.text);
        const response = JSON.parse(JSON.stringify(native));
          const violations = operationSerializationViolations(response, nativeSources, options.cueOnlySentinels);
        rows.push({ id, probe_id: probe.id, surface, response, violations });
        if (violations.length) accounting.error(id, 'sut', violations.join('; '));
        else accounting.score(id, 1);
      } catch (error) {
        const origin = error instanceof Cat36Failure ? error.origin : 'sut';
        const message = String(error);
        accounting.error(id, origin, message);
        rows.push({ id, probe_id: probe.id, surface, violations: [], error: { origin, message } });
      }
    }
  } catch (error) {
    blocked = String(error);
    accounting.error('construction', error instanceof Cat36Failure ? error.origin : 'harness', blocked);
  } finally {
    try { await options.runtime.close(); }
    catch (error) { blocked = `operation runtime close failed: ${String(error)}`; accounting.error('cleanup', 'harness', blocked); }
  }
  const summary = accounting.summary();
  const complete = !blocked && summary.n_total === summary.n_scored && rows.length === summary.n_total;
  const passed = complete && !summary.errors.length;
  const receipt: Receipt = {
    schema_version: 1, benchmark_version: BENCHMARK_VERSION, category: CAT36_OPERATION_CATEGORY,
    run_status: blocked ? 'error' : 'completed', ...(!blocked ? { verdict: passed ? 'pass' as const : complete ? 'fail' as const : 'partial' as const } : {}),
    n_total: summary.n_total, n_scored: summary.n_scored, completion_rate: summary.completion_rate, errors: summary.errors,
    publishable: passed && reviewed && !options.smoke && profile.mode === 'live' && options.runtime.kind === 'production',
    gbrain_pin: gbrainPin(), gbrain_version: gbrainVersion(), started_at: startedAt, finished_at: new Date().toISOString(), hashes,
    resolved_config: { profile, surfaces, native_response_preserved: true, raw_five_primary: false, answer_quality_scored: false,
      query_expansion: profile.mode === 'offline' ? 'disabled for keyless replay' : 'native operation default',
      serialization_checks: ['explicit cue-prose fields', 'configured cue-only sentinels', 'source-qualified visibility', 'original chunk_text', 'complete unavailable source text'],
      cue_only_sentinel_count: options.cueOnlySentinels?.length ?? 0 },
    data: { label: 'native operation protocol and serialization conformance; not retrieval or answer-quality evidence',
      mode: profile.mode, runtime_kind: options.runtime.kind, blocked_reason: blocked ?? null, relevance_review_approved: reviewed,
      build: build ?? null, rows, by_surface: Object.fromEntries(surfaces.map(surface => [surface, {
        attempted: rows.filter(row => row.surface === surface).length,
        passed: rows.filter(row => row.surface === surface && !row.error && !row.violations.length).length,
      }])) },
  };
  writeFileSync(join(options.outputDir, 'operations.ndjson'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
  writeReceipt(join(options.outputDir, 'receipt.json'), receipt);
  return receipt;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (values.has(arg) || flags.has(arg)) throw new Error(`duplicate option ${arg}`);
    if (arg === '--offline' || arg === '--smoke') flags.add(arg);
    else if (['--profile', '--output', '--surfaces'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`missing value ${arg}`);
      values.set(arg, args[++i]);
    } else throw new Error(`unknown option ${arg}`);
  }
  if (flags.has('--offline') && values.has('--profile')) throw new Error('choose --offline or --profile');
  const surfaces = (values.get('--surfaces')?.split(',') ?? [...CAT36_OPERATION_SURFACES]) as Cat36OperationSurface[];
  const profile: Cat36Profile = { ...(values.has('--profile') ? JSON.parse(readFileSync(values.get('--profile')!, 'utf8')) : offlineCat36Profile()), required_operations: surfaces };
  validateCat36Profile(profile);
  const { createCat36ProductionRuntime } = await import('./cat36-production.ts');
  const outputDir = resolve(values.get('--output') ?? `eval/reports/${CAT36_OPERATION_CATEGORY}/${Date.now()}-${process.pid}`);
  const receipt = await runCat36OperationConformance({ corpusDir: resolve('eval/data/associative-recall-v1'), outputDir, profile,
    runtime: await createCat36ProductionRuntime(profile, profile.mode === 'live' ? { artifactDir: join(outputDir, 'runtime') } : {}), surfaces, smoke: flags.has('--smoke') });
  console.log(JSON.stringify({ receipt: join(outputDir, 'receipt.json'), status: receipt.run_status, publishable: receipt.publishable }));
  if (receipt.run_status !== 'completed' || receipt.verdict !== 'pass') process.exitCode = 2;
}
