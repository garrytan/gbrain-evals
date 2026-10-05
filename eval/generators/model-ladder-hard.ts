/**
 * Cat 40 Hard world generator (plan docs/plans/2026-10-05-cat40-hard/PLAN.md).
 *
 * Ledger first, prose second, as in the v1 generator: every fact and every
 * answer key comes from the ledger built here; document bodies are rendered
 * afterwards (lazily, one seeded stream per document) and never read back.
 * The world and task contract is eval/generators/hard/schema.ts; the meaning
 * of dates, corrections, user statements and names is hard/semantics.ts.
 *
 * Families:
 *   H1 many-record   a set or a count over 10 to 40 accounts, from a
 *                    predicate over owners, tickets, renewals, segments and
 *                    regions as of a date (one evaluator, semantics.ts)
 *   H2 long history  a contract term changed 3 to 6 times by executed change
 *                    orders, with reversals, backdated corrections and
 *                    effective dates that differ from signing dates, asked
 *                    as of a date; agent notes summarize intermediate states
 *   H3 look-alikes   accounts sharing a first word or a code prefix, renamed
 *                    accounts and merged accounts; the question names the
 *                    ambiguous name and one fact to look up (the champion)
 *   H4 authority     3 to 5 conflicting documents: executed contract and
 *                    amendments (the later effective date wins, future dates
 *                    do not apply yet), draft amendment, email summary,
 *                    agent note; some deciding documents are long
 *   H5 five sessions four recording sessions of user statements (one later
 *                    superseded, one a look-alike's fact), then a question
 *                    that depends on two of them
 *
 * Reference forms (generator v2, amendment A1, knob schema 2): event records
 * refer to their account by name, account code, nickname or account manager
 * ("<manager>'s <region> <industry> account"), drawn per reference from the
 * reference-form knobs after the ledger is complete; CRM records, account
 * sheets, rename and merger notices name the account and resolve the other
 * forms. Event documents get opaque ids, so a path never names an account.
 * With `direct_name_share` 1 (or without the keys) the output is v1's.
 *
 * Scale `large` (about 50,000 documents) is the 4k world plus appended
 * accounts that never satisfy a full H1 predicate and never name a 4k
 * account, plus non-deciding documents about 4k accounts. The generator
 * recomputes every H1 key over the full ledger and checks every H3
 * disambiguation is still unique before it writes a 50k world.
 *
 * Usage: bun eval/generators/model-ladder-gen.ts --mode hard [--seed N] [--knobs <file.json>]
 *          [--scale large --base-world <4k world.json>] [--out DIR] [--check]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LadderDoc } from './model-ladder-gen.ts';
import {
  HARD_FAMILIES, HARD_SEEDS, RECORDED, DEFAULT_HARD_KNOBS, validateKnobs, knobDigest, knobSchemaOf, hardGeneratorVersion,
  type HardKnobs, type HardWorld, type HardTask, type HardEntity, type H1Predicate, type H1Clause, type SessionFact, type HardFamily, type RefForm, type HardReference,
} from './hard/schema.ts';
import {
  eventAsOf, valueAsOf, correctionOf, historyValues, statedValue, nameRegistry, evaluatePredicate, clauseHolds, managerReference, managerKnownOn, managerReadingsOn,
  type ValueEvent, type PredicateFacts, type UserStatement,
} from './hard/semantics.ts';
import { Rng, rngFor, addDays, longDate, slugify } from './hard/rng.ts';
import * as R from './hard/render.ts';
import { assertHardWorld } from './hard/validate.ts';

export const HARD_TODAY = '2026-09-15';
export const HARD_PRINCIPAL = { name: 'Sam Rivera', role: 'account manager (sales team)' };
export const HARD_KNOBS_DIR = resolve(import.meta.dir, '../../docs/benchmarks/cat40-hard');
export const HARD_STAFF = 18;
/** Generator v2: account managers of appended (50k) accounts, a separate team, so a 4k record's manager reference stays unique at 50k. */
export const HARD_STAFF_LARGE = 150;
/** World sizes the generator holds (CEO-F5): about 4,000 and about 50,000 documents, within 25%. */
export const HARD_SIZE = { v1: [3000, 5000], large: [37_500, 62_500] } as const;
/** Appended look-alikes per H3 task at 50k. */
export const LARGE_LOOKALIKES_PER_H3 = 3;
const MAX_DRAWS = 20_000;

type Term = 'seats' | 'payment_terms' | 'liability_cap' | 'uptime_sla';
const TERMS: Term[] = ['seats', 'payment_terms', 'liability_cap', 'uptime_sla'];
const SLA = ['99.0%', '99.5%', '99.8%', '99.9%', '99.95%', '99.99%'];
const NET = [15, 30, 45, 60, 75, 90].map(n => `Net ${n}`);
const TICKET_TOPICS = ['Export job failing', 'SSO login errors', 'Data sync delays', 'API timeouts', 'Billing portal error', 'Report scheduler stuck', 'Webhook deliveries dropped'];

interface Ticket { id: string; opened: string; escalated?: string; closed?: string; topic: string; doc: string }

export interface HardAccount {
  id: string;
  slug: string;
  base: string;
  name: string;
  code: string;
  /** Name and code on the original contract when the account was renamed later. */
  former?: { name: string; code: string; date: string; doc: string };
  /** Accounts merged into this one (their names become aliases). */
  mergedIn: Array<{ name: string; code: string; date: string; doc: string; nickname?: string }>;
  /** Generator v2: the nickname (an alias) and the account sheet that introduces it. */
  nickname?: string;
  sheetDoc?: string;
  /** Industry from the suffix of the account's first name; with the region it is the manager-form descriptor. */
  industry: string;
  /** Set on an account merged into another: it is not an entity of its own. */
  mergedInto?: string;
  segment: string;
  region: string;
  champion: string;
  billing: string;
  signed: string;
  owner: ValueEvent[];
  renewal: ValueEvent[];
  terms: Record<Term, ValueEvent[]>;
  tickets: Ticket[];
  contractDoc: string;
  crmDoc: string;
  large: boolean;
  role: string;
  /** Name of the account's random streams; stable when other accounts are added or removed. */
  stream: string;
  /** Documents written about the account by its own timelines (handoffs, tickets, routine mail and meetings, notes). */
  docIds: string[];
  /** The executed contract is a planted long document (H4), so the standard contract is not rendered. */
  customContract?: boolean;
}

/**
 * How one document refers to one account. Name, code and base are captured
 * when the document is created (as v1 rendered them); in v2 the reference
 * form is resolved after the ledger is complete, and a non-name form replaces
 * all three with its text.
 */
interface Ident {
  readonly account: HardAccount;
  readonly name: string;
  readonly code: string;
  readonly base: string;
  /** v1: the name when `useName`, else the code. v2: the reference text. */
  alt(useName: boolean): string;
  /** Owner-timeline records never use the manager form (they define it). */
  noManager: boolean;
  /** v2: the form, its text, and the name and code in force on the document's date (what a name-form record prints). */
  resolved?: { form: RefForm; text: string; name: string; code: string };
}

interface HDoc extends Omit<LadderDoc, 'body' | 'title'> {
  title: string | (() => string);
  body: string | (() => string);
  /** Accounts the document refers to (event records). */
  refs?: Ident[];
  /** CRM records, account sheets, rename and merger notices: they name the account and keep readable ids. */
  resolution?: true;
}
const text = (v: string | (() => string)) => (typeof v === 'function' ? v() : v);

export interface HardBuild {
  seed: number;
  knobs: HardKnobs;
  scale: 'v1' | 'large';
  staff: string[];
  accounts: HardAccount[];
  appended: HardAccount[];
  tasks: HardTask[];
  docs: HDoc[];
  /** Documents of appended (50k) accounts and their team updates. */
  appendedDocIds: Set<string>;
  /** Facts for the H1 evaluator over every entity in the build. */
  facts(): PredicateFacts[];
  /** v2: every account reference in an event record, with final document ids. */
  references: HardReference[];
}

export function aliasesOf(a: HardAccount): string[] {
  return [a.code, ...(a.former ? [a.former.name, a.former.code] : []), ...a.mergedIn.flatMap(m => [m.name, m.code]), ...(a.nickname ? [a.nickname] : []), ...a.mergedIn.flatMap(m => (m.nickname ? [m.nickname] : []))];
}

export const descriptorOf = (a: HardAccount) => `${a.region} ${a.industry}`;

function factsOf(a: HardAccount): PredicateFacts {
  return { id: a.id, segment: a.segment, region: a.region, owner: a.owner, renewal: a.renewal, tickets: a.tickets };
}

const pairwiseClean = (vals: string[]) => {
  const n = vals.map(v => v.toLowerCase().replace(/,/g, '').trim());
  for (let i = 0; i < n.length; i++) for (let j = 0; j < n.length; j++) if (i !== j && (n[i] === n[j] || n[i].includes(n[j]))) return false;
  return true;
};

// ─── Build ──────────────────────────────────────────────────────────

