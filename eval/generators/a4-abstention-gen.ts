/**
 * A4 abstention world generator and answerability oracle.
 *
 * `generateA4World(seed)` writes fictional companies, each with a profile
 * page (`companies/<slug>`, titled with the company name) stating some
 * attributes, plus diligence notes that state one more attribute each. It
 * then asks one question per item about one attribute of one company.
 *
 * Question classes (gold from the ledger, never from gbrain):
 *   answerable_profile    the attribute is on the company's profile page
 *   answerable_note       the attribute is only in a diligence note
 *   missing_attribute     the company exists, the attribute is written for
 *                         other companies but never for this one (the
 *                         exact-entity negative: an exact title match with
 *                         no answer-bearing text)
 *   sibling_attribute     the company lacks the attribute but a different
 *                         company sharing its head word has it (answering
 *                         with the sibling's value is a wrong-source answer)
 *   absent_entity         no page names the company at all
 *
 * Every attribute value is unique across the world, so a reader's answer can
 * be matched to the exact company it came from. The oracle evidence for a
 * question is fixed here too: the page that states the answer for
 * answerable questions, and the matched nearest page(s) for unanswerable
 * ones (the company's own profile; for sibling questions also the sibling's
 * page that states the attribute; for absent companies the profile of an
 * existing company that has the attribute).
 *
 * All names are fictional placeholders ending in "Example".
 */
import { createHash } from 'node:crypto';

export const A4_GENERATOR_VERSION = 'a4-abstention-gen/1.0.0';
export const A4_DEFAULT_SEED = 20261001;

export type A4Class = 'answerable_profile' | 'answerable_note' | 'missing_attribute' | 'sibling_attribute' | 'absent_entity';
export const ANSWERABLE_CLASSES: readonly A4Class[] = ['answerable_profile', 'answerable_note'];
export const isAnswerable = (c: A4Class) => ANSWERABLE_CLASSES.includes(c);

export interface A4Page { slug: string; title: string; type: 'company' | 'note'; body: string; entity: string; facts: Array<{ attribute: string; value: string }> }
export interface A4Question {
  id: string;
  cls: A4Class;
  entity: string;
  attribute: string;
  question: string;
  /** Gold answer (answerable only). */
  answer: string | null;
  /** The page that states the answer (answerable only). */
  answer_slug: string | null;
  /** The sibling company's value, when the class is sibling_attribute. */
  sibling_value: string | null;
  /** Pages handed to the reader in the matched oracle-evidence control. */
  oracle_slugs: string[];
}
export interface A4Ledger { generator_version: string; seed: number; pages: A4Page[]; questions: A4Question[]; values: Record<string, string[]> }
export interface GeneratedA4 { ledger: A4Ledger; fingerprint: string }

export const A4_DEFAULT_COUNTS: Readonly<Record<A4Class, number>> = {
  answerable_profile: 60, answerable_note: 60, missing_attribute: 50, sibling_attribute: 40, absent_entity: 30,
};

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
const pick = <T>(xs: readonly T[], r: () => number): T => xs[Math.floor(r() * xs.length)];
function unique(used: Set<string>, make: () => string): string {
  for (let i = 0; i < 10_000; i++) {
    const v = make();
    if (!used.has(v)) { used.add(v); return v; }
  }
  throw new Error('value space exhausted');
}

