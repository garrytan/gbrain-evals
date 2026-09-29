/**
 * Input allowlists for the reading-notes reader, the Cat29 answerer and
 * pairwise judge, and the Cat35 system under test and judges (plan amendment
 * 6, v0.10.1).
 *
 * Each boundary declares the exact fields a payload may carry (allowlist.ts
 * rejects anything else, at any depth) plus the evaluator-only values that
 * must not appear beyond what the payload's source material accounts for:
 *
 *   reading-notes  the reader gets opaque session ids only; raw dataset
 *                  session ids (the `answer_` prefix marks gold) may appear
 *                  only as often as the conversations themselves mention them.
 *   Cat29          the system under test gets the question only, never the
 *                  expected facts or gold slugs; the pairwise judge gets two
 *                  answers under neutral labels, and no system identity may
 *                  appear beyond what the answers and pages themselves say.
 *   Cat35          the system under test (ingest, facts, dream) never sees a
 *                  gold item, distractor or hazard id; the coverage judge sees
 *                  paraphrased statements and never the verbatim anchors
 *                  beyond what the judged document quotes; the leak judge
 *                  gets declared fields only; the usability judge never sees gold statements beyond the
 *                  pages it grades.
 */
import { assertPayload, withPermitted, MIN_FORBIDDEN_LENGTH, type Boundary, type ForbiddenValue } from './allowlist.ts';

const longEnough = (value: string) => typeof value === 'string' && value.length >= MIN_FORBIDDEN_LENGTH;
const forbid = (values: readonly string[], label: string): ForbiddenValue[] =>
  [...new Set(values.filter(longEnough))].map(value => ({ value, label }));

// ─── Reading notes ─────────────────────────────────────────────────────

const OPAQUE_SLUG = /^chat\/s-[0-9a-f]{10}$/;
const READING_DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{4}\/\d{2}\/\d{2} \((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\) \d{2}:\d{2})$/;

export const READING_NOTES_READER_INPUT: Boundary = {
  name: 'reading-notes.reader.input@1',
  recipient: 'reader',
  schema: {
    type: 'object',
    fields: {
      question: { type: 'string' },
      question_date: { type: 'string', pattern: READING_DATE, optional: true },
      evidence: {
        type: 'array',
        items: { type: 'object', fields: {
          slug: { type: 'string', pattern: OPAQUE_SLUG },
          date: { type: 'string', pattern: READING_DATE, optional: true },
          text: { type: 'string' },
        } },
      },
    },
  },
};

/** The exact request the native reader would send, captured offline. */
export const READING_NOTES_READER_REQUEST: Boundary = {
  name: 'reading-notes.reader.request@1',
  recipient: 'reader',
  schema: {
    type: 'object',
    fields: {
      model: { type: 'string' },
      system: { type: 'string' },
      max_tokens: { type: 'number' },
      messages: { type: 'array', items: { type: 'object', fields: { role: { type: 'string', pattern: /^user$/ }, content: { type: 'string' } } } },
    },
  },
};

export function readingNotesForbidden(rawSessionIds: readonly string[], material: readonly string[]): ForbiddenValue[] {
  return withPermitted(forbid(rawSessionIds, 'raw dataset session id'), material);
}

// ─── Cat29 ─────────────────────────────────────────────────────────────

export const CAT29_SUT_QUESTION: Boundary = {
  name: 'cat29.sut.question@1',
  recipient: 'system-under-test',
  schema: { type: 'object', fields: { text: { type: 'string' } } },
};

export const CAT29_JUDGE_PAIR: Boundary = {
  name: 'cat29.judge.pair@1',
  recipient: 'reader',
  schema: {
    type: 'object',
    fields: {
      question: { type: 'object', fields: { id: { type: 'string' }, text: { type: 'string' } } },
      ground_truth: { type: 'array', items: { type: 'object', fields: { slug: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } } } },
      rubric: { type: 'array', items: { type: 'object', fields: { id: { type: 'string' }, weight: { type: 'number' }, criterion: { type: 'string' } } } },
      answer_1: { type: 'string' },
      answer_2: { type: 'string' },
    },
  },
};

/** Names that would tell the judge which system wrote an answer. */
export const CAT29_SYSTEM_IDENTITIES = ['runThink', 'gbrain think', 'think arm', 'hybridSearch', 'search arm', 'raw search payload', 'baseline answer', 'treatment answer'];

export interface Cat29JudgeInput {
  question: { id: string; text: string };
  ground_truth: Array<{ slug: string; title: string; content: string }>;
  rubric: Array<{ id: string; weight: number; criterion: string }>;
  answer_1: string;
  answer_2: string;
}

