/**
 * BrainBench Cat 33 — SkillOpt cross-model transfer (v0.42.9.0).
 *
 * Headline question: when you optimize a skill on model X, do the gains TRANSFER
 * to a different model Y you never optimized against? This is the "the skill got
 * genuinely better, not just X-specific prompt-hacking" proof.
 *
 * Per seed + (X,Y) pair:
 *   1. optimize the seed on X (real runSkillOpt, X as target).
 *   2. score on Y, WITHOUT re-optimizing, three skills:
 *        - seed (unoptimized) on Y          → floor
 *        - X-optimized best.md on Y          → transfer
 *        - Y-optimized best.md on Y          → ceiling (optimized natively on Y)
 *   transfer_lift  = xopt_on_y - seed_on_y
 *   transfer_ratio = transfer_lift / (yopt_on_y - seed_on_y), reported as null
 *                    when the ceiling lift is inside noise (<= MARGIN) — a
 *                    ~0 denominator would explode the ratio (audit
 *                    skillopt-cats-03).
 *
 * ── Gate (real + failable; implements the documented two-clause condition,
 *    audit skillopt-cats-03) ─────────────────────────────────────────────
 * A pair "transferred" requires BOTH:
 *   (a) lift clause: transfer_lift > MARGIN (X-opt beats the seed on Y), AND
 *   (b) band clause: X-opt lands within a defined band of the Y-optimized
 *       ceiling — transfer_ratio >= RATIO_BAND (0.5) when the ceiling lift is
 *       meaningful (> MARGIN); when the ceiling itself didn't lift (Y-opt at
 *       or below seed + MARGIN) the ratio is undefined (null) and the band
 *       clause falls back to the absolute check xopt_on_y >= yopt_on_y - MARGIN.
 * full  : transferred on >= ceil(0.75 * pairs). Pairs whose optimize step
 *         errored count as NOT transferred (SUT failure, scored 0).
 * B-pre : every pair ran end-to-end — no error recorded AND neither optimize
 *         outcome is 'errored' (audit skillopt-cats-01: PairResult.error is
 *         now actually wired; optimizeOn failures propagate).
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: runSkillOpt (per-model optimization) + scoreSkillOnTasks as the
 * harness's independent measurement (never trusts optimizer receipts).
 * LEGITIMATELY SEEDED/STUBBED: the committed skillopt-v1 corpus (rule judges,
 * disjoint held-out task_ids) and, under --stub-llm only, the gateway chat
 * transport (cat30's deterministic stub; publishable:false).
 *
 * ── Scoring policy (WS0, eval/runner/probe-accounting.ts) ────────────
 * One probe per (seed, X→Y) pair. optimizeOn throwing or outcome 'errored' →
 * origin 'sut' (scored 0, stays in gate denominator, error recorded on the
 * PairResult). scoreSkillOnTasks throwing → origin 'dependency' (pair
 * excluded from the gate denominator, recorded, capped).
 *
 * Run:
 *   SKILLOPT_BPRE=1 bun eval/runner/cat33-skillopt-transfer.ts   # validity
 *   bun eval/runner/cat33-skillopt-transfer.ts                   # full
 *   SKILLOPT_BPRE=1 bun eval/runner/cat33-skillopt-transfer.ts --stub-llm  # hermetic
 */

