/**
 * fact-check task set for the SkillOpt method benchmark (GST-799, plan Phase 1).
 *
 * Each task is one brain-derived claim for the skill's data-derived-claims
 * gate (PRODUCER ≠ VERIFIER, AFFILIATION ≠ AUTHORSHIP), which runs on the
 * rollout's read-only tools: search, query, get_page, get_backlinks and
 * traverse_graph. No task needs the web lane. Families:
 *
 *   gov-supported     an account attribute as of a date, stated correctly
 *   gov-contradicted  the same with a nearby wrong value the brain rules out;
 *                     the report must state the correct value
 *   founder-supported "P founded C" where P is C's founder
 *   not-founder       "P founded C" where P is tied to C only as investor,
 *                     employee or advisor (affiliation, not authorship); one
 *                     claim per person, so an investor's companies do not all
 *                     fall into one component
 *   negative          a claim naming an invented or look-alike person or an
 *                     invented company; the brain cannot support it
 *
 * Statuses follow the skill's 6-level scale: supported claims need VERIFIED
 * or LIKELY ACCURATE; contradicted ones LIKELY INACCURATE or FALSE; claims the
 * brain cannot support UNVERIFIED, LIKELY INACCURATE or FALSE.
 *
 * Usage: generated through eval/generators/skillopt-method/gen.ts.
 */
import { Rng } from '../seeded.ts';
import { type Corpus, type Draft, type SkillGeneration, assembleSkill, confirmFounder, confirmNotFounder, govBase, govFacts, inventedCompanies, inventedPeople, longDate, lookalikePeople, loadCorpora, nonFounderAffiliates, perturbedValue, possessive, uniqueTitle } from './common.ts';

export const FACT_CHECK_SEED = 15_003;
export const FACT_CHECK_QUOTAS = {
  'gov-supported': [5, 5, 7],
  'gov-contradicted': [5, 5, 7],
  'founder-supported': [4, 4, 6],
  'not-founder': [6, 6, 10],
  negative: [4, 4, 6],
} as const;

const PREAMBLE = 'Fact-check this claim before it ships. A gbrain pipeline produced it from the brain, so it is a data-derived claim.';
export const taskText = (claim: string) => `${PREAMBLE}\n\nCLAIM: ${claim}`;
export const report = (claim: string, status: string, source: string) => `[1] CLAIM: ${claim}\nLANE: data-derived\nSTATUS: ${status}\nSOURCE: ${source}`;

export function factCheckDrafts(corpus: Corpus, rng: Rng): Draft[] {
  const drafts: Draft[] = [];
  for (const g of govFacts(corpus)) {
    if (!g.ok) {
      for (const family of ['gov-supported', 'gov-contradicted']) drafts.push({ ok: false, family, anchor: g.row.id, reason: g.reason });
      continue;
    }
    const f = g.fact;
    const statement = (v: number | string) => `As of ${longDate(f.row.as_of)}, ${possessive(f.account)} ${f.attribute.phrase} is ${f.attribute.format(v)}.`;
    const right = statement(f.row.value);
    drafts.push({ ok: true, candidate: {
      family: 'gov-supported',
      task: taskText(right),
      ...govBase(f),
      answerable: true,
      gold: { values: [], slugs: [f.row.governing_slug], status: 'supported' },
      oracle_answer: report(right, '✅ VERIFIED', `${f.row.governing_slug}: "${f.evidence}"`),
    } });
    const wrongValue = perturbedValue(f, rng);
    if (wrongValue === null) { drafts.push({ ok: false, family: 'gov-contradicted', anchor: f.row.id, reason: 'no wrong value differs from every recorded value and the governing paragraph' }); continue; }
    const wrong = statement(wrongValue);
    const base = govBase(f);
    drafts.push({ ok: true, candidate: {
      family: 'gov-contradicted',
      task: taskText(wrong),
      ...base,
      anchor: { kind: 'claim', id: `${f.row.id}=${wrongValue}` },
      fact_keys: [...base.fact_keys],
      answerable: true,
      gold: { values: [f.attribute.gold(f.row.value)], slugs: [f.row.governing_slug], status: 'contradicted' },
      oracle_answer: report(wrong, 'FALSE', `${f.row.governing_slug}: "${f.evidence}"`),
    } });
  }
  drafts.push(...worldClaimDrafts(corpus, rng));
  return drafts;
}

