/**
 * Under `set -u`, Bash before 4.4 (macOS ships 3.2.57) treats "${arr[@]}" on an empty array as an unbound variable
 * and aborts. scripts/run-shootout-phase1.sh died this way on a first run with no output file to resume from
 * ("resume_args[@]: unbound variable"). Every tracked script that sets -u and expands an array it also declares
 * empty must use the ${arr[@]+"${arr[@]}"} form. Bash 5 can't reproduce the abort, so this check is structural.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '../..');

export function unguardedEmptyArrayExpansions(source: string): string[] {
  if (!/^\s*set -[a-z]*u/m.test(source)) return [];
  const empties = new Set([...source.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=\(\s*\)/g)].map(m => m[1]));
  const found: string[] = [];
  source.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/"\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"/g)) {
      if (!empties.has(m[1])) continue;
      if (line.slice(0, m.index).endsWith(`\${${m[1]}[@]+`)) continue;
      found.push(`${i + 1}: ${line.trim()}`);
    }
  });
  return found;
}

describe('empty-array expansions under set -u (Bash 3.2)', () => {
  test('the detector flags the bare form and accepts the guarded form', () => {
    expect(unguardedEmptyArrayExpansions('set -euo pipefail\na=()\ncmd "${a[@]}"\n')).toEqual(['3: cmd "${a[@]}"']);
    expect(unguardedEmptyArrayExpansions('set -euo pipefail\na=()\ncmd ${a[@]+"${a[@]}"}\n')).toEqual([]);
    expect(unguardedEmptyArrayExpansions('a=()\ncmd "${a[@]}"\n')).toEqual([]);
  });

  test('no tracked shell script expands a possibly empty array unguarded', () => {
    const files = execFileSync('git', ['ls-files', '*.sh'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
    const offenders = files.flatMap(f => unguardedEmptyArrayExpansions(readFileSync(join(REPO, f), 'utf8')).map(l => `${f}:${l}`));
    expect(offenders).toEqual([]);
  });
});
