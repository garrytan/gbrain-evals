#!/usr/bin/env bun
/**
 * Recount for the filtered vector search experiment
 * (docs/benchmarks/2026-11-26-filtered-vector-material-preregistration.md). Every published number comes from this
 * script and the raw rows run.ts wrote; nothing is typed by hand.
 *
 *   bun eval/runner/filtered-vector/recount.ts --out <summary dir> <run dir>... [--rerun <run dir>]... [--resamples 10000]
 *
 * Per cell: p50, p95 and p99 per arm, the T/C ratios of p50 and p95 with 95% bootstrap intervals, recall@k per arm and
 * the paired difference with its interval, recall@10 inside limit 20, the share of queries where both arms return the
 * same ordered pages, repeat stability, errors, incomplete searches, the share of T searches that ran a joined pooled
 * attempt (reached), and a summary of the captured plans. Then the cell states, the sanity checks per engine and
 * version, the pooled latency test over the realistic affected reached warm cells, and the preregistered outcome. A cell
 * that came out loss or regresses keeps that state only when its re-run (a --rerun dir, fresh query seed) agrees; when
 * the re-run disagrees the cell takes the re-run's state, and both are reported.
 * --pilot adds the pilot checks: the oracle against the brute force, the part under test in each arm, and the recall
 * spread per cell family.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash32 } from './attributes.ts';
import {
  BOOTSTRAP_RESAMPLES, cellStats, latencyState, outcome, percentile, pooledRatio, recallAt, recallState,
  type CellStats, type CellVerdict, type Interval, type LatencyState, type QueryRow, type RecallState,
} from './stats.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const REALISTIC_MAX_CHUNKS = 375_000;
export const ERROR_LIMIT = 0.01;

const readJsonl = (file: string): Any[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

export interface PlanSummary { attempts_per_search: number; kinds: Record<string, number>; enable_material: Record<string, number>; materialize_nodes: number; materialize_over: Record<string, number>; node_types: Record<string, number>; indexes: Record<string, number>; temp_blocks: number }

function walkPlan(node: Any, visit: (n: Any, parent: Any) => void, parent: Any = null) {
  if (!node) return;
  visit(node, parent);
  for (const child of node.Plans ?? []) walkPlan(child, visit, node);
}
const relationsUnder = (node: Any): string[] => { const out: string[] = []; walkPlan(node, n => { if (n['Relation Name']) out.push(n['Relation Name']); }); return out; };

export function summarizePlans(captures: Any[]): PlanSummary {
  const s: PlanSummary = { attempts_per_search: 0, kinds: {}, enable_material: {}, materialize_nodes: 0, materialize_over: {}, node_types: {}, indexes: {}, temp_blocks: 0 };
  const bump = (o: Record<string, number>, k: string, by = 1) => { o[k] = (o[k] ?? 0) + by; };
  for (const c of captures) {
    s.attempts_per_search += c.attempts.length / Math.max(1, captures.length);
    for (const a of c.attempts) {
      bump(s.kinds, a.kind);
      bump(s.enable_material, a.kind + ':' + a.enable_material);
      walkPlan(a.plan?.Plan, n => {
        bump(s.node_types, n['Node Type']);
        if (n['Index Name']) bump(s.indexes, n['Index Name']);
        s.temp_blocks += Number(n['Temp Read Blocks'] ?? 0) + Number(n['Temp Written Blocks'] ?? 0);
        if (n['Node Type'] === 'Materialize') { s.materialize_nodes++; bump(s.materialize_over, relationsUnder(n).sort().join('+') || 'none'); }
      });
    }
  }
  return s;
}

export interface CellResult {
  cell: string; cellKey: string; label: string; corpus: string; chunks: number; size: string; mode: string; caller: string; filter: string; kind: string;
  affected: boolean; realistic: boolean; limit: number; cache: string; queries: number; query_set: string; share_measured: number; eligible_pages: number;
  stats: CellStats; recall_diff_sd: number; recall10: { c: number; t: number } | null; same_pages: number; repeat_stable: { c: number; t: number };
  errors: { c: number; t: number }; invalid: boolean; incomplete: { c: number; t: number }; reached: number; reached_any: boolean;
  recall_state: RecallState; latency_state: LatencyState; plans: { C: PlanSummary; T: PlanSummary } | null;
  inside_outside?: { inside: { c: number; t: number } | null; outside: { c: number; t: number } | null };
  rerun?: { cell: string; recall_state: RecallState; latency_state: LatencyState; agrees_recall: boolean; agrees_latency: boolean };
  final_recall: RecallState; final_latency: LatencyState;
}

const meanOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** All cells of one run dir, computed from its raw rows. */
export function recountDir(dir: string, resamples = BOOTSTRAP_RESAMPLES): CellResult[] {
  const cells = readJsonl(join(dir, 'cells.jsonl'));
  const doneSet = new Set(readJsonl(join(dir, 'cells-done.jsonl')).map(r => r.cell));
  const exactBy = new Map<string, Any>();
  for (const e of readJsonl(join(dir, 'exact.jsonl'))) exactBy.set(e.cell + '#' + e.q, e);
  const searchesBy = new Map<string, Any[]>();
  for (const s of readJsonl(join(dir, 'searches.jsonl'))) { const k = s.cell; const a = searchesBy.get(k) ?? []; a.push(s); searchesBy.set(k, a); }
  const plansBy = new Map<string, Any[]>();
  for (const p of readJsonl(join(dir, 'plans.jsonl'))) { const k = p.cell + '#' + p.arm; const a = plansBy.get(k) ?? []; a.push(p); plansBy.set(k, a); }
  const out: CellResult[] = [];
  for (const c of cells) {
    if (!doneSet.has(c.cell)) continue;
    const rows = searchesBy.get(c.cell) ?? [];
    const k: number = c.limit;
    const qs = [...new Set(rows.map(r => r.q as number))].sort((a, b) => a - b);
    const byQ = (q: number, arm: string) => rows.filter(r => r.q === q && r.arm === arm).sort((a, b) => a.rep - b.rep);
    const qrows: QueryRow[] = [];
    const recall10: Array<[number, number]> = [];
    let same = 0, stableC = 0, stableT = 0, multi = 0;
    const insideDiff: Array<[number, number]> = [], outsideDiff: Array<[number, number]> = [];
    for (const q of qs) {
      const cr = byQ(q, 'C'), tr = byQ(q, 'T');
      const ex = exactBy.get(c.cell + '#' + q);
      const truth: number[] = ex?.pages ?? [];
      const rc = recallAt(cr[0]?.error ? [] : cr[0]?.pages ?? [], truth, k);
      const rt = recallAt(tr[0]?.error ? [] : tr[0]?.pages ?? [], truth, k);
      qrows.push({ c: cr.map(r => r.ms), t: tr.map(r => r.ms), recallC: rc, recallT: rt });
      if (k === 20) {
        const a = recallAt(cr[0]?.pages ?? [], truth, 10), b = recallAt(tr[0]?.pages ?? [], truth, 10);
        if (a !== null && b !== null) recall10.push([a, b]);
      }
      if (JSON.stringify(cr[0]?.pages) === JSON.stringify(tr[0]?.pages)) same++;
      if (cr.length > 1) { multi++; if (cr.every(r => JSON.stringify(r.pages) === JSON.stringify(cr[0].pages))) stableC++; if (tr.every(r => JSON.stringify(r.pages) === JSON.stringify(tr[0].pages))) stableT++; }
      if (rc !== null && rt !== null && ex) { if (ex.inside === true) insideDiff.push([rc, rt]); else if (ex.inside === false) outsideDiff.push([rc, rt]); }
    }
    const stats = cellStats(qrows, hash32(...[...c.cell].map((ch: string) => ch.charCodeAt(0))), resamples);
    const errC = rows.filter(r => r.arm === 'C' && r.error).length, errT = rows.filter(r => r.arm === 'T' && r.error).length;
    const nC = rows.filter(r => r.arm === 'C').length, nT = rows.filter(r => r.arm === 'T').length;
    const tRows = rows.filter(r => r.arm === 'T');
    const reached = tRows.length ? tRows.filter(r => r.joined).length / tRows.length : 0;
    const cP = plansBy.get(c.cell + '#C'), tP = plansBy.get(c.cell + '#T');
    const rs = recallState(stats.recall?.diff ?? null), ls = latencyState(stats);
    const diffs = qrows.filter(r => r.recallC !== null && r.recallT !== null).map(r => r.recallT! - r.recallC!);
    const dm = meanOf(diffs);
    const sd = diffs.length > 1 ? Math.sqrt(diffs.reduce((a, d) => a + (d - dm) ** 2, 0) / (diffs.length - 1)) : 0;
    const pair = (xs: Array<[number, number]>) => (xs.length ? { c: meanOf(xs.map(x => x[0])), t: meanOf(xs.map(x => x[1])) } : null);
    out.push({
      cell: c.cell, cellKey: c.cell.split('|').slice(0, -1).join('|'), label: c.label, corpus: c.corpus, chunks: c.chunks, size: c.corpus + '-' + c.chunks, mode: c.mode, caller: c.caller,
      filter: c.filter, kind: c.kind, affected: c.affected, realistic: c.corpus === 'wiki' || c.chunks <= REALISTIC_MAX_CHUNKS, limit: k, cache: c.cache,
      queries: qs.length, query_set: c.query_set, share_measured: c.share_measured, eligible_pages: c.eligible_pages, stats, recall_diff_sd: sd,
      recall10: pair(recall10), same_pages: qs.length ? same / qs.length : NaN, repeat_stable: { c: multi ? stableC / multi : NaN, t: multi ? stableT / multi : NaN },
      errors: { c: errC, t: errT }, invalid: errC > ERROR_LIMIT * nC || errT > ERROR_LIMIT * nT,
      incomplete: { c: rows.filter(r => r.arm === 'C' && r.incomplete).length, t: tRows.filter(r => r.incomplete).length },
      reached, reached_any: reached > 0, recall_state: rs, latency_state: ls,
      plans: cP && tP ? { C: summarizePlans(cP), T: summarizePlans(tP) } : null,
      ...(c.mode === 'clustered' ? { inside_outside: { inside: pair(insideDiff), outside: pair(outsideDiff) } } : {}),
      final_recall: rs, final_latency: ls,
    });
  }
  return out;
}

