/**
 * The gbrain pin bump (eval/runner/gbrain-pin.ts): which tag counts as the newest release, how package.json's spec is
 * rewritten, and which CHANGELOG sections the bump prints. Keyless and offline; the git fetch and `bun install` are
 * exercised by running the command itself.
 */
import { describe, expect, test } from 'bun:test';
import { changelogBetween, compareVersions, newestRelease, specSha, withGbrainSpec } from '../../eval/runner/gbrain-pin.ts';

const OLD = 'github:garrytan/gbrain#d253ec0ff12ed370ed3a846cb7da0191639c4a9e';
const NEW = 'github:garrytan/gbrain#6ce7195b44a034f85aec811f11fbf862db376f50';
const CUES = 'github:garrytan/gbrain#939232f1746381b4e932d620d6c709e29198f14c';

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
});
