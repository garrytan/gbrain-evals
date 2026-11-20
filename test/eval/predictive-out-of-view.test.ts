/**
 * G6, gold out of view by cause (eval/runner/predictive/out-of-view/): pinned
 * seed digests, reachability on a small world in an in-process PGLite brain
 * (keyless, inside withHermeticEnv), the keyed scorer and its mutation suite,
 * and the rule that the write-up counts hides without calling one a fault.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { PRIVACY_SUBCAUSES } from '../../eval/runner/predictive/causes.ts';
import { DEFAULT_KNOBS, expectedReachable, generateWorld, intendedCounts, validateKnobs, VARIANTS, type Knobs } from '../../eval/runner/predictive/out-of-view/gen.ts';
import { measureReach, reachSummaryLines } from '../../eval/runner/predictive/out-of-view/reach.ts';
import { main } from '../../eval/runner/predictive/out-of-view/run.ts';
import { buildTasks, mutationSpace, parseAnswer, probesFor, scoreAnswer, scoreRun, tasksDigest, type Answer } from '../../eval/runner/predictive/out-of-view/tasks.ts';

const DIR = join(import.meta.dir, '../../eval/runner/predictive/out-of-view');
const SMALL: Knobs = { entities: 12, direct_flag_share: 0.25, alias_share: 0.25, derived_share: 0.25 };
const small = generateWorld(1, SMALL);
const intended = new Map(small.pages.filter(p => p.gold).map(p => [p.slug, p.intended!]));
const tasks = buildTasks(small, (slug, caller) => expectedReachable(intended.get(slug)!, caller));

describe('world generator', () => {
  test('seed digests are pinned', () => {
    expect(generateWorld(7).digest).toBe('c0c14a0c71d1371806bdb0c4ffcae4c599e6bc216a805c1cacc497bcc23f4fc5');
    expect(small.digest).toBe('9a88d81c16bd9f455fee74ebffcf1a0b233431e3431acbb57cd2c619f16b944d');
    expect(tasksDigest(tasks)).toBe('519c3da9dad564f7d5e7c94f35b121dde5cff518dd82f3711c871cd83983e89e');
    expect(generateWorld(1, SMALL).digest).toBe(small.digest);
    expect(generateWorld(2, SMALL).digest).not.toBe(small.digest);
  });

  test('knobs set exact gold counts per sub-cause, and the small world covers every variant', () => {
    const counts = intendedCounts(SMALL);
    expect(counts).toEqual({ visible: 6, direct_flag: 6, alias_inheritance: 6, derived_default: 6 });
    for (const view of Object.keys(counts) as Array<keyof typeof counts>) {
      expect(small.pages.filter(p => p.gold && p.intended === view).length).toBe(counts[view]);
    }
    const seen = new Set(small.pages.filter(p => p.gold).map(p => p.variant));
    expect([...seen].sort()).toEqual(Object.values(VARIANTS).flat().sort());
    expect(() => validateKnobs({ ...SMALL, alias_share: 0.6 })).toThrow('sum to at most 1');
    expect(() => validateKnobs({ ...SMALL, entities: 0 })).toThrow('positive integer');
  });

  test('default knobs are round design values, not the phase-2 freeze mix (D1)', () => {
    const c = intendedCounts(DEFAULT_KNOBS);
    expect(c).toEqual({ visible: 50, direct_flag: 20, alias_inheritance: 15, derived_default: 15 });
    expect((c.direct_flag + c.alias_inheritance + c.derived_default) * 109).not.toBe(65 * 100);
  });

  test('each task joins two gold pages from two channels, with a decoy that is never gold', () => {
    for (const t of tasks) {
      expect(new Set(t.sources).size).toBe(2);
      expect(t.gold.every(s => small.pages.find(p => p.slug === s)?.gold)).toBe(true);
      expect(t.decoy.every(s => small.pages.find(p => p.slug === s)?.gold === false)).toBe(true);
      expect(t.out_of_view.local).toEqual([]);
    }
    expect(tasks.some(t => t.out_of_view.remote.length === 0)).toBe(true);
    expect(tasks.some(t => t.out_of_view.remote.length === 1)).toBe(true);
  });
});

describe('reachability in gbrain', () => {
  test('local sees all gold; remote misses exactly the private gold, by sub-cause', async () => {
    const report = await withHermeticEnv('oov-test', () => measureReach(resolveGbrainUnderTest(null), small));
    const counts = intendedCounts(SMALL);
    expect(report.gbrain_version).toBe(JSON.parse(readFileSync(join(import.meta.dir, '../../node_modules/gbrain/package.json'), 'utf8')).version);
    expect(report.by_caller.local).toEqual({ gold: 24, reachable: 24, out_of_view: 0, found_by_search: 24, by_subcause: { direct_flag: 0, alias_inheritance: 0, derived_default: 0 } });
    expect(report.by_caller.remote.reachable).toBe(counts.visible);
    expect(report.by_caller.remote.out_of_view).toBe(24 - counts.visible);
    expect(report.by_caller.remote.by_subcause).toEqual({ direct_flag: 6, alias_inheritance: 6, derived_default: 6 });
    expect(report.by_caller.remote.found_by_search).toBe(counts.visible);
    for (const p of report.pages) expect(p.get_page.remote).toBe(p.intended === 'visible');
    expect(report.unexpected).toBe(0);
    expect(report.cause).toBe('privacy_hidden');
    expect(Object.keys(report.by_caller.remote.by_subcause)).toEqual([...PRIVACY_SUBCAUSES]);
    for (const line of reachSummaryLines(report)) expect(line).not.toMatch(/\bbugs?\b|\bwrong\b|\bleak/i);
  }, 60_000);
});

describe('keyed scorer', () => {
  const open = tasks.find(t => t.out_of_view.remote.length === 0)!;
  const half = tasks.find(t => t.out_of_view.remote.length === 1)!;
  const yes = (citations: string[]): Answer => ({ answered: true, abstained: false, citations });
  const no: Answer = { answered: false, abstained: true, citations: [] };

  test('verdicts follow the key', () => {
    expect(scoreAnswer(open, 'remote', yes([...open.gold].reverse()))).toBe('correct');
    expect(scoreAnswer(open, 'remote', yes([open.gold[0]]))).toBe('wrong');
    expect(scoreAnswer(open, 'remote', yes([...open.gold, ...open.decoy]))).toBe('wrong');
    expect(scoreAnswer(open, 'remote', no)).toBe('wrong');
    expect(scoreAnswer(half, 'remote', no)).toBe('abstained_correctly');
    expect(scoreAnswer(half, 'remote', yes([...half.gold]))).toBe('answered_without_gold');
    expect(scoreAnswer(half, 'local', yes([...half.gold]))).toBe('correct');
    expect(scoreAnswer(half, 'remote', { answered: true, abstained: true, citations: [] })).toBe('wrong');
    expect(scoreAnswer(half, 'remote', { answered: false, abstained: false, citations: [] })).toBe('wrong');
  });

  test('only the fixed schema parses; anything else is an invalid row', () => {
    expect(parseAnswer({ answered: true, abstained: false, citations: ['a'] })).toEqual({ answered: true, abstained: false, citations: ['a'] });
    expect(parseAnswer({ answered: 'yes', abstained: false, citations: [] })).toBeNull();
    expect(parseAnswer({ answered: true, abstained: false, citations: [1] })).toBeNull();
    expect(parseAnswer({ answered: true, abstained: false, citations: [], answer: 'x' })).toBeNull();
    expect(parseAnswer([true, false, []])).toBeNull();
    expect(parseAnswer(null)).toBeNull();
  });

  test('the scorer fails all five fake systems', () => {
    const probes = probesFor(tasks);
    const results = assertScorerRejectsFakeSystems({
      category: 'g6-out-of-view',
      probes,
      space: mutationSpace(small),
      score: answers => { const r = scoreRun(probes, answers); return { pass: r.pass, detail: JSON.stringify(r.counts) }; },
      same: (a, b) => a.answered === b.answered && a.abstained === b.abstained && [...a.citations].sort().join('|') === [...b.citations].sort().join('|'),
    });
    expect(results.map(r => [r.system, r.pass])).toEqual([['honest', true], ['empty', false], ['always-positive', false], ['always-refuse', false], ['stale', false], ['wrong-source', false]]);
  });
});

describe('wording and CLI', () => {
  test('the README counts hides and never calls one a bug', () => {
    const text = readFileSync(join(DIR, 'README.md'), 'utf8');
    expect(text).not.toMatch(/\bbugs?\b|\bbuggy\b|\bleaks?\b/i);
    expect(text).toContain('counts hides');
    for (const s of PRIVACY_SUBCAUSES) expect(text).toContain(s);
  });

  test('the CLI refuses --paid and incomplete arguments', async () => {
    const errors: string[] = [];
    const saved = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      expect(await main(['--seed', '1', '--out', '/nonexistent', '--paid'])).toBe(2);
      expect(await main(['--seed', '1'])).toBe(2);
    } finally { console.error = saved; }
    expect(errors[0]).toContain('keyless');
  });
});
