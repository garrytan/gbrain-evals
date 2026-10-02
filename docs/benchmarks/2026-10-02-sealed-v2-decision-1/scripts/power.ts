/**
 * Power of the preregistered rule for sealed v2 decision 1, simulated before
 * the set was opened. Uses the real comparison code (evaluateFamily with this
 * decision's family) and the real rule (decideEvidence), with sign-flip and
 * bootstrap draws lowered to 2,000 for speed.
 *
 * Model: 40 personas x 5 questions. Persona chunk accuracy is the cell's chunk
 * accuracy plus N(0, 0.12), clipped to [0.02, 0.98]. Each question draws one
 * uniform u; chunk is correct when u < p_persona. auto reuses u with
 * probability 1 - r and draws a fresh uniform with probability r, and is
 * correct when that value < p_persona + delta. r sets how often the two arms
 * disagree for reasons other than the true effect.
 *
 *   bun docs/benchmarks/2026-10-02-sealed-v2-decision-1/scripts/power.ts > docs/benchmarks/2026-10-02-sealed-v2-decision-1/power.json
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateFamily, type ComparisonFamily } from '../../../../eval/runner/stats/gates.ts';
import { seededRandom } from '../../../../eval/runner/stats/paired.ts';
import { decideEvidence, type EvidenceDecision } from '../../../../eval/runner/sealed-confirmation.ts';

const dir = join(import.meta.dir, '..');
const family = JSON.parse(readFileSync(join(dir, 'family.json'), 'utf8')) as ComparisonFamily;
const decision = JSON.parse(readFileSync(join(dir, 'decision.json'), 'utf8')) as EvidenceDecision;
const sim: ComparisonFamily = { ...family, draws: 2000, comparisons: family.comparisons.filter(c => c.metric === 'answer_correct') };
const SIMS = 200;
const rng = seededRandom(20261002);
const gauss = () => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());

const cells = [];
for (const r of [0.2, 0.4]) {
  for (const chunkAcc of [0.5, 0.65, 0.8]) {
    for (const delta of [-0.05, -0.03, 0, 0.03, 0.05, 0.1, 0.15]) {
      const counts = { pass: 0, fail: 0, inconclusive: 0, superiority_confirmed: 0 };
      for (let s = 0; s < SIMS; s++) {
        const a: Array<Record<string, unknown>> = [], b: Array<Record<string, unknown>> = [];
        for (let j = 0; j < 40; j++) {
          const p = Math.min(0.98, Math.max(0.02, chunkAcc + 0.12 * gauss()));
          for (let k = 0; k < 5; k++) {
            const u = rng();
            const u2 = rng() < r ? rng() : u;
            const id = `q${j}-${k}`, hay = `h${j}`;
            a.push({ question_id: id, haystack_id: hay, answer_correct: u < p });
            b.push({ question_id: id, haystack_id: hay, answer_correct: u2 < p + delta });
          }
        }
        const out = decideEvidence(decision.rule, { decision: evaluateFamily(a, b, { ...sim, seed: 20261002 + s }) as any }, {});
        counts[out.verdict]++;
        if (out.superiority === 'confirmed') counts.superiority_confirmed++;
      }
      cells.push({ discordance_r: r, chunk_accuracy: chunkAcc, true_delta: delta, sims: SIMS, p_pass: counts.pass / SIMS, p_fail: counts.fail / SIMS, p_inconclusive: counts.inconclusive / SIMS, p_superiority_confirmed: counts.superiority_confirmed / SIMS });
    }
  }
}
console.log(JSON.stringify({ schema: 'gbrain-evals/sealed-v2-decision-1-power/v1', simulated_at: '2026-10-02', note: 'Simulated before opening the set, with the committed family and rule; sign-flip and bootstrap draws lowered to 2,000.', model: 'see the header of scripts/power.ts', cells }, null, 2));
