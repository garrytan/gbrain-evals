/**
 * Cat 40 Hard renderers: the prose of every Hard document, from ledger
 * values chosen elsewhere. Nothing here decides a fact. Each function gets
 * its own seeded stream (one per document), so bodies render the same in any
 * order. The sealed validation variant writes its own renderers; it shares
 * only schema.ts.
 */
import { longDate, type Rng } from './rng.ts';

export const FIRST = ['Mira', 'Tobin', 'Ines', 'Dario', 'Kenji', 'Lena', 'Arjun', 'Selma', 'Ruben', 'Noor', 'Calla', 'Yusuf', 'Petra', 'Omari', 'Hana', 'Felix', 'Zara', 'Emil', 'Priya', 'Teo', 'Wren', 'Idris', 'Maren', 'Joaquin', 'Suki', 'Bram', 'Lior', 'Anouk', 'Desmond', 'Ilse', 'Kofi', 'Rania', 'Soren', 'Talia', 'Vikram', 'Elodie', 'Matteo', 'Ayla', 'Niko', 'Odette'];
/** First names used only for people at appended (50k) accounts, so they never equal a 4k person. */
export const FIRST_LARGE = ['Alba', 'Bastian', 'Cosima', 'Dmitri', 'Esme', 'Florin', 'Greta', 'Hugo', 'Ione', 'Jasper', 'Kaia', 'Leif', 'Maeve', 'Nils', 'Ottilie', 'Pavel', 'Quinn', 'Rosalind', 'Stellan', 'Thea', 'Ulrich', 'Vera', 'Willem', 'Xenia', 'Yannick', 'Zelda', 'Amias', 'Brisa', 'Cyrus', 'Dagny', 'Elio', 'Fenna', 'Gideon', 'Halle', 'Ivo', 'Juno', 'Kasimir', 'Linnea', 'Mattias', 'Nadja'];
export const LAST = ['Okafor', 'Lindqvist', 'Marchetti', 'Haddad', 'Nakashima', 'Brandt', 'Mehta', 'Kowalczyk', 'Ferreira', 'Aziz', 'Delacroix', 'Osei', 'Varga', 'Thorne', 'Ishikawa', 'Morales', 'Petrov', 'Quist', 'Rahman', 'Sato', 'Torvik', 'Udeh', 'Valdez', 'Wexler', 'Yilmaz', 'Zeller', 'Abara', 'Bellweather', 'Castellan', 'Draxler', 'Eskildsen', 'Fairbourne', 'Galloway', 'Holmgren', 'Ivers', 'Jaramillo'];
export const SYL_A = ['Quor', 'Tel', 'Ves', 'Ondr', 'Pral', 'Kest', 'Mur', 'Zel', 'Bran', 'Cael', 'Dov', 'Fen', 'Gral', 'Hyd', 'Isk', 'Jor', 'Lum', 'Nax', 'Orv', 'Thal', 'Ulm', 'Vor', 'Wyn', 'Xer', 'Yar'];
export const SYL_B = ['vane', 'miro', 'tiva', 'ellis', 'onex', 'adyn', 'ura', 'ithe', 'oria', 'quent', 'ostra', 'ivel', 'anta', 'esso', 'umbr', 'ari', 'ovik', 'enza', 'alto', 'ique'];
export const SUFFIX = ['Systems', 'Health', 'Logistics', 'Labs', 'Foods', 'Capital', 'Robotics', 'Energy', 'Media', 'Retail'];
/** Generator v2: an account's industry, from the suffix of its first name; with the region it forms the manager-form descriptor. */
export const INDUSTRY: Record<string, string> = { Systems: 'software', Health: 'healthcare', Logistics: 'freight', Labs: 'research', Foods: 'food', Capital: 'finance', Robotics: 'automation', Energy: 'utilities', Media: 'publishing', Retail: 'consumer' };
/** Generator v2 nicknames: one word from each list. No word is a prefix of another, and none appears in any other template. */
export const NICK_A = ['Amber', 'Basalt', 'Cobalt', 'Driftwood', 'Ember', 'Flint', 'Garnet', 'Hazel', 'Indigo', 'Jonquil', 'Kestrel', 'Lichen', 'Maple', 'Nectar', 'Obsidian', 'Pewter', 'Quartz', 'Russet', 'Saffron', 'Tundra', 'Umber', 'Velvet', 'Walnut', 'Yarrow', 'Zinc', 'Alder', 'Bramble', 'Cinder', 'Dune', 'Ebony', 'Fennel', 'Glacier', 'Heather', 'Ivory', 'Juniper', 'Kelp', 'Larch', 'Mica', 'Nutmeg', 'Ochre', 'Pumice', 'Quince', 'Rowan', 'Sorrel', 'Thistle', 'Vermilion', 'Willow', 'Agate', 'Birch', 'Clover', 'Damask', 'Ermine', 'Fjord', 'Gossamer', 'Hemlock', 'Iris', 'Jade', 'Kumquat', 'Lupine', 'Marigold', 'Nimbus', 'Opal', 'Pinyon', 'Raven'];
export const NICK_B = ['Heron', 'Lantern', 'Anvil', 'Badger', 'Compass', 'Dynamo', 'Falcon', 'Gazebo', 'Harbor', 'Igloo', 'Jackal', 'Kiln', 'Lynx', 'Marmot', 'Narwhal', 'Otter', 'Pelican', 'Quokka', 'Rudder', 'Sextant', 'Tapir', 'Urchin', 'Vulture', 'Walrus', 'Yak', 'Zeppelin', 'Abacus', 'Beacon', 'Caravan', 'Dolphin', 'Easel', 'Ferret', 'Gondola', 'Hammock', 'Ibis', 'Jetty', 'Koala', 'Lemur', 'Mongoose', 'Nautilus', 'Ocelot', 'Puffin', 'Quiver', 'Raccoon', 'Sparrow', 'Toucan', 'Unicorn', 'Viaduct', 'Wombat', 'Xylophone', 'Yurt', 'Zebra', 'Albatross', 'Bison', 'Condor', 'Dingo', 'Egret', 'Flamingo', 'Gecko', 'Hornet', 'Iguana', 'Jaguar', 'Kayak', 'Lobster'];
export const SEGMENTS = ['enterprise', 'mid-market', 'growth'];
export const REGIONS = ['North America', 'EMEA', 'APAC', 'LATAM'];

