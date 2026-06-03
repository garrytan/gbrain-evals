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
 *   transfer_lift = xopt_on_y - seed_on_y   (must be > margin)
 *   transfer_ratio = (xopt_on_y - seed_on_y) / max(eps, yopt_on_y - seed_on_y)
 *
 * Gate: X-optimized beats the unoptimized seed on Y (transfer lift > margin) on
 * >= ceil(0.75 * pairs), AND lands within a reasonable band of Y-optimized.
 * Per codex r2 #12 the seed-vs-Xopt comparison alone could just show the edit is
 * generically useful; the Y-optimized ceiling distinguishes "transferred" from
 * "trivially better".
 *
 * Scores are computed by the harness via gbrain's scoreSkillOnTasks (does NOT
 * trust receipts). Held-out task set is the transfer eval set (disjoint task_ids
 * from the benchmark the optimizer trained on).
 *
 * B-pre validity mode (SKILLOPT_BPRE=1): one seed, one (X,Y) pair, 1 epoch,
 * Haiku→Haiku (degenerate transfer, just confirms plumbing) — cheap.
 *
 * Run:
 *   SKILLOPT_BPRE=1 bun eval/runner/cat33-skillopt-transfer.ts   # validity
 *   bun eval/runner/cat33-skillopt-transfer.ts                   # full
 */

