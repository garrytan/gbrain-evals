/**
 * eval/verify/claim-hygiene.ts tests — fixture-driven, keyless, $0.
 *
 * Pure rule engine over synthetic text (retired hit, qualified in the same
 * row / paragraph / table header / table lead-in, unqualified miss, exempt
 * quoted third-party claims, banner detection incl. a dated UPDATE header),
 * rules-file validation, the real repo (zero failures on main;
 * the known unbannered historical reports are warnings), a git fixture
 * with a bare origin for `--ref` and the `--sweep` (one clean branch, one
 * stale), and the CLI exit-code contract including exit 2 on an unreadable
 * rules file.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  checkClaimHygiene,
  checkLiveSurface,
  checkReport,
  findHits,
  hasBanner,
  listRemoteRefs,
  loadRules,
  sweepRefs,
  unitAround,
  type RulesFile,
} from '../../eval/verify/claim-hygiene.ts';
import { initRepo, put, commitAll, cleanup, git, at, severities, runCliFile } from './verify-fixtures.ts';

const SCRIPT = join(import.meta.dir, '../../eval/verify/claim-hygiene.ts');
const REAL_RULES = join(import.meta.dir, '../../docs/claim-hygiene.json');

const RULES: RulesFile = {
  schema_version: 1,
  live_surfaces: ['README.md'],
  reports_dir: 'docs/benchmarks',
  banner: { pattern: 'erratum|correction', within_lines: 5, severity: 'warn' },
  rules: [
    { id: 'retired-0.076', pattern: '\\b0\\.076\\b', kind: 'retired', severity: 'fail' },
    { id: 'qualified-0.582', pattern: '\\b0\\.582\\b', kind: 'qualified', qualifier: 'upper bound|pending', severity: 'fail' },
    { id: 'any-hit-97.6', pattern: '\\b97\\.6(?:0|6)?%', kind: 'qualified', qualifier: 'any-hit|recall_any', severity: 'fail' },
  ],
};

describe('unitAround', () => {
  test('a prose line expands to its paragraph', () => {
    const lines = ['a', 'b', '', 'c', 'd', 'e', '', 'f'];
    expect(unitAround(lines, 4)).toBe('c\nd\ne');
    expect(unitAround(lines, 0)).toBe('a\nb');
    expect(unitAround(lines, 7)).toBe('f');
  });
  test('a table row includes the header row and the paragraph above the table', () => {
    const lines = ['Lead-in about any-hit.', '', '| adapter | recall |', '|---|---|', '| hybrid | 97.66% |'];
    const u = unitAround(lines, 4);
    expect(u).toContain('Lead-in about any-hit.');
    expect(u).toContain('| adapter | recall |');
    expect(u).toContain('| hybrid | 97.66% |');
    expect(u).not.toContain('|---|---|');
  });
  test('a table directly under another table takes no lead-in', () => {
    const lines = ['| x |', '', '| h |', '| r |'];
    expect(unitAround(lines, 3)).toBe('\n| h |\n| r |');
  });
});

describe('findHits', () => {
  const ids = (t: string) => findHits(t, RULES.rules).map(h => `${h.rule.id}@${h.line}`);

  test('retired figure hits wherever it appears', () => {
    expect(ids('scores 0.076 precision')).toEqual(['retired-0.076@1']);
  });
  test('qualified figure with its qualifier on the same line is clean', () => {
    expect(ids('0.582 precision (upper bound pending re-run)')).toEqual([]);
  });
  test('qualifier two sentences later in the same paragraph is clean', () => {
    expect(ids('reaches 0.582 precision.\nThat 0.582 is an upper bound.')).toEqual([]);
  });
  test('qualifier in a different paragraph does not count', () => {
    expect(ids('reaches 0.582 precision.\n\nIt is an upper bound.')).toEqual(['qualified-0.582@1']);
  });
  test('table row inherits a qualifying column header', () => {
    expect(ids('| adapter | recall_any@k |\n|---|---|\n| hybrid | 97.66% |')).toEqual([]);
  });
  test('table row inherits the paragraph above the table', () => {
    expect(ids('Shown as any-hit.\n\n| adapter | r |\n|---|---|\n| hybrid | 97.66% |')).toEqual([]);
  });
  test('table row without either is a hit', () => {
    expect(ids('| adapter | r |\n|---|---|\n| hybrid | 97.66% |')).toEqual(['any-hit-97.6@3']);
  });
  test('a qualifier for one rule does not satisfy another', () => {
    expect(ids('0.582 and 97.60% (upper bound)')).toEqual(['any-hit-97.6@1']);
  });
  test('excerpt is trimmed and capped', () => {
    const h = findHits('   ' + '0.076 ' + 'x'.repeat(300), RULES.rules)[0];
    expect(h.excerpt.length).toBeLessThanOrEqual(140);
    expect(h.excerpt.startsWith('0.076')).toBe(true);
  });
});

describe('exempt', () => {
  const SOTA = { id: 'retired-sota', pattern: '\\bSOTA\\b', kind: 'retired' as const, severity: 'fail' as const, exempt: '"[^"]*\\bSOTA\\b[^"]*"' };
  test('a quoted third-party claim is exempt; a bare claim on the same surface still hits', () => {
    expect(findHits('| Supermemory "99% SOTA" post | ~99% |', [SOTA])).toEqual([]);
    expect(findHits('gbrain is SOTA at reading memory back', [SOTA]).map(h => h.line)).toEqual([1]);
    expect(findHits('| Supermemory "99% SOTA" post | our SOTA row |', [SOTA])).toEqual([]);
  });
  test('the committed SOTA rule exempts the v0.6.1 Supermemory comparison row', () => {
    const sota = loadRules(REAL_RULES).rules.find(r => r.id === 'sota-unqualified')!;
    expect(sota.exempt).toBeDefined();
    expect(findHits('| Supermemory "99% SOTA" post | ~99%; 98.60% is pass@8 | QA-acc (NOT R@k) |', [sota])).toEqual([]);
    expect(findHits('gbrain is SOTA', [sota])).toHaveLength(1);
  });
  test('a bad exempt regex is rejected at load time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-rules-'));
    const bad = join(dir, 'a.json');
    writeFileSync(bad, JSON.stringify({ ...RULES, rules: [{ id: 'x', pattern: 'a', kind: 'retired', severity: 'fail', exempt: '(' }] }));
    expect(() => loadRules(bad)).toThrow();
  });
});

describe('hasBanner / checkReport / checkLiveSurface', () => {
  test('banner within the window counts; beyond it does not', () => {
    expect(hasBanner('# T\n> **Erratum (2026-08-31)**\nbody', RULES.banner)).toBe(true);
    expect(hasBanner('# T\n\n\n\n\n\n> Erratum', RULES.banner)).toBe(false);
  });
  test('report with hits behind a banner is info; without is the banner severity', () => {
    const bannered = '# R\n> Correction: numbers are pre-audit\n\n| a | b |\n|---|---|\n| x | 0.076 |';
    expect(checkReport('docs/benchmarks/r.md', bannered, RULES).map(f => f.severity)).toEqual(['info']);
    const bare = '# R\n\n| a | b |\n|---|---|\n| x | 0.076 |';
    const f = checkReport('docs/benchmarks/r.md', bare, RULES);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].message).toMatch(/retired-0\.076/);
  });
  test('a dated UPDATE header counts as a banner under the committed rules; an undated one does not', () => {
    const banner = loadRules(REAL_RULES).banner;
    expect(hasBanner('# R\n\n> ## UPDATE (2026-09-02) — re-run at gbrain v0.48.2.0\n>\n> fresh numbers', banner)).toBe(true);
    expect(hasBanner('# R\n\n> ## UPDATE — re-run\n', banner)).toBe(false);
  });
  test('report with no hits produces nothing', () => {
    expect(checkReport('docs/benchmarks/r.md', '# clean', RULES)).toEqual([]);
  });
  test('live surface findings carry the rule severity and the line', () => {
    const f = checkLiveSurface('README.md', 'x\n0.076 y', RULES.rules);
    expect(f).toEqual([
      expect.objectContaining({ severity: 'fail', where: 'README.md:2' }),
    ]);
  });
});

describe('loadRules', () => {
  test('the committed rules file loads', () => {
    const r = loadRules(REAL_RULES);
    expect(r.schema_version).toBe(1);
    expect(r.rules.length).toBeGreaterThanOrEqual(5);
    expect(r.live_surfaces).toContain('README.md');
  });
  test('rejects a qualified rule without a qualifier, and a bad regex', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-rules-'));
    const bad1 = join(dir, 'a.json');
    writeFileSync(bad1, JSON.stringify({ ...RULES, rules: [{ id: 'x', pattern: 'a', kind: 'qualified', severity: 'fail' }] }));
    expect(() => loadRules(bad1)).toThrow(/needs a qualifier/);
    const bad2 = join(dir, 'b.json');
    writeFileSync(bad2, JSON.stringify({ ...RULES, rules: [{ id: 'x', pattern: '(', kind: 'retired', severity: 'fail' }] }));
    expect(() => loadRules(bad2)).toThrow();
    const bad3 = join(dir, 'c.json');
    writeFileSync(bad3, JSON.stringify({ ...RULES, schema_version: 2 }));
    expect(() => loadRules(bad3)).toThrow(/schema_version/);
  });
});

describe('claim-hygiene on this repo', () => {
  const report = checkClaimHygiene();
  test('no failures on main: live surfaces are clean', () => {
    expect(report.findings.filter(f => f.severity === 'fail')).toEqual([]);
    expect(at(report, 'README.md')).toEqual([]);
    expect(at(report, 'docs/comparison-systems.md')).toEqual([]);
  });
  test('the known unbannered historical reports are warnings', () => {
    expect(at(report, '2026-05-23-v0.40.6.0-snapshot.md', 'warn')).toHaveLength(1);
    expect(at(report, '2026-04-19-brainbench-multi-adapter.md', 'warn')).toHaveLength(1);
  });
  test('bannered reports with retired figures are info, not warnings', () => {
    expect(at(report, '2026-05-07-longmemeval-s.md', 'info')).toHaveLength(1);
    expect(at(report, '2026-05-07-longmemeval-s.md', 'warn')).toEqual([]);
  });
});

describe('--ref and --sweep on a git fixture with a bare origin', () => {
  let root: string;
  let bare: string;

  beforeAll(() => {
    root = initRepo('verify-claims');
    put(root, 'docs/claim-hygiene.json', JSON.stringify(RULES));
    put(root, 'README.md', '# clean\n\n| a | recall_any@k |\n|---|---|\n| hybrid | 97.66% |\n');
    put(root, 'docs/benchmarks/r.md', '# R\n> Erratum\n0.076');
    commitAll(root, 'clean main');
    git(root, 'checkout', '-q', '-b', 'stale');
    put(root, 'README.md', '# stale\n\ngbrain hits **97.60% R@5**, SOTA. Default 0.076.\n');
    commitAll(root, 'stale readme');
    git(root, 'checkout', '-q', 'main');
    bare = mkdtempSync(join(tmpdir(), 'verify-claims-origin-'));
    git(bare, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', 'origin', 'main', 'stale');
  });

  afterAll(() => {
    cleanup(root);
    cleanup(bare);
  });

  test('working tree is clean; --ref origin/stale fails on the retired + unqualified figures', () => {
    expect(severities(checkClaimHygiene({ root })).fail).toBe(0);
    const stale = checkClaimHygiene({ root, ref: 'origin/stale' });
    const fails = stale.findings.filter(f => f.severity === 'fail');
    expect(fails.map(f => f.where)).toEqual(['README.md @ origin/stale:3', 'README.md @ origin/stale:3']);
    expect(fails.map(f => f.message).join(' ')).toMatch(/retired-0\.076/);
    expect(fails.map(f => f.message).join(' ')).toMatch(/any-hit-97\.6/);
  });

  test('--ref reads reports at the ref too', () => {
    const r = checkClaimHygiene({ root, ref: 'origin/main' });
    expect(at(r, 'docs/benchmarks/r.md @ origin/main', 'info')).toHaveLength(1);
  });

  test('sweep lists both remote refs, flags only the stale one, warns by default', () => {
    expect(listRemoteRefs(root).sort()).toEqual(['origin/main', 'origin/stale']);
    const s = sweepRefs({ root });
    expect(s.unavailable).toBeUndefined();
    expect(severities(s).fail).toBe(0);
    expect(at(s, '@ origin/stale', 'warn').length).toBe(2);
    expect(at(s, '@ origin/main', 'warn')).toEqual([]);
    const summary = s.findings[s.findings.length - 1];
    expect(summary.message).toMatch(/1 carry stale claims/);
    expect(at(s, 'origin/main', 'info')[0].message).toBe('clean');
  });

  test('sweep --fail-on-stale turns hits into failures', () => {
    expect(severities(sweepRefs({ root, failOnStale: true })).fail).toBe(2);
  });

  test('sweep with an explicit ref list honors it', () => {
    const s = sweepRefs({ root, refs: ['origin/main'] });
    expect(at(s, 'origin/stale')).toEqual([]);
  });

  test('sweep with no remote refs is UNAVAILABLE, never a silent pass', () => {
    const lonely = initRepo('verify-claims-lonely');
    put(lonely, 'docs/claim-hygiene.json', JSON.stringify(RULES));
    put(lonely, 'README.md', '# x');
    commitAll(lonely);
    expect(sweepRefs({ root: lonely }).unavailable).toMatch(/no remote refs/);
    cleanup(lonely);
  });

  test('CLI: --ref origin/stale exits 1, --ref origin/main exits 0, bad rules path exits 2', () => {
    expect(runCliFile(SCRIPT, ['--root', root, '--ref', 'origin/stale', '--quiet']).code).toBe(1);
    expect(runCliFile(SCRIPT, ['--root', root, '--ref', 'origin/main', '--quiet']).code).toBe(0);
    const r = runCliFile(SCRIPT, ['--root', root, '--rules', join(root, 'nope.json')]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/UNAVAILABLE/);
    expect(runCliFile(SCRIPT, ['--root', root, '--sweep', '--quiet']).code).toBe(0);
    expect(runCliFile(SCRIPT, ['--root', root, '--sweep', '--fail-on-stale', '--quiet']).code).toBe(1);
  });
});
