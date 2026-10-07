/**
 * Scorer mutation kit (eval/runner/mutation-kit.ts) and its demonstration on
 * N3, N4 and N6: each category's scorer must pass the honest system and fail
 * the empty, always-positive, always-refuse, stale and wrong-source fakes.
 *
 * N4 and N6 are graded by their preregistered promotion rules
 * (eval/registry.ts), so these tests also show the CI gate itself rejects
 * every fake. N3's probe comparisons sit inside its runner next to the
 * gbrain calls; the suite applies the same comparison rules per gold kind
 * (setF1 is shared) and grades with the runner's own summarize and n3Verdict.
 */
import { describe, expect, test } from 'bun:test';
import { registryEntry } from '../../eval/registry.ts';
import { evaluatePromotion } from '../../eval/runner/promotion.ts';
import {
  FAKE_SYSTEM_KINDS, assertScorerRejectsFakeSystems, mutationProblems, runMutationSuite, type MutationSuite,
} from '../../eval/runner/mutation-kit.ts';
import { N3_DEFAULT_SEED, generateN3World, type N3Gold, type N3Probe } from '../../eval/generators/n3-temporal-gen.ts';
import { n3Verdict, setF1, summarize, type ProbeRow } from '../../eval/runner/n3-temporal-asof.ts';
import { deriveGold, entityByPage, generateLedger, type Gold as N4Gold, type LedgerMention } from '../../eval/generators/n4-entity-gen.ts';
import { GoldStore } from '../../eval/runner/evaluator/gold-store.ts';
import { baselinePrediction, scoreSurface, verdictOf, writtenPages, type Prediction, type ScoringContext } from '../../eval/runner/n4-entity-resolution.ts';
import { generateN6World, type N6ClassSpec } from '../../eval/generators/n6-visibility-gen.ts';
import { controlSeen, scanLeaks, type CallOutcome } from '../../eval/runner/n6-visibility-fuzz.ts';

describe('mutation kit', () => {
  const probes = [1, 2, 3];
  const space = {
    truth: (p: number) => p, empty: () => 0, everything: () => 99, refusal: () => -1,
    stale: (p: number) => (p > 1 ? p - 1 : undefined), wrongSource: (p: number) => p + 10,
  };
  const exact: MutationSuite<number, number>['score'] = answers => ({ pass: answers.every((a, i) => a === probes[i]), detail: answers.join(',') });

  test('an exact scorer rejects all five fakes and passes the honest system', () => {
    const results = assertScorerRejectsFakeSystems({ category: 'toy', probes, space, score: exact });
    expect(results.map(r => r.system)).toEqual(['honest', ...FAKE_SYSTEM_KINDS]);
    expect(results.filter(r => r.pass).map(r => r.system)).toEqual(['honest']);
  });

  test('a vacuous scorer is caught: every fake that passes is named', () => {
    const problems = mutationProblems('vacuous', runMutationSuite({ category: 'vacuous', probes, space, score: () => ({ pass: true, detail: 'always' }) }));
    expect(problems).toHaveLength(FAKE_SYSTEM_KINDS.length);
    expect(() => assertScorerRejectsFakeSystems({ category: 'vacuous', probes, space, score: () => ({ pass: true, detail: 'always' }) })).toThrow(/always-positive fake passes/);
  });

  test('a scorer that fails the honest system is caught too', () => {
    expect(mutationProblems('broken', runMutationSuite({ category: 'broken', probes, space, score: () => ({ pass: false, detail: 'never' }) })))
      .toContain('broken: the honest system fails (never), so the scorer cannot pass anything');
  });

  test('a fake that changes no answer proves nothing and must be declared not applicable', () => {
    const noHistory = { ...space, stale: () => undefined };
    expect(mutationProblems('t', runMutationSuite({ category: 't', probes, space: noHistory, score: exact }))).toEqual([
      't: the stale fake changed no answer; give the world a probe it can get wrong or declare it not applicable',
    ]);
    expect(() => assertScorerRejectsFakeSystems({ category: 't', probes, space: noHistory, score: exact, notApplicable: { stale: 'no time axis' } })).not.toThrow();
  });
});

