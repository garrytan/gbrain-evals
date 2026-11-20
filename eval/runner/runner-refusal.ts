/**
 * Stable runner refusals (the entity-dedupe head-to-head preregistration, "Runner refusals"): a refusal exits
 * non-zero with a stable code, the counts involved and one fix line, so an operator or an agent reading the
 * output knows what to do without reading code.
 *
 *   WORLD_DIR_USED       the folder a run would write was used before: pass a fresh --output
 *   IMPORT_INCOMPLETE    the system did not take in every page: pages expected and imported
 *   LEDGER_UNRECONCILED  the ledger does not match the metering proxy's usage log: run the reconcile first
 *   SCHEMA_PACK_INACTIVE gbrain did not activate the schema pack that declares the person id field: check the build
 *   STACK_CONFIG_MISMATCH a memory system's stack reports another setting than its cell records: start it from the cell
 *   TUNING_SEED          a tuning cell off the held-out seed at 5 per family, or a tuned cell on it: use the right world
 *   TUNING_CHOICE        a tuned cell without a usable choice record from default's and every grid setting's slice run
 *   TUNED_IS_DEFAULT     a tuned cell whose system has no documented dedupe setting, or whose rule chose default: it is
 *                        the default cell (preregistration Amendment 2), so nothing runs
 *
 * Every refusal prints one line, "REFUSED <CODE>: <message> (<counts>). Fix: <fix>", to stderr and exits
 * REFUSAL_EXIT. No score is written after a refusal.
 */

export const REFUSAL_CODES = ['WORLD_DIR_USED', 'IMPORT_INCOMPLETE', 'LEDGER_UNRECONCILED', 'SCHEMA_PACK_INACTIVE', 'STACK_CONFIG_MISMATCH', 'TUNING_SEED', 'TUNING_CHOICE', 'TUNED_IS_DEFAULT'] as const;
export type RefusalCode = typeof REFUSAL_CODES[number];

/** The exit status of every refusal; 1 stays a failed verdict and 3 an unexpected error. */
export const REFUSAL_EXIT = 2;

export class RunnerRefusal extends Error {
  constructor(readonly code: RefusalCode, readonly detail: string, readonly counts: Record<string, number>, readonly fix: string) {
    super(`REFUSED ${code}: ${detail} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}). Fix: ${fix}`);
    this.name = 'RunnerRefusal';
  }
}

/** Prints a refusal and exits REFUSAL_EXIT; anything else is rethrown for the caller's own handler. */
export function exitOnRefusal(e: unknown): never {
  if (e instanceof RunnerRefusal) {
    console.error(e.message);
    process.exit(REFUSAL_EXIT);
  }
  throw e;
}
