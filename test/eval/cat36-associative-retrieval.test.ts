import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cat36Hash, canonicalText, constructionSources, loadCat36Corpus, loadCat36Counterfactual, validateCat36Corpus, type Cat36Source, type Cat36Span, type Cat36Probe } from '../../eval/runner/cat36-corpus.ts';
import { alignSourceChunks, scoreCat36Probe, type Cat36Chunk, type Cat36CueObservation } from '../../eval/runner/cat36-scorer.ts';
import { Cat36Failure, cueFamilies, offlineCat36Profile, runCat36, validateCat36Profile, type Cat36Runtime, type Cat36Profile } from '../../eval/runner/cat36-associative-retrieval.ts';
import { assertCat36ProviderReadiness, cat36EmbeddingCacheKey, cat36RuntimeSourceId, mapReturnedChunk, requireCueSupport, validateCat36RerankerModel } from '../../eval/runner/cat36-production.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';
import { executedCueLookup } from '../../eval/runner/situation-recall-observations.ts';

const dir = resolve('eval/data/associative-recall-v1');
const source: Cat36Source = {
  family_id: 'f1', source_id: 's1', slug: 'notes/shared', title: 'Schedule',
  text: 'Before. Do not book an early train. After.', created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-02T00:00:00.000Z', visibility: 'public', role: 'evidence',
};
const span: Cat36Span = { id: 'span-1', family_id: 'f1', source_id: 's1', slug: source.slug, start: 8, end: 35, text: source.text.slice(8, 35) };
const probe: Cat36Probe = { id: 'p1', family_id: 'f1', kind: 'indirect', text: 'Can we arrive before breakfast?', required_span_ids: [span.id], tags: [] };
const off: Cat36CueObservation = { mode: 'off', status: 'skipped', reason: 'disabled', candidates: 0, admitted: 0 };
const chunk = (start = 0, end = source.text.length, overrides: Partial<Cat36Chunk> = {}): Cat36Chunk => ({
  source_id: source.source_id, slug: source.slug, page_id: 100, chunk_id: 200, chunk_index: 0,
  text: source.text.slice(start, end), start, end, token_count: Math.ceil((end - start) / 4), ...overrides,
});

