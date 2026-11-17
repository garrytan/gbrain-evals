/**
 * Chart generator for engine-shootout receipts. Reads one runner JSON per
 * brain size and writes inline SVGs (GitHub renders them without an image
 * host) plus `summary.md`, a markdown copy of every number the charts show.
 * Every number comes from the JSON; nothing is typed in here.
 *
 * Run:
 *   bun eval/runner/engine-shootout-chart.ts <receipt.json> [<receipt.json> ...] --out <dir>
 *
 * Per receipt (suffix is the page count, e.g. `-1000`):
 *   paired-latency-<n>.svg   the primary view: per operation, how many times as long the other engine takes, 95% interval, log axis
 *   latency-<n>.svg          p50 and p95 per operation and engine, from the paired phase
 *   footprint-<n>.svg        bulk import, cold start, memory and disk (one run each, no interval)
 *   quality-<n>.svg          Recall@5 and nDCG@10 per search mode
 *   cost-<n>.svg             dollars per 1,000 operations by operation
 * With two or more receipts:
 *   scaling.svg              the hybrid-search ratio and its interval against brain size
 * And `summary.md` with the tables behind all of them.
 *
 * The reference engine (the one the others are compared against) and the
 * other engines are read from the receipt, so a later Rust arm gets its own
 * colour and column with no change here.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

// ─── Types (the slice of the runner's JSON this file reads) ─────────

type CI = [number, number] | null;
interface PairLat {
  n: number;
  ref_p50_ms: number; other_p50_ms: number; ref_p95_ms: number; other_p95_ms: number; ref_p99_ms: number; other_p99_ms: number;
  diff_ms: { delta: number; ci95: CI };
  geo_mean_ratio: { ratio: number; ci95: CI };
  p_two_sided: number; p_holm: number | null;
  by_order: { ref_first: { n: number; mean_diff_ms: number | null }; other_first: { n: number; mean_diff_ms: number | null } };
}
interface PairCost {
  blocks: number; ops_per_block: number;
  ref_usd_per_1k_ops: number; other_usd_per_1k_ops: number; ref_cpu_s_per_1k_ops: number; other_cpu_s_per_1k_ops: number;
  diff_usd_per_1k_ops: { delta: number; ci95: CI }; diff_cpu_s_per_1k_ops: { delta: number; ci95: CI };
}
interface PairQual { n_queries: number; ref_mean: number; other_mean: number; diff: { delta: number; ci95: CI }; queries_that_differ: number }
interface Paired {
  reference: string; other: string;
  latency: Record<string, PairLat>;
  cost_per_op: Record<string, PairCost>;
  quality: Record<string, { recall_at_5: PairQual; ndcg_at_10: PairQual }>;
  decision: { outcome: string; reasons: string[] };
}
interface Arm {
  id: string; label: string;
  run: {
    import: { pages: number; pages_per_sec: number; chunk_upserts_per_sec: number; cpu_seconds: { client: number; server: number | null } };
    quality: Record<string, { recall_at_5: number; ndcg_at_10: number; empty_result_rate: number }>;
    cost_window: { cpu_seconds_per_1k: number; wall_seconds_per_1k: number; qps_single_client: number };
    memory: { client_engine_rss_bytes: number; server_peak_working_set_bytes: number | null };
    latency: Record<string, { p50_ms: number; p95_ms: number; p99_ms: number; n: number }>;
  };
  cold_start: { median_total_ms: number; median_server_to_answer_ms: number | null };
  disk: { excl_wal_bytes: number; total_bytes: number };
  cost: { usd_per_1k_queries: { cpu_usd: number; memory_usd: number; total_usd: number }; inputs: { memory_gb: number } };
}
export interface Receipt {
  generated_at: string;
  counted: boolean;
  options: { scale: number };
  arms: Record<string, Arm>;
  paired: Record<string, Paired>;
  price_model: { as_of: string; hosted_postgres: { usd_per_hour: number; label: string }; hours_per_month: number };
  decision_rule: { ratio_margin: number; interactive_p95_ms: number };
}

const C = {
  bgPanel: '#0a0a0a', bgCard: '#171717', text: '#e5e7eb', muted: '#9ca3af', axis: '#404040', grid: '#262626', mark: '#fbbf24',
};
const ARM_COLORS = ['#38bdf8', '#16a34a', '#f97316', '#c084fc'];
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MB = 2 ** 20;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Three significant figures, no scientific notation below 1e-3 unless the value is tiny. */
export function fmt(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
  const a = Math.abs(x);
  if (a === 0) return '0';
  if (a >= 1000) return Math.round(x).toLocaleString('en-US');
  if (a >= 100) return x.toFixed(0);
  if (a >= 10) return x.toFixed(1);
  if (a >= 1) return x.toFixed(2);
  if (a >= 0.001) return x.toFixed(3);
  return x.toExponential(2);
}
const fmtCI = (ci: CI, f: (x: number) => string = fmt) => (ci ? `${f(ci[0])} to ${f(ci[1])}` : 'n/a');
export const usd = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toExponential(2)}`;

const svgOpen = (w: number, h: number, title: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}" font-family="${FONT}">\n<rect width="${w}" height="${h}" fill="${C.bgPanel}"/>\n`;
const text = (x: number, y: number, s: string, o: { size?: number; fill?: string; anchor?: string; weight?: number } = {}) =>
  `<text x="${x}" y="${y}" font-size="${o.size ?? 13}" fill="${o.fill ?? C.text}" text-anchor="${o.anchor ?? 'start'}" font-weight="${o.weight ?? 400}">${esc(s)}</text>\n`;

