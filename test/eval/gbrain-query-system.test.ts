/**
 * The gbrain-query connector and `GbrainQuerySystem` (budgeted delivery plan
 * C0), keyless: real PGLite brains of the pinned gbrain, hash vectors, the
 * reranker off, no provider key.
 *
 * Includes the two fixtures other waves rely on (GBRA-60):
 *   - `auto` overrunning an explicit 8,000-token budget (spill);
 *   - the frozen-hit path (assembleEvidenceForHits) dropping effective_date
 *     while the evidence fingerprint still matches.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { importGbrain, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { hashEmbed } from '../../eval/runner/memory-qa/run.ts';
import { renderSessionPage } from '../../eval/runner/memory-qa/corpus.ts';
import { GbrainQueryConnector, loadConnectorModules, parity, QUERY_PATH_PINS, wireRequest, WIRE_NAMES, type ConnectorModules } from '../../eval/runner/systems/gbrain-query/connector.ts';
import { DELIVERY_VARIANTS, GbrainQuerySystem, memoKey, parseGrid } from '../../eval/runner/systems/gbrain-query/system.ts';
import type { GbrainModules } from '../../eval/runner/systems/gbrain.ts';

const gut = resolveGbrainUnderTest(null);
const load = <T,>(rel: string) => importGbrain<T>(gut, rel);
let conn: ConnectorModules;
let mods: GbrainModules;
const engines: any[] = [];

const WORDS = ['apple', 'banana', 'cherry', 'harbor', 'elephant', 'violin', 'guitar', 'lantern', 'island', 'jungle', 'meadow', 'canyon'];
/** A brain of `sessions` dated conversation pages, `turns` turns each, under the pins the system writes. */
async function brain(sessions: number, turns: number, extra: Record<string, string> = {}) {
  const e = new mods.PGLiteEngine();
  await e.connect({});
  await e.initSchema();
  for (const [k, v] of Object.entries({ 'search.reranker.enabled': 'false', ...QUERY_PATH_PINS, ...extra })) await e.setConfig(k, v);
  for (let s = 0; s < sessions; s++) {
    const body = Array.from({ length: turns }, (_, t) => ({ speaker: t % 2 ? 'Bob' : 'Alice',
      content: `Session ${s} turn ${t}: we talked about the ${WORDS[(s + t) % WORDS.length]} and the ${WORDS[(s * 5 + t) % WORDS.length]} near the harbor, then planned the trip to Lisbon in May with the violin.` }));
    await mods.importFromContent(e, `chat/${s.toString(16).padStart(16, '0')}`, renderSessionPage({ id: String(s), date: `2023-${String(1 + (s % 12)).padStart(2, '0')}-1${s % 10}T10:00:00.000Z`, turns: body }, { as: 'conversation' }), {});
  }
  engines.push(e);
  return e;
}

beforeAll(async () => {
  const gateway = await load<{ configureGateway: (c: Record<string, unknown>) => void; __setEmbedTransportForTests: (fn: unknown) => void }>('src/core/ai/gateway.ts');
  process.env.OPENAI_API_KEY ||= 'hash-embed-transport-no-provider-call';
  gateway.configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: process.env });
  gateway.__setEmbedTransportForTests(async (p: { values: string[] }) => ({ embeddings: p.values.map(v => hashEmbed(v, 1536)), values: p.values, warnings: [], usage: { tokens: 0 } }));
  conn = await loadConnectorModules(load);
  mods = {
    PGLiteEngine: (await load<{ PGLiteEngine: GbrainModules['PGLiteEngine'] }>('src/core/pglite-engine.ts')).PGLiteEngine,
    importFromContent: (await load<{ importFromContent: GbrainModules['importFromContent'] }>('src/core/import-file.ts')).importFromContent,
    hybridSearch: (await load<{ hybridSearch: GbrainModules['hybridSearch'] }>('src/core/search/hybrid.ts')).hybridSearch,
  };
});
afterAll(async () => { for (const e of engines) try { await e.disconnect(); } catch { /* ignore */ } });

const Q = 'trip to Lisbon harbor violin';

