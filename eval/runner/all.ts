/**
 * BrainBench combined runner.
 *
 * Lists EVERY category in the repository and dispatches the ones in the
 * selected tier, then writes a unified markdown report to
 * `eval/reports/YYYY-MM-DD-brainbench.md` that also names every category it
 * did not run and why (C-09, audit 2026-09-28).
 *
 *   bun eval/runner/all.ts                 # --tier offline (default, keyless)
 *   bun eval/runner/all.ts --tier paid --paid --budget-run-id <id>   # provider-backed runners only
 *   bun eval/runner/all.ts --tier all --paid --budget-run-id <id>    # both
 *   bun eval/runner/all.ts --only N3,entity-resolution               # a subset (ids or legacy aliases)
 *
 * **Paid guard:** a selection that includes any K or P category refuses to
 * start without both `--paid` and `--budget-run-id <id>` naming an open run
 * in the budget ledger (eval/runner/paid-arm.ts). The id reaches every child
 * as BRAINBENCH_BUDGET_RUN_ID, so runners that use startPaidRun join it.
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
 *   - a completed receipt passes only with verdict 'pass'; a report-only
 *     category (registry gate) with another verdict is REPORTED, never a
 *     pass and never a failure of the run.
 *
 * **Promotion rules (amendment 1, 2026-10-01):** a completed receipt is
 * graded against the category's preregistered promotion rules in
 * eval/registry.ts: every safety contract and quality threshold must hold.
 * The runner's verdict gates only when a rule names it (RUNNER_VERDICT), so a
 * category can gate on zero leaks while its recall stays exploratory. A
 * category with no gating rule is report-only.
 *
 * **Promotion rules (amendment 1, 2026-10-01):** a completed receipt is
 * graded against the category's preregistered promotion rules in
 * eval/registry.ts: every safety contract and quality threshold must hold.
 * The runner's verdict gates only when a rule names it (RUNNER_VERDICT).
 * A category with no gating rule, or whose rules are held while a gbrain fix
 * is pending, is report-only.
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
import { REGISTRY, registryEntry, tiersFor, type CategoryEntry, type GateStatus, type PromotionRules, type RegistryTier, type TierSelection } from '../registry.ts';
import { PaidArmRefusal, requirePaidArm } from './paid-arm.ts';
import { describeOutcome, evaluatePromotion } from './promotion.ts';

// ─── Category registry ───────────────────────────────────────────────
// The rows live in eval/registry.ts. all.ts keeps each row's legacy alias
// as its display id ("Cat 13b") and maps registry tiers onto the older
// offline/paid names: H is offline, K and P are paid.

export type Tier = 'offline' | 'paid';
export type { TierSelection };

interface DispatchedCategory {
  kind: 'dispatched';
  id: string;
  registryId: string;
  name: string;
  tier: Tier;
  registryTier: RegistryTier;
  script: string;
  args?: string[];
  env?: Record<string, string>;
  /** Runner takes a fresh output directory via this flag; the receipt is read from there. */
  outputFlag?: string;
  /** Bounded timeout per category. Default 600s. */
  timeoutMs?: number;
  /** Latency benchmark: runs alone, never alongside another category. */
  exclusive?: boolean;
  /** report-only: a completed non-pass verdict is reported, not failed (registry gate). */
  gate: GateStatus;
  /** Preregistered promotion rules; all.ts gates on these when present. */
  promotion?: PromotionRules;
  /** Registry cost estimate in USD, null when unmeasured. */
  costUsd: number | null;
}

interface ListedCategory {
  kind: 'listed';
  id: string;
  registryId: string;
  name: string;
  /** What running it would need; 'none' when it cannot run at all today. */
  tier: Tier | 'none';
  registryTier: RegistryTier | 'none';
  reason: string;
  command?: string;
}

type Category = DispatchedCategory | ListedCategory;

function toCategory(entry: CategoryEntry): Category {
  const base = { id: entry.legacy_alias, registryId: entry.id, name: entry.name };
  if (entry.run.kind === 'listed') {
    return { ...base, kind: 'listed', tier: entry.tier === 'none' ? 'none' : entry.tier === 'H' ? 'offline' : 'paid',
      registryTier: entry.tier, reason: entry.run.reason, command: entry.run.command };
  }
  if (entry.tier === 'none') throw new Error(`registry entry ${entry.id} is dispatched but has no tier`);
  const { kind: _kind, ...run } = entry.run;
  return { ...base, ...run, kind: 'dispatched', tier: entry.tier === 'H' ? 'offline' : 'paid', registryTier: entry.tier, script: entry.script, gate: entry.gate, promotion: entry.promotion, costUsd: entry.cost_estimate.usd };
}

