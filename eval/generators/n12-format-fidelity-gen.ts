/**
 * N12 format-fidelity world generator.
 *
 * Emits a LEDGER of canonical conversations (participants with a role, turns
 * with a speaker, a UTC instant and one or more text lines carrying a unique
 * marker), seeded meeting pages for the attendance stage (who attended, who
 * is only mentioned, and the evidence form the page uses), and negative
 * inputs that are not conversations. The renderers in
 * n12-format-renderers.ts turn each conversation into every format; the gold
 * for a rendered item is this ledger plus what the renderer wrote, never
 * gbrain output.
 *
 * Conversation kinds (each a stress the category reports separately):
 *   control       two speakers, four single-line turns, whole minutes, one day
 *                 (the utility-floor item);
 *   edges         12-hour clock edges (12:05 AM, 11:59 AM, 12:00 PM, 12:30 PM),
 *                 seconds on every turn;
 *   multiline     multi-line turns, seconds on every turn;
 *   three-party   three speakers, one name with a non-ASCII letter;
 *   same-speaker  two consecutive turns by the same speaker;
 *   tricky        lines inside turns that look like labels, times and lists;
 *   midnight      turns that cross midnight UTC;
 *   offset        a source that stamps instants with a -07:00 offset
 *                 (ISO-string formats only; the instants are the same).
 *
 * Names are fictional placeholders (Alice Example, people/alice-example).
 *
 * Usage: bun eval/generators/n12-format-fidelity-gen.ts [--seed N] [--json]
 */
import { createHash } from 'node:crypto';

