/**
 * N2 contradiction-surfacing world generator and oracle.
 *
 * `generateN2World(seed)` writes a deterministic LEDGER of planted pairs.
 * Each item is one fact about one fictional company, stated on two note
 * pages, plus one query that names the company and the attribute (the probe
 * is query-driven: gbrain judges pairs among the top results of the queries
 * a caller supplies, so every item carries the query a caller would ask).
 *
 * Item kinds and their gold class:
 *   same_time_conflict  contradiction  two values for the same fact at the
 *                                      same date (variants: both pages dated
 *                                      the same day; both undated; one dated
 *                                      and one undated with the same date in
 *                                      its text)
 *   dated_change        temporal       the value changed between two dates
 *                                      (variants: dates in frontmatter; dates
 *                                      only in the text; a metric that fell,
 *                                      which gbrain names temporal_regression)
 *   holder_opinion      compatible     two people hold different subjective
 *                                      opinions (different holders)
 *   agreement           compatible     the same value in different words
 *   namesake            compatible     the same attribute of two different
 *                                      companies whose names share a word
 *   negation            compatible     "X is not leading" beside "Y is leading"
 *
 * Every other page (one profile per company) states only attributes that are
 * not planted for that company, and every value is unique per attribute, so
 * any pair that is not planted is compatible by construction. The oracle
 * (`n2Gold`) therefore labels every possible pair from the ledger alone.
 *
 * Presence: `generateN2World` throws if a claim span is missing from the
 * rendered page that should carry it. Gold never comes from gbrain output.
 *
 * All names are fictional placeholders ending in "Example".
 */
import { createHash } from 'node:crypto';

export const N2_GENERATOR_VERSION = 'n2-contradiction-gen/1.0.0';
export const N2_DEFAULT_SEED = 20261001;

export type N2Kind = 'same_time_conflict' | 'dated_change' | 'holder_opinion' | 'agreement' | 'namesake' | 'negation';
export type N2Variant =
  | 'dated_same_day' | 'undated' | 'mixed_dated'
  | 'frontmatter_dates' | 'text_dates' | 'regression'
  | 'plain';
export type GoldClass = 'contradiction' | 'temporal' | 'compatible';

export const KIND_CLASS: Record<N2Kind, GoldClass> = {
  same_time_conflict: 'contradiction', dated_change: 'temporal',
  holder_opinion: 'compatible', agreement: 'compatible', namesake: 'compatible', negation: 'compatible',
};

export interface N2Side { slug: string; title: string; date: string | null; claim: string; body: string }
export interface N2Item {
  id: string;
  kind: N2Kind;
  variant: N2Variant;
  gold_class: GoldClass;
  /** temporal items only: the side whose value is older (superseded). */
  older_side: 'a' | 'b' | null;
  entity: string;
  attribute: string;
  query: string;
  a: N2Side;
  b: N2Side;
}
export interface N2Page { slug: string; title: string; date: string | null; body: string; item: string | null }
export interface N2Ledger {
  generator_version: string;
  seed: number;
  items: N2Item[];
  pages: N2Page[];
}
export interface GeneratedN2 { ledger: N2Ledger; fingerprint: string }

export const N2_DEFAULT_COUNTS: Readonly<Record<N2Kind, number>> = {
  same_time_conflict: 150, dated_change: 60, holder_opinion: 15, agreement: 15, namesake: 15, negation: 15,
};

// ─── Seeded randomness ─────────────────────────────────────────────────

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

// ─── Fictional vocabulary ──────────────────────────────────────────────

