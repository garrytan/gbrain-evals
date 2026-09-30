/**
 * Preloaded into gbrain server subprocesses (`bun --preload`) so their paid
 * requests (query embeddings, reranks) join the campaign's budget-ledger run.
 * Requires BRAINBENCH_BUDGET_RUN_ID; without it the process refuses to start.
 */
import { BudgetRun, budgetOptionsFrom, installPaidRequestGuard } from '../budget-ledger.ts';

const options = budgetOptionsFrom([], process.env);
if (!options.runId) throw new Error('ledger-preload: BRAINBENCH_BUDGET_RUN_ID is required so subprocess spend joins the campaign run');
installPaidRequestGuard(BudgetRun.join({ runId: options.runId, ledgerPath: options.ledgerPath, programCapUsd: options.programCapUsd }));
