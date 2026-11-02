/**
 * query task set for skillopt-method-v2 (GST-799), the one hardening round
 * after probe 1 found v1 saturated: the seed and one rewrite both scored at the
 * ceiling. Each family needs more of the skill's procedure than v1's single
 * lookups did:
 *
 *   gov-superseded  an account attribute as of a date when the record in force
 *                   superseded an earlier one that held another value (the
 *                   date may also fall before a newer record takes effect);
 *                   only the governing page counts as a citation, and the
 *                   superseded value and page are recorded as distractors
 *   gov-pair        two attributes of one account as of one date: both values,
 *                   and a citation of each attribute's governing page
 *   multi-hop       a world-v1 founder reached through a first page: the
 *                   company a person works with, is employed by or advises, or
 *                   the company a meeting was about; the founder's own page is
 *                   the one to cite
 *   negative        an invented or look-alike person, or an invented company,
 *                   in the same question forms; the answer says the brain has
 *                   nothing on it
 *
 * Usage: generated through eval/generators/skillopt-method/gen.ts.
 */
import type { RichPage } from '../../runner/world-v1-gold.ts';
import { Rng } from '../seeded.ts';
import {
  type Corpus, type Draft, type MethodTask, type SkillGeneration, assembleGrouped, confirmAffiliation, confirmFounder, confirmFounderPage, confirmMeetingTopic,
  confirmRoleTie, governingRows, govBase, govPairs, inventedCompanies, inventedPeople, longDate, lookalikePeople, loadCorpora, pairBase, possessive,
  supersededFacts, uniqueTitle,
} from './common.ts';
import { negative } from './query.ts';

export const QUERY_V2_SEED = 15_011;
export const QUERY_V2_QUOTAS = {
  'gov-superseded': [8, 8, 12],
  'gov-pair': [5, 5, 7],
  'multi-hop': [7, 7, 11],
  negative: [4, 4, 6],
} as const;

/** Recorded in the generation report: where the corpora bound the families. */
export const QUERY_V2_NOTES = [
  'gov-superseded fills a third of the set (8/8/12) from 53 superseding rows on 11 later records (amendments, renewals, an affiliate override), at most three tasks per record, the group limit; 10 of the 11 records are used.',
  'gov-pair draws only pairs whose two attributes one record governs: every pair across two records touches a later record that gov-superseded already fills, and no seeded attempt fits a cross-record pair beside it at 8/8/12 (two fit at 7/7/10). fact-check\'s compound claims carry the cross-record pairs. The pairs placed first are those with the most traps (a newer record signed but not yet in force, a draft, a misstatement elsewhere).',
];

const MEETING_LABELS: Readonly<Record<string, string>> = { board_meeting: 'a board meeting', demo_day: 'a demo day', one_on_one: 'a one-on-one meeting' };

interface FirstHop { slug: string; source: string; path: string; evidence: string }

/** A multi-hop draft: the second hop (the company's founder, cited by the founder's own page) on top of a confirmed first hop. */
function hopDraft(corpus: Corpus, anchor: MethodTask['anchor'], task: string, company: RichPage, first: FirstHop): Draft {
  const o = confirmFounderPage(corpus, company);
  if ('reason' in o) return { ok: false, family: 'multi-hop', anchor: anchor.id, reason: `second hop: ${o.reason}` };
  if (o.founder.slug === first.slug) return { ok: false, family: 'multi-hop', anchor: anchor.id, reason: 'the first-hop person is the founder' };
  return { ok: true, candidate: {
    family: 'multi-hop',
    task,
    anchor,
    fact_keys: [`rel:${o.founder.slug}:${company.slug}`, `page:${o.founder.slug}`],
    answerable: true,
    gold: { values: [{ kind: 'name', value: o.founder.title }], slugs: [o.founder.slug] },
    distractors: { slugs: [company.slug, first.slug], values: [] },
    source: `world-v1 ${first.source}, then ${company.slug} _facts.founders`,
    oracle: { path: `${first.path}; then the company's founder (confirmFounder) and a founding sentence on the founder's own page`, evidence: `${first.evidence}\n\n${o.evidence}` },
    oracle_answer: `${first.evidence}\n\n${o.founder.title}: "${o.evidence}"\n\n[Source: ${o.founder.slug}]`,
  } };
}

