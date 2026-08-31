/**
 * BrainBench Category 7: Performance / Latency at scale.
 *
 * Measures gbrain operation latency (P50/P95/P99) and throughput at 1K and 10K
 * page scales against PGLite (in-memory).
 *
 * Post-audit contract:
 *   - Workload selection is SEEDED (mulberry32, --seed, default 42): the slug
 *     sequence each op times is precomputed and identical run-to-run, so a
 *     latency delta vs a baseline JSON means gbrain changed, not the dice
 *     (audit misc-runners-08 — unseeded Math.random picked the timed pages).
 *   - Percentiles use eval/runner/metrics.ts `percentile` (linear
 *     interpolation, numpy-default). The old local nearest-rank-off-by-one
 *     reported the MAX sample as p95 at n=20 (audit misc-runners-09).
 *   - Every op runs WARMUP_RUNS discarded iterations before sampling, so JIT /
 *     plan-cache cold starts stop dominating small-n tails (misc-runners-12).
 *   - --scale is validated (positive integer, both `--scale N` and
 *     `--scale=N`); bad input exits 2 with a message instead of an opaque
 *     crash on an empty corpus (misc-runners-11).
 *   - The search_keyword P95 @10K < 200ms threshold is ENFORCED: a breach is
 *     verdict fail + non-zero exit + receipt, not a console warning
 *     (misc-runners-13). Runs that skip scale 10000 record zero thresholds
 *     evaluated in the receipt so nobody mistakes them for a gated pass.
 *   - Receipt at eval/reports/perf/receipt.json (WS0 contract).
 *
 * Usage: bun run eval/runner/perf.ts [--scale N | --scale=N] [--seed N] [--json]
 */

import { PGLiteEngine } from 'gbrain/pglite-engine';
import type { PageInput } from 'gbrain/types';
import { percentile } from './metrics.ts';
import {
  writeReceipt,
  receiptPath,
  RECEIPT_SCHEMA_VERSION,
  BENCHMARK_VERSION,
  type ProbeError,
  type Receipt,
} from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

export const DEFAULT_SEED = 42;
export const WARMUP_RUNS = 3;

export interface LatencySample {
  op: string;
  scale: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  count: number;
}

export interface ThroughputSample {
  op: string;
  scale: number;
  total_seconds: number;
  ops_per_sec: number;
}

export interface ThresholdResult {
  op: string;
  scale: number;
  metric: 'p95_ms';
  limit_ms: number;
  actual_ms: number;
  pass: boolean;
}

// ─── Seeded PRNG (mulberry32 — same pattern as cat13/longmemeval) ─────

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── CLI parsing (misc-runners-11) ────────────────────────────────────

export interface PerfArgs {
  scales: number[];
  seed: number;
  json: boolean;
}