/** Applies re-runs: a loss or regresses state stands only when the re-run of the same cell agrees. */
export function applyReruns(cells: CellResult[], reruns: CellResult[]): void {
  const byKey = new Map(reruns.map(r => [r.cellKey, r]));
  for (const c of cells) {
    const r = byKey.get(c.cellKey);
    if (!r) continue;
    const agreesRecall = c.recall_state !== 'loss' || r.recall_state === 'loss';
    const agreesLatency = c.latency_state !== 'regresses' || r.latency_state === 'regresses';
    c.rerun = { cell: r.cell, recall_state: r.recall_state, latency_state: r.latency_state, agrees_recall: agreesRecall, agrees_latency: agreesLatency };
    if (!agreesRecall) c.final_recall = r.recall_state;
    if (!agreesLatency) c.final_latency = r.latency_state;
  }
}

/** Rows of one cell as QueryRows, for the pooled bootstrap. */
function queryRowsOf(dir: string, cell: string): QueryRow[] {
  const rows = readJsonl(join(dir, 'searches.jsonl')).filter(r => r.cell === cell);
  const qs = [...new Set(rows.map(r => r.q as number))];
  return qs.map(q => ({ c: rows.filter(r => r.q === q && r.arm === 'C').map(r => r.ms), t: rows.filter(r => r.q === q && r.arm === 'T').map(r => r.ms), recallC: null, recallT: null }));
}

