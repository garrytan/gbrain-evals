/**
 * BrainBench combined runner.
 *
 * Lists EVERY category in the repository and dispatches the ones in the
 * selected tier, then writes a unified markdown report to
 * `eval/reports/YYYY-MM-DD-brainbench.md` that also names every category it
 * did not run and why (C-09, audit 2026-09-28).
 *
 *   bun eval/runner/all.ts                 # --tier offline (default, keyless)
 *   bun eval/runner/all.ts --tier paid     # provider-backed runners only
 *   bun eval/runner/all.ts --tier all      # both
 *
 * **Shape:** each dispatched runner runs in its own Bun subprocess (isolated
 * PGLite engine, stdout/stderr captured). Subprocesses run concurrently
 * under a small cap (BRAINBENCH_CONCURRENCY, default 2). Latency
 * benchmarks are `exclusive`: they run alone, after the concurrent pool has
 * drained, so their timings do not measure contention (C-11).
 *
 * **Status source (WS0):** every dispatched runner must write a fresh,
 * valid receipt (eval/reports/<script-stem>/receipt.json, or the fresh
 * --output directory for runners that take one). The receipt is the only
 * source of a pass:
 *   - no fresh receipt → FAIL (C-06); the exit code is never read as a pass,
 *   - a receipt that exists but fails validation → FAIL with the reason (C-07),
 *   - run_status 'skipped' → SKIPPED, never pass; skips fail the whole run
 *     unless `BRAINBENCH_ALLOW_SKIP=1` acknowledges them,
 *   - a completed receipt passes only with verdict 'pass'.
 *
 * **Env vars passed through to every child:**
 *   - `BRAINBENCH_N`: read ONLY by multi-adapter.ts (paid tier). No other
 *     dispatched runner reads it; it is not a universal work cap.
 *   - `BRAINBENCH_LLM_CONCURRENCY`: max simultaneous Anthropic calls,
 *     read by `llm-budget.ts`.
 *   - `BRAINBENCH_ALLOW_SKIP`: set to 1 to let receipt-declared skips
 *     (missing keys/fixtures) not fail the aggregate run.
 *   - Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`,
 *     `GROQ_API_KEY`): used by paid-tier runners.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { basename, join } from 'path';
import { loadReceipt, receiptPath, type Receipt } from './receipt.ts';

// ─── Category registry ───────────────────────────────────────────────

export type Tier = 'offline' | 'paid';
export type TierSelection = Tier | 'all';

interface DispatchedCategory {
  kind: 'dispatched';
  id: string;
  name: string;
  tier: Tier;
  script: string;
  args?: string[];
  env?: Record<string, string>;
  /** Runner takes a fresh output directory via this flag; the receipt is read from there. */
  outputFlag?: string;
  /** Bounded timeout per category. Default 600s. */
  timeoutMs?: number;
  /** Latency benchmark: runs alone, never alongside another category. */
  exclusive?: boolean;
}

interface ListedCategory {
  kind: 'listed';
  id: string;
  name: string;
  /** What running it would need; 'none' when it cannot run at all today. */
  tier: Tier | 'none';
  reason: string;
  command?: string;
}

type Category = DispatchedCategory | ListedCategory;

const HOUR = 3_600_000;

