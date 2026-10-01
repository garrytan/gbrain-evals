/**
 * N3 temporal and as-of world generator.
 *
 * Emits a LEDGER (the world as generated: people, companies, dated person
 * events with separate valid and recorded dates, meetings with timestamped
 * chronicle events, dated pages with competing date signals, time-zone edge
 * pages and company metric trajectories) and derives every probe's gold from
 * that ledger with independent oracles:
 *
 *   - as-of employer: ForwardJobState (eval/generators/job-state.ts), a
 *     streaming state machine over the person's events in valid-time order;
 *   - recorded-time as-of: the same machine over only the events recorded by
 *     the query date (what the notes said at the time);
 *   - range, day, week, since, on-this-day and last-seen: set arithmetic over
 *     the ledger's timeline rows;
 *   - effective dates: an independent implementation of gbrain's documented
 *     precedence chain (src/core/effective-date.ts header) over the values the
 *     generator wrote;
 *   - time zones: an independent US Eastern offset rule (second Sunday of
 *     March to first Sunday of November, 02:00 local), never Intl.
 *
 * Nothing here reads gbrain output. The runner writes the ledger through
 * gbrain's operation handlers and scores what gbrain returns against this
 * gold. Names are fictional placeholders (alice-example, startup-3).
 *
 * Usage: bun eval/generators/n3-temporal-gen.ts [--seed N] [--json]
 */
import { createHash } from 'node:crypto';
import { EVENT_TYPES, ForwardJobState, JOB_CHANGE_TYPES, type EventType } from './job-state.ts';

export const N3_GENERATOR_VERSION = 'n3-temporal-gen/1';
export const N3_DEFAULT_SEED = 3;
/** brain.timezone and chronicle.tz for the whole world. */
export const WORLD_TZ = 'America/New_York';
export const WORLD_START = '2022-01-10';
export const WORLD_LAST_EVENT = '2025-11-30';

