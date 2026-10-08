import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BudgetExceededError, BudgetRun, budgetOptionsFrom, closeLedgers, initLedger, installPaidRequestGuard, ledgerTotals, priceRequest, readLedger, receiptCost,
  reservationUsd, startPaidRun, usageCost,
} from '../../eval/runner/budget-ledger.ts';
import Anthropic from '@anthropic-ai/sdk';

const dirs: string[] = [];
/** A path with no ledger yet. */
const freshPath = () => { const dir = mkdtempSync(join(tmpdir(), 'budget-ledger-')); dirs.push(dir); return join(dir, 'nested', 'ledger.sqlite'); };
/** A ledger created with the default $500 cap (a missing ledger off the default path is refused since 0.10.12). */
const ledgerPath = () => { const path = freshPath(); initLedger({ ledgerPath: path }); return path; };
const read = (path: string) => readLedger(path);
afterEach(() => { closeLedgers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const anthropicBody = { model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: 'x'.repeat(3000) }] };
const embeddingBody = { model: 'text-embedding-3-large', input: ['alpha beta', 'gamma'] };

function mockFetch(respond: (url: string, body: unknown) => Response) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    return respond(url, init?.body ? JSON.parse(String(init.body)) : undefined);
  }) as typeof fetch;
  return { impl, calls };
}

async function send(url: string, body: unknown) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('pricing', () => {
  test('free hosts are not priced; paid requests reserve input estimate plus the full output allowance', () => {
    expect(priceRequest('http://localhost:1234/v1/chat/completions', anthropicBody)).toBeNull();
    const chat = priceRequest('https://api.anthropic.com/v1/messages', anthropicBody)!;
    expect(chat).toMatchObject({ provider: 'anthropic', kind: 'chat', input: 3, output: 15, maxOutputTokens: 1000 });
    expect(reservationUsd(chat)).toBeCloseTo((chat.inputTokens * 3 + 1000 * 15) / 1e6, 12);
    const embed = priceRequest('https://api.openai.com/v1/embeddings', embeddingBody)!;
    expect(embed).toMatchObject({ kind: 'embedding', input: 0.13, output: 0 });
  });

  test('unpriceable paid requests are refused, never sent at an unknown cost', () => {
    expect(() => priceRequest('https://api.openai.com/v1/chat/completions', { messages: [] })).toThrow(BudgetExceededError);
    expect(() => priceRequest('https://api.anthropic.com/v1/messages', { model: 'unlisted-model', max_tokens: 5 })).toThrow('no chat price');
    expect(() => priceRequest('https://openrouter.ai/api/v1/chat/completions', { model: 'x/y', max_tokens: 5 })).toThrow('max_price');
    const routed = priceRequest('https://openrouter.ai/api/v1/chat/completions', { model: 'x/y', max_tokens: 5, provider: { max_price: { prompt: 3, completion: 15 } } })!;
    expect(routed).toMatchObject({ input: 3, output: 15 });
  });

  test('the cheap extraction candidates carry their list prices', () => {
    expect(priceRequest('https://api.anthropic.com/v1/messages', { model: 'claude-haiku-5-5', max_tokens: 10, messages: [] }))
      .toMatchObject({ kind: 'chat', input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 });
    expect(priceRequest('https://api.openai.com/v1/responses', { model: 'gpt-6-luna', max_output_tokens: 10, input: 'x' }))
      .toMatchObject({ kind: 'chat', input: 0.1, output: 0.5 });
  });

  test('dated snapshots use the family list price; Voyage rerank is priced from query and documents', () => {
    expect(priceRequest('https://api.openai.com/v1/chat/completions', { model: 'gpt-4o-2024-08-06', max_tokens: 10, messages: [] }))
      .toMatchObject({ kind: 'chat', input: 2.5, output: 10, maxOutputTokens: 10 });
    const jev = priceRequest('https://api.typesafe.ai/v1/systemone', { model: 'jev-1.13.0', state: { query: 'abc' }, questions: { q: { type: 'noul', instructions: 'defdef' } } })!;
    expect(jev).toMatchObject({ provider: 'typesafe', model: 'jev-1.13.0', input: 0.042, output: 0, maxOutputTokens: 0 });
    expect(jev.inputTokens).toBeGreaterThan(16);
    expect(() => priceRequest('https://api.typesafe.ai/v1/x', { model: 'jev-1' })).toThrow('no TypeSafe price');
    const rerank = priceRequest('https://api.voyageai.com/v1/rerank', { model: 'rerank-2.5', query: 'abc', documents: ['defdef', 'ghi'] })!;
    expect(rerank).toMatchObject({ kind: 'rerank', input: 0.05, output: 0, maxOutputTokens: 0 });
    expect(rerank.inputTokens).toBe(Math.ceil((3 * 2 + 9) / 3) + 16);
    expect(usageCost(rerank, { usage: { total_tokens: 2000 } })).toEqual({ usd: 2000 * 0.05 / 1e6, input_tokens: 2000, output_tokens: 0 });
    expect(() => priceRequest('https://api.voyageai.com/v1/rerank', { model: 'rerank-9', query: 'q', documents: [] })).toThrow('no rerank price');
  });

  test('usage reconciles from provider-reported tokens; missing usage is null', () => {
    const chat = priceRequest('https://api.anthropic.com/v1/messages', anthropicBody)!;
    expect(usageCost(chat, { usage: { input_tokens: 1000, output_tokens: 200 } })).toEqual({ usd: (1000 * 3 + 200 * 15) / 1e6, input_tokens: 1000, output_tokens: 200 });
    expect(usageCost(chat, { content: [] })).toBeNull();
    const embed = priceRequest('https://api.openai.com/v1/embeddings', embeddingBody)!;
    expect(usageCost(embed, { usage: { prompt_tokens: 10, total_tokens: 10 } })!.input_tokens).toBe(10);
  });
});