const HEADS = ['Cor', 'Tal', 'Bren', 'Quil', 'Mor', 'Vex', 'Lun', 'Sab', 'Dra', 'Pel', 'Ost', 'Fen', 'Gral', 'Hux', 'Ivo', 'Jarn', 'Kel', 'Nim', 'Orv', 'Ruv'];
const TAILS = ['vane', 'mora', 'dlex', 'trix', 'quay', 'sorn', 'dela', 'barth', 'nix', 'wick', 'pellow', 'zarra', 'ford', 'mund', 'tessa', 'loom'];
const SECTORS = ['Labs', 'Health', 'Grid', 'Freight', 'Robotics', 'Foods', 'Analytics', 'Marine'];
const CITY_HEADS = ['Talmo', 'Brevi', 'Ostra', 'Quill', 'Marsd', 'Vella', 'Dune', 'Carro', 'Eskel', 'Fallo', 'Grenn', 'Halbro', 'Iverd', 'Jorva', 'Kestwi', 'Lornc'];
const CITY_TAILS = ['ra', 'port', 'holt', 'mere', 'mouth', 'deen', 'vale', 'wick', 'cliff', 'ford', 'haven', 'stead'];
const BIRDS = ['Kestrel', 'Osprey', 'Plover', 'Heron', 'Merlin', 'Curlew', 'Shrike', 'Wren', 'Avocet', 'Bittern', 'Dunlin', 'Egret'];
const FIRST = ['Alice', 'Bruno', 'Celia', 'Dmitri', 'Elena', 'Farid', 'Greta', 'Hugo', 'Ines', 'Jonas', 'Kira', 'Liam', 'Mara', 'Niko', 'Olga', 'Pavel'];
const LAST = ['Ward', 'Lund', 'Sato', 'Okoro', 'Brandt', 'Rossi', 'Novak', 'Haas', 'Moreau', 'Silva', 'Quist', 'Varga'];
const OPINIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['pricing', 'too aggressive', 'too conservative'],
  ['market', 'overcrowded', 'wide open'],
  ['founding team', 'too inexperienced for enterprise sales', 'unusually strong at enterprise sales'],
  ['product roadmap', 'too ambitious', 'too timid'],
  ['hiring plan', 'reckless', 'overly cautious'],
];
const SOURCES_A = ['Call notes', 'Diligence memo', 'Partner meeting notes', 'Founder update digest'];
const SOURCES_B = ['Board deck review', 'Reference call notes', 'Analyst brief', 'Investor dinner notes'];
const FILLER = [
  'The rest of the conversation covered hiring and the next quarter.',
  'We agreed to revisit the deal after the next partner meeting.',
  'Follow-ups are tracked in the weekly review.',
  'Nothing else in the discussion changes the investment view.',
];

interface Attr {
  key: string;
  label: string;
  numeric: boolean;
  question: (e: string) => string;
  value: (r: () => number, used: Set<string>) => string;
  sentence: (e: string, v: string) => string;
  /** The same value in other words, for agreement items. */
  restate: (e: string, v: string) => string;
  /** For dated changes: phrasing of the newer value. */
  changed: (e: string, v: string) => string;
}