/** The paired block of a receipt: the first (and today only) comparison. */
export function pairOf(r: Receipt): { key: string; p: Paired } {
  const key = Object.keys(r.paired)[0];
  if (!key) throw new Error('receipt has no paired section; run the full benchmark with two engines');
  return { key, p: r.paired[key] };
}

const armIds = (r: Receipt) => { const { p } = pairOf(r); return [p.reference, p.other]; };
const colorOf = (r: Receipt, id: string) => ARM_COLORS[Object.keys(r.arms).indexOf(id) % ARM_COLORS.length];
const label = (r: Receipt, id: string) => r.arms[id].label;
const title = (r: Receipt, what: string) => `${what}, ${r.options.scale.toLocaleString('en-US')} pages`;

function legend(r: Receipt, x0: number, y: number): string {
  let s = '';
  armIds(r).forEach((id, i) => {
    s += `<rect x="${x0 + i * 170}" y="${y - 10}" width="10" height="10" rx="2" fill="${colorOf(r, id)}"/>\n`;
    s += text(x0 + 16 + i * 170, y, label(r, id), { size: 12 });
  });
  return s;
}

// ─── Charts ─────────────────────────────────────────────────────────

/** The primary view. One row per operation: the other engine's time over the reference's, 95% interval, log axis. */
export function pairedLatencySvg(r: Receipt): string {
  const { p } = pairOf(r);
  const ops = Object.keys(p.latency);
  const W = 920, left = 250, right = 60, rowH = 30, top = 100;
  const H = top + ops.length * rowH + 70;
  const vals = ops.flatMap((o) => [p.latency[o].geo_mean_ratio.ci95?.[0] ?? p.latency[o].geo_mean_ratio.ratio, p.latency[o].geo_mean_ratio.ci95?.[1] ?? p.latency[o].geo_mean_ratio.ratio]);
  const lo = Math.min(0.1, ...vals) * 0.9, hi = Math.max(4, ...vals) * 1.1;
  const x = (v: number) => left + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - left - right);
  let s = svgOpen(W, H, 'Paired latency ratio per operation');
  s += text(24, 32, `${label(r, p.other)} time as a multiple of ${label(r, p.reference)} time`, { size: 20, weight: 700 });
  s += text(24, 54, `${title(r, 'Same query on both engines, back to back, random order')}. Dot is the geometric mean ratio, bar is the 95% interval.`, { size: 12, fill: C.muted });
  s += text(24, 72, `Left of the 1x line, ${label(r, p.other)} is faster. The ${r.decision_rule.ratio_margin}x line is the preregistered margin.`, { size: 12, fill: C.muted });
  for (const t of [0.1, 0.25, 0.5, 1, 2, 4, 8].filter((v) => v >= lo && v <= hi)) {
    const gx = x(t);
    s += `<line x1="${gx}" y1="${top - 10}" x2="${gx}" y2="${top + ops.length * rowH}" stroke="${t === 1 ? C.muted : t === r.decision_rule.ratio_margin ? C.mark : C.grid}" ${t === 1 || t === r.decision_rule.ratio_margin ? 'stroke-dasharray="4 3"' : ''}/>\n`;
    s += text(gx, top + ops.length * rowH + 18, `${t}x`, { size: 11, fill: C.muted, anchor: 'middle' });
  }
  ops.forEach((op, i) => {
    const y = top + i * rowH + 10;
    const g = p.latency[op].geo_mean_ratio;
    s += text(left - 12, y + 4, op, { size: 12, anchor: 'end' });
    if (g.ci95) s += `<line x1="${x(g.ci95[0])}" y1="${y}" x2="${x(g.ci95[1])}" y2="${y}" stroke="${colorOf(r, p.other)}" stroke-width="4" stroke-linecap="round"/>\n`;
    s += `<circle cx="${x(g.ratio)}" cy="${y}" r="5" fill="${C.text}"/>\n`;
    s += text(W - right + 8, y + 4, `${fmt(g.ratio)}x`, { size: 11, fill: C.muted });
  });
  s += text(24, H - 14, `n = ${p.latency[ops[0]].n} queries per operation. Source: ${r.generated_at.slice(0, 10)} receipt, paired.${pairOf(r).key}.latency`, { size: 11, fill: C.muted });
  return s + '</svg>\n';
}

