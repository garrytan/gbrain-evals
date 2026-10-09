/**
 * The budgeted delivery E2 readings (preregistration
 * docs/benchmarks/2026-10-09-gbrain-budgeted-delivery-e2-preregistration.md):
 * every packing against `off` and `cap_only` on the LongMemEval-S 500 as raw
 * paired intervals, guards 1 to 9, the LoCoMo and BEAM descriptive tables, the
 * slice references (window, five hits, the 16,000-token sweep, the native link,
 * C5 rank order), the frontier reader check and the dev rule's choice. $0; it
 * reads the cells' canonical rows and makes no provider call.
 *
 *   bun eval/runner/budgeted-delivery/e2-readings.ts --config <readings-config.json> [--out <file.json>]
 *
 * The config names, per benchmark, the deliver cell directories (shards are
 * merged), and for LongMemEval-S the live cell directories.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorpus } from '../memory-qa/corpus.ts';
import { devConversations } from '../decisions/splits.ts';
import { selectQuestions } from '../memory-qa/run-systems.ts';
import { percentile } from '../metrics.ts';
import { contextStats, paired, serviceScore } from './e1-readings.ts';

type Row = Record<string, any>;
export const PACKINGS = ['off', 'cap_only', 'breadth_capped', 'depth_first'] as const;
export const CANDIDATES = ['cap_only', 'breadth_capped', 'depth_first'] as const;
type Candidate = typeof CANDIDATES[number];
/** The counted frontier readers of the reader check (Fable is smoke-only, Garry 2026-10-07). */
export const FRONTIER = [{ id: 'sonnet-5-5', model: 'anthropic:claude-sonnet-5-5' }, { id: 'opus-5-5', model: 'anthropic:claude-opus-5-5' }, { id: 'gpt-6-1-sol', model: 'openai:gpt-6.1-sol' }] as const;
export const LIVE_LATENCY_LIMIT = 1.2;
export const DESCRIPTIVE_LOSS_POINTS = 3;

export interface E2Config {
  'lme-s': { cells: string[]; live: string[]; slice: { limit: number; seed: number } };
  locomo?: { cells: string[] };
  'beam-100k'?: { cells: string[] };
}

const readNdjson = (p: string): Row[] => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
/** An arm's canonical rows across shard cells. */
export const armRows = (cells: string[], arm: string): Row[] => cells.flatMap(c => readNdjson(join(c, 'arms', arm, 'rows.ndjson')));
/** The canonical retrieval rows across shard cells. */
export const retrievalRows = (cells: string[]): Row[] => cells.flatMap(c => readNdjson(join(c, 'retrievals', 'rows.ndjson')));
const arm = (context: string, reader: string) => `fixed-evidence.${context}.b8000.${reader}`;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** Guard 7: per question kind, the paired change in questions; a kind fails when it drops by more than max(1, 2% of the kind). */
export function kindGuard(base: Row[], cand: Row[]) {
  const byId = new Map(cand.map(r => [r.id, r]));
  const kinds: Record<string, { n: number; base: number; cand: number; delta_questions: number; threshold: number; pass: boolean }> = {};
  for (const r of base) {
    const c = byId.get(r.id);
    if (!c || typeof r.qa_score !== 'number' || typeof c.qa_score !== 'number') continue;
    const k = (kinds[r.category] ??= { n: 0, base: 0, cand: 0, delta_questions: 0, threshold: 0, pass: true });
    k.n++; k.base += r.qa_score; k.cand += c.qa_score;
  }
  for (const k of Object.values(kinds)) {
    k.delta_questions = Math.round((k.cand - k.base) * 1000) / 1000;
    k.threshold = Math.max(1, 0.02 * k.n);
    k.pass = k.delta_questions >= -k.threshold - 1e-9;
  }
  return { kinds, pass: Object.values(kinds).every(k => k.pass) };
}

