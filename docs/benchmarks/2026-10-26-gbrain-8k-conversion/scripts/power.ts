/**
 * Power of the preregistered 8k conversion rule, simulated before custody from the development reading's paired
 * per-question Sonnet 5.5 rows (LongMemEval-S dev100, c8k-run.sh dev), with the real comparison code (evaluateFamily
 * with this decision's family) and the real rule (decideC8k in c8k.ts, Holm over D1 to D4 and F1's non-inferiority
 * against R5); bootstrap and sign-flip draws lowered to 2,000 for speed.
 *
 * Each simulated set has sealed v2's shape, 40 personas x (2 multi-session, 1 temporal, 1 knowledge update,
 * 1 abstention), and draws each question's whole row of six arms (A0 to A4 and R5) with replacement from the
 * development questions of its kind, so each step's per-kind effect, discordance and the correlation between steps
 * are the development reading's. Pairs are independent within a persona: a persona effect would widen the intervals.
 *
 * Scenarios:
 *   dev_transfer  every kind as in the development reading
 *   null          the five configurations A0 to A4 exchangeable within each drawn question (no true effect of any
 *                 flag): the rule's false-pass and false-recommendation rates
 *
 *   bun docs/benchmarks/2026-10-26-gbrain-8k-conversion/scripts/power.ts --dev-scores <dev scores dir> [--sims 1000] > power.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateFamily, type ComparisonFamily } from '../../../../eval/runner/stats/gates.ts';
import { seededRandom } from '../../../../eval/runner/stats/paired.ts';
import { decideC8k, type C8kDecision } from '../../../../eval/runner/budgeted-delivery/c8k.ts';

const dir = join(import.meta.dir, '..');
const family = JSON.parse(readFileSync(join(dir, 'family.json'), 'utf8')) as ComparisonFamily;
const argv = process.argv.slice(2);
const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const decision = JSON.parse(readFileSync(one('--decision') ?? join(dir, 'decision.json'), 'utf8')) as C8kDecision;
const sim: ComparisonFamily = { ...family, draws: 2000, comparisons: family.comparisons.filter(c => c.metric === 'answer_correct') };
const ARMS = ['A0', 'A1', 'A2', 'A3', 'A4', 'R5'] as const;
export const KINDS = ['multi-session', 'temporal-reasoning', 'knowledge-update', 'abstention'] as const;
export const SHAPE: Array<[typeof KINDS[number], number]> = [['multi-session', 2], ['temporal-reasoning', 1], ['knowledge-update', 1], ['abstention', 1]];
type Tuple = Record<typeof ARMS[number], number>;

/** The development pools: per kind, one tuple of six 0/1 scores per development question (the deciding reader). */
export function devPools(scoresDir: string, reader = 'sonnet-5-5'): Record<string, Tuple[]> {
  const per: Record<string, Map<string, { kind: string; correct: boolean }>> = {};
  for (const arm of ARMS) {
    const id = decision.answer_arms.find(a => a.role === 'development' && a.reader === reader && a.arm === arm)?.id;
    const p = id && join(scoresDir, `${id}.json`);
    if (!p || !existsSync(p)) throw new Error(`no development score report for ${reader} ${arm} in ${scoresDir}`);
    per[arm] = new Map((JSON.parse(readFileSync(p, 'utf8')).per_question as Array<{ question_id: string; question_type: string; answer_correct: boolean }>).map(r => [r.question_id, { kind: r.question_type, correct: !!r.answer_correct }]));
  }
  const pools: Record<string, Tuple[]> = Object.fromEntries(KINDS.map(k => [k, []]));
  for (const [qid, r] of per.A0) {
    if (!pools[r.kind] || ARMS.some(a => !per[a].has(qid))) continue;
    pools[r.kind].push(Object.fromEntries(ARMS.map(a => [a, per[a].get(qid)!.correct ? 1 : 0])) as Tuple);
  }
  for (const k of KINDS) if (!pools[k].length) throw new Error(`the development reading has no ${k} question`);
  return pools;
}

function shuffleConfigs(rng: () => number, t: Tuple): Tuple {
  const xs = ['A0', 'A1', 'A2', 'A3', 'A4'].map(a => t[a as keyof Tuple]);
  for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
  return { A0: xs[0], A1: xs[1], A2: xs[2], A3: xs[3], A4: xs[4], R5: t.R5 };
}

