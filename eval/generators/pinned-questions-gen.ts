/**
 * Seeded worlds for the pinned-questions category (eval/runner/pinned-questions.ts).
 *
 * Each world is a set of fictional companies. Every company gets one pinned
 * question with four claims, each backed by one kind of evidence:
 *
 *   city      where it builds its products     the company page (paragraph 1)
 *   flagship  its flagship product             the company page (paragraph 2)
 *   ceo       its chief executive              the CEO's person page
 *   founded   the year it was founded          a fact row written with remember
 *
 * The company page also holds a staff-count paragraph no claim needs, and a
 * visit note names the company without stating any claim. Each company then
 * gets exactly one controlled change, balanced across MUTATION_CLASSES, and
 * the ledger records which claims the change affects. That set is the gold:
 * a sentence about an affected claim should be flagged stale, and every other
 * sentence should stay unflagged. Gold comes from the ledger, never from gbrain.
 *
 * Names, cities and products are generated from syllables, so every claim value
 * is a token that appears nowhere else in the world.
 */
import { Rng, fingerprint } from './seeded.ts';

export const PINNED_QUESTIONS_GENERATOR_VERSION = 'pinned-questions-gen/1';
export const DEV_SEEDS = [1, 2, 3] as const;
export const CLAIMS = ['city', 'flagship', 'ceo', 'founded'] as const;
export type Claim = typeof CLAIMS[number];

export const MUTATION_CLASSES = [
  'edit_claim_page',
  'edit_claim_fact',
  'remove_source_page',
  'contradict_new_page',
  'contradict_existing_page',
  'unrelated_edit_cited_page',
  'unrelated_edit_uncited_page',
  'unrelated_new_page',
] as const;
export type MutationClass = typeof MUTATION_CLASSES[number];

/** The claims each change makes stale. Empty means every sentence should stay unflagged. */
export const AFFECTED: Readonly<Record<MutationClass, readonly Claim[]>> = {
  edit_claim_page: ['city'],
  edit_claim_fact: ['founded'],
  remove_source_page: ['ceo'],
  contradict_new_page: ['city'],
  contradict_existing_page: ['city'],
  unrelated_edit_cited_page: [],
  unrelated_edit_uncited_page: [],
  unrelated_new_page: [],
};

/** Changes whose gold rests on new or contradicting text rather than on an edit to cited evidence. */
export const CONTRADICTION_CLASSES: readonly MutationClass[] = ['contradict_new_page', 'contradict_existing_page'];

export interface PqPage { slug: string; content: string }
export interface PqFact { entity: string; text: string }

export type PqStep =
  | { op: 'put'; page: PqPage }
  | { op: 'delete'; slug: string }
  | { op: 'replace_fact'; fact: PqFact };

export interface PqCompany {
  slug: string;
  name: string;
  product: string;
  city: string;
  flagship: string;
  ceo: { slug: string; name: string };
  founded: number;
  staff: number;
  pet: string;
  question: string;
  /** Claim values before the change. */
  before: Record<Claim, string>;
  /** Claim values after the change; null when the change removed the only evidence. */
  after: Record<Claim, string | null>;
  mutation: MutationClass;
  affected: readonly Claim[];
  /** The change, applied in order after the first answer is published. */
  steps: PqStep[];
}

export interface PqWorld { seed: number; generator_version: string; companies: PqCompany[]; pages: PqPage[]; facts: PqFact[]; fingerprint: string }

const ONSETS = ['b', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z', 'br', 'dr', 'kl', 'tr', 'st', 'gr'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ai', 'ou', 'ei'];
const CODAS = ['', 'n', 'r', 'l', 's', 'th', 'nd', 'rk', 'm', 'x'];
const PRODUCTS = ['pumps', 'kites', 'lamps', 'valves', 'bicycles', 'kettles', 'drones', 'looms', 'scales', 'boilers', 'sensors', 'turbines'];
const PETS = ['dog', 'cat', 'parrot', 'tortoise', 'rabbit', 'goldfish'];

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function namer(rng: Rng): (syllables: number, suffix?: string) => string {
  const seen = new Set<string>();
  return (syllables, suffix = '') => {
    for (;;) {
      let w = '';
      for (let i = 0; i < syllables; i++) w += rng.pick(ONSETS) + rng.pick(VOWELS) + (i === syllables - 1 ? rng.pick(CODAS) : '');
      const word = cap(w) + suffix;
      if (!seen.has(word.toLowerCase())) { seen.add(word.toLowerCase()); return word; }
    }
  };
}

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function companyPage(c: Pick<PqCompany, 'name' | 'product' | 'flagship'>, city: string, staff: number): string {
  return `---\ntype: company\ntitle: ${c.name}\n---\n# ${c.name}\n\n${c.name} builds ${c.product} in ${city}.\n\nThe flagship product of ${c.name} is the ${c.flagship}.\n\n${c.name} employs ${staff} people.\n`;
}

export function personPage(c: Pick<PqCompany, 'slug' | 'name' | 'ceo'>): string {
  return `---\ntype: person\ntitle: ${c.ceo.name}\n---\n# ${c.ceo.name}\n\n${c.ceo.name} is the chief executive of [${c.name}](../${c.slug}.md).\n`;
}

