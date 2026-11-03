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
 *
 * Every rollout attempt runs with the AI SDK's own retries off
 * (`withoutSdkRetries`), so the harness is the only layer that resends a
 * request. A rollout attempt that provably produced nothing billable (it
 * finished no model turn, and its request failed with `unbilledFailure`: the
 * connection was refused before sending, or the provider rejected it with
 * HTTP 429 or 529) is retried, at most `ROLLOUT_RETRIES` times, and counted
 * in the meter. Any other failure, a 5xx that may have been forwarded or a
 * 429 after a finished turn included, is that task's error, and the arm has
 * no score. In flight per arm stays at gbrain's validation-gate
 * concurrency (4), and arms run one at a time.
 *
 * A refusal (`refusalKind`: a budget refusal from the ledger, gbrain's hook
 * cap or a metering proxy, or the proxy's tripwire or model allowlist) is
 * terminal: no later rollout of the arm calls anything, and the arm reads
 * incomplete (`budget_exhausted`) or invalid (`cell_invalid`), never a
 * score. The ledger's lock timeout is not a refusal: nothing was sent, and
 * the task errors like any other infrastructure failure.
 */
import { toolLoop } from 'gbrain/ai/gateway';
import { withAIInvocationGuard } from 'gbrain/ai/invocation-guard';
import { runRollout, scoreSkillPerTask, SKILLOPT_HOOK_BUDGET_EXHAUSTED, type BenchmarkTask } from 'gbrain/core/skillopt';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import type { MethodTask } from '../../generators/skillopt-method/common.ts';
import { BudgetExceededError, chatPrice } from '../budget-ledger.ts';
import { evaluateJudge, type CheckResult, type Judge, type ScoreFn, type Trajectory } from './score.ts';

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
  /** Rollout attempts retried after an unbilled failure; their calls are in the totals, not in `rollouts`. */
  retries: number;
}

export interface MeterSummary extends MeterTotals {
  mean_rollout_usd: number | null;
  calls_per_rollout: number | null;
  /** Cache reads over all input tokens. */
  cached_input_share: number | null;
  reasoning_tokens_per_rollout: number | null;
}

export const emptyMeter = (): MeterTotals => ({ rollouts: 0, calls: 0, usd: 0, unpriced_calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: null, retries: 0 });

/** Add one rollout's calls to a meter; a retried attempt adds its calls and a retry, not a rollout. */
export function meterRollout(m: MeterTotals, calls: readonly CallUsage[], o: { retried?: boolean } = {}): void {
  if (o.retried) m.retries++;
  else m.rollouts++;
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
  /** Each task's median of runs, as gbrain scores it; absent when the arm failed. */
  task_medians?: Record<string, number>;
  error?: string;
  /** The arm stopped at a budget refusal; read incomplete, never a score. */
  budget_exhausted?: true;
  /** A request tripped the metering proxy's tripwire or left its model allowlist; the cell is invalid. */
  cell_invalid?: true;
}

/** Retries per rollout or proposer call after an unbilled failure; the harness is the only retry layer (`withoutSdkRetries`). */
export const ROLLOUT_RETRIES = 2;
export const ROLLOUT_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000];

const REFUSED_BEFORE_SEND = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Run `run` under a pass-through gbrain invocation guard, composed with any
 * enclosing guard. gbrain sends every generation under a guard with the AI
 * SDK's `maxRetries: 0`, so no request is resent below the harness, whose
 * classifier is then the only retry layer. This guard admits every call and
 * settles nothing: the budget ledger stays at the fetch boundary.
 */
export function withoutSdkRetries<T>(run: () => Promise<T>): Promise<T> {
  return withAIInvocationGuard(async () => ({ settle: async () => {} }), run, { inherit: true });
}

type ChainLink = { message?: unknown; statusCode?: unknown; status?: unknown; code?: unknown; responseBody?: unknown; cause?: unknown; lastError?: unknown; errors?: unknown };

