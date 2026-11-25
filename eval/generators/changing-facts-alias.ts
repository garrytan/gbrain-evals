/**
 * The described-subject pools of changing-facts-gen@3 (eval/generators/changing-facts-gen.ts, profile alias): the
 * names, aliases, properties and relations that let a world's questions describe their subject instead of naming it.
 * GBEV-3's brief for the weekly line's re-plan: no shared keyword links a question to its sessions. Sessions refer to
 * people and things by role, nickname, alias or misspelling, and questions describe the subject, some across two steps.
 *
 * Every entity of a @3 world has an alias set: its canonical name (said only in its introduction line), a nickname, a
 * misspelling of its name and a role ("my old flatmate", "the big renewal"); a person can also be named only by a
 * pronoun after an antecedent in the same line. Each fact line about the entity uses one of the non-canonical aliases,
 * and the plan records which. Two link lines tie the aliases together (canonical to nickname, nickname to role); the
 * misspelling is tied by its likeness alone. A property line ("Annie taught me to make kimchi") gives the entity the
 * property its questions describe it by ("the person who taught me to make kimchi"), and a relation line ("Bart is
 * Annie's landlord") lets a question describe one entity through another ("the landlord of the person who taught me
 * to make kimchi"). Property and relation lines sit only in sessions with no tracked fact line, so a question's
 * describing words never share a session with its evidence.
 *
 * All names are fictional. Every pool entry names its key terms: the words that pick the entity out, which no fact
 * line, alias or template may use (the planner checks it, and changing-facts-alias-checks.ts checks it again).
 */
import type { EntityType } from './changing-facts-gen.ts';

/** A person's canonical first name, the nickname the history uses and the pronoun a pronoun-only line uses. */
export const ALIAS_FIRST_NAMES: ReadonlyArray<readonly [string, string, 'she' | 'he']> = [
  ['Anneliese', 'Annie', 'she'], ['Bartholomew', 'Bart', 'he'], ['Cornelia', 'Nell', 'she'], ['Dominik', 'Dom', 'he'], ['Evangeline', 'Evie', 'she'],
  ['Frederik', 'Freddie', 'he'], ['Georgina', 'Georgie', 'she'], ['Henrietta', 'Hettie', 'she'], ['Ignatius', 'Iggy', 'he'], ['Josephine', 'Josie', 'she'],
  ['Konstantin', 'Kostya', 'he'], ['Leopold', 'Leo', 'he'], ['Magdalena', 'Magda', 'she'], ['Nathaniel', 'Nate', 'he'], ['Octavia', 'Tavi', 'she'],
  ['Peregrine', 'Perry', 'he'], ['Rosalind', 'Roz', 'she'], ['Sebastian', 'Seb', 'he'], ['Clementine', 'Clem', 'she'], ['Augustin', 'Gus', 'he'],
  ['Wilhelmina', 'Mina', 'she'], ['Montgomery', 'Monty', 'he'], ['Philippa', 'Pippa', 'she'], ['Reginald', 'Reggie', 'he'], ['Jacqueline', 'Jacqui', 'she'],
  ['Isidore', 'Izzy', 'he'], ['Lucinda', 'Cindy', 'she'], ['Tobias', 'Toby', 'he'],
];
export const ALIAS_SURNAMES = [
  'Okafor', 'Lindqvist', 'Marchetti', 'Halloran', 'Petrovic', 'Nakamura', 'Brennan', 'Achterberg', 'Delacroix', 'Fairbairn', 'Gallagher', 'Haddad',
  'Ivanova', 'Jansen', 'Kowalski', 'Lefebvre', 'Novak', 'Oyelaran', 'Pereira', 'Quintero', 'Rasmussen', 'Sandoval', 'Takahashi', 'Whitlock', 'Yilmaz',
  'Zielinski', 'Abernathy', 'Dunleavy',
];
/** Companies: the canonical name, and the short name the history uses as its nickname. */
export const ALIAS_COMPANIES: ReadonlyArray<readonly [string, string]> = [
  ['Fenwick Labs', 'Fenwick'], ['Corbel Systems', 'Corbel'], ['Ashgrove Foods', 'Ashgrove'], ['Halcyon Freight', 'Halcyon'], ['Marlpit Software', 'Marlpit'],
  ['Quayside Health', 'Quayside'], ['Tidewell Energy', 'Tidewell'], ['Brackenridge Media', 'Brackenridge'], ['Stonechat Robotics', 'Stonechat'],
  ['Vantor Biotech', 'Vantor'], ['Lowmoor Retail', 'Lowmoor'], ['Elderflower Travel', 'Elderflower'], ['Wrenfield Optics', 'Wrenfield'],
  ['Gannetry Logistics', 'Gannetry'], ['Moorcroft Dairy', 'Moorcroft'], ['Pellucid Clinics', 'Pellucid'],
];
/** Projects (canonical "Project <name>", nickname the bare name) and deals (canonical "the <name> deal", nickname the bare name). */
export const ALIAS_PROJECTS = ['Kestrel', 'Bluebell', 'Granite', 'Ostrava', 'Sandpiper', 'Tamarind', 'Halyard', 'Pennant', 'Lodestar', 'Mistletoe', 'Corncrake', 'Larkhill', 'Quillon', 'Saltire'];
export const ALIAS_DEALS = ['Harbor', 'Juniper', 'Alder', 'Beacon', 'Cobalt', 'Marlow', 'Tamsin', 'Wexley', 'Ridgeway', 'Solent', 'Fairholme', 'Carrick'];

