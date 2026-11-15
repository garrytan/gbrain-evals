import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory, isBunTestFile, junitFiles, PYTHON_TESTS, treeRecord } from '../../scripts/ci-tested-tree.ts';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const pregate = JSON.parse(read('.gstack/pregate.json'));
const pkg = JSON.parse(read('package.json'));
const job = (name: string) => { const at = workflow.indexOf(`\n  ${name}:\n`); expect(at).toBeGreaterThan(0); const rest = workflow.slice(at + 1); const next = rest.slice(1).search(/\n {2}(?=[\w-]+:\n)/); return next < 0 ? rest : rest.slice(0, next + 1); };

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const ENV = { GITHUB_SHA: SHA_A, GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '2', GITHUB_WORKFLOW_REF: 'garrytan/gbrain-evals/.github/workflows/ci.yml@refs/heads/main', RUNNER_OS: 'Linux' };

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="7" assertions="9" failures="0" skipped="2" time="1.2">
  <testsuite name="test/eval/a.test.ts" file="test/eval/a.test.ts" tests="5" skipped="2">
    <testsuite name="nested &amp; grouped" file="test/eval/a.test.ts" line="3" tests="3">
      <testcase name="x" file="test/eval/a.test.ts" line="4" />
    </testsuite>
  </testsuite>
  <testsuite name="eval/runner/b&amp;c.test.ts" file="eval/runner/b&amp;c.test.ts" tests="2" />
