/**
 * BrainBench: PrecisionMemBench — instrumentation sweep (A5).
 *
 * Phase-1 "instrument before build" evidence (decision A5). Seeds gbrain once,
 * then:
 *   1. Sweeps return-sizing policies (topk / fixed:N / cliff) through the
 *      vendored scorer and reports precision / recall / active-passes for each
 *      — answers "can a tight/cliff gate clear supermemory's 0.43?"
 *   2. Reads the per-query score distribution to answer "does a stable cliff
 *      exist?" — for single-expected cases, how often is the right belief at
 *      rank 1, and how big is the gap to rank 2 (the separatrix)?
 *
 * Separatrix capture is keyed by CASE ID, not raw query text (audit finding
 * precisionmembench-05): the fixture reuses 4 query strings across 9 cases,
 * and a query-keyed map let the last case overwrite the others' captured
 * score distributions. The probe now runs one case at a time so each capture
 * is attributed to exactly the case that produced it.
 *
 * Receipt: writes eval/reports/precisionmembench-instrument/receipt.json.
 * Hybrid mode needs OPENAI_API_KEY; missing key → run_status 'skipped' and a
 * non-zero exit unless --allow-skip. --keyword is the hermetic no-key path.
 *
 * Run: bun eval/runner/precisionmembench-instrument.ts [--keyword]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildReportPayload } from '../precisionmembench/scorer/buildRetrievalReport.ts';
import { scoreCases, pinnedInSeedSet, coerceBelief, type RetrievalCase } from '../precisionmembench/scorer/runCases.ts';
import type { Belief } from '../precisionmembench/scorer/belief.ts';
import { GbrainBeliefAdapter, type AdapterReturnPolicy } from '../precisionmembench/gbrainAdapter.ts';
import type { BrainEngine } from 'gbrain/engine';
import { createBenchEngine, seedGbrainEngine, configureGatewayForBench } from '../precisionmembench/seed.ts';
import { percentile } from './metrics.ts';
import { writeReceipt, receiptPath, RECEIPT_SCHEMA_VERSION, BENCHMARK_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

const PMB = join(import.meta.dir, '..', 'precisionmembench');

export const POLICIES: Array<{ label: string; policy: AdapterReturnPolicy }> = [
  { label: 'topk (baseline)', policy: { kind: 'topk' } },
  { label: 'fixed:1', policy: { kind: 'fixed', n: 1 } },
  { label: 'fixed:2', policy: { kind: 'fixed', n: 2 } },
  { label: 'cliff minKeep1 gap0.20', policy: { kind: 'cliff', minKeep: 1, minGapRatio: 0.20 } },
  { label: 'intent: entity=1 / else=3', policy: { kind: 'intent', single: { kind: 'fixed', n: 1 }, multi: { kind: 'fixed', n: 3 } } },
  { label: 'intent: entity=1 / else=2', policy: { kind: 'intent', single: { kind: 'fixed', n: 1 }, multi: { kind: 'fixed', n: 2 } } },
  { label: 'intent: entity=1 / else=cliff.20', policy: { kind: 'intent', single: { kind: 'fixed', n: 1 }, multi: { kind: 'cliff', minKeep: 1, minGapRatio: 0.20 } } },
];

export interface CaseCapture {
  query: string;
  scores: number[];
  rankedIds: string[];
}

/**
 * Run the topk probe one case at a time and key each captured score
 * distribution by tc.caseId. Within a single buildContext the adapter's
 * searchText fires at most once, so the mutable currentCaseId is unambiguous;
 * empty-query and zero-budget cases never reach searchText and simply have no
 * capture (same as before the fix).
 */
export async function captureSeparatrix(
  engine: BrainEngine,
  beliefs: Belief[],
  cases: RetrievalCase[],
  pinnedInSeed: Set<string>,
  mode: 'hybrid' | 'keyword',
): Promise<Map<string, CaseCapture>> {
  const perCase = new Map<string, CaseCapture>();
  let currentCaseId = '';
  const probe = new GbrainBeliefAdapter(engine, mode, {
    returnPolicy: { kind: 'topk' },
    onScores: ({ query, scores, keptIds }) =>
      perCase.set(currentCaseId, { query, scores, rankedIds: keptIds }),
  });
  probe.loadFixture(beliefs);
  for (const tc of cases) {
    currentCaseId = tc.caseId;
    await scoreCases(probe, [tc], pinnedInSeed);
  }
  return perCase;
}

export interface Separatrix {
  single: number;
  rank1: number;
  medGapCorrect: number | null;
  medGapWrong: number | null;
}

