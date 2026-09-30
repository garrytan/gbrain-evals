/**
 * Power analysis for the evidence-delivery decision rule (plan amendment 1).
 *
 * Seeded Monte Carlo over the exact decision code in decision.ts, with the
 * real confirmatory strata sizes and gold-evidence clusters. Only the
 * permutation and bootstrap draw counts are lowered (to `draws`) so the
 * simulation finishes; with about 400 clusters the smallest Monte Carlo
 * p-value is 1/(draws+1), far below the Holm threshold for six tests.
 *
 * Inputs are published measurements, never private data:
 *   page accuracy per stratum      R1 notes reader on the 400 confirmatory questions
 *   where chunks lose              the 2026-09-29 reranker-off c1 vs full-session gaps per stratum
 *   chunk-only correct rate        4 in 100 (c1 won 4 questions against full sessions)
 *   reader noise                   3% of concordant questions flip (R1 vs the reranker-off run
 *                                  disagreed on 11 of 100 with different retrieval, an upper bound)
 *   judge disagreement             1% of verdicts flip for the confirmation judge (the judges agreed on 490/500)
 * Chunk accuracy on reranker-on lists has never been measured, so it is a
 * scenario axis (0.65, 0.72, 0.80), as is the true closure fraction.
 */
import { seededRandom } from '../stats/paired.ts';
import { decideConfirmatory, decideE2, selectPilot, type ArmRows, type DecisionManifest, type OutcomeRow } from './decision.ts';

export interface Stratum { type: string; n: number; page: number; gapWeight: number }

/** Confirmatory strata: sizes and R1 page accuracy (docs/.../reranker-on/r1/rows.ndjson). */
export const CONFIRMATORY_STRATA: Stratum[] = [
  { type: 'single-session-user', n: 54, page: 52 / 54, gapWeight: 2 / 16 },
  { type: 'single-session-assistant', n: 44, page: 44 / 44, gapWeight: 0.02 },
  { type: 'single-session-preference', n: 25, page: 23 / 25, gapWeight: 0.02 },
  { type: 'multi-session', n: 112, page: 94 / 112, gapWeight: 11 / 21 },
  { type: 'temporal-reasoning', n: 110, page: 99 / 110, gapWeight: 8 / 23 },
  { type: 'knowledge-update', n: 55, page: 53 / 55, gapWeight: 3 / 23 },
];
/** Pilot strata sizes with R1 pilot page accuracy. */
export const PILOT_STRATA: Stratum[] = [
  { type: 'single-session-user', n: 16, page: 16 / 16, gapWeight: 2 / 16 },
  { type: 'single-session-assistant', n: 12, page: 12 / 12, gapWeight: 0.02 },
  { type: 'single-session-preference', n: 5, page: 4 / 5, gapWeight: 0.02 },
  { type: 'multi-session', n: 21, page: 16 / 21, gapWeight: 11 / 21 },
  { type: 'temporal-reasoning', n: 23, page: 19 / 23, gapWeight: 8 / 23 },
  { type: 'knowledge-update', n: 23, page: 21 / 23, gapWeight: 3 / 23 },
];

export const CHUNK_ONLY_RATE = 0.04;
export const READER_NOISE = 0.03;
export const JUDGE_FLIP = 0.01;

interface Latent { id: string; type: string; cluster: string; c: 0 | 1; p: 0 | 1 }

/** Per-stratum chunk accuracy so the overall chunk accuracy equals `chunkAcc`, with the gap spread by gapWeight. */
export function chunkRates(strata: Stratum[], chunkAcc: number): number[] {
  const n = strata.reduce((s, x) => s + x.n, 0);
  const pageAcc = strata.reduce((s, x) => s + x.n * x.page, 0) / n;
  const totalGap = pageAcc - chunkAcc;
  const w = strata.reduce((s, x) => s + x.n * x.gapWeight, 0) / n;
  return strata.map(x => Math.max(0, Math.min(x.page, x.page - totalGap * x.gapWeight / w)));
}

