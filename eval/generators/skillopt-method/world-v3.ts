/**
 * world-v3: the seeded fictional brain for skillopt-method-v3 (GBEV-30, plan
 * section 2, decision N). About a thousand Markdown pages, written from
 * templates and the phrase banks in world-v3-banks.ts, with no model call, so
 * the world regenerates byte for byte from its knobs.
 *
 *   companies      90 (15 look-alike pairs: one stem, two suffixes), each with
 *                  one founder, a dated leadership history and a team; 16 are
 *                  acquired by 16 others; 8 are investor firms
 *   people         330 (20 look-alike pairs: half homonyms, half one-letter
 *                  surname variants), each with a dated career
 *   accounts       60 customers of the vendor, each with a contract chain of
 *                  chain_depth records: a master agreement, then amendments,
 *                  renewals signed ahead of their start, side letters and
 *                  rescissions that reinstate the value in force before
 *   meetings       150 (account reviews and meetings across the companies)
 *   notes          80 informal notes, some stating values the signed records
 *                  contradict
 *   announcements  every acquisition and chief-executive change
 *
 * Links are Markdown links to slugs, as in world-v1, which gbrain's import
 * turns into its link graph. Every page is 150 to 700 words: each is padded
 * from its bank's filler sentences to a seeded length of 170 to 300 words.
 *
 * The world model (orgs, people, contracts, mentions) is the generators' first
 * path to gold. The oracles in common-v3.ts never read it: they re-derive every
 * gold value from the rendered page text.
 *
 * The calibration knobs are one object (V3Knobs) with its own seed; the plan's
 * calibration round changes them and regenerates.
 */
import { Rng } from '../seeded.ts';
import {
  ACCOUNT_BUSINESS, ACCOUNT_FILLER, ACCOUNT_SUFFIXES, ANNOUNCEMENT_FILLER, CITIES, COMPANY_FILLER, COMPANY_KINDS, CONTACT_TITLES, CONTRACT_FILLER, EARLY_WORK,
  FIELDS, FIRST_NAMES, HOBBIES, INVESTOR_SUFFIXES, MEETING_FILLER, NEAR_SURNAME_PAIRS, NOTE_FILLER, PERSON_FILLER, SCHOOLS, STEM_HEADS, STEM_TAILS, SURNAMES,
  TEAM_TITLES, VENDOR_TITLES,
} from './world-v3-banks.ts';

// ─── Knobs and sizes ─────────────────────────────────────────────────────────

/** The calibration knobs (plan section 4): change them and regenerate. */
export interface V3Knobs {
  /** Seed of the world generator. */
  seed: number;
  /** Records per account contract chain, the master agreement included. */
  chain_depth: { min: number; max: number };
  /** Look-alike pairs: companies (one stem, two suffixes) and people (half homonyms, half near-name surnames). */
  lookalike_pairs: { companies: number; people: number };
  /** Wrong-value mentions per account, alternating between informal notes (a claim the record contradicts) and meeting notes (an unsigned proposal). */
  distractor_count: number;
}

export const DEFAULT_V3_KNOBS: Readonly<V3Knobs> = { seed: 30_001, chain_depth: { min: 4, max: 5 }, lookalike_pairs: { companies: 20, people: 24 }, distractor_count: 6 };

export const WORLD_SIZE = { companies: 90, investors: 8, people: 330, accounts: 60, meetings: 150, notes: 80, vendor_staff: 12, acquisitions: 16 } as const;
/** The world's present: every page is dated on or before it, and "current" means as of it. */
export const WORLD_NOW = '2026-10-30';
export const PAGE_WORDS = { min: 150, max: 700 } as const;

export const VENDOR = { name: 'Lanterncrest Software', slug: 'companies/lanterncrest-software', product: 'Lanterncrest Yard' } as const;

// ─── Dates ───────────────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const parts = (d: string) => d.split('-').map(Number) as [number, number, number];
export function addDays(d: string, n: number): string { const [y, m, dd] = parts(d); return iso(y, m, dd + n); }
/** The first day of the month `n` months after the month of `d`. */
export function monthStart(d: string, n = 0): string { const [y, m] = parts(d); return iso(y, m + n, 1); }
/** The last day of the month `n` months after the month of `d`. */
export function monthEnd(d: string, n = 0): string { const [y, m] = parts(d); return iso(y, m + n + 1, 0); }
/** 2026-03-31 → March 31, 2026 */
export function longDate(d: string): string { const [y, m, dd] = parts(d); return `${MONTHS[m - 1]} ${dd}, ${y}`; }
/** 2026-03-01 → March 2026 */
export function monthYear(d: string): string { const [y, m] = parts(d); return `${MONTHS[m - 1]} ${y}`; }
export const year = (d: string) => d.slice(0, 4);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const dateIn = (rng: Rng, from: string, to: string) => addDays(from, rng.int(0, Math.max(0, daysBetween(from, to))));
/** A weekday: `d` itself, else the Friday before. */
export function weekdayOn(d: string): string { const day = new Date(`${d}T12:00:00Z`).getUTCDay(); return day === 0 ? addDays(d, -2) : day === 6 ? addDays(d, -1) : d; }

// ─── Model ───────────────────────────────────────────────────────────────────

export type Role = 'founder' | 'ceo' | 'cto' | 'cfo' | 'team' | 'contact' | 'vendor' | 'partner';
export interface Stint { org: string; title: string; start: string; end: string | null; role: Role }
export interface Person { slug: string; name: string; first: string; last: string; city: string; stints: Stint[]; lookalike?: { slug: string; kind: 'homonym' | 'near' } }
export interface Tenure { person: string; start: string; end: string | null }
export type OrgKind = 'company' | 'investor' | 'account' | 'vendor';
export interface Org {
  slug: string; name: string; kind: OrgKind; stem: string; suffix: string; industry: string; city: string;
  founded: string | null; founder: string | null;
  ceo: Tenure[]; cto: Tenure[]; cfo: Tenure[];
  acquiredBy: { org: string; date: string } | null;
  acquired: Array<{ org: string; date: string }>;
  investors: Array<{ org: string; year: string }>;
  portfolio: Array<{ org: string; year: string }>;
  owner: string | null;
  lookalike: string | null;
  product: string; customer: string;
}

export const ATTR_IDS = ['seats', 'price', 'discount', 'renewal_date', 'notice', 'payment', 'tier'] as const;
export type AttrId = typeof ATTR_IDS[number];
export type AttrValue = number | string;

export interface AttrSpec {
  /** The row label in a contract's terms table. */
  label: string;
  /** How a question or claim names it. */
  phrase: string;
  /** How a contract table writes a value. */
  cell(v: AttrValue): string;
  /** How a claim or a note states a value. */
  say(v: AttrValue): string;
}

const thousands = (n: number) => n.toLocaleString('en-US');
export const ATTRS: Readonly<Record<AttrId, AttrSpec>> = {
  seats: { label: 'Subscribed seats', phrase: 'subscribed seat count', cell: v => String(v), say: v => `${v} seats` },
  price: { label: 'List price per seat per year', phrase: 'list price per seat per year', cell: v => `USD ${thousands(Number(v))}`, say: v => `$${thousands(Number(v))} per seat per year` },
  discount: { label: 'Discount', phrase: 'percentage discount', cell: v => `${v}%`, say: v => `a ${v}% discount` },
  renewal_date: { label: 'Renewal date (end of the current term)', phrase: 'renewal date (the last day of the current term)', cell: v => longDate(String(v)), say: v => `a renewal date of ${longDate(String(v))}` },
  notice: { label: 'Non-renewal notice period', phrase: 'non-renewal notice period', cell: v => `${v} days`, say: v => `${v} days' non-renewal notice` },
  payment: { label: 'Payment terms', phrase: 'payment term (days until an invoice is due)', cell: v => `net ${v}`, say: v => `payment terms of net ${v}` },
  tier: { label: 'Support tier', phrase: 'support tier', cell: v => String(v), say: v => `${v} support` },
};

const VALUE_RANGES = {
  seats: () => [...Array(149).keys()].map(i => 130 + 5 * i),
  price: () => [...Array(31).keys()].map(i => 1100 + 25 * i),
  discount: () => [5, 8, 10, 12, 15, 18, 20, 22, 25],
  notice: () => [60, 90, 120],
  payment: () => [15, 30, 45],
  tier: () => ['Tier 1', 'Tier 2', 'Tier 3'],
} as const;