describe('wire requests', () => {
  test('each named request is exactly the preregistered object', () => {
    expect(WIRE_NAMES).toEqual(['frozen-chunk', 'native-default', 'auto-budget', 'live-parity', 'bare-budget']);
    expect(wireRequest('frozen-chunk', Q, { limit: 25 })).toEqual({ query: Q, limit: 25, expand: false, return_unit: 'chunk' });
    expect(wireRequest('native-default', Q, { limit: 25 })).toEqual({ query: Q, limit: 25, expand: false });
    expect(wireRequest('auto-budget', Q, { limit: 25, budget: 8000 })).toEqual({ query: Q, limit: 25, expand: false, return_unit: 'auto', token_budget: 8000 });
    expect(wireRequest('live-parity', Q, { limit: 25, budget: 6100 })).toEqual({ query: Q, limit: 25, expand: false, return_unit: 'auto', token_budget: 6100, use_cache: false });
    expect(wireRequest('bare-budget', Q, { limit: 25, budget: 8000 })).toEqual({ query: Q, limit: 25, expand: false, token_budget: 8000 });
    expect(() => wireRequest('auto-budget', Q, { limit: 25 })).toThrow(/budget/);
  });
});

describe('settings pins', () => {
  test('every pin is a registered gbrain key and reads back from the brain the handler reads; cache status disabled', async () => {
    const c = new GbrainQueryConnector(conn, await brain(1, 4));
    const checks = await c.checkPins({ ...QUERY_PATH_PINS });
    expect(checks.map(p => [p.key, p.registered, p.applied])).toEqual([
      ['search.cache.enabled', 'known', true], ['decide.provider', 'decide', true], ['search.crag_escalation', 'known', true], ['search.crag_think', 'known', true], ['search.track_retrieval', 'known', true]]);
    expect(c.cacheStatus()).toBe('disabled');
  });
  test('the v2 key search.cache_enabled is refused as unregistered, and an unapplied value is refused', async () => {
    const e = await brain(1, 4);
    const c = new GbrainQueryConnector(conn, e);
    await expect(c.checkPins({ 'search.cache_enabled': 'false' })).rejects.toThrow(/not a registered gbrain key/);
    await expect(c.checkPins({ 'search.crag_think': 'true' })).rejects.toThrow(/read back "false"/);
  });
});

describe('frozen list, deliveries and live parity', () => {
  let e: any;
  let c: GbrainQueryConnector;
  beforeAll(async () => { e = await brain(12, 40); c = new GbrainQueryConnector(conn, e); });

  test('the chunk-unit call resolves no evidence plan and sends no budget; rows are the ranked hits', async () => {
    const f = await c.freeze(Q, 25);
    expect(f.request).toEqual({ query: Q, limit: 25, expand: false, return_unit: 'chunk' });
    expect('delivery' in f.meta).toBe(false);
    expect(f.rows.length).toBeGreaterThan(5);
    expect(f.rows.map(r => r.rank)).toEqual(f.rows.map((_, i) => i + 1));
    expect(f.rows.every(r => r.chunk_text.length > 0 && r.slug.startsWith('chat/'))).toBe(true);
    expect((f.meta.token_budget as { budget: number }).budget).toBe(12000);
  });

  test('a limit-5 frozen list is the first five of the limit-25 list (the five-hit derivation holds)', async () => {
    const f25 = await c.freeze(Q, 25), f5 = await c.freeze(Q, 5);
    expect(f5.rows.map(r => r.chunk_id)).toEqual(f25.rows.slice(0, 5).map(r => r.chunk_id));
  });

  test('live auto at an explicit budget equals the assembled delivery on every consumed field except the date', async () => {
    const f = await c.freeze(Q, 25);
    const assembled = await c.deliver(f.rows, 'auto', 6000);
    const live = await c.live('live-parity', Q, 25, 6000);
    const p = parity(live, assembled);
    expect(p).toMatchObject({ equal: true, fingerprint_equal: true, mismatches: [] });
    expect(assembled.record).toMatchObject({ source: 'assemble', requested_unit: 'auto', applied_unit: 'auto', budget_tokens: 6000, budget_explicit: true, hit_count: f.rows.length });
    expect(assembled.record.request).toEqual({ return_unit: 'auto', budget_tokens: 6000, caller: { remote: false }, hits: { count: f.rows.length } });
  });

  test('fixture: the frozen-hit path drops effective_date while the fingerprint still matches', async () => {
    const f = await c.freeze(Q, 25);
    expect(f.rows.every(r => /^2023-\d{2}-\d{2}/.test(r.effective_date ?? ''))).toBe(true);
    const assembled = await c.deliver(f.rows, 'auto', 6000);
    const live = await c.live('live-parity', Q, 25, 6000);
    const p = parity(live, assembled, { dates: true });
    expect(p.fingerprint_equal).toBe(true);
    expect(p.live_dated_blocks).toBe(live.rows.length);
    expect(p.assembled_dated_blocks).toBe(0);
    expect(p.equal).toBe(false);
    expect(p.mismatches.every(m => m.endsWith('effective_date'))).toBe(true);
    expect(assembled.record.per_block.every(b => b.effective_date === null)).toBe(true);
  });

  test('bare budget (G7 record): token_budget without return_unit is legacy chunk budgeting, no delivery', async () => {
    const bare = await c.live('bare-budget', Q, 25, 8000);
    expect(bare.record.applied_unit).toBeNull();
    expect(bare.rows.some(r => r.delivered)).toBe(false);
    expect((bare.meta.token_budget as { budget: number }).budget).toBe(8000);
  });

  test('native default: neither override resolves auto at the 24,000-token conversation budget', async () => {
    const nd = await c.live('native-default', Q, 25);
    expect(nd.record).toMatchObject({ requested_unit: 'auto', applied_unit: 'auto', budget_tokens: 24000, budget_explicit: false });
  });
});