describe('ledger', () => {
  test('reservations persist before sending and reconcile to actual spend', async () => {
    const path = ledgerPath();
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, ledgerPath: path });
    const mock = mockFetch(() => Response.json({ usage: { input_tokens: 100, output_tokens: 10 } }));
    let reservedDuringSend = 0;
    const guard = installPaidRequestGuard(run, { fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      reservedDuringSend = read(path).entries.filter(e => e.status === 'reserved').length;
      return mock.impl(input, init);
    }) as typeof fetch });
    try { await send('https://api.anthropic.com/v1/messages', anthropicBody); }
    finally { guard.uninstall(); }
    expect(reservedDuringSend).toBe(1);
    const [entry] = read(path).entries;
    expect(entry.status).toBe('reconciled');
    expect(entry.actual_usd).toBeCloseTo((100 * 3 + 10 * 15) / 1e6, 12);
    expect(entry.reserved_usd).toBeGreaterThan(entry.actual_usd!);
    const summary = run.close();
    expect(summary).toMatchObject({ requests: 1, charged_reservations: 0, input_tokens: 100, output_tokens: 10 });
    expect(receiptCost(summary).usd).toBeCloseTo(entry.actual_usd!, 6);
    expect(read(path).runs[0].finished_at).not.toBeNull();
  });

  test('every retry reserves again, and the run budget stops sending before overspend', async () => {
    const path = ledgerPath();
    const chat = priceRequest('https://api.anthropic.com/v1/messages', anthropicBody)!;
    const perRequest = reservationUsd(chat);
    const run = BudgetRun.open({ runner: 'test', budgetUsd: perRequest * 2.5, ledgerPath: path });
    const mock = mockFetch(() => new Response('overloaded', { status: 529 }));
    const guard = installPaidRequestGuard(run, { fetchImpl: mock.impl });
    try {
      for (let attempt = 0; attempt < 2; attempt++) expect((await send('https://api.anthropic.com/v1/messages', anthropicBody)).status).toBe(529);
      await expect(send('https://api.anthropic.com/v1/messages', anthropicBody)).rejects.toThrow(BudgetExceededError);
      expect(guard.exhausted).toBe(true);
    } finally { guard.uninstall(); }
    expect(mock.calls).toHaveLength(2);
    const entries = read(path).entries;
    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.status === 'charged-reservation' && e.actual_usd === e.reserved_usd)).toBe(true);
  });

  test('a network failure after send charges the reservation', async () => {
    const path = ledgerPath();
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, ledgerPath: path });
    const guard = installPaidRequestGuard(run, { fetchImpl: (async () => { throw new TypeError('socket hang up'); }) as unknown as typeof fetch });
    try { await expect(send('https://api.openai.com/v1/embeddings', embeddingBody)).rejects.toThrow('socket hang up'); }
    finally { guard.uninstall(); }
    const [entry] = read(path).entries;
    expect(entry.status).toBe('charged-reservation');
    expect(entry.actual_usd).toBe(entry.reserved_usd);
  });

  test('the program cap spans runs, counts open reservations, and refuses a run that does not fit', () => {
    const path = freshPath();
    const first = BudgetRun.open({ runner: 'a', budgetUsd: 4, ledgerPath: path, programCapUsd: 5 });
    const open = first.reserve(3, 'crashed before settling');
    expect(ledgerTotals(read(path))).toMatchObject({ committed_usd: 3, open_reservations_usd: 3 });
    expect(() => BudgetRun.open({ runner: 'b', budgetUsd: 2.5, ledgerPath: path, programCapUsd: 5 })).toThrow('program cap');
    const second = BudgetRun.open({ runner: 'b', budgetUsd: 2, ledgerPath: path, programCapUsd: 5 });
    second.reserve(1.5, 'ok');
    expect(() => second.reserve(0.6, 'crosses program cap')).toThrow('program');
    expect(read(path).entries).toHaveLength(2);
    first.settle(open, { usd: 0.5, input_tokens: 10, output_tokens: 1 });
    expect(ledgerTotals(read(path)).remaining_usd).toBeCloseTo(3, 12);
    expect(() => first.settle(open, null)).toThrow('already settled');
  });

  test('the default program cap is $500 and a corrupt ledger blocks spending', () => {
    const path = ledgerPath();
    expect(() => BudgetRun.open({ runner: 'a', budgetUsd: 500.01, ledgerPath: path })).toThrow('$500.00 program cap');
    BudgetRun.open({ runner: 'a', budgetUsd: 1, ledgerPath: path });
    closeLedgers();
    writeFileSync(path, '{"schema_version": 9}');
    expect(() => BudgetRun.open({ runner: 'b', budgetUsd: 1, ledgerPath: path })).toThrow('unreadable budget ledger');
  });

  test('an estimate above the run budget refuses to start', () => {
    expect(() => BudgetRun.open({ runner: 'a', budgetUsd: 1, estimateUsd: 3, ledgerPath: ledgerPath() })).toThrow('exceeds --budget-usd');
  });
});

