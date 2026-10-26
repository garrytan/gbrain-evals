/**
 * The 8k conversion (preregistration docs/benchmarks/2026-10-26-gbrain-8k-conversion-preregistration.md), keyless:
 * the committed decision directory agrees with itself and the harness; the preregistered rule (decideC8k) in every
 * branch; the product-text renderer adds nothing and cuts whole rows; the stub facts and the determinism questions.
 * The whole chain runs in c8k-dry-run.sh (receipts committed).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertFilled, decideC8k, determinismQuestions, loadDecision, type C8kDecision } from '../../eval/runner/budgeted-delivery/c8k.ts';
import { BRAIN_SETTINGS, C8K_ARMS, C8K_KEYS, HARNESS_BUDGET_TOKENS, QUERY_BUDGET, READER_TEMPLATE_SHA256, RECIPE_HASH, RENDERER_VERSION, renderContext } from '../../eval/runner/budgeted-delivery/c8k-product.ts';
import { stubFacts } from '../../eval/runner/budgeted-delivery/stub-proxy.ts';
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
    expect(Object.keys(C8K_ARMS.find(a => a.id === 'A4')!.keys).sort()).toEqual([...C8K_KEYS].sort());
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

  test('measures the wave PR head; not ready for custody until the access log is filled', () => {
    expect(D.gbrain.commit).toBe('cf3ec433f4fffda60d00076bae7361100c632cc4');
    expect(JSON.parse(readFileSync(join(DIR, 'manifests/campaign.json'), 'utf8')).parameters.gbrain_sha).toBe(D.gbrain.commit);
    expect(() => assertFilled(D)).toThrow(/access_log_before/);
    expect(() => assertFilled({ ...D, gbrain: { ...D.gbrain, commit: 'fill-at-freeze' } })).toThrow(/gbrain.commit/);
    const filled = structuredClone(D) as C8kDecision;
    filled.gbrain.commit = 'a'.repeat(40);
    filled.sealed.access_log_before.entries = filled.sealed.access_log_before.entries.map(e => e.action === 'fill-at-custody' ? { action: 'score', decision_id: e.decision_id } : e);
    expect(() => assertFilled(filled)).not.toThrow();
    expect(D.sealed.access_log_before.lines).toBe(35);
  });
});

describe('the preregistered rule (decideC8k)', () => {
  const kinds = { 'multi-session': 80, 'temporal-reasoning': 40, 'knowledge-update': 40, abstention: 40 };
  /** 200 rows per arm; base is right on even indices, and each step's wins/losses flip questions of a kind from the previous arm. */
  const armRows = (steps: Record<string, { wins?: Record<string, number>; losses?: Record<string, number> }>) => {
    const out: Record<string, Row[]> = {};
    let prev: Row[] = [];
    for (const [k, n] of Object.entries(kinds)) for (let i = 0; i < n; i++) prev.push({ question_id: `${k}-${i}`, haystack_id: `h${i % 40}`, question_type: k, answer_correct: i % 2 === 0 });
    out.A0 = prev;
    for (const arm of ['A1', 'A2', 'A3', 'A4']) {
      const s = steps[arm] ?? {};
      const left: Record<string, { w: number; l: number }> = Object.fromEntries(Object.keys(kinds).map(k => [k, { w: s.wins?.[k] ?? 0, l: s.losses?.[k] ?? 0 }]));
      prev = prev.map(r => {
        const c = left[r.question_type];
        if (!r.answer_correct && c.w > 0) { c.w--; return { ...r, answer_correct: true }; }
        if (r.answer_correct && c.l > 0) { c.l--; return { ...r, answer_correct: false }; }
        return r;
      });
      out[arm] = prev;
    }
    out.R5 = out.A0;
    return out;
  };
  const cmp = (id: string, delta: number, lo: number, hi: number, p: number) => ({ id: 'answer_accuracy', status: 'ok', stats: { delta, ci95: [lo, hi] as [number, number], p_two_sided: p, n_pairs: 200, n_clusters: 40, mean_a: 0.5, mean_b: 0.5 + delta }, mcnemar: { wins: 20, losses: 4, p_two_sided: p } });
  const strong = { D1: cmp('D1', 0.08, 0.03, 0.13, 0.001), D2: cmp('D2', 0.08, 0.03, 0.13, 0.002), D3: cmp('D3', 0.08, 0.03, 0.13, 0.003), D4: cmp('D4', 0.08, 0.03, 0.13, 0.004) };
  const wins = { wins: { 'multi-session': 6, 'temporal-reasoning': 5, 'knowledge-update': 5 } };
  const run = (o: Partial<Parameters<typeof decideC8k>[1]> & { steps?: Parameters<typeof armRows>[0] } = {}) =>
    decideC8k(D.rule, { gatePass: true, comparisons: strong, rows: armRows(o.steps ?? { A1: wins, A2: wins, A3: wins, A4: wins }), readerErrors: {}, r5: cmp('F1', 0.02, -0.02, 0.06, 0.4), ...o });
  const verdicts = (r: ReturnType<typeof decideC8k>) => Object.fromEntries(r.comparisons.map(c => [c.id, c.label]));

  test('every comparison passing recommends all four flips, in order', () => {
    const r = run();
    expect(verdicts(r)).toEqual({ D1: 'pass', D2: 'pass', D3: 'pass', D4: 'pass' });
    expect(r.recommended_prefix).toEqual(['D1', 'D2', 'D3', 'D4']);
    expect(r.recommendations).toEqual(['D1', 'D2', 'D3', 'D4'].map(id => D.rule.recommendations[id]));
    expect(r.outcome).toMatch(/^recommend: flip search.query_budget_unit/);
  });

  test('Holm over the four McNemar p values: 0.01, 0.02, 0.03, 0.04 adjust to 0.04, 0.06, 0.06, 0.06', () => {
    const r = run({ comparisons: { D1: cmp('D1', 0.08, 0.03, 0.13, 0.01), D2: cmp('D2', 0.08, 0.03, 0.13, 0.02), D3: cmp('D3', 0.08, 0.03, 0.13, 0.03), D4: cmp('D4', 0.08, 0.03, 0.13, 0.04) } });
    expect(r.p_holm.D1).toBeCloseTo(0.04, 12);
    for (const id of ['D2', 'D3', 'D4']) expect(r.p_holm[id]).toBeCloseTo(0.06, 12);
    expect(verdicts(r)).toEqual({ D1: 'pass', D2: 'inconclusive', D3: 'inconclusive', D4: 'inconclusive' });
    expect(r.comparisons[1].reasons[0]).toMatch(/Holm-adjusted McNemar p < alpha/);
    expect(r.recommended_prefix).toEqual(['D1']);
  });

  test('a blocked or missing comparison counts as p = 1 in Holm and is inconclusive', () => {
    const r = run({ comparisons: { ...strong, D3: { id: 'answer_accuracy', status: 'blocked', reasons: ['missing rows'] } as never, D4: undefined } });
    expect(r.p_holm.D1).toBeCloseTo(0.004, 12);
    expect(r.p_holm.D3).toBe(1);
    expect(verdicts(r)).toMatchObject({ D3: 'inconclusive', D4: 'inconclusive' });
    expect(r.comparisons[2].reasons[0]).toMatch(/blocked: missing rows/);
    expect(r.comparisons[3].reasons[0]).toMatch(/missing/);
  });

  test('superiority needs delta > 0 and the interval above zero; an interval wholly below zero fails', () => {
    expect(verdicts(run({ comparisons: { ...strong, D2: cmp('D2', 0.03, -0.01, 0.07, 0.001) } })).D2).toBe('inconclusive');
    expect(verdicts(run({ comparisons: { ...strong, D2: cmp('D2', -0.08, -0.13, -0.02, 0.001) } })).D2).toBe('fail');
  });

  test('guard 7: a clear loss in a kind fails that comparison only (exact one-sided McNemar, p < 0.05)', () => {
    const small = run({ steps: { A1: wins, A2: { wins: { 'temporal-reasoning': 9 }, losses: { 'multi-session': 4 } }, A3: wins, A4: wins } });
    expect(small.comparisons[1].guard7.kinds['multi-session']).toMatchObject({ wins: 0, losses: 4, pass: true });
    expect(verdicts(small).D2).toBe('pass');
    const clear = run({ steps: { A1: wins, A2: { wins: { 'temporal-reasoning': 9 }, losses: { 'multi-session': 5 } }, A3: wins, A4: wins } });
    expect(clear.comparisons[1].guard7.kinds['multi-session']).toMatchObject({ wins: 0, losses: 5, pass: false });
    expect(clear.comparisons[1].guard7.kinds['multi-session'].p_loss_one_sided).toBeCloseTo(1 / 32, 12);
    expect(verdicts(clear)).toEqual({ D1: 'pass', D2: 'fail', D3: 'pass', D4: 'pass' });
    expect(clear.comparisons[1].reasons[0]).toMatch(/guard 7: a clear loss in multi-session \(0 wins, 5 losses/);
  });

  test('guard 8: abstention may not fall at all', () => {
    const r = run({ steps: { A1: { wins: { 'temporal-reasoning': 9 }, losses: { abstention: 1 } }, A2: wins, A3: wins, A4: wins } });
    expect(r.comparisons[0].guard7.kinds.abstention).toMatchObject({ losses: 1, pass: true });
    expect(r.comparisons[0].guard8).toMatchObject({ pass: false, earlier: 20, later: 19 });
    expect(verdicts(r).D1).toBe('fail');
    expect(r.recommended_prefix).toEqual([]);
  });

  test('F1 is recommended only when A1 is non-inferior to R5 (lower bound above -5 points), else "pass, not recommended"', () => {
    const at = (lo: number | null) => run({ r5: lo === null ? undefined : cmp('F1', 0, lo, 0.04, 0.5) });
    expect(at(-0.049).comparisons[0]).toMatchObject({ verdict: 'pass', label: 'pass', recommended: true });
    const miss = at(-0.05);
    expect(miss.comparisons[0]).toMatchObject({ verdict: 'pass', label: 'pass, not recommended', recommended: false });
    expect(miss.comparisons[0].noninferiority).toMatchObject({ reference: 'R5', candidate: 'A1', pass: false });
    expect(miss.comparisons[0].reasons.join(' ')).toMatch(/pass, not recommended: .* lower bound -0.0500, not above -0.05/);
    expect(miss.recommended_prefix).toEqual([]);
    expect(miss.reported_without_recommendation).toEqual(['D2', 'D3', 'D4']);
    expect(miss.outcome).toMatch(/every flag stays off/);
    expect(at(null).comparisons[0].label).toBe('pass, not recommended');
  });

  test('recommendations follow only the contiguous passing prefix from D1', () => {
    const r = run({ comparisons: { ...strong, D2: cmp('D2', 0.01, -0.03, 0.05, 0.5) } });
    expect(verdicts(r)).toEqual({ D1: 'pass', D2: 'inconclusive', D3: 'pass', D4: 'pass' });
    expect(r.recommended_prefix).toEqual(['D1']);
    expect(r.recommendations).toEqual([D.rule.recommendations.D1]);
    expect(r.reported_without_recommendation).toEqual(['D3', 'D4']);
  });

  test('a failed gate fails everything; more than 3 reader errors in either arm is inconclusive', () => {
    const g = run({ gatePass: false, gateReasons: ['A1: 2 tool results are errors'] });
    expect(verdicts(g)).toEqual({ D1: 'fail', D2: 'fail', D3: 'fail', D4: 'fail' });
    expect(g.comparisons[0].reasons[0]).toMatch(/a gate failed: A1: 2 tool results are errors/);
    expect(g.recommended_prefix).toEqual([]);
    expect(verdicts(run({ readerErrors: { A2: 3 } }))).toEqual({ D1: 'pass', D2: 'pass', D3: 'pass', D4: 'pass' });
    expect(verdicts(run({ readerErrors: { A2: 4 } }))).toEqual({ D1: 'pass', D2: 'inconclusive', D3: 'inconclusive', D4: 'pass' });
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
