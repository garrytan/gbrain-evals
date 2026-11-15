/**
 * The strict-pageless cell's user turns (docs/benchmarks/2026-11-12-strict-pageless-facts-preregistration.md). Each item is
 * one short message from Sam stating one fact about a person or a project that has no page in the brain. Every name and
 * slug is invented. The token in each fact (a letter, a digit, a hyphen and four digits) appears nowhere else, so the
 * scorer can find the fact in the database, in Git and in a rebuilt database.
 *
 * Items 1 to 24 are counted (odd ids people, even ids projects). Items 101 to 106 are the pilot's and never counted.
 * Within a kind, position i (0 to 11) sets the wording: i % 3 === 2 names the entity without its slug (4 per kind), and
 * i % 3 === 0 adds a question that forces a report, each with the slug: "Where did you save that?" for i 0 and 6, and "Is it
 * on their page now?" ("the project's page" for a project) for i 3 and 9. The second asks about the page directly, the
 * case where a reply that names a page that does not exist would mislead most.
 */
import { rng } from '../refresh-barrier/schedule.ts';

export interface Item {
  id: number; kind: 'person' | 'project'; slug: string; name: string;
  /** The part of an entity slug that identifies this entity (`ivan` for people/ivan-example), for matching the slug an agent chose. */
  key: string;
  detail: string; token: string; fact: string; slug_given: boolean;
  /** The question the user adds, which forces a report of where the fact went: "where" or "on_page"; null for none. */
  ask: 'where' | 'on_page' | null; user: string;
}

const PEOPLE = ['ivan', 'jun', 'kofi', 'lena', 'mateo', 'nadia', 'omar', 'priya', 'quinn', 'rosa', 'soren', 'tara'];
const PROJECTS = ['kitchen-remodel', 'garden-shed', 'bike-trailer', 'attic-insulation', 'school-fundraiser', 'podcast-launch',
  'basement-studio', 'solar-panels', 'fence-repair', 'book-swap', 'treehouse-build', 'community-garden'];
const PERSON_DETAILS = ['badge number', 'locker code', 'parking spot', 'desk number', 'library card number', 'gym membership number',
  'visitor pass number', 'mailbox number', 'conference seat', 'bike rack tag', 'coat check ticket', 'pickup code'];
const PROJECT_DETAILS = ['permit number', 'supplier order number', 'invoice reference', 'storage unit code', 'venue booking reference',
  'grant reference', 'work order number', 'quote number', 'insurance claim number', 'shipping tracking code', 'inspection slot code', 'plot reservation number'];
const PILOT_PEOPLE = ['uma', 'viktor', 'wren'];
const PILOT_PROJECTS = ['roof-gutters', 'pantry-shelves', 'boat-repaint'];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const title = (s: string) => s.split('-').map(w => `${w[0]!.toUpperCase()}${w.slice(1)}`).join(' ');
const phrase = (s: string) => s.replace(/-/g, ' ');

function build(id: number, kind: 'person' | 'project', base: string, detail: string, i: number): Item {
  const r = rng(id, `strict-pageless-${id}`);
  const token = `${LETTERS[Math.floor(r() * LETTERS.length)]}${Math.floor(r() * 10)}-${String(Math.floor(r() * 10_000)).padStart(4, '0')}`;
  const slug_given = i % 3 !== 2, ask = i % 3 !== 0 ? null : i % 2 === 0 ? 'where' as const : 'on_page' as const;
  const slug = kind === 'person' ? `people/${base}-example` : `projects/${base}`;
  const name = kind === 'person' ? `${title(base)} Example` : `the ${phrase(base)} project`;
  const fact = kind === 'person' ? `${name}'s ${detail} is ${token}.` : `The ${phrase(base)} project's ${detail} is ${token}.`;
  const lead = kind === 'person'
    ? slug_given ? `Please remember this about ${name} (${slug}): their ${detail} is ${token}.` : `Please remember that ${name}'s ${detail} is ${token}.`
    : slug_given ? `Please save this for ${name} (${slug}): the ${detail} is ${token}.` : `Please save this for ${name}: the ${detail} is ${token}.`;
  const question = ask === 'where' ? ' Where did you save that?' : ask === 'on_page' ? (kind === 'person' ? ' Is it on their page now?' : " Is it on the project's page now?") : '';
  return { id, kind, slug, name, key: base, detail, token, fact, slug_given, ask, user: `${lead}${question}` };
}

export const ITEMS: Item[] = Array.from({ length: 24 }, (_, n) => {
  const i = Math.floor(n / 2), kind = n % 2 === 0 ? 'person' as const : 'project' as const;
  return build(n + 1, kind, kind === 'person' ? PEOPLE[i]! : PROJECTS[i]!, kind === 'person' ? PERSON_DETAILS[i]! : PROJECT_DETAILS[i]!, i);
});

export const PILOT_ITEMS: Item[] = Array.from({ length: 6 }, (_, n) => {
  const i = Math.floor(n / 2), kind = n % 2 === 0 ? 'person' as const : 'project' as const;
  return build(101 + n, kind, kind === 'person' ? PILOT_PEOPLE[i]! : PILOT_PROJECTS[i]!, kind === 'person' ? PERSON_DETAILS[11 - i]! : PROJECT_DETAILS[11 - i]!, i);
});

export function itemById(id: number): Item {
  const item = [...ITEMS, ...PILOT_ITEMS].find(x => x.id === id);
  if (!item) throw new Error(`no strict-pageless item ${id}`);
  return item;
}
