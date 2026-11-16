import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const pin = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies.gbrain as string;
const sha = /#([a-f0-9]{40})$/.exec(pin)?.[1];
const PIN_PAGE = 'docs/gbrain-under-test.md';

const INSTALL_CLAIM = /installed by this repository|this repository (?:currently |now )?(?:installs|pins)|library installed here|pinned (?:version|at) `|`package\.json` declares|declared in `package\.json`/i;
const COMMIT_OR_RELEASE = /`[a-f0-9]{7,40}`|\bv?\d+\.\d+\.\d+\.\d+\b/;

function claimSentences(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ');
  return prose.split(/(?<=[.!?])\s+/).filter(sentence => INSTALL_CLAIM.test(sentence));
}

/**
 * Sentences in a page's current state, above its `## Changelog`, claiming what this repository installs that would go
 * stale when the pin moves. The pin page names the package.json pin; every other page links to that page's pin section
 * and names no commit or release of its own, so a re-pin (eval/runner/gbrain-pin.ts) changes one page.
 */
function wrongClaims(file: string, text: string): string[] {
  return claimSentences(text.split('\n## Changelog\n')[0])
    .filter(s => file === PIN_PAGE ? !s.includes(sha!.slice(0, 7)) : !s.includes('gbrain-under-test.md#the-pin') || COMMIT_OR_RELEASE.test(s))
    .map(s => `${file}: ${s}`);
}

const DOCS = [
  'README.md',
  ...readdirSync(join(ROOT, 'docs')).filter(f => f.endsWith('.md')).map(f => `docs/${f}`),
  ...readdirSync(join(ROOT, 'eval')).filter(f => f.endsWith('.md')).map(f => `eval/${f}`),
];

describe('documentation names the installed gbrain pin on one page (audit B1)', () => {
  test('package.json pins gbrain to an exact commit', () => {
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
  });

  test('the pin page names the package.json pin, and every other install claim links there instead', () => {
    expect(claimSentences(readFileSync(join(ROOT, PIN_PAGE), 'utf8')).some(s => s.includes(sha!.slice(0, 9)))).toBe(true);
    expect(DOCS.flatMap(file => wrongClaims(file, readFileSync(join(ROOT, file), 'utf8')))).toEqual([]);
  });

  test('the checker recognizes the historical false claim', () => {
    const old = 'These recommendations refer to gbrain v0.48.4.0, commit `2efaaf8f`, the library\ninstalled by this repository.';
    expect(claimSentences(old)).toHaveLength(1);
    expect(wrongClaims(PIN_PAGE, old)).toHaveLength(1);
    expect(wrongClaims('README.md', old)).toHaveLength(1);
  });

  test('a hub that names a commit or a release, even beside the link, fails', () => {
    expect(wrongClaims('eval/README.md', 'Every runner loads the gbrain declared in `package.json`: master `6ce7195b4` as `gbrain`.')).toHaveLength(1);
    expect(wrongClaims('docs/settings.md', 'This repository installs gbrain v0.60.733.0 ([the pin](gbrain-under-test.md#the-pin)).')).toHaveLength(1);
    expect(wrongClaims('docs/settings.md', "This repository installs gbrain's newest release ([the pin](gbrain-under-test.md#the-pin)).")).toEqual([]);
  });
});
