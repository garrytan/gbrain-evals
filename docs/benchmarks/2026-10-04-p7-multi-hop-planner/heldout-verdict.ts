// P7 held-out verdict: applies the preregistered benefit gates to the custodian's run directory.
// Usage: bun docs/benchmarks/2026-10-04-p7-multi-hop-planner/heldout-verdict.ts <run dir> [--falsefire <falsefire.json>] [--decision-id <id>] > verdict.json
// Custodian interpretations fixed before the runs (gbrain-evals 25e33bd): chain answers are distinct pages among the
// first 10 whose row carries relational role "answer"; edge evidence is correct when every edge on the row connects a
// gold chain pair (unordered); wrong-answer promotion compares the feature arm's chain rows above the first gold page
// with the baseline arm's non-gold rows above the first gold page, per run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...rest] = process.argv.slice(2);
const ffPath = rest.includes('--falsefire') ? rest[rest.indexOf('--falsefire') + 1] : null;
const decisionId = rest.includes('--decision-id') ? rest[rest.indexOf('--decision-id') + 1] : 'p7-heldout-2026-10-04';
const TYPED = new Set(['investor_founders', 'advisor_founders', 'founder_investors', 'coinvestors', 'founder_portfolio_peers']);

type Row = { seed: number; question_id: string; split: string; family: string; on: { strict_all_hit: number } | null; funnel: { fired: boolean } | null;
  on_safety?: { chain_answers: number; chain_answers_gold: number; chain_edges_ok: number; wrong_above_first_gold: number; chain_wrong_above_first_gold: number } | null };
const n9 = (cell: string) => JSON.parse(readFileSync(join(dir, cell, 'receipt.json'), 'utf8')).data.per_question as Row[];
const rab = (arm: string) => JSON.parse(readFileSync(join(dir, `rab-${arm}`, 'receipt.json'), 'utf8')).data.per_query as Array<{ seed: number; query_id: string; split: string; on: { metrics: { recall_at_5: number; hit_at_1: number } | null } }>;

function binomTwoSided(k: number, n: number): number {
  if (n === 0) return 1;
  const pmf = (i: number) => { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); return c / 2 ** n; };
  const lo = Math.min(k, n - k);
  let p = 0; for (let i = 0; i <= lo; i++) p += pmf(i);
  return Math.min(1, 2 * p);
}

/** Per distinct question, mean over seeds of feature minus baseline; sign test with ties dropped. */
function signTest(base: Row[], feat: Row[], split: string, metric = (r: Row) => r.on?.strict_all_hit ?? 0) {
  const mean = (rows: Row[]) => { const m = new Map<string, number[]>(); for (const r of rows.filter(x => x.split === split)) m.set(r.question_id, [...(m.get(r.question_id) ?? []), metric(r)]); return new Map([...m].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length])); };
  const a = mean(base), b = mean(feat);
  let better = 0, worse = 0, ties = 0;
  for (const [q, va] of a) { const vb = b.get(q); if (vb === undefined) continue; if (vb > va) better++; else if (vb < va) worse++; else ties++; }
  return { better, worse, ties, p_two_sided: binomTwoSided(better, better + worse) };
}

const strictTyped = (rows: Row[], split: string, family?: string) => {
  const r = rows.filter(x => x.split === split && (family ? x.family === family : TYPED.has(x.family)) && x.on);
  return r.length ? r.reduce((s, x) => s + x.on!.strict_all_hit, 0) / r.length : null;
};

const cells = {
  a_keyless: { base: n9('n9-a-keyless-base'), feat: n9('n9-a-keyless-feat') },
  a_paid: { base: n9('n9-a-paid-base'), feat: n9('n9-a-paid-feat') },
  b_paid: { base: n9('n9-b-paid-base'), feat: n9('n9-b-paid-feat') },
};

const summary: Record<string, unknown> = {};
for (const [name, c] of Object.entries(cells)) for (const split of ['composed-template', 'composed-paraphrase']) {
  const st = signTest(c.base, c.feat, split);
  summary[`${name}:${split}`] = {
    strict_typed: { base: strictTyped(c.base, split), feat: strictTyped(c.feat, split) },
    strict_all7: { base: c.base.filter(r => r.split === split && r.on).reduce((s, r) => s + r.on!.strict_all_hit, 0) / c.base.filter(r => r.split === split && r.on).length,
      feat: c.feat.filter(r => r.split === split && r.on).reduce((s, r) => s + r.on!.strict_all_hit, 0) / c.feat.filter(r => r.split === split && r.on).length },
    sign_test: st, hurts: st.worse > st.better && st.p_two_sided < 0.05,
    fired: c.feat.filter(r => r.split === split && r.funnel?.fired).length, runs: c.feat.filter(r => r.split === split).length,
    family_drop_over_5pt: [...TYPED].filter(f => { const b = strictTyped(c.base, split, f), x = strictTyped(c.feat, split, f); return b !== null && x !== null && x < b - 0.05; }),
  };
}