/** Role aliases: how the history refers to an entity by what it is to the user, never by name. */
export const ALIAS_ROLES: Readonly<Record<EntityType, readonly string[]>> = {
  person: [
    'my old flatmate', 'my running buddy', 'my former teammate', 'my neighbour across the hall', 'my oldest school friend', 'my squash partner',
    'the new hire in finance', 'my study buddy', 'my carpool partner', 'my allotment neighbour', 'my gym buddy', 'my old roommate',
    'the friend from the choir', 'my accountant', 'my yoga teacher', 'my tennis partner', 'my old lab partner', 'the volunteer coordinator', 'my bridge partner',
  ],
  company: [
    'our biggest client', 'the client in the old mill building', 'the outfit with the green logo', 'our newest customer', 'the firm downstairs',
    'the startup we advise', 'our oldest account', 'the client with the glass tower', 'the family firm', 'the agency we share an office with',
    'the client from the trade fair', 'the company across the canal',
  ],
  project: [
    'the side project', 'the skunkworks thing', 'the big rebuild', 'the overdue project', 'the pet project', 'the board-mandated project', 'the moonshot',
    'the quick-win project', 'the cross-team project', 'the summer project', 'the legacy cleanup',
  ],
  deal: [
    'the big renewal', 'the multi-year deal', 'the enterprise deal', 'the tricky renewal', 'the expansion deal', 'the flagship deal', 'the rescue deal',
    'the bundled deal', 'the year-end deal', 'the handshake deal',
  ],
};

/**
 * A property: the line that gives an entity the property ({a}, one of its aliases), the noun phrase a question
 * describes the entity by, and the key terms that pick it out. A property is used by one entity per world.
 */
