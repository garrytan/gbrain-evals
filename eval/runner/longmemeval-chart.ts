/**
 * Generate SVG charts from a longmemeval runner/aggregate JSON output.
 * Inline-SVG so GitHub markdown renders it without an external image host.
 *
 * FEATURE BOUNDARY: presentation only — no gbrain code runs here, no metric
 * math beyond reading the summary fields the runner/aggregate wrote.
 *
 * Charts plot recall_all@k (the official LongMemEval headline; see
 * longmemeval.ts header). Inputs produced by the pre-2026-08-31 pipeline
 * only carry the inflating any-hit `recall_at_k` — those are REJECTED with
 * instructions to re-aggregate rather than silently charted as recall_all
 * (audit finding longmemeval-01). Titles carry the actual dataset name and
 * question count from the input, never a hardcoded "full 500 questions"
 * (audit finding longmemeval-09).
 *
 * Run:
 *   bun eval/runner/longmemeval-chart.ts <runner-output.json> [<runner-output.json> ...]
 *   bun eval/runner/longmemeval-chart.ts --merge a.json b.json   # combine adapters from two files
 *
 * Writes <input>.headline.svg + <input>.per-type.svg next to each input file.
 */

import { readFileSync, writeFileSync } from 'fs';
import type { RunSummary } from './longmemeval.ts';

interface RunnerOutput {
  opts: { datasetName: string; topK: number };
  summaries: RunSummary[];
}

/**
 * Refuse legacy summaries: `recall_at_k` (any-hit) is a strictly looser
 * metric than recall_all@k and must never be charted next to published
 * recall_all baselines. Re-run longmemeval-aggregate.ts on the NDJSON stream
 * (it recomputes recall_all from retrieved+ground_truth, legacy rows
 * included) to get a chartable summary.
 */
export function assertChartable(data: RunnerOutput, source: string): void {
  if (!Array.isArray(data.summaries) || data.summaries.length === 0) {
    throw new Error(`${source}: no summaries to chart`);
  }
  for (const s of data.summaries) {
    if (typeof s.recall_all_at_k !== 'number') {
      throw new Error(
        `${source}: adapter ${s.adapter} has no recall_all_at_k — this is a legacy any-hit summary. ` +
        `Re-aggregate the NDJSON with longmemeval-aggregate.ts; any-hit numbers are not comparable to published recall_all baselines.`,
      );
    }
  }
  if (typeof data.opts?.topK !== 'number' || typeof data.opts?.datasetName !== 'string' || data.opts.datasetName === '') {
    throw new Error(`${source}: opts.topK/opts.datasetName missing — cannot label the chart honestly`);
  }
}

/** "n=500" when every adapter scored the same count, "n=60–500 per adapter" otherwise. */
export function nLabel(summaries: RunSummary[]): string {
  const totals = [...new Set(summaries.map(s => s.total))].sort((a, b) => a - b);
  return totals.length === 1 ? `n=${totals[0]}` : `n varies ${totals[0]}–${totals[totals.length - 1]} per adapter`;
}

export function chartTitle(data: RunnerOutput): string {
  return `recall_all@${data.opts.topK} on LongMemEval _${data.opts.datasetName} — ${nLabel(data.summaries)}`;
}

