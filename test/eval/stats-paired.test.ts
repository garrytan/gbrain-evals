import { describe, expect, test } from 'bun:test';
import {
  clusteredPairedDelta, exactMcNemar, holmAdjusted, minimumDiscordantForSignificance, nonInferiorityP, normalQuantile,
  fiellerRatio, pairObservations, PairingError, powerNote, seededRandom, simultaneousBand, type Observation, type PairedItem,
} from '../../eval/runner/stats/paired.ts';
import { clusteredRegressionStatistics, type RegressionMetricSpec } from '../../eval/runner/situation-recall-regression.ts';

const obs = (id: string, value: number | null, cluster = id, eligible = value !== null): Observation => ({ id, cluster, value, eligible, ...(eligible ? {} : { reason: 'n/a' }) });

describe('pairing contract', () => {
  test('pairs unique ids and reports items ineligible on both sides', () => {
    const { pairs, excluded } = pairObservations([obs('q1', 1), obs('q2', 0), obs('q3', null)], [obs('q2', 1), obs('q1', 1), obs('q3', null)]);
    expect(pairs).toEqual([{ id: 'q1', cluster: 'q1', a: 1, b: 1 }, { id: 'q2', cluster: 'q2', a: 0, b: 1 }]);
    expect(excluded).toEqual([{ id: 'q3', reason: 'n/a' }]);
  });

  test('duplicate ids, missing pairs, changed eligibility and changed clusters all block', () => {
    const problems = (a: Observation[], b: Observation[]) => {
      try { pairObservations(a, b); return []; } catch (error) { expect(error).toBeInstanceOf(PairingError); return (error as PairingError).problems; }
    };
    expect(problems([obs('q1', 1), obs('q1', 0)], [obs('q1', 1)])).toContain('A: duplicate id q1');
    expect(problems([obs('q1', 1), obs('q2', 1)], [obs('q1', 1)])).toContain('missing in B: q2');
    expect(problems([obs('q1', 1)], [obs('q1', 1), obs('q9', 0)])).toContain('missing in A: q9');
    expect(problems([obs('q1', 1)], [obs('q1', null)])[0]).toContain('eligibility differs for q1');
    expect(problems([obs('q1', 1, 'c1')], [obs('q1', 1, 'c2')])[0]).toContain('cluster differs for q1');
    expect(problems([obs('q1', null)], [obs('q1', null)])).toEqual(['no eligible pairs']);
    expect(problems([{ id: 'q1', cluster: '', value: 1, eligible: true }], [obs('q1', 1)])).toContain('A: q1 has no cluster id');
  });
});

