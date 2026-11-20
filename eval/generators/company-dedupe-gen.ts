/**
 * Company pages for the person-dedupe bench (registry id `person-dedupe`).
 *
 * Writes a seeded world of company pages in the same two sources as the
 * person pages, where every page belongs to one invented company and the
 * ledger records which. The cases are the ones that join different companies
 * or split one: the same name in another city, industry or country, a legal
 * suffix that marks another company, a parent and its subsidiary, a holding
 * group on one domain and an acquisition (all must stay apart), and one
 * company written differently: a legal suffix spelled another way or dropped,
 * its initials, a rename, several domains (all one company).
 *
 * Companies draw from their own random stream (companySeed), so adding them
 * moves no person page. Pages carry the fields gbrain's finder reads for a
 * company (finder contract schema 1): `domain` (a string or a list) and
 * `website` (its host is a domain key), and `linkedin` (a /company/ path).
 * Each instance gets a name stem no other instance uses, so a designed pair is
 * independent of the rest of the world.
 *
 * Pure: no gbrain import, no I/O.
 */
import { createHash } from 'node:crypto';
import { SOURCES, exclusiveIdSuffix, mulberry32, pageKey, slugify, type DesignedPair, type Label, type LedgerPage, type SourceId, type WrittenPage } from './person-dedupe-gen.ts';

export const COMPANY_DEDUPE_GENERATOR_VERSION = 2;

/** The company stream's seed for a world seed. */
export function companySeed(seed: number): number {
  return (seed ^ 0x5bd1e995) >>> 0;
}

export interface CompanyFamily {
  id: string;
  label: Label;
  description: string;
}

const V1_FAMILIES: readonly CompanyFamily[] = [
  { id: 'co-same-exact', label: 'same', description: 'one company in two sources: same name, same domain' },
  { id: 'co-same-legal-suffix', label: 'same', description: 'one company whose legal suffix is written another way or dropped (Halwick Inc and Halwick, Inc.; Halwick Inc and Halwick; Inc and LLC after a conversion), same domain' },
  { id: 'co-same-abbreviation', label: 'same', description: 'one company; one page uses its initials (Halwick International Machines, HIM), with the same domain or no domain on the short page' },
  { id: 'co-same-rebrand', label: 'same', description: 'one company before and after a rename: the new page keeps the old domain, or says "formerly" and shares nothing' },
  { id: 'co-same-multi-domain', label: 'same', description: 'one company with several domains: one page lists both, the pages list different ones, or one page has a country domain' },
  { id: 'co-diff-namesake-city', label: 'different', description: 'two companies with the same name and industry in different cities: different domains, or two franchise owners whose sites both sit on the brand domain' },
  { id: 'co-diff-namesake-industry', label: 'different', description: 'two companies with the same name in one city, different industries and domains' },
  { id: 'co-diff-namesake-country-suffix', label: 'different', description: 'two companies with the same name and different legal suffixes in different countries (Halwick GmbH, Halwick Ltd), different domains' },
  { id: 'co-diff-legal-suffix', label: 'different', description: 'two companies in one city whose names differ only by the legal suffix (Halwick Inc, Halwick LLC; a bakery called Halwick and Halwick Inc), different industries and domains' },
  { id: 'co-diff-parent-subsidiary', label: 'different', description: 'a parent and its subsidiary: the subsidiary site sits on the parent domain, or on a subdomain, or the subsidiary name adds a word the finder drops as a suffix (Halwick, Halwick Labs)' },
  { id: 'co-diff-holding-domain', label: 'different', description: 'two or three companies of one holding group on one domain, including two national companies with the same name (the US one and the UK one)' },
  { id: 'co-diff-acquired', label: 'different', description: 'an acquirer and the company it bought, whose second page lists the acquirer domain (its site now redirects); the bought company\'s two pages are one company' },
];

const FOUNDER_FAMILY: CompanyFamily = {
  id: 'co-diff-founder-linkedin', label: 'different',
  description: 'A directory uses the founder’s personal LinkedIn as the profile of a practice named after them. The founder and the practice can have the same display name and location. Controls use the founder’s link on two pages about the same practice.',
};

export const COMPANY_FAMILIES: readonly CompanyFamily[] = [...V1_FAMILIES, FOUNDER_FAMILY];
export const COMPANY_MIXED_FAMILIES: ReadonlySet<string> = new Set(['co-diff-acquired', FOUNDER_FAMILY.id]);

