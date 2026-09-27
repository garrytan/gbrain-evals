import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('CI excludes dependency diagnostics by path, not by message text', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  expect(workflow.match(/grep -v '\^node_modules\/'/g)).toHaveLength(4);
  expect(workflow).not.toContain('grep -v node_modules ');

  const diagnostics = [
    'node_modules/gbrain/src/a.ts(1,2): error TS2304: inherited dependency issue',
    'eval/runner/reader.ts(2,3): error TS2307: Cannot find module node_modules/gbrain/foo',
    'scripts/check.ts(4,5): error TS2322: repo-owned diagnostic',
  ];
  const visible = diagnostics.filter(line => !/^node_modules\//.test(line));
  expect(visible).toEqual(diagnostics.slice(1));
  expect(visible.some(line => line.includes('error TS'))).toBe(true);
});
