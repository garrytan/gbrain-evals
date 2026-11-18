/**
 * Person-dedupe world generator (registry id `person-dedupe`).
 *
 * Writes a seeded world of person pages in two sources, where every page
 * belongs to one invented person and the ledger records which. The cases are
 * the hard ones the entity-resolution literature names: the same name on
 * different people (alone, at the same company, in the same city, behind a
 * shared team or family address, across sources with the same slug), and the
 * same person written differently (case and spacing, diacritics,
 * transliteration, name order, nicknames, initials, a married name, several
 * emails, a duplicate inside one source).
 *
 * Colleague pages (the extra holders of a team address) are scored only in
 * the whole-world metrics; the designed pair in those families is the two
 * namesakes. Each case instance gets names no other instance uses, so a designed pair is
 * independent of the rest of the world. Gold is never read from a system: a
 * page's person id is the label, and deriveGold checks that every designed
 * pair's label agrees with the family it came from.
 *
 * Pure: no gbrain import, no I/O.
 */
import { createHash } from 'node:crypto';

export const PERSON_DEDUPE_GENERATOR_VERSION = 2;
export const PERSON_DEDUPE_DEFAULT_SEED = 20261117;
export const PERSON_DEDUPE_DEFAULT_PER_FAMILY = 20;
export const DECLARED_PERSON_ID_FIELD = 'external_id';
export const SOURCES = ['work', 'home'] as const;
export type SourceId = typeof SOURCES[number];

export type Label = 'same' | 'different';

export interface Family {
  id: string;
  label: Label;
  description: string;
}

const V1_FAMILIES: readonly Family[] = [
  { id: 'same-exact', label: 'same', description: 'one person in two sources: same name, same email' },
  { id: 'same-case-space', label: 'same', description: 'one person; the name differs only in case, spacing or a full stop' },
  { id: 'same-diacritics', label: 'same', description: 'one person; one page drops the accents (Núñez, Nunez)' },
  { id: 'same-transliteration', label: 'same', description: 'one person; two romanizations of the given name (Aleksandr, Alexander)' },
  { id: 'same-name-order', label: 'same', description: 'one person; family name first on one page (Zhang Wei, Wei Zhang)' },
  { id: 'same-nickname', label: 'same', description: 'one person; a nickname on one page (Robert, Bob)' },
  { id: 'same-initial', label: 'same', description: 'one person; given name as an initial on one page (M. Reeves)' },
  { id: 'same-married-name', label: 'same', description: 'one person; maiden name on one page, married name on the other, same email' },
  { id: 'same-email-bridge', label: 'same', description: 'one person with two emails; one page lists both, the other only the personal one' },
  { id: 'same-disjoint-emails', label: 'same', description: 'one person; each page has a different email, so only the name is shared' },
  { id: 'same-role-address', label: 'same', description: 'one person who runs a one-person studio; the only email on both pages is hello@ at the studio' },
  { id: 'same-within-source', label: 'same', description: 'one person written twice inside one source (people/x and people/x-2)' },
  { id: 'diff-namesake', label: 'different', description: 'two people with the same name, different emails, company and city' },
  { id: 'diff-namesake-same-company', label: 'different', description: 'two people with the same name at the same company, different emails' },
  { id: 'diff-namesake-same-city', label: 'different', description: 'two people with the same name in the same city, different emails and companies' },
  { id: 'diff-namesake-cross-source-slug', label: 'different', description: 'two people with the same name and the same slug, one in each source, nothing else shared' },
  { id: 'diff-namesake-team-alias', label: 'different', description: 'two people with the same name at one company who both list the team address' },
  { id: 'diff-namesake-family-email', label: 'different', description: 'parent and child with the same name who both list the family email' },
  { id: 'diff-assistant-email', label: 'different', description: 'an executive whose page lists the assistant\'s email, and the assistant' },
  { id: 'diff-shared-mailbox', label: 'different', description: 'two colleagues with different names who both list the support mailbox' },
  { id: 'diff-nickname-lookalike', label: 'different', description: 'two people at one company whose names look like nickname variants (Jon Park, John Park), different emails' },
  { id: 'diff-initial-lookalike', label: 'different', description: 'two people at one company who share an initial and surname (M. Reeves is Mira, not Maya), different emails' },
  { id: 'diff-namesake-alias-on-5', label: 'different', description: 'two people with the same name, one per source, who share a team address with three colleagues (the address is on exactly five pages)' },
  { id: 'diff-namesake-alias-on-6', label: 'different', description: 'the same, with the address on six pages (past the finder\'s five-page cutoff, so it is not a key)' },
  { id: 'diff-jr-suffix', label: 'different', description: 'a parent and child whose names differ only by Jr, sharing the family email, one per source' },
  { id: 'diff-namesake-placeholder-email', label: 'different', description: 'two people with the same name, one per source, whose only email is a placeholder (unknown, n/a, none)' },
  { id: 'diff-namesake-household-plain', label: 'different', description: 'a parent and child with the same name and no suffix, one per source, sharing a household email with no role or household word in it (thesatos7@)' },
  { id: 'diff-namesake-offlist-alias', label: 'different', description: 'two colleagues with the same name, one per source, sharing a team alias whose words are not on the role list (bluebirds@)' },
  { id: 'diff-bridge-page', label: 'different', description: 'two people with the same name in one source, one with a GitHub login and one with a LinkedIn profile, and a third page (the first person\'s, in the other source) that carries both, the LinkedIn copied by mistake' },
  { id: 'diff-transitive-chain', label: 'different', description: 'A and B are one person (same name, same email); C has the same name and shares only the team address with B' },
];

