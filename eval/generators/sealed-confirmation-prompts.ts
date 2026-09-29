/**
 * Frozen prompts and seed lists for the sealed confirmation generator.
 *
 * These are public on purpose: anyone can read how the sealed set was made.
 * The generated personas, conversations, questions and answers are private.
 * The manifest records the SHA-256 of this file's prompt texts
 * (PROMPT_TEXTS), so a later edit is visible as a new prompt hash rather
 * than a silent change to an existing set.
 *
 * Nothing here names a real person or organization. The generator asks the
 * model to invent every name.
 */

export const GENERATOR_MODEL = 'gpt-6-sol';
export const AUDIT_MODEL = 'gpt-6-sol';

/** Occupations, one per persona, never reused inside a set. */
export const OCCUPATIONS = [
  'pediatric nurse', 'high school chemistry teacher', 'municipal water engineer', 'freelance court interpreter', 'ferry mechanic',
  'orchestra librarian', 'veterinary technician', 'wedding cake baker', 'air traffic controller trainee', 'public defender paralegal',
  'museum conservator', 'long-haul truck dispatcher', 'hospital pharmacist', 'landscape architect', 'sign language teacher',
  'wildland firefighter', 'bicycle shop owner', 'community college math tutor', 'food truck operator', 'archival film restorer',
  'physical therapist', 'insurance claims adjuster', 'greenhouse manager', 'piano tuner', 'school bus driver',
  'clinical research coordinator', 'bookbinder', 'marine research technician', 'stage lighting designer', 'dental hygienist',
  'tax preparer', 'farrier', 'radio news producer', 'elevator inspector', 'hotel night auditor', 'occupational safety officer',
];

/** Hobbies; each persona draws three, never shared with another persona in the set. */
export const HOBBIES = [
  'sourdough baking', 'trail running', 'birdwatching', 'amateur astronomy', 'wheel-thrown pottery', 'correspondence chess',
  'indoor bouldering', 'sweater knitting', 'home brewing', 'furniture woodworking', 'salsa dancing', 'geocaching',
  'sea kayaking', 'urban sketching', 'community theater', 'fly fishing', 'stamp collecting', 'ukulele',
  'brush calligraphy', 'mushroom foraging', 'bonsai', 'board game design', 'marathon training', 'family history research',
  'planted aquariums', 'orienteering', 'hand embroidery', 'film photography', 'audio drama podcasting', 'bicycle touring',
  'choir singing', 'adult literacy tutoring', 'heirloom tomato growing', 'restoring vintage radios', 'quilting', 'recurve archery',
  'cross-country skiing', 'table tennis', 'jigsaw puzzles', 'learning Portuguese', 'learning Japanese', 'crossword construction',
  'kimchi fermentation', 'open-mic comedy', 'swing dancing', 'model railroading', 'fire lookout hiking', 'dinghy sailing',
  'disc golf', 'silent meditation retreats', 'pub trivia', 'cold-process soap making', 'candle making', 'digital illustration',
  'beach cleanups', 'retro console collecting', 'tai chi', 'regional curry cooking', 'cake decorating', 'mosaic tiling',
  'leathercraft', 'origami', 'competitive cribbage', 'rowing', 'figure drawing', 'watch repair', 'hot sauce making',
  'lindy hop', 'rock tumbling', 'harmonica', 'violin', 'bouldering route setting', 'amateur radio', 'kite building',
  'mountain biking', 'ice skating', 'terrarium building', 'poetry slams', 'scuba diving', 'book club hosting',
  'cheese making', 'fencing', 'bread-oven building', 'canoe camping', 'weaving on a floor loom', 'yo-yo tricks',
  'badminton', 'fruit tree grafting', 'miniature painting', 'snorkeling', 'improv classes', 'chili cook-offs',
  'glass fusing', 'dog agility', 'pinball restoration', 'wild swimming', 'map collecting', 'speed cubing',
];

