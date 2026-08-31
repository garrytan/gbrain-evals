/**
 * Shell-script integration tests with stub executables (WS7).
 *
 * `bash -n` cannot catch the ${var:+VAR=val} class: the phase1 script's
 * env-prefix expansion made 4 of 7 cells die with exit 127 while printing
 * "-> done" (audit orchestrators-01/05). These tests run the REAL scripts
 * with a stub `gbrain`/`bun`/python on PATH that records argv + env, and
 * assert the config actually reaches the child, failures propagate, and
 * cells are labeled.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = join(import.meta.dir, '../..');
let sandbox: string;
let stubBin: string;
let recordDir: string;
let fakeLmeRepo: string;
let fakeDataset: string;

function writeStub(name: string, script: string): void {
  const p = join(stubBin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(p, 0o755);
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'shootout-test-'));
  stubBin = join(sandbox, 'bin');
  recordDir = join(sandbox, 'record');
  fakeLmeRepo = join(sandbox, 'LongMemEval');
  mkdirSync(stubBin, { recursive: true });
  mkdirSync(recordDir, { recursive: true });
  mkdirSync(join(fakeLmeRepo, 'src/evaluation'), { recursive: true });
  mkdirSync(join(fakeLmeRepo, '.venv/bin'), { recursive: true });

  fakeDataset = join(sandbox, 'longmemeval_s.json');
  writeFileSync(fakeDataset, '[]');
  // evaluate_qa.py stub: records argv.
  writeFileSync(join(fakeLmeRepo, 'src/evaluation/evaluate_qa.py'), '# stub');
  writeFileSync(
    join(fakeLmeRepo, '.venv/bin/python'),
    `#!/usr/bin/env bash\necho "PYTHON_ARGV $@" >> "${recordDir}/evaluate_qa.argv"\nexit 0\n`,
  );
  chmodSync(join(fakeLmeRepo, '.venv/bin/python'), 0o755);

  // gbrain stub: --version prints a modern version; `eval longmemeval`
  // records argv + the embedding env vars and writes the --output file.
  writeStub('gbrain', `
if [ "$1" = "--version" ]; then echo "gbrain 0.47.6.0"; exit 0; fi
echo "GBRAIN_ARGV $@" >> "${recordDir}/gbrain.argv"
echo "GBRAIN_ENV model=\${GBRAIN_EMBEDDING_MODEL:-unset} dims=\${GBRAIN_EMBEDDING_DIMENSIONS:-unset} dead_reranker=\${GBRAIN_RERANKER_MODEL:-unset}" >> "${recordDir}/gbrain.env"
if [ -n "\${GBRAIN_STUB_FAIL:-}" ]; then exit 9; fi
out=""
prev=""
for a in "$@"; do if [ "$prev" = "--output" ]; then out="$a"; fi; prev="$a"; done
[ -n "$out" ] && echo '{"q":1}' > "$out"
exit 0`);

  // bun stub: the phase1 smoke gate shells out to \`bun run smoke.ts ...\` —
  // record and succeed so the script proceeds to the gbrain invocation.
  writeStub('bun', `echo "BUN_ARGV $@" >> "${recordDir}/bun.argv"\nexit 0`);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
  // Remove run artifacts the script wrote into the repo's results dir.
  const resultsDir = join(REPO, 'results/shootout');
  for (const f of existsSync(resultsDir) ? readdirSync(resultsDir) : []) {
    if (/^longmemeval-/.test(f) || f === 'phase1-run-log.txt') {
      rmSync(join(resultsDir, f), { force: true });
    }
  }
});

function runPhase1(extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [join(REPO, 'scripts/run-shootout-phase1.sh')], {
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH}`,
      OPENAI_API_KEY: 'k',
      ANTHROPIC_API_KEY: 'k',
      VOYAGE_API_KEY: 'k',
      ZEROENTROPY_API_KEY: 'k',
      LONGMEMEVAL_REPO: fakeLmeRepo,
      LONGMEMEVAL_DATASET: fakeDataset,
      ...extraEnv,
    },
    cwd: sandbox, // results/ land under a throwaway CWD? no — script cds to repo; results dir is in-repo
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('run-shootout-phase1.sh with stub gbrain', () => {
  test('no-reranker cells reach gbrain with env config; reranker cells are refused, not silently unreranked', () => {
    // Clean any prior state the script might resume from.
    const resultsDir = join(REPO, 'results/shootout');
    for (const f of existsSync(resultsDir) ? readdirSync(resultsDir) : []) {
      if (/^longmemeval-.*\.(jsonl|json|log)$/.test(f) || f.startsWith('phase1-run-log')) {
        rmSync(join(resultsDir, f), { force: true });
      }
    }
    rmSync(join(recordDir, 'gbrain.argv'), { force: true });
    rmSync(join(recordDir, 'gbrain.env'), { force: true });

    const res = runPhase1();
    const stdout = res.stdout + res.stderr;

    // Version gate accepts a NEWER gbrain than the old 0.35-0.36 allowlist.
    expect(stdout).not.toContain('need >= 0.35.1.0');

    // The three no-reranker cells (A0, B0, C0) invoked gbrain...
    const argv = readFileSync(join(recordDir, 'gbrain.argv'), 'utf8');
    const invocations = argv.trim().split('\n');
    expect(invocations.length).toBe(3);
    expect(argv).toContain('--mode tokenmax');
    expect(argv).toContain('--expansion');

    // ...and the embedding env ACTUALLY reached the child (the old
    // ${var:+X=y} prefix form never did — exit 127).
    const env = readFileSync(join(recordDir, 'gbrain.env'), 'utf8');
    expect(env).toContain('model=openai:text-embedding-3-large dims=1536');
    expect(env).toContain('model=voyage:voyage-4-large dims=2048');
    expect(env).toContain('model=zeroentropyai:zembed-1 dims=2560');
    // The dead reranker env var is never set for any cell.
    expect(env).not.toContain('dead_reranker=zeroentropyai');

    // Reranker cells refused loudly (labeled SKIPPED), not run unreranked.
    expect(stdout).toContain('SKIPPED');
    expect(stdout).toMatch(/A1[\s\S]*SKIPPED|SKIPPED[\s\S]*A1/);

    // Scoring used the published positional evaluate_qa interface.
    const qaArgv = readFileSync(join(recordDir, 'evaluate_qa.argv'), 'utf8');
    expect(qaArgv).toContain('gpt-4o');
    expect(qaArgv).not.toContain('--input');

    // Exit 0: skips are acknowledged, no failures.
    expect(res.status).toBe(0);
  }, 60_000);

  test('a failing gbrain run fails the cell AND the script exit code', () => {
    const resultsDir = join(REPO, 'results/shootout');
    for (const f of existsSync(resultsDir) ? readdirSync(resultsDir) : []) {
      if (/^longmemeval-.*\.(jsonl|json|log)$/.test(f) || f.startsWith('phase1-run-log')) {
        rmSync(join(resultsDir, f), { force: true });
      }
    }
    const res = runPhase1({ GBRAIN_STUB_FAIL: '1' });
    const stdout = res.stdout + res.stderr;
    expect(stdout).toContain('FAILED');
    // The old script printed "-> done" and exited 0 on exactly this path.
    expect(res.status).not.toBe(0);
  }, 60_000);
});