export function queryV2Drafts(corpus: Corpus, rng: Rng): Draft[] {
  const drafts: Draft[] = [];
  for (const r of supersededFacts(corpus)) {
    if (!r.ok) { drafts.push({ ok: false, family: 'gov-superseded', anchor: r.row.id, reason: r.reason }); continue; }
    const { fact: f, prev, prevEvidence } = r.s;
    const base = govBase(f);
    drafts.push({ ok: true, priority: f.row.traps.length, candidate: {
      family: 'gov-superseded',
      task: `As of ${longDate(f.row.as_of)}, what is ${possessive(f.account)} ${f.attribute.phrase}?`,
      ...base,
      anchor: { kind: 'record', id: f.row.id },
      answerable: true,
      gold: { values: [f.attribute.gold(f.row.value)], slugs: [f.row.governing_slug] },
      distractors: {
        slugs: [...new Set([prev.governing_slug, ...f.row.distractor_slugs])].filter(x => x !== f.row.governing_slug),
        values: [f.attribute.gold(prev.value), ...f.others.filter(v => String(v.value) !== String(prev.value))],
      },
      oracle: {
        path: `${base.oracle.path}; the superseded record's value reads out of its own deciding paragraph on ${prev.governing_slug}, and the labels put it in force from ${prev.effective}, before the governing record (${f.row.effective})`,
        evidence: `${f.evidence}\n\nsuperseded: ${prevEvidence}`,
      },
      oracle_answer: `${f.evidence}\n\n[Source: ${f.row.governing_slug}]`,
    } });
  }

  for (const r of govPairs(corpus)) {
    if (!r.ok) { drafts.push({ ok: false, family: 'gov-pair', anchor: r.anchor, reason: r.reason }); continue; }
    const { a, b } = r;
    const { pages, base } = pairBase(a, b);
    drafts.push({ ok: true, priority: a.row.traps.length + b.row.traps.length + 2 * (pages.length - 1), candidate: {
      family: 'gov-pair',
      task: `As of ${longDate(a.row.as_of)}, what are ${possessive(a.account)} ${a.attribute.phrase} and its ${b.attribute.phrase}?`,
      ...base,
      answerable: true,
      gold: { values: [a.attribute.gold(a.row.value), b.attribute.gold(b.row.value)], slugs: pages, cite: pages.map(p => [p]) },
      oracle_answer: `${base.oracle.evidence}\n\n${pages.map(p => `[Source: ${p}]`).join(' ')}`,
    } });
  }

  const world = [...corpus.world.values()];
  const companies = world.filter(p => p.type === 'company');
  for (const person of world.filter(p => p.type === 'person')) {
    const anchor = { kind: 'entity' as const, id: person.slug };
    if (person._facts.role !== 'founder') {
      const o = confirmAffiliation(corpus, person);
      if ('reason' in o) drafts.push({ ok: false, family: 'multi-hop', anchor: person.slug, reason: `first hop: ${o.reason}` });
      else drafts.push(hopDraft(corpus, anchor, `Who founded the company that ${person.title} works with?`, corpus.world.get(o.company)!, { slug: person.slug, source: `${person.slug} _facts.primary_affiliation`, path: "the person's primary affiliation (the company's facts or prose name the person, the person's prose names the company)", evidence: o.evidence }));
    }
    for (const role of ['employees', 'advisors'] as const) {
      if (!companies.some(c => (c._facts[role] ?? []).includes(person.slug))) continue;
      const o = confirmRoleTie(corpus, person, role);
      if ('reason' in o) { drafts.push({ ok: false, family: 'multi-hop', anchor: `${person.slug}#${role}`, reason: `first hop: ${o.reason}` }); continue; }
      const task = role === 'employees' ? `Who founded the company where ${person.title} is an employee?` : `Who founded the company that ${person.title} advises?`;
      drafts.push(hopDraft(corpus, anchor, task, o.company, { slug: person.slug, source: `${o.company.slug} _facts.${role}`, path: `the one company whose ${role} list names the person, and a sentence on either page naming the other`, evidence: o.evidence }));
    }
  }

  const meetings = world.filter(p => p.type === 'meeting');
  for (const m of meetings) {
    const t = confirmMeetingTopic(corpus, m);
    if ('reason' in t) { drafts.push({ ok: false, family: 'multi-hop', anchor: m.slug, reason: `first hop: ${t.reason}` }); continue; }
    const founder = confirmFounder(corpus, t.company);
    const type = String(m._facts.meeting_type);
    const date = String(m._facts.date);
    const sameDay = meetings.filter(x => x !== m && x._facts.meeting_type === type && x._facts.date === date);
    const who = rng.shuffle((m._facts.attendees ?? []).map(s => corpus.world.get(s)).filter((p): p is RichPage => !!p))
      .find(p => uniqueTitle(corpus, p) && !('founder' in founder && founder.founder === p.slug) && !sameDay.some(x => (x._facts.attendees ?? []).includes(p.slug)));
    if (!who) { drafts.push({ ok: false, family: 'multi-hop', anchor: m.slug, reason: 'first hop: no attendee other than the founder identifies the meeting by type and date' }); continue; }
    drafts.push(hopDraft(corpus, { kind: 'page', id: m.slug }, `${who.title} attended ${MEETING_LABELS[type] ?? 'a meeting'} on ${longDate(date)}. Who founded the company that meeting was about?`, t.company, { slug: m.slug, source: `${m.slug} _facts.topic_company`, path: "the meeting's topic company, named in the meeting page's prose", evidence: t.evidence }));
  }

  const asOf = [...new Set(governingRows().map(r => r.as_of))].sort();
  for (const n of [...inventedPeople(corpus, rng, 6), ...lookalikePeople(corpus, rng, 8)]) drafts.push(negative(n.name, n.kind, n.evidence, `Who founded the company that ${n.name} works with?`));
  for (const n of inventedCompanies(corpus, rng, 6)) drafts.push(negative(n.name, n.kind, n.evidence, `As of ${longDate(rng.pick(asOf))}, what is ${possessive(n.name)} subscribed seat count?`));
  return drafts;
}

export function generateQueryV2(): SkillGeneration {
  return assembleGrouped('query', QUERY_V2_SEED, queryV2Drafts(loadCorpora(), new Rng(QUERY_V2_SEED)), QUERY_V2_QUOTAS, { notes: QUERY_V2_NOTES });
}
