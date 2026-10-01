/**
 * Frozen prompts and seed lists for sealed confirmation set v2.
 *
 * v1 turned out too easy for evidence-delivery decisions: five retrieved
 * chunks already answered 147 of its 150 questions, because its chats were
 * short and most answers sat in one place. v2 is built so that chunks cannot
 * cover the evidence: long sessions, LongMemEval-S-sized haystacks, every
 * answer spread over several sessions, long-range dates, and knowledge that
 * changes more than once.
 *
 * Public on purpose: anyone can read how the set was made. The generated
 * personas, chats, questions and answers are private. The manifest records
 * the SHA-256 of every prompt text (PROMPT_TEXTS_V2). Seed lists share no
 * entry with v1's, so no v2 persona repeats a v1 occupation, hobby or life arc.
 * Nothing here names a real person or organization.
 */
import { AUDIT_SCHEMA, AUDIT_SYSTEM, FILLER_TOPICS as V1_FILLER_TOPICS, TURNS_SCHEMA, auditUser } from './sealed-confirmation-prompts.ts';

export { AUDIT_SCHEMA, AUDIT_SYSTEM, TURNS_SCHEMA, auditUser };

/** Plans (the labels' source) and fact audits use the stronger model; long chats and fillers use the cheaper one, and every chat must pass the audit. */
export const GENERATOR_MODEL_V2 = 'gpt-6-sol';
export const SESSION_MODEL_V2 = 'gpt-6-luna';
export const AUDIT_MODEL_V2 = 'gpt-6-sol';
export const FILLER_MODEL_V2 = 'gpt-6-luna';

export const QUESTION_SLOTS_V2 = ['multi-session', 'multi-session', 'temporal-reasoning', 'knowledge-update', 'abstention'] as const;

export const OCCUPATIONS_V2 = [
  'subway signal technician', 'hospice social worker', 'commercial beekeeper', 'county surveyor', 'airline gate agent',
  'cooperage apprentice', 'neonatal respiratory therapist', 'harbor pilot', 'pipe organ builder', 'recycling plant supervisor',
  'high school debate coach', 'textile dye chemist', 'mobile dog groomer', 'wind turbine technician', 'court stenographer',
  'ski patroller', 'optometrist', 'tugboat deckhand', 'pastry instructor', 'grain elevator operator',
  'animal shelter director', 'medical coder', 'theater costume maker', 'locksmith', 'ophthalmic photographer',
  'forestry nursery manager', 'emergency dispatcher', 'violin maker', 'fish hatchery technician', 'orthodontist assistant',
  'rare book appraiser', 'railway conductor', 'solar panel installer', 'meteorology intern', 'hearing aid specialist',
  'cider maker', 'sports physiotherapy aide', 'print shop owner', 'zookeeper for reptiles', 'customs broker',
  'glassblower', 'irrigation designer', 'crossword editor', 'night-shift baker', 'addiction counselor',
];

export const HOBBIES_V2 = [
  'aerial silks', 'bagpipes', 'banjo', 'basket weaving', 'beekeeping at home', 'blacksmithing', 'bird banding volunteering', 'bowling league',
  'bread scoring art', 'butterfly gardening', 'cajon drumming', 'carpentry for a tiny house', 'cave exploring', 'ceramic glazing chemistry',
  'chainmail making', 'clay animation', 'coffee roasting', 'competitive jump rope', 'cooking through a cookbook', 'curling',
  'darts league', 'dragon boat paddling', 'drone photography', 'dumpling folding', 'enamel pin design', 'falconry lessons',
  'fantasy map drawing', 'foraging seaweed', 'french horn', 'furniture reupholstery', 'glass bead lampworking', 'gold panning',
  'handball', 'hand lettering', 'herbal tea blending', 'historical reenactment', 'hula hooping', 'ice fishing',
  'indoor rock gardens', 'javelin throwing', 'jewelry casting', 'kayak building', 'kendo', 'knife sharpening',
  'lacrosse coaching', 'lapidary', 'learning Korean', 'learning Swahili', 'learning Welsh', 'letterpress printing',
  'macrame', 'magic tricks', 'mandolin', 'marbled paper making', 'metal detecting', 'meteor shower photography',
  'micro-greens growing', 'model rocketry', 'moth trapping', 'natural dyeing', 'night sky sketching', 'noodle pulling',
  'oboe', 'oil painting landscapes', 'outrigger canoeing', 'paddleboard yoga', 'paper quilling', 'parkour',
  'pasta making', 'pickleball', 'plein air watercolor', 'pottery raku firing', 'puppetry', 'racquetball',
  'rescue horse riding', 'robot combat kits', 'roller derby', 'rug hooking', 'sauerkraut making', 'screen printing',
  'sculling', 'sea glass collecting', 'shadow boxing', 'shortwave listening', 'skateboarding', 'slacklining',
  'snowshoeing', 'soap carving', 'spelunking photography', 'spinning wool', 'squash', 'stained glass',
  'stand-up bass', 'storm chasing', 'street photography', 'sumi-e ink painting', 'surf fishing', 'taxidermy classes',
  'tea ceremony', 'tintype photography', 'topiary', 'track cycling', 'trombone', 'tuba',
  'turntable collecting', 'underwater hockey', 'upholstered chair restoring', 'vegan baking', 'volleyball league', 'wakeboarding',
  'water polo', 'wax seal making', 'whittling', 'wine label collecting', 'wood burning art', 'woodland bushcraft',
  'writing sonnets', 'xylophone', 'yodeling lessons', 'zine making', 'zither', 'ceilidh dancing', 'bolo tie crafting', 'accordion',
];

