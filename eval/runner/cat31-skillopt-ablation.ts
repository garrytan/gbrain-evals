/**
 * BrainBench Cat 31 — SkillOpt ablation (v0.42.9.0).
 *
 * Answers the product/cost question: "is the loop worth running, and do its
 * parts pay off?" — NOT an optimizer-algorithm bake-off. All configs are
 * gbrain's own runSkillOpt with different internal knobs, scored on the SAME
 * held-out set so they're directly comparable.
 *
 * Configs (each repeated TRIALS times for a paired-bootstrap CI):
 *   A  full pipeline      reflectMode:'both'  + D12 validation gate
 *   B  single-reflect     reflectMode:'failure-only'  (cost/perf comparison —
 *                         report optimizer token cost alongside; full mode can
 *                         spend up to 2 optimizer calls/step so a raw A>B win is
 *                         confounded with spend, codex r2 #9)
 *   C  one-shot rewrite   optimizerMode:'one-shot-rewrite'  (the load-bearing
 *                         "do I even need the loop?" baseline — a real method)
 *   D  greedy no-gate     disableValidationGate:true  (accept every edit)
 * Plus reference floors (no optimizer spend):
 *   seed  the unoptimized seed scored directly
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: runSkillOpt's ablation knobs (reflectMode, optimizerMode,
 * disableValidationGate — real orchestrator switches) and scoreSkillOnTasks
 * as the independent held-out measurement. LEGITIMATELY SEEDED/STUBBED:
 * the committed skillopt-v1 seed corpus (deterministic rule judges) and,
 * under --stub-llm only, the gateway chat transport (cat30's deterministic
 * stub). Stub runs are plumbing verification, publishable:false.
 *
 * ── Gate (real + failable; matches the code, audit skillopt-cats-07) ──
 * full mode passes ONLY when ALL of:
 *   (1) every trial of every config ran clean — an errored trial in ANY arm
 *       invalidates the comparison (a crashed D_no_gate must never make the
 *       gate easier to pass; audit skillopt-cats-02);
 *   (2) loopLifts: mean A held-out beats the unoptimized seed floor by > 0.3
 *       (the loop earns its cost);
 *   (3) gateIsFree: mean A >= mean D - 0.05 (the validation gate never
 *       sacrifices held-out quality — its real payoff, blocking
 *       reward-hacking, is demonstrated in cat32).
 * A-vs-C (paired bootstrap p, SEEDED — reproducible) and per-config sel/cost
 * are reported informationally, NOT gated: on toy single-fix seeds a one-shot
 * rewrite legitimately ties the loop, and D's sel-overfit story is cat32's
 * job. B-pre (SKILLOPT_BPRE=1): config A only, 1 trial — plumbing validity.
 *
 * ── Scoring policy (WS0, eval/runner/probe-accounting.ts) ────────────
 * One probe per (config, trial) + one seed-floor probe. runSkillOpt throwing
 * or outcome 'errored' → origin 'sut' (scored 0 in accounting AND fails the
 * full-mode gate via clause 1). Held-out scoring throws → 'dependency'
 * (excluded from means, capped). Errored trials are NEVER averaged into
 * per-config means.
 *
 * Run:
 *   SKILLOPT_BPRE=1 bun eval/runner/cat31-skillopt-ablation.ts   # validity
 *   bun eval/runner/cat31-skillopt-ablation.ts                   # full ($$$)
 *   SKILLOPT_BPRE=1 bun eval/runner/cat31-skillopt-ablation.ts --stub-llm  # hermetic
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

export const CAT31_CATEGORY = 'cat31-skillopt-ablation';

export const LIFT_MARGIN = 0.3;
export const GATE_EPS = 0.05;
/** Fixed bootstrap seed — recorded in the receipt so the p-value is reproducible (audit skillopt-cats-05). */
export const BOOTSTRAP_SEED = 0x5eed31;

export type ConfigKey = 'A_full' | 'B_single_reflect' | 'C_one_shot' | 'D_no_gate';
const FULL_CONFIGS: Array<{ key: ConfigKey; opts: Record<string, unknown> }> = [
  { key: 'A_full', opts: { reflectMode: 'both' } },
  { key: 'B_single_reflect', opts: { reflectMode: 'failure-only' } },
  { key: 'C_one_shot', opts: { optimizerMode: 'one-shot-rewrite' } },
  { key: 'D_no_gate', opts: { disableValidationGate: true } },
];
const SPLIT: [number, number, number] = [1, 1, 1];

