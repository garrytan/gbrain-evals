/**
 * Scored, metered rollouts for the SkillOpt method benchmark (GST-799): the
 * one arm runner the A1 probe and the harness one-shot share.
 *
 * `scoreArm` scores a skill text on tasks through gbrain's `scoreSkillPerTask`
 * with the counted scorer in its `scoreFn` seam (median of runs per task, mean
 * over tasks), and keeps each task's median for paired comparisons. Through
 * the `rolloutFn` seam it also meters every rollout: each model call's usage,
 * read from the tool loop's `onAssistantTurn`, is priced at the budget
 * ledger's list prices (`chatPrice`, the rates the ledger settles at). The
 * ledger stays the record of spend; the meter gives the per-pair figures a
 * receipt reports and the reprice trigger reads: mean cost per rollout, model
 * calls per rollout, the cached share of input tokens and reasoning tokens.
 *
 * Usage follows gbrain's `ChatResult.usage`: `input_tokens` is the whole
 * prompt and the cache read and write counts are parts of it.
 */
import { toolLoop } from 'gbrain/ai/gateway';
import { runRollout, scoreSkillPerTask, type BenchmarkTask } from 'gbrain/core/skillopt';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import type { MethodTask } from '../../generators/skillopt-method/common.ts';
import { chatPrice } from '../budget-ledger.ts';
import { evaluateJudge, type CheckResult, type ScoreFn, type Trajectory } from './score.ts';

/** One model call's usage, as gbrain's gateway reports it. */
export interface CallUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens?: number;
}

/** USD for one call at the ledger's list prices, long-prompt rates included; null when the ledger has no price for the model. */
export function callCostUsd(u: CallUsage): number | null {
  const price = chatPrice(u.model);
  if (!price) return null;
  const rates = price.long && u.input_tokens > price.long.above_input_tokens ? price.long : price;
  const uncached = Math.max(0, u.input_tokens - u.cache_read_tokens - u.cache_creation_tokens);
  return (uncached * rates.input + u.cache_read_tokens * (rates.cache_read ?? rates.input)
    + u.cache_creation_tokens * (rates.cache_write ?? rates.input) + u.output_tokens * rates.output) / 1e6;
}

export interface MeterTotals {
  rollouts: number;
  calls: number;
  usd: number;
  /** Calls the ledger has no price for; their cost is not in `usd`. */
  unpriced_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Null when no call reported reasoning tokens (Anthropic bills thinking as output without a separate count). */
  reasoning_tokens: number | null;
}

export interface MeterSummary extends MeterTotals {
  mean_rollout_usd: number | null;
  calls_per_rollout: number | null;
  /** Cache reads over all input tokens. */
  cached_input_share: number | null;
  reasoning_tokens_per_rollout: number | null;
}

export const emptyMeter = (): MeterTotals => ({ rollouts: 0, calls: 0, usd: 0, unpriced_calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: null });

/** Add one rollout's calls to a meter. */
export function meterRollout(m: MeterTotals, calls: readonly CallUsage[]): void {
  m.rollouts++;
  for (const c of calls) {
    m.calls++;
    const usd = callCostUsd(c);
    if (usd === null) m.unpriced_calls++;
    else m.usd += usd;
    m.input_tokens += c.input_tokens;
    m.output_tokens += c.output_tokens;
    m.cache_read_tokens += c.cache_read_tokens;
    m.cache_creation_tokens += c.cache_creation_tokens;
    if (typeof c.reasoning_tokens === 'number') m.reasoning_tokens = (m.reasoning_tokens ?? 0) + c.reasoning_tokens;
  }
}

export function summarizeMeter(m: MeterTotals): MeterSummary {
  const per = (n: number) => (m.rollouts ? n / m.rollouts : null);
  return {
    ...m,
    mean_rollout_usd: per(m.usd),
    calls_per_rollout: per(m.calls),
    cached_input_share: m.input_tokens ? m.cache_read_tokens / m.input_tokens : null,
    reasoning_tokens_per_rollout: m.reasoning_tokens === null ? null : per(m.reasoning_tokens),
  };
}

export interface ArmScore {
  score: number | null;
  per_task: Record<string, number[]>;
  /** Each task's median of runs, as gbrain scores it (a task whose rollout errored counts 0); absent when the arm failed. */
  task_medians?: Record<string, number>;
  error?: string;
}

export interface ArmOptions {
  engine: PGLiteEngine;
  skillText: string;
  tasks: readonly MethodTask[];
  model: string;
  runs: number;
  meter?: MeterTotals;
  /** Called with every scored rollout. */
  onRollout?: (trajectory: Trajectory, result: CheckResult) => void;
}

const benchTask = (t: MethodTask): BenchmarkTask => ({ task_id: t.task_id, task: t.task, judge: t.judge });

/** Score a skill text on tasks; a failure of the whole arm is returned as `error` with a null score. */
export async function scoreArm(o: ArmOptions): Promise<ArmScore> {
  const per_task: Record<string, number[]> = {};
  const scoreFn: ScoreFn = async (trajectory, judge) => {
    const result = evaluateJudge(trajectory.final_text, judge);
    (per_task[trajectory.task_id] ??= []).push(result.correct ? 1 : 0);
    o.onRollout?.(trajectory, result);
    return { trajectory, score: result.correct ? 1 : 0 };
  };
  const meter = o.meter;
  const rolloutFn: typeof runRollout | undefined = meter && (async opts => {
    const calls: CallUsage[] = [];
    const metered: typeof toolLoop = loop => toolLoop({
      ...loop,
      onAssistantTurn: async (turn, idx, blocks, usage, model) => {
        calls.push({ model, ...usage });
        await loop.onAssistantTurn?.(turn, idx, blocks, usage, model);
      },
    });
    try {
      return await runRollout({ ...opts, toolLoopFn: metered });
    } finally {
      meterRollout(meter, calls);
    }
  });
  try {
    const { score, perTask } = await scoreSkillPerTask({
      engine: o.engine, skillText: o.skillText, tasks: o.tasks.map(benchTask), targetModel: o.model, judgeModel: o.model,
      runsPerTask: o.runs, scoreFn, ...(rolloutFn ? { rolloutFn } : {}),
    });
    return { score, per_task, task_medians: Object.fromEntries(perTask.map(t => [t.task_id, t.median])) };
  } catch (e) {
    return { score: null, per_task, error: e instanceof Error ? e.message : String(e) };
  }
}
