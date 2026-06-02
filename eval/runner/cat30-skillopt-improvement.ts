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
 * The harness computes held-out scores itself via gbrain's scoreSkillOnTasks
 * (does NOT trust the receipt) — the eval's measurement is independent of the
 * optimizer's own bookkeeping.
 *
 * Rule judges are deterministic + FREE; only target rollouts + optimizer
 * reflects cost money. 15-task benchmarks with split 1:1:1 → train5/sel5/test5.
 *
 * B-pre validity mode (SKILLOPT_BPRE=1): one seed, 1 epoch, Haiku-all, ~$0.50 —
 * confirms the seed actually FAILS at baseline + the plumbing works before any
 * full spend.
 *
 * Run:
 *   SKILLOPT_BPRE=1 bun eval/runner/cat30-skillopt-improvement.ts   # validity (~$0.5)
 *   bun eval/runner/cat30-skillopt-improvement.ts                    # full (4 seeds)
 */

import { writeFileSync, mkdirSync, readFileSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { configureGateway } from 'gbrain/ai/gateway';
import { runSkillOpt } from '../../node_modules/gbrain/src/core/skillopt/orchestrator.ts';
import { scoreSkillOnTasks } from '../../node_modules/gbrain/src/core/skillopt/validate-gate.ts';
import { loadHeldOut } from '../../node_modules/gbrain/src/core/skillopt/held-out.ts';

const BPRE = process.env.SKILLOPT_BPRE === '1';
const TARGET_MODEL = process.env.SKILLOPT_TARGET_MODEL ?? 'anthropic:claude-haiku-4-5';
const OPTIMIZER_MODEL = process.env.SKILLOPT_OPTIMIZER_MODEL ?? (BPRE ? 'anthropic:claude-haiku-4-5' : 'anthropic:claude-sonnet-4-6');
const JUDGE_MODEL = process.env.SKILLOPT_JUDGE_MODEL ?? 'anthropic:claude-haiku-4-5'; // unused for rule judges
const MAX_COST_USD = Number(process.env.SKILLOPT_MAX_COST_USD ?? (BPRE ? 3.0 : 6.0));
const EPOCHS = Number(process.env.SKILLOPT_EPOCHS ?? (BPRE ? 1 : 2));
const BATCH_SIZE = Number(process.env.SKILLOPT_BATCH_SIZE ?? 5);
const RUNS_PER_TASK = Number(process.env.SKILLOPT_HELDOUT_RUNS ?? (BPRE ? 1 : 3)); // median-of-N for the held-out measurement
// split [1,1,1]: train5/sel5/test5 — sel>=5 (D_sel floor); test must be >0
// (splitBench rejects a zero segment). cat30 does NOT pass heldOutPath to
// runSkillOpt — the per-step held-out gate is cat32's job and is the real cost
// driver; here it would just add cost. The harness measures held-out before/
// after itself. Seeds are user-owned (temp dir), so the bundled ENFORCE never
// fires.
const SPLIT: [number, number, number] = [1, 1, 1];

const DATA = join(process.cwd(), 'eval/data/skillopt-v1');
const ALL_SEEDS = ['seed-missing-structure', 'seed-verbose', 'seed-no-brain-first', 'seed-no-verdict'];
const SEEDS = BPRE
  ? ['seed-missing-structure']
  : (process.env.SKILLOPT_SEEDS ? process.env.SKILLOPT_SEEDS.split(',') : ALL_SEEDS);

const ISOLATED_HOME = join(tmpdir(), `cat30-gbrain-home-${Date.now()}`);
mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.GBRAIN_HOME = ISOLATED_HOME;

interface SeedResult {
  seed: string;
  baseline_heldout: number;
  optimized_heldout: number;
  delta: number;
  outcome: string;
  baseline_sel_score?: number;
  best_sel_score?: number;
  final_cost_usd?: number;
  improved: boolean;
  error?: string;
}

async function runSeed(engine: any, seed: string): Promise<SeedResult> {
  const seedDir = join(DATA, seed);
  const seedBody = readFileSync(join(seedDir, 'SKILL.md'), 'utf8');
  const benchmarkPath = join(seedDir, 'benchmark.jsonl');
  const heldOutPath = join(seedDir, 'held-out.jsonl');
  const heldOutTasks = loadHeldOut(heldOutPath);

  // Copy the seed into a temp skills dir so skillopt can mutate it in place
  // (and so it's NOT detected as a bundled/install-path skill).
  const tmpSkills = join(ISOLATED_HOME, `skills-${seed}`);
  const skillName = seed;
  mkdirSync(join(tmpSkills, skillName), { recursive: true });
  cpSync(join(seedDir, 'SKILL.md'), join(tmpSkills, skillName, 'SKILL.md'));

  const scoreOpts = { engine, tasks: heldOutTasks, targetModel: TARGET_MODEL, judgeModel: JUDGE_MODEL, runsPerTask: RUNS_PER_TASK };

  process.stderr.write(`[cat30] ${seed}: scoring baseline on held-out (${heldOutTasks.length} tasks × ${RUNS_PER_TASK})...\n`);
  const baselineHeldout = await scoreSkillOnTasks({ ...scoreOpts, skillText: seedBody });
  process.stderr.write(`[cat30]   baseline_heldout=${baselineHeldout.toFixed(3)}\n`);

  process.stderr.write(`[cat30]   optimizing (epochs=${EPOCHS} batch=${BATCH_SIZE} target=${TARGET_MODEL} optimizer=${OPTIMIZER_MODEL} cap=$${MAX_COST_USD})...\n`);
  let outcome = 'errored';
  let optimizedBody = seedBody;
  let receipt: any = {};
  try {
    const result = await runSkillOpt({
      engine,
      skillName,
      skillsDir: tmpSkills,
      benchmarkPath,
      epochs: EPOCHS,
      batchSize: BATCH_SIZE,
      lr: 4,
      lrSchedule: 'cosine',
      split: SPLIT,
      optimizerModel: OPTIMIZER_MODEL,
      targetModel: TARGET_MODEL,
      judgeModel: JUDGE_MODEL,
      mode: 'patch',
      dryRun: false,
      noMutate: false,
      allowMutateBundled: false,
      bootstrapReviewed: false,
      json: true,
      maxCostUsd: MAX_COST_USD,
      maxRuntimeMin: 20,
      force: true,
    } as any);
    outcome = result.outcome;
    optimizedBody = result.finalText ?? seedBody;
    receipt = result.receipt ?? {};
  } catch (e: any) {
    process.stderr.write(`[cat30]   skillopt error: ${e?.message ?? e}\n`);
    return { seed, baseline_heldout: baselineHeldout, optimized_heldout: baselineHeldout, delta: 0, outcome: 'errored', improved: false, error: String(e?.message ?? e) };
  }

  process.stderr.write(`[cat30]   outcome=${outcome}; scoring OPTIMIZED on held-out...\n`);
  const optimizedHeldout = await scoreSkillOnTasks({ ...scoreOpts, skillText: optimizedBody });
  const delta = optimizedHeldout - baselineHeldout;
  const MARGIN = 0.05;
  process.stderr.write(`[cat30]   optimized_heldout=${optimizedHeldout.toFixed(3)} delta=${delta >= 0 ? '+' : ''}${delta.toFixed(3)} cost=$${(receipt.final_cost_usd ?? 0).toFixed(3)}\n`);

  return {
    seed,
    baseline_heldout: baselineHeldout,
    optimized_heldout: optimizedHeldout,
    delta,
    outcome,
    baseline_sel_score: receipt.baseline_sel_score,
    best_sel_score: receipt.best_sel_score,
    final_cost_usd: receipt.final_cost_usd,
    improved: delta > MARGIN,
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('[cat30] ANTHROPIC_API_KEY missing — source ~/.zshrc. Aborting.\n');
    process.exit(2);
  }
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    chat_model: TARGET_MODEL,
    env: process.env as Record<string, string | undefined>,
  });

  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const results: SeedResult[] = [];
  for (const seed of SEEDS) {
    results.push(await runSeed(engine, seed));
  }
  await engine.disconnect();

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const improved = results.filter((r) => r.improved).length;
  const totalCost = results.reduce((a, r) => a + (r.final_cost_usd ?? 0), 0);
  // Gate (full): post > baseline by margin on >= 3/4 seeds. B-pre: validity only.
  const gatePass = BPRE ? results.every((r) => r.baseline_heldout < 0.95 && !r.error)
    : improved >= Math.ceil(SEEDS.length * 0.75);

  const receipt = {
    schema_version: 1 as const,
    cat: 'cat30-skillopt-improvement',
    mode: BPRE ? 'b-pre-validity' : 'full',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    corpus: 'skillopt-v1',
    target_model: TARGET_MODEL,
    optimizer_model: OPTIMIZER_MODEL,
    epochs: EPOCHS,
    batch_size: BATCH_SIZE,
    seeds: results,
    seeds_improved: improved,
    seeds_total: results.length,
    total_cost_usd: totalCost,
    gate_pass: gatePass,
  };

  const outDir = join(process.cwd(), 'eval/reports/cat30-skillopt-improvement');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat30${BPRE ? '-bpre' : ''}.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat30] ─── Scorecard (${BPRE ? 'B-PRE VALIDITY' : 'FULL'}) ───────────────\n`);
  for (const r of results) {
    process.stderr.write(`[cat30]   ${r.seed}: baseline=${r.baseline_heldout.toFixed(2)} → optimized=${r.optimized_heldout.toFixed(2)} (Δ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)}) ${r.improved ? 'IMPROVED' : ''}${r.error ? 'ERROR: ' + r.error : ''}\n`);
  }
  process.stderr.write(`[cat30]   improved: ${improved}/${results.length}  total cost: $${totalCost.toFixed(2)}\n`);
  process.stderr.write(`[cat30]   GATE: ${gatePass ? 'PASS' : 'FAIL'}\n`);
  process.stderr.write(`[cat30]   receipt: ${outFile}\n`);
  process.exit(gatePass ? 0 : 1);
}

await main();