function latent(strata: Stratum[], chunkAcc: number, rng: () => number, clusters?: Map<number, string>): Latent[] {
  const rates = chunkRates(strata, chunkAcc);
  const out: Latent[] = [];
  let k = 0;
  strata.forEach((s, t) => {
    const pc = rates[t], pp = s.page;
    const b = Math.min(CHUNK_ONLY_RATE, 1 - pp, pc);
    for (let i = 0; i < s.n; i++, k++) {
      const u = rng();
      // both right: pc - b; chunk only: b; page only: pp - pc + b; neither: rest
      const c = u < pc ? 1 : 0;
      const p = u < pc - b ? 1 : u < pc ? 0 : u < pp + b ? 1 : 0;
      out.push({ id: `q${k}`, type: s.type, cluster: clusters?.get(k) ?? `q${k}`, c: c as 0 | 1, p: p as 0 | 1 });
    }
  });
  return out;
}

/** Candidate outcomes with expected closure `f` of the page - chunk gap. */
function candidate(qs: Latent[], f: number, rng: () => number): (0 | 1)[] {
  const n = qs.length;
  const a = qs.filter(q => q.p && !q.c).length / n, b = qs.filter(q => q.c && !q.p).length / n;
  const both = qs.filter(q => q.c && q.p).length / n, neither = qs.filter(q => !q.c && !q.p).length / n;
  const keepChunkOnly = 0.6;
  const fAdj = a > 0 ? Math.max(0, Math.min(1, (f * (a - b) + (1 - keepChunkOnly) * b - READER_NOISE * (neither - both)) / a)) : 0;
  return qs.map(q => {
    const u = rng();
    if (q.p && !q.c) return (u < fAdj ? 1 : 0);
    if (q.c && !q.p) return (u < keepChunkOnly ? 1 : 0);
    if (q.c && q.p) return (u < 1 - READER_NOISE ? 1 : 0);
    return (u < READER_NOISE ? 1 : 0);
  });
}

const flip = (x: 0 | 1, rng: () => number): 0 | 1 => (rng() < JUDGE_FLIP ? (1 - x) as 0 | 1 : x);
function rows(qs: Latent[], outcome: (0 | 1)[], tokens: number, rng: () => number): OutcomeRow[] {
  return qs.map((q, i) => ({ question_id: q.id, question_type: q.type, cluster: q.cluster, primary: outcome[i], confirmation: flip(outcome[i], rng), provider_input_tokens: tokens }));
}

export function simulationManifest(m: DecisionManifest, draws: number): DecisionManifest {
  const copy: DecisionManifest = JSON.parse(JSON.stringify(m));
  copy.confirmatory.success.sign_flip_draws = draws;
  copy.confirmatory.success.bootstrap_draws = draws;
  copy.e2.bootstrap_draws = draws;
  return copy;
}

export interface ConfirmatoryCell { chunk_accuracy: number; closure: number; sims: number; gap_established: number; closure_met: number; significance_met: number; per_type_met: number; success: number; mean_gap: number }

export function confirmatoryPower(m: DecisionManifest, opts: { chunkAcc: number; closure: number; sims: number; seed: number; draws: number; clusters?: Map<number, string> }): ConfirmatoryCell {
  const sm = simulationManifest(m, opts.draws);
  const rng = seededRandom(opts.seed);
  let est = 0, clo = 0, sig = 0, typ = 0, suc = 0, gapSum = 0;
  for (let s = 0; s < opts.sims; s++) {
    const qs = latent(CONFIRMATORY_STRATA, opts.chunkAcc, rng, opts.clusters);
    const w = candidate(qs, opts.closure, rng);
    const arms: ArmRows = { chunk: rows(qs, qs.map(q => q.c), 3400, rng), page: rows(qs, qs.map(q => q.p), 15500, rng), window1: rows(qs, w, 6500, rng) };
    const d = decideConfirmatory(sm, arms, qs.map(q => q.id), ['window1']);
    const c = d.candidates[0];
    gapSum += d.gap.value;
    est += d.gap.established ? 1 : 0;
    clo += c.closure_met ? 1 : 0;
    sig += c.significance_met ? 1 : 0;
    typ += c.per_type_met ? 1 : 0;
    suc += d.outcome === 'success' ? 1 : 0;
  }
  const r = (k: number) => Number((k / opts.sims).toFixed(4));
  return { chunk_accuracy: opts.chunkAcc, closure: opts.closure, sims: opts.sims, gap_established: r(est), closure_met: r(clo), significance_met: r(sig), per_type_met: r(typ), success: r(suc), mean_gap: Number((gapSum / opts.sims).toFixed(2)) };
}