// ─── Deterministic randomness and date arithmetic ────────────────────────

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  readonly #next: () => number;
  constructor(seed: number) { this.#next = mulberry32(seed); }
  float(): number { return this.#next(); }
  int(lo: number, hi: number): number { return lo + Math.floor(this.#next() * (hi - lo + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.#next() * xs.length)]; }
  chance(p: number): boolean { return this.#next() < p; }
  sample<T>(xs: readonly T[], n: number): T[] {
    const pool = [...xs];
    const out: T[] = [];
    while (out.length < n && pool.length > 0) out.push(pool.splice(Math.floor(this.#next() * pool.length), 1)[0]);
    return out;
  }
  letters(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(97 + Math.floor(this.#next() * 26));
    return s;
  }
}

const DAY_MS = 86_400_000;
export function dayMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
export function msDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
export function addDays(day: string, n: number): string { return msDay(dayMs(day) + n * DAY_MS); }
export function daysBetween(from: string, to: string): number { return Math.round((dayMs(to) - dayMs(from)) / DAY_MS); }

/** Monday of the ISO week containing `day` (weeks run Monday to Sunday). */
export function isoWeekStart(day: string): string {
  const dow = new Date(dayMs(day)).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

// ─── Independent US Eastern offset oracle ─────────────────────────────────

/** nth Sunday (1-based) of a month, as a day string. */
function nthSunday(year: number, month: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return msDay(Date.UTC(year, month - 1, 1 + ((7 - first) % 7) + (n - 1) * 7));
}

/**
 * UTC offset in minutes of US Eastern time at a UTC instant, by the post-2007
 * US rule: daylight time from 02:00 EST on the second Sunday of March (07:00
 * UTC) to 02:00 EDT on the first Sunday of November (06:00 UTC).
 */
export function easternOffsetMinutes(utcMs: number): number {
  const year = new Date(utcMs).getUTCFullYear();
  const dstStart = dayMs(nthSunday(year, 3, 2)) + 7 * 3_600_000;
  const dstEnd = dayMs(nthSunday(year, 11, 1)) + 6 * 3_600_000;
  return utcMs >= dstStart && utcMs < dstEnd ? -240 : -300;
}

/**
 * The UTC instant of an Eastern wall-clock time. Only called for wall times
 * that are neither skipped nor repeated (the generator keeps edge times at
 * 19:00 to 23:59 local), so standard and daylight readings never both fit.
 */
export function easternWallToUtcMs(wallDay: string, hh: number, mm: number): number {
  const wall = dayMs(wallDay) + (hh * 60 + mm) * 60_000;
  for (const offset of [-300, -240]) {
    const utc = wall - offset * 60_000;
    if (easternOffsetMinutes(utc) === offset) return utc;
  }
  throw new Error(`easternWallToUtcMs: ${wallDay} ${hh}:${mm} is not a unique Eastern wall time`);
}

function offsetSuffix(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** ISO string with the Eastern offset for a wall time, e.g. 2024-05-01T23:30:00-04:00. */
export function easternIso(wallDay: string, hh: number, mm: number): string {
  const utc = easternWallToUtcMs(wallDay, hh, mm);
  return `${wallDay}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00${offsetSuffix(easternOffsetMinutes(utc))}`;
}

// ─── Ledger types ─────────────────────────────────────────────────────────

export interface LedgerPerson { slug: string; name: string; token: string; role: 'regular' | 'prefix-short' | 'prefix-long' | 'never-seen' }
export interface LedgerCompany { slug: string; id: string; has_trajectory: boolean }

/** One dated thing that happened to a person. `date` is valid (event) time; `recorded_on` is when a note about it was written. */
export interface PersonEvent {
  id: string;
  person: string;
  date: string;
  type: EventType;
  company: string;
  summary: string;
  recorded_on: string;
  late: boolean;
  /** Note page written on `recorded_on`; frontmatter `date: recorded_on`. */
  note_slug: string;
  scenario: 'normal' | 'boomerang-late';
}

export interface ChronicleEvent {
  id: string;
  /** Exactly what the scripted judge returns as `when` (ISO with Eastern offset, or YYYY-MM-DD). */
  when: string;
  local_day: string;
  utc_day: string;
  who: string[];
  what: string;
  kind: string;
  edge: 'none' | 'late-evening' | 'date-only';
}
export interface LedgerMeeting { slug: string; date: string; attendees: string[]; token: string; events: ChronicleEvent[] }

export type DateSource = 'event_date' | 'date' | 'published' | 'filename' | 'created';
export interface PrecedencePage {
  slug: string;
  token: string;
  frontmatter: Partial<Record<'event_date' | 'date' | 'published' | 'created', string>>;
  filename_date: string | null;
  expected_day: string;
  expected_source: DateSource;
  /** Other date signals on the page that must NOT win. */
  decoy_days: string[];
}

export interface TzPage {
  slug: string;
  token: string;
  event_date: string;
  case: string;
  expected_utc_ms: number;
  expected_utc_day: string;
}

export interface UndatedPage { slug: string; token: string }
export interface TrajectoryPoint { valid_from: string; value: number }
export interface LedgerTrajectory { company: string; metric: 'team_size'; points: TrajectoryPoint[] }

export interface N3Ledger {
  generator_version: string;
  seed: number;
  brain_timezone: string;
  chronicle_tz: string;
  people: LedgerPerson[];
  companies: LedgerCompany[];
  person_events: PersonEvent[];
  meetings: LedgerMeeting[];
  precedence_pages: PrecedencePage[];
  undated_pages: UndatedPage[];
  tz_pages: TzPage[];
  trajectories: LedgerTrajectory[];
}

/** One timeline row gbrain should hold, as the ledger defines it. */
export interface LedgerTimelineRow { page_slug: string; date: string; summary: string; kind: string | null; instant_ms: number; who: string[] }

// ─── Probes (what the runner sends) and gold (what the evaluator keeps) ──

export type N3Feature =
  | 'asof_facts' | 'asof_timeline' | 'pagedate_filter'
  | 'search_date_bounds' | 'effective_date_precedence' | 'effective_date_recorded_time'
  | 'relative_durations' | 'date_bound_input_validation'
  | 'timezone_search' | 'timezone_chronicle'
  | 'chronicle_day' | 'chronicle_week' | 'chronicle_since' | 'chronicle_since_kind' | 'chronicle_on_this_day' | 'chronicle_last_seen'
  | 'trajectory_range' | 'trajectory_asof';

export type N3Probe =
  | { id: string; feature: 'asof_facts' | 'asof_timeline'; person: string; asof: string; scenario: string }
  | { id: string; feature: 'pagedate_filter'; person: string; token: string; asof: string; scenario: string }
  | { id: string; feature: 'search_date_bounds'; token: string; since: string; until: string; label: string }
  | { id: string; feature: 'effective_date_precedence'; slug: string; token: string; check_days: string[] }
  | { id: string; feature: 'timezone_search'; slug: string; token: string; check_days: string[]; case: string }
  | { id: string; feature: 'chronicle_day' | 'chronicle_week' | 'timezone_chronicle'; date: string }
  | { id: string; feature: 'chronicle_since'; date: string }
  | { id: string; feature: 'chronicle_since_kind'; date: string; kind: string }
  | { id: string; feature: 'chronicle_on_this_day'; date: string }
  | { id: string; feature: 'chronicle_last_seen'; entity: string; asof: string; case: string }
  | { id: string; feature: 'trajectory_range'; entity: string; metric: string; since: string; until: string }
  | { id: string; feature: 'trajectory_asof'; entity: string; metric: string; asof: string };

export type N3Gold =
  | { kind: 'company'; company: string | null; recorded_company?: string | null }
  | { kind: 'set'; ids: string[] }
  | { kind: 'page_days'; slug: string; include_day: string; exclude_days: string[]; source?: DateSource }
  | { kind: 'last_seen'; last_date: string | null; days_ago: number | null }
  | { kind: 'value'; value: number | null };

export interface GeneratedN3 {
  ledger: N3Ledger;
  fingerprint: string;
  probes: N3Probe[];
  gold: Map<string, N3Gold>;
  /** Probes whose correct answer is empty / none / excluded. */
  negative: Set<string>;
}

// ─── World construction ──────────────────────────────────────────────────

const FIRST_NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory', 'niaj', 'olivia', 'peggy', 'rupert', 'sybil', 'trent', 'victor', 'walter', 'yvonne'];
const COMPANY_COUNT = 6;
const CHRONICLE_KINDS = ['meeting', 'call', 'meal', 'decision', 'intro', 'commitment'] as const;

export interface N3Options { seed?: number; people?: number; meetings?: number }

export function generateN3World(opts: N3Options = {}): GeneratedN3 {
  const seed = opts.seed ?? N3_DEFAULT_SEED;
  const nPeople = Math.min(opts.people ?? 16, FIRST_NAMES.length);
  const nMeetings = opts.meetings ?? 14;
  const rng = new Rng(seed);
  const usedTokens = new Set<string>();
  const token = (prefix: string) => {
    for (;;) {
      const t = `${prefix}${rng.letters(6)}`;
      if (!usedTokens.has(t)) { usedTokens.add(t); return t; }
    }
  };

  const companies: LedgerCompany[] = Array.from({ length: COMPANY_COUNT }, (_, i) => ({
    slug: `companies/startup-${i}`, id: `startup-${i}`, has_trajectory: i < COMPANY_COUNT - 1,
  }));
  const companyIds = companies.map(c => c.id);

  const people: LedgerPerson[] = FIRST_NAMES.slice(0, nPeople).map(name => ({ slug: `people/${name}-example`, name, token: token('zp'), role: 'regular' }));
  // Slug-prefix pairs: a person whose slug is a prefix of another's. lee has
  // a few early events of their own; kim is never seen. Their longer
  // namesakes attend meetings.
  people.push({ slug: 'people/lee-example', name: 'lee', token: token('zp'), role: 'prefix-short' });
  people.push({ slug: 'people/lee-example-jr', name: 'lee jr', token: token('zp'), role: 'prefix-long' });
  people.push({ slug: 'people/kim-example', name: 'kim', token: token('zp'), role: 'never-seen' });
  people.push({ slug: 'people/kim-example-2', name: 'kim 2', token: token('zp'), role: 'prefix-long' });
  people.push({ slug: 'people/quinn-example', name: 'quinn', token: token('zp'), role: 'never-seen' });

  // ── Person events (valid time) with recorded time ──
  const personEvents: PersonEvent[] = [];
  const eventful = people.filter(p => p.role === 'regular' || p.role === 'prefix-short');
  eventful.forEach((person, pi) => {
    const short = person.role === 'prefix-short';
    const count = short ? 3 : rng.int(5, 9);
    const boomerang = !short && pi % 6 === 0;
    const span = daysBetween(WORLD_START, short ? '2023-06-30' : WORLD_LAST_EVENT);
    const dates = new Set<string>();
    while (dates.size < count) dates.add(addDays(WORLD_START, rng.int(0, span)));
    const sorted = [...dates].sort();
    // Enforce >= 12 days between a person's events so day-before probes are unambiguous.
    for (let i = 1; i < sorted.length; i++) if (daysBetween(sorted[i - 1], sorted[i]) < 12) sorted[i] = addDays(sorted[i - 1], 12);
    let current: string | null = null;
    const jobSeq: string[] = [];
    const types: EventType[] = sorted.map((_, i) => {
      if (boomerang && i < 3) return i === 0 ? 'spoke at' : 'joined';
      if (i === 0 && rng.chance(0.4)) return 'announced';
      return rng.chance(0.5) ? rng.pick(['joined', 'hired by'] as const) : rng.pick(['announced', 'spoke at', 'promoted to'] as const);
    });
    if (boomerang) types[3] = 'hired by';
    sorted.forEach((date, i) => {
      const type = types[i];
      let company: string;
      if (JOB_CHANGE_TYPES.has(type)) {
        if (boomerang && jobSeq.length === 2) company = jobSeq[0];
        else company = rng.pick(companyIds.filter(c => c !== current));
        current = company;
        jobSeq.push(company);
      } else {
        company = rng.pick(companyIds);
      }
      const late = rng.chance(0.25);
      const recorded_on = late ? addDays(date, rng.int(30, 240)) : date;
      personEvents.push({
        id: `${person.slug}#${i}`, person: person.slug, date, type, company, summary: `${type} ${company}`,
        recorded_on, late, note_slug: `notes/${person.slug.slice('people/'.length)}-${String(i).padStart(2, '0')}`, scenario: 'normal',
      });
    });
    if (boomerang) {
      // Boomerang with a late record: the person joined A, moved to B, came
      // back to A; the note about the FIRST stint at A is written after the
      // return to A is already on file. Valid time says A during the first
      // stint regardless of when that was learned.
      const mine = personEvents.filter(e => e.person === person.slug && JOB_CHANGE_TYPES.has(e.type));
      if (mine.length >= 3 && mine[0].company === mine[2].company) {
        mine[0].recorded_on = addDays(mine[2].recorded_on > mine[2].date ? mine[2].recorded_on : mine[2].date, 10);
        mine[0].late = true;
        mine[0].scenario = 'boomerang-late';
      }
    }
  });

  // ── Meetings and chronicle events ──
  const attendeePool = people.filter(p => p.role === 'regular' || p.role === 'prefix-long').map(p => p.slug);
  const meetings: LedgerMeeting[] = [];
  const meetingDays = new Set<string>();
  const regularEvents = personEvents.filter(e => people.find(p => p.slug === e.person)?.role === 'regular');
  // Edge meetings: an attendee's late-evening event on day X - 1 (local)
  // lands on day X in UTC, and the same person has their own event on day X.
  // Edge meetings come first so their fixed days are never displaced.
  const edgeAnchors = rng.sample(regularEvents, Math.min(3, regularEvents.length))
    .filter((e, i, all) => all.findIndex(o => o.date === e.date) === i);
  for (let m = 0; m < edgeAnchors.length + nMeetings; m++) {
    const edge = m < edgeAnchors.length ? edgeAnchors[m] : null;
    let day = edge ? addDays(edge.date, -1) : addDays(WORLD_START, rng.int(0, daysBetween(WORLD_START, WORLD_LAST_EVENT)));
    while (!edge && meetingDays.has(day)) day = addDays(day, 1);
    meetingDays.add(day);
    const attendees = edge
      ? [edge.person]
      : rng.sample(attendeePool, rng.int(1, 3));
    if (!edge && m % 4 === 0 && !attendees.includes('people/lee-example-jr')) attendees[0] = 'people/lee-example-jr';
    if (!edge && m % 5 === 1 && !attendees.includes('people/kim-example-2')) attendees[attendees.length - 1] = 'people/kim-example-2';
    const uniqAttendees = [...new Set(attendees)];
    const nEvents = edge ? 1 : rng.int(1, 2);
    const hours = [9, 14];
    const events: ChronicleEvent[] = [];
    for (let e = 0; e < nEvents; e++) {
      const dateOnly = !edge && m % 7 === 3 && e === 0;
      const hh = edge ? 23 : hours[e];
      const mm = edge ? rng.int(5, 55) : rng.int(0, 59);
      const when = dateOnly ? day : easternIso(day, hh, mm);
      const utcMs = dateOnly ? dayMs(day) : easternWallToUtcMs(day, hh, mm);
      events.push({
        id: `mtg${m}#${e}`, when, local_day: day, utc_day: msDay(utcMs),
        who: uniqAttendees, what: `${rng.pick(['Sync', 'Review', 'Dinner', 'Planning', 'Kickoff'])} ${m}-${e} with ${uniqAttendees.length} attendee(s)`,
        kind: edge ? 'call' : rng.pick(CHRONICLE_KINDS), edge: edge ? 'late-evening' : dateOnly ? 'date-only' : 'none',
      });
    }
    meetings.push({ slug: `meetings/${day}-mtg-${String(m).padStart(2, '0')}`, date: day, attendees: uniqAttendees, token: token('zm'), events });
  }

  // ── Effective-date precedence pages ──
  const precedencePages: PrecedencePage[] = [];
  const PREC_KEYS = ['event_date', 'date', 'published', 'created'] as const;
  for (let i = 0; i < 10; i++) {
    const days = rng.sample(Array.from({ length: 360 }, (_, k) => addDays('2023-01-05', k)), 5);
    const fm: PrecedencePage['frontmatter'] = {};
    PREC_KEYS.forEach((k, j) => { if (rng.chance(0.55)) fm[k] = days[j]; });
    const layout = i % 3; // 0: meetings/<date>-…, 1: notes/<date>-…, 2: notes/prec-…
    // Pin the two lowest-precedence outcomes so every source is exercised:
    // a filename date outside meetings/ beats `created` (i = 7), and
    // `created` wins when nothing else is present (i = 8).
    if (i === 7 || i === 8) for (const k of PREC_KEYS) delete fm[k];
    if (i === 7 || i === 8) fm.created = days[3];
    const filenameDate = layout === 2 ? null : days[4];
    if (Object.keys(fm).length === 0 && filenameDate === null) fm.date = days[1];
    const t = token('zd');
    const slug = layout === 0 ? `meetings/${days[4]}-prec-${t}` : layout === 1 ? `notes/${days[4]}-prec-${t}` : `notes/prec-${t}`;
    const expected = expectedEffectiveDate(slug, fm, filenameDate);
    const all = [...Object.values(fm), ...(filenameDate ? [filenameDate] : [])];
    precedencePages.push({ slug, token: t, frontmatter: fm, filename_date: filenameDate, expected_day: expected.day, expected_source: expected.source, decoy_days: [...new Set(all.filter(d => d !== expected.day))].sort() });
  }

  const undatedPages: UndatedPage[] = Array.from({ length: 3 }, () => { const t = token('zu'); return { slug: `notes/undated-${t}`, token: t }; });

  // ── Time-zone edge pages (fixed catalogue; oracle computes the instants) ──
  const tzCases: Array<{ case: string; event_date: string; utcMs: number }> = [
    { case: 'offset -07:00 late evening', event_date: '2024-06-14T23:30:00-07:00', utcMs: Date.UTC(2024, 5, 15, 6, 30) },
    { case: 'Z just after midnight', event_date: '2024-06-15T00:15:00Z', utcMs: Date.UTC(2024, 5, 15, 0, 15) },
    { case: 'offset +02:00 just after midnight', event_date: '2024-06-15T00:30:00+02:00', utcMs: Date.UTC(2024, 5, 14, 22, 30) },
    { case: 'naive, brain.timezone, day after spring-forward (EDT)', event_date: '2024-03-10T19:30:00', utcMs: easternWallToUtcMs('2024-03-10', 19, 30) },
    { case: 'naive, brain.timezone, day before spring-forward (EST)', event_date: '2024-03-09T19:30:00', utcMs: easternWallToUtcMs('2024-03-09', 19, 30) },
    { case: 'naive, brain.timezone, day of fall-back (EST)', event_date: '2024-11-03T19:30:00', utcMs: easternWallToUtcMs('2024-11-03', 19, 30) },
    { case: 'naive, brain.timezone, day before fall-back (EDT)', event_date: '2024-11-02T19:30:00', utcMs: easternWallToUtcMs('2024-11-02', 19, 30) },
    { case: 'naive, brain.timezone, summer evening (EDT)', event_date: '2024-07-04T21:00:00', utcMs: easternWallToUtcMs('2024-07-04', 21, 0) },
    { case: 'date-only is a UTC calendar date even with brain.timezone', event_date: '2024-03-10', utcMs: Date.UTC(2024, 2, 10) },
  ];
  const tzPages: TzPage[] = tzCases.map(c => { const t = token('zt'); return { slug: `notes/tz-${t}`, token: t, event_date: c.event_date, case: c.case, expected_utc_ms: c.utcMs, expected_utc_day: msDay(c.utcMs) }; });

  // ── Company metric trajectories ──
  const trajectories: LedgerTrajectory[] = companies.filter(c => c.has_trajectory).map(c => {
    let value = rng.int(5, 30);
    const points: TrajectoryPoint[] = [];
    for (let q = 0; q < 16; q++) {
      const year = 2022 + Math.floor(q / 4);
      points.push({ valid_from: `${year}-${String((q % 4) * 3 + 1).padStart(2, '0')}-01`, value });
      value = Math.max(1, value + rng.int(-6, 9));
    }
    return { company: c.slug, metric: 'team_size', points };
  });

  const ledger: N3Ledger = {
    generator_version: N3_GENERATOR_VERSION, seed, brain_timezone: WORLD_TZ, chronicle_tz: WORLD_TZ,
    people, companies, person_events: personEvents, meetings, precedence_pages: precedencePages,
    undated_pages: undatedPages, tz_pages: tzPages, trajectories,
  };
  const { probes, gold, negative } = deriveProbes(ledger, rng);
  return { ledger, fingerprint: ledgerFingerprint(ledger), probes, gold, negative };
}

/** Documented effective-date precedence (gbrain src/core/effective-date.ts header), date-only values. */
export function expectedEffectiveDate(
  slug: string,
  fm: PrecedencePage['frontmatter'],
  filenameDate: string | null,
): { day: string; source: DateSource } {
  const filenameFirst = slug.startsWith('daily/') || slug.startsWith('meetings/');
  const chain: Array<[DateSource, string | null | undefined]> = filenameFirst
    ? [['filename', filenameDate], ['event_date', fm.event_date], ['date', fm.date], ['published', fm.published], ['created', fm.created]]
    : [['event_date', fm.event_date], ['date', fm.date], ['published', fm.published], ['filename', filenameDate], ['created', fm.created]];
  for (const [source, day] of chain) if (day) return { day, source };
  throw new Error(`expectedEffectiveDate: ${slug} has no date signal`);
}

// ─── Timeline rows the ledger implies ─────────────────────────────────────

export function ledgerTimelineRows(ledger: N3Ledger): LedgerTimelineRow[] {
  const rows: LedgerTimelineRow[] = ledger.person_events.map(e => ({
    page_slug: e.person, date: e.date, summary: e.summary, kind: null, instant_ms: dayMs(e.date), who: [],
  }));
  for (const m of ledger.meetings) {
    for (const ev of m.events) {
      rows.push({ page_slug: m.slug, date: ev.local_day, summary: ev.what, kind: ev.kind, instant_ms: /T/.test(ev.when) ? Date.parse(ev.when) : dayMs(ev.when), who: ev.who });
    }
  }
  return rows;
}

export function timelineRowId(r: { page_slug: string; date: string; summary: string }): string {
  return `${r.page_slug}|${r.date}|${r.summary}`;
}

/** Last day ≤ asof on which the entity appears: its own timeline rows or an event's `who`. */
export function oracleLastSeen(rows: readonly LedgerTimelineRow[], entity: string, asof: string): { last_date: string | null; days_ago: number | null } {
  let best: string | null = null;
  for (const r of rows) {
    if (r.date > asof) continue;
    if (r.page_slug !== entity && !r.who.includes(entity)) continue;
    if (best === null || r.date > best) best = r.date;
  }
  return { last_date: best, days_ago: best === null ? null : daysBetween(best, asof) };
}

/** Employer at the end of each query day, by valid time; `recordedBy` limits to events recorded on or before that day. */
export function oracleEmployer(events: readonly PersonEvent[], person: string, asof: string, recordedBy?: string): string | null {
  const mine = events
    .filter(e => e.person === person && (recordedBy === undefined || e.recorded_on <= recordedBy))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1);
  const machine = new ForwardJobState([asof]);
  for (const e of mine) machine.observe(e.date, e.summary);
  return machine.finish().get(asof) ?? null;
}

// ─── Probe derivation ─────────────────────────────────────────────────────

function deriveProbes(ledger: N3Ledger, rng: Rng): { probes: N3Probe[]; gold: Map<string, N3Gold>; negative: Set<string> } {
  const probes: N3Probe[] = [];
  const gold = new Map<string, N3Gold>();
  const negative = new Set<string>();
  const add = (p: N3Probe, g: N3Gold, isNegative: boolean) => {
    if (gold.has(p.id)) throw new Error(`duplicate probe id ${p.id}`);
    probes.push(p); gold.set(p.id, g); if (isNegative) negative.add(p.id);
  };
  const rows = ledgerTimelineRows(ledger);
  const events = ledger.person_events;

  // ── As-of employer: facts arm, timeline arm, page-date arm ──
  const asofPeople = ledger.people.filter(p => p.role === 'regular');
  for (const person of asofPeople) {
    const mine = events.filter(e => e.person === person.slug).sort((a, b) => a.date < b.date ? -1 : 1);
    const jobs = mine.filter(e => JOB_CHANGE_TYPES.has(e.type));
    const dates = new Map<string, string>();
    dates.set(addDays(WORLD_START, -30), 'before-any-state');
    if (jobs.length > 0) {
      dates.set(addDays(jobs[0].date, -1), 'day-before-first-job');
      const boundary = rng.pick(jobs);
      dates.set(boundary.date, 'on-job-change-day');
      if (jobs.indexOf(boundary) > 0) dates.set(addDays(boundary.date, -1), 'day-before-job-change');
    }
    for (let k = 0; k < 2; k++) dates.set(addDays(WORLD_START, rng.int(0, daysBetween(WORLD_START, '2026-03-31'))), 'random');
    const boomerang = mine.find(e => e.scenario === 'boomerang-late');
    if (boomerang) {
      const next = jobs[jobs.indexOf(boomerang) + 1];
      dates.set(addDays(boomerang.date, Math.max(1, Math.floor(daysBetween(boomerang.date, next.date) / 2))), 'boomerang-late-first-stint');
    }
    for (const lateEv of mine.filter(e => e.late && JOB_CHANGE_TYPES.has(e.type) && e.scenario === 'normal').slice(0, 1)) {
      const mid = addDays(lateEv.date, Math.max(0, Math.floor(daysBetween(lateEv.date, lateEv.recorded_on) / 2)));
      const nextJob = jobs[jobs.indexOf(lateEv) + 1];
      if (!nextJob || mid < nextJob.date) dates.set(mid, 'late-recorded-window');
    }
    for (const [asof, scenario] of [...dates.entries()].sort()) {
      const company = oracleEmployer(events, person.slug, asof);
      const recorded = oracleEmployer(events, person.slug, asof, asof);
      const tag = `${person.name}@${asof}`;
      // The recorded-time answer rides on the facts gold for the descriptive
      // "page-date filtering vs true as-of" comparison.
      add({ id: `asof_facts:${tag}`, feature: 'asof_facts', person: person.slug, asof, scenario }, { kind: 'company', company, recorded_company: recorded }, company === null);
      add({ id: `asof_timeline:${tag}`, feature: 'asof_timeline', person: person.slug, asof, scenario }, { kind: 'company', company }, company === null);
      const noteIds = events.filter(e => e.person === person.slug && e.recorded_on <= asof).map(e => e.note_slug).sort();
      add({ id: `pagedate_filter:${tag}`, feature: 'pagedate_filter', person: person.slug, token: person.token, asof, scenario },
        { kind: 'set', ids: noteIds }, noteIds.length === 0);
    }
  }

  // ── Search date bounds over note pages (page date = recorded_on) ──
  const noteDays = events.map(e => ({ slug: e.note_slug, day: e.recorded_on }));
  const windows: Array<{ label: string; since: string; until: string }> = [];
  const quarters: Array<[string, string]> = [];
  for (let y = 2022; y <= 2025; y++) for (let q = 0; q < 4; q++) quarters.push([`${y}-${String(q * 3 + 1).padStart(2, '0')}-01`, addDays(`${q === 3 ? y + 1 : y}-${String(q === 3 ? 1 : q * 3 + 4).padStart(2, '0')}-01`, -1)]);
  for (const [since, until] of rng.sample(quarters, 6)) windows.push({ label: `quarter ${since}..${until}`, since, until });
  for (const e of rng.sample(events, 4)) windows.push({ label: `single day ${e.recorded_on}`, since: e.recorded_on, until: e.recorded_on });
  const startDay = rng.pick(events).recorded_on;
  windows.push({ label: 'open-ended since', since: addDays('2025-06-30', 0), until: '' });
  windows.push({ label: 'open-ended until', since: '', until: '2022-06-30' });
  windows.push({ label: 'month', since: `${startDay.slice(0, 7)}-01`, until: addDays(msDay(Date.UTC(+startDay.slice(0, 4), +startDay.slice(5, 7), 1)), -1) });
  windows.push({ label: 'empty: before the world', since: '2019-01-01', until: '2019-12-31' });
  let gapDay = addDays(WORLD_START, 3);
  const noteDaySet = new Set(noteDays.map(n => n.day));
  while (noteDaySet.has(gapDay)) gapDay = addDays(gapDay, 1);
  windows.push({ label: `empty: day with no note ${gapDay}`, since: gapDay, until: gapDay });
  windows.forEach((w, i) => {
    const ids = noteDays.filter(n => (!w.since || n.day >= w.since) && (!w.until || n.day <= w.until)).map(n => n.slug).sort();
    if (ids.length > 90) throw new Error(`window ${w.label} holds ${ids.length} notes; search returns at most 100`);
    add({ id: `search_date_bounds:${i}:${w.label}`, feature: 'search_date_bounds', token: 'ledgernote', since: w.since, until: w.until, label: w.label }, { kind: 'set', ids }, ids.length === 0);
  });

  // ── Effective-date precedence ──
  for (const p of ledger.precedence_pages) {
    add({ id: `effective_date_precedence:${p.slug}`, feature: 'effective_date_precedence', slug: p.slug, token: p.token, check_days: [p.expected_day, ...p.decoy_days] },
      { kind: 'page_days', slug: p.slug, include_day: p.expected_day, exclude_days: p.decoy_days, source: p.expected_source }, false);
  }

  // ── Time-zone search pages ──
  for (const t of ledger.tz_pages) {
    const exclude = [addDays(t.expected_utc_day, -1), addDays(t.expected_utc_day, 1)];
    add({ id: `timezone_search:${t.slug}`, feature: 'timezone_search', slug: t.slug, token: t.token, check_days: [t.expected_utc_day, ...exclude], case: t.case },
      { kind: 'page_days', slug: t.slug, include_day: t.expected_utc_day, exclude_days: exclude }, false);
  }

  // ── Chronicle day / week / since / kind / on-this-day ──
  const setOf = (pred: (r: LedgerTimelineRow) => boolean) => rows.filter(pred).map(timelineRowId).sort();
  const rowDays = [...new Set(rows.map(r => r.date))].sort();
  const dayProbe = (feature: 'chronicle_day' | 'timezone_chronicle', date: string, tag: string) => {
    const ids = setOf(r => r.date === date);
    add({ id: `${feature}:${tag}:${date}`, feature, date }, { kind: 'set', ids }, ids.length === 0);
  };
  const plainMeetingDays = ledger.meetings.filter(m => m.events.every(e => e.edge === 'none')).map(m => m.date);
  for (const d of rng.sample(plainMeetingDays, 5)) dayProbe('chronicle_day', d, 'meeting');
  for (const d of rng.sample(events.map(e => e.date), 5)) dayProbe('chronicle_day', d, 'person');
  for (const m of ledger.meetings.filter(mm => mm.events.some(e => e.edge === 'date-only'))) dayProbe('chronicle_day', m.date, 'date-only-event');
  let emptyDay = '2023-01-01';
  const rowDaySet = new Set(rowDays);
  for (let k = 0; k < 3; k++) {
    while (rowDaySet.has(emptyDay)) emptyDay = addDays(emptyDay, 1);
    dayProbe('chronicle_day', emptyDay, 'empty');
    emptyDay = addDays(emptyDay, 97);
  }
  for (const m of ledger.meetings.filter(mm => mm.events.some(e => e.edge === 'late-evening'))) {
    const ev = m.events.find(e => e.edge === 'late-evening')!;
    dayProbe('timezone_chronicle', ev.local_day, 'local-day');
    dayProbe('timezone_chronicle', ev.utc_day, 'utc-day');
  }
  for (const d of [...rng.sample(rowDays, 3), '2021-06-16']) {
    const start = isoWeekStart(d);
    const end = addDays(start, 6);
    const ids = setOf(r => r.date >= start && r.date <= end);
    add({ id: `chronicle_week:${d}`, feature: 'chronicle_week', date: d }, { kind: 'set', ids }, ids.length === 0);
  }
  for (const d of ['2025-09-01', '2025-03-15', '2024-12-01', '2026-01-01']) {
    const ids = setOf(r => r.date >= d);
    add({ id: `chronicle_since:${d}`, feature: 'chronicle_since', date: d }, { kind: 'set', ids }, ids.length === 0);
  }
  const kinds = [...new Set(rows.filter(r => r.kind).map(r => r.kind!))].sort();
  for (const k of rng.sample(kinds, 2)) {
    const ids = setOf(r => r.kind === k && r.date >= '2023-01-01');
    add({ id: `chronicle_since_kind:${k}`, feature: 'chronicle_since_kind', date: '2023-01-01', kind: k }, { kind: 'set', ids }, ids.length === 0);
  }
  add({ id: 'chronicle_since_kind:travel(absent)', feature: 'chronicle_since_kind', date: '2022-01-01', kind: 'travel' }, { kind: 'set', ids: [] }, true);
  const monthDays = [...new Set(rows.map(r => r.date.slice(5)))].filter(md => md !== '02-29').sort();
  for (const md of rng.sample(monthDays, 4)) {
    const anchor = `2026-${md}`;
    const ids = setOf(r => r.date.slice(5) === md && r.date < anchor);
    add({ id: `chronicle_on_this_day:${anchor}`, feature: 'chronicle_on_this_day', date: anchor }, { kind: 'set', ids }, ids.length === 0);
  }
  let emptyMd = '01-01';
  const mdSet = new Set(rows.map(r => r.date.slice(5)));
  for (let k = 0; mdSet.has(emptyMd) && k < 366; k++) emptyMd = addDays(`2023-${emptyMd}`, 1).slice(5);
  add({ id: `chronicle_on_this_day:2026-${emptyMd}(empty)`, feature: 'chronicle_on_this_day', date: `2026-${emptyMd}` }, { kind: 'set', ids: [] }, true);

  // ── Last seen ──
  for (const person of ledger.people) {
    const seen = rows.filter(r => r.page_slug === person.slug || r.who.includes(person.slug)).map(r => r.date).sort();
    const asofs = new Map<string, string>();
    asofs.set('2026-06-30', 'after-everything');
    asofs.set(addDays(WORLD_START, rng.int(200, daysBetween(WORLD_START, WORLD_LAST_EVENT))), 'random');
    if (seen.length > 0) {
      asofs.set(addDays(seen[0], -1), 'before-first-sighting');
      asofs.set(seen[Math.floor(seen.length / 2)], 'on-a-sighting-day');
    }
    for (const [asof, c] of [...asofs.entries()].sort()) {
      const g = oracleLastSeen(rows, person.slug, asof);
      add({ id: `chronicle_last_seen:${person.slug}@${asof}`, feature: 'chronicle_last_seen', entity: person.slug, asof, case: `${person.role}:${c}` },
        { kind: 'last_seen', ...g }, g.last_date === null);
    }
  }
  for (const m of ledger.meetings.filter(mm => mm.events.some(e => e.edge === 'late-evening'))) {
    const who = m.events[0].who[0];
    const own = events.find(e => e.person === who && e.date === addDays(m.date, 1));
    if (!own) continue;
    const g = oracleLastSeen(rows, who, own.date);
    add({ id: `chronicle_last_seen:${who}@${own.date}(late-evening-edge)`, feature: 'chronicle_last_seen', entity: who, asof: own.date, case: 'regular:late-evening-event-then-own-event-next-day' },
      { kind: 'last_seen', ...g }, false);
  }

  // ── Trajectories ──
  for (const t of ledger.trajectories) {
    for (let k = 0; k < 2; k++) {
      const a = rng.int(0, 13);
      const b = rng.int(a + 1, 15);
      const since = t.points[a].valid_from;
      const until = addDays(t.points[b].valid_from, rng.chance(0.5) ? 0 : 10);
      const ids = t.points.filter(p => p.valid_from >= since && p.valid_from <= until).map(p => p.valid_from);
      add({ id: `trajectory_range:${t.company}:${since}..${until}`, feature: 'trajectory_range', entity: t.company, metric: t.metric, since, until }, { kind: 'set', ids }, false);
    }
    add({ id: `trajectory_range:${t.company}:2019(empty)`, feature: 'trajectory_range', entity: t.company, metric: t.metric, since: '2019-01-01', until: '2019-12-31' }, { kind: 'set', ids: [] }, true);
    const asof = addDays('2022-01-01', rng.int(0, 1500));
    const at = t.points.filter(p => p.valid_from <= asof).pop();
    add({ id: `trajectory_asof:${t.company}@${asof}`, feature: 'trajectory_asof', entity: t.company, metric: t.metric, asof }, { kind: 'value', value: at?.value ?? null }, at === undefined);
    add({ id: `trajectory_asof:${t.company}@2021-12-31(before)`, feature: 'trajectory_asof', entity: t.company, metric: t.metric, asof: '2021-12-31' }, { kind: 'value', value: null }, true);
  }
  for (const c of ledger.companies.filter(cc => !cc.has_trajectory)) {
    add({ id: `trajectory_range:${c.slug}:no-facts`, feature: 'trajectory_range', entity: c.slug, metric: 'team_size', since: '2022-01-01', until: '2025-12-31' }, { kind: 'set', ids: [] }, true);
  }

  return { probes, gold, negative };
}

// ─── Fingerprint ──────────────────────────────────────────────────────────

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** sha256 over the canonical JSON of the ledger. */
export function ledgerFingerprint(ledger: N3Ledger): string {
  return createHash('sha256').update(canonical(ledger)).digest('hex');
}

// ─── Clock-relative pages (outside the ledger; gbrain cannot pin "now") ──

export const RELATIVE_AGES_DAYS = [2, 10, 20, 45, 200, 500] as const;
export interface RelativePage { slug: string; age_days: number; date: string }
export interface RelativeProbe { id: string; since?: string; until?: string; expected_ages: number[] | 'reject' }

/**
 * Pages dated a fixed number of days before the run's UTC date, and the
 * relative-duration probes over them. The ages keep every page at least two
 * days from any window edge, so seconds of clock drift cannot move a page
 * across a boundary.
 */
export function relativeWorld(anchorDay: string): { pages: RelativePage[]; probes: RelativeProbe[] } {
  const pages = RELATIVE_AGES_DAYS.map(age => ({ slug: `notes/relative-${age}d`, age_days: age, date: addDays(anchorDay, -age) }));
  const within = (lo: number | null, hi: number | null) => RELATIVE_AGES_DAYS.filter(a => (lo === null || a <= lo) && (hi === null || a >= hi));
  const probes: RelativeProbe[] = [
    { id: 'relative:since=7d', since: '7d', expected_ages: within(7, null) },
    { id: 'relative:since=2w', since: '2w', expected_ages: within(14, null) },
    { id: 'relative:since=1m', since: '1m', expected_ages: within(30, null) },
    { id: 'relative:since=1y', since: '1y', expected_ages: within(365, null) },
    { id: 'relative:since=3y', since: '3y', expected_ages: within(3 * 365, null) },
    { id: 'relative:since=1m,until=7d', since: '1m', until: '7d', expected_ages: within(30, 7) },
    { id: 'relative:since=1d(empty)', since: '1d', expected_ages: [] },
    { id: 'input:yesterday', since: 'yesterday', expected_ages: 'reject' },
    { id: 'input:last week', since: 'last week', expected_ages: 'reject' },
    { id: 'input:3 days ago', since: '3 days ago', expected_ages: 'reject' },
    { id: 'input:May 5 (non-ISO)', since: 'May 5', expected_ages: 'reject' },
    { id: 'input:2024-02-30 (not a calendar date)', since: '2024-02-30', expected_ages: 'reject' },
  ];
  return { pages, probes };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--seed');
  const seed = at >= 0 ? Number(argv[at + 1]) : N3_DEFAULT_SEED;
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const world = generateN3World({ seed });
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ fingerprint: world.fingerprint, ledger: world.ledger }, null, 2) + '\n');
  } else {
    const byFeature = new Map<string, number>();
    for (const p of world.probes) byFeature.set(p.feature, (byFeature.get(p.feature) ?? 0) + 1);
    console.log(`${N3_GENERATOR_VERSION} seed=${seed} fingerprint=${world.fingerprint}`);
    console.log(`people=${world.ledger.people.length} person_events=${world.ledger.person_events.length} meetings=${world.ledger.meetings.length} probes=${world.probes.length} negative=${world.negative.size}`);
    for (const [f, n] of [...byFeature.entries()].sort()) console.log(`  ${f}: ${n}`);
  }
}