export type ContractKind = 'msa' | 'amendment' | 'renewal' | 'side-letter' | 'rescission';
export interface Contract {
  slug: string; account: string; kind: ContractKind; ordinal: number; title: string;
  signed: string; effective: string;
  /** The terms this record sets from its effective date. */
  sets: Partial<Record<AttrId, AttrValue>>;
  /** The values in force just before its effective date, for the terms it sets. */
  before: Partial<Record<AttrId, AttrValue>>;
  rescinds: string | null;
  termStart: string | null; termEnd: string | null;
  preparedBy: string;
}

/** A value stated on a page other than the record: right or wrong on the page's date. */
export interface Mention { page: string; date: string; account: string; attr: AttrId; value: AttrValue; kind: 'note-claim' | 'meeting-proposal' | 'meeting-status' | 'snapshot'; correct: boolean; by: string | null }
export interface Meeting { slug: string; date: string; title: string; kind: string; attendees: string[]; account: string | null; company: string | null }
export interface Note { slug: string; date: string; title: string; author: string; mentions: Mention[]; rumor: { person: string; org: string } | null }
export interface Announcement { slug: string; date: string; title: string; kind: 'acquisition' | 'leadership'; org: string; other: string; outgoing: string | null }

export interface WorldV3 {
  knobs: V3Knobs;
  orgs: Map<string, Org>;
  people: Map<string, Person>;
  contracts: Map<string, Contract>;
  /** Account slug to its records in chain order. */
  chains: Map<string, Contract[]>;
  meetings: Meeting[];
  notes: Note[];
  announcements: Announcement[];
  mentions: Mention[];
  /** Slug to rendered Markdown, in slug order. */
  pages: Map<string, string>;
  lookalikes: { companies: Array<[string, string]>; homonyms: Array<[string, string]>; near: Array<[string, string]> };
}

// ─── Facts the model answers (the generators' first path) ────────────────────

/** The value of `attr` in force on `date`: the last record by effective date that sets it among those in force, a rescinded record dropping out from its rescission's effective date. */
export function valueAt(chain: readonly Contract[], attr: AttrId, date: string): { value: AttrValue; record: Contract } | null {
  const rescinded = new Map(chain.filter(c => c.rescinds && c.effective <= date).map(c => [c.rescinds!, c]));
  let best: Contract | null = null;
  for (const c of chain) {
    if (c.effective > date || rescinded.has(c.slug) || !(attr in c.sets)) continue;
    if (!best || c.effective > best.effective || (c.effective === best.effective && c.signed > best.signed)) best = c;
  }
  return best ? { value: best.sets[attr]!, record: best } : null;
}

/** The last day an account's chain covers: the end of its latest term. Nothing about the account is asked after it. */
export const chainEnd = (chain: readonly Contract[]): string => chain.reduce((m, c) => (c.termEnd && c.termEnd > m ? c.termEnd : m), '0000-00-00');

/** The person's primary stint on `date` (every stint is primary; none overlap). */
export const stintAt = (p: Person, date: string): Stint | null => p.stints.find(s => s.start <= date && (s.end === null || date <= s.end)) ?? null;
export const currentStint = (p: Person) => stintAt(p, WORLD_NOW);
export const tenureAt = (ts: readonly Tenure[], date: string) => ts.find(t => t.start <= date && (t.end === null || date <= t.end)) ?? null;

// ─── Names ───────────────────────────────────────────────────────────────────

export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function stems(rng: Rng): string[] {
  const people = [...FIRST_NAMES, ...SURNAMES, ...NEAR_SURNAME_PAIRS.flat()].map(x => x.toLowerCase());
  const all = STEM_HEADS.flatMap(h => STEM_TAILS.map(t => h + t)).filter(s => s.length >= 6 && s.length <= 10);
  const ok = all.filter(s => !people.some(p => p.length >= 4 && (s.toLowerCase().includes(p) || p.includes(s.toLowerCase()))));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of rng.shuffle(ok)) {
    const head = s.slice(0, 4).toLowerCase();
    if (seen.has(head)) continue;
    seen.add(head);
    out.push(s);
  }
  return out;
}

// ─── Generation ──────────────────────────────────────────────────────────────

interface Slot { org: string; role: Role; title: string; start: string; end: string | null; current: boolean; pinned?: string }

