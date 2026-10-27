/**
 * N14 large-page fidelity: seeded generator for very large single documents.
 *
 * Three fictional document kinds, all Markdown:
 *   conversation  an iMessage-style group chat in the imessage-slack line shape
 *                 `**Name** (YYYY-MM-DD h:mm AM): text` under `## YYYY-MM-DD`
 *                 day headers, at 2 MB, 20 MB, 200 MB or 1 GB;
 *   project-log   a long markdown project log, one `## YYYY-MM-DD` entry per
 *                 day with `### Standup` / `### Notes` subsections;
 *   book          a book-length novel, `## Chapter N: Title` sections of prose.
 *
 * Every document carries planted needles: four per decile of its byte length
 * (a number, a date, a person's surname and a colour fact), each a sentence of
 * the form "the <Anchor> <noun> is <answer>". The anchor is an invented place
 * name that occurs nowhere else, so a keyword query for "<Anchor> <noun>" has
 * exactly one right passage. Every needle has a distractor five deciles away:
 * the same sentence with one detail changed (the place name, which carries its
 * own value), so a system that confuses near-duplicates is visible.
 *
 * The ledger records each needle's answer, its UTF-8 byte offset, its decile
 * and the section that holds it, plus the document's byte length and sha256.
 * Gold comes from the ledger, never from gbrain. `checkPresence` is the
 * independent oracle: it rescans the raw bytes and proves every answer and
 * anchor occurs exactly once, at the recorded offset, in the recorded decile.
 *
 * Fictional names only: participants, characters and surnames are invented.
 *
 * The generator streams: `generateDocument` hands pieces to a sink, so a 1 GB
 * document never needs one JavaScript string. `renderDocument` collects the
 * pieces for the small sizes tests use.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { Rng, addDays, fingerprint } from './seeded.ts';

export const N14_GENERATOR_VERSION = 'n14-large-page-gen/v1';
export const N14_DEFAULT_SEED = 14;

export type DocKind = 'conversation' | 'project-log' | 'book';
export type NeedleType = 'number' | 'date' | 'name' | 'fact';
export const NEEDLE_TYPES: readonly NeedleType[] = ['number', 'date', 'name', 'fact'];
export const DECILES = 10;

/**
 * Size tiers. `1gb` is listed for manual runs only. The binary tiers
 * (Amendment 4) sit on gbrain's page limits: `24mib` just under the 24 MiB
 * single-call write ceiling, `128mib` and `256mib` just under the PGLite and
 * Postgres segmented page ceilings, `260mib` just over the Postgres one.
 */
export const TIERS = {
  '2mb': { conversation: 2_000_000, 'project-log': 2_000_000, book: 1_500_000 },
  '20mb': { conversation: 20_000_000 },
  '24mib': { conversation: 25_100_288 },
  '100mib': { conversation: 104_857_600 },
  '128mib': { conversation: 134_152_192 },
  '200mb': { conversation: 200_000_000 },
  '256mib': { conversation: 268_369_920 },
  '260mib': { conversation: 272_629_760 },
  '1gb': { conversation: 1_000_000_000 },
} as const satisfies Record<string, Partial<Record<DocKind, number>>>;
export type TierId = keyof typeof TIERS;
export const TIER_IDS = Object.keys(TIERS) as TierId[];

export interface DocSpec { kind: DocKind; target_bytes: number; seed: number }

export interface PlantedFact {
  anchor: string;
  noun: string;
  answer: string;
  /** The planted sentence (without speaker or bullet decoration). */
  sentence: string;
  /** UTF-8 byte offset of `answer` in the document. */
  byte_offset: number;
  decile: number;
  /** Key of the `## ` section holding it (a date or `chapter-NN`). */
  section: string;
}

export interface Needle extends PlantedFact {
  id: string;
  type: NeedleType;
  /** Keyword query: anchor plus noun. */
  query: string;
  /** Natural-language question for the paid agent QA arm. */
  question: string;
  distractor: PlantedFact;
}

export interface Section { key: string; heading: string; byte_start: number; byte_end: number }

export interface AppendPlan {
  /** Exactly what is appended to the end of the document (about 1 KB). */
  text: string;
  bytes: number;
  sha256: string;
  section: string;
  needle: Omit<Needle, 'distractor' | 'decile' | 'byte_offset'> & { byte_offset_in_append: number };
}