describe('Cat36 exact returned source evidence', () => {
  test('credits exact source offsets, never engine numeric identity', () => {
    expect(scoreCat36Probe(probe, [chunk()], [span], [source], off).all_evidence_in_top5_chunks).toBe(1);
    expect(scoreCat36Probe(probe, [chunk(0, source.text.length, { page_id: 900, chunk_id: 999 })], [span], [source], off).all_evidence_in_top5_chunks).toBe(1);
  });
  test('rejects correct page with wrong chunk and foreign same-slug page', () => {
    expect(scoreCat36Probe(probe, [chunk(0, 7)], [span], [source], off).all_evidence_in_top5_chunks).toBe(0);
    expect(scoreCat36Probe(probe, [chunk(0, source.text.length, { source_id: 'foreign' })], [span], [source], off).all_evidence_in_top5_chunks).toBe(0);
  });
  test('a sixth chunk cannot rescue a miss and duplicate pages do not refill the cutoff', () => {
    const wrong = chunk(0, 7);
    const score = scoreCat36Probe(probe, [wrong, wrong, wrong, wrong, wrong, chunk()], [span], [source], off);
    expect(score.all_evidence_in_top5_chunks).toBe(0);
    expect(score.returned_page_ids).toHaveLength(1);
    expect(score.page_precision_at5).toBe(0.2);
  });
  test('split fragments cover a required span only without a gap', () => {
    expect(scoreCat36Probe(probe, [chunk(0, 18), chunk(18)], [span], [source], off).all_evidence_in_top5_chunks).toBe(1);
    expect(scoreCat36Probe(probe, [chunk(0, 17), chunk(18)], [span], [source], off).all_evidence_in_top5_chunks).toBe(0);
  });
  test('a split scheduling constraint needs both actual returned chunks', () => {
    const text = 'I do not take calls before 10.';
    const split = 'I do not take calls '.length;
    const original = { ...source, text };
    const required = { ...span, start: 0, end: text.length, text };
    const left = chunk(0, split, { chunk_id: 301, text: text.slice(0, split) });
    const right = chunk(split, text.length, { chunk_id: 302, chunk_index: 1, text: text.slice(split) });
    expect(left.text).toBe('I do not take calls ');
    expect(right.text).toBe('before 10.');
    expect(scoreCat36Probe(probe, [left, right], [required], [original], off).all_evidence_in_top5_chunks).toBe(1);
    expect(scoreCat36Probe(probe, [left], [required], [original], off).all_evidence_in_top5_chunks).toBe(0);
    expect(scoreCat36Probe(probe, [right], [required], [original], off).all_evidence_in_top5_chunks).toBe(0);
  });
  test('token-budget truncation cannot recover an unreturned constraint suffix', () => {
    const text = 'I do not take calls before 10.';
    const split = 'I do not take calls '.length;
    const original = { ...source, text };
    const required = { ...span, start: 0, end: text.length, text };
    const indexed = new Map([[200, { source: original, page_id: 100, chunk_id: 200, chunk_index: 0, text, start: 0, end: text.length }]]);
    const truncated = mapReturnedChunk({ source_id: source.source_id, slug: source.slug, page_id: 100, chunk_id: 200, chunk_index: 0,
      chunk_text: text.slice(0, split) }, indexed);
    expect(truncated.end).toBe(split);
    expect(scoreCat36Probe(probe, [truncated], [required], [original], off).all_evidence_in_top5_chunks).toBe(0);
    const finalPartial = chunk(split, split + 6, { chunk_id: 201, chunk_index: 1, text: 'before' });
    expect(scoreCat36Probe(probe, [truncated, finalPartial], [required], [original], off).all_evidence_in_top5_chunks).toBe(0);
    expect(scoreCat36Probe(probe, [truncated, finalPartial], [required], [original], off).returned_evidence_tokens)
      .toBe(truncated.token_count + finalPartial.token_count);
  });
  test('fabricated cue prose and stale offsets never count as evidence', () => {
    expect(scoreCat36Probe(probe, [chunk(0, source.text.length, { text: 'A useful cue about choosing departures' })], [span], [source], off).all_evidence_in_top5_chunks).toBe(0);
    expect(scoreCat36Probe(probe, [chunk(0, source.text.length, { start: 2 })], [span], [source], off).all_evidence_in_top5_chunks).toBe(0);
  });
  test('ambiguous repeated text has no guessed source offset; normalization is versioned', () => {
    expect(alignSourceChunks('Echo. Echo.', [{ chunk_id: 1, text: 'Echo.' }]).get(1)).toBeNull();
    expect(alignSourceChunks('Cafe\u0301\r\nNotes', [{ chunk_id: 2, text: 'Café\nNotes' }]).get(2)).toEqual({ start: 0, end: 10 });
    expect(canonicalText('Cafe\u0301\r\n')).toBe('Café\n');
  });
  test('negative probes have no recall denominator and cue false fire is separate', () => {
    const negative: Cat36Probe = { ...probe, kind: 'negative', required_span_ids: [] };
    const result = scoreCat36Probe(negative, [chunk()], [], [source], off);
    expect(result.all_evidence_in_top5_chunks).toEqual({ not_applicable: 'no_gold' });
    expect(result.associative_false_fire).toBe(0);
    expect(result.negative_result_count).toBe(1);
    expect(scoreCat36Probe(negative, [], [], [source], { mode: 'on', status: 'ready', candidates: 1, admitted: 1 }).associative_false_fire).toBe(1);
  });
  test('bounded empty cue searches and evidence-budget drops remain scored outcomes', () => {
    for (const reason of ['candidate_budget', 'iterative_scan_unavailable', 'evidence_budget_incomplete']) {
      expect(executedCueLookup('degraded', reason)).toBe(true);
      const observation: Cat36CueObservation = { mode: 'on', status: 'degraded', reason, candidates: 0, admitted: 0 };
      expect(scoreCat36Probe(probe, [], [span], [source], observation).all_evidence_in_top5_chunks).toBe(0);
      expect(scoreCat36Probe({ ...probe, kind: 'negative', required_span_ids: [] }, [], [], [source], observation).associative_false_fire).toBe(0);
    }
    for (const reason of ['schema_missing', 'index_missing', 'unsupported_embedding_signature', 'deadline']) {
      expect(executedCueLookup('degraded', reason)).toBe(false);
      expect(executedCueLookup('ready', reason)).toBe(false);
    }
  });
  test('private and withdrawn evidence count as safety violations', () => {
    for (const visibility of ['private', 'withdrawn'] as const) {
      expect(scoreCat36Probe(probe, [chunk()], [span], [{ ...source, visibility }], off).safety_violations).toBe(1);
    }
  });
  test('all pieces are required, precision uses five slots', () => {
    const second = { ...span, id: 'second', start: 36, end: 42, text: source.text.slice(36, 42) };
    const multi = { ...probe, required_span_ids: [span.id, second.id] };
    expect(scoreCat36Probe(multi, [chunk(0, 35)], [span, second], [source], off).all_evidence_in_top5_chunks).toBe(0);
    expect(scoreCat36Probe(multi, [chunk()], [span, second], [source], off).page_precision_at5).toBe(0.2);
  });
  test('run-local IDs and product truncation map back to stable source offsets', () => {
    const indexed = new Map([[200, { source, page_id: 100, chunk_id: 200, chunk_index: 0, text: source.text, start: 0, end: source.text.length }]]);
    const mapped = mapReturnedChunk({ source_id: 's1', slug: source.slug, page_id: 100, chunk_id: 200, chunk_index: 0, chunk_text: source.text.slice(8, 35) }, indexed);
    expect(mapped.start).toBe(8);
    expect(mapped.end).toBe(35);
    expect(scoreCat36Probe(probe, [mapped], [span], [source], off).all_evidence_in_top5_chunks).toBe(1);
    const foreign = mapReturnedChunk({ source_id: 'foreign', slug: source.slug, page_id: 100, chunk_id: 200, chunk_index: 0, chunk_text: source.text }, indexed);
    expect(foreign.start).toBeNull();
  });
  test('fixture source identities map one-to-one to valid runtime IDs without collapsing namesakes', () => {
    const id = cat36RuntimeSourceId('constraints/kiln-clearance/history');
    const foreign = cat36RuntimeSourceId('constraints/kiln-clearance/other-party');
    expect(id).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);
    expect(id.length).toBe(32);
    expect(id).not.toBe(foreign);
    expect(cat36RuntimeSourceId('constraints/kiln-clearance/history')).toBe(id);
    const indexed = new Map([[200, { source, runtime_source_id: id, page_id: 100, chunk_id: 200, chunk_index: 0, text: source.text, start: 0, end: source.text.length }]]);
    const mapped = mapReturnedChunk({ source_id: id, slug: source.slug, page_id: 100, chunk_id: 200, chunk_index: 0, chunk_text: source.text }, indexed);
    expect(mapped.source_id).toBe(source.source_id);
    expect(mapped.runtime_source_id).toBe(id);
    expect(scoreCat36Probe(probe, [mapped], [span], [source], off).all_evidence_in_top5_chunks).toBe(1);
    const wrong = mapReturnedChunk({ source_id: foreign, slug: source.slug, page_id: 100, chunk_id: 200, chunk_index: 0, chunk_text: source.text }, indexed);
    expect(scoreCat36Probe(probe, [wrong], [span], [source], off).all_evidence_in_top5_chunks).toBe(0);
  });
});

