/**
 * N7 open-loops world generator: Gmail-shaped threads with known loop state.
 *
 * Emits a LEDGER of synthetic threads (who wrote each message, to whom, how
 * many hours before a pinned now, what the author's own text says, what it
 * quotes, whether it is calendar, list or noise mail) and multi-round store
 * scenarios, then derives two kinds of gold from the ledger:
 *
 *   mechanics  an independent implementation of the rules gbrain documents in
 *              docs/guides/open-loops.md: the last substantive message is
 *              theirs, I am in To and it has been unanswered for 24 hours, so
 *              a reply is owed; the last substantive message is mine, asks a
 *              question and has been unanswered for 72 hours, so I am waiting;
 *              a reply flips the turn and closes the answered loop; noise,
 *              calendar notices, list mail, CC-only delivery, self-threads and
 *              mail without a question never open a loop. "Unanswered for 24
 *              hours" is read as the time since the first unanswered message in
 *              the trailing run, so a nudge does not restart the clock (the
 *              reading gbrain's own loop-detect.ts comment gives for nudges).
 *              Whether a message asks a question, and whether it is noise,
 *              calendar or list mail, are ledger facts the generator writes,
 *              never gbrain's classifiers.
 *   semantic   what a person reading the thread would say: is the counterparty
 *              still waiting on me, did someone promise something, was the
 *              promise fulfilled. Reported separately and never mapped onto
 *              reply closure (wave amendment 8).
 *
 * Nothing here reads gbrain output. Names and addresses are invented
 * placeholders on example.* domains.
 *
 * Usage: bun eval/generators/n7-gmail-loops-gen.ts [--seed N] [--json]
 */
import { createHash } from 'node:crypto';

export const N7_GENERATOR_VERSION = 'n7-gmail-loops-gen-v1';
export const N7_DEFAULT_SEED = 7;
/** The pinned "now" every detector call receives. */
export const N7_NOW_ISO = '2026-10-01T12:00:00.000Z';
export const ME = 'me@example.com';
export const ME_ALIAS = 'me.alt@example.com';
export const MY_ADDRESSES = [ME, ME_ALIAS] as const;
export const INBOUND_GRACE_H = 24;
export const OUTBOUND_GRACE_H = 72;
/** The acknowledgement-only replies the generator writes (ack_thanks threads and the ack_close scenario). */
export const ACK_ONLY_REPLIES: readonly string[] = ['Thanks!', 'Thanks, got it.', 'Noted, thank you.'];

/**
 * Which documented open-loop rules the oracle applies (amendment of 2026-10-03,
 * docs/benchmarks/2026-10-03-n7-oracle-amendment.md):
 *   reply-closes        docs/guides/open-loops.md at 3a284ae and d44296c: any
 *                       reply of mine flips the turn, "Thanks!" included.
 *   ack-is-not-a-reply  the same guide at 48ed5e8 (v0.60.32.0): my
 *                       acknowledgement-only reply to their question is not an
 *                       answer; the loop stays open and its clock keeps running.
 */
export type N7Rules = 'reply-closes' | 'ack-is-not-a-reply';
export const N7_ACK_RULE_SINCE = '0.60.32.0';

/** The rules documented by the gbrain version under test. */
export function n7RulesFor(version: string): N7Rules {
  const parse = (v: string) => v.split('.').map(n => Number.parseInt(n, 10) || 0);
  const a = parse(version); const b = parse(N7_ACK_RULE_SINCE);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? 'ack-is-not-a-reply' : 'reply-closes';
  }
  return 'ack-is-not-a-reply';
}

export type MessageKind = 'human' | 'noise' | 'calendar' | 'list';

export interface LedgerMessage {
  id: string;
  /** Full From header, display name included. */
  from: string;
  /** Bare lowercase sender address (the ledger's own normalization). */
  from_address: string;
  sent_by_me: boolean;
  to: string[];
  cc: string[];
  subject: string;
  age_hours: number;
  kind: MessageKind;
  /** The author's own words. */
  own_text: string;
  /** Text below the author's words (a quoted reply or a forwarded message), or ''. */
  quoted: string;
  /** Ledger fact: the author's own words ask the counterparty something. */
  asks: boolean;
}