/** Absolute p50 and p95 per engine from the paired phase, log axis. */
export function latencySvg(r: Receipt): string {
  const { p } = pairOf(r);
  const ops = Object.keys(p.latency);
  const ids = [p.reference, p.other];
  const W = 920, left = 230, right = 80, rowH = 16 * ids.length + 18, top = 96;
  const H = top + ops.length * rowH + 50;
  const get = (op: string, id: string, q: 'p50' | 'p95') => (id === p.reference ? p.latency[op][`ref_${q}_ms`] : p.latency[op][`other_${q}_ms`]);
  const all = ops.flatMap((o) => ids.flatMap((id) => [get(o, id, 'p50'), get(o, id, 'p95')])).filter((v) => v > 0);
  const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...all)) - 0.1));
  const hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...all))));
  const x = (v: number) => left + ((Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (W - left - right);
  let s = svgOpen(W, H, 'Latency per operation');
  s += text(24, 32, title(r, 'Latency per operation'), { size: 20, weight: 700 });
  s += text(24, 52, 'Solid bar is the median (p50). The tick is the 95th percentile (p95). Log scale, milliseconds, lower is better.', { size: 12, fill: C.muted });
  s += legend(r, 24, 76);
  for (let e = Math.log10(lo); e <= Math.log10(hi) + 1e-9; e++) {
    const gx = x(Math.pow(10, e));
    s += `<line x1="${gx}" y1="${top - 8}" x2="${gx}" y2="${top + ops.length * rowH}" stroke="${C.grid}"/>\n`;
    s += text(gx, top + ops.length * rowH + 18, `${fmt(Math.pow(10, e))} ms`, { size: 11, fill: C.muted, anchor: 'middle' });
  }
  ops.forEach((op, i) => {
    const y = top + i * rowH;
    s += text(left - 10, y + 12, op, { size: 12, anchor: 'end' });
    ids.forEach((id, j) => {
      const by = y + j * 16;
      const m = get(op, id, 'p50'), t = get(op, id, 'p95');
      s += `<rect x="${left}" y="${by}" width="${Math.max(2, x(m) - left)}" height="12" rx="2" fill="${colorOf(r, id)}"/>\n`;
      s += `<line x1="${x(t)}" y1="${by - 1}" x2="${x(t)}" y2="${by + 13}" stroke="${C.text}" stroke-width="2"/>\n`;
      s += text(x(Math.max(m, t)) + 8, by + 10, `${fmt(m)} / ${fmt(t)}`, { size: 11, fill: C.muted });
    });
  });
  return s + '</svg>\n';
}

interface FootRow { name: string; unit: string; better: 'lower' | 'higher'; vals: Record<string, number | null> }
export function footprintRows(r: Receipt): FootRow[] {
  const ids = armIds(r);
  const row = (name: string, unit: string, better: 'lower' | 'higher', f: (a: Arm) => number | null): FootRow => ({ name, unit, better, vals: Object.fromEntries(ids.map((id) => [id, f(r.arms[id])])) });
  return [
    row(`Bulk import of ${r.options.scale.toLocaleString('en-US')} pages`, 'pages/s', 'higher', (a) => a.run.import.pages_per_sec),
    row('Chunk upserts during import', 'chunks/s', 'higher', (a) => a.run.import.chunk_upserts_per_sec),
    row('Cold start to first answer', 'ms', 'lower', (a) => a.cold_start.median_total_ms),
    row('Peak memory (engine plus server)', 'MB', 'lower', (a) => (a.run.memory.client_engine_rss_bytes + (a.run.memory.server_peak_working_set_bytes ?? 0)) / MB),
    row('On-disk size, no WAL', 'MB', 'lower', (a) => a.disk.excl_wal_bytes / MB),
  ];
}

export function footprintSvg(r: Receipt): string {
  const ids = armIds(r);
  const rows = footprintRows(r);
  const W = 920, left = 420, right = 140, rowH = 22 * ids.length + 22, top = 96;
  const H = top + rows.length * rowH + 44;
  let s = svgOpen(W, H, 'Import, startup and footprint');
  s += text(24, 32, title(r, 'Import, cold start, memory and disk'), { size: 20, weight: 700 });
  s += text(24, 52, 'One measured run per engine, so no interval. Each row has its own scale.', { size: 12, fill: C.muted });
  s += legend(r, 24, 76);
  rows.forEach((row, i) => {
    const y = top + i * rowH;
    const max = Math.max(...ids.map((id) => row.vals[id] ?? 0), 1e-9);
    s += text(24, y + 14, `${row.name}, ${row.unit} (${row.better} is better)`, { size: 12 });
    ids.forEach((id, j) => {
      const v = row.vals[id];
      const by = y + j * 22;
      const bw = v === null ? 0 : ((W - left - right) * v) / max;
      s += `<rect x="${left}" y="${by}" width="${Math.max(2, bw)}" height="16" rx="2" fill="${colorOf(r, id)}"/>\n`;
      s += text(left + Math.max(2, bw) + 8, by + 13, v === null ? 'n/a' : fmt(v), { size: 12 });
    });
  });
  s += text(24, H - 14, 'Memory and disk definitions are in the report. Cold start has a warm OS file cache.', { size: 11, fill: C.muted });
  return s + '</svg>\n';
}

export function qualitySvg(r: Receipt): string {
  const ids = armIds(r);
  const modes = ['keyword', 'vector', 'hybrid'];
  const metrics: Array<[string, 'recall_at_5' | 'ndcg_at_10']> = [['Recall@5', 'recall_at_5'], ['nDCG@10', 'ndcg_at_10']];
  const W = 920, H = 410, left = 70, top = 100, plotH = 230;
  const groups = modes.flatMap((m) => metrics.map(([lab, key]) => ({ m, lab, key })));
  const gw = (W - left - 30) / groups.length;
  const bw = Math.min(40, (gw - 14) / ids.length);
  const all = groups.flatMap((g) => ids.map((id) => r.arms[id].run.quality[g.m][g.key]));
  const maxV = Math.max(0.05, Math.ceil(Math.max(...all) * 20) / 20);
  const y = (v: number) => top + plotH - (v / maxV) * plotH;
  const n = pairOf(r).p.quality.hybrid.recall_at_5.n_queries;
  let s = svgOpen(W, H, 'Retrieval quality');
  s += text(24, 32, title(r, `Retrieval quality on ${n} queries`), { size: 20, weight: 700 });
  s += text(24, 52, 'Same pages, same vectors, same queries on every engine. Higher is better. Hash vectors measure word overlap, not meaning.', { size: 12, fill: C.muted });
  s += legend(r, 24, 76);
  for (let t = 0; t <= 4; t++) {
    const v = (maxV * t) / 4;
    s += `<line x1="${left}" y1="${y(v)}" x2="${W - 20}" y2="${y(v)}" stroke="${C.grid}"/>\n`;
    s += text(left - 8, y(v) + 4, v.toFixed(2), { size: 11, fill: C.muted, anchor: 'end' });
  }
  groups.forEach((g, gi) => {
    const gx = left + gi * gw + (gw - bw * ids.length) / 2;
    ids.forEach((id, j) => {
      const v = r.arms[id].run.quality[g.m][g.key];
      s += `<rect x="${gx + j * bw}" y="${y(v)}" width="${bw - 3}" height="${top + plotH - y(v)}" rx="2" fill="${colorOf(r, id)}"/>\n`;
      s += text(gx + j * bw + (bw - 3) / 2, y(v) - 5, v.toFixed(3), { size: 10, fill: C.muted, anchor: 'middle' });
    });
    s += text(left + gi * gw + gw / 2, top + plotH + 20, g.lab, { size: 12, anchor: 'middle' });
    if (gi % 2 === 0) s += text(left + gi * gw + gw, top + plotH + 40, g.m, { size: 13, weight: 600, anchor: 'middle' });
  });
  return s + '</svg>\n';
}

/** Dollars per 1,000 operations, by operation, both engines, with the paired difference and its interval. */
export function costSvg(r: Receipt): string {
  const { p } = pairOf(r);
  const ops = Object.keys(p.cost_per_op);
  const ids = [p.reference, p.other];
  const W = 920, left = 190, right = 330, rowH = 56, top = 100;
  const H = top + ops.length * rowH + 80;
  const val = (op: string, id: string) => (id === p.reference ? p.cost_per_op[op].ref_usd_per_1k_ops : p.cost_per_op[op].other_usd_per_1k_ops);
  const max = Math.max(...ops.flatMap((o) => ids.map((id) => val(o, id))), 1e-12);
  let s = svgOpen(W, H, 'Cost per 1,000 operations');
  s += text(24, 32, title(r, 'Cost per 1,000 operations'), { size: 20, weight: 700 });
  s += text(24, 52, `Measured CPU seconds and memory held, priced at ${r.price_model.as_of} AWS Fargate list prices. Not a quote. Lower is better.`, { size: 12, fill: C.muted });
  s += legend(r, 24, 76);
  ops.forEach((op, i) => {
    const y = top + i * rowH;
    const c = p.cost_per_op[op];
    s += text(left - 12, y + 20, op, { size: 12, anchor: 'end' });
    ids.forEach((id, j) => {
      const v = val(op, id);
      const w = Math.max(2, ((W - left - right) * v) / max);
      s += `<rect x="${left}" y="${y + j * 20}" width="${w}" height="16" rx="2" fill="${colorOf(r, id)}"/>\n`;
      s += text(left + w + 8, y + j * 20 + 13, usd(v), { size: 11, fill: C.muted });
    });
    s += text(W - right + 120, y + 14, `${label(r, p.other)} minus ${label(r, p.reference)}`, { size: 11, fill: C.muted });
    s += text(W - right + 120, y + 30, `${usd(c.diff_usd_per_1k_ops.delta)}  (${fmtCI(c.diff_usd_per_1k_ops.ci95, usd)})`, { size: 11 });
  });
  const hosted = r.price_model.hosted_postgres.usd_per_hour * r.price_model.hours_per_month;
  s += text(24, H - 36, `Separate line: ${r.price_model.hosted_postgres.label} lists at about $${hosted.toFixed(2)} per month`, { size: 11, fill: C.muted });
  s += text(24, H - 20, 'regardless of query volume. A list-price assumption, not measured here.', { size: 11, fill: C.muted });
  return s + '</svg>\n';
}

/** With several brain sizes: the hybrid-search ratio and interval against size. */
export function scalingSvg(rs: Receipt[]): string {
  const sorted = [...rs].sort((a, b) => a.options.scale - b.options.scale);
  const W = 920, H = 420, left = 90, right = 60, top = 100, plotH = 240;
  const ops = ['search_hybrid_rrf', 'search_keyword', 'search_vector', 'get_page'].filter((o) => sorted.every((r) => pairOf(r).p.latency[o]));
  const colors = ['#f97316', '#38bdf8', '#16a34a', '#c084fc'];
  const get = (r: Receipt, op: string) => pairOf(r).p.latency[op].geo_mean_ratio;
  const all = sorted.flatMap((r) => ops.flatMap((o) => { const g = get(r, o); return [g.ratio, g.ci95?.[0] ?? g.ratio, g.ci95?.[1] ?? g.ratio]; }));
  const lo = Math.min(0.1, ...all) * 0.9, hi = Math.max(4, ...all) * 1.1;
  const y = (v: number) => top + plotH - ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * plotH;
  const xs = sorted.map((_, i) => left + ((i + 0.5) / sorted.length) * (W - left - right));
  const ref = pairOf(sorted[0]);
  let s = svgOpen(W, H, 'Latency ratio against brain size');
  s += text(24, 32, `${label(sorted[0], ref.p.other)} time as a multiple of ${label(sorted[0], ref.p.reference)} time, by brain size`, { size: 20, weight: 700 });
  s += text(24, 52, 'Geometric mean ratio of paired per-query times, 95% interval. Below the 1x line the other engine is faster. Log axis.', { size: 12, fill: C.muted });
  ops.forEach((o, i) => {
    s += `<rect x="${24 + i * 190}" y="64" width="10" height="10" rx="2" fill="${colors[i]}"/>\n` + text(40 + i * 190, 74, o, { size: 12 });
  });
  for (const t of [0.1, 0.25, 0.5, 1, 2, 4, 8].filter((v) => v >= lo && v <= hi)) {
    s += `<line x1="${left}" y1="${y(t)}" x2="${W - right}" y2="${y(t)}" stroke="${t === 1 ? C.muted : C.grid}" ${t === 1 ? 'stroke-dasharray="4 3"' : ''}/>\n`;
    s += text(left - 8, y(t) + 4, `${t}x`, { size: 11, fill: C.muted, anchor: 'end' });
  }
  sorted.forEach((r, i) => s += text(xs[i], top + plotH + 24, `${r.options.scale.toLocaleString('en-US')} pages`, { size: 12, anchor: 'middle' }));
  ops.forEach((o, k) => {
    const off = (k - (ops.length - 1) / 2) * 14;
    sorted.forEach((r, i) => {
      const g = get(r, o);
      if (g.ci95) s += `<line x1="${xs[i] + off}" y1="${y(g.ci95[0])}" x2="${xs[i] + off}" y2="${y(g.ci95[1])}" stroke="${colors[k]}" stroke-width="3" stroke-linecap="round"/>\n`;
      s += `<circle cx="${xs[i] + off}" cy="${y(g.ratio)}" r="4" fill="${colors[k]}" stroke="${C.bgPanel}"/>\n`;
    });
  });
  return s + '</svg>\n';
}

// ─── Markdown summary ───────────────────────────────────────────────

export function summaryMarkdown(rs: Receipt[]): string {
  const sorted = [...rs].sort((a, b) => a.options.scale - b.options.scale);
  let out = '';
  for (const r of sorted) {
    const { key, p } = pairOf(r);
    const n = r.options.scale.toLocaleString('en-US');
    const [A, B] = [label(r, p.reference), label(r, p.other)];
    out += `## ${n} pages\n\nReceipt generated ${r.generated_at}. Counted: ${r.counted ? 'yes' : 'no (dev run)'}. Comparison: \`${key}\`.\n\n`;
    out += `### Decision rule outcome\n\n**${p.decision.outcome}**. ${p.decision.reasons.join('. ')}.\n\n`;
    out += `### Paired latency (${B} over ${A})\n\n| Operation | n | ${A} p50 / p95 (ms) | ${B} p50 / p95 (ms) | Mean difference, ms (95% interval) | Ratio (95% interval) | Holm p |\n|---|---:|---:|---:|---:|---:|---:|\n`;
    for (const [op, l] of Object.entries(p.latency)) {
      out += `| ${op} | ${l.n} | ${fmt(l.ref_p50_ms)} / ${fmt(l.ref_p95_ms)} | ${fmt(l.other_p50_ms)} / ${fmt(l.other_p95_ms)} | ${fmt(l.diff_ms.delta)} (${fmtCI(l.diff_ms.ci95)}) | ${fmt(l.geo_mean_ratio.ratio)} (${fmtCI(l.geo_mean_ratio.ci95)}) | ${l.p_holm === null ? 'n/a' : fmt(l.p_holm)} |\n`;
    }
    out += `\nOrder check, mean difference in ms by who ran first:\n\n| Operation | ${A} first (n) | ${B} first (n) |\n|---|---:|---:|\n`;
    for (const [op, l] of Object.entries(p.latency)) {
      out += `| ${op} | ${fmt(l.by_order.ref_first.mean_diff_ms)} (${l.by_order.ref_first.n}) | ${fmt(l.by_order.other_first.mean_diff_ms)} (${l.by_order.other_first.n}) |\n`;
    }
    out += `\n### Cost per 1,000 operations (price model ${r.price_model.as_of})\n\n| Operation | blocks x ops | ${A} USD | ${B} USD | Difference, USD (95% interval) | ${A} CPU s | ${B} CPU s | CPU s difference (95% interval) |\n|---|---:|---:|---:|---:|---:|---:|---:|\n`;
    for (const [op, c] of Object.entries(p.cost_per_op)) {
      out += `| ${op} | ${c.blocks} x ${c.ops_per_block} | ${usd(c.ref_usd_per_1k_ops)} | ${usd(c.other_usd_per_1k_ops)} | ${usd(c.diff_usd_per_1k_ops.delta)} (${fmtCI(c.diff_usd_per_1k_ops.ci95, usd)}) | ${fmt(c.ref_cpu_s_per_1k_ops)} | ${fmt(c.other_cpu_s_per_1k_ops)} | ${fmt(c.diff_cpu_s_per_1k_ops.delta)} (${fmtCI(c.diff_cpu_s_per_1k_ops.ci95)}) |\n`;
    }
    out += `\n### Quality, paired per query\n\n| Mode | Metric | n | ${A} | ${B} | Difference (95% interval) | Queries that differ |\n|---|---|---:|---:|---:|---:|---:|\n`;
    for (const [mode, q] of Object.entries(p.quality)) {
      for (const [name, v] of [['Recall@5', q.recall_at_5], ['nDCG@10', q.ndcg_at_10]] as const) {
        out += `| ${mode} | ${name} | ${v.n_queries} | ${fmt(v.ref_mean)} | ${fmt(v.other_mean)} | ${fmt(v.diff.delta)} (${fmtCI(v.diff.ci95)}) | ${v.queries_that_differ} |\n`;
      }
    }
    out += `\n### Descriptive, one run each\n\n| Measure | ${A} | ${B} |\n|---|---:|---:|\n`;
    for (const f of footprintRows(r)) out += `| ${f.name} (${f.unit}) | ${fmt(f.vals[p.reference])} | ${fmt(f.vals[p.other])} |\n`;
    const q = (id: string) => r.arms[id].run.quality;
    out += `| Empty keyword result rate | ${fmt(q(p.reference).keyword.empty_result_rate)} | ${fmt(q(p.other).keyword.empty_result_rate)} |\n`;
    out += `| CPU seconds per 1,000 mixed queries | ${fmt(r.arms[p.reference].run.cost_window.cpu_seconds_per_1k)} | ${fmt(r.arms[p.other].run.cost_window.cpu_seconds_per_1k)} |\n`;
    out += `| USD per 1,000 mixed queries | ${usd(r.arms[p.reference].cost.usd_per_1k_queries.total_usd)} | ${usd(r.arms[p.other].cost.usd_per_1k_queries.total_usd)} |\n\n`;
  }
  return out;
}

// ─── CLI ────────────────────────────────────────────────────────────

export function writeCharts(rs: Receipt[], outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const files: Array<[string, string]> = [];
  for (const r of rs) {
    const n = r.options.scale;
    files.push([`paired-latency-${n}.svg`, pairedLatencySvg(r)], [`latency-${n}.svg`, latencySvg(r)], [`footprint-${n}.svg`, footprintSvg(r)],
      [`quality-${n}.svg`, qualitySvg(r)], [`cost-${n}.svg`, costSvg(r)]);
  }
  if (rs.length > 1) files.push(['scaling.svg', scalingSvg(rs)]);
  files.push(['summary.md', summaryMarkdown(rs)]);
  for (const [name, body] of files) writeFileSync(join(outDir, name), body);
  return files.map(([n]) => join(outDir, n));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const oi = argv.indexOf('--out');
  const inputs = argv.filter((a, i) => a.endsWith('.json') && argv[i - 1] !== '--out');
  if (!inputs.length || oi === -1) {
    console.error('usage: bun eval/runner/engine-shootout-chart.ts <receipt.json> [<receipt.json> ...] --out <dir>');
    process.exit(1);
  }
  const receipts = inputs.map((f) => JSON.parse(readFileSync(f, 'utf-8')) as Receipt);
  for (const f of writeCharts(receipts, resolve(argv[oi + 1]))) console.log(f);
}
