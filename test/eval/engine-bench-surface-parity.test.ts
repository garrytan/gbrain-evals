import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORPUS_MTIME, NORMALIZATION_RULES, SURFACE_PARITY_SCHEMA_VERSION, buildCorpus, classifyDiff, compareCaptures, defaultScript, diffExcerpt,
  enginesFrom, inputFingerprint, normalize, runSurfaceParity, worldSubset, type Capture, type CorpusFile, type EngineCapture, type Step,
} from '../../eval/runner/engine-bench/surface-parity.ts';
import { resolveGbrainUnderTest, type GbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';

/**
 * A fake gbrain root: a CLI that answers import, export, call, serve and CLI-native commands with outputs that carry
 * run-varying values (timestamps, random revisions, durations, its own home path), and optionally a Rust engine.
 * `reorder` names an engine whose list_pages answer comes back in another order. A write's receipt reports its effect
 * queued for its first poll (five for the `slowSettle` engine, every poll for the `neverSettle` engine), counted per brain
 * home and request_id so CLI polls in separate processes see it settle. As in gbrain, a CLI write's receipt also carries an
 * embedding effect that stays queued, because only a later writing process drains it, and a put_page's receipt carries a
 * facts-backstop effect, queued on the CLI for the same reason and dispatched at once by serve. The `recovering` engine's receipts stay
 * `recovering` with no effects, and the `slowPoll` engine's CLI get_write_request answers after 2 s. Every CLI start is logged
 * to calls.log.
 */
function fakeGbrain(o: { rust: 'none' | 'unsupported' | 'opens'; reorder?: string; slowSettle?: string; neverSettle?: string; recovering?: string; slowPoll?: string }): GbrainUnderTest {
  const root = mkdtempSync(join(tmpdir(), 'surface-parity-fake-'));
  mkdirSync(join(root, 'src/core'), { recursive: true });
  if (o.rust !== 'none') {
    mkdirSync(join(root, 'src/core/rust-engine'), { recursive: true });
    writeFileSync(join(root, 'src/core/engine-construct.ts'), o.rust === 'opens'
      ? 'export async function constructEngine(c) { return { kind: c.engine, async connect() {}, async initSchema() {}, async disconnect() {} }; }\n'
      : 'export async function constructEngine(c) { throw new Error(`Unknown engine type: "${c.engine}"`); }\n');
  }
  writeFileSync(join(root, 'reorder.txt'), o.reorder ?? '');
  writeFileSync(join(root, 'slow-settle.txt'), o.slowSettle ?? '');
  writeFileSync(join(root, 'never-settle.txt'), o.neverSettle ?? '');
  writeFileSync(join(root, 'recovering.txt'), o.recovering ?? '');
  writeFileSync(join(root, 'slow-poll.txt'), o.slowPoll ?? '');
  writeFileSync(join(root, 'calls.log'), '');
  writeFileSync(join(root, 'src/cli.ts'), `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const home = process.env.GBRAIN_HOME;
const cfg = JSON.parse(readFileSync(join(home, '.gbrain/config.json'), 'utf8'));
const reorder = readFileSync(join(import.meta.dir, '../reorder.txt'), 'utf8').trim() === cfg.engine;
const queuedPolls = readFileSync(join(import.meta.dir, '../never-settle.txt'), 'utf8').trim() === cfg.engine ? Infinity
  : readFileSync(join(import.meta.dir, '../slow-settle.txt'), 'utf8').trim() === cfg.engine ? 4 : 1;
const recovering = readFileSync(join(import.meta.dir, '../recovering.txt'), 'utf8').trim() === cfg.engine;
const slowPoll = readFileSync(join(import.meta.dir, '../slow-poll.txt'), 'utf8').trim() === cfg.engine;
const [cmd, ...rest] = process.argv.slice(2);
appendFileSync(join(import.meta.dir, '../calls.log'), cfg.engine + '\\t' + process.argv.slice(2).join(' ') + '\\n');
const out = v => process.stdout.write(JSON.stringify(v, null, 2) + '\\n');
const polled = id => {
  const f = join(home, 'polls-' + encodeURIComponent(id));
  const n = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0;
  writeFileSync(f, String(n + 1));
  return n;
};
const facts = id => join(home, 'facts-' + encodeURIComponent(id));
const answer = (op, args) => {
  if (op === 'put_page' && args.request_id) writeFileSync(facts(args.request_id), '');
  return reply(op, args);
};
const reply = (op, args) => op === 'get_write_request' && recovering
  ? { state: 'recovering', effects: [] }
  : op === 'get_write_request'
  ? { state: 'committed', effects: [{ kind: 'links', state: polled(args.request_id) < queuedPolls ? 'queued' : 'committed' }, ...(cmd === 'call' ? [{ kind: 'embedding', state: 'queued' }] : []),
    ...(existsSync(facts(args.request_id)) ? [{ kind: 'facts-backstop', state: cmd === 'call' ? 'queued' : 'dispatched' }] : [])] }
  : op === 'list_pages'
  ? (reorder ? [{ slug: 'b' }, { slug: 'a' }] : [{ slug: 'a' }, { slug: 'b' }])
  : { op, args, revision: crypto.randomUUID(), updated_at: new Date().toISOString(), effective_date: '2025-01-01T00:00:00.000Z', home };
if (cmd === 'import') out({ status: 'success', duration_s: Math.random(), keyless: cfg.embedding_disabled === true, store: cfg.database_path ?? cfg.database_url });
else if (cmd === 'export') {
  const dir = rest[rest.indexOf('--dir') + 1];
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes/a.md'), '---\\ntitle: A\\n---\\n\\nA body\\n');
} else if (cmd === 'call') {
  if (slowPoll && rest[0] === 'get_write_request') await Bun.sleep(2000);
  out(answer(rest[0], JSON.parse(rest[1])));
}
else if (cmd === 'serve') {
  createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.id === undefined) return;
    const result = m.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify(answer(m.params.name, m.params.arguments)) }] } : { serverInfo: { name: 'fake' } };
    process.stdout.write(JSON.stringify({ result, jsonrpc: '2.0', id: m.id }) + '\\n');
  });
} else out({ cmd, rest, at: new Date().toISOString() });
`);
  return { root, version: '0.0.0-fake', overlay: null };
}

const tinyCorpus: CorpusFile[] = [
  { path: 'notes/a.md', content: '---\ntitle: A\ntype: note\n---\n\nAlpha mentions [B](notes/b).\n' },
  { path: 'notes/b.md', content: '---\ntitle: B\ntype: note\n---\n\nBeta.\n' },
];
const tinyScript: Step[] = [
  { id: 'get_page/notes/a', op: 'get_page', args: { slug: 'notes/a' } },
  { id: 'list_pages/slug', op: 'list_pages', args: { sort: 'slug' } },
  { id: 'cli:stats --json', cli: ['stats', '--json'] },
];

const ctx = { workDir: '/w/run', engineDir: '/w/run/engines/pglite', databaseLocations: ['/w/run/engines/pglite/brain-a.pglite'] };

describe('corpus and script', () => {
  test('the world subset is the first 15 of each folder by sorted slug, plus five edge cases', () => {
    const world = worldSubset();
    expect(world).toHaveLength(60);
    for (const folder of ['companies', 'concepts', 'meetings', 'people']) {
      const slugs = world.filter(p => p.slug.startsWith(`${folder}/`)).map(p => p.slug);
      expect(slugs).toHaveLength(15);
      expect([...slugs].sort()).toEqual(slugs);
    }
    const corpus = buildCorpus();
    expect(corpus).toHaveLength(65);
    expect(corpus.filter(f => f.path.startsWith('edge/')).map(f => f.path)).toEqual(['edge/unicode.md', 'edge/long-page.md', 'edge/frontmatter.md', 'edge/links.md', 'edge/timeline.md']);
    expect(corpus.find(f => f.path === 'edge/long-page.md')!.content.length).toBeGreaterThan(20_000);
    expect(corpus[0].content.startsWith('---\ntitle: ')).toBe(true);
  });
  test('the input fingerprint is stable and moves with the corpus or the script', () => {
    const corpus = buildCorpus();
    const script = defaultScript(corpus);
    const a = inputFingerprint(corpus, script);
    expect(inputFingerprint(buildCorpus(), defaultScript(buildCorpus()))).toEqual(a);
    expect(inputFingerprint(corpus, script.slice(1)).sha256).not.toBe(a.sha256);
    expect(inputFingerprint([...corpus.slice(1), { ...corpus[0], content: `${corpus[0].content} ` }], script).corpus_sha256).not.toBe(a.corpus_sha256);
    expect(a.corpus_mtime).toBe(CORPUS_MTIME.toISOString());
  });
  test('the script covers reads, keyword search, writes followed by reads, and a delete then get', () => {
    const ops = new Set(defaultScript(buildCorpus()).map(s => s.op ?? 'cli'));
    for (const op of ['get_page', 'list_pages', 'search', 'get_links', 'get_backlinks', 'get_timeline', 'get_tags', 'get_stats', 'put_page', 'add_tag', 'add_link', 'add_timeline_entry', 'delete_page', 'cli']) expect(ops.has(op)).toBe(true);
    const script = defaultScript(buildCorpus());
    expect(script.filter(s => s.op === 'search').every(s => s.args?.match === 'keyword')).toBe(true);
    expect(script.findIndex(s => s.id === 'after/get_page/edge/long-page')).toBeGreaterThan(script.findIndex(s => s.id === 'write/delete_page'));
  });
});

describe('normalize', () => {
  test('masks run-time timestamps, keeps the fixed corpus mtime and counts each rule', () => {
    const n = normalize('{"created_at": "2026-11-17T08:33:57.899Z", "pg": "2026-11-17 08:33:57.899+00", "effective_date": "2025-01-01T00:00:00.000Z", "date": "2024-05-01"}', ctx);
    expect(n.text).toBe('{"created_at": "<TS:####-##-##T##:##:##.###Z>", "pg": "<TS:####-##-## ##:##:##.###+##>", "effective_date": "2025-01-01T00:00:00.000Z", "date": "2024-05-01"}');
    expect(n.counts.timestamp).toBe(2);
    expect(normalize('"2026-11-17T08:33:57.899000Z"', ctx).text).not.toBe(normalize('"2026-11-17T08:33:57.899Z"', ctx).text);
  });
  test('numbers UUIDs by first appearance so equal ids stay equal', () => {
    const a = '1a376cad-aa2d-40a6-8d43-daeaf190dcd2';
    const b = '2f7da101-d5fe-4e45-b251-086e8849313f';
    const n = normalize(`${a} ${b} ${a}`, ctx);
    expect(n.text).toBe('<UUID-1> <UUID-2> <UUID-1>');
    expect(n.counts.uuid).toBe(3);
  });
  test('masks durations under duration keys only', () => {
    const n = normalize('{"duration_s":0.1,"took_ms": 12,"ms":3,"imported":2,"score":1.25}', ctx);
    expect(n.text).toBe('{"duration_s":"<DURATION>","took_ms": "<DURATION>","ms":"<DURATION>","imported":2,"score":1.25}');
    expect(JSON.parse(n.text).imported).toBe(2);
    expect(n.counts.duration).toBe(3);
  });
  test('replaces the database location, the engine directory and the work directory, longest first', () => {
    const n = normalize('db /w/run/engines/pglite/brain-a.pglite home /w/run/engines/pglite/home-a corpus file:///w/run/corpus/a.md', ctx);
    expect(n.text).toBe('db <DATABASE> home <ENGINE_DIR>/home-a corpus file://<WORK>/corpus/a.md');
    expect(n.counts).toMatchObject({ database_location: 1, engine_dir: 1, work_dir: 1 });
  });
  test('masks a whole timings object, braces inside strings included, and keeps what follows', () => {
    const n = normalize('{"retrieval":{"timings":{"total_ms":5,"stages_ms":{"a":1,"b":"}{"}},"rows":"lean"},"x":1}', ctx);
    expect(n.text).toBe('{"retrieval":{"timings":"<TIMINGS>","rows":"lean"},"x":1}');
    expect(n.counts.timings).toBe(1);
    expect(n.counts.duration).toBe(0);
  });
  test('every rule is listed with a description', () => {
    expect(NORMALIZATION_RULES.map(r => r.id)).toEqual(['database_location', 'engine_dir', 'work_dir', 'timestamp', 'uuid', 'duration', 'timings']);
    for (const r of NORMALIZATION_RULES) expect(r.description.length).toBeGreaterThan(20);
  });
});

describe('classifyDiff and diffExcerpt', () => {
  test('ordering: the same lines, or the same JSON items, in another order', () => {
    expect(classifyDiff('[\n  "a",\n  "b"\n]', '[\n  "b",\n  "a"\n]')).toBe('ordering');
    const mcp = (items: unknown[]) => JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(items) }] }, id: 3 });
    expect(classifyDiff(mcp([{ slug: 'a', n: 1 }, { slug: 'b', n: 2 }]), mcp([{ slug: 'b', n: 2 }, { slug: 'a', n: 1 }]))).toBe('ordering');
  });
  test('float formatting, numeric value, timestamp and content', () => {
    expect(classifyDiff('{"score": 1.0}', '{"score": 1}')).toBe('float_formatting');
    expect(classifyDiff('{"score": 1.250001}', '{"score": 1.25}')).toBe('numeric_value');
    expect(classifyDiff('{"effective_date": "2026-11-17"}', '{"effective_date": "2026-11-18"}')).toBe('timestamp');
    expect(classifyDiff('{"title": "Alpha"}', '{"title": "Beta"}')).toBe('content');
  });
  test('a JSON excerpt names the differing leaf paths, inside MCP text payloads too', () => {
    const mcp = (items: unknown) => JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(items) }] }, id: 3 });
    const e = diffExcerpt(mcp({ page_count: 66, title: 'A' }), mcp({ page_count: 65, title: 'A' }), ['pglite', 'postgres']);
    expect(e).toContain('first difference at line 1, character');
    expect(e).toContain('.result.content[0].text.page_count: 66 vs 65');
  });
  test('the excerpt names the first differing line with context', () => {
    const e = diffExcerpt('a\nb\nc\nd', 'a\nB\nc\nd', ['pglite', 'postgres']);
    expect(e).toContain('first difference at line 2');
    expect(e).toContain('- pglite: b');
    expect(e).toContain('+ postgres: B');
  });
});

