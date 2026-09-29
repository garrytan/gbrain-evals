import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

function runLines(): string[] {
  return [...workflow.matchAll(/^\s+run: (.+)$/gm)].map(m => m[1]);
}

describe('CI workflow gates (audit C5 to C8)', () => {
  test('tsc gates run unfiltered, so dependency diagnostics fail too', () => {
    expect(runLines()).toContain('bunx tsc --noEmit');
    expect(runLines()).toContain('bunx tsc --noEmit -p tsconfig.scripts.json');
    expect(workflow).not.toContain('node_modules/');
    expect(workflow).not.toMatch(/tsc[^\n]*\|/);
  });

  test('every step fails on its own exit code', () => {
    expect(workflow).not.toContain('continue-on-error');
    for (const line of runLines()) {
      expect(line).not.toMatch(/\|\|\s*(true|:)/);
      expect(line).not.toMatch(/\|(?!\|)/);
    }
  });

  test('the offline BrainBench tier runs through all.ts, so gated categories fail CI', () => {
    expect(runLines()).toContain('BRAINBENCH_ALLOW_SKIP=1 timeout 900 bun run eval:brainbench');
    expect(pkg.scripts['eval:brainbench']).toBe('bun eval/runner/all.ts --tier offline');
  });

  test('colocated eval/ unit tests, Python tests and validators all run', () => {
    expect(workflow).toContain('bun test --shard=${{ matrix.shard }}/4 test/eval/ eval/');
    for (const line of runLines()) expect(line).not.toContain('--parallel');
    expect(workflow).toContain('python3 test/retrieval_refresh_orchestrator_test.py');
    expect(runLines()).toContain('bun run validate');
    for (const check of ['verify-published-longmemeval.py', 'verify-documentation-refresh.py', 'eval:query:validate', 'validate-data.ts']) {
      expect(pkg.scripts.validate).toContain(check);
    }
    expect(pkg.scripts['test:unit']).toBe('bun scripts/test-shards.ts');
    expect(pkg.scripts.test).toContain('scripts/test-shards.ts');
    expect(pkg.scripts.test).toContain('test:py');
    expect(pkg.scripts.test).toContain('validate');
  });

  test('every job has a timeout and the suite is sharded', () => {
    const jobs = workflow.slice(workflow.indexOf('\njobs:')).split(/^  (?=\w[\w-]*:\n)/m).slice(1);
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    for (const job of jobs) expect(job).toMatch(/timeout-minutes: \d+/);
    expect(workflow).toMatch(/shard: \[1, 2, 3, 4\]/);
  });

  test('the Bun version CI installs supports --shard', () => {
    const version = /bun-version: (\d+)\.(\d+)\.(\d+)/.exec(workflow)!.slice(1).map(Number);
    expect(version[0] * 1e6 + version[1] * 1e3 + version[2]).toBeGreaterThanOrEqual(1_003_014);
  });
});

describe('test-shards summary', () => {
  test('sums every shard and names failing shards', async () => {
    const { summarize } = await import('../../scripts/test-shards.ts');
    const summary = summarize([
      { shard: 1, code: 0, output: '(pass) a\n 10 pass\n 1 skip\n 0 fail\n' },
      { shard: 2, code: 1, output: '(fail) b\n 4 pass\n 2 fail\n' },
      { shard: 3, code: 1, output: 'worker crashed before printing a summary' },
    ]);
    expect(summary).toEqual({ pass: 14, fail: 2, skip: 1, failedShards: [2, 3] });
  });
});
