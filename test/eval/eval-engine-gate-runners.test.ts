import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVAL_ENGINE_REFUSED_EXIT, EvalEngineUnavailable, evalEngineReceiptFields, evalEngineRefusalMessage, openScratchEvalEngine,
  preflightEvalEngine, requestedEvalEngine,
} from '../../eval/runner/eval-engine.ts';
import type { GbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { SliceCell } from '../../eval/runner/lifecycle/slice.ts';
import { checkEvalEngineArgs } from '../../eval/runner/n1-knowledge-update.ts';
import { GbrainAdapter, N14_SQL_CHECKS, n14NotApplicable, n14Verdict, parseEngine, type N14Summary } from '../../eval/runner/n14-large-page-fidelity.ts';
import { PGLITE_HTTP_UNSUPPORTED, RUST_HTTP_UNSUPPORTED } from '../../eval/runner/n6-postgres-http.ts';
import { N6_SQL_CHECKS, presence, seed, type CallOutcome, type Gbrain } from '../../eval/runner/n6-visibility-fuzz.ts';
import { generateN6World } from '../../eval/generators/n6-visibility-gen.ts';

const ROOT = join(import.meta.dir, '../..');

/** A gbrain root that carries src/core/rust-engine, with the factory given here (the fakeGbrain pattern of eval-engine.test.ts). */
function fakeGbrain(constructSource: string): GbrainUnderTest {
  const root = mkdtempSync(join(tmpdir(), 'gate-runners-'));
  mkdirSync(join(root, 'src/core/rust-engine'), { recursive: true });
  writeFileSync(join(root, 'src/core/engine-construct.ts'), constructSource);
  writeFileSync(join(root, 'src/cli.ts'), '');
  return { root, version: '0.0.0-fake', overlay: null };
}

const OPENS = 'export async function constructEngine(c) { return { kind: c.engine, async connect(x) { this.seen = x; }, async initSchema() {}, async disconnect() {} }; }';
const NO_ADDON = 'export async function constructEngine() { return { kind: "rust", async connect() { const e = new Error("no addon"); e.code = "engine_unavailable"; e.reason = "addon_missing"; throw e; } }; }';

describe('receipt fields and refusal', () => {
  test('env unset adds nothing; env set adds engine and not_applicable', () => {
    expect(requestedEvalEngine({})).toBeNull();
    expect(requestedEvalEngine({ GBRAIN_EVAL_ENGINE: 'postgres' })).toBe('postgres');
    expect(evalEngineReceiptFields(null)).toEqual({});
    expect(Object.keys(evalEngineReceiptFields(null))).toHaveLength(0);
    expect(evalEngineReceiptFields('pglite')).toEqual({ engine: 'pglite', not_applicable: [] });
  });
  test('the refusal names the reason and the exit code differs from pass, fail, paid refusal and harness error', () => {
    expect([0, 1, 2, 3]).not.toContain(EVAL_ENGINE_REFUSED_EXIT);
    const msg = evalEngineRefusalMessage(new EvalEngineUnavailable('rust', 'rust_engine_not_in_build', 'no rust here.'), 'N12');
    expect(msg).toMatch(/EvalEngineUnavailable \(rust_engine_not_in_build\)/);
    expect(msg).toMatch(/No receipt or verdict/);
  });
});

describe('preflight and scratch engines', () => {
  test('pglite and postgres need no preflight; rust refuses on the pinned gbrain', async () => {
    const gut = resolveGbrainUnderTest(null);
    await preflightEvalEngine(gut, 'pglite');
    await preflightEvalEngine(gut, 'postgres');
    const err = await preflightEvalEngine(gut, 'rust').catch(e => e);
    expect(err).toBeInstanceOf(EvalEngineUnavailable);
    expect(err.reason).toBe('rust_kind_unsupported');
  });
  test('rust refuses when the addon does not load', async () => {
    const err = await preflightEvalEngine(fakeGbrain(NO_ADDON), 'rust').catch(e => e);
    expect(err.reason).toBe('addon_unavailable');
  });
  test('a rust scratch store opens in a temp directory and close removes it', async () => {
    const s = await openScratchEvalEngine({ gut: fakeGbrain(OPENS), kind: 'rust', label: 'gate' });
    const path = (s.config as unknown as { database_path: string }).database_path;
    expect(s.kind).toBe('rust');
    expect(path).toMatch(/gate-rust-.*brain\.rust$/);
    const dir = join(path, '..');
    expect(existsSync(dir)).toBe(true);
    await s.close();
    expect(existsSync(dir)).toBe(false);
  });
  test('postgres scratch needs an admin URL', async () => {
    const err = await openScratchEvalEngine({ gut: resolveGbrainUnderTest(null), kind: 'postgres', label: 'gate' }).catch(e => e);
    expect(err.reason).toBe('postgres_url_missing');
  });
});

describe('N6 raw-SQL checks on rust', () => {
  const ledger = generateN6World();
  const noSql = { executeRaw: async () => { throw Object.assign(new Error('raw sql refused'), { code: 'engine_capability_missing' }); } };
  const all = ledger.classes.flatMap(c => c.protected_markers).join(' ');
  const local = async (): Promise<CallOutcome> => ({ exposed: true, ok: true, raw: all, data: null });
  const op = (name: string) => ({ name, params: {} }) as never;

  test('presence reports the six SQL checks not_applicable and still runs the positive controls', async () => {
    const na: Array<{ check: string; status: string; reason: string; engine: string }> = [];
    const r = await presence(noSql as never, ledger, local, op('get_page'), op, 'rust', na as never);
    expect(na.map(x => x.check)).toEqual(
      (['pages_stored', 'take_indexed', 'fact_indexed', 'timeline_indexed', 'link_indexed', 'sealed_chunks'] as const).map(k => N6_SQL_CHECKS[k].check));
    for (const x of na) {
      expect(x.status).toBe('not_applicable');
      expect(x.engine).toBe('rust');
      expect(x.reason).toMatch(/raw_sql/);
    }
    expect(r.checks).toHaveLength(ledger.classes.length);
    expect(r.checks.every(c => c.name.startsWith('local ') && c.pass)).toBe(true);
    expect(r.sealed_chunk_violations).toEqual([]);
  });

  test('pglite presence records nothing not_applicable', async () => {
    const na: unknown[] = [];
    const counting = { executeRaw: async () => [{ n: 1 }] };
    await presence(counting as never, ledger, local, op('get_page'), op, 'pglite', na as never);
    expect(na).toEqual([]);
  });

  test('seed on rust creates sources through addSource and skips the contradiction report as not_applicable', async () => {
    const added: string[] = [];
    let probeRan = false;
    const ok = { content: [{ text: '{"revision":"r1"}' }] };
    const g = {
      operations: ['put_page', 'ontology_propose', 'put_raw_data', 'get_page'].map(name => ({ name, params: {}, handler: async () => ({}) })),
      dispatchToolCall: async () => ok,
      operationScopesAllowed: () => true,
      buildBrainTools: () => [],
      sources: { addSource: async (_e: unknown, o: { id: string }) => { added.push(o.id); } },
      contradictions: { runContradictionProbe: async () => { probeRan = true; return { report: { duration_ms: 0, per_query: [] } }; }, writeRunRow: async () => {} },
    } as unknown as Gbrain;
    const na: Array<{ check: string }> = [];
    const errors = await seed(g, noSql as never, ledger, undefined, 'rust', na as never);
    expect(errors).toEqual([]);
    expect(added).toEqual([...ledger.sources]);
    expect(probeRan).toBe(false);
    expect(na.map(x => x.check)).toEqual([N6_SQL_CHECKS.contradiction_report.check]);
  });
});

describe('N14 adapter on rust', () => {
  test('opens through gbrain init --migrate-only and never calls initSchema(), which the Rust engine refuses', async () => {
    const pinned = resolveGbrainUnderTest(null).root;
    const root = mkdtempSync(join(tmpdir(), 'n14-rust-'));
    const p = (sub: string) => JSON.stringify(join(pinned, sub));
    for (const sub of ['src/core/pglite-engine.ts', 'src/core/operations.ts', 'src/core/ai/gateway.ts', 'src/commands/embed.ts', 'src/commands/export.ts']) {
      mkdirSync(join(root, sub, '..'), { recursive: true });
      writeFileSync(join(root, sub), 'export * from ' + p(sub) + ';\n');
    }
    mkdirSync(join(root, 'src/core/rust-engine'), { recursive: true });
    writeFileSync(join(root, 'src/cli.ts'), "import { appendFileSync } from 'node:fs'; import { join } from 'node:path'; appendFileSync(join(import.meta.dir, 'cli-calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');");
    writeFileSync(join(root, 'src/core/engine-construct.ts'), 'import { PGLiteEngine } from ' + p('src/core/pglite-engine.ts') + ';\n'
      + 'export async function constructEngine() { const e = new PGLiteEngine(); const connect = e.connect.bind(e); const init = e.initSchema.bind(e);'
      + ' e.connect = async c => { await connect({}); await init(); };'
      + ' e.initSchema = async () => { const err = new Error("schema is managed by gbrain init"); err.code = "engine_capability_missing"; throw err; }; return e; }\n');
    const a = await GbrainAdapter.open(root, 'native', {} as never, { rust: true });
    await a.close();
    expect(readFileSync(join(root, 'src/cli-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))).toEqual([['init', '--migrate-only', '--non-interactive']]);
  }, 120_000);
});

describe('N14 engine selection', () => {
  test('GBRAIN_EVAL_ENGINE picks the engine; --engine may repeat it but not contradict it', () => {
    expect(parseEngine([], {})).toEqual({ kind: 'pglite' });
    expect(parseEngine([], { GBRAIN_EVAL_ENGINE: 'rust' })).toEqual({ kind: 'rust' });
    expect(parseEngine(['--engine', 'rust'], { GBRAIN_EVAL_ENGINE: 'rust' })).toEqual({ kind: 'rust' });
    expect(parseEngine([], { GBRAIN_EVAL_ENGINE: 'postgres', N14_PG_ADMIN_URL: 'postgres://x' })).toEqual({ kind: 'postgres', adminUrl: 'postgres://x' });
    expect(() => parseEngine(['--engine', 'postgres'], { GBRAIN_EVAL_ENGINE: 'pglite' })).toThrow(/disagree/);
    expect(() => parseEngine(['--engine', 'rust'], {})).toThrow(/takes pglite or postgres/);
  });
  test('rust lists every SQL measurement not_applicable; pglite and postgres list none', () => {
    expect(n14NotApplicable('pglite')).toEqual([]);
    expect(n14NotApplicable('postgres')).toEqual([]);
    const na = n14NotApplicable('rust');
    expect(na).toHaveLength(N14_SQL_CHECKS.length);
    expect(na.every(x => x.status === 'not_applicable' && /raw_sql/.test(x.reason))).toBe(true);
  });
  test('without raw SQL the quality and floor rules count as neither pass nor fail; safety still gates', () => {
    const s = { safety: { crashes: 0, responses_over_cap: 0, roundtrip_byte_loss: 0, presence_failures: 0 }, quality: { native_append_embed_ratio_max: null, native_recall_gap_points_max: null }, floor: { native_keyword_recall_2mb: null }, arms: [{ status: 'ran', roundtrip: 'match' }, { status: 'capability_absent', roundtrip: 'not_stored' }] } as unknown as N14Summary;
    expect(n14Verdict(s).verdict).toBe('fail');
    expect(n14Verdict(s, { rawSql: false })).toEqual({ verdict: 'pass', failed: [] });
    expect(n14Verdict({ ...s, safety: { ...s.safety, crashes: 1 } }, { rawSql: false }).verdict).toBe('fail');
  });
  test('without raw SQL an arm that ran but stored nothing fails instead of passing on zero safety counts', () => {
    const s = { safety: { crashes: 0, responses_over_cap: 0, roundtrip_byte_loss: 0, presence_failures: 0 }, quality: { native_append_embed_ratio_max: null, native_recall_gap_points_max: null }, floor: { native_keyword_recall_2mb: null }, arms: [{ status: 'ran', roundtrip: 'not_stored' }, { status: 'ran', roundtrip: 'not_stored' }, { status: 'ran', roundtrip: 'match' }] } as unknown as N14Summary;
    expect(n14Verdict(s, { rawSql: false })).toEqual({ verdict: 'fail', failed: ['roundtrip.not_stored=2'] });
  });
});

describe('N1 and N6 HTTP engine arguments', () => {
  test('N1: --engines may repeat GBRAIN_EVAL_ENGINE but not contradict it; the paid arm stays PGLite-only', () => {
    expect(() => checkEvalEngineArgs('postgres', [])).not.toThrow();
    expect(() => checkEvalEngineArgs('postgres', ['--engines', 'postgres'])).not.toThrow();
    expect(() => checkEvalEngineArgs('rust', ['--engines', 'pglite,postgres'])).toThrow(/disagree/);
    expect(() => checkEvalEngineArgs('pglite', ['--paid'])).toThrow(/paid arm/);
  });
  test('N6 over HTTP says why PGLite and rust do not run', () => {
    expect(PGLITE_HTTP_UNSUPPORTED).toMatch(/one process/);
    expect(RUST_HTTP_UNSUPPORTED).toMatch(/no Rust flag/);
  });
});

describe('lifecycle slice: a rust cell', () => {
  test('writes the rust CLI config and initialises with init --migrate-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-cli-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    const argLog = join(root, 'args.log');
    writeFileSync(join(root, 'src/cli.ts'), [
      "import { appendFileSync } from 'node:fs';",
      'const a = process.argv.slice(2);',
      'appendFileSync(' + JSON.stringify(argLog) + ", JSON.stringify(a) + '\\n');",
      "if (a[0] === 'decide') console.log(JSON.stringify({ slots: [{ slot: 'x', effective: 'off' }] }));",
    ].join('\n'));
    const work = mkdtempSync(join(tmpdir(), 'gate-work-'));
    const cell = new SliceCell({ buildDir: root, engine: 'rust', iface: 'cli', work, label: 't', pgAdminUrl: 'postgres://unused', port: 1 });
    await cell.setup();
    const config = JSON.parse(readFileSync(join(cell.home, '.gbrain/config.json'), 'utf8'));
    expect(config).toEqual({ engine: 'rust', database_path: join(cell.home, 'brain.rust'), embedding_disabled: true, schema_pack: 'gbrain-base-v2' });
    const calls = readFileSync(argLog, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]);
    expect(calls[0]).toEqual(['init', '--migrate-only', '--non-interactive']);
    expect(cell.decideOff.ok).toBe(true);
    await cell.close();
  }, 60_000);
});

describe('runners refuse rust today with exit 69 and no receipt', () => {
  const runners: Array<[string, string[]]> = [
    ['n12-format-fidelity.ts', []],
    ['n6-visibility-fuzz.ts', []],
    ['n14-large-page-fidelity.ts', ['--tiers', '2mb']],
    ['n1-knowledge-update.ts', ['--slice', 'ci']],
    ['n5-forget-residue.ts', ['--slice', 'ci']],
    ['n6-postgres-http.ts', []],
  ];
  for (const [file, args] of runners) {
    test(file, () => {
      const out = mkdtempSync(join(tmpdir(), 'gate-refuse-'));
      const home = mkdtempSync(join(tmpdir(), 'gate-home-'));
      const r = spawnSync('bun', [join(ROOT, 'eval/runner', file), ...args, '--output', out], {
        cwd: ROOT, encoding: 'utf8', timeout: 120_000,
        env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, TZ: 'UTC', GBRAIN_EVAL_ENGINE: 'rust' },
      });
      expect(r.stderr).toMatch(/REFUSED: .* did not run on engine rust\. EvalEngineUnavailable \(rust_kind_unsupported\)/);
      expect(r.status).toBe(EVAL_ENGINE_REFUSED_EXIT);
      expect(readdirSync(out)).toEqual([]);
    }, 130_000);
  }
});
