/**
 * One row per (suite, item, reader, ref, sha, trial) of a nightly run, appended to `<night dir>/outcomes.jsonl` as each
 * finishes, so `run.ts --resume` continues where a stopped run left off and the report reads one shape for every suite.
 *
 * `harness` marks a row that measured the harness or a provider, not gbrain (a provider error, a crashed child, a
 * placeholder result). The report counts those rows apart and never as a gbrain failure. `skipped` marks an item the night
 * scheduled and did not run, with the reason; it is neither a pass, a failure nor a harness row.
 *
 * The fields after `harness` are what eval/runner/failure-causes/adapters/nightly.ts reads into an EvalFailure. The suite's
 * facts (system, arm, arm_role, condition, visibility, agent_loop) are on every row; a measured field the suite does not
 * measure is absent or null, never a guess, so classify lists that stage as unmeasured.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { ArmRole, Condition, Coverage, ToolCall, Visibility, WriteRecord } from '../failure-causes/types.ts';

export const OUTCOME_SCHEMA = 'nightly-outcome/1';

export interface ToolError {
  tool: string;
  /** gbrain's error code (invalid_params, worktree_refreshing, ...) or null when the answer named none. */
  code: string | null;
  /** True for an error gbrain returned to a call the model could make; false for a crash, timeout or server error. */
  refused: boolean;
  message?: string;
}

export interface Outcome {
  schema: typeof OUTCOME_SCHEMA;
  night: string;
  suite: string;
  suite_digest: string;
  item: string;
  role: 'headroom' | 'canary';
  /** The model under test, or null for a keyless suite. */
  reader: string | null;
  ref: string;
  sha: string;
  /** 1-based. */
  trial: number;
  pass: boolean;
  score: number | null;
  cost_usd: number | null;
  /** How the item ended (submitted, turn_cap, error, harness_error, refused, ...), as the suite's runner records it. */
  stop: string | null;
  tool_errors: ToolError[];
  /** The evidence fields the suite's runner records: gold evidence read, landed writes, recall, failure classes. */
  evidence: Record<string, unknown>;
  harness: { error: string } | null;
  system: string;
  /** `<suite>@<ref>`. */
  arm: string;
  arm_role: ArmRole;
  condition: Condition;
  visibility: Visibility;
  agent_loop: boolean;
  /** The task family or question category. */
  category?: string | null;
  /** Gold items the task needs; 0 for an abstention question. */
  gold_count?: number | null;
  /** How much of the gold any retrieval result held (QA: at 10 when recorded, else at 5). */
  retrieved?: Coverage | null;
  /** How much of the gold the reader received after packing. */
  delivered?: Coverage | null;
  /** Agent suites: how much of the gold the agent read, from evidence_cited and missed_evidence. */
  opened?: Coverage | null;
  /** Agent suites: gold ids named in any tool result. */
  searched_gold?: string[] | null;
  /** Every tool call; null when the suite does not record them call by call. */
  calls?: ToolCall[] | null;
  writes?: WriteRecord | null;
  /** System smokes: the operation that failed (the smoke) and its code. */
  operation?: { step: string; error: string } | null;
  /** False when there is nothing to judge: no submission, an empty answer, no report. */
  answered?: boolean | null;
  /** The reader's finish reason, when recorded. */
  finish_reason?: string | null;
  question?: string | null;
  expected?: string | null;
  answer?: string | null;
  context?: string | null;
  skipped?: string;
}

/** A dev-set reader as provider:model. */
export function qualifiedModel(reader: string): string {
  if (reader.includes(':')) return reader;
  if (reader.startsWith('claude-')) return `anthropic:${reader}`;
  if (reader.startsWith('gpt-') || /^o\d/.test(reader)) return `openai:${reader}`;
  if (reader.startsWith('particle-')) return `particle:${reader}`;
  throw new Error(`no provider for reader ${reader}`);
}

export const outcomeKey = (o: Pick<Outcome, 'suite' | 'item' | 'reader' | 'trial'>) => `${o.suite}\u0000${o.item}\u0000${o.reader ?? ''}\u0000${o.trial}`;

export function appendOutcome(path: string, o: Outcome): void {
  appendFileSync(path, JSON.stringify(o) + '\n');
}

/** Rows from outcomes.jsonl, else outcomes.jsonl.gz; the last row per key wins, so a rerun row replaces an earlier one. */
export function readOutcomes(path: string): Outcome[] {
  const plain = path.endsWith('.gz') ? path.slice(0, -3) : path;
  const gz = `${plain}.gz`;
  const text = existsSync(plain) ? readFileSync(plain, 'utf8') : existsSync(gz) ? gunzipSync(readFileSync(gz)).toString('utf8') : '';
  const rows = new Map<string, Outcome>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as Outcome;
    rows.set(outcomeKey(o), o);
  }
  return [...rows.values()];
}
