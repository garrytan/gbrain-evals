/**
 * Shared fixture helpers for the eval/verify tests: a throwaway git repo
 * per suite, files written under it, committed with identity + signing
 * pinned so the host's git config cannot break the run. Keyless, $0.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { CheckReport, Finding, Severity } from '../../eval/verify/lib.ts';

export function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${new TextDecoder().decode(p.stderr)}`);
  }
  return new TextDecoder().decode(p.stdout);
}

export function initRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'verify@test');
  git(dir, 'config', 'user.name', 'verify test');
  return dir;
}

export function put(root: string, relPath: string, content: string): void {
  mkdirSync(dirname(join(root, relPath)), { recursive: true });
  writeFileSync(join(root, relPath), content);
}

export function commitAll(root: string, message = 'fixture'): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Findings whose `where` contains the substring, optionally filtered by severity. */
export function at(report: CheckReport, whereSub: string, severity?: Severity): Finding[] {
  return report.findings.filter(f => f.where.includes(whereSub) && (severity === undefined || f.severity === severity));
}

export function severities(report: CheckReport): Record<Severity, number> {
  const c: Record<Severity, number> = { fail: 0, warn: 0, info: 0 };
  for (const f of report.findings) c[f.severity]++;
  return c;
}

/** Run one verify CLI and return its exit code + combined output. */
export function runCliFile(script: string, args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(['bun', script, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    code: p.exitCode,
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  };
}
