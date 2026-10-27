#!/usr/bin/env bun
/**
 * Memory proof wave: the preregistered non-inferiority analysis of the sealed
 * BEAM cells (gbrain minus the comparator, in points, conversations as
 * clusters, BEAM sizes as strata).
 *
 *   bun eval/runner/memory-proof-wave-sealed-analysis.ts --pair <gbrain-dir>:<comparator-dir> [--pair ...] \
 *       --margin 3.5 [--draws 9999] [--seed 20261005] [--out <json>] [--rows <jsonl>]
 *
 * Each directory holds a `cell.json` and `stages/judge/` (the joint blinded
 * re-judge output with the cell's `cell.json` beside it). The primary lower
 * bound is the restricted wild cluster bootstrap-t with Webb weights, found
 * by inverting the one-sided 5% test; the upper bound is the same test in the
 * other direction. The analytic CR1 t bound and the stratified cluster
 * bootstrap-t are reported beside it and decide nothing. `--rows` writes the
 * per-question paired differences (ids included) for custody; the JSON output
 * carries aggregates only.
 *
 * The preregistration's incomplete-cell rule is applied before `decide()`: if
 * any scheduled question lacks a scored row for either system, any rubric item
 * is unscored, or a cell's delivered-context gate failed (its `summary.json`,
 * read from `--cells-dir` when given), the outcome is `inconclusive` whatever
 * the bounds say. The output counts each kind; the ids go only to `--rows`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pairRows, type PairRow } from './memory-proof-wave-dev-power.ts';
import { decide, lowerBounds, prepare, wildRestrictedLowerBound, type ClusterRow } from './memory-proof-wave/ni-stats.ts';

export function clusters(rows: readonly PairRow[], sign = 1): ClusterRow[] {
  const by = new Map<string, ClusterRow>();
  for (const r of rows) {
    const c = by.get(r.conversation) ?? { id: r.conversation, stratum: r.split, n: 0, sum: 0 };
    c.n += 1;
    c.sum += sign * 100 * r.d;
    by.set(r.conversation, c);
  }
  return [...by.values()];
}

/** Outcomes the preregistration scores 0 and counts by type; they never make a cell incomplete. */
export const SCORED_ZERO = new Set(['answer_failure', 'retrieval_failure', 'incomplete_ingest']);

export interface Incomplete { cell_id: string; kind: 'no_scored_row' | 'judge_failure' | 'unscored_rubric_item' | 'delivered_context_gate'; query_id?: string }

/** Every way a cell breaks the preregistered completeness rule. */
export function incompleteness(dir: string, cellsDir?: string): Incomplete[] {
  const cell = JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8'));
  const id: string = cell.cell_id;
  const judged = new Map<string, any>();
  const judgeDir = join(dir, 'stages/judge');
  for (const f of existsSync(judgeDir) ? readdirSync(judgeDir).sort() : []) {
    const r = JSON.parse(readFileSync(join(judgeDir, f), 'utf8'));
    judged.set(r.query_id, r);
  }
  const out: Incomplete[] = [];
  for (const qid of cell.resolved.schedule as string[]) {
    const r = judged.get(qid);
    if (!r) out.push({ cell_id: id, kind: 'no_scored_row', query_id: qid });
    else if (SCORED_ZERO.has(r.outcome)) continue;
    else if (r.outcome === 'judge_failure' || typeof r.score !== 'number') out.push({ cell_id: id, kind: 'judge_failure', query_id: qid });
    else if ((r.rubric ?? []).some((item: any) => typeof item.score !== 'number')) out.push({ cell_id: id, kind: 'unscored_rubric_item', query_id: qid });
  }
  const summaryPath = cellsDir ? join(cellsDir, id, 'summary.json') : join(dir, 'summary.json');
  if (existsSync(summaryPath) && JSON.parse(readFileSync(summaryPath, 'utf8')).delivered_context?.ok !== true) out.push({ cell_id: id, kind: 'delivered_context_gate' });
  return out;
}

export function analyse(rows: readonly PairRow[], margin: number, draws: number, seed: number, incomplete: readonly Incomplete[] = []) {
  const p = prepare(clusters(rows));
  const side = lowerBounds(p, { alpha: 0.05, draws, seed }, ['analytic', 'boot-t']);
  const lower = wildRestrictedLowerBound(p, { alpha: 0.05, draws, seed, weights: 'webb' });
  const upper = -wildRestrictedLowerBound(prepare(clusters(rows, -1)), { alpha: 0.05, draws, seed, weights: 'webb' });
  const bySplit = Object.fromEntries([...new Set(rows.map(r => r.split))].sort().map(s => {
    const rs = rows.filter(r => r.split === s);
    return [s, { questions: rs.length, conversations: new Set(rs.map(r => r.conversation)).size, mean_points: Number((100 * rs.reduce((a, r) => a + r.d, 0) / rs.length).toFixed(2)) }];
  }));
  return {
    questions: rows.length, conversations: p.G, margin,
    estimate_points: Number(side.theta.toFixed(3)), se_points: Number(side.se.toFixed(3)),
    primary: { method: 'restricted wild cluster bootstrap-t, Webb weights', draws, seed, lower: Number(lower.toFixed(3)), upper: Number(upper.toFixed(3)) },
    reported_beside: { analytic_lower: Number(side.analytic.toFixed(3)), boot_t_lower: Number(side['boot-t'].toFixed(3)) },
    by_split: bySplit,
    complete: incomplete.length === 0,
    incomplete: Object.fromEntries([...new Set(incomplete.map(i => i.cell_id))].sort().map(c => [c, Object.fromEntries(
      [...new Set(incomplete.filter(i => i.cell_id === c).map(i => i.kind))].map(k => [k, incomplete.filter(i => i.cell_id === c && i.kind === k).length]))])),
    outcome_from_bounds: decide(lower, upper, margin),
    outcome: incomplete.length ? 'inconclusive' as const : decide(lower, upper, margin),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const all = (n: string) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
  const flag = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const pairs = all('--pair').map(p => p.split(':'));
  const rows = pairs.flatMap(([g, c]) => pairRows(g, c));
  if (!rows.length) { console.error('usage: memory-proof-wave-sealed-analysis.ts --pair <gbrain-dir>:<comparator-dir> [...] --margin 3.5 [--cells-dir <dir>]'); process.exit(2); }
  const incomplete = pairs.flatMap(dirs => dirs.flatMap(d => incompleteness(d, flag('--cells-dir'))));
  const out = analyse(rows, Number(flag('--margin', '3.5')), Number(flag('--draws', '9999')), Number(flag('--seed', '20261005')), incomplete);
  const rowsPath = flag('--rows');
  if (rowsPath) {
    mkdirSync(dirname(rowsPath), { recursive: true });
    writeFileSync(rowsPath, [...rows.map(r => JSON.stringify(r)), ...incomplete.map(i => JSON.stringify({ incomplete: i }))].join('\n') + '\n');
  }
  const path = flag('--out');
  if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(out, null, 2) + '\n'); }
  console.log(JSON.stringify(out, null, 1));
}
