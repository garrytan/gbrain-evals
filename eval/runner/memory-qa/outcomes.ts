/**
 * Canonical outcomes for memory-qa (plan contract 7; engineering reviews A1
 * and Astra 4).
 *
 *   manifest.json    the frozen list of expected question ids for this
 *                    output directory, written before the first attempt; a
 *                    resume whose selection differs is refused;
 *   attempts.ndjson  append-only history, one line per attempt;
 *   rows.ndjson      exactly one canonical row per expected id that has an
 *                    attempt, in manifest order, rewritten from the attempts
 *                    (the latest attempt wins, so a successful retry replaces
 *                    a failure instead of adding a row);
 *   outcomes.ndjson  the terminal outcome and attempt count per expected id.
 *
 * Outcomes: `scored`; product failures that stay in the denominator as misses
 * (`retrieval_error`, `unsupported`, an answering agent's `turn_cap` and
 * `context_overflow` stops, and `ingest_degraded`, which keeps its measured
 * scores); harness failures that make a comparison incomplete, never a
 * product loss (`reader_error`, `judge_error`, `harness_invalid`,
 * `budget_not_run`); and `does_not_fit`, not applicable: a whole history
 * that does not fit the reader's window leaves that system's denominator and
 * is reported, neither a product nor a harness failure. Everything except
 * `scored`, `unsupported`, `ingest_degraded`, `turn_cap`, `context_overflow`
 * and `does_not_fit` is retried on resume up to the attempt limit (rerunning
 * a deterministic stop would only re-roll a number); the last attempt is
 * terminal.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Observation } from '../stats/paired.ts';

export type Outcome = 'scored' | 'retrieval_error' | 'unsupported' | 'turn_cap' | 'context_overflow' | 'ingest_degraded' | 'reader_error' | 'judge_error' | 'harness_invalid' | 'budget_not_run' | 'does_not_fit';
export const OUTCOMES: readonly Outcome[] = ['scored', 'retrieval_error', 'unsupported', 'turn_cap', 'context_overflow', 'ingest_degraded', 'reader_error', 'judge_error', 'harness_invalid', 'budget_not_run', 'does_not_fit'];
export const PRODUCT_FAILURES: ReadonlySet<Outcome> = new Set(['retrieval_error', 'unsupported', 'turn_cap', 'context_overflow']);
export const HARNESS_FAILURES: ReadonlySet<Outcome> = new Set(['reader_error', 'judge_error', 'harness_invalid', 'budget_not_run']);
/** Out of that system's denominator and reported; neither a product nor a harness failure. */
export const NOT_APPLICABLE: ReadonlySet<Outcome> = new Set(['does_not_fit']);
const FINAL: ReadonlySet<Outcome> = new Set(['scored', 'unsupported', 'ingest_degraded', 'turn_cap', 'context_overflow', 'does_not_fit']);
export const DEFAULT_MAX_ATTEMPTS = 3;

export type Row = Record<string, unknown> & { id: string };

/** The outcome a row records: an explicit `outcome`, else derived from its error fields (legacy gbrain rows carry none). */
export function outcomeOf(row: Record<string, unknown>): Outcome {
  if (typeof row.outcome === 'string') return row.outcome as Outcome;
  const error = row.error;
  if (error !== undefined && error !== null) {
    if (row.error_origin === 'harness') return /budget/i.test(String(error)) ? 'budget_not_run' : 'harness_invalid';
    if (row.error_origin === 'dependency') return 'harness_invalid';
    return 'retrieval_error';
  }
  if (typeof row.qa_error === 'string') return row.qa_error.startsWith('judge:') ? 'judge_error' : 'reader_error';
  return 'scored';
}

export interface Manifest { kind: 'memory-qa-manifest'; schema_version: 1; run_config_hash: string; expected: string[]; expected_sha256: string; created_at: string }

const writeAtomic = (path: string, text: string) => { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); };

/** Write the manifest on first use; refuse a resume whose configuration or expected ids differ. */
export function freezeManifest(dir: string, runConfigHash: string, expected: string[]): Manifest {
  const path = join(dir, 'manifest.json');
  const sha = createHash('sha256').update(expected.join('\n')).digest('hex');
  if (existsSync(path)) {
    const prior = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    if (prior.run_config_hash !== runConfigHash) throw new Error(`${dir} holds a manifest from a different run configuration; use a fresh --output`);
    if (prior.expected_sha256 !== sha) throw new Error(`${dir}: the frozen manifest lists ${prior.expected.length} expected ids, this selection ${expected.length}; use a fresh --output`);
    return prior;
  }
  const m: Manifest = { kind: 'memory-qa-manifest', schema_version: 1, run_config_hash: runConfigHash, expected, expected_sha256: sha, created_at: new Date().toISOString() };
  writeAtomic(path, JSON.stringify(m, null, 2) + '\n');
  return m;
}