describe('Cat36 frozen corpus and construction firewall', () => {
  test('seals 120 independent families and exactly 160/320 probes', () => {
    const c = loadCat36Corpus(dir);
    expect(c.families).toHaveLength(120);
    expect(c.probes).toHaveLength(480);
    for (const [split, count] of [['dev', 160], ['holdout', 320]] as const) {
      const ids = new Set(c.families.filter(f => f.split === split).map(f => f.id));
      expect(c.probes.filter(p => ids.has(p.family_id))).toHaveLength(count);
    }
    expect(c.probes.filter(p => p.tags.includes('multi-evidence')).length).toBeGreaterThan(0);
  });
  test('rejects cross-family gold, split changes and duplicate IDs', () => {
    const c = loadCat36Corpus(dir);
    c.probes[0].required_span_ids = c.probes.find(p => p.family_id !== c.probes[0].family_id && p.kind === 'direct')!.required_span_ids;
    expect(() => validateCat36Corpus(c)).toThrow('crosses family');
    const d = loadCat36Corpus(dir);
    d.families[0].split = d.families[0].split === 'dev' ? 'holdout' : 'dev';
    expect(() => validateCat36Corpus(d)).toThrow('split');
    const e = loadCat36Corpus(dir);
    e.probes[0].id = e.probes[1].id;
    expect(() => validateCat36Corpus(e)).toThrow('duplicate');
  });
  test('copies only the source allowlist even when hidden query/gold sentinels are present', () => {
    const input = { ...source, query: 'FUTURE_QUERY_SENTINEL', gold: 'ANSWER_SENTINEL', cue: 'LABEL_SENTINEL' };
    const clean = constructionSources([input]);
    expect(JSON.stringify(clean)).not.toContain('SENTINEL');
    expect(Object.keys(clean[0]).sort()).toEqual(['source_id', 'slug', 'title', 'text', 'created_at', 'updated_at', 'visibility'].sort());
  });
  test('counterfactual variants retain family identity and exact alternate evidence', () => {
    const c = loadCat36Corpus(dir);
    const { variants } = JSON.parse(readFileSync(join(dir, 'counterfactuals.json'), 'utf8'));
    expect(variants).toHaveLength(5);
    for (const { id } of variants) {
      const v = loadCat36Counterfactual(dir, id);
      expect(c.probes.find(p => p.id === v.base_probe_id)?.family_id).toBe(v.family_id);
      for (const s of v.required_spans) expect(v.replacement_text.slice(s.start, s.end)).toBe(s.text);
    }
  });
});

