/**
 * query task set for the SkillOpt method benchmark (GST-799, plan Phase 1).
 *
 * Questions the query skill answers from the brain, in five families:
 *
 *   gov-value     an account attribute as of a date (seats, price, discount,
 *                 renewal date, support tier, notice, payment terms), from
 *                 messy-company-v1's governing-records labels; the traps are
 *                 superseded, not-yet-effective, draft and misstated records
 *   founder       who founded a world-v1 company
 *   affiliation   which company a world-v1 person works with
 *   negative      an invented or look-alike person or company; the right
 *                 answer says the brain has nothing on it
 *
 * Usage: generated through eval/generators/skillopt-method/gen.ts.
 */
import { Rng } from '../seeded.ts';
import { type SkillGeneration, type Draft, type Corpus, assembleSkill, confirmAffiliation, confirmFounder, govBase, govFacts, inventedCompanies, inventedPeople, longDate, lookalikePeople, loadCorpora, possessive } from './common.ts';

export const QUERY_SEED = 15_001;
export const QUERY_QUOTAS = {
  'gov-value': [10, 10, 15],
  founder: [5, 5, 8],
  affiliation: [5, 5, 7],
  negative: [4, 4, 6],
} as const;

export function queryDrafts(corpus: Corpus, rng: Rng): Draft[] {
  const drafts: Draft[] = [];
  for (const g of govFacts(corpus)) {
    if (!g.ok) { drafts.push({ ok: false, family: 'gov-value', anchor: g.row.id, reason: g.reason }); continue; }
    const f = g.fact;
    drafts.push({ ok: true, candidate: {
      family: 'gov-value',
      task: `As of ${longDate(f.row.as_of)}, what is ${possessive(f.account)} ${f.attribute.phrase}?`,
      ...govBase(f),
      answerable: true,
      gold: { values: [f.attribute.gold(f.row.value)], slugs: [f.row.governing_slug] },
      oracle_answer: `${f.evidence}\n\n[Source: ${f.row.governing_slug}]`,
    } });
  }

  const world = [...corpus.world.values()];
  for (const company of world.filter(p => p.type === 'company')) {
    const o = confirmFounder(corpus, company);
    if ('reason' in o) { drafts.push({ ok: false, family: 'founder', anchor: company.slug, reason: o.reason }); continue; }
    const founder = corpus.world.get(o.founder)!;
    drafts.push({ ok: true, candidate: {
      family: 'founder',
      task: `Who founded ${company.title}?`,
      anchor: { kind: 'entity', id: company.slug },
      fact_keys: [`rel:${founder.slug}:${company.slug}`, `page:${company.slug}`, `page:${founder.slug}`],
      answerable: true,
      gold: { values: [{ kind: 'name', value: founder.title }], slugs: [company.slug, founder.slug] },
      distractors: { slugs: [], values: [] },
      source: `world-v1 ${company.slug} _facts.founders`,
      oracle: { path: "the founder's own _facts (role founder, primary affiliation this company) and the company page prose", evidence: o.evidence },
      oracle_answer: `${o.evidence}\n\n[Source: ${company.slug}]`,
    } });
  }

  for (const person of world.filter(p => p.type === 'person')) {
    const o = confirmAffiliation(corpus, person);
    if ('reason' in o) { drafts.push({ ok: false, family: 'affiliation', anchor: person.slug, reason: o.reason }); continue; }
    const company = corpus.world.get(o.company)!;
    drafts.push({ ok: true, candidate: {
      family: 'affiliation',
      task: `Which company does ${person.title} work with?`,
      anchor: { kind: 'entity', id: person.slug },
      fact_keys: [`rel:${person.slug}:${company.slug}`, `page:${person.slug}`, `page:${company.slug}`],
      answerable: true,
      gold: { values: [{ kind: 'name', value: company.title }], slugs: [person.slug, company.slug] },
      distractors: { slugs: person._facts.secondary_affiliations ?? [], values: [] },
      source: `world-v1 ${person.slug} _facts.primary_affiliation`,
      oracle: { path: "the company's _facts role lists and the person page prose", evidence: o.evidence },
      oracle_answer: `${o.evidence}\n\n[Source: ${person.slug}]`,
    } });
  }

  const people = [...inventedPeople(corpus, rng, 6), ...lookalikePeople(corpus, rng, 8)];
  for (const n of people) drafts.push(negative(n.name, n.kind, n.evidence, `Which company does ${n.name} work with?`));
  for (const n of inventedCompanies(corpus, rng, 6)) drafts.push(negative(n.name, n.kind, n.evidence, `Who founded ${n.name}?`));
  return drafts;
}

function negative(name: string, kind: string, evidence: string, task: string): Draft {
  return { ok: true, candidate: {
    family: 'negative',
    task,
    anchor: { kind: 'entity', id: `name:${name}` },
    fact_keys: [`name:${name}`],
    answerable: false,
    gold: { values: [], slugs: [], subject: name },
    distractors: { slugs: [], values: [] },
    source: `${kind} name`,
    oracle: { path: 'absence from every page of both corpora, held-out and private pages included', evidence },
    oracle_answer: `The brain doesn't have information on ${name}.`,
  } };
}

export function generateQuery(): SkillGeneration {
  return assembleSkill('query', QUERY_SEED, queryDrafts(loadCorpora(), new Rng(QUERY_SEED)), QUERY_QUOTAS);
}
