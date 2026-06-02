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
 * Gate: A > {C one-shot, D no-gate} on held-out (the loop + the gate each earn
 * their cost), AND D shows HIGHER sel but LOWER/EQUAL held-out than A (the gate
 * prevents overfit — the core safety story). Paired-bootstrap p-value on A vs C.
 *
 * B-pre validity (SKILLOPT_BPRE=1): config A only, 1 trial, Haiku — cheap, just
 * confirms the ablation plumbing runs end-to-end.
 *
 * Run:
 *   SKILLOPT_BPRE=1 bun eval/runner/cat31-skillopt-ablation.ts   # validity
 *   bun eval/runner/cat31-skillopt-ablation.ts                   # full ($$$)
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
const TARGET_MODEL = process.env.SKILLOPT_TARGET_MODEL ?? 'anthropic:claude-haiku-4-5';
const OPTIMIZER_MODEL = process.env.SKILLOPT_OPTIMIZER_MODEL ?? (BPRE ? 'anthropic:claude-haiku-4-5' : 'anthropic:claude-sonnet-4-6');
const EPOCHS = Number(process.env.SKILLOPT_EPOCHS ?? (BPRE ? 1 : 3));
const BATCH_SIZE = Number(process.env.SKILLOPT_BATCH_SIZE ?? 5);
const RUNS_PER_TASK = Number(process.env.SKILLOPT_HELDOUT_RUNS ?? (BPRE ? 1 : 3));
const TRIALS = Number(process.env.SKILLOPT_TRIALS ?? (BPRE ? 1 : 2));
const MAX_COST_USD = Number(process.env.SKILLOPT_MAX_COST_USD ?? (BPRE ? 3.0 : 6.0));
const SEED = process.env.SKILLOPT_SEED ?? 'seed-missing-structure';
const SPLIT: [number, number, number] = [1, 1, 1];

type ConfigKey = 'A_full' | 'B_single_reflect' | 'C_one_shot' | 'D_no_gate';
const CONFIGS: Array<{ key: ConfigKey; opts: Record<string, unknown> }> = BPRE
  ? [{ key: 'A_full', opts: { reflectMode: 'both' } }]
  : [
      { key: 'A_full', opts: { reflectMode: 'both' } },
      { key: 'B_single_reflect', opts: { reflectMode: 'failure-only' } },
      { key: 'C_one_shot', opts: { optimizerMode: 'one-shot-rewrite' } },
      { key: 'D_no_gate', opts: { disableValidationGate: true } },
    ];

const DATA = join(process.cwd(), 'eval/data/skillopt-v1');
const ISOLATED_HOME = join(tmpdir(), `cat31-gbrain-home-${Date.now()}`);
mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.GBRAIN_HOME = ISOLATED_HOME;

// ── Pure paired-bootstrap p-value (inline; gbrain-evals harnesses may use RNG) ─
function pairedBootstrapPValue(deltas: number[], resamples = 2000): number {
  // H0: mean(delta) <= 0. p = fraction of bootstrap resample means <= 0.
  if (deltas.length === 0) return 1;
  let leq = 0;
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < deltas.length; i++) sum += deltas[Math.floor(Math.random() * deltas.length)]!;
    if (sum / deltas.length <= 0) leq += 1;
  }
  return leq / resamples;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

interface TrialScore { heldout: number; sel: number; cost: number; outcome: string }

