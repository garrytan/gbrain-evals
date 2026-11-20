import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const policy = JSON.parse(readFileSync(new URL('../../.gstack/ship-policy.json', import.meta.url), 'utf8')) as { review_exclude_paths: string[] };
const R = 'docs/benchmarks/2026-11-18-entity-dedupe-h2h';
const GLOBS = [
  `${R}/counted/**/*.json`,
  `${R}/counted/**/*.jsonl`,
  `${R}/dev/**/*.json`,
  `${R}/dev/**/*.jsonl`,
  'docs/comparison-systems/*/entity-h2h-smoke-run.json',
];

const excluded = [
  `${R}/counted/seed-reveal.json`,
  `${R}/counted/gbrain/finder.json`,
  `${R}/counted/gbrain/imports.jsonl`,
  `${R}/counted/splink-tuned/direct-edges.json`,
  `${R}/counted/ext-graph-pipeline-tuned/scores.json`,
  `${R}/dev/aggregate.json`,
  `${R}/dev/finder-dev/run-1/imports.jsonl`,
  `${R}/dev/er-h2h-classic/splink-default/output.json`,
  'docs/comparison-systems/ext-memory-bank/entity-h2h-smoke-run.json',
  'docs/comparison-systems/ext-graph-pipeline/entity-h2h-smoke-run.json',
];
const kept = [
  `${R}.md`,
  `${R}-preregistration.md`,
  `${R}/counted/README.md`,
  `${R}/dev/standin/scores.txt`,
  `${R}/analysis/analyze.ts`,
  `${R}/analysis/analyze.test.ts`,
  `${R}/analysis/paired.json`,
  `${R}/analysis/operating-points.md`,
  'docs/comparison-systems/ext-graph-pipeline/entity-h2h/capability.json',
  'docs/comparison-systems/ext-graph-pipeline/entity-h2h/entity_h2h.py',
  'docs/benchmarks/2026-11-17-person-dedupe/counted/scores.json',
  'eval/runner/entity-h2h/score.ts',
  'README.md',
];

describe('ship policy: reviewers leave out the duplicate-finder head-to-head raw run data', () => {
  test('lists the five globs', () => {
    for (const glob of GLOBS) expect(policy.review_exclude_paths).toContain(glob);
  });

  test("git's glob dialect matches the counted and dev data files and the smoke-run records only", () => {
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
