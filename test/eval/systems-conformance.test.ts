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
import { resolve } from 'node:path';
import { FakeMemorySystem, serveProtocol } from '../../eval/runner/systems/fake.ts';
import { HttpMemorySystem } from '../../eval/runner/systems/http.ts';
import { validateSources } from '../../eval/runner/systems/render.ts';
import { opaqueNamespace, opaqueSourceId, SanitizerLeakError } from '../../eval/runner/systems/sanitize.ts';
import { ERROR_KINDS, SystemError, type MemorySystem, type RetrievalPolicy, type SessionInput } from '../../eval/runner/systems/types.ts';

const ROOT = resolve(import.meta.dir, '../..');
const NS_A = opaqueNamespace('conformance', 'alpha'), NS_B = opaqueNamespace('conformance', 'beta');
const S1 = opaqueSourceId('alpha', 's1'), S2 = opaqueSourceId('alpha', 's2'), S3 = opaqueSourceId('beta', 's1');
const CANARY = 'zephyrquokka';
const session = (source_id: string, user: string): SessionInput => ({ source_id, turns: [{ role: 'user', speaker: 'user', content: user }, { role: 'assistant', speaker: 'assistant', content: 'Noted, thanks.' }] });
const POLICY: RetrievalPolicy = { name: 'conformance:vendor-default', mode: 'vendor-default', settings: {} };

const ts = serveProtocol(new FakeMemorySystem());
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
afterAll(() => { ts.stop(); py?.proc.kill(); });

type Target = { name: string; system: () => MemorySystem; url?: () => string };
const targets: Target[] = [
  { name: 'TypeScript fake (in process)', system: () => new FakeMemorySystem() },
  { name: 'TypeScript fake (HTTP)', system: () => new HttpMemorySystem(ts.url), url: () => ts.url },
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

  test('the client refuses raw ids and forbidden markers before anything is sent', async () => {
    const sent: string[] = [];
    const sys = new HttpMemorySystem(ts.url, { markers: ['conv-26:q007', '_abs'], onRequest: (_p, body) => sent.push(body) });
    await expect(sys.reset('locomo-conv-26')).rejects.toThrow(/not opaque/);
    await expect(sys.ingestSession(NS_A, session('session_3', 'hi'), null)).rejects.toThrow(/not opaque/);
    await expect(sys.retrieve(NS_A, { text: 'what about conv-26:q007', query_time: null }, POLICY)).rejects.toBeInstanceOf(SanitizerLeakError);
    expect(sent).toEqual([]);
  });
});