/** One life arc per persona; the arc supplies the topic history the questions draw on. */
export const LIFE_ARCS = [
  'moving to a new apartment across town', 'training a newly adopted rescue dog', 'planning a small wedding', 'helping an aging parent move into assisted living',
  'starting a weekend side business', 'recovering from a knee injury', 'renovating a kitchen on a budget', 'preparing for a professional certification exam',
  'learning to drive as an adult', 'planning a long overseas trip', 'adopting two cats', 'organizing a family reunion',
  'switching to a new career field', 'buying a first car', 'running for a seat on a local library board', 'starting a community garden plot',
  'preparing for a first baby', 'paying down credit card debt', 'training for a first triathlon', 'writing a first novel',
  'downsizing to a smaller home', 'organizing a charity auction', 'working toward a private pilot license', 'fostering kittens for a shelter',
  'restoring an old sailboat', 'launching a neighborhood newsletter', 'changing diet after a new medical diagnosis', 'coaching a youth soccer team',
  'applying to graduate school', 'redesigning a backyard garden', 'caring for a sibling after surgery', 'learning to play in a local band',
];

export const HOUSEHOLDS = [
  'lives alone', 'lives with a partner', 'lives with a partner and two young children', 'lives with a roommate', 'lives with a widowed parent',
  'single parent of a teenager', 'lives with a spouse and a grown child who moved back home', 'lives with a partner and a newborn',
];

/** Filler topics: general-help chats with no personal facts. Each topic seeds one filler session per variant. */
export const FILLER_TOPICS = [
  'explaining how public-key cryptography works', 'debugging an off-by-one error in a Python loop', 'writing a SQL query with a window function',
  'the difference between baking soda and baking powder', 'how tides are caused', 'summarizing the causes of the French Revolution',
  'tips for writing a cover letter in general', 'how to calculate compound interest', 'explaining photosynthesis to a ten-year-old',
  'converting a recipe from metric to imperial units', 'how vaccines train the immune system', 'regular expressions for matching email addresses',
  'how a bill becomes law in a parliamentary system', 'the rules of cricket', 'explaining the Monty Hall problem', 'how noise-cancelling headphones work',
  'writing a haiku about autumn', 'the history of the printing press', 'how to structure a persuasive essay', 'explaining Big-O notation',
  'how to sharpen a kitchen knife', 'the water cycle', 'what causes inflation', 'how to write unit tests in JavaScript',
  'translating a short paragraph into Spanish', 'how black holes form', 'comparing TCP and UDP', 'writing a limerick about a cat',
  'the basics of music theory chords', 'how to remove a red wine stain', 'the plot structure of classic tragedies', 'explaining CRISPR gene editing',
  'writing a bash script to rename files', 'how compound words work in German', 'the causes of the seasons', 'how credit scores are calculated in general',
  'explaining recursion with an example', 'how to brew pour-over coffee', 'the difference between weather and climate', 'writing a product description for a generic desk lamp',
  'how electric cars regenerate energy when braking', 'basic first aid for minor burns', 'how to format a bibliography in APA style', 'what makes bread rise',
  'explaining the prisoner\'s dilemma', 'the history of the Silk Road', 'how to pick a strong password', 'writing a regular expression for phone numbers',
  'how solar panels generate electricity', 'explaining supply and demand', 'how to make a basic vinaigrette', 'the difference between viruses and bacteria',
  'writing a CSS flexbox layout', 'how airplanes stay in the air', 'the rules of chess castling', 'explaining the Pythagorean theorem',
  'the life cycle of a star', 'how to write a good meeting agenda in general', 'what is a Fourier transform', 'the history of the bicycle',
  'how to care for a cast iron pan', 'explaining Git rebase versus merge', 'the causes of the Great Depression', 'writing a short fable with a moral',
  'how earthquakes are measured', 'the basics of probability with dice', 'how to proofread effectively', 'the difference between affect and effect',
  'how a refrigerator works', 'explaining machine learning overfitting', 'the structure of DNA', 'writing a thank-you note template',
  'how coral reefs form', 'the rules of basketball fouls', 'how to estimate square footage of a room shape', 'explaining the greenhouse effect',
  'writing a JSON schema for a simple object', 'the history of paper money', 'how to memorize a speech', 'explaining how a hash map works',
  'the difference between a latte and a cappuccino', 'how volcanoes erupt', 'writing a riddle', 'the basics of Roman numerals',
  'how to convert Celsius to Fahrenheit', 'explaining the stock market in simple terms', 'the migration of monarch butterflies', 'how to write a haiku sequence',
];

// ─── Persona plan ─────────────────────────────────────────────────

