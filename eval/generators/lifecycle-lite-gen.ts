/**
 * lifecycle-lite generator: seeded synthetic chat histories for the
 * open-source memory shootout's update-and-forget category (P2,
 * docs/plans/2026-10-05-oss-memory-shootout/PLAN.md), with the gold an
 * independent oracle derives from the ledger.
 *
 * One history per seed, one namespace per history. Its sessions are short
 * user and assistant exchanges with an ISO event date, and they come from
 * two existing ledgers:
 *
 *   update chains   the N1 fence chains (eval/generators/n1-knowledge-update-gen.ts)
 *                   for the same seed: six fictional people, a home city and
 *                   an employer each, update depth 1 to 4, three of them
 *                   reverting to an earlier value. Each value becomes one
 *                   dated session ("Alder Example now lives in Porto") at the
 *                   value's N1 `valid_from` date, so corrections arrive
 *                   through normal ingestion. N1's labels repeat across
 *                   chains, so every distinct value gets a fresh label that
 *                   is unique in the history; the structure (depth, kind,
 *                   revert position, dates) is N1's.
 *   canaries        the N5 canaries (eval/generators/n5-forget-residue-gen.ts)
 *                   for the same seed: four fictional people with hobby
 *                   claims. Forgotten and late-forgotten canaries are the
 *                   delete targets, removed through the protocol's
 *                   /delete_source; retained canaries are the survivors.
 *                   Each canary is its own session, so deleting its source
 *                   removes exactly that claim. Same-text twins,
 *                   paraphrases, corrected claims and the concurrent round
 *                   need N5's remember verb and have no portable equivalent,
 *                   so they are left out.
 *   filler          ordinary assistant chores that mention no person, value
 *                   or hobby.
 *
 * Gold is lexical and evaluator-side: each value has a whole-word pattern of
 * its label, and each canary has word-start patterns of its hobby (a stem
 * such as `beekeep` catches "beekeeper" as well as "bees"). Generator
 * invariants (tested): no pattern matches any session except its own fact's
 * sessions, and no label contains another.
 *
 * Probes, each one retrieval question with a query date:
 *   update_current  "Which city does Alder Example live in now?" asked the day
 *                   after the last session: the chain's final value must be
 *                   served, and no value that was current earlier may be
 *                   served as current.
 *   update_asof     the same question asked between the chain's first and
 *                   second dates: the first value was current then, and no
 *                   later value may be served as current at that date.
 *   forget_target   "Does Hazel Example keep bees?" for each delete target:
 *                   present before its delete, absent after it.
 *   survivor        the same question for each retained canary: present
 *                   before the deletes and still present after them.
 *
 * All names are fictional placeholders.
 */
import type { Conversation, MemoryQuestion, Session } from '../runner/memory-qa/corpus.ts';
import { generateN1World, type FenceChain } from './n1-knowledge-update-gen.ts';
import { generateN5World, type Canary } from './n5-forget-residue-gen.ts';
import { Rng, addDays, fingerprint } from './seeded.ts';

export const LIFECYCLE_LITE_GENERATOR_VERSION = 'lifecycle-lite-gen@1';
/** The draft preregistration's seeds (docs/benchmarks/2026-10-06-oss-memory-shootout-lifecycle-lite-preregistration.md). */
export const LIFECYCLE_LITE_SEEDS: readonly number[] = [1, 2, 3, 4, 5];

const CITIES = [
  'Lisbon', 'Porto', 'Braga', 'Faro', 'Leiria', 'Evora', 'Coimbra', 'Aveiro', 'Viseu', 'Tomar', 'Sintra', 'Setubal',
  'Granada', 'Valencia', 'Seville', 'Bilbao', 'Zaragoza', 'Malaga', 'Toledo', 'Cordoba', 'Salamanca', 'Girona',
  'Lyon', 'Nantes', 'Rennes', 'Dijon', 'Toulouse', 'Grenoble', 'Turin', 'Verona', 'Bologna', 'Parma', 'Genoa',
  'Trieste', 'Ghent', 'Utrecht', 'Bergen', 'Tampere', 'Krakow', 'Gdansk',
];
const EMPLOYERS = [
  'Orchard Labs', 'Harbor Works', 'Quarry Systems', 'Lantern Media', 'Summit Freight', 'Meadow Health', 'Granite Bank',
  'Willow Robotics', 'Copperline Analytics', 'Bluefin Logistics', 'Northgate Insurance', 'Saffron Foods',
  'Ironwood Construction', 'Pebble Software', 'Riverstone Energy', 'Larkspur Design', 'Halcyon Pharma',
  'Tidewater Shipping', 'Foxglove Games', 'Marigold Retail', 'Basalt Mining', 'Driftwood Hotels', 'Cobalt Security',
  'Evergreen Textiles', 'Kestrel Aviation', 'Silverleaf Capital', 'Thistle Publishing', 'Beacon Telecom',
  'Crescent Biotech', 'Mosaic Learning', 'Obsidian Networks', 'Prairie Dairy', 'Quill Legal', 'Redwood Ceramics',
  'Sterling Optics', 'Topaz Ventures',
];

