import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHRASING_A2 } from '../../eval/generators/temporal-edges-gen.ts';
import { loadDevPhrasingFile } from '../../eval/runner/temporal-edges.ts';

function devFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'te-dev-phrasing-'));
  const path = join(dir, 'dev-phrasing.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

describe('temporal-edges --dev-phrasing-file', () => {
  test('loads { id, templates } for dev seeds, returns the file sha256 and writes no access log', () => {
    const path = devFile({ id: 'dev-fresh-1', templates: PHRASING_A2 });
    const r = loadDevPhrasingFile(path, [3, 5]);
    expect(r.phrasing.id).toBe('dev-fresh-1');
    expect(r.phrasing.templates.current).toBe(PHRASING_A2.current);
    expect(r.sha256).toBe(createHash('sha256').update(JSON.stringify({ id: 'dev-fresh-1', templates: PHRASING_A2 })).digest('hex'));
    expect(readdirSync(join(path, '..'))).toEqual(['dev-phrasing.json']);
    expect(existsSync(join(path, '..', 'access-log.jsonl'))).toBe(false);
  });

  test('refuses held-out seeds with the rerun command', () => {
    const path = devFile({ id: 'x', templates: PHRASING_A2 });
    expect(() => loadDevPhrasingFile(path, [3, 11])).toThrow(/held out\. Rerun with --seeds 3,5/);
  });

  test('refuses a file without an id or with incomplete templates, saying what to fix', () => {
    expect(() => loadDevPhrasingFile(devFile({ templates: PHRASING_A2 }), [3])).toThrow(/needs a non-empty string "id"/);
    expect(() => loadDevPhrasingFile(devFile({ id: 'x', templates: { current: 'a' } }), [3])).toThrow(/phrasing templates missing/);
    expect(() => loadDevPhrasingFile(devFile('{not json'), [3])).toThrow(/is not JSON/);
  });
});
