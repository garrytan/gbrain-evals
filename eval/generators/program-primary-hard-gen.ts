/**
 * Program primary, harder workload (T0b): seeded founder brains about 10x the
 * size of T0's, and two-session tasks whose facts live where a real brain
 * keeps them.
 *
 * Same target user and carrier as T0 (program-primary-gen.ts,
 * t0-program-primary.ts). What changes, per task (one customer company C):
 *
 *   no cue to look   session 2 is a reply or prep request that never says
 *                    "check my brain" and names no page; session 1 (knob
 *                    `session1`) is a chat about something else in which the
 *                    user mentions a promise in passing, with no request to
 *                    save it;
 *   several parties  the reply goes to C's champion A and "our procurement
 *                    lead" (unnamed), so it touches two people and a company;
 *                    A has a namesake (same first name) at another company and
 *                    C has a namesake company sharing its first word; notes
 *                    call C by its short code and people by nicknames;
 *   bigger brains    about 1,000 pages: people, companies, deals, meeting
 *                    notes, mail threads and daily notes (knob `scale`);
 *   correction       the meeting move arrives in a later mail thread and the
 *   elsewhere        corrected seat count or price in a later call note; the
 *                    person, deal and meeting pages keep the old values;
 *   hop commitment   one promise was made in a technical review note about C
 *                    whose attendees do not include A;
 *   time             a handoff mail dated before today says procurement moves
 *                    from one person to another "starting <date>"; the old
 *                    contact's page still says procurement lead.
 *
 * A failure is an unsupported or stale answer or action, or a missed
 * commitment (t0/score.ts `scoreItems`). Gold is drawn here; the brain is
 * rendered from it.
 *
 * Version 2 (`--knobs '{"unique_codes":true}'`, `V2_KNOBS`) draws company names so that every short code is unique
 * within a brain and is never an English word or a common abbreviation. Version 1 built codes from the name alone,
 * so two customers in one brain could share a code (`BRL`), and a note about either named neither: the workload, not
 * the memory, made those notes ambiguous (alias-stack report, 2026-10-09). Version 1 worlds are unchanged.
 *
 * Seeds. Development and fresh seeds are public. A custodian-sealed set is minted on the custodian's machine:
 * `--mint-sealed --personas N --custodian-out <dir>` writes N random seeds to a 0600 file outside the repository and
 * prints only their SHA-256 commitment; `--custodian-seeds <file> --out <dir>` renders the version 2 world from them
 * with persona ids `sealed-01`... and no seed in the world, and prints its digest. The world file never enters the
 * repository; the runner reads it with `--world`.
 *
 *   bun eval/generators/program-primary-hard-gen.ts [--seeds a,b] [--knobs '<json>'] [--out DIR] [--check]
 *   bun eval/generators/program-primary-hard-gen.ts --mint-sealed --personas 16 --custodian-out <dir outside the repository>
 *   bun eval/generators/program-primary-hard-gen.ts --custodian-seeds <file> [--out <dir outside the repository>] [--digest-only]
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { insideRepository } from '../runner/sealed-confirmation-lib.ts';
import {
  addDays, COMMITMENTS, CUSTOMER_SUFFIX, dateMatcher, DONE_ITEMS, draw, escapeRe, FILLER_LINES, FIRST, humanDate, LAST, OTHER_SUFFIX, PLAIN_ROLES,
  priceMatcher, PRINCIPAL_ROLES, PRODUCTS, renderPPDoc, Rng, seatsMatcher, slugify, SYL_A, SYL_B, TIMES, TOPICS, type Matcher, type PPDoc, type TaskKind,
} from './program-primary-gen.ts';

export const PPH_GENERATOR_VERSION = 'program-primary-hard-v1';
export const PPH_GENERATOR_VERSION_V2 = 'program-primary-hard-v2';
export const PPH_SEALED_COMMITMENT_PREFIX = 'program-primary-hard-sealed-seeds:v2:';
/** Development seeds: public worlds for building, calibration and the development baseline. */
export const PPH_DEV_SEEDS: readonly number[] = Array.from({ length: 16 }, (_, i) => 20261101 + i);
export const PPH_TODAY = '2026-10-14';
export const PPH_SESSION2_DAY = '2026-10-15';

/** Difficulty knobs. Calibration varies them on development seeds; the preregistration freezes one set. */
export interface HardKnobs {
  tasks_per_persona: number;
  /** passing: session 1 mentions a second promise in passing (no save request); explicit: asks to save it; none: no second promise. */
  session1: 'passing' | 'explicit' | 'none';
  /** Brain size multiplier: 1 is about 1,000 pages. */
  scale: number;
  /** The hop commitment (made in a review note about C that A did not attend) is required. */
  hop: boolean;
  /** The procurement contact is superseded by date (handoff mail). */
  supersession: boolean;
  /** Version 2: every company's short code is unique within the brain and not in CODE_STOPWORDS. Absent in version 1. */
  unique_codes?: true;
}
/**
 * Frozen by the T0b preregistration after calibration (docs/benchmarks/2026-10-08-program-primary-hard-preregistration.md):
 * round 1 (session1 `passing`) failed 18 of 18 because no reader saved a promise it was not asked to save; rounds 2
 * and 3 (session1 `explicit`) failed 15 of 36.
 */
