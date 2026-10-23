#!/usr/bin/env bun
/**
 * Synthetic relative-date questions for the external-ideas wave A study
 * (GBRA-162): a seeded, LongMemEval-format dataset whose answers need the day
 * a conversation happened plus a relative phrase the user said in it ("I
 * adopted the beagle three weeks ago"). Every person, pet and event is
 * invented. Gold answers come from the generator's own calendar arithmetic,
 * never from gbrain.
 *
 * Four question kinds, 15 each (60 questions, question_type
 * `temporal-reasoning` so LongMemEval's official judge applies its day-count
 * rule):
 *   between  days between two events stated in different sessions
 *   date     the calendar date of one event
 *   ago      days from one event to the question date
 *   order    which of two events came first, where the event mentioned in the
 *            later conversation happened earlier
 *
 * Each haystack has 6 to 10 sessions on different days, with multi-week gaps
 * and, for a quarter of the questions, a year boundary. Distractors: other
 * events with relative phrases, a same-topic event of someone else, future
 * plans ("I'm flying out next Friday"), and assistant turns that use relative
 * words generically.
 *
 *   bun eval/runner/external-ideas-wave-a/synthetic-dates.ts [--out <json>] [--seed N]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seededRandom } from '../stats/paired.ts';

export const SYNTHETIC_SEED = 20261021;
export const SYNTHETIC_PATH = join(import.meta.dir, '../../data/external-ideas/synthetic-dates-v1.json');
export const KINDS = ['between', 'date', 'ago', 'order'] as const;
export type Kind = typeof KINDS[number];
export const PER_KIND = 15;

export interface Turn { role: 'user' | 'assistant'; content: string; has_answer?: boolean }
export interface SyntheticQuestion {
  question_id: string;
  question_type: 'temporal-reasoning';
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

// ─── Calendar ───────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const diffDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
/** 0 = Monday ... 6 = Sunday. */
export const weekday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
export const longDate = (day: string) => `${MONTHS[+day.slice(5, 7) - 1]} ${+day.slice(8, 10)}, ${day.slice(0, 4)}`;
/** LongMemEval's date format: `2023/05/20 (Sat) 02:21`. */
export const lmeDate = (day: string, hh: number, mm: number) => `${day.replace(/-/g, '/')} (${WEEKDAYS[weekday(day)].slice(0, 3)}) ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

// ─── Relative phrases with one unambiguous day ──────────────────────

export interface Phrase { text: string; offset: number }

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];

/**
 * Past phrases that name exactly one day relative to the session day.
 * "last <weekday>" is offered only when that weekday falls in the previous
 * calendar week and at least two days back, so "the most recent one" and
 * "the one in last week" agree.
 */
export function exactPastPhrases(sessionDay: string): Phrase[] {
  const out: Phrase[] = [{ text: 'yesterday', offset: -1 }];
  for (let n = 2; n <= 5; n++) out.push({ text: `${NUMBER_WORDS[n]} days ago`, offset: -n });
  out.push({ text: 'a week ago', offset: -7 }, { text: 'two weeks ago', offset: -14 }, { text: 'three weeks ago', offset: -21 });
  const ws = weekday(sessionDay);
  for (let wt = ws + 1; wt <= 6; wt++) {
    const back = 7 + ws - wt;
    if (back >= 2) out.push({ text: `last ${WEEKDAYS[wt]}`, offset: -back });
  }
  return out;
}

// ─── Invented content ───────────────────────────────────────────────

interface EventDef { say: (p: string) => string; ref: string; did: string }

/** Ordered pairs: the second event naturally follows the first. */
const PAIRS: Array<[EventDef, EventDef]> = [
  [{ say: p => `I adopted a beagle puppy ${p}, and she already comes when I call her name.`, ref: 'adopting the beagle puppy', did: 'adopt the beagle puppy' },
    { say: p => `The beagle had her first vet visit ${p}, and the vet said she is perfectly healthy.`, ref: "the beagle's first vet visit", did: 'take the beagle to her first vet visit' }],
  [{ say: p => `I ran my first 10k race ${p} and finished without walking once.`, ref: 'running my first 10k', did: 'run my first 10k' },
    { say: p => `I signed up for the autumn half marathon ${p}, so now I have a real training plan.`, ref: 'signing up for the half marathon', did: 'sign up for the half marathon' }],
  [{ say: p => `I started a Tuesday-night pottery class ${p}; my hands were covered in clay.`, ref: 'starting the pottery class', did: 'start the pottery class' },
    { say: p => `I finished my first glazed bowl ${p} and it only wobbles a little.`, ref: 'finishing my first glazed bowl', did: 'finish my first glazed bowl' }],
  [{ say: p => `I planted the tomato seedlings on the balcony ${p}.`, ref: 'planting the tomato seedlings', did: 'plant the tomato seedlings' },
    { say: p => `I picked the very first ripe tomato from the balcony ${p}!`, ref: 'picking the first ripe tomato', did: 'pick the first ripe tomato' }],
  [{ say: p => `We moved into the new apartment ${p}, and the boxes are still everywhere.`, ref: 'moving into the new apartment', did: 'move into the new apartment' },
    { say: p => `We hosted a small housewarming dinner ${p} in the new place.`, ref: 'hosting the housewarming dinner', did: 'host the housewarming dinner' }],
  [{ say: p => `I bought a used road bike ${p} from a local listing.`, ref: 'buying the used road bike', did: 'buy the used road bike' },
    { say: p => `I took the road bike in for a full tune-up ${p}; the gears shift smoothly now.`, ref: 'the road bike tune-up', did: 'get the road bike tuned up' }],
  [{ say: p => `I made a sourdough starter from scratch ${p}.`, ref: 'making the sourdough starter', did: 'make the sourdough starter' },
    { say: p => `I baked my first loaf with that starter ${p}, and the crust was amazing.`, ref: 'baking the first sourdough loaf', did: 'bake the first sourdough loaf' }],
  [{ say: p => `I joined the bouldering gym near my office ${p}.`, ref: 'joining the bouldering gym', did: 'join the bouldering gym' },
    { say: p => `I finally sent my first V3 problem at the gym ${p}.`, ref: 'climbing my first V3', did: 'climb my first V3' }],
  [{ say: p => `I ordered a standing desk ${p} after my back started hurting.`, ref: 'ordering the standing desk', did: 'order the standing desk' },
    { say: p => `I assembled the standing desk ${p}; it took most of the afternoon.`, ref: 'assembling the standing desk', did: 'assemble the standing desk' }],
  [{ say: p => `I started learning to play the ukulele ${p}.`, ref: 'starting the ukulele', did: 'start learning the ukulele' },
    { say: p => `I played a full song on the ukulele for my roommate ${p}.`, ref: 'playing my first full song on the ukulele', did: 'play my first full song on the ukulele' }],
  [{ say: p => `I began a beginner Spanish course online ${p}.`, ref: 'starting the Spanish course', did: 'start the Spanish course' },
    { say: p => `I passed the first unit test of my Spanish course ${p}.`, ref: 'passing the first Spanish unit test', did: 'pass the first Spanish unit test' }],
  [{ say: p => `I set up a freshwater aquarium in the living room ${p}.`, ref: 'setting up the aquarium', did: 'set up the aquarium' },
    { say: p => `I added the first six neon tetras to the aquarium ${p}.`, ref: 'adding the first fish to the aquarium', did: 'add the first fish to the aquarium' }],
  [{ say: p => `I started the couch-to-5k program ${p}.`, ref: 'starting the couch-to-5k program', did: 'start the couch-to-5k program' },
    { say: p => `I ran thirty minutes without stopping ${p} for the first time ever.`, ref: 'running thirty minutes without stopping', did: 'run thirty minutes without stopping' }],
  [{ say: p => `I put in the application for the community garden plot ${p}.`, ref: 'applying for the community garden plot', did: 'apply for the community garden plot' },
    { say: p => `I got the keys to my community garden plot ${p}.`, ref: 'getting the keys to the garden plot', did: 'get the keys to the garden plot' }],
  [{ say: p => `I bought a secondhand sewing machine ${p}.`, ref: 'buying the sewing machine', did: 'buy the sewing machine' },
    { say: p => `I finished sewing my first tote bag ${p}.`, ref: 'finishing my first tote bag', did: 'finish my first tote bag' }],
];

/** Independent single events (date, ago and order questions, and distractors). */
const SINGLES: EventDef[] = [
  { say: p => `I repainted the bedroom a pale green ${p}.`, ref: 'repainting the bedroom', did: 'repaint the bedroom' },
  { say: p => `I replaced the car battery ${p} after it died in the parking lot.`, ref: 'replacing the car battery', did: 'replace the car battery' },
  { say: p => `I donated three bags of old clothes ${p}.`, ref: 'donating the old clothes', did: 'donate the old clothes' },
  { say: p => `I got my flu shot at the pharmacy ${p}.`, ref: 'getting the flu shot', did: 'get my flu shot' },
  { say: p => `I renewed my passport ${p}; the photo is terrible.`, ref: 'renewing my passport', did: 'renew my passport' },
  { say: p => `I hiked to the fire lookout on the ridge trail ${p}.`, ref: 'hiking to the fire lookout', did: 'hike to the fire lookout' },
  { say: p => `I cleaned out the garage ${p} and found my old skateboard.`, ref: 'cleaning out the garage', did: 'clean out the garage' },
  { say: p => `I switched to a new phone plan ${p} to save some money.`, ref: 'switching phone plans', did: 'switch to the new phone plan' },
  { say: p => `I baked a lemon cake for the office potluck ${p}.`, ref: 'baking the lemon cake', did: 'bake the lemon cake' },
  { say: p => `I installed a smart thermostat ${p}.`, ref: 'installing the smart thermostat', did: 'install the smart thermostat' },
  { say: p => `I went to my first improv workshop ${p}.`, ref: 'going to the improv workshop', did: 'go to the improv workshop' },
  { say: p => `I fixed the leaky kitchen faucet myself ${p}.`, ref: 'fixing the kitchen faucet', did: 'fix the kitchen faucet' },
  { say: p => `I watched the meteor shower from the lake ${p}.`, ref: 'watching the meteor shower', did: 'watch the meteor shower' },
  { say: p => `I finished reading that thousand-page fantasy novel ${p}.`, ref: 'finishing the fantasy novel', did: 'finish the fantasy novel' },
  { say: p => `I had my wisdom tooth pulled ${p}.`, ref: 'having my wisdom tooth pulled', did: 'have my wisdom tooth pulled' },
  { say: p => `I bought a kayak at the end-of-season sale ${p}.`, ref: 'buying the kayak', did: 'buy the kayak' },
  { say: p => `I volunteered at the animal shelter for the first time ${p}.`, ref: 'volunteering at the animal shelter', did: 'volunteer at the animal shelter' },
  { say: p => `I rearranged the whole living room ${p}.`, ref: 'rearranging the living room', did: 'rearrange the living room' },
  { say: p => `I learned to change a bike tire ${p}.`, ref: 'learning to change a bike tire', did: 'learn to change a bike tire' },
  { say: p => `I tried indoor skydiving ${p}.`, ref: 'trying indoor skydiving', did: 'try indoor skydiving' },
];

/** Someone else's event on a similar topic: never the answer. */
const OTHERS = [
  (p: string) => `My neighbor adopted a gray kitten ${p}.`,
  (p: string) => `My coworker ran a marathon ${p}, which is wild to me.`,
  (p: string) => `My brother moved across town ${p}.`,
  (p: string) => `My roommate bought an electric scooter ${p}.`,
  (p: string) => `My aunt started a watercolor class ${p}.`,
  (p: string) => `My cousin finished building a bookshelf ${p}.`,
];

const FUTURE = [
  "I'm flying out next Friday to visit my sister.",
  "We're visiting the coast in June if the weather cooperates.",
  'My dentist appointment is tomorrow morning.',
  "I'm planning to repaint the fence next weekend.",
  'The concert we got tickets for is in two weeks.',
  "I'm thinking of taking a few days off next month.",
];

const ASK = [
  'Can you suggest a simple stretching routine I can do in ten minutes?',
  'What is a good way to keep track of small daily habits?',
  'Any tips for meal prepping lunches for the week?',
  'How do I keep houseplants alive in a dim apartment?',
  'What should I pack for a short weekend trip?',
  'Can you recommend a few podcasts about history?',
  'How do I make my morning routine less rushed?',
  'What is an easy vegetarian dinner I can cook tonight?',
  'How often should I replace running shoes?',
  'What are some low-cost hobbies I could try?',
];

const ASSISTANT = [
  'Great question! Many people find that what felt hard a week ago gets easier with practice. Start small and stay consistent.',
  'Here are a few ideas. Today most guides recommend keeping it simple: pick one thing, do it daily, and review it at the end of the week.',
  'That sounds like a lot of progress. In a few weeks you will probably notice the difference even more.',
  'Sure. A common approach from last year is to batch similar tasks together and plan them a day ahead.',
  "That's wonderful to hear! Tomorrow is always a good day to build on what you started.",
  'Happy to help. Some people set a reminder for next month to check whether the routine is still working for them.',
];

// ─── Generator ──────────────────────────────────────────────────────

interface Planned { sessionIndex: number; text: string; answer: boolean }

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

function shuffle<T>(rand: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** Session days: a start day, then gaps of 2 to 25 days with an occasional 30 to 45 day gap. */
function sessionDays(rand: () => number, n: number, crossYear: boolean): string[] {
  const year = 2023 + Math.floor(rand() * 2);
  const start = crossYear ? addDays(`${year}-11-25`, Math.floor(rand() * 20)) : addDays(`${year}-01-10`, Math.floor(rand() * 260));
  const out = [start];
  while (out.length < n) out.push(addDays(out[out.length - 1], rand() < 0.15 ? 30 + Math.floor(rand() * 16) : 2 + Math.floor(rand() * 24)));
  return out;
}

export function generate(seed = SYNTHETIC_SEED): SyntheticQuestion[] {
  const rand = seededRandom(seed);
  const out: SyntheticQuestion[] = [];
  for (const kind of KINDS) {
    for (let k = 0; k < PER_KIND; k++) {
      const n = 6 + Math.floor(rand() * 5);
      const sdays = sessionDays(rand, n, k % 4 === 0);
      const phrase = (i: number) => pick(rand, exactPastPhrases(sdays[i]));
      const used = new Set<number>();
      const single = () => {
        let i = Math.floor(rand() * SINGLES.length);
        while (used.has(i)) i = (i + 1) % SINGLES.length;
        used.add(i);
        return SINGLES[i];
      };
      const planned: Planned[] = [];
      let question: string;
      let answer: string;
      if (kind === 'between') {
        const [a, b] = PAIRS[k % PAIRS.length];
        const ia = Math.floor(rand() * (n - 1));
        const ib = ia + 1 + Math.floor(rand() * (n - 1 - ia));
        const pa = phrase(ia);
        const da = addDays(sdays[ia], pa.offset);
        const pb = pick(rand, exactPastPhrases(sdays[ib]).filter(p => addDays(sdays[ib], p.offset) > da));
        const db = addDays(sdays[ib], pb.offset);
        planned.push({ sessionIndex: ia, text: capitalize(a.say(pa.text)), answer: true }, { sessionIndex: ib, text: capitalize(b.say(pb.text)), answer: true });
        question = `How many days passed between ${a.ref} and ${b.ref}?`;
        answer = `${days(diffDays(da, db))} (${longDate(da)} to ${longDate(db)})`;
      } else if (kind === 'date' || kind === 'ago') {
        const e = single();
        const i = Math.floor(rand() * n);
        const p = phrase(i);
        const d = addDays(sdays[i], p.offset);
        planned.push({ sessionIndex: i, text: capitalize(e.say(p.text)), answer: true });
        question = kind === 'date' ? `On what date did I ${e.did}?` : `How many days ago did I ${e.did}?`;
        answer = kind === 'date' ? longDate(d) : `ago:${d}`;
      } else {
        const x = single(), y = single();
        const iy = Math.floor(rand() * (n - 1));
        const ix = iy + 1 + Math.floor(rand() * (n - 1 - iy));
        const py = phrase(iy);
        const dy = addDays(sdays[iy], py.offset);
        const options = exactPastPhrases(sdays[ix]).filter(p => addDays(sdays[ix], p.offset) < dy);
        if (!options.length) { k--; continue; }
        const px = pick(rand, options);
        const dx = addDays(sdays[ix], px.offset);
        planned.push({ sessionIndex: iy, text: capitalize(y.say(py.text)), answer: true }, { sessionIndex: ix, text: capitalize(x.say(px.text)), answer: true });
        const [first, second] = rand() < 0.5 ? [x, y] : [y, x];
        question = `Which did I do first, ${first.ref} or ${second.ref}?`;
        answer = `${capitalize(x.ref)} came first (${longDate(dx)}), ${days(diffDays(dx, dy))} before ${y.ref} (${longDate(dy)}).`;
      }
      const distractors = 2 + Math.floor(rand() * 3);
      for (let j = 0; j < distractors; j++) {
        const i = Math.floor(rand() * n);
        planned.push({ sessionIndex: i, text: capitalize(single().say(phrase(i).text)), answer: false });
      }
      const io = Math.floor(rand() * n);
      planned.push({ sessionIndex: io, text: pick(rand, OTHERS)(phrase(io).text), answer: false });
      for (const f of shuffle(rand, FUTURE).slice(0, 2)) planned.push({ sessionIndex: Math.floor(rand() * n), text: f, answer: false });

      const qid = `synth-${kind}-${String(k + 1).padStart(2, '0')}`;
      const sessions: Turn[][] = [], ids: string[] = [], dates: string[] = [], answerIds: string[] = [];
      for (let s = 0; s < n; s++) {
        const statements = shuffle(rand, planned.filter(p => p.sessionIndex === s));
        const asks = shuffle(rand, ASK).slice(0, 2 + Math.floor(rand() * 2));
        const turns: Turn[] = [];
        for (let r = 0; r < Math.max(asks.length, statements.length); r++) {
          const content = [statements[r]?.text, asks[r]].filter(Boolean).join(' ');
          turns.push({ role: 'user', content, ...(statements[r]?.answer ? { has_answer: true } : {}) });
          turns.push({ role: 'assistant', content: pick(rand, ASSISTANT) });
        }
        const isAnswer = statements.some(p => p.answer);
        const id = `${isAnswer ? 'answer_' : ''}${qid.replace(/-/g, '_')}_${s}`;
        if (isAnswer) answerIds.push(id);
        sessions.push(turns);
        ids.push(id);
        dates.push(lmeDate(sdays[s], 8 + Math.floor(rand() * 13), Math.floor(rand() * 60)));
      }
      const qDay = addDays(sdays[n - 1], 1 + Math.floor(rand() * 5));
      if (answer.startsWith('ago:')) answer = `${days(diffDays(answer.slice(4), qDay))} (${longDate(answer.slice(4))})`;
      out.push({
        question_id: qid, question_type: 'temporal-reasoning', question, answer,
        question_date: lmeDate(qDay, 9 + Math.floor(rand() * 12), Math.floor(rand() * 60)),
        haystack_dates: dates, haystack_session_ids: ids, haystack_sessions: sessions, answer_session_ids: answerIds,
      });
    }
  }
  return out;
}

export const serialize = (qs: SyntheticQuestion[]) => JSON.stringify(qs, null, 1) + '\n';
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const text = serialize(generate(Number(flag('--seed') ?? SYNTHETIC_SEED)));
  const out = flag('--out') ?? SYNTHETIC_PATH;
  writeFileSync(out, text);
  process.stdout.write(JSON.stringify({ out, questions: JSON.parse(text).length, sha256: sha256(text) }) + '\n');
}