export interface PropertySpec { id: string; line: string; np: string; keys: readonly string[] }
const prop = (id: string, line: string, np: string, keys: readonly string[] = [id]): PropertySpec => ({ id, line, np, keys });
export const ALIAS_PROPERTIES: Readonly<Record<EntityType, readonly PropertySpec[]>> = {
  person: [
    prop('kimchi', '{a} taught me to make kimchi', 'the person who taught me to make kimchi'),
    prop('kayak', '{a} lent me a kayak for the summer', 'the person who lent me a kayak for the summer'),
    prop('esperanto', '{a} is teaching me Esperanto', 'the person who is teaching me Esperanto', ['Esperanto']),
    prop('harmonica', '{a} plays harmonica in a blues band', 'the person who plays harmonica in a blues band', ['harmonica', 'blues']),
    prop('beehives', '{a} looks after a row of beehives', 'the person who looks after a row of beehives'),
    prop('origami', '{a} folds origami as a hobby', 'the person who folds origami as a hobby'),
    prop('motorbike', '{a} owns a vintage motorbike', 'the person who owns a vintage motorbike'),
    prop('falconer', '{a} trained as a falconer', 'the person who trained as a falconer'),
    prop('crosswords', '{a} sets crosswords for a local paper', 'the person who sets crosswords for a local paper'),
    prop('improv', '{a} performs improv comedy', 'the person who performs improv comedy'),
    prop('sailboat', '{a} is fixing up an old sailboat', 'the person who is fixing up an old sailboat'),
    prop('calligraphy', '{a} did the calligraphy on our wedding invitations', 'the person who did the calligraphy on our wedding invitations'),
    prop('ukulele', '{a} gave me my first ukulele', 'the person who gave me my first ukulele'),
    prop('quiz', '{a} captains our pub quiz team', 'the person who captains our pub quiz team'),
    prop('tango', '{a} is the one I met at a tango class', 'the person I met at a tango class'),
    prop('mushrooms', '{a} forages for wild mushrooms', 'the person who forages for wild mushrooms', ['mushrooms', 'forages']),
    prop('snowboard', '{a} taught me to snowboard', 'the person who taught me to snowboard'),
    prop('telescope', '{a} built a telescope in the garage', 'the person who built a telescope in the garage'),
    prop('triathlon', '{a} talked me into my first triathlon', 'the person who talked me into my first triathlon'),
    prop('karaoke', '{a} is my karaoke partner', 'my karaoke partner'),
    prop('chili', '{a} won the office chili cook-off', 'the person who won the office chili cook-off'),
    prop('glassblowing', '{a} took a glassblowing course with me', 'the person who took a glassblowing course with me'),
    prop('fencing', '{a} coached me in fencing', 'the person who coached me in fencing'),
    prop('lighthouse', '{a} grew up in a lighthouse', 'the person who grew up in a lighthouse'),
    prop('harp', '{a} plays the harp at weddings', 'the person who plays the harp at weddings'),
    prop('puppets', '{a} makes puppets for a children\'s theatre', 'the person who makes puppets for a children\'s theatre'),
    prop('bonsai', '{a} looks after a bonsai collection', 'the person who looks after a bonsai collection'),
    prop('magic', '{a} does magic tricks at parties', 'the person who does magic tricks at parties'),
    prop('stamps', '{a} collects rare stamps', 'the person who collects rare stamps'),
    prop('jazz', '{a} hosts a jazz radio show', 'the person who hosts a jazz radio show'),
    prop('archery', '{a} competes in archery', 'the person who competes in archery'),
    prop('bagpipes', '{a} plays the bagpipes', 'the person who plays the bagpipes'),
  ],
  company: [
    prop('rostering', '{a} makes hospital rostering software', 'the company that makes hospital rostering software'),
    prop('ferry', '{a} runs the island ferry service', 'the company that runs the island ferry service'),
    prop('drones', '{a} builds crop-spraying drones', 'the company that builds crop-spraying drones'),
    prop('parquet', '{a} makes parquet flooring', 'the company that makes parquet flooring'),
    prop('oat-milk', '{a} sells oat milk to cafes', 'the company that sells oat milk to cafes', ['oat milk']),
    prop('escape-rooms', '{a} designs escape rooms', 'the company that designs escape rooms', ['escape rooms']),
    prop('turbines', '{a} services offshore wind turbines', 'the company that services offshore wind turbines'),
    prop('hearing-aids', '{a} makes hearing aids', 'the company that makes hearing aids', ['hearing aids']),
    prop('satellites', '{a} launches weather satellites', 'the company that launches weather satellites'),
    prop('violins', '{a} makes violins', 'the company that makes violins'),
    prop('vertical-farms', '{a} runs vertical farms', 'the company that runs vertical farms', ['vertical farms']),
    prop('payroll', '{a} does payroll for restaurants', 'the company that does payroll for restaurants'),
    prop('tyres', '{a} recycles old tyres', 'the company that recycles old tyres'),
    prop('elevators', '{a} maintains elevators', 'the company that maintains elevators'),
    prop('sunscreen', '{a} makes sunscreen', 'the company that makes sunscreen'),
    prop('subtitles', '{a} writes subtitles for streaming shows', 'the company that writes subtitles for streaming shows'),
    prop('scaffolding', '{a} rents out scaffolding', 'the company that rents out scaffolding'),
    prop('fireworks', '{a} puts on fireworks displays', 'the company that puts on fireworks displays'),
    prop('ice-cream', '{a} makes ice cream', 'the company that makes ice cream', ['ice cream']),
  ],
  project: [
    prop('parish-archive', '{a} is about digitising the parish archive', 'the project about digitising the parish archive', ['parish archive']),
    prop('loyalty', '{a} is the rebuild of our loyalty app', 'the project rebuilding our loyalty app'),
    prop('braille', '{a} adds braille labels to our packaging', 'the project adding braille labels to our packaging'),
    prop('carbon', '{a} measures our carbon footprint', 'the project measuring our carbon footprint'),
    prop('welsh', '{a} translates the manual into Welsh', 'the project translating the manual into Welsh', ['Welsh']),
    prop('kiosks', '{a} is about self-checkout kiosks', 'the project about self-checkout kiosks'),
    prop('railway', '{a} predicts railway signal faults', 'the project predicting railway signal faults'),
    prop('audio-guide', '{a} builds the museum audio guide', 'the project building the museum audio guide', ['audio guide']),
    prop('timetables', '{a} generates school timetables', 'the project generating school timetables'),
    prop('flood', '{a} puts flood sensors under bridges', 'the project putting flood sensors under bridges'),
    prop('farmers', '{a} is a voice assistant for farmers', 'the project building a voice assistant for farmers'),
    prop('recipe', '{a} is the recipe search revamp', 'the project revamping recipe search'),
    prop('solar', '{a} covers car parks with solar canopies', 'the project covering car parks with solar canopies'),
    prop('wayfinding', '{a} does wayfinding for hospitals', 'the project doing wayfinding for hospitals'),
    prop('library', '{a} automates library lending', 'the project automating library lending'),
  ],
  deal: [
    prop('cold-storage', '{a} covers the cold-storage sensors', 'the deal that covers the cold-storage sensors', ['cold-storage']),
    prop('fleet', '{a} covers fleet tracking for the vans', 'the deal for fleet tracking on the vans'),
    prop('headsets', '{a} is for the call-centre headsets', 'the deal for the call-centre headsets'),
    prop('lounges', '{a} covers the airport lounges', 'the deal that covers the airport lounges'),
    prop('stadium', '{a} is for the stadium screens', 'the deal for the stadium screens'),
    prop('laptops', '{a} is for the school laptops', 'the deal for the school laptops'),
    prop('wifi', '{a} covers the hotel wifi', 'the deal that covers the hotel wifi'),
    prop('parking', '{a} is for the parking meters', 'the deal for the parking meters'),
    prop('freezers', '{a} covers the lab freezers', 'the deal that covers the lab freezers'),
    prop('shelters', '{a} is for the bus shelters', 'the deal for the bus shelters'),
    prop('lighting', '{a} covers the museum lighting', 'the deal that covers the museum lighting'),
    prop('ticket-gates', '{a} is for the ticket gates', 'the deal for the ticket gates', ['ticket gates']),
    prop('vending', '{a} covers the vending machines', 'the deal that covers the vending machines'),
    prop('rigging', '{a} is for the stage rigging', 'the deal for the stage rigging'),
  ],
};