describe('known paired datasets', () => {
  test('four clusters of ten identical wins: one cluster unit each, exact sign-flip p', () => {
    const pairs = Array.from({ length: 4 }, (_, c) => Array.from({ length: 10 }, (_, i) => ({ id: `c${c}-${i}`, cluster: `c${c}`, a: 0, b: 1 }))).flat();
    const s = clusteredPairedDelta(pairs, { seed: 1, draws: 10000 });
    expect(s.delta).toBe(1);
    expect(s.ci95).toEqual([1, 1]);
    expect(s.p_greater).toBe(1 / 16);
    expect(s.p_two_sided).toBe(2 / 16);
    expect(s.p_method).toBe('exact-sign-flip');
  });

  test('100 duplicated paraphrases in one cluster give no interval and no significance', () => {
    const pairs = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, cluster: 'one-concept', a: 0, b: 1 }));
    const s = clusteredPairedDelta(pairs, { seed: 1, draws: 10000 });
    expect(s.ci95).toBeNull();
    expect(s.p_two_sided).toBe(1);
    expect(powerNote(s).mde).toBeNull();
  });

  test('duplicating each item ten times inside its cluster does not shrink the interval', () => {
    const rng = seededRandom(7);
    const base = Array.from({ length: 60 }, (_, i) => ({ id: `q${i}`, cluster: `q${i}`, a: rng() < 0.7 ? 1 : 0, b: rng() < 0.75 ? 1 : 0 }));
    const duplicated = base.flatMap(p => Array.from({ length: 10 }, (_, j) => ({ ...p, id: `${p.id}-para${j}` })));
    const one = clusteredPairedDelta(base, { seed: 3, draws: 20000 });
    const ten = clusteredPairedDelta(duplicated, { seed: 3, draws: 20000 });
    expect(ten.delta).toBeCloseTo(one.delta, 12);
    expect(ten.se_cluster!).toBeCloseTo(one.se_cluster!, 12);
    expect(ten.effective_n!).toBeLessThan(0.2 * ten.n_pairs);
    const width = (s: typeof one) => s.ci95![1] - s.ci95![0];
    expect(Math.abs(width(ten) - width(one))).toBeLessThan(0.02);
  });

  test('matches the situation-recall regression gate it generalizes (mean metrics)', () => {
    const metric = { id: 'm', direction: 'higher', range: [0, 1], aggregation: 'mean' } as RegressionMetricSpec;
    for (const [clusters, seed] of [[5, 1], [12, 2], [16, 3], [40, 4]] as const) {
      const rng = seededRandom(seed * 101);
      const pairs: PairedItem[] = [];
      for (let c = 0; c < clusters; c++) for (let i = 0; i < 1 + (c % 3); i++) pairs.push({ id: `${c}-${i}`, cluster: `f${String(c).padStart(2, '0')}`, a: rng() < 0.5 ? 1 : 0, b: rng() < 0.6 ? 1 : 0 });
      const mine = clusteredPairedDelta(pairs, { seed, draws: 10000 });
      const legacy = clusteredRegressionStatistics(pairs.map(p => ({ family_id: p.cluster, baseline: p.a, candidate: p.b })), metric, seed, 10000);
      expect(mine.delta).toBeCloseTo(legacy.delta, 12);
      expect(mine.ci95![0]).toBeCloseTo(legacy.lower95, 12);
      expect(mine.ci95![1]).toBeCloseTo(legacy.upper95, 12);
      expect(mine.p_greater).toBeCloseTo(legacy.p_value, 12);
    }
  });

  test('exact McNemar on published and textbook counts', () => {
    const make = (wins: number, losses: number, same = 10): PairedItem[] => [
      ...Array.from({ length: wins }, (_, i) => ({ id: `w${i}`, cluster: `w${i}`, a: 0, b: 1 })),
      ...Array.from({ length: losses }, (_, i) => ({ id: `l${i}`, cluster: `l${i}`, a: 1, b: 0 })),
      ...Array.from({ length: same }, (_, i) => ({ id: `s${i}`, cluster: `s${i}`, a: 1, b: 1 })),
    ];
    expect(exactMcNemar(make(18, 8)).p_two_sided).toBeCloseTo(0.075519, 5);
    expect(exactMcNemar(make(0, 1)).p_two_sided).toBe(1);
    expect(exactMcNemar(make(0, 3)).p_two_sided).toBe(0.25);
    expect(exactMcNemar(make(6, 0)).p_two_sided).toBe(0.03125);
    expect(exactMcNemar(make(5, 0)).p_two_sided).toBe(0.0625);
    expect(exactMcNemar(make(70, 0)).p_two_sided).toBeCloseTo(2 * 0.5 ** 70, 30);
    expect(exactMcNemar(make(0, 0)).p_two_sided).toBe(1);
    expect(exactMcNemar(make(3, 2))).toMatchObject({ wins: 3, losses: 2, both_pass: 10, both_fail: 0, discordant: 5 });
    expect(() => exactMcNemar([{ id: 'x', cluster: 'x', a: 0.5, b: 1 }])).toThrow('binary');
    expect(minimumDiscordantForSignificance(0.05)).toBe(6);
    expect(minimumDiscordantForSignificance(0.01)).toBe(8);
  });

  test('Holm correction', () => {
    expect(holmAdjusted([0.01, 0.03, 0.2])).toEqual([0.03, 0.06, 0.2]);
    expect(holmAdjusted([0.04, 0.01])).toEqual([0.04, 0.02]);
    expect(() => holmAdjusted([NaN])).toThrow();
  });

  test('normal quantiles and detectable effect', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
    const pairs = Array.from({ length: 200 }, (_, i) => ({ id: `q${i}`, cluster: `q${i}`, a: i % 2, b: i % 3 === 0 ? 1 : i % 2 }));
    const s = clusteredPairedDelta(pairs, { seed: 1, draws: 5000 });
    const note = powerNote(s, { binary: true });
    expect(note.mde!).toBeCloseTo((1.959964 + 0.841621) * s.se_cluster!, 4);
    expect(note.min_one_sided_discordant).toBe(6);
    expect(note.note).toContain('80% power');
  });

  test('non-inferiority p follows the bootstrap interval and the metric direction', () => {
    const pairs = Array.from({ length: 400 }, (_, i) => ({ id: `q${i}`, cluster: `q${i}`, a: i % 10 === 0 ? 0 : 1, b: i % 10 === 1 ? 0 : 1 }));
    const s = clusteredPairedDelta(pairs, { seed: 5, draws: 10000 });
    expect(s.delta).toBe(0);
    expect(nonInferiorityP(s, 0.08, 'higher')!).toBeLessThan(0.01);
    expect(nonInferiorityP(s, 0.05, 'higher')!).toBeLessThan(0.05);
    expect(nonInferiorityP(s, 0, 'higher')!).toBeGreaterThan(0.3);
    const worse = pairs.map((p, i) => ({ ...p, b: i % 5 === 0 ? 0 : p.b }));
    const w = clusteredPairedDelta(worse, { seed: 5, draws: 10000 });
    expect(nonInferiorityP(w, 0.05, 'higher')!).toBeGreaterThan(0.5);
    expect(nonInferiorityP(w, 0.05, 'lower')!).toBeLessThan(0.01);
    expect(w.delta).toBeCloseTo(-0.2, 12);
    expect(() => nonInferiorityP(s, -1, 'higher')).toThrow();
  });

  test('deterministic under a seed, and Monte Carlo above 20 clusters', () => {
    const pairs = Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, cluster: `q${i}`, a: 0.5, b: i < 18 ? 1 : 0 }));
    const first = clusteredPairedDelta(pairs, { seed: 42, draws: 10000 });
    expect(first).toEqual(clusteredPairedDelta(pairs, { seed: 42, draws: 10000 }));
    expect(first.p_method).toBe('monte-carlo-sign-flip');
    expect(first.ci95![0]).toBeLessThan(first.delta);
    expect(first.ci95![1]).toBeGreaterThan(first.delta);
  });
});

