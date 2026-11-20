import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Entry = { finding: string; paths?: string[]; pattern?: string; reason: string };
const pregate = JSON.parse(readFileSync(new URL('../../.gstack/pregate.json', import.meta.url), 'utf8')) as { allowlist: Entry[] };
const entry = pregate.allowlist.find(e => e.finding === 'env.kv' && e.paths?.includes('docs/benchmarks/*/analysis/*.json'))!;

/** gstack's pregate tests an allowlist pattern from where the flagged value starts, ending at a token boundary. */
const covers = (value: string) => new RegExp(`^(?:${entry.pattern})(?![\\w-])`).test(value);
const inScope = (path: string) => entry.paths!.some(glob => new Bun.Glob(glob).match(path));

const realShaped = [
  ['sk', 'proj', 'Qm7Xc2Vb9Nl4Kj8Hg1Fd6Sa3Pw5Oe0Iu2Yt9Rr4Ee7Ww1Qq3'].join('-'),
  ['sk', 'ant', 'api03', 'Zx9Qw2Lk7Pn4Rt8Yv1Bm6Cd3Fg5Hj0Ks2Lq9Wr4Et7Yu1Io3Pa6Sd8Fg'].join('-'),
];

describe('secrets allowlist: the Cat 40 Hard analysis interval field name', () => {
  test('covers the interval field names the analysis writes, in benchmark analysis JSON only', () => {
    for (const value of ['"ci_z1.98"', '"ci_z2.80"', 'ci_z1.98"']) expect(covers(value)).toBe(true);
    expect(inScope('docs/benchmarks/2026-11-19-cat40-hard-newest/analysis/final.json')).toBe(true);
    for (const path of ['docs/benchmarks/2026-11-19-cat40-hard-newest/n1/gbrain-particle/receipt-1.json', 'eval/runner/cat40/newest_analysis.py', 'docs/benchmarks/analysis.json']) expect(inScope(path)).toBe(false);
  });

  test('still flags anything else in that field', () => {
    for (const value of ['"ci_z1.98x"', '"ci_z1.98-hunter2"', '"ci_z12.345"', '"ci_z1.9"', '"sk_live_ci_z1.98"', ...realShaped.map(v => `"${v}"`), ...realShaped.map(v => `"ci_z1.98${v}"`)]) expect(covers(value)).toBe(false);
  });
});
