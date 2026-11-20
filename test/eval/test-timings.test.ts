import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunReports, fileTimes, medianTimings } from '../../scripts/test-timings.ts';

const report = (suites: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="3" time="2.5">\n${suites}</testsuites>\n`;

describe('test timings for time-balanced shards', () => {
  test('a file takes the time of its top-level testsuite, not of its describes', () => {
    const xml = report([
      '  <testsuite name="test/eval/a.test.ts" file="test/eval/a.test.ts" tests="2" time="1.2346">',
      '    <testsuite name="describe one" file="test/eval/a.test.ts" line="4" tests="2" time="0">',
      '      <testcase name="x" classname="describe one" time="1.1" file="test/eval/a.test.ts" />',
      '    </testsuite>',
      '  </testsuite>',
      '  <testsuite name="eval/b.test.ts" file="eval/b.test.ts" tests="1" time="0.0004">',
      '    <testcase name="y" time="0.0004" file="eval/b.test.ts" />',
      '  </testsuite>',
      '',
    ].join('\n'));
    expect(fileTimes(xml)).toEqual({ 'test/eval/a.test.ts': 1235, 'eval/b.test.ts': 0 });
    expect(() => fileTimes(report('  <testsuite name="no file" tests="0" time="1">\n  </testsuite>\n'))).toThrow(/no file or time/);
  });

  test("a run's download directory yields the shards' Bun reports, not the harness pytest report that shares the tested-files-* pattern", () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-timings-'));
    try {
      for (const [sub, file] of [['tested-files-2', 'tests-2.xml'], ['tested-files-1', 'tests-1.xml'], ['tested-files-pytest', 'pytest.xml'], ['tested-files-pytest', 'pytest-2.xml']]) {
        mkdirSync(join(dir, sub!), { recursive: true });
        writeFileSync(join(dir, sub!, file!), '<testsuites />');
      }
      expect(bunReports(dir)).toEqual([join('tested-files-1', 'tests-1.xml'), join('tested-files-2', 'tests-2.xml')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('each file gets its median time across runs, and files come out sorted', () => {
    expect(medianTimings([{ 'b.test.ts': 30, 'a.test.ts': 5 }, { 'b.test.ts': 10, 'a.test.ts': 6 }, { 'b.test.ts': 20 }])).toEqual({ version: 1, files: { 'a.test.ts': 6, 'b.test.ts': 20 } });
    expect(Object.keys(medianTimings([{ 'z.test.ts': 1, 'a.test.ts': 1 }]).files)).toEqual(['a.test.ts', 'z.test.ts']);
  });

  test('CI and the local shard runner read the committed timings, which name repo-relative files in whole ms', () => {
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const shards = readFileSync(new URL('../../scripts/test-shards.ts', import.meta.url), 'utf8');
    expect(ci).toContain('--timings=test/timings.json');
    expect(shards).toContain("'--timings=test/timings.json'");
    const timings = JSON.parse(readFileSync(new URL('../timings.json', import.meta.url), 'utf8'));
    expect(timings.version).toBe(1);
    const entries = Object.entries<number>(timings.files);
    expect(entries.length).toBeGreaterThan(0);
    for (const [file, ms] of entries) {
      expect(file).toMatch(/^(test\/eval|eval)\/.+\.test\.ts$/);
      expect(Number.isSafeInteger(ms) && ms >= 0).toBe(true);
    }
  });
});
