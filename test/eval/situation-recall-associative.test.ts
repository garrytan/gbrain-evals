import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { offlineCat36Profile, Cat36Failure } from '../../eval/runner/cat36-associative-retrieval.ts';
import { cat36Hash, loadCat36Corpus } from '../../eval/runner/cat36-corpus.ts';
import { validateReceipt } from '../../eval/runner/receipt.ts';
import {
  ASSOCIATIVE_CATEGORIES, ASSOCIATIVE_FAMILIES, associativeFixture, createAssociativeProductionRuntime, runAssociativeReplay,
  scoreAssociativeProbe, validateAssociativeProfile, type AssociativeCategory, type AssociativeProfile, type AssociativeRuntime,
} from '../../eval/runner/situation-recall-associative.ts';

const corpusDir = resolve('eval/data/associative-recall-v1');
const profile = (category: AssociativeCategory = 'cat22'): AssociativeProfile => ({
  id: `${category}-associative-dev-v1`, category,
  sut: { ...offlineCat36Profile(), mode: 'live', arm: 'C1', expected_product_sha: 'a'.repeat(40),
    generation_model: 'anthropic:claude-haiku-4-5-20251001', cue_min_similarity: 0.5, build_max_usd: 5,
    provider_budget: { kind: 'isolated-provider-cap', approval_id: 'unit-test-no-paid-admission', max_usd: 5 } },
  ...(category === 'cat34' ? { delivery_surface: 'public-volunteer-context', push_min_similarity: 0.5 } : {}),
});

function fakeRuntime(overrides: Partial<AssociativeRuntime> = {}): AssociativeRuntime {
  return { kind: 'hermetic',
    async build(sources) { return { complete: true, source_hash: cat36Hash(JSON.stringify(sources)),
      enrichment: { complete: true, observed: true, families: ['scene', 'horizon'], receipt: { provider_mode: 'hermetic' } }, provenance: {}, resolved_config: {} }; },
    async execute() { return { pages: [], cue: { mode: 'on', status: 'empty', candidates: 0, admitted: 0 }, failures: [], raw: null }; },
    async close() {}, ...overrides };
}

async function withOutput(fn: (outputDir: string) => Promise<void>) {
  const output = mkdtempSync(join(tmpdir(), 'associative-test-'));
  try { await fn(output); } finally { rmSync(output, { recursive: true, force: true }); }
}

describe('associative development recipes', () => {
  test('every category uses only fixed development histories and unique probes', () => {
    const corpus = loadCat36Corpus(corpusDir);
    for (const category of ASSOCIATIVE_CATEGORIES) {
      const fixture = associativeFixture(corpus, category);
      expect(fixture.probes.length).toBeGreaterThan(0);
      expect(new Set(fixture.probes.map(p => p.id)).size).toBe(fixture.probes.length);
      expect(fixture.corpus_reviewed).toBe(false);
      for (const source of fixture.sources) {
        const original = corpus.sources.find(s => s.source_id === source.source_id && s.slug === source.slug)!;
        expect(ASSOCIATIVE_FAMILIES).toContain(original.family_id as typeof ASSOCIATIVE_FAMILIES[number]);
        expect(corpus.families.find(f => f.id === original.family_id)?.split).toBe('dev');
        expect(Object.keys(source)).not.toContain('required_span_ids');
        expect(Object.keys(source)).not.toContain('family_id');
      }
    }
  });
  test('rejects a moved holdout family and holdout profiles', () => {
    const c = loadCat36Corpus(corpusDir);
    c.families.find(f => f.id === ASSOCIATIVE_FAMILIES[0])!.split = 'holdout';
    expect(() => associativeFixture(c, 'cat22')).toThrow('development');
    const p = profile(); p.sut.split = 'holdout';
    expect(() => validateAssociativeProfile(p)).toThrow('development-only');
  });
  test('source-qualified references do not match a foreign same-slug page or an empty result', () => {
    const fixture = associativeFixture(loadCat36Corpus(corpusDir), 'cat27');
    const probe = fixture.probes.find(p => p.slice === 'exact-reference-scoped')!;
    expect(scoreAssociativeProbe(probe, { pages: [], failures: [], raw: null }).probe_success).toBe(0);
    expect(scoreAssociativeProbe(probe, { pages: [{ ...probe.expected[0], source_id: 'foreign' }], failures: [], raw: null }).source_isolation_violations).toBe(1);
    expect(scoreAssociativeProbe(probe, { pages: probe.expected, failures: [], raw: null }).probe_success).toBe(1);
  });
  test('a lexical pointer cannot substitute for an observed situation reminder', () => {
    const probe = associativeFixture(loadCat36Corpus(corpusDir), 'cat34').probes[0];
    expect(scoreAssociativeProbe(probe, { pages: probe.expected.map(p => ({ ...p, arm: 'exact-title' })), failures: [], raw: null }).probe_success).toBe(0);
    expect(scoreAssociativeProbe(probe, { pages: probe.expected.map(p => ({ ...p, arm: 'situation', rationale: 'related situation' })), failures: [], raw: null }).probe_success).toBe(1);
  });
  test('negative controls have no fabricated nDCG and duplicate chunks cannot inflate ranking', () => {
    const fixture = associativeFixture(loadCat36Corpus(corpusDir), 'cat22');
    const negative = fixture.probes.find(p => p.slice === 'empty-source-scope')!;
    const empty = scoreAssociativeProbe(negative, { pages: [], failures: [], raw: null });
    expect(empty.ndcg_at5).toBeUndefined();
    expect(empty.exact_reference_recall).toBeUndefined();
    expect(empty.empty_result_correct).toBe(1);
    const positive = fixture.probes[0];
    const duplicate = scoreAssociativeProbe(positive, { pages: new Array(5).fill(positive.expected[0]), failures: [], raw: null });
    expect(duplicate.ndcg_at5).toBeLessThanOrEqual(1);
    expect(duplicate.exact_reference_recall).toBe(0.5);
  });
});

