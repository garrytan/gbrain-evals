/**
 * BrainBench Cat 30 — SkillOpt improvement (v0.42.9.0).
 *
 * Headline question: does `gbrain skillopt` make a deficient skill measurably
 * BETTER on a HELD-OUT set it was never optimized against? Each seed has one
 * fixable flaw (missing structure, verbose, no brain-first, no verdict) and a
 * rule judge that catches it. We score the seed on the held-out set, run
 * skillopt against the benchmark, then score the OPTIMIZED skill on the same
 * held-out set. Improvement = optimized_heldout - baseline_heldout.
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: gbrain's SkillOpt pipeline end to end — `runSkillOpt`
 * (reflect → patch → D12 validation gate, orchestrator.ts) plus
 * `scoreSkillOnTasks` as the harness's INDEPENDENT held-out measurement
 * (does NOT trust the optimizer's own receipt).
 * LEGITIMATELY SEEDED/STUBBED: the committed skillopt-v1 seed corpus
 * (deterministic rule judges — free, no LLM) and, under --stub-llm only,
 * the gateway chat transport (`makeSkilloptStubTransport`: a deterministic
 * "obedient model" + scripted optimizer). Stub runs exercise the REAL
 * orchestrator/gate/scoring code paths hermetically but say nothing about
 * real model behavior — they are stamped publishable:false with
 * resolved_config.llm_transport='stubbed-obedient'.
 *
 * ── Scoring policy (WS0, eval/runner/probe-accounting.ts) ────────────
 * One probe per seed. runSkillOpt throwing or returning outcome 'errored'
 * is a SUT failure → scored 0 (seed not improved, stays in the gate
 * denominator). scoreSkillOnTasks throwing (rollout/judge infra) is a
 * dependency failure → excluded from the gate denominator, recorded,
 * capped. No probe ever silently vanishes.
 *
 * ── Verdict (real + failable) ────────────────────────────────────────
 * full  : improved (delta > 0.05) on >= ceil(0.75 * scored seeds), with at
 *         least one scored seed.
 * B-pre : every seed ran end-to-end (no error, outcome !== 'errored') AND
 *         its baseline held-out < 0.95 (the seed actually fails at baseline).
 * Exit non-zero unless verdict === 'pass'. Missing ANTHROPIC_API_KEY (and
 * not --stub-llm) → receipt run_status 'skipped' + NON-ZERO exit unless
 * --allow-skip / BRAINBENCH_ALLOW_SKIP=1.
 *
 * Run:
 *   SKILLOPT_BPRE=1 bun eval/runner/cat30-skillopt-improvement.ts   # validity (~$0.5)
 *   bun eval/runner/cat30-skillopt-improvement.ts                    # full (4 seeds)
 *   SKILLOPT_BPRE=1 bun eval/runner/cat30-skillopt-improvement.ts --stub-llm  # hermetic, no keys
 */

import { writeFileSync, mkdirSync, readFileSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import {
  configureGateway,
  __setChatTransportForTests,
  type ChatOpts,
  type ChatResult,
} from 'gbrain/ai/gateway';
// Deep src imports: gbrain's export map has no skillopt subpath yet (audit
// skillopt-cats-11). Works on the pinned flat bun/npm install this repo uses;
// requesting a proper `./core/skillopt` export upstream.
import { runSkillOpt } from '../../node_modules/gbrain/src/core/skillopt/orchestrator.ts';
import { scoreSkillOnTasks } from '../../node_modules/gbrain/src/core/skillopt/validate-gate.ts';
import { loadHeldOut } from '../../node_modules/gbrain/src/core/skillopt/held-out.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';

export const CAT30_CATEGORY = 'cat30-skillopt-improvement';

/** A seed "improved" when held-out delta clears this margin. */
export const IMPROVE_MARGIN = 0.05;
/** B-pre validity requires the seed to actually FAIL at baseline. */
export const BPRE_BASELINE_CEILING = 0.95;

/**
 * WS5 pin — applied via engine.setConfig BEFORE any rollout and echoed in
 * resolved_config. SkillOpt rollouts can call brain search tools, and
 * gbrain's default 'balanced' bundle silently enables the zerank-2 reranker
 * when ZEROENTROPY_API_KEY is set — never rely on defaults.
 */
export const PINNED_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
};

