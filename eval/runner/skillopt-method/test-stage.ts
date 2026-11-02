/**
 * Stage test of the frontier probe (GST-799, plan revision 3): the one read of
 * skillopt-method-v2's sealed test split, for the pairs stage F0b scored.
 *
 * Per target, for every skill in that target's F0b result, on the 36 test
 * tasks:
 *
 *   no skill   NO_SKILL_TEXT at 1 run per task
 *   seed       the shipped SKILL.md at 3 runs per task
 *   rewrite    the kept one-shot rewrite at 3 runs per task: this target's own
 *              (`rewrite_source: 'own'`), else the other target's kept rewrite
 *              of the same skill from its F0b result (`'other-target'`). With
 *              neither there is no rewrite arm, and `no_rewrite_reason` says
 *              why. The text scored is the one whose sha8 is the kept arm's
 *              `text_sha8`.
 *
 * An arm's score is the mean over tasks of the median of runs. Paired by task,
 * each pair reports seed minus no skill and rewrite minus seed, each with a 95%
 * percentile interval from a task-level bootstrap (`pairedBootstrap`: 10,000
 * resamples, seed 799), and each arm's cost per correct answer (its metered
 * USD over its correct rollouts). Two preregistrable verdicts read them:
 *
 *   shippedSkillVerdict  KEEP when the interval's lower bound is above 0 and
 *                        the exact McNemar p is below 0.05, CUT-CANDIDATE
 *                        when the point difference is 0 or below, else
 *                        FIX-METHOD
 *   rewriteVerdict       rewrite-beats-seed when the lower bound is above 0,
 *                        rewrite-worse when the upper bound is below 0, each
 *                        only with McNemar p below 0.05; else
 *                        no-difference-shown
 *
 * The machinery is F0a's and F0b's (probe.ts): only the target's key,
 * keyword-only retrieval, metered rollouts, the request-settings observer on a
 * live run, `onSkill` after each pair and the reprice trigger on a pair's mean
 * rollout cost. Only this stage reads the test split (`readSealedTestTasks`),
 * and its result lists every task file it read. A live run takes only live F0b
 * results; a fake run takes fake or live ones.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import type { MethodTask } from '../../generators/skillopt-method/common.ts';
import { exactMcNemar, seededRandom } from '../stats/paired.ts';
import { datasetName, DEFAULT_DATASET, readSealedTestTasks, readSeed } from './dataset.ts';
import {
  fakeTransport, FRONTIER_TARGET_NAMES, FRONTIER_TARGETS, MODELS_NOT_RUN, NO_SKILL_TEXT, observeModelRequests, openBrain, REPRICE_TRIGGER_USD, RETRIEVAL, servedTools, sha8, TARGET_KEY, withProbeGateway,
  type ChatTransport, type FrontierResult, type FrontierTarget, type RepriceTrigger, type RequestSettings,
} from './probe.ts';
import { emptyMeter, scoreArm, summarizeMeter, type ArmScore, type MeterSummary, type MeterTotals } from './rollouts.ts';
import { evaluateJudge, SKILLS, type SkillName } from './score.ts';

export const TEST_STAGE = 'test';
export const TEST_RUNS = { no_skill: 1, seed: 3, rewrite: 3 } as const;
/** Test tasks per skill in skillopt-method-v2. */
export const TEST_TASKS = 36;
/** 252 rollouts for a pair with a rewrite arm, 144 without. */
export const testRolloutsPerPair = (rewrite: boolean) => TEST_TASKS * (TEST_RUNS.no_skill + TEST_RUNS.seed + (rewrite ? TEST_RUNS.rewrite : 0));

/** Measured mean cost per rollout per pair: the mean of the pair's F0a and F0b figures in probe/frontier's receipts, rounded. */
export const TEST_ROLLOUT_USD: Readonly<Record<FrontierTarget, Readonly<Record<SkillName, number>>>> = {
  opus: { query: 0.129, briefing: 0.29, 'fact-check': 0.17 },
  sol: { query: 0.0325, briefing: 0.064, 'fact-check': 0.073 },
};

export function testStageEstimateUsd(target: FrontierTarget, pairs: ReadonlyArray<{ skill: SkillName; rewrite: boolean }>): number {
  return pairs.reduce((n, p) => n + testRolloutsPerPair(p.rewrite) * TEST_ROLLOUT_USD[target][p.skill], 0);
}

