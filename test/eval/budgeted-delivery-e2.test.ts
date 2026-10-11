/**
 * Budgeted delivery E2 harness (preregistration
 * docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2-preregistration.md), keyless: the per-call packing request,
 * the E2 variant set, budget sizing per budget, the rank-order rendering (C5), the readings' guards, reader check and
 * dev rule, the E3 session fusion, local campaign cells, and the keyless gate verdict. The real-PGLite block runs only
 * against a gbrain with `search.auto_packing` (gbrain#6367): set GBRAIN_E2_OVERLAY=<checkout>@<sha> to run it when the
 * pinned dependency predates it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { E2_BUDGETS, sizeBudgetE2, type SizingE2Point } from '../../eval/runner/budgeted-delivery/budget-sizing.ts';
import { capGuard, contextGuard, devRule, kindGuard, readerCheck } from '../../eval/runner/budgeted-delivery/e2-readings.ts';
import { gateProblems } from '../../eval/runner/budgeted-delivery/e2-gate-check.ts';
import { sessionOrders } from '../../eval/runner/budgeted-delivery/e3-retrieval-gate.ts';
import { importGbrain, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { expandArms, parseArms, recipeHash } from '../../eval/runner/memory-qa/arms.ts';
import { renderSessionPage, type MemoryQuestion, type Session } from '../../eval/runner/memory-qa/corpus.ts';
import { hashEmbed } from '../../eval/runner/memory-qa/run.ts';
import { Campaign, localPort, type CampaignManifest } from '../../eval/runner/shootout-cell.ts';
import { assembleRequest, AUTO_PACKINGS, GbrainQueryConnector, loadConnectorModules, QUERY_PATH_PINS, type ConnectorModules } from '../../eval/runner/systems/gbrain-query/connector.ts';
import { E2_DELIVERY_VARIANTS, E2_SIZING, GbrainQuerySystem, H1_DELIVERY_VARIANTS } from '../../eval/runner/systems/gbrain-query/system.ts';
import type { GbrainModules } from '../../eval/runner/systems/gbrain.ts';
import { packRecipe } from '../../eval/runner/systems/render.ts';
import type { Item } from '../../eval/runner/systems/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'bd-e2-'));
afterAll(() => { closeLedgers(); rmSync(tmp, { recursive: true, force: true }); });

describe('per-call packing and the E2 variant set', () => {
  test('assembleRequest passes auto_packing only when a packing is named', () => {
    const hits = [{ source_id: 'default', slug: 'chat/a', chunk_id: 1 }];
    expect(assembleRequest(hits, 'auto', 5000)).toEqual({ hits, return_unit: 'auto', budget_tokens: 5000, caller: { remote: false } });
    expect(assembleRequest(hits, 'auto', 5000, 'off')).toEqual({ hits, return_unit: 'auto', budget_tokens: 5000, auto_packing: 'off', caller: { remote: false } });
    expect(assembleRequest(hits, 'auto', null, 'depth_first')).toEqual({ hits, return_unit: 'auto', auto_packing: 'depth_first', caller: { remote: false } });
  });
  test('fourteen preregistered variants: four packings at three budgets, off on five hits, window; off is always explicit', () => {
    expect(AUTO_PACKINGS).toEqual(['off', 'cap_only', 'breadth_capped', 'depth_first']);
    expect(Object.keys(E2_DELIVERY_VARIANTS).sort()).toEqual([
      ...['b16_pseudo', 'b_native', 'b_pseudo'].flatMap(b => AUTO_PACKINGS.map(p => `${p}-${b}`)), 'off-l5-b_pseudo', 'window-b_pseudo'].sort());
    for (const [name, v] of Object.entries(E2_DELIVERY_VARIANTS)) {
      if (name.startsWith('window')) expect(v).toEqual({ unit: 'window', budget: 'b_pseudo', prefix: null, packing: null });
      else expect(v.packing).toBe(name.split('-')[0] as typeof v.packing);
    }
    expect(E2_DELIVERY_VARIANTS['off-l5-b_pseudo']).toEqual({ unit: 'auto', budget: 'b_pseudo', prefix: 5, packing: 'off' });
    expect(Object.keys(E2_SIZING.b8).sort()).toEqual([...AUTO_PACKINGS, 'off-l5', 'window'].sort());
    expect(Object.keys(E2_SIZING.b16)).toEqual([...AUTO_PACKINGS]);
  });
});

describe('E2 budget sizing', () => {
  /** One question: at grid budget b each variant used b tokens (off overruns by half) and serialized at `ratio` times that. */
  const point = (grid: 'b8' | 'b16', b: number, ratio: number, variants: readonly string[]): SizingE2Point => ({ grid, budget: b,
    variants: Object.fromEntries(variants.map(v => { const used = v === 'off' ? Math.round(b * 1.5) : b; return [v, { budget_used: used, blocks: 3, over_budget: v === 'off', pseudo: Math.round(used * ratio), native: Math.round(used * ratio * 0.9) }]; })) });
  const grid = (g: 'b8' | 'b16', lo: number, hi: number, ratio: number, variants: readonly string[]) => Array.from({ length: (hi - lo) / 100 + 1 }, (_, i) => point(g, lo + i * 100, ratio, variants));
  const all8 = [...AUTO_PACKINGS, 'off-l5', 'window'];
  test('B = floor_100(harness / (r_max x 1.02)) per budget, over every delivery read at it; off overflow is gbrain overrun', () => {
    const rows = [grid('b8', 4000, 7000, 1.3, all8), grid('b8', 4000, 7000, 1.4, all8)];
    const p = sizeBudgetE2(rows, 'b_pseudo');
    expect(p.budget).toBe(Math.floor(8000 / (1.4 * 1.02) / 100) * 100);
    expect(p.verification.passed).toBe(true);
    expect(p.verification.overflow_within_budget).toBe(0);
    expect(sizeBudgetE2(rows, 'b_native').budget).toBe(Math.floor(8000 / (1.4 * 0.9 * 1.02) / 100) * 100);
    expect(sizeBudgetE2(rows.map(q => q.map(g => ({ ...g, variants: Object.fromEntries(AUTO_PACKINGS.map(v => [v, g.variants[v]])) }))), 'b_pseudo_primary').budget).toBe(p.budget);
    const b16 = [grid('b16', 9000, 13500, 1.35, AUTO_PACKINGS)];
    expect(sizeBudgetE2(b16, 'b16_pseudo').budget).toBe(Math.floor(16000 / (1.35 * 1.02) / 100) * 100);
    expect(E2_BUDGETS.b16_pseudo.harness).toBe(16000);
  });
  test('a fixed point outside the grid is refused, above as well as below', () => {
    expect(() => sizeBudgetE2([grid('b8', 4000, 5000, 1.2, all8)], 'b_pseudo')).toThrow(/outside the grid/);
    expect(() => sizeBudgetE2([grid('b8', 6000, 7000, 1.6, all8)], 'b_pseudo')).toThrow(/outside the grid/);
  });
  test('a missing variant is refused, not skipped', () => {
    expect(() => sizeBudgetE2([grid('b8', 4000, 7000, 1.3, AUTO_PACKINGS)], 'b_pseudo')).toThrow(/variant off-l5 missing/);
  });
});