/**
 * Every N5 phrase: the base form for a yes-or-no question and the word-start
 * stems that identify the claim in any wording a memory system might store.
 */
export const CANARY_LEXICON: Record<string, { base: string; stems: string[] }> = {
  'Keeps bees': { base: 'keep bees', stems: ['bees', 'beekeep', 'beehive'] },
  'Plays the oboe': { base: 'play the oboe', stems: ['oboe', 'oboist'] },
  'Collects stamps': { base: 'collect stamps', stems: ['stamp', 'philatel'] },
  'Prefers email': { base: 'prefer email', stems: ['email', 'e-mail'] },
  'Speaks Basque': { base: 'speak Basque', stems: ['basque'] },
  'Runs marathons': { base: 'run marathons', stems: ['marathon'] },
  'Grows bonsai': { base: 'grow bonsai', stems: ['bonsai'] },
  'Restores clocks': { base: 'restore clocks', stems: ['clock'] },
  'Sails dinghies': { base: 'sail dinghies', stems: ['dinghies', 'dinghy', 'sailboat'] },
  'Brews cider': { base: 'brew cider', stems: ['cider'] },
  'Paints murals': { base: 'paint murals', stems: ['mural'] },
  'Studies moths': { base: 'study moths', stems: ['moths', 'lepidopter'] },
  'Builds kites': { base: 'build kites', stems: ['kite'] },
  'Carves spoons': { base: 'carve spoons', stems: ['spoon'] },
  'Bakes sourdough': { base: 'bake sourdough', stems: ['sourdough'] },
  'Knits socks': { base: 'knit socks', stems: ['socks', 'knit'] },
  'Climbs boulders': { base: 'climb boulders', stems: ['boulder'] },
  'Juggles clubs': { base: 'juggle clubs', stems: ['juggl'] },
  'Translates poetry': { base: 'translate poetry', stems: ['poetry', 'poem'] },
  'Rides unicycles': { base: 'ride unicycles', stems: ['unicycl'] },
  'Tunes pianos': { base: 'tune pianos', stems: ['piano'] },
  'Binds books': { base: 'bind books', stems: ['bookbind', 'binds books'] },
  'Forages mushrooms': { base: 'forage mushrooms', stems: ['mushroom', 'forag'] },
  'Repairs bicycles': { base: 'repair bicycles', stems: ['bicycle', 'bike'] },
};

const FILLER: Array<[string, string]> = [
  ['Can you remind me to water the plants on Sunday?', 'Sure, I will remind you on Sunday.'],
  ['What is a good way to keep coffee fresh?', 'Store it in an airtight container away from light.'],
  ['I need a name for my new notebook.', 'How about calling it the ideas log?'],
  ['Please add milk and rice to the shopping list.', 'Added milk and rice to your shopping list.'],
  ['How long should I steep green tea?', 'About two to three minutes in water just below boiling.'],
  ['Remind me that the car needs new wipers.', 'Noted: the car needs new wipers.'],
  ['What is a quick stretch for a stiff neck?', 'Slowly tilt your head toward each shoulder and hold for a few breaths.'],
  ['Suggest a short title for a slide about quarterly goals.', 'Try: Where we are headed this quarter.'],
  ['How do I convert ten miles to kilometers?', 'Ten miles is about sixteen kilometers.'],
  ['Set a note that the dentist appointment is in the afternoon now.', 'Done: your dentist appointment is in the afternoon.'],
  ['Any tips for a tidy desk?', 'Keep one tray for incoming papers and clear it every evening.'],
  ['What rhymes with orange?', 'Very few words do; door hinge is a near rhyme.'],
];
export const FILLER_PER_HISTORY = 8;

export type Attr = 'city' | 'employer';
export type ProbeKind = 'update_current' | 'update_asof' | 'forget_target' | 'survivor';
export const PROBE_KINDS: readonly ProbeKind[] = ['update_current', 'update_asof', 'forget_target', 'survivor'];

/** One value of an update chain: its fresh label, its session and its date. */
export interface ChainValue { label: string; session: string; date: string; pattern: string }

export interface LiteChain {
  id: string;
  entity: string;
  name: string;
  attr: Attr;
  kind: FenceChain['kind'];
  depth: number;
  values: ChainValue[];
}

