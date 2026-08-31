/**
 * amara-life-v1 procedural skeleton (Day 2 of BrainBench v1 Complete plan).
 *
 * Produces deterministic fact/reference scaffolding for Amara Okafor's messy
 * week in April 2026:
 *   - 50 emails   (threads across inbox)
 *   - 300 slack   (messages across 4 channels; ~30 threads)
 *   - 20 calendar (VEVENT-shaped)
 *   -  8 meetings (transcripts)
 *   - 40 notes    (first-person journal)
 *
 * This file emits STRUCTURED FACTS ONLY — no prose. Day 3 feeds this
 * skeleton to Opus (via amara-life-gen.ts) which expands each item with
 * natural-language body/transcript/note text.
 *
 * Perturbations (the messy-synthetic-life thesis) are planted at
 * deterministic positions so the gold files can reference them by fixture_id:
 *   - 10 contradictions (PAIRED: a primary + a counterpart item state the
 *     same fact two ways in two sources — 20 planted items)
 *   -  5 stale facts    (PAIRED: primary true at date A, counterpart
 *     supersedes at a later date B — 10 planted items)
 *   -  5 poison items   (adversarial prompt injection; single-item fixtures)
 *   -  3 implicit preferences (>=3 evidence items each; inferable from
 *     patterns, never stated — 9 planted items)
 *
 * Slug convention (matches eval/runner/queries/validator.ts:131 regex):
 *   emails/em-NNNN, slack/sl-NNNN, cal/evt-NNNN, meeting/mtg-NNNN,
 *   doc/<name>, note/<date>-<topic>
 *
 * Determinism: seeded LCG (Lehmer / MINSTD). Same `seed` → byte-identical
 * output. Regeneration is free; no LLM calls in this file.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type PerturbationKind =
  | 'contradiction'
  | 'stale-fact'
  | 'poison'
  | 'implicit-preference';

export type PerturbationRole = 'primary' | 'counterpart' | 'evidence';

/**
 * Machine-readable fact pair for contradiction/stale-fact fixtures. Both the
 * primary and counterpart item carry the SAME pair, so the prose generator can
 * render genuinely conflicting values and gold files can score against them.
 * For stale facts, primary_value is the older (superseded) fact and
 * counterpart_value the newer superseding one.
 */
export interface FactPair {
  fact_key: string;
  primary_value: string;
  counterpart_value: string;
}

export interface Perturbation {
  kind: PerturbationKind;
  fixture_id: string;
  /** primary/counterpart for paired fixtures; evidence for implicit prefs. Absent for poison. */
  role?: PerturbationRole;
  /** Present on contradiction + stale-fact items (both sides). */
  fact?: FactPair;
  /** Present on implicit-preference evidence items: renderer instruction. */
  evidence_hint?: string;
}

export interface AmaraContact {
  /** World-v1 slug for the entity (e.g. 'people/mina-kapoor-47'). */
  worldSlug: string;
  name: string;
  email: string;
  slackHandle: string;
  relation: 'cofounder' | 'investor' | 'advisor' | 'peer' | 'mentor' | 'founder';
}

export interface EmailSkeleton {
  slug: string;        // emails/em-0001
  id: string;          // em-0001
  ts: string;          // ISO 8601
  from: { name: string; email: string };
  to: Array<{ name: string; email: string }>;
  subject: string;
  thread_id: string;
  in_reply_to: string | null;
  perturbation?: Perturbation;
}

export interface SlackSkeleton {
  slug: string;        // slack/sl-0001
  id: string;          // sl-0001
  ts: string;
  channel: string;     // '#halfway-partners' etc.
  user: { name: string; handle: string };
  thread_ts: string | null;
  mentions: string[];  // worldSlugs the message references (drives auto-linking)
  perturbation?: Perturbation;
}

export interface CalendarSkeleton {
  slug: string;        // cal/evt-0001
  uid: string;
  dtstart: string;     // ISO
  dtend: string;
  summary: string;
  attendees: Array<{ name: string; email: string }>;
  location?: string;
}

export interface MeetingSkeleton {
  slug: string;        // meeting/mtg-0001
  id: string;
  date: string;        // YYYY-MM-DD
  attendees: string[]; // world slugs
  source: 'circleback' | 'granola' | 'manual';
  linked_calendar?: string; // cal/evt-NNNN
  perturbation?: Perturbation;
}