export const DEFAULT_KNOBS: HardKnobs = { tasks_per_persona: 3, session1: 'explicit', scale: 1, hop: true, supersession: true };
/** Version 2: the frozen knobs plus unique short codes. */
export const V2_KNOBS: HardKnobs = { ...DEFAULT_KNOBS, unique_codes: true };
/**
 * Codes version 2 never draws: the reachable codes that are English words, common names or common business
 * abbreviations. Nobody's shorthand for one customer is "THE" or "CAC", and a reader could not tell such a code from
 * the word.
 */
export const CODE_STOPWORDS: ReadonlySet<string> = new Set([
  'BRA', 'CAC', 'CAL', 'CAM', 'CAP', 'CAR', 'CAT', 'DOC', 'DOE', 'DOM', 'DOT', 'FEE', 'ISA', 'ISP', 'JOE', 'MUM', 'NAP', 'NAV',
  'ONE', 'ORE', 'PRE', 'PRM', 'TEA', 'TEC', 'TEE', 'TEL', 'THE', 'VET', 'VOL', 'YAM', 'YAP', 'ZEE',
]);
/** A company's short code: the first two letters of its first word and the initial of its suffix. */
export const shortCode = (name: string): string => { const w = name.split(' '); return (w[0].slice(0, 2) + w[1][0]).toUpperCase(); };
/** Development seeds the calibration rounds used; the development baseline runs on the other eight. */
export const PPH_CALIBRATION_SEEDS: readonly number[] = [20261109, 20261110, 20261111, 20261112, 20261113, 20261114];
export const PPH_BASELINE_SEEDS: readonly number[] = PPH_DEV_SEEDS.slice(0, 8);
/**
 * Fresh development seeds for Candidate 1's fresh-seed check (preregistration amendment 3): drawn at random on
 * 2026-10-09 after Candidate 1's code was frozen, never used before. Public, so not a custodian-sealed set.
 */
export const PPH_FRESH_SEEDS_C1: readonly number[] = [306480323, 316602389, 384540222, 476843991, 615322188, 691467441, 731983881, 767687777];
/**
 * Fresh development seeds for the alias-stack check (preregistration amendment 4): drawn at random on 2026-10-09
 * 13:44 UTC after the measurement build (gbrain 9ac26bea) was frozen, never used before. Public, so not a custodian-sealed set.
 */
export const PPH_FRESH_SEEDS_ALIAS: readonly number[] = [124371926, 196299785, 253035751, 446884266, 500901660, 560317357, 746355681, 868827636];
/** Every seed the T0b runner and this generator's CLI accept. */
export const PPH_RUNNABLE_SEEDS: readonly number[] = [...PPH_DEV_SEEDS, ...PPH_FRESH_SEEDS_C1, ...PPH_FRESH_SEEDS_ALIAS];

export interface HardTask {
  id: string;
  persona: string;
  seed: number;
  kind: TaskKind;
  correction_kind: 'seats' | 'price';
  contact: string;
  contact_name: string;
  company: string;
  session1: string;
  session2: string;
  gold: {
    commitments: Matcher[];
    date: { old: Matcher; new: Matcher; old_iso: string; new_iso: string; time: string };
    corrections: Array<{ kind: 'terms' | 'superseded'; stale: Matcher; corrected: Matcher }>;
    namesake: Matcher[];
    /**
     * Version 2 (and `generateHardPersona(..., { owners: true })`): what names each side, for t0b-score-v2's owner
     * check. Last names, company names and codes only: the contact and the namesake share a first name by design.
     */
    owners?: { contact: string[]; namesake: string[] };
    /** Docs that carry the current values (the scripted oracle reads these; mutants remove some). */
    evidence: string[];
    /** Docs removed by the stale-correction mutant (the corrections never land). */
    correction_docs: string[];
    /** Docs removed by the forced-drop mutant (no item arrives): corrections, the hop note and the handoff. */
    item_docs: string[];
  };
}

export interface HardPersona {
  id: string;
  seed: number;
  knobs: HardKnobs;
  principal: { name: string; first: string; role: string; company: string; product: string };
  docs: PPDoc[];
  tasks: HardTask[];
}

export interface HardWorld { version: string; knobs: HardKnobs; today: string; session2_day: string; personas: HardPersona[] }

