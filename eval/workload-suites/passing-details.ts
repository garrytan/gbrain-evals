/**
 * B1 passing details: long chat histories in which each answer is a detail
 * the user mentioned once, in passing, inside a conversation about something
 * else. Every history also mentions similar details with different values
 * (the plumber's bill next to the electrician's, a sister's dog next to a
 * neighbor's), and some questions have a "considered" distractor: an earlier
 * value for the same thing that was never final ("first quoted me $X").
 *
 * Generation is template based and deterministic from the seed; no model is
 * called. Gold comes from the generator's own slot assignments.
 *
 * Miss classification (per answered query, from receipts):
 *   absent_from_storage    the store probe for the lane found no stored text
 *                          or fact containing the gold value (presence
 *                          receipt `stored: false`);
 *   stored_not_retrieved   the value is stored, but the exact context
 *                          inserted into the final prompt (answer receipt
 *                          `context`) does not contain it;
 *   delivered_but_misread  the delivered context contains the gold value and
 *                          the graded answer is still not correct.
 * Gold values are unique tokens within a history (asserted at generation),
 * so "the context contains the value" means the answer-bearing detail was
 * delivered, not a look-alike.
 */
import { Rng, addDays } from '../generators/seeded.ts';
import {
  STUB_ABSTAIN, capitalize, contextBlocks, countValue, fill, isoAt, longDate, makeDocument, norm, opaqueId, renderContext, scoreGold, statementRegex,
} from './common.ts';
import { fillerSession } from './filler.ts';
import type { ChatMessage, HarnessDocument, HarnessQuery, Outcome, ScoreResult, ScorerLabel, SuiteBundle, SuiteDefinition } from './types.ts';

export const PASSING_DETAILS_VERSION = 'passing-details-v1';
export const PASSING_DETAILS_SEED = 20261005;
export const PASSING_DETAILS_SIZES = {
  full: { histories: 40, questionsPerHistory: 10, sessions: 64 },
  smoke: { histories: 3, questionsPerHistory: 10, sessions: 14 },
} as const;

interface Family {
  id: string;
  /** Qualifier phrase as it appears in the statement, and its possessive/object form in the question. */
  qualifiers: ReadonlyArray<{ q: string; ask: string }>;
  /** The definitive statement. `{Q}` qualifier, `{V}` value; a clause terminator always follows `{V}`. */
  statement: string;
  /** A non-final earlier value for the same qualifier. */
  considered: string;
  questions: readonly string[];
  values: (rng: Rng) => string;
}

const pickFrom = (pool: readonly string[]) => (rng: Rng) => rng.pick(pool);
const digits = (n: number) => (rng: Rng) => String(rng.int(10 ** (n - 1), 10 ** n - 1));