describe('C5 rank-order rendering', () => {
  const sessions: Record<string, Session> = { 'src-a': { id: 'a', date: '2023/05/20 (Sat) 02:21', turns: [] }, 'src-b': { id: 'b', date: '2023/01/02 (Mon) 10:00', turns: [] } };
  const item = (id: string, src: string, rank: number): Item => ({ id, rank, type: 'chunk', text: `**user:** item ${id} text`, source_ids: [src], valid_from: null, valid_to: null, provenance_status: 'exact' });
  const q = { id: 'q', conversation: 'c', question: 'When?', category: 'temporal', abstention: false, gold: [] } as unknown as MemoryQuestion;
  test('the same packed blocks and token count as pseudo-session, shown in delivery order instead of date order', () => {
    const items = [item('first', 'src-a', 1), item('second', 'src-b', 2)];
    const opts = { budgetTokens: 8000, sessionOf: (s: string) => sessions[s] };
    const date = packRecipe('pseudo-session', q, items, opts), rank = packRecipe('pseudo-session-rank', q, items, opts);
    expect(rank.item_ids).toEqual(date.item_ids);
    expect(rank.tokens).toBe(date.tokens);
    expect(rank.prompt.length).toBe(date.prompt.length);
    expect(date.prompt.indexOf('item second')).toBeLessThan(date.prompt.indexOf('item first'));
    expect(rank.prompt.indexOf('item first')).toBeLessThan(rank.prompt.indexOf('item second'));
  });
  test('the arms parser accepts the render and gives it its own recipe identity', () => {
    const spec = parseArms(JSON.stringify({ policies: { 'fixed-evidence': { budget_tokens: 8000 } }, contexts: ['d', 'r'],
      recipes: { d: { items: 'cap_only-b_pseudo', render: 'pseudo-session' }, r: { items: 'cap_only-b_pseudo', render: 'pseudo-session-rank' } }, readers: [{ id: 's', model: 'anthropic:claude-sonnet-5-5' }] }));
    expect(expandArms(spec)).toHaveLength(2);
    expect(recipeHash('d', spec)).not.toBe(recipeHash('r', spec));
  });
});

