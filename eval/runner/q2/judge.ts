/**
 * Q2 line labels (G1, G2, G4, adoption recall): judge prompt `q2-judge-v1`, two judges, a disagreement counts as
 * wrong, and there is no adjudication queue. Labels hold verdicts only (no reasons, no line text) and live in the
 * custody work root; receipts carry counts.
 *
 * A line is correct only when every judge returned "correct". An incorrect verdict, a disagreement or a terminal
 * judge failure makes it wrong; a retryable failure leaves it unlabeled, so its gate is "not run" until a rerun
 * labels it.
 */
import { createHash } from 'node:crypto';
import { chatText, firstJsonObject, runPool, type ChatOut } from '../p5-agent.ts';
import { AttemptCheckpoint, withAttempts } from './checkpoints.ts';

export const Q2_JUDGE_PROMPT_VERSION = 'q2-judge-v1';
export const Q2_LINE_JUDGES: readonly string[] = ['claude-opus-5-5', 'gpt-6.1-sol'];

export const Q2_JUDGE_SYSTEM = 'You audit a markdown parser for a personal knowledge base. You answer with one JSON object and nothing else.';

export interface LineToLabel { id: string; kind: 'relation' | 'fact'; parsed: string; text: string; context: string }

export function q2JudgePrompt(m: Pick<LineToLabel, 'kind' | 'parsed' | 'text' | 'context'>): string {
  const what = m.kind === 'relation'
    ? 'a typed relation line: the parser stores the single link on this line as a relationship of the type named by the word before the link'
    : 'a typed fact line: the parser records the text after the bracketed word as a fact filed under that bracketed category';
  return [
    `A parser read the list line below as ${what}. It read it as: ${m.parsed}.`,
    '',
    `Line:\n${m.text}`,
    '',
    `Surrounding lines (context only):\n${m.context}`,
    '',
    'Question: did the author write this line to state exactly that typed relation or fact?',
    'Answer "correct" only if a careful reader would agree the author deliberately wrote this line in that typed form: a relationship of that type to the linked page (relation line), or a claim filed under that category label (fact line).',
    'Answer "incorrect" if the bracketed or leading word is something else: an unfilled template slot, a dictionary or usage label, a timestamp, a checkbox, a citation, a date, a heading-like label for a list, a speaker name, part of a sentence; or if the line does not state a relationship or fact at all, or states a different one.',
    'Reply with JSON: {"verdict": "correct" | "incorrect"}',
  ].join('\n');
}

/** SHA-256 of the frozen prompt: system text and the template with placeholders, recorded in every receipt and the freeze record. */
export const Q2_JUDGE_PROMPT_SHA256 = createHash('sha256').update(Q2_JUDGE_SYSTEM + '\n' + q2JudgePrompt({ kind: 'relation', parsed: '{parsed}', text: '{line}', context: '{context}' }) + '\n' + q2JudgePrompt({ kind: 'fact', parsed: '{parsed}', text: '{line}', context: '{context}' })).digest('hex');

export type LineVerdict = 'correct' | 'incorrect';
export const labelKey = (lineId: string, judge: string) => `${lineId}|${judge}`;

export interface LabelOptions {
  judges?: readonly string[];
  concurrency?: number;
  maxAttempts?: number;
  backoffMs?: number;
  chat?: (model: string, system: string, user: string) => Promise<ChatOut>;
  log?: (s: string) => void;
  /** Stops new calls when the paid-request guard is exhausted. */
  exhausted?: () => boolean;
}

/** Label every line with every judge, skipping finished and terminal (line, judge) pairs. */
export async function labelLines(lines: readonly LineToLabel[], ckpt: AttemptCheckpoint<{ verdict: LineVerdict }>, o: LabelOptions = {}): Promise<{ attempted: number }> {
  const judges = o.judges ?? Q2_LINE_JUDGES;
  const chat = o.chat ?? ((m, s, u) => chatText(m, s, u, { maxTokens: 400 }));
  const todo = lines.flatMap(l => judges.map(j => ({ l, j }))).filter(x => ckpt.todo([labelKey(x.l.id, x.j)]).length);
  let usd = 0;
  await runPool(todo, o.concurrency ?? 6, async ({ l, j }) => {
    if (o.exhausted?.()) throw Object.assign(new Error('budget exhausted'), { name: 'BudgetExceededError' });
    let spent = 0;
    const r = await withAttempts(async () => {
      const out = await chat(j, Q2_JUDGE_SYSTEM, q2JudgePrompt(l));
      spent += out.usd;
      const v = String(firstJsonObject(out.text)?.verdict ?? '').toLowerCase();
      return v as LineVerdict | '';
    }, { maxAttempts: o.maxAttempts ?? 3, backoffMs: o.backoffMs, isValid: v => v === 'correct' || v === 'incorrect' });
    usd += spent;
    ckpt.record(labelKey(l.id, j), { line: l.id, judge: j }, { state: r.state, ...(r.state === 'done' ? { result: { verdict: r.result as LineVerdict } } : {}), error: r.error, usd: spent, attempts: r.attempts });
  });
  o.log?.(`labels: ${todo.length} (line, judge) pairs attempted, $${usd.toFixed(2)}`);
  return { attempted: todo.length };
}

/** correct only when every judge said correct; wrong on any incorrect, disagreement or terminal failure; else unlabeled. */
export function lineOutcome(lineId: string, ckpt: AttemptCheckpoint<{ verdict: LineVerdict }>, judges: readonly string[] = Q2_LINE_JUDGES): 'correct' | 'wrong' | 'unlabeled' {
  const recs = judges.map(j => ckpt.get(labelKey(lineId, j)));
  if (recs.some(r => r?.state === 'terminal' || (r?.state === 'done' && r.result?.verdict === 'incorrect'))) return 'wrong';
  if (recs.every(r => r?.state === 'done' && r.result?.verdict === 'correct')) return 'correct';
  return 'unlabeled';
}
