/**
 * Document styles of the sealed Hard generator: record cards and change logs
 * as tables, order forms with schedules, numbered change orders, forwarded
 * mail threads, minutes with an action-item table, helpdesk exports as
 * key-value blocks, assistant scratchpads and ops bulletins.
 */
import type { LadderDoc } from '../model-ladder-gen.ts';
import { COMPANY, COMPANY_DOMAIN, GIVEN, FAMILY, STAFF, SUPPORT_STAFF, TOPICS } from './pools.ts';
import { cardId, changesId, formId, longDate, mailDate, minDate, nameAt, addDays, type Acct, type ChangeOrder, type Ticket, TODAY } from './ledger.ts';
import type { Rng } from './rng.ts';

const mailbox = (person: string, domain: string) => `${person.toLowerCase().replace(/[^a-z]+/g, '.')}@${domain}`;

export function personName(r: Rng): string { return `${r.pick(GIVEN)} ${r.pick(FAMILY)}`; }

// ─── Registry ───────────────────────────────────────────────────────

export function renderCard(a: Acct): LadderDoc {
  const name = a.names[0].name;
  const rows: Array<[string, string]> = [
    ['Customer', name], ['Short-name', a.code], ['Tier', a.segment], ['Territory', a.region],
    ...(a.ghostOf ? [] : [['Account lead', a.owner[0].value] as [string, string]]),
    ['Primary contact', a.contacts[0]], ['Mail domain', a.domain], ['Card opened', a.opened],
  ];
  const body = [
    `CUSTOMER RECORD CARD`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    ``,
    `Later edits to this card are kept in the change log (registry/${a.code.toLowerCase()}/changes), not here.`,
  ].join('\n');
  return { id: cardId(a), title: `Record card: ${name}`, type: 'crm', date: a.opened, author: 'crm-sync', body };
}

export function renderChanges(a: Acct): LadderDoc | null {
  if (!a.changes.length) return null;
  const rows = [...a.changes].sort((x, y) => x.logged.localeCompare(y.logged) || x.effective.localeCompare(y.effective));
  const body = [
    `CHANGE LOG / ${a.code}`,
    `Rows appear in the order they were keyed. "Applies from" is the date the change counts from; it can fall before or after the day it was keyed.`,
    ``,
    `| keyed | field | was | now | applies from | keyed by | remark |`,
    `|---|---|---|---|---|---|---|`,
    ...rows.map(r => `| ${r.logged} | ${r.field} | ${r.was} | ${r.now} | ${r.effective} | ${r.by} | ${r.note ?? ''} |`),
  ].join('\n');
  return { id: changesId(a), title: `Change log: ${a.code}`, type: 'crm', date: rows[rows.length - 1].logged, author: 'crm-sync', body };
}

export function renderSites(a: Acct): LadderDoc | null {
  if (!a.sites) return null;
  const body = [
    `SITE DIRECTORY / ${a.code}`,
    `Snapshot taken ${longDate(a.sites.asOf)} from the customer's onboarding sheet.`,
    ``,
    `| Site | Receiving contact |`,
    `|---|---|`,
    ...a.sites.list.map(s => `| ${s.name} | ${s.contact} |`),
  ].join('\n');
  return { id: a.sites.doc, title: `Site directory: ${nameAt(a, a.sites.asOf)}`, type: 'crm', date: a.sites.asOf, author: 'onboarding-desk', body };
}

// ─── Paper ──────────────────────────────────────────────────────────

const BOILERPLATE = [
  'Each party keeps the other party\'s non-public material in confidence for three years after the term ends.',
  'Formal notices are sent to the postal address printed on the cover page until a party names another in writing.',
  'Neither party may assign this agreement without consent, except to a successor of its whole business.',
  'Supplier keeps the hosted service available from at least two data centres in the same jurisdiction.',
  'Customer can pull a full copy of its records in an open file format whenever it asks, up to sixty days after the term.',
  'Delays caused by events outside a party\'s reasonable control do not count as a breach.',
  'Supplier may update the service if the update does not materially reduce its functions.',
  'Customer is responsible for the accuracy of the data it uploads and for its users\' credentials.',
  'Fees exclude taxes; Customer pays any sales or use tax that applies to the order.',
  'Supplier carries professional indemnity insurance and supplies a certificate on request.',
  'Either party may terminate for a material breach left uncured thirty days after written notice.',
  'Disputes go first to the two relationship managers, then to senior executives, before any filing.',
  'Supplier subprocessors are listed on its trust page and Customer is told of changes in advance.',
  'Training material supplied under this order may be copied for Customer\'s internal use only.',
  'Each schedule forms part of this order; where they conflict, the schedule wins over the body.',
  'Customer site rules apply to Supplier staff while they are on Customer premises.',
  'Supplier returns or destroys Customer data within forty-five days of a written request after the term.',
  'This order may be signed in counterparts, and an electronic signature counts as an original.',
];

