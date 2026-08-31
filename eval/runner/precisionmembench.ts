/**
 * BrainBench: PrecisionMemBench (faithful external-benchmark adapter)
 *
 * Runs gbrain's REAL retrieval against tenurehq/precisionmembench using the
 * vendored upstream scorer (MIT, see eval/precisionmembench/ATTRIBUTION.md).
 * The scorer is byte-identical to upstream except the ava wrapper was removed;
 * gbrain's adapter overrides only `searchText`, so we are measured on exactly
 * the searchText categories (alias, scope, fuzzy, supersession, ranking).
 * Structural categories (pinned facts, relation expansion, open questions) are
 * harness-computed and identical for every provider on the leaderboard.
 *
 * Honesty: no benchmark-gaming. Beliefs feed gbrain the way real content
 * arrives; scope uses gbrain's real multi-source isolation. Superseded
 * beliefs are seeded LIVE — the upstream provider contract never delivers a
 * supersession field, so pre-hiding them at seed time was reading the answer
 * key (audit finding precisionmembench-01, fixed; scores dropped and the
 * report doc says so). Every mode's number is reported as-is.
 *
 * Receipt: writes eval/reports/precisionmembench/receipt.json (WS0 contract).
 *   - verdict encodes measurement completeness ('pass' = full case set scored,
 *     'partial' = --limit run), NOT a precision bar — this repo enforces no
 *     threshold on an external leaderboard benchmark.
 *   - A missing API key for an embedding/LLM mode → run_status 'skipped' and
 *     a NON-ZERO exit unless --allow-skip.
 *   - Adapter throws are SUT failures: scored as misses (passed=false,
 *     precision per the empty-return rules) and kept in the denominator
 *     (probe-accounting policy).
 *
 * Run:
 *   bun eval/runner/precisionmembench.ts --mode gbrain-hybrid
 *   bun eval/runner/precisionmembench.ts --mode gbrain-keyword   # no embed key
 *   bun eval/runner/precisionmembench.ts --mode gbrain-hybrid --limit 10
 *   bun eval/runner/precisionmembench.ts --mode gbrain-hybrid --json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildReportPayload } from '../precisionmembench/scorer/buildRetrievalReport.ts';
import {
  scoreCases,
  pinnedInSeedSet,
  coerceBelief,
  type RetrievalCase,
  type ReportEntry,
} from '../precisionmembench/scorer/runCases.ts';
import type { Belief } from '../precisionmembench/scorer/belief.ts';
import { GbrainBeliefAdapter } from '../precisionmembench/gbrainAdapter.ts';
import { GbrainThinkAdapter } from '../precisionmembench/gbrainThinkAdapter.ts';
import {
  createBenchEngine,
  seedGbrainEngine,
  configureGatewayForBench,
  type SeedFidelity,
} from '../precisionmembench/seed.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, RECEIPT_SCHEMA_VERSION, BENCHMARK_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

const PMB_DIR = join(import.meta.dir, '..', 'precisionmembench');
const FIXTURE_BELIEFS = join(PMB_DIR, 'fixtures', 'beliefs.seed.json');
const FIXTURE_CASES = join(PMB_DIR, 'fixtures', 'retrieval.cases.json');
const DEFAULT_REPORT_DIR = join(import.meta.dir, '..', 'reports', 'precisionmembench');

// Published leaderboard (from upstream test-results/baseline/, c9689ca) for context.
// All rows are FULL 77-case runs by the upstream harness.
export const LEADERBOARD: Array<{ name: string; precision: number; active: number; pass: string }> = [
  { name: 'tenure (author)', precision: 1.0, active: 43, pass: '77/77' },
  { name: 'supermemory', precision: 0.43, active: 17, pass: '44/77' },
  { name: 'agentmemory', precision: 0.17, active: 0, pass: '7/77' },
  { name: 'yourmemory', precision: 0.17, active: 0, pass: '21/77' },
  { name: 'atomicmemory', precision: 0.15, active: 0, pass: '9/77' },
  { name: 'zep', precision: 0.09, active: 0, pass: '9/77' },
  { name: 'vector baseline', precision: 0.088, active: 0, pass: '9/77' },
  { name: 'mem0', precision: 0.056, active: 0, pass: '9/77' },
];

export const MODES = ['gbrain-hybrid', 'gbrain-keyword', 'gbrain-think', 'gbrain-adaptive'] as const;
export type BenchMode = (typeof MODES)[number];
export const FIDELITIES = ['body-text', 'structured'] as const satisfies readonly SeedFidelity[];

export interface Opts {
  mode: BenchMode;
  fidelity: SeedFidelity;
  limit: number | null;
  json: boolean;
  noEmbed: boolean;
  entityMax: number | null;
  otherMax: number | null;
  allowSkip: boolean;
  reportDir: string;
  receiptFile: string;
}

/**
 * Strict flag parsing (audit finding precisionmembench-02): --mode and
 * --fidelity are whitelisted enums and any unknown flag is a hard error.
 * Previously `--mode gbrain-adaptive-tight` silently ran plain hybrid while
 * stamping the bogus mode into the provider label, filename, and payload.
 */