const ROUTINE_SUBJECTS = ['Quarterly check-in', 'Question about exports', 'Scheduling the training session', 'Feature request: bulk edit', 'Invoice copy request', 'Dashboard loading slowly', 'New admin user', 'Webinar invite follow-up', 'Roadmap preview', 'Usage report for last month', 'Security questionnaire', 'Office hours signup', 'API key rotation', 'Holiday support coverage', 'Survey results'];
const ROUTINE_LINES = [
  'Thanks for the quick turnaround on this.', 'Payment questions should go through the usual invoice process.', 'They asked again about the uptime numbers on the status page.',
  'Their admin wants a refresher on permissions.', 'Usage dipped last month, which is normal for them.', 'The champion mentioned a reorg but no details yet.',
  'They are evaluating another vendor for one team.', 'Can we get the slides from last week?', 'I will circle back once I hear from their IT team.',
  'They liked the new reporting templates.', 'Please loop in support if this comes up again.', 'No action needed from our side for now.',
  'They want to bring two more teams onto the platform next year.', 'The integration with their data warehouse is working again.',
];
const TRANSCRIPT_LINES = [
  'Let me share my screen so everyone can see the usage chart.', 'Can you hear me okay? I think my audio cut out for a second.', 'We pulled the numbers from last quarter and they look roughly flat.',
  'I want to make sure we cover the training plan before we run out of time.', 'Our team has been asking for better export options.', 'Okay, moving on to the next item on the agenda.',
  'That is a good question, I will need to check with our product team.', 'We had a couple of support tickets but they were resolved quickly.', 'The dashboard has been faster since the last release.',
  'I can send the slides after the call.', 'Our fiscal year starts in February, so planning happens in December.', 'We are still rolling it out to the European office.',
  'Has anyone looked at the new reporting templates?', 'I think the integration with the data warehouse is the main thing people use.', 'Let us table that and come back to it next time.',
  'Security asked for the latest penetration test summary.', 'We would like to add a few more admins next month.', 'The onboarding sessions went well, people liked the recordings.',
  'I do not have the contract in front of me, but legal can confirm.', 'Can we schedule a follow-up for the week after next?', 'There was some confusion about who approves new seats.',
  'We should loop in procurement before any changes.', 'Honestly the mobile app is not a priority for us this year.', 'Thanks everyone, this was helpful.',
  'Can someone take notes for the action items?', 'We are hiring for two analyst roles this quarter.', 'Our CFO wants a summary of value delivered before planning.',
];
const BOILERPLATE = [
  'Each party shall maintain the confidentiality of the other party\'s Confidential Information using at least reasonable care.',
  'Notices under this agreement shall be in writing and delivered to the addresses on the signature page.',
  'Neither party shall be liable for delays caused by events beyond its reasonable control, including natural disasters and network outages of third parties.',
  'The customer shall not reverse engineer, decompile or disassemble the service except to the extent applicable law permits.',
  'This agreement is governed by the laws of the State of Delaware, without regard to its conflict of laws rules.',
  'Any dispute shall first be escalated to senior executives of both parties, who shall meet within fifteen business days.',
  'The provider shall maintain an information security program with administrative, physical and technical safeguards.',
  'Personal data is processed in accordance with the Data Processing Addendum, which forms part of this agreement.',
  'The customer may export its data in a standard format at any time during the term and for thirty days after.',
  'Sections on confidentiality, limitation of liability and governing law survive termination of this agreement.',
  'Support requests are handled according to the support policy published at the time the request is made.',
  'Invoices are issued in U.S. dollars and exclude applicable taxes, which the customer pays.',
];