function fakeRuntime(overrides: Partial<Cat36Runtime> = {}): Cat36Runtime {
  return {
    kind: 'test',
    async build(sources, profile) {
      return { mode: profile.mode, complete: true, feature_supported: false, generation_observed: false,
        families: [], source_hash: cat36Hash(JSON.stringify(sources)), resolved_config: {}, provenance: {}, mappings: [], generation: {} };
    },
    async search(_text, options) {
      expect(options.limit).toBe(5);
      return { chunks: [], cue: off, failures: [], metadata: null };
    },
    async close() {},
    ...overrides,
  };
}

describe('Cat36 receipts and actual arm execution', () => {
  test('offline common receipt is complete but never publishable; build sealed before query', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'cat36-test-'));
    try {
      const runtime = fakeRuntime({ async search() {
        expect(JSON.parse(readFileSync(join(outputDir, 'build.json'), 'utf8')).frozen_at).toBeString();
        return { chunks: [], cue: off, failures: [], metadata: null };
      } });
      const receipt = await runCat36({ corpusDir: dir, outputDir, profile: offlineCat36Profile(), runtime, smoke: true });
      expect(receipt.n_total).toBe(4);
      expect(receipt.n_scored).toBe(4);
      expect(receipt.publishable).toBe(false);
      expect(loadReceipt(join(outputDir, 'receipt.json')).data?.rows).toHaveLength(4);
      expect(receipt.data?.summary).toBeDefined();
    } finally { rmSync(outputDir, { recursive: true, force: true }); }
  });
  test('source/mode mismatch and incomplete build block all queries', async () => {
    for (const field of [{ complete: false }, { source_hash: 'wrong' }, { mode: 'live' as const }]) {
      const outputDir = mkdtempSync(join(tmpdir(), 'cat36-blocked-'));
      let calls = 0;
      const base = fakeRuntime();
      try {
        const receipt = await runCat36({ corpusDir: dir, outputDir, profile: offlineCat36Profile(), smoke: true,
          runtime: fakeRuntime({ async build(s, p) { return { ...await base.build(s, p), ...field }; }, async search() { calls++; throw new Error('must not run'); } }) });
        expect(receipt.run_status).toBe('error');
        expect(receipt.publishable).toBe(false);
        expect(calls).toBe(0);
      } finally { rmSync(outputDir, { recursive: true, force: true }); }
    }
  });
  test('SUT failures are misses; dependency failures stay excluded and incomplete', async () => {
    for (const origin of ['sut', 'dependency'] as const) {
      const outputDir = mkdtempSync(join(tmpdir(), 'cat36-errors-'));
      try {
        const r = await runCat36({ corpusDir: dir, outputDir, profile: offlineCat36Profile(), smoke: true,
          runtime: fakeRuntime({ async search() { throw new Cat36Failure('test failure', origin); } }) });
        expect(r.n_scored).toBe(origin === 'sut' ? 4 : 0);
        expect(r.errors).toHaveLength(4);
        expect(r.publishable).toBe(false);
      } finally { rmSync(outputDir, { recursive: true, force: true }); }
    }
  });
  test('over-limit responses remain raw evidence and block the verdict while scoring SUT misses', async () => {
    for (const oversized of ['chunks', 'tokens']) {
      const outputDir = mkdtempSync(join(tmpdir(), 'cat36-overbudget-'));
      try {
        const chunks = oversized === 'chunks' ? Array.from({ length: 6 }, () => chunk(0, 7)) : [chunk()];
        const receipt = await runCat36({ corpusDir: dir, outputDir, profile: { ...offlineCat36Profile(), token_budget: oversized === 'tokens' ? 1 : 4096 }, smoke: true,
          runtime: fakeRuntime({ async search() { return { chunks, cue: off, metadata: null, failures: [] }; } }) });
        expect(receipt.n_scored).toBe(4);
        expect(receipt.verdict).toBe('fail');
        expect(receipt.publishable).toBe(false);
        const row = (receipt.data?.rows as Array<{ failed_response: { chunks: unknown[] }; observation_failures: string[] }>)[0];
        expect(row.failed_response.chunks).toHaveLength(chunks.length);
        expect(row.observation_failures).toContain('output_budget_violation');
      } finally { rmSync(outputDir, { recursive: true, force: true }); }
    }
  });
  test('harness errors retain raw responses without inventing scored metrics', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'cat36-token-accounting-'));
    try {
      const bad = chunk(0, 7, { token_count: 99 });
      const receipt = await runCat36({ corpusDir: dir, outputDir, profile: offlineCat36Profile(), smoke: true,
        runtime: fakeRuntime({ async search() { return { chunks: [bad], cue: off, metadata: null, failures: [] }; } }) });
      expect(receipt.n_scored).toBe(0);
      expect(receipt.verdict).toBe('partial');
      const rows = receipt.data?.rows as Array<{ metrics: unknown; failed_response: { chunks: unknown[] }; error: { origin: string } }>;
      expect(rows).toHaveLength(4);
      expect(rows[0].metrics).toBeNull();
      expect(rows[0].failed_response.chunks).toEqual([bad]);
      expect(rows[0].error.origin).toBe('harness');
    } finally { rmSync(outputDir, { recursive: true, force: true }); }
  });
  test('disabled profile cannot accidentally enable providers and live requires budget/identity', () => {
    expect(() => validateCat36Profile({ ...offlineCat36Profile(), arm: 'C1' })).toThrow('keyless');
    expect(() => validateCat36Profile({ ...offlineCat36Profile(), mode: 'live' })).toThrow('SHA');
    expect(cueFamilies('C1')).toEqual(['scene', 'horizon']);
    expect(cueFamilies('scene-horizon-bridge')).toEqual(['scene', 'horizon', 'bridge']);
  });
  test('embedding cache shares unchanged off construction but not candidate cues or changed signatures', () => {
    const p = offlineCat36Profile();
    const sources = constructionSources([source]);
    const key = cat36EmbeddingCacheKey(p, sources);
    expect(cat36EmbeddingCacheKey({ ...p, arm: 'C0' }, sources)).toBe(key);
    expect(cat36EmbeddingCacheKey({ ...p, arm: 'C1' }, sources)).not.toBe(key);
    expect(cat36EmbeddingCacheKey({ ...p, embedding_dimensions: 3072 }, sources)).not.toBe(key);
    expect(cat36EmbeddingCacheKey(p, [{ ...sources[0], text: 'Changed source' }])).not.toBe(key);
    expect(cat36EmbeddingCacheKey({ ...p, arm: 'scene' }, sources)).toBe(cat36EmbeddingCacheKey({ ...p, arm: 'C1' }, sources));
  });
  test('read-time ablations require frozen C1 state instead of a new construction budget', () => {
    const profile: Cat36Profile = { ...offlineCat36Profile(), mode: 'live', arm: 'scene', expected_product_sha: 'a'.repeat(40),
      generation_model: 'anthropic:claude-haiku-4-5', cue_min_similarity: 0.5,
      provider_budget: { kind: 'isolated-provider-cap', approval_id: 'test-only', max_usd: 1 } };
    expect(() => validateCat36Profile(profile)).toThrow('frozen C1');
    expect(() => validateCat36Profile({ ...profile, reuse_build_dir: '/example/complete-c1' })).not.toThrow();
    expect(() => validateCat36Profile({ ...profile, reuse_build_dir: '/example/complete-c1', build_max_usd: 1 })).toThrow('no new build allowance');
    expect(() => validateCat36Profile({ ...profile, arm: 'scene-horizon-bridge', reuse_build_dir: '/example/complete-c1' })).toThrow('only Scene/Horizon');
  });
  test('all requested paid query lanes are checked before source ingestion', () => {
    const profile = { ...offlineCat36Profile(), mode: 'live' as const };
    const ready = { embedding: true, reranker: false, expansion: false, generation: false };
    expect(() => assertCat36ProviderReadiness(profile, ready)).not.toThrow();
    expect(() => assertCat36ProviderReadiness({ ...profile, search_config: { ...profile.search_config, 'search.reranker.enabled': 'true' } }, ready)).toThrow('reranker');
    expect(() => assertCat36ProviderReadiness({ ...profile, search_config: { ...profile.search_config, 'search.expansion': 'true' } }, ready)).toThrow('expansion');
    expect(() => assertCat36ProviderReadiness({ ...profile, required_operations: ['query'] }, ready)).toThrow('expansion');
    expect(() => assertCat36ProviderReadiness({ ...profile, arm: 'C1' }, ready)).toThrow('generation');
  });
  test('reranker model support is checked against the production recipe before embeddings', async () => {
    const p = offlineCat36Profile();
    p.search_config['search.reranker.enabled'] = 'true';
    p.search_config['search.reranker.model'] = 'voyage:not-a-real-model';
    await expect(validateCat36RerankerModel(p)).rejects.toThrow('unsupported configured reranker model');
    p.search_config['search.reranker.model'] = 'voyage:rerank-2.5';
    await expect(validateCat36RerankerModel(p)).resolves.toBeUndefined();
  });
  test('missing candidate API is detected without making provider calls', async () => {
    const pkg = JSON.parse(readFileSync(resolve('node_modules/gbrain/package.json'), 'utf8'));
    if (!pkg.exports['./memory-cues']) await expect(requireCueSupport()).rejects.toThrow('public feature module unavailable');
    else expect(await requireCueSupport()).toHaveProperty('getMemoryCueStatus');
  });
  test('requested-on but unobserved generation or skipped read arm cannot pass', async () => {
    const profile: Cat36Profile = { ...offlineCat36Profile(), mode: 'live', arm: 'C1', expected_product_sha: 'a'.repeat(40),
      cue_min_similarity: 0.61, generation_model: 'anthropic:claude-haiku-4-5', build_max_usd: 1,
      provider_budget: { kind: 'isolated-provider-cap', approval_id: 'test-only', max_usd: 1 } };
    for (const generationObserved of [false, true]) {
      const outputDir = mkdtempSync(join(tmpdir(), 'cat36-unexercised-'));
      const base = fakeRuntime();
      try {
        const r = await runCat36({ corpusDir: dir, outputDir, profile, smoke: true, runtime: fakeRuntime({
          async build(s, p) { return { ...await base.build(s, p), feature_supported: true, generation_observed: generationObserved, families: ['scene', 'horizon'] }; },
          async search() { return { chunks: [], cue: { mode: 'on', status: 'skipped', reason: 'uncalibrated', candidates: 0, admitted: 0 }, failures: [], metadata: null }; },
        }) });
        expect(r.n_scored).toBe(0);
        expect(r.publishable).toBe(false);
        expect(r.run_status).toBe(generationObserved ? 'completed' : 'error');
        expect(r.errors.length).toBeGreaterThan(0);
      } finally { rmSync(outputDir, { recursive: true, force: true }); }
    }
  });
  test('counterfactual construction changes the source but never the later query', async () => {
    const { variants } = JSON.parse(readFileSync(join(dir, 'counterfactuals.json'), 'utf8'));
    const variant = loadCat36Counterfactual(dir, variants[0].id);
    const corpus = loadCat36Corpus(dir);
    const family = corpus.families.find(f => f.id === variant.family_id)!;
    const probeText = corpus.probes.find(p => p.id === variant.base_probe_id)!.text;
    const outputDir = mkdtempSync(join(tmpdir(), 'cat36-counterfactual-'));
    const base = fakeRuntime();
    const queries: string[] = [];
    try {
      const receipt = await runCat36({ corpusDir: dir, outputDir, profile: { ...offlineCat36Profile(), split: family.split, counterfactual: variant.id }, runtime: fakeRuntime({
        async build(s, p) {
          expect(s.find(x => x.source_id === variant.source_id && x.slug === variant.slug)?.text).toBe(variant.replacement_text);
          expect(JSON.stringify(s)).not.toContain(probeText);
          return await base.build(s, p);
        },
        async search(text, opts) { queries.push(text); return await base.search(text, opts); },
      }) });
      expect(queries).toEqual([probeText]);
      expect(receipt.n_total).toBe(1);
      expect(receipt.publishable).toBe(false);
      expect(receipt.data?.counterfactual).toBe(variant.id);
      await expect(runCat36({ corpusDir: dir, outputDir, profile: offlineCat36Profile(), runtime: fakeRuntime() })).rejects.toThrow('immutable');
    } finally { rmSync(outputDir, { recursive: true, force: true }); }
  });
});