export function generateWorldV3(knobs: V3Knobs = DEFAULT_V3_KNOBS): WorldV3 {
  if (knobs.chain_depth.min < 2 || knobs.chain_depth.max < knobs.chain_depth.min || knobs.chain_depth.max > 6) throw new Error('world-v3: chain_depth must satisfy 2 <= min <= max <= 6');
  if (knobs.lookalike_pairs.companies > 20 || knobs.lookalike_pairs.people > 2 * NEAR_SURNAME_PAIRS.length) throw new Error('world-v3: too many look-alike pairs for the banks');
  const rng = new Rng(knobs.seed);
  const stemPool = stems(rng);
  const takeStem = () => { const s = stemPool.shift(); if (!s) throw new Error('world-v3: ran out of stems'); return s; };
  const cities = (n: number) => CITIES[n % CITIES.length]!;

  // Orgs.
  const orgs = new Map<string, Org>();
  const newOrg = (name: string, kind: OrgKind, stem: string, suffix: string, industry: string, product = '', customer = ''): Org => {
    const o: Org = { slug: kind === 'account' ? `accounts/${slugify(name)}` : kind === 'vendor' ? VENDOR.slug : `companies/${slugify(name)}`, name, kind, stem, suffix, industry, city: rng.pick(CITIES),
      founded: null, founder: null, ceo: [], cto: [], cfo: [], acquiredBy: null, acquired: [], investors: [], portfolio: [], owner: null, lookalike: null, product, customer };
    if (orgs.has(o.slug)) throw new Error(`world-v3: duplicate org slug ${o.slug}`);
    orgs.set(o.slug, o);
    return o;
  };
  newOrg(VENDOR.name, 'vendor', 'Lanterncrest', 'Software', 'logistics software', 'dock and yard scheduling', 'warehouses and distribution sites');
  const lookCompanies: Array<[string, string]> = [];
  const companyCount = WORLD_SIZE.companies - WORLD_SIZE.investors;
  const kinds = () => rng.pick(COMPANY_KINDS);
  for (let i = 0; i < knobs.lookalike_pairs.companies; i++) {
    const stem = takeStem();
    const [a, b] = rng.shuffle(COMPANY_KINDS).slice(0, 2);
    const oa = newOrg(`${stem} ${a!.suffix}`, 'company', stem, a!.suffix, a!.industry, rng.pick(a!.products), rng.pick(a!.customers));
    const ob = newOrg(`${stem} ${b!.suffix}`, 'company', stem, b!.suffix, b!.industry, rng.pick(b!.products), rng.pick(b!.customers));
    oa.lookalike = ob.slug; ob.lookalike = oa.slug;
    lookCompanies.push([oa.slug, ob.slug]);
  }
  while ([...orgs.values()].filter(o => o.kind === 'company').length < companyCount) {
    const k = kinds();
    newOrg(`${takeStem()} ${k.suffix}`, 'company', '', k.suffix, k.industry, rng.pick(k.products), rng.pick(k.customers));
  }
  for (const o of orgs.values()) if (!o.stem) o.stem = o.name.split(' ')[0]!;
  for (let i = 0; i < WORLD_SIZE.investors; i++) {
    const stem = takeStem();
    const suffix = INVESTOR_SUFFIXES[i % 2]!;
    newOrg(`${stem} ${suffix}`, 'investor', stem, suffix, 'venture capital', 'early-stage investments', 'founders in operations software');
  }
  const accountSuffixes = rng.shuffle([...ACCOUNT_SUFFIXES, ...ACCOUNT_SUFFIXES, ...ACCOUNT_SUFFIXES]);
  for (let i = 0; i < WORLD_SIZE.accounts; i++) {
    const stem = takeStem();
    const suffix = accountSuffixes[i]!;
    newOrg(`${stem} ${suffix}`, 'account', stem, suffix, ACCOUNT_BUSINESS[suffix]!, '', '');
  }
  const reservedStems = stemPool.slice(0, 60);

  const companies = [...orgs.values()].filter(o => o.kind === 'company');
  const investors = [...orgs.values()].filter(o => o.kind === 'investor');
  const accounts = [...orgs.values()].filter(o => o.kind === 'account');
  const vendor = orgs.get(VENDOR.slug)!;

  // People names.
  const homonymPairs = Math.floor(knobs.lookalike_pairs.people / 2);
  const nearPairs = knobs.lookalike_pairs.people - homonymPairs;
  const nearSurnames = new Set(NEAR_SURNAME_PAIRS.flat());
  const firsts = rng.shuffle(FIRST_NAMES);
  const lasts = rng.shuffle(SURNAMES.filter(s => !nearSurnames.has(s)));
  const names: Array<{ first: string; last: string; pair?: { kind: 'homonym' | 'near'; index: number; side: 0 | 1 } }> = [];
  const used = new Set<string>();
  let fi = 0, li = 0;
  for (let j = 0; j < nearPairs; j++) {
    const first = firsts[fi++ % firsts.length]!;
    const [s1, s2] = NEAR_SURNAME_PAIRS[j]!;
    names.push({ first, last: s1, pair: { kind: 'near', index: j, side: 0 } }, { first, last: s2, pair: { kind: 'near', index: j, side: 1 } });
    used.add(`${first} ${s1}`); used.add(`${first} ${s2}`);
  }
  for (let j = 0; j < homonymPairs; j++) {
    const first = firsts[fi++ % firsts.length]!;
    const last = lasts[li++ % lasts.length]!;
    names.push({ first, last, pair: { kind: 'homonym', index: j, side: 0 } }, { first, last, pair: { kind: 'homonym', index: j, side: 1 } });
    used.add(`${first} ${last}`);
  }
  const pairFirsts = new Set(names.map(n => n.first));
  while (names.length < WORLD_SIZE.people) {
    const first = firsts[fi++ % firsts.length]!;
    const last = lasts[li++ % lasts.length]!;
    if (pairFirsts.has(first) && names.some(n => n.pair && n.first === first)) continue;
    if (used.has(`${first} ${last}`)) continue;
    used.add(`${first} ${last}`);
    names.push({ first, last });
  }
  const numbers = rng.shuffle([...Array(900).keys()].map(i => i + 100).filter(n => n % 5 !== 0));
  const people = new Map<string, Person>();
  const pairMembers = new Map<string, string[]>();
  names.forEach((n, i) => {
    const slug = `people/${slugify(n.first)}-${slugify(n.last)}-${numbers[i]}`;
    people.set(slug, { slug, name: `${n.first} ${n.last}`, first: n.first, last: n.last, city: rng.pick(CITIES), stints: [] });
    if (n.pair) pairMembers.set(`${n.pair.kind}:${n.pair.index}`, [...(pairMembers.get(`${n.pair.kind}:${n.pair.index}`) ?? []), slug]);
  });
  const lookHomonyms: Array<[string, string]> = [];
  const lookNear: Array<[string, string]> = [];
  for (const [key, [a, b]] of pairMembers) {
    const kind = key.startsWith('near') ? 'near' as const : 'homonym' as const;
    people.get(a!)!.lookalike = { slug: b!, kind };
    people.get(b!)!.lookalike = { slug: a!, kind };
    (kind === 'near' ? lookNear : lookHomonyms).push([a!, b!]);
  }

  // Structure: founding dates, leadership tenures and slots.
  const slots: Slot[] = [];
  for (const s of VENDOR_TITLES.flatMap(t => [t, t]).slice(0, WORLD_SIZE.vendor_staff)) slots.push({ org: vendor.slug, role: 'vendor', title: s, start: monthStart(dateIn(rng, '2017-01-01', '2023-06-30')), end: null, current: true });
  vendor.founded = '2014-03-01';
  for (const c of [...companies, ...investors]) {
    c.founded = monthStart(dateIn(rng, c.kind === 'investor' ? '2008-01-01' : '2011-01-01', '2021-06-30'));
    slots.push({ org: c.slug, role: 'founder', title: c.kind === 'investor' ? 'founding partner' : 'founder and chief executive', start: c.founded, end: null, current: true });
    if (c.kind === 'investor') continue;
    const ceoChange = rng.float() < 0.42;
    c.ceo.push({ person: '', start: c.founded, end: null });
    if (ceoChange) {
      const t1 = monthStart(dateIn(rng, addDays(c.founded, 3 * 365), '2025-10-31'));
      if (t1 > c.founded && t1 < '2026-01-01') {
        c.ceo[0]!.end = addDays(t1, -1);
        c.ceo.push({ person: '', start: t1, end: null });
        if (rng.float() < 0.3 && t1 < '2024-06-01') {
          const t2 = monthStart(dateIn(rng, addDays(t1, 540), '2026-07-31'));
          c.ceo[1]!.end = addDays(t2, -1);
          c.ceo.push({ person: '', start: t2, end: null });
        }
      }
    }
    if (rng.float() < 0.4) {
      const s = monthStart(addDays(c.founded, rng.int(180, 540)));
      c.cto.push({ person: '', start: s, end: null });
      if (rng.float() < 0.3) {
        const t = monthStart(dateIn(rng, addDays(s, 730), '2026-03-31'));
        if (t > s) { c.cto[0]!.end = addDays(t, -1); c.cto.push({ person: '', start: t, end: null }); }
      }
    }
    if (rng.float() < 0.22) c.cfo.push({ person: '', start: monthStart(dateIn(rng, addDays(c.founded, 730), '2025-06-30')), end: null });
    for (const [role, ts, title] of [['ceo', c.ceo.slice(1), 'chief executive'], ['cto', c.cto, 'chief technology officer'], ['cfo', c.cfo, 'chief financial officer']] as const) {
      for (const t of ts) slots.push({ org: c.slug, role, title, start: t.start, end: t.end, current: t.end === null });
    }
    const team = rng.int(0, 2);
    for (let k = 0; k < team; k++) {
      const start = monthStart(dateIn(rng, addDays(c.founded, 180), '2026-04-30'));
      const former = rng.float() < 0.3 && start < '2024-06-01';
      slots.push({ org: c.slug, role: 'team', title: rng.pick(TEAM_TITLES), start, end: former ? monthEnd(dateIn(rng, addDays(start, 365), '2025-12-31')) : null, current: !former });
    }
  }
  for (const a of accounts) {
    a.founded = null;
    const start = monthStart(dateIn(rng, '2018-01-01', '2025-09-30'));
    slots.push({ org: a.slug, role: 'contact', title: rng.pick(CONTACT_TITLES), start, end: null, current: true });
    if (rng.float() < 0.3) slots.push({ org: a.slug, role: 'contact', title: rng.pick(CONTACT_TITLES), start: monthStart(dateIn(rng, '2019-01-01', '2026-03-31')), end: null, current: true });
    if (rng.float() < 0.35) {
      const s = monthStart(dateIn(rng, '2017-01-01', '2022-12-31'));
      slots.push({ org: a.slug, role: 'contact', title: rng.pick(CONTACT_TITLES), start: s, end: monthEnd(dateIn(rng, addDays(s, 365), '2025-08-31')), current: false });
    }
  }

  // Look-alike people take designated slots: near pairs (founder and contact or team), homonyms (team and contact at two orgs).
  const current = slots.filter(s => s.current);
  const freeOf = (pred: (s: Slot) => boolean) => rng.shuffle(current.filter(s => !s.pinned && pred(s)));
  const pinTo = (person: string, pred: (s: Slot) => boolean, avoidOrg?: string) => {
    const s = freeOf(x => pred(x) && x.org !== avoidOrg)[0];
    if (!s) throw new Error('world-v3: no slot left for a look-alike person');
    s.pinned = person;
    return s;
  };
  lookNear.forEach(([a, b], j) => {
    const sa = j < Math.ceil(nearPairs * 0.6) ? pinTo(a, s => s.role === 'founder' && orgs.get(s.org)!.kind === 'company') : pinTo(a, s => s.role === 'team');
    pinTo(b, s => s.role === 'contact' || s.role === 'team', sa.org);
  });
  for (const [a, b] of lookHomonyms) {
    const sa = pinTo(a, s => s.role === 'team' || s.role === 'ceo' || s.role === 'cto');
    pinTo(b, s => s.role === 'contact', sa.org);
  }

  // Everyone else fills the remaining current slots; extra people join a company team, extra slots are dropped.
  const pinned = new Set(current.filter(s => s.pinned).map(s => s.pinned!));
  const pool = rng.shuffle([...people.keys()].filter(p => !pinned.has(p)));
  const open = current.filter(s => !s.pinned);
  const priority = (s: Slot) => (['vendor', 'founder', 'ceo', 'cto', 'cfo', 'contact', 'team'] as Role[]).indexOf(s.role);
  open.sort((x, y) => priority(x) - priority(y));
  for (const s of open) { const p = pool.shift(); if (p) s.pinned = p; }
  const dropped = new Set(open.filter(s => !s.pinned));
  while (pool.length) {
    const c = rng.pick(companies);
    const start = monthStart(dateIn(rng, addDays(c.founded!, 180), '2026-04-30'));
    slots.push({ org: c.slug, role: 'team', title: rng.pick(TEAM_TITLES), start, end: null, current: true, pinned: pool.shift()! });
  }
  for (const s of slots) if (s.current && s.pinned) people.get(s.pinned)!.stints.push({ org: s.org, title: s.title, start: s.start, end: null, role: s.role });

  // Former slots go to people whose own career starts after the slot ends, at another org; a former CEO moved on, so a successor's predecessor is a real person with a later job.
  const careerStart = (p: Person) => p.stints.reduce((m, s) => (s.start < m ? s.start : m), '9999-12-31');
  for (const s of slots.filter(x => !x.current && !dropped.has(x))) {
    const candidates = rng.shuffle([...people.values()].filter(p => p.stints.length && !p.lookalike && careerStart(p) > addDays(s.end!, 20) && p.stints.every(x => x.org !== s.org) && p.stints.every(x => x.role !== 'vendor')));
    const p = candidates.find(x => x.stints.length === 1) ?? candidates[0];
    if (!p) { dropped.add(s); continue; }
    s.pinned = p.slug;
    p.stints.push({ org: s.org, title: s.title, start: s.start, end: s.end, role: s.role });
  }
  // Earlier jobs for a share of the rest (job changers): a team or contact role elsewhere, ending the month before the current one starts.
  for (const p of rng.shuffle([...people.values()])) {
    if (p.lookalike || p.stints.length !== 1 || rng.float() > 0.3) continue;
    const cur = p.stints[0]!;
    if (cur.role === 'vendor' || cur.start < '2019-06-01') continue;
    const end = addDays(cur.start, -1);
    const start = monthStart(addDays(end, -rng.int(500, 1500)));
    const other = rng.pick([...companies, ...accounts].filter(o => o.slug !== cur.org && (!o.founded || o.founded <= start)));
    const role: Role = other.kind === 'account' ? 'contact' : 'team';
    const title = role === 'contact' ? rng.pick(CONTACT_TITLES) : rng.pick(TEAM_TITLES);
    p.stints.push({ org: other.slug, title, start, end, role });
    slots.push({ org: other.slug, role, title, start, end, current: false, pinned: p.slug });
  }
  for (const p of people.values()) p.stints.sort((a, b) => a.start.localeCompare(b.start));

  // Leadership tenures and founders from the filled slots.
  for (const s of slots) {
    if (!s.pinned || dropped.has(s)) continue;
    const o = orgs.get(s.org)!;
    if (s.role === 'founder') {
      o.founder = s.pinned;
      if (o.kind === 'company') o.ceo[0]!.person = s.pinned;
    }
    if (s.role === 'ceo') o.ceo.find(t => t.start === s.start)!.person = s.pinned;
    if (s.role === 'cto') o.cto.find(t => t.start === s.start)!.person = s.pinned;
    if (s.role === 'cfo') o.cfo.find(t => t.start === s.start)!.person = s.pinned;
  }
  for (const o of orgs.values()) {
    for (const k of ['ceo', 'cto', 'cfo'] as const) {
      o[k] = o[k].filter(t => t.person);
      if (o[k].length) o[k][o[k].length - 1]!.end = o[k].every((t, i, ts) => i === 0 || ts[i - 1]!.end) ? o[k][o[k].length - 1]!.end : null;
    }
  }
  // A founder who handed over the chief executive role stays on as executive chair: split the founder's stint at the handover.
  for (const c of companies) {
    if (c.ceo.length < 2 || c.ceo[0]!.person !== c.founder) continue;
    const f = people.get(c.founder!)!;
    const st = f.stints.find(s => s.org === c.slug && s.role === 'founder')!;
    const handover = c.ceo[1]!.start;
    f.stints.push({ org: c.slug, title: 'founder and executive chair', start: handover, end: null, role: 'founder' });
    st.end = addDays(handover, -1);
    f.stints.sort((a, b) => a.start.localeCompare(b.start));
  }

  // Acquisitions: distinct targets and acquirers among operating companies.
  const operating = rng.shuffle(companies);
  const targets = operating.filter(c => c.founded! <= '2020-12-31').slice(0, WORLD_SIZE.acquisitions);
  const acquirers = operating.filter(c => !targets.includes(c));
  for (const t of targets) {
    const date = monthStart(dateIn(rng, addDays(t.founded!, 3 * 365) > '2021-03-01' ? addDays(t.founded!, 3 * 365) : '2021-03-01', '2026-06-30'));
    const a = acquirers.find(x => x.founded! < addDays(date, -365) && !x.acquired.length && !x.acquiredBy);
    if (!a) continue;
    t.acquiredBy = { org: a.slug, date };
    a.acquired.push({ org: t.slug, date });
  }
  // Investments: each firm backs a handful of companies founded before the round.
  for (const inv of investors) {
    for (const c of rng.shuffle(companies).slice(0, rng.int(3, 6))) {
      const y = String(Math.max(Number(year(c.founded!)) + rng.int(0, 2), Number(year(inv.founded!)) + 1));
      if (y > '2026') continue;
      c.investors.push({ org: inv.slug, year: y });
      inv.portfolio.push({ org: c.slug, year: y });
    }
  }
  const vendorStaff = [...people.values()].filter(p => p.stints.some(s => s.role === 'vendor'));
  for (const a of accounts) a.owner = rng.pick(vendorStaff).slug;

  // Contract chains.
  const contracts = new Map<string, Contract>();
  const chains = new Map<string, Contract[]>();
  for (const a of accounts) {
    const chain = makeChain(rng, a, knobs, vendorStaff.map(p => p.slug));
    chains.set(a.slug, chain);
    for (const c of chain) contracts.set(c.slug, c);
  }

  // Meetings, notes, mentions and announcements.
  const mentions: Mention[] = [];
  const meetings: Meeting[] = [];
  const notes: Note[] = [];
  const contactsAt = (org: string, date: string) => [...people.values()].filter(p => { const s = stintAt(p, date); return s && s.org === org; });
  const chainSpan = (a: Org) => { const ch = chains.get(a.slug)!; const end = chainEnd(ch); return { from: addDays(ch[0]!.effective, 20), to: end < addDays(WORLD_NOW, -5) ? end : addDays(WORLD_NOW, -5) }; };
  const wrongValue = (a: Org, attr: AttrId, date: string): AttrValue => {
    const chain = chains.get(a.slug)!;
    const now = valueAt(chain, attr, date)!.value;
    const others = [...new Set(chain.flatMap(c => (attr in c.sets ? [c.sets[attr]!] : [])))].filter(v => String(v) !== String(now));
    if (others.length && rng.float() < 0.7) return rng.pick(others);
    if (attr === 'renewal_date') return monthEnd(String(now), rng.pick([3, -3, 12]));
    const range = (VALUE_RANGES as Record<string, () => readonly AttrValue[]>)[attr]!().filter(v => String(v) !== String(now) && !others.includes(v));
    const near = typeof now === 'number' ? [...range].sort((x, y) => Math.abs(Number(x) - now) - Math.abs(Number(y) - now)).slice(0, 4) : range;
    return rng.pick(near);
  };
  const askable: AttrId[] = ['seats', 'price', 'discount', 'renewal_date', 'notice', 'payment', 'tier'];

  // Account meetings: one or two per account, each stating one value in force that day, some carrying an unsigned proposal.
  const accountMeetingKinds = ['Quarterly review', 'Renewal planning call', 'Pricing review', 'Account check-in'];
  const accountMeetings: Meeting[] = [];
  for (const a of accounts) {
    const n = 1 + (rng.float() < 0.25 ? 1 : 0);
    const span = chainSpan(a);
    for (let k = 0; k < n; k++) {
      const date = weekdayOn(dateIn(rng, span.from, span.to));
      const kind = rng.pick(accountMeetingKinds);
      const attendees = [...contactsAt(a.slug, date).map(p => p.slug).slice(0, 2), a.owner!];
      const m: Meeting = { slug: `meetings/${slugify(a.name)}-${slugify(kind)}-${k + 1}`, date, title: `${kind}: ${a.name}`, kind, attendees, account: a.slug, company: null };
      accountMeetings.push(m);
      const attr = rng.pick(askable);
      mentions.push({ page: m.slug, date, account: a.slug, attr, value: valueAt(chains.get(a.slug)!, attr, date)!.value, kind: 'meeting-status', correct: true, by: null });
    }
  }
  meetings.push(...accountMeetings);

  // Distractor mentions: even ones in informal notes (a claim), odd ones in meetings (an unsigned proposal).
  const noteDates = [...Array(WORLD_SIZE.notes).keys()].map(() => weekdayOn(dateIn(rng, '2023-03-01', addDays(WORLD_NOW, -3)))).sort();
  const noteSlots: Array<{ date: string; mentions: Mention[] }> = noteDates.map(date => ({ date, mentions: [] }));
  for (const a of accounts) {
    const span = chainSpan(a);
    const own = accountMeetings.filter(m => m.account === a.slug);
    for (let k = 0; k < knobs.distractor_count; k++) {
      const attr = rng.pick(askable.filter(x => x !== 'renewal_date' || k % 2 === 0));
      if (k % 2 === 0) {
        const fits = noteSlots.filter(s => s.date >= span.from && s.date <= span.to && s.mentions.length < 3 && !s.mentions.some(x => x.account === a.slug));
        if (!fits.length) continue;
        const slot = rng.pick(fits);
        slot.mentions.push({ page: '', date: slot.date, account: a.slug, attr, value: wrongValue(a, attr, slot.date), kind: 'note-claim', correct: false, by: null });
      } else {
        const m = own[Math.floor(k / 2) % own.length]!;
        mentions.push({ page: m.slug, date: m.date, account: a.slug, attr, value: wrongValue(a, attr, m.date), kind: 'meeting-proposal', correct: false, by: m.attendees[0] ?? null });
      }
    }
  }
  // Notes also carry correct statements and rumors about people, so a note is not a tell.
  noteSlots.forEach((slot, i) => {
    if (slot.mentions.length === 0 || rng.float() < 0.3) {
      const a = rng.pick(accounts.filter(x => chainSpan(x).from <= slot.date));
      if (a && !slot.mentions.some(x => x.account === a.slug)) {
        const attr = rng.pick(askable);
        slot.mentions.push({ page: '', date: slot.date, account: a.slug, attr, value: valueAt(chains.get(a.slug)!, attr, slot.date)!.value, kind: 'note-claim', correct: true, by: null });
      }
    }
    const author = rng.pick(vendorStaff.filter(p => p.stints[0]!.start <= slot.date) .length ? vendorStaff.filter(p => p.stints[0]!.start <= slot.date) : vendorStaff);
    const kind = rng.pick(['Hallway notes', 'Pipeline notes', 'Call notes', 'Slack recap']);
    const slug = `notes/${slugify(kind)}-${slugify(author.first)}-${i + 1}`;
    for (const m of slot.mentions) { m.page = slug; m.by = rng.pick(vendorStaff.filter(p => p !== author)).slug; mentions.push(m); }
    const movers = [...people.values()].filter(p => p.stints.length > 1 && p.stints.some(s => s.start > slot.date && s.start < addDays(slot.date, 120)));
    let rumor: Note['rumor'] = null;
    if (movers.length && rng.float() < 0.35) {
      const p = rng.pick(movers);
      const next = p.stints.find(s => s.start > slot.date)!;
      rumor = { person: p.slug, org: rng.float() < 0.5 ? next.org : rng.pick([...companies, ...accounts].filter(o => o.slug !== next.org && o.slug !== stintAt(p, slot.date)?.org)).slug };
    }
    notes.push({ slug, date: slot.date, title: `${kind}, ${longDate(slot.date)}`, author: author.slug, mentions: slot.mentions, rumor });
  });

  // Meetings across the companies, until there are WORLD_SIZE.meetings.
  const companyMeetingKinds = ['Board meeting', 'Intro call', 'Coffee', 'Partner sync', 'Demo'];
  let mi = 0;
  while (meetings.length < WORLD_SIZE.meetings) {
    const c = rng.pick(companies);
    const kind = rng.pick(companyMeetingKinds);
    const date = weekdayOn(dateIn(rng, addDays(c.founded!, 365) > '2022-01-01' ? addDays(c.founded!, 365) : '2022-01-01', addDays(WORLD_NOW, -7)));
    const team = contactsAt(c.slug, date).map(p => p.slug);
    if (!team.length) continue;
    const guests = kind === 'Board meeting' ? c.investors.map(i => orgs.get(i.org)!.founder!).filter(Boolean).slice(0, 1) : kind === 'Intro call' || kind === 'Demo' ? [rng.pick(vendorStaff).slug] : [];
    const attendees = [...rng.shuffle(team).slice(0, rng.int(1, 3)), ...guests];
    mi++;
    meetings.push({ slug: `meetings/${slugify(c.name)}-${slugify(kind)}-${mi}`, date, title: `${kind}: ${c.name}`, kind, attendees, account: null, company: c.slug });
  }

  const announcements: Announcement[] = [];
  for (const c of companies) {
    if (c.acquiredBy) {
      const a = orgs.get(c.acquiredBy.org)!;
      announcements.push({ slug: `announcements/${slugify(a.name)}-acquires-${slugify(c.name)}`, date: c.acquiredBy.date, title: `${a.name} acquires ${c.name}`, kind: 'acquisition', org: a.slug, other: c.slug, outgoing: null });
    }
    c.ceo.forEach((t, i) => {
      if (i === 0) return;
      const p = people.get(t.person)!;
      announcements.push({ slug: `announcements/${slugify(c.name)}-names-${slugify(p.name)}-chief-executive`, date: t.start, title: `${c.name} names ${p.name} chief executive`, kind: 'leadership', org: c.slug, other: p.slug, outgoing: c.ceo[i - 1]!.person });
    });
  }

  const world: WorldV3 = {
    knobs: { ...knobs, chain_depth: { ...knobs.chain_depth }, lookalike_pairs: { ...knobs.lookalike_pairs } },
    orgs, people, contracts, chains, meetings, notes, announcements, mentions, pages: new Map(),
    lookalikes: { companies: lookCompanies, homonyms: lookHomonyms, near: lookNear },
  };
  for (const [slug, text] of [...renderAll(world, rng)].sort((x, y) => x[0].localeCompare(y[0]))) world.pages.set(slug, text);
  // Snapshot mentions come from the rendered account pages.
  for (const a of accounts) {
    const snap = snapshotOf(world, a);
    for (const attr of ['seats', 'tier', 'renewal_date'] as const) mentions.push({ page: a.slug, date: snap.date, account: a.slug, attr, value: valueAt(chains.get(a.slug)!, attr, snap.date)!.value, kind: 'snapshot', correct: true, by: null });
  }
  validateWorld(world, reservedStems);
  (world as WorldV3 & { reservedStems: string[] }).reservedStems = reservedStems;
  return world;
}