describe('E2 readings: guards, reader check and dev rule', () => {
  const row = (id: string, category: string, qa_score: number) => ({ id, category, qa_score, outcome: 'scored' });
  test('guard 7: a kind fails when it drops by more than max(1 question, 2% of the kind)', () => {
    const base = [...Array.from({ length: 100 }, (_, i) => row(`m${i}`, 'multi-session', 1)), ...Array.from({ length: 10 }, (_, i) => row(`p${i}`, 'pref', 1))];
    const twoDown = base.map(r => r.id === 'm0' || r.id === 'm1' ? { ...r, qa_score: 0 } : r);
    expect(kindGuard(base, twoDown).kinds['multi-session']).toMatchObject({ n: 100, delta_questions: -2, threshold: 2, pass: true });
    const threeDown = twoDown.map(r => r.id === 'm2' ? { ...r, qa_score: 0 } : r);
    expect(kindGuard(base, threeDown).pass).toBe(false);
    expect(kindGuard(base, base.map(r => r.id === 'p0' ? { ...r, qa_score: 0 } : r)).pass).toBe(true);
    expect(kindGuard(base, base.map(r => r.id === 'p0' || r.id === 'p1' ? { ...r, qa_score: 0 } : r)).pass).toBe(false);
  });
  test('guard 3 needs every question within its explicit budget and the reported packing; guard 4 needs zero cuts', () => {
    const r = (used: number, packing: string | null) => ({ accounting: { deliveries: { 'cap_only-b_pseudo': { record: { budget_used: used, budget_tokens: 5000, budget_explicit: true, auto_packing: packing } } } } });
    expect(capGuard([r(4990, 'cap_only'), r(5000, 'cap_only')], 'cap_only-b_pseudo', 'cap_only').pass).toBe(true);
    expect(capGuard([r(5001, 'cap_only')], 'cap_only-b_pseudo', 'cap_only').over_budget).toBe(1);
    expect(capGuard([r(4000, null)], 'cap_only-b_pseudo', 'cap_only').pass).toBe(false);
    expect(capGuard([r(4000, 'cap_only'), {}], 'cap_only-b_pseudo', 'cap_only').pass).toBe(false);
    expect(contextGuard([{ qa_context: { tokens: 7000, tokens_before: 7000, items_cut: 0 } }], 8000).pass).toBe(true);
    expect(contextGuard([{ qa_context: { tokens: 7000, tokens_before: 9000, items_cut: 2 } }], 8000).pass).toBe(false);
  });
  test('the reader check fails on two or more sign changes among the three counted readers', () => {
    expect(readerCheck(3, { a: { delta: 2 }, b: { delta: -1 }, c: { delta: 0 } })).toMatchObject({ sign_changes: ['b'], pass: true });
    expect(readerCheck(3, { a: { delta: -2 }, b: { delta: -1 }, c: { delta: 4 } })).toMatchObject({ sign_changes: ['a', 'b'], pass: false });
    expect(readerCheck(3, { a: { delta: 2 }, b: null, c: { delta: 1 } }).pass).toBeNull();
  });
  test('the dev rule: interval above zero, every guard, no descriptive loss, the reader check; highest estimate wins', () => {
    const c = (delta: number, ci_low: number, guards_pass = true, descriptive_pass = true, reader_pass: boolean | null = null) => ({ delta, ci_low, guards_pass, descriptive_pass, reader_pass });
    const pending = devRule({ cap_only: c(3, 0.5), breadth_capped: c(5, 1), depth_first: c(6, -0.5) });
    expect(pending).toMatchObject({ eligible_before_reader_check: ['breadth_capped', 'cap_only'], frontier_candidate: 'breadth_capped', verdict: 'pending reader check', choice: null });
    expect(devRule({ cap_only: c(3, 0.5, true, true, true), breadth_capped: c(5, 1, true, true, false), depth_first: c(6, -0.5) })).toMatchObject({ choice: 'cap_only', verdict: 'pass' });
    expect(devRule({ cap_only: c(3, 0.5, false), breadth_capped: c(5, 1, true, false), depth_first: c(6, -0.5) })).toMatchObject({ eligible_before_reader_check: [], frontier_candidate: 'depth_first', frontier_candidate_qualifies: false, verdict: 'inconclusive' });
  });
});

