/**
 * B3 time and relationships: three existing gbrain-evals question sets
 * rendered as conversations, so a memory has to build the timeline and the
 * relationship graph itself from chat.
 *
 *   as-of employer   the N3 ledger (eval/generators/n3-temporal-gen.ts, its
 *                    default seed): each person event becomes one dated
 *                    conversation sent on the day the note was recorded. A
 *                    late-recorded event says "back on <date>". Questions are
 *                    N3's asof_facts probes ("Where did Alice work on
 *                    9 January 2023?") with N3's valid-time gold.
 *   one-hop          world-v1 relational questions ("Who invested in Keel?")
 *                    in their committed paraphrase wording
 *                    (eval/data/relational-paraphrase-v1).
 *   multi-hop        the committed N9 composed questions
 *                    (eval/data/n9-multihop-paraphrase-v1), paraphrase
 *                    wording, gold from world-v1 `_facts`.
 *
 * World-v1 pages become conversations in which the user shares their notes
 * on one entity and closes with a "for the record" list of the page's
 * relationships, one per line ("- Carol Jackson invested in Keel."). Each
 * relationship is stated on the page that holds it in `_facts`, matching
 * N9's support pages.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rng, addDays } from '../generators/seeded.ts';
import { N3_DEFAULT_SEED, generateN3World, type N3Gold, type PersonEvent } from '../generators/n3-temporal-gen.ts';
import type { N9QuestionFile } from '../generators/n9-multihop-paraphrase-gen.ts';
import type { ParaphraseFile } from '../generators/relational-paraphrase-gen.ts';
import { buildRelationalQueries, type RichPage } from '../runner/queries/relational.ts';
import { STUB_ABSTAIN, capitalize, isoAt, longDate, makeDocument, namesIn, opaqueId, scoreGold } from './common.ts';
import { fillerSession } from './filler.ts';
import { worldPageConversation, worldPages } from './world-conversations.ts';
import type { HarnessDocument, HarnessQuery, ScoreResult, ScorerLabel, SuiteBundle, SuiteDefinition } from './types.ts';

export const TIME_RELATIONSHIPS_VERSION = 'time-relationships-v1';
export const TIME_RELATIONSHIPS_SEED = 20261007;
const DATA = join(import.meta.dir, '../data');
export const N9_QUESTIONS = join(DATA, 'n9-multihop-paraphrase-v1/questions.json');
export const RELATIONAL_PARAPHRASES = join(DATA, 'relational-paraphrase-v1/paraphrases.json');

/** Display names for the N3 ledger's placeholder companies. */
export const N3_COMPANY_NAMES: Record<string, string> = {
  'startup-0': 'Brightwater', 'startup-1': 'Copperline', 'startup-2': 'Fernway',
  'startup-3': 'Halcyon Labs', 'startup-4': 'Ironbark', 'startup-5': 'Juniper Systems',
};

/** "lee jr" becomes "Lee Jr", "kim 2" becomes "Kim II": no digits or periods in a name. */
export function n3PersonName(name: string): string {
  return name.split(' ').map(w => w === '2' ? 'II' : capitalize(w)).join(' ');
}

const EVENT_SENTENCE: Record<string, string> = {
  'joined': '{P} joined {C}',
  'hired by': '{P} was hired by {C}',
  'spoke at': '{P} spoke at an event hosted by {C}',
  'announced': '{P} made an announcement on behalf of {C}',
  'promoted to': '{P} was promoted at {C}',
};

type Spec =
  | { kind: 'as_of_employer'; person: string; asof: string }
  | { kind: 'one_hop'; relation: 'attended' | 'works_at' | 'invested_in' | 'advises'; subject: string }
  | { kind: 'multi_hop'; family: string; anchor: string; relations: string[]; answer_type: 'person' | 'company' | 'meeting' };

