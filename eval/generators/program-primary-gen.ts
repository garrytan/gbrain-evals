/**
 * Program primary (T0) workload generator: seeded personal brains for the
 * target user, and the two-session tasks asked of them.
 *
 * Target user (plan 2026-10-07 section 3.1): an engineer or founder running
 * an agent harness against a personal brain. Each seed is one persona: a
 * founder of a small invented startup, the people they deal with, the
 * companies those people work for, deals, upcoming meetings, daily notes and
 * inbox digests. Nothing refers to a real person or company.
 *
 * Ledger first, prose second. Every value a task depends on is drawn here and
 * every document is rendered from those draws, so the answer key never
 * depends on reading the brain back. No model writes any of it.
 *
 * One task is the binding workload, cross-session meeting or reply
 * preparation after a correction:
 *   session 1  the user tells the agent, after a call with a contact, three
 *              things and asks it to keep the brain up to date: a commitment
 *              (something the user owes the contact), a dated change (their
 *              next meeting moved) and a correction (a stored fact about the
 *              contact or the deal was wrong);
 *   session 2  a fresh session asks for a meeting-prep brief or a reply draft
 *              to that contact without naming any of the three facts.
 * A failure is an unsupported or stale answer or action, or a missed
 * commitment (t0/score.ts derives it from the gold below).
 *
 * Task distribution (frozen by the T0 preregistration): TASKS_PER_PERSONA
 * tasks per persona, half `prep` and half `reply`; the correction is the
 * contact's role (prep only), the deal's seat count or its per-seat price;
 * the commitment comes from a fixed pool; the meeting moves 2 to 9 days
 * later at the same time. Traps: every task contact has a namesake (same
 * first name, other company) with their own meeting, deal and commitment,
 * and the stale values stay in the base brain (person, deal and meeting
 * pages and a daily note), as an un-updated brain would hold them.
 *
 * Seeds. PP_DEV_SEEDS are public development worlds for building and the
 * development baseline. A sealed seed is minted only by the custodian
 * (`--mint-sealed --custodian-out <dir outside the repository>`): the seed
 * goes to a 0600 file in custody and only its SHA-256 commitment is printed
 * for the preregistration. Nothing in this repository holds a sealed seed.
 *
 * Usage:
 *   bun eval/generators/program-primary-gen.ts [--seeds 20261008,...] [--out DIR] [--check]
 *   bun eval/generators/program-primary-gen.ts --mint-sealed --custodian-out <dir outside the repository>
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { insideRepository } from '../runner/sealed-confirmation-lib.ts';

export const PP_GENERATOR_VERSION = 'program-primary-v1';
export const PP_DEV_SEEDS: readonly number[] = [20261008, 20261009, 20261010, 20261011, 20261012, 20261013, 20261014, 20261015];
export const PP_TODAY = '2026-10-14';
export const PP_SESSION2_DAY = '2026-10-15';
export const TASKS_PER_PERSONA = 4;
export const OTHER_CONTACTS = 4;
export const FILLER_NOTES = 24;
export const SEALED_COMMITMENT_PREFIX = 'program-primary-sealed-seed:v1:';
const MAX_DRAWS = 100_000;

export type TaskKind = 'prep' | 'reply';
export type CorrectionKind = 'role' | 'seats' | 'price';

export interface PPDoc {
  /** Path without extension, e.g. `people/dana-okafor`. */
  id: string;
  title: string;
  type: 'person' | 'company' | 'deal' | 'meeting' | 'note' | 'digest';
  date: string;
  body: string;
}

/** A value the scorer looks for, with the regular expressions (case-insensitive sources) that recognize it. */
export interface Matcher { label: string; patterns: string[] }

export interface PPTask {
  id: string;
  persona: string;
  seed: number;
  kind: TaskKind;
  correction_kind: CorrectionKind;
  contact: string;
  contact_name: string;
  session1: string;
  session2: string;
  gold: {
    commitment: Matcher;
    date: { old: Matcher; new: Matcher; old_iso: string; new_iso: string; time: string };
    correction: { stale: Matcher; corrected: Matcher };
    /** Values only the namesake (same first name, other company) has; naming one is an unsupported answer. */
    namesake: Matcher[];
    /** Doc ids that carry the stale values in the base brain. */
    stale_docs: string[];
  };
}

