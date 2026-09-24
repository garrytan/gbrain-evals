import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cat36Hash, loadCat36Corpus, type Cat36Source } from '../../eval/runner/cat36-corpus.ts';
import { Cat36Failure, offlineCat36Profile, type Cat36Runtime } from '../../eval/runner/cat36-associative-retrieval.ts';
import { operationSerializationViolations, runCat36OperationConformance, type OperationConformanceRow } from '../../eval/runner/cat36-operation-conformance.ts';
import { loadReceipt } from '../../eval/runner/receipt.ts';

const corpusDir = resolve('eval/data/associative-recall-v1');
const corpus = loadCat36Corpus(corpusDir);
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function output(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cat36-operations-'));
  directories.push(directory);
  return directory;
}

function runtime(overrides: Partial<Cat36Runtime> = {}): Cat36Runtime {
  return {
    kind: 'test',
    async build(sources, profile) {
      return { mode: profile.mode, complete: true, feature_supported: false, generation_observed: false,
        families: [], source_hash: cat36Hash(JSON.stringify(sources)), resolved_config: {}, provenance: { test_only: true }, mappings: [], generation: {} };
    },
    async search() { throw new Error('native replay must not call raw-five search'); },
    async operation() { return []; },
    async close() {},
    ...overrides,
  };
}

const publicSource: Cat36Source = {
  family_id: 'fictional-family', source_id: 'fictional-public', slug: 'notes/shared', title: 'Public fixture',
  text: 'Original public fixture evidence.', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', visibility: 'public', role: 'evidence',
};
const privateSource = { ...publicSource, source_id: 'fictional-private', text: 'Private fixture sentinel.', visibility: 'private' as const };
const withdrawnSource = { ...publicSource, source_id: 'fictional-withdrawn', text: 'Withdrawn fixture sentinel.', visibility: 'withdrawn' as const };

describe('native operation serialization checks', () => {
  const sources = [publicSource, privateSource, withdrawnSource];
  test('retains valid original snippets and safe cue status metadata', () => {
    expect(operationSerializationViolations([{ source_id: publicSource.source_id, slug: publicSource.slug, chunk_text: publicSource.text,
      memory_cues: { mode: 'on', status: 'ready', candidates: 1, admitted: 1 } }], sources)).toEqual([]);
  });

  test('rejects cue prose fields and cue-only strings without banning safe metadata', () => {
    expect(operationSerializationViolations({ output: { cue_text: 'Generated narrative.' } }, sources)).toContain('cue_prose_field_serialized');
    expect(operationSerializationViolations({ synopsis: 'cue-only-fixture-sentinel' }, sources, ['cue-only-fixture-sentinel'])).toContain('cue_only_sentinel_serialized');
    expect(operationSerializationViolations([{ source_id: publicSource.source_id, slug: publicSource.slug, chunk_text: 'Generated narrative.' }], sources)).toContain('chunk_text_not_original_source');
  });

  test('rejects private, withdrawn, unknown and ambiguous same-slug references', () => {
    for (const source of [privateSource, withdrawnSource]) {
      expect(operationSerializationViolations([{ source_id: source.source_id, slug: source.slug }], sources)).toContain('unavailable_source_reference');
      expect(operationSerializationViolations({ summary: source.text }, sources)).toContain('unavailable_source_text_serialized');
    }
    expect(operationSerializationViolations([{ source_id: 'foreign', slug: publicSource.slug }], sources)).toContain('unknown_or_unqualified_source_reference');
    expect(operationSerializationViolations([{ slug: publicSource.slug }], sources)).toContain('unknown_or_unqualified_source_reference');
  });

  test('checks nested snippets using their qualified parent identity', () => {
    expect(operationSerializationViolations({ source_id: publicSource.source_id, slug: publicSource.slug, chunks: [{ chunk_text: publicSource.text }] }, sources)).toEqual([]);
    expect(operationSerializationViolations(null, sources)).toContain('missing_native_response');
    expect(operationSerializationViolations([{ source_id: publicSource.source_id, slug: publicSource.slug, chunk_text: publicSource.text }], [publicSource, { ...privateSource, text: publicSource.text }])).toEqual([]);
  });
});