import { writeFileSync, mkdirSync, readFileSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { configureGateway, __setChatTransportForTests } from 'gbrain/ai/gateway';
// Deep src imports: no skillopt subpath in gbrain's export map yet (audit skillopt-cats-11).
import { runSkillOpt } from '../../node_modules/gbrain/src/core/skillopt/orchestrator.ts';
import { scoreSkillOnTasks } from '../../node_modules/gbrain/src/core/skillopt/validate-gate.ts';
import { loadHeldOut } from '../../node_modules/gbrain/src/core/skillopt/held-out.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';
import { makeSkilloptStubTransport, PINNED_CONFIG, CLEAN_OUTCOMES, type SkilloptStubBehavior } from './cat30-skillopt-improvement.ts';

export const CAT33_CATEGORY = 'cat33-skillopt-transfer';

export const MARGIN = 0.05;
/** Band clause: X-opt must recover at least this fraction of the Y-optimized ceiling lift. */
export const RATIO_BAND = 0.5;

const SPLIT: [number, number, number] = [1, 1, 1];
export const ALL_SEEDS = ['seed-missing-structure', 'seed-no-verdict'];

// ─── Pure transfer math (exported for the regression test) ───────────────────

export interface TransferMetrics {
  transfer_lift: number;
  /** null when the ceiling lift is inside noise — a ratio against a ~0 denominator is meaningless. */
  transfer_ratio: number | null;
  band_ok: boolean;
  transferred: boolean;
}

export function computeTransfer(seedOnY: number, xoptOnY: number, yoptOnY: number): TransferMetrics {
  const lift = xoptOnY - seedOnY;
  const ceilingLift = yoptOnY - seedOnY;
  let ratio: number | null;
  let bandOk: boolean;
  if (ceilingLift > MARGIN) {
    ratio = lift / ceilingLift;
    bandOk = ratio >= RATIO_BAND;
  } else {
    // Ceiling didn't lift: ratio undefined; require X-opt to land at (or
    // above) the ceiling minus noise instead.
    ratio = null;
    bandOk = xoptOnY >= yoptOnY - MARGIN;
  }
  return { transfer_lift: lift, transfer_ratio: ratio, band_ok: bandOk, transferred: lift > MARGIN && bandOk };
}

// ─── Types + options ─────────────────────────────────────────────────────────

export interface PairResult {
  seed: string;
  x: string;
  y: string;
  seed_on_y: number | null;
  xopt_on_y: number | null;
  yopt_on_y: number | null;
  transfer_lift: number | null;
  transfer_ratio: number | null;
  band_ok: boolean;
  transferred: boolean;
  cost_usd: number;
  /** Outcome of the optimize-on-X step ('accepted' | 'no_improvement' | 'aborted' | 'errored'). */
  x_outcome: string;
  /** Outcome of the optimize-on-Y ceiling step ('skipped_bpre' when x===y in B-pre). */
  y_outcome: string;
  error?: string;
  error_origin?: 'sut' | 'dependency';
}

export interface Cat33Options {
  bpre?: boolean;
  stubLlm?: boolean;
  stubBehavior?: SkilloptStubBehavior;
  allowSkip?: boolean;
  seeds?: string[];
  pairs?: Array<{ x: string; y: string }>;
  optimizerModel?: string;
  epochs?: number;
  batchSize?: number;
  runsPerTask?: number;
  maxCostUsd?: number;
  dataDir?: string;
  reportsDir?: string;
  quiet?: boolean;
  engineFactory?: () => Promise<any>;
  runSkillOptFn?: typeof runSkillOpt;
  scoreFn?: typeof scoreSkillOnTasks;
}

export interface Cat33RunResult {
  receipt: Receipt;
  results: PairResult[];
  exitCode: number;
  receiptFile: string;
}

export function optionsFromEnv(argv: string[] = process.argv.slice(2)): Cat33Options {
  const bpre = process.env.SKILLOPT_BPRE === '1';
  return {
    bpre,
    stubLlm: argv.includes('--stub-llm') || process.env.SKILLOPT_STUB === '1',
    allowSkip: argv.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    seeds: bpre ? ['seed-missing-structure'] : (process.env.SKILLOPT_SEEDS ? process.env.SKILLOPT_SEEDS.split(',') : undefined),
    pairs: bpre
      ? [{ x: 'anthropic:claude-haiku-4-5', y: 'anthropic:claude-haiku-4-5' }]
      : (process.env.SKILLOPT_PAIRS
          ? process.env.SKILLOPT_PAIRS.split(',').map((p) => { const [x, y] = p.split('>'); return { x: x!, y: y! }; })
          : undefined),
    optimizerModel: process.env.SKILLOPT_OPTIMIZER_MODEL,
    epochs: process.env.SKILLOPT_EPOCHS ? Number(process.env.SKILLOPT_EPOCHS) : undefined,
    batchSize: process.env.SKILLOPT_BATCH_SIZE ? Number(process.env.SKILLOPT_BATCH_SIZE) : undefined,
    runsPerTask: process.env.SKILLOPT_HELDOUT_RUNS ? Number(process.env.SKILLOPT_HELDOUT_RUNS) : undefined,
    maxCostUsd: process.env.SKILLOPT_MAX_COST_USD ? Number(process.env.SKILLOPT_MAX_COST_USD) : undefined,
  };
}

/**
 * Gate (exported so the regression test can prove both directions).
 * B-pre: validity — every pair ran end-to-end: no error AND both optimize
 * outcomes clean, i.e. 'accepted'/'no_improvement' — not 'errored'/'aborted'
 * (audit skillopt-cats-01: this can now actually fail; the Y ceiling may be
 * 'skipped_bpre' when x===y).
 * full : transferred on >= ceil(0.75 * scored pairs); dependency-errored
 * pairs excluded from the denominator; zero scored pairs = fail.
 */
export function computeCat33Gate(results: PairResult[], bpre: boolean): boolean {
  if (results.length === 0) return false;
  if (bpre) {
    return results.every((r) =>
      !r.error
      && CLEAN_OUTCOMES.has(r.x_outcome)
      && (r.y_outcome === 'skipped_bpre' || CLEAN_OUTCOMES.has(r.y_outcome)));
  }
  const scored = results.filter((r) => r.error_origin !== 'dependency');
  if (scored.length === 0) return false;
  const transferred = scored.filter((r) => r.transferred).length;
  return transferred >= Math.ceil(scored.length * 0.75);
}

// ─── Per-pair run ─────────────────────────────────────────────────────────────

interface PairDeps {
  engine: any;
  isolatedHome: string;
  dataDir: string;
  acc: ProbeAccounting;
  bpre: boolean;
  optimizerModel: string;
  epochs: number;
  batchSize: number;
  runsPerTask: number;
  maxCostUsd: number;
  runSkillOptFn: typeof runSkillOpt;
  scoreFn: typeof scoreSkillOnTasks;
  log: (s: string) => void;
}

/** Optimize `seedBody` on `targetModel`. Returns the best skill text, or the seed + outcome 'errored' on failure. */
async function optimizeOn(deps: PairDeps, seed: string, seedBody: string, benchmarkPath: string, targetModel: string): Promise<{ best: string; cost: number; outcome: string; errorMsg?: string }> {
  const tmpSkills = join(deps.isolatedHome, `skills-${seed}-${targetModel.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}`);
  mkdirSync(join(tmpSkills, seed), { recursive: true });
  cpSync(join(deps.dataDir, seed, 'SKILL.md'), join(tmpSkills, seed, 'SKILL.md'));
  try {
    const r = await deps.runSkillOptFn({
      engine: deps.engine, skillName: seed, skillsDir: tmpSkills, benchmarkPath,
      epochs: deps.epochs, batchSize: deps.batchSize, lr: 4, lrSchedule: 'cosine', split: SPLIT,
      optimizerModel: deps.optimizerModel, targetModel, judgeModel: targetModel,
      mode: 'patch', dryRun: false, noMutate: false, allowMutateBundled: false,
      bootstrapReviewed: false, json: true, maxCostUsd: deps.maxCostUsd, maxRuntimeMin: 25, force: true,
    } as any);
    return {
      best: r.finalText ?? seedBody,
      cost: r.receipt?.final_cost_usd ?? 0,
      outcome: r.outcome,
      ...(r.outcome === 'errored' ? { errorMsg: 'runSkillOpt returned outcome errored' } : {}),
    };
  } catch (e: any) {
    const msg = `runSkillOpt threw: ${e?.message ?? e}`;
    deps.log(`[cat33]   optimize-on-${targetModel} error: ${msg}\n`);
    return { best: seedBody, cost: 0, outcome: 'errored', errorMsg: msg };
  }
}

async function runPair(deps: PairDeps, seed: string, x: string, y: string): Promise<PairResult> {
  const pairId = `${seed}:${x}>${y}`;
  const seedDir = join(deps.dataDir, seed);
  const seedBody = readFileSync(join(seedDir, 'SKILL.md'), 'utf8');
  const benchmarkPath = join(seedDir, 'benchmark.jsonl');
  const transferTasks = loadHeldOut(join(seedDir, 'held-out.jsonl'));
  const scoreOnY = (skillText: string) => deps.scoreFn({ engine: deps.engine, skillText, tasks: transferTasks, targetModel: y, judgeModel: y, runsPerTask: deps.runsPerTask });
  const base: Omit<PairResult, 'x_outcome' | 'y_outcome'> = {
    seed, x, y, seed_on_y: null, xopt_on_y: null, yopt_on_y: null,
    transfer_lift: null, transfer_ratio: null, band_ok: false, transferred: false, cost_usd: 0,
  };

  deps.log(`[cat33] ${seed} (${x} → ${y}): optimizing on X...\n`);
  const xopt = await optimizeOn(deps, seed, seedBody, benchmarkPath, x);
  deps.log(`[cat33]   X-opt outcome=${xopt.outcome} cost=$${xopt.cost.toFixed(3)}; scoring seed + X-opt on Y...\n`);

  let seedOnY: number, xoptOnY: number;
  try {
    seedOnY = await scoreOnY(seedBody);
    xoptOnY = await scoreOnY(xopt.best);
  } catch (e: any) {
    const msg = `scoring on Y failed: ${e?.message ?? e}`;
    deps.acc.error(pairId, 'dependency', msg);
    return { ...base, cost_usd: xopt.cost, x_outcome: xopt.outcome, y_outcome: 'not_run', error: msg, error_origin: 'dependency' };
  }

  // Ceiling: optimize natively on Y (skipped in B-pre where x===y to save cost).
  let yoptOnY = xoptOnY;
  let yCost = 0;
  let yOutcome = 'skipped_bpre';
  if (!(deps.bpre && x === y)) {
    deps.log(`[cat33]   optimizing on Y (ceiling)...\n`);
    const yopt = await optimizeOn(deps, seed, seedBody, benchmarkPath, y);
    yCost = yopt.cost;
    yOutcome = yopt.outcome;
    if (yopt.outcome !== 'errored') {
      try {
        yoptOnY = await scoreOnY(yopt.best);
      } catch (e: any) {
        const msg = `scoring Y-opt ceiling failed: ${e?.message ?? e}`;
        deps.acc.error(pairId, 'dependency', msg);
        return { ...base, seed_on_y: seedOnY, xopt_on_y: xoptOnY, cost_usd: xopt.cost + yCost, x_outcome: xopt.outcome, y_outcome: yOutcome, error: msg, error_origin: 'dependency' };
      }
    }
  }

  const totalCost = xopt.cost + yCost;
  // SUT failure in either optimize step: the pair is scored 0 (not
  // transferred) and stays in the gate denominator; error propagates so the
  // B-pre validity gate can actually fail (audit skillopt-cats-01).
  const sutError = xopt.errorMsg ?? (yOutcome === 'errored' ? 'Y-ceiling runSkillOpt errored' : undefined);
  if (sutError) {
    deps.acc.error(pairId, 'sut', sutError);
    return {
      ...base, seed_on_y: seedOnY, xopt_on_y: xoptOnY, yopt_on_y: yoptOnY,
      transfer_lift: xoptOnY - seedOnY, cost_usd: totalCost,
      x_outcome: xopt.outcome, y_outcome: yOutcome, error: sutError, error_origin: 'sut',
    };
  }

  const m = computeTransfer(seedOnY, xoptOnY, yoptOnY);
  deps.acc.score(pairId, m.transferred ? 1 : 0);
  deps.log(`[cat33]   seed_on_Y=${seedOnY.toFixed(2)} Xopt_on_Y=${xoptOnY.toFixed(2)} Yopt_on_Y=${yoptOnY.toFixed(2)} lift=${m.transfer_lift >= 0 ? '+' : ''}${m.transfer_lift.toFixed(2)} ratio=${m.transfer_ratio === null ? 'n/a (ceiling flat)' : m.transfer_ratio.toFixed(2)} band_ok=${m.band_ok}\n`);

  return {
    seed, x, y, seed_on_y: seedOnY, xopt_on_y: xoptOnY, yopt_on_y: yoptOnY,
    transfer_lift: m.transfer_lift, transfer_ratio: m.transfer_ratio, band_ok: m.band_ok,
    transferred: m.transferred, cost_usd: totalCost,
    x_outcome: xopt.outcome, y_outcome: yOutcome,
  };
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runCat33(options: Cat33Options = {}): Promise<Cat33RunResult> {
  const startedAt = new Date().toISOString();
  const bpre = options.bpre ?? false;
  const stub = options.stubLlm ?? false;
  const optimizerModel = options.optimizerModel ?? (bpre ? 'anthropic:claude-haiku-4-5' : 'anthropic:claude-sonnet-4-6');
  const epochs = options.epochs ?? (bpre ? 1 : 3);
  const batchSize = options.batchSize ?? 5;
  const runsPerTask = options.runsPerTask ?? (bpre || stub ? 1 : 3);
  const maxCostUsd = options.maxCostUsd ?? (bpre ? 3.0 : 6.0);
  const seeds = options.seeds ?? (bpre ? ['seed-missing-structure'] : ALL_SEEDS);
  // (X, Y) model pairs: optimize on X, evaluate transfer on Y. Default exercises
  // Haiku→Sonnet and Sonnet→Haiku so transfer is shown in both directions (a
  // one-way pair could be confounded by Y simply being a stronger model).
  const pairs = options.pairs ?? (bpre
    ? [{ x: 'anthropic:claude-haiku-4-5', y: 'anthropic:claude-haiku-4-5' }]
    : [
        { x: 'anthropic:claude-haiku-4-5', y: 'anthropic:claude-sonnet-4-6' },
        { x: 'anthropic:claude-sonnet-4-6', y: 'anthropic:claude-haiku-4-5' },
      ]);
  const dataDir = options.dataDir ?? join(process.cwd(), 'eval/data/skillopt-v1');
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT33_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);

  const baseReceipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT33_CATEGORY,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
  } as const;

  const expected = seeds.length * pairs.length;

  if (!stub && !process.env.ANTHROPIC_API_KEY) {
    const receipt: Receipt = {
      ...baseReceipt,
      run_status: 'skipped',
      skip_reason: 'ANTHROPIC_API_KEY missing (run with --stub-llm for a hermetic plumbing check)',
      n_total: expected,
      n_scored: 0,
      completion_rate: 0,
      errors: [],
      publishable: false,
      finished_at: new Date().toISOString(),
    };
    writeReceipt(receiptFile, receipt);
    log(`[cat33] SKIPPED: ${receipt.skip_reason}\n[cat33] receipt: ${receiptFile}\n`);
    return { receipt, results: [], exitCode: options.allowSkip ? 0 : 1, receiptFile };
  }

  const isolatedHome = join(tmpdir(), `cat33-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(isolatedHome, { recursive: true });
  process.env.GBRAIN_HOME = isolatedHome;

  if (stub) {
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'dummy-stub-llm';
    __setChatTransportForTests(makeSkilloptStubTransport(options.stubBehavior));
  }

  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, chat_model: pairs[0]!.y, env: process.env as Record<string, string | undefined> });

  const acc = new ProbeAccounting(expected);
  const results: PairResult[] = [];
  let engine: any = null;
  try {
    engine = options.engineFactory ? await options.engineFactory() : new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    for (const [key, value] of Object.entries(PINNED_CONFIG)) await engine.setConfig(key, value);

    const deps: PairDeps = {
      engine, isolatedHome, dataDir, acc, bpre,
      optimizerModel, epochs, batchSize, runsPerTask, maxCostUsd,
      runSkillOptFn: options.runSkillOptFn ?? runSkillOpt,
      scoreFn: options.scoreFn ?? scoreSkillOnTasks,
      log,
    };
    for (const seed of seeds) for (const { x, y } of pairs) results.push(await runPair(deps, seed, x, y));
  } finally {
    if (stub) __setChatTransportForTests(null);
    if (engine) await engine.disconnect().catch(() => {});
    rmSync(isolatedHome, { recursive: true, force: true });
  }

  const summary = acc.summary();
  const scoredResults = results.filter((r) => r.error_origin !== 'dependency');
  const transferred = scoredResults.filter((r) => r.transferred).length;
  const totalCost = results.reduce((a, r) => a + r.cost_usd, 0);
  const gatePass = computeCat33Gate(results, bpre);
  const verdict: 'pass' | 'fail' = gatePass ? 'pass' : 'fail';
  const publishable = summary.publishable && !stub && !bpre;

  const receipt: Receipt = {
    ...baseReceipt,
    run_status: summary.run_invalid ? 'error' : 'completed',
    ...(summary.run_invalid ? {} : { verdict }),
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable,
    resolved_config: {
      search_mode: PINNED_CONFIG['search.mode'],
      reranker_enabled: false,
      pinned_config: PINNED_CONFIG,
      llm_transport: stub ? 'stubbed-obedient' : 'live',
      mode: bpre ? 'b-pre-validity' : 'full',
      optimizer_model: optimizerModel,
      epochs, batch_size: batchSize, runs_per_task: runsPerTask,
      max_cost_usd: maxCostUsd,
      seeds, pairs,
      margin: MARGIN,
      ratio_band: RATIO_BAND,
      corpus: 'skillopt-v1',
    },
    finished_at: new Date().toISOString(),
    data: {
      results,
      pairs_transferred: transferred,
      pairs_scored: scoredResults.length,
      pairs_total: results.length,
      total_cost_usd: totalCost,
      gate_pass: gatePass,
      infra_error_rate: summary.infra_error_rate,
    },
  };
  writeReceipt(receiptFile, receipt);

  const outDir = join(reportsDir, CAT33_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat33${bpre ? '-bpre' : ''}.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat33] ─── Scorecard (${bpre ? 'B-PRE' : 'FULL'}${stub ? ', STUB LLM' : ''}) ───────────────\n`);
  for (const r of results) log(`[cat33]   ${r.seed} ${r.x}→${r.y}: seed=${r.seed_on_y?.toFixed(2) ?? 'n/a'} Xopt=${r.xopt_on_y?.toFixed(2) ?? 'n/a'} Yopt=${r.yopt_on_y?.toFixed(2) ?? 'n/a'} lift=${r.transfer_lift !== null ? (r.transfer_lift >= 0 ? '+' : '') + r.transfer_lift.toFixed(2) : 'n/a'} ratio=${r.transfer_ratio?.toFixed(2) ?? 'n/a'} ${r.transferred ? 'TRANSFERRED' : ''}${r.error ? `ERROR(${r.error_origin}): ${r.error}` : ''}\n`);
  log(`[cat33]   transferred: ${transferred}/${scoredResults.length} scored (${results.length} total)  cost: $${totalCost.toFixed(2)}  GATE: ${gatePass ? 'PASS' : 'FAIL'}\n`);
  log(`[cat33]   run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'} publishable=${publishable}\n`);
  log(`[cat33]   receipt: ${receiptFile}\n`);

  const exitCode = summary.run_invalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, results, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat33(optionsFromEnv());
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT33_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT33_CATEGORY,
        run_status: 'error',
        n_total: 0,
        n_scored: 0,
        completion_rate: 0,
        errors: [{ probe_id: 'preflight', origin: 'harness', message: String(e?.message ?? e).slice(0, 500) }],
        publishable: false,
        gbrain_version: gbrainVersionResolved(),
        gbrain_pin: gbrainPin(),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });
    } catch { /* receipt write failed too */ }
    process.stderr.write(`[cat33] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
