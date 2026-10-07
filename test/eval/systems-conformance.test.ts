/**
 * Protocol v1 conformance (eval/systems/PROTOCOL.md). Keyless: drives the
 * TypeScript fake in process, the TypeScript fake over HTTP, and the Python
 * reference shim (eval/systems/_fake/fake.py, stdlib only). With SHIM_URL set
 * it also drives that running shim:
 *
 *   SHIM_URL=http://127.0.0.1:8700 bun test test/eval/systems-conformance.test.ts
 *
 * Covered: capability record, health, reset, two dated sessions, finish,
 * retrieve with query time and policy, namespace isolation canary, delete,
 * error shapes, and the harness's rejection of foreign source ids.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FakeMemorySystem, serveProtocol } from '../../eval/runner/systems/fake.ts';
import { FullContextSystem, NoMemorySystem, PlainHybridSystem } from '../../eval/runner/systems/baselines.ts';
import { PG_EMBED_DIMS } from '../../eval/runner/cat40/pg-arm.ts';
import { hashEmbed } from '../../eval/runner/memory-qa/run.ts';
import { HttpMemorySystem } from '../../eval/runner/systems/http.ts';
import { validateSources } from '../../eval/runner/systems/render.ts';
import { opaqueNamespace, opaqueSourceId, SanitizerLeakError } from '../../eval/runner/systems/sanitize.ts';
import { ERROR_KINDS, passiveUnsupported, SystemError, type MemorySystem, type RetrievalPolicy, type SessionInput } from '../../eval/runner/systems/types.ts';

const ROOT = resolve(import.meta.dir, '../..');
const NS_A = opaqueNamespace('conformance', 'alpha'), NS_B = opaqueNamespace('conformance', 'beta');
const S1 = opaqueSourceId('alpha', 's1'), S2 = opaqueSourceId('alpha', 's2'), S3 = opaqueSourceId('beta', 's1');
const CANARY = 'zephyrquokka';
const session = (source_id: string, user: string): SessionInput => ({ source_id, turns: [{ role: 'user', speaker: 'user', content: user }, { role: 'assistant', speaker: 'assistant', content: 'Noted, thanks.' }] });
const POLICY: RetrievalPolicy = { name: 'conformance:vendor-default', mode: 'vendor-default', settings: {} };

const ts = serveProtocol(new FakeMemorySystem());

/** A system with no passive memory API, shaped like the agent runtime's record: native agent, every policy unsupported. */
class NativeAgentOnly implements MemorySystem {
  readonly name = 'native-agent-only';
  private no = (): never => { throw new SystemError('unsupported', 'no passive memory API', 501); };
  async capabilities() { return { ...(await new FakeMemorySystem().capabilities()), system: 'native-agent-only', agent_surface: { kind: 'native-agent' as const }, delete: 'unsupported' as const, retrieval_policies: { 'vendor-default': { supported: false }, 'fixed-evidence': { supported: false } } }; }
  async reset() { return this.no(); }
  async ingestSession(): Promise<never> { return this.no(); }
  async finishIngest(): Promise<never> { return this.no(); }
  async retrieve(_ns: string, _q: unknown, p: RetrievalPolicy): Promise<never> { if (p?.mode !== 'vendor-default' && p?.mode !== 'fixed-evidence') throw new SystemError('invalid_request', 'policy.mode must be vendor-default or fixed-evidence', 400); return this.no(); }
  async deleteSource() { return { status: 'unsupported' as const, receipt: {} }; }
}
const agentOnly = serveProtocol(new NativeAgentOnly());
let py: { proc: ReturnType<typeof Bun.spawn>; url: string } | null = null;
let pyError: string | null = null;

beforeAll(async () => {
  for (let attempt = 0; attempt < 3 && !py; attempt++) {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = probe.port as number;
    probe.stop(true);
    const proc = Bun.spawn(['python3', 'eval/systems/_fake/fake.py'], { cwd: ROOT, env: { ...process.env, SHIM_PORT: String(port) }, stdout: 'ignore', stderr: 'pipe' });
    for (let i = 0; i < 200 && proc.exitCode === null; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`, { keepalive: false })).ok) { py = { proc, url: `http://127.0.0.1:${port}` }; break; } } catch { await Bun.sleep(50); }
    }
    if (!py) { proc.kill(); pyError = `python fake shim did not start: ${(await new Response(proc.stderr).text()).slice(-300)}`; }
  }
}, 30_000);
afterAll(() => { ts.stop(); agentOnly.stop(); py?.proc.kill(); });