export interface SanityResult { label: string; cells: number; identical_sql_settings: boolean; mismatches: string[]; same_pages_min: number; same_pages_ok: boolean; pooled_p50: Interval | null; pooled_ok: boolean; single_cells_missing_1: string[] }

export function sanity(dirs: string[], cells: CellResult[], resamples = BOOTSTRAP_RESAMPLES): SanityResult[] {
  const out: SanityResult[] = [];
  for (const label of [...new Set(cells.map(c => c.label))]) {
    const sc = cells.filter(c => c.label === label && !c.affected);
    const mismatches: string[] = [];
    for (const dir of dirs) {
      const plans = readJsonl(join(dir, 'plans.jsonl')).filter(p => sc.some(c => c.cell === p.cell));
      const by = new Map<string, Any>();
      for (const p of plans) by.set(p.cell + '#' + p.q + '#' + p.arm, p);
      for (const p of plans.filter(x => x.arm === 'C')) {
        const t = by.get(p.cell + '#' + p.q + '#T');
        const sig = (x: Any) => JSON.stringify(x?.attempts.map((a: Any) => [a.kind, a.sql_sha256, a.enable_material]));
        if (!t || sig(p) !== sig(t)) mismatches.push(p.cell + ' q' + p.q);
      }
    }
    const warmDirs = (c: CellResult) => dirs.find(d => readJsonl(join(d, 'cells-done.jsonl')).some(r => r.cell === c.cell))!;
    const warm = sc.filter(c => c.cache === 'warm');
    const pooled = warm.length ? pooledRatio(warm.map(c => queryRowsOf(warmDirs(c), c.cell)), 0.5, hash32(label.length, 0x5a), resamples) : null;
    const minSame = sc.length ? Math.min(...sc.map(c => c.same_pages)) : NaN;
    out.push({
      label, cells: sc.length, identical_sql_settings: mismatches.length === 0, mismatches: mismatches.slice(0, 20), same_pages_min: minSame, same_pages_ok: sc.every(c => c.same_pages >= 0.99),
      pooled_p50: pooled, pooled_ok: !!pooled && pooled.lo >= 0.95 && pooled.hi <= 1.05,
      single_cells_missing_1: warm.filter(c => c.stats.p50.ratio.lo > 1 || c.stats.p50.ratio.hi < 1).map(c => c.cell),
    });
  }
  return out;
}

