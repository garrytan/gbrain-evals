import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const policy = JSON.parse(readFileSync(new URL('../../.gstack/ship-policy.json', import.meta.url), 'utf8')) as { review_exclude_paths: string[] };
const GLOB = 'docs/benchmarks/2026-11-24-person-isolation/**/*.json';
const D = 'docs/benchmarks/2026-11-24-person-isolation';
const excluded = ['v0.60.771.0/20261124/mcp-dispatch-postgres.json', 'v0.60.771.0/20261126/cli-pglite.json', 'v0.60.769.0/20261125/http-pglite.json'].map(p => `${D}/${p}`);
const kept = [
  'docs/benchmarks/2026-11-24-person-isolation.md',
  'docs/benchmarks/2026-11-24-person-isolation-preregistration.md',
  'docs/benchmarks/preregistrations.d/person-isolation.json',
  `${D}/README.md`,
  'eval/runner/person-isolation-fuzz.ts',
  'docs/benchmarks/2026-11-24-person-isolation-other/receipt.json',
];

describe("ship policy: reviewers leave out the person-isolation receipts", () => {
  // Value: protects=the review reads the person-isolation runner, plan and results page but not its 3.3 MB of run receipts; fails_when=the glob is dropped or widened to the page, the plan, its registry entry or the runner; why_new=the results pull request is over the review's 2 MB limit; seam=.gstack/ship-policy.json review_exclude_paths through git ls-files :(glob); no_claim=gstack's own use of the list
  test("lists the glob, and git's glob dialect matches the receipts only", () => {
    expect(policy.review_exclude_paths).toContain(GLOB);
    const repo = mkdtempSync(join(tmpdir(), 'review-exclude-pi-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      git('init', '-q');
      for (const path of [...excluded, ...kept]) {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        writeFileSync(join(repo, path), '');
      }
      git('add', '-A');
      const matched = git('ls-files', '--', ':(glob)' + GLOB).split('\n').filter(Boolean).sort();
      expect(matched).toEqual([...excluded].sort());
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