const SHARED_ID_FAMILIES: readonly Family[] = [
  { id: 'diff-recycled-github', label: 'different', description: 'Two dated rosters show one GitHub login: a namesake took it after the first owner deleted the account. Both people do similar work, so the change looks like an ordinary profile update. Some rosters instead track the same owner.' },
  { id: 'diff-wrong-linkedin', label: 'different', description: 'A contact in a second source gets a LinkedIn URL copied from a namesake, with no second profile to contradict it. The people work in the same area. In controls the copied link goes to the right person.' },
  { id: 'diff-declared-id-typo', label: 'different', description: 'Two nearby CRM records have ids that differ by a digit swap. A handwritten import transposes the id onto a similar-looking contact, so the only account id agrees. In controls the id is copied without error.' },
  { id: 'diff-shared-github-account', label: 'different', description: 'Project maintainers list the same organisation or release account as their GitHub login. Two are namesakes or look like namesakes, and one is also listed twice across sources.' },
];

export const FAMILIES: readonly Family[] = [...V1_FAMILIES, ...SHARED_ID_FAMILIES];
export const MIXED_FAMILIES: ReadonlySet<string> = new Set(['diff-transitive-chain', 'diff-bridge-page', ...SHARED_ID_FAMILIES.map(f => f.id)]);

export const FAMILY_BY_ID: ReadonlyMap<string, Family> = new Map(FAMILIES.map(f => [f.id, f]));

export interface LedgerPage {
  source: SourceId;
  slug: string;
  /** The true person behind the page. Never rendered. */
  person: string;
  family: string;
  instance: number;
  title: string;
  emails: string[];
  /** A LinkedIn profile URL or a GitHub handle; see the key-coverage note in generateLedger. */
  linkedin: string | null;
  github: string | null;
  external_id?: string;
  company: string | null;
  city: string | null;
  body: string;
}

export interface DesignedPair {
  a: string;
  b: string;
  family: string;
  instance: number;
  label: Label;
}

export interface Ledger {
  seed: number;
  per_family: number;
  generator_version: number;
  sources: readonly SourceId[];
  pages: LedgerPage[];
  pairs: DesignedPair[];
}