export function decide(dirs: string[], cells: CellResult[], resamples = BOOTSTRAP_RESAMPLES) {
  const valid = cells.filter(c => !c.invalid);
  const pooledCells = valid.filter(c => c.realistic && c.affected && c.cache === 'warm' && c.reached_any);
  const dirOf = (c: CellResult) => dirs.find(d => readJsonl(join(d, 'cells-done.jsonl')).some(r => r.cell === c.cell))!;
  const rows = pooledCells.map(c => queryRowsOf(dirOf(c), c.cell));
  const none: Interval = { est: NaN, lo: NaN, hi: NaN };
  const pooled = rows.length ? { p50: pooledRatio(rows, 0.5, 0x9817, resamples), p95: pooledRatio(rows, 0.95, 0x9818, resamples) } : { p50: none, p95: none };
  const verdicts: CellVerdict[] = valid.filter(c => c.affected).map(c => ({ realistic: c.realistic, affected: true, warm: c.cache === 'warm', recall: c.final_recall, latency: c.final_latency, size: c.size, reached: c.reached_any }));
  return { pooled_cells: pooledCells.length, pooled, ...outcome(verdicts, pooled), invalid_cells: cells.filter(c => c.invalid).map(c => c.cell) };
}

/**
 * The continuing truth check (amendment 2026-11-26): on the first queries of every counted cell, exactSql against the
 * brute-force truth. A cell in truth-stops.jsonl never ran; any stop or disagreement goes to the Captain before numbers count.
 */
export function truthCheck(dirs: string[], cells: CellResult[]) {
  const perCell = new Map<string, { ok: number; n: number }>();
  for (const o of dirs.flatMap(d => readJsonl(join(d, 'oracle-check.jsonl')))) { const x = perCell.get(o.cell) ?? { ok: 0, n: 0 }; x.n++; if (o.ok) x.ok++; perCell.set(o.cell, x); }
  const stops = dirs.flatMap(d => readJsonl(join(d, 'truth-stops.jsonl')).map(s => s.cell as string));
  const disagreements = [...perCell].filter(([, x]) => x.ok !== x.n).map(([cell, x]) => ({ cell, ...x }));
  return { cells_checked: cells.filter(c => perCell.has(c.cell)).length, cells: cells.length, unchecked: cells.filter(c => !perCell.has(c.cell)).map(c => c.cell), disagreements, stops, clean: !disagreements.length && !stops.length };
}