export type ThreadClass =
  | 'inbound_owed' | 'inbound_alias' | 'inbound_multi_to' | 'mixed_case_sender' | 'outbound_question' | 'outbound_multi_to'
  | 'outbound_answered_then_owed' | 'calendar_after_question'
  | 'answered_by_me' | 'ack_thanks' | 'outbound_answered_fresh' | 'reply_with_quoted_question' | 'forward_fyi'
  | 'inbound_fresh' | 'outbound_fresh' | 'cc_only' | 'list_mail' | 'noise' | 'calendar_only' | 'self_thread' | 'outbound_fyi'
  | 'nudge_inbound_backfill' | 'followup_outbound_backfill' | 'url_question_fyi'
  | 'promise_pending' | 'promise_fulfilled' | 'promise_then_thanks' | 'promise_to_me';

/** Classes whose every message the documented rules exclude from opening a loop. */
export const EXCLUDED_CLASSES: readonly ThreadClass[] = ['inbound_fresh', 'outbound_fresh', 'cc_only', 'list_mail', 'noise', 'calendar_only', 'self_thread', 'outbound_fyi'];
/** Classes where the reading of a documented rule is contested; reported, never in the gated rates. */
export const CONTESTED_CLASSES: readonly ThreadClass[] = ['nudge_inbound_backfill', 'followup_outbound_backfill', 'url_question_fyi'];

export interface SemanticLabels {
  /** The counterparty is still waiting on me for something. */
  someone_waiting_on_me: boolean;
  promise: null | { by: 'me' | 'them'; what: string; due: string | null; fulfilled: boolean };
}

export interface LedgerThread {
  id: string;
  klass: ThreadClass;
  messages: LedgerMessage[];
  semantic: SemanticLabels;
}

export type LoopType = 'unanswered_inbound' | 'unanswered_outbound';

export interface MechanicsGold {
  open: null | { loop_type: LoopType; counterparty: string };
  /** The loop type the last substantive message answers (turn flip), or null when no human mail exists. */
  closes: LoopType | null;
  /** True when, before the last substantive message, the documented rules held a loop of type `closes` open. */
  closure_case: boolean;
}

export type ScenarioStep =
  | { kind: 'apply'; messages: number; now_offset_hours: number; expect: { status: 'open' | 'done' | 'absent'; loop_type: LoopType; counterparty?: string; closed_by?: string } }
  | { kind: 'manual_close'; loop_type: LoopType; status: 'done' | 'dropped' }
  | { kind: 'mute'; mute: 'sender' | 'thread'; value: string };

export type ScenarioKind = 'reply_close' | 'ack_close' | 'nudge_hold' | 'calendar_hold' | 'manual_close' | 'mute_sender' | 'mute_thread' | 'turn_flip';

export interface StoreScenario {
  id: string;
  kind: ScenarioKind;
  thread: LedgerThread;
  steps: ScenarioStep[];
}

export interface N7Ledger {
  generator_version: string;
  seed: number;
  now: string;
  my_addresses: string[];
  threads: LedgerThread[];
  scenarios: StoreScenario[];
}

export interface GeneratedN7 {
  ledger: N7Ledger;
  fingerprint: string;
  gold: Map<string, MechanicsGold>;
}

