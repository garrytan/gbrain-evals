/**
 * One row per (suite, item, reader, ref, sha, trial) of a nightly run, appended to `<night dir>/outcomes.jsonl` as each
 * finishes, so `run.ts --resume` continues where a stopped run left off and the report reads one shape for every suite.
 *
 * `harness` marks a row that measured the harness or a provider, not gbrain (a provider error, a crashed child, a
 * placeholder result). The report counts those rows apart and never as a gbrain failure.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

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
