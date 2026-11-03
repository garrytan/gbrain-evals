/**
 * briefing task set for skillopt-method-v2 (GST-799), the one hardening round
 * after probe 1 found v1 saturated. v1 asked about one external meeting a day;
 * v2 asks about every external meeting on the calendar, so the briefing has to
 * cover each one, look each up and cite each in the skill's own form,
 * `[Source: slug, updated DATE]`. Families:
 *
 *   multi-meeting         two external meetings, every one answerable: a
 *                         customer account and a world-v1 person, or two
 *                         world-v1 people
 *   multi-meeting-absent  three external meetings: the same two plus one whose
 *                         subject no page of either corpus carries, which
 *                         needs the skill's "no brain page" abstention naming
 *                         the subject while the other two are answered
 *   negative              one external meeting with an invented or look-alike
 *                         person
 *
 * The oracle screens the meetings before any calendar is built, so its drops
 * are counted as account-meeting and person-meeting candidates.
 *
 * An account meeting falls on a governing record's date and asks for the
 * account's value in force that day; records that superseded another value
 * come first. A person's meeting asks which company they are with and is
 * cited by the person's own page. Each calendar draws on one bundle (a
 * governing page and one person, or two people at different companies), so a
 * bundle's tasks form one group, sit in one split and number three at most.
 *
 * Usage: generated through eval/generators/skillopt-method/gen.ts.
 */
import type { RichPage } from '../../runner/world-v1-gold.ts';
import type { GoldValue } from '../../runner/skillopt-method/score.ts';
import { addDays, Rng } from '../seeded.ts';
import {
  type Corpus, type Draft, type GovFact, type MethodTask, type NegativeName, type SkillGeneration, assembleGrouped, confirmAffiliation, FILLER_ENTRIES, governingRows,
  govFacts, govFactKey, inventedPeopleGrid, longDate, lookalikePeople, loadCorpora, MEETING_TIMES, supersededRow, weekday, workday,
} from './common.ts';

export const BRIEFING_V2_SEED = 15_012;
export const BRIEFING_V2_QUOTAS = {
  'multi-meeting': [13, 13, 20],
  'multi-meeting-absent': [7, 7, 10],
  negative: [4, 4, 6],
} as const;

/** Recorded in the generation report: how the calendars are shaped and what the drops count. */
export const BRIEFING_V2_NOTES = [
  'Answered calendars hold two external meetings and absent ones three, the same two plus a subject no page carries. Each calendar draws on one bundle (a governing page and a person, or two people at different companies), so its tasks form one group, and the absent meeting adds an abstention without adding a page.',
  'person-meeting and account-meeting count the meetings the oracle screens before any calendar is built; neither family is placed. The person drops are people whose affiliation the oracle cannot confirm, for v1\'s reasons. account-meeting appears only when a governing row fails the oracle.',
];

const ACCOUNT_MEETINGS = ['Account check-in with', 'Quarterly business review with', 'Renewal planning call with', 'Pricing review with'];
const PERSON_MEETINGS = ['Coffee with', 'Intro call with', 'Catch-up with', 'Lunch meeting with'];
/** world-v1 calendars are dated inside the fortnight before this day. */
const WORLD_DAY = '2026-10-30';
/** Calendars offered per bundle; the assembler places at most three. */
const SLOTS_PER_BUNDLE = 4;

/** One external meeting: its calendar entry, what the task asks, and its gold, keys and oracle. */
interface Meeting {
  subject: string;
  entry: string;
  ask: string;
  value?: GoldValue;
  cite?: string[];
  absent?: boolean;
  keys: string[];
  distractors: { slugs: string[]; values: GoldValue[] };
  source: string;
  oracle: { path: string; evidence: string };
  /** The solvability control's line for this meeting, given its time and the briefing's date. */
  answer: (day: string) => string;
}