const PROCUREMENT_ROLES = ['Procurement Lead', 'Senior Buyer', 'Head of Procurement', 'Vendor Manager'];
const ENGINEER_ROLES = ['Staff Engineer', 'Platform Engineer', 'Senior SRE', 'Build Engineer', 'DevEx Engineer'];
const NICK: Record<string, string> = { Joaquin: 'Quin', Desmond: 'Des', Vikram: 'Vik', Matteo: 'Teo', Elodie: 'Elo', Rania: 'Ran', Tobin: 'Toby', Felix: 'Fee', Omari: 'Om', Idris: 'Id' };
const SESSION1_ASKS = [
  'Can you give me three subject lines for our launch email? Something punchy.',
  'Help me write a two-sentence bio for a conference speaker page.',
  'What are three good questions to ask a candidate for a founding designer role?',
  'Give me a short checklist for preparing a board deck.',
  'Suggest a name for our internal hackathon. Something fun.',
  'Draft a one-line LinkedIn post celebrating our tenth customer.',
];
const MAIL_SUBJECTS = ['Quick question', 'Following up', 'Invoice copy', 'Usage report', 'Webinar invite', 'Admin access', 'Docs feedback', 'Roadmap question', 'SSO setup', 'Training session', 'Status page', 'API limits', 'Billing contact', 'Seat true-up', 'Security questionnaire'];
const MAIL_LINES = [
  'Thanks for the quick turnaround last week.', 'Could you resend the docs link? I lost it.', 'Our team liked the last release.', 'No rush on this one.',
  'Can we find 15 minutes next week?', 'Looping in a colleague who asked about exports.', 'The dashboard was slow on Tuesday but it is fine now.',
  'We are reorganizing teams this quarter.', 'Happy to be a reference if useful.', 'Is there a sandbox we could try for another team?',
  'Our fiscal year planning starts soon.', 'Security asked about data retention.', 'We had a small outage unrelated to you.',
];
const NOTE_LINES = [
  'Walked through usage; numbers look stable.', 'They asked about SSO again.', 'Discussed roadmap at a high level.', 'Agreed to check in next month.',
  'Their champion is busy with a reorg.', 'Mentioned a competitor evaluation for one team.', 'Positive on the latest release.',
];

interface Person { first: string; last: string; name: string; slug: string; company: string; companySlug: string; alias: string; role: string; nick: string }
interface Company { name: string; slug: string; alias: string; first: string }

/**
 * Version 2 matches a namesake promise on its distinctive phrase only. Version 1's short patterns ("order form",
 * "sandbox", "reference list") also matched generic offers, filler mail and relayed maintenance notices, none of
 * which is a claim about the namesake (namesake diagnostic, 2026-10-10).
 */
export const NAMESAKE_STRICT: Record<string, string[]> = {
  'the SOC 2 bridge letter': ['soc ?2 bridge letter'],
  'the revised statement of work': ['revised (?:statement of work|sow)'],
  'the migration runbook': ['migration runbook'],
  'our benchmark results on their monorepo': ['benchmark results'],
  'the pricing one-pager': ['pricing one[- ]pager'],
  'the security architecture diagram': ['architecture diagram'],
  'the draft pilot success criteria': ['success criteria'],
  'a sandbox account for their team': ['sandbox account'],
  'the updated order form': ['updated order form'],
  'the customer reference list': ['customer reference list'],
  'the data processing addendum': ['data processing addendum', '\\bdpa\\b'],
  'the uptime report for last quarter': ['uptime report'],
};

const nameMatcher = (p: { first: string; last: string; nick: string }): Matcher => ({
  label: `${p.first} ${p.last}`,
  patterns: [`(?<![a-z])(?:${escapeRe(p.first)}|${escapeRe(p.nick)})(?![a-z])`],
});