/** Guard 3 and the packing receipt: every candidate delivery within its explicit budget, reporting the packing it ran. */
export function capGuard(retrievals: Row[], variant: string, packing: string) {
  const recs = retrievals.map(r => r.accounting?.deliveries?.[variant]?.record).filter(Boolean) as Row[];
  const over = recs.filter(r => !(typeof r.budget_used === 'number' && typeof r.budget_tokens === 'number' && r.budget_used <= r.budget_tokens));
  const wrong = recs.filter(r => (packing === 'off' ? r.auto_packing !== null : r.auto_packing !== packing) || r.budget_explicit !== true);
  return { questions: recs.length, over_budget: over.length, wrong_packing_or_implicit_budget: wrong.length, pass: recs.length === retrievals.length && over.length === 0 && wrong.length === 0 };
}

/** Guard 4: every reader context of the arm fits its harness budget with zero packer cuts. */
export function contextGuard(rows: Row[], harnessBudget: number) {
  const c = rows.map(r => r.qa_context).filter(Boolean) as Row[];
  const bad = c.filter(x => (x.items_cut ?? 0) > 0 || (x.tokens_before ?? x.tokens) > harnessBudget);
  return { rows: c.length, cut_or_over: bad.length, pass: c.length === rows.length && bad.length === 0 };
}

/** Delivered and packed gold-session coverage (guard 5's reported metrics), over questions with gold. */
export function coverage(rows: Row[]) {
  const g = rows.map(r => r.qa_context?.gold).filter((x: Row | undefined) => x && x.count > 0) as Row[];
  return { questions: g.length, offered_all: g.filter(x => x.offered === x.count).length, packed_all: g.filter(x => x.packed === x.count).length,
    offered_share: mean(g.map(x => x.offered / x.count)), packed_share: mean(g.map(x => x.packed / x.count)) };
}

/** Delivery statistics of one deliver-cell variant. */
export function deliveryStats(retrievals: Row[], variant: string) {
  const recs = retrievals.map(r => r.accounting?.deliveries?.[variant]?.record).filter(Boolean) as Row[];
  const drops: Record<string, number> = {};
  for (const r of recs) for (const [k, v] of Object.entries(r.dropped_reasons ?? {})) drops[k] = (drops[k] ?? 0) + Number(v);
  return { questions: recs.length, budget_tokens: recs[0]?.budget_tokens ?? null, budget_used_mean: mean(recs.map(r => r.budget_used)), over_budget: recs.filter(r => r.over_budget).length,
    blocks_mean: mean(recs.map(r => r.blocks)), whole_pages_mean: mean(recs.map(r => r.units?.page ?? 0)), spilled_blocks_mean: mean(recs.map(r => r.spilled_blocks)),
    sessions_out_mean: mean(recs.map(r => r.distinct_sessions_out)), dropped_reasons_total: drops };
}

/** Guard 1 over deliver rows: without an explicit budget every packing's delivered bytes equal `off`'s. */
export function guard1(retrievals: Row[]) {
  const recs = retrievals.map(r => r.accounting?.guard1).filter(Boolean) as Row[];
  return { questions: recs.length, equal: recs.filter(g => g.equal).length, pass: recs.length === retrievals.length && recs.every(g => g.equal) };
}