export interface SelectionCell { chunk_accuracy: number; closures: number[]; sims: number; best_advanced: number; any_ge_0_6_advanced: number; top2_mean_true_closure: number }

/** Six candidates with fixed true closures on the 100-question pilot; how often does selection keep the good ones? */
export function selectionPower(m: DecisionManifest, opts: { chunkAcc: number; closures: number[]; sims: number; seed: number }): SelectionCell {
  const rng = seededRandom(opts.seed);
  const ids = m.family.candidates;
  let best = 0, good = 0, meanTop = 0;
  const bestIdx = opts.closures.indexOf(Math.max(...opts.closures));
  for (let s = 0; s < opts.sims; s++) {
    const qs = latent(PILOT_STRATA, opts.chunkAcc, rng);
    const arms: ArmRows = { chunk: rows(qs, qs.map(q => q.c), 3400, rng), page: rows(qs, qs.map(q => q.p), 15500, rng) };
    ids.forEach((id, i) => { arms[id] = rows(qs, candidate(qs, opts.closures[i], rng), 6000 + i, rng); });
    const sel = selectPilot(m, arms, qs.map(q => q.id));
    const idx = sel.advanced.map(a => ids.indexOf(a));
    best += idx.includes(bestIdx) ? 1 : 0;
    good += idx.some(i => opts.closures[i] >= 0.6) ? 1 : 0;
    meanTop += idx.reduce((acc, i) => acc + opts.closures[i], 0) / Math.max(1, idx.length);
  }
  const r = (k: number) => Number((k / opts.sims).toFixed(4));
  return { chunk_accuracy: opts.chunkAcc, closures: opts.closures, sims: opts.sims, best_advanced: r(best), any_ge_0_6_advanced: r(good), top2_mean_true_closure: r(meanTop) };
}

export interface E2Cell { chunk_accuracy: number; true_delta: number; persona_sd: number; reader_noise: number; sims: number; pass: number; reject: number; inconclusive: number }

/**
 * Sealed set: 30 personas x 5 questions. A persona-level shift on the logit
 * scale (sd `personaSd`) makes questions within a persona correlated.
 */
export function e2Power(m: DecisionManifest, opts: { chunkAcc: number; trueDelta: number; personaSd: number; noise: number; sims: number; seed: number; draws: number }): E2Cell {
  const sm = simulationManifest(m, opts.draws);
  const rng = seededRandom(opts.seed);
  const logit = (p: number) => Math.log(p / (1 - p));
  const inv = (x: number) => 1 / (1 + Math.exp(-x));
  const normal = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  let pass = 0, reject = 0, inc = 0;
  for (let s = 0; s < opts.sims; s++) {
    const chunk: OutcomeRow[] = [], winner: OutcomeRow[] = [];
    for (let p = 0; p < 30; p++) {
      const shift = normal() * opts.personaSd;
      const pc = inv(logit(opts.chunkAcc) + shift);
      const pw = Math.max(0, Math.min(1, pc + opts.trueDelta));
      for (let q = 0; q < 5; q++) {
        const u = rng();
        // shared latent draw: the two arms agree except where their rates differ, plus reader noise
        let c: 0 | 1 = u < pc ? 1 : 0, w: 0 | 1 = u < pw ? 1 : 0;
        if (rng() < opts.noise) c = (1 - c) as 0 | 1;
        if (rng() < opts.noise) w = (1 - w) as 0 | 1;
        const id = `p${p}q${q}`;
        chunk.push({ question_id: id, question_type: 'sealed', cluster: `p${p}`, primary: c, confirmation: flip(c, rng), provider_input_tokens: 2000 });
        winner.push({ question_id: id, question_type: 'sealed', cluster: `p${p}`, primary: w, confirmation: flip(w, rng), provider_input_tokens: 3000 });
      }
    }
    const d = decideE2(sm, chunk, winner);
    if (d.outcome === 'pass') pass++; else if (d.outcome === 'reject') reject++; else inc++;
  }
  const r = (k: number) => Number((k / opts.sims).toFixed(4));
  return { chunk_accuracy: opts.chunkAcc, true_delta: opts.trueDelta, persona_sd: opts.personaSd, reader_noise: opts.noise, sims: opts.sims, pass: r(pass), reject: r(reject), inconclusive: r(inc) };
}