/**
 * For each case with exactly one expected relevant belief, find its rank + the
 * gap between rank1 and rank2 (the cliff). Split by whether the expected
 * belief IS rank 1. Gap normalization uses a positive magnitude (same guard
 * as gate-proto.ts — audit finding precisionmembench-07).
 */
export function computeSeparatrix(
  cases: RetrievalCase[],
  perCase: ReadonlyMap<string, CaseCapture>,
  pinnedInSeed: Set<string>,
): Separatrix {
  let single = 0, rank1 = 0;
  const gapWhenRank1: number[] = [], gapWhenNot: number[] = [];
  for (const tc of cases) {
    const rb = tc.expect.relevantBeliefs ?? {};
    const expected = rb.shouldOnlyInclude ?? rb.mustInclude ?? [];
    const exp = expected.filter((id) => !pinnedInSeed.has(id));
    if (exp.length !== 1) continue;
    const pq = perCase.get(tc.caseId);
    if (!pq || pq.scores.length < 1) continue;
    single++;
    const idx = pq.rankedIds.indexOf(exp[0]);
    const top = Math.max(Math.abs(pq.scores[0]), 1e-9);
    const gap = pq.scores.length >= 2 ? (pq.scores[0] - pq.scores[1]) / top : 1;
    if (idx === 0) { rank1++; gapWhenRank1.push(gap); } else { gapWhenNot.push(gap); }
  }
  const med = (a: number[]): number | null => (a.length ? percentile(a, 50) : null);
  return { single, rank1, medGapCorrect: med(gapWhenRank1), medGapWrong: med(gapWhenNot) };
}

function summarize(report: Awaited<ReturnType<typeof scoreCases>>) {
  const r = (buildReportPayload({ provider: 'x', entries: report, caseCount: report.length }, report) as {
    retrieval: { meanPrecision: number | null; meanRecall: number | null; activeRetrievalPasses: number; totalPassed: number; totalCases: number };
  }).retrieval;
  return { precision: r.meanPrecision, recall: r.meanRecall, active: r.activeRetrievalPasses, pass: `${r.totalPassed}/${r.totalCases}` };
}

interface CliOpts {
  keyword: boolean;
  allowSkip: boolean;
  reportDir: string;
  receiptFile: string;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    keyword: false,
    allowSkip: false,
    reportDir: join(import.meta.dir, '..', 'reports', 'precisionmembench-instrument'),
    receiptFile: receiptPath('precisionmembench-instrument'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keyword') opts.keyword = true;
    else if (a === '--allow-skip') opts.allowSkip = true;
    else if (a === '--report-dir') opts.reportDir = argv[++i] ?? (() => { throw new Error('--report-dir requires a value'); })();
    else if (a === '--receipt-path') opts.receiptFile = argv[++i] ?? (() => { throw new Error('--receipt-path requires a value'); })();
    else throw new Error(`unknown arg: ${a} (valid: --keyword --allow-skip --report-dir --receipt-path)`);
  }
  return opts;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cli = parseArgs(argv);
  const startedAt = new Date().toISOString();
  // Probes: one per swept policy + one separatrix read.
  const nTotal = POLICIES.length + 1;

