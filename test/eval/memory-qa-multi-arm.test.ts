/**
 * Multi-arm memory-qa (`--arms`): one ingest per namespace, one retrieval per
 * question and policy, every context and reader derived from them, frozen
 * reader contexts replayed byte for byte; and the upstream-trouble retry.
 * Keyless: the shim is the TypeScript fake over HTTP, and the "proxy" is a
 * local server that speaks the proxy's control routes and answers reader and
 * judge calls with canned text.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FakeMemorySystem, serveProtocol } from '../../eval/runner/systems/fake.ts';
import { expandArms, parseArms } from '../../eval/runner/memory-qa/arms.ts';
import { SystemError } from '../../eval/runner/systems/types.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'mqa-arms-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Counts every shim call by route and policy mode. */
function countingShim(fail?: (q: string, mode: string, n: number) => boolean) {
  const fake = new FakeMemorySystem();
  const calls: Record<string, number> = {};
  const bump = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; return calls[k]; };
  const ingest = fake.ingestSession.bind(fake), retrieve = fake.retrieve.bind(fake);
  fake.ingestSession = async (ns, s, t) => { bump('ingest'); return ingest(ns, s, t); };
  fake.retrieve = async (ns, q, p) => {
    const n = bump(`retrieve:${p.mode}:${q.text}`);
    bump(`retrieve:${p.mode}`);
    if (fail?.(q.text, p.mode, n)) throw new SystemError('product_error', 'vendor saw an upstream 503 and gave up');
    return retrieve(ns, q, p);
  };
  return { server: serveProtocol(fake), calls };
}

/** Stands in for the metering proxy: control routes, plus canned reader and judge answers on the harness slot. */
function fakeProxy(meterFor: (key: string) => Record<string, unknown> = () => ({})) {
  const prompts: Array<{ model: string; prompt: string }> = [];
  const finalized: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
    const path = new URL(req.url).pathname;
    const body = await req.json().catch(() => ({})) as any;
    if (path === '/__proxy/bind' || path === '/__proxy/unbind') return Response.json({ ok: true });
    if (path === '/__proxy/finalize') { finalized.push(body.key); return Response.json({ usd: 0.001, requests: 1, unpriced: 0, byModel: {}, ...meterFor(body.key) }); }
    if (path.endsWith('/chat/completions')) {
      const prompt = String(body.messages?.[0]?.content ?? '');
      prompts.push({ model: body.model, prompt });
      return Response.json({ choices: [{ message: { content: prompt.includes('Answer yes or no') || prompt.includes('Is the model response correct') ? 'yes' : 'the answer' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
    }
    return Response.json({ error: 'no route' }, { status: 404 });
  } });
  return { url: `http://127.0.0.1:${server.port}`, prompts, finalized, stop: () => server.stop(true) };
}

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, 'eval/runner/memory-qa/run.ts', '--benchmark', 'fixture', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GBRAIN_EVALS_QA_CACHE: join(tmp, `qa-cache-${Math.random()}`) } });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.slice(-2000));
  return err;
}
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const readNd = (p: string) => readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

describe('arms file', () => {
  test('expands policy x context x reader, and a retrieval-only matrix without readers', () => {
    const spec = parseArms(JSON.stringify({ policies: { 'vendor-default': { budget_tokens: null }, 'fixed-evidence': { budget_tokens: 8000 } }, contexts: ['native', 'rehydrated'],
      readers: [{ id: 'gpt-4o', model: 'openai:gpt-4o-2024-08-06' }, { id: 'opus', model: 'anthropic:claude-opus-5-5', slice: { limit: 3, seed: 1 } }] }));
    expect(expandArms(spec).map(a => a.id)).toEqual([
      'fixed-evidence.native.b8000.gpt-4o', 'fixed-evidence.native.b8000.opus', 'fixed-evidence.rehydrated.b8000.gpt-4o', 'fixed-evidence.rehydrated.b8000.opus',
      'vendor-default.native.bnone.gpt-4o', 'vendor-default.native.bnone.opus', 'vendor-default.rehydrated.bnone.gpt-4o', 'vendor-default.rehydrated.bnone.opus']);
    expect(expandArms(parseArms(JSON.stringify({ policies: { 'vendor-default': { budget_tokens: null } } }))).map(a => a.id)).toEqual(['vendor-default.retrieval']);
    expect(() => parseArms(JSON.stringify({ policies: { 'top-k': { budget_tokens: 5 } } }))).toThrow(/policies must name/);
  });
});

