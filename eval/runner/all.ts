/**
 * BrainBench — combined runner (Day 10 rewrite of the v1 Complete plan).
 *
 * Dispatches every shipping Cat runner and writes a unified markdown
 * report to `eval/reports/YYYY-MM-DD-brainbench.md`.
 *
 * **Shape:** each Cat runner exposes a CLI entry point and runs in its
 * own Bun subprocess (atomic, isolated PGLite engine per Cat, per-Cat
 * stdout/stderr captured intact). Subprocesses are dispatched concurrently
 * under `p-limit(2)` — max 2 in-flight at any time, which caps peak
 * memory around 800MB (≈400MB per PGLite instance).
 *
 * **Status source (WS0):** each Cat's status comes from its RECEIPT
 * (eval/reports/<script-stem>/receipt.json, validated, freshness-checked
 * against run start) when one exists; the exit code is only a crash
 * backstop for legacy runners. A receipt with run_status 'skipped' is
 * NEVER counted as pass, and skipped Cats fail the whole run unless
 * `BRAINBENCH_ALLOW_SKIP=1` explicitly acknowledges them.
 *
 * **Env vars passed through to every child:**
 *   - `BRAINBENCH_N` — run count per scorecard (1=smoke, 5=iteration,
 *     10=published). Honesty note: only runners that document BRAINBENCH_N
 *     support actually read it — it is NOT a universal work cap. CI bounds
 *     each runner with explicit per-job caps + timeouts instead.
 *   - `BRAINBENCH_LLM_CONCURRENCY` — max simultaneous Anthropic calls,
 *     read by `llm-budget.ts`.
 *   - `BRAINBENCH_ALLOW_SKIP` — set to 1 to let receipt-declared skips
 *     (missing keys/fixtures) not fail the aggregate run.
 *   - `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GROQ_API_KEY` — agent,
 *     judge, embedding, transcription credentials.
 *
 * **Not in the subprocess list (Cat 5, 8, 9):** these are programmatic
 * runners whose entry points need runtime inputs (claims, probes,
 * scenarios, pre-seeded state) that can't be passed via CLI flags. They
 * run from a harness that assembles those inputs; all.ts records their
 * status as "programmatic (see harness)".
 */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { basename, join } from 'path';
import { loadReceipt, receiptPath, type Receipt } from './receipt.ts';

// ─── Cat catalog ──────────────────────────────────────────────────────

interface SubprocessCategory {
  kind: 'subprocess';
  num: number;
  name: string;
  script: string;
  /** Bounded timeout per cat. Default 600s (10 min) — long enough for
   *  N=5 at moderate corpus sizes, short enough to surface hung runs. */
  timeoutMs?: number;
}

interface ProgrammaticCategory {
  kind: 'programmatic';
  num: number;
  name: string;
  reason: string;
}

type Category = SubprocessCategory | ProgrammaticCategory;