// ─── Seeded PRNG + paired bootstrap (audit skillopt-cats-05) ─────────────────

/** mulberry32 — tiny deterministic PRNG; same seed → same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** H0: mean(delta) <= 0. p = fraction of bootstrap resample means <= 0. Deterministic via injected rng. */
export function pairedBootstrapPValue(deltas: number[], resamples = 2000, rng: () => number = mulberry32(BOOTSTRAP_SEED)): number {
  if (deltas.length === 0) return 1;
  let leq = 0;
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i++) sum += deltas[Math.floor(rng() * deltas.length)]!;
    if (sum / deltas.length <= 0) leq += 1;
  }
  return leq / resamples;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// ─── Types + options ─────────────────────────────────────────────────────────

export interface TrialScore {
  heldout: number | null;
  sel: number | null;
  cost: number;
  outcome: string;
  error?: string;
  error_origin?: 'sut' | 'dependency';
}

export interface Cat31Options {
  bpre?: boolean;
  stubLlm?: boolean;
  stubBehavior?: SkilloptStubBehavior;
  allowSkip?: boolean;
  seed?: string;
  trials?: number;
  targetModel?: string;
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

export interface Cat31RunResult {
  receipt: Receipt;
  byConfig: Record<string, TrialScore[]>;
  exitCode: number;
  receiptFile: string;
}

export function optionsFromEnv(argv: string[] = process.argv.slice(2)): Cat31Options {
  return {
    bpre: process.env.SKILLOPT_BPRE === '1',
    stubLlm: argv.includes('--stub-llm') || process.env.SKILLOPT_STUB === '1',
    allowSkip: argv.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    seed: process.env.SKILLOPT_SEED,
    trials: process.env.SKILLOPT_TRIALS ? Number(process.env.SKILLOPT_TRIALS) : undefined,
    targetModel: process.env.SKILLOPT_TARGET_MODEL,
    optimizerModel: process.env.SKILLOPT_OPTIMIZER_MODEL,
    epochs: process.env.SKILLOPT_EPOCHS ? Number(process.env.SKILLOPT_EPOCHS) : undefined,
    batchSize: process.env.SKILLOPT_BATCH_SIZE ? Number(process.env.SKILLOPT_BATCH_SIZE) : undefined,
    runsPerTask: process.env.SKILLOPT_HELDOUT_RUNS ? Number(process.env.SKILLOPT_HELDOUT_RUNS) : undefined,
    maxCostUsd: process.env.SKILLOPT_MAX_COST_USD ? Number(process.env.SKILLOPT_MAX_COST_USD) : undefined,
  };
}

/**
 * Gate (exported so the regression test can prove both directions).
 * Errored/dep-failed trials fail the full-mode gate outright — they are never
 * averaged in, and a comparison with a crashed arm proves nothing (audit
 * skillopt-cats-02). Clean per-config means drive clauses 2 + 3.
 */
export function computeCat31Gate(args: {
  bpre: boolean;
  byConfig: Record<string, TrialScore[]>;
  seedHeldout: number;
}): { gatePass: boolean; reasons: string[]; cleanMeans: Record<string, number> } {
  const { bpre, byConfig, seedHeldout } = args;
  const reasons: string[] = [];
  const cleanMeans: Record<string, number> = {};
  for (const [key, trials] of Object.entries(byConfig)) {
    cleanMeans[key] = mean(trials.filter((t) => !t.error).map((t) => t.heldout ?? 0));
  }
  if (bpre) {
    const a = byConfig['A_full'] ?? [];
    const pass = a.length > 0 && a.every((s) => !s.error && CLEAN_OUTCOMES.has(s.outcome));
    if (!pass) reasons.push('B-pre validity: config A must run end-to-end with no errored/aborted trial');
    return { gatePass: pass, reasons, cleanMeans };
  }
  let pass = true;
  for (const [key, trials] of Object.entries(byConfig)) {
    const errored = trials.filter((t) => t.error);
    if (trials.length === 0 || errored.length > 0) {
      pass = false;
      reasons.push(`config ${key}: ${errored.length}/${trials.length} trial(s) errored — comparison invalid`);
    }
  }
  const A = cleanMeans['A_full'] ?? NaN;
  const D = cleanMeans['D_no_gate'] ?? NaN;
  const loopLifts = A - seedHeldout > LIFT_MARGIN;
  const gateIsFree = A >= D - GATE_EPS;
  if (!loopLifts) { pass = false; reasons.push(`loopLifts failed: A=${A.toFixed(2)} - seed=${seedHeldout.toFixed(2)} <= ${LIFT_MARGIN}`); }
  if (!gateIsFree) { pass = false; reasons.push(`gateIsFree failed: A=${A.toFixed(2)} < D=${D.toFixed(2)} - ${GATE_EPS}`); }
  return { gatePass: pass, reasons, cleanMeans };
}

// ─── Per-trial run ────────────────────────────────────────────────────────────

interface TrialDeps {
  engine: any;
  isolatedHome: string;
  dataDir: string;
  seed: string;
  acc: ProbeAccounting;
  targetModel: string;
  optimizerModel: string;
  epochs: number;
  batchSize: number;
  runsPerTask: number;
  maxCostUsd: number;
  runSkillOptFn: typeof runSkillOpt;
  scoreFn: typeof scoreSkillOnTasks;
  log: (s: string) => void;
}

async function runConfigTrial(deps: TrialDeps, cfgOpts: Record<string, unknown>, seedBody: string, benchmarkPath: string, heldTasks: any[], tag: string): Promise<TrialScore> {
  const tmpSkills = join(deps.isolatedHome, `skills-${tag}`);
  mkdirSync(join(tmpSkills, deps.seed), { recursive: true });
  cpSync(join(deps.dataDir, deps.seed, 'SKILL.md'), join(tmpSkills, deps.seed, 'SKILL.md'));
  let r: any;
  try {
    r = await deps.runSkillOptFn({
      engine: deps.engine, skillName: deps.seed, skillsDir: tmpSkills, benchmarkPath,
      epochs: deps.epochs, batchSize: deps.batchSize, lr: 4, lrSchedule: 'cosine', split: SPLIT,
      optimizerModel: deps.optimizerModel, targetModel: deps.targetModel, judgeModel: deps.targetModel,
      mode: 'patch', dryRun: false, noMutate: false, allowMutateBundled: false,
      bootstrapReviewed: false, json: true, maxCostUsd: deps.maxCostUsd, maxRuntimeMin: 25, force: true,
      ...cfgOpts,
    } as any);
  } catch (e: any) {
    const msg = `runSkillOpt threw: ${e?.message ?? e}`;
    deps.log(`[cat31]   ${tag} SUT error: ${msg}\n`);
    deps.acc.error(tag, 'sut', msg);
    return { heldout: null, sel: null, cost: 0, outcome: 'errored', error: msg, error_origin: 'sut' };
  }
  if (r.outcome === 'errored') {
    const msg = 'runSkillOpt returned outcome errored';
    deps.acc.error(tag, 'sut', msg);
    return { heldout: null, sel: r.receipt?.best_sel_score ?? null, cost: r.receipt?.final_cost_usd ?? 0, outcome: r.outcome, error: msg, error_origin: 'sut' };
  }
  try {
    const heldout = await deps.scoreFn({ engine: deps.engine, skillText: r.finalText ?? seedBody, tasks: heldTasks, targetModel: deps.targetModel, judgeModel: deps.targetModel, runsPerTask: deps.runsPerTask });
    deps.acc.score(tag, heldout);
    return { heldout, sel: r.receipt?.best_sel_score ?? 0, cost: r.receipt?.final_cost_usd ?? 0, outcome: r.outcome };
  } catch (e: any) {
    const msg = `held-out scoring failed: ${e?.message ?? e}`;
    deps.log(`[cat31]   ${tag} dependency error: ${msg}\n`);
    deps.acc.error(tag, 'dependency', msg);
    return { heldout: null, sel: r.receipt?.best_sel_score ?? null, cost: r.receipt?.final_cost_usd ?? 0, outcome: r.outcome, error: msg, error_origin: 'dependency' };
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runCat31(options: Cat31Options = {}): Promise<Cat31RunResult> {
  const startedAt = new Date().toISOString();
  const bpre = options.bpre ?? false;
  const stub = options.stubLlm ?? false;
  const targetModel = options.targetModel ?? 'anthropic:claude-haiku-4-5';
  const optimizerModel = options.optimizerModel ?? (bpre ? 'anthropic:claude-haiku-4-5' : 'anthropic:claude-sonnet-4-6');
  const epochs = options.epochs ?? (bpre ? 1 : 3);
  const batchSize = options.batchSize ?? 5;
  const runsPerTask = options.runsPerTask ?? (bpre || stub ? 1 : 3);
  const trials = options.trials ?? (bpre ? 1 : 2);
  const maxCostUsd = options.maxCostUsd ?? (bpre ? 3.0 : 6.0);
  const seed = options.seed ?? 'seed-missing-structure';
  const dataDir = options.dataDir ?? join(process.cwd(), 'eval/data/skillopt-v1');
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT31_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);
  const configs = bpre ? FULL_CONFIGS.slice(0, 1) : FULL_CONFIGS;

  const baseReceipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT31_CATEGORY,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
  } as const;

  const expected = configs.length * trials + 1; // +1 seed-floor probe

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
    log(`[cat31] SKIPPED: ${receipt.skip_reason}\n[cat31] receipt: ${receiptFile}\n`);
    return { receipt, byConfig: {}, exitCode: options.allowSkip ? 0 : 1, receiptFile };
  }