export const N12_GENERATOR_VERSION = 'n12-format-fidelity-gen/1';
export const N12_DEFAULT_SEED = 12;

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
  int(lo: number, hi: number): number { return lo + Math.floor(this.#next() * (hi - lo + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.#next() * xs.length)]; }
  sample<T>(xs: readonly T[], n: number): T[] {
    const pool = [...xs];
    const out: T[] = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(this.#next() * pool.length), 1)[0]);
    return out;
  }
}

export interface Participant {
  /** Display name, e.g. "Alice Example". */
  name: string;
  /** Lowercase handle for IRC and Matrix, e.g. "alice". */
  nick: string;
  /** Person slug tail, e.g. "alice-example". */
  handle: string;
  role: 'user' | 'assistant';
}

export interface Turn {
  /** Index into the conversation's participants. */
  speaker: number;
  /** UTC instant, ISO with milliseconds and Z. */
  at: string;
  /** Text lines; the last line ends with the marker. */
  lines: string[];
  /** Unique token that identifies this turn wherever it lands. */
  marker: string;
}

export type ConversationKind = 'control' | 'edges' | 'multiline' | 'three-party' | 'same-speaker' | 'tricky' | 'midnight' | 'offset';

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string;
  participants: Participant[];
  turns: Turn[];
  /** Minutes east of UTC that ISO-string sources stamp (offset kind only). */
  source_offset_minutes: number;
}

export const ATTENDANCE_FORMS = ['attendees-section', 'inline-attendees', 'bold-attendees', 'frontmatter-attendees', 'participants-line', 'speakers-only'] as const;
export type AttendanceForm = typeof ATTENDANCE_FORMS[number];
/** Forms gbrain documents as attendance evidence (src/core/link-extraction.ts attendanceEvidenceRanges and FRONTMATTER_LINK_MAP). */
export const DOCUMENTED_ATTENDANCE_FORMS: readonly AttendanceForm[] = ['attendees-section', 'inline-attendees', 'bold-attendees', 'frontmatter-attendees'];
/** The meeting-ingestion template form; the attendance utility floor. */
export const CONTROL_ATTENDANCE_FORM: AttendanceForm = 'attendees-section';

export interface PersonPage { slug: string; name: string }

export interface MeetingPage {
  slug: string;
  title: string;
  date: string;
  form: AttendanceForm;
  /** Person slugs that attended (gold). */
  attendees: string[];
  /** Person slugs only mentioned in the body (negatives). */
  mentioned: string[];
  /** Full page content with frontmatter. */
  content: string;
}

export type NegativeKind = 'prose-note' | 'generic-json-body' | 'bold-label-notes' | 'code-doc' | 'meeting-summary';

export interface NegativePage { id: string; kind: NegativeKind; body: string }

export interface N12Ledger {
  generator_version: string;
  seed: number;
  conversations: Conversation[];
  people: PersonPage[];
  meetings: MeetingPage[];
  negative_pages: NegativePage[];
}

export interface GeneratedN12 { ledger: N12Ledger; fingerprint: string }

const PEOPLE: ReadonlyArray<Omit<Participant, 'role'>> = [
  { name: 'Alice Example', nick: 'alice', handle: 'alice-example' },
  { name: 'Bob Example', nick: 'bob', handle: 'bob-example' },
  { name: 'Charlie Example', nick: 'charlie', handle: 'charlie-example' },
  { name: 'Dana Example', nick: 'dana', handle: 'dana-example' },
  { name: 'Erin Example', nick: 'erin', handle: 'erin-example' },
  { name: 'Frank Example', nick: 'frank', handle: 'frank-example' },
  { name: 'Grace Example', nick: 'grace', handle: 'grace-example' },
  { name: 'Hana Example', nick: 'hana', handle: 'hana-example' },
];
const NON_ASCII: Omit<Participant, 'role'> = { name: 'Zoë Example', nick: 'zoe', handle: 'zoe-example' };

const OPENERS = ['Can we', 'I think we should', 'Please', 'Let us', 'We still need to', 'Remember to', 'I would rather', 'Could you'];
const TOPICS = ['review the widget launch plan', 'move the pricing page to Friday', 'send the acme-example memo', 'check the demo build', 'update the fund-a summary', 'draft the onboarding checklist', 'fix the signup copy', 'book the design review'];
const CLOSERS = ['before the call', 'this week', 'after lunch', 'when you can', 'by tomorrow', 'first thing', 'today', 'next sprint'];
const SECOND_LINES = ['The numbers look fine so far', 'I added two comments in the doc', 'Nothing blocks this yet', 'The team agreed in principle'];
const TRICKY = ['Agenda: pricing, demo, launch', 'at 9:30 we sync again', '- follow up with the design team', '**Next step:** ship the draft', 'Note to self: check the numbers'];

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const MIN = 60_000;

function sentence(r: Rng, marker: string): string {
  return `${r.pick(OPENERS)} ${r.pick(TOPICS)} ${r.pick(CLOSERS)}, ref ${marker}`;
}

function baseDay(r: Rng): number {
  return Date.UTC(2026, r.int(0, 7), r.int(1, 28));
}

export function generateN12World(opts: { seed?: number } = {}): GeneratedN12 {
  const seed = opts.seed ?? N12_DEFAULT_SEED;
  const r = new Rng(seed);
  let markerN = 0;
  const marker = () => `zq${(seed * 1000 + markerN++).toString(36).padStart(4, '0')}`;
  const cast = (n: number, extra?: Omit<Participant, 'role'>): Participant[] => {
    const picks = r.sample(PEOPLE, extra ? n - 1 : n);
    if (extra) picks.splice(1, 0, extra);
    return picks.map((p, i) => ({ ...p, role: i === 0 ? 'user' : 'assistant' }));
  };
  const turnsAt = (times: number[], speakers: number[], textFor: (i: number, m: string) => string[]): Turn[] =>
    times.map((t, i) => {
      const m = marker();
      return { speaker: speakers[i], at: iso(t), lines: textFor(i, m), marker: m };
    });
  const oneLine = (_i: number, m: string) => [sentence(r, m)];
  const twoLines = (_i: number, m: string) => [r.pick(SECOND_LINES), sentence(r, m)];
  const conversations: Conversation[] = [];
  const add = (kind: ConversationKind, participants: Participant[], turns: Turn[], offset = 0) => {
    conversations.push({ id: `c${conversations.length}-${kind}`, kind, title: `Synthetic ${kind} chat ${conversations.length}`, participants, turns, source_offset_minutes: offset });
  };

  // control: whole minutes, two speakers alternating, single line.
  {
    const day = baseDay(r) + r.int(9, 15) * 60 * MIN;
    const times = [0, 1, 2, 3].map(i => day + i * r.int(2, 9) * MIN + i * MIN);
    add('control', cast(2), turnsAt(times, [0, 1, 0, 1], oneLine));
  }
  // edges: 12-hour clock edges with seconds.
  {
    const day = baseDay(r);
    const times = [5, 11 * 60 + 59, 12 * 60, 12 * 60 + 30].map(m => day + m * MIN + r.int(1, 59) * 1000);
    add('edges', cast(2), turnsAt(times, [0, 1, 0, 1], oneLine));
  }
  // multiline: two lines per turn, seconds.
  {
    let t = baseDay(r) + r.int(8, 18) * 60 * MIN + r.int(1, 59) * 1000;
    const times = Array.from({ length: 6 }, () => (t += r.int(1, 40) * MIN + r.int(1, 59) * 1000));
    add('multiline', cast(2), turnsAt(times, [0, 1, 0, 1, 0, 1], twoLines));
  }
  // three-party with a non-ASCII name.
  {
    let t = baseDay(r) + r.int(8, 18) * 60 * MIN;
    const times = Array.from({ length: 6 }, () => (t += r.int(1, 30) * MIN));
    add('three-party', cast(3, NON_ASCII), turnsAt(times, [0, 1, 2, 0, 2, 1], oneLine));
  }
  // same-speaker: consecutive turns by one speaker.
  {
    let t = baseDay(r) + r.int(8, 18) * 60 * MIN;
    const times = Array.from({ length: 5 }, () => (t += r.int(1, 20) * MIN));
    add('same-speaker', cast(2), turnsAt(times, [0, 1, 1, 0, 0], oneLine));
  }
  // tricky: label-, time- and list-shaped lines inside turns.
  {
    let t = baseDay(r) + r.int(8, 18) * 60 * MIN;
    const times = Array.from({ length: 5 }, () => (t += r.int(1, 20) * MIN));
    add('tricky', cast(2), turnsAt(times, [0, 1, 0, 1, 0], (i, m) => [TRICKY[i % TRICKY.length], sentence(r, m)]));
  }
  // midnight: crosses midnight UTC.
  {
    const midnight = baseDay(r) + DAY;
    const times = [-4, -1, 2, 7].map(m => midnight + m * MIN);
    add('midnight', cast(2), turnsAt(times, [0, 1, 0, 1], oneLine));
  }
  // offset: evening local time at UTC-7, so the local and UTC dates differ.
  {
    const day = baseDay(r);
    const times = [22 * 60 + 30, 22 * 60 + 41, 23 * 60 + 5, 23 * 60 + 20].map(m => day + m * MIN + 7 * 60 * MIN);
    add('offset', cast(2), turnsAt(times, [0, 1, 0, 1], oneLine), -7 * 60);
  }

  const people: PersonPage[] = [...PEOPLE, NON_ASCII].map(p => ({ slug: `people/${p.handle}`, name: p.name }));
  const meetings: MeetingPage[] = [];
  for (const form of ATTENDANCE_FORMS) {
    for (let k = 0; k < 2; k++) {
      const chosen = r.sample(PEOPLE, 5);
      const attendees = chosen.slice(0, k === 0 ? 2 : 3);
      const mentioned = chosen.slice(attendees.length, attendees.length + 2);
      const date = iso(baseDay(r)).slice(0, 10);
      const slug = `meetings/${date}-${form}-${k}`;
      meetings.push({
        slug, title: `Planning sync ${form} ${k}`, date, form,
        attendees: attendees.map(p => `people/${p.handle}`),
        mentioned: mentioned.map(p => `people/${p.handle}`),
        content: renderMeeting(form, date, `Planning sync ${form} ${k}`, attendees, mentioned),
      });
    }
  }

  const negative_pages: NegativePage[] = renderNegatives(r);
  const ledger: N12Ledger = { generator_version: N12_GENERATOR_VERSION, seed, conversations, people, meetings, negative_pages };
  return { ledger, fingerprint: createHash('sha256').update(JSON.stringify(ledger)).digest('hex') };
}

const link = (p: Omit<Participant, 'role'>) => `[[people/${p.handle}|${p.name}]]`;

function renderMeeting(form: AttendanceForm, date: string, title: string, attendees: Array<Omit<Participant, 'role'>>, mentioned: Array<Omit<Participant, 'role'>>): string {
  const fm = ['---', 'type: meeting', `title: ${title}`, `date: ${date}`];
  if (form === 'frontmatter-attendees') fm.push(`attendees: [${attendees.map(a => a.name).join(', ')}]`);
  fm.push('---');
  const notes = [
    '## Notes',
    '',
    `${link(mentioned[0])} will send the revised deck after the call.`,
    `We discussed the proposal from ${link(mentioned[1])} and agreed to revisit it next week.`,
  ];
  const body: string[] = [`# ${title}`, ''];
  switch (form) {
    case 'attendees-section':
      body.push('## Attendees', '', ...attendees.map(a => `- ${link(a)}`), '');
      break;
    case 'inline-attendees':
      body.push(`Attendees: ${attendees.map(link).join(', ')}`, '');
      break;
    case 'bold-attendees':
      body.push(`**Attendees:** ${attendees.map(link).join(', ')}`, '');
      break;
    case 'frontmatter-attendees':
      break;
    case 'participants-line':
      body.push(`Participants: ${attendees.map(link).join(', ')}`, '');
      break;
    case 'speakers-only':
      body.push('## Transcript', '', ...attendees.map((a, i) => `**${a.name}:** point ${i + 1} on the launch plan`), '');
      break;
  }
  return [...fm, ...body, ...notes, ''].join('\n');
}

function renderNegatives(r: Rng): NegativePage[] {
  const prose = Array.from({ length: 4 }, () => `${r.pick(OPENERS)} ${r.pick(TOPICS)} ${r.pick(CLOSERS)}. ${r.pick(SECOND_LINES)}.`).join('\n\n');
  const filler = Array.from({ length: 22 }, (_, i) => `Paragraph ${i + 1}: ${r.pick(SECOND_LINES)} and we will ${r.pick(TOPICS)} ${r.pick(CLOSERS)}.`);
  return [
    { id: 'neg-prose-note', kind: 'prose-note', body: `# Weekly note\n\n${prose}\n` },
    {
      id: 'neg-generic-json-body', kind: 'generic-json-body',
      body: JSON.stringify([
        { role: 'user', content: 'Can we review the widget launch plan?', timestamp: '2026-03-02T10:00:00Z' },
        { role: 'assistant', content: 'Yes, the plan is in the shared doc.', timestamp: '2026-03-02T10:01:00Z' },
        { role: 'user', content: 'Great, thanks.', timestamp: '2026-03-02T10:02:00Z' },
      ], null, 2),
    },
    { id: 'neg-bold-label-notes', kind: 'bold-label-notes', body: ['# Project status', '', '**Status:** green', '**Owner:** Alice Example', '**Next step:** ship the draft', '', ...filler, ''].join('\n') },
    { id: 'neg-code-doc', kind: 'code-doc', body: ['# Setup', '', 'Run the build:', '', '```sh', 'bun install', 'bun run build', '```', '', '| step | owner |', '|---|---|', '| build | Bob Example |', '| deploy | Dana Example |', ''].join('\n') },
    { id: 'neg-meeting-summary', kind: 'meeting-summary', body: ['## Summary', '', '- Pricing moves to Friday.', '- The demo build is green.', '', '## Decisions', '', '- Ship the onboarding checklist next sprint.', ''].join('\n') },
  ];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--seed');
  const seed = at >= 0 ? Number(argv[at + 1]) : N12_DEFAULT_SEED;
  const world = generateN12World({ seed });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(world, null, 2) + '\n');
  else console.log(`${N12_GENERATOR_VERSION} seed=${seed} fingerprint=${world.fingerprint} conversations=${world.ledger.conversations.length} turns=${world.ledger.conversations.reduce((n, c) => n + c.turns.length, 0)} meetings=${world.ledger.meetings.length}`);
}
