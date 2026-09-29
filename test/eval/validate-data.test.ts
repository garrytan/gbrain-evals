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
import { checkSyntheticV1, checkQrels, checkBaseline, checkAmaraLife, checkGold, runAllChecks } from '../../eval/runner/validate-data.ts';
import { canonicalJson, sha256 } from '../../eval/generators/amara-life-gen.ts';

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

describe('checkAmaraLife hash scheme (audit C10)', () => {
  function lifeCorpus(name: string, records: Array<Record<string, unknown>>, manifestHash: (r: Record<string, unknown>) => string): string {
    const root = join(dir, name);
    mkdirSync(join(root, 'inbox'), { recursive: true });
    writeFileSync(join(root, 'inbox/emails.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(root, 'corpus-manifest.json'), JSON.stringify({ items: records.map(r => ({ slug: r.slug, path: 'inbox/emails.jsonl', content_sha256: manifestHash(r) })) }));
    return root;
  }
  const records = [{ slug: 'emails/em-0000', body_text: 'hello' }, { slug: 'emails/em-0001', body_text: 'world' }];

  test('per-record hashes of a container file pass', () => {
    expect(checkAmaraLife(lifeCorpus('life-ok', records, r => sha256(canonicalJson(r))))).toEqual({ check: 'amara-life-v1', failures: [], warnings: [] });
  });

  test('an edited record FAILS instead of warning', () => {
    const root = lifeCorpus('life-edited', records, r => sha256(canonicalJson(r)));
    writeFileSync(join(root, 'inbox/emails.jsonl'), JSON.stringify(records[0]) + '\n' + JSON.stringify({ ...records[1], body_text: 'edited' }) + '\n');
    const r = checkAmaraLife(root);
    expect(r.failures).toEqual(['manifest item emails/em-0001: content_sha256 does not match its record in inbox/emails.jsonl']);
  });

  test('a record without a manifest item FAILS', () => {
    const root = lifeCorpus('life-extra', records, r => sha256(canonicalJson(r)));
    writeFileSync(join(root, 'inbox/emails.jsonl'), [...records, { slug: 'emails/em-0002', body_text: 'x' }].map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(checkAmaraLife(root).failures).toEqual(['inbox/emails.jsonl: record emails/em-0002 has no manifest item']);
  });
});

describe('checkGold', () => {
  test('a template stub FAILS', () => {
    const goldDir = join(dir, 'gold-stub');
    mkdirSync(goldDir, { recursive: true });
    writeFileSync(join(goldDir, 'x.json'), JSON.stringify({ version: 1, items: [{ _example: 'true' }] }));
    expect(checkGold(goldDir).failures.length).toBe(1);
  });
});

describe('committed data', () => {
  test('all checks pass on the committed corpora right now, with no warnings', () => {
    for (const r of runAllChecks()) {
      expect({ check: r.check, failures: r.failures, warnings: r.warnings }).toEqual({ check: r.check, failures: [], warnings: [] });
    }
  });
});