/** Guard 9 and the live checks: handler p95 per packing (reranker time inside and separated), and every live call's receipt. */
export function liveReadings(live: Row[]) {
  const calls = live.flatMap(r => (r.accounting?.live_checks ?? []) as Row[]);
  const per: Record<string, Row> = {};
  for (const p of PACKINGS) {
    const c = calls.filter(x => x.packing === p);
    const svc = c.map(x => Number(x.service_ms)), net = c.map(x => Number(x.rerank?.ms ?? 0)), rest = c.map(x => Number(x.handler_minus_rerank_ms));
    per[p] = { calls: c.length, handler_p50_ms: percentile(svc, 50), handler_p95_ms: percentile(svc, 95), rerank_p95_ms: percentile(net, 95), handler_minus_rerank_p95_ms: percentile(rest, 95),
      rerank_calls_mean: mean(c.map(x => Number(x.rerank?.calls ?? 0))),
      packing_reported_ok: c.filter(x => (p === 'off' ? x.auto_packing_reported === null : x.auto_packing_reported === p) && x.config_read_back === p).length,
      parity_fresh_equal: c.filter(x => x.parity_fresh?.equal).length, parity_frozen_equal: c.filter(x => x.parity_frozen?.equal).length,
      over_budget: c.filter(x => x.over_budget).length };
  }
  const guard9: Record<string, Row> = {};
  for (const p of CANDIDATES) {
    const ratio = per[p].handler_p95_ms / per.off.handler_p95_ms;
    guard9[p] = { ratio, ratio_without_rerank: per[p].handler_minus_rerank_p95_ms / per.off.handler_minus_rerank_p95_ms, pass: Number.isFinite(ratio) && ratio <= LIVE_LATENCY_LIMIT };
  }
  return { questions: live.length, frozen_list_equal: live.filter(r => r.accounting?.frozen_list_equal).length, per_packing: per, guard9 };
}

/** The reader check: a reader's slice gain changes sign when it is below zero while the primary gain is above zero (or the reverse). */
export function readerCheck(primaryDelta: number, perReader: Record<string, { delta: number } | null>) {
  const changed = Object.entries(perReader).filter(([, d]) => d && (primaryDelta > 0 ? d.delta < 0 : primaryDelta < 0 ? d.delta > 0 : false)).map(([k]) => k);
  const missing = Object.entries(perReader).filter(([, d]) => !d).map(([k]) => k);
  return { sign_changes: changed, missing, pass: missing.length ? null : changed.length < 2 };
}

/**
 * The dev rule: among candidates whose primary interval against `off` is above zero, that pass every guard, have no
 * descriptive loss above 3 points and pass the reader check, the highest primary point estimate goes to H1. A pending
 * reader check (phase 1) names the frontier candidate instead: the same rule without the reader check.
 */
export function devRule(c: Record<Candidate, { delta: number; ci_low: number; guards_pass: boolean; descriptive_pass: boolean; reader_pass: boolean | null }>) {
  const eligible = CANDIDATES.filter(v => c[v].ci_low > 0 && c[v].guards_pass && c[v].descriptive_pass).sort((a, b) => c[b].delta - c[a].delta);
  const frontierCandidate = eligible[0] ?? [...CANDIDATES].sort((a, b) => c[b].delta - c[a].delta)[0];
  const decided = eligible.filter(v => c[v].reader_pass === true);
  const pending = eligible.some(v => c[v].reader_pass === null);
  return { eligible_before_reader_check: eligible, frontier_candidate: frontierCandidate, frontier_candidate_qualifies: eligible.length > 0,
    choice: pending && !decided.length ? null : decided[0] ?? null, verdict: pending && !decided.length ? 'pending reader check' : decided.length ? 'pass' : 'inconclusive' };
}

export function sliceIds(slice: { limit: number; seed: number }): Set<string> {
  const corpus = loadCorpus('lme-s');
  const dev = devConversations('lme-s');
  return new Set(selectQuestions(corpus.questions.filter(q => !dev || dev.has(q.conversation)), slice.limit, slice.seed).map(q => q.id));
}

const delta = (p: ReturnType<typeof paired>) => p ? { n: p.n, a: p.a, b: p.b, delta_points: p.delta * 100, ci95_points: p.ci95 ? p.ci95.map(x => x * 100) : null, p_two_sided: p.p_two_sided, wins: p.wins, losses: p.losses, excluded: p.excluded } : null;