export function assertCat29SutQuestion(text: string, expectedFacts: readonly string[], goldSlugs: readonly string[]): void {
  assertPayload(CAT29_SUT_QUESTION, { text }, [...forbid(expectedFacts, 'expected fact'), ...forbid(goldSlugs, 'gold slug')]);
}

export function assertCat29JudgeInput(input: Cat29JudgeInput): void {
  const material = [input.answer_1, input.answer_2, input.question.text, ...input.ground_truth.flatMap(p => [p.title, p.content])];
  assertPayload(CAT29_JUDGE_PAIR, input, withPermitted(forbid(CAT29_SYSTEM_IDENTITIES, 'system identity'), material));
}

// ─── Cat35 ─────────────────────────────────────────────────────────────

export interface Cat35GoldIds {
  items: ReadonlyArray<{ item_id: string; statement: string; verbatim_anchor: string }>;
  distractors: ReadonlyArray<{ distractor_id: string; anchor: string }>;
  hazards: ReadonlyArray<{ hazard_id: string }>;
}

export const CAT35_SUT_SOURCE: Boundary = {
  name: 'cat35.sut.source@1',
  recipient: 'system-under-test',
  schema: { type: 'object', fields: { slug: { type: 'string' }, content: { type: 'string' } } },
};

export const CAT35_COVERAGE_JUDGE: Boundary = {
  name: 'cat35.judge.coverage@1',
  recipient: 'reader',
  schema: { type: 'object', fields: {
    document: { type: 'string' },
    items: { type: 'array', items: { type: 'object', fields: { item_id: { type: 'string' }, statement: { type: 'string' } } } },
  } },
};

export const CAT35_LEAK_JUDGE: Boundary = {
  name: 'cat35.judge.leak@1',
  recipient: 'reader',
  schema: { type: 'object', fields: {
    document: { type: 'string' },
    hits: { type: 'array', items: { type: 'object', fields: { distractor_id: { type: 'string' }, statement: { type: 'string' } } } },
  } },
};

export const CAT35_USABILITY_JUDGE: Boundary = {
  name: 'cat35.judge.usability@1',
  recipient: 'reader',
  schema: { type: 'object', fields: {
    transcript_id: { type: 'string' },
    pages: { type: 'array', items: { type: 'object', fields: { slug: { type: 'string' }, body: { type: 'string' } } } },
    hasGoldVibes: { type: 'boolean' },
  } },
};

export const CAT35_BOUNDARIES = [CAT35_SUT_SOURCE, CAT35_COVERAGE_JUDGE, CAT35_LEAK_JUDGE, CAT35_USABILITY_JUDGE].map(b => b.name);

/** Gold ids must never reach the system under test, whatever the source text says. */
export function assertCat35SutSource(source: { slug: string; content: string }, gold: readonly Cat35GoldIds[]): void {
  const ids = gold.flatMap(g => [...g.items.map(i => i.item_id), ...g.distractors.map(d => d.distractor_id), ...g.hazards.map(h => h.hazard_id)]);
  assertPayload(CAT35_SUT_SOURCE, source, forbid(ids, 'gold id'));
}

export function assertCat35CoverageInput(input: { document: string; items: Array<{ item_id: string; statement: string }> }, gold: Cat35GoldIds): void {
  assertPayload(CAT35_COVERAGE_JUDGE, input, withPermitted(forbid(gold.items.map(i => i.verbatim_anchor), 'verbatim anchor'), [input.document]));
}

/**
 * Structural check only. The leak judge is shown distractor statements on
 * purpose, and one committed distractor statement quotes its own anchor, so
 * an anchor check here could only fire on intended material. Salient-item
 * anchors, which this judge never needs, are still forbidden.
 */
export function assertCat35LeakInput(input: { document: string; hits: Array<{ distractor_id: string; statement: string }> }, gold: Cat35GoldIds): void {
  assertPayload(CAT35_LEAK_JUDGE, input, withPermitted(forbid(gold.items.map(i => i.verbatim_anchor), 'verbatim anchor'), [input.document, ...input.hits.map(h => h.statement)]));
}

export function assertCat35UsabilityInput(input: { transcript_id: string; pages: Array<{ slug: string; body: string }>; hasGoldVibes: boolean }, gold: Cat35GoldIds): void {
  assertPayload(CAT35_USABILITY_JUDGE, input, withPermitted(forbid(gold.items.map(i => i.statement), 'gold statement'), input.pages.map(p => p.body)));
}