function accountMeeting(rng: Rng, f: GovFact): Meeting {
  const prev = supersededRow(governingRows(), f.row);
  const g = f.row.governing_slug;
  return {
    subject: f.account,
    entry: `${rng.pick(ACCOUNT_MEETINGS)} ${f.account}`,
    ask: `${f.account}: the account's current ${f.attribute.phrase}.`,
    value: f.attribute.gold(f.row.value),
    cite: [g],
    keys: [govFactKey(f.row), `page:${g}`],
    distractors: { slugs: [...new Set([...(prev ? [prev.governing_slug] : []), ...f.row.distractor_slugs])].filter(x => x !== g), values: f.others },
    source: `messy-company-v1 labels/governing-records/dev.jsonl ${f.row.id}`,
    oracle: { path: 'the paragraph holding the labelled deciding passage on the governing page; the gold value reads out of it through the scorer pattern', evidence: f.evidence },
    answer: day => `- ${f.evidence} [Source: ${g}, updated ${day}]`,
  };
}

/** A confirmed world-v1 affiliation: the person, their company and the sentence on the person's page naming it. */
interface Person { person: RichPage; company: RichPage; evidence: string }

function personMeeting(rng: Rng, { person, company, evidence }: Person): Meeting {
  return {
    subject: person.title,
    entry: `${rng.pick(PERSON_MEETINGS)} ${person.title}`,
    ask: `${person.title}: who they are and which company they are with.`,
    value: { kind: 'name', value: company.title },
    cite: [person.slug],
    keys: [`rel:${person.slug}:${company.slug}`, `page:${person.slug}`],
    distractors: { slugs: [company.slug, ...(person._facts.secondary_affiliations ?? [])], values: [] },
    source: `world-v1 ${person.slug} _facts.primary_affiliation`,
    oracle: { path: "the company's _facts role lists or page prose name the person, and the person's page prose names the company", evidence },
    answer: day => `- ${evidence} [Source: ${person.slug}, updated ${day}]`,
  };
}

function absentMeeting(rng: Rng, n: NegativeName): Meeting {
  return {
    subject: n.name,
    entry: `${rng.pick(PERSON_MEETINGS)} ${n.name}`,
    ask: `${n.name}: who they are and which company they are with.`,
    absent: true,
    keys: [`name:${n.name}`],
    distractors: { slugs: n.near ? [n.near] : [], values: [] },
    source: `${n.kind} name`,
    oracle: { path: 'absence from every page of both corpora, held-out and private pages included', evidence: n.evidence },
    answer: () => `- No brain page for ${n.name}.`,
  };
}

/** A calendar holding the external meetings among internal entries, the task text and the solvability control. */
function calendarTask(rng: Rng, day: string, meetings: readonly Meeting[]): { task: string; oracle_answer: string } {
  const fillers = rng.shuffle(FILLER_ENTRIES).slice(0, 2);
  const times = rng.shuffle(MEETING_TIMES).slice(0, meetings.length + fillers.length).sort();
  const entries = rng.shuffle([...meetings.map(m => ({ m, text: m.entry })), ...fillers.map(text => ({ m: null as Meeting | null, text }))]);
  const lines = entries.map((e, i) => `- ${times[i]} ${e.text}`);
  const external = entries.map((e, i) => ({ m: e.m, time: times[i]! })).filter((e): e is { m: Meeting; time: string } => !!e.m);
  return {
    task: [`Daily briefing for ${weekday(day)}, ${longDate(day)}.`, '', "Today's calendar:", ...lines, '', 'For each external meeting, include:', ...external.map(e => `- ${e.m.ask}`)].join('\n'),
    oracle_answer: external.map(e => `## ${e.time} ${e.m.subject}\n${e.m.answer(day)}`).join('\n'),
  };
}

function draft(rng: Rng, family: string, anchor: string, day: string, meetings: readonly Meeting[], priority: number): Draft {
  const { task, oracle_answer } = calendarTask(rng, day, meetings);
  const answered = meetings.filter(m => !m.absent);
  const absent = meetings.find(m => m.absent);
  const cite = answered.map(m => m.cite!);
  return { ok: true, priority, candidate: {
    family,
    task,
    anchor: { kind: 'calendar', id: anchor },
    fact_keys: [...new Set(meetings.flatMap(m => m.keys))],
    answerable: answered.length > 0,
    gold: { values: answered.map(m => m.value!), slugs: [...new Set(cite.flat())], ...(cite.length ? { cite } : {}), ...(absent ? { subject: absent.subject } : {}) },
    distractors: { slugs: [...new Set(meetings.flatMap(m => m.distractors.slugs))], values: meetings.flatMap(m => m.distractors.values) },
    source: meetings.map(m => m.source).join('; '),
    oracle: { path: meetings.map(m => m.oracle.path).join('; '), evidence: meetings.map(m => m.oracle.evidence).join('\n\n') },
    oracle_answer,
  } };
}