/** Pilot checks (preregistration, "Pilot per arm"). */
export function pilotChecks(dirs: string[], cells: CellResult[]) {
  const oracle = dirs.flatMap(d => readJsonl(join(d, 'oracle-check.jsonl')));
  const perCell = new Map<string, { ok: number; n: number }>();
  for (const o of oracle) { const x = perCell.get(o.cell) ?? { ok: 0, n: 0 }; x.n++; if (o.ok) x.ok++; perCell.set(o.cell, x); }
  const oracleCellsChecked = cells.filter(c => perCell.has(c.cell)).length;
  const plans = dirs.flatMap(d => readJsonl(join(d, 'plans.jsonl')));
  const joined = { C: {} as Record<string, number>, T: {} as Record<string, number> };
  for (const p of plans) for (const a of p.attempts) if (a.kind === 'joined') { const o = joined[p.arm as 'C' | 'T']; o[a.enable_material] = (o[a.enable_material] ?? 0) + 1; }
  const family = (c: CellResult) => [c.label, c.mode, c.kind, c.caller].join('|');
  const spread = new Map<string, number[]>();
  for (const c of cells.filter(x => x.affected && x.stats.recall)) {
    const planned = c.chunks > REALISTIC_MAX_CHUNKS ? 100 : 200;
    const arr = spread.get(family(c)) ?? []; arr.push(1.96 * c.recall_diff_sd / Math.sqrt(planned)); spread.set(family(c), arr);
  }
  return {
    oracle: { cells_checked: oracleCellsChecked, cells: cells.length, all_agree: [...perCell.values()].every(x => x.ok === x.n), disagreements: [...perCell].filter(([, x]) => x.ok !== x.n).map(([cell, x]) => ({ cell, ...x })) },
    joined_attempt_settings: joined,
    t_sets_material_off: (joined.T.off ?? 0) > 0 && !joined.T.on,
    c_keeps_default: (joined.C.on ?? 0) > 0 && !joined.C.off,
    not_reached: cells.filter(c => c.affected && !c.reached_any).map(c => c.cell),
    query_sets: { clustered_with_both_halves: cells.filter(c => c.mode === 'clustered' && c.query_set.startsWith('stratified')).length, clustered_independent_fallback: cells.filter(c => c.mode === 'clustered' && c.affected && !c.query_set.startsWith('stratified')).map(c => c.cell) },
    projected_recall_half_width_max_by_family: Object.fromEntries([...spread].map(([k, v]) => [k, Math.max(...v)])),
    families_over_0_008: [...spread].filter(([, v]) => Math.max(...v) > 0.008).map(([k]) => k),
    plan_same_both_arms: cells.filter(c => c.affected && c.plans && JSON.stringify(c.plans.C.node_types) === JSON.stringify(c.plans.T.node_types)).map(c => c.cell),
  };
}

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const iv = (i: Interval) => f(i.est) + ' [' + f(i.lo) + ', ' + f(i.hi) + ']';

export function markdownTable(cells: CellResult[]): string {
  const head = '| cell | reached | p50 C | p50 T | p50 T/C | p95 T/C | p99 C | p99 T | recall C | recall T | T − C | recall | latency | Materialize C/T |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const lines = cells.map(c => '| ' + [c.cell.split('|').slice(0, 8).join(' '), f(c.reached), f(c.stats.p50.c, 1), f(c.stats.p50.t, 1), iv(c.stats.p50.ratio), iv(c.stats.p95.ratio), f(c.stats.p99.c, 1), f(c.stats.p99.t, 1),
    c.stats.recall ? f(c.stats.recall.c, 3) : 'n/a', c.stats.recall ? f(c.stats.recall.t, 3) : 'n/a', c.stats.recall ? f(c.stats.recall.diff.est, 3) + ' [' + f(c.stats.recall.diff.lo, 3) + ', ' + f(c.stats.recall.diff.hi, 3) + ']' : 'n/a',
    c.final_recall + (c.rerun && !c.rerun.agrees_recall ? ' (was ' + c.recall_state + ')' : ''), c.final_latency + (c.rerun && !c.rerun.agrees_latency ? ' (was ' + c.latency_state + ')' : ''),
    c.plans ? c.plans.C.materialize_nodes + '/' + c.plans.T.materialize_nodes : 'n/a'].join(' | ') + ' |');
  return [head, ...lines].join('\n');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const take = (name: string) => { const out: string[] = []; for (let i = 0; i < argv.length; i++) if (argv[i] === name) { out.push(argv[i + 1]!); argv.splice(i, 2); i--; } return out; };
  const outDir = resolve(take('--out')[0] ?? 'recount');
  const reruns = take('--rerun').map(d => resolve(d));
  const resamples = Number(take('--resamples')[0] ?? BOOTSTRAP_RESAMPLES);
  const pilot = argv.includes('--pilot');
  const dirs = argv.filter(a => !a.startsWith('--')).map(d => resolve(d));
  if (!dirs.length) throw new Error('usage: recount.ts --out <dir> <run dir>... [--rerun <run dir>]... [--pilot]');
  const cells = dirs.flatMap(d => recountDir(d, resamples));
  applyReruns(cells, reruns.flatMap(d => recountDir(d, resamples)));
  const result = { cells: cells.length, decision: decide(dirs, cells, resamples), truth_check: truthCheck(dirs, cells), sanity: sanity(dirs, cells, resamples), ...(pilot ? { pilot: pilotChecks(dirs, cells) } : {}), manifests: dirs.map(d => JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'))) };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'cells.json'), JSON.stringify(cells, null, 1));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(result, null, 1));
  writeFileSync(join(outDir, 'cells.md'), markdownTable(cells) + '\n');
  const { manifests: _m, ...printed } = result;
  console.log(JSON.stringify(printed, null, 1));
}
