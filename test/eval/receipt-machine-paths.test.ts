/**
 * Machine-local paths in committed receipts (docs audit B11).
 *
 * writeReceipt rewrites checkout, home and temp paths before writing. This
 * test scans every committed receipt-like file (JSON, NDJSON, JSONL, logs)
 * under docs/benchmarks, results, baselines and qrels, and every member of a
 * committed tarball or gzip receipt there (#221). A file may contain a
 * machine-local path only if it is one of the historical receipts frozen, by
 * hash, in fixtures/historical-machine-local-paths.json; those stay
 * byte-for-byte as evidence and may not change. Compressed receipts reviewed
 * member by member are frozen, by hash, in
 * fixtures/reviewed-compressed-receipts.json; any other compressed receipt is
 * read here, and only the path prefixes that file declares, each with its
 * reason, are exempt inside it. A compressed receipt is known by its name or
 * its leading bytes. One in a format this test cannot open, a tarball that
 * scripts/scan-receipts.sh refuses (GNU tar cannot list it cleanly, it names a
 * member twice, or it holds an entry other than a regular file or directory),
 * or one with a member that is not UTF-8 text fails unread.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { MACHINE_LOCAL_PATH, scrubMachinePaths } from '../../eval/runner/receipt.ts';

const ROOT = resolve(import.meta.dir, '../..');
const historical = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/historical-machine-local-paths.json'), 'utf8')) as { files: Record<string, string> }).files;
const historicalCapy = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/historical-capy-local-paths.json'), 'utf8')) as { files: Record<string, string> }).files;
const reviewed = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/reviewed-compressed-receipts.json'), 'utf8')) as { exempt_machine_paths: Record<string, string>; files: Record<string, { sha256: string; gitleaks?: string }> };
const VM_OVERLAY = Object.keys(reviewed.exempt_machine_paths)[0]!;
/** Capy machine paths: the /workspace/ checkout root and the agent scratch under ~/.capy/, which home scrubbing turns into `~/.capy/...` and MACHINE_LOCAL_PATH accepts. */
const CAPY_LOCAL_PATH = /(?:^|[\s"'=(:,\[])(?:\/workspace\/|~\/\.capy\/|\$HOME\/\.capy\/)/;

describe('scrubMachinePaths', () => {
  test('rewrites checkout, home and temp prefixes in nested strings', () => {
    const scrubbed = scrubMachinePaths({
      corpus_dir: '/work/repo/eval/data/world-v1',
      root: '/work/repo',
      nested: [{ cache: '/home/alice/.cache/x.sqlite' }, '/tmp/run/out.json', '/var/tmp-x/y'],
      command: 'bun x --out /work/repo/eval/reports/a.json',
      n: 3,
    }, '/work/repo', '/home/alice', '/var/tmp-x');
    expect(scrubbed).toEqual({
      corpus_dir: 'eval/data/world-v1',
      root: '.',
      nested: [{ cache: '~/.cache/x.sqlite' }, '<tmp>/run/out.json', '<tmp>/y'],
      command: 'bun x --out eval/reports/a.json',
      n: 3,
    });
    expect(MACHINE_LOCAL_PATH.test(JSON.stringify(scrubbed))).toBe(false);
  });

  test('the pattern catches the paths the audit found', () => {
    for (const leak of ['"/home/vercel-sandbox/gbrain-lme-receipts/A3.ndjson"', '"path": "/tmp/r1-embed-cache.sqlite"', ' /Users/me/x', '"C:\\Users\\me\\x"']) {
      expect(MACHINE_LOCAL_PATH.test(leak)).toBe(true);
    }
    for (const ok of ['"eval/reports/a.json"', '"~/.cache/x"', '"<tmp>/x"', 'https://example.com/tmp/x']) {
      expect(MACHINE_LOCAL_PATH.test(ok)).toBe(false);
    }
  });

  test('the Capy pattern catches checkout and scratch paths that home scrubbing leaves behind', () => {
    for (const leak of ['"ledger": "/workspace/gbrain-evals/.budget/x.sqlite"', '"--gbrain": "~/.capy/work/gbrain@14ea3e2e"', '"--gbrain-root": "~/.capy/work/cat40/gbrain-d5"', 'root=$HOME/.capy/work/x']) {
      expect(CAPY_LOCAL_PATH.test(leak)).toBe(true);
    }
    for (const ok of ['"gbrain@14ea3e2e"', '"<slots>/gbrain-d5"', '".budget/x.sqlite"', '"~/.cache/x"', 'https://example.com/workspace/x']) {
      expect(CAPY_LOCAL_PATH.test(ok)).toBe(false);
    }
  });
});

/** Leading bytes of the compression and archive formats neither receipt guard opens: zip, xz, zstd, bzip2, 7z, lz4, compress (.Z), lzip and rar. scripts/scan-receipts.sh refuses the same. */
const UNREADABLE = ['504b0304', 'fd377a585a00', '28b52ffd', '425a68', '377abcaf271c', '04224d18', '1f9d', '4c5a4950', '526172211a07'];

/** A file's first 262 bytes: every leading mark above, a gzip file's 1f8b and a tar stream's "ustar" at byte 257. */
function head(path: string): Buffer {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(262);
    return bytes.subarray(0, readSync(fd, bytes, 0, 262, 0));
  } finally { closeSync(fd); }
}

/** GNU tar's listing of a tarball, judged as scripts/scan-receipts.sh judges it: the reason it is refused unread (tar cannot list it cleanly, an entry is not a regular file or directory, or a member is named twice, so extraction would keep only the last copy), else the number of regular files it lists. */
function listing(path: string): { refusal: string } | { files: number } {
  const list = (...flags: string[]) => spawnSync('tar', [...flags, path], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 256 * 1024 * 1024 });
  const [long, names, past] = [list('-tvf'), list('-tf'), list('--ignore-zeros', '-tf')];
  const failed = [long, names, past].find(p => p.status !== 0 || p.stderr);
  if (failed) return { refusal: `tar cannot list it cleanly (${failed.stderr.trim().split('\n')[0] || `exit ${failed.status}`})` };
  if (past.stdout !== names.stdout) return { refusal: 'tar cannot list it cleanly (it lists more entries past a zero block)' };
  const kinds = long.stdout.split('\n').filter(Boolean).map(line => line[0]);
  const listed = names.stdout.split('\n').filter(Boolean);
  if (kinds.length !== listed.length) return { refusal: 'tar cannot list it cleanly (its two listings differ)' };
  const seen = new Set<string>();
  for (const [i, name] of listed.entries()) {
    if (kinds[i] !== '-' && kinds[i] !== 'd') return { refusal: `${name} is not a regular file or directory` };
    const key = posix.normalize(`/${name}`).replace(/^\/+|\/+$/g, '');
    if (seen.has(key)) return { refusal: `${name} is named twice` };
    seen.add(key);
  }
  return { files: kinds.filter(kind => kind === '-').length };
}

