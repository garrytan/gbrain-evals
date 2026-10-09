/**
 * Q2 G6 inference: a crossed bootstrap over question pairs and ingest brains.
 *
 * One draw resamples, within each corpus stratum, the question pairs with replacement, the same draw shared by every
 * model and both arms; and, independently, within each corpus × model × arm cell, the ingest brains with
 * replacement, each brain carrying all its answers. A statistic is a difference of arm means (B − A) over the drawn
 * answers. The interval is the two-sided 95% percentile interval.
 *
 * G6 bars (preregistration): pooled B − A >= +3 points with lower bound > 0; per model, lower bound > −3 points; per
 * question type (relational, temporal), lower bound > −2 points; on unanswerable items, the upper bound of the
 * false-answer rate difference (B − A) < +2 points.
 */
import { seededRandom } from '../stats/paired.ts';
import type { GateOutcome } from '../receipt.ts';

export interface AnswerRow { corpus: string; model: string; arm: 'A' | 'B'; ingest: number; pair: string; question: string; type: 'relational' | 'temporal'; answerable: boolean; correct: number | null; false_answer: number | null }

export interface CrossedResult { point: number | null; ci95: [number, number] | null; n_answers: number; draws: number }

type Filter = (r: AnswerRow) => boolean;

interface Prepared { corpora: string[]; pairs: Map<string, string[]>; cells: Array<{ corpus: string; model: string; arm: 'A' | 'B'; ingests: number[]; sums: Map<string, Map<number, { s: number; n: number }>> }> }

/** Per cell, per pair, per ingest: sum and count of the metric over the filtered rows. */
function prepare(rows: readonly AnswerRow[], metric: 'correct' | 'false_answer', filter: Filter): Prepared {
  const used = rows.filter(r => filter(r) && typeof r[metric] === 'number');
  const corpora = [...new Set(rows.map(r => r.corpus))].sort();
  const pairs = new Map(corpora.map(c => [c, [...new Set(rows.filter(r => r.corpus === c).map(r => r.pair))].sort()]));
  const cellKeys = [...new Set(rows.map(r => `${r.corpus}\u0000${r.model}\u0000${r.arm}`))].sort();
  const cells = cellKeys.map(k => {
    const [corpus, model, arm] = k.split('\u0000') as [string, string, 'A' | 'B'];
    const mine = used.filter(r => r.corpus === corpus && r.model === model && r.arm === arm);
    const ingests = [...new Set(rows.filter(r => r.corpus === corpus && r.model === model && r.arm === arm).map(r => r.ingest))].sort((a, b) => a - b);
    const sums = new Map<string, Map<number, { s: number; n: number }>>();
    for (const r of mine) {
      const byIngest = sums.get(r.pair) ?? sums.set(r.pair, new Map()).get(r.pair)!;
      const c = byIngest.get(r.ingest) ?? { s: 0, n: 0 };
      c.s += r[metric] as number; c.n++;
      byIngest.set(r.ingest, c);
    }
    return { corpus, model, arm, ingests, sums };
  });
  return { corpora, pairs, cells };
}

function armDiff(p: Prepared, pairWeight: Map<string, Map<string, number>>, ingestWeight: (cellIndex: number) => Map<number, number>): number | null {
  const tot = { A: { s: 0, n: 0 }, B: { s: 0, n: 0 } };
  p.cells.forEach((cell, ci) => {
    const iw = ingestWeight(ci);
    const pw = pairWeight.get(cell.corpus)!;
    for (const [pair, w] of pw) {
      const byIngest = cell.sums.get(pair);
      if (!byIngest || !w) continue;
      for (const [ing, m] of iw) { const c = byIngest.get(ing); if (c && m) { tot[cell.arm].s += w * m * c.s; tot[cell.arm].n += w * m * c.n; } }
    }
  });
  if (!tot.A.n || !tot.B.n) return null;
  return tot.B.s / tot.B.n - tot.A.s / tot.A.n;
}

/** B − A of `metric` over rows passing `filter`, with the crossed bootstrap interval. */
export function crossedBootstrap(rows: readonly AnswerRow[], o: { metric?: 'correct' | 'false_answer'; filter?: Filter; seed: number; draws: number }): CrossedResult {
  const metric = o.metric ?? 'correct';
  const p = prepare(rows, metric, o.filter ?? (() => true));
  const unit = new Map(p.corpora.map(c => [c, new Map(p.pairs.get(c)!.map(x => [x, 1]))]));
  const point = armDiff(p, unit, ci => new Map(p.cells[ci].ingests.map(i => [i, 1])));
  const n = p.cells.reduce((a, c) => a + [...c.sums.values()].reduce((b, m) => b + [...m.values()].reduce((x, y) => x + y.n, 0), 0), 0);
  if (point === null) return { point: null, ci95: null, n_answers: n, draws: 0 };
  const rnd = seededRandom(o.seed);
  const out: number[] = [];
  for (let d = 0; d < o.draws; d++) {
    const pw = new Map(p.corpora.map(c => {
      const list = p.pairs.get(c)!;
      const w = new Map<string, number>();
      for (let i = 0; i < list.length; i++) { const k = list[Math.floor(rnd() * list.length)]; w.set(k, (w.get(k) ?? 0) + 1); }
      return [c, w];
    }));
    const iw = p.cells.map(cell => {
      const w = new Map<number, number>();
      for (let i = 0; i < cell.ingests.length; i++) { const k = cell.ingests[Math.floor(rnd() * cell.ingests.length)]; w.set(k, (w.get(k) ?? 0) + 1); }
      return w;
    });
    const v = armDiff(p, pw, ci => iw[ci]);
    if (v !== null) out.push(v);
  }
  out.sort((a, b) => a - b);
  return { point, ci95: out.length ? [out[Math.floor(out.length * 0.025)], out[Math.max(0, Math.ceil(out.length * 0.975) - 1)]] : null, n_answers: n, draws: out.length };
}