const HEADS = ['Ast', 'Bel', 'Cav', 'Dor', 'Elm', 'Fal', 'Gav', 'Hel', 'Isk', 'Jov', 'Kar', 'Lev', 'Mav', 'Nor', 'Ober', 'Pax', 'Quor', 'Ril', 'Siv', 'Tor'];
const TAILS = ['anth', 'ello', 'imar', 'osk', 'urne', 'avel', 'endra', 'ox', 'ippa', 'umbra', 'ethe', 'ardo', 'ilia', 'onde', 'uvio', 'aska'];
const SECTORS = ['Labs', 'Health', 'Grid', 'Freight', 'Robotics', 'Foods', 'Analytics', 'Marine'];
const CITY_HEADS = ['Wend', 'Ashb', 'Corr', 'Dals', 'Elsw', 'Firth', 'Glenc', 'Hart', 'Ingle', 'Kirk', 'Lynd', 'Mosk', 'Penr', 'Rusk', 'Selb', 'Thorn'];
const CITY_TAILS = ['oria', 'ham', 'ington', 'ovar', 'erby', 'mund', 'ivale', 'stow', 'akeld', 'urgh', 'enna', 'olme', 'aby', 'ecote', 'ister', 'uven'];
const FIRST = ['Agnes', 'Basil', 'Cora', 'Dario', 'Edda', 'Felix', 'Gilda', 'Henrik', 'Iris', 'Jasper', 'Klara', 'Lucan', 'Mila', 'Nestor', 'Opal', 'Piers', 'Rhea', 'Soren', 'Tamsin', 'Ulric'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LAST = ['Arden', 'Bloch', 'Crane', 'Dahl', 'Ekberg', 'Fenn', 'Gault', 'Hale', 'Ivers', 'Jekel', 'Kemp', 'Lowe'];

interface Attr { key: string; question: (e: string) => string; value: (r: () => number) => string; sentence: (e: string, v: string) => string }
export const A4_ATTRS: readonly Attr[] = [
  { key: 'hq', question: e => `Which city is ${e} headquartered in?`, value: r => `${pick(CITY_HEADS, r)}${pick(CITY_TAILS, r)}`, sentence: (e, v) => `${e} is headquartered in ${v}.` },
  { key: 'ceo', question: e => `Who is the CEO of ${e}?`, value: r => `${pick(FIRST, r)} ${pick(LAST, r)}-Example`, sentence: (e, v) => `The CEO of ${e} is ${v}.` },
  { key: 'founded', question: e => `When was ${e} founded?`, value: r => `${MONTHS[Math.floor(r() * 12)]} ${1961 + Math.floor(r() * 64)}`, sentence: (e, v) => `${e} was founded in ${v}.` },
  { key: 'headcount', question: e => `How many employees does ${e} have?`, value: r => `${30 + Math.floor(r() * 2900)} employees`, sentence: (e, v) => `${e} has ${v}.` },
  { key: 'runway', question: e => `How many months of runway does ${e} have?`, value: r => `${7 + Math.floor(r() * 200)} months of runway`, sentence: (e, v) => `${e} has ${v} at current burn.` },
  { key: 'arr', question: e => `What is the annual recurring revenue of ${e}?`, value: r => `$${(0.5 + Math.floor(r() * 990) / 10).toFixed(1)}M ARR`, sentence: (e, v) => `${e} reports ${v}.` },
];
const ATTR = new Map(A4_ATTRS.map(a => [a.key, a]));

const pad = (n: number, w = 3) => String(n).padStart(w, '0');
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function renderA4Page(p: Pick<A4Page, 'title' | 'type' | 'body'>): string {
  return `---\ntype: ${p.type}\ntitle: ${p.title}\n---\n${p.body}\n`;
}

export function generateA4World(opts: { seed?: number; counts?: Partial<Record<A4Class, number>> } = {}): GeneratedA4 {
  const seed = opts.seed ?? A4_DEFAULT_SEED;
  const counts = { ...A4_DEFAULT_COUNTS, ...opts.counts };
  const r = mulberry32(seed);
  const names = new Set<string>();
  const used = new Map(A4_ATTRS.map(a => [a.key, new Set<string>()]));
  const value = (k: string) => unique(used.get(k)!, () => ATTR.get(k)!.value(r));
  const pages: A4Page[] = [];
  const questions: A4Question[] = [];
  const profiles = new Map<string, A4Page>();
  let q = 0;

  const head = () => unique(names, () => `${pick(HEADS, r)}${pick(TAILS, r)}`);
  const company = (name: string, attrs: readonly string[], noteAttrs: readonly string[] = []) => {
    const facts = attrs.map(a => ({ attribute: a, value: value(a) }));
    const body = [`${name} is a fictional company in the A4 abstention world.`, ...facts.map(f => ATTR.get(f.attribute)!.sentence(name, f.value))].join(' ');
    const p: A4Page = { slug: `companies/${slugify(name)}`, title: name, type: 'company', body, entity: name, facts };
    pages.push(p);
    profiles.set(name, p);
    const notes = noteAttrs.map(a => {
      const f = { attribute: a, value: value(a) };
      const n: A4Page = { slug: `notes/a4-${slugify(name)}-${a}`, title: `Diligence note: ${name}`, type: 'note', entity: name, facts: [f],
        body: `Diligence note on ${name}. ${ATTR.get(a)!.sentence(name, f.value)} The remaining questions go to the next partner meeting.` };
      pages.push(n);
      return n;
    });
    return { profile: p, notes };
  };
  const others = (k: string) => A4_ATTRS.map(a => a.key).filter(x => x !== k);
  const shuffled = <T>(xs: readonly T[]) => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  };
  const add = (cls: A4Class, entity: string, attribute: string, answer: string | null, answerSlug: string | null, oracle: string[], sibling: string | null = null) => {
    questions.push({ id: `q${pad(++q)}`, cls, entity, attribute, question: ATTR.get(attribute)!.question(entity), answer, answer_slug: answerSlug, sibling_value: sibling, oracle_slugs: oracle });
  };

  for (let i = 0; i < counts.answerable_profile; i++) {
    const k = A4_ATTRS[i % A4_ATTRS.length].key;
    const name = `${head()} Example`;
    const { profile } = company(name, [k, ...shuffled(others(k)).slice(0, 2)]);
    add('answerable_profile', name, k, profile.facts[0].value, profile.slug, [profile.slug]);
  }
  for (let i = 0; i < counts.answerable_note; i++) {
    const k = A4_ATTRS[i % A4_ATTRS.length].key;
    const name = `${head()} Example`;
    const { notes } = company(name, shuffled(others(k)).slice(0, 2), [k]);
    add('answerable_note', name, k, notes[0].facts[0].value, notes[0].slug, [notes[0].slug]);
  }
  for (let i = 0; i < counts.missing_attribute; i++) {
    const k = A4_ATTRS[i % A4_ATTRS.length].key;
    const name = `${head()} Example`;
    const { profile } = company(name, shuffled(others(k)).slice(0, 3));
    add('missing_attribute', name, k, null, null, [profile.slug]);
  }
  for (let i = 0; i < counts.sibling_attribute; i++) {
    const k = A4_ATTRS[i % A4_ATTRS.length].key;
    const h = head();
    const [s1, s2] = [SECTORS[i % SECTORS.length], SECTORS[(i + 3) % SECTORS.length]];
    const asked = `${h} ${s1} Example`;
    const sib = `${h} ${s2} Example`;
    const mine = company(asked, shuffled(others(k)).slice(0, 2));
    const theirs = company(sib, [k, ...shuffled(others(k)).slice(0, 1)]);
    add('sibling_attribute', asked, k, null, null, [mine.profile.slug, theirs.profile.slug], theirs.profile.facts[0].value);
  }
  const holders = (k: string) => [...profiles.values()].filter(p => p.facts.some(f => f.attribute === k));
  for (let i = 0; i < counts.absent_entity; i++) {
    const k = A4_ATTRS[i % A4_ATTRS.length].key;
    const name = `${head()} Example`;
    const near = holders(k);
    add('absent_entity', name, k, null, null, [pick(near, r).slug]);
  }

  for (const qq of questions) {
    if (qq.answer && !pages.find(p => p.slug === qq.answer_slug)!.body.includes(qq.answer)) throw new Error(`presence: ${qq.id} answer missing from ${qq.answer_slug}`);
    if (qq.cls === 'absent_entity' && pages.some(p => p.body.includes(qq.entity))) throw new Error(`absent entity ${qq.entity} is written`);
    if (!isAnswerable(qq.cls) && pages.some(p => p.entity === qq.entity && p.facts.some(f => f.attribute === qq.attribute))) throw new Error(`${qq.id}: unanswerable attribute is written`);
  }
  const values = Object.fromEntries([...used].map(([k, s]) => [k, [...s].sort()]));
  const ledger: A4Ledger = { generator_version: A4_GENERATOR_VERSION, seed, pages, questions, values };
  return { ledger, fingerprint: a4Fingerprint(ledger) };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export function a4Fingerprint(ledger: A4Ledger): string {
  return createHash('sha256').update(canonical(ledger)).digest('hex');
}

if (import.meta.main) {
  const g = generateA4World();
  const by: Record<string, number> = {};
  for (const x of g.ledger.questions) by[x.cls] = (by[x.cls] ?? 0) + 1;
  process.stdout.write(JSON.stringify({ fingerprint: g.fingerprint, pages: g.ledger.pages.length, questions: g.ledger.questions.length, by }, null, 2) + '\n');
}
