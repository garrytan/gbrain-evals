import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const policy = JSON.parse(readFileSync(new URL('../../.gstack/ship-policy.json', import.meta.url), 'utf8')) as { review_exclude_paths: string[] };
const D = 'docs/benchmarks/2026-11-23-weekly-outcome-line/pilot';
const GLOBS = ['answers', 'judgments', 'rows'].map(kind => `${D}/**/${kind}.ndjson`);
const excluded = ['named-200k/gbrain/answers.ndjson', 'alias-stage2/memory-bank/judgments.ndjson', 'alias-stage1/grep-agent-pilot/rows.ndjson'].map(p => `${D}/${p}`);
const kept = [
  `${D}/alias-stage1/grep-agent-pilot/receipt.json`,
  `${D}/named-1m/gbrain/run-config.json`,
  `${D}/alias-stage2/memory-bank/leases/bgw-alias-s2.ext-memory-bank.recipe-a1-0000.json`,
  `${D}/README.md`,
  'docs/benchmarks/2026-11-23-weekly-outcome-line.md',
  'docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md',
  'docs/benchmarks/preregistrations.d/weekly-outcome-line.json',
  'eval/runner/weekly-line/results-recount.ts',
  'docs/benchmarks/2026-11-23-weekly-outcome-line-other/pilot/answers.ndjson',
];

describe("ship policy: reviewers leave out the weekly line's per-question records only", () => {
  // Value: protects=the review reads the weekly line's receipts, run configs, lease files, results page, plan, registry entry and recount, and skips only the bulk answers, judgments and rows records; fails_when=a glob is dropped, or the policy as a whole hides a receipt, run config, lease file or the page; why_new=the stop-and-publish results pull request (#652) is over the review's 2 MB limit; seam=.gstack/ship-policy.json review_exclude_paths through git ls-files :(glob); no_claim=gstack's own use of the list
  test("the whole exclusion list matches the three record kinds and keeps receipts, run configs and leases in review", () => {
    for (const glob of GLOBS) expect(policy.review_exclude_paths).toContain(glob);
    const repo = mkdtempSync(join(tmpdir(), 'review-exclude-wl-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      git('init', '-q');
      for (const path of [...excluded, ...kept]) {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        writeFileSync(join(repo, path), '');
      }
      git('add', '-A');
      const matched = git('ls-files', '--', ...policy.review_exclude_paths.map(p => ':(glob)' + p)).split('\n').filter(Boolean).sort();
      expect(matched).toEqual([...excluded].sort());
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