export interface ControlPage {
  slug: string;
  content: string;
  sha256: string;
  needles: Array<Omit<Needle, 'distractor' | 'decile'>>;
}

export interface N14DocLedger {
  id: string;
  kind: DocKind;
  seed: number;
  slug: string;
  title: string;
  page_type: string;
  target_bytes: number;
  bytes: number;
  lines: number;
  sha256: string;
  /** Byte length of the frontmatter block; the body starts here. */
  body_offset: number;
  body_sha256: string;
  sections: Section[];
  needles: Needle[];
  append: AppendPlan;
  control: ControlPage;
}

// ─── Vocabulary (fictional, checked disjoint from anchors and answers) ───

const PEOPLE = ['Rowan Vale', 'Imogen Pell', 'Casimir Holt', 'Juniper Ashdown'] as const;
const LOG_OWNERS = ['Tamsin Rook', 'Ezra Quill', 'Noor Halvard', 'Bram Okonkwo-Lisle'] as const;
const CHARACTERS = ['Odile', 'Bartholomew', 'Wren', 'Magistrate Corvin', 'the ferryman', 'Aunt Lusa'] as const;
const FIRST_NAMES = ['Thessaly', 'Ivo', 'Marisol', 'Cormac', 'Ysolde', 'Anselm', 'Petra', 'Lucan', 'Delphine', 'Oswin'] as const;

const FILLER = (
  'the a and to of in on for with at by from about after before over under into out up down off then than so but or if when while because '
  + 'today tomorrow tonight morning evening later soon maybe probably definitely really pretty quite just still already again also even '
  + 'coffee tea lunch dinner breakfast train bus walk park market garden kitchen window door street corner bakery library office studio '
  + 'plan meeting call message photo picture song movie book podcast weekend holiday trip ticket bag jacket umbrella bike car rain sun wind '
  + 'good great fine nice lovely busy tired happy sorry funny weird quiet loud early late long short warm cold new old big small '
  + 'think know feel want need like love see look hear say tell ask bring take make get go come leave stay wait try start finish '
  + 'yes no okay sure thanks please haha lol wow hmm right exactly honestly basically anyway apparently'
).split(' ');
const UNICODE_WORDS = ['café', 'naïve', 'jalapeño', 'crème', 'über', 'Zoë', 'façade', 'smörgåsbord', '🙂', '👍', '☕', '🌧️', '日曜日', 'déjà'] as const;
const LOG_WORDS = (
  'deploy review ticket build pipeline staging release migration schema dashboard alert latency queue worker cache index backup rollout '
  + 'patch fix test flaky retry config secret rotation incident postmortem standup sprint roadmap estimate scope blocker dependency vendor '
  + 'ferry dock timetable crossing harbor manifest berth captain crew deck engine fuel route passenger'
).split(' ');
const PROSE_WORDS = (
  'orchard salt lantern river hill road house room table letter candle shadow light morning night winter summer field stone bridge tower '
  + 'remembered whispered walked turned waited listened opened closed carried watched wondered believed feared promised answered '
  + 'quietly slowly suddenly softly carefully again never always almost perhaps'
).split(' ');
const CHAPTER_TITLES = ['The Ferry', 'Salt and Lanterns', 'A Letter Unopened', 'Winter Orchard', 'The Magistrate', 'Low Tide', 'The Bell Tower', 'Ash on the Road', 'What Wren Saw', 'The Last Crossing'] as const;

const PREFIXES = ['Brack', 'Quill', 'Thorn', 'Wyck', 'Ember', 'Hollow', 'Marl', 'Fenn', 'Cobb', 'Vell', 'Drum', 'Orrin', 'Sorrel', 'Tamsk', 'Yarrow', 'Kest', 'Lunt', 'Morrow', 'Grisk', 'Halv', 'Ombr', 'Pyke', 'Rusk', 'Skarl'] as const;
const SUFFIXES = ['ford', 'mere', 'wick', 'stead', 'holm', 'combe', 'gate', 'thorpe', 'ridge', 'haven', 'moor', 'dale'] as const;