describe('reader policies', () => {
  test('a reader limited to one policy adds arms only for that policy; an undefined policy is refused', () => {
    const spec = parseArms(JSON.stringify({ policies: { 'vendor-default': { budget_tokens: null }, 'fixed-evidence': { budget_tokens: 8000 } }, contexts: ['native', 'rehydrated'],
      readers: [{ id: 'opus', model: 'anthropic:claude-opus-5-5', policies: ['fixed-evidence'] }] }));
    expect(expandArms(spec).map(a => a.id)).toEqual(['fixed-evidence.native.b8000.opus', 'fixed-evidence.rehydrated.b8000.opus']);
    expect(() => parseArms(JSON.stringify({ policies: { 'fixed-evidence': { budget_tokens: 8000 } }, contexts: ['native'], readers: [{ id: 'x', model: 'm', policies: ['vendor-default'] }] }))).toThrow(/policies must name policies the file defines/);
  });
});

describe('one ingest, many arms', () => {
  test('ingests once, retrieves once per policy, freezes one context per policy and mode, and replays it for a reader added later', async () => {
    const shim = countingShim();
    const proxy = fakeProxy();
    const out = join(tmp, 'cell');
    const arms = join(tmp, 'arms.json');
    const spec = { policies: { 'vendor-default': { budget_tokens: null }, 'fixed-evidence': { budget_tokens: 8000 } }, contexts: ['native', 'rehydrated'],
      readers: [{ id: 'gpt-4o', model: 'openai:gpt-4o-2024-08-06' }, { id: 'frontier', model: 'openai:gpt-6.1-sol', slice: { limit: 3, seed: 5 } }] };
    writeFileSync(arms, JSON.stringify(spec));
    try {
      await run(['--system', shim.server.url, '--arms', arms, '--provider-proxy', proxy.url, '--output', out]);
      expect(shim.calls.ingest).toBe(12);
      expect(shim.calls['retrieve:vendor-default']).toBe(8);
      expect(shim.calls['retrieve:fixed-evidence']).toBe(8 + 4);
      const receipt = readJson(join(out, 'receipt.json'));
      expect(receipt.kind).toBe('memory-qa-arms');
      expect(receipt.run_status).toBe('complete');
      expect(receipt.arms).toHaveLength(8);
      expect(receipt.contexts.frozen).toBe(8 * 2 * 2);
      for (const arm of receipt.arms) {
        const rows = readNd(join(out, arm.dir, 'rows.ndjson'));
        expect(rows).toHaveLength(arm.id.endsWith('frontier') ? 3 : 8);
        expect(rows.every((r: any) => r.outcome === 'scored' && typeof r.qa_score === 'number' && r.arm === arm.id && !r.items)).toBe(true);
        expect(readJson(join(out, arm.dir, 'receipt.json'))).toMatchObject({ kind: 'memory-qa-arm', run_status: 'complete', arm: { id: arm.id } });
      }
      const contexts = readNd(join(out, 'contexts.ndjson'));
      const frozen = new Set(contexts.map((c: any) => c.prompt));
      const sent = (model: string) => proxy.prompts.filter(p => p.model === model && frozen.has(p.prompt)).map(p => p.prompt);
      expect(new Set(sent('gpt-4o-2024-08-06'))).toEqual(frozen);
      expect(sent('gpt-6.1-sol').length).toBeGreaterThan(0);
      expect(proxy.prompts.filter(p => p.model === 'gpt-6.1-sol' && p.prompt.startsWith('I will give you several history') || p.model === 'gpt-6.1-sol' && p.prompt.startsWith('I will give you items')).every(p => frozen.has(p.prompt))).toBe(true);
      expect(proxy.finalized.filter(k => k.startsWith('ingest:'))).toHaveLength(4);

      const before = { ...shim.calls };
      writeFileSync(arms, JSON.stringify({ ...spec, readers: [...spec.readers, { id: 'sonnet', model: 'openai:gpt-5.5' }] }));
      await run(['--system', shim.server.url, '--arms', arms, '--provider-proxy', proxy.url, '--output', out]);
      expect(shim.calls).toEqual(before);
      const url = shim.server.url;
      shim.server.stop();
      writeFileSync(arms, JSON.stringify({ ...spec, readers: [...spec.readers, { id: 'sonnet', model: 'openai:gpt-5.5' }, { id: 'luna', model: 'openai:gpt-6-luna', slice: { limit: 2, seed: 3 } }] }));
      await run(['--system', url, '--arms', arms, '--provider-proxy', proxy.url, '--output', out, '--replay']);
      const luna = readJson(join(out, 'receipt.json')).arms.filter((x: any) => x.id.endsWith('luna'));
      expect(luna.map((x: any) => x.run_status)).toEqual(['complete', 'complete', 'complete', 'complete']);
      expect(readNd(join(out, luna[0].dir, 'rows.ndjson')).every((r: any) => r.qa_context.replayed === true)).toBe(true);
      expect(shim.calls).toEqual(before);
      const added = readJson(join(out, 'receipt.json')).arms.filter((x: any) => x.id.endsWith('sonnet'));
      expect(added).toHaveLength(4);
      for (const arm of added) {
        const rows = readNd(join(out, arm.dir, 'rows.ndjson'));
        expect(rows).toHaveLength(8);
        expect(rows.every((r: any) => r.qa_context.replayed === true && contexts.some((c: any) => c.prompt_sha256 === r.qa_context.prompt_sha256))).toBe(true);
      }
      expect(readNd(join(out, 'contexts.ndjson'))).toHaveLength(contexts.length);
    } finally { shim.server.stop(); proxy.stop(); }
  }, 120_000);
});