const CATEGORIES: readonly Category[] = [
  { kind: 'dispatched', id: '1', tier: 'offline', name: 'Relational retrieval before/after graph traversal (world-v1)', script: 'eval/runner/before-after.ts' },
  { kind: 'dispatched', id: '2', tier: 'offline', name: 'Link type accuracy (world-v1)', script: 'eval/runner/type-accuracy.ts' },
  { kind: 'dispatched', id: '3', tier: 'offline', name: 'Identity resolution through keyword search', script: 'eval/runner/identity.ts' },
  { kind: 'dispatched', id: '4', tier: 'offline', name: 'Timeline storage round-trip', script: 'eval/runner/temporal.ts' },
  {
    kind: 'listed', id: '5', tier: 'none', name: 'Source attribution / provenance',
    reason: 'not implemented: no reviewed claim catalog exists (gold/citations.json is a one-claim template), and the runner has no gbrain in the loop',
  },
  { kind: 'dispatched', id: '6', tier: 'offline', name: 'Auto-link precision under prose', script: 'eval/runner/cat6-prose-scale.ts' },
  { kind: 'dispatched', id: '7', tier: 'offline', name: 'Performance / latency', script: 'eval/runner/perf.ts', exclusive: true },
  {
    kind: 'listed', id: '8', tier: 'none', name: 'Skill behavior compliance',
    reason: 'not implemented: no reviewed probe catalog in the repository',
  },
  {
    kind: 'listed', id: '9', tier: 'none', name: 'End-to-end workflows',
    reason: 'not implemented: no reviewed scenario catalog in the repository',
  },
  { kind: 'dispatched', id: '10', tier: 'offline', name: 'Robustness / adversarial input', script: 'eval/runner/adversarial.ts' },
  { kind: 'dispatched', id: '11', tier: 'offline', name: 'Text ingestion fidelity (md/html; audio needs a key)', script: 'eval/runner/cat11-multimodal.ts' },
  { kind: 'dispatched', id: '12', tier: 'offline', name: 'MCP operation contract', script: 'eval/runner/mcp-contract.ts' },
  { kind: 'dispatched', id: '13', tier: 'paid', name: 'Conceptual search (live embeddings)', script: 'eval/runner/cat13-conceptual.ts', timeoutMs: 2 * HOUR },
  { kind: 'dispatched', id: '13b', tier: 'paid', name: 'Source swamp: curated notes vs bulk chat (live embeddings)', script: 'eval/runner/cat13b-source-swamp.ts', timeoutMs: HOUR },
  {
    kind: 'listed', id: '13b-sit', tier: 'paid', name: 'Situation recall on Cat 13b (memory-cue arms)',
    reason: 'release protocol run, not a sweep category; needs the memory-cue build and an explicit protocol',
    command: 'bun eval/runner/situation-recall-cat13b.ts',
  },
  { kind: 'dispatched', id: '14', tier: 'paid', name: 'Calibration A/B of think (live model and judge)', script: 'eval/runner/cat14-calibration.ts', timeoutMs: HOUR },
  { kind: 'dispatched', id: '15', tier: 'paid', name: 'propose_takes extraction (live model)', script: 'eval/runner/cat15-propose-takes.ts', timeoutMs: HOUR },
  {
    kind: 'listed', id: '18', tier: 'none', name: 'Embedding providers',
    reason: 'dead: the default provider set includes ZeroEntropy, which was shut down on 2026-09-04',
    command: 'bun eval/runner/cat18-embedding-providers.ts',
  },
  {
    kind: 'listed', id: '18b', tier: 'none', name: 'Embedder x reranker matrix',
    reason: 'dead: four of six cells use ZeroEntropy, which was shut down on 2026-09-04',
    command: 'bun eval/runner/cat18b-embedding-rerank-matrix.ts',
  },
  { kind: 'dispatched', id: '19', tier: 'offline', name: 'Sick-brain remediation loop (hash embeddings)', script: 'eval/runner/cat19-doctor-remediate.ts' },
  { kind: 'dispatched', id: '20', tier: 'paid', name: 'Brainstorm grounding (live model and judge)', script: 'eval/runner/cat20-brainstorm.ts', timeoutMs: HOUR },
  { kind: 'dispatched', id: '21', tier: 'paid', name: 'Code retrieval (live embeddings)', script: 'eval/runner/cat21-code-retrieval.ts', timeoutMs: HOUR },
  { kind: 'dispatched', id: '22', tier: 'offline', name: 'Source isolation', script: 'eval/runner/cat22-source-isolation.ts' },
  { kind: 'dispatched', id: '23', tier: 'offline', name: 'Phantom to canonical redirect', script: 'eval/runner/cat23-phantom-redirect.ts' },
  { kind: 'dispatched', id: '24', tier: 'offline', name: 'Capture provenance', script: 'eval/runner/cat24-capture-provenance.ts' },
  { kind: 'dispatched', id: '25', tier: 'paid', name: 'Trajectory routing in think (live model)', script: 'eval/runner/cat25-trajectory-routing.ts', timeoutMs: HOUR },
  { kind: 'dispatched', id: '26', tier: 'paid', name: 'Contextual retrieval modes (live embeddings)', script: 'eval/runner/cat26-contextual-retrieval.ts', timeoutMs: HOUR },
  { kind: 'dispatched', id: '27', tier: 'offline', name: 'Graph signals on/off', script: 'eval/runner/cat27-graph-signals.ts' },
  { kind: 'dispatched', id: '28', tier: 'offline', name: 'Federated sync latency', script: 'eval/runner/cat28-federated-sync-latency.ts', exclusive: true },
  { kind: 'dispatched', id: '29', tier: 'paid', name: 'think vs raw search payload (live model and judge)', script: 'eval/runner/cat29-think-vs-search.ts', timeoutMs: HOUR },
  {
    kind: 'listed', id: '30-33', tier: 'paid', name: 'SkillOpt improvement, ablation, reward hacking, transfer',
    reason: 'multi-hour paid optimizer runs; dispatched by their own script',
    command: 'bash eval/runner/run-skillopt-cats.sh',
  },
  { kind: 'dispatched', id: '34', tier: 'offline', name: 'BrainBench memory conformance (external gbrain checkout)', script: 'eval/runner/cat34-brainbench-memory.ts' },
  {
    kind: 'dispatched', id: '35', tier: 'paid', name: 'Transcript to brain-page distillation fidelity (full mode)',
    script: 'eval/runner/cat35-transcript-distill.ts', env: { CAT35_FULL: '1' },
    // Worst-case dream lane alone is 24 x 600s subagent cap / 2 concurrency.
    timeoutMs: 3 * HOUR,
  },
  {
    kind: 'dispatched', id: '36', tier: 'offline', name: 'Associative retrieval (offline keyword plumbing only; not capability evidence)',
    script: 'eval/runner/cat36-associative-retrieval.ts', args: ['--offline', '--smoke'], outputFlag: '--output', timeoutMs: 180_000,
  },
  {
    kind: 'listed', id: '36-live', tier: 'paid', name: 'Associative retrieval (live cue arms)',
    reason: 'needs an approved provider budget profile and the memory-cue build',
    command: 'bun eval/runner/cat36-associative-retrieval.ts --profile <approved-profile.json>',
  },
  { kind: 'dispatched', id: 'multi-adapter', tier: 'paid', name: 'Multi-adapter relational, fuzzy and external query families', script: 'eval/runner/multi-adapter.ts', timeoutMs: 2 * HOUR },
  { kind: 'dispatched', id: 'relational-ab', tier: 'paid', name: 'Relational retrieval off vs on', script: 'eval/runner/relational-ab.ts', outputFlag: '--output-dir', timeoutMs: 2 * HOUR },
  { kind: 'dispatched', id: 'precisionmembench', tier: 'paid', name: 'PrecisionMemBench', script: 'eval/runner/precisionmembench.ts', timeoutMs: 2 * HOUR },
  {
    kind: 'listed', id: 'longmemeval', tier: 'paid', name: 'LongMemEval retrieval',
    reason: 'needs the downloaded LongMemEval dataset path and a multi-hour batch',
    command: 'bash eval/runner/longmemeval-batch.sh --dataset <longmemeval_s_cleaned.json>',
  },
  {
    kind: 'listed', id: 'longmemeval-answers', tier: 'paid', name: 'LongMemEval answer grounding check',
    reason: 'needs a retained LongMemEval evidence stream from a retrieval run',
    command: 'bun eval/runner/longmemeval-answers.ts',
  },
  {
    kind: 'listed', id: 'longmemeval-m-pilot', tier: 'paid', name: 'LongMemEval-M paired pilot',
    reason: 'preregistered paid protocol with frozen package identities; run by its own scripts',
    command: 'bun eval/runner/longmemeval-m-pilot-live.ts',
  },
  {
    kind: 'listed', id: 'reading-notes', tier: 'paid', name: 'Reading notes reader A/B',
    reason: 'paid protocol with frozen request payloads; the offline recount runs in bun run test',
    command: 'bun eval/runner/reading-notes-run.ts',
  },
  {
    kind: 'listed', id: 'situation-recall', tier: 'paid', name: 'Situation-recall release comparator',
    reason: 'release protocol, run against registered baselines rather than as a sweep category',
    command: 'bun eval/runner/situation-recall-orchestration.ts',
  },
  {
    kind: 'listed', id: 'shootout', tier: 'paid', name: 'Embedder x reranker shootout cell',
    reason: 'single-cell driver parameterized per run',
    command: 'bun eval/runner/shootout-driver.ts',
  },
  {
    kind: 'listed', id: 'qrels', tier: 'offline', name: 'qrels / baseline regression fixture',
    reason: 'checked in CI; the corpus is synthesized from the queries, so it is a regression smoke only',
    command: 'bun scripts/generate-v0.41-launch.ts --check',
  },
];

