import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const pin = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies.gbrain as string;
const sha = /#([a-f0-9]{40})$/.exec(pin)?.[1];

const INSTALL_CLAIM = /installed by this repository|this repository (?:currently |now )?installs|library installed here|pinned (?:version|at) `/i;

function claimSentences(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ');
  return prose.split(/(?<=[.!?])\s+/).filter(sentence => INSTALL_CLAIM.test(sentence));
}

const DOCS = ['README.md', ...readdirSync(join(ROOT, 'docs')).filter(f => f.endsWith('.md')).map(f => `docs/${f}`)];

describe('documentation names the installed gbrain pin (audit B1)', () => {
  test('package.json pins gbrain to an exact commit', () => {
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
  });

  test('every sentence claiming what this repository installs names the package.json pin', () => {
    const wrong: string[] = [];
    for (const file of DOCS) {
      for (const sentence of claimSentences(readFileSync(join(ROOT, file), 'utf8'))) {
        if (!sentence.includes(sha!.slice(0, 7))) wrong.push(`${file}: ${sentence}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('the checker recognizes the historical false claim', () => {
    const old = 'These recommendations refer to gbrain v0.48.4.0, commit `2efaaf8f`, the library\ninstalled by this repository.';
    expect(claimSentences(old)).toHaveLength(1);
    expect(claimSentences(old)[0]).not.toContain(sha!.slice(0, 7));
  });
});
