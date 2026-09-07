/**
 * Cat 13 — Phase E2 floor calibration for gbrain's
 * `search.keyword_arm_confidence_floor` (kacf).
 *
 * The plan (ranker wave, Phase E2) fixes the knob's ONE free parameter BEFORE
 * the decision run: the floor is the median keyword-arm margin ratio over the
 * TUNING-concept probes whose keyword top hit is NOT gold. Held-out concepts
 * are never queried here; the E2 decision arm (cat13-conceptual.ts with
 * `--keyword-arm-confidence-floor <floor>`) is judged on them once.
 *
 * What one run does:
 *   1. Loads the world-v1 corpus + generates the Cat 13 probes exactly like
 *      the runner (same generator, same seed, same CAT13_PROBES), and the
 *      same seeded concept split (--seed / --tuning-concepts /
 *      --holdout-concepts; defaults match the runner: 42, 20 / 10).
 *   2. Builds ONE gbrain brain through GbrainInlineAdapter with the E0-V1
 *      cell's embedder + pins (`search.mode=balanced`, reranker off, autocut
 *      off — margins are computed pre-rerank, so the reranker/autocut pins
 *      cannot move them; they are kept identical for the receipt).
 *   3. For every tuning-subset probe: `hybridSearch(engine, text, { onMeta,
 *      keywordArmConfidenceFloor: null, limit: TOP_K*6 })` (floor forced OFF;
 *      the same limit the gbrain arm uses) reads
 *      `meta.keyword_arm_confidence` = { margin_ratio, top_score,
 *      downweighted:false }, and `engine.searchKeyword(text, { limit: 5 })`
 *      gives the keyword arm's top slug + row count. Both are recorded per
 *      probe with whether the keyword top hit is a grade-3 gold.
 *   4. Computes the floor (pure, unit-tested):
 *        floor = median(margin_ratio) over tuning probes with
 *                keyword_top_is_gold == false AND 0 < margin_ratio < 1
 *      (margin 1.0 = a single row, nothing contests it; 0 = empty arm —
 *      neither carries a comparable margin, both excluded), plus collateral
 *      (gold-top probes the floor would down-weight; non-gold-top probes the
 *      floor cannot reach because they were single-row / empty) and a 10-bin
 *      margin histogram for gold-top vs non-gold-top probes.
 *   5. Writes eval/reports/cat13-kacf/calibration.json + calibration.md and
 *      prints the exact E2 command with the floor filled in.
 *
 * Determinism: the probe set and split are seeded; the brain is rebuilt from
 * the committed corpus. Live embeddings are the only non-hermetic input (the
 * same provider/model/dims as the E0-V1 receipt). `--stub-embed` runs the
 * whole path on the deterministic hash transport — the margins it produces
 * mean nothing, the plumbing and the report shape do.
 *
 * This script reads gold BY DESIGN (it is calibration, not scoring). It never
 * writes a benchmark receipt and never touches eval/reports/cat13-conceptual.
 *
 * Run (hermetic):
 *   CAT13_PROBES=60 bun eval/runner/cat13-kacf-calibrate.ts --stub-embed \
 *     --embedding-model voyage:voyage-4 --embedding-dims 1024
 * Run (paid, the orchestrator's):
 *   CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024 \
 *     bun eval/runner/cat13-kacf-calibrate.ts
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { hybridSearch } from 'gbrain/search/hybrid';
import type { HybridSearchMeta, SearchResult } from 'gbrain/types';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import { GbrainInlineAdapter, gcNow } from './adapters/gbrain-inline.ts';
import { __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import {
  TOP_K, PROBE_SEED, DEFAULT_TUNING_CONCEPTS, DEFAULT_HOLDOUT_CONCEPTS,
  loadCorpus, buildProbes, splitConcepts, probeSubset,
  resolveEmbedder, ensureGateway, providerKeyEnv, pinnedSearchConfig, resolveTargetProbes,
  type Probe, type ConceptSplit, type EmbedderConfig,
} from './cat13-conceptual.ts';
import { sanitizePage } from './types.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

export const KACF_REPORT_DIR = 'cat13-kacf';
/** Rows requested from the keyword arm per probe (top slug + row count). */
export const KEYWORD_PROBE_LIMIT = 5;
/** Histogram bins over [0, 1] for margin_ratio. */
export const HISTOGRAM_BINS = 10;

