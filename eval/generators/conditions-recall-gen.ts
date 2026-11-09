#!/usr/bin/env bun
/**
 * Conditions recall (GBEV-55 G2): a seeded, fictional brain and live-recall
 * question file for measuring recall under the conditions a real brain is in.
 *
 *   bun eval/generators/conditions-recall-gen.ts --out <dir> [--seed N] [--per-type N]
 *     [--unembedded-share 0..1] [--synopsis-off] [--keyword-bound N] [--shell-share 0..1]
 *     [--paraphrases <file.jsonl>]
 *
 * It writes <dir>/pages/**.md, <dir>/questions.jsonl (the schema parseQuestions
 * in eval/runner/live-recall/run.ts reads) and <dir>/manifest.json (seed,
 * knobs, counts, digest). eval/runner/live-recall/synthetic.ts builds the brain.
 *
 * Every question has an exact form and a paraphrase on the same gold, across
 * the five live types. Besides plain tickets, error strings, dated meetings,
 * two-page questions and customer notes, it carries Wintermute's recall
 * templates, all invented:
 *   - codename: a page titled by a codename ("Bluejay") whose text never names
 *     the thing the paraphrase asks about ("the voice app");
 *   - transcript_only: a fact that sits only in a meeting transcript, while the
 *     person's own page (a near miss) does not hold it;
 *   - nickname: notes that say "Tommy" about a person whose page is titled
 *     with the formal name ("Thomas Ferrow"), asked about by the formal name.
 *
 * Knobs (recorded in the manifest and in its digest):
 *   - unembedded_chunk_share: that share of chunks is left with no vector,
 *     chosen by a seeded hash so a larger share contains a smaller one. It
 *     models an embedding backlog; gold chunks are eligible like any other.
 *   - synopsis_vectors_off: gbrain 0.60.557's synopsis vectors are its
 *     contextual retrieval (search.contextual_retrieval: none, title or
 *     per_chunk_synopsis), a <context> prefix embedded with each chunk. The
 *     per-chunk synopsis tier needs a model (a Minion backfill), so an import,
 *     and so a keyless build, gets the title tier, the balanced-mode default.
 *     true sets gbrain's kill switch search.contextual_retrieval_disabled, so
 *     chunks embed with no prefix.
 *   - keyword_candidate_bound: gbrain ranks at most KEYWORD_RANK_CANDIDATES
 *     (50,000) keyword matches on Postgres, a constant with no config key, and
 *     PGLite has no bound. null keeps gbrain's behaviour; a number makes the
 *     synthetic brain rank only that many matching chunks (a seeded sample)
 *     and report keyword_candidates_incomplete, as Postgres does past its bound.
 *   - shell_page_share: that share of non-gold pages is rendered as a login
 *     wall, CSS-only text or a pending-curation stub, keeping its title and
 *     losing its body. Gold pages are never shells: a shell gold page would
 *     make the question unanswerable, which measures the corpus, not recall.
 *
 * Paraphrases: the built-in template paraphrases are a keyless control.
 * Counted runs pass --paraphrases (JSONL {id, paraphrase}, written by
 * eval/runner/live-recall/paraphrase-opus.ts). Either way every paraphrase
 * follows live batch 2's rule: it shares no identifier-like token
 * (identifierTokens in run.ts) with its exact form. A file that breaks the
 * rule, misses a question or names an unknown one is refused by id only.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { identifierTokens, parseQuestions, type Question } from '../runner/live-recall/run.ts';
import { Rng, addDays, fingerprint } from './seeded.ts';

export const SCHEMA = 'conditions-recall/v1';
export const DEFAULT_SEED = 20261109;
export const DEFAULT_PER_TYPE = 20;

export interface ConditionsKnobs {
  unembedded_chunk_share: number;
  synopsis_vectors_off: boolean;
  keyword_candidate_bound: number | null;
  shell_page_share: number;
}

export const DEFAULT_KNOBS: ConditionsKnobs = { unembedded_chunk_share: 0, synopsis_vectors_off: false, keyword_candidate_bound: null, shell_page_share: 0 };

export const TEMPLATES = ['ticket', 'codename', 'error', 'meeting', 'vendor_pair', 'transcript_only', 'customer_note', 'nickname'] as const;
export type Template = (typeof TEMPLATES)[number];
export const SHELL_KINDS = ['login_wall', 'css_only', 'pending_curation'] as const;

export interface Page { slug: string; body: string }
export interface Manifest {
  schema: typeof SCHEMA;
  seed: number;
  per_type: number;
  knobs: ConditionsKnobs;
  counts: { pages: number; gold_pages: number; questions: number; by_type: Record<string, number>; by_template: Record<string, number> };
  shells: { count: number; non_gold_pages: number; by_kind: Record<string, number>; gold_shells: 0 };
  question_templates: Record<string, Template>;
  paraphrase_source: 'template' | 'file';
  paraphrases_sha256: string | null;
  questions_sha256: string;
  digest: string;
}

export class ConditionsRecallError extends Error {
  constructor(message: string) { super(message); this.name = 'ConditionsRecallError'; }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pad = (n: number) => String(n).padStart(2, '0');
const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const FIRST = ['Nadia', 'Ravi', 'Ines', 'Oskar', 'Leona', 'Marek', 'Soren', 'Talia', 'Bram', 'Odile', 'Kenji', 'Femi', 'Lucia', 'Yusuf', 'Greta', 'Anselm', 'Mirela', 'Callum', 'Zofia', 'Imre'];
const LAST = ['Ferrow', 'Quillan', 'Daventry', 'Halloway', 'Penhale', 'Brisco', 'Vantreight', 'Ashdown', 'Kellerby', 'Marchetti', 'Oyelaran', 'Tamsett', 'Ulverton', 'Wexley', 'Yardley', 'Corbel', 'Ingleby', 'Pellow', 'Strand', 'Rusk'];
const NICKNAMES: Array<[string, string]> = [['Thomas', 'Tommy'], ['William', 'Billy'], ['Margaret', 'Peggy'], ['Robert', 'Bobby'], ['Elizabeth', 'Libby'], ['Katherine', 'Kit'], ['Theodore', 'Teddy'], ['Patricia', 'Trish'], ['Daniel', 'Danny'], ['Josephine', 'Josie'], ['Alexander', 'Sandy'], ['Frederick', 'Freddie'], ['Eleanor', 'Nell']];
const TEAMS = ['platform', 'payments', 'field operations', 'growth', 'data', 'support tooling'];
const ROLES = ['staff engineer', 'product manager', 'designer', 'operations lead', 'analyst', 'engineering manager'];
const CITIES = ['Lisbon', 'Tallinn', 'Montreal', 'Osaka', 'Nairobi', 'Valparaiso', 'Krakow', 'Auckland'];

const PROJECTS = ['Quarry', 'Lantern', 'Saffron', 'Basalt', 'Meridian', 'Tinder', 'Cobalt', 'Ferrule', 'Halyard', 'Pewter', 'Trellis', 'Gannet'];
const PURPOSES = [
  { doc: 'collects soil moisture readings from sensors buried along the orchard rows', ask: 'gathering dampness data from the probes in the fruit fields' },
  { doc: 'replaces the paper packing slips with printed shipping labels at the dock', ask: 'swapping handwritten box tags for machine-made ones' },
  { doc: 'moves customer invoices from the old accounting system into the new ledger', ask: 'shifting bills over to the replacement bookkeeping software' },
  { doc: 'adds two-factor sign-in for the partner portal', ask: 'adding a second login check for resellers' },
  { doc: 'cuts the nightly batch import from four hours to under one', ask: 'speeding up the overnight data load' },
  { doc: 'builds a returns flow so shoppers can send items back without calling support', ask: 'letting buyers mail things back on their own' },
  { doc: 'teaches the picker tablets to recognise bruised fruit from a photo', ask: 'spotting damaged produce with a camera' },
  { doc: 'consolidates three regional warehouses into one inventory count', ask: 'merging stock numbers across our storage sites' },
  { doc: 'rewrites the help center search so articles rank by recent tickets', ask: 'making help articles easier to find' },
  { doc: 'archives sensor data older than two years to cold storage', ask: 'moving old telemetry somewhere cheaper' },
  { doc: 'replaces the on-call pager rotation with a shared calendar', ask: 'changing how the emergency duty roster is kept' },
  { doc: 'measures delivery van fuel use per route', ask: 'tracking how much diesel each truck run burns' },
];
const TICKET_EXACT = ['What is {T}?', 'status of {T}', 'Who owns {T}?'];
const TICKET_PARA = ['Which project is {A}?', 'How is the work on {A} going?', 'Who is leading the effort on {A}?'];

const CODENAMES = ['Bluejay', 'Kestrel', 'Marmot', 'Juniper', 'Wren', 'Pika', 'Tamarack', 'Ibis', 'Sorrel', 'Ember', 'Thistle', 'Coyote'];
/** Codename pages: the page text never uses a forbidden word, so only the codename or the meaning connects page and paraphrase. */
export const THINGS = [
  { ask: 'the voice app', doc: 'Spoken-command client for field crews: wake word, microphone capture and speech-to-text on a handheld.', forbidden: ['voice', 'app'] },
  { ask: 'the fraud detector', doc: 'Flags suspicious card payments before they settle and holds them for a person to review.', forbidden: ['fraud', 'detector'] },
  { ask: 'the driver scheduling tool', doc: 'Assigns delivery routes and shift slots to couriers each morning.', forbidden: ['driver', 'scheduling', 'tool'] },
  { ask: 'the warehouse robot map', doc: 'Floor plan with aisle coordinates that the autonomous pickers navigate by.', forbidden: ['warehouse', 'robot', 'map'] },
  { ask: 'the support chatbot', doc: 'Answers shopper questions in a help widget with canned replies and a language model.', forbidden: ['support', 'chatbot'] },
  { ask: 'the onboarding emails', doc: 'A welcome sequence sent to new signups over their first two weeks.', forbidden: ['onboarding', 'emails'] },
  { ask: 'the price calculator', doc: 'Quote builder that totals hourly rates, discounts and tax for a proposal.', forbidden: ['price', 'calculator'] },
  { ask: 'the photo uploader', doc: 'Sends pictures from field phones to storage, shrinking them first.', forbidden: ['photo', 'uploader'] },
  { ask: 'the translation plugin', doc: 'Renders the interface in Spanish, Portuguese and French.', forbidden: ['translation', 'plugin'] },
  { ask: 'the sleep tracker', doc: 'Wristband readings of nightly rest, summarized each morning.', forbidden: ['sleep', 'tracker'] },
  { ask: 'the parking finder', doc: 'Shows open bays near a job site from city sensor feeds.', forbidden: ['parking', 'finder'] },
  { ask: 'the expense scanner', doc: 'Reads receipts from a phone camera and files the amounts against a trip.', forbidden: ['expense', 'scanner'] },
];
const MILESTONES = ['a pilot with two crews', 'a closed beta', 'the security review', 'a field trial'];
const CODENAME_EXACT = ['{C} status', 'Who is working on {C}?'];
const CODENAME_PARA = ['How is {A} coming along?', 'Who is building {A}?'];