function boilerplate(r: Rng, n: number, startAt: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`Clause ${startAt + i}. ${r.pick(BOILERPLATE)}`);
  return out;
}

export function renderOrderForm(a: Acct, r: Rng): LadderDoc {
  const name = a.names[0].name;
  const renewal = a.renewal[0]?.value;
  const long = a.formLongLabel;
  const rows = Object.entries(a.form).filter(([k]) => k !== long);
  const parts = [
    `ORDER FORM VF-${a.code}`,
    `Between ${COMPANY} ("Supplier") and ${name} ("Customer"). Ref: ${a.code}`,
    `Execution state: EXECUTED. Both signatures are dated ${longDate(a.opened)}.`,
    `Commencement: ${longDate(a.opened)}.`,
    ``,
  ];
  if (long) {
    const before = r.int(18, 40), after = r.int(18, 40);
    parts.push(`Part A. General terms`, ...boilerplate(r, before, 1), `Clause ${before + 1}. ${long}: ${a.form[long]}, which applies from commencement unless a later executed change order replaces it.`, ...boilerplate(r, after, before + 2), ``);
  }
  parts.push(
    `Schedule 1. Commercial terms`,
    ``,
    `| Item | Agreed |`,
    `|---|---|`,
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    ...(renewal ? [`| Renewal date | ${longDate(renewal)} |`] : []),
    ``,
    `Signed for Supplier: ${a.ghostOf ? r.pick(SUPPORT_STAFF) : a.owner[0].value}. Signed for Customer: ${a.contacts[0]}.`,
  );
  return { id: formId(a), title: `Order form VF-${a.code}`, type: 'contract', date: a.opened, author: 'contracts-desk', body: parts.join('\n') };
}

export function renderChangeOrder(a: Acct, co: ChangeOrder, r: Rng): LadderDoc {
  const name = nameAt(a, co.signed);
  const state = co.state === 'executed'
    ? `Execution state: EXECUTED. ${COMPANY} and the customer each signed it on ${longDate(co.signed)}.`
    : `Execution state: UNSIGNED DRAFT, circulated for review on ${longDate(co.signed)}. Nobody has signed it.`;
  const items = co.items.map((it, i) => {
    const tag = `(${String.fromCharCode(97 + i)})`;
    if (it.corrects) return `${tag} Corrective entry. CO-${it.corrects} keyed the wrong figure for ${it.label}. From the date CO-${it.corrects} named, ${it.label} reads "${it.value}" instead.`;
    return `${tag} ${it.label} now reads "${it.value}".`;
  });
  const head = [
    `CHANGE ORDER CO-${co.no} to order form VF-${a.code}`,
    `Parties: ${COMPANY} and ${name} (Ref: ${a.code}).`,
    state,
    `Applies from: ${longDate(co.effective)}.`,
    ``,
  ];
  const body = co.long
    ? (() => {
      const before = r.int(20, 45), after = r.int(20, 45);
      return [...head, `Restated terms`, ...boilerplate(r, before, 1), `Clause ${before + 1}. Amended item ${items.join(' ')}`, ...boilerplate(r, after, before + 2)];
    })()
    : [...head, `Changes`, ...items, ``, `Everything not listed above stays as the order form and earlier executed change orders set it.`];
  return { id: co.id, title: `CO-${co.no}: ${a.code}`, type: 'amendment', date: co.signed, author: co.author, body: body.join('\n') };
}

// ─── Mail ───────────────────────────────────────────────────────────

