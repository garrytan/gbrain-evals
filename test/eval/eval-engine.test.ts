import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EvalEngineEmbeddingMismatch, EvalEngineUnavailable, assertStoredEmbeddingWidth, cliEngineConfig, evalEngineKind, evalEngineRequested,
  inProcessInitOptions, isCapabilityMissing, openEvalEngine, rawSqlNotApplicable, rustAddonEnv, rustAddonIdentity, rustAddonRefusal,
  rustInitConfig, supportsRawSql,
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

const CAT13_EMBEDDING = { model: 'openai:text-embedding-3-large', dimensions: 1536 };

/**
 * A factory whose engines record the initSchema options they get and report a stored width: the width initSchema was
 * given (a brain created at the run's width), or `storedWidth` when set (a brain created at some other width).
 */
function widthRecordingGbrain(storedWidth?: number): GbrainUnderTest {
  return fakeGbrain(`export async function constructEngine(c) {
    return {
      kind: c.engine, initOpts: undefined,
      async connect() {}, async disconnect() {},
      async initSchema(opts) { this.initOpts = opts; },
      width() { return ${storedWidth ?? 'null'} ?? this.initOpts?.embedding?.dimensions ?? (c.engine === 'rust' ? 1536 : null); },
      async getConfig(k) { const w = this.width(); return k === 'embedding_dimensions' && w !== null ? String(w) : null; },
      async executeRaw() { const w = this.width(); return w === null ? [] : [{ formatted: 'vector(' + w + ')' }]; },
    };
  }`);
}