// External published baselines for comparison context. ONLY strict
// session-level recall_all@K numbers belong here (every gold session in the
// top-K distinct sessions) — the metric our headline plots. Published any-hit
// numbers (MemPalace's 96.6% / 98.4% / "100%" are recall_any@5 per their own
// script, which computes recall_all but never prints it) and LLM-judged QA
// accuracy (Mastra, Mem0, MemCog, Zep, …) must NEVER be charted here. Keep in
// sync with docs/comparison-systems.md and re-check sources quarterly.
interface ExternalBaseline {
  label: string;
  recall: number;          // recall_all@K, as a fraction
  topK: number;
  questions: number;
  source: string;
}
const EXTERNAL_BASELINES: ExternalBaseline[] = [
  {
    // Our recomputation of recall_all@5 from MemPalace's committed per-question
    // rankings (results_mempal_raw_session_20260414_1629.jsonl) joined to the
    // official gold labels; their logged any-hit reproduced with 0 mismatches.
    label: 'MemPalace raw (strict, recomputed)',
    recall: 0.857,
    topK: 5,
    questions: 470,
    source: 'github.com/MemPalace/mempalace benchmarks/results_mempal_raw_session_20260414_1629.jsonl (recomputed recall_all@5; published 96.6% is any-hit)',
  },
  {
    label: 'MemPalace hybrid v4 + LLM rerank (strict, recomputed)',
    recall: 0.900,
    topK: 5,
    questions: 470,
    source: 'github.com/MemPalace/mempalace benchmarks/results_mempal_hybrid_v4_llmrerank_session_20260414_1659.jsonl (recomputed recall_all@5; LLM reranker in the loop)',
  },
  {
    // Loosely comparable: same All@5 definition on the cleaned split, but the
    // rerank layer reads gold labels during the run (leakage caveat).
    label: 'ContextFit fusion All@5 (self-reported, leak caveat)',
    recall: 0.8745,
    topK: 5,
    questions: 470,
    source: 'context.fit/longmemeval-fusion-20260519.html (All@5 = all gold sessions in top-5 distinct; gold-label-aware rerank)',
  },
];

const COLORS = {
  hybrid: '#16a34a',      // green-600 — primary gbrain (hybrid family)
  vector: '#10b981',      // emerald-500 — gbrain vector-only (slightly different green)
  keyword: '#6b7280',     // gray-500 — keyword baseline (deemphasized)
  external: '#f59e0b',    // amber-500 — published competitor numbers
  bgPanel: '#0a0a0a',
  bgCard: '#171717',
  text: '#e5e7eb',
  textMuted: '#9ca3af',
  axis: '#404040',
  grid: '#262626',
};

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

