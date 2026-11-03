/**
 * briefing task set for skillopt-method-v3 (GBEV-30, plan section 2), over
 * world-v3. Each task is a day's calendar: internal entries plus external
 * meetings, each asking one fact as of the briefing's day. An external meeting
 * is with an account (its term in force that day, cited by the record in
 * force), a company (its chief executive that day, cited by the company or
 * the holder's page) or a person (the company they are with that day, cited by
 * their own page). Trained families (train, sel, gate, test):
 *
 *   meetings-3-4        three or four external meetings
 *   unknown-attendee    three or four, one with a person no page carries (a
 *                       real first name with another person's surname); the
 *                       entry says "No brain page for <name>"
 *   lookalike-attendee  three or four, one with a near-name person (Maren
 *                       Holte beside Maren Holt); the other's company is the
 *                       trap
 *
 * Held-out families (gate and test only):
 *
 *   changed-companies   one attendee moved companies; the old company is the
 *                       trap
 *   renewal-pending     one account has a renewal signed but not yet in force;
 *                       the renewal's value is the trap
 *   meetings-5-6        five or six external meetings
 *
 * Every subject belongs to one bundle, and a bundle offers several calendars
 * (different days) of one family, so a bundle's tasks form one group and the
 * assembler keeps at most three of them.
 *
 * Revision 1 (rev1-v3.ts; `V3Knobs.revision` 1) replaces every family. Each
 * calendar has two or three asked meetings, each one fact as of the day:
 * a contact's account's term (indirect), an account's term when the record in
 * force names its legal entity (supersession), a rep's account with the most
 * or fewest seats, highest or lowest price, largest or smallest discount
 * (aggregation), or a contact no page carries (abstention); held-out kinds
 * add a company's founder named through a former officer (indirect), a rep's
 * account that renews first (aggregation) and the one account meeting two
 * conditions (join). Trained families:
 *
 *   contact-terms    two contact meetings and up to one more
 *   legal-terms      two legal-entity meetings and up to one more
 *   rep-review       a rep's account review and one or two more
 *   unknown-contact  a contact no page carries and one or two more
 *
 * Held out (gate and test only): former-role, rep-renewal and join-review,
 * each that meeting and one or two more of the trained kinds. A bundle's
 * calendars fall in one window of 60 days; no fact or page serves two
 * bundles.
 *
 * Usage: generated through eval/generators/skillopt-method/gen.ts.
 */
import { Rng } from '../seeded.ts';
import {
  accountsOf, assembleRev1, condPhrase, contactFacts, formerRoleFacts, groupFacts, groupPhrase, joinFacts, repsOf, termFact,
  type ContactFact, type DraftRev1, type FormerRoleFact, type GroupFact, type JoinFact, type ProbeSpec,
} from './rev1-v3.ts';
import {
  absentFromWorld, assembleV3, goldOf, loadWorldV3, nameValue, roleHolderFromText, stintFromText, uniqueValues, valueFromText, weekdayName, type CandidateV3,
  type DraftV3, type SkillGenerationV3, type WorldCorpus,
} from './common-v3.ts';
import {
  addDays, ATTR_IDS, ATTRS, chainEnd, currentStint, daysBetween, DEFAULT_V3_KNOBS, longDate, revisionOf, stintAt, tenureAt, valueAt, weekdayOn, WORLD_NOW, type AttrId, type Contract, type Org, type Person,
  type V3Knobs,
} from './world-v3.ts';
import { possessive } from './common.ts';
import type { MeetingSpec } from '../../runner/skillopt-method/score-v3.ts';
import type { GoldValue } from '../../runner/skillopt-method/score.ts';

export const BRIEFING_V3_SEED = 30_012;
const QUOTAS_R0 = {
  'meetings-3-4': [10, 10, 8, 20],
  'unknown-attendee': [7, 7, 5, 14],
  'lookalike-attendee': [7, 7, 5, 14],
  'changed-companies': [0, 0, 6, 16],
  'renewal-pending': [0, 0, 6, 16],
  'meetings-5-6': [0, 0, 6, 16],
} as const;
const QUOTAS_R1 = {
  'contact-terms': [6, 6, 5, 12],
  'legal-terms': [6, 6, 5, 12],
  'rep-review': [6, 6, 4, 12],
  'unknown-contact': [6, 6, 4, 12],
  'former-role': [0, 0, 6, 16],
  'rep-renewal': [0, 0, 6, 16],
  'join-review': [0, 0, 6, 16],
} as const;
/** Per revision: family quotas [train, sel, gate, test] and the held-out families. */
export const BRIEFING_V3_QUOTAS_BY_REVISION = { 0: QUOTAS_R0, 1: QUOTAS_R1 } as const;
export const BRIEFING_V3_HELD_OUT_BY_REVISION = { 0: ['changed-companies', 'renewal-pending', 'meetings-5-6'], 1: ['former-role', 'rep-renewal', 'join-review'] } as const;
/** The default revision's. */
export const BRIEFING_V3_QUOTAS: Readonly<Record<string, readonly [number, number, number, number]>> = BRIEFING_V3_QUOTAS_BY_REVISION[revisionOf(DEFAULT_V3_KNOBS)];
export const BRIEFING_V3_HELD_OUT: readonly string[] = BRIEFING_V3_HELD_OUT_BY_REVISION[revisionOf(DEFAULT_V3_KNOBS)];
/** Calendars each bundle offers; the assembler places at most three. */
const VARIANTS = 4;
/** Bundles built per family, relative to the fewest that could fill its quota at three tasks each. */
const SLACK = 1.25;