export interface ForwardSpec {
  id: string;
  date: string;
  subject: string;
  forwarder: string;
  to: string;
  note: string[];
  original: { date: string; from: string; fromDomain: string; lines: string[] };
}

export function renderForward(s: ForwardSpec): LadderDoc {
  const body = [
    `From: ${s.forwarder} <${mailbox(s.forwarder, COMPANY_DOMAIN)}>`,
    `Sent: ${mailDate(s.date)}`,
    `To: ${s.to}`,
    `Subject: Fwd: ${s.subject}`,
    ``,
    ...s.note,
    ``,
    `---- forwarded ----`,
    `| from | ${s.original.from} <${mailbox(s.original.from, s.original.fromDomain)}> |`,
    `| sent | ${mailDate(s.original.date)} |`,
    `| subject | ${s.subject} |`,
    ``,
    ...s.original.lines.map(l => `> ${l}`),
  ].join('\n');
  return { id: s.id, title: `Fwd: ${s.subject}`, type: 'email', date: s.date, author: s.forwarder, body };
}

const FORWARD_NOTES = [
  'Filing this in the customer folder. No action for us yet.',
  'Parking this thread here so the next person can find it.',
  'For the record; I already answered them directly.',
  'Sharing for context ahead of the next check-in.',
  'Adding to the folder. Shout if anything here looks off.',
  'Copying the team so this does not live only in my inbox.',
];

const ROUTINE_ASKS = [
  (t: string) => `Could your side send over the ${t} when you get a moment?`,
  (t: string) => `We are still waiting on the ${t}; is there a new date for it?`,
  (t: string) => `Our facilities lead wants to talk through the ${t} before the end of the month.`,
  (t: string) => `Thanks for sorting the ${t} so quickly last week.`,
  (t: string) => `One of our supervisors raised the ${t} again at the morning stand-up.`,
  (t: string) => `Please treat the ${t} as low priority; nothing is blocked on it.`,
  (t: string) => `Is there a template we should use for the ${t}?`,
  (t: string) => `The ${t} came up during our internal review and nobody objected.`,
];

export function routineForward(a: Acct, r: Rng, id: string, date: string): LadderDoc {
  const topic = r.pick(TOPICS);
  const sender = r.pick(a.contacts);
  const lines = [`Hello ${COMPANY.split(' ')[0]} team,`, r.pick(ROUTINE_ASKS)(topic), r.pick(ROUTINE_ASKS)(r.pick(TOPICS)), `Regards, ${sender.split(' ')[0]}`];
  return renderForward({
    id, date: minDate(TODAY, addDays(date, r.int(0, 3))), subject: `${topic} (Ref: ${a.code})`, forwarder: r.pick(SUPPORT_STAFF), to: 'customer-folder',
    note: [r.pick(FORWARD_NOTES)], original: { date, from: sender, fromDomain: a.domain, lines },
  });
}

// ─── Minutes ────────────────────────────────────────────────────────

const LOG_LINES = [
  (t: string) => `Can we park the ${t} until next time?`,
  (t: string) => `I'll take the ${t} back to my team and send notes.`,
  (t: string) => `From where I sit the ${t} is mostly a timing question.`,
  (t: string) => `Last quarter the ${t} dragged on longer than anyone wanted.`,
  (t: string) => `Who on your side is closest to the ${t}?`,
  () => `That works for me. Let's write it down as an action.`,
  (t: string) => `Sorry, I was muted. Could you repeat the bit about the ${t}?`,
  () => `The floor staff like the new screens, for what it's worth.`,
  () => `We should check with facilities before anyone books travel.`,
  (t: string) => `I have a draft of the ${t} but it needs another pass.`,
  () => `Quick reminder that our office is closed on the bank holiday.`,
  (t: string) => `If the ${t} slips, nothing else moves with it.`,
  () => `Agreed. Moving on.`,
  (t: string) => `Our auditors asked about the ${t} in passing.`,
  () => `Can everyone see my screen now?`,
  (t: string) => `Let me find the email about the ${t}; it was a few weeks back.`,
  () => `I think we covered that in the last session.`,
  (t: string) => `There's a small budget question behind the ${t}, nothing major.`,
  () => `Happy to take that one.`,
  (t: string) => `Night shift has its own view on the ${t}; I'll ask them.`,
];

