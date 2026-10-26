/**
 * The 8k conversion (preregistration docs/benchmarks/2026-10-26-gbrain-8k-conversion-preregistration.md), keyless:
 * the committed decision directory agrees with itself and the harness; the preregistered rule (decideC8k) in every
 * branch; the product-text renderer adds nothing and cuts whole rows; the stub facts and the determinism questions.
 * The whole chain runs in c8k-dry-run.sh (receipts committed).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';
import { assertFilled, decideC8k, determinismQuestions, loadDecision, type C8kDecision } from '../../eval/runner/budgeted-delivery/c8k.ts';
import { BRAIN_SETTINGS, C8K_ARMS, C8K_KEYS, HARNESS_BUDGET_TOKENS, QUERY_BUDGET, READER_TEMPLATE_SHA256, RECIPE_HASH, RENDERER_VERSION, renderContext } from '../../eval/runner/budgeted-delivery/c8k-product.ts';
import { stubFacts } from '../../eval/runner/budgeted-delivery/stub-proxy.ts';
import { cachingRerankTransport, installRetrievalCache, rerankKey, retrievalCacheReceipt, type RetrievalCacheModules } from '../../eval/runner/budgeted-delivery/c8k-retrieval-cache.ts';
import { READER_TEMPLATE } from '../../eval/runner/memory-qa/qa.ts';
import { loadCampaign } from '../../eval/runner/shootout-cell.ts';
import { loadFamily } from '../../eval/runner/stats/gates.ts';

const REPO = resolve(import.meta.dir, '../..');
const DIR = join(REPO, 'docs/benchmarks/2026-10-26-gbrain-8k-conversion');
const { decision: D } = loadDecision(join(DIR, 'decision.json'));
type Row = Record<string, any>;

describe('the committed decision directory', () => {
  test('arms, keys, budgets and renderer are the harness\'s', () => {
    const arms = (D as unknown as { arms: Array<{ id: string; keys: Record<string, string> }> }).arms;
    expect(arms.map(a => a.id)).toEqual(C8K_ARMS.map(a => a.id));
    for (const a of arms) expect(a.keys).toEqual(C8K_ARMS.find(x => x.id === a.id)!.keys);
    expect(C8K_ARMS.find(a => a.id === 'B3')!.keys).toEqual({ 'search.query_facts_block': 'true' });
    expect(C8K_KEYS.filter(k => C8K_ARMS.some(a => k in a.keys))).toEqual(C8K_KEYS.filter(k => k !== 'search.fact_source_pages'));
    expect(D.construction.query_budget).toBe(QUERY_BUDGET);
    expect(D.construction.harness_budget_tokens).toBe(HARNESS_BUDGET_TOKENS);
    expect(D.construction.renderer).toMatchObject({ version: RENDERER_VERSION, recipe_hash: RECIPE_HASH, reader_template_sha256: READER_TEMPLATE_SHA256 });
    expect(createHash('sha256').update(READER_TEMPLATE).digest('hex')).toBe(READER_TEMPLATE_SHA256);
    expect((D.construction as unknown as { brain_settings: Record<string, string> }).brain_settings).toEqual({ ...BRAIN_SETTINGS });
  });

  test('answer arms: Sonnet decides, two replay readers, two development readers, every arm each; 18 label reads', () => {
    const by = (role: string) => D.answer_arms.filter(a => a.role === role);
    expect(by('primary').map(a => a.arm)).toEqual(C8K_ARMS.map(a => a.id));
    expect(new Set(by('primary').map(a => a.model))).toEqual(new Set([D.readers.primary]));
    expect(new Set(by('replay').map(a => a.model))).toEqual(new Set(D.readers.replay));
    expect(new Set(by('development').map(a => a.model))).toEqual(new Set(D.readers.development));
    expect(by('replay')).toHaveLength(12);
    expect(by('development')).toHaveLength(12);
    expect(D.rule.expected_label_reads).toBe(by('primary').length + by('replay').length);
    for (const c of D.rule.comparisons) expect([c.a, c.b].every(a => C8K_ARMS.some(x => x.id === a))).toBe(true);
    expect(D.rule.holm.over).toEqual(D.rule.comparisons.map(c => c.id));
    expect(D.rule.f1_noninferiority).toEqual({ comparison: 'D1', reference: 'R5', candidate: 'A1', lower_bound_above: -0.05 });
  });

  test('one $300 campaign covers the development and held-out cells, each cell its step\'s cap', () => {
    loadFamily(join(DIR, 'family.json'));
    loadFamily(join(DIR, 'family-descriptive.json'));
    const dev = (D as unknown as { development: { budget: { cap_usd: number; estimate_usd: number; steps: Array<{ id: string; cap_usd: number; estimate_usd: number }> } } }).development.budget;
    const { manifest } = loadCampaign(join(DIR, 'manifests/campaign.json'));
    expect(manifest.cap_usd).toBe(300);
    expect(manifest.cap_usd).toBe((D.budget as unknown as { program_cap_usd: number }).program_cap_usd);
    expect(D.budget.cap_usd + dev.cap_usd).toBe(manifest.cap_usd);
    expect(manifest.cells.map(c => [c.id, c.lease_usd])).toEqual([...dev.steps.map(s => [`c8k-${s.id}`, s.cap_usd]), ...D.budget.steps.map(s => [`c8k-${s.id}`, s.cap_usd])]);
    expect(manifest.cells.every(c => c.local && c.command.startsWith('bash eval/runner/budgeted-delivery/c8k-run.sh cell '))).toBe(true);
    expect(D.budget.steps.reduce((n, s) => n + s.cap_usd, 0)).toBe(D.budget.cap_usd);
    expect(dev.steps.reduce((n, s) => n + s.cap_usd, 0)).toBe(dev.cap_usd);
    expect(D.budget.steps.reduce((n, s) => n + s.estimate_usd, 0)).toBeCloseTo(D.budget.estimate_usd, 6);
    expect(dev.steps.reduce((n, s) => n + s.estimate_usd, 0)).toBeCloseTo(dev.estimate_usd, 6);
  });

  test('measures the wave PR head; ready for custody with the access log filled, refused when any line is not', () => {
    expect(D.gbrain.commit).toBe('cf3ec433f4fffda60d00076bae7361100c632cc4');
    expect(JSON.parse(readFileSync(join(DIR, 'manifests/campaign.json'), 'utf8')).parameters.gbrain_sha).toBe(D.gbrain.commit);
    expect(D.sealed.access_log_before.lines).toBe(35);
    expect(D.sealed.access_log_before.entries).toHaveLength(35);
    expect(() => assertFilled(D)).not.toThrow();
    expect(() => assertFilled({ ...D, gbrain: { ...D.gbrain, commit: 'fill-at-freeze' } })).toThrow(/gbrain.commit/);
    const unfilled = structuredClone(D) as C8kDecision;
    unfilled.sealed.access_log_before.entries[6] = { action: 'fill-at-custody', decision_id: unfilled.sealed.access_log_before.entries[6].decision_id };
    expect(() => assertFilled(unfilled)).toThrow(/access_log_before/);
    const short = structuredClone(D) as C8kDecision;
    short.sealed.access_log_before.entries.pop();
    expect(() => assertFilled(short)).toThrow(/access_log_before/);
  });
});

describe('the preregistered rule (decideC8k)', () => {
  const kinds = { 'multi-session': 80, 'temporal-reasoning': 40, 'knowledge-update': 40, abstention: 40 };
  /** 200 rows per arm; base is right on even indices. A1 to A3 each flip questions of a kind from the arm before; B3 flips from A0. */
  const armRows = (steps: Record<string, { wins?: Record<string, number>; losses?: Record<string, number> }>) => {
    const out: Record<string, Row[]> = {};
    let prev: Row[] = [];
    for (const [k, n] of Object.entries(kinds)) for (let i = 0; i < n; i++) prev.push({ question_id: `${k}-${i}`, haystack_id: `h${i % 40}`, question_type: k, answer_correct: i % 2 === 0 });
    out.A0 = prev;
    for (const arm of ['A1', 'A2', 'A3', 'B3']) {
      const s = steps[arm] ?? {};
      const left: Record<string, { w: number; l: number }> = Object.fromEntries(Object.keys(kinds).map(k => [k, { w: s.wins?.[k] ?? 0, l: s.losses?.[k] ?? 0 }]));
      out[arm] = (arm === 'B3' ? out.A0 : prev).map(r => {
        const c = left[r.question_type];
        if (!r.answer_correct && c.w > 0) { c.w--; return { ...r, answer_correct: true }; }
        if (r.answer_correct && c.l > 0) { c.l--; return { ...r, answer_correct: false }; }
        return r;
      });
      if (arm !== 'B3') prev = out[arm];
    }
    out.R5 = out.A0;
    return out;
  };
  const cmp = (id: string, delta: number, lo: number, hi: number, p: number) => ({ id: 'answer_accuracy', status: 'ok', stats: { delta, ci95: [lo, hi] as [number, number], p_two_sided: p, n_pairs: 200, n_clusters: 40, mean_a: 0.5, mean_b: 0.5 + delta }, mcnemar: { wins: 20, losses: 4, p_two_sided: p } });
  const strong = { D1: cmp('D1', 0.08, 0.03, 0.13, 0.001), D2: cmp('D2', 0.08, 0.03, 0.13, 0.002), D3: cmp('D3', 0.08, 0.03, 0.13, 0.003), D3p: cmp('D3p', 0.08, 0.03, 0.13, 0.004) };
  const worse = (id: string) => cmp(id, -0.08, -0.13, -0.02, 0.001);
  const wins = { wins: { 'multi-session': 6, 'temporal-reasoning': 5, 'knowledge-update': 5 } };
  const allWins = { A1: wins, A2: wins, A3: wins, B3: wins };
  const run = (o: Partial<Parameters<typeof decideC8k>[1]> & { steps?: Parameters<typeof armRows>[0] } = {}) =>
    decideC8k(D.rule, { gatePass: true, comparisons: strong, rows: armRows(o.steps ?? allWins), readerErrors: {}, r5: cmp('F1', 0.02, -0.02, 0.06, 0.4), ...o });
  const verdicts = (r: ReturnType<typeof decideC8k>) => Object.fromEntries(r.comparisons.map(c => [c.id, c.label]));
  const F3 = D.rule.recommendations.D3p;

  test('the amended family (spec change 7): D1 to D3 chained, D3p is B3 against A0, F3 either way', () => {
    expect(D.rule.comparisons.map(c => [c.id, c.a, c.b, c.tests])).toEqual([['D1', 'A0', 'A1', 'F1'], ['D2', 'A1', 'A2', 'F2'], ['D3', 'A2', 'A3', 'F3'], ['D3p', 'A0', 'B3', 'F3']]);
    expect(D.rule.prefix).toEqual(['D1', 'D2', 'D3']);
    expect(D.rule.standalone).toEqual(['D3p']);
    expect(D.rule.recommendations.D3).toBe(F3);
    expect(F3).toBe('flip search.query_facts_block on');
  });

  test('every comparison passing recommends the three flips in order, F3 named once', () => {
    const r = run();
    expect(verdicts(r)).toEqual({ D1: 'pass', D2: 'pass', D3: 'pass', D3p: 'pass' });
    expect(r.recommended_prefix).toEqual(['D1', 'D2', 'D3']);
    expect(r.recommended_standalone).toEqual(['D3p']);
    expect(r.recommendations).toEqual(['D1', 'D2', 'D3'].map(id => D.rule.recommendations[id]));
    expect(r.outcome).toMatch(/^recommend: flip search.query_budget_unit/);
  });

  test('Holm across all four McNemar p values: 0.01, 0.02, 0.03, 0.04 adjust to 0.04, 0.06, 0.06, 0.06', () => {
    const r = run({ comparisons: { D1: cmp('D1', 0.08, 0.03, 0.13, 0.01), D2: cmp('D2', 0.08, 0.03, 0.13, 0.02), D3: cmp('D3', 0.08, 0.03, 0.13, 0.03), D3p: cmp('D3p', 0.08, 0.03, 0.13, 0.04) } });
    expect(r.p_holm.D1).toBeCloseTo(0.04, 12);
    for (const id of ['D2', 'D3', 'D3p']) expect(r.p_holm[id]).toBeCloseTo(0.06, 12);
    expect(verdicts(r)).toEqual({ D1: 'pass', D2: 'inconclusive', D3: 'inconclusive', D3p: 'inconclusive' });
    expect(r.comparisons[1].reasons[0]).toMatch(/Holm-adjusted McNemar p < alpha/);
    expect(r.recommendations).toEqual([D.rule.recommendations.D1]);
  });

  test('Holm counts D3p: at 0.012 it takes the x4 rank (0.048), and D1 at 0.0125 (x3, 0.0375) rises to it by monotonicity', () => {
    const r = run({ comparisons: { D1: cmp('D1', 0.08, 0.03, 0.13, 0.0125), D2: cmp('D2', 0.08, 0.03, 0.13, 0.5), D3: cmp('D3', 0.08, 0.03, 0.13, 0.5), D3p: cmp('D3p', 0.08, 0.03, 0.13, 0.012) } });
    expect(r.p_holm.D3p).toBeCloseTo(0.048, 12);
    expect(r.p_holm.D1).toBeCloseTo(0.048, 12);
    expect(verdicts(r)).toMatchObject({ D1: 'pass', D3p: 'pass' });
  });

  test('a blocked or missing comparison counts as p = 1 in Holm and is inconclusive', () => {
    const r = run({ comparisons: { ...strong, D3: { id: 'answer_accuracy', status: 'blocked', reasons: ['missing rows'] } as never, D3p: undefined } });
    expect(r.p_holm.D1).toBeCloseTo(0.004, 12);
    expect(r.p_holm.D3).toBe(1);
    expect(verdicts(r)).toMatchObject({ D3: 'inconclusive', D3p: 'inconclusive' });
    expect(r.comparisons[2].reasons[0]).toMatch(/blocked: missing rows/);
    expect(r.comparisons[3].reasons[0]).toMatch(/missing/);
    expect(r.recommendations).toEqual([D.rule.recommendations.D1, D.rule.recommendations.D2]);
  });

  test('superiority needs delta > 0 and the interval above zero; an interval wholly below zero fails', () => {
    expect(verdicts(run({ comparisons: { ...strong, D2: cmp('D2', 0.03, -0.01, 0.07, 0.001) } })).D2).toBe('inconclusive');
    expect(verdicts(run({ comparisons: { ...strong, D2: worse('D2') } })).D2).toBe('fail');
  });

  test('guard 7: a clear loss in a kind fails that comparison only (exact one-sided McNemar, p < 0.05), D3p included', () => {
    const small = run({ steps: { ...allWins, A2: { wins: { 'temporal-reasoning': 9 }, losses: { 'multi-session': 4 } } } });
    expect(small.comparisons[1].guard7.kinds['multi-session']).toMatchObject({ wins: 0, losses: 4, pass: true });
    expect(verdicts(small).D2).toBe('pass');
    const clear = run({ steps: { ...allWins, A2: { wins: { 'temporal-reasoning': 9 }, losses: { 'multi-session': 5 } } } });
    expect(clear.comparisons[1].guard7.kinds['multi-session']).toMatchObject({ wins: 0, losses: 5, pass: false });
    expect(clear.comparisons[1].guard7.kinds['multi-session'].p_loss_one_sided).toBeCloseTo(1 / 32, 12);
    expect(verdicts(clear)).toEqual({ D1: 'pass', D2: 'fail', D3: 'pass', D3p: 'pass' });
    expect(clear.comparisons[1].reasons[0]).toMatch(/guard 7: a clear loss in multi-session \(0 wins, 5 losses/);
    const b3 = run({ steps: { ...allWins, B3: { wins: { 'temporal-reasoning': 9 }, losses: { 'knowledge-update': 5 } } } });
    expect(b3.comparisons[3].guard7.kinds['knowledge-update']).toMatchObject({ wins: 0, losses: 5, pass: false });
    expect(verdicts(b3)).toEqual({ D1: 'pass', D2: 'pass', D3: 'pass', D3p: 'fail' });
  });

  test('guard 8: abstention may not fall at all, D3p included', () => {
    const r = run({ steps: { ...allWins, A1: { wins: { 'temporal-reasoning': 9 }, losses: { abstention: 1 } } } });
    expect(r.comparisons[0].guard7.kinds.abstention).toMatchObject({ losses: 1, pass: true });
    expect(r.comparisons[0].guard8).toMatchObject({ pass: false, earlier: 20, later: 19 });
    expect(verdicts(r).D1).toBe('fail');
    expect(r.recommended_prefix).toEqual([]);
    const b3 = run({ steps: { ...allWins, B3: { wins: { 'temporal-reasoning': 9 }, losses: { abstention: 1 } } } });
    expect(b3.comparisons[3].guard8).toMatchObject({ pass: false, earlier: 20, later: 19 });
    expect(verdicts(b3).D3p).toBe('fail');
    expect(b3.recommended_standalone).toEqual([]);
  });

  test('F1 is recommended only when A1 is non-inferior to R5 (lower bound above -5 points), else "pass, not recommended"', () => {
    const at = (lo: number | null) => run({ r5: lo === null ? undefined : cmp('F1', 0, lo, 0.04, 0.5) });
    expect(at(-0.049).comparisons[0]).toMatchObject({ verdict: 'pass', label: 'pass', recommended: true });
    const miss = at(-0.05);
    expect(miss.comparisons[0]).toMatchObject({ verdict: 'pass', label: 'pass, not recommended', recommended: false });
    expect(miss.comparisons[0].noninferiority).toMatchObject({ reference: 'R5', candidate: 'A1', pass: false });
    expect(miss.comparisons[0].reasons.join(' ')).toMatch(/pass, not recommended: .* lower bound -0.0500, not above -0.05/);
    expect(miss.recommended_prefix).toEqual([]);
    expect(miss.reported_without_recommendation).toEqual(['D2', 'D3']);
    expect(miss.recommendations).toEqual([F3]);
    expect(at(null).comparisons[0].label).toBe('pass, not recommended');
  });

  test('D1 to D3 recommend only as the contiguous prefix from D1; D3p recommends F3 outside it', () => {
    const r = run({ comparisons: { ...strong, D2: cmp('D2', 0.01, -0.03, 0.05, 0.5) } });
    expect(verdicts(r)).toEqual({ D1: 'pass', D2: 'inconclusive', D3: 'pass', D3p: 'pass' });
    expect(r.recommended_prefix).toEqual(['D1']);
    expect(r.recommended_standalone).toEqual(['D3p']);
    expect(r.recommendations).toEqual([D.rule.recommendations.D1, F3]);
    expect(r.reported_without_recommendation).toEqual(['D3']);
  });

  test('D3p passing while D1 fails recommends F3 alone', () => {
    const r = run({ comparisons: { ...strong, D1: worse('D1') } });
    expect(verdicts(r)).toEqual({ D1: 'fail', D2: 'pass', D3: 'pass', D3p: 'pass' });
    expect(r.recommended_prefix).toEqual([]);
    expect(r.recommended_standalone).toEqual(['D3p']);
    expect(r.reported_without_recommendation).toEqual(['D2', 'D3']);
    expect(r.recommendations).toEqual([F3]);
    expect(r.outcome).toBe(`recommend: ${F3}`);
  });

  test('D3p failing while D3 passes: F3 comes only through the prefix, as the flag stacked on F1 and F2', () => {
    const stacked = run({ comparisons: { ...strong, D3p: worse('D3p') } });
    expect(verdicts(stacked)).toEqual({ D1: 'pass', D2: 'pass', D3: 'pass', D3p: 'fail' });
    expect(stacked.recommended_standalone).toEqual([]);
    expect(stacked.recommendations).toEqual(['D1', 'D2', 'D3'].map(id => D.rule.recommendations[id]));
    const broken = run({ comparisons: { ...strong, D2: cmp('D2', 0.01, -0.03, 0.05, 0.5), D3p: worse('D3p') } });
    expect(verdicts(broken)).toEqual({ D1: 'pass', D2: 'inconclusive', D3: 'pass', D3p: 'fail' });
    expect(broken.recommendations).toEqual([D.rule.recommendations.D1]);
    expect(broken.reported_without_recommendation).toEqual(['D3']);
  });

  test('a failed gate fails everything; more than 3 reader errors in either arm is inconclusive', () => {
    const g = run({ gatePass: false, gateReasons: ['A1: 2 tool results are errors'] });
    expect(verdicts(g)).toEqual({ D1: 'fail', D2: 'fail', D3: 'fail', D3p: 'fail' });
    expect(g.comparisons[0].reasons[0]).toMatch(/a gate failed: A1: 2 tool results are errors/);
    expect(g.recommendations).toEqual([]);
    expect(verdicts(run({ readerErrors: { A2: 3 } }))).toEqual({ D1: 'pass', D2: 'pass', D3: 'pass', D3p: 'pass' });
    expect(verdicts(run({ readerErrors: { A2: 4 } }))).toEqual({ D1: 'pass', D2: 'inconclusive', D3: 'inconclusive', D3p: 'pass' });
    expect(verdicts(run({ readerErrors: { A0: 4 } }))).toEqual({ D1: 'inconclusive', D2: 'pass', D3: 'pass', D3p: 'inconclusive' });
  });
});

