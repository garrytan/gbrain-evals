/**
 * G4 task generator: wrong entity at agent level (GBEV-55, gap rank 4).
 *
 * Wintermute estimates about 8 costly mix-ups of same-named people and companies. Each task is a small fictional brain
 * with a set of confusable pages and a question whose answer is the entity id (page slug) of the right one:
 *
 *   moved_namesake   two people with one name at different firms, one of whom has since moved.
 *   family_surname   a family sharing a surname.
 *   company_handle   a company named like its founder's handle.
 *   father_son       a father and son with one name.
 *
 * Variant 0 of each pattern is Wintermute's fictional template (two Dana Kims at Fernway and Orchid; Lumen; a father and
 * son); the rest draw invented names from the seed.
 */
import { Rng, fingerprint } from './seeded.ts';

export const G4_PATTERNS = ['moved_namesake', 'family_surname', 'company_handle', 'father_son'] as const;
export type G4Pattern = typeof G4_PATTERNS[number];
export const G4_DEFAULT_SEED = 20261111;
export const G4_DEFAULT_TASKS = 60;

export interface EntityTask {
  id: string;
  pattern: G4Pattern;
  variant: number;
  pages: Array<{ slug: string; markdown: string }>;
  question: string;
  gold: string;
  /** Every confusable id in the task, the gold included. */
  candidates: string[];
  /** The page that disambiguates; the scripted fake opens it. */
  evidence_page: string;
}

const FIRST = ['Dana', 'Avery', 'Rowan', 'Kai', 'Sasha', 'Morgan', 'Remy', 'Jules', 'Emery', 'Noa', 'Skye', 'Arden'];
const LAST = ['Kim', 'Okafor', 'Brandt', 'Lindgren', 'Moreau', 'Tanaka', 'Castillo', 'Nakamura', 'Ferraro', 'Adeyemi'];
const FIRMS = ['Fernway', 'Orchid', 'Brightwell', 'Halcyon', 'Kitefin', 'Saltmarsh', 'Mossgrove', 'Driftline'];
const EVENTS = ['the Harbor Founders dinner', 'the Climate Tools demo day', 'the Seed Summit panel', 'the Robotics meetup'];
const HANDLES = ['lumen', 'quill', 'nova', 'ember', 'atlas', 'zephyr', 'tarn', 'onyx'];
const SCHOOLS = ['Westbrook Academy', 'Riverside High', 'Hillcrest School', 'Lakemont Prep'];
const SHOPS = ['a bakery on Elm Street', 'a bike shop on Pier 3', 'a bookshop on Fourth Avenue', 'a florist on Mill Road'];

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pg = (type: string, title: string, body: string) => `---\ntype: ${type}\ntitle: ${title}\n---\n\n${body}\n`;

