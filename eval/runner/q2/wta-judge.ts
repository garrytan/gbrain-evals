/**
 * Q2 G6 answer judging: rubric `q2-wta-judge-v1` scores answerable and unanswerable items separately.
 *
 *   answerable    correct only when the response gives the reference (every person and no other for names; the
 *                 date for dates; the employer set for "where"); UNKNOWN or a refusal is incorrect
 *   unanswerable  the documents never settle the question: correct only when the response says it does not know
 *                 or that the brain does not say (UNKNOWN); any concrete answer is a false answer
 * The judge returns { correct, false_answer }. A 10% second-judge audit (claude-opus-5-5) re-judges a deterministic
 * hash-selected subset and reports agreement; it never changes a score.
 */
import { createHash } from 'node:crypto';
import type { QQuestion } from './q-set.ts';

export const WTA_RUBRIC_VERSION = 'q2-wta-judge-v1';
export const WTA_JUDGE_SYSTEM = 'You grade answers to questions about a person\'s records. You reply with one JSON object and nothing else.';

export function wtaJudgePrompt(q: Pick<QQuestion, 'question' | 'answer' | 'answerable'>, response: string): string {
  const head = [`Question: ${q.question}`, `Response: ${response || '(no answer)'}`];
  if (!q.answerable) return [...head, '',
    'The records never settle this question: the correct response says the answer is unknown or not in the records (for example UNKNOWN).',
    'Grade: "correct" is true only if the response declines to give a concrete answer and says it does not know or cannot find it. "false_answer" is true if the response asserts any concrete answer (a name, company or date), even hedged.',
    'Reply with JSON: {"correct": true | false, "false_answer": true | false}'].join('\n');
  return [...head, `Reference answer: ${q.answer}`, '',
    'Grade: "correct" is true only if the response gives the reference answer. For people, it must name every person in the reference and no other (first names alone are enough when unambiguous). For companies, every company in the reference and no other. For a date, the reference date. UNKNOWN or a refusal is incorrect. "false_answer" is true if the response asserts a concrete answer that is wrong.',
    'Reply with JSON: {"correct": true | false, "false_answer": true | false}'].join('\n');
}

export const WTA_RUBRIC_SHA256 = createHash('sha256').update(WTA_JUDGE_SYSTEM + '\n' + wtaJudgePrompt({ question: '{question}', answer: '{answer}', answerable: true }, '{response}') + '\n' + wtaJudgePrompt({ question: '{question}', answer: '{answer}', answerable: false }, '{response}')).digest('hex');

export interface WtaVerdict { correct: 0 | 1; false_answer: 0 | 1 }
export function parseWtaVerdict(o: Record<string, unknown> | null): WtaVerdict | null {
  if (!o || typeof o.correct !== 'boolean') return null;
  return { correct: o.correct ? 1 : 0, false_answer: o.false_answer === true ? 1 : 0 };
}

/** The deterministic audit subset: about `fraction` of answer keys, by hash. */
export function inAudit(answerKey: string, fraction = 0.1): boolean {
  return parseInt(createHash('sha256').update(`q2-wta-audit-v1\u0000${answerKey}`).digest('hex').slice(0, 8), 16) / 2 ** 32 < fraction;
}
