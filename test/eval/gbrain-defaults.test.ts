/**
 * The gbrain-defaults shim's own logic (eval/systems/gbrain-defaults/shim.py), keyless and without Docker or gbrain:
 * degraded-meta and own-answer classification, the doctor quiesce gate (live_serve, embedding coverage), the
 * deterministic request id, the conversation page it writes, the query arguments for each policy (never
 * token_budget), the capability record, and the keyless provider stand-in (fake_upstream.py). The container is
 * exercised by gbrain-defaults-docker.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const BUNDLE = 'eval/systems/gbrain-defaults';

/** Call one pure function of shim.py (loaded under its own module name; the shared base is also `shim`) and return its JSON result. */
function py(expr: string, ...args: unknown[]): any {
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("gbrain_defaults_shim", ${JSON.stringify(`${ROOT}/${BUNDLE}/shim.py`)})`,
    'shim = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(shim)',
    'a = [json.loads(x) for x in sys.argv[1:]]',
    'try:',
    `    print(json.dumps({"ok": ${expr}}))`,
    'except shim.ShimError as e:',
    '    print(json.dumps({"error": {"kind": e.kind, "status": e.status, "message": str(e)}}))',
  ].join('\n');
  const r = Bun.spawnSync(['python3', '-c', code, ...args.map(a => JSON.stringify(a))], { cwd: ROOT });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

describe('serve stdin is bounded', () => {
  test('a serve that stops reading its input fails the call as a timeout within the deadline, is killed, and closes cleanly', () => {
    const code = [
      'import importlib.util, json, sys, time, tempfile, os',
      `spec = importlib.util.spec_from_file_location("gbrain_defaults_shim", ${JSON.stringify(`${ROOT}/${BUNDLE}/shim.py`)})`,
      'shim = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(shim)',
      'm = shim.McpStdio(["sleep", "60"], dict(os.environ), tempfile.gettempdir(), os.path.join(tempfile.mkdtemp(), "serve.log"))',
      't0 = time.monotonic()',
      'try:',
      '    m.request("tools/call", {"blob": "x" * (4 << 20)}, timeout_s=2)',
      '    out = {"raised": None}',
      'except shim.ShimError as e:',
      '    out = {"raised": e.kind, "message": str(e)}',
      'out["seconds"] = time.monotonic() - t0',
      'm.proc.wait(timeout=10)',
      'out["killed"] = m.proc.returncode is not None',
      'm.close()',
      'print(json.dumps(out))',
    ].join('\n');
    const r = Bun.spawnSync(['python3', '-c', code], { cwd: ROOT, timeout: 60_000 });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const out = JSON.parse(r.stdout.toString());
    expect(out).toMatchObject({ raised: 'timeout', killed: true });
    expect(out.message).toContain('stopped reading its input');
    expect(out.seconds).toBeLessThan(10);
  });
});

const TOKENMAX = { reranker_enabled: true, expansion: true };
const cleanMeta = {
  returned_count: 2, retrieved_count: 2, vector_enabled: true, expansion_applied: true, cache: 'disabled', degraded: [],
  projection_readiness: { status: 'ready', ready: true }, crag: { confidence: 'strong', reason: 'rerank_top', top_rerank_score: 0.61 },
  delivery: { requested_unit: 'auto', applied_unit: 'auto', budget_tokens: 24000, fallbacks: [], dropped_reasons: {} },
};

describe('degraded query meta is a harness failure (plan contract 4.8.4)', () => {
  const classify = (meta: unknown) => py('shim.classify_query_meta(a[0], a[1])', meta, TOKENMAX).ok;
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ['clean read', {}, []],
    ['reranker failed', { degraded: [{ stage: 'rerank_failed', reason: 'provider_error' }], crag: { reason: 'cosine_top' } }, ['degraded:rerank_failed', 'rerank_missing']],
    ['reranker skipped (no key)', { degraded: [{ stage: 'reranker_skipped', reason: 'no_key' }] }, ['degraded:reranker_skipped']],
    ['rerank silently absent in a reranked mode', { crag: { confidence: 'weak', reason: 'cosine_top' } }, ['rerank_missing']],
    ['an identity-tier grade carries no rerank score by construction (A12)', { crag: { confidence: 'strong', reason: 'high_vector_match' } }, []],
    ['an exact lookup grade likewise', { crag: { confidence: 'strong', reason: 'exact_lookup' } }, []],
    ['expansion call failed', { degraded: [{ stage: 'expansion_failed', reason: 'provider_error' }], expansion_applied: false }, ['degraded:expansion_failed', 'expansion_not_applied']],
    ['expansion fell back silently (proxy 402)', { expansion_applied: false }, ['expansion_not_applied']],
    ['vector arm off', { vector_enabled: false }, ['vector_disabled']],
    ['projection pending', { projection_readiness: { status: 'projection_pending' }, degraded: [{ stage: 'projection_pending' }] }, ['degraded:projection_pending', 'projection:projection_pending']],
    ['evidence delivery fell back', { delivery: { ...cleanMeta.delivery, fallbacks: ['fetch_timeout'] } }, ['delivery_fallback:fetch_timeout']],
    ['chunk delivery (a token_budget slipped in)', { delivery: { ...cleanMeta.delivery, requested_unit: 'chunk' } }, ['delivery_unit:chunk']],
  ];
  for (const [name, patch, reasons] of cases) {
    test(name, () => {
      const v = classify({ ...cleanMeta, ...patch });
      expect(v.reasons).toEqual(reasons);
      expect(v.outcome).toBe(reasons.length ? 'harness_invalid' : 'scored');
    });
  }
  test('a semantic cache hit and dropped blocks are shipped behavior, recorded only', () => {
    const v = classify({ ...cleanMeta, cache: 'hit', vector_pool_underfilled: true, delivery: { ...cleanMeta.delivery, dropped_reasons: { over_budget: 3 } } });
    expect(v.outcome).toBe('scored');
    expect(v.recorded).toEqual(['semantic_cache_hit', 'vector_pool_underfilled', 'delivery_dropped:over_budget=3']);
  });
  test('shipped-behavior delivery fallbacks (redaction_unmapped, no_text_chunks) are recorded, never a degraded read', () => {
    const v = classify({ ...cleanMeta, delivery: { ...cleanMeta.delivery, fallbacks: ['no_text_chunks', 'redaction_unmapped'] } });
    expect(v.outcome).toBe('scored');
    expect(v.reasons).toEqual([]);
    expect(v.recorded).toEqual(['delivery_fallback:no_text_chunks', 'delivery_fallback:redaction_unmapped']);
  });
  test('timeout-type and unknown delivery fallbacks stay harness failures beside a shipped one', () => {
    for (const f of ['fetch_timeout', 'fetch_failed', 'row_limit', 'unsealed_page', 'anchor_not_located', 'page_missing', 'something_new']) {
      const v = classify({ ...cleanMeta, delivery: { ...cleanMeta.delivery, fallbacks: ['redaction_unmapped', f] } });
      expect(v.outcome).toBe('harness_invalid');
      expect(v.reasons).toEqual([`delivery_fallback:${f}`]);
      expect(v.recorded).toEqual(['delivery_fallback:redaction_unmapped']);
    }
  });
  test('the shipped set is configurable (GBRAIN_SHIPPED_FALLBACKS); a set without a reason makes it a harness failure', () => {
    const meta = { ...cleanMeta, delivery: { ...cleanMeta.delivery, fallbacks: ['no_text_chunks'] } };
    const run = (set: string) => {
      const code = ['import importlib.util, json, sys',
        `spec = importlib.util.spec_from_file_location("gbrain_defaults_shim", ${JSON.stringify(`${ROOT}/${BUNDLE}/shim.py`)})`,
        'shim = importlib.util.module_from_spec(spec)', 'spec.loader.exec_module(shim)',
        'print(json.dumps({"set": sorted(shim.SHIPPED_BEHAVIOR), "v": shim.classify_query_meta(json.loads(sys.argv[1]), json.loads(sys.argv[2]))}))'].join('\n');
      return JSON.parse(Bun.spawnSync(['python3', '-c', code, JSON.stringify(meta), JSON.stringify(TOKENMAX)], { cwd: ROOT, env: { ...process.env, GBRAIN_SHIPPED_FALLBACKS: set } }).stdout.toString());
    };
    expect(run('no_text_chunks,redaction_unmapped')).toMatchObject({ set: ['no_text_chunks', 'redaction_unmapped'], v: { outcome: 'scored' } });
    expect(run('redaction_unmapped')).toMatchObject({ set: ['redaction_unmapped'], v: { outcome: 'harness_invalid', reasons: ['delivery_fallback:no_text_chunks'] } });
  });
  test('an empty result has nothing to rerank', () => {
    expect(classify({ ...cleanMeta, returned_count: 0, retrieved_count: 0, crag: { reason: 'zero_results' } }).outcome).toBe('scored');
  });
  test('a mode without the reranker or expansion does not require them', () => {
    expect(py('shim.classify_query_meta(a[0], a[1])', { ...cleanMeta, expansion_applied: false, crag: { reason: 'cosine_top' } }, { reranker_enabled: false, expansion: false }).ok.outcome).toBe('scored');
  });
});

describe('own answer (synthesize / think) classification', () => {
  const s = (status: string | null, code: string | null) => py('shim.classify_synthesis(a[0], a[1])', status, code).ok;
  test('ok is an answer, extractive_fallback a product-degraded answer in its own column, unavailable a harness failure', () => {
    expect(s('ok', null)).toEqual({ outcome: 'scored', synthesis_status: 'ok', degraded: null });
    expect(s('extractive_fallback', null)).toEqual({ outcome: 'scored', synthesis_status: 'extractive_fallback', degraded: 'extractive_fallback' });
    expect(s(null, 'unavailable')).toMatchObject({ outcome: 'harness_invalid', synthesis_status: 'unavailable', error_code: 'unavailable' });
    expect(s(null, null).outcome).toBe('harness_invalid');
  });
});

describe('the doctor quiesce gate', () => {
  const report = (checks: unknown[]) => ({ status: 'healthy', health_score: 100, checks });
  const conn = { name: 'connection', status: 'ok', message: 'Connected, 2 pages' };
  const emb = { name: 'embeddings', status: 'ok', message: '100% coverage, 0 missing' };
  const gate = (r: unknown, pages: number) => py('shim.doctor_gate(a[0], a[1])', r, pages).ok;
  test('clean with every page and full embedding coverage', () => {
    expect(gate(report([conn, emb]), 2)).toMatchObject({ clean: true, pages: 2, embeddings_missing: 0, reasons: [] });
  });
  test('doctor under a live serve (details.reason live_serve) never passes, even though it is only a warning', () => {
    const live = { name: 'connection', status: 'warn', message: 'The brain is held by gbrain serve. The database checks did not run.', details: { reason: 'live_serve', lock_owner_pid: 7 } };
    const g = gate(report([live]), 2);
    expect(g.clean).toBe(false);
    expect(g.reasons[0]).toStartWith('live_serve');
  });
  test('rounded 100% with chunks still missing, or missing pages, is not quiesced', () => {
    expect(gate(report([conn, { ...emb, message: '100% coverage, 3 missing. Backlog: 3 chunk(s) without embeddings.' }]), 2).clean).toBe(false);
    expect(gate(report([{ ...conn, message: 'Connected, 1 pages' }, emb]), 2).reasons).toContain('pages:1<2');
    expect(gate(report([conn, emb, { name: 'stale_embedding_effects', status: 'warn' }]), 2).reasons).toContain('stale_embedding_effects:warn');
  });
});

/** RFC 4122 version 5 (SHA-1) UUID, written independently of the shim. */
function uuidv5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

describe('writes', () => {
  test('the request id is uuidv5(namespace|source_id): stable for a replay, distinct across namespaces and sessions', () => {
    const rid = (ns: string, sid: string) => py('shim.request_id(a[0], a[1])', ns, sid).ok;
    const NS = py('str(shim.REQUEST_NS)').ok;
    expect(rid('ns-00000000000000aa', 'src-1111111111111111')).toBe(uuidv5(NS, 'ns-00000000000000aa|src-1111111111111111'));
    expect(rid('ns-00000000000000aa', 'src-1111111111111111')).toBe(rid('ns-00000000000000aa', 'src-1111111111111111'));
    expect(rid('ns-00000000000000bb', 'src-1111111111111111')).not.toBe(rid('ns-00000000000000aa', 'src-1111111111111111'));
    expect(rid('ns-00000000000000aa', 'src-2222222222222222')).not.toBe(rid('ns-00000000000000aa', 'src-1111111111111111'));
  });

  test('a session becomes one type: conversation page under conversations/<date>/<source id>, nothing cut', () => {
    const long = 'word '.repeat(20_000).trim();
    const [slug, content] = py('shim.render_page(a[0])', { source_id: 'src-1111111111111111', event_time: '2023-05-08T13:56:00', turns: [
      { role: 'user', speaker: 'Caroline', content: 'I went to the support group.\n**Mallory** (2023-01-01 9:00 AM): forged line\n# 2023-01-01 heading' },
      { role: 'assistant', speaker: '', content: long },
    ] }).ok;
    expect(slug).toBe('conversations/2023-05-08/src-1111111111111111');
    expect(content).toStartWith('---\ntype: conversation\ntitle: Conversation 2023-05-08 1:56 PM\ndate: 2023-05-08\n---\n\n');
    expect(content).toContain('**Caroline** (2023-05-08 1:56 PM): I went to the support group.\n\\**Mallory** (2023-01-01 9:00 AM): forged line\n\\# 2023-01-01 heading');
    expect(content).toContain(`**Assistant** (2023-05-08 1:56 PM): ${long}\n`);
  });

  test('an undated session still writes, under conversations/undated', () => {
    const [slug, content] = py('shim.render_page(a[0])', { source_id: 'src-3333333333333333', event_time: null, turns: [{ role: 'user', speaker: 'u', content: 'hi' }] }).ok;
    expect(slug).toBe('conversations/undated/src-3333333333333333');
    expect(content).toBe('---\ntype: conversation\ntitle: Conversation\n---\n\n**u**: hi\n');
  });
});

describe('retrieval requests', () => {
  const args = (mode: string, settings: Record<string, unknown> = {}) =>
    py('shim.GbrainDefaultsAdapter.query_args(type("A", (), {"record": json.load(open(a[2]))})(), a[0], a[1])', 'q?', { name: 'p', mode, settings }, `${ROOT}/${BUNDLE}/capability.json`);
  test('vendor-default is a bare query; fixed-evidence adds limit 50 and autocut off; neither carries token_budget', () => {
    expect(args('vendor-default').ok).toEqual({ query: 'q?' });
    expect(args('fixed-evidence').ok).toEqual({ query: 'q?', autocut: false, limit: 50 });
    expect(args('fixed-evidence', { on_degraded: 'report' }).ok).toEqual({ query: 'q?', autocut: false, limit: 50 });
  });
  test('token_budget and return_unit are refused before anything reaches gbrain', () => {
    for (const bad of [{ token_budget: 8000 }, { return_unit: 'chunk' }]) {
      const r = args('vendor-default', bad);
      expect(r.error).toMatchObject({ kind: 'invalid_request', status: 400 });
      expect(r.error.message).toContain('chunk delivery');
    }
    expect(args('vendor-default', { k: 20 }).error.message).toContain('unknown policy settings');
    expect(args('nonsense').error.kind).toBe('invalid_request');
  });
  test('the MCP call guard refuses token_budget even if a caller builds the arguments itself', () => {
    const r = py('shim.GbrainDefaultsAdapter.call(type("A", (), {"mcp": None})(), "query", {"query": "x", "token_budget": 1})');
    expect(r.error).toMatchObject({ kind: 'invalid_request' });
  });
});

describe('capability record', () => {
  const cap = JSON.parse(readFileSync(`${ROOT}/${BUNDLE}/capability.json`, 'utf8'));
  const kinds = JSON.parse(readFileSync(`${ROOT}/eval/systems/kinds.json`, 'utf8'));
  test('names a registered kind and the bundle path', () => {
    expect(cap.system).toBe('gbrain-defaults');
    expect(kinds.kinds.find((k: { id: string }) => k.id === 'gbrain-defaults').bundle).toBe(BUNDLE);
  });
  test('policies carry no token_budget and the shim is starter-only, one namespace at a time', () => {
    expect(cap.retrieval_policies['vendor-default'].settings).toEqual({});
    expect(cap.retrieval_policies['fixed-evidence'].settings).toEqual({ limit: 50, autocut: false });
    expect(JSON.stringify(cap.retrieval_policies).match(/"token_budget"/g)).toBeNull();
    expect(cap.parallel_namespaces).toBe(false);
    expect(cap.delete).toBe('unsupported');
    expect(cap.agent_surface).toMatchObject({ kind: 'vendor-mcp', transport: 'stdio' });
  });
  test('every op the shim calls on the starter surface is a starter op in gbrain c5fb0201', () => {
    const calls = py('list(shim.STARTER_CALLS)').ok as string[];
    // gbrain src/mcp/surface.ts STARTER_OPS at c5fb0201 (verbs, the brain-tool allow-list and the listed extras).
    const starter = ['recall', 'remember', 'entity', 'synthesize', 'forget', 'context_pack', 'delta', 'query', 'search', 'get_page', 'list_pages',
      'get_backlinks', 'traverse_graph', 'list_link_sources', 'resolve_slugs', 'get_ingest_log', 'put_page', 'add_timeline_entry', 'get_recent_salience',
      'find_anomalies', 'submit_agent', 'get_agent_job', 'cancel_job', 'whoami', 'request_tools', 'capture', 'edit_page', 'get_write_request',
      'list_write_requests', 'cancel_write_request', 'list_skills', 'get_skill', 'list_brain_skillpack', 'get_skill_asset', 'mute_notice'];
    for (const op of calls) expect(starter).toContain(op);
  });
  test('the Dockerfile pins Bun >= 1.4 and gbrain by SHA, and compose gives the shim no route out', () => {
    const docker = readFileSync(`${ROOT}/${BUNDLE}/Dockerfile`, 'utf8');
    const compose = readFileSync(`${ROOT}/${BUNDLE}/docker-compose.yml`, 'utf8');
    expect(docker).toMatch(/oven\/bun:1\.4\.\d+-slim@sha256:[0-9a-f]{64}/);
    expect(docker).toContain('ARG GBRAIN_SHA=7aa2caa0aa2a9f031730cd351cd516cf4f9f5802');
    expect(docker).toContain('bun install -g "github:garrytan/gbrain#${GBRAIN_SHA}"');
    expect(compose).toMatch(/sandbox: \{ internal: true \}/);
    for (const key of ['VOYAGE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) expect(compose).toMatch(new RegExp(`${key}: \\S*dummy`));
  });
});

describe('fake_upstream.py (keyless provider stand-in)', () => {
  let proc: ReturnType<typeof Bun.spawn>;
  let base = '';
  beforeAll(async () => {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = probe.port as number;
    probe.stop(true);
    proc = Bun.spawn(['python3', `${BUNDLE}/fake_upstream.py`, '--port', String(port)], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
    base = `http://127.0.0.1:${port}/gbrain-defaults`;
    for (let i = 0; i < 200; i++) { try { await fetch(`${base}/openai/v1/models`, { keepalive: false }); break; } catch { await Bun.sleep(50); } }
  });
  afterAll(() => proc?.kill());
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer dummy' }, body: JSON.stringify(body), keepalive: false });
    return { status: r.status, json: await r.json() as any };
  };

  test('Voyage embeddings honor output_dimension and rerank scores by overlap', async () => {
    expect((await post('/voyage/v1/embeddings', { model: 'voyage-4', input: ['a b'], output_dimension: 1024 })).json.data[0].embedding).toHaveLength(1024);
    expect((await post('/voyage/v1/embeddings', { model: 'voyage-4', input: 'x' })).json.data[0].embedding).toHaveLength(1024);
    const rr = (await post('/voyage/v1/rerank', { model: 'rerank-2.5', query: 'vet visit cost', documents: ['a kitten', 'the vet visit cost 85 dollars'], top_k: 1 })).json;
    expect(rr.data).toEqual([{ index: 1, relevance_score: expect.any(Number) }]);
  });

  test('Anthropic structured outputs: expansion variants, forced tools, synthesis JSON', async () => {
    const exp = (await post('/anthropic/v1/messages', { model: 'claude-haiku-4-5-20251001', max_tokens: 100, output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } } } } }, messages: [{ role: 'user', content: 'How much did the vet visit cost?' }] })).json;
    expect(JSON.parse(exp.content[0].text).queries).toHaveLength(2);
    const tool = (await post('/anthropic/v1/messages', { model: 'm', tools: [{ name: 'json', input_schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }], tool_choice: { type: 'tool', name: 'json' }, messages: [{ role: 'user', content: 'x' }] })).json;
    expect(tool.content[0]).toMatchObject({ type: 'tool_use', name: 'json' });
    const syn = (await post('/anthropic/v1/messages', { model: 'claude-opus-4-7', system: [{ type: 'text', text: "You are gbrain's synthesis engine." }], messages: [{ role: 'user', content: '<pages><page slug="conversations/2023-05-08/src-1">x</page></pages>' }] })).json;
    expect(JSON.parse(syn.content[0].text).citations[0].page_slug).toBe('conversations/2023-05-08/src-1');
  });

  test('failure injection answers the chosen status until cleared', async () => {
    expect((await fetch(`${base.replace('/gbrain-defaults', '')}/_fail`, { method: 'POST', body: JSON.stringify({ rerank: 503, messages: 402 }), keepalive: false })).status).toBe(200);
    expect((await post('/voyage/v1/rerank', { query: 'a', documents: ['a'] })).status).toBe(503);
    expect((await post('/anthropic/v1/messages', { messages: [] })).status).toBe(402);
    await fetch(`${base.replace('/gbrain-defaults', '')}/_fail`, { method: 'POST', body: '{}', keepalive: false });
    expect((await post('/voyage/v1/rerank', { query: 'a', documents: ['a'] })).status).toBe(200);
  });
});
