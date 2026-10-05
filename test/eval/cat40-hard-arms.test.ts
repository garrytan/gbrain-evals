/**
 * Cat 40 Hard arm infrastructure (plan 2026-10-05): tool limits and their descriptions (CEO-T4, DX-F10), the
 * Hard grep worker (ENG-F13), pg chunked embeddings and cost attribution (ENG-F11, ENG-F12), slot quarantine
 * (ENG-F10), asynchronous restores and MCP transport failures. Hermetic: fake embedders, fake fetch, fake slots
 * and a fake MCP server; no paid call.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLadderWorld, type LadderDoc } from '../../eval/generators/model-ladder-gen.ts';
import { FileStore, FsArm, GREP_LIMITS, HARD_GREP_TOOL, MemoryArm } from '../../eval/runner/cat40/arms.ts';
import { grepTimeoutMessage, grepWorkerFor, terminateGrepWorkers } from '../../eval/runner/cat40/hard-grep.ts';
import { HarnessError } from '../../eval/runner/cat40/loop.ts';
import {
  PG_CHUNK_CHARS, PG_CHUNK_OVERLAP, PG_CHUNKING_ID, PG_EMBED_DIMS, PG_EMBED_INPUT_CHARS, PG_SEARCH_LIMITS, PgArm, PgStore,
  cachedOpenAIEmbedder, chunkDocument, type Embedder,
} from '../../eval/runner/cat40/pg-arm.ts';
import { GbrainPool, GbrainSlot, McpClient, SlotQuarantineError, type PoolSlot } from '../../eval/runner/cat40/gbrain-arm.ts';

const world = generateLadderWorld();
const tmp = mkdtempSync(join(tmpdir(), 'cat40-hard-arms-'));
afterAll(() => { terminateGrepWorkers(); rmSync(tmp, { recursive: true, force: true }); });

const V1_GREP_DESCRIPTION = 'Search file contents with a regular expression, like ripgrep. Returns matching lines as path:line: text.';
const longLine = `needle ${'x'.repeat(493)}`;
const manyMatches = () => new Map([
  ['a.md', Array.from({ length: 150 }, (_, i) => `needle line ${i}`).join('\n')],
  ['dir/b.md', [...Array.from({ length: 99 }, (_, i) => `needle b ${i}`), longLine].join('\n')],
]);

describe('fs grep limits match their descriptions', () => {
  test('v1: default 50, max 200, 300-character lines, descriptions unchanged', async () => {
    const arm = new FsArm('fs', new FileStore(manyMatches()));
    expect(arm.limits).toBe('v1');
    const grep = arm.tools().find(t => t.name === 'grep')!;
    expect(grep.description).toBe(V1_GREP_DESCRIPTION);
    expect((grep.input_schema.properties as Record<string, { description?: string }>).max_results.description).toBe(`Default ${GREP_LIMITS.v1.defaultResults}.`);
    expect(new FsArm('fs', new FileStore(manyMatches()), { limits: 'v1' }).tools()).toEqual(arm.tools());
    const byDefault = (await arm.call('grep', { pattern: 'needle' })).split('\n');
    expect(byDefault.length).toBe(GREP_LIMITS.v1.defaultResults! + 1);
    expect(byDefault.at(-1)).toBe('[200 more matches not shown]');
    const capped = (await arm.call('grep', { pattern: 'needle', max_results: 1000 })).split('\n');
    expect(capped.length).toBe(GREP_LIMITS.v1.maxResults! + 1);
    expect(capped.at(-1)).toBe('[50 more matches not shown]');
    const long = (await arm.call('grep', { pattern: 'needle x', path: 'dir' })).split('\n')[0];
    expect(long).toBe(`dir/b.md:100: ${longLine.slice(0, GREP_LIMITS.v1.lineChars!)}…`);
  });

  test('hard: every match, full lines, total; max_results caps what is shown, not the total', async () => {
    const arm = new FsArm('fs', new FileStore(manyMatches()), { limits: 'hard' });
    const grep = arm.tools().find(t => t.name === 'grep')!;
    expect(grep).toEqual(HARD_GREP_TOOL);
    expect(grep.description).toContain('every matching line in full');
    expect(grep.description).toContain('[N matches]');
    expect(grep.description).toContain('[N matches; showing the first K]');
    expect(arm.tools().filter(t => t.name !== 'grep')).toEqual(new FsArm('fs', new FileStore(new Map())).tools().filter(t => t.name !== 'grep'));
    const all = (await arm.call('grep', { pattern: 'needle' })).split('\n');
    expect(all.length).toBe(251);
    expect(all.at(-1)).toBe('[250 matches]');
    expect(all).toContain(`dir/b.md:100: ${longLine}`);
    const capped = (await arm.call('grep', { pattern: 'needle', max_results: 10 })).split('\n');
    expect(capped.length).toBe(11);
    expect(capped.at(-1)).toBe('[250 matches; showing the first 10]');
    expect(await arm.call('grep', { pattern: 'absent' })).toBe('No matches.\n[0 matches]');
    expect(await arm.call('grep', { pattern: '(' })).toStartWith('Invalid regular expression');
  });

  test('hard grep sees the run overlay (writes and deletions) and the scope, and agrees with v1 totals on the ladder world', async () => {
    const files = new Map(world.docs.map(d => [`${d.id}.md`, `${d.title}\n${d.body}`]));
    const hard = new FsArm('fs', new FileStore(files), { limits: 'hard' });
    const v1 = new FsArm('fs', new FileStore(files));
    for (const pattern of ['renewal', 'billing contact', 'invoice']) {
      const v = await v1.call('grep', { pattern, max_results: 200 });
      const vTotal = v.split('\n').filter(l => /^[^[].*:\d+: /.test(l)).length + Number(v.match(/\[(\d+) more matches not shown\]$/)?.[1] ?? 0);
      expect((await hard.call('grep', { pattern })).split('\n').at(-1)).toBe(`[${vTotal} matches]`);
    }
    const mem = new MemoryArm(hard.store);
    await hard.call('write_file', { path: 'notes/new.md', content: 'zebracorn sighting' });
    expect(await hard.call('grep', { pattern: 'zebracorn' })).toBe('notes/new.md:1: zebracorn sighting\n[1 matches]');
    await mem.call('memory', { command: 'delete', path: '/memories/notes/new.md' });
    expect(await hard.call('grep', { pattern: 'zebracorn' })).toBe('No matches.\n[0 matches]');
    const first = world.docs[0].id;
    const scoped = (await hard.call('grep', { pattern: '.', path: `${first}.md` })).split('\n');
    expect(scoped.slice(0, -1).every(l => l.startsWith(`${first}.md:`))).toBe(true);
    expect(grepWorkerFor(files).spawned).toBe(1);
  });

  test('hard grep runs in a worker: a catastrophic pattern times out as agent text, the main thread keeps running, the next call works', async () => {
    const files = new Map([['slow.md', `${'a'.repeat(40)}b`], ['ok.md', 'fine line']]);
    const arm = new FsArm('fs', new FileStore(files), { limits: 'hard', grepTimeoutMs: 400 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const t0 = Date.now();
    const out = await arm.call('grep', { pattern: '(a+)+$' });
    clearInterval(timer);
    expect(out).toBe(grepTimeoutMessage(400));
    expect(out).toBe('Error: grep timed out after 0.4 s; use a simpler pattern or a narrower path');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ticks).toBeGreaterThan(5);
    expect(await arm.call('grep', { pattern: 'fine' })).toBe('ok.md:1: fine line\n[1 matches]');
    expect(grepWorkerFor(files).spawned).toBe(2);
  });
});

// ─── pg ─────────────────────────────────────────────────────────────

/** Deterministic set of hashed words (presence, not counts), cut at the real embedder's input limit. */
const hashed = (text: string) => {
  const v = new Array(PG_EMBED_DIMS).fill(0);
  v[0] = 0.01;
  for (const w of text.slice(0, PG_EMBED_INPUT_CHARS).toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[1 + (h % (PG_EMBED_DIMS - 1))] = 1;
  }
  return v;
};
const fakeEmbedder: Embedder = async texts => texts.map(hashed);
const doc = (id: string, body: string, title = id): LadderDoc => ({ id, title, type: 'email', date: '2026-01-01', author: 'Test Author', body });