export interface NoteSkeleton {
  slug: string;        // note/2026-03-14-orange-mode
  id: string;
  date: string;
  topic_hint: string;  // short phrase; Day 3 expands to full prose
  mentions: string[];  // world slugs + amara-life slugs
  perturbation?: Perturbation;
}

export interface AmaraLifeSkeleton {
  version: 1;
  schema_version: 1;
  generated_at: string;
  seed: number;
  profile: {
    slug: 'user/amara-okafor';
    name: 'Amara Okafor';
    role: 'Partner';
    firm: 'Halfway Capital';
    role_detail: string;
    // Implicit preferences (never stated in body text; inferable from patterns).
    implicit_preferences: Array<{
      fixture_id: string;
      label: string;
      surface_hint: string;
    }>;
  };
  contacts: AmaraContact[];
  emails: EmailSkeleton[];
  slack: SlackSkeleton[];
  calendar: CalendarSkeleton[];
  meetings: MeetingSkeleton[];
  notes: NoteSkeleton[];
}

// ─── Seeded PRNG (Mulberry32) ────────────────────────────────────────

// Chose Mulberry32 over Lehmer MINSTD: JS `%` on 32-bit products goes
// negative, and Lehmer needs Schrage's method or BigInt to stay in range.
// Mulberry32 is single-Math.imul-per-step, no overflow, seeds cleanly.
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, xs: T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

// ─── Contact network ──────────────────────────────────────────────────

/**
 * Default contact network used when `buildSkeleton` is called without an
 * explicit contacts[] (e.g., tests). Day 3's amara-life-gen.ts replaces this
 * with contacts resolved from eval/data/world-v1/ entities.
 */
export const DEFAULT_CONTACTS: AmaraContact[] = [
  // 1 cofounder
  { worldSlug: 'people/mina-kapoor',      name: 'Mina Kapoor',      email: 'mina@threshold-ventures.com', slackHandle: 'mina',    relation: 'cofounder' },
  // 2 investors
  { worldSlug: 'people/priya-patel',      name: 'Priya Patel',      email: 'priya@sequoia.com',            slackHandle: 'priya',   relation: 'investor' },
  { worldSlug: 'people/marcus-reid',      name: 'Marcus Reid',      email: 'mreid@a16z.com',               slackHandle: 'marcus',  relation: 'investor' },
  // 3 advisors
  { worldSlug: 'people/sarah-chen',       name: 'Sarah Chen',       email: 'sarah@chen.dev',               slackHandle: 'sarah',   relation: 'advisor' },
  { worldSlug: 'people/jordan-park',      name: 'Jordan Park',      email: 'jordan@novamind.ai',           slackHandle: 'jordan',  relation: 'founder' },
  { worldSlug: 'people/hannah-liu',       name: 'Hannah Liu',       email: 'hannah@datastream.io',         slackHandle: 'hannah',  relation: 'advisor' },
  // 6 peers
  { worldSlug: 'people/diego-alvarez',    name: 'Diego Alvarez',    email: 'diego@tartan.vc',              slackHandle: 'diego',   relation: 'peer' },
  { worldSlug: 'people/elena-rossi',      name: 'Elena Rossi',      email: 'elena@crossbeam.capital',      slackHandle: 'elena',   relation: 'peer' },
  { worldSlug: 'people/kofi-mensah',      name: 'Kofi Mensah',      email: 'kofi@beacon.vc',               slackHandle: 'kofi',    relation: 'peer' },
  { worldSlug: 'people/ravi-gupta',       name: 'Ravi Gupta',       email: 'ravi@founders-fund.com',       slackHandle: 'ravi',    relation: 'peer' },
  { worldSlug: 'people/lena-park',        name: 'Lena Park',        email: 'lena@initialized.com',         slackHandle: 'lena',    relation: 'peer' },
  { worldSlug: 'people/tomoko-sato',      name: 'Tomoko Sato',      email: 'tomoko@khosla.com',            slackHandle: 'tomoko',  relation: 'peer' },
  // 3 mentors
  { worldSlug: 'people/bill-hart',        name: 'Bill Hart',        email: 'bill@hart-ventures.com',       slackHandle: 'bill',    relation: 'mentor' },
  { worldSlug: 'people/nadia-freeman',    name: 'Nadia Freeman',    email: 'nadia@unionsq.vc',             slackHandle: 'nadia',   relation: 'mentor' },
  { worldSlug: 'people/anna-petrov',      name: 'Anna Petrov',      email: 'anna@petrov-capital.com',      slackHandle: 'anna',    relation: 'mentor' },
];

