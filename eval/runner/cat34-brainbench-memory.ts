/**
 * BrainBench Cat 34 — cross-harness memory conformance (the gbrain-repo
 * BrainBench suite, driven through its published foreign-runner contract).
 *
 * FEATURE BOUNDARY — what is under test vs what is seeded/stubbed:
 *   Under test: the exact seam any third party gets — the subprocess CLI
 *   contract `gbrain eval brainbench --harness all --suite all --json --out
 *   FILE` documented in <gbrain>/evals/brainbench/schema/ (fixture / gold /
 *   result / baseline JSON Schemas), and the memory conformance it grades:
 *   know-to-ask, push precision/recall, write-back fidelity (production
 *   pipeline), cross-session continuity, source isolation — per harness seam
 *   (openclaw=production, claude-code and codex=contract; see
 *   <gbrain>/docs/eval/BRAINBENCH.md). This runner does NOT import gbrain
 *   internals; everything inside the subprocess (fixtures, gold, in-memory
 *   PGLite, scoring) is BrainBench's own and is the SUT.
 *   Seeded/stubbed: nothing on our side. Provider API keys are STRIPPED from
 *   the subprocess env so the run is hermetic (llm:false) and gbrain's
 *   'balanced' search mode cannot silently enable the zerank-2 reranker off
 *   an ambient ZEROENTROPY_API_KEY. No LLM, no network, ~15s.
 *
 * Pass criteria (real, failable — graded HERE, not from the subprocess exit
 * code, which is 0 even for gold failures when no --compare is given):
 *   - a FRESH result document was written by THIS run (run-unique --out path,
 *     stale artifacts purged before spawn, mtime verified after — audit
 *     finding skillopt-cats-04),
 *   - the document passes result_schema_version===1 contract validation
 *     (audit finding skillopt-cats-10),
 *   - every cell has gold_failed === 0 and gold_total > 0,
 *   - all four suites appear in the matrix, seed_failures is empty, and the
 *     subprocess exited 0.
 * Missing-fresh-result and unparseable/contract-mismatched documents are
 * typed errors (run_status 'error'), never graded from a stale file.
 *
 * Run:
 *   bun eval/runner/cat34-brainbench-memory.ts                    # gate-mode corpus
 *   bun eval/runner/cat34-brainbench-memory.ts --include-holdout  # published-run mode
 *   bun eval/runner/cat34-brainbench-memory.ts --allow-skip       # exit 0 when no checkout
 *
 * gbrain resolution: $GBRAIN_REPO (a checkout containing src/cli.ts +
 * evals/brainbench/), falling back to ../gbrain then ~/git/gbrain. Requires a
 * gbrain that ships `eval brainbench` (Cathedral 2, > v0.42.40.0). No
 * checkout → receipt run_status 'skipped' + NON-ZERO exit unless
 * --allow-skip / BRAINBENCH_ALLOW_SKIP=1.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { ProbeAccounting } from './probe-accounting.ts';
import {
  BENCHMARK_VERSION,
  RECEIPT_SCHEMA_VERSION,
  receiptPath,
  writeReceipt,
  type ProbeError,
  type Receipt,
} from './receipt.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';

export const CAT34_CATEGORY = 'cat34-brainbench-memory';

/** The published matrix: all four suites must appear or the gate narrowed. */
const EXPECTED_SUITES = ['know-to-ask', 'push', 'write-back', 'continuity'] as const;

/** Stripped from the subprocess env: hermetic run, and gbrain's default
 * 'balanced' mode silently enables the zerank-2 reranker when
 * ZEROENTROPY_API_KEY is set — never rely on ambient keys. */
const STRIPPED_ENV_KEYS = [
  'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY',
];

interface ResultCell {
  harness: string;
  seam: string;
  suite: string;
  gold_total: number;
  gold_failed: number;
  metrics: Record<string, number>;
}
interface BrainBenchResultDoc {
  receipt: {
    result_schema_version: number;
    fixtures_hash: string;
    harness_sha: string;
    ts: string;
    include_holdout: boolean;
    llm: boolean;
  };
  cells: ResultCell[];
  seed_failures: Array<{ fixture_id: string; error: string }>;
}

/**
 * Contract validation for the foreign-runner result document
 * (evals/brainbench/schema/result.schema.json pins result_schema_version to
 * {const:1}, additive-only within a version). Returns violations; empty =
 * valid. A v2 or truncated document must be a typed contract-mismatch error,
 * not a TypeError three dereferences later (audit finding skillopt-cats-10).
 */
