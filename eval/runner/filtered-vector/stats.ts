/**
 * Statistics and cell states for the filtered vector search experiment, exactly as its preregistration's "Metric and
 * denominator" and "Decision rule" fix them (docs/benchmarks/2026-11-26-filtered-vector-material-preregistration.md).
 * Pure functions: the run writes raw rows, and recount.ts computes every published number from them with these.
 */
import { rng } from './attributes.ts';

export const BOOTSTRAP_RESAMPLES = 10_000;
export const BOOTSTRAP_SEED = 9820;
export const RECALL_MARGIN = 0.01;

/** Linear-interpolation percentile (type 7), q in [0, 1]; sorts a copy. */
export function percentile(values: ArrayLike<number>, q: number): number {
  const n = values.length;
  if (n === 0) return NaN;
  const sorted = Float64Array.from(values).sort();
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  return sorted[lo]! + (h - lo) * ((sorted[Math.min(lo + 1, n - 1)] ?? sorted[lo]!) - sorted[lo]!);
}

/** Recall@k of one result list against the exact top k: the share of the exact pages returned, over min(k, |exact|). */
export function recallAt(returned: readonly number[], exact: readonly number[], k: number): number | null {
  const truth = exact.slice(0, k);
  if (truth.length === 0) return null;
  const got = new Set(returned.slice(0, k));
  let hit = 0;
  for (const page of truth) if (got.has(page)) hit++;
  return hit / Math.min(k, truth.length);
}

/** One query of one cell: its timed latencies per arm (ms) and its recall per arm (null when no page is eligible). */
export interface QueryRow { c: number[]; t: number[]; recallC: number | null; recallT: number | null }

export interface Interval { est: number; lo: number; hi: number }

export interface CellStats {
  queries: number;
  recallQueries: number;
  p50: { c: number; t: number; ratio: Interval };
  p95: { c: number; t: number; ratio: Interval };
  p99: { c: number; t: number };
  recall: { c: number; t: number; diff: Interval } | null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function pool(rows: QueryRow[], idx: ArrayLike<number>, arm: 'c' | 't'): Float64Array {
  let n = 0;
  for (let i = 0; i < idx.length; i++) n += rows[idx[i]!]![arm].length;
  const out = new Float64Array(n);
  let o = 0;
  for (let i = 0; i < idx.length; i++) for (const v of rows[idx[i]!]![arm]) out[o++] = v;
  return out;
}

/** Percentile bootstrap over queries (a query's repeats move together), seeded per cell key. */
export function cellStats(rows: QueryRow[], seedKey: number, resamples = BOOTSTRAP_RESAMPLES): CellStats {
  const n = rows.length;
  const all = Array.from({ length: n }, (_, i) => i);
  const c = pool(rows, all, 'c'), t = pool(rows, all, 't');
  const recallRows = rows.filter(r => r.recallC !== null && r.recallT !== null);
  const diffs = recallRows.map(r => r.recallT! - r.recallC!);
  const next = rng(seedKey);
  const r50: number[] = [], r95: number[] = [], rd: number[] = [];
  const idx = new Int32Array(n);
  const ridx = new Int32Array(recallRows.length);
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) idx[i] = Math.floor(next() * n);
    const bc = pool(rows, idx, 'c'), bt = pool(rows, idx, 't');
    r50.push(percentile(bt, 0.5) / percentile(bc, 0.5));
    r95.push(percentile(bt, 0.95) / percentile(bc, 0.95));
    if (diffs.length) {
      let s = 0;
      for (let i = 0; i < diffs.length; i++) { ridx[i] = Math.floor(next() * diffs.length); s += diffs[ridx[i]!]!; }
      rd.push(s / diffs.length);
    }
  }
  const interval = (est: number, draws: number[]): Interval => ({ est, lo: percentile(draws, 0.025), hi: percentile(draws, 0.975) });
  return {
    queries: n,
    recallQueries: recallRows.length,
    p50: { c: percentile(c, 0.5), t: percentile(t, 0.5), ratio: interval(percentile(t, 0.5) / percentile(c, 0.5), r50) },
    p95: { c: percentile(c, 0.95), t: percentile(t, 0.95), ratio: interval(percentile(t, 0.95) / percentile(c, 0.95), r95) },
    p99: { c: percentile(c, 0.99), t: percentile(t, 0.99) },
    recall: diffs.length ? { c: mean(recallRows.map(r => r.recallC!)), t: mean(recallRows.map(r => r.recallT!)), diff: interval(mean(diffs), rd) } : null,
  };
}