export function e2Readings(cfg: E2Config) {
  const L = cfg['lme-s'];
  const R = retrievalRows(L.cells);
  const S = (ctx: string) => armRows(L.cells, arm(ctx, 'sonnet-5-5'));
  const slice = sliceIds(L.slice);
  const inSlice = (r: Row) => slice.has(r.id);
  const off = S('pseudo-off');
  const armNames = [...new Set(L.cells.flatMap(c => existsSync(join(c, 'arms')) ? readdirSync(join(c, 'arms')).filter(d => !d.endsWith('.retrieval')) : []))].sort();
  const arms = Object.fromEntries(armNames.map(a => { const rows = armRows(L.cells, a); return [a, { ...serviceScore(rows), context: contextStats(rows), coverage: coverage(rows) }]; }));

  const primary: Record<string, Row> = {};
  for (const v of [...CANDIDATES, 'off-l5'] as const) {
    const rows = S(`pseudo-${v}`);
    primary[v] = { vs_off: delta(paired(off, rows, 'question')), vs_cap_only: v === 'cap_only' ? null : delta(paired(S('pseudo-cap_only'), rows, 'question')) };
  }
  const descriptive: Record<string, Row> = {};
  for (const b of ['locomo', 'beam-100k'] as const) {
    const cells = cfg[b]?.cells;
    if (!cells?.length) continue;
    const r = retrievalRows(cells);
    const get = (v: string) => armRows(cells, arm(`pseudo-${v}`, 'sonnet-5-5'));
    descriptive[b] = { scores: Object.fromEntries(PACKINGS.map(p => [p, serviceScore(get(p))])),
      vs_off: Object.fromEntries(CANDIDATES.map(v => [v, delta(paired(get('off'), get(v), 'conversation'))])),
      vs_cap_only: Object.fromEntries(['breadth_capped', 'depth_first'].map(v => [v, delta(paired(get('cap_only'), get(v), 'conversation'))])),
      guard1: guard1(r), cap: Object.fromEntries(CANDIDATES.map(v => [v, capGuard(r, `${v}-b_pseudo`, v)])),
      contexts: Object.fromEntries(CANDIDATES.map(v => [v, contextGuard(get(v), 8000)])), deliveries: Object.fromEntries(PACKINGS.map(p => [p, deliveryStats(r, `${p}-b_pseudo`)])),
      kinds: Object.fromEntries(CANDIDATES.map(v => [v, kindGuard(get('off'), get(v)).kinds])) };
  }
  const live = liveReadings(retrievalRows(L.live));
  const abst = (r: Row) => r.abstention === true;

  const guards: Record<string, Row> = {};
  const g1all = [guard1(R), ...Object.values(descriptive).map(d => d.guard1)];
  for (const v of CANDIDATES) {
    const rows = S(`pseudo-${v}`);
    const g = {
      g1_compatibility: { lme_s: g1all[0], pass: g1all.every(x => x.pass) },
      g3_product_cap: capGuard(R, `${v}-b_pseudo`, v),
      g4_reader_context: contextGuard(rows, 8000),
      g5_retrieval_invariance: { frozen_lists_shared: true, note: 'every arm reads the same frozen hit list row; delivered and packed gold coverage are reported, not gated' },
      g6_default_budget: { exact_by_guard1: g1all.every(x => x.pass) },
      g7_kinds: kindGuard(off, rows),
      g8_abstention: (() => { const p = paired(off, rows, 'question', abst); return { ...delta(p), pass: p ? p.b >= p.a - 1e-9 : false }; })(),
      g9_latency: live.guard9[v],
    };
    guards[v] = { ...g, pass: g.g1_compatibility.pass && g.g3_product_cap.pass && g.g4_reader_context.pass && g.g6_default_budget.exact_by_guard1 && g.g7_kinds.pass && g.g8_abstention.pass && !!g.g9_latency?.pass };
  }

  const sliceRefs = {
    'pseudo-window': delta(paired(off.filter(inSlice), armRows(L.cells, arm('pseudo-window', 'sonnet-5-5-slice')), 'question')),
    sweep16: Object.fromEntries(PACKINGS.map(p => [p, { score: serviceScore(armRows(L.cells, arm(`sweep16-${p}`, 'sonnet-5-5-slice'))),
      vs_off16: p === 'off' ? null : delta(paired(armRows(L.cells, arm('sweep16-off', 'sonnet-5-5-slice')), armRows(L.cells, arm(`sweep16-${p}`, 'sonnet-5-5-slice')), 'question')),
      vs_same_packing_8k: delta(paired(S(`pseudo-${p}`).filter(inSlice), armRows(L.cells, arm(`sweep16-${p}`, 'sonnet-5-5-slice')), 'question')) }])),
    sweep16_contexts: Object.fromEntries(CANDIDATES.map(v => [v, contextGuard(armRows(L.cells, arm(`sweep16-${v}`, 'sonnet-5-5-slice')), 16000)])),
  };

  const cand = Object.fromEntries(CANDIDATES.map(v => [v, {
    delta: primary[v].vs_off?.delta_points ?? -Infinity, ci_low: primary[v].vs_off?.ci95_points?.[0] ?? -Infinity, guards_pass: guards[v].pass,
    descriptive_pass: Object.values(descriptive).every(d => (d.vs_off[v]?.delta_points ?? 0) >= -DESCRIPTIVE_LOSS_POINTS), reader_pass: null as boolean | null }])) as Parameters<typeof devRule>[0];

  const frontier: Record<string, Row> = {};
  for (const v of CANDIDATES) {
    const perReader: Record<string, { delta: number } | null> = {};
    const detail: Record<string, Row | null> = {};
    for (const f of FRONTIER) {
      const a = f.id === 'sonnet-5-5' ? off.filter(inSlice) : armRows(L.cells, arm('pseudo-off', f.id));
      const b = f.id === 'sonnet-5-5' ? S(`pseudo-${v}`).filter(inSlice) : armRows(L.cells, arm(`pseudo-${v}`, f.id));
      const p = a.length && b.length ? delta(paired(a, b, 'question')) : null;
      detail[f.id] = p;
      perReader[f.id] = p ? { delta: p.delta_points } : null;
    }
    if (Object.values(perReader).some(x => x) && Object.entries(perReader).some(([k, x]) => k !== 'sonnet-5-5' && x)) {
      const check = readerCheck(cand[v].delta, perReader);
      frontier[v] = { readers: detail, ...check, fable_smoke: delta(paired(armRows(L.cells, arm('pseudo-off', 'fable-5-1-smoke')), armRows(L.cells, arm(`pseudo-${v}`, 'fable-5-1-smoke')), 'question')),
        native_link_gpt4o: delta(paired(armRows(L.cells, arm('native-off', 'gpt-4o')), armRows(L.cells, arm(`native-${v}`, 'gpt-4o')), 'question')),
        c5_rank_order: delta(paired(S(`pseudo-${v}`).filter(inSlice), armRows(L.cells, arm(`rank-${v}`, 'sonnet-5-5-slice')), 'question')) };
      cand[v].reader_pass = check.pass;
    }
  }

  return {
    'lme-s': { questions: R.length, slice_questions: slice.size, arms, primary, guards, deliveries: Object.fromEntries(Object.keys(R[0]?.accounting?.deliveries ?? {}).map(k => [k, deliveryStats(R, k)])),
      multi_session_expectation: Object.fromEntries(CANDIDATES.map(v => [v, guards[v].g7_kinds.kinds['multi-session'] ?? null])), live, slice_refs: sliceRefs, frontier },
    descriptive, dev_rule: { candidates: cand, ...devRule(cand) },
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const result = e2Readings(JSON.parse(readFileSync(one('--config')!, 'utf8')) as E2Config);
  const text = JSON.stringify(result, null, 2) + '\n';
  if (one('--out')) writeFileSync(one('--out')!, text);
  process.stdout.write(text);
}