// ─── Per-probe record ─────────────────────────────────────────────

export interface ProbeMarginRecord {
  probe_id: string;
  template: string;
  text: string;
  /** Grade-3 gold slugs for the probe. */
  targets: string[];
  /**
   * `meta.keyword_arm_confidence.margin_ratio` with the floor OFF. `null`
   * when hybridSearch did not stamp a decision (keyword-only fallback path:
   * no vector arm voted) — such a probe is excluded from every statistic.
   */
  margin_ratio: number | null;
  /** Raw keyword top score (diagnostics only, scale-bound). */
  top_score: number | null;
  /** Strict (non-relaxed) rows returned by engine.searchKeyword(text, {limit: KEYWORD_PROBE_LIMIT}). */
  keyword_rows: number;
  /** AND→OR relaxed rows in that same response (they never fuse when the vector arm votes). */
  keyword_rows_relaxed: number;
  /** Top strict keyword row's slug; null when the strict list is empty. */
  keyword_top_slug: string | null;
  /** True iff keyword_top_slug is one of `targets`. */
  keyword_top_is_gold: boolean;
  /** What hybridSearch reported about the run that produced the margin. */
  vector_enabled: boolean;
  intent: string | null;
  /** Fused top page (best chunk per page, same normalization as the gbrain arm) and whether it is gold. */
  hybrid_top_slug: string | null;
  hybrid_top_is_gold: boolean;
}

/** `empty` = margin 0 (no strict rows), `single` = margin 1 (one row), `contested` = 0 < margin < 1. */
export type MarginClass = 'empty' | 'single' | 'contested' | 'unstamped';

export function marginClass(margin: number | null): MarginClass {
  if (margin === null || !Number.isFinite(margin)) return 'unstamped';
  if (margin <= 0) return 'empty';
  if (margin >= 1) return 'single';
  return 'contested';
}

/** The plan's inclusion rule: keyword top hit is NOT gold AND the margin is strictly inside (0, 1). */
export function isFloorEligible(r: Pick<ProbeMarginRecord, 'keyword_top_is_gold' | 'margin_ratio'>): boolean {
  return !r.keyword_top_is_gold && marginClass(r.margin_ratio) === 'contested';
}

/** Standard median (mean of the two middle values for even n); null for an empty input. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface FloorResult {
  /** Median margin over the eligible probes; null when none were eligible. */
  floor: number | null;
  /** The value to pass to `--keyword-arm-confidence-floor` (knobsHash prints 3dp; we pin 4dp so the CLI string round-trips). */
  floor_cli: string | null;
  eligible_n: number;
  eligible_margins_sorted: number[];
}

export function computeFloor(records: readonly ProbeMarginRecord[]): FloorResult {
  const margins = records.filter(isFloorEligible).map(r => r.margin_ratio as number);
  const floor = median(margins);
  return {
    floor,
    floor_cli: floor === null ? null : floor.toFixed(4),
    eligible_n: margins.length,
    eligible_margins_sorted: [...margins].sort((a, b) => a - b),
  };
}

export interface ClassCounts {
  total: number;
  empty: number;
  single: number;
  contested: number;
  unstamped: number;
}

function countClasses(records: readonly ProbeMarginRecord[]): ClassCounts {
  const c: ClassCounts = { total: records.length, empty: 0, single: 0, contested: 0, unstamped: 0 };
  for (const r of records) c[marginClass(r.margin_ratio)] += 1;
  return c;
}