// ─── Fixed perturbation positions ────────────────────────────────────

export type FixtureSource = 'email' | 'slack' | 'meeting' | 'note';

/**
 * A paired fixture plants the SAME fact on TWO items: a primary and a
 * counterpart (different source type where feasible: email↔note,
 * meeting↔note), so contradiction/stale-fact evals actually have both sides
 * in the corpus. Positions are fixed so gold files are reproducible.
 * Primary positions match the original v1 plants (emails 4/11/19,
 * meetings 1/2/5/6, notes 8/17/31 for contradictions; emails 7/22 +
 * notes 5/19/35 for stale facts); counterparts occupy previously-clean items.
 */
export interface PairedFixture {
  fixture_id: string;
  kind: 'contradiction' | 'stale-fact';
  fact: FactPair;
  primary: { source: FixtureSource; index: number };
  counterpart: { source: FixtureSource; index: number };
  /** Which side the scorer trusts (gold `canonical`). */
  canonical: 'primary' | 'counterpart';
  reason: string;
}

export const CONTRADICTION_FIXTURES: PairedFixture[] = [
  { fixture_id: 'c-001', kind: 'contradiction',
    fact: { fact_key: 'meridian-solar-series-a-size', primary_value: '$12M', counterpart_value: '$18M' },
    primary: { source: 'email', index: 4 }, counterpart: { source: 'note', index: 2 },
    canonical: 'primary', reason: 'email is the later source and quotes the term sheet directly' },
  { fixture_id: 'c-002', kind: 'contradiction',
    fact: { fact_key: 'datastream-headcount', primary_value: '45 people', counterpart_value: '60 people' },
    primary: { source: 'email', index: 11 }, counterpart: { source: 'note', index: 4 },
    canonical: 'primary', reason: 'email is the later source, direct from the company' },
  { fixture_id: 'c-003', kind: 'contradiction',
    fact: { fact_key: 'voltaic-grid-lead-investor', primary_value: 'Sequoia is leading', counterpart_value: 'a16z is leading' },
    primary: { source: 'email', index: 19 }, counterpart: { source: 'note', index: 7 },
    canonical: 'primary', reason: 'email is the later source; the note predates the round coming together' },
  { fixture_id: 'c-004', kind: 'contradiction',
    fact: { fact_key: 'jordan-park-equity-stake', primary_value: '17%', counterpart_value: '15%' },
    primary: { source: 'meeting', index: 1 }, counterpart: { source: 'note', index: 10 },
    canonical: 'primary', reason: 'meeting notes are later and agree with doc/novamind-investor-update (17% post-pool)' },
  { fixture_id: 'c-005', kind: 'contradiction',
    fact: { fact_key: 'threshold-series-b-target', primary_value: '$18M', counterpart_value: '$25M' },
    primary: { source: 'meeting', index: 2 }, counterpart: { source: 'note', index: 13 },
    canonical: 'primary', reason: 'meeting is later and agrees with doc/deal-memo-threshold ($18M target)' },
  { fixture_id: 'c-006', kind: 'contradiction',
    fact: { fact_key: 'carbonloop-burn-multiple', primary_value: '1.8', counterpart_value: '2.4' },
    primary: { source: 'meeting', index: 5 }, counterpart: { source: 'note', index: 16 },
    canonical: 'primary', reason: 'meeting transcript is later and cites the data room' },
  { fixture_id: 'c-007', kind: 'contradiction',
    fact: { fact_key: 'helios-board-seat', primary_value: 'Amara takes the Helios board seat', counterpart_value: 'Mina takes the Helios board seat' },
    primary: { source: 'meeting', index: 6 }, counterpart: { source: 'note', index: 22 },
    canonical: 'primary', reason: 'meeting is later; the note reflects an earlier tentative plan' },
  { fixture_id: 'c-008', kind: 'contradiction',
    fact: { fact_key: 'novamind-runway-months', primary_value: '22 months', counterpart_value: '14 months' },
    primary: { source: 'note', index: 8 }, counterpart: { source: 'email', index: 6 },
    canonical: 'primary', reason: 'the note agrees with doc/novamind-investor-update (runway ~22 months)' },
  { fixture_id: 'c-009', kind: 'contradiction',
    fact: { fact_key: 'sunfield-valuation-cap', primary_value: '$30M cap', counterpart_value: '$45M cap' },
    primary: { source: 'note', index: 17 }, counterpart: { source: 'email', index: 14 },
    canonical: 'counterpart', reason: 'email is the later source and quotes the signed SAFE' },
  { fixture_id: 'c-010', kind: 'contradiction',
    fact: { fact_key: 'tidewater-pilot-customers', primary_value: '3 pilot customers', counterpart_value: '7 pilot customers' },
    primary: { source: 'note', index: 31 }, counterpart: { source: 'email', index: 21 },
    canonical: 'counterpart', reason: 'email is months later; pilots were added since the note' },
];