/** Every skill with a rewrite arm: Opus $148.43 and Sol $42.71, about $191 for the six pairs. */
export const TEST_STAGE_ESTIMATE_USD = Object.fromEntries(FRONTIER_TARGET_NAMES.map(t => [t, testStageEstimateUsd(t, SKILLS.map(skill => ({ skill, rewrite: true })))])) as Readonly<Record<FrontierTarget, number>>;

// ─── Paired analysis and verdicts ────────────────────────────────────────────

export const TEST_BOOTSTRAP = { resamples: 10_000, seed: 799 } as const;

export interface PairedDifference {
  tasks: number;
  point: number;
  lower: number;
  upper: number;
  /** Tasks where the later arm passed and the earlier failed, and the reverse. */
  wins: number;
  losses: number;
  /** Exact two-sided McNemar p on the discordant tasks; null when a difference is not -1, 0 or 1. */
  mcnemar_p: number | null;
}

/** Both verdicts need the exact McNemar test below this as well as the bootstrap interval. */
export const MCNEMAR_ALPHA = 0.05;

/**
 * The mean of per-task differences and its 95% percentile interval from a
 * task-level bootstrap: tasks resampled with replacement under a fixed seed,
 * the interval read as order statistics of the sorted resample means (the
 * convention of stats/paired.ts). Null with no tasks.
 */
export function pairedBootstrap(diffs: readonly number[], o: { resamples: number; seed: number } = TEST_BOOTSTRAP): PairedDifference | null {
  const n = diffs.length;
  if (!n) return null;
  const rand = seededRandom(o.seed);
  const means = new Float64Array(o.resamples);
  for (let b = 0; b < o.resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)]!;
    means[b] = sum / n;
  }
  means.sort();
  const binary = diffs.every(d => d === -1 || d === 0 || d === 1);
  const mcnemar = binary ? exactMcNemar(diffs.map((d, i) => ({ id: String(i), cluster: String(i), a: d < 0 ? 1 : 0, b: d > 0 ? 1 : 0 }))) : null;
  return {
    tasks: n, point: diffs.reduce((a, d) => a + d, 0) / n, lower: means[Math.floor(o.resamples * 0.025)]!, upper: means[Math.ceil(o.resamples * 0.975) - 1]!,
    wins: diffs.filter(d => d > 0).length, losses: diffs.filter(d => d < 0).length, mcnemar_p: mcnemar?.p_two_sided ?? null,
  };
}

const significant = (d: Pick<PairedDifference, 'mcnemar_p'>) => d.mcnemar_p !== null && d.mcnemar_p < MCNEMAR_ALPHA;

/** Arm b minus arm a, paired by task on each task's median of runs; null when either arm is unscored. */
export function armDifference(b: ArmScore, a: ArmScore): PairedDifference | null {
  if (b.score === null || a.score === null || !b.task_medians || !a.task_medians) return null;
  const mb = b.task_medians;
  const ma = a.task_medians;
  return pairedBootstrap(Object.keys(ma).filter(id => id in mb).map(id => mb[id]! - ma[id]!));
}

export type ShippedSkillVerdict = 'KEEP' | 'CUT-CANDIDATE' | 'FIX-METHOD';

/** The shipped skill (seed) against no skill. */
export function shippedSkillVerdict(d: Pick<PairedDifference, 'point' | 'lower' | 'mcnemar_p'>): ShippedSkillVerdict {
  if (d.lower > 0 && significant(d)) return 'KEEP';
  if (d.point <= 0) return 'CUT-CANDIDATE';
  return 'FIX-METHOD';
}

export type RewriteVerdict = 'rewrite-beats-seed' | 'rewrite-worse' | 'no-difference-shown';

/** The kept one-shot rewrite against the seed. */
export function rewriteVerdict(d: Pick<PairedDifference, 'lower' | 'upper' | 'mcnemar_p'>): RewriteVerdict {
  if (d.lower > 0 && significant(d)) return 'rewrite-beats-seed';
  if (d.upper < 0 && significant(d)) return 'rewrite-worse';
  return 'no-difference-shown';
}

// ─── Which rewrite each pair scores ──────────────────────────────────────────

export interface RewritePick {
  source: 'own' | 'other-target';
  /** The target whose F0b proposed and kept it. */
  target: FrontierTarget;
  /** Its number among that pair's rewrites, as in one-shot/<target>-<skill>-rewrite-<n>.txt. */
  number: number;
  text_sha8: string;
  selection_score: number;
  text: string;
}

