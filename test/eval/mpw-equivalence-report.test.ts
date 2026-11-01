/**
 * Value: protects=eval/harness-provider/mpw_tools/equivalence_report.py refuses to rewrite a report.json under
 *   docs/benchmarks (#222), whose committed copy docs/receipts-manifest.json pins by sha256, and still writes a copy's;
 *   fails_when=the script writes into a published receipt directory again, or refuses a copy outside docs/benchmarks;
 *   why_new=no test ran the script, and its documented usage pointed at the committed directory;
 *   seam=a temporary tree shaped like the repository, so the script's own location decides what is published;
 *   no_claim=that a copy reproduces the committed report (its extract_stale inputs were never committed).
 */
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '../../eval/harness-provider/mpw_tools/equivalence_report.py');
const PINNED = '{"pinned": true}\n';

function run(rootFromRepo: string) {
  const repo = mkdtempSync(join(tmpdir(), 'mpw-equivalence-'));
  try {
    mkdirSync(join(repo, 'eval/harness-provider/mpw_tools'), { recursive: true });
    copyFileSync(SCRIPT, join(repo, 'eval/harness-provider/mpw_tools/equivalence_report.py'));
    const root = join(repo, rootFromRepo);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'report.json'), PINNED);
    const p = Bun.spawnSync(['python3', join(repo, 'eval/harness-provider/mpw_tools/equivalence_report.py'), root], { stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, err: p.stderr.toString(), report: readFileSync(join(root, 'report.json'), 'utf8') };
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

describe('equivalence_report.py', () => {
  test('refuses to rewrite a report.json under docs/benchmarks and leaves it unchanged', () => {
    const r = run('docs/benchmarks/2026-10-10-memory-proof-wave-equivalence');
    expect(r.code).toBe(2);
    expect(r.err).toContain('run it on a copy');
    expect(r.report).toBe(PINNED);
  });

  test('writes report.json in a copy outside docs/benchmarks', () => {
    const r = run('scratch/eq');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.report)).toEqual({});
  });
});
