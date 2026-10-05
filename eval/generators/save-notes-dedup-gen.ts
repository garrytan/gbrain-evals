/**
 * P5 H5b: "save these notes" tasks over a seeded entity world.
 *
 * A world is a brain of existing person and company pages (the seed pages)
 * plus tasks. Each task is a note that mentions ten entities:
 *   existing (30%)  an entity that already has a seed page, named by a variant
 *                   (nickname, initial, one-letter typo, declared alias, changed
 *                   surname, first name plus company; for companies the short
 *                   name, a legal suffix or a typo). The note repeats facts from
 *                   the seed page (company, city) so the identity is decidable.
 *   similar (20%)   a different entity whose name resembles a seed page
 *                   (namesake with the same full name, a near name one or two
 *                   letters away, a company sharing the stem) with a different
 *                   company, role and city, so the right outcome is a new page.
 *                   A namesake's line says it is not the person at the seed
 *                   page's company: the same name at a new employer could
 *                   otherwise be a job change, and the label would be unsound.
 *   new (50%)       an entity with no similar page.
 * Every mention carries one marker: an invented project codename that appears
 * nowhere else in the world. Where the marker lands after the agent saved the
 * note decides the outcome (save-notes-dedup.ts classifies it).
 *
 * Names are fictional: person surnames end in "-Example", company stems are
 * invented words. Templates and pools: development set A lives here. A held-out
 * set is authored by the custodian outside the repository and reaches the
 * runner only from a custody file (`sealedTemplates`); any other set name is refused.
 */
import { Rng, fingerprint } from './seeded.ts';

export const SAVE_NOTES_GENERATOR_VERSION = 'save-notes-dedup-gen/1';
export const DEV_SEEDS: readonly number[] = [1, 2, 3];
export const TEMPLATE_SETS = ['A'] as const;
export const MENTIONS_PER_TASK = { existing: 3, similar: 2, new: 5 } as const;

export const PERSON_VARIANTS = ['nickname', 'initial', 'typo', 'alias', 'changed-surname', 'first-name-company'] as const;
export const COMPANY_VARIANTS = ['short-name', 'legal-suffix', 'typo'] as const;
export const PERSON_SIMILAR = ['namesake', 'near-name'] as const;
export const COMPANY_SIMILAR = ['sibling-stem'] as const;

export interface SaveNotesTemplates {
  first_names: string[];
  /** Nickname for a first name; used by the nickname variant and declared aliases. */
  nicknames: Record<string, string>;
  surname_stems: string[];
  company_stems: string[];
  industries: string[];
  legal_suffixes: string[];
  cities: string[];
  roles: string[];
  codename_parts: [string[], string[]];
  events: string[];
  /** Sentences with {name} {company} {role} {city} {marker} {prior} placeholders. */
  person_line: string[];
  company_line: string[];
  /** For changed-surname mentions: {name} is the new name, {prior} the name on the seed page. */
  changed_surname_line: string[];
  /** For namesakes (same full name, different person): {prior_company} is the employer on the seed page, so the note itself says they differ. */
  namesake_line: string[];
  intro: string[];
  task_prompt: string[];
}

