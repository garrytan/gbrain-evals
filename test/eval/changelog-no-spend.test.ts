import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SINCE = '2026-11-08';

const MONEY = [
  /\$\s?\d/,
  /\b\d[\d,.]*\s?(?:USD|dollars?)\b/i,
  /\b(?:spend|spent|costs?|budget|caps?|ceiling)\s+(?:(?:moves|rises|rose|falls|fell|goes|went)\s+)?(?:of|was|were|is|at|under|about|around|to|from)\s+(?:about\s+|around\s+|roughly\s+)?\d/i,
  /\bunder an?\s+\d[\d,.]*\s+(?:\w+\s+)?(?:cap|budget|ceiling)\b/i,
];

/** Lines of prose (code spans and fences removed) that state a dollar amount, a cap or a spend figure. */
function moneyLines(text: string): string[] {
  return text.replace(/```[\s\S]*?```/g, '').split('\n')
    .map(line => line.replace(/`[^`]*`/g, ''))
    .filter(line => MONEY.some(re => re.test(line)));
}

/** CHANGELOG.md's sections dated on or after SINCE, the day spend and caps stopped being published here. */
function recentSections(text: string): string {
  const out: string[] = [];
  for (const section of text.split(/^(?=## \[)/m)) {
    const date = /^## \[[^\]]+\] - (\d{4}-\d{2}-\d{2})/.exec(section)?.[1];
    if (date && date >= SINCE) out.push(section);
  }
  return out.join('');
}

describe('changelog money wording', () => {
  test('the check catches dollar amounts and cap figures, and ignores code spans and token caps', () => {
    expect(moneyLines('a cost of about $990 under a $1,200 cap')).toHaveLength(1);
    expect(moneyLines('Spend was 11.07 dollars.')).toHaveLength(1);
    expect(moneyLines('the cap moves to 700 for the counted run')).toHaveLength(1);
    expect(moneyLines('under a 1,200 cap')).toHaveLength(1);
    expect(moneyLines('runs `awk \'{print $1}\'` and records an 8192-token output cap')).toHaveLength(0);
    expect(moneyLines('cost per correct answer, and the ledger stops at its cap')).toHaveLength(0);
  });

  test('no changelog fragment states spend, a cost total or a cap', () => {
    const dir = join(ROOT, 'changelog.d');
    const hits = readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md')
      .flatMap(f => moneyLines(readFileSync(join(dir, f), 'utf8')).map(line => `changelog.d/${f}: ${line.trim()}`));
    expect(hits).toEqual([]);
  });

  test(`CHANGELOG.md sections dated ${SINCE} or later state no spend, cost total or cap`, () => {
    const hits = moneyLines(recentSections(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'))).map(l => l.trim());
    expect(hits).toEqual([]);
  });
});
