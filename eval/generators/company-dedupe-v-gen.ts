/**
 * Development families for company auto-linking, layered on the person-dedupe company world
 * (eval/generators/company-dedupe-gen.ts). Opt-in only: `bun eval/runner/person-dedupe.ts --company-autolink`
 * reads them, and nothing else in the repository does, so the default bench and the entity-dedupe head-to-head world
 * are unchanged.
 *
 * The families test the cases a key-based company auto-link rule can get wrong:
 *   v-renamed-moved            one firm under an old and a new name, its pages split across sources, some moved
 *   v-renamed-namesake         a firm renamed to a name an unrelated firm in the other source already uses
 *   v-rejected-then-changed    two firms with one name, a pair a user already rejected, then one side moved or renamed
 *   v-shared-linkedin          two different companies listing one LinkedIn company page
 *   v-subsidiary-root-domain   a subsidiary listing its parent's root domain with no URL path
 *
 * Every page carries a stable `page_id` that survives a move or a rename (a base page's id is its page key, since
 * base pages never move). A rejection records both page ids and both page keys as they were when the user rejected
 * the pair, so a scorer can key rejection memory either way.
 *
 * Dev seed only: the families draw names from their own stream, seeded from the world seed, and the generator refuses
 * any seed but the public development seed. Invented names under .example; any likeness to a real company is accidental.
 *
 * Pure: no gbrain import, no I/O.
 */
import { companyWrittenPages, deriveCompanyGold, generateCompanyLedger } from './company-dedupe-gen.ts';
import type { DesignedPair, Label, WrittenPage } from './person-dedupe-gen.ts';
import { domainKey, strictFold } from '../runner/person-dedupe.ts';

export const COMPANY_V_GENERATOR_VERSION = 1;
export const COMPANY_V_DEV_SEED = 20261117;

export interface CompanyVFamily { id: string; label: Label; description: string; variants: readonly string[] }

export const COMPANY_V_FAMILIES: readonly CompanyVFamily[] = [
  { id: 'v-renamed-moved', label: 'same', description: 'one firm under an old and a new name, with its pages split across sources and some moved', variants: ['rename keeps old domain', 'rename keeps LinkedIn page', 'old page moved into the new page source', 'new page moved, nothing shared'] },
  { id: 'v-renamed-namesake', label: 'different', description: 'a firm renamed to a name an unrelated firm in the other source already uses', variants: ['renamed into a namesake'] },
  { id: 'v-rejected-then-changed', label: 'different', description: 'two firms with one name, a pair a user already rejected; then one side moves to the other source or is renamed ("X" to "X Ltd")', variants: ['different domains, then moved', 'different domains, then renamed', 'one root domain, then moved', 'one root domain, then renamed'] },
  { id: 'v-shared-linkedin', label: 'different', description: "two different companies that list one LinkedIn company page: a group's US and UK companies with one name, or a subsidiary listing its parent's page", variants: ['same name, group LinkedIn page', 'different name, subsidiary lists the parent LinkedIn page'] },
  { id: 'v-subsidiary-root-domain', label: 'different', description: "a subsidiary that lists its parent's root domain with no URL path: its name differs only by a word the name fold drops (Halwick, Halwick Labs), or plainly", variants: ['name differs by a word the fold drops', 'plainly different name'] },
];

export interface CompanyVPage extends WrittenPage { page_id: string }
export interface CompanyVPair extends DesignedPair { variant: string | null }
/** A user's rejection of a pair: both stable page ids, and both page keys as they were when the user rejected it. */
export interface CompanyRejection { a_id: string; b_id: string; a_key: string; b_key: string }
/** A page as it was before a move or rename, and as it is now. */
export interface CompanyPageChange { before: CompanyVPage; after: CompanyVPage }

export interface CompanyVWorld {
  seed: number;
  per_family: number;
  generator_version: number;
  /** Every company page, base world first; each has a stable page_id. */
  pages: CompanyVPage[];
  /** Every designed company pair; base pairs have variant null. */
  pairs: CompanyVPair[];
  /** Page key to company id. */
  gold: Map<string, string>;
  rejections: CompanyRejection[];
  changes: CompanyPageChange[];
  /** The base world's company family ids, in order. */
  base_families: string[];
}

