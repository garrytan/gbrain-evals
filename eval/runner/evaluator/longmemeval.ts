/**
 * LongMemEval evaluator side: a separate gold loader, the gold-free view the
 * runner builds product inputs from, and the input allowlists for the system
 * under test and the reader.
 *
 * The runner and the gold loader read the dataset file independently. The
 * runner keeps only `longMemEvalSutView` objects, which have no answer and
 * no evidence labels; scoring goes through the gold store. The loader checks
 * that it read the same bytes as the runner.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Question } from '../longmemeval.ts';
import type { Boundary, ForbiddenValue } from './allowlist.ts';
import { GoldStore } from './gold-store.ts';
import { scoreSessionRecall, type SessionRecallScore } from './reference-scorer.ts';

export type LmeSutQuestion = Omit<Question, 'answer' | 'answer_session_ids'>;

export interface LmeGold {
  answer: string | number;
  answer_session_ids: string[];
  /** Every raw dataset session id for the question. The product and the reader only ever see opaque ids. */
  raw_session_ids: string[];
}

const OPAQUE_SLUG = /^chat\/s-[0-9a-f]{10}$/;

export const LME_SUT_PAGE: Boundary = {
  name: 'longmemeval.sut.page@1',
  recipient: 'system-under-test',
  schema: { type: 'object', fields: { slug: { type: 'string', pattern: OPAQUE_SLUG }, content: { type: 'string' } } },
};

export const LME_SUT_QUERY: Boundary = {
  name: 'longmemeval.sut.query@1',
  recipient: 'system-under-test',
  schema: { type: 'object', fields: { text: { type: 'string' } } },
};

export const LME_READER_INPUT: Boundary = {
  name: 'longmemeval.reader.input@1',
  recipient: 'reader',
  schema: {
    type: 'object',
    fields: {
      question: { type: 'string' },
      evidence: {
        type: 'array',
        items: { type: 'object', fields: { source_id: { type: 'string', pattern: /^[a-z0-9][a-z0-9_-]*$/ }, slug: { type: 'string', pattern: OPAQUE_SLUG }, text: { type: 'string' } } },
      },
    },
  },
};

export const LME_BOUNDARIES = [LME_SUT_PAGE, LME_SUT_QUERY, LME_READER_INPUT].map(b => b.name);

/** Raw session ids in dataset order, including the runner's fallback id for unnamed sessions. */
export function rawSessionIds(q: Pick<Question, 'question_id' | 'haystack_session_ids' | 'haystack_sessions'>): string[] {
  return q.haystack_sessions.map((raw, i) => {
    const named = Array.isArray(raw) ? q.haystack_session_ids?.[i] : (raw as { session_id?: string })?.session_id;
    return named ?? `lme_${q.question_id}_${i}`;
  });
}

/** The gold-free question the runner renders product inputs from. Explicit fields, never spread-and-delete. */
export function longMemEvalSutView(q: Question): LmeSutQuestion {
  const view: LmeSutQuestion = {
    question_id: q.question_id,
    question_type: q.question_type,
    question: q.question,
    haystack_sessions: q.haystack_sessions,
  };
  if (q.haystack_dates !== undefined) view.haystack_dates = q.haystack_dates;
  if (q.haystack_session_ids !== undefined) view.haystack_session_ids = q.haystack_session_ids;
  return view;
}

export function buildLongMemEvalGold(questions: readonly Question[]): GoldStore<LmeGold> {
  return new GoldStore('longmemeval', questions.map(q => {
    if (!Array.isArray(q.answer_session_ids) || q.answer_session_ids.some(id => typeof id !== 'string')) throw new Error(`longmemeval gold: ${q.question_id} has no answer_session_ids list`);
    return [q.question_id, { answer: q.answer, answer_session_ids: [...q.answer_session_ids], raw_session_ids: rawSessionIds(q) }] as const;
  }));
}

/** The separate gold loader: reads the dataset itself and refuses bytes that differ from what the runner loaded. */
export function loadLongMemEvalGold(datasetPath: string, expectedSha256: string): GoldStore<LmeGold> {
  const bytes = readFileSync(datasetPath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) throw new Error(`longmemeval gold: dataset bytes changed between the runner and the gold loader (${actual} != ${expectedSha256})`);
  const questions = JSON.parse(bytes.toString('utf8')) as Question[];
  if (!Array.isArray(questions)) throw new Error('longmemeval gold: dataset must be a JSON array');
  return buildLongMemEvalGold(questions);
}

type RawTurn = { role?: unknown; content?: unknown };

/** Dataset-provided text of one session (date, roles, turn contents): what the product is meant to see, before rendering. */
export function lmeSessionMaterial(session: { date?: string; turns: readonly RawTurn[] }): string[] {
  return [session.date ?? '', ...session.turns.flatMap(t => [String(t.role ?? ''), String(t.content ?? '')])];
}

/** Dataset-provided text of a whole question: its wording plus every session's material. */
export function lmeQuestionMaterial(q: Pick<Question, 'question' | 'haystack_dates' | 'haystack_sessions'>): string[] {
  return [q.question, ...q.haystack_sessions.flatMap((raw, i) => {
    const turns = Array.isArray(raw) ? raw : (raw as { turns?: RawTurn[] })?.turns;
    return Array.isArray(turns) ? lmeSessionMaterial({ date: q.haystack_dates?.[i], turns }) : [];
  })];
}

export function lmeForbiddenValues(gold: GoldStore<LmeGold>, questionId: string): ForbiddenValue[] {
  return gold.score(questionId, g => [...new Set([...g.raw_session_ids, ...g.answer_session_ids])]
    .map(id => ({ value: id, label: g.answer_session_ids.includes(id) ? 'raw evidence session id' : 'raw session id' })));
}

export function scoreLmeRetrieval(gold: GoldStore<LmeGold>, questionId: string, retrieved: readonly string[], k: number): SessionRecallScore {
  return gold.score(questionId, g => scoreSessionRecall(retrieved, g.answer_session_ids, k));
}
