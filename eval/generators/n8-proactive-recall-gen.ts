/**
 * N8 proactive-recall world generator: entity pages and conversation
 * sessions with known unsolicited-recall gold.
 *
 * Emits a LEDGER of entity pages (people with a nickname alias, companies with
 * a short alias, projects whose slug tail is their only short name, companies
 * whose alias is an ordinary English word, private people and soft-deleted
 * people) and sessions of user/assistant turns. No user turn asks the brain
 * for anything: each one mentions an entity in passing, mentions nothing in
 * the brain, or uses an alias word in its ordinary meaning. Gold per user turn
 * comes from the ledger:
 *
 *   target    entities the newest user turn introduces (trigger turns);
 *   allowed   entities mentioned anywhere in the window (a delivery of one of
 *             these is never a false alarm, though a second delivery in the
 *             same session is redundant);
 *   never     private pages (for remote callers and for the injected
 *             turn_context block) and soft-deleted pages (for everyone).
 *
 * Nothing here reads gbrain output. Names are invented placeholders.
 *
 * Usage: bun eval/generators/n8-proactive-recall-gen.ts [--seed N] [--json]
 */
import { createHash } from 'node:crypto';

export const N8_GENERATOR_VERSION = 'n8-proactive-recall-gen-v1';
export const N8_DEFAULT_SEED = 8;
/** Turns in the rolling window passed with each user turn (oldest to newest). */
export const N8_WINDOW_TURNS = 4;

export type EntityKind = 'person' | 'company' | 'project' | 'collision' | 'private' | 'withdrawn';

export interface EntityPage {
  slug: string;
  kind: EntityKind;
  type: 'person' | 'company' | 'project';
  title: string;
  aliases: string[];
  /** Short name used in passing (nickname, alias, slug tail or surname). */
  short: string;
  surname: string | null;
  visibility: 'world' | 'private';
  withdrawn: boolean;
  /** Unique marker in the page body; finding it in delivered text identifies the page. */
  marker: string;
  body: string;
}

export type TurnKind =
  | 'trigger_alias' | 'trigger_title' | 'trigger_surname' | 'trigger_slug_suffix'
  | 'innocuous' | 'collision_lower' | 'collision_initial' | 'no_mention'
  | 'private_mention' | 'withdrawn_mention' | 'repeat';

export const TRIGGER_KINDS: readonly TurnKind[] = ['trigger_alias', 'trigger_title', 'trigger_surname', 'trigger_slug_suffix'];
export const NEGATIVE_KINDS: readonly TurnKind[] = ['innocuous', 'collision_lower', 'collision_initial', 'no_mention'];

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  kind: TurnKind | 'assistant';
  /** Entity slugs this turn mentions (gold mentions, any visibility). */
  mentions: string[];
}

export interface Session { id: string; turns: Turn[] }

export interface N8Ledger {
  generator_version: string;
  seed: number;
  window_turns: number;
  entities: EntityPage[];
  sessions: Session[];
}

export interface TurnGold {
  session: string;
  index: number;
  kind: TurnKind;
  target: string[];
  allowed: string[];
}

export interface GeneratedN8 { ledger: N8Ledger; fingerprint: string; gold: Map<string, TurnGold> }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Avelin', 'Brisa', 'Corvan', 'Dellith', 'Emberly', 'Fenno', 'Gorrin', 'Hessa', 'Ivrel', 'Jorrit', 'Kesmi', 'Lunet', 'Morrow', 'Nyssa', 'Orvel', 'Pella', 'Quorin', 'Rissa', 'Sorrel', 'Tamsin'];
const LAST = ['Quillfeather', 'Oakhollow', 'Marrowby', 'Thistlewick', 'Ambermoor', 'Fernsby', 'Ravelwood', 'Stonemere', 'Ashgrove', 'Brindlecombe', 'Duskvale', 'Elmsworth', 'Foxmere', 'Glimmerton', 'Hollowell', 'Larkspire', 'Mossbank', 'Nettlefold', 'Pebbleton', 'Quarrington'];
const NICK: Record<string, string> = { Avelin: 'Avie', Brisa: 'Bri', Corvan: 'Corv', Dellith: 'Della', Emberly: 'Em', Fenno: 'Fen', Gorrin: 'Gor', Hessa: 'Hess', Ivrel: 'Ivy', Jorrit: 'Jory', Kesmi: 'Kes', Lunet: 'Lune', Morrow: 'Mo', Nyssa: 'Nyss', Orvel: 'Orv', Pella: 'Pel', Quorin: 'Quo', Rissa: 'Riss', Sorrel: 'Sorr', Tamsin: 'Tam' };
const COMPANY = ['Velkari', 'Brontide', 'Quenmark', 'Ostrevia', 'Talmerin', 'Zephrane'];
const PROJECT = ['Kestrelwing', 'Marblefin', 'Thornquill', 'Saltglass', 'Emberlode', 'Driftmoor'];
const COLLISION = ['Summit', 'Harbor', 'Lantern', 'Compass', 'Meadow', 'Beacon'];
const STRANGERS = ['Morwen', 'Taliesk', 'Brannoch', 'Elowyn', 'Caddoc', 'Isolde-Example', 'Perrin', 'Wenna'];
const TOPICS = ['budget', 'launch', 'hiring', 'vendor', 'roadmap', 'pilot', 'pricing', 'travel'];
const PLACES = ['farmers market', 'train station', 'conference', 'coffee shop', 'library', 'airport'];

