import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BudgetRun, closeLedgers, initLedger } from '../../eval/runner/budget-ledger.ts';
import { ChatClient, chatCacheKey, latestDate, renderHistory, sendsTemperature, sessionDateKey } from '../../eval/runner/memory-qa/qa-v2.ts';
import { ledgerRerankRequests, loadFrozenRetrieval, parseRunArgs, resolveReranker, runArm, scoreRetrieval } from '../../eval/runner/memory-qa/run.ts';
import { DecideError } from '../../eval/runner/decisions/errors.ts';
import { loadFixture } from '../../eval/runner/memory-qa/corpus.ts';

const tmp = mkdtempSync(join(tmpdir(), 'memory-qa-arms-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => closeLedgers());

const session = (id: string, date: string) => ({ id, date, turns: [{ speaker: 'user', content: `text of ${id}` }] });

describe('reader session order', () => {
  test('BEAM Month-DD-YYYY dates are read in calendar order, not alphabetically by month name', () => {
    const history = renderHistory([session('mar', 'March-05-2024'), session('jan', 'January-10-2024'), session('feb', 'February-01-2024'), session('dec', 'December-28-2023')]);
    const order = ['dec', 'jan', 'feb', 'mar'].map(id => history.indexOf(`text of ${id}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(sessionDateKey('March-05-2024')).toBe('2024-03-05');
  });

  test('the fallback current date is the latest session, not the alphabetically last month', () => {
    expect(latestDate([session('a', 'September-20-2024'), session('b', 'December-05-2024'), session('c', 'January-02-2024')] as never)).toBe('December-05-2024');
  });

  test('other date formats keep their string order and stay byte-identical', () => {
    for (const d of ['2023/05/20 (Sat) 02:21', '2026-02-11', '1:56 pm on 8 May, 2023', 'unknown']) expect(sessionDateKey(d)).toBe(d);
    const lme = [session('b', '2023/05/21 (Sun) 10:00'), session('a', '2023/05/20 (Sat) 02:21')];
    expect(renderHistory(lme)).toBe(renderHistory([...lme].reverse()));
    expect(renderHistory(lme).indexOf('text of a')).toBeLessThan(renderHistory(lme).indexOf('text of b'));
  });
});

describe('reader sampling', () => {
  test('Claude 5-family readers get no temperature (the API rejects it); older Claude and gpt-4.1-mini keep temperature 0', async () => {
    expect([sendsTemperature('anthropic:claude-sonnet-5-5'), sendsTemperature('anthropic:claude-opus-5-5'), sendsTemperature('anthropic:claude-sonnet-4-6')]).toEqual([false, false, true]);
    expect([sendsTemperature('openai:gpt-4.1-mini'), sendsTemperature('openai:gpt-6.1-sol')]).toEqual([true, false]);
    const bodies: Array<Record<string, unknown>> = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }), { status: 200 });
    }) as never;
    try {
      const c = new ChatClient(join(tmp, 'sampling-cache'));
      const five = await c.chat('anthropic:claude-sonnet-5-5', 'p', { maxTokens: 5, replicate: 0 });
      await c.chat('anthropic:claude-sonnet-4-6', 'p', { maxTokens: 5, replicate: 0 });
      expect('temperature' in bodies[0]).toBe(false);
      expect(bodies[1].temperature).toBe(0);
      expect(five.finish).toBe('end_turn');
    } finally { globalThis.fetch = real; }
  });
});

describe('output floors for models that always reason (A19)', () => {
  test('a Claude 5-family or GPT-6 judge asked for 10 tokens is sent 2,000; older models, Claude rubric and reader calls are sent what was asked', async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const real = globalThis.fetch;
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test';
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = String(i);
      bodies.push({ url, body: JSON.parse(String(init?.body)) });
      return url.includes('anthropic')
        ? new Response(JSON.stringify({ content: [{ type: 'text', text: 'yes' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'yes' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    }) as never;
    try {
      const c = new ChatClient(join(tmp, 'floor-cache'));
      await c.chat('anthropic:claude-opus-5-5', 'judge', { maxTokens: 10, replicate: 0, temperature: null });
      await c.chat('anthropic:claude-sonnet-4-6', 'judge', { maxTokens: 10, replicate: 0 });
      await c.chat('anthropic:claude-opus-5-5', 'read', { maxTokens: 2048, replicate: 0 });
      await c.chat('anthropic:claude-opus-5-5', 'rubric', { maxTokens: 1024, replicate: 0, temperature: null });
      await c.chat('openai:gpt-6.1-sol', 'judge', { maxTokens: 10, replicate: 0, temperature: null });
      await c.chat('openai:gpt-4.1-mini', 'judge', { maxTokens: 1024, replicate: 0 });
      expect(bodies.map(b => b.body.max_tokens ?? b.body.max_completion_tokens)).toEqual([2000, 10, 2048, 1024, 2000, 1024]);
      const key = (model: string, maxTokens: number) => chatCacheKey(model, 'judge', { maxTokens, replicate: 0, temperature: null });
      expect(key('anthropic:claude-opus-5-5', 10)).not.toBe(key('anthropic:claude-opus-5-5', 2000));
      expect(createHash('sha256').update(JSON.stringify({ provider: 'anthropic', name: 'claude-opus-5-5', prompt: 'judge', maxTokens: 1024, temperature: 'default', replicate: 0 })).digest('hex')).toBe(key('anthropic:claude-opus-5-5', 1024));
    } finally { globalThis.fetch = real; if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; }
  });
});

describe('frozen ranked lists', () => {
  test('shard directories and gzip rows load; errored rows are skipped', () => {
    const dir = join(tmp, 'frozen-load');
    mkdirSync(join(dir, 'shard-0'), { recursive: true });
    mkdirSync(join(dir, 'shard-1'), { recursive: true });
    writeFileSync(join(dir, 'shard-0', 'rows.ndjson.gz'), gzipSync(JSON.stringify({ id: 'q1', retrieved: ['s1', 's2'], error: null }) + '\n'));
    writeFileSync(join(dir, 'shard-1', 'rows.ndjson'), [JSON.stringify({ id: 'q2', retrieved: ['s3'], error: null }), JSON.stringify({ id: 'q3', error: 'boom' })].join('\n') + '\n');
    const { lists, files } = loadFrozenRetrieval(dir);
    expect([...lists.entries()]).toEqual([['q1', ['s1', 's2']], ['q2', ['s3']]]);
    expect(files).toHaveLength(2);
    expect(files.every(f => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  test('a replay rescores the frozen lists without building a brain', async () => {
    const fx = loadFixture();
    const frozenDir = join(tmp, 'frozen-fixture');
    mkdirSync(frozenDir, { recursive: true });
    const lists = new Map(fx.questions.map(q => [q.id, q.abstention ? ['s1'] : [...q.gold].reverse().concat(['s1'])]));
    writeFileSync(join(frozenDir, 'rows.ndjson'), [...lists].map(([id, retrieved]) => JSON.stringify({ id, retrieved, error: null })).join('\n') + '\n');
    const out = join(tmp, 'replay-out');
    const { receipt, rows } = await runArm(parseRunArgs(['--benchmark', 'fixture', '--retrieved-from', frozenDir, '--output', out]));
    expect(receipt.run_status).toBe('complete');
    expect(String(receipt.retrieval_path)).toContain('frozen ranked lists');
    expect((receipt.embedding as { cache_stats: unknown }).cache_stats).toBeNull();
    for (const r of rows) {
      expect(r.retrieved).toEqual(lists.get(r.id)!.slice(0, 10));
      if (!r.abstention) expect(r).toMatchObject(scoreRetrieval(lists.get(r.id)!, fx.questions.find(q => q.id === r.id)!.gold));
      expect(r.latency_ms).toBeUndefined();
    }
  }, 60_000);
});

describe('reading arms without retrieval', () => {
  const runReader = async (context: 'none' | 'oracle', label: string) => {
    const ledger = join(tmp, `${label}.sqlite`);
    initLedger({ ledgerPath: ledger });
    const prompts: string[] = [];
    const real = globalThis.fetch;
    const prevCache = process.env.GBRAIN_EVALS_QA_CACHE;
    process.env.GBRAIN_EVALS_QA_CACHE = join(tmp, `${label}-qa-cache`);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[0].content;
      prompts.push(prompt);
      const text = prompt.startsWith('I will give you several history chats') ? 'The answer.' : 'yes';
      return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never;
    try {
      const out = join(tmp, `${label}-out`);
      const res = await runArm(parseRunArgs(['--benchmark', 'fixture', '--qa', 'reader', '--qa-context', context, '--reader', 'openai:gpt-4o-mini', '--judge', 'openai:gpt-4o-mini',
        '--paid', '--budget-run-id', BudgetRun.open({ runner: 'test', budgetUsd: 1, estimateUsd: 0.1, ledgerPath: ledger }).runId, '--budget-ledger', ledger, '--output', out]));
      return { ...res, readerPrompts: prompts.filter(p => p.startsWith('I will give you several history chats')) };
    } finally {
      globalThis.fetch = real;
      if (prevCache === undefined) delete process.env.GBRAIN_EVALS_QA_CACHE; else process.env.GBRAIN_EVALS_QA_CACHE = prevCache;
    }
  };

  test('no memory: the reader sees an empty history and no retrieval is scored', async () => {
    const fx = loadFixture();
    const { receipt, rows, readerPrompts } = await runReader('none', 'nomem');
    expect(readerPrompts).toHaveLength(fx.questions.length);
    expect(readerPrompts.every(p => p.includes('History Chats:\n\n\n\nCurrent Date:') && !p.includes('### Session'))).toBe(true);
    expect(rows.every(r => r.retrieved === undefined && typeof r.qa_score === 'number' && r.qa_sessions === 0)).toBe(true);
    expect((receipt.summary as Record<string, unknown>).recall_all_at_5).toBeNull();
    expect(rows.every(r => r.qa_answer === 'The answer.')).toBe(true);
  }, 60_000);

  test('oracle: the reader sees exactly the gold sessions', async () => {
    const fx = loadFixture();
    const { rows, readerPrompts } = await runReader('oracle', 'oracle');
    for (const q of fx.questions) {
      const p = readerPrompts.find(x => x.includes(`Question: ${q.question}\n`))!;
      expect((p.match(/### Session \d+:/g) ?? []).length).toBe(q.gold.length);
      const conv = fx.conversations.find(c => c.id === q.conversation)!;
      for (const s of conv.sessions) expect(p.includes(JSON.stringify(s.turns.map(t => ({ role: t.speaker, content: t.content }))))).toBe(q.gold.includes(s.id));
      expect(rows.find(r => r.id === q.id)!.qa_sessions).toBe(q.gold.length);
    }
  }, 60_000);

  test('think and the facts lane are refused without a brain', async () => {
    await expect(runArm(parseRunArgs(['--benchmark', 'fixture', '--qa', 'think', '--qa-context', 'none', '--output', join(tmp, 'refuse-1')]))).rejects.toThrow('--qa reader');
    await expect(runArm(parseRunArgs(['--benchmark', 'fixture', '--qa', 'reader', '--retrieved-from', tmp, '--facts', 'conversation', '--output', join(tmp, 'refuse-2')]))).rejects.toThrow('build no brain');
  });
});

describe('reranker fidelity', () => {
  test('the ledger count sees only this run\'s rerank requests', () => {
    const ledger = join(tmp, 'rerank-count.sqlite');
    initLedger({ ledgerPath: ledger });
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, estimateUsd: 0.01, ledgerPath: ledger });
    const other = BudgetRun.open({ runner: 'test', budgetUsd: 1, estimateUsd: 0.01, ledgerPath: ledger });
    run.reserve(0.001, 'voyage:rerank-2.5 rerank');
    run.reserve(0.001, 'voyage:rerank-2.5 rerank');
    run.reserve(0.001, 'openai:text-embedding-3-large embedding');
    other.reserve(0.001, 'voyage:rerank-2.5 rerank');
    run.reserve(0.001, 'voyage:rerank-2.5-lite rerank');
    expect(ledgerRerankRequests(ledger, run.runId, null)).toEqual({ 'voyage:rerank-2.5': 2, 'voyage:rerank-2.5-lite': 1 });
    expect(ledgerRerankRequests(ledger, other.runId, null)).toEqual({ 'voyage:rerank-2.5': 1 });
  });

  const rerankRun = async (label: string, respond: (documents: string[]) => Response, out = label) => {
    const ledger = join(tmp, `${label}.sqlite`);
    initLedger({ ledgerPath: ledger });
    const real = globalThis.fetch;
    const prevKey = process.env.VOYAGE_API_KEY;
    process.env.VOYAGE_API_KEY = 'test-key-no-provider-call';
    let calls = 0;
    // Installed before the run opens, so the paid-request guard sends through it and meters each rerank request.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!/voyageai\.com\/v1\/rerank/.test(url)) return real(input, init);
      calls++;
      return respond((JSON.parse(String(init?.body)) as { documents: string[] }).documents);
    }) as never;
    try {
      const { receipt } = await runArm(parseRunArgs(['--benchmark', 'fixture', '--embed', 'hash', '--pin', 'search.reranker.enabled=true', '--pin', 'search.reranker.model=voyage:rerank-2.5',
        '--paid', '--budget-run-id', BudgetRun.open({ runner: 'test', budgetUsd: 1, estimateUsd: 0.1, ledgerPath: ledger }).runId, '--budget-ledger', ledger, '--output', join(tmp, `${out}-out`)]));
      return { receipt, calls, fidelity: receipt.fidelity as Record<string, unknown> };
    } finally {
      globalThis.fetch = real;
      if (prevKey === undefined) delete process.env.VOYAGE_API_KEY; else process.env.VOYAGE_API_KEY = prevKey;
    }
  };

  test('a reranker that ran on every query: one metered request per query and the configured model on each', async () => {
    const { receipt, calls, fidelity } = await rerankRun('rerank-ok', docs => new Response(JSON.stringify({ object: 'list', data: docs.map((_, index) => ({ index, relevance_score: 1 - index / 100 })), model: 'rerank-2.5', usage: { total_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(calls).toBeGreaterThan(0);
    expect(fidelity.reranked_queries).toBe(calls);
    expect(fidelity.rerank_provider_requests).toEqual({ 'voyage:rerank-2.5': calls });
    expect(receipt.run_status).toBe('complete');
    expect(receipt.reranker).toEqual({ applies: true, enabled: true, decided_by: 'pin', model: 'voyage:rerank-2.5' });
    const rows = readFileSync(join(tmp, 'rerank-ok-out', 'rows.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.rerank.state).toBe('reranked');
  }, 120_000);

  test('a reranker that failed open stops the run with the coded refusal RERANKER_INACTIVE (no silent fallback)', async () => {
    let err: unknown;
    try { await rerankRun('rerank-down', () => new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(DecideError);
    expect((err as DecideError).op.code).toBe('RERANKER_INACTIVE');
    expect((err as DecideError).op.fix.next).toBe('ask_user');
    const receipt = JSON.parse(readFileSync(join(tmp, 'rerank-down-out', 'receipt.json'), 'utf8'));
    expect(receipt.run_status).toBe('refused');
    expect(receipt.refusal.code).toBe('RERANKER_INACTIVE');
    expect(receipt.refusal.message).toMatch(/rerank degradation|without rerank scores/);
    expect(receipt.counts.rows).toBe(0);
    expect(receipt.fidelity.reranked_queries).toBe(0);
  }, 120_000);

  test('a refused arm resumed to completion counts reranked queries, metered requests and cost across both attempts', async () => {
    const ok = (docs: string[]) => new Response(JSON.stringify({ object: 'list', data: docs.map((_, index) => ({ index, relevance_score: 1 - index / 100 })), model: 'rerank-2.5', usage: { total_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    let served = 0;
    let err: unknown;
    try { await rerankRun('resume-a', docs => (++served <= 1 ? ok(docs) : new Response('{}', { status: 503 })), 'resume'); }
    catch (e) { err = e; }
    expect((err as DecideError).op.code).toBe('RERANKER_INACTIVE');
    const first = JSON.parse(readFileSync(join(tmp, 'resume-out', 'receipt.json'), 'utf8'));
    expect(first.run_status).toBe('refused');
    expect(first.counts.rows).toBe(1);
    const { receipt, calls, fidelity } = await rerankRun('resume-b', ok, 'resume');
    expect(receipt.run_status).toBe('complete');
    const rows = readFileSync(join(tmp, 'resume-out', 'rows.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows.filter(r => r.rerank.state === 'reranked').length).toBe(1 + calls);
    expect(fidelity.reranked_queries).toBe(1 + calls);
    expect((fidelity.rerank_provider_requests as Record<string, number>)['voyage:rerank-2.5']).toBeGreaterThanOrEqual(1 + calls);
    const attempts = receipt.attempts as Array<{ run_status: string; rows_added: number; usd: number }>;
    expect(attempts.map(x => [x.run_status, x.rows_added])).toEqual([['refused', 1], ['complete', calls]]);
    expect(receipt.cost_usd_all_attempts).toBeCloseTo(attempts.reduce((x, y) => x + y.usd, 0), 6);
  }, 120_000);

  test('the reranker is on unless the arm is keyless or says otherwise; a contradiction is refused', () => {
    expect(resolveReranker(undefined, undefined, 'real')).toEqual({ enabled: true, decided_by: 'default' });
    expect(resolveReranker(undefined, undefined, 'hash')).toEqual({ enabled: false, decided_by: 'keyless-default' });
    expect(resolveReranker('off', undefined, 'real')).toEqual({ enabled: false, decided_by: 'flag' });
    expect(resolveReranker('on', 'true', 'hash')).toEqual({ enabled: true, decided_by: 'flag' });
    expect(resolveReranker(undefined, 'false', 'real')).toEqual({ enabled: false, decided_by: 'pin' });
    expect(() => resolveReranker('on', 'false', 'real')).toThrow(/contradicts/);
    expect(() => resolveReranker('maybe', undefined, 'real')).toThrow(/on or off/);
    const real = parseRunArgs(['--benchmark', 'beam-1m', '--output', join(tmp, 'parse-real')]);
    expect(real.pins['search.reranker.enabled']).toBe('true');
    expect(real.reranker.decided_by).toBe('default');
    const viaConfig = parseRunArgs(['--benchmark', 'fixture', '--embed', 'real', '--config', 'search.reranker.enabled=false', '--output', join(tmp, 'parse-config')]);
    expect(viaConfig.pins['search.reranker.enabled']).toBe('false');
    expect(viaConfig.config['search.reranker.enabled']).toBeUndefined();
  });

  test('a reranker without its provider key is refused before anything is searched', async () => {
    const prevKey = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    try {
      let err: unknown;
      try { await runArm(parseRunArgs(['--benchmark', 'fixture', '--embed', 'hash', '--reranker', 'on', '--pin', 'search.reranker.model=voyage:rerank-2.5', '--output', join(tmp, 'rerank-nokey-out')])); }
      catch (e) { err = e; }
      expect((err as DecideError).op.code).toBe('RERANKER_INACTIVE');
      expect((err as DecideError).message).toContain('VOYAGE_API_KEY');
    } finally {
      if (prevKey !== undefined) process.env.VOYAGE_API_KEY = prevKey;
    }
  });
});
