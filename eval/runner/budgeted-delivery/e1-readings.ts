/**
 * The budgeted delivery E1 readings (preregistration
 * docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1-preregistration.md):
 * arm scores, the reproduction band, readings 1 to 6 with cluster-bootstrap
 * intervals, and the per-arm delivery statistics, from the cells' canonical
 * rows. $0; no provider call.
 *
 *   bun eval/runner/budgeted-delivery/e1-readings.ts --config <readings-config.json> [--out <file.json>]
 *
 * The config names, per benchmark, the Cell A output, the Cell B deliver
 * output, the comparison's frozen gbrain arms and (LoCoMo) the facts probe.
 */
import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clusteredPairedDelta, pairObservations, type Observation } from '../stats/paired.ts';
import { crossSystemExclusion, PRODUCT_FAILURES, type Outcome } from '../memory-qa/outcomes.ts';

type Row = Record<string, any>;
const readRows = (path: string): Row[] => {
  if (!existsSync(path)) return [];
  const text = path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8');
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
};
const armRows = (cell: string, arm: string) => { const p = join(cell, 'arms', arm, 'rows.ndjson'); return existsSync(p) ? readRows(p) : readRows(`${p}.gz`); };

export interface BenchConfig { cell_a: string; cell_b: string; frozen_native: string; frozen_rehydrated: string; facts?: string; cluster: 'question' | 'conversation'; band_points: number }

/** One observation per question: the QA score, a product failure counted as 0, a harness failure ineligible. */
export function observations(rows: Row[], cluster: BenchConfig['cluster'], filter: (r: Row) => boolean = () => true): Observation[] {
  return rows.filter(filter).map(r => {
    const outcome = r.outcome as Outcome | undefined;
    const c = cluster === 'question' ? r.id : r.conversation;
    if (typeof r.qa_score === 'number' && (outcome === 'scored' || outcome === 'ingest_degraded' || outcome === undefined)) return { id: r.id, cluster: c, value: r.qa_score, eligible: true };
    if (outcome && PRODUCT_FAILURES.has(outcome)) return { id: r.id, cluster: c, value: 0, eligible: true };
    return { id: r.id, cluster: c, value: null, eligible: false, reason: `harness error: ${outcome ?? 'unknown'}` };
  });
}

export function serviceScore(rows: Row[], filter: (r: Row) => boolean = () => true) {
  const obs = observations(rows, 'question', filter).filter(o => o.eligible);
  return { score: obs.length ? obs.reduce((n, o) => n + (o.value ?? 0), 0) / obs.length : null, n: obs.length, incomplete: rows.filter(filter).length - obs.length };
}

/** Paired B minus A over the questions both arms hold, after the cross-arm harness exclusion. */
export function paired(a: Row[], b: Row[], cluster: BenchConfig['cluster'], filter: (r: Row) => boolean = () => true, seed = 20261008) {
  const ids = new Set(a.map(r => r.id).filter(id => b.some(r => r.id === id)));
  const keep = (r: Row) => ids.has(r.id) && filter(r);
  const ex = crossSystemExclusion({ a: observations(a, cluster, keep), b: observations(b, cluster, keep) });
  if (!ex.bySystem.a.some(o => o.eligible)) return null;
  const pairing = pairObservations(ex.bySystem.a, ex.bySystem.b);
  if (!pairing.pairs.length) return null;
  const d = clusteredPairedDelta(pairing.pairs, { seed, draws: 10000 });
  return { n: d.n_pairs, clusters: d.n_clusters, a: d.mean_a, b: d.mean_b, delta: d.delta, ci95: d.ci95, p_two_sided: d.p_two_sided, excluded: ex.excluded.length,
    wins: pairing.pairs.filter(p => p.b > p.a).length, losses: pairing.pairs.filter(p => p.b < p.a).length };
}

