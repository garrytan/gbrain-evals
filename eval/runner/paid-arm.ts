/**
 * Paid-arm guard (eval-category wave, plan section 7).
 *
 * Every runner is hermetic by default. Work that spends money runs only when
 * the caller passes both `--paid` and `--budget-run-id <id>`, and the id names
 * an open run in the budget ledger (eval/runner/budget-ledger.ts). The wave
 * opens one such run for its $150 cap:
 *
 *   bun eval/runner/budget-ledger.ts open --runner eval-category-wave --budget-usd 150
 *
 * and every paid arm joins it, so the ledger enforces the cap across lanes,
 * retries and write-side work. Environment variables never satisfy the guard:
 * an inherited BRAINBENCH_BUDGET_RUN_ID must not turn on spending by itself.
 */
import { budgetOptionsFrom, ledgerStatus } from './budget-ledger.ts';

export const WAVE_CAP_USD = 150;
export const WAVE_RUN_COMMAND = `bun eval/runner/budget-ledger.ts open --runner eval-category-wave --budget-usd ${WAVE_CAP_USD}`;

export class PaidArmRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaidArmRefusal';
  }
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const eq = argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

/** True when the caller asked for paid work with either flag; requirePaidArm then insists on both. */
export function paidRequested(argv: readonly string[]): boolean {
  return argv.includes('--paid') || argv.some(a => a === '--budget-run-id' || a.startsWith('--budget-run-id='));
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Refuse unless argv carries `--paid` and `--budget-run-id <id>` for an open
 * ledger run with money left. Returns the run id and what is left of it.
 */
export function requirePaidArm(argv: readonly string[], options: { arm: string; estimateUsd: number | null; ledgerPath?: string }): { budgetRunId: string; remainingUsd: number } {
  // The ledger the run's own budget code will use (--budget-ledger, BRAINBENCH_BUDGET_LEDGER, else the default).
  const ledgerPath = options.ledgerPath ?? budgetOptionsFrom(argv).ledgerPath;
  const runId = flagValue(argv, '--budget-run-id');
  const estimate = options.estimateUsd === null ? 'unmeasured' : usd(options.estimateUsd);
  if (!argv.includes('--paid') || !runId) {
    const { totals, run, ledger } = ledgerStatus({ ledgerPath, runId: runId ?? null });
    const capped = totals.program_cap_usd === null || totals.remaining_usd === null
      ? `the ledger ${ledger} has no recorded program cap yet (create it with \`bun eval/runner/budget-ledger.ts init --budget-ledger ${ledger} --program-cap-usd <dollars>\`)`
      : `the ledger has ${usd(totals.remaining_usd)} left of its ${usd(totals.program_cap_usd)} program cap`;
    const left = run
      ? `run ${run.run_id} has ${usd(run.remaining_usd)} left of its ${usd(run.budget_usd)} budget`
      : `${capped}; the wave cap is ${usd(WAVE_CAP_USD)} (open its run once with \`${WAVE_RUN_COMMAND}\`)`;
    const missing = [!argv.includes('--paid') && '--paid', !runId && '--budget-run-id <id>'].filter(Boolean).join(' and ');
    throw new PaidArmRefusal(`${options.arm} spends money (estimate ${estimate}), and ${missing} ${missing.includes(' and ') ? 'are' : 'is'} missing. Pass \`--paid --budget-run-id <id>\`; ${left}.`);
  }
  const { run, ledger } = ledgerStatus({ ledgerPath, runId });
  if (!run) throw new PaidArmRefusal(`${options.arm}: budget run ${runId} is not in the ledger at ${ledger}. Open it with \`${WAVE_RUN_COMMAND}\` and pass the id it prints.`);
  if (run.finished_at !== null) throw new PaidArmRefusal(`${options.arm}: budget run ${runId} is already closed. Open a new run with \`${WAVE_RUN_COMMAND}\`.`);
  if (run.remaining_usd <= 0 || (options.estimateUsd !== null && options.estimateUsd > run.remaining_usd)) {
    throw new PaidArmRefusal(`${options.arm} spends money (estimate ${estimate}), but run ${runId} has only ${usd(run.remaining_usd)} left of its ${usd(run.budget_usd)} budget. Lower the arm's size or open a new run within the wave cap.`);
  }
  return { budgetRunId: runId, remainingUsd: run.remaining_usd };
}
