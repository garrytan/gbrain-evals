/**
 * Hermetic tests for the two remaining shootout-script findings:
 *
 * orchestrators-10 (scripts/run-shootout-phase1.sh): the header used to claim
 * a "$90/cell hard cap" that no code implemented. The claim is now a REAL
 * per-cell wall-clock cap (PHASE1_CELL_WALL_CAP_SECONDS via timeout(1)) on
 * the answer-gen step. These tests prove the cap can FAIL a cell (slow stub
 * gbrain + 1s cap → cell FAILED, script exit non-zero) and doesn't break the
 * happy path (fast stub + generous cap → exit 0).
 *
 * orchestrators-19 (scripts/run-shootout-phase2.sh): phase2 used to invoke
 * the driver with NO smoke gate, so a dim typo burned the full 240-page embed
 * spend before failing. These tests prove the gate runs BEFORE the driver,
 * a failing smoke aborts the cell without any driver invocation, and a
 * passing smoke still reaches the driver.
 *
 * Same stub-executable pattern as test/eval/shootout-scripts.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = join(import.meta.dir, '../..');
let sandbox: string;
let stubBin: string;
let recordDir: string;
let resultsDir: string;
let fakeLmeRepo: string;
let fakeDataset: string;

function writeStub(name: string, script: string): void {
  const p = join(stubBin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(p, 0o755);
}

// Every run gets a fresh sandboxed results dir via SHOOTOUT_RESULTS_DIR —
// the scripts must NEVER touch the repo's committed results/shootout/
// artifacts (brainbench-A0-*.json, phase2-run-log.txt) from a test.
function cleanResults(): void {
  rmSync(resultsDir, { recursive: true, force: true });
  mkdirSync(resultsDir, { recursive: true });
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'shootout-caps-test-'));
  stubBin = join(sandbox, 'bin');
  recordDir = join(sandbox, 'record');
  resultsDir = join(sandbox, 'results');
  fakeLmeRepo = join(sandbox, 'LongMemEval');
  mkdirSync(stubBin, { recursive: true });
  mkdirSync(recordDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(join(fakeLmeRepo, 'src/evaluation'), { recursive: true });
  mkdirSync(join(fakeLmeRepo, '.venv/bin'), { recursive: true });

  fakeDataset = join(sandbox, 'longmemeval_s.json');
  writeFileSync(fakeDataset, '[]');
  writeFileSync(join(fakeLmeRepo, 'src/evaluation/evaluate_qa.py'), '# stub');
  writeFileSync(join(fakeLmeRepo, '.venv/bin/python'), `#!/usr/bin/env bash\nexit 0\n`);
  chmodSync(join(fakeLmeRepo, '.venv/bin/python'), 0o755);

  // gbrain stub: optionally sleeps (to trip the wall cap), then writes --output.
  writeStub('gbrain', `
if [ "$1" = "--version" ]; then echo "gbrain 0.47.6.0"; exit 0; fi
if [ -n "\${GBRAIN_STUB_SLEEP:-}" ]; then sleep "\$GBRAIN_STUB_SLEEP"; fi
out=""
prev=""
for a in "$@"; do if [ "$prev" = "--output" ]; then out="$a"; fi; prev="$a"; done
[ -n "$out" ] && echo '{"q":1}' > "$out"
exit 0`);

  // bun stub (phase1 smoke + phase2 smoke/driver): records argv; the smoke
  // invocation fails when STUB_SMOKE_FAIL is set.
  writeStub('bun', `
echo "BUN_ARGV $@" >> "${recordDir}/bun.argv"
case "$*" in
  *smoke.ts*) if [ -n "\${STUB_SMOKE_FAIL:-}" ]; then exit 7; fi ;;
esac
exit 0`);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runPhase(script: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [join(REPO, 'scripts', script)], {
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH}`,
      OPENAI_API_KEY: 'k',
      ANTHROPIC_API_KEY: 'k',
      VOYAGE_API_KEY: 'k',
      ZEROENTROPY_API_KEY: 'k',
      LONGMEMEVAL_REPO: fakeLmeRepo,
      LONGMEMEVAL_DATASET: fakeDataset,
      SHOOTOUT_RESULTS_DIR: resultsDir,
      ...extraEnv,
    },
    cwd: sandbox,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('run-shootout-phase1.sh wall-clock cap (orchestrators-10)', () => {
  test('a cell exceeding PHASE1_CELL_WALL_CAP_SECONDS is killed, marked FAILED, and fails the script', () => {
    cleanResults();
    const res = runPhase('run-shootout-phase1.sh', {
      PHASE1_CELL_WALL_CAP_SECONDS: '1',
      GBRAIN_STUB_SLEEP: '5',
    });
    const out = res.stdout + res.stderr;
    expect(out).toContain('wall cap');
    expect(out).toContain('FAILED');
    expect(res.status).not.toBe(0);
  }, 120_000);

  test('a fast cell under a generous cap still completes (cap does not break the happy path)', () => {
    cleanResults();
    const res = runPhase('run-shootout-phase1.sh', {
      PHASE1_CELL_WALL_CAP_SECONDS: '60',
    });
    const out = res.stdout + res.stderr;
    expect(out).toContain('(wall cap: 60s)');
    // Reranker cells are refused by design; no FAILED cells.
    expect(out).not.toContain('answer-gen FAILED');
    expect(res.status).toBe(0);
  }, 120_000);
});

describe('run-shootout-phase2.sh smoke gate (orchestrators-19)', () => {
  test('failing smoke aborts every cell BEFORE the driver runs; script exits non-zero', () => {
    cleanResults();
    rmSync(join(recordDir, 'bun.argv'), { force: true });
    const res = runPhase('run-shootout-phase2.sh', { STUB_SMOKE_FAIL: '1' });
    const out = res.stdout + res.stderr;
    expect(out).toContain('smoke FAILED');
    expect(res.status).not.toBe(0);
    const argv = readFileSync(join(recordDir, 'bun.argv'), 'utf8');
    // The gate ran for each cell...
    expect(argv).toContain('smoke.ts');
    // ...and the expensive driver was NEVER reached.
    expect(argv).not.toContain('shootout-driver.ts');
  }, 120_000);

  test('passing smoke reaches the driver with the cell config; smoke precedes the driver per cell', () => {
    cleanResults();
    rmSync(join(recordDir, 'bun.argv'), { force: true });
    const res = runPhase('run-shootout-phase2.sh');
    expect(res.status).toBe(0);
    const argv = readFileSync(join(recordDir, 'bun.argv'), 'utf8');
    const lines = argv.trim().split('\n');
    const firstSmoke = lines.findIndex((l) => l.includes('smoke.ts'));
    const firstDriver = lines.findIndex((l) => l.includes('shootout-driver.ts'));
    expect(firstSmoke).toBeGreaterThanOrEqual(0);
    expect(firstDriver).toBeGreaterThan(firstSmoke);
    // Smoke gets the cell's embedder + dim (dim-typo class caught pre-spend),
    // and reranker cells pass the reranker through to smoke's phase-3 check.
    expect(argv).toMatch(/smoke\.ts --embedder openai:text-embedding-3-large --dim 1536\b/);
    expect(argv).toMatch(/smoke\.ts --embedder zeroentropyai:zembed-1 --dim 1280 --reranker zeroentropyai:zerank-2/);
    // Driver still runs both scorer passes per cell (7 cells × 2).
    expect(lines.filter((l) => l.includes('shootout-driver.ts')).length).toBe(14);
  }, 120_000);
});