export function generateHardPersona(seed: number, knobs: HardKnobs = DEFAULT_KNOBS, opts: { owners?: boolean } = {}): HardPersona {
  const rng = new Rng(seed);
  const personaId = `h${seed}`;
  const usedCo = new Set<string>();
  const usedCodes = new Set<string>();
  const codeOk = (c: string) => !knobs.unique_codes || (!usedCodes.has(shortCode(c)) && !CODE_STOPWORDS.has(shortCode(c)));
  const usedNames = new Set<string>();
  const pFirst = rng.pick(FIRST), pLast = rng.pick(LAST);
  usedNames.add(`${pFirst} ${pLast}`);
  const coName = (suffixes: readonly string[], first?: string) => draw(() => `${first ?? rng.pick(SYL_A) + rng.pick(SYL_B)} ${rng.pick(suffixes)}`, c => !usedCo.has(c) && (first !== undefined || ![...usedCo].some(u => u.split(' ')[0] === c.split(' ')[0])) && codeOk(c), 'company names');
  const company = (name: string): Company => {
    usedCo.add(name);
    usedCodes.add(shortCode(name));
    return { name, slug: `companies/${slugify(name)}`, alias: shortCode(name), first: name.split(' ')[0] };
  };
  const startup = company(coName(['Labs']));
  const principal = { name: `${pFirst} ${pLast}`, first: pFirst, role: rng.pick(PRINCIPAL_ROLES), company: startup.name, product: rng.pick(PRODUCTS) };
  const person = (c: Company, role: string, first?: string): Person => {
    const f = first ?? draw(() => rng.pick(FIRST), x => x !== pFirst, 'first names');
    const last = draw(() => rng.pick(LAST), l => !usedNames.has(`${f} ${l}`) && l !== pLast, 'last names');
    usedNames.add(`${f} ${last}`);
    return { first: f, last, name: `${f} ${last}`, slug: `people/${slugify(`${f} ${last}`)}`, company: c.name, companySlug: c.slug, alias: c.alias, role, nick: NICK[f] ?? f };
  };

  const docs: PPDoc[] = [];
  const doc = (d: PPDoc) => { if (docs.some(x => x.id === d.id)) throw new Error(`duplicate doc ${d.id}`); docs.push(d); };
  const nCustomers = Math.round(22 * knobs.scale);
  const customers: Array<{ c: Company; champion: Person; buyer: Person; eng: Person; seats: number; price: number }> = [];
  const SEATS = [12, 15, 18, 20, 24, 25, 30, 35, 40, 45, 48, 50, 55, 60, 64, 70, 75, 80, 90, 100, 120, 150];
  const PRICES = [9, 11, 12, 14, 16, 18, 19, 21, 22, 24, 26, 28, 29, 32, 35, 38, 42, 45];
  for (let i = 0; i < nCustomers; i++) {
    const c = company(coName(CUSTOMER_SUFFIX));
    customers.push({ c, champion: person(c, rng.pick(PLAIN_ROLES)), buyer: person(c, rng.pick(PROCUREMENT_ROLES)), eng: person(c, rng.pick(ENGINEER_ROLES)), seats: rng.pick(SEATS), price: rng.pick(PRICES) });
  }
  const others: Person[] = [];
  for (let i = 0; i < Math.round(8 * knobs.scale); i++) { const c = company(coName(OTHER_SUFFIX)); others.push(person(c, rng.pick(['Partner', 'Principal', 'Advisor', 'Recruiter']))); }

  // Task companies: the first `tasks` customers. Each gets a namesake company (same first word) and A a namesake person.
  const tasks: HardTask[] = [];
  const taskCos = customers.slice(0, knobs.tasks_per_persona);
  const usedDates = new Set<string>([PPH_TODAY, PPH_SESSION2_DAY]);
  const weekday = (d: string) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  const freshDate = (lo: number, hi: number, from = PPH_TODAY) => { const d = draw(() => addDays(from, rng.int(lo, hi)), x => !usedDates.has(x) && weekday(x), 'dates'); usedDates.add(d); return d; };
  const commitments = rng.shuffle(COMMITMENTS);
  const topics = rng.shuffle(TOPICS);
  const kinds: TaskKind[] = rng.shuffle(Array.from({ length: knobs.tasks_per_persona }, (_, i) => (i % 3 === 2 ? 'prep' : 'reply')));
  const usedFigures = new Set<number>();
  const fig = (pool: number[], not: number[] = []) => { const v = draw(() => rng.pick(pool), x => !usedFigures.has(x) && !not.includes(x), 'figures'); usedFigures.add(v); return v; };
  for (const tc of taskCos) { tc.seats = fig(SEATS); tc.price = fig(PRICES); }

  const taskMeta = taskCos.map((tc, i) => {
    const nsCo = company(coName(CUSTOMER_SUFFIX.filter(x => x[0] !== tc.c.name.split(' ')[1][0]), tc.c.first));
    const nsPerson = person(nsCo, rng.pick(PLAIN_ROLES), tc.champion.first);
    const newBuyer = person(tc.c, tc.buyer.role, draw(() => rng.pick(FIRST), f => ![pFirst, tc.champion.first, tc.buyer.first, tc.eng.first].includes(f), 'first names'));
    if (tc.buyer.first === tc.champion.first) tc.buyer = person(tc.c, tc.buyer.role, draw(() => rng.pick(FIRST), f => ![pFirst, tc.champion.first, newBuyer.first].includes(f), 'first names'));
    return { tc, nsCo, nsPerson, newBuyer, i };
  });
  for (const m of taskMeta) customers.push({ c: m.nsCo, champion: m.nsPerson, buyer: person(m.nsCo, rng.pick(PROCUREMENT_ROLES)), eng: person(m.nsCo, rng.pick(ENGINEER_ROLES)), seats: fig(SEATS), price: fig(PRICES) });

  const allPeople = [...customers.flatMap(c => [c.champion, c.buyer, c.eng]), ...others];
  const upcoming = new Map<string, { date: string; time: string; topic: string; id: string }>();
  for (const cu of customers) {
    const isTask = taskCos.includes(cu);
    const isNamesake = taskMeta.some(m => m.nsCo.slug === cu.c.slug);
    const topic = isTask ? topics[taskCos.indexOf(cu) % topics.length] : rng.pick(TOPICS);
    // Task and namesake meetings get dates no other task value uses; background meetings only avoid those.
    const date = isTask ? freshDate(3, 12) : isNamesake ? freshDate(2, 40) : draw(() => addDays(PPH_TODAY, rng.int(2, 60)), x => !usedDates.has(x) && weekday(x), 'dates');
    const time = rng.pick(TIMES);
    upcoming.set(cu.c.slug, { date, time, topic, id: `meetings/${date}-${slugify(cu.c.first)}-${slugify(topic)}` });
  }

  // Base pages: companies, people, deals, upcoming meetings.
  doc({ id: startup.slug, title: startup.name, type: 'company', date: '2026-01-10', body: `# ${startup.name}\n\nMy company. We build a ${principal.product} for engineering teams. I am ${principal.role}.\n` });
  for (const cu of customers) {
    const u = upcoming.get(cu.c.slug)!;
    const terms = `${cu.seats} seats at $${cu.price} per seat per month`;
    doc({ id: cu.c.slug, title: cu.c.name, type: 'company', date: '2026-08-01', body: `# ${cu.c.name}\n\nAlso called ${cu.c.alias} in my notes. Prospect for our ${principal.product}.\n\n- Champion: [[${cu.champion.slug}|${cu.champion.name}]] (${cu.champion.role})\n- Procurement: [[${cu.buyer.slug}|${cu.buyer.name}]] (${cu.buyer.role})\n- Engineering contact: [[${cu.eng.slug}|${cu.eng.name}]]\n- Deal: [[deals/${slugify(cu.c.name)}]]\n` });
    doc({ id: `deals/${slugify(cu.c.name)}`, title: `${cu.c.name} deal`, type: 'deal', date: '2026-09-28', body: `# ${cu.c.name} deal\n\nStage: proposal sent. Champion: [[${cu.champion.slug}|${cu.champion.name}]].\n\nTerms quoted: ${terms}, annual contract, billed quarterly.\n\nNext step: ${u.topic} on ${humanDate(u.date)} (${u.date}).\n` });
    doc({ id: u.id, title: `${cu.c.name} ${u.topic}`, type: 'meeting', date: u.date, body: `# ${cu.c.name} ${u.topic}\n\nWhen: ${humanDate(u.date)} (${u.date}), ${u.time}\nWith: [[${cu.champion.slug}|${cu.champion.name}]]\n\nAgenda:\n- Walk through the quote (${terms}).\n- Rollout plan and timeline.\n` });
    for (const p of [cu.champion, cu.buyer, cu.eng]) doc({ id: p.slug, title: p.name, type: 'person', date: '2026-08-15', body: `# ${p.name}\n\n${p.name}${p.nick !== p.first ? ` ("${p.nick}")` : ''} is ${p.role} at [[${p.companySlug}|${p.company}]].\n\n- First met ${addDays(PPH_TODAY, -rng.int(40, 150))}.\n` });
  }
  for (const p of others) {
    doc({ id: p.slug, title: p.name, type: 'person', date: '2026-07-01', body: `# ${p.name}\n\n${p.name} is a ${p.role.toLowerCase()} at [[${p.companySlug}|${p.company}]].\n` });
    doc({ id: p.companySlug, title: p.company, type: 'company', date: '2026-07-01', body: `# ${p.company}\n\nContact: [[${p.slug}|${p.name}]].\n` });
  }

  // Background: past meeting notes, routine mail, daily notes.
  const nMeet = Math.round(130 * knobs.scale), nMail = Math.round(460 * knobs.scale), nDaily = Math.round(150 * Math.min(1.5, knobs.scale));
  for (let i = 0; i < nMeet; i++) {
    const cu = rng.pick(customers);
    const day = addDays(PPH_TODAY, -rng.int(3, 160));
    const id = `meetings/${day}-${slugify(cu.c.first)}-checkin-${i}`;
    doc({ id, title: `${cu.c.alias} check-in`, type: 'meeting', date: day, body: `# ${cu.c.alias} check-in, ${day}\n\nAttendees: ${rng.pick([cu.champion, cu.eng, cu.buyer]).nick}, me.\n\n- ${rng.pick(NOTE_LINES)}\n- ${rng.pick(NOTE_LINES)}\n- Done: sent ${rng.pick(DONE_ITEMS)}.\n` });
  }
  for (let i = 0; i < nMail; i++) {
    const p = rng.pick(allPeople);
    const day = addDays(PPH_TODAY, -rng.int(1, 150));
    const subj = rng.pick(MAIL_SUBJECTS);
    doc({ id: `inbox/${day}-${slugify(p.last)}-${i}`, title: `${subj} (${p.name})`, type: 'note', date: day, body: `# ${subj}\n\nFrom: ${p.name} (${p.alias})\nDate: ${day}\n\n${rng.pick(MAIL_LINES)} ${rng.pick(MAIL_LINES)}\n` });
  }
  const dailyLines: Map<string, string[]> = new Map();
  for (let d = 1; d <= nDaily; d++) dailyLines.set(addDays(PPH_TODAY, -d), [rng.pick(FILLER_LINES), `Pinged ${rng.pick(allPeople).nick} at ${rng.pick(customers).c.alias} about ${rng.pick(['onboarding', 'pricing', 'the roadmap', 'SSO', 'a reference call'])}.`]);

  // Task facts.
  for (const { tc, nsCo, nsPerson, newBuyer, i } of taskMeta) {
    const A = tc.champion, C = tc.c, u = upcoming.get(C.slug)!;
    const nsCu = customers.find(x => x.c.slug === nsCo.slug)!;
    const nsU = upcoming.get(nsCo.slug)!;
    const nsPersonU = nsU;
    const correctionKind: 'seats' | 'price' = rng.int(0, 1) ? 'seats' : 'price';
    const newDate = draw(() => addDays(u.date, rng.int(2, 9)), d => !usedDates.has(d) && weekday(d), 'new dates');
    usedDates.add(newDate);
    const correctedSeats = correctionKind === 'seats' ? fig(SEATS, [tc.seats]) : tc.seats;
    const correctedPrice = correctionKind === 'price' ? fig(PRICES, [tc.price]) : tc.price;
    const [hopItem, hopPatterns] = commitments[3 * i];
    const [s1Item, s1Patterns] = commitments[3 * i + 1];
    const [nsItem, nsPatterns] = commitments[3 * i + 2];

    // The move, in a later mail thread (pages untouched).
    const moveDay = addDays(PPH_TODAY, -rng.int(2, 5));
    // Version 2 keys mail ids by company too: two champions can share a last name.
    const mailTag = knobs.unique_codes ? `${slugify(C.first)}-${slugify(A.last)}` : slugify(A.last);
    const moveId = `inbox/${moveDay}-${mailTag}-reschedule`;
    doc({ id: moveId, title: `Re: ${u.topic} (${A.name})`, type: 'note', date: moveDay, body: `# Re: ${u.topic}\n\nFrom: ${A.name} (${C.alias})\nDate: ${moveDay}\n\n> Could we push the ${u.topic} to ${humanDate(newDate)}? Same time works on our side.\n\nMe: Works for me, see you ${humanDate(newDate)}.\n` });
    // The correction, in a later call note.
    const callDay = addDays(PPH_TODAY, -rng.int(1, 4));
    const callId = `meetings/${callDay}-${slugify(C.first)}-call`;
    const corrLine = correctionKind === 'seats'
      ? `Scope: they need ${correctedSeats} seats, not ${tc.seats} (my earlier count was off). Price unchanged.`
      : `Pricing: the right number is $${correctedPrice} per seat; the $${tc.price} in the quote was a typo. Seat count unchanged.`;
    doc({ id: callId, title: `Call with ${C.alias}`, type: 'meeting', date: callDay, body: `# Call with ${C.alias}, ${callDay}\n\nAttendees: ${A.nick}, me.\n\n- ${rng.pick(NOTE_LINES)}\n- ${corrLine}\n- ${rng.pick(NOTE_LINES)}\n` });
    // The hop commitment, in a review about C that A did not attend.
    const hopDay = addDays(PPH_TODAY, -rng.int(6, 14));
    const hopId = `meetings/${hopDay}-${slugify(C.first)}-technical-review`;
    doc({ id: hopId, title: `${C.name} technical review`, type: 'meeting', date: hopDay, body: `# ${C.name} technical review, ${hopDay}\n\nAttendees: ${tc.eng.nick} (${C.alias} engineering), me.\n\n- Went through their CI setup.\n- Done: sent ${rng.pick(DONE_ITEMS)}.\n\nAction items:\n- Me: send ${C.alias} ${hopItem} before the ${u.topic}.\n` });
    // Procurement handoff by date.
    const handoffDay = addDays(PPH_TODAY, -rng.int(18, 24));
    const startDay = addDays(PPH_TODAY, -rng.int(5, 10));
    const handoffId = `inbox/${handoffDay}-${mailTag}-procurement-handoff`;
    doc({ id: handoffId, title: `Procurement contact change (${A.name})`, type: 'note', date: handoffDay, body: `# Procurement contact change\n\nFrom: ${A.name} (${C.alias})\nDate: ${handoffDay}\n\nHeads up: starting ${humanDate(startDay)}, ${newBuyer.name} takes over vendor procurement from ${tc.buyer.nick}, who is moving to our platform team.\n` });
    // Namesake: A's namesake at the namesake company, with their own promise in a daily note.
    const lines = dailyLines.get(addDays(PPH_TODAY, -rng.int(2, 8)))!;
    lines.push(`${nsPerson.name} (${nsCo.alias}) asked about ${nsCu.seats} seats; I owe ${nsPerson.nick} ${nsItem}.`);

    const terms = (s: number, p: number) => correctionKind === 'seats' ? seatsMatcher(s) : priceMatcher(p);
    const session1 = knobs.session1 === 'none'
      ? `${rng.pick(SESSION1_ASKS)}`
      : knobs.session1 === 'passing'
        ? `${rng.pick(SESSION1_ASKS)} Also, on my call with ${A.nick} earlier I said I'd send over ${s1Item}.`
        : `${rng.pick(SESSION1_ASKS)} Also, please note in my brain that I promised ${A.name} I'd send ${s1Item}.`;
    const kind = kinds[i];
    const session2 = kind === 'reply'
      ? `${A.name} emailed me: "Hi ${principal.first}, quick one before our ${u.topic}: can you confirm when we're meeting, where the numbers landed, and what we're still waiting on from you? I've looped in our procurement lead." Draft my reply to both of them.`
      : `I have a call with ${A.nick} from ${C.alias} and their procurement lead coming up. Prep me: when it is, who I'm talking to, where the numbers are, and what I owe them.`;
    const commitmentsGold: Matcher[] = [];
    if (knobs.hop) commitmentsGold.push({ label: hopItem, patterns: hopPatterns });
    if (knobs.session1 !== 'none') commitmentsGold.push({ label: s1Item, patterns: s1Patterns });
    const corrections: HardTask['gold']['corrections'] = [{ kind: 'terms', stale: terms(tc.seats, tc.price), corrected: terms(correctedSeats, correctedPrice) }];
    if (knobs.supersession) corrections.push({ kind: 'superseded', stale: nameMatcher(tc.buyer), corrected: nameMatcher(newBuyer) });
    tasks.push({
      id: `${personaId}-t${i + 1}`, persona: personaId, seed, kind, correction_kind: correctionKind, contact: A.slug, contact_name: A.name, company: C.name,
      session1, session2,
      gold: {
        commitments: commitmentsGold,
        date: { old: dateMatcher(u.date), new: dateMatcher(newDate), old_iso: u.date, new_iso: newDate, time: u.time },
        corrections,
        namesake: [
          { ...dateMatcher(nsPersonU.date), label: `namesake meeting ${nsPersonU.date}` },
          { ...seatsMatcher(nsCu.seats), label: `namesake ${nsCu.seats} seats` },
          { ...priceMatcher(nsCu.price), label: `namesake $${nsCu.price} per seat` },
          { label: `namesake commitment: ${nsItem}`, patterns: knobs.unique_codes ? NAMESAKE_STRICT[nsItem] : nsPatterns },
        ],
        ...(knobs.unique_codes || opts.owners ? { owners: { contact: [A.last, C.name, C.alias], namesake: [nsPerson.last, nsCo.name, nsCo.alias] } } : {}),
        evidence: [A.slug, C.slug, `deals/${slugify(C.name)}`, u.id, moveId, callId, hopId, handoffId],
        correction_docs: [moveId, callId, handoffId],
        item_docs: [moveId, callId, hopId, handoffId],
      },
    });
    if (!knobs.hop) docs.splice(docs.findIndex(d => d.id === hopId), 1);
    if (!knobs.supersession) docs.splice(docs.findIndex(d => d.id === handoffId), 1);
  }
  for (const [day, lines] of dailyLines) doc({ id: `notes/daily/${day}`, title: `Daily note ${day}`, type: 'note', date: day, body: `# ${day}\n\n${rng.shuffle(lines).map(l => `- ${l}`).join('\n')}\n` });
  return { id: personaId, seed, knobs, principal, docs, tasks };
}