export const TEMPLATES_A: SaveNotesTemplates = {
  first_names: ['Robert', 'Katherine', 'William', 'Elizabeth', 'Michael', 'Jennifer', 'Thomas', 'Margaret', 'Daniel', 'Patricia',
    'Joseph', 'Victoria', 'Andrew', 'Alexandra', 'Nicholas', 'Rebecca', 'Jonathan', 'Samantha', 'Christopher', 'Abigail',
    'Theodore', 'Josephine', 'Benjamin', 'Gabriella', 'Frederick', 'Natalie', 'Matthew', 'Caroline', 'Edward', 'Eleanor'],
  nicknames: { Robert: 'Bob', Katherine: 'Kate', William: 'Bill', Elizabeth: 'Liz', Michael: 'Mike', Jennifer: 'Jen', Thomas: 'Tom',
    Margaret: 'Peggy', Daniel: 'Dan', Patricia: 'Trish', Joseph: 'Joe', Victoria: 'Tori', Andrew: 'Drew', Alexandra: 'Sasha',
    Nicholas: 'Nick', Rebecca: 'Becky', Jonathan: 'Jon', Samantha: 'Sam', Christopher: 'Chris', Abigail: 'Abby', Theodore: 'Teddy',
    Josephine: 'Jo', Benjamin: 'Ben', Gabriella: 'Gabby', Frederick: 'Fred', Natalie: 'Nat', Matthew: 'Matt', Caroline: 'Carrie',
    Edward: 'Ned', Eleanor: 'Nell' },
  surname_stems: ['Ashcombe', 'Birchley', 'Calloway', 'Dewhurst', 'Ellsworth', 'Farrington', 'Gilchrist', 'Hartwell', 'Islington', 'Jessup',
    'Kendrick', 'Lindqvist', 'Marchetti', 'Northam', 'Okonkwo', 'Prescott', 'Quilliam', 'Rourke', 'Sandoval', 'Tremaine',
    'Vasquez', 'Whitmore', 'Yardley', 'Abernathy', 'Bellamy', 'Castellano', 'Delacroix', 'Fairweather', 'Galloway', 'Hollister',
    'Iverson', 'Kowalczyk', 'Lancaster', 'Montague', 'Nakamura', 'Ostrowski', 'Pendleton', 'Radcliffe', 'Sinclair', 'Thackeray'],
  company_stems: ['Brightforge', 'Cobaltine', 'Duskwater', 'Emberline', 'Fernhollow', 'Granitebay', 'Halcyonix', 'Ironvale', 'Juniperworks',
    'Kelpstone', 'Lumenreach', 'Nightjar', 'Opalcrest', 'Pinegate', 'Quartzlane', 'Ravenmoor', 'Saltmarsh', 'Tidewell', 'Umberfield', 'Vantorra'],
  industries: ['Robotics', 'Analytics', 'Logistics', 'Biosciences', 'Foods', 'Energy', 'Software', 'Materials'],
  legal_suffixes: ['Inc.', 'LLC', 'Ltd.', 'Corp.'],
  cities: ['Lisbon', 'Denver', 'Osaka', 'Nairobi', 'Toronto', 'Austin', 'Melbourne', 'Bogota', 'Helsinki', 'Pittsburgh', 'Seoul', 'Dublin', 'Phoenix', 'Lyon', 'Accra'],
  roles: ['head of product', 'staff engineer', 'CFO', 'founder', 'design lead', 'VP of sales', 'research scientist', 'operations manager',
    'general counsel', 'data lead', 'COO', 'marketing director', 'principal investor', 'hardware engineer', 'recruiter'],
  codename_parts: [['Copper', 'Velvet', 'Silent', 'Amber', 'Crimson', 'Hollow', 'Lunar', 'Granite', 'Saffron', 'Cobalt', 'Willow', 'Ember',
    'Frost', 'Quill', 'Marble', 'Thistle', 'Harbor', 'Juniper', 'Basalt', 'Indigo'],
  ['wren', 'fox', 'heron', 'lynx', 'otter', 'finch', 'marten', 'ibis', 'stoat', 'plover', 'badger', 'tern', 'vole', 'egret', 'shrike',
    'gecko', 'osprey', 'newt', 'kestrel', 'bison']],
  events: ['the climate tech dinner', 'the founders breakfast', 'the hardware meetup', 'the partner offsite', 'the conference in Lisbon', 'the demo day afterparty'],
  person_line: [
    'Met {name}, {role} at {company} in {city}. {name} is running Project {marker}.',
    'Long chat with {name} ({role}, {company}, based in {city}); currently heads Project {marker}.',
    'Caught up with {name} from {company} ({city}), the {role} there, who is leading Project {marker}.',
  ],
  company_line: [
    'Heard a pitch from {company}, a company in {city}; their new product is called {marker}.',
    '{company} ({city}) is about to launch {marker}.',
    'Learned that {company}, out of {city}, is building {marker}.',
  ],
  changed_surname_line: [
    'Ran into {name} (previously {prior}), {role} at {company} in {city}, now running Project {marker}.',
    'Coffee with {name}, who went by {prior} until last year; {role} at {company} in {city}, leading Project {marker}.',
  ],
  namesake_line: [
    'Met a different {name} (not the one at {prior_company}): {role} at {company} in {city}, running Project {marker}.',
    'Another {name}, unrelated to the {name} at {prior_company}, is the {role} at {company} in {city} and leads Project {marker}.',
  ],
  intro: ['Notes from {event}:', 'Raw notes after {event}:', 'People and companies from {event}:'],
  task_prompt: [
    'Please save these notes to my brain so I can find these people and companies later.',
    'Save these notes into my brain.',
  ],
};
const DEV_TEMPLATES: Record<(typeof TEMPLATE_SETS)[number], SaveNotesTemplates> = { A: TEMPLATES_A };

