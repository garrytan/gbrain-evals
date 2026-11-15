/**
 * BG1 changing-facts generator (GST-2010; docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md):
 * a seeded world plan of facts that change, the gold an independent oracle derives from that plan for each stratum,
 * a deterministic template renderer for keyless fixtures, and the per-session briefs the custody renderer
 * (eval/custody/bg1/render.ts) hands gemini-3.8-flash.
 *
 * The plan. One world is 140 to 160 dated sessions over about 18 months, ending on day 0, the world end. Days are
 * offsets from the world end, so every date in a plan, a rendered session or a question is a [[D:<offset>]] or
 * [[W:<offset>]] token that the loader resolves (eval/runner/memory-qa/corpus.ts). Every world is planned to end on a
 * BG1_WORLD_END_WEEKDAY, so a campaign may move the world end only in whole weeks. 30 tracked slots (an entity and an
 * attribute: a person's city, a company's head of operations, a deal's signed price) carry the five kinds of change of
 * the primary family, six slots each:
 *
 *   s1_updated         A to B, or chains A to B to C to D. Some changes are learned late ("moved there back on ..."),
 *                      and some chains carry a scheduled change that takes effect after the counted run, so the gold
 *                      is still the old value.
 *   s2_corrected       A is stated, and a later line says A was wrong and the value is B (A was never true).
 *   s3_repeated_stale  A is mentioned in 8 to 15 sessions, then B is said once.
 *   s4_conflicting     the Cat 40 H4 shape (docs/benchmarks/cat40-hard/WORLD_SCHEMA.md): 3 to 5 sources disagree in one
 *                      period. The governing source (an executed contract or an owner's written confirmation) sits
 *                      mid-way through a long session; drafts, recaps and agent notes carry other values, mostly later.
 *   s5_withdrawn       a plan is called off, or a report is retracted as a rumour, so nothing is current.
 *
 * Near-name decoy entities (Ana Okafor and Ana Okoro, the Harbor deal and the Harbor Point deal) hold values of the
 * same kind, and every session has a filler topic. Values are unique within a world and checked against each other,
 * against every name and against the phrasing, with an alias and implication lexicon per value, so the custody
 * renderer can prove that no value appears anywhere it was not planned.
 *
 * Questions. 64 per world, eight strata of eight (eval/runner/bg1/types.ts). A primary stratum asks about its six
 * slots, two of them in both forms; a secondary stratum (s6 as-of, s7 as-known, s8 history) asks about eight slots of
 * s1 to s3. Each stratum has four exact and four paraphrase questions, assigned by seed.
 *
 * Gold. Each stratum has its own oracle over the plan's events, never over rendered text: s1, s6 and s7 run the
 * forward state machine of job-state.ts over valid-time or learned-time events, s2 replays statements with their
 * corrections, s3 takes the latest change by valid time and ignores mentions, s4 ranks sources by authority (executed,
 * owner-confirmed, draft, recap, agent note; a later effective date breaks a tie), s5 replays plans and withdrawals,
 * and s8 orders the true values by valid time. The planner also records what it meant each slot to say (`intent`), and
 * the question builder refuses a world where an oracle disagrees with it.
 *
 * Phrasing. PUBLIC_PHRASING builds the dev worlds. Sealed worlds use a custody phrasing set (a *.bg1-phrasing.json file
 * outside the checkout carrying the custody marker; loadPhrasing checks its keys and placeholders against the public
 * set). Seeds: the dev worlds use the public BG1_DEV_SEEDS; a sealed world's seed is HMAC-SHA256 of the custody seed
 * line and "bg1/world/<slot>" (sealedWorldSeed), and a sealed plan never records it.
 *
 * Gold-audit fixes (stage 1, Amendment 4), sealed worlds only, so the dev worlds stage 1 rendered and scored still
 * match a fresh generation: a sealed retraction uses only retract templates that say the plan is not happening (one of
 * NONE_FORMS), because "the report was false" alone does not support the s5 gold; and a sealed s8 question never asks
 * about a slot with a scheduled change, because a value due after the world end is neither history nor stale.
 *
 * Files (eval/data/changing-facts-v1): dev/worlds/<id>/{plan,questions}.json, the public dev plans and gold (stage 1
 * adds the Gemini-rendered world.json beside them), and fixtures/worlds/<id>/{world,questions}.json, the same worlds
 * from the template renderer at BG1_FIXTURE_TOKENS, for keyless tests.
 *
 *   bun eval/generators/changing-facts-gen.ts write   write the dev plans and questions and the template fixtures
 *   bun eval/generators/changing-facts-gen.ts check   exit 1 when a committed file differs from a fresh generation
 *
 * All names are fictional.
 */
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BG1_DEV_CONVERSATIONS, BG1_PRIMARY, BG1_QUESTIONS_PER_STRATUM, familyOf, type Bg1QuestionFields, type Bg1Stratum } from '../runner/bg1/types.ts';
import { encodingCount } from '../runner/systems/render-v2.ts';
import { ForwardJobState } from './job-state.ts';
import { Rng, addDays } from './seeded.ts';

export const BG1_GENERATOR_VERSION = 'changing-facts-gen@1';
export const BG1_PLAN_SCHEMA = 'gbrain-evals/bg1-plan/v1';
export const BG1_WORLD_SCHEMA = 'gbrain-evals/bg1-world/v1';
export const BG1_SPAN_DAYS = 547;
export const BG1_SESSIONS = { min: 140, max: 160 } as const;
export const BG1_SLOTS_PER_STRATUM = 6;
export const BG1_TRACKED_SLOTS = BG1_PRIMARY.length * BG1_SLOTS_PER_STRATUM;
export const BG1_DECOY_SLOTS = 10;
export const BG1_WORLD_END_WEEKDAY = 'Sunday';
/** A scheduled change takes effect this many days after the world end: past the 14-day slip and the run itself. */
export const BG1_FUTURE_DAYS = { min: 45, max: 120 } as const;
export const BG1_TARGET_TOKENS = 200_000;
/** The committed template fixtures are smaller than a counted world. */
export const BG1_FIXTURE_TOKENS = 30_000;
export const BG1_MAX_LINES_PER_SESSION = 3;
export const BG1_DEV_SEEDS: Readonly<Record<string, string>> = Object.fromEntries(BG1_DEV_CONVERSATIONS.map(id => [id, `bg1-dev-seed-v1:${id}`]));
/** Embedded in every sealed plan, world, gold item and custody phrasing set; the sealed key's text rule matches it. */
export const BG1_CUSTODY_MARKER = ['BG1', 'SEALED', 'CUSTODY', 'v1'].join('-');
export const BG1_DATA_DIR = resolve(import.meta.dir, '../data/changing-facts-v1');
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export class PlanError extends Error {}

// ─── plan types ──────────────────────────────────────────────────────

export type EntityType = 'person' | 'company' | 'project' | 'deal';
export type Kind = 'city' | 'employer' | 'role' | 'ops_lead' | 'hq' | 'lead' | 'vendor' | 'price' | 'seats' | 'discount' | 'term' | 'merger' | 'offsite' | 'pilot';
export type Source = 'executed' | 'owner_confirmed' | 'draft' | 'recap' | 'agent_note';
export type EventType = 'state' | 'change' | 'late' | 'scheduled' | 'correct' | 'mention' | 'source' | 'plan' | 'withdraw';
export type SlotStratum = Bg1Stratum | 'decoy';

export interface Entity { id: string; type: EntityType; name: string; twin_of?: string }
export interface SlotEvent {
  id: string;
  type: EventType;
  /** The value the line asserts; for a withdrawal, the value withdrawn; for a correction, the corrected value. */
  value: string;
  session: string;
  /** The day the user says it (the session's day). */
  said: number;
  /** Valid time: the day the value became true (null for a mention or a withdrawal). */
  valid_from: number | null;
  /** A correction: the event whose value was never true. */
  replaces?: string;
  source?: Source;
  /** A withdrawal: the report was a rumour, not a plan that was called off. */
  rumour?: boolean;
}
export interface Slot {
  id: string;
  entity: string;
  kind: Kind;
  stratum: SlotStratum;
  /** A decoy slot: the tracked slot whose entity it shadows. */
  twin_slot?: string;
  events: SlotEvent[];
  /** What the planner meant the slot to say. Oracles never read it; the question builder checks them against it. */
  intent: { now: string | null; history: string[] };
}
export interface PlannedLine { text: string; slot: string; event: string; values: string[]; speaker: 'user'; position: 'any' | 'middle' }
export interface SessionPlan { id: string; day: number; time: string; topic: string; long: boolean; lines: PlannedLine[] }
export interface Lexeme { aliases: string[]; implications: string[] }
export interface WorldPlan {
  schema: string;
  generator: string;
  id: string;
  /** Dev worlds only: the public seed. A sealed plan never records its seed. */
  seed?: string;
  custody?: string;
  world_end_weekday: string;
  entities: Entity[];
  slots: Slot[];
  sessions: SessionPlan[];
  lexicon: Record<string, Lexeme>;
}

export interface Turn { speaker: 'user' | 'assistant'; content: string }
export interface WorldSession { id: string; day: number; time: string; turns: Turn[] }
export interface World { schema: string; id: string; custody?: string; world_end_weekday: string; renderer: string; sessions: WorldSession[] }
export interface QuestionRecord { id: string; question: string; answer: string; evidence_sessions: string[]; bg1: Bg1QuestionFields; custody?: string }