export const PLAN_SYSTEM = `You design test data for a benchmark of long-term memory in chat assistants. You invent one fictional person and plan a series of chat sessions that person has with an AI assistant over several months, plus five questions whose answers depend on remembering those sessions. Everything must be invented: people, pets, businesses, organizations, streets and towns. Never use a real person, celebrity, company, brand or product name. Use plausible but uncommon invented names. Output only JSON that matches the schema.`;

export interface PlanSeed {
  persona_index: number;
  given_initial: string;
  surname_initial: string;
  occupation: string;
  hobbies: string[];
  life_arc: string;
  household: string;
  start_date: string;
}

export function planUser(seed: PlanSeed): string {
  return `Design persona ${seed.persona_index} with these fixed attributes:
- given name starts with "${seed.given_initial}", surname starts with "${seed.surname_initial}" (invent both; avoid famous names)
- occupation: ${seed.occupation}
- hobbies: ${seed.hobbies.join('; ')}
- household: ${seed.household}
- main life arc during these months: ${seed.life_arc}
- the first session is on ${seed.start_date}

Plan 18 to 22 chat sessions with dates strictly increasing, spread over four to seven months starting on ${seed.start_date}. Each session has a topic and a concrete reason the user is talking to the assistant (asking for advice, a plan, a draft, a recommendation, an explanation). Topics should mix the life arc, the occupation, the hobbies and ordinary errands.

Write facts: short first-person statements the user reveals, each assigned to exactly one session. Every session carries one to three facts. Facts must be specific (names, numbers, places, dates, prices, counts), and none may repeat another fact's content. A fact that describes an event gets an event_date (on or before its session date); otherwise event_date is null. Mark each fact's purpose:
- "question_evidence": needed to answer one of the five questions;
- "near_miss": deliberately similar to question evidence but not the answer (a friend's similar event, an option considered and rejected, a different count in a different context); include at least four;
- "background": other life details that make the history realistic.

Write exactly five questions, one of each type, asked by the user at a later date (question_date after the last session). The answer must follow only from the question_evidence facts it lists, with no outside knowledge:
1. "single-session-user": asks for one specific detail stated in a single session. Exactly one evidence session.
2. "multi-session": needs combining facts from two to four different sessions (a total, a count, or a list). Each evidence session contributes a needed part; the answer states the combined result.
3. "temporal-reasoning": needs dates: the order of events, the time elapsed between two events, or how long ago something happened relative to the question_date. Use event_dates or session dates; state the arithmetic in the rationale. One to three evidence sessions.
4. "knowledge-update": a detail stated in an earlier session changes in a later session (a new price, a moved date, a changed choice, an updated count). The question asks for the current value; the answer is the latest value. List both the old-value and the new-value facts and both sessions as evidence. The earlier session must not hint at the later change.
5. "abstention": asks for a plausible detail about something that was discussed, but that detail is never stated in any session (for example, the name of a pet whose name never came up). List the related facts and sessions as evidence, set must_never_state to the missing detail, and write the answer as an explanation of what is known and that the asked detail was never mentioned.

Questions must be natural, in the user's voice, and must not quote the facts word for word. Do not reuse the same fact as evidence for two different questions. Answers must be short (one phrase or sentence). For the four answerable questions set must_never_state to an empty string. Session keys look like "S01", fact keys like "F01".`;
}

export const PLAN_SCHEMA = {
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
          type: { type: 'string', enum: ['single-session-user', 'multi-session', 'temporal-reasoning', 'knowledge-update', 'abstention'] },
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

export const SESSION_SYSTEM = `You write realistic chat logs between a person and an AI assistant, for a benchmark of long-term memory. The user reveals personal details only in passing, the way people do when asking for help. Output only JSON that matches the schema.`;

export interface SessionBrief {
  persona_sheet: string;
  date: string;
  weekday: string;
  topic: string;
  user_goal: string;
  required: Array<{ statement: string; event_date: string | null }>;
  forbidden: string[];
  never_state: string[];
}

export function sessionUser(b: SessionBrief): string {
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
- Start with a user message. Write 5 to 9 user messages, each followed by an assistant reply.
- User messages are casual and short (one to four sentences), in the user's voice. Weave each fact in naturally as context for the request; do not list facts or announce them.
- The user sheet is background for voice and consistency. Do not recite it: the user does not introduce themselves or list their age, job, household or hobbies unless the request genuinely needs one of them.
- When a fact has a date, say it the way a person would on ${b.date}: "today", "yesterday", "last Tuesday", "on the 14th", or a full date. It must match the given date exactly. Never write a date in numeric YYYY-MM-DD form. Do not mention the chat's own date otherwise.
- Assistant replies are helpful and specific, 60 to 220 words. The assistant never claims to remember earlier chats and never invents facts about the user.
- Do not reveal anything from this list, not even partially or as a hint:
${forb}
- Never state these details in any form (they must stay unknown):
${never}
- Do not add other new named people, pets, purchases, prices or dated events from the user's life beyond the facts above and the user sheet.`;
}

export const TURNS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['turns'],
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'content'],
        properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } },
      },
    },
  },
} as const;