// Stale facts: primary asserts the OLDER fact as current truth; the
// counterpart is the NEWER superseding fact and always has a later timestamp
// (notes run backwards from week start; emails run forward through the week).
export const STALE_FACT_FIXTURES: PairedFixture[] = [
  { fixture_id: 's-001', kind: 'stale-fact',
    fact: { fact_key: 'datastream-cfo-status', primary_value: 'still searching for a CFO', counterpart_value: 'CFO hired and started this week' },
    primary: { source: 'email', index: 7 }, counterpart: { source: 'email', index: 31 },
    canonical: 'counterpart', reason: 'later email supersedes: the CFO search closed' },
  { fixture_id: 's-002', kind: 'stale-fact',
    fact: { fact_key: 'threshold-series-b-close', primary_value: 'close expected in 6 weeks', counterpart_value: 'close pushed to Q3 2026' },
    primary: { source: 'email', index: 22 }, counterpart: { source: 'email', index: 40 },
    canonical: 'counterpart', reason: 'later email supersedes: timeline slipped' },
  { fixture_id: 's-003', kind: 'stale-fact',
    fact: { fact_key: 'meridian-solar-pilot', primary_value: 'pilot contract still unsigned', counterpart_value: 'pilot contract signed' },
    primary: { source: 'note', index: 5 }, counterpart: { source: 'email', index: 9 },
    canonical: 'counterpart', reason: 'later email supersedes: the pilot closed after the note' },
  { fixture_id: 's-004', kind: 'stale-fact',
    fact: { fact_key: 'halfway-fund-iii', primary_value: 'Fund III first close not yet scheduled', counterpart_value: 'Fund III first close completed at $60M' },
    primary: { source: 'note', index: 19 }, counterpart: { source: 'email', index: 26 },
    canonical: 'counterpart', reason: 'later email supersedes: first close happened' },
  { fixture_id: 's-005', kind: 'stale-fact',
    fact: { fact_key: 'novamind-vp-eng', primary_value: 'NovaMind still has no VP of Engineering', counterpart_value: 'NovaMind VP of Engineering started in April' },
    primary: { source: 'note', index: 35 }, counterpart: { source: 'email', index: 35 },
    canonical: 'counterpart', reason: 'later email supersedes: the role was filled' },
];

/**
 * Implicit preferences get >=3 evidence items each. The evidence_hint tells
 * the prose renderer to SURFACE the behavior without ever stating the
 * preference directly (that is the whole point of the fixture).
 */
export interface PrefEvidencePlacement {
  fixture_id: string;
  items: Array<{ source: FixtureSource; index: number }>;
  evidence_hint: string;
}