export function validateTemplates(t: unknown): SaveNotesTemplates {
  const o = t as Record<string, unknown>;
  const problems: string[] = [];
  const lists: Array<[keyof SaveNotesTemplates, number]> = [['first_names', 12], ['surname_stems', 20], ['company_stems', 10], ['industries', 4],
    ['legal_suffixes', 1], ['cities', 6], ['roles', 6], ['events', 1], ['person_line', 1], ['company_line', 1], ['changed_surname_line', 1], ['namesake_line', 1], ['intro', 1], ['task_prompt', 1]];
  for (const [k, min] of lists) if (!Array.isArray(o?.[k]) || (o[k] as unknown[]).length < min || (o[k] as unknown[]).some(x => typeof x !== 'string' || !x.trim())) problems.push(`${k} must list at least ${min} strings`);
  if (!o?.nicknames || typeof o.nicknames !== 'object') problems.push('nicknames must map first names to nicknames');
  const parts = o?.codename_parts as unknown[];
  if (!Array.isArray(parts) || parts.length !== 2 || parts.some(p => !Array.isArray(p) || p.length < 8)) problems.push('codename_parts must be two lists of at least eight parts');
  for (const s of (o?.namesake_line as string[] | undefined) ?? []) if (!s.includes('{prior_company}')) problems.push('namesake_line lines need {prior_company}');
  for (const k of ['person_line', 'changed_surname_line', 'namesake_line'] as const) for (const s of (o?.[k] as string[] | undefined) ?? []) if (!s.includes('{marker}') || !s.includes('{name}')) problems.push(`${k} lines need {name} and {marker}`);
  for (const s of (o?.company_line as string[] | undefined) ?? []) if (!s.includes('{marker}') || !s.includes('{company}')) problems.push('company_line lines need {company} and {marker}');
  if (problems.length) throw new Error(`save-notes templates: ${problems.join('; ')}`);
  return o as unknown as SaveNotesTemplates;
}

export interface SeedEntity {
  id: string; kind: 'person' | 'company'; slug: string; title: string; aliases: string[];
  /** person: employer name, role, city. company: industry, city. */
  company?: string; role?: string; city: string; industry?: string;
}
export type MentionKind = 'existing' | 'similar' | 'new';
export interface Mention {
  id: string; kind: MentionKind; entity_kind: 'person' | 'company';
  /** Variant family (existing), resemblance family (similar), or `new`. */
  family: string;
  /** The name the note uses. */
  text: string;
  /** Every name that identifies this mention's entity (for existing: the seed page's title and aliases too). */
  names: string[];
  marker: string;
  /** existing: the seed page this is; similar: the seed page it resembles. */
  seed_slug: string | null;
  line: string;
}
export interface SaveNotesTask { id: string; seed: number; note: string; prompt: string; mentions: Mention[] }
export interface SaveNotesWorld {
  seed: number; templates: string; entities: SeedEntity[]; pages: Array<{ path: string; content: string }>; tasks: SaveNotesTask[]; fingerprint: string;
}

export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const normName = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

export function renderSeedPage(e: SeedEntity): string {
  const fm = ['---', `type: ${e.kind}`, `title: ${JSON.stringify(e.title)}`];
  if (e.aliases.length) fm.push(`aliases: [${e.aliases.map(a => JSON.stringify(a)).join(', ')}]`);
  fm.push('---', '');
  const body = e.kind === 'person'
    ? `# ${e.title}\n\n${e.title} is the ${e.role} at ${e.company}, based in ${e.city}.\n`
    : `# ${e.title}\n\n${e.title} is a ${e.industry!.toLowerCase()} company based in ${e.city}.\n`;
  return `${fm.join('\n')}\n${body}`;
}

/** Swap two adjacent interior letters (a one-edit typo that keeps the first and last letters). */
function typo(word: string, rng: Rng): string {
  if (word.length < 5) return word + word.at(-1);
  const i = rng.int(1, word.length - 3);
  return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
}
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? `{${k}}`);