const safety = (rows: Row[]) => {
  const fired = rows.filter(r => r.funnel?.fired && r.on_safety);
  const ans = fired.reduce((s, r) => s + r.on_safety!.chain_answers, 0);
  return { fired_runs: fired.length, chain_answers: ans,
    chain_answer_precision: ans ? fired.reduce((s, r) => s + r.on_safety!.chain_answers_gold, 0) / ans : null,
    edge_evidence_correct: ans ? fired.reduce((s, r) => s + r.on_safety!.chain_edges_ok, 0) / ans : null };
};
const promo = (base: Row[], feat: Row[]) => {
  const b = base.filter(r => r.on_safety), f = feat.filter(r => r.on_safety);
  return { baseline_wrong_above_first_gold_per_run: b.reduce((s, r) => s + r.on_safety!.wrong_above_first_gold, 0) / b.length,
    feature_chain_wrong_above_first_gold_per_run: f.reduce((s, r) => s + r.on_safety!.chain_wrong_above_first_gold, 0) / f.length };
};

const pa = summary['a_paid:composed-paraphrase'] as any, pb = summary['b_paid:composed-paraphrase'] as any;
const safetyA = safety(cells.a_paid.feat), safetyB = safety(cells.b_paid.feat), promoB = promo(cells.b_paid.base, cells.b_paid.feat);

const oneHop = (arm: string) => {
  const base = rab('base'), feat = rab(arm);
  const out: Record<string, unknown> = {};
  for (const split of ['template', 'paraphrase']) for (const metric of ['recall_at_5', 'hit_at_1'] as const) {
    const m = (rows: typeof base) => { const mm = new Map<string, number[]>(); for (const r of rows.filter(x => x.split === split && x.on.metrics)) mm.set(r.query_id, [...(mm.get(r.query_id) ?? []), r.on.metrics![metric]]); return new Map([...mm].map(([k, v]) => [k, v.reduce((a, c) => a + c, 0) / v.length])); };
    const a = m(base), b = m(feat);
    let better = 0, worse = 0; for (const [q, va] of a) { const vb = b.get(q); if (vb === undefined) continue; if (vb > va) better++; else if (vb < va) worse++; }
    out[`${split}:${metric}`] = { better, worse, p_two_sided: binomTwoSided(better, better + worse), regression: worse > better && binomTwoSided(better, better + worse) < 0.05 };
  }
  return out;
};
const oneHopFeat = oneHop('feat'), oneHopOrient = oneHop('orient');
const ff = ffPath ? JSON.parse(readFileSync(ffPath, 'utf8')) as Array<{ set: string; n: number; fired: number; rate: number }> : null;

const gates = {
  benefit_1_sign_test: { pass: pa.sign_test.better > pa.sign_test.worse && pa.sign_test.p_two_sided < 0.05, detail: pa.sign_test },
  benefit_2_effect_floor: { pass: (pa.strict_typed.feat - pa.strict_typed.base) >= 0.10 && (pb.strict_typed.feat - pb.strict_typed.base) >= 0.05,
    detail: { cell_a_delta: pa.strict_typed.feat - pa.strict_typed.base, cell_b_delta: pb.strict_typed.feat - pb.strict_typed.base } },
  benefit_3_safety: {
    pass: (safetyA.chain_answer_precision ?? 0) >= 0.7 && (safetyB.chain_answer_precision ?? 0) >= 0.7 && (safetyA.edge_evidence_correct ?? 0) >= 0.8 && (safetyB.edge_evidence_correct ?? 0) >= 0.8
      && promoB.feature_chain_wrong_above_first_gold_per_run <= promoB.baseline_wrong_above_first_gold_per_run
      && Object.values(summary).every((s: any) => s.family_drop_over_5pt.length === 0),
    detail: { cell_a: safetyA, cell_b: safetyB, promotion_cell_b: promoB, unanswerable_chain_questions: 'not evaluable: N9 v1 has no unanswerable composed questions' },
  },
  benefit_4_no_hurt: { pass: Object.values(summary).every((s: any) => !s.hurts) },
  benefit_5_one_hop: { pass: [...Object.values(oneHopFeat), ...Object.values(oneHopOrient)].every((x: any) => !x.regression), detail: { feature: oneHopFeat, orientation: oneHopOrient } },
  benefit_6_false_fire: ff ? { pass: ff.filter(x => x.set !== 'brainbench-cat13-subset').every(x => x.rate <= 0.01), detail: ff.map(x => ({ set: x.set, n: x.n, fired: x.fired })) } : { pass: null, detail: 'not run' },
  benefit_7_latency: { pass: null, detail: 'release gate 5, implementer evidence on the frozen build (not re-measured by the custodian)' },
};
console.log(JSON.stringify({ decision_id: decisionId, cells: summary, gates }, null, 2));
