/**
 * A1 headroom probe for the SkillOpt method benchmark (GST-799, plan decision A).
 *
 * Before any optimizer adapter is built, measure whether gbrain's shipped
 * skills leave room for an optimizer to show anything. It reads the default
 * dataset (skillopt-method-v2 since probe 1 saturated v1), selection split
 * only; the test split is never read. Per skill:
 *
 *   no-skill    a one-line neutral system prompt, Haiku 5.5, 3 runs per task
 *   seed        the shipped SKILL.md, Haiku 5.5, 3 runs per task
 *   one-shot    gbrain's `runSkillOpt` in one-shot-rewrite mode (Opus 5.5
 *               proposer, Haiku 5.5 target) over a benchmark file of the 24
 *               train tasks with split [1,22,1], so its forward pass and
 *               criteria come from train; two repeats, each rewrite scored on
 *               selection by this harness and kept only if it beats the seed
 *   seed-opus   the shipped SKILL.md on Opus 5.5, 1 run per task
 *
 * Scoring goes through gbrain's `scoreSkillOnTasks` with this benchmark's
 * counted scorer in its `scoreFn` seam (median of runs per task, mean over
 * tasks). The preregistered gate (docs/benchmarks/2026-11-01-skillopt-method/
 * PREREGISTRATION.md): build the server and the outside arms only if, on at
 * least two skills, the seed's selection score is in [0.2, 0.8] and the kept
 * one-shot rewrite stays at least 0.15 below the solvability ceiling. A stop
 * may rest only on skills whose frontmatter brain operations the rollout
 * serves in full; `toolCoverage` lists the gaps keylessly before any paid call.
 *
 * Run it through the category runner: `bun eval/runner/n15-skillopt-method.ts
 * --probe --paid --budget-run-id <id>`. `runProbe({ fake: true })` runs the same
 * path end to end on a deterministic in-process chat transport, keyless.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway, __setChatTransportForTests, type ChatOpts, type ChatResult } from 'gbrain/ai/gateway';
import { runSkillOpt, scoreSkillOnTasks, type BenchmarkTask } from 'gbrain/core/skillopt';
import { operations } from 'gbrain/operations';
import { READ_ONLY_BRAIN_TOOLS } from '../../../node_modules/gbrain/src/core/skillopt/rollout.ts';
import { loadCorpora, type MethodTask } from '../../generators/skillopt-method/common.ts';
import { datasetName, DEFAULT_DATASET, frontmatterTools, readSeed, readTasks } from './dataset.ts';
import { countedScoreFn, evaluateJudge, SKILLS, type ScoreFn, type SkillName } from './score.ts';

export const PROBE_MODELS = {
  target: 'anthropic:claude-haiku-5-5',
  proposer: 'anthropic:claude-opus-5-5',
  frontier: 'anthropic:claude-opus-5-5',
} as const;
export const PROBE_RUNS_PER_TASK = 3;
export const PROBE_FRONTIER_RUNS_PER_TASK = 1;
export const PROBE_REWRITE_REPEATS = 2;
export const PROBE_REWRITE_SPLIT: [number, number, number] = [1, 22, 1];
/**
 * Whole probe, three skills, at measured prices: probe 1 spent $19.82 on all but
 * fact-check's second rewrite and its Opus seed arm, $12.13 of it on Opus
 * rollouts that read long pages (PREREGISTRATION.md, amendment 1).
 */
export const PROBE_ESTIMATE_USD = 28;
/** Per one-shot repeat, passed to runSkillOpt as its own cap; the budget ledger enforces the probe total. */
export const PROBE_REWRITE_MAX_COST_USD = 3;
export const PROBE_REFLECT_MAX_TOKENS = 16_000;
export const PROBE_GATE = { seedLow: 0.2, seedHigh: 0.8, minRoomBelowCeiling: 0.15, minSkills: 2 } as const;
/** CLAUDE.md "Choose models": a run with no particle: route names particle-1 and why. */
export const MODELS_NOT_RUN = [
  { model: 'particle:particle-1', reason: 'the rollout runs through gbrain\'s gateway, which has no Particle recipe at the pinned gbrain (GBRA-268, plan decision D); particle-1 gets a test-only pass once that recipe reaches the pin' },
] as const;
/** The no-skill control's whole system prompt. */
export const NO_SKILL_TEXT = 'You have read-only tools over the user\'s brain, a knowledge base of their pages. Complete the task.';
/** Pinned before any rollout, as in Cats 30 to 33: no reranker, so no ambient provider key is used. */
export const PINNED_SEARCH_CONFIG: Readonly<Record<string, string>> = { 'search.mode': 'balanced', 'search.reranker.enabled': 'false' };

// ─── Tool coverage (keyless) ─────────────────────────────────────────────────