export const LIFE_ARCS_V2 = [
  'selling a family home and splitting proceeds with siblings', 'going back to school part-time for a nursing degree', 'building an accessory dwelling in the backyard',
  'recovering from a burnout leave and returning to work', 'planning and hosting a milestone birthday trip for a parent', 'getting a small food cart permitted and opened',
  'training for a long-distance charity walk', 'adopting a retired racing greyhound', 'moving abroad for a two-year work contract',
  'dealing with a flooded basement and the insurance claim', 'organizing a sibling\'s surprise wedding shower', 'learning to swim as an adult',
  'fixing up and selling a vintage camper van', 'becoming a foster parent for teenagers', 'switching from renting to buying a townhouse',
  'running a school fundraiser as the parent-teacher group treasurer', 'writing and self-publishing a cookbook', 'caring for a spouse through chemotherapy',
  'starting a pottery studio in a rented garage', 'preparing a thesis defense', 'taking over a late uncle\'s hardware store',
  'planning a cross-country move with three pets', 'getting a chronic back condition diagnosed and treated', 'restoring a century-old farmhouse',
  'coaching a robotics team to a regional competition', 'launching a podcast about local history', 'going through a divorce and co-parenting setup',
  'organizing a neighborhood solar co-op', 'training a service dog in partnership with a charity', 'saving for and planning a sabbatical year',
  'managing a parent\'s estate after a death', 'building a tiny house on wheels', 'preparing for a citizenship test and interview',
  'running a community theater production as director', 'starting a beehive-to-honey side business', 'rebuilding credit after a bankruptcy',
  'planning a large family holiday gathering abroad', 'studying for a commercial driver license', 'reviving a closed neighborhood bakery',
  'coordinating a class reunion for a graduating year', 'converting a garage into a home recording studio', 'learning to sail and buying a small boat',
];

export const HOUSEHOLDS_V2 = [
  'lives alone with a cat', 'lives with a spouse and a teenage stepson', 'lives with two roommates', 'lives with an adult sister',
  'lives with a partner and twins in grade school', 'lives with a grandparent they care for', 'lives with a partner and a toddler', 'lives with a spouse, no children',
];

export const FILLER_TOPICS_V2 = V1_FILLER_TOPICS;

// ─── Persona plan ─────────────────────────────────────────────────

export const PLAN_SYSTEM_V2 = `You design hard test data for a benchmark of long-term memory in chat assistants. You invent one fictional person and plan a long series of chat sessions that person has with an AI assistant over most of a year, plus five questions whose answers can only be reached by combining details scattered across several of those sessions. Everything must be invented: people, pets, businesses, organizations, streets and towns. Never use a real person, celebrity, company, brand or product name. Use plausible but uncommon invented names. Output only JSON that matches the schema.`;

export interface PlanSeedV2 {
  persona_index: number;
  given_initial: string;
  surname_initial: string;
  occupation: string;
  hobbies: string[];
  life_arc: string;
  household: string;
  start_date: string;
}