interface CategoryRun {
  id: string;
  name: string;
  tier: Tier;
  script: string;
  status: 'pass' | 'fail' | 'skipped';
  statusSource: 'receipt' | 'no-receipt' | 'timeout' | 'spawn-error';
  statusNote?: string;
  output: string;
  exitCode: number;
  elapsedMs: number;
}

interface NotRun {
  id: string;
  name: string;
  tier: Tier | 'none';
  reason: string;
  command?: string;
}

export function parseTier(argv: string[]): TierSelection {
  const i = argv.indexOf('--tier');
  if (i < 0) return 'offline';
  const value = argv[i + 1];
  if (value === 'offline' || value === 'paid' || value === 'all') return value;
  throw new Error(`--tier must be offline, paid or all (got ${JSON.stringify(value)})`);
}

/** Split the registry into what runs in this tier and what does not, with a reason for each omission. */
export function selectCategories(tier: TierSelection): { dispatch: DispatchedCategory[]; notRun: NotRun[] } {
  const dispatch: DispatchedCategory[] = [];
  const notRun: NotRun[] = [];
  for (const c of CATEGORIES) {
    if (c.kind === 'listed') {
      notRun.push({ id: c.id, name: c.name, tier: c.tier, reason: c.reason, command: c.command });
    } else if (tier === 'all' || c.tier === tier) {
      dispatch.push(c);
    } else {
      notRun.push({ id: c.id, name: c.name, tier: c.tier, reason: `tier ${c.tier} not selected`, command: `bun ${[c.script, ...(c.args ?? [])].join(' ')}` });
    }
  }
  return { dispatch, notRun };
}