type Target = { name: string; system: () => MemorySystem; url?: () => string };
const targets: Target[] = [
  { name: 'TypeScript fake (in process)', system: () => new FakeMemorySystem() },
  { name: 'full-context control', system: () => new FullContextSystem() },
  { name: 'plain-hybrid control (hash vectors)', system: () => new PlainHybridSystem(async texts => texts.map(t => hashEmbed(t, PG_EMBED_DIMS)), 'hash') },
  { name: 'TypeScript fake (HTTP)', system: () => new HttpMemorySystem(ts.url), url: () => ts.url },
  { name: 'native agent without a passive API (HTTP)', system: () => new HttpMemorySystem(agentOnly.url), url: () => agentOnly.url },
  { name: 'Python reference shim (HTTP)', system: () => { if (!py) throw new Error(pyError ?? 'python shim missing'); return new HttpMemorySystem(py.url); }, url: () => py!.url },
  ...(process.env.SHIM_URL ? [{ name: `live shim ${process.env.SHIM_URL}`, system: () => new HttpMemorySystem(process.env.SHIM_URL!, { timeoutMs: 900_000 }), url: () => process.env.SHIM_URL! }] : []),
];

for (const t of targets) {
  describe(`conformance: ${t.name}`, () => {
    test('capabilities, reset, two dated sessions, finish, retrieve, isolation and delete', async () => {
      const sys = t.system();
      const cap = await sys.capabilities();
      expect(cap.protocol).toBe(1);
      expect(typeof cap.system).toBe('string');
      for (const k of ['time', 'provenance', 'delete', 'readiness', 'namespace', 'parallel_namespaces', 'retrieval_policies', 'streaming', 'agent_surface']) expect(cap).toHaveProperty(k);
      expect(['native', 'in-text', 'none']).toContain(cap.time);
      if (passiveUnsupported(cap)) {
        const unsupported = async (p: Promise<unknown>) => { const e = await p.then(() => null, x => x); expect(e).toBeInstanceOf(SystemError); expect((e as SystemError).kind).toBe('unsupported'); };
        await unsupported(sys.reset(NS_A));
        await unsupported(sys.ingestSession(NS_A, session(S1, 'kitten'), '2023-05-08T13:56:00'));
        await unsupported(sys.finishIngest(NS_A, 10));
        await unsupported(sys.retrieve(NS_A, { text: 'kitten', query_time: null }, POLICY));
        const del = await sys.deleteSource(NS_A, S1).then(r => r.status, e => (e as SystemError).kind);
        expect(del).toBe('unsupported');
        return;
      }
      await sys.reset(NS_A); await sys.reset(NS_B);
      const r1 = await sys.ingestSession(NS_A, session(S1, 'I adopted a gray tabby kitten named Pebble from the shelter.'), '2023-05-08T13:56:00');
      const r2 = await sys.ingestSession(NS_A, session(S2, 'Pebble needed a rabies vaccine and the vet visit cost 85 dollars.'), '2023-06-02T09:10:00');
      await sys.ingestSession(NS_B, session(S3, `My secret code word is ${CANARY} and I keep it in a notebook.`), '2023-05-09T10:00:00');
      for (const r of [r1, r2]) { expect(['known', 'unknown', 'degraded']).toContain(r.completeness); expect(Array.isArray(r.errors)).toBe(true); }
      const fin = await sys.finishIngest(NS_A, 120);
      expect(fin.ready).toBe(true);
      expect(['known', 'unknown', 'degraded']).toContain(fin.completeness);
      await sys.finishIngest(NS_B, 120);

      const res = await sys.retrieve(NS_A, { text: 'How much did the vet visit for Pebble cost?', query_time: '2023-07-01T00:00:00' }, POLICY);
      expect(res.items.length).toBeGreaterThan(0);
      expect(() => validateSources(res.items, new Set([S1, S2]))).not.toThrow();
      expect(res.items.flatMap(i => i.source_ids)).toContain(S2);

      const leak = await sys.retrieve(NS_A, { text: `What is the secret code word ${CANARY}?`, query_time: null }, POLICY);
      expect(leak.items.some(i => i.text.includes(CANARY) || i.source_ids.includes(S3))).toBe(false);
      const own = await sys.retrieve(NS_B, { text: `secret code word ${CANARY}`, query_time: null }, POLICY);
      expect(own.items.flatMap(i => i.source_ids)).toContain(S3);

      const del = await sys.deleteSource(NS_A, S1);
      expect(['deleted', 'partial', 'unsupported']).toContain(del.status);
      if (cap.delete === 'unsupported') expect(del.status).toBe('unsupported');
      else expect(del.status).not.toBe('unsupported');
      if (del.status === 'deleted') {
        await sys.finishIngest(NS_A, 120);
        const after = await sys.retrieve(NS_A, { text: 'gray tabby kitten adopted shelter', query_time: null }, POLICY);
        expect(after.items.flatMap(i => i.source_ids)).not.toContain(S1);
      }
      await sys.reset(NS_A);
      const empty = await sys.retrieve(NS_A, { text: 'vet visit Pebble rabies', query_time: null }, POLICY);
      expect(empty.items).toEqual([]);
      await sys.reset(NS_B);
    }, 900_000);

    test('error shapes', async () => {
      const sys = t.system();
      await expect(sys.retrieve(NS_A, { text: 'x', query_time: null }, { name: 'bad', mode: 'nonsense' as never, settings: {} })).rejects.toBeInstanceOf(SystemError);
      if (!t.url) return;
      const base = t.url();
      const raw = (path: string, body: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body, keepalive: false });
      const post = (path: string, body: unknown) => raw(path, JSON.stringify(body));
      for (const [path, body, status] of [['/retrieve', { ns: NS_A }, 400], ['/nowhere', {}, 404], ['/ingest', { ns: NS_A, session: { source_id: 'raw-session-1', event_time: null, turns: [] } }, 400]] as const) {
        const res = await post(path, body);
        expect(res.status).toBe(status);
        const json = await res.json() as { error: { kind: string; message: string }; service_ms: number };
        expect(json.error.kind).toBe('invalid_request');
        expect(ERROR_KINDS).toContain(json.error.kind as never);
        expect(typeof json.service_ms).toBe('number');
      }
      const notJson = await raw('/reset', '{nope');
      expect(notJson.status).toBe(400);
      expect((await notJson.json()).error.kind).toBe('invalid_request');
    });
  });
}

