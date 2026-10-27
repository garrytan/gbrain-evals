import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_SEEDS, PHRASING_W4, generateWeeklyWorld, validateWeeklyPhrasing, weeklyGold } from '../../eval/generators/belief-weekly-gen.ts';
import { changeKey, f1Of, gatesOf, scoreWeek, type ChangeLike, type EventLike } from '../../eval/runner/belief-weekly-probes.ts';
import { custodyTemplatesInput } from '../../eval/runner/sealed-confirmation-lib.ts';

const fresh = { seed_fact: 'Alpha-example {i} reports metric {n}', seed_take: 'Alpha-example {i} may expand ({n})', fact: '{title} notes item {n}', take: '{title} could pivot, view {n}', transient: '{title} draft line {n}' };

describe('belief-weekly generator (W11, port of the W4 probe)', () => {
  test('dev phrasing renders the probe\'s own lines, and the world is a pure function of seed and phrasing', () => {
    const w = generateWeeklyWorld(DEV_SEEDS[0]);
    expect([...w.initial[0]!.state.facts.keys()]).toEqual(['Company 0 fact 0', 'Company 0 fact 1']);
    expect([...w.initial[0]!.state.takes.keys()]).toEqual(['Company 0 take 2']);
    expect(w.weeks).toHaveLength(4);
    const sizes = w.weeks.map(k => weeklyGold(k.start, k.end).set.size);
    expect(sizes.every(n => n > 0)).toBe(true);
    expect(generateWeeklyWorld(DEV_SEEDS[0]).weeks.map(k => weeklyGold(k.start, k.end).set.size)).toEqual(sizes);
    const lines = w.weeks.flatMap(k => k.writes.flatMap(x => [...x.state.facts.keys(), ...x.state.takes.keys()]));
    expect(lines.every(l => /^(Company \d+ (fact|take) \d+|companies\/[a-z0-9-]+ (fact|take|transient) \d+)$/.test(l))).toBe(true);
  });

  test('fresh phrasing changes every line but not the edit history', () => {
    const dev = generateWeeklyWorld(7);
    const held = generateWeeklyWorld(7, validateWeeklyPhrasing(fresh));
    expect(held.weeks.map(k => k.writes.map(x => [x.slug, x.transient, x.state.facts.size, x.state.takes.size, [...x.state.links]])))
      .toEqual(dev.weeks.map(k => k.writes.map(x => [x.slug, x.transient, x.state.facts.size, x.state.takes.size, [...x.state.links]])));
    const heldLines = held.weeks.flatMap(k => k.writes.flatMap(x => [...x.state.facts.keys(), ...x.state.takes.keys()]));
    expect(heldLines.some(l => / (fact|take|transient) \d+$/.test(l))).toBe(false);
  });

  test('a reverted edit nets to nothing in gold, and every week sees writes the gold does not list', () => {
    const w = generateWeeklyWorld(DEV_SEEDS[0]);
    const transient = w.weeks.flatMap(k => k.writes.filter(x => x.transient));
    expect(transient.length).toBeGreaterThan(0);
    for (const k of w.weeks) for (const x of k.writes.filter(y => y.transient)) {
      const extra = [...x.state.facts.keys()].filter(c => !k.end.get(x.slug)!.facts.has(c));
      for (const c of extra) expect([...weeklyGold(k.start, k.end).set].some(g => g.includes(c))).toBe(false);
    }
  });

  test('phrasing validation refuses templates that would collide or break the tables, naming the template only', () => {
    expect(() => validateWeeklyPhrasing({ ...fresh, fact: '{title} notes item' })).toThrow(/template fact needs \{n\}/);
    expect(() => validateWeeklyPhrasing({ ...fresh, take: '{title} | view {n}' })).toThrow(/template take contains \|/);
    expect(() => validateWeeklyPhrasing({ ...fresh, transient: '{i} draft {n}' })).toThrow(/template transient uses placeholders it cannot fill: \{i\}/);
    expect(() => validateWeeklyPhrasing({ ...fresh, extra: 'x {n}' })).toThrow(/unknown templates: extra/);
    expect(() => validateWeeklyPhrasing({ ...fresh, seed_fact: ' padded {n}' })).toThrow(/surrounding whitespace/);
    // Valid templates can still render one line twice ({n} = 12 after 'L' meets {n} = 2 after 'L1'); the generator refuses that world.
    expect(() => generateWeeklyWorld(1, validateWeeklyPhrasing({ ...fresh, seed_fact: 'L{n}', seed_take: 'L1{n}' }))).toThrow(/renders the same line twice/);
    expect(validateWeeklyPhrasing(PHRASING_W4)).toEqual(PHRASING_W4);
  });
});

