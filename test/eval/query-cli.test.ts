/**
 * End-to-end regression tests for the query-authoring CLI pair
 * (audit findings generators-15 + generators-16).
 *
 * generators-15: eval:query:new claimed its scaffold "passes
 * eval:query:validate" while the uppercase 'REPLACE/...' slug placeholder
 * failed the validator's dir/slug regex out of the box. These tests run the
 * two CLIs against each other for every tier — the exact contract the header
 * documents — and prove the self-check can FAIL (bogus tier exits 1).
 *
 * generators-16: eval:query:validate's header advertised .ts files but the
 * loader only JSON.parsed. These tests exercise the new dynamic-import path
 * in both directions (valid module exits 0, invalid module exits 1).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = join(import.meta.dir, '../..');
const QUERY_NEW = join(REPO, 'eval/cli/query-new.ts');
const QUERY_VALIDATE = join(REPO, 'eval/cli/query-validate.ts');

let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'query-cli-test-'));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function run(args: string[], stdinFile?: string) {
  return spawnSync('bun', args, { cwd: REPO, encoding: 'utf8', timeout: 30_000, input: stdinFile });
}

describe('eval:query:new → eval:query:validate contract (generators-15)', () => {
  const TIERS = ['easy', 'medium', 'hard', 'adversarial', 'fuzzy', 'externally-authored'];

  for (const tier of TIERS) {
    test(`--tier ${tier} scaffold passes validation end-to-end`, () => {
      const gen = run([QUERY_NEW, '--tier', tier, '--id', `q-test-${tier}`]);
      expect(gen.status).toBe(0);
      // stdout must be pure JSON (hints go to stderr) so `> file.json` works.
      const parsed = JSON.parse(gen.stdout);
      expect(parsed.id).toBe(`q-test-${tier}`);
      const file = join(sandbox, `scaffold-${tier}.json`);
      writeFileSync(file, gen.stdout);
      const val = run([QUERY_VALIDATE, file]);
      expect(val.stdout).toContain('valid');
      expect(val.status).toBe(0);
    });
  }

  test('the self-check can FAIL: a bogus tier exits 1 and prints the validator issue', () => {
    const gen = run([QUERY_NEW, '--tier', 'not-a-tier']);
    expect(gen.status).toBe(1);
    expect(gen.stderr).toContain('does not validate');
    expect(gen.stderr).toContain('tier');
  });

  test('slug placeholders conform to the validator dir/slug regex', () => {
    const gen = run([QUERY_NEW]);
    const parsed = JSON.parse(gen.stdout);
    // The regex the validator enforces (eval/runner/queries/validator.ts).
    const SLUG_RE = /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
    for (const slug of parsed.gold.relevant) {
      expect(slug).toMatch(SLUG_RE);
    }
  });
});

describe('eval:query:validate file loading (generators-16)', () => {
  test('.ts module with a default Query[] export validates (exit 0)', () => {
    const file = join(sandbox, 'good-queries.ts');
    writeFileSync(file, `
      export default [
        {
          id: 'q-ts-0001',
          tier: 'fuzzy',
          text: 'that note about the picking robot demo',
          expected_output_type: 'cited-source-pages',
          gold: { relevant: ['companies/acme-robotics'] },
        },
      ];
    `);
    const val = run([QUERY_VALIDATE, file]);
    expect(val.stdout).toContain('valid');
    expect(val.status).toBe(0);
  });

  test('.ts module with a named `queries` export validates (exit 0)', () => {
    const file = join(sandbox, 'named-queries.ts');
    writeFileSync(file, `
      export const queries = [
        {
          id: 'q-ts-0002',
          tier: 'fuzzy',
          text: 'the follow-up about the picking robot demo',
          expected_output_type: 'cited-source-pages',
          gold: { relevant: ['companies/acme-robotics'] },
        },
      ];
    `);
    const val = run([QUERY_VALIDATE, file]);
    expect(val.status).toBe(0);
  });

  test('.ts module exporting an INVALID query exits 1 (the check can fail)', () => {
    const file = join(sandbox, 'bad-queries.ts');
    writeFileSync(file, `
      export default [
        {
          id: 'q-ts-bad',
          tier: 'fuzzy',
          text: 'where was the team as of last spring', // temporal verb, no as_of_date
          expected_output_type: 'cited-source-pages',
          gold: { relevant: ['NOT A SLUG'] },
        },
      ];
    `);
    const val = run([QUERY_VALIDATE, file]);
    expect(val.status).toBe(1);
    expect(val.stdout + val.stderr).toContain('slug');
  });

  test('.ts module with no array export exits 1 with a clear message', () => {
    const file = join(sandbox, 'empty-module.ts');
    writeFileSync(file, `export const notQueries = 'nope';`);
    const val = run([QUERY_VALIDATE, file]);
    expect(val.status).toBe(1);
    expect(val.stderr).toContain('No queries found');
  });

  test('single-Query JSON object (the query-new scaffold shape) is accepted', () => {
    const file = join(sandbox, 'single.json');
    writeFileSync(file, JSON.stringify({
      id: 'q-single-0001',
      tier: 'fuzzy',
      text: 'the deal with the threshold clause',
      expected_output_type: 'cited-source-pages',
      gold: { relevant: ['deals/threshold-series-a'] },
    }));
    const val = run([QUERY_VALIDATE, file]);
    expect(val.status).toBe(0);
  });

  test('malformed JSON exits 1', () => {
    const file = join(sandbox, 'broken.json');
    writeFileSync(file, '{ not json');
    const val = run([QUERY_VALIDATE, file]);
    expect(val.status).toBe(1);
  });
});
