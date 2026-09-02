/**
 * Shared plumbing for the outside-verification checks in eval/verify/.
 *
 * Every check is keyless, $0, no network (the stale-surface sweep is the
 * one exception and says so). Each exports pure functions that take a repo
 * root so tests can point them at synthetic fixture repos, plus a CLI entry
 * with the validator exit-code contract used across this repo:
 *
 *   0 — no failures (warnings may be present)
 *   1 — at least one failure
 *   2 — a required input is missing/unreadable (the check could not run)
 *
 * Severity semantics:
 *   fail — a receipts/claims contract is broken (blocks CI)
 *   warn — a disclosed or historical condition worth a human read; never
 *          blocks CI unless --strict promotes it
 *   info — inventory output (what the check looked at)
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

export type Severity = 'fail' | 'warn' | 'info';

export interface Finding {
  severity: Severity;
  /** Repo-relative file (plus :line when known) the finding is about. */
  where: string;
  message: string;
}

export interface CheckReport {
  check: string;
  findings: Finding[];
  /** Set when the check could not run at all (maps to exit 2). */
  unavailable?: string;
}

export const REPO_ROOT = join(import.meta.dir, '../..');

/** Depth-first file walk, sorted for deterministic output. */
export function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Repo-relative POSIX path. */
export function rel(root: string, abs: string): string {
  return relative(root, abs).split('\\').join('/');
}

/**
 * The set of git-tracked paths under root (via `git ls-files -z`). Returns
 * null when git is unavailable or root is not a work tree, so callers can
 * degrade to an existence-only check and say so.
 */
export function gitTrackedFiles(root: string): Set<string> | null {
  try {
    const proc = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    if (proc.exitCode !== 0) return null;
    const out = new TextDecoder().decode(proc.stdout);
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

/** `git show <ref>:<path>` as a string, or null when the path is absent at that ref. */
export function gitShow(root: string, ref: string, path: string): string | null {
  const proc = Bun.spawnSync(['git', 'show', `${ref}:${path}`], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) return null;
  return new TextDecoder().decode(proc.stdout);
}

export function countBy(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { fail: 0, warn: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

/** Print one report in the [check] prefix style the repo's validators use. */
export function printReport(r: CheckReport, opts: { quiet?: boolean } = {}): void {
  const tag = `[${r.check}]`;
  if (r.unavailable) {
    console.error(`${tag} UNAVAILABLE: ${r.unavailable}`);
    return;
  }
  for (const f of r.findings) {
    if (opts.quiet && f.severity === 'info') continue;
    const line = `${tag} ${f.severity.toUpperCase()}: ${f.where} — ${f.message}`;
    if (f.severity === 'fail') console.error(line);
    else console.log(line);
  }
  const c = countBy(r.findings);
  const verdict = c.fail > 0 ? 'FAIL' : 'OK';
  const summary = `${tag} ${verdict}: ${c.fail} fail, ${c.warn} warn, ${c.info} info`;
  if (c.fail > 0) console.error(summary);
  else console.log(summary);
}

/** Exit code for one or more reports under the shared contract. */
export function exitCodeFor(reports: CheckReport[], strict = false): 0 | 1 | 2 {
  if (reports.some(r => r.unavailable)) return 2;
  for (const r of reports) {
    const c = countBy(r.findings);
    if (c.fail > 0) return 1;
    if (strict && c.warn > 0) return 1;
  }
  return 0;
}

/** Minimal flag parser: --name value / --flag. Positionals returned separately. */
export function parseArgs(argv: string[]): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(a.slice(2), next);
        i++;
      } else {
        flags.set(a.slice(2), true);
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/** Run a check's CLI: print, then exit under the contract. */
export function runCli(reports: CheckReport[], flags: Map<string, string | true>): never {
  const quiet = flags.has('quiet');
  const strict = flags.has('strict');
  if (flags.has('json')) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const r of reports) printReport(r, { quiet });
  }
  process.exit(exitCodeFor(reports, strict));
}