describe('allowances (bulk requests)', () => {
  test('requests inside an allowance write no ledger entries, stop at the allowance, and settle as one entry', async () => {
    const path = ledgerPath();
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, ledgerPath: path });
    const perRequest = reservationUsd(priceRequest('https://api.openai.com/v1/embeddings', embeddingBody)!);
    const mock = mockFetch(() => Response.json({ usage: { prompt_tokens: 4, total_tokens: 4 } }));
    const guard = installPaidRequestGuard(run, { fetchImpl: mock.impl });
    const allowance = run.allowance(perRequest * 3.5, 'bulk');
    try {
      await allowance.run(async () => {
        for (let i = 0; i < 3; i++) expect((await send('https://api.openai.com/v1/embeddings', embeddingBody)).status).toBe(200);
        expect(read(path).entries).toHaveLength(1);
      });
      // Spent is below the reservations, so a fourth fits; a fifth would pass the allowance only if usage were unknown.
      await allowance.run(() => send('https://api.openai.com/v1/embeddings', embeddingBody));
      const big = { model: 'text-embedding-3-large', input: ['x'.repeat(400_000)] };
      await expect(allowance.run(() => send('https://api.openai.com/v1/embeddings', big))).rejects.toThrow(BudgetExceededError);
    } finally { guard.uninstall(); }
    expect(mock.calls).toHaveLength(4);
    const charged = allowance.close();
    expect(charged.requests).toBe(4);
    const [entry] = read(path).entries;
    expect(read(path).entries).toHaveLength(1);
    expect(entry.status).toBe('reconciled');
    expect(entry.actual_usd).toBeCloseTo(charged.usd, 12);
    expect(entry.input_tokens).toBe(16);
  });
  test('an allowance cannot exceed the run budget', () => {
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, ledgerPath: ledgerPath() });
    expect(() => run.allowance(2, 'bulk')).toThrow(BudgetExceededError);
  });
});

