/**
 * Aggregate the per-question NDJSON stream from `longmemeval.ts --ndjson`
 * into the same RunSummary[] shape the all-in-one runner produces.
 *
 * FEATURE BOUNDARY: pure post-processing — no gbrain code runs here. The
 * pipeline under test already ran in longmemeval.ts; this file only re-scores
 * the streamed rows via the SAME summarizeAdapterRows the runner uses (one
 * metric implementation, zero drift) and writes the authoritative receipt for
 * the aggregated run.
 *
 * Metric + denominator policy (see longmemeval.ts header): recall_all@k is
 * the headline, recall_any@k is the secondary any-hit diagnostic, `_abs`
 * questions are excluded from recall denominators and reported as
 * abs_noise@k, and rows are typed by failure origin (sut → scored 0,
 * harness/dependency → excluded + capped).
 *
 * Run:
 *   bun eval/runner/longmemeval-aggregate.ts <ndjson-path> [--output <out.json>]
 *        [--top-k <k>] [--dataset <name>] [--min-recall-all <x>]
 *        [--expect-rows <n>] [--allow-mixed]
 *
 * top_k/dataset are read from the NDJSON rows (the runner stamps every row).
 * Legacy streams (pre 2026-08-31) don't carry them — pass --top-k/--dataset
 * explicitly for those; mixed values across rows are an error, never a guess
 * (audit finding longmemeval-04: k=8 runs were published as Recall@5).
 *
 * run_config_hash guard: rows written by the current runner carry a
 * run_config_hash (sha256 over the resolved run configuration). Two different
 * hashes inside ONE adapter mean the rows came from different pipelines and
 * must not be averaged into one number — the aggregator REJECTS that (exit
 * non-zero) unless --allow-mixed is passed, which prints a loud banner and
 * records the mix in the receipt. Legacy streams where no row carries a hash
 * are treated as consistent (there is nothing to compare).
 *
 * --expect-rows <n> (validation, opt-in): assert every adapter has exactly n
 * rows after dedupe. Off by default so legacy partial streams keep
 * aggregating; turn it on when you expect a complete run (500 for `_s`).
 *
 * Writes:
 *   <stem>.json — { opts: {...}, summaries: [...] } same shape as runner output
 *   <stem>.md   — human-readable summary table
 *   eval/reports/longmemeval-aggregate/receipt.json — verdict + accounting
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  summarizeAdapterRows,
  classifyErrorOrigin,
  computeVerdict,
  defaultMinRecallAll,
  fmt,
  type NdjsonRow,
  type RunSummary,
} from './longmemeval.ts';
import {
  writeReceipt,
  receiptPath,
  RECEIPT_SCHEMA_VERSION,
  BENCHMARK_VERSION,
  type Receipt,
} from './receipt.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

const AGG_CATEGORY = 'longmemeval-aggregate';

/**
 * Parse + dedupe NDJSON rows. Concurrent workers can race past the resume
 * skip and double-process a pair; dedup prefers the NON-error row when one
 * exists (audit finding longmemeval-03: first-wins used to drop a later
 * success in favor of an earlier transient error). Between two clean rows,
 * first wins (results are deterministic given the same cached embeddings).
 * Malformed/truncated lines are skipped and counted.
 */
export function dedupeRows(raw: string): { rows: NdjsonRow[]; dupes: number; parseErrors: number } {
  const byKey = new Map<string, NdjsonRow>();
  let dupes = 0;
  let parseErrors = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: NdjsonRow;
    try {
      obj = JSON.parse(line) as NdjsonRow;
    } catch {
      parseErrors++;
      continue;
    }
    if (!obj?.adapter || !obj?.question_id) {
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
      byKey.set(key, obj); // success supersedes an earlier transient error
    }
  }
  return { rows: [...byKey.values()], dupes, parseErrors };
}

/**
 * Resolve top_k + dataset from the rows themselves. Mixed values are an
 * error; absent values (legacy streams) fall back to the CLI-provided
 * override or fail loudly — never a hardcoded 5/'s'.
 */
