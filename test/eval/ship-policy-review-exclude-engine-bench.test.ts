import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const policy = JSON.parse(readFileSync(new URL('../../.gstack/ship-policy.json', import.meta.url), 'utf8')) as { review_exclude_paths: string[] };
const GLOBS = [
  'docs/benchmarks/*-engine-bench/correctness/work/*/receipt.json', 'docs/benchmarks/*-engine-bench/speed/*speed-*-10000.json',
  'docs/benchmarks/*-engine-bench/lme-recall/lme-w*', 'docs/benchmarks/*-engine-bench/lme-recall/aggregate.json',
];
const RUN = 'docs/benchmarks/2026-11-17-engine-bench';

const excluded = [
  ...['n1', 'n5', 'n6', 'n12', 'n14'].flatMap(n => [`${RUN}/correctness/work/${n}-pglite/receipt.json`, `${RUN}/correctness/work/${n}-postgres/receipt.json`]),
  `${RUN}/correctness/work/n6-http-postgres/receipt.json`,
  `${RUN}/speed/dev-speed-2026-11-17T09-39-20-10000.json`,
  'docs/benchmarks/2026-12-01-engine-bench/correctness/work/n1-rust/receipt.json',
  'docs/benchmarks/2026-12-01-engine-bench/speed/speed-2026-12-01T10-00-00-10000.json',
  ...['json', 'ndjson', 'log'].map(ext => `docs/benchmarks/2026-12-01-engine-bench/lme-recall/lme-w0.${ext}`),
  'docs/benchmarks/2026-12-01-engine-bench/lme-recall/aggregate.json',
];
const kept = [
  `${RUN}.md`,
  `${RUN}/correctness/out/correctness-2026-11-17T15-35-05-048Z.json`,
  `${RUN}/correctness/work/n1-pglite.log`,
  `${RUN}/correctness/work/n6-http-postgres/other.json`,
  `${RUN}/speed/dev-speed-2026-11-17T16-12-15-100000.json`,
  `${RUN}/speed/run-10000.log`,
  `${RUN}/speed/launcher-100000-pglite.log`,
  `${RUN}/lme-recall/dry100.json`,
  `${RUN}/lme-recall/dry100.ndjson`,
  `${RUN}/lme-recall/count.json`,
  `${RUN}/lme-recall/cache.sha256`,
  'docs/benchmarks/2026-12-01-engine-bench/gate-suites/cat10.json',
  'docs/benchmarks/x/y-engine-bench/lme-recall/aggregate.json',
  `${RUN}/surface-parity/surface-parity-2026-11-17T09-11-34-800Z.json`,
  'docs/benchmarks/2026-11-17-engine-bench-preregistration.md',
  'docs/benchmarks/x/y-engine-bench/correctness/work/n1-pglite/receipt.json',
  'eval/runner/engine-bench/perf.ts',
];

describe('ship policy: reviewers leave out the bulky engine-bench receipts', () => {
  test('lists the engine-bench globs', () => {
    for (const glob of GLOBS) expect(policy.review_exclude_paths).toContain(glob);
  });

  test("git's glob dialect matches the per-runner correctness receipts and 10,000-page speed receipts only", () => {
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
