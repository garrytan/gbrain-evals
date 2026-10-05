/**
 * The sealed generator's ledger: what is true about each customer, with the
 * documents that state it. Answer keys come from this ledger through
 * `eval/generators/hard/semantics.ts`; prose is rendered from it afterwards.
 */
import type { LadderDoc } from '../model-ladder-gen.ts';
import type { RefForm } from '../hard/schema.ts';
import type { ValueEvent } from '../hard/semantics.ts';
import type { Rng } from './rng.ts';
import { SECTOR, type TRADES } from './pools.ts';

/** The date "today" means in every sealed world. */
export const TODAY = '2026-09-18';
/** No customer opens before this date. */
export const EPOCH = '2025-06-02';

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function minDate(a: string, b: string): string { return a < b ? a : b; }
export function maxDate(a: string, b: string): string { return a > b ? a : b; }

export function randomDate(r: Rng, lo: string, hi: string): string {
  return addDays(lo, r.int(0, Math.max(0, daysBetween(lo, hi))));
}

/** `n` distinct sorted dates in [lo, hi]. */
export function distinctDates(r: Rng, n: number, lo: string, hi: string): string[] {
  const span = daysBetween(lo, hi);
  if (span + 1 < n) throw new Error(`cannot place ${n} dates between ${lo} and ${hi}`);
  const picked = new Set<number>();
  while (picked.size < n) picked.add(r.int(0, span));
  return [...picked].sort((x, y) => x - y).map(d => addDays(lo, d));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `4 March 2026` */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** `Wed, 4 Mar 2026` */
export function mailDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${DAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]}, ${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

export interface Ticket {
  key: string;
  summary: string;
  priority: string;
  reporter: string;
  opened: string;
  escalated?: string;
  closed?: string;
  doc: string;
}

/** One row of a customer's CRM change log. */
export interface ChangeRow {
  logged: string;
  field: string;
  was: string;
  now: string;
  effective: string;
  by: string;
  note?: string;
  /** The document that records the row: the change log, or (reference forms) its own change slip. */
  doc: string;
}

export interface CoItem {
  label: string;
  value: string;
  /** Set when the item corrects an earlier change order: that order's number. */
  corrects?: number;
}

/** A change order against the customer's order form: executed or an unsigned draft. */
export interface ChangeOrder {
  id: string;
  no: number;
  state: 'executed' | 'draft';
  /** Executed: signature date. Draft: the date it was circulated. */
  signed: string;
  effective: string;
  items: CoItem[];
  author: string;
  long?: boolean;
}

/** A backdated account-lead change, announced after it took effect. */
export interface Announcement {
  ev: ValueEvent;
  previous: string;
  channel: 'mail' | 'bulletin';
}

export interface Site { name: string; contact: string }

export interface Acct {
  id: string;
  code: string;
  /** Registered names in order; `from` is the date each became the name on file. */
  names: Array<{ name: string; from: string }>;
  opened: string;
  segment: string;
  region: string;
  domain: string;
  contacts: string[];
  owner: ValueEvent[];
  renewal: ValueEvent[];
  tickets: Ticket[];
  /** Order-form schedule: label → value. */
  form: Record<string, string>;
  /** The order-form label whose clause sits mid-document in a long rendering. */
  formLongLabel?: string;
  changes: ChangeRow[];
  cos: ChangeOrder[];
  announcements: Announcement[];
  /** Documents beyond the card, change log, order form, change orders and tickets: rendered ones, and ones rendered once the ledger is complete. */
  docs: LadderDoc[];
  pending: Array<() => LadderDoc>;
  /** Reference forms: the desk handle (a two-word nickname). */
  nickname?: string;
  /** Per-folder counters for document ids. */
  seq: Record<string, number>;
  /** An account folded into this one. */
  merged?: { name: string; code: string; on: string };
  /** For a merged-away account: the survivor's id. It is not an entity of its own. */
  ghostOf?: string;
  sites?: { doc: string; asOf: string; list: Site[] };
  kind: 'background' | 'task' | 'appended';
}

export function currentName(a: Acct): string { return a.names[a.names.length - 1].name; }

export function nameAt(a: Acct, date: string): string {
  let out = a.names[0].name;
  for (const n of a.names) if (n.from <= date) out = n.name;
  return out;
}

export function folder(a: Acct): string { return a.code.toLowerCase(); }

export function nextId(a: Acct, area: string, stem: string): string {
  a.seq[area] = (a.seq[area] ?? 0) + 1;
  return `${area}/${folder(a)}/${stem}-${String(a.seq[area]).padStart(2, '0')}`;
}

export const cardId = (a: Acct) => `registry/${folder(a)}/card`;
export const profileId = (a: Acct) => `registry/${folder(a)}/profile`;
export const changesId = (a: Acct) => `registry/${folder(a)}/changes`;
export const formId = (a: Acct) => `paper/${folder(a)}/order-form`;

/** Reference forms: territory and sector, e.g. `Delta haulage`. The sector comes from the first registered name's trade, so a rename keeps it. */
export function descriptorOf(a: Acct): string {
  const first = a.names[0].name;
  return `${a.region} ${SECTOR[first.slice(first.indexOf(' ') + 1) as typeof TRADES[number]]}`;
}

/**
 * How one document refers to one customer. `name` and `code` forms carry the
 * short-name in `code`; `mail` says whether customer mail addresses (whose
 * domain spells the name) may appear.
 */
export interface Who { form: RefForm; text: string; code?: string; mail: boolean }
