import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EvalEngineUnavailable, cliEngineConfig, evalEngineKind, evalEngineRequested, isCapabilityMissing, openEvalEngine,
  rawSqlNotApplicable, supportsRawSql,
} from '../../eval/runner/eval-engine.ts';
import { resolveGbrainUnderTest, type GbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';

function fakeGbrain(constructSource: string | null): GbrainUnderTest {
  const root = mkdtempSync(join(tmpdir(), 'eval-engine-'));
  mkdirSync(join(root, 'src/core/rust-engine'), { recursive: true });
  if (constructSource !== null) writeFileSync(join(root, 'src/core/engine-construct.ts'), constructSource);
  return { root, version: '0.0.0-fake', overlay: null };
}

describe('evalEngineKind', () => {
  test('unset falls back to the runner default', () => {
    expect(evalEngineKind({}, 'pglite')).toBe('pglite');
    expect(evalEngineKind({ GBRAIN_EVAL_ENGINE: '' }, 'postgres')).toBe('postgres');
    expect(evalEngineRequested({})).toBe(false);
  });
  test('reads each engine', () => {
    for (const k of ['pglite', 'postgres', 'rust'] as const) {
      expect(evalEngineKind({ GBRAIN_EVAL_ENGINE: k })).toBe(k);
      expect(evalEngineRequested({ GBRAIN_EVAL_ENGINE: k })).toBe(true);
    }
  });
  test('an unknown engine throws instead of falling back', () => {
    expect(() => evalEngineKind({ GBRAIN_EVAL_ENGINE: 'sqlite' })).toThrow(/not an engine/);
  });
});

describe('raw SQL checks', () => {
  test('pglite and postgres run them; rust reports not_applicable with the reason', () => {
    expect(supportsRawSql('pglite')).toBe(true);
    expect(rawSqlNotApplicable('postgres', 'N6 presence assertions', 'count indexed rows')).toBeNull();
    const na = rawSqlNotApplicable('rust', 'N6 presence assertions', 'count indexed rows');
    expect(na?.status).toBe('not_applicable');
    expect(na?.reason).toMatch(/raw_sql/);
    expect(na?.reason).toMatch(/count indexed rows/);
  });
  test('isCapabilityMissing reads code or canonical', () => {
    expect(isCapabilityMissing({ code: 'engine_capability_missing' })).toBe(true);
    expect(isCapabilityMissing({ code: 'legacy', canonical: 'engine_capability_missing' })).toBe(true);
    expect(isCapabilityMissing(new Error('x'))).toBe(false);
  });
});

describe('cliEngineConfig', () => {
  test('writes the CLI config each engine needs', () => {
    expect(cliEngineConfig('pglite', { databasePath: '/b' })).toEqual({ engine: 'pglite', database_path: '/b' });
    expect(cliEngineConfig('rust', { databasePath: '/b.rust' })).toEqual({ engine: 'rust', database_path: '/b.rust' });
    expect(cliEngineConfig('postgres', { databaseUrl: 'postgres://x' })).toEqual({ engine: 'postgres', database_url: 'postgres://x' });
    expect(() => cliEngineConfig('postgres', {})).toThrow(EvalEngineUnavailable);
  });
});

describe('openEvalEngine', () => {
  test('rust refuses when the build has no Rust engine (the pinned gbrain today)', async () => {
    const gut = resolveGbrainUnderTest(null);
    const err = await openEvalEngine({ gut, kind: 'rust', databasePath: '/nowhere' }).catch(e => e);
    expect(err).toBeInstanceOf(EvalEngineUnavailable);
    expect(err.reason).toBe('rust_engine_not_in_build');
  });
  test('rust refuses when the factory does not know the kind', async () => {
    const gut = fakeGbrain('export async function constructEngine(c) { throw new Error(`Unknown engine type: "${c.engine}"`); }');
    const err = await openEvalEngine({ gut, kind: 'rust', databasePath: join(gut.root, 'b.rust') }).catch(e => e);
    expect(err.reason).toBe('rust_kind_unsupported');
  });
  test('rust refuses when the addon does not load', async () => {
    const gut = fakeGbrain('export async function constructEngine() { return { kind: "rust", async connect() { const e = new Error("no addon"); e.code = "engine_unavailable"; e.reason = "addon_missing"; throw e; } }; }');
    const err = await openEvalEngine({ gut, kind: 'rust', databasePath: join(gut.root, 'b.rust') }).catch(e => e);
    expect(err.reason).toBe('addon_unavailable');
    expect(err.message).toMatch(/addon_missing/);
  });
  test('rust opens through the factory once the build carries it', async () => {
    const gut = fakeGbrain('export async function constructEngine(c) { return { kind: c.engine, seen: null, async connect(x) { this.seen = x; }, async initSchema() { this.init = true; } }; }');
    const { engine, kind, config } = await openEvalEngine({ gut, kind: 'rust', databasePath: '/s.rust' });
    expect(kind).toBe('rust');
    expect(config).toEqual({ engine: 'rust', database_path: '/s.rust' } as never);
    expect((engine as unknown as { init: boolean }).init).toBe(true);
  });
  test('postgres needs a URL', async () => {
    const err = await openEvalEngine({ gut: resolveGbrainUnderTest(null), kind: 'postgres' }).catch(e => e);
    expect(err.reason).toBe('postgres_url_missing');
  });
  test('pglite opens in memory through the pinned gbrain', async () => {
    const { engine, kind } = await openEvalEngine({ gut: resolveGbrainUnderTest(null), kind: 'pglite' });
    try {
      expect(kind).toBe('pglite');
      expect(engine.kind).toBe('pglite');
      await engine.putPage('notes/x', { type: 'note', title: 'x', compiled_truth: 'hello', timeline: '' });
      expect((await engine.getPage('notes/x'))?.title).toBe('x');
    } finally {
      await engine.disconnect();
    }
  }, 60_000);
});
