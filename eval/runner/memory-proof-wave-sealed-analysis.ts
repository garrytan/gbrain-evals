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
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

export function analyse(rows: readonly PairRow[], margin: number, draws: number, seed: number) {
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
    outcome: decide(lower, upper, margin),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const all = (n: string) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
  const flag = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const rows = all('--pair').flatMap(p => { const [g, c] = p.split(':'); return pairRows(g, c); });
  if (!rows.length) { console.error('usage: memory-proof-wave-sealed-analysis.ts --pair <gbrain-dir>:<comparator-dir> [...] --margin 3.5'); process.exit(2); }
  const out = analyse(rows, Number(flag('--margin', '3.5')), Number(flag('--draws', '9999')), Number(flag('--seed', '20261005')));
  const rowsPath = flag('--rows');
  if (rowsPath) { mkdirSync(dirname(rowsPath), { recursive: true }); writeFileSync(rowsPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); }
  const path = flag('--out');
  if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(out, null, 2) + '\n'); }
  console.log(JSON.stringify(out, null, 1));
}