function mulberry32(seed: number): () => number {
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
  readonly #next: () => number;
  constructor(seed: number) { this.#next = mulberry32(seed); }
  float(): number { return this.#next(); }
  int(lo: number, hi: number): number { return lo + Math.floor(this.#next() * (hi - lo + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.#next() * xs.length)]; }
}

const FIRST = ['Avelin', 'Brisa', 'Corvan', 'Dellith', 'Emberly', 'Fenno', 'Gorrin', 'Hessa', 'Ivrel', 'Jorrit', 'Kesmi', 'Lunet', 'Morrow', 'Nyssa', 'Orvel', 'Pella', 'Quorin', 'Rissa', 'Sorrel', 'Tamsin', 'Ulric', 'Vessa', 'Wrenna', 'Yorin'];
const LAST = ['Quillfeather', 'Oakhollow', 'Marrowby', 'Thistlewick', 'Ambermoor', 'Fernsby', 'Ravelwood', 'Stonemere', 'Ashgrove', 'Brindlecombe', 'Copperfield-Example', 'Duskvale', 'Elmsworth', 'Foxmere', 'Glimmerton', 'Hollowell'];
const DOMAINS = ['example.org', 'example.net', 'acme-example.com', 'fund-a-example.com', 'startup-example.io'];
const TOPICS = ['the Q3 budget', 'the vendor contract', 'the hiring plan', 'the launch checklist', 'the board deck', 'the pilot results', 'the travel dates', 'the design review', 'the pricing sheet', 'the partner intro'];
const ITEMS = ['the deck', 'the signed contract', 'the revised numbers', 'the meeting notes', 'the draft proposal', 'the floor plan'];
const DUE_DATES = ['2026-10-03', '2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09'];
const WEEKDAY: Record<string, string> = { '2026-10-03': 'Saturday October 3', '2026-10-05': 'Monday October 5', '2026-10-06': 'Tuesday October 6', '2026-10-08': 'Thursday October 8', '2026-10-09': 'Friday October 9' };

/** How many threads of each class one seed generates. */
export const CLASS_COUNTS: Readonly<Record<ThreadClass, number>> = {
  inbound_owed: 12, inbound_alias: 3, inbound_multi_to: 3, mixed_case_sender: 3, outbound_question: 10, outbound_multi_to: 3,
  outbound_answered_then_owed: 4, calendar_after_question: 4,
  answered_by_me: 8, ack_thanks: 8, outbound_answered_fresh: 5, reply_with_quoted_question: 4, forward_fyi: 3,
  inbound_fresh: 5, outbound_fresh: 5, cc_only: 5, list_mail: 5, noise: 5, calendar_only: 4, self_thread: 3, outbound_fyi: 5,
  nudge_inbound_backfill: 6, followup_outbound_backfill: 4, url_question_fyi: 4,
  promise_pending: 4, promise_fulfilled: 4, promise_then_thanks: 4, promise_to_me: 3,
};

interface Person { name: string; address: string }

class Builder {
  readonly rng: Rng;
  #people = 0;
  #threads = 0;
  #messages = 0;
  constructor(seed: number) { this.rng = new Rng(seed); }

  person(): Person {
    const i = this.#people++;
    const first = FIRST[i % FIRST.length];
    const last = LAST[Math.floor(i / FIRST.length) % LAST.length];
    const domain = DOMAINS[i % DOMAINS.length];
    return { name: `${first} ${last}`, address: `${first.toLowerCase()}.${last.toLowerCase()}-${i}@${domain}` };
  }

  threadId(): string {
    const n = this.#threads++;
    return createHash('sha256').update(`n7-thread-${n}`).digest('hex').slice(0, 16);
  }

  msg(o: { from: Person | 'me'; to: Array<Person | 'me' | 'alias'>; cc?: Array<Person | 'me'>; subject: string; age: number; own: string; quoted?: string; asks: boolean; kind?: MessageKind; fromHeader?: string }): LedgerMessage {
    const addr = (p: Person | 'me' | 'alias') => p === 'me' ? ME : p === 'alias' ? ME_ALIAS : p.address;
    const mine = o.from === 'me';
    const fromAddr = mine ? ME : (o.from as Person).address;
    const fromHeader = o.fromHeader ?? (mine ? `Me Example <${ME}>` : `${(o.from as Person).name} <${fromAddr}>`);
    return {
      id: `m${String(this.#messages++).padStart(5, '0')}`,
      from: fromHeader,
      from_address: fromAddr.toLowerCase(),
      sent_by_me: mine,
      to: o.to.map(addr),
      cc: (o.cc ?? []).map(addr),
      subject: o.subject,
      age_hours: o.age,
      kind: o.kind ?? 'human',
      own_text: o.own,
      quoted: o.quoted ?? '',
      asks: o.asks,
    };
  }
}

const quoteOf = (author: string, text: string) => `On Mon, Sep 28, 2026 at 9:00 AM ${author} wrote:\n${text.split('\n').map(l => `> ${l}`).join('\n')}`;

function buildThread(b: Builder, klass: ThreadClass): LedgerThread {
  const r = b.rng;
  const them = b.person();
  const topic = r.pick(TOPICS);
  const item = r.pick(ITEMS);
  const subject = `Re: ${topic.replace(/^the /, '')}`;
  const ask = `Could you send me ${item} for ${topic}?`;
  const waiting = (v: boolean): SemanticLabels => ({ someone_waiting_on_me: v, promise: null });
  const id = b.threadId();
  const T = (messages: LedgerMessage[], semantic: SemanticLabels): LedgerThread => ({ id, klass, messages, semantic });
  switch (klass) {
    case 'inbound_owed':
      return T([b.msg({ from: them, to: ['me'], subject, age: r.int(25, 200), own: `Hi,\n\n${ask}\n\nThanks,\n${them.name}`, asks: true })], waiting(true));
    case 'inbound_alias':
      return T([b.msg({ from: them, to: ['alias'], subject, age: r.int(25, 200), own: `${ask}`, asks: true })], waiting(true));
    case 'inbound_multi_to': {
      const other = b.person();
      return T([b.msg({ from: them, to: [other, 'me'], subject, age: r.int(25, 200), own: `Both of you: ${ask}`, asks: true })], waiting(true));
    }
    case 'mixed_case_sender': {
      const header = `${them.name} <${them.address.toUpperCase()}>`;
      return T([b.msg({ from: them, to: ['me'], subject, age: r.int(25, 200), own: ask, asks: true, fromHeader: header })], waiting(true));
    }
    case 'outbound_question':
      return T([b.msg({ from: 'me', to: [them], subject, age: r.int(73, 240), own: `Hi ${them.name.split(' ')[0]},\n\nAny update on ${topic}?`, asks: true })], waiting(false));
    case 'outbound_multi_to': {
      const other = b.person();
      return T([b.msg({ from: 'me', to: [them, other], subject, age: r.int(73, 240), own: `Can one of you confirm ${topic}?`, asks: true })], waiting(false));
    }
    case 'outbound_answered_then_owed': {
      const other = b.person();
      const q = r.int(100, 200);
      return T([
        b.msg({ from: 'me', to: [them, other], subject, age: q, own: `Where are we on ${topic}?`, asks: true }),
        b.msg({ from: other, to: ['me'], cc: [them], subject, age: r.int(30, q - 10), own: `It slipped a week. Can you approve the new date?`, asks: true }),
      ], waiting(true));
    }
    case 'calendar_after_question': {
      const q = r.int(90, 200);
      return T([
        b.msg({ from: 'me', to: [them], subject, age: q, own: `Did you get a chance to review ${topic}?`, asks: true }),
        b.msg({ from: them, to: ['me'], subject: `Invitation: sync on ${topic.replace(/^the /, '')}`, age: r.int(2, 20), own: 'Invitation from Google Calendar', asks: false, kind: 'calendar' }),
      ], waiting(false));
    }
    case 'answered_by_me': {
      const a = r.int(40, 200);
      return T([
        b.msg({ from: them, to: ['me'], subject, age: a, own: ask, asks: true }),
        b.msg({ from: 'me', to: [them], subject, age: r.int(25, a - 5), own: `Here it is, attached: ${item}.`, quoted: quoteOf(them.name, ask), asks: false }),
      ], waiting(false));
    }
    case 'ack_thanks': {
      const a = r.int(40, 200);
      return T([
        b.msg({ from: them, to: ['me'], subject, age: a, own: ask, asks: true }),
        b.msg({ from: 'me', to: [them], subject, age: r.int(25, a - 5), own: r.pick(ACK_ONLY_REPLIES), quoted: quoteOf(them.name, ask), asks: false }),
      ], waiting(true));
    }
    case 'outbound_answered_fresh': {
      const q = r.int(80, 200);
      return T([
        b.msg({ from: 'me', to: [them], subject, age: q, own: `Is ${topic} still on track?`, asks: true }),
        b.msg({ from: them, to: ['me'], subject, age: r.int(1, 20), own: `Yes, all on track.`, quoted: quoteOf('Me Example', `Is ${topic} still on track?`), asks: false }),
      ], waiting(false));
    }
    case 'reply_with_quoted_question':
      return T([
        b.msg({ from: them, to: ['me'], subject, age: r.int(120, 200), own: ask, asks: true }),
        b.msg({ from: 'me', to: [them], subject, age: r.int(76, 110), own: 'Done, sent it over this morning.', quoted: quoteOf(them.name, ask), asks: false }),
      ], waiting(false));
    case 'forward_fyi': {
      const colleague = b.person();
      return T([b.msg({ from: 'me', to: [colleague], subject: `Fwd: ${topic.replace(/^the /, '')}`, age: r.int(80, 200), own: 'FYI, see below.', quoted: `---------- Forwarded message ---------\nFrom: ${them.name} <${them.address}>\n\n${ask}`, asks: false })], waiting(false));
    }
    case 'inbound_fresh':
      return T([b.msg({ from: them, to: ['me'], subject, age: r.int(1, 22), own: ask, asks: true })], waiting(true));
    case 'outbound_fresh':
      return T([b.msg({ from: 'me', to: [them], subject, age: r.int(1, 70), own: `Any thoughts on ${topic}?`, asks: true })], waiting(false));
    case 'cc_only': {
      const other = b.person();
      return T([b.msg({ from: them, to: [other], cc: ['me'], subject, age: r.int(30, 200), own: `${other.name.split(' ')[0]}, ${ask}`, asks: true })], waiting(false));
    }
    case 'list_mail':
      return T([b.msg({ from: them, to: ['me'], subject: `[newsletter] ${topic}`, age: r.int(30, 200), own: `This week: notes on ${topic}. Questions? Reply any time.`, asks: true, kind: 'list' })], waiting(false));
    case 'noise': {
      const sender = r.pick(['noreply', 'notifications', 'no-reply', 'mailer-daemon']);
      const domain = r.pick(DOMAINS);
      const bot = { name: 'Automated Example', address: `${sender}@${domain}` };
      return T([b.msg({ from: bot, to: ['me'], subject: `Your ${topic.replace(/^the /, '')} report`, age: r.int(30, 200), own: 'Did you know you can change your notification settings?', asks: true, kind: 'noise' })], waiting(false));
    }
    case 'calendar_only':
      return T([b.msg({ from: them, to: ['me'], subject: `Invitation: ${topic.replace(/^the /, '')} review`, age: r.int(30, 200), own: 'Join with Google Meet. Will you attend?', asks: true, kind: 'calendar' })], waiting(false));
    case 'self_thread':
      return T([b.msg({ from: 'me', to: ['alias'], subject: `note to self: ${topic.replace(/^the /, '')}`, age: r.int(80, 200), own: `Remember to check ${topic}?`, asks: true })], waiting(false));
    case 'outbound_fyi':
      return T([b.msg({ from: 'me', to: [them], subject, age: r.int(80, 200), own: `Sharing ${item} for ${topic}. No action needed.`, asks: false })], waiting(false));
    case 'nudge_inbound_backfill': {
      const a = r.int(30, 120);
      return T([
        b.msg({ from: them, to: ['me'], subject, age: a, own: ask, asks: true }),
        b.msg({ from: them, to: ['me'], subject, age: r.int(1, 20), own: 'Just bumping this up. Any news?', quoted: quoteOf(them.name, ask), asks: true }),
      ], waiting(true));
    }
    case 'followup_outbound_backfill': {
      const q = r.int(80, 200);
      return T([
        b.msg({ from: 'me', to: [them], subject, age: q, own: `Could you confirm ${topic}?`, asks: true }),
        b.msg({ from: 'me', to: [them], subject, age: r.int(2, 60), own: 'Following up on this. Any update?', quoted: quoteOf('Me Example', `Could you confirm ${topic}?`), asks: true }),
      ], waiting(false));
    }
    case 'url_question_fyi':
      return T([b.msg({ from: 'me', to: [them], subject, age: r.int(80, 200), own: `For reference, the notes are at https://docs.example.com/view?id=${r.int(100, 999)}. No reply needed.`, asks: false })], waiting(false));
    case 'promise_pending': {
      const due = r.pick(DUE_DATES);
      return T([
        b.msg({ from: them, to: ['me'], subject, age: r.int(60, 120), own: ask, asks: true }),
        b.msg({ from: 'me', to: [them], subject, age: r.int(26, 50), own: `Sure, I will send ${item} by ${WEEKDAY[due]}.`, quoted: quoteOf(them.name, ask), asks: false }),
      ], { someone_waiting_on_me: true, promise: { by: 'me', what: `send ${item}`, due, fulfilled: false } });
    }
    case 'promise_fulfilled': {
      const due = r.pick(DUE_DATES);
      return T([
        b.msg({ from: them, to: ['me'], subject, age: r.int(100, 160), own: ask, asks: true }),
        b.msg({ from: 'me', to: [them], subject, age: r.int(70, 95), own: `Sure, I will send ${item} by ${WEEKDAY[due]}.`, quoted: quoteOf(them.name, ask), asks: false }),
        b.msg({ from: 'me', to: [them], subject, age: r.int(26, 50), own: `As promised, here is ${item}.`, asks: false }),
      ], { someone_waiting_on_me: false, promise: { by: 'me', what: `send ${item}`, due, fulfilled: true } });
    }
    case 'promise_then_thanks': {
      const due = r.pick(DUE_DATES);
      return T([
        b.msg({ from: them, to: ['me'], subject, age: r.int(60, 120), own: ask, asks: true }),
        b.msg({ from: 'me', to: [them], subject, age: r.int(26, 50), own: `Thanks! Will get ${item} to you by ${WEEKDAY[due]}.`, quoted: quoteOf(them.name, ask), asks: false }),
      ], { someone_waiting_on_me: true, promise: { by: 'me', what: `send ${item}`, due, fulfilled: false } });
    }
    case 'promise_to_me': {
      const due = r.pick(DUE_DATES);
      return T([
        b.msg({ from: 'me', to: [them], subject, age: r.int(100, 160), own: `Where is ${item}?`, asks: true }),
        b.msg({ from: them, to: ['me'], subject, age: r.int(30, 60), own: `I will send ${item} by ${WEEKDAY[due]}.`, quoted: quoteOf('Me Example', `Where is ${item}?`), asks: false }),
      ], { someone_waiting_on_me: false, promise: { by: 'them', what: `send ${item}`, due, fulfilled: false } });
    }
  }
}

/** Independent implementation of the documented open-loop rules over ledger facts. */
export function mechanicsOracle(messages: readonly LedgerMessage[], myAddresses: readonly string[] = MY_ADDRESSES, rules: N7Rules = 'reply-closes'): MechanicsGold {
  const mine = new Set(myAddresses);
  let theirQuestionPending = false;
  const substantive = messages.filter(m => m.kind === 'human' || m.kind === 'list').filter(m => {
    if (rules === 'reply-closes') return true;
    if (!m.sent_by_me) { theirQuestionPending = m.asks; return true; }
    if (theirQuestionPending && ACK_ONLY_REPLIES.includes(m.own_text.trim())) return false;
    theirQuestionPending = false;
    return true;
  });
  if (!substantive.length) return { open: null, closes: null, closure_case: false };
  const stateOf = (ms: readonly LedgerMessage[]): MechanicsGold['open'] => {
    const last = ms[ms.length - 1];
    const participants = new Set<string>();
    for (const m of ms) { participants.add(m.from_address); for (const a of [...m.to, ...m.cc]) participants.add(a.toLowerCase()); }
    if ([...participants].every(p => mine.has(p))) return null;
    let i = ms.length - 1;
    while (i > 0 && ms[i - 1].sent_by_me === last.sent_by_me) i--;
    const run = ms.slice(i);
    if (!last.sent_by_me) {
      if (last.kind === 'list' || !last.to.some(a => mine.has(a.toLowerCase()))) return null;
      const firstOwed = run.find(m => m.kind === 'human' && m.to.some(a => mine.has(a.toLowerCase())));
      if (!firstOwed || firstOwed.age_hours < INBOUND_GRACE_H) return null;
      return { loop_type: 'unanswered_inbound', counterparty: last.from_address };
    }
    if (!last.asks) return null;
    const external = last.to.map(a => a.toLowerCase()).filter(a => !mine.has(a));
    if (!external.length) return null;
    const firstAsk = run.find(m => m.asks);
    if (!firstAsk || firstAsk.age_hours < OUTBOUND_GRACE_H) return null;
    return { loop_type: 'unanswered_outbound', counterparty: external[0] };
  };
  const open = stateOf(substantive);
  const last = substantive[substantive.length - 1];
  const closes: LoopType = last.sent_by_me ? 'unanswered_inbound' : 'unanswered_outbound';
  let closure_case = false;
  if (substantive.length > 1) {
    const before = substantive.slice(0, -1);
    const prior = before[before.length - 1];
    if (prior.sent_by_me !== last.sent_by_me) {
      const shifted = before.map(m => ({ ...m, age_hours: m.age_hours - last.age_hours }));
      const was = stateOf(shifted);
      closure_case = was?.loop_type === closes;
    }
  }
  return { open, closes, closure_case };
}

function buildScenarios(b: Builder): StoreScenario[] {
  const out: StoreScenario[] = [];
  const r = b.rng;
  const add = (kind: ScenarioKind, thread: LedgerThread, steps: ScenarioStep[]) => out.push({ id: `${kind}-${out.filter(s => s.kind === kind).length}`, kind, thread, steps });
  for (let k = 0; k < 4; k++) {
    const them = b.person();
    const subject = `Re: ${r.pick(TOPICS).replace(/^the /, '')}`;
    // Ages are relative to the final round; each apply step fixes how many
    // messages exist and how many hours before the final now it is judged.
    const inbound = (age: number) => b.msg({ from: them, to: ['me'], subject, age, own: 'Can you review the attached plan?', asks: true });
    add('reply_close', { id: b.threadId(), klass: 'answered_by_me', semantic: { someone_waiting_on_me: false, promise: null }, messages: [inbound(80), b.msg({ from: 'me', to: [them], subject, age: 10, own: 'Reviewed, two comments inline.', asks: false })] }, [
      { kind: 'apply', messages: 1, now_offset_hours: 40, expect: { status: 'open', loop_type: 'unanswered_inbound', counterparty: them.address } },
      { kind: 'apply', messages: 2, now_offset_hours: 0, expect: { status: 'done', loop_type: 'unanswered_inbound', closed_by: 'reply_detected' } },
    ]);
    const them2 = b.person();
    add('ack_close', { id: b.threadId(), klass: 'ack_thanks', semantic: { someone_waiting_on_me: true, promise: null }, messages: [b.msg({ from: them2, to: ['me'], subject, age: 80, own: 'Can you send the signed form?', asks: true }), b.msg({ from: 'me', to: [them2], subject, age: 10, own: 'Thanks!', asks: false })] }, [
      { kind: 'apply', messages: 1, now_offset_hours: 40, expect: { status: 'open', loop_type: 'unanswered_inbound', counterparty: them2.address } },
      { kind: 'apply', messages: 2, now_offset_hours: 0, expect: { status: 'done', loop_type: 'unanswered_inbound', closed_by: 'reply_detected' } },
    ]);
    const them3 = b.person();
    add('nudge_hold', { id: b.threadId(), klass: 'nudge_inbound_backfill', semantic: { someone_waiting_on_me: true, promise: null }, messages: [b.msg({ from: them3, to: ['me'], subject, age: 70, own: 'Could you approve the invoice?', asks: true }), b.msg({ from: them3, to: ['me'], subject, age: 2, own: 'Bumping this.', asks: true })] }, [
      { kind: 'apply', messages: 1, now_offset_hours: 30, expect: { status: 'open', loop_type: 'unanswered_inbound', counterparty: them3.address } },
      { kind: 'apply', messages: 2, now_offset_hours: 0, expect: { status: 'open', loop_type: 'unanswered_inbound', counterparty: them3.address } },
    ]);
    const them4 = b.person();
    add('calendar_hold', { id: b.threadId(), klass: 'calendar_after_question', semantic: { someone_waiting_on_me: false, promise: null }, messages: [b.msg({ from: 'me', to: [them4], subject, age: 150, own: 'Did legal sign off?', asks: true }), b.msg({ from: them4, to: ['me'], subject: 'Invitation: legal sync', age: 3, own: 'Invitation from Google Calendar', asks: false, kind: 'calendar' })] }, [
      { kind: 'apply', messages: 1, now_offset_hours: 40, expect: { status: 'open', loop_type: 'unanswered_outbound', counterparty: them4.address } },
      { kind: 'apply', messages: 2, now_offset_hours: 0, expect: { status: 'open', loop_type: 'unanswered_outbound', counterparty: them4.address } },
    ]);
    const them5 = b.person();
    add('manual_close', { id: b.threadId(), klass: 'inbound_owed', semantic: { someone_waiting_on_me: true, promise: null }, messages: [b.msg({ from: them5, to: ['me'], subject, age: 120, own: 'Can you share the agenda?', asks: true }), b.msg({ from: them5, to: ['me'], subject, age: 30, own: 'One more thing: can you add the budget item?', asks: true })] }, [
      { kind: 'apply', messages: 1, now_offset_hours: 60, expect: { status: 'open', loop_type: 'unanswered_inbound', counterparty: them5.address } },
      { kind: 'manual_close', loop_type: 'unanswered_inbound', status: 'done' },
      { kind: 'apply', messages: 1, now_offset_hours: 50, expect: { status: 'done', loop_type: 'unanswered_inbound', closed_by: 'manual' } },
      { kind: 'apply', messages: 2, now_offset_hours: 0, expect: { status: 'open', loop_type: 'unanswered_inbound', counterparty: them5.address } },
    ]);
    const them6 = b.person();
    const header = `${them6.name} <${them6.address.toUpperCase()}>`;
    add('mute_sender', { id: b.threadId(), klass: 'inbound_owed', semantic: { someone_waiting_on_me: true, promise: null }, messages: [b.msg({ from: them6, to: ['me'], subject, age: 90, own: 'Can you sponsor our event?', asks: true, fromHeader: header })] }, [
      { kind: 'mute', mute: 'sender', value: k % 2 ? them6.address.toUpperCase() : them6.address },
      { kind: 'apply', messages: 1, now_offset_hours: 0, expect: { status: 'absent', loop_type: 'unanswered_inbound' } },
    ]);
    const them7 = b.person();
    const muteThreadId = b.threadId();
    add('mute_thread', { id: muteThreadId, klass: 'inbound_owed', semantic: { someone_waiting_on_me: true, promise: null }, messages: [b.msg({ from: them7, to: ['me'], subject, age: 90, own: 'Can you join the panel?', asks: true })] }, [
      { kind: 'mute', mute: 'thread', value: muteThreadId },
      { kind: 'apply', messages: 1, now_offset_hours: 0, expect: { status: 'absent', loop_type: 'unanswered_inbound' } },
    ]);
    const them8 = b.person();
    add('turn_flip', { id: b.threadId(), klass: 'outbound_answered_then_owed', semantic: { someone_waiting_on_me: true, promise: null }, messages: [b.msg({ from: 'me', to: [them8], subject, age: 200, own: 'Can you confirm the venue?', asks: true }), b.msg({ from: them8, to: ['me'], subject, age: 30, own: 'Venue confirmed. Can you send the headcount?', asks: true })] }, [
      { kind: 'apply', messages: 1, now_offset_hours: 100, expect: { status: 'open', loop_type: 'unanswered_outbound', counterparty: them8.address } },
      { kind: 'apply', messages: 2, now_offset_hours: 0, expect: { status: 'done', loop_type: 'unanswered_outbound', closed_by: 'reply_detected' } },
      { kind: 'apply', messages: 2, now_offset_hours: 0, expect: { status: 'open', loop_type: 'unanswered_inbound', counterparty: them8.address } },
    ]);
  }
  return out;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function ledgerFingerprint(ledger: N7Ledger): string {
  return createHash('sha256').update(canonical(ledger)).digest('hex');
}

export function generateN7World(opts: { seed?: number; rules?: N7Rules } = {}): GeneratedN7 {
  const seed = opts.seed ?? N7_DEFAULT_SEED;
  const b = new Builder(seed);
  const threads: LedgerThread[] = [];
  for (const klass of Object.keys(CLASS_COUNTS) as ThreadClass[]) {
    for (let i = 0; i < CLASS_COUNTS[klass]; i++) threads.push(buildThread(b, klass));
  }
  const scenarios = buildScenarios(b);
  const ledger: N7Ledger = { generator_version: N7_GENERATOR_VERSION, seed, now: N7_NOW_ISO, my_addresses: [...MY_ADDRESSES], threads, scenarios };
  const gold = new Map<string, MechanicsGold>(threads.map(t => [t.id, mechanicsOracle(t.messages, MY_ADDRESSES, opts.rules ?? 'reply-closes')]));
  return { ledger, fingerprint: ledgerFingerprint(ledger), gold };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--seed');
  const seed = at >= 0 ? Number(argv[at + 1]) : N7_DEFAULT_SEED;
  const world = generateN7World({ seed });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ fingerprint: world.fingerprint, ledger: world.ledger }, null, 2) + '\n');
  else console.log(`${N7_GENERATOR_VERSION} seed=${seed} threads=${world.ledger.threads.length} scenarios=${world.ledger.scenarios.length} fingerprint=${world.fingerprint}`);
}