describe('the run embedding every arm is created with', () => {
  test('the Rust init config names the run model and width and drops embedding_disabled', () => {
    expect(rustInitConfig('/s.rust', CAT13_EMBEDDING)).toEqual({
      engine: 'rust', database_path: '/s.rust', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, schema_pack: 'gbrain-base-v2',
    });
    expect(rustInitConfig('/s.rust', CAT13_EMBEDDING)).not.toHaveProperty('embedding_disabled');
  });
  test('without a run embedding the Rust init config stays the keyless one', () => {
    expect(rustInitConfig('/s.rust')).toEqual({ engine: 'rust', database_path: '/s.rust', embedding_disabled: true, schema_pack: 'gbrain-base-v2' });
  });
  test('the in-process arms get the same model and width as initSchema options', () => {
    expect(inProcessInitOptions(CAT13_EMBEDDING)).toEqual({ embedding: CAT13_EMBEDDING });
    expect(inProcessInitOptions(undefined)).toEqual({});
  });
  test('all three arms are created with the same model and width, and none depends on the gateway', async () => {
    const gut = widthRecordingGbrain();
    const seen: Record<string, unknown> = {};
    for (const kind of ['pglite', 'postgres'] as const) {
      const { engine } = await openEvalEngine({ gut, kind, databaseUrl: 'postgres://fake/x', embedding: CAT13_EMBEDDING });
      seen[kind] = (engine as unknown as { initOpts: { embedding: unknown } }).initOpts.embedding;
    }
    const { engine: rust } = await openEvalEngine({ gut, kind: 'rust', databasePath: '/s.rust', embedding: CAT13_EMBEDDING });
    expect((rust as unknown as { initOpts?: unknown }).initOpts).toBeUndefined();
    const [call] = readFileSync(join(gut.root, 'src/cli-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(call.config).not.toHaveProperty('embedding_disabled');
    seen.rust = { model: call.config.embedding_model, dimensions: call.config.embedding_dimensions };
    expect(seen).toEqual({ pglite: CAT13_EMBEDDING, postgres: CAT13_EMBEDDING, rust: CAT13_EMBEDDING });
    expect(call.keys).toEqual([]);
  });
  test('a Rust brain created at another width stops the open with a clear message', async () => {
    const gut = widthRecordingGbrain(1024);
    const err = await openEvalEngine({ gut, kind: 'rust', databasePath: '/s.rust', embedding: CAT13_EMBEDDING }).catch(e => e);
    expect(err).toBeInstanceOf(EvalEngineEmbeddingMismatch);
    expect(err.kind).toBe('rust');
    expect(err.stored).toEqual({ column: null, config: 1024 });
    expect(err.message).toContain('openai:text-embedding-3-large at 1536 dimensions');
    expect(err.message).toContain('embedding_dimensions 1024');
  });
  test('an in-process brain created at another width stops the open, reading the column type and the config row', async () => {
    const err = await openEvalEngine({ gut: widthRecordingGbrain(1024), kind: 'pglite', embedding: CAT13_EMBEDDING }).catch(e => e);
    expect(err).toBeInstanceOf(EvalEngineEmbeddingMismatch);
    expect(err.stored).toEqual({ column: 1024, config: 1024 });
    expect(err.message).toContain('a 1024-dimension content_chunks.embedding column');
  });
  test('the width check fails on either source and on an unreadable width', async () => {
    const engine = (column: string | null, config: string | null) => ({
      getConfig: async () => config, executeRaw: async () => (column === null ? [] : [{ formatted: column }]),
    }) as never;
    await assertStoredEmbeddingWidth('pglite', engine('vector(1536)', '1536'), CAT13_EMBEDDING);
    await assertStoredEmbeddingWidth('postgres', engine('halfvec(1536)', null), CAT13_EMBEDDING);
    for (const column of [null, 'text']) {
      const err = await assertStoredEmbeddingWidth('pglite', engine(column, '1536'), CAT13_EMBEDDING).catch(e => e);
      expect(err, `column ${column}`).toBeInstanceOf(EvalEngineEmbeddingMismatch);
    }
    await assertStoredEmbeddingWidth('rust', engine(null, '1536'), CAT13_EMBEDDING);
    await expect(assertStoredEmbeddingWidth('postgres', engine('vector(1536)', '1024'), CAT13_EMBEDDING)).rejects.toBeInstanceOf(EvalEngineEmbeddingMismatch);
    await expect(assertStoredEmbeddingWidth('pglite', engine('vector(1024)', '1536'), CAT13_EMBEDDING)).rejects.toBeInstanceOf(EvalEngineEmbeddingMismatch);
    const unreadable = await assertStoredEmbeddingWidth('rust', engine(null, null), CAT13_EMBEDDING).catch(e => e);
    expect(unreadable).toBeInstanceOf(EvalEngineEmbeddingMismatch);
    expect(unreadable.message).toContain('Without a readable width');
  });
  test('a real PGLite brain is held to the run width: the check fails when the gateway width differs and passes when it matches', () => {
    // A child process, because the gateway is process-global and other test files in this process configure it.
    const evalEngine = join(import.meta.dir, '../../eval/runner/eval-engine.ts');
    const gutModule = join(import.meta.dir, '../../eval/runner/gbrain-under-test.ts');
    const script = `
      const { openEvalEngine } = await import(${JSON.stringify(evalEngine)});
      const { importGbrain, resolveGbrainUnderTest } = await import(${JSON.stringify(gutModule)});
      const gut = resolveGbrainUnderTest(null);
      const gw = await importGbrain(gut, 'src/core/ai/gateway.ts');
      const other = gw.DEFAULT_EMBEDDING_DIMENSIONS === 1536 ? 1024 : 1536;
      const want = { model: 'openai:text-embedding-3-large', dimensions: other };
      const out = {};
      const unconfigured = await openEvalEngine({ gut, kind: 'pglite', embedding: want }).then(() => 'opened', e => e.name);
      out.unconfigured = unconfigured;
      gw.configureGateway({ embedding_model: want.model, embedding_dimensions: want.dimensions, env: { OPENAI_API_KEY: 'placeholder-never-sent' } });
      const opened = await openEvalEngine({ gut, kind: 'pglite', embedding: want });
      out.configured = await opened.engine.getConfig('embedding_dimensions');
      out.want = String(want.dimensions);
      await opened.engine.disconnect();
      console.log(JSON.stringify(out));`;
    const home = mkdtempSync(join(tmpdir(), 'eval-engine-width-'));
    const r = spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home }, cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 170_000 });
    const out = JSON.parse((r.stdout ?? '').trim().split('\n').at(-1) || '{}');
    expect(out, r.stderr).toEqual({ unconfigured: 'EvalEngineEmbeddingMismatch', configured: out.want, want: out.want });
  }, 180_000);
});
