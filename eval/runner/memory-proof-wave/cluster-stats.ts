/**
 * Per-history cluster counts and accuracy spread for one dataset's
 * committed per-question rows.
 *
 * ICC is the one-way ANOVA estimator with unequal cluster sizes: the share
 * of score variance that sits between clusters. The design effect
 * 1 + (m - 1) * ICC (m = mean cluster size) is how much a clustered sample's
 * variance exceeds that of the same number of independent questions.
 */
import type { ClusterInput } from './harness-inputs.ts';

export interface ClusterSpread {
  clusters: number;
  histories: number;
  questions: number;
  questions_per_cluster: { min: number; median: number; max: number };
  histories_per_cluster: { min: number; max: number };
  mean_points: number;
  cluster_mean_points: { min: number; median: number; max: number; sd: number };
  icc: number;
  design_effect: number;
  effective_questions: number;
}

const round = (x: number, d = 2) => Number(x.toFixed(d));

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function clusterSpread(clusters: ClusterInput[]): ClusterSpread {
  const sizes = clusters.map(c => c.items.length);
  const N = sizes.reduce((s, x) => s + x, 0);
  const G = clusters.length;
  const means = clusters.map(c => c.items.reduce((s, i) => s + i.score, 0) / c.items.length);
  const grand = clusters.reduce((s, c) => s + c.items.reduce((t, i) => t + i.score, 0), 0) / N;
  const ssb = clusters.reduce((s, c, k) => s + c.items.length * (means[k] - grand) ** 2, 0);
  const ssw = clusters.reduce((s, c, k) => s + c.items.reduce((t, i) => t + (i.score - means[k]) ** 2, 0), 0);
  const msb = ssb / (G - 1);
  const msw = ssw / (N - G);
  const n0 = (N - sizes.reduce((s, x) => s + x * x, 0) / N) / (G - 1);
  const icc = Math.max(0, (msb - msw) / (msb + (n0 - 1) * msw));
  const mbar = N / G;
  const deff = 1 + (mbar - 1) * icc;
  const cm = means.map(m => 100 * m);
  const cmMean = cm.reduce((s, x) => s + x, 0) / G;
  const hist = clusters.map(c => c.histories.length);
  return {
    clusters: G,
    histories: clusters.reduce((s, c) => s + c.histories.length, 0),
    questions: N,
    questions_per_cluster: { min: Math.min(...sizes), median: median(sizes), max: Math.max(...sizes) },
    histories_per_cluster: { min: Math.min(...hist), max: Math.max(...hist) },
    mean_points: round(100 * grand),
    cluster_mean_points: { min: round(Math.min(...cm)), median: round(median(cm)), max: round(Math.max(...cm)), sd: round(Math.sqrt(cm.reduce((s, x) => s + (x - cmMean) ** 2, 0) / (G - 1))) },
    icc: round(icc, 4),
    design_effect: round(deff, 3),
    effective_questions: Math.round(N / deff),
  };
}