export interface LiteCanary {
  id: string;
  entity: string;
  name: string;
  phrase: string;
  role: 'delete' | 'survivor';
  /** The N5 role it came from. */
  n5_role: Canary['role'];
  session: string;
  date: string;
  patterns: string[];
}

interface ProbeBase { id: string; seed: number; kind: ProbeKind; question: string; query_time: string; entity: string }
export type LiteProbe =
  | ProbeBase & { kind: 'update_current'; chain: string; attr: Attr; depth: number; chain_kind: string; gold: string; gold_pattern: string; stale: Array<{ label: string; pattern: string }> }
  | ProbeBase & { kind: 'update_asof'; chain: string; attr: Attr; depth: number; chain_kind: string; gold: string; gold_pattern: string; future: Array<{ label: string; pattern: string }> }
  | ProbeBase & { kind: 'forget_target'; canary: string; patterns: string[]; session: string }
  | ProbeBase & { kind: 'survivor'; canary: string; patterns: string[] };

export interface LifecycleLiteWorld {
  generator_version: string;
  seed: number;
  /** The N1 and N5 ledgers this history was derived from. */
  sources: { n1_fingerprint: string; n5_fingerprint: string };
  conversation: Conversation;
  chains: LiteChain[];
  canaries: LiteCanary[];
  /** Delete targets in the order the runner deletes them. */
  deletes: Array<{ canary: string; session: string }>;
  /** The query time of the current-value, forget and survivor probes: the day after the last session. */
  now: string;
  probes: LiteProbe[];
  fingerprint: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A whole-word, case-insensitive pattern for a label (spaces match any run of whitespace). */
export const labelPattern = (label: string) => `(?<![a-z0-9])${label.toLowerCase().split(/\s+/).map(escapeRe).join('\\s+')}(?![a-z0-9])`;
/** A word-start pattern for a stem. */
export const stemPattern = (stem: string) => `(?<![a-z0-9])${escapeRe(stem.toLowerCase())}`;
/** True when any pattern occurs in `text` (case-insensitive). */
export const matchesAny = (text: string, patterns: readonly string[]) => patterns.some(p => new RegExp(p, 'i').test(text));

const nameOf = (slug: string) => {
  const base = slug.split('/').pop()!.replace(/-example$/, '');
  return `${base[0].toUpperCase()}${base.slice(1)} Example`;
};
const iso = (day: string) => `${day}T00:00:00`;
const midpoint = (a: string, b: string) => addDays(a, Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000 / 2));
const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1);

function valueTurns(chain: { attr: Attr; name: string }, label: string, round: number): Session['turns'] {
  const { attr, name } = chain;
  if (attr === 'city') {
    return round === 0
      ? [{ speaker: 'user', content: `For your notes: ${name} lives in ${label}.` }, { speaker: 'assistant', content: `Noted: ${name} lives in ${label}.` }]
      : [{ speaker: 'user', content: `Update: ${name} has moved and now lives in ${label}.` }, { speaker: 'assistant', content: `Got it: ${name} now lives in ${label}.` }];
  }
  return round === 0
    ? [{ speaker: 'user', content: `For your notes: ${name} works at ${label}.` }, { speaker: 'assistant', content: `Noted: ${name} works at ${label}.` }]
    : [{ speaker: 'user', content: `Update: ${name} has changed jobs and now works at ${label}.` }, { speaker: 'assistant', content: `Got it: ${name} now works at ${label}.` }];
}

const questionFor = (attr: Attr, name: string) => attr === 'city' ? `Which city does ${name} live in now?` : `Where does ${name} work now?`;