describe('the product-text renderer', () => {
  const q = { question: 'What did the user plan?', question_date: '2026/01/01 (Thu) 10:00' };
  const rows = (n: number, chars: number) => Array.from({ length: n }, (_, i) => ({ slug: `chat/c-${i}`, chunk_text: 'x'.repeat(chars), score: 1 - i / 100 }));
  test('the tool result text appears byte for byte, blocks joined by one blank line, nothing added', () => {
    const blocks = [JSON.stringify(rows(3, 50), null, 2), '[gbrain notice] something'];
    const r = renderContext(blocks, q);
    expect(r.prompt).toContain(blocks.join('\n\n'));
    expect(r.rows_cut).toBe(0);
    expect(r.prompt.replace(blocks.join('\n\n'), '')).not.toMatch(/observed|chat\/c-/);
    expect(renderContext(blocks, q).prompt_sha256).toBe(r.prompt_sha256);
  });
  test('over the reader budget, whole rows are cut from the end of the first block (gbrain\'s compact JSON) and counted', () => {
    const blocks = [JSON.stringify(rows(40, 2000))];
    const r = renderContext(blocks, q);
    expect(r.rows_total).toBe(40);
    expect(r.rows_cut).toBeGreaterThan(0);
    expect(r.rows_kept).toBe(40 - r.rows_cut);
    expect(r.tokens).toBeLessThanOrEqual(HARNESS_BUDGET_TOKENS);
    expect(r.slugs).toEqual(rows(r.rows_kept!, 1).map(x => x.slug));
  });
});

