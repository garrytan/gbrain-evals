/**
 * briefing task set for the SkillOpt method benchmark (GST-799, plan Phase 1).
 *
 * Each task is a day's calendar: one external meeting among internal entries
 * that have no brain page. Account meetings fall on the governing record's
 * date; person meetings on a weekday in the fortnight before 2026-10-30. The briefing must state the fact the task asks
 * about that meeting and cite the page holding it in the skill's own form,
 * `[Source: slug, updated DATE]`. Families:
 *
 *   meeting-account  a meeting with a messy-company-v1 customer on the date of
 *                    a governing record; the briefing states the account's
 *                    current value for one attribute
 *   meeting-person   a meeting with a world-v1 person; the briefing says which
 *                    company they are with
 *   negative         a meeting with an invented or look-alike person; the
 *                    briefing says the brain has no page on them
 *
 * Usage: generated through eval/generators/skillopt-method/gen.ts.
 */
import { addDays, Rng } from '../seeded.ts';
import { type Corpus, type Draft, type SkillGeneration, assembleSkill, confirmAffiliation, FILLER_ENTRIES, govBase, govFacts, inventedPeople, longDate, lookalikePeople, loadCorpora, MEETING_TIMES, possessive, weekday, workday } from './common.ts';

export const BRIEFING_SEED = 15_002;
export const BRIEFING_QUOTAS = {
  'meeting-account': [10, 10, 15],
  'meeting-person': [10, 10, 15],
  negative: [4, 4, 6],
} as const;

const ACCOUNT_MEETINGS = ['Account check-in with', 'Quarterly business review with', 'Renewal planning call with', 'Pricing review with'];
const PERSON_MEETINGS = ['Coffee with', 'Intro call with', 'Catch-up with', 'Lunch meeting with'];
/** world-v1 tasks are dated inside the fortnight before this day. */
const WORLD_DAY = '2026-10-30';

/** A calendar of two or three internal entries plus the external one, in time order; returns the text and the external entry's time. */
function calendar(rng: Rng, external: string): { lines: string[]; time: string } {
  const times = rng.shuffle(MEETING_TIMES).slice(0, rng.int(3, 4)).sort();
  const at = rng.int(0, times.length - 1);
  const fillers = rng.shuffle(FILLER_ENTRIES);
  return { lines: times.map((t, i) => `- ${t} ${i === at ? external : fillers[i]}`), time: times[at]! };
}

function taskText(day: string, cal: { lines: string[]; time: string }, ask: string): string {
  return [`Daily briefing for ${weekday(day)}, ${longDate(day)}.`, '', "Today's calendar:", ...cal.lines, '', `For the ${cal.time} meeting, ${ask}`].join('\n');
}

export function briefingDrafts(corpus: Corpus, rng: Rng): Draft[] {
  const drafts: Draft[] = [];
  for (const g of govFacts(corpus)) {
    if (!g.ok) { drafts.push({ ok: false, family: 'meeting-account', anchor: g.row.id, reason: g.reason }); continue; }
    const f = g.fact;
    const cal = calendar(rng, `${rng.pick(ACCOUNT_MEETINGS)} ${f.account}`);
    drafts.push({ ok: true, candidate: {
      family: 'meeting-account',
      task: taskText(f.row.as_of, cal, `include ${possessive(f.account)} current ${f.attribute.phrase}.`),
      ...govBase(f),
      answerable: true,
      gold: { values: [f.attribute.gold(f.row.value)], slugs: [f.row.governing_slug] },
      oracle_answer: `## ${cal.time} ${f.account}\n- ${f.evidence} [Source: ${f.row.governing_slug}, updated ${f.row.as_of}]`,
    } });
  }

  for (const person of [...corpus.world.values()].filter(p => p.type === 'person')) {
    const o = confirmAffiliation(corpus, person);
    if ('reason' in o) { drafts.push({ ok: false, family: 'meeting-person', anchor: person.slug, reason: o.reason }); continue; }
    const company = corpus.world.get(o.company)!;
    const day = workday(addDays(WORLD_DAY, -rng.int(0, 13)));
    const cal = calendar(rng, `${rng.pick(PERSON_MEETINGS)} ${person.title}`);
    drafts.push({ ok: true, candidate: {
      family: 'meeting-person',
      task: taskText(day, cal, `say who ${person.title} is and which company they are with.`),
      anchor: { kind: 'entity', id: person.slug },
      fact_keys: [`rel:${person.slug}:${company.slug}`, `page:${person.slug}`, `page:${company.slug}`],
      answerable: true,
      gold: { values: [{ kind: 'name', value: company.title }], slugs: [person.slug, company.slug] },
      distractors: { slugs: person._facts.secondary_affiliations ?? [], values: [] },
      source: `world-v1 ${person.slug} _facts.primary_affiliation`,
      oracle: { path: "the company's _facts role lists and the person page prose", evidence: o.evidence },
      oracle_answer: `## ${cal.time} ${person.title}\n- ${o.evidence} [Source: ${person.slug}, updated ${day}]`,
    } });
  }

  for (const n of [...inventedPeople(corpus, rng, 8), ...lookalikePeople(corpus, rng, 12)]) {
    const day = workday(addDays(WORLD_DAY, -rng.int(0, 13)));
    const cal = calendar(rng, `${rng.pick(PERSON_MEETINGS)} ${n.name}`);
    drafts.push({ ok: true, candidate: {
      family: 'negative',
      task: taskText(day, cal, `say who ${n.name} is and which company they are with.`),
      anchor: { kind: 'entity', id: `name:${n.name}` },
      fact_keys: [`name:${n.name}`],
      answerable: false,
      gold: { values: [], slugs: [], subject: n.name },
      distractors: { slugs: n.near ? [n.near] : [], values: [] },
      source: `${n.kind} name`,
      oracle: { path: 'absence from every page of both corpora, held-out and private pages included', evidence: n.evidence },
      oracle_answer: `## ${cal.time} ${n.name}\n- No brain page for ${n.name}.`,
    } });
  }
  return drafts;
}

export function generateBriefing(): SkillGeneration {
  return assembleSkill('briefing', BRIEFING_SEED, briefingDrafts(loadCorpora(), new Rng(BRIEFING_SEED)), BRIEFING_QUOTAS);
}