export const FAMILIES: readonly Family[] = [
  {
    id: 'pet',
    qualifiers: [
      { q: 'my sister', ask: "my sister's" }, { q: 'my neighbor', ask: "my neighbor's" },
      { q: 'my cousin', ask: "my cousin's" }, { q: 'my boss', ask: "my boss's" },
    ],
    statement: "{Q}'s new dog is called {V}.",
    considered: '{Q} was going to call the new dog {V} but changed their mind.',
    questions: ['What is {A} new dog called?', "What's the name of {A} dog?"],
    values: pickFrom(['Pepper', 'Biscuit', 'Juniper', 'Mochi', 'Waffles', 'Ziggy', 'Clementine', 'Bramble', 'Noodle', 'Pistachio', 'Marlowe', 'Odin', 'Tango', 'Paprika', 'Rufus', 'Hazel', 'Gizmo', 'Truffle', 'Banjo', 'Kiwi']),
  },
  {
    id: 'repair-cost',
    qualifiers: [
      { q: 'the plumber', ask: 'the plumber' }, { q: 'the electrician', ask: 'the electrician' },
      { q: 'the mechanic', ask: 'the mechanic' }, { q: 'the roofer', ask: 'the roofer' },
    ],
    statement: '{Q} ended up charging me ${V}.',
    considered: '{Q} first quoted me ${V} for the job.',
    questions: ['How much did {A} end up charging me?', 'What did {A} charge me in the end?'],
    values: digits(3),
  },
  {
    id: 'restaurant',
    qualifiers: [
      { q: 'my anniversary dinner', ask: 'my anniversary dinner' }, { q: "my mom's birthday dinner", ask: "my mom's birthday dinner" },
      { q: 'the team lunch', ask: 'the team lunch' }, { q: "my brother's graduation dinner", ask: "my brother's graduation dinner" },
    ],
    statement: 'for {Q} we went to {V}.',
    considered: 'for {Q} we almost booked {V} instead.',
    questions: ['Which restaurant did we go to for {A}?', 'Where did we eat for {A}?'],
    values: pickFrom(['Lotus Garden', 'The Copper Kettle', 'Osteria Lucca', 'Marigold Room', 'Blue Heron Grill', 'Casa Olivo', 'The Lantern House', 'Fig and Thistle', 'Harbor Noodle Bar', 'Little Saigon Kitchen', 'The Quince Table', 'Bistro Amandine', 'Ember and Oak', 'The Salt Cellar', 'Juniper Hall']),
  },
  {
    id: 'flight',
    qualifiers: [
      { q: 'Lisbon', ask: 'Lisbon' }, { q: 'Denver', ask: 'Denver' }, { q: 'Osaka', ask: 'Osaka' }, { q: 'Montreal', ask: 'Montreal' },
    ],
    statement: 'my flight to {Q} is {V}.',
    considered: 'I was originally on {V} to {Q} until the schedule changed.',
    questions: ['What is my flight number to {A}?', 'Which flight am I on to {A}?'],
    values: (rng: Rng) => `${rng.pick(['TP', 'UA', 'NH', 'AC', 'LH', 'KL', 'BA', 'IB'])} ${rng.int(1000, 9999)}`,
  },
  {
    id: 'access-code',
    qualifiers: [
      { q: 'the gym locker', ask: 'the gym locker' }, { q: 'the garage door', ask: 'the garage door' },
      { q: 'my bike lock', ask: 'my bike lock' }, { q: 'the storage unit', ask: 'the storage unit' },
    ],
    statement: 'the code for {Q} is {V}.',
    considered: 'the old code for {Q} was {V} before they reset it.',
    questions: ['What is the code for {A}?', "What's the code to open {A}?"],
    values: digits(5),
  },
  {
    id: 'clinician',
    qualifiers: [
      { q: 'dentist', ask: 'dentist' }, { q: 'dermatologist', ask: 'dermatologist' },
      { q: 'physical therapist', ask: 'physical therapist' }, { q: 'eye doctor', ask: 'eye doctor' },
    ],
    statement: 'my new {Q} is Dr. {V}.',
    considered: 'I nearly switched my {Q} to Dr. {V} but did not.',
    questions: ['What is the name of my new {A}?', 'Who is my new {A}?'],
    values: pickFrom(['Okafor', 'Lindqvist', 'Abernathy', 'Castellanos', 'Nakamura', 'Petrova', 'Oyelaran', 'Haddad', 'Fitzgerald', 'Moreau', 'Szabo', 'Iversen', 'Quintero', 'Bhattacharya', 'Delacroix', 'Varga']),
  },
  {
    id: 'paint-color',
    qualifiers: [
      { q: 'the hallway', ask: 'the hallway' }, { q: 'the kitchen', ask: 'the kitchen' },
      { q: 'the nursery', ask: 'the nursery' }, { q: 'the back porch', ask: 'the back porch' },
    ],
    statement: 'we painted {Q} in a color called {V}.',
    considered: 'we tested a swatch called {V} for {Q} and hated it.',
    questions: ['What color did we paint {A}?', 'Which paint color did we use for {A}?'],
    values: pickFrom(['Harbor Fog', 'Sage Whisper', 'Desert Rose', 'Midnight Spruce', 'Oat Milk', 'Coral Reef', 'Quiet Moss', 'Lavender Haze', 'Iron Ore', 'Buttercream', 'Storm Cloud', 'Terracotta Sun', 'Arctic Mist', 'Golden Wheat']),
  },
  {
    id: 'expiry',
    qualifiers: [
      { q: 'my passport', ask: 'my passport' }, { q: 'the car registration', ask: 'the car registration' },
      { q: 'my apartment lease', ask: 'my apartment lease' }, { q: 'my gym membership', ask: 'my gym membership' },
    ],
    statement: '{Q} expires on {V}.',
    considered: 'I thought {Q} expired on {V} but I had misread it.',
    questions: ['When does {A} expire?', 'What is the expiry date of {A}?'],
    values: (rng: Rng) => longDate(`${rng.int(2026, 2029)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`),
  },
  {
    id: 'person-name',
    qualifiers: [
      { q: 'my new manager', ask: 'my new manager' }, { q: 'our landlord', ask: 'our landlord' },
      { q: "my son's soccer coach", ask: "my son's soccer coach" }, { q: 'the realtor', ask: 'the realtor' },
    ],
    statement: '{Q} is someone called {V}.',
    considered: 'I assumed {Q} would be {V} but that fell through.',
    questions: ['What is the name of {A}?', 'Who is {A}?'],
    values: pickFrom(['Imogen Tull', 'Rafael Okonkwo', 'Priya Venkataraman', 'Tobias Wrenfield', 'Mireille Dufresne', 'Ansel Barrowby', 'Keiko Hollander', 'Dmitri Salazar', 'Wren Achterberg', 'Ottoline Park', 'Caspian Mbeki', 'Leonie Fairweather', 'Isidore Quan', 'Saoirse Malloy']),
  },
  {
    id: 'furniture-width',
    qualifiers: [
      { q: 'the new couch', ask: 'the new couch' }, { q: 'the hallway rug', ask: 'the hallway rug' },
      { q: 'my standing desk', ask: 'my standing desk' }, { q: 'the bookshelf', ask: 'the bookshelf' },
    ],
    statement: '{Q} is {V} inches wide.',
    considered: 'the listing said {Q} was {V} inches wide but that was wrong.',
    questions: ['How wide is {A}?', 'What is the width of {A}?'],
    values: (rng: Rng) => String(rng.int(31, 119)),
  },
  {
    id: 'reading-pick',
    qualifiers: [
      { q: 'my book club', ask: 'my book club' }, { q: "my daughter's class", ask: "my daughter's class" },
      { q: 'the office reading group', ask: 'the office reading group' }, { q: 'my running club', ask: 'my running club' },
    ],
    statement: '{Q} is reading {V} this month.',
    considered: '{Q} voted down {V} for this month.',
    questions: ['What is {A} reading this month?', 'Which book is {A} reading this month?'],
    values: pickFrom(['The Glass Orchard', 'Salt and Starlight', 'A Map of Quiet Rivers', 'The Lighthouse Accountant', 'Winter at Fennick Bay', 'The Clockmaker’s Daughter', 'Nine Paper Boats', 'The Long Way to Calder', 'Ashes of the Copper Sea', 'The Orchardist’s Ledger', 'Small Hours in Tangier', 'The Honey Thief']),
  },
  {
    id: 'wifi-password',
    qualifiers: [
      { q: 'the cabin', ask: 'the cabin' }, { q: "my parents' house", ask: "my parents' house" },
      { q: 'the coworking space', ask: 'the coworking space' }, { q: 'the guest apartment', ask: 'the guest apartment' },
    ],
    statement: 'the wifi password at {Q} is {V}.',
    considered: 'the old wifi password at {Q} was {V} before they changed it.',
    questions: ['What is the wifi password at {A}?', "What's the wifi password for {A}?"],
    values: (rng: Rng) => `${rng.pick(['bluefinch', 'mapletree', 'quietfox', 'sunporch', 'redkite', 'tidepool', 'oakbarrel', 'stonewall'])}${rng.int(10, 99)}`,
  },
];