/** Stems no page carries, kept for absent-entity names. */
export const reservedStemsOf = (w: WorldV3): string[] => (w as WorldV3 & { reservedStems?: string[] }).reservedStems ?? [];

// ─── Contract chains ─────────────────────────────────────────────────────────

function makeChain(rng: Rng, a: Org, knobs: V3Knobs, staff: readonly string[]): Contract[] {
  const depth = rng.int(knobs.chain_depth.min, knobs.chain_depth.max);
  for (let attempt = 0; attempt < 50; attempt++) {
    const chain = tryChain(rng, a, depth, staff);
    if (chain) return chain;
  }
  throw new Error(`world-v3: no contract chain of depth ${depth} fits for ${a.slug}`);
}

function pickNew(rng: Rng, attr: AttrId, now: AttrValue): AttrValue {
  const range = (VALUE_RANGES as Record<string, () => readonly AttrValue[]>)[attr]!();
  if (attr === 'seats') { const n = Number(now); return rng.pick(range.filter(v => v !== n && Math.abs(Number(v) - n) >= 15 && Math.abs(Number(v) - n) <= Math.max(60, n * 0.5))); }
  if (attr === 'price') { const n = Number(now); return rng.pick(range.filter(v => v !== n && Math.abs(Number(v) - n) <= 250)); }
  return rng.pick(range.filter(v => String(v) !== String(now)));
}

