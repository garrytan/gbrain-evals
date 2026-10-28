/**
 * Value: protects=scripts/scan-receipts.sh scans every receipts/ and *-scoreboard directory under docs/benchmarks, keeps going past a finding, and exits 1 with LEAKS FOUND;
 *   fails_when=the find filter drops a directory kind, the loop stops at the first finding, or the exit status ignores a finding;
 *   why_new=no test references the script (q1-secret-scan.test.ts covers the TypeScript scanner only); seam=none;
 *   no_claim=real secret detection (a stub scanner stands in for the pinned detector; no download, no network).
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '../../scripts/scan-receipts.sh');

function run(dirs: string[], stubBody: string) {
  const root = mkdtempSync(join(tmpdir(), 'scan-receipts-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(SCRIPT, join(root, 'scripts/scan-receipts.sh'));
    for (const d of dirs) { mkdirSync(join(root, d), { recursive: true }); writeFileSync(join(root, d, 'f.txt'), 'x\n'); }
    const stub = join(root, 'stub-scanner');
    writeFileSync(stub, `#!/usr/bin/env bash\n${stubBody}\n`);
    chmodSync(stub, 0o755);
    const p = Bun.spawnSync(['bash', join(root, 'scripts/scan-receipts.sh')], { env: { PATH: process.env.PATH!, GITLEAKS: stub }, stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('scan-receipts.sh', () => {
  test('scans receipts and scoreboard directories only, and exits 0 with no leaks', () => {
    const r = run(['docs/benchmarks/a/receipts', 'docs/benchmarks/b/q1-scoreboard', 'docs/benchmarks/c/notes'], 'exit 0');
    expect(r.code).toBe(0);
    expect(r.out).toContain('scanning docs/benchmarks/a/receipts');
    expect(r.out).toContain('scanning docs/benchmarks/b/q1-scoreboard');
    expect(r.out).not.toContain('notes');
    expect(r.out).toContain('scan-receipts: 2 directories scanned, no leaks');
  });

  test('a finding in one directory still scans the rest, then exits 1 with LEAKS FOUND', () => {
    const r = run(['docs/benchmarks/a/receipts', 'docs/benchmarks/b/receipts'], 'case "$2" in *a/receipts) exit 1;; esac; exit 0');
    expect(r.code).toBe(1);
    expect(r.out).toContain('scanning docs/benchmarks/b/receipts');
    expect(r.out).toContain('scan-receipts: 2 directories scanned, LEAKS FOUND');
  });

  test('one directory reads in the singular', () => {
    expect(run(['docs/benchmarks/a/receipts'], 'exit 0').out).toContain('1 directory scanned, no leaks');
  });
});