describe('shared runs (longmemeval-batch workers)', () => {
  test('joined workers share one run budget, report only their own spend, and cannot close the run', () => {
    const path = ledgerPath();
    const owner = BudgetRun.open({ runner: 'batch', budgetUsd: 1, ledgerPath: path });
    const a = BudgetRun.join({ runId: owner.runId, ledgerPath: path });
    const b = BudgetRun.join({ runId: owner.runId, ledgerPath: path });
    a.settle(a.reserve(0.6, 'worker a'), { usd: 0.6 });
    expect(() => b.reserve(0.6, 'worker b')).toThrow(BudgetExceededError);
    b.settle(b.reserve(0.3, 'worker b'), { usd: 0.3 });
    expect(a.summary().actual_usd).toBeCloseTo(0.6, 9);
    expect(b.summary().actual_usd).toBeCloseTo(0.3, 9);
    expect(owner.summary().actual_usd).toBeCloseTo(0.9, 9);
    a.close();
    expect(read(path).runs[0].finished_at).toBeNull();
    owner.close();
    expect(read(path).runs[0].finished_at).not.toBeNull();
    expect(() => BudgetRun.join({ runId: owner.runId, ledgerPath: path })).toThrow('already finished');
    expect(() => BudgetRun.join({ runId: 'missing', ledgerPath: path })).toThrow('no budget run');
  });

  test('--budget-run-id makes startPaidRun join instead of opening a run of its own', () => {
    const path = ledgerPath();
    const owner = BudgetRun.open({ runner: 'batch', budgetUsd: 2, ledgerPath: path });
    const options = budgetOptionsFrom(['--budget-run-id', owner.runId, '--budget-ledger', path], {});
    expect(options.runId).toBe(owner.runId);
    const { run, guard } = startPaidRun('worker', { ...options, estimateUsd: 0.1, log: () => {} });
    guard.uninstall();
    expect(run.runId).toBe(owner.runId);
    expect(run.budgetUsd).toBe(2);
    expect(read(path).runs.length).toBe(1);
  });
});

describe('runner flags', () => {
  test('--budget-usd is required for paid work; flags override env', () => {
    const path = freshPath();
    const lines: string[] = [];
    const options = budgetOptionsFrom(['--budget-ledger', path], {});
    expect(options).toMatchObject({ budgetUsd: null, programCapUsd: null });
    expect(() => startPaidRun('cat13', { ...options, estimateUsd: 3, log: l => lines.push(l) })).toThrow('--budget-usd');
    expect(lines[0]).toContain('estimated cost $3.00');
    expect(existsSync(path)).toBe(false);
    expect(budgetOptionsFrom(['--budget-usd=7'], { BRAINBENCH_BUDGET_USD: '2' }).budgetUsd).toBe(7);
    expect(budgetOptionsFrom([], { BRAINBENCH_BUDGET_USD: '2', BRAINBENCH_PROGRAM_CAP_USD: '50' })).toMatchObject({ budgetUsd: 2, programCapUsd: 50 });
    expect(() => budgetOptionsFrom(['--budget-usd', '-1'])).toThrow('positive');
    initLedger({ ledgerPath: path });
    const { run, guard } = startPaidRun('cat13', { ...budgetOptionsFrom(['--budget-usd', '5', '--budget-ledger', path], {}), estimateUsd: 3, log: () => {} });
    guard.uninstall();
    expect(run.budgetUsd).toBe(5);
    expect(read(path).runs[0]).toMatchObject({ runner: 'cat13', budget_usd: 5, estimate_usd: 3 });
  });
});

describe('provider SDKs that capture fetch', () => {
  test('an Anthropic client built before the guard is installed still reserves every request', async () => {
    const path = ledgerPath();
    const client = new Anthropic({ apiKey: 'dummy-never-sent', maxRetries: 1 });
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, ledgerPath: path });
    let attempts = 0;
    const guard = installPaidRequestGuard(run, { fetchImpl: (async () => {
      attempts++;
      if (attempts === 1) return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: 529, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });
      return Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 3 } });
    }) as unknown as typeof fetch });
    try { await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }); }
    finally { guard.uninstall(); }
    const entries = read(path).entries;
    expect(attempts).toBe(2);
    expect(entries.map(e => e.status)).toEqual(['charged-reservation', 'reconciled']);
    expect(entries[1].input_tokens).toBe(12);
  });
});