export interface TestPlanPair { skill: SkillName; rewrite: RewritePick | null; no_rewrite_reason?: string }

/** A rewrite file an F0b run wrote beside its receipt. */
export const rewritePath = (receiptPath: string, target: FrontierTarget, skill: SkillName, n: number) => join(dirname(receiptPath), 'one-shot', `${target}-${skill}-rewrite-${n}.txt`);

/** An F0b receipt's result with each pair's rewrite texts read back from the one-shot files beside it, in order. */
export function withRewriteTexts(r: FrontierResult, receiptPath: string): FrontierResult {
  return {
    ...r,
    skills: r.skills.map(s => {
      const rewrites: string[] = [];
      for (let n = 1; existsSync(rewritePath(receiptPath, r.target, s.skill, n)); n++) rewrites.push(readFileSync(rewritePath(receiptPath, r.target, s.skill, n), 'utf8'));
      return { ...s, rewrites };
    }),
  };
}

function keptRewrite(r: FrontierResult | null | undefined, skill: SkillName, source: RewritePick['source']): RewritePick | null {
  const row = r?.skills.find(s => s.skill === skill);
  const arm = row?.arms.one_shot?.find(a => a.kept);
  if (!r || !row || !arm || arm.score === null || !arm.text_sha8) return null;
  const texts = row.rewrites ?? [];
  const at = texts.findIndex(t => sha8(t) === arm.text_sha8);
  if (at < 0) throw new Error(`${r.target} ${skill}: no rewrite text matches the kept rewrite's text_sha8 ${arm.text_sha8} (${texts.length} rewrite texts read)`);
  return { source, target: r.target, number: at + 1, text_sha8: arm.text_sha8, selection_score: arm.score, text: texts[at]! };
}

function noKeptRewrite(r: FrontierResult | null | undefined, skill: SkillName, target: FrontierTarget): string {
  const row = r?.skills.find(s => s.skill === skill);
  if (!r) return `${target}: no F0b result read`;
  if (!row) return `${target}: no F0b pair`;
  if (row.skipped) return `${target}: F0b skipped the pair (${row.skipped})`;
  return `${target}: no rewrite beat the seed (${(row.arms.one_shot ?? []).map(a => (a.outcome === 'scored' && a.score !== null ? `scored ${a.score.toFixed(2)}` : a.outcome)).join(', ')})`;
}

function checkedF0b(o: TestStageOptions): { from: FrontierResult; other: FrontierResult | null } {
  const otherTarget = FRONTIER_TARGET_NAMES.find(t => t !== o.target)!;
  const problems = (r: FrontierResult, target: FrontierTarget) => [
    r.stage !== 'f0b' && `it is stage ${r.stage}`,
    r.target !== target && `it is for target ${r.target}`,
    !o.fake && r.mode !== 'live' && `it is a ${r.mode} run`,
    r.dataset !== datasetName(DEFAULT_DATASET) && `it read ${r.dataset}`,
  ].filter(Boolean);
  const refuse = (flag: string, target: FrontierTarget, found: unknown[]) => {
    if (found.length) throw new Error(`stage test for ${o.target}${o.fake ? ' (fake)' : ''} needs ${target}'s ${o.fake ? '' : 'live '}F0b result on ${datasetName(DEFAULT_DATASET)} in ${flag}, but ${found.join(', ')}`);
  };
  if (!o.from) throw new Error("stage test reads this target's F0b result (--from <F0b receipt>)");
  refuse('--from', o.target, problems(o.from, o.target));
  if (o.other) refuse('--other', otherTarget, problems(o.other, otherTarget));
  return { from: o.from, other: o.other ?? null };
}

/** Each pair stage test scores, with its rewrite; refuses F0b results the run may not read (see the header). */
export function planTestStage(o: TestStageOptions): TestPlanPair[] {
  const { from, other } = checkedF0b(o);
  const otherTarget = FRONTIER_TARGET_NAMES.find(t => t !== o.target)!;
  return from.skills.map(s => s.skill).filter(s => !o.skills || o.skills.includes(s)).map(skill => {
    const rewrite = keptRewrite(from, skill, 'own') ?? keptRewrite(other, skill, 'other-target');
    if (rewrite) return { skill, rewrite };
    return { skill, rewrite: null, no_rewrite_reason: `no kept rewrite on either target: ${noKeptRewrite(from, skill, o.target)}; ${noKeptRewrite(other, skill, otherTarget)}` };
  });
}