describe('E3 session fusion', () => {
  test('a session matched twice near the top outranks a single slightly higher match; ties keep first appearance', () => {
    const h = (slug: string, r: number) => ({ slug, rerank_score: r, score: 0.1 });
    const o = sessionOrders([h('a', 0.9), h('b', 0.85), h('c', 0.8), h('b', 0.7), h('d', 0.5), h('e', 0.5)]);
    expect(o.scale).toBe('rerank');
    expect(o.today).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(o.fused).toEqual(['b', 'a', 'c', 'd', 'e']);
  });
  test('a list with a missing rerank score falls back to the search score for every hit', () => {
    const o = sessionOrders([{ slug: 'a', rerank_score: 0.9, score: 0.2 }, { slug: 'b', rerank_score: null, score: 0.5 }]);
    expect(o.scale).toBe('score');
    expect(o.fused).toEqual(['b', 'a']);
  });
});

describe('local campaign cells', () => {
  test('a local cell runs the remote step on this host into its results directory, on a port derived from its lease', () => {
    const dir = join(tmp, 'camp');
    mkdirSync(dir, { recursive: true });
    const m: CampaignManifest = { kind: 'oss-shootout-campaign', schema_version: 1, campaign_id: 'e2-local', cap_usd: 10, ledger: join(dir, 'c.sqlite'),
      cells: [{ id: 'read', system: 'gbrain-query', benchmark: 'lme-s', config: 'common', lease_usd: 2, command: 'echo read', local: true }, { id: 'vm', system: 'gbrain-query', benchmark: 'lme-s', config: 'common', lease_usd: 2, command: 'echo vm' }] };
    writeFileSync(join(dir, 'm.json'), JSON.stringify(m));
    const c = new Campaign(join(dir, 'm.json'), join(dir, 'state'));
    c.init();
    const l = c.reserve('read');
    const argv = c.launchArgv(l);
    expect(argv.slice(1, 4)).toEqual([expect.stringMatching(/eval\/runner\/shootout-cell\.ts$/), 'remote', '--cell-b64']);
    expect(JSON.parse(Buffer.from(argv[4], 'base64').toString('utf8'))).toMatchObject({ lease_id: l.lease_id, lease_usd: 2, command: 'echo read', out: c.resultsDir(l) });
    expect(argv.slice(5)).toEqual(['--port', String(localPort(l.lease_id))]);
    expect(localPort(l.lease_id)).toBeGreaterThanOrEqual(9000);
    expect(localPort(l.lease_id)).toBeLessThan(9900);
    expect(c.launchArgv(c.reserve('vm'))).toContain('run');
  });
});

