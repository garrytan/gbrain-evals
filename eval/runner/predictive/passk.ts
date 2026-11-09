/**
 * pass^k for agent tasks: the chance that k independent trials of a task all
 * succeed, estimated without bias from n >= k trials with c successes as
 * C(c, k) / C(n, k), then averaged over tasks.
 */

export interface TaskTrials {
  task_id: string;
  successes: number;
  trials: number;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 1; i <= k; i += 1) out = (out * (n - k + i)) / i;
  return out;
}

export function taskPassHatK(successes: number, trials: number, k: number): number {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || !Number.isInteger(k)) throw new Error('pass^k takes integer counts');
  if (k < 1) throw new Error('pass^k needs k >= 1');
  if (trials < k) throw new Error(`pass^k needs at least k=${k} trials, got ${trials}`);
  if (successes < 0 || successes > trials) throw new Error(`successes ${successes} outside 0..${trials}`);
  return choose(successes, k) / choose(trials, k);
}

export function passHatK(tasks: TaskTrials[], k: number): number {
  if (tasks.length === 0) throw new Error('pass^k needs at least one task');
  let sum = 0;
  for (const task of tasks) sum += taskPassHatK(task.successes, task.trials, k);
  return sum / tasks.length;
}

/** pass^1 through pass^kMax, the curve every agent scorecard reports. */
export function passHatCurve(tasks: TaskTrials[], kMax: number): number[] {
  return Array.from({ length: kMax }, (_, i) => passHatK(tasks, i + 1));
}

export function costPerCorrect(totalUsd: number, correct: number): number | null {
  if (!Number.isFinite(totalUsd) || totalUsd < 0) throw new Error('cost must be a finite non-negative number');
  return correct > 0 ? totalUsd / correct : null;
}