const ACCOUNT_MEETINGS = ['Quarterly review with', 'Renewal planning call with', 'Pricing review with', 'Account check-in with'];
const COMPANY_MEETINGS = ['Partnership intro with', 'Vendor review with', 'Board prep call with', 'Demo for'];
const PERSON_MEETINGS = ['Coffee with', 'Intro call with', 'Catch-up with', 'Lunch with'];
const INTERNAL = ['Team standup (internal)', 'Focus block', 'Pipeline review (internal)', 'Inbox and follow-ups', 'Hiring sync (internal)', 'Lunch'];
const TIMES = ['08:30', '09:00', '10:00', '10:30', '11:30', '13:00', '14:00', '14:30', '15:30', '16:00', '17:00'];

type Subject =
  | { kind: 'account'; org: Org; from: string; to: string; attrs?: readonly AttrId[] }
  | { kind: 'company'; org: Org; from: string; to: string }
  | { kind: 'person'; person: Person; from: string; to: string }
  | { kind: 'absent'; name: () => { name: string; near: Person[] } };

interface Built { meeting: Omit<MeetingSpec, 'time'>; ask: string; keys: string[]; slugs: string[]; nearMiss: string[]; source: string; evidence: string; line: (day: string) => string }

export function briefingV3Drafts(corpus: WorldCorpus, rng: Rng): DraftV3[] {
  const { world: w, pages } = corpus;
  const drafts: DraftV3[] = [];
  const org = (s: string) => w.orgs.get(s)!;
  const person = (s: string) => w.people.get(s)!;
  const last = addDays(WORLD_NOW, -1);
  const lookalike = new Set([...w.lookalikes.homonyms.flat(), ...w.lookalikes.near.flat()]);
  const orgsOf = (p: Person) => new Set(p.stints.map(s => s.org));
  const pendingOn = (chain: readonly Contract[], attr: AttrId, day: string) => chain.some(c => c.kind === 'renewal' && c.signed <= day && day < c.effective && attr in c.sets);

  // Pools: each subject is used in one bundle.
  const accounts = rng.shuffle([...w.orgs.values()].filter(o => o.kind === 'account'));
  const companies = rng.shuffle([...w.orgs.values()].filter(o => o.kind === 'company'));
  const regular = rng.shuffle([...w.people.values()].filter(p => !lookalike.has(p.slug) && currentStint(p) && currentStint(p)!.role !== 'vendor' && orgsOf(p).size === 1));
  const changers = rng.shuffle([...w.people.values()].filter(p => !lookalike.has(p.slug) && currentStint(p) && currentStint(p)!.role !== 'vendor' && orgsOf(p).size > 1 && currentStint(p)!.start >= '2022-06-01'));
  const nearPeople = rng.shuffle(w.lookalikes.near.flat().map(person).filter(p => currentStint(p)));
  const absentNames = (() => {
    const pool = rng.shuffle([...w.people.values()].filter(p => !lookalike.has(p.slug) && currentStint(p) && currentStint(p)!.role !== 'vendor'));
    let i = 0;
    return () => {
      for (; i + 1 < pool.length * 4; i += 2) {
        const a = pool[i % pool.length]!, b = pool[(i * 7 + 3) % pool.length]!;
        const name = `${a.first} ${b.last}`;
        if (a === b || a.last === b.last || a.first === b.first) continue;
        if (!absentFromWorld(corpus, name) || [...w.people.values()].some(p => p.name === name)) continue;
        i += 2;
        return { name, near: [a, b] };
      }
      throw new Error('briefing v3: ran out of absent names');
    };
  })();

  /** A company meeting cites its chief executives' pages too, so a company and those people are never subjects of two bundles. */
  const usedPeople = new Set<string>();
  const leaders = (c: Org) => c.ceo.map(t => t.person);
  const take = <T,>(xs: T[], free: (x: T) => boolean) => { const i = xs.findIndex(free); return i < 0 ? undefined : xs.splice(i, 1)[0]; };
  const accountSubject = (a: Org): Subject => { const ch = w.chains.get(a.slug)!; return { kind: 'account', org: a, from: addDays(ch[0]!.effective, 20), to: [last, chainEnd(ch)].sort()[0]! }; };
  const companySubject = (c: Org): Subject => { for (const p of leaders(c)) usedPeople.add(p); return { kind: 'company', org: c, from: addDays(c.founded!, 200) > '2023-01-01' ? addDays(c.founded!, 200) : '2023-01-01', to: last }; };
  const personSubject = (p: Person): Subject => { usedPeople.add(p.slug); return { kind: 'person', person: p, from: addDays(currentStint(p)!.start, 14) > '2023-01-01' ? addDays(currentStint(p)!.start, 14) : '2023-01-01', to: last }; };
  const freePerson = (p: Person) => !usedPeople.has(p.slug);
  const freeCompany = (c: Org) => leaders(c).every(p => !usedPeople.has(p));
  let turn = 0;
  const generic = (): Subject | undefined => {
    for (let k = 0; k < 3; k++) {
      const pick = (turn++) % 3;
      if (pick === 0) { const p = take(regular, freePerson); if (p) return personSubject(p); }
      if (pick === 1) { const c = take(companies, freeCompany); if (c) return companySubject(c); }
      if (pick === 2) { const a = take(accounts, () => true); if (a) return accountSubject(a); }
    }
    return undefined;
  };

  /** One meeting's spec for `day`, from the world model, checked against the page text. */
  const build = (s: Subject, day: string, rngAttr: Rng): Built | { reason: string } => {
    if (s.kind === 'absent') {
      const { name, near } = s.name();
      const nearOrgs = near.map(p => org(stintAt(p, day)?.org ?? currentStint(p)!.org));
      return {
        meeting: { title: `${rngAttr.pick(PERSON_MEETINGS)} ${name}`, subject: name, absent: true, distractors: uniqueValues(nearOrgs.map(o => nameValue(o.name))) },
        ask: `${name}: which company they are with today.`, keys: [`name:${name.toLowerCase()}`], slugs: [], nearMiss: [...near.map(p => p.slug), ...nearOrgs.map(o => o.slug)],
        source: `absent name from ${near.map(p => p.slug).join(' and ')}`, evidence: `"${name}" occurs on no page`, line: () => `No brain page for ${name}.`,
      };
    }
    if (s.kind === 'person') {
      const p = s.person;
      const st = stintAt(p, day);
      if (!st) return { reason: `${p.slug} has no stint on ${day}` };
      const o = stintFromText(pages, p.slug, day);
      if ('reason' in o) return { reason: o.reason };
      if (o.org !== st.org) return { reason: `the page gives ${o.org}, the world ${st.org}` };
      const answer = nameValue(org(st.org).name);
      const pair = p.lookalike ? currentStint(person(p.lookalike.slug)) : null;
      const rumors = w.notes.filter(n => n.rumor?.person === p.slug && n.date <= day).map(n => org(n.rumor!.org).name);
      const distractors = uniqueValues([...p.stints.filter(x => x.org !== st.org && x.start <= day).map(x => nameValue(org(x.org).name)), ...(pair ? [nameValue(org(pair.org).name)] : []), ...rumors.map(nameValue)], [answer]);
      return {
        meeting: { title: `${rngAttr.pick(PERSON_MEETINGS)} ${p.name}`, subject: p.name, answer, distractors, cite: [p.slug] },
        ask: `${p.name}: which company they are with today.`, keys: [`works:${p.slug}@${st.org}`], slugs: [p.slug], nearMiss: p.lookalike ? [p.lookalike.slug] : [],
        source: `${p.slug} career on ${day}`, evidence: o.line, line: d => `${p.name}: ${o.title}, ${org(st.org).name} [Source: ${p.slug}, updated ${d}].`,
      };
    }
    if (s.kind === 'company') {
      const c = s.org;
      const t = tenureAt(c.ceo, day);
      if (!t) return { reason: `${c.slug} has no chief executive on ${day}` };
      const o = roleHolderFromText(pages, c.slug, 'Chief executive', day);
      if ('reason' in o) return { reason: o.reason };
      if (o.slug !== t.person) return { reason: `the page gives ${o.slug}, the world ${t.person}` };
      const answer = nameValue(o.name);
      const distractors = uniqueValues([...c.ceo.filter(x => x !== t).map(x => nameValue(person(x.person).name)), ...(c.founder ? [nameValue(person(c.founder).name)] : []), ...c.cto.map(x => nameValue(person(x.person).name))], [answer]);
      return {
        meeting: { title: `${rngAttr.pick(COMPANY_MEETINGS)} ${c.name}`, subject: c.name, answer, distractors, cite: [c.slug, t.person] },
        ask: `${c.name}: who its chief executive is today.`, keys: [`role:${c.slug}:chief executive:${t.person}`], slugs: [c.slug, t.person], nearMiss: [],
        source: `${c.slug} chief executive on ${day}`, evidence: o.evidence, line: d => `${c.name}: chief executive ${o.name} [Source: ${c.slug}, updated ${d}].`,
      };
    }
    const a = s.org;
    const chain = w.chains.get(a.slug)!;
    const options = (s.attrs ?? ATTR_IDS).filter(x => (s.attrs ? true : !pendingOn(chain, x, day)) && new Set(chain.flatMap(c => (x in c.sets ? [String(c.sets[x])] : []))).size > 1);
    if (!options.length) return { reason: `${a.slug} has no term with more than one value to ask on ${day}` };
    const attr = rngAttr.pick(options);
    const g = valueAt(chain, attr, day)!;
    const o = valueFromText(pages, a.slug, attr, day);
    if (!o || String(o.value) !== String(g.value) || o.slug !== g.record.slug) return { reason: `oracle: the contract pages disagree with the chain for ${a.slug} ${attr} on ${day}` };
    const answer = goldOf(attr, g.value);
    const pending = chain.filter(c => c.kind === 'renewal' && c.signed <= day && day < c.effective && attr in c.sets).map(c => c.sets[attr]!);
    const wrong = w.mentions.filter(m => m.account === a.slug && m.attr === attr && !m.correct && m.date <= day).map(m => m.value);
    const distractors = uniqueValues([...pending, ...chain.flatMap(c => (attr in c.sets ? [c.sets[attr]!] : [])), ...wrong].map(v => goldOf(attr, v)), [answer]);
    if (attr === 'renewal_date' && distractors.some(d => d.value === day)) return { reason: 'the day equals a candidate value' };
    const slugs = [g.record.slug, ...(o.rescission ? [o.rescission] : [])];
    return {
      meeting: { title: `${rngAttr.pick(ACCOUNT_MEETINGS)} ${a.name}`, subject: a.name, answer, distractors, cite: slugs },
      ask: `${a.name}: the account's ${ATTRS[attr].phrase} in force today.`, keys: [`val:${a.slug}:${attr}@${g.record.slug}`], slugs, nearMiss: [],
      source: `${a.slug} ${attr} on ${day}`, evidence: o.evidence, line: d => `${a.name}: ${ATTRS[attr].phrase} ${ATTRS[attr].cell(g.value)} [Source: ${g.record.slug}, updated ${d}].`,
    };
  };

  let bundleNo = 0;
  /** Up to VARIANTS calendars of one family over one set of subjects. */
  const bundle = (family: string, subjects: Subject[], window: { from: string; to: string } | null, priority: number) => {
    const id = `b${String(++bundleNo).padStart(3, '0')}`;
    const real = subjects.filter((s): s is Exclude<Subject, { kind: 'absent' }> => s.kind !== 'absent');
    const from = [window?.from ?? '2023-01-01', ...real.map(s => s.from)].sort().at(-1)!;
    const to = [window?.to ?? last, ...real.map(s => s.to)].sort()[0]!;
    if (daysBetween(from, to) < 20) { drafts.push({ ok: false, family, anchor: `cal:${id}`, reason: 'the subjects share no span of days' }); return; }
    const days = new Set<string>();
    for (let k = 0; k < VARIANTS * 3 && days.size < VARIANTS; k++) {
      const d = weekdayOn(addDays(from, rng.int(0, daysBetween(from, to))));
      if (d >= from && d <= to) days.add(d);
    }
    for (const day of [...days].sort()) {
      const anchor = `cal:${id}@${day}`;
      const built: Built[] = [];
      let reason = '';
      for (const s of subjects) { const b = build(s, day, rng); if ('reason' in b) { reason = b.reason; break; } built.push(b); }
      if (reason) { drafts.push({ ok: false, family, anchor, reason }); continue; }
      const internal = rng.shuffle(INTERNAL).slice(0, rng.int(1, 2));
      const times = rng.shuffle(TIMES).slice(0, built.length + internal.length).sort();
      const entries = rng.shuffle([...built.map(b => ({ b, text: b.meeting.title })), ...internal.map(text => ({ b: null as Built | null, text }))]).map((e, i) => ({ ...e, time: times[i]! }));
      const external = entries.filter((e): e is typeof e & { b: Built } => !!e.b);
      const names = external.flatMap(e => (e.b.meeting.answer?.kind === 'name' ? [e.b.meeting.answer] : []));
      /** Another meeting's answer inside this meeting's entry is a swapped fact, so it counts as a distractor here. */
      const meetings: MeetingSpec[] = external.map(e => ({ time: e.time, ...e.b.meeting, distractors: uniqueValues([...e.b.meeting.distractors, ...names], e.b.meeting.answer ? [e.b.meeting.answer] : []) }));
      const slugs = [...new Set(external.flatMap(e => e.b.slugs))];
      const values = meetings.flatMap(m => (m.answer ? [m.answer] : []));
      const candidate: CandidateV3 = {
        family,
        task: [`Daily briefing for ${weekdayName(day)}, ${longDate(day)}.`, '', "Today's calendar:", ...entries.map(e => `- ${e.time} ${e.text}`), '', 'For each external meeting, include:', ...external.map(e => `- ${e.b.ask}`)].join('\n'),
        anchor: { kind: 'calendar', id: anchor },
        fact_keys: [...new Set(external.flatMap(e => e.b.keys))],
        answerable: values.length > 0,
        gold: { values, slugs, cite: external.filter(e => e.b.slugs.length).map(e => e.b.slugs), ...(meetings.find(m => m.absent) ? { subject: meetings.find(m => m.absent)!.subject } : {}), spec: { kind: 'briefing', times, meetings } },
        distractors: { slugs: [...new Set(external.flatMap(e => e.b.nearMiss))], values: uniqueValues(meetings.flatMap(m => m.distractors)) },
        source: `world-v3 bundle ${id}: ${external.map(e => e.b.source).join('; ')}`,
        oracle: { path: "per meeting: the account's contract pages (the record in force that day), the company page's leadership line confirmed by the holder's career list, the person's career list confirmed by the company page, or absence from every page", evidence: external.map(e => e.b.evidence).join('\n') },
        oracle_answer: ['MEETINGS TODAY', ...external.map(e => `- ${e.time} ${e.b.meeting.title}\n  ${e.b.line(day)}`)].join('\n'),
        ...(meetings.some(m => m.absent) ? { near_miss: [...new Set(external.filter(e => e.b.meeting.absent).flatMap(e => e.b.nearMiss))] } : {}),
      };
      drafts.push({ ok: true, candidate, priority });
    }
  };

  const target = (family: keyof typeof QUOTAS_R0) => Math.ceil((QUOTAS_R0[family].reduce<number>((a, b) => a + b, 0) / 3) * SLACK);
  const fill = (n: number) => { const out: Subject[] = []; for (let i = 0; i < n; i++) { const s = generic(); if (s) out.push(s); } return out.length === n ? out : null; };

  // renewal-pending: an account inside a renewal's signed-not-in-force window, asked a term the renewal changes.
  const windows = accounts.flatMap(a => w.chains.get(a.slug)!.filter(c => c.kind === 'renewal' && daysBetween(c.signed, c.effective) > 20 && c.signed > addDays(w.chains.get(a.slug)![0]!.effective, 30) && c.effective <= addDays(WORLD_NOW, 400))
    .map(c => ({ a, c, attrs: (Object.keys(c.sets) as AttrId[]).filter(x => String(c.sets[x]) !== String(c.before[x])) })));
  const usedAccounts = new Set<string>();
  for (const { a, c, attrs } of rng.shuffle(windows)) {
    if (usedAccounts.size >= target('renewal-pending') || usedAccounts.has(a.slug) || !attrs.length) continue;
    const others = fill(2);
    if (!others) break;
    usedAccounts.add(a.slug);
    const i = accounts.indexOf(a);
    if (i >= 0) accounts.splice(i, 1);
    bundle('renewal-pending', rng.shuffle([{ kind: 'account', org: a, from: addDays(c.signed, 2), to: addDays(c.effective, -2) > last ? last : addDays(c.effective, -2), attrs }, ...others]), null, 2);
  }
  for (let i = 0; i < target('changed-companies'); i++) {
    const x = take(changers, freePerson);
    if (!x) break;
    const others = fill(rng.int(2, 3));
    if (!others) break;
    const start = currentStint(x)!.start;
    bundle('changed-companies', rng.shuffle([personSubject(x), ...others]), { from: addDays(start, 10), to: addDays(start, 540) }, 2);
  }
  for (let i = 0; i < target('lookalike-attendee'); i++) {
    const x = take(nearPeople, freePerson);
    if (!x) break;
    const others = fill(rng.int(2, 3));
    if (!others) break;
    bundle('lookalike-attendee', rng.shuffle([personSubject(x), ...others]), null, 1);
  }
  for (let i = 0; i < target('unknown-attendee'); i++) {
    const others = fill(rng.int(2, 3));
    if (!others) break;
    bundle('unknown-attendee', rng.shuffle([...others, { kind: 'absent', name: absentNames } as Subject]), null, 1);
  }
  for (let i = 0; i < target('meetings-3-4'); i++) {
    const s = fill(rng.int(3, 4));
    if (!s) break;
    bundle('meetings-3-4', s, null, 1);
  }
  for (let i = 0; i < target('meetings-5-6'); i++) {
    const s = fill(rng.int(5, 6));
    if (!s) break;
    bundle('meetings-5-6', s, null, 1);
  }
  return drafts;
}

