/**
 * P5 H5a: plausible names that belong to no page in an N4 entity ledger.
 *
 * When an agent creates a page titled with such a name, the right outcome is
 * a new page and no "did you mean an existing page?" hint. The N4 ledger
 * (eval/generators/n4-entity-gen.ts) carries only four no-referent mentions
 * per seed; the P5 bar needs at least 50, so this generator draws them from
 * name pools in the N4 style (fictional, every surname ends in "-Example",
 * every company in "Example"):
 *   fresh-person   a first name and surname stem that no ledger person uses
 *   relative       a new first name with the surname of a ledger person
 *                  (a relative, not the same person)
 *   fresh-company  a company stem that no ledger company uses
 * Every name is checked against the ledger with the N4 oracle (oracleResolve
 * over the rendered pages: exact slug, exact name, declared name, one-edit
 * typo, initials, first name) and must resolve to nothing, sit three or more
 * edits from every page title and alias, and not reuse a page's slug
 * basename. A generator bug therefore cannot put a solvable name into the
 * no-referent set.
 *
 * Pools: only development set A lives here. A held-out pool set is authored
 * and frozen by the custodian outside the repository and reaches this module
 * only as an object the custodian's run loads from custody (`sealedPools`).
 * A pool set name other than "A" is refused.
 */
import { Rng, fingerprint } from './seeded.ts';
import {
  levenshtein, normName, oracleResolve, parseWrittenPage, renderPage, slugPart, type Ledger,
} from './n4-entity-gen.ts';

export const NO_REFERENT_GENERATOR_VERSION = 'no-referent-names-gen/1';
export const DEV_SEEDS: readonly number[] = [1, 2, 3];
export const POOL_SETS = ['A'] as const;
export const NAME_FAMILIES = ['fresh-person', 'relative', 'fresh-company'] as const;
export type NameFamily = typeof NAME_FAMILIES[number];

export interface NamePools {
  first_names: string[];
  surname_stems: string[];
  company_stems: string[];
  /** How many names of each family to draw per seed. */
  counts: Record<NameFamily, number>;
}

export const POOLS_A: NamePools = {
  first_names: [
    'Ambrose', 'Bertrand', 'Clementine', 'Desmond', 'Evangeline', 'Fitzgerald', 'Gwendolyn', 'Horatio', 'Imogen', 'Jasper',
    'Lavinia', 'Montgomery', 'Octavia', 'Percival', 'Quentin', 'Rosamund', 'Sebastian', 'Tabitha', 'Ulysses', 'Wilhelmina',
    'Augustin', 'Barnaby', 'Cordelia', 'Delphine', 'Ezekiel', 'Fenella', 'Gideon', 'Hermione', 'Ignatius', 'Juliana',
    'Leopold', 'Marigold', 'Neville', 'Orlando', 'Philippa', 'Reginald', 'Seraphina', 'Thaddeus', 'Ursula', 'Wendell',
  ],
  surname_stems: [
    'Ashgrove', 'Blackwater', 'Coldharbour', 'Deepdale', 'Elmstead', 'Foxhollow', 'Greystoke', 'Hawthorne', 'Inglewood', 'Kingsley',
    'Longmire', 'Millbrook', 'Northcote', 'Oldfield', 'Pemberton', 'Redcliffe', 'Shelbourne', 'Thornbury', 'Underhill', 'Whitlock',
    'Ashdown', 'Brightwell', 'Crowhurst', 'Dunstable', 'Eversley', 'Fairbairn', 'Goldsworth', 'Holloway', 'Ironside', 'Lockwood',
  ],
  company_stems: [
    'Brightforge', 'Cobaltine', 'Duskwater', 'Emberline', 'Fernhollow', 'Granitebay', 'Halcyonix', 'Ironvale', 'Juniperworks', 'Kelpstone',
    'Lumenreach', 'Mistral Point', 'Nightjar', 'Opalcrest', 'Pinegate', 'Quartzlane', 'Ravenmoor', 'Saltmarsh', 'Tidewell', 'Umberfield',
  ],
  counts: { 'fresh-person': 26, relative: 22, 'fresh-company': 12 },
};
const DEV_POOLS: Record<(typeof POOL_SETS)[number], NamePools> = { A: POOLS_A };

