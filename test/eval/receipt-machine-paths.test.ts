/**
 * Machine-local paths in committed receipts (docs audit B11).
 *
 * writeReceipt rewrites checkout, home and temp paths before writing. This
 * test scans every committed receipt-like file (JSON, NDJSON, JSONL, logs)
 * under docs/benchmarks, results, baselines and qrels. A file may contain a
 * machine-local path only if it is one of the historical receipts frozen, by
 * hash, in fixtures/historical-machine-local-paths.json; those stay
 * byte-for-byte as evidence and may not change.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MACHINE_LOCAL_PATH, scrubMachinePaths } from '../../eval/runner/receipt.ts';

const ROOT = resolve(import.meta.dir, '../..');
const historical = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/historical-machine-local-paths.json'), 'utf8')) as { files: Record<string, string> }).files;

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
});

describe('committed receipts', () => {
  const files = execFileSync('git', ['ls-files', 'docs/benchmarks', 'results', 'baselines', 'qrels'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n').filter(f => /\.(json|ndjson|jsonl|log)$/.test(f));

  test('no receipt outside the frozen historical list contains a machine-local path', () => {
    const offenders = files.filter(f => !(f in historical) && MACHINE_LOCAL_PATH.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('historical receipts with machine-local paths are unchanged', () => {
    const changed = Object.entries(historical).filter(([f, sha]) => createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex') !== sha);
    expect(changed).toEqual([]);
  });
});
