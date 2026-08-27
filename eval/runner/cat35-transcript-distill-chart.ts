/**
 * Cat 35 chart generator — renders the receipt JSON into committed SVGs.
 *
 *   bun eval/runner/cat35-transcript-distill-chart.ts <receipt.json> [--out <dir>]
 *
 * Emits (inline-SVG, GitHub-renderable, longmemeval-chart.ts conventions):
 *   <stem>.headline.svg  — salient-unit recall per lane (macro + CI) with
 *                          HaluMem context rows (different corpus, labeled)
 *   <stem>.by-kind.svg   — grouped bars: recall by kind × lane
 *   <stem>.noise.svg     — distractor leakage + triage separation panel
 *
 * Default output: alongside the input receipt. Pass --out
 * docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill/ to publish.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const COLORS = {
  dream: '#16a34a', // green-600 — the headline lane
  facts: '#10b981', // emerald-500 — memory-write lane
  verbatim: '#6b7280', // gray-500 — control/floor (deemphasized)
  external: '#f59e0b', // amber-500 — published context numbers
  bgPanel: '#0a0a0a',
  bgCard: '#171717',
  text: '#e5e7eb',
  textMuted: '#9ca3af',
  axis: '#404040',
  grid: '#262626',
  bad: '#ef4444',
};

const LANE_ORDER = ['dream', 'facts', 'verbatim'] as const;

// Published write-path context rows (different corpus — labeled as such).
// These numbers also live in docs/comparison-systems.md, README.md, and the
// report §5 — update all four together when HaluMem republishes (CLAUDE.md's
// living-comparison rule).
const CONTEXT_ROWS = [
  { label: 'Mem0 (HaluMem-Medium)', recall: 0.429, source: 'arXiv 2511.03506 — different corpus' },
  { label: 'Supermemory (HaluMem-Medium)', recall: 0.415, source: 'arXiv 2511.03506 — different corpus' },
];

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

function laneColor(lane: string): string {
  return (COLORS as Record<string, string>)[lane] ?? COLORS.external;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Receipt {
  mode: string;
  gbrain_version: string;
  judge_model: string;
  coverage_by_lane: Record<string, { macro: number; micro: number; strict: number; ci_lo: number; ci_hi: number }>;
  coverage_by_kind: Record<string, Record<string, number>>;
  distractor_leakage: Record<string, { rate: number; confirmed: number }>;
  triage: { verdicts: Array<{ transcript_id: string; score: number; expected: 'high' | 'low' }>; threshold_curve: Array<{ threshold: number; high_pass_rate: number; low_pass_rate: number }> };
  transcripts: string[];
}

// ─── Headline card: horizontal bars, lanes + context rows ────────────────

function headlineCard(r: Receipt): string {
  interface Row { label: string; sub: string; recall: number; ci?: [number, number]; color: string; isUs: boolean }
  const rows: Row[] = [];
  for (const lane of LANE_ORDER) {
    const c = r.coverage_by_lane[lane];
    if (!c) continue;
    rows.push({
      label: `gbrain ${lane}${lane === 'dream' ? ' (headline)' : lane === 'verbatim' ? ' (control)' : ''}`,
      // n = SIGNAL transcripts (the macro denominator population), not all
      // evaluated transcripts — pure-routine controls carry no gold items.
      sub: `macro · strict ${pct(c.strict)} · n=${(r as { signal_transcripts?: number }).signal_transcripts ?? r.transcripts?.length ?? '?'} signal`,
      recall: c.macro,
      ci: [c.ci_lo, c.ci_hi],
      color: laneColor(lane),
      isUs: true,
    });
  }
  for (const b of CONTEXT_ROWS) {
    rows.push({ label: b.label, sub: b.source, recall: b.recall, color: COLORS.external, isUs: false });
  }

  const W = 880;
  const padL = 250;
  const padR = 90;
  const rowH = 44;
  const barH = 22;
  const headerH = 78;
  const H = headerH + rows.length * rowH + 30;
  const plotW = W - padL - padR;
  const x = (v: number) => padL + v * plotW;

  let bars = '';
  rows.forEach((row, i) => {
    const y = headerH + i * rowH;
    const op = row.isUs ? 1.0 : 0.7;
    const w = Math.max(2, row.recall * plotW);
    bars += `
  <text x="${padL - 10}" y="${y + 10}" text-anchor="end" fill="${COLORS.text}" font-size="13" font-weight="${row.isUs ? 700 : 400}" font-family="ui-sans-serif,system-ui">${escapeXml(row.label)}</text>
  <text x="${padL - 10}" y="${y + 25}" text-anchor="end" fill="${COLORS.textMuted}" font-size="10" font-family="ui-sans-serif,system-ui">${escapeXml(row.sub)}</text>
  <rect x="${padL}" y="${y + 2}" width="${w}" height="${barH}" rx="3" fill="${row.color}" opacity="${op}"/>`;
    if (row.ci) {
      const cx1 = x(row.ci[0]);
      const cx2 = x(row.ci[1]);
      const cy = y + 2 + barH / 2;
      bars += `
  <line x1="${cx1}" y1="${cy}" x2="${cx2}" y2="${cy}" stroke="${COLORS.text}" stroke-width="1.5" opacity="0.9"/>
  <line x1="${cx1}" y1="${cy - 4}" x2="${cx1}" y2="${cy + 4}" stroke="${COLORS.text}" stroke-width="1.5" opacity="0.9"/>
  <line x1="${cx2}" y1="${cy - 4}" x2="${cx2}" y2="${cy + 4}" stroke="${COLORS.text}" stroke-width="1.5" opacity="0.9"/>`;
    }
    bars += `
  <text x="${padL + w + 8}" y="${y + 17}" fill="${COLORS.text}" font-size="12" font-family="ui-monospace,SFMono-Regular" font-weight="${row.isUs ? 700 : 400}">${pct(row.recall)}</text>`;
  });

  let gridLines = '';
  for (const v of [0, 0.25, 0.5, 0.75, 1.0]) {
    gridLines += `
  <line x1="${x(v)}" y1="${headerH - 8}" x2="${x(v)}" y2="${H - 26}" stroke="${COLORS.grid}" stroke-width="1"/>
  <text x="${x(v)}" y="${H - 10}" text-anchor="middle" fill="${COLORS.textMuted}" font-size="10" font-family="ui-monospace,SFMono-Regular">${v * 100}%</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${COLORS.bgPanel}" rx="8"/>
  <text x="20" y="28" fill="${COLORS.text}" font-size="16" font-weight="700" font-family="ui-sans-serif,system-ui">Cat 35 — salient-unit recall: what survives transcript → brain page</text>
  <text x="20" y="48" fill="${COLORS.textMuted}" font-size="11" font-family="ui-sans-serif,system-ui">FULL/PARTIAL/ABSENT → 1/0.5/0 · macro over transcripts, whiskers = bootstrap 95% CI · amber rows are HaluMem-published write-path numbers on a DIFFERENT corpus (context, not head-to-head) · mode=${escapeXml(r.mode)} · gbrain v${escapeXml(r.gbrain_version)} · judge ${escapeXml(r.judge_model)}</text>
${gridLines}
${bars}
</svg>
`;
}

// ─── Recall by kind × lane grouped bars ───────────────────────────────────

function byKindChart(r: Receipt): string {
  const kinds = ['fact', 'idea', 'decision', 'vibe', 'entity'].filter((k) => r.coverage_by_kind[k]);
  const lanes = LANE_ORDER.filter((l) => r.coverage_by_lane[l]);
  const W = 880;
  const padL = 60;
  const padB = 60;
  const padT = 70;
  const H = 360;
  const plotW = W - padL - 30;
  const plotH = H - padT - padB;
  const groupW = plotW / kinds.length;
  const barW = Math.min(34, (groupW - 20) / lanes.length);
  const y = (v: number) => padT + (1 - v) * plotH;

  let grid = '';
  for (const v of [0, 0.25, 0.5, 0.75, 1.0]) {
    grid += `
  <line x1="${padL}" y1="${y(v)}" x2="${W - 30}" y2="${y(v)}" stroke="${COLORS.grid}" stroke-width="1"/>
  <text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end" fill="${COLORS.textMuted}" font-size="10" font-family="ui-monospace,SFMono-Regular">${v * 100}%</text>`;
  }
  let bars = '';
  kinds.forEach((kind, ki) => {
    const gx = padL + ki * groupW + (groupW - lanes.length * barW - (lanes.length - 1) * 4) / 2;
    lanes.forEach((lane, li) => {
      const v = r.coverage_by_kind[kind]?.[lane] ?? 0;
      const bx = gx + li * (barW + 4);
      bars += `
  <rect x="${bx}" y="${y(v)}" width="${barW}" height="${Math.max(1, padT + plotH - y(v))}" rx="2" fill="${laneColor(lane)}"/>
  <text x="${bx + barW / 2}" y="${y(v) - 4}" text-anchor="middle" fill="${COLORS.textMuted}" font-size="9" font-family="ui-monospace,SFMono-Regular">${Math.round(v * 100)}</text>`;
    });
    bars += `
  <text x="${padL + ki * groupW + groupW / 2}" y="${H - padB + 18}" text-anchor="middle" fill="${COLORS.text}" font-size="12" font-family="ui-sans-serif,system-ui">${kind}</text>`;
  });
  let legend = '';
  lanes.forEach((lane, i) => {
    const lx = padL + i * 130;
    legend += `
  <rect x="${lx}" y="${H - 24}" width="12" height="12" rx="2" fill="${laneColor(lane)}"/>
  <text x="${lx + 18}" y="${H - 14}" fill="${COLORS.text}" font-size="11" font-family="ui-sans-serif,system-ui">${lane}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${COLORS.bgPanel}" rx="8"/>
  <text x="20" y="28" fill="${COLORS.text}" font-size="15" font-weight="700" font-family="ui-sans-serif,system-ui">Salient-unit recall by kind × lane</text>
  <text x="20" y="46" fill="${COLORS.textMuted}" font-size="11" font-family="ui-sans-serif,system-ui">The vibes column is the axis no other benchmark measures — descriptive breakdown, single run</text>
${grid}
${bars}
${legend}
</svg>
`;
}

// ─── Noise panel: leakage bars + triage score strip ───────────────────────

function noisePanel(r: Receipt): string {
  const W = 880;
  const H = 300;
  const midX = 430;

  // Left: distractor leakage per lane.
  let leak = '';
  const lanes = LANE_ORDER.filter((l) => r.distractor_leakage[l]);
  lanes.forEach((lane, i) => {
    const yy = 90 + i * 44;
    const rate = r.distractor_leakage[lane].rate;
    const w = Math.max(2, rate * 300);
    leak += `
  <text x="120" y="${yy + 14}" text-anchor="end" fill="${COLORS.text}" font-size="12" font-family="ui-sans-serif,system-ui">${lane}</text>
  <rect x="130" y="${yy}" width="${w}" height="20" rx="3" fill="${lane === 'verbatim' ? COLORS.verbatim : COLORS.bad}" opacity="${lane === 'verbatim' ? 0.5 : 0.9}"/>
  <text x="${134 + w}" y="${yy + 14}" fill="${COLORS.text}" font-size="11" font-family="ui-monospace,SFMono-Regular">${pct(rate)}</text>`;
  });

  // Right: triage score strip (high = green dots, low = amber), 0..1 axis.
  const stripX = midX + 40;
  const stripW = 330;
  const sx = (v: number) => stripX + v * stripW;
  let strip = `
  <line x1="${stripX}" y1="150" x2="${stripX + stripW}" y2="150" stroke="${COLORS.axis}" stroke-width="1.5"/>`;
  for (const v of [0, 0.3, 0.5, 0.7, 1.0]) {
    strip += `
  <line x1="${sx(v)}" y1="145" x2="${sx(v)}" y2="155" stroke="${COLORS.axis}" stroke-width="1"/>
  <text x="${sx(v)}" y="172" text-anchor="middle" fill="${COLORS.textMuted}" font-size="9" font-family="ui-monospace,SFMono-Regular">${v}</text>`;
  }
  strip += `
  <line x1="${sx(0.5)}" y1="95" x2="${sx(0.5)}" y2="150" stroke="${COLORS.textMuted}" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="${sx(0.5)}" y="88" text-anchor="middle" fill="${COLORS.textMuted}" font-size="9" font-family="ui-sans-serif,system-ui">gate 0.5</text>`;
  for (const v of r.triage.verdicts) {
    const cy = v.expected === 'high' ? 120 : 135;
    strip += `
  <circle cx="${sx(Math.max(0, Math.min(1, v.score)))}" cy="${cy}" r="5" fill="${v.expected === 'high' ? COLORS.dream : COLORS.external}" opacity="0.85"/>`;
  }
  strip += `
  <circle cx="${stripX}" cy="205" r="5" fill="${COLORS.dream}"/>
  <text x="${stripX + 12}" y="209" fill="${COLORS.text}" font-size="11" font-family="ui-sans-serif,system-ui">expected-high transcript</text>
  <circle cx="${stripX + 190}" cy="205" r="5" fill="${COLORS.external}"/>
  <text x="${stripX + 202}" y="209" fill="${COLORS.text}" font-size="11" font-family="ui-sans-serif,system-ui">pure-routine</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${COLORS.bgPanel}" rx="8"/>
  <text x="20" y="28" fill="${COLORS.text}" font-size="15" font-weight="700" font-family="ui-sans-serif,system-ui">Noise handling</text>
  <text x="20" y="46" fill="${COLORS.textMuted}" font-size="11" font-family="ui-sans-serif,system-ui">Left: planted-distractor leakage (verbatim keeps everything by construction — the floor). Right: triage separation, one dot per transcript.</text>
  <text x="20" y="74" fill="${COLORS.text}" font-size="12" font-weight="600" font-family="ui-sans-serif,system-ui">Distractor leakage</text>
  <text x="${midX + 40}" y="74" fill="${COLORS.text}" font-size="12" font-weight="600" font-family="ui-sans-serif,system-ui">Triage separation (score 0..1)</text>
${leak}
${strip}
</svg>
`;
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  if (!input) {
    process.stderr.write('usage: bun eval/runner/cat35-transcript-distill-chart.ts <receipt.json> [--out <dir>]\n');
    process.exit(2);
  }
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : dirname(input);
  mkdirSync(outDir, { recursive: true });
  const receipt = JSON.parse(readFileSync(input, 'utf8')) as Receipt;
  const stem = basename(input).replace(/\.json$/, '');
  const outputs: Array<[string, string]> = [
    [`${stem}.headline.svg`, headlineCard(receipt)],
    [`${stem}.by-kind.svg`, byKindChart(receipt)],
    [`${stem}.noise.svg`, noisePanel(receipt)],
  ];
  for (const [name, svg] of outputs) {
    const p = join(outDir, name);
    writeFileSync(p, svg);
    process.stderr.write(`[cat35-chart] wrote ${p}\n`);
  }
}

main();
