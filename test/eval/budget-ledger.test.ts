import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BudgetExceededError, BudgetRun, budgetOptionsFrom, CHAT_PRICE_OVERRIDES, chatPrice, closeLedgers, closeRun, HARNESS_CHAT_PRICES, initLedger, installPaidRequestGuard, ledgerStatus,
  ledgerTotals, priceRequest, readLedger, receiptCost, reservationUsd, responseUsd, startPaidRun, UnpricedUsageError, usageCost, verifyLedger,
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

  test('the current cheap models are priced: claude-haiku-5-5 and gpt-6-luna at their published short-prompt rates', () => {
    const haiku = priceRequest('https://api.anthropic.com/v1/messages', { model: 'claude-haiku-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'x'.repeat(3000) }] })!;
    expect(haiku).toMatchObject({ provider: 'anthropic', kind: 'chat', input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 });
    expect(reservationUsd(haiku)).toBeCloseTo((haiku.inputTokens * 0.1 + 100 * 0.5) / 1e6, 12);
    const luna = priceRequest('https://api.openai.com/v1/chat/completions', { model: 'gpt-6-luna', max_completion_tokens: 100, messages: [] })!;
    expect(luna).toMatchObject({ provider: 'openai', input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 });
  });

  test('a prompt over the long-prompt threshold is reserved and settled at the long rates for the whole request', () => {
    const big = priceRequest('https://api.anthropic.com/v1/messages', { model: 'claude-haiku-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'x'.repeat(400_000) }] })!;
    expect(big.inputTokens).toBeGreaterThan(100_000);
    expect(reservationUsd(big)).toBeCloseTo((big.inputTokens * 0.5 + 100 * 2.5) / 1e6, 12);
    const short = priceRequest('https://api.anthropic.com/v1/messages', { model: 'claude-haiku-5-5', max_tokens: 100, messages: [] })!;
    expect(usageCost(short, { usage: { input_tokens: 100_000, output_tokens: 10 } })!.usd).toBeCloseTo((100_000 * 0.1 + 10 * 0.5) / 1e6, 12);
    // Cache reads count toward the threshold: 40,000 uncached + 61,000 read is a 101,000-token prompt.
    expect(usageCost(short, { usage: { input_tokens: 40_000, cache_read_input_tokens: 61_000, output_tokens: 10 } })!.usd)
      .toBeCloseTo((40_000 * 0.5 + 61_000 * 0.05 + 10 * 2.5) / 1e6, 12);
    const sol = priceRequest('https://api.openai.com/v1/chat/completions', { model: 'gpt-6.1-sol', max_completion_tokens: 10, messages: [] })!;
    expect(usageCost(sol, { usage: { prompt_tokens: 272_001, completion_tokens: 10 } })!.usd).toBeCloseTo((272_001 * 4 + 10 * 15) / 1e6, 12);
    expect(usageCost(sol, { usage: { prompt_tokens: 272_000, completion_tokens: 10 } })!.usd).toBeCloseTo((272_000 * 2 + 10 * 10) / 1e6, 12);
  });

  test('OpenAI cache writes are a subset of prompt_tokens and settle at the cache-write price', () => {
    const sol = priceRequest('https://api.openai.com/v1/chat/completions', { model: 'gpt-6.1-sol', max_completion_tokens: 10, messages: [] })!;
    // The usage shape of a committed W10b gpt-6.1-sol row.
    const usage = { prompt_tokens: 12374, completion_tokens: 88, total_tokens: 12462, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 12371 }, completion_tokens_details: { reasoning_tokens: 52 } };
    expect(usageCost(sol, { usage })).toEqual({ usd: (3 * 2 + 12371 * 2.5 + 88 * 10) / 1e6, input_tokens: 12374, output_tokens: 88 });
  });

  test('particle-1 is priced on both Particle hosts and settles from OpenAI chat usage, reasoning inside completion_tokens', () => {
    const body = { model: 'particle-1', max_tokens: 1024, messages: [{ role: 'user', content: 'x'.repeat(900) }] };
    for (const host of ['api.particle.ai', 'us.api.particle.ai']) {
      expect(priceRequest(`https://${host}/v1/chat/completions`, body)).toMatchObject({ provider: 'particle', model: 'particle-1', kind: 'chat', input: 0.25, output: 1, cache_read: 0.03, maxOutputTokens: 1024 });
    }
    // With no output limit Particle generates up to 32,000 tokens (docs.particle.ai/models), so that is reserved, not 4,096.
    expect(priceRequest('https://api.particle.ai/v1/chat/completions', { model: 'particle-1', messages: [] })!.maxOutputTokens).toBe(32_000);
    // A dated id takes its family's output cap as it takes its family's price.
    expect(priceRequest('https://api.particle.ai/v1/chat/completions', { model: 'particle-1-2026-10-31', messages: [] })!.maxOutputTokens).toBe(32_000);
    const p = priceRequest('https://api.particle.ai/v1/chat/completions', body)!;
    // The usage of the 2026-10-31 live memory-qa reader smoke: 330 prompt tokens, 70 completion tokens, 39 of them reasoning.
    const smoke = usageCost(p, { usage: { prompt_tokens: 330, completion_tokens: 70, total_tokens: 400, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 39 } } })!;
    expect(smoke).toMatchObject({ input_tokens: 330, output_tokens: 70 });
    expect(smoke.usd).toBeCloseTo((330 * 0.25 + 70 * 1) / 1e6, 12);
    // docs.particle.ai/usage-billing's example: the cached prefix is part of prompt_tokens and bills at the cached rate.
    const cached = usageCost(p, { usage: { prompt_tokens: 18234, completion_tokens: 412, total_tokens: 18646, prompt_tokens_details: { cached_tokens: 16384 }, completion_tokens_details: { reasoning_tokens: 256 } } })!;
    expect(cached.usd).toBeCloseTo(((18234 - 16384) * 0.25 + 16384 * 0.03 + 412 * 1) / 1e6, 12);
    expect(() => priceRequest('https://api.particle.ai/v1/chat/completions', { model: 'glm-5.3-flash', max_tokens: 5, messages: [] })).toThrow('no chat price for particle:glm-5.3-flash');
    expect(priceRequest('https://api.particle.ai/v1/models', undefined)).toBeNull();
  });

  // Value: protects=GST-1365's Gemini referee is metered on its OpenAI-compatible route at the 2026-12-01 rate, with thinking billed whichever way usage reports it, and the native route keeps its price; fails_when=a compatible request spends unmetered, thinking outside completion_tokens goes unbilled, a cached prefix bills at the full rate, or the native route loses its price; why_new=GST-1365 adds the route; seam=priceRequest/usageCost; no_claim=does not call Gemini (the paid smoke checks completion_tokens against the limit sent)
  test('gemini-4-argon on its OpenAI-compatible route is priced at $4/$20 and settles thinking from total_tokens or completion_tokens; the native route still prices', () => {
    const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
    const p = priceRequest(url, { model: 'gemini-4-argon', max_completion_tokens: 8192, messages: [{ role: 'user', content: 'x'.repeat(900) }] })!;
    expect(p).toMatchObject({ provider: 'gemini', model: 'gemini-4-argon', kind: 'chat', input: 4, output: 20, cache_read: 0.2, maxOutputTokens: 8192, usage: 'openai' });
    expect(priceRequest(url, { model: 'gemini-4-argon', messages: [] })!.maxOutputTokens).toBe(65_536);
    const outside = usageCost(p, { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 905 } })!;
    expect(outside).toMatchObject({ input_tokens: 100, output_tokens: 805 });
    expect(outside.usd).toBeCloseTo((100 * 4 + 805 * 20) / 1e6, 12);
    expect(usageCost(p, { usage: { prompt_tokens: 100, completion_tokens: 805, total_tokens: 905 } })!.output_tokens).toBe(805);
    expect(usageCost(p, { usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 800 } } })!.usd).toBeCloseTo((200 * 4 + 800 * 0.2 + 10 * 20) / 1e6, 12);
    expect(priceRequest('https://generativelanguage.googleapis.com/v1beta/openai/models', undefined)).toBeNull();
    expect(() => priceRequest(url, { model: 'gemini-9-unknown', messages: [] })).toThrow('no chat price for gemini:gemini-9-unknown');
    expect(() => priceRequest('https://generativelanguage.googleapis.com/v1beta/openai/embeddings', { model: 'gemini-4-argon', input: 'x' })).toThrow('only /chat/completions is priced');
    expect(priceRequest('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent', { contents: [{ parts: [{ text: 'x' }] }] })).toMatchObject({ provider: 'gemini', model: 'gemini-4-argon', input: 4, output: 20 });
  });

  test("Particle's hosted web search is refused: it bills $0.0025 a search outside usage, so the ledger could neither reserve nor settle it", () => {
    const url = 'https://api.particle.ai/v1/chat/completions';
    const body = { model: 'particle-1', max_tokens: 64, messages: [{ role: 'user', content: 'What happened today?' }] };
    expect(() => priceRequest(url, { ...body, tools: [{ type: 'web_search' }] })).toThrow(/hosted web search/);
    expect(() => priceRequest(`https://us.api.particle.ai/v1/chat/completions`, { ...body, tools: [{ type: 'function', function: { name: 'f' } }, { type: 'web_search' }] })).toThrow(/hosted web search/);
    expect(priceRequest(url, { ...body, tools: [{ type: 'web_search' }], tool_choice: 'none' })).toMatchObject({ provider: 'particle', maxOutputTokens: 64 });
    expect(priceRequest(url, { ...body, tools: [{ type: 'function', function: { name: 'f' } }] })).toMatchObject({ provider: 'particle', maxOutputTokens: 64 });
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

  test('a host the ledger cannot price is refused before sending; loopback, local files and priced hosts go through', async () => {
    const path = ledgerPath();
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, ledgerPath: path });
    const usage = { prompt_tokens: 330, completion_tokens: 70, total_tokens: 400, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 39 } };
    const mock = mockFetch(() => Response.json({ model: 'particle-ai/particle-1', usage }));
    const guard = installPaidRequestGuard(run, { fetchImpl: mock.impl });
    const chat = { model: 'particle-1', max_tokens: 1024, messages: [{ role: 'user', content: 'When did I move?' }] };
    try {
      for (const url of ['https://api.unlisted-vendor.ai/v1/chat/completions', 'http://10.0.0.5:8000/v1/chat/completions', 'https://127.0.0.1.example.com/v1/chat/completions']) {
        await expect(send(url, chat)).rejects.toThrow(/is not a host the ledger can price.*PAID_HOSTS/);
      }
      // A host named like an Object.prototype member is not a paid host.
      await expect(fetch('https://constructor/v1/models')).rejects.toThrow(/is not a host the ledger can price/);
      expect(guard.exhausted).toBe(true);
      for (const url of ['http://127.0.0.1:8787/v1/chat/completions', 'http://localhost:8787/v1/chat/completions', 'http://[::1]:8787/v1/chat/completions',
        'http://0.0.0.0:8787/v1/chat/completions', 'http://[::ffff:127.0.0.1]:8787/v1/chat/completions']) await send(url, chat);
      await fetch('file:///dev/null');
      await fetch('https://api.particle.ai/v1/models');
      await send('https://api.particle.ai/v1/chat/completions', chat);
    } finally { guard.uninstall(); }
    expect(mock.calls).toEqual(['http://127.0.0.1:8787/v1/chat/completions', 'http://localhost:8787/v1/chat/completions', 'http://[::1]:8787/v1/chat/completions',
      'http://0.0.0.0:8787/v1/chat/completions', 'http://[::ffff:127.0.0.1]:8787/v1/chat/completions', 'file:///dev/null', 'https://api.particle.ai/v1/models', 'https://api.particle.ai/v1/chat/completions']);
    const entries = read(path).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'reconciled', input_tokens: 330, output_tokens: 70 });
    expect(entries[0].actual_usd).toBeCloseTo((330 * 0.25 + 70 * 1) / 1e6, 12);
    expect(run.close()).toMatchObject({ requests: 1, input_tokens: 330, output_tokens: 70 });
  });

  test('a guarded request follows no redirect, so an admitted host cannot hand it on to another host', async () => {
    let reached = 0;
    const far = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { reached++; return Response.json({}); } });
    const hop = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${far.port}/v1/chat/completions` } }) });
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, ledgerPath: ledgerPath() });
    const guard = installPaidRequestGuard(run);
    try {
      await expect(fetch(`http://127.0.0.1:${hop.port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) })).rejects.toThrow();
    } finally { guard.uninstall(); hop.stop(true); far.stop(true); }
    expect(reached).toBe(0);
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

  // Value: protects=GST-2163's answer that a ledger run left open (finished_at NULL) cannot change the next window's guard; fails_when=an open run's unspent budget is held against the program cap, or its settled spend stops counting; why_new=two live-recall runs stayed open after exiting 0; seam=BudgetRun.open/reserve; no_claim=does not read Wintermute's ledger
  test('a run left open with nothing reserved holds no budget: the next run can reserve everything the program cap has left', () => {
    const path = freshPath();
    const first = BudgetRun.open({ runner: 'a', budgetUsd: 60, ledgerPath: path, programCapUsd: 100 });
    first.settle(first.reserve(10, 'spent'), { usd: 10 });
    first.close({ finish: false });
    expect(ledgerStatus({ ledgerPath: path })).toMatchObject({ open_runs: 1, totals: { committed_usd: 10, open_reservations_usd: 0 } });
    const next = BudgetRun.open({ runner: 'b', budgetUsd: 90, ledgerPath: path, programCapUsd: 100 });
    next.reserve(89.99, 'the rest');
    expect(() => BudgetRun.open({ runner: 'c', budgetUsd: 0.02, ledgerPath: path, programCapUsd: 100 })).toThrow('program cap');
    expect(() => first.reserve(0.02, 'after the program cap filled')).toThrow('over its $100.00 cap');
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

describe('closed runs refuse new reservations', () => {
  test('a joined handle that closes the run cannot reserve on it again, and the refusal records nothing', () => {
    const path = ledgerPath();
    const owner = BudgetRun.open({ runner: 'gate', budgetUsd: 5, ledgerPath: path });
    const worker = BudgetRun.join({ runId: owner.runId, ledgerPath: path });
    worker.close({ finish: true });
    expect(read(path).runs[0].finished_at).not.toBeNull();
    expect(() => worker.reserve(0.1, 'pair after close')).toThrow(BudgetExceededError);
    expect(() => worker.reserve(0.1, 'pair after close')).toThrow(`pair after close: budget run ${owner.runId} already finished`);
    expect(() => worker.allowance(0.1, 'arm after close')).toThrow('already finished');
    expect(() => owner.reserve(0.1, 'owner after close')).toThrow('already finished');
    expect(read(path).entries).toHaveLength(0);
    expect(ledgerStatus({ ledgerPath: path, runId: owner.runId }).run!.committed_usd).toBe(0);
    expect(verifyLedger(path).ok).toBe(true);
  });

  test('with two handles on one run, a close through either one stops the other from reserving', () => {
    const path = ledgerPath();
    const owner = BudgetRun.open({ runner: 'gate', budgetUsd: 5, ledgerPath: path });
    const a = BudgetRun.join({ runId: owner.runId, ledgerPath: path });
    const b = BudgetRun.join({ runId: owner.runId, ledgerPath: path });
    b.settle(b.reserve(0.2, 'pair b'), { usd: 0.2 });
    a.close({ finish: true });
    expect(() => b.reserve(0.2, 'pair b again')).toThrow('already finished');
    const other = BudgetRun.open({ runner: 'gate', budgetUsd: 5, ledgerPath: path });
    const held = BudgetRun.join({ runId: other.runId, ledgerPath: path });
    closeRun(path, other.runId);
    expect(() => held.reserve(0.2, 'pair after a CLI close')).toThrow('already finished');
    expect(read(path).entries.map(e => e.description)).toEqual(['pair b']);
    expect(ledgerTotals(read(path)).committed_usd).toBeCloseTo(0.2, 9);
    expect(verifyLedger(path).ok).toBe(true);
  });

  test('an open run still reserves and settles as before', () => {
    const path = ledgerPath();
    const owner = BudgetRun.open({ runner: 'gate', budgetUsd: 1, ledgerPath: path });
    const worker = BudgetRun.join({ runId: owner.runId, ledgerPath: path });
    const id = worker.reserve(0.5, 'pair');
    expect(ledgerStatus({ ledgerPath: path, runId: owner.runId }).run!.committed_usd).toBeCloseTo(0.5, 9);
    worker.settle(id, { usd: 0.3, input_tokens: 10, output_tokens: 5 });
    owner.settle(owner.reserve(0.4, 'owner pair'), null);
    expect(read(path).entries.map(e => [e.status, e.actual_usd])).toEqual([['reconciled', 0.3], ['charged-reservation', 0.4]]);
    expect(ledgerStatus({ ledgerPath: path, runId: owner.runId }).run!.committed_usd).toBeCloseTo(0.7, 9);
    expect(() => worker.reserve(0.31, 'over budget')).toThrow('over its $1.00 budget');
    expect(verifyLedger(path).ok).toBe(true);
  });

  test('a reservation or allowance taken before the close still settles after it', () => {
    const path = ledgerPath();
    const owner = BudgetRun.open({ runner: 'gate', budgetUsd: 5, ledgerPath: path });
    const worker = BudgetRun.join({ runId: owner.runId, ledgerPath: path });
    const measured = worker.reserve(0.5, 'in flight, measured');
    const unknown = worker.reserve(0.25, 'in flight, no usage');
    const allowance = worker.allowance(1, 'arm');
    allowance.hold(0.1, 'request inside the allowance');
    owner.close();
    allowance.charge(0.1, { usd: 0.05, input_tokens: 100, output_tokens: 10 });
    expect(read(path).runs[0].finished_at).not.toBeNull();
    worker.settle(measured, { usd: 0.2 });
    worker.settle(unknown, null);
    allowance.close();
    expect(read(path).entries.map(e => [e.status, e.actual_usd])).toEqual([['reconciled', 0.2], ['charged-reservation', 0.25], ['reconciled', 0.05]]);
    expect(read(path).entries.every(e => e.actual_usd !== null)).toBe(true);
    expect(() => worker.reserve(0.1, 'after the settles')).toThrow('already finished');
    expect(verifyLedger(path).ok).toBe(true);
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

  test('a 4xx answer without usage settles at $0, as the metering proxy settles it; a 5xx keeps its reservation', async () => {
    const path = ledgerPath();
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, ledgerPath: path });
    let status = 400;
    const guard = installPaidRequestGuard(run, { fetchImpl: (async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model.' } }),
      { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch });
    const call = () => fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(anthropicBody) });
    try { expect((await call()).status).toBe(400); status = 500; expect((await call()).status).toBe(500); }
    finally { guard.uninstall(); }
    const entries = read(path).entries;
    expect(entries.map(e => [e.status, e.actual_usd! > 0])).toEqual([['reconciled', false], ['charged-reservation', true]]);
  });
});

describe('a request the provider rejects before generating does not book its reservation', () => {
  test('a 413 and a prompt over the context window settle at $0; a 4xx that reports usage settles at that usage', async () => {
    const path = ledgerPath();
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 50, ledgerPath: path });
    const replies = [
      new Response(JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: 'Request exceeds the maximum size' } }), { status: 413, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
      new Response('<html>413 Request Entity Too Large</html>', { status: 413, headers: { 'content-type': 'text/html' } }),
      new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'rejected' }, usage: { input_tokens: 1000, output_tokens: 0 } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    ];
    const guard = installPaidRequestGuard(run, { fetchImpl: (async () => replies.shift()!) as unknown as typeof fetch });
    const body = { ...anthropicBody, max_tokens: 64_000, messages: [{ role: 'user', content: 'x'.repeat(600_000) }] };
    const call = () => fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try { for (const want of [413, 400, 413, 400]) expect((await call()).status).toBe(want); }
    finally { guard.uninstall(); }
    const entries = read(path).entries;
    expect(entries.map(e => e.status)).toEqual(['reconciled', 'reconciled', 'reconciled', 'reconciled']);
    expect(entries.slice(0, 3).map(e => e.actual_usd)).toEqual([0, 0, 0]);
    expect(entries[3].actual_usd).toBeGreaterThan(0);
    expect(entries[3].actual_usd!).toBeLessThan(entries[3].reserved_usd / 10);
    expect(entries[3].input_tokens).toBe(1000);
  });
});