/** A fake OpenAI embeddings endpoint: hashed vectors, usage of one token per 4 characters. */
function fakeOpenAI(opts: { status?: number } = {}) {
  const calls: string[][] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    calls.push(body.input);
    if (opts.status) return new Response('{"error":{"message":"boom"}}', { status: opts.status });
    const tokens = body.input.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
    return Response.json({ data: body.input.map((t, index) => ({ index, embedding: hashed(t) })), usage: { prompt_tokens: tokens, total_tokens: tokens } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, tokens: (inputs: string[]) => inputs.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
}

describe('pg Hard limits match their descriptions', () => {
  const docs = Array.from({ length: 30 }, (_, i) => doc(`emails/e${String(i).padStart(2, '0')}`, `Quarterly renewal note number ${i} about pricing.`));
  let store: PgStore;
  test('v1: limit default 10, max 25, descriptions unchanged; hard: offset paging up to 100 with total and exhaustion', async () => {
    store = await PgStore.build({ docs: [...docs, doc('emails/other', 'Unrelated lunch plans.')] }, fakeEmbedder);
    const v1 = new PgArm(store, 'run-v1');
    const kw = v1.tools().find(t => t.name === 'keyword_search')!;
    expect(kw.description).toBe('Full-text keyword search (Postgres websearch syntax). Returns id, title and a snippet per document.');
    expect((kw.input_schema.properties as Record<string, { description: string }>).limit.description).toBe(`Default ${PG_SEARCH_LIMITS.v1.defaultLimit}, max ${PG_SEARCH_LIMITS.v1.maxLimit}.`);
    expect((await v1.call('keyword_search', { query: 'renewal' })).match(/^\d+\. id:/gm)!.length).toBe(10);
    expect((await v1.call('keyword_search', { query: 'renewal', limit: 500 })).match(/^\d+\. id:/gm)!.length).toBe(25);
    expect((await v1.call('vector_search', { query: 'renewal', limit: 500 })).match(/^\d+\. id:/gm)!.length).toBe(25);

    const hard = new PgArm(store, 'run-hard', { limits: 'hard' });
    for (const name of ['keyword_search', 'vector_search']) {
      const t = hard.tools().find(x => x.name === name)!;
      expect(t.description).toContain('total: N; showing A-B; exhausted: true|false');
      expect(t.description).toContain(`max ${PG_SEARCH_LIMITS.hard.maxLimit}`);
      expect(Object.keys(t.input_schema.properties as object)).toEqual(['query', 'limit', 'offset']);
    }
    expect(hard.tools().slice(2)).toEqual(v1.tools().slice(2));
    const first = await hard.call('keyword_search', { query: 'renewal' });
    expect(first.split('\n')[0]).toBe('total: 30; showing 1-10; exhausted: false; next offset: 10');
    expect(first.match(/^\d+\. id:/gm)!.length).toBe(10);
    const second = await hard.call('keyword_search', { query: 'renewal', offset: 10, limit: 10 });
    expect(second.split('\n')[0]).toBe('total: 30; showing 11-20; exhausted: false; next offset: 20');
    expect(second).toContain('11. id:');
    const ids = (s: string) => [...s.matchAll(/id: (\S+)/g)].map(m => m[1]);
    expect(ids(first).filter(x => ids(second).includes(x))).toEqual([]);
    const rest = await hard.call('keyword_search', { query: 'renewal', offset: 20, limit: 500 });
    expect(rest.split('\n')[0]).toBe('total: 30; showing 21-30; exhausted: true');
    expect(await hard.call('keyword_search', { query: 'renewal', offset: 40 })).toBe('total: 30; showing none (offset 40 is past the last result); exhausted: true');
    expect(await hard.call('keyword_search', { query: 'nonexistentword' })).toBe('No results.\ntotal: 0; exhausted: true');
    const big = await hard.call('vector_search', { query: 'renewal', limit: 500 });
    expect(big.split('\n')[0]).toBe('total: 31; showing 1-31; exhausted: true');
    await hard.call('save_document', { id: 'notes/mine', content: 'my note' });
    expect((await hard.call('vector_search', { query: 'x', limit: 1 })).split('\n')[0]).toBe('total: 32; showing 1-1; exhausted: false; next offset: 1');
    expect((await v1.call('vector_search', { query: 'x' })).includes('notes/mine')).toBe(false);
    const hardManyDocs = Array.from({ length: 120 }, (_, i) => doc(`emails/m${i}`, 'renewal'));
    const s2 = await PgStore.build({ docs: hardManyDocs }, fakeEmbedder);
    expect((await new PgArm(s2, 'r', { limits: 'hard' }).call('keyword_search', { query: 'renewal', limit: 500 })).split('\n')[0]).toBe('total: 120; showing 1-100; exhausted: false; next offset: 100');
  }, 60_000);
});

describe('pg chunked embeddings on Hard', () => {
  test('chunks stay under the embed cut, overlap, and keep every short line whole in some chunk', () => {
    const lines = Array.from({ length: 900 }, (_, i) => `line ${i} ${'w'.repeat(i % 120)}`);
    const text = lines.join('\n');
    const chunks = chunkDocument(text);
    expect(PG_CHUNKING_ID).toBe(`chunks-v1:${PG_CHUNK_CHARS}:${PG_CHUNK_OVERLAP}`);
    expect(chunks.length).toBeGreaterThan(text.length / PG_CHUNK_CHARS);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(PG_CHUNK_CHARS);
    expect(chunks[0].startsWith('line 0 ')).toBe(true);
    expect(chunks.at(-1)!.endsWith(lines.at(-1)!)).toBe(true);
    for (const l of lines) expect(chunks.some(c => c.split('\n').includes(l))).toBe(true);
    expect(chunkDocument('short')).toEqual(['short']);
  });

  const filler = Array.from({ length: 700 }, (_, i) => `Routine meeting chatter line ${i} about agenda items and coffee.`).join('\n');
  const deciding = 'Decision: the zephyrine quokka contract renews on March 3.';
  const long = doc('meetings/long', `${filler}\n${deciding}\nClosing remarks.`, 'Weekly sync');
  const decoy = doc('emails/decoy', 'A short note mentioning the quokka mascot.', 'Mascot note');
  const others = Array.from({ length: 5 }, (_, i) => doc(`emails/o${i}`, `Other note ${i} about invoices.`));

  test('a deciding line past character 24,000 is found by vector_search on Hard, not with whole-document embeddings', async () => {
    expect(`---\n`.length + long.body.indexOf(deciding)).toBeGreaterThan(PG_EMBED_INPUT_CHARS);
    const corpus = { docs: [long, decoy, ...others] };
    const query = 'zephyrine quokka contract renews';
    const hardStore = await PgStore.build(corpus, fakeEmbedder, { chunking: 'hard' });
    expect(hardStore.chunking).toBe('hard');
    const hard = new PgArm(hardStore, 'run', { limits: 'hard' });
    const hit = await hard.call('vector_search', { query, limit: 3 });
    expect(hit.split('\n')[0]).toBe('total: 7; showing 1-3; exhausted: false; next offset: 3');
    expect(hit.split('\n')[1]).toBe('1. id: meetings/long');
    const whole = new PgArm(await PgStore.build(corpus, fakeEmbedder), 'run', { limits: 'hard' });
    expect((await whole.call('vector_search', { query, limit: 3 })).split('\n')[1]).not.toBe('1. id: meetings/long');
    const full = await hard.call('get_document', { id: 'meetings/long' });
    expect(full.length).toBeGreaterThan(PG_EMBED_INPUT_CHARS);
    expect(full).toContain(deciding);
    expect((await hard.call('keyword_search', { query: 'zephyrine' })).split('\n')[1]).toBe('1. id: meetings/long');
    await hard.call('save_document', { id: 'notes/long-note', title: 'My long note', content: `${filler}\nNote: the xylophonic narwhal deal closed.` });
    expect((await hard.call('vector_search', { query: 'xylophonic narwhal deal', limit: 1 })).split('\n')[1]).toBe('1. id: notes/long-note');
    expect((await new PgArm(hardStore, 'other-run', { limits: 'hard' }).call('vector_search', { query: 'xylophonic narwhal deal', limit: 1 })).includes('notes/long-note')).toBe(false);
  }, 60_000);

  test('chunk embeddings have their own cache keys; cost goes to setup or to the arm, cache hits are free', async () => {
    const cache = join(tmp, 'embed-cache.json');
    const api = fakeOpenAI();
    const embed = cachedOpenAIEmbedder(cache, api.fetchImpl);
    const corpus = { docs: [decoy, ...others] };
    const wholeStore = await PgStore.build(corpus, embed);
    const wholeInputs = api.calls.flat();
    expect(wholeStore.setupEmbedUsd).toBeCloseTo(api.tokens(wholeInputs) * 0.13 / 1e6, 12);
    expect(wholeStore.setupEmbed.requests).toBe(1);
    api.calls.length = 0;
    const hardStore = await PgStore.build(corpus, embed, { chunking: 'hard' });
    expect(api.calls.flat().sort()).toEqual(wholeInputs.sort());
    expect(hardStore.setupEmbedUsd).toBeGreaterThan(0);
    api.calls.length = 0;
    const again = await PgStore.build(corpus, cachedOpenAIEmbedder(cache, api.fetchImpl), { chunking: 'hard' });
    expect(api.calls.length).toBe(0);
    expect(again.setupEmbedUsd).toBe(0);
    expect(existsSync(cache.replace(/\.json$/, '.jsonl'))).toBe(true);

    const arm = new PgArm(hardStore, 'cell-1|attempt-1', { limits: 'hard' });
    await arm.call('vector_search', { query: 'quokka mascot please' });
    expect(arm.embedUsd).toBeCloseTo(api.tokens(['quokka mascot please']) * 0.13 / 1e6, 12);
    await arm.call('vector_search', { query: 'quokka mascot please' });
    expect(arm.embedUsage.requests).toBe(1);
    await arm.call('save_document', { id: 'notes/n', content: 'a fresh note' });
    expect(arm.embedUsage.requests).toBe(2);
    const session = arm.takeEmbedUsage();
    expect(session.requests).toBe(2);
    expect(session.tokens).toBe(api.tokens(['quokka mascot please']) + api.tokens(['a fresh note']));
    expect(arm.embedUsd).toBe(0);
    expect(hardStore.setupEmbed.requests).toBe(1);
  }, 60_000);

  test('an embedding API failure during a cell is a HarnessError and is still charged', async () => {
    const store = await PgStore.build({ docs: others }, fakeEmbedder);
    const api = fakeOpenAI({ status: 500 });
    const arm = new PgArm(Object.assign(Object.create(Object.getPrototypeOf(store)), store, { embed: cachedOpenAIEmbedder(join(tmp, 'fail-cache.json'), api.fetchImpl) }), 'r', { limits: 'hard' });
    await expect(arm.call('vector_search', { query: 'anything' })).rejects.toBeInstanceOf(HarnessError);
    expect(arm.embedUsage.requests).toBe(1);
    expect(arm.embedUsage.unpriced).toBe(1);
  }, 60_000);
});

// ─── Slot quarantine ────────────────────────────────────────────────

class FakeSlot implements PoolSlot {
  restores = 0;
  constructor(readonly id: string, public fail: 'restore' | 'health' | null = null) {}
  async restore() { this.restores++; await Bun.sleep(5); if (this.fail === 'restore') throw new Error('tar: snapshot unreadable'); }
  async healthCheck() { return this.fail === 'health' ? 'MCP server lists no tools' : null; }
}

describe('gbrain slot quarantine', () => {
  test('a failed restore never reaches a waiting cell; the waiter gets the next healthy slot', async () => {
    const [a, b] = [new FakeSlot('slot0', 'restore'), new FakeSlot('slot1')];
    const pool = new GbrainPool<FakeSlot>([a, b]);
    expect(await pool.acquire()).toBe(a);
    expect(await pool.acquire()).toBe(b);
    let got: FakeSlot | null = null;
    const waiter = pool.acquire().then(s => { got = s; return s; });
    expect(await pool.restoreOrQuarantine(a)).toBe('restore failed: tar: snapshot unreadable');
    await Bun.sleep(10);
    expect(got).toBeNull();
    expect(pool.healthy).toBe(1);
    expect([...pool.quarantined.keys()]).toEqual(['slot0']);
    pool.release(a);
    await Bun.sleep(10);
    expect(got).toBeNull();
    expect(await pool.restoreOrQuarantine(b)).toBeNull();
    expect(await waiter).toBe(b);
    pool.release(b);
    expect(await pool.acquire()).toBe(b);
  });

  test('waiters are rejected with SlotQuarantineError once fewer than the minimum healthy slots remain', async () => {
    const slots = [new FakeSlot('slot0'), new FakeSlot('slot1', 'health'), new FakeSlot('slot2')];
    const pool = new GbrainPool<FakeSlot>(slots, { minHealthy: 3 });
    for (const s of slots) expect(await pool.acquire()).toBe(s);
    const waiter = pool.acquire();
    expect(await pool.restoreOrQuarantine(slots[1])).toBe('MCP server lists no tools');
    expect(pool.healthy).toBe(2);
    await expect(waiter).rejects.toBeInstanceOf(SlotQuarantineError);
    await expect(waiter).rejects.toThrow('2 healthy gbrain slots of 3, the step needs 3; quarantined: slot1: MCP server lists no tools');
    expect(await pool.restoreOrQuarantine(slots[0])).toBeNull();
    await expect(pool.acquire()).rejects.toBeInstanceOf(SlotQuarantineError);
  });

  test('with the default minimum of one, the pool keeps serving until every slot is quarantined', async () => {
    const [a, b] = [new FakeSlot('slot0', 'restore'), new FakeSlot('slot1', 'restore')];
    const pool = new GbrainPool<FakeSlot>([a, b]);
    await pool.acquire(); await pool.acquire();
    const waiter = pool.acquire();
    await pool.restoreOrQuarantine(a);
    expect(pool.shortfall()).toBeNull();
    await pool.restoreOrQuarantine(b);
    await expect(waiter).rejects.toBeInstanceOf(SlotQuarantineError);
  });
});

// ─── MCP transport and asynchronous restore (fake server) ───────────

const FAKE_SERVER = `
let buf = '';
const send = o => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdout.write('fake gbrain booting (not JSON-RPC)\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { instructions: 'fake brain', serverInfo: { version: '0.0.0' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: process.env.FAKE_NO_TOOLS ? [] : [{ name: 'echo' }, { name: 'die' }] } });
    else if (m.method === 'tools/call') {
      const n = m.params.name;
      if (n === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo ' + JSON.stringify(m.params.arguments) }] } });
      else if (n === 'tool_error') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'bad slug' }], isError: true } });
      else if (n === 'rpc_error') send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } });
      else if (n === 'malformed') send({ jsonrpc: '2.0', id: m.id });
      else if (n === 'die') { console.error('fatal: out of memory'); process.exit(3); }
    }
  }
});
`;
const buildDir = join(tmp, 'fake-build');
mkdirSync(join(buildDir, 'src'), { recursive: true });
writeFileSync(join(buildDir, 'src/cli.ts'), FAKE_SERVER);
const fakeRun = (extra: Record<string, string> = {}) => {
  const home = join(tmp, `home-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  return { buildDir, env: { PATH: process.env.PATH, GBRAIN_HOME: home, ...extra } };
};

describe('MCP transport failures are HarnessErrors; tool errors stay text', () => {
  test('isError and JSON-RPC errors are text; exit, closed pipe, malformed response and timeout throw HarnessError', async () => {
    const c = new McpClient(fakeRun(), ['--surface', 'starter']);
    await c.start();
    expect(c.instructions).toBe('fake brain');
    expect(c.tools.map(t => t.name)).toEqual(['echo', 'die']);
    expect(await c.call('echo', { a: 1 })).toBe('echo {"a":1}');
    expect(await c.call('tool_error', {})).toBe('Error: bad slug');
    expect(await c.call('rpc_error', {})).toBe('Error: {"code":-32602,"message":"unknown tool"}');
    await expect(c.call('malformed', {})).rejects.toBeInstanceOf(HarnessError);
    c.callTimeoutMs = 300;
    const hang = c.call('hang', {});
    await expect(hang).rejects.toBeInstanceOf(HarnessError);
    await expect(hang).rejects.toThrow('MCP timeout: tools/call');
    c.callTimeoutMs = 300_000;
    const died = c.call('die', {});
    await expect(died).rejects.toBeInstanceOf(HarnessError);
    await expect(died).rejects.toThrow(/MCP server exited \(exit 3\).*out of memory/);
    expect(c.alive).toBe(false);
    await expect(c.call('echo', {})).rejects.toBeInstanceOf(HarnessError);
    await c.close();
    await expect(c.call('echo', {})).rejects.toThrow('MCP transport closed');
  });
  test('a server that cannot start is a HarnessError', async () => {
    const c = new McpClient({ buildDir: join(tmp, 'no-such-build'), env: fakeRun().env }, []);
    await expect(c.start()).rejects.toBeInstanceOf(HarnessError);
  });
});

describe('GbrainSlot.restore (asynchronous) and health check', () => {
  const root = join(tmp, 'slots');
  const slotFixture = (id: string) => {
    const dir = join(root, id);
    const vault = join(dir, 'vault');
    for (const d of ['vault', 'home', 'uh']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(vault, 'a.md'), 'corpus a\n');
    const git = (args: string[]) => execFileSync('git', ['-C', vault, '-c', 'user.name=cat40', '-c', 'user.email=cat40@example.invalid', ...args], { stdio: 'pipe' });
    git(['init', '-q']); git(['add', '-A']); git(['commit', '-q', '-m', 'corpus']); git(['tag', 'cat40-corpus']);
    writeFileSync(join(dir, 'home', 'brain.txt'), 'snapshot');
    execFileSync('tar', ['-C', dir, '-cf', `${dir}.tar`, 'home']);
    return { dir, vault };
  };

  test('resets the vault, keeps the ownership marker, replaces home from the snapshot, starts a healthy server', async () => {
    const { dir, vault } = slotFixture('slot0');
    writeFileSync(join(vault, 'a.md'), 'agent edit\n');
    writeFileSync(join(vault, 'b.md'), 'agent note\n');
    writeFileSync(join(vault, '.gbrain-owner.json'), '{}');
    writeFileSync(join(dir, 'home', 'brain.txt'), 'dirty');
    writeFileSync(join(dir, 'home', 'extra.txt'), 'x');
    const slot = new GbrainSlot('slot0', root, buildDir, 1, 'starter');
    expect(await slot.healthCheck()).toBe('MCP client not started');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await slot.restore();
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    expect(readFileSync(join(vault, 'a.md'), 'utf8')).toBe('corpus a\n');
    expect(existsSync(join(vault, 'b.md'))).toBe(false);
    expect(existsSync(join(vault, '.gbrain-owner.json'))).toBe(true);
    expect(readFileSync(join(dir, 'home', 'brain.txt'), 'utf8')).toBe('snapshot');
    expect(existsSync(join(dir, 'home', 'extra.txt'))).toBe(false);
    expect(await slot.healthCheck()).toBeNull();
    await slot.client!.call('die', {}).catch(() => {});
    expect(await slot.healthCheck()).toBe('MCP server not running');
    await slot.stop();
  });

  test('a restore whose snapshot is missing throws HarnessError and the pool quarantines the slot', async () => {
    const { dir } = slotFixture('slot1');
    rmSync(`${dir}.tar`);
    const slot = new GbrainSlot('slot1', root, buildDir, 1, 'starter');
    await expect(slot.restore()).rejects.toBeInstanceOf(HarnessError);
    const pool = new GbrainPool([slot]);
    await pool.acquire();
    expect(await pool.restoreOrQuarantine(slot)).toMatch(/^restore failed: gbrain slot1 restore: /);
    expect(pool.healthy).toBe(0);
    await expect(pool.acquire()).rejects.toBeInstanceOf(SlotQuarantineError);
  });
});