describe('separate native operation replay', () => {
  test('freezes source-only build before replay and preserves more than five native rows', async () => {
    const outputDir = output();
    const native = Array.from({ length: 8 }, (_, i) => ({ native_rank: i, protocol_specific: { exact: true } }));
    const called: string[] = [];
    let closed = false;
    const base = runtime();
    const receipt = await runCat36OperationConformance({ corpusDir, outputDir, profile: offlineCat36Profile(), smoke: true,
      runtime: runtime({
        async build(sources, profile) {
          expect(profile.required_operations).toEqual(['search', 'query', 'recall']);
          expect(sources.every(s => !('family_id' in s) && !('role' in s) && !('required_span_ids' in s))).toBe(true);
          expect(JSON.stringify(sources)).not.toContain(corpus.probes[0].text);
          expect(called).toEqual([]);
          return base.build(sources, profile);
        },
        async operation(surface, text) {
          expect(existsSync(join(outputDir, 'build.json'))).toBe(true);
          expect(corpus.probes.some(probe => probe.text === text)).toBe(true);
          called.push(surface);
          return native;
        },
        async close() { closed = true; },
      }) });
    expect(closed).toBe(true);
    expect(receipt.n_total).toBe(12);
    expect(receipt.n_scored).toBe(12);
    expect(receipt.verdict).toBe('pass');
    expect(receipt.publishable).toBe(false);
    expect(called.slice(0, 3)).toEqual(['search', 'query', 'recall']);
    const rows = receipt.data?.rows as OperationConformanceRow[];
    expect(rows[0].response).toEqual(native);
    expect(rows[0].response).toHaveLength(8);
    expect(receipt.resolved_config?.raw_five_primary).toBe(false);
    expect(receipt.resolved_config?.answer_quality_scored).toBe(false);
    expect(readFileSync(join(outputDir, 'operations.ndjson'), 'utf8').trim().split('\n')).toHaveLength(12);
  });

  test('requires operation support in build preflight, retaining a blocked receipt', async () => {
    let attempted = 0;
    const receipt = await runCat36OperationConformance({ corpusDir, outputDir: output(), profile: offlineCat36Profile(), smoke: true,
      runtime: runtime({ async build(_sources, profile) {
        expect(profile.required_operations).toContain('recall');
        throw new Cat36Failure('native recall unavailable before paid import', 'dependency');
      }, async operation() { attempted++; return []; } }) });
    expect(attempted).toBe(0);
    expect(receipt.run_status).toBe('error');
    expect(receipt.errors[0].origin).toBe('dependency');
    expect(receipt.n_scored).toBe(0);
    expect(receipt.publishable).toBe(false);
  });

  test('missing method and incomplete/mismatched construction do not expose queries', async () => {
    for (const change of [{ complete: false }, { source_hash: 'wrong' }]) {
      const base = runtime();
      let called = false;
      const receipt = await runCat36OperationConformance({ corpusDir, outputDir: output(), profile: offlineCat36Profile(), smoke: true,
        runtime: runtime({ async build(s, p) { return { ...await base.build(s, p), ...change }; }, async operation() { called = true; return []; } }) });
      expect(receipt.run_status).toBe('error');
      expect(called).toBe(false);
    }
    const receipt = await runCat36OperationConformance({ corpusDir, outputDir: output(), profile: offlineCat36Profile(), runtime: runtime({ operation: undefined }), smoke: true });
    expect(receipt.run_status).toBe('error');
    expect(receipt.data?.blocked_reason).toContain('unavailable');
  });

  test('SUT failures remain misses while dependency failures remain excluded', async () => {
    for (const origin of ['sut', 'dependency'] as const) {
      const receipt = await runCat36OperationConformance({ corpusDir, outputDir: output(), profile: offlineCat36Profile(), surfaces: ['search'], smoke: true,
        runtime: runtime({ async operation() { throw new Cat36Failure('fixture failure', origin); } }) });
      expect(receipt.n_total).toBe(4);
      expect(receipt.n_scored).toBe(origin === 'sut' ? 4 : 0);
      expect(receipt.verdict).toBe(origin === 'sut' ? 'fail' : 'partial');
      expect(receipt.errors).toHaveLength(4);
      expect(receipt.publishable).toBe(false);
    }
  });

  test('serialization violations fail without rewriting the offending native response', async () => {
    const raw = { generatedCue: 'fixture-only generated cue' };
    const receipt = await runCat36OperationConformance({ corpusDir, outputDir: output(), profile: offlineCat36Profile(), surfaces: ['query'], smoke: true,
      runtime: runtime({ async operation() { return raw; } }) });
    expect(receipt.verdict).toBe('fail');
    expect(receipt.n_scored).toBe(4);
    expect((receipt.data?.rows as OperationConformanceRow[])[0].response).toEqual(raw);
    expect(receipt.errors.every(error => error.origin === 'sut')).toBe(true);
  });

  test('cleanup failure keeps raw results but blocks the receipt', async () => {
    const outputDir = output();
    const receipt = await runCat36OperationConformance({ corpusDir, outputDir, profile: offlineCat36Profile(), surfaces: ['search'], smoke: true,
      runtime: runtime({ async close() { throw new Error('fixture cleanup failure'); } }) });
    expect(receipt.run_status).toBe('error');
    expect(loadReceipt(join(outputDir, 'receipt.json')).data?.rows).toHaveLength(4);
  });

  test('rejects empty or duplicate surface sets', async () => {
    for (const surfaces of [[], ['search', 'search']] as const) {
      await expect(runCat36OperationConformance({ corpusDir, outputDir: output(), profile: offlineCat36Profile(), runtime: runtime(), surfaces })).rejects.toThrow('nonempty unique');
    }
  });

  test('refuses an old output directory before building again', async () => {
    const outputDir = output();
    await runCat36OperationConformance({ corpusDir, outputDir, profile: offlineCat36Profile(), runtime: runtime(), smoke: true });
    let calls = 0;
    await expect(runCat36OperationConformance({ corpusDir, outputDir, profile: offlineCat36Profile(), smoke: true,
      runtime: runtime({ async build() { calls++; throw new Error('must not build'); } }) })).rejects.toThrow('fresh directory');
    expect(calls).toBe(0);
  });

  test('production native replay is keyless and unsupported surfaces block before import', () => {
    const outputDir = output();
    const script = `
      import { operationsByName } from 'gbrain/operations';
      import { offlineCat36Profile } from './eval/runner/cat36-associative-retrieval.ts';
      import { createCat36ProductionRuntime } from './eval/runner/cat36-production.ts';
      import { runCat36OperationConformance } from './eval/runner/cat36-operation-conformance.ts';
      let calls = 0;
      globalThis.fetch = async () => { calls++; throw new Error('Network prohibited in offline conformance'); };
      const profile = offlineCat36Profile();
      const supported = ['search', 'query', 'recall'].every(name => Boolean(operationsByName[name]?.params.query));
      const receipt = await runCat36OperationConformance({corpusDir:${JSON.stringify(corpusDir)},outputDir:${JSON.stringify(outputDir)},profile,
        runtime:await createCat36ProductionRuntime(profile),smoke:true});
      if(calls!==0 || receipt.publishable!==false) throw new Error('Offline provider/publishability violation');
      if(supported) {
        if(receipt.n_scored!==12 || receipt.verdict!=='pass') throw new Error(JSON.stringify(receipt.errors));
        if(!receipt.data.rows.some(row=>row.surface==='recall' && row.response && !Array.isArray(row.response))) throw new Error('Native recall envelope was not preserved');
      } else if(receipt.run_status!=='error' || receipt.n_scored!==0 || receipt.data.build!==null) throw new Error('Unsupported surface did not block before construction');
      console.log(JSON.stringify({supported,calls,publishable:receipt.publishable}));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', script], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 60_000 });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
    expect(child.exitCode).toBe(0);
    const last = JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!);
    expect(last.calls).toBe(0);
    expect(last.publishable).toBe(false);
  }, 70_000);
});