const SUBSYSTEMS = [
  { code: 'LEDGER', doc: 'ledger service', ask: 'the bookkeeping system' },
  { code: 'SCHED', doc: 'job scheduler', ask: 'the thing that runs background work' },
  { code: 'UPLOAD', doc: 'upload gateway', ask: 'the file intake service' },
  { code: 'CACHE', doc: 'session cache', ask: 'where logins are kept between requests' },
  { code: 'MAILER', doc: 'outbound mailer', ask: 'the service that sends our email' },
  { code: 'INDEX', doc: 'search indexer', ask: 'the process that makes documents findable' },
  { code: 'WEBHOOK', doc: 'payment webhook receiver', ask: 'the endpoint the card processor calls' },
  { code: 'PRINT', doc: 'label print spooler', ask: 'the dock label printing queue' },
  { code: 'TILES', doc: 'map tile server', ask: 'the service that draws map images' },
  { code: 'FEED', doc: 'camera feed relay', ask: 'the pipe that carries video from the sites' },
];
const FAILURES = [
  { code: 'LOCK_TIMEOUT', detail: 'lock wait exceeded {n}s', doc: 'A long export held the lock, and every write queued behind it timed out.', ask: 'everything stalled waiting for exclusive access' },
  { code: 'QUOTA_EXCEEDED', detail: 'quota of {n} per minute exceeded', doc: 'A retry loop with no backoff used up the per-minute allowance.', ask: 'we ran past our rate allowance' },
  { code: 'CHECKSUM_MISMATCH', detail: 'checksum mismatch on block {n}', doc: 'A half-written file was read back before the write finished.', ask: 'corrupted data was detected on read' },
  { code: 'CONN_REFUSED', detail: 'connection refused on port {n}', doc: 'A config push restarted the process on a new port, and nothing could reach it.', ask: 'nothing could connect after a configuration change' },
  { code: 'CERT_EXPIRED', detail: 'certificate expired {n} days ago', doc: 'The TLS certificate lapsed because its renewal job had been switched off.', ask: 'an expired security certificate broke connections' },
];
const VENDORS = ['Brackenford Hosting', 'Calloway Systems', 'Dunmore Networks', 'Ellery Cloud', 'Fenwick Data', 'Glenrock Compute', 'Harrowgate Labs', 'Kestle Telecom', 'Lowther Storage', 'Marrable Hosting'];
const SLAS = ['99.9% monthly uptime with a 10% credit per missed hour', 'a four-hour response to severe faults', 'a named engineer and a same-day postmortem', '99.95% uptime and a 25% credit after two outages'];