export function parseOpts(argv: string[]): Opts {
  const opts: Opts = {
    mode: 'gbrain-hybrid',
    fidelity: 'body-text',
    limit: null,
    json: false,
    noEmbed: false,
    entityMax: null,
    otherMax: null,
    allowSkip: false,
    reportDir: DEFAULT_REPORT_DIR,
    receiptFile: receiptPath('precisionmembench'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    const nextInt = (min: number): number => {
      const raw = next();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min) throw new Error(`${a} must be an integer >= ${min}, got '${raw}'`);
      return n;
    };
    if (a === '--mode') opts.mode = next() as BenchMode;
    else if (a === '--fidelity') opts.fidelity = next() as SeedFidelity;
    else if (a === '--limit') opts.limit = nextInt(1);
    else if (a === '--json') opts.json = true;
    else if (a === '--no-embed') opts.noEmbed = true;
    else if (a === '--entity-max') opts.entityMax = nextInt(0);
    else if (a === '--other-max') opts.otherMax = nextInt(0);
    else if (a === '--allow-skip') opts.allowSkip = true;
    else if (a === '--report-dir') opts.reportDir = next();
    else if (a === '--receipt-path') opts.receiptFile = next();
    else throw new Error(`unknown arg: ${a} (valid: --mode --fidelity --limit --json --no-embed --entity-max --other-max --allow-skip --report-dir --receipt-path)`);
  }
  if (!MODES.includes(opts.mode)) {
    throw new Error(`--mode must be one of ${MODES.join(' | ')}, got '${opts.mode}'`);
  }
  if (!(FIDELITIES as readonly string[]).includes(opts.fidelity)) {
    throw new Error(`--fidelity must be one of ${FIDELITIES.join(' | ')}, got '${opts.fidelity}'`);
  }
  if (opts.mode === 'gbrain-keyword') opts.noEmbed = true;
  return opts;
}

/**
 * Report filename carries the resolved run config (audit finding
 * precisionmembench-03): adaptive caps, --limit, and --no-embed used to be
 * absent from both filename and payload, so same-day runs with different caps
 * silently overwrote each other and published numbers lost provenance.
 */
export function reportFileName(
  date: string,
  opts: Pick<Opts, 'mode' | 'fidelity' | 'limit' | 'noEmbed' | 'entityMax' | 'otherMax'>,
): string {
  const provider = `${opts.mode}-${opts.fidelity}`;
  const parts: string[] = [];
  if (opts.entityMax != null) parts.push(`e${opts.entityMax}`);
  if (opts.otherMax != null) parts.push(`o${opts.otherMax}`);
  if (opts.noEmbed && opts.mode !== 'gbrain-keyword') parts.push('noembed');
  if (opts.limit != null) parts.push(`limit${opts.limit}`);
  return `${date}-${provider}${parts.length > 0 ? '-' + parts.join('-') : ''}.json`;
}

