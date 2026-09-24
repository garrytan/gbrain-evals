import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { offlineCat36Profile, runCat36, validateCat36Profile, type Cat36Profile, type Cat36Runtime } from '../../eval/runner/cat36-associative-retrieval.ts';
import { cat36Hash } from '../../eval/runner/cat36-corpus.ts';
import { cat36SnapshotHash, loadCat36FrozenConstruction } from '../../eval/runner/cat36-snapshot.ts';
import { writeReceipt } from '../../eval/runner/receipt.ts';
import { assertDevelopmentPricing, developmentChatOptions, startDevelopmentRequestGuard } from '../../eval/runner/situation-recall-development.ts';

const OPENROUTER_DEVELOPMENT_CHAT_OPTIONS = developmentChatOptions('openrouter:qwen/qwen3.7-flash');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function profile(): Cat36Profile {
  return { ...offlineCat36Profile(), mode: 'live', arm: 'C1', split: 'dev', expected_product_sha: 'a'.repeat(40),
    embedding_model: 'openrouter:openai/text-embedding-3-large', generation_model: 'openrouter:qwen/qwen3.7-flash',
    provider_chat_options: structuredClone(OPENROUTER_DEVELOPMENT_CHAT_OPTIONS),
    cue_min_similarity: 0.5, build_max_usd: 1,
    provider_budget: { kind: 'operator-authorized-development', approval_id: 'synthetic-only', max_usd: 5,
      max_requests: 2, max_request_bytes: 8192, max_output_tokens: 1200, build_timeout_ms: 60000, cell_timeout_ms: 120000 } };
}

const embeddingBody = { model: 'openai/text-embedding-3-large', dimensions: 1536, input: ['synthetic text'] };
const embeddingUrl = 'https://openrouter.ai/api/v1/embeddings';

test('pricing preflight requires exact installed router rows and never aliases native chat prices', async () => {
  const p = profile();
  await expect(assertDevelopmentPricing(p, resolve('node_modules/gbrain'))).resolves.toBeUndefined();
  const root = mkdtempSync(join(tmpdir(), 'development-price-contract-'));
  try {
    mkdirSync(join(root, 'src/core'), { recursive: true });
    writeFileSync(join(root, 'src/core/embedding-pricing.ts'), 'export const lookupEmbeddingPrice = () => ({kind:"known",pricePerMTok:0.13});');
    writeFileSync(join(root, 'src/core/model-pricing.ts'), 'export const canonicalLookup = model => model.startsWith("openrouter:") ? undefined : ({input:3,output:15});');
    p.generation_model = 'openrouter:anthropic/claude-sonnet-4.6';
    p.provider_chat_options = developmentChatOptions(p.generation_model);
    validateCat36Profile(p);
    await expect(assertDevelopmentPricing(p, root)).rejects.toThrow('exact OpenRouter price row required before ingestion');
    p.arm = 'B';
    await expect(assertDevelopmentPricing(p, root)).resolves.toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('operator admission is limited to the development route, not holdout, expanded operations or release arms', () => {
  expect(() => validateCat36Profile(profile())).not.toThrow();
  for (const change of [
    { split: 'holdout' }, { mode: 'offline', arm: 'B' }, { arm: 'scene-horizon-bridge' }, { arm: 'summary' }, { required_operations: ['search'] },
    { embedding_model: 'openai:text-embedding-3-large' }, { embedding_dimensions: 3072 },
    { generation_model: 'openrouter:anthropic/claude-haiku-4-5' }, { build_max_usd: 11 },
    { search_config: { ...profile().search_config, 'search.expansion': 'true' }, expansion_model: 'openrouter:qwen/qwen3.7-flash' },
  ]) expect(() => validateCat36Profile({ ...profile(), ...change } as Cat36Profile)).toThrow();
  for (const change of [{ max_usd: 101 }, { max_requests: 0 }, { max_requests: 1501 }, { max_request_bytes: 65537 }, { max_output_tokens: 1201 }, { max_output_tokens: 256 },
    { build_timeout_ms: 1800001 }, { cell_timeout_ms: 3600001 }, { cell_timeout_ms: 59999 }]) {
    expect(() => validateCat36Profile({ ...profile(), provider_budget: { ...profile().provider_budget!, ...change } })).toThrow();
  }
  expect(() => validateCat36Profile({ ...profile(), split: 'holdout', provider_budget: { kind: 'isolated-provider-cap', approval_id: 'synthetic-external', max_usd: 5 } })).not.toThrow();
});

test('the frozen cell deadline aborts in-flight inference and retains its uncertain reservation', async () => {
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('synthetic abort'))));
    return Response.json({});
  }) as unknown as typeof fetch;
  const p = profile();
  if (p.provider_budget?.kind !== 'operator-authorized-development') throw new Error('test admission missing');
  p.provider_budget.cell_timeout_ms = 10;
  const guard = startDevelopmentRequestGuard(p)!;
  try {
    await expect(fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })).rejects.toThrow('network outcome unknown');
    expect(guard.snapshot().cell_deadline_exceeded).toBe(true);
    expect(guard.snapshot().reserved_usd).toBeGreaterThan(0);
    await expect(fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })).rejects.toThrow('no request dispatched');
  } finally { guard.restore(); }
});