// ─── Receipt-driven status (WS0 outcome contract) ─────────────────────

/** Receipt directory convention: eval/reports/<script-stem>/receipt.json. */
function receiptSlugFor(script: string): string {
  return basename(script).replace(/\.ts$/, '');
}

export type ReceiptLoad =
  | { kind: 'ok'; receipt: Receipt }
  | { kind: 'missing' }
  | { kind: 'stale'; mtime: string }
  | { kind: 'invalid'; reason: string };

/**
 * Read the receipt a runner wrote during this sweep. Only a missing file is
 * "missing"; any read, parse or validation failure is "invalid" (C-07). A
 * receipt older than the run start is "stale" and never graded.
 */
export function loadFreshReceipt(path: string, startedAtMs: number): ReceiptLoad {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', reason: String((e as Error).message ?? e) };
  }
  if (mtimeMs < startedAtMs) return { kind: 'stale', mtime: new Date(mtimeMs).toISOString() };
  try {
    return { kind: 'ok', receipt: loadReceipt(path) };
  } catch (e) {
    return { kind: 'invalid', reason: String((e as Error).message ?? e) };
  }
}

/** Every dispatched runner must produce a fresh valid receipt; nothing else counts as a pass. */
export function deriveStatus(load: ReceiptLoad): { status: 'pass' | 'fail' | 'skipped'; statusSource: 'receipt' | 'no-receipt'; statusNote: string } {
  if (load.kind === 'missing') return { status: 'fail', statusSource: 'no-receipt', statusNote: 'no receipt written by this run' };
  if (load.kind === 'stale') return { status: 'fail', statusSource: 'no-receipt', statusNote: `stale receipt from ${load.mtime}; this run wrote none` };
  if (load.kind === 'invalid') return { status: 'fail', statusSource: 'receipt', statusNote: `invalid receipt: ${load.reason}` };
  const receipt = load.receipt;
  switch (receipt.run_status) {
    case 'completed':
      // 'partial' verdicts count as fail at the aggregate: a category either
      // meets its own bar or it does not.
      return {
        status: receipt.verdict === 'pass' ? 'pass' : 'fail',
        statusSource: 'receipt',
        statusNote: `verdict=${receipt.verdict}${receipt.publishable ? '' : ' (not publishable)'}`,
      };
    case 'skipped':
      return { status: 'skipped', statusSource: 'receipt', statusNote: receipt.skip_reason ?? 'skipped' };
    case 'error':
    case 'not_run':
      return { status: 'fail', statusSource: 'receipt', statusNote: `run_status=${receipt.run_status}` };
  }
}

// ─── Subprocess dispatch ──────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 600_000;

