/**
 * eval/verify/cited-artifacts.ts tests — fixture-driven, keyless, $0.
 *
 * A synthetic git repo exercises every rule in the header: committed
 * citation (clean), missing citation on a live surface (fail) vs in a
 * historical report (warn), disclosed miss (warn), untracked-but-present
 * file (fail), transient eval/reports/ citation with and without
 * disclosure, receipt pointer at a transient path with and without a
 * committed sibling, machine-local absolute path (warn), unparseable
 * receipt (fail), artifacts/ pages skipped, cross-repo citation resolved
 * against a fake node_modules/gbrain (info) and unresolved when absent
 * (warn). Then the real repo: zero failures, and the known warnings the
 * PR body lists are present. Finally the CLI exit-code contract.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import {
  checkCitedArtifacts,
  publishedSurfaces,
  PATH_TOKEN,
  isHistorical,
} from '../../eval/verify/cited-artifacts.ts';
import { initRepo, put, commitAll, cleanup, at, severities, runCliFile } from './verify-fixtures.ts';

const SCRIPT = join(import.meta.dir, '../../eval/verify/cited-artifacts.ts');

describe('PATH_TOKEN', () => {
  test('matches repo-relative paths with data/doc/code extensions', () => {
    const s = 'see `docs/benchmarks/x/receipt.json` and eval/runner/foo.ts, not https://example.com/docs/a.md';
    const m = [...s.matchAll(PATH_TOKEN)].map(x => x[0]);
    expect(m).toEqual(['docs/benchmarks/x/receipt.json', 'eval/runner/foo.ts']);
  });
  test('does not match directories or non-listed roots', () => {
    const s = 'docs/benchmarks/ and src/foo.ts and node_modules/gbrain/x.json';
    expect([...s.matchAll(PATH_TOKEN)]).toEqual([]);
  });
});

describe('isHistorical', () => {
  test('benchmarks and audit are historical; README and docs/*.md are live', () => {
    expect(isHistorical('docs/benchmarks/2026-05-23-x.md')).toBe(true);
    expect(isHistorical('docs/audit/2026-08-31-eval-audit.md')).toBe(true);
    expect(isHistorical('README.md')).toBe(false);
    expect(isHistorical('docs/comparison-systems.md')).toBe(false);
  });
});

describe('cited-artifacts on a synthetic repo', () => {
  let root: string;

  beforeAll(() => {
    root = initRepo('verify-cited');
    put(root, '.gitignore', 'node_modules/\neval/reports/\n');
    put(root, 'docs/ok.json', '{"n": 1}');
    put(root, 'docs/benchmarks/r/rows.ndjson', '{"a":1}\n');
    put(root, 'docs/benchmarks/r/summary.json', JSON.stringify({ resolved: { source_ndjson: 'eval/reports/r/rows.ndjson' } }));
    put(root, 'docs/benchmarks/q/summary.json', JSON.stringify({ resolved: { source_ndjson: 'eval/reports/q/rows.ndjson' } }));
    put(root, 'docs/benchmarks/abs.json', JSON.stringify({ prior_run: { path: '/private/tmp/somewhere/baseline.json', timestamp: 'x' } }));
    put(root, 'docs/benchmarks/ptr.json', JSON.stringify({ artifact_path: 'docs/nope.json' }));
    put(root, 'docs/bad.json', '{not json');
    put(root, 'docs/benchmarks/x/artifacts/page.md', 'run `scripts/market_model.py` then `docs/never.json`');
    put(
      root,
      'README.md',
      [
        'ok: `docs/ok.json`',
        'missing: `docs/missing.json`',
        'disclosed: `docs/gone.json` (gitignored, regenerate with the runner)',
        'tmp: `eval/reports/cat1/receipt.json`',
        'tmp disclosed: receipts land under `eval/reports/cat1/` — see `eval/reports/cat1/receipt.json` (gitignored)',
        'crossrepo: `test/benchmark-foo.ts`',
        'untracked: `docs/untracked.json`',
      ].join('\n'),
    );
    put(root, 'docs/benchmarks/old.md', 'historical: `docs/gone-too.json`');
    commitAll(root);
    // Present but never added — the gitignore-by-accident case.
    put(root, 'docs/untracked.json', '{}');
  });

  afterAll(() => cleanup(root));

  test('publishedSurfaces lists README + docs, skips artifacts/', () => {
    const s = publishedSurfaces(root);
    expect(s).toContain('README.md');
    expect(s).toContain('docs/benchmarks/r/summary.json');
    expect(s.some(x => x.includes('/artifacts/'))).toBe(false);
  });

  test('without node_modules/gbrain: cross-repo citation is a warn, not a fail', () => {
    const r = checkCitedArtifacts({ root });
    expect(at(r, 'README.md:6', 'warn')[0]?.message).toMatch(/gbrain not installed/);
  });

  describe('with a fake node_modules/gbrain at the pin', () => {
    let report: ReturnType<typeof checkCitedArtifacts>;
    beforeAll(() => {
      put(root, 'node_modules/gbrain/package.json', '{"name":"gbrain"}');
      put(root, 'node_modules/gbrain/test/benchmark-foo.ts', '// upstream');
      report = checkCitedArtifacts({ root });
    });

    test('committed citation is clean', () => {
      expect(at(report, 'README.md:1')).toEqual([]);
    });
    test('missing citation on a live surface fails', () => {
      const f = at(report, 'README.md:2', 'fail');
      expect(f).toHaveLength(1);
      expect(f[0].message).toMatch(/docs\/missing\.json.*neither/);
    });
    test('disclosed miss warns', () => {
      expect(at(report, 'README.md:3', 'warn')).toHaveLength(1);
      expect(at(report, 'README.md:3', 'fail')).toEqual([]);
    });
    test('transient citation without disclosure warns; with disclosure is silent', () => {
      expect(at(report, 'README.md:4', 'warn')[0]?.message).toMatch(/transient/);
      expect(at(report, 'README.md:5')).toEqual([]);
    });
    test('cross-repo citation resolves to info', () => {
      const f = at(report, 'README.md:6');
      expect(f).toHaveLength(1);
      expect(f[0].severity).toBe('info');
      expect(f[0].message).toMatch(/cross-repo/);
    });
    test('present-but-untracked citation fails (the gitignore-by-accident class)', () => {
      const f = at(report, 'README.md:7', 'fail');
      expect(f).toHaveLength(1);
      expect(f[0].message).toMatch(/not git-tracked/);
    });
    test('missing citation in a historical report warns instead of failing', () => {
      expect(at(report, 'docs/benchmarks/old.md:1', 'warn')).toHaveLength(1);
      expect(at(report, 'docs/benchmarks/old.md:1', 'fail')).toEqual([]);
    });
    test('receipt pointer at a transient path with a committed sibling warns', () => {
      const f = at(report, 'docs/benchmarks/r/summary.json/resolved/source_ndjson');
      expect(f).toHaveLength(1);
      expect(f[0].severity).toBe('warn');
      expect(f[0].message).toContain('docs/benchmarks/r/rows.ndjson');
    });
    test('receipt pointer at a transient path with no committed copy fails', () => {
      const f = at(report, 'docs/benchmarks/q/summary.json/resolved/source_ndjson');
      expect(f).toHaveLength(1);
      expect(f[0].severity).toBe('fail');
    });
    test('receipt pointer at a missing repo path fails', () => {
      expect(at(report, 'docs/benchmarks/ptr.json/artifact_path', 'fail')).toHaveLength(1);
    });
    test('machine-local absolute path warns', () => {
      const f = at(report, 'docs/benchmarks/abs.json/prior_run/path', 'warn');
      expect(f).toHaveLength(1);
      expect(f[0].message).toContain('/private/tmp/');
    });
    test('unparseable receipt fails', () => {
      expect(at(report, 'docs/bad.json', 'fail')).toHaveLength(1);
    });
    test('artifacts/ pages are not scanned', () => {
      expect(at(report, 'artifacts/page.md')).toEqual([]);
    });
    test('summary counts cross-repo resolutions', () => {
      const s = report.findings[report.findings.length - 1];
      expect(s.severity).toBe('info');
      expect(s.message).toMatch(/1 resolve cross-repo/);
    });
  });
});

describe('cited-artifacts on this repo', () => {
  const report = checkCitedArtifacts();

  test('no failures on main', () => {
    const fails = report.findings.filter(f => f.severity === 'fail');
    expect(fails).toEqual([]);
  });

  test('the rescore summary still points at the transient NDJSON path (known, disclosed in CHANGELOG)', () => {
    const f = at(report, 'rescore-may-2026-08-31.json/resolved/source_ndjson', 'warn');
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('docs/benchmarks/2026-05-07-longmemeval-s/rescore-may-copy.ndjson');
  });

  test('the two Cat 35 receipts carry machine-local prior_run paths (known)', () => {
    expect(at(report, 'prior_run/path', 'warn').length).toBe(2);
  });
});

describe('cited-artifacts CLI exit codes', () => {
  test('clean fixture exits 0; failing fixture exits 1', () => {
    const clean = initRepo('verify-cited-cli-ok');
    put(clean, 'docs/a.json', '{}');
    put(clean, 'README.md', 'see `docs/a.json`');
    commitAll(clean);
    expect(runCliFile(SCRIPT, ['--root', clean, '--quiet']).code).toBe(0);
    cleanup(clean);

    const bad = initRepo('verify-cited-cli-bad');
    put(bad, '.gitignore', 'node_modules/\n');
    put(bad, 'README.md', 'see `docs/a.json`');
    commitAll(bad);
    put(bad, 'node_modules/gbrain/package.json', '{}'); // definitive: not here, not upstream either
    const r = runCliFile(SCRIPT, ['--root', bad, '--quiet']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL: README\.md:1/);
    cleanup(bad);
  });

  test('--strict promotes warnings to a non-zero exit', () => {
    const w = initRepo('verify-cited-cli-warn');
    put(w, 'README.md', 'see `eval/reports/x.json`');
    commitAll(w);
    expect(runCliFile(SCRIPT, ['--root', w, '--quiet']).code).toBe(0);
    expect(runCliFile(SCRIPT, ['--root', w, '--quiet', '--strict']).code).toBe(1);
    cleanup(w);
  });

  test('--json emits a parseable report', () => {
    const r = runCliFile(SCRIPT, ['--json']);
    const parsed = JSON.parse(r.out) as Array<{ check: string; findings: unknown[] }>;
    expect(parsed[0].check).toBe('cited-artifacts');
    expect(Array.isArray(parsed[0].findings)).toBe(true);
  });
});