test('uncertain requests retain reservations and block further attempts without claiming zero cost', async () => {
  let calls = 0;
  const upstream = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    expect(init?.redirect).toBe('error');
    throw new Error('synthetic uncertain network failure');
  }) as unknown as typeof fetch;
  globalThis.fetch = upstream;
  const guard = startDevelopmentRequestGuard(profile())!;
  const send = () => fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) });
  try {
    await expect(send()).rejects.toThrow('network outcome unknown');
    await expect(send()).rejects.toThrow('no request dispatched');
    expect(calls).toBe(1);
    expect(guard.snapshot()).toMatchObject({ provider_hard_cap: false, dispatched_requests: 1, rejected_requests: 1,
      failed_or_unreported_requests: 1, requests_with_reported_cost: 0 });
    expect(guard.snapshot().reserved_usd).toBeGreaterThan(0);
    expect(guard.snapshot().per_request[0].reservation_retained).toBe(true);
  } finally { guard.restore(); }
  expect(globalThis.fetch).not.toBe(upstream);
  await expect(fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })).rejects.toThrow('no request dispatched');
  expect(calls).toBe(1);
});

test('route, body, output and concurrent request bounds stop calls before dispatch', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ model: embeddingBody.model, usage: { prompt_tokens: 1, cost: 0.00000013, is_byok: false } }); }) as unknown as typeof fetch;
  const p = profile();
  const guard = startDevelopmentRequestGuard(p)!;
  try {
    const chat = { model: 'qwen/qwen3.7-flash', messages: [], max_tokens: 1200, ...OPENROUTER_DEVELOPMENT_CHAT_OPTIONS['openrouter:qwen/qwen3.7-flash'] };
    for (const [url, body] of [
      ['https://api.openai.com/v1/embeddings', embeddingBody],
      [embeddingUrl, { ...embeddingBody, model: 'openai/text-embedding-3-small' }],
      [embeddingUrl, { ...embeddingBody, dimensions: 3072 }],
      [embeddingUrl, { ...embeddingBody, input: ['x'.repeat(9000)] }],
      ['https://openrouter.ai/api/v1/chat/completions', { ...chat, max_tokens: 1201 }],
      ['https://openrouter.ai/api/v1/chat/completions', { ...chat, model: 'deepseek/deepseek-v4-flash' }],
      ['https://openrouter.ai/api/v1/chat/completions', { ...chat, stream: true }],
      ['https://openrouter.ai/api/v1/chat/completions', { ...chat, n: 2 }],
      ['https://openrouter.ai/api/v1/chat/completions', { ...chat, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'https://example.invalid/image' }] }] }],
    ] as const) await expect(fetch(url, { method: 'POST', body: JSON.stringify(body) })).rejects.toThrow('no request dispatched');
    expect(calls).toBe(0);
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect(calls).toBe(2);
    expect(guard.snapshot().failed_or_unreported_requests).toBe(0);
    expect(guard.snapshot().reserved_usd).toBe(0);
  } finally { guard.restore(); }
});

test('external-cap profiles do not install a development guard', () => {
  expect(startDevelopmentRequestGuard({ ...profile(), provider_budget: { kind: 'isolated-provider-cap', approval_id: 'synthetic', max_usd: 5 } })).toBeUndefined();
  expect(globalThis.fetch).toBe(originalFetch);
});