export const COMPANY_FAMILY_BY_ID: ReadonlyMap<string, CompanyFamily> = new Map(COMPANY_FAMILIES.map(f => [f.id, f]));

export interface CompanyLedgerPage {
  source: SourceId;
  /** File name under <source>/companies/; the page key is `<source>:companies/<slug>`. */
  slug: string;
  /** The true company behind the page. Never rendered. */
  company: string;
  family: string;
  instance: number;
  title: string;
  domains: string[];
  website: string | null;
  linkedin: string | null;
  industry: string;
  city: string;
  country: string;
  legal_suffix: string | null;
  parent: string | null;
  body: string;
}

export interface CompanyLedger {
  seed: number;
  stream_seed: number;
  per_family: number;
  generator_version: number;
  sources: readonly SourceId[];
  pages: CompanyLedgerPage[];
  founders?: LedgerPage[];
  pairs: DesignedPair[];
}

// Invented names under .example; any likeness to a real company is accidental.
const STEM_HEADS = ['Hal', 'Tide', 'Mar', 'Quil', 'Sable', 'Orv', 'Vel', 'Cin', 'Lark', 'Bright', 'Copper', 'Fern', 'Gan', 'Hol', 'Isel', 'Abb', 'Kel', 'Lat', 'Moss', 'Nim', 'Ori', 'Pell', 'Quar', 'Rook', 'Salt', 'Thorn', 'Umb', 'Ver', 'Wren', 'Yar', 'Zeph', 'Bram'];
const STEM_TAILS = ['ford', 'wick', 'mere', 'dale', 'field', 'stone', 'vale', 'crest', 'brook', 'wood', 'gate', 'haven'];
const GENERIC = ['Partners', 'Group', 'Works', 'Collective', 'Associates'];
const INDUSTRIES: ReadonlyArray<readonly [string, string]> = [['bakery', 'Bakery'], ['software', 'Software'], ['freight', 'Freight'], ['dental care', 'Dental'], ['brewing', 'Brewing'], ['architecture', 'Design'], ['biotech', 'Bio'], ['construction', 'Builders'], ['insurance', 'Insurance'], ['media', 'Media'], ['analytics', 'Analytics'], ['robotics', 'Robotics']];
const ABBREV_MIDDLE = ['International', 'United', 'General', 'Consolidated', 'Pacific', 'Northern'];
const ABBREV_LAST = ['Machines', 'Systems', 'Instruments', 'Shipping', 'Minerals', 'Textiles'];
const DIVISIONS = ['Energy', 'Water', 'Rail', 'Ports', 'Foods'];
const FOUNDER_GIVEN = ['Aline', 'Caris', 'Della', 'Ellery', 'Galen', 'Iona', 'Jory', 'Liora', 'Maren', 'Neris', 'Olin', 'Renna', 'Tavin', 'Veda'];
interface Place { country: string; suffix: string; cc: string; cities: readonly string[] }
const PLACES: readonly Place[] = [
  { country: 'United States', suffix: 'Inc', cc: 'us', cities: ['Portland', 'Austin', 'Denver', 'Raleigh'] },
  { country: 'United Kingdom', suffix: 'Ltd', cc: 'uk', cities: ['Leeds', 'Bristol', 'York'] },
  { country: 'Germany', suffix: 'GmbH', cc: 'de', cities: ['Leipzig', 'Bremen', 'Kassel'] },
  { country: 'France', suffix: 'SA', cc: 'fr', cities: ['Lyon', 'Nantes', 'Lille'] },
  { country: 'Netherlands', suffix: 'BV', cc: 'nl', cities: ['Utrecht', 'Delft'] },
  { country: 'Switzerland', suffix: 'AG', cc: 'ch', cities: ['Basel', 'Bern'] },
];
/** One company's legal suffix written two ways, or changed by a conversion: [work title ending, its suffix, home title ending, its suffix, extra body line]. */
const SAME_SUFFIX_FORMS: ReadonlyArray<readonly [string, string | null, string, string | null, string]> = [
  [' Inc', 'Inc', ', Inc.', 'Inc', ''],
  [' Inc', 'Inc', '', null, ''],
  [' Incorporated', 'Inc', ' Inc', 'Inc', ''],
  [' LLC', 'LLC', ', L.L.C.', 'LLC', ''],
  [' Ltd', 'Ltd', ' Limited', 'Ltd', ''],
  [' LLC', 'LLC', ' Inc', 'Inc', ' It converted from an Inc to an LLC last year.'],
];

