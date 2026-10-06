/**
 * Cat 40 Hard, sealed validation variant (gate decision CEO-UC2,
 * docs/benchmarks/cat40-hard/SEALED.md).
 *
 * Writes Hard worlds that satisfy eval/generators/hard/schema.ts and pass
 * validate.ts, with answer keys computed through hard/semantics.ts, in its
 * own document styles, alias conventions, folder layout and fictional
 * company. Deterministic from (seed, knobs, scale).
 */
import { createHash } from 'node:crypto';
import type { LadderDoc } from '../model-ladder-gen.ts';
import { DEFAULT_HARD_KNOBS, H5_SESSIONS, hasReferenceKnobs, knobDigest, knobSchemaOf, type H1Clause, type H1Predicate, type HardEntity, type HardFamily, type HardKnobs, type HardReference, type HardTask, type HardWorld, type RefForm, type SessionFact } from '../hard/schema.ts';
import { clauseHolds, correctionOf, evaluatePredicate, eventAsOf, historyValues, managerKnownOn, managerReadingsOn, managerReference, nameRegistry, statedValue, valueAsOf, type PredicateFacts, type UserStatement, type ValueEvent } from '../hard/semantics.ts';
import { assertHardWorld } from '../hard/validate.ts';
import { normalizeValue } from '../../runner/cat40/score.ts';
import { Rng } from './rng.ts';
import * as P from './pools.ts';
import {
  TODAY, EPOCH, addDays, maxDate, minDate, randomDate, distinctDates, longDate, currentName, nameAt, nextId, folder, cardId, changesId, formId, profileId, descriptorOf,
  type Acct, type ChangeOrder, type ChangeRow, type Ticket, type Who,
} from './ledger.ts';
import * as R from './render.ts';

/** Version string of sealed worlds from a knob file without the reference-form keys; the runner's regenerator registry uses it as the key. */
export const SEALED_VERSION = 'hard-sealed';
/** Version string of sealed worlds from a knob file with the reference-form keys (knob schema 2). */
export const SEALED_VERSION_V2 = 'hard-sealed-v2';

/** One drawn account reference: the customer (a merged-away one included), its form and text, and the record's date. */
interface Cite { acct: Acct; form: RefForm; text: string; date: string }

type Fact =
  | { kind: 'region'; region: string }
  | { kind: 'segment'; segment: string }
  | { kind: 'lead-on'; date: string; staff: string }
  | { kind: 'ticket'; key: string };

interface H3Spec { task: number; token: { kind: 'first-word' | 'code-prefix'; value: string }; fact: Fact; target: string }

/** What the H5 dependency check needs about a task (or one item of a multi-account task) beyond the world: the site directory's contacts. */
export interface H5Ledger { task: string; item: number; account: string; directory: Record<string, string> }

const pad2 = (n: number) => String(n).padStart(2, '0');
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** No value is equal to, or a substring of, another after normalization. */
function substringFree(values: string[]): boolean {
  const n = values.map(normalizeValue);
  for (let a = 0; a < n.length; a++) for (let b = 0; b < n.length; b++) if (a !== b && n[a].includes(n[b])) return false;
  return true;
}

class Builder {
  accts: Acct[] = [];
  byId = new Map<string, Acct>();
  names = new Set<string>();
  firstWords = new Set<string>();
  prefixes = new Set<string>();
  ticketKeys = new Set<string>();
  bulletins: Array<{ id: string; no: number; date: string; items: string[]; announce?: { acct: Acct; text: (w: Who) => string } }> = [];
  h3: H3Spec[] = [];
  h5: H5Ledger[] = [];
  predicates: H1Predicate[] = [];

  /** Reference forms are on: the knobs carry them and not every reference is by name. */
  readonly v2: boolean;
  /** Reference forms drawn so far, by the document's readable id. */
  cites = new Map<string, Cite[]>();
  /** Documents that record an account-lead change; they never use the lead form. */
  timeline = new Set<string>();
  /** Resolution documents besides record cards and profiles: rename and merger notices and slips. */
  resolution = new Set<string>();
  /** Rename and merger documents by the customer whose names they link. */
  links = new Map<string, string[]>();
  nicknames = new Set<string>();
  /** Multi-account questions: descriptors and account leads taken by earlier items of the question being built. */
  guard: { descriptors: Set<string>; managers: Set<string> } | null = null;
  private descIndex?: { n: number; map: Map<string, Acct[]> };

  constructor(readonly seed: number, readonly k: HardKnobs) {
    this.v2 = hasReferenceKnobs(k) && (k.direct_name_share ?? 1) < 1;
  }

  private reserve(name: string): boolean {
    const n = normalizeValue(name);
    if (this.names.has(n)) return false;
    this.names.add(n);
    return true;
  }

  newFirstWord(r: Rng, syllables: 2 | 3): string {
    for (let i = 0; i < 20000; i++) {
      const w = r.pick(P.ONSETS) + (syllables === 3 ? r.pick(P.MIDS) : '') + r.pick(P.CODAS);
      if (this.firstWords.has(w.toLowerCase())) continue;
      if (this.nicknames.size && [...this.nicknames].some(n => n.toLowerCase().includes(w.toLowerCase()))) continue;
      this.firstWords.add(w.toLowerCase());
      return w;
    }
    throw new Error('ran out of customer first words; lower the account knobs');
  }

  newPrefix(r: Rng): string {
    const letters = 'BCDFGHJKLMNPRSTVWXZ';
    for (let i = 0; i < 20000; i++) {
      const p = Array.from({ length: 3 }, () => r.pick([...letters])).join('');
      if (this.prefixes.has(p)) continue;
      this.prefixes.add(p);
      return p;
    }
    throw new Error('ran out of short-name prefixes');
  }

  private newCode(r: Rng, prefix?: string): string {
    const p = prefix ?? this.newPrefix(r);
    for (let i = 0; i < 400; i++) {
      const code = `${p}-${r.int(10, 99)}`;
      if (this.reserve(code)) return code;
    }
    throw new Error(`no free short-name under prefix ${p}`);
  }

  private newTicketKey(r: Rng): string {
    for (;;) {
      const key = `HD-${r.int(10000, 99999)}`;
      if (!this.ticketKeys.has(key)) { this.ticketKeys.add(key); return key; }
    }
  }

  newName(r: Rng, first: string, tradeOk?: (trade: typeof P.TRADES[number]) => boolean): string {
    for (const trade of r.shuffle(P.TRADES)) {
      if (tradeOk && !tradeOk(trade)) continue;
      const name = `${first} ${trade}`;
      if (this.reserve(name)) return name;
    }
    throw new Error(`every trade is taken for ${first}`);
  }

  private bulletinSeq = 0;

  reserveBulletin(date: string): { id: string; no: number } {
    const no = ++this.bulletinSeq;
    const id = `bulletin/issue-${String(no).padStart(3, '0')}`;
    this.bulletins.push({ id, no, date, items: [] });
    return { id, no };
  }

  /**
   * `guarded`: the account an item of a multi-account question is about. While `guard` is set, it takes a
   * territory and sector pair and account leads that no earlier item's account has (first words and short-name
   * prefixes are unique across clusters already).
   */
  makeAccount(r: Rng, o: { kind: Acct['kind']; first?: string; firstSyllables?: 2 | 3; prefix?: string; segment?: string; region?: string; avoidSegment?: string; avoidRegion?: string; ghost?: boolean; openedBy?: string; team?: readonly string[]; guarded?: boolean }): Acct {
    const guard = o.guarded ? this.guard : null;
    const regions = (trade: typeof P.TRADES[number]) => (o.region ? [o.region] : P.REGIONS.filter(x => x !== o.avoidRegion)).filter(x => !guard?.descriptors.has(`${x} ${P.SECTOR[trade]}`));
    const first = o.first ?? this.newFirstWord(r, o.firstSyllables ?? 2);
    const name = this.newName(r, first, guard ? trade => regions(trade).length > 0 : undefined);
    const free = guard ? regions(name.slice(name.indexOf(' ') + 1) as typeof P.TRADES[number]) : null;
    const team = o.team ?? (guard ? P.STAFF.filter(x => !guard.managers.has(x)) : P.STAFF);
    if (team.length < 3) throw new Error('a multi-account question has run out of account leads for its items; lower multi_account_max');
    const code = this.newCode(r, o.prefix);
    const opened = randomDate(r, EPOCH, o.openedBy ?? '2026-01-30');
    const contacts: string[] = [];
    while (contacts.length < 3) { const p = R.personName(r); if (!contacts.includes(p)) contacts.push(p); }
    const form: Record<string, string> = {};
    for (const a of Object.values(P.ATTRIBUTES)) form[a.label] = r.pick(a.values);
    for (const t of Object.values(P.TERMS)) form[t.label] = r.pick(t.values);
    const a: Acct = {
      id: `cust-${String(this.accts.length + 1).padStart(4, '0')}`, code, names: [{ name, from: opened }], opened,
      segment: o.segment ?? r.pick(P.SEGMENTS.filter(s => s !== o.avoidSegment)),
      region: o.region ?? r.pick(free ?? P.REGIONS.filter(s => s !== o.avoidRegion)),
      domain: `${first.toLowerCase()}-${name.split(' ')[1].toLowerCase()}.example`,
      contacts, owner: [], renewal: [], tickets: [], form, changes: [], cos: [], announcements: [], docs: [], pending: [], seq: {}, kind: o.kind,
    };
    this.accts.push(a);
    this.byId.set(a.id, a);
    if (!o.ghost) { this.buildOwner(a, r, team); this.buildRenewal(a, r); this.buildTickets(a, r); }
    return a;
  }