  const receiptBase: Omit<Receipt, 'run_status' | 'verdict' | 'skip_reason' | 'publishable'> = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: 'precisionmembench-instrument',
    n_total: nTotal,
    n_scored: 0,
    completion_rate: 0,
    errors: [],
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      mode: cli.keyword ? 'keyword' : 'hybrid',
      policies: POLICIES.map((p) => p.label),
      supersession_seeding: 'live — all beliefs seeded, no ground-truth soft-delete (audit precisionmembench-01)',
    },
    started_at: startedAt,
    finished_at: startedAt,
  };

  if (!cli.keyword && !process.env.OPENAI_API_KEY) {
    const reason = "hybrid instrumentation requires OPENAI_API_KEY; not set. Use --keyword for the hermetic no-key path.";
    writeReceipt(cli.receiptFile, {
      ...receiptBase,
      run_status: 'skipped',
      skip_reason: reason,
      publishable: false,
      finished_at: new Date().toISOString(),
    });
    console.error(`[precisionmembench-instrument] SKIPPED — ${reason} ${cli.allowSkip ? '--allow-skip acknowledged.' : 'Exiting non-zero (pass --allow-skip to acknowledge).'}`);
    return cli.allowSkip ? 0 : 2;
  }

  let nScored = 0;
  try {
    const beliefs: Belief[] = (JSON.parse(readFileSync(join(PMB, 'fixtures', 'beliefs.seed.json'), 'utf8')) as Record<string, unknown>[]).map(coerceBelief);
    const cases = JSON.parse(readFileSync(join(PMB, 'fixtures', 'retrieval.cases.json'), 'utf8')) as RetrievalCase[];
    const pinnedInSeed = pinnedInSeedSet(beliefs);

    const origLog = console.log, origErr = console.error;
    console.log = () => {}; console.error = () => {};
    let engine: BrainEngine;
    try {
      if (!cli.keyword) configureGatewayForBench();
      engine = await createBenchEngine();
      await seedGbrainEngine(engine, beliefs, { fidelity: 'body-text', noEmbed: cli.keyword });
    } finally {
      console.log = origLog; console.error = origErr;
    }

    // ── 1. Policy sweep ────────────────────────────────────────────────
    const sweep: Array<{ label: string; precision: number | null; recall: number | null; active: number; pass: string }> = [];
    for (const { label, policy } of POLICIES) {
      const adapter = new GbrainBeliefAdapter(engine, cli.keyword ? 'keyword' : 'hybrid', { returnPolicy: policy });
      adapter.loadFixture(beliefs);
      const report = await scoreCases(adapter, cases, pinnedInSeed);
      sweep.push({ label, ...summarize(report) });
      nScored++;
    }

    // ── 2. Separatrix read (topk pass, per-CASE ranked-score capture) ──
    const perCase = await captureSeparatrix(engine, beliefs, cases, pinnedInSeed, cli.keyword ? 'keyword' : 'hybrid');
    const separatrix = computeSeparatrix(cases, perCase, pinnedInSeed);
    nScored++;

    // ── Output ─────────────────────────────────────────────────────────
    origLog(`\n# PrecisionMemBench instrumentation (${cli.keyword ? 'keyword' : 'hybrid'})\n`);
    origLog(`## Policy sweep (can a tight/cliff gate clear supermemory 0.43?)\n`);
    origLog('| policy | precision | recall | active | pass |');
    origLog('|--------|-----------|--------|--------|------|');
    for (const s of sweep) {
      origLog(`| ${s.label.padEnd(24)} | ${(s.precision ?? 0).toFixed(3)} | ${(s.recall ?? 0).toFixed(3)} | ${String(s.active).padStart(2)} | ${s.pass} |`);
    }
    origLog(`\n## Separatrix read (does a stable cliff exist?)\n`);
    origLog(`single-expected cases analyzed : ${separatrix.single}`);
    origLog(`expected belief IS rank-1      : ${separatrix.rank1}/${separatrix.single} (${(separatrix.rank1 / Math.max(1, separatrix.single) * 100).toFixed(0)}%)`);
    origLog(`median rank1→rank2 gap (correct@1): ${separatrix.medGapCorrect?.toFixed(3) ?? '—'}`);
    origLog(`median rank1→rank2 gap (wrong@1)  : ${separatrix.medGapWrong?.toFixed(3) ?? '—'}`);
    origLog(`\n(if correct@1 is high AND its gap >> wrong@1 gap, a cliff gate wins cleanly)`);

    mkdirSync(cli.reportDir, { recursive: true });
    const out = join(cli.reportDir, `${new Date().toISOString().slice(0, 10)}-instrument-${cli.keyword ? 'keyword' : 'hybrid'}.json`);
    writeFileSync(out, JSON.stringify({
      sweep,
      separatrix,
      perCase: [...perCase.entries()].map(([caseId, v]) => ({ caseId, query: v.query, scores: v.scores.slice(0, 8) })),
      config: receiptBase.resolved_config,
    }, null, 2));
    origLog(`\nReport: ${out}`);
    await engine.disconnect();

    writeReceipt(cli.receiptFile, {
      ...receiptBase,
      run_status: 'completed',
      verdict: nScored === nTotal ? 'pass' : 'fail',
      n_scored: nScored,
      completion_rate: nScored / nTotal,
      publishable: nScored === nTotal,
      finished_at: new Date().toISOString(),
      data: { report_path: out, sweep, separatrix: { ...separatrix } },
    });
    origLog(`Receipt: ${cli.receiptFile}`);
    return 0;
  } catch (err) {
    writeReceipt(cli.receiptFile, {
      ...receiptBase,
      run_status: 'error',
      n_scored: nScored,
      completion_rate: nScored / nTotal,
      errors: [{ probe_id: 'run', origin: 'harness', message: String(err).slice(0, 500) }],
      publishable: false,
      finished_at: new Date().toISOString(),
    });
    console.error(err);
    return 1;
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code)) // explicit: PGLite's WASM runtime pollutes ambient process.exitCode
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