const compact = (s: string) => slugify(s).replace(/-/g, '');

export function companyPageKey(p: { source: string; slug: string }): string {
  return `${p.source}:companies/${p.slug}`;
}

export function generateCompanyLedger(seed: number, perFamily: number, version = COMPANY_DEDUPE_GENERATOR_VERSION): CompanyLedger {
  if (version !== 1 && version !== COMPANY_DEDUPE_GENERATOR_VERSION) throw new Error(`company-dedupe: unknown generator version ${version}`);
  const streamSeed = companySeed(seed);
  const next = mulberry32(streamSeed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const other = <T>(items: readonly T[], not: T): T => {
    const rest = items.filter(x => x !== not);
    return rest[Math.floor(next() * rest.length)];
  };
  const used = new Set<string>();
  const claim = (name: string) => {
    const k = slugify(name);
    if (used.has(k)) return false;
    used.add(k);
    return true;
  };
  const stem = (): string => {
    for (let i = 0; i < 10_000; i++) {
      const s = `${pick(STEM_HEADS)}${pick(STEM_TAILS)}`;
      if (claim(s)) return s;
    }
    throw new Error('company-dedupe: name pool exhausted');
  };
  const pages: CompanyLedgerPage[] = [];
  const founders: LedgerPage[] = [];
  const pairs: DesignedPair[] = [];
  const slugsBySource = new Map<SourceId, Set<string>>(SOURCES.map(s => [s, new Set<string>()]));
  const place = (source: SourceId, base: string): string => {
    const taken = slugsBySource.get(source)!;
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    return slug;
  };

  for (const family of version === 1 ? V1_FAMILIES : COMPANY_FAMILIES) {
    for (let instance = 0; instance < perFamily; instance++) {
      const home = pick(PLACES);
      const city = pick(home.cities);
      const [industry, word] = pick(INDUSTRIES);
      const tag = `${family.id}-${instance}`;
      // Variants step every three instances, so each variant meets every LinkedIn coverage case below.
      const variant = (k: number) => Math.floor(instance / 3) % k;
      const made: CompanyLedgerPage[] = [];
      type Opts = { domains: string[]; website?: string | null; linkedin?: string; industry?: string; city?: string; country?: string; legal_suffix?: string | null; parent?: string | null; body?: string };
      const add = (company: string, source: SourceId, title: string, o: Opts) => {
        const ind = o.industry ?? industry, c = o.city ?? city, country = o.country ?? home.country;
        made.push({
          source, slug: place(source, slugify(title)), company: `${tag}-${company}`, family: family.id, instance, title,
          domains: o.domains, website: o.website === undefined ? (o.domains.length ? `https://www.${o.domains[0]}` : null) : o.website,
          linkedin: o.linkedin ?? null, industry: ind, city: c, country, legal_suffix: o.legal_suffix ?? null, parent: o.parent ?? null,
          body: o.body ?? `${title} is a ${ind} business in ${c}, ${country}.`,
        });
      };

      switch (family.id) {
        case 'co-same-exact': {
          const name = `${stem()} ${word}`;
          const d = `${compact(name)}.example`;
          add('c', 'work', name, { domains: [d] });
          add('c', 'home', name, { domains: [d] });
          break;
        }
        case 'co-same-legal-suffix': {
          const s = stem();
          const [a, sa, b, sb, note] = SAME_SUFFIX_FORMS[variant(SAME_SUFFIX_FORMS.length)];
          const d = `${compact(s)}.example`;
          add('c', 'work', `${s}${a}`, { domains: [d], legal_suffix: sa });
          add('c', 'home', `${s}${b}`, { domains: [d], legal_suffix: sb, body: `${s}${b} is a ${industry} business in ${city}, ${home.country}.${note}` });
          break;
        }
        case 'co-same-abbreviation': {
          let full = '', short = '';
          for (let i = 0; i < 10_000 && !short; i++) {
            const f = `${stem()} ${pick(ABBREV_MIDDLE)} ${pick(ABBREV_LAST)}`;
            const ab = f.split(' ').map(w => w[0]).join('');
            if (claim(ab)) { full = f; short = ab; }
          }
          if (!short) throw new Error('company-dedupe: abbreviation pool exhausted');
          const d = `${compact(short)}.example`;
          add('c', 'work', full, { domains: [d] });
          add('c', 'home', short, variant(2) === 0 ? { domains: [d] } : { domains: [], body: `${short} (${full}) is a ${industry} business in ${city}, ${home.country}.` });
          break;
        }
        case 'co-same-rebrand': {
          const old = `${stem()} ${word}`;
          const now = `${stem()} ${word}`;
          const od = `${compact(old)}.example`, nd = `${compact(now)}.example`;
          add('c', 'work', now, { domains: variant(2) === 0 ? [nd, od] : [nd], body: `${now} (formerly ${old}) is a ${industry} business in ${city}, ${home.country}.` });
          add('c', 'home', old, { domains: [od] });
          break;
        }
        case 'co-same-multi-domain': {
          const name = `${stem()} ${word}`;
          const d = `${compact(name)}.example`, alt = `get${compact(name)}.example`, local = `${compact(name)}.${home.cc}.example`;
          const v = variant(3);
          add('c', 'work', name, { domains: v === 0 ? [d, alt] : [d] });
          add('c', 'home', name, { domains: [v === 2 ? local : alt] });
          break;
        }
        case 'co-diff-namesake-city': {
          const name = `${stem()} ${word}`;
          const there = pick(PLACES);
          const otherCity = other(there.cities, city);
          if (variant(2) === 0) {
            add('a', 'work', name, { domains: [`${compact(name)}.example`] });
            add('b', 'home', name, { domains: [`${compact(name)}${compact(otherCity)}.example`], city: otherCity, country: there.country });
          } else {
            const brand = `${compact(name)}.example`;
            add('a', 'work', name, { domains: [], website: `https://www.${brand}/${compact(city)}`, body: `${name} is a ${industry} business in ${city}, ${home.country}, run by its own franchise owner.` });
            add('b', 'home', name, { domains: [], website: `https://www.${brand}/${compact(otherCity)}`, city: otherCity, country: there.country, body: `${name} is a ${industry} business in ${otherCity}, ${there.country}, run by its own franchise owner.` });
          }
          break;
        }
        case 'co-diff-namesake-industry': {
          const name = `${stem()} ${pick(GENERIC)}`;
          const [otherIndustry, otherWord] = other(INDUSTRIES, INDUSTRIES.find(i => i[0] === industry)!);
          add('a', 'work', name, { domains: [`${compact(name)}.example`] });
          add('b', 'home', name, { domains: [`${compact(name)}${compact(otherWord)}.example`], industry: otherIndustry });
          break;
        }
        case 'co-diff-namesake-country-suffix': {
          const s = stem();
          const there = other(PLACES, home);
          add('a', 'work', `${s} ${home.suffix}`, { domains: [`${compact(s)}.${home.cc}.example`], legal_suffix: home.suffix });
          add('b', 'home', `${s} ${there.suffix}`, { domains: [`${compact(s)}.${there.cc}.example`], legal_suffix: there.suffix, city: pick(there.cities), country: there.country });
          break;
        }
        case 'co-diff-legal-suffix': {
          const s = stem();
          const [otherIndustry] = other(INDUSTRIES, INDUSTRIES.find(i => i[0] === industry)!);
          const us = PLACES[0];
          const usCity = pick(us.cities);
          const [ta, sa, tb, sb] = variant(2) === 0 ? [`${s} Inc`, 'Inc', `${s} LLC`, 'LLC'] : [s, null, `${s} Inc`, 'Inc'];
          add('a', 'work', ta, { domains: [`${compact(s)}${compact(word)}.example`], legal_suffix: sa, country: us.country, city: usCity });
          add('b', 'home', tb, { domains: [`${compact(s)}hq.example`], legal_suffix: sb, industry: otherIndustry, country: us.country, city: usCity });
          break;
        }
        case 'co-diff-parent-subsidiary': {
          const s = stem();
          const v = variant(3);
          if (v === 0) {
            const d = `${compact(s)}group.example`;
            add('parent', 'work', `${s} Group`, { domains: [d] });
            add('sub', 'home', `${s} ${word}`, { domains: [d], website: `https://www.${d}/${compact(word)}`, parent: `${s} Group` });
          } else if (v === 1) {
            const d = `${compact(s)}.example`;
            const us = PLACES[0], uk = PLACES[1];
            add('parent', 'work', `${s} Inc`, { domains: [d], legal_suffix: 'Inc', country: us.country, city: pick(us.cities) });
            add('sub', 'home', `${s} Ltd`, { domains: [`uk.${d}`], legal_suffix: 'Ltd', country: uk.country, city: pick(uk.cities), parent: `${s} Inc` });
          } else {
            const d = `${compact(s)}.example`;
            add('parent', 'work', s, { domains: [d] });
            add('sub', 'home', `${s} Labs`, { domains: [d], website: `https://www.${d}/labs`, industry: 'research', parent: s, body: `${s} Labs is the research arm of ${s}, in ${city}, ${home.country}.` });
          }
          break;
        }
        case 'co-diff-holding-domain': {
          const s = stem();
          const d = `${compact(s)}group.example`;
          const v = variant(3);
          if (v < 2) {
            const first = Math.floor(next() * DIVISIONS.length);
            for (let i = 0; i < (v === 0 ? 2 : 3); i++) {
              const div = DIVISIONS[(first + i) % DIVISIONS.length];
              add(`div${i}`, i === 1 ? 'home' : 'work', `${s} ${div}`, { domains: [d], website: `https://www.${d}/${div.toLowerCase()}`, industry: div.toLowerCase(), parent: `${s} Holdings` });
            }
          } else {
            const div = pick(DIVISIONS);
            const us = PLACES[0], uk = PLACES[1];
            add('us', 'work', `${s} ${div}`, { domains: [d], website: `https://www.${d}/${div.toLowerCase()}-us`, industry: div.toLowerCase(), legal_suffix: 'Inc', country: us.country, city: pick(us.cities), parent: `${s} Holdings` });
            add('uk', 'home', `${s} ${div}`, { domains: [d], website: `https://www.${d}/${div.toLowerCase()}-uk`, industry: div.toLowerCase(), legal_suffix: 'Ltd', country: uk.country, city: pick(uk.cities), parent: `${s} Holdings` });
          }
          break;
        }
        case 'co-diff-acquired': {
          const bought = `${stem()} ${word}`;
          const buyer = `${stem()} ${pick(GENERIC)}`;
          const bd = `${compact(bought)}.example`, ad = `${compact(buyer)}.example`;
          add('bought', 'work', bought, { domains: [bd], body: `${bought} is a ${industry} business in ${city}, ${home.country}. ${buyer} acquired it last year.` });
          add('bought', 'home', bought, { domains: variant(2) === 0 ? [bd, ad] : [ad], website: `https://www.${ad}`, body: `${bought}, now part of ${buyer}.` });
          add('buyer', 'work', buyer, { domains: [ad], industry: 'holding company' });
          break;
        }
        case FOUNDER_FAMILY.id: {
          const founder = `${pick(FOUNDER_GIVEN)} ${stem()}`;
          const title = instance % 4 === 1 ? `${founder}, LLC` : founder;
          const linkedin = `https://www.linkedin.example/in/${exclusiveIdSuffix(seed, version, `company:linkedin:${tag}:founder`)}`;
          const domains = [`${compact(founder)}.example`];
          add('practice', 'work', title, { domains, linkedin, body: `${title} provides ${industry} services in ${city}.` });
          if (instance % 5 === 4) {
            add('practice', 'home', title, { domains: [], linkedin, body: `Listed locally for ${industry} services in ${city}.` });
          } else {
            const p: LedgerPage = {
              person: `${tag}-founder`, source: 'home', slug: slugify(founder), title: founder, family: family.id, instance,
              linkedin, github: null, emails: [], company: title, city, body: `Works in ${industry} in ${city}.`,
            };
            founders.push(p);
            pairs.push({ a: companyPageKey(made[0]), b: pageKey(p), family: family.id, instance, label: 'different' });
          }
          break;
        }
        default:
          throw new Error(`company-dedupe: no generator for family ${family.id}`);
      }

      // LinkedIn coverage cycles by instance, as on person pages: on every third instance the first
      // two pages carry a LinkedIn company page, one value per company. A design choice, not a field rate.
      if (instance % 3 === 1 && !made.some(pg => pg.linkedin)) for (const pg of made.slice(0, 2)) {
        pg.linkedin = version === 1
          ? `https://www.linkedin.com/company/${createHash('sha256').update(pg.company).digest('hex').slice(0, 10)}`
          : `https://www.linkedin.example/company/${exclusiveIdSuffix(seed, version, `company:linkedin:${pg.company}`)}`;
      }
      for (let i = 0; i < made.length; i++) for (let j = i + 1; j < made.length; j++) {
        pairs.push({ a: companyPageKey(made[i]), b: companyPageKey(made[j]), family: family.id, instance, label: made[i].company === made[j].company ? 'same' : 'different' });
      }
      pages.push(...made);
    }
  }
  return { seed, stream_seed: streamSeed, per_family: perFamily, generator_version: version, sources: SOURCES, pages, ...(version === 1 ? {} : { founders }), pairs };
}

/** The Markdown a system imports: frontmatter and a body line, never the company id. */
export function renderCompanyPage(p: CompanyLedgerPage): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = ['---', 'type: company', `title: ${q(p.title)}`];
  if (p.domains.length === 1) lines.push(`domain: ${q(p.domains[0])}`);
  if (p.domains.length > 1) lines.push(`domain: [${p.domains.map(q).join(', ')}]`);
  if (p.website) lines.push(`website: ${q(p.website)}`);
  if (p.linkedin) lines.push(`linkedin: ${q(p.linkedin)}`);
  lines.push(`industry: ${q(p.industry)}`, `city: ${q(p.city)}`, `country: ${q(p.country)}`);
  if (p.legal_suffix) lines.push(`legal_suffix: ${q(p.legal_suffix)}`);
  if (p.parent) lines.push(`parent: ${q(p.parent)}`);
  lines.push('---', '', `# ${p.title}`, '', p.body, '');
  return lines.join('\n');
}

