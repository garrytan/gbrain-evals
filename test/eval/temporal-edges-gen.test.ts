import { describe, expect, test } from 'bun:test';
import {
  DEV_SEEDS, E5_FORMS, E5_PROBES_PER_SEED, E5_TARGETS, PHRASING_A2, currentEmployers, employersAt, employersDuring, generateTemporalEdgesWorld, rangeRendered,
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

  test('render relation-lines: a seeded half states employment only as ranged relation lines; ledger and probes unchanged', () => {
    for (const seed of DEV_SEEDS) {
      const base = generateTemporalEdgesWorld({ seed });
      const w = generateTemporalEdgesWorld({ seed, render: 'relation-lines' });
      expect(w.people).toEqual(base.people);
      expect(w.asof_probes).toEqual(base.asof_probes);
      const ranged = new Set(w.range_people);
      expect(ranged.size).toBeGreaterThan(w.people.length * 0.3);
      expect(ranged.size).toBeLessThan(w.people.length * 0.7);
      for (const p of w.people) {
        expect(ranged.has(p.slug)).toBe(rangeRendered(seed, p.slug));
        const page = w.pages.find(x => x.slug === p.slug)!.content;
        if (!ranged.has(p.slug)) { expect(page).toBe(base.pages.find(x => x.slug === p.slug)!.content); continue; }
        const lines = page.split('\n').filter(l => l.startsWith('- works_at '));
        expect(lines).toEqual(p.stints.map(s => `- works_at @effective[${s.from},${s.until ?? ''}) [[${s.company}]]`));
        expect(page.indexOf('## Roles')).toBeLessThan(page.indexOf('- works_at'));
        expect(page).not.toMatch(/^company:/m);
        if (p.advises) expect(page).toContain(`- advises @effective[${p.advises.from},) [[${p.advises.company}]]`);
        expect(page).not.toContain('linkedin —');
      }
    }
  });

  test('E5 probe: probe people on their own companies; the world is unchanged; every form and target is covered', () => {
    const base = generateTemporalEdgesWorld({ seed: 3 });
    const w = generateTemporalEdgesWorld({ seed: 3, e5Probe: true });
    expect(w.people).toEqual(base.people);
    expect(w.pages.slice(0, base.pages.length)).toEqual(base.pages);
    expect(w.e5_probes!.length).toBe(E5_PROBES_PER_SEED);
    for (const form of E5_FORMS) for (const target of E5_TARGETS) expect(w.e5_probes!.filter(p => p.e5.form === form && p.e5.target === target).length).toBeGreaterThanOrEqual(5);
    const probeCompanies = new Set(w.e5_companies!.map(c => c.slug));
    for (const p of w.e5_probes!) {
      expect(p.stints.length).toBe(1);
      expect(p.stints[0]!.until).toBeNull();
      expect(probeCompanies.has(p.stints[0]!.company) && probeCompanies.has(p.e5.advisory_target)).toBe(true);
      expect(p.e5.target === 'same' ? p.e5.advisory_target === p.stints[0]!.company : p.e5.advisory_target !== p.stints[0]!.company).toBe(true);
      expect(p.e5.advisory_on > p.stints[0]!.from).toBe(true);
      const page = w.pages.find(x => x.slug === p.slug)!.content;
      if (p.e5.form === 'became_advisor_at') expect(page).toContain(`| note — Became an advisor at [`);
      if (p.e5.form === 'took_advisory_role_with') expect(page).toContain(`| linkedin — Took an advisory role with [`);
      if (p.e5.target === 'other') expect(page).toContain(`also works at [`);
    }
    const a2 = generateTemporalEdgesWorld({ seed: 3, phrasing: 'A2', e5Probe: true });
    const tlAdvise = a2.e5_probes!.find(p => p.e5.form === 'tl_advise')!;
    expect(a2.pages.find(x => x.slug === tlAdvise.slug)!.content).toContain(PHRASING_A2.tl_advise.replace('note — ', '').split('{company}')[0]!);
  });
});