describe('compareCaptures', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const engine = (kind: 'pglite' | 'postgres' | 'rust', captures: Capture[], status: EngineCapture['status'] = 'ran'): EngineCapture => ({
    kind, status, captures, setup: [], settles: [], ctx: { workDir: '/w', engineDir: `/w/engines/${kind}`, databaseLocations: [] },
  });
  test('identical after normalization, differs with a class and excerpt, errored and not_applicable', () => {
    const pg = engine('pglite', [
      { surface: 'cli', op: 'same', raw_b64: b64('{"updated_at": "2026-11-17T01:00:00Z", "home": "/w/engines/pglite/home-a"}'), exit_code: 0 },
      { surface: 'cli', op: 'order', raw_b64: b64('[\n  "a",\n  "b"\n]'), exit_code: 0 },
      { surface: 'cli', op: 'exit', raw_b64: b64('{}'), exit_code: 0 },
      { surface: 'mcp', op: 'broken', error: 'MCP get_page got no response in 180 s' },
      { surface: 'mcp', op: 'cli-only', not_applicable: 'no MCP tool' },
    ]);
    const post = engine('postgres', [
      { surface: 'cli', op: 'same', raw_b64: b64('{"updated_at": "2026-11-17T02:00:00Z", "home": "/w/engines/postgres/home-a"}'), exit_code: 0 },
      { surface: 'cli', op: 'order', raw_b64: b64('[\n  "b",\n  "a"\n]'), exit_code: 0 },
      { surface: 'cli', op: 'exit', raw_b64: b64('{}'), exit_code: 1 },
      { surface: 'mcp', op: 'broken', raw_b64: b64('{}') },
      { surface: 'mcp', op: 'cli-only', not_applicable: 'no MCP tool' },
    ]);
    const { operations, replacements } = compareCaptures([pg, post, engine('rust', [], 'refused')]);
    const by = Object.fromEntries(operations.map(o => [o.op, o]));
    expect(by.same.status).toBe('identical');
    expect(by.same.engines_compared).toEqual(['pglite', 'postgres']);
    expect(by.order.status).toBe('differs');
    expect(by.order.diffs![0]).toMatchObject({ reference: 'pglite', engine: 'postgres', class: 'ordering' });
    expect(by.exit.status).toBe('differs');
    expect(by.exit.diffs![0].excerpt).toContain('exit code pglite=0 postgres=1');
    expect(by.broken.status).toBe('errored');
    expect(by.broken.reason).toContain('pglite: MCP get_page');
    expect(by['cli-only'].status).toBe('not_applicable');
    expect(replacements.pglite!.cli).toMatchObject({ timestamp: 1, engine_dir: 1 });
    expect(replacements.rust).toBeUndefined();
  });
  test('an operation only rust refuses with engine_capability_missing is refused, a named gap; any other rust error stays errored', () => {
    const ts = (kind: 'pglite' | 'postgres') => engine(kind, [
      { surface: 'cli', op: 'tags', raw_b64: b64('["a"]'), exit_code: 0 },
      { surface: 'mcp', op: 'health', raw_b64: b64('{}') },
      { surface: 'mcp', op: 'crash', raw_b64: b64('{}') },
    ]);
    const rust = engine('rust', [
      { surface: 'cli', op: 'tags', raw_b64: b64('{"error":{"code":"engine_capability_missing","capability":"tags"}}'), exit_code: 1 },
      { surface: 'mcp', op: 'health', error: 'tools/call get_health: engine_capability_missing (health)' },
      { surface: 'mcp', op: 'crash', error: 'MCP server exited' },
    ]);
    const by = Object.fromEntries(compareCaptures([ts('pglite'), ts('postgres'), rust]).operations.map(o => [o.op, o]));
    expect(by.tags.status).toBe('refused');
    expect(by.health.status).toBe('refused');
    expect(by.health.reason).toContain('rust: tools/call get_health');
    expect(by.crash.status).toBe('errored');
  });
  test('one engine alone compares nothing', () => {
    const { operations } = compareCaptures([engine('pglite', [{ surface: 'cli', op: 'x', raw_b64: b64('{}'), exit_code: 0 }]), engine('rust', [], 'refused')]);
    expect(operations[0]).toMatchObject({ status: 'not_applicable', engines_compared: ['pglite'] });
    expect(operations[0].reason).toContain('fewer than two engines ran');
  });
});

