/**
 * Value: protects=scripts/scan-receipts.sh scans every receipts/ and *-scoreboard directory under docs/benchmarks and the members of every
 *   compressed receipt there that is not reviewed at its current hash and gitleaks pin (#221), keeps going past a finding, and exits 1 with LEAKS FOUND;
 *   fails_when=the find filter drops a directory kind, a tarball or gzip receipt goes unopened, a changed or unreviewed one is skipped,
 *   the loop stops at the first finding, or the exit status ignores a finding;
 *   why_new=no test references the script (q1-secret-scan.test.ts covers the TypeScript scanner only); seam=none;
 *   no_claim=real secret detection (a stub scanner stands in for the pinned detector; no download, no network).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const SCRIPT = resolve(import.meta.dir, '../../scripts/scan-receipts.sh');

/** A fake secret-shaped key (an AWS access key ID), assembled here so the source holds no literal key. */
const FAKE_KEY = ['AKIA', 'Z7Q4X2W9K3M5N8P1'].join('');
/** A stub scanner that fails when anything it is pointed at holds the fake key. */
const KEY_STUB = 'grep -rqE "AKIA[A-Z0-9]{16}" "$2" && exit 1; exit 0';

function run(dirs: string[], stubBody: string, setup?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'scan-receipts-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(SCRIPT, join(root, 'scripts/scan-receipts.sh'));
    for (const d of dirs) { mkdirSync(join(root, d), { recursive: true }); writeFileSync(join(root, d, 'f.txt'), 'x\n'); }
    setup?.(root);
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

  test('a key inside a tarball or gzip receipt outside any receipts directory is found (#221)', () => {
    const tarball = (root: string) => {
      const cell = join(root, 'docs/benchmarks/w/cells/c');
      mkdirSync(join(root, 'stage/stages/ingest'), { recursive: true });
      writeFileSync(join(root, 'stage/stages/ingest/a.json'), JSON.stringify({ key: FAKE_KEY, store: '/home/alice/cells/_stores/x' }));
      mkdirSync(cell, { recursive: true });
      execFileSync('tar', ['-czf', join(cell, 'receipt.tgz'), '-C', join(root, 'stage'), 'stages']);
      rmSync(join(root, 'stage'), { recursive: true });
    };
    const r = run(['docs/benchmarks/a/receipts'], KEY_STUB, tarball);
    expect(r.code).toBe(1);
    expect(r.out).toContain('LEAKS FOUND');
    const gz = run(['docs/benchmarks/a/receipts'], KEY_STUB, root => {
      mkdirSync(join(root, 'docs/benchmarks/w/raw'), { recursive: true });
      writeFileSync(join(root, 'docs/benchmarks/w/raw/rows.ndjson.gz'), gzipSync(JSON.stringify({ key: FAKE_KEY })));
    });
    expect(gz.code).toBe(1);
    expect(gz.out).toContain('LEAKS FOUND');
  });

  test('a compressed receipt reviewed with the pinned gitleaks is skipped until its bytes or the pin change', () => {
    const pinned = readFileSync(SCRIPT, 'utf8').match(/^VERSION=(.+)$/m)![1]!;
    const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const setup = (listed: (path: string) => string, gitleaks: string) => (root: string) => {
      const f = 'docs/benchmarks/w/raw/rows.ndjson.gz';
      mkdirSync(join(root, 'docs/benchmarks/w/raw'), { recursive: true });
      writeFileSync(join(root, f), gzipSync(JSON.stringify({ key: FAKE_KEY })));
      mkdirSync(join(root, 'test/eval/fixtures'), { recursive: true });
      writeFileSync(join(root, 'test/eval/fixtures/reviewed-compressed-receipts.json'), JSON.stringify({ gitleaks, files: { [f]: listed(join(root, f)) } }));
    };
    const reviewed = run(['docs/benchmarks/a/receipts'], KEY_STUB, setup(sha, pinned));
    expect(reviewed.code).toBe(0);
    expect(reviewed.out).toContain('compressed receipts: 1 found, 1 unchanged since review, 0 unpacked');
    expect(run(['docs/benchmarks/a/receipts'], KEY_STUB, setup(() => 'f'.repeat(64), pinned)).code).toBe(1);
    expect(run(['docs/benchmarks/a/receipts'], KEY_STUB, setup(sha, '0.0.1')).code).toBe(1);
  });
});
