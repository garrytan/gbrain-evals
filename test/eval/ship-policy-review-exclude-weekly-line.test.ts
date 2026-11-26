import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const policy = JSON.parse(readFileSync(new URL('../../.gstack/ship-policy.json', import.meta.url), 'utf8')) as { review_exclude_paths: string[] };
const GLOB = 'docs/benchmarks/2026-11-23-weekly-outcome-line/pilot/**';
const D = 'docs/benchmarks/2026-11-23-weekly-outcome-line/pilot';
const excluded = ['named-200k/gbrain/answers.ndjson', 'alias-stage2/memory-bank/leases/x.json', 'alias-stage1/grep-agent-pilot/receipt.json'].map(p => `${D}/${p}`);
const kept = [
  'docs/benchmarks/2026-11-23-weekly-outcome-line.md',
  'docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md',
  'docs/benchmarks/preregistrations.d/weekly-outcome-line.json',
  'docs/benchmarks/2026-11-23-weekly-outcome-line/README.md',
  'eval/runner/weekly-line/results-recount.ts',
  'docs/benchmarks/2026-11-23-weekly-outcome-line-other/pilot/receipt.json',
];

describe("ship policy: reviewers leave out the weekly line's pilot records", () => {
  // Value: protects=the review reads the weekly line's results page, plan, registry entry and recount but not its 4.8 MB of per-question pilot records; fails_when=the glob is dropped or widened to the page, the plan, its registry entry or the recount; why_new=the stop-and-publish results pull request (#652) is over the review's 2 MB limit; seam=.gstack/ship-policy.json review_exclude_paths through git ls-files :(glob); no_claim=gstack's own use of the list
  test("lists the glob, and git's glob dialect matches the receipts only", () => {
    expect(policy.review_exclude_paths).toContain(GLOB);
    const repo = mkdtempSync(join(tmpdir(), 'review-exclude-wl-'));
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
