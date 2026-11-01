/**
 * Value: protects=eval/harness-provider/mpw_tools/equivalence_report.py refuses to rewrite a report.json under
 *   docs/benchmarks (#222), whose committed copy docs/receipts-manifest.json pins by sha256, and still writes a copy's;
 *   fails_when=the script writes into a published receipt directory again, directly, through a copy's report.json that
 *   is a symbolic link into one, or through one that is a hard link to the committed file, or refuses a copy outside
 *   docs/benchmarks;
 *   why_new=no test ran the script, and its documented usage pointed at the committed directory;
 *   seam=a temporary tree shaped like the repository, so the script's own location decides what is published;
 *   no_claim=that a copy reproduces the committed report (its extract_stale inputs were never committed).
 */
import { describe, expect, test } from 'bun:test';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '../../eval/harness-provider/mpw_tools/equivalence_report.py');
const PINNED = '{"pinned": true}\n';
const PUBLISHED_DIR = 'docs/benchmarks/2026-10-10-memory-proof-wave-equivalence';

/** Runs the script on rootFromRepo. With linked, the committed report.json lives in PUBLISHED_DIR and the root's report.json is a symbolic or hard link to it. */
function run(rootFromRepo: string, linked?: 'symbolic' | 'hard') {
  const repo = mkdtempSync(join(tmpdir(), 'mpw-equivalence-'));
  try {
    mkdirSync(join(repo, 'eval/harness-provider/mpw_tools'), { recursive: true });
    copyFileSync(SCRIPT, join(repo, 'eval/harness-provider/mpw_tools/equivalence_report.py'));
    const root = join(repo, rootFromRepo);
    const report = join(repo, linked ? PUBLISHED_DIR : rootFromRepo, 'report.json');
    mkdirSync(root, { recursive: true });
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, PINNED);
    if (linked === 'symbolic') symlinkSync(report, join(root, 'report.json'));
    if (linked === 'hard') linkSync(report, join(root, 'report.json'));
    const p = Bun.spawnSync(['python3', join(repo, 'eval/harness-provider/mpw_tools/equivalence_report.py'), root], { stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, err: p.stderr.toString(), report: readFileSync(report, 'utf8'), copy: readFileSync(join(root, 'report.json'), 'utf8') };
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

describe('equivalence_report.py', () => {
  test('refuses to rewrite a report.json under docs/benchmarks and leaves it unchanged', () => {
    const r = run(PUBLISHED_DIR);
    expect(r.code).toBe(2);
    expect(r.err).toContain('run it on a copy');
    expect(r.report).toBe(PINNED);
  });

  test('refuses a copy whose report.json is a symbolic link into docs/benchmarks and leaves the linked report unchanged', () => {
    const r = run('scratch/eq', 'symbolic');
    expect(r.code).toBe(2);
    expect(r.err).toContain('run it on a copy');
    expect(r.report).toBe(PINNED);
  });

  test('writes a copy whose report.json is a hard link to the committed one without changing the committed file', () => {
    const r = run('scratch/eq', 'hard');
    expect(r.code).toBe(0);
    expect(r.report).toBe(PINNED);
    expect(JSON.parse(r.copy)).toEqual({});
  });

  test('writes report.json in a copy outside docs/benchmarks', () => {
    const r = run('scratch/eq');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.report)).toEqual({});
  });
});