const CATEGORIES: readonly Category[] = [
  {
    kind: 'subprocess',
    num: 1,
    name: 'Before/After PR #188 (240-page rich corpus, relational queries)',
    script: 'eval/runner/before-after.ts',
  },
  {
    kind: 'subprocess',
    num: 2,
    name: 'Type Accuracy (per-link-type on rich prose)',
    script: 'eval/runner/type-accuracy.ts',
  },
  {
    kind: 'subprocess',
    num: 3,
    name: 'Identity Resolution',
    script: 'eval/runner/identity.ts',
  },
  {
    kind: 'subprocess',
    num: 4,
    name: 'Temporal Queries',
    script: 'eval/runner/temporal.ts',
  },
  {
    kind: 'programmatic',
    num: 5,
    name: 'Source Attribution / Provenance',
    reason:
      'Cat 5 needs a claim catalog (gold/citations.json) + Haiku judge. Run via eval/runner/cat5-provenance.ts\'s runCat5({claims, pagesBySlug, ...}) harness.',
  },
  {
    kind: 'subprocess',
    num: 6,
    name: 'Auto-link Precision under Prose',
    script: 'eval/runner/cat6-prose-scale.ts',
  },
  {
    kind: 'subprocess',
    num: 7,
    name: 'Performance / Latency',
    script: 'eval/runner/perf.ts',
  },
  {
    kind: 'programmatic',
    num: 8,
    name: 'Skill Behavior Compliance',
    reason:
      'Cat 8 needs a probe catalog + agent state. Run via eval/runner/cat8-skill-compliance.ts\'s runCat8({probes, state, ...}).',
  },
  {
    kind: 'programmatic',
    num: 9,
    name: 'End-to-End Workflows',
    reason:
      'Cat 9 needs a scenario catalog + gold pagesBySlug + agent state. Run via eval/runner/cat9-workflows.ts\'s runCat9({scenarios, state, pagesBySlug, ...}).',
  },
  {
    kind: 'subprocess',
    num: 10,
    name: 'Robustness / Adversarial',
    script: 'eval/runner/adversarial.ts',
  },
  {
    kind: 'subprocess',
    num: 11,
    name: 'Multi-modal Ingestion',
    script: 'eval/runner/cat11-multimodal.ts',
  },
  {
    kind: 'subprocess',
    num: 12,
    name: 'MCP Operation Contract',
    script: 'eval/runner/mcp-contract.ts',
  },
  {
    kind: 'subprocess',
    num: 34,
    name: 'BrainBench Memory Conformance (cross-harness: know-to-ask / push / write-back / continuity)',
    script: 'eval/runner/cat34-brainbench-memory.ts',
  },
  {
    kind: 'subprocess',
    num: 35,
    // Safe-by-default: without CAT35_FULL=1 the runner executes its cheap BPRE
    // smoke (2 transcripts, Haiku, measured ~$0.10) and the receipt carries
    // mode:'b-pre-validity' — sweep output must NOT be read as a published
    // result. Only a CAT35_FULL=1 receipt feeds the benchmark page. Note the
    // gbrain revision seam: Cat 34 resolves an external gbrain checkout while
    // Cat 35 runs the SHA pinned in package.json — when they differ, one
    // sweep report spans two gbrain revisions.
    name: 'Transcript → Brain-Page Distillation Fidelity (verbatim vs facts vs dream)',
    script: 'eval/runner/cat35-transcript-distill.ts',
    // 3h: worst-case dream lane alone is 24 × 600s subagent cap / 2 concurrency
    // = 7200s; a 2h cap could SIGTERM mid-scoring and discard every paid
    // verdict (the receipt writes at the end).
    timeoutMs: 10_800_000,
  },
];

interface CategoryRun {
  num: number;
  name: string;
  kind: 'subprocess' | 'programmatic';
  script?: string;
  status: 'pass' | 'fail' | 'skipped' | 'programmatic';
  /** Where the status came from: validated receipt, or legacy exit code. */
  statusSource: 'receipt' | 'exit-code' | 'n/a';
  statusNote?: string;
  output: string;
  exitCode: number;
  elapsedMs: number;
}

// ─── Receipt-driven status (WS0 outcome contract) ─────────────────────
//
// The receipt — not the exit code — is the source of truth. Exit codes
// remain only a crash backstop for runners that predate receipt adoption.
// This kills the class where a runner skipped everything, exited 0, and
// all.ts recorded PASS (audit finding retrieval-cats cat11).

/** Receipt directory convention: eval/reports/<script-stem>/receipt.json. */
function receiptSlugFor(script: string): string {
  return basename(script).replace(/\.ts$/, '');
}

/**
 * Derive a CategoryRun status from a receipt, guarding against stale
 * receipts left by previous runs (audit finding skillopt-cats cat34: a
 * subprocess that died before writing left last week's result to be read
 * as today's). A receipt older than the run start is ignored.
 */
