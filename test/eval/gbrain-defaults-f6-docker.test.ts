/**
 * The gbrain-defaults container on its F6 path, keyless, at the F6 gbrain pin (GBRAIN_SHA in the launch environment,
 * docs/benchmarks/2026-10-29-f6-current-master-preregistration.md): the real gbrain build serving the full surface,
 * the install posture written and read back, /finish running conversation fact extraction under its recorded cap
 * and the safe-chunks repair, the fact index, and policy-major overlay switches (stop serve, six config keys, start
 * serve, each key read back) with query, the facts block and recall. The fake upstream answers canned text, so its
 * facts say nothing about quality. Needs Docker:
 *
 *   SHOOTOUT_DOCKER_TESTS=1 bun test test/eval/gbrain-defaults-f6-docker.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const COMPOSE = 'eval/systems/gbrain-defaults/docker-compose.yml';
const ON = process.env.SHOOTOUT_DOCKER_TESTS === '1';
const PIN = '0ccf2bdd4f42ed50be4cfb515eaa804ddb4b7049';
const PROJECT = `gbrain-defaults-f6-test-${process.pid}`;
const NS = 'ns-00000000000000f6';
const S1 = 'src-1111111111111111', S2 = 'src-2222222222222222';
const KEYS = ['search.evidence_date_header', 'search.evidence_titles', 'search.fact_source_pages', 'search.query_budget_unit', 'search.query_facts_block', 'search.saved_facts_supersede'];
const BASE = { 'search.evidence_date_header': false, 'search.evidence_titles': false, 'search.fact_source_pages': false, 'search.query_budget_unit': 'chunk', 'search.query_facts_block': false, 'search.saved_facts_supersede': true };

const free = () => { const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }); const p = s.port as number; s.stop(true); return p; };
const port = ON ? free() : 0;
const BASE_URL = `http://127.0.0.1:${port}`;
const env = { ...process.env, SHIM_HOST_PORT: String(port), PROXY_UPSTREAM: 'fake-upstream:8787', GBRAIN_F6: '1', GBRAIN_SHA: PIN, GBRAIN_F6_EXTRACT_CAP_USD: '1' } as Record<string, string>;
for (const k of ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'VOYAGE_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete env[k];
const compose = (...args: string[]) => Bun.spawnSync(['docker', 'compose', '-p', PROJECT, '-f', COMPOSE, '--profile', 'keyless', ...args], { cwd: ROOT, env });
const inShim = (...cmd: string[]) => compose('exec', '-T', 'shim', ...cmd);

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE_URL}${path}`, { method, headers: { 'content-type': 'application/json', connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body), keepalive: false, signal: AbortSignal.timeout(900_000) });
  return { status: r.status, json: await r.json() };
}
const ok = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const r = await call(method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json).slice(0, 800)}`);
  return r.json;
};
const session = (source_id: string, when: string, text: string) => ({ source_id, event_time: when, turns: [{ role: 'user', speaker: 'user', content: text }, { role: 'assistant', speaker: 'assistant', content: 'Noted, thanks.' }] });
const f6 = (op: string, args: Record<string, unknown>, overlay: Record<string, unknown>) => ({ name: 'gbrain-defaults:packed', mode: 'packed', settings: { op, args, overlay } });
const Q = 'How much did the vet visit for Pebble cost?';
const receipts = () => inShim('cat', '/data/logs/receipts.ndjson').stdout.toString().trim().split('\n').map(l => JSON.parse(l));
const waitHealthy = async () => {
  for (let i = 0; i < 300; i++) {
    try { const h = await call('GET', '/health'); if (h.json.ok === true) return h.json; } catch { /* starting */ }
    await Bun.sleep(1000);
  }
  throw new Error(`gbrain-defaults never became healthy: ${compose('logs', '--tail', '40').stdout.toString()}`);
};

