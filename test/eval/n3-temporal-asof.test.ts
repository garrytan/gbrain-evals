import { describe, expect, test } from 'bun:test';
import { ForwardJobState } from '../../eval/generators/job-state.ts';
import {
  N3_DEFAULT_SEED, easternWallToUtcMs, expectedEffectiveDate, generateN3World, isoWeekStart, ledgerTimelineRows,
  oracleEmployer, oracleLastSeen, relativeWorld, timelineRowId, type LedgerTimelineRow, type PersonEvent,
} from '../../eval/generators/n3-temporal-gen.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import {
  employerFromNotes, n3Verdict, runN3, runtimeProbeCount, setF1, summarize, type ProbeRow,
} from '../../eval/runner/n3-temporal-asof.ts';

describe('generator determinism', () => {
  test('same seed, same ledger fingerprint and probes; different seed, different ledger', () => {
    const a = generateN3World();
    const b = generateN3World({ seed: N3_DEFAULT_SEED });
    const c = generateN3World({ seed: N3_DEFAULT_SEED + 1 });
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.probes.map(p => p.id)).toEqual(a.probes.map(p => p.id));
    expect(c.fingerprint).not.toBe(a.fingerprint);
    expect(JSON.stringify(c.ledger.person_events)).not.toBe(JSON.stringify(a.ledger.person_events));
  });

  test('every probe has gold, and each family carries negative controls', () => {
    const w = generateN3World();
    for (const p of w.probes) expect(w.gold.has(p.id)).toBe(true);
    const negByFeature = new Set(w.probes.filter(p => w.negative.has(p.id)).map(p => p.feature));
    for (const f of ['asof_facts', 'search_date_bounds', 'chronicle_day', 'chronicle_last_seen', 'trajectory_range', 'chronicle_on_this_day']) expect(negByFeature.has(f as never)).toBe(true);
  });

  test('fictional placeholder names only', () => {
    const w = generateN3World();
    for (const p of w.ledger.people) expect(p.slug).toMatch(/^people\/[a-z]+-example(-[a-z0-9]+)?$/);
    for (const c of w.ledger.companies) expect(c.id).toMatch(/^startup-\d$/);
  });
});