export function deriveStatusFromReceipt(
  receipt: Receipt | null,
  exitCode: number,
): { status: 'pass' | 'fail' | 'skipped'; statusSource: 'receipt' | 'exit-code'; statusNote?: string } {
  if (receipt === null) {
    return {
      status: exitCode === 0 ? 'pass' : 'fail',
      statusSource: 'exit-code',
      statusNote: 'no fresh receipt — legacy exit-code status',
    };
  }
  switch (receipt.run_status) {
    case 'completed': {
      // 'partial' verdicts count as fail at the aggregate: a category either
      // meets its own bar or it does not.
      const pass = receipt.verdict === 'pass';
      return {
        status: pass ? 'pass' : 'fail',
        statusSource: 'receipt',
        statusNote: `verdict=${receipt.verdict}${receipt.publishable ? '' : ' (not publishable)'}`,
      };
    }
    case 'skipped':
      return { status: 'skipped', statusSource: 'receipt', statusNote: receipt.skip_reason };
    case 'error':
    case 'not_run':
      return { status: 'fail', statusSource: 'receipt', statusNote: `run_status=${receipt.run_status}` };
  }
}

function loadFreshReceipt(script: string, startedAtMs: number): Receipt | null {
  const path = receiptPath(receiptSlugFor(script));
  try {
    const mtime = statSync(path).mtimeMs;
    if (mtime < startedAtMs) return null; // stale — from a previous run
    return loadReceipt(path);
  } catch {
    return null;
  }
}

// ─── Subprocess dispatch with concurrency cap ─────────────────────────

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min

