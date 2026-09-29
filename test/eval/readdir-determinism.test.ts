/**
 * Bun's readdirSync returns directory entries in filesystem order, which
 * differs between ext4, APFS and tmpfs. Any enumeration that feeds sampling,
 * ids or output order must be sorted (A-06, audit 2026-09-28). This guard
 * fails on a new unsorted enumeration; an emptiness or count check is fine.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'reports' || name === 'data' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) ? [path] : [];
  });
}

describe('readdirSync determinism (A-06)', () => {
  test('every readdirSync enumeration in eval/ and scripts/ is sorted or only counted', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles('eval'), ...sourceFiles('scripts')]) {
      const text = readFileSync(file, 'utf8');
      const re = /readdirSync\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (text.slice(Math.max(0, m.index - 30), m.index).includes('import')) continue;
        const statementEnd = text.indexOf(';', m.index);
        const statement = text.slice(m.index, statementEnd === -1 ? undefined : statementEnd);
        if (/\.sort\(/.test(statement) || /\)\s*\.length\b/.test(statement) || /\.filter\([^;]*\)\.length\b/.test(statement)) continue;
        offenders.push(`${file}:${text.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