/** One sealed-shaped set: score rows per arm. */
export function drawSet(rng: () => number, pools: Record<string, Tuple[]>, nullScenario: boolean) {
  const rows: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(ARMS.map(a => [a, []]));
  for (let j = 0; j < 40; j++) for (const [kind, n] of SHAPE) for (let k = 0; k < n; k++) {
    const pool = pools[kind];
    let t = pool[Math.floor(rng() * pool.length)];
    if (nullScenario) t = shuffleConfigs(rng, t);
    const base = { question_id: `q${j}-${kind}-${k}`, haystack_id: `h${j}`, question_type: kind };
    for (const a of ARMS) rows[a].push({ ...base, answer_correct: t[a] === 1 });
  }
  return rows;
}

export function decideSet(rows: Record<string, Array<Record<string, unknown>>>, s: number) {
  const cmp = (a: string, b: string) => evaluateFamily(rows[a], rows[b], { ...sim, seed: 20261026 + s }).comparisons.find(x => x.id === 'answer_accuracy') as never;
  const comparisons = Object.fromEntries(decision.rule.comparisons.map(c => [c.id, cmp(c.a, c.b)]));
  return decideC8k(decision.rule, { gatePass: true, comparisons, rows, readerErrors: {}, r5: cmp(decision.rule.f1_noninferiority.reference, decision.rule.f1_noninferiority.candidate) });
}

if (import.meta.main) {
  const scores = one('--dev-scores');
  if (!scores) { console.error('usage: bun scripts/power.ts --dev-scores <dev scores dir> [--sims 1000] [--decision <decision.json>]'); process.exit(2); }
  const SIMS = Number(one('--sims') ?? 1000);
  const pools = devPools(scores);
  const rng = seededRandom(20261026);
  const out: Record<string, unknown> = {};
  for (const name of ['dev_transfer', 'null']) {
    const ids = decision.rule.comparisons.map(c => c.id);
    const c = Object.fromEntries(ids.map(id => [id, { pass: 0, fail: 0, inconclusive: 0, recommended: 0, pass_not_recommended: 0, guard7_fail: 0, guard8_fail: 0, delta_sum: 0 }]));
    const prefix: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (let s = 0; s < SIMS; s++) {
      const r = decideSet(drawSet(rng, pools, name === 'null'), s);
      for (const x of r.comparisons) {
        const k = c[x.id];
        k[x.verdict]++;
        if (x.recommended && r.recommended_prefix.includes(x.id)) k.recommended++;
        if (x.label === 'pass, not recommended') k.pass_not_recommended++;
        if (!x.guard7.pass) k.guard7_fail++;
        if (!x.guard8.pass) k.guard8_fail++;
        k.delta_sum += x.stats?.delta ?? 0;
      }
      prefix[r.recommended_prefix.length]++;
    }
    out[name] = {
      sims: SIMS,
      comparisons: Object.fromEntries(ids.map(id => { const k = c[id]; return [id, { mean_delta: k.delta_sum / SIMS, p_pass: k.pass / SIMS, p_fail: k.fail / SIMS, p_inconclusive: k.inconclusive / SIMS,
        p_pass_not_recommended: k.pass_not_recommended / SIMS, p_recommended_in_prefix: k.recommended / SIMS, p_guard7_fail: k.guard7_fail / SIMS, p_guard8_fail: k.guard8_fail / SIMS, below_20_percent: k.pass / SIMS < 0.2 }]; })),
      recommended_prefix_length: Object.fromEntries(Object.entries(prefix).map(([n, v]) => [n, v / SIMS])),
    };
  }
  console.log(JSON.stringify({
    schema: 'gbrain-evals/c8k-power/v1', decision_id: decision.decision_id,
    note: 'Simulated before custody from the development reading\'s Sonnet 5.5 rows (LongMemEval-S dev100) with the committed family and rule; bootstrap and sign-flip draws lowered to 2,000. No sealed data. A comparison whose dev_transfer p_pass is below 0.2 is flagged below_20_percent, as the preregistration requires.',
    pools: Object.fromEntries(KINDS.map(k => [k, { n: pools[k].length, accuracy: Object.fromEntries(ARMS.map(a => [a, pools[k].reduce((n, t) => n + t[a], 0) / pools[k].length])) }])),
    sealed_shape: { personas: 40, per_persona: Object.fromEntries(SHAPE), kinds: decision.sealed.kinds }, scenarios: out,
  }, null, 2));
}