  addCo(a: Acct, co: Omit<ChangeOrder, 'id' | 'no' | 'author'>, author = 'contracts-desk'): ChangeOrder {
    const no = a.cos.length + 1;
    const full: ChangeOrder = { id: `paper/${folder(a)}/co-${pad2(no)}`, no, author, ...co };
    a.cos.push(full);
    return full;
  }

  /** The document a new change-log row goes on: the change log, or with reference forms its own slip. */
  rowDoc(a: Acct): string { return this.v2 ? nextId(a, 'registry', 'slip') : changesId(a); }

  private buildOwner(a: Acct, r: Rng, team: readonly string[]): void {
    const k = this.k;
    a.owner.push({ value: r.pick(team), effective: a.opened, recorded: a.opened, doc: cardId(a), kind: 'initial' });
    const n = r.int(0, k.handoffs_per_account_max);
    let cur = a.owner[0].value;
    for (const eff of distinctDates(r, n, addDays(a.opened, 25), addDays(TODAY, 20))) {
      const next = r.pick(team.filter(s => s !== cur));
      if (eff <= addDays(TODAY, -8) && r.chance(k.backdated_handoff_rate)) {
        const recorded = minDate(TODAY, addDays(eff, r.int(8, 45)));
        const channel = r.chance(0.5) ? 'mail' as const : 'bulletin' as const;
        const doc = channel === 'mail' ? nextId(a, 'mail', 'fw') : this.reserveBulletin(recorded).id;
        const ev: ValueEvent = { value: next, effective: eff, recorded, doc, kind: 'change' };
        a.owner.push(ev);
        a.announcements.push({ ev, previous: cur, channel });
        cur = next;
        continue;
      }
      const recorded = minDate(TODAY, maxDate(a.opened, addDays(eff, -r.int(0, 14))));
      const ev: ValueEvent = { value: next, effective: eff, recorded, doc: this.rowDoc(a), kind: 'change' };
      a.owner.push(ev);
      a.changes.push({ logged: recorded, field: 'account lead', was: cur, now: next, effective: eff, by: 'crm-sync', doc: ev.doc });
      cur = next;
      const fixedOn = addDays(recorded, r.int(3, 25));
      if (r.chance(0.12) && fixedOn <= TODAY) {
        const fixed = r.pick(team.filter(s => s !== next && s !== ev.value));
        const fix = correctionOf(ev, fixed, fixedOn, this.rowDoc(a));
        a.owner.push(fix);
        a.changes.push({ logged: fixedOn, field: 'account lead', was: next, now: fixed, effective: eff, by: 'ops-desk', note: `correction: the row keyed ${recorded} named the wrong lead`, doc: fix.doc });
        cur = fixed;
      }
    }
  }

  private buildRenewal(a: Acct, r: Rng): void {
    const first = addDays(a.opened, 365 + r.int(-12, 12));
    a.renewal.push({ value: first, effective: a.opened, recorded: a.opened, doc: formId(a), kind: 'initial' });
    if (!r.chance(0.3)) return;
    const on = randomDate(r, addDays(a.opened, 60), addDays(TODAY, -5));
    const moved = addDays(first, r.pick([-45, -30, 30, 60, 90, 120]));
    const co = this.addCo(a, { state: 'executed', signed: on, effective: on, items: [{ label: 'Renewal date', value: moved }] });
    a.renewal.push({ value: moved, effective: on, recorded: on, doc: co.id, kind: 'change' });
  }

  private buildTickets(a: Acct, r: Rng): void {
    const n = r.int(0, this.k.tickets_per_account_max);
    for (let i = 0; i < n; i++) {
      const opened = randomDate(r, addDays(a.opened, 10), addDays(TODAY, -1));
      const esc = addDays(opened, r.int(1, 12));
      const escalated = r.chance(0.5) && esc <= TODAY ? esc : undefined;
      const cl = addDays(escalated ?? opened, r.int(4, 80));
      const closed = r.chance(0.5) && cl <= TODAY ? cl : undefined;
      this.addTicket(a, r, { opened, escalated, closed });
    }
  }

  addTicket(a: Acct, r: Rng, t: { opened: string; escalated?: string; closed?: string }): Ticket {
    const key = this.newTicketKey(r);
    const ticket: Ticket = { key, summary: r.pick(P.TICKET_SUMMARIES), priority: r.pick(['P1', 'P2', 'P3', 'P4']), reporter: r.pick(a.contacts), ...t, doc: `support/${key.toLowerCase()}` };
    a.tickets.push(ticket);
    return ticket;
  }

  /** Give an account a single account lead for its whole life, dropping its handoffs. */
  flattenOwner(a: Acct, staff: string): void {
    a.owner = [{ value: staff, effective: a.opened, recorded: a.opened, doc: cardId(a), kind: 'initial' }];
    a.changes = a.changes.filter(c => c.field !== 'account lead');
    for (const ann of a.announcements) if (ann.channel === 'bulletin') this.bulletins = this.bulletins.filter(b => b.id !== ann.ev.doc);
    a.announcements = [];
  }

  /** An assistant scratchpad, rendered once the ledger is complete. `stated` marks a note that states the account lead, which never uses the lead form. */
  scratch(a: Acct, date: string, lines: (w: Who) => string[], stated = false): string {
    const id = nextId(a, 'assistant', 'scratch');
    a.pending.push(() => { const w = this.who(id, a, date, 'name', stated); return R.renderScratch(id, date, lines(w), w); });
    return id;
  }

  /** A forwarded mail that mentions the customer only by short-name in reference-free worlds, rendered once the ledger is complete. */
  forward(a: Acct, date: string, spec: (w: Who) => Omit<R.ForwardSpec, 'id' | 'date'>): string {
    const id = nextId(a, 'mail', 'fw');
    a.pending.push(() => R.renderForward({ id, date, ...spec(this.who(id, a, date, 'code')) }));
    return id;
  }

  /** A rename or merger notice: a resolution document that names the customer in full. */
  notice(a: Acct, spec: Omit<R.ForwardSpec, 'id'>): string {
    const d = R.renderForward({ id: nextId(a, 'mail', 'fw'), ...spec });
    a.docs.push(d);
    this.linkDoc(a, d.id);
    return d.id;
  }

  linkDoc(a: Acct, id: string): void {
    this.resolution.add(id);
    this.links.set(a.id, [...(this.links.get(a.id) ?? []), id]);
  }

  // ─── Reference forms ──────────────────────────────────────────────

  /** Give each customer a desk handle: unique, and containing no customer name, short-name or first word. */
  assignNicknames(accts: Acct[]): void {
    const fw = [...this.firstWords];
    const clean = new Map([...P.HANDLE_FIRST, ...P.HANDLE_SECOND].map(w => [w, !fw.some(f => w.toLowerCase().includes(f))]));
    for (const a of accts) {
      const r = new Rng(this.seed, `handle:${a.id}`);
      for (let i = 0; ; i++) {
        if (i > 5000) throw new Error('ran out of desk handles; lower large_extra_accounts');
        const [x, y] = [r.pick(P.HANDLE_FIRST), r.pick(P.HANDLE_SECOND)];
        const nick = `${x} ${y}`;
        if (!clean.get(x) || !clean.get(y) || this.nicknames.has(nick) || !this.reserve(nick)) continue;
        this.nicknames.add(nick);
        a.nickname = nick;
        break;
      }
    }
  }

  /** Mark the documents that record an account-lead change (everything in a lead timeline but the record card). */
  markTimeline(): void {
    for (const a of this.accts) for (const e of a.owner) if (e.doc !== cardId(a)) this.timeline.add(e.doc);
  }

  private sameDescriptor(a: Acct): Acct[] {
    if (this.descIndex?.n !== this.accts.length) {
      const map = new Map<string, Acct[]>();
      for (const x of this.accts) if (!x.ghostOf) map.set(descriptorOf(x), [...(map.get(descriptorOf(x)) ?? []), x]);
      this.descIndex = { n: this.accts.length, map };
    }
    return this.descIndex.map.get(descriptorOf(a)) ?? [];
  }