describe('belief-weekly scoring', () => {
  const since = '2026-10-17T00:00:00.000Z', until = '2026-10-17T00:10:00.000Z', inside = '2026-10-17T00:05:00.000Z';
  const ev = (id: number, slug: string, event_type: string, recorded_at = inside): EventLike => ({ id, slug, event_type, recorded_at });
  const ch = (o: Partial<ChangeLike> & Pick<ChangeLike, 'kind' | 'slug' | 'change'>, id: number, event = 'fact.revised'): ChangeLike => ({
    subject: {}, before: null, after: null, cause: { event, op: 'put_page' }, evidence: { event_id: id, recorded_at: inside, slug: o.slug }, ...o });
  const gold = { set: new Set(['fact|companies/a|x|changed', 'take|companies/a|y|added', 'link|companies/a|companies/b|added']), values: new Map([['fact|companies/a|x', ['0.6', '0.9'] as [string, string]]]) };
  const events = [ev(1, 'companies/a', 'fact.revised'), ev(2, 'companies/a', 'take.asserted'), ev(3, 'companies/a', 'link.added')];
  const good = [
    ch({ kind: 'fact', slug: 'companies/a', change: 'changed', subject: { claim: 'x' }, before: { confidence: 0.6 }, after: { confidence: 0.9 } }, 1),
    ch({ kind: 'take', slug: 'companies/a', change: 'added', subject: { claim: 'y' } }, 2, 'take.asserted'),
    ch({ kind: 'link', slug: 'companies/a', change: 'added', subject: { to: 'companies/b' } }, 3, 'link.added'),
    ch({ kind: 'link_transition', slug: 'companies/a', change: 'ended', subject: { to: 'companies/b' } }, 99, 'nope'),
  ];

  test('a correct diff passes every check; link transitions are outside the set and the checks', () => {
    const s = scoreWeek(gold, good, events, { since, until });
    expect(s).toMatchObject({ gold: 3, reported: 3, tp: 3, fp: 0, fn: 0, rescored_gold: 1, rescored_exact: 1, rescored_wrong_or_missing: 0, rescored_extra: 0, checked: 3, cause_ok: 3, evidence_ok: 3 });
    expect(changeKey(good[2]!)).toBe('link|companies/a|companies/b|added');
    expect(gatesOf([{ seed: 1, weeks: [{ ...s, page_list_pages: 1, page_list_tokens: 1, belief_diff_tokens: 1 }], ...f1Of([s]) }])).toMatchObject({ valid: true, pass: true });
  });

  // Forced probes: each check fails on the defect it exists for.
  test('a wrong before or after value, or a re-score gold does not hold, fails before/after', () => {
    const wrong = scoreWeek(gold, [{ ...good[0]!, after: { confidence: 0.8 } }, ...good.slice(1)], events, { since, until });
    expect([wrong.rescored_exact, wrong.rescored_wrong_or_missing]).toEqual([0, 1]);
    const extra = scoreWeek(gold, [...good, ch({ kind: 'take', slug: 'companies/a', change: 'changed', subject: { claim: 'z' }, before: { weight: 0.5 }, after: { weight: 0.6 } }, 2, 'take.asserted')], events, { since, until });
    expect([extra.rescored_extra, extra.fp]).toEqual([1, 1]);
    const g = gatesOf([{ seed: 1, weeks: [{ ...extra, page_list_pages: 0, page_list_tokens: 0, belief_diff_tokens: 0 }], ...f1Of([extra]) }]);
    expect(g.gates.before_after.pass).toBe(false);
  });

  test('a cause with another op or another event type, and evidence that points elsewhere or outside the week, fail', () => {
    const bad = [
      { ...good[0]!, cause: { event: 'fact.revised', op: 'sync' } },
      { ...good[1]!, cause: { event: 'fact.revised', op: 'put_page' } },
      { ...good[2]!, evidence: { ...good[2]!.evidence, event_id: 404 } },
    ];
    const s = scoreWeek(gold, bad, events, { since, until });
    expect([s.cause_ok, s.evidence_ok]).toEqual([0, 2]);
    const late = scoreWeek(gold, good, [events[0]!, events[1]!, ev(3, 'companies/a', 'link.added', '2026-10-17T00:11:00.000Z')], { since, until });
    expect(late.evidence_ok).toBe(2);
    const otherPage = scoreWeek(gold, [good[0]!, good[1]!, { ...good[2]!, evidence: { ...good[2]!.evidence, slug: 'companies/b' } }], events, { since, until });
    expect(otherPage.evidence_ok).toBe(2);
    const g = gatesOf([{ seed: 1, weeks: [{ ...s, page_list_pages: 0, page_list_tokens: 0, belief_diff_tokens: 0 }], ...f1Of([s]) }]);
    expect([g.gates.cause.pass, g.gates.evidence_pointer.pass, g.pass]).toEqual([false, false, false]);
  });

  test('set-F1 below 0.95 on any seed fails, and a harness error makes the run invalid rather than a pass', () => {
    const half = scoreWeek(gold, [good[0]!], events, { since, until });
    const ok = scoreWeek(gold, good, events, { since, until });
    const seed = (n: number, w: typeof ok) => ({ seed: n, weeks: [{ ...w, page_list_pages: 0, page_list_tokens: 0, belief_diff_tokens: 0 }], ...f1Of([w]) });
    expect(gatesOf([seed(1, ok), seed(2, half)]).gates.set_f1.pass).toBe(false);
    const broken = gatesOf([seed(1, ok), { ...seed(2, ok), error: 'boom' }]);
    expect([broken.valid, broken.pass]).toEqual([false, false]);
    expect(gatesOf([]).valid).toBe(false);
  });
});

describe('belief-weekly custodian input', () => {
  test('without a phrasing file only the dev seed runs; with one, the access log is written before parsing', () => {
    expect(() => custodyTemplatesInput([], [5], DEV_SEEDS)).toThrow(/only dev seeds/);
    expect(custodyTemplatesInput([], [...DEV_SEEDS], DEV_SEEDS)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'belief-weekly-custody-'));
    const file = join(dir, 'phrasing.json');
    writeFileSync(file, JSON.stringify({ id: 'set-x', templates: fresh }));
    const got = custodyTemplatesInput(['--phrasing-file', file, '--decision-id', 'w11-test', '--purpose', 'unit test', '--output', join(dir, 'out'), '--work', join(dir, 'work')], [5], DEV_SEEDS, { needsWork: true })!;
    expect(validateWeeklyPhrasing(got.parsed.templates)).toEqual(fresh);
    expect(readFileSync(join(dir, 'access-log.jsonl'), 'utf8')).toContain('"decision_id":"w11-test"');
    expect(() => custodyTemplatesInput(['--phrasing-file', file, '--decision-id', 'w11-test', '--purpose', 'unit test', '--output', join(dir, 'out')], [5], DEV_SEEDS, { needsWork: true })).toThrow(/--work/);
  });
});