export function generateLifecycleLiteWorld(opts: { seed: number }): LifecycleLiteWorld {
  const { seed } = opts;
  const n1 = generateN1World({ seed });
  const n5 = generateN5World({ seed });
  const rng = new Rng(seed * 7919 + 17);
  const cities = rng.shuffle(CITIES);
  const employers = rng.shuffle(EMPLOYERS);
  const sessions: Session[] = [];
  const add = (id: string, date: string, turns: Session['turns']) => { sessions.push({ id, date, turns }); return id; };

  const chains: LiteChain[] = n1.ledger.fence.map(c => {
    const name = nameOf(c.entity);
    const pool = c.attr === 'city' ? cities : employers;
    const fresh = new Map<string, string>();
    const values = c.values.map((v, r) => {
      if (!fresh.has(v.label)) fresh.set(v.label, pool.shift()!);
      const label = fresh.get(v.label)!;
      const session = add(`s${seed}-${c.id}-r${r}`, v.valid_from, valueTurns({ attr: c.attr, name }, label, r));
      return { label, session, date: v.valid_from, pattern: labelPattern(label) };
    });
    return { id: c.id, entity: c.entity, name, attr: c.attr, kind: c.kind, depth: c.depth, values };
  });

  const allDates = chains.flatMap(c => c.values.map(v => v.date)).sort();
  const first = allDates[0], last = allDates[allDates.length - 1];
  const span = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000);
  const someDay = () => addDays(first, rng.int(1, Math.max(1, span - 1)));

  const canaries: LiteCanary[] = n5.ledger.canaries
    .filter(c => !c.twin_of && ['forgotten', 'late-forgotten', 'retained'].includes(c.role))
    .map(c => {
      const lex = CANARY_LEXICON[c.phrase];
      if (!lex) throw new Error(`lifecycle-lite: no lexicon entry for the N5 phrase ${JSON.stringify(c.phrase)}`);
      const name = nameOf(c.entity);
      const date = someDay();
      const session = add(`s${seed}-canary-${c.id}`, date, [
        { speaker: 'user', content: `By the way, ${name} ${lowerFirst(c.phrase)}.` },
        { speaker: 'assistant', content: `Thanks, I will remember that ${name} ${lowerFirst(c.phrase)}.` },
      ]);
      return { id: c.id, entity: c.entity, name, phrase: c.phrase, role: c.role === 'retained' ? 'survivor' as const : 'delete' as const, n5_role: c.role, session, date, patterns: lex.stems.map(stemPattern) };
    });

  for (const [k, turn] of rng.shuffle(FILLER).slice(0, FILLER_PER_HISTORY).entries()) {
    add(`s${seed}-filler-${k + 1}`, someDay(), [{ speaker: 'user', content: turn[0] }, { speaker: 'assistant', content: turn[1] }]);
  }

  const now = iso(addDays(last, 1));
  const probes: LiteProbe[] = [];
  for (const c of chains) {
    const final = c.values[c.values.length - 1];
    const stale = [...new Map(c.values.filter(v => v.label !== final.label).map(v => [v.label, { label: v.label, pattern: v.pattern }])).values()];
    const base = { seed, entity: c.entity, chain: c.id, attr: c.attr, depth: c.depth, chain_kind: c.kind, question: questionFor(c.attr, c.name) };
    probes.push({ ...base, id: `s${seed}:update_current:${c.id}`, kind: 'update_current', query_time: now, gold: final.label, gold_pattern: final.pattern, stale });
    const [v0, v1] = c.values;
    const future = [...new Map(c.values.slice(1).filter(v => v.label !== v0.label).map(v => [v.label, { label: v.label, pattern: v.pattern }])).values()];
    probes.push({ ...base, id: `s${seed}:update_asof:${c.id}`, kind: 'update_asof', query_time: iso(midpoint(v0.date, v1.date)), gold: v0.label, gold_pattern: v0.pattern, future });
  }
  for (const c of canaries) {
    const base = { seed, entity: c.entity, canary: c.id, question: `Does ${c.name} ${CANARY_LEXICON[c.phrase].base}?`, query_time: now, patterns: c.patterns };
    probes.push(c.role === 'delete'
      ? { ...base, id: `s${seed}:forget_target:${c.id}`, kind: 'forget_target', session: c.session }
      : { ...base, id: `s${seed}:survivor:${c.id}`, kind: 'survivor' });
  }

  const conversation: Conversation = { id: `lifecycle-lite-seed-${seed}`, sessions };
  const deletes = canaries.filter(c => c.role === 'delete').map(c => ({ canary: c.id, session: c.session }));
  const body = { generator_version: LIFECYCLE_LITE_GENERATOR_VERSION, seed, sources: { n1_fingerprint: n1.fingerprint, n5_fingerprint: n5.fingerprint }, conversation, chains, canaries, deletes, now, probes };
  return { ...body, fingerprint: fingerprint(body) };
}

/**
 * The world as memory-qa's corpus shape, so the shootout sanitizer
 * (eval/runner/systems/sanitize.ts) derives opaque ids and forbidden markers
 * from it: probe ids and kinds and session ids must never reach a system.
 */
export function sanitizerCorpus(worlds: readonly LifecycleLiteWorld[]): { conversations: Conversation[]; questions: MemoryQuestion[] } {
  return {
    conversations: worlds.map(w => w.conversation),
    questions: worlds.flatMap(w => w.probes.map(p => ({
      id: p.id, conversation: w.conversation.id, question: p.question, category: p.kind,
      gold: p.kind === 'forget_target' ? [p.session] : [], abstention: false,
    }))),
  };
}