// ─── N3: temporal and as-of ──────────────────────────────────────────────

describe('N3 scorer rejects the fake systems', () => {
  const world = generateN3World({ seed: N3_DEFAULT_SEED });
  const gold = (p: N3Probe) => world.gold.get(p.id)!;
  type Answer = string | null | number | string[];
  const fields = (p: N3Probe) => p as unknown as Record<string, string | undefined>;
  // A series is one entity's answers to one feature over time; stale answers come from its earlier point.
  const seriesKey = (p: N3Probe) => `${p.feature}|${fields(p).person ?? fields(p).entity ?? fields(p).slug ?? ''}`;
  const timeKey = (p: N3Probe) => fields(p).asof ?? fields(p).date ?? fields(p).until ?? '';
  const truthOf = (g: N3Gold): Answer => {
    switch (g.kind) {
      case 'company': return g.company;
      case 'set': return [...g.ids];
      case 'value': return g.value;
      case 'last_seen': return g.last_date;
      case 'page_days': return [g.include_day];
    }
  };
  const same = (a: Answer, b: Answer) => JSON.stringify(a) === JSON.stringify(b);
  const allIds = new Map<string, string[]>();
  for (const p of world.probes) {
    const g = gold(p);
    if (g.kind === 'set') allIds.set(p.feature, [...new Set([...(allIds.get(p.feature) ?? []), ...g.ids])].sort());
  }
  const companies = world.ledger.companies.map(c => c.id);
  const space = {
    truth: (p: N3Probe) => truthOf(gold(p)),
    empty: (p: N3Probe): Answer => (['set', 'page_days'].includes(gold(p).kind) ? [] : null),
    refusal: (p: N3Probe): Answer => (['set', 'page_days'].includes(gold(p).kind) ? [] : null),
    everything: (p: N3Probe): Answer => {
      const g = gold(p);
      switch (g.kind) {
        case 'company': return g.company ?? companies[0];
        case 'set': return allIds.get(p.feature) ?? [];
        case 'value': return g.value ?? 0;
        case 'last_seen': return g.last_date ?? '2020-01-01';
        case 'page_days': return [g.include_day, ...g.exclude_days];
      }
    },
    stale: (p: N3Probe): Answer | undefined => {
      const earlier = world.probes.filter(q => seriesKey(q) === seriesKey(p) && timeKey(q) < timeKey(p)).sort((a, b) => timeKey(b).localeCompare(timeKey(a)))[0];
      return earlier && !same(truthOf(gold(earlier)), truthOf(gold(p))) ? truthOf(gold(earlier)) : undefined;
    },
    wrongSource: (p: N3Probe): Answer | undefined => {
      const other = world.probes.find(q => q.feature === p.feature && seriesKey(q) !== seriesKey(p) && !same(truthOf(gold(q)), truthOf(gold(p))));
      return other ? truthOf(gold(other)) : undefined;
    },
  };
  const passes = (g: N3Gold, a: Answer): { pass: boolean; f1?: number } => {
    switch (g.kind) {
      case 'company': return { pass: a === g.company };
      case 'set': { const f1 = setF1(g.ids, a as string[]).f1; return { pass: f1 === 1, f1 }; }
      case 'value': return { pass: a === g.value };
      case 'last_seen': return { pass: a === g.last_date };
      case 'page_days': { const days = a as string[]; return { pass: days.includes(g.include_day) && !g.exclude_days.some(d => days.includes(d)) }; }
    }
  };
  const score = (answers: readonly Answer[]) => {
    const rows: ProbeRow[] = world.probes.map((p, i) => ({
      probe_id: p.id, feature: p.feature, negative: world.negative.has(p.id), status: 'scored', gold: gold(p), predicted: answers[i], ...passes(gold(p), answers[i]),
    }));
    const s = summarize(rows, { lastSeenErrors: [], pagedate: [] });
    return { pass: n3Verdict(s) === 'pass', detail: `as-of ${s.asof_accuracy.toFixed(3)}, range F1 ${s.range_set_f1.toFixed(3)}, negatives ${s.negative_control_pass_rate.toFixed(3)}` };
  };

  test('honest passes n3Verdict; every fake fails it', () => {
    const results = assertScorerRejectsFakeSystems({ category: 'N3', probes: world.probes, space, score, same });
    for (const r of results.filter(x => x.system !== 'honest')) expect([r.system, r.changed > 0]).toEqual([r.system, true]);
  });
});