function adapterColor(name: string): string {
  if (name.includes('hybrid')) return COLORS.hybrid;
  if (name.includes('vector')) return COLORS.vector;
  if (name.includes('keyword')) return COLORS.keyword;
  return COLORS.external;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Headline horizontal bar chart ──────────────────────────────────

export function headlineCard(data: RunnerOutput): string {
  const summaries = data.summaries;
  const topK = data.opts.topK;
  // Rows: gbrain adapters + applicable external baselines.
  interface Row {
    label: string;
    sub: string;
    recall: number;
    color: string;
    isUs: boolean;
  }
  const rows: Row[] = [];
  for (const s of summaries) {
    rows.push({
      label: s.adapter,
      sub: `n=${s.total} · k=${s.topK}`,
      recall: s.recall_all_at_k ?? 0,
      color: adapterColor(s.adapter),
      isUs: true,
    });
  }
  for (const b of EXTERNAL_BASELINES.filter(b => b.topK === topK)) {
    rows.push({
      label: b.label,
      sub: `n=${b.questions} · k=${b.topK} · published`,
      recall: b.recall,
      color: COLORS.external,
      isUs: false,
    });
  }
  // Sort by recall descending so the top performer leads the eye.
  rows.sort((a, b) => b.recall - a.recall);

  const W = 880;
  const padL = 220;       // wide enough for "gbrain-hybrid+expansion" + "MemPal hybrid v4 + Haiku rerank"
  const padR = 90;        // room for value label + tail
  const padT = 24;
  const padB = 36;
  const rowH = 40;
  const barH = 22;
  const H = padT + rows.length * rowH + padB;
  const plotW = W - padL - padR;

  // Axis grid every 20% so the eye can read off precise values without cluttering bars.
  const grid: string[] = [];
  for (let v = 0.2; v <= 1.0; v += 0.2) {
    const x = padL + plotW * v;
    grid.push(`<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + rows.length * rowH}" stroke="${COLORS.grid}" stroke-width="1" />`);
    grid.push(`<text x="${x}" y="${padT + rows.length * rowH + 18}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,monospace" font-size="10" fill="${COLORS.textMuted}">${(v * 100).toFixed(0)}%</text>`);
  }

  const rowsXml = rows.map((r, i) => {
    const yMid = padT + i * rowH + rowH / 2;
    const barY = yMid - barH / 2;
    const w = plotW * r.recall;
    const labelWeight = r.isUs ? 600 : 400;
    const labelFill = r.isUs ? COLORS.text : COLORS.textMuted;
    const valueFill = r.color;
    const valueX = padL + w + 8;
    return `
      <text x="${padL - 12}" y="${yMid + 4}" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" font-weight="${labelWeight}" fill="${labelFill}">${escapeXml(r.label)}</text>
      <rect x="${padL}" y="${barY}" width="${w}" height="${barH}" rx="3" fill="${r.color}" opacity="${r.isUs ? 1.0 : 0.7}" />
      <text x="${valueX}" y="${yMid + 4}" text-anchor="start" font-family="ui-monospace,SFMono-Regular,monospace" font-size="13" font-weight="700" fill="${valueFill}">${pct(r.recall)}</text>
      <text x="${padL - 12}" y="${yMid + 18}" text-anchor="end" font-family="ui-monospace,SFMono-Regular,monospace" font-size="10" fill="${COLORS.textMuted}">${escapeXml(r.sub)}</text>
    `;
  }).join('');

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${COLORS.bgPanel}" />
  <text x="${padL}" y="16" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" fill="${COLORS.textMuted}">${escapeXml(chartTitle(data))}</text>
  ${grid.join('\n  ')}
  ${rowsXml}
</svg>
`.trim();
}

// ─── Per-type grouped bar chart ─────────────────────────────────────

export function perTypeChart(data: RunnerOutput): string {
  const summaries = data.summaries;
  const topK = data.opts.topK;
  // Pull all question_types in stable order across summaries.
  const types: string[] = [];
  for (const s of summaries) {
    for (const t of Object.keys(s.recall_by_type)) {
      if (!types.includes(t)) types.push(t);
    }
  }
  // Stable order: easiest to hardest based on hybrid recall_all.
  const sorter = summaries.find(s => s.adapter.includes('hybrid')) ?? summaries[0];
  types.sort((a, b) => {
    const ra = sorter.recall_by_type[a]?.recall_all ?? 0;
    const rb = sorter.recall_by_type[b]?.recall_all ?? 0;
    return rb - ra;
  });

  const adapters = summaries;
  const externals = EXTERNAL_BASELINES.filter(b => b.topK === topK).slice(0, 1); // first matching K only
  // External baselines are per-system overall — render as a horizontal reference line.

  const W = 880;
  const H = 360;
  const padL = 200, padR = 40, padT = 32, padB = 60;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const groupH = plotH / Math.max(types.length, 1);
  const barH = (groupH - 8) / Math.max(adapters.length, 1);
  const maxX = 1.0;

  // Grid lines (every 20%)
  const gridLines: string[] = [];
  for (let v = 0.2; v <= 1.0; v += 0.2) {
    const x = padL + plotW * (v / maxX);
    gridLines.push(`<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${COLORS.grid}" stroke-width="1" />`);
    gridLines.push(`<text x="${x}" y="${padT + plotH + 18}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,monospace" font-size="10" fill="${COLORS.textMuted}">${(v * 100).toFixed(0)}%</text>`);
  }

  const rows: string[] = [];
  for (let ti = 0; ti < types.length; ti++) {
    const t = types[ti];
    const yGroup = padT + ti * groupH + 4;
    rows.push(`<text x="${padL - 12}" y="${yGroup + groupH / 2 + 4}" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" fill="${COLORS.text}">${escapeXml(t)}</text>`);
    for (let ai = 0; ai < adapters.length; ai++) {
      const a = adapters[ai];
      const v = a.recall_by_type[t]?.recall_all ?? 0;
      const w = plotW * (v / maxX);
      const y = yGroup + ai * (barH + 2);
      rows.push(`<rect x="${padL}" y="${y}" width="${w}" height="${barH}" fill="${adapterColor(a.adapter)}" />`);
      // Label inside or right of bar
      const labelText = pct(v);
      const labelX = w > 50 ? padL + w - 6 : padL + w + 6;
      const labelAnchor = w > 50 ? 'end' : 'start';
      const labelFill = w > 50 ? '#000' : COLORS.text;
      rows.push(`<text x="${labelX}" y="${y + barH / 2 + 4}" text-anchor="${labelAnchor}" font-family="ui-monospace,SFMono-Regular,monospace" font-size="11" font-weight="600" fill="${labelFill}">${labelText}</text>`);
    }
  }

  // External reference line (overall recall_all, not per-type)
  const refLines = externals.map(b => {
    const x = padL + plotW * b.recall;
    return `
      <line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${COLORS.external}" stroke-width="1" stroke-dasharray="4,3" />
      <text x="${x}" y="${padT - 8}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="${COLORS.external}">${escapeXml(b.label)} ${pct(b.recall)}</text>
    `;
  }).join('');

  // Legend
  const legend: string[] = [];
  let lx = padL;
  for (const a of adapters) {
    legend.push(`<rect x="${lx}" y="${H - 18}" width="14" height="10" fill="${adapterColor(a.adapter)}" />`);
    legend.push(`<text x="${lx + 20}" y="${H - 8}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="${COLORS.text}">${escapeXml(a.adapter)} (k=${a.topK}, n=${a.total})</text>`);
    lx += 220;
  }

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${COLORS.bgPanel}" />
  <text x="${padL}" y="20" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" fill="${COLORS.text}">recall_all@${topK} by question_type — LongMemEval _${escapeXml(data.opts.datasetName)}, ${escapeXml(nLabel(summaries))}</text>
  ${gridLines.join('\n  ')}
  ${rows.join('\n  ')}
  ${refLines}
  ${legend.join('\n  ')}
</svg>
`.trim();
}

// ─── Main ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('usage: bun longmemeval-chart.ts <runner-output.json> [...]\n');
    process.stderr.write('       bun longmemeval-chart.ts --merge a.json b.json\n');
    process.exit(1);
  }

  try {
    if (args[0] === '--merge') {
      const inputs = args.slice(1);
      if (inputs.length < 2) {
        process.stderr.write('--merge needs at least 2 inputs\n');
        process.exit(1);
      }
      const merged: RunnerOutput = { opts: { datasetName: '', topK: 0 }, summaries: [] };
      for (const f of inputs) {
        const data = JSON.parse(readFileSync(f, 'utf8')) as RunnerOutput;
        assertChartable(data, f);
        // Merging different datasets or K values would mislabel the chart —
        // refuse instead of last-write-wins (audit finding longmemeval-09).
        if (merged.summaries.length > 0
          && (merged.opts.datasetName !== data.opts.datasetName || merged.opts.topK !== data.opts.topK)) {
          throw new Error(`--merge inputs disagree: ${merged.opts.datasetName}@k=${merged.opts.topK} vs ${f} ${data.opts.datasetName}@k=${data.opts.topK}`);
        }
        merged.opts.datasetName = data.opts.datasetName;
        merged.opts.topK = data.opts.topK;
        merged.summaries.push(...data.summaries);
      }
      const stem = inputs[0].replace(/\.json$/, '');
      writeFileSync(stem + '.headline.svg', headlineCard(merged) + '\n');
      writeFileSync(stem + '.per-type.svg', perTypeChart(merged) + '\n');
      process.stderr.write(`wrote ${stem}.headline.svg + ${stem}.per-type.svg (merged from ${inputs.length} files)\n`);
    } else {
      for (const f of args) {
        const data = JSON.parse(readFileSync(f, 'utf8')) as RunnerOutput;
        assertChartable(data, f);
        const stem = f.replace(/\.json$/, '');
        writeFileSync(stem + '.headline.svg', headlineCard(data) + '\n');
        writeFileSync(stem + '.per-type.svg', perTypeChart(data) + '\n');
        process.stderr.write(`wrote ${stem}.headline.svg + ${stem}.per-type.svg\n`);
      }
    }
  } catch (e: any) {
    process.stderr.write(`[longmemeval-chart] FATAL: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}
