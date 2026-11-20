/**
 * G1 freshness: the generator's seeds and disjoint gold readings, answer keying, pages_opened, the causes, the
 * scorecard and the scorer mutation kit. Pure and keyless.
 */
import { describe, expect, test } from 'bun:test';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import type { ArmCall } from '../../eval/runner/predictive/cli-arm.ts';
import { keyAnswer, normalizeValue, pagesOpened, scoreFreshnessEpisode, summarizeFreshness } from '../../eval/runner/predictive/freshness.ts';
import { freshnessDigest, generateFreshnessTasks, G1_PATTERNS, READINGS, type FreshnessTask } from '../../eval/generators/freshness-world-gen.ts';

const tasks = generateFreshnessTasks();
const get = (slug: string, extra: string[] = []): ArmCall => ({ surface: 'cli', argv: ['get', ...extra, slug], exit: 0, output: 'page', ms: 1 });
const searchCall: ArmCall = { surface: 'cli', argv: ['search', 'Brightwell'], exit: 0, output: 'people/priya-rao: now VP Engineering at Brightwell', ms: 1 };

describe('G1 generator', () => {
  test('120 seeded tasks over five patterns with a pinned digest', () => {
    expect(tasks.length).toBe(120);
    expect(new Set(tasks.map(t => t.pattern))).toEqual(new Set(G1_PATTERNS));
    expect(freshnessDigest(tasks)).toBe(freshnessDigest(generateFreshnessTasks()));
    expect(freshnessDigest(tasks)).toBe('51589efdd23764d616f73ffd0c96d918ab94ece9ad562d176e971c3064433018');
    expect(freshnessDigest(generateFreshnessTasks({ seed: 7 }))).not.toBe(freshnessDigest(tasks));
  });
  test('variant 0 carries Wintermute\'s fictional templates', () => {
    expect(tasks[0].question).toContain('Priya Rao');
    expect(tasks[0].gold).toEqual({ fresh: ['Brightwell'], stale: ['Halcyon'], time_shifted: ['Corvane'] });
    expect(tasks[1].gold.fresh).toContain('$12M');
    expect(tasks[1].gold.stale).toContain('$8M');
    expect(tasks[2].gold.stale).toEqual(['Vendor A']);
  });
  test('every task keys its own readings back, and no spelling keys two readings', () => {
    for (const t of tasks) for (const r of READINGS) for (const alias of t.gold[r]) expect({ id: t.id, alias, got: keyAnswer(alias, t.gold) }).toEqual({ id: t.id, alias, got: r });
  });
  test('the fresh page is in the brain and the pressured question adds the time-pressure line', () => {
    for (const t of tasks) {
      expect(t.pages.map(p => p.slug)).toContain(t.fresh_page);
      expect(t.pressured_question.length).toBeGreaterThan(t.question.length);
    }
  });
});

describe('keying', () => {
  const t = tasks[1];
  test('money, dates and names key exactly; a hedge naming two readings is invalid', () => {
    expect(normalizeValue('$12 million')).toBe('12m');
    expect(keyAnswer('$12M', t.gold)).toBe('fresh');
    expect(keyAnswer('12 million', t.gold)).toBe('fresh');
    expect(keyAnswer('$120M', t.gold)).toBeNull();
    expect(keyAnswer('$12M (the summary says $8M)', t.gold)).toBeNull();
    expect(keyAnswer('', t.gold)).toBeNull();
    expect(keyAnswer('UNKNOWN', t.gold)).toBeNull();
    const d = tasks.find(x => x.pattern === 'shared_vs_published')!;
    expect(keyAnswer(d.gold.fresh[0], d.gold)).toBe('fresh');
    expect(keyAnswer(d.gold.time_shifted[1], d.gold)).toBe('time_shifted');
  });
  test('pages_opened counts get calls only, never search snippets', () => {
    expect(pagesOpened([searchCall])).toEqual([]);
    expect(pagesOpened([searchCall, get('people/priya-rao', ['--lines', '1-5']), get('people/priya-rao'), { ...get('notes/x'), exit: 1 }])).toEqual(['people/priya-rao']);
    expect(pagesOpened([{ surface: 'mcp', argv: ['get_page'], args: { slug: 'meetings/m1' }, exit: 0, output: '{}', ms: 1 }, { surface: 'mcp', argv: ['search'], args: { query: 'x' }, exit: 0, output: '{}', ms: 1 }])).toEqual(['meetings/m1']);
  });
});

