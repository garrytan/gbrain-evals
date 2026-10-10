/**
 * Power of the preregistered H1 rule, simulated before custody from E2's paired per-question results, with the real
 * comparison code (evaluateFamily with this decision's family) and the real rule (decideH1 in h1.ts), bootstrap and
 * sign-flip draws lowered to 2,000 for speed.
 *
 * Pools: E2's Sonnet 5.5 rows on the LongMemEval-S 500 (committed receipts), paired by question, for the kinds sealed
 * v2 is built from: multi-session, temporal-reasoning and knowledge-update (answerable questions), and abstention
 * (LongMemEval's 30 abstention questions, every kind). Each simulated set has sealed v2's shape, 40 personas x
 * (2 multi-session, 1 temporal, 1 knowledge update, 1 abstention), and draws each question's (cap_only, depth_first)
 * pair with replacement from its kind's pool, so the per-kind effect and discordance are E2's. Pairs are independent
 * within a persona: a persona effect on the difference would widen the interval somewhat.
 *
 * Scenarios, because the transfer from LongMemEval-S to sealed v2 is the main uncertainty:
 *   e2_transfer        every kind as in E2
 *   ms_no_gain         multi-session pairs keep E2's discordance with each discordant pair's direction a coin flip
 *   ms_breadth_wins    multi-session pairs are E2's (breadth_capped, depth_first) pairs: what happens if cap_only's
 *                      breadth helps sealed multi-session questions (three or four gold chats) the way breadth_capped
 *                      helped LongMemEval-S's
 *   null               every kind symmetrized (no true effect anywhere): the rule's false-pass rate
 *
 *   bun docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/scripts/power.ts > docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/power.json
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { evaluateFamily, type ComparisonFamily } from '../../../../eval/runner/stats/gates.ts';
import { seededRandom } from '../../../../eval/runner/stats/paired.ts';
import { decideH1, type H1Decision } from '../../../../eval/runner/budgeted-delivery/h1.ts';

const dir = join(import.meta.dir, '..');
const family = JSON.parse(readFileSync(join(dir, 'family.json'), 'utf8')) as ComparisonFamily;
const decision = JSON.parse(readFileSync(join(dir, 'decision.json'), 'utf8')) as H1Decision;
const sim: ComparisonFamily = { ...family, draws: 2000, comparisons: family.comparisons.filter(c => c.metric === 'answer_correct') };
const E2 = join(dir, '..', '2026-10-09-gbrain-budgeted-delivery-e2', 'results', 'lme-s', 'deliver');
const SIMS = 1000;

type Pair = [number, number];
function armScores(arm: string): Map<string, { score: number; category: string; abstention: boolean }> {
  const out = new Map<string, { score: number; category: string; abstention: boolean }>();
  for (const shard of readdirSync(E2).sort()) {
    const p = join(E2, shard, 'arms', arm, 'rows.ndjson.gz');
    if (!existsSync(p)) continue;
    for (const line of gunzipSync(readFileSync(p)).toString('utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      out.set(r.id, { score: r.qa_score, category: r.category, abstention: r.abstention });
    }
  }
  return out;
}
const capOnly = armScores('fixed-evidence.pseudo-cap_only.b8000.sonnet-5-5');
const depthFirst = armScores('fixed-evidence.pseudo-depth_first.b8000.sonnet-5-5');
const breadth = armScores('fixed-evidence.pseudo-breadth_capped.b8000.sonnet-5-5');
if (capOnly.size !== 500 || depthFirst.size !== 500 || breadth.size !== 500) throw new Error('E2 receipts: expected 500 rows per arm');

const KINDS = ['multi-session', 'temporal-reasoning', 'knowledge-update', 'abstention'] as const;
const kindOf = (r: { category: string; abstention: boolean }) => r.abstention ? 'abstention' : r.category;
function pools(control: Map<string, { score: number; category: string; abstention: boolean }>) {
  const p: Record<string, Pair[]> = Object.fromEntries(KINDS.map(k => [k, []]));
  for (const [id, c] of control) { const k = kindOf(c); if (p[k]) p[k].push([c.score, depthFirst.get(id)!.score]); }
  return p;
}
const base = pools(capOnly);
const symmetrize = (ps: Pair[]): Pair[] => ps.flatMap(([a, b]) => a === b ? [[a, b] as Pair] : [[a, b] as Pair, [b, a] as Pair]);
const scenarios: Record<string, Record<string, Pair[]>> = {
  e2_transfer: base,
  ms_no_gain: { ...base, 'multi-session': symmetrize(base['multi-session']) },
  ms_breadth_wins: { ...base, 'multi-session': pools(breadth)['multi-session'] },
  null: Object.fromEntries(KINDS.map(k => [k, symmetrize(base[k])])),
};
const SHAPE: Array<[typeof KINDS[number], number]> = [['multi-session', 2], ['temporal-reasoning', 1], ['knowledge-update', 1], ['abstention', 1]];
const SEALED = decision.sealed.kinds;

function describePool(ps: Record<string, Pair[]>) {
  return Object.fromEntries(KINDS.map(k => {
    const x = ps[k], n = x.length;
    const wins = x.filter(([a, b]) => b > a).length, losses = x.filter(([a, b]) => b < a).length;
    const delta = x.reduce((s, [a, b]) => s + b - a, 0) / n;
    return [k, { pool: n, control: x.reduce((s, [a]) => s + a, 0) / n, candidate: x.reduce((s, [, b]) => s + b, 0) / n, delta, discordant: (wins + losses) / n, wins, losses, projected_questions: delta * SEALED[k] }];
  }));
}

const rng = seededRandom(20261010);
const out: Record<string, unknown> = {};
for (const [name, ps] of Object.entries(scenarios)) {
  const c = { pass: 0, fail: 0, inconclusive: 0, superiority: 0, guard7_fail: 0, guard8_fail: 0, guard7_fail_by_kind: Object.fromEntries(KINDS.map(k => [k, 0])) as Record<string, number> };
  let deltaSum = 0;
  for (let s = 0; s < SIMS; s++) {
    const a: Array<Record<string, unknown>> = [], b: Array<Record<string, unknown>> = [];
    for (let j = 0; j < 40; j++) for (const [kind, n] of SHAPE) for (let k = 0; k < n; k++) {
      const pool = ps[kind];
      const [x, y] = pool[Math.floor(rng() * pool.length)];
      const row = { question_id: `q${j}-${kind}-${k}`, haystack_id: `h${j}`, question_type: kind };
      a.push({ ...row, answer_correct: x === 1 });
      b.push({ ...row, answer_correct: y === 1 });
    }
    const fam = evaluateFamily(a, b, { ...sim, seed: 20261010 + s });
    const r = decideH1(decision.rule, { gatePass: true, primary: fam.comparisons.find(x => x.id === decision.rule.primary_comparison) as any, control: a, candidate: b, readerErrors: {} });
    c[r.verdict]++;
    if (r.superiority_shown) c.superiority++;
    if (!r.guard7.pass) c.guard7_fail++;
    if (!r.guard8.pass) c.guard8_fail++;
    for (const [k, v] of Object.entries(r.guard7.kinds)) if (!v.pass) c.guard7_fail_by_kind[k]++;
    deltaSum += r.primary?.delta ?? 0;
  }
  out[name] = {
    pools: describePool(ps),
    projected_delta_questions: KINDS.reduce((s, k) => s + describePool(ps)[k].projected_questions, 0),
    sims: SIMS, mean_delta: deltaSum / SIMS,
    p_pass: c.pass / SIMS, p_fail: c.fail / SIMS, p_inconclusive: c.inconclusive / SIMS, p_superiority_shown: c.superiority / SIMS,
    p_guard7_fail: c.guard7_fail / SIMS, p_guard8_fail: c.guard8_fail / SIMS, p_guard7_fail_by_kind: Object.fromEntries(Object.entries(c.guard7_fail_by_kind).map(([k, v]) => [k, v / SIMS])),
  };
}
console.log(JSON.stringify({
  schema: 'gbrain-evals/budgeted-delivery-h1-power/v1', simulated_at: '2026-10-10', decision_id: decision.decision_id,
  note: 'Simulated before custody from E2\'s committed Sonnet 5.5 rows (cap_only, depth_first, breadth_capped) on the LongMemEval-S 500, with the committed family and rule; bootstrap and sign-flip draws lowered to 2,000. No sealed data.',
  sealed_shape: { personas: 40, per_persona: Object.fromEntries(SHAPE), kinds: SEALED }, model: 'see the header of scripts/power.ts', scenarios: out,
}, null, 2));