describe('harness side of the contract', () => {
  test('the no-memory control stores nothing and returns nothing', async () => {
    const sys = new NoMemorySystem();
    await sys.reset(NS_A);
    expect((await sys.ingestSession(NS_A, session(S1, 'kitten Pebble'), null)).items_created).toBe(0);
    expect((await sys.retrieve(NS_A, { text: 'kitten Pebble', query_time: null }, POLICY)).items).toEqual([]);
    await expect(sys.retrieve(NS_A, { text: 'x', query_time: null }, { ...POLICY, mode: 'bad' as never })).rejects.toBeInstanceOf(SystemError);
  });

  test('the full-context control returns the whole namespace most recent first, and plain hybrid fuses keyword and vector ranks', async () => {
    const full = new FullContextSystem();
    await full.reset(NS_A);
    await full.ingestSession(NS_A, session(S1, 'first'), '2023-01-01T00:00:00');
    await full.ingestSession(NS_A, session(S2, 'second'), '2023-02-01T00:00:00');
    expect((await full.retrieve(NS_A, { text: 'anything', query_time: null }, POLICY)).items.map(i => [i.rank, i.source_ids[0], i.valid_from])).toEqual([[1, S2, '2023-02-01T00:00:00'], [2, S1, '2023-01-01T00:00:00']]);
    const hybrid = new PlainHybridSystem(async texts => texts.map(t => hashEmbed(t, PG_EMBED_DIMS)), 'hash');
    try {
      await hybrid.reset(NS_A);
      for (const [i, text] of ['the bakery on Main Street sells sourdough', 'we hiked to the waterfall at dawn', 'my sourdough starter is named Clint'].entries()) await hybrid.ingestSession(NS_A, session(opaqueSourceId('h', String(i)), text), null);
      const res = await hybrid.retrieve(NS_A, { text: 'sourdough starter name', query_time: null }, { ...POLICY, settings: { k: 2 } });
      expect(res.items.map(i => i.source_ids[0])).toEqual([opaqueSourceId('h', '2'), opaqueSourceId('h', '0')]);
      expect(res.applied_settings).toMatchObject({ k: 2, pool: 50, rrf_k: 60 });
    } finally { await hybrid.close(); }
  });

  test('the TypeScript and Python fakes return identical items for identical input', async () => {
    if (!py) throw new Error(pyError ?? 'python shim missing');
    const a = new HttpMemorySystem(ts.url), b = new HttpMemorySystem(py.url);
    const ns = opaqueNamespace('parity', 'x');
    const sessions = [
      session(opaqueSourceId('x', '1'), 'Alpha beta gamma delta, we talked about the garden.'),
      session(opaqueSourceId('x', '2'), 'The garden had tomatoes and beta peppers this year.'),
      session(opaqueSourceId('x', '3'), 'Nothing about plants here, only trains and stations.'),
    ];
    for (const sys of [a, b]) { await sys.reset(ns); for (const [i, s] of sessions.entries()) await sys.ingestSession(ns, s, `2024-01-0${i + 1}T00:00:00`); }
    for (const policy of [POLICY, { ...POLICY, mode: 'fixed-evidence' as const }, { ...POLICY, settings: { k: 1 } }]) {
      const [x, y] = await Promise.all([a.retrieve(ns, { text: 'beta garden tomatoes', query_time: null }, policy), b.retrieve(ns, { text: 'beta garden tomatoes', query_time: null }, policy)]);
      expect(x.items).toEqual(y.items);
      expect(x.applied_settings).toEqual(y.applied_settings);
    }
    expect((await a.capabilities())).toEqual(await b.capabilities());
  });

  test('a shim returning a source id the namespace never ingested is rejected', async () => {
    const rogue = new FakeMemorySystem();
    const original = rogue.retrieve.bind(rogue);
    rogue.retrieve = async (ns, q, p) => { const r = await original(ns, q, p); return { ...r, items: r.items.map(i => ({ ...i, source_ids: [...i.source_ids, opaqueSourceId('other', 'zz')] })) }; };
    const server = serveProtocol(rogue);
    try {
      const sys = new HttpMemorySystem(server.url);
      await sys.reset(NS_A);
      await sys.ingestSession(NS_A, session(S1, 'kitten Pebble shelter'), null);
      const res = await sys.retrieve(NS_A, { text: 'kitten Pebble', query_time: null }, POLICY);
      expect(() => validateSources(res.items, new Set([S1]))).toThrow(/never ingested/);
    } finally { server.stop(); }
  });

  test('long shim calls run under the harness deadline, not the HTTP client\'s default timeout', async () => {
    const inits: RequestInit[] = [];
    const sys = new HttpMemorySystem('http://shim.invalid', { ingestTimeoutMs: 123_000, fetchImpl: async (_u, init) => { inits.push(init!); return Response.json({ ready: true, waited_ms: 1, completeness: 'known', items_created: 1, errors: [], warnings: [] }); } });
    await sys.finishIngest(NS_A, 11_000);
    await sys.ingestSession(NS_A, session(S1, 'x'), null);
    expect(inits.every(i => (i as { timeout?: unknown }).timeout === false && i.signal instanceof AbortSignal)).toBe(true);
    const slow = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch: async () => { await Bun.sleep(1500); return Response.json({ items_created: 1, errors: [], warnings: [], completeness: 'known' }); } });
    try {
      const err = await new HttpMemorySystem(`http://127.0.0.1:${slow.port}`, { ingestTimeoutMs: 200 }).ingestSession(NS_A, session(S1, 'x'), null).then(() => null, e => e);
      expect(err).toBeInstanceOf(SystemError);
      expect((err as SystemError).kind).toBe('timeout');
    } finally { slow.stop(true); }
  });

  test('the client refuses raw ids and forbidden markers before anything is sent', async () => {
    const sent: string[] = [];
    const sys = new HttpMemorySystem(ts.url, { markers: ['conv-26:q007', '_abs'], onRequest: (_p, body) => sent.push(body) });
    await expect(sys.reset('locomo-conv-26')).rejects.toThrow(/not opaque/);
    await expect(sys.ingestSession(NS_A, session('session_3', 'hi'), null)).rejects.toThrow(/not opaque/);
    await expect(sys.retrieve(NS_A, { text: 'what about conv-26:q007', query_time: null }, POLICY)).rejects.toBeInstanceOf(SanitizerLeakError);
    expect(sent).toEqual([]);
  });
});

