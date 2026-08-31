/**
 * Regression tests for the audit fixes in adversarial-injections.ts:
 *
 *   - misc-runners-03 / tests-audit-05: injectAmbiguousRole must produce a
 *     gold that is SATISFIABLE — every must_extract slug appears in the
 *     returned content, in BOTH the "works at"-replace branch and the append
 *     branch. The old replace-only branch demanded a random corpus entity
 *     that was never inserted (a guaranteed miss charged to the extractor).
 *
 *   - misc-runners-04: substring_collision's must_not_extract is now a REAL
 *     corpus slug that a sloppy prose-substring matcher would emit, so the
 *     false-positive branch is REACHABLE (can fail) while a correct extractor
 *     still produces no FP (passes on good input).
 *
 *   - misc-runners-05: scoreGoldDelta enforces must_extract[].type when
 *     enforce_type is set — a slug extracted with only the wrong type lands
 *     in `mistyped`, NOT `matched`, so type-downgrade kinds can finally fail
 *     on mistyping.
 *
 * Hermetic: gbrain's extractPageLinks is pure (no DB, no LLM, no network);
 * the resolver used here is a corpus-slug passthrough.
 */

import { describe, test, expect } from 'bun:test';
import { extractPageLinks, type SlugResolver } from 'gbrain/link-extraction';
import {
  injectAmbiguousRole,
  injectSubstringCollision,
  scoreGoldDelta,
  type EntityRef,
  type ExtractedLinkLike,
  type GoldDelta,
} from '../../eval/runner/adversarial-injections.ts';

const REFS: EntityRef[] = [
  { slug: 'people/amara-okafor', name: 'Amara Okafor' },
  { slug: 'people/jordan-park', name: 'Jordan Park' },
  { slug: 'people/mina-kapoor', name: 'Mina Kapoor' },
  { slug: 'people/sarah-chen', name: 'Sarah Chen' },
  { slug: 'people/priya-patel', name: 'Priya Patel' },
  { slug: 'companies/halfway-capital', name: 'Halfway Capital' },
  { slug: 'companies/novamind', name: 'NovaMind' },
];

/** Cat-6-shaped resolver: exact known-slug match only, no bare-name resolution. */
function corpusResolver(extra: string[] = []): SlugResolver {
  const known = new Set([...REFS.map(r => r.slug), ...extra]);
  return { resolve: async (name: string) => (known.has(name) ? name : null) };
}

async function extractLinks(baseSlug: string, content: string): Promise<ExtractedLinkLike[]> {
  const res = await extractPageLinks(baseSlug, content, {}, 'person', corpusResolver());
  return res.candidates
    .filter(c => c.targetSlug)
    .map(c => ({ targetSlug: c.targetSlug, linkType: c.linkType ?? 'mentions' }));
}

// ─── misc-runners-03 / tests-audit-05: satisfiable ambiguous_role gold ─

describe('injectAmbiguousRole gold satisfiability (misc-runners-03 / tests-audit-05)', () => {
  test('replace branch ("works at" present): every must_extract slug appears in the content', () => {
    const input = 'Alice works at [Acme](companies/acme). She also works at [Beta](companies/beta).';
    const res = injectAmbiguousRole({ content: input, seed: 7, refs: REFS });
    expect(res.content).not.toMatch(/works at/i);
    for (const must of res.goldDelta.must_extract) {
      expect(res.content).toContain(`](${must.slug})`);
    }
  });

  test('append branch (no "works at"): every must_extract slug appears in the content', () => {
    const res = injectAmbiguousRole({ content: 'plain prose.', seed: 7, refs: REFS });
    for (const must of res.goldDelta.must_extract) {
      expect(res.content).toContain(`](${must.slug})`);
    }
  });

  test('replace branch gold is satisfied by gbrain extractPageLinks (end-to-end)', async () => {
    const input = 'Alice works at [Acme](companies/acme) as an engineer.';
    const res = injectAmbiguousRole({ content: input, seed: 3, refs: REFS });
    const extracted = await extractLinks('people/alice', res.content);
    const score = scoreGoldDelta(res.goldDelta, extracted);
    expect(score.missed).toEqual([]);
    expect(score.mistyped).toEqual([]);
    expect(score.matched.map(m => m.slug)).toContain(res.goldDelta.must_extract[0].slug);
  });

  test('type enforcement is only claimed when an isolated people/ target exists', () => {
    // Tiny forced pool with a company target: enforce_type must NOT be set,
    // because gbrain's person→company page-role prior can legitimately type
    // the link works_at/invested_in (that would be a false mistype charge).
    const res = injectAmbiguousRole({
      content: 'plain prose.',
      seed: 1,
      refs: REFS,
      forcedRefs: [{ slug: 'companies/acme', name: 'Acme' }],
    });
    expect(res.goldDelta.must_extract[0].enforce_type).toBeUndefined();

    const res2 = injectAmbiguousRole({ content: 'plain prose.', seed: 1, refs: REFS });
    expect(res2.goldDelta.must_extract[0].enforce_type).toBe(true);
    expect(res2.goldDelta.must_extract[0].slug.startsWith('people/')).toBe(true);
  });

  test('deterministic under same seed', () => {
    const a = injectAmbiguousRole({ content: 'plain prose.', seed: 11, refs: REFS });
    const b = injectAmbiguousRole({ content: 'plain prose.', seed: 11, refs: REFS });
    expect(a.content).toBe(b.content);
    expect(a.goldDelta).toEqual(b.goldDelta);
  });
});