/** Throws with a usage message on invalid input; caller maps that to exit 2. */
export function parsePerfArgs(argv: string[]): PerfArgs {
  const args: PerfArgs = { scales: [1000, 10000], seed: DEFAULT_SEED, json: false };
  const parsePositiveInt = (flag: string, raw: string | undefined): number => {
    const n = Number(raw);
    if (raw === undefined || raw === '' || !Number.isInteger(n) || n <= 0) {
      throw new Error(`${flag} requires a positive integer, got ${JSON.stringify(raw)}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--scale') args.scales = [parsePositiveInt('--scale', argv[++i])];
    else if (a.startsWith('--scale=')) args.scales = [parsePositiveInt('--scale', a.slice('--scale='.length))];
    else if (a === '--seed') args.seed = parsePositiveInt('--seed', argv[++i]);
    else if (a.startsWith('--seed=')) args.seed = parsePositiveInt('--seed', a.slice('--seed='.length));
    else throw new Error(`unknown arg: ${a} (usage: perf.ts [--scale N | --scale=N] [--seed N] [--json])`);
  }
  return args;
}

// ─── Timing helpers ───────────────────────────────────────────────────

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

/**
 * Time `runs` iterations of `fn(i)` after `warmup` DISCARDED iterations
 * (fn receives the warmup indices first, then 0..runs-1 for the sampled
 * ones, so a precomputed slug plan indexes deterministically).
 */
export async function timeMany(
  label: string,
  scale: number,
  fn: (i: number) => Promise<unknown>,
  runs: number,
  warmup = WARMUP_RUNS,
): Promise<LatencySample> {
  for (let i = 0; i < warmup; i++) {
    await fn(i % runs); // warmup: same input domain, samples discarded
  }
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const { ms } = await timed(() => fn(i));
    samples.push(ms);
  }
  return {
    op: label,
    scale,
    p50_ms: percentile(samples, 50),
    p95_ms: percentile(samples, 95),
    p99_ms: percentile(samples, 99),
    count: runs,
  };
}

// ─── Seed data ────────────────────────────────────────────────────────

/**
 * Procedural seeder. Power-law connection distribution: 5% of entities are
 * "hub nodes" with many inbound links; the rest are sparsely connected. This
 * matches real-brain shape and stresses the right code paths.
 */
export function generateSeedData(scale: number): { pages: Array<{ slug: string; page: PageInput }>; links: Array<{ from: string; to: string; type: string }> } {
  const pages: Array<{ slug: string; page: PageInput }> = [];
  const links: Array<{ from: string; to: string; type: string }> = [];

  // 60% people, 20% companies, 10% meetings, 10% concepts
  const peopleN = Math.floor(scale * 0.6);
  const companyN = Math.floor(scale * 0.2);
  const meetingN = Math.floor(scale * 0.1);
  const conceptN = Math.floor(scale * 0.1);

  for (let i = 0; i < peopleN; i++) {
    const slug = `people/person-${i}`;
    pages.push({
      slug,
      page: {
        type: 'person', title: `Person ${i}`,
        compiled_truth: `Person ${i} works in tech. Met them via [Company](companies/company-${i % companyN}). Mentioned in [Meeting](meetings/meeting-${i % meetingN}).`,
        timeline: `- **2025-01-${(i % 28) + 1 < 10 ? '0' : ''}${(i % 28) + 1}** | First met\n- **2025-06-15** | Follow-up call\n- **2026-01-10** | Latest update`,
      },
    });
  }
  for (let i = 0; i < companyN; i++) {
    const slug = `companies/company-${i}`;
    pages.push({
      slug,
      page: {
        type: 'company', title: `Company ${i}`,
        compiled_truth: `Company ${i} is a startup in fintech.`,
        timeline: `- **2024-09-01** | Founded\n- **2025-03-15** | Seed round\n- **2026-02-01** | Series A`,
      },
    });
  }
  for (let i = 0; i < meetingN; i++) {
    const slug = `meetings/meeting-${i}`;
    pages.push({
      slug,
      page: {
        type: 'meeting', title: `Meeting ${i}`,
        compiled_truth: `Meeting ${i} attendees: [Person A](people/person-${i * 5 % peopleN}), [Person B](people/person-${(i * 5 + 1) % peopleN}), [Person C](people/person-${(i * 5 + 2) % peopleN}).`,
        timeline: `- **2026-03-01** | Meeting held`,
      },
    });
  }
  for (let i = 0; i < conceptN; i++) {
    pages.push({
      slug: `concepts/concept-${i}`,
      page: {
        type: 'concept', title: `Concept ${i}`,
        compiled_truth: `Concept ${i} relates to [Company](companies/company-${i % companyN}).`,
        timeline: `- **2025-12-01** | Wrote thesis`,
      },
    });
  }

  // Hub-node connections: 5% of people get 100+ inbound links from the rest.
  const hubCount = Math.max(1, Math.floor(peopleN * 0.05));
  for (let i = 0; i < hubCount; i++) {
    const hub = `people/person-${i}`;
    // Connect every Nth person to this hub.
    const interval = Math.max(1, Math.floor(peopleN / 100));
    for (let j = hubCount; j < peopleN; j += interval) {
      links.push({ from: `people/person-${j}`, to: hub, type: 'mentions' });
    }
  }

  return { pages, links };
}

// ─── Workload plan (misc-runners-08) ──────────────────────────────────

/**
 * Precomputed, seeded slug sequence: `pick(i)` for the i-th timed call of an
 * op. Same seed + same corpus → the identical page mix is timed every run.
 */
export function buildSlugPlan(
  slugs: readonly string[],
  seed: number,
  length: number,
): string[] {
  if (slugs.length === 0) throw new Error('buildSlugPlan: empty slug list');
  const rng = mulberry32(seed);
  const plan: string[] = [];
  for (let i = 0; i < length; i++) {
    plan.push(slugs[Math.floor(rng() * slugs.length)]);
  }
  return plan;
}

// ─── Thresholds (misc-runners-13) ─────────────────────────────────────

/** Enforced limits, keyed by op+scale. Breach ⇒ verdict fail, non-zero exit. */
export const THRESHOLDS: ReadonlyArray<{ op: string; scale: number; metric: 'p95_ms'; limit_ms: number }> = [
  { op: 'search_keyword', scale: 10000, metric: 'p95_ms', limit_ms: 200 },
];

/** Evaluate every threshold whose (op, scale) is present in the measured set. */
export function evaluateThresholds(latency: readonly LatencySample[]): ThresholdResult[] {
  const results: ThresholdResult[] = [];
  for (const t of THRESHOLDS) {
    const sample = latency.find(l => l.op === t.op && l.scale === t.scale);
    if (!sample) continue;
    results.push({
      op: t.op,
      scale: t.scale,
      metric: t.metric,
      limit_ms: t.limit_ms,
      actual_ms: sample[t.metric],
      pass: sample[t.metric] <= t.limit_ms,
    });
  }
  return results;
}

export interface PerfOutcome {
  thresholds: ThresholdResult[];
  breaches: ThresholdResult[];
  verdict: 'pass' | 'fail';
  /** 0 on pass, 1 on any threshold breach — main() exits with exactly this. */
  exitCode: 0 | 1;
}

/** The gate main() enforces: breach ⇒ verdict fail + exit 1 (misc-runners-13). */
export function perfOutcome(latency: readonly LatencySample[]): PerfOutcome {
  const thresholds = evaluateThresholds(latency);
  const breaches = thresholds.filter(t => !t.pass);
  return {
    thresholds,
    breaches,
    verdict: breaches.length === 0 ? 'pass' : 'fail',
    exitCode: breaches.length === 0 ? 0 : 1,
  };
}

// ─── One scale run ────────────────────────────────────────────────────

async function runScale(scale: number, seed: number, log: (msg: string) => void): Promise<{ latency: LatencySample[]; throughput: ThroughputSample[] }> {
  log(`\n## Scale: ${scale} pages (seed ${seed})\n`);

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const { pages, links } = generateSeedData(scale);
  if (pages.length === 0) {
    await engine.disconnect();
    throw new Error(`scale ${scale} generated zero pages — scale too small for the 60/20/10/10 split`);
  }

  // ── Throughput: bulk import via putPage ──
  const importStart = performance.now();
  for (const { slug, page } of pages) {
    await engine.putPage(slug, page);
  }
  const importSecs = (performance.now() - importStart) / 1000;
  const importTput: ThroughputSample = {
    op: 'putPage_bulk',
    scale,
    total_seconds: importSecs,
    ops_per_sec: pages.length / importSecs,
  };
  log(`Bulk putPage: ${pages.length} pages in ${importSecs.toFixed(1)}s = ${importTput.ops_per_sec.toFixed(1)} pages/sec`);

  // ── Throughput: bulk addLink ──
  const linkStart = performance.now();
  for (const l of links) {
    try { await engine.addLink(l.from, l.to, '', l.type); } catch { /* skip if either page missing */ }
  }
  const linkSecs = (performance.now() - linkStart) / 1000;
  const linkTput: ThroughputSample = {
    op: 'addLink_bulk',
    scale,
    total_seconds: linkSecs,
    ops_per_sec: links.length / linkSecs,
  };
  log(`Bulk addLink: ${links.length} links in ${linkSecs.toFixed(1)}s = ${linkTput.ops_per_sec.toFixed(1)} links/sec`);

  // ── Latency samples — precomputed seeded slug plans, one per op so each
  // op's sequence is independent of how many other ops ran before it. ──
  const allSlugs = pages.map(p => p.slug);
  const hubSlug = `people/person-0`; // known to have many inbound links
  const plan = (opIndex: number, runs: number) =>
    buildSlugPlan(allSlugs, seed * 1000 + opIndex, runs);

  const latency: LatencySample[] = [];

  const getPagePlan = plan(1, 50);
  latency.push(await timeMany('get_page', scale, i => engine.getPage(getPagePlan[i]), 50));
  const getLinksPlan = plan(2, 50);
  latency.push(await timeMany('get_links', scale, i => engine.getLinks(getLinksPlan[i]), 50));
  const getBacklinksPlan = plan(3, 50);
  latency.push(await timeMany('get_backlinks', scale, i => engine.getBacklinks(getBacklinksPlan[i]), 50));
  latency.push(await timeMany('get_backlinks_hub', scale, () => engine.getBacklinks(hubSlug), 20));
  const getTimelinePlan = plan(4, 50);
  latency.push(await timeMany('get_timeline', scale, i => engine.getTimeline(getTimelinePlan[i]), 50));
  latency.push(await timeMany('get_stats', scale, () => engine.getStats(), 10));
  latency.push(await timeMany('list_pages_50', scale, () => engine.listPages({ limit: 50 }), 20));
  latency.push(await timeMany('search_keyword', scale, () => engine.searchKeyword('person', { limit: 20 }), 30));
  latency.push(await timeMany('traverse_paths_d1', scale, () => engine.traversePaths(hubSlug, { depth: 1, direction: 'in' }), 10));
  latency.push(await timeMany('traverse_paths_d2', scale, () => engine.traversePaths(hubSlug, { depth: 2, direction: 'both' }), 10));

  // Single-page write latency (separate from bulk).
  let counter = 0;
  latency.push(await timeMany('putPage_single', scale, () => engine.putPage(`probes/p-${counter++}`, {
    type: 'concept', title: `P${counter}`, compiled_truth: 'A probe page.', timeline: '',
  }), 30));

  for (const s of latency) {
    log(`  ${s.op.padEnd(22)} P50=${s.p50_ms.toFixed(2)}ms  P95=${s.p95_ms.toFixed(2)}ms  P99=${s.p99_ms.toFixed(2)}ms  (n=${s.count}, warmup=${WARMUP_RUNS} discarded)`);
  }

  await engine.disconnect();
  return { latency, throughput: [importTput, linkTput] };
}

// ─── Entry ────────────────────────────────────────────────────────────

async function main() {
  let args: PerfArgs;
  try {
    args = parsePerfArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`perf: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const log = args.json ? () => {} : console.log;
  const startedAt = new Date().toISOString();

  log('# BrainBench Category 7: Performance / Latency\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);
  log(`Engine: PGLite (in-memory)`);
  log(`Seed: ${args.seed} (mulberry32; identical workload every run)`);
  log(`Percentile method: linear interpolation (eval/runner/metrics.ts)`);

  const receiptBase = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: 'perf',
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
  } as const;

  const allLatency: LatencySample[] = [];
  const allThroughput: ThroughputSample[] = [];
  // Probes = op×scale measurement groups (latency + throughput).
  const LATENCY_OPS_PER_SCALE = 11;
  const THROUGHPUT_OPS_PER_SCALE = 2;
  const nTotal = args.scales.length * (LATENCY_OPS_PER_SCALE + THROUGHPUT_OPS_PER_SCALE);
  const errors: ProbeError[] = [];

  try {
    for (const scale of args.scales) {
      const { latency, throughput } = await runScale(scale, args.seed, log);
      allLatency.push(...latency);
      allThroughput.push(...throughput);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Corpus-generation problems (zero pages at a degenerate scale) are the
    // harness's fault; anything thrown by an engine op is the SUT's.
    const origin = msg.includes('generated zero pages') ? 'harness' as const : 'sut' as const;
    errors.push({ probe_id: `scale:${args.scales.join(',')}`, origin, message: msg.slice(0, 500) });
    const nScored = allLatency.length + allThroughput.length;
    writeReceipt(receiptPath('perf'), {
      ...receiptBase,
      run_status: 'error',
      n_total: nTotal,
      n_scored: nScored,
      completion_rate: nTotal > 0 ? nScored / nTotal : 0,
      errors,
      publishable: false,
      finished_at: new Date().toISOString(),
    } satisfies Receipt);
    console.error('Perf benchmark error:', msg);
    process.exit(1);
  }

  const { thresholds, breaches, verdict, exitCode } = perfOutcome(allLatency);
  const nScored = allLatency.length + allThroughput.length;

  writeReceipt(receiptPath('perf'), {
    ...receiptBase,
    run_status: 'completed',
    verdict,
    n_total: nTotal,
    n_scored: nScored,
    completion_rate: nTotal > 0 ? nScored / nTotal : 0,
    errors,
    publishable: true,
    resolved_config: {
      engine: 'pglite-in-memory',
      scales: args.scales,
      seed: args.seed,
      warmup_runs: WARMUP_RUNS,
      percentile_method: 'linear interpolation (metrics.ts percentile)',
      thresholds_defined: THRESHOLDS,
      thresholds_evaluated: thresholds.length,
    },
    finished_at: new Date().toISOString(),
    data: {
      latency: allLatency,
      throughput: allThroughput,
      thresholds,
    },
  } satisfies Receipt);

  if (args.json) {
    process.stdout.write(JSON.stringify({
      latency: allLatency,
      throughput: allThroughput,
      thresholds,
      verdict,
      seed: args.seed,
      warmup_runs: WARMUP_RUNS,
      percentile_method: 'linear interpolation (metrics.ts percentile)',
    }, null, 2) + '\n');
  }

  if (thresholds.length === 0) {
    log(`\nNo thresholds evaluated (gated ops are defined at scale 10000; this run used [${args.scales.join(', ')}]). Verdict reflects completion only.`);
  }
  for (const t of thresholds) {
    const mark = t.pass ? '✓' : '✗';
    log(`\n${mark} ${t.op} P95 at ${t.scale} = ${t.actual_ms.toFixed(1)}ms (limit ${t.limit_ms}ms)`);
  }
  if (breaches.length > 0) {
    console.error(`\n✗ perf thresholds FAILED:\n  - ${breaches.map(b => `${b.op}@${b.scale} p95=${b.actual_ms.toFixed(1)}ms > ${b.limit_ms}ms`).join('\n  - ')}`);
  }
  // Explicit exit: PGLite's WASM runtime pollutes ambient process.exitCode.
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch(e => {
    console.error('Perf benchmark error:', e);
    process.exit(1);
  });
}
