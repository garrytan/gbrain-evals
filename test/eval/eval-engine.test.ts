import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EvalEngineUnavailable, cliEngineConfig, evalEngineKind, evalEngineRequested, isCapabilityMissing, openEvalEngine,
  rawSqlNotApplicable, rustAddonEnv, rustAddonIdentity, rustAddonRefusal, supportsRawSql,
} from '../../eval/runner/eval-engine.ts';
import { resolveGbrainUnderTest, type GbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';

const RECORDING_CLI = "import { appendFileSync, readFileSync } from 'node:fs'; import { join } from 'node:path'; const home = process.env.GBRAIN_HOME; appendFileSync(join(import.meta.dir, 'cli-calls.jsonl'), JSON.stringify({ argv: process.argv.slice(2), config: JSON.parse(readFileSync(join(home, '.gbrain/config.json'), 'utf8')), keys: Object.keys(process.env).filter(k => /API_KEY/.test(k)) }) + '\\n');";

function fakeGbrain(constructSource: string | null, cliSource = RECORDING_CLI): GbrainUnderTest {
  const root = mkdtempSync(join(tmpdir(), 'eval-engine-'));
  mkdirSync(join(root, 'src/core/rust-engine'), { recursive: true });
  if (constructSource !== null) writeFileSync(join(root, 'src/core/engine-construct.ts'), constructSource);
  writeFileSync(join(root, 'src/cli.ts'), cliSource);
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

describe('Rust addon', () => {
  test('rustAddonEnv passes only GBRAIN_RUST_ENGINE_ADDON, and nothing when it is unset or blank', () => {
    expect(rustAddonEnv({ GBRAIN_RUST_ENGINE_ADDON: ' /a/x.node ', OPENAI_API_KEY: 'k' })).toEqual({ GBRAIN_RUST_ENGINE_ADDON: '/a/x.node' });
    expect(rustAddonEnv({ GBRAIN_RUST_ENGINE_ADDON: '  ' })).toEqual({});
    expect(rustAddonEnv({})).toEqual({});
  });
  test('rustAddonEnv resolves a relative path, so children started in another directory load the file this process hashes', () => {
    expect(rustAddonEnv({ GBRAIN_RUST_ENGINE_ADDON: 'build/x.node' })).toEqual({ GBRAIN_RUST_ENGINE_ADDON: join(process.cwd(), 'build/x.node') });
  });
  test('rustAddonIdentity records an unreadable addon file instead of throwing away the receipt', () => {
    const gut = fakeGbrain(null);
    const id = rustAddonIdentity(gut, { PATH: process.env.PATH, GBRAIN_RUST_ENGINE_ADDON: join(gut.root, 'missing.node') })!;
    expect(id.sha256).toBeNull();
    expect(id.read_error).toContain('missing.node');
  });
  test('rustAddonIdentity records the file digest and the exports gbrain\'s loader returns, in a child with no provider key', () => {
    const gut = fakeGbrain(null);
    const addon = join(gut.root, 'x.node');
    writeFileSync(addon, 'addon bytes');
    writeFileSync(join(gut.root, 'src/core/rust-engine/addon-loader.ts'), "export async function loadRustAddon() { return { target: 'linux-x64-glibc', engineBuild: 'b1', engineAbi: 3, catalogVersion: 7, formatVersions: [2], keys: Object.keys(process.env).filter(k => /API_KEY/.test(k)) }; }");
    const id = rustAddonIdentity(gut, { PATH: process.env.PATH, GBRAIN_RUST_ENGINE_ADDON: addon, OPENAI_API_KEY: 'k' });
    expect(id).toEqual({ sha256: createHash('sha256').update('addon bytes').digest('hex'), bytes: 11, target: 'linux-x64-glibc', engine_build: 'b1', engine_abi: 3, catalog_version: 7, format_versions: [2] });
    expect(rustAddonIdentity(gut, { PATH: process.env.PATH })).toBeNull();
  });
  test('rustAddonIdentity keeps the digest when the exports cannot be read', () => {
    const gut = fakeGbrain(null);
    const addon = join(gut.root, 'x.node');
    writeFileSync(addon, 'addon bytes');
    writeFileSync(join(gut.root, 'src/core/rust-engine/addon-loader.ts'), "export async function loadRustAddon() { throw new Error('rust_engine_addon_mismatch'); }");
    const id = rustAddonIdentity(gut, { PATH: process.env.PATH, GBRAIN_RUST_ENGINE_ADDON: addon })!;
    expect(id.sha256).toBe(createHash('sha256').update('addon bytes').digest('hex'));
    expect(id.exports_error).toContain('rust_engine_addon_mismatch');
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
  test('rust refuses on the pinned gbrain, whose factory does not construct it', async () => {
    const gut = resolveGbrainUnderTest(null);
    const err = await openEvalEngine({ gut, kind: 'rust', databasePath: '/nowhere' }).catch(e => e);
    expect(err).toBeInstanceOf(EvalEngineUnavailable);
    expect(err.reason).toBe('rust_kind_unsupported');
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
  test('rust opens through the factory and creates the brain with gbrain init, never initSchema', async () => {
    const gut = fakeGbrain('export async function constructEngine(c) { return { kind: c.engine, seen: null, async connect(x) { this.seen = x; }, async initSchema() { this.init = true; } }; }');
    const { engine, kind, config } = await openEvalEngine({ gut, kind: 'rust', databasePath: '/s.rust' });
    expect(kind).toBe('rust');
    expect(config).toEqual({ engine: 'rust', database_path: '/s.rust' } as never);
    expect((engine as unknown as { init?: boolean }).init).toBeUndefined();
    const calls = readFileSync(join(gut.root, 'src/cli-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(calls).toEqual([{ argv: ['init', '--migrate-only', '--non-interactive'], config: { engine: 'rust', database_path: '/s.rust', embedding_disabled: true, schema_pack: 'gbrain-base-v2' }, keys: [] }]);
  });
  test('initSchema: false skips gbrain init on rust', async () => {
    const gut = fakeGbrain('export async function constructEngine(c) { return { kind: c.engine, async connect() {} }; }');
    await openEvalEngine({ gut, kind: 'rust', databasePath: '/s.rust', initSchema: false });
    expect(existsSync(join(gut.root, 'src/cli-calls.jsonl'))).toBe(false);
  });
  test('gbrain init failing on a rust config refuses, keeping an addon code when the CLI printed one', async () => {
    const construct = 'export async function constructEngine(c) { return { kind: c.engine, async connect() {} }; }';
    const missing = fakeGbrain(construct, "console.error('error rust_engine_addon_missing: no addon at path'); process.exit(1);");
    expect((await openEvalEngine({ gut: missing, kind: 'rust', databasePath: '/s.rust' }).catch(e => e)).reason).toBe('rust_engine_addon_missing');
    const other = fakeGbrain(construct, "console.error('init: capability schema refused'); process.exit(2);");
    const err = await openEvalEngine({ gut: other, kind: 'rust', databasePath: '/s.rust' }).catch(e => e);
    expect(err).toBeInstanceOf(EvalEngineUnavailable);
    expect(err.reason).toBe('rust_init_failed');
    expect(err.message).toMatch(/capability schema refused/);
  });
  test('rust_engine_addon_missing and rust_engine_addon_mismatch are refusals with their own reasons', async () => {
    for (const code of ['rust_engine_addon_missing', 'rust_engine_addon_mismatch']) {
      const atConstruct = fakeGbrain(`export async function constructEngine() { const e = new Error('addon'); e.code = '${code}'; throw e; }`);
      expect((await openEvalEngine({ gut: atConstruct, kind: 'rust', databasePath: '/s.rust' }).catch(e => e)).reason).toBe(code);
      const atConnect = fakeGbrain(`export async function constructEngine() { return { kind: 'rust', async connect() { const e = new Error('addon'); e.canonical = '${code}'; throw e; } }; }`);
      const err = await openEvalEngine({ gut: atConnect, kind: 'rust', databasePath: '/s.rust' }).catch(e => e);
      expect(err).toBeInstanceOf(EvalEngineUnavailable);
      expect(err.reason).toBe(code);
    }
    expect(rustAddonRefusal(new Error('plain'))).toBeNull();
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