export const IMPLICIT_PREF_PLACEMENTS: PrefEvidencePlacement[] = [
  { fixture_id: 'pref-001',
    items: [
      { source: 'email', index: 13 },
      { source: 'slack', index: 45 },
      { source: 'note', index: 11 },
    ],
    evidence_hint:
      'Show, in passing, that a 7:00-8:00am meeting slot got moved to 10:00am or later at Amara\'s ' +
      'request. No reason is given and no complaint is voiced. NEVER state or imply the preference ' +
      'directly (no "not a morning person", no "hates early meetings").' },
  { fixture_id: 'pref-002',
    items: [
      { source: 'slack', index: 90 },
      { source: 'slack', index: 132 },
      { source: 'note', index: 23 },
    ],
    evidence_hint:
      'Amara reacts to a founder who closed a Series B less than 10 months after their Series A. ' +
      'Her questions and tone are noticeably skeptical (burn discipline, why raise again so soon, ' +
      'what changed), but she NEVER states a general rule about founders who raise too fast.' },
  { fixture_id: 'pref-003',
    items: [
      { source: 'meeting', index: 3 },
      { source: 'note', index: 25 },
      { source: 'note', index: 29 },
    ],
    evidence_hint:
      'On a climate deal, Amara digs materially deeper than she does elsewhere: unit economics, ' +
      'LCOE, offtake contracts, capacity factors — at least two extra diligence questions. ' +
      'Do NOT state that she prefers climate deals; the depth of questioning is the only signal.' },
];

// Poison items stay single-item fixtures (the injection has no counterpart).
const POISON_EMAIL_INDICES = [29, 33, 44];           // 3
const POISON_SLACK_INDICES = [178, 245];             // 2; total 5

/** Map `${source}:${index}` → perturbation object, built from the fixture tables. */
function buildPerturbationMap(): Map<string, Perturbation> {
  const map = new Map<string, Perturbation>();
  const put = (key: string, p: Perturbation) => {
    if (map.has(key)) {
      throw new Error(`fixture placement collision at ${key} (${map.get(key)!.fixture_id} vs ${p.fixture_id})`);
    }
    map.set(key, p);
  };
  for (const f of [...CONTRADICTION_FIXTURES, ...STALE_FACT_FIXTURES]) {
    put(`${f.primary.source}:${f.primary.index}`,
        { kind: f.kind, fixture_id: f.fixture_id, role: 'primary', fact: f.fact });
    put(`${f.counterpart.source}:${f.counterpart.index}`,
        { kind: f.kind, fixture_id: f.fixture_id, role: 'counterpart', fact: f.fact });
  }
  for (const pref of IMPLICIT_PREF_PLACEMENTS) {
    for (const it of pref.items) {
      put(`${it.source}:${it.index}`,
          { kind: 'implicit-preference', fixture_id: pref.fixture_id, role: 'evidence', evidence_hint: pref.evidence_hint });
    }
  }
  for (let i = 0; i < POISON_EMAIL_INDICES.length; i++) {
    put(`email:${POISON_EMAIL_INDICES[i]}`, { kind: 'poison', fixture_id: `poison-${pad(i + 1, 3)}` });
  }
  for (let i = 0; i < POISON_SLACK_INDICES.length; i++) {
    put(`slack:${POISON_SLACK_INDICES[i]}`, { kind: 'poison', fixture_id: `poison-${pad(i + 4, 3)}` });
  }
  return map;
}

// ─── Skeleton builder ────────────────────────────────────────────────

export interface BuildSkeletonOpts {
  seed?: number;
  contacts?: AmaraContact[];
  /** Fixed week-start date. Week runs Mon 2026-04-13 through Sun 2026-04-19. */
  weekStartIso?: string;
}