function runCatSubprocess(cat: SubprocessCategory): Promise<CategoryRun> {
  return new Promise(resolve => {
    const timeoutMs = cat.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    // eslint-disable-next-line no-console
    console.log(`  [start] Cat ${cat.num}: ${cat.name}`);

    let output = '';
    let settled = false;
    const child = spawn('bun', [cat.script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      // SIGKILL escalation: a hung PGLite worker can ignore SIGTERM and keep
      // its ~400MB resident while the rest of the suite runs (orchestrators-16).
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 10_000);
      killTimer.unref?.();
      const elapsed = Date.now() - started;
      output += `\n\n[TIMEOUT] Cat ${cat.num} exceeded ${timeoutMs}ms — SIGTERM sent (SIGKILL after 10s).`;
      resolve({
        num: cat.num,
        name: cat.name,
        kind: 'subprocess',
        script: cat.script,
        status: 'fail',
        statusSource: 'exit-code',
        statusNote: 'timeout',
        output,
        exitCode: 124,
        elapsedMs: elapsed,
      });
    }, timeoutMs);

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? 1;
      const elapsedMs = Date.now() - started;
      const receipt = loadFreshReceipt(cat.script, started);
      const derived = deriveStatusFromReceipt(receipt, exitCode);
      const lastLines = output.split('\n').slice(-3).join('\n').trim();
      // eslint-disable-next-line no-console
      console.log(
        `  [done ] Cat ${cat.num}: ${derived.status.toUpperCase()} [${derived.statusSource}] (${Math.round(elapsedMs / 1000)}s)  ${lastLines ? '— ' + lastLines.split('\n')[0] : ''}`,
      );
      resolve({
        num: cat.num,
        name: cat.name,
        kind: 'subprocess',
        script: cat.script,
        status: derived.status,
        statusSource: derived.statusSource,
        statusNote: derived.statusNote,
        output,
        exitCode,
        elapsedMs,
      });
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        num: cat.num,
        name: cat.name,
        kind: 'subprocess',
        script: cat.script,
        status: 'fail',
        statusSource: 'exit-code',
        statusNote: 'spawn error',
        output: output + `\n\nSPAWN ERROR: ${err.message}`,
        exitCode: 127,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

/**
 * Dispatch subprocess Cats with a bounded concurrency cap. Returns the
 * CategoryRun array in the same order as the input (not completion order).
 */
async function runConcurrently<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ─── Report rendering ─────────────────────────────────────────────────

async function readCommit(): Promise<string> {
  return new Promise(resolve => {
    const { execSync } = require('child_process');
    try {
      resolve(execSync('git rev-parse --short HEAD').toString().trim());
    } catch {
      resolve('unknown');
    }
  });
}

async function readBranch(): Promise<string> {
  return new Promise(resolve => {
    const { execSync } = require('child_process');
    try {
      resolve(execSync('git rev-parse --abbrev-ref HEAD').toString().trim());
    } catch {
      resolve('unknown');
    }
  });
}

async function buildReport(runs: CategoryRun[]): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const branch = await readBranch();
  const commit = await readCommit();
  const subprocess = runs.filter(r => r.kind === 'subprocess');
  const passed = subprocess.filter(r => r.status === 'pass').length;
  const failed = subprocess.filter(r => r.status === 'fail').length;
  const skipped = subprocess.filter(r => r.status === 'skipped').length;
  const programmatic = runs.filter(r => r.kind === 'programmatic').length;

  const lines: string[] = [];
  lines.push(`# BrainBench — ${date}`);
  lines.push('');
  lines.push(`**Branch:** ${branch}`);
  lines.push(`**Commit:** \`${commit}\``);
  lines.push(`**Engine:** PGLite (in-memory)`);
  lines.push(`**N:** ${process.env.BRAINBENCH_N ?? '5 (iteration default)'}`);
  lines.push(`**Concurrency:** ${process.env.BRAINBENCH_CONCURRENCY ?? DEFAULT_CONCURRENCY} subprocess slots, ${process.env.BRAINBENCH_LLM_CONCURRENCY ?? '4'} LLM slots`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(
    `${subprocess.length} subprocess Cats ran. ${passed} passed, ${failed} failed, ${skipped} SKIPPED (a skipped Cat is never a pass). ${programmatic} programmatic Cats run via harness.`,
  );
  lines.push('');

  lines.push('| # | Category | Kind | Status | Source | Elapsed | Notes |');
  lines.push('|---|----------|------|--------|--------|---------|-------|');
  for (const r of runs) {
    if (r.kind === 'subprocess') {
      const status = r.status === 'pass' ? '✓ pass' : r.status === 'skipped' ? '⤼ SKIPPED' : '✗ fail';
      const elapsed = `${Math.round(r.elapsedMs / 1000)}s`;
      const note = [r.statusNote, `\`${r.script}\``].filter(Boolean).join(' — ');
      lines.push(`| ${r.num} | ${r.name} | subprocess | ${status} | ${r.statusSource} | ${elapsed} | ${note} |`);
    } else {
      lines.push(`| ${r.num} | ${r.name} | programmatic | — | n/a | — | run via harness |`);
    }
  }
  lines.push('');

  // Embed each subprocess Cat's full output
  for (const r of runs) {
    if (r.kind !== 'subprocess') continue;
    lines.push('---');
    lines.push(`## Cat ${r.num}: ${r.name}`);
    lines.push('');
    lines.push(`**Status:** ${r.status === 'pass' ? '✓ PASS' : '✗ FAIL'} (exit ${r.exitCode}, ${Math.round(r.elapsedMs / 1000)}s)`);
    lines.push('');
    lines.push('```');
    // Trim migration noise
    const trimmed = r.output
      .split('\n')
      .filter(l => !/^\s*\d+ migration\(s\) applied$/.test(l))
      .filter(l => !/^\s*Migration \d+ applied/.test(l))
      .join('\n');
    lines.push(trimmed);
    lines.push('```');
    lines.push('');
  }

  // Programmatic-only Cats section
  const progs = runs.filter(r => r.kind === 'programmatic');
  if (progs.length > 0) {
    lines.push('---');
    lines.push('## Programmatic-only Cats');
    lines.push('');
    lines.push(
      'These Cats have no subprocess CLI entry — they require runtime inputs (probes, claims, scenarios, pre-seeded state) that must be composed from a harness. Run them from a test or a runtime script that imports the corresponding `runCatN` function.',
    );
    lines.push('');
    for (const p of progs) {
      lines.push(`- **Cat ${p.num}: ${p.name}** — ${p.output}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('## How to reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push('# Full scorecard (N=5 default iteration run)');
  lines.push('bun run eval:brainbench');
  lines.push('');
  lines.push('# Smoke mode (N=1, fast)');
  lines.push('BRAINBENCH_N=1 bun run eval:brainbench');
  lines.push('');
  lines.push('# Published baseline (N=10, ~$200 Opus)');
  lines.push('BRAINBENCH_N=10 bun run eval:brainbench');
  lines.push('');
  lines.push('# Individual subprocess Cats');
  for (const c of CATEGORIES) {
    if (c.kind === 'subprocess') lines.push(`bun ${c.script}`);
  }
  lines.push('```');
  lines.push('');
  lines.push(
    'Subprocess Cats run concurrently at `--concurrency 2` by default (set via `BRAINBENCH_CONCURRENCY`). Programmatic Cats (5, 8, 9) are omitted from `all.ts` because they need runtime inputs; invoke them from a harness.',
  );

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const subprocessCats = CATEGORIES.filter(
    (c): c is SubprocessCategory => c.kind === 'subprocess',
  );
  const concurrency = parseInt(
    process.env.BRAINBENCH_CONCURRENCY ?? String(DEFAULT_CONCURRENCY),
    10,
  );

  // eslint-disable-next-line no-console
  console.log(`BrainBench dispatch starting: ${subprocessCats.length} subprocess Cats, concurrency=${concurrency}`);

  const subprocessRuns = await runConcurrently(
    subprocessCats,
    Number.isFinite(concurrency) && concurrency > 0 ? concurrency : DEFAULT_CONCURRENCY,
    runCatSubprocess,
  );

  const programmaticRuns: CategoryRun[] = CATEGORIES
    .filter((c): c is ProgrammaticCategory => c.kind === 'programmatic')
    .map(c => ({
      num: c.num,
      name: c.name,
      kind: 'programmatic' as const,
      status: 'programmatic' as const,
      statusSource: 'n/a' as const,
      output: c.reason,
      exitCode: 0,
      elapsedMs: 0,
    }));

  const allRuns: CategoryRun[] = [...subprocessRuns, ...programmaticRuns].sort((a, b) => a.num - b.num);

  const reportDir = 'eval/reports';
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = join(reportDir, `${date}-brainbench.md`);
  writeFileSync(reportPath, await buildReport(allRuns));

  // eslint-disable-next-line no-console
  console.log(`\nReport written to ${reportPath}`);
  const skippedRuns = subprocessRuns.filter(r => r.status === 'skipped');
  // eslint-disable-next-line no-console
  console.log(
    `${subprocessRuns.filter(r => r.status === 'pass').length}/${subprocessRuns.length} subprocess Cats passed` +
      (skippedRuns.length > 0 ? `, ${skippedRuns.length} SKIPPED (${skippedRuns.map(r => `Cat ${r.num}`).join(', ')})` : '') + '.',
  );

  // Exit policy (WS0): failures always fail the run. Skips also fail it
  // unless explicitly acknowledged — a benchmark that silently shrinks is
  // how the cat11 always-pass bug shipped. Set BRAINBENCH_ALLOW_SKIP=1 to
  // acknowledge expected skips (e.g. keyless environments).
  const allowSkip = process.env.BRAINBENCH_ALLOW_SKIP === '1';
  if (subprocessRuns.some(r => r.status === 'fail')) process.exit(1);
  if (skippedRuns.length > 0 && !allowSkip) {
    // eslint-disable-next-line no-console
    console.error('Skipped Cats present and BRAINBENCH_ALLOW_SKIP is not set — failing the run.');
    process.exit(2);
  }
}

if (import.meta.main) {
  main().catch(e => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}

// Exports for tests + harnesses that want to invoke individual pieces.
export { CATEGORIES, runCatSubprocess, runConcurrently, buildReport };
export type { Category, SubprocessCategory, ProgrammaticCategory, CategoryRun };
