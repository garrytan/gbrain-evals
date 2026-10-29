/**
 * The 8k conversion (preregistration docs/benchmarks/2026-10-26-gbrain-8k-conversion-preregistration.md), keyless:
 * the committed decision directory agrees with itself and the harness; the preregistered rule (decideC8k) in every
 * branch; the product-text renderer adds nothing and cuts whole rows; the stub facts and the determinism questions.
 * The whole chain runs in c8k-dry-run.sh (receipts committed).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';
import { assertFilled, budgetSummary, buildCorpus, decideC8k, determinismQuestions, loadDecision, readEvidence, retrievalChecks, runDecide, runExport, runExtract, runFreeze, runGate, runRead, writeAnswers, type C8kDecision } from '../../eval/runner/budgeted-delivery/c8k.ts';
import { BRAIN_SETTINGS, C8K_ARMS, C8K_KEYS, FACTS_BLOCK_MAX_ROWS, HARNESS_BUDGET_TOKENS, QUERY_BUDGET, READER_TEMPLATE_SHA256, RECIPE_HASH, RENDERER_VERSION, brainName, productHistory, renderContext, type EvidenceRow, type ProductModules } from '../../eval/runner/budgeted-delivery/c8k-product.ts';
import type { Corpus } from '../../eval/runner/memory-qa/corpus.ts';
import { sha256File } from '../../eval/runner/sealed-confirmation-lib.ts';
import { slugOf } from '../../eval/runner/systems/gbrain.ts';
import { opaqueSourceId } from '../../eval/runner/systems/sanitize.ts';
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
  // Value: protects=a cut never changes the bytes of the rows it keeps, and a first block that is not a JSON array passes through whole; fails_when=productHistory cuts a block that gbrain did not write compactly, or cuts a non-array block; why_new=the round-trip guard had no negative-path test; seam=none; no_claim=does not show gbrain writes compact JSON
  test('a pretty-printed first block over budget is refused instead of cut; a block that is not a JSON array is passed through uncut', () => {
    const pretty = [JSON.stringify(rows(5, 400), null, 2)];
    expect(() => productHistory(pretty, 100)).toThrow(/round-trip/);
    expect(productHistory(pretty, 1 << 20)).toMatchObject({ kept: 5, cut: 0, text: pretty[0] });
    expect(productHistory(['not json', 'second'], 1)).toEqual({ text: 'not json\n\nsecond', rows: null, kept: 0, cut: 0 });
    expect(productHistory([JSON.stringify({ rows: [] })], 1).rows).toBeNull();
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


// ─── custody steps on invented fixtures (no keys, no network) ─────

const fixtureCorpus = (): Corpus => ({
  benchmark: 'custody', source: { name: 'fixture' } as never,
  conversations: ['conv-a', 'conv-b'].map(c => ({ id: c, sessions: ['s1', 's2'].map(s => ({ id: s, date: '2026/01/01', turns: [{ speaker: 'user', content: `${c} ${s}` }] })) })) as never,
  questions: [['q-a1', 'conv-a'], ['q-a2', 'conv-a'], ['q-b1', 'conv-b'], ['q-b2', 'conv-b']].map(([id, c]) => ({ id, conversation: c, question: `What about ${id}?`, question_date: '2026/02/01 (Sun) 10:00', category: 'multi-session', gold: [], abstention: false })),
});
const chatSlug = (conv: string, session: string) => slugOf(opaqueSourceId(conv, session));
/** One clean result per arm and question: a row of the question's own history, capped arms reporting cap_only within budget, and an A0 repeat for every question. */
const cleanEvidence = (corpus: Corpus) => {
  const evidence = C8K_ARMS.flatMap(arm => corpus.questions.map(q => ({ kind: 'evidence', question_id: q.id, haystack_id: q.conversation, arm: arm.id, request: {}, keys: {},
    blocks: [JSON.stringify([{ slug: chatSlug(q.conversation, 's1'), chunk_text: 'x' }])], is_error: false, text_sha256: `t-${q.id}`,
    delivery: 'search.query_budget_unit' in arm.keys ? { budget_used: 100, auto_packing: 'cap_only' } : null, degraded: null, notices: [] as string[], service_ms: 1 }) as EvidenceRow & { kind: string }));
  const repeats = corpus.questions.map(q => ({ kind: 'repeat', question_id: q.id, arm: 'A0', text_sha256: `t-${q.id}` }));
  return { evidence, repeats, sha256: 'fixture' };
};