/** Every error in a failure's cause chain, the AI SDK's retry wrapper included. */
function causeChain(error: unknown): ChainLink[] {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  const chain: ChainLink[] = [];
  while (queue.length) {
    const e = queue.shift();
    if (!e || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    const o = e as ChainLink;
    chain.push(o);
    queue.push(o.cause, o.lastError, ...(Array.isArray(o.errors) ? o.errors : []));
  }
  return chain;
}

const httpStatus = (o: ChainLink) => (typeof o.statusCode === 'number' ? o.statusCode : typeof o.status === 'number' ? o.status : null);

/** The metering proxy's error body (`{ error: { kind, type, message } }`), from the AI SDK's `APICallError.responseBody`. */
function proxyError(o: ChainLink): { kind?: unknown; message?: unknown } | null {
  if (typeof o.responseBody !== 'string') return null;
  try {
    const body = JSON.parse(o.responseBody) as { error?: { kind?: unknown; message?: unknown } } | null;
    return body && typeof body.error === 'object' ? body.error : null;
  } catch {
    return null;
  }
}

/** The ledger's lock timeout: nothing was reserved or sent, so it is an infrastructure error, not a budget refusal. */
const LEDGER_LOCKED = 'stayed locked';

/**
 * Why a failure must stop the arm, walking its cause chain: `budget` for the
 * ledger's `BudgetExceededError` (except its lock timeout, an infrastructure
 * error), gbrain's `SKILLOPT_HOOK_BUDGET_EXHAUSTED` tag, or a metering proxy
 * refusal whose body is `error.kind: 'budget'` (402 over the cap, 503 without
 * a key); `invalid-cell` for the proxy's 403 tripwire and its 403 for a model
 * off the cell's allowlist. Null for anything else.
 */
export function refusalKind(error: unknown): 'budget' | 'invalid-cell' | null {
  for (const o of causeChain(error)) {
    const status = httpStatus(o);
    const body = proxyError(o);
    if ((o instanceof BudgetExceededError && !o.message.includes(LEDGER_LOCKED)) || (typeof o.message === 'string' && o.message.includes(SKILLOPT_HOOK_BUDGET_EXHAUSTED))) return 'budget';
    if (status === 403 && typeof body?.message === 'string' && (body.message.includes('tripwire:') || body.message.includes('model allowlist'))) return 'invalid-cell';
    if ((status === 402 || status === 503) && body?.kind === 'budget') return 'budget';
  }
  return null;
}

/**
 * True when a rollout failure provably produced no billable completion: the
 * connection was refused before sending, or the provider rejected the request
 * with 429 (rate limit) or 529 (overloaded). A 5xx is not proof, since a
 * gateway can fail after forwarding. Walks the error's cause chain and the AI
 * SDK's retry wrapper. A refusal (`refusalKind`) is never retried.
 */
export function unbilledFailure(error: unknown): boolean {
  if (refusalKind(error)) return false;
  return causeChain(error).some(o => {
    const status = httpStatus(o);
    return status === 429 || status === 529 || (typeof o.code === 'string' && REFUSED_BEFORE_SEND.has(o.code));
  });
}

/** What an arm reads of a task: its id, the prompt it sends and its judge. */
export type ArmTask = Pick<MethodTask, 'task_id' | 'task' | 'judge'>;

export interface ArmOptions {
  engine: PGLiteEngine;
  skillText: string;
  tasks: readonly ArmTask[];
  model: string;
  runs: number;
  meter?: MeterTotals;
  /** How a rollout's answer is judged (default `evaluateJudge`: every check); v3 passes substance pass. */
  evaluate?: (text: string, judge: Judge) => CheckResult;
  /** Called with every scored rollout and the model calls it made. */
  onRollout?: (trajectory: Trajectory, result: CheckResult, calls: readonly CallUsage[]) => void;
  /** Delays before each retry (tests pass zeros). */
  retryDelaysMs?: readonly number[];
  /** Called before each retry. */
  onRetry?: (taskId: string, attempt: number, error: unknown) => void;
  /** Called with each task whose rollouts errored, and its first error, when the arm fails on them. */
  onTaskError?: (taskId: string, error: string) => void;
  /** Called with the model calls a failed rollout attempt made before it failed (only when it made any), so their spend is not lost with the rollout. */
  onFailedRollout?: (taskId: string, calls: readonly CallUsage[]) => void;
}

const benchTask = (t: ArmTask): BenchmarkTask => ({ task_id: t.task_id, task: t.task, judge: t.judge });

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An `onRetry` that logs each retried rollout or proposer call. */
export const logRetries = (log: (line: string) => void) => (id: string, attempt: number, error: unknown) =>
  log(`[n15 probe]   retry ${attempt} of ${id} after an unbilled failure: ${errMsg(error)}`);

/**
 * Score a skill text on tasks. A failed arm, or one where any task's rollout
 * errored (gbrain scores such a task 0), is returned as `error` with a null
 * score, so a provider failure never reads as a wrong answer. A refusal
 * (`refusalKind`) is terminal: every later rollout attempt rethrows it before
 * calling anything, and the arm returns `budget_exhausted` or `cell_invalid`
 * with a null score.
 */
export async function scoreArm(o: ArmOptions): Promise<ArmScore> {
  const per_task: Record<string, number[]> = {};
  const callsOf = new WeakMap<Trajectory, CallUsage[]>();
  const scoreFn: ScoreFn = async (trajectory, judge) => {
    const result = (o.evaluate ?? evaluateJudge)(trajectory.final_text, judge);
    (per_task[trajectory.task_id] ??= []).push(result.correct ? 1 : 0);
    o.onRollout?.(trajectory, result, callsOf.get(trajectory) ?? []);
    return { trajectory, score: result.correct ? 1 : 0 };
  };
  const meter = o.meter;
  const delays = o.retryDelaysMs ?? ROLLOUT_RETRY_DELAYS_MS;
  let refusal: { kind: 'budget' | 'invalid-cell'; error: unknown } | undefined;
  const rolloutFn: typeof runRollout = async opts => {
    for (let attempt = 0; ; attempt++) {
      if (refusal) throw refusal.error;
      const calls: CallUsage[] = [];
      const metered: typeof toolLoop = loop => toolLoop({
        ...loop,
        onAssistantTurn: async (turn, idx, blocks, usage, model) => {
          calls.push({ model, ...usage });
          await loop.onAssistantTurn?.(turn, idx, blocks, usage, model);
        },
      });
      let retry = false;
      try {
        const trajectory = await withoutSdkRetries(() => runRollout({ ...opts, toolLoopFn: metered }));
        callsOf.set(trajectory, calls);
        return trajectory;
      } catch (error) {
        const kind = refusalKind(error);
        if (kind) refusal ??= { kind, error };
        if (calls.length) o.onFailedRollout?.(opts.task.task_id, calls);
        retry = attempt < ROLLOUT_RETRIES && calls.length === 0 && unbilledFailure(error);
        if (!retry) throw error;
        o.onRetry?.(opts.task.task_id, attempt + 1, error);
      } finally {
        if (meter) meterRollout(meter, calls, { retried: retry });
      }
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      if (delay) await new Promise(r => setTimeout(r, delay));
    }
  };
  const refused = (r: { kind: 'budget' | 'invalid-cell'; error: unknown }): ArmScore => r.kind === 'budget'
    ? { score: null, per_task, error: `budget refusal: ${errMsg(r.error)}`, budget_exhausted: true }
    : { score: null, per_task, error: `invalid cell: ${errMsg(r.error)}`, cell_invalid: true };
  try {
    const { score, perTask } = await scoreSkillPerTask({
      engine: o.engine, skillText: o.skillText, tasks: o.tasks.map(benchTask), targetModel: o.model, judgeModel: o.model,
      runsPerTask: o.runs, scoreFn, rolloutFn,
    });
    if (refusal) return refused(refusal);
    const errored = perTask.filter(t => t.error !== undefined);
    if (errored.length) {
      for (const t of errored) o.onTaskError?.(t.task_id, String(t.error));
      return { score: null, per_task, error: `${errored.length} of ${perTask.length} tasks errored (${errored.map(t => t.task_id).join(', ')}); first error: ${errored[0]!.error}` };
    }
    return { score, per_task, task_medians: Object.fromEntries(perTask.map(t => [t.task_id, t.median])) };
  } catch (e) {
    const kind = refusalKind(e);
    if (refusal || kind) return refused(refusal ?? { kind: kind!, error: e });
    return { score: null, per_task, error: errMsg(e) };
  }
}