// ─── Fact audit ───────────────────────────────────────────────────

export const AUDIT_SYSTEM = `You check chat logs against a list of statements. Judge only what the chat itself establishes about the user, read as of the chat's date. Output only JSON that matches the schema.`;

export function auditUser(date: string, weekday: string, transcript: string, statements: string[], details: string[]): string {
  return `Chat date: ${date} (a ${weekday})

Chat:
${transcript}

For each numbered statement, decide whether the chat establishes it about the user:
- "stated": the chat clearly conveys it with the same specifics (a dated statement counts only if the chat implies that same date, read from the chat's date);
- "contradicted": the chat conveys something incompatible;
- "not_stated": otherwise.

Statements:
${statements.map((s, i) => `${i + 1}. ${s}`).join('\n')}

For each numbered detail, answer whether the chat reveals it (true) or not (false):
${details.length ? details.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(none)'}`;
}

export const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['statements', 'details'],
  properties: {
    statements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'verdict'],
        properties: { index: { type: 'integer' }, verdict: { type: 'string', enum: ['stated', 'not_stated', 'contradicted'] } },
      },
    },
    details: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'revealed'],
        properties: { index: { type: 'integer' }, revealed: { type: 'boolean' } },
      },
    },
  },
} as const;

// ─── Filler sessions ──────────────────────────────────────────────

export const FILLER_SYSTEM = `You write realistic chat logs between an anonymous user and an AI assistant. The user asks for general help and reveals nothing about their own life. Output only JSON that matches the schema.`;

export const FILLER_VARIANTS = [
  'The user is a beginner and asks basic questions.',
  'The user already knows the basics and asks detailed, advanced questions.',
];

export function fillerUser(topic: string, variant: string): string {
  return `Topic: ${topic}
${variant}

Write a chat that starts with a user message: 4 to 7 user messages, each followed by an assistant reply. The user asks follow-up questions like a curious person would. Assistant replies are 80 to 250 words and accurate.

The user must not reveal any personal detail: no names of family, friends, pets or coworkers; no job, school, employer, location or travel; no purchases, prices paid, health, hobbies, plans, appointments or dates from their life. Keep every user message about the topic itself.`;
}

/** Every prompt text that shapes the corpus, hashed into the manifest. */
export const PROMPT_TEXTS = {
  PLAN_SYSTEM,
  plan_user_template: planUser({ persona_index: 0, given_initial: '{G}', surname_initial: '{S}', occupation: '{occupation}', hobbies: ['{hobby1}', '{hobby2}', '{hobby3}'], life_arc: '{life_arc}', household: '{household}', start_date: '{start_date}' }),
  SESSION_SYSTEM,
  session_user_template: sessionUser({ persona_sheet: '{persona_sheet}', date: '{date}', weekday: '{weekday}', topic: '{topic}', user_goal: '{user_goal}', required: [{ statement: '{fact}', event_date: '{event_date}' }], forbidden: ['{forbidden}'], never_state: ['{never_state}'] }),
  AUDIT_SYSTEM,
  audit_user_template: auditUser('{date}', '{weekday}', '{transcript}', ['{statement}'], ['{detail}']),
  FILLER_SYSTEM,
  filler_user_template: fillerUser('{topic}', '{variant}'),
  FILLER_VARIANTS: JSON.stringify(FILLER_VARIANTS),
  PLAN_SCHEMA: JSON.stringify(PLAN_SCHEMA),
  TURNS_SCHEMA: JSON.stringify(TURNS_SCHEMA),
  AUDIT_SCHEMA: JSON.stringify(AUDIT_SCHEMA),
};
