/**
 * The gbrain-defaults container end to end, keyless: the real gbrain build in its image, the shim driving
 * `gbrain serve --surface starter` over stdio, and the fake upstream (profile keyless) standing where the metering
 * proxy stands. Needs Docker, so it runs with SHOOTOUT_DOCKER_TESTS=1, as systems-bootstrap.test.ts does:
 *
 *   SHOOTOUT_DOCKER_TESTS=1 bun test test/eval/gbrain-defaults-docker.test.ts
 *
 * Covered: the documented install and its resolved defaults (two clean installs resolve identically), dummy keys
 * and no direct route to a provider host, committed writes with request-id replay, the quiesce barrier, doctor's
 * live_serve detection, bare `query` with auto delivery and no token_budget, every called op on the starter
 * tools/list, embedding, rerank, expansion and synthesis reaching the proxy, degraded-read and own-answer
 * classification under injected provider failures, the shared protocol check, and a restart that keeps brains.
 * The protocol conformance suite runs against the same stack with SHIM_URL (see the bundle README).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const COMPOSE = 'eval/systems/gbrain-defaults/docker-compose.yml';
const ON = process.env.SHOOTOUT_DOCKER_TESTS === '1';
const PROJECT = `gbrain-defaults-test-${process.pid}`;
const NS_A = 'ns-00000000000000a1', NS_B = 'ns-00000000000000b2', NS_C = 'ns-00000000000000c3';
const S1 = 'src-1111111111111111', S2 = 'src-2222222222222222', S3 = 'src-3333333333333333';
const CANARY = 'zephyrquokka';
const STARTER_CALLS = ['put_page', 'get_write_request', 'query', 'list_pages', 'synthesize'];

const free = () => { const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }); const p = s.port as number; s.stop(true); return p; };
const port = ON ? free() : 0;
const BASE = `http://127.0.0.1:${port}`;
const env = { ...process.env, SHIM_HOST_PORT: String(port), PROXY_UPSTREAM: 'fake-upstream:8787' } as Record<string, string>;
for (const k of ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'VOYAGE_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete env[k];
const compose = (...args: string[]) => Bun.spawnSync(['docker', 'compose', '-p', PROJECT, '-f', COMPOSE, '--profile', 'keyless', ...args], { cwd: ROOT, env });
const composeWith = (extra: Record<string, string>, ...args: string[]) => Bun.spawnSync(['docker', 'compose', '-p', PROJECT, '-f', COMPOSE, '--profile', 'keyless', ...args], { cwd: ROOT, env: { ...env, ...extra } });
const inShim = (...cmd: string[]) => compose('exec', '-T', 'shim', ...cmd);
const pyInShim = (code: string) => inShim('python3', '-c', code);
const upstream = (path: string, body?: unknown) => {
  const r = pyInShim(`import urllib.request, json; req = urllib.request.Request("http://egress:9000${path}", data=${body === undefined ? 'None' : `json.dumps(${JSON.stringify(body)}).encode()`}, method=${body === undefined ? '"GET"' : '"POST"'}); print(urllib.request.urlopen(req, timeout=10).read().decode())`);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
};

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body), keepalive: false, signal: AbortSignal.timeout(900_000) });
  return { status: r.status, json: await r.json() };
}
const ok = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const r = await call(method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json).slice(0, 600)}`);
  return r.json;
};
const session = (source_id: string, when: string, text: string) => ({ source_id, event_time: when, turns: [{ role: 'user', speaker: 'user', content: text }, { role: 'assistant', speaker: 'assistant', content: 'Noted, thanks.' }] });
const policy = (mode: string, settings: Record<string, unknown> = {}) => ({ name: `gbrain-defaults:${mode}`, mode, settings });
const waitHealthy = async () => {
  for (let i = 0; i < 300; i++) {
    try { const h = await call('GET', '/health'); if (h.json.ok === true) return h.json; } catch { /* starting */ }
    await Bun.sleep(1000);
  }
  throw new Error(`gbrain-defaults never became healthy: ${compose('logs', '--tail', '40').stdout.toString()}`);
};