// Invented name combinations; no real person is intended.
const GIVEN = ['Maya', 'Daniel', 'Priya', 'Tomas', 'Lena', 'Omar', 'Ines', 'Hugo', 'Nadia', 'Felix', 'Rosa', 'Kenji', 'Amara', 'Lucas', 'Sofia', 'Idris', 'Clara', 'Mateo', 'Yara', 'Elias', 'Noor', 'Anton', 'Leila', 'Ravi', 'Greta', 'Samir', 'Iris', 'Pavel', 'Mira', 'Theo'];
const SURNAME = ['Reeves', 'Okafor', 'Lindqvist', 'Moreau', 'Halloran', 'Castell', 'Brandt', 'Sato', 'Varga', 'Quinlan', 'Abara', 'Feld', 'Marsh', 'Ostrow', 'Pell', 'Rasku', 'Tamsin', 'Ulloa', 'Wexford', 'Yilmaz', 'Corrigan', 'Dahl', 'Esposito', 'Galloway', 'Hartigan', 'Ibsen', 'Kowal', 'Lorne', 'Mabry', 'Nakata', 'Orsini', 'Prior', 'Rhee', 'Strand', 'Teague', 'Vance', 'Whitlow', 'Zeller', 'Ahn', 'Bly'];
const DIACRITIC_SURNAMES: ReadonlyArray<readonly [string, string]> = [['Núñez', 'Nunez'], ['Müller', 'Muller'], ['Øster', 'Oster'], ['Gonçalves', 'Goncalves'], ['Dvořák', 'Dvorak'], ['Søndergaard', 'Sondergaard'], ['Ibáñez', 'Ibanez'], ['Šimek', 'Simek'], ['Ståhl', 'Stahl'], ['Lefèvre', 'Lefevre'], ['Köhler', 'Kohler'], ['Peña', 'Pena']];
const TRANSLIT_GIVEN: ReadonlyArray<readonly [string, string]> = [['Aleksandr', 'Alexander'], ['Yevgeny', 'Evgeny'], ['Sergei', 'Sergey'], ['Mohammed', 'Muhammad'], ['Dmitri', 'Dmitry'], ['Yuliya', 'Julia'], ['Andrei', 'Andrey'], ['Natalya', 'Natalia'], ['Fyodor', 'Fedor'], ['Mikhail', 'Michail'], ['Ksenia', 'Xenia'], ['Yusuf', 'Youssef']];
const EAST_ASIAN_FAMILY = ['Zhang', 'Wang', 'Chen', 'Liu', 'Huang', 'Zhao', 'Zhou', 'Xu', 'Sun', 'Guo', 'Luo', 'Song'];
const EAST_ASIAN_GIVEN = ['Wei', 'Fang', 'Jie', 'Yang', 'Min', 'Lei', 'Hui', 'Xin', 'Ming', 'Tao', 'Jing', 'Qiang'];
/** Formal given name and a common English nickname for it. */
export const NICKNAMES: ReadonlyArray<readonly [string, string]> = [['Robert', 'Bob'], ['William', 'Bill'], ['Elizabeth', 'Liz'], ['Katherine', 'Kate'], ['Alexander', 'Alex'], ['Michael', 'Mike'], ['Margaret', 'Peggy'], ['James', 'Jim'], ['Richard', 'Rick'], ['Jennifer', 'Jen'], ['Thomas', 'Tom'], ['Rebecca', 'Becky'], ['Joseph', 'Joe'], ['Patricia', 'Trish'], ['Edward', 'Ted'], ['Susan', 'Sue'], ['Christopher', 'Chris'], ['Victoria', 'Vicky'], ['Benjamin', 'Ben'], ['Abigail', 'Abby'], ['Jonathan', 'Jon'], ['Nicholas', 'Nick'], ['Samantha', 'Sam'], ['Daniel', 'Dan']];
const LOOKALIKE_GIVEN: ReadonlyArray<readonly [string, string]> = [['Jon', 'John'], ['Kate', 'Katie'], ['Dan', 'Danny'], ['Alex', 'Alexa'], ['Chris', 'Christa'], ['Sam', 'Samuel'], ['Ben', 'Benny'], ['Nick', 'Nicky'], ['Tom', 'Tomas'], ['Jen', 'Jenna'], ['Will', 'Willa'], ['Max', 'Maxine']];
const COMPANIES = ['Acme Robotics', 'Bluefin Labs', 'Cobalt Health', 'Driftwood Capital', 'Ember Foods', 'Fathom Analytics', 'Granite Logistics', 'Harbor Bio', 'Ionic Studio', 'Juniper Legal', 'Kestrel Air', 'Lumen Schools', 'Meridian Energy', 'Northwind Media', 'Orchid Retail', 'Pioneer Grid'];
const CITIES = ['Portland', 'Austin', 'Denver', 'Raleigh', 'Tucson', 'Madison', 'Boise', 'Savannah', 'Spokane', 'Duluth', 'Lisbon', 'Leeds', 'Lyon', 'Graz', 'Malmo', 'Porto'];
const MAIL = 'mail.example';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Strips accents and folds the letters NFKD leaves alone (ø, ß). */
export function asciiFold(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ø/g, 'o').replace(/Ø/g, 'O').replace(/ß/g, 'ss');
}

