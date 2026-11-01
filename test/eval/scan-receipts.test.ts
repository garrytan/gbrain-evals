/**
 * Value: protects=scripts/scan-receipts.sh scans every receipts/ and *-scoreboard directory under docs/benchmarks and the members of every
 *   compressed receipt under docs/benchmarks, results, baselines and qrels that is not reviewed at its current hash and gitleaks pin (#221),
 *   refuses unread a tarball GNU tar cannot list cleanly, that names a member twice or that holds an entry other than a regular file or
 *   directory, keeps going past a finding, and exits 1 with LEAKS FOUND;
 *   fails_when=the find filter drops a directory kind, a tarball or gzip receipt goes unopened (outside docs/benchmarks or without an archive
 *   name too), a tarball whose extraction could hide or skip a member is scanned instead of refused, an unreadable extracted directory hides
 *   a member, a changed, unreviewed or machine-path-only entry is skipped, the loop stops at the first finding, or the exit status ignores a
 *   finding;
 *   why_new=no test references the script (q1-secret-scan.test.ts covers the TypeScript scanner only); seam=none;
 *   no_claim=real secret detection (a stub scanner stands in for the pinned detector; no download, no network).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const SCRIPT = resolve(import.meta.dir, '../../scripts/scan-receipts.sh');

/** A fake secret-shaped key (an AWS access key ID), assembled here so the source holds no literal key. */
const FAKE_KEY = ['AKIA', 'Z7Q4X2W9K3M5N8P1'].join('');
/** A stub scanner that fails when anything it is pointed at holds the fake key. */
const KEY_STUB = 'grep -rqE "AKIA[A-Z0-9]{16}" "$2" && exit 1; exit 0';
const RECEIPT = 'docs/benchmarks/w/cells/c/receipt.tar';

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
    const p = Bun.spawnSync(['bash', join(root, 'scripts/scan-receipts.sh')], { env: { PATH: process.env.PATH!, GITLEAKS: stub }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    return { code: p.exitCode, out: p.stdout.toString() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** A ustar tarball, made by GNU tar, of files written into a fresh stage directory under root; returns its bytes. */
function tarOf(root: string, files: Array<[string, string]>): Buffer {
  const stage = mkdtempSync(join(root, 'stage-'));
  for (const [name, content] of files) writeFileSync(join(stage, name), content);
  execFileSync('tar', ['--format=ustar', '-cf', join(stage, '..', 'staged.tar'), '-C', stage, ...files.map(([name]) => name)]);
  const bytes = readFileSync(join(stage, '..', 'staged.tar'));
  rmSync(stage, { recursive: true });
  rmSync(join(stage, '..', 'staged.tar'));
  return bytes;
}

/** Sets the typeflag of the tar header at offset and rewrites its checksum. */
function retype(tar: Buffer, offset: number, typeflag: string): Buffer {
  tar.write(typeflag, offset + 156, 'latin1');
  tar.fill(' ', offset + 148, offset + 156);
  const sum = tar.subarray(offset, offset + 512).reduce((a, b) => a + b, 0);
  tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, offset + 148, 'latin1');
  return tar;
}

function writeReceipt(root: string, bytes: Buffer) {
  mkdirSync(join(root, 'docs/benchmarks/w/cells/c'), { recursive: true });
  writeFileSync(join(root, RECEIPT), bytes);
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

  test('a binary member or an unsupported compression fails the scan instead of passing unread', () => {
    const nested = run(['docs/benchmarks/a/receipts'], KEY_STUB, root => {
      mkdirSync(join(root, 'stage'), { recursive: true });
      writeFileSync(join(root, 'stage/rows.json.gz'), gzipSync(JSON.stringify({ key: FAKE_KEY })));
      mkdirSync(join(root, 'docs/benchmarks/w/cells/c'), { recursive: true });
      execFileSync('tar', ['-czf', join(root, 'docs/benchmarks/w/cells/c/receipt.tgz'), '-C', join(root, 'stage'), 'rows.json.gz']);
      rmSync(join(root, 'stage'), { recursive: true });
    });
    expect(nested.code).toBe(1);
    expect(nested.out).toContain('cannot scan a member that is not UTF-8 text: docs/benchmarks/w/cells/c/receipt.tgz/rows.json.gz');
    expect(nested.out).toContain('LEAKS FOUND');
    const xz = run(['docs/benchmarks/a/receipts'], 'exit 0', root => {
      mkdirSync(join(root, 'docs/benchmarks/w/raw'), { recursive: true });
      writeFileSync(join(root, 'docs/benchmarks/w/raw/rows.json.xz'), 'not opened');
    });
    expect(xz.code).toBe(1);
    expect(xz.out).toContain('cannot unpack docs/benchmarks/w/raw/rows.json.xz');
  });

  test('the scanner sees a short key and a 3,046-byte key that straddle window edges in a long member', () => {
    const longKey = ['-----BEGIN FAKE KEY-----', 'Q'.repeat(3000), '-----END FAKE KEY-----'].join('');
    const bothStub = 'grep -rqE "AKIA[A-Z0-9]{16}" "$2" && grep -rqE "BEGIN FAKE KEY-----Q{3000}-----END FAKE KEY" "$2" && exit 1; exit 0';
    const r = run(['docs/benchmarks/a/receipts'], bothStub, root => {
      mkdirSync(join(root, 'stage'), { recursive: true });
      writeFileSync(join(root, 'stage/rows.jsonl'), `${'a'.repeat(7000)}${longKey}${'a'.repeat(13490 - 7000 - longKey.length)}${FAKE_KEY}\n${'b'.repeat(20000)}\n`);
      mkdirSync(join(root, 'docs/benchmarks/w/cells/c'), { recursive: true });
      execFileSync('tar', ['-czf', join(root, 'docs/benchmarks/w/cells/c/receipt.tgz'), '-C', join(root, 'stage'), 'rows.jsonl']);
      rmSync(join(root, 'stage'), { recursive: true });
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('LEAKS FOUND');
  });

  test('a tarball GNU tar cannot list cleanly is refused unread: a garbage block mid-archive, or a lone zero block that ends the listing early', () => {
    for (const [fill, said] of [['G', 'Skipping to next header'], ['\0', 'A lone zero block']] as const) {
      const r = run(['docs/benchmarks/a/receipts'], KEY_STUB, root => {
        const clean = tarOf(root, [['clean.log', 'clean receipt\n']]).subarray(0, 1024);
        writeReceipt(root, Buffer.concat([clean, Buffer.alloc(512, fill), tarOf(root, [['rows.log', `${FAKE_KEY}\n`]])]));
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain(`refusing ${RECEIPT}: tar cannot list it cleanly (tar: ${said}`);
    }
  });

  test('a tarball holding an entry other than a regular file or directory is refused unread, including an unknown type GNU tar extracts as a file', () => {
    const unknown = run(['docs/benchmarks/a/receipts'], KEY_STUB, root => {
      writeReceipt(root, retype(tarOf(root, [['clean.log', 'clean receipt\n'], ['rows.log', `${FAKE_KEY}\n`]]), 1024, 'Z'));
    });
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain(`refusing ${RECEIPT}: rows.log is not a regular file or directory`);
    for (const special of ['pipe', 'link']) {
      const r = run(['docs/benchmarks/a/receipts'], 'exit 0', root => {
        const stage = join(root, 'stage');
        mkdirSync(stage);
        if (special === 'pipe') execFileSync('mkfifo', [join(stage, 'pipe')]);
        else symlinkSync('/etc/hostname', join(stage, 'link'));
        mkdirSync(join(root, 'docs/benchmarks/w/cells/c'), { recursive: true });
        execFileSync('tar', ['-cf', join(root, RECEIPT), '-C', stage, special]);
        rmSync(stage, { recursive: true });
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain(`refusing ${RECEIPT}: ${special} is not a regular file or directory`);
    }
  });

  test('a tarball that names a member twice is refused unread, because extraction keeps only the last copy', () => {
    for (const again of ['rows.log', './rows.log']) {
      const r = run(['docs/benchmarks/a/receipts'], KEY_STUB, root => {
        const stage = join(root, 'stage');
        mkdirSync(stage);
        mkdirSync(join(root, 'docs/benchmarks/w/cells/c'), { recursive: true });
        writeFileSync(join(stage, 'rows.log'), `${FAKE_KEY}\n`);
        execFileSync('tar', ['-cf', join(root, RECEIPT), '-C', stage, 'rows.log']);
        writeFileSync(join(stage, 'rows.log'), 'clean receipt\n');
        execFileSync('tar', ['-rf', join(root, RECEIPT), '-C', stage, again]);
        rmSync(stage, { recursive: true });
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain(`refusing ${RECEIPT}: ${again} is named twice`);
    }
  });

  test('a member under a directory the runner cannot read is still scanned', () => {
    const r = run(['docs/benchmarks/a/receipts'], 'grep -rqE "AKIA[A-Z0-9]{16}" "$2" && { echo "scanner saw the key"; exit 1; }; exit 0', root => {
      mkdirSync(join(root, 'stage/locked'), { recursive: true });
      writeFileSync(join(root, 'stage/locked/a.json'), JSON.stringify({ key: FAKE_KEY }));
      mkdirSync(join(root, 'docs/benchmarks/w/cells/c'), { recursive: true });
      execFileSync('tar', ['-czf', join(root, 'docs/benchmarks/w/cells/c/receipt.tgz'), '--mode=a-rwx', '-C', join(root, 'stage'), 'locked']);
      rmSync(join(root, 'stage'), { recursive: true });
    });
    expect(r.out).toContain('scanner saw the key');
    expect(r.code).toBe(1);
  });

  test('a compressed receipt under results/ is found by its leading bytes, and one in another format fails unread whatever its name', () => {
    const gz = run(['docs/benchmarks/a/receipts'], KEY_STUB, root => {
      mkdirSync(join(root, 'results/x'), { recursive: true });
      writeFileSync(join(root, 'results/x/rows.bin'), gzipSync(JSON.stringify({ key: FAKE_KEY })));
    });
    expect(gz.code).toBe(1);
    expect(gz.out).toContain('compressed receipts: 1 found, 0 unchanged since review, 1 unpacked');
    const bzip2 = run(['docs/benchmarks/a/receipts'], 'exit 0', root => {
      mkdirSync(join(root, 'docs/benchmarks/w/raw'), { recursive: true });
      writeFileSync(join(root, 'docs/benchmarks/w/raw/rows.dat'), Buffer.concat([Buffer.from('BZh91AY&SY'), Buffer.alloc(16)]));
    });
    expect(bzip2.code).toBe(1);
    expect(bzip2.out).toContain('cannot unpack docs/benchmarks/w/raw/rows.dat');
  });

  test('a compressed receipt reviewed with the pinned gitleaks is skipped until its bytes or the pin change, and one listed without a gitleaks version is scanned', () => {
    const pinned = readFileSync(SCRIPT, 'utf8').match(/^VERSION=(.+)$/m)![1]!;
    const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const setup = (listed: (path: string) => string, gitleaks?: string) => (root: string) => {
      const f = 'docs/benchmarks/w/raw/rows.ndjson.gz';
      mkdirSync(join(root, 'docs/benchmarks/w/raw'), { recursive: true });
      writeFileSync(join(root, f), gzipSync(JSON.stringify({ key: FAKE_KEY })));
      mkdirSync(join(root, 'test/eval/fixtures'), { recursive: true });
      writeFileSync(join(root, 'test/eval/fixtures/reviewed-compressed-receipts.json'), JSON.stringify({ files: { [f]: { sha256: listed(join(root, f)), gitleaks } } }));
    };
    const reviewed = run(['docs/benchmarks/a/receipts'], KEY_STUB, setup(sha, pinned));
    expect(reviewed.code).toBe(0);
    expect(reviewed.out).toContain('compressed receipts: 1 found, 1 unchanged since review, 0 unpacked');
    expect(run(['docs/benchmarks/a/receipts'], KEY_STUB, setup(() => 'f'.repeat(64), pinned)).code).toBe(1);
    expect(run(['docs/benchmarks/a/receipts'], KEY_STUB, setup(sha, '0.0.1')).code).toBe(1);
    expect(run(['docs/benchmarks/a/receipts'], KEY_STUB, setup(sha)).code).toBe(1);
  });
});