export function briefingV2Drafts(corpus: Corpus, rng: Rng): Draft[] {
  const drafts: Draft[] = [];
  const rows = governingRows();
  const facts: GovFact[] = [];
  for (const g of govFacts(corpus)) {
    if (g.ok) facts.push(g.fact);
    else drafts.push({ ok: false, family: 'account-meeting', anchor: g.row.id, reason: g.reason });
  }

  const people: Person[] = [];
  for (const person of [...corpus.world.values()].filter(p => p.type === 'person')) {
    const o = confirmAffiliation(corpus, person);
    if ('reason' in o) { drafts.push({ ok: false, family: 'person-meeting', anchor: person.slug, reason: o.reason }); continue; }
    people.push({ person, company: corpus.world.get(o.company)!, evidence: o.evidence });
  }
  const names = [...lookalikePeople(corpus, rng, 60), ...inventedPeopleGrid(corpus, rng, 80)];
  let nextName = 0;
  const name = () => {
    const n = names[nextName++];
    if (!n) throw new Error('briefing v2: ran out of absent names');
    return n;
  };

  const pool = rng.shuffle(people);
  const pages = rng.shuffle([...new Set(facts.map(f => f.row.governing_slug))].sort());
  if (pool.length < pages.length) throw new Error('briefing v2: fewer confirmed people than governing pages');
  const weight = (f: GovFact) => (supersededRow(rows, f.row) ? 2 : 0) + f.row.traps.length;
  pages.forEach((page, b) => {
    const p = pool[b]!;
    const byDate = new Map<string, GovFact>();
    for (const f of rng.shuffle(facts.filter(x => x.row.governing_slug === page)).sort((x, y) => weight(y) - weight(x))) if (!byDate.has(f.row.as_of)) byDate.set(f.row.as_of, f);
    for (const f of [...byDate.values()].slice(0, SLOTS_PER_BUNDLE)) {
      const anchor = `${page}@${f.row.as_of}`;
      drafts.push(draft(rng, 'multi-meeting', anchor, f.row.as_of, [accountMeeting(rng, f), personMeeting(rng, p)], weight(f)));
      drafts.push(draft(rng, 'multi-meeting-absent', anchor, f.row.as_of, [accountMeeting(rng, f), personMeeting(rng, p), absentMeeting(rng, name())], weight(f)));
    }
  });

  const rest = pool.slice(pages.length);
  while (rest.length > 1) {
    const a = rest.shift()!;
    const j = rest.findIndex(x => x.company.slug !== a.company.slug);
    if (j < 0) break;
    const b = rest.splice(j, 1)[0]!;
    const days = new Set<string>();
    for (let i = 0; i < SLOTS_PER_BUNDLE; i++) {
      let day = workday(addDays(WORLD_DAY, -rng.int(0, 13)));
      while (days.has(day)) day = workday(addDays(day, -1));
      days.add(day);
      const anchor = `${a.person.slug}+${b.person.slug}@${day}`;
      drafts.push(draft(rng, 'multi-meeting', anchor, day, [personMeeting(rng, a), personMeeting(rng, b)], 0));
      drafts.push(draft(rng, 'multi-meeting-absent', anchor, day, [personMeeting(rng, a), personMeeting(rng, b), absentMeeting(rng, name())], 0));
    }
  }

  for (let i = 0; i < 20; i++) {
    const day = workday(addDays(WORLD_DAY, -rng.int(0, 13)));
    drafts.push(draft(rng, 'negative', `negative-${i}@${day}`, day, [absentMeeting(rng, name())], 0));
  }
  return drafts;
}

export function generateBriefingV2(): SkillGeneration {
  return assembleGrouped('briefing', BRIEFING_V2_SEED, briefingV2Drafts(loadCorpora(), new Rng(BRIEFING_V2_SEED)), BRIEFING_V2_QUOTAS, { notes: BRIEFING_V2_NOTES });
}