/** The brain operations a SkillOpt rollout serves to the target model at the installed gbrain. */
export function servedTools(): string[] {
  return operations.filter(op => READ_ONLY_BRAIN_TOOLS.has(op.name) && !op.mutating && !op.localOnly).map(op => op.name).sort();
}

export interface ToolCoverage { skill: SkillName; declared: string[]; missing: string[]; outside_brain: string[]; full: boolean }

/**
 * Each seed's frontmatter tools that are gbrain operations the rollout does not
 * serve: a harness limit the probe reports, and the gaps a stop must wait on.
 * Tools that are not gbrain operations (fact-check's web lane) are listed as
 * `outside_brain`: no gbrain rollout can serve them and no task needs them.
 */
export function toolCoverage(skills: readonly SkillName[] = SKILLS): ToolCoverage[] {
  const served = new Set(servedTools());
  const brainOps = new Set(operations.map(op => op.name));
  return skills.map(skill => {
    const declared = frontmatterTools(readSeed(skill));
    const missing = declared.filter(t => brainOps.has(t) && !served.has(t));
    const outside_brain = declared.filter(t => !brainOps.has(t));
    return { skill, declared, missing, outside_brain, full: missing.length === 0 };
  });
}

// ─── Gate ────────────────────────────────────────────────────────────────────

export interface SkillProbe {
  skill: SkillName;
  /** Share of selection tasks whose solvability control passes the scorer. */
  ceiling: number;
  no_skill: number | null;
  seed: number | null;
  /** Each repeat's rewrite scored on selection; null when the repeat produced no candidate or errored. */
  one_shot_repeats: Array<number | null>;
  /** The best repeat that beat the seed, else the seed's score. */
  one_shot_kept: number | null;
  seed_opus: number | null;
  tool_gaps: string[];
}

export type ProbeVerdict = 'build' | 'harden-and-reprobe' | 'stop' | 'out-of-band' | 'incomplete';

export interface GateResult {
  verdict: ProbeVerdict;
  qualifying: SkillName[];
  reasons: Record<string, string[]>;
  /** Skills with a tool gap a stop would rest on; the stop waits for their rerun once the rollout serves those tools. */
  waits_for_rerun: SkillName[];
}

/**
 * The preregistered A1 gate. `afterHardening` marks the second probe, after
 * the tasks were hardened once because one-shot reached the ceiling.
 */
export function probeGate(rows: readonly SkillProbe[], opts: { afterHardening?: boolean } = {}): GateResult {
  const reasons: Record<string, string[]> = {};
  const qualifying: SkillName[] = [];
  for (const r of rows) {
    const why: string[] = [];
    if (r.seed === null || r.one_shot_kept === null) why.push('incomplete');
    else {
      if (r.seed < PROBE_GATE.seedLow) why.push('seed-below-band');
      if (r.seed > PROBE_GATE.seedHigh) why.push('seed-above-band');
      if (r.ceiling - r.one_shot_kept < PROBE_GATE.minRoomBelowCeiling) why.push('one-shot-at-ceiling');
    }
    reasons[r.skill] = why;
    if (!why.length) qualifying.push(r.skill);
  }
  if (qualifying.length >= PROBE_GATE.minSkills) return { verdict: 'build', qualifying, reasons, waits_for_rerun: [] };
  const failing = rows.filter(r => reasons[r.skill]!.length);
  if (failing.some(r => reasons[r.skill]!.includes('incomplete'))) return { verdict: 'incomplete', qualifying, reasons, waits_for_rerun: [] };
  const atCeiling = failing.filter(r => reasons[r.skill]!.includes('one-shot-at-ceiling'));
  if (!atCeiling.length) return { verdict: 'out-of-band', qualifying, reasons, waits_for_rerun: [] };
  if (!opts.afterHardening) return { verdict: 'harden-and-reprobe', qualifying, reasons, waits_for_rerun: [] };
  return { verdict: 'stop', qualifying, reasons, waits_for_rerun: atCeiling.filter(r => r.tool_gaps.length).map(r => r.skill) };
}

// ─── Fake transport (keyless end-to-end) ─────────────────────────────────────

export const FAKE_REWRITE_MARKER = '<!-- n15 fake one-shot rewrite -->';

