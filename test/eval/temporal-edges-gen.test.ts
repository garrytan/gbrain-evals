import { describe, expect, test } from 'bun:test';
import {
  DEV_SEEDS, currentEmployers, employersAt, employersDuring, generateTemporalEdgesWorld,
} from '../../eval/generators/temporal-edges-gen.ts';

describe('temporal-edges generator (dev phrasing set A)', () => {
  test('deterministic per seed, different across seeds', () => {
    const a = generateTemporalEdgesWorld({ seed: DEV_SEEDS[0] });
    expect(generateTemporalEdgesWorld({ seed: DEV_SEEDS[0] }).fingerprint).toBe(a.fingerprint);
    expect(generateTemporalEdgesWorld({ seed: DEV_SEEDS[1] }).fingerprint).not.toBe(a.fingerprint);
  });

  test('development sets A2 and A3 render the same ledger with different wording', () => {
    const a = generateTemporalEdgesWorld({ seed: 3 });
    for (const phrasing of ['A2', 'A3'] as const) {
      const w = generateTemporalEdgesWorld({ seed: 3, phrasing });
      expect(w.phrasing).toBe(phrasing);
      expect(w.people.map(p => p.stints)).toEqual(a.people.map(p => p.stints));
      expect(w.asof_probes).toEqual(a.asof_probes);
      expect(w.fingerprint).not.toBe(a.fingerprint);
    }
  });

  test('held-out phrasing sets are refused', () => {
    expect(() => generateTemporalEdgesWorld({ seed: 3, phrasing: 'B' })).toThrow(/held out/);
  });

  test('stints are ordered and non-overlapping; at most one current employer', () => {
    for (const seed of DEV_SEEDS) {
      for (const p of generateTemporalEdgesWorld({ seed }).people) {
        for (let k = 1; k < p.stints.length; k++) {
          expect(p.stints[k - 1].until).not.toBeNull();
          expect(p.stints[k].from >= p.stints[k - 1].until!).toBe(true);
        }
        expect(currentEmployers(p).length).toBeLessThanOrEqual(1);
      }
    }
  });

  test('gold follows the ledger: half-open stints, during overlaps', () => {
    const p = { slug: 'people/x', name: 'X', style: 'timeline' as const, advises: null, invests_after_exit: null, alumni_meeting: null, rejoin_eu: false,
      stints: [{ company: 'companies/a', from: '2020-01-01', until: '2022-06-01', role: 'engineer' }, { company: 'companies/b', from: '2022-06-01', until: null, role: 'CTO' }] };
    expect(employersAt(p, '2022-05-31')).toEqual(['companies/a']);
    expect(employersAt(p, '2022-06-01')).toEqual(['companies/b']);
    expect(employersDuring(p, '2022-01-01', '2023-01-01')).toEqual(['companies/a', 'companies/b']);
    expect(currentEmployers(p)).toEqual(['companies/b']);
  });

  test('company pages come before the people who link to them', () => {
    const w = generateTemporalEdgesWorld({ seed: 3 });
    const firstPerson = w.pages.findIndex(p => p.slug.startsWith('people/'));
    expect(w.pages.slice(0, firstPerson).every(p => p.slug.startsWith('companies/'))).toBe(true);
    expect(w.pages.slice(firstPerson).every(p => p.slug.startsWith('people/'))).toBe(true);
  });
});