const NOUNS: Record<NeedleType, readonly string[]> = {
  number: ['locker code', 'gate code', 'storage unit number', 'ferry ticket number', 'badge number'],
  date: ['lease start', 'kiln firing', 'permit renewal', 'choir recital', 'harbor inspection'],
  name: ['beekeeper', 'harbor pilot', 'clockmaker', 'archivist', 'locksmith'],
  fact: ['boathouse', 'tram', 'lighthouse', 'greenhouse', 'footbridge'],
};
const SURNAMES = ['Ombrecourt', 'Thistlewaite', 'Quarrington', 'Vasquell', 'Hollinrake', 'Brennagh', 'Castellow', 'Dunmorrow', 'Everleigh', 'Fairweld', 'Garrowby', 'Hesketh', 'Inchbald', 'Jerrold', 'Kilbride', 'Larkhall', 'Merriweather', 'Nethercott', 'Ormsley', 'Penhallow', 'Quested', 'Rathbone', 'Stallybrass', 'Tregarthen', 'Underhay', 'Venning', 'Wolstenholme', 'Yelverton', 'Zouche', 'Abernethy', 'Blenkinsop', 'Coldridge', 'Dalrymple', 'Etherington', 'Featherstonhaugh', 'Gisborne', 'Haverstock', 'Illingworth', 'Jagoe', 'Kitteringham', 'Loveridge', 'Mortlock', 'Nankivell', 'Osgathorpe'] as const;
const COLOURS = ['vermilion', 'chartreuse', 'cerulean', 'ochre', 'mauve', 'saffron', 'russet', 'viridian', 'carmine', 'sienna', 'periwinkle', 'celadon', 'gamboge', 'puce', 'fuchsia', 'cinnabar', 'taupe', 'heliotrope', 'zaffre', 'smalt', 'glaucous', 'wenge', 'sarcoline', 'coquelicot', 'falu', 'mikado', 'skobeloff', 'bistre', 'amaranth', 'aureolin', 'byzantium', 'cattleya', 'eburnean', 'feldgrau', 'glaucine', 'incarnadine', 'jasper', 'kobicha', 'liseran', 'malachite', 'nacarat', 'orpiment'] as const;

const TITLES: Record<DocKind, { title: string; slug: string; page_type: string }> = {
  conversation: { title: 'Group chat: Rowan, Imogen, Casimir and Juniper', slug: 'conversations/rowan-imogen-casimir-juniper', page_type: 'imessage' },
  'project-log': { title: 'Halcyon Ferry project log', slug: 'projects/halcyon-ferry-log', page_type: 'project' },
  book: { title: 'The Salt Orchard', slug: 'books/the-salt-orchard', page_type: 'book' },
};

// ─── Answer allocation ───────────────────────────────────────────────────