/** Relationship lines stated on a world page, from that page's `_facts`. */
export function relationLines(page: RichPage, titleOf: (slug: string) => string | null): string[] {
  const f = page._facts as RichPage['_facts'] & { category?: string; topic_company?: string };
  const names = (xs?: string[]) => (xs ?? []).map(titleOf).filter((x): x is string => x !== null);
  const lines: string[] = [];
  if (f.type === 'company') {
    lines.push(`${page.title} is ${f.category === 'startup' ? 'a startup' : f.category === 'vc' ? 'a venture firm' : 'an established company'}.`);
    for (const n of names(f.founders)) lines.push(`${page.title} was founded by ${n}.`);
    for (const n of names(f.investors)) lines.push(`${n} invested in ${page.title}.`);
    for (const n of names(f.advisors)) lines.push(`${n} advises ${page.title}.`);
    for (const n of names(f.employees)) lines.push(`${n} works at ${page.title}.`);
  } else if (f.type === 'meeting') {
    for (const n of names(f.attendees)) lines.push(`${n} attended ${page.title}.`);
    const topic = f.topic_company ? titleOf(f.topic_company) : null;
    if (topic) lines.push(`${page.title} was about ${topic}.`);
  }
  return lines;
}

export function generateTimeRelationships(opts: { seed?: number; smoke?: boolean } = {}): SuiteBundle {
  const seed = opts.seed ?? TIME_RELATIONSHIPS_SEED;
  const smoke = opts.smoke ?? false;
  const rng = new Rng(seed);
  const documents: HarnessDocument[] = [];
  const queries: HarnessQuery[] = [];
  const labels: ScorerLabel[] = [];

  // ── As-of employer from the N3 ledger ──
  const n3 = generateN3World({ seed: N3_DEFAULT_SEED });
  const asofUser = opaqueId('tru', seed, 'asof');
  const personName = new Map(n3.ledger.people.map(p => [p.slug, n3PersonName(p.name)]));
  const docOfEvent = new Map<string, string>();
  const events = [...n3.ledger.person_events].sort((a, b) => a.recorded_on < b.recorded_on ? -1 : a.recorded_on > b.recorded_on ? 1 : a.id < b.id ? -1 : 1);
  for (const e of events) {
    const core = EVENT_SENTENCE[e.type]!.replace('{P}', personName.get(e.person)!).replace('{C}', N3_COMPANY_NAMES[e.company]!);
    const sentence = e.late ? `I just found out that ${core} back on ${longDate(e.date)}.` : `Quick update: ${core} on ${longDate(e.date)}.`;
    const messages = fillerSession(rng, rng.int(2, 3));
    messages.splice(2, 0, { role: 'user', content: sentence }, { role: 'assistant', content: 'Thanks, noted.' });
    const id = opaqueId('trd', seed, e.id);
    docOfEvent.set(e.id, id);
    documents.push(makeDocument(id, asofUser, isoAt(e.recorded_on, rng.int(8 * 60, 21 * 60)), messages));
  }
  const asofQueryTs = isoAt(addDays(events[events.length - 1]!.recorded_on, 7), 12 * 60);
  const companies = Object.values(N3_COMPANY_NAMES);
  let asofProbes = n3.probes.filter(p => p.feature === 'asof_facts') as Array<{ id: string; person: string; asof: string; scenario: string }>;
  if (smoke) asofProbes = asofProbes.filter((_, i) => i % 8 === 0);
  for (const p of asofProbes) {
    const g = n3.gold.get(p.id) as Extract<N3Gold, { kind: 'company' }>;
    const mine = n3.ledger.person_events.filter((e: PersonEvent) => e.person === p.person);
    const jobDocs = mine.filter(e => (e.type === 'joined' || e.type === 'hired by') && e.date <= p.asof).map(e => docOfEvent.get(e.id)!);
    const qid = opaqueId('trq', seed, p.id);
    const name = personName.get(p.person)!;
    const company = g.company ? N3_COMPANY_NAMES[g.company]! : null;
    queries.push({
      id: qid, query: `Where did ${name} work on ${longDate(p.asof)}?`, gold_ids: jobDocs,
      gold_answers: [company ?? 'Nowhere on record: no job had started by that date'], user_id: asofUser,
      meta: { query_timestamp: asofQueryTs, category: 'as_of_employer' },
    });
    const recorded = g.recorded_company ? N3_COMPANY_NAMES[g.recorded_company]! : null;
    labels.push({
      query_id: qid, suite: 'time-relationships', category: 'as_of_employer',
      spec: { kind: 'as_of_employer', person: name, asof: p.asof } satisfies Spec,
      gold: company ? { kind: 'value', value: company } : { kind: 'none' },
      oracle_doc_ids: mine.map(e => docOfEvent.get(e.id)!),
      needles: mine.filter(e => (e.type === 'joined' || e.type === 'hired by') && e.date <= p.asof)
        .map(e => ({ doc_id: docOfEvent.get(e.id)!, text: longDate(e.date), value: N3_COMPANY_NAMES[e.company]! })),
      distractors: [
        ...companies.filter(c => c !== company).map(c => ({ doc_id: '', value: c, kind: c === recorded ? 'recorded-time-answer' : 'other-company' })),
      ],
      negative: company === null,
    });
  }

  // ── World-v1 conversations, one per page ──
  const pages = worldPages();
  const bySlug = new Map(pages.map(p => [p.slug, p]));
  const titleOf = (slug: string) => bySlug.get(slug)?.title ?? null;
  const worldUser = opaqueId('tru', seed, 'world');
  const docOfPage = new Map<string, string>();
  let day = '2025-02-03';
  for (const page of rng.shuffle(pages)) {
    const lines = relationLines(page, titleOf);
    const { messages } = worldPageConversation(page, rng, { closing: lines.length ? ['For the record:\n' + lines.map(l => `- ${l}`).join('\n')] : [] });
    const id = opaqueId('trd', seed, page.slug);
    docOfPage.set(page.slug, id);
    documents.push(makeDocument(id, worldUser, isoAt(day, rng.int(8 * 60, 21 * 60)), messages));
    if (rng.float() < 0.4) day = addDays(day, 1);
  }
  const worldQueryTs = isoAt(addDays(day, 7), 12 * 60);
  const people = pages.filter(p => p._facts.type === 'person').map(p => p.title);
  const universe = { person: people, company: pages.filter(p => p._facts.type === 'company').map(p => p.title), meeting: pages.filter(p => p._facts.type === 'meeting').map(p => p.title) };

  // One-hop relational questions in their committed paraphrase wording.
  const paraphrases = new Map((JSON.parse(readFileSync(RELATIONAL_PARAPHRASES, 'utf8')) as ParaphraseFile).paraphrases.map(p => [p.query_id, p]));
  let oneHop = buildRelationalQueries(pages);
  if (smoke) oneHop = oneHop.filter((_, i) => i % 10 === 0);
  for (const q of oneHop) {
    const para = paraphrases.get(q.id)!;
    const prefix = { attended: 'Who attended ', works_at: 'Who works at ', invested_in: 'Who invested in ', advises: 'Who advises ' }[para.template];
    const subjectTitle = q.text.slice(prefix.length).replace(/\?$/, '');
    const holder = pages.find(p => p.title === subjectTitle)!;
    const answers = (q.gold.relevant ?? []).map(s => titleOf(s)!).sort();
    const qid = opaqueId('trq', seed, 'one-hop', q.id);
    queries.push({
      id: qid, query: para.text, gold_ids: [docOfPage.get(holder.slug)!], gold_answers: [answers.join('; ')], user_id: worldUser,
      meta: { query_timestamp: worldQueryTs, category: `one_hop_${para.template}` },
    });
    labels.push({
      query_id: qid, suite: 'time-relationships', category: `one_hop_${para.template}`,
      spec: { kind: 'one_hop', relation: para.template, subject: subjectTitle } satisfies Spec,
      gold: { kind: 'set', values: answers, universe: universe.person },
      oracle_doc_ids: [docOfPage.get(holder.slug)!],
      needles: answers.map(a => ({ doc_id: docOfPage.get(holder.slug)!, text: a, value: a })),
      distractors: [],
      negative: false,
    });
  }

  // Composed multi-hop questions (N9), paraphrase wording.
  let n9 = (JSON.parse(readFileSync(N9_QUESTIONS, 'utf8')) as N9QuestionFile).questions;
  if (smoke) n9 = n9.filter((_, i) => i % 10 === 0);
  for (const q of n9) {
    const answerType = bySlug.get(q.answers[0]!)!._facts.type as 'person' | 'company' | 'meeting';
    const answers = q.answers.map(s => titleOf(s)!).sort();
    const qid = opaqueId('trq', seed, 'multi-hop', q.id);
    const required = q.required.map(s => docOfPage.get(s)!);
    queries.push({
      id: qid, query: q.paraphrase_text, gold_ids: required, gold_answers: [answers.join('; ')], user_id: worldUser,
      meta: { query_timestamp: worldQueryTs, category: `multi_hop_${q.family}`, hops: q.hops },
    });
    labels.push({
      query_id: qid, suite: 'time-relationships', category: `multi_hop_${q.family}`,
      spec: { kind: 'multi_hop', family: q.family, anchor: titleOf(q.anchor)!, relations: q.relations, answer_type: answerType } satisfies Spec,
      gold: { kind: 'set', values: answers, universe: universe[answerType] },
      oracle_doc_ids: required,
      needles: q.edges.map(e => ({ doc_id: docOfPage.get(e.holder)!, text: titleOf(e.holder === e.to ? e.from : e.to)!, value: titleOf(e.to)! })),
      distractors: [],
      negative: false,
    });
  }

  return {
    suite: 'time-relationships', version: TIME_RELATIONSHIPS_VERSION, seed, smoke,
    documents, queries, labels, extra: {},
    timestamp_provenance: 'observed_session_time: as-of conversations are sent on the day the N3 note was recorded, and an event date inside the text is never the document timestamp; world-v1 conversations carry seeded session times with no meaning for the questions.',
  };
}

