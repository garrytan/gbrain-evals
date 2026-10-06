/**
 * Q2 G6 power simulation from development-pilot receipts (preregistration "Size").
 *
 * Input: write-then-answer receipts of both arms from the dev pilot (two ingests per model, both corpora). The pilot
 * gives, per corpus × model × arm × question, an observed accuracy, and, per corpus × model × arm, the spread of
 * brain-level accuracy across ingests. Each simulated experiment then:
 *   1. draws `--pairs` question pairs per corpus with replacement from the pilot's pairs (a pilot question keeps its
 *      per-model, per-arm difficulty; with fewer pilot questions than planned the same question can repeat);
 *   2. draws, per corpus × model × arm × ingest, a brain effect u ~ Normal(0, sigma_ingest) on the logit scale, where
 *      sigma_ingest is the between-ingest SD of brain accuracy left after removing binomial noise (floor 0);
 *   3. shifts arm B's logit by the scenario's effect (`--effects`, in points on the pooled accuracy scale, solved so
 *      the pooled B − A equals it; 0 is the null) and draws every answer as Bernoulli;
 *   4. runs every G6 gate with the same crossed bootstrap the decision uses (fewer draws, `--boot-draws`).
 * Output: per scenario, the share of simulations where every gate passes (power) and each gate's pass rate; under the
 * null, the coverage of the pooled interval (should be near 95%) and the false pass rate of the pooled bar; under a
 * sparse-error scenario (false answers on unanswerable items set to `--sparse-rate`), the coverage of the
 * false-answer difference interval. Sizes may rise, never fall, before the freeze.
 *
 *   bun eval/runner/q2/power-sim.ts --receipts <a.json,b.json,...> --pairs 100 --ingests 3 --sims 200 [--effects 0,3,5] [--seed 20261006] --output <dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flagValue } from '../p5-agent.ts';
import { seededRandom } from '../stats/paired.ts';
import { g6Gates, crossedBootstrap, type AnswerRow } from './crossed-bootstrap.ts';
import { rowsFromReceipt } from '../write-then-answer.ts';

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (p: number) => Math.min(0.98, Math.max(0.02, p));

export interface PilotModel {
  corpora: string[];
  models: string[];
  pairs: Map<string, Array<{ pair: string; questions: Array<{ id: string; type: 'relational' | 'temporal'; answerable: boolean; p: Map<string, number> }> }>>;
  sigma: Map<string, number>;
}

/** Fit the simulation's inputs from pilot answer rows. */
export function fitPilot(rows: readonly AnswerRow[]): PilotModel {
  const scored = rows.filter(r => r.correct !== null);
  const corpora = [...new Set(scored.map(r => r.corpus))].sort();
  const models = [...new Set(scored.map(r => r.model))].sort();
  const pairs = new Map(corpora.map(c => {
    const qs = [...new Set(scored.filter(r => r.corpus === c).map(r => r.pair))].sort();
    return [c, qs.map(pair => ({ pair, questions: [...new Set(scored.filter(r => r.corpus === c && r.pair === pair).map(r => r.question))].sort().map(id => {
      const mine = scored.filter(r => r.corpus === c && r.question === id);
      const p = new Map<string, number>();
      for (const m of models) for (const a of ['A', 'B']) {
        const xs = mine.filter(r => r.model === m && r.arm === a);
        // Shrink toward the cell mean with one pseudo-observation, so a 0/2 or 2/2 question is not certain.
        const cell = scored.filter(r => r.corpus === c && r.model === m && r.arm === a);
        const prior = cell.length ? cell.reduce((s, r) => s + (r.correct as number), 0) / cell.length : 0.5;
        p.set(`${m}|${a}`, clamp((xs.reduce((s, r) => s + (r.correct as number), 0) + prior) / (xs.length + 1)));
      }
      return { id, type: mine[0].type, answerable: mine[0].answerable, p };
    }) }))];
  }));
  const sigma = new Map<string, number>();
  for (const c of corpora) for (const m of models) for (const a of ['A', 'B']) {
    const cell = scored.filter(r => r.corpus === c && r.model === m && r.arm === a);
    const ingests = [...new Set(cell.map(r => r.ingest))];
    const accs = ingests.map(i => { const xs = cell.filter(r => r.ingest === i); return { acc: xs.reduce((s, r) => s + (r.correct as number), 0) / xs.length, n: xs.length }; });
    if (accs.length < 2) { sigma.set(`${c}|${m}|${a}`, 0); continue; }
    const mean = accs.reduce((s, x) => s + x.acc, 0) / accs.length;
    const between = accs.reduce((s, x) => s + (x.acc - mean) ** 2, 0) / (accs.length - 1);
    const binom = accs.reduce((s, x) => s + clamp(mean) * (1 - clamp(mean)) / x.n, 0) / accs.length;
    const varAcc = Math.max(0, between - binom);
    const slope = clamp(mean) * (1 - clamp(mean));
    sigma.set(`${c}|${m}|${a}`, Math.sqrt(varAcc) / slope);
  }
  return { corpora, models, pairs, sigma };
}