test('the journal records reservations before dispatch and retains sanitized uncertain outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'development-journal-'));
  const path = join(root, 'requests.ndjson');
  globalThis.fetch = (async () => {
    const before = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(before.map(row => row.event)).toEqual(['admission', 'reserved']);
    expect(before[1].reservation_retained).toBe(true);
    throw new Error('synthetic failure with Bearer synthetic-secret-not-a-key');
  }) as unknown as typeof fetch;
  const guard = startDevelopmentRequestGuard(profile(), path)!;
  try {
    await expect(fetch(embeddingUrl, { method: 'POST', headers: { authorization: 'Bearer synthetic-secret-not-a-key' }, body: JSON.stringify(embeddingBody) })).rejects.toThrow('reservation retained');
    const serialized = readFileSync(path, 'utf8');
    expect(serialized).not.toContain('synthetic-secret-not-a-key');
    expect(serialized).not.toContain('synthetic text');
    const rows = serialized.trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.event)).toEqual(['admission', 'reserved', 'uncertain']);
    expect(rows[2].reservation_usd).toBe(rows[1].reservation_usd);
    const requestBytes = readFileSync(rows[1].request_artifact.path);
    expect(cat36Hash(requestBytes)).toBe(rows[1].request_artifact.sha256);
    expect(JSON.parse(requestBytes.toString()).input).toEqual(embeddingBody.input);
    const errorText = readFileSync(rows[2].error_artifact.path, 'utf8');
    expect(errorText).toContain('synthetic failure');
    expect(errorText).not.toContain('synthetic-secret-not-a-key');
    expect(() => startDevelopmentRequestGuard(profile(), path)).toThrow();
  } finally { guard.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('the real bare embedding response ID is explicit and failed model output remains inspectable without secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'development-response-artifacts-'));
  const previousKey = process.env.SYNTHETIC_API_KEY;
  process.env.SYNTHETIC_API_KEY = 'synthetic-private-value';
  globalThis.fetch = (async () => Response.json({ model: 'text-embedding-3-large',
    usage: { prompt_tokens: 1, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.00000013 } },
    diagnostic: { invalid_output: 'wrong cue family', echoed_secret: 'synthetic-private-value', headers: { authorization: 'Bearer unknown-token' } } })) as unknown as typeof fetch;
  const guard = startDevelopmentRequestGuard(profile(), join(root, 'requests.ndjson'))!;
  try {
    await fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) });
    const row = guard.snapshot().per_request[0];
    expect(row.model).toBe('openai/text-embedding-3-large');
    expect(row.response_model).toBe('text-embedding-3-large');
    const artifact = row.response_artifact as { path: string; sha256: string; redacted: boolean };
    const text = readFileSync(artifact.path, 'utf8');
    expect(cat36Hash(text)).toBe(artifact.sha256);
    expect(artifact.redacted).toBe(true);
    expect(text).toContain('wrong cue family');
    expect(text).not.toContain('synthetic-private-value');
    expect(text).not.toContain('authorization');
    expect(text).not.toContain('unknown-token');
  } finally {
    guard.restore();
    if (previousKey === undefined) delete process.env.SYNTHETIC_API_KEY; else process.env.SYNTHETIC_API_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['artifact', 'journal'])('%s write failure blocks dispatch and keeps the transport closed during cleanup', async failure => {
  const root = mkdtempSync(join(tmpdir(), 'development-write-failure-'));
  const journal = join(root, 'requests.ndjson');
  let calls = 0;
  const upstream = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
  globalThis.fetch = upstream;
  const guard = startDevelopmentRequestGuard(profile(), journal)!;
  try {
    rmSync(failure === 'artifact' ? join(root, 'development-http') : journal, { recursive: true });
    await expect(fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })).rejects.toThrow(
      failure === 'artifact' ? 'HTTP artifact unavailable' : 'accounting journal unavailable');
    expect(calls).toBe(0);
    expect(guard.snapshot().dispatched_requests).toBe(0);
    guard.restore();
    expect(guard.snapshot().closed_transport_retained).toBe(true);
    expect(globalThis.fetch).not.toBe(upstream);
    await expect(fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })).rejects.toThrow('no request dispatched');
    expect(calls).toBe(0);
  } finally { guard.restore(); rmSync(root, { recursive: true, force: true }); }
});

test('healthy settled cleanup restores the previous transport', async () => {
  const upstream = (async () => Response.json({ model: embeddingBody.model,
    usage: { prompt_tokens: 1, cost: 0.00000013, is_byok: false } })) as unknown as typeof fetch;
  globalThis.fetch = upstream;
  const guard = startDevelopmentRequestGuard(profile())!;
  try {
    await fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) });
    expect(guard.snapshot().reserved_usd).toBe(0);
  } finally { guard.restore(); }
  expect(guard.snapshot().closed_transport_retained).toBe(false);
  expect(globalThis.fetch).toBe(upstream);
});

