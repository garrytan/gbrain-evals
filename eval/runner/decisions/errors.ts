/**
 * The decision kit's status and error contract.
 *
 * Every refusal, failure and partial result is an operator message in the
 * same shape gbrain uses for its agent operator protocol: a stable `code`,
 * what happened (`message`), why (`why`), and a `fix` whose `next` says who
 * acts (`run` a command, `ask_user`, `tell_user_to_run`, `wait`, `report`),
 * with the exact argv and a read-only `verify` command. The kit's operator is
 * usually an AI agent implementing a feature plan, so every message names the
 * next action instead of only describing the failure.
 */

export type FixNext = 'run' | 'ask_user' | 'tell_user_to_run' | 'wait' | 'report';

export interface OperatorFix {
  next: FixNext;
  /** Exact command for `run` / `tell_user_to_run`. */
  argv?: string[];
  /** What to tell the user for `ask_user` / `tell_user_to_run`. */
  user_message?: string;
  /** Read-only command that confirms the fix worked. */
  verify?: string[];
}

export type DecideCode =
  | 'SPEC_INVALID'
  | 'SPEC_MISSING'
  | 'DATASET_MISSING'
  | 'DATASET_HASH_MISMATCH'
  | 'PAID_FLAGS_MISSING'
  | 'BUDGET_CAP'
  | 'OVERLAY_FAILED'
  | 'ARM_FAILED'
  | 'ROWS_MISSING'
  | 'FIDELITY_FALLBACK'
  | 'SEALED_SOURCE_IN_DEV'
  | 'NOT_YET_AVAILABLE'
  | 'CUSTODY_MISSING'
  | 'PREREG_UNCOMMITTED'
  | 'UNDERPOWERED'
  | 'SOURCE_EXHAUSTED';

export interface OperatorMessage {
  code: DecideCode;
  message: string;
  why: string;
  fix: OperatorFix;
  /** Where the evidence for this message lives, when there is any. */
  artifact?: string;
  /** Spend and exposure state at the time of the message. */
  state?: Record<string, unknown>;
}

export class DecideError extends Error {
  constructor(readonly op: OperatorMessage) {
    super(`${op.code}: ${op.message}`);
    this.name = 'DecideError';
  }
}

export function decideError(op: OperatorMessage): DecideError {
  return new DecideError(op);
}

/** Human-readable rendering; `--json` callers get the object itself. */
export function renderOperatorMessage(op: OperatorMessage): string {
  const lines = [`[${op.code}] ${op.message}`, `  why: ${op.why}`];
  if (op.fix.next === 'run' && op.fix.argv) lines.push(`  next: run \`${op.fix.argv.join(' ')}\``);
  else if (op.fix.next === 'tell_user_to_run' && op.fix.argv) lines.push(`  next: ask the user to run \`${op.fix.argv.join(' ')}\`${op.fix.user_message ? ` (${op.fix.user_message})` : ''}`);
  else if (op.fix.next === 'ask_user') lines.push(`  next: ask the user: ${op.fix.user_message ?? '(no message)'} — stop until they answer`);
  else lines.push(`  next: ${op.fix.next}${op.fix.user_message ? ` — ${op.fix.user_message}` : ''}`);
  if (op.fix.verify) lines.push(`  verify: \`${op.fix.verify.join(' ')}\``);
  if (op.artifact) lines.push(`  artifact: ${op.artifact}`);
  if (op.state && Object.keys(op.state).length) lines.push(`  state: ${JSON.stringify(op.state)}`);
  return lines.join('\n');
}

/** Exit codes follow gbrain's operator protocol: 3 means stop and ask the user. */
export function exitCodeFor(op: OperatorMessage): number {
  return op.fix.next === 'ask_user' || op.fix.next === 'tell_user_to_run' ? 3 : 2;
}