export function validateResultDoc(doc: unknown): string[] {
  const v: string[] = [];
  if (!doc || typeof doc !== 'object') return ['result is not an object'];
  const d = doc as Record<string, unknown>;
  const receipt = d.receipt as Record<string, unknown> | undefined;
  if (!receipt || typeof receipt !== 'object') {
    v.push('receipt missing');
  } else {
    if (receipt.result_schema_version !== 1) {
      v.push(`result_schema_version must be 1 (got ${JSON.stringify(receipt.result_schema_version)})`);
    }
    if (typeof receipt.fixtures_hash !== 'string') v.push('receipt.fixtures_hash must be a string');
    if (typeof receipt.harness_sha !== 'string') v.push('receipt.harness_sha must be a string');
    if (typeof receipt.include_holdout !== 'boolean') v.push('receipt.include_holdout must be a boolean');
    if (typeof receipt.llm !== 'boolean') v.push('receipt.llm must be a boolean');
  }
  if (!Array.isArray(d.cells)) {
    v.push('cells must be an array');
  } else {
    for (const [i, c] of (d.cells as unknown[]).entries()) {
      const cell = c as Record<string, unknown>;
      if (!cell || typeof cell !== 'object'
        || typeof cell.harness !== 'string' || typeof cell.seam !== 'string' || typeof cell.suite !== 'string'
        || typeof cell.gold_total !== 'number' || typeof cell.gold_failed !== 'number'
        || !cell.metrics || typeof cell.metrics !== 'object') {
        v.push(`cells[${i}] requires {harness, seam, suite, gold_total, gold_failed, metrics}`);
        break;
      }
    }
  }
  if (!Array.isArray(d.seed_failures)) {
    v.push('seed_failures must be an array');
  } else {
    for (const [i, s] of (d.seed_failures as unknown[]).entries()) {
      const sf = s as Record<string, unknown>;
      if (!sf || typeof sf !== 'object' || typeof sf.fixture_id !== 'string' || typeof sf.error !== 'string') {
        v.push(`seed_failures[${i}] requires {fixture_id, error}`);
        break;
      }
    }
  }
  return v;
}

/**
 * Find a gbrain checkout carrying BrainBench. When `explicit` is given
 * (option or $GBRAIN_REPO) ONLY it is considered — no silent fallback to a
 * different checkout than the one asked for. Returns null when nothing valid
 * is found (caller writes a 'skipped' receipt).
 */
export function resolveGbrainRepo(explicit?: string): string | null {
  const candidates = explicit !== undefined
    ? [explicit]
    : [process.env.GBRAIN_REPO, resolve('..', 'gbrain'), join(homedir(), 'git', 'gbrain')].filter(
        (c): c is string => !!c,
      );
  for (const c of candidates) {
    if (existsSync(join(c, 'src', 'cli.ts')) && existsSync(join(c, 'evals', 'brainbench', 'fixtures'))) {
      return c;
    }
  }
  return null;
}

export interface Cat34Options {
  /** Explicit gbrain checkout. When set, env/fallback resolution is skipped. */
  repo?: string;
  reportsDir?: string;
  includeHoldout?: boolean;
  /** Acknowledge a skip (no checkout) as exit 0. Default false: skip exits non-zero. */
  allowSkip?: boolean;
  quiet?: boolean;
}

export interface Cat34RunResult {
  receipt: Receipt;
  exitCode: number;
  receiptFile: string;
}

