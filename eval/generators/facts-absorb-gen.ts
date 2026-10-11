/**
 * Facts-absorb world: dated chat sessions about fictional people and
 * companies, written as `note` pages, with an answer key of the facts each
 * page states. It follows the N1 knowledge-update ledger (value chains that
 * change over time, reverts and corrections, the same city and employer
 * pools and the same seeded PRNG) and renders it as conversation instead of
 * Facts fences, because the background facts extractor reads prose.
 *
 * Every planted claim carries a value token (a city, an employer, a hobby,
 * an allergy, a venue or an amount) and an entity (a person's first name or
 * a company name), unique within the world, so a scorer can match extracted
 * facts to claims without a model:
 *
 *   user        the user states a person's city, employer, hobby or allergy,
 *               or a company's monthly MRR, burn or headcount;
 *   third       the user relays a named third party's claim ("Rowan told me
 *               Gammaline's March MRR was $61,000"); the fact must keep the
 *               third party's name;
 *   assistant   the assistant recommends a venue or a vendor; the fact must
 *               be attributed to the assistant;
 *   self-fix    the user states a wrong value and corrects it in the same
 *               turn; the corrected value is the claim, the retracted value
 *               must not be stored as a current claim;
 *   metric-fix  a later session corrects an amount stated in an earlier one;
 *               the corrected amount is the claim, the old amount must not be
 *               restated as current.
 *
 * Two kinds of planted text are not claims: a rejected suggestion (the
 * assistant proposes a job or a move, the user refuses; no fact may say the
 * person took it unless it says the assistant suggested it or that they
 * declined) and a low-notability aside (lunch, a spilled coffee), which may
 * be stored or not.
 *
 * Development data only: deterministic, no model wrote it, nothing here is
 * sealed. All names are invented placeholders.
 */
import { Rng, addDays, fingerprint } from './seeded.ts';

export const FACTS_ABSORB_GENERATOR_VERSION = 'facts-absorb-gen@1';
export const FACTS_ABSORB_DEFAULT_SEED = 60;

export type ClaimType = 'user' | 'third' | 'assistant' | 'self-fix' | 'metric-fix';
export type Attr = 'city' | 'employer' | 'hobby' | 'allergy' | 'mrr' | 'burn' | 'headcount' | 'recommendation';
export type Speaker = 'user' | 'assistant' | 'other';

export interface Entity { id: string; name: string; type: 'person' | 'company' }

export interface Claim {
  id: string;
  type: ClaimType;
  page: string;
  /** Entity id, or null for an assistant recommendation (its subject is the task). */
  entity: string | null;
  attr: Attr;
  /** The value as rendered in the text, lowercase, e.g. "porto", "harbor works", "pottery". */
  value: string;
  /** Amount for mrr, burn and headcount claims. */
  amount?: number;
  month?: string;
  /** Who asserts it: the user, the assistant, or a named third party. */
  speaker: Speaker;
  /** First name of the third party for `third` claims. */
  source?: string;
  /** The retracted value for self-fix (lowercase string) and metric-fix (amount). */
  retracted?: string;
  retracted_amount?: number;
}

export interface Rejection { id: string; page: string; entity: string; attr: 'city' | 'employer'; value: string }
export interface Aside { id: string; page: string; token: string }

export interface Session {
  slug: string;
  date: string;
  turns: Array<{ speaker: 'user' | 'assistant'; text: string }>;
}

export interface FactsAbsorbWorld {
  generator_version: string;
  seed: number;
  entities: Entity[];
  sessions: Session[];
  claims: Claim[];
  rejections: Rejection[];
  asides: Aside[];
  fingerprint: string;
}

