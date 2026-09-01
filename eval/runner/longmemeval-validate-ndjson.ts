/**
 * LongMemEval NDJSON validator — integrity checks over a committed raw-row
 * stream (e.g. docs/benchmarks/2026-05-07-longmemeval-s/rescore-may-copy.ndjson).
 *
 * This is the validator the erratum-resolution report cites: it answers
 * "does this NDJSON actually contain one clean row per (adapter, question)
 * for the full split, with ground truth matching the dataset?" with a hard
 * exit code — no partial-success wording.
 *
 * Pure Bun/node stdlib. No API keys, no gbrain imports. The dedup and
 * abstention conventions REPLICATE the runner/aggregator contracts
 * (longmemeval.ts isAbsQuestion: question_id contains '_abs';
 * longmemeval-aggregate.ts dedupeRows: prefer the non-error row, else first
 * wins) rather than importing them, so the validator stays dependency-free
 * and usable on a machine that never ran `bun install` for gbrain.
 *
 * Usage:
 *   bun eval/runner/longmemeval-validate-ndjson.ts <ndjson> \
 *     [--path <dataset json>] [--expected-rows 500] [--expected-abs 30] \
 *     [--adapters a,b,c] [--expected-dataset-sha <hex>]
 *
 * Checks (defaults parameterized for the LongMemEval `_s` split):
 *   1. every line parses and carries adapter + question_id (parse errors fail)
 *   2. adapter set == --adapters (default: the four published gbrain adapters)
 *   3. per adapter, unique (adapter, question_id) count AFTER dedup
 *      == --expected-rows (default 500; resume dupes are deduped first,
 *      preferring non-error rows, mirroring the aggregator)
 *   4. identical question_id coverage across all adapters
 *   5. per adapter, abstention count (ids containing '_abs') == --expected-abs
 *      (default 30)
 *   6. with --path: every row's ground_truth equals the dataset's
 *      answer_session_ids (reported N/N), question coverage equals the
 *      dataset's question ids, and the dataset file's sha256 is printed
 *      (compared when --expected-dataset-sha is given)
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — any mismatch (every mismatch printed with counts)
 *   2 — NDJSON or dataset file missing/unreadable/not the expected shape
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { gunzipSync } from 'zlib';

// ─── Conventions replicated from the runner/aggregator (see header) ────────

/** longmemeval.ts convention: abstention questions carry '_abs' in the id. */
export function isAbsQuestion(questionId: string): boolean {
  return questionId.includes('_abs');
}

export interface ValidatorRow {
  adapter: string;
  question_id: string;
  ground_truth?: string[];
  error?: string;
}

/**
 * Parse + dedupe, mirroring longmemeval-aggregate.ts dedupeRows: between an
 * error row and a clean row for the same (adapter, question_id), the clean
 * row wins; between two clean rows, first wins.
 */
