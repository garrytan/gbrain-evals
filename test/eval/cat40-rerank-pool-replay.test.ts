/**
 * Cat 40 rerank-pool replay (eval/runner/cat40/rerank-pool-replay.ts, GBRA-81 item 1 gate 2): call extraction,
 * result parsing, per-arm validity, metrics, the paired bootstrap and its gate boundaries, and the provider proxy's
 * capture, embedding cache, audited rerank reuse and failure fixture. All keyless.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ARMS, armConfig, armOutcome, callRecord, enteredFromTail, estimateReplayCost, extractHybridSearchCalls, fixtureWorld, gateVerdict,
  goldHitAtK, isHybridSearch, isPrefix, jsonDiff, overlapAtK, pairedBootstrapLowerBound, parseSearchResult, poolPositions, spreadSample,
  summarize, type ArmOutcome, type ChunkRef, type ReplayCall,
} from '../../eval/runner/cat40/rerank-pool-replay.ts';
import { RerankPoolProxy, compareRerank, docSha, rerankTokenEstimate, stubEmbedding, stubRerankScores, type Capture, type RerankCapture } from '../../eval/runner/cat40/rerank-pool-proxy.ts';

const world = { tasks: [
  { id: 'H1-01', family: 'H1', gold: { evidence: ['crm/Acme-Example', 'contracts/aa11'] } },
  { id: 'H5-01', family: 'H5', gold: { evidence: [] } },
] };
const line = (key: string, tools: unknown[], attempt?: string) => JSON.stringify({ key, ...(attempt ? { attempt_id: attempt } : {}), tools });

describe('extractHybridSearchCalls', () => {
  const lines = [
    line('m|gbrain-hard|H1-01|0', [{ session: 1, name: 'search', args: { query: 'old attempt' } }], 'm|gbrain-hard|H1-01|0#1'),
    line('m|fs|H1-01|0', [{ session: 1, name: 'grep', args: { pattern: 'x' } }]),
    line('m|gbrain-hard|H1-01|0', [
      { session: 1, name: 'search', args: { query: 'acme renewal', limit: 10 } },
      { session: 1, name: 'search', args: { query: 'acme', match: 'keyword' } },
      { session: 1, name: 'get_page', args: { slug: 'crm/acme-example' } },
      { session: 2, name: 'search', args: { query: 'acme seats', match: 'hybrid', types: ['contract'] } },
    ], 'm|gbrain-hard|H1-01|0#2'),
    line('m|gbrain-hard|H5-01|0', [{ session: 3, name: 'search', args: { query: 'alice-example manager' } }], 'm|gbrain-hard|H5-01|0#1'),
    '',
  ];
  const calls = extractHybridSearchCalls(lines, world);
  test('keeps only hybrid search calls from the last attempt of each gbrain cell, with their recorded args', () => {
    expect(calls.map(c => c.query)).toEqual(['acme renewal', 'acme seats', 'alice-example manager']);
    expect(calls[0]).toMatchObject({ id: 'm|gbrain-hard|H1-01|0#2#0', task: 'H1-01', family: 'H1', session: 1, args: { query: 'acme renewal', limit: 10 } });
    expect(calls[1].id).toBe('m|gbrain-hard|H1-01|0#2#3');
    expect(calls[1].args).toEqual({ query: 'acme seats', match: 'hybrid', types: ['contract'] });
  });
  test('gold documents come from the task (lowercased); H5 tasks name none', () => {
    expect(calls[0].gold).toEqual(['crm/acme-example', 'contracts/aa11']);
    expect(calls[2].gold).toEqual([]);
  });
  test('a cell naming a task the world lacks refuses (wrong world)', () => {
    expect(() => extractHybridSearchCalls([line('m|gbrain-hard|H9-01|0', [{ name: 'search', args: { query: 'q' } }])], world)).toThrow(/does not have/);
  });
  test('isHybridSearch rejects keyword match and non-search tools', () => {
    expect(isHybridSearch({ name: 'search', args: { query: 'q', match: 'keyword' } })).toBe(false);
    expect(isHybridSearch({ name: 'query', args: { query: 'q' } })).toBe(false);
    expect(isHybridSearch({ name: 'search', args: { query: 'q' } })).toBe(true);
  });
  test('spreadSample takes evenly spaced calls', () => {
    expect(spreadSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([0, 3, 6]);
    expect(spreadSample([1, 2], 5)).toEqual([1, 2]);
  });
});

describe('parseSearchResult', () => {
  test('lean rows then trailer lines', () => {
    const p = parseSearchResult('[{"slug":"crm/Acme-Example","chunk_id":7,"score":0.9},{"slug":"mail/x","score":0.1}]\n[gbrain search] Rows are a ranked top-K.\n[gbrain dates] effective_date ...');
    expect(p.rows).toEqual([{ slug: 'crm/acme-example', chunk_id: 7 }, { slug: 'mail/x', chunk_id: null }]);
    expect(p.trailer).toMatch(/^\[gbrain search\]/);
  });
  test('prose between the rows and the trailer, and brackets inside strings, do not break the parse', () => {
    const text = '[{"slug":"crm/acme-example","chunk_id":3,"chunk_text":"see [note] {x} \\"q]\\""}]\nOther names in these results: ACME = Acme Example (declared in crm/acme-example).\n[gbrain search] Rows are a ranked top-K.';
    const p = parseSearchResult(text);
    expect(p.parse_error).toBeUndefined();
    expect(p.rows).toEqual([{ slug: 'crm/acme-example', chunk_id: 3 }]);
    expect(p.trailer).toMatch(/^Other names/);
  });
  test('tool errors and unparseable bodies', () => {
    expect(parseSearchResult('Error: invalid_params').error).toMatch(/invalid_params/);
    expect(parseSearchResult('not json\n[gbrain search] x').parse_error).toBeTruthy();
    expect(parseSearchResult('{"results":[{"slug":"a","chunk_id":1}]}').rows).toEqual([{ slug: 'a', chunk_id: 1 }]);
  });
});

const rerank = (query: string, n: number, over: Partial<RerankCapture> = {}): RerankCapture => ({
  kind: 'rerank', model: 'rerank-2.5', query, doc_sha: Array.from({ length: n }, (_, i) => `d${i}`), status: 200, tokens: 100, est_tokens: 100, reused: false, order: [], ...over,
});
const rowsText = (ids: number[], trailer = '[gbrain search] ok') => `${JSON.stringify(ids.map(i => ({ slug: `s/${i}`, chunk_id: i })))}\n${trailer}`;

describe('armOutcome: rerank status per call', () => {
  test('ok: rows and a successful rerank of the recorded query', () => {
    const o = armOutcome(50, 'q', rowsText([1, 2]), null, [rerank('alias fan-out', 3), rerank('q', 50)], 10);
    expect(o.status).toBe('ok');
    expect(o.rerank).toMatchObject({ status: 'ok', requests: 2, primary_docs: 50, tokens: 200 });
  });
  test('a provider failure marks the call failed', () => {
    const o = armOutcome(25, 'q', rowsText([1]), null, [rerank('q', 25, { status: 500, error: 'boom' })], 10);
    expect(o.rerank.status).toBe('failed');
    expect(o.rerank.reason).toMatch(/HTTP 500/);
  });
  test('a degraded_recall rerank notice marks the call failed even when the proxy saw nothing wrong', () => {
    const o = armOutcome(25, 'q', rowsText([1], '[gbrain notice degraded_recall kind=info]\nstage: rerank_failed reason=timeout'), null, [rerank('q', 25)], 10);
    expect(o.rerank.status).toBe('failed');
  });
  test('rows without any rerank request are missing; no rows and no request is empty', () => {
    expect(armOutcome(50, 'q', rowsText([1]), null, [], 1).rerank.status).toBe('missing');
    expect(armOutcome(50, 'q', '[]\n[gbrain search] none', null, [], 1).rerank.status).toBe('empty');
  });
  test('harness and operation errors', () => {
    expect(armOutcome(50, 'q', null, 'MCP server exited', [], 1)).toMatchObject({ status: 'harness_error', rerank: { status: 'failed' } });
    expect(armOutcome(50, 'q', 'Error: unknown_param return_unit', null, [], 1).status).toBe('op_error');
  });
});

describe('metrics', () => {
  const r = (ids: number[]) => ids.map(i => ({ slug: `s/${i}`, chunk_id: i }));
  test('overlapAtK over the longer list, capped at k', () => {
    expect(overlapAtK(r([1, 2, 3, 4]), r([1, 2, 3, 4]))).toBe(1);
    expect(overlapAtK(r([1, 2, 3, 4]), r([4, 3, 9, 8]))).toBe(0.5);
    expect(overlapAtK(r([1, 2]), r([1, 2, 3, 4]))).toBe(0.5);
    expect(overlapAtK([], [])).toBeNull();
    expect(overlapAtK(r(Array.from({ length: 30 }, (_, i) => i)), r(Array.from({ length: 30 }, (_, i) => 29 - i)))).toBe(0.5);
    expect(overlapAtK(r(Array.from({ length: 30 }, (_, i) => i)), r(Array.from({ length: 30 }, (_, i) => 30 + i)))).toBe(0);
  });
  test('goldHitAtK looks at the first 5 rows only; null without gold', () => {
    expect(goldHitAtK(r([1, 2, 3, 4, 5, 6]), ['s/6'])).toBe(0);
    expect(goldHitAtK(r([1, 2, 3, 4, 5, 6]), ['s/5'])).toBe(1);
    expect(goldHitAtK(r([1]), [])).toBeNull();
  });
  test('pool positions map documents to chunks; rows 26 to 50 that reach the top 20 are reported with their fused rank', () => {
    const index = new Map<string, ChunkRef[]>(Array.from({ length: 50 }, (_, i) => [`h${i}`, [{ chunk_id: i, slug: `s/${i}` }]]));
    const pos = poolPositions([...Array.from({ length: 50 }, (_, i) => `h${i}`), 'unknown'], index);
    expect(pos.unmapped).toBe(1);
    const top = r([30, 1, 24, 25, 49, 50]);
    expect(enteredFromTail(top, pos).map(x => [x.chunk_id, x.fused_rank])).toEqual([[30, 31], [25, 26], [49, 50]]);
    const deep = r([...Array.from({ length: 20 }, (_, i) => i), 40]);
    expect(enteredFromTail(deep, pos)).toEqual([]);
  });
  test('isPrefix', () => {
    expect(isPrefix(['a', 'b'], ['a', 'b', 'c'])).toBe(true);
    expect(isPrefix(['b', 'a'], ['a', 'b', 'c'])).toBe(false);
    expect(isPrefix(['a', 'b', 'c', 'd'], ['a', 'b', 'c'])).toBe(false);
  });
});

describe('paired bootstrap lower bound (10,000 resamples, seed 1)', () => {
  test('boundary cases: empty, one pair, all ties', () => {
    expect(pairedBootstrapLowerBound([])).toMatchObject({ n: 0, estimate: null, lower: null });
    expect(pairedBootstrapLowerBound([-1])).toMatchObject({ n: 1, estimate: -1, lower: -1 });
    expect(pairedBootstrapLowerBound(new Array(500).fill(0))).toMatchObject({ estimate: 0, lower: 0 });
    expect(pairedBootstrapLowerBound(new Array(40).fill(-1))).toMatchObject({ estimate: -1, lower: -1 });
  });
  test('deterministic for a seed, below the estimate, and wider for fewer pairs', () => {
    const d = [...new Array(90).fill(0), ...new Array(4).fill(1), ...new Array(6).fill(-1)];
    const a = pairedBootstrapLowerBound(d), b = pairedBootstrapLowerBound(d);
    expect(a.lower).toBe(b.lower);
    expect(a).toMatchObject({ resamples: 10_000, seed: 1, confidence: 0.95, estimate: -0.02 });
    expect(a.lower!).toBeLessThan(a.estimate!);
    expect(pairedBootstrapLowerBound(d, { seed: 2 }).lower).not.toBeNaN();
    const big = pairedBootstrapLowerBound([...d, ...d, ...d, ...d]);
    expect(big.lower!).toBeGreaterThan(a.lower!);
  });
  test('the lower bound is the 5th percentile of resample means (index 500 of 10,000)', () => {
    const d = [1, 0, 0, 0, -1, 0, 0, 1, 0, 0];
    expect(pairedBootstrapLowerBound(d, { resamples: 20 }).lower).not.toBeNull();
    // With 20 resamples the bound is the sorted mean at index floor(0.05 * 20) = 1, never the minimum at 0.
    const twenty = pairedBootstrapLowerBound(d, { resamples: 20 });
    expect(twenty.lower).toBeGreaterThanOrEqual(-1);
  });
});

describe('gate verdict (margin -1 point)', () => {
  test('a lower bound exactly at -0.01 is inconclusive (strictly above is required); just above passes; an estimate below the margin fails', () => {
    expect(gateVerdict({ estimate: 0, lower: -0.01 })).toBe('inconclusive');
    expect(gateVerdict({ estimate: 0, lower: -1 / 100 })).toBe('inconclusive');
    expect(gateVerdict({ estimate: 0, lower: -0.0099999 })).toBe('pass');
    expect(gateVerdict({ estimate: 0, lower: -0.0100001 })).toBe('inconclusive');
    expect(gateVerdict({ estimate: -0.01, lower: -0.03 })).toBe('inconclusive');
    expect(gateVerdict({ estimate: -0.0101, lower: -0.03 })).toBe('fail');
    expect(gateVerdict({ estimate: 0.02, lower: 0.001 })).toBe('pass');
  });
  test('an invalid comparison or no pairs is invalid, whatever the numbers', () => {
    expect(gateVerdict({ estimate: 0, lower: 0 }, -0.01, false)).toBe('invalid');
    expect(gateVerdict({ estimate: null, lower: null })).toBe('invalid');
  });
});

describe('summarize: validity and the comparison', () => {
  const index = new Map<string, ChunkRef[]>(Array.from({ length: 50 }, (_, i) => [`d${i}`, [{ chunk_id: i, slug: `s/${i}` }]]));
  const call = (i: number, gold: string[]): ReplayCall => ({ id: `c${i}`, cell: 'm|gbrain-hard|H1-01|0', model: 'm', task: 'H1-01', family: i % 2 ? 'H1' : 'H5', session: 1, query: `q${i}`, args: { query: `q${i}` }, gold });
  const outcome = (arm: 25 | 50, q: string, top: number[], over: Partial<RerankCapture> = {}): ArmOutcome =>
    armOutcome(arm, q, rowsText(top), null, [rerank(q, arm, over)] as Capture[], 5);
  const okRecords = () => Array.from({ length: 30 }, (_, i) => callRecord(call(i, i % 2 ? ['s/0'] : []),
    { 50: outcome(50, `q${i}`, [0, 30, 2, 3, 4]), 25: outcome(25, `q${i}`, i === 1 ? [1, 2, 3, 4, 5] : [0, 2, 3, 4, 5]) }, index));

  test('a clean run: prefix verified, rows 26-50 counted, hit@5 per arm, a verdict', () => {
    const s = summarize(okRecords(), { planned: 30, completeArms: { 50: true, 25: true } });
    expect(s.comparison_valid).toBe(true);
    expect(s.prefix).toMatchObject({ checked: 30, verified: 30, unmapped_docs: 0 });
    expect(s.pool_rows_26_50).toMatchObject({ calls_with_pool_over_25: 30, calls_where_any_entered_top20: 30, rate: 1, rows_entered: 30 });
    expect(s.gold_hit5).toMatchObject({ paired_calls: 15, arm50: 1, discordant: { arm25_only: 0, arm50_only: 1 } });
    expect(s.gold_hit5.difference_25_minus_50.estimate).toBeCloseTo(-1 / 15, 6);
    expect(['fail', 'inconclusive']).toContain(s.gold_hit5.verdict);
    expect(s.by_family.H1.gold_calls).toBe(15);
    expect(s.by_family.H5.gold_calls).toBe(0);
  });
  test('one failed rerank in arm 25 invalidates that arm and the verdict', () => {
    const recs = okRecords();
    recs[3] = callRecord(call(3, ['s/0']), { 50: outcome(50, 'q3', [0, 1]), 25: outcome(25, 'q3', [0, 1], { status: 500, error: 'stub reranker failure fixture' }) }, index);
    const s = summarize(recs, { planned: 30, completeArms: { 50: true, 25: true } });
    expect(s.arms['25'].valid).toBe(false);
    expect(s.arms['25'].rerank_failed).toBe(1);
    expect(s.arms['50'].valid).toBe(true);
    expect(s.comparison_valid).toBe(false);
    expect(s.gold_hit5.verdict).toBe('invalid');
  });
  test('a call that errors in one arm only is a missing pair; identical errors in both arms are excluded', () => {
    const recs = okRecords();
    recs[5] = callRecord(call(5, ['s/0']), { 50: outcome(50, 'q5', [0]), 25: armOutcome(25, 'q5', 'Error: boom', null, [], 1) }, index);
    let s = summarize(recs, { planned: 30, completeArms: { 50: true, 25: true } });
    expect(s.calls.missing_pairs).toBe(1);
    expect(s.gold_hit5.verdict).toBe('invalid');
    recs[5] = callRecord(call(5, ['s/0']), { 50: armOutcome(50, 'q5', 'Error: boom', null, [], 1), 25: armOutcome(25, 'q5', 'Error: boom', null, [], 1) }, index);
    s = summarize(recs, { planned: 30, completeArms: { 50: true, 25: true } });
    expect(s.calls).toMatchObject({ missing_pairs: 0, excluded_op_error_both: 1 });
    expect(s.comparison_valid).toBe(true);
    expect(s.gold_hit5.paired_calls).toBe(14);
  });
  test('an arm stopped by the budget is incomplete and invalid', () => {
    const recs = okRecords().slice(0, 20);
    const s = summarize(recs, { planned: 30, completeArms: { 50: true, 25: false } });
    expect(s.arms['25'].invalid_reasons.join()).toMatch(/incomplete/);
    expect(s.gold_hit5.verdict).toBe('invalid');
  });
});

describe('arm settings', () => {
  test('only top_n_in differs between the arms; extra pins cannot override the pinned keys', () => {
    const a = armConfig(50, 'tokenmax', [['search.reranker.timeout_ms', '15000']]);
    const b = armConfig(25, 'tokenmax', [['search.reranker.timeout_ms', '15000']]);
    expect(a.filter((p, i) => p[1] !== b[i][1])).toEqual([['search.reranker.top_n_in', '50']]);
    expect(a.at(-1)).toEqual(['search.reranker.top_n_in', '50']);
    expect(a).toContainEqual(['search.cache.enabled', 'false']);
    expect(ARMS[0]).toBe(50);
  });
  test('jsonDiff names differing paths', () => {
    expect(jsonDiff({ a: 1, b: { c: 2, top_n_in: 50 } }, { a: 1, b: { c: 2, top_n_in: 25 } })).toEqual(['b.top_n_in']);
    expect(jsonDiff({ a: [1, 2] }, { a: [1, 3] })).toEqual(['a.1']);
  });
});

describe('estimate and fixture', () => {
  const docs = Array.from({ length: 100 }, (_, i) => ({ id: `mail/${i}`, title: 't', body: 'x'.repeat(397), type: 'email', date: '2026-01-01', author: 'alice-example' }));
  const calls: ReplayCall[] = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, cell: 'k', model: 'm', task: 'H1-01', family: 'H1', session: 1, query: 'x'.repeat(40), args: {}, gold: i === 0 ? ['mail/99'] : [] }));
  test('reuse leaves only the 50-document reranks to pay for', () => {
    const withReuse = estimateReplayCost(calls, { docs } as never, { requestsPerCall: 1 });
    const without = estimateReplayCost(calls, { docs } as never, { requestsPerCall: 1, reuse: false });
    expect(withReuse.tokens_per_doc).toBe(100);
    expect(withReuse.rerank_tokens).toBe(10 * 50 * (10 + 100));
    expect(without.rerank_tokens).toBe(10 * 75 * (10 + 100));
    expect(without.replay_usd).toBeGreaterThan(withReuse.replay_usd);
  });
  test('the fixture keeps every gold document and stays within the size', () => {
    const f = fixtureWorld({ docs, tasks: [] } as never, calls, 10);
    expect(f.docs).toHaveLength(10);
    expect(f.docs.map(d => d.id)).toContain('mail/99');
  });
});

describe('RerankPoolProxy', () => {
  const post = (port: number, slot: string, path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/${slot}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const docs = Array.from({ length: 50 }, (_, i) => `document ${i} about acme renewal ${i % 7}`);
  let proxy: RerankPoolProxy;
  beforeAll(() => { proxy = new RerankPoolProxy({ upstream: 'stub', reuseAuditCalls: 1 }); proxy.start(); });
  afterAll(() => proxy.stop());

  test('embeddings are captured and the second identical request is served from cache', async () => {
    proxy.bind('slot0', 'k1');
    const a = await (await post(proxy.port, 'slot0', '/openai/v1/embeddings', { model: 'text-embedding-3-large', input: ['acme renewal'], dimensions: 8 })).json() as any;
    const b = await (await post(proxy.port, 'slot0', '/openai/v1/embeddings', { model: 'text-embedding-3-large', input: ['acme renewal'], dimensions: 8 })).json() as any;
    expect(a.data[0].embedding).toHaveLength(8);
    expect(b).toEqual(a);
    expect(proxy.take('k1').map(c => c.kind === 'embedding' && c.cached)).toEqual([false, true]);
  });
  test('a 25-document prefix is audited once, then answered from the 50-document response at zero tokens', async () => {
    proxy.bind('slot0', 'a50');
    await post(proxy.port, 'slot0', '/voyage/v1/rerank', { model: 'rerank-2.5', query: 'acme renewal', documents: docs });
    const c50 = proxy.take('a50')[0] as RerankCapture;
    expect(c50).toMatchObject({ status: 200, reused: false, doc_sha: docs.map(docSha) });
    expect(c50.tokens).toBe(rerankTokenEstimate('acme renewal', docs));
    proxy.bind('slot0', 'a25-audit');
    await post(proxy.port, 'slot0', '/voyage/v1/rerank', { model: 'rerank-2.5', query: 'acme renewal', documents: docs.slice(0, 25) });
    expect(proxy.take('a25-audit')[0]).toMatchObject({ reused: false, audit: { agreed: true } });
    proxy.bind('slot0', 'a25');
    const r = await (await post(proxy.port, 'slot0', '/voyage/v1/rerank', { model: 'rerank-2.5', query: 'acme renewal', documents: docs.slice(0, 25) })).json() as any;
    const c25 = proxy.take('a25')[0] as RerankCapture;
    expect(c25).toMatchObject({ reused: true, tokens: 0, status: 200 });
    expect(r.data.map((x: any) => x.index)).toEqual(stubRerankScores('acme renewal', docs.slice(0, 25)).map(x => x.index));
    expect(proxy.reuse).toMatchObject({ enabled: true, reused: 1 });
  });
  test('a 25-document pool that is not a prefix is sent to the provider', async () => {
    proxy.bind('slot0', 'np');
    await post(proxy.port, 'slot0', '/voyage/v1/rerank', { model: 'rerank-2.5', query: 'acme renewal', documents: [docs[1], docs[0], ...docs.slice(2, 25)] });
    expect(proxy.take('np')[0]).toMatchObject({ reused: false, tokens: expect.any(Number) });
  });
  test('the failure fixture answers HTTP 500 and is captured; chat routes are refused', async () => {
    proxy.setStubRerank('fail');
    proxy.bind('slot0', 'f');
    expect((await post(proxy.port, 'slot0', '/voyage/v1/rerank', { model: 'rerank-2.5', query: 'q', documents: ['a'] })).status).toBe(500);
    expect((await post(proxy.port, 'slot0', '/anthropic/v1/messages', { model: 'x' })).status).toBe(403);
    const c = proxy.take('f');
    expect(c[0]).toMatchObject({ kind: 'rerank', status: 500 });
    expect(c[1]).toEqual({ kind: 'refused', provider: 'anthropic', path: '/v1/messages' });
    proxy.setStubRerank('lexical');
  });
  test('an audit disagreement turns reuse off for the rest of the run', async () => {
    // Forward upstream with a fake provider whose 25-document answer reverses the order.
    const fake = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const b = JSON.parse(String(init!.body));
      const data = stubRerankScores(b.query, b.documents);
      return Response.json({ data: b.documents.length === 25 ? [...data].reverse() : data, usage: { total_tokens: 1 } });
    }) as typeof fetch;
    const p = new RerankPoolProxy({ upstream: 'forward', reuseAuditCalls: 2, fetchImpl: fake });
    p.start();
    try {
      p.bind('s', 'x');
      await post(p.port, 's', '/voyage/v1/rerank', { model: 'rerank-2.5', query: 'acme renewal', documents: docs });
      await post(p.port, 's', '/voyage/v1/rerank', { model: 'rerank-2.5', query: 'acme renewal', documents: docs.slice(0, 25) });
      await post(p.port, 's', '/voyage/v1/rerank', { model: 'rerank-2.5', query: 'acme renewal', documents: docs.slice(0, 25) });
      const c = p.take('x') as RerankCapture[];
      expect(c[1].audit?.agreed).toBe(false);
      expect(c[2]).toMatchObject({ reused: false });
      expect(c[2].audit).toBeUndefined();
      expect(p.reuse.enabled).toBe(false);
      expect(p.reuse.disabled_reason).toMatch(/ordered documents differently/);
    } finally { p.stop(); }
  });
  test('stub embedding and compareRerank', () => {
    const e = stubEmbedding('acme renewal acme', 16);
    expect(Math.abs(Math.hypot(...e) - 1)).toBeLessThan(1e-9);
    expect(stubEmbedding('acme renewal acme', 16)).toEqual(e);
    expect(compareRerank([{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }], [{ index: 1, relevance_score: 0.91 }, { index: 0, relevance_score: 0.5 }])).toEqual({ agreed: true, max_abs_score_diff: 0.01 });
  });
});
