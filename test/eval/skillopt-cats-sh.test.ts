/**
 * Hermetic tests for eval/runner/run-skillopt-cats.sh
 * (audit finding orchestrators-14).
 *
 * The old suite recorded per-cat exit codes into the sentinel but never
 * aggregated them: the final mv/echo always succeeded, so the script exited 0
 * even when every cat failed — CI or a caller checking $? saw success. These
 * tests run the REAL script with a stub `bun` on PATH and prove both
 * directions: all-pass → exit 0; any-fail → exit 1 while the remaining cats
 * still run (continue-on-failure preserved).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = join(import.meta.dir, '../..');
const SCRIPT = join(REPO, 'eval/runner/run-skillopt-cats.sh');

let sandbox: string;
let stubBin: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'skillopt-cats-test-'));
  stubBin = join(sandbox, 'bin');
  mkdirSync(stubBin, { recursive: true });
  // Stub bun: exit FAIL_RC when the runner filename matches FAIL_CAT.
  const stub = join(stubBin, 'bun');
  writeFileSync(stub, `#!/usr/bin/env bash
if [ -n "\${FAIL_CAT:-}" ] && [[ "$1" == *"\${FAIL_CAT}"* ]]; then exit "\${FAIL_RC:-3}"; fi
exit 0
`);
  chmodSync(stub, 0o755);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runSuite(extraEnv: Record<string, string> = {}) {
  const sentinel = join(sandbox, `sentinel-${Date.now()}-${Math.floor(performance.now() * 1000)}.done`);
  const res = spawnSync('bash', [SCRIPT], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH}`,
      SKILLOPT_SENTINEL: sentinel,
      ...extraEnv,
    },
  });
  return { res, sentinel };
}

describe('run-skillopt-cats.sh (orchestrators-14)', () => {
  test('all cats pass → exit 0, sentinel records all four rc=0 lines', () => {
    const { res, sentinel } = runSuite();
    expect(res.status).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
    const lines = readFileSync(sentinel, 'utf8').trim().split('\n');
    expect(lines.length).toBe(4);
    for (const l of lines) expect(l).toMatch(/=0$/);
  }, 60_000);

  test('one failing cat → suite exits non-zero, but the other cats still ran', () => {
    const { res, sentinel } = runSuite({ FAIL_CAT: 'cat32', FAIL_RC: '3' });
    // The core regression: the old script exited 0 on exactly this path.
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('SUITE FAILED');
    const lines = readFileSync(sentinel, 'utf8').trim().split('\n');
    expect(lines.length).toBe(4); // continue-on-failure preserved
    expect(lines.find((l) => l.includes('cat32'))).toMatch(/=3$/);
    expect(lines.filter((l) => l.endsWith('=0')).length).toBe(3);
  }, 60_000);

  test('every cat failing → suite exits non-zero (never a vacuous pass)', () => {
    const { res, sentinel } = runSuite({ FAIL_CAT: 'skillopt', FAIL_RC: '1' });
    expect(res.status).not.toBe(0);
    const lines = readFileSync(sentinel, 'utf8').trim().split('\n');
    expect(lines.length).toBe(4);
    for (const l of lines) expect(l).toMatch(/=1$/);
  }, 60_000);
});