const MEETING_TOPICS = [
  { title: 'Warehouse lease review', ask: 'renting the storage building' },
  { title: 'Courier contract review', ask: 'our parcel delivery agreement' },
  { title: 'Recruiting plan', ask: 'which roles to staff' },
  { title: 'Roadmap review', ask: 'what to build next quarter' },
  { title: 'Account security review', ask: 'protecting logins and data' },
  { title: 'Pilot farms check-in', ask: 'how the trial growers are doing' },
  { title: 'Board prep', ask: 'getting ready for the investor meeting' },
  { title: 'Budget planning', ask: 'how much to spend next half' },
  { title: 'Offsite planning', ask: 'the team trip' },
  { title: 'Weekend coverage', ask: 'who answers help requests on Saturdays and Sundays' },
  { title: 'Data retention review', ask: 'how long we keep old records' },
  { title: 'Vendor consolidation', ask: 'cutting down the number of suppliers' },
];
const DECISIONS = ['approve option {X} with a budget of {n} thousand dollars', 'postpone the decision until the next review and gather two more quotes', 'drop option {X} and keep the current setup for another quarter', 'start a six-week trial of option {X}'];

const TRANSCRIPT_FACTS = [
  { line: "Quick personal update: I'm moving to the {City} office at the start of {Month}.", exact: '{First} moving office {Month}', ask: 'Which city is {Full} relocating to?' },
  { line: "I'll be on parental leave from {Month} for twelve weeks, and {Other} covers my reviews.", exact: '{First} parental leave {Month}', ask: 'When will {Full} be away with a new baby, and who fills in?' },
  { line: 'Starting in {Month} I report to {Other} instead.', exact: '{First} report to {Other} {Month}', ask: 'Who is going to be the new boss of {Full}?' },
  { line: "I'm also helping the {Team} team two days a week until {Month}.", exact: '{First} helping {Team} team two days a week', ask: 'Is {Full} splitting time with another group?' },
];
const SYNC_FILLER = ['The release went out on Tuesday with no rollbacks.', 'We still owe the finance team the quarterly numbers.', 'Two flaky tests were quarantined this week.', 'The design review moved to Thursday afternoon.'];