  const isolatedHome = join(tmpdir(), `cat31-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(isolatedHome, { recursive: true });
  process.env.GBRAIN_HOME = isolatedHome;

  if (stub) {
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'dummy-stub-llm';
    __setChatTransportForTests(makeSkilloptStubTransport(options.stubBehavior));
  }

  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, chat_model: targetModel, env: process.env as Record<string, string | undefined> });

  const acc = new ProbeAccounting(expected);
  const byConfig: Record<string, TrialScore[]> = {};
  let seedHeldout = NaN;
  let engine: any = null;
  try {
    engine = options.engineFactory ? await options.engineFactory() : new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    for (const [key, value] of Object.entries(PINNED_CONFIG)) await engine.setConfig(key, value);

    const seedDir = join(dataDir, seed);
    const seedBody = readFileSync(join(seedDir, 'SKILL.md'), 'utf8');
    const benchmarkPath = join(seedDir, 'benchmark.jsonl');
    const heldTasks = loadHeldOut(join(seedDir, 'held-out.jsonl'));
    const scoreFn = options.scoreFn ?? scoreSkillOnTasks;

    // Reference floor: the unoptimized seed on held-out (cheap, no optimizer).
    // A floor-scoring failure is fatal — the gate is meaningless without it.
    try {
      seedHeldout = await scoreFn({ engine, skillText: seedBody, tasks: heldTasks, targetModel, judgeModel: targetModel, runsPerTask });
      acc.score('seed-floor', seedHeldout);
    } catch (e: any) {
      acc.error('seed-floor', 'dependency', `seed floor scoring failed: ${e?.message ?? e}`);
      const summary = acc.summary();
      const receipt: Receipt = {
        ...baseReceipt,
        run_status: 'error',
        n_total: summary.n_total, n_scored: summary.n_scored, completion_rate: summary.completion_rate,
        errors: summary.errors, publishable: false,
        finished_at: new Date().toISOString(),
      };
      writeReceipt(receiptFile, receipt);
      log(`[cat31] FATAL: seed floor scoring failed — run_status=error\n`);
      return { receipt, byConfig, exitCode: 1, receiptFile };
    }
    log(`[cat31] reference: seed_heldout=${seedHeldout.toFixed(2)}\n`);

    const deps: TrialDeps = {
      engine, isolatedHome, dataDir, seed, acc,
      targetModel, optimizerModel, epochs, batchSize, runsPerTask, maxCostUsd,
      runSkillOptFn: options.runSkillOptFn ?? runSkillOpt,
      scoreFn,
      log,
    };
    for (const cfg of configs) {
      byConfig[cfg.key] = [];
      for (let t = 0; t < trials; t++) {
        log(`[cat31] ${cfg.key} trial ${t + 1}/${trials}...\n`);
        const s = await runConfigTrial(deps, cfg.opts, seedBody, benchmarkPath, heldTasks, `${cfg.key}-t${t}`);
        byConfig[cfg.key]!.push(s);
        log(`[cat31]   heldout=${s.heldout?.toFixed(2) ?? 'n/a'} sel=${s.sel?.toFixed(2) ?? 'n/a'} cost=$${s.cost.toFixed(2)} outcome=${s.outcome}\n`);
      }
    }
  } finally {
    if (stub) __setChatTransportForTests(null);
    if (engine) await engine.disconnect().catch(() => {});
    rmSync(isolatedHome, { recursive: true, force: true });
  }

  // Paired A vs C deltas across CLEAN trial pairs (reported, NOT gated — see header).
  const aClean = (byConfig['A_full'] ?? []).filter((t) => !t.error);
  const cClean = (byConfig['C_one_shot'] ?? []).filter((t) => !t.error);
  const n = Math.min(aClean.length, cClean.length);
  const deltas = Array.from({ length: n }, (_, i) => (aClean[i]!.heldout ?? 0) - (cClean[i]!.heldout ?? 0));
  const pAvsC = bpre ? undefined : pairedBootstrapPValue(deltas, 2000, mulberry32(BOOTSTRAP_SEED));

  const { gatePass, reasons, cleanMeans } = computeCat31Gate({ bpre, byConfig, seedHeldout });
  const summary = acc.summary();
  const verdict: 'pass' | 'fail' = gatePass ? 'pass' : 'fail';
  const publishable = summary.publishable && !stub && !bpre;
  const meanSel = (k: string) => mean((byConfig[k] ?? []).filter((t) => !t.error).map((s) => s.sel ?? 0));
  const meanCost = (k: string) => mean((byConfig[k] ?? []).map((s) => s.cost));

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
      seed,
      target_model: targetModel,
      optimizer_model: optimizerModel,
      epochs, batch_size: batchSize, runs_per_task: runsPerTask, trials,
      max_cost_usd: maxCostUsd,
      lift_margin: LIFT_MARGIN,
      gate_eps: GATE_EPS,
      bootstrap_seed: BOOTSTRAP_SEED,
      corpus: 'skillopt-v1',
    },
    finished_at: new Date().toISOString(),
    data: {
      seed_heldout: seedHeldout,
      configs: Object.fromEntries(Object.keys(byConfig).map((k) => [k, {
        mean_heldout_clean: cleanMeans[k],
        mean_sel: meanSel(k),
        mean_cost_usd: meanCost(k),
        trials: byConfig[k],
      }])),
      paired_bootstrap_p_A_vs_C: pAvsC,
      gate_pass: gatePass,
      gate_reasons: reasons,
      infra_error_rate: summary.infra_error_rate,
    },
  };
  writeReceipt(receiptFile, receipt);

  const outDir = join(reportsDir, CAT31_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat31${bpre ? '-bpre' : ''}.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat31] ─── Scorecard (${bpre ? 'B-PRE' : 'FULL'}${stub ? ', STUB LLM' : ''}) ───────────────\n`);
  log(`[cat31]   seed (floor): heldout=${seedHeldout.toFixed(2)}\n`);
  for (const k of Object.keys(byConfig)) log(`[cat31]   ${k}: heldout=${(cleanMeans[k] ?? NaN).toFixed(2)} sel=${meanSel(k).toFixed(2)} cost=$${meanCost(k).toFixed(2)}\n`);
  if (pAvsC !== undefined) log(`[cat31]   paired-bootstrap p(A>C): ${pAvsC.toFixed(3)} (seed=${BOOTSTRAP_SEED})\n`);
  for (const r of reasons) log(`[cat31]   gate: ${r}\n`);
  log(`[cat31]   run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'} publishable=${publishable}\n`);
  log(`[cat31]   GATE: ${gatePass ? 'PASS' : 'FAIL'}   receipt: ${receiptFile}\n`);

  const exitCode = summary.run_invalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, byConfig, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat31(optionsFromEnv());
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT31_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT31_CATEGORY,
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
    process.stderr.write(`[cat31] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
