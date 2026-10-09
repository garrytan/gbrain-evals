/**
 * E3 of the budgeted delivery plan, the C3 retrieval gate (preregistration
 * docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2-preregistration.md,
 * "E3"): session fusion against today's ranking, as strict recall of every gold
 * session in the top 5 and top 10 sessions, on the frozen ranked hit lists of
 * the E2 freeze cells. $0; no provider call.
 *
 *   today   distinct sessions in first-appearance order of the frozen list;
 *   fused   each session scored from all its hits in the list, sorted by
 *           score descending: S = h1 + 0.5 h2 + 0.25 h3 + ..., where h are the
 *           session's hit scores (gbrain's rerank score when every hit of the
 *           list carries one, else its fused search score), largest first;
 *           ties keep first-appearance order.
 *
 * Gate: on the LongMemEval-S slice, fused recall_all@5 non-inferior within
 * 1 point (95% interval of fused minus today above -1 point); on BEAM-100K dev,
 * superior (interval above 0). LoCoMo dev and the LongMemEval-S 500 are
 * reported, not gated.
 *
 *   bun eval/runner/budgeted-delivery/e3-retrieval-gate.ts --config <e3-config.json> [--out <file.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadCorpus } from '../memory-qa/corpus.ts';
import { recallAllAtK } from '../metrics.ts';
import { opaqueSourceId } from '../systems/sanitize.ts';
import { sourceOfSlug } from '../systems/gbrain.ts';
import { paired } from './e1-readings.ts';
import { sliceIds } from './e2-readings.ts';

type Row = Record<string, any>;
export const DAMPING = 0.5;
export const SLICE_NI_POINTS = 1;

/** Session order of a frozen list: first appearance (today) and the fused score order. */
export function sessionOrders(hits: ReadonlyArray<{ slug: string; rerank_score: number | null; score: number | null }>): { today: string[]; fused: string[]; scale: 'rerank' | 'score' } {
  const scale = hits.length && hits.every(h => typeof h.rerank_score === 'number') ? 'rerank' : 'score';
  const today: string[] = [];
  const scores = new Map<string, number[]>();
  for (const h of hits) {
    if (!today.includes(h.slug)) today.push(h.slug);
    scores.set(h.slug, [...(scores.get(h.slug) ?? []), Number((scale === 'rerank' ? h.rerank_score : h.score) ?? 0)]);
  }
  const fusedScore = (slug: string) => [...scores.get(slug)!].sort((a, b) => b - a).reduce((n, x, j) => n + x * DAMPING ** j, 0);
  const fused = today.map((slug, k) => ({ slug, k, s: fusedScore(slug) })).sort((a, b) => b.s - a.s || a.k - b.k).map(x => x.slug);
  return { today, fused, scale };
}

export interface E3Bench { benchmark: 'lme-s' | 'locomo' | 'beam-100k'; freeze: string[]; cluster: 'question' | 'conversation' }

/** Per question, today's and the fused recall_all@5 and @10 (questions without gold sessions are skipped). */
export function recallRows(b: E3Bench) {
  const corpus = loadCorpus(b.benchmark);
  const gold = new Map(corpus.questions.map(q => [q.id, q]));
  const session = new Map<string, string>();
  for (const c of corpus.conversations) for (const s of c.sessions) session.set(opaqueSourceId(c.id, s.id), s.id);
  const out: Array<{ id: string; conversation: string; scale: string; today5: number; today10: number; fused5: number; fused10: number }> = [];
  for (const p of b.freeze) for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Row;
    const id = String(r.question_id ?? String(r.id).split('|')[0]);
    const q = gold.get(id);
    const hits = r.accounting?.frozen?.rows as Row[] | undefined;
    if (!q || !hits || !q.gold.length) continue;
    const toSessions = (slugs: string[]) => slugs.map(s => session.get(sourceOfSlug(s) ?? '') ?? `?${s}`);
    const o = sessionOrders(hits as never);
    const rel = new Set(q.gold);
    const t = toSessions(o.today), f = toSessions(o.fused);
    out.push({ id, conversation: q.conversation, scale: o.scale, today5: recallAllAtK(t, rel, 5), today10: recallAllAtK(t, rel, 10), fused5: recallAllAtK(f, rel, 5), fused10: recallAllAtK(f, rel, 10) });
  }
  return out;
}

const asRows = (rows: ReturnType<typeof recallRows>, k: 'today5' | 'today10' | 'fused5' | 'fused10') => rows.map(r => ({ id: r.id, conversation: r.conversation, qa_score: r[k], outcome: 'scored' }));

export function compare(rows: ReturnType<typeof recallRows>, cluster: E3Bench['cluster']) {
  const at = (k: 5 | 10) => {
    const p = paired(asRows(rows, k === 5 ? 'today5' : 'today10'), asRows(rows, k === 5 ? 'fused5' : 'fused10'), cluster);
    return p ? { n: p.n, clusters: p.clusters, today: p.a, fused: p.b, delta_points: p.delta * 100, ci95_points: p.ci95 ? p.ci95.map(x => x * 100) : null, wins: p.wins, losses: p.losses } : null;
  };
  return { questions: rows.length, rerank_scale: rows.filter(r => r.scale === 'rerank').length, recall_all_at_5: at(5), recall_all_at_10: at(10) };
}

export function e3Gate(cfg: { benches: E3Bench[]; slice: { limit: number; seed: number } }) {
  const out: Record<string, ReturnType<typeof compare>> = {};
  for (const b of cfg.benches) {
    const rows = recallRows(b);
    if (b.benchmark === 'lme-s') {
      const slice = sliceIds(cfg.slice);
      out['lme-s-slice'] = compare(rows.filter(r => slice.has(r.id)), b.cluster);
      out['lme-s-500'] = compare(rows, b.cluster);
    } else out[b.benchmark] = compare(rows, b.cluster);
  }
  const sliceLow = out['lme-s-slice']?.recall_all_at_5?.ci95_points?.[0];
  const beamLow = out['beam-100k']?.recall_all_at_5?.ci95_points?.[0];
  const slicePass = typeof sliceLow === 'number' && sliceLow > -SLICE_NI_POINTS;
  const beamPass = typeof beamLow === 'number' && beamLow > 0;
  return { readings: out, gate: { slice_non_inferior: slicePass, beam_superior: beamPass, pass: slicePass && beamPass, qa_follow_up: slicePass && beamPass ? 'earned (separate approval)' : 'not earned' } };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const result = e3Gate(JSON.parse(readFileSync(one('--config')!, 'utf8')));
  const text = JSON.stringify(result, null, 2) + '\n';
  if (one('--out')) writeFileSync(one('--out')!, text);
  process.stdout.write(text);
}