export function slugify(name: string): string {
  return asciiFold(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const compact = (s: string) => slugify(s).replace(/-/g, '');

export function pageKey(p: { source: string; slug: string }): string {
  return `${p.source}:${p.slug}`;
}

class Names {
  private used = new Set<string>();
  constructor(private next: () => number) {}
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  claim(fullName: string): boolean {
    const k = slugify(fullName);
    if (this.used.has(k)) return false;
    this.used.add(k);
    return true;
  }
  /** A given name and surname no other instance has used; make() proposes candidates. */
  fresh(make: () => { given: string; surname: string } = () => ({ given: this.pick(GIVEN), surname: this.pick(SURNAME) })): { given: string; surname: string } {
    for (let i = 0; i < 10_000; i++) {
      const n = make();
      if (this.claim(`${n.given} ${n.surname}`)) return n;
    }
    throw new Error('person-dedupe: name pool exhausted');
  }
}

export function exclusiveIdSuffix(seed: number, version: number, id: string): string {
  return createHash('sha256').update(JSON.stringify([seed, version, id])).digest('hex').slice(0, 16);
}

export function generateLedger(seed: number = PERSON_DEDUPE_DEFAULT_SEED, perFamily: number = PERSON_DEDUPE_DEFAULT_PER_FAMILY, version = PERSON_DEDUPE_GENERATOR_VERSION): Ledger {
  if (version !== 1 && version !== PERSON_DEDUPE_GENERATOR_VERSION) throw new Error(`person-dedupe: unknown generator version ${version}`);
  const next = mulberry32(seed);
  const names = new Names(next);
  const pages: LedgerPage[] = [];
  const pairs: DesignedPair[] = [];
  const slugsBySource = new Map<SourceId, Set<string>>(SOURCES.map(s => [s, new Set<string>()]));
  const place = (source: SourceId, base: string): string => {
    const taken = slugsBySource.get(source)!;
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    return slug;
  };
  const other = <T>(items: readonly T[], not: T): T => {
    const rest = items.filter(x => x !== not);
    return rest[Math.floor(next() * rest.length)];
  };
  const num = () => String(10 + Math.floor(next() * 89));
  let shared = 0;

  for (const family of version === 1 ? V1_FAMILIES : FAMILIES) {
    for (let instance = 0; instance < perFamily; instance++) {
      const company = names.pick(COMPANIES);
      const otherCompany = other(COMPANIES, company);
      const city = names.pick(CITIES);
      const otherCity = other(CITIES, city);
      const domain = `${compact(company)}.example`;
      const tag = `${family.id}-${instance}`;
      const made: LedgerPage[] = [];
      const add = (person: string, source: SourceId, title: string, o: { emails: string[]; linkedin?: string; github?: string; external_id?: string; company?: string | null; city?: string | null; body?: string; slugBase?: string }) => {
        made.push({
          source, slug: place(source, o.slugBase ?? slugify(title)), person: `${tag}-${person}`, family: family.id, instance, title,
          emails: o.emails, linkedin: o.linkedin ?? null, github: o.github ?? null, company: o.company === undefined ? company : o.company, city: o.city === undefined ? city : o.city,
          ...(o.external_id ? { external_id: o.external_id } : {}),
          body: o.body ?? `${title.trim()} is a contact.`,
        });
      };
      const work = (g: string, s: string, n = '') => `${compact(g)}.${compact(s)}${n}@${domain}`;
      const home = (g: string, s: string) => `${compact(g)}.${compact(s)}${num()}@${MAIL}`;
      const team = (s: string) => `team-${compact(s)}${++shared}@${domain}`;

      switch (family.id) {
        case 'same-exact': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          add('p', 'work', name, { emails: [work(n.given, n.surname)] });
          add('p', 'home', name, { emails: [work(n.given, n.surname)], company: null });
          break;
        }
        case 'same-case-space': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const variants = [name.toLowerCase(), `${n.given}  ${n.surname}`, `${n.given.toUpperCase()} ${n.surname}`, `${name}.`];
          add('p', 'work', name, { emails: [work(n.given, n.surname)] });
          add('p', 'home', variants[instance % variants.length], { emails: [work(n.given, n.surname)], company: null, slugBase: slugify(name) });
          break;
        }
        case 'same-diacritics': {
          const n = names.fresh(() => ({ given: names.pick(GIVEN), surname: names.pick(DIACRITIC_SURNAMES)[0] }));
          const plain = DIACRITIC_SURNAMES.find(d => d[0] === n.surname)![1];
          add('p', 'work', `${n.given} ${n.surname}`, { emails: [work(n.given, plain)] });
          add('p', 'home', `${n.given} ${plain}`, { emails: [work(n.given, plain)], company: null });
          break;
        }
        case 'same-transliteration': {
          let roman = '';
          const n = names.fresh(() => { const [a, b] = names.pick(TRANSLIT_GIVEN); roman = b; return { given: a, surname: names.pick(SURNAME) }; });
          names.claim(`${roman} ${n.surname}`);
          add('p', 'work', `${n.given} ${n.surname}`, { emails: [work(roman, n.surname)] });
          add('p', 'home', `${roman} ${n.surname}`, { emails: [work(roman, n.surname)], company: null });
          break;
        }
        case 'same-name-order': {
          const n = names.fresh(() => ({ given: names.pick(EAST_ASIAN_GIVEN), surname: names.pick(EAST_ASIAN_FAMILY) }));
          names.claim(`${n.surname} ${n.given}`);
          const e = home(n.given, n.surname);
          add('p', 'work', `${n.surname} ${n.given}`, { emails: [e] });
          add('p', 'home', `${n.given} ${n.surname}`, { emails: [e], company: null });
          break;
        }
        case 'same-nickname': {
          let nick = '';
          const n = names.fresh(() => { const [f, k] = names.pick(NICKNAMES); nick = k; return { given: f, surname: names.pick(SURNAME) }; });
          names.claim(`${nick} ${n.surname}`);
          add('p', 'work', `${n.given} ${n.surname}`, { emails: [work(n.given, n.surname)] });
          add('p', 'home', `${nick} ${n.surname}`, { emails: [work(n.given, n.surname)], company: null });
          break;
        }
        case 'same-initial': {
          const n = names.fresh();
          add('p', 'work', `${n.given} ${n.surname}`, { emails: [work(n.given, n.surname)] });
          add('p', 'home', `${n.given[0]}. ${n.surname}`, { emails: [work(n.given, n.surname)], company: null });
          break;
        }
        case 'same-married-name': {
          const n = names.fresh();
          const married = names.fresh(() => ({ given: n.given, surname: names.pick(SURNAME) }));
          const e = home(n.given, n.surname);
          add('p', 'home', `${n.given} ${n.surname}`, { emails: [e], company: null });
          add('p', 'work', `${n.given} ${married.surname}`, { emails: [e], body: `${n.given} ${married.surname} (née ${n.surname}) is a contact.` });
          break;
        }
        case 'same-email-bridge': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const h = home(n.given, n.surname);
          add('p', 'work', name, { emails: [work(n.given, n.surname), h] });
          add('p', 'home', name, { emails: [h], company: null });
          break;
        }
        case 'same-disjoint-emails': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          add('p', 'work', name, { emails: [work(n.given, n.surname)] });
          add('p', 'home', name, { emails: [home(n.given, n.surname)] });
          break;
        }
        case 'same-role-address': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const e = `hello@${compact(n.surname)}studio${++shared}.example`;
          add('p', 'work', name, { emails: [e] });
          add('p', 'home', name, { emails: [e], company: null });
          break;
        }
        case 'same-within-source': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          add('p', 'work', name, { emails: [work(n.given, n.surname)] });
          add('p', 'work', name, { emails: [work(n.given, n.surname)], body: `Met ${name} again at the offsite.` });
          break;
        }
        case 'diff-namesake': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          add('a', 'work', name, { emails: [work(n.given, n.surname)] });
          add('b', 'home', name, { emails: [home(n.given, n.surname)], company: otherCompany, city: otherCity });
          break;
        }
        case 'diff-namesake-same-company': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          add('a', 'work', name, { emails: [work(n.given, n.surname)] });
          add('b', 'work', name, { emails: [work(n.given, n.surname, '2')], city: otherCity });
          break;
        }
        case 'diff-namesake-same-city': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          add('a', 'work', name, { emails: [work(n.given, n.surname)] });
          add('b', 'home', name, { emails: [home(n.given, n.surname)], company: otherCompany });
          break;
        }
        case 'diff-namesake-cross-source-slug': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          add('a', 'work', name, { emails: [work(n.given, n.surname)] });
          add('b', 'home', name, { emails: [home(n.given, n.surname)], company: null, city: otherCity });
          break;
        }
        case 'diff-namesake-team-alias': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const t = team(n.surname);
          add('a', 'work', name, { emails: [work(n.given, n.surname), t] });
          add('b', 'home', name, { emails: [work(n.given, n.surname, '2'), t], city: otherCity });
          break;
        }
        case 'diff-namesake-family-email': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const fam = `${compact(n.surname)}.family${++shared}@${MAIL}`;
          add('a', 'home', name, { emails: [fam], company: null, body: `${name} is a contact; the parent.` });
          add('b', 'work', name, { emails: [work(n.given, n.surname), fam], body: `${name} is a contact; the child.` });
          break;
        }
        case 'diff-assistant-email': {
          const exec = names.fresh();
          const asst = names.fresh();
          const ae = work(asst.given, asst.surname);
          add('exec', 'work', `${exec.given} ${exec.surname}`, { emails: [ae], body: `${exec.given} ${exec.surname}: book meetings through the assistant.` });
          add('asst', 'home', `${asst.given} ${asst.surname}`, { emails: [ae], body: `${asst.given} ${asst.surname} is an executive assistant.` });
          break;
        }
        case 'diff-shared-mailbox': {
          const a = names.fresh();
          const b = names.fresh();
          const box = `support${++shared}@${domain}`;
          add('a', 'work', `${a.given} ${a.surname}`, { emails: [box] });
          add('b', 'home', `${b.given} ${b.surname}`, { emails: [box, home(b.given, b.surname)] });
          break;
        }
        case 'diff-nickname-lookalike': {
          let second = '';
          const n = names.fresh(() => { const [g1, g2] = names.pick(LOOKALIKE_GIVEN); second = g2; return { given: g1, surname: names.pick(SURNAME) }; });
          names.claim(`${second} ${n.surname}`);
          add('a', 'work', `${n.given} ${n.surname}`, { emails: [work(n.given, n.surname)] });
          add('b', 'work', `${second} ${n.surname}`, { emails: [work(second, n.surname)], city: otherCity });
          break;
        }
        case 'diff-initial-lookalike': {
          let sibling = '';
          const n = names.fresh(() => {
            const g = names.pick(GIVEN.filter(x => GIVEN.some(y => y !== x && y[0] === x[0])));
            sibling = names.pick(GIVEN.filter(y => y !== g && y[0] === g[0]));
            return { given: g, surname: names.pick(SURNAME) };
          });
          names.claim(`${sibling} ${n.surname}`);
          add('a', 'work', `${sibling[0]}. ${n.surname}`, { emails: [work(sibling, n.surname)], body: `${sibling[0]}. ${n.surname} (${sibling}) is a contact.` });
          add('b', 'work', `${n.given} ${n.surname}`, { emails: [work(n.given, n.surname)], city: otherCity });
          break;
        }
        case 'diff-namesake-alias-on-5':
        case 'diff-namesake-alias-on-6': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const t = team(n.surname);
          add('a', 'work', name, { emails: [work(n.given, n.surname), t] });
          add('b', 'home', name, { emails: [work(n.given, n.surname, '2'), t], city: otherCity });
          const colleagues = family.id === 'diff-namesake-alias-on-5' ? 3 : 4;
          for (let c = 0; c < colleagues; c++) {
            const m = names.fresh();
            add(`colleague${c}`, 'work', `${m.given} ${m.surname}`, { emails: [work(m.given, m.surname), t] });
          }
          break;
        }
        case 'diff-jr-suffix': {
          const n = names.fresh();
          names.claim(`${n.given} ${n.surname} Jr`);
          const fam = `${compact(n.surname)}.family${++shared}@${MAIL}`;
          add('parent', 'home', `${n.given} ${n.surname}`, { emails: [fam], company: null });
          add('child', 'work', `${n.given} ${n.surname} Jr`, { emails: [fam, work(n.given, n.surname)] });
          break;
        }
        case 'diff-namesake-placeholder-email': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const placeholder = ['unknown', 'n/a', 'none', 'TBD'][instance % 4];
          add('a', 'work', name, { emails: [placeholder] });
          add('b', 'home', name, { emails: [placeholder], company: otherCompany, city: otherCity });
          break;
        }
        case 'diff-namesake-household-plain': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const house = `the${compact(n.surname)}s${++shared}@${MAIL}`;
          add('parent', 'home', name, { emails: [house], company: null });
          add('child', 'work', name, { emails: [work(n.given, n.surname), house] });
          break;
        }
        case 'diff-namesake-offlist-alias': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const alias = `${['bluebirds', 'platform-squad', 'nightowls', 'growth-crew'][instance % 4]}${++shared}@${domain}`;
          add('a', 'work', name, { emails: [work(n.given, n.surname), alias] });
          add('b', 'home', name, { emails: [work(n.given, n.surname, '2'), alias], city: otherCity });
          break;
        }
        case 'diff-bridge-page': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const gh = `${compact(name)}${++shared}`;
          const li = `https://www.linkedin.com/in/${compact(name)}-${++shared}`;
          add('a', 'work', name, { emails: [work(n.given, n.surname)], github: gh });
          add('b', 'work', name, { emails: [work(n.given, n.surname, '2')], linkedin: li, city: otherCity });
          add('a', 'home', name, { emails: [], github: gh, linkedin: li, company: null, body: `${name} is a contact. Profile links pasted from an old note.` });
          break;
        }
        case 'diff-transitive-chain': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const e = work(n.given, n.surname);
          add('ab', 'home', name, { emails: [e], company: null });
          const t = team(n.surname);
          add('ab', 'work', name, { emails: [e, t] });
          add('c', 'work', name, { emails: [work(n.given, n.surname, '2'), t], city: otherCity });
          break;
        }
        case 'diff-recycled-github': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const shortened = `${n.given[0]}. ${n.surname}`;
          const later = instance % 4 === 1 && names.claim(shortened) ? shortened : name;
          const github = `${compact(name)}-dev`;
          add('original', 'work', name, { emails: [], github, company: null, body: '2021 contributor roster: maintains test fixtures and reviews documentation changes.' });
          add(instance % 5 === 4 ? 'original' : 'later', 'home', later, { emails: [], github, company: null, body: '2025 contributor roster: updates test fixtures and reviews documentation changes.' });
          break;
        }
        case 'diff-wrong-linkedin': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const shortened = `${n.given[0]}. ${n.surname}`;
          const listed = instance % 4 === 2 && names.claim(shortened) ? shortened : name;
          const linkedin = `https://www.linkedin.example/in/${slugify(name)}`;
          add('owner', 'work', name, { emails: [], linkedin, body: `${name} is on the partner directory.` });
          add(instance % 5 === 4 ? 'owner' : 'other', 'home', listed, { emails: [], linkedin, body: `${listed} was added from a regional event list.` });
          break;
        }
        case 'diff-declared-id-typo': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const shortened = `${n.given[0]}. ${n.surname}`;
          const listed = instance % 4 === 3 && names.claim(shortened) ? shortened : name;
          const same = instance % 5 === 4;
          const batch = `crm-${exclusiveIdSuffix(seed, version, tag)}`;
          const [issuedA, issuedB] = [`${batch}-4817`, `${batch}-4871`];
          const imported = same ? issuedA : `${issuedB.slice(0, -2)}${issuedB.at(-1)}${issuedB.at(-2)}`;
          add('owner', 'work', name, { emails: [], external_id: issuedA, body: `${name} appears in the account directory.` });
          add(same ? 'owner' : 'other', 'home', listed, { emails: [], external_id: imported, body: `${listed} appears in the migrated contact list.` });
          break;
        }
        case 'diff-shared-github-account': {
          const n = names.fresh();
          const name = `${n.given} ${n.surname}`;
          const shortened = `${n.given[0]}. ${n.surname}`;
          const namesake = instance % 4 === 3 && names.claim(shortened) ? shortened : name;
          const github = `${instance % 2 === 0 ? 'releases' : 'engineering'}-${compact(company)}-${instance}`;
          add('maintainer', 'work', name, { emails: [], github, body: `${name} reviews changes for the project.` });
          add('maintainer', 'home', name, { emails: [], github, body: `${name} helps maintain the project.` });
          add('other-maintainer', 'work', namesake, { emails: [], github, body: `${namesake} coordinates project releases.` });
          break;
        }
        default:
          throw new Error(`person-dedupe: no generator for family ${family.id}`);
      }

      // Key coverage cycles by instance: 0 emails only; 1 the first two pages both carry a LinkedIn
      // profile (one value per person, so the same person agrees and different people disagree);
      // 2 only the first page carries a GitHub handle. The split is a design choice, not a field rate.
      const profile = (pg: LedgerPage) => createHash('sha256').update(pg.person).digest('hex').slice(0, 10);
      const presetKeys = made.some(pg => pg.linkedin || pg.github || pg.external_id);
      if (!presetKeys && instance % 3 === 1 && made.length >= 2) for (const pg of made.slice(0, 2)) pg.linkedin = `https://www.linkedin.com/in/${profile(pg)}`;
      if (!presetKeys && instance % 3 === 2) made[0].github = `${compact(made[0].title)}${profile(made[0]).slice(0, 4)}`;
      if (version !== 1) for (const pg of made) {
        if (pg.linkedin) pg.linkedin = `https://www.linkedin.example/in/${exclusiveIdSuffix(seed, version, `person:linkedin:${pg.linkedin}`)}`;
        if (pg.github) pg.github = `${pg.github.slice(0, 22).replace(/-+$/, '')}-${exclusiveIdSuffix(seed, version, `person:github:${pg.github}`)}`;
      }
      for (let i = 0; i < made.length; i++) for (let j = i + 1; j < made.length; j++) {
        if (made[i].person.includes('-colleague') || made[j].person.includes('-colleague')) continue;
        pairs.push({ a: pageKey(made[i]), b: pageKey(made[j]), family: family.id, instance, label: made[i].person === made[j].person ? 'same' : 'different' });
      }
      pages.push(...made);
    }
  }
  return { seed, per_family: perFamily, generator_version: version, sources: SOURCES, pages, pairs };
}

