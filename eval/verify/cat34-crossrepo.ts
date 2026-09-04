/**
 * cat34-crossrepo — the README's cross-repo pointer is machine-checked.
 *
 * Issue #26 gap 2: the Cat 34 current-baseline numbers cite gbrain's
 * `evals/brainbench/baselines/main.json` at the pinned SHA — a file in a
 * different repo. CI installs gbrain from that exact pin
 * (`bun install --frozen-lockfile`), so the file is on disk at
 * node_modules/gbrain/… during every run, and the committed rerun receipt
 * (docs/benchmarks/2026-06-12-brainbench-memory/receipt-2026-09-01-v0.47.8.0-rerun.json)
 * claims to reproduce it digit-for-digit. This check makes both true:
 *
 *   - the receipt's gbrain_pin SHA equals package.json's pin → FAIL otherwise
 *   - baseline.fixtures_hash equals receipt.hashes.fixtures → FAIL otherwise
 *   - every receipt cell (`harness/suite`) exists in the baseline and every
 *     metric in it equals the baseline's value exactly → FAIL per mismatch
 *   - baseline cells the receipt does not carry → WARN (coverage, not drift)
 *
 * When node_modules/gbrain is not installed the check is UNAVAILABLE
 * (exit 2), never a silent pass.
 *
 * Keyless, $0, no network (after install).
 *
 * Usage: bun eval/verify/cat34-crossrepo.ts [--root <dir>] [--receipt <path>] [--baseline <path>] [--quiet] [--json]
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, parseArgs, runCli, type CheckReport, type Finding } from './lib.ts';

export const CHECK = 'cat34-crossrepo';
export const DEFAULT_RECEIPT = 'docs/benchmarks/2026-06-12-brainbench-memory/receipt-2026-09-01-v0.47.8.0-rerun.json';
export const DEFAULT_BASELINE = 'node_modules/gbrain/evals/brainbench/baselines/main.json';

interface Baseline {
  fixtures_hash?: string;
  cells?: Record<string, Record<string, unknown>>;
}

interface Receipt {
  gbrain_pin?: string;
  hashes?: { fixtures?: string };
  data?: { cells?: Array<{ cell: string; metrics?: Record<string, unknown> }> };
}

export interface Cat34Opts {
  root?: string;
  receipt?: string;
  baseline?: string;
  /** Test hook: the package.json pin SHA to compare against (default: read package.json). */
  pinSha?: string;
}

function readPinSha(root: string): string | null {
  const p = join(root, 'package.json');
  if (!existsSync(p)) return null;
  const pkg = JSON.parse(readFileSync(p, 'utf8')) as { dependencies?: Record<string, string> };
  const m = pkg.dependencies?.gbrain?.match(/#([0-9a-f]{40})$/);
  return m ? m[1] : null;
}

/** Pure comparison; callers supply parsed documents. */
export function compareCat34(receipt: Receipt, baseline: Baseline, pinSha: string | null, receiptName: string): Finding[] {
  const findings: Finding[] = [];
  const receiptSha = receipt.gbrain_pin?.match(/#([0-9a-f]+)$/)?.[1] ?? null;
  if (!receiptSha) {
    findings.push({ severity: 'fail', where: `${receiptName}:gbrain_pin`, message: `no commit SHA in gbrain_pin (${receipt.gbrain_pin ?? 'absent'})` });
  } else if (pinSha && receiptSha !== pinSha) {
    findings.push({ severity: 'fail', where: `${receiptName}:gbrain_pin`, message: `receipt ran at ${receiptSha}, package.json pins ${pinSha} — "at the pin" is not true` });
  } else {
    findings.push({ severity: 'info', where: `${receiptName}:gbrain_pin`, message: `receipt pin ${receiptSha} == package.json pin` });
  }

  const rf = receipt.hashes?.fixtures;
  if (!rf || !baseline.fixtures_hash) {
    findings.push({ severity: 'fail', where: 'fixtures_hash', message: `missing on ${!rf ? 'receipt' : 'baseline'}` });
  } else if (rf !== baseline.fixtures_hash) {
    findings.push({ severity: 'fail', where: 'fixtures_hash', message: `receipt ${rf} != baseline ${baseline.fixtures_hash} — different fixture corpus` });
  } else {
    findings.push({ severity: 'info', where: 'fixtures_hash', message: `${rf.slice(0, 12)}… identical on both sides` });
  }

  const cells = receipt.data?.cells ?? [];
  const bcells = baseline.cells ?? {};
  if (cells.length === 0) findings.push({ severity: 'fail', where: `${receiptName}:data.cells`, message: 'receipt carries no cells' });
  let metrics = 0;
  const seen = new Set<string>();
  for (const c of cells) {
    seen.add(c.cell);
    const b = bcells[c.cell];
    if (!b) {
      findings.push({ severity: 'fail', where: c.cell, message: 'cell in receipt but absent from the baseline' });
      continue;
    }
    for (const [k, v] of Object.entries(c.metrics ?? {})) {
      metrics++;
      if (!(k in b)) {
        findings.push({ severity: 'fail', where: `${c.cell}.${k}`, message: `metric in receipt but absent from the baseline cell` });
      } else if (b[k] !== v) {
        findings.push({ severity: 'fail', where: `${c.cell}.${k}`, message: `receipt ${JSON.stringify(v)} != baseline ${JSON.stringify(b[k])}` });
      }
    }
  }
  for (const k of Object.keys(bcells)) {
    if (!seen.has(k)) findings.push({ severity: 'warn', where: k, message: 'baseline cell not covered by the receipt' });
  }
  findings.push({ severity: 'info', where: `${cells.length} cell(s)`, message: `${metrics} metric(s) compared digit-for-digit` });
  return findings;
}

export function checkCat34CrossRepo(opts: Cat34Opts = {}): CheckReport {
  const root = opts.root ?? REPO_ROOT;
  const receiptPath = opts.receipt ?? DEFAULT_RECEIPT;
  const baselinePath = opts.baseline ?? DEFAULT_BASELINE;
  const absR = join(root, receiptPath);
  const absB = join(root, baselinePath);
  if (!existsSync(absB)) {
    return { check: CHECK, findings: [], unavailable: `${baselinePath} not found — run \`bun install --frozen-lockfile\` (installs gbrain at the pin)` };
  }
  if (!existsSync(absR)) {
    return { check: CHECK, findings: [], unavailable: `${receiptPath} not found` };
  }
  let receipt: Receipt;
  let baseline: Baseline;
  try {
    receipt = JSON.parse(readFileSync(absR, 'utf8')) as Receipt;
    baseline = JSON.parse(readFileSync(absB, 'utf8')) as Baseline;
  } catch (e) {
    return { check: CHECK, findings: [], unavailable: `unparseable: ${e instanceof Error ? e.message : e}` };
  }
  const pinSha = opts.pinSha ?? readPinSha(root);
  return { check: CHECK, findings: compareCat34(receipt, baseline, pinSha, receiptPath) };
}

if (import.meta.main) {
  const { flags } = parseArgs(process.argv.slice(2));
  const root = typeof flags.get('root') === 'string' ? String(flags.get('root')) : REPO_ROOT;
  const receipt = typeof flags.get('receipt') === 'string' ? String(flags.get('receipt')) : undefined;
  const baseline = typeof flags.get('baseline') === 'string' ? String(flags.get('baseline')) : undefined;
  runCli([checkCat34CrossRepo({ root, receipt, baseline })], flags);
}