export interface CollateralResult {
  /** Gold-top probes (keyword top hit IS gold) whose margin is strictly below the floor: the knob would down-weight a correct arm. */
  gold_top_below_floor: number;
  /** Denominator: gold-top probes that were contested (0 < margin < 1) — the only ones the floor can reach. */
  gold_top_contested: number;
  gold_top_below_floor_frac_of_contested: number | null;
  /** Same numerator over ALL stamped gold-top probes with a non-empty arm (single-row included; they are never below the floor). */
  gold_top_nonempty: number;
  gold_top_below_floor_frac_of_nonempty: number | null;
  /** Non-gold-top probes the floor cannot reach: a single row (margin 1.0 never falls below a floor ≤ 1). */
  non_gold_top_single: number;
  /** Non-gold-top probes with an empty strict keyword arm (nothing fused; not noise). */
  non_gold_top_empty: number;
  non_gold_top_stamped: number;
  non_gold_top_single_frac: number | null;
  non_gold_top_empty_frac: number | null;
  /** Non-gold-top contested probes at or above the floor — the misses the floor leaves at full weight (by construction ≈ half of the eligible set). */
  non_gold_top_contested_not_below: number;
}

const frac = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export function collateral(records: readonly ProbeMarginRecord[], floor: number | null): CollateralResult {
  const stamped = records.filter(r => marginClass(r.margin_ratio) !== 'unstamped');
  const goldTop = stamped.filter(r => r.keyword_top_is_gold);
  const nonGoldTop = stamped.filter(r => !r.keyword_top_is_gold);
  const goldContested = goldTop.filter(r => marginClass(r.margin_ratio) === 'contested');
  const goldNonEmpty = goldTop.filter(r => marginClass(r.margin_ratio) !== 'empty');
  const below = (r: ProbeMarginRecord) => floor !== null && (r.margin_ratio as number) < floor;
  const goldBelow = floor === null ? 0 : goldContested.filter(below).length;
  const nonGoldSingle = nonGoldTop.filter(r => marginClass(r.margin_ratio) === 'single').length;
  const nonGoldEmpty = nonGoldTop.filter(r => marginClass(r.margin_ratio) === 'empty').length;
  const nonGoldContested = nonGoldTop.filter(r => marginClass(r.margin_ratio) === 'contested');
  return {
    gold_top_below_floor: goldBelow,
    gold_top_contested: goldContested.length,
    gold_top_below_floor_frac_of_contested: frac(goldBelow, goldContested.length),
    gold_top_nonempty: goldNonEmpty.length,
    gold_top_below_floor_frac_of_nonempty: frac(goldBelow, goldNonEmpty.length),
    non_gold_top_single: nonGoldSingle,
    non_gold_top_empty: nonGoldEmpty,
    non_gold_top_stamped: nonGoldTop.length,
    non_gold_top_single_frac: frac(nonGoldSingle, nonGoldTop.length),
    non_gold_top_empty_frac: frac(nonGoldEmpty, nonGoldTop.length),
    non_gold_top_contested_not_below: floor === null ? nonGoldContested.length : nonGoldContested.filter(r => !below(r)).length,
  };
}

export interface MarginHistogram {
  bins: number;
  /** `edges[i]..edges[i+1]` is bin i; the last bin is closed on the right so margin 1.0 (single-row) lands in it. */
  edges: number[];
  gold_top: number[];
  non_gold_top: number[];
}

export function histogram(records: readonly ProbeMarginRecord[], bins: number = HISTOGRAM_BINS): MarginHistogram {
  if (!Number.isInteger(bins) || bins < 1) throw new Error(`histogram bins must be a positive integer, got ${bins}`);
  const edges = Array.from({ length: bins + 1 }, (_, i) => i / bins);
  const gold = new Array<number>(bins).fill(0);
  const nonGold = new Array<number>(bins).fill(0);
  for (const r of records) {
    if (marginClass(r.margin_ratio) === 'unstamped') continue;
    const m = r.margin_ratio as number;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(m * bins)));
    (r.keyword_top_is_gold ? gold : nonGold)[idx] += 1;
  }
  return { bins, edges, gold_top: gold, non_gold_top: nonGold };
}

