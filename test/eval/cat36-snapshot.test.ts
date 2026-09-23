import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cat36Hash } from '../../eval/runner/cat36-corpus.ts';
import { offlineCat36Profile, type Cat36BuildReceipt, type Cat36Profile } from '../../eval/runner/cat36-associative-retrieval.ts';
import { cat36SnapshotHash, copyCat36Snapshot, loadCat36FrozenConstruction } from '../../eval/runner/cat36-snapshot.ts';
import { writeReceipt } from '../../eval/runner/receipt.ts';

test('frozen construction loader rejects changed source, code, settings, and index bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat36-snapshot-contract-'));
  try {
    const path = join(root, 'runtime/frozen-db');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'synthetic-unit-test-data'), 'unit fixture, not a real benchmark database');
    const profile: Cat36Profile = { ...offlineCat36Profile(), mode: 'live', arm: 'C1', expected_product_sha: 'a'.repeat(40),
      generation_model: 'openai:gpt-5.6-luna', cue_min_similarity: 0.5, build_max_usd: 2,
      provider_budget: { kind: 'isolated-provider-cap', approval_id: 'synthetic-fixture-only', max_usd: 2 } };
    const build: Cat36BuildReceipt = { runtime_kind: 'production', construction_profile: profile, mode: 'live', complete: true,
      feature_supported: true, generation_observed: true, families: ['scene', 'horizon'], source_hash: 'c'.repeat(64),
      resolved_config: {}, provenance: { package_sha256: 'b'.repeat(64) }, mappings: [], generation: {},
      index_snapshot: { path: 'runtime/frozen-db', sha256: cat36SnapshotHash(path) } };
    writeFileSync(join(root, 'build.json'), JSON.stringify({ ...build, frozen_at: new Date().toISOString(), profile_hash: cat36Hash(JSON.stringify(profile)) }));
    writeReceipt(join(root, 'receipt.json'), { schema_version: 1, benchmark_version: 'test', category: 'cat36-associative-retrieval',
      run_status: 'completed', verdict: 'pass', publishable: false, n_total: 0, n_scored: 0, completion_rate: 0, errors: [],
      gbrain_pin: 'synthetic', gbrain_version: 'synthetic', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      hashes: { build: cat36Hash(readFileSync(join(root, 'build.json'))) }, data: { synthetic_fixture: true, runtime_kind: 'production', build } });
    const { build_max_usd, ...shared } = profile;
    const scene: Cat36Profile = { ...shared, arm: 'scene', reuse_build_dir: root };
    const loaded = loadCat36FrozenConstruction(root, scene, 'c'.repeat(64), 'b'.repeat(64));
    expect(loaded.index_snapshot?.path).toBe(path);
    const clone = join(root, 'fresh-copy');
    copyCat36Snapshot(loaded.index_snapshot!, clone);
    expect(cat36SnapshotHash(clone)).toBe(build.index_snapshot!.sha256);
    expect(() => loadCat36FrozenConstruction(root, scene, 'd'.repeat(64), 'b'.repeat(64))).toThrow('source/product');
    expect(() => loadCat36FrozenConstruction(root, scene, 'c'.repeat(64), 'd'.repeat(64))).toThrow('source/product');
    expect(() => loadCat36FrozenConstruction(root, { ...scene, cue_weight: 0.5 }, 'c'.repeat(64), 'b'.repeat(64))).toThrow('cue_weight');
    writeFileSync(join(path, 'synthetic-unit-test-data'), 'changed');
    expect(() => loadCat36FrozenConstruction(root, scene, 'c'.repeat(64), 'b'.repeat(64))).toThrow('content changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('production pre-query PGLite snapshot survives close and restores independently', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat36-persistent-test-'));
  const script = `
    import { join } from 'node:path';
    import { writeFileSync } from 'node:fs';
    import { createCat36ProductionRuntime,cat36RuntimeSourceId } from './eval/runner/cat36-production.ts';
    import { offlineCat36Profile } from './eval/runner/cat36-associative-retrieval.ts';
    import { cat36SnapshotHash,copyCat36Snapshot } from './eval/runner/cat36-snapshot.ts';
    const root=${JSON.stringify(root)};
    const profile=offlineCat36Profile();
    let network=0;globalThis.fetch=async()=>{network++;throw new Error('network forbidden');};
    const runtime=await createCat36ProductionRuntime(profile,{artifactDir:join(root,'runtime')});
    let build;
    try {
      build=await runtime.build([{source_id:'fixture/history',slug:'notes/schedule',title:'Schedule',text:'I do not take calls before 10.',visibility:'public',created_at:'2025-01-01T00:00:00.000Z',updated_at:'2025-01-02T00:00:00.000Z'}],profile);
      if(!build.complete||!build.index_snapshot)throw new Error(JSON.stringify(build));
      await runtime.search('calls',{limit:5,tokenBudget:4096});
    } finally {await runtime.close();}
    const snapshot={...build.index_snapshot,path:join(root,build.index_snapshot.path)};
    if(cat36SnapshotHash(snapshot.path)!==snapshot.sha256)throw new Error('read changed frozen index');
    const destination=join(root,'copied-db');copyCat36Snapshot(snapshot,destination);
    const {PGLiteEngine}=await import('gbrain/pglite-engine');
    const engine=new PGLiteEngine();await engine.connect({database_path:destination});
    try {
      const page=await engine.getPage('notes/schedule',{sourceId:cat36RuntimeSourceId('fixture/history')});
      if(page.compiled_truth.trim()!=='I do not take calls before 10.')throw new Error('copy did not preserve source');
    } finally {await engine.disconnect();}
    if(cat36SnapshotHash(snapshot.path)!==snapshot.sha256||network!==0)throw new Error('source snapshot mutated or network invoked');
    writeFileSync(join(root,'verified.json'),JSON.stringify({network,snapshot:build.index_snapshot,restored:true,publishable:false}));
  `;
  try {
    const child = Bun.spawnSync(['bun', '-e', script], { cwd: resolve('.'), timeout: 120_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
    const result = JSON.parse(readFileSync(join(root, 'verified.json'), 'utf8'));
    expect(result.network).toBe(0);
    expect(result.restored).toBe(true);
    expect(result.publishable).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 130_000);