async function runConfigTrial(engine: any, cfgOpts: Record<string, unknown>, seedBody: string, benchmarkPath: string, heldTasks: any[], tag: string): Promise<TrialScore> {
  const tmpSkills = join(ISOLATED_HOME, `skills-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(tmpSkills, SEED), { recursive: true });
  cpSync(join(DATA, SEED, 'SKILL.md'), join(tmpSkills, SEED, 'SKILL.md'));
  try {
    const r = await runSkillOpt({
      engine, skillName: SEED, skillsDir: tmpSkills, benchmarkPath,
      epochs: EPOCHS, batchSize: BATCH_SIZE, lr: 4, lrSchedule: 'cosine', split: SPLIT,
      optimizerModel: OPTIMIZER_MODEL, targetModel: TARGET_MODEL, judgeModel: TARGET_MODEL,
      mode: 'patch', dryRun: false, noMutate: false, allowMutateBundled: false,
      bootstrapReviewed: false, json: true, maxCostUsd: MAX_COST_USD, maxRuntimeMin: 25, force: true,
      ...cfgOpts,
    } as any);
    const heldout = await scoreSkillOnTasks({ engine, skillText: r.finalText ?? seedBody, tasks: heldTasks, targetModel: TARGET_MODEL, judgeModel: TARGET_MODEL, runsPerTask: RUNS_PER_TASK });
    return { heldout, sel: r.receipt?.best_sel_score ?? 0, cost: r.receipt?.final_cost_usd ?? 0, outcome: r.outcome };
  } catch (e: any) {
    process.stderr.write(`[cat31]   ${tag} error: ${e?.message ?? e}\n`);
    return { heldout: 0, sel: 0, cost: 0, outcome: 'errored' };
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) { process.stderr.write('[cat31] ANTHROPIC_API_KEY missing. Aborting.\n'); process.exit(2); }
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, chat_model: TARGET_MODEL, env: process.env as Record<string, string | undefined> });
  const engine: any = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();

  const seedDir = join(DATA, SEED);
  const seedBody = readFileSync(join(seedDir, 'SKILL.md'), 'utf8');
  const benchmarkPath = join(seedDir, 'benchmark.jsonl');
  const heldTasks = loadHeldOut(join(seedDir, 'held-out.jsonl'));

  // Reference floor: the unoptimized seed on held-out (cheap, no optimizer).
  const seedHeldout = await scoreSkillOnTasks({ engine, skillText: seedBody, tasks: heldTasks, targetModel: TARGET_MODEL, judgeModel: TARGET_MODEL, runsPerTask: RUNS_PER_TASK });
  process.stderr.write(`[cat31] reference: seed_heldout=${seedHeldout.toFixed(2)}\n`);

  const byConfig: Record<string, TrialScore[]> = {};
  for (const cfg of CONFIGS) {
    byConfig[cfg.key] = [];
    for (let t = 0; t < TRIALS; t++) {
      process.stderr.write(`[cat31] ${cfg.key} trial ${t + 1}/${TRIALS}...\n`);
      const s = await runConfigTrial(engine, cfg.opts, seedBody, benchmarkPath, heldTasks, `${cfg.key}-t${t}`);
      byConfig[cfg.key]!.push(s);
      process.stderr.write(`[cat31]   heldout=${s.heldout.toFixed(2)} sel=${s.sel.toFixed(2)} cost=$${s.cost.toFixed(2)} outcome=${s.outcome}\n`);
    }
  }
  await engine.disconnect();

  const meanHeldout = (k: ConfigKey) => mean((byConfig[k] ?? []).map((s) => s.heldout));
  const meanSel = (k: ConfigKey) => mean((byConfig[k] ?? []).map((s) => s.sel));
  const meanCost = (k: ConfigKey) => mean((byConfig[k] ?? []).map((s) => s.cost));

  let gatePass: boolean;
  let pAvsC: number | undefined;
  if (BPRE) {
    gatePass = (byConfig['A_full'] ?? []).every((s) => s.outcome !== 'errored');
  } else {
    const A = meanHeldout('A_full'), C = meanHeldout('C_one_shot'), D = meanHeldout('D_no_gate');
    const Dsel = meanSel('D_no_gate'), Asel = meanSel('A_full');
    // Paired A vs C deltas across trials (paired by trial index).
    const aTrials = byConfig['A_full'] ?? [], cTrials = byConfig['C_one_shot'] ?? [];
    const n = Math.min(aTrials.length, cTrials.length);
    const deltas = Array.from({ length: n }, (_, i) => aTrials[i]!.heldout - cTrials[i]!.heldout);
    pAvsC = pairedBootstrapPValue(deltas);
    // Loop earns its cost: A beats one-shot AND no-gate on held-out.
    const loopWins = A > C && A > D;
    // Gate prevents overfit: no-gate gets HIGHER sel (gameable) but LOWER/EQUAL held-out vs full.
    const gatePreventsOverfit = Dsel >= Asel && D <= A;
    gatePass = loopWins && gatePreventsOverfit;
  }

  let gbrainVersion = 'unknown';
  try { const pkg = await import('gbrain/package.json' as any); gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown'; } catch { /* best-effort */ }

  const receipt = {
    schema_version: 1 as const, cat: 'cat31-skillopt-ablation', mode: BPRE ? 'b-pre-validity' : 'full',
    gbrain_version: gbrainVersion, timestamp: new Date().toISOString(), seed: SEED,
    target_model: TARGET_MODEL, optimizer_model: OPTIMIZER_MODEL, epochs: EPOCHS, trials: TRIALS,
    seed_heldout: seedHeldout,
    configs: Object.fromEntries(CONFIGS.map((c) => [c.key, {
      mean_heldout: meanHeldout(c.key), mean_sel: meanSel(c.key), mean_cost_usd: meanCost(c.key), trials: byConfig[c.key],
    }])),
    paired_bootstrap_p_A_vs_C: pAvsC,
    gate_pass: gatePass,
  };
  const outDir = join(process.cwd(), 'eval/reports/cat31-skillopt-ablation');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat31${BPRE ? '-bpre' : ''}.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat31] ─── Scorecard (${BPRE ? 'B-PRE' : 'FULL'}) ───────────────\n`);
  process.stderr.write(`[cat31]   seed (floor): heldout=${seedHeldout.toFixed(2)}\n`);
  for (const c of CONFIGS) process.stderr.write(`[cat31]   ${c.key}: heldout=${meanHeldout(c.key).toFixed(2)} sel=${meanSel(c.key).toFixed(2)} cost=$${meanCost(c.key).toFixed(2)}\n`);
  if (pAvsC !== undefined) process.stderr.write(`[cat31]   paired-bootstrap p(A>C): ${pAvsC.toFixed(3)}\n`);
  process.stderr.write(`[cat31]   GATE: ${gatePass ? 'PASS' : 'FAIL'}   receipt: ${outFile}\n`);
  process.exit(gatePass ? 0 : 1);
}

await main();