import { writeFileSync, mkdirSync, readFileSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { configureGateway } from 'gbrain/ai/gateway';
import { runSkillOpt } from '../../node_modules/gbrain/src/core/skillopt/orchestrator.ts';
import { scoreSkillOnTasks } from '../../node_modules/gbrain/src/core/skillopt/validate-gate.ts';
import { loadHeldOut } from '../../node_modules/gbrain/src/core/skillopt/held-out.ts';

const BPRE = process.env.SKILLOPT_BPRE === '1';
const OPTIMIZER_MODEL = process.env.SKILLOPT_OPTIMIZER_MODEL ?? (BPRE ? 'anthropic:claude-haiku-4-5' : 'anthropic:claude-sonnet-4-6');
const EPOCHS = Number(process.env.SKILLOPT_EPOCHS ?? (BPRE ? 1 : 3));
const BATCH_SIZE = Number(process.env.SKILLOPT_BATCH_SIZE ?? 5);
const RUNS_PER_TASK = Number(process.env.SKILLOPT_HELDOUT_RUNS ?? (BPRE ? 1 : 3));
const MAX_COST_USD = Number(process.env.SKILLOPT_MAX_COST_USD ?? (BPRE ? 3.0 : 6.0));
const SPLIT: [number, number, number] = [1, 1, 1];
const MARGIN = 0.05;

// (X, Y) model pairs: optimize on X, evaluate transfer on Y. Default exercises
// Haiku→Sonnet and Sonnet→Haiku so transfer is shown in both directions (a one-way
// pair could be confounded by Y simply being a stronger model).
const PAIRS: Array<{ x: string; y: string }> = BPRE
  ? [{ x: 'anthropic:claude-haiku-4-5', y: 'anthropic:claude-haiku-4-5' }]
  : (process.env.SKILLOPT_PAIRS
      ? process.env.SKILLOPT_PAIRS.split(',').map((p) => { const [x, y] = p.split('>'); return { x: x!, y: y! }; })
      : [
          { x: 'anthropic:claude-haiku-4-5', y: 'anthropic:claude-sonnet-4-6' },
          { x: 'anthropic:claude-sonnet-4-6', y: 'anthropic:claude-haiku-4-5' },
        ]);

const DATA = join(process.cwd(), 'eval/data/skillopt-v1');
const ALL_SEEDS = ['seed-missing-structure', 'seed-no-verdict'];
const SEEDS = BPRE ? ['seed-missing-structure'] : (process.env.SKILLOPT_SEEDS ? process.env.SKILLOPT_SEEDS.split(',') : ALL_SEEDS);

const ISOLATED_HOME = join(tmpdir(), `cat33-gbrain-home-${Date.now()}`);
mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.GBRAIN_HOME = ISOLATED_HOME;

interface PairResult {
  seed: string;
  x: string;
  y: string;
  seed_on_y: number;
  xopt_on_y: number;
  yopt_on_y: number;
  transfer_lift: number;
  transfer_ratio: number;
  transferred: boolean;
  cost_usd: number;
  error?: string;
}

/** Optimize `seedBody` on `targetModel`, return the best skill text (or seed on failure). */
async function optimizeOn(engine: any, seed: string, seedBody: string, benchmarkPath: string, targetModel: string): Promise<{ best: string; cost: number; outcome: string }> {
  const tmpSkills = join(ISOLATED_HOME, `skills-${seed}-${targetModel.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}`);
  mkdirSync(join(tmpSkills, seed), { recursive: true });
  cpSync(join(DATA, seed, 'SKILL.md'), join(tmpSkills, seed, 'SKILL.md'));
  try {
    const r = await runSkillOpt({
      engine, skillName: seed, skillsDir: tmpSkills, benchmarkPath,
      epochs: EPOCHS, batchSize: BATCH_SIZE, lr: 4, lrSchedule: 'cosine', split: SPLIT,
      optimizerModel: OPTIMIZER_MODEL, targetModel, judgeModel: targetModel,
      mode: 'patch', dryRun: false, noMutate: false, allowMutateBundled: false,
      bootstrapReviewed: false, json: true, maxCostUsd: MAX_COST_USD, maxRuntimeMin: 25, force: true,
    } as any);
    return { best: r.finalText ?? seedBody, cost: r.receipt?.final_cost_usd ?? 0, outcome: r.outcome };
  } catch (e: any) {
    process.stderr.write(`[cat33]   optimize-on-${targetModel} error: ${e?.message ?? e}\n`);
    return { best: seedBody, cost: 0, outcome: 'errored' };
  }
}

async function runPair(engine: any, seed: string, x: string, y: string): Promise<PairResult> {
  const seedDir = join(DATA, seed);
  const seedBody = readFileSync(join(seedDir, 'SKILL.md'), 'utf8');
  const benchmarkPath = join(seedDir, 'benchmark.jsonl');
  const transferTasks = loadHeldOut(join(seedDir, 'held-out.jsonl'));
  const scoreOnY = (skillText: string) => scoreSkillOnTasks({ engine, skillText, tasks: transferTasks, targetModel: y, judgeModel: y, runsPerTask: RUNS_PER_TASK });

  process.stderr.write(`[cat33] ${seed} (${x} → ${y}): optimizing on X...\n`);
  const xopt = await optimizeOn(engine, seed, seedBody, benchmarkPath, x);
  process.stderr.write(`[cat33]   X-opt outcome=${xopt.outcome} cost=$${xopt.cost.toFixed(3)}; scoring seed + X-opt on Y...\n`);

  const seedOnY = await scoreOnY(seedBody);
  const xoptOnY = await scoreOnY(xopt.best);

  // Ceiling: optimize natively on Y (skipped in B-pre where x===y to save cost).
  let yoptOnY = xoptOnY;
  let yCost = 0;
  if (!(BPRE && x === y)) {
    process.stderr.write(`[cat33]   optimizing on Y (ceiling)...\n`);
    const yopt = await optimizeOn(engine, seed, seedBody, benchmarkPath, y);
    yCost = yopt.cost;
    yoptOnY = await scoreOnY(yopt.best);
  }

  const transferLift = xoptOnY - seedOnY;
  const denom = Math.max(1e-6, yoptOnY - seedOnY);
  const transferRatio = transferLift / denom;
  process.stderr.write(`[cat33]   seed_on_Y=${seedOnY.toFixed(2)} Xopt_on_Y=${xoptOnY.toFixed(2)} Yopt_on_Y=${yoptOnY.toFixed(2)} lift=${transferLift >= 0 ? '+' : ''}${transferLift.toFixed(2)} ratio=${transferRatio.toFixed(2)}\n`);

  return {
    seed, x, y, seed_on_y: seedOnY, xopt_on_y: xoptOnY, yopt_on_y: yoptOnY,
    transfer_lift: transferLift, transfer_ratio: transferRatio,
    transferred: transferLift > MARGIN, cost_usd: xopt.cost + yCost,
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) { process.stderr.write('[cat33] ANTHROPIC_API_KEY missing. Aborting.\n'); process.exit(2); }
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, chat_model: PAIRS[0]!.y, env: process.env as Record<string, string | undefined> });
  const engine: any = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();

  const results: PairResult[] = [];
  for (const seed of SEEDS) for (const { x, y } of PAIRS) results.push(await runPair(engine, seed, x, y));
  await engine.disconnect();

  let gbrainVersion = 'unknown';
  try { const pkg = await import('gbrain/package.json' as any); gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown'; } catch { /* best-effort */ }

  const transferred = results.filter((r) => r.transferred).length;
  const totalCost = results.reduce((a, r) => a + r.cost_usd, 0);
  const gatePass = BPRE
    ? results.every((r) => !r.error) // validity: ran end-to-end
    : transferred >= Math.ceil(results.length * 0.75);

  const receipt = {
    schema_version: 1 as const, cat: 'cat33-skillopt-transfer', mode: BPRE ? 'b-pre-validity' : 'full',
    gbrain_version: gbrainVersion, timestamp: new Date().toISOString(), corpus: 'skillopt-v1',
    optimizer_model: OPTIMIZER_MODEL, epochs: EPOCHS, pairs: PAIRS, results,
    pairs_transferred: transferred, pairs_total: results.length, total_cost_usd: totalCost, gate_pass: gatePass,
  };
  const outDir = join(process.cwd(), 'eval/reports/cat33-skillopt-transfer');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat33${BPRE ? '-bpre' : ''}.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat33] ─── Scorecard (${BPRE ? 'B-PRE' : 'FULL'}) ───────────────\n`);
  for (const r of results) process.stderr.write(`[cat33]   ${r.seed} ${r.x}→${r.y}: seed=${r.seed_on_y.toFixed(2)} Xopt=${r.xopt_on_y.toFixed(2)} Yopt=${r.yopt_on_y.toFixed(2)} lift=${r.transfer_lift >= 0 ? '+' : ''}${r.transfer_lift.toFixed(2)} ${r.transferred ? 'TRANSFERRED' : ''}\n`);
  process.stderr.write(`[cat33]   transferred: ${transferred}/${results.length}  cost: $${totalCost.toFixed(2)}  GATE: ${gatePass ? 'PASS' : 'FAIL'}\n`);
  process.stderr.write(`[cat33]   receipt: ${outFile}\n`);
  process.exit(gatePass ? 0 : 1);
}

await main();