function runCatSubprocess(cat: DispatchedCategory): Promise<CategoryRun> {
  return new Promise(resolve => {
    const timeoutMs = cat.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    const outputDir = cat.outputFlag ? join('eval/reports', receiptSlugFor(cat.script), `sweep-${randomUUID()}`) : undefined;
    const receiptFile = outputDir ? join(outputDir, 'receipt.json') : receiptPath(receiptSlugFor(cat.script));
    // eslint-disable-next-line no-console
    console.log(`  [start] Cat ${cat.id}: ${cat.name}`);

    let output = '';
    let settled = false;
    const base = { id: cat.id, name: cat.name, tier: cat.tier, script: cat.script };
    const child = spawn('bun', [cat.script, ...(cat.args ?? []), ...(outputDir ? [cat.outputFlag!, outputDir] : [])], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(cat.env ?? {}) },
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
      output += `\n\n[TIMEOUT] Cat ${cat.id} exceeded ${timeoutMs}ms: SIGTERM sent (SIGKILL after 10s).`;
      resolve({ ...base, status: 'fail', statusSource: 'timeout', statusNote: 'timeout', output, exitCode: 124, elapsedMs: Date.now() - started });
    }, timeoutMs);

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsedMs = Date.now() - started;
      const exitCode = code ?? -1;
      const derived = deriveStatus(loadFreshReceipt(receiptFile, started));
      // eslint-disable-next-line no-console
      console.log(`  [done ] Cat ${cat.id}: ${derived.status.toUpperCase()} [${derived.statusSource}] (${Math.round(elapsedMs / 1000)}s) ${derived.statusNote}`);
      resolve({ ...base, ...derived, output, exitCode, elapsedMs });
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...base, status: 'fail', statusSource: 'spawn-error', statusNote: 'spawn error', output: output + `\n\nSPAWN ERROR: ${err.message}`, exitCode: 127, elapsedMs: Date.now() - started });
    });
  });
}

/**
 * Run items with a bounded concurrency cap. Returns results in input order
 * (not completion order).
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

/**
 * Shared categories run under the concurrency cap; exclusive ones then run
 * one at a time with nothing else in flight. Results keep input order.
 */
export async function runSchedule<T extends { exclusive?: boolean }, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const shared = items.map((item, i) => ({ item, i })).filter(x => !x.item.exclusive);
  const exclusive = items.map((item, i) => ({ item, i })).filter(x => x.item.exclusive);
  const results: R[] = new Array(items.length);
  const sharedResults = await runConcurrently(shared.map(x => x.item), concurrency, fn);
  shared.forEach((x, k) => { results[x.i] = sharedResults[k]; });
  for (const x of exclusive) results[x.i] = await fn(x.item);
  return results;
}

// ─── Report rendering ─────────────────────────────────────────────────

function git(args: string): string {
  const { execSync } = require('child_process');
  try {
    return execSync(`git ${args}`).toString().trim();
  } catch {
    return 'unknown';
  }
}

const STATUS_LABEL: Record<CategoryRun['status'], string> = { pass: '✓ PASS', fail: '✗ FAIL', skipped: '⤼ SKIPPED' };

