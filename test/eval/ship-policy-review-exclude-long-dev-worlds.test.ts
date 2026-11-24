import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const policy = JSON.parse(readFileSync(new URL('../../.gstack/ship-policy.json', import.meta.url), 'utf8')) as { review_exclude_paths: string[] };
const D = 'eval/data/changing-facts-v1';
const GLOBS = [
  `${D}/dev/worlds/bg1-dev-long-0[1-3]/plan.json`,
  `${D}/dev/worlds/bg1-dev-long-0[1-3]/questions.json`,
  `${D}/fixtures/worlds/bg1-dev-long-0[1-3]/world.json`,
  `${D}/fixtures/worlds/bg1-dev-long-0[1-3]/questions.json`,
];
const LONG = ['bg1-dev-long-01', 'bg1-dev-long-02', 'bg1-dev-long-03'];
const excluded = LONG.flatMap(id => [`${D}/dev/worlds/${id}/plan.json`, `${D}/dev/worlds/${id}/questions.json`, `${D}/fixtures/worlds/${id}/world.json`, `${D}/fixtures/worlds/${id}/questions.json`]);
const kept = [
  `${D}/dev/worlds/bg1-dev-01/plan.json`,
  `${D}/dev/worlds/bg1-dev-01/questions.json`,
  `${D}/fixtures/worlds/bg1-dev-03/world.json`,
  `${D}/dev/worlds/bg1-dev-long-04/plan.json`,
  `${D}/long-fixture/spread.json`,
  'eval/generators/changing-facts-gen.ts',
  'test/eval/bg1-dev-long.test.ts',
];

describe("ship policy: reviewers leave out the long dev worlds' generated data", () => {
  // Value: protects=the review reads the generator and its tests but not the long dev worlds' 2.3 MB of generated JSON, and never the stage 1 dev worlds' gold; fails_when=a glob is dropped, widened to the stage 1 worlds or the generator, or git's glob dialect reads the brackets differently; why_new=the pull request adding the long dev worlds is over the review's 2 MB limit; seam=.gstack/ship-policy.json review_exclude_paths through git ls-files :(glob); no_claim=gstack's own use of the list
  test("lists the four globs, and git's glob dialect matches the long worlds' generated files only", () => {
    for (const glob of GLOBS) expect(policy.review_exclude_paths).toContain(glob);
    const repo = mkdtempSync(join(tmpdir(), 'review-exclude-long-'));
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
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