export function buildSkeleton(opts: BuildSkeletonOpts = {}): AmaraLifeSkeleton {
  const seed = opts.seed ?? 42;
  const contacts = opts.contacts ?? DEFAULT_CONTACTS;
  const weekStart = new Date(opts.weekStartIso ?? '2026-04-13T09:00:00-07:00');
  const rng = createRng(seed);

  if (contacts.length < 8) {
    throw new Error(`amara-life skeleton needs ≥8 contacts; got ${contacts.length}`);
  }

  // ── Profile + implicit preferences ──
  const profile = {
    slug: 'user/amara-okafor' as const,
    name: 'Amara Okafor' as const,
    role: 'Partner' as const,
    firm: 'Halfway Capital' as const,
    role_detail: 'Seed/Series A, focus on climate + AI infra',
    implicit_preferences: [
      {
        fixture_id: 'pref-001',
        label: 'hates-morning-meetings',
        surface_hint: 'Amara reschedules 7-8am slots to 10am+ in 3+ sources; never states it directly',
      },
      {
        fixture_id: 'pref-002',
        label: 'distrusts-founders-raising-too-fast',
        surface_hint: 'Skeptical commentary on 3 founders who raised Series B within 10 months of Series A',
      },
      {
        fixture_id: 'pref-003',
        label: 'strong-preference-climate-deals',
        surface_hint: 'Asks deeper due-diligence questions on climate deals than on other categories',
      },
    ],
  };

  const amaraSelf = { name: 'Amara Okafor', email: 'amara@halfway.vc' };
  const perturbationAt = buildPerturbationMap();

  // ── Emails ──
  const emails: EmailSkeleton[] = [];
  let prevCounterparty = contacts[0];
  for (let i = 0; i < 50; i++) {
    // Always draw (keeps the seeded rng stream stable for downstream items),
    // but replies (odd i) reuse the thread parent's counterparty so a thread
    // holds its participants — and therefore its subject — constant.
    const drawn = pick(rng, contacts);
    const counterparty = i % 2 === 1 ? prevCounterparty : drawn;
    prevCounterparty = counterparty;
    const ts = new Date(weekStart.getTime() + i * 3.5 * 3600 * 1000); // spread ~3.5h apart
    const isIncoming = rng() < 0.55;
    const id = `em-${pad(i, 4)}`;
    const thread_id = `thr-${pad(Math.floor(i / 2), 4)}`;
    const in_reply_to = i > 0 && i % 2 === 1 ? `em-${pad(i - 1, 4)}` : null;

    emails.push({
      slug: `emails/${id}`,
      id,
      ts: ts.toISOString(),
      from: isIncoming ? { name: counterparty.name, email: counterparty.email } : amaraSelf,
      to: isIncoming ? [amaraSelf] : [{ name: counterparty.name, email: counterparty.email }],
      subject: `Thread ${thread_id} re ${counterparty.name.split(' ')[0]}`,
      thread_id,
      in_reply_to,
      perturbation: perturbationAt.get(`email:${i}`),
    });
  }

  // ── Slack (300 messages across 4 channels, thread-grouped) ──
  const channels = ['#halfway-partners', '#deal-flow', '#ops', '#random'];
  const slack: SlackSkeleton[] = [];
  for (let i = 0; i < 300; i++) {
    const channel = channels[i % channels.length];
    const user = i % 3 === 0
      ? { name: 'Amara Okafor', handle: 'amara' }
      : (() => {
          const c = pick(rng, contacts);
          return { name: c.name, handle: c.slackHandle };
        })();
    const ts = new Date(weekStart.getTime() + i * 20 * 60 * 1000).toISOString();
    const thread_ts = i % 10 === 0 ? null : new Date(weekStart.getTime() + Math.floor(i / 10) * 200 * 60 * 1000).toISOString();

    const mentionsCount = rng() < 0.3 ? 1 : 0;
    const mentions = mentionsCount > 0 ? [pick(rng, contacts).worldSlug] : [];

    slack.push({
      slug: `slack/sl-${pad(i, 4)}`,
      id: `sl-${pad(i, 4)}`,
      ts,
      channel,
      user,
      thread_ts,
      mentions,
      perturbation: perturbationAt.get(`slack:${i}`),
    });
  }

  // ── Calendar (20 events across the week) ──
  const calendar: CalendarSkeleton[] = [];
  for (let i = 0; i < 20; i++) {
    const c = pick(rng, contacts);
    const dayOffset = Math.floor(i / 4);
    const hourOffset = 9 + (i % 4) * 2;
    const dtstart = new Date(weekStart.getTime() + dayOffset * 86400000 + hourOffset * 3600000);
    const dtend = new Date(dtstart.getTime() + 30 * 60 * 1000);
    calendar.push({
      slug: `cal/evt-${pad(i, 4)}`,
      uid: `evt-${pad(i, 4)}@halfway.vc`,
      dtstart: dtstart.toISOString(),
      dtend: dtend.toISOString(),
      summary: `${c.name.split(' ')[0]} sync`,
      attendees: [amaraSelf, { name: c.name, email: c.email }],
      location: rng() < 0.3 ? 'Halfway HQ' : undefined,
    });
  }

  // ── Meetings (8 transcripts, linked to same-day calendar events) ──
  const meetings: MeetingSkeleton[] = [];
  const meetingsPerDay = new Map<number, number>();
  for (let i = 0; i < 8; i++) {
    // Draw to keep the seeded rng stream stable; the actual counterparty is
    // derived from the linked calendar event so date + attendees agree.
    const drawn = pick(rng, contacts);
    const dayIdx = Math.floor(i * 0.875);
    const slot = meetingsPerDay.get(dayIdx) ?? 0;
    meetingsPerDay.set(dayIdx, slot + 1);
    // Calendar packs 4 events per day (Mon-Fri, days 0..4): events
    // dayIdx*4 .. dayIdx*4+3. At most 2 meetings land on one day, so the slot
    // resolves to a real event on weekdays; weekend meetings (days 5-6) have
    // no calendar events and stay unlinked rather than linking a wrong-day one.
    const evt = dayIdx <= 4 ? calendar[dayIdx * 4 + slot] : undefined;
    const evtCounterparty = evt?.attendees.find(a => a.email !== amaraSelf.email);
    const c = (evtCounterparty && contacts.find(ct => ct.email === evtCounterparty.email)) ?? drawn;
    // Meeting date comes FROM the linked event so the two can never disagree
    // (events late in the day cross the UTC date line relative to weekStart).
    const date = evt
      ? evt.dtstart.slice(0, 10)
      : new Date(weekStart.getTime() + dayIdx * 86400000).toISOString().slice(0, 10);
    const id = `mtg-${pad(i, 4)}`;

    meetings.push({
      slug: `meeting/${id}`,
      id,
      date,
      attendees: ['user/amara-okafor', c.worldSlug],
      source: i % 2 === 0 ? 'circleback' : 'granola',
      linked_calendar: evt?.slug,
      perturbation: perturbationAt.get(`meeting:${i}`),
    });
  }

  // ── Notes (40 first-person entries) ──
  const notes: NoteSkeleton[] = [];
  const topicHints = [
    'orange-mode', 'climate-thesis', 'novamind-followup', 'next-quarter-plan',
    'jordan-diligence', 'market-report-reactions', 'threshold-terms', 'sourcing-queue',
    'board-prep', 'team-1-1s', 'morning-reflection', 'weekly-review',
  ];
  for (let i = 0; i < 40; i++) {
    const date = new Date(weekStart.getTime() - i * 86400000 * 2); // backwards in time, ~80 days
    const topic = topicHints[i % topicHints.length];
    const mentions = i % 3 === 0 ? [pick(rng, contacts).worldSlug] : [];

    notes.push({
      slug: `note/${date.toISOString().slice(0, 10)}-${topic}`,
      id: `note-${pad(i, 4)}`,
      date: date.toISOString().slice(0, 10),
      topic_hint: topic,
      mentions,
      perturbation: perturbationAt.get(`note:${i}`),
    });
  }

  return {
    version: 1,
    schema_version: 1,
    generated_at: new Date('2026-04-19T00:00:00Z').toISOString(),
    seed,
    profile,
    contacts,
    emails,
    slack,
    calendar,
    meetings,
    notes,
  };
}