export function inferRunParams(
  rows: NdjsonRow[],
  cli: { topK: number | null; dataset: string | null },
): { topK: number; dataset: string } {
  const topKs = new Set(rows.map(r => r.top_k).filter((v): v is number => typeof v === 'number'));
  const datasets = new Set(rows.map(r => r.dataset).filter((v): v is string => typeof v === 'string'));
  if (topKs.size > 1) throw new Error(`mixed top_k values in NDJSON: ${[...topKs].join(', ')} — aggregate shards separately`);
  if (datasets.size > 1) throw new Error(`mixed dataset values in NDJSON: ${[...datasets].join(', ')} — aggregate shards separately`);
  const rowTopK = topKs.size === 1 ? [...topKs][0] : null;
  const rowDataset = datasets.size === 1 ? [...datasets][0] : null;
  if (rowTopK !== null && cli.topK !== null && rowTopK !== cli.topK) {
    throw new Error(`--top-k ${cli.topK} contradicts top_k=${rowTopK} recorded in the NDJSON rows`);
  }
  if (rowDataset !== null && cli.dataset !== null && rowDataset !== cli.dataset) {
    throw new Error(`--dataset ${cli.dataset} contradicts dataset=${rowDataset} recorded in the NDJSON rows`);
  }
  const topK = rowTopK ?? cli.topK;
  const dataset = rowDataset ?? cli.dataset;
  if (topK === null) throw new Error('NDJSON rows carry no top_k (legacy stream) — pass --top-k explicitly');
  if (dataset === null) throw new Error('NDJSON rows carry no dataset (legacy stream) — pass --dataset explicitly');
  return { topK, dataset };
}

/** Stable preferred adapter order so charts and tables look the same across runs. */
const ADAPTER_ORDER = [
  'gbrain-keyword',
  'gbrain-vector',
  'gbrain-hybrid',
  'gbrain-hybrid+expansion',
  'gbrain-hybrid-sessdiv',
  'gbrain-hybrid+expansion-sessdiv',
  'gbrain-hybrid+rerank',
  'gbrain-hybrid-sessdiv+rerank',
];

export interface MixedHashFinding {
  adapter: string;
  /** Distinct run_config_hash values seen (sorted). */
  hashes: string[];
  n_with_hash: number;
  n_without_hash: number;
}

/**
 * Flag adapters whose rows carry more than one distinct run_config_hash, or a
 * mix of hashed and hash-less rows (rows from two runner generations). An
 * adapter where NO row carries a hash is a legacy stream — consistent by
 * definition, nothing to compare. Averaging rows produced by different
 * pipeline configurations into one published number is exactly the class of
 * error the hash exists to catch, so the CLI treats any finding as fatal
 * unless --allow-mixed is passed explicitly.
 */
export function findMixedRunConfigHashes(rows: NdjsonRow[]): MixedHashFinding[] {
  const byAdapter = new Map<string, NdjsonRow[]>();
  for (const r of rows) {
    if (!byAdapter.has(r.adapter)) byAdapter.set(r.adapter, []);
    byAdapter.get(r.adapter)!.push(r);
  }
  const findings: MixedHashFinding[] = [];
  for (const [adapter, group] of byAdapter) {
    const hashes = new Set<string>();
    let without = 0;
    for (const r of group) {
      if (typeof r.run_config_hash === 'string' && r.run_config_hash.length > 0) hashes.add(r.run_config_hash);
      else without++;
    }
    if (hashes.size === 0) continue; // all-absent (legacy) → consistent
    if (hashes.size > 1 || without > 0) {
      findings.push({
        adapter,
        hashes: [...hashes].sort(),
        n_with_hash: group.length - without,
        n_without_hash: without,
      });
    }
  }
  return findings.sort((a, b) => a.adapter.localeCompare(b.adapter));
}

export function aggregateRows(rows: NdjsonRow[], topK: number, dataset: string): RunSummary[] {
  const byAdapter = new Map<string, NdjsonRow[]>();
  for (const r of rows) {
    if (!byAdapter.has(r.adapter)) byAdapter.set(r.adapter, []);
    byAdapter.get(r.adapter)!.push(r);
  }
  const summaries: RunSummary[] = [];
  for (const [adapterName, adapterRows] of byAdapter) {
    summaries.push(summarizeAdapterRows(adapterName, adapterRows, topK, dataset));
  }
  summaries.sort((a, b) => ADAPTER_ORDER.indexOf(a.adapter) - ADAPTER_ORDER.indexOf(b.adapter));
  return summaries;
}