export function planUserV2(seed: PlanSeedV2): string {
  return `Design persona ${seed.persona_index} with these fixed attributes:
- given name starts with "${seed.given_initial}", surname starts with "${seed.surname_initial}" (invent both; avoid famous names)
- occupation: ${seed.occupation}
- hobbies: ${seed.hobbies.join('; ')}
- household: ${seed.household}
- main life arc during these months: ${seed.life_arc}
- the first session is on ${seed.start_date}

Plan 15 to 17 chat sessions with dates strictly increasing, spread over eight to twelve months starting on ${seed.start_date}. Each session has a topic and a concrete reason the user is talking to the assistant (advice, a plan, a draft, a comparison, an explanation). Topics mix the life arc, the occupation, the hobbies and ordinary errands. Sessions will be long, so give each a topic rich enough for a long conversation.

Write facts: short first-person statements the user reveals, each assigned to exactly one session. Every session carries two to four facts. Facts are specific (names, numbers, places, dates, prices, counts) and none repeats another's content. A fact describing an event gets an event_date (on or before its session date); otherwise event_date is null. Mark each fact's purpose:
- "question_evidence": needed to answer one of the five questions;
- "near_miss": deliberately similar to question evidence but not the answer (a friend's similar event, an option considered and rejected, a count in a different context); include at least six, spread over different sessions;
- "background": other life details.

Write exactly five questions, asked by the user at a later date (question_date after the last session). Each answer must follow only from the question_evidence facts it lists, with no outside knowledge, and no single session may contain enough to answer any answerable question:
1. "multi-session" (first): an aggregation (a total, a sum of money or time, or a count) that needs one part from each of three to five different sessions, at least two months apart in total.
2. "multi-session" (second): a list, comparison or combination (for example which option ended up cheapest, or every item in a set) that needs three to five different sessions. It must not share evidence facts or sessions' facts with the first multi-session question.
3. "temporal-reasoning": needs dates from two to four sessions whose dates span at least 90 days: the time elapsed between events described in different sessions, the order of several events, or how long before the question_date something happened. Use event_dates or session dates, and state the arithmetic in the rationale.
4. "knowledge-update": one detail is set in one session and then changed at least twice in later sessions (at least three sessions in total, each change in a different session, at least 30 days between the first and last). The question asks for the current value; the answer is the latest value. List every value's fact and session as evidence, in time order. Earlier sessions must not hint at later changes.
5. "abstention": asks for a plausible detail about something discussed in at least two sessions, but that detail is never stated anywhere. List the related facts and sessions as evidence, set must_never_state to the missing detail, and write the answer as an explanation of what is known and that the detail was never mentioned.

Questions are natural, in the user's voice, and must not quote facts word for word. No fact is evidence for two questions. Answers are short (one phrase or sentence). For the four answerable questions set must_never_state to an empty string. Session keys look like "S01", fact keys like "F01".`;
}