// ─── The stage ───────────────────────────────────────────────────────────────

export interface TestStageOptions {
  target: FrontierTarget;
  fake: boolean;
  /** This target's F0b result, with each pair's rewrite texts (`withRewriteTexts` for a receipt). */
  from?: FrontierResult;
  /** The other target's F0b result, for a pair with no kept rewrite of its own. */
  other?: FrontierResult | null;
  skills?: readonly SkillName[];
  /** A brain the caller opened with openBrain() and disconnects; default: one per run. */
  engine?: PGLiteEngine;
  log?: (line: string) => void;
  /** Called with each pair's result as soon as it is scored, so a later budget stop or crash keeps it. */
  onSkill?: (result: TestPairResult) => void;
  /** Fake runs only: the chat transport (default fakeTransport). */
  transport?: (tasks: readonly MethodTask[]) => ChatTransport;
}

export interface TestArm extends ArmScore {
  runs: number;
  correct_rollouts: number;
  cost: MeterSummary;
  /** The arm's metered USD over its correct rollouts; null when none is correct. */
  cost_per_correct_usd: number | null;
}

export interface TestPairResult {
  skill: SkillName;
  target: FrontierTarget;
  /** Share of test tasks whose solvability control passes the scorer. */
  ceiling: number;
  /** A reprice trigger stopped the stage before this pair. */
  skipped?: 'reprice-trigger';
  rewrite_source: RewritePick['source'] | null;
  rewrite_target: FrontierTarget | null;
  rewrite_number: number | null;
  rewrite_sha8: string | null;
  rewrite_selection_score: number | null;
  no_rewrite_reason?: string;
  no_skill: number | null;
  seed: number | null;
  rewrite: number | null;
  served_tools: { seed: string[]; rewrite?: string[] };
  arms: { no_skill?: TestArm; seed?: TestArm; rewrite?: TestArm };
  seed_minus_no_skill: (PairedDifference & { verdict: ShippedSkillVerdict }) | null;
  rewrite_minus_seed: (PairedDifference & { verdict: RewriteVerdict }) | null;
  /** This pair's rollouts, all arms; null when it did not run. */
  cost: MeterSummary | null;
}

export interface TestStageResult {
  mode: 'fake' | 'live';
  stage: typeof TEST_STAGE;
  target: FrontierTarget;
  models: { target: string; proposer: null };
  dataset: string;
  runs: typeof TEST_RUNS;
  bootstrap: typeof TEST_BOOTSTRAP;
  models_not_run: typeof MODELS_NOT_RUN;
  skills: TestPairResult[];
  reprice_trigger: RepriceTrigger | null;
  /** Every task file the stage read: the test split of each planned pair. */
  files_read: string[];
  retrieval: string;
  /** Live runs: the settings gbrain sent each provider, grouped. */
  request_settings: RequestSettings[] | null;
}

const METER_COUNTS = ['rollouts', 'calls', 'usd', 'unpriced_calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'] as const;

function addMeter(into: MeterTotals, m: MeterTotals): void {
  for (const k of METER_COUNTS) into[k] += m[k];
  if (m.reasoning_tokens !== null) into.reasoning_tokens = (into.reasoning_tokens ?? 0) + m.reasoning_tokens;
}

/**
 * Run stage test for one target (see the header). The caller owns the
 * environment of a live run: the target's key and nothing else.
 */