export function parseAndDedupe(raw: string): {
  rows: ValidatorRow[];
  dupes: number;
  parseErrors: number;
} {
  const byKey = new Map<string, ValidatorRow>();
  let dupes = 0;
  let parseErrors = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: ValidatorRow;
    try {
      obj = JSON.parse(line) as ValidatorRow;
    } catch {
      parseErrors++;
      continue;
    }
    if (typeof obj?.adapter !== 'string' || typeof obj?.question_id !== 'string') {
      parseErrors++;
      continue;
    }
    const key = `${obj.adapter}::${obj.question_id}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, obj);
      continue;
    }
    dupes++;
    if (existing.error !== undefined && obj.error === undefined) {
      byKey.set(key, obj);
    }
  }
  return { rows: [...byKey.values()], dupes, parseErrors };
}

// ─── Dataset loading ────────────────────────────────────────────────────────

interface DatasetQuestion {
  question_id: string;
  answer_session_ids: string[];
}

/**
 * Load the LongMemEval dataset JSON: a top-level array of question objects
 * (or `{questions: [...]}`), each with question_id + answer_session_ids.
 * Throws with a descriptive message on any shape violation — the caller maps
 * that to exit 2 (unreadable), never to a soft mismatch.
 */
export function loadDataset(path: string): { questions: DatasetQuestion[]; sha256: string } {
  const buf = readFileSync(path);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const parsed = JSON.parse(buf.toString('utf8'));
  const arr = Array.isArray(parsed) ? parsed : parsed?.questions;
  if (!Array.isArray(arr)) {
    throw new Error('dataset is neither a JSON array nor {questions: [...]}');
  }
  const questions: DatasetQuestion[] = [];
  for (let i = 0; i < arr.length; i++) {
    const q = arr[i];
    if (typeof q?.question_id !== 'string') {
      throw new Error(`dataset question at index ${i} has no string question_id`);
    }
    const gt = q.answer_session_ids;
    if (!Array.isArray(gt) || gt.some((s: unknown) => typeof s !== 'string')) {
      throw new Error(`dataset question ${q.question_id} has no answer_session_ids string array`);
    }
    questions.push({ question_id: q.question_id, answer_session_ids: gt });
  }
  return { questions, sha256 };
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface ValidateOpts {
  expectedRows: number;
  expectedAbs: number;
  adapters: string[];
  dataset?: { questions: DatasetQuestion[]; sha256: string };
  expectedDatasetSha?: string;
}

export interface ValidateResult {
  mismatches: string[];
  info: string[];
}

function sortedEq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function validateRows(
  rows: ValidatorRow[],
  dupes: number,
  parseErrors: number,
  opts: ValidateOpts,
): ValidateResult {
  const mismatches: string[] = [];
  const info: string[] = [];

  info.push(`rows=${rows.length} (unique after dedup), resume dupes deduped=${dupes}`);
  if (parseErrors > 0) {
    mismatches.push(`${parseErrors} malformed/truncated line(s) — a committed stream must parse 100%`);
  }

  // Adapter set.
  const byAdapter = new Map<string, ValidatorRow[]>();
  for (const r of rows) {
    if (!byAdapter.has(r.adapter)) byAdapter.set(r.adapter, []);
    byAdapter.get(r.adapter)!.push(r);
  }
  const found = [...byAdapter.keys()].sort();
  const expected = [...opts.adapters].sort();
  if (!sortedEq(found, expected)) {
    mismatches.push(
      `adapter set mismatch: found [${found.join(', ')}], expected [${expected.join(', ')}]`,
    );
  }

  // Per-adapter unique row count + abstention count.
  for (const adapter of expected) {
    const aRows = byAdapter.get(adapter);
    if (!aRows) continue; // already reported as an adapter-set mismatch
    if (aRows.length !== opts.expectedRows) {
      mismatches.push(
        `${adapter}: ${aRows.length} unique (adapter, question_id) rows after dedup, expected ${opts.expectedRows}`,
      );
    }
    const nAbs = aRows.filter(r => isAbsQuestion(r.question_id)).length;
    if (nAbs !== opts.expectedAbs) {
      mismatches.push(`${adapter}: ${nAbs} abstention (_abs) questions, expected ${opts.expectedAbs}`);
    }
  }

  // Identical question_id coverage across adapters.
  const adaptersPresent = [...byAdapter.keys()].sort();
  if (adaptersPresent.length > 1) {
    const refAdapter = adaptersPresent[0];
    const refIds = new Set(byAdapter.get(refAdapter)!.map(r => r.question_id));
    for (const adapter of adaptersPresent.slice(1)) {
      const ids = new Set(byAdapter.get(adapter)!.map(r => r.question_id));
      const missing = [...refIds].filter(id => !ids.has(id));
      const extra = [...ids].filter(id => !refIds.has(id));
      if (missing.length > 0 || extra.length > 0) {
        mismatches.push(
          `question_id coverage differs: ${adapter} vs ${refAdapter} — ` +
            `${missing.length} missing, ${extra.length} extra ` +
            `(e.g. ${[...missing, ...extra].slice(0, 3).join(', ')})`,
        );
      }
    }
  }

  // Ground-truth validation against the dataset.
  if (opts.dataset) {
    const { questions, sha256 } = opts.dataset;
    info.push(`dataset sha256=${sha256} (${questions.length} questions)`);
    if (opts.expectedDatasetSha && opts.expectedDatasetSha.toLowerCase() !== sha256) {
      mismatches.push(
        `dataset sha256 mismatch: file=${sha256}, expected=${opts.expectedDatasetSha.toLowerCase()}`,
      );
    }
    const gtById = new Map(questions.map(q => [q.question_id, q.answer_session_ids]));

    // Coverage must equal the dataset's question ids exactly.
    const ndjsonIds = new Set(rows.map(r => r.question_id));
    const notInDataset = [...ndjsonIds].filter(id => !gtById.has(id));
    const notInNdjson = questions.filter(q => !ndjsonIds.has(q.question_id));
    if (notInDataset.length > 0) {
      mismatches.push(
        `${notInDataset.length} NDJSON question_id(s) absent from the dataset (e.g. ${notInDataset.slice(0, 3).join(', ')})`,
      );
    }
    if (notInNdjson.length > 0) {
      mismatches.push(
        `${notInNdjson.length} dataset question(s) never appear in the NDJSON (e.g. ${notInNdjson.slice(0, 3).map(q => q.question_id).join(', ')})`,
      );
    }

    // Per-row ground_truth equality.
    let checked = 0;
    let matched = 0;
    const examples: string[] = [];
    for (const r of rows) {
      const gt = gtById.get(r.question_id);
      if (gt === undefined) continue; // reported above
      checked++;
      if (sortedEq(r.ground_truth ?? [], gt)) {
        matched++;
      } else if (examples.length < 3) {
        examples.push(`${r.adapter}::${r.question_id}`);
      }
    }
    info.push(`ground_truth vs dataset answer_session_ids: ${matched}/${checked} rows match`);
    if (matched !== checked) {
      mismatches.push(
        `ground_truth mismatch on ${checked - matched}/${checked} rows (e.g. ${examples.join(', ')})`,
      );
    }
  }

  return { mismatches, info };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const DEFAULT_ADAPTERS = [
  'gbrain-keyword',
  'gbrain-vector',
  'gbrain-hybrid',
  'gbrain-hybrid+expansion',
];

function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flagValues = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      flagValues.add(args[i + 1]);
    }
  }
  const positional = args.filter(a => !a.startsWith('--') && !flagValues.has(a));
  const input = positional[0];
  if (!input) {
    console.error(
      'usage: bun eval/runner/longmemeval-validate-ndjson.ts <ndjson> ' +
        '[--path <dataset json>] [--expected-rows 500] [--expected-abs 30] ' +
        '[--adapters a,b,c] [--expected-dataset-sha <hex>]',
    );
    process.exit(2);
  }

  const expectedRows = Number(argValue(args, '--expected-rows') ?? '500');
  const expectedAbs = Number(argValue(args, '--expected-abs') ?? '30');
  if (!Number.isInteger(expectedRows) || !Number.isInteger(expectedAbs)) {
    console.error('--expected-rows / --expected-abs must be integers');
    process.exit(2);
  }
  const adaptersArg = argValue(args, '--adapters');
  const adapters = adaptersArg
    ? adaptersArg.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_ADAPTERS;
  const datasetPath = argValue(args, '--path');
  const expectedDatasetSha = argValue(args, '--expected-dataset-sha') ?? undefined;

  let raw: string;
  try {
    const buf = readFileSync(input);
    raw = input.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  } catch (e) {
    console.error(`[validate] NDJSON unreadable: ${input} — ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }

  let dataset: { questions: DatasetQuestion[]; sha256: string } | undefined;
  if (datasetPath) {
    try {
      dataset = loadDataset(datasetPath);
    } catch (e) {
      console.error(
        `[validate] dataset unreadable: ${datasetPath} — ${e instanceof Error ? e.message : e}`,
      );
      process.exit(2);
    }
  }

  const { rows, dupes, parseErrors } = parseAndDedupe(raw);
  const { mismatches, info } = validateRows(rows, dupes, parseErrors, {
    expectedRows,
    expectedAbs,
    adapters,
    dataset,
    expectedDatasetSha,
  });

  for (const line of info) console.log(`[validate] ${line}`);
  if (mismatches.length > 0) {
    for (const m of mismatches) console.error(`[validate] MISMATCH: ${m}`);
    console.error(`[validate] FAIL: ${mismatches.length} mismatch(es)`);
    process.exit(1);
  }
  console.log(
    `[validate] OK: ${adapters.length} adapter(s) x ${expectedRows} rows, ` +
      `${expectedAbs} abstentions each${dataset ? ', ground truth validated against dataset' : ''}`,
  );
  process.exit(0);
}