describe('associative replay admission and receipts', () => {
  test('validation-only default never constructs or calls providers', async () => withOutput(async outputDir => {
    let builds = 0;
    const receipt = await runAssociativeReplay({ profile: profile(), corpusDir, outputDir, runtime: fakeRuntime({ async build() { builds++; throw new Error('must not build'); } }) });
    expect(builds).toBe(0);
    expect(receipt.run_status).toBe('not_run');
    expect(receipt.data?.status).toBe('validated');
    expect(receipt.publishable).toBe(false);
    expect(validateReceipt(receipt)).toEqual([]);
  }));
  test('live cannot use injected clients or omit paid admission', async () => {
    for (const allowPaid of [false, true]) await withOutput(async outputDir => {
      let calls = 0;
      const receipt = await runAssociativeReplay({ profile: profile(), corpusDir, outputDir, mode: 'live', allowPaid,
        runtime: fakeRuntime({ async build() { calls++; throw new Error('must not build'); } }) });
      expect(calls).toBe(0); expect(receipt.run_status).toBe('error'); expect(receipt.publishable).toBe(false);
    });
  });
  test('seals source-only construction before queries and preserves scored SUT misses', async () => withOutput(async outputDir => {
    const base = fakeRuntime();
    const fixture = associativeFixture(loadCat36Corpus(corpusDir), 'cat22');
    const receipt = await runAssociativeReplay({ profile: profile(), corpusDir, outputDir, mode: 'offline', runtime: fakeRuntime({
      async build(sources, links, p) {
        for (const probe of fixture.probes.filter(p => p.action.query && p.slice !== 'private-source' && p.slice !== 'hybrid-unscoped-control')) expect(JSON.stringify(sources)).not.toContain(probe.action.query!);
        return base.build(sources, links, p);
      },
      async execute() {
        expect(JSON.parse(readFileSync(join(outputDir, 'build.json'), 'utf8')).frozen_at).toBeString();
        throw new Cat36Failure('SUT failure', 'sut');
      },
    }) });
    expect(receipt.n_scored).toBe(fixture.probes.length);
    expect(receipt.verdict).toBe('fail'); expect(receipt.publishable).toBe(false);
  }));
  test('incomplete or unobserved construction never runs probes', async () => {
    for (const field of [{ complete: false }, { source_hash: 'different' }, { enrichment: { complete: true, observed: false, families: ['scene', 'horizon'], receipt: {} } }]) await withOutput(async outputDir => {
      const base = fakeRuntime(); let calls = 0;
      const receipt = await runAssociativeReplay({ profile: profile(), corpusDir, outputDir, mode: 'offline', runtime: fakeRuntime({
        async build(s, l, p) { return { ...await base.build(s, l, p), ...field }; }, async execute() { calls++; throw new Error('must not execute'); },
      }) });
      expect(calls).toBe(0); expect(receipt.run_status).toBe('error'); expect(receipt.publishable).toBe(false);
    });
  });
  test('missing cue observations are incomplete, not an empty passing measurement', async () => withOutput(async outputDir => {
    const receipt = await runAssociativeReplay({ profile: profile(), corpusDir, outputDir, mode: 'offline', runtime: fakeRuntime({
      async execute() { return { pages: [], failures: [], raw: null }; },
    }) });
    expect(receipt.verdict).toBe('partial'); expect(receipt.errors.some(e => e.message.includes('cue_arm_unobserved'))).toBe(true);
  }));
  test('bounded empty cue lookups remain scored misses with their original reasons', async () => {
    for (const reason of ['candidate_budget', 'iterative_scan_unavailable', 'evidence_budget_incomplete']) await withOutput(async outputDir => {
      const receipt = await runAssociativeReplay({ profile: profile('cat27'), corpusDir, outputDir, mode: 'offline', runtime: fakeRuntime({
        async execute() { return { pages: [], cue: { mode: 'on', status: 'degraded', reason, candidates: 0, admitted: 0 }, failures: [], raw: null }; },
      }) });
      expect(receipt.n_scored).toBe(receipt.n_total); expect(receipt.errors).toEqual([]); expect(receipt.verdict).toBe('fail');
      const rows = receipt.data?.rows as Array<{ metrics: { probe_success: number }; observation: { cue: { reason: string } } }>;
      expect(rows.every(row => row.metrics.probe_success === 0 && row.observation.cue.reason === reason)).toBe(true);
    });
  });
  test('missing index/schema/model and deadline are still incomplete', async () => {
    for (const reason of ['index_not_provisioned', 'schema_missing', 'embedding_signature_changed', 'deadline']) await withOutput(async outputDir => {
      const receipt = await runAssociativeReplay({ profile: profile('cat27'), corpusDir, outputDir, mode: 'offline', runtime: fakeRuntime({
        async execute() { return { pages: [], cue: { mode: 'on', status: 'degraded', reason, candidates: 0, admitted: 0 }, failures: [], raw: null }; },
      }) });
      expect(receipt.n_scored).toBeLessThan(receipt.n_total); expect(receipt.verdict).toBe('partial');
      expect(receipt.errors.some(error => error.message.includes('cue_arm_unobserved'))).toBe(true);
    });
  });
  test('unsupported actual delivery surfaces are blocked and never inherit public-op coverage', async () => withOutput(async outputDir => {
    const p = { ...profile('cat34'), delivery_surface: 'openclaw-reflex' };
    const receipt = await runAssociativeReplay({ profile: p, corpusDir, outputDir });
    expect(receipt.run_status).toBe('error'); expect(receipt.n_scored).toBe(0);
    expect((receipt.data?.coverage as { transport_release_ready: boolean }).transport_release_ready).toBe(false);
  }));
  test('CLI defaults to validation and refuses live execution without paid admission', async () => withOutput(async root => {
    const path = join(root, 'profile.json');
    writeFileSync(path, JSON.stringify(profile()));
    for (const live of [false, true]) {
      const output = join(root, live ? 'blocked' : 'validate');
      const result = Bun.spawnSync(['bun', 'eval/runner/situation-recall-associative.ts', '--profile', path, '--output', output, ...(live ? ['--live'] : [])],
        { cwd: resolve('.'), timeout: 20_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
      expect(result.exitCode).toBe(live ? 1 : 0);
      const receipt = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
      expect(receipt.run_status).toBe(live ? 'error' : 'not_run');
      expect(receipt.n_scored).toBe(0); expect(receipt.publishable).toBe(false);
      expect(existsSync(join(output, 'runtime'))).toBe(false);
    }
  }));
  test('the actual public config resolver reads the written model before provider work', async () => withOutput(async root => {
    const p = profile('cat27'); p.sut.arm = 'B';
    const outputDir = join(root, 'output');
    const runtimeRoot = join(outputDir, 'runtime');
    let checked = false;
    const runtime = await createAssociativeProductionRuntime(runtimeRoot, async () => {
      const config = await import('gbrain/config');
      const expectedPath = join(runtimeRoot, 'home', '.gbrain', 'config.json');
      expect(process.env.GBRAIN_HOME).toBe(join(runtimeRoot, 'home'));
      expect(config.configPath()).toBe(expectedPath);
      expect(config.loadConfig()?.embedding_model).toBe(p.sut.embedding_model);
      expect(config.loadConfig()?.embedding_dimensions).toBe(p.sut.embedding_dimensions);
      expect(config.loadConfig()?.chat_model).toBe(p.sut.generation_model);
      expect(JSON.parse(readFileSync(config.configPath(), 'utf8')).embedding_model).toBe(p.sut.embedding_model);
      checked = true;
      throw new Cat36Failure('intentional stop before provider work', 'dependency');
    });
    const receipt = await runAssociativeReplay({ profile: p, corpusDir, outputDir, mode: 'offline', runtime });
    expect(checked).toBe(true);
    expect(receipt.n_scored).toBe(0);
    expect(receipt.errors[0].message).toContain('intentional stop before provider work');
  }));
});

const hasCandidate = Boolean(JSON.parse(readFileSync(resolve('node_modules/gbrain/package.json'), 'utf8')).exports?.['./memory-cues']);

test.skipIf(!hasCandidate)('real candidate engine builds source-only cues and exercises public replay without network', () => {
  const script = `
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join, resolve } from 'node:path';
    import { createAssociativeProductionRuntime, runAssociativeReplay } from './eval/runner/situation-recall-associative.ts';
    const root=mkdtempSync(join(tmpdir(),'associative-candidate-'));
    let network=0,generated=0,embedded=0;
    globalThis.fetch=async()=>{network++;throw new Error('network forbidden')};
    const base=${JSON.stringify(profile('cat34'))};
    const vector=text=>{const v=new Array(1536).fill(0);v[text.includes('Thanks, that is all')?1:0]=1;return v;};
    try {
      const results=[];
      for(const category of ['cat22','cat23','cat27','cat34']) {
        const p={...base,id:category+'-associative-dev-v1',category};
        const outputDir=join(root,category);
        const runtime=await createAssociativeProductionRuntime(join(outputDir,'runtime'),async gateway=>{
          const config=await import('gbrain/config');
          if(config.configPath()!==join(outputDir,'runtime','home','.gbrain','config.json') || config.loadConfig()?.embedding_model!==p.sut.embedding_model || config.loadConfig()?.embedding_dimensions!==p.sut.embedding_dimensions || config.loadConfig()?.chat_model!==p.sut.generation_model)throw new Error('actual file-plane configuration mismatch before providers');
          gateway.configureGateway({embedding_model:p.sut.embedding_model,embedding_dimensions:p.sut.embedding_dimensions,chat_model:p.sut.generation_model,env:{OPENAI_API_KEY:'dummy-hermetic-not-a-key'}});
          gateway.__setChatTransportForTests(async options=>{
            generated++;
            const payload=JSON.parse(options.messages[0].content);
            if(Object.keys(payload).sort().join(',')!=='evidence,includeBridge')throw new Error('non-source construction fields');
            const evidence=payload.evidence;
            const phrase='The choir accompanist prefers smoky black tea without added perfume or fruit flavor.';
            const excerpt=evidence.find(value=>value.text.includes(phrase))??evidence[0];
            if(payload.includeBridge!==false || !excerpt || !Number.isInteger(excerpt.id))throw new Error('source-selected construction fields missing');
            const situation=excerpt.text.includes(phrase)?phrase:excerpt.text.slice(0,160);
            return {text:JSON.stringify({scene:{evidence_ref:excerpt.id,text:'CUE_ONLY_SENTINEL '+situation},association_1:null,association_2:null,association_3:null}),blocks:[],stopReason:'end',model:options.model,providerId:'anthropic',usage:{input_tokens:20,output_tokens:20,cache_read_tokens:0,cache_creation_tokens:0}};
          });
          gateway.__setEmbedTransportForTests(async({values})=>{embedded++;return {values,embeddings:values.map(vector),warnings:[],usage:{tokens:20},response:{headers:{}}};});
          return ()=>{gateway.__setChatTransportForTests(null);gateway.__setEmbedTransportForTests(null);};
        });
        const receipt=await runAssociativeReplay({profile:p,corpusDir:resolve('eval/data/associative-recall-v1'),outputDir,mode:'offline',runtime});
        results.push({category,status:receipt.run_status,verdict:receipt.verdict,publishable:receipt.publishable,n_scored:receipt.n_scored,n_total:receipt.n_total,build:receipt.data.construction,rows:receipt.data.rows,errors:receipt.errors});
      }
      console.log('ASSOCIATIVE_CANDIDATE='+JSON.stringify({network,generated,embedded,results}));
    } finally {rmSync(root,{recursive:true,force:true});}
  `;
  const result = Bun.spawnSync(['bun', '-e', script], { cwd: resolve('.'), timeout: 180_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  if (result.exitCode) throw new Error(result.stderr.toString() + result.stdout.toString());
  const line = result.stdout.toString().split('\n').find(l => l.startsWith('ASSOCIATIVE_CANDIDATE='));
  expect(line).toBeDefined();
  const data = JSON.parse(line!.slice('ASSOCIATIVE_CANDIDATE='.length));
  if (!data.generated) throw new Error(JSON.stringify(data.results));
  expect(data.network).toBe(0); expect(data.generated).toBeGreaterThan(0); expect(data.embedded).toBeGreaterThan(0);
  for (const row of data.results) {
    expect(row.publishable).toBe(false);
    expect(row.build.provenance.file_config.path.endsWith('/runtime/home/.gbrain/config.json')).toBe(true);
    expect(row.build.provenance.file_config.path).not.toContain('/.gbrain/.gbrain/');
    expect(row.build.provenance.file_config.values.embedding_model).toBe(profile().sut.embedding_model);
    expect(row.build.provenance.file_config.values.embedding_dimensions).toBe(profile().sut.embedding_dimensions);
    if (!row.build?.enrichment.complete || !row.build?.enrichment.observed) throw new Error(JSON.stringify(row));
    expect(row.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(row.rows)).not.toContain('CUE_ONLY_SENTINEL');
    const unexpected = row.errors.filter((error: { probe_id: string; message: string }) => {
      const probe = row.rows.find((r: { probe_id: string }) => r.probe_id === error.probe_id);
      if (error.message === 'public_graph_nodes_lack_source_identity') {
        expect(probe.action.kind).toBe('graph');
        expect(probe.metrics.missing_source_id).toBeGreaterThan(0);
        return false;
      }
      return true;
    });
    if (unexpected.length) throw new Error(JSON.stringify({ category: row.category, unexpected, cues: row.rows.map((r: { probe_id: string; observation?: { cue?: unknown } }) => ({ id: r.probe_id, cue: r.observation?.cue })) }));
    if (row.errors.length) { expect(row.verdict).toBe('partial'); expect(row.n_scored).toBeLessThan(row.n_total); }
    else expect(row.n_scored).toBe(row.n_total);
    const unsafe = row.rows.filter((r: { action: { kind: string }; metrics: { source_isolation_violations: number; missing_source_id: number; unsafe_results: number } }) => r.action.kind !== 'graph'
      && (r.metrics.source_isolation_violations || r.metrics.missing_source_id || r.metrics.unsafe_results));
    if (unsafe.length) throw new Error(JSON.stringify({ category: row.category, unsafe: unsafe.map((r: { probe_id: string; metrics: unknown; observation: { pages: unknown } }) => ({ id: r.probe_id, metrics: r.metrics, pages: r.observation.pages })) }));
    expect(row.rows.filter((r: { action: { kind: string } }) => r.action.kind !== 'graph').every((r: { metrics: { source_isolation_violations: number; missing_source_id: number; unsafe_results: number } }) =>
      r.metrics.source_isolation_violations === 0 && r.metrics.missing_source_id === 0 && r.metrics.unsafe_results === 0)).toBe(true);
    expect(row.rows.every((r: { metrics: { original_text_violations?: number } }) => !r.metrics.original_text_violations)).toBe(true);
  }
  const reminder = data.results.find((r: { category: string }) => r.category === 'cat34');
  expect(reminder.rows[0].metrics.situation_recall).toBe(1);
  expect(reminder.rows.slice(1).every((r: { metrics: { false_fire: number } }) => r.metrics.false_fire === 0)).toBe(true);
  const redirects = data.results.find((r: { category: string }) => r.category === 'cat23');
  expect(redirects.rows.find((r: { slice: string }) => r.slice === 'redirect-owner').metrics.probe_success).toBe(1);
  const references = data.results.find((r: { category: string }) => r.category === 'cat27');
  expect(references.rows.filter((r: { slice: string }) => r.slice.startsWith('exact-reference')).every((r: { metrics: { probe_success: number } }) => r.metrics.probe_success === 1)).toBe(true);
}, 190_000);