/** What a company page tells a matcher: the title, every `domain` and `website` value as written, LinkedIn and city. */
export function parseCompanyPage(source: string, slug: string, markdown: string): WrittenPage {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!m) throw new Error(`company-dedupe: ${source}:${slug} has no frontmatter`);
  const fields = new Map<string, string>();
  for (const line of m[1].split('\n')) {
    const at = line.indexOf(': ');
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 2));
  }
  const value = (k: string): unknown => fields.has(k) ? JSON.parse(fields.get(k)!) : null;
  const domain = value('domain');
  const website = value('website') as string | null;
  const domains = [...(Array.isArray(domain) ? domain as string[] : typeof domain === 'string' ? [domain] : []), ...(website ? [website] : [])];
  return { key: companyPageKey({ source, slug }), source, slug: `companies/${slug}`, type: 'company', title: (value('title') as string | null) ?? '', emails: [], domains, linkedin: value('linkedin') as string | null, github: null, company: null, city: value('city') as string | null };
}

export function companyWrittenPages(ledger: CompanyLedger): WrittenPage[] {
  return ledger.pages.map(p => parseCompanyPage(p.source, p.slug, renderCompanyPage(p)));
}

/** Page key to company id. Throws when a designed pair's label disagrees with the companies or with its family. */
export function deriveCompanyGold(ledger: CompanyLedger): Map<string, string> {
  const company = new Map<string, string>();
  for (const p of ledger.pages) {
    const k = companyPageKey(p);
    if (company.has(k)) throw new Error(`company-dedupe: duplicate page key ${k}`);
    company.set(k, p.company);
  }
  const entities = new Map([...company, ...(ledger.founders ?? []).map(p => [pageKey(p), p.person] as const)]);
  for (const pair of ledger.pairs) {
    if (!entities.has(pair.a) || !entities.has(pair.b)) throw new Error(`company-dedupe: unknown page in pair ${pair.a} ${pair.b}`);
    const truth: Label = entities.get(pair.a) === entities.get(pair.b) ? 'same' : 'different';
    if (truth !== pair.label) throw new Error(`company-dedupe: pair ${pair.a} ${pair.b} labelled ${pair.label}, companies say ${truth}`);
    const fam = COMPANY_FAMILY_BY_ID.get(pair.family)!;
    if (!COMPANY_MIXED_FAMILIES.has(fam.id) && fam.label !== truth) throw new Error(`company-dedupe: family ${fam.id} designs ${fam.label} pairs, got ${truth}`);
  }
  return company;
}