describe('raising a campaign cap', () => {
  test('raise-cap moves the program cap and the campaign run budget up to the manifest cap, never down', () => {
    const dir = join(tmp, 'raise');
    mkdirSync(dir, { recursive: true });
    const m: CampaignManifest = { kind: 'oss-shootout-campaign', schema_version: 1, campaign_id: 'e2-raise', cap_usd: 10, ledger: join(dir, 'c.sqlite'),
      cells: [{ id: 'big', system: 'fake', benchmark: 'fixture', config: 'common', lease_usd: 15, command: 'true' }] };
    writeFileSync(join(dir, 'm.json'), JSON.stringify(m));
    const c = new Campaign(join(dir, 'm.json'), join(dir, 'state'));
    c.init();
    expect(() => c.reserve('big')).toThrow();
    writeFileSync(join(dir, 'm.json'), JSON.stringify({ ...m, cap_usd: 20 }));
    const raised = new Campaign(join(dir, 'm.json'), join(dir, 'state'));
    expect(() => raised.raiseCap('')).toThrow(/reason/);
    expect(raised.raiseCap('user raised the cap')).toMatchObject({ cap_usd: 20, program: { program_cap_usd: 20, previous_cap_usd: 10 }, run: { budget_usd: 20, previous_budget_usd: 10 } });
    expect(raised.reserve('big').usd).toBe(15);
    writeFileSync(join(dir, 'm.json'), JSON.stringify({ ...m, cap_usd: 12 }));
    expect(() => new Campaign(join(dir, 'm.json'), join(dir, 'state')).raiseCap('lower')).toThrow();
  });
});

describe('keyless gate verdict', () => {
  const ok = () => ({ calls: 3, packing_reported_ok: 3, parity_fresh_equal: 3 });
  const g = { g1_compatibility: { pass: true }, g3_product_cap: { pass: true }, g4_reader_context: { pass: true } };
  const readings = { 'lme-s': { guards: { cap_only: g }, live: { per_packing: { off: ok(), cap_only: ok() } }, arms: { a: { n: 3, incomplete: 0 } }, frontier: { cap_only: {} } },
    descriptive: { locomo: { guard1: { pass: true }, cap: { cap_only: { pass: true } }, contexts: { cap_only: { pass: true } }, scores: { off: { n: 4, incomplete: 0 } } } } };
  const e3 = { readings: { 'lme-s-slice': { recall_all_at_5: {} }, locomo: { recall_all_at_5: {} }, 'beam-100k': { recall_all_at_5: {} } } };
  test('passes a complete keyless run and names each structural failure', () => {
    expect(gateProblems(readings, e3)).toEqual([]);
    const bad = structuredClone(readings);
    bad['lme-s'].guards.cap_only.g3_product_cap.pass = false;
    bad['lme-s'].live.per_packing.cap_only.parity_fresh_equal = 2;
    expect(gateProblems(bad, { readings: {} })).toEqual([
      expect.stringMatching(/guard 3 fails for cap_only/), expect.stringMatching(/1 calls of cap_only differ/), 'E3 has no recall reading for lme-s-slice', 'E3 has no recall reading for locomo', 'E3 has no recall reading for beam-100k']);
  });
});

// ─── Real PGLite brains at a gbrain with search.auto_packing ───────────────────────────────────────────────────────

const gut = resolveGbrainUnderTest(process.env.GBRAIN_E2_OVERLAY || null);
const load = <T,>(rel: string) => importGbrain<T>(gut, rel);
const conn = await loadConnectorModules(load);
const supported = conn.knownConfigKeys.includes('search.auto_packing');