function tryChain(rng: Rng, a: Org, depth: number, staff: readonly string[]): Contract[] | null {
  const base = slugify(a.name);
  const counts: Record<ContractKind, number> = { msa: 0, amendment: 0, renewal: 0, 'side-letter': 0, rescission: 0 };
  const signedMsa = dateIn(rng, '2022-01-10', '2024-02-28');
  const eff = monthStart(signedMsa, rng.int(1, 2));
  const termEnd = monthEnd(eff, rng.pick([12, 24, 36]) - 1);
  const v = (attr: AttrId) => rng.pick((VALUE_RANGES as Record<string, () => readonly AttrValue[]>)[attr]!());
  const msa: Contract = {
    slug: `contracts/${base}-msa`, account: a.slug, kind: 'msa', ordinal: 1, title: `Master Subscription Agreement: ${a.name}`, signed: signedMsa, effective: eff,
    sets: { seats: v('seats'), price: v('price'), discount: v('discount'), renewal_date: termEnd, notice: v('notice'), payment: v('payment'), tier: v('tier') },
    before: {}, rescinds: null, termStart: eff, termEnd, preparedBy: rng.pick(staff),
  };
  const chain: Contract[] = [msa];
  let term = { start: eff, end: termEnd };
  let cursor = signedMsa;
  const inForce = (attr: AttrId, date: string) => valueAt(chain, attr, date)!.value;
  while (chain.length < depth) {
    const last = chain.at(-1)!;
    const options: ContractKind[] = [];
    const renewSigned = addDays(term.end, -rng.int(35, 85));
    if (renewSigned > cursor && renewSigned <= addDays(WORLD_NOW, -10)) options.push('renewal', 'renewal');
    const midFrom = addDays(cursor > term.start ? cursor : term.start, 25), midTo = addDays(term.end, -60);
    if (midFrom < midTo && midFrom <= addDays(WORLD_NOW, -40)) options.push('amendment', 'amendment', 'side-letter');
    if ((last.kind === 'amendment' || last.kind === 'side-letter') && !chain.some(c => c.rescinds === last.slug)) options.push('rescission', 'rescission');
    if (!options.length) return null;
    const kind = chain.length === depth - 1 && term.end < WORLD_NOW && options.includes('renewal') ? 'renewal' : rng.pick(options);
    counts[kind]++;
    const prepared = rng.pick(staff);
    if (kind === 'renewal') {
      const start = addDays(term.end, 1);
      const end = monthEnd(start, rng.pick([12, 12, 24]) - 1);
      const sets: Partial<Record<AttrId, AttrValue>> = { renewal_date: end };
      if (rng.float() < 0.6) sets.seats = pickNew(rng, 'seats', inForce('seats', term.end));
      if (rng.float() < 0.4) sets.price = pickNew(rng, 'price', inForce('price', term.end));
      if (rng.float() < 0.25) sets.discount = pickNew(rng, 'discount', inForce('discount', term.end));
      const before = Object.fromEntries(Object.keys(sets).map(k => [k, inForce(k as AttrId, term.end)]));
      chain.push({ slug: `contracts/${base}-renewal-${year(start)}`, account: a.slug, kind, ordinal: counts.renewal, title: `Renewal Order ${year(start)}: ${a.name}`, signed: renewSigned, effective: start, sets, before, rescinds: null, termStart: start, termEnd: end, preparedBy: prepared });
      cursor = renewSigned;
      term = { start, end };
    } else if (kind === 'amendment' || kind === 'side-letter') {
      const signed = dateIn(rng, midFrom, midTo < addDays(WORLD_NOW, -40) ? midTo : addDays(WORLD_NOW, -40));
      const effective = monthStart(signed, 1);
      const pool: AttrId[] = kind === 'amendment' ? ['seats', 'discount', 'tier', 'price'] : ['payment', 'notice', 'discount'];
      const attrs = rng.shuffle(pool).slice(0, kind === 'amendment' && rng.float() < 0.35 ? 2 : 1);
      const sets = Object.fromEntries(attrs.map(x => [x, pickNew(rng, x, inForce(x, effective))])) as Partial<Record<AttrId, AttrValue>>;
      const before = Object.fromEntries(attrs.map(x => [x, inForce(x, addDays(effective, -1))]));
      const label = kind === 'amendment' ? 'Amendment' : 'Side Letter';
      chain.push({ slug: `contracts/${base}-${kind}-${counts[kind]}`, account: a.slug, kind, ordinal: counts[kind], title: `${label} ${counts[kind]}: ${a.name}`, signed, effective, sets, before, rescinds: null, termStart: null, termEnd: null, preparedBy: prepared });
      cursor = signed;
    } else {
      const signed = dateIn(rng, addDays(last.effective, 20), addDays(last.effective, 75));
      const effective = monthStart(signed, 1);
      if (signed > addDays(WORLD_NOW, -10) || effective >= term.end) { counts[kind]--; return null; }
      const restored = Object.fromEntries(Object.keys(last.sets).map(k => [k, last.before[k as AttrId]!]));
      chain.push({ slug: `contracts/${base}-rescission-${counts.rescission}`, account: a.slug, kind, ordinal: counts.rescission, title: `Rescission of ${last.title.split(':')[0]}: ${a.name}`, signed, effective, sets: {}, before: restored, rescinds: last.slug, termStart: null, termEnd: null, preparedBy: prepared });
      cursor = signed;
    }
  }
  return chainEnd(chain) >= ACTIVE_UNTIL ? chain : null;
}