test('pending cleanup cannot let later requests or SDK retries escape the guard', async () => {
  let entered!: () => void;
  let complete!: (response: Response) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const upstream = (async () => {
    entered();
    return await new Promise<Response>(resolve => { complete = resolve; });
  }) as unknown as typeof fetch;
  globalThis.fetch = upstream;
  const guard = startDevelopmentRequestGuard(profile())!;
  const pending = fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) });
  try {
    await started;
    expect(guard.snapshot().reserved_usd).toBeGreaterThan(0);
    guard.restore();
    expect(guard.snapshot().closed_transport_retained).toBe(true);
    await expect(fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })).rejects.toThrow('no request dispatched');
    complete(Response.json({ model: embeddingBody.model, usage: { prompt_tokens: 1, cost: 0.00000013, is_byok: false } }));
    await pending;
    expect(guard.snapshot().reserved_usd).toBe(0);
    expect(guard.snapshot().known_attributed_usd).toBe(0.00000013);
    expect(globalThis.fetch).not.toBe(upstream);
    await expect(fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })).rejects.toThrow('no request dispatched');
  } finally {
    complete?.(Response.json({ model: embeddingBody.model, usage: { prompt_tokens: 1, cost: 0.00000013, is_byok: false } }));
    await pending.catch(() => {});
    guard.restore();
  }
});

test('the local allocation is reserved before dispatch and cannot be enlarged by mutating the profile', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
  const p = profile();
  p.arm = 'B';
  delete p.build_max_usd;
  p.provider_budget!.max_usd = 0.000001;
  validateCat36Profile(p);
  const guard = startDevelopmentRequestGuard(p)!;
  p.provider_budget!.max_usd = 100;
  try {
    await expect(fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })).rejects.toThrow('no request dispatched');
    expect(calls).toBe(0);
    expect(guard.snapshot().limits.max_usd).toBe(0.000001);
  } finally { guard.restore(); }
});

test.each([
  { model: 'changed-model', usage: { prompt_tokens: 1, cost: 0.00000013, is_byok: false } },
  { model: embeddingBody.model, usage: { prompt_tokens: 1, cost: 1, is_byok: false } },
  { model: embeddingBody.model },
])('changed routes, prices and missing accounting halt subsequent work: %j', async response => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json(response); }) as unknown as typeof fetch;
  const guard = startDevelopmentRequestGuard(profile())!;
  try {
    await expect(fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })).rejects.toThrow('reservation retained');
    await expect(fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })).rejects.toThrow('no request dispatched');
    expect(calls).toBe(1);
    expect(guard.snapshot().reserved_usd).toBeGreaterThan(0);
  } finally { guard.restore(); }
});

test('BYOK upstream cost is retained while non-BYOK upstream cost is not charged twice', async () => {
  const records = [
    { prompt_tokens: 11, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.00000143 } },
    { prompt_tokens: 11, completion_tokens: 256, cost: 0.000035442, is_byok: false, cost_details: { upstream_inference_cost: 0.0000358 } },
  ];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => Response.json({ model: new URL((input as Request).url).pathname.endsWith('/embeddings') ? embeddingBody.model : 'qwen/qwen3.7-flash', usage: records.shift() })) as unknown as typeof fetch;
  const guard = startDevelopmentRequestGuard(profile())!;
  try {
    await fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) });
    await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'qwen/qwen3.7-flash', messages: [], max_tokens: 1200, ...OPENROUTER_DEVELOPMENT_CHAT_OPTIONS['openrouter:qwen/qwen3.7-flash'] }) });
    const usage = guard.snapshot();
    expect(usage.provider_reported_usd).toBe(0.000035442);
    expect(usage.byok_upstream_usd).toBe(0.00000143);
    expect(usage.known_attributed_usd).toBeCloseTo(0.000036872, 12);
    expect(usage.requests_with_unknown_byok_status).toBe(0);
    expect(usage.requests_with_unreported_byok_cost).toBe(0);
    expect(usage.per_request[1].usage).toMatchObject({ is_byok: false, upstream_inference_cost_usd: 0.0000358 });
  } finally { guard.restore(); }
});