export function generateCompanyVWorld(seed: number = COMPANY_V_DEV_SEED, perFamily = 20): CompanyVWorld {
  if (seed !== COMPANY_V_DEV_SEED) throw new Error(`company-dedupe-v: the V families are development families on seed ${COMPANY_V_DEV_SEED} only, not ${seed}`);
  const ledger = generateCompanyLedger(seed, perFamily);
  const basePages = companyWrittenPages(ledger).filter(p => p.type === 'company');
  const baseGold = deriveCompanyGold(ledger);
  const companyKeys = new Set(basePages.map(p => p.key));
  const basePairs: CompanyVPair[] = ledger.pairs.filter(p => companyKeys.has(p.a) && companyKeys.has(p.b)).map(p => ({ ...p, variant: null }));

  let s = (seed ^ 0x5eed) >>> 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const taken = new Set(basePages.flatMap(p => [strictFold(p.title).split(' ')[0], ...p.domains.map(d => domainKey(d)?.split('.')[0])]));
  const HEADS = ['zor', 'quin', 'vex', 'tal', 'yor', 'druv', 'pex', 'wyl', 'jask', 'omb', 'frel', 'gav', 'hux', 'klo', 'nyv', 'ruz'];
  const TAILS = ['ston', 'forge', 'holt', 'by', 'mont', 'ridge', 'vane', 'dell', 'port', 'reach'];
  const IND = ['Freight', 'Analytics', 'Bakery', 'Design', 'Robotics', 'Software', 'Brewing', 'Partners'];
  const CITIES = ['Leeds', 'Austin', 'Bristol', 'Lyon', 'Porto', 'Denver', 'Cork', 'Graz'];
  const word = () => {
    for (let i = 0; i < 100_000; i++) {
      const w = HEADS[Math.floor(rnd() * HEADS.length)] + TAILS[Math.floor(rnd() * TAILS.length)];
      if (!taken.has(w)) { taken.add(w); return w[0].toUpperCase() + w.slice(1); }
    }
    throw new Error('company-dedupe-v: name pool exhausted');
  };
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ex = (w: string) => `${w.toLowerCase()}.example`;
  const pages: CompanyVPage[] = [], pairs: CompanyVPair[] = [];
  const gold = new Map<string, string>();
  let n = 0;
  const page = (source: string, title: string, entity: string, o: { domains?: string[]; li?: string; city?: string } = {}): CompanyVPage => {
    const p: CompanyVPage = { key: `${source}:companies/${slug(title)}`, source, slug: `companies/${slug(title)}`, type: 'company', title, emails: [], domains: o.domains ?? [], linkedin: o.li ?? null, github: null, company: null, city: o.city ?? null, page_id: `pg-${++n}` };
    gold.set(p.key, entity);
    return p;
  };
  const family = (id: string) => COMPANY_V_FAMILIES.find(f => f.id === id)!;
  const pair = (a: CompanyVPage, b: CompanyVPage, id: string, instance: number, variant: number) => {
    pages.push(a, b);
    pairs.push({ a: a.key, b: b.key, family: id, instance, label: family(id).label, variant: family(id).variants[variant] });
  };

  for (let i = 0; i < perFamily; i++) {
    const ind = IND[i % IND.length], city = CITIES[i % CITIES.length];
    const o = `${word()} ${ind}`, nw = `${word()} ${ind}`, od = ex(o.replace(' ', '')), nd = ex(nw.replace(' ', '')), id = `ren-${i}`;
    const li = `https://www.linkedin.example/company/ren${i}`;
    const v = i % 4;
    const [x, y] = v === 0 ? [page('work', o, id, { domains: [od], city }), page('home', nw, id, { domains: [nd, od], city })]
      : v === 1 ? [page('work', o, id, { domains: [od], li, city }), page('home', nw, id, { domains: [nd], li, city })]
      : v === 2 ? [page('home', o, id, { domains: [od], city }), page('home', nw, id, { domains: [nd, od], city })]
      : [page('work', nw, id, { domains: [nd], city }), page('home', o, id, { domains: [od], city })];
    pair(x, y, 'v-renamed-moved', i, v);
  }
  for (let i = 0; i < Math.floor(perFamily / 2); i++) {
    const ind = IND[i % IND.length], nw = `${word()} ${ind}`, o = `${word()} ${ind}`;
    const x = page('work', nw, `rnn-${i}a`, { domains: [ex(nw.replace(' ', '') + 'hq'), ex(o.replace(' ', ''))], city: CITIES[i % 8] });
    const y = page('home', nw, `rnn-${i}b`, { domains: [ex(nw.replace(' ', ''))], city: CITIES[(i + 3) % 8] });
    pair(x, y, 'v-renamed-namesake', i, 0);
  }
  const rejections: CompanyRejection[] = [], changes: CompanyPageChange[] = [];
  for (let i = 0; i < perFamily; i++) {
    const ind = IND[i % IND.length], nm = `${word()} ${ind}`, v = i % 4, sharedRoot = v >= 2, move = v % 2 === 0;
    const d1 = ex(nm.replace(' ', '') + (sharedRoot ? 'group' : CITIES[i % 8].toLowerCase()));
    const d2 = sharedRoot ? d1 : ex(nm.replace(' ', '') + CITIES[(i + 2) % 8].toLowerCase());
    const a = page('work', nm, `rej-${i}a`, { domains: [d1], city: CITIES[i % 8] });
    const before = page('home', nm, `rej-${i}b`, { domains: [d2], city: CITIES[(i + 2) % 8] });
    const after: CompanyVPage = { ...before, ...(move ? { source: 'work', key: `work:companies/${slug(nm)}-2`, slug: `companies/${slug(nm)}-2` } : { title: `${nm} Ltd`, key: `home:companies/${slug(nm)}-ltd`, slug: `companies/${slug(nm)}-ltd` }) };
    gold.delete(before.key);
    gold.set(after.key, `rej-${i}b`);
    changes.push({ before, after });
    rejections.push({ a_id: a.page_id, b_id: before.page_id, a_key: a.key, b_key: before.key });
    pair(a, after, 'v-rejected-then-changed', i, v);
  }
  for (let i = 0; i < perFamily; i++) {
    const ind = IND[i % IND.length], v = i % 2, li = `https://www.linkedin.example/company/grp${i}`;
    if (v === 0) {
      const nm = `${word()} ${ind}`, c = nm.replace(' ', '').toLowerCase();
      pair(page('work', nm, `sli-${i}us`, { domains: [ex(c)], li, city: 'Austin' }), page('home', nm, `sli-${i}uk`, { domains: [`${c}.uk.example`], li, city: 'Leeds' }), 'v-shared-linkedin', i, v);
    } else {
      const parent = `${word()} Group`, sub = `${word()} ${ind}`;
      pair(page('work', parent, `sli-${i}parent`, { domains: [ex(parent.replace(' ', ''))], li, city: CITIES[i % 8] }), page('home', sub, `sli-${i}sub`, { domains: [ex(sub.replace(' ', ''))], li, city: CITIES[i % 8] }), 'v-shared-linkedin', i, v);
    }
  }
  for (let i = 0; i < perFamily; i++) {
    const ind = IND[i % IND.length], v = i % 2;
    if (v === 0) {
      const stem = word(), d = ex(stem);
      pair(page('work', stem, `srd-${i}parent`, { domains: [d], city: CITIES[i % 8] }), page('home', `${stem} ${i % 4 === 0 ? 'Labs' : 'Lab'}`, `srd-${i}sub`, { domains: [d, `https://www.${d}`], city: CITIES[i % 8] }), 'v-subsidiary-root-domain', i, v);
    } else {
      const parent = `${word()} Group`, d = ex(parent.replace(' ', ''));
      pair(page('work', parent, `srd-${i}parent`, { domains: [d], city: CITIES[i % 8] }), page('home', `${word()} ${ind}`, `srd-${i}sub`, { domains: [d, `https://www.${d}`], city: CITIES[i % 8] }), 'v-subsidiary-root-domain', i, v);
    }
  }

  const all: CompanyVPage[] = [...basePages.map(p => ({ ...p, page_id: p.key })), ...pages];
  const keys = new Set<string>();
  for (const p of all) {
    if (keys.has(p.key)) throw new Error(`company-dedupe-v: duplicate page key ${p.key}`);
    keys.add(p.key);
  }
  const goldAll = new Map([...[...baseGold].filter(([k]) => companyKeys.has(k)), ...gold]);
  for (const p of pairs) {
    const truth: Label = goldAll.get(p.a) === goldAll.get(p.b) ? 'same' : 'different';
    if (!goldAll.has(p.a) || !goldAll.has(p.b) || truth !== p.label) throw new Error(`company-dedupe-v: pair ${p.a} ${p.b} in ${p.family} is labelled ${p.label}, companies say ${truth}`);
  }
  return {
    seed, per_family: perFamily, generator_version: COMPANY_V_GENERATOR_VERSION, pages: all, pairs: [...basePairs, ...pairs], gold: goldAll, rejections, changes,
    base_families: [...new Set(basePairs.map(p => p.family))],
  };
}
