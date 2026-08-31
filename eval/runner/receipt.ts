/**
 * Receipt architecture (BrainBench v0.3.0, WS0).
 *
 * Every category runner writes exactly one receipt JSON per run. The receipt
 * — not the exit code — is the source of truth the umbrella runner (all.ts)
 * aggregates. Exit codes remain only a crash backstop: a runner that dies
 * before writing a receipt is `not_run`; a runner that writes
 * `run_status: 'skipped'` can never be counted as pass (audit finding
 * retrieval-cats cat11: skipped modalities aggregated as PASS via exit 0).
 *
 * Outcome model is THREE dimensions, not one enum:
 *   run_status      — did it execute (completed | error | skipped | not_run)
 *   verdict         — benchmark semantics, only meaningful when completed
 *   failure_origin  — who broke (sut | harness | dependency | judge), typed
 *                     on every recorded error
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can never leave
 * a half-receipt that parses as a result. Readers validate before trusting.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export const BENCHMARK_VERSION = '0.3.0';
export const RECEIPT_SCHEMA_VERSION = 1;

export type RunStatus = 'completed' | 'error' | 'skipped' | 'not_run';
export type ReceiptVerdict = 'pass' | 'partial' | 'fail';
export type FailureOrigin = 'sut' | 'harness' | 'dependency' | 'judge';

export interface ProbeError {
  probe_id: string;
  origin: FailureOrigin;
  message: string;
}

export interface JudgeProvenance {
  model: string;
  temperature: number;
  rubric_version?: string;
  seed?: number;
}

export interface Receipt {
  schema_version: typeof RECEIPT_SCHEMA_VERSION;
  benchmark_version: string;
  category: string;
  run_status: RunStatus;
  /** Only meaningful when run_status === 'completed'. */
  verdict?: ReceiptVerdict;
  skip_reason?: string;
  n_total: number;
  n_scored: number;
  completion_rate: number;
  errors: ProbeError[];
  /** False for smoke runs (n_total < 10) that recorded any harness error. */
  publishable: boolean;
  gbrain_version: string;
  gbrain_pin: string;
  resolved_config?: Record<string, unknown>;
  judge?: JudgeProvenance;
  /** Content hashes for provenance: corpus, qrels, evaluator, etc. */
  hashes?: Record<string, string>;
  started_at: string;
  finished_at: string;
  /** Category-specific payload (metric tables, per-probe rows). */
  data?: Record<string, unknown>;
}

const RUN_STATUSES: RunStatus[] = ['completed', 'error', 'skipped', 'not_run'];
const VERDICTS: ReceiptVerdict[] = ['pass', 'partial', 'fail'];
const ORIGINS: FailureOrigin[] = ['sut', 'harness', 'dependency', 'judge'];

/**
 * Structural validation. Returns a list of violations; empty list = valid.
 * all.ts refuses to aggregate a receipt with violations.
 */
export function validateReceipt(obj: unknown): string[] {
  const v: string[] = [];
  if (!obj || typeof obj !== 'object') return ['receipt is not an object'];
  const r = obj as Record<string, unknown>;
  if (r.schema_version !== RECEIPT_SCHEMA_VERSION) v.push(`schema_version must be ${RECEIPT_SCHEMA_VERSION}`);
  if (typeof r.benchmark_version !== 'string') v.push('benchmark_version missing');
  if (typeof r.category !== 'string' || r.category === '') v.push('category missing');
  if (!RUN_STATUSES.includes(r.run_status as RunStatus)) v.push(`run_status must be one of ${RUN_STATUSES.join('|')}`);
  if (r.run_status === 'completed') {
    if (!VERDICTS.includes(r.verdict as ReceiptVerdict)) v.push('completed receipt requires verdict pass|partial|fail');
  } else if (r.verdict !== undefined) {
    v.push('verdict only allowed when run_status is completed');
  }
  if (r.run_status === 'skipped' && typeof r.skip_reason !== 'string') v.push('skipped receipt requires skip_reason');
  if (typeof r.n_total !== 'number' || r.n_total < 0) v.push('n_total must be a number >= 0');
  if (typeof r.n_scored !== 'number' || r.n_scored < 0) v.push('n_scored must be a number >= 0');
  if (typeof r.completion_rate !== 'number' || Number.isNaN(r.completion_rate)) v.push('completion_rate must be a number');
  if (typeof r.publishable !== 'boolean') v.push('publishable must be boolean');
  if (typeof r.gbrain_version !== 'string') v.push('gbrain_version missing');
  if (typeof r.gbrain_pin !== 'string') v.push('gbrain_pin missing');
  if (!Array.isArray(r.errors)) {
    v.push('errors must be an array');
  } else {
    for (const e of r.errors as unknown[]) {
      const err = e as Record<string, unknown>;
      if (!err || typeof err !== 'object' || typeof err.probe_id !== 'string'
        || !ORIGINS.includes(err.origin as FailureOrigin) || typeof err.message !== 'string') {
        v.push('errors[] entries require {probe_id, origin sut|harness|dependency|judge, message}');
        break;
      }
    }
  }
  if (typeof r.started_at !== 'string' || typeof r.finished_at !== 'string') v.push('started_at/finished_at missing');
  return v;
}

/** Canonical receipt location for a category run. */
export function receiptPath(category: string, reportsDir = join(process.cwd(), 'eval/reports')): string {
  return join(reportsDir, category, 'receipt.json');
}

/** Atomic write: validate, write temp file in the same dir, rename over target. */
export function writeReceipt(path: string, receipt: Receipt): void {
  const violations = validateReceipt(receipt);
  if (violations.length > 0) {
    throw new Error(`refusing to write invalid receipt (${receipt.category}): ${violations.join('; ')}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Read + validate. Throws with the violation list on an invalid receipt. */
export function loadReceipt(path: string): Receipt {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const violations = validateReceipt(parsed);
  if (violations.length > 0) throw new Error(`invalid receipt at ${path}: ${violations.join('; ')}`);
  return parsed as Receipt;
}