// ─── pools ───────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'Ana', 'Bilal', 'Chiara', 'Dmitri', 'Esme', 'Farid', 'Greta', 'Hiro', 'Ines', 'Jonah', 'Kavya', 'Luca', 'Mirela', 'Nnamdi', 'Odile', 'Pavel',
  'Rania', 'Soren', 'Talia', 'Umar', 'Vera', 'Ximena', 'Yusuf', 'Zofia', 'Benedikt', 'Calla', 'Dario', 'Elif', 'Gwen', 'Hamid', 'Ilse', 'Joaquin',
  'Keiko', 'Lorcan', 'Maren', 'Nadia', 'Oren', 'Petra', 'Rafael', 'Saoirse', 'Tomas', 'Viktor', 'Wanjiru', 'Yara', 'Zainab', 'Anouk', 'Bastian',
  'Cosima', 'Desmond', 'Emeka', 'Freya', 'Gideon', 'Halima', 'Ivo', 'Kasimir', 'Leila', 'Matteo', 'Priya', 'Ronan', 'Sanne', 'Theo', 'Ulla',
  'Valentin', 'Willa', 'Aurelio', 'Bettina', 'Cyrus', 'Delphine', 'Eamon', 'Fenna',
];
/** Surname pairs: a tracked person takes the first, their near-name decoy the second. */
const SURNAME_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['Okafor', 'Okoro'], ['Lindqvist', 'Lindgren'], ['Marchetti', 'Marchesi'], ['Halloran', 'Holloran'], ['Petrovic', 'Petrovski'],
  ['Nakamura', 'Nakagawa'], ['Brennan', 'Brannigan'], ['Achterberg', 'Achterhof'], ['Delacroix', 'Delacourt'], ['Fairbairn', 'Fairweather'],
  ['Gallagher', 'Gallacher'], ['Haddad', 'Hadid'], ['Ivanova', 'Ivanovic'], ['Jansen', 'Janssen'], ['Kowalski', 'Kowalczyk'],
  ['Lefebvre', 'Lefevre'], ['Novak', 'Novacek'], ['Oyelaran', 'Oyelowo'], ['Pereira', 'Pereda'], ['Quintero', 'Quintana'],
  ['Rasmussen', 'Rasmusson'], ['Sandoval', 'Sandvik'], ['Takahashi', 'Takayama'], ['Whitlock', 'Whitcombe'], ['Yilmaz', 'Yildiz'],
  ['Zielinski', 'Zielonka'], ['Abernathy', 'Abernethy'], ['Dunleavy', 'Dunlevy'],
];
/** Surnames of people who are values (a head of operations, a project lead), never entities. */
const VALUE_SURNAMES = [
  'Raman', 'Osei', 'Varga', 'Moreau', 'Kaur', 'Ferreira', 'Lindholm', 'Mensah', 'Novotny', 'Ortega', 'Pham', 'Quigley', 'Rossi', 'Sato', 'Tran',
  'Uddin', 'Vance', 'Weber', 'Yamada', 'Zoric', 'Adeyemi', 'Bauer', 'Coelho', 'Dimitrov', 'Eriksen', 'Fontaine', 'Grieve', 'Holm', 'Iqbal',
  'Jovanovic', 'Kiplagat', 'Larsen', 'Mahlangu', 'Nilsen', 'Okonjo', 'Pires', 'Rinaldi', 'Sokolov', 'Tanaka', 'Ugwu', 'Vidal', 'Wojcik', 'Yeboah', 'Zamora',
];
const COMPANY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['Fenwick Labs', 'Fenwick Lane'], ['Corbel Systems', 'Corbel Studio'], ['Ashgrove Foods', 'Ashgrove Farms'], ['Halcyon Freight', 'Halcyon Ferries'],
  ['Marlpit Software', 'Marlpit Supply'], ['Quayside Health', 'Quayside Homes'], ['Tidewell Energy', 'Tidewell Estates'], ['Brackenridge Media', 'Brackenridge Mills'],
  ['Stonechat Robotics', 'Stonechat Records'], ['Vantor Biotech', 'Vantor Books'], ['Lowmoor Retail', 'Lowmoor Rentals'], ['Elderflower Travel', 'Elderflower Tours'],
];
const PROJECT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['Kestrel', 'Kessel'], ['Bluebell', 'Bluebird'], ['Granite', 'Granita'], ['Ostrava', 'Ostrova'], ['Sandpiper', 'Sandpaper'], ['Tamarind', 'Tamarisk'],
  ['Halyard', 'Halberd'], ['Pennant', 'Penumbra'], ['Lodestar', 'Lodestone'], ['Mistletoe', 'Mistlethrush'],
];
const DEAL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['Harbor', 'Harbor Point'], ['Juniper', 'Juniper Hill'], ['Alder', 'Alderley'], ['Beacon', 'Beaconsfield'], ['Cobalt', 'Cobalt Bay'], ['Marlow', 'Marlowe'],
  ['Tamsin', 'Tamsworth'], ['Wexley', 'Wexford'], ['Ridgeway', 'Ridgeline'], ['Solent', 'Solenne'],
];
/** [city, implications, aliases]. Implications are words that would give the city away (a country or region). */
const CITIES: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
  ['Lisbon', ['Portugal'], ['Lisboa']], ['Porto', ['Portugal'], []], ['Oslo', ['Norway'], []], ['Bergen', ['Norway'], []], ['Tallinn', ['Estonia'], []],
  ['Riga', ['Latvia'], []], ['Vilnius', ['Lithuania'], []], ['Krakow', ['Poland'], ['Kraków']], ['Gdansk', ['Poland'], ['Gdańsk']], ['Prague', ['Czechia'], ['Praha']],
  ['Brno', ['Czechia'], []], ['Vienna', ['Austria'], ['Wien']], ['Graz', ['Austria'], []], ['Zurich', ['Switzerland'], ['Zürich']], ['Basel', ['Switzerland'], []],
  ['Lyon', ['France'], []], ['Bordeaux', ['France'], []], ['Valencia', ['Spain'], []], ['Seville', ['Spain'], ['Sevilla']], ['Bilbao', ['Spain'], []],
  ['Turin', ['Italy'], ['Torino']], ['Bologna', ['Italy'], []], ['Ghent', ['Belgium'], ['Gent']], ['Utrecht', ['Netherlands'], []], ['Rotterdam', ['Netherlands'], []],
  ['Aarhus', ['Denmark'], []], ['Gothenburg', ['Sweden'], ['Göteborg']], ['Malmo', ['Sweden'], ['Malmö']], ['Helsinki', ['Finland'], []], ['Tampere', ['Finland'], []],
  ['Edinburgh', ['Scotland'], []], ['Leeds', ['Yorkshire'], []], ['Galway', ['Ireland'], []], ['Denver', ['Colorado'], []], ['Montreal', ['Quebec'], ['Montréal']],
  ['Calgary', ['Alberta'], []], ['Adelaide', ['Australia'], []], ['Kyoto', ['Japan'], []], ['Busan', ['Korea'], []], ['Taipei', ['Taiwan'], []], ['Accra', ['Ghana'], []],
];
const ORGS = [
  'Brightline Analytics', 'Quillfeather Media', 'Tarnwood Logistics', 'Oakhaven Health', 'Silvermere Capital', 'Pinecrest Robotics', 'Larkspur Foods',
  'Northgate Freight', 'Glasswing Studios', 'Ambergrove Partners', 'Copperleaf Systems', 'Driftmark Software', 'Emberly Energy', 'Fernhollow Labs',
  'Goldcrest Insurance', 'Hazelpoint Consulting', 'Ironbark Security', 'Kettlebrook Brewing', 'Lanternfish Games', 'Moonvale Pharma', 'Nettlefield Supply',
  'Orchardly Retail', 'Pebblestone Data', 'Quarryhill Materials', 'Rookwood Design', 'Saltmarsh Marine', 'Thistledown Textiles', 'Umberfield Mining',
  'Vellumworks Print', 'Willowmere Hotels', 'Yarrowby Seeds', 'Zephyrine Aviation', 'Bramblecote Bakery', 'Cinderford Steel', 'Elmstead Clinics',
  'Foxglove Cosmetics', 'Gorseway Transit', 'Heathmont Schools', 'Inkberry Publishing', 'Jasperwood Furniture', 'Kinglet Telecom', 'Lindenhall Bank',
];
const ROLES = [
  'Head of Design', 'Chief of Staff', 'VP of Sales', 'Head of Platform', 'Staff Data Scientist', 'Director of Partnerships', 'Principal Architect',
  'Head of Support', 'General Counsel', 'Head of Growth', 'Director of Research', 'Lead Recruiter', 'Product Marketing Lead', 'Head of Security',
  'Field CTO', 'Customer Success Director', 'Finance Controller', 'Head of Procurement', 'Developer Advocate', 'Analytics Manager',
  'Quality Lead', 'Head of Brand', 'Programme Director', 'Compliance Officer',
];
const TERM_MONTHS = [9, 15, 18, 21, 27, 30, 33, 39, 42, 45, 51, 54, 57, 63, 66];

export type Pool = 'city' | 'org' | 'role' | 'person' | 'price' | 'seats' | 'discount' | 'term';
interface KindSpec { entity: EntityType; pool: Pool }
export const KINDS: Readonly<Record<Kind, KindSpec>> = {
  city: { entity: 'person', pool: 'city' }, employer: { entity: 'person', pool: 'org' }, role: { entity: 'person', pool: 'role' },
  ops_lead: { entity: 'company', pool: 'person' }, hq: { entity: 'company', pool: 'city' }, lead: { entity: 'project', pool: 'person' },
  vendor: { entity: 'project', pool: 'org' }, price: { entity: 'deal', pool: 'price' }, seats: { entity: 'deal', pool: 'seats' },
  discount: { entity: 'deal', pool: 'discount' }, term: { entity: 'deal', pool: 'term' }, merger: { entity: 'company', pool: 'org' },
  offsite: { entity: 'company', pool: 'city' }, pilot: { entity: 'project', pool: 'org' },
};
/** The kinds each primary stratum draws its six slots from (every kind once, then at random). */
export const STRATUM_KINDS: Readonly<Record<string, readonly Kind[]>> = {
  s1_updated: ['city', 'employer', 'role', 'ops_lead', 'hq', 'lead'],
  s2_corrected: ['city', 'role', 'hq', 'lead', 'vendor', 'price'],
  s3_repeated_stale: ['city', 'employer', 'ops_lead', 'vendor'],
  s4_conflicting: ['price', 'seats', 'discount', 'term'],
  s5_withdrawn: ['merger', 'offsite', 'pilot'],
};
const SOURCE_RANK: Readonly<Record<Source, number>> = { executed: 5, owner_confirmed: 4, draft: 3, recap: 2, agent_note: 1 };

