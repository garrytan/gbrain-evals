import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Entry = { finding: string; paths?: string[]; pattern?: string; reason: string };
const pregate = JSON.parse(readFileSync(new URL('../../.gstack/pregate.json', import.meta.url), 'utf8')) as { allowlist: Entry[] };
const AGGREGATES = 'docs/benchmarks/2026-11-08-rs1-narrow/results/aggregates.json';
const entry = pregate.allowlist.find(e => e.finding === 'env.kv' && e.paths!.includes(AGGREGATES))!;

/** gstack's pregate tests an allowlist pattern from where the flagged value starts, ending at a token boundary. */
const covers = (value: string) => new RegExp(`^(?:${entry.pattern})(?![\\w-])`).test(value);
const inScope = (path: string) => entry.paths!.some(glob => new Bun.Glob(glob).match(path));

const realShaped = [
  ['sk', 'proj', 'Qm7Xc2Vb9Nl4Kj8Hg1Fd6Sa3Pw5Oe0Iu2Yt9Rr4Ee7Ww1Qq3'].join('-'),
  ['sk', 'ant', 'api03', 'Zx9Qw2Lk7Pn4Rt8Yv1Bm6Cd3Fg5Hj0Ks2Lq9Wr4Et7Yu1Io3Pa6Sd8Fg'].join('-'),
];

describe('secrets allowlist: the narrowed RS1 verdict aggregates', () => {
  test("covers the four comparison labels in the aggregates' key fields, as the scanner flags them (from the value, after its opening quote)", () => {
    for (const label of ['memory-bank/frontier', 'memory-bank/bridge', 'extract-first/frontier', 'extract-first/bridge']) {
      expect(covers(`${label}",`)).toBe(true);
      expect(covers(`"${label}"`)).toBe(true);
    }
  });

  test('still flags any other value there', () => {
    for (const value of ['memory-bank/frontier-x"', 'memory-bank/frontier/hunter2"', 'memory-bank/judge"', 'temporal-graph/frontier"', 'memory-bank/frontierhunter2"', 'Memory-bank/frontier"', 'memory-bank/frontier']) expect(covers(value)).toBe(false);
    for (const value of realShaped) {
      expect(covers(`${value}"`)).toBe(false);
      expect(covers(`memory-bank/frontier${value}"`)).toBe(false);
    }
  });

  test("applies to RS1's aggregates.json only", () => {
    expect(inScope(AGGREGATES)).toBe(true);
    for (const path of ['docs/benchmarks/2026-11-08-rs1-narrow/results/aggregates.md', 'docs/benchmarks/2026-11-08-rs1-narrow/results/judge-check.json', 'docs/benchmarks/other/results/aggregates.json', 'eval/runner/rs1/verdict.ts']) expect(inScope(path)).toBe(false);
  });
});