export interface CalibrationSummary {
  floor: FloorResult;
  collateral: CollateralResult;
  histogram: MarginHistogram;
  classes: { all: ClassCounts; gold_top: ClassCounts; non_gold_top: ClassCounts };
  /** Probes whose `keyword_rows >= 2` disagrees with `marginClass === 'contested'` (tie at zero score, or a relaxed-only arm) — diagnostics. */
  row_count_disagreements: number;
  by_template: Record<string, { probes: number; eligible: number; gold_top: number; median_margin_non_gold: number | null }>;
}

/** The pure aggregate over per-probe records — everything the report prints. */
export function calibrate(records: readonly ProbeMarginRecord[]): CalibrationSummary {
  const floor = computeFloor(records);
  const goldTop = records.filter(r => r.keyword_top_is_gold);
  const nonGoldTop = records.filter(r => !r.keyword_top_is_gold);
  const byTemplate: CalibrationSummary['by_template'] = {};
  for (const t of [...new Set(records.map(r => r.template))].sort()) {
    const rs = records.filter(r => r.template === t);
    byTemplate[t] = {
      probes: rs.length,
      eligible: rs.filter(isFloorEligible).length,
      gold_top: rs.filter(r => r.keyword_top_is_gold).length,
      median_margin_non_gold: median(rs.filter(isFloorEligible).map(r => r.margin_ratio as number)),
    };
  }
  return {
    floor,
    collateral: collateral(records, floor.floor),
    histogram: histogram(records),
    classes: { all: countClasses(records), gold_top: countClasses(goldTop), non_gold_top: countClasses(nonGoldTop) },
    row_count_disagreements: records.filter(r =>
      marginClass(r.margin_ratio) !== 'unstamped' && (r.keyword_rows >= 2) !== (marginClass(r.margin_ratio) === 'contested'),
    ).length,
    by_template: byTemplate,
  };
}

// ─── Per-probe measurement (engine-bound) ─────────────────────────

function bestPagePerChunkList(rows: readonly SearchResult[]): string | null {
  const pageBest = new Map<string, number>();
  for (const r of rows) {
    const existing = pageBest.get(r.slug);
    if (existing === undefined || r.score > existing) pageBest.set(r.slug, r.score);
  }
  const top = [...pageBest.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return top ? top[0] : null;
}

/**
 * One probe: hybridSearch with the floor OFF (decision stamped on meta) plus
 * the bare keyword arm. Exported for the hermetic test; takes the engine
 * directly so it has no adapter dependency.
 */
export async function measureProbe(engine: PGLiteEngine, probe: Probe): Promise<ProbeMarginRecord> {
  let meta: HybridSearchMeta | undefined;
  const fused = await hybridSearch(engine, probe.q.text, {
    limit: TOP_K * 6, // identical to GbrainInlineAdapter.query
    keywordArmConfidenceFloor: null, // floor OFF: the decision is still stamped for calibration
    onMeta: (m) => { meta = m; },
  });
  const kw = await engine.searchKeyword(probe.q.text, { limit: KEYWORD_PROBE_LIMIT });
  const strict = kw.filter(r => !r.keyword_relaxed);
  const relaxed = kw.length - strict.length;
  const topStrict = strict.length > 0
    ? [...strict].sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))[0]
    : undefined;
  const conf = meta?.keyword_arm_confidence;
  const hybridTop = bestPagePerChunkList(fused);
  return {
    probe_id: probe.q.id,
    template: probe.template,
    text: probe.q.text,
    targets: [...probe.targetSlugs],
    margin_ratio: conf ? conf.margin_ratio : null,
    top_score: conf ? conf.top_score : null,
    keyword_rows: strict.length,
    keyword_rows_relaxed: relaxed,
    keyword_top_slug: topStrict?.slug ?? null,
    keyword_top_is_gold: topStrict !== undefined && probe.targetSlugs.includes(topStrict.slug),
    vector_enabled: meta?.vector_enabled ?? false,
    intent: meta?.intent ?? null,
    hybrid_top_slug: hybridTop,
    hybrid_top_is_gold: hybridTop !== null && probe.targetSlugs.includes(hybridTop),
  };
}