const CUSTOMERS = [
  { name: 'Calder Ridge Vineyard', kind: 'vineyard' }, { name: 'Moss Hollow Dairy', kind: 'dairy' }, { name: 'Pinecrest Nurseries', kind: 'plant nursery' },
  { name: 'Tidewater Oyster Co-op', kind: 'oyster farm' }, { name: 'Sable Creek Orchards', kind: 'orchard' }, { name: 'Juniper Flats Ranch', kind: 'cattle ranch' },
  { name: 'Ashgrove Apiaries', kind: 'beekeeper' }, { name: 'Redfern Greenhouses', kind: 'greenhouse grower' }, { name: 'Coldwater Hatchery', kind: 'fish hatchery' },
  { name: 'Blackthorn Cider', kind: 'cider maker' }, { name: 'Wychwood Mushrooms', kind: 'mushroom farm' }, { name: 'Fallowmere Grains', kind: 'grain mill' },
];
const COMPLAINTS = [
  { doc: 'the handheld scanners lose their charge before the afternoon shift', ask: 'batteries dying too early on the barcode readers' },
  { doc: 'invoices arrive in English only, and their bookkeeper needs Spanish', ask: 'bills not being in the language their accountant reads' },
  { doc: 'the delivery window is too wide and they want a two-hour slot', ask: 'wanting tighter arrival times for shipments' },
  { doc: 'the mobile dashboard hides frost alerts behind two taps', ask: 'cold-weather warnings being hard to reach on the phone' },
  { doc: 'they were double charged after the plan change in spring', ask: 'being billed twice when they switched subscriptions' },
  { doc: 'sensor readings stop syncing when the barn has no signal', ask: 'data not uploading from buildings without reception' },
];

const NICK_FACTS = [
  { title: 'Equipment check-in', doc: 'the forklift lease renews in {Month} and the rate goes up eight percent', exact: '{Nick} forklift lease renews', ask: 'When does {Formal} expect the lifting-truck rental to come up again?' },
  { title: 'Facilities catch-up', doc: 'the second-floor lease ends in {Month}, so the team moves upstairs', exact: '{Nick} second-floor lease ends', ask: 'What did {Formal} say about our workspace agreement running out?' },
  { title: 'Procurement sync', doc: 'we drop the old courier for overnight parcels after {Month}', exact: '{Nick} drop courier overnight parcels', ask: 'Which shipping change did {Formal} announce?' },
  { title: 'Hiring check-in', doc: 'two shift supervisor roles open in {Month}', exact: '{Nick} shift supervisor roles open', ask: 'How many lead positions is {Formal} planning to recruit?' },
  { title: 'Budget review', doc: 'the travel budget is frozen until {Month}', exact: '{Nick} travel budget frozen', ask: 'Did {Formal} put a hold on trip spending?' },
  { title: 'Safety walkthrough', doc: 'the loading bay needs new guard rails before {Month}', exact: '{Nick} loading bay guard rails', ask: 'What workplace hazard fix did {Formal} raise?' },
  { title: 'Fleet review', doc: 'three of the delivery vans are due for new tyres in {Month}', exact: '{Nick} delivery vans tyres', ask: 'How many trucks did {Formal} say need wheel work?' },
  { title: 'Customer escalations', doc: 'the cider maker escalation is closed and a refund went out in {Month}', exact: '{Nick} cider maker escalation refund', ask: 'Which complaint did {Formal} report as resolved with money back?' },
  { title: 'Tooling sync', doc: 'the build servers move to the new region in {Month}', exact: '{Nick} build servers new region', ask: 'Where are the compile machines going, according to {Formal}?' },
  { title: 'Insurance renewal', doc: 'the liability policy premium rises by a fifth in {Month}', exact: '{Nick} liability policy premium', ask: 'How much more will our coverage cost, per {Formal}?' },
];
const AREAS = ['purchasing', 'facilities', 'the delivery fleet', 'hiring', 'finance operations', 'site safety', 'customer escalations', 'build infrastructure', 'insurance and risk', 'vendor relations'];

const FILLER = ['Shipping went out on time.', 'Two help tickets were escalated and closed.', 'No incidents this week.', 'The new hire finished the security training.', 'Office plants were watered on schedule.', 'The team lunch moved to Friday.'];

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : '{' + k + '}'));
const frontmatter = (fields: Record<string, string>) => '---\n' + Object.entries(fields).map(([k, v]) => k + ': ' + v).join('\n') + '\n---\n\n';
const partOfMonth = (day: number) => (day <= 10 ? 'early' : day <= 20 ? 'mid' : 'late');