// ─── N4: entity resolution, graded by its preregistered promotion rules ──

describe('N4 promotion gate rejects the fake systems', () => {
  const ledger = generateLedger();
  const goldMap = deriveGold(ledger);
  const gold = new GoldStore<N4Gold>('n4-mutation', goldMap);
  const entityOfPage = entityByPage(ledger);
  const ctx: ScoringContext = { entityOfPage, clusterOfPage: k => `c:${entityOfPage.get(k)}` };
  const pages = writtenPages(ledger);
  const single = ledger.mentions.filter(m => m.caller.sources.length === 1 && !m.caller.remote);
  const rules = registryEntry('N4')!.promotion!;
  const otherEntityPage = (m: LedgerMention, notEntity: string | null) => {
    const g = goldMap.get(m.id)!;
    const sameSlugElsewhere = g.kind === 'entity' ? pages.find(p => p.key !== g.pages[0] && p.key.split(':')[1] === g.pages[0].split(':')[1] && entityOfPage.get(p.key) !== notEntity) : undefined;
    return (sameSlugElsewhere ?? pages.find(p => entityOfPage.get(p.key) !== notEntity))!.key;
  };
  const space = {
    truth: (m: LedgerMention): Prediction => { const g = goldMap.get(m.id)!; return g.kind === 'entity' ? { kind: 'pages', pages: [g.pages[0]] } : { kind: 'unresolved' }; },
    empty: (): Prediction => ({ kind: 'unresolved' }),
    refusal: (): Prediction => ({ kind: 'unresolved' }),
    everything: (m: LedgerMention): Prediction => baselinePrediction('merge-everything', m, pages),
    wrongSource: (m: LedgerMention): Prediction => {
      const g = goldMap.get(m.id)!;
      return { kind: 'pages', pages: [otherEntityPage(m, g.kind === 'entity' ? g.entity : null)] };
    },
  };
  const score = (answers: readonly Prediction[]) => {
    const m = scoreSurface(single.map((x, i) => ({ id: x.id, family: x.family, documented: x.documented, floor: x.family.startsWith('exact'), pred: answers[i] })), gold, ctx);
    const surfaces = { resolver: m, recall: m, remember: m, resolve_on_save: m };
    const identity = { n: 1, expected_members: 1, found_members: 1, recall: 1, leaks: 0, foreign_rows: 0, foreign_by_scope: {} };
    const search_floor = { n: m.floor.n, correct: m.floor.correct, rate: m.floor.rate, errors: 0 };
    const outcome = evaluatePromotion(rules, { verdict: verdictOf({ surfaces, search_floor, identity }).verdict, data: { surfaces, search_floor, identity } });
    return { pass: outcome.pass, detail: outcome.failures.map(f => f.id).join(', ') || 'all rules hold' };
  };

  test('honest passes the gate; empty, positive, refuse and wrong-source fail it; stale does not apply', () => {
    const results = assertScorerRejectsFakeSystems({
      category: 'N4', probes: single, space, score,
      notApplicable: { stale: 'N4 has no time axis: a former name is a variant of the current entity, scored like any other variant' },
    });
    const failed = Object.fromEntries(results.map(r => [r.system, r.detail]));
    expect(failed.empty).toContain('exact-lookup-floor');
    expect(failed['always-positive']).toContain('no-wrong-merge-resolver');
    expect(failed['wrong-source']).toContain('no-wrong-merge-resolver');
  });
});