describe('streamed responses settle from their usage events', () => {
  test('Anthropic message_start plus message_delta, and OpenAI response.completed', async () => {
    const { sseUsage, usageCost, priceRequest } = await import('../../eval/runner/budget-ledger.ts');
    const anthropic = [
      'event: message_start', 'data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":12,"cache_creation_input_tokens":1000,"cache_read_input_tokens":5000,"output_tokens":1}}}', '',
      'event: content_block_delta', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}', '',
      'event: message_delta', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":250}}', '',
    ].join('\n');
    expect(sseUsage(anthropic)).toEqual({ input_tokens: 12, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 250 });
    const price = priceRequest('https://api.anthropic.com/v1/messages', { model: 'claude-sonnet-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] })!;
    expect(usageCost(price, { usage: sseUsage(anthropic) })!.output_tokens).toBe(250);
    const openai = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":40,"output_tokens":7}}}\n';
    expect(sseUsage(openai)).toEqual({ input_tokens: 40, output_tokens: 7 });
    expect(sseUsage('data: {"type":"ping"}\n')).toBeNull();
  });
});


// Value: protects=GST-2163: every OpenAI row prices cache writes (30-minute and 12-hour) and its long-prompt tier, and the ledger refuses what it cannot price instead of booking it as input; fails_when=an OpenAI row lacks a write rate or tier, gpt-6-sol books writes or long prompts at the short input rate, a 12-hour write books at the 30-minute rate, or an unknown cache tier settles; why_new=gpt-6-sol had neither rate and the 12-hour lifetime was unpriced; seam=priceRequest/usageCost/installPaidRequestGuard; no_claim=does not call OpenAI (rates checked by hand against developers.openai.com/api/docs/pricing.md on 2026-11-09)
describe('cache writes, the long-prompt tier and usage the ledger cannot price', () => {
  const responses = 'https://api.openai.com/v1/responses';
  const body = (model: string, extra: Record<string, unknown> = {}) => ({ model, max_output_tokens: 100, input: 'x'.repeat(3000), ...extra });

  test('every OpenAI row states its cache-write rate and its long-prompt tier; an OpenAI model with neither has no price', () => {
    const rows = Object.entries({ ...CHAT_PRICE_OVERRIDES, ...HARNESS_CHAT_PRICES }).filter(([id]) => id.startsWith('openai:'));
    expect(rows.length).toBeGreaterThan(10);
    for (const [id, p] of rows) {
      expect({ id, cache_write: typeof p.cache_write }).toEqual({ id, cache_write: 'number' });
      expect({ id, long: p.long === undefined }).toEqual({ id, long: false });
      if (p.long) expect({ id, long_write: typeof p.long.cache_write }).toEqual({ id, long_write: 'number' });
    }
    expect(CHAT_PRICE_OVERRIDES['openai:gpt-6-sol']).toEqual({ input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, cache_write_12h: 5,
      long: { above_input_tokens: 272_000, input: 4, output: 15, cache_read: 0.4, cache_write: 5, cache_write_12h: 10 } });
    // gbrain's own table lists gpt-5.6-sol with input and output only.
    expect(chatPrice('openai:gpt-5.6-sol')).toBeUndefined();
    expect(() => priceRequest(responses, body('gpt-5.6-sol'))).toThrow(/no chat price for openai:gpt-5.6-sol.*cache-write rates.*long: null/);
    expect(chatPrice('openai:gpt-4o-2024-08-06')).toEqual(CHAT_PRICE_OVERRIDES['openai:gpt-4o']);
  });

  test('gpt-6-sol settles cache writes at 1.25x input and a prompt over 272K tokens at its long rates', () => {
    const sol = priceRequest(responses, body('gpt-6-sol'))!;
    // A gpt-6.1-sol response from the 2026-11-08 live recall capture: 2,645 input tokens, 1,789 read, 853 written.
    const real = { input_tokens: 2645, input_tokens_details: { cache_write_tokens: 853, cached_tokens: 1789 }, output_tokens: 21, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2666 };
    expect(usageCost(sol, { usage: real })!.usd).toBeCloseTo((3 * 2 + 1789 * 0.2 + 853 * 2.5 + 21 * 10) / 1e6, 12);
    const long = { input_tokens: 300_000, input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 50_000 }, output_tokens: 1000 };
    expect(usageCost(sol, { usage: long })!.usd).toBeCloseTo((150_000 * 4 + 100_000 * 0.4 + 50_000 * 5 + 1000 * 15) / 1e6, 12);
    expect(responseUsd('openai', 'gpt-6-sol', { usage: long })).toBeCloseTo(usageCost(sol, { usage: long })!.usd, 12);
    const big = priceRequest(responses, body('gpt-6-sol', { input: 'x'.repeat(900_000) }))!;
    expect(reservationUsd(big)).toBeCloseTo((big.inputTokens * 5 + 100 * 15) / 1e6, 12);
  });

  test('12-hour cache writes settle from the lifetime split, or all at the 12-hour rate when the request chose it and usage has no split', () => {
    const twelve = priceRequest(responses, body('gpt-6.1-sol', { prompt_cache_options: { ttl: '12h' } }))!;
    expect(twelve).toMatchObject({ cacheWritePremium: true, cacheWrite12h: true, cache_write: 2.5, cache_write_12h: 5 });
    expect(reservationUsd(twelve)).toBeCloseTo((twelve.inputTokens * 5 + 100 * 10) / 1e6, 12);
    const split = { input_tokens: 2000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1000, cache_write_tokens_details: { ttl_30m_tokens: 400, ttl_12h_tokens: 600 } }, output_tokens: 10 };
    expect(usageCost(twelve, { usage: split })!.usd).toBeCloseTo((1000 * 2 + 400 * 2.5 + 600 * 5 + 10 * 10) / 1e6, 12);
    const unsplit = { input_tokens: 2000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1000 }, output_tokens: 10 };
    expect(usageCost(twelve, { usage: unsplit })!.usd).toBeCloseTo((1000 * 2 + 1000 * 5 + 10 * 10) / 1e6, 12);
    const plain = priceRequest(responses, body('gpt-6.1-sol'))!;
    expect(plain.cacheWrite12h).toBe(false);
    expect(usageCost(plain, { usage: unsplit })!.usd).toBeCloseTo((1000 * 2 + 1000 * 2.5 + 10 * 10) / 1e6, 12);
    // A breakpoint's own lifetime counts too.
    expect(priceRequest(responses, body('gpt-6.1-sol', { input: [{ role: 'user', content: 'x', prompt_cache_breakpoint: { ttl: '12h' } }] }))!.cacheWrite12h).toBe(true);
  });

  test('a cache lifetime or retention the ledger has no write rate for is refused before sending', () => {
    expect(() => priceRequest(responses, body('gpt-5.5', { prompt_cache_options: { ttl: '12h' } }))).toThrow(/selects the 12h cache lifetime, which has no write rate/);
    expect(() => priceRequest(responses, body('gpt-6.1-sol', { prompt_cache_options: { ttl: '24h' } }))).toThrow(/selects the 24h cache lifetime/);
    expect(() => priceRequest(responses, body('gpt-6.1-sol', { prompt_cache_retention: '24h' }))).toThrow(/sets prompt_cache_retention/);
    // Before GPT-5.6 a write bills as input, so extended retention costs nothing the ledger cannot price.
    expect(priceRequest(responses, body('gpt-4.1-mini', { prompt_cache_retention: '24h' }))).toMatchObject({ model: 'gpt-4.1-mini', cacheWritePremium: false });
    const anthropic = { model: 'claude-opus-5-5', max_tokens: 10, system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [] };
    expect(() => priceRequest('https://api.anthropic.com/v1/messages', anthropic)).toThrow(/selects the 1h cache lifetime/);
    expect(priceRequest('https://api.anthropic.com/v1/messages', { ...anthropic, system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }] })!.cacheWritePremium).toBe(true);
  });

  test('usage naming a cache tier the ledger has no rate for is refused, never settled as input', () => {
    const sol = priceRequest(responses, body('gpt-6.1-sol'))!;
    const tier = { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 5, cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_7d_tokens: 5 } }, output_tokens: 1 };
    expect(() => usageCost(sol, { usage: tier })).toThrow(UnpricedUsageError);
    expect(() => usageCost(sol, { usage: tier })).toThrow(/reported ttl_7d_tokens, a cache tier the budget ledger has no rate for/);
    const opus = priceRequest('https://api.anthropic.com/v1/messages', { model: 'claude-opus-5-5', max_tokens: 10, messages: [] })!;
    // An Opus response from the same capture: its zero 1-hour count is no tier.
    const real = { input_tokens: 4, cache_creation_input_tokens: 1885, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 1885, ephemeral_1h_input_tokens: 0 }, output_tokens: 379,
      output_tokens_details: { thinking_tokens: 0 }, service_tier: 'standard', inference_geo: 'global', speed: 'standard' };
    expect(usageCost(opus, { usage: real })!.usd).toBeCloseTo((4 * 4 + 1885 * 5 + 379 * 20) / 1e6, 12);
    expect(() => usageCost(opus, { usage: { ...real, cache_creation: { ephemeral_5m_input_tokens: 1875, ephemeral_1h_input_tokens: 10 } } })).toThrow(/ephemeral_1h_input_tokens/);
    const particle = priceRequest('https://api.particle.ai/v1/chat/completions', { model: 'particle-1', max_tokens: 10, messages: [] })!;
    expect(() => usageCost(particle, { usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 40 } } })).toThrow(/has no cache-write rate for it/);
    expect(() => usageCost(particle, { usage: { prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 60 } })).toThrow(/reported prompt_cache_hit_tokens/);
    expect(() => usageCost(sol, { usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 10, cache_write_tokens_details: { ttl_12h_tokens: 10 } }, output_tokens: 1 } })).not.toThrow();
    const mini = priceRequest(responses, body('gpt-4.1-mini'))!;
    expect(() => usageCost(mini, { usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 10, cache_write_tokens_details: { ttl_12h_tokens: 10 } }, output_tokens: 1 } })).toThrow(/has no 12-hour cache-write rate for it/);
  });

  test('a response the ledger cannot price is charged at its reservation, and every later paid request is refused before sending', async () => {
    const path = ledgerPath();
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 1, ledgerPath: path });
    const mock = mockFetch(() => Response.json({ usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 5 } } }));
    const guard = installPaidRequestGuard(run, { fetchImpl: mock.impl });
    try {
      await expect(send('https://api.anthropic.com/v1/messages', anthropicBody)).rejects.toThrow(UnpricedUsageError);
      await expect(send('https://api.anthropic.com/v1/messages', anthropicBody)).rejects.toThrow(/refused before sending: an earlier response in this run reported usage the ledger cannot price \(.*ephemeral_1h_input_tokens/);
      expect(guard.exhausted).toBe(true);
    } finally { guard.uninstall(); }
    expect(mock.calls).toHaveLength(1);
    const entries = read(path).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'charged-reservation' });
    expect(entries[0].actual_usd).toBe(entries[0].reserved_usd);
  });
});