function lastUserText(opts: ChatOpts): string {
  const last = [...opts.messages].reverse().find(m => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return (last.content as unknown[]).map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
}

/**
 * Deterministic stand-in for every model the probe calls. The proposer
 * returns a body carrying FAKE_REWRITE_MARKER; the target answers with the
 * task's solvability-control answer when its system prompt carries the
 * marker, answers half the tasks that way under the seed (task ids ending in
 * an even digit), and says "I don't know" otherwise. It never calls a tool.
 */
export function fakeTransport(tasks: readonly MethodTask[]): (opts: ChatOpts) => Promise<ChatResult> {
  return async opts => {
    const system = opts.system ?? '';
    const mk = (text: string): ChatResult => ({
      text, blocks: [{ type: 'text', text }] as ChatResult['blocks'], stopReason: 'end',
      usage: { input_tokens: 40, output_tokens: 40, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model ?? 'fake:model', providerId: 'fake',
    } as ChatResult);
    if (system.includes("SkillOpt's optimizer")) return mk(`# Rewritten skill\n\n${FAKE_REWRITE_MARKER}\n\nAnswer from the brain and cite the page that holds the answer.`);
    const user = lastUserText(opts);
    const task = tasks.find(t => user.includes(t.task));
    if (!task) return mk("I don't know.");
    if (system.includes(FAKE_REWRITE_MARKER)) return mk(task.oracle_answer);
    if (system.includes(NO_SKILL_TEXT)) return mk("I don't know.");
    return mk(Number(task.task_id.slice(-1)) % 2 === 0 ? task.oracle_answer : "I don't know.");
  };
}

// ─── Probe ───────────────────────────────────────────────────────────────────

export interface ArmScore { score: number | null; per_task: Record<string, number[]>; error?: string }

export interface ProbeSkillResult extends SkillProbe {
  arms: {
    no_skill: ArmScore;
    seed: ArmScore;
    one_shot: Array<ArmScore & { outcome: string; rewrite_error?: string; text_sha8?: string; kept: boolean; cost_usd: number | null }>;
    seed_opus: ArmScore;
  };
  /** Proposed skill texts, for the audit (eval/runner/skillopt-method/audit.ts). */
  rewrites: string[];
}

export interface ProbeOptions {
  fake: boolean;
  skills?: readonly SkillName[];
  afterHardening?: boolean;
  log?: (line: string) => void;
  /** Called with each skill's result as soon as it is scored, so a later budget stop or crash keeps it. */
  onSkill?: (result: ProbeSkillResult) => void;
}

export interface ProbeResult {
  mode: 'fake' | 'live';
  models: typeof PROBE_MODELS;
  models_not_run: typeof MODELS_NOT_RUN;
  served_tools: string[];
  coverage: ToolCoverage[];
  skills: ProbeSkillResult[];
  gate: GateResult;
  /** Every task file the probe read (the test split must never appear). */
  files_read: string[];
  retrieval: string;
}

const benchTask = (t: MethodTask): BenchmarkTask => ({ task_id: t.task_id, task: t.task, judge: t.judge });
const sha8 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex').slice(0, 8);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function openBrain(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [key, value] of Object.entries(PINNED_SEARCH_CONFIG)) await engine.setConfig(key, value);
  for (const [slug, content] of loadCorpora().pages) await importFromContent(engine, slug, content, { noEmbed: true });
  return engine;
}

/**
 * Run the probe. The caller owns the environment: a live run needs
 * ANTHROPIC_API_KEY set and nothing else (the runner does this inside
 * withHermeticEnv after the paid-arm guard); a fake run installs the fake
 * transport and a dummy key itself and removes the transport afterwards.
 */
export async function runProbe(opts: ProbeOptions): Promise<ProbeResult> {
  const log = opts.log ?? (() => {});
  const skills = opts.skills ?? SKILLS;
  const filesRead: string[] = [];
  const load = (skill: SkillName, split: 'train' | 'sel') => {
    filesRead.push(`eval/data/${datasetName(DEFAULT_DATASET)}/${skill}/${split}.jsonl`);
    return readTasks(skill, split);
  };
  const data = new Map(skills.map(s => [s, { train: load(s, 'train'), sel: load(s, 'sel') }]));
  const coverage = toolCoverage(skills);

  if (opts.fake) {
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'dummy-fake-transport';
    __setChatTransportForTests(fakeTransport([...data.values()].flatMap(d => [...d.train, ...d.sel])));
  }
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, chat_model: PROBE_MODELS.target, env: process.env as Record<string, string | undefined> });

  const results: ProbeSkillResult[] = [];
  let engine: PGLiteEngine | null = null;
  try {
    engine = await openBrain();
    const brain = engine;
    const scoreArm = async (skillText: string, tasks: readonly MethodTask[], model: string, runs: number): Promise<ArmScore> => {
      const per_task: Record<string, number[]> = {};
      const scoreFn: ScoreFn = async (trajectory, judge) => {
        const r = await countedScoreFn(trajectory, judge);
        (per_task[trajectory.task_id] ??= []).push(r.score);
        return r;
      };
      try {
        const score = await scoreSkillOnTasks({ engine: brain, skillText, tasks: tasks.map(benchTask), targetModel: model, judgeModel: model, runsPerTask: runs, scoreFn });
        return { score, per_task };
      } catch (e) {
        return { score: null, per_task, error: errMsg(e) };
      }
    };

    for (const skill of skills) {
      const { train, sel } = data.get(skill)!;
      const seedText = readSeed(skill);
      log(`[n15 probe] ${skill}: ${sel.length} selection tasks, ${train.length} train tasks`);
      const ceiling = sel.filter(t => evaluateJudge(t.oracle_answer, t.judge).correct).length / sel.length;
      const noSkill = await scoreArm(NO_SKILL_TEXT, sel, PROBE_MODELS.target, PROBE_RUNS_PER_TASK);
      const seed = await scoreArm(seedText, sel, PROBE_MODELS.target, PROBE_RUNS_PER_TASK);
      log(`[n15 probe]   no-skill ${noSkill.score ?? 'error'}, seed ${seed.score ?? 'error'}`);

      const oneShot: ProbeSkillResult['arms']['one_shot'] = [];
      const rewrites: string[] = [];
      for (let repeat = 0; repeat < PROBE_REWRITE_REPEATS; repeat++) {
        const dir = mkdtempSync(join(tmpdir(), `n15-oneshot-${skill}-`));
        try {
          mkdirSync(join(dir, 'skills', skill), { recursive: true });
          writeFileSync(join(dir, 'skills', skill, 'SKILL.md'), seedText);
          const benchmarkPath = join(dir, 'train.jsonl');
          writeFileSync(benchmarkPath, train.map(t => JSON.stringify(benchTask(t))).join('\n') + '\n');
          const r = await runSkillOpt({
            engine: brain, skillName: skill, skillsDir: join(dir, 'skills'), benchmarkPath,
            epochs: 1, batchSize: 1, lr: 4, lrSchedule: 'constant', split: PROBE_REWRITE_SPLIT,
            optimizerModel: PROBE_MODELS.proposer, targetModel: PROBE_MODELS.target, judgeModel: PROBE_MODELS.target,
            reflectMaxTokens: PROBE_REFLECT_MAX_TOKENS, optimizerMode: 'one-shot-rewrite',
            mode: 'patch', dryRun: false, noMutate: true, allowMutateBundled: false, bootstrapReviewed: false, json: true,
            maxCostUsd: PROBE_REWRITE_MAX_COST_USD, maxCostSource: 'user', maxRuntimeMin: 30, force: true,
          });
          const cost = r.receipt?.final_cost_usd ?? null;
          if (r.outcome === 'errored' || r.finalText === seedText) {
            oneShot.push({ score: null, per_task: {}, outcome: r.outcome, rewrite_error: r.outcome === 'errored' ? 'runSkillOpt outcome errored' : 'no candidate (the rewrite was refused or empty)', kept: false, cost_usd: cost });
            continue;
          }
          rewrites.push(r.finalText);
          const scored = await scoreArm(r.finalText, sel, PROBE_MODELS.target, PROBE_RUNS_PER_TASK);
          oneShot.push({ ...scored, outcome: r.outcome, text_sha8: sha8(r.finalText), kept: false, cost_usd: cost });
        } catch (e) {
          oneShot.push({ score: null, per_task: {}, outcome: 'threw', rewrite_error: errMsg(e), kept: false, cost_usd: null });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      const beat = oneShot.filter(x => x.score !== null && seed.score !== null && x.score > seed.score).sort((a, b) => b.score! - a.score!)[0];
      if (beat) beat.kept = true;
      const seedOpus = await scoreArm(seedText, sel, PROBE_MODELS.frontier, PROBE_FRONTIER_RUNS_PER_TASK);
      log(`[n15 probe]   one-shot ${oneShot.map(x => x.score ?? 'none').join(', ')} (kept ${beat ? beat.score : 'seed'}), seed on Opus ${seedOpus.score ?? 'error'}`);
      const result: ProbeSkillResult = {
        skill, ceiling,
        no_skill: noSkill.score, seed: seed.score,
        one_shot_repeats: oneShot.map(x => x.score), one_shot_kept: beat ? beat.score : seed.score,
        seed_opus: seedOpus.score,
        tool_gaps: coverage.find(c => c.skill === skill)!.missing,
        arms: { no_skill: noSkill, seed, one_shot: oneShot, seed_opus: seedOpus },
        rewrites,
      };
      results.push(result);
      opts.onSkill?.(result);
    }
  } finally {
    if (opts.fake) __setChatTransportForTests(null);
    if (engine) await engine.disconnect().catch(() => {});
  }
  return {
    mode: opts.fake ? 'fake' : 'live',
    models: PROBE_MODELS,
    models_not_run: MODELS_NOT_RUN,
    served_tools: servedTools(),
    coverage,
    skills: results,
    gate: probeGate(results, { afterHardening: opts.afterHardening }),
    files_read: filesRead,
    retrieval: 'keyword only: pages imported with noEmbed and no embedding key in the process; reranker off',
  };
}