function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

if (import.meta.main) {
  const startedAt = new Date().toISOString();
  const args = process.argv.slice(2);
  // Positional input path: first arg that is neither a flag nor a flag's value.
  // Boolean flags take no value — without this set, `--allow-mixed <path>`
  // would swallow the path as a flag value.
  const BOOLEAN_FLAGS = new Set(['--allow-mixed']);
  const flagValues = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && !BOOLEAN_FLAGS.has(args[i]) && i + 1 < args.length && !args[i + 1].startsWith('--')) flagValues.add(args[i + 1]);
  }
  const positional = args.filter(a => !a.startsWith('--') && !flagValues.has(a));
  const input = positional[0];
  if (!input) {
    console.error('usage: bun longmemeval-aggregate.ts <ndjson-path> [--output <out.json>] [--top-k <k>] [--dataset <name>] [--min-recall-all <x>] [--expect-rows <n>] [--allow-mixed]');
    process.exit(1);
  }
  const outputArg = argValue(args, '--output');
  const cliTopK = argValue(args, '--top-k');
  const cliDataset = argValue(args, '--dataset');
  const cliMin = argValue(args, '--min-recall-all');
  const cliExpectRows = argValue(args, '--expect-rows');
  const allowMixed = args.includes('--allow-mixed');

  const receiptFile = receiptPath(AGG_CATEGORY, join(process.cwd(), 'eval/reports'));
  try {
    const raw = readFileSync(input, 'utf8');
    const { rows, dupes, parseErrors } = dedupeRows(raw);
    if (dupes > 0) process.stderr.write(`[aggregate] ${dupes} duplicate (adapter, question_id) rows deduped (non-error rows preferred)\n`);
    if (parseErrors > 0) process.stderr.write(`[aggregate] ${parseErrors} malformed/truncated lines skipped\n`);
    if (rows.length === 0) throw new Error(`no parseable rows in ${input}`);

    // run_config_hash guard: never average rows from two different pipeline
    // configurations into one number. Legacy all-absent streams pass.
    const mixed = findMixedRunConfigHashes(rows);
    if (mixed.length > 0) {
      const detail = mixed
        .map(m => `  ${m.adapter}: ${m.hashes.length} distinct run_config_hash value(s)` +
          `${m.n_without_hash > 0 ? ` plus ${m.n_without_hash} row(s) without a hash` : ''}` +
          ` [${m.hashes.map(h => h.slice(0, 12)).join(', ')}]`)
        .join('\n');
      if (!allowMixed) {
        throw new Error(
          `MIXED run_config_hash within adapter(s) — these rows were produced by different runner configurations and must not be aggregated as one number:\n${detail}\n` +
          `Aggregate each configuration's NDJSON separately, or pass --allow-mixed to override (the mix is recorded in the receipt).`,
        );
      }
      process.stderr.write(
        `\n${'='.repeat(72)}\n` +
        `[aggregate] WARNING: --allow-mixed — aggregating rows from DIFFERENT\n` +
        `[aggregate] runner configurations within one adapter. The resulting\n` +
        `[aggregate] numbers are NOT publishable as a single-configuration run.\n` +
        `${detail}\n${'='.repeat(72)}\n\n`,
      );
    }

    // Opt-in completeness gate (--expect-rows): every adapter must have
    // exactly n rows after dedupe. Off by default so legacy partial streams
    // keep aggregating.
    if (cliExpectRows !== null) {
      const want = Number(cliExpectRows);
      if (!Number.isFinite(want) || want <= 0) throw new Error(`--expect-rows must be a positive number, got "${cliExpectRows}"`);
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.adapter, (counts.get(r.adapter) ?? 0) + 1);
      const short = [...counts.entries()].filter(([, n]) => n !== want);
      if (short.length > 0) {
        throw new Error(
          `--expect-rows ${want} violated: ` +
          short.map(([a, n]) => `${a} has ${n} rows`).join(', '),
        );
      }
    }

    const { topK, dataset } = inferRunParams(rows, {
      topK: cliTopK !== null ? Number(cliTopK) : null,
      dataset: cliDataset,
    });
    const summaries = aggregateRows(rows, topK, dataset);

    // Accounting over deduped rows: sut errors scored 0, infra errors
    // excluded + capped (probe-accounting policy).
    const acc = new ProbeAccounting(rows.length);
    for (const r of rows) {
      const id = `${r.adapter}::${r.question_id}`;
      if (r.error !== undefined) {
        acc.error(id, r.error_origin ?? classifyErrorOrigin(r.error), r.error);
      } else {
        acc.score(id, r.recall_all ?? (r.hit_at_k ? 1 : 0));
      }
    }
    const accSummary = acc.summary();
    const minGate = cliMin !== null
      ? Number(cliMin)
      : process.env.LME_MIN_RECALL_ALL
        ? Number(process.env.LME_MIN_RECALL_ALL)
        : defaultMinRecallAll(summaries.map(s => s.adapter));
    const gate = computeVerdict(summaries, minGate);
    const runInvalid = accSummary.run_invalid;

    const stem = outputArg || input.replace(/\.ndjson$/, '');
    const outJson = stem.endsWith('.json') ? stem : stem + '.json';
    writeFileSync(outJson, JSON.stringify({
      opts: { datasetName: dataset, topK },
      resolved: { gbrain_version: gbrainVersion(), gbrain_pin: gbrainPin(), source_ndjson: input },
      summaries,
    }, null, 2) + '\n');
    process.stderr.write(`wrote ${outJson}\n`);

    // Human-readable markdown — same fmt as the runner (one formatter).
    const mdPath = outJson.replace(/\.json$/, '.md');
    const md = `<!-- aggregated from ${input} -->\n` + fmt(summaries);
    writeFileSync(mdPath, md + '\n');
    process.stderr.write(`wrote ${mdPath}\n\n${md}\n`);

    const receipt: Receipt = {
      schema_version: RECEIPT_SCHEMA_VERSION,
      benchmark_version: BENCHMARK_VERSION,
      category: AGG_CATEGORY,
      run_status: runInvalid ? 'error' : 'completed',
      ...(runInvalid ? {} : { verdict: gate.verdict }),
      n_total: accSummary.n_total,
      n_scored: accSummary.n_scored,
      completion_rate: accSummary.completion_rate,
      errors: accSummary.errors,
      // A mixed-hash aggregation (--allow-mixed) is diagnostic output, never
      // a publishable single-configuration number.
      publishable: accSummary.publishable && mixed.length === 0,
      gbrain_version: gbrainVersion(),
      gbrain_pin: gbrainPin(),
      resolved_config: {
        dataset,
        top_k: topK,
        min_recall_all_gate: minGate,
        source_ndjson: input,
        dupes_deduped: dupes,
        parse_errors: parseErrors,
        ...(cliExpectRows !== null ? { expect_rows: Number(cliExpectRows) } : {}),
        // --allow-mixed override: the mix is on the record, never silent.
        ...(mixed.length > 0 ? { allow_mixed: true, mixed_run_config_hashes: mixed } : {}),
      },
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      data: {
        headline_metric: 'recall_all_at_k',
        verdict_reason: gate.reason,
        infra_error_rate: accSummary.infra_error_rate,
        summaries,
      },
    };
    writeReceipt(receiptFile, receipt);
    process.stderr.write(`[aggregate] receipt: ${receiptFile} (run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'})\n`);
    process.exit(runInvalid ? 1 : gate.verdict === 'fail' ? 1 : 0);
  } catch (e: any) {
    try {
      writeReceipt(receiptFile, {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: AGG_CATEGORY,
        run_status: 'error',
        n_total: 0,
        n_scored: 0,
        completion_rate: 0,
        errors: [{ probe_id: 'aggregate', origin: 'harness', message: String(e?.message ?? e).slice(0, 500) }],
        publishable: false,
        gbrain_version: gbrainVersion(),
        gbrain_pin: gbrainPin(),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      });
    } catch { /* receipt write failed too */ }
    console.error(`[aggregate] FATAL: ${e?.message ?? e}`);
    process.exit(1);
  }
}
