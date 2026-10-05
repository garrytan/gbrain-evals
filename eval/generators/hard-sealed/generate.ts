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
import { DEFAULT_HARD_KNOBS, HARD_KNOB_SCHEMA_VERSION, knobDigest, type H1Clause, type H1Predicate, type HardEntity, type HardKnobs, type HardTask, type HardWorld, type SessionFact } from '../hard/schema.ts';
import { clauseHolds, correctionOf, evaluatePredicate, eventAsOf, historyValues, nameRegistry, statedValue, valueAsOf, type PredicateFacts, type UserStatement, type ValueEvent } from '../hard/semantics.ts';
import { assertHardWorld } from '../hard/validate.ts';
import { normalizeValue } from '../../runner/cat40/score.ts';
import { Rng } from './rng.ts';
import * as P from './pools.ts';
import {
  TODAY, EPOCH, addDays, maxDate, minDate, randomDate, distinctDates, longDate, currentName, nameAt, nextId, folder, cardId, changesId, formId,
  type Acct, type ChangeOrder, type Ticket,
} from './ledger.ts';
import * as R from './render.ts';

/** Version string of sealed worlds; the runner's regenerator registry uses it as the key. */
export const SEALED_VERSION = 'hard-sealed';

type Fact =
  | { kind: 'region'; region: string }
  | { kind: 'segment'; segment: string }
  | { kind: 'lead-on'; date: string; staff: string }
  | { kind: 'ticket'; key: string };

interface H3Spec { task: number; token: { kind: 'first-word' | 'code-prefix'; value: string }; fact: Fact; target: string }