/** Every account's latest term runs at least until this day. */
const ACTIVE_UNTIL = '2025-09-30';

// ─── Rendering ───────────────────────────────────────────────────────────────

const link = (title: string, slug: string) => `[${title}](${slug})`;
const fill = (tpl: string, slots: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => slots[k] ?? `{${k}}`);
const frontmatter = (type: string, title: string, date?: string) => `---\ntype: ${type}\ntitle: ${JSON.stringify(title)}${date ? `\ndate: ${date}` : ''}\n---\n\n`;
export const wordCount = (page: string) => page.replace(/^---\n[\s\S]*?\n---\n/, '').split(/\s+/).filter(Boolean).length;
const span = (start: string, end: string | null) => (end ? `${monthYear(start)} to ${monthYear(end)}` : `since ${monthYear(start)}`);

function snapshotOf(w: WorldV3, a: Org): { date: string } {
  const chain = w.chains.get(a.slug)!;
  const own = w.meetings.filter(m => m.account === a.slug).map(m => m.date).sort();
  const date = own[0] ?? addDays(chain[0]!.effective, 60);
  return { date };
}

/** Pad a page with sentences from `bank` it does not hold yet, in seeded order, until it reaches `min` words or the bank runs out. */
function padTo(rng: Rng, min: number, body: string, bank: readonly string[], item = (x: string) => `\n${x}\n`): string {
  let out = body;
  for (const x of rng.shuffle([...new Set(bank)])) {
    if (wordCount(out) >= min) break;
    if (!out.includes(x)) out = out.replace(/\n*$/, '\n') + item(x);
  }
  return out;
}

