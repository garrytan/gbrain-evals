import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const pregate = JSON.parse(readFileSync(new URL('../../.gstack/pregate.json', import.meta.url), 'utf8')) as {
  allowlist: { finding: string; paths?: string[]; pattern?: string; reason: string }[];
};
const entry = pregate.allowlist.find(e => e.reason === "N6's description of its expired-token probe, not a token")!;

/** gstack's pregate tests an allowlist pattern from where the flagged value starts, ending at a token boundary. */
const covers = (value: string) => new RegExp(`^(?:${entry.pattern})(?![\\w-])`).test(value);
const inScope = (path: string) => entry.paths!.some(glob => new Bun.Glob(glob).match(path));

const RECEIPT = 'docs/benchmarks/2026-11-17-engine-bench/correctness/work/n6-http-postgres/receipt.json';
const DESCRIPTION = 'client_credentials token from a client with --token-ttl 60, used after expires_in (60s) plus 5 s';

describe("secrets allowlist: N6's expired-token description", () => {
  test('is one env.kv entry covering counted n6pg receipts and the engine-bench correctness receipt', () => {
    expect(entry).toBeDefined();
    expect(entry.finding).toBe('env.kv');
    expect(entry.pattern).toBe('"?client_credentials token from a client w[^"]*');
    expect(entry.paths).toEqual(['docs/benchmarks/*/counted/*/n6pg*-receipt.json', 'docs/benchmarks/*/correctness/work/n6-http-postgres/receipt.json']);
  });

  test('scopes to the N6-over-HTTP Postgres receipt of any dated engine-bench run, and no other file', () => {
    expect(inScope(RECEIPT)).toBe(true);
    expect(inScope('docs/benchmarks/2026-12-01-engine-bench/correctness/work/n6-http-postgres/receipt.json')).toBe(true);
    expect(inScope('docs/benchmarks/2026-10-11-wave14-repin/counted/77cf8e111/n6pg-receipt.json')).toBe(true);
    for (const path of [
      'docs/benchmarks/2026-11-17-engine-bench/correctness/work/n6-http-pglite/receipt.json',
      'docs/benchmarks/2026-11-17-engine-bench/correctness/work/n6-postgres/receipt.json',
      'docs/benchmarks/2026-11-17-engine-bench/correctness/work/n6-http-postgres/other.json',
      'docs/benchmarks/2026-11-17-engine-bench/correctness/out/receipt.json',
      'docs/benchmarks/a/b/correctness/work/n6-http-postgres/receipt.json',
      'eval/runner/engine-bench/correctness.ts',
    ]) expect(inScope(path)).toBe(false);
  });

  test("covers the receipt's description line", () => {
    expect(covers(`"${DESCRIPTION}",`)).toBe(true);
    expect(covers(`${DESCRIPTION}",`)).toBe(true);
  });

  test('still flags a real-looking token at that path', () => {
    expect(inScope(RECEIPT)).toBe(true);
    const anthropicShaped = ['sk', 'ant', 'api03', 'Zx9Qw2Lk7Pn4Rt8Yv1Bm6Cd3Fg5Hj0Ks2Lq9Wr4Et7Yu1Io3Pa6Sd8Fg'].join('-');
    const openaiShaped = ['sk', 'proj', 'Qm7Xc2Vb9Nl4Kj8Hg1Fd6Sa3Pw5Oe0Iu2Yt9Rr4Ee7Ww1Qq3'].join('-');
    const bearerShaped = ['gbrain', 'at', 'Rk3Vt8Wn2Lp6Qz9Xc1Bm4Hj7Fd5Gs0Ty'].join('_');
    const hex40 = '9f86d081884c7d659a2feaea0c55ad01'.concat('5a3bf4f1');
    for (const value of [anthropicShaped, openaiShaped, bearerShaped, hex40]) {
      expect(covers(`"${value}",`)).toBe(false);
      expect(covers(value)).toBe(false);
    }
  });
});