/** The alias and implication lexicon of a value of a pool. */
export function lexemeOf(pool: Pool, value: string): Lexeme {
  switch (pool) {
    case 'city': { const c = CITIES.find(x => x[0] === value)!; return { aliases: [...c[2]], implications: [...c[1]] }; }
    case 'org': return { aliases: [value.split(' ')[0]], implications: [] };
    case 'person': return { aliases: value.split(' '), implications: [] };
    case 'role': return { aliases: [], implications: [] };
    case 'price': { const n = value.slice(1, -4); return { aliases: [`${n},000`, `$${n}k`, `${n}k`, `${n} thousand`], implications: [] }; }
    case 'seats': { const n = value.split(' ')[0]; return { aliases: [`${n} licenses`, `${n} licences`, `${n} users`], implications: [] }; }
    case 'discount': { const n = value.slice(0, -1); return { aliases: [`${n} percent`, `${n} per cent`], implications: [] }; }
    case 'term': { const n = value.split(' ')[0]; return { aliases: [`${n}-month`, `${n} mo`], implications: [] }; }
  }
}

/** Every value a pool offers (people who are values are drawn from the name lists instead). */
export function poolValues(pool: Pool): string[] {
  switch (pool) {
    case 'city': return CITIES.map(c => c[0]);
    case 'org': return [...ORGS];
    case 'role': return [...ROLES];
    case 'person': return [];
    case 'price': return Array.from({ length: 160 }, (_, i) => `$${24 + 2 * i},000`);
    case 'seats': return Array.from({ length: 90 }, (_, i) => `${40 + 10 * i} seats`);
    case 'discount': return Array.from({ length: 36 }, (_, i) => `${6 + i}%`);
    case 'term': return TERM_MONTHS.map(n => `${n} months`);
  }
}

// ─── phrasing ────────────────────────────────────────────────────────

type Pair = readonly [readonly string[], readonly string[]];
export type QuestionKey = 'now' | 'asof' | 'known' | 'history' | 'signed';
export type ClauseKey = 'is' | 'became' | 'will' | 'mention' | 'plan' | 'off' | 'attr';
export interface KindPhrasing {
  is?: readonly string[]; became?: readonly string[]; will?: readonly string[]; mention?: readonly string[];
  plan?: readonly string[]; off?: readonly string[]; attr?: readonly string[];
  q: Partial<Record<QuestionKey, Pair>>;
}
export type FrameKey = 'state' | 'change' | 'late' | 'scheduled' | 'correct' | 'mention' | 'plan' | 'off' | 'retract' | Source;
export interface Phrasing { frames: Readonly<Record<FrameKey, readonly string[]>>; kinds: Readonly<Record<Kind, KindPhrasing>>; custody?: string }

/**
 * The public phrasing set. Clauses use {e} (the entity as the history names it: "Ana Okafor", "the Harbor deal"),
 * {n} (its bare name: "Harbor"), {v} (the value) and {date} (a date token). Frames wrap clauses ({is}, {became},
 * {will}, {mention}, {plan}, {off}) and may add {old} (the corrected value), {attr} (a contract field), {e} and {n}.
 */
export const PUBLIC_PHRASING: Phrasing = {
  frames: {
    state: ['{is}.', 'Quick note for later: {is}.', 'For the record, {is}.', 'Writing this down so I remember: {is}.'],
    change: ['Update: {became}.', 'News from this week: {became}.', 'Something changed: {became}.', 'Heard today that {became}.'],
    late: ['I only just heard that {became} back on {date}.', 'Nobody told me until now, but {became} on {date}.', 'Catching up on old news: {became} on {date}.'],
    scheduled: ['Heads up: {will}.', 'Planning note: {will}.', 'It is official that {will}.'],
    correct: ['Correction: I had that wrong earlier. It was never {old}; {is}.', 'I need to fix something I told you: not {old}. In fact {is}.', 'Scratch {old}, that was my mistake; {is}.'],
    mention: ['{mention}.', 'Side note, {mention}.', 'Funny timing: {mention}.'],
    plan: ['{plan}.', 'Big news: {plan}.', 'Keep this quiet for now, but {plan}.'],
    off: ['Change of plans: {off}.', 'It fell through: {off}.', 'Final word on that: {off}.'],
    retract: ['Forget what I said earlier about how {plan}; that was only a rumour and it is not happening.', 'Please ignore the report that {plan}; it turned out to be false.'],
    executed: ['The countersigned {n} contract sets the {attr} at {v}.', 'Both sides executed the {n} agreement today, and it fixes the {attr} at {v}.'],
    owner_confirmed: ['Our CFO confirmed in writing that the {attr} for {e} is final at {v}.', 'The account owner signed off in writing on {v} as the binding {attr} for {e}.'],
    draft: ['The draft amendment for {e} floats {v} for the {attr}.', 'A redlined draft of the {n} amendment proposes {v} as the {attr}.'],
    recap: ['The recap email from the {n} kickoff says the {attr} is {v}.', 'The meeting summary for {e} lists the {attr} as {v}.'],
    agent_note: ['My agent\'s notes on {e} record the {attr} as {v}.', 'The assistant\'s call notes for {e} say the {attr} is {v}.'],
  },
  kinds: {
    city: {
      is: ['{e} is based in {v}', '{e} lives in {v}'], became: ['{e} moved to {v}', '{e} relocated to {v}'], will: ['{e} moves to {v} on {date}'],
      mention: ['I had coffee with {e} in {v} again', '{e} sent photos from a walk around {v}', '{e} is hosting the book club at home in {v} this month', '{e} complained about the weather in {v}', '{e} recommended a bakery near home in {v}', '{e} is busy redecorating the flat in {v}'],
      q: {
        now: [['Which city is {e} based in now?'], ['Where does {e} live these days?']],
        asof: [['Which city was {e} based in on {date}?'], ['On {date}, where did {e} live?']],
        known: [['On {date}, which city had I been told {e} was based in?'], ['As of {date}, where did I think {e} lived?']],
        history: [['List the cities {e} has been based in, oldest first.'], ['In order from earliest, where has {e} lived?']],
      },
    },
    employer: {
      is: ['{e} works at {v}', '{e} is employed by {v}'], became: ['{e} joined {v}', '{e} started a new job at {v}'], will: ['{e} starts at {v} on {date}'],
      mention: ['{e} was stuck in a long all-hands at {v}', '{e} said the coffee at {v} is still terrible', '{e} is leading a hiring push at {v}', '{e} got a new badge photo at {v}', '{e} is buried in quarter planning at {v}', '{e} brought a {v} tote bag to the picnic'],
      q: {
        now: [['Where does {e} work now?'], ['Which company employs {e} at the moment?']],
        asof: [['Where did {e} work on {date}?'], ['On {date}, which company was {e} employed by?']],
        known: [['On {date}, where had I been told {e} worked?'], ['As of {date}, which company did I believe {e} worked for?']],
        history: [['List the companies {e} has worked at, oldest first.'], ['In order from earliest, which employers has {e} had?']],
      },
    },
    role: {
      is: ['{e} holds the title {v}', '{e} works as {v}'], became: ['{e} was promoted to {v}', '{e} took on the {v} role'], will: ['{e} becomes {v} on {date}'],
      q: {
        now: [['What is {e}\'s job title now?'], ['What role does {e} hold these days?']],
        asof: [['What was {e}\'s job title on {date}?'], ['On {date}, what role did {e} hold?']],
        known: [['On {date}, what had I been told {e}\'s job title was?'], ['As of {date}, which role did I think {e} held?']],
        history: [['List {e}\'s job titles, oldest first.'], ['In order from earliest, which roles has {e} held?']],
      },
    },
    ops_lead: {
      is: ['{v} runs operations at {e}', '{v} is the head of operations at {e}'], became: ['{v} took over operations at {e}', '{v} became head of operations at {e}'], will: ['{v} takes over operations at {e} on {date}'],
      mention: ['{v} ran the {e} operations review again', '{v} signed off on the {e} supplier list', '{v} sent the weekly {e} operations numbers', '{v} is still untangling the {e} shipping backlog', '{v} chaired the {e} operations standup', '{v} rearranged the warehouse shifts at {e}'],
      q: {
        now: [['Who runs operations at {e} now?'], ['Who is in charge of operations at {e} these days?']],
        asof: [['Who ran operations at {e} on {date}?'], ['On {date}, who was in charge of operations at {e}?']],
        known: [['On {date}, who had I been told ran operations at {e}?'], ['As of {date}, who did I think was in charge of operations at {e}?']],
        history: [['List the people who have run operations at {e}, oldest first.'], ['In order from earliest, who has been in charge of operations at {e}?']],
      },
    },
    hq: {
      is: ['{e} is headquartered in {v}', '{e} has its head office in {v}'], became: ['{e} moved its headquarters to {v}', '{e} relocated its head office to {v}'], will: ['{e} moves its headquarters to {v} on {date}'],
      q: {
        now: [['Where is {e} headquartered now?'], ['Which city is {e}\'s head office in these days?']],
        asof: [['Where was {e} headquartered on {date}?'], ['On {date}, which city was {e}\'s head office in?']],
        known: [['On {date}, where had I been told {e} was headquartered?'], ['As of {date}, which city did I think {e}\'s head office was in?']],
        history: [['List the cities {e} has been headquartered in, oldest first.'], ['In order from earliest, where has {e} had its head office?']],
      },
    },
    lead: {
      is: ['{v} leads {e}', '{v} is the lead on {e}'], became: ['{v} took over as lead of {e}', '{v} became the lead on {e}'], will: ['{v} takes over as lead of {e} on {date}'],
      q: {
        now: [['Who leads {e} now?'], ['Who is running {e} these days?']],
        asof: [['Who led {e} on {date}?'], ['On {date}, who was running {e}?']],
        known: [['On {date}, who had I been told led {e}?'], ['As of {date}, who did I think was running {e}?']],
        history: [['List the people who have led {e}, oldest first.'], ['In order from earliest, who has run {e}?']],
      },
    },
    vendor: {
      is: ['{e} buys from {v}', '{e} uses {v} as its vendor'], became: ['{e} switched its vendor to {v}', '{e} moved its contract over to {v}'], will: ['{e} switches its vendor to {v} on {date}'],
      mention: ['{v} sent another invoice for {e}', 'the {v} support desk fixed the {e} outage', '{e} had a review call with {v}', '{v} shipped the next batch for {e}', 'I renewed the {e} support plan with {v}', '{v} asked for feedback on {e}'],
      q: {
        now: [['Which vendor does {e} use now?'], ['Who supplies {e} at the moment?']],
        asof: [['Which vendor did {e} use on {date}?'], ['On {date}, who supplied {e}?']],
        known: [['On {date}, which vendor had I been told {e} used?'], ['As of {date}, who did I think supplied {e}?']],
        history: [['List the vendors {e} has used, oldest first.'], ['In order from earliest, who has supplied {e}?']],
      },
    },
    price: {
      is: ['the renewal price on {e} is {v} a year'], became: ['the renewal price on {e} changed to {v} a year'], attr: ['annual price'],
      q: {
        now: [['What is the renewal price on {e}?'], ['How much does {e} renew for each year now?']],
        known: [['On {date}, what had I been told the renewal price on {e} was?'], ['As of {date}, what did I think {e} renewed for each year?']],
        signed: [['What annual price did we actually sign for {e}?'], ['What yearly price is binding on {e}?']],
      },
    },
    seats: { attr: ['seat count'], q: { signed: [['How many seats did we actually sign for on {e}?'], ['What seat count is binding on {e}?']] } },
    discount: { attr: ['discount'], q: { signed: [['What discount did we actually sign on {e}?'], ['Which discount is binding on {e}?']] } },
    term: { attr: ['contract term'], q: { signed: [['What contract term did we actually sign for {e}?'], ['How long is the binding term on {e}?']] } },
    merger: {
      plan: ['{e} is merging with {v}', '{e} agreed to merge with {v}'], off: ['the merger between {e} and {v} is off', '{e} walked away from the merger with {v}'],
      q: { now: [['Which company is {e} merging with?'], ['Who is {e}\'s merger partner at this point?']] },
    },
    offsite: {
      plan: ['the {n} team offsite will be in {v}', '{e} is holding its team offsite in {v}'], off: ['the {n} offsite in {v} is cancelled', '{e} cancelled its team offsite in {v}'],
      q: { now: [['Where is the {n} team offsite being held?'], ['Which city is {e}\'s offsite in?']] },
    },
    pilot: {
      plan: ['{e} is running a pilot with {v}', '{e} signed {v} as its pilot customer'], off: ['the {e} pilot with {v} is cancelled', '{v} pulled out of the {e} pilot'],
      q: { now: [['Which customer is {e} piloting with?'], ['Who is {e}\'s pilot customer right now?']] },
    },
  },
};