describe.skipIf(!ON)('gbrain-defaults container (keyless)', () => {
  beforeAll(async () => {
    const up = compose('up', '-d', '--build');
    if (up.exitCode !== 0) throw new Error(up.stderr.toString().slice(-3000));
    await waitHealthy();
  }, 900_000);
  afterAll(() => { compose('down', '-v', '--remove-orphans'); }, 300_000);

  test('install: the documented recipe resolves to the shipped defaults, and a second clean install resolves identically', async () => {
    const cap = await ok('GET', '/capabilities');
    expect(cap.protocol).toBe(1);
    const r = cap.resolved;
    expect(r.gbrain_version).toBe('gbrain 0.60.106.0');
    expect([r.engine, r.embedding_model, r.embedding_dimensions, r.search_mode]).toEqual(['pglite', 'voyage:voyage-4', 1024, 'tokenmax']);
    expect([r.search.reranker_enabled, r.search.reranker_model, r.search.expansion, r.search.searchLimit]).toEqual([true, 'voyage:rerank-2.5', true, 50]);
    expect(r.model_tasks['models.expansion']).toBe('anthropic:claude-haiku-4-5-20251001');
    expect(r.model_tasks['models.think']).toBe('anthropic:claude-opus-4-7');
    expect(r.first_run_decisions.map((d: { id: string; default: string }) => `${d.id}=${d.default}`)).toEqual(['search_mode=tokenmax', 'writeback=salient', 'harness_wiring=skip']);
    for (const op of STARTER_CALLS) expect(r.starter_tools).toContain(op);
    await ok('POST', '/reset', { ns: NS_A });
    await ok('POST', '/reset', { ns: NS_B });
    const installs = inShim('cat', '/data/logs/receipts.ndjson').stdout.toString().trim().split('\n').map(l => JSON.parse(l)).filter(x => x.kind === 'install');
    expect(installs.length).toBe(2);
    expect(new Set(installs.map(i => i.resolved_sha256))).toEqual(new Set([r.resolved_sha256]));
    expect(new Set(installs.map(i => i.config_sha256))).toEqual(new Set([r.config_sha256]));
  }, 600_000);

  test('the container holds dummy provider keys and cannot reach a provider host directly', () => {
    const vars = Object.fromEntries(inShim('env').stdout.toString().trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    for (const k of ['VOYAGE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(vars[k]).toContain('dummy');
      if (process.env[k]) expect(vars[k]).not.toBe(process.env[k]);
    }
    expect(vars.OPENAI_BASE_URL).toBeUndefined();
    for (const host of ['api.voyageai.com', 'api.openai.com', 'api.anthropic.com']) {
      expect(pyInShim(`import urllib.request; urllib.request.urlopen("https://${host}", timeout=5)`).exitCode).not.toBe(0);
    }
  }, 120_000);

  test('writes: committed receipts, a free replay of the same request id, and a refused rewrite', async () => {
    const r1 = await ok('POST', '/ingest', { ns: NS_A, session: session(S1, '2023-05-08T13:56:00', 'I adopted a gray tabby kitten named Pebble from the shelter.') });
    const r2 = await ok('POST', '/ingest', { ns: NS_A, session: session(S2, '2023-06-02T09:10:00', 'Pebble needed a rabies vaccine and the vet visit cost 85 dollars.') });
    expect([r1.write_state, r2.write_state, r1.completeness]).toEqual(['committed', 'committed', 'known']);
    const replay = await ok('POST', '/ingest', { ns: NS_A, session: session(S1, '2023-05-08T13:56:00', 'I adopted a gray tabby kitten named Pebble from the shelter.') });
    expect([replay.request_id, replay.write_state]).toEqual([r1.request_id, 'committed']);
    const changed = await call('POST', '/ingest', { ns: NS_A, session: session(S1, '2023-05-08T13:56:00', 'A different text for the same session.') });
    expect([changed.status, changed.json.error.kind]).toEqual([409, 'invalid_request']);
    await ok('POST', '/ingest', { ns: NS_B, session: session(S3, '2023-05-09T10:00:00', `My secret code word is ${CANARY} and I keep it in a notebook.`) });
  }, 600_000);

  test('finish is the quiesce barrier: doctor with the brain to itself, every page, full embedding coverage', async () => {
    const fin = await ok('POST', '/finish', { ns: NS_A, timeout_s: 300 });
    expect(fin).toMatchObject({ ready: true, completeness: 'known', expected_pages: 2, absent_pages: 0 });
    expect(fin.doctor).toMatchObject({ clean: true, embeddings_missing: 0, pages: 2 });
    expect((await ok('POST', '/finish', { ns: NS_B, timeout_s: 300 })).ready).toBe(true);
    const finishes = inShim('cat', '/data/logs/receipts.ndjson').stdout.toString().trim().split('\n').map(l => JSON.parse(l)).filter(x => x.kind === 'finish');
    for (const f of finishes) for (const round of f.rounds) expect(round.reasons.join(' ')).not.toContain('live_serve');
  }, 900_000);

  test('retrieve: bare query with auto delivery, never token_budget, exact provenance, meta and notices kept', async () => {
    const r = await ok('POST', '/retrieve', { ns: NS_A, question: 'How much did the vet visit for Pebble cost?', query_time: '2023-07-01T00:00:00', policy: policy('vendor-default') });
    expect(r.applied_settings).toEqual({ query: 'How much did the vet visit for Pebble cost?' });
    expect(r.raw.args).toEqual(r.applied_settings);
    expect(r.raw.meta.delivery).toMatchObject({ requested_unit: 'auto', budget_tokens: 24000, fallbacks: [] });
    expect(r.raw.meta.token_budget).toBeUndefined();
    for (const k of ['vector_enabled', 'expansion_applied', 'cache', 'degraded', 'projection_readiness']) expect(r.raw.meta).toHaveProperty(k);
    expect(Array.isArray(r.raw.notices)).toBe(true);
    expect(r.raw.classification).toMatchObject({ outcome: 'scored', reasons: [] });
    expect(r.items[0]).toMatchObject({ rank: 1, type: 'episode', source_ids: [S2], provenance_status: 'exact' });
    expect(r.items[0].text).toContain('85 dollars');
    expect(r.items.flatMap((i: { source_ids: string[] }) => i.source_ids)).not.toContain(S3);
    const fixed = await ok('POST', '/retrieve', { ns: NS_A, question: 'How much did the vet visit for Pebble cost?', query_time: null, policy: policy('fixed-evidence') });
    expect(fixed.applied_settings).toEqual({ query: 'How much did the vet visit for Pebble cost?', autocut: false, limit: 50 });
    expect(fixed.raw.meta.delivery.requested_unit).toBe('auto');
    const refused = await call('POST', '/retrieve', { ns: NS_A, question: 'x', query_time: null, policy: policy('vendor-default', { token_budget: 8000 }) });
    expect([refused.status, refused.json.error.kind]).toEqual([400, 'invalid_request']);
  }, 600_000);

  test('doctor under the live serve reports live_serve, and the gate refuses it', () => {
    const r = pyInShim([
      'import importlib.util, json, os, subprocess',
      'spec = importlib.util.spec_from_file_location("gd", "/app/gbrain-defaults/shim.py"); gd = importlib.util.module_from_spec(spec); spec.loader.exec_module(gd)',
      'out = subprocess.run(["gbrain", "doctor", "--json"], env={**os.environ, "GBRAIN_HOME": "/data/home", "HOME": "/data/home"}, cwd="/data/work", stdin=subprocess.DEVNULL, capture_output=True, text=True).stdout',
      'print(json.dumps(gd.doctor_gate(json.loads(out[out.index("{"):]), 2)))',
    ].join('\n'));
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const gate = JSON.parse(r.stdout.toString());
    expect(gate.clean).toBe(false);
    expect(gate.reasons[0]).toStartWith('live_serve');
  }, 300_000);

  test('own answer: synthesize on the starter surface; think needs the labeled full surface', async () => {
    const a = await ok('POST', '/answer', { ns: NS_A, question: 'How much did the vet visit cost?', query_time: '2023-07-01T00:00:00' });
    expect(a).toMatchObject({ outcome: 'scored', synthesis_status: 'ok', degraded: null });
    expect(a.source_ids.length).toBeGreaterThan(0);
    expect(a.cost.model).toBe('anthropic:claude-opus-4-7');
    const think = await call('POST', '/answer', { ns: NS_A, question: 'x', mode: 'think' });
    expect([think.status, think.json.error.kind]).toEqual([501, 'unsupported']);
  }, 300_000);

  test('embedding, rerank, expansion and synthesis each reached the proxy, and only starter ops were called', async () => {
    const stats = upstream('/_stats');
    for (const k of ['embeddings:voyage-4', 'rerank:rerank-2.5', 'messages:claude-haiku-4-5-20251001', 'messages:claude-opus-4-7']) expect(stats[k]).toBeGreaterThan(0);
    const health = await ok('GET', '/health');
    const cap = await ok('GET', '/capabilities');
    expect(health.called_ops.length).toBeGreaterThan(0);
    for (const op of health.called_ops) expect(cap.resolved.starter_tools).toContain(op);
  }, 120_000);

  test('degraded reads and degraded answers are classified under injected provider failures', async () => {
    try {
      upstream('/_fail', { rerank: 503 });
      const failed = await call('POST', '/retrieve', { ns: NS_A, question: 'What vaccine did Pebble need at the vet?', query_time: null, policy: policy('vendor-default') });
      expect([failed.status, failed.json.error.kind]).toEqual([503, 'invalid_request']);
      expect(failed.json.error.message).toContain('rerank');
      const reported = await ok('POST', '/retrieve', { ns: NS_A, question: 'Which shelter kitten did I adopt?', query_time: null, policy: policy('vendor-default', { on_degraded: 'report' }) });
      expect(reported.raw.classification.outcome).toBe('harness_invalid');
      expect(reported.raw.classification.reasons.some((x: string) => x.startsWith('degraded:rerank'))).toBe(true);
      expect(reported.items.length).toBeGreaterThan(0);

      upstream('/_fail', { messages: 402 });
      const noExpansion = await ok('POST', '/retrieve', { ns: NS_A, question: 'What color is the kitten Pebble?', query_time: null, policy: policy('vendor-default', { on_degraded: 'report' }) });
      expect(noExpansion.raw.classification.reasons).toContain('expansion_not_applied');
      const fallback = await ok('POST', '/answer', { ns: NS_A, question: 'How much did the vet visit cost?' });
      expect(fallback).toMatchObject({ outcome: 'scored', synthesis_status: 'extractive_fallback', degraded: 'extractive_fallback' });
      await ok('POST', '/reset', { ns: NS_C });
      const unavailable = await ok('POST', '/answer', { ns: NS_C, question: 'How much did the vet visit cost?' });
      expect(unavailable).toMatchObject({ outcome: 'harness_invalid', synthesis_status: 'unavailable' });
    } finally {
      upstream('/_fail', {});
    }
  }, 900_000);

  test('the shared protocol check passes against the container', () => {
    const r = Bun.spawnSync(['python3', 'eval/systems/_shim/protocol_check.py', '--url', BASE, '--questions', '3'], { cwd: ROOT });
    expect(r.exitCode, r.stdout.toString().slice(-2000)).toBe(0);
    expect(r.stdout.toString()).toMatch(/\n(\d+)\/\1 checks passed/);
  }, 900_000);

  test('a container restart keeps every brain and serves the active one again', async () => {
    expect(compose('restart', 'shim').exitCode).toBe(0);
    await waitHealthy();
    const r = await ok('POST', '/retrieve', { ns: NS_A, question: 'How much did the vet visit for Pebble cost?', query_time: null, policy: policy('vendor-default', { on_degraded: 'report' }) });
    expect(r.items.flatMap((i: { source_ids: string[] }) => i.source_ids)).toContain(S2);
    const stats = await ok('GET', '/stats');
    expect(stats.serve_rss_kb).toBeGreaterThan(0);
    expect(stats.brain_bytes).toBeGreaterThan(0);
    expect((await ok('POST', '/restart', { ns: NS_A })).restart_ms).toBeGreaterThan(0);
  }, 600_000);

  test('the labeled full surface runs think with the reader as model and the question date as reference_date', async () => {
    expect(composeWith({ GBRAIN_FULL_SURFACE: '1' }, 'up', '-d', 'shim').exitCode).toBe(0);
    await waitHealthy();
    expect((await ok('GET', '/health')).surface).toBe('full');
    const t = await ok('POST', '/answer', { ns: NS_A, question: 'How much did the vet visit cost?', query_time: '2023-07-01T00:00:00', mode: 'think', model: 'anthropic:claude-sonnet-4-6' });
    expect(t.args).toEqual({ question: 'How much did the vet visit cost?', model: 'anthropic:claude-sonnet-4-6', reference_date: '2023-07-01' });
    expect(t.outcome).toBe('scored');
    expect(t.serve_session.surface).toBe('full');
    const health = await ok('GET', '/health');
    const cap = await ok('GET', '/capabilities');
    for (const op of health.called_ops.filter((o: string) => o !== 'think')) expect(cap.resolved.starter_tools).toContain(op);
  }, 600_000);
});
