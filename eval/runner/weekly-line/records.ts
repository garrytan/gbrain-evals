/**
 * The weekly line's values from the records BG1-C's cells write (eval/runner/memory-qa/records.ts answers.ndjson and
 * judgments.ndjson, under <out>/cells/<cell id>/ for each cell and particle-1 re-read): one cell per planned question, row
 * and reader, with BG1-C's rules. A product failure (retrieval error, unsupported, turn cap, context overflow) scores 0 and
 * keeps its outcome, so the grep agent's turn-cap and context-overflow rates come from the same values. A harness failure,
 * any other outcome that is not scored, a missing answer or a missing gating judgment is a drop, by reason. The gating
 * judgment is the reader's mapped judge (gpt-6-astra for claude-opus-5-5, claude-opus-5-5 for particle-1), checked by
 * BG1's gatingProblems (never the reader's own family, the pinned settings, a model version). A judge score other than 0
 * or 1 refuses, because a question scores the share of readers whose answer the judge passes.
 *
 * Refused: an answer from a system that is not one of the four rows, a reader that is not one of the two, a world outside
 * the given worlds, a question that is not planned (<world>:<stratum>:<k>), and two answers for one question, row and reader.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { instrumentFor } from '../memory-qa/instruments.ts';
import { HARNESS_FAILURES, PRODUCT_FAILURES, type Outcome } from '../memory-qa/outcomes.ts';
import { readRecords, type AnswerRecord, type JudgmentRecord } from '../memory-qa/records.ts';
import { frontierInstrumentId } from '../q1/cell.ts';
import { bg1JudgeOf } from '../q1/cells/definitions.ts';
import { gatingProblems } from '../bg1/verdict.ts';
import type { Bg1Stratum } from '../memory-qa/bg1-names.ts';
import { classOf, plannedQuestions, readerKey, WL_READERS, WL_SYSTEMS, type WlClass, type WlReaderKey, type WlRow } from './design.ts';

export class WeeklyRecordsError extends Error {}
const refuse = (m: string): never => { throw new WeeklyRecordsError(m); };

/** One reader's answer in one row: passed (1) or not (0), with the product failure that scored it 0, or why it dropped. */
export type WlCell = { pass: 0 | 1; failure: Outcome | null } | { drop: string };
export interface WlQuestion {
  id: string; world: string; stratum: Bg1Stratum; cls: WlClass;
  rows: Partial<Record<WlRow, Partial<Record<WlReaderKey, WlCell>>>>;
}

export const isDrop = (c: WlCell | undefined): c is { drop: string } | undefined => !c || 'drop' in c;
export const passOf = (c: WlCell | undefined): number | null => (isDrop(c) ? null : c.pass);

/** The planned questions of the worlds, in world order, with no values yet. */
export function plannedFor(worlds: readonly string[]): WlQuestion[] {
  return worlds.flatMap(world => plannedQuestions(world).map(q => ({ id: q.id, world, stratum: q.stratum, cls: classOf(q.stratum), rows: {} })));
}

/** Every answer and judgment record under each directory's cells/<cell id>/. */
export function readRecordDirs(dirs: readonly string[]): { answers: AnswerRecord[]; judgments: JudgmentRecord[] } {
  const answers: AnswerRecord[] = [], judgments: JudgmentRecord[] = [];
  for (const root of dirs) {
    const cells = join(root, 'cells');
    if (!existsSync(cells)) refuse(`${root} has no cells/ directory`);
    for (const d of readdirSync(cells).sort()) {
      answers.push(...readRecords(join(cells, d, 'answers.ndjson'), 'answer'));
      judgments.push(...readRecords(join(cells, d, 'judgments.ndjson'), 'judgment'));
    }
  }
  return { answers, judgments };
}

/** The questions of the worlds with each row's and reader's cell; a planned question no record covers stays without a cell, which reads as a drop. */
export function questionsFromRecords(worlds: readonly string[], answers: readonly AnswerRecord[], judgments: readonly JudgmentRecord[]): WlQuestion[] {
  const instrument = instrumentFor('bg1').id;
  const questions = plannedFor(worlds);
  const byId = new Map(questions.map(q => [q.id, q]));
  const worldSet = new Set(worlds);
  const scoped = answers.filter(a => a.replicate === 0);
  const readerOf = new Map(scoped.map(a => [a.answer_id, a.reader]));
  const js = judgments.filter(j => j.judge_replicate === 0 && readerOf.has(j.answer_id));
  const problems = js.flatMap(j => gatingProblems(j, readerOf.get(j.answer_id), instrument));
  if (problems.length) refuse(`${problems.length} gating judgment problem${problems.length === 1 ? '' : 's'}: ${problems.slice(0, 3).join('; ')}`);
  const score = new Map(js.filter(j => j.view === 'gating').map(j => [`${j.answer_id}|${j.instrument_id}`, j.score]));
  for (const a of scoped) {
    const row = WL_SYSTEMS[a.system] ?? refuse(`an answer comes from system ${a.system}, which is not one of the weekly line's rows`);
    if (!(WL_READERS as readonly string[]).includes(a.reader)) refuse(`an answer is read by ${a.reader}, which is not one of the weekly line's readers`);
    if (!worldSet.has(a.conversation)) refuse(`an answer is on a world outside the given worlds`);
    const q = byId.get(a.question_id) ?? refuse(`an answer's question is not a planned question of its world`);
    if (q.world !== a.conversation) refuse(`an answer's question belongs to another world`);
    const r = readerKey(a.reader);
    const cells = (q.rows[row] ??= {});
    if (cells[r]) refuse(`two answers for one question in row ${row} by ${r}`);
    cells[r] = cellOf(a, score, instrument);
  }
  return questions;
}

function cellOf(a: AnswerRecord, score: ReadonlyMap<string, number | null>, instrument: string): WlCell {
  const outcome = a.outcome as Outcome;
  if (PRODUCT_FAILURES.has(outcome)) return { pass: 0, failure: outcome };
  if (HARNESS_FAILURES.has(outcome) || (outcome !== 'scored' && outcome !== 'ingest_degraded')) return { drop: outcome };
  const s = score.get(`${a.answer_id}|${frontierInstrumentId(instrument, bg1JudgeOf(a.reader))}`);
  if (typeof s !== 'number') return { drop: 'judgment_missing' };
  if (s !== 0 && s !== 1) refuse(`a gating judgment scored ${s}; the weekly line counts a judge's pass (1) or fail (0) only`);
  return { pass: s === 1 ? 1 : 0, failure: null };
}