export interface HeadlineNumbers {
  meanPrecision: number | null;
  activeRetrievalPasses: number;
  totalPassed: number;
  totalCases: number;
}

/**
 * Leaderboard rows for the scorecard. Partial (--limit) runs are labeled
 * "not comparable" next to the full-77 published rows (audit finding
 * precisionmembench-06) instead of being silently sorted in.
 */
export function leaderboardRows(
  provider: string,
  r: HeadlineNumbers,
  fullCaseCount: number,
): Array<{ name: string; precision: number; active: number; pass: string }> {
  const partial = r.totalCases < fullCaseCount;
  const name = partial
    ? `>> gbrain (${provider}) [PARTIAL n=${r.totalCases}/${fullCaseCount} — not comparable]`
    : `>> gbrain (${provider})`;
  return [
    ...LEADERBOARD,
    { name, precision: r.meanPrecision ?? 0, active: r.activeRetrievalPasses, pass: `${r.totalPassed}/${r.totalCases}` },
  ].sort((x, y) => y.precision - x.precision);
}

/**
 * Upstream's scorer has no notion of a provider that throws (their ava suite
 * would abort). Per the probe-accounting policy a SUT throw is a scored MISS:
 * passed=false, precision/recall per the empty-return rules (the crashed
 * provider returned nothing), kept in every denominator.
 */
export function missEntryForCrash(tc: RetrievalCase, pinnedInSeed: Set<string>, message: string): ReportEntry {
  const rb = tc.expect.relevantBeliefs ?? {};
  const expected = rb.shouldOnlyInclude
    ? new Set(rb.shouldOnlyInclude)
    : new Set([...(rb.mustInclude ?? [])].filter((id) => !pinnedInSeed.has(id)));
  return {
    caseId: tc.caseId,
    category: tc.category,
    description: tc.description,
    pinnedBeliefs: [],
    relevantBeliefs: [],
    retrievedQuestions: [],
    retrievalPrecision: expected.size === 0 ? null : 0,
    retrievalRecall: expected.size === 0 ? null : 0,
    pinnedCoverage: null,
    passed: false,
    failures: [`provider threw during buildContext: ${message}`],
    retrievalLatencyMs: 0,
  };
}