const FIRST = ['Alder', 'Birch', 'Cedar', 'Dune', 'Ember', 'Fern', 'Gale', 'Heath', 'Iris', 'Juniper', 'Kestrel', 'Linden', 'Moss', 'Nettle', 'Oriel', 'Perrin', 'Quill', 'Rowan', 'Sorrel', 'Tamsin', 'Umber', 'Vale', 'Wren', 'Yarrow', 'Zinnia', 'Briar', 'Clover', 'Dahlia', 'Ezra', 'Fennel', 'Hazel', 'Ivo'];
const LAST = ['Varrow', 'Kestley', 'Ombrin', 'Thalwick', 'Pellory', 'Quenby', 'Druvell', 'Ashcombe', 'Marlowe', 'Fenwright', 'Holloway', 'Ingleby', 'Corrin', 'Brackley', 'Sallow', 'Tregar'];
export const CITIES = ['Lisbon', 'Porto', 'Braga', 'Faro', 'Leiria', 'Evora', 'Coimbra', 'Aveiro', 'Viseu', 'Tomar', 'Sintra', 'Setubal', 'Guarda', 'Beja', 'Funchal', 'Cascais'];
export const EMPLOYERS = ['Orchard Labs', 'Harbor Works', 'Quarry Systems', 'Lantern Media', 'Summit Freight', 'Meadow Health', 'Granite Bank', 'Willow Robotics', 'Copper Atlas', 'Beacon Foods', 'Tidewater Energy', 'Ironleaf Studio', 'Northgate Insurance', 'Bluefin Analytics'];
const HOBBIES = ['pottery', 'bouldering', 'sailing', 'birdwatching', 'fencing', 'beekeeping', 'woodworking', 'calligraphy', 'archery', 'kitesurfing', 'falconry', 'origami', 'rowing', 'glassblowing'];
const ALLERGIES = ['shellfish', 'peanuts', 'sesame', 'penicillin', 'kiwi', 'walnuts'];
const COMPANIES = ['Gammaline', 'Deltaworks', 'Kappaforge', 'Lambdaleaf', 'Sigmapath', 'Thetabloom', 'Omicrest', 'Zetavale'];
const VENUES = ['Quinta Azul', 'Casa Lumen', 'Hotel Brisa', 'Solar Verde', 'Pateo Real', 'Villa Serra', 'Moinho Alto', 'Cais Dourado', 'Herdade Lua', 'Quinta Ribeira', 'Palacio Sol', 'Casa Mirante', 'Convento Branco', 'Torre Alva', 'Adega Funda', 'Monte Claro'];
const VENDORS = ['Brightline Payroll', 'Cobalt CRM', 'Ferrous Legal', 'Saltmarsh Design', 'Pinecrest Audit', 'Tallow Hosting', 'Marigold Travel', 'Kiln Analytics', 'Driftwood Benefits', 'Garnet Security', 'Larkspur Recruiting', 'Basalt Logistics', 'Heron Translation', 'Sable Insurance Brokers', 'Thistle Catering', 'Quartzite Cloud'];
const ASIDES: Array<[string, string]> = [
  ['falafel', 'I had a falafel wrap at my desk for lunch, not my finest meal.'],
  ['latte', 'Sorry for the delay, I was waiting forever for an oat milk latte.'],
  ['keyboard', 'Also I just spilled water on my keyboard, so excuse typos.'],
  ['umbrella', 'I forgot my umbrella again and got soaked on the way in.'],
  ['bagel', 'Grabbing an everything bagel before the next call.'],
  ['thermostat', 'The office thermostat is stuck on freezing today.'],
  ['playlist', 'I have had the same focus playlist on repeat all morning.'],
  ['parking', 'Got a parking ticket outside the dentist, which was annoying.'],
];
const FILLER_USER = ['Can you keep this in my notes?', 'Okay, a couple more things while I remember.', 'That is it for now, thanks.', 'Let me know if anything is unclear.', 'One sec, reading my notes.'];
const FILLER_ASSISTANT = ['Got it, noted.', 'Thanks, saved to your notes.', 'Understood. Anything else?', 'Noted. Go on.', 'Sure, I have that.'];
/** Long assistant replies with no world names or values: the bulk of a real chat page, where claims get buried. */
const ASSISTANT_NOISE = [
  'A quick thought on keeping notes like these useful: write down the one thing you would want to know in six months, not everything that happened. Dates and names age well; adjectives do not. If something is uncertain, say so in the note itself, because the future reader will not remember how sure you were. It also helps to keep a short list of open questions at the bottom so they do not get lost in the narrative.',
  'If you want, I can also turn today into a short summary at the end of the week. Most people find a weekly review easier than daily filing, as long as the raw notes are captured somewhere. The trick is to keep the capture step cheap, so it actually happens, and to do the organizing later in one batch when you have the context fresh in your head.',
  'On the scheduling side, it usually works better to block two longer focus sessions than to scatter meetings across the whole day. Back-to-back calls feel efficient but leave no time to write anything down, and the follow-ups are what actually move things forward. Consider leaving ten minutes after each important conversation to jot down decisions and next steps.',
  'For travel planning in general, booking early matters more for trains than for flights in many places, and refundable fares are worth a small premium when plans are still moving. Keeping a single shared document with confirmations, addresses and phone numbers saves a lot of scrambling on the day. I can draft a template for that if it would help.',
  'That sounds like a full week. One pattern that helps with busy stretches is to decide in advance which two or three things must happen and treat everything else as optional. It is easier to protect a short list than a long one, and it makes it clearer what to say no to when new requests come in late on a Thursday.',
  'When you write up the meeting, it can help to separate what was decided from what was merely discussed. Decisions get an owner and a date; discussion points can stay as bullets. That way, when you search your notes later, the decisions stand out instead of being buried in the conversation around them.',
  'For dinners and events, a short message the day before confirming time, place and any dietary needs avoids most last-minute problems. Restaurants are usually happy to accommodate restrictions with notice. It is also worth asking for a quieter table if the point of the evening is conversation rather than celebration.',
  'Budget reviews tend to go more smoothly when the numbers come with a sentence of explanation each. A figure on its own invites questions; a figure with its reason usually ends the discussion. If something changed a lot from the previous month, say why before anyone asks, and note whether it is a one-off or a trend.',
];
/** Phrases only the assistant's long replies contain: a fact carrying one restates the assistant's advice. */
export const ASSISTANT_NOISE_KEYS: readonly RegExp[] = [
  /six months|future reader|open questions|adjectives/i,
  /weekly (review|summary|batch)|end of the week|capture step|keep(ing)? (the )?capture|one batch/i,
  /focus sessions?|back-to-back|ten minutes after/i,
  /\btrains?\b|refundable|shared document|confirmations/i,
  /two or three|short list|say no\b/i,
  /merely discussed|owner and (a )?date|what was decided|discussion points/i,
  /dietary|quieter table|day before/i,
  /sentence of (explanation|reasoning)|one-offs?\b|budget (reviews?|figures?)/i,
];
/** The lead-in of a pronoun claim ("I caught up with Wren yesterday."): true, and not a claim. */
export const MEETING_LEAD = /\b(caught up with|coffee with|ran into)\b/i;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Amount as rendered: "$61,000", "$61k", "61 thousand dollars" or "$1.2 million". */
function money(rng: Rng, n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 100_000 === 0 ? 1 : 2)} million`;
  const form = rng.int(0, 2);
  if (form === 1 && n % 1000 === 0) return `$${n / 1000}k`;
  if (form === 2 && n % 1000 === 0) return `${n / 1000} thousand dollars`;
  return `$${n.toLocaleString('en-US')}`;
}

interface Event {
  date: string;
  user?: string;
  assistant?: string;
  /** For an assistant claim or a rejection: the assistant speaks first, then the user. */
  order?: 'assistant-first';
  claim?: Omit<Claim, 'id' | 'page'>;
  rejection?: Omit<Rejection, 'id' | 'page'>;
}

export function generateFactsAbsorbWorld(opts: { seed?: number; people?: number } = {}): FactsAbsorbWorld {
  const seed = opts.seed ?? FACTS_ABSORB_DEFAULT_SEED;
  const rng = new Rng(seed);
  const nPeople = opts.people ?? FIRST.length;
  const people: Entity[] = FIRST.slice(0, nPeople).map((f, i) => ({ id: `people/${f.toLowerCase()}-example`, name: `${f} ${LAST[i % LAST.length]}`, type: 'person' }));
  const companies: Entity[] = COMPANIES.map(c => ({ id: `companies/${c.toLowerCase()}-example`, name: c, type: 'company' }));
  const first = (e: Entity) => e.name.split(' ')[0];
  const events: Event[] = [];
  const day0 = '2025-01-06';

  for (const [pi, p] of people.entries()) {
    const n = first(p);
    const intro = (s: string) => (rng.int(0, 2) === 0 ? `${p.name}` : n) + s;
    for (const attr of ['city', 'employer'] as const) {
      const pool = attr === 'city' ? CITIES : EMPLOYERS;
      const depth = rng.int(1, 3);
      const labels = rng.shuffle(pool).slice(0, depth + 2);
      const decoy = labels[depth];
      const refused = labels[depth + 1];
      let day = addDays(day0, rng.int(0, 60));
      for (let r = 0; r < depth; r++) {
        if (r > 0) day = addDays(day, rng.int(40, 110));
        const v = labels[r];
        const say = attr === 'city'
          ? (r === 0 ? rng.pick([` lives in ${v}.`, ` is based in ${v} these days.`, ` has been living in ${v} for a while.`]) : rng.pick([` moved to ${v}.`, ` just relocated to ${v}.`, ` packed up and moved to ${v} last week.`]))
          : (r === 0 ? rng.pick([` works at ${v}.`, ` is at ${v} right now.`, `'s day job is at ${v}.`]) : rng.pick([` joined ${v}.`, ` started a new job at ${v}.`, ` left for ${v}, starting this month.`]));
        const selfFix = r === depth - 1 && (pi + (attr === 'city' ? 0 : 1)) % 2 === 0;
        if (selfFix) {
          const wrong = attr === 'city' ? `${n} lives in ${decoy}` : `${n} works at ${decoy}`;
          const right = attr === 'city' ? `${n} lives in ${v}` : `${n} works at ${v}`;
          const text = rng.pick([
            `${wrong}. Wait, no, sorry, I am mixing people up. ${right}.`,
            `${wrong}... actually scratch that, wrong person. ${right}.`,
            `Correction to what I just typed: not ${decoy}. ${right}.`,
          ]);
          const t = text.startsWith('Correction') ? `${wrong}. ${text}` : text;
          events.push({ date: day, user: t, claim: { type: 'self-fix', entity: p.id, attr, value: v.toLowerCase(), speaker: 'user', retracted: decoy.toLowerCase() } });
        } else {
          const pronoun = rng.int(0, 3) === 0;
          const text = pronoun ? `${rng.pick(['I had coffee with', 'I caught up with', 'Ran into'])} ${n} ${rng.pick(['yesterday', 'this morning', 'at the conference'])}. They${say.replace(/^'s day job is/, ' work').replace(/^ is /, ' are ').replace(/^ has /, ' have ').replace(/^ lives /, ' live ').replace(/^ works /, ' work ')}` : intro(say);
          events.push({ date: day, user: text, claim: { type: 'user', entity: p.id, attr, value: v.toLowerCase(), speaker: 'user' } });
        }
      }
      if (pi % 2 === (attr === 'city' ? 0 : 1)) {
        const ask = attr === 'city' ? `Maybe ${n} should think about moving to ${refused}?` : `Have you thought about introducing ${n} to ${refused}? They are hiring, and it could be a good next job for ${n}.`;
        const no = rng.pick([`No, ${n} already said no to that. Not happening.`, `No. ${n} turned that down flat.`, `Definitely not, ${n} would never do that.`]);
        events.push({ date: addDays(day, rng.int(5, 30)), order: 'assistant-first', assistant: ask, user: no, rejection: { entity: p.id, attr, value: refused.toLowerCase() } });
      }
    }
    const hobby = HOBBIES[pi % HOBBIES.length];
    events.push({ date: addDays(day0, rng.int(30, 300)), user: rng.pick([`${n} has gotten really into ${hobby}.`, `Fun fact, ${n} spends every weekend on ${hobby} now.`, `${n} took up ${hobby} this spring.`]), claim: { type: 'user', entity: p.id, attr: 'hobby', value: hobby, speaker: 'user' } });
    if (pi % 2 === 0) {
      const allergy = ALLERGIES[(pi / 2) % ALLERGIES.length];
      events.push({ date: addDays(day0, rng.int(30, 300)), user: rng.pick([`Important for the dinner: ${n} is allergic to ${allergy}.`, `Note that ${n} has a ${allergy} allergy.`, `${n} cannot have ${allergy}, it is a serious allergy.`]), claim: { type: 'user', entity: p.id, attr: 'allergy', value: allergy, speaker: 'user' } });
    }
  }

  const usedAmounts = new Set<number>();
  const amount = (lo: number, step: number) => { for (;;) { const v = lo + rng.int(1, 300) * step; if (!usedAmounts.has(v)) { usedAmounts.add(v); return v; } } };
  for (const [ci, c] of companies.entries()) {
    const metric = (['mrr', 'burn', 'headcount'] as const)[ci % 3];
    const points = rng.int(4, 6);
    const fixes = new Set(rng.shuffle([...Array(points - 1).keys()]).slice(0, 2));
    for (let k = 0; k < points; k++) {
      const month = MONTHS[k];
      const date = addDays(day0, 28 * (k + 1) + rng.int(0, 6));
      const value = metric === 'headcount' ? amount(10, 1) : metric === 'mrr' ? amount(20_000, 500) : amount(30_000, 1000);
      const shown = metric === 'headcount' ? `${value} people` : money(rng, value);
      const third = (ci + k) % 2 === 0;
      const src = first(people[(ci * 5 + k * 3) % people.length]);
      const stmt = metric === 'mrr' ? `${c.name}'s ${month} MRR came in at ${shown}`
        : metric === 'burn' ? `${c.name} burned ${shown} in ${month}`
          : `${c.name} had ${shown} on the team at the end of ${month}`;
      const user = third ? `${src} told me ${stmt}.` : `${stmt}.`;
      events.push({ date, user, claim: { type: third ? 'third' : 'user', entity: c.id, attr: metric, value: String(value), amount: value, month, speaker: third ? 'other' : 'user', ...(third ? { source: src } : {}) } });
      if (fixes.has(k)) {
        const fixed = metric === 'headcount' ? value + rng.int(2, 9) : value + (metric === 'mrr' ? 500 : 1000) * rng.int(3, 12);
        usedAmounts.add(fixed);
        const fixedShown = metric === 'headcount' ? `${fixed}` : money(rng, fixed);
        const oldShown = metric === 'headcount' ? `${value}` : money(rng, value);
        const label = metric === 'mrr' ? `${month} MRR` : metric === 'burn' ? `${month} burn` : `end-of-${month} headcount`;
        const text = rng.pick([
          `I need to correct the ${c.name} number I gave you before: ${label} was actually ${fixedShown}, not ${oldShown}.`,
          `Correction on ${c.name}: their ${label} was ${fixedShown}. I had said ${oldShown}, that was a typo.`,
        ]);
        events.push({ date: addDays(date, rng.int(10, 20)), user: text, claim: { type: 'metric-fix', entity: c.id, attr: metric, value: String(fixed), amount: fixed, month, speaker: 'user', retracted_amount: value } });
      }
    }
  }

  const recs = [...VENUES.map(v => ['venue', v] as const), ...VENDORS.map(v => ['vendor', v] as const)];
  for (const [ri, [kind, v]] of recs.entries()) {
    const ask = kind === 'venue' ? rng.pick(['Any ideas for where to hold the team offsite?', 'I need a place for the board dinner, around 20 people.']) : rng.pick(['We need a new provider for payroll and admin stuff, any suggestions?', 'Who should we use for the audit and finance tooling?']);
    const rec = kind === 'venue' ? `I would recommend ${v}. It fits the group size and is easy to reach by train.` : `I would go with ${v}; they are well reviewed for teams your size.`;
    events.push({ date: addDays(day0, 20 + ri * 11), order: 'assistant-first', user: ask, assistant: rec, claim: { type: 'assistant', entity: null, attr: 'recommendation', value: v.toLowerCase(), speaker: 'assistant' } });
  }

  events.sort((a, b) => a.date.localeCompare(b.date));
  const sessions: Session[] = [];
  const claims: Claim[] = [];
  const rejections: Rejection[] = [];
  const asides: Aside[] = [];
  for (let i = 0, s = 0; i < events.length; s++) {
    const size = rng.int(3, 4);
    const batch = events.slice(i, i + size);
    i += size;
    const date = batch.at(-1)!.date;
    const slug = `conversations/fa${seed}-${String(s + 1).padStart(3, '0')}`;
    const turns: Session['turns'] = [{ speaker: 'user', text: rng.pick([`Notes from today (${date}).`, 'Hey, quick catch-up so you can file a few things.', 'Morning. A few updates for my notes.']) }, { speaker: 'assistant', text: rng.pick(FILLER_ASSISTANT) }];
    const asideAt = s % 2 === 0 ? rng.int(0, batch.length - 1) : -1;
    for (const [k, e] of batch.entries()) {
      if (e.order === 'assistant-first' && e.claim?.type === 'assistant') {
        turns.push({ speaker: 'user', text: e.user! }, { speaker: 'assistant', text: e.assistant! }, { speaker: 'user', text: rng.pick(['Thanks, I will think about it.', 'Okay, I will look into it.', 'Hm, maybe. Let me check the calendar first.']) });
      } else if (e.order === 'assistant-first') {
        turns.push({ speaker: 'assistant', text: e.assistant! }, { speaker: 'user', text: e.user! }, { speaker: 'assistant', text: rng.pick(ASSISTANT_NOISE) });
      } else {
        turns.push({ speaker: 'user', text: e.user! }, { speaker: 'assistant', text: rng.int(0, 1) === 0 ? rng.pick(ASSISTANT_NOISE) : rng.pick(FILLER_ASSISTANT) });
      }
      if (k === asideAt) {
        const [token, text] = ASIDES[s % ASIDES.length];
        turns.push({ speaker: 'user', text }, { speaker: 'assistant', text: rng.pick(FILLER_ASSISTANT) });
        asides.push({ id: `aside-${s + 1}`, page: slug, token });
      }
      if (e.claim) claims.push({ ...e.claim, id: `c${String(claims.length + 1).padStart(4, '0')}`, page: slug });
      if (e.rejection) rejections.push({ ...e.rejection, id: `r${String(rejections.length + 1).padStart(3, '0')}`, page: slug });
    }
    turns.push({ speaker: 'user', text: rng.pick(FILLER_USER) });
    sessions.push({ slug, date, turns });
  }
  const body = { generator_version: FACTS_ABSORB_GENERATOR_VERSION, seed, entities: [...people, ...companies], sessions, claims, rejections, asides };
  return { ...body, fingerprint: fingerprint(body) };
}

/** The page as the agent writes it with put_page: an extraction-eligible `note`, one turn per line. */
export function renderSessionNote(s: Session): string {
  const fm = ['---', 'type: note', `date: ${JSON.stringify(s.date)}`, `title: ${JSON.stringify(`Conversation on ${s.date}`)}`, '---', ''];
  return fm.join('\n') + s.turns.map(t => `**${t.speaker}:** ${t.text}\n`).join('\n');
}