describe('keyless helpers', () => {
  test('stub facts: first-person sentences of the turn, at most four, as event facts', () => {
    const f = stubFacts('I moved to Lisbon in May. The weather is fine. Later I adopted a cat named Pip! I sold the bike. I sang. I ran.');
    expect(f.map(x => x.fact)).toEqual(['The user moved to Lisbon in May.', 'Later the user adopted a cat named Pip!', 'The user sold the bike.', 'The user sang.']);
    expect(f.every(x => x.kind === 'event')).toBe(true);
    expect(stubFacts('Nothing personal here.')).toEqual([]);
  });
  test('the determinism questions are a seeded, order-free choice', () => {
    const qs = Array.from({ length: 50 }, (_, i) => ({ id: `q-${i}` }));
    const a = determinismQuestions(qs, 20, 20261026);
    expect(a).toHaveLength(20);
    expect(determinismQuestions([...qs].reverse(), 20, 20261026)).toEqual(a);
    expect(determinismQuestions(qs, 20, 1)).not.toEqual(a);
  });
});

describe('the freeze retrieval cache (spec change 6)', () => {
  const URL_ = 'http://127.0.0.1:4001/cell/voyage/v1/rerank';
  const body = (query: string, model = 'rerank-2.5') => JSON.stringify({ query, documents: ['a', 'b'], model, top_k: 2 });
  /** A provider whose scores drift on every call, as the real reranker's floats do. */
  const noisy = () => { let n = 0; const calls: string[] = []; return { calls, fn: async (u: string, init: RequestInit) => { calls.push(String(init.body)); n++; return new Response(JSON.stringify({ data: [{ index: 0, relevance_score: 0.5 + n / 1e4 }] }), { status: 200, headers: { 'content-type': 'application/json' } }); } }; };
  test('the key is provider, endpoint, model and the full body; the proxy port is not part of it', () => {
    const k = rerankKey(URL_, body('q'));
    expect(k).toMatchObject({ provider: 'voyage', endpoint: '/cell/voyage/v1/rerank', model: 'rerank-2.5' });
    expect(rerankKey('http://127.0.0.1:5999/cell/voyage/v1/rerank', body('q')).key).toBe(k.key);
    for (const other of [rerankKey(URL_, body('q2')).key, rerankKey(URL_, body('q', 'rerank-2.5-lite')).key, rerankKey('http://127.0.0.1:4001/cell/voyage/v1/other', body('q')).key]) expect(other).not.toBe(k.key);
  });
  test('an identical request returns the first response\'s bytes; a different body calls the provider', async () => {
    const db = new Database(':memory:');
    const p = noisy(), counts = { hits: 0, misses: 0, bypassed: 0, uncached_errors: 0 };
    const t = cachingRerankTransport(db, p.fn, counts);
    const first = await (await t(URL_, { method: 'POST', body: body('q') })).text();
    const again = await (await t(URL_, { method: 'POST', body: body('q') })).text();
    const other = await (await t(URL_, { method: 'POST', body: body('q2') })).text();
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(p.calls).toHaveLength(2);
    expect(counts).toEqual({ hits: 1, misses: 2, bypassed: 0, uncached_errors: 0 });
  });
  test('a failed response is passed through and never stored', async () => {
    const db = new Database(':memory:');
    let n = 0;
    const counts = { hits: 0, misses: 0, bypassed: 0, uncached_errors: 0 };
    const t = cachingRerankTransport(db, async () => (++n === 1 ? new Response('busy', { status: 429 }) : new Response('{"data":[]}', { status: 200 })), counts);
    expect((await t(URL_, { method: 'POST', body: body('q') })).status).toBe(429);
    expect((await t(URL_, { method: 'POST', body: body('q') })).status).toBe(200);
    expect(n).toBe(2);
    expect(counts.uncached_errors).toBe(1);
  });
  test('install wires both seams, close uninstalls them, and the receipt sums every process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c8k-retrieval-cache-'));
    try {
      let rerankSeam: unknown = 'unset', embedReal: unknown = 'unset', uninstalled = 0;
      class FakeEmbeddingCache { constructor(readonly path: string) {} open() {} close() {} stats() { return { hits: 5, misses: 2, bypassed: 0, infra_faults: 0 }; } canonicalSha256() { return 'e'.repeat(64); } }
      const m: RetrievalCacheModules = { EmbeddingCache: FakeEmbeddingCache, installEmbedCache: (_c, o) => { embedReal = o.realTransport; return { model: 'openai:text-embedding-3-large', dims: 1536, uninstall: () => { uninstalled++; } }; }, setRerankTransport: fn => { rerankSeam = fn; } };
      const hash = async () => ({});
      const p = noisy();
      for (let run = 0; run < 2; run++) {
        const c = installRetrievalCache(m, dir, { embedTransport: hash, fetchImpl: p.fn });
        expect(embedReal).toBe(hash);
        expect(typeof rerankSeam).toBe('function');
        await (rerankSeam as (u: string, i: RequestInit) => Promise<Response>)(URL_, { method: 'POST', body: body('q') });
        c.close();
        expect(rerankSeam).toBeNull();
      }
      expect(uninstalled).toBe(2);
      expect(p.calls).toHaveLength(1);
      const r = retrievalCacheReceipt(m, dir);
      expect(r).toMatchObject({ spec_change: 6, processes: 2, embed: { hits: 10, misses: 4, models: ['openai:text-embedding-3-large@1536'] }, rerank: { hits: 1, misses: 1, rows: 1 } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