  /** The lead-form text for a record, or null when a reader with only earlier records could not pin it to this one customer. */
  private leadForm(a: Acct, doc: string, date: string): string | null {
    if (a.ghostOf || this.timeline.has(doc)) return null;
    const m = managerKnownOn(a.owner, date);
    if (!m || this.sameDescriptor(a).some(o => o !== a && managerReadingsOn(o.owner, date).has(m))) return null;
    return managerReference(m, descriptorOf(a));
  }

  /**
   * How document `doc` (dated `date`) refers to customer `a`. Without reference forms it is the
   * form this kind of document always used (`v1`). With them, the form is drawn once per document
   * and customer from its own stream, after the ledger is complete, so it never moves a fact.
   */
  who(doc: string, a: Acct, date: string, v1: 'name' | 'code', stated = false): Who {
    if (!this.v2) return v1 === 'name' ? { form: 'name', text: nameAt(a, date), code: a.code, mail: true } : { form: 'code', text: a.code, code: a.code, mail: true };
    const list = this.cites.get(doc) ?? [];
    let c = list.find(x => x.acct === a);
    if (!c) {
      const k = this.k, r = new Rng(this.seed, `cite:${doc}:${a.id}`);
      const draw = (forms: RefForm[]): RefForm => {
        const w = forms.map(f => (f === 'code' ? k.code_ref_weight! : f === 'nickname' ? k.nickname_ref_weight! : k.manager_ref_weight!));
        const total = w.reduce((x, y) => x + y, 0);
        let u = r.next() * total;
        for (let i = 0; i < forms.length; i++) { if (u < w[i]) return forms[i]; u -= w[i]; }
        return forms[0];
      };
      let form: RefForm = r.next() < k.direct_name_share! ? 'name' : draw(['code', 'nickname', 'manager']);
      const lead = form === 'manager' && !stated ? this.leadForm(a, doc, date) : null;
      if (form === 'manager' && !lead) form = draw(['code', 'nickname']);
      c = { acct: a, form, date, text: form === 'name' ? nameAt(a, date) : form === 'code' ? a.code : form === 'nickname' ? a.nickname! : lead! };
      list.push(c);
      this.cites.set(doc, list);
    }
    return { form: c.form, text: c.text, code: c.form === 'name' || c.form === 'code' ? a.code : undefined, mail: c.form === 'name' };
  }