// ─── misc-runners-04: reachable substring-collision false positive ────

describe('substring_collision FP reachability (misc-runners-04)', () => {
  test('forbidden slug is a REAL pool slug that is not linked in the content', () => {
    const res = injectSubstringCollision({ content: 'A base page.', seed: 5, refs: REFS });
    const forbidden = res.goldDelta.must_not_extract[0].slug;
    expect(REFS.some(r => r.slug === forbidden)).toBe(true);
    // The forbidden slug must not appear in the content — only its name-
    // collision prose word does — so extracting it can only mean a
    // prose-substring match fired.
    expect(res.content).not.toContain(forbidden);
  });

  test('CAN FAIL: a sloppy prose-substring matcher output is charged as a false positive', () => {
    const res = injectSubstringCollision({ content: 'A base page.', seed: 5, refs: REFS });
    const forbidden = res.goldDelta.must_not_extract[0].slug;
    const realSlug = res.goldDelta.must_extract[0].slug;
    // Simulate a buggy extractor that resolves the "<Name>AI" prose word to
    // the near-miss entity (plus the legitimate markdown link).
    const sloppy: ExtractedLinkLike[] = [
      { targetSlug: realSlug, linkType: 'mentions' },
      { targetSlug: forbidden, linkType: 'mentions' },
    ];
    const score = scoreGoldDelta(res.goldDelta, sloppy);
    expect(score.false_positives.map(f => f.slug)).toEqual([forbidden]);
  });

  test('PASSES on good input: gbrain extractPageLinks produces no FP and matches the real link', async () => {
    const res = injectSubstringCollision({ content: 'A base page.', seed: 5, refs: REFS });
    const extracted = await extractLinks('concepts/base', res.content);
    const score = scoreGoldDelta(res.goldDelta, extracted);
    expect(score.false_positives).toEqual([]);
    expect(score.missed).toEqual([]);
  });

  test('single-ref pools fall back to the fabricated near-miss slug (never spuriously chargeable)', () => {
    const forced: EntityRef[] = [{ slug: 'people/sam', name: 'Sam' }];
    const res = injectSubstringCollision({ content: 'A base page.', seed: 1, refs: REFS, forcedRefs: forced });
    expect(res.goldDelta.must_not_extract[0].slug).toBe('people/samai');
  });
});

// ─── misc-runners-05: enforce_type actually enforced by the scorer ────

describe('scoreGoldDelta type enforcement (misc-runners-05)', () => {
  const gold: GoldDelta = {
    must_not_extract: [],
    must_extract: [
      { slug: 'people/jordan-park', type: 'mentions', enforce_type: true, reason: 'downgrade required' },
    ],
    note: 'test',
  };

  test('CAN FAIL: slug extracted with only the wrong type lands in mistyped, not matched', () => {
    const score = scoreGoldDelta(gold, [{ targetSlug: 'people/jordan-park', linkType: 'works_at' }]);
    expect(score.matched).toEqual([]);
    expect(score.mistyped).toEqual([
      {
        slug: 'people/jordan-park',
        expected_type: 'mentions',
        actual_types: ['works_at'],
        reason: 'downgrade required',
      },
    ]);
    expect(score.missed).toEqual([]);
  });

  test('passes when the required type is present', () => {
    const score = scoreGoldDelta(gold, [{ targetSlug: 'people/jordan-park', linkType: 'mentions' }]);
    expect(score.matched).toEqual([{ slug: 'people/jordan-park', type: 'mentions' }]);
    expect(score.mistyped).toEqual([]);
  });

  test('absent slug is missed (not mistyped)', () => {
    const score = scoreGoldDelta(gold, []);
    expect(score.missed.map(m => m.slug)).toEqual(['people/jordan-park']);
    expect(score.mistyped).toEqual([]);
  });

  test('entries WITHOUT enforce_type match on slug alone, any type', () => {
    const loose: GoldDelta = {
      must_not_extract: [],
      must_extract: [{ slug: 'companies/novamind', type: 'mentions', reason: 'presence only' }],
      note: 'test',
    };
    const score = scoreGoldDelta(loose, [{ targetSlug: 'companies/novamind', linkType: 'invested_in' }]);
    expect(score.matched).toEqual([{ slug: 'companies/novamind', type: 'mentions' }]);
    expect(score.mistyped).toEqual([]);
  });

  test('must_not_extract fires regardless of type', () => {
    const neg: GoldDelta = {
      must_not_extract: [{ slug: 'people/fake-1', reason: 'inside fence' }],
      must_extract: [],
      note: 'test',
    };
    const score = scoreGoldDelta(neg, [{ targetSlug: 'people/fake-1', linkType: 'mentions' }]);
    expect(score.false_positives.map(f => f.slug)).toEqual(['people/fake-1']);
  });
});
