import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Entry = { finding: string; paths?: string[]; pattern?: string; reason: string };
const pregate = JSON.parse(readFileSync(new URL('../../.gstack/pregate.json', import.meta.url), 'utf8')) as { allowlist: Entry[] };
const R = 'docs/benchmarks/2026-11-19-changing-facts-confirmation-results';
const entry = pregate.allowlist.find(e => e.finding === 'env.kv' && e.paths?.includes(`${R}/confirm.json`))!;

/** gstack's pregate tests an allowlist pattern from where the flagged value starts, ending at a token boundary. */
const covers = (value: string) => new RegExp(`^(?:${entry.pattern})(?![\\w-])`).test(value);
const inScope = (path: string) => entry.paths!.some(glob => new Bun.Glob(glob).match(path));

const realShaped = [
  ['sk', 'proj', 'Qm7Xc2Vb9Nl4Kj8Hg1Fd6Sa3Pw5Oe0Iu2Yt9Rr4Ee7Ww1Qq3'].join('-'),
  ['sk', 'ant', 'api03', 'Zx9Qw2Lk7Pn4Rt8Yv1Bm6Cd3Fg5Hj0Ks2Lq9Wr4Et7Yu1Io3Pa6Sd8Fg'].join('-'),
];

describe('secrets allowlist: the changing-facts confirmation receipts', () => {
  test("covers BG1-C's four comparison names, in its confirm and look receipts only", () => {
    for (const key of ['now|memory-bank', 'now|extract-first', 'past|memory-bank', 'past|extract-first']) expect(covers(`"${key}"`)).toBe(true);
    for (const path of [`${R}/confirm.json`, `${R}/look.json`]) expect(inScope(path)).toBe(true);
    for (const path of [`${R}/other.json`, `${R}.md`, 'docs/benchmarks/2026-11-15-changing-facts-battleground-results/confirm.json']) expect(inScope(path)).toBe(false);
  });

  test('still flags any other value in those files, a real-looking key included', () => {
    const others = ['"now|memory-bank|hunter2"', '"now|memory-bank-x"', '"later|memory-bank"', '"now|gbrain"', '"past|extract-first/hunter2"'];
    for (const value of [...others, ...realShaped.map(v => `"${v}"`), ...realShaped.map(v => `"now|${v}"`)]) expect(covers(value)).toBe(false);
  });
});
