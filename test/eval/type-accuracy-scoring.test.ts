import { describe, expect, test } from 'bun:test';
import { buildGoldEdges, CAT2_GATES, cat2Verdict, classifyPair, inferAllEdges, score, type GoldEdge, type RichPage } from '../../eval/runner/type-accuracy.ts';

const TYPES = ['advises', 'attended', 'founded', 'invested_in', 'mentions', 'works_at'];
const edge = (from: string, to: string, type: string): GoldEdge => ({ from, to, type });
const gold = [
  edge('p1', 'c1', 'founded'),
  edge('p2', 'c1', 'works_at'),
  edge('p3', 'c1', 'invested_in'),
  edge('m1', 'p1', 'attended'),
];

describe('Cat2 type-spam negative control (C-05)', () => {
  test('an extractor that emits every type for every pair scores below an honest one', () => {
    const honest = score(gold, gold);
    const spam = score(gold, gold.flatMap(g => TYPES.map(t => edge(g.from, g.to, t))));
    expect(honest.overallTypeAccuracy).toBe(1);
    expect(honest.overallStrictF1).toBe(1);
    expect(spam.overallTypeAccuracy).toBe(0);
    expect(spam.overallStrictF1).toBe(0);
    expect(spam.overallAnyTypeAccuracy).toBe(1);
    expect(cat2Verdict(honest)).toBe('pass');
    expect(cat2Verdict(spam)).toBe('fail');
  });

  test('every inferred type that differs from gold is charged as spurious', () => {
    const scored = score(gold, [...gold, edge('p1', 'c1', 'works_at'), edge('p2', 'c1', 'mentions')]);
    const byType = Object.fromEntries(scored.perType.map(r => [r.linkType, r]));
    expect(byType.works_at.spurious).toBe(1);
    expect(byType.mentions.spurious).toBe(1);
    expect(byType.founded.mistyped).toBe(1);
    expect(byType.works_at.correctly_typed).toBe(1);
    expect(scored.rows.find(r => r.from === 'p1')!.inferredType).toBe('works_at');
  });

  test('the untyped mentions fallback does not make a pair mistyped, but a second specific type does', () => {
    expect(classifyPair('founded', ['founded', 'mentions'])).toBe('correctly_typed');
    expect(classifyPair('founded', ['founded', 'works_at'])).toBe('mistyped');
    expect(classifyPair('founded', ['works_at'])).toBe('mistyped');
    expect(classifyPair('founded', [])).toBe('missed');
    expect(classifyPair(null, ['founded'])).toBe('spurious');
    expect(classifyPair('mentions', ['mentions', 'works_at'])).toBe('mistyped');
  });

  test('gates are real floors that a regression fails', () => {
    expect(cat2Verdict({ overallTypeAccuracy: CAT2_GATES.min_type_accuracy, overallStrictF1: CAT2_GATES.min_strict_f1 })).toBe('pass');
    expect(cat2Verdict({ overallTypeAccuracy: CAT2_GATES.min_type_accuracy - 0.01, overallStrictF1: 1 })).toBe('fail');
    expect(cat2Verdict({ overallTypeAccuracy: 1, overallStrictF1: CAT2_GATES.min_strict_f1 - 0.01 })).toBe('fail');
  });
});

describe('Cat2 attended orientation (audit B3)', () => {
  const page = (slug: string, type: RichPage['type'], facts: RichPage['_facts']): RichPage => ({ slug, type, title: slug, compiled_truth: '', timeline: '', _facts: facts });
  const pages = [
    page('people/alice-example', 'person', { type: 'person' }),
    page('meetings/sync-example', 'meeting', { type: 'meeting', attendees: ['people/alice-example'] }),
  ];

  test('gold attendance edges point from the person to the meeting, as gbrain stores them', () => {
    expect(buildGoldEdges(pages)).toEqual([edge('people/alice-example', 'meetings/sync-example', 'attended')]);
  });

  test('canonical attendance candidates are oriented person -> meeting; other candidates keep the page as source', async () => {
    const extractor = (async (slug: string) => slug === 'meetings/sync-example'
      ? { candidates: [
        { targetSlug: 'people/alice-example', linkType: 'attended', context: '', canonicalAttendance: true },
        { targetSlug: 'people/alice-example', linkType: 'mentions', context: '' },
      ], unresolved: [], attendanceComplete: true }
      : { candidates: [], unresolved: [], attendanceComplete: true }) as unknown as Parameters<typeof inferAllEdges>[2];
    const inferred = await inferAllEdges(pages, [], extractor);
    expect(inferred).toEqual([
      edge('people/alice-example', 'meetings/sync-example', 'attended'),
      edge('meetings/sync-example', 'people/alice-example', 'mentions'),
    ]);
    const scored = score(buildGoldEdges(pages), inferred);
    expect(scored.perType.find(r => r.linkType === 'attended')!.correctly_typed).toBe(1);
  });
});