  /** The id a document is published under: event records get an opaque id (area plus ten letters); resolution documents and ids that name no customer stay readable. */
  opaque(id: string): string {
    if (!this.v2 || !/^[a-z]+\/[a-z]{3}-\d{2}\//.test(id) || id.endsWith('/card') || id.endsWith('/profile') || this.resolution.has(id)) return id;
    const h = createHash('sha256').update(`hard-sealed-id|${this.seed}|${id}`).digest();
    const letters = 'bcdfghjkmnpqrstvwxz';
    let token = '';
    for (let i = 0; i < 10; i++) token += letters[h[i] % letters.length];
    return `${id.slice(0, id.indexOf('/'))}/${token}`;
  }

  /**
   * Reference forms: `ids` plus every resolution document their references need (WORLD_SCHEMA.md,
   * "Oracle evidence"): the record card for a short-name, the profile for a desk handle, the profile
   * and the lead timeline up to the record for the lead form (with what those documents need in
   * turn), and the rename or merger documents when the chain passes through another name.
   */
  withResolution(ids: string[]): string[] {
    if (!this.v2) return ids;
    const out = [...ids], seen = new Set(ids);
    const add = (id: string) => { if (!seen.has(id)) { seen.add(id); out.push(id); } };
    for (let i = 0; i < out.length; i++) for (const c of this.cites.get(out[i]) ?? []) {
      const a = c.acct;
      if (c.form === 'code') add(cardId(a));
      if (c.form === 'nickname' || c.form === 'manager') add(profileId(a));
      if (c.form === 'manager') for (const e of a.owner) if (e.recorded <= c.date) add(e.doc);
      const viaOtherName = a.ghostOf !== undefined || (c.form === 'name' ? c.text !== currentName(a) : a.names.length > 1);
      if (viaOtherName) for (const l of this.links.get(a.ghostOf ?? a.id) ?? []) add(l);
    }
    return out;
  }

  /** Readable ids to published ids in a task, after adding the resolution documents. */
  publishTask(t: HardTask): HardTask {
    if (!this.v2) return t;
    return { ...t, gold: { ...t.gold, evidence: this.withResolution(t.gold.evidence).map(id => this.opaque(id)) }, relevant: this.withResolution(t.relevant).map(id => this.opaque(id)) };
  }

  /** Every reference in the given documents, by published id. */
  references(docIds: Iterable<string>): HardReference[] {
    const out: HardReference[] = [];
    for (const doc of docIds) for (const c of this.cites.get(doc) ?? []) out.push({ doc: this.opaque(doc), entity: c.acct.ghostOf ?? c.acct.id, form: c.form, text: c.text });
    return out.sort((x, y) => x.doc.localeCompare(y.doc) || x.entity.localeCompare(y.entity));
  }

  /** Render an account's documents: registry, paper, mail, minutes, helpdesk and notes. */
  finish(a: Acct): LadderDoc[] {
    const r = new Rng(this.seed, `noise:${a.id}`);
    const k = this.k;
    for (const ann of a.announcements) {
      if (ann.channel === 'mail') {
        const w = this.who(ann.ev.doc, a, ann.ev.recorded, 'name');
        a.docs.push(R.renderForward({
          id: ann.ev.doc, date: ann.ev.recorded, subject: `Lead change for ${R.whoRef(w)}`, forwarder: r.pick(P.SUPPORT_STAFF), to: 'account-team',
          note: ['This was agreed some time ago and only written up now. Filing it so the folder is complete.'],
          original: { date: ann.ev.recorded, from: ann.previous, fromDomain: P.COMPANY_DOMAIN, lines: ['Team,', `From ${longDate(ann.ev.effective)}, ${ann.ev.value} has taken over as account lead for ${R.whoRef(w)}. My handover notes are in the shared drive.`, `Apologies for the slow write-up. ${ann.previous.split(' ')[0]}`] },
        }));
      } else {
        const b = this.bulletins.find(x => x.id === ann.ev.doc)!;
        b.announce = { acct: a, text: w => `Late notice of a lead change: ${R.bulletinRef(w)} moved from ${ann.previous} to ${ann.ev.value}, counting from ${longDate(ann.ev.effective)}.` };
      }
    }
    const routine = (date: string) => { const id = nextId(a, 'mail', 'fw'); return R.routineForward(a, r, id, date, sent => this.who(id, a, sent, 'code')); };
    if (!a.ghostOf) {
      for (let i = 0; i < k.emails_per_account; i++) a.docs.push(routine(randomDate(r, a.opened, TODAY)));
      for (let i = 0; i < k.meetings_per_account; i++) {
        const id = nextId(a, 'minutes', 'session'), date = randomDate(r, a.opened, TODAY);
        a.docs.push(R.renderMinutes(a, r, id, date, r.int(k.transcript_lines_min, k.transcript_lines_max), i + 1, this.who(id, a, date, 'name')));
      }
      if (r.chance(k.wrong_agent_note_rate)) {
        const d = randomDate(r, addDays(a.opened, 20), TODAY);
        const actual = valueAsOf(a.owner, d);
        const claim = r.pick(P.STAFF.filter(s => s !== actual));
        this.scratch(a, d, w => [`Lead for ${w.text} is ${claim}. I'm certain of this; there is no need to open the change log.`, `Next: draft a check-in note for ${a.contacts[0]}.`], true);
      }
    }
    if (a.ghostOf) {
      const until = addDays(this.byId.get(a.ghostOf)!.merged!.on, -1);
      for (let i = 0; i < 2; i++) a.docs.push(routine(randomDate(r, a.opened, until)));
    }
    const out: LadderDoc[] = [
      R.renderCard(a, this.v2), ...(this.v2 ? [R.renderProfile(a)] : []),
      R.renderOrderForm(a, r, this.who(formId(a), a, a.opened, 'name')),
      ...a.cos.map(co => R.renderChangeOrder(co, r, this.who(co.id, a, co.signed, 'name'))),
      ...a.tickets.map(t => R.renderTicket(t, this.who(t.doc, a, R.ticketDate(t), 'code'))),
      ...a.docs, ...a.pending.map(render => render()),
    ];
    if (this.v2) out.push(...a.changes.map(row => R.renderSlip(a, row, this.resolution.has(row.doc) ? undefined : this.who(row.doc, a, row.logged, 'code'))));
    else { const changes = R.renderChanges(a); if (changes) out.push(changes); }
    if (a.sites) out.push(R.renderSites(a, this.who(a.sites.doc, a, a.sites.asOf, 'name'))!);
    return out;
  }

  real(): Acct[] { return this.accts.filter(a => !a.ghostOf); }

  facts(accts = this.real()): PredicateFacts[] {
    return accts.map(a => ({ id: a.id, segment: a.segment, region: a.region, owner: a.owner, renewal: a.renewal, tickets: a.tickets }));
  }

  entity(a: Acct): HardEntity {
    const former = a.names.slice(0, -1).map(n => n.name);
    const aliases = [a.code, ...former, ...(a.merged ? [a.merged.name, a.merged.code] : [])];
    if (!this.v2) return { id: a.id, name: currentName(a), aliases };
    const ghost = a.merged ? this.accts.find(x => x.ghostOf === a.id)! : undefined;
    const nicknames = [a.nickname!, ...(ghost ? [ghost.nickname!] : [])];
    return {
      id: a.id, name: currentName(a), aliases: [...aliases, ...nicknames],
      refs: {
        codes: [a.code, ...(ghost ? [ghost.code] : [])], nicknames, descriptor: descriptorOf(a),
        managers: a.owner.map(e => ({ name: e.value, effective: e.effective, recorded: e.recorded, doc: this.opaque(e.doc) })),
      },
    };
  }
}

// ─── H3 helpers ─────────────────────────────────────────────────────

function factHolds(a: Pick<Acct, 'segment' | 'region' | 'owner' | 'tickets'>, f: Fact): boolean {
  switch (f.kind) {
    case 'region': return a.region === f.region;
    case 'segment': return a.segment === f.segment;
    case 'lead-on': return valueAsOf(a.owner, f.date) === f.staff;
    case 'ticket': return a.tickets.some(t => t.key === f.key);
  }
}

function tokenMatches(a: Acct, token: H3Spec['token']): boolean {
  if (token.kind === 'code-prefix') return [a.code, a.merged?.code].some(c => c?.startsWith(`${token.value}-`));
  const names = [...a.names.map(n => n.name), ...(a.merged ? [a.merged.name] : [])];
  return names.some(n => n.split(' ')[0] === token.value);
}

/** Every H3 question resolves to exactly its target among the accounts its ambiguous name matches. */
function assertH3Unique(b: Builder): void {
  for (const s of b.h3) {
    const holders = b.real().filter(a => tokenMatches(a, s.token) && factHolds(a, s.fact));
    if (holders.length !== 1 || holders[0].id !== s.target) throw new Error(`H3 task index ${s.task}: the disambiguating fact matches ${holders.length} accounts`);
  }
}

// ─── Families ───────────────────────────────────────────────────────

/** Random-stream key of item `j` of task `i`: item 0 keeps the single-account name. */
const itemKey = (i: number, j: number) => (j ? `${i}/item${j}` : `${i}`);

function buildH2(b: Builder, i: number, j = 0): HardTask {
  const k = b.k;
  const r = new Rng(b.seed, `h2:${itemKey(i, j)}`);
  const a = b.makeAccount(r, { kind: 'task', openedBy: '2025-11-30', guarded: true });
  const attr = P.H2_ATTRS[(i + j) % P.H2_ATTRS.length];
  const { label, values } = P.ATTRIBUTES[attr];
  for (let attempt = 0; attempt < 60; attempt++) {
    const h = new Rng(b.seed, `h2:${itemKey(i, j)}:${attempt}`);
    type Step = { value: string; effective: string; recorded: string; kind: ValueEvent['kind']; corrects?: number };
    const steps: Step[] = [{ value: h.pick(values), effective: a.opened, recorded: a.opened, kind: 'initial' }];
    const asEvents = (doc: (j: number) => string) => steps.map((s, j): ValueEvent => ({ value: s.value, effective: s.effective, recorded: s.recorded, doc: doc(j), kind: s.kind }));
    const seen = [steps[0].value];
    const n = h.int(k.h2_changes_min, k.h2_changes_max);
    for (const eff of distinctDates(h, n, addDays(a.opened, 30), addDays(TODAY, -15))) {
      const cur = valueAsOf(asEvents(String), addDays(eff, -1))!;
      const reversal = seen.length > 1 && h.chance(0.3);
      let options = reversal ? seen.filter(v => v !== cur) : values.filter(v => !seen.includes(v));
      if (!options.length) options = values.filter(v => v !== cur);
      const value = h.pick(options);
      const timing = h.pick(['advance', 'backdated', 'same'] as const);
      const recorded = timing === 'advance' ? maxDate(addDays(a.opened, 1), addDays(eff, -h.int(5, 30))) : timing === 'backdated' ? minDate(TODAY, addDays(eff, h.int(5, 40))) : eff;
      steps.push({ value, effective: eff, recorded, kind: 'change' });
      seen.push(value);
      const fixedOn = addDays(recorded, h.int(4, 30));
      if (h.chance(k.h2_correction_rate) && fixedOn <= TODAY) {
        const fixed = h.pick(values.filter(v => v !== value && v !== cur));
        steps.push({ value: fixed, effective: eff, recorded: fixedOn, kind: 'correction', corrects: steps.length - 1 });
        seen.push(fixed);
      }
    }
    const draft = asEvents(String);
    const todayValue = valueAsOf(draft, TODAY);
    const cands: Array<{ date: string; strong: boolean }> = [];
    for (const e of draft) for (const off of [1, 4, 11, 23]) {
      const date = addDays(e.effective, off);
      if (date > TODAY || cands.some(c => c.date === date)) continue;
      const ans = valueAsOf(draft, date);
      if (ans === null || ans === todayValue) continue;
      cands.push({ date, strong: valueAsOf(draft.filter(x => x.recorded <= date), date) !== ans });
    }
    if (!cands.length) continue;
    const strong = cands.filter(c => c.strong);
    const asOf = h.pick(strong.length ? strong : cands).date;

    a.form[label] = steps[0].value;
    const coOf = new Map<number, ChangeOrder>();
    steps.forEach((s, j) => {
      if (j === 0) return;
      coOf.set(j, b.addCo(a, { state: 'executed', signed: s.recorded, effective: s.effective, items: [{ label, value: s.value, ...(s.corrects !== undefined ? { corrects: coOf.get(s.corrects)!.no } : {}) }] }));
    });
    const events = asEvents(j => (j === 0 ? formId(a) : coOf.get(j)!.id));
    const answer = valueAsOf(events, asOf)!;
    const inForce = eventAsOf(events, asOf)!;
    const naive = valueAsOf(events.filter(x => x.recorded <= asOf), asOf);
    const firstChange = steps[1].effective;
    for (let j = 0; j < k.h2_intermediate_notes; j++) {
      const d = randomDate(h, firstChange, TODAY);
      const v = valueAsOf(events.filter(x => x.recorded <= d), d);
      if (v) b.scratch(a, d, w => [`${label} for ${w.text}: ${v}, going by the newest paperwork I could find today.`, `Re-check before the next invoice run.`]);
    }
    const reversal = events.some(e => e.value === answer && e !== inForce && e.effective < inForce.effective) && events.some(e => e.value !== answer && e.effective < inForce.effective);
    const variant = inForce.kind === 'correction' ? 'correction' : naive !== answer ? 'backdated' : reversal ? 'reversal' : 'as-of';
    const docs = uniq(events.map(e => e.doc));
    return {
      id: `H2-${pad2(i + 1)}`, family: 'H2', variant, answer_kind: 'value', accounts: [a.id],
      question: `Using every record on file, including anything written afterwards, what ${label.toLowerCase()} applied to ${currentName(a)} on ${asOf}? Reply with the value alone.`,
      gold: { answer: [answer], wrong: historyValues(events).filter(v => v !== answer), evidence: docs },
      relevant: docs,
    };
  }
  throw new Error(`H2 task index ${i}: no usable history after 60 attempts`);
}

function buildH3(b: Builder, i: number, j = 0): HardTask {
  const k = b.k;
  const r = new Rng(b.seed, `h3:${itemKey(i, j)}`);
  const variant = (['first-word', 'code-prefix', 'renamed', 'merged'] as const)[(i + j) % 4];
  const attr = r.pick(P.H3_ATTRS);
  const { label, values } = P.ATTRIBUTES[attr];
  const nLook = r.int(k.h3_lookalikes_min, k.h3_lookalikes_max);
  const vals = r.sample(nLook + 2 > values.length ? [...values, ...P.ATTRIBUTE_OVERFLOW[attr]] : values, nLook + 2);
  const segment = r.pick(P.SEGMENTS), region = r.pick(P.REGIONS);
  const looks: Acct[] = [];
  const evidence: string[] = [];
  const relevant: string[] = [];
  const wrong: string[] = [];
  let target: Acct;
  let token: H3Spec['token'];
  let attrDoc: string;
  const look = (o: { first?: string; prefix?: string }) => looks.push(b.makeAccount(r, { kind: 'task', avoidSegment: segment, avoidRegion: region, ...o }));

  if (variant === 'code-prefix') {
    const prefix = b.newPrefix(r);
    target = b.makeAccount(r, { kind: 'task', prefix, segment, region, guarded: true });
    for (let j = 0; j < nLook; j++) look({ prefix });
    token = { kind: 'code-prefix', value: prefix };
    target.form[label] = vals[0];
    attrDoc = formId(target);
  } else if (variant === 'first-word') {
    const first = b.newFirstWord(r, 2);
    target = b.makeAccount(r, { kind: 'task', first, segment, region, guarded: true });
    for (let j = 0; j < nLook; j++) look({ first });
    token = { kind: 'first-word', value: first };
    target.form[label] = vals[0];
    attrDoc = formId(target);
  } else if (variant === 'renamed') {
    const first = b.newFirstWord(r, 2);
    target = b.makeAccount(r, { kind: 'task', first, segment, region, openedBy: '2025-12-31', guarded: true });
    for (let j = 0; j < nLook; j++) look({ first });
    token = { kind: 'first-word', value: first };
    const oldName = target.names[0].name;
    const on = randomDate(r, addDays(target.opened, 45), addDays(TODAY, -90));
    const newName = b.newName(r, b.newFirstWord(r, 2));
    target.names.push({ name: newName, from: on });
    const row: ChangeRow = { logged: on, field: 'registered name', was: oldName, now: newName, effective: on, by: 'contracts-desk', note: 'short-name unchanged', doc: b.rowDoc(target) };
    target.changes.push(row);
    if (b.v2) b.linkDoc(target, row.doc);
    const notice = b.notice(target, {
      date: on, subject: `New registered name (Ref: ${target.code})`, forwarder: r.pick(P.SUPPORT_STAFF), to: 'account-team', note: ['Please update any templates that still carry the old name.'],
      original: { date: on, from: target.contacts[0], fromDomain: target.domain, lines: [`Hello,`, `${oldName} now trades as ${newName}. Our short-name with you stays ${target.code}, and nothing else about the account changes.`, `Best, ${target.contacts[0].split(' ')[0]}`] },
    });
    target.form[label] = vals[nLook + 1];
    wrong.push(vals[nLook + 1]);
    const signed = randomDate(r, addDays(on, 5), addDays(TODAY, -5));
    attrDoc = b.addCo(target, { state: 'executed', signed, effective: signed, items: [{ label, value: vals[0] }] }).id;
    evidence.push(row.doc, notice);
    relevant.push(formId(target));
  } else {
    target = b.makeAccount(r, { kind: 'task', segment, region, openedBy: '2025-11-30', guarded: true });
    const first = b.newFirstWord(r, 2);
    const ghost = b.makeAccount(r, { kind: 'task', first, segment, region, ghost: true, openedBy: '2025-12-31', guarded: true });
    for (let j = 0; j < nLook; j++) look({ first });
    token = { kind: 'first-word', value: first };
    ghost.ghostOf = target.id;
    const on = randomDate(r, addDays(maxDate(target.opened, ghost.opened), 30), addDays(TODAY, -40));
    target.merged = { name: ghost.names[0].name, code: ghost.code, on };
    const row: ChangeRow = { logged: on, field: 'merged in', was: '-', now: `${ghost.names[0].name} (${ghost.code})`, effective: on, by: 'contracts-desk', note: `${ghost.code} order form retired; the combined account runs on VF-${target.code}`, doc: b.rowDoc(target) };
    target.changes.push(row);
    if (b.v2) b.linkDoc(target, row.doc);
    const notice = b.notice(target, {
      date: on, subject: `Accounts combined: ${ghost.code} into ${target.code}`, forwarder: r.pick(P.SUPPORT_STAFF), to: 'account-team', note: ['Merger paperwork is done. Both names now point at one account.'],
      original: { date: on, from: target.contacts[0], fromDomain: target.domain, lines: [`Hi all,`, `${ghost.names[0].name} (${ghost.code}) is now part of ${nameAt(target, on)}. Please bill and support everything under ${target.code} from today; the old ${ghost.code} order form no longer applies.`, `Thanks, ${target.contacts[0].split(' ')[0]}`] },
    });
    target.form[label] = vals[0];
    ghost.form[label] = vals[nLook + 1];
    wrong.push(vals[nLook + 1]);
    attrDoc = formId(target);
    evidence.push(row.doc, notice);
    relevant.push(cardId(ghost), formId(ghost));
  }
  looks.forEach((l, j) => { l.form[label] = vals[j + 1]; wrong.push(vals[j + 1]); relevant.push(cardId(l), formId(l)); });

  let fact: Fact | undefined;
  let factDoc = cardId(target);
  for (const kind of r.shuffle(['lead-on', 'ticket', 'region', 'segment'] as const)) {
    if (kind === 'region') fact = { kind, region: target.region };
    else if (kind === 'segment') fact = { kind, segment: target.segment };
    else if (kind === 'ticket') {
      const opened = randomDate(r, addDays(target.opened, 10), addDays(TODAY, -20));
      const t = b.addTicket(target, r, { opened, closed: addDays(opened, r.int(3, 15)) });
      fact = { kind, key: t.key };
      factDoc = t.doc;
    } else {
      const lo = [target, ...looks].reduce((m, x) => maxDate(m, x.opened), target.opened);
      for (let tries = 0; tries < 40 && !fact; tries++) {
        const date = randomDate(r, addDays(lo, 1), TODAY);
        const staff = valueAsOf(target.owner, date)!;
        if (looks.every(l => valueAsOf(l.owner, date) !== staff)) { fact = { kind, date, staff }; factDoc = eventAsOf(target.owner, date)!.doc; }
      }
    }
    if (fact) break;
  }
  b.h3.push({ task: i, token, fact: fact!, target: target.id });

  const subject = token.kind === 'first-word' ? `the ${token.value} customer` : `the customer whose short-name starts with ${token.value}-`;
  const clause = fact!.kind === 'region' ? `in the ${fact!.region} territory`
    : fact!.kind === 'segment' ? `in the ${fact!.segment} tier`
      : fact!.kind === 'ticket' ? `that raised helpdesk ticket ${fact!.key}`
        : `whose account lead on ${fact!.date} was ${fact!.staff}`;
  evidence.unshift(factDoc, attrDoc);
  return {
    id: `H3-${pad2(i + 1)}`, family: 'H3', variant: `${variant}/${fact!.kind}`, answer_kind: 'value', accounts: [target.id, ...looks.map(l => l.id)],
    question: `What ${label.toLowerCase()} does ${subject} ${clause} have today? Reply with the value only.`,
    gold: { answer: [vals[0]], wrong, evidence: uniq(evidence) },
    relevant: uniq([...evidence, ...relevant]),
  };
}

function buildH4(b: Builder, i: number, j = 0): HardTask {
  const k = b.k;
  const r = new Rng(b.seed, `h4:${itemKey(i, j)}`);
  const a = b.makeAccount(r, { kind: 'task', openedBy: '2025-10-31', guarded: true });
  const term = r.pick(P.TERM_KINDS);
  const { label, values } = P.TERMS[term];
  const variant = (['amendment-wins', 'draft-loses', 'later-effective-wins', 'not-yet-effective'] as const)[(i + j) % 4];
  const n = r.int(k.h4_sources_min, k.h4_sources_max);
  const vals = r.sample(values, n);
  a.form[label] = vals[0];
  const executed: ValueEvent[] = [{ value: vals[0], effective: a.opened, recorded: a.opened, doc: formId(a), kind: 'initial' }];
  const sources = [formId(a)];
  let used = 1;
  const executedCo = (signed: string, effective: string) => {
    const co = b.addCo(a, { state: 'executed', signed, effective, items: [{ label, value: vals[used] }] });
    executed.push({ value: vals[used++], effective, recorded: signed, doc: co.id, kind: 'change' });
    sources.push(co.id);
  };
  const draftCo = () => {
    const d = randomDate(r, addDays(a.opened, 40), addDays(TODAY, -3));
    sources.push(b.addCo(a, { state: 'draft', signed: d, effective: addDays(d, r.int(10, 40)), items: [{ label, value: vals[used++] }] }, r.pick(P.SUPPORT_STAFF)).id);
  };
  if (variant === 'amendment-wins') {
    const eff = randomDate(r, addDays(a.opened, 60), addDays(TODAY, -20));
    executedCo(maxDate(addDays(a.opened, 1), addDays(eff, -r.int(0, 20))), eff);
  } else if (variant === 'draft-loses') {
    draftCo();
  } else if (variant === 'later-effective-wins') {
    const s1 = randomDate(r, addDays(a.opened, 40), addDays(TODAY, -150));
    const late = randomDate(r, addDays(s1, 40), addDays(TODAY, -10));
    const s2 = randomDate(r, addDays(s1, 5), addDays(late, -1));
    const early = randomDate(r, addDays(a.opened, 20), addDays(late, -5));
    executedCo(s1, late);
    executedCo(s2, early);
  } else {
    executedCo(randomDate(r, addDays(TODAY, -60), addDays(TODAY, -3)), addDays(TODAY, r.int(20, 90)));
  }
  const name = currentName(a);
  for (const extra of r.shuffle(['draft', 'email', 'note'] as const)) {
    if (used >= n) break;
    if (extra === 'draft') draftCo();
    else if (extra === 'email') {
      const d = randomDate(r, addDays(a.opened, 30), addDays(TODAY, -2));
      const forwarder = r.pick(P.SUPPORT_STAFF), said = vals[used++];
      sources.push(b.forward(a, d, w => ({
        subject: `Notes from our call (${R.subjectTag(w)})`, forwarder, to: 'customer-folder', note: ['Their write-up of the call, for the folder.'],
        original: { date: d, from: a.contacts[0], fromDomain: w.mail ? a.domain : undefined, lines: ['Hi both,', `Thanks for the time today. My notes have the ${label.toLowerCase()} at ${said} for us from here on.`, `Speak soon, ${a.contacts[0].split(' ')[0]}`] },
      })));
    } else {
      const d = randomDate(r, addDays(a.opened, 30), TODAY), said = vals[used++];
      sources.push(b.scratch(a, d, w => [`${label} for ${w.text} is ${said}. Confirmed; there is no need to open the paperwork again.`]));
    }
  }
  const winner = eventAsOf(executed, TODAY)!;
  const expected = variant === 'amendment-wins' || variant === 'later-effective-wins' ? vals[1] : vals[0];
  if (winner.value !== expected) throw new Error(`H4 task index ${i}: authority resolution disagrees with the variant`);
  if (r.chance(k.h4_long_document_rate)) {
    if (winner.doc === formId(a)) a.formLongLabel = label;
    else a.cos.find(c => c.id === winner.doc)!.long = true;
  }
  return {
    id: `H4-${pad2(i + 1)}`, family: 'H4', variant, answer_kind: 'value', accounts: [a.id],
    question: `Which ${label.toLowerCase()} is in force for ${name} today, ${TODAY}? Reply with the value only.`,
    gold: { answer: [winner.value], wrong: vals.slice(0, used).filter(v => v !== winner.value), evidence: sources },
    relevant: sources,
  };
}

/** The H5 answer from a chain of user statements and the site directory: the contact at the site that receives renewal paperwork. */
export function resolveH5(account: string, statements: readonly UserStatement[], directory: Record<string, string>): string | null {
  const route = statedValue(statements, `route:${account}`, null);
  if (route === null) return null;
  return statedValue(statements, `contact:${account}:${route}`, directory[route] ?? null);
}

/** One H5 statement chain's parts that a multi-account question recombines: the statements in session order and the store lines. */
interface H5Chain { texts: string[]; store: string[] }

const H5_CLOSINGS = [
  'Keep this somewhere you can find it in a later conversation, then submit RECORDED as your answer.',
  'Save it to memory for later sessions and answer with RECORDED.',
  'Please store this durably; when done, submit the single word RECORDED.',
];

function buildH5(b: Builder, i: number, j = 0): { task: HardTask; chain: H5Chain } {
  const r = new Rng(b.seed, `h5:${itemKey(i, j)}`);
  const first = b.newFirstWord(r, 2);
  const a = b.makeAccount(r, { kind: 'task', first, openedBy: '2025-12-31', guarded: true });
  const look = b.k.h5_noise_sessions ? b.makeAccount(r, { kind: 'task', first }) : undefined;
  const name = currentName(a);
  const [sA, sB] = r.sample(P.SITE_WORDS, 2).map(w => `${w} ${r.pick(P.SITE_KINDS)}`);
  const people: string[] = [];
  while (people.length < 6) { const p = R.personName(r); if (substringFree([...people, p])) people.push(p); }
  const [p0, q0, p1, q1, p2, extra] = people;
  a.sites = { doc: `registry/${folder(a)}/sites`, asOf: randomDate(r, addDays(a.opened, 20), addDays(TODAY, -120)), list: [{ name: sA, contact: p0 }, { name: sB, contact: q0 }] };
  const key = (site: string) => `contact:${a.id}:${site}`, route = `route:${a.id}`;
  type Statement = { tag: string; facts: Array<{ key: string; value: string }>; text: string; after?: string };
  const variant = (i + j) % 2 === 0 ? 'contact-updated' : 'route-moved';
  const contacts: Statement = { tag: 'C', facts: [{ key: key(sA), value: p1 }, { key: key(sB), value: q1 }], text: `${name} told me who signs for incoming documents at each of their sites: ${p1} at the ${sA} and ${q1} at the ${sB}.` };
  const statements: Statement[] = [contacts];
  if (variant === 'contact-updated') {
    statements.push(
      { tag: 'R', facts: [{ key: route, value: sA }], text: `${name} wants their signed renewal paperwork sent to the ${sA}, not to head office.` },
      { tag: 'U', facts: [{ key: key(sA), value: p2 }], after: 'C', text: `Update on ${name}: ${p1} has left the ${sA}, and ${p2} signs for documents there now.` },
    );
  } else {
    statements.push(
      { tag: 'R1', facts: [{ key: route, value: sA }], text: `${name} wants their signed renewal paperwork sent to the ${sA}, not to head office.` },
      { tag: 'R2', facts: [{ key: route, value: sB }], after: 'R1', text: `Change of plan from ${name}: renewal paperwork should go to the ${sB} from now on, not the ${sA}.` },
    );
  }
  if (look) {
    const ls = `${r.pick(P.SITE_WORDS)} ${r.pick(P.SITE_KINDS)}`;
    statements.push({ tag: 'N', facts: [{ key: `route:${look.id}`, value: ls }, { key: `contact:${look.id}:${ls}`, value: extra }], text: `A different customer, ${currentName(look)}: their renewal paperwork goes to the ${ls}, for the attention of ${extra}.` });
  } else if (variant === 'contact-updated') {
    statements.push({ tag: 'N', facts: [{ key: key(sB), value: extra }], after: 'C', text: `Small change at ${name}: ${extra} now signs for documents at the ${sB}.` });
  } else {
    statements.push({ tag: 'N', facts: [{ key: key(sA), value: extra }], after: 'C', text: `${name} mentioned that ${extra} has taken over signing for documents at the ${sA}.` });
  }
  let order = statements;
  for (let tries = 0; tries < 500; tries++) {
    order = r.shuffle(statements);
    if (order.every((s, j) => !s.after || order.findIndex(x => x.tag === s.after) < j)) break;
  }
  const said: UserStatement[] = order.flatMap((s, j) => s.facts.map(f => ({ session: j + 1, key: f.key, value: f.value })));
  const directory = { [sA]: p0, [sB]: q0 };
  const answer = resolveH5(a.id, said, directory);
  if (!answer) throw new Error(`H5 task index ${i}: the chain does not resolve`);
  const routed = statedValue(said, route, null)!;
  const inForce = (k: string) => said.filter(s => s.key === k).reduce<UserStatement | null>((m, s) => (!m || s.session > m.session ? s : m), null);
  const required = [inForce(route), inForce(key(routed))];
  const session_facts: SessionFact[] = said.map(s => {
    const later = said.find(x => x.key === s.key && x.session > s.session);
    return { session: s.session, key: s.key, value: s.value, ...(later ? { superseded_by: later.session } : {}), required: required.includes(s) };
  });
  const personValues = uniq([...said.filter(s => s.key.startsWith('contact:')).map(s => s.value), p0, q0]);
  const tid = `H5-${pad2(i + 1)}`;
  b.h5.push({ task: tid, item: j, account: a.id, directory });
  const store = [`Renewal paperwork for ${name} goes to the ${routed}.`, `Signs for documents at the ${sA}: ${statedValue(said, key(sA), p0)}.`, `Signs for documents at the ${sB}: ${statedValue(said, key(sB), q0)}.`];
  if (look) store.push(`${currentName(look)} is a different customer; its routing does not apply to ${name}.`);
  const task: HardTask = {
    id: tid, family: 'H5', variant, answer_kind: 'value', accounts: [a.id, ...(look ? [look.id] : [])],
    sessions: order.map(s => `${s.text} ${r.pick(H5_CLOSINGS)}`),
    question: `Who should receive the signed renewal paperwork for ${name}? Give the person's full name only.`,
    gold: { answer: [answer], wrong: personValues.filter(v => v !== answer), evidence: [a.sites.doc] },
    relevant: [a.sites.doc],
    oracle_notes: [{ id: `oracle/${tid.toLowerCase()}-store`, title: `What the store holds after sessions 1 to 4: ${name}`, body: store.join('\n') }],
    session_facts,
  };
  return { task, chain: { texts: order.map(s => s.text), store } };
}

// ─── Multi-account questions (amendment A2) ─────────────────────────

/**
 * Task `i` of a family: k items drawn from multi_account_min..max (1 without the multi-account knobs), each a
 * complete single-account instance built by `item`. While the items are built, each item's account avoids the
 * descriptors and account leads of the earlier items' accounts. k = 1 is the single-account task unchanged.
 */
function question(b: Builder, family: HardFamily, i: number, item: (j: number) => { task: HardTask; chain?: H5Chain }): HardTask {
  const kn = b.k;
  const k = kn.multi_account_max === undefined ? 1 : new Rng(b.seed, `items:${family}:${i}`).int(kn.multi_account_min!, kn.multi_account_max);
  if (k === 1) return item(0).task;
  b.guard = { descriptors: new Set(), managers: new Set() };
  const built: Array<{ task: HardTask; chain?: H5Chain }> = [];
  for (let j = 0; j < k; j++) {
    const one = item(j);
    built.push(one);
    const main = b.byId.get(one.task.accounts[0])!;
    for (const a of [main, ...b.accts.filter(x => x.ghostOf === main.id)]) {
      b.guard.descriptors.add(descriptorOf(a));
      for (const e of a.owner) b.guard.managers.add(e.value);
    }
  }
  b.guard = null;
  const items = built.map(x => x.task);
  const tid = `${family}-${pad2(i + 1)}`;
  const union = (f: (t: HardTask) => string[]) => uniq(items.flatMap(f));
  const head = { id: tid, family, variant: items.map(t => t.variant).join('|'), answer_kind: 'values' as const, accounts: union(t => t.accounts) };
  const rest = {
    question: [`Answer each of these ${k} questions:`, ...items.map((t, n) => `${n + 1}. ${t.question}`), `Answer with a JSON array of the ${k} answers in the order asked, as one string in \`answer\`, for example ["first answer","second answer"].`].join('\n'),
    gold: { items: items.map(t => ({ account: t.accounts[0], answer: t.gold.answer!, wrong: t.gold.wrong! })), evidence: union(t => t.gold.evidence) },
    relevant: union(t => t.relevant),
  };
  if (family !== 'H5') return { ...head, ...rest };
  const chains = built.map(x => x.chain!);
  const r = new Rng(b.seed, `h5:${i}:closings`);
  return {
    ...head,
    sessions: Array.from({ length: H5_SESSIONS - 1 }, (_, n) => `${chains.map(c => c.texts[n]).join(' ')} ${r.pick(H5_CLOSINGS)}`),
    ...rest,
    oracle_notes: [{
      id: `oracle/${tid.toLowerCase()}-store`, title: `What the store holds after sessions 1 to 4: ${items.map(t => currentName(b.byId.get(t.accounts[0])!)).join('; ')}`,
      body: ['Recorded from team updates (sessions 1 to 4):', ...chains.flatMap(c => c.store)].join('\n'),
    }],
    session_facts: Array.from({ length: H5_SESSIONS - 1 }, (_, n) => items.flatMap(t => t.session_facts!.filter(f => f.session === n + 1))).flat(),
  };
}

const H1_TEMPLATES: Array<(r: Rng) => H1Clause[]> = [
  r => [{ kind: 'owner', staff: r.pick(P.STAFF) }],
  r => [{ kind: 'region', region: r.pick(P.REGIONS) }, { kind: 'segment', segment: r.pick(P.SEGMENTS) }],
  r => [{ kind: 'region', region: r.pick(P.REGIONS) }, { kind: 'open_escalated_ticket' }],
  r => [{ kind: 'segment', segment: r.pick(P.SEGMENTS) }, { kind: 'renewal_within', days: r.pick([60, 90, 120]) }],
  r => [{ kind: 'open_escalated_ticket' }, { kind: 'renewal_within', days: r.pick([90, 120, 180]) }],
  r => [{ kind: 'region', region: r.pick(P.REGIONS) }, { kind: 'renewal_within', days: r.pick([90, 120, 180]) }],
  r => [{ kind: 'owner', staff: r.pick(P.STAFF) }, { kind: 'open_escalated_ticket' }],
  r => [{ kind: 'segment', segment: r.pick(P.SEGMENTS) }, { kind: 'open_escalated_ticket' }],
];

function clauseText(c: H1Clause, asOf: string): string {
  switch (c.kind) {
    case 'owner': return `had ${c.staff} as account lead`;
    case 'segment': return `were in the ${c.segment} tier`;
    case 'region': return `were in the ${c.region} territory`;
    case 'open_escalated_ticket': return 'had a helpdesk ticket that had been escalated and was not yet resolved';
    case 'renewal_within': return `had a renewal date from ${asOf} through ${addDays(asOf, c.days)}`;
  }
}

/** Documents that decide one clause for one account; `deciding` keeps only what makes it hold. */
function clauseDocs(a: Acct, c: H1Clause, asOf: string, deciding: boolean): string[] {
  switch (c.kind) {
    case 'owner': { const e = eventAsOf(a.owner, asOf); return e ? [e.doc] : []; }
    case 'segment': case 'region': return [cardId(a)];
    case 'open_escalated_ticket': return a.tickets.filter(t => !deciding || (t.opened <= asOf && t.escalated !== undefined && t.escalated <= asOf && !(t.closed !== undefined && t.closed <= asOf))).map(t => t.doc);
    case 'renewal_within': { const e = eventAsOf(a.renewal, asOf); return e ? [e.doc] : []; }
  }
}

function h1Evidence(b: Builder, i: number, p: H1Predicate, members: string[], nearMisses: string[]) {
  const evidence = uniq(members.flatMap(id => p.clauses.flatMap(c => clauseDocs(b.byId.get(id)!, c, p.as_of, true))));
  const shown = new Rng(b.seed, `h1:${i}:near-miss`).shuffle(nearMisses).slice(0, b.k.h1_near_miss_cap);
  const near = shown.flatMap(id => p.clauses.flatMap(c => clauseDocs(b.byId.get(id)!, c, p.as_of, false)));
  return { evidence, relevant: uniq([...evidence, ...near]), near_miss: { total: nearMisses.length, in_evidence: shown.length } };
}

function buildH1(b: Builder): HardTask[] {
  const k = b.k;
  const r = new Rng(b.seed, 'h1');
  const facts = b.facts();
  const seen = new Set<string>();
  const tasks: HardTask[] = [];
  for (let tries = 0; tasks.length < k.tasks_per_family && tries < 50000; tries++) {
    const clauses = r.pick(H1_TEMPLATES)(r);
    const as_of = r.chance(0.3) ? TODAY : randomDate(r, '2026-02-01', TODAY);
    const p: H1Predicate = { as_of, clauses };
    const sig = JSON.stringify(p);
    if (seen.has(sig)) continue;
    const { members, nearMisses } = evaluatePredicate(p, facts);
    if (members.length < k.h1_min_members || members.length > k.h1_max_members) continue;
    seen.add(sig);
    const i = tasks.length;
    const asSet = i % 2 === 0;
    const words = clauses.map(c => clauseText(c, as_of)).join(' and ');
    const ev = h1Evidence(b, i, p, members, nearMisses);
    b.predicates.push(p);
    tasks.push({
      id: `H1-${pad2(i + 1)}`, family: 'H1', variant: `${asSet ? 'set' : 'count'}/${clauses.map(c => c.kind).join('+')}`, answer_kind: asSet ? 'set' : 'count', accounts: [],
      question: asSet
        ? `List every customer that, on ${as_of}, ${words}. Give the names as a JSON list of strings, shaped like ["<customer name>", "<customer name>"].`
        : `On ${as_of}, how many customers ${words}? Begin your answer with the number.`,
      gold: { ...(asSet ? { members: members.map(id => { const e = b.entity(b.byId.get(id)!); return { id, names: [e.name, ...e.aliases] }; }) } : { count: members.length }), evidence: ev.evidence },
      relevant: ev.relevant, near_miss: ev.near_miss, predicate: p,
    });
  }
  if (tasks.length < k.tasks_per_family) throw new Error(`H1: found ${tasks.length} of ${k.tasks_per_family} predicates with ${k.h1_min_members} to ${k.h1_max_members} members; raise accounts or widen the member range`);
  return tasks;
}

// ─── Assembly ───────────────────────────────────────────────────────

function renderBulletins(b: Builder, docs: LadderDoc[], label: string, skip: ReadonlySet<string> = new Set()): void {
  const r = new Rng(b.seed, label);
  const real = b.real();
  for (const bl of b.bulletins.filter(x => !skip.has(x.id))) {
    const open = real.filter(a => a.opened <= bl.date);
    const cite = (a: Acct) => b.who(bl.id, a, bl.date, 'name');
    const items = [...(bl.announce ? [bl.announce.text(cite(bl.announce.acct))] : [])];
    const n = r.int(bl.announce ? 1 : 3, bl.announce ? 3 : 5);
    for (let j = 0; j < n && open.length; j++) items.push(R.bulletinRoutine(r, cite(r.pick(open))));
    docs.push(R.renderBulletin(bl.id, bl.no, bl.date, r.shuffle(items)));
  }
}

/** Documents under their published ids, sorted by id. Call before reading `references` for them: it needs the readable ids. */
function publish(b: Builder, docs: LadderDoc[]): LadderDoc[] {
  return docs.map(d => ({ ...d, id: b.opaque(d.id) })).sort((x, y) => x.id.localeCompare(y.id));
}

export function sealedWorldDigest(w: HardWorld): string {
  return createHash('sha256').update(JSON.stringify(w)).digest('hex');
}

function build(seed: number, knobs: HardKnobs): { world: HardWorld; b: Builder } {
  const b = new Builder(seed, knobs);
  const t = knobs.tasks_per_family;
  const h2 = Array.from({ length: t }, (_, i) => question(b, 'H2', i, j => ({ task: buildH2(b, i, j) })));
  const h3 = Array.from({ length: t }, (_, i) => question(b, 'H3', i, j => ({ task: buildH3(b, i, j) })));
  const h4 = Array.from({ length: t }, (_, i) => question(b, 'H4', i, j => ({ task: buildH4(b, i, j) })));
  const h5 = Array.from({ length: t }, (_, i) => question(b, 'H5', i, j => buildH5(b, i, j)));
  for (let j = 0; j < knobs.accounts; j++) b.makeAccount(new Rng(seed, `acct:${j}`), { kind: 'background' });
  if (b.v2) b.assignNicknames(b.accts);
  const h1 = buildH1(b);
  assertH3Unique(b);
  b.markTimeline();
  const docs = b.accts.flatMap(a => b.finish(a));
  const br = new Rng(seed, 'bulletin-dates');
  for (let j = 0; j < knobs.team_updates; j++) b.reserveBulletin(randomDate(br, addDays(EPOCH, 30), TODAY));
  renderBulletins(b, docs, 'bulletins');
  const published = publish(b, docs);
  const entities = b.real().map(a => b.entity(a));
  nameRegistry(entities, normalizeValue);
  const world: HardWorld = {
    version: hasReferenceKnobs(knobs) ? SEALED_VERSION_V2 : SEALED_VERSION, mode: 'hard', seed, knob_schema: knobSchemaOf(knobs), knobs, knob_digest: knobDigest(knobs), max_turns: knobs.max_turns,
    today: TODAY, principal: { ...P.PRINCIPAL }, entities, docs: published, tasks: [...h1, ...h2, ...h3, ...h4, ...h5].map(t => b.publishTask(t)),
    ...(b.v2 ? { references: b.references(docs.map(d => d.id)) } : {}),
  };
  assertHardWorld(world);
  return { world, b };
}

/**
 * Keep an appended account out of every H1 key and every H3 disambiguation.
 * Its documents are not rendered yet, so the smallest change that clears
 * every predicate is applied to the ledger: territory or tier first, then
 * calmer tickets, a renewal outside every window, and a single account lead.
 */
function quarantine(b: Builder, a: Acct): void {
  const matching = b.h3.filter(s => tokenMatches(a, s.token));
  const hits = (f: Pick<Acct, 'segment' | 'region' | 'owner' | 'tickets' | 'renewal'>) =>
    b.predicates.some(p => p.clauses.every(c => clauseHolds(c, { id: a.id, ...f }, p.as_of))) || matching.some(s => factHolds(f, s.fact));
  const busy = new Set([
    ...b.predicates.flatMap(p => p.clauses.flatMap(c => (c.kind === 'owner' ? [c.staff] : []))),
    ...matching.flatMap(s => (s.fact.kind === 'lead-on' ? [s.fact.staff] : [])),
  ]);
  const single = (staff: string): ValueEvent[] => [{ value: staff, effective: a.opened, recorded: a.opened, doc: cardId(a), kind: 'initial' }];
  const owners = [a.owner, ...(b.v2 ? P.APPENDED_TEAM : P.STAFF).filter(s => !busy.has(s)).map(single)];
  const renewals = [a.renewal, [{ ...a.renewal[0], value: addDays(TODAY, 400) }]];
  const ticketSets = [a.tickets, a.tickets.map(({ escalated: _e, ...t }) => t)];
  const segments = [a.segment, ...P.SEGMENTS.filter(x => x !== a.segment)];
  const regions = [a.region, ...P.REGIONS.filter(x => x !== a.region)];
  for (const owner of owners) for (const renewal of renewals) for (const tickets of ticketSets) for (const segment of segments) for (const region of regions) {
    if (hits({ segment, region, owner, tickets, renewal })) continue;
    if (owner !== a.owner) b.flattenOwner(a, owner[0].value);
    if (renewal !== a.renewal) { a.renewal = renewal; a.cos = a.cos.filter(co => !co.items.some(i => i.label === 'Renewal date')); }
    a.tickets = tickets;
    a.segment = segment;
    a.region = region;
    return;
  }
  throw new Error('50k append: an appended account cannot be kept out of every Hard predicate');
}

function extendLarge(b: Builder, base: HardWorld): HardWorld {
  const k = b.k;
  const appended: Acct[] = [];
  const team = b.v2 ? { team: P.APPENDED_TEAM } : {};
  const baseBulletins = new Set(b.bulletins.map(x => x.id));
  for (const s of b.h3) {
    const target = b.byId.get(s.target)!;
    const r = new Rng(b.seed, `large:h3:${s.task}`);
    appended.push(b.makeAccount(r, { kind: 'appended', avoidRegion: target.region, avoidSegment: target.segment, ...(s.token.kind === 'first-word' ? { first: s.token.value } : { prefix: s.token.value }), ...team }));
  }
  for (let j = 0; j < k.large_extra_accounts; j++) appended.push(b.makeAccount(new Rng(b.seed, `large:acct:${j}`), { kind: 'appended', firstSyllables: 3, ...team }));
  for (const a of appended) quarantine(b, a);
  if (b.v2) b.assignNicknames(appended);
  b.markTimeline();

  const docs: LadderDoc[] = [];
  for (const a of b.accts) {
    if (a.kind === 'appended' || a.ghostOf) continue;
    const r = new Rng(b.seed, `large:nondeciding:${a.id}`);
    for (let j = 0; j < k.large_nondeciding_per_account; j++) {
      const date = randomDate(r, a.opened, TODAY);
      if (j % 3 === 2) {
        const id = nextId(a, 'minutes', 'session');
        docs.push(R.renderMinutes(a, r, id, date, r.int(6, 20), (a.seq.minutes ?? 0), b.who(id, a, date, 'name')));
      } else {
        const id = nextId(a, 'mail', 'fw');
        docs.push(R.routineForward(a, r, id, date, sent => b.who(id, a, sent, 'code')));
      }
    }
  }
  for (const a of appended) docs.push(...b.finish(a));
  renderBulletins(b, docs, 'large:bulletins', baseBulletins);

  const facts = b.facts();
  const tasks = base.tasks.map((t, idx) => {
    if (t.family !== 'H1') return t;
    const p = t.predicate!;
    const { members, nearMisses } = evaluatePredicate(p, facts);
    const before = t.answer_kind === 'set' ? t.gold.members!.map(m => m.id) : null;
    if (t.answer_kind === 'count' ? members.length !== t.gold.count : JSON.stringify(members) !== JSON.stringify(before)) throw new Error(`50k append changed the key of H1 task index ${idx}`);
    const ev = h1Evidence(b, idx, p, members, nearMisses);
    return { ...t, relevant: b.v2 ? b.withResolution(ev.relevant).map(id => b.opaque(id)) : ev.relevant, near_miss: ev.near_miss };
  });
  assertH3Unique(b);
  const entities = [...base.entities, ...appended.map(a => b.entity(a))];
  nameRegistry(entities, normalizeValue);
  const world: HardWorld = {
    ...base, scale: 'large', base_digest: sealedWorldDigest(base), entities, docs: [...base.docs, ...publish(b, docs)], tasks,
    ...(b.v2 ? { references: [...base.references!, ...b.references(docs.map(d => d.id))] } : {}),
  };
  assertHardWorld(world);
  return world;
}

/** Build a sealed world and the H5 site directories its dependency check needs. */
export function buildSealed(seed: number, knobs: HardKnobs = DEFAULT_HARD_KNOBS, scale: 'v1' | 'large' = 'v1'): { world: HardWorld; h5: H5Ledger[] } {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error(`seed must be a non-negative integer (got ${seed})`);
  const { world, b } = build(seed, knobs);
  return { world: scale === 'large' ? extendLarge(b, world) : world, h5: b.h5 };
}

/** The regenerator registered in HARD_WORLD_GENERATORS under `hard-sealed`. */
export function generateSealedWorld(seed: number, knobs: HardKnobs = DEFAULT_HARD_KNOBS, scale: 'v1' | 'large' = 'v1'): HardWorld {
  return buildSealed(seed, knobs, scale).world;
}