function renderAll(w: WorldV3, rng: Rng): Map<string, string> {
  const pages = new Map<string, string>();
  const org = (slug: string) => w.orgs.get(slug)!;
  const person = (slug: string) => w.people.get(slug)!;
  const ol = (slug: string) => link(org(slug).name, slug);
  const pl = (slug: string) => link(person(slug).name, slug);
  const pickN = <T,>(xs: readonly T[], n: number) => rng.shuffle(xs).slice(0, n);
  const target = () => rng.int(PAGE_WORDS.min + 20, 300);

  for (const p of w.people.values()) {
    const cur = currentStint(p);
    const lines: string[] = [];
    const founderOf = [...w.orgs.values()].find(o => o.founder === p.slug);
    if (founderOf) {
      const handed = founderOf.ceo.length > 1 && founderOf.ceo[0]!.person === p.slug ? founderOf.ceo[1]! : null;
      const what = founderOf.kind === 'investor' ? 'the venture firm' : `the ${founderOf.industry} company`;
      lines.push(`${p.name} founded ${ol(founderOf.slug)}, ${what}, in ${year(founderOf.founded!)}.`);
      if (handed) lines.push(`${p.first} handed the chief executive role to ${pl(handed.person)} in ${monthYear(handed.start)} and stayed on as executive chair.`);
      else if (founderOf.kind === 'company') lines.push(`${p.first} has led it as chief executive ever since.`);
    } else if (cur) {
      lines.push(`${p.name} is the ${cur.title} at ${ol(cur.org)}, a role ${p.first} has held since ${monthYear(cur.start)}.`);
    }
    const prev = p.stints.filter(s => s.end).sort((a, b) => b.start.localeCompare(a.start));
    if (prev[0] && !founderOf) lines.push(`Before that, ${p.first} was ${prev[0].title} at ${ol(prev[0].org)}.`);
    const inv = founderOf?.kind === 'investor' ? founderOf.portfolio : [];
    if (inv.length) lines.push(`${p.first} led the firm's investments in ${inv.map(x => ol(x.org)).join(', ')}.`);
    const career = [...p.stints].sort((a, b) => b.start.localeCompare(a.start)).map(s => `- ${s.end ? `${monthYear(s.start)} to ${monthYear(s.end)}` : `Since ${monthYear(s.start)}`}: ${s.title}, ${ol(s.org)}`);
    const slots = { first: p.first, field: rng.pick(FIELDS), school: rng.pick(SCHOOLS), hobby: rng.pick(HOBBIES), early: rng.pick(EARLY_WORK), city: p.city };
    const bio = pickN(PERSON_FILLER, rng.int(3, 5)).map(t => fill(t, slots)).join(' ');
    const timeline = [...p.stints].sort((a, b) => b.start.localeCompare(a.start)).map(s => s.role === 'founder' && s.title.startsWith('founder and chief') || (s.role === 'founder' && founderOf?.kind === 'investor')
      ? `- **${s.start}** | Founded ${ol(s.org)}` : `- **${s.start}** | Started as ${s.title} at ${ol(s.org)}`);
    let body = `# ${p.name}\n\n${lines.join(' ')}\n\n## Career\n\n${career.join('\n')}\n\n## Background\n\n${bio}\n\n## Timeline\n\n${timeline.join('\n')}\n`;
    body = padTo(rng, target(), body, PERSON_FILLER.map(t => fill(t, slots)));
    pages.set(p.slug, frontmatter('person', p.name) + body);
  }

  for (const o of w.orgs.values()) {
    if (o.kind === 'account') continue;
    const kindLine = o.kind === 'investor' ? `${o.name} is a venture capital firm based in ${o.city}.` : o.kind === 'vendor' ? `${o.name} makes ${VENDOR.product}, dock and yard scheduling software for warehouses and distribution sites. It is based in ${o.city}.` : `${o.name} is a ${o.industry} company based in ${o.city}.`;
    const founding = o.founder ? `It was founded in ${year(o.founded!)} by ${pl(o.founder)}.` : '';
    const slots = { name: o.name, industry: o.industry, product: o.product, customer: o.customer, city: o.city };
    const intro = [kindLine, founding, ...pickN(COMPANY_FILLER, 2).map(t => fill(t, slots))].filter(Boolean).join(' ');
    const sections: string[] = [`# ${o.name}\n\n${intro}`];
    const lead: string[] = [];
    for (const [label, ts] of [['Chief executive', o.ceo], ['Chief technology officer', o.cto], ['Chief financial officer', o.cfo]] as const) {
      if (ts.length) lead.push(`- ${label}: ${ts.map(t => `${pl(t.person)} (${span(t.start, t.end)})`).join('; ')}`);
    }
    if (lead.length) sections.push(`## Leadership\n\n${lead.join('\n')}`);
    const team = [...w.people.values()].flatMap(p => p.stints.filter(s => s.org === o.slug && (s.role === 'team' || s.role === 'vendor')).map(s => ({ p, s }))).sort((x, y) => x.s.start.localeCompare(y.s.start) || x.p.slug.localeCompare(y.p.slug));
    if (team.length) sections.push(`## Team\n\n${team.map(({ p, s }) => `- ${pl(p.slug)}, ${s.title} (${span(s.start, s.end)})`).join('\n')}`);
    const own: string[] = [];
    if (o.acquiredBy) own.push(`In ${monthYear(o.acquiredBy.date)}, ${o.name} was acquired by ${ol(o.acquiredBy.org)}. It operates as a subsidiary and keeps its own brand.`);
    for (const x of o.acquired) own.push(`In ${monthYear(x.date)}, ${o.name} acquired ${ol(x.org)}.`);
    if (own.length) sections.push(`## Ownership\n\n${own.join(' ')}`);
    if (o.investors.length) sections.push(`## Investors\n\n${o.investors.map(i => `- ${ol(i.org)}, first invested in ${i.year}`).join('\n')}`);
    if (o.portfolio.length) sections.push(`## Portfolio\n\n${o.portfolio.map(i => `- ${ol(i.org)}, first invested in ${i.year}`).join('\n')}`);
    const tl: Array<[string, string]> = [];
    if (o.founder) tl.push([o.founded!, `Founded by ${pl(o.founder)}`]);
    o.ceo.slice(1).forEach(t => tl.push([t.start, `${pl(t.person)} became chief executive`]));
    if (o.acquiredBy) tl.push([o.acquiredBy.date, `Acquired by ${ol(o.acquiredBy.org)}`]);
    o.acquired.forEach(x => tl.push([x.date, `Acquired ${ol(x.org)}`]));
    if (tl.length) sections.push(`## Timeline\n\n${tl.sort((x, y) => y[0].localeCompare(x[0])).map(([d, t]) => `- **${d}** | ${t}`).join('\n')}`);
    const body = padTo(rng, target(), sections.join('\n\n') + '\n', COMPANY_FILLER.map(t => fill(t, slots)));
    pages.set(o.slug, frontmatter('company', o.name) + body);
  }

  for (const a of [...w.orgs.values()].filter(o => o.kind === 'account')) {
    const chain = w.chains.get(a.slug)!;
    const slots = { name: a.name, city: a.city, business: a.industry };
    const contacts = [...w.people.values()].flatMap(p => p.stints.filter(s => s.org === a.slug).map(s => ({ p, s }))).sort((x, y) => x.s.start.localeCompare(y.s.start) || x.p.slug.localeCompare(y.p.slug));
    const snap = snapshotOf(w, a).date;
    const sv = (attr: AttrId) => ATTRS[attr].cell(valueAt(chain, attr, snap)!.value);
    const sections = [
      `# ${a.name}\n\n${a.name} is a customer of ${link(VENDOR.name, VENDOR.slug)} for ${VENDOR.product}. ${pickN(ACCOUNT_FILLER, 2).map(t => fill(t, slots)).join(' ')}`,
      `## Contacts\n\n${contacts.map(({ p, s }) => `- ${pl(p.slug)}, ${s.title} (${span(s.start, s.end)})`).join('\n')}\n- Account owner at ${VENDOR.name}: ${pl(a.owner!)}`,
      `## Contract history\n\n${chain.map(c => `- ${link(c.title.split(':')[0]!, c.slug)}, signed ${longDate(c.signed)}`).join('\n')}`,
      `## Account snapshot\n\nLast reviewed ${longDate(snap)}. Seats: ${sv('seats')}. Support: ${sv('tier')}. Current term ends: ${sv('renewal_date')}. The snapshot is copied from the last account review and is not updated when a contract changes; the signed records above govern.`,
    ];
    const body = padTo(rng, target(), sections.join('\n\n') + '\n', ACCOUNT_FILLER.map(t => fill(t, slots)));
    pages.set(a.slug, frontmatter('company', a.name) + body);
  }

  for (const c of w.contracts.values()) {
    const a = org(c.account);
    const chain = w.chains.get(a.slug)!;
    const msa = chain[0]!;
    const boiler = () => pickN(CONTRACT_FILLER, 2).map(t => fill(t, { vendor: VENDOR.name, account: a.name })).join(' ');
    const parts: string[] = [`# ${c.title}`];
    if (c.kind === 'msa') {
      parts.push(`This Master Subscription Agreement is between ${VENDOR.name} and ${link(a.name, a.slug)} for ${VENDOR.product}, ${VENDOR.name}'s dock and yard scheduling product.`);
      parts.push(`## Dates\n\nSigned: ${longDate(c.signed)}.\nEffective: ${longDate(c.effective)}.\nThe initial term runs from ${longDate(c.termStart!)} to ${longDate(c.termEnd!)}.`);
      parts.push(`## Terms\n\n| Term | Value |\n|---|---|\n${ATTR_IDS.map(x => `| ${ATTRS[x].label} | ${ATTRS[x].cell(c.sets[x]!)} |`).join('\n')}`);
      parts.push(`From ${longDate(c.effective)}, the subscribed seat count is ${c.sets.seats} seats at a list price of ${ATTRS.price.cell(c.sets.price!)} per seat per year, less a ${c.sets.discount}% discount. Invoices are due net ${c.sets.payment}, either party may decline renewal with ${c.sets.notice} days' notice, and support is ${c.sets.tier}.`);
    } else if (c.kind === 'rescission') {
      const target = w.contracts.get(c.rescinds!)!;
      const name = target.title.split(':')[0]!;
      parts.push(`This rescission agreement between ${VENDOR.name} and ${link(a.name, a.slug)} rescinds ${link(name, target.slug)} in full.`);
      parts.push(`## Dates\n\nSigned: ${longDate(c.signed)}.\nEffective: ${longDate(c.effective)}.`);
      parts.push(`## Effect\n\nFrom ${longDate(c.effective)}, ${name} has no further effect. Every term it changed returns to the value in force immediately before ${name} took effect. ${name} applied from ${longDate(target.effective)} until ${longDate(addDays(c.effective, -1))}.`);
    } else {
      const rows = (Object.keys(c.sets) as AttrId[]).sort((x, y) => ATTR_IDS.indexOf(x) - ATTR_IDS.indexOf(y));
      const what = c.kind === 'renewal' ? `This renewal order renews the subscription of ${link(a.name, a.slug)} under the ${link('Master Subscription Agreement', msa.slug)}.`
        : c.kind === 'amendment' ? `This amendment is between ${VENDOR.name} and ${link(a.name, a.slug)}. It amends the ${link('Master Subscription Agreement', msa.slug)}.`
          : `This side letter is a letter agreement between ${VENDOR.name} and ${link(a.name, a.slug)} under the ${link('Master Subscription Agreement', msa.slug)}.`;
      parts.push(what);
      const dates = c.kind === 'renewal'
        ? `Signed: ${longDate(c.signed)}.\nEffective: ${longDate(c.effective)}.\nThe renewal term runs from ${longDate(c.termStart!)} to ${longDate(c.termEnd!)}. This order was signed ahead of the start of the renewal term; until ${longDate(c.effective)} the current term and its terms continue to apply.`
        : `Signed: ${longDate(c.signed)}.\nEffective: ${longDate(c.effective)}.\nUntil the effective date, the terms in force before this document continue to apply.`;
      parts.push(`## Dates\n\n${dates}`);
      parts.push(`## Changes\n\n| Term | Before this document | From ${longDate(c.effective)} |\n|---|---|---|\n${rows.map(x => `| ${ATTRS[x].label} | ${ATTRS[x].cell(c.before[x]!)} | ${ATTRS[x].cell(c.sets[x]!)} |`).join('\n')}`);
      parts.push(`From ${longDate(c.effective)}, ${rows.map(x => `the ${ATTRS[x].label.toLowerCase()} is ${ATTRS[x].cell(c.sets[x]!)}`).join(' and ')}. All other terms are unchanged.`);
    }
    parts.push(`Prepared by ${pl(c.preparedBy)} for the order file. ${boiler()}`);
    const body = padTo(rng, target(), parts.join('\n\n') + '\n', CONTRACT_FILLER.map(t => fill(t, { vendor: VENDOR.name, account: a.name })));
    pages.set(c.slug, frontmatter('deal', c.title, c.signed) + body);
  }

  for (const m of w.meetings) {
    const att = m.attendees.map(s => { const st = stintAt(person(s), m.date); return st ? `${pl(s)} (${st.title}, ${org(st.org).name})` : pl(s); });
    const subject = m.account ? org(m.account) : org(m.company!);
    const bullets: string[] = [];
    for (const x of w.mentions.filter(y => y.page === m.slug)) {
      const rec = valueAt(w.chains.get(x.account)!, x.attr, x.date)!.record;
      if (x.kind === 'meeting-status') bullets.push(`${subject.name} is on ${ATTRS[x.attr].say(x.value)} under the ${link(rec.title.split(':')[0]!, rec.slug)}.`);
      else bullets.push(`${x.by ? pl(x.by) : 'The customer'} floated moving to ${ATTRS[x.attr].say(x.value)} at some point; nothing has been signed.`);
    }
    const who = m.attendees[0] ? person(m.attendees[0]).first : 'The group';
    bullets.push(...pickN(MEETING_FILLER, rng.int(3, 5)).map(t => fill(t, { org: subject.name, person: who })));
    const body = padTo(rng, target(), `# ${m.title}\n\nDate: ${longDate(m.date)}.\nAttendees: ${att.join(', ')}.\nAbout: ${link(subject.name, subject.slug)}.\n\n## Notes\n\n${bullets.map(b => `- ${b}`).join('\n')}\n`, MEETING_FILLER.map(t => fill(t, { org: subject.name, person: who })), x => `- ${x}\n`);
    pages.set(m.slug, frontmatter('meeting', m.title, m.date) + body);
  }

  for (const n of w.notes) {
    const author = person(n.author);
    const lines = n.mentions.map(x => {
      const who = x.by ? pl(x.by) : 'Someone on the team';
      return x.correct ? `${who} confirmed that ${link(org(x.account).name, x.account)} is on ${ATTRS[x.attr].say(x.value)}.`
        : `${who} thinks ${link(org(x.account).name, x.account)} is on ${ATTRS[x.attr].say(x.value)} now. I have not seen the paperwork.`;
    });
    if (n.rumor) lines.push(`Heard that ${pl(n.rumor.person)} might be moving to ${ol(n.rumor.org)}. Unconfirmed.`);
    const filler = pickN(NOTE_FILLER, 2).map(t => fill(t, { author: author.first }));
    const body = padTo(rng, target(), `# ${n.title}\n\nBy ${pl(n.author)}.\n\n${filler[0]}\n\n${lines.map(l => `- ${l}`).join('\n')}\n\n${filler[1]}\n`, NOTE_FILLER.map(t => fill(t, { author: author.first })));
    pages.set(n.slug, frontmatter('note', n.title, n.date) + body);
  }

  for (const x of w.announcements) {
    const o = org(x.org);
    const lines = x.kind === 'acquisition'
      ? [`On ${longDate(x.date)}, ${ol(x.org)} announced that it has acquired ${ol(x.other)}.`, `${org(x.other).name} will operate as a subsidiary and keep its own brand.`]
      : [`On ${longDate(x.date)}, ${ol(x.org)} named ${pl(x.other)} chief executive.`, `${person(x.other).first} succeeds ${pl(x.outgoing!)} in the role.`];
    const about = [o, ...(x.kind === 'acquisition' ? [org(x.other)] : [])].map(z => `About ${z.name}: ${fill(rng.pick(COMPANY_FILLER), { name: z.name, industry: z.industry, product: z.product, customer: z.customer, city: z.city })}`);
    const body = padTo(rng, target(), `# ${x.title}\n\n${lines.join(' ')} ${pickN(ANNOUNCEMENT_FILLER, 2).join(' ')}\n\n${about.join('\n\n')}\n`, [...ANNOUNCEMENT_FILLER, ...COMPANY_FILLER.map(t => fill(t, { name: o.name, industry: o.industry, product: o.product, customer: o.customer, city: o.city }))]);
    pages.set(x.slug, frontmatter('media', x.title, x.date) + body);
  }
  return pages;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const LINK_RE = /\[([^\]]+)\]\(([a-z]+\/[a-z0-9-]+)\)/g;