/** The comparison's frozen arm against its E1 reproduction: score difference and per-question agreement. */
export function reproduction(frozen: Row[], now: Row[], bandPoints: number) {
  const f = serviceScore(frozen), n = serviceScore(now);
  const byId = new Map(now.map(r => [r.id, r]));
  const both = frozen.filter(r => typeof r.qa_score === 'number' && typeof byId.get(r.id)?.qa_score === 'number');
  const agree = both.filter(r => Math.abs(r.qa_score - byId.get(r.id)!.qa_score) < 1e-9).length;
  const diff = f.score !== null && n.score !== null ? (n.score - f.score) * 100 : null;
  return { frozen: f.score, now: n.score, diff_points: diff, band_points: bandPoints, within_band: diff !== null && Math.abs(diff) <= bandPoints, agreement: both.length ? agree / both.length : null, compared: both.length };
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** Delivery statistics of one Cell B variant over the deliver rows. */
export function deliveryStats(retrievals: Row[], variant: string) {
  const recs = retrievals.map(r => r.accounting?.deliveries?.[variant]?.record).filter(Boolean);
  return { questions: recs.length, budget_tokens: recs[0]?.budget_tokens ?? null, budget_used_mean: mean(recs.map((r: Row) => r.budget_used)), over_budget: recs.filter((r: Row) => r.over_budget).length,
    overrun_mean: mean(recs.map((r: Row) => r.overrun_tokens)), blocks_mean: mean(recs.map((r: Row) => r.blocks)), whole_pages_mean: mean(recs.map((r: Row) => r.units?.page ?? 0)),
    spilled_blocks_mean: mean(recs.map((r: Row) => r.spilled_blocks)), hit_count_mean: mean(recs.map((r: Row) => r.hit_count)), sessions_in_mean: mean(recs.map((r: Row) => r.distinct_sessions_in)) };
}

export function contextStats(rows: Row[]) {
  const c = rows.map(r => r.qa_context).filter(Boolean);
  return { rows: c.length, tokens_mean: mean(c.map((x: Row) => x.tokens)), tokens_before_mean: mean(c.map((x: Row) => x.tokens_before ?? x.tokens)), cut_rows: c.filter((x: Row) => (x.items_cut ?? 0) > 0).length,
    items_cut_mean: mean(c.map((x: Row) => x.items_cut ?? 0)), reused: rows.filter(r => r.reused_from).length };
}

/** Questions where the frozen query list equals the same-length prefix of Cell A's list (by page and chunk text) and live parity held. */
export function deliveryOnlyQuestions(cellA: Row[], cellB: Row[]): Set<string> {
  const aById = new Map(cellA.map(r => [r.question_id ?? r.id.split('|')[0], r]));
  const out = new Set<string>();
  for (const b of cellB) {
    const qid = b.question_id ?? b.id.split('|')[0];
    const a = aById.get(qid);
    const fz = b.accounting?.frozen?.rows ?? [];
    if (!a || !b.accounting?.live?.parity?.equal) continue;
    const ai = (a.items ?? []).slice(0, fz.length);
    if (ai.length === fz.length && fz.every((h: Row, i: number) => ai[i].id.startsWith(`${h.slug}#`) && ai[i].text === h.chunk_text)) out.add(qid);
  }
  return out;
}

export function benchReadings(name: string, c: BenchConfig) {
  const A = (arm: string) => armRows(c.cell_a, arm), B = (arm: string) => armRows(c.cell_b, arm);
  const arms: Record<string, Row[]> = {};
  for (const [cell, get] of [[c.cell_a, A], [c.cell_b, B]] as const) {
    if (!existsSync(join(cell, 'arms'))) continue;
    for (const d of readdirSync(join(cell, 'arms'))) if (!d.endsWith('.retrieval')) arms[d] = get(d);
  }
  const key = (recipe: string, reader = 'main') => `fixed-evidence.${recipe}.b8000.${reader}`;
  const get = (recipe: string, reader = 'main') => arms[key(recipe, reader)] ?? [];
  const scores = Object.fromEntries(Object.entries(arms).map(([k, rows]) => [k, { ...serviceScore(rows), context: contextStats(rows) }]));
  const retrievalsB = readRows(join(c.cell_b, 'retrievals/rows.ndjson'));
  const retrievalsA = readRows(join(c.cell_a, 'retrievals/rows.ndjson'));
  const temporal = (r: Row) => ['temporal', 'temporal-reasoning', 'temporal_reasoning'].includes(r.category);
  const deliveryOnly = deliveryOnlyQuestions(retrievalsA, retrievalsB);
  const out: Record<string, unknown> = {
    benchmark: name, arms: scores,
    reproduction: { 'shootout-chunk': reproduction(readRows(c.frozen_native), get('native'), c.band_points), rehydrated: reproduction(readRows(c.frozen_rehydrated), get('rehydrated'), c.band_points),
      unreranked_cell_a_rows: retrievalsA.filter(r => r.accounting?.rerank_present === false).length, cell_a_rows: retrievalsA.length },
    reading1_date: { all: paired(get('chunk-undated-twin'), get('chunk-dated'), c.cluster), temporal: paired(get('chunk-undated-twin'), get('chunk-dated'), c.cluster, temporal) },
    reading2_product_path: { all: paired(get('chunk-dated'), get('query-auto'), c.cluster), delivery_only_questions: deliveryOnly.size,
      delivery_only: deliveryOnly.size ? paired(get('chunk-dated'), get('query-auto'), c.cluster, r => deliveryOnly.has(r.id)) : null },
    deliveries: Object.fromEntries(['auto-b_native', 'auto-b_pseudo', 'auto-default', 'auto-l5-b_pseudo'].map(v => [v, deliveryStats(retrievalsB, v)])),
    live_parity: { equal: retrievalsB.filter(r => r.accounting?.live?.parity?.equal).length, mismatch: retrievalsB.filter(r => r.accounting?.live?.parity && !r.accounting.live.parity.equal).length,
      fingerprint_equal: retrievalsB.filter(r => r.accounting?.live?.parity?.fingerprint_equal).length },
    frozen_list: { hits_mean: mean(retrievalsB.map(r => r.accounting?.frozen?.hit_count ?? 0)), sessions_mean: mean(retrievalsB.map(r => r.accounting?.frozen?.distinct_sessions ?? 0)),
      unreranked: retrievalsB.filter(r => r.accounting?.frozen?.rerank_present === false).length },
  };
  const sonnet = (r: string) => get(r, 'sonnet-5-5');
  if (sonnet('query-rehydrated').length) {
    const p = serviceScore(sonnet('query-auto-pseudo')).score ?? -1, l5 = serviceScore(sonnet('query-auto-l5-pseudo')).score ?? -1;
    const better = l5 > p ? 'query-auto-l5-pseudo' : 'query-auto-pseudo';
    out.reading3_depth = { a: { better_breadth_arm: better, delta: paired(sonnet(better), sonnet('query-rehydrated'), c.cluster), l5_vs_rehydrated: paired(sonnet('query-auto-l5-pseudo'), sonnet('query-rehydrated'), c.cluster) },
      b: paired(sonnet('chunk-dated-pseudo'), sonnet('rehydrated'), c.cluster) };
    out.reading4_rendering = paired(sonnet('query-auto-pseudo-as-native'), sonnet('query-auto-pseudo'), c.cluster);
  }
  if (get('query-auto-default').length) out.reading5_as_shipped = { ...serviceScore(get('query-auto-default')), context: contextStats(get('query-auto-default')) };
  if (c.facts) {
    const facts = readRows(c.facts);
    out.reading6_facts = { ...serviceScore(facts), facts_tokens_mean: mean(facts.map(r => r.qa_facts_tokens).filter((x: unknown) => typeof x === 'number')), facts_per_question: mean(facts.map(r => r.qa_facts ?? 0)) };
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const cfg = JSON.parse(readFileSync(one('--config')!, 'utf8')) as Record<string, BenchConfig>;
  const result = Object.fromEntries(Object.entries(cfg).map(([b, c]) => [b, benchReadings(b, c)]));
  const text = JSON.stringify(result, null, 2) + '\n';
  if (one('--out')) writeFileSync(one('--out')!, text);
  process.stdout.write(text);
}