// ─── Offline reader ────────────────────────────────────────────────────────

const LONG_DATE = /(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})/;
const MONTH_INDEX: Record<string, number> = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
function isoOfLong(m: RegExpMatchArray): string {
  return `${m[3]}-${String(MONTH_INDEX[m[2]!]).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

interface TextGraph {
  startups: Set<string>;
  founders: Map<string, Set<string>>;
  investors: Map<string, Set<string>>;
  advisors: Map<string, Set<string>>;
  employees: Map<string, Set<string>>;
  attendees: Map<string, Set<string>>;
  topic: Map<string, string>;
}

function parseGraph(context: string): TextGraph {
  const g: TextGraph = { startups: new Set(), founders: new Map(), investors: new Map(), advisors: new Map(), employees: new Map(), attendees: new Map(), topic: new Map() };
  const add = (m: Map<string, Set<string>>, k: string, v: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(v); };
  for (const raw of context.split('\n')) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if (!line.startsWith('- ')) continue;
    const s = line.slice(2);
    if ((m = /^(.+) is a startup\.$/.exec(s))) g.startups.add(m[1]!);
    else if ((m = /^(.+) was founded by (.+)\.$/.exec(s))) add(g.founders, m[1]!, m[2]!);
    else if ((m = /^(.+) invested in (.+)\.$/.exec(s))) add(g.investors, m[2]!, m[1]!);
    else if ((m = /^(.+) advises (.+)\.$/.exec(s))) add(g.advisors, m[2]!, m[1]!);
    else if ((m = /^(.+) works at (.+)\.$/.exec(s))) add(g.employees, m[2]!, m[1]!);
    else if ((m = /^(.+) attended (.+)\.$/.exec(s))) add(g.attendees, m[2]!, m[1]!);
    else if ((m = /^(.+) was about (.+)\.$/.exec(s))) g.topic.set(m[1]!, m[2]!);
  }
  return g;
}

function step(g: TextGraph, from: string, relation: string): string[] {
  const has = (m: Map<string, Set<string>>, k: string) => [...(m.get(k) ?? [])];
  const startupsWith = (m: Map<string, Set<string>>) => [...g.startups].filter(c => m.get(c)?.has(from));
  switch (relation) {
    case 'invested_in': return startupsWith(g.investors);
    case 'advises': return startupsWith(g.advisors);
    case 'founded_by': return g.startups.has(from) ? has(g.founders, from) : startupsWith(g.founders);
    case 'has_investor': return has(g.investors, from);
    case 'topic': { const t = g.topic.get(from); return t && g.startups.has(t) ? [t] : []; }
    case 'attended': return [...g.attendees.keys()].filter(m => g.attendees.get(m)!.has(from));
    default: throw new Error(`unknown relation ${relation}`);
  }
}

export function timeRelationshipsStubAnswer(label: ScorerLabel, context: string): string {
  const spec = label.spec as unknown as Spec;
  if (spec.kind === 'as_of_employer') {
    const re = new RegExp(`(?:^|[^A-Za-z])${spec.person} (joined|was hired by) ([^.,;\\n]+?) (?:back )?on (${LONG_DATE.source})`, 'g');
    let best: { date: string; company: string } | null = null;
    for (const m of context.matchAll(re)) {
      const date = isoOfLong(LONG_DATE.exec(m[3]!)!);
      if (date <= spec.asof && (!best || date >= best.date)) best = { date, company: m[2]! };
    }
    return best ? best.company : STUB_ABSTAIN;
  }
  const g = parseGraph(context);
  let answers: string[];
  if (spec.kind === 'one_hop') {
    const s = spec.subject;
    answers = spec.relation === 'attended' ? [...(g.attendees.get(s) ?? [])]
      : spec.relation === 'invested_in' ? [...(g.investors.get(s) ?? [])]
        : spec.relation === 'advises' ? [...(g.advisors.get(s) ?? [])]
          : [...new Set([...(g.employees.get(s) ?? []), ...(g.founders.get(s) ?? [])])];
  } else {
    let paths: string[][] = [[spec.anchor]];
    for (const relation of spec.relations) {
      const next: string[][] = [];
      for (const path of paths) for (const to of step(g, path[path.length - 1]!, relation)) if (!path.includes(to)) next.push([...path, to]);
      paths = next;
    }
    answers = [...new Set(paths.map(p => p[p.length - 1]!))];
  }
  return answers.length ? answers.sort().join('; ') : STUB_ABSTAIN;
}

export function scoreTimeRelationships(label: ScorerLabel, answer: string): ScoreResult {
  if (label.gold.kind === 'none') {
    const named = namesIn(answer, label.distractors.map(d => d.value));
    return named.length ? { outcome: 'wrong', matched: named } : scoreGold(label.gold, answer);
  }
  return scoreGold(label.gold, answer, label.distractors.map(d => d.value));
}

export const timeRelationships: SuiteDefinition = {
  id: 'time-relationships',
  version: TIME_RELATIONSHIPS_VERSION,
  defaultSeed: TIME_RELATIONSHIPS_SEED,
  describe: 'B3: as-of employer, one-hop and composed multi-hop relationship questions rendered as conversations.',
  generate: ({ seed, smoke }) => generateTimeRelationships({ seed, smoke }),
  stubAnswer: timeRelationshipsStubAnswer,
  score: scoreTimeRelationships,
};