/** The world-v1 claims (founder-supported, not-founder) and the negative controls, shared with v2. */
export function worldClaimDrafts(corpus: Corpus, rng: Rng): Draft[] {
  const drafts: Draft[] = [];
  const companies = [...corpus.world.values()].filter(p => p.type === 'company');
  for (const company of companies) {
    const o = confirmFounder(corpus, company);
    if ('reason' in o) { drafts.push({ ok: false, family: 'founder-supported', anchor: company.slug, reason: o.reason }); continue; }
    const founder = corpus.world.get(o.founder)!;
    const claim = `${founder.title} founded ${company.title}.`;
    drafts.push({ ok: true, candidate: {
      family: 'founder-supported',
      task: taskText(claim),
      anchor: { kind: 'claim', id: `founded:${founder.slug}:${company.slug}` },
      fact_keys: [`rel:${founder.slug}:${company.slug}`, `page:${company.slug}`, `page:${founder.slug}`],
      answerable: true,
      gold: { values: [], slugs: [company.slug, founder.slug], status: 'supported' },
      distractors: { slugs: nonFounderAffiliates(corpus, company).map(p => p.slug), values: [] },
      source: `world-v1 ${company.slug} _facts.founders`,
      oracle: { path: "the founder's own _facts (role founder, primary affiliation this company) and the company page prose", evidence: o.evidence },
      oracle_answer: report(claim, '✅ VERIFIED', `${company.slug}: "${o.evidence}"`),
    } });
  }

  const claimed = new Set<string>();
  for (const company of rng.shuffle(companies)) {
    for (const person of nonFounderAffiliates(corpus, company)) {
      if (claimed.has(person.slug)) continue;
      const o = confirmNotFounder(corpus, company, person);
      if ('reason' in o) { drafts.push({ ok: false, family: 'not-founder', anchor: `${person.slug}:${company.slug}`, reason: o.reason }); continue; }
      claimed.add(person.slug);
      const claim = `${person.title} founded ${company.title}.`;
      drafts.push({ ok: true, candidate: {
        family: 'not-founder',
        task: taskText(claim),
        anchor: { kind: 'claim', id: `founded:${person.slug}:${company.slug}` },
        fact_keys: [`rel:${person.slug}:${company.slug}`, `page:${company.slug}`, `page:${person.slug}`],
        answerable: true,
        gold: { values: [], slugs: [company.slug, person.slug], status: 'not-supported' },
        distractors: { slugs: company._facts.founders ?? [], values: [] },
        source: `world-v1 ${company.slug} _facts role lists without ${person.slug} among founders`,
        oracle: { path: "the person's own _facts and a sentence naming both pages with no founding word", evidence: o.evidence },
        oracle_answer: report(claim, '🤷 UNVERIFIED', `${company.slug}: no founded edge or statement; the brain only says "${o.evidence}"`),
      } });
    }
  }

  const founded = companies.filter(c => !('reason' in confirmFounder(corpus, c)));
  const negatives: Array<{ name: string; kind: string; evidence: string; claim: string; page: string }> = [];
  for (const n of inventedPeople(corpus, rng, 8)) {
    const c = rng.pick(founded);
    negatives.push({ ...n, claim: `${n.name} founded ${c.title}.`, page: c.slug });
  }
  for (const n of lookalikePeople(corpus, rng, 30)) {
    const near = corpus.world.get(n.near!)!;
    const c = near._facts.role === 'founder' && near._facts.primary_affiliation ? corpus.world.get(near._facts.primary_affiliation) : undefined;
    if (!c || !founded.includes(c) || !uniqueTitle(corpus, c) || negatives.filter(x => x.kind === 'lookalike').length === 8) continue;
    negatives.push({ ...n, claim: `${n.name} founded ${c.title}.`, page: c.slug });
  }
  for (const n of inventedCompanies(corpus, rng, 8)) {
    const founder = corpus.world.get((confirmFounder(corpus, rng.pick(founded)) as { founder: string }).founder)!;
    negatives.push({ ...n, claim: `${n.name} was founded by ${founder.title}.`, page: founder.slug });
  }
  for (const n of negatives) {
    drafts.push({ ok: true, candidate: {
      family: 'negative',
      task: taskText(n.claim),
      anchor: { kind: 'claim', id: `name:${n.name}` },
      fact_keys: [`name:${n.name}`, `page:${n.page}`],
      answerable: false,
      gold: { values: [], slugs: [], status: 'not-supported' },
      distractors: { slugs: [n.page], values: [] },
      source: `${n.kind} name`,
      oracle: { path: 'absence from every page of both corpora, held-out and private pages included', evidence: n.evidence },
      oracle_answer: report(n.claim, '🤷 UNVERIFIED', `the brain has no page or mention of ${n.name}`),
    } });
  }
  return drafts;
}

export function generateFactCheck(): SkillGeneration {
  return assembleSkill('fact-check', FACT_CHECK_SEED, factCheckDrafts(loadCorpora(), new Rng(FACT_CHECK_SEED)), FACT_CHECK_QUOTAS);
}