export async function runCat34(options: Cat34Options = {}): Promise<Cat34RunResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const reportDir = join(reportsDir, CAT34_CATEGORY);
  const receiptFile = receiptPath(CAT34_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);
  mkdirSync(reportDir, { recursive: true });

  const baseReceipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT34_CATEGORY,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
  } as const;

  const finishError = (errors: ProbeError[], data?: Record<string, unknown>): Cat34RunResult => {
    const receipt: Receipt = {
      ...baseReceipt,
      run_status: 'error',
      n_total: 0,
      n_scored: 0,
      completion_rate: 0,
      errors,
      publishable: false,
      finished_at: new Date().toISOString(),
      ...(data ? { data } : {}),
    };
    writeReceipt(receiptFile, receipt);
    log(`[cat34] ERROR: ${errors.map((e) => `${e.origin}: ${e.message}`).join(' | ')}\n`);
    return { receipt, exitCode: 2, receiptFile };
  };

  const repo = resolveGbrainRepo(options.repo);
  if (repo === null) {
    const skipReason =
      'no gbrain checkout with BrainBench found. Set GBRAIN_REPO to a checkout carrying ' +
      'src/cli.ts + evals/brainbench/ (requires the Cathedral 2 release, > v0.42.40.0).';
    const receipt: Receipt = {
      ...baseReceipt,
      run_status: 'skipped',
      skip_reason: skipReason,
      n_total: 0,
      n_scored: 0,
      completion_rate: 0,
      errors: [],
      publishable: false,
      finished_at: new Date().toISOString(),
    };
    writeReceipt(receiptFile, receipt);
    const exitCode = options.allowSkip ? 0 : 2;
    log(`[cat34] SKIPPED — ${skipReason} ${options.allowSkip ? '--allow-skip acknowledged.' : 'Exiting non-zero (pass --allow-skip to acknowledge).'}\n`);
    return { receipt, exitCode, receiptFile };
  }

  // ── Stale-artifact defenses (audit finding skillopt-cats-04) ─────────
  // eval/reports/ is gitignored and persists between runs; a result.json
  // left by an earlier run must never be graded as this run's output.
  //   1. purge the canonical artifact BEFORE spawning,
  //   2. have the subprocess write to a run-unique (nonced) path,
  //   3. verify the fresh file's mtime is not older than this run's start.
  const canonicalOut = join(reportDir, 'result.json');
  rmSync(canonicalOut, { force: true });
  const nonce = `${startedMs.toString(36)}-${process.pid.toString(36)}`;
  const outFile = join(reportDir, `result-${nonce}.json`);
  rmSync(outFile, { force: true });

  const includeHoldout = options.includeHoldout ?? false;
  const args = [
    'src/cli.ts', 'eval', 'brainbench',
    '--harness', 'all', '--suite', 'all',
    '--json', '--out', outFile,
    ...(includeHoldout ? ['--include-holdout'] : []),
  ];
  const subprocessEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of STRIPPED_ENV_KEYS) delete subprocessEnv[k];

  log(`[cat34] bun ${args.join(' ')}  (cwd ${repo})\n`);
  const proc = Bun.spawnSync(['bun', ...args], {
    cwd: repo,
    stdout: 'pipe',
    stderr: 'pipe',
    env: subprocessEnv as Record<string, string>,
  });
  const subExit = proc.exitCode ?? -1;
  const stderrTail = proc.stderr.toString().slice(-2000);

  // ── Fresh-result gate: missing fresh result is a HARNESS error ───────
  if (!existsSync(outFile)) {
    return finishError(
      [{
        probe_id: 'brainbench-subprocess',
        origin: 'harness',
        message: `no fresh result artifact at ${outFile} (subprocess exit ${subExit}): ${stderrTail.slice(0, 400)}`,
      }],
      { subprocess_exit: subExit, gbrain_repo: repo },
    );
  }
  const mtimeMs = statSync(outFile).mtimeMs;
  if (mtimeMs < startedMs - 2_000) {
    return finishError(
      [{
        probe_id: 'brainbench-subprocess',
        origin: 'harness',
        message: `result artifact predates this run (mtime ${new Date(mtimeMs).toISOString()} < start ${startedAt}) — refusing to grade a stale file`,
      }],
      { subprocess_exit: subExit, gbrain_repo: repo },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outFile, 'utf-8'));
  } catch (e) {
    return finishError(
      [{
        probe_id: 'brainbench-subprocess',
        origin: 'harness',
        message: `fresh result artifact is unparseable JSON: ${String((e as Error)?.message ?? e).slice(0, 300)}`,
      }],
      { subprocess_exit: subExit, gbrain_repo: repo },
    );
  }

  // ── Contract gate (audit finding skillopt-cats-10) ────────────────────
  const violations = validateResultDoc(parsed);
  if (violations.length > 0) {
    return finishError(
      [{
        probe_id: 'brainbench-subprocess',
        origin: 'dependency',
        message: `result schema mismatch (expected result_schema_version 1 per evals/brainbench/schema/result.schema.json): ${violations.join('; ')}`,
      }],
      { subprocess_exit: subExit, gbrain_repo: repo },
    );
  }
  const result = parsed as BrainBenchResultDoc;
  // Fresh + valid: promote the nonced file to the canonical artifact path.
  renameSync(outFile, canonicalOut);

  let sutGbrainVersion = 'unknown';
  try {
    sutGbrainVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf-8')).version ?? 'unknown';
  } catch {
    /* best-effort */
  }

  // ── Grade (the failable gate lives HERE — the subprocess exits 0 on
  // gold failures when no --compare is given) ───────────────────────────
  const missingSuites = EXPECTED_SUITES.filter((s) => !result.cells.some((c) => c.suite === s));
  const subprocessProbe = subExit !== 0 && result.seed_failures.length === 0;
  const nExpected =
    result.cells.length + missingSuites.length + result.seed_failures.length + (subprocessProbe ? 1 : 0);
  const acc = new ProbeAccounting(nExpected);
  for (const c of result.cells) {
    const id = `${c.harness}/${c.suite}`;
    if (c.gold_total <= 0) {
      // Zero gold checks: a vacuous cell must not count as pass — and it is
      // a rig/corpus problem, so it is infra-class (capped), not a miss.
      acc.error(id, 'harness', `cell has zero gold checks (vacuous, gold_total=${c.gold_total})`);
    } else if (c.gold_failed === 0) {
      acc.score(id, 1);
    } else {
      acc.error(id, 'sut', `gold_failed=${c.gold_failed}/${c.gold_total}`);
    }
  }
  for (const s of missingSuites) {
    acc.error(`suite:${s}`, 'sut', 'expected suite absent from result matrix (--suite all)');
  }
  for (const sf of result.seed_failures) {
    acc.error(`seed:${sf.fixture_id}`, 'sut', `fixture failed to seed: ${sf.error}`);
  }
  if (subprocessProbe) {
    acc.error('brainbench-subprocess', 'sut', `subprocess exit ${subExit} despite a parseable result doc: ${stderrTail.slice(0, 300)}`);
  }

  const summary = acc.summary();
  const allPass =
    result.cells.length > 0
    && summary.n_scored > 0
    && summary.errors.length === 0
    && acc.scoredValues().every((v) => v === 1);
  const verdict: 'pass' | 'fail' = allPass ? 'pass' : 'fail';
  const runInvalid = summary.run_invalid;

  const cellRows = result.cells.map((c) => ({
    cell: `${c.harness}/${c.suite}`,
    seam: c.seam,
    gold_failed: c.gold_failed,
    gold_total: c.gold_total,
    metrics: c.metrics,
  }));

  const receipt: Receipt = {
    ...baseReceipt,
    run_status: runInvalid ? 'error' : 'completed',
    ...(runInvalid ? {} : { verdict }),
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable,
    resolved_config: {
      gbrain_repo: repo,
      sut_gbrain_version: sutGbrainVersion,
      harness_sha: result.receipt.harness_sha,
      cmd: ['bun', ...args],
      include_holdout: result.receipt.include_holdout,
      llm: result.receipt.llm,
      env_keys_stripped: STRIPPED_ENV_KEYS,
      // Search config is subprocess-owned: BrainBench brings its own hermetic
      // in-memory PGLite. With provider keys stripped, the balanced-mode
      // zerank-2 reranker cannot silently enable.
      search_mode: 'subprocess-owned (BrainBench hermetic PGLite)',
      reranker_enabled: false,
      result_nonce: nonce,
    },
    hashes: { fixtures: result.receipt.fixtures_hash },
    finished_at: new Date().toISOString(),
    data: {
      subprocess_exit: subExit,
      cells: cellRows,
      seed_failures: result.seed_failures,
      missing_suites: missingSuites,
      result_artifact: canonicalOut,
    },
  };
  writeReceipt(receiptFile, receipt);

  // ── Human-readable scorecard (from the FRESH doc only) ───────────────
  const HEADLINE: Record<string, string> = {
    'know-to-ask': 'know_to_ask_failure_rate',
    push: 'push_recall',
    'write-back': 'write_back_fidelity',
    continuity: 'continuity_rate',
  };
  const lines: string[] = [
    '# Cat 34 — BrainBench memory conformance',
    '',
    `gbrain ${sutGbrainVersion} (\`${result.receipt.harness_sha.slice(0, 12)}\`) · fixtures \`${result.receipt.fixtures_hash.slice(0, 12)}\` · ${includeHoldout ? 'holdout INCLUDED' : 'gate mode'} · verdict ${runInvalid ? 'INVALID' : verdict} · subprocess exit ${subExit}`,
    '',
    '| harness | seam | suite | failed/gold | headline |',
    '|---|---|---|---|---|',
  ];
  for (const c of result.cells) {
    const h = HEADLINE[c.suite];
    const v = h && c.metrics[h] !== undefined ? `${h}=${c.metrics[h]}` : '—';
    lines.push(`| ${c.harness} | ${c.seam} | ${c.suite} | ${c.gold_failed}/${c.gold_total} | ${v} |`);
  }
  lines.push('');
  lines.push('Full per-turn rows in `result.json`; methodology: gbrain `docs/eval/BRAINBENCH.md`.');
  writeFileSync(join(reportDir, 'scorecard.md'), lines.join('\n') + '\n');

  const exitCode = runInvalid ? 2 : verdict === 'pass' ? 0 : 1;
  log(`[cat34] receipt + scorecard → ${reportDir} (run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'} exit ${exitCode})\n`);
  return { receipt, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const run = await runCat34({
      includeHoldout: process.argv.includes('--include-holdout'),
      allowSkip: process.argv.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    });
    process.exit(run.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT34_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT34_CATEGORY,
        run_status: 'error',
        n_total: 0,
        n_scored: 0,
        completion_rate: 0,
        errors: [{ probe_id: 'preflight', origin: 'harness', message: String(e?.message ?? e).slice(0, 500) }],
        publishable: false,
        gbrain_version: gbrainVersion(),
        gbrain_pin: gbrainPin(),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });
    } catch { /* receipt write failed too — exit code carries the failure */ }
    process.stderr.write(`[cat34] FATAL: ${e?.stack ?? e}\n`);
    process.exit(2);
  }
}