const score = (t: FreshnessTask, calls: ArmCall[], answer: string | null, extra: Partial<{ trial: number; usd: number; pressured: boolean }> = {}) =>
  scoreFreshnessEpisode({ task: t, model: 'm', trial: extra.trial ?? 0, pressured: extra.pressured ?? false, calls, answer, usd: extra.usd ?? 0, stop: 'submitted' });

describe('causes', () => {
  const t = tasks[0];
  const stalePage = t.pages[0].slug;
  test('fresh is correct; stale with the fresh page open is stale_fact, without it gold_unopened; a future plan is time_reasoning', () => {
    expect(score(t, [get(stalePage), get(t.fresh_page)], 'Brightwell').cause).toBe('correct');
    expect(score(t, [get(stalePage), get(t.fresh_page)], 'Halcyon').cause).toBe('stale_fact');
    expect(score(t, [searchCall, get(stalePage)], 'Halcyon').cause).toBe('gold_unopened');
    expect(score(t, [get(t.fresh_page)], 'Corvane').cause).toBe('time_reasoning');
  });
  test('no gbrain call is memory_not_consulted, and an unkeyable answer is an invalid row, never a judge call', () => {
    expect(score(t, [], 'Halcyon', { pressured: true }).cause).toBe('memory_not_consulted');
    const bad = score(t, [get(stalePage)], 'She is between jobs');
    expect(bad).toMatchObject({ cause: 'invalid', valid: false, success: false });
  });
  test('the scorecard counts causes, invalid rows, pass^4 and cost per correct', () => {
    const eps = [0, 1, 2, 3].flatMap(trial => [score(t, [get(t.fresh_page)], trial === 3 ? 'Halcyon' : 'Brightwell', { trial, usd: 0.2 }), score(tasks[5], [get(tasks[5].fresh_page)], tasks[5].gold.fresh[0], { trial, usd: 0.2 })]);
    const s = summarizeFreshness(eps);
    expect(s).toMatchObject({ episodes: 8, valid: 8, invalid: 0, correct: 7, tasks: 2 });
    expect(s.causes.stale_fact).toBe(1);
    expect(s.pass_hat_k.value).toBe(0.5);
    expect(s.cost_per_correct_usd).toBeCloseTo(1.6 / 7);
  });
});

describe('G1 scorer mutation kit', () => {
  test('passes the honest system and fails all five fakes', () => {
    const probes = tasks.slice(0, 25);
    assertScorerRejectsFakeSystems<FreshnessTask, { calls: ArmCall[]; answer: string | null }>({
      category: 'G1 freshness', probes,
      space: {
        truth: t => ({ calls: t.pages.map(p => get(p.slug)), answer: t.gold.fresh[0] }),
        empty: () => ({ calls: [], answer: null }),
        everything: t => ({ calls: t.pages.map(p => get(p.slug)), answer: [...t.gold.fresh, ...t.gold.stale, ...t.gold.time_shifted].join(' / ') }),
        refusal: t => ({ calls: t.pages.map(p => get(p.slug)), answer: 'UNKNOWN' }),
        stale: t => ({ calls: t.pages.map(p => get(p.slug)), answer: t.gold.stale[0] }),
        wrongSource: t => ({ calls: [get(t.pages.find(p => p.slug !== t.fresh_page)?.slug ?? t.fresh_page)], answer: t.gold.time_shifted[0] }),
      },
      score: answers => {
        const eps = answers.map((a, i) => score(probes[i], a.calls, a.answer));
        const bad = eps.filter(e => !e.success);
        return { pass: bad.length === 0, detail: bad.length ? `${bad.length} not correct (${bad[0].cause})` : 'all correct' };
      },
    });
  });
});