/** Throws on a page outside the word range, a link to a missing page, a title collision outside the look-alike design, or a reserved stem a page carries. */
function validateWorld(w: WorldV3, reserved: readonly string[]): void {
  const problems: string[] = [];
  for (const [slug, text] of w.pages) {
    const n = wordCount(text);
    if (n < PAGE_WORDS.min || n > PAGE_WORDS.max) problems.push(`${slug}: ${n} words`);
    for (const m of text.matchAll(LINK_RE)) if (!w.pages.has(m[2]!)) problems.push(`${slug}: link to missing ${m[2]}`);
  }
  const titles = new Map<string, string[]>();
  for (const p of w.people.values()) titles.set(p.name, [...(titles.get(p.name) ?? []), p.slug]);
  for (const o of w.orgs.values()) titles.set(o.name, [...(titles.get(o.name) ?? []), o.slug]);
  const homonyms = new Set(w.lookalikes.homonyms.flat());
  for (const [t, slugs] of titles) if (slugs.length > 1 && !slugs.every(s => homonyms.has(s))) problems.push(`title ${t} on ${slugs.join(', ')}`);
  const all = [...w.pages.values()].join('\n').toLowerCase();
  for (const s of reserved) if (all.includes(s.toLowerCase())) problems.push(`reserved stem ${s} occurs in a page`);
  if (w.pages.size < 900 || w.pages.size > 1100) problems.push(`${w.pages.size} pages`);
  if (problems.length) throw new Error(`world-v3 is invalid:\n  ${problems.slice(0, 30).join('\n  ')}`);
}
