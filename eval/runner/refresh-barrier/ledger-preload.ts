/**
 * Preloaded into Part B's B2 runner processes (`bun --preload`, retrieval.ts): joins the B2 budget-ledger run named by
 * BRAINBENCH_BUDGET_RUN_ID, as eval/runner/evidence-delivery/ledger-preload.ts does, so every embedding request is reserved
 * and capped, and appends each refusal's message to RB_LEDGER_STOPS, so retrieval.ts can tell a cap stop from a ledger
 * failure. Without BRAINBENCH_BUDGET_RUN_ID the process refuses to start.
 */
import { appendFileSync } from 'node:fs';
import { BudgetRun, budgetOptionsFrom, installPaidRequestGuard } from '../budget-ledger.ts';

const options = budgetOptionsFrom([], process.env);
if (!options.runId) throw new Error('ledger-preload: BRAINBENCH_BUDGET_RUN_ID is required so B2 spend joins its budget run');
installPaidRequestGuard(BudgetRun.join({ runId: options.runId, ledgerPath: options.ledgerPath, programCapUsd: options.programCapUsd, programCapSource: options.programCapSource }));
const guarded = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  try { return await guarded(input, init); }
  catch (error) {
    if ((error as Error)?.name === 'BudgetExceededError' && process.env.RB_LEDGER_STOPS) appendFileSync(process.env.RB_LEDGER_STOPS, `${JSON.stringify((error as Error).message)}\n`);
    throw error;
  }
}, { preconnect: guarded.preconnect?.bind(guarded) }) as typeof fetch;