type Kind1 = 'contact' | 'legal' | 'rep' | 'absent' | 'former' | 'renewal' | 'join' | 'filler';
interface Built1 { meeting: Omit<MeetingSpec, 'time'>; ask: string; keys: string[]; nearMiss: string[]; names: string[]; source: string; evidence: string; line: (day: string) => string; probe: ProbeSpec }
/** Calendars each revision-1 bundle offers, the bundles per family (relative to the fewest that could fill its quota at three tasks each), and the window a bundle's days fall in. */
const R1 = { variants: 4, slack: 1.2, window: 60 } as const;

/** Revision 1's drafts: bundles of calendars over one window, each with the searches the findability control runs (one per asked meeting). */
export function briefingV3Rev1Drafts(corpus: WorldCorpus, rng: Rng): DraftRev1[] {
  const { world: w, pages } = corpus;
  const drafts: DraftRev1[] = [];
  const taken = new Set<string>();
  const last = addDays(WORLD_NOW, -1);
  const title = (slug: string) => pages.get(slug)!.match(/^# (.+)$/m)![1]!;
  const contacts = rng.shuffle(contactFacts(corpus));
  const legalAccounts = rng.shuffle(accountsOf(corpus).filter(a => a.legal));
  const reps = rng.shuffle(repsOf(corpus));
  const formers = rng.shuffle(formerRoleFacts(corpus, possessive));
  const absentPool = rng.shuffle([...w.people.values()].filter(p => !p.lookalike && currentStint(p)?.role === 'contact'));
  const groupMemo = new Map<string, GroupFact[]>();
  const groupsOn = (rep: Person, day: string) => { const k = `${rep.slug}@${day}`; if (!groupMemo.has(k)) groupMemo.set(k, groupFacts(corpus, rep, day)); return groupMemo.get(k)!; };
  const joinMemo = new Map<string, JoinFact[]>();
  const joinsOn = (day: string) => { if (!joinMemo.has(day)) joinMemo.set(day, joinFacts(corpus, day, (xs, n) => xs.slice(0, n))); return joinMemo.get(day)!; };
  const usedPeople = new Set<string>();

  /** A term meeting for `a`'s `attr` on `day`. */
  const termMeeting = (kind: 'contact' | 'legal', a: Org, attr: AttrId, day: string, cf?: ContactFact): Built1 | null => {
    const t = termFact(corpus, a, attr, day);
    if ('reason' in t || (kind === 'legal' && !t.alias)) return null;
    const subject = cf ? cf.person.name : a.name;
    const ask = cf ? `${cf.person.name}: the ${ATTRS[attr].phrase} in force today at the account they work for.` : `${a.name}: the account's ${ATTRS[attr].phrase} in force today.`;
    const patterns: ProbeSpec['patterns'] = cf ? (t.alias ? ['indirect', 'supersession'] : ['indirect']) : ['supersession'];
    return {
      meeting: { title: `${rng.pick(cf ? PERSON_MEETINGS : ACCOUNT_MEETINGS)} ${subject}`, subject, answer: t.answer, distractors: t.distractors, cite: t.slugs },
      ask, keys: [t.key, ...t.slugs.map(s => `page:${s}`), ...(cf ? [`works:${cf.person.slug}@${a.slug}`] : [])], nearMiss: [], names: [a.name, ...(a.legal ? [a.legal.name] : [])],
      source: `${a.slug} ${attr} on ${day}${cf ? ` via ${cf.person.slug}` : ''}`, evidence: (cf ? `${cf.evidence}; ` : '') + t.evidence,
      line: d => `${subject}: ${ATTRS[attr].phrase} ${ATTRS[attr].cell(t.value)}, from ${title(t.record.slug)} [Source: ${t.record.slug}, updated ${d}].`,
      probe: { query: ask, patterns, deciding: [...(cf ? [cf.person.slug] : []), ...t.slugs], ...(t.alias ? { newest: t.newest } : {}) },
    };
  };
  const groupMeeting = (f: GroupFact, day: string): Built1 => {
    const renewal = f.op === 'next-renewal';
    const ask = renewal ? `${f.rep.name}: which of the accounts they own renews first after today.` : `${f.rep.name}: which of the accounts they own has ${groupPhrase(f.attr, f.op)} today.`;
    return {
      meeting: { title: `${renewal ? 'Renewals check-in with' : 'Account review with'} ${f.rep.name}`, subject: f.rep.name, answer: f.answer, distractors: f.distractors, cite: f.winnerSlugs },
      ask, keys: [f.key, ...f.winnerSlugs.map(s => `page:${s}`)], nearMiss: [], names: f.members.map(m => m.name),
      source: `accounts owned by ${f.rep.slug}, ${f.attr} ${f.op} on ${day}`, evidence: f.evidence,
      line: d => `${f.rep.name}: ${f.winner!.name} has ${groupPhrase(f.attr, f.op)} of the ${f.members.length} accounts they own [Source: ${f.winnerSlugs[0]}, updated ${d}].`,
      probe: { query: ask, patterns: ['aggregation'], deciding: f.winnerSlugs, needed: f.needed },
    };
  };

  /** One subject of `kind` whose meeting builds on every day, touching no fact or page another bundle took and no name another meeting of the calendar answers or mentions. */
  const subject = (kind: Kind1, days: readonly string[], names: Set<string>, answers: Set<string>): { built: Built1[]; claim: string[] } | null => {
    const fits = (built: Built1[], person?: string) => {
      const keys = [...new Set(built.flatMap(b => b.keys))];
      if (keys.some(k => taken.has(k)) || (person && usedPeople.has(person))) return null;
      const ans = built.flatMap(b => (b.meeting.answer?.kind === 'name' ? [b.meeting.answer.value] : []));
      if (built.some(b => b.names.some(n => answers.has(n))) || ans.some(n => names.has(n))) return null;
      return { built, claim: [...keys, ...(person ? [`person:${person}`] : [])] };
    };
    if (kind === 'filler') {
      for (const k of rng.shuffle(['contact', 'legal', 'rep'] as const)) { const s = subject(k, days, names, answers); if (s) return s; }
      return null;
    }
    const every = (f: (day: string) => Built1 | null) => { const out: Built1[] = []; for (const d of days) { const b = f(d); if (!b) return null; out.push(b); } return new Set(out.map(b => b.ask)).size === 1 ? out : null; };
    if (kind === 'contact') for (const cf of contacts) {
      if (usedPeople.has(cf.person.slug) || days[0]! < addDays(cf.since, 14)) continue;
      const chain = w.chains.get(cf.account.slug)!;
      for (const attr of rng.shuffle(ATTR_IDS.filter(x => new Set(chain.flatMap(c => (x in c.sets ? [String(c.sets[x])] : []))).size > 1))) {
        const b = every(d => termMeeting('contact', cf.account, attr, d, cf));
        const ok = b && fits(b, cf.person.slug);
        if (ok) return ok;
      }
    }
    if (kind === 'legal') for (const a of legalAccounts) {
      if (days[0]! < a.legal!.since) continue;
      for (const attr of rng.shuffle([...ATTR_IDS])) {
        const b = every(d => termMeeting('legal', a, attr, d));
        const ok = b && fits(b);
        if (ok) return ok;
      }
    }
    if (kind === 'rep' || kind === 'renewal') for (const rep of reps) {
      const ops = kind === 'renewal' ? [['renewal_date', 'next-renewal']] as const : rng.shuffle(['seats', 'price', 'discount'].flatMap(attr => [[attr, 'max'], [attr, 'min']] as const));
      for (const [attr, op] of ops) {
        const b = every(d => { const f = groupsOn(rep, d).find(x => x.attr === attr && x.op === op); return f ? groupMeeting(f, d) : null; });
        const ok = b && fits(b);
        if (ok) return ok;
      }
    }
    if (kind === 'former') for (const f of formers) {
      const cur = currentStint(f.person)!;
      if (usedPeople.has(f.person.slug) || days[0]! < addDays(cur.start, 14)) continue;
      const subjectText = `the former ${f.title} of ${f.former.name}`;
      const ask = `The former ${f.title} of ${f.former.name}: who founded the company they work with today.`;
      const slugs = [f.company.slug, f.founder.slug];
      const b = days.map((): Built1 => ({
        meeting: { title: `Intro call with ${subjectText}`, subject: subjectText, answer: nameValue(f.founder.name), distractors: f.distractors, cite: slugs },
        ask, keys: [`founder:${f.company.slug}`, `works:${f.person.slug}@${f.company.slug}`, ...slugs.map(s => `page:${s}`)], nearMiss: [], names: [f.former.name, f.company.name],
        source: `${f.person.slug}, formerly ${f.title} at ${f.former.slug}`, evidence: f.evidence,
        line: d => `${subjectText}: ${f.person.name}, now with ${f.company.name}, which ${f.founder.name} founded [Source: ${f.company.slug}, updated ${d}].`,
        probe: { query: ask, patterns: ['indirect'], deciding: f.deciding },
      }));
      const ok = fits(b, f.person.slug);
      if (ok) return ok;
    }
    if (kind === 'join') for (const j of joinsOn(days[0]!)) {
      const b = every(d => {
        const x = joinsOn(d).find(y => y.keys[0]!.replace(/@.*$/, '') === j.keys[0]!.replace(/@.*$/, '') && y.account === j.account);
        if (!x) return null;
        const ask = `Account health review: the one account ${condPhrase(x.conds[0])} and ${condPhrase(x.conds[1])} today.`;
        return {
          meeting: { title: 'Account health review (internal)', subject: 'Account health review', answer: nameValue(x.account.name), distractors: x.near.map(o => nameValue(o.name)), cite: x.groups.flat() },
          ask, keys: [x.keys[0]!.replace(/@.*$/, ''), ...x.keys.slice(1), ...x.groups.flat().map(s => `page:${s}`)], nearMiss: x.near.map(o => o.slug), names: x.near.map(o => o.name),
          source: `accounts on ${d}: ${x.keys[0]}`, evidence: x.evidence,
          line: dd => `Account health review: ${x.account.name} [Source: ${x.groups[1]![0]}, updated ${dd}].`,
          probe: { query: ask, patterns: ['join'], deciding: x.groups.flat() },
        };
      });
      const ok = b && fits(b);
      if (ok) return ok;
    }
    if (kind === 'absent') for (let i = 0; i + 1 < absentPool.length; i += 2) {
      const pa = absentPool[i]!, pb = absentPool[i + 1]!;
      const name = `${pa.first} ${pb.last}`;
      if (taken.has(`name:${name.toLowerCase()}`) || pa.first === pb.first || pa.last === pb.last || !absentFromWorld(corpus, name) || [...w.people.values()].some(p => p.name === name)) continue;
      const near = [pa, pb].map(p => ({ p, a: w.orgs.get(currentStint(p)!.org)! }));
      const ask = `${name}: the support tier in force today at the account they work for.`;
      const b = days.map((): Built1 => ({
        meeting: { title: `${rng.pick(PERSON_MEETINGS)} ${name}`, subject: name, absent: true, distractors: uniqueValues(near.map(x => nameValue(x.a.name))) },
        ask, keys: [`name:${name.toLowerCase()}`], nearMiss: near.flatMap(x => [x.p.slug, x.a.slug]), names: near.map(x => x.a.name),
        source: `absent name from ${pa.slug} and ${pb.slug}`, evidence: `"${name}" occurs on no page`, line: () => `No brain page for ${name}.`,
        probe: { query: ask, patterns: ['abstention'], deciding: [], near: near.flatMap(x => [x.p.slug, x.a.slug]) },
      }));
      const ok = fits(b);
      if (ok) return ok;
    }
    return null;
  };

  let bundleNo = 0;
  const bundle = (family: string, kinds: Kind1[], priority: number) => {
    const id = `r1b${String(++bundleNo).padStart(3, '0')}`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const from = addDays('2024-03-01', rng.int(0, daysBetween('2024-03-01', addDays(last, -R1.window))));
      const days = [...new Set(Array.from({ length: R1.variants * 2 }, () => weekdayOn(addDays(from, rng.int(1, R1.window)))))].filter(d => d >= from && d <= last).slice(0, R1.variants).sort();
      if (days.length < 2) continue;
      const names = new Set<string>(), answers = new Set<string>();
      const chosen: Array<{ built: Built1[]; claim: string[] }> = [];
      for (const kind of kinds) {
        const s = subject(kind, days, names, answers);
        if (!s) break;
        chosen.push(s);
        for (const n of s.built.flatMap(b => b.names)) names.add(n);
        for (const b of s.built) if (b.meeting.answer?.kind === 'name') answers.add(b.meeting.answer.value);
        for (const k of s.claim) taken.add(k);
        for (const k of s.claim) if (k.startsWith('person:')) usedPeople.add(k.slice(7));
      }
      if (chosen.length !== kinds.length) {
        for (const s of chosen) for (const k of s.claim) { taken.delete(k); if (k.startsWith('person:')) usedPeople.delete(k.slice(7)); }
        continue;
      }
      days.forEach((day, i) => {
        const built = chosen.map(s => s.built[i]!);
        const internal = rng.shuffle(INTERNAL).slice(0, rng.int(1, 2));
        const times = rng.shuffle(TIMES).slice(0, built.length + internal.length).sort();
        const entries = rng.shuffle([...built.map(b => ({ b, text: b.meeting.title })), ...internal.map(text => ({ b: null as Built1 | null, text }))]).map((e, k) => ({ ...e, time: times[k]! }));
        const asked = entries.filter((e): e is typeof e & { b: Built1 } => !!e.b);
        const nameAnswers = asked.flatMap(e => (e.b.meeting.answer?.kind === 'name' ? [e.b.meeting.answer] : []));
        const meetings: MeetingSpec[] = asked.map(e => ({ time: e.time, ...e.b.meeting, distractors: uniqueValues([...e.b.meeting.distractors, ...nameAnswers], e.b.meeting.answer ? [e.b.meeting.answer] : []) }));
        const groups = asked.filter(e => e.b.meeting.cite?.length).map(e => e.b.meeting.cite!);
        const values = meetings.flatMap(m => (m.answer ? [m.answer] : []));
        const absent = meetings.find(m => m.absent);
        drafts.push({ ok: true, priority, probes: asked.map(e => e.b.probe), candidate: {
          family,
          task: [`Daily briefing for ${weekdayName(day)}, ${longDate(day)}.`, '', "Today's calendar:", ...entries.map(e => `- ${e.time} ${e.text}`), '', 'For these meetings, include:', ...asked.map(e => `- ${e.b.ask}`)].join('\n'),
          anchor: { kind: 'calendar', id: `cal:${id}@${day}` },
          fact_keys: [...new Set(asked.flatMap(e => e.b.keys.filter(k => !k.startsWith('page:'))))],
          answerable: values.length > 0,
          gold: { values, slugs: [...new Set(groups.flat())], cite: groups, ...(absent ? { subject: absent.subject } : {}), spec: { kind: 'briefing', times, meetings } },
          distractors: { slugs: [...new Set(asked.flatMap(e => e.b.nearMiss))], values: uniqueValues(meetings.flatMap(m => m.distractors)) },
          source: `world-v3 revision-1 bundle ${id}: ${asked.map(e => e.b.source).join('; ')}`,
          oracle: { path: "per meeting: the contact's career list and the account's contacts list, then the account's contract pages (the record in force that day, a record naming the account's legal entity counting as the account's); every account page naming a rep as owner and those accounts' contract pages; the career list naming a former officer and the company's founding line; every account's owner line and contract pages for a join; or absence from every page", evidence: asked.map(e => e.b.evidence).join('\n') },
          oracle_answer: ['MEETINGS TODAY', ...asked.map(e => `- ${e.time} ${e.b.meeting.title}\n  ${e.b.line(day)}`)].join('\n'),
          ...(absent ? { near_miss: [...new Set(asked.filter(e => e.b.meeting.absent).flatMap(e => e.b.nearMiss))] } : {}),
        } });
      });
      return;
    }
    drafts.push({ ok: false, family, anchor: `cal:${id}`, reason: 'no window where every subject builds without touching another bundle' });
  };

  const bundles = (family: keyof typeof QUOTAS_R1) => Math.ceil((QUOTAS_R1[family].reduce<number>((a, b) => a + b, 0) / 3) * R1.slack);
  const fillers = (lo: number, hi: number): Kind1[] => Array.from({ length: rng.int(lo, hi) }, () => 'filler');
  const plan: Array<[keyof typeof QUOTAS_R1, () => Kind1[], number]> = [
    ['contact-terms', () => ['contact', 'contact', ...fillers(0, 1)], 1],
    ['legal-terms', () => ['legal', 'legal', ...fillers(0, 1)], 1],
    ['join-review', () => ['join', ...fillers(1, 2)], 2],
    ['former-role', () => ['former', ...fillers(1, 2)], 2],
    ['rep-renewal', () => ['renewal', ...fillers(1, 2)], 2],
    ['rep-review', () => ['rep', ...fillers(1, 2)], 1],
    ['unknown-contact', () => ['absent', ...fillers(1, 2)], 1],
  ];
  for (const [family, kinds, priority] of plan) for (let i = 0; i < bundles(family); i++) bundle(family, rng.shuffle(kinds()), priority);
  return drafts;
}

export function generateBriefingV3(knobs: V3Knobs = DEFAULT_V3_KNOBS): SkillGenerationV3 {
  const corpus = loadWorldV3(knobs);
  if (revisionOf(knobs) === 1) return assembleRev1('briefing', BRIEFING_V3_SEED, knobs, corpus, briefingV3Rev1Drafts(corpus, new Rng(BRIEFING_V3_SEED)), QUOTAS_R1, BRIEFING_V3_HELD_OUT_BY_REVISION[1]);
  return assembleV3('briefing', BRIEFING_V3_SEED, knobs, briefingV3Drafts(corpus, new Rng(BRIEFING_V3_SEED)), QUOTAS_R0, { heldOut: BRIEFING_V3_HELD_OUT_BY_REVISION[0] });
}