function makeTask(rng: Rng, pattern: G4Pattern, variant: number, index: number): EntityTask {
  const t = variant === 0;
  const id = `g4-${String(index + 1).padStart(3, '0')}-${pattern}`;
  const n = String(index + 1);
  switch (pattern) {
    case 'moved_namesake': {
      const name = t ? 'Dana Kim' : `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
      const [a, b, dest] = t ? ['Fernway', 'Orchid', 'Brightwell'] : rng.shuffle(FIRMS).slice(0, 3);
      const event = rng.pick(EVENTS);
      const moved = `people/${slugify(name)}-${slugify(a)}`;
      const stayed = `people/${slugify(name)}-${slugify(b)}`;
      const ev = `events/${slugify(event)}-${n}`;
      return { id, pattern, variant, gold: moved, candidates: [moved, stayed], evidence_page: ev,
        question: `Give the page id of the ${name} I met at ${event}.`,
        pages: [
          { slug: moved, markdown: pg('person', name, `${name} worked at ${a} until March, then moved to ${dest}.`) },
          { slug: stayed, markdown: pg('person', name, `${name} is a partner at ${b}.`) },
          { slug: ev, markdown: pg('event', event, `Met ${name}, who joined ${dest} in March after leaving ${a}.`) },
        ] };
    }
    case 'family_surname': {
      const last = t ? 'Okafor' : rng.pick(LAST);
      const [p, c, u] = rng.shuffle(FIRST).slice(0, 3);
      const shop = rng.pick(SHOPS);
      const ids = [p, c, u].map(f => `people/${slugify(f)}-${slugify(last)}-${n}`);
      const family = `notes/${slugify(last)}-family-${n}`;
      return { id, pattern, variant, gold: ids[0], candidates: ids, evidence_page: family,
        question: `Which ${last} runs ${shop}? Give the page id.`,
        pages: [
          { slug: ids[0], markdown: pg('person', `${p} ${last}`, `${p} ${last} is a parent in the ${last} family.`) },
          { slug: ids[1], markdown: pg('person', `${c} ${last}`, `${c} ${last} is a student and helps out on weekends.`) },
          { slug: ids[2], markdown: pg('person', `${u} ${last}`, `${u} ${last} is an accountant and the family's uncle.`) },
          { slug: family, markdown: pg('note', `The ${last} family`, `${p} ${last} runs ${shop}; ${c} works the till on Saturdays; ${u} does the books.`) },
        ] };
    }
    case 'company_handle': {
      const handle = t ? 'lumen' : rng.pick(HANDLES);
      const co = handle[0].toUpperCase() + handle.slice(1);
      const founder = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
      const coId = `companies/${handle}-${n}`;
      const fId = `people/${slugify(founder)}-${n}`;
      const age = rng.int(29, 58);
      return { id, pattern, variant, gold: fId, candidates: [fId, coId], evidence_page: fId,
        question: `I want the age of ${co}'s founder, who posts as @${handle}. Which page holds the founder's age? Give its page id.`,
        pages: [
          { slug: coId, markdown: pg('company', co, `${co} is a startup founded by ${founder}. The company account posts as @${handle}hq.`) },
          { slug: fId, markdown: pg('person', founder, `${founder}, known online as @${handle}, founded ${co}. Age ${age}.`) },
        ] };
    }
    case 'father_son': {
      const name = t ? 'Ray Castillo' : `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
      const school = rng.pick(SCHOOLS);
      const fatherYear = rng.int(1950, 1968);
      const sonYear = fatherYear + rng.int(26, 34);
      const father = `people/${slugify(name)}-${fatherYear}`;
      const son = `people/${slugify(name)}-${sonYear}`;
      return { id, pattern, variant, gold: son, candidates: [son, father], evidence_page: son,
        question: `Which ${name} is the son, the one I asked about at ${school}? Give the page id.`,
        pages: [
          { slug: father, markdown: pg('person', name, `${name}, born ${fatherYear}, retired engineer and father of ${name} (born ${sonYear}).`) },
          { slug: son, markdown: pg('person', name, `${name}, born ${sonYear}, son of ${name} (born ${fatherYear}); studied at ${school}.`) },
        ] };
    }
  }
}

export function generateEntityTasks(opts: { seed?: number; n?: number } = {}): EntityTask[] {
  const rng = new Rng(opts.seed ?? G4_DEFAULT_SEED);
  const n = opts.n ?? G4_DEFAULT_TASKS;
  return Array.from({ length: n }, (_, i) => {
    const task = makeTask(rng, G4_PATTERNS[i % G4_PATTERNS.length], Math.floor(i / G4_PATTERNS.length), i);
    return { ...task, pages: rng.shuffle(task.pages) };
  });
}

export function entityTasksDigest(tasks: readonly EntityTask[]): string { return fingerprint(tasks); }

if (import.meta.main) {
  const tasks = generateEntityTasks();
  console.log(JSON.stringify({ tasks: tasks.length, digest: entityTasksDigest(tasks), first: tasks.slice(0, 4).map(t => ({ id: t.id, question: t.question, gold: t.gold, candidates: t.candidates })) }, null, 2));
}