export type RecallState = 'safe' | 'loss' | 'unresolved';
export type LatencyState = 'improves' | 'regresses' | 'neutral';

/** Non-inferiority on the paired recall difference T - C with a one-point margin. */
export function recallState(diff: Interval | null): RecallState {
  if (!diff) return 'safe';
  if (diff.lo >= -RECALL_MARGIN) return 'safe';
  if (diff.est < -RECALL_MARGIN && diff.hi < 0) return 'loss';
  return 'unresolved';
}

export function latencyState(s: Pick<CellStats, 'p50' | 'p95'>): LatencyState {
  if (s.p50.ratio.hi < 0.9 && s.p95.ratio.hi < 1) return 'improves';
  const slower50 = s.p50.ratio.lo > 1.1 && s.p50.t - s.p50.c >= 5;
  const slower95 = s.p95.ratio.lo > 1.1 && s.p95.t - s.p95.c >= 20;
  return slower50 || slower95 ? 'regresses' : 'neutral';
}

/**
 * Geometric mean of the p50 (or p95) ratio over a set of cells, with a joint percentile bootstrap that resamples queries
 * within each cell independently.
 */
export function pooledRatio(cells: QueryRow[][], q: 0.5 | 0.95, seedKey: number, resamples = BOOTSTRAP_RESAMPLES): Interval {
  const logRatio = (rows: QueryRow[], idx: ArrayLike<number>) => Math.log(percentile(pool(rows, idx, 't'), q) / percentile(pool(rows, idx, 'c'), q));
  const est = Math.exp(mean(cells.map(rows => logRatio(rows, Array.from({ length: rows.length }, (_, i) => i)))));
  const next = rng(seedKey);
  const draws: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (const rows of cells) {
      const idx = new Int32Array(rows.length);
      for (let i = 0; i < rows.length; i++) idx[i] = Math.floor(next() * rows.length);
      s += logRatio(rows, idx);
    }
    draws.push(Math.exp(s / cells.length));
  }
  return { est, lo: percentile(draws, 0.025), hi: percentile(draws, 0.975) };
}

export type Outcome = 'flip' | 'limited-flip' | 'no-flip' | 'close';

export interface CellVerdict { realistic: boolean; affected: boolean; warm: boolean; recall: RecallState; latency: LatencyState; size: string; reached: boolean }

/**
 * The preregistered outcome before any stage 1b check. `pooled` are the geometric-mean ratios over the realistic
 * affected reached warm cells; with no such cell the intervals are NaN, latency does not improve and the outcome is
 * close (amendment of 2026-11-26).
 */
export function outcome(cells: CellVerdict[], pooled: { p50: Interval; p95: Interval }): { outcome: Outcome; latencyImproves: boolean; blocking: number } {
  const realistic = cells.filter(c => c.realistic && c.affected);
  const improvingSizes = new Set(realistic.filter(c => c.warm && c.latency === 'improves').map(c => c.size));
  const latencyImproves = pooled.p50.hi < 1 && pooled.p95.hi < 1 && improvingSizes.size > 0;
  const blocking = realistic.filter(c => c.recall !== 'safe' || c.latency === 'regresses').length;
  if (!latencyImproves) return { outcome: 'close', latencyImproves, blocking };
  return { outcome: blocking === 0 ? 'flip' : 'limited-flip', latencyImproves, blocking };
}
