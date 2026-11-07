/**
 * Budget-ledger helpers for the refresh-barrier validation's paid parts, Part B's B2 and Part C
 * (docs/benchmarks/2026-11-06-refresh-barrier-preregistration.md, "Budget"). Each Budget-table item is its own ledger run
 * (eval/runner/budget-ledger.ts), opened by the first invocation and joined by later ones on the same ledger. A cap stop
 * finishes the item's run, so nothing reruns: openBudgetItem refuses a finished run.
 */
import { readLedger, startPaidRun, type BudgetOptions } from '../budget-ledger.ts';

export interface BudgetItem { runner: string; cap_usd: number }

/** Opens the item's ledger run with its cap, or joins it when an earlier invocation opened it, and installs the paid-request guard. */
export function openBudgetItem(item: BudgetItem, options: BudgetOptions) {
  const runs = readLedger(options.ledgerPath).runs.filter(r => r.runner === item.runner);
  const open = runs.find(r => r.finished_at === null);
  if (runs.length && !open) throw new Error(`budget run ${item.runner} is finished in ${options.ledgerPath}; a cap stop ends that part INCOMPLETE and is never retried`);
  return startPaidRun(item.runner, { ...options, budgetUsd: item.cap_usd, runId: open?.run_id ?? null, estimateUsd: null });
}

const CAP_STOP = /over its \$[\d.]+ (budget|cap)\b|budget run \S+ already finished|^budget: (Particle credit exhausted|the metering proxy refused)/;

/**
 * Whether a refusal (a BudgetExceededError, or its message) is a cap stop: a reservation over the item's budget or the
 * program cap, a run a cap stop already finished, or a provider's budget stop (Particle's empty balance, the metering
 * proxy's budget refusal). A ledger lock timeout, a failed ledger write, a host the ledger cannot price or a cleartext
 * host is a ledger failure, not a cap stop.
 */
export function isCapStop(error: unknown): boolean {
  const message = typeof error === 'string' ? error : error instanceof Error && error.name === 'BudgetExceededError' ? error.message : null;
  return message !== null && CAP_STOP.test(message);
}