export function visitPage(c: Pick<PqCompany, 'slug' | 'name'>, pet: string, extra = ''): string {
  return `---\ntype: note\ntitle: Visit to ${c.name}\n---\n# Visit to ${c.name}\n\nNotes from a visit to [${c.name}](../${c.slug}.md): the office ${pet} greets every guest.${extra}\n`;
}

export const foundedFact = (c: Pick<PqCompany, 'name'>, year: number) => `${c.name} was founded in ${year}.`;

export const questionFor = (c: Pick<PqCompany, 'name' | 'product'>) =>
  `Where does ${c.name} build its ${c.product}, what is the flagship product of ${c.name}, who is the chief executive of ${c.name}, and what year was ${c.name} founded?`;

export function generatePinnedQuestionsWorld(opts: { seed: number; companies?: number }): PqWorld {
  const n = opts.companies ?? 24;
  if (n % MUTATION_CLASSES.length !== 0) throw new Error(`companies must be a multiple of ${MUTATION_CLASSES.length}`);
  const rng = new Rng(opts.seed * 7919 + 17);
  const name = namer(rng);
  const classes = rng.shuffle(Array.from({ length: n }, (_, i) => MUTATION_CLASSES[i % MUTATION_CLASSES.length]!));
  const companies: PqCompany[] = [];
  const pages: PqPage[] = [];
  const facts: PqFact[] = [];
  for (let i = 0; i < n; i++) {
    const cname = name(2);
    const slug = `companies/${slugOf(cname)}`;
    const ceoName = `${name(2)} ${name(2)}`;
    const c = {
      slug, name: cname, product: rng.pick(PRODUCTS), city: name(2, 'ford'), flagship: name(2, ' Mark ' + rng.int(2, 9)),
      ceo: { slug: `people/${slugOf(ceoName)}`, name: ceoName }, founded: rng.int(1950, 2015), staff: rng.int(20, 900), pet: rng.pick(PETS),
    };
    const mutation = classes[i]!;
    const before: Record<Claim, string> = { city: c.city, flagship: c.flagship, ceo: c.ceo.name, founded: String(c.founded) };
    const after: Record<Claim, string | null> = { ...before };
    const visitSlug = `notes/${slugOf(cname)}-visit`;
    const steps: PqStep[] = [];
    switch (mutation) {
      case 'edit_claim_page': {
        const city = name(2, 'ford');
        steps.push({ op: 'put', page: { slug, content: companyPage(c, city, c.staff) } });
        after.city = city;
        break;
      }
      case 'edit_claim_fact': {
        const year = c.founded + rng.int(1, 6);
        steps.push({ op: 'replace_fact', fact: { entity: slug, text: foundedFact(c, year) } });
        after.founded = String(year);
        break;
      }
      case 'remove_source_page':
        steps.push({ op: 'delete', slug: c.ceo.slug });
        after.ceo = null;
        break;
      case 'contradict_new_page': {
        const city = name(2, 'ford');
        steps.push({ op: 'put', page: { slug: `notes/${slugOf(cname)}-press`, content: `---\ntype: note\ntitle: ${cname} press note\n---\n# ${cname} press note\n\nA press note says [${cname}](../${slug}.md) moved all production of its ${c.product} to ${city}, and ${cname} builds ${c.product} in ${city} from this month.\n` } });
        after.city = city;
        break;
      }
      case 'contradict_existing_page': {
        const city = name(2, 'ford');
        steps.push({ op: 'put', page: { slug: visitSlug, content: visitPage(c, c.pet, ` On the way out we learned that ${cname} moved all production of its ${c.product} to ${city}, and ${cname} builds ${c.product} in ${city} from this month.`) } });
        after.city = city;
        break;
      }
      case 'unrelated_edit_cited_page':
        steps.push({ op: 'put', page: { slug, content: companyPage(c, c.city, c.staff + rng.int(1, 40)) } });
        break;
      case 'unrelated_edit_uncited_page':
        steps.push({ op: 'put', page: { slug: visitSlug, content: visitPage(c, rng.pick(PETS.filter(p => p !== c.pet))) } });
        break;
      case 'unrelated_new_page':
        steps.push({ op: 'put', page: { slug: `notes/${slugOf(cname)}-canteen`, content: `---\ntype: note\ntitle: ${cname} canteen\n---\n# ${cname} canteen\n\nThe canteen at [${cname}](../${slug}.md) serves soup on ${rng.pick(['Mondays', 'Tuesdays', 'Thursdays'])}.\n` } });
        break;
    }
    const company: PqCompany = { ...c, question: questionFor(c), before, after, mutation, affected: AFFECTED[mutation], steps };
    companies.push(company);
    pages.push({ slug, content: companyPage(c, c.city, c.staff) }, { slug: c.ceo.slug, content: personPage(c) }, { slug: visitSlug, content: visitPage(c, c.pet) });
    facts.push({ entity: slug, text: foundedFact(c, c.founded) });
  }
  const world = { seed: opts.seed, generator_version: PINNED_QUESTIONS_GENERATOR_VERSION, companies, pages, facts };
  return { ...world, fingerprint: fingerprint(world) };
}
