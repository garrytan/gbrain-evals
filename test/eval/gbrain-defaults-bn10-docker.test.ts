/**
 * The gbrain-defaults container at the BEAM-10M re-measure's pin (eval/runner/q1/cells/bn10.ts, BN10_ASSUMPTIONS),
 * keyless, on F6's build path: the image runs the pinned release, and the three arms' calls run: P and A0 with F6's identities, and the whole
 * arm's bare query under P's keys, sent as vendor-default. The fake upstream answers canned text, so nothing here says
 * anything about quality. Needs Docker:
 *
 *   SHOOTOUT_DOCKER_TESTS=1 bun test test/eval/gbrain-defaults-bn10-docker.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { BN10_ASSUMPTIONS } from '../../eval/runner/q1/cells/definitions.ts';
import { BN10_ARMS } from '../../eval/runner/q1/cells/bn10.ts';

const ROOT = resolve(import.meta.dir, '../..');
const COMPOSE = 'eval/systems/gbrain-defaults/docker-compose.yml';
const ON = process.env.SHOOTOUT_DOCKER_TESTS === '1';
const PIN = BN10_ASSUMPTIONS.gbrain_sha;
const PROJECT = `gbrain-defaults-bn10-test-${process.pid}`;
const NS = 'ns-0000000000000b10';
const S1 = 'src-1111111111111111', S2 = 'src-2222222222222222';
const [P, A0, WHOLE] = BN10_ARMS.map(a => a.retrieval!);

const free = () => { const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }); const p = s.port as number; s.stop(true); return p; };
const port = ON ? free() : 0;
const BASE_URL = `http://127.0.0.1:${port}`;
const env = { ...process.env, SHIM_HOST_PORT: String(port), PROXY_UPSTREAM: 'fake-upstream:8787', GBRAIN_F6: '1', GBRAIN_SHA: PIN, GBRAIN_BUN_IMAGE: BN10_ASSUMPTIONS.bun_image, GBRAIN_F6_EXTRACT_CAP_USD: '1' } as Record<string, string | undefined>;
for (const k of ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'VOYAGE_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete env[k];
const compose = (...args: string[]) => Bun.spawnSync(['docker', 'compose', '-p', PROJECT, '-f', COMPOSE, '--profile', 'keyless', ...args], { cwd: ROOT, env });

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
const policy = (mode: string, r: typeof P) => ({ name: `gbrain-defaults:${mode}`, mode, settings: { op: r.op, args: r.args, overlay: r.overlay } });
const Q = 'How much did the vet visit for Pebble cost?';
const waitHealthy = async () => {
  for (let i = 0; i < 300; i++) {
    try { const h = await call('GET', '/health'); if (h.json.ok === true) return h.json; } catch { /* starting */ }
    await Bun.sleep(1000);
  }
  throw new Error(`gbrain-defaults never became healthy: ${compose('logs', '--tail', '40').stdout.toString()}`);
};

describe.skipIf(!ON)('gbrain-defaults container at the BEAM-10M re-measure pin (keyless)', () => {
  beforeAll(async () => {
    const up = compose('up', '-d', '--build');
    if (up.exitCode !== 0) throw new Error(up.stderr.toString().slice(-3000));
    await waitHealthy();
  }, 1_800_000);
  afterAll(() => { compose('down', '-v', '--remove-orphans'); }, 300_000);

  test('the image runs the pinned release', async () => {
    const cap = await ok('GET', '/capabilities');
    expect(cap.f6).toMatchObject({ enabled: true, gbrain_sha: PIN });
    expect(cap.resolved.gbrain_version).toBe(`gbrain ${BN10_ASSUMPTIONS.gbrain_version.slice(1)}`);
    await ok('POST', '/reset', { ns: NS });
  }, 900_000);

  test('the brain builds, and P, A0 and the whole arm\'s bare query each run under their own keys', async () => {
    await ok('POST', '/ingest', { ns: NS, session: session(S1, '2023-05-08T13:56:00', 'I adopted a gray tabby kitten named Pebble from the shelter.') });
    await ok('POST', '/ingest', { ns: NS, session: session(S2, '2023-06-02T09:10:00', 'Pebble needed a rabies vaccine and the vet visit cost 85 dollars.') });
    const fin = await ok('POST', '/finish', { ns: NS, timeout_s: 600 });
    expect(fin).toMatchObject({ ready: true, expected_pages: 2, absent_pages: 0 });
    expect(fin.f6_build).toMatchObject({ ok: true, problems: [], pages: 2 });

    const p = await ok('POST', '/retrieve', { ns: NS, question: Q, query_time: null, policy: policy('fixed-evidence', P) });
    expect(p.applied_settings).toMatchObject({ op: 'query', query: Q, limit: 50, token_budget: 5500 });
    expect(p.raw.overlay.resolved['search.query_facts_block']).toBe('true');
    expect(p.items.length).toBeGreaterThan(0);

    const a0 = await ok('POST', '/retrieve', { ns: NS, question: Q, query_time: null, policy: policy('fixed-evidence', A0) });
    expect(a0.applied_settings).toMatchObject({ op: 'query', query: Q, limit: 50 });
    expect(a0.applied_settings.token_budget).toBeUndefined();
    expect([a0.raw.overlay.switched, a0.raw.overlay.resolved['search.query_facts_block']]).toEqual([true, 'false']);

    const whole = await ok('POST', '/retrieve', { ns: NS, question: Q, query_time: null, policy: policy('vendor-default', WHOLE) });
    console.log('[bn10-docker] whole', JSON.stringify({ applied: whole.applied_settings, rows: whole.items.length, classification: whole.raw.classification }));
    expect(whole.applied_settings).toMatchObject({ op: 'query', query: Q, overlay_sha256: p.raw.overlay.overlay_sha256 });
    expect(Object.keys(whole.applied_settings).sort()).toEqual(['fence', 'op', 'overlay_sha256', 'query']);
    expect(whole.applied_settings.fence).toMatchObject({ budget_tokens: 5500, unmatched_quoted_rows: 0 });
    expect(whole.raw.overlay).toMatchObject({ switched: true, overlay_sha256: p.raw.overlay.overlay_sha256 });
    expect(whole.items.length).toBeGreaterThan(0);
  }, 1_800_000);
});