export const PLAN_SCHEMA_V2 = {
  type: 'object',
  additionalProperties: false,
  required: ['persona', 'sessions', 'facts', 'questions'],
  properties: {
    persona: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'age', 'occupation', 'home_description', 'household', 'hobbies', 'voice'],
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        occupation: { type: 'string' },
        home_description: { type: 'string' },
        household: { type: 'string' },
        hobbies: { type: 'array', items: { type: 'string' } },
        voice: { type: 'string', description: 'how this person writes chat messages' },
      },
    },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'date', 'topic', 'user_goal'],
        properties: { key: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, topic: { type: 'string' }, user_goal: { type: 'string' } },
      },
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'session_key', 'statement', 'event_date', 'purpose'],
        properties: {
          key: { type: 'string' },
          session_key: { type: 'string' },
          statement: { type: 'string' },
          event_date: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
          purpose: { type: 'string', enum: ['question_evidence', 'near_miss', 'background'] },
        },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'question', 'answer', 'evidence_fact_keys', 'evidence_session_keys', 'question_date', 'must_never_state', 'rationale'],
        properties: {
          type: { type: 'string', enum: ['multi-session', 'temporal-reasoning', 'knowledge-update', 'abstention'] },
          question: { type: 'string' },
          answer: { type: 'string' },
          evidence_fact_keys: { type: 'array', items: { type: 'string' } },
          evidence_session_keys: { type: 'array', items: { type: 'string' } },
          question_date: { type: 'string', description: 'YYYY-MM-DD' },
          must_never_state: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const;

// ─── Session writing ──────────────────────────────────────────────

export const SESSION_SYSTEM_V2 = `You write long, realistic chat logs between a person and an AI assistant, for a benchmark of long-term memory. The user reveals personal details only in passing, the way people do while working through a real task, and the conversation spends most of its length on the task itself. Output only JSON that matches the schema.`;

export interface SessionBriefV2 {
  persona_sheet: string;
  date: string;
  weekday: string;
  topic: string;
  user_goal: string;
  required: Array<{ statement: string; event_date: string | null }>;
  forbidden: string[];
  never_state: string[];
}

export function sessionUserV2(b: SessionBriefV2): string {
  const req = b.required.map((f, i) => `${i + 1}. ${f.statement}${f.event_date ? ` (this happened on ${f.event_date})` : ''}`).join('\n');
  const forb = b.forbidden.length ? b.forbidden.map(s => `- ${s}`).join('\n') : '- (none)';
  const never = b.never_state.length ? b.never_state.map(s => `- ${s}`).join('\n') : '- (none)';
  return `The user:
${b.persona_sheet}

This chat takes place on ${b.date} (a ${b.weekday}).
Topic: ${b.topic}
Why the user opened the chat: ${b.user_goal}

The user must reveal every one of these facts during the chat, each with its specific details intact (names, numbers, amounts, dates):
${req}

Rules:
- Start with a user message. Write 8 to 11 user messages, each followed by an assistant reply. This is a long working session.
- Spread the facts out: reveal them in different user messages, and never more than one fact in the first two user messages or in any single message. At least one fact appears in the second half of the chat.
- User messages are casual (one to five sentences), in the user's voice. Weave each fact in as context for the request; do not list facts or announce them.
- The user sheet is background for voice and consistency. Do not recite it.
- When a fact has a date, say it the way a person would on ${b.date}: "today", "yesterday", "last Tuesday", "on the 14th", "back in March", or a full date. It must match the given date exactly. Never write a date in numeric YYYY-MM-DD form. Do not mention the chat's own date otherwise.
- Assistant replies are helpful, specific and substantial, 120 to 260 words. The assistant never claims to remember earlier chats and never invents facts about the user.
- Do not reveal anything from this list, not even partially or as a hint:
${forb}
- Never state these details in any form (they must stay unknown):
${never}
- Do not add other new named people, pets, purchases, prices or dated events from the user's life beyond the facts above and the user sheet.`;
}


// ─── Filler sessions ──────────────────────────────────────────────

export const FILLER_SYSTEM_V2 = `You write long, realistic chat logs between an anonymous user and an AI assistant. The user asks for general help and reveals nothing about their own life. Output only JSON that matches the schema.`;

export const FILLER_VARIANTS_V2 = [
  'The user wants a thorough step-by-step walkthrough and asks for clarifications along the way.',
  'The user compares several options in depth and pushes back on the assistant\'s first suggestions.',
];

export function fillerUserV2(topic: string, variant: string): string {
  return `Topic: ${topic}
${variant}

Write a long chat that starts with a user message: 7 to 10 user messages, each followed by an assistant reply. The user asks follow-up questions like a curious person would. Assistant replies are 150 to 300 words and accurate.

The user must not reveal any personal detail: no names of family, friends, pets or coworkers; no job, school, employer, location or travel; no purchases, prices paid, health, hobbies, plans, appointments or dates from their life. Keep every user message about the topic itself.`;
}

/** Every prompt text that shapes the v2 corpus, hashed into the manifest. */
export const PROMPT_TEXTS_V2 = {
  PLAN_SYSTEM_V2,
  plan_user_template: planUserV2({ persona_index: 0, given_initial: '{G}', surname_initial: '{S}', occupation: '{occupation}', hobbies: ['{hobby1}', '{hobby2}', '{hobby3}'], life_arc: '{life_arc}', household: '{household}', start_date: '{start_date}' }),
  SESSION_SYSTEM_V2,
  session_user_template: sessionUserV2({ persona_sheet: '{persona_sheet}', date: '{date}', weekday: '{weekday}', topic: '{topic}', user_goal: '{user_goal}', required: [{ statement: '{fact}', event_date: '{event_date}' }], forbidden: ['{forbidden}'], never_state: ['{never_state}'] }),
  AUDIT_SYSTEM,
  audit_user_template: auditUser('{date}', '{weekday}', '{transcript}', ['{statement}'], ['{detail}']),
  FILLER_SYSTEM_V2,
  filler_user_template: fillerUserV2('{topic}', '{variant}'),
  FILLER_VARIANTS_V2: JSON.stringify(FILLER_VARIANTS_V2),
  PLAN_SCHEMA_V2: JSON.stringify(PLAN_SCHEMA_V2),
  TURNS_SCHEMA: JSON.stringify(TURNS_SCHEMA),
  AUDIT_SCHEMA: JSON.stringify(AUDIT_SCHEMA),
};