/** Normal deviate (Box-Muller) from the shared seeded generator. */
function normal(rnd: () => number): number {
  const u = Math.max(1e-12, rnd()), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** One simulated experiment; arm B's accuracy logit shifted by `shift` (A untouched); B's false-answer rate optionally fixed. */
export function simulate(fit: PilotModel, o: { pairs: number; ingests: number; shift: number; seed: number; nullArms?: boolean; sparseRate?: number }): AnswerRow[] {
  const rnd = seededRandom(o.seed);
  const rows: AnswerRow[] = [];
  for (const c of fit.corpora) {
    const pool = fit.pairs.get(c)!;
    const drawn = Array.from({ length: o.pairs }, (_, k) => ({ src: pool[Math.floor(rnd() * pool.length)], key: `${c}-sim-p${k}` }));
    for (const m of fit.models) for (const arm of ['A', 'B'] as const) for (let i = 0; i < o.ingests; i++) {
      const u = normal(rnd) * (fit.sigma.get(`${c}|${m}|${arm}`) ?? 0);
      for (const d of drawn) for (const q of d.src.questions) {
        const base = o.nullArms ? q.p.get(`${m}|A`)! : q.p.get(`${m}|${arm}`)!;
        // On an unanswerable item a wrong response is a concrete (false) answer; the sparse scenario fixes that rate.
        const p = !q.answerable && o.sparseRate !== undefined ? 1 - o.sparseRate : sigmoid(logit(base) + u + (arm === 'B' ? o.shift : 0));
        const correct = rnd() < p ? 1 : 0;
        rows.push({ corpus: c, model: m, arm, ingest: i, pair: d.key, question: `${d.key}:${q.id}`, type: q.type, answerable: q.answerable, correct, false_answer: q.answerable ? 0 : 1 - correct });
      }
    }
  }
  return rows;
}

/** The logit shift on arm B that moves the pooled B − A to `points` (bisection on the expected pooled difference). */
export function shiftFor(fit: PilotModel, points: number): number {
  if (points === 0) return 0;
  const expected = (shift: number) => {
    let a = 0, b = 0, n = 0;
    for (const c of fit.corpora) for (const pr of fit.pairs.get(c)!) for (const q of pr.questions) for (const m of fit.models) {
      a += q.p.get(`${m}|A`)!; b += sigmoid(logit(q.p.get(`${m}|A`)!) + shift); n++;
    }
    return (b - a) / n;
  };
  let lo = -5, hi = 5;
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (expected(mid) < points / 100) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

export function powerTable(fit: PilotModel, o: { pairs: number; ingests: number; sims: number; effects: number[]; seed: number; bootDraws: number; sparseRate: number }) {
  const out: Record<string, unknown> = {};
  for (const e of o.effects) {
    const shift = shiftFor(fit, e);
    const passAll: number[] = [];
    const gatePass: Record<string, number> = {};
    let covered = 0;
    for (let s = 0; s < o.sims; s++) {
      const rows = simulate(fit, { pairs: o.pairs, ingests: o.ingests, shift, seed: o.seed + s * 7919 + e * 104_729, nullArms: e === 0 });
      const g = g6Gates(rows, { seed: o.seed + s, draws: o.bootDraws });
      passAll.push(g.gates.every(x => x.outcome === 'pass') ? 1 : 0);
      for (const x of g.gates) gatePass[x.gate] = (gatePass[x.gate] ?? 0) + (x.outcome === 'pass' ? 1 : 0);
      const ci = g.estimates.pooled.ci95;
      if (ci && ci[0] <= e / 100 && e / 100 <= ci[1]) covered++;
    }
    out[`effect_${e}_points`] = { logit_shift_on_B: shift, power_all_gates: passAll.reduce((a, b) => a + b, 0) / o.sims, gate_pass_rate: Object.fromEntries(Object.entries(gatePass).map(([k, v]) => [k, v / o.sims])), pooled_interval_coverage_of_true_effect: covered / o.sims };
  }
  let sparseCovered = 0;
  for (let s = 0; s < o.sims; s++) {
    const rows = simulate(fit, { pairs: o.pairs, ingests: o.ingests, shift: 0, seed: o.seed + 31 * s + 17, nullArms: true, sparseRate: o.sparseRate });
    const ci = crossedBootstrap(rows, { metric: 'false_answer', filter: r => !r.answerable, seed: o.seed + s, draws: o.bootDraws }).ci95;
    if (ci && ci[0] <= 0 && 0 <= ci[1]) sparseCovered++;
  }
  out.sparse_error_null = { false_answer_rate: o.sparseRate, interval_coverage_of_zero: sparseCovered / o.sims };
  return out;
}

async function main(argv: string[]): Promise<void> {
  const receipts = (flagValue(argv, '--receipts') ?? '').split(',').filter(Boolean);
  const output = flagValue(argv, '--output');
  if (!receipts.length || !output) throw new Error('usage: power-sim.ts --receipts <dev pilot receipts of both arms> --output <dir> [--pairs 100] [--ingests 3] [--sims 200] [--effects 0,3,5]');
  const rows = receipts.flatMap(rowsFromReceipt);
  const fit = fitPilot(rows);
  const o = { pairs: Number(flagValue(argv, '--pairs') ?? 100), ingests: Number(flagValue(argv, '--ingests') ?? 3), sims: Number(flagValue(argv, '--sims') ?? 200),
    effects: (flagValue(argv, '--effects') ?? '0,3,5').split(',').map(Number), seed: Number(flagValue(argv, '--seed') ?? 20261006), bootDraws: Number(flagValue(argv, '--boot-draws') ?? 1000), sparseRate: Number(flagValue(argv, '--sparse-rate') ?? 0.02) };
  const table = powerTable(fit, o);
  const report = { inputs: receipts, pilot: { answers: rows.length, corpora: fit.corpora, models: fit.models, pairs: Object.fromEntries(fit.corpora.map(c => [c, fit.pairs.get(c)!.length])), sigma_ingest_logit: Object.fromEntries(fit.sigma) }, matrix: { pairs_per_corpus: o.pairs, ingests: o.ingests, models: fit.models.length, arms: 2 }, settings: o, results: table,
    note: 'Sizes may rise, never fall, before the freeze; a raise goes into the freeze record with its cost.' };
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'power-sim.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.results, null, 2));
}

if (import.meta.main) main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(3); });