export const TERM_LABELS: Record<string, string> = { seats: 'licensed seats', payment_terms: 'payment terms', liability_cap: 'liability cap', uptime_sla: 'uptime SLA', renewal_date: 'renewal date' };

export function frontmatterless(title: string, lines: string[]) { return [`# ${title}`, ...lines].join('\n\n'); }

/** "Name (CODE)" for a record that names its account; the single reference text otherwise (generator v2 passes one text as both). */
export function both(name: string, code: string) { return name === code ? name : `${name} (${code})`; }

export function transcript(rng: Rng, speakers: string[], planted: string[], minLines: number, maxLines: number): string {
  const n = rng.int(minLines, maxLines);
  const lines = Array.from({ length: n }, () => `${rng.pick(speakers)}: ${rng.pick(TRANSCRIPT_LINES)}`);
  for (const p of planted) lines.splice(rng.int(Math.floor(n * 0.3), Math.floor(n * 0.8)), 0, `${speakers[0]}: ${p}`);
  return lines.join('\n');
}

export function routineEmail(rng: Rng, o: { from: string; date: string; ref: string }): { subject: string; body: string } {
  const subject = rng.pick(ROUTINE_SUBJECTS);
  const lines = rng.shuffle(ROUTINE_LINES).slice(0, rng.int(2, 4));
  return { subject, body: `From: ${o.from}\nDate: ${o.date}\nSubject: ${subject} (${o.ref})\n\nHi team,\n\n${lines.join(' ')}\n\nBest,\n${o.from}` };
}

export function routineMeeting(rng: Rng, o: { title: string; date: string; speakers: string[]; minLines: number; maxLines: number }): string {
  return `# ${o.title}\n\nDate: ${o.date}. Attendees: ${o.speakers.join(', ')}.\n\n## Transcript\n\n${transcript(rng, o.speakers, [], o.minLines, o.maxLines)}`;
}