describe('shared Python shim tooling (eval/systems/_shim)', () => {
  test('protocol_check.py passes against the TypeScript fake and the Python reference shim', async () => {
    if (!py) throw new Error(pyError ?? 'python shim missing');
    for (const url of [ts.url, py.url, agentOnly.url]) {
      const proc = Bun.spawn(['python3', 'eval/systems/_shim/protocol_check.py', '--url', url, '--questions', '3'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code, out).toBe(0);
      expect(out).toMatch(/\n(\d+)\/\1 checks passed/);
    }
  }, 60_000);

  test('fake_provider.py answers every route the vendor shims use and logs no credential', async () => {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = probe.port as number;
    probe.stop(true);
    const log = join(mkdtempSync(join(tmpdir(), 'fake-provider-')), 'log.jsonl');
    const proc = Bun.spawn(['python3', 'eval/systems/_shim/fake_provider.py', '--port', String(port), '--log', log], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
    const base = `http://127.0.0.1:${port}/ext-extract-first/openai/v1`;
    const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer dummy-key', 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: false })).json() as Promise<any>;
    try {
      for (let i = 0; i < 200; i++) { try { await fetch(`${base}/models`, { keepalive: false }); break; } catch { await Bun.sleep(50); } }
      const emb = await post('/embeddings', { model: 'text-embedding-3-large', input: ['alpha beta', 'gamma'], dimensions: 1536 });
      expect(emb.data).toHaveLength(2);
      expect(emb.data[0].embedding).toHaveLength(1536);
      expect((await post('/embeddings', { model: 'text-embedding-3-small', input: 'x' })).data[0].embedding).toHaveLength(1536);
      const lp = await post('/chat/completions', { model: 'gpt-4.1-nano', logprobs: true, top_logprobs: 2, messages: [{ role: 'user', content: '<QUERY>pottery class</QUERY><PASSAGE>a pottery class in Portland</PASSAGE>' }] });
      expect(lp.choices[0].logprobs.content[0].token).toBe('True');
      const js = await post('/chat/completions', { model: 'gpt-4.1-mini', response_format: { type: 'json_schema', json_schema: { name: 'KG', schema: { type: 'object', properties: { nodes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } }, edges: { type: 'array', items: { type: 'object', properties: { source_node_id: { type: 'string' }, target_node_id: { type: 'string' } } } } } } } }, messages: [{ role: 'user', content: 'Caroline met Melanie in Portland.' }] });
      expect(JSON.parse(js.choices[0].message.content).nodes.map((n: any) => n.name)).toEqual(['Caroline', 'Melanie', 'Portland']);
      const m0 = await post('/chat/completions', { model: 'gpt-5-mini', messages: [{ role: 'user', content: '## New Messages\nuser: I adopted a dog named Biscuit\nassistant: Nice\n## Output' }] });
      expect(JSON.parse(m0.choices[0].message.content).memory.map((x: any) => x.text)).toEqual(['I adopted a dog named Biscuit', 'Nice']);
      const resp = await post('/responses', { model: 'gpt-4.1-mini', input: [{ role: 'user', content: '<CURRENT MESSAGES>Caroline hiked with Melanie at Yosemite.</CURRENT MESSAGES>' }], text: { format: { type: 'json_schema', name: 'ExtractedEdges', schema: { type: 'object', properties: { edges: { type: 'array' } } } } } });
      expect(JSON.parse(resp.output[0].content[0].text).edges[0]).toMatchObject({ source_entity_name: 'Caroline', target_entity_name: 'Melanie' });
      const stream = await fetch(`${base}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'gpt-4.1-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] }), keepalive: false });
      expect(stream.headers.get('content-type')).toContain('event-stream');
      expect(await stream.text()).toContain('"usage": {"prompt_tokens"');
      const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(lines.map(l => l.route)).toEqual(['embeddings', 'embeddings', 'chat', 'chat', 'chat', 'responses', 'chat']);
      expect(lines[0]).toMatchObject({ model: 'text-embedding-3-large', dimensions: 1536, auth_is_dummy: true });
      expect(readFileSync(log, 'utf8')).not.toContain('dummy-key');
    } finally { proc.kill(); }
  }, 30_000);
});