const CATEGORIES: readonly Category[] = REGISTRY.map(toCategory);

interface CategoryRun {
  id: string;
  name: string;
  tier: Tier;
  script: string;
  status: 'pass' | 'fail' | 'skipped' | 'reported';
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
  if (value === 'offline' || value === 'paid' || value === 'all' || value === 'H' || value === 'K' || value === 'P') return value;
  throw new Error(`--tier must be H, K, P, offline (H), paid (K and P) or all (got ${JSON.stringify(value)})`);
}

/**
 * `--only a,b,c`: registry ids or legacy aliases, resolved to registry ids.
 * Returns null without the flag; an unknown name throws with the valid list.
 */
export function parseOnly(argv: string[]): Set<string> | null {
  const eq = argv.find(a => a.startsWith('--only='));
  const i = argv.indexOf('--only');
  const raw = eq ? eq.slice('--only='.length) : i >= 0 ? argv[i + 1] : undefined;
  if (raw === undefined) return null;
  const names = raw.split(',').map(n => n.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('--only needs a comma-separated list of registry ids or legacy aliases');
  const unknown = names.filter(n => !registryEntry(n));
  if (unknown.length) {
    throw new Error(`--only: unknown categor${unknown.length > 1 ? 'ies' : 'y'} ${unknown.map(n => JSON.stringify(n)).join(', ')}. `
      + `Valid ids (legacy alias in parentheses): ${REGISTRY.map(e => `${e.id} (${e.legacy_alias})`).join(', ')}`);
  }
  return new Set(names.map(n => registryEntry(n)!.id));
}

/** Split the registry into what runs in this tier and what does not, with a reason for each omission. */
export function selectCategories(tier: TierSelection, only: ReadonlySet<string> | null = null): { dispatch: DispatchedCategory[]; notRun: NotRun[] } {
  const dispatch: DispatchedCategory[] = [];
  const notRun: NotRun[] = [];
  const selected = tiersFor(tier);
  for (const c of CATEGORIES) {
    if (only && !only.has(c.registryId)) {
      notRun.push({ id: c.id, name: c.name, tier: c.tier, reason: 'not selected by --only' });
    } else if (c.kind === 'listed') {
      notRun.push({ id: c.id, name: c.name, tier: c.tier, reason: c.reason, command: c.command });
    } else if (selected.has(c.registryTier)) {
      dispatch.push(c);
    } else {
      notRun.push({ id: c.id, name: c.name, tier: c.tier, reason: `tier ${c.registryTier} not selected`, command: `bun ${[c.script, ...(c.args ?? [])].join(' ')}` });
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

/**
 * Every dispatched runner must produce a fresh valid receipt; nothing else
 * counts as a pass. A completed receipt is graded by the category's promotion
 * rules: every safety contract and quality threshold must hold, whatever the
 * runner's own verdict says. A category without a gating rule that completes
 * with a non-pass verdict is 'reported': shown in the report, never failing
 * the run. A missing, stale, invalid or errored receipt still fails.
 */
export function deriveStatus(load: ReceiptLoad, gating: GateStatus | PromotionRules = 'gate'): { status: 'pass' | 'fail' | 'skipped' | 'reported'; statusSource: 'receipt' | 'no-receipt'; statusNote: string } {
  if (load.kind === 'missing') return { status: 'fail', statusSource: 'no-receipt', statusNote: 'no receipt written by this run' };
  if (load.kind === 'stale') return { status: 'fail', statusSource: 'no-receipt', statusNote: `stale receipt from ${load.mtime}; this run wrote none` };
  if (load.kind === 'invalid') return { status: 'fail', statusSource: 'receipt', statusNote: `invalid receipt: ${load.reason}` };
  const receipt = load.receipt;
  switch (receipt.run_status) {
    case 'completed': {
      const note = `verdict=${receipt.verdict}${receipt.publishable ? '' : ' (not publishable)'}`;
      // Without promotion rules (older callers): the verdict gates, and
      // 'partial' counts as fail.
      if (typeof gating === 'string') {
        return { status: receipt.verdict === 'pass' ? 'pass' : gating === 'report-only' ? 'reported' : 'fail', statusSource: 'receipt', statusNote: note };
      }
      const outcome = evaluatePromotion(gating, receipt);
      if (!outcome.gated) return { status: receipt.verdict === 'pass' ? 'pass' : 'reported', statusSource: 'receipt', statusNote: `${note}; ${gating.held ? `rules held since ${gating.held.since} (${describeOutcome(outcome)})` : 'no gating rule'}` };
      return { status: outcome.pass ? 'pass' : 'fail', statusSource: 'receipt', statusNote: `${note}; ${describeOutcome(outcome)}` };
    }
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
      const derived = deriveStatus(loadFreshReceipt(receiptFile, started), cat.promotion ?? cat.gate);
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

const STATUS_LABEL: Record<CategoryRun['status'], string> = { pass: '✓ PASS', fail: '✗ FAIL', skipped: '⤼ SKIPPED', reported: '◐ REPORTED (report-only)' };

function buildReport(tier: TierSelection, runs: CategoryRun[], notRun: NotRun[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const passed = runs.filter(r => r.status === 'pass').length;
  const failed = runs.filter(r => r.status === 'fail').length;
  const skipped = runs.filter(r => r.status === 'skipped').length;
  const reported = runs.filter(r => r.status === 'reported').length;

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
    `${runs.length} of ${CATEGORIES.length} listed categories ran in tier "${tier}": ${passed} passed, ${failed} failed, ${skipped} skipped (a skipped category is never a pass), ${reported} report-only with a non-pass verdict (reported, not failed). ${notRun.length} were not run; they are listed below with the reason.`,
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
  lines.push('bun eval/runner/all.ts --tier paid --paid --budget-run-id <id>   # provider-backed categories (spends money)');
  lines.push('bun eval/runner/all.ts --tier all --paid --budget-run-id <id>');
  lines.push('bun eval/runner/all.ts --only <ids-or-aliases>   # a subset, e.g. --only N3,N4,N6');
  lines.push('```');

  return lines.join('\n');
}

export function printNotRun(notRun: NotRun[], log: (s: string) => void = console.log): void {
  log(`Not run in this invocation (${notRun.length}):`);
  for (const n of notRun) log(`  - Cat ${n.id} (${n.name}): ${n.reason}`);
}

// ─── Main ─────────────────────────────────────────────────────────────

/**
 * Refuse a selection that includes a K or P category unless `--paid` and
 * `--budget-run-id` name an open budget run; returns the env every child gets.
 */
export function paidGuard(argv: readonly string[], dispatch: readonly DispatchedCategory[], ledger: { ledgerPath?: string } = {}): Record<string, string> {
  const paid = dispatch.filter(c => c.registryTier !== 'H');
  if (paid.length === 0) return {};
  const estimate = paid.some(c => c.costUsd === null) ? null : paid.reduce((n, c) => n + (c.costUsd ?? 0), 0);
  const { budgetRunId } = requirePaidArm(argv, { arm: `all.ts with ${paid.length} paid categor${paid.length > 1 ? 'ies' : 'y'} (${paid.map(c => `Cat ${c.id}`).join(', ')})`, estimateUsd: estimate, ...ledger });
  return { BRAINBENCH_BUDGET_RUN_ID: budgetRunId };
}

async function main() {
  const argv = process.argv.slice(2);
  const tier = parseTier(argv);
  const { dispatch, notRun } = selectCategories(tier, parseOnly(argv));
  Object.assign(process.env, paidGuard(argv, dispatch));
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
    // Refusals and flag errors carry their own fix; print the message, not a stack.
    const usage = e instanceof PaidArmRefusal || (e instanceof Error && e.message.startsWith('--'));
    // eslint-disable-next-line no-console
    console.error(usage ? e.message : e);
    process.exit(usage ? 2 : 1);
  });
}

export { CATEGORIES, runCatSubprocess, runConcurrently, buildReport };
export type { Category, DispatchedCategory, ListedCategory, CategoryRun, NotRun };
