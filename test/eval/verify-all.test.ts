/**
 * eval/verify/all.ts + lib.ts tests — keyless, $0.
 *
 * The shared exit-code contract (exitCodeFor: fail → 1, unavailable → 2,
 * warn → 0 unless strict), the flag parser, and the aggregate CLI on this
 * repo: every check runs (cat34-crossrepo skipped when gbrain is not
 * installed), no check but cat34-crossrepo may fail on main (that one fails
 * exactly when package.json's gbrain pin has moved past the committed Cat 34
 * receipt — v0.6.1 did), the CLI exit code follows the reports, `--json`
 * emits one report per check, `--skip` drops one.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { countBy, exitCodeFor, parseArgs } from '../../eval/verify/lib.ts';
import { CHECKS, runAll } from '../../eval/verify/all.ts';
import { DEFAULT_BASELINE } from '../../eval/verify/cat34-crossrepo.ts';
import { runCliFile } from './verify-fixtures.ts';

const SCRIPT = join(import.meta.dir, '../../eval/verify/all.ts');
const installed = existsSync(join(import.meta.dir, '../..', DEFAULT_BASELINE));
const skipArgs = installed ? [] : ['--skip', 'cat34-crossrepo'];

describe('lib', () => {
  test('exitCodeFor: clean 0, warn 0, warn+strict 1, fail 1, unavailable 2 (wins)', () => {
    const clean = { check: 'a', findings: [{ severity: 'info' as const, where: 'x', message: 'm' }] };
    const warn = { check: 'a', findings: [{ severity: 'warn' as const, where: 'x', message: 'm' }] };
    const fail = { check: 'a', findings: [{ severity: 'fail' as const, where: 'x', message: 'm' }] };
    const unavailable = { check: 'a', findings: [], unavailable: 'nope' };
    expect(exitCodeFor([clean])).toBe(0);
    expect(exitCodeFor([warn])).toBe(0);
    expect(exitCodeFor([warn], true)).toBe(1);
    expect(exitCodeFor([clean, fail])).toBe(1);
    expect(exitCodeFor([fail, unavailable])).toBe(2);
  });
  test('countBy tallies severities', () => {
    expect(countBy([
      { severity: 'fail', where: '', message: '' },
      { severity: 'warn', where: '', message: '' },
      { severity: 'warn', where: '', message: '' },
    ])).toEqual({ fail: 1, warn: 2, info: 0 });
  });
  test('parseArgs: --flag, --name value, positionals', () => {
    const { flags, positional } = parseArgs(['a.ndjson', 'b', '--quiet', '--root', '/r', '--json']);
    expect(flags.get('quiet')).toBe(true);
    expect(flags.get('root')).toBe('/r');
    expect(flags.get('json')).toBe(true);
    expect(positional).toEqual(['a.ndjson', 'b']);
  });
});

describe('all.ts', () => {
  test('five checks are registered in the documented order', () => {
    expect(CHECKS.map(c => c.name)).toEqual(['cited-artifacts', 'claim-hygiene', 'judge-model-evidence', 'pins', 'cat34-crossrepo']);
  });
  test('runAll on this repo: every check runs; only cat34-crossrepo may fail, and only on pin drift', () => {
    const reports = runAll(undefined, new Set(installed ? [] : ['cat34-crossrepo']));
    for (const r of reports) {
      expect({ check: r.check, unavailable: r.unavailable }).toEqual({ check: r.check, unavailable: undefined });
      if (r.check === 'cat34-crossrepo') {
        const fails = r.findings.filter(f => f.severity === 'fail');
        if (fails.length > 0) expect(fails.map(f => f.where).some(w => w.endsWith(':gbrain_pin'))).toBe(true);
        continue;
      }
      expect({ check: r.check, fails: r.findings.filter(f => f.severity === 'fail') }).toEqual({ check: r.check, fails: [] });
    }
  });
  test('CLI exit code follows the reports; --json lists one report per check; --skip drops one', () => {
    const expected = exitCodeFor(runAll(undefined, new Set(installed ? [] : ['cat34-crossrepo'])));
    expect(runCliFile(SCRIPT, ['--quiet', ...skipArgs]).code).toBe(expected);
    const j = runCliFile(SCRIPT, ['--json', ...skipArgs]);
    expect(j.code).toBe(expected);
    const reports = JSON.parse(j.out) as Array<{ check: string }>;
    expect(reports.map(r => r.check)).toEqual(CHECKS.map(c => c.name).filter(n => installed || n !== 'cat34-crossrepo'));
    const s = runCliFile(SCRIPT, ['--json', '--skip', 'pins,cat34-crossrepo']);
    expect((JSON.parse(s.out) as Array<{ check: string }>).map(r => r.check)).toEqual(['cited-artifacts', 'claim-hygiene', 'judge-model-evidence']);
  });
  test('CLI --strict exits 1 while main carries the disclosed warnings', () => {
    const r = runCliFile(SCRIPT, ['--quiet', '--strict', ...skipArgs]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/WARN:/);
  });
});