export function validatePools(p: unknown): NamePools {
  const o = p as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of ['first_names', 'surname_stems', 'company_stems'] as const) {
    if (!Array.isArray(o?.[k]) || (o[k] as unknown[]).length < 5 || (o[k] as unknown[]).some(x => typeof x !== 'string' || !x.trim())) problems.push(`${k} must list at least five names`);
  }
  const counts = o?.counts as Record<string, unknown> | undefined;
  for (const f of NAME_FAMILIES) if (!Number.isInteger(counts?.[f]) || (counts![f] as number) < 0) problems.push(`counts.${f} must be a non-negative integer`);
  if (!problems.length && NAME_FAMILIES.reduce((a, f) => a + (counts![f] as number), 0) < 50) problems.push('counts must add up to at least 50 names (the P5 H5a bar)');
  if (problems.length) throw new Error(`no-referent name pools: ${problems.join('; ')}`);
  return o as unknown as NamePools;
}

export interface NoReferentName { id: string; text: string; family: NameFamily; kind: 'person' | 'company'; note: string }
export interface NoReferentSet { seed: number; pools: string; names: NoReferentName[]; fingerprint: string }

/** Why `text` is not a safe no-referent name for this ledger, or null when it is. */
export function referentProblem(text: string, ledger: Ledger): string | null {
  const readable = ledger.pages.filter(p => p.source === 'default').map(p => parseWrittenPage(p.source, p.slug, renderPage(p)));
  const { rule, hits } = oracleResolve(text, readable, k => k);
  if (hits.length) return `the N4 oracle resolves it by ${rule} to ${hits[0].page.key}`;
  const q = normName(text);
  const near = ledger.pages.flatMap(p => [p.title, ...p.aliases]).find(n => levenshtein(q, normName(n)) < 3);
  if (near) return `within two edits of "${near}"`;
  const base = slugPart(text);
  const same = ledger.pages.find(p => p.slug.slice(p.slug.lastIndexOf('/') + 1) === base || p.slug.endsWith(`/${base}-example`));
  if (same) return `its slug matches ${same.slug}`;
  if (ledger.mentions.some(m => normName(m.text) === q)) return 'it is the text of a ledger mention';
  return null;
}

export function generateNoReferentNames(opts: { seed: number; ledger: Ledger; pools?: string; sealedPools?: { id: string; pools: NamePools } }): NoReferentSet {
  if (opts.pools !== undefined && !(POOL_SETS as readonly string[]).includes(opts.pools)) {
    throw new Error(`name pool set ${opts.pools} is held out: only the custodian's run draws from it, from a --phrasing-file in custody`);
  }
  const pools = opts.sealedPools ? validatePools(opts.sealedPools.pools) : DEV_POOLS[(opts.pools ?? 'A') as (typeof POOL_SETS)[number]];
  const label = opts.sealedPools ? `sealed:${opts.sealedPools.id}` : (opts.pools ?? 'A');
  const rng = new Rng(opts.seed * 2_654_435 + 97);
  const ledgerStems = [...new Set(opts.ledger.pages.filter(p => p.type === 'person').map(p => /([A-Z][a-z]+)-Example$/.exec(p.title)?.[1]).filter((s): s is string => !!s))].sort();
  const names: NoReferentName[] = [];
  const taken = new Set<string>();
  const accept = (text: string, family: NameFamily, kind: NoReferentName['kind'], note: string) => {
    if (taken.has(normName(text)) || referentProblem(text, opts.ledger)) return false;
    taken.add(normName(text));
    names.push({ id: `nr${String(names.length + 1).padStart(3, '0')}`, text, family, kind, note });
    return true;
  };
  const draw = (family: NameFamily, make: () => [string, NoReferentName['kind'], string]) => {
    for (let made = 0, tries = 0; made < pools.counts[family]; tries++) {
      if (tries > 5000) throw new Error(`no-referent generator: pools ran out drawing ${family} names (${made} of ${pools.counts[family]})`);
      const [text, kind, note] = make();
      if (accept(text, family, kind, note)) made++;
    }
  };
  draw('fresh-person', () => [`${rng.pick(pools.first_names)} ${rng.pick(pools.surname_stems)}-Example`, 'person', 'first name and surname that no page carries']);
  draw('relative', () => {
    const stem = rng.pick(ledgerStems);
    return [`${rng.pick(pools.first_names)} ${stem}-Example`, 'person', `a new first name with the surname ${stem}-Example of a ledger person`];
  });
  draw('fresh-company', () => [`${rng.pick(pools.company_stems)} Example`, 'company', 'company name that no page carries']);
  const set = { seed: opts.seed, pools: label, names };
  return { ...set, fingerprint: fingerprint({ v: NO_REFERENT_GENERATOR_VERSION, ledger_seed: opts.ledger.seed, ...set }) };
}