describe('enginesFrom', () => {
  test('defaults to pglite and postgres, adds GBRAIN_EVAL_ENGINE, and rejects unknown engines', () => {
    expect(enginesFrom([], {})).toEqual(['pglite', 'postgres']);
    expect(enginesFrom([], { GBRAIN_EVAL_ENGINE: 'rust' })).toEqual(['pglite', 'postgres', 'rust']);
    expect(enginesFrom(['--engines', 'pglite,rust'], {})).toEqual(['pglite', 'rust']);
    expect(() => enginesFrom(['--engines', 'sqlite'], {})).toThrow(/not an engine/);
  });
});

describe('runSurfaceParity with a fake gbrain', () => {
  test('rust opens through eval-engine.ts once the build carries it, and every surface is compared', async () => {
    const r = await runSurfaceParity({ gut: fakeGbrain({ rust: 'opens' }), engines: ['pglite', 'rust'], corpus: tinyCorpus, script: tinyScript });
    expect(r.schema_version).toBe(SURFACE_PARITY_SCHEMA_VERSION);
    expect(r.summary.engines_ran).toEqual(['pglite', 'rust']);
    expect(r.summary.verdict).toBe('byte_exact');
    expect(r.surfaces.cli.counts).toEqual({ identical: 5, differs: 0, errored: 0, refused: 0, not_applicable: 0 });
    expect(r.surfaces.mcp.counts).toEqual({ identical: 2, differs: 0, errored: 0, refused: 0, not_applicable: 1 });
    expect(r.surfaces.markdown.counts.identical).toBe(2 + 2 + 2);
    const counts = r.normalization.replacements.rust!.cli!;
    expect(counts.timestamp).toBeGreaterThan(0);
    expect(counts.uuid).toBeGreaterThan(0);
    expect(counts.duration).toBe(1);
    expect(counts.engine_dir).toBeGreaterThan(0);
    expect(r.keyless.provider_calls).toBe(0);
    expect(r.input_fingerprint).toEqual(inputFingerprint(tinyCorpus, tinyScript));
  }, 60_000);
  test('an engine that orders a list differently is a parity failure with the operation, surface and class', async () => {
    const r = await runSurfaceParity({ gut: fakeGbrain({ rust: 'opens', reorder: 'rust' }), engines: ['pglite', 'rust'], corpus: tinyCorpus, script: tinyScript });
    expect(r.summary.verdict).toBe('differs');
    for (const s of ['cli', 'mcp'] as const) {
      const op = r.surfaces[s].operations.find(o => o.op === 'list_pages/slug')!;
      expect(op.status).toBe('differs');
      expect(op.diffs![0]).toMatchObject({ reference: 'pglite', engine: 'rust', class: 'ordering' });
    }
    expect(r.differences_by_class).toEqual({ cli: { ordering: 1 }, mcp: { ordering: 1 } });
  }, 60_000);
  test('rust is refused, not passed or failed, when the build lacks it or cannot construct it', async () => {
    for (const [rust, reason] of [['none', 'rust_engine_not_in_build'], ['unsupported', 'rust_kind_unsupported']] as const) {
      const r = await runSurfaceParity({ gut: fakeGbrain({ rust }), engines: ['pglite', 'rust'], corpus: tinyCorpus, script: tinyScript });
      expect(r.engines.rust).toMatchObject({ status: 'refused', refusal_reason: reason });
      expect(r.engines.pglite.status).toBe('ran');
      expect(r.summary.engines_refused).toEqual(['rust']);
      expect(r.summary.verdict).toBe('incomplete');
      expect(r.summary.counts.identical + r.summary.counts.differs + r.summary.counts.errored).toBe(0);
    }
  }, 60_000);
  test('postgres without a URL is refused with the reason', async () => {
    const r = await runSurfaceParity({ gut: fakeGbrain({ rust: 'none' }), engines: ['postgres'], corpus: tinyCorpus, script: tinyScript });
    expect(r.engines.postgres).toMatchObject({ status: 'refused', refusal_reason: 'postgres_url_missing' });
  });
});