// ─── N6: visibility leaks, graded by its preregistered promotion rules ───

describe('N6 promotion gate rejects the fake systems', () => {
  const ledger = generateN6World();
  const forbiddenMarkers = ledger.classes.flatMap(c => c.protected_markers);
  const forbiddenSlugs = ledger.classes.flatMap(c => c.protected_slugs);
  const rules = registryEntry('N6')!.promotion!;
  const ok = (data: unknown): CallOutcome => ({ exposed: true, ok: true, raw: JSON.stringify(data), data });
  const denied: CallOutcome = { exposed: true, ok: false, error_code: 'permission_denied', raw: '{"error":"permission_denied"}', data: { error: 'permission_denied' } };
  const twinHit = (c: N6ClassSpec) => ok({ results: [{ slug: c.twin.slug, text: c.twin_markers.join(' ') }] });
  const everything = ok({ pages: ledger.pages.map(p => ({ slug: p.slug, source_id: p.source_id, body: p.content })) });
  type Answer = { protectedResponse: CallOutcome; twinResponse: CallOutcome };
  const space = {
    truth: (c: N6ClassSpec): Answer => ({ protectedResponse: ok({ results: [] }), twinResponse: twinHit(c) }),
    empty: (): Answer => ({ protectedResponse: ok({ results: [] }), twinResponse: ok({ results: [] }) }),
    refusal: (): Answer => ({ protectedResponse: denied, twinResponse: denied }),
    everything: (): Answer => ({ protectedResponse: everything, twinResponse: everything }),
    // A stale cache still serves the protected text from before it became private.
    stale: (c: N6ClassSpec): Answer => ({ protectedResponse: ok({ results: [{ slug: c.twin.slug, text: c.protected_markers.join(' ') }] }), twinResponse: twinHit(c) }),
    // A row from the ungranted source answers the scoped caller.
    wrongSource: (c: N6ClassSpec): Answer => ({ protectedResponse: ok({ results: [{ slug: 'projects/foreign-example', source_id: 'beta' }] }), twinResponse: twinHit(c) }),
  };
  const score = (answers: readonly Answer[]) => {
    const scans = answers.map(a => scanLeaks(a.protectedResponse, forbiddenMarkers, forbiddenSlugs, []));
    const signal = answers.filter((a, i) => controlSeen(a.twinResponse, ledger.classes[i].twin_markers, [ledger.classes[i].twin.slug])).length;
    const metrics = {
      content_leak_probes: scans.filter(s => s.content).length, existence_leak_probes: scans.filter(s => s.existence).length,
      oracle_probes: 0, gate_bypasses: 0, sealed_chunk_violations: 0, content_reachable_coverage: signal / answers.length, named_window_probes_with_signal: signal,
    };
    const leakFree = metrics.content_leak_probes === 0 && metrics.existence_leak_probes === 0;
    const outcome = evaluatePromotion(rules, { verdict: leakFree ? 'pass' : 'fail', data: { metrics } });
    return { pass: outcome.pass, detail: outcome.failures.map(f => f.id).join(', ') || 'all rules hold' };
  };

  test('honest passes the gate; every fake fails it, refusals through the coverage floor', () => {
    const results = assertScorerRejectsFakeSystems({ category: 'N6', probes: ledger.classes, space, score });
    const failed = Object.fromEntries(results.map(r => [r.system, r.detail]));
    expect(failed.empty).toBe('content-reachable-coverage, named-window-signal');
    expect(failed['always-refuse']).toBe('content-reachable-coverage, named-window-signal');
    expect(failed['always-positive']).toContain('no-content-leak');
    expect(failed.stale).toContain('no-content-leak');
    expect(failed['wrong-source']).toContain('no-existence-leak');
  });
});