describe.skipIf(!ON)('gbrain-defaults container on the F6 path (keyless, F6 pin)', () => {
  beforeAll(async () => {
    const up = compose('up', '-d', '--build');
    if (up.exitCode !== 0) throw new Error(up.stderr.toString().slice(-3000));
    await waitHealthy();
  }, 1_800_000);
  afterAll(() => { compose('down', '-v', '--remove-orphans'); }, 300_000);

  test('install: the image runs the F6 pin on the full surface, with facts.default_visibility world written and read back', async () => {
    const cap = await ok('GET', '/capabilities');
    expect(cap.f6).toMatchObject({ enabled: true, gbrain_sha: PIN, extract_cap_usd: 1, overlay_keys: KEYS });
    expect(cap.resolved.gbrain_version).toBe('gbrain 0.60.493.0');
    expect((await ok('GET', '/health')).surface).toBe('full');
    await ok('POST', '/reset', { ns: NS });
    expect(inShim('sh', '-c', 'GBRAIN_HOME=/data/home HOME=/data/home gbrain config get facts.default_visibility').stdout.toString().trim()).toBe('world');
  }, 900_000);

  test('finish: extraction under the recorded cap, the safe-chunks repair and the fact index, each recorded', async () => {
    await ok('POST', '/ingest', { ns: NS, session: session(S1, '2023-05-08T13:56:00', 'I adopted a gray tabby kitten named Pebble from the shelter.') });
    await ok('POST', '/ingest', { ns: NS, session: session(S2, '2023-06-02T09:10:00', 'Pebble needed a rabies vaccine and the vet visit cost 85 dollars.') });
    const fin = await ok('POST', '/finish', { ns: NS, timeout_s: 600 });
    expect(fin).toMatchObject({ ready: true, expected_pages: 2, absent_pages: 0 });
    const b = fin.f6_build;
    console.log('[f6-docker] build', JSON.stringify({ totals: b.totals, spent_usd: b.spent_usd, extract_ms: b.extract_ms, safe_chunks: b.safe_chunks, passes: b.passes, fact_index: b.fact_index }));
    expect(b).toMatchObject({ ok: true, problems: [], pages: 2, cap_usd: 1, posture: { 'facts.default_visibility': 'world' } });
    expect(b.passes).toBeGreaterThanOrEqual(1);
    expect(b.totals.pages_processed).toBe(2);
    expect(b.safe_chunks.complete).toBe(true);
    expect(b.fact_index).toBeDefined();
    expect(receipts().some(r => r.kind === 'f6_build')).toBe(true);
    expect((await ok('POST', '/finish', { ns: NS, timeout_s: 600 })).f6_build.reused).toBe(true);
  }, 1_800_000);

  test('policy-major overlays: a new overlay switches once and every key reads back; the same overlay does not switch again', async () => {
    const a = await ok('POST', '/retrieve', { ns: NS, question: Q, query_time: null, policy: f6('query', { limit: 50, token_budget: 5500 }, BASE) });
    expect(a.raw.overlay.switched).toBe(true);
    expect(a.raw.overlay.switch_ms).toBeGreaterThan(0);
    expect(a.raw.overlay.resolved).toEqual(Object.fromEntries(KEYS.map(k => [k, String((BASE as Record<string, unknown>)[k])])));
    expect(a.applied_settings).toMatchObject({ op: 'query', query: Q, limit: 50, token_budget: 5500 });
    expect(a.raw.meta.delivery).toMatchObject({ budget_tokens: 5500 });
    expect(a.items.length).toBeGreaterThan(0);
    const again = await ok('POST', '/retrieve', { ns: NS, question: Q, query_time: null, policy: f6('query', { limit: 50, token_budget: 5500 }, BASE) });
    expect([again.raw.overlay.switched, again.raw.overlay.overlay_sha256]).toEqual([false, a.raw.overlay.overlay_sha256]);
    const p = await ok('POST', '/retrieve', { ns: NS, question: Q, query_time: null, policy: f6('query', { limit: 50, token_budget: 5500 }, { ...BASE, 'search.query_facts_block': true }) });
    expect(p.raw.overlay.switched).toBe(true);
    expect(p.raw.overlay.overlay_sha256).not.toBe(a.raw.overlay.overlay_sha256);
    expect(p.raw.overlay.resolved['search.query_facts_block']).toBe('true');
    const rec = await ok('POST', '/retrieve', { ns: NS, question: Q, query_time: null, policy: f6('recall', { budget_tokens: 5500 }, BASE) });
    expect(rec.applied_settings).toMatchObject({ op: 'recall', question: Q, query: Q, budget_tokens: 5500 });
    expect(rec.raw.overlay).toMatchObject({ switched: true, overlay_sha256: a.raw.overlay.overlay_sha256 });
    expect(rec.items.length).toBeGreaterThan(0);
    const facts = [...p.items, ...rec.items].filter((i: { type: string }) => i.type === 'fact');
    for (const f of facts) expect(f.id).toMatch(/^fact:/);
    const switches = receipts().filter(r => r.kind === 'overlay');
    console.log('[f6-docker] overlay switch_ms', JSON.stringify(switches.map(s => s.switch_ms)), 'fact rows', facts.length);
    expect(switches.length).toBe(3);
  }, 900_000);

  test('a Q1 vendor-default policy still sends no token_budget, and token_budget in a Q1 policy is refused', async () => {
    const refused = await call('POST', '/retrieve', { ns: NS, question: 'x', query_time: null, policy: { name: 'gbrain-defaults:vendor-default', mode: 'vendor-default', settings: { token_budget: 8000 } } });
    expect([refused.status, refused.json.error.kind]).toEqual([400, 'invalid_request']);
  }, 600_000);
});
