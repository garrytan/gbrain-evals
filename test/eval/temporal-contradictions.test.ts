import { describe, expect, test } from 'bun:test';
import { generateTemporalEdgesWorld, PHRASING_A } from '../../eval/generators/temporal-edges-gen.ts';
import { judgeClosure, renderE2Person, subLedgerOf } from '../../eval/runner/temporal-contradictions.ts';

describe('temporal-contradictions (P1 E2)', () => {
  const w = generateTemporalEdgesWorld({ seed: 3 });
  const name = (slug: string) => w.companies.find(c => c.slug === slug)!.name;

  test('pages carry only join lines or undated prose, never leave or move cues', () => {
    const kinds = new Set<string>();
    for (const p of w.people) {
      const page = renderE2Person(p, name, PHRASING_A);
      kinds.add(subLedgerOf(p.slug));
      expect(page).not.toContain('Left ');
      if (subLedgerOf(p.slug) === 'undated') expect(page).not.toContain('## Timeline');
      else expect(page.match(/Joined /g)?.length).toBe(p.stints.length);
    }
    expect([...kinds].sort()).toEqual(['dated', 'out_of_order', 'undated']);
  });

  test('a closure is wrong only when the person still worked there on the close date', () => {
    const p = { slug: 'people/x', name: 'X', style: 'timeline' as const, advises: null, invests_after_exit: null, alumni_meeting: null, rejoin_eu: false,
      stints: [{ company: 'companies/a', from: '2010-01-01', until: '2012-01-01', role: 'engineer' }, { company: 'companies/b', from: '2013-01-01', until: null, role: 'CTO' }] };
    expect(judgeClosure(p, { person: p.slug, ending: 'companies/a', close_date: '2013-01-01', status: 'applied' })).toEqual({ wrong: false, late: true });
    expect(judgeClosure(p, { person: p.slug, ending: 'companies/a', close_date: '2012-01-01', status: 'applied' })).toEqual({ wrong: false, late: false });
    expect(judgeClosure(p, { person: p.slug, ending: 'companies/b', close_date: '2020-01-01', status: 'applied' }).wrong).toBe(true);
  });
});