</testsuites>
`;

describe('ci-tested-tree inventory', () => {
  test('matches the files Bun discovers under the suite roots, plus the Python tests for the full lane', () => {
    const tracked = ['test/eval/a.test.ts', 'eval/runner/b_test.ts', 'eval/runner/c.spec.tsx', 'eval/runner/helper.ts', 'test/support/x.test.ts', 'docs/eval/y.test.ts', 'eval/data/notes.md'];
    expect(inventory('unit', tracked)).toEqual(['eval/runner/b_test.ts', 'eval/runner/c.spec.tsx', 'test/eval/a.test.ts']);
    expect(inventory('test', tracked)).toEqual([...inventory('unit', tracked), ...PYTHON_TESTS]);
    expect(inventory('py', tracked)).toEqual(PYTHON_TESTS);
    expect(isBunTestFile('test/eval/a.test.mts')).toBe(true);
    expect(isBunTestFile('test/eval/a.test.json')).toBe(false);
  });

  test('lists this tree: every tracked Bun test under the roots and the Python tests the checks job runs', () => {
    const r = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', 'scripts/ci-tested-tree.ts', 'inventory', '--lane', 'test'], { cwd: root, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const files = r.stdout.trim().split('\n');
    expect(files).toContain('test/eval/ci-workflow.test.ts');
    expect(files).toContain('eval/generators/world-html.test.ts');
    expect(files.at(-1)).toBe(PYTHON_TESTS.at(-1));
    expect(job('checks')).toContain(`run: python3 ${PYTHON_TESTS.join(' ')}`);
    expect(pkg.scripts['test:py']).toBe(`python3 ${PYTHON_TESTS.join(' ')}`);
  });
});

describe('ci-tested-tree record', () => {
  test('reads the files a JUnit report ran and counts the tests that ran', () => {
    expect(junitFiles(JUNIT)).toEqual({ files: ['eval/runner/b&c.test.ts', 'test/eval/a.test.ts'], tests: 5 });
    expect(() => junitFiles('<testsuite file="a.test.ts" />')).toThrow('no <testsuites>');
    expect(() => junitFiles('<testsuites tests="2" skipped="3"></testsuites>')).toThrow('valid tests');
    expect(() => junitFiles('<testsuites name="bun test"></testsuites>')).toThrow('valid tests');
  });

  test("reads Bun's own JUnit report: repo-relative files, skips excluded, and no entry for a file that registers no tests", () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-tested-tree-'));
    try {
      writeFileSync(join(dir, 'ran.test.ts'), "import { test } from 'bun:test';\ntest('runs', () => {});\ntest.skip('skipped', () => {});\n");
      writeFileSync(join(dir, 'skipped.test.ts'), "import { test } from 'bun:test';\ntest.skip('only skipped', () => {});\n");
      writeFileSync(join(dir, 'empty.test.ts'), "import { test } from 'bun:test';\nif (process.env.NEVER_SET_CI_TESTED_TREE) test('never registered', () => {});\n");
      const r = spawnSync(process.execPath, ['test', '--reporter=junit', '--reporter-outfile=out.xml', 'ran.test.ts', 'skipped.test.ts', 'empty.test.ts'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(junitFiles(readFileSync(join(dir, 'out.xml'), 'utf8'))).toEqual({ files: ['ran.test.ts', 'skipped.test.ts'], tests: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a push run records its own commit as the head; a pull_request run records the merge commit and the head', () => {
    const reports = [junitFiles(JUNIT), { files: ['test/eval/a.test.ts', 'test/eval/d.test.ts'], tests: 4 }];
    const push = treeRecord(ENV, { reports, tree: TREE });
    expect(push).toEqual({ run_id: 41, run_attempt: 2, event: 'push', sha: SHA_A, head_sha: SHA_A, tree: TREE, workflow: '.github/workflows/ci.yml', os: 'Linux', files: ['eval/runner/b&c.test.ts', 'test/eval/a.test.ts', 'test/eval/d.test.ts', ...PYTHON_TESTS], tests: 9 });
    const pr = treeRecord({ ...ENV, GITHUB_EVENT_NAME: 'pull_request', PR_HEAD_SHA: SHA_B }, { reports, tree: TREE });
    expect([pr.event, pr.sha, pr.head_sha]).toEqual(['pull_request', SHA_A, SHA_B]);
  });

  test('refuses a record it cannot make whole', () => {
    const reports = [junitFiles(JUNIT)];
    expect(() => treeRecord({ ...ENV, GITHUB_EVENT_NAME: 'pull_request' }, { reports, tree: TREE })).toThrow('PR_HEAD_SHA');
    expect(() => treeRecord({ ...ENV, GITHUB_SHA: 'abc' }, { reports, tree: TREE })).toThrow('GITHUB_SHA');
    expect(() => treeRecord({ ...ENV, GITHUB_EVENT_NAME: 'Push!' }, { reports, tree: TREE })).toThrow('GITHUB_EVENT_NAME');
    expect(() => treeRecord({ ...ENV, GITHUB_RUN_ATTEMPT: '0' }, { reports, tree: TREE })).toThrow('GITHUB_RUN_ATTEMPT');
    expect(() => treeRecord({ ...ENV, GITHUB_WORKFLOW_REF: 'nope' }, { reports, tree: TREE })).toThrow('GITHUB_WORKFLOW_REF');
    expect(() => treeRecord({ ...ENV, RUNNER_OS: undefined }, { reports, tree: TREE })).toThrow('RUNNER_OS');
    expect(() => treeRecord(ENV, { reports, tree: 'HEAD' })).toThrow('tree id');
    expect(() => treeRecord(ENV, { reports: [], tree: TREE })).toThrow('no JUnit report');
    expect(() => treeRecord(ENV, { reports: [{ files: [], tests: 0 }], tree: TREE })).toThrow('no test files');
  });

  test('the record command writes tree.json when every inventory file ran, and fails without writing when one did not', () => {
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
    const unit = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', 'scripts/ci-tested-tree.ts', 'inventory', '--lane', 'unit'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
    const dir = mkdtempSync(join(tmpdir(), 'ci-tested-tree-'));
    const env = { ...process.env, ...ENV, GITHUB_SHA: git('rev-parse', 'HEAD'), GITHUB_STEP_SUMMARY: join(dir, 'summary.md') };
    const junit = (files: string[]) => `<testsuites tests="${files.length}" skipped="0">${files.map(f => `<testsuite file="${f}" tests="1" />`).join('')}</testsuites>`;
    const record = (files: string[], out: string) => {
      mkdirSync(join(dir, out), { recursive: true });
      writeFileSync(join(dir, out, 'tests-1.xml'), junit(files));
      return spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', 'scripts/ci-tested-tree.ts', 'record', '--junit', join(dir, out), '--out', join(dir, out, 'tree.json')], { cwd: root, encoding: 'utf8', env });
    };
    try {
      const ok = record(unit, 'all');
      expect(ok.status).toBe(0);
      const tree = JSON.parse(readFileSync(join(dir, 'all', 'tree.json'), 'utf8'));
      expect([tree.tree, tree.head_sha, tree.files, tree.tests]).toEqual([git('rev-parse', 'HEAD^{tree}'), env.GITHUB_SHA, [...unit, ...PYTHON_TESTS].sort(), unit.length]);
      expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toStartWith(`TESTED_TREE: run 41/2 push head ${env.GITHUB_SHA.slice(0, 12)}`);
      const short = record(unit.slice(1), 'short');
      expect(short.status).toBe(1);
      expect(short.stdout).toContain(`::error::1 inventory file(s) did not run`);
      expect(short.stdout).toContain(unit[0]!);
      expect(short.stderr).toContain('tree.json was not written');
      expect(existsSync(join(dir, 'short', 'tree.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CI carry wiring (.gstack/pregate.json and ci.yml)', () => {
  const profile = pregate.run_profiles['ci-carry/tests'];

  test('the profile names this workflow, the tested-tree artifact and the jobs that ran the lanes', () => {
    const shards = /shard: \[([\d, ]+)\]/.exec(job('tests'))![1]!.split(', ');
    expect(profile).toEqual({ workflow: 'ci.yml', events: ['pull_request', 'push'], jobs: ['checks', ...shards.map(s => `tests (${s})`), 'tested-tree'], artifact: 'tested-tree', os: 'Linux' });
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n/m);
  });

  test('every shard uploads the JUnit report of the files it ran, and tested-tree records them after the checks job and every shard pass', () => {
    const tests = job('tests');
    expect(tests).toContain('bun test --shard=${{ matrix.shard }}/${{ strategy.job-total }} --timings=test/timings.json test/eval/ eval/ --reporter=junit --reporter-outfile="$RUNNER_TEMP/tests-${{ matrix.shard }}.xml"');
    expect(tests).toContain('name: tested-files-${{ matrix.shard }}');
    expect(tests).toContain('path: ${{ runner.temp }}/tests-${{ matrix.shard }}.xml');
    const record = job('tested-tree');
    expect(record).toContain('needs: [checks, tests]');
    expect(record).not.toMatch(/^\s+if:/m);
    expect(record).toContain('pattern: tested-files-*');
    expect(record).toContain('PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}');
    expect(record).toContain('run: bun scripts/ci-tested-tree.ts record --junit "$RUNNER_TEMP/tested-files" --out "$RUNNER_TEMP/tested-tree/tree.json"');
    expect(record).toContain(`name: ${profile.artifact}`);
    expect(record).toContain('path: ${{ runner.temp }}/tested-tree/tree.json');
  });

  test('ship_lanes_from maps the package.json test commands to their inventories', () => {
    const inv = (lane: string) => ({ profiles: ['ci-carry/tests'], inventory: `bun --no-env-file --config=/dev/null scripts/ci-tested-tree.ts inventory --lane ${lane}` });
    expect(pregate.ship_lanes_from).toEqual({ 'bun run test': inv('test'), 'TEST_SHARDS=1 bun run test': inv('test'), 'TEST_SHARDS=2 bun run test': inv('test'), 'bun run test:unit': inv('unit'), 'bun run test:py': inv('py') });
    expect(pkg.scripts.test).toBe('bun scripts/test-shards.ts && bun run test:py && bun run validate');
    expect(pkg.scripts['test:unit']).toBe('bun scripts/test-shards.ts');
    expect(job('checks')).toContain('run: bun run validate');
  });

  test('the repo floor is a gstack that reads ship_lanes_from (1.94.0.0)', () => {
    const floor = JSON.parse(read('.gstack/ship-policy.json')).min_gstack_version.split('.').map(Number);
    expect(floor.reduce((n: number, p: number) => n * 1000 + p, 0)).toBeGreaterThanOrEqual([1, 94, 0, 0].reduce((n, p) => n * 1000 + p, 0));
  });
});
