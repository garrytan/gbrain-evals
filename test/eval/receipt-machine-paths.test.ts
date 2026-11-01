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
 * reason, are exempt inside it.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { MACHINE_LOCAL_PATH, scrubMachinePaths } from '../../eval/runner/receipt.ts';

const ROOT = resolve(import.meta.dir, '../..');
const historical = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/historical-machine-local-paths.json'), 'utf8')) as { files: Record<string, string> }).files;
const historicalCapy = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/historical-capy-local-paths.json'), 'utf8')) as { files: Record<string, string> }).files;
const reviewed = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/reviewed-compressed-receipts.json'), 'utf8')) as { exempt_machine_paths: Record<string, string>; files: Record<string, string> };
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

/** Each member of a tarball, or a gzip file's content, as [member name, text], with the declared exempt path prefixes removed. */
function members(path: string): Array<[string, string]> {
  const exempt = (text: string) => Object.keys(reviewed.exempt_machine_paths).reduce((t, prefix) => t.split(prefix).join(''), text);
  if (!/\.(tgz|tar\.gz|tar)$/.test(path)) return [['', exempt(gunzipSync(readFileSync(path)).toString('utf8'))]];
  const dir = mkdtempSync(join(tmpdir(), 'receipt-members-'));
  try {
    execFileSync('tar', ['-xf', path, '-C', dir]);
    return (readdirSync(dir, { recursive: true }) as string[]).filter(f => statSync(join(dir, f)).isFile()).sort()
      .map(f => [f, exempt(readFileSync(join(dir, f), 'utf8'))]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Receipts under `root` outside `frozen` whose text matches `pattern`; a tarball or gzip receipt is read member by member. */
function offenders(root: string, files: string[], frozen: Record<string, string>, pattern: RegExp): string[] {
  return files.filter(f => !(f in frozen)).flatMap(f => /\.(tgz|tar|gz)$/.test(f)
    ? members(join(root, f)).filter(([, text]) => pattern.test(text)).map(([name]) => name ? `${f}: ${name}` : f)
    : /\.(json|ndjson|jsonl|log)$/.test(f) && pattern.test(readFileSync(join(root, f), 'utf8')) ? [f] : []);
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

  test('the only exemption is the harness VM overlay checkout, which still matches the machine-path pattern', () => {
    expect(Object.keys(reviewed.exempt_machine_paths)).toEqual(['/home/ubi/work/gbrain-evals/.gbrain-overlays/']);
    expect(MACHINE_LOCAL_PATH.test(`"${VM_OVERLAY}d7467d1cf/src/cli.ts"`)).toBe(true);
  });

  test('reviewed compressed receipts are unchanged', () => {
    const changed = Object.entries(reviewed.files).filter(([f, sha]) => sha256(join(ROOT, f)) !== sha);
    expect(changed).toEqual([]);
  });
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
