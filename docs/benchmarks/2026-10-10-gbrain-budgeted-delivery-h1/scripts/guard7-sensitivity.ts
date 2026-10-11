/**
 * Pre-custody sensitivity of the H1 rule to guard 7 (2026-10-10, before any sealed file was copied), the analysis behind
 * Garry's choice of the clear-loss test. It draws exactly the sets power.ts draws (same scenarios, seed and order) and
 * scores each set under five kind guards; superiority (delta > 0, persona-clustered 95% interval above zero, exact
 * two-sided McNemar p < 0.05), guard 8 and the gates are unchanged. The C2 column is the committed rule, so it equals
 * power.json.
 *
 *   A   the plan's point rule: no kind down by more than max(1 question, 2% of the kind)
 *   B   max(1 question, 5% of the kind)
 *   C   a kind fails if its persona-clustered bootstrap 90% upper bound (one-sided 0.05) is below zero
 *   C2  committed: a kind fails if an exact one-sided McNemar test on its discordant pairs (losses > wins) has p < 0.05
 *   D   no per-kind limit: answerable questions overall down by no more than max(1, 2% of 160), plus guard 8
 *
 *   bun docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/scripts/guard7-sensitivity.ts > docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/guard7-sensitivity.json
 */
import { seededRandom } from '../../../../eval/runner/stats/paired.ts';
import { decideSet, drawSet, KINDS, scenarios, SIMS, type Pair } from './power.ts';

const BOOT = 2000;
const bootRng = seededRandom(7);

/** Persona-clustered bootstrap 90% upper bound of a kind's mean difference (candidate minus control). */
function clusterUpper90(diffByPersona: number[][]): number {
  const sums = diffByPersona.map(x => x.reduce((a, b) => a + b, 0)), counts = diffByPersona.map(x => x.length), n = sums.length;
  const means: number[] = [];
  for (let d = 0; d < BOOT; d++) {
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) { const j = Math.floor(bootRng() * n); s += sums[j]; c += counts[j]; }
    means.push(s / c);
  }
  means.sort((a, b) => a - b);
  return means[Math.floor(0.95 * (BOOT - 1))];
}

const VARIANTS = ['A', 'B', 'C', 'C2', 'D'] as const;
type Kinds = Record<string, { n: number; delta_questions: number; pass: boolean }>;
const pointRule = (share: number) => (kinds: Kinds, k: string) => kinds[k].delta_questions >= -Math.max(1, share * kinds[k].n) - 1e-9;

const rng = seededRandom(20261010);
const out: Record<string, unknown> = {};
for (const [name, ps] of Object.entries(scenarios)) {
  const c = Object.fromEntries(VARIANTS.map(v => [v, { pass: 0, fail: 0, inconclusive: 0, guard7_fail: 0, guard7_fail_multi_session: 0 }]));
  let superiority = 0;
  for (let s = 0; s < SIMS; s++) {
    const { a, b } = drawSet(rng, ps);
    const r = decideSet(a, b, s);
    if (r.superiority_shown) superiority++;
    const kinds = r.guard7.kinds as Kinds;
    const diffs: Record<string, number[][]> = Object.fromEntries(KINDS.map(k => [k, Array.from({ length: 40 }, () => [] as number[])]));
    a.forEach((x, i) => diffs[x.question_type as string][Number(String(x.haystack_id).slice(1))].push(Number(b[i].answer_correct) - Number(x.answer_correct)));
    const answerable = KINDS.filter(k => k !== 'abstention');
    const overall = answerable.reduce((n, k) => n + kinds[k].delta_questions, 0) >= -Math.max(1, 0.02 * answerable.reduce((n, k) => n + kinds[k].n, 0)) - 1e-9;
    const perKind: Record<typeof VARIANTS[number], (k: string) => boolean> = {
      A: k => pointRule(0.02)(kinds, k), B: k => pointRule(0.05)(kinds, k), C: k => clusterUpper90(diffs[k]) >= 0, C2: k => kinds[k].pass, D: () => overall,
    };
    const shownWorse = !!(r.primary?.ci95 && r.primary.ci95[1] < 0);
    for (const v of VARIANTS) {
      const g7 = KINDS.every(perKind[v]);
      const verdict = !g7 || !r.guard8.pass || shownWorse ? 'fail' : r.superiority_shown ? 'pass' : 'inconclusive';
      if (v === 'C2' && verdict !== r.verdict) throw new Error(`C2 must reproduce decideH1 (set ${s} of ${name})`);
      c[v][verdict]++;
      if (!g7) c[v].guard7_fail++;
      if (!perKind[v]('multi-session')) c[v].guard7_fail_multi_session++;
    }
  }
  const ms = ps['multi-session'] as Pair[];
  out[name] = {
    multi_session_pool_delta_points: 100 * ms.reduce((n, [x, y]) => n + y - x, 0) / ms.length, p_superiority_shown: superiority / SIMS,
    variants: Object.fromEntries(VARIANTS.map(v => [v, Object.fromEntries(Object.entries(c[v]).map(([k, n]) => [`p_${k}`, n / SIMS]))])),
  };
}
console.log(JSON.stringify({
  schema: 'gbrain-evals/budgeted-delivery-h1-guard7-sensitivity/v1', analysed_at: '2026-10-10', stage: 'pre-custody, before any sealed file was copied',
  decision: 'Garry chose C2 on 2026-10-10; it replaced A (the plan\'s rule) in decision.json before custody.',
  sims: SIMS, cluster_bootstrap_draws_for_C: BOOT, variants: {
    A: 'no kind down by more than max(1 question, 2% of the kind)', B: 'max(1 question, 5% of the kind)', C: 'persona-clustered bootstrap 90% upper bound of the kind difference below zero fails',
    C2: 'exact one-sided McNemar on the kind\'s discordant pairs (losses > wins), p < 0.05 fails (committed)', D: 'answerable overall down by no more than max(1, 2% of 160), plus guard 8; no per-kind limit',
  }, scenarios: out,
}, null, 2));
