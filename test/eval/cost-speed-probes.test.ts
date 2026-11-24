/**
 * Keyless tests for the cost-and-speed experiment's probe rules (amendment of 2026-11-24): a search that overlaps a
 * write is labelled probe by its own text and every charge lands exactly once; errored polls are not misses; a void
 * window counts nothing; the idle check is bounded and never treats an undrained /finish as idle.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { MeteringProxy, ProxyControl, searchTexts, type UsageLine } from '../../eval/runner/metering-proxy.ts';
import { costSpeed, usagePhase } from '../../eval/runner/cost-speed.ts';
import { awaitIdle, finishDrained, probeRecord, probeSummary, windowVoid, type ProbeRecord } from '../../eval/runner/cost-speed-probes.ts';

const tmp = mkdtempSync(join(tmpdir(), 'cost-speed-probes-'));
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); });
const FAKE_ENV = { OPENAI_API_KEY: 'placeholder-openai', VOYAGE_API_KEY: 'placeholder-voyage' };
const PASSAGE = 'I finally moved the standing desk to the window, and the afternoon light makes the long calls bearable.';

describe('probe attribution in the lease proxy', () => {
  beforeEach(() => closeLedgers());
  test('a probe search that overlaps a write is labelled probe by its text; the write keeps its phase; each request is charged once', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (Array.isArray(body.input) && body.input[0] !== PASSAGE) await gate;
      return Response.json({ data: [{ embedding: [0.1] }], usage: { prompt_tokens: Array.isArray(body.input) ? 400 : 20, total_tokens: Array.isArray(body.input) ? 400 : 20 } });
    }) as unknown as typeof fetch;
    const lease = BudgetRun.openLease({ runId: 'probe-overlap', leaseUsd: 1, ledgerPath: join(tmp, 'ledger.sqlite') });
    const usageLog = join(tmp, 'usage.ndjson');
    const proxy = new MeteringProxy({ fetchImpl, policy: { lease, env: FAKE_ENV, usageLog }, controlToken: 'ctl' });
    proxy.start();
    const base = `http://127.0.0.1:${proxy.port}`;
    const post = (body: unknown) => fetch(`${base}/ext-extract-first/openai/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const ctl = new ProxyControl(base, 'ctl');
      await ctl.bind('ext-extract-first', 'ingest:ns-a', { brain: 'ns-a', phase: 'background' });
      await ctl.probeQueries('ext-extract-first', [PASSAGE]);
      const write = post({ model: 'text-embedding-3-small', input: [`user: ${PASSAGE} And then the rest of the session went on for a while.`] });
      await Bun.sleep(50);
      expect((await post({ model: 'text-embedding-3-small', input: PASSAGE })).status).toBe(200);
      release();
      expect((await write).status).toBe(200);
      await ctl.probeQueries('ext-extract-first', null);
      expect((await post({ model: 'text-embedding-3-small', input: PASSAGE })).status).toBe(200);
      const lines = readFileSync(usageLog, 'utf8').trim().split('\n').map(l => JSON.parse(l) as UsageLine).filter(l => l.outcome !== 'refused');
      expect(lines.map(l => [l.phase, usagePhase(l)])).toEqual([['probe', 'probe'], ['background', 'ingest'], ['background', 'ingest']]);
      expect(new Set(lines.map(l => l.request_id)).size).toBe(3);
      const billed = lines.reduce((n, l) => n + (l.actual_usd ?? 0), 0);
      expect(billed).toBeCloseTo(Number(proxy.status().billed_usd), 10);
      const cs = costSpeed({ usage: lines, rows: [] } as never);
      const p = cs.spend.campaign.by_phase;
      expect(p.ingest + p.retrieval + p.answer + p.judge + p.other).toBeCloseTo(billed, 4);
      expect(p.ingest).toBeCloseTo(lines.filter(l => l.phase === 'background').reduce((n, l) => n + (l.actual_usd ?? 0), 0), 4);
    } finally { proxy.stop(); }
  });

  test('search texts come from embedding inputs and rerank queries only', () => {
    expect(searchTexts('openai', '/v1/embeddings', { input: 'a' })).toEqual(['a']);
    expect(searchTexts('voyage', '/v1/embeddings', { input: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(searchTexts('voyage', '/v1/rerank', { query: 'q', documents: ['a'] })).toEqual(['q']);
    expect(searchTexts('openai', '/v1/chat/completions', { messages: [{ role: 'user', content: 'a' }] })).toEqual([]);
  });
});

describe('probe records and summary', () => {
  const rec = (status: 'found' | 'missed' | 'errored', ms: number | null = null, idle = true): ProbeRecord =>
    ({ source_id: 's', status, write_to_queryable_ms: ms, polls: 1, errored_polls: status === 'errored' ? 1 : 0, unattributed_returns: 0, started_idle: idle });

  test('a probe whose polls errored and never found the session is errored, not missed', () => {
    expect(probeRecord('s1', [{ at_ms: 1000, error: 'HTTP 503' }, { at_ms: 2000, error: 'HTTP 503' }], true).status).toBe('errored');
    expect(probeRecord('s1', [{ at_ms: 1000, found: false, unattributed: 2 }, { at_ms: 2000, found: false }], true)).toMatchObject({ status: 'missed', unattributed_returns: 2 });
    expect(probeRecord('s1', [{ at_ms: 1000, error: 'HTTP 503' }, { at_ms: 2000, found: true }], true)).toMatchObject({ status: 'found', write_to_queryable_ms: 2000, errored_polls: 1 });
  });

  test('errored probes stay out of the percentiles and the miss share, and a window with more than a tenth errored is void', () => {
    const outage = Array.from({ length: 21 }, () => rec('errored'));
    expect(windowVoid(outage)).toBe(true);
    const healthy = [...Array.from({ length: 20 }, (_, i) => rec('found', 1000 + i)), rec('errored')];
    expect(windowVoid(healthy)).toBe(false);
    const s = probeSummary([outage, healthy], 600_000);
    expect(s).toMatchObject({ counted: 20, found: 20, missed: 0, miss_share: 0, errored: 22, void_windows: 1 });
    expect(s.p50_ms).toBe(1009);
  });

  test('a percentile that lands on a miss reports no time, and probes that started without the system idle do not count', () => {
    const w = [...Array.from({ length: 5 }, () => rec('found', 500)), ...Array.from({ length: 6 }, () => rec('missed')), rec('found', 900, false)];
    expect(probeSummary([w], 600_000)).toMatchObject({ counted: 11, found: 5, missed: 6, p50_ms: null, not_idle: 1, void_windows: 0 });
    expect(probeSummary([[rec('found', 500), rec('found', 900, false)]], 600_000)).toMatchObject({ counted: 0, void_windows: 1 });
    const ok = [...Array.from({ length: 10 }, () => rec('found', 500)), rec('missed')];
    expect(probeSummary([ok], 600_000)).toMatchObject({ counted: 11, p50_ms: 500, p95_ms: null });
  });
});

describe('idle check', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

  test('a system with pending work is given up on at the bound, without draining it', async () => {
    const c = clock();
    let calls = 0;
    const r = await awaitIdle({ pending: async () => { calls++; return 3; }, lastRequestAt: () => null, maxMs: 600_000, intervalMs: 1_000, ...c });
    expect(r).toEqual({ idle: false, waited_ms: 600_000 });
    expect(calls).toBe(601);
  });

  test('idle once nothing is pending and the slot has been quiet for the quiet window', async () => {
    const c = clock();
    const r = await awaitIdle({ pending: async () => 0, lastRequestAt: () => 0, quietMs: 60_000, intervalMs: 1_000, ...c });
    expect(r).toEqual({ idle: true, waited_ms: 60_000 });
  });

  test('a /finish that says ready with undrained background liabilities is not drained', () => {
    expect(finishDrained({ ready: true, raw: { background_liabilities: { drained: false } } })).toBe(false);
    expect(finishDrained({ ready: true, raw: { background_liabilities: { drained: true } } })).toBe(true);
    expect(finishDrained({ ready: true })).toBe(true);
    expect(finishDrained({ ready: false })).toBe(false);
  });
});