describe('retrievalChecks (decision rule step 1) on hand-built evidence', () => {
  // Value: protects=each retrieval gate problem class is flagged alone and a clean freeze passes; fails_when=any one check in retrievalChecks is dropped or loosened; why_new=no test exercised retrievalChecks; seam=none; no_claim=does not test the live gbrain query path
  test('a clean freeze passes; each problem class is flagged alone', () => {
    const corpus = fixtureCorpus();
    const clean = retrievalChecks(D, corpus, cleanEvidence(corpus), () => 1);
    expect(clean.problems).toEqual([]);
    expect(clean.determinism).toEqual({ questions: 4, repeated: 4, byte_identical: 4, pass: true });
    const row = (ev: ReturnType<typeof cleanEvidence>, arm: string, q = 'q-a1') => ev.evidence.find(r => r.arm === arm && r.question_id === q)!;
    const cases: Array<[string, (ev: ReturnType<typeof cleanEvidence>) => void, RegExp]> = [
      ['coverage', ev => { ev.evidence.splice(ev.evidence.indexOf(row(ev, 'A2')), 1); }, /^A2: 3 results for 3 of 4 questions$/],
      ['tool errors', ev => { row(ev, 'A1').is_error = true; }, /^A1: 1 tool results are errors$/],
      ['row outside history', ev => { row(ev, 'A0').blocks = [JSON.stringify([{ slug: chatSlug('conv-b', 's2'), chunk_text: 'x' }])]; }, /^A0: 1 rows name a page outside the question's history$/],
      ['behavior_changes disclosure', ev => { row(ev, 'B3').notices = ['behavior_changes']; }, /^B3: 1 results carry the once-per-brain behavior_changes disclosure/],
      ['safe_index_pending', ev => { row(ev, 'R5').degraded = [{ stage: 'safe_index_pending' }]; }, /^R5: 1 results report safe_index_pending/],
      ['over budget', ev => { row(ev, 'A1').delivery = { budget_used: QUERY_BUDGET + 1, auto_packing: 'cap_only' }; }, new RegExp(`^A1: 1 results do not report budget_used at most ${QUERY_BUDGET}$`)],
      ['not cap_only', ev => { row(ev, 'A2').delivery = { budget_used: 100, auto_packing: 'off' }; }, /^A2: 1 results do not report auto_packing cap_only$/],
      ['oversize facts block', ev => { row(ev, 'A3').blocks = [JSON.stringify(Array.from({ length: FACTS_BLOCK_MAX_ROWS + 1 }, (_, i) => ({ result_type: 'fact', slug: `facts/f-${i}`, fact: 'f' })))]; }, /^A3: 1 results carry facts over \d+ tokens or 40 rows$/],
      ['determinism mismatch', ev => { ev.repeats[0].text_sha256 = 'drifted'; }, /^determinism: 3 of 4 A0 results byte-identical on repeat$/],
      ['arm outside the table', ev => { ev.evidence.push({ ...row(ev, 'A0'), arm: 'C9' }); }, /^C9: 1 results of an arm outside the arm table$/],
    ];
    for (const [name, mutate, want] of cases) {
      const ev = cleanEvidence(corpus);
      mutate(ev);
      const { problems } = retrievalChecks(D, corpus, ev, () => 1);
      expect(problems.length === 1 && want.test(problems[0]) ? name : `${name}: ${JSON.stringify(problems)}`).toBe(name);
    }
  });
});

/** Writes the clean evidence as one ndjson per history, as the freeze does. */
const writeEvidence = (dir: string, ev: ReturnType<typeof cleanEvidence>) => {
  mkdirSync(dir, { recursive: true });
  for (const conv of ['conv-a', 'conv-b']) {
    const mine = [...ev.evidence.filter(r => r.haystack_id === conv), ...ev.repeats.filter(r => r.question_id.startsWith(`q-${conv.slice(-1)}`))];
    writeFileSync(join(dir, `${brainName(conv)}.ndjson`), mine.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
};
const primaryArms = () => D.answer_arms.filter(a => a.role === 'primary');

describe('runGate final phase on temp-dir fixtures', () => {
  // Value: protects=final gate refuses reader prompts that no longer re-render and refuses to run after a label read; fails_when=prompt_sha or recipe_hash compare or score-line check is removed; why_new=runGate final had no test; seam=none; no_claim=does not cover the retrieval phase receipt shape
  test('passes when every reader prompt re-renders; fails on a changed prompt or recipe hash; throws once a score line exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'c8k-gate-'));
    try {
      const corpus = fixtureCorpus();
      const ev = cleanEvidence(corpus);
      writeEvidence(join(root, 'evidence'), ev);
      const readers = join(root, 'readers');
      const writeReaders = (tamper?: (r: Row, arm: string) => void) => {
        for (const a of primaryArms()) {
          mkdirSync(join(readers, a.reader), { recursive: true });
          const rows = corpus.questions.map(q => {
            const e = ev.evidence.find(r => r.arm === a.arm && r.question_id === q.id)!;
            const r: Row = { question_id: q.id, prompt_sha256: renderContext(e.blocks, q, D.construction.harness_budget_tokens).prompt_sha256, recipe_hash: RECIPE_HASH };
            tamper?.(r, a.arm);
            return r;
          });
          writeFileSync(join(readers, a.reader, `${a.arm}.ndjson`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        }
      };
      const log = join(root, 'access.ndjson');
      const gate = () => runGate({ decision: D, decisionSha: 'd'.repeat(64), corpus, evidence: join(root, 'evidence'), readers, phase: 'final', log, tokens: () => 1, gbrain: {}, roles: ['primary'] });
      writeReaders();
      const ok = gate();
      expect(ok.problems).toEqual([]);
      expect(ok.pass).toBe(true);
      expect(ok.render_identity).toEqual({ rerender_mismatches: 0 });
      writeReaders((r, arm) => { if (arm === 'A2' && r.question_id === 'q-b1') r.prompt_sha256 = '0'.repeat(64); });
      const prompt = gate();
      expect(prompt.pass).toBe(false);
      expect(prompt.problems).toEqual(['sonnet-5-5.A2: 1 contexts do not re-render to the bytes the reader got']);
      writeReaders((r, arm) => { if (arm === 'R5') r.recipe_hash = 'older-recipe'; });
      const recipe = gate();
      expect(recipe.problems).toEqual(['sonnet-5-5.R5: 4 contexts do not re-render to the bytes the reader got']);
      expect(recipe.render_identity).toEqual({ rerender_mismatches: 4 });
      writeFileSync(log, JSON.stringify({ action: 'open', decision_id: D.decision_id }) + '\n' + JSON.stringify({ action: 'score', decision_id: D.decision_id }) + '\n');
      expect(gate).toThrow(/labels were already read under this decision/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runFreeze amendment resume (spec change 7) with stub product modules', () => {
  // Value: protects=a history frozen before the arm-table amendment gets only its missing arms and keeps its repeat; fails_when=freeze requeries frozen arms, drops repeats, keeps retired rows or leaves .tmp; why_new=runFreeze resume was untested; seam=none; no_claim=does not prove the real PGLite engine or dispatch behave like the stub
  test('only the missing arm is queried, retired rows move to retired/, the frozen repeat is kept, nothing is left as .tmp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'c8k-freeze-'));
    try {
      const corpus = fixtureCorpus();
      corpus.conversations = corpus.conversations.filter(c => c.id === 'conv-a');
      corpus.questions = corpus.questions.filter(q => q.conversation === 'conv-a');
      const evidence = join(root, 'runs', 'evidence');
      mkdirSync(evidence, { recursive: true });
      const name = brainName('conv-a');
      const frozen = (arm: string, q: string) => ({ kind: 'evidence', question_id: q, haystack_id: 'conv-a', arm, blocks: ['[]'], is_error: false, text_sha256: `old-${arm}-${q}`, notices: [], service_ms: 1 });
      const prior = [...['A0', 'A1', 'A2', 'A3', 'C9', 'R5'].flatMap(a => ['q-a1', 'q-a2'].map(q => frozen(a, q))), { kind: 'repeat', question_id: 'q-a1', arm: 'A0', text_sha256: 'old-A0-q-a1', is_error: false, blocks: ['[]'] }];
      writeFileSync(join(evidence, `${name}.ndjson`), prior.map(r => JSON.stringify(r)).join('\n') + '\n');
      const calls: Array<{ query: unknown; keys: Record<string, string> }> = [];
      class StubEngine {
        cfg = new Map<string, string>();
        async connect() {} async initSchema() {} async disconnect() {}
        async setConfig(k: string, v: string) { this.cfg.set(k, v); }
        async getConfig(k: string) { return this.cfg.get(k); }
        async executeRaw(_sql: string, params: [string[]]) { for (const k of params[0]) this.cfg.delete(k); return []; }
      }
      const m = { PGLiteEngine: StubEngine, stdioFrameBytes: 1 << 20, NoticeLedger: class {},
        dispatchToolCall: async (e: StubEngine, _n: string, p: Record<string, unknown>) => { calls.push({ query: p.query, keys: Object.fromEntries(e.cfg) }); return { content: [{ type: 'text', text: '[]' }], _meta: {} }; } } as unknown as ProductModules;
      class FakeEmbeddingCache { constructor(readonly path: string) {} open() {} close() {} stats() { return { hits: 0, misses: 0, bypassed: 0, infra_faults: 0 }; } canonicalSha256() { return 'e'.repeat(64); } }
      const cache = { modules: { EmbeddingCache: FakeEmbeddingCache, installEmbedCache: () => ({ model: 'hash', dims: 1536, uninstall() {} }), setRerankTransport() {} } as unknown as RetrievalCacheModules };
      const freeze = () => runFreeze({ custodyRoot: root, decision: D, corpus, brains: join(root, 'brains'), evidence, m, identity: {}, cache });
      const out = await freeze();
      expect(calls.map(c => c.query)).toEqual(['warm-up', 'What about q-a1?', 'What about q-a2?']);
      expect(calls.slice(1).map(c => c.keys)).toEqual([{ 'search.query_facts_block': 'true' }, { 'search.query_facts_block': 'true' }]);
      const rows = readFileSync(join(evidence, `${name}.ndjson`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(rows.filter(r => r.arm === 'C9')).toEqual([]);
      expect(rows.filter(r => r.kind === 'repeat')).toEqual([prior.at(-1)]);
      expect(rows.filter(r => r.arm === 'B3').map(r => r.question_id)).toEqual(['q-a1', 'q-a2']);
      expect(rows.filter(r => ['A0', 'A1', 'A2', 'A3', 'R5'].includes(r.arm) && r.kind === 'evidence')).toEqual(prior.filter(r => r.kind === 'evidence' && r.arm !== 'C9'));
      expect(readFileSync(join(evidence, 'retired', `${name}.ndjson`), 'utf8').trim().split('\n').map(l => JSON.parse(l))).toEqual(prior.filter(r => r.arm === 'C9'));
      expect(out.amended).toEqual({ histories: 1, arms_added: { B3: 1 }, rows_retired: { C9: 2 } });
      expect(readdirSync(evidence).filter(f => f.endsWith('.tmp'))).toEqual([]);
      const settled = readFileSync(join(evidence, `${name}.ndjson`), 'utf8');
      await freeze();
      expect(calls).toHaveLength(3);
      expect(readFileSync(join(evidence, `${name}.ndjson`), 'utf8')).toBe(settled);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runDecide custody refusals', () => {
  // Value: protects=decide fails every comparison on a stale score sha, an early label read or a foreign decision sha; fails_when=any runDecide custody check is removed or stops failing the gate; why_new=runDecide refusals untested; seam=none; no_claim=does not check comparison statistics
  test('stale score report, label read before the final gate and a foreign decision sha each land in problems and fail the gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'c8k-decide-'));
    try {
      const sha = 'a'.repeat(64);
      const dirs = { scoresDir: join(root, 'scores'), compareDir: join(root, 'compare'), answersDir: join(root, 'answers') };
      for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
      const id = (arm: string) => primaryArms().find(a => a.arm === arm)!.id;
      const setup = () => {
        for (const a of primaryArms()) {
          writeFileSync(join(dirs.scoresDir, `${a.id}.json`), JSON.stringify({ per_question: [{ question_id: 'q-1', question_type: 'multi-session', answer_correct: a.arm !== 'A0' }] }));
          writeFileSync(join(dirs.answersDir, `${a.id}.jsonl`), JSON.stringify({ record_type: 'meta', decision_sha256: sha }) + '\n' + JSON.stringify({ question_id: 'q-1', hypothesis: 'x' }) + '\n');
        }
        const inputs = (a: string, b: string) => ({ inputs: [a, b].map(x => ({ sha256: sha256File(join(dirs.scoresDir, `${id(x)}.json`)) })) });
        for (const c of D.rule.comparisons) writeFileSync(join(dirs.compareDir, `${c.id}.json`), JSON.stringify(inputs(c.a, c.b)));
        writeFileSync(join(dirs.compareDir, 'F1-noninferiority.json'), JSON.stringify(inputs(D.rule.f1_noninferiority.reference, D.rule.f1_noninferiority.candidate)));
        writeFileSync(join(root, 'log.ndjson'), [{ action: 'open', decision_id: D.decision_id }, { action: 'gate', decision_id: D.decision_id }].map(e => JSON.stringify(e)).join('\n') + '\n');
      };
      const decide = () => runDecide({ decision: D, decisionSha: sha, gate: { decision_sha256: sha, phase: 'final', pass: true, problems: [], access_log_lines_at_gate: 2 }, ...dirs, log: join(root, 'log.ndjson') });
      setup();
      const clean = decide();
      expect(clean.problems).toEqual([]);
      expect(clean.comparisons.map(c => c.verdict)).toEqual(['inconclusive', 'inconclusive', 'inconclusive', 'inconclusive']);
      const refusals: Array<[string, () => void, string]> = [
        ['stale score report', () => writeFileSync(join(dirs.scoresDir, `${id('A2')}.json`), JSON.stringify({ per_question: [] })), 'D2.json was not computed from the A1 and A2 score reports (in that order)'],
        ['label read before the gate', () => writeFileSync(join(root, 'log.ndjson'), [{ action: 'score', decision_id: D.decision_id }, { action: 'gate', decision_id: D.decision_id }].map(e => JSON.stringify(e)).join('\n') + '\n'), 'a label read under this decision precedes the final gate'],
        ['foreign decision sha', () => writeFileSync(join(dirs.answersDir, `${id('B3')}.jsonl`), JSON.stringify({ record_type: 'meta', decision_sha256: 'b'.repeat(64) }) + '\n'), `${id('B3')}.jsonl was written under another decision file`],
      ];
      for (const [, mutate, problem] of refusals) {
        setup();
        mutate();
        const r = decide();
        expect(r.problems).toContain(problem);
        expect(r.comparisons.map(c => c.verdict)).toEqual(['fail', 'fail', 'fail', 'fail']);
        expect(r.comparisons[0].reasons[0]).toContain(problem);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('writeAnswers and budgetSummary', () => {
  // Value: protects=answers keep only the question's own sessions, never turn a reader error into a hypothesis, and spend counts settled plus abandoned; fails_when=retrieved filter, reader_error branch or lease spend rule changes; why_new=c8k writeAnswers/budgetSummary untested; seam=none; no_claim=does not cover the development budget scope
  test('retrieved stays inside the question\'s conversation; a reader error is never a hypothesis; spend is settled actuals plus abandoned reservations', () => {
    const root = mkdtempSync(join(tmpdir(), 'c8k-answers-'));
    try {
      const corpus = fixtureCorpus();
      const readers = join(root, 'readers');
      for (const a of primaryArms()) {
        mkdirSync(join(readers, a.reader), { recursive: true });
        const rows: Row[] = corpus.questions.map(q => ({ question_id: q.id, slugs: [chatSlug(q.conversation, 's1')], answer: 'ok', prompt_sha256: 'p', context_tokens: 10, rows_cut: 0, input_tokens: 5, output_tokens: 1 }));
        if (a.arm === 'A1') {
          rows[0].slugs = [chatSlug('conv-a', 's2'), chatSlug('conv-b', 's1'), 'extracts/receipt-1', chatSlug('conv-a', 's2')];
          rows[1] = { ...rows[1], answer: 'stale text', reader_error: 'HTTP 529' };
          rows[2] = { ...rows[2], answer: '  ' };
        }
        writeFileSync(join(readers, a.reader, `${a.arm}.ndjson`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      }
      const outDir = join(root, 'answers');
      const summary = writeAnswers({ custodyRoot: root, decision: D, decisionSha: 'c'.repeat(64), corpus, readers, outDir, roles: ['primary'] });
      expect(summary['sonnet-5-5.A1']).toEqual({ rows: 4, reader_errors: 1, empty: 1 });
      expect(summary['sonnet-5-5.A0']).toEqual({ rows: 4, reader_errors: 0, empty: 0 });
      const lines = readFileSync(join(outDir, 'sonnet-5-5.A1.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(lines[0]).toMatchObject({ record_type: 'meta', decision_sha256: 'c'.repeat(64), questions: 4 });
      expect(lines[1].retrieved).toEqual(['s2']);
      expect(lines[2]).toMatchObject({ question_id: 'q-a2', reader_error: 'HTTP 529' });
      expect('hypothesis' in lines[2]).toBe(false);
      expect(lines[3]).toMatchObject({ hypothesis: '  ', reader_empty: true });
      const step = D.budget.steps[0];
      const b = budgetSummary(D, { campaign_id: 'camp-1', leases: [
        { cell: `c8k-${step.id}`, usd: 5, status: 'settled', actual_usd: 1.5 },
        { cell: `c8k-${step.id}`, usd: 2, status: 'abandoned' },
        { cell: `c8k-${step.id}`, usd: 3, status: 'open' },
        { cell: 'other-cell', usd: 9, status: 'settled', actual_usd: 9 },
      ] });
      expect(b.steps[0]).toMatchObject({ id: step.id, leases: 3, reserved_usd: 10, spent_usd: 3.5, open_leases: 1 });
      expect(b.spent_usd).toBe(3.5);
      expect(b.steps.slice(1).every(s => s.leases === 0 && s.spent_usd === 0)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});



describe('readEvidence on temp-dir files', () => {
  // Value: protects=repeat rows split from evidence rows and the evidence sha covering each sorted file name and its bytes; fails_when=the kind split, ndjson filter, sort or sha input changes; why_new=readEvidence had no direct test; seam=none; no_claim=does not validate row contents
  test('repeats and evidence split by kind; the sha hashes sorted names and bytes; other files and blank lines are skipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'c8k-evidence-'));
    try {
      const dir = join(root, 'evidence');
      mkdirSync(dir, { recursive: true });
      const a = [{ kind: 'evidence', question_id: 'q-a1', arm: 'A0' }, { kind: 'repeat', question_id: 'q-a1', arm: 'A0' }].map(r => JSON.stringify(r)).join('\n\n') + '\n';
      const b = [{ kind: 'repeat', question_id: 'q-b1', arm: 'A0' }, { kind: 'evidence', question_id: 'q-b1', arm: 'A1' }].map(r => JSON.stringify(r)).join('\n') + '\n';
      writeFileSync(join(dir, 'b.ndjson'), b);
      writeFileSync(join(dir, 'a.ndjson'), a);
      writeFileSync(join(dir, 'notes.txt'), 'not json');
      const r = readEvidence(dir);
      expect(r.evidence.map(x => `${x.arm}|${x.question_id}`)).toEqual(['A0|q-a1', 'A1|q-b1']);
      expect(r.repeats.map(x => x.question_id)).toEqual(['q-a1', 'q-b1']);
      expect(r.sha256).toBe(createHash('sha256').update('a.ndjson').update(a).update('b.ndjson').update(b).digest('hex'));
      expect(readEvidence(join(root, 'absent'))).toEqual({ evidence: [], repeats: [], sha256: createHash('sha256').digest('hex') });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runRead resume against a local stub reader endpoint', () => {
  // Value: protects=a reader rerun answers only missing and reader_error rows and refuses a question with no frozen evidence; fails_when=the todo filter skips errored rows, re-asks finished ones or the missing-evidence throw is dropped; why_new=runRead was untested; seam=none; no_claim=does not exercise real provider APIs, retries or backoff
  test('finished rows are skipped, reader_error rows are retried, a question without evidence throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'c8k-read-'));
    const prompts: string[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      const body = await req.json() as { messages: Array<{ content: string }> };
      prompts.push(body.messages[0].content);
      return Response.json({ choices: [{ message: { content: 'served' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 }, model: 'stub-model' });
    } });
    const env = { base: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY };
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.OPENAI_API_KEY = 'test-key';
    try {
      const corpus = fixtureCorpus();
      const evidence = join(root, 'evidence');
      writeEvidence(evidence, cleanEvidence(corpus));
      const readers = join(root, 'readers');
      mkdirSync(join(readers, 'stub-reader'), { recursive: true });
      const prior = [{ question_id: 'q-a1', answer: 'kept' }, { question_id: 'q-a2', reader_error: 'HTTP 529' }, { question_id: 'q-b1', answer: 'kept' }];
      writeFileSync(join(readers, 'stub-reader', 'A0.ndjson'), prior.map(r => JSON.stringify(r)).join('\n') + '\n');
      const read = (reader: string) => runRead({ custodyRoot: root, decision: D, corpus, evidence, readers, reader, model: 'stub-model', arms: ['A0'], cache: join(root, 'qa'), concurrency: 1 });
      const out = await read('stub-reader');
      expect(prompts.map(p => ['q-a1', 'q-a2', 'q-b1', 'q-b2'].filter(id => p.includes(`What about ${id}?`)))).toEqual([['q-a2'], ['q-b2']]);
      const rows = readFileSync(join(readers, 'stub-reader', 'A0.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(rows.slice(3).map(r => [r.question_id, r.answer, 'reader_error' in r])).toEqual([['q-a2', 'served', false], ['q-b2', 'served', false]]);
      expect(out.arms.A0).toMatchObject({ rows: 4, reader_errors: 0 });
      rmSync(join(evidence, `${brainName('conv-b')}.ndjson`));
      await read('stub-reader');
      expect(prompts).toHaveLength(2);
      await expect(read('fresh-reader')).rejects.toThrow('no A0 evidence for a question; the freeze is incomplete');
    } finally {
      server.stop(true);
      if (env.base === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = env.base;
      if (env.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = env.key;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildCorpus on temp-dir questions', () => {
  // Value: protects=the corpus step logs the open before parsing, refuses a commitment mismatch unlogged and writes no corpus from a rejected file; fails_when=the log moves after validation, the commitment check or validation is dropped; why_new=c8k buildCorpus was untested; seam=none; no_claim=does not cover the custody-check step
  test('the open is logged with the questions sha before validation; a commitment mismatch logs nothing; a rejected file writes no corpus', () => {
    const root = mkdtempSync(join(tmpdir(), 'c8k-corpus-'));
    try {
      const qfile = (questionId: string) => JSON.stringify({ schema: 'sealed-confirmation-questions-v1', set_id: 'set-fixture', haystacks: [{ haystack_id: 'hs-0123456789', sessions: ['ss-0123456789', 'ss-0123456780'].map(s => ({ session_id: s, date: '2026/01/01', turns: [{ role: 'user', content: 'hello' }] })) }], questions: [{ question_id: questionId, haystack_id: 'hs-0123456789', question: 'What?', question_date: '2026/02/01' }] });
      const log = join(root, 'log', 'access.ndjson');
      const logLines = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
      const build = (text: string, out: string, commit = text) => {
        const questions = join(root, 'sealed', 'questions.json');
        mkdirSync(join(root, 'sealed'), { recursive: true });
        writeFileSync(questions, text);
        const manifest = join(root, 'sealed', 'manifest.json');
        writeFileSync(manifest, JSON.stringify({ set: 'set-fixture', commitments: { 'questions.json': { sha256: createHash('sha256').update(commit).digest('hex'), bytes: Buffer.byteLength(commit) } } }));
        return buildCorpus({ custodyRoot: root, decision: D, manifestPath: manifest, questions, log, out: join(root, out), purpose: 'fixture' });
      };
      const good = qfile('qq-0123456789');
      expect(build(good, 'corpus.json')).toEqual({ questions: 1, conversations: 1, sessions: 2 });
      expect(logLines()).toHaveLength(1);
      expect(logLines()[0]).toMatchObject({ action: 'open', decision_id: D.decision_id, labels_sha256: createHash('sha256').update(good).digest('hex'), run_sha256: null });
      const corpus = JSON.parse(readFileSync(join(root, 'corpus.json'), 'utf8'));
      expect([corpus.id, corpus.questions[0].conversation]).toEqual(['set-fixture-c8k', 'hs-0123456789']);
      expect(() => build(good, 'mismatch.json', good + ' ')).toThrow(/commitment mismatch for questions.json/);
      expect(logLines()).toHaveLength(1);
      const bad = qfile('Question-1');
      expect(() => build(bad, 'rejected.json')).toThrow(/questions file rejected:\nquestions\[0\]: question_id must be opaque/);
      expect(logLines()).toHaveLength(2);
      expect(logLines()[1].labels_sha256).toBe(createHash('sha256').update(bad).digest('hex'));
      expect(existsSync(join(root, 'rejected.json'))).toBe(false);
      expect(existsSync(join(root, 'mismatch.json'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runExport on temp-dir runs', () => {
  // Value: protects=export copies only the listed aggregate files, refuses an out dir inside the runs dir and writes nothing when a corpus id would leak; fails_when=the file list widens, the runs-dir check or leakScan call is removed; why_new=c8k runExport was untested; seam=none; no_claim=does not check scoreAggregate or compareAggregate shapes
  test('only aggregates leave; an export dir inside runs is refused; a corpus id in a summary refuses the whole export', () => {
    const root = mkdtempSync(join(tmpdir(), 'c8k-export-'));
    try {
      const corpus = fixtureCorpus();
      const runs = join(root, 'runs');
      const put = (p: string, v: unknown) => { mkdirSync(join(runs, p, '..'), { recursive: true }); writeFileSync(join(runs, p), typeof v === 'string' ? v : JSON.stringify(v)); };
      put('gate.json', { pass: true, problems: [] });
      put('read/sonnet.json', { rows: 4 });
      put('ledger/cells.json', { usd: 1 });
      put('notes.json', { private: true });
      put('read/sonnet.ndjson', '{"answer":"x"}\n');
      put('evidence/b-1.ndjson', '{"kind":"evidence"}\n');
      const out = join(root, 'export');
      expect(runExport({ custodyRoot: root, corpus, runs, out })).toEqual({ files: 3, out: 'export' });
      const listed = (readdirSync(out, { recursive: true }) as string[]).filter(f => f.endsWith('.json')).sort();
      expect(listed).toEqual(['gate.json', join('ledger', 'cells.json'), join('read', 'sonnet.json')]);
      expect(JSON.parse(readFileSync(join(out, 'read', 'sonnet.json'), 'utf8'))).toEqual({ rows: 4 });
      expect(() => runExport({ custodyRoot: root, corpus, runs, out: join(runs, 'export') })).toThrow('the export directory must be outside the runs directory');
      expect(existsSync(join(runs, 'export'))).toBe(false);
      put('gate.json', { pass: false, problems: ['conv-a has no evidence'] });
      const leakOut = join(root, 'export-2');
      expect(() => runExport({ custodyRoot: root, corpus, runs, out: leakOut })).toThrow(/export refused, nothing written: gate.json: an id of the corpus/);
      expect(existsSync(leakOut)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runExtract with stub product modules', () => {
  // Value: protects=extract shard k of n takes every nth history, records an extraction throw as an error row and skips finished brains on resume; fails_when=shard selection, the per-brain catch or the finished skip changes; why_new=runExtract was untested; seam=none; no_claim=does not prove gbrain's real extraction or safe-chunks repair
  test('shard 1/2 takes only the second history; shard 0/2 the first and third with a throw as an error row; a full rerun calls nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'c8k-extract-'));
    try {
      const corpus = fixtureCorpus();
      corpus.conversations = [...corpus.conversations, { ...corpus.conversations[0], id: 'conv-c' }];
      corpus.questions = [...corpus.questions, { ...corpus.questions[0], id: 'q-c1', conversation: 'conv-c' }];
      const brains = join(root, 'brains');
      for (const c of ['conv-a', 'conv-b', 'conv-c']) mkdirSync(join(brains, brainName(c)), { recursive: true });
      const calls: string[] = [];
      class StubEngine {
        path = '';
        async connect(o: { database_path: string }) { this.path = o.database_path; } async initSchema() {} async disconnect() {}
        async executeRaw(sql: string) { return sql.includes('FROM facts') ? [{ facts: 3, world: 1, sources: 2 }] : [{ n: 0 }]; }
      }
      const m = { PGLiteEngine: StubEngine,
        runRepairCommand: async () => { console.log(JSON.stringify({ results: [{ kind: 'safe-chunks', affected: 0, applied: 0, failed: [], complete: true }] })); },
        runExtractConversationFactsCore: async (e: StubEngine) => {
          calls.push(e.path);
          if (e.path.endsWith(brainName('conv-c'))) throw new Error('model refused');
          return { pages_processed: 2, pages_failed: 0, segments_processed: 2, facts_extracted: 3 };
        } } as unknown as ProductModules;
      const extract = (shard?: { k: number; n: number }) => runExtract({ custodyRoot: root, corpus, brains, m, identity: {}, shard });
      const names = (cs: string[]) => cs.map(c => join(brains, brainName(c)));
      await extract({ k: 1, n: 2 });
      expect(calls).toEqual(names(['conv-b']));
      const out = await extract({ k: 0, n: 2 });
      expect(calls).toEqual(names(['conv-b', 'conv-a', 'conv-c']));
      const rows = readFileSync(join(brains, 'extracted.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(rows.map(r => [r.brain, r.error, r.pages_processed, r.facts])).toEqual([[brainName('conv-b'), null, 2, 3], [brainName('conv-a'), null, 2, 3], [brainName('conv-c'), 'extraction threw', 0, 3]]);
      expect(out).toMatchObject({ brains: 3, extraction_errors: 1, pages_processed: 4, facts: 9 });
      await extract();
      expect(calls).toHaveLength(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