export function buildHardLedger(seed: number, knobs: HardKnobs, opts: { scale?: 'v1' | 'large' } = {}): HardBuild {
  const scale = opts.scale ?? 'v1';
  const K = knobs;
  /** Reference forms on: generator v2 with some references not by name. Off reproduces v1 exactly. */
  const refsOn = (K.direct_name_share ?? 1) < 1;
  const docs: HDoc[] = [];
  const ids = new Set<string>();
  const add = (d: HDoc) => {
    let id = d.id, n = 2;
    while (ids.has(id)) id = `${d.id}-${n++}`;
    ids.add(id);
    docs.push({ ...d, id });
    return id;
  };
  const body = (docKey: string, f: (rng: Rng) => string) => () => f(rngFor(seed, 'body', docKey));

  const usedNames = new Set<string>();
  const usedPersons = new Set<string>();
  /** Distinctive values (seats, liability caps, discount codes) are unique within a namespace (each family's accounts, the background); 50k accounts draw from the shared pools. */
  const usedValues = new Map<string, Set<string>>();
  const usedTickets = new Set<string>();
  const nameKey = (s: string) => s.toLowerCase();
  const draw = <T>(make: () => T, ok: (v: T) => boolean, what: string): T => {
    for (let i = 0; i < MAX_DRAWS; i++) { const v = make(); if (ok(v)) return v; }
    throw new Error(`model-ladder-hard: ran out of ${what}`);
  };
  /** Draws that reject values already used elsewhere take one number from the caller's stream and reject on a sub-stream, so a collision never shifts the caller's later draws (ENG-F15). */
  const sub = (rng: Rng) => new Rng(Math.floor(rng.float() * 4294967296));
  const person = (parent: Rng, large = false) => {
    const rng = sub(parent);
    if (large) return `${rng.pick(R.FIRST_LARGE)} ${rng.pick(R.LAST)}`;
    const p = draw(() => `${rng.pick(R.FIRST)} ${rng.pick(R.LAST)}`, x => !usedPersons.has(x), 'person names');
    usedPersons.add(p);
    return p;
  };
  const staffRng = rngFor(seed, 'staff');
  const staff = Array.from({ length: HARD_STAFF }, () => person(staffRng));
  const acmeSigner = staff[0];
  const staffLargeRng = rngFor(seed, 'staff-large');
  const staffLarge: string[] = [];
  while (refsOn && staffLarge.length < HARD_STAFF_LARGE) { const p = person(staffLargeRng, true); if (!staffLarge.includes(p)) staffLarge.push(p); }
  const ownersFor = (a: HardAccount) => (refsOn && a.large ? staffLarge : staff);
  const usedNicknames = new Set<string>();
  const nickname = (streamKey: string) => {
    const rng = rngFor(seed, 'nick', streamKey);
    const n = draw(() => `${rng.pick(R.NICK_A)} ${rng.pick(R.NICK_B)}`, x => !usedNicknames.has(x), 'nicknames');
    usedNicknames.add(n);
    return n;
  };
  const ident = (a: HardAccount, o: { name?: string; code?: string; noManager?: boolean } = {}): Ident => {
    const name = o.name ?? a.name, code = o.code ?? a.code, base = a.base;
    const v2 = () => {
      if (!I.resolved) throw new Error(`model-ladder-hard: a reference to ${a.id} was rendered before its form was resolved`);
      return I.resolved;
    };
    const I: Ident = {
      account: a, noManager: o.noManager ?? false,
      get name() { return !refsOn ? name : v2().form === 'name' ? v2().name : v2().text; },
      get code() { return !refsOn ? code : v2().form === 'name' ? v2().code : v2().text; },
      get base() { return refsOn ? I.name : base; },
      alt(useName: boolean) { return refsOn ? I.name : useName ? name : code; },
    };
    return I;
  };
  const uniqueValue = (parent: Rng, make: (r: Rng) => string, ns: string) => {
    if (ns === 'large') return make(parent);
    const rng = sub(parent);
    if (!usedValues.has(ns)) usedValues.set(ns, new Set());
    const used = usedValues.get(ns)!;
    const v = draw(() => make(rng), x => !used.has(x), 'unique values');
    used.add(v);
    return v;
  };
  const seatsValue = (r: Rng) => String(r.int(100, 2400));
  const capValue = (r: Rng) => `$${(r.int(20, 900) * 5).toLocaleString('en-US')},000`;
  const termValue = (t: Term, r: Rng, ns: string): string => t === 'seats' ? uniqueValue(r, seatsValue, ns) : t === 'liability_cap' ? uniqueValue(r, capValue, ns) : t === 'uptime_sla' ? r.pick(SLA) : r.pick(NET);
  const ticketId = (parent: Rng) => { const rng = sub(parent); const t = draw(() => `TKT-${rng.int(10000, 99999)}`, x => !usedTickets.has(x), 'ticket ids'); usedTickets.add(t); return t; };

  const allocName = (parent: Rng, o: { base?: string; fresh?: boolean } = {}) => { const rng = sub(parent); return draw(() => {
    const base = o.base ?? `${rng.pick(R.SYL_A)}${rng.pick(R.SYL_B)}`;
    return { base, name: `${base} ${rng.pick(R.SUFFIX)}` };
  }, x => !usedNames.has(nameKey(x.name)) && !(o.fresh && [...usedNames].some(n => n.startsWith(`${nameKey(x.base)} `))), 'account names'); };
  const allocCode = (parent: Rng, base: string, name: string, prefix?: string) => {
    const rng = sub(parent);
    const natural = prefix ? '' : (base.slice(0, 2) + name.split(' ')[1].slice(0, 1) + base.slice(-1)).toUpperCase();
    const ALNUM = [...'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'];
    const p3 = prefix ?? natural.slice(0, 3);
    const code = natural && !usedNames.has(nameKey(natural)) ? natural
      : draw(() => (prefix ? p3 + rng.pick(ALNUM) : rng.chance(0.5) ? p3 + rng.pick(ALNUM) : p3.slice(0, 2) + rng.pick(ALNUM) + rng.pick(ALNUM)), x => !usedNames.has(nameKey(x)), `account codes ${p3}*`);
    usedNames.add(nameKey(code));
    return code;
  };

  let nextId = 1;
  const accounts: HardAccount[] = [];
  const appended: HardAccount[] = [];
  const appendedDocIds = new Set<string>();

  /** Create an account and its timelines and records. `streamKey` names its random stream. */
  const createAccount = (streamKey: string, o: { role: string; base?: string; codePrefix?: string; large?: boolean; fresh?: boolean }): HardAccount => {
    const rng = rngFor(seed, 'acct', streamKey);
    const large = o.large ?? false;
    const { base, name } = allocName(rng, { base: o.base, fresh: o.fresh });
    usedNames.add(nameKey(name));
    const code = allocCode(rng, base, name, o.codePrefix);
    const id = `acct-${String(nextId++).padStart(4, '0')}`;
    const signed = rng.date('2024-01-10', '2025-09-30');
    const a: HardAccount = {
      id, slug: slugify(name), base, name, code, mergedIn: [], segment: rng.pick(R.SEGMENTS), region: rng.pick(R.REGIONS),
      champion: person(rng, large), billing: person(rng, large), signed, owner: [], renewal: [], terms: { seats: [], payment_terms: [], liability_cap: [], uptime_sla: [] },
      tickets: [], contractDoc: '', crmDoc: '', large, role: o.role, stream: streamKey, docIds: [], industry: R.INDUSTRY[name.split(' ')[1]],
      ...(refsOn ? { nickname: nickname(streamKey) } : {}),
    };
    a.contractDoc = `contracts/${a.slug}-msa`;
    a.crmDoc = `crm/${a.slug}`;
    const mark = docs.length;
    populate(a, rng);
    a.docIds = docs.slice(mark).map(d => d.id);
    (large ? appended : accounts).push(a);
    return a;
  };

  /** Timelines: owner handoffs, renewal, contract terms and tickets, with their documents. */
  const populate = (a: HardAccount, rng: Rng) => {
    const cd = a.code, champion = a.champion;
    const owners = ownersFor(a);
    const rv = rngFor(seed, 'values', a.stream);
    const renewal0 = rng.date('2026-09-20', '2027-08-31');
    for (const t of TERMS) a.terms[t] = [{ value: termValue(t, rv, a.role.split('-')[0]), effective: a.signed, recorded: a.signed, doc: a.contractDoc, kind: 'initial' }];
    a.renewal = [{ value: renewal0, effective: a.signed, recorded: a.signed, doc: a.contractDoc, kind: 'initial' }];
    a.owner = [{ value: rng.pick(owners), effective: a.signed, recorded: a.signed, doc: a.crmDoc, kind: 'initial' }];
    if (rng.chance(0.2)) {
      const ad = rng.date('2026-01-05', '2026-08-31');
      const nr = rng.date('2026-10-01', '2027-09-30');
      const doc = `contracts/${a.slug}-renewal-amendment`;
      a.renewal.push({ value: nr, effective: ad, recorded: ad, doc, kind: 'change' });
      const I = ident(a), prev = renewal0;
      add({ id: doc, title: () => `Amendment: ${I.code} renewal date`, type: 'amendment', date: ad, author: 'legal@acme-example', refs: [I],
        body: () => R.frontmatterless(`Amendment to the Master Services Agreement with ${I.name}`, [`Status: Executed. Countersigned by both parties on ${longDate(ad)}.`, `Effective ${ad}, the renewal date moves from ${prev} to ${nr}. All other terms are unchanged.`]) });
    }
    const nh = rng.int(0, K.handoffs_per_account_max);
    const effs = Array.from({ length: nh }, () => rng.date('2025-03-01', '2026-11-30')).filter(d => d > a.signed).sort();
    let current = a.owner[0].value;
    let lastRecorded = a.signed;
    effs.forEach((eff, k) => {
      const next = draw(() => rng.pick(owners), x => x !== current, 'owners');
      const prev = current;
      let recorded: string, kind: 'belated' | 'advance' | 'heads_up';
      if (eff > HARD_TODAY) { recorded = addDays(eff, -rng.int(5, 30)); kind = 'heads_up'; }
      else if (rng.chance(K.backdated_handoff_rate)) { recorded = addDays(eff, rng.int(3, 40)); kind = 'belated'; }
      else { recorded = addDays(eff, -rng.int(0, 14)); kind = 'advance'; }
      if (recorded > HARD_TODAY) recorded = HARD_TODAY;
      if (recorded < lastRecorded) recorded = lastRecorded;
      lastRecorded = recorded;
      const I = ident(a, { noManager: true });
      const docId = add({ id: `mail/${recorded.slice(0, 7)}/${recorded}-handoff-${slugify(cd)}`, title: () => `Handoff: ${I.name}`, type: 'email', date: recorded, author: prev, refs: [I],
        body: body(`handoff:${a.stream}:${k}`, r => {
          const lead = kind === 'belated' ? `Belated note, sorry for the delay: effective ${eff}, ${next} took over as account owner for ${I.alt(r.chance(0.5))} from me.`
            : kind === 'heads_up' ? `Heads up: effective ${eff}, ${next} will take over as account owner for ${I.name} from me.`
            : `Team, effective ${eff} ${next} takes over as account owner for ${I.name}. I'll stay on for two weeks to transition.`;
          return `From: ${prev}\nDate: ${recorded}\nSubject: Handoff of ${R.both(I.name, I.code)}\n\n${lead}`;
        }) });
      const ev: ValueEvent = { value: next, effective: eff, recorded, doc: docId, kind: 'change' };
      a.owner.push(ev);
      current = next;
      if (eff <= HARD_TODAY && rng.chance(0.12)) {
        const fixed = draw(() => rng.pick(owners), x => x !== next && x !== prev, 'owners');
        const cr = addDays(recorded, rng.int(2, 20));
        if (cr <= HARD_TODAY) {
          const C = ident(a, { noManager: true });
          const cdoc = add({ id: `mail/${cr.slice(0, 7)}/${cr}-owner-correction-${slugify(cd)}`, title: () => `Correction: owner of ${C.code}`, type: 'email', date: cr, author: 'sales-ops@acme-example', refs: [C],
            body: () => `From: sales-ops@acme-example\nDate: ${cr}\nSubject: Correction: owner of ${C.code}\n\nCorrection to the handoff note of ${recorded}: effective ${eff}, ${C.name} went to ${fixed}, not ${next}. The CRM will be updated in the next sync.` });
          a.owner.push(correctionOf(ev, fixed, cr, cdoc));
          current = fixed;
          lastRecorded = cr;
        }
      }
    });
    const nt = rng.int(0, K.tickets_per_account_max);
    for (let k = 0; k < nt; k++) {
      const opened = rng.date('2026-02-01', '2026-09-10');
      const escalated = rng.chance(0.55) ? addDays(opened, rng.int(1, 10)) : undefined;
      const closeAt = rng.chance(0.5) ? addDays(escalated ?? opened, rng.int(3, 70)) : undefined;
      const tk: Ticket = { id: ticketId(rng), opened, escalated: escalated && escalated <= HARD_TODAY ? escalated : undefined, closed: closeAt && closeAt <= HARD_TODAY ? closeAt : undefined, topic: rng.pick(TICKET_TOPICS), doc: '' };
      tk.doc = addTicket(a, tk, rng.chance(0.55));
      a.tickets.push(tk);
    }
    if (rng.chance(K.wrong_agent_note_rate)) {
      const nd = rng.date('2026-05-01', '2026-09-12');
      const wrongOwner = draw(() => rng.pick(owners), x => x !== valueAsOf(a.owner, nd), 'owners');
      const wrongRenewal = draw(() => rng.date('2026-09-20', '2027-09-30'), x => x !== valueAsOf(a.renewal, nd), 'dates');
      const I = ident(a);
      add({ id: `notes/agents/${nd}-${a.slug}-snapshot`, title: () => `Agent snapshot: ${I.name}`, type: 'agent-note', date: nd, author: 'agent:research-assistant', refs: [I],
        body: () => R.frontmatterless(`Account snapshot: ${I.name} (auto-generated)`, [`Account owner: ${wrongOwner}. Renewal date: ${wrongRenewal}.`, 'Confidence: high. Verified against the CRM and recent email.']) });
    }
    for (let k = 0; k < K.emails_per_account; k++) {
      const d = rng.date('2025-10-01', '2026-09-14');
      const I = ident(a);
      add({ id: `mail/${d.slice(0, 7)}/${d}-${slugify(cd)}-note`, title: () => `Email: ${I.code}`, type: 'email', date: d, author: champion, refs: [I],
        body: body(`routine:${a.stream}:${k}`, r => R.routineEmail(r, { from: r.chance(0.5) ? champion : 'success@acme-example', date: d, ref: r.chance(0.3) ? I.base : I.alt(r.chance(0.55)) }).body) });
    }
    for (let k = 0; k < K.meetings_per_account; k++) {
      const d = rng.date('2025-10-01', '2026-09-14');
      const I = ident(a);
      add({ id: `meetings/${d.slice(0, 7)}/${d}-${slugify(cd)}-sync`, title: () => `Meeting: ${I.code} sync`, type: 'meeting', date: d, author: 'success@acme-example', refs: [I],
        body: body(`meeting:${a.stream}:${k}`, r => R.routineMeeting(r, { title: `Sync: ${I.alt(r.chance(0.5))}`, date: d, speakers: [champion, 'Acme success team'], minLines: K.transcript_lines_min, maxLines: K.transcript_lines_max })) });
    }
  };

  const addTicket = (a: HardAccount, tk: Ticket, useName: boolean) => {
    const log: Array<[string, string]> = [[tk.opened, 'Opened.']];
    if (tk.escalated) log.push([tk.escalated, 'Escalated to the Platform team.']);
    if (tk.closed) log.push([tk.closed, 'Closed. Resolved.']);
    const I = ident(a);
    return add({ id: `tickets/${tk.id}`, title: `${tk.id}: ${tk.topic}`, type: 'ticket', date: log.at(-1)![0], author: 'support-desk', refs: [I], body: () => R.ticketBody({ id: tk.id, ref: I.alt(useName), topic: tk.topic, log }) });
  };

  /** Contract, CRM and (v2) account-sheet documents; rendered at the end, so renames and merges planted later appear. */
  const recordDocs = (a: HardAccount) => {
    const t0 = Object.fromEntries(TERMS.map(t => [t, a.terms[t][0].value]));
    const I = ident(a, { name: a.former?.name ?? a.name, code: a.former?.code ?? a.code });
    if (!a.customContract) add({ id: a.contractDoc, title: () => `Master Services Agreement: ${I.name}`, type: 'contract', date: a.signed, author: 'legal@acme-example', refs: [I],
      body: () => R.contractBody({ name: I.name, code: I.code, segment: a.segment, region: a.region, signed: a.signed, renewal: a.renewal[0].value, terms: t0, champion: a.champion, acmeSigner }) });
    if (refsOn) {
      a.sheetDoc = `accounts/${a.slug}`;
      add({ id: a.sheetDoc, title: `Account sheet: ${a.name}`, type: 'crm', date: a.signed, author: 'crm-sync', resolution: true,
        body: R.accountSheetBody({ name: a.name, nickname: a.nickname!, industry: a.industry, region: a.region, descriptor: descriptorOf(a) }) });
    }
    add({ id: a.crmDoc, title: `CRM record: ${a.name}`, type: 'crm', date: a.signed, author: 'crm-sync', resolution: true,
      body: () => a.mergedInto ? R.frontmatterless(`CRM record: ${a.name}`, [`Account: ${a.name}. Account code: ${a.code}.`, `Status: merged into another account (see the merger announcement). Champion at the time of the merger: ${a.champion}.`])
        : R.crmBody({ name: a.name, code: a.code, segment: a.segment, region: a.region, owner: a.owner[0].value, asOf: a.signed, champion: a.champion, billing: a.billing, aliases: aliasesOf(a).filter(x => x !== a.code && x !== a.nickname && !a.mergedIn.some(m => m.nickname === x)) }) });
  };

  const tasks: HardTask[] = [];
  const nTasks = K.tasks_per_family;
  const today = HARD_TODAY;
  const taskId = (f: HardFamily, i: number) => `${f}-${String(i + 1).padStart(2, '0')}`;

  // ─── H2: long histories ──────────────────────────────────────────
  for (let i = 0; i < nTasks; i++) {
    const rng = rngFor(seed, 'task', 'H2', i);
    const a = createAccount(`H2:${i}`, { role: 'H2' });
    const attr: Term = i % 2 ? 'liability_cap' : 'seats';
    const label = R.TERM_LABELS[attr];
    const variant = ['intermediate', 'current_with_corrections', 'before_backdated'][i % 3];
    const n = rng.int(K.h2_changes_min, K.h2_changes_max);
    const events = a.terms[attr];
    const values = [events[0].value];
    const fresh = () => { const v = draw(() => termValue(attr, rng, 'H2'), x => pairwiseClean([...values, x]), 'H2 values'); values.push(v); return v; };
    const effDates = Array.from({ length: n }, () => rng.date(addDays(a.signed, 30) > '2025-01-15' ? addDays(a.signed, 30) : '2025-01-15', addDays(today, -10))).sort();
    effDates.forEach((eff, k) => {
      const reversal = k >= 2 && rng.chance(0.4);
      const inEffect = valueAsOf(events, eff);
      const prior = [...new Set(events.map(e => e.value))].filter(v => v !== inEffect);
      const value = reversal && prior.length ? prior[prior.length - 1] : fresh();
      const backdated = rng.chance(0.5);
      let recorded = backdated ? addDays(eff, rng.int(5, 45)) : addDays(eff, -rng.int(1, 30));
      if (recorded > today) recorded = today;
      if (recorded < a.signed) recorded = addDays(a.signed, 1);
      const I = ident(a);
      const doc = add({ id: `contracts/${a.slug}-change-order-${k + 1}`, title: () => `Change Order No. ${k + 1}: ${I.name}`, type: 'amendment', date: recorded, author: 'legal@acme-example', refs: [I],
        body: () => R.frontmatterless(`Change Order No. ${k + 1} under the Master Services Agreement with ${R.both(I.name, I.code)}`, [`Status: Executed. Signed by both parties on ${longDate(recorded)}.`, `Effective ${eff}, the ${label} under the agreement ${reversal ? 'return to' : 'change to'} ${value}.`, 'All other terms are unchanged.']) });
      const ev: ValueEvent = { value, effective: eff, recorded, doc, kind: 'change' };
      events.push(ev);
      if (rng.chance(K.h2_correction_rate)) {
        const fixed = fresh();
        const cr = addDays(recorded, rng.int(3, 40));
        if (cr <= today) {
          const C = ident(a);
          const cdoc = add({ id: `mail/${cr.slice(0, 7)}/${cr}-change-order-correction-${slugify(a.code)}`, title: () => `Correction: Change Order No. ${k + 1} (${C.code})`, type: 'email', date: cr, author: 'legal@acme-example', refs: [C],
            body: () => `From: legal@acme-example\nDate: ${cr}\nSubject: Correction to Change Order No. ${k + 1} for ${C.name}\n\nChange Order No. ${k + 1}, signed ${recorded}, has a typo. Effective ${eff}, the ${label} is ${fixed}, not ${value}. Both parties initialed the corrected page on ${cr}.` });
          events.push(correctionOf(ev, fixed, cr, cdoc));
        }
      }
    });
    const changes = events.filter(e => e.kind !== 'initial');
    const candidates = (pred: (d: string) => boolean) => { const out: string[] = []; for (let d = changes[0].effective; d <= today; d = addDays(d, 1)) if (pred(d)) out.push(d); return out; };
    let pool = variant === 'current_with_corrections' ? [today]
      : variant === 'before_backdated' ? candidates(d => changes.some(e => e.effective <= d && d < e.recorded))
      : candidates(d => valueAsOf(events, d) !== valueAsOf(events, today));
    if (!pool.length) pool = candidates(() => true);
    const D = pool[Math.floor(rng.float() * pool.length)];
    const gold = valueAsOf(events, D)!;
    const notes: string[] = [];
    const others = historyValues(events).filter(v => v !== gold);
    for (let k = 0; k < K.h2_intermediate_notes && others.length; k++) {
      const v = others[k % others.length];
      const nd = rng.date(addDays(D, -60) > a.signed ? addDays(D, -60) : addDays(a.signed, 1), today);
      const I = ident(a);
      notes.push(add({ id: `notes/agents/${nd}-${a.slug}-${attr}-summary`, title: () => `Agent summary: ${I.name} ${label}`, type: 'agent-note', date: nd, author: 'agent:research-assistant', refs: [I],
        body: () => R.frontmatterless(`Contract summary: ${I.name} (auto-generated)`, [`The ${label} for ${I.code} is ${v}, from the latest change order I could find.`, 'Confidence: high.']) }));
    }
    const asName = refsOn || i % 2 === 0;
    tasks.push({
      id: taskId('H2', i), family: 'H2', variant, answer_kind: 'value', accounts: [a.id],
      question: attr === 'seats' ? `How many licensed seats did ${asName ? a.name : a.code} have under contract on ${D}?` : `What was the liability cap in our agreement with ${asName ? a.name : a.code} on ${D}?`,
      gold: { answer: [gold], wrong: others, evidence: [eventAsOf(events, D)!.doc] },
      relevant: [a.contractDoc, a.crmDoc, ...new Set(changes.map(e => e.doc))],
    });
  }

  // ─── H3: look-alikes ─────────────────────────────────────────────
  const h3Targets: Array<{ task: number; base: string; prefix?: string; champion: string; variant: string; accountId: string }> = [];
  const nowValue = (a: HardAccount, attr: Term | 'renewal_date' | 'owner') => attr === 'owner' ? valueAsOf(a.owner, today)! : attr === 'renewal_date' ? valueAsOf(a.renewal, today)! : valueAsOf(a.terms[attr], today)!;
  const nowDoc = (a: HardAccount, attr: Term | 'renewal_date' | 'owner') => eventAsOf(attr === 'owner' ? a.owner : attr === 'renewal_date' ? a.renewal : a.terms[attr], today)!.doc;
  const attrDocs = (a: HardAccount, attr: Term | 'renewal_date' | 'owner') => [...new Set((attr === 'owner' ? a.owner : attr === 'renewal_date' ? a.renewal : a.terms[attr]).map(e => e.doc))];
  for (let i = 0; i < nTasks; i++) {
    const rng = rngFor(seed, 'task', 'H3', i);
    const variant = ['shared_first_word', 'code_prefix', 'renamed', 'merged'][i % 4];
    const attr = (['payment_terms', 'seats', 'renewal_date', 'owner'] as const)[Math.floor(i / 4) % 4];
    const label = attr === 'owner' ? 'account owner' : R.TERM_LABELS[attr];
    let target: HardAccount, holder: HardAccount, ambiguous: string, prefix: string | undefined;
    const wrongExtra: string[] = [];
    const relevant: string[] = [];
    const evidence: string[] = [];
    if (variant === 'merged') {
      holder = createAccount(`H3:${i}:holder`, { role: 'H3', fresh: true });
      target = createAccount(`H3:${i}:merged`, { role: 'H3', fresh: true });
      ambiguous = target.base;
      const md = rng.date('2026-03-01', '2026-08-20');
      const doc = add({ id: `mail/${md.slice(0, 7)}/${md}-merger-${slugify(target.code)}`, title: `Merger: ${target.name} and ${holder.name}`, type: 'email', date: md, author: 'legal@acme-example', resolution: true,
        body: () => `From: legal@acme-example\nDate: ${md}\nSubject: ${target.name} has merged into ${holder.name}\n\nEffective ${md}, ${target.name} (account code ${target.code}) is part of ${holder.name}. The ${target.name} agreement is consolidated into the ${holder.name} Master Services Agreement, whose terms, owner and renewal date now govern both. ${holder.name} keeps both names, and code ${target.code} now refers to ${holder.name}.` });
      target.mergedInto = holder.id;
      holder.mergedIn.push({ name: target.name, code: target.code, date: md, doc, ...(target.nickname ? { nickname: target.nickname } : {}) });
      // One entity, one set of facts: the merged account's names map to the holder, so its tickets are the holder's
      // tickets, and its contract carries the holder's renewal date (its own renewal amendment is not written).
      holder.tickets.push(...target.tickets);
      for (const e of target.renewal.filter(e => e.kind !== 'initial')) { const i = docs.findIndex(d => d.id === e.doc); if (i >= 0) { ids.delete(docs[i].id); docs.splice(i, 1); } }
      target.renewal = [{ ...target.renewal[0], value: holder.renewal[0].value }];
      wrongExtra.push(nowValue(target, attr));
      relevant.push(doc, target.contractDoc, target.crmDoc);
      evidence.push(doc, target.contractDoc);
    } else {
      target = createAccount(`H3:${i}:target`, { role: 'H3', fresh: true });
      holder = target;
      ambiguous = target.base;
      if (variant === 'code_prefix') prefix = target.code.slice(0, 3);
      if (variant === 'renamed') {
        const rd = rng.date('2026-02-01', '2026-07-31');
        const oldName = target.name, oldCode = target.code;
        const { base: nb, name: nn } = allocName(rng, { fresh: true });
        usedNames.add(nameKey(nn));
        const nc = allocCode(rng, nb, nn);
        const doc = add({ id: `mail/${rd.slice(0, 7)}/${rd}-rename-${slugify(oldCode)}`, title: `Account renamed: ${oldName}`, type: 'email', date: rd, author: 'sales-ops@acme-example', resolution: true,
          body: () => `From: sales-ops@acme-example\nDate: ${rd}\nSubject: ${oldName} is now ${nn}\n\nAs of ${rd}, ${oldName} (account code ${oldCode}) operates as ${nn}, account code ${nc}. Same customer, same contract; records from now on use the new name.` });
        target.former = { name: oldName, code: oldCode, date: rd, doc };
        target.name = nn; target.base = nb; target.code = nc; target.slug = slugify(nn); target.crmDoc = `crm/${target.slug}`;
        for (const e of target.owner) if (e.kind === 'initial') e.doc = target.crmDoc;
        const ceDraw = addDays(rd, rng.int(5, 40));
        const ce = ceDraw <= today ? ceDraw : today;
        wrongExtra.push(nowValue(target, attr));
        if (attr === 'owner') {
          const next = draw(() => rng.pick(staff), x => x !== valueAsOf(target.owner, today), 'owners');
          const I = ident(target, { noManager: true });
          const hd = add({ id: `mail/${ce.slice(0, 7)}/${ce}-handoff-${slugify(nc)}`, title: () => `Handoff: ${I.name}`, type: 'email', date: ce, author: 'sales-ops@acme-example', refs: [I],
            body: () => `From: sales-ops@acme-example\nDate: ${ce}\nSubject: Handoff of ${I.name}\n\nEffective ${ce}, ${next} takes over as account owner for ${R.both(I.name, I.code)}.` });
          target.owner.push({ value: next, effective: ce, recorded: ce, doc: hd, kind: 'change' });
        } else {
          const events = attr === 'renewal_date' ? target.renewal : target.terms[attr];
          const value = attr === 'renewal_date' ? draw(() => rng.date('2026-10-01', '2027-09-30'), v => !historyValues(events).includes(v), 'dates') : draw(() => termValue(attr, rng, 'H3'), v => pairwiseClean([...historyValues(events), v]), 'H3 values');
          const I = ident(target);
          const am = add({ id: `contracts/${slugify(nn)}-amendment-1`, title: () => `Amendment No. 1: ${I.name}`, type: 'amendment', date: ce, author: 'legal@acme-example', refs: [I],
            body: () => R.frontmatterless(`Amendment No. 1 to the Master Services Agreement with ${R.both(I.name, I.code)}`, [`Status: Executed. Countersigned by both parties on ${longDate(ce)}.`, `Effective ${ce}, the ${label} change to ${value}. All other terms are unchanged.`]) });
          events.push({ value, effective: ce, recorded: ce, doc: am, kind: 'change' });
        }
        relevant.push(doc);
        evidence.push(doc);
      }
      relevant.push(target.contractDoc, target.crmDoc);
      evidence.push(target.contractDoc);
    }
    const gold = nowValue(holder, attr);
    const nL = rng.int(K.h3_lookalikes_min, K.h3_lookalikes_max);
    for (let k = 0; k < nL; k++) {
      let look: HardAccount | null = null;
      for (let attempt = 0; attempt < 50; attempt++) {
        const mark = docs.length;
        const cand = createAccount(`H3:${i}:look:${k}:${attempt}`, { role: 'H3-lookalike', base: prefix ? undefined : ambiguous, codePrefix: prefix });
        const v = nowValue(cand, attr);
        if (v !== gold && pairwiseClean([gold, v])) { look = cand; break; }
        accounts.pop();
        usedNames.delete(nameKey(cand.name)); usedNames.delete(nameKey(cand.code)); if (cand.nickname) usedNicknames.delete(cand.nickname);
        for (const d of docs.splice(mark)) ids.delete(d.id);
      }
      if (!look) throw new Error(`model-ladder-hard: H3 task index ${i}: no look-alike with a different value`);
      wrongExtra.push(nowValue(look, attr));
      relevant.push(look.contractDoc, look.crmDoc, ...attrDocs(look, attr));
    }
    relevant.push(...attrDocs(holder, attr), holder.contractDoc, holder.crmDoc);
    evidence.push(nowDoc(holder, attr));
    const who = prefix ? `the account whose code starts with ${prefix} and whose champion is ${target.champion}` : `the ${ambiguous} account whose champion is ${target.champion}`;
    const question = attr === 'payment_terms' ? `What payment terms are currently in force with ${who}?`
      : attr === 'seats' ? `How many licensed seats does ${who} have under contract right now?`
      : attr === 'renewal_date' ? `What is the current contract renewal date for ${who}?`
      : `Who is the account owner right now for ${who}?`;
    const wrong = [...new Set(wrongExtra.filter(v => v !== gold))];
    h3Targets.push({ task: i, base: ambiguous, prefix, champion: target.champion, variant, accountId: holder.id });
    tasks.push({ id: taskId('H3', i), family: 'H3', variant: `${variant}:${attr}`, answer_kind: 'value', accounts: [holder.id], question,
      gold: { answer: [gold], wrong, evidence: [...new Set(evidence)] }, relevant: [...new Set(relevant)] });
  }

  // Records written on or after a rename use the new name and code (the rename announcement says so); earlier ones keep the old.
  for (const a of accounts.filter(x => x.former)) {
    const f = a.former!;
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const oldBase = f.name.split(' ')[0], newBase = a.name.split(' ')[0];
    const subst = (text: string) => text.replace(new RegExp(esc(f.name), 'g'), a.name).replace(new RegExp(`\\b${esc(f.code)}\\b`, 'g'), a.code).replace(new RegExp(`\\b${esc(oldBase)}\\b`, 'g'), newBase);
    for (const d of docs) {
      if (!a.docIds.includes(d.id) || d.date < f.date) continue;
      const orig = d.body, origTitle = d.title;
      d.title = () => subst(text(origTitle));
      d.body = () => subst(text(orig));
    }
  }

  // ─── H4: conflicting sources by authority ─────────────────────────
  for (let i = 0; i < nTasks; i++) {
    const rng = rngFor(seed, 'task', 'H4', i);
    const a = createAccount(`H4:${i}`, { role: 'H4' });
    const variant = ['contract_holds', 'amended', 'later_effective_wins', 'future_effective'][i % 4];
    const attr = TERMS[Math.floor(i / 4) % 4];
    const label = R.TERM_LABELS[attr];
    const events = a.terms[attr];
    const values = [events[0].value];
    const fresh = () => { const v = draw(() => termValue(attr, rng, 'H4'), x => pairwiseClean([...values, x]), 'H4 values'); values.push(v); return v; };
    const executed: string[] = [a.contractDoc];
    const long = rng.chance(K.h4_long_document_rate);
    const amend = (k: number, eff: string, recorded: string, value: string, isLong: boolean) => {
      const I = ident(a);
      const head = () => [`# Amendment No. ${k} to the Master Services Agreement with ${R.both(I.name, I.code)}`, `Status: Executed. Countersigned by both parties on ${longDate(recorded)}.`];
      const deciding = `Effective ${eff}, the ${label} change to ${value}.`;
      const doc = add({ id: `contracts/${a.slug}-amendment-${k}`, title: () => `Amendment No. ${k}: ${I.name}`, type: 'amendment', date: recorded, author: 'legal@acme-example', refs: [I],
        body: body(`h4:${a.stream}:${k}`, r => isLong ? R.longExecuted(r, head(), deciding, r.int(26_000, 40_000)) : [...head(), deciding, 'All other terms are unchanged.'].join('\n\n')) });
      events.push({ value, effective: eff, recorded, doc, kind: 'change' });
      executed.push(doc);
    };
    if (variant === 'amended') { const e = rng.date('2026-01-10', '2026-07-31'); amend(1, e, addDays(e, -rng.int(0, 20)), fresh(), long); }
    if (variant === 'later_effective_wins') {
      const r1 = rng.date('2026-01-10', '2026-04-30'), e1 = rng.date(addDays(r1, 60), '2026-08-31');
      const r2 = rng.date(addDays(r1, 10), addDays(e1, -5) < today ? addDays(e1, -5) : today), e2 = rng.date(addDays(r1, 1), addDays(e1, -10));
      amend(1, e1, r1, fresh(), long);
      amend(2, e2, r2 > r1 ? r2 : addDays(r1, 1), fresh(), false);
    }
    if (variant === 'future_effective') { const r = rng.date('2026-07-01', '2026-09-10'); amend(1, rng.date(addDays(today, 20), addDays(today, 120)), r, fresh(), false); }
    if (variant === 'contract_holds' && long) {
      const otherTerms = TERMS.filter(t => t !== attr).map(t => `${R.TERM_LABELS[t][0].toUpperCase()}${R.TERM_LABELS[t].slice(1)}: ${a.terms[t][0].value}.`).join(' ');
      const I = ident(a);
      const head = () => [`# Master Services Agreement: Acme Example Inc. and ${I.name}`, `Status: Executed. Countersigned by both parties on ${longDate(a.signed)}.`,
        `Customer: ${I.name === I.code ? I.name : `${I.name} (account code ${I.code})`}. Segment: ${a.segment}. Region: ${a.region}.`, `Initial term: ${longDate(a.signed)} through ${longDate(a.renewal[0].value)}. Renewal date: ${a.renewal[0].value}.`,
        otherTerms, `Signed for ${I.name}: ${a.champion} (customer champion). Signed for Acme Example Inc.: ${acmeSigner}.`];
      const oldDoc = a.contractDoc;
      a.contractDoc = `contracts/${a.slug}-msa-full`;
      a.customContract = true;
      for (const ev of [...a.renewal, ...TERMS.flatMap(t => a.terms[t])]) if (ev.doc === oldDoc) ev.doc = a.contractDoc;
      const t0 = events[0].value;
      add({ id: a.contractDoc, title: () => `Master Services Agreement (full text): ${I.name}`, type: 'contract', date: a.signed, author: 'legal@acme-example', refs: [I],
        body: body(`h4full:${a.stream}`, r => R.longExecuted(r, head(), `The ${label} under this agreement is ${t0}.`, r.int(26_000, 40_000))) });
      executed[0] = a.contractDoc;
    }
    const lower: string[] = [];
    const nLower = Math.max(0, rng.int(K.h4_sources_min, K.h4_sources_max) - executed.length);
    const kinds = rng.shuffle(['draft', 'email', 'note', 'email2']).slice(0, nLower);
    for (const kind of kinds) {
      const v = fresh();
      const d = rng.date('2026-06-01', '2026-09-12');
      const I = ident(a);
      if (kind === 'draft') lower.push(add({ id: `contracts/${a.slug}-amendment-draft`, title: () => `DRAFT Amendment: ${I.name}`, type: 'amendment', date: d, author: 'legal@acme-example', refs: [I],
        body: () => R.frontmatterless(`DRAFT: Amendment to the Master Services Agreement with ${I.name}`, ['Status: Draft for discussion. Not signed by either party.', `Proposed: the ${label} change to ${v}.`]) }));
      else if (kind === 'note') lower.push(add({ id: `notes/agents/${d}-${a.slug}-terms`, title: () => `Agent summary: ${I.name} contract terms`, type: 'agent-note', date: d, author: 'agent:research-assistant', refs: [I],
        body: () => R.frontmatterless(`Contract terms summary: ${I.name} (auto-generated)`, [`${label[0].toUpperCase()}${label.slice(1)}: ${v}. Summarized from recent correspondence.`]) }));
      else {
        const from = rng.pick(staff);
        lower.push(add({ id: `mail/${d.slice(0, 7)}/${d}-re-${slugify(a.code)}-${slugify(label)}`, title: () => `Re: ${I.code} ${label}`, type: 'email', date: d, author: from, refs: [I],
          body: () => `From: ${from}\nDate: ${d}\nSubject: Re: ${I.code} ${label}\n\nSummary from the call: the ${label} for ${I.name} is ${v} now. Can someone double-check before the QBR deck goes out?` }));
      }
    }
    const gold = valueAsOf(events, today)!;
    const asked = refsOn || i % 2 === 0 ? a.name : a.code;
    tasks.push({ id: taskId('H4', i), family: 'H4', variant: `${variant}${long ? '+long' : ''}:${attr}`, answer_kind: 'value', accounts: [a.id],
      question: attr === 'seats' ? `How many licensed seats does ${asked} have under contract right now?`
        : attr === 'payment_terms' ? `What payment terms are currently in force with ${asked}?`
        : attr === 'uptime_sla' ? `What uptime SLA do we currently owe ${asked}?`
        : `What is the current liability cap in our agreement with ${asked}?`,
      gold: { answer: [gold], wrong: values.filter(v => v !== gold), evidence: [eventAsOf(events, today)!.doc] },
      relevant: [a.crmDoc, ...executed, ...lower] });
  }

  // ─── H5: memory across five sessions ──────────────────────────────
  const discount = (rng: Rng) => uniqueValue(rng, r => `DISC-${r.pick([...'ABCDEFGHJKLMNPQRSTUVWXYZ'])}${r.pick([...'ABCDEFGHJKLMNPQRSTUVWXYZ'])}${r.int(100, 999)}`, 'H5');
  for (let i = 0; i < nTasks; i++) {
    const rng = rngFor(seed, 'task', 'H5', i);
    const variant = i % 2 ? 'merge' : 'routing';
    const x = createAccount(`H5:${i}:x`, { role: 'H5', fresh: true });
    const record = 'Please record this in the knowledge base so that other people and agents see it. When it is recorded, submit the answer RECORDED.';
    let facts: Array<{ key: string; value: string; text: string; role: 'superseded' | 'required' | 'superseding' | 'noise' }>;
    let question: string, wrong: string[], relevant: string[];
    const docValues: Record<string, string> = {};
    let y: HardAccount | null = null;
    if (variant === 'routing') {
      const look = createAccount(`H5:${i}:look`, { role: 'H5-lookalike', base: x.base });
      const [pa, pb, pc] = [person(rng), person(rng), person(rng)];
      facts = [
        { key: `procurement_lead:${x.id}`, value: pa, role: 'superseded', text: `Quick update for the team: ${pa} is the procurement lead at ${x.name}.` },
        { key: `invoice_routing:${x.id}`, value: 'procurement lead', role: 'required', text: `Decision from today's call with ${x.name}: their renewal invoices go to their procurement lead from now on, not to the billing contact on file.` },
        { key: `procurement_lead:${x.id}`, value: pb, role: 'superseding', text: `Correction for ${x.code}: ${pb} is now the procurement lead at ${x.name}; ${pa} moved to another role.` },
        K.h5_noise_sessions ? { key: `procurement_lead:${look.id}`, value: pc, role: 'noise', text: `Quick update for the team: ${pc} is the procurement lead at ${look.name}.` }
          : { key: `kickoff:${x.id}`, value: addDays(today, 21), role: 'noise', text: `FYI: the ${x.name} expansion kickoff is set for ${addDays(today, 21)}.` },
      ];
      docValues.billing = x.billing;
      question = `I'm sending the renewal invoice for ${x.name}. Who should receive it?`;
      wrong = [pa, x.billing, ...(K.h5_noise_sessions ? [pc] : [])];
      relevant = [x.crmDoc, x.contractDoc, look.crmDoc];
    } else {
      y = createAccount(`H5:${i}:y`, { role: 'H5', fresh: true });
      const ly = createAccount(`H5:${i}:look`, { role: 'H5-lookalike', base: y.base });
      const [dx0, dy0, d1, d2, d3] = [discount(rng), discount(rng), discount(rng), discount(rng), discount(rng)];
      const codeDocs: string[] = [];
      for (const [acc, code] of [[x, dx0], [y, dy0]] as const) {
        const d = rng.date('2026-03-01', '2026-08-31');
        const I = ident(acc);
        codeDocs.push(add({ id: `mail/${d.slice(0, 7)}/${d}-discount-code-${slugify(acc.code)}`, title: () => `Discount code: ${I.code}`, type: 'email', date: d, author: 'billing@acme-example', refs: [I],
          body: () => `From: billing@acme-example\nDate: ${d}\nSubject: Discount code for ${I.code}\n\nThe discount code on file for ${I.name} orders is ${code}.` }));
      }
      docValues.dx0 = dx0; docValues.dy0 = dy0;
      facts = [
        { key: `discount_code:${x.id}`, value: d1, role: 'superseded', text: `Quick update for the team: the discount code for ${x.name} orders is now ${d1}.` },
        { key: `merged_into:${y.id}`, value: x.id, role: 'required', text: `Heads up: ${y.name} is being folded into ${x.name}. From today, ${possessive(y.name)} orders use ${possessive(x.name)} discount code.` },
        { key: `discount_code:${x.id}`, value: d2, role: 'superseding', text: `Correction for ${x.code}: the discount code for ${x.name} is ${d2}. ${d1} is retired.` },
        K.h5_noise_sessions ? { key: `discount_code:${ly.id}`, value: d3, role: 'noise', text: `Quick update for the team: the discount code for ${ly.name} orders is now ${d3}.` }
          : { key: `kickoff:${x.id}`, value: addDays(today, 21), role: 'noise', text: `FYI: the ${x.name} expansion kickoff is set for ${addDays(today, 21)}.` },
      ];
      question = `What discount code goes on ${possessive(y.name)} next order?`;
      wrong = [d1, dx0, dy0, ...(K.h5_noise_sessions ? [d3] : [])];
      relevant = [x.crmDoc, y.crmDoc, ly.crmDoc, ...codeDocs];
    }
    let order: number[];
    do order = rng.shuffle([0, 1, 2, 3]); while (order.indexOf(0) > order.indexOf(2));
    const sessionFacts: SessionFact[] = order.map((fi, s) => ({ session: s + 1, key: facts[fi].key, value: facts[fi].value, required: facts[fi].role === 'required' || facts[fi].role === 'superseding' }));
    const supersededAt = order.indexOf(0) + 1, supersedingAt = order.indexOf(2) + 1;
    sessionFacts[supersededAt - 1].superseded_by = supersedingAt;
    const statements: UserStatement[] = sessionFacts.map(f => ({ session: f.session, key: f.key, value: f.value }));
    const gold = h5Resolve(variant, statements, { x: x.id, y: y?.id ?? null, ...docValues })!;
    const stateNow = (key: string) => statedValue(statements, key, null);
    const note = variant === 'routing'
      ? `Recorded from team updates (sessions 1 to 4):\n- ${x.name}: procurement lead is ${stateNow(`procurement_lead:${x.id}`)} (this replaces an earlier entry).\n- ${x.name}: renewal invoices go to the procurement lead, not to the billing contact on file.`
      : `Recorded from team updates (sessions 1 to 4):\n- ${y!.name} is folded into ${x.name}; ${possessive(y!.name)} orders use ${possessive(x.name)} discount code.\n- ${x.name}: discount code is ${stateNow(`discount_code:${x.id}`)} (this replaces an earlier entry).`;
    tasks.push({
      id: taskId('H5', i), family: 'H5', variant, answer_kind: 'value', accounts: [x.id, ...(y ? [y.id] : [])],
      sessions: order.map(fi => `${facts[fi].text} ${record}`), question,
      gold: { answer: [gold], wrong: [...new Set(wrong)].filter(v => v !== gold), evidence: [] },
      relevant, oracle_notes: [{ id: `notes/${taskId('H5', i).toLowerCase()}-ideal-store`, title: 'Recorded team updates', body: note }], session_facts: sessionFacts,
    });
  }

  // ─── Background population ────────────────────────────────────────
  for (let k = 0; k < K.accounts; k++) createAccount(`bg:${k}`, { role: 'background' });

  // ─── H1: many-record questions over the whole 4k population ──────
  const population = () => accounts.filter(a => !a.mergedInto);
  const h1Tasks: Array<{ task: HardTask; predicate: H1Predicate }> = [];
  for (let i = 0; i < nTasks; i++) {
    const rng = rngFor(seed, 'task', 'H1', i);
    const template = i % 6;
    const facts = population().map(factsOf);
    let found: { p: H1Predicate; members: string[]; nearMisses: string[]; q: string; kind: 'set' | 'count' } | null = null;
    for (let attempt = 0; attempt < 5000 && !found; attempt++) {
      const asOf = rng.chance(0.4) ? today : rng.date('2026-03-01', '2026-09-14');
      const st = rng.pick(staff), seg = rng.pick(R.SEGMENTS), reg = rng.pick(R.REGIONS), days = rng.pick([30, 45, 60, 90, 120]);
      const spec: { clauses: H1Clause[]; q: string; kind: 'set' | 'count' } =
        template === 0 ? { clauses: [{ kind: 'owner', staff: st }], kind: 'count', q: `How many accounts did ${st} own on ${asOf}?` }
        : template === 1 ? { clauses: [{ kind: 'owner', staff: st }], kind: 'set', q: `Which accounts did ${st} own on ${asOf}?` }
        : template === 2 ? { clauses: [{ kind: 'segment', segment: seg }, { kind: 'open_escalated_ticket' }], kind: 'set', q: `Which ${seg} accounts had an open escalated support ticket on ${asOf}?` }
        : template === 3 ? { clauses: [{ kind: 'open_escalated_ticket' }, { kind: 'renewal_within', days }], kind: 'count', q: `How many accounts had an open escalated support ticket and a contract renewal date within ${days} days on ${asOf}?` }
        : template === 4 ? { clauses: [{ kind: 'open_escalated_ticket' }, { kind: 'renewal_within', days }], kind: 'set', q: `Which accounts had an open escalated support ticket and a contract renewal date within ${days} days on ${asOf}?` }
        : { clauses: [{ kind: 'region', region: reg }, { kind: 'renewal_within', days }], kind: 'count', q: `How many ${reg} accounts had a contract renewal date within ${days} days of ${asOf}?` };
      const p: H1Predicate = { as_of: asOf, clauses: spec.clauses };
      const r = evaluatePredicate(p, facts);
      if (r.members.length >= K.h1_min_members && r.members.length <= K.h1_max_members && !h1Tasks.some(t => JSON.stringify(t.predicate) === JSON.stringify(p)) && !onEdge(p, facts)) found = { p, ...r, q: spec.q, kind: spec.kind };
    }
    if (!found) throw new Error(`model-ladder-hard: H1 task index ${i}: no predicate with ${K.h1_min_members} to ${K.h1_max_members} members (lower h1_min_members or add accounts)`);
    const byId = new Map(accounts.map(a => [a.id, a]));
    const members = found.members.map(id => byId.get(id)!).sort((p, q) => p.name.localeCompare(q.name));
    const format = found.kind === 'set'
      ? 'Answer with a JSON array of account names, as one string in `answer`, for example ["Quorvane Systems","Telmiro Labs"]. Use [] if there are none.'
      : 'Answer with the number only in `answer`, for example 12.';
    const task: HardTask = {
      id: taskId('H1', i), family: 'H1', variant: `${['count_owner', 'set_owner', 'set_segment_escalated', 'count_escalated_renewal', 'set_escalated_renewal', 'count_region_renewal'][template]}${found.p.as_of === today ? '+today' : ''}`,
      answer_kind: found.kind, accounts: [], question: `${found.q} ${format}`,
      gold: { ...(found.kind === 'set' ? { members: members.map(a => ({ id: a.id, names: [a.name, ...aliasesOf(a)] })) } : {}), ...(found.kind === 'count' ? { count: members.length } : {}), evidence: [...new Set(members.flatMap(a => h1Docs(a, found!.p)))] },
      relevant: [], predicate: found.p,
    };
    h1Tasks.push({ task, predicate: found.p });
  }

  /** Every H3 disambiguation names exactly one account among all accounts sharing the ambiguous name or code prefix. */
  const h3Problems = () => h3Targets.flatMap(t => {
    const named = [...accounts, ...appended].filter(a => t.prefix ? [a.code, a.former?.code].some(c => c?.startsWith(t.prefix!)) : [a.name, a.former?.name].some(n => n?.startsWith(`${t.base} `)));
    const hits = named.filter(a => a.champion === t.champion).length;
    return hits === 1 ? [] : [`H3 task index ${t.task}: ${hits} accounts match the disambiguating fact`];
  });
  if (scale === 'v1' && h3Problems().length) throw new Error(`model-ladder-hard: ${h3Problems().join('; ')}`);

  // ─── 50k append ───────────────────────────────────────────────────
  const n4kAccounts = accounts.length;
  if (scale === 'large') {
    const h1Preds = h1Tasks.map(t => t.predicate);
    const satisfiesAny = (a: HardAccount) => h1Preds.some(p => p.clauses.every(c => clauseHolds(c, factsOf(a), p.as_of)));
    const lookalikeSpecs = h3Targets.flatMap(t => Array.from({ length: LARGE_LOOKALIKES_PER_H3 }, () => t));
    const docsBefore = docs.length;
    for (let k = 0; k < K.large_extra_accounts; k++) {
      const wanted = lookalikeSpecs[k];
      const spec = wanted && (wanted.prefix || R.SUFFIX.some(sf => !usedNames.has(nameKey(`${wanted.base} ${sf}`)))) ? wanted : undefined;
      let a: HardAccount | null = null;
      for (let attempt = 0; attempt < 60; attempt++) {
        const mark = docs.length;
        const cand = createAccount(`large:${k}:${attempt}`, { role: spec ? 'large-lookalike' : 'large', large: true, base: spec && !spec.prefix ? spec.base : undefined, codePrefix: spec?.prefix });
        if (!satisfiesAny(cand)) { a = cand; for (const d of docs.slice(mark)) appendedDocIds.add(d.id); break; }
        appended.pop();
        usedNames.delete(nameKey(cand.name)); usedNames.delete(nameKey(cand.code)); if (cand.nickname) usedNicknames.delete(cand.nickname);
        for (const d of docs.splice(mark)) ids.delete(d.id);
      }
      if (!a) throw new Error(`model-ladder-hard: appended account index ${k} satisfies an H1 predicate after 60 draws`);
    }
    const teamRng = rngFor(seed, 'large-team');
    const extraUpdates = Math.round(K.team_updates * appended.length / Math.max(1, n4kAccounts));
    for (let k = 0; k < extraUpdates; k++) teamUpdate(teamRng, k, appended, 'large');
    for (const a of population()) {
      const rng = rngFor(seed, 'large-nd', a.stream);
      for (let k = 0; k < K.large_nondeciding_per_account; k++) {
        const kind = R.NONDECIDING_KINDS[k % R.NONDECIDING_KINDS.length];
        const d = rng.date('2025-10-01', '2026-09-14');
        const I = ident(a);
        if (kind === 'logistics') add({ id: `logistics/${d.slice(0, 7)}/${d}-${slugify(a.code)}-visit`, title: () => `Logistics: ${I.code} visit`, type: 'email', date: d, author: 'events@acme-example', refs: [I], body: body(`nd:${a.stream}:${k}`, r => R.logisticsBody(r, { name: I.name, date: d })) });
        else if (kind === 'correspondence') add({ id: `mail/${d.slice(0, 7)}/${d}-${slugify(a.code)}-correspondence`, title: () => `Email: ${I.code}`, type: 'email', date: d, author: a.champion, refs: [I], body: body(`nd:${a.stream}:${k}`, r => R.routineEmail(r, { from: a.champion, date: d, ref: I.alt(r.chance(0.5)) }).body) });
        else {
          const closed = addDays(d, rng.int(0, 5)) <= today ? addDays(d, rng.int(0, 5)) : d;
          const tk: Ticket = { id: ticketId(rng), opened: d, closed, topic: rng.pick(R.UNRELATED_TICKET_TOPICS), doc: '' };
          tk.doc = addTicket(a, tk, false);
          a.tickets.push(tk);
        }
      }
    }
    const allFacts = [...population(), ...appended].map(factsOf);
    const problems: string[] = [];
    h1Tasks.forEach(({ task, predicate }, i) => {
      const before = evaluatePredicate(predicate, population().map(factsOf)).members.sort();
      const after = evaluatePredicate(predicate, allFacts).members.sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) problems.push(`H1 task index ${i}: key differs (members 4k=${before.length}, 50k=${after.length})`);
      void task;
    });
    problems.push(...h3Problems());
    if (problems.length) throw new Error(`model-ladder-hard: 50k invariance failed (${problems.length}): ${problems.join('; ')}`);
    void docsBefore;
  }

  // ─── Shared records and team updates for the 4k accounts ─────────
  for (const a of accounts) recordDocs(a);
  for (const a of appended) { const mark = docs.length; recordDocs(a); for (const d of docs.slice(mark)) appendedDocIds.add(d.id); }
  const teamRng4k = rngFor(seed, 'team');
  for (let k = 0; k < K.team_updates; k++) teamUpdate(teamRng4k, k, population(), '4k');

  // H1 oracle evidence: members' deciding records plus near misses, in seeded order, capped.
  const everyone = scale === 'large' ? [...population(), ...appended] : population();
  const byIdAll = new Map(everyone.map(a => [a.id, a]));
  for (const { task, predicate } of h1Tasks) {
    const { members, nearMisses } = evaluatePredicate(predicate, everyone.map(factsOf));
    const order = (id: string) => createHash('sha256').update(`${seed}:${task.id}:${id}`).digest('hex');
    const near = [...nearMisses].sort((p, q) => order(p).localeCompare(order(q)));
    const kept = near.slice(0, K.h1_near_miss_cap);
    task.near_miss = { total: near.length, in_evidence: kept.length };
    task.relevant = [...new Set([...members.flatMap(id => h1Docs(byIdAll.get(id)!, predicate)), ...kept.flatMap(id => h1Docs(byIdAll.get(id)!, predicate))])];
    tasks.unshift(task);
  }
  tasks.sort((p, q) => p.id.localeCompare(q.id));

  function teamUpdate(rng: Rng, k: number, pool: HardAccount[], tag: string) {
    const d = rng.date('2025-10-01', '2026-09-14');
    const team = rng.pick(['Platform', 'Support', 'Solutions', 'Partnerships', 'Growth']);
    const picked = rng.shuffle(pool).slice(0, 3).map(a => ident(a));
    const tid = add({ id: `team/updates/${d}-${slugify(team)}-${tag}-${k}`, title: `${team} team update ${d}`, type: 'team-update', date: d, author: `${team.toLowerCase()}@acme-example`, refs: picked,
      body: body(`team:${tag}:${k}`, r => R.teamUpdateBody(r, { team, date: d, refs: picked.map(I => I.alt(r.chance(0.5))) })) });
    if (tag === 'large') appendedDocIds.add(tid);
  }

  const references = refsOn ? resolveReferences() : [];

  /**
   * Generator v2, once the ledger is complete: draw each reference's form, fall back from the manager form where it
   * would not name exactly one account on the record's date, add the resolution documents each oracle record needs,
   * and give event documents opaque ids.
   */
  function resolveReferences(): HardReference[] {
    const all = [...accounts, ...appended];
    const byDescriptor = new Map<string, HardAccount[]>();
    for (const a of all) byDescriptor.set(descriptorOf(a), [...(byDescriptor.get(descriptorOf(a)) ?? []), a]);
    const weighted = (u: number, opts: Array<[RefForm, number]>): RefForm => {
      let x = u * opts.reduce((t, [, w]) => t + w, 0);
      for (const [f, w] of opts) { if (w > 0 && x < w) return f; x -= w; }
      return 'code';
    };
    const managerText = (I: Ident, date: string) => {
      const a = I.account;
      const m = I.noManager || a.mergedInto ? null : managerKnownOn(a.owner, date);
      if (!m || byDescriptor.get(descriptorOf(a))!.some(b => b !== a && managerReadingsOn(b.owner, date).has(m))) return null;
      return managerReference(m, descriptorOf(a));
    };
    const before = (a: HardAccount, date: string) => !!a.former && date < a.former.date;
    for (const d of docs) (d.refs ?? []).forEach((I, k) => {
      const rng = rngFor(seed, 'ref', d.id, k);
      const a = I.account;
      let form: RefForm = rng.chance(K.direct_name_share!) ? 'name' : weighted(rng.float(), [['code', K.code_ref_weight!], ['nickname', K.nickname_ref_weight!], ['manager', K.manager_ref_weight!]]);
      const manager = form === 'manager' ? managerText(I, d.date) : null;
      if (form === 'manager' && !manager) form = weighted(rng.float(), [['code', K.code_ref_weight!], ['nickname', K.nickname_ref_weight!]]);
      const name = before(a, d.date) ? a.former!.name : a.name, code = before(a, d.date) ? a.former!.code : a.code;
      I.resolved = { form, text: form === 'name' ? name : form === 'code' ? code : form === 'nickname' ? a.nickname! : manager!, name, code };
    });

    const byId = new Map(docs.map(d => [d.id, d]));
    const mergerDoc = new Map(all.flatMap(h => h.mergedIn.map(m => [all.find(x => x.mergedInto === h.id && x.name === m.name)!.id, m.doc] as const)));
    const linksOf = (I: Ident, date: string): string[] => {
      const a = I.account, f = I.resolved!.form;
      const out = [...(a.mergedInto ? [mergerDoc.get(a.id)!] : []), ...(f === 'name' && before(a, date) ? [a.former!.doc] : [])];
      if (f === 'code') out.push(a.crmDoc);
      if (f === 'nickname' || f === 'manager') out.push(a.sheetDoc!);
      if (f === 'manager') for (const e of a.owner) if (e.recorded <= date) out.push(e.doc, ...(byId.get(e.doc)?.refs ?? []).flatMap(J => linksOf(J, e.recorded)));
      return out;
    };
    const withLinks = (ids: string[]) => [...new Set([...ids, ...ids.flatMap(id => { const d = byId.get(id)!; return (d.refs ?? []).flatMap(I => linksOf(I, d.date)); })])];
    for (const t of tasks) { t.relevant = withLinks(t.relevant); t.gold.evidence = withLinks(t.gold.evidence); }

    const remap = new Map<string, string>();
    for (const d of docs) {
      if (d.resolution) continue;
      const slash = d.id.lastIndexOf('/');
      const date = /^\d{4}-\d{2}-\d{2}-/.exec(d.id.slice(slash + 1))?.[0] ?? '';
      remap.set(d.id, `${d.id.slice(0, slash)}/${date}${createHash('sha256').update(`${seed}:${d.id}`).digest('hex').slice(0, 10)}`);
    }
    if (new Set(remap.values()).size !== remap.size) throw new Error('model-ladder-hard: two event documents got the same opaque id');
    const re = (id: string) => remap.get(id) ?? id;
    for (const d of docs) d.id = re(d.id);
    for (const t of tasks) { t.relevant = t.relevant.map(re); t.gold.evidence = t.gold.evidence.map(re); }
    for (const a of all) {
      a.docIds = a.docIds.map(re);
      a.contractDoc = re(a.contractDoc);
      for (const e of [...a.owner, ...a.renewal, ...TERMS.flatMap(t => a.terms[t])]) e.doc = re(e.doc);
      for (const tk of a.tickets) tk.doc = re(tk.doc);
    }
    const appendedNow = [...appendedDocIds].map(re);
    appendedDocIds.clear();
    for (const id of appendedNow) appendedDocIds.add(id);
    return docs.flatMap(d => (d.refs ?? []).map(I => ({ doc: d.id, entity: I.account.mergedInto ?? I.account.id, form: I.resolved!.form, text: I.resolved!.text })));
  }

  return {
    seed, knobs: K, scale, staff, accounts, appended, tasks, docs, appendedDocIds, references,
    facts: () => [...population(), ...appended].map(factsOf),
  };
}