describe('oracles on hand-built cases', () => {
  test('ForwardJobState: on-day change counts, before any job is null, out-of-order input throws', () => {
    const m = new ForwardJobState(['2022-01-01', '2022-03-01', '2022-03-02', '2023-01-01']);
    m.observe('2022-02-01', 'spoke at startup-4');
    m.observe('2022-03-02', 'joined startup-1');
    m.observe('2022-06-01', 'hired by startup-2');
    expect(Object.fromEntries(m.finish())).toEqual({ '2022-01-01': null, '2022-03-01': null, '2022-03-02': 'startup-1', '2023-01-01': 'startup-2' });
    const bad = new ForwardJobState([]);
    bad.observe('2022-02-01', 'joined startup-1');
    expect(() => bad.observe('2022-01-01', 'joined startup-2')).toThrow();
  });

  test('valid-time vs recorded-time employer differ for a late record', () => {
    const ev = (i: number, date: string, recorded_on: string, summary: string): PersonEvent => ({
      id: `p#${i}`, person: 'people/x-example', date, type: summary.startsWith('joined') ? 'joined' : 'spoke at', company: summary.split(' ').pop()!,
      summary, recorded_on, late: recorded_on !== date, note_slug: `notes/x-${i}`, scenario: 'normal',
    });
    const events = [ev(0, '2022-01-01', '2022-01-01', 'joined startup-0'), ev(1, '2022-05-01', '2022-09-01', 'joined startup-1')];
    expect(oracleEmployer(events, 'people/x-example', '2022-06-01')).toBe('startup-1');
    expect(oracleEmployer(events, 'people/x-example', '2022-06-01', '2022-06-01')).toBe('startup-0');
    expect(oracleEmployer(events, 'people/x-example', '2021-12-31')).toBe(null);
  });

  test('last seen: own rows and exact who membership, by day, never after asof', () => {
    const rows: LedgerTimelineRow[] = [
      { page_slug: 'people/lee-example', date: '2022-01-05', summary: 'a', kind: null, instant_ms: 0, who: [] },
      { page_slug: 'meetings/m1', date: '2023-05-01', summary: 'b', kind: 'call', instant_ms: Date.UTC(2023, 4, 2, 3, 30), who: ['people/lee-example-jr', 'people/dave-example'] },
      { page_slug: 'people/dave-example', date: '2023-05-02', summary: 'c', kind: null, instant_ms: Date.UTC(2023, 4, 2), who: [] },
    ];
    expect(oracleLastSeen(rows, 'people/lee-example', '2024-01-01')).toEqual({ last_date: '2022-01-05', days_ago: 726 });
    expect(oracleLastSeen(rows, 'people/kim-example', '2024-01-01')).toEqual({ last_date: null, days_ago: null });
    expect(oracleLastSeen(rows, 'people/dave-example', '2023-05-02')).toEqual({ last_date: '2023-05-02', days_ago: 0 });
    expect(oracleLastSeen(rows, 'people/dave-example', '2023-05-01')).toEqual({ last_date: '2023-05-01', days_ago: 0 });
    expect(oracleLastSeen(rows, 'people/dave-example', '2023-04-30')).toEqual({ last_date: null, days_ago: null });
  });

  test('US Eastern offsets across both 2024 DST changes, ISO weeks, and date precedence', () => {
    expect(new Date(easternWallToUtcMs('2024-03-09', 19, 30)).toISOString()).toBe('2024-03-10T00:30:00.000Z');
    expect(new Date(easternWallToUtcMs('2024-03-10', 19, 30)).toISOString()).toBe('2024-03-10T23:30:00.000Z');
    expect(new Date(easternWallToUtcMs('2024-11-02', 19, 30)).toISOString()).toBe('2024-11-02T23:30:00.000Z');
    expect(new Date(easternWallToUtcMs('2024-11-03', 19, 30)).toISOString()).toBe('2024-11-04T00:30:00.000Z');
    expect(isoWeekStart('2024-03-10')).toBe('2024-03-04');
    expect(isoWeekStart('2024-03-11')).toBe('2024-03-11');
    expect(expectedEffectiveDate('meetings/2023-02-01-x', { date: '2023-03-01' }, '2023-02-01')).toEqual({ day: '2023-02-01', source: 'filename' });
    expect(expectedEffectiveDate('notes/2023-02-01-x', { published: '2023-03-01', created: '2023-01-01' }, '2023-02-01')).toEqual({ day: '2023-03-01', source: 'published' });
    expect(expectedEffectiveDate('notes/x', { created: '2023-01-01', event_date: '2023-06-01', date: '2023-05-01' }, null)).toEqual({ day: '2023-06-01', source: 'event_date' });
  });

  test('clock-relative windows keep every page away from window edges', () => {
    const { probes } = relativeWorld('2026-09-30');
    const since7 = probes.find(p => p.id === 'relative:since=7d')!;
    expect(since7.expected_ages).toEqual([2]);
    expect(probes.find(p => p.id === 'relative:since=1m,until=7d')!.expected_ages).toEqual([10, 20]);
    expect(probes.filter(p => p.expected_ages === 'reject').length).toBe(5);
  });

  test('timeline row ids are unique across the ledger', () => {
    const rows = ledgerTimelineRows(generateN3World().ledger);
    expect(new Set(rows.map(timelineRowId)).size).toBe(rows.length);
  });
});