describe('MCP writes settle before the next read', () => {
  test('a write with a request_id waits for its queued effects, and the wait is in the receipt but not compared', async () => {
    const script: Step[] = [...tinyScript, { id: 'write/add_tag', op: 'add_tag', args: { slug: 'notes/a', tag: 't', request_id: 'rid-1' } }];
    const r = await runSurfaceParity({ gut: fakeGbrain({ rust: 'opens' }), engines: ['pglite', 'rust'], corpus: tinyCorpus, script });
    for (const k of ['pglite', 'rust']) {
      expect(r.engines[k].settles).toEqual([
        expect.objectContaining({ surface: 'cli', op: 'write/add_tag', settled: true, polls: 2, last: 'state committed; effects links=committed, embedding=queued' }),
        expect.objectContaining({ surface: 'mcp', op: 'write/add_tag', settled: true, polls: 2, last: 'state committed; effects links=committed' }),
      ]);
    }
    expect(r.surfaces.mcp.operations.map(o => o.op)).not.toContain('get_write_request');
    expect(r.summary.verdict).toBe('byte_exact');
  }, 60_000);
  test('an engine whose effects take longer to settle still matches byte for byte (polls never shift JSON-RPC ids)', async () => {
    const script: Step[] = [{ id: 'write/add_tag', op: 'add_tag', args: { slug: 'notes/a', tag: 't', request_id: 'rid-1' } }, ...tinyScript];
    const r = await runSurfaceParity({ gut: fakeGbrain({ rust: 'opens', slowSettle: 'rust' }), engines: ['pglite', 'rust'], corpus: tinyCorpus, script });
    expect(r.engines.rust.settles.map(s => s.polls)).toEqual([5, 5]);
    expect(r.engines.pglite.settles.map(s => s.polls)).toEqual([2, 2]);
    expect(r.summary.verdict).toBe('byte_exact');
  }, 60_000);
});