// ─── Perturbation summary ────────────────────────────────────────────

export interface PerturbationCounts {
  /** Distinct fixture_ids per kind (a contradiction pair counts once). */
  fixtures: Record<PerturbationKind, number>;
  /** Planted corpus items per kind (a contradiction pair counts twice). */
  items: Record<PerturbationKind, number>;
}

export function countPerturbations(
  skeleton: AmaraLifeSkeleton,
): PerturbationCounts {
  const zero = (): Record<PerturbationKind, number> => ({
    'contradiction': 0,
    'stale-fact': 0,
    'poison': 0,
    'implicit-preference': 0,
  });
  const items = zero();
  const fixtureKind = new Map<string, PerturbationKind>();
  const walk = (xs: Array<{ perturbation?: Perturbation }>) => {
    for (const it of xs) {
      if (!it.perturbation) continue;
      items[it.perturbation.kind]++;
      fixtureKind.set(it.perturbation.fixture_id, it.perturbation.kind);
    }
  };
  walk(skeleton.emails);
  walk(skeleton.slack);
  walk(skeleton.meetings);
  walk(skeleton.notes);
  const fixtures = zero();
  for (const kind of fixtureKind.values()) fixtures[kind]++;
  return { fixtures, items };
}

// ─── Gold fixture derivation ─────────────────────────────────────────