export function generateHardWorld(seeds: readonly number[] = PPH_DEV_SEEDS, knobs: HardKnobs = DEFAULT_KNOBS): HardWorld {
  return { version: knobs.unique_codes ? PPH_GENERATOR_VERSION_V2 : PPH_GENERATOR_VERSION, knobs, today: PPH_TODAY, session2_day: PPH_SESSION2_DAY, personas: seeds.map(s => generateHardPersona(s, knobs)) };
}

/** A world rendered from custodian seeds: persona ids `sealed-01`... and no seed anywhere in it. */
export interface CustodianWorld extends HardWorld { custodian: true; commitment: string }

export function sealedSeedsCommitment(seeds: readonly number[]): string {
  return createHash('sha256').update(`${PPH_SEALED_COMMITMENT_PREFIX}${seeds.join(',')}`).digest('hex');
}

/** Custodian only: mint `personas` random seeds into a 0600 file in `dir` (outside this repository) and return their commitment. */
export function mintSealedSeeds(dir: string, personas: number): { path: string; commitment: string } {
  if (insideRepository(dir)) throw new Error('--custodian-out must be outside the repository: sealed seeds are never committed');
  if (!Number.isInteger(personas) || personas < 1) throw new Error('--personas must be a positive integer');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 't0b-sealed-seeds.json');
  if (existsSync(path)) throw new Error(`${path} exists; a sealed set is minted once`);
  const seeds = new Set<number>();
  // About 1 seed in 300 cannot place its dates and throws; such a seed is redrawn before the commitment exists.
  const renders = (s: number) => { try { return hardSolvabilityProblems(generateHardPersona(s, V2_KNOBS)).length === 0; } catch { return false; } };
  while (seeds.size < personas) { const s = randomBytes(4).readUInt32BE(0); if (!PPH_RUNNABLE_SEEDS.includes(s) && renders(s)) seeds.add(s); }
  const commitment = sealedSeedsCommitment([...seeds]);
  writeFileSync(path, JSON.stringify({ version: PPH_GENERATOR_VERSION_V2, seeds: [...seeds], commitment, minted_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, commitment };
}

/** Render the version 2 world from custodian seeds, with every seed removed and personas renamed in order. */
export function custodianWorld(seeds: readonly number[]): CustodianWorld {
  const w = generateHardWorld(seeds, V2_KNOBS);
  const personas = w.personas.map((p, k) => {
    const id = `sealed-${String(k + 1).padStart(2, '0')}`;
    return { ...p, id, seed: 0, tasks: p.tasks.map(t => ({ ...t, id: t.id.replace(p.id, id), persona: id, seed: 0 })) };
  });
  return { ...w, personas, custodian: true, commitment: sealedSeedsCommitment(seeds) };
}

export const renderHardDoc = renderPPDoc;
export function hardDigest(w: HardWorld | HardPersona): string { return createHash('sha256').update(JSON.stringify(w)).digest('hex'); }

/** Ledger-only checks: stale values present in the base brain, current values only in the item docs or session 1, session 2 names none of them. */
export function hardSolvabilityProblems(p: HardPersona): string[] {
  const problems: string[] = [];
  const hit = (m: { patterns: string[] }, s: string) => m.patterns.some(re => new RegExp(re, 'i').test(s));
  const byId = new Map(p.docs.map(d => [d.id, d.body]));
  for (const t of p.tasks) {
    const g = t.gold;
    const pages = [t.contact, `deals/${slugify(t.company)}`].map(id => byId.get(id) ?? '').join('\n');
    if (!hit(g.date.old, pages)) problems.push(`${t.id}: old date not on the deal page`);
    if (hit(g.date.new, pages)) problems.push(`${t.id}: new date already on a page`);
    for (const id of g.evidence) if (!byId.has(id) && !(id.includes('technical-review') && !p.knobs.hop) && !(id.includes('handoff') && !p.knobs.supersession)) problems.push(`${t.id}: evidence ${id} missing`);
    const items = g.item_docs.map(id => byId.get(id) ?? '').join('\n');
    if (!hit(g.date.new, items)) problems.push(`${t.id}: new date absent from the move thread`);
    for (const c of g.corrections) if (!hit(c.corrected, items)) problems.push(`${t.id}: corrected ${c.corrected.label} absent from item docs`);
    if (hit(g.corrections[0].corrected, pages)) problems.push(`${t.id}: corrected value already on a page`);
    for (const m of [...g.commitments, g.date.new, g.date.old, ...g.corrections.flatMap(c => [c.corrected, c.stale])]) if (hit(m, t.session2)) problems.push(`${t.id}: session 2 names ${m.label}`);
  }
  return problems;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--mint-sealed')) {
    const dir = flag('--custodian-out');
    if (!dir) throw new Error('--mint-sealed needs --custodian-out <dir outside the repository>');
    const { commitment } = mintSealedSeeds(resolve(dir), Number(flag('--personas') ?? 16));
    console.log(JSON.stringify({ commitment, note: 'record this commitment in the preregistration; the seeds stay in custody' }));
    process.exit(0);
  }
  const custody = flag('--custodian-seeds');
  if (custody) {
    const file = JSON.parse(readFileSync(resolve(custody), 'utf8')) as { version: string; seeds: number[]; commitment: string };
    if (file.version !== PPH_GENERATOR_VERSION_V2 || sealedSeedsCommitment(file.seeds) !== file.commitment) throw new Error('custodian seed file does not match its commitment or version');
    const world = custodianWorld(file.seeds);
    const problems = world.personas.flatMap(hardSolvabilityProblems);
    if (problems.length) throw new Error(`solvability: ${problems.join('; ')}`);
    const out = flag('--out');
    if (out && !argv.includes('--digest-only')) {
      if (insideRepository(resolve(out))) throw new Error('--out must be outside the repository: a sealed world is never committed');
      mkdirSync(out, { recursive: true, mode: 0o700 });
      writeFileSync(join(out, 'world.json'), JSON.stringify(world) + '\n', { mode: 0o600 });
    }
    console.log(JSON.stringify({ version: world.version, knobs: world.knobs, commitment: world.commitment, digest: hardDigest(world), personas: world.personas.length, tasks: world.personas.reduce((n, p) => n + p.tasks.length, 0) }));
    process.exit(0);
  }
  const seeds = flag('--seeds')?.split(',').map(Number) ?? [...PPH_DEV_SEEDS];
  const bad = seeds.filter(s => !PPH_RUNNABLE_SEEDS.includes(s));
  if (bad.length) throw new Error(`only development seeds run here; got ${bad.join(', ')}`);
  const world = generateHardWorld(seeds, { ...DEFAULT_KNOBS, ...(flag('--knobs') ? JSON.parse(flag('--knobs')!) : {}) });
  const problems = world.personas.flatMap(hardSolvabilityProblems);
  if (problems.length) throw new Error(`solvability: ${problems.join('; ')}`);
  const summary = { version: world.version, knobs: world.knobs, digest: hardDigest(world), personas: world.personas.length, docs_per_persona: world.personas.map(p => p.docs.length), tasks: world.personas.reduce((n, p) => n + p.tasks.length, 0) };
  const out = flag('--out');
  if (out && !argv.includes('--check')) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'world.json'), JSON.stringify(world, null, 1) + '\n'); }
  console.log(JSON.stringify(summary));
}
