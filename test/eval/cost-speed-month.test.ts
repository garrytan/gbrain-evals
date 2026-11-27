/**
 * Keyless tests for the cost-and-speed aggregation in eval/runner/cost-speed.ts (preregistration
 * docs/benchmarks/2026-11-24-cost-speed-preregistration.md: "What the result decides", "Workload profile", "Measures",
 * "Statistics"): both profiles' scaling, idle and hosting, the zero rule for cost per correct answer, the not-defined
 * ratio over a zero-cost server, the seeded bootstrap, probe percentiles past the horizon, the full-context range, history
 * growth, each decision rule firing and not firing, and README's table. Every number is invented; nothing calls a
 * provider.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { MatchClass } from '../../eval/runner/bg1/match.ts';
import { CS1_DRAWS, CS1_PROFILES, CS1_SEED, cs1Accuracy, cs1Aggregate, cs1Draws, cs1FullContext, cs1Growth, cs1Hosting, cs1IdleUsdPerMonth, cs1MonthlyLines, renderCs1Table,
  type Cs1Input, type Cs1Rule, type Cs1System, type Cs1World } from '../../eval/runner/cost-speed.ts';
import { probeSummary, type ProbeRecord } from '../../eval/runner/memory-qa/cost-speed-probes.ts';
import { seededRandom } from '../../eval/runner/stats/paired.ts';

const GIB = 2 ** 30;
const OPUS = 'claude-opus-5-5', PARTICLE = 'particle-1';
const WORLDS = Array.from({ length: 10 }, (_, i) => `bg1-dev-${String(i + 1).padStart(2, '0')}`);
const jitter = (i: number) => 1 + 0.04 * ((i % 3) - 1);
const classes = (correct: number, n = 20, unclear = 0): MatchClass[] => [...Array(correct).fill('correct'), ...Array(unclear).fill('unclear'), ...Array(n - correct - unclear).fill('stale')];
const LADDER = { provider: 'example-cloud', instances: [{ name: 'gp.large', memory_gib: 8, usd_per_hour: 0.08 }, { name: 'gp.small', memory_gib: 2, usd_per_hour: 0.02 }, { name: 'gp.medium', memory_gib: 4, usd_per_hour: 0.04 }], storage_usd_per_gb_month: 0.08 };
const HOSTED = { resident_bytes: GIB, disk_bytes: GIB / 10, disk_tokens: 180_000 };

const probe = (k: number, ms: number | null): ProbeRecord => ({ source_id: `s${k}`, status: ms === null ? 'missed' : 'found', write_to_queryable_ms: ms, polls: 1, errored_polls: 0, unattributed_returns: 0, started_idle: true });
const fastProbes = (i: number) => Array.from({ length: 21 }, (_, k) => probe(k, 500 + 100 * k + 10 * i));

interface Shape { write?: number; background?: number; read?: number; opus?: number; particle?: number; correctAt?: (i: number) => number; idle?: number; probes?: (i: number) => ProbeRecord[]; quarters?: [number, number]; byModel?: Record<string, number>; hosting?: Cs1System['hosting'] }
const system = (name: string, s: Shape = {}): Cs1System => ({
  system: name, hosting: s.hosting === undefined ? HOSTED : s.hosting,
  worlds: WORLDS.map((world, i): Cs1World => ({
    world, ingested_tokens: 180_000, sessions: 150, questions: 20,
    usd: { write: (s.write ?? 0) * jitter(i), background: (s.background ?? 0) * jitter(i), read: (s.read ?? 0) * jitter(i), probe: 0.5 },
    by_model: s.byModel ? { write: s.byModel } : undefined,
    idle: i < 2 && s.idle !== undefined ? { usd: s.idle, window_ms: 3_600_000 } : null,
    quarters: s.quarters ? { first_usd_per_mtok: s.quarters[0], last_usd_per_mtok: s.quarters[1] } : null,
    readers: {
      [OPUS]: { questions: 20, usd: (s.opus ?? 1) * jitter(i + 1), classes: classes(s.correctAt ? s.correctAt(i) : 10) },
      [PARTICLE]: { questions: 20, usd: (s.particle ?? 0.05) * jitter(i + 2), classes: classes(8) },
    },
    probes: s.probes ? s.probes(i) : null,
  })),
});

const input = (over: Partial<Record<string, Shape>> = {}, extra: Partial<Cs1Input> = {}): Cs1Input => ({
  systems: [
    system('gbrain-defaults', { write: 0.02, background: 0.15, read: 0.01, idle: 0.001, probes: fastProbes, ...over['gbrain-defaults'] }),
    system('ext-extract-first', { write: 17, read: 0.02, ...over['ext-extract-first'] }),
    system('ext-memory-bank', { write: 0.33, background: 0.33, idle: 0.002, ...over['ext-memory-bank'] }),
    system('ext-verbatim-session', { ...over['ext-verbatim-session'] }),
    system('baseline-hybrid', { write: 0.025, read: 0.002, ...over['baseline-hybrid'] }),
    system('baseline-file-agent', { ...over['baseline-file-agent'] }),
  ],
  ladder: LADDER, draws: 400, ...extra,
});
const rule = (rules: Cs1Rule[], n: number) => rules.find(r => r.rule === n)!;

describe('monthly lines', () => {
  const w = system('x', { write: 1.8, background: 0.18, read: 0.2, opus: 2 }).worlds[1];
  test('heavy and light scale the same unit costs to their own tokens and questions', () => {
    const heavy = cs1MonthlyLines(w, 'heavy', { idle_usd: 3, hosting_usd: 10 }), light = cs1MonthlyLines(w, 'light', { idle_usd: 3, hosting_usd: 10 });
    expect(CS1_PROFILES.heavy).toMatchObject({ messages: 2_000, tokens: 80_700, questions: 300, history_tokens: 968_000 });
    expect(CS1_PROFILES.light).toMatchObject({ messages: 215, tokens: 8_700, questions: 32, history_tokens: 104_000 });
    expect(w.usd.write).toBe(1.8);
    expect(heavy.write).toBeCloseTo(1.8 / 180_000 * 80_700, 10);
    expect(light.write).toBeCloseTo(1.8 / 180_000 * 8_700, 10);
    expect(heavy.write / light.write).toBeCloseTo(80_700 / 8_700, 10);
    expect(heavy.background).toBeCloseTo(0.18 / 180_000 * 80_700, 10);
    expect(heavy.read).toBeCloseTo(0.2 / 20 * 300, 10);
    expect(light.read).toBeCloseTo(0.2 / 20 * 32, 10);
    expect(heavy.readers[OPUS].reader).toBeCloseTo(w.readers[OPUS].usd / 20 * 300, 10);
    expect(light.readers[OPUS].reader).toBeCloseTo(w.readers[OPUS].usd / 20 * 32, 10);
    expect(heavy.write_background).toBeCloseTo(heavy.write + heavy.background, 10);
    for (const l of [heavy, light]) {
      expect(l.idle).toBe(3);
      expect(l.hosting).toBe(10);
      expect(l.system).toBeCloseTo(l.write + l.background + l.read + l.idle + l.hosting, 10);
      expect(l.system_without_hosting).toBeCloseTo(l.system - 10, 10);
      expect(l.readers[OPUS].total).toBeCloseTo(l.system + l.readers[OPUS].reader, 10);
      expect(l.readers[OPUS].total_without_hosting).toBeCloseTo(l.system_without_hosting + l.readers[OPUS].reader, 10);
    }
  });

  test('idle is the system-level rate from its idle worlds, times 730, applied to every world', () => {
    const worlds = system('x').worlds.map((w, i) => ({ ...w, idle: i === 0 ? { usd: 0.5, window_ms: 1_800_000 } : i === 1 ? { usd: 1.5, window_ms: 5_400_000 } : null }));
    expect(cs1IdleUsdPerMonth(worlds)).toBeCloseTo(730, 10);
    expect(cs1IdleUsdPerMonth(worlds.map(w => ({ ...w, idle: null })))).toBeNull();
    const res = cs1Aggregate({ ...input(), systems: [{ system: 'x', hosting: null, worlds }] });
    expect(res.systems[0].profiles.heavy.per_world.every(p => Math.abs(p.lines.idle - 730) < 1e-9)).toBe(true);
    expect(res.systems[0].idle).toMatchObject({ measured_worlds: 2, note: null });
  });

  test('a daily job run through its trigger is priced per run times its runs a month, not at the window\'s hourly rate', () => {
    const upkeep = (usd: number) => [{ job: 'upkeep round', usd, cadence_minutes: 1440 }];
    const worlds = system('x').worlds.map((w, i) => ({ ...w, idle: i === 0 ? { usd: 0.5, window_ms: 1_800_000, triggers: upkeep(1) } : i === 1 ? { usd: 1.5, window_ms: 5_400_000, triggers: upkeep(3) } : null }));
    expect(cs1IdleUsdPerMonth(worlds)).toBeCloseTo(730 + 2 * 730 / 24, 10);
    const daily = worlds.map((w, i) => ({ ...w, idle: i < 2 ? { usd: 0, window_ms: 7_200_000, triggers: upkeep(0.24) } : null }));
    expect(cs1IdleUsdPerMonth(daily)).toBeCloseTo(0.24 * 730 / 24, 10);
  });

  test('hosting is the smallest instance holding 1.5 times the peak, plus storage projected to the profile history', () => {
    const small = cs1Hosting(HOSTED, LADDER, 'heavy');
    expect(small.instance).toBe('gp.small');
    expect(small.compute_usd).toBeCloseTo(0.02 * 730, 10);
    expect(small.storage_gb).toBeCloseTo(0.1 * 968_000 / 180_000, 10);
    expect(small.usd).toBeCloseTo(0.02 * 730 + 0.1 * 968_000 / 180_000 * 0.08, 10);
    expect(cs1Hosting(HOSTED, LADDER, 'light').storage_gb).toBeCloseTo(0.1 * 104_000 / 180_000, 10);
    expect(cs1Hosting({ ...HOSTED, resident_bytes: 2 * GIB }, LADDER, 'heavy').instance).toBe('gp.medium');
    expect(() => cs1Hosting({ ...HOSTED, resident_bytes: 6 * GIB }, LADDER, 'heavy')).toThrow(/no example-cloud instance holds/);
    expect(cs1Hosting(null, LADDER, 'heavy').usd).toBe(0);
  });

  test('probe dollars are never counted in cost', () => {
    const res = cs1Aggregate(input());
    const v = res.systems.find(s => s.system === 'ext-verbatim-session')!;
    expect(v.probe_usd).toBeCloseTo(5, 10);
    expect(v.profiles.heavy.system_without_hosting.usd).toBe(0);
  });

  test('refuses systems whose worlds differ, so every resample pairs them', () => {
    const inp = input();
    const short = { ...inp.systems[1], worlds: inp.systems[1].worlds.slice(1) };
    expect(() => cs1Aggregate({ ...inp, systems: [inp.systems[0], short] })).toThrow(/worlds differ/);
  });
});

describe('cost per correct answer', () => {
  test('accuracy counts unclear as not correct and on its own', () => {
    expect(cs1Accuracy([{ questions: 20, classes: classes(5, 20, 3) }])).toEqual({ questions: 20, correct: 5, unclear: 3, not_correct: 15, key_matched: 0.25 });
  });

  test('the monthly total over the profile questions times key-matched accuracy, with an interval', () => {
    const res = cs1Aggregate(input());
    const g = res.systems.find(s => s.system === 'gbrain-defaults')!;
    for (const p of ['heavy', 'light'] as const) {
      const c = g.profiles[p].readers[OPUS];
      expect(c.cost_per_correct.usd).toBeCloseTo(c.total.usd / (CS1_PROFILES[p].questions * 0.5), 10);
      expect(c.cost_per_correct.ci95).not.toBeNull();
      expect(c.cost_per_correct.note).toBeNull();
    }
  });

  test('zero rule: no correct answer gives "no correct answers"; correct answers in one world only give the point estimate and no interval', () => {
    const res = cs1Aggregate(input({ 'baseline-hybrid': { correctAt: () => 0 }, 'baseline-file-agent': { correctAt: i => (i === 0 ? 4 : 0) } }));
    const none = res.systems.find(s => s.system === 'baseline-hybrid')!.profiles.heavy.readers[OPUS].cost_per_correct;
    expect(none).toEqual({ usd: null, ci95: null, note: 'no correct answers' });
    const one = res.systems.find(s => s.system === 'baseline-file-agent')!.profiles.heavy.readers[OPUS].cost_per_correct;
    expect(one.usd).not.toBeNull();
    expect(one.ci95).toBeNull();
    expect(one.note).toBe('interval not defined');
    const table = renderCs1Table(res, Object.fromEntries(res.systems.map(s => [s.system, { build: 'b', date: '2026-12-01' }])));
    expect(table).toContain('no correct answers');
    expect(table).toContain('(interval not defined)');
  });
});

describe('bootstrap', () => {
  test('draws come from the string seed through the shared generator, 10,000 by default', () => {
    const rand = seededRandom(createHash('sha256').update(CS1_SEED).digest().readUInt32LE(0));
    const expected = Array.from({ length: 3 }, () => Array.from({ length: 10 }, () => Math.floor(rand() * 10)));
    expect(cs1Draws(10, CS1_SEED, 3)).toEqual(expected);
    expect(cs1Draws(10).length).toBe(CS1_DRAWS);
    expect(CS1_DRAWS).toBe(10_000);
    expect(cs1Draws(10, 'another-seed', 3)).not.toEqual(expected);
  });

  test('the same seed gives byte-identical results; another seed moves the intervals, not the estimates', () => {
    const a = cs1Aggregate(input()), b = cs1Aggregate(input()), c = cs1Aggregate(input({}, { seed: 'another-seed' }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const g = (r: typeof a) => r.systems.find(s => s.system === 'gbrain-defaults')!.profiles.heavy.readers[OPUS].total;
    expect(g(c).usd).toBe(g(a).usd);
    expect(g(c).ci95).not.toEqual(g(a).ci95);
    expect(a.method).toContain('seed cost-speed-1');
  });

  test('intervals bracket the world-mean estimate', () => {
    const res = cs1Aggregate(input());
    for (const s of res.systems) {
      const t = s.profiles.heavy.readers[OPUS].total;
      expect(t.ci95![0]).toBeLessThanOrEqual(t.usd + 1e-9);
      expect(t.ci95![1]).toBeGreaterThanOrEqual(t.usd - 1e-9);
    }
  });
});

describe('write to queryable', () => {
  test('percentiles and their intervals come from resampled probe windows', () => {
    const p = cs1Aggregate(input()).systems.find(s => s.system === 'gbrain-defaults')!.probes!;
    expect(p.counted).toBe(210);
    expect(p.p50_ms).not.toBeNull();
    expect(p.p50_ci95![0]).toBeLessThanOrEqual(p.p50_ms!);
    expect(p.p50_ci95![1]).toBeGreaterThanOrEqual(p.p50_ms!);
  });

  test('a percentile that lands on a miss reads "more than 10 minutes"', () => {
    const missing = (i: number) => Array.from({ length: 21 }, (_, k) => probe(k, k < 4 ? 2_000 + i : null));
    const res = cs1Aggregate(input({ 'gbrain-defaults': { probes: missing } }));
    const p = res.systems.find(s => s.system === 'gbrain-defaults')!.probes!;
    expect(p.p50_ms).toBeNull();
    expect(p.p95_ms).toBeNull();
    expect(p.p50_ci95).toEqual([null, null]);
    const table = renderCs1Table(res, Object.fromEntries(res.systems.map(s => [s.system, { build: 'b', date: '2026-12-01' }])));
    const row = table.split('\n').find(l => l.startsWith('| gbrain-defaults'))!;
    expect(row).toContain('more than 10 minutes (more than 10 minutes to more than 10 minutes)');
    expect(rule(res.rules, 3).status).toBe('fired');
  });
});

describe('history growth', () => {
  test('bulk probes are pooled descriptively; late and never-found misses are counted among counted misses', () => {
    const rec = (k: number, status: 'found' | 'missed', ms: number | null, extra: object = {}): ProbeRecord => ({ source_id: `s${k}`, status, write_to_queryable_ms: ms, polls: 1, errored_polls: 0, unattributed_returns: 0, started_idle: false, ...extra });
    const worlds = system('x').worlds.map((w, i) => ({ ...w, bulk_probes: i === 0 ? [rec(1, 'found', 100), rec(2, 'found', 300), rec(3, 'missed', null)] : [] }));
    expect(cs1Aggregate({ ...input(), systems: [{ system: 'x', hosting: null, worlds }] }).systems[0].bulk_probes).toEqual({ probes: 3, found: 2, p50_ms: 300 });
    const held = [rec(1, 'missed', null, { started_idle: true, miss: 'late' }), rec(2, 'missed', null, { started_idle: true, miss: 'never' }), ...Array.from({ length: 8 }, (_, k) => rec(3 + k, 'found', 50, { started_idle: true }))];
    expect(probeSummary([held], 600_000)).toMatchObject({ counted: 10, missed: 2, late: 1, never: 1 });
  });

  test('last quarter over first, flagged above 1.25; not defined when the first quarter cost nothing', () => {
    const w = (q: [number, number]) => system('x', { quarters: q }).worlds;
    expect(cs1Growth(w([1, 1.5]))).toMatchObject({ ratio: 1.5, flagged: true });
    expect(cs1Growth(w([1, 1.1]))).toMatchObject({ flagged: false });
    expect(cs1Growth(w([0, 0]))).toMatchObject({ ratio: null, flagged: false, note: 'not defined: no write-and-background spend in the first quarter' });
    expect(cs1Growth(system('x').worlds)).toMatchObject({ ratio: null, note: 'not measured' });
  });
});

describe('baseline-full-context', () => {
  const fc = (fits: boolean) => ({
    worlds: WORLDS.slice(0, 2).map(world => ({ world, questions: 20, cached_tokens: 19 * 180_000, cached_usd: 19 * 180_000 * 1e-7, cache_write_tokens: 180_000, cache_write_usd: 180_000 * 1.25e-6, uncached_usd: 0.1, output_usd: 0.1, classes: classes(10) })),
    fit: { heavy: { fits }, light: { fits: true, prompt_tokens: 110_000 } },
  });
  test('warm and cold monthly bounds from measured rates, scaled to the one-year prompt', () => {
    const days = 730 / 24;
    const heavy = cs1FullContext(fc(true), 'heavy');
    expect(heavy.cold_usd).toBeCloseTo(300 * 968_000 * 1.25e-6 + 300 * 0.01, 6);
    expect(heavy.warm_usd).toBeCloseTo(days * 968_000 * 1.25e-6 + (300 - days) * 968_000 * 1e-7 + 300 * 0.01, 6);
    expect(heavy.cost_per_correct!.cold_usd).toBeCloseTo(heavy.cold_usd! / 150, 6);
    const light = cs1FullContext(fc(true), 'light');
    expect(light.history_tokens).toBe(110_000);
    expect(light.cold_usd).toBeCloseTo(32 * 110_000 * 1.25e-6 + 32 * 0.01, 6);
  });
  test('a prompt that does not fit is reported, not priced', () => {
    expect(cs1FullContext(fc(false), 'heavy')).toMatchObject({ fits: false, warm_usd: null, cold_usd: null, note: "doesn't fit" });
  });
  test('a reader that reports no cache writes is priced at its uncached input rate, warm and cold alike', () => {
    const plain = { worlds: WORLDS.slice(0, 2).map(world => ({ world, questions: 20, cached_tokens: 0, cached_usd: 0, cache_write_tokens: 0, cache_write_usd: 0, uncached_tokens: 20 * 180_000, uncached_usd: 20 * 180_000 * 2.5e-7, output_usd: 0.1, classes: classes(10) })),
      fit: { heavy: { fits: true }, light: { fits: true, prompt_tokens: 110_000 } } };
    const heavy = cs1FullContext(plain, 'heavy');
    expect(heavy.cold_usd).toBeCloseTo(300 * (968_000 * 2.5e-7 + 0.005), 6);
    expect(heavy.warm_usd).toBe(heavy.cold_usd);
    expect(heavy.note).toBe('no cache writes reported: priced at the uncached input rate');
    expect(cs1FullContext({ ...plain, worlds: plain.worlds.map(w => ({ ...w, uncached_tokens: 0 })) }, 'heavy').note).toBe('not priced: no cache-write reads measured');
  });
  test('a reader that reads from cache but reports no cache writes fills once a day at the uncached rate and reads the rest cached', () => {
    const cached = { worlds: WORLDS.slice(0, 2).map(world => ({ world, questions: 20, cached_tokens: 19 * 180_000, cached_usd: 19 * 180_000 * 1e-7, cache_write_tokens: 0, cache_write_usd: 0, uncached_tokens: 180_000, uncached_usd: 180_000 * 2.5e-7, output_usd: 0.1, classes: classes(10) })),
      fit: { heavy: { fits: true }, light: { fits: true, prompt_tokens: 110_000 } } };
    const days = 730 / 24;
    const heavy = cs1FullContext(cached, 'heavy');
    expect(heavy.cold_usd).toBeCloseTo(300 * (968_000 * 2.5e-7 + 0.005), 6);
    expect(heavy.warm_usd).toBeCloseTo(days * 968_000 * 2.5e-7 + (300 - days) * 968_000 * 1e-7 + 300 * 0.005, 6);
    expect(heavy.warm_usd!).toBeLessThan(heavy.cold_usd!);
    expect(heavy.cost_per_correct!.warm_usd).toBeCloseTo(heavy.warm_usd! / 150, 6);
    expect(heavy.note).toBe('no cache writes reported: cache fills priced at the uncached input rate');
  });
});

describe('decision rules', () => {
  test('rule 1 fires when gbrain costs well over the cheapest server, and names its largest line and model', () => {
    const r = rule(cs1Aggregate(input({ 'gbrain-defaults': { write: 100, byModel: { 'voyage-4': 100 } } })).rules, 1);
    expect(r.status).toBe('fired');
    expect(r.numbers.largest_line).toMatchObject({ phase: 'write', model: 'voyage-4' });
    expect((r.numbers.with_hosting as { at_point: string }).at_point).toBe('ext-verbatim-session');
  });
  test('rule 1 does not fire when gbrain is near the cheapest server', () => {
    expect(rule(cs1Aggregate(input()).rules, 1).status).toBe('not fired');
  });
  test('without hosting, a zero-cost verbatim-session leaves the ratio not defined and reports the gap in dollars a month', () => {
    const w = rule(cs1Aggregate(input()).rules, 1).numbers.without_hosting as { ratio: number | null; ci95: unknown; gap_usd: number; gap_ci95: [number, number] | null; note: string };
    expect(w.ratio).toBeNull();
    expect(w.ci95).toBeNull();
    expect(w.note).toBe('ratio not defined: the denominator is zero');
    expect(w.gap_usd).toBeGreaterThan(0);
    expect(w.gap_ci95).not.toBeNull();
  });

  test('rule 2 fires when gbrain reader cost per question is well over the median of the four other passive systems', () => {
    const r = rule(cs1Aggregate(input({ 'gbrain-defaults': { opus: 3 } })).rules, 2);
    expect(r.status).toBe('fired');
    expect(r.numbers.shipped_read_is_largest).toBe(true);
    expect(r.numbers.median_usd_per_question as number).toBeCloseTo(0.05, 2);
  });
  test('rule 2 does not fire at 1.2 times the median, and names the largest line when the read is not', () => {
    const r = rule(cs1Aggregate(input({ 'gbrain-defaults': { opus: 1.2, write: 100 } })).rules, 2);
    expect(r.status).toBe('not fired');
    expect(r.numbers.shipped_read_is_largest).toBe(false);
    expect((r.numbers.largest_line as { line: string }).line).toBe('write');
  });

  test('rule 3 fires on a slow p50 and does not fire on fast probes', () => {
    const slow = (i: number) => Array.from({ length: 21 }, (_, k) => probe(k, 90_000 + 1_000 * k + i));
    expect(rule(cs1Aggregate(input({ 'gbrain-defaults': { probes: slow } })).rules, 3).status).toBe('fired');
    expect(rule(cs1Aggregate(input()).rules, 3).status).toBe('not fired');
  });
  test('rule 3 fires when more than 5% of counted probes miss, even with fast finds', () => {
    const someMiss = (i: number) => Array.from({ length: 21 }, (_, k) => probe(k, k < 2 ? null : 1_000 + i));
    const r = rule(cs1Aggregate(input({ 'gbrain-defaults': { probes: someMiss } })).rules, 3);
    expect(r.status).toBe('fired');
    expect(r.numbers).toMatchObject({ p50_over: false, miss_over: true });
  });

  test('rule 4 fires when every server is under a tenth of its total, and does not when hosting makes a server a large share', () => {
    const cheap = { hosting: null, opus: 100 };
    const fired = rule(cs1Aggregate(input({ 'ext-extract-first': cheap, 'ext-memory-bank': cheap, 'ext-verbatim-session': cheap })).rules, 4);
    expect(fired.status).toBe('fired');
    expect(rule(cs1Aggregate(input()).rules, 4).status).toBe('not fired');
  });

  test('rule 5 fires for a compared system whose total is well over gbrain total, and not otherwise', () => {
    const r = rule(cs1Aggregate(input({ 'ext-extract-first': { write: 300 } })).rules, 5);
    expect(r.status).toBe('fired');
    expect(r.numbers.firing).toEqual(['ext-extract-first']);
    expect(rule(cs1Aggregate(input()).rules, 5).status).toBe('not fired');
  });

  test('a rule whose systems are missing is not evaluated', () => {
    const inp = input();
    const res = cs1Aggregate({ ...inp, systems: inp.systems.filter(s => s.system !== 'gbrain-defaults') });
    expect([1, 2, 3, 5].map(n => rule(res.rules, n).status)).toEqual(['not evaluated', 'not evaluated', 'not evaluated', 'not evaluated']);
    expect(rule(res.rules, 4).status).not.toBe('not evaluated');
    expect(res.rules[0].reason).toContain('gbrain-defaults');
  });
});

describe('README table', () => {
  const res = cs1Aggregate({
    ...input(),
    full_context: {
      [OPUS]: { worlds: [{ world: WORLDS[0], questions: 20, cached_tokens: 3_420_000, cached_usd: 0.342, cache_write_tokens: 180_000, cache_write_usd: 0.225, uncached_usd: 0.1, output_usd: 0.1, classes: classes(12) }], fit: { heavy: { fits: true }, light: { fits: true } } },
      [PARTICLE]: { worlds: [{ world: WORLDS[0], questions: 20, cached_tokens: 0, cached_usd: 0, cache_write_tokens: 0, cache_write_usd: 0, uncached_usd: 0.01, output_usd: 0.01, classes: classes(2) }], fit: { heavy: { fits: false }, light: { fits: false } } },
    },
    not_run: [{ system: 'ext-temporal-graph', reason: 'its pinned reranker and ingest model were retired' }],
  });
  const rows = Object.fromEntries([...res.systems.map(s => s.system), 'baseline-full-context'].map(s => [s, { build: `build-${s}`, date: '2026-12-01' }]));

  test('has the preregistered columns, every row names its build and date, and not-run rows carry their reason', () => {
    const table = renderCs1Table(res, rows);
    const [header, , ...body] = table.trim().split('\n');
    expect(header).toBe('| System | System cost a month | Answer model a month, claude-opus-5-5 | Answer model a month, particle-1 | Total a month, claude-opus-5-5 | Cost per correct answer, claude-opus-5-5 | Cost per correct answer, particle-1 | Write to queryable, p50 | Write to queryable, p95 | Build | Measured |');
    expect(body.length).toBe(res.systems.length + 2);
    for (const l of body) expect(l.split(' | ').length).toBe(11);
    expect(body.find(l => l.startsWith('| gbrain-defaults'))).toContain('build-gbrain-defaults | 2026-12-01 |');
    expect(body.find(l => l.startsWith('| ext-temporal-graph'))).toContain('not run: its pinned reranker and ingest model were retired');
    const fcRow = body.find(l => l.startsWith('| baseline-full-context'))!;
    expect(fcRow).toContain('(warm to cold)');
    expect(fcRow).toContain("doesn't fit");
    expect(body.find(l => l.startsWith('| baseline-file-agent'))).toContain('not measured');
  });

  test('renders dollars from the inputs with their intervals', () => {
    const g = res.systems.find(s => s.system === 'gbrain-defaults')!.profiles.heavy;
    const row = renderCs1Table(res, rows).split('\n').find(l => l.startsWith('| gbrain-defaults'))!;
    expect(row).toContain(`$${g.system.usd.toFixed(2)} ($${g.system.ci95![0].toFixed(2)} to $${g.system.ci95![1].toFixed(2)})`);
  });

  test('refuses a run row with no build', () => {
    const { 'gbrain-defaults': _g, ...partial } = rows;
    expect(() => renderCs1Table(res, partial)).toThrow(/every row names its build and date; missing gbrain-defaults/);
  });
});
