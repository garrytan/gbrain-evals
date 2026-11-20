import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const pregate = JSON.parse(readFileSync(new URL('../../.gstack/pregate.json', import.meta.url), 'utf8')) as {
  allowlist: { finding: string; paths?: string[]; pattern?: string; reason: string }[];
};
const entry = pregate.allowlist.find(e => e.reason === "episode ids in correction records' key fields")!;

/** gstack's pregate tests an allowlist pattern from where the flagged value starts, ending at a token boundary. */
const covers = (value: string) => new RegExp(`^(?:${entry.pattern})(?![\\w-])`).test(value);

describe('secrets allowlist: G6 correction episode ids', () => {
  test('is one env.kv entry scoped to predictive-measures correction records', () => {
    expect(entry).toBeDefined();
    expect(entry.finding).toBe('env.kv');
    expect(entry.paths).toEqual(['docs/benchmarks/predictive-measures/*/correction-*.json']);
  });

  test('covers the three rescored episode ids', () => {
    for (const id of ['g6:claude-opus-5-5:oov-7-p002:local:0', 'g6:particle-1:oov-7-p012:local:1', 'g6:particle-1:oov-7-p030:local:3']) {
      expect(covers(`"${id}",`)).toBe(true);
      expect(covers(`${id}",`)).toBe(true);
    }
  });

  test('does not cover a real-looking key, or a key appended to an episode id', () => {
    const anthropicShaped = ['sk', 'ant', 'api03', 'Zx9Qw2Lk7Pn4Rt8Yv1Bm6Cd3Fg5Hj0Ks2Lq9Wr4Et7Yu1Io3Pa6Sd8Fg'].join('-');
    const openaiShaped = ['sk', 'proj', 'Qm7Xc2Vb9Nl4Kj8Hg1Fd6Sa3Pw5Oe0Iu2Yt9Rr4Ee7Ww1Qq3'].join('-');
    const hex40 = '9f86d081884c7d659a2feaea0c55ad01'.concat('5a3bf4f1');
    const appended = ['', '-', ':', '.', '/'].flatMap(sep => [anthropicShaped, hex40].map(key => `g6:particle-1:oov-7-p012:local:1${sep}${key}`));
    for (const value of [anthropicShaped, openaiShaped, hex40, ...appended]) {
      expect(covers(`"${value}",`)).toBe(false);
      expect(covers(value)).toBe(false);
    }
  });
});