function buildReport(tier: TierSelection, runs: CategoryRun[], notRun: NotRun[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const passed = runs.filter(r => r.status === 'pass').length;
  const failed = runs.filter(r => r.status === 'fail').length;
  const skipped = runs.filter(r => r.status === 'skipped').length;

  const lines: string[] = [];
  lines.push(`# BrainBench: ${date}`);
  lines.push('');
  lines.push(`**Tier:** ${tier}`);
  lines.push(`**Branch:** ${git('rev-parse --abbrev-ref HEAD')}`);
  lines.push(`**Commit:** \`${git('rev-parse --short HEAD')}\``);
  lines.push(`**Engine:** PGLite (in-memory)`);
  lines.push(`**BRAINBENCH_N:** ${process.env.BRAINBENCH_N ?? 'unset'} (read only by multi-adapter.ts)`);
  lines.push(`**Concurrency:** ${process.env.BRAINBENCH_CONCURRENCY ?? DEFAULT_CONCURRENCY} subprocess slots; exclusive latency categories run alone`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(
    `${runs.length} of ${CATEGORIES.length} listed categories ran in tier "${tier}": ${passed} passed, ${failed} failed, ${skipped} skipped (a skipped category is never a pass). ${notRun.length} were not run; they are listed below with the reason.`,
  );
  lines.push('');

  lines.push('| Cat | Category | Tier | Status | Source | Elapsed | Notes |');
  lines.push('|---|----------|------|--------|--------|---------|-------|');
  for (const r of runs) {
    const note = [r.statusNote, `\`${r.script}\``].filter(Boolean).join(': ');
    lines.push(`| ${r.id} | ${r.name} | ${r.tier} | ${STATUS_LABEL[r.status]} | ${r.statusSource} | ${Math.round(r.elapsedMs / 1000)}s | ${note} |`);
  }
  lines.push('');

  lines.push('## Not run in this invocation');
  lines.push('');
  lines.push('| Cat | Category | Needs | Reason | Command |');
  lines.push('|---|----------|-------|--------|---------|');
  for (const n of notRun) {
    lines.push(`| ${n.id} | ${n.name} | ${n.tier} | ${n.reason} | ${n.command ? `\`${n.command}\`` : ''} |`);
  }
  lines.push('');

  for (const r of runs) {
    lines.push('---');
    lines.push(`## Cat ${r.id}: ${r.name}`);
    lines.push('');
    lines.push(`**Status:** ${STATUS_LABEL[r.status]} (${r.statusSource}; exit ${r.exitCode}, ${Math.round(r.elapsedMs / 1000)}s)`);
    lines.push('');
    lines.push('```');
    lines.push(
      r.output
        .split('\n')
        .filter(l => !/^\s*\d+ migration\(s\) applied$/.test(l))
        .filter(l => !/^\s*Migration \d+ applied/.test(l))
        .join('\n'),
    );
    lines.push('```');
    lines.push('');
  }

  lines.push('---');
  lines.push('## How to reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push('bun eval/runner/all.ts --tier offline   # keyless categories');
  lines.push('bun eval/runner/all.ts --tier paid      # provider-backed categories (spends money)');
  lines.push('bun eval/runner/all.ts --tier all');
  lines.push('```');

  return lines.join('\n');
}

export function printNotRun(notRun: NotRun[], log: (s: string) => void = console.log): void {
  log(`Not run in this invocation (${notRun.length}):`);
  for (const n of notRun) log(`  - Cat ${n.id} (${n.name}): ${n.reason}`);
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const tier = parseTier(process.argv.slice(2));
  const { dispatch, notRun } = selectCategories(tier);
  const concurrency = parseInt(process.env.BRAINBENCH_CONCURRENCY ?? String(DEFAULT_CONCURRENCY), 10);

  // eslint-disable-next-line no-console
  console.log(`BrainBench tier "${tier}": dispatching ${dispatch.length} of ${CATEGORIES.length} categories, concurrency=${concurrency}`);
  printNotRun(notRun);

  const runs = await runSchedule(
    dispatch,
    Number.isFinite(concurrency) && concurrency > 0 ? concurrency : DEFAULT_CONCURRENCY,
    runCatSubprocess,
  );

  const reportDir = 'eval/reports';
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${new Date().toISOString().slice(0, 10)}-brainbench.md`);
  writeFileSync(reportPath, buildReport(tier, runs, notRun));

  const skippedRuns = runs.filter(r => r.status === 'skipped');
  // eslint-disable-next-line no-console
  console.log(`\nReport written to ${reportPath}`);
  // eslint-disable-next-line no-console
  console.log(
    `${runs.filter(r => r.status === 'pass').length}/${runs.length} dispatched categories passed` +
      (skippedRuns.length > 0 ? `, ${skippedRuns.length} SKIPPED (${skippedRuns.map(r => `Cat ${r.id}`).join(', ')})` : '') +
      `; ${notRun.length} not run.`,
  );
  printNotRun(notRun);

  // Exit policy (WS0): failures always fail the run. Skips also fail it
  // unless explicitly acknowledged with BRAINBENCH_ALLOW_SKIP=1.
  if (runs.some(r => r.status === 'fail')) process.exit(1);
  if (skippedRuns.length > 0 && process.env.BRAINBENCH_ALLOW_SKIP !== '1') {
    // eslint-disable-next-line no-console
    console.error('Skipped categories present and BRAINBENCH_ALLOW_SKIP is not set: failing the run.');
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

export { CATEGORIES, runCatSubprocess, runConcurrently, buildReport };
export type { Category, DispatchedCategory, ListedCategory, CategoryRun, NotRun };