describe('upstream trouble', () => {
  const vet = (q: string) => /vet visit/.test(q);
  test('a retrieval that failed while the proxy saw a provider 5xx is retried once and keeps the evidence', async () => {
    const shim = countingShim((q, mode, n) => mode === 'vendor-default' && vet(q) && n === 1);
    const proxy = fakeProxy(key => key.startsWith('q:fx-00:') && !proxy.finalized.slice(0, -1).includes(key) ? { upstream: { statuses: { '503': 1 }, failed: 0, unparseable: 0 } } : { upstream: { statuses: { '200': 1 }, failed: 0, unparseable: 0 } });
    const out = join(tmp, 'retry');
    try {
      await run(['--system', shim.server.url, '--provider-proxy', proxy.url, '--output', out]);
      const row = readNd(join(out, 'rows.ndjson')).find((r: any) => r.id === 'fx-00');
      expect(row.outcome).toBe('scored');
      expect(row.upstream_retry).toMatchObject({ first_error: expect.stringContaining('503'), first_provider: { upstream: { statuses: { '503': 1 } } } });
      expect(readJson(join(out, 'receipt.json')).upstream).toEqual({ trouble_rows: 0, retried_rows: 1 });
    } finally { shim.server.stop(); proxy.stop(); }
  }, 60_000);

  test('with the retry off, the product failure stands and the provider status is on the row', async () => {
    const shim = countingShim((q, mode) => mode === 'vendor-default' && vet(q));
    const proxy = fakeProxy(key => key.startsWith('q:fx-00:') ? { upstream: { statuses: { '503': 1 }, failed: 0, unparseable: 0 } } : {});
    const out = join(tmp, 'no-retry');
    try {
      await run(['--system', shim.server.url, '--provider-proxy', proxy.url, '--no-retry-upstream-5xx', '--output', out]);
      const row = readNd(join(out, 'rows.ndjson')).find((r: any) => r.id === 'fx-00');
      expect(row).toMatchObject({ outcome: 'retrieval_error', provider: { upstream: { statuses: { '503': 1 } } } });
      expect(row.upstream_retry).toBeUndefined();
      expect(readJson(join(out, 'receipt.json')).upstream).toEqual({ trouble_rows: 1, retried_rows: 0 });
    } finally { shim.server.stop(); proxy.stop(); }
  }, 60_000);
});