describe('fixture: auto overruns an explicit 8,000-token budget', () => {
  test('25 hits over long conversations: floors fill the budget, the rest spill as chunks outside it', async () => {
    const e = await brain(26, 120);
    const c = new GbrainQueryConnector(conn, e);
    const f = await c.freeze(Q, 25);
    expect(f.rows.length).toBeGreaterThanOrEqual(20);
    const d = await c.deliver(f.rows, 'auto', 8000);
    expect(d.record.over_budget).toBe(true);
    expect(d.record.budget_used!).toBeGreaterThan(8000);
    expect(d.record.overrun_tokens).toBe(d.record.budget_used! - 8000);
    expect(d.record.spilled_blocks).toBeGreaterThan(0);
    expect(d.record.units.chunk).toBe(d.record.spilled_blocks);
    const live = await c.live('auto-budget', Q, 25, 8000);
    expect(live.record).toMatchObject({ over_budget: true, budget_used: d.record.budget_used, spilled_blocks: d.record.spilled_blocks });
    const five = await c.deliver(f.rows.slice(0, 5), 'auto', 8000);
    expect(five.record.over_budget).toBe(false);
    expect(five.record.spilled_blocks).toBe(0);
  }, 120_000);
});

describe('GbrainQuerySystem', () => {
  const identity = { version: gut.version, commit: 'test' };
  const session = (s: number) => ({ source_id: `src-${s.toString(16).padStart(16, '0')}`, turns: Array.from({ length: 30 }, (_, t) => ({ role: (t % 2 ? 'assistant' : 'user') as 'user' | 'assistant', speaker: t % 2 ? 'Bob' : 'Alice',
    content: `Session ${s} turn ${t}: the ${WORDS[(s + t) % WORDS.length]} by the harbor and the trip to Lisbon with the violin.` })) });
  async function ingested(opts: { frozenFrom?: string; rerankExpected?: boolean } = {}) {
    const sys = new GbrainQuerySystem(mods, conn, { 'search.reranker.enabled': 'false' }, identity, { frozenFrom: opts.frozenFrom ?? null, rerankExpected: opts.rerankExpected ?? false });
    await sys.reset('ns-a');
    for (let s = 0; s < 8; s++) await sys.ingestSession('ns-a', session(s), `2023-0${1 + s}-15T09:00:00.000Z`);
    return sys;
  }
  const policy = (settings: Record<string, unknown>) => ({ name: 'gbrain-query:fixed-evidence', mode: 'fixed-evidence' as const, settings: { limit: 25, ...settings } });
  const question = { text: 'Lisbon violin harbor', query_time: '2023-12-01T00:00:00' };

  test('pins are written through the config channel and checked at open; a probe (no stage) is a plain frozen call', async () => {
    const sys = await ingested();
    const r = await sys.retrieve('ns-a', question, policy({}));
    const acc = r.accounting as any;
    expect(acc.pins.every((p: { applied: boolean }) => p.applied)).toBe(true);
    expect(acc.cache_status).toBe('disabled');
    expect(acc.frozen.request).toEqual({ query: question.text, limit: 25, expand: false, return_unit: 'chunk' });
    expect(acc.frozen.memo_key).toBe(memoKey(session(0).source_id, question));
    expect(r.items.every(i => i.type === 'chunk' && i.source_ids.length === 1)).toBe(true);
    await sys.close();
  });

  test('freeze with a grid hands raw deliveries to the sizing hook only', async () => {
    const sys = await ingested();
    const r = await sys.retrieve('ns-a', question, policy({ stage: 'freeze', grid: '2000:4000:1000' }));
    expect(sys.lastSizing!.map(g => g.budget)).toEqual([2000, 3000, 4000]);
    expect(sys.lastSizing!.every(g => g.prefix.record.hit_count === Math.min(5, r.items.length))).toBe(true);
    expect(JSON.stringify(r.accounting)).not.toContain('"blocks":[{');
    expect(parseGrid('4000:8000:100').length).toBe(41);
    await sys.close();
  });

  test('deliver stage: no new frozen call, every variant delivered on the frozen list, live parity recorded, chunk ids remapped by index', async () => {
    const sys = await ingested();
    const frozenRow = await sys.retrieve('ns-a', question, policy({ stage: 'freeze' }));
    await sys.close();
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'gq-')), 'rows.ndjson');
    const shifted = { ...(frozenRow.accounting as any).frozen, rows: (frozenRow.accounting as any).frozen.rows.map((r: { chunk_id: number }) => ({ ...r, chunk_id: r.chunk_id + 1000 })) };
    writeFileSync(file, JSON.stringify({ accounting: { frozen: shifted } }) + '\n');
    const sys2 = await ingested({ frozenFrom: file });
    const r = await sys2.retrieve('ns-a', question, policy({ stage: 'deliver', b_native: 3000, b_pseudo: 2500 }));
    const acc = r.accounting as any;
    expect(Object.keys(acc.deliveries)).toEqual(Object.keys(DELIVERY_VARIANTS));
    expect(acc.remapped_chunk_ids).toBe(shifted.rows.length);
    expect(acc.deliveries['auto-b_native'].record.budget_tokens).toBe(3000);
    expect(acc.deliveries['auto-default'].record).toMatchObject({ budget_tokens: 24000, budget_explicit: false });
    expect(acc.deliveries['auto-l5-b_pseudo'].record.hit_count).toBe(Math.min(5, shifted.rows.length));
    expect(acc.live.record.request).toEqual({ query: question.text, limit: 25, expand: false, return_unit: 'auto', token_budget: 3000, use_cache: false });
    expect(acc.live.parity.equal).toBe(true);
    expect(acc.live.parity.assembled_dated_blocks).toBe(0);
    await expect(sys2.retrieve('ns-a', { text: 'never frozen', query_time: null }, policy({ stage: 'deliver', b_native: 3000, b_pseudo: 2500 }))).rejects.toThrow(/no frozen list/);
    await expect(sys2.retrieve('ns-a', question, policy({ stage: 'deliver', b_native: 3000 }))).rejects.toThrow(/b_pseudo/);
    await sys2.close();
  });

  test('a missing rerank on a reranked build is retried, then kept and counted', async () => {
    const sys = await ingested({ rerankExpected: true });
    const r = await sys.retrieve('ns-a', question, policy({ stage: 'freeze', rerank_attempts: 3 }));
    expect((r.accounting as any).frozen).toMatchObject({ rerank_present: false, rerank_attempts: 3 });
    expect(sys.fidelity.rerank_missing_queries).toBe(1);
    expect(r.items.length).toBeGreaterThan(0);
    await sys.close();
  });
});