/** The Markdown a system imports: frontmatter and a body line, never the person id. */
export function renderPage(p: LedgerPage): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = ['---', 'type: person', `title: ${q(p.title)}`];
  if (p.emails.length) lines.push(`emails: [${p.emails.map(q).join(', ')}]`);
  if (p.linkedin) lines.push(`linkedin: ${q(p.linkedin)}`);
  if (p.github) lines.push(`github: ${q(p.github)}`);
  if (p.external_id) lines.push(`${DECLARED_PERSON_ID_FIELD}: ${q(p.external_id)}`);
  if (p.company) lines.push(`company: ${q(p.company)}`);
  if (p.city) lines.push(`city: ${q(p.city)}`);
  lines.push('---', '', `# ${p.title.trim()}`, '', p.body, '');
  return lines.join('\n');
}

/** What a page tells a matcher: the rendered fields, read back from the Markdown. */
export interface WrittenPage {
  key: string;
  source: string;
  slug: string;
  /** The page's canonical type; a person never groups with a company. */
  type: 'person' | 'company';
  title: string;
  emails: string[];
  /** Company pages: every `domain` and `website` value as written. Empty on person pages. */
  domains: string[];
  linkedin: string | null;
  github: string | null;
  external_id?: string;
  company: string | null;
  city: string | null;
}