// ─── CLI / options ────────────────────────────────────────────────

export interface CalibrateOptions {
  stubEmbed?: boolean;
  embeddingModel?: string;
  embeddingDims?: string | number;
  tuningConcepts?: number;
  holdoutConcepts?: number;
  seed?: number;
  /** Probe-generator target (CAT13_PROBES); same meaning as the runner. */
  targetProbes?: number;
  /** Cap on tuning probes measured (generation order) — smoke runs only; the report flags it. */
  maxProbes?: number;
  reportsDir?: string;
  quiet?: boolean;
}

function parseNonNegativeInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer, got '${raw}'`);
  return n;
}

export function parseCalibrateArgv(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): CalibrateOptions {
  const opts: CalibrateOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      i += 1;
      return v;
    };
    switch (flag) {
      case '--stub-embed': opts.stubEmbed = true; break;
      case '--embedding-model': opts.embeddingModel = value(); break;
      case '--embedding-dims': opts.embeddingDims = value(); break;
      case '--tuning-concepts': opts.tuningConcepts = parseNonNegativeInt(value(), '--tuning-concepts'); break;
      case '--holdout-concepts': opts.holdoutConcepts = parseNonNegativeInt(value(), '--holdout-concepts'); break;
      case '--seed': opts.seed = parseNonNegativeInt(value(), '--seed'); break;
      case '--max-probes': {
        const n = parseNonNegativeInt(value(), '--max-probes');
        if (n === 0) throw new Error('--max-probes must be >= 1');
        opts.maxProbes = n;
        break;
      }
      case '--reports-dir': opts.reportsDir = value(); break;
      default:
        throw new Error(
          `unknown argument '${arg}'. Known: --stub-embed --embedding-model <provider:model> --embedding-dims <N> `
          + `--tuning-concepts <N> --holdout-concepts <M> --seed <N> --max-probes <N> --reports-dir <dir>`,
        );
    }
  }
  if (env.CAT13_STUB_EMBED === '1') opts.stubEmbed = true;
  return opts;
}

// ─── Report ───────────────────────────────────────────────────────

export interface CalibrationReport {
  generated_at: string;
  gbrain_version: string;
  gbrain_pin: string;
  stub_embed: boolean;
  embedder: EmbedderConfig;
  embedding_transport: string;
  /** The engine.setConfig pins the brain ran with (identical to the E0-V1 cell). */
  search_pins: Record<string, string>;
  /** Per-call hybridSearch options used for every probe. */
  per_call: { limit: number; keywordArmConfidenceFloor: null };
  keyword_probe_limit: number;
  concept_split: { seed: number; tuning_n: number; holdout_n: number; tuning: string[]; holdout: string[] };
  probes: { generated: number; tuning: number; measured: number; max_probes: number | null };
  summary: CalibrationSummary;
  /** The exact E2 decision-arm command with the floor filled in (null when no floor). */
  e2_command: string | null;
  records: ProbeMarginRecord[];
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null, dp = 4): string => (x === null ? 'n/a' : x.toFixed(dp));

export function e2Command(report: Pick<CalibrationReport, 'embedder' | 'summary'>): string | null {
  const f = report.summary.floor.floor_cli;
  if (f === null) return null;
  return `CAT13_EMBEDDING_MODEL=${report.embedder.model} CAT13_EMBED_DIMS=${report.embedder.dims} `
    + `bun eval/runner/cat13-conceptual.ts --reranker off --autocut off --keyword-arm-confidence-floor ${f}`;
}

export function renderMarkdown(report: CalibrationReport): string {
  const s = report.summary;
  const c = s.collateral;
  const h = s.histogram;
  const lines: string[] = [];
  lines.push(`# Cat 13 — keyword_arm_confidence_floor calibration (Phase E2)`);
  lines.push('');
  lines.push(`Generated: ${report.generated_at} · gbrain ${report.gbrain_version} (pin ${report.gbrain_pin})`);
  lines.push(`Embeds: ${report.embedding_transport}`);
  lines.push(`Search pins: ${Object.entries(report.search_pins).map(([k, v]) => `${k}=${v}`).join(' ')} · per-call keywordArmConfidenceFloor=null (OFF), limit=${report.per_call.limit}`);
  lines.push(`Concept split: seed=${report.concept_split.seed}, ${report.concept_split.tuning_n} tuning / ${report.concept_split.holdout_n} held-out (held-out never queried here)`);
  lines.push(`Probes: ${report.probes.generated} generated, ${report.probes.tuning} tuning-subset, ${report.probes.measured} measured${report.probes.max_probes !== null ? ` (CAPPED by --max-probes ${report.probes.max_probes}: smoke run, not a calibration)` : ''}`);
  if (report.stub_embed) lines.push(`**STUB EMBEDDINGS — the numbers below exercise the plumbing only; do not use this floor.**`);
  lines.push('');
  lines.push(`## Floor`);
  lines.push('');
  lines.push(`Rule (pre-registered): median margin_ratio over tuning probes whose keyword top hit is NOT gold AND 0 < margin_ratio < 1 (single-row = 1.0 and empty = 0 excluded).`);
  lines.push('');
  lines.push(`- eligible probes: ${s.floor.eligible_n}`);
  lines.push(`- **floor = ${num(s.floor.floor)}** (CLI value \`${s.floor.floor_cli ?? 'none'}\`)`);
  lines.push('');
  lines.push(`## Keyword-arm classes (tuning probes)`);
  lines.push('');
  lines.push(`| Set | probes | empty (0) | single (1.0) | contested (0,1) | unstamped |`);
  lines.push(`|-----|--------|-----------|--------------|-----------------|-----------|`);
  for (const [name, cc] of [['all', s.classes.all], ['keyword top = gold', s.classes.gold_top], ['keyword top ≠ gold', s.classes.non_gold_top]] as const) {
    lines.push(`| ${name} | ${cc.total} | ${cc.empty} | ${cc.single} | ${cc.contested} | ${cc.unstamped} |`);
  }
  lines.push('');
  lines.push(`Row-count vs margin-class disagreements (keyword_rows ≥ 2 but margin not in (0,1), or vice versa): ${s.row_count_disagreements}.`);
  lines.push('');
  lines.push(`## Collateral at the floor`);
  lines.push('');
  lines.push(`- gold-top probes the floor would down-weight: ${c.gold_top_below_floor} / ${c.gold_top_contested} contested (${pct(c.gold_top_below_floor_frac_of_contested)}); ${c.gold_top_below_floor} / ${c.gold_top_nonempty} of all non-empty gold-top (${pct(c.gold_top_below_floor_frac_of_nonempty)})`);
  lines.push(`- non-gold-top probes that were single-row (unreachable by any floor): ${c.non_gold_top_single} / ${c.non_gold_top_stamped} (${pct(c.non_gold_top_single_frac)})`);
  lines.push(`- non-gold-top probes with an empty strict keyword arm (nothing to demote): ${c.non_gold_top_empty} / ${c.non_gold_top_stamped} (${pct(c.non_gold_top_empty_frac)})`);
  lines.push(`- non-gold-top contested probes left at full weight (margin ≥ floor): ${c.non_gold_top_contested_not_below}`);
  lines.push('');
  lines.push(`## margin_ratio histogram (${h.bins} bins; last bin closed at 1.0)`);
  lines.push('');
  lines.push(`| bin | keyword top = gold | keyword top ≠ gold |`);
  lines.push(`|-----|--------------------|--------------------|`);
  for (let i = 0; i < h.bins; i++) {
    const closeBracket = i === h.bins - 1 ? ']' : ')';
    lines.push(`| [${h.edges[i].toFixed(1)}, ${h.edges[i + 1].toFixed(1)}${closeBracket} | ${h.gold_top[i]} | ${h.non_gold_top[i]} |`);
  }
  lines.push('');
  lines.push(`## Per template`);
  lines.push('');
  lines.push(`| template | probes | gold-top | eligible | median margin (eligible) |`);
  lines.push(`|----------|--------|----------|----------|--------------------------|`);
  for (const [t, row] of Object.entries(s.by_template)) {
    lines.push(`| ${t} | ${row.probes} | ${row.gold_top} | ${row.eligible} | ${num(row.median_margin_non_gold, 6)} |`);
  }
  lines.push('');
  lines.push(`## E2 decision arm (held-out concepts, judged once)`);
  lines.push('');
  lines.push(report.e2_command ? '```bash\n' + report.e2_command + '\n```' : '_No floor: zero eligible tuning probes — do not run E2._');
  lines.push('');
  lines.push(`## Sample of eligible probes (non-gold keyword top, contested)`);
  lines.push('');
  lines.push(`| probe | template | margin | keyword top | gold |`);
  lines.push(`|-------|----------|--------|-------------|------|`);
  // 6dp: a second row scoring ~1e-10 of the top gives margin 0.9999999999 —
  // still "contested" under the strict (0,1) rule; 4dp would print it as 1.0000.
  for (const r of report.records.filter(isFloorEligible).slice(0, 15)) {
    lines.push(`| ${r.probe_id} "${r.text}" | ${r.template} | ${num(r.margin_ratio, 6)} | ${r.keyword_top_slug} | ${r.targets.join(', ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Runner ───────────────────────────────────────────────────────

export interface CalibrateRunResult {
  report: CalibrationReport;
  files: { json: string; md: string };
  exitCode: number;
}

export async function runCalibration(opts: CalibrateOptions = {}): Promise<CalibrateRunResult> {
  const stubEmbed = opts.stubEmbed ?? false;
  const log = opts.quiet ? (_: string) => {} : (s: string) => console.log(s);
  const reportsDir = opts.reportsDir ?? join(process.cwd(), 'eval/reports');

  const embedder = resolveEmbedder({ model: opts.embeddingModel, dims: opts.embeddingDims });
  // The E0-V1 like-for-like cell: balanced, reranker off, autocut off. The
  // floor knob is NOT pinned here (bundle default null = off) and is forced
  // off per call as well, so the stamped margins are the knob-off truth.
  // `search.metadata_boost_gate` is deliberately left at the installed
  // default: every stamped quantity here (strict keyword-arm rows and their
  // scores, hybrid's keyword_arm_confidence meta) is computed BEFORE the
  // post-fusion boost stage the gate controls, so the gate cannot move them.
  const searchPins = pinnedSearchConfig({ reranker: 'off', autocut: 'off' });
  if ('search.keyword_arm_confidence_floor' in searchPins) {
    throw new Error('calibration must run with the floor OFF; pinnedSearchConfig unexpectedly set search.keyword_arm_confidence_floor');
  }

  const embedKeyEnv = providerKeyEnv(embedder.model);
  if (!stubEmbed && !process.env[embedKeyEnv]) {
    throw new Error(`${embedKeyEnv} required for live embeds with ${embedder.model} (run with --stub-embed for the hermetic plumbing run)`);
  }

  const targetProbes = opts.targetProbes ?? resolveTargetProbes();
  const corpusDir = join(import.meta.dir, '..', 'data', 'world-v1');
  const pages = loadCorpus(corpusDir);
  const { probes } = buildProbes(pages, targetProbes);
  const conceptSlugs = pages.filter(p => p.slug.startsWith('concepts/')).map(p => p.slug);
  const split: ConceptSplit = splitConcepts(
    conceptSlugs,
    opts.tuningConcepts ?? DEFAULT_TUNING_CONCEPTS,
    opts.holdoutConcepts ?? DEFAULT_HOLDOUT_CONCEPTS,
    opts.seed ?? PROBE_SEED,
  );
  const tuningProbes = probes.filter(p => probeSubset(p, split) === 'tuning');
  const measured = opts.maxProbes !== undefined ? tuningProbes.slice(0, opts.maxProbes) : tuningProbes;
  if (measured.length === 0) throw new Error('no tuning-subset probes to measure (split too small?)');

  ensureGateway(stubEmbed, embedder);

  log(`# Cat 13 kacf calibration`);
  log(`Embeds: ${stubEmbed ? 'stubbed deterministic hash (hermetic)' : 'live'} — ${embedder.model} @ ${embedder.dims}d`);
  log(`Search pins: ${Object.entries(searchPins).map(([k, v]) => `${k}=${v}`).join(' ')}; per-call keywordArmConfidenceFloor=null`);
  log(`Concept split: seed=${split.seed} tuning=${split.tuning.length} held-out=${split.holdout.length}; probes generated=${probes.length} tuning=${tuningProbes.length} measured=${measured.length}`);
  log(`Building one gbrain brain (${pages.length} pages) ...`);

  const adapter = new GbrainInlineAdapter({
    topK: TOP_K,
    searchConfig: searchPins,
    embeddingModel: embedder.model,
    expectStubTransport: stubEmbed,
    embeddingDimensions: embedder.dims,
  });
  const t0 = Date.now();
  const state = await adapter.init(pages.map(sanitizePage), { name: adapter.name });
  const engine = adapter.engineOf(state); // the SAME brain the gbrain arm searches
  log(`  brain ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const records: ProbeMarginRecord[] = [];
  try {
    let i = 0;
    for (const probe of measured) {
      records.push(await measureProbe(engine, probe));
      i += 1;
      // Direct-engine loop (bypasses adapter.query): pace the GC the same way
      // the adapter does, or the full 179-probe run piles up GBs of garbage.
      if (i % 25 === 0) gcNow();
      if (i % 50 === 0) log(`  ${i}/${measured.length} probes`);
    }
  } finally {
    await adapter.teardown(state);
    // Leave the process-global gateway the way the other runners do: a stub
    // installed here must not leak into a later file's live run.
    if (stubEmbed) __setEmbedTransportForTests(null);
  }

  const summary = calibrate(records);
  const report: CalibrationReport = {
    generated_at: new Date().toISOString(),
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    stub_embed: stubEmbed,
    embedder,
    embedding_transport: stubEmbed
      ? `stubbed deterministic hash-embed (__setEmbedTransportForTests), ${embedder.dims}d`
      : `live ${embedder.model} @ ${embedder.dims}d`,
    search_pins: searchPins,
    per_call: { limit: TOP_K * 6, keywordArmConfidenceFloor: null },
    keyword_probe_limit: KEYWORD_PROBE_LIMIT,
    concept_split: {
      seed: split.seed, tuning_n: split.tuning.length, holdout_n: split.holdout.length,
      tuning: split.tuning, holdout: split.holdout,
    },
    probes: { generated: probes.length, tuning: tuningProbes.length, measured: measured.length, max_probes: opts.maxProbes ?? null },
    summary,
    e2_command: null,
    records,
  };
  report.e2_command = e2Command(report);

  const outDir = join(reportsDir, KACF_REPORT_DIR);
  mkdirSync(outDir, { recursive: true });
  const jsonFile = join(outDir, 'calibration.json');
  const mdFile = join(outDir, 'calibration.md');
  writeFileSync(jsonFile, JSON.stringify(report, null, 2) + '\n');
  const md = renderMarkdown(report);
  writeFileSync(mdFile, md + '\n');
  log('');
  log(md);
  log(`[cat13-kacf] wrote ${jsonFile} and ${mdFile}`);

  // A live run that finds no eligible probe has nothing to pre-register: fail
  // loudly. Stub runs are plumbing checks and exit 0 regardless.
  const exitCode = !stubEmbed && summary.floor.floor === null ? 1 : 0;
  return { report, files: { json: jsonFile, md: mdFile }, exitCode };
}

if (import.meta.main) {
  runCalibration(parseCalibrateArgv(process.argv.slice(2)))
    .then(({ exitCode }) => process.exit(exitCode)) // explicit: PGLite's WASM runtime pollutes ambient process.exitCode
    .catch(err => {
      console.error(err);
      process.exit(3);
    });
}
