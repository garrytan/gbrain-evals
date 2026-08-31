/**
 * validate-data.ts tests — proves the referential-integrity gate can FAIL.
 *
 * The audit found dangling wikilinks and manifest overcounts by hand; this
 * gate must catch a seeded dangling slug (plan verification requirement),
 * not just pass on clean data.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkSyntheticV1, checkQrels, checkBaseline, runAllChecks } from '../../eval/runner/validate-data.ts';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'validate-data-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function corpus(name: string, files: Record<string, string>, manifestPages?: number): string {
  const root = join(dir, name);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  writeFileSync(
    join(root, '_manifest.json'),
    JSON.stringify({ schema_version: 1, pages: manifestPages ?? Object.keys(files).length }),
  );
  return root;
}

describe('checkSyntheticV1', () => {
  test('clean corpus passes', () => {
    const root = corpus('clean', {
      'people/a.md': 'links to [[companies/x]]',
      'companies/x.md': 'a company',
    });
    expect(checkSyntheticV1(root).failures).toEqual([]);
  });

  test('SEEDED dangling wikilink FAILS the gate', () => {
    const root = corpus('dangling', {
      'people/a.md': 'links to [[companies/does-not-exist]]',
    });
    const r = checkSyntheticV1(root);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]).toContain('does-not-exist');
  });

  test('manifest overcount FAILS (the silent-overwrite class)', () => {
    const root = corpus('overcount', { 'people/a.md': 'x' }, 2);
    const r = checkSyntheticV1(root);
    expect(r.failures.some(f => f.includes('pages=2') && f.includes('1 .md'))).toBe(true);
  });
});

describe('checkQrels', () => {
  test('top-1 label outside relevant_slugs FAILS', () => {
    const p = join(dir, 'bad-qrels.json');
    writeFileSync(p, JSON.stringify({
      queries: [{ query_id: 'q1', query: 'x', relevant_slugs: ['a/b'], first_relevant_slug: 'a/OTHER' }],
    }));
    const r = checkQrels(p);
    expect(r.failures.some(f => f.includes('a/OTHER'))).toBe(true);
  });

  test('the committed qrels pass', () => {
    expect(checkQrels().failures).toEqual([]);
  });
});

describe('checkBaseline', () => {
  test('row_count mismatch FAILS', () => {
    const p = join(dir, 'bad-baseline.ndjson');
    writeFileSync(p, [
      JSON.stringify({ _kind: 'baseline_metadata', row_count: 3 }),
      JSON.stringify({ query: 'q', retrieved_slugs: ['a'] }),
    ].join('\n'));
    const r = checkBaseline(p);
    expect(r.failures.some(f => f.includes('row_count=3'))).toBe(true);
  });

  test('zero-result capture row FAILS', () => {
    const p = join(dir, 'empty-baseline.ndjson');
    writeFileSync(p, [
      JSON.stringify({ _kind: 'baseline_metadata', row_count: 1 }),
      JSON.stringify({ query: 'q', retrieved_slugs: [] }),
    ].join('\n'));
    const r = checkBaseline(p);
    expect(r.failures.some(f => f.includes('zero retrieved_slugs'))).toBe(true);
  });
});

describe('committed data', () => {
  test('all checks pass on the committed corpora right now', () => {
    for (const r of runAllChecks()) {
      expect({ check: r.check, failures: r.failures }).toEqual({ check: r.check, failures: [] });
    }
  });
});
