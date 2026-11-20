/**
 * The gbrain pin bump (eval/runner/gbrain-pin.ts): which tag counts as the newest release, how package.json's spec and
 * the pin page are rewritten, and which CHANGELOG sections the bump prints. Keyless and offline; the git fetch and
 * `bun install` are exercised by running the command itself.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PinChange, PIN_PAGE, changelogBetween, checkPinPage, compareVersions, newestRelease, pinFragment, pinLine, specSha, withGbrainSpec, withPinOnPage } from '../../eval/runner/gbrain-pin.ts';

const OLD = 'github:garrytan/gbrain#d253ec0ff12ed370ed3a846cb7da0191639c4a9e';
const NEW = 'github:garrytan/gbrain#6ce7195b44a034f85aec811f11fbf862db376f50';
const CUES = 'github:garrytan/gbrain#939232f1746381b4e932d620d6c709e29198f14c';
const ROOT = join(import.meta.dir, '../..');
const CHANGE: PinChange = {
  from: { version: '0.60.623.0', sha: 'd253ec0ff12ed370ed3a846cb7da0191639c4a9e' },
  to: { version: '0.60.733.0', sha: '6ce7195b44a034f85aec811f11fbf862db376f50' },
  date: '2026-11-16',
  releases: 110,
  commits: 2325,
};
const OLD_LINE = pinLine(CHANGE.from.version, CHANGE.from.sha, '2026-11-09');
const PAGE = ['# The gbrain under test', '', '## The pin', '', OLD_LINE, 'It is declared as `gbrain` in `package.json`.', '', '## Changelog', '', '### 2026-11-09: Page created', '', 'Text.', ''].join('\n');

describe('gbrain-pin', () => {
  test('versions compare by number, not by text', () => {
    expect(compareVersions('0.60.100.0', '0.60.99.0')).toBeGreaterThan(0);
    expect(compareVersions('0.60.733.0', '0.60.733.0')).toBe(0);
    expect(compareVersions('0.60.733', '0.60.733.1')).toBeLessThan(0);
  });

  test('the newest release is the highest version tag; stable, latest-stable and suffixed tags never count', () => {
    expect(newestRelease(['v0.60.99.0', 'v0.60.100.0', 'stable', 'latest-stable', 'v0.61.0.0-rc1', 'v1', ''])).toBe('0.60.100.0');
    expect(newestRelease(['stable', 'latest-stable'])).toBeNull();
  });

  test('the pinned commit must be a full sha on garrytan/gbrain', () => {
    expect(specSha(OLD)).toBe('d253ec0ff12ed370ed3a846cb7da0191639c4a9e');
    expect(() => specSha('github:garrytan/gbrain#d253ec0')).toThrow('full sha');
    expect(() => specSha('github:someone/gbrain#d253ec0ff12ed370ed3a846cb7da0191639c4a9e')).toThrow();
    expect(() => specSha('^0.60.0')).toThrow();
  });

  test('only the gbrain dependency moves, and the file keeps its formatting', () => {
    const pkg = `{\n  "dependencies": {\n    "gbrain": "${OLD}",\n    "gbrain-cues": "${CUES}"\n  }\n}\n`;
    expect(withGbrainSpec(pkg, OLD, NEW)).toBe(pkg.replace(OLD, NEW));
    expect(() => withGbrainSpec(pkg, NEW, OLD)).toThrow('exactly once');
  });

  test('the printed changelog runs from just after the old version through the new one', () => {
    const changelog = [
      '# Changelog', '', 'Intro text.', '',
      '## [0.60.3.0] - 2026-11-16', '', '**Third.**', '',
      '## [0.60.2.0] - 2026-11-15', '', '**Second.**', '',
      '## [0.60.1.0] - 2026-11-14', '', '**First.**', '',
      '## [0.60.0.0] - 2026-11-13', '', '**Zeroth.**',
    ].join('\n');
    const { versions, text } = changelogBetween(changelog, '0.60.1.0', '0.60.3.0');
    expect(versions).toEqual(['0.60.3.0', '0.60.2.0']);
    expect(text).toBe('## [0.60.3.0] - 2026-11-16\n\n**Third.**\n\n## [0.60.2.0] - 2026-11-15\n\n**Second.**');
    expect(changelogBetween(changelog, '0.60.3.0', '0.60.3.0').versions).toEqual([]);
  });

  test('the pin page holds one pin line, and it names package.json\'s pin', () => {
    const page = readFileSync(join(ROOT, PIN_PAGE), 'utf8');
    const sha = specSha(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies.gbrain);
    expect(() => checkPinPage(page)).not.toThrow();
    expect(page).toContain('([`' + sha.slice(0, 9) + '`](https://github.com/garrytan/gbrain/tree/' + sha + '))');
  });

  test('a bump rewrites only the pin line and adds its entry at the top of the page\'s changelog', () => {
    const after = withPinOnPage(PAGE, CHANGE);
    const entry = [
      '### 2026-11-16: Re-pin to gbrain `6ce7195b4` (v0.60.733.0)',
      '',
      '`bun eval/runner/gbrain-pin.ts bump` moved the pin from `d253ec0ff` (v0.60.623.0) to `6ce7195b4` (v0.60.733.0),',
      '110 releases and 2325 commits later. Only the pin line changed, and no result was rerun.',
      '', '',
    ].join('\n');
    expect(after).toBe(PAGE
      .replace(OLD_LINE, "This repository installs gbrain v0.60.733.0 ([`6ce7195b4`](https://github.com/garrytan/gbrain/tree/6ce7195b44a034f85aec811f11fbf862db376f50)), gbrain's newest release on 2026-11-16.")
      .replace('## Changelog\n\n', '## Changelog\n\n' + entry));
    expect(() => checkPinPage(after)).not.toThrow();
    expect(() => checkPinPage(withPinOnPage(readFileSync(join(ROOT, PIN_PAGE), 'utf8'), CHANGE))).not.toThrow();
  });

  test('a page without exactly one pin line or one changelog is refused', () => {
    expect(() => checkPinPage(PAGE.replace(OLD_LINE, 'This repository installs gbrain.'))).toThrow('holds 0 pin lines');
    expect(() => checkPinPage(PAGE.replace(OLD_LINE, OLD_LINE + '\n' + OLD_LINE))).toThrow('holds 2 pin lines');
    expect(() => checkPinPage(PAGE.replace('## Changelog', '## History'))).toThrow('one "## Changelog" heading');
    expect(() => withPinOnPage(PAGE.replace('## Changelog', '## History'), CHANGE)).toThrow('one "## Changelog" heading');
  });

  test('the changelog.d fragment names both pins, the range and the pin page', () => {
    expect(pinFragment(CHANGE)).toBe([
      '### Tests run against gbrain v0.60.733.0',
      '',
      '- `package.json` and `bun.lock` move the `gbrain` dependency from v0.60.623.0 (`d253ec0ff`) to v0.60.733.0',
      "  (`6ce7195b4`), gbrain's newest release on 2026-11-16, 110 releases and 2325 commits later.",
      '  [docs/gbrain-under-test.md](docs/gbrain-under-test.md#the-pin) names the new pin. No result was rerun.',
      '',
    ].join('\n'));
  });
});