/** Hands out unique anchors and answers for one document (doc + control + append). */
class Allocator {
  readonly #rng: Rng;
  readonly #anchors: Array<{ prefix: string; suffixes: string[] }>;
  #anchorAt = 0;
  readonly #used = new Set<string>();
  #surnames: string[];
  #colours: string[];
  constructor(rng: Rng) {
    this.#rng = rng;
    // Each prefix yields anchor pairs that share it: needle (suffix 2k) and distractor (suffix 2k+1).
    const prefixes = rng.shuffle(PREFIXES);
    const suffixes = rng.shuffle(SUFFIXES);
    this.#anchors = [];
    for (let k = 0; k < suffixes.length / 2; k++) for (const prefix of prefixes) this.#anchors.push({ prefix, suffixes: [suffixes[2 * k], suffixes[2 * k + 1]] });
    this.#surnames = rng.shuffle(SURNAMES);
    this.#colours = rng.shuffle(COLOURS);
  }
  anchorPair(): [string, string] {
    const a = this.#anchors[this.#anchorAt++];
    if (!a) throw new Error('n14 generator: anchor pool exhausted');
    return [a.prefix + a.suffixes[0], a.prefix + a.suffixes[1]];
  }
  #fresh(make: () => string): string {
    for (let i = 0; i < 1000; i++) { const v = make(); if (!this.#used.has(v)) { this.#used.add(v); return v; } }
    throw new Error('n14 generator: could not allocate a fresh answer');
  }
  answerPair(type: NeedleType): [string, string] {
    const rng = this.#rng;
    if (type === 'number') {
      const a = this.#fresh(() => String(rng.int(30000, 89999)));
      // One detail: swap two different adjacent digits, else bump the last digit.
      const d = a.split('');
      const i = d.findIndex((c, j) => j < d.length - 1 && c !== d[j + 1]);
      const swapped = i >= 0 ? [...d.slice(0, i), d[i + 1], d[i], ...d.slice(i + 2)].join('') : a.slice(0, -1) + String((Number(a.at(-1)) + 1) % 10);
      const b = this.#used.has(swapped) ? this.#fresh(() => String(rng.int(30000, 89999))) : (this.#used.add(swapped), swapped);
      return [a, b];
    }
    if (type === 'date') {
      const a = this.#fresh(() => addDays('2041-01-01', rng.int(0, 365 * 25)));
      let b = addDays(a, 1);
      if (this.#used.has(b)) b = this.#fresh(() => addDays('2041-01-01', rng.int(0, 365 * 25)));
      else this.#used.add(b);
      return [a, b];
    }
    const pool = type === 'name' ? this.#surnames : this.#colours;
    const a = pool.pop();
    const b = pool.pop();
    if (!a || !b) throw new Error(`n14 generator: ${type} answer pool exhausted`);
    this.#used.add(a);
    this.#used.add(b);
    return [a, b];
  }
}

function sentence(type: NeedleType, anchor: string, noun: string, answer: string, rng: Rng): string {
  switch (type) {
    case 'number': return `the ${anchor} ${noun} is ${answer}`;
    case 'date': return `the ${anchor} ${noun} is set for ${answer}`;
    case 'name': return `the ${anchor} ${noun} is ${rng.pick(FIRST_NAMES)} ${answer}`;
    case 'fact': return `the ${anchor} ${noun} is painted ${answer}`;
  }
}

function question(type: NeedleType, anchor: string, noun: string): string {
  switch (type) {
    case 'number': return `What is the ${anchor} ${noun}?`;
    case 'date': return `What date is the ${anchor} ${noun} set for?`;
    case 'name': return `What is the surname of the ${anchor} ${noun}?`;
    case 'fact': return `What colour is the ${anchor} ${noun} painted?`;
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────

/** Days for a conversation or log of this size: 365 at 2 MB, growing sublinearly, capped at ten years. */
export function plannedDays(targetBytes: number): number {
  return Math.max(30, Math.min(3650, Math.round(365 * Math.pow(targetBytes / 2_000_000, 0.45))));
}
const CHAPTER_BYTES = 37_000;

function clock(i: number, perDay: number): string {
  const minutes = 7 * 60 + Math.floor((i * (16 * 60 + 59)) / Math.max(1, perDay));
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

function words(rng: Rng, vocab: readonly string[], lo: number, hi: number, unicodeRate: number): string {
  const n = rng.int(lo, hi);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(rng.float() < unicodeRate ? rng.pick(UNICODE_WORDS) : rng.pick(vocab));
  return out.join(' ');
}

interface Planned { type: NeedleType; decile: number; target: number; distractor: boolean; index: number }

type Sink = (piece: string) => void;

const TEMPLATE_INTRO = ['fyi', 'reminder:', 'ok so', 'just checked,', 'noting here that', 'for the record'];

function frontmatter(kind: DocKind): string {
  const t = TITLES[kind];
  return `---\ntype: ${t.page_type}\ntitle: ${JSON.stringify(t.title)}\n---\n`;
}

/**
 * Stream one document into `sink` and return its ledger. Deterministic in
 * (kind, target_bytes, seed).
 */
export function generateDocument(spec: DocSpec, sink: Sink): N14DocLedger {
  const rng = new Rng(spec.seed * 1_000_003 + ({ conversation: 1, 'project-log': 2, book: 3 } as const)[spec.kind]);
  const alloc = new Allocator(rng);
  const hash = createHash('sha256');
  const bodyHash = createHash('sha256');
  let bytes = 0;
  let lines = 0;
  let inBody = false;
  const emit = (piece: string) => {
    sink(piece);
    hash.update(piece);
    if (inBody) bodyHash.update(piece);
    bytes += Buffer.byteLength(piece);
    for (let i = piece.indexOf('\n'); i >= 0; i = piece.indexOf('\n', i + 1)) lines++;
  };
  const t = TITLES[spec.kind];
  emit(frontmatter(spec.kind));
  const bodyOffset = bytes;
  inBody = true;
  const preamble = spec.kind === 'conversation'
    ? `\n# ${t.title}\n\nExported group chat, one section per day.\n\n`
    : spec.kind === 'project-log' ? `\n# ${t.title}\n\nRunning log kept by the Halcyon Ferry team, one entry per working day.\n\n`
      : `\n# ${t.title}\n\nA novel. All characters and places are invented.\n\n`;
  emit(preamble);

  // Plan needle and distractor targets: 4 per decile, spread inside the middle 70% of each decile.
  const target = spec.target_bytes;
  const planned: Planned[] = [];
  let index = 0;
  for (let d = 0; d < DECILES; d++) {
    const order = rng.shuffle(NEEDLE_TYPES);
    order.forEach((type, slot) => {
      const frac = (d + 0.15 + 0.7 * ((slot + 0.1 + 0.8 * rng.float()) / NEEDLE_TYPES.length)) / DECILES;
      planned.push({ type, decile: d, target: Math.floor(frac * target), distractor: false, index: index++ });
    });
  }
  for (const p of [...planned]) {
    const dd = (p.decile + 5) % DECILES;
    const frac = (dd + 0.15 + 0.7 * rng.float()) / DECILES;
    planned.push({ ...p, decile: dd, target: Math.floor(frac * target), distractor: true });
  }
  // Answers and anchors, allocated per needle index.
  const facts = new Map<number, { type: NeedleType; anchors: [string, string]; answers: [string, string]; noun: string; sentences: [string, string] }>();
  for (const p of planned.filter(x => !x.distractor)) {
    const anchors = alloc.anchorPair();
    const answers = alloc.answerPair(p.type);
    const noun = rng.pick(NOUNS[p.type]);
    facts.set(p.index, { type: p.type, anchors, answers, noun, sentences: [sentence(p.type, anchors[0], noun, answers[0], rng), sentence(p.type, anchors[1], noun, answers[1], rng)] });
  }
  const queue = planned.sort((a, b) => a.target - b.target || a.index - b.index);
  let q = 0;
  const placed = new Map<string, PlantedFact>();

  const sections: Section[] = [];
  const openSection = (key: string, heading: string) => {
    if (sections.length) sections[sections.length - 1].byte_end = bytes;
    sections.push({ key, heading, byte_start: bytes, byte_end: bytes });
  };
  const section = () => sections[sections.length - 1].key;
  /** Emit `piece` containing `answer`; record where the answer landed. */
  const plant = (p: Planned, prefix: string, s: string, after: string) => {
    const f = facts.get(p.index)!;
    const k = p.distractor ? 1 : 0;
    const before = bytes + Buffer.byteLength(prefix) + Buffer.byteLength(s.slice(0, s.lastIndexOf(f.answers[k])));
    emit(prefix + s + after);
    placed.set(`${p.index}:${k}`, { anchor: f.anchors[k], noun: f.noun, answer: f.answers[k], sentence: s, byte_offset: before, decile: -1, section: section() });
  };
  const due = () => q < queue.length && queue[q].target <= bytes;

  if (spec.kind === 'book') {
    const chapters = Math.max(10, Math.round(target / CHAPTER_BYTES));
    for (let c = 1; bytes < target || q < queue.length; c++) {
      const key = `chapter-${String(c).padStart(3, '0')}`;
      const heading = `## Chapter ${c}: ${CHAPTER_TITLES[(c - 1) % CHAPTER_TITLES.length]}`;
      openSection(key, heading);
      emit(`${heading}\n\n`);
      const chapterEnd = Math.min(target, bodyOffset + (c * (target - bodyOffset)) / chapters);
      while ((bytes < chapterEnd || (c >= chapters && q < queue.length))) {
        const n = rng.int(4, 9);
        let para = '';
        for (let i = 0; i < n; i++) {
          if (due()) {
            const p = queue[q++];
            const f = facts.get(p.index)!;
            const s = f.sentences[p.distractor ? 1 : 0];
            const who = rng.pick(CHARACTERS);
            const prefix = para + `${who.charAt(0).toUpperCase() + who.slice(1)} remembered that `;
            plant(p, prefix, s, '. ');
            para = '';
            continue;
          }
          const w = words(rng, PROSE_WORDS, 8, 22, 0.01);
          para += `${w.charAt(0).toUpperCase() + w.slice(1)}. `;
        }
        emit(para.trimEnd() + '\n\n');
        if (c >= chapters && bytes >= target && q >= queue.length) break;
      }
    }
  } else {
    const days = plannedDays(target);
    const perDay = (target - bodyOffset) / days;
    const start = spec.kind === 'conversation' ? '2017-01-02' : '2018-03-05';
    for (let d = 0; bytes < target || q < queue.length; d++) {
      const day = addDays(start, d);
      openSection(day, `## ${day}`);
      emit(`## ${day}\n\n`);
      const dayEnd = bodyOffset + (d + 1) * perDay;
      if (spec.kind === 'conversation') {
        const perDayMsgs = Math.max(4, Math.round(perDay / 85));
        let i = 0;
        while (bytes < dayEnd || (bytes >= target && q < queue.length && i === 0)) {
          const who = PEOPLE[rng.int(0, PEOPLE.length - 1)];
          const prefix = `**${who}** (${day} ${clock(i, perDayMsgs)}): `;
          if (due()) {
            const p = queue[q++];
            const s = facts.get(p.index)!.sentences[p.distractor ? 1 : 0];
            plant(p, prefix + `${rng.pick(TEMPLATE_INTRO)} `, s, '\n');
          } else {
            emit(`${prefix}${words(rng, FILLER, 3, 20, 0.02)}\n`);
          }
          i++;
          if (bytes >= target && q >= queue.length) break;
        }
      } else {
        const owners = rng.shuffle(LOG_OWNERS);
        let block = 0;
        while (bytes < dayEnd || (bytes >= target && q < queue.length && block === 0)) {
          emit(block % 2 === 0 ? '### Standup\n\n' : '### Notes\n\n');
          const n = rng.int(3, 8);
          for (let i = 0; i < n; i++) {
            const prefix = `- **${owners[i % owners.length]}**: `;
            if (due()) {
              const p = queue[q++];
              const s = facts.get(p.index)!.sentences[p.distractor ? 1 : 0];
              plant(p, prefix + 'noting that ', s, '.\n');
            } else {
              emit(`${prefix}${words(rng, LOG_WORDS, 6, 24, 0.01)}.\n`);
            }
          }
          emit('\n');
          block++;
          if (bytes >= target && q >= queue.length) break;
        }
      }
      if (spec.kind === 'conversation') emit('\n');
    }
  }
  sections[sections.length - 1].byte_end = bytes;

  const decileOf = (offset: number) => Math.min(DECILES - 1, Math.floor((offset / bytes) * DECILES));
  const needles: Needle[] = [];
  for (const p of planned.filter(x => !x.distractor).sort((a, b) => a.index - b.index)) {
    const f = facts.get(p.index)!;
    const n = placed.get(`${p.index}:0`)!;
    const dx = placed.get(`${p.index}:1`)!;
    needles.push({
      ...n, decile: decileOf(n.byte_offset),
      id: `${spec.kind}:d${p.decile}:${p.type}`, type: p.type, query: `${f.anchors[0]} ${f.noun}`, question: question(p.type, f.anchors[0], f.noun),
      distractor: { ...dx, decile: decileOf(dx.byte_offset) },
    });
  }

  // The 1 KB append: a new section after the last one, with its own needle.
  const lastKey = sections[sections.length - 1].key;
  const [appendAnchor] = alloc.anchorPair();
  const [appendAnswer] = alloc.answerPair('number');
  const appendNoun = rng.pick(NOUNS.number);
  const appendSentence = sentence('number', appendAnchor, appendNoun, appendAnswer, rng);
  const appendKey = spec.kind === 'book' ? `chapter-${String(Number(lastKey.slice(8)) + 1).padStart(3, '0')}` : addDays(lastKey, 1);
  const appendLines: string[] = [];
  if (spec.kind === 'book') {
    appendLines.push(`## Chapter ${Number(lastKey.slice(8)) + 1}: Afterword`, '');
    while (appendLines.join('\n').length < 900) appendLines.push(`${words(rng, PROSE_WORDS, 10, 18, 0)}.`);
    appendLines.push(`Odile remembered that ${appendSentence}.`, '');
  } else if (spec.kind === 'project-log') {
    appendLines.push(`## ${appendKey}`, '', '### Standup', '');
    while (appendLines.join('\n').length < 900) appendLines.push(`- **${LOG_OWNERS[0]}**: ${words(rng, LOG_WORDS, 8, 16, 0)}.`);
    appendLines.push(`- **${LOG_OWNERS[1]}**: noting that ${appendSentence}.`, '');
  } else {
    appendLines.push(`## ${appendKey}`, '');
    let i = 0;
    while (appendLines.join('\n').length < 900) appendLines.push(`**${PEOPLE[i % PEOPLE.length]}** (${appendKey} ${clock(i++, 12)}): ${words(rng, FILLER, 6, 14, 0)}`);
    appendLines.push(`**${PEOPLE[1]}** (${appendKey} ${clock(i, 12)}): fyi ${appendSentence}`, '');
  }
  const appendText = appendLines.join('\n') + '\n';
  const appendQuery = `${appendAnchor} ${appendNoun}`;

  // Control page: a small page with one needle per type, ingested into every arm's brain.
  const controlNeedles: ControlPage['needles'] = [];
  const controlLines = ['---', 'type: note', 'title: N14 control notes', '---', '', '# N14 control notes', ''];
  for (const type of NEEDLE_TYPES) {
    const [anchor] = alloc.anchorPair();
    const [answer] = alloc.answerPair(type);
    const noun = rng.pick(NOUNS[type]);
    const s = sentence(type, anchor, noun, answer, rng);
    for (let i = 0; i < 12; i++) controlLines.push(words(rng, FILLER, 8, 20, 0) + '.');
    controlLines.push(`Noted: ${s}.`, '');
    controlNeedles.push({ id: `control:${type}`, type, anchor, noun, answer, sentence: s, byte_offset: -1, section: 'control', query: `${anchor} ${noun}`, question: question(type, anchor, noun) });
  }
  const controlContent = controlLines.join('\n') + '\n';
  for (const n of controlNeedles) n.byte_offset = Buffer.from(controlContent).indexOf(Buffer.from(n.answer));

  return {
    id: spec.kind, kind: spec.kind, seed: spec.seed, slug: t.slug, title: t.title, page_type: t.page_type,
    target_bytes: spec.target_bytes, bytes, lines, sha256: hash.digest('hex'), body_offset: bodyOffset, body_sha256: bodyHash.digest('hex'),
    sections, needles,
    append: {
      text: appendText, bytes: Buffer.byteLength(appendText), sha256: createHash('sha256').update(appendText).digest('hex'), section: appendKey,
      needle: { id: `${spec.kind}:append:number`, type: 'number', anchor: appendAnchor, noun: appendNoun, answer: appendAnswer, sentence: appendSentence, section: appendKey, query: appendQuery, question: question('number', appendAnchor, appendNoun), byte_offset_in_append: Buffer.from(appendText).indexOf(Buffer.from(appendAnswer)) },
    },
    control: { slug: 'notes/n14-control', content: controlContent, sha256: createHash('sha256').update(controlContent).digest('hex'), needles: controlNeedles },
  };
}

/** Render a document to one string (small sizes and tests). */
export function renderDocument(spec: DocSpec): { text: string; ledger: N14DocLedger } {
  const parts: string[] = [];
  const ledger = generateDocument(spec, p => parts.push(p));
  return { text: parts.join(''), ledger };
}

/** Stream a document to a file in 1 MB writes; returns the ledger. */
export function writeDocument(spec: DocSpec, path: string): N14DocLedger {
  const fd = openSync(path, 'w');
  let buf: string[] = [];
  let pending = 0;
  try {
    const ledger = generateDocument(spec, p => {
      buf.push(p);
      pending += p.length;
      if (pending >= 1 << 20) { writeSync(fd, buf.join('')); buf = []; pending = 0; }
    });
    if (buf.length) writeSync(fd, buf.join(''));
    return ledger;
  } finally {
    closeSync(fd);
  }
}

/** The ledger fingerprint: sha256 of its canonical JSON (covers the document sha256). */
export function ledgerFingerprint(docs: readonly N14DocLedger[]): string {
  return fingerprint({ generator: N14_GENERATOR_VERSION, docs });
}

export function tierSpecs(tier: TierId, seed: number): DocSpec[] {
  return Object.entries(TIERS[tier]).map(([kind, target_bytes]) => ({ kind: kind as DocKind, target_bytes, seed }));
}

// ─── Independent oracle ──────────────────────────────────────────────────

export interface PresenceCheck { name: string; expected: number | string; actual: number | string; ok: boolean }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-token occurrences of `token` (letters, digits and hyphens are token characters). */
export function tokenOccurrences(text: string, token: string): number {
  return (text.match(new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRe(token)}(?![\\p{L}\\p{N}-])`, 'gu')) ?? []).length;
}
/** True when `text` holds `token` as a whole token. */
export function containsToken(text: string, token: string): boolean {
  return tokenOccurrences(text, token) > 0;
}

/**
 * Re-derive every gold fact from the raw bytes, without the generator's
 * bookkeeping: hash, per-needle uniqueness, offsets and deciles, the append
 * plan and the control page.
 */
export function checkPresence(raw: Buffer, ledger: N14DocLedger): PresenceCheck[] {
  const checks: PresenceCheck[] = [];
  const check = (name: string, expected: number | string, actual: number | string) => checks.push({ name, expected, actual, ok: expected === actual });
  check(`${ledger.id}: sha256`, ledger.sha256, createHash('sha256').update(raw).digest('hex'));
  check(`${ledger.id}: bytes`, ledger.bytes, raw.length);
  const text = raw.toString('utf8');
  const perDecile = new Array(DECILES).fill(0);
  let badNeedles = 0;
  const problems: string[] = [];
  for (const n of ledger.needles) {
    for (const [label, f] of [['needle', n], ['distractor', n.distractor]] as const) {
      const answerCount = tokenOccurrences(text, f.answer);
      const anchorCount = tokenOccurrences(text, f.anchor);
      const atOffset = raw.subarray(f.byte_offset, f.byte_offset + Buffer.byteLength(f.answer)).toString('utf8') === f.answer;
      const decile = Math.min(DECILES - 1, Math.floor((f.byte_offset / raw.length) * DECILES));
      const sectionOk = ledger.sections.some(s => s.key === f.section && s.byte_start <= f.byte_offset && f.byte_offset < s.byte_end);
      if (answerCount !== 1 || anchorCount !== 1 || !atOffset || decile !== f.decile || !sectionOk) {
        badNeedles++;
        problems.push(`${n.id} ${label}: answer x${answerCount}, anchor x${anchorCount}, at_offset=${atOffset}, decile ${decile} vs ${f.decile}, section_ok=${sectionOk}`);
      }
    }
    perDecile[n.decile]++;
  }
  check(`${ledger.id}: needles and distractors unique, at their offsets, deciles and sections`, 0, badNeedles);
  if (problems.length) checks[checks.length - 1].actual = `${badNeedles}: ${problems.slice(0, 3).join('; ')}`;
  check(`${ledger.id}: four needles in every decile`, DECILES * NEEDLE_TYPES.length, perDecile.filter(c => c === NEEDLE_TYPES.length).length * NEEDLE_TYPES.length);
  const app = ledger.append;
  check(`${ledger.id}: append needle absent from the document`, 0, tokenOccurrences(text, app.needle.answer) + tokenOccurrences(text, app.needle.anchor));
  check(`${ledger.id}: append needle once in the append`, 1, tokenOccurrences(app.text, app.needle.answer));
  check(`${ledger.id}: append is about 1 KB`, 'yes', app.bytes >= 900 && app.bytes <= 1400 ? 'yes' : String(app.bytes));
  let controlBad = 0;
  for (const c of ledger.control.needles) {
    if (tokenOccurrences(ledger.control.content, c.answer) !== 1 || tokenOccurrences(text, c.answer) !== 0 || tokenOccurrences(text, c.anchor) !== 0) controlBad++;
  }
  check(`${ledger.id}: control needles unique and absent from the document`, 0, controlBad);
  return checks;
}
