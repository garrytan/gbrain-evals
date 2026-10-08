/**
 * The shootout harness pieces around `MemorySystem`: sanitizer, renderer and
 * packer, strict recall (with the scorer mutation kit), canonical outcomes
 * and resume, the multi-system exclusion join, and memory-qa end to end on
 * the keyless fixture through the TypeScript fake and a flaky HTTP shim.
 * Keyless, no network beyond 127.0.0.1.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFixture, type Conversation, type MemoryQuestion, type Session } from '../../eval/runner/memory-qa/corpus.ts';
import { canonicalize, crossSystemExclusion, freezeManifest, outcomeOf, type Manifest } from '../../eval/runner/memory-qa/outcomes.ts';
import { readerPrompt } from '../../eval/runner/memory-qa/qa.ts';
import { parseRunArgs, runArm } from '../../eval/runner/memory-qa/run.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { pairObservations } from '../../eval/runner/stats/paired.ts';
import { toObservation } from '../../eval/runner/stats/rows.ts';
import { FakeMemorySystem, serveProtocol } from '../../eval/runner/systems/fake.ts';
import { FullContextSystem } from '../../eval/runner/systems/baselines.ts';
import { BudgetRun, closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { HttpMemorySystem } from '../../eval/runner/systems/http.ts';
import { packContext, packNative, renderItem, strictSources, TOKENIZER, validateSources } from '../../eval/runner/systems/render.ts';
import { findLeaks, forbiddenMarkers, NS_RE, Sanitizer, SanitizerLeakError, SRC_RE } from '../../eval/runner/systems/sanitize.ts';
import { SystemError, type Item } from '../../eval/runner/systems/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'memory-systems-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const item = (rank: number, source_ids: string[], over: Partial<Item> = {}): Item => ({ id: `i${rank}`, rank, type: 'fact', text: `fact ${rank}`, source_ids, valid_from: null, valid_to: null, provenance_status: source_ids.length ? 'exact' : 'unavailable', ...over });

describe('sanitizer', () => {
  const lme: { conversations: Conversation[]; questions: MemoryQuestion[] } = {
    conversations: [{ id: 'gpt4_2655b836_abs', sessions: [
      { id: 'answer_4be1b6b4_2', date: '2023/05/20 (Sat) 02:21', turns: [{ speaker: 'user', content: 'I bought a red bicycle at the shop downtown.' }, { speaker: 'assistant', content: 'Nice choice.' }] },
      { id: 'sharegpt_yywfq3u_0', date: '2023/05/18 (Thu) 11:00', turns: [{ speaker: 'user', content: 'Can you suggest a pasta recipe?' }] },
      { id: 'ultrachat_552113', turns: [{ speaker: 'user', content: 'Tell me about trains.' }] },
    ] }],
    questions: [{ id: 'gpt4_2655b836_abs', conversation: 'gpt4_2655b836_abs', question: 'What color is my car?', question_date: '2023/05/30 (Tue) 23:40', category: 'single-session-user', gold: [], abstention: true, answer: 'unknown' }],
  };
  const san = new Sanitizer(lme, 'salt-1');

  test('every id that crosses is opaque; raw ids, categories and _abs are forbidden markers', () => {
    expect(san.ns('gpt4_2655b836_abs')).toMatch(NS_RE);
    expect(san.markers).toEqual(expect.arrayContaining(['_abs', 'gpt4_2655b836_abs', 'answer_4be1b6b4_2', 'single-session-user']));
    const plan = san.ingestPlan(lme.conversations[0]);
    for (const s of plan) expect(s.input.source_id).toMatch(SRC_RE);
    expect(san.sessionOf(san.ns('gpt4_2655b836_abs'), plan[0].input.source_id)).toBe('sharegpt_yywfq3u_0');
    expect(san.sessionOf(san.ns('other'), plan[0].input.source_id)).toBeUndefined();
  });

  test('sessions go in event-time order; an undated session gets a counted synthetic time after the previous one', () => {
    const plan = san.ingestPlan(lme.conversations[0]);
    expect(plan.map(s => [s.session.id, s.event_time, s.synthetic_time])).toEqual([
      ['sharegpt_yywfq3u_0', '2023-05-18T11:00:00', false], ['answer_4be1b6b4_2', '2023-05-20T02:21:00', false], ['ultrachat_552113', '2023-05-18T11:01:00', true],
    ].sort((a, b) => String(a[1]) < String(b[1]) ? -1 : 1));
    expect(san.question(lme.questions[0])).toEqual({ text: 'What color is my car?', query_time: '2023-05-30T23:40:00' });
  });

  test('captured HTTP bodies for a whole LongMemEval-style haystack carry no marker', async () => {
    const bodies: string[] = [];
    const server = serveProtocol(new FakeMemorySystem());
    try {
      const sys = new HttpMemorySystem(server.url, { markers: san.markers, onRequest: (_p, b) => bodies.push(b) });
      const ns = san.ns('gpt4_2655b836_abs');
      await sys.reset(ns);
      for (const s of san.ingestPlan(lme.conversations[0])) await sys.ingestSession(ns, s.input, s.event_time);
      await sys.finishIngest(ns);
      await sys.retrieve(ns, san.question(lme.questions[0]), { name: 'fake:vendor-default', mode: 'vendor-default', settings: {} });
    } finally { server.stop(); }
    expect(bodies.length).toBe(6);
    expect(bodies.flatMap(b => findLeaks(b, san.markers))).toEqual([]);
  });

  test('a marker inside the system\'s own name (its policy names) does not refuse its requests; the marker elsewhere still does', async () => {
    const server = serveProtocol(new FakeMemorySystem());
    try {
      const sys = new HttpMemorySystem(server.url, { name: 'ext-temporal-graph', markers: ['temporal'] });
      const ns = san.ns('gpt4_2655b836_abs');
      await sys.reset(ns);
      await sys.retrieve(ns, { text: 'What color is my car?', query_time: null }, { name: 'ext-temporal-graph:fixed-evidence', mode: 'fixed-evidence', settings: {} });
      await expect(sys.retrieve(ns, { text: 'a temporal question', query_time: null }, { name: 'ext-temporal-graph:fixed-evidence', mode: 'fixed-evidence', settings: {} })).rejects.toBeInstanceOf(SanitizerLeakError);
    } finally { server.stop(); }
  });

  test('a marker that the corpus text itself contains is not forbidden', () => {
    expect(forbiddenMarkers({ conversations: [{ id: 'conv-1', sessions: [{ id: 'session_1', turns: [{ speaker: 'a', content: 'see session_1 notes' }] }] }], questions: [] })).not.toContain('session_1');
  });
});

describe('renderer and packer', () => {
  test('native items print their validity window, mark superseded facts, and pack whole items in rank order', () => {
    const items = [item(1, ['src-a'], { text: 'Lives in Boston', valid_from: '2023-01-01T00:00:00', valid_to: '2023-06-01T00:00:00' }), item(2, ['src-b'], { text: 'x'.repeat(400) }), item(3, ['src-c'], { text: 'short' })];
    expect(renderItem(items[0])).toBe('- (1, fact, superseded) [valid 2023-01-01 to 2023-06-01] Lives in Boston');
    const first = TOKENIZER.count(renderItem(items[0]) + '\n');
    expect(packNative(items, first + 5).items.map(i => i.id)).toEqual(['i1']);
    expect(packNative(items, null).items.map(i => i.id)).toEqual(['i1', 'i2', 'i3']);
    expect(packNative(items, null, 2).items.map(i => i.id)).toEqual(['i1', 'i2']);
  });

  test('rehydrated context is the legacy LongMemEval reading prompt, sessions in first-appearance selection', () => {
    const corpus = loadFixture();
    const conv = corpus.conversations[0];
    const q = corpus.questions.find(x => x.conversation === conv.id)!;
    const src = (s: Session) => `src-${s.id}`;
    const items = [item(1, [src(conv.sessions[1]), src(conv.sessions[0])]), item(2, [src(conv.sessions[1])]), item(3, [src(conv.sessions[2])])];
    const p = packContext('rehydrated', q, items, { budgetTokens: null, sessionOf: id => conv.sessions.find(s => src(s) === id), fallbackDate: '2026-04-01' });
    expect(p.source_ids).toEqual([src(conv.sessions[1]), src(conv.sessions[0]), src(conv.sessions[2])]);
    expect(p.prompt).toBe(readerPrompt(q, [conv.sessions[1], conv.sessions[0], conv.sessions[2]], '2026-04-01'));
    expect(p.tokenizer).toBe('approx-chars-div-4');
  });

  test('full-context under a budget drops the earliest sessions and shows the kept ones in chronological order', async () => {
    const full = new FullContextSystem();
    for (const [i, day] of ['01', '02', '03', '04'].entries()) await full.ingestSession('ns-x', { source_id: `src-${i}`, turns: [{ role: 'user', speaker: 'user', content: `day ${day} ${'x'.repeat(380)}` }] }, `2024-01-${day}T00:00:00`);
    const { items } = await full.retrieve('ns-x', { text: 'q', query_time: null }, { name: 'p', mode: 'fixed-evidence', settings: {} });
    const q = { id: 'q', conversation: 'c', question: 'What happened?', category: 'x', gold: [], abstention: false } as MemoryQuestion;
    const one = TOKENIZER.count(renderItem(items[0]) + '\n');
    const native = packContext('native', q, items, { budgetTokens: one * 2 + 1, sessionOf: () => undefined, present: 'event-time' });
    expect(native.item_ids).toEqual(['src-3', 'src-2']);
    expect(native.prompt.indexOf('day 03')).toBeLessThan(native.prompt.indexOf('day 04'));
    expect(native.prompt).not.toContain('day 01');
    const sessions = new Map(['01', '02', '03', '04'].map((d, i) => [`src-${i}`, { id: `s${i}`, date: `2024-01-${d}`, turns: [{ speaker: 'user', content: `day ${d} ${'x'.repeat(380)}` }] }]));
    const rehydrated = packContext('rehydrated', q, items, { budgetTokens: 260, sessionOf: id => sessions.get(id) });
    expect(rehydrated.source_ids).toEqual(['src-3', 'src-2']);
    expect(rehydrated.prompt.indexOf('day 03')).toBeLessThan(rehydrated.prompt.indexOf('day 04'));
  });

  test('foreign source ids and out-of-order ranks are product errors', () => {
    expect(() => validateSources([item(1, ['src-x'])], new Set(['src-a']))).toThrow(SystemError);
    expect(() => validateSources([item(2, ['src-a']), item(1, ['src-a'])], new Set(['src-a']))).toThrow(/rank order/);
  });

  test('strict recall takes whole items in first-appearance order and records fan-out', () => {
    const r = strictSources([item(1, ['a']), item(2, ['b', 'c', 'd', 'e', 'f']), item(3, ['g'])], 5);
    expect(r.sources).toEqual(['a']);
    expect(r.fanout_max).toBe(5);
    expect(strictSources([item(1, ['a']), item(2, ['a', 'b']), item(3, [])], 5).sources).toEqual(['a', 'b']);
    expect(strictSources([item(1, [])], 5).measurable).toBe(false);
  });

  test('strict recall rejects every fake system in the mutation kit', () => {
    const N = 12;
    const probes = Array.from({ length: 6 }, (_, p) => ({ ns: `ns${p}`, sessions: Array.from({ length: N }, (_, i) => `ns${p}-s${i}`), gold: [`ns${p}-s${(p * 5) % N}`, `ns${p}-s${(p * 5 + 7) % N}`] }));
    type Probe = typeof probes[number];
    assertScorerRejectsFakeSystems<Probe, Item[]>({
      category: 'memory-qa strict recall',
      probes,
      space: {
        truth: p => [...p.gold, ...p.sessions.filter(s => !p.gold.includes(s))].slice(0, 6).map((s, i) => item(i + 1, [s])),
        empty: () => [],
        everything: p => [item(1, [...p.sessions].reverse())],
        refusal: p => p.sessions.slice(0, 5).map((_, i) => item(i + 1, [])),
        stale: p => p.sessions.filter(s => !p.gold.includes(s)).slice(0, 5).map((s, i) => item(i + 1, [s])),
        wrongSource: p => p.gold.map((g, i) => item(i + 1, [`other-${g}`])),
      },
      score: answers => {
        const recalls = answers.map((items, k): number => {
          try { validateSources(items, new Set(probes[k].sessions)); } catch { return 0; }
          const got = strictSources(items, 5);
          return got.measurable && probes[k].gold.every(g => got.sources.includes(g)) ? 1 : 0;
        });
        const mean = recalls.reduce((a, b) => a + b, 0) / recalls.length;
        return { pass: mean >= 0.9, detail: `recall_all@5 ${mean.toFixed(2)}` };
      },
    });
  });
});

describe('canonical outcomes', () => {
  const manifest = (ids: string[]): Manifest => ({ kind: 'memory-qa-manifest', schema_version: 1, run_config_hash: 'h', expected: ids, expected_sha256: 'x', created_at: '' });
  test('the latest attempt wins, failures retry until the limit, foreign ids are reported, and outcomes derive from legacy rows', () => {
    const attempts = [
      { id: 'q1', error: null }, { id: 'q2', error: 'boom', error_origin: 'sut' }, { id: 'q2', error: null }, { id: 'q3', qa_error: 'reader: 500' },
      { id: 'q4', error: 'BudgetExceededError: over', error_origin: 'harness' }, { id: 'q4', error: 'BudgetExceededError: over', error_origin: 'harness' }, { id: 'zz', error: null },
      { id: 'q5', qa_error: 'judge: parse' }, { id: 'q6', error: 'x', error_origin: 'sut', outcome: 'unsupported' },
    ];
    const c = canonicalize(manifest(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']), attempts, 2);
    expect(c.rows.map(r => r.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
    expect(c.outcomes.map(o => [o.id, o.outcome, o.attempts])).toEqual([['q1', 'scored', 1], ['q2', 'scored', 2], ['q3', 'reader_error', 1], ['q4', 'budget_not_run', 2], ['q5', 'judge_error', 1], ['q6', 'unsupported', 1]]);
    expect([...c.pending].sort()).toEqual(['q3', 'q5', 'q7']);
    expect(c.missing).toEqual(['q7']);
    expect(c.foreign).toEqual(['zz']);
    expect(outcomeOf({ error: 'x', error_origin: 'dependency' })).toBe('harness_invalid');
  });

  test('a resume with a different selection is refused', () => {
    const dir = mkdtempSync(join(tmp, 'man-'));
    freezeManifest(dir, 'h1', ['a', 'b']);
    expect(freezeManifest(dir, 'h1', ['a', 'b']).expected).toEqual(['a', 'b']);
    expect(() => freezeManifest(dir, 'h1', ['a'])).toThrow(/frozen manifest/);
    expect(() => freezeManifest(dir, 'h2', ['a', 'b'])).toThrow(/different run configuration/);
  });

  test('a reader failure on one system excludes that id from every system before pairing', () => {
    const sel = { idField: 'id', metric: 'qa_score', clusterBy: 'conversation' };
    const rows = (failing: string | null) => Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, conversation: `c${i}`, ...(failing === `q${i}` ? { qa_error: 'reader: 503' } : { qa_score: i % 2 }) }));
    const a = rows('q3').map(r => toObservation(r, sel)), b = rows(null).map(r => toObservation(r, sel));
    expect(() => pairObservations(a, b)).toThrow(/eligibility differs for q3/);
    const joined = crossSystemExclusion({ a, b });
    expect(joined.excluded).toEqual(['q3']);
    const pairing = pairObservations(joined.bySystem.a, joined.bySystem.b);
    expect(pairing.pairs).toHaveLength(11);
    expect(pairing.excluded).toEqual([{ id: 'q3', reason: 'reader or judge error' }]);
  });
});

describe('memory-qa with a MemorySystem', () => {
  const args = (out: string, ...extra: string[]) => parseRunArgs(['--benchmark', 'fixture', '--output', out, ...extra]);

  test('the TypeScript fake runs the fixture end to end with canonical files', async () => {
    const out = join(tmp, 'fake-run');
    const { receipt, rows } = await runArm(args(out, '--system', 'fake'));
    expect(receipt.run_status).toBe('complete');
    expect(rows).toHaveLength(8);
    expect(rows.every(r => r.outcome === 'scored' && r.system === 'fake' && r.context === 'rehydrated')).toBe(true);
    expect(rows.find(r => r.id === 'fx-00')!.retrieved![0]).toBe('s2');
    expect((receipt as any).outcomes.scored).toBe(8);
    expect((receipt as any).ingest).toMatchObject({ conversations: 4, failed_sessions: 0, synthetic_times: 0, degraded_conversations: 0 });
    expect(readFileSync(join(out, 'attempts.ndjson'), 'utf8').trim().split('\n')).toHaveLength(8);
    const again = await runArm(args(out, '--system', 'fake'));
    expect(again.rows).toHaveLength(8);
    expect((again.receipt as any).attempts_this_run).toBe(0);
  });

  test('a flaky shim: product errors retry on resume without duplicate rows; a permanent failure becomes terminal at the attempt limit', async () => {
    const calls = new Map<string, number>();
    const fake = new FakeMemorySystem();
    const original = fake.retrieve.bind(fake);
    fake.retrieve = async (ns, q, p) => {
      if (p.mode === 'fixed-evidence') return original(ns, q, p);
      const n = (calls.get(q.text) ?? 0) + 1; calls.set(q.text, n);
      if (/vet visit/.test(q.text) && n === 1) throw new SystemError('timeout', 'vendor timed out');
      if (/hallway/.test(q.text)) throw new SystemError('product_error', 'always broken');
      return original(ns, q, p);
    };
    const server = serveProtocol(fake);
    const out = join(tmp, 'flaky');
    try {
      const first = await runArm(args(out, '--system', server.url, '--max-attempts', '2'));
      expect((first.receipt as any).outcomes).toMatchObject({ scored: 6, retrieval_error: 2 });
      const second = await runArm(args(out, '--system', server.url, '--max-attempts', '2'));
      expect(second.rows).toHaveLength(8);
      expect(new Set(second.rows.map(r => r.id)).size).toBe(8);
      expect((second.receipt as any).outcomes).toMatchObject({ scored: 7, retrieval_error: 1 });
      expect((second.receipt as any).attempts_this_run).toBe(2);
      const third = await runArm(args(out, '--system', server.url, '--max-attempts', '2'));
      expect((third.receipt as any).attempts_this_run).toBe(0);
      expect(readFileSync(join(out, 'attempts.ndjson'), 'utf8').trim().split('\n')).toHaveLength(10);
      const outcomes = readFileSync(join(out, 'outcomes.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(outcomes.find(o => o.outcome === 'retrieval_error')).toMatchObject({ attempts: 2 });
      expect(third.receipt.run_status).toBe('complete');
    } finally { server.stop(); }
  });

  test('the gbrain shootout recipe sends its provider calls through the lease proxy with dummy keys, and needs no paid flags there', async () => {
    const seen: Array<{ path: string; auth: string | null; model: string }> = [];
    const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
      const body = await req.json().catch(() => ({})) as { model?: string; documents?: string[] };
      if (new URL(req.url).pathname.startsWith('/__proxy/')) return Response.json({ usd: 0, requests: 0, unpriced: 0, byModel: {} });
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), model: String(body.model) });
      return Response.json({ object: 'list', model: body.model, data: (body.documents ?? []).map((_, i) => ({ index: i, relevance_score: 1 - i / 10 })), usage: { total_tokens: 5 } });
    } });
    const out = join(tmp, 'gbrain-shootout-proxy');
    try {
      const proc = Bun.spawn([process.execPath, 'eval/runner/memory-qa/run.ts', '--benchmark', 'fixture', '--system', 'gbrain-shootout', '--context', 'native', '--provider-proxy', `http://127.0.0.1:${upstream.port}`, '--output', out],
        { cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GBRAIN_EVALS_QA_CACHE: join(out, 'qa') } });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code, err).toBe(0);
    } finally { upstream.stop(true); }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(r => r.path === '/harness/voyage/v1/rerank' && r.auth === 'Bearer dummy-key-the-proxy-replaces' && r.model === 'rerank-2.5')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
    expect(receipt.metering.mode).toBe('lease-proxy');
    expect(receipt.run_status).toBe('complete');
    expect(receipt.system.capabilities.retrieval_policies).toEqual({ 'vendor-default': { settings: {} }, 'fixed-evidence': { settings: { limit: 40 } } });
    expect(receipt.policy).toMatchObject({ mode: 'vendor-default', settings: {}, settings_source: 'settings' });
  }, 120_000);

  test('the D1 controls run end to end: context controls carry no recall, plain hybrid does', async () => {
    for (const [system, measurable] of [['full-context', false], ['no-memory', false], ['plain-hybrid', true]] as const) {
      const { receipt, rows } = await runArm(args(join(tmp, `d1-${system}`), '--system', system, '--embed', 'hash'));
      expect(receipt.run_status).toBe('complete');
      expect(rows.every(r => r.outcome === 'scored')).toBe(true);
      expect(rows.filter(r => !r.abstention).every(r => (r.recall_measurable !== false) === measurable)).toBe(true);
    }
  });

  test('readiness probe: a shim whose quiescence signal lies (indexes late) marks its conversations ingest-degraded; an honest one passes', async () => {
    const late = new FakeMemorySystem();
    const original = late.retrieve.bind(late);
    const probed = new Set<string>();
    late.retrieve = async (ns, q, p) => {
      if (!probed.has(ns)) { probed.add(ns); return { items: [], applied_settings: {}, truncated: false }; }
      return original(ns, q, p);
    };
    const server = serveProtocol(late);
    try {
      const { receipt, rows } = await runArm(args(join(tmp, 'late-index'), '--system', server.url));
      expect((receipt as any).ingest).toMatchObject({ conversations: 4, readiness_probe_misses: 4, degraded_conversations: 4 });
      expect(rows.every(r => r.outcome === 'ingest_degraded' && r.ingest?.readiness_probe === 'missed')).toBe(true);
      expect((receipt as any).outcomes.ingest_degraded).toBe(8);
    } finally { server.stop(); }
    const honest = await runArm(args(join(tmp, 'honest-index'), '--system', 'fake'));
    expect(honest.rows.every(r => r.ingest?.readiness_probe === 'found' && r.outcome === 'scored')).toBe(true);
    const flaky = new FakeMemorySystem();
    const base = flaky.retrieve.bind(flaky);
    const errors = new Map<string, number>();
    flaky.retrieve = async (ns, q, p) => {
      const n = (errors.get(ns) ?? 0) + 1; errors.set(ns, n);
      if (p.mode === 'fixed-evidence' && n === 1) throw new SystemError('timeout', 'vendor hiccup');
      return base(ns, q, p);
    };
    const flakyServer = serveProtocol(flaky);
    try {
      const once = await runArm(args(join(tmp, 'probe-retry'), '--system', flakyServer.url));
      expect(once.rows.every(r => r.ingest?.readiness_probe === 'found' && r.outcome === 'scored')).toBe(true);
    } finally { flakyServer.stop(); }
    const broken = new FakeMemorySystem();
    const brokenBase = broken.retrieve.bind(broken);
    broken.retrieve = async (ns, q, p) => { if (p.mode === 'fixed-evidence') throw new SystemError('product_error', 'probe always fails'); return brokenBase(ns, q, p); };
    const brokenServer = serveProtocol(broken);
    try {
      const twice = await runArm(args(join(tmp, 'probe-broken'), '--system', brokenServer.url));
      expect(twice.rows.every(r => r.ingest?.readiness_probe === 'missed' && r.outcome === 'ingest_degraded')).toBe(true);
    } finally { brokenServer.stop(); }
    const control = await runArm(args(join(tmp, 'probe-control'), '--system', 'no-memory'));
    expect(control.rows.every(r => r.ingest?.readiness_probe === 'not-measurable' && r.outcome === 'scored')).toBe(true);
  });

  test('receipts carry the shim identity; a recipe run and a common run never share an output directory', async () => {
    const out = join(tmp, 'identity');
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = probe.port as number;
    probe.stop(true);
    let server = serveProtocol(new FakeMemorySystem(), { port, config: 'recipe' });
    try {
      const { receipt } = await runArm(args(out, '--system', server.url));
      expect((receipt as any).system.identity).toMatchObject({ system: 'fake', config: 'recipe', versions: { package: 'in-repo' }, health: { ok: true, config: 'recipe' } });
    } finally { server.stop(); }
    server = serveProtocol(new FakeMemorySystem(), { port, config: 'common' });
    try {
      await expect(runArm(args(out, '--system', server.url))).rejects.toThrow(/different run configuration/);
      const { receipt } = await runArm(args(join(tmp, 'identity-common'), '--system', server.url));
      expect((receipt as any).system.identity.config).toBe('common');
    } finally { server.stop(); }
  });

  test('a failed session keeps its error kind and message in the attempt row and the receipt', async () => {
    const fake = new FakeMemorySystem();
    const base = fake.ingestSession.bind(fake);
    let n = 0;
    fake.ingestSession = async (ns, s, t) => { if (++n === 2) throw new SystemError('timeout', 'vendor queue timed out'); return base(ns, s, t); };
    const server = serveProtocol(fake);
    try {
      const out = join(tmp, 'ingest-errors');
      const { receipt } = await runArm(args(out, '--system', server.url));
      expect((receipt as any).ingest.error_kinds).toEqual({ timeout: 1 });
      expect((receipt as any).ingest.errors[0]).toMatchObject({ kind: 'timeout', message: expect.stringContaining('vendor queue timed out') });
      expect((receipt as any).ingest.errors[0].source_id).toMatch(/^src-[0-9a-f]{16}$/);
      const attempts = readFileSync(join(out, 'attempts.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(attempts.some(r => r.ingest?.errors?.[0]?.kind === 'timeout')).toBe(true);
    } finally { server.stop(); }
  });

  test('a policy sends only its knob map; a record without settings is flattened and says so', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const flat = new FakeMemorySystem();
    const caps = flat.capabilities.bind(flat);
    const retrieve = flat.retrieve.bind(flat);
    flat.capabilities = async () => ({ ...(await caps()), retrieval_policies: { 'vendor-default': { k: 3, maps_to: 'search(top_k=3)', notes: 'doc' }, 'fixed-evidence': { k: 20 } } });
    flat.retrieve = async (ns, q, p) => { if (p.mode === 'vendor-default') seen.push(p.settings); return retrieve(ns, q, p); };
    const server = serveProtocol(flat);
    try {
      const { receipt } = await runArm(args(join(tmp, 'flattened'), '--system', server.url));
      expect(seen.every(s => JSON.stringify(s) === JSON.stringify({ k: 3 }))).toBe(true);
      expect((receipt as any).policy).toMatchObject({ settings: { k: 3 }, settings_source: 'flattened' });
    } finally { server.stop(); }
    const { receipt } = await runArm(args(join(tmp, 'knobs'), '--system', 'fake', '--policy-setting', 'k=2'));
    expect((receipt as any).policy).toMatchObject({ settings: { k: '2' }, settings_source: 'settings' });
  });

  test('the paid guard reads --budget-ledger, not only the default ledger', () => {
    const ledger = join(tmp, 'custom-ledger.sqlite');
    const run = BudgetRun.open({ runner: 'test', budgetUsd: 0.01, ledgerPath: ledger, programCapUsd: 1 });
    closeLedgers();
    const proc = Bun.spawnSync([process.execPath, 'eval/runner/memory-qa/run.ts', '--benchmark', 'fixture', '--system', 'fake', '--qa', 'reader', '--output', join(tmp, 'ledger-run'),
      '--paid', '--budget-run-id', run.runId, '--budget-ledger', ledger], { cwd: join(import.meta.dir, '../..'), env: { ...process.env, BRAINBENCH_BUDGET_LEDGER: '' } });
    const err = proc.stderr.toString();
    expect(proc.exitCode).not.toBe(0);
    expect(err).toContain(`run ${run.runId} has only $0.01 left`);
  });

  test('flags: native context and budgets are accepted for shootout systems; gbrain-only lanes are refused elsewhere', async () => {
    const a = args(join(tmp, 'x'), '--system', 'fake', '--context', 'native', '--budget-tokens', '8000', '--policy', 'fixed-evidence');
    expect([a.context, a.qa.budgetTokens, a.policy]).toEqual(['native', 8000, 'fixed-evidence']);
    await expect(runArm(args(join(tmp, 'y'), '--system', 'fake', '--facts', 'conversation'))).rejects.toThrow(/need --system gbrain/);
    await expect(runArm(args(join(tmp, 'z'), '--context', 'native'))).rejects.toThrow(/legacy rehydrated/);
    await expect(runArm(args(join(tmp, 'w'), '--system', 'nonsense'))).rejects.toThrow(/--system must be/);
  });
});