export function parseWrittenPage(source: string, slug: string, markdown: string): WrittenPage {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!m) throw new Error(`person-dedupe: ${source}:${slug} has no frontmatter`);
  const fields = new Map<string, string>();
  for (const line of m[1].split('\n')) {
    const at = line.indexOf(': ');
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 2));
  }
  const scalar = (k: string) => fields.has(k) ? JSON.parse(fields.get(k)!) as string : null;
  const externalId = scalar(DECLARED_PERSON_ID_FIELD);
  return { key: pageKey({ source, slug }), source, slug, type: 'person', title: scalar('title') ?? '', emails: fields.has('emails') ? JSON.parse(fields.get('emails')!) as string[] : [], domains: [], linkedin: scalar('linkedin'), github: scalar('github'), ...(externalId ? { external_id: externalId } : {}), company: scalar('company'), city: scalar('city') };
}

export function writtenPages(ledger: Ledger): WrittenPage[] {
  return ledger.pages.map(p => parseWrittenPage(p.source, p.slug, renderPage(p)));
}

/** Page key to person id. Throws when a designed pair's label disagrees with the people or with its family. */
export function deriveGold(ledger: Ledger): Map<string, string> {
  const person = new Map<string, string>();
  for (const p of ledger.pages) {
    const k = pageKey(p);
    if (person.has(k)) throw new Error(`person-dedupe: duplicate page key ${k}`);
    person.set(k, p.person);
  }
  for (const pair of ledger.pairs) {
    if (!person.has(pair.a) || !person.has(pair.b)) throw new Error(`person-dedupe: unknown page in pair ${pair.a} ${pair.b}`);
    const truth: Label = person.get(pair.a) === person.get(pair.b) ? 'same' : 'different';
    if (truth !== pair.label) throw new Error(`person-dedupe: pair ${pair.a} ${pair.b} labelled ${pair.label}, people say ${truth}`);
    const fam = FAMILY_BY_ID.get(pair.family)!;
    if (!MIXED_FAMILIES.has(fam.id) && fam.label !== truth) throw new Error(`person-dedupe: family ${fam.id} designs ${fam.label} pairs, got ${truth}`);
  }
  return person;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function ledgerFingerprint(ledger: object): string {
  return createHash('sha256').update(canonical(ledger)).digest('hex');
}