export const ALL_SEEDS = ['seed-missing-structure', 'seed-verbose', 'seed-no-brain-first', 'seed-no-verdict'];

// ─── Hermetic LLM stub (--stub-llm), shared by cat30-33 ─────────────────────

/**
 * Behavior knobs for the stub transport — used by regression tests to force
 * each failure mode the accounting must classify.
 */
export interface SkilloptStubBehavior {
  /**
   * Throw a must-abort (BUDGET_EXHAUSTED-tagged) error on every target-model
   * rollout. gbrain's runValidationGate rethrows must-abort errors instead of
   * scoring them 0, so this makes scoreSkillOnTasks/runSkillOpt genuinely
   * fail end-to-end (plain rollout errors are pessimistically scored 0 by
   * design and never propagate).
   */
  failRollouts?: boolean;
  /** Return unparseable judge output → llm-judge scores 0 with judge_error. */
  breakJudge?: boolean;
}

/** The structure mandate the scripted optimizer adds (satisfies the skillopt-v1 rule judges). */
export const STUB_STRUCTURE_MANDATE = `Always end the brief with:

1. A line starting "Recommendation:" giving a clear one-line verdict.
2. A "## Key Risks" section listing two specific, concrete risks.
3. A line starting "Confidence:" whose level is justified by the analysis.`;

const STUB_STRUCTURED_BRIEF = `Lead answer: ship the free tier only if support load stays bounded at the current team size.

Recommendation: yes — ship it with a hard usage cap and self-serve onboarding only.

## Key Risks
- Support cost can outgrow conversion revenue if the cap is set too high for a two-person team.
- Free users anchor pricing expectations, which makes the later paid conversion measurably harder.

Confidence: medium — both risks are stage-specific and the analysis above addresses them directly.`;

const STUB_PLAIN_BRIEF = `Ship it if support cost stays low; otherwise wait until the team can absorb the load. The deciding factor is whether free users convert at a rate that pays for their own support burden, which depends on the product's onboarding maturity.`;

const STUB_HOLLOW_BRIEF = `The answer is: it depends.

## Key Risks
- There are some risks.
- Consider them.

Confidence: medium`;

const STUB_ONE_SHOT_BODY = `# Brief Writer (optimized)

When asked, write a short, clear research brief that answers the question. Lead with the answer.

${STUB_STRUCTURE_MANDATE}`;

/**
 * Deterministic chat transport for hermetic runs (cat31/32/33 import this).
 * Routes on the system prompt:
 *
 *  - gbrain's LLM-judge prompt → JSON score from a substance heuristic
 *    (hollow boilerplate 0.1, structured+substantive 0.9, plain prose 0.35).
 *    This SIMULATES a quality judge so harness logic is testable; it says
 *    nothing about a real judge's discrimination.
 *  - SkillOpt optimizer prompts → a scripted edit adding the exact structure
 *    the skillopt-v1 rule judges require (patch mode: one `add` op anchored
 *    at the skill's H1; one-shot mode: a rewritten body).
 *  - anything else (target-model rollout; the system prompt IS the candidate
 *    skill) → an "obedient model": hollow hack template when the skill
 *    demands form-without-substance, structured sections when the skill
 *    mandates them, plain prose otherwise. Never calls tools.
 */
