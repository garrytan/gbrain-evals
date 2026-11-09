/**
 * The records of the failure-cause library. EvalFailure is one eval row
 * normalized by a source adapter; CauseLabel is what the classifier or the
 * residual labeller says caused it; StressCount is a call-level or aggregate
 * count from a source that forces a cause or measures only one stage.
 *
 * Evidence fields are tri-state: null means the source did not measure the
 * field, and a value (including 'none' or []) means it did. A rule never fires
 * on a null field; the stage is listed as unmeasured instead.
 */
import type { Cause, Stage, Tag } from './taxonomy.ts';

export const FAILURE_CAUSE_SCHEMA = 'failure-cause/1';
export const EVAL_FAILURE_SCHEMA = 'eval-failure/1';

export type ArmRole = 'gbrain_default' | 'gbrain_variant' | 'other_system' | 'control' | 'oracle';
/** natural: the run did not force a cause; forced: the design forces one (a fault-injection or stress probe). */
export type Condition = 'natural' | 'forced';
export type Visibility = 'public' | 'synthetic' | 'private' | 'sealed';
/** How much of the gold a stage covered. */
export type Coverage = 'none' | 'partial' | 'all';

export interface ToolCall {
  name: string;
  /** Error or refusal code and message; null when the call succeeded. */
  error: string | null;
  /** true when the agent recovered from this error before the failure; null when unknown. */
  recovered: boolean | null;
  ms: number | null;
  /** A memory read or write against the system under test. */
  memory: boolean;
}

export interface GoldExposure {
  /** Number of gold items the question needs; 0 for abstention questions; null when unknown. */
  gold_count: number | null;
  stored: Coverage | null;
  hidden: Coverage | null;
  retrieved: Coverage | null;
  delivered: Coverage | null;
  opened: Coverage | null;
  /** true when the delivered gold reached the model only as a summary or a cut page. */
  summary_only: boolean | null;
}

export interface WriteRecord {
  lost: string[] | null;
  stuck: string[] | null;
  overwritten: string[] | null;
  duplicated: string[] | null;
}

/** Text the residual labeller reads. Only public and synthetic sources carry it, and labels never store it. */
export interface FailureText {
  question: string;
  expected: string | null;
  answer: string;
  context: string | null;
}

export interface EvalFailure {
  schema: typeof EVAL_FAILURE_SCHEMA;
  source: string;
  run_id: string;
  case_id: string;
  /** The task or question this row answers, the same for every arm and system that ran it, so the report can compare them. */
  task_id?: string;
  system: string;
  arm: string;
  arm_role: ArmRole;
  condition: Condition;
  visibility: Visibility;
  /** provider:model of the system's reader or agent. */
  model: string;
  gbrain_sha: string | null;
  failed: boolean;
  /**
   * Why the system never ran this task (an outcome such as does_not_fit or budget_not_run). Such a row is neither passed
   * nor failed: it only tells the report's same-task comparison that the system did not run the task.
   */
  not_run?: string;
  /** The row's score on the source's own scale, when it has one. */
  score: number | null;
  /** Task category or family, a hint for the labeller. */
  category: string | null;
  /** true for agent-loop records, where the consult and open stages apply. */
  agent_loop: boolean;
  stop: string | null;
  finish_reason: string | null;
  harness: { error: string | null; scorer_artifact: string | null } | null;
  operation: { step: string; error: string } | null;
  tool_calls: ToolCall[] | null;
  gold: GoldExposure;
  writes: WriteRecord | null;
  tags: Tag[];
  /** Archive-relative pointers: <root>:<path>#<sha8>, optionally followed by a locator. */
  evidence: string[];
  text?: FailureText;
}

export type LabelBasis = 'deterministic' | 'model' | 'needs_model' | 'unclassified';

export interface LabellerInfo {
  model: string;
  effort: string;
  /** The labeller path: which labeller labels which row family. */
  path: string;
  prompt_sha256: string;
  cached: boolean;
  reason: string | null;
}

export interface CauseLabel {
  schema: typeof FAILURE_CAUSE_SCHEMA;
  taxonomy_version: string;
  source: string;
  run_id: string;
  case_id: string;
  task_id: string | null;
  system: string;
  arm: string;
  arm_role: ArmRole;
  condition: Condition;
  visibility: Visibility;
  model: string;
  gbrain_sha: string | null;
  category: string | null;
  /** null while basis is needs_model. */
  cause: Cause | 'unclassified' | null;
  basis: LabelBasis;
  rule_id: string;
  secondary: Cause[];
  tags: Tag[];
  unmeasured: Stage[];
  evidence: string[];
  labeller: LabellerInfo | null;
}

export interface StressCount {
  source: string;
  run_id: string;
  system: string;
  model: string;
  gbrain_sha: string | null;
  condition: Condition;
  visibility: Visibility;
  cause: Cause;
  unit: 'calls' | 'episodes' | 'questions';
  count: number;
  of: number;
  detail: string;
  evidence: string[];
}

/** What an adapter read: every row it saw is read, mapped, a duplicate of an earlier row, or skipped with a reason. */
export interface SourceCounts {
  read: number;
  mapped: number;
  duplicate: number;
  skipped: number;
  failed: number;
  skipped_reasons: Record<string, number>;
}