export interface PPPersona {
  id: string;
  seed: number;
  principal: { name: string; first: string; role: string; company: string; product: string };
  docs: PPDoc[];
  tasks: PPTask[];
}

export interface PPWorld { version: string; today: string; session2_day: string; personas: PPPersona[] }

// ─── Seeded randomness ──────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(seed: number) { this.next = mulberry32(seed); }
  int(lo: number, hi: number) { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.next() * xs.length)]; }
  shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }
}

function draw<T>(make: () => T, ok: (v: T) => boolean, what: string): T {
  for (let i = 0; i < MAX_DRAWS; i++) { const v = make(); if (ok(v)) return v; }
  throw new Error(`program-primary-gen: ran out of ${what}`);
}

// ─── Vocabulary (invented) ──────────────────────────────────────────

const FIRST = ['Mira', 'Tobin', 'Ines', 'Dario', 'Kenji', 'Lena', 'Arjun', 'Selma', 'Ruben', 'Noor', 'Calla', 'Yusuf', 'Petra', 'Omari', 'Hana', 'Felix', 'Zara', 'Emil', 'Wren', 'Idris', 'Maren', 'Joaquin', 'Suki', 'Bram', 'Lior', 'Anouk', 'Desmond', 'Ilse', 'Kofi', 'Rania', 'Soren', 'Talia', 'Vikram', 'Elodie', 'Matteo', 'Ayla', 'Niko', 'Odette'];
const LAST = ['Okafor', 'Lindqvist', 'Marchetti', 'Haddad', 'Nakashima', 'Brandt', 'Mehta', 'Kowalczyk', 'Ferreira', 'Aziz', 'Delacroix', 'Osei', 'Varga', 'Thorne', 'Ishikawa', 'Morales', 'Petrov', 'Quist', 'Rahman', 'Sato', 'Torvik', 'Udeh', 'Valdez', 'Wexler', 'Yilmaz', 'Zeller', 'Abara', 'Castellan', 'Draxler', 'Eskildsen', 'Fairbourne', 'Galloway', 'Holmgren', 'Ivers', 'Jaramillo'];
const SYL_A = ['Quor', 'Tel', 'Ves', 'Ondr', 'Pral', 'Kest', 'Mur', 'Zel', 'Bran', 'Cael', 'Dov', 'Fen', 'Gral', 'Hyd', 'Isk', 'Jor', 'Lum', 'Nax', 'Orv', 'Thal', 'Ulm', 'Vor', 'Wyn', 'Xer', 'Yar'];
const SYL_B = ['vane', 'miro', 'tiva', 'ellis', 'onex', 'adyn', 'ura', 'ithe', 'oria', 'quent', 'ostra', 'ivel', 'anta', 'esso', 'umbr', 'ari', 'ovik', 'enza', 'alto', 'ique'];
const CUSTOMER_SUFFIX = ['Logistics', 'Health', 'Foods', 'Robotics', 'Energy', 'Media', 'Retail', 'Freight', 'Analytics', 'Insurance'];
const OTHER_SUFFIX = ['Ventures', 'Capital', 'Partners', 'Advisory', 'Talent'];
const PRODUCTS = ['remote build cache', 'feature-flag service', 'observability agent', 'data pipeline testing tool', 'internal developer portal', 'CI flake detector'];
const PRINCIPAL_ROLES = ['founder and CEO', 'co-founder and CTO', 'founder and head of engineering', 'co-founder and staff engineer'];
const OTHER_ROLES = ['partner at', 'advisor from', 'recruiter at', 'principal at'];
/** Role pairs for a role correction: [stored (wrong), corrected]. Every role appears in one pair only. */
const ROLE_PAIRS: ReadonlyArray<[string, string]> = [
  ['Director of IT', 'VP of Procurement'], ['Head of Platform', 'Director of Infrastructure'], ['Engineering Manager', 'Head of Developer Productivity'],
  ['Head of Security', 'CISO'], ['Director of Operations', 'COO'], ['Senior Buyer', 'Procurement Lead'], ['Platform Architect', 'VP of Platform'],
  ['IT Manager', 'Director of Enterprise Systems'],
];
/** Roles for contacts without a role correction (never one of ROLE_PAIRS). */
const PLAIN_ROLES = ['Platform Lead', 'Head of Data', 'DevOps Manager', 'Director of Engineering', 'SRE Lead', 'Head of IT', 'Tooling Lead', 'Release Manager'];
const TOPICS = ['pricing review', 'pilot kickoff', 'security review', 'contract walkthrough', 'roadmap session', 'technical deep dive', 'renewal discussion', 'rollout planning call', 'design partner sync', 'procurement review'];
/** Commitment items: [phrase in prose, recognizing patterns]. */
const COMMITMENTS: ReadonlyArray<[string, string[]]> = [
  ['the SOC 2 bridge letter', ['soc ?2 bridge letter', 'bridge letter']],
  ['the revised statement of work', ['revised (?:statement of work|sow)', 'statement of work']],
  ['the migration runbook', ['migration runbook', 'runbook']],
  ['our benchmark results on their monorepo', ['benchmark results', 'benchmarks? (?:on|for|from) (?:their|your|the) monorepo']],
  ['the pricing one-pager', ['pricing one[- ]pager', 'one[- ]pager']],
  ['the security architecture diagram', ['architecture diagram']],
  ['the draft pilot success criteria', ['success criteria']],
  ['a sandbox account for their team', ['sandbox']],
  ['the updated order form', ['order form']],
  ['the customer reference list', ['reference list', 'list of (?:customer )?references']],
  ['the data processing addendum', ['data processing addendum', '\\bdpa\\b']],
  ['the uptime report for last quarter', ['uptime report']],
];
const DONE_ITEMS = ['security questionnaire', 'W-9 form', 'product roadmap deck', 'trial extension', 'invoice copy', 'onboarding checklist'];
const TIMES = ['09:30', '10:00', '11:00', '13:30', '14:00', '15:30', '16:00'];
const FILLER_LINES = [
  'Spent the morning on hiring loops; two strong backend candidates.', 'Board deck draft is in progress; numbers due Friday.', 'Ran the weekly metrics review with the team.',
  'Fixed the flaky integration test in the billing service.', 'Investor update went out; two replies asking about churn.', 'Customer support queue is under control this week.',
  'Need to renew the office lease before the end of the year.', 'Discussed the Q4 roadmap with the engineering leads.', 'Tried a new on-call rotation; feedback is mixed.',
  'Reviewed the SOC 2 audit timeline with our auditor.', 'Wrote the job description for a developer advocate.', 'Coffee chat about open-source licensing.',
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function slugify(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
export function addDays(iso: string, days: number) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
/** `Thursday, October 16`. */
export function humanDate(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Patterns for one calendar date in the forms an answer may use: October 21, Oct 21st, 21 October, 10/21, 2026-10-21. */
export function dateMatcher(iso: string): Matcher {
  const [, mm, dd] = iso.split('-');
  const m = Number(mm), d = Number(dd);
  const month = MONTHS[m - 1];
  const mon = `${month.slice(0, 3).toLowerCase()}(?:${month.slice(3).toLowerCase()})?\\.?`;
  const day = `0?${d}(?:st|nd|rd|th)?`;
  return {
    label: iso,
    patterns: [`\\b${mon}\\s+${day}\\b`, `\\b${day}\\s+(?:of\\s+)?${mon}(?![a-z])`, `\\b0?${m}/0?${d}\\b(?!/\\d{3})`, `\\b${iso}\\b`],
  };
}

/** Patterns for a seat count: `40 seats`, `40-seat`, `40 licenses`, `40 users`. */
export function seatsMatcher(n: number): Matcher {
  return { label: `${n} seats`, patterns: [`\\b${n}[- ]?(?:seats?|licen[cs]es?|users?)\\b`] };
}

/** Patterns for a per-seat price: `$22 per seat`, `$22/seat`, `$22 a seat`, `$22 per user per month`. */
export function priceMatcher(n: number): Matcher {
  return { label: `$${n} per seat`, patterns: [`\\$${n}(?:\\.00)?\\s*(?:/|per|a|each)\\s*(?:seat|user|licen[cs]e)`, `\\$${n}(?:\\.00)?\\s*(?:/|per)\\s*(?:seat|user)?\\s*(?:/|per)?\\s*(?:mo|month)`] };
}

export function roleMatcher(role: string): Matcher {
  const words = role.split(' ').map(escapeRe);
  const alts = [words.join('\\s+')];
  if (role.startsWith('VP ')) alts.push(['(?:vice\\s+president|v\\.p\\.)', ...words.slice(1)].join('\\s+'));
  if (role === 'CISO') alts.push('chief\\s+information\\s+security\\s+officer');
  if (role === 'COO') alts.push('chief\\s+operating\\s+officer');
  return { label: role, patterns: [`(?<![a-z])(?:${alts.join('|')})(?![a-z])`] };
}

// ─── World ──────────────────────────────────────────────────────────

interface Person { first: string; last: string; name: string; slug: string; company: string; companySlug: string; role: string }

export function generatePersona(seed: number): PPPersona {
  const rng = new Rng(seed);
  const usedNames = new Set<string>();
  const usedCompanies = new Set<string>();
  const company = (suffixes: readonly string[]) => draw(() => `${rng.pick(SYL_A)}${rng.pick(SYL_B)} ${rng.pick(suffixes)}`, c => !usedCompanies.has(c.split(' ')[0]), 'company names');
  const claimCompany = (c: string) => { usedCompanies.add(c.split(' ')[0]); return c; };

  const pFirst = rng.pick(FIRST), pLast = rng.pick(LAST);
  usedNames.add(`${pFirst} ${pLast}`);
  const startup = claimCompany(`${rng.pick(SYL_A)}${rng.pick(SYL_B)} Labs`);
  const principal = { name: `${pFirst} ${pLast}`, first: pFirst, role: rng.pick(PRINCIPAL_ROLES), company: startup, product: rng.pick(PRODUCTS) };
  const personaId = `p${seed}`;

  const usedFirst = new Set<string>([pFirst]);
  const person = (first: string, role: string, suffixes: readonly string[]): Person => {
    const last = draw(() => rng.pick(LAST), l => !usedNames.has(`${first} ${l}`) && l !== pLast, 'last names');
    const name = `${first} ${last}`;
    usedNames.add(name);
    const co = claimCompany(company(suffixes));
    return { first, last, name, slug: `people/${slugify(name)}`, company: co, companySlug: `companies/${slugify(co)}`, role };
  };

  // Task contacts and their namesakes.
  const kinds: TaskKind[] = rng.shuffle(Array.from({ length: TASKS_PER_PERSONA }, (_, i) => (i % 2 ? 'reply' : 'prep')));
  const rolePairs = rng.shuffle(ROLE_PAIRS);
  const plainRoles = rng.shuffle(PLAIN_ROLES);
  const commitments = rng.shuffle(COMMITMENTS);
  const topics = rng.shuffle(TOPICS);
  const usedDates = new Set<string>([PP_TODAY, PP_SESSION2_DAY]);
  const freshDate = (lo: number, hi: number) => draw(() => addDays(PP_TODAY, rng.int(lo, hi)), d => !usedDates.has(d) && ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()), 'meeting dates');
  const usedNumbers = new Set<number>();
  const freshNumber = (pool: readonly number[]) => draw(() => rng.pick(pool), n => !usedNumbers.has(n), 'figures');
  const SEAT_POOL = [12, 15, 18, 20, 24, 25, 30, 35, 40, 45, 48, 50, 60, 64, 75, 80, 90, 120, 150];
  const PRICE_POOL = [9, 11, 14, 16, 18, 19, 21, 22, 24, 26, 28, 29, 32, 35, 38, 42, 45];

  const docs: PPDoc[] = [];
  const tasks: PPTask[] = [];
  const allPeople: Person[] = [];
  const dailyMentions: string[] = [];

  for (let i = 0; i < TASKS_PER_PERSONA; i++) {
    const kind = kinds[i];
    const correction: CorrectionKind = kind === 'reply' ? (rng.int(0, 1) ? 'seats' : 'price') : rng.pick(['role', 'seats', 'price'] as const);
    const first = draw(() => rng.pick(FIRST), f => !usedFirst.has(f), 'first names');
    usedFirst.add(first);
    const [staleRole, correctedRole] = rolePairs[i];
    const contact = person(first, correction === 'role' ? staleRole : plainRoles[2 * i], CUSTOMER_SUFFIX);
    const namesake = person(first, plainRoles[2 * i + 1], CUSTOMER_SUFFIX);
    allPeople.push(contact, namesake);

    const time = rng.pick(TIMES);
    const oldIso = freshDate(2, 13); usedDates.add(oldIso);
    const newIso = draw(() => addDays(oldIso, rng.int(2, 9)), d => !usedDates.has(d) && ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()), 'new dates');
    usedDates.add(newIso);
    const nsIso = freshDate(2, 27); usedDates.add(nsIso);
    const topic = topics[i % topics.length];
    const nsTopic = topics[(i + TASKS_PER_PERSONA) % topics.length];

    const seats = freshNumber(SEAT_POOL); usedNumbers.add(seats);
    const price = freshNumber(PRICE_POOL); usedNumbers.add(price);
    const correctedSeats = correction === 'seats' ? draw(() => freshNumber(SEAT_POOL), n => n !== seats, 'seats') : seats; usedNumbers.add(correctedSeats);
    const correctedPrice = correction === 'price' ? draw(() => freshNumber(PRICE_POOL), n => n !== price, 'prices') : price; usedNumbers.add(correctedPrice);
    const nsSeats = freshNumber(SEAT_POOL); usedNumbers.add(nsSeats);
    const nsPrice = freshNumber(PRICE_POOL); usedNumbers.add(nsPrice);
    const [item, itemPatterns] = commitments[2 * i];
    const [nsItem, nsItemPatterns] = commitments[2 * i + 1];
    const done = rng.pick(DONE_ITEMS);

    const meetingId = `meetings/${oldIso}-${slugify(contact.company.split(' ')[0])}-${slugify(topic)}`;
    const nsMeetingId = `meetings/${nsIso}-${slugify(namesake.company.split(' ')[0])}-${slugify(nsTopic)}`;
    const dealId = `deals/${slugify(contact.company)}`;
    const nsDealId = `deals/${slugify(namesake.company)}`;
    const terms = (s: number, p: number) => `${s} seats at $${p} per seat per month`;

    docs.push(
      { id: contact.slug, title: contact.name, type: 'person', date: '2026-09-22', body: `# ${contact.name}\n\n${contact.name} is ${contact.role} at [[${contact.companySlug}|${contact.company}]]. ${first} is evaluating our ${principal.product} for their engineering team.\n\n## Current\n\n- Next meeting: ${topic} on ${humanDate(oldIso)} (${oldIso}) at ${time}. See [[${meetingId}]].\n- Deal: ${terms(seats, price)} (see [[${dealId}]]).\n- Done ${addDays(PP_TODAY, -12)}: sent ${first} the ${done}.\n\n## Timeline\n\n- ${addDays(PP_TODAY, -30)}: first call; intro through a mutual investor.\n- ${addDays(PP_TODAY, -12)}: sent the ${done}.\n` },
      { id: namesake.slug, title: namesake.name, type: 'person', date: '2026-09-25', body: `# ${namesake.name}\n\n${namesake.name} is ${namesake.role} at [[${namesake.companySlug}|${namesake.company}]]. Trialing our ${principal.product} on one team.\n\n## Current\n\n- Next meeting: ${nsTopic} on ${humanDate(nsIso)} (${nsIso}) at ${rng.pick(TIMES)}. See [[${nsMeetingId}]].\n- Deal: ${terms(nsSeats, nsPrice)} (see [[${nsDealId}]]).\n- Open: I owe ${first} ${nsItem}.\n` },
      { id: contact.companySlug, title: contact.company, type: 'company', date: '2026-09-22', body: `# ${contact.company}\n\nProspect for our ${principal.product}. Main contact: [[${contact.slug}|${contact.name}]] (${contact.role}).\n` },
      { id: namesake.companySlug, title: namesake.company, type: 'company', date: '2026-09-25', body: `# ${namesake.company}\n\nTrial customer. Contact: [[${namesake.slug}|${namesake.name}]].\n` },
      { id: dealId, title: `${contact.company} deal`, type: 'deal', date: '2026-10-01', body: `# ${contact.company} deal\n\nStage: proposal sent. Champion: [[${contact.slug}|${contact.name}]].\n\nTerms quoted: ${terms(seats, price)}, annual contract, billed quarterly.\n\nNext step: ${topic} on ${humanDate(oldIso)}.\n` },
      { id: nsDealId, title: `${namesake.company} deal`, type: 'deal', date: '2026-10-02', body: `# ${namesake.company} deal\n\nStage: trial. Contact: [[${namesake.slug}|${namesake.name}]].\n\nTerms discussed: ${terms(nsSeats, nsPrice)}.\n` },
      { id: meetingId, title: `${contact.company} ${topic}`, type: 'meeting', date: oldIso, body: `# ${contact.company} ${topic}\n\nWhen: ${humanDate(oldIso)} (${oldIso}), ${time}\nWith: [[${contact.slug}|${contact.name}]] (${contact.role})\n\nAgenda:\n- Walk through the quote (${terms(seats, price)}).\n- Rollout plan and timeline.\n` },
      { id: nsMeetingId, title: `${namesake.company} ${nsTopic}`, type: 'meeting', date: nsIso, body: `# ${namesake.company} ${nsTopic}\n\nWhen: ${humanDate(nsIso)} (${nsIso})\nWith: [[${namesake.slug}|${namesake.name}]]\n\nAgenda:\n- Trial results.\n- ${nsItem[0].toUpperCase()}${nsItem.slice(1)} (I owe this).\n` },
    );
    dailyMentions.push(`Quick sync with ${contact.name} confirmed the ${topic} for ${humanDate(oldIso)}; they are still looking at ${seats} seats.`);
    dailyMentions.push(`${namesake.name} (${namesake.company}) asked about ${nsSeats} seats; I owe ${namesake.first} ${nsItem}.`);

    const corrected = correction === 'role' ? roleMatcher(correctedRole) : correction === 'seats' ? seatsMatcher(correctedSeats) : priceMatcher(correctedPrice);
    const stale = correction === 'role' ? roleMatcher(staleRole) : correction === 'seats' ? seatsMatcher(seats) : priceMatcher(price);
    const correctionSentence = correction === 'role'
      ? `${first}'s title in my notes is wrong: ${first} is ${correctedRole}, not ${staleRole}.`
      : correction === 'seats'
        ? `the quote in my notes is wrong: it's ${correctedSeats} seats, not ${seats}.`
        : `the price in my notes is wrong: we quoted $${correctedPrice} per seat, not $${price}.`;
    const lines = rng.shuffle([
      `I promised ${first} I'd send ${item} before our ${topic}.`,
      `Our ${topic} moved from ${humanDate(oldIso)} to ${humanDate(newIso)}, same time.`,
      `Correction: ${correctionSentence}`,
    ]);
    const session1 = `Just got off a call with ${contact.name}. Please update my brain with this:\n${lines.map((l, k) => `${k + 1}. ${l}`).join('\n')}`;
    const session2 = kind === 'prep'
      ? `Prep me for my next meeting with ${contact.name}: who they are now, when we're meeting, where things stand, and anything I owe them.`
      : `${contact.name} just emailed me: "Hi ${principal.first}, looking forward to our ${topic}. Anything we should prepare on our side?" Draft my reply. Confirm when we're meeting, restate where things stand, and cover anything I owe them.`;

    const nsValues: Matcher[] = [
      { label: namesake.company, patterns: [`(?<![a-z])${escapeRe(namesake.company.split(' ')[0])}(?![a-z])`] },
      { ...dateMatcher(nsIso), label: `namesake meeting ${nsIso}` },
      { ...seatsMatcher(nsSeats), label: `namesake ${nsSeats} seats` },
      { ...priceMatcher(nsPrice), label: `namesake $${nsPrice} per seat` },
      { label: `namesake commitment: ${nsItem}`, patterns: nsItemPatterns },
    ];
    tasks.push({
      id: `${personaId}-t${i + 1}`, persona: personaId, seed, kind, correction_kind: correction, contact: contact.slug, contact_name: contact.name,
      session1, session2,
      gold: {
        commitment: { label: item, patterns: itemPatterns },
        date: { old: dateMatcher(oldIso), new: dateMatcher(newIso), old_iso: oldIso, new_iso: newIso, time },
        correction: { stale, corrected },
        namesake: nsValues,
        stale_docs: [contact.slug, dealId, meetingId],
      },
    });
  }

  // People who are not task contacts (investors, advisors, recruiters).
  for (let i = 0; i < OTHER_CONTACTS; i++) {
    const first = draw(() => rng.pick(FIRST), f => !usedFirst.has(f), 'first names');
    usedFirst.add(first);
    const rel = rng.pick(OTHER_ROLES);
    const p = person(first, rel.split(' ')[0][0].toUpperCase() + rel.split(' ')[0].slice(1), OTHER_SUFFIX);
    allPeople.push(p);
    docs.push(
      { id: p.slug, title: p.name, type: 'person', date: '2026-08-30', body: `# ${p.name}\n\n${p.name} is a ${rel} [[${p.companySlug}|${p.company}]].\n\n- Last spoke ${addDays(PP_TODAY, -rng.int(5, 40))}.\n` },
      { id: p.companySlug, title: p.company, type: 'company', date: '2026-08-30', body: `# ${p.company}\n\n${rel.startsWith('partner') || rel.startsWith('principal') ? 'Seed investor in our company.' : 'Works with us occasionally.'} Contact: [[${p.slug}|${p.name}]].\n` },
    );
    dailyMentions.push(`Caught up with ${p.name} about ${rng.pick(['the next raise', 'hiring', 'pricing strategy', 'a board seat', 'customer intros'])}.`);
  }

  docs.push({ id: `companies/${slugify(startup)}`, title: startup, type: 'company', date: '2026-01-10', body: `# ${startup}\n\nMy company. We build a ${principal.product} for engineering teams. I am ${principal.role}.\n` });

  // Daily notes carry the stale values among routine lines; filler notes add noise.
  const mentions = rng.shuffle(dailyMentions);
  const dailyDays = 6;
  for (let d = 0; d < dailyDays; d++) {
    const day = addDays(PP_TODAY, -(d + 1));
    const mine = mentions.filter((_, k) => k % dailyDays === d);
    docs.push({ id: `notes/daily/${day}`, title: `Daily note ${day}`, type: 'note', date: day, body: `# ${day}\n\n${[...mine, rng.pick(FILLER_LINES), rng.pick(FILLER_LINES)].map(l => `- ${l}`).join('\n')}\n` });
  }
  for (let f = 0; f < FILLER_NOTES; f++) {
    const day = addDays(PP_TODAY, -(dailyDays + 1 + f));
    const who = rng.pick(allPeople);
    docs.push({ id: `notes/daily/${day}`, title: `Daily note ${day}`, type: 'note', date: day, body: `# ${day}\n\n- ${rng.pick(FILLER_LINES)}\n- Emailed ${who.name} a short update on our roadmap.\n- ${rng.pick(FILLER_LINES)}\n` });
  }
  for (let k = 0; k < 2; k++) {
    const day = addDays(PP_TODAY, -(2 + 3 * k));
    const picks = rng.shuffle(allPeople).slice(0, 4);
    docs.push({ id: `inbox/${day}-digest`, title: `Inbox digest ${day}`, type: 'digest', date: day, body: `# Inbox digest ${day}\n\n${picks.map(p => `- ${p.name} (${p.company}): ${rng.pick(['following up on last week', 'sharing an article', 'asking for a quick call', 'confirming receipt'])}.`).join('\n')}\n` });
  }

  return { id: personaId, seed, principal, docs, tasks };
}

export function generateWorld(seeds: readonly number[] = PP_DEV_SEEDS): PPWorld {
  return { version: PP_GENERATOR_VERSION, today: PP_TODAY, session2_day: PP_SESSION2_DAY, personas: seeds.map(generatePersona) };
}

export function renderPPDoc(d: PPDoc): string {
  return `---\ntitle: ${JSON.stringify(d.title)}\ntype: ${d.type}\ndate: ${d.date}\n---\n${d.body}`;
}

export function worldDigest(w: PPWorld | PPPersona): string {
  return createHash('sha256').update(JSON.stringify(w)).digest('hex');
}

/**
 * Solvability and trap checks derived from the ledger alone: every stale value is present in the base brain
 * (so the update is needed), no corrected value or new date is (so session 1 is the only source), and the
 * namesake's values never collide with the task's.
 */
export function solvabilityProblems(p: PPPersona): string[] {
  const problems: string[] = [];
  const text = p.docs.map(d => d.body).join('\n');
  const hit = (m: { patterns: string[] }, s: string) => m.patterns.some(re => new RegExp(re, 'i').test(s));
  for (const t of p.tasks) {
    const g = t.gold;
    if (!hit(g.date.old, text)) problems.push(`${t.id}: old date absent from the base brain`);
    if (hit(g.date.new, text)) problems.push(`${t.id}: new date already in the base brain`);
    if (!hit(g.correction.stale, text)) problems.push(`${t.id}: stale value absent from the base brain`);
    if (hit(g.correction.corrected, text)) problems.push(`${t.id}: corrected value already in the base brain`);
    if (hit(g.commitment, p.docs.filter(d => d.id === t.contact).map(d => d.body).join('\n'))) problems.push(`${t.id}: commitment already on the contact page`);
    if (!hit(g.commitment, t.session1) || !hit(g.date.new, t.session1) || !hit(g.correction.corrected, t.session1)) problems.push(`${t.id}: session 1 does not state all three facts`);
    for (const m of [g.commitment, g.date.new, g.date.old, g.correction.corrected, g.correction.stale]) {
      if (hit(m, t.session2)) problems.push(`${t.id}: session 2 names ${m.label}`);
    }
    for (const ns of g.namesake) {
      const truthText = [t.session1, g.commitment.label, g.date.new.label, g.correction.corrected.label].join('\n');
      if (hit(ns, truthText)) problems.push(`${t.id}: namesake value ${ns.label} matches the truth`);
    }
  }
  return problems;
}

// ─── Sealed seed custody ────────────────────────────────────────────

export function sealedCommitment(seed: number): string {
  return createHash('sha256').update(`${SEALED_COMMITMENT_PREFIX}${seed}`).digest('hex');
}

/**
 * Custodian only: mint a random sealed seed into `dir` (outside this repository, file mode 0600) and return its
 * commitment. The caller prints only the commitment; the seed never enters the repository or a log.
 */
export function mintSealedSeed(dir: string): { path: string; commitment: string } {
  if (insideRepository(dir)) throw new Error('--custodian-out must be outside the repository: a sealed seed is never committed');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'program-primary-sealed-seed.json');
  if (existsSync(path)) throw new Error(`${path} exists; a sealed seed is minted once`);
  const seed = randomBytes(4).readUInt32BE(0);
  const commitment = sealedCommitment(seed);
  writeFileSync(path, JSON.stringify({ version: PP_GENERATOR_VERSION, seed, commitment, minted_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, commitment };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--mint-sealed')) {
    const dir = flag('--custodian-out');
    if (!dir) throw new Error('--mint-sealed needs --custodian-out <dir outside the repository>');
    const { commitment } = mintSealedSeed(resolve(dir));
    console.log(JSON.stringify({ commitment, note: 'record this commitment in the preregistration; the seed stays in custody' }));
  } else {
    const seeds = flag('--seeds')?.split(',').map(Number) ?? [...PP_DEV_SEEDS];
    const bad = seeds.filter(s => !PP_DEV_SEEDS.includes(s));
    if (bad.length) throw new Error(`only development seeds run here (${PP_DEV_SEEDS.join(', ')}); got ${bad.join(', ')}`);
    const world = generateWorld(seeds);
    const problems = world.personas.flatMap(solvabilityProblems);
    if (problems.length) throw new Error(`solvability: ${problems.join('; ')}`);
    const summary = { version: world.version, digest: worldDigest(world), personas: world.personas.length, docs: world.personas.reduce((n, p) => n + p.docs.length, 0), tasks: world.personas.reduce((n, p) => n + p.tasks.length, 0) };
    if (argv.includes('--check')) { console.log(JSON.stringify(summary)); process.exit(0); }
    const out = flag('--out');
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'world.json'), JSON.stringify(world, null, 1) + '\n'); }
    console.log(JSON.stringify(summary));
  }
}