export function generateSaveNotesWorld(opts: {
  seed: number; tasks: number; templates?: string; sealedTemplates?: { id: string; templates: SaveNotesTemplates };
  people?: number; companies?: number;
}): SaveNotesWorld {
  if (opts.templates !== undefined && !(TEMPLATE_SETS as readonly string[]).includes(opts.templates)) {
    throw new Error(`template set ${opts.templates} is held out: only the custodian's run reads it, from a --phrasing-file in custody`);
  }
  const t = opts.sealedTemplates ? validateTemplates(opts.sealedTemplates.templates) : DEV_TEMPLATES[(opts.templates ?? 'A') as 'A'];
  const label = opts.sealedTemplates ? `sealed:${opts.sealedTemplates.id}` : (opts.templates ?? 'A');
  const rng = new Rng(opts.seed * 7_919 + 2_026);
  const nPeople = opts.people ?? 30;
  const nCompanies = opts.companies ?? 12;

  const usedNames = new Set<string>();
  const companies: SeedEntity[] = [];
  const stems = rng.shuffle(t.company_stems);
  for (let i = 0; i < nCompanies; i++) {
    const stem = stems[i % stems.length];
    const industry = rng.pick(t.industries);
    const title = `${stem} ${industry}`;
    if (usedNames.has(normName(title))) continue;
    usedNames.add(normName(title));
    companies.push({ id: `c${companies.length + 1}`, kind: 'company', slug: `companies/${slugify(title)}`, title, aliases: [], industry, city: rng.pick(t.cities) });
  }
  const people: SeedEntity[] = [];
  const firsts = t.first_names.filter(f => t.nicknames[f]);
  for (let tries = 0; people.length < nPeople && tries < 10_000; tries++) {
    const title = `${rng.pick(firsts)} ${rng.pick(t.surname_stems)}-Example`;
    if (usedNames.has(normName(title))) continue;
    usedNames.add(normName(title));
    const employer = rng.pick(companies);
    people.push({ id: `p${people.length + 1}`, kind: 'person', slug: `people/${slugify(title)}`, title, aliases: [], company: employer.title, role: rng.pick(t.roles), city: employer.city });
  }
  // A quarter of the people declare an alias on their page (the alias variant needs one).
  for (const p of people.filter((_, i) => i % 4 === 0)) p.aliases.push(`${t.nicknames[p.title.split(' ')[0]]} ${p.title.split(' ').slice(1).join(' ')}`);
  const entities = [...companies, ...people];

  const codenames = new Set<string>();
  const marker = () => {
    for (;;) {
      const c = `${rng.pick(t.codename_parts[0])}${rng.pick(t.codename_parts[1])}`;
      if (!codenames.has(c)) { codenames.add(c); return c; }
      if (codenames.size >= t.codename_parts[0].length * t.codename_parts[1].length) throw new Error('codename parts exhausted');
    }
  };
  const freshPerson = (taken: Set<string>): string => {
    for (let k = 0; k < 10_000; k++) {
      const n = `${rng.pick(t.first_names)} ${rng.pick(t.surname_stems)}-Example`;
      const key = normName(n);
      const surname = n.split(' ')[1];
      if (!usedNames.has(key) && !taken.has(key) && !people.some(p => p.title.split(' ')[1] === surname)) return n;
    }
    throw new Error('person pools exhausted');
  };
  const freshCompany = (taken: Set<string>): string => {
    for (let k = 0; k < 10_000; k++) {
      const n = `${rng.pick(t.company_stems)} ${rng.pick(t.industries)}`;
      const stem = n.split(' ')[0];
      if (!usedNames.has(normName(n)) && !taken.has(normName(n)) && !companies.some(c => c.title.startsWith(`${stem} `))) return n;
    }
    // Every stem is a seed company: new companies take an invented two-part stem instead.
    for (let k = 0; k < 10_000; k++) {
      const n = `${rng.pick(t.codename_parts[0])}${rng.pick(t.codename_parts[1])} ${rng.pick(t.industries)}`;
      if (!usedNames.has(normName(n)) && !taken.has(normName(n))) return n;
    }
    throw new Error('company pools exhausted');
  };

  const tasks: SaveNotesTask[] = [];
  for (let ti = 0; ti < opts.tasks; ti++) {
    const id = `s${opts.seed}-t${String(ti + 1).padStart(3, '0')}`;
    const pick = rng.shuffle(entities);
    const existing = pick.slice(0, MENTIONS_PER_TASK.existing);
    const similarTo = pick.slice(MENTIONS_PER_TASK.existing, MENTIONS_PER_TASK.existing + MENTIONS_PER_TASK.similar);
    const taken = new Set<string>();
    const mentions: Mention[] = [];
    const lineFor = (kind: 'person' | 'company', v: Record<string, string>) => fill(rng.pick(kind === 'person' ? t.person_line : t.company_line), v);
    for (const e of existing) {
      const m = marker();
      const [first, ...rest] = e.title.split(' ');
      const surname = rest.join(' ');
      let family: string;
      let text: string;
      let line: string;
      if (e.kind === 'person') {
        const options = PERSON_VARIANTS.filter(f => f !== 'alias' || e.aliases.length);
        family = rng.pick(options);
        const nick = `${t.nicknames[first]} ${surname}`;
        const values = { company: e.company!, role: e.role!, city: e.city, marker: m };
        if (family === 'changed-surname') {
          text = `${first} ${rng.pick(t.surname_stems.filter(s => !e.title.includes(s)))}-Example`;
          line = fill(rng.pick(t.changed_surname_line), { ...values, name: text, prior: e.title });
        } else {
          text = family === 'nickname' ? nick : family === 'initial' ? `${first[0]}. ${surname}` : family === 'typo' ? `${first} ${typo(surname.replace(/-Example$/, ''), rng)}-Example`
            : family === 'alias' ? e.aliases[0] : first;
          line = lineFor('person', { ...values, name: text });
        }
      } else {
        family = rng.pick(COMPANY_VARIANTS);
        const [stem, industry] = [first, surname];
        text = family === 'short-name' ? stem : family === 'legal-suffix' ? `${e.title} ${rng.pick(t.legal_suffixes)}` : `${typo(stem, rng)} ${industry}`;
        line = lineFor('company', { company: text, city: e.city, marker: m });
      }
      taken.add(normName(text));
      mentions.push({ id: `${id}-m${mentions.length + 1}`, kind: 'existing', entity_kind: e.kind, family, text, names: [...new Set([text, e.title, ...e.aliases])], marker: m, seed_slug: e.slug, line });
    }
    for (const e of similarTo) {
      const m = marker();
      const otherCity = rng.pick(t.cities.filter(c => c !== e.city));
      if (e.kind === 'person') {
        const family = rng.pick(PERSON_SIMILAR);
        const [first, ...rest] = e.title.split(' ');
        let text = e.title;
        if (family === 'near-name') {
          const alt = t.first_names.filter(f => f !== first && f[0] === first[0]);
          text = alt.length ? `${rng.pick(alt)} ${rest.join(' ')}` : `${first} ${typo(rest.join(' ').replace(/-Example$/, ''), rng)}-Example`;
        }
        const otherCompany = rng.pick(companies.filter(c => c.title !== e.company)).title;
        const role = rng.pick(t.roles.filter(r => r !== e.role));
        taken.add(normName(text));
        mentions.push({ id: `${id}-m${mentions.length + 1}`, kind: 'similar', entity_kind: 'person', family, text, names: [text], marker: m, seed_slug: e.slug,
          line: family === 'namesake'
            ? fill(rng.pick(t.namesake_line), { name: text, company: otherCompany, role, city: otherCity, marker: m, prior_company: e.company! })
            : lineFor('person', { name: text, company: otherCompany, role, city: otherCity, marker: m }) });
      } else {
        const stem = e.title.split(' ')[0];
        const text = `${stem} ${rng.pick(t.industries.filter(i => !e.title.endsWith(i)))}`;
        taken.add(normName(text));
        mentions.push({ id: `${id}-m${mentions.length + 1}`, kind: 'similar', entity_kind: 'company', family: 'sibling-stem', text, names: [text], marker: m, seed_slug: e.slug,
          line: lineFor('company', { company: text, city: otherCity, marker: m }) });
      }
    }
    for (let k = 0; k < MENTIONS_PER_TASK.new; k++) {
      const m = marker();
      const isPerson = rng.float() < 0.7;
      if (isPerson) {
        const text = freshPerson(taken);
        taken.add(normName(text));
        mentions.push({ id: `${id}-m${mentions.length + 1}`, kind: 'new', entity_kind: 'person', family: 'new', text, names: [text], marker: m, seed_slug: null,
          line: lineFor('person', { name: text, company: freshCompany(taken), role: rng.pick(t.roles), city: rng.pick(t.cities), marker: m }) });
      } else {
        const text = freshCompany(taken);
        taken.add(normName(text));
        mentions.push({ id: `${id}-m${mentions.length + 1}`, kind: 'new', entity_kind: 'company', family: 'new', text, names: [text], marker: m, seed_slug: null,
          line: lineFor('company', { company: text, city: rng.pick(t.cities), marker: m }) });
      }
    }
    const order = rng.shuffle(mentions);
    const note = `${fill(rng.pick(t.intro), { event: rng.pick(t.events) })}\n\n${order.map(x => `- ${x.line}`).join('\n')}\n`;
    tasks.push({ id, seed: opts.seed, note, prompt: `${rng.pick(t.task_prompt)}\n\n${note}`, mentions });
  }
  const pages = entities.map(e => ({ path: `${e.slug}.md`, content: renderSeedPage(e) }));
  const world = { seed: opts.seed, templates: label, entities, pages, tasks };
  return { ...world, fingerprint: fingerprint({ v: SAVE_NOTES_GENERATOR_VERSION, ...world }) };
}
