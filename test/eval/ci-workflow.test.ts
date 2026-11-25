import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

function runLines(): string[] {
  return [...workflow.matchAll(/^\s+run: (.+)$/gm)].map(m => m[1]);
}

describe('CI workflow gates (audit C5 to C8)', () => {
  test('tsc gates run unfiltered, so dependency diagnostics fail too', () => {
    expect(runLines()).toContain('bun run typecheck');
    expect(pkg.scripts.typecheck).toBe('NODE_OPTIONS=--max-old-space-size=8192 tsc --noEmit && tsc --noEmit -p tsconfig.scripts.json');
    expect(workflow).not.toContain('node_modules/');
    expect(workflow).not.toMatch(/tsc[^\n]*\|/);
  });

  test('every step fails on its own exit code', () => {
    const exempt = /\n {6}- id: ([\w-]+)\n {8}uses: actions\/cache\/restore@\S+ # v4\.3\.0\n {8}continue-on-error: true\n {8}timeout-minutes: 2\n {8}with:\n {10}path: \.git\n(?: {10}.*\n)+\n {6}- if: steps\.\1\.outcome == 'failure'\n {8}name: Drop a partly restored git cache\n {8}run: rm -rf \.git\n/g;
    const save = /\n {8}uses: actions\/cache\/save@\S+ # v4\.3\.0\n {8}continue-on-error: true\n {8}timeout-minutes: 5\n/g;
    const pack = /\n {6}- id: harness-pack\n {8}uses: actions\/cache\/restore@\S+ # v4\.3\.0\n {8}continue-on-error: true\n {8}timeout-minutes: 2\n {8}with:\n {10}path: \.harness\/packs\n(?: {10}.*\n)+\n {6}- if: steps\.harness-pack\.outcome == 'failure'\n {8}name: Drop a partly restored harness pack\n {8}run: rm -rf \.harness\/packs\n/g;
    expect([...workflow.matchAll(exempt)]).toHaveLength(9);
    expect([...workflow.matchAll(pack)]).toHaveLength(1);
    expect([...workflow.matchAll(save)]).toHaveLength(2);
    expect(workflow).toContain("      - if: steps.harness-pack.outcome == 'success' && steps.harness-pack.outputs.cache-hit != 'true'\n        uses: actions/cache/save@");
    expect(workflow.replace(exempt, '\n').replace(pack, '\n').replace(save, '\n')).not.toContain('continue-on-error');
    for (const line of runLines()) {
      expect(line).not.toMatch(/\|\|\s*(true|:)/);
      expect(line).not.toMatch(/\|(?!\|)/);
    }
  });

  test('the offline BrainBench tier runs through all.ts in three shards, each under the 900 s bound, so gated categories fail CI', () => {
    expect(runLines()).toContain('BRAINBENCH_ALLOW_SKIP=1 BRAINBENCH_BOUND_S=900 timeout 900 bun run eval:brainbench --shard ${{ matrix.shard }}/3');
    const job = workflow.slice(workflow.indexOf('\n  brainbench:'));
    expect(job).toMatch(/^\n  brainbench:\n(?:.*\n)*?\s+shard: \[1, 2, 3\]/);
    expect(pkg.scripts['eval:brainbench']).toBe('bun eval/runner/all.ts --tier offline');
  });

  test('the person-isolation ci profile runs keyless on Postgres pinned by digest, and its reports are never uploaded', () => {
    expect(runLines()).toContain('env -i PATH="$PATH" HOME="$HOME" PI_PG_URL=postgres://postgres@127.0.0.1:55432/postgres timeout 1500 bun eval/runner/person-isolation-fuzz.ts --profile ci --cells mcp-dispatch-postgres,http-postgres --output "$RUNNER_TEMP/person-isolation-postgres"');
    const start = workflow.indexOf('\n  person-isolation-postgres:');
    const end = workflow.slice(start + 1).search(/\n  [a-z-]+:\n/);
    const job = workflow.slice(start, start + 1 + end);
    expect(job).toMatch(/\n {8}image: pgvector\/pgvector@sha256:[0-9a-f]{64}\n/);
    expect(job).not.toContain('upload-artifact@');
    expect(workflow).not.toMatch(/path: eval\/reports\/?\n/);
    expect(workflow.split('            eval/reports/\n            !eval/reports/person-isolation-fuzz/\n')).toHaveLength(3);
  });

  test('colocated eval/ unit tests, Python tests and validators all run', () => {
    expect(workflow).toContain('bun scripts/test-shards.ts --job=${{ matrix.shard }}/${{ strategy.job-total }} --junit-dir="$RUNNER_TEMP/tested-files" test/eval/ eval/');
    expect(readFileSync(new URL('../../scripts/test-shards.ts', import.meta.url), 'utf8')).toContain("'--timings=test/timings.json'");
    for (const line of runLines()) expect(line).not.toContain('--parallel');
    expect(workflow).toContain('python3 test/retrieval_refresh_orchestrator_test.py');
    expect(runLines()).toContain('bun run validate');
    for (const check of ['verify-published-longmemeval.py', 'verify-documentation-refresh.py', 'check-links.py', 'eval:query:validate', 'validate-data.ts']) {
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
    expect(workflow).toMatch(/shard: \[1, 2, 3, 4, 5, 6\]/);
  });

  test('the Bun version CI installs supports --shard', () => {
    const version = /bun-version: (\d+)\.(\d+)\.(\d+)/.exec(workflow)!.slice(1).map(Number);
    expect(version[0] * 1e6 + version[1] * 1e3 + version[2]).toBeGreaterThanOrEqual(1_003_014);
  });

  test('every job installs the Bun version package.json requires', () => {
    const versions = [...workflow.matchAll(/bun-version: (\S+)/g)].map(m => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    expect(pkg.engines.bun).toMatch(/^>=\d+\.\d+\.\d+$/);
    expect([...new Set(versions)]).toEqual([pkg.engines.bun.replace(/^>=/, '')]);
  });
});

// Value: protects=the one check the main branch's ruleset requires; fails_when=a job the merge waits on can fail, be cancelled or be skipped while merge-gate passes or is skipped, which GitHub reads as passing; seam=ci.yml and .gstack/ship-policy.json as text, keyless; no_claim=how GitHub evaluates the expressions at run time
describe('merge gate', () => {
  const gate = workflow.slice(workflow.indexOf('\n  merge-gate:'), workflow.indexOf('\n  # The head-to-head scoreboard'));
  const needs = (job: string) => /needs: \[([^\]]*)\]/.exec(workflow.slice(workflow.indexOf(`\n  ${job}:`)))![1]!.split(',').map(s => s.trim());

  test('runs even when a needed job fails, and fails on any result but success', () => {
    expect(gate).toMatch(/^\n  merge-gate:\n    if: always\(\)\n/);
    expect(gate).toContain("if: always() && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped'))");
    expect(gate).toContain('run: exit 1');
  });

  test('needs every check the merge waits on and every job tested-tree needs', () => {
    const policy = JSON.parse(readFileSync(new URL('../../.gstack/ship-policy.json', import.meta.url), 'utf8'));
    const gateNeeds = needs('merge-gate');
    for (const check of policy.changelog_fragments.required_checks as string[]) expect(gateNeeds).toContain(check.replace(/ \(\d+\)$/, ''));
    for (const job of needs('tested-tree')) expect(gateNeeds).toContain(job);
  });

  test('no job is path-filtered, so every pull request reports the gate', () => {
    expect(workflow).toMatch(/^on:\n  pull_request:\n  push:\n/m);
    expect(workflow).not.toMatch(/paths(-ignore)?:/);
  });
});

describe('link check (docs audit B12)', () => {
  test('a weekly job fetches external links as well as local ones', () => {
    const links = readFileSync(new URL('../../.github/workflows/links.yml', import.meta.url), 'utf8');
    expect(links).toMatch(/schedule:/);
    expect(links).toContain('run: python3 scripts/check-links.py --external');
    expect(links).toMatch(/timeout-minutes: \d+/);
  });
});

describe('test-shards jobs', () => {
  test('six jobs of four processes run each of the 24 shards exactly once', async () => {
    const { jobShards } = await import('../../scripts/test-shards.ts');
    const all = [1, 2, 3, 4, 5, 6].flatMap(k => { const { shards, of } = jobShards(k, 6, 4); expect(of).toBe(24); return shards; });
    expect(all.sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(jobShards(1, 1, 4)).toEqual({ shards: [1, 2, 3, 4], of: 4 });
    expect(() => jobShards(7, 6, 4)).toThrow();
    expect(() => jobShards(1, 6, 0)).toThrow();
  });

  test('CI runs four processes per test job on an 8-vCPU runner, in six jobs', () => {
    const job = workflow.slice(workflow.indexOf('\n  tests:'), workflow.indexOf('\n  tested-tree:'));
    expect(job).toContain("TEST_SHARDS: '4'");
    expect(job).toContain('runs-on: ubicloud-standard-8-');
    expect(job).toContain('shard: [1, 2, 3, 4, 5, 6]');
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
