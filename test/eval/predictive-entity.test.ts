/**
 * G4 wrong entity: the generator, the exact entity-id key and the scorer mutation kit. The T0b namesake scorer counted
 * 11 of 11 namesake failures that were its own false positives, so this file tries hard to make keyEntity accept a
 * near miss. Pure and keyless.
 */
import { describe, expect, test } from 'bun:test';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { keyEntity, scoreEntityEpisode, summarizeEntity } from '../../eval/runner/predictive/entity-agent.ts';
import { entityTasksDigest, generateEntityTasks, G4_PATTERNS, type EntityTask } from '../../eval/generators/entity-agent-gen.ts';

const tasks = generateEntityTasks();
const score = (t: EntityTask, answer: string | null, trial = 0, usd = 0) => scoreEntityEpisode({ task: t, model: 'm', trial, answer, usd, stop: 'submitted' });

describe('G4 generator', () => {
  test('60 seeded tasks over four patterns with a pinned digest; variant 0 is Wintermute\'s template', () => {
    expect(tasks.length).toBe(60);
    expect(new Set(tasks.map(t => t.pattern))).toEqual(new Set(G4_PATTERNS));
    expect(entityTasksDigest(tasks)).toBe('5a7c2583871d7a44625e1e8a8b9caba3943dc9d0c353be535afeea5ae4dff347');
    expect(tasks[0]).toMatchObject({ gold: 'people/dana-kim-fernway', candidates: ['people/dana-kim-fernway', 'people/dana-kim-orchid'] });
    expect(tasks[2].question).toContain('@lumen');
    expect(tasks[3].question).toContain('Ray Castillo');
  });
  test('every task has at least two confusable pages, the gold among them, and every candidate is a page', () => {
    for (const t of tasks) {
      expect(t.candidates.length).toBeGreaterThanOrEqual(2);
      expect(t.candidates).toContain(t.gold);
      const slugs = t.pages.map(p => p.slug);
      for (const c of t.candidates) expect(slugs).toContain(c);
      expect(slugs).toContain(t.evidence_page);
    }
  });
  test('same-name pages share a title, so only the id separates them', () => {
    for (const t of tasks.filter(x => x.pattern === 'moved_namesake' || x.pattern === 'father_son')) {
      const titles = t.candidates.map(c => /title: (.*)/.exec(t.pages.find(p => p.slug === c)!.markdown)![1]);
      expect(new Set(titles).size).toBe(1);
    }
  });
});

describe('keyEntity is exact', () => {
  const t = tasks[0];
  const gold = t.gold;
  test('accepts only harmless spelling of the gold id', () => {
    for (const a of [gold, ` ${gold} `, `/${gold}`, `${gold}.md`, gold.toUpperCase(), `"${gold}"`, '\u0060' + gold + '\u0060']) expect({ a, got: score(t, a).cause }).toEqual({ a, got: 'correct' });
  });
  test('near misses never count as correct (the T0b failure)', () => {
    const traps = [
      'people/dana-kim', 'people/dana-kim-fernway-2', 'people/dana-kim-fernwa', 'dana-kim-fernway', 'Dana Kim', 'Dana Kim at Fernway',
      `${gold} or people/dana-kim-orchid`, `people/dana-kim-orchid, not ${gold}`, `The answer is ${gold}`, 'people/dana-kim-*', '',
    ];
    for (const a of traps) expect({ a, ok: score(t, a).success }).toEqual({ a, ok: false });
  });
  test('the namesake is wrong_entity, an unknown id or a name is invalid', () => {
    expect(score(t, 'people/dana-kim-orchid')).toMatchObject({ cause: 'wrong_entity', confused_with_candidate: true, valid: true });
    expect(score(t, 'people/nobody-here').cause).toBe('invalid');
    expect(score(t, 'Dana Kim').cause).toBe('invalid');
    expect(score(t, null).cause).toBe('invalid');
    expect(keyEntity('companies/lumen-3')).toBe('companies/lumen-3');
  });
  test('the handle trap: the company page is the wrong entity for the founder', () => {
    const h = tasks.find(x => x.pattern === 'company_handle')!;
    expect(score(h, h.candidates.find(c => c.startsWith('companies/'))!).cause).toBe('wrong_entity');
    expect(score(h, h.gold).cause).toBe('correct');
  });
});

describe('G4 scorecard and mutation kit', () => {
  test('B-cubed, wrong entity, pass^4 and cost per correct', () => {
    const [a, b] = tasks;
    const eps = [0, 1, 2, 3].flatMap(trial => [score(a, trial === 0 ? a.candidates[1] : a.gold, trial, 0.1), score(b, b.gold, trial, 0.1)]);
    const s = summarizeEntity(eps);
    expect(s).toMatchObject({ episodes: 8, correct: 7, wrong_entity: 1, invalid: 0 });
    expect(s.pass_hat_k.value).toBe(0.5);
    expect(s.b3.f1).toBeGreaterThan(0.8);
    expect(s.b3.f1).toBeLessThan(1);
    expect(s.cost_per_correct_usd).toBeCloseTo(0.8 / 7);
  });
  test('passes the honest system and fails every applicable fake', () => {
    assertScorerRejectsFakeSystems<EntityTask, string | null>({
      category: 'G4 wrong entity', probes: tasks,
      space: {
        truth: t => t.gold,
        empty: () => null,
        everything: t => t.candidates.join(' '),
        refusal: () => 'UNKNOWN',
        wrongSource: t => t.candidates.find(c => c !== t.gold)!,
      },
      notApplicable: { stale: 'an entity id has no before-and-after value; the moved namesake is the wrong-source fake' },
      score: answers => {
        const eps = answers.map((a, i) => score(tasks[i], a));
        const bad = eps.filter(e => !e.success);
        return { pass: bad.length === 0, detail: bad.length ? `${bad.length} wrong (${bad[0].cause})` : 'all correct' };
      },
    });
  });
});
