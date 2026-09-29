/**
 * Cat13 evaluator side: gold store, alignment check and input allowlists.
 *
 * Cat13 gold is generated from the corpus's hidden `_facts` (concept to
 * company and person links). The system under test gets sanitized pages and
 * queries; `CAT13_SUT_PAGE` and `CAT13_SUT_QUERY` make that boundary an
 * enforced allowlist instead of a convention. The gold store is built by a
 * separate loader (`cat13-gold-loader.ts`) that reads the corpus itself, and
 * `assertCat13Alignment` proves the runner's probes are the probes the gold
 * describes, id for id and text for text, so a shifted or permuted label set
 * cannot be scored.
 */
import type { Probe } from '../cat13-conceptual.ts';
import type { Boundary, ForbiddenValue } from './allowlist.ts';
import { GoldStore } from './gold-store.ts';
import { scoreGradedRanking, type GradedRankingScore } from './reference-scorer.ts';

export interface Cat13Gold {
  text: string;
  template: string;
  grades: Record<string, number>;
  targets: string[];
}

export const CAT13_SUT_PAGE: Boundary = {
  name: 'cat13.sut.page@1',
  recipient: 'system-under-test',
  schema: { type: 'object', fields: {
    slug: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' }, compiled_truth: { type: 'string' }, timeline: { type: 'string' },
  } },
};

export const CAT13_SUT_QUERY: Boundary = {
  name: 'cat13.sut.query@1',
  recipient: 'system-under-test',
  schema: { type: 'object', fields: { id: { type: 'string' }, text: { type: 'string' }, as_of_date: { type: 'string', optional: true } } },
};

export const CAT13_BOUNDARIES = [CAT13_SUT_PAGE, CAT13_SUT_QUERY].map(b => b.name);

export function cat13GoldFromProbes(probes: readonly Probe[], gradesByQuery: ReadonlyMap<string, ReadonlyMap<string, number>>): GoldStore<Cat13Gold> {
  return new GoldStore('cat13', probes.map(p => {
    const grades = gradesByQuery.get(p.q.id);
    if (!grades) throw new Error(`cat13 gold: no grades for ${p.q.id}`);
    return [p.q.id, { text: p.q.text, template: p.template, grades: Object.fromEntries(grades), targets: [...p.targetSlugs] }] as const;
  }));
}

/** The runner's probes must be exactly the gold store's probes: same ids, same texts, same templates. */
export function assertCat13Alignment(gold: GoldStore<Cat13Gold>, probes: readonly Pick<Probe, 'q' | 'template'>[]): void {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const p of probes) {
    if (ids.has(p.q.id)) problems.push(`duplicate probe id ${p.q.id}`);
    ids.add(p.q.id);
    if (!gold.has(p.q.id)) { problems.push(`probe ${p.q.id} has no gold`); continue; }
    gold.score(p.q.id, g => {
      if (g.text !== p.q.text) problems.push(`probe ${p.q.id} text differs from its gold`);
      if (g.template !== p.template) problems.push(`probe ${p.q.id} template differs from its gold`);
    });
  }
  for (const id of gold.ids()) if (!ids.has(id)) problems.push(`gold ${id} has no probe`);
  if (problems.length) throw new Error(`cat13 gold alignment failed: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`);
}

/** Graded slugs, in full `dir/name` form, must not appear in the query sent to the system under test. */
export function cat13ForbiddenValues(gold: GoldStore<Cat13Gold>, id: string): ForbiddenValue[] {
  return gold.score(id, g => Object.keys(g.grades).filter(slug => slug.includes('/') && slug.length >= 6).map(slug => ({ value: slug, label: 'graded page slug' })));
}

export function scoreCat13(gold: GoldStore<Cat13Gold>, id: string, ranked: readonly string[], k: number): GradedRankingScore {
  return gold.score(id, g => scoreGradedRanking(ranked, g.grades, g.targets, k));
}