export function validateKnobs(knobs: ConditionsKnobs): ConditionsKnobs {
  const share = (v: unknown, name: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new ConditionsRecallError(name + ' must be a number from 0 to 1');
  };
  share(knobs.unembedded_chunk_share, 'unembedded_chunk_share');
  share(knobs.shell_page_share, 'shell_page_share');
  if (typeof knobs.synopsis_vectors_off !== 'boolean') throw new ConditionsRecallError('synopsis_vectors_off must be true or false');
  const bound = knobs.keyword_candidate_bound;
  if (bound !== null && (!Number.isInteger(bound) || bound < 1)) throw new ConditionsRecallError('keyword_candidate_bound must be null or a positive integer');
  return { unembedded_chunk_share: knobs.unembedded_chunk_share, synopsis_vectors_off: knobs.synopsis_vectors_off, keyword_candidate_bound: bound, shell_page_share: knobs.shell_page_share };
}

/** Identity of a generated directory: knobs, every page and the question file. synthetic.ts recomputes it before building. */
export function corpusDigest(knobs: ConditionsKnobs, pages: Page[], questionsText: string): string {
  return fingerprint({ schema: SCHEMA, knobs, pages: [...pages].sort((a, b) => a.slug.localeCompare(b.slug)), questions: questionsText });
}

/** Ids whose paraphrase shares an identifier-like token with the exact form (live batch 2's rule, the same test run.ts reports). */
export function paraphraseRuleBreaks(questions: Array<Pick<Question, 'id' | 'forms'>>): string[] {
  return questions.filter(q => [...identifierTokens(q.forms.exact)].some(t => q.forms.paraphrase.toLowerCase().includes(t))).map(q => q.id);
}

/** Replace every template paraphrase with the file's. Refusals name an id or a line, never paraphrase text. */
export function applyParaphrases(questions: Question[], text: string): Question[] {
  const byId = new Map<string, string>();
  const known = new Set(questions.map(q => q.id));
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let row: any;
    try { row = JSON.parse(line); } catch { throw new ConditionsRecallError('paraphrase file line ' + (i + 1) + ' is not JSON'); }
    if (typeof row?.id !== 'string' || !known.has(row.id)) throw new ConditionsRecallError('paraphrase file line ' + (i + 1) + ' names no generated question');
    if (byId.has(row.id)) throw new ConditionsRecallError('paraphrase file repeats id ' + row.id);
    if (typeof row.paraphrase !== 'string' || !row.paraphrase.trim()) throw new ConditionsRecallError('paraphrase for id ' + row.id + ' is empty');
    byId.set(row.id, row.paraphrase.trim());
  });
  const missing = questions.find(q => !byId.has(q.id));
  if (missing) throw new ConditionsRecallError('paraphrase file has no paraphrase for id ' + missing.id);
  const out = questions.map(q => ({ ...q, forms: { exact: q.forms.exact, paraphrase: byId.get(q.id)! } }));
  const breaks = paraphraseRuleBreaks(out);
  if (breaks.length) throw new ConditionsRecallError('paraphrase for id ' + breaks[0] + ' shares an identifier-like token with its exact form');
  return out;
}

function shellBody(kind: (typeof SHELL_KINDS)[number], title: string, type: string, day: string): string {
  const head = frontmatter({ type, title });
  if (kind === 'login_wall') return head + 'Sign in to continue\n\nYour session has expired. Enter your email and password to view this page.\n\nEmail\n\nPassword\n\nForgot password? · Create an account · Privacy · Terms\n';
  if (kind === 'css_only') return head + '.page{margin:0 auto;max-width:960px}.nav{display:flex;gap:12px}.btn-primary{background:#2457f5;color:#fff;border-radius:6px}@media (max-width:640px){.nav{flex-direction:column}}\n';
  return head + '# ' + title + '\n\nThis page is waiting for curation. It was captured on ' + day + ' and has not been reviewed yet.\n';
}

export interface GenerateOptions { seed?: number; perType?: number; knobs?: Partial<ConditionsKnobs>; paraphrasesText?: string }
export interface Generated { pages: Page[]; questions: Question[]; questionsText: string; manifest: Manifest }

