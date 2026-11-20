import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const policy = JSON.parse(readFileSync(new URL('../../.gstack/ship-policy.json', import.meta.url), 'utf8')) as { review_exclude_paths: string[] };
const GLOBS = ['docs/benchmarks/2026-11-19-cat40-hard-newest/n[12]/*/**', 'docs/benchmarks/2026-11-19-cat40-hard-old-build-control/n[12]/*/**'];
const NEW = 'docs/benchmarks/2026-11-19-cat40-hard-newest';
const OLD = 'docs/benchmarks/2026-11-19-cat40-hard-old-build-control';

const excluded = [
  ...['n1', 'n2'].flatMap(w => [
    `${NEW}/${w}/gbrain-opus-a/attempts.jsonl`,
    `${NEW}/${w}/fs-particle/receipt-1795151566657.json`,
    `${NEW}/${w}/gbrain-particle/served-tools.json`,
    `${OLD}/${w}/gbrain-old-opus/attempts.jsonl`,
    `${OLD}/${w}/slots/receipt-1.json`,
  ]),
];
const kept = [
  `${NEW}.md`,
  `${NEW}-preregistration.md`,
  `${NEW}/analysis/final.json`,
  `${NEW}/analysis/interim.json`,
  `${NEW}/n1/oracle-gate.json`,
  `${NEW}/n2/oracle-gate.json`,
  `${NEW}/n3/gbrain-opus-a/attempts.jsonl`,
  `${OLD}.md`,
  `${OLD}/analysis/control.json`,
  'docs/benchmarks/2026-11-20-cat40-hard-newest/n1/gbrain-opus-a/attempts.jsonl',
  'eval/runner/cat40/newest_analysis.py',
  'README.md',
];

describe('ship policy: reviewers leave out the hard company questions raw per-step data', () => {
  test('lists the two globs', () => {
    for (const glob of GLOBS) expect(policy.review_exclude_paths).toContain(glob);
  });

  test("git's glob dialect matches the arm folders inside the two runs' per-world folders only", () => {
    const repo = mkdtempSync(join(tmpdir(), 'review-exclude-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      git('init', '-q');
      for (const path of [...excluded, ...kept]) {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        writeFileSync(join(repo, path), '');
      }
      git('add', '-A');
      const matched = git('ls-files', '-z', '--', ...GLOBS.map(g => `:(top,glob)${g}`)).split('\0').filter(Boolean).sort();
      expect(matched).toEqual([...excluded].sort());
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