/** Each member of a tarball, or a gzip file's content, as [member name, bytes]; a string is why the tarball is refused unread. */
function members(path: string): Array<[string, Buffer]> | string {
  const raw = readFileSync(path);
  const data = raw.subarray(0, 2).toString('hex') === '1f8b' ? gunzipSync(raw) : raw;
  if (!/\.(tgz|tar\.gz|tar)$/.test(path) && data.subarray(257, 262).toString('latin1') !== 'ustar') return [['', data]];
  const judged = listing(path);
  if ('refusal' in judged) return judged.refusal;
  const dir = mkdtempSync(join(tmpdir(), 'receipt-members-'));
  try {
    execFileSync('tar', ['-xf', path, '-C', dir]);
    execFileSync('chmod', ['-R', 'u+rwX', dir]);
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter(f => lstatSync(join(dir, f)).isFile()).sort();
    if (files.length !== judged.files) return `GNU tar extracts ${files.length} files where it lists ${judged.files}`;
    return files.map(f => [f, readFileSync(join(dir, f))]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A member's text, or null when it is not UTF-8 text without NUL bytes (a compressed, archive or other binary member, which neither receipt guard reads; scripts/scan-receipts.sh refuses the same). */
const text = (bytes: Buffer): string | null => {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
};
const exempt = (text: string) => Object.keys(reviewed.exempt_machine_paths).reduce((t, prefix) => t.split(prefix).join(''), text);

/** Receipts under `root` outside `frozen` whose text matches `pattern`; a tarball or gzip receipt, known by its name or its leading bytes, is read member by member, and one this cannot read is an offender. */
function offenders(root: string, files: string[], frozen: Record<string, unknown>, pattern: RegExp): string[] {
  return files.filter(f => !(f in frozen)).flatMap(f => {
    const lead = head(join(root, f));
    if (/\.(zip|xz|zst|bz2|7z)$/.test(f) || UNREADABLE.some(magic => lead.subarray(0, magic.length / 2).toString('hex') === magic)) return [`${f} (unreadable compression)`];
    if (!/\.(tgz|tar|gz)$/.test(f) && lead.subarray(0, 2).toString('hex') !== '1f8b' && lead.subarray(257, 262).toString('latin1') !== 'ustar') {
      return /\.(json|ndjson|jsonl|log)$/.test(f) && pattern.test(readFileSync(join(root, f), 'utf8')) ? [f] : [];
    }
    const read = members(join(root, f));
    if (typeof read === 'string') return [`${f} (refused: ${read})`];
    return read.flatMap(([name, bytes]) => {
      const label = name ? `${f}: ${name}` : f;
      const content = text(bytes);
      if (content === null) return [`${label} (not UTF-8 text)`];
      return pattern.test(exempt(content)) ? [label] : [];
    });
  });
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('compressed receipts', () => {
  test('a tarball or gzip receipt is read member by member (#221)', () => {
    const root = mkdtempSync(join(tmpdir(), 'receipt-members-'));
    try {
      mkdirSync(join(root, 'cell/stages/ingest'), { recursive: true });
      writeFileSync(join(root, 'cell/stages/ingest/a.json'), JSON.stringify({ key: ['AKIA', 'Z7Q4X2W9K3M5N8P1'].join(''), store: '/home/alice/cells/_stores/x' }));
      writeFileSync(join(root, 'cell/stages/ingest/b.json'), JSON.stringify({ gbrain: { cli: `${VM_OVERLAY}d7467d1cf/src/cli.ts` } }));
      execFileSync('tar', ['-czf', join(root, 'receipt.tgz'), '-C', join(root, 'cell'), 'stages']);
      writeFileSync(join(root, 'rows.ndjson.gz'), gzipSync(JSON.stringify({ cache: '/tmp/r1-embed-cache.sqlite' })));
      expect(offenders(root, ['receipt.tgz', 'rows.ndjson.gz'], {}, MACHINE_LOCAL_PATH)).toEqual(['receipt.tgz: stages/ingest/a.json', 'rows.ndjson.gz']);
      expect(offenders(root, ['receipt.tgz'], { 'receipt.tgz': sha256(join(root, 'receipt.tgz')) }, MACHINE_LOCAL_PATH)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a binary member or a compression neither guard opens is an offender, whatever it holds', () => {
    const root = mkdtempSync(join(tmpdir(), 'receipt-members-'));
    try {
      mkdirSync(join(root, 'cell'), { recursive: true });
      writeFileSync(join(root, 'cell/rows.json.gz'), gzipSync(JSON.stringify({ store: '/home/alice/cells/_stores/x' })));
      execFileSync('tar', ['-czf', join(root, 'receipt.tgz'), '-C', join(root, 'cell'), 'rows.json.gz']);
      writeFileSync(join(root, 'rows.json.xz'), 'not opened');
      expect(offenders(root, ['receipt.tgz', 'rows.json.xz'], {}, MACHINE_LOCAL_PATH)).toEqual(['receipt.tgz: rows.json.gz (not UTF-8 text)', 'rows.json.xz (unreadable compression)']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a tarball that names a member twice, or reaches an earlier member again through a symlinked directory or a leading slash, is an offender, because extraction keeps only the last copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'receipt-members-'));
    try {
      const machinePath = JSON.stringify({ store: '/home/alice/cells/_stores/x' });
      mkdirSync(join(root, 'first/e'), { recursive: true });
      mkdirSync(join(root, 'last/d'), { recursive: true });
      writeFileSync(join(root, 'first/x.log'), machinePath);
      writeFileSync(join(root, 'first/e/x.log'), machinePath);
      symlinkSync('e', join(root, 'first/d'));
      writeFileSync(join(root, 'last/x.log'), 'clean receipt\n');
      writeFileSync(join(root, 'last/d/x.log'), 'clean receipt\n');
      execFileSync('tar', ['-cf', join(root, 'twice.tar'), '-C', join(root, 'first'), 'x.log']);
      execFileSync('tar', ['-rf', join(root, 'twice.tar'), '-C', join(root, 'last'), 'x.log']);
      execFileSync('tar', ['-cPf', join(root, 'slash.tar'), '-C', join(root, 'first'), '--transform', 's,^,/,', 'x.log']);
      execFileSync('tar', ['-rf', join(root, 'slash.tar'), '-C', join(root, 'last'), 'x.log'], { stdio: 'pipe' });
      execFileSync('tar', ['-cf', join(root, 'link.tar'), '-C', join(root, 'first'), 'e/x.log', 'd']);
      execFileSync('tar', ['-rf', join(root, 'link.tar'), '-C', join(root, 'last'), 'd/x.log']);
      expect(offenders(root, ['twice.tar', 'slash.tar', 'link.tar'], {}, MACHINE_LOCAL_PATH)).toEqual([
        'twice.tar (refused: x.log is named twice)',
        "slash.tar (refused: tar cannot list it cleanly (tar: Removing leading `/' from member names))",
        'link.tar (refused: d is not a regular file or directory)',
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a compressed receipt is recognised by its leading bytes, whatever its name', () => {
    const root = mkdtempSync(join(tmpdir(), 'receipt-members-'));
    try {
      writeFileSync(join(root, 'rows.bin'), gzipSync(JSON.stringify({ cache: '/tmp/r1-embed-cache.sqlite' })));
      writeFileSync(join(root, 'rows.dat'), Buffer.concat([Buffer.from('BZh91AY&SY'), Buffer.alloc(16)]));
      expect(offenders(root, ['rows.bin', 'rows.dat'], {}, MACHINE_LOCAL_PATH)).toEqual(['rows.bin', 'rows.dat (unreadable compression)']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the only exemption is the harness VM overlay checkout, which still matches the machine-path pattern', () => {
    expect(Object.keys(reviewed.exempt_machine_paths)).toEqual(['/home/ubi/work/gbrain-evals/.gbrain-overlays/']);
    expect(MACHINE_LOCAL_PATH.test(`"${VM_OVERLAY}d7467d1cf/src/cli.ts"`)).toBe(true);
  });

  test('reviewed compressed receipts are unchanged', () => {
    const changed = Object.entries(reviewed.files).filter(([f, entry]) => sha256(join(ROOT, f)) !== entry.sha256);
    expect(changed).toEqual([]);
  }, 60_000);
});

describe('committed receipts', () => {
  const files = execFileSync('git', ['ls-files', 'docs/benchmarks', 'results', 'baselines', 'qrels'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n').filter(Boolean);

  test('no receipt outside the frozen historical and reviewed lists contains a machine-local path', () => {
    expect(offenders(ROOT, files, { ...historical, ...reviewed.files }, MACHINE_LOCAL_PATH)).toEqual([]);
  });

  test('historical receipts with machine-local paths are unchanged', () => {
    const changed = Object.entries(historical).filter(([f, sha]) => createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex') !== sha);
    expect(changed).toEqual([]);
  });

  test('no receipt outside the frozen lists contains a Capy machine path', () => {
    expect(offenders(ROOT, files, { ...historical, ...historicalCapy, ...reviewed.files }, CAPY_LOCAL_PATH)).toEqual([]);
  });

  test('historical receipts with Capy machine paths are unchanged', () => {
    const changed = Object.entries(historicalCapy).filter(([f, sha]) => createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex') !== sha);
    expect(changed).toEqual([]);
  });
});