export function makeSkilloptStubTransport(behavior: SkilloptStubBehavior = {}): (opts: ChatOpts) => Promise<ChatResult> {
  return async (opts: ChatOpts): Promise<ChatResult> => {
    const system = opts.system ?? '';
    const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
    const userText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser!.content.map((b: any) => (typeof b === 'object' && b && 'text' in b ? b.text : '')).join('\n')
        : '';
    const mk = (text: string): ChatResult => ({
      text,
      blocks: [{ type: 'text', text } as any],
      stopReason: 'end',
      usage: { input_tokens: 50, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model ?? 'stub:model',
      providerId: 'stub',
    });

    // 1) LLM judge (score.ts LLM_JUDGE_SYSTEM).
    if (system.includes('strict, fair judge')) {
      if (behavior.breakJudge) return mk('the judge model refused to answer with JSON today');
      const outMatch = userText.match(/AGENT OUTPUT:\n([\s\S]*?)\n\nScore the output/);
      const out = outMatch ? outMatch[1]! : userText;
      let score = 0.35;
      if (/there are some risks/i.test(out) || out.trim().length < 120) score = 0.1;
      else if (/##\s+key risks/i.test(out) && /confidence\s*[:=]/i.test(out)) score = 0.9;
      return mk(JSON.stringify({ score, rationale: 'stub judge: substance heuristic' }));
    }

    // 2) SkillOpt optimizer (reflect.ts prompts).
    if (system.includes("SkillOpt's optimizer")) {
      if (system.includes('ONE-SHOT REWRITE')) return mk(STUB_ONE_SHOT_BODY);
      const bodyMatch = userText.match(/CURRENT SKILL BODY:\n([\s\S]*?)(?:\n\nSUCCESS CRITERIA|\n\nOBSERVED ROLLOUTS)/);
      const body = bodyMatch ? bodyMatch[1]! : userText;
      const h1 = body.match(/^# .+$/m)?.[0] ?? '';
      return mk(JSON.stringify({
        edits: [{ op: 'add', anchor: h1, content: STUB_STRUCTURE_MANDATE, reason: 'stub: add the structure the judge requires' }],
      }));
    }

    // 3) Target-model rollout — obey the skill (= system prompt).
    if (behavior.failRollouts) {
      const err: any = new Error('stub rollout failure (forced by test behavior)');
      err.tag = 'BUDGET_EXHAUSTED'; // must-abort tag: runValidationGate rethrows instead of scoring 0
      throw err;
    }
    if (/do not elaborate|do not add specifics/i.test(system)) return mk(STUB_HOLLOW_BRIEF);
    if (/key risks|confidence\s*:|recommendation\s*:/i.test(system)) return mk(STUB_STRUCTURED_BRIEF);
    return mk(STUB_PLAIN_BRIEF);
  };
}

// ─── Types + options ─────────────────────────────────────────────────────────

export interface SeedResult {
  seed: string;
  baseline_heldout: number | null;
  optimized_heldout: number | null;
  delta: number | null;
  outcome: string;
  baseline_sel_score?: number;
  best_sel_score?: number;
  final_cost_usd?: number;
  improved: boolean;
  error?: string;
  /** WS0 origin when error is set: 'sut' stays in the gate denominator (scored 0), 'dependency' is excluded. */
  error_origin?: 'sut' | 'dependency';
}

export interface Cat30Options {
  bpre?: boolean;
  stubLlm?: boolean;
  stubBehavior?: SkilloptStubBehavior;
  allowSkip?: boolean;
  seeds?: string[];
  targetModel?: string;
  optimizerModel?: string;
  judgeModel?: string;
  epochs?: number;
  batchSize?: number;
  runsPerTask?: number;
  maxCostUsd?: number;
  dataDir?: string;
  reportsDir?: string;
  quiet?: boolean;
  /** Test seam: substitute engine (default PGLiteEngine). */
  engineFactory?: () => Promise<any>;
  /** Test seams: substitute the gbrain functions under test. */
  runSkillOptFn?: typeof runSkillOpt;
  scoreFn?: typeof scoreSkillOnTasks;
}

export interface Cat30RunResult {
  receipt: Receipt;
  results: SeedResult[];
  exitCode: number;
  receiptFile: string;
}

export function optionsFromEnv(argv: string[] = process.argv.slice(2)): Cat30Options {
  const bpre = process.env.SKILLOPT_BPRE === '1';
  return {
    bpre,
    stubLlm: argv.includes('--stub-llm') || process.env.SKILLOPT_STUB === '1',
    allowSkip: argv.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    seeds: bpre ? ['seed-missing-structure'] : (process.env.SKILLOPT_SEEDS ? process.env.SKILLOPT_SEEDS.split(',') : undefined),
    targetModel: process.env.SKILLOPT_TARGET_MODEL,
    optimizerModel: process.env.SKILLOPT_OPTIMIZER_MODEL,
    judgeModel: process.env.SKILLOPT_JUDGE_MODEL,
    epochs: process.env.SKILLOPT_EPOCHS ? Number(process.env.SKILLOPT_EPOCHS) : undefined,
    batchSize: process.env.SKILLOPT_BATCH_SIZE ? Number(process.env.SKILLOPT_BATCH_SIZE) : undefined,
    runsPerTask: process.env.SKILLOPT_HELDOUT_RUNS ? Number(process.env.SKILLOPT_HELDOUT_RUNS) : undefined,
    maxCostUsd: process.env.SKILLOPT_MAX_COST_USD ? Number(process.env.SKILLOPT_MAX_COST_USD) : undefined,
  };
}

/** Outcomes that count as "ran end-to-end" ('errored' and 'aborted' do not). */
export const CLEAN_OUTCOMES: ReadonlySet<string> = new Set(['accepted', 'no_improvement']);

/**
 * Gate (exported so the regression test can prove both directions).
 * full  : improved on >= ceil(0.75 * scored seeds); dependency-errored seeds
 *         are excluded from the denominator; zero scored seeds = fail.
 * B-pre : ran end-to-end (no error at all, outcome in CLEAN_OUTCOMES) AND
 *         baseline < BPRE_BASELINE_CEILING on every seed.
 */
export function computeCat30Gate(results: SeedResult[], bpre: boolean): boolean {
  if (results.length === 0) return false;
  if (bpre) {
    return results.every((r) =>
      !r.error
      && CLEAN_OUTCOMES.has(r.outcome)
      && r.baseline_heldout !== null
      && r.baseline_heldout < BPRE_BASELINE_CEILING);
  }
  const scored = results.filter((r) => r.error_origin !== 'dependency');
  if (scored.length === 0) return false;
  const improved = scored.filter((r) => r.improved).length;
  return improved >= Math.ceil(scored.length * 0.75);
}

// ─── Per-seed run ─────────────────────────────────────────────────────────────

interface SeedRunDeps {
  engine: any;
  dataDir: string;
  isolatedHome: string;
  acc: ProbeAccounting;
  targetModel: string;
  optimizerModel: string;
  judgeModel: string;
  epochs: number;
  batchSize: number;
  runsPerTask: number;
  maxCostUsd: number;
  runSkillOptFn: typeof runSkillOpt;
  scoreFn: typeof scoreSkillOnTasks;
  log: (s: string) => void;
}

// split [1,1,1]: train5/sel5/test5 — sel>=5 (D_sel floor); test must be >0
// (splitBench rejects a zero segment). cat30 does NOT pass heldOutPath to
// runSkillOpt — the per-step held-out gate is cat32's job and is the real cost
// driver; here it would just add cost. The harness measures held-out before/
// after itself. Seeds are user-owned (temp dir), so the bundled ENFORCE never
// fires.
const SPLIT: [number, number, number] = [1, 1, 1];

async function runSeed(deps: SeedRunDeps, seed: string): Promise<SeedResult> {
  const { engine, acc, log } = deps;
  const seedDir = join(deps.dataDir, seed);
  const seedBody = readFileSync(join(seedDir, 'SKILL.md'), 'utf8');
  const benchmarkPath = join(seedDir, 'benchmark.jsonl');
  const heldOutTasks = loadHeldOut(join(seedDir, 'held-out.jsonl'));

  // Copy the seed into a temp skills dir so skillopt can mutate it in place
  // (and so it's NOT detected as a bundled/install-path skill).
  const tmpSkills = join(deps.isolatedHome, `skills-${seed}`);
  mkdirSync(join(tmpSkills, seed), { recursive: true });
  cpSync(join(seedDir, 'SKILL.md'), join(tmpSkills, seed, 'SKILL.md'));

  const scoreOpts = { engine, tasks: heldOutTasks, targetModel: deps.targetModel, judgeModel: deps.judgeModel, runsPerTask: deps.runsPerTask };

  log(`[cat30] ${seed}: scoring baseline on held-out (${heldOutTasks.length} tasks × ${deps.runsPerTask})...\n`);
  let baselineHeldout: number;
  try {
    baselineHeldout = await deps.scoreFn({ ...scoreOpts, skillText: seedBody });
  } catch (e: any) {
    const msg = `baseline held-out scoring failed: ${e?.message ?? e}`;
    acc.error(seed, 'dependency', msg);
    return { seed, baseline_heldout: null, optimized_heldout: null, delta: null, outcome: 'not_run', improved: false, error: msg, error_origin: 'dependency' };
  }
  log(`[cat30]   baseline_heldout=${baselineHeldout.toFixed(3)}\n`);

  log(`[cat30]   optimizing (epochs=${deps.epochs} batch=${deps.batchSize} target=${deps.targetModel} optimizer=${deps.optimizerModel} cap=$${deps.maxCostUsd})...\n`);
  let outcome = 'errored';
  let optimizedBody = seedBody;
  let receipt: any = {};
  try {
    const result = await deps.runSkillOptFn({
      engine,
      skillName: seed,
      skillsDir: tmpSkills,
      benchmarkPath,
      epochs: deps.epochs,
      batchSize: deps.batchSize,
      lr: 4,
      lrSchedule: 'cosine',
      split: SPLIT,
      optimizerModel: deps.optimizerModel,
      targetModel: deps.targetModel,
      judgeModel: deps.judgeModel,
      mode: 'patch',
      dryRun: false,
      noMutate: false,
      allowMutateBundled: false,
      bootstrapReviewed: false,
      json: true,
      maxCostUsd: deps.maxCostUsd,
      maxRuntimeMin: 20,
      force: true,
    } as any);
    outcome = result.outcome;
    optimizedBody = result.finalText ?? seedBody;
    receipt = result.receipt ?? {};
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    log(`[cat30]   skillopt error: ${msg}\n`);
    acc.error(seed, 'sut', `runSkillOpt threw: ${msg}`);
    return { seed, baseline_heldout: baselineHeldout, optimized_heldout: null, delta: null, outcome: 'errored', improved: false, error: msg, error_origin: 'sut' };
  }
  if (outcome === 'errored') {
    acc.error(seed, 'sut', 'runSkillOpt returned outcome errored');
    return { seed, baseline_heldout: baselineHeldout, optimized_heldout: null, delta: null, outcome, improved: false, error: 'skillopt outcome errored', error_origin: 'sut' };
  }

  log(`[cat30]   outcome=${outcome}; scoring OPTIMIZED on held-out...\n`);
  let optimizedHeldout: number;
  try {
    optimizedHeldout = await deps.scoreFn({ ...scoreOpts, skillText: optimizedBody });
  } catch (e: any) {
    const msg = `optimized held-out scoring failed: ${e?.message ?? e}`;
    acc.error(seed, 'dependency', msg);
    return { seed, baseline_heldout: baselineHeldout, optimized_heldout: null, delta: null, outcome, improved: false, error: msg, error_origin: 'dependency' };
  }
  const delta = optimizedHeldout - baselineHeldout;
  const improved = delta > IMPROVE_MARGIN;
  acc.score(seed, improved ? 1 : 0);
  log(`[cat30]   optimized_heldout=${optimizedHeldout.toFixed(3)} delta=${delta >= 0 ? '+' : ''}${delta.toFixed(3)} cost=$${(receipt.final_cost_usd ?? 0).toFixed(3)}\n`);

  return {
    seed,
    baseline_heldout: baselineHeldout,
    optimized_heldout: optimizedHeldout,
    delta,
    outcome,
    baseline_sel_score: receipt.baseline_sel_score,
    best_sel_score: receipt.best_sel_score,
    final_cost_usd: receipt.final_cost_usd,
    improved,
  };
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runCat30(options: Cat30Options = {}): Promise<Cat30RunResult> {
  const startedAt = new Date().toISOString();
  const bpre = options.bpre ?? false;
  const stub = options.stubLlm ?? false;
  const targetModel = options.targetModel ?? 'anthropic:claude-haiku-4-5';
  const optimizerModel = options.optimizerModel ?? (bpre ? 'anthropic:claude-haiku-4-5' : 'anthropic:claude-sonnet-4-6');
  const judgeModel = options.judgeModel ?? 'anthropic:claude-haiku-4-5'; // unused for rule judges
  const epochs = options.epochs ?? (bpre ? 1 : 2);
  const batchSize = options.batchSize ?? 5;
  const runsPerTask = options.runsPerTask ?? (bpre || stub ? 1 : 3);
  const maxCostUsd = options.maxCostUsd ?? (bpre ? 3.0 : 6.0);
  const seeds = options.seeds ?? (bpre ? ['seed-missing-structure'] : ALL_SEEDS);
  const dataDir = options.dataDir ?? join(process.cwd(), 'eval/data/skillopt-v1');
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT30_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);

  const baseReceipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT30_CATEGORY,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
  } as const;

  if (!stub && !process.env.ANTHROPIC_API_KEY) {
    const receipt: Receipt = {
      ...baseReceipt,
      run_status: 'skipped',
      skip_reason: 'ANTHROPIC_API_KEY missing (run with --stub-llm for a hermetic plumbing check)',
      n_total: seeds.length,
      n_scored: 0,
      completion_rate: 0,
      errors: [],
      publishable: false,
      finished_at: new Date().toISOString(),
    };
    writeReceipt(receiptFile, receipt);
    log(`[cat30] SKIPPED: ${receipt.skip_reason}\n[cat30] receipt: ${receiptFile}\n`);
    return { receipt, results: [], exitCode: options.allowSkip ? 0 : 1, receiptFile };
  }

  const isolatedHome = join(tmpdir(), `cat30-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(isolatedHome, { recursive: true });
  process.env.GBRAIN_HOME = isolatedHome;

  if (stub) {
    // Model construction/pricing lookup needs a non-empty key even with the
    // transport stubbed; the stub never lets a request leave the process.
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'dummy-stub-llm';
    __setChatTransportForTests(makeSkilloptStubTransport(options.stubBehavior));
  }

  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    chat_model: targetModel,
    env: process.env as Record<string, string | undefined>,
  });

  const acc = new ProbeAccounting(seeds.length);
  const results: SeedResult[] = [];
  let engine: any = null;
  try {
    engine = options.engineFactory ? await options.engineFactory() : new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    // WS5 pin BEFORE any rollout can touch search.
    for (const [key, value] of Object.entries(PINNED_CONFIG)) await engine.setConfig(key, value);

    const deps: SeedRunDeps = {
      engine, dataDir, isolatedHome, acc,
      targetModel, optimizerModel, judgeModel,
      epochs, batchSize, runsPerTask, maxCostUsd,
      runSkillOptFn: options.runSkillOptFn ?? runSkillOpt,
      scoreFn: options.scoreFn ?? scoreSkillOnTasks,
      log,
    };
    for (const seed of seeds) results.push(await runSeed(deps, seed));
  } finally {
    if (stub) __setChatTransportForTests(null);
    if (engine) await engine.disconnect().catch(() => {});
    rmSync(isolatedHome, { recursive: true, force: true });
  }

  const summary = acc.summary();
  const scoredResults = results.filter((r) => r.error_origin !== 'dependency');
  const improved = scoredResults.filter((r) => r.improved).length;
  const totalCost = results.reduce((a, r) => a + (r.final_cost_usd ?? 0), 0);
  const gatePass = computeCat30Gate(results, bpre);
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
      target_model: targetModel,
      optimizer_model: optimizerModel,
      judge_model: judgeModel,
      epochs, batch_size: batchSize, runs_per_task: runsPerTask,
      max_cost_usd: maxCostUsd,
      seeds,
      improve_margin: IMPROVE_MARGIN,
      corpus: 'skillopt-v1',
    },
    finished_at: new Date().toISOString(),
    data: {
      seeds: results,
      seeds_improved: improved,
      seeds_scored: scoredResults.length,
      seeds_total: results.length,
      total_cost_usd: totalCost,
      gate_pass: gatePass,
      infra_error_rate: summary.infra_error_rate,
    },
  };
  writeReceipt(receiptFile, receipt);

  // Human-readable dated detail file (legacy location, same payload).
  const outDir = join(reportsDir, CAT30_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat30${bpre ? '-bpre' : ''}.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat30] ─── Scorecard (${bpre ? 'B-PRE VALIDITY' : 'FULL'}${stub ? ', STUB LLM' : ''}) ───────────────\n`);
  for (const r of results) {
    log(`[cat30]   ${r.seed}: baseline=${r.baseline_heldout?.toFixed(2) ?? 'n/a'} → optimized=${r.optimized_heldout?.toFixed(2) ?? 'n/a'} (Δ${r.delta !== null && r.delta >= 0 ? '+' : ''}${r.delta?.toFixed(2) ?? 'n/a'}) ${r.improved ? 'IMPROVED' : ''}${r.error ? `ERROR(${r.error_origin}): ${r.error}` : ''}\n`);
  }
  log(`[cat30]   improved: ${improved}/${scoredResults.length} scored (${results.length} total)  cost: $${totalCost.toFixed(2)}\n`);
  log(`[cat30]   run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'} publishable=${publishable}\n`);
  log(`[cat30]   receipt: ${receiptFile}\n`);

  const exitCode = summary.run_invalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, results, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat30(optionsFromEnv());
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT30_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT30_CATEGORY,
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
    } catch { /* receipt write failed too — exit code carries the failure */ }
    process.stderr.write(`[cat30] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