export function generateConditionsRecall(options: GenerateOptions = {}): Generated {
  const seed = options.seed ?? DEFAULT_SEED;
  const perType = options.perType ?? DEFAULT_PER_TYPE;
  const knobs = validateKnobs({ ...DEFAULT_KNOBS, ...options.knobs });
  const half = Math.ceil(perType / 2);
  const maxPerType = 2 * Math.min(PROJECTS.length, CODENAMES.length, THINGS.length, VENDORS.length, CUSTOMERS.length, NICK_FACTS.length, MEETING_TOPICS.length);
  if (!Number.isInteger(seed) || seed < 0) throw new ConditionsRecallError('seed must be a non-negative integer');
  if (!Number.isInteger(perType) || perType < 2 || perType > maxPerType) throw new ConditionsRecallError('per-type must be an integer from 2 to ' + maxPerType);

  const rng = new Rng(seed);
  const pages = new Map<string, { title: string; type: string; day: string; body: string }>();
  const addPage = (slug: string, type: string, title: string, day: string, text: string, extra: Record<string, string> = {}) => {
    if (pages.has(slug)) throw new ConditionsRecallError('duplicate slug ' + slug);
    pages.set(slug, { title, type, day, body: frontmatter({ type, title, ...extra }) + text });
  };
  const people = rng.shuffle(FIRST.flatMap(f => LAST.map(l => f + ' ' + l)));
  const nextPerson = () => people.pop()!;
  const day = () => '2026-' + pad(rng.int(2, 10)) + '-' + pad(rng.int(1, 28));
  const month = () => rng.pick(MONTHS.slice(6));
  const questions: Question[] = [];
  const templates: Record<string, Template> = {};
  const ask = (id: string, type: Question['type'], template: Template, exact: string, paraphrase: string, gold: string[], window?: Question['window']) => {
    questions.push({ id, type, forms: { exact, paraphrase }, gold: gold.map(slug => ({ slug })), gold_found_by: 'page_first', ...(window ? { window } : {}) });
    templates[id] = template;
  };
  const personPage = (full: string, text: string) => {
    const slug = 'people/' + slugify(full);
    addPage(slug, 'person', full, day(), '# ' + full + '\n\n' + text + '\n');
    return slug;
  };

  // identifier: plain tickets, then codename pages.
  const projects = rng.shuffle(PROJECTS), purposes = rng.shuffle(PURPOSES), codenames = rng.shuffle(CODENAMES), things = rng.shuffle(THINGS);
  for (let i = 0; i < perType; i++) {
    const id = 'id-' + (i + 1);
    if (i < half) {
      const name = projects[i], purpose = purposes[i], owner = nextPerson();
      const ticket = name.slice(0, 3).toUpperCase() + '-' + rng.int(100, 9999);
      const ownerSlug = personPage(owner, owner + ' is a ' + rng.pick(ROLES) + ' on the ' + rng.pick(TEAMS) + ' team.');
      const slug = 'projects/' + slugify(name);
      addPage(slug, 'project', name + ' project', day(), '# ' + name + ' project\n\nTracking ticket: ' + ticket + '. Owner: ' + owner + ' ([[' + ownerSlug + ']]).\n\nThe ' + name + ' project ' + purpose.doc + '. Status: on track for ' + month() + '.\n');
      ask(id, 'identifier', 'ticket', fill(TICKET_EXACT[i % TICKET_EXACT.length], { T: ticket }), fill(TICKET_PARA[i % TICKET_PARA.length], { A: purpose.ask }), [slug]);
    } else {
      const j = i - half, codename = codenames[j], thing = things[j];
      const slug = 'projects/' + slugify(codename);
      addPage(slug, 'project', codename, day(), '# ' + codename + '\n\n' + thing.doc + ' Lead: ' + nextPerson() + '. Next milestone: ' + rng.pick(MILESTONES) + ' in ' + month() + '.\n');
      ask(id, 'identifier', 'codename', fill(CODENAME_EXACT[j % CODENAME_EXACT.length], { C: codename }), fill(CODENAME_PARA[j % CODENAME_PARA.length], { A: thing.ask }), [slug]);
    }
  }

  // error_string and the incident half of cross_source draw from one shuffled set of subsystem and failure pairs.
  const combos = rng.shuffle(SUBSYSTEMS.flatMap(sub => FAILURES.map(fail => ({ sub, fail }))));
  const incident = (combo: (typeof combos)[number], vendor?: string) => {
    const date = day();
    const code = 'ERR_' + combo.sub.code + '_' + combo.fail.code + ': ' + fill(combo.fail.detail, { n: rng.int(3, 900) });
    const slug = 'incidents/' + date + '-' + slugify(combo.sub.code) + '-' + slugify(combo.fail.code);
    const title = capitalize(combo.sub.doc) + ' incident';
    const time = pad(rng.int(0, 23)) + ':' + pad(rng.int(0, 59));
    addPage(slug, 'incident', title, date, '# ' + title + ', ' + date + '\n\nAt ' + time + ' the ' + combo.sub.doc + ' started failing with `' + code + '`.\n\n'
      + combo.fail.doc + (vendor ? ' The fault was on the ' + vendor + ' side.' : '') + ' Customer-facing impact lasted about ' + rng.int(5, 90) + ' minutes.\n', { date });
    return { slug, code };
  };
  for (let i = 0; i < perType; i++) {
    const combo = combos[i];
    const { slug, code } = incident(combo);
    ask('err-' + (i + 1), 'error_string', 'error', code, 'the time ' + combo.fail.ask + ' in ' + combo.sub.ask, [slug]);
  }

  // time_window: each topic meets twice, in different months; every fourth question has no window.
  const topics = rng.shuffle(MEETING_TOPICS);
  for (let i = 0; i < perType; i++) {
    const topic = topics[Math.floor(i / 2)];
    const m = 2 + (i % 2) * 4 + rng.int(0, 3);
    const d = rng.int(1, 28);
    const ym = '2026-' + pad(m);
    const date = ym + '-' + pad(d);
    const slug = 'meetings/' + date + '-' + slugify(topic.title);
    const decision = fill(rng.pick(DECISIONS), { X: rng.pick(['A', 'B', 'C']), n: rng.int(5, 400) });
    addPage(slug, 'meeting', topic.title, date, '# ' + topic.title + ', ' + date + '\n\nAttendees: ' + nextPerson() + ', ' + nextPerson() + '.\n\nDecision: ' + decision + '. Follow-up in two weeks.\n', { date });
    const part = partOfMonth(d);
    const lastDay = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    const [since, until] = part === 'early' ? [1, 10] : part === 'mid' ? [11, 20] : [21, lastDay];
    const window = i % 4 === 3 ? undefined : { since: ym + '-' + pad(since), until: ym + '-' + pad(until) };
    ask('time-' + (i + 1), 'time_window', 'meeting', topic.title.toLowerCase() + ' ' + date, 'what did we decide about ' + topic.ask + ' in ' + part + ' ' + MONTHS[m - 1], [slug], window);
  }

  // cross_source: an incident plus its vendor page, then facts that sit only in a transcript.
  const vendors = rng.shuffle(VENDORS);
  for (let i = 0; i < perType; i++) {
    const id = 'cross-' + (i + 1);
    if (i < half) {
      const combo = combos[perType + i], vendor = vendors[i];
      const contract = vendor.slice(0, 3).toUpperCase() + '-' + rng.int(10, 99) + '-' + rng.int(1000, 9999);
      const inc = incident(combo, vendor);
      const vendorSlug = 'vendors/' + slugify(vendor);
      addPage(vendorSlug, 'vendor', vendor, day(), '# ' + vendor + '\n\n' + vendor + ' hosts our ' + combo.sub.doc + '. Contract ' + contract + ' promises ' + rng.pick(SLAS) + '.\n');
      ask(id, 'cross_source', 'vendor_pair', vendor + ' ' + inc.code.split(':')[0] + ' incident and contract ' + contract,
        'Which supplier was behind the time ' + combo.fail.ask + ' in ' + combo.sub.ask + ', and what does our agreement with them promise?', [inc.slug, vendorSlug]);
    } else {
      const j = i - half, fact = TRANSCRIPT_FACTS[j % TRANSCRIPT_FACTS.length];
      const full = nextPerson(), first = full.split(' ')[0], team = rng.pick(TEAMS), other = nextPerson();
      personPage(full, full + ' is a ' + rng.pick(ROLES) + ' on the ' + team + ' team.');
      const date = day();
      const vars = { City: rng.pick(CITIES), Month: month(), Other: other, Team: rng.pick(TEAMS.filter(t => t !== team)), First: first, Full: full };
      const slug = 'meetings/' + date + '-' + slugify(team) + '-sync-' + (j + 1);
      const [a, b] = rng.shuffle(SYNC_FILLER);
      const speaker = nextPerson().split(' ')[0];
      const title = capitalize(team) + ' team sync';
      addPage(slug, 'transcript', title, date, '# ' + title + ', ' + date + '\n\n**' + speaker + ':** ' + a + '\n\n**' + first + ':** ' + fill(fact.line, vars) + '\n\n**' + speaker + ':** ' + b + '\n', { date });
      ask(id, 'cross_source', 'transcript_only', fill(fact.exact, vars), fill(fact.ask, vars), [slug]);
    }
  }

  // topic: customer feedback notes, then notes that use a nickname.
  const customers = rng.shuffle(CUSTOMERS), nicks = rng.shuffle(NICKNAMES), nickFacts = rng.shuffle(NICK_FACTS), lasts = rng.shuffle(LAST);
  for (let i = 0; i < perType; i++) {
    const id = 'topic-' + (i + 1);
    if (i < half) {
      const customer = customers[i], complaint = rng.pick(COMPLAINTS);
      const slug = 'notes/' + slugify(customer.name) + '-feedback';
      addPage(slug, 'note', customer.name + ' feedback', day(), '# ' + customer.name + ' feedback\n\n' + customer.name + ', a fictional ' + customer.kind + ', says ' + complaint.doc + '. They asked for a fix before ' + month() + '.\n');
      ask(id, 'topic', 'customer_note', customer.name + ' feedback', 'what did the ' + customer.kind + ' pilot say about ' + complaint.ask, [slug]);
    } else {
      const j = i - half, [formalFirst, nick] = nicks[j], fact = nickFacts[j];
      const formal = formalFirst + ' ' + lasts[j];
      personPage(formal, formal + ' runs ' + AREAS[j % AREAS.length] + ' for the ' + rng.pick(TEAMS) + ' team.');
      const date = day();
      const slug = 'notes/' + date + '-' + slugify(fact.title);
      addPage(slug, 'note', fact.title, date, '# ' + fact.title + ', ' + date + '\n\n' + nick + ' said ' + fill(fact.doc, { Month: month() }) + '. ' + nextPerson().split(' ')[0] + ' will follow up.\n', { date });
      ask(id, 'topic', 'nickname', fill(fact.exact, { Nick: nick }), fill(fact.ask, { Formal: formal }), [slug]);
    }
  }

  for (let i = 0; i < perType * 2; i++) {
    const date = addDays('2026-02-02', 7 * i);
    addPage('notes/weekly-status-' + date, 'note', 'Weekly status ' + date, date, '# Weekly status, week of ' + date + '\n\n' + rng.shuffle(FILLER).slice(0, 3).join(' ') + '\n', { date });
  }

  const finalQuestions = options.paraphrasesText === undefined ? questions : applyParaphrases(questions, options.paraphrasesText);
  const breaks = paraphraseRuleBreaks(finalQuestions);
  if (breaks.length) throw new ConditionsRecallError('template paraphrase for id ' + breaks[0] + ' shares an identifier-like token with its exact form');

  const gold = new Set(finalQuestions.flatMap(q => q.gold.map(g => g.slug)));
  for (const slug of gold) if (!pages.has(slug)) throw new ConditionsRecallError('gold slug ' + slug + ' has no page');
  const nonGold = [...pages.keys()].filter(s => !gold.has(s)).sort();
  const ranked = nonGold.map(slug => ({ slug, h: sha256(seed + ':shell:' + slug) })).sort((a, b) => a.h.localeCompare(b.h));
  const shellKinds: Record<string, number> = Object.fromEntries(SHELL_KINDS.map(k => [k, 0]));
  for (const { slug, h } of ranked.slice(0, Math.round(knobs.shell_page_share * nonGold.length))) {
    const kind = SHELL_KINDS[parseInt(h.slice(0, 8), 16) % SHELL_KINDS.length];
    const p = pages.get(slug)!;
    p.body = shellBody(kind, p.title, p.type, p.day);
    shellKinds[kind]++;
  }

  const outPages = [...pages.entries()].map(([slug, p]) => ({ slug, body: p.body })).sort((a, b) => a.slug.localeCompare(b.slug));
  const questionsText = finalQuestions.map(q => JSON.stringify(q)).join('\n') + '\n';
  parseQuestions(questionsText);
  const count = (xs: string[]) => xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});
  const manifest: Manifest = {
    schema: SCHEMA,
    seed,
    per_type: perType,
    knobs,
    counts: { pages: outPages.length, gold_pages: gold.size, questions: finalQuestions.length, by_type: count(finalQuestions.map(q => q.type)), by_template: count(Object.values(templates)) },
    shells: { count: Object.values(shellKinds).reduce((a, b) => a + b, 0), non_gold_pages: nonGold.length, by_kind: shellKinds, gold_shells: 0 },
    question_templates: templates,
    paraphrase_source: options.paraphrasesText === undefined ? 'template' : 'file',
    paraphrases_sha256: options.paraphrasesText === undefined ? null : sha256(options.paraphrasesText),
    questions_sha256: sha256(questionsText),
    digest: corpusDigest(knobs, outPages, questionsText),
  };
  return { pages: outPages, questions: finalQuestions, questionsText, manifest };
}