/** Placeholders each frame must use; any frame may also name the entity ({e}, {n}). */
const FRAME_NEEDS: Readonly<Record<FrameKey, readonly string[]>> = {
  state: ['is'], change: ['became'], late: ['became', 'date'], scheduled: ['will'], correct: ['old', 'is'], mention: ['mention'], plan: ['plan'], off: ['off'],
  retract: ['plan'], executed: ['v', 'attr'], owner_confirmed: ['v', 'attr'], draft: ['v', 'attr'], recap: ['v', 'attr'], agent_note: ['v', 'attr'],
};
const placeholders = (t: string) => [...new Set([...t.matchAll(/\{([a-z]+)\}/g)].map(m => m[1]))];

/**
 * Check a phrasing set against the public set's shape: every key the public set has, each a non-empty list of
 * templates using the placeholders that key needs and no others, and (for a custody set) the custody marker.
 */
export function checkPhrasing(p: unknown, needMarker: boolean): Phrasing {
  const fail = (why: string): never => { throw new PlanError(`the phrasing set ${why}`); };
  const o = p as Phrasing;
  if (!o || typeof o !== 'object' || !o.frames || !o.kinds) fail('needs frames and kinds');
  if (needMarker && o.custody !== BG1_CUSTODY_MARKER) fail('lacks the custody marker');
  const list = (v: unknown, needs: readonly string[], allowed: readonly string[], key: string, entity: boolean) => {
    if (!Array.isArray(v) || !v.length || v.some(t => typeof t !== 'string')) fail(`has no templates for ${key}`);
    for (const t of v as string[]) {
      const ps = placeholders(t);
      if (needs.some(x => !ps.includes(x)) || ps.some(x => !allowed.includes(x) && !needs.includes(x))) fail(`has a template for ${key} with the wrong placeholders`);
      if (entity && !ps.includes('e') && !ps.includes('n')) fail(`has a template for ${key} that names no entity`);
    }
  };
  for (const k of Object.keys(PUBLIC_PHRASING.frames) as FrameKey[]) list(o.frames[k], FRAME_NEEDS[k], ['e', 'n'], `frames.${k}`, false);
  for (const [kind, pub] of Object.entries(PUBLIC_PHRASING.kinds) as Array<[Kind, KindPhrasing]>) {
    const mine = o.kinds[kind];
    if (!mine) fail(`has no kind ${kind}`);
    for (const k of ['is', 'became', 'will', 'mention', 'plan', 'off', 'attr'] as const) {
      if (!pub[k]) continue;
      if (k === 'attr') list(mine.attr, [], [], `kinds.${kind}.attr`, false);
      else list(mine[k], k === 'will' ? ['v', 'date'] : ['v'], ['e', 'n'], `kinds.${kind}.${k}`, true);
    }
    for (const qk of Object.keys(pub.q) as QuestionKey[]) {
      const m = mine.q?.[qk];
      if (!m) fail(`has no ${qk} questions for ${kind}`);
      const needs = qk === 'asof' || qk === 'known' ? ['date'] : [];
      list(m![0], needs, ['e', 'n'], `kinds.${kind}.q.${qk} exact`, true);
      list(m![1], needs, ['e', 'n'], `kinds.${kind}.q.${qk} paraphrase`, true);
    }
  }
  return o;
}

/** Read a custody phrasing set; it must carry the custody marker. */
export function loadPhrasing(path: string): Phrasing {
  return checkPhrasing(JSON.parse(readFileSync(path, 'utf8')), true);
}

// ─── terms ───────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRes = new Map<string, RegExp>();
/** A whole-word, case-insensitive match: no letter or digit may touch either end. */
export function termRegex(term: string): RegExp {
  let re = termRes.get(term);
  if (!re) { re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, 'iu'); termRes.set(term, re); }
  return re;
}
export const termsOf = (value: string, lex: Lexeme) => [value, ...lex.aliases, ...lex.implications];
const clash = (terms: readonly string[], texts: readonly string[]) => terms.some(t => texts.some(x => termRegex(t).test(x) || termRegex(x).test(t)));

/** Every static text the lines and questions are built from, with placeholders blanked. */
export function phrasingTexts(p: Phrasing): string[] {
  const out: string[] = [...Object.values(p.frames).flat()];
  for (const k of Object.values(p.kinds)) {
    for (const key of ['is', 'became', 'will', 'mention', 'plan', 'off', 'attr'] as const) out.push(...(k[key] ?? []));
    for (const pair of Object.values(k.q)) out.push(...pair![0], ...pair![1]);
  }
  return out.map(t => t.replace(/\{[a-z]+\}/g, ' '));
}

// ─── planner ─────────────────────────────────────────────────────────

const seedNumber = (s: string) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16);
/** A sealed world's seed: HMAC-SHA256 of the custody seed line and the world's mint slot. */
export const sealedWorldSeed = (seedLine: string, slot: number) => createHmac('sha256', seedLine.trim()).update(`bg1/world/${slot}`).digest('hex');
export const weekdayOf = (day: number) => WEEKDAYS[(((WEEKDAYS.indexOf(BG1_WORLD_END_WEEKDAY) + day) % 7) + 7) % 7];
const pad2 = (n: number) => String(n).padStart(2, '0');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fill = (t: string, ctx: Record<string, string>) => t.replace(/\{([a-z]+)\}/g, (_, k: string) => { if (ctx[k] === undefined) throw new PlanError(`a template names {${k}}, which has no value here`); return ctx[k]; });

class Names {
  readonly firsts = new Set<string>();
  readonly texts: string[] = [];
  constructor(readonly rng: Rng, staticTexts: readonly string[]) { this.texts.push(...staticTexts); }
  ok(terms: readonly string[]) { return !clash(terms, this.texts); }
  add(...texts: string[]) { this.texts.push(...texts); }
  first(): string {
    for (const f of this.rng.shuffle(FIRST_NAMES)) if (!this.firsts.has(f) && this.ok([f])) { this.firsts.add(f); return f; }
    throw new PlanError('first names ran out');
  }
}

class Board {
  readonly load: number[];
  readonly slotsAt: Array<Set<string>>;
  readonly exclusive: boolean[];
  constructor(readonly sessions: SessionPlan[], readonly rng: Rng) {
    this.load = sessions.map(() => 0); this.slotsAt = sessions.map(() => new Set()); this.exclusive = sessions.map(() => false);
  }
  free(i: number, slot: string) { return !this.exclusive[i] && !this.slotsAt[i].has(slot) && this.load[i] < BG1_MAX_LINES_PER_SESSION; }
  take(i: number, slot: string) { this.load[i]++; this.slotsAt[i].add(slot); }
  /** A session on a day in [lo, hi] with a free line and no line of the slot yet; exclusive keeps it to this one line and makes it long. */
  pick(lo: number, hi: number, slot: string, opts: { exclusive?: boolean; after?: number; before?: number } = {}): number {
    const ok = this.sessions.map((_, i) => i).filter(i => {
      const s = this.sessions[i];
      if (s.day < lo || s.day > hi || !this.free(i, slot)) return false;
      if (opts.after !== undefined && i <= opts.after) return false;
      if (opts.before !== undefined && i >= opts.before) return false;
      return !opts.exclusive || this.load[i] === 0;
    });
    if (!ok.length) throw new PlanError(`no free session between day ${lo} and ${hi}`);
    const i = this.rng.pick(ok);
    this.take(i, slot);
    if (opts.exclusive) { this.exclusive[i] = true; this.sessions[i].long = true; }
    return i;
  }
}

const TOPICS = [
  'sourdough baking', 'a home office rebuild', 'marathon training', 'a balcony herb garden', 'a weekend hiking route', 'learning the cello', 'a book club novel',
  'a broken dishwasher', 'meal prep for the week', 'a birthday party for a niece', 'a rescue dog\'s training', 'planning a camping trip', 'a pottery class',
  'restoring an old bicycle', 'a chess opening', 'a podcast episode', 'a board game night', 'a slow cooker stew', 'a kitchen repaint', 'a photography walk',
  'a sleep schedule', 'a language exchange', 'a jigsaw puzzle', 'a backyard bird feeder',
];

export interface PlanOptions { phrasing?: Phrasing; custody?: boolean; publicSeed?: boolean }

/**
 * The world plan for one world id and seed. Deterministic: the same id, seed and phrasing give the same plan. A seed
 * that cannot be placed (rare) moves on to the next attempt of the same seed, so the result stays deterministic.
 */