describe('metric math and degenerate baselines', () => {
  test('set F1', () => {
    expect(setF1([], []).f1).toBe(1);
    expect(setF1([], ['a']).f1).toBe(0);
    expect(setF1(['a'], []).f1).toBe(0);
    expect(setF1(['a', 'b'], ['a', 'b']).f1).toBe(1);
    expect(setF1(['a', 'b'], ['a', 'c']).f1).toBeCloseTo(0.5);
  });

  test('employerFromNotes reads the latest stated job change on or before asof', () => {
    const chunks = ['On 2022-01-01, alice joined startup-1. Note written 2022-01-01.', 'On 2022-06-01, alice hired by startup-2. Note written 2022-09-01.', 'On 2022-07-01, alice spoke at startup-4.'];
    expect(employerFromNotes(chunks, '2022-05-31')).toBe('startup-1');
    expect(employerFromNotes(chunks, '2022-06-01')).toBe('startup-2');
    expect(employerFromNotes(chunks, '2021-01-01')).toBe(null);
  });

  test('"return everything", "refuse everything" and "always the latest employer" all score badly', () => {
    const w = generateN3World();
    const setProbes = w.probes.filter(p => (w.gold.get(p.id) as { kind: string }).kind === 'set');
    const universe = [...new Set(setProbes.flatMap(p => (w.gold.get(p.id) as { ids: string[] }).ids))];
    const everything = setProbes.map(p => setF1((w.gold.get(p.id) as { ids: string[] }).ids, universe).f1);
    const nothing = setProbes.map(p => setF1((w.gold.get(p.id) as { ids: string[] }).ids, []).f1);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(everything)).toBeLessThan(0.35);
    expect(avg(nothing)).toBeLessThan(0.45);

    const asof = w.probes.filter(p => p.feature === 'asof_facts');
    const latest = (person: string) => oracleEmployer(w.ledger.person_events, person, '2099-01-01');
    const latestAcc = avg(asof.map(p => (w.gold.get(p.id) as { company: string | null }).company === latest((p as { person: string }).person) ? 1 : 0));
    const nullAcc = avg(asof.map(p => (w.gold.get(p.id) as { company: string | null }).company === null ? 1 : 0));
    expect(latestAcc).toBeLessThan(0.5);
    expect(nullAcc).toBeLessThan(0.5);
  });

  test('verdict passes only when every metric is exact; negative controls are counted', () => {
    const row = (id: string, feature: ProbeRow['feature'], pass: boolean, negative = false, f1?: number): ProbeRow => ({ probe_id: id, feature, negative, status: 'scored', pass, f1, gold: null, predicted: null });
    const perfect = [row('a', 'asof_facts', true), row('b', 'asof_timeline', true), row('c', 'chronicle_day', true, true, 1), row('d', 'chronicle_last_seen', true)];
    const s = summarize(perfect, { lastSeenErrors: [0], pagedate: [] });
    expect(n3Verdict(s)).toBe('pass');
    expect(s.negative_controls).toBe(1);
    const oneMiss = summarize([...perfect.slice(0, 3), row('d', 'chronicle_last_seen', false)], { lastSeenErrors: [1], pagedate: [] });
    expect(oneMiss.last_seen_mae_days).toBe(1);
    expect(n3Verdict(oneMiss)).toBe('fail');
    const refuseAll = summarize([row('c', 'chronicle_day', false, false, 0), row('e', 'chronicle_day', true, true, 1)], { lastSeenErrors: [], pagedate: [] });
    expect(refuseAll.range_set_f1).toBe(0.5);
    expect(n3Verdict(refuseAll)).toBe('fail');
  });
});

describe('end to end against the pinned gbrain', () => {
  test('small world: presence holds, every probe is scored, receipt metrics are finite', async () => {
    const gut = resolveGbrainUnderTest(null);
    const r = await runN3({ gut, seed: 11, people: 4, meetings: 4, anchorDay: new Date().toISOString().slice(0, 10) });
    expect(r.harnessError).toBe(null);
    expect(r.presence.length).toBeGreaterThan(5);
    for (const p of r.presence) expect([p.name, p.ok]).toEqual([p.name, true]);
    const a = r.acc.summary();
    expect(a.n_total).toBe(r.world.probes.length + runtimeProbeCount(r.world.ledger));
    expect(r.rows.length).toBe(a.n_total);
    expect(a.completion_rate).toBe(1);
    expect(a.errors.filter(e => e.origin !== 'sut')).toEqual([]);
    expect(Number.isFinite(r.summary!.asof_accuracy)).toBe(true);
    expect(Number.isFinite(r.summary!.range_set_f1)).toBe(true);
    expect(r.summary!.negative_controls).toBeGreaterThan(10);
    expect(['pass', 'fail']).toContain(r.verdict!);
  }, 60_000);
});