/**
 * Derives the gold files for contradiction/stale-fact pairs and implicit
 * preferences directly from the fixture tables + the built skeleton, so the
 * gold can never drift from what is actually planted. amara-life-gen.ts
 * writes these to eval/data/gold/{contradictions,implicit-preferences}.json.
 */
export interface GoldPairEntry {
  id: string;
  fact: string;
  source_a: { ref: string; claim: string };
  source_b: { ref: string; claim: string };
  canonical: 'source_a' | 'source_b';
  reason: string;
  expected_behavior: string;
}

export interface GoldFiles {
  contradictions: {
    version: 1;
    _comment: string;
    pairs: GoldPairEntry[];
    stale_facts: GoldPairEntry[];
  };
  implicitPreferences: {
    version: 1;
    _comment: string;
    preferences: Array<{
      id: string;
      label: string;
      surface_hint: string;
      evidence_pages: string[];
      expected_behavior: string;
    }>;
  };
}

function slugAt(skeleton: AmaraLifeSkeleton, ref: { source: FixtureSource; index: number }): string {
  switch (ref.source) {
    case 'email': return skeleton.emails[ref.index].slug;
    case 'slack': return skeleton.slack[ref.index].slug;
    case 'meeting': return skeleton.meetings[ref.index].slug;
    case 'note': return skeleton.notes[ref.index].slug;
  }
}

export function buildGoldFixtures(skeleton: AmaraLifeSkeleton): GoldFiles {
  const toEntry = (f: PairedFixture, expected_behavior: string): GoldPairEntry => ({
    id: f.fixture_id,
    fact: f.fact.fact_key,
    source_a: { ref: slugAt(skeleton, f.primary), claim: f.fact.primary_value },
    source_b: { ref: slugAt(skeleton, f.counterpart), claim: f.fact.counterpart_value },
    canonical: f.canonical === 'primary' ? 'source_a' : 'source_b',
    reason: f.reason,
    expected_behavior,
  });
  return {
    contradictions: {
      version: 1,
      _comment:
        'Derived from CONTRADICTION_FIXTURES/STALE_FACT_FIXTURES in eval/generators/amara-life.ts ' +
        'by amara-life-gen.ts — do not hand-edit. `pairs` are contradictions (same fact, two values, '
        + 'no ordering); `stale_facts` are supersessions (source_b is later and wins). `canonical` marks '
        + 'the side the scorer trusts.',
      pairs: CONTRADICTION_FIXTURES.map(f => toEntry(f,
        'surface both claims, cite both sources, and prefer the canonical source when asked for the fact')),
      stale_facts: STALE_FACT_FIXTURES.map(f => toEntry(f,
        'prefer the newer fact (source_b) and flag the older one as superseded, not merely conflicting')),
    },
    implicitPreferences: {
      version: 1,
      _comment:
        'Derived from IMPLICIT_PREF_PLACEMENTS in eval/generators/amara-life.ts by amara-life-gen.ts — '
        + 'do not hand-edit. Preferences are never stated in body text; each evidence page surfaces the '
        + 'behavior. Cat 9 measures implicit_preference_recall.',
      preferences: skeleton.profile.implicit_preferences.map(p => {
        const placement = IMPLICIT_PREF_PLACEMENTS.find(pl => pl.fixture_id === p.fixture_id);
        return {
          id: p.fixture_id,
          label: p.label,
          surface_hint: p.surface_hint,
          evidence_pages: (placement?.items ?? []).map(it => slugAt(skeleton, it)),
          expected_behavior:
            'infer the preference from the evidence pages; it is never stated verbatim anywhere in the corpus',
        };
      }),
    },
  };
}

// ─── CLI smoke ────────────────────────────────────────────────────────

if (import.meta.main) {
  const skeleton = buildSkeleton();
  console.log(JSON.stringify({
    counts: {
      emails: skeleton.emails.length,
      slack: skeleton.slack.length,
      calendar: skeleton.calendar.length,
      meetings: skeleton.meetings.length,
      notes: skeleton.notes.length,
      contacts: skeleton.contacts.length,
    },
    perturbations: countPerturbations(skeleton),
    sample_slugs: {
      first_email: skeleton.emails[0].slug,
      first_slack: skeleton.slack[0].slug,
      first_cal: skeleton.calendar[0].slug,
      first_meeting: skeleton.meetings[0].slug,
      first_note: skeleton.notes[0].slug,
    },
  }, null, 2));
}