export interface G6Result { gates: GateOutcome[]; estimates: Record<string, CrossedResult> }

/** Every G6 gate from the answer rows of both arms. */
export function g6Gates(rows: readonly AnswerRow[], o: { seed: number; draws: number; models?: readonly string[] }): G6Result {
  const models = o.models ?? [...new Set(rows.map(r => r.model))].sort();
  const missing = rows.filter(r => r.correct === null).length;
  const d = { planned: rows.length, attempted: rows.length, scored: rows.length - missing, errors: missing };
  const est: Record<string, CrossedResult> = {};
  const gates: GateOutcome[] = [];
  const blocked = missing ? { outcome: 'not_run' as const, reason: `${missing} answer(s) lack a judgment; resume the judge phase` } : null;
  const pooled = (est.pooled = crossedBootstrap(rows, o));
  const pooledOk = pooled.point !== null && pooled.ci95 !== null && pooled.point >= 0.03 && pooled.ci95[0] > 0;
  gates.push({ gate: 'G6.pooled', ...(blocked ?? { outcome: pooledOk ? 'pass' : 'fail' }), threshold: 'pooled B − A >= +3 points with 95% lower bound > 0', observed: pooled.point, denominators: d,
    ...(!blocked && !pooledOk ? { failed_threshold: `B − A ${fmt(pooled.point)} [${fmt(pooled.ci95?.[0])}, ${fmt(pooled.ci95?.[1])}] vs >= +0.03 and lower > 0` } : {}) });
  for (const m of models) {
    const r = (est[`model:${m}`] = crossedBootstrap(rows, { ...o, filter: x => x.model === m }));
    const ok = r.ci95 !== null && r.ci95[0] > -0.03;
    gates.push({ gate: `G6.model.${m}`, ...(blocked ?? { outcome: ok ? 'pass' : 'fail' }), threshold: 'per model: 95% lower bound of B − A > −3 points', observed: r.point, denominators: d, ...(!blocked && !ok ? { failed_threshold: `lower ${fmt(r.ci95?.[0])} <= −0.03` } : {}) });
  }
  for (const t of ['relational', 'temporal'] as const) {
    const r = (est[`type:${t}`] = crossedBootstrap(rows, { ...o, filter: x => x.type === t }));
    const ok = r.ci95 !== null && r.ci95[0] > -0.02;
    gates.push({ gate: `G6.type.${t}`, ...(blocked ?? { outcome: ok ? 'pass' : 'fail' }), threshold: 'per question type: 95% lower bound of B − A > −2 points', observed: r.point, denominators: d, ...(!blocked && !ok ? { failed_threshold: `lower ${fmt(r.ci95?.[0])} <= −0.02` } : {}) });
  }
  const fa = (est.unanswerable_false_answer = crossedBootstrap(rows, { ...o, metric: 'false_answer', filter: x => !x.answerable }));
  const faOk = fa.ci95 !== null && fa.ci95[1] < 0.02;
  const unans = rows.filter(r => !r.answerable).length;
  gates.push({ gate: 'G6.unanswerable_false_answers', ...(blocked ?? (unans ? { outcome: faOk ? 'pass' : 'fail' } : { outcome: 'insufficient' })), threshold: 'unanswerable items: 95% upper bound of the false-answer rate difference (B − A) < +2 points', observed: fa.point,
    denominators: { planned: unans, attempted: unans, scored: unans - rows.filter(r => !r.answerable && r.correct === null).length, errors: rows.filter(r => !r.answerable && r.correct === null).length },
    ...(!blocked && unans && !faOk ? { failed_threshold: `upper ${fmt(fa.ci95?.[1])} >= +0.02` } : {}), ...(!blocked && !unans ? { failed_threshold: 'no unanswerable items' } : {}) });
  for (const c of [...new Set(rows.map(r => r.corpus))].sort()) est[`corpus:${c}`] = crossedBootstrap(rows, { ...o, filter: x => x.corpus === c });
  return { gates, estimates: est };
}

const fmt = (x: number | null | undefined) => (typeof x === 'number' ? x.toFixed(4) : 'n/a');