export interface PowerReport {
  schema: 'gbrain-evals/evidence-delivery-power/v1';
  decision_manifest_sha256: string;
  seed: number;
  draws: number;
  assumptions: Record<string, unknown>;
  confirmatory: ConfirmatoryCell[];
  selection: SelectionCell[];
  e2: E2Cell[];
}

export function runPowerAnalysis(m: DecisionManifest, manifestSha: string, opts: { sims: number; selectionSims: number; e2Sims: number; seed: number; draws: number; clusters?: Map<number, string> }): PowerReport {
  const confirmatory: ConfirmatoryCell[] = [];
  let seed = opts.seed;
  for (const chunkAcc of [0.65, 0.72, 0.8]) {
    for (const closure of [0, 0.3, 0.5, 0.6, 0.7, 0.8, 1]) confirmatory.push(confirmatoryPower(m, { chunkAcc, closure, sims: opts.sims, seed: seed++, draws: opts.draws, clusters: opts.clusters }));
  }
  const selection: SelectionCell[] = [];
  for (const chunkAcc of [0.65, 0.72, 0.8]) {
    for (const closures of [[0.3, 0.4, 0.5, 0.6, 0.7, 0.8], [0.5, 0.5, 0.5, 0.5, 0.5, 0.7], [0.2, 0.3, 0.3, 0.4, 0.4, 0.6]]) selection.push(selectionPower(m, { chunkAcc, closures, sims: opts.selectionSims, seed: seed++ }));
  }
  const e2: E2Cell[] = [];
  for (const noise of [0.01, READER_NOISE]) {
    for (const chunkAcc of [0.8, 0.9]) {
      for (const trueDelta of [-0.05, -0.03, 0, 0.03, 0.05]) e2.push(e2Power(m, { chunkAcc, trueDelta, personaSd: 0.8, noise, sims: opts.e2Sims, seed: seed++, draws: opts.draws }));
    }
  }
  return {
    schema: 'gbrain-evals/evidence-delivery-power/v1', decision_manifest_sha256: manifestSha, seed: opts.seed, draws: opts.draws,
    assumptions: {
      page_accuracy: 'R1 per stratum on the 400 confirmatory questions (365/400 overall)',
      chunk_accuracy: 'scenario axis: 0.65, 0.72, 0.80 (reranker-on chunk delivery is unmeasured; reranker-off was 65/100)',
      gap_by_stratum: 'proportional to the 2026-09-29 c1 vs full-session gaps (multi-session and temporal carry most of it)',
      chunk_only_rate: CHUNK_ONLY_RATE, reader_noise: READER_NOISE, confirmation_judge_flip: JUDGE_FLIP,
      candidate_keeps_chunk_only_answers: 0.6,
      tokens: 'fixed per arm (chunk 3400, page 15500, candidate 6500), so the token rule never binds here; it is a separate point-estimate condition',
      clusters: opts.clusters ? 'real gold-evidence clusters of the confirmatory questions' : 'singletons',
      e2: '30 personas x 5 questions, persona random effect sd 0.8 on the logit scale, arms share each question\'s latent draw plus 1% or 3% reader noise each',
    },
    confirmatory, selection, e2,
  };
}
