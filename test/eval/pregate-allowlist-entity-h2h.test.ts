import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Entry = { finding: string; paths?: string[]; pattern?: string; reason: string };
const pregate = JSON.parse(readFileSync(new URL('../../.gstack/pregate.json', import.meta.url), 'utf8')) as { allowlist: Entry[] };
const byFinding = (finding: string, path: string) => pregate.allowlist.find(e => e.finding === finding && e.paths!.includes(path))!;
const dbUrl = byFinding('db.url_with_password', 'docs/comparison-systems/ext-memory-bank/**/docker-compose.yml');
const sentinel = byFinding('env.kv', 'test/eval/entity-h2h-cells.test.ts');
const pageKey = byFinding('env.kv', 'docs/benchmarks/2026-11-18-entity-dedupe-h2h/counted/*/subjects.json');

/** gstack's pregate tests an allowlist pattern from where the flagged value starts, ending at a token boundary. */
const covers = (entry: Entry, value: string) => new RegExp(`^(?:${entry.pattern})(?![\\w-])`).test(value);
const inScope = (entry: Entry, path: string) => entry.paths!.some(glob => new Bun.Glob(glob).match(path));

const product = String.fromCharCode(104) + 'indsight';
const pgUrl = (user: string, password: string, host = 'db', db = product) => ['postgresql:/', `${user}:${password}@${host}:5432`, db].join('/');
const DUMMY_URL = pgUrl(product, product);

const realShaped = [
  ['sk', 'proj', 'Qm7Xc2Vb9Nl4Kj8Hg1Fd6Sa3Pw5Oe0Iu2Yt9Rr4Ee7Ww1Qq3'].join('-'),
  ['sk', 'ant', 'api03', 'Zx9Qw2Lk7Pn4Rt8Yv1Bm6Cd3Fg5Hj0Ks2Lq9Wr4Et7Yu1Io3Pa6Sd8Fg'].join('-'),
];

describe('secrets allowlist: the entity-dedupe head-to-head harness', () => {
  test("covers the memory-bank bundles' internal dummy Postgres URL, in that bundle's compose files only", () => {
    expect(covers(dbUrl, DUMMY_URL)).toBe(true);
    expect(inScope(dbUrl, 'docs/comparison-systems/ext-memory-bank/docker-compose.yml')).toBe(true);
    expect(inScope(dbUrl, 'docs/comparison-systems/ext-memory-bank/entity-h2h/docker-compose.yml')).toBe(true);
    for (const path of ['docs/comparison-systems/ext-temporal-graph/docker-compose.yml', 'docs/comparison-systems/ext-memory-bank/entity-h2h/shim.py', 'eval/runner/entity-h2h/run.ts']) expect(inScope(dbUrl, path)).toBe(false);
  });

  test('still flags any other password, user, host or database in that URL', () => {
    for (const url of [
      pgUrl(product, 'hunter2'),
      pgUrl(product, product, 'db.example.com'),
      pgUrl(product, product, 'db', 'other'),
      pgUrl('admin', 'admin', 'db', 'admin'),
      pgUrl(product, `${product}x`),
      `${DUMMY_URL}?password=hunter2`,
      `${DUMMY_URL}/hunter2`,
    ]) expect(covers(dbUrl, url)).toBe(false);
  });

  test("covers the harness test's sentinel key value, in that test file only", () => {
    expect(covers(sentinel, "must-not-reach-gbrain';")).toBe(true);
    for (const value of ['must-not-reach-gbrain.hunter2', 'must-not-reach-gbrain:hunter2', 'must-not-reach-gbrain/hunter2']) expect(covers(sentinel, value)).toBe(false);
    expect(sentinel.paths).toEqual(['test/eval/entity-h2h-cells.test.ts']);
    expect(inScope(sentinel, 'test/eval/entity-h2h.test.ts')).toBe(false);
  });

  test("covers the counted run's generated page keys, in its subject lists and hand-check samples only", () => {
    for (const key of ['home:yara-mabry', 'work:companies/saltvale', 'home:s-vance']) expect(covers(pageKey, `"${key}"`)).toBe(true);
    for (const value of ['"home:yara-mabry/../x"', '"home:Yara-Mabry"', '"cloud:yara-mabry"', '"home:yara_mabry"', '"home:yara-mabry:hunter2"', '"home:companies/a/b"']) expect(covers(pageKey, value)).toBe(false);
    const R = 'docs/benchmarks/2026-11-18-entity-dedupe-h2h/counted';
    for (const path of [`${R}/ext-memory-bank/subjects.json`, `${R}/gpt/hand-check-sample.json`]) expect(inScope(pageKey, path)).toBe(true);
    for (const path of [`${R}/subjects.json`, `${R}/gbrain/finder.json`, `${R}/ext-memory-bank/output.json`, 'docs/benchmarks/2026-11-17-person-dedupe/counted/x/subjects.json']) expect(inScope(pageKey, path)).toBe(false);
  });

  test('still flags a real-looking key at either path', () => {
    for (const value of realShaped) {
      expect(covers(sentinel, value)).toBe(false);
      expect(covers(sentinel, `must-not-reach-gbrain-${value}`)).toBe(false);
      expect(covers(dbUrl, pgUrl(product, value))).toBe(false);
      expect(covers(pageKey, `"${value}"`)).toBe(false);
    }
  });
});