/** Write a generated set into a directory that holds no earlier set. */
export function writeConditionsRecall(dir: string, generated: Generated): void {
  if (existsSync(join(dir, 'pages')) || existsSync(join(dir, 'manifest.json'))) throw new ConditionsRecallError(dir + ' already holds a generated set; choose an empty --out');
  for (const page of generated.pages) {
    const path = join(dir, 'pages', page.slug + '.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, page.body);
  }
  writeFileSync(join(dir, 'questions.jsonl'), generated.questionsText);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(generated.manifest, null, 2) + '\n');
}

function main(argv: string[]): number {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const out = flag('--out');
  if (!out) {
    console.error('usage: bun eval/generators/conditions-recall-gen.ts --out <dir> [--seed N] [--per-type N] [--unembedded-share 0..1] [--synopsis-off] [--keyword-bound N] [--shell-share 0..1] [--paraphrases <file.jsonl>]');
    return 2;
  }
  const num = (name: string) => (flag(name) === undefined ? undefined : Number(flag(name)));
  const paraphrases = flag('--paraphrases');
  try {
    const generated = generateConditionsRecall({
      seed: num('--seed'),
      perType: num('--per-type'),
      knobs: {
        unembedded_chunk_share: num('--unembedded-share') ?? 0,
        synopsis_vectors_off: argv.includes('--synopsis-off'),
        keyword_candidate_bound: num('--keyword-bound') ?? null,
        shell_page_share: num('--shell-share') ?? 0,
      },
      paraphrasesText: paraphrases === undefined ? undefined : readFileSync(paraphrases, 'utf8'),
    });
    writeConditionsRecall(out, generated);
    const m = generated.manifest;
    console.log('conditions-recall: ' + out + ' (' + m.counts.questions + ' questions, ' + m.counts.pages + ' pages, ' + m.shells.count + ' shells, paraphrases ' + m.paraphrase_source + ', digest ' + m.digest.slice(0, 12) + ')');
    return 0;
  } catch (error) {
    if (!(error instanceof ConditionsRecallError)) throw error;
    console.error('conditions-recall: refused: ' + error.message);
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