describe.skipIf(!supported)('E2 stages on real PGLite (gbrain with search.auto_packing)', () => {
  const engines: any[] = [];
  afterAll(async () => { for (const e of engines) try { await e.disconnect(); } catch { /* ignore */ } });
  let mods: GbrainModules;
  const WORDS = ['apple', 'harbor', 'violin', 'lantern', 'island', 'meadow', 'canyon', 'jungle'];
  const page = (s: number, turns: number) => renderSessionPage({ id: String(s), date: `2023-0${1 + (s % 9)}-1${s % 10}T10:00:00.000Z`,
    turns: Array.from({ length: turns }, (_, t) => ({ speaker: t % 2 ? 'Bob' : 'Alice', content: `Session ${s} turn ${t}: the ${WORDS[(s + t) % WORDS.length]} near the harbor, then the trip to Lisbon with the violin.` })) }, { as: 'conversation' });
  const Q = 'trip to Lisbon harbor violin';

  test('setup', async () => {
    const gateway = await load<{ configureGateway: (c: Record<string, unknown>) => void; __setEmbedTransportForTests: (fn: unknown) => void }>('src/core/ai/gateway.ts');
    process.env.OPENAI_API_KEY ||= 'hash-embed-transport-no-provider-call';
    gateway.configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: process.env });
    gateway.__setEmbedTransportForTests(async (p: { values: string[] }) => ({ embeddings: p.values.map(v => hashEmbed(v, 1536)), values: p.values, warnings: [], usage: { tokens: 0 } }));
    mods = {
      PGLiteEngine: (await load<{ PGLiteEngine: GbrainModules['PGLiteEngine'] }>('src/core/pglite-engine.ts')).PGLiteEngine,
      importFromContent: (await load<{ importFromContent: GbrainModules['importFromContent'] }>('src/core/import-file.ts')).importFromContent,
      hybridSearch: (await load<{ hybridSearch: GbrainModules['hybridSearch'] }>('src/core/search/hybrid.ts')).hybridSearch,
    };
  });

  async function brain(sessions: number, turns: number) {
    const e = new mods.PGLiteEngine();
    await e.connect({});
    await e.initSchema();
    for (const [k, v] of Object.entries({ 'search.reranker.enabled': 'false', ...QUERY_PATH_PINS })) await e.setConfig(k, v);
    for (let s = 0; s < sessions; s++) await mods.importFromContent(e, `chat/${s.toString(16).padStart(16, '0')}`, page(s, turns), {});
    engines.push(e);
    return e;
  }

  test('per call: off overruns an explicit budget, every capped packing stays within it and reports itself; without a budget all four are byte-identical', async () => {
    const c = new GbrainQueryConnector(conn as ConnectorModules, await brain(30, 40));
    await c.checkPins({ ...QUERY_PATH_PINS });
    const { rows } = await c.freeze(Q, 25);
    const off = await c.deliver(rows, 'auto', 3000, 'off');
    expect(off.record.over_budget).toBe(true);
    expect(off.record.auto_packing).toBeNull();
    for (const p of ['cap_only', 'breadth_capped', 'depth_first'] as const) {
      const d = await c.deliver(rows, 'auto', 3000, p);
      expect(d.record.auto_packing).toBe(p);
      expect(d.record.budget_used!).toBeLessThanOrEqual(3000);
      expect(d.blocks.every(b => b.effective_date !== null)).toBe(true);
    }
    const none = await Promise.all(AUTO_PACKINGS.map(p => c.deliver(rows, 'auto', null, p)));
    expect(new Set(none.map(d => d.record.evidence_sha256)).size).toBe(1);
    expect(none.every(d => d.record.auto_packing === null)).toBe(true);
  });

  test('setPacking writes the config key the handler reads; the live call reports that packing and equals the assembled delivery, dates included', async () => {
    const c = new GbrainQueryConnector(conn as ConnectorModules, await brain(30, 40));
    const { rows } = await c.freeze(Q, 25);
    for (const p of AUTO_PACKINGS) {
      expect((await c.setPacking(p)).read_back).toBe(p);
      const live = await c.live('live-parity', Q, 25, 3000);
      expect(live.record.auto_packing).toBe(p === 'off' ? null : p);
      expect(live.rerank).toEqual({ calls: 0, ms: 0 });
      const assembled = await c.deliver(rows, 'auto', 3000, p);
      expect(live.record.evidence_sha256).toBe(assembled.record.evidence_sha256);
    }
  });

  test('GbrainQuerySystem: freeze, size, deliver (with guard 1) and live, on one frozen list re-resolved by chunk text', async () => {
    const dir = join(tmp, 'sys');
    mkdirSync(dir, { recursive: true });
    const sys = new GbrainQuerySystem(mods, conn as ConnectorModules, { 'search.reranker.enabled': 'false' }, { version: gut.version }, { frozenFrom: join(dir, 'frozen.ndjson'), rerankExpected: false });
    const question = { text: Q, query_time: null };
    await sys.reset('ns-a');
    for (let s = 0; s < 20; s++) await sys.ingestSession('ns-a', { source_id: `src-${s.toString(16).padStart(16, '0')}`, turns: Array.from({ length: 30 }, (_, t) => ({ speaker: t % 2 ? 'Bob' : 'Alice', role: 'user', content: `Session ${s} turn ${t}: the ${WORDS[(s + t) % WORDS.length]} near the harbor, then the trip to Lisbon with the violin.`, time: null })) } as never, `2023-0${1 + (s % 9)}-10T10:00:00`);
    const policy = (settings: Record<string, string>) => ({ name: 'gbrain-query:fixed-evidence', mode: 'fixed-evidence' as const, settings: { limit: 25, variants: 'e2', ...settings } });
    const frozen = await sys.retrieve('ns-a', question, policy({ stage: 'freeze' }));
    writeFileSync(join(dir, 'frozen.ndjson'), JSON.stringify({ accounting: frozen.accounting }) + '\n');
    await expect(sys.retrieve('ns-a', question, policy({ stage: 'freeze', grid: '3000:3000:100' }))).rejects.toThrow(/stage=size/);
    await sys.retrieve('ns-a', question, policy({ stage: 'size', grid: '3000:3200:100', size_set: 'primary' }));
    expect(sys.lastSizingE2!.map(g => [g.grid, g.budget, Object.keys(g.variants).sort()])).toEqual([3000, 3100, 3200].map(b => ['b8', b, [...AUTO_PACKINGS].sort()]));
    const d = await sys.retrieve('ns-a', question, policy({ stage: 'deliver', b_pseudo: '3000', b_native: '3200', b16_pseudo: '6000' }));
    const acc = d.accounting as any;
    expect(Object.keys(acc.deliveries)).toHaveLength(14);
    expect(acc.guard1.equal).toBe(true);
    for (const p of ['cap_only', 'breadth_capped', 'depth_first']) expect(acc.deliveries[`${p}-b_pseudo`].record.budget_used).toBeLessThanOrEqual(3000);
    const prim = await sys.retrieve('ns-a', question, policy({ stage: 'deliver', deliver_set: 'primary', b_pseudo: '3000' }));
    expect(Object.keys((prim.accounting as any).deliveries).sort()).toEqual(AUTO_PACKINGS.map(p => `${p}-b_pseudo`).sort());
    const h1 = await sys.retrieve('ns-a', question, policy({ stage: 'deliver', deliver_set: 'h1', b_pseudo: '3000' }));
    expect(Object.keys((h1.accounting as any).deliveries).sort()).toEqual([...H1_DELIVERY_VARIANTS].sort());
    expect((h1.applied_settings as any).deliver_set).toBe('h1');
    for (const v of H1_DELIVERY_VARIANTS) expect((h1.accounting as any).deliveries[v].record.evidence_sha256).toBe(acc.deliveries[v].record.evidence_sha256);
    await expect(sys.retrieve('ns-a', question, policy({ stage: 'deliver', deliver_set: 'h2', b_pseudo: '3000' }))).rejects.toThrow(/all, primary or h1/);
    const live = await sys.retrieve('ns-a', question, policy({ stage: 'live', b_pseudo: '3000', live_reps: '2' }));
    const calls = (live.accounting as any).live_checks as any[];
    expect(calls).toHaveLength(8);
    expect(calls.slice(0, 4).map(x => x.packing)).toEqual([...AUTO_PACKINGS]);
    expect(calls.slice(4).map(x => x.packing)).toEqual(['cap_only', 'breadth_capped', 'depth_first', 'off']);
    expect(calls.every(x => x.parity_fresh.equal && x.config_read_back === x.packing && x.auto_packing_reported === (x.packing === 'off' ? null : x.packing))).toBe(true);
    expect((live.accounting as any).frozen_list_equal).toBe(true);
  });
});

describe('frozen chunk text against the re-import', () => {
  test('equal except at gbrain output-redaction tokens; any other difference is a mismatch', async () => {
    const { redactedMatch } = await import('../../eval/runner/systems/gbrain-query/system.ts');
    expect(redactedMatch('a?token=<REDACTED:high_entropy_assignment>&orig b', 'a?token=Zx81kQ9vL2&orig b')).toBe(true);
    expect(redactedMatch('a <REDACTED:aws_key> b <REDACTED:email> c', 'a AKIA123 b x@y.z c')).toBe(true);
    expect(redactedMatch('a?token=<REDACTED:high_entropy_assignment>&orig b', 'a?token=Zx81&orig CHANGED')).toBe(false);
    expect(redactedMatch('no tokens here (.*)', 'no tokens here (.*)')).toBe(false);
  });
});