/**
 * A relation from an entity (the subject, {x}) to another ({y}): the line that states it, the noun phrase a question
 * describes the subject by ({Y} is the other entity's property noun phrase) and its key terms. Every relation is one-way
 * (X is Y's landlord; Y is not X's), so "the landlord of Y" has one answer when Y has one landlord.
 */
export interface RelationSpec { id: string; subject: EntityType; object: EntityType; line: string; np: string; keys: readonly string[] }
export const ALIAS_RELATIONS: readonly RelationSpec[] = [
  { id: 'landlord', subject: 'person', object: 'person', line: '{x} is {y}\'s landlord', np: 'the landlord of {Y}', keys: ['landlord'] },
  { id: 'mentor', subject: 'person', object: 'person', line: '{x} mentored {y} early on', np: 'the person who mentored {Y}', keys: ['mentored'] },
  { id: 'boss', subject: 'person', object: 'person', line: '{x} used to be {y}\'s boss', np: 'the former boss of {Y}', keys: ['boss'] },
  { id: 'founded', subject: 'company', object: 'person', line: '{y} founded {x}', np: 'the company founded by {Y}', keys: ['founded'] },
  { id: 'commissioned', subject: 'project', object: 'company', line: '{y} commissioned {x}', np: 'the project commissioned by {Y}', keys: ['commissioned'] },
  { id: 'counterparty', subject: 'deal', object: 'company', line: 'The counterparty on {x} is {y}', np: 'the deal whose counterparty is {Y}', keys: ['counterparty'] },
];

