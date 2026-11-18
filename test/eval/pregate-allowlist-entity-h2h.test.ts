import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Entry = { finding: string; paths?: string[]; pattern?: string; reason: string };
const pregate = JSON.parse(readFileSync(new URL('../../.gstack/pregate.json', import.meta.url), 'utf8')) as { allowlist: Entry[] };
const byFinding = (finding: string, path: string) => pregate.allowlist.find(e => e.finding === finding && e.paths!.includes(path))!;
const dbUrl = byFinding('db.url_with_password', 'docs/comparison-systems/ext-memory-bank/**/docker-compose.yml');
const sentinel = byFinding('env.kv', 'test/eval/entity-h2h-cells.test.ts');

/** gstack's pregate tests an allowlist pattern from where the flagged value starts, ending at a token boundary. */
const covers = (entry: Entry, value: string) => new RegExp(`^(?:${entry.pattern})(?![\\w-])`).test(value);
const inScope = (entry: Entry, path: string) => entry.paths!.some(glob => new Bun.Glob(glob).match(path));

const product = String.fromCharCode(104) + 'indsight';
const DUMMY_URL = `postgresql://${product}:${product}@db:5432/${product}`;

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
      `postgresql://${product}:hunter2@db:5432/${product}`,
      `postgresql://${product}:${product}@db.example.com:5432/${product}`,
      `postgresql://${product}:${product}@db:5432/other`,
      `postgresql://admin:admin@db:5432/admin`,
      `postgresql://${product}:${product}x@db:5432/${product}`,
      `postgresql://${product}:${product}@db:5432/${product}?password=hunter2`,
      `postgresql://${product}:${product}@db:5432/${product}/hunter2`,
    ]) expect(covers(dbUrl, url)).toBe(false);
  });

  test("covers the harness test's sentinel key value, in that test file only", () => {
    expect(covers(sentinel, "must-not-reach-gbrain';")).toBe(true);
    for (const value of ['must-not-reach-gbrain.hunter2', 'must-not-reach-gbrain:hunter2', 'must-not-reach-gbrain/hunter2']) expect(covers(sentinel, value)).toBe(false);
    expect(sentinel.paths).toEqual(['test/eval/entity-h2h-cells.test.ts']);
    expect(inScope(sentinel, 'test/eval/entity-h2h.test.ts')).toBe(false);
  });

  test('still flags a real-looking key at either path', () => {
    for (const value of realShaped) {
      expect(covers(sentinel, value)).toBe(false);
      expect(covers(sentinel, `must-not-reach-gbrain-${value}`)).toBe(false);
      expect(covers(dbUrl, `postgresql://${product}:${value}@db:5432/${product}`)).toBe(false);
    }
  });
});
