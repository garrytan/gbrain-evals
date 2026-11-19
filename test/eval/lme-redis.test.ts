import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const DIR = join(ROOT, 'eval/runner/lme-redis');

describe('LongMemEval on Redis harness: rendering', () => {
  test('the Python rendering and delivery tests pass on a bare python3', () => {
    const run = Bun.spawnSync(['python3', join(DIR, 'test_lme_redis.py')], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stderr: 'pipe' });
    expect([run.exitCode, run.stderr.toString().trim().split('\n').at(-1)]).toEqual([0, 'OK']);
  }, 60_000);
});

describe('LongMemEval on Redis harness: gbrain adapter server, keyless', () => {
  const home = mkdtempSync(join(tmpdir(), 'lme-redis-server-'));
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let url = '';
  const post = async (path: string, body: unknown) => {
    const r = await fetch(url + path, { method: 'POST', body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };

  beforeAll(async () => {
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, provider_base_urls: { voyage: 'http://127.0.0.1:9/v1' } }));
    server = Bun.spawn(['bun', join(DIR, 'gbrain-server.ts')], {
      env: { PATH: process.env.PATH ?? '', HOME: home, GBRAIN_HOME: home, GBRAIN_SRC: join(ROOT, 'node_modules/gbrain/src'), VOYAGE_API_KEY: 'dead-upstream-test', LME_REDIS_STUB_EMBED: '1', LME_REDIS_PORT: '0' },
      stdout: 'ignore', stderr: 'pipe',
    });
    const reader = (server.stderr as ReadableStream<Uint8Array>).getReader();
    let seen = '';
    while (!/up on (\d+)/.test(seen)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('adapter server exited: ' + seen);
      seen += new TextDecoder().decode(value);
    }
    url = 'http://127.0.0.1:' + /up on (\d+)/.exec(seen)![1];
    reader.releaseLock();
  }, 120_000);

  afterAll(() => { server?.kill(); rmSync(home, { recursive: true, force: true }); });

  test('reports the pinned reranker', async () => {
    const health = await (await fetch(url + '/')).json() as any;
    expect(health.reranker).toBe('voyage:rerank-3-lite');
  });

  test('imports one page per conversation and maps every result to its conversation', async () => {
    const sessions = [
      { date: '2023/05/20 (Sat) 02:21', turns: [{ role: 'user', content: 'I adopted a beagle named Biscuit last week.' }, { role: 'assistant', content: 'Congrats on Biscuit!' }] },
      { date: '2023/05/21 (Sun) 10:00', turns: [{ role: 'user', content: 'My favourite pasta is carbonara.' }, { role: 'assistant', content: 'Nice.' }] },
      { date: '2023/05/22 (Mon) 09:00', turns: [{ role: 'user', content: 'I started learning Rust.' }, { role: 'assistant', content: 'Good choice.' }] },
    ];
    expect(await post('/ingest', { brain_id: 'q1', sessions })).toEqual({ status: 200, body: { pages: 3 } });
    const q = await post('/query', { brain_id: 'q1', question: 'What is the name of the beagle I adopted?', params: { limit: 10, autocut: false } });
    expect(q.status).toBe(200);
    expect(q.body.op.params).toEqual({ limit: 10, autocut: false });
    expect(q.body.results.length).toBeGreaterThan(0);
    expect(q.body.results[0].idx).toBe(0);
    for (const r of q.body.results) expect([0, 1, 2]).toContain(r.idx);
    expect(q.body.op.reranker).toBeNull();
    expect(q.body.op.degraded.length).toBeGreaterThan(0);
    expect(await post('/reset', { brain_id: 'q1' })).toEqual({ status: 200, body: { ok: true } });
    expect((await post('/query', { brain_id: 'q1', question: 'x' })).status).toBe(500);
  }, 120_000);
});
