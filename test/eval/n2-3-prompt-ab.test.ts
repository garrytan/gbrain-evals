/**
 * N2-3 prompt A/B — keyless, $0. Pins the sampling rule and the paired-flip
 * count, then recounts the committed development receipt from its per-arm
 * files: world fingerprint, offered-pair hash, classification scores and the
 * compare output must all reproduce exactly.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateN2World } from '../../eval/generators/n2-contradiction-gen.ts';
import { scoreClassification, type Judgment } from '../../eval/runner/n2-contradiction-surfacing.ts';
import { compareArms, inSample, offeredKeysSha256, pairedFlips, type ArmResult } from '../../eval/runner/n2-3-prompt-ab.ts';

const DIR = join(import.meta.dir, '../../docs/benchmarks/2026-10-01-n2-contradiction-surfacing/n2-3-prompt-ab');
const read = <T>(f: string): T => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as T;

const j = (query: string, key: string, verdict: Judgment['verdict'], gold: Judgment['gold']): Judgment =>
  ({ query, query_item: query, a: 'x', b: 'y', key, gold, verdict, error: null, dates_seen: [null, null] });

describe('n2-3 prompt A/B helpers', () => {
  test('the unplanted sample is deterministic and about 40%', () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `notes/a-${i}::companies/b-${i}`);
    const hits = keys.filter(inSample).length;
    expect(keys.filter(inSample)).toEqual(keys.filter(inSample));
    expect(hits / keys.length).toBeGreaterThan(0.37);
    expect(hits / keys.length).toBeLessThan(0.44);
  });

  test('paired flips count changes by gold class and refuse mismatched arms', () => {
    const conflict = { planted: true, item: 'i1', kind: 'same_time_conflict', variant: 'undated', gold_class: 'contradiction', older_slug: null } as Judgment['gold'];
    const unplanted = { planted: false, gold_class: 'compatible' } as Judgment['gold'];
    const before = [j('q1', 'k1', 'temporal_regression', conflict), j('q1', 'k2', 'contradiction', unplanted), j('q2', 'k3', 'no_contradiction', unplanted)];
    const after = [j('q1', 'k1', 'contradiction', conflict), j('q1', 'k2', 'no_contradiction', unplanted), j('q2', 'k3', 'no_contradiction', unplanted)];
    expect(pairedFlips(before, after)).toEqual({ contradiction: { gained: 1, lost: 0 }, unplanted: { gained: 0, lost: 1 } });
    expect(() => pairedFlips(before, after.slice(1))).toThrow('arms judged different pairs');
  });
});

describe('committed N2-3 development receipt (seed 20261002)', () => {
  const before = read<ArmResult>('arm-before.json');
  const after = read<ArmResult>('arm-after.json');
  const receipt = read<Record<string, unknown>>('receipt.json');
  const { ledger, fingerprint } = generateN2World({ seed: 20261002 });

  test('both arms ran the regenerated fresh-seed world, not the counted seed', () => {
    for (const arm of [before, after]) {
      expect(arm.seed).toBe(20261002);
      expect(arm.world_fingerprint).toBe(fingerprint);
    }
    expect([before.prompt_version, after.prompt_version]).toEqual(['2', '3']);
  });

  test('offered-pair hashes recount and match across arms and the parity rerun', () => {
    expect(offeredKeysSha256(before.judgments)).toBe(before.offered_keys_sha256);
    expect(offeredKeysSha256(after.judgments)).toBe(after.offered_keys_sha256);
    expect(before.offered_keys_sha256).toBe(after.offered_keys_sha256);
    const parity = read<{ matches_measured: boolean; arms: Record<string, { offered_keys_sha256: string }> }>('parity-2026-10-01.json');
    expect(parity.matches_measured).toBe(true);
    for (const arm of Object.values(parity.arms)) expect(arm.offered_keys_sha256).toBe(before.offered_keys_sha256);
  });

  test('scores recount from the per-pair judgments', () => {
    expect(scoreClassification(ledger, before.judgments)).toEqual(before.score!);
    expect(scoreClassification(ledger, after.judgments)).toEqual(after.score!);
  });

  test('the receipt is exactly what compare produces from the arm files', () => {
    const { ledger_summary: _ledger, ...rest } = receipt;
    expect(JSON.parse(JSON.stringify(compareArms(before, after)))).toEqual(rest);
  });
});