/** The line that introduces an entity's canonical name beside its nickname ({c}, {k}). */
export const INTRO_LINES: Readonly<Record<EntityType, readonly string[]>> = {
  person: ['{c} goes by {k} with friends', 'Everyone calls {c} {k}', '{k} is what everyone calls {c}'],
  company: ['{c} is the full name; most of us just say {k}', '{k} is what we call {c} around here'],
  project: ['{c} is the official name of what we call {k}', 'On paper it is {c}, but everyone says {k}'],
  deal: ['When I say {k}, I mean {c}', 'On paper it is {c}, but everyone says {k}'],
};
/** The line that ties an entity's nickname ({k}) to its role ({r}). */
export const ROLE_LINES: readonly string[] = ['{k} is {r}, in case I never said', 'When I mention {r}, I mean {k}'];
/** The sentence a pronoun-only line opens with, naming the antecedent ({a}). */
export const ANTECEDENTS: readonly string[] = ['I caught up with {a} yesterday.', 'I had a long call with {a}.', '{a} rang me last night.', 'I bumped into {a} at the market.'];

/** Every static text the @3 lines are built from, with placeholders blanked: part of the planner's clash list. */
export function aliasTemplateTexts(): string[] {
  const props = Object.values(ALIAS_PROPERTIES).flat();
  return [
    ...props.flatMap(p => [p.line, p.np]), ...ALIAS_RELATIONS.flatMap(r => [r.line, r.np]), ...Object.values(INTRO_LINES).flat(), ...ROLE_LINES, ...ANTECEDENTS,
  ].map(t => t.replace(/\{[a-zA-Z]+\}/g, ' '));
}

const SIBLING_VOWEL: Readonly<Record<string, string>> = { a: 'e', e: 'a', i: 'y', o: 'u', u: 'o', y: 'i' };
/**
 * The misspellings a word can take, in a fixed order: a vowel swapped for its neighbour (o and u, a and e, i and y), then
 * a doubled letter undoubled, then a consonant after a vowel doubled. The first two letters are never changed, so the
 * misspelling still reads as the word.
 */
export function misspellings(word: string): string[] {
  const swaps: string[] = [], undoubled: string[] = [], doubled: string[] = [];
  for (let i = 2; i < word.length; i++) {
    const c = word[i];
    if (SIBLING_VOWEL[c]) swaps.push(word.slice(0, i) + SIBLING_VOWEL[c] + word.slice(i + 1));
    if (i < word.length - 1 && word[i + 1] === c) undoubled.push(word.slice(0, i) + word.slice(i + 1));
    else if (i < word.length - 1 && word[i - 1] !== c && /[bcdfgklmnprstvz]/.test(c) && /[aeiou]/.test(word[i - 1])) doubled.push(word.slice(0, i + 1) + c + word.slice(i + 1));
  }
  return [...new Set([...swaps, ...undoubled, ...doubled])].filter(m => m !== word);
}

/** Levenshtein distance, case-insensitive. */
export function editDistance(a: string, b: string): number {
  const x = a.toLowerCase(), y = b.toLowerCase();
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[y.length];
}