describe('simultaneous band over shared clusters', () => {
  const rng = seededRandom(7);
  const questions = Array.from({ length: 50 }, (_, i) => 'q' + String(i).padStart(2, '0'));
  const member = (id: string, pA: number, pB: number, perQuestion = 1): { id: string; pairs: PairedItem[] } => ({
    id,
    pairs: questions.flatMap(q => Array.from({ length: perQuestion }, (_, k) => ({ id: q + ':' + k, cluster: q, a: rng() < pA ? 1 : 0, b: rng() < pB ? 1 : 0 }))),
  });
  const family = [member('m1', 0.4, 0.7), member('m2', 0.5, 0.5, 2), member('m3', 0.8, 0.4), member('m4', 0.3, 0.35, 2)];
  const opts = { seed: 20261106, draws: 2000 };

  test('each band is the delta plus or minus the shared critical value times its bootstrap error, and it is reproducible', () => {
    const band = simultaneousBand(family, opts);
    expect(band).toMatchObject({ method: 'max_t_cluster_bootstrap', level: 0.95, seed: 20261106, draws: 2000, n_clusters: 50 });
    for (const m of band.members) {
      expect(m.ci![0]).toBeCloseTo(m.delta - band.critical_value! * m.se_boot!, 10);
      expect(m.ci![1]).toBeCloseTo(m.delta + band.critical_value! * m.se_boot!, 10);
    }
    expect(band.members.map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(simultaneousBand(family, opts)).toEqual(band);
  });

  test('the critical value sits above one interval\'s and at or below Bonferroni\'s split over the same members', () => {
    const band = simultaneousBand(family, opts);
    expect(band.critical_value!).toBeGreaterThan(normalQuantile(0.975));
    expect(band.bonferroni_critical_value).toBeCloseTo(normalQuantile(1 - 0.05 / 8), 10);
    expect(band.critical_value!).toBeLessThan(band.bonferroni_critical_value + 0.15);
    const single = simultaneousBand([family[0]!], opts);
    expect(single.critical_value!).toBeGreaterThan(1.7);
    expect(single.critical_value!).toBeLessThan(2.3);
  });

  test('a duplicated member adds no width, and a member that never varies keeps a zero-width band outside the max', () => {
    const one = simultaneousBand([family[0]!], opts);
    const twice = simultaneousBand([family[0]!, { ...family[0]!, id: 'copy' }], opts);
    expect(twice.critical_value).toBe(one.critical_value);
    const flat = { id: 'flat', pairs: questions.map(q => ({ id: q, cluster: q, a: 1, b: 1 })) };
    const withFlat = simultaneousBand([family[0]!, flat], opts);
    expect(withFlat.critical_value).toBe(one.critical_value);
    expect(withFlat.members[1]).toMatchObject({ id: 'flat', delta: 0, se_boot: 0, ci: [0, 0] });
  });

  test('resampling within strata keeps a member that covers one stratum banded and finite; without strata it may get no band', () => {
    const strata = Object.fromEntries(questions.map((q, i) => [q, 't' + (i % 5)]));
    const windowLike = { id: 'window', pairs: questions.filter((_, i) => i % 5 === 2).map(q => ({ id: q, cluster: q, a: rng() < 0.5 ? 1 : 0, b: rng() < 0.6 ? 1 : 0 })) };
    const band = simultaneousBand([...family, windowLike], { ...opts, strata });
    expect(band.n_strata).toBe(5);
    const w = band.members.find(m => m.id === 'window')!;
    expect(w.ci).not.toBeNull();
    for (const m of band.members) for (const x of [m.delta, m.se_boot, ...(m.ci ?? [])]) expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(band.critical_value!)).toBe(true);
    const sparse = { id: 'sparse', pairs: [{ id: 'q00', cluster: 'q00', a: 0, b: 1 }, { id: 'q01', cluster: 'q01', a: 1, b: 1 }] };
    const unstratified = simultaneousBand([...family, sparse], opts);
    expect(unstratified.members.find(m => m.id === 'sparse')).toMatchObject({ se_boot: null, ci: null });
    expect(Number.isFinite(unstratified.critical_value!)).toBe(true);
  });

  test('Fieller\'s ratio interval from two intervals, unbounded when the denominator\'s interval nears zero', () => {
    const r = fiellerRatio({ estimate: -0.07, lo: -0.12, hi: -0.03 }, { estimate: -0.4, lo: -0.56, hi: -0.24 });
    expect(r.estimate).toBeCloseTo(0.175, 10);
    expect(r.lo!).toBeCloseTo(0.060, 3);
    expect(r.hi!).toBeCloseTo(0.357, 3);
    expect(fiellerRatio({ estimate: 0.1, lo: 0, hi: 0.2 }, { estimate: 0.05, lo: -0.1, hi: 0.2 })).toEqual({ estimate: 2, lo: null, hi: null });
  });

  test('fewer than two clusters leaves no band, and bad input refuses', () => {
    const lone = simultaneousBand([{ id: 'x', pairs: [{ id: 'a', cluster: 'c', a: 0, b: 1 }] }], opts);
    expect(lone.critical_value).toBeNull();
    expect(lone.members[0]!.ci).toBeNull();
    expect(() => simultaneousBand([], opts)).toThrow('at least one member');
    expect(() => simultaneousBand([family[0]!, family[0]!], opts)).toThrow('unique');
    expect(() => simultaneousBand(family, { seed: 1, draws: 999 })).toThrow('1000 draws');
    expect(() => simultaneousBand([{ id: 'x', pairs: [] }], opts)).toThrow('invalid paired observations');
  });
});