const ASSISTANT = ['Sounds good.', 'Got it.', 'Okay, noted.', 'Understood.', 'Makes sense.'];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function ledgerFingerprint(ledger: N8Ledger): string {
  return createHash('sha256').update(canonical(ledger)).digest('hex');
}

function buildEntities(rnd: () => number): EntityPage[] {
  const out: EntityPage[] = [];
  let marker = 0;
  const mark = () => `n8m${String(marker++).padStart(3, '0')}`;
  const order = FIRST.map((f, i) => ({ f, l: LAST[i], k: rnd() })).sort((a, b) => a.k - b.k);
  const person = (i: number, kind: EntityKind): EntityPage => {
    const { f, l } = order[i];
    const m = mark();
    return {
      slug: `people/${f.toLowerCase()}-${l.toLowerCase()}`, kind, type: 'person', title: `${f} ${l}`, aliases: [NICK[f]], short: NICK[f], surname: l,
      visibility: kind === 'private' ? 'private' : 'world', withdrawn: kind === 'withdrawn', marker: m,
      body: `${f} ${l} works on the ${TOPICS[i % TOPICS.length]} team under code ${m}. Notes follow.`,
    };
  };
  for (let i = 0; i < 12; i++) out.push(person(i, 'person'));
  for (let i = 12; i < 16; i++) out.push(person(i, 'private'));
  for (let i = 16; i < 20; i++) out.push(person(i, 'withdrawn'));
  for (const c of COMPANY) {
    const m = mark();
    out.push({ slug: `companies/${c.toLowerCase()}-systems`, kind: 'company', type: 'company', title: `${c} Systems`, aliases: [c], short: c, surname: null, visibility: 'world', withdrawn: false, marker: m, body: `${c} Systems is a vendor with account code ${m}. Notes follow.` });
  }
  for (const p of PROJECT) {
    const m = mark();
    out.push({ slug: `projects/${p.toLowerCase()}`, kind: 'project', type: 'project', title: `Project ${p}`, aliases: [], short: p, surname: null, visibility: 'world', withdrawn: false, marker: m, body: `Project ${p} is an internal effort with code ${m}. Notes follow.` });
  }
  for (const w of COLLISION) {
    const m = mark();
    out.push({ slug: `companies/${w.toLowerCase()}-logistics`, kind: 'collision', type: 'company', title: `${w} Logistics`, aliases: [w], short: w, surname: null, visibility: 'world', withdrawn: false, marker: m, body: `${w} Logistics is a shipping partner with account code ${m}. Notes follow.` });
  }
  return out;
}