describe('CLI writes settle before the export after the writes', () => {
  const writes: Step[] = [
    { id: 'write/add_tag', op: 'add_tag', args: { slug: 'notes/a', tag: 't', request_id: 'rid-1' } },
    { id: 'write/delete_page', op: 'delete_page', args: { slug: 'notes/b', request_id: 'rid-2' } },
  ];
  test('every CLI write is polled to a settled receipt before gbrain export runs, and each wait is in the receipt', async () => {
    const gut = fakeGbrain({ rust: 'opens' });
    const r = await runSurfaceParity({ gut, engines: ['pglite', 'rust'], corpus: tinyCorpus, script: [...tinyScript, ...writes] });
    const calls = readFileSync(join(gut.root, 'calls.log'), 'utf8').split('\n');
    for (const k of ['pglite', 'rust']) {
      const mine = calls.filter(l => l.startsWith(`${k}\t`));
      const exportAt = mine.findIndex(l => /\texport --dir \S+export-after-writes$/.test(l));
      expect(exportAt).toBeGreaterThan(0);
      for (const id of ['rid-1', 'rid-2']) {
        const lastPoll = mine.findLastIndex(l => l.includes('call get_write_request') && l.includes(id));
        expect(lastPoll).toBeGreaterThan(mine.findIndex(l => l.includes(`"request_id":"${id}"`)));
        expect(lastPoll).toBeLessThan(exportAt);
      }
      expect(r.engines[k].settles.filter(s => s.surface === 'cli')).toEqual(writes.map(w => expect.objectContaining({ op: w.id, settled: true, polls: 2 })));
    }
    expect(r.summary.verdict).toBe('byte_exact');
  }, 60_000);
  test('a CLI put_page settles with its facts-backstop effect still queued, as serve dispatches it at once', async () => {
    const put: Step = { id: 'write/put_page', op: 'put_page', args: { slug: 'notes/c', content: '---\ntitle: C\ntype: note\n---\n\nGamma.\n', request_id: 'rid-3' } };
    const r = await runSurfaceParity({ gut: fakeGbrain({ rust: 'opens' }), engines: ['pglite', 'rust'], corpus: tinyCorpus, script: [...tinyScript, put], settleTimeoutMs: 5_000 });
    for (const k of ['pglite', 'rust']) {
      expect(r.engines[k].settles).toEqual([
        expect.objectContaining({ surface: 'cli', op: 'write/put_page', settled: true, polls: 2, last: 'state committed; effects links=committed, embedding=queued, facts-backstop=queued' }),
        expect.objectContaining({ surface: 'mcp', op: 'write/put_page', settled: true, polls: 2, last: 'state committed; effects links=committed, facts-backstop=dispatched' }),
      ]);
    }
    expect(r.surfaces.cli.operations.map(o => o.op)).not.toContain('write/put_page (settle)');
    expect(r.summary.verdict).toBe('byte_exact');
  }, 60_000);
  test('a CLI write that never settles errors its (settle) operation instead of being skipped', async () => {
    const r = await runSurfaceParity({ gut: fakeGbrain({ rust: 'opens', neverSettle: 'rust' }), engines: ['pglite', 'rust'], corpus: tinyCorpus, script: [...tinyScript, writes[1]], settleTimeoutMs: 1_000 });
    const op = r.surfaces.cli.operations.find(o => o.op === 'write/delete_page (settle)')!;
    expect(op.status).toBe('errored');
    expect(op.reason).toContain('rust: write rid-2 did not settle in 1 s: state committed; effects links=queued, embedding=queued');
    expect(r.engines.rust.settles.find(s => s.surface === 'cli')).toMatchObject({ settled: false });
    expect(r.summary.verdict).not.toBe('byte_exact');
  }, 60_000);
  test('a write whose receipt is still recovering is not settled, on either surface', async () => {
    const r = await runSurfaceParity({ gut: fakeGbrain({ rust: 'opens', recovering: 'rust' }), engines: ['pglite', 'rust'], corpus: tinyCorpus, script: [...tinyScript, writes[1]], settleTimeoutMs: 1_000 });
    for (const s of ['cli', 'mcp'] as const) {
      const op = r.surfaces[s].operations.find(o => o.op === 'write/delete_page (settle)')!;
      expect(op.status).toBe('errored');
      expect(op.reason).toContain('rust: write rid-2 did not settle in 1 s: state recovering; effects none');
    }
    expect(r.engines.pglite.settles.every(s => s.settled)).toBe(true);
  }, 60_000);
  test('a receipt that arrives after the settle wait has run out does not count as settled', async () => {
    const r = await runSurfaceParity({ gut: fakeGbrain({ rust: 'opens', slowPoll: 'rust' }), engines: ['pglite', 'rust'], corpus: tinyCorpus, script: [...tinyScript, writes[1]], settleTimeoutMs: 1_000 });
    const settle = r.engines.rust.settles.find(s => s.surface === 'cli')!;
    expect(settle).toMatchObject({ settled: false, polls: 1 });
    expect(settle.ms).toBeLessThan(2_000);
    expect(r.surfaces.cli.operations.find(o => o.op === 'write/delete_page (settle)')!.status).toBe('errored');
    expect(r.engines.pglite.settles.every(s => s.settled)).toBe(true);
  }, 60_000);
  test('the receipt keeps the full normalized delete_page reply on every surface, not only its digest', async () => {
    const r = await runSurfaceParity({ gut: fakeGbrain({ rust: 'opens' }), engines: ['pglite', 'rust'], corpus: tinyCorpus, script: [...tinyScript, writes[1]] });
    for (const s of ['cli', 'mcp'] as const) {
      const op = r.surfaces[s].operations.find(o => o.op === 'write/delete_page')!;
      for (const k of ['pglite', 'rust'] as const) {
        expect(op.outputs![k]!.text).toContain('delete_page');
        expect(op.outputs![k]!.text).toContain('notes/b');
        expect(op.outputs![k]!.text).toContain('<UUID-');
        expect(op.outputs![k]!.sha256).toBe(createHash('sha256').update(op.outputs![k]!.text!).digest('hex'));
      }
    }
    expect(r.surfaces.cli.operations.find(o => o.op === 'get_page/notes/a')!.outputs!.pglite!.text).toBeUndefined();
  }, 60_000);
});

describe('runSurfaceParity on the pinned gbrain', () => {
  test('pglite runs every surface keyless through the real CLI; rust is refused', async () => {
    const gut = resolveGbrainUnderTest(null);
    const r = await runSurfaceParity({ gut, engines: ['pglite', 'rust'], corpus: tinyCorpus, script: tinyScript });
    expect(r.engines.rust).toMatchObject({ status: 'refused', refusal_reason: 'rust_engine_addon_missing' });
    expect(r.engines.pglite.status).toBe('ran');
    expect(r.engines.pglite.setup.every(s => s.code === 0)).toBe(true);
    const ops = SURFACES_OF(r);
    expect(ops).toContain('cli:get_page/notes/a');
    expect(ops).toContain('mcp:get_page/notes/a');
    expect(ops).toContain('markdown:export/notes/a.md');
    expect(ops).toContain('markdown:get_page view=markdown/notes/a');
    expect(r.summary.counts.errored).toBe(0);
  }, 180_000);
});

function SURFACES_OF(r: Awaited<ReturnType<typeof runSurfaceParity>>): string[] {
  return (['cli', 'mcp', 'markdown'] as const).flatMap(s => r.surfaces[s].operations.map(o => `${s}:${o.op}`));
}