test('production raw-five path is keyless, source-qualified and ingestion-order independent', () => {
  const script = `
    import { createCat36ProductionRuntime } from './eval/runner/cat36-production.ts';
    import { offlineCat36Profile } from './eval/runner/cat36-associative-retrieval.ts';
    import { scoreCat36Probe } from './eval/runner/cat36-scorer.ts';
    const base = ${JSON.stringify(source)};
    const span = ${JSON.stringify(span)};
    const probe = ${JSON.stringify(probe)};
    const sources = [base, {...base,source_id:'s2',text:'The station door is on the west side.'},
      {...base,source_id:'s3',text:'Violet sentinel private notebook.',visibility:'private'},
      {...base,source_id:'s4',text:'Violet sentinel withdrawn notebook.',visibility:'withdrawn'}];
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('network forbidden in plumbing'); };
    const outcomes = [];
    for (const reversed of [false,true]) {
      const profile = offlineCat36Profile();
      const runtime = await createCat36ProductionRuntime(profile);
      try {
        const input = (reversed ? [...sources].reverse() : sources).map(({family_id,role,...s}) => s);
        const build = await runtime.build(input,profile);
        const answer = await runtime.search('early train',{limit:5,tokenBudget:4096});
        const secret = await runtime.search('Violet sentinel',{limit:5,tokenBudget:4096});
        if(secret.chunks.some(c => c.source_id === 's3' || c.source_id === 's4')) throw new Error('visibility leak');
        if(answer.chunks.length > 5) throw new Error('overfetch');
        outcomes.push({score:scoreCat36Probe(probe,answer.chunks,[span],sources,answer.cue).all_evidence_in_top5_chunks,
          page_id:build.mappings.find(m=>m.fixture_source_id==='s1').page_id});
      } finally { await runtime.close(); }
    }
    console.log('CAT36_TEST_RESULT='+JSON.stringify({outcomes,networkCalls}));
  `;
  const result = Bun.spawnSync(['bun', '-e', script], { cwd: resolve('.'), timeout: 120_000, env: { ...process.env, OPENAI_API_KEY: 'offline-must-not-use-this' } });
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  const line = output.split('\n').find(l => l.startsWith('CAT36_TEST_RESULT='));
  expect(line).toBeDefined();
  const evidence = JSON.parse(line!.slice('CAT36_TEST_RESULT='.length));
  expect(evidence.networkCalls).toBe(0);
  expect(evidence.outcomes.map((o: { score: number }) => o.score)).toEqual([1, 1]);
  expect(evidence.outcomes[0].page_id).not.toBe(evidence.outcomes[1].page_id);
}, 130_000);
