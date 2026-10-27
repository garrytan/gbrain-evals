import { afterAll, describe, expect, test } from 'bun:test';
import { generateTemporalEdgesWorld, PHRASING_A } from '../../eval/generators/temporal-edges-gen.ts';
import { closureIsUpperBound, judgeClosure, renderE2Person, subLedgerOf } from '../../eval/runner/temporal-contradictions.ts';
import { importGbrain, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';

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

describe('late_upper_bound: a closure only the nightly check dated is an upper bound (gbrain W5 rule)', () => {
  const gut = resolveGbrainUnderTest(process.env.GBRAIN_E2_OVERLAY || null);
  const engines: Array<{ disconnect(): Promise<void> }> = [];
  afterAll(async () => { for (const e of engines) await e.disconnect().catch(() => {}); });
  const person = (lines: string[]) => ['---', 'type: person', 'title: Alice Example', '---', 'Alice is CTO of Widget.', '', '## Timeline', '', ...lines, ''].join('\n');
  const JOINED_ACME = '- **2019-02-01** | linkedin — Joined [Acme](../companies/acme-example) as CTO';
  const JOINED_WIDGET = '- **2025-03-01** | linkedin — Joined [Widget](../companies/widget-co) as CTO';
  const INFERRED = '- **2025-03-01** | gbrain-dream (inferred) — Ended works_at [[companies/acme-example]] (superseded by works_at companies/widget-co)';
  const closure = { person: 'people/alice-example', ending: 'companies/acme-example', close_date: '2025-03-01' };

  test('an inferred end alone is an upper bound; an explicit end on the same date, or no end, is not', async () => {
    const { PGLiteEngine } = await importGbrain<any>(gut, 'src/core/pglite-engine.ts');
    const { operations } = await importGbrain<any>(gut, 'src/core/operations.ts');
    const engine = new PGLiteEngine();
    engines.push(engine);
    await engine.connect({});
    await engine.initSchema();
    const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote: false, sourceId: 'default' };
    const revisions = new Map<string, string>();
    const put = async (slug: string, content: string) => {
      const r = await operations.find((o: any) => o.name === 'put_page').handler(ctx, { slug, content, ...(revisions.has(slug) ? { expected_revision: revisions.get(slug) } : {}) });
      revisions.set(slug, r.revision);
    };
    await put('companies/acme-example', '---\ntype: company\ntitle: Acme\n---\nA company.\n');
    await put('companies/widget-co', '---\ntype: company\ntitle: Widget\n---\nAnother company.\n');
    await put(closure.person, person([JOINED_ACME, JOINED_WIDGET]));
    expect(await closureIsUpperBound(engine, closure)).toBe(false);
    await put(closure.person, person([JOINED_ACME, JOINED_WIDGET, INFERRED]));
    expect(await closureIsUpperBound(engine, closure)).toBe(true);
    await put(closure.person, person([JOINED_ACME, '- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example)', JOINED_WIDGET, INFERRED]));
    expect(await closureIsUpperBound(engine, closure)).toBe(false);
  }, 120_000);
});