const possessive = (n: string) => (n.endsWith('s') ? `${n}'` : `${n}'s`);

/**
 * True when an account's membership would turn on a boundary a reader can take either way: an owner change or a
 * ticket event dated exactly on the as-of date, or a renewal date on the first or last day of the window (or one day
 * past it), for an account that holds every other clause. The generator draws another predicate instead.
 */
export function onEdge(p: H1Predicate, facts: readonly PredicateFacts[]): boolean {
  const end = (days: number) => { const d = new Date(`${p.as_of}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  for (const c of p.clauses) for (const f of facts) {
    if (!p.clauses.every(o => o === c || clauseHolds(o, f, p.as_of))) continue;
    if (c.kind === 'owner' && f.owner.some(e => e.effective === p.as_of)) return true;
    if (c.kind === 'open_escalated_ticket' && f.tickets.some(t => [t.opened, t.escalated, t.closed].includes(p.as_of))) return true;
    if (c.kind === 'renewal_within') { const r = valueAsOf(f.renewal, p.as_of); if (r && [p.as_of, end(c.days), end(c.days + 1)].includes(r)) return true; }
  }
  return false;
}

/** The documents that decide each clause of an H1 predicate for one account. */
function h1Docs(a: HardAccount, p: H1Predicate): string[] {
  // A renamed or merged account's records name it more than one way; the announcement that links the names decides too.
  const out: string[] = [...(a.former ? [a.former.doc] : []), ...a.mergedIn.map(m => m.doc)];
  for (const c of p.clauses) {
    if (c.kind === 'owner') out.push(...a.owner.map(e => e.doc));
    else if (c.kind === 'segment' || c.kind === 'region') out.push(a.crmDoc);
    else if (c.kind === 'open_escalated_ticket') out.push(...a.tickets.map(t => t.doc));
    else out.push(...a.renewal.map(e => e.doc));
  }
  return [...new Set(out)];
}

/**
 * The H5 answer from the user statements of a session chain (later
 * statements win) and the document values. Exported for the counterfactual
 * tests: removing a required statement changes or voids the answer.
 */
export function h5Resolve(variant: string, statements: readonly UserStatement[], ctx: { x: string; y: string | null; billing?: string; dx0?: string; dy0?: string }): string | null {
  if (variant === 'routing') {
    const routing = statedValue(statements, `invoice_routing:${ctx.x}`, null);
    return routing === 'procurement lead' ? statedValue(statements, `procurement_lead:${ctx.x}`, null) : ctx.billing ?? null;
  }
  const merged = statedValue(statements, `merged_into:${ctx.y}`, null) === ctx.x;
  return merged ? statedValue(statements, `discount_code:${ctx.x}`, ctx.dx0 ?? null) : statedValue(statements, `discount_code:${ctx.y}`, ctx.dy0 ?? null);
}

// ─── World ──────────────────────────────────────────────────────────

export function generateHardWorld(seed: number = HARD_SEEDS.calibration, knobs: HardKnobs = DEFAULT_HARD_KNOBS, opts: { scale?: 'v1' | 'large'; skipSizeCheck?: boolean } = {}): HardWorld {
  const scale = opts.scale ?? 'v1';
  const b = buildHardLedger(seed, knobs, { scale });
  const docs: LadderDoc[] = b.docs.map(({ refs: _r, resolution: _s, ...d }) => ({ ...d, title: text(d.title), body: text(d.body) })).sort((x, y) => x.id.localeCompare(y.id));
  const v2 = b.references.length > 0;
  const entities: HardEntity[] = [...b.accounts, ...b.appended].filter(a => !a.mergedInto).map(a => ({
    id: a.id, name: a.name, aliases: aliasesOf(a),
    ...(v2 ? { refs: {
      codes: [a.code, ...(a.former ? [a.former.code] : []), ...a.mergedIn.map(m => m.code)], nicknames: [a.nickname!, ...a.mergedIn.map(m => m.nickname!)], descriptor: descriptorOf(a),
      managers: a.owner.map(e => ({ name: e.value, effective: e.effective, recorded: e.recorded, doc: e.doc })),
    } } : {}),
  }));
  const world: HardWorld = {
    version: hardGeneratorVersion(knobs), mode: 'hard', seed, ...(scale === 'large' ? { scale: 'large' as const } : {}),
    knob_schema: knobSchemaOf(knobs), knobs, knob_digest: knobDigest(knobs), max_turns: knobs.max_turns,
    today: HARD_TODAY, principal: HARD_PRINCIPAL, entities, docs, tasks: b.tasks, ...(v2 ? { references: b.references } : {}),
  };
  if (scale === 'large') {
    world.base_digest = hardWorldDigest(generateHardWorld(seed, knobs, { skipSizeCheck: opts.skipSizeCheck }));
    const fourK = new Set(b.accounts.filter(a => !a.mergedInto).flatMap(a => [a.name, ...aliasesOf(a)]));
    const bad = appendedNaming4k(docs, b, fourK);
    if (bad) throw new Error(`model-ladder-hard: 50k invariance failed: ${bad} appended-account documents name a 4k account`);
  }
  const [lo, hi] = HARD_SIZE[scale];
  if (!opts.skipSizeCheck && (docs.length < lo || docs.length > hi)) throw new Error(`model-ladder-hard: the ${scale === 'large' ? '50k' : '4k'} world has ${docs.length} documents, outside ${lo}-${hi}; change the accounts or large_extra_accounts knob`);
  assertHardWorld(world);
  return world;
}

/** Appended-account documents (contracts, CRM, mail, meetings, tickets, notes of appended accounts) that name a 4k account; 0 when clean. */
function appendedNaming4k(docs: LadderDoc[], b: HardBuild, fourK: Set<string>): number {
  const appendedDoc = (d: LadderDoc) => b.appendedDocIds.has(d.id);
  const re = new RegExp(`\\b(${[...fourK].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
  let bad = 0;
  for (const d of docs) if (appendedDoc(d) && re.test(d.body)) bad++;
  return bad;
}

export function hardWorldDigest(w: HardWorld): string {
  return createHash('sha256').update(JSON.stringify(w)).digest('hex');
}

export interface HardManifest { version: string; seed: number; scale: 'v1' | 'large'; digest: string; base_digest?: string; knob_digest: string; file_sha256: string; bytes: number; docs: number; tasks: number; by_type: Record<string, number>; by_family: Record<string, number>; command: string }

export function hardManifest(world: HardWorld, text: string, knobsPath: string): HardManifest {
  const by_type: Record<string, number> = {};
  for (const d of world.docs) by_type[d.type] = (by_type[d.type] ?? 0) + 1;
  return {
    version: world.version, seed: world.seed, scale: world.scale ?? 'v1', digest: hardWorldDigest(world), ...(world.base_digest ? { base_digest: world.base_digest } : {}),
    knob_digest: world.knob_digest, file_sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), docs: world.docs.length, tasks: world.tasks.length, by_type,
    by_family: Object.fromEntries(HARD_FAMILIES.map(f => [f, world.tasks.filter(t => t.family === f).length])),
    command: `bun eval/generators/model-ladder-gen.ts --mode hard --seed ${world.seed} --knobs ${knobsPath}${world.scale ? ' --scale large --base-world <4k world.json>' : ''}`,
  };
}

/** The default knob file: knobs.frozen.json once the generator is frozen, else knobs.default.json. */
export function defaultKnobsPath(): string {
  const frozen = join(HARD_KNOBS_DIR, 'knobs.frozen.json');
  return existsSync(frozen) ? frozen : join(HARD_KNOBS_DIR, 'knobs.default.json');
}

export function loadKnobs(path: string): HardKnobs {
  if (!existsSync(path)) throw new Error(`no knob file at ${path}. Pass --knobs <file.json>; docs/benchmarks/cat40-hard/knobs.default.json lists every key.`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`${path} is not valid JSON: ${(e as Error).message}`); }
  return validateKnobs(raw, path);
}

export const HARD_GEN_USAGE = `Usage: bun eval/generators/model-ladder-gen.ts --mode hard [options]

  --seed <n>             world seed (calibration ${HARD_SEEDS.calibration}, smoke ${HARD_SEEDS.smoke}, held-out ${HARD_SEEDS.heldout}); default ${HARD_SEEDS.calibration}
  --knobs <file.json>    knob file (default: docs/benchmarks/cat40-hard/knobs.frozen.json when it exists, else knobs.default.json)
  --scale large          the 50k world: the 4k world plus appended accounts; needs --base-world
  --base-world <path>    the 4k world.json the 50k world extends; refused unless it matches seed and knobs
  --out <dir>            output directory (default eval/reports/cat40/hard/seed-<seed>[-large])
  --check                compare <out>/world.json with a fresh generation instead of writing
  --help                 this text`;

/** CLI body for `--mode hard`; `args` are already validated flag values. */
export function hardGenMain(args: { seed?: string; knobs?: string; scale?: string; out?: string; 'base-world'?: string; check?: boolean }): number {
  const seed = args.seed === undefined ? HARD_SEEDS.calibration : Number(args.seed);
  if (!Number.isSafeInteger(seed)) throw new Error(`--seed must be an integer (got ${JSON.stringify(args.seed)})`);
  const scale = (args.scale ?? 'v1') as 'v1' | 'large';
  if (scale !== 'v1' && scale !== 'large') throw new Error(`--scale must be v1 or large, not ${args.scale}`);
  const knobsPath = resolve(args.knobs ?? defaultKnobsPath());
  const knobs = loadKnobs(knobsPath);
  const out = resolve(args.out ?? `eval/reports/cat40/hard/seed-${seed}${scale === 'large' ? '-large' : ''}`);
  if (scale === 'large') {
    if (!args['base-world']) throw new Error('--scale large needs --base-world <4k world.json>: the 50k world extends that exact 4k world');
    const base = JSON.parse(readFileSync(resolve(args['base-world']), 'utf8')) as HardWorld;
    const differs = (['seed', 'version', 'knob_digest'] as const).filter(k => base[k] !== (k === 'seed' ? seed : k === 'version' ? hardGeneratorVersion(knobs) : knobDigest(knobs)));
    if (differs.length) throw new Error(`--base-world ${args['base-world']} differs in ${differs.join(', ')} from this generation. Fix: repeat the 4k world's seed and --knobs, or regenerate the 4k world first.`);
    const regenerated = hardWorldDigest(generateHardWorld(seed, knobs));
    if (regenerated !== hardWorldDigest(base)) throw new Error(`--base-world ${args['base-world']} does not match its generator (digest ${hardWorldDigest(base).slice(0, 12)}, regenerated ${regenerated.slice(0, 12)}); regenerate the 4k world first`);
  }
  const world = generateHardWorld(seed, knobs, { scale });
  const text = JSON.stringify(world, null, 1) + '\n';
  const path = join(out, 'world.json');
  const manifestPath = join(out, 'manifest.json');
  if (args.check) {
    const same = existsSync(path) && readFileSync(path, 'utf8') === text;
    console.log(same ? `ok: ${path} matches seed ${seed} and ${knobsPath}` : `DIFFERS: ${path}`);
    return same ? 0 : 1;
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path, text);
  const manifest = hardManifest(world, text, knobsPath);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ path, docs: world.docs.length, tasks: world.tasks.length, by_family: manifest.by_family, digest: manifest.digest, knob_digest: world.knob_digest, file_sha256: manifest.file_sha256 }));
  return 0;
}