export function contractBody(o: { name: string; code: string; segment: string; region: string; signed: string; renewal: string; terms: Record<string, string>; champion: string; acmeSigner: string }): string {
  return frontmatterless(`Master Services Agreement: Acme Example Inc. and ${o.name}`, [
    `Status: Executed. Countersigned by both parties on ${longDate(o.signed)}.`,
    `Customer: ${o.name === o.code ? o.name : `${o.name} (account code ${o.code})`}. Segment: ${o.segment}. Region: ${o.region}.`,
    `Initial term: ${longDate(o.signed)} through ${longDate(o.renewal)}. Renewal date: ${o.renewal}.`,
    `Payment terms: ${o.terms.payment_terms}. Licensed seats: ${o.terms.seats}. Uptime SLA: ${o.terms.uptime_sla}. Liability cap: ${o.terms.liability_cap}.`,
    `Signed for ${o.name}: ${o.champion} (customer champion). Signed for Acme Example Inc.: ${o.acmeSigner}.`,
  ]);
}

export function crmBody(o: { name: string; code: string; segment: string; region: string; owner: string; asOf: string; champion: string; billing: string; aliases: string[] }): string {
  return frontmatterless(`CRM record: ${o.name}`, [
    `Account: ${o.name}. Account code: ${o.code}.${o.aliases.length ? ` Also known as: ${o.aliases.join('; ')}.` : ''}`,
    `Segment: ${o.segment}. Region: ${o.region}.`,
    `Account owner: ${o.owner} (as of ${o.asOf}). Champion: ${o.champion}. Billing contact: ${o.billing}.`,
    'Owner changes after the date above are announced by email and are not reflected in this record until the next sync.',
  ]);
}

/** Generator v2: the resolution document that introduces an account's nickname and descriptor. */
export function accountSheetBody(o: { name: string; nickname: string; industry: string; region: string; descriptor: string }): string {
  return frontmatterless(`Account sheet: ${o.name}`, [
    `Account: ${o.name}. Nickname used by the team: ${o.nickname}. Industry: ${o.industry}. Region: ${o.region}.`,
    `In notes and tickets the team also calls it "${o.nickname}", or "the ${o.descriptor} account" together with its account manager on that date (for example "<manager>'s ${o.descriptor} account").`,
    'Account manager changes are announced in handoff notes; the CRM record holds the account code and the first account owner.',
  ]);
}

/** A long executed document: boilerplate clauses with the deciding clause placed mid-document. */
export function longExecuted(rng: Rng, head: string[], deciding: string, minChars: number): string {
  const clauses: string[] = [];
  let n = 0;
  while (clauses.join('\n\n').length < minChars) clauses.push(`${++n}. ${rng.pick(BOILERPLATE)} ${rng.pick(BOILERPLATE)}`);
  const at = Math.floor(clauses.length * (0.4 + rng.float() * 0.3));
  clauses.splice(at, 0, `${at + 1}a. ${deciding}`);
  return [...head, '## Terms', ...clauses].join('\n\n');
}

export function ticketBody(o: { id: string; ref: string; topic: string; log: Array<[string, string]> }): string {
  return frontmatterless(`${o.id}: ${o.topic}`, [`Customer: ${o.ref}.`, '## Status log', o.log.map(([d, s]) => `- ${d}: ${s}`).join('\n')]);
}

export function teamUpdateBody(rng: Rng, o: { team: string; date: string; refs: string[] }): string {
  const lines = o.refs.map(r => `- ${r}: ${rng.pick(ROUTINE_LINES)}`);
  return frontmatterless(`${o.team} team update, week of ${o.date}`, ['Routine notes from this week. Owner changes, contract terms and ticket status live in their own records.', lines.join('\n')]);
}

export const NONDECIDING_KINDS = ['logistics', 'correspondence', 'closed_ticket'] as const;
export const UNRELATED_TICKET_TOPICS = ['Password reset request', 'Question about a CSV column', 'Typo in the help center', 'Calendar invite not received', 'Request for a W-9 form', 'Logo update for the portal'];

export function logisticsBody(rng: Rng, o: { name: string; date: string }): string {
  return frontmatterless(`Logistics: ${o.name} visit`, [`Room booked for ${longDate(o.date)}. ${rng.pick(['Lunch is ordered for eight.', 'Visitor badges are at the front desk.', 'The projector in room 4 is fixed.', 'Parking passes were emailed.'])}`, rng.pick(ROUTINE_LINES)]);
}