export async function runTestStage(o: TestStageOptions): Promise<TestStageResult> {
  const log = o.log ?? (() => {});
  const model = FRONTIER_TARGETS[o.target];
  const plan = planTestStage(o);
  const filesRead: string[] = [];
  const tasks = new Map(plan.map(p => {
    filesRead.push(`eval/data/${datasetName(DEFAULT_DATASET)}/${p.skill}/test.jsonl`);
    return [p.skill, readSealedTestTasks(p.skill)] as const;
  }));
  const transport = o.fake ? (o.transport ?? fakeTransport)([...tasks.values()].flat()) : undefined;

  const results: TestPairResult[] = [];
  let trigger: RepriceTrigger | null = null;
  const engine = o.engine ?? await openBrain();
  const observer = o.fake ? null : observeModelRequests();
  try {
    await withProbeGateway({ chatModel: model, fake: o.fake, transport, keys: [TARGET_KEY[o.target]] }, async () => {
      for (const { skill, rewrite, no_rewrite_reason } of plan) {
        const test = tasks.get(skill)!;
        const seedText = readSeed(skill);
        const base = {
          skill, target: o.target, ceiling: test.filter(t => evaluateJudge(t.oracle_answer, t.judge).correct).length / test.length,
          rewrite_source: rewrite?.source ?? null, rewrite_target: rewrite?.target ?? null, rewrite_number: rewrite?.number ?? null,
          rewrite_sha8: rewrite?.text_sha8 ?? null, rewrite_selection_score: rewrite?.selection_score ?? null,
          ...(no_rewrite_reason ? { no_rewrite_reason } : {}),
          served_tools: { seed: servedTools(seedText), ...(rewrite ? { rewrite: servedTools(rewrite.text) } : {}) },
        };
        if (trigger) {
          results.push({ ...base, skipped: 'reprice-trigger', no_skill: null, seed: null, rewrite: null, arms: {}, seed_minus_no_skill: null, rewrite_minus_seed: null, cost: null });
          continue;
        }
        log(`[n15 probe] ${o.target} test ${skill}: no skill x${TEST_RUNS.no_skill}, seed x${TEST_RUNS.seed}${rewrite ? `, ${rewrite.target}'s rewrite ${rewrite.number} (${rewrite.text_sha8}, ${rewrite.source}) x${TEST_RUNS.rewrite}` : ', no rewrite arm'} on ${test.length} test tasks`);
        const pair = emptyMeter();
        const arm = async (skillText: string, runs: number): Promise<TestArm> => {
          const meter = emptyMeter();
          const scored = await scoreArm({ engine, skillText, tasks: test, model, runs, meter });
          addMeter(pair, meter);
          const correct = Object.values(scored.per_task).flat().filter(x => x === 1).length;
          return { ...scored, runs, correct_rollouts: correct, cost: summarizeMeter(meter), cost_per_correct_usd: correct ? meter.usd / correct : null };
        };
        const noSkill = await arm(NO_SKILL_TEXT, TEST_RUNS.no_skill);
        const seed = await arm(seedText, TEST_RUNS.seed);
        const rewritten = rewrite ? await arm(rewrite.text, TEST_RUNS.rewrite) : null;
        const seedDiff = armDifference(seed, noSkill);
        const rewriteDiff = rewritten ? armDifference(rewritten, seed) : null;
        const result: TestPairResult = {
          ...base,
          no_skill: noSkill.score, seed: seed.score, rewrite: rewritten?.score ?? null,
          arms: { no_skill: noSkill, seed, ...(rewritten ? { rewrite: rewritten } : {}) },
          seed_minus_no_skill: seedDiff && { ...seedDiff, verdict: shippedSkillVerdict(seedDiff) },
          rewrite_minus_seed: rewriteDiff && { ...rewriteDiff, verdict: rewriteVerdict(rewriteDiff) },
          cost: summarizeMeter(pair),
        };
        results.push(result);
        o.onSkill?.(result);
        log(`[n15 probe]   no-skill ${noSkill.score ?? 'error'}, seed ${seed.score ?? 'error'}${rewritten ? `, rewrite ${rewritten.score ?? 'error'}` : ''}`);
        const mean = result.cost?.mean_rollout_usd ?? null;
        if (mean !== null && mean > REPRICE_TRIGGER_USD[o.target]) {
          trigger = { reason: 'reprice-trigger', skill, target: o.target, mean_rollout_usd: mean, threshold_usd: REPRICE_TRIGGER_USD[o.target] };
          log(`[n15 probe] reprice trigger: ${o.target} ${skill} mean rollout $${mean.toFixed(4)} is above $${trigger.threshold_usd.toFixed(2)}; the stage stops here`);
        }
      }
    });
  } finally {
    observer?.stop();
    if (!o.engine) await engine.disconnect().catch(() => {});
  }
  return {
    mode: o.fake ? 'fake' : 'live',
    stage: TEST_STAGE,
    target: o.target,
    models: { target: model, proposer: null },
    dataset: datasetName(DEFAULT_DATASET),
    runs: TEST_RUNS,
    bootstrap: TEST_BOOTSTRAP,
    models_not_run: MODELS_NOT_RUN,
    skills: results,
    reprice_trigger: trigger,
    files_read: filesRead,
    retrieval: RETRIEVAL,
    request_settings: observer ? observer.settings() : null,
  };
}