function missingKeys(mode: BenchMode): string[] {
  const missing: string[] = [];
  if (mode !== 'gbrain-keyword' && !process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (mode === 'gbrain-think' && !process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  return missing;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseOpts(argv);
  const startedAt = new Date().toISOString();
  const provider = `${opts.mode}-${opts.fidelity}`;

  const rawBeliefs = JSON.parse(readFileSync(FIXTURE_BELIEFS, 'utf8')) as Record<string, unknown>[];
  const beliefs: Belief[] = rawBeliefs.map(coerceBelief);
  const allCases = JSON.parse(readFileSync(FIXTURE_CASES, 'utf8')) as RetrievalCase[];
  const fullCaseCount = allCases.length;
  const cases = opts.limit ? allCases.slice(0, opts.limit) : allCases;
  const partial = cases.length < fullCaseCount;

  const resolvedConfig: Record<string, unknown> = {
    mode: opts.mode,
    fidelity: opts.fidelity,
    limit: opts.limit,
    no_embed: opts.noEmbed,
    entity_max: opts.entityMax,
    other_max: opts.otherMax,
    partial,
    full_case_count: fullCaseCount,
    supersession_seeding: 'live — all beliefs seeded, no ground-truth soft-delete (audit precisionmembench-01)',
  };

  const receiptBase: Omit<Receipt, 'run_status' | 'verdict' | 'skip_reason' | 'publishable'> = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: 'precisionmembench',
    n_total: cases.length,
    n_scored: 0,
    completion_rate: 0,
    errors: [],
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    resolved_config: resolvedConfig,
    started_at: startedAt,
    finished_at: startedAt,
  };

  // Missing key for an embedding/LLM mode: skip receipt, non-zero exit unless
  // acknowledged (WS0 contract — a skip must never look like a pass).
  const missing = missingKeys(opts.mode);
  if (missing.length > 0) {
    const reason = `mode '${opts.mode}' requires ${missing.join(' + ')}; not set. Use --mode gbrain-keyword for the hermetic no-key fallback.`;
    writeReceipt(opts.receiptFile, {
      ...receiptBase,
      run_status: 'skipped',
      skip_reason: reason,
      publishable: false,
      finished_at: new Date().toISOString(),
    });
    console.error(`[precisionmembench] SKIPPED — ${reason} ${opts.allowSkip ? '--allow-skip acknowledged.' : 'Exiting non-zero (pass --allow-skip to acknowledge).'}`);
    return opts.allowSkip ? 0 : 2;
  }

  const acc = new ProbeAccounting(cases.length);

  try {
    // hybrid + adaptive + think all need embeddings (think's gather uses hybridSearch).
    const needsEmbed = opts.mode !== 'gbrain-keyword';
    if (needsEmbed) configureGatewayForBench();

    // Silence gbrain's chatty import/extract logs so the scorecard is readable.
    const origLog = console.log;
    const origErr = console.error;
    if (!opts.json) {
      console.log = () => {};
      console.error = () => {};
    }
    const engine = await createBenchEngine();
    let seedStats: { imported: number; supersededLive: number };
    try {
      seedStats = await seedGbrainEngine(engine, beliefs, {
        fidelity: opts.fidelity,
        noEmbed: opts.noEmbed,
      });
    } finally {
      if (!opts.json) {
        console.log = origLog;
        console.error = origErr;
      }
    }

    let adapter;
    if (opts.mode === 'gbrain-think') {
      adapter = new GbrainThinkAdapter(engine);
    } else if (opts.mode === 'gbrain-adaptive') {
      // Drive gbrain's REAL adaptive-return core feature via hybridSearch opts.
      // Default to the shipped recall-preserving caps unless overridden.
      const adaptiveReturn: Record<string, unknown> = { enabled: true };
      if (opts.entityMax != null) adaptiveReturn.entityMax = opts.entityMax;
      if (opts.otherMax != null) adaptiveReturn.otherMax = opts.otherMax;
      adapter = new GbrainBeliefAdapter(engine, 'hybrid', { extraHybridOpts: { adaptiveReturn } });
    } else {
      adapter = new GbrainBeliefAdapter(engine, opts.mode === 'gbrain-keyword' ? 'keyword' : 'hybrid');
    }
    adapter.loadFixture(beliefs);

    const pinnedInSeed = pinnedInSeedSet(beliefs);

    // Per-case invocation so one adapter throw is a scored miss for THAT case
    // (probe-accounting sut policy) instead of aborting the whole run. The
    // per-case scoring is unchanged: scoreCases iterates cases independently.
    const report: ReportEntry[] = [];
    for (const tc of cases) {
      try {
        const [entry] = await scoreCases(adapter, [tc], pinnedInSeed);
        report.push(entry);
        acc.score(tc.caseId, entry.passed ? 1 : 0);
      } catch (err) {
        const msg = String(err);
        acc.error(tc.caseId, 'sut', msg);
        report.push(missEntryForCrash(tc, pinnedInSeed, msg));
      }
    }

    const payload: Record<string, unknown> = {
      ...buildReportPayload({ provider, entries: report, caseCount: cases.length }, report),
      // Audit finding precisionmembench-03: the resolved run config rides in
      // the payload so a committed JSON can never lose its provenance.
      config: {
        ...resolvedConfig,
        seeded_beliefs: seedStats.imported,
        superseded_seeded_live: seedStats.supersededLive,
        gbrain_version: gbrainVersion(),
        gbrain_pin: gbrainPin(),
      },
    };
    const r = payload.retrieval as {
      meanPrecision: number | null;
      meanRecall: number | null;
      totalPassed: number;
      totalCases: number;
      passRate: number | null;
      activeRetrievalPasses: number;
      passTypes: { activeRetrieval: number; structural: number; triviallyEmpty: number };
      p50LatencyMs: number;
      categories: Array<{ category: string; passed: number; caseCount: number; meanPrecision: number | null; meanRecall: number | null }>;
    };

    mkdirSync(opts.reportDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const reportPath = join(opts.reportDir, reportFileName(date, opts));
    writeFileSync(reportPath, JSON.stringify(payload, null, 2));

    await engine.disconnect();

    const summary = acc.summary();
    // A prefix-slice partial run is never publishable as a benchmark result.
    const verdict: Receipt['verdict'] = partial ? 'partial' : summary.n_scored === summary.n_total ? 'pass' : 'fail';
    writeReceipt(opts.receiptFile, {
      ...receiptBase,
      run_status: 'completed',
      verdict,
      n_total: summary.n_total,
      n_scored: summary.n_scored,
      completion_rate: summary.completion_rate,
      errors: summary.errors,
      publishable: summary.publishable && !partial,
      finished_at: new Date().toISOString(),
      data: {
        report_path: reportPath,
        mean_precision: r.meanPrecision,
        mean_recall: r.meanRecall,
        total_passed: r.totalPassed,
        total_cases: r.totalCases,
        active_retrieval_passes: r.activeRetrievalPasses,
      },
    });

    if (opts.json) {
      origLog(JSON.stringify(payload, null, 2));
      return summary.run_invalid ? 3 : 0;
    }

    // Scorecard
    origLog(`\n# PrecisionMemBench — gbrain (${provider})\n`);
    origLog(`Seeded: ${seedStats.imported} beliefs (${seedStats.supersededLive} superseded beliefs seeded LIVE — gbrain must exclude them itself)`);
    origLog(`Cases:  ${r.totalCases}  |  embed: ${opts.noEmbed ? 'OFF (keyword-only)' : 'ON'}\n`);
    if (partial) {
      origLog(`!! PARTIAL RUN — n=${r.totalCases} of ${fullCaseCount} cases (prefix slice, not stratified).`);
      origLog(`!! Numbers below are NOT comparable to full-${fullCaseCount} published rows.\n`);
    }
    origLog(`  mean precision : ${r.meanPrecision}`);
    origLog(`  mean recall    : ${r.meanRecall}`);
    origLog(`  pass rate      : ${r.totalPassed}/${r.totalCases} (${r.passRate})`);
    origLog(`  active passes  : ${r.activeRetrievalPasses}`);
    origLog(`  passTypes      : active=${r.passTypes.activeRetrieval} structural=${r.passTypes.structural} triviallyEmpty=${r.passTypes.triviallyEmpty}`);
    origLog(`  p50 latency    : ${r.p50LatencyMs}ms\n`);

    origLog(`## vs published leaderboard (mean precision${partial ? '; published rows are FULL 77-case runs' : ''})\n`);
    const rows = leaderboardRows(provider, r, fullCaseCount);
    origLog('| System | Precision | Active | Pass |');
    origLog('|--------|-----------|--------|------|');
    for (const row of rows) {
      origLog(`| ${row.name.padEnd(20)} | ${row.precision.toFixed(3)} | ${String(row.active).padStart(2)} | ${row.pass} |`);
    }

    origLog(`\n## per-category mean precision\n`);
    for (const c of r.categories) {
      origLog(`  ${c.category.padEnd(34)} ${c.passed}/${c.caseCount}  prec=${c.meanPrecision ?? '—'}  recall=${c.meanRecall ?? '—'}`);
    }
    origLog(`\nReport:  ${reportPath}`);
    origLog(`Receipt: ${opts.receiptFile} (run_status=completed verdict=${verdict}${partial ? ', publishable=false' : ''})`);
    return summary.run_invalid ? 3 : 0;
  } catch (err) {
    const summary = acc.summary();
    writeReceipt(opts.receiptFile, {
      ...receiptBase,
      run_status: 'error',
      n_total: summary.n_total,
      n_scored: summary.n_scored,
      completion_rate: summary.completion_rate,
      errors: [...summary.errors, { probe_id: 'run', origin: 'harness', message: String(err).slice(0, 500) }],
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