const pick = <T>(xs: readonly T[], r: () => number): T => xs[Math.floor(r() * xs.length)];
function shuffle<T>(items: readonly T[], r: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function unique(used: Set<string>, make: () => string): string {
  for (let i = 0; i < 10_000; i++) {
    const v = make();
    if (!used.has(v)) { used.add(v); return v; }
  }
  throw new Error('value space exhausted');
}

export const ATTRS: readonly Attr[] = [
  { key: 'headcount', label: 'headcount', numeric: true, question: e => `What is the headcount of ${e}?`,
    value: (r, u) => unique(u, () => `${20 + Math.floor(r() * 480)} people`),
    sentence: (e, v) => `${e} headcount is ${v}.`, restate: (e, v) => `${e} has ${v.replace(' people', '')} employees on staff, so its headcount is ${v}.`,
    changed: (e, v) => `${e} headcount is now ${v}.` },
  { key: 'arr', label: 'annual recurring revenue', numeric: true, question: e => `What is the annual recurring revenue of ${e}?`,
    value: (r, u) => unique(u, () => `$${(1 + Math.floor(r() * 290) / 10).toFixed(1)}M ARR`),
    sentence: (e, v) => `${e} reports ${v}.`, restate: (e, v) => `${e} annual recurring revenue stands at ${v}.`,
    changed: (e, v) => `${e} now reports ${v}.` },
  { key: 'runway', label: 'runway', numeric: true, question: e => `How many months of runway does ${e} have?`,
    value: (r, u) => unique(u, () => `${6 + Math.floor(r() * 120)} months of runway`),
    sentence: (e, v) => `${e} has ${v}.`, restate: (e, v) => `At current burn ${e} has ${v}.`,
    changed: (e, v) => `${e} now has ${v}.` },
  { key: 'pilots', label: 'pilot customers', numeric: true, question: e => `How many pilot customers does ${e} have?`,
    value: (r, u) => unique(u, () => `${2 + Math.floor(r() * 300)} pilot customers`),
    sentence: (e, v) => `${e} has ${v}.`, restate: (e, v) => `${e} is running ${v} in total.`,
    changed: (e, v) => `${e} now has ${v}.` },
  { key: 'cap', label: 'valuation cap', numeric: true, question: e => `What is the valuation cap on the ${e} SAFE?`,
    value: (r, u) => unique(u, () => `$${10 + Math.floor(r() * 400)}M cap`),
    sentence: (e, v) => `The ${e} SAFE carries a ${v}.`, restate: (e, v) => `The SAFE for ${e} is priced with a ${v}.`,
    changed: (e, v) => `The ${e} SAFE now carries a ${v}.` },
  { key: 'hq', label: 'headquarters city', numeric: false, question: e => `Which city is ${e} headquartered in?`,
    value: (r, u) => unique(u, () => `${pick(CITY_HEADS, r)}${pick(CITY_TAILS, r)}`),
    sentence: (e, v) => `${e} is headquartered in ${v}.`, restate: (e, v) => `The head office of ${e} sits in ${v}, its headquarters city.`,
    changed: (e, v) => `${e} is now headquartered in ${v}.` },
  { key: 'ceo', label: 'chief executive', numeric: false, question: e => `Who is the CEO of ${e}?`,
    value: (r, u) => unique(u, () => `${pick(FIRST, r)} ${pick(LAST, r)}-Example`),
    sentence: (e, v) => `${v} is the CEO of ${e}.`, restate: (e, v) => `${e} is led by chief executive ${v}, its CEO.`,
    changed: (e, v) => `${v} is now the CEO of ${e}.` },
];
const ATTR_BY_KEY = new Map(ATTRS.map(a => [a.key, a]));
export const attrByKey = (k: string): Attr => ATTR_BY_KEY.get(k)!;

// A regression uses a smaller value, a numeric change a larger one; numeric attributes only.
function scaled(v: string, factor: number): string {
  return v.replace(/\d+(\.\d+)?/, m => (m.includes('.') ? Math.max(0.1, Number(m) * factor).toFixed(1) : String(Math.max(1, Math.round(Number(m) * factor)))));
}
const smaller = (v: string, r: () => number) => scaled(v, 0.25 + r() * 0.5);
const larger = (v: string, r: () => number) => scaled(v, 1.4 + r() * 1.6);

const pad = (n: number, w = 3) => String(n).padStart(w, '0');
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function isoDay(base: number, offsetDays: number): string {
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
function monthDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function renderN2Page(p: Pick<N2Page, 'title' | 'date' | 'body'>): string {
  const fm = [`type: note`, `title: ${p.title}`, ...(p.date ? [`date: ${p.date}`] : [])];
  return `---\n${fm.join('\n')}\n---\n${p.body}\n`;
}

export function generateN2World(opts: { seed?: number; counts?: Partial<Record<N2Kind, number>> } = {}): GeneratedN2 {
  const seed = opts.seed ?? N2_DEFAULT_SEED;
  const counts = { ...N2_DEFAULT_COUNTS, ...opts.counts };
  const r = mulberry32(seed);
  const usedNames = new Set<string>();
  const usedValues = new Map<string, Set<string>>(ATTRS.map(a => [a.key, new Set<string>()]));
  const vals = (k: string) => usedValues.get(k)!;
  const items: N2Item[] = [];
  const pages: N2Page[] = [];
  const base = Date.UTC(2025, 0, 6);

  const newHead = () => unique(usedNames, () => `${pick(HEADS, r)}${pick(TAILS, r)}`);
  const companyName = (head: string, sector?: string) => `${head}${sector ? ` ${sector}` : ''} Example`;

  const profile = (name: string, exclude: string) => {
    const attrs = ATTRS.filter(a => a.key !== exclude && a.key !== 'ceo').slice(0, 7);
    const chosen = shuffle(attrs, r).slice(0, 3);
    const body = [`${name} is a fictional company in the N2 contradiction world.`, ...chosen.map(a => a.sentence(name, a.value(r, new Set<string>())))].join(' ');
    pages.push({ slug: `companies/${slugify(name)}`, title: name, date: null, body, item: null });
  };

  const side = (id: string, which: 'a' | 'b', name: string, date: string | null, claim: string, extra = ''): N2Side => {
    const title = `${pick(which === 'a' ? SOURCES_A : SOURCES_B, r)}: ${name}`;
    const body = [`${title}.`, extra, claim, pick(FILLER, r)].filter(Boolean).join(' ');
    return { slug: `notes/n2-${id}-${which}`, title, date, claim, body };
  };

  let n = 0;
  const push = (kind: N2Kind, variant: N2Variant, entity: string, attribute: string, query: string, a: N2Side, b: N2Side, older: 'a' | 'b' | null) => {
    const item: N2Item = { id: `i${pad(++n)}`, kind, variant, gold_class: KIND_CLASS[kind], older_side: older, entity, attribute, query, a, b };
    for (const s of [a, b]) {
      if (!s.body.includes(s.claim)) throw new Error(`presence: claim missing from ${s.slug}`);
      if (!renderN2Page(s).includes(s.claim)) throw new Error(`presence: claim missing from rendered ${s.slug}`);
      pages.push({ slug: s.slug, title: s.title, date: s.date, body: s.body, item: item.id });
    }
    items.push(item);
  };
  const nextId = () => `i${pad(n + 1)}`;
  const day = () => Math.floor(r() * 500);

  // same_time_conflict: variants round-robin.
  const stVariants: N2Variant[] = ['dated_same_day', 'undated', 'mixed_dated'];
  for (let i = 0; i < counts.same_time_conflict; i++) {
    const variant = stVariants[i % 3];
    const attr = ATTRS[i % ATTRS.length];
    const name = companyName(newHead());
    profile(name, attr.key);
    const v1 = attr.value(r, vals(attr.key));
    const v2 = attr.value(r, vals(attr.key));
    const d = isoDay(base, day());
    const id = nextId();
    const asOf = `As of ${monthDay(d)}:`;
    let a: N2Side;
    let b: N2Side;
    if (variant === 'dated_same_day') {
      a = side(id, 'a', name, d, attr.sentence(name, v1));
      b = side(id, 'b', name, d, attr.sentence(name, v2));
    } else if (variant === 'undated') {
      a = side(id, 'a', name, null, attr.sentence(name, v1));
      b = side(id, 'b', name, null, attr.sentence(name, v2));
    } else {
      a = side(id, 'a', name, d, `${asOf} ${attr.sentence(name, v1)}`);
      b = side(id, 'b', name, null, `${asOf} ${attr.sentence(name, v2)}`);
    }
    push('same_time_conflict', variant, name, attr.key, attr.question(name), a, b, null);
  }

  // dated_change: the older value first, the newer at least 90 days later.
  const dcVariants: N2Variant[] = ['frontmatter_dates', 'text_dates', 'regression'];
  const numeric = ATTRS.filter(a => a.numeric);
  for (let i = 0; i < counts.dated_change; i++) {
    const variant = dcVariants[i % 3];
    const attr = variant === 'regression' ? numeric[i % numeric.length] : ATTRS[i % ATTRS.length];
    const name = companyName(newHead());
    profile(name, attr.key);
    const old = attr.value(r, vals(attr.key));
    const neu = variant === 'regression' ? unique(vals(attr.key), () => smaller(old, r)) : (attr.numeric ? unique(vals(attr.key), () => larger(old, r)) : attr.value(r, vals(attr.key)));
    const o1 = day();
    const d1 = isoDay(base, o1);
    const d2 = isoDay(base, o1 + 120 + Math.floor(r() * 200));
    const id = nextId();
    const flip = r() < 0.5;
    let older: N2Side;
    let newer: N2Side;
    if (variant === 'text_dates') {
      older = side(id, flip ? 'b' : 'a', name, null, `As of ${monthDay(d1)}: ${attr.sentence(name, old)}`);
      newer = side(id, flip ? 'a' : 'b', name, null, `As of ${monthDay(d2)}: ${attr.changed(name, neu)}`);
    } else {
      older = side(id, flip ? 'b' : 'a', name, d1, attr.sentence(name, old));
      newer = side(id, flip ? 'a' : 'b', name, d2, attr.changed(name, neu));
    }
    const [a, b] = flip ? [newer, older] : [older, newer];
    push('dated_change', variant, name, attr.key, attr.question(name), a, b, flip ? 'b' : 'a');
  }

  // holder_opinion: two different people, opposite subjective views, same date.
  for (let i = 0; i < counts.holder_opinion; i++) {
    const [topic, x, y] = OPINIONS[i % OPINIONS.length];
    const name = companyName(newHead());
    profile(name, '');
    const p1 = `${pick(FIRST, r)} ${pick(LAST, r)}-Example`;
    let p2 = `${pick(FIRST, r)} ${pick(LAST, r)}-Example`;
    while (p2 === p1) p2 = `${pick(FIRST, r)} ${pick(LAST, r)}-Example`;
    const d = isoDay(base, day());
    const id = nextId();
    const a = side(id, 'a', name, d, `${p1} thinks the ${topic} of ${name} is ${x}.`);
    const b = side(id, 'b', name, d, `${p2} thinks the ${topic} of ${name} is ${y}.`);
    push('holder_opinion', 'plain', name, `opinion:${topic}`, `What do people think about the ${topic} of ${name}?`, a, b, null);
  }

  // agreement: same value, different words, same date.
  for (let i = 0; i < counts.agreement; i++) {
    const attr = ATTRS[i % ATTRS.length];
    const name = companyName(newHead());
    profile(name, attr.key);
    const v = attr.value(r, vals(attr.key));
    const d = isoDay(base, day());
    const id = nextId();
    push('agreement', 'plain', name, attr.key, attr.question(name), side(id, 'a', name, d, attr.sentence(name, v)), side(id, 'b', name, d, attr.restate(name, v)), null);
  }

  // namesake: same attribute, two different companies sharing a head word.
  for (let i = 0; i < counts.namesake; i++) {
    const attr = ATTRS[i % ATTRS.length];
    const head = newHead();
    const [s1, s2] = [SECTORS[i % SECTORS.length], SECTORS[(i + 3) % SECTORS.length]];
    const n1 = companyName(head, s1);
    const n2 = companyName(head, s2);
    profile(n1, attr.key);
    profile(n2, attr.key);
    const d = isoDay(base, day());
    const id = nextId();
    push('namesake', 'plain', n1, attr.key, attr.question(n1),
      side(id, 'a', n1, d, attr.sentence(n1, attr.value(r, vals(attr.key)))), side(id, 'b', n2, d, attr.sentence(n2, attr.value(r, vals(attr.key)))), null);
  }

  // negation: one fund is not leading, another is.
  const usedFunds = new Set<string>();
  for (let i = 0; i < counts.negation; i++) {
    const name = companyName(newHead());
    profile(name, '');
    const f1 = unique(usedFunds, () => `Fund ${pick(BIRDS, r)} ${pick(SECTORS, r)} Example`);
    const f2 = unique(usedFunds, () => `Fund ${pick(BIRDS, r)} ${pick(SECTORS, r)} Example`);
    const d = isoDay(base, day());
    const id = nextId();
    push('negation', 'plain', name, 'lead_investor', `Who is leading the Series A of ${name}?`,
      side(id, 'a', name, d, `${f1} is not leading the ${name} Series A.`), side(id, 'b', name, d, `${f2} is leading the ${name} Series A.`), null);
  }

  const ledger: N2Ledger = { generator_version: N2_GENERATOR_VERSION, seed, items, pages };
  return { ledger, fingerprint: n2Fingerprint(ledger) };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function n2Fingerprint(ledger: N2Ledger): string {
  return createHash('sha256').update(canonical(ledger)).digest('hex');
}

// ─── Oracle ─────────────────────────────────────────────────────────────

export type PairGold =
  | { planted: true; item: string; kind: N2Kind; variant: N2Variant; gold_class: GoldClass; older_slug: string | null }
  | { planted: false; gold_class: 'compatible' };

export const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/**
 * Gold for an unordered pair of chunks, from the ledger alone. A pair is the
 * planted item only when its slugs are the item's two pages AND each chunk
 * text carries its side's claim span (independent spans); anything else is
 * compatible by construction.
 */
export function n2Gold(ledger: N2Ledger): (a: { slug: string; text: string }, b: { slug: string; text: string }) => PairGold {
  const bySlugs = new Map(ledger.items.map(it => [pairKey(it.a.slug, it.b.slug), it]));
  return (a, b) => {
    const it = bySlugs.get(pairKey(a.slug, b.slug));
    if (!it) return { planted: false, gold_class: 'compatible' };
    const side = (s: { slug: string; text: string }) => (s.slug === it.a.slug ? it.a : it.b);
    if (!a.text.includes(side(a).claim) || !b.text.includes(side(b).claim)) return { planted: false, gold_class: 'compatible' };
    return { planted: true, item: it.id, kind: it.kind, variant: it.variant, gold_class: it.gold_class, older_slug: it.older_side ? it[it.older_side].slug : null };
  };
}

if (import.meta.main) {
  const g = generateN2World();
  const by: Record<string, number> = {};
  for (const it of g.ledger.items) by[`${it.kind}/${it.variant}`] = (by[`${it.kind}/${it.variant}`] ?? 0) + 1;
  process.stdout.write(JSON.stringify({ fingerprint: g.fingerprint, items: g.ledger.items.length, pages: g.ledger.pages.length, by }, null, 2) + '\n');
}