/** What the H5 dependency check needs about a task beyond the world: the site directory's contacts. */
export interface H5Ledger { task: string; account: string; directory: Record<string, string> }

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
  bulletins: Array<{ id: string; no: number; date: string; items: string[]; announce?: { acct: Acct; text: string } }> = [];
  h3: H3Spec[] = [];
  h5: H5Ledger[] = [];
  predicates: H1Predicate[] = [];

  constructor(readonly seed: number, readonly k: HardKnobs) {}

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

  newName(r: Rng, first: string): string {
    for (const trade of r.shuffle(P.TRADES)) {
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

  makeAccount(r: Rng, o: { kind: Acct['kind']; first?: string; firstSyllables?: 2 | 3; prefix?: string; segment?: string; region?: string; avoidSegment?: string; avoidRegion?: string; ghost?: boolean; openedBy?: string }): Acct {
    const first = o.first ?? this.newFirstWord(r, o.firstSyllables ?? 2);
    const name = this.newName(r, first);
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
      region: o.region ?? r.pick(P.REGIONS.filter(s => s !== o.avoidRegion)),
      domain: `${first.toLowerCase()}-${name.split(' ')[1].toLowerCase()}.example`,
      contacts, owner: [], renewal: [], tickets: [], form, changes: [], cos: [], announcements: [], docs: [], seq: {}, kind: o.kind,
    };
    this.accts.push(a);
    this.byId.set(a.id, a);
    if (!o.ghost) { this.buildOwner(a, r); this.buildRenewal(a, r); this.buildTickets(a, r); }
    return a;
  }

  addCo(a: Acct, co: Omit<ChangeOrder, 'id' | 'no' | 'author'>, author = 'contracts-desk'): ChangeOrder {
    const no = a.cos.length + 1;
    const full: ChangeOrder = { id: `paper/${folder(a)}/co-${pad2(no)}`, no, author, ...co };
    a.cos.push(full);
    return full;
  }

  private buildOwner(a: Acct, r: Rng): void {
    const k = this.k;
    a.owner.push({ value: r.pick(P.STAFF), effective: a.opened, recorded: a.opened, doc: cardId(a), kind: 'initial' });
    const n = r.int(0, k.handoffs_per_account_max);
    let cur = a.owner[0].value;
    for (const eff of distinctDates(r, n, addDays(a.opened, 25), addDays(TODAY, 20))) {
      const next = r.pick(P.STAFF.filter(s => s !== cur));
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
      const ev: ValueEvent = { value: next, effective: eff, recorded, doc: changesId(a), kind: 'change' };
      a.owner.push(ev);
      a.changes.push({ logged: recorded, field: 'account lead', was: cur, now: next, effective: eff, by: 'crm-sync' });
      cur = next;
      const fixedOn = addDays(recorded, r.int(3, 25));
      if (r.chance(0.12) && fixedOn <= TODAY) {
        const fixed = r.pick(P.STAFF.filter(s => s !== next && s !== ev.value));
        a.owner.push(correctionOf(ev, fixed, fixedOn, changesId(a)));
        a.changes.push({ logged: fixedOn, field: 'account lead', was: next, now: fixed, effective: eff, by: 'ops-desk', note: `correction: the row keyed ${recorded} named the wrong lead` });
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

  scratch(a: Acct, date: string, lines: string[]): LadderDoc {
    const d = R.renderScratch(a, nextId(a, 'assistant', 'scratch'), date, lines);
    a.docs.push(d);
    return d;
  }

  forward(a: Acct, spec: Omit<R.ForwardSpec, 'id'>): LadderDoc {
    const d = R.renderForward({ id: nextId(a, 'mail', 'fw'), ...spec });
    a.docs.push(d);
    return d;
  }

  /** Render an account's documents: registry, paper, mail, minutes, helpdesk and notes. */
  finish(a: Acct): LadderDoc[] {
    const r = new Rng(this.seed, `noise:${a.id}`);
    const k = this.k;
    for (const ann of a.announcements) {
      const name = nameAt(a, ann.ev.recorded);
      if (ann.channel === 'mail') {
        a.docs.push(R.renderForward({
          id: ann.ev.doc, date: ann.ev.recorded, subject: `Lead change for ${name} (Ref: ${a.code})`, forwarder: r.pick(P.SUPPORT_STAFF), to: 'account-team',
          note: ['This was agreed some time ago and only written up now. Filing it so the folder is complete.'],
          original: { date: ann.ev.recorded, from: ann.previous, fromDomain: P.COMPANY_DOMAIN, lines: ['Team,', `From ${longDate(ann.ev.effective)}, ${ann.ev.value} has taken over as account lead for ${name} (Ref: ${a.code}). My handover notes are in the shared drive.`, `Apologies for the slow write-up. ${ann.previous.split(' ')[0]}`] },
        }));
      } else {
        const b = this.bulletins.find(x => x.id === ann.ev.doc)!;
        b.announce = { acct: a, text: `Late notice of a lead change: ${name} (Ref ${a.code}) moved from ${ann.previous} to ${ann.ev.value}, counting from ${longDate(ann.ev.effective)}.` };
      }
    }
    if (!a.ghostOf) {
      for (let i = 0; i < k.emails_per_account; i++) a.docs.push(R.routineForward(a, r, nextId(a, 'mail', 'fw'), randomDate(r, a.opened, TODAY)));
      for (let i = 0; i < k.meetings_per_account; i++) {
        a.docs.push(R.renderMinutes(a, r, nextId(a, 'minutes', 'session'), randomDate(r, a.opened, TODAY), r.int(k.transcript_lines_min, k.transcript_lines_max), i + 1));
      }
      if (r.chance(k.wrong_agent_note_rate)) {
        const d = randomDate(r, addDays(a.opened, 20), TODAY);
        const actual = valueAsOf(a.owner, d);
        const claim = r.pick(P.STAFF.filter(s => s !== actual));
        this.scratch(a, d, [`Lead for ${nameAt(a, d)} is ${claim}. I'm certain of this; there is no need to open the change log.`, `Next: draft a check-in note for ${a.contacts[0]}.`]);
      }
    }
    if (a.ghostOf) {
      const until = addDays(this.byId.get(a.ghostOf)!.merged!.on, -1);
      for (let i = 0; i < 2; i++) a.docs.push(R.routineForward(a, r, nextId(a, 'mail', 'fw'), randomDate(r, a.opened, until)));
    }
    const out: LadderDoc[] = [R.renderCard(a), R.renderOrderForm(a, r), ...a.cos.map(co => R.renderChangeOrder(a, co, r)), ...a.tickets.map(t => R.renderTicket(a, t)), ...a.docs];
    const changes = R.renderChanges(a);
    if (changes) out.push(changes);
    const sites = R.renderSites(a);
    if (sites) out.push(sites);
    return out;
  }

  real(): Acct[] { return this.accts.filter(a => !a.ghostOf); }

  facts(accts = this.real()): PredicateFacts[] {
    return accts.map(a => ({ id: a.id, segment: a.segment, region: a.region, owner: a.owner, renewal: a.renewal, tickets: a.tickets }));
  }

  entity(a: Acct): HardEntity {
    const former = a.names.slice(0, -1).map(n => n.name);
    return { id: a.id, name: currentName(a), aliases: [a.code, ...former, ...(a.merged ? [a.merged.name, a.merged.code] : [])] };
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

function buildH2(b: Builder, i: number): HardTask {
  const k = b.k;
  const r = new Rng(b.seed, `h2:${i}`);
  const a = b.makeAccount(r, { kind: 'task', openedBy: '2025-11-30' });
  const attr = P.H2_ATTRS[i % P.H2_ATTRS.length];
  const { label, values } = P.ATTRIBUTES[attr];
  for (let attempt = 0; attempt < 60; attempt++) {
    const h = new Rng(b.seed, `h2:${i}:${attempt}`);
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
      if (v) b.scratch(a, d, [`${label} for ${nameAt(a, d)}: ${v}, going by the newest paperwork I could find today.`, `Re-check before the next invoice run.`]);
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

function buildH3(b: Builder, i: number): HardTask {
  const k = b.k;
  const r = new Rng(b.seed, `h3:${i}`);
  const variant = (['first-word', 'code-prefix', 'renamed', 'merged'] as const)[i % 4];
  const attr = r.pick(P.H3_ATTRS);
  const { label, values } = P.ATTRIBUTES[attr];
  const nLook = r.int(k.h3_lookalikes_min, k.h3_lookalikes_max);
  const vals = r.sample(values, nLook + 2);
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
    target = b.makeAccount(r, { kind: 'task', prefix, segment, region });
    for (let j = 0; j < nLook; j++) look({ prefix });
    token = { kind: 'code-prefix', value: prefix };
    target.form[label] = vals[0];
    attrDoc = formId(target);
  } else if (variant === 'first-word') {
    const first = b.newFirstWord(r, 2);
    target = b.makeAccount(r, { kind: 'task', first, segment, region });
    for (let j = 0; j < nLook; j++) look({ first });
    token = { kind: 'first-word', value: first };
    target.form[label] = vals[0];
    attrDoc = formId(target);
  } else if (variant === 'renamed') {
    const first = b.newFirstWord(r, 2);
    target = b.makeAccount(r, { kind: 'task', first, segment, region, openedBy: '2025-12-31' });
    for (let j = 0; j < nLook; j++) look({ first });
    token = { kind: 'first-word', value: first };
    const oldName = target.names[0].name;
    const on = randomDate(r, addDays(target.opened, 45), addDays(TODAY, -90));
    const newName = b.newName(r, b.newFirstWord(r, 2));
    target.names.push({ name: newName, from: on });
    target.changes.push({ logged: on, field: 'registered name', was: oldName, now: newName, effective: on, by: 'contracts-desk', note: 'short-name unchanged' });
    const notice = b.forward(target, {
      date: on, subject: `New registered name (Ref: ${target.code})`, forwarder: r.pick(P.SUPPORT_STAFF), to: 'account-team', note: ['Please update any templates that still carry the old name.'],
      original: { date: on, from: target.contacts[0], fromDomain: target.domain, lines: [`Hello,`, `${oldName} now trades as ${newName}. Our short-name with you stays ${target.code}, and nothing else about the account changes.`, `Best, ${target.contacts[0].split(' ')[0]}`] },
    });
    target.form[label] = vals[nLook + 1];
    wrong.push(vals[nLook + 1]);
    const signed = randomDate(r, addDays(on, 5), addDays(TODAY, -5));
    attrDoc = b.addCo(target, { state: 'executed', signed, effective: signed, items: [{ label, value: vals[0] }] }).id;
    evidence.push(changesId(target), notice.id);
    relevant.push(formId(target));
  } else {
    target = b.makeAccount(r, { kind: 'task', segment, region, openedBy: '2025-11-30' });
    const first = b.newFirstWord(r, 2);
    const ghost = b.makeAccount(r, { kind: 'task', first, segment, region, ghost: true, openedBy: '2025-12-31' });
    for (let j = 0; j < nLook; j++) look({ first });
    token = { kind: 'first-word', value: first };
    ghost.ghostOf = target.id;
    const on = randomDate(r, addDays(maxDate(target.opened, ghost.opened), 30), addDays(TODAY, -40));
    target.merged = { name: ghost.names[0].name, code: ghost.code, on };
    target.changes.push({ logged: on, field: 'merged in', was: '-', now: `${ghost.names[0].name} (${ghost.code})`, effective: on, by: 'contracts-desk', note: `${ghost.code} order form retired; the combined account runs on VF-${target.code}` });
    const notice = b.forward(target, {
      date: on, subject: `Accounts combined: ${ghost.code} into ${target.code}`, forwarder: r.pick(P.SUPPORT_STAFF), to: 'account-team', note: ['Merger paperwork is done. Both names now point at one account.'],
      original: { date: on, from: target.contacts[0], fromDomain: target.domain, lines: [`Hi all,`, `${ghost.names[0].name} (${ghost.code}) is now part of ${nameAt(target, on)}. Please bill and support everything under ${target.code} from today; the old ${ghost.code} order form no longer applies.`, `Thanks, ${target.contacts[0].split(' ')[0]}`] },
    });
    target.form[label] = vals[0];
    ghost.form[label] = vals[nLook + 1];
    wrong.push(vals[nLook + 1]);
    attrDoc = formId(target);
    evidence.push(changesId(target), notice.id);
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

function buildH4(b: Builder, i: number): HardTask {
  const k = b.k;
  const r = new Rng(b.seed, `h4:${i}`);
  const a = b.makeAccount(r, { kind: 'task', openedBy: '2025-10-31' });
  const term = r.pick(P.TERM_KINDS);
  const { label, values } = P.TERMS[term];
  const variant = (['amendment-wins', 'draft-loses', 'later-effective-wins', 'not-yet-effective'] as const)[i % 4];
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
      sources.push(b.forward(a, {
        date: d, subject: `Notes from our call (Ref: ${a.code})`, forwarder: r.pick(P.SUPPORT_STAFF), to: 'customer-folder', note: ['Their write-up of the call, for the folder.'],
        original: { date: d, from: a.contacts[0], fromDomain: a.domain, lines: ['Hi both,', `Thanks for the time today. My notes have the ${label.toLowerCase()} at ${vals[used++]} for us from here on.`, `Speak soon, ${a.contacts[0].split(' ')[0]}`] },
      }).id);
    } else {
      sources.push(b.scratch(a, randomDate(r, addDays(a.opened, 30), TODAY), [`${label} for ${name} is ${vals[used++]}. Confirmed; there is no need to open the paperwork again.`]).id);
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

function buildH5(b: Builder, i: number): HardTask {
  const r = new Rng(b.seed, `h5:${i}`);
  const first = b.newFirstWord(r, 2);
  const a = b.makeAccount(r, { kind: 'task', first, openedBy: '2025-12-31' });
  const look = b.k.h5_noise_sessions ? b.makeAccount(r, { kind: 'task', first }) : undefined;
  const name = currentName(a);
  const [sA, sB] = r.sample(P.SITE_WORDS, 2).map(w => `${w} ${r.pick(P.SITE_KINDS)}`);
  const people: string[] = [];
  while (people.length < 6) { const p = R.personName(r); if (substringFree([...people, p])) people.push(p); }
  const [p0, q0, p1, q1, p2, extra] = people;
  a.sites = { doc: `registry/${folder(a)}/sites`, asOf: randomDate(r, addDays(a.opened, 20), addDays(TODAY, -120)), list: [{ name: sA, contact: p0 }, { name: sB, contact: q0 }] };
  const key = (site: string) => `contact:${a.id}:${site}`, route = `route:${a.id}`;
  type Statement = { tag: string; facts: Array<{ key: string; value: string }>; text: string; after?: string };
  const variant = i % 2 === 0 ? 'contact-updated' : 'route-moved';
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
  const closings = [
    'Keep this somewhere you can find it in a later conversation, then submit RECORDED as your answer.',
    'Save it to memory for later sessions and answer with RECORDED.',
    'Please store this durably; when done, submit the single word RECORDED.',
  ];
  const tid = `H5-${pad2(i + 1)}`;
  b.h5.push({ task: tid, account: a.id, directory });
  const store = [`Renewal paperwork for ${name} goes to the ${routed}.`, `Signs for documents at the ${sA}: ${statedValue(said, key(sA), p0)}.`, `Signs for documents at the ${sB}: ${statedValue(said, key(sB), q0)}.`];
  if (look) store.push(`${currentName(look)} is a different customer; its routing does not apply to ${name}.`);
  return {
    id: tid, family: 'H5', variant, answer_kind: 'value', accounts: [a.id, ...(look ? [look.id] : [])],
    sessions: order.map(s => `${s.text} ${r.pick(closings)}`),
    question: `Who should receive the signed renewal paperwork for ${name}? Give the person's full name only.`,
    gold: { answer: [answer], wrong: personValues.filter(v => v !== answer), evidence: [a.sites.doc] },
    relevant: [a.sites.doc],
    oracle_notes: [{ id: `oracle/${tid.toLowerCase()}-store`, title: `What the store holds after sessions 1 to 4: ${name}`, body: store.join('\n') }],
    session_facts,
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
    const items = [...(bl.announce ? [bl.announce.text] : [])];
    const n = r.int(bl.announce ? 1 : 3, bl.announce ? 3 : 5);
    for (let j = 0; j < n && open.length; j++) items.push(R.bulletinRoutine(r, r.pick(open), bl.date));
    docs.push(R.renderBulletin(bl.id, bl.no, bl.date, r.shuffle(items)));
  }
}

export function sealedWorldDigest(w: HardWorld): string {
  return createHash('sha256').update(JSON.stringify(w)).digest('hex');
}

function build(seed: number, knobs: HardKnobs): { world: HardWorld; b: Builder } {
  const b = new Builder(seed, knobs);
  const t = knobs.tasks_per_family;
  const h2 = Array.from({ length: t }, (_, i) => buildH2(b, i));
  const h3 = Array.from({ length: t }, (_, i) => buildH3(b, i));
  const h4 = Array.from({ length: t }, (_, i) => buildH4(b, i));
  const h5 = Array.from({ length: t }, (_, i) => buildH5(b, i));
  for (let j = 0; j < knobs.accounts; j++) b.makeAccount(new Rng(seed, `acct:${j}`), { kind: 'background' });
  const h1 = buildH1(b);
  assertH3Unique(b);
  const docs = b.accts.flatMap(a => b.finish(a));
  const br = new Rng(seed, 'bulletin-dates');
  for (let j = 0; j < knobs.team_updates; j++) b.reserveBulletin(randomDate(br, addDays(EPOCH, 30), TODAY));
  renderBulletins(b, docs, 'bulletins');
  docs.sort((x, y) => x.id.localeCompare(y.id));
  const entities = b.real().map(a => b.entity(a));
  nameRegistry(entities, normalizeValue);
  const world: HardWorld = {
    version: SEALED_VERSION, mode: 'hard', seed, knob_schema: HARD_KNOB_SCHEMA_VERSION, knobs, knob_digest: knobDigest(knobs), max_turns: knobs.max_turns,
    today: TODAY, principal: { ...P.PRINCIPAL }, entities, docs, tasks: [...h1, ...h2, ...h3, ...h4, ...h5],
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
  const owners = [a.owner, ...P.STAFF.filter(s => !busy.has(s)).map(single)];
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
  const baseBulletins = new Set(b.bulletins.map(x => x.id));
  for (const s of b.h3) {
    const target = b.byId.get(s.target)!;
    const r = new Rng(b.seed, `large:h3:${s.task}`);
    appended.push(b.makeAccount(r, { kind: 'appended', avoidRegion: target.region, avoidSegment: target.segment, ...(s.token.kind === 'first-word' ? { first: s.token.value } : { prefix: s.token.value }) }));
  }
  for (let j = 0; j < k.large_extra_accounts; j++) appended.push(b.makeAccount(new Rng(b.seed, `large:acct:${j}`), { kind: 'appended', firstSyllables: 3 }));
  for (const a of appended) quarantine(b, a);

  const docs: LadderDoc[] = [];
  for (const a of b.accts) {
    if (a.kind === 'appended' || a.ghostOf) continue;
    const r = new Rng(b.seed, `large:nondeciding:${a.id}`);
    for (let j = 0; j < k.large_nondeciding_per_account; j++) {
      const date = randomDate(r, a.opened, TODAY);
      docs.push(j % 3 === 2
        ? R.renderMinutes(a, r, nextId(a, 'minutes', 'session'), date, r.int(6, 20), (a.seq.minutes ?? 0))
        : R.routineForward(a, r, nextId(a, 'mail', 'fw'), date));
    }
  }
  for (const a of appended) docs.push(...b.finish(a));
  renderBulletins(b, docs, 'large:bulletins', baseBulletins);
  docs.sort((x, y) => x.id.localeCompare(y.id));

  const facts = b.facts();
  const tasks = base.tasks.map((t, idx) => {
    if (t.family !== 'H1') return t;
    const p = t.predicate!;
    const { members, nearMisses } = evaluatePredicate(p, facts);
    const before = t.answer_kind === 'set' ? t.gold.members!.map(m => m.id) : null;
    if (t.answer_kind === 'count' ? members.length !== t.gold.count : JSON.stringify(members) !== JSON.stringify(before)) throw new Error(`50k append changed the key of H1 task index ${idx}`);
    const ev = h1Evidence(b, idx, p, members, nearMisses);
    return { ...t, relevant: ev.relevant, near_miss: ev.near_miss };
  });
  assertH3Unique(b);
  const entities = [...base.entities, ...appended.map(a => b.entity(a))];
  nameRegistry(entities, normalizeValue);
  const world: HardWorld = { ...base, scale: 'large', base_digest: sealedWorldDigest(base), entities, docs: [...base.docs, ...docs], tasks };
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