const readNdjson = (path: string): Row[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Row) : [];

/** Every attempt so far. A directory from before attempts existed migrates its rows.ndjson lines as attempts once. */
export function readAttempts(dir: string): Row[] {
  const path = join(dir, 'attempts.ndjson');
  if (!existsSync(path) && existsSync(join(dir, 'rows.ndjson'))) {
    const legacy = readNdjson(join(dir, 'rows.ndjson'));
    writeAtomic(path, legacy.map(r => JSON.stringify({ ...r, attempt_meta: { migrated: true } }) + '\n').join(''));
  }
  return readNdjson(path);
}

export function appendAttempt(dir: string, row: Row): void {
  appendFileSync(join(dir, 'attempts.ndjson'), JSON.stringify({ ...row, attempt_meta: { at: new Date().toISOString() } }) + '\n');
}

export interface Canonical {
  rows: Row[];
  outcomes: Array<{ id: string; outcome: Outcome; attempts: number }>;
  /** Expected ids still to attempt in this invocation. */
  pending: Set<string>;
  missing: string[];
  /** Attempted ids that the manifest does not list. */
  foreign: string[];
  counts: Record<Outcome, number>;
}

const stripMeta = ({ attempt_meta: _m, ...row }: Row) => row as Row;

export function canonicalize(manifest: Manifest, attempts: readonly Row[], maxAttempts = DEFAULT_MAX_ATTEMPTS): Canonical {
  const expected = new Set(manifest.expected);
  const latest = new Map<string, Row>();
  const tries = new Map<string, number>();
  const foreign = new Set<string>();
  for (const a of attempts) {
    if (!expected.has(a.id)) { foreign.add(a.id); continue; }
    latest.set(a.id, a);
    tries.set(a.id, (tries.get(a.id) ?? 0) + 1);
  }
  const counts = Object.fromEntries(OUTCOMES.map(k => [k, 0])) as Record<Outcome, number>;
  const rows: Row[] = [], outcomes: Canonical['outcomes'] = [], missing: string[] = [];
  const pending = new Set<string>();
  for (const id of manifest.expected) {
    const row = latest.get(id);
    if (!row) { missing.push(id); pending.add(id); continue; }
    const outcome = outcomeOf(row);
    const n = tries.get(id)!;
    counts[outcome]++;
    rows.push(stripMeta(row));
    outcomes.push({ id, outcome, attempts: n });
    if (!FINAL.has(outcome) && n < maxAttempts) pending.add(id);
  }
  return { rows, outcomes, pending, missing, foreign: [...foreign].sort(), counts };
}

export function writeCanonical(dir: string, c: Canonical): void {
  writeAtomic(join(dir, 'rows.ndjson'), c.rows.map(r => JSON.stringify(r) + '\n').join(''));
  writeAtomic(join(dir, 'outcomes.ndjson'), c.outcomes.map(o => JSON.stringify(o) + '\n').join(''));
}

const HARNESS_REASON = /^(harness|dependency|judge) error|^reader or judge error/;

/**
 * The preregistered pre-pairing join: an id that is ineligible for a harness
 * reason on any system is excluded from every system, so one flaky reader
 * call neither blocks a comparison family nor counts as a product loss.
 */
export function crossSystemExclusion(bySystem: Record<string, readonly Observation[]>): { bySystem: Record<string, Observation[]>; excluded: string[] } {
  const excluded = new Set<string>();
  for (const obs of Object.values(bySystem)) for (const o of obs) if (!o.eligible && HARNESS_REASON.test(o.reason ?? '')) excluded.add(o.id);
  const out: Record<string, Observation[]> = {};
  for (const [name, obs] of Object.entries(bySystem)) out[name] = obs.map(o => excluded.has(o.id) && o.eligible ? { ...o, value: null, eligible: false, reason: 'harness error on another system' } : { ...o });
  return { bySystem: out, excluded: [...excluded].sort() };
}
