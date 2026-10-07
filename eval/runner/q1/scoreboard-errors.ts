/**
 * Operator messages for the scoreboard front door (eval/runner/scoreboard-cli.ts),
 * the Q1 campaign (eval/runner/shootout-cell.ts) and the cost and speed report.
 *
 * Same shape and exit codes as the decision kit (eval/runner/decisions/errors.ts):
 * a stable `code`, what happened, why, and a `fix` whose `next` names who acts,
 * with the exact argv and a read-only `verify` command. Exit 2 is a refusal,
 * 3 means stop and ask the user, 4 means a partial result (some cells ran, or
 * the spend cap stopped the run). The operator is usually an AI agent, so every
 * message says what to do next.
 */
import { exitCodeFor, renderOperatorMessage, type DecideCode, type OperatorMessage } from '../decisions/errors.ts';

export type ScoreboardCode =
  | 'USAGE'
  | 'NOT_YET_AVAILABLE'
  | 'DELEGATE_FAILED'
  | 'CAMPAIGN_INVALID'
  | 'CAMPAIGN_HASH_MISMATCH'
  | 'CAMPAIGN_STATE_MISSING'
  | 'LEASE_STATE'
  | 'LEASE_ABANDONED'
  | 'BUDGET_CAP'
  | 'CELL_FAILED'
  | 'CELL_TIMEOUT'
  | 'RUNNER_UNRESOLVED'
  | 'OWNER_UNSET'
  | 'CUSTODY_REQUIRED'
  | 'SEALED_CELL_LOCAL'
  | 'PREFLIGHT_FAILED'
  | 'MODEL_UNPRICED'
  | 'KEY_MISSING'
  | 'DOCKER_MISSING'
  | 'FIXTURE_FAILED'
  | 'RESUME_REFUSED'
  | 'INPUT_MISSING';

export interface ScoreboardMessage extends Omit<OperatorMessage, 'code'> {
  code: ScoreboardCode;
  /** A partial result (exit 4): some work finished and is kept, the rest did not run. */
  partial?: boolean;
}

export class ScoreboardError extends Error {
  constructor(readonly op: ScoreboardMessage) {
    super(`${op.code}: ${op.message}`);
    this.name = 'ScoreboardError';
  }
}

export const refuse = (op: ScoreboardMessage) => new ScoreboardError(op);

/** The decision kit's renderer reads `code` only as text, so the scoreboard's codes render the same way. */
export const renderMessage = (op: ScoreboardMessage) => renderOperatorMessage({ ...op, code: op.code as unknown as DecideCode });

export const exitCodeOf = (op: ScoreboardMessage) => op.partial ? 4 : exitCodeFor({ ...op, code: op.code as unknown as DecideCode });