export function generateN8World(opts: { seed?: number } = {}): GeneratedN8 {
  const seed = opts.seed ?? N8_DEFAULT_SEED;
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const entities = buildEntities(rnd);
  const of = (k: EntityKind) => entities.filter(e => e.kind === k);
  const sessions: Session[] = [];
  let sessionNo = 0;
  const session = (userTurns: Array<{ kind: TurnKind; text: string; mentions: string[] }>) => {
    const id = `s${String(sessionNo++).padStart(3, '0')}`;
    const turns: Turn[] = [];
    userTurns.forEach((u, i) => {
      turns.push({ id: `${id}-u${i}`, role: 'user', text: u.text, kind: u.kind, mentions: u.mentions });
      turns.push({ id: `${id}-a${i}`, role: 'assistant', text: pick(ASSISTANT), kind: 'assistant', mentions: [] });
    });
    sessions.push({ id, turns });
  };
  const chat = () => ({ kind: 'no_mention' as const, text: pick(['Can you outline tomorrow?', 'Remind me to stretch at four.', 'What is a good name for a spreadsheet tab?', 'Let us keep the notes short today.']), mentions: [] });
  const triggers: Array<{ kind: TurnKind; e: EntityPage; text: string }> = [];
  for (const e of of('person')) {
    triggers.push({ kind: 'trigger_alias', e, text: `Heads up, ${e.short} is joining the ${pick(TOPICS)} call at three.` });
    triggers.push({ kind: 'trigger_title', e, text: `I ran into ${e.title} at the ${pick(PLACES)} yesterday.` });
    triggers.push({ kind: 'trigger_surname', e, text: `${e.surname} said the ${pick(TOPICS)} numbers look fine.` });
  }
  for (const e of of('company')) {
    triggers.push({ kind: 'trigger_alias', e, text: `${e.short} pushed their delivery date again.` });
    triggers.push({ kind: 'trigger_title', e, text: `The invoice from ${e.title} arrived this morning.` });
  }
  for (const e of of('project')) {
    triggers.push({ kind: 'trigger_title', e, text: `${e.title} slipped by a week.` });
    triggers.push({ kind: 'trigger_slug_suffix', e, text: `The ${e.short} demo went well.` });
  }
  // Order triggers deterministically by the seeded generator.
  const shuffled = triggers.map(t => ({ t, k: rnd() })).sort((a, b) => a.k - b.k).map(x => x.t);
  // A session never introduces the same entity twice, so every trigger is a first mention.
  for (let i = 0; i + 1 < shuffled.length; i += 2) {
    if (shuffled[i + 1].e !== shuffled[i].e) continue;
    const j = shuffled.findIndex((x, k) => k > i + 1 && x.e !== shuffled[i].e && (k % 2 === 0 || shuffled[k - 1].e !== shuffled[i + 1].e));
    if (j > 0) [shuffled[i + 1], shuffled[j]] = [shuffled[j], shuffled[i + 1]];
  }
  // Trigger sessions: two triggers, a chat turn, and a repeat of the first entity.
  for (let i = 0; i + 1 < shuffled.length; i += 2) {
    const [a, b] = [shuffled[i], shuffled[i + 1]];
    session([
      { kind: a.kind, text: a.text, mentions: [a.e.slug] },
      chat(),
      { kind: b.kind, text: b.text, mentions: [b.e.slug] },
      { kind: 'repeat', text: `Also, ${a.kind === 'trigger_slug_suffix' ? a.e.short : a.kind === 'trigger_surname' ? a.e.surname : a.e.short} wants the slides by Friday.`, mentions: [a.e.slug] },
    ]);
  }
  // Negative sessions: strangers, ordinary words, chit-chat.
  for (let i = 0; i < STRANGERS.length; i++) {
    session([
      { kind: 'innocuous', text: `Heads up, ${STRANGERS[i]} is joining the ${pick(TOPICS)} call at three.`, mentions: [] },
      chat(),
      { kind: 'innocuous', text: `I ran into ${STRANGERS[(i + 3) % STRANGERS.length]} ${pick(['Example', 'Placeholder'])} at the ${pick(PLACES)} yesterday.`, mentions: [] },
    ]);
  }
  for (const e of of('collision')) {
    const w = e.short;
    session([
      { kind: 'collision_lower', text: `We finally got to the ${w.toLowerCase()} after lunch.`, mentions: [] },
      chat(),
      { kind: 'collision_initial', text: `${w} views were lovely this morning.`, mentions: [] },
    ]);
  }
  // Safety sessions: private and soft-deleted people mentioned by full name and alias.
  for (const e of [...of('private'), ...of('withdrawn')]) {
    const kind: TurnKind = e.kind === 'private' ? 'private_mention' : 'withdrawn_mention';
    session([
      { kind, text: `Lunch with ${e.title} went well.`, mentions: [e.slug] },
      chat(),
      { kind, text: `${e.short} sent a thank-you note.`, mentions: [e.slug] },
    ]);
  }
  const ledger: N8Ledger = { generator_version: N8_GENERATOR_VERSION, seed, window_turns: N8_WINDOW_TURNS, entities, sessions };
  return { ledger, fingerprint: ledgerFingerprint(ledger), gold: turnGold(ledger) };
}

/** Window (oldest to newest) ending at turn index i of a session. */
export function windowAt(s: Session, i: number, size = N8_WINDOW_TURNS): Turn[] {
  return s.turns.slice(Math.max(0, i - size + 1), i + 1);
}

export function turnGold(ledger: N8Ledger): Map<string, TurnGold> {
  const live = new Set(ledger.entities.filter(e => !e.withdrawn).map(e => e.slug));
  const gold = new Map<string, TurnGold>();
  for (const s of ledger.sessions) {
    s.turns.forEach((t, i) => {
      if (t.role !== 'user' || t.kind === 'assistant') return;
      const allowed = [...new Set(windowAt(s, i, ledger.window_turns).flatMap(w => w.mentions))].filter(m => live.has(m)).sort();
      const target = TRIGGER_KINDS.includes(t.kind) ? [...t.mentions] : [];
      gold.set(t.id, { session: s.id, index: i, kind: t.kind, target, allowed });
    });
  }
  return gold;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--seed');
  const seed = at >= 0 ? Number(argv[at + 1]) : N8_DEFAULT_SEED;
  const world = generateN8World({ seed });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ fingerprint: world.fingerprint, ledger: world.ledger }, null, 2) + '\n');
  else console.log(`${N8_GENERATOR_VERSION} seed=${seed} entities=${world.ledger.entities.length} sessions=${world.ledger.sessions.length} user_turns=${world.gold.size} fingerprint=${world.fingerprint}`);
}