const ASIDES = [
  (s: string) => `Oh, unrelated, but ${s}`,
  (s: string) => `Side note: ${s}`,
  (s: string) => `${capitalize(s.replace(/\.$/, ''))}, by the way.`,
  (s: string) => `Totally different subject for a second: ${s}`,
  (s: string) => `Before I forget, ${s}`,
];

const USER_COUNT_PREFIX = 'pd';

export interface PassingSpec { family: string; qualifier: string }

/** Build one family's slot plan for a history: target qualifier, distractor qualifiers and values. */
interface SlotPlan { family: Family; target: { q: string; ask: string }; value: string; distractors: Array<{ q: string; value: string }>; considered: string | null }

/** Draw a value that is not a sub-phrase of, and does not contain, any value already used in the history. */
function uniqueValue(rng: Rng, family: Family, used: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    const v = family.values(rng);
    const n = ` ${norm(v)} `;
    if (![...used].some(u => u.includes(n) || n.includes(u))) { used.add(n); return v; }
  }
  throw new Error(`passing-details: value pool for ${family.id} exhausted`);
}

export function generatePassingDetails(opts: { seed?: number; smoke?: boolean; histories?: number; sessions?: number } = {}): SuiteBundle {
  const seed = opts.seed ?? PASSING_DETAILS_SEED;
  const smoke = opts.smoke ?? false;
  const size = smoke ? PASSING_DETAILS_SIZES.smoke : PASSING_DETAILS_SIZES.full;
  const histories = opts.histories ?? size.histories;
  const sessions = opts.sessions ?? size.sessions;
  const rng = new Rng(seed);
  const documents: HarnessDocument[] = [];
  const queries: HarnessQuery[] = [];
  const labels: ScorerLabel[] = [];

  for (let h = 0; h < histories; h++) {
    const user = opaqueId(USER_COUNT_PREFIX + 'u', seed, h);
    const used = new Set<string>();
    const families = rng.shuffle(FAMILIES).slice(0, size.questionsPerHistory);
    const plans: SlotPlan[] = families.map(family => {
      const [target, ...others] = rng.shuffle(family.qualifiers);
      const nDistractors = rng.int(2, 3);
      return {
        family,
        target: target!,
        value: uniqueValue(rng, family, used),
        distractors: others.slice(0, nDistractors).map(o => ({ q: o.q, value: uniqueValue(rng, family, used) })),
        considered: rng.float() < 0.3 ? uniqueValue(rng, family, used) : null,
      };
    });

    // Session skeletons, then place each mention in a user turn of some session.
    let day = `2025-${String(rng.int(1, 3)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;
    const skeletons: Array<{ ts: string; messages: ChatMessage[] }> = [];
    for (let s = 0; s < sessions; s++) {
      skeletons.push({ ts: isoAt(day, rng.int(7 * 60, 22 * 60)), messages: fillerSession(rng, rng.int(4, 7), rng.int(1, 2)) });
      day = addDays(day, rng.int(1, 4));
    }
    type Mention = { text: string; role: 'target' | 'distractor' | 'considered'; plan: SlotPlan; value: string; minSession: number; maxSession: number };
    const mentions: Mention[] = [];
    for (const plan of plans) {
      const targetSession = rng.int(Math.min(2, sessions - 1), sessions - 1);
      mentions.push({ text: fill(plan.family.statement, { Q: plan.target.q, V: plan.value }), role: 'target', plan, value: plan.value, minSession: targetSession, maxSession: targetSession });
      for (const d of plan.distractors) mentions.push({ text: fill(plan.family.statement, { Q: d.q, V: d.value }), role: 'distractor', plan, value: d.value, minSession: 0, maxSession: sessions - 1 });
      if (plan.considered) mentions.push({ text: fill(plan.family.considered, { Q: plan.target.q, V: plan.considered }), role: 'considered', plan, value: plan.considered, minSession: 0, maxSession: Math.max(0, targetSession - 1) });
    }
    const placed: Array<Mention & { session: number; turn: number; sentence: string }> = [];
    const taken = new Set<string>();
    for (const m of mentions) {
      for (let attempt = 0; ; attempt++) {
        const session = rng.int(m.minSession, m.maxSession);
        const messages = skeletons[session]!.messages;
        if (attempt >= 50) {
          // Every user turn in range is taken: add one more short exchange to this session.
          messages.push({ role: 'user', content: 'One more thing.' }, { role: 'assistant', content: 'Sure, go ahead.' });
        }
        const userTurns = messages.map((x, i) => x.role === 'user' ? i : -1).filter(i => i > 0 && !taken.has(`${session}:${i}`));
        if (!userTurns.length) continue;
        const turn = rng.pick(userTurns);
        taken.add(`${session}:${turn}`);
        const sentence = rng.pick(ASIDES)(m.text);
        const msg = skeletons[session]!.messages[turn]!;
        msg.content = `${sentence} ${msg.content}`;
        placed.push({ ...m, session, turn, sentence });
        break;
      }
    }

    const docIds = skeletons.map((_, s) => opaqueId('pdd', seed, h, s));
    skeletons.forEach((sk, s) => documents.push(makeDocument(docIds[s]!, user, sk.ts, sk.messages)));
    const historyText = skeletons.map(sk => sk.messages.map(m => m.content).join('\n')).join('\n');
    const queryTs = isoAt(day, 12 * 60);

    for (const plan of plans) {
      for (const p of placed.filter(x => x.plan === plan)) {
        const n = countValue(historyText, p.value);
        if (n !== 1) throw new Error(`passing-details seed ${seed} history ${h}: value "${p.value}" (${plan.family.id}) occurs ${n} times; values must be unique tokens`);
      }
      const target = placed.find(x => x.plan === plan && x.role === 'target')!;
      const qid = opaqueId('pdq', seed, h, plan.family.id);
      const query = fill(rng.pick(plan.family.questions), { A: plan.target.ask });
      queries.push({
        id: qid, query: capitalize(query), gold_ids: [docIds[target.session]!], gold_answers: [plan.value], user_id: user,
        meta: { query_timestamp: queryTs, category: plan.family.id },
      });
      labels.push({
        query_id: qid, suite: 'passing-details', category: plan.family.id,
        spec: { family: plan.family.id, qualifier: plan.target.q } satisfies PassingSpec,
        gold: { kind: 'value', value: plan.value },
        oracle_doc_ids: [docIds[target.session]!],
        needles: [{ doc_id: docIds[target.session]!, text: target.sentence, value: plan.value }],
        distractors: placed.filter(x => x.plan === plan && x.role !== 'target').map(x => ({ doc_id: docIds[x.session]!, value: x.value, kind: x.role })),
        negative: false,
      });
    }
  }
  return {
    suite: 'passing-details', version: PASSING_DETAILS_VERSION, seed, smoke,
    documents, queries, labels, extra: {},
    timestamp_provenance: 'observed_session_time: every document timestamp is the time the conversation happened; no event dates are promoted from text.',
  };
}

/** Offline reader: finds the definitive statement for the asked qualifier; never reads gold. */
export function passingStubAnswer(label: ScorerLabel, context: string): string {
  const spec = label.spec as unknown as PassingSpec;
  const family = FAMILIES.find(f => f.id === spec.family)!;
  const found = new Set<string>();
  for (const block of contextBlocks(context)) {
    for (const m of block.text.matchAll(statementRegex(family.statement, { Q: spec.qualifier }))) found.add(m[1]!.trim());
  }
  if (found.size === 0) return STUB_ABSTAIN;
  return [...found].join(' or ');
}

export function scorePassingDetail(label: ScorerLabel, answer: string): ScoreResult {
  return scoreGold(label.gold, answer, label.distractors.map(d => d.value));
}

export type MissClass = 'correct' | 'absent_from_storage' | 'stored_not_retrieved' | 'delivered_but_misread' | 'unclassified';

/**
 * Classify one graded answer. `stored` comes from the lane's presence
 * receipt (null when no store probe ran); `deliveredContext` is the exact
 * context inserted into the final prompt.
 */
export function classifyMiss(label: ScorerLabel, input: { outcome: Outcome; stored: boolean | null; deliveredContext: string }): MissClass {
  if (input.outcome === 'correct') return 'correct';
  if (label.gold.kind !== 'value') return 'unclassified';
  if (input.stored === false) return 'absent_from_storage';
  const delivered = countValue(input.deliveredContext, label.gold.value) > 0;
  if (!delivered) return input.stored === null ? 'unclassified' : 'stored_not_retrieved';
  return 'delivered_but_misread';
}

export const passingDetails: SuiteDefinition = {
  id: 'passing-details',
  version: PASSING_DETAILS_VERSION,
  defaultSeed: PASSING_DETAILS_SEED,
  describe: 'B1: details mentioned once in passing inside long chat histories, with look-alike distractors.',
  generate: ({ seed, smoke }) => generatePassingDetails({ seed, smoke }),
  stubAnswer: passingStubAnswer,
  score: scorePassingDetail,
};

export { renderContext };
