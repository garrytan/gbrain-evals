#!/usr/bin/env bun
/**
 * Memory proof wave 2: the preregistered confirmation gates, from each group's joint blinded re-judge.
 *
 *   bun eval/runner/memory-proof-wave-2-confirm-analysis.ts --rejudges <dir> [--out <json>]
 *
 * `<dir>/<group>/out/` is one group's re-judge output (`lme-1`..`lme-4`, `beam-100k`, `beam-500k-1`, ...), with each
 * cell's `cell.json` and its in-cell `summary.json` copied beside its `stages/judge/`. Arms are read from each cell's
 * spec note (`arm <name>:`); the comparator is its provider.
 *
 * - Gate 1, LongMemEval-S: `combined-v2` beats `combined-v1@pin` and is non-inferior to `raw@pin` at 2 points; questions
 *   are the unit, with a one-sided 95% paired bootstrap-t bound (9,999 draws, seed 20261010).
 * - Gate 2, BEAM pooled: `combined-v2` non-inferior to `combined-v1@pin` at 2 points; gate 3: against the comparator
 *   at 3.5 points. Both use wave 1's restricted wild cluster bootstrap-t (conversations, stratified by size).
 * - W5: `combined-v2+w5` against `combined-v2`: the pooled lower bound above -3, and no TC6 kind's two-sided 95%
 *   interval entirely below -3.
 * - LongMemEval-S against the comparator's wave-1 answers is reported with gate 1's statistic and decides nothing.
 *
 * The output carries aggregates only; no question or conversation ids.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyse, incompleteness } from './memory-proof-wave-sealed-analysis.ts';
import { pairRows, type PairRow } from './memory-proof-wave-dev-power.ts';
import { lowerBounds, prepare, wildRestrictedLowerBound, type ClusterRow } from './memory-proof-wave/ni-stats.ts';

const DRAWS = 9999, SEED = 20261010;
const TC6 = ['multi_session_reasoning', 'contradiction_resolution', 'temporal_reasoning', 'event_ordering', 'abstention'];

type Cells = Record<string, string>;

function cellsOf(out: string): Cells {
  const arms: Cells = {};
  for (const id of readdirSync(out).sort()) {
    const path = join(out, id, 'cell.json');
    if (!existsSync(path)) continue;
    const cell = JSON.parse(readFileSync(path, 'utf8'));
    const arm = cell.spec.provider === 'comparator' ? 'comparator' : /arm (\S+):/.exec(cell.spec.note)?.[1];
    if (!arm || arms[arm]) throw new Error(`${path}: no arm, or a second ${arm}`);
    arms[arm] = join(out, id);
  }
  return arms;
}

function scores(dir: string): Map<string, number> {
  const cell = JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8'));
  return new Map((cell.resolved.schedule as string[]).map(q => {
    const f = join(dir, 'stages/judge', `${q}.json`);
    return [q, existsSync(f) ? Number(JSON.parse(readFileSync(f, 'utf8')).score ?? 0) : 0];
  }));
}

function cellGate(dir: string) {
  const s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  return { cell_id: JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8')).cell_id, delivered_mean: s.delivered_context?.mean,
    delivered_p95: s.delivered_context?.p95, delivered_ok: s.delivered_context?.ok === true, complete: s.score?.complete === true,
    in_cell_mean_points: Number((100 * s.score?.mean_score).toFixed(2)) };
}

function lmeGate(groups: Cells[], a: string, b: string, margin: number, beats: boolean) {
  const rows: ClusterRow[] = [];
  for (const g of groups) {
    const x = scores(g[a]), y = scores(g[b]);
    for (const [q, v] of x) rows.push({ id: q, stratum: 'lme', n: 1, sum: 100 * (v - (y.get(q) ?? 0)) });
  }
  const p = prepare(rows);
  const lb = lowerBounds(p, { alpha: 0.05, draws: DRAWS, seed: SEED }, ['boot-t']);
  const lower = lb['boot-t'];
  const incomplete = groups.flatMap(g => [...incompleteness(g[a]), ...incompleteness(g[b])]);
  return {
    pair: `${a} - ${b}`, questions: rows.length, estimate_points: Number(lb.theta.toFixed(3)), lower: Number(lower.toFixed(3)), margin,
    claim: beats ? 'beats (lower > 0)' : `non-inferior (lower > -${margin})`, holds: beats ? lower > 0 : lower > -margin,
    complete: incomplete.length === 0,
  };
}

function beamRows(groups: Cells[], a: string, b: string): PairRow[] {
  return groups.flatMap(g => pairRows(g[a], g[b]));
}

function kindIntervals(rows: PairRow[]) {
  return Object.fromEntries(TC6.map(k => {
    const rs = rows.filter(r => r.qid.includes(`_${k}_`));
    const cl = (sign: number) => {
      const by = new Map<string, ClusterRow>();
      for (const r of rs) {
        const c = by.get(r.conversation) ?? { id: r.conversation, stratum: r.split, n: 0, sum: 0 };
        c.n += 1; c.sum += sign * 100 * r.d; by.set(r.conversation, c);
      }
      return prepare([...by.values()]);
    };
    const lower = wildRestrictedLowerBound(cl(1), { alpha: 0.025, draws: DRAWS, seed: SEED, weights: 'webb' });
    const upper = -wildRestrictedLowerBound(cl(-1), { alpha: 0.025, draws: DRAWS, seed: SEED, weights: 'webb' });
    const mean = 100 * rs.reduce((s, r) => s + r.d, 0) / rs.length;
    return [k, { questions: rs.length, estimate_points: Number(mean.toFixed(2)), lower: Number(lower.toFixed(3)), upper: Number(upper.toFixed(3)), entirely_below_minus_3: upper < -3 }];
  }));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const root = flag('--rejudges');
  if (!root) { console.error('usage: memory-proof-wave-2-confirm-analysis.ts --rejudges <dir> [--out <json>]'); process.exit(2); }
  const group = (name: string) => cellsOf(join(root, name, 'out'));
  const lme = ['lme-1', 'lme-2', 'lme-3', 'lme-4'].map(group);
  const beamNames = readdirSync(root).filter(n => n.startsWith('beam-')).sort();
  const beam = beamNames.map(group);
  const out: Record<string, unknown> = {
    cells: Object.fromEntries([...['lme-1', 'lme-2', 'lme-3', 'lme-4'].map((n, i) => [n, lme[i]] as const), ...beamNames.map((n, i) => [n, beam[i]] as const)]
      .map(([n, g]) => [n, Object.fromEntries(Object.entries(g).filter(([a]) => !(n.startsWith('lme') && a === 'comparator')).map(([a, d]) => [a, cellGate(d)]))])),
    gate_1: { beats_v1: lmeGate(lme, 'v2', 'v1', 0, true), non_inferior_to_raw: lmeGate(lme, 'v2', 'raw', 2, false) },
    lme_vs_comparator_wave1: lmeGate(lme, 'v2', 'comparator', 0, true),
    lme_one_call_vs_v2: lmeGate(lme, 'one-call', 'v2', 0, true),
  };
  const inc = (a: string, b: string) => beam.flatMap(g => [...incompleteness(g[a]), ...incompleteness(g[b])]);
  out.gate_2 = analyse(beamRows(beam, 'v2', 'v1'), 2, DRAWS, SEED, inc('v2', 'v1'));
  out.gate_3 = analyse(beamRows(beam, 'v2', 'comparator'), 3.5, DRAWS, SEED, inc('v2', 'comparator'));
  if (beam.every(g => g['v2-w5'])) {
    const rows = beamRows(beam, 'v2-w5', 'v2');
    const pooled = analyse(rows, 3, DRAWS, SEED, inc('v2-w5', 'v2'));
    const kinds = kindIntervals(rows);
    out.w5 = { pooled, tc6: kinds, passes: pooled.complete && pooled.primary.lower > -3 && Object.values(kinds).every(k => !k.entirely_below_minus_3) };
  }
  out.beam_lane_points = Object.fromEntries(['v1', 'v2', 'v2-w5', 'comparator'].filter(a => beam.every(g => g[a])).map(a => {
    let s = 0, n = 0;
    for (const g of beam) for (const v of scores(g[a]).values()) { s += v; n += 1; }
    return [a, Number((100 * s / n).toFixed(2))];
  }));
  out.lme_lane_points = Object.fromEntries(['v1', 'v2', 'one-call', 'raw', 'comparator'].map(a => {
    let s = 0, n = 0;
    for (const g of lme) for (const v of scores(g[a]).values()) { s += v; n += 1; }
    return [a, Number((100 * s / n).toFixed(2))];
  }));
  const path = flag('--out');
  if (path) writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 1));
}