export function planWorld(id: string, seed: string, opts: PlanOptions = {}): WorldPlan {
  const phrasing = opts.phrasing ?? PUBLIC_PHRASING;
  let last: Error | null = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const plan = buildPlan(id, `${seed}#${attempt}`, phrasing, opts.custody === true, opts.publicSeed ? seed : undefined);
      buildQuestions(plan, phrasing);
      return plan;
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
      last = e;
    }
  }
  throw new PlanError(`world ${id}: no attempt could be placed (${last?.message})`);
}

function buildPlan(id: string, seed: string, phrasing: Phrasing, custody: boolean, publicSeed: string | undefined): WorldPlan {
  const rng = new Rng(seedNumber(seed));
  const names = new Names(rng, [...phrasingTexts(phrasing), ...TOPICS, ...FILLER_TEXTS, ...WEEKDAYS]);
  const frames = custody ? { ...phrasing.frames, retract: phrasing.frames.retract.filter(t => NONE_FORMS.some(f => termRegex(f).test(t))) } : phrasing.frames;
  if (!frames.retract.length) throw new Error('the custody phrasing set has no retract template that says the plan is not happening (gold audit, Amendment 4)');

  const n = rng.int(BG1_SESSIONS.min, BG1_SESSIONS.max);
  const first = -(BG1_SPAN_DAYS - 1) + rng.int(0, 4), lastDay = -rng.int(0, 2);
  const days = [first, lastDay, ...Array.from({ length: n - 2 }, () => rng.int(first, lastDay))].sort((a, b) => a - b);
  const sessions: SessionPlan[] = days.map(day => ({ id: '', day, time: `${pad2(rng.int(8, 21))}:${pad2(rng.int(0, 11) * 5)}`, topic: rng.pick(TOPICS), long: rng.float() < 0.08, lines: [] }));
  sessions.sort((a, b) => a.day - b.day || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  sessions.forEach((s, i) => {
    if (i > 0 && sessions[i - 1].day === s.day && sessions[i - 1].time >= s.time) s.time = laterTime(sessions[i - 1].time);
    s.id = `s${String(i + 1).padStart(3, '0')}`;
  });
  const F = sessions[0].day, L = sessions[sessions.length - 1].day;
  const board = new Board(sessions, rng);

  const entities: Entity[] = [];
  const kindsOf = new Map<string, Set<Kind>>();
  const pairsOf = (type: EntityType) => (type === 'person' ? SURNAME_PAIRS : type === 'company' ? COMPANY_PAIRS : type === 'project' ? PROJECT_PAIRS : DEAL_PAIRS);
  const pairUsed: Record<EntityType, Set<number>> = { person: new Set(), company: new Set(), project: new Set(), deal: new Set() };
  const newEntity = (type: EntityType): Entity => {
    for (const i of rng.shuffle(pairsOf(type).map((_, k) => k))) {
      const [a, b] = pairsOf(type)[i];
      if (pairUsed[type].has(i) || !names.ok([a, b])) continue;
      pairUsed[type].add(i);
      const prefix = type === 'person' ? `${names.first()} ` : type === 'project' ? 'Project ' : '';
      names.add(prefix + a, prefix + b);
      const e: Entity = { id: `${type}-${pad2(entities.filter(x => x.type === type).length + 1)}`, type, name: prefix + a };
      entities.push(e);
      kindsOf.set(e.id, new Set());
      return e;
    }
    throw new PlanError(`${type} names ran out`);
  };
  const entityFor = (kind: Kind): Entity => {
    const type = KINDS[kind].entity;
    const open = entities.filter(e => e.type === type && !kindsOf.get(e.id)!.has(kind) && kindsOf.get(e.id)!.size < 2);
    const e = open.length && rng.float() < 0.5 ? rng.pick(open) : newEntity(type);
    kindsOf.get(e.id)!.add(kind);
    return e;
  };

  const lexicon: Record<string, Lexeme> = {};
  const takeValue = (kind: Kind): string => {
    const pool = KINDS[kind].pool;
    const candidates = pool === 'person' ? Array.from({ length: 60 }, () => `${rng.pick(FIRST_NAMES)} ${rng.pick(VALUE_SURNAMES)}`) : rng.shuffle(poolValues(pool));
    for (const v of candidates) {
      if (lexicon[v] || (pool === 'person' && names.firsts.has(v.split(' ')[0]))) continue;
      const lex = lexemeOf(pool, v);
      if (!names.ok([v, ...lex.aliases])) continue;
      if (lex.implications.some(t => !names.ok([t]))) continue;
      if (pool === 'person') names.firsts.add(v.split(' ')[0]);
      names.add(v, ...lex.aliases);
      lexicon[v] = lex;
      return v;
    }
    throw new PlanError(`values ran out for ${kind}`);
  };

  const slots: Slot[] = [];
  const entityText = (e: Entity) => ({ e: e.type === 'deal' ? `the ${e.name} deal` : e.name, n: e.name });
  const addEvent = (slot: Slot, type: EventType, value: string, at: number, extra: Partial<SlotEvent> = {}): SlotEvent => {
    const e: SlotEvent = { id: `${slot.id}#${slot.events.length}`, type, value, session: sessions[at].id, said: sessions[at].day, valid_from: sessions[at].day, ...extra };
    slot.events.push(e);
    return e;
  };
  const say = (slot: Slot, ev: SlotEvent, frame: FrameKey, extra: Record<string, string> = {}, position: 'any' | 'middle' = 'any') => {
    const kp = phrasing.kinds[slot.kind];
    const base: Record<string, string> = { ...entityText(entities.find(x => x.id === slot.entity)!), v: ev.value, ...extra };
    const clause = (k: ClauseKey) => fill(rng.pick(kp[k] as readonly string[]), base);
    const ctx: Record<string, string> = { ...base };
    if (frame === 'state' || frame === 'correct') ctx.is = clause('is');
    if (frame === 'change' || frame === 'late') ctx.became = clause('became');
    if (frame === 'scheduled') ctx.will = clause('will');
    if (frame === 'mention') ctx.mention = clause('mention');
    if (frame === 'plan' || frame === 'retract') ctx.plan = clause('plan');
    if (frame === 'off') ctx.off = clause('off');
    if (frame in SOURCE_RANK) ctx.attr = clause('attr');
    const text = cap(fill(rng.pick(frames[frame]), ctx));
    sessions.find(x => x.id === ev.session)!.lines.push({ text, slot: slot.id, event: ev.id, values: frame === 'correct' ? [extra.old, ev.value] : [ev.value], speaker: 'user', position });
  };

  function planUpdated(slot: Slot, late: boolean, scheduled: boolean) {
    const k = rng.int(2, 4);
    const lo = F + 3, len = Math.floor((L - 30 - lo) / k);
    const lateAt = late ? rng.int(1, k - 1) : -1;
    const values = Array.from({ length: k }, () => takeValue(slot.kind));
    let prev = -1;
    values.forEach((v, i) => {
      const start = lo + i * len, end = start + len - 1;
      if (i === 0) {
        prev = board.pick(start, start + Math.floor(len / 2), slot.id);
        say(slot, addEvent(slot, 'state', v, prev), 'state');
      } else if (i === lateAt) {
        const vf = rng.int(start + 5, end - 70);
        prev = board.pick(vf + 21, Math.min(vf + 60, end - 3), slot.id, { after: prev });
        say(slot, addEvent(slot, 'late', v, prev, { valid_from: vf }), 'late', { date: token(vf) });
      } else {
        prev = board.pick(start + 5, end - 5, slot.id, { after: prev });
        say(slot, addEvent(slot, 'change', v, prev), 'change');
      }
    });
    slot.intent = { now: values[k - 1], history: [...values] };
    if (!scheduled) return;
    const v = takeValue(slot.kind), vf = rng.int(BG1_FUTURE_DAYS.min, BG1_FUTURE_DAYS.max);
    const at = board.pick(Math.max(L - 120, sessions[prev].day + 7), L - 3, slot.id, { after: prev });
    say(slot, addEvent(slot, 'scheduled', v, at, { valid_from: vf }), 'scheduled', { date: token(vf) });
  }

  function planCorrected(slot: Slot, afterChange: boolean) {
    let at0 = -1;
    const history: string[] = [];
    if (afterChange) {
      const x = takeValue(slot.kind);
      at0 = board.pick(F + 5, F + 150, slot.id);
      say(slot, addEvent(slot, 'state', x, at0), 'state');
      history.push(x);
    }
    const a = takeValue(slot.kind), b = takeValue(slot.kind);
    const at1 = board.pick(at0 < 0 ? F + 10 : sessions[at0].day + 45, L - 140, slot.id, { after: at0 });
    const wrong = addEvent(slot, afterChange ? 'change' : 'state', a, at1);
    say(slot, wrong, afterChange ? 'change' : 'state');
    const at2 = board.pick(sessions[at1].day + 20, Math.min(sessions[at1].day + 150, L - 10), slot.id, { after: at1 });
    say(slot, addEvent(slot, 'correct', b, at2, { valid_from: wrong.valid_from, replaces: wrong.id }), 'correct', { old: a });
    slot.intent = { now: b, history: [...history, b] };
  }

  function planRepeated(slot: Slot) {
    const a = takeValue(slot.kind), b = takeValue(slot.kind);
    const m = rng.int(8, 15);
    const at0 = board.pick(F + 3, F + 90, slot.id);
    say(slot, addEvent(slot, 'state', a, at0), 'state');
    const atB = board.pick(L - 200, L - 20, slot.id, { after: at0 });
    const between = sessions.map((_, i) => i).filter(i => i > at0 && i < atB && board.free(i, slot.id));
    if (between.length < m - 1) throw new PlanError('too few sessions for the repeated value');
    for (const i of rng.shuffle(between).slice(0, m - 1).sort((x, y) => x - y)) {
      board.take(i, slot.id);
      say(slot, addEvent(slot, 'mention', a, i, { valid_from: null }), 'mention');
    }
    say(slot, addEvent(slot, 'change', b, atB), 'change');
    slot.intent = { now: b, history: [a, b] };
  }

  function planConflicting(slot: Slot, executed: boolean) {
    const gv = takeValue(slot.kind);
    const g0 = rng.int(F + 60, L - 150);
    const atG = board.pick(g0, g0 + 20, slot.id, { exclusive: true });
    const gd = sessions[atG].day;
    const before = rng.float() < 0.5;
    const lower = rng.shuffle<Source>(['draft', 'recap', 'agent_note', 'draft', 'recap', 'agent_note']).slice(0, rng.int(2, 4));
    const all: Array<[number, Source, string]> = [[atG, executed ? 'executed' : 'owner_confirmed', gv]];
    lower.forEach((src, i) => {
      const v = takeValue(slot.kind);
      all.push([before && i === 0 ? board.pick(gd - 45, gd - 3, slot.id, { before: atG }) : board.pick(gd + 3, gd + 90, slot.id, { after: atG }), src, v]);
    });
    for (const [at, src, v] of all.sort((x, y) => x[0] - y[0])) say(slot, addEvent(slot, 'source', v, at, { source: src }), src, {}, at === atG ? 'middle' : 'any');
    slot.intent = { now: gv, history: [gv] };
  }

  function planWithdrawn(slot: Slot, rumour: boolean) {
    const v = takeValue(slot.kind);
    let at = board.pick(F + 20, L - 200, slot.id);
    say(slot, addEvent(slot, 'plan', v, at), 'plan');
    for (let i = rng.int(1, 3); i > 1; i--) {
      at = board.pick(sessions[at].day + 5, sessions[at].day + 60, slot.id, { after: at });
      say(slot, addEvent(slot, 'plan', v, at), 'plan');
    }
    const w = board.pick(sessions[at].day + 30, L - 5, slot.id, { after: at });
    say(slot, addEvent(slot, 'withdraw', v, w, { valid_from: null, rumour }), rumour ? 'retract' : 'off');
    slot.intent = { now: null, history: [] };
  }

  for (const stratum of BG1_PRIMARY) {
    const kinds = STRATUM_KINDS[stratum];
    const picks = rng.shuffle([...kinds, ...Array.from({ length: BG1_SLOTS_PER_STRATUM - kinds.length }, () => rng.pick(kinds))]);
    const half = rng.shuffle([true, true, true, false, false, false]);
    const third = rng.shuffle([true, true, false, false, false, false]);
    picks.forEach((kind, k) => {
      const ent = entityFor(kind);
      const slot: Slot = { id: `${ent.id}.${kind}`, entity: ent.id, kind, stratum, events: [], intent: { now: null, history: [] } };
      slots.push(slot);
      if (stratum === 's1_updated') planUpdated(slot, half[k], third[k]);
      else if (stratum === 's2_corrected') planCorrected(slot, half[k]);
      else if (stratum === 's3_repeated_stale') planRepeated(slot);
      else if (stratum === 's4_conflicting') planConflicting(slot, half[k]);
      else planWithdrawn(slot, third[k]);
    });
  }

  for (const t of rng.shuffle([...slots]).slice(0, BG1_DECOY_SLOTS)) {
    const ent = entities.find(e => e.id === t.entity)!;
    let twin = entities.find(e => e.twin_of === ent.id);
    if (!twin) {
      const [a, b] = pairsOf(ent.type).find(([x]) => ent.name === x || ent.name.endsWith(` ${x}`))!;
      twin = { id: `${ent.id}-twin`, type: ent.type, name: ent.name.slice(0, ent.name.length - a.length) + b, twin_of: ent.id };
      entities.push(twin);
    }
    const slot: Slot = { id: `${twin.id}.${t.kind}`, entity: twin.id, kind: t.kind, stratum: 'decoy', twin_slot: t.id, events: [], intent: { now: null, history: [] } };
    slots.push(slot);
    const v = takeValue(t.kind);
    const at = board.pick(F + 3, L - 3, slot.id);
    if (t.stratum === 's4_conflicting') say(slot, addEvent(slot, 'source', v, at, { source: 'executed' }), 'executed');
    else if (t.stratum === 's5_withdrawn') say(slot, addEvent(slot, 'plan', v, at), 'plan');
    else say(slot, addEvent(slot, 'state', v, at), 'state');
    slot.intent = { now: v, history: [v] };
  }

  for (const s of sessions) if (s.lines.length > 1) s.lines = rng.shuffle(s.lines);
  const plan: WorldPlan = {
    schema: BG1_PLAN_SCHEMA, generator: BG1_GENERATOR_VERSION, id, ...(publicSeed ? { seed: publicSeed } : {}), ...(custody ? { custody: BG1_CUSTODY_MARKER } : {}),
    world_end_weekday: BG1_WORLD_END_WEEKDAY, entities, slots, sessions, lexicon: Object.fromEntries(Object.entries(lexicon).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  checkPlan(plan);
  return plan;
}

function laterTime(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const total = Math.min(h * 60 + m + 35, 23 * 60 + 55);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/**
 * Plan invariants: 140 to 160 sessions over about 18 months ending on day 0, 30 tracked slots (six per primary
 * stratum), no value sharing a term with another, and every line holding its own values and no other value's term.
 */
export function checkPlan(plan: WorldPlan): void {
  const fail = (why: string): never => { throw new PlanError(`plan ${plan.id}: ${why}`); };
  if (plan.sessions.length < BG1_SESSIONS.min || plan.sessions.length > BG1_SESSIONS.max) fail('the session count is outside 140 to 160');
  if (plan.sessions.some((s, i) => i > 0 && !(plan.sessions[i - 1].day < s.day || (plan.sessions[i - 1].day === s.day && plan.sessions[i - 1].time < s.time)))) fail('the sessions are not in strict time order');
  const span = plan.sessions[plan.sessions.length - 1].day - plan.sessions[0].day;
  if (span < BG1_SPAN_DAYS - 10 || plan.sessions.some(s => s.day > 0)) fail('the sessions do not span about 18 months ending on day 0');
  const tracked = plan.slots.filter(s => s.stratum !== 'decoy');
  if (tracked.length !== BG1_TRACKED_SLOTS) fail(`it has ${tracked.length} tracked slots`);
  for (const st of BG1_PRIMARY) if (tracked.filter(s => s.stratum === st).length !== BG1_SLOTS_PER_STRATUM) fail(`stratum ${st} does not hold six slots`);
  const values = Object.keys(plan.lexicon);
  for (const v of values) for (const w of values) if (v !== w && clash([v, ...plan.lexicon[v].aliases], termsOf(w, plan.lexicon[w]))) fail('two values share a term');
  for (const s of plan.sessions) {
    if (s.lines.length > BG1_MAX_LINES_PER_SESSION) fail(`${s.id} holds too many lines`);
    for (const l of s.lines) {
      if (l.values.some(v => !termRegex(v).test(l.text))) fail(`a line in ${s.id} lacks its value`);
      for (const w of values) if (!l.values.includes(w) && termsOf(w, plan.lexicon[w]).some(t => termRegex(t).test(l.text))) fail(`a line in ${s.id} holds another value's term`);
    }
  }
}

// ─── oracles ─────────────────────────────────────────────────────────

const ASSERTS: ReadonlySet<EventType> = new Set(['state', 'change', 'late', 'scheduled']);
const dayKey = (d: number) => addDays('2400-01-01', d);
/** The counted "now": the question date, the day after the world end. */
export const QUESTION_DAY = 1;

export interface OracleResult { values: string[]; events: SlotEvent[] }
interface Timed { day: number; value: string; event: SlotEvent }

/** Valid-time assertions with each correction applied: a corrected value takes the replaced event's valid time. */
function validTimeline(slot: Slot): Timed[] {
  const fixes = new Map(slot.events.filter(e => e.type === 'correct').map(e => [e.replaces!, e]));
  return slot.events.filter(e => ASSERTS.has(e.type)).map(e => { const fix = fixes.get(e.id); return { day: e.valid_from!, value: fix ? fix.value : e.value, event: fix ?? e }; });
}

/** job-state.ts's forward machine over (day, value) events: the value held at the end of the query day, and the event that set it. */
function forward(events: Timed[], query: number): { value: string | null; event: SlotEvent | null } {
  const ids: string[] = [];
  const idOf = (v: string) => { if (!ids.includes(v)) ids.push(v); return `startup-${ids.indexOf(v)}`; };
  const fsm = new ForwardJobState([dayKey(query)]);
  const ordered = events.map((e, i) => ({ ...e, i })).sort((a, b) => a.day - b.day || a.event.said - b.event.said || a.i - b.i);
  for (const e of ordered) fsm.observe(dayKey(e.day), `joined ${idOf(e.value)}`);
  const held = fsm.finish().get(dayKey(query)) ?? null;
  if (held === null) return { value: null, event: null };
  const value = ids[Number(held.slice('startup-'.length))];
  return { value, event: ordered.filter(e => e.day <= query && e.value === value).pop()?.event ?? null };
}
const result = (r: { value: string | null; event: SlotEvent | null }, more: SlotEvent[] = []): OracleResult => ({ values: r.value === null ? [] : [r.value], events: [...(r.event ? [r.event] : []), ...more] });

/** s1: the value in effect on the question day, by valid time; a scheduled change after it does not count. */
export function oracleUpdated(slot: Slot): OracleResult {
  return result(forward(validTimeline(slot), QUESTION_DAY), slot.events.filter(e => e.type === 'scheduled' && e.valid_from! > QUESTION_DAY));
}

/** s2: statements replayed in the order they were said; a correction overwrites the value it says was never true. */
export function oracleCorrected(slot: Slot): OracleResult {
  let current: SlotEvent | null = null;
  const replaced: SlotEvent[] = [];
  for (const e of [...slot.events].sort((a, b) => a.said - b.said)) {
    if (ASSERTS.has(e.type) && e.valid_from! <= QUESTION_DAY) current = e;
    if (e.type === 'correct') { replaced.push(slot.events.find(x => x.id === e.replaces)!); current = e; }
  }
  return { values: current ? [current.value] : [], events: [...replaced, ...(current ? [current] : [])] };
}

/** s3: the assertion with the latest valid time on or before the question day; mentions repeat a value and never change it. */
export function oracleRepeatedStale(slot: Slot): OracleResult {
  const best = slot.events.filter(e => ASSERTS.has(e.type) && e.valid_from! <= QUESTION_DAY).reduce<SlotEvent | null>((b, e) => (!b || e.valid_from! >= b.valid_from! ? e : b), null);
  return { values: best ? [best.value] : [], events: best ? [best] : [] };
}

/** s4: the source with the highest authority (executed, owner-confirmed, draft, recap, agent note); a later effective date breaks a tie. */
export function oracleConflicting(slot: Slot): OracleResult {
  const best = slot.events.filter(e => e.type === 'source').reduce<SlotEvent | null>((b, e) => {
    if (!b) return e;
    const d = SOURCE_RANK[e.source!] - SOURCE_RANK[b.source!];
    return d > 0 || (d === 0 && e.valid_from! > b.valid_from!) ? e : b;
  }, null);
  return { values: best ? [best.value] : [], events: best ? [best] : [] };
}

/** s5: plans and withdrawals replayed in the order they were said; a withdrawal leaves nothing current. */
export function oracleWithdrawn(slot: Slot): OracleResult {
  let current: SlotEvent | null = null;
  const trail: SlotEvent[] = [];
  for (const e of [...slot.events].sort((a, b) => a.said - b.said)) {
    if (e.type === 'plan' || ASSERTS.has(e.type)) { current = e; trail.push(e); }
    if (e.type === 'withdraw' && current?.value === e.value) { current = null; trail.push(e); }
  }
  return { values: current ? [current.value] : [], events: trail };
}

/** s6: the value in effect at the end of a past day, by valid time. */
export function oracleAsOf(slot: Slot, day: number): OracleResult {
  return result(forward(validTimeline(slot), day));
}

/** s7: what the user had been told by the end of a past day: the latest value learned, corrections included. */
export function oracleAsKnown(slot: Slot, day: number): OracleResult {
  const learned = slot.events.filter(e => e.type === 'state' || e.type === 'change' || e.type === 'late' || e.type === 'mention' || e.type === 'correct').map(e => ({ day: e.said, value: e.value, event: e }));
  return result(forward(learned, day));
}

/** s8: the values that were ever true, in valid-time order, oldest first (never-true and not-yet-effective values excluded). */
export function oracleHistory(slot: Slot): OracleResult {
  const values: string[] = [];
  const events: SlotEvent[] = [];
  for (const e of validTimeline(slot).filter(x => x.day <= QUESTION_DAY).sort((a, b) => a.day - b.day)) if (values[values.length - 1] !== e.value) { values.push(e.value); events.push(e.event); }
  return { values, events };
}

const PRIMARY_ORACLE: Readonly<Record<string, (s: Slot) => OracleResult>> = {
  s1_updated: oracleUpdated, s2_corrected: oracleCorrected, s3_repeated_stale: oracleRepeatedStale, s4_conflicting: oracleConflicting, s5_withdrawn: oracleWithdrawn,
};

/** The query day of an s6 or s7 question: its date token. */
export function queryDayOf(question: string): number | undefined {
  const m = /\[\[D:(-?\d+)\]\]/.exec(question);
  return m ? Number(m[1]) : undefined;
}

/** One question's gold from the plan alone (no rendered text): its stratum's oracle at its slot and, for s6 and s7, its date. */
export function deriveGold(plan: WorldPlan, q: Pick<QuestionRecord, 'question' | 'bg1'>): OracleResult {
  const slot = plan.slots.find(s => s.id === q.bg1.slot);
  if (!slot) throw new PlanError(`plan ${plan.id} has no slot ${q.bg1.slot}`);
  const st = q.bg1.stratum;
  if (PRIMARY_ORACLE[st]) return PRIMARY_ORACLE[st](slot);
  if (st === 's8_history') return oracleHistory(slot);
  const day = queryDayOf(q.question);
  if (day === undefined) throw new PlanError(`${st} question ${q.bg1.slot} has no date`);
  return st === 's6_as_of' ? oracleAsOf(slot, day) : oracleAsKnown(slot, day);
}

// ─── questions ───────────────────────────────────────────────────────

/** Accepted forms when nothing is current (s5). */
export const NONE_FORMS = ['none', 'no one', 'nothing', 'called off', 'cancelled', 'canceled', 'not happening', 'no longer'];

/** The gold fields a plan's oracle gives one question: what a check of questions.json against the plan compares. */
export function goldFields(plan: WorldPlan, q: Pick<QuestionRecord, 'question' | 'bg1'>): Pick<Bg1QuestionFields, 'gold_values' | 'stale_values' | 'decoy_values'> & { evidence_sessions: string[] } {
  const slot = plan.slots.find(s => s.id === q.bg1.slot)!;
  const gold = deriveGold(plan, q);
  return {
    gold_values: q.bg1.stratum === 's8_history' ? gold.values : gold.values.length ? gold.values.flatMap(v => [v, ...plan.lexicon[v].aliases]) : [...NONE_FORMS],
    stale_values: [...new Set(slot.events.map(e => e.value))].filter(v => !gold.values.includes(v)),
    decoy_values: [...new Set(plan.slots.filter(s => s.twin_slot === slot.id).flatMap(s => s.events.map(e => e.value)))],
    evidence_sessions: [...new Set(gold.events.map(e => e.session))].sort(),
  };
}

const token = (d: number) => `[[D:${d}]]`;

/**
 * The 64 questions of a plan. Throws PlanError when a stratum's oracle disagrees with what the planner meant, or when
 * a secondary stratum cannot find eight slots with a usable date.
 */
export function buildQuestions(plan: WorldPlan, phrasing: Phrasing = PUBLIC_PHRASING): QuestionRecord[] {
  const rng = new Rng(seedNumber(`${plan.id}/questions/${plan.slots.map(s => s.id).join(',')}`));
  const out: QuestionRecord[] = [];
  const entityText = (slot: Slot) => { const e = plan.entities.find(x => x.id === slot.entity)!; return { e: e.type === 'deal' ? `the ${e.name} deal` : e.name, n: e.name }; };
  const balanced = (n: number) => rng.shuffle<'exact' | 'paraphrase'>(Array.from({ length: n }, (_, i) => (i % 2 ? 'paraphrase' : 'exact')));
  const ask = (slot: Slot, key: QuestionKey, form: 'exact' | 'paraphrase', extra: Record<string, string> = {}) => {
    const pair = phrasing.kinds[slot.kind].q[key];
    if (!pair) throw new PlanError(`no ${key} question for ${slot.kind}`);
    return cap(fill(rng.pick(pair[form === 'exact' ? 0 : 1]), { ...entityText(slot), ...extra }));
  };
  const push = (stratum: Bg1Stratum, slot: Slot, form: 'exact' | 'paraphrase', question: string, want: readonly string[], extra: Partial<Bg1QuestionFields> = {}) => {
    const bg1 = { stratum, family: familyOf(stratum), form, slot: slot.id, gold_values: [], stale_values: [], decoy_values: [], ...(stratum === 's8_history' ? { ordered: true } : {}), ...extra } as Bg1QuestionFields;
    const gold = deriveGold(plan, { question, bg1 });
    if (gold.values.join('\u0000') !== want.join('\u0000')) throw new PlanError(`${plan.id} ${slot.id}: the ${stratum} oracle disagrees with the plan`);
    const { evidence_sessions, ...fields } = goldFields(plan, { question, bg1 });
    const answer = stratum === 's5_withdrawn' ? withdrawnAnswer(slot) : stratum === 's8_history' ? gold.values.join(', then ') : gold.values[0];
    out.push({ id: `${plan.id}:${stratum}:${out.filter(q => q.bg1.stratum === stratum).length}`, question, answer, evidence_sessions, bg1: { ...bg1, ...fields }, ...(plan.custody ? { custody: plan.custody } : {}) });
  };

  for (const stratum of BG1_PRIMARY) {
    const slots = plan.slots.filter(s => s.stratum === stratum);
    const doubled = new Set(rng.shuffle(slots.map(s => s.id)).slice(0, BG1_QUESTIONS_PER_STRATUM - slots.length));
    const single = balanced(slots.length - doubled.size);
    for (const slot of slots) {
      const extra: Partial<Bg1QuestionFields> = {};
      if (stratum === 's4_conflicting') {
        const g = oracleConflicting(slot).events[0];
        extra.deciding_line = plan.sessions.find(x => x.id === g.session)!.lines.find(l => l.event === g.id)!.text;
      }
      const key: QuestionKey = stratum === 's4_conflicting' ? 'signed' : 'now';
      for (const form of doubled.has(slot.id) ? (['exact', 'paraphrase'] as const) : [single.shift()!]) push(stratum, slot, form, ask(slot, key, form), slot.intent.now === null ? [] : [slot.intent.now], extra);
    }
  }

  const eight = <T>(xs: T[], what: string) => { if (xs.length < BG1_QUESTIONS_PER_STRATUM) throw new PlanError(`${plan.id}: only ${xs.length} slots for ${what}`); return xs.slice(0, BG1_QUESTIONS_PER_STRATUM); };
  const quietDay = (slot: Slot, lo: number, hi: number) => {
    const busy = slot.events.flatMap(e => [e.said, e.valid_from ?? e.said]);
    const days = Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i).filter(d => busy.every(b => Math.abs(b - d) >= 3));
    return days.length ? rng.pick(days) : null;
  };
  const changing = plan.slots.filter(s => s.stratum === 's1_updated' || s.stratum === 's3_repeated_stale');

  const asOf: Array<[Slot, number, string]> = [];
  for (const slot of rng.shuffle(changing)) {
    if (oracleHistory(slot).values.join('\u0000') !== slot.intent.history.join('\u0000')) throw new PlanError(`${plan.id} ${slot.id}: the history oracle disagrees with the plan`);
    const tl = validTimeline(slot).filter(e => e.day <= QUESTION_DAY).sort((a, b) => a.day - b.day);
    const firstSaid = Math.min(...slot.events.map(e => e.said));
    const windows = tl.slice(0, -1).map((e, i) => [Math.max(e.day, firstSaid) + 3, tl[i + 1].day - 3, e.value] as const).filter(([lo, hi]) => hi - lo >= 8);
    if (!windows.length) continue;
    const [lo, hi, value] = rng.pick(windows);
    const day = quietDay(slot, lo, hi);
    if (day !== null) asOf.push([slot, day, value]);
  }
  const f6 = balanced(BG1_QUESTIONS_PER_STRATUM);
  for (const [slot, day, value] of eight(asOf, 's6_as_of')) {
    const form = f6.shift()!;
    push('s6_as_of', slot, form, ask(slot, 'asof', form, { date: token(day) }), [value]);
  }

  const asKnown: Array<[Slot, number, string]> = [];
  for (const slot of plan.slots.filter(s => s.stratum === 's2_corrected')) {
    const fix = slot.events.find(e => e.type === 'correct')!;
    const wrong = slot.events.find(e => e.id === fix.replaces)!;
    const day = quietDay(slot, wrong.said + 3, fix.said - 3);
    if (day !== null) asKnown.push([slot, day, wrong.value]);
  }
  for (const slot of plan.slots.filter(s => s.stratum === 's1_updated')) {
    const late = slot.events.find(e => e.type === 'late');
    if (!late) continue;
    const told = slot.events.filter(e => e.said < late.said && e.type !== 'scheduled').pop()!;
    const day = quietDay(slot, Math.max(late.valid_from!, told.said) + 3, late.said - 3);
    if (day !== null) asKnown.push([slot, day, told.value]);
  }
  const f7 = balanced(BG1_QUESTIONS_PER_STRATUM);
  for (const [slot, day, value] of eight(rng.shuffle(asKnown), 's7_as_known')) {
    const form = f7.shift()!;
    push('s7_as_known', slot, form, ask(slot, 'known', form, { date: token(day) }), [value]);
  }

  const f8 = balanced(BG1_QUESTIONS_PER_STRATUM);
  const histories = plan.custody ? changing.filter(s => !s.events.some(e => e.type === 'scheduled')) : changing;
  for (const slot of eight(rng.shuffle(histories).sort((a, b) => b.intent.history.length - a.intent.history.length), 's8_history')) {
    const form = f8.shift()!;
    push('s8_history', slot, form, ask(slot, 'history', form), slot.intent.history);
  }
  return out;
}

function withdrawnAnswer(slot: Slot): string {
  const w = slot.events.find(e => e.type === 'withdraw')!;
  return w.rumour ? `None: the report about ${w.value} was a rumour, and nothing is planned.` : `None: the plan with ${w.value} was called off.`;
}

// ─── template renderer ───────────────────────────────────────────────

const FILLER: Readonly<Record<'user' | 'assistant' | 'lead' | 'ack', readonly string[]>> = {
  user: [
    'I spent most of the evening on {t} and lost track of time.', 'Can you help me think through {t} for a minute?', 'I keep coming back to {t} this week.',
    'Small progress on {t}, but I hit a snag halfway through.', 'A friend asked me about {t} and I had no good answer.', 'I want a simple plan for {t} that I can actually follow.',
    'Honestly, {t} has been the most relaxing part of my week.', 'I tried a new approach to {t} and it mostly worked.', 'What would you do first with {t} if you had one free hour?',
    'I wrote a short checklist for {t} but it feels too long.', 'The trickiest part of {t} is staying patient.', 'I watched a tutorial about {t} and took notes.',
  ],
  assistant: [
    'Start with the smallest step you can finish today, then build from there.', 'That sounds like steady progress; a short routine usually beats a long one.',
    'One option is to set a timer and stop while it still feels easy.', 'Try writing down what went well, so you can repeat it next time.',
    'If it feels stuck, change one thing at a time and watch what happens.', 'A little preparation the night before can make the next session smoother.',
    'You could ask a friend to join, which tends to keep things fun.', 'It helps to keep notes short, with one line for each attempt.',
    'Patience pays off here; most people notice a change after a few tries.', 'Break the task into three parts and tackle the easiest part first.',
  ],
  lead: ['One more thing.', 'Before I forget.', 'Unrelated, but worth noting.', 'Also, a quick update.', 'Changing the subject for a second.', 'By the way.'],
  ack: ['Noted, I will keep that in mind.', 'Got it, thanks for telling me.', 'Thanks, that is useful to know.', 'Understood, I have made a note of it.', 'Okay, noted for later.'],
};
const FILLER_TEXTS = Object.values(FILLER).flat().map(t => t.replace('{t}', ' '));

const tokenCache = new Map<string, number>();
function countTokens(text: string): number {
  let n = tokenCache.get(text);
  if (n === undefined) { n = encodingCount('cl100k_base', text); tokenCache.set(text, n); }
  return n;
}

/**
 * A deterministic session written from templates: an opener about the session's topic, each planned line in its own
 * user turn with an acknowledgement, and filler turns until the session reaches its token target. A planned line
 * marked middle lands in the middle half of the session's turns. For keyless fixtures and tests only.
 */
export function renderTemplateSession(plan: WorldPlan, s: SessionPlan, targetTokens: number): Turn[] {
  const rng = new Rng(seedNumber(`${plan.id}/${s.id}/template`));
  const say = (k: keyof typeof FILLER) => rng.pick(FILLER[k]).replace('{t}', s.topic);
  const pair = (user: string, assistant: string): Turn[] => [{ speaker: 'user', content: user }, { speaker: 'assistant', content: assistant }];
  const linePair = (l: PlannedLine) => pair(`${say('lead')} ${l.text} ${say('user')}`, `${say('ack')} ${say('assistant')}`);
  const filler = () => pair(`${say('user')} ${say('user')} ${say('user')}`, `${say('assistant')} ${say('assistant')} ${say('assistant')}`);
  const opener = pair(`${say('user')} ${say('user')}`, `${say('assistant')} ${say('assistant')}`);
  const body = s.lines.filter(l => l.position !== 'middle').map(linePair);
  const middle = s.lines.filter(l => l.position === 'middle').map(linePair);
  const front: Turn[][] = [], back: Turn[][] = [];
  let tokens = [opener, ...body, ...middle].flat().reduce((n, t) => n + countTokens(t.content) + 4, 0);
  while (tokens < targetTokens || (middle.length && front.length + back.length < 4)) {
    const f = filler();
    tokens += f.reduce((n, t) => n + countTokens(t.content) + 4, 0);
    (front.length <= back.length ? front : back).push(f);
  }
  const ordered = [opener, ...front, ...body, ...back];
  ordered.splice(Math.floor(ordered.length / 2), 0, ...middle);
  return ordered.flat();
}

/** Each session's token target: an equal share of the world target, triple for a long session, with seeded jitter. */
export function sessionTargets(plan: WorldPlan, worldTokens: number): number[] {
  const rng = new Rng(seedNumber(`${plan.id}/targets`));
  const weights = plan.sessions.map(s => (s.long ? 3 : 0.7 + 0.6 * rng.float()));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map(w => Math.round((worldTokens * w) / sum));
}

/** The whole world from templates: BG1_FIXTURE_TOKENS for the committed fixtures, BG1_TARGET_TOKENS for a full-size one. */
export function renderTemplateWorld(plan: WorldPlan, worldTokens = BG1_FIXTURE_TOKENS): World {
  const targets = sessionTargets(plan, worldTokens);
  return {
    schema: BG1_WORLD_SCHEMA, id: plan.id, ...(plan.custody ? { custody: plan.custody } : {}), world_end_weekday: plan.world_end_weekday, renderer: 'template',
    sessions: plan.sessions.map((s, i) => ({ id: s.id, day: s.day, time: s.time, turns: renderTemplateSession(plan, s, targets[i]) })),
  };
}

/** cl100k tokens of a world's turn text. */
export function worldTokens(world: World): number {
  return world.sessions.reduce((n, s) => n + s.turns.reduce((m, t) => m + encodingCount('cl100k_base', t.content), 0), 0);
}

// ─── render briefs ───────────────────────────────────────────────────

export interface RenderBrief {
  world: string; session: string; day: number; weekday: string; time: string; topic: string; long: boolean; target_tokens: number;
  lines: Array<{ text: string; speaker: 'user'; position: 'any' | 'middle' }>;
  /** A planned line is on a tracked slot (not only decoys): the second validator reads the session. */
  tracked: boolean;
  /** Date tokens the session may use: its planned lines' tokens and its own date and weekday. */
  allowed_tokens: string[];
  /** Every value, alias and implication in the world; each may appear only inside a planned line. */
  forbidden: string[];
  /** Tracked and decoy entity names: the session states no fact about them beyond its planned lines. */
  entities: string[];
}

export function renderBriefs(plan: WorldPlan, worldTokensTarget = BG1_TARGET_TOKENS): RenderBrief[] {
  const targets = sessionTargets(plan, worldTokensTarget);
  const forbidden = [...new Set(Object.entries(plan.lexicon).flatMap(([v, l]) => termsOf(v, l)))].sort();
  const entities = plan.entities.map(e => e.name).sort();
  return plan.sessions.map((s, i) => ({
    world: plan.id, session: s.id, day: s.day, weekday: weekdayOf(s.day), time: s.time, topic: s.topic, long: s.long, target_tokens: targets[i],
    lines: s.lines.map(l => ({ text: l.text, speaker: l.speaker, position: l.position })),
    tracked: s.lines.some(l => plan.slots.find(x => x.id === l.slot)!.stratum !== 'decoy'),
    allowed_tokens: [...new Set([...s.lines.flatMap(l => [...l.text.matchAll(/\[\[[DW]:-?\d+\]\]/g)].map(m => m[0])), token(s.day), `[[W:${s.day}]]`])].sort(),
    forbidden, entities,
  }));
}

// ─── dev data ────────────────────────────────────────────────────────

const json = (v: unknown) => JSON.stringify(v, null, 1) + '\n';

/** The committed dev files (paths relative to eval/data/changing-facts-v1), generated from the public seeds. */
export function devFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const id of BG1_DEV_CONVERSATIONS) {
    const plan = planWorld(id, BG1_DEV_SEEDS[id], { publicSeed: true });
    const questions = json(buildQuestions(plan));
    files.set(`dev/worlds/${id}/plan.json`, json(plan));
    files.set(`dev/worlds/${id}/questions.json`, questions);
    files.set(`fixtures/worlds/${id}/world.json`, json(renderTemplateWorld(plan)));
    files.set(`fixtures/worlds/${id}/questions.json`, questions);
  }
  return files;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd !== 'write' && cmd !== 'check') { console.error('usage: bun eval/generators/changing-facts-gen.ts write|check'); process.exit(2); }
  let differ = 0;
  for (const [rel, text] of devFiles()) {
    const path = join(BG1_DATA_DIR, rel);
    if (cmd === 'write') { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); continue; }
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) { differ++; console.error(`changing-facts-gen: ${rel} differs from a fresh generation`); }
  }
  console.log(`changing-facts-gen ${cmd} worlds=${BG1_DEV_CONVERSATIONS.length} differ=${differ}`);
  process.exit(differ ? 1 : 0);
}