test('missing BYOK cost stays explicitly unreported, and request-field overrides cannot enter provider options', async () => {
  globalThis.fetch = (async () => Response.json({ model: embeddingBody.model, usage: { prompt_tokens: 1, cost: 0, is_byok: true } })) as unknown as typeof fetch;
  const guard = startDevelopmentRequestGuard(profile())!;
  try {
    await expect(fetch(embeddingUrl, { method: 'POST', body: JSON.stringify(embeddingBody) })).rejects.toThrow('accounting or model invalid');
    expect(guard.snapshot().requests_with_unreported_byok_cost).toBe(1);
  } finally { guard.restore(); }
  for (const key of ['model', 'messages', 'max_tokens']) {
    const p = profile();
    Object.assign(p.provider_chat_options!['openrouter:qwen/qwen3.7-flash'], { [key]: 'forbidden' });
    expect(() => validateCat36Profile(p)).toThrow('request overrides forbidden');
  }
});

test('operator admission alone prevents publication even when the other receipt gates are satisfied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'development-publishability-'));
  try {
    const corpus = join(root, 'synthetic-review-copy');
    cpSync('eval/data/associative-recall-v1', corpus, { recursive: true });
    const manifestPath = join(corpus, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.review = { status: 'approved', reviewer: 'synthetic-test-only-not-a-human-approval', reviewed_hashes: manifest.hashes };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    for (const external of [true, false]) {
      const p = profile();
      if (external) p.provider_budget = { kind: 'isolated-provider-cap', approval_id: 'synthetic-only', max_usd: 5 };
      const runtime: Cat36Runtime = {
        kind: 'production',
        async build(sources) { return { mode: 'live', complete: true, feature_supported: true, generation_observed: true,
          families: ['scene', 'horizon'], source_hash: cat36Hash(JSON.stringify(sources)), resolved_config: {}, provenance: {}, mappings: [], generation: {} }; },
        async search() { return { chunks: [], cue: { mode: 'on', status: 'ready', candidates: 0, admitted: 0 }, failures: [], metadata: null }; },
        async close() {},
      };
      const receipt = await runCat36({ corpusDir: corpus, outputDir: join(root, external ? 'external' : 'operator'), profile: p, runtime });
      expect(receipt.run_status).toBe('completed');
      expect(receipt.n_scored).toBe(160);
      expect(receipt.data?.relevance_review_approved).toBe(true);
      expect(receipt.publishable).toBe(external);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a sealed operator-funded snapshot cannot be relabeled as externally capped release construction', () => {
  const root = mkdtempSync(join(tmpdir(), 'development-snapshot-'));
  try {
    mkdirSync(join(root, 'db'));
    writeFileSync(join(root, 'db', 'fixture'), 'synthetic database bytes');
    for (const external of [true, false]) {
      const original = profile();
      if (external) original.provider_budget = { kind: 'isolated-provider-cap', approval_id: 'synthetic', max_usd: 5 };
      const build = { runtime_kind: 'production', construction_profile: original, mode: 'live', complete: true,
        feature_supported: true, generation_observed: true, families: ['scene', 'horizon'], source_hash: 'a'.repeat(64),
        resolved_config: {}, provenance: { package_sha256: 'b'.repeat(64) }, mappings: [], generation: {}, index_snapshot: { path: 'db', sha256: cat36SnapshotHash(join(root, 'db')) } };
      writeFileSync(join(root, 'build.json'), JSON.stringify({ ...build, frozen_at: new Date().toISOString(), profile_hash: cat36Hash(JSON.stringify(original)) }));
      writeReceipt(join(root, 'receipt.json'), { schema_version: 1, benchmark_version: 'synthetic', category: 'cat36-associative-retrieval',
        run_status: 'completed', verdict: 'pass', publishable: false, n_total: 0, n_scored: 0, completion_rate: 0, errors: [],
        gbrain_pin: 'synthetic', gbrain_version: 'synthetic', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
        hashes: { build: cat36Hash(readFileSync(join(root, 'build.json'))) }, data: { runtime_kind: 'production', build } });
      const { build_max_usd, ...shared } = original;
      const scene: Cat36Profile = { ...shared, arm: 'scene', reuse_build_dir: root,
        provider_budget: { kind: 'isolated-provider-cap', approval_id: 'synthetic-external', max_usd: 5 } };
      const load = () => loadCat36FrozenConstruction(root, scene, 'a'.repeat(64), 'b'.repeat(64));
      if (external) expect(load).not.toThrow();
      else expect(load).toThrow('verified production C1 construction');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