export function renderMinutes(a: Acct, r: Rng, id: string, date: string, lines: number, n: number): LadderDoc {
  const name = nameAt(a, date);
  const ours = [r.pick(STAFF), r.pick(SUPPORT_STAFF)];
  const theirs = r.sample(a.contacts, Math.min(2, a.contacts.length));
  const people = [...ours, ...theirs];
  const agenda = r.sample(TOPICS, 3);
  const log: string[] = [];
  let sec = r.int(5, 40);
  for (let i = 0; i < lines; i++) {
    sec += r.int(8, 55);
    const stamp = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    log.push(`[${stamp}] ${r.pick(people)}: ${r.pick(LOG_LINES)(r.pick(agenda))}`);
  }
  const body = [
    `MINUTES / ${name} working session ${n}`,
    `Held ${longDate(date)}, video call. Present: ${people.join(', ')}.`,
    ``,
    `Agenda`,
    ...agenda.map((t, i) => `${i + 1}. ${t}`),
    ``,
    `Discussion log`,
    ...log,
    ``,
    `Action items`,
    `| # | Who | What | By |`,
    `|---|---|---|---|`,
    ...agenda.map((t, i) => `| ${i + 1} | ${r.pick(people)} | follow up on the ${t} | ${addDays(date, r.int(5, 21))} |`),
  ].join('\n');
  return { id, title: `Minutes: ${name} session ${n}`, type: 'meeting', date, author: ours[1], body };
}

// ─── Helpdesk ───────────────────────────────────────────────────────

export function renderTicket(a: Acct, t: Ticket): LadderDoc {
  const hist = [`  - ${t.opened} | opened | reported by ${t.reporter}`];
  if (t.escalated) hist.push(`  - ${t.escalated} | escalated | moved to tier-3 engineering`);
  if (t.closed) hist.push(`  - ${t.closed} | resolved | fix confirmed with the reporter`);
  const date = t.closed ?? t.escalated ?? t.opened;
  const state = t.closed ? 'resolved' : t.escalated ? 'escalated, unresolved' : 'open';
  const body = [
    `=== HELPDESK EXPORT ===`,
    `key: ${t.key}`,
    `ref: ${a.code}`,
    `summary: ${t.summary}`,
    `priority: ${t.priority}`,
    `state_at_export: ${state}`,
    `history:`,
    ...hist,
    `=== END ===`,
  ].join('\n');
  return { id: t.doc, title: `Helpdesk export ${t.key}`, type: 'ticket', date, author: 'helpdesk-export', body };
}

// ─── Assistant scratchpad and bulletins ─────────────────────────────

export function renderScratch(a: Acct, id: string, date: string, lines: string[]): LadderDoc {
  const body = [`assistant scratchpad / ${a.code} / ${date}`, ``, ...lines.map(l => `- ${l}`)].join('\n');
  return { id, title: `Assistant scratchpad: ${a.code}`, type: 'agent-note', date, author: 'assistant', body };
}

export function renderBulletin(id: string, no: number, date: string, items: string[]): LadderDoc {
  const body = [`OPS BULLETIN No. ${no}`, `Circulated ${longDate(date)} to the account team.`, ``, ...items.map(i => `* ${i}`)].join('\n');
  return { id, title: `Ops bulletin No. ${no}`, type: 'team-update', date, author: 'ops-desk', body };
}

const BULLETIN_ROUTINE = [
  (n: string, c: string, t: string) => `${n} (Ref ${c}) hosted our field team for a walkthrough of the ${t}.`,
  (n: string, c: string, t: string) => `${n} (Ref ${c}) sent thanks for the turnaround on the ${t}.`,
  (n: string, c: string, t: string) => `Heads-up: ${n} (Ref ${c}) may ask about the ${t} next week.`,
  (n: string, c: string, t: string) => `${n} (Ref ${c}) shared photos of the ${t} for the case-study folder.`,
  (n: string, c: string, t: string) => `Reminder to whoever visits ${n} (Ref ${c}): bring the ${t}.`,
];

export function bulletinRoutine(r: Rng, a: Acct, date: string): string {
  return r.pick(BULLETIN_ROUTINE)(nameAt(a, date), a.code, r.pick(TOPICS));
}

