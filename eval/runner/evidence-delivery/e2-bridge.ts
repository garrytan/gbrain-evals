/**
 * E2 bridge: the sealed confirmation set under the E1 protocol (plan amendment 3).
 *
 * The existing sealed runner expands whole sessions with the official
 * JSON-history prompt at temperature 0 and 2,048 output tokens. That would
 * compare nothing: both arms would get whole sessions. This bridge keeps the
 * exact E1 notes-reader pins (system text, model, 1,024 output tokens,
 * provider-default temperature, renderChatBlock framing) and changes only the
 * evidence, which comes from the same freeze code as E1 applied to the sealed
 * haystacks in LongMemEval shape.
 *
 *   system-under-test side (never sees labels)
 *     sealedFreezeInputs  sealed questions -> freeze inputs (same retrieval pins as E1)
 *     buildSealedRequests chunk and winner requests from the frozen evidence
 *   evaluator side (custodian)
 *     scoreSealed         opens labels once with a non-empty decision id, judges
 *                         both arms with both judges, applies decideE2
 */
import { armRequest, type E1Context } from './e1.ts';
import { decideE2, type DecisionManifest, type E2Decision, type OutcomeRow } from './decision.ts';
import type { FreezeInput } from './freeze.ts';
import type { LmeQuestion } from './data.ts';
import type { FrozenQuestion } from './store.ts';
import type { QuestionsFile, LabelsFile } from '../sealed-confirmation-lib.ts';

/** Sealed questions in LongMemEval shape with no labels (toLmeRows) become freeze inputs. */
export function sealedFreezeInputs(lmeRows: Array<Record<string, any>>): FreezeInput[] {
  return lmeRows.map(r => ({
    set: 'sealed' as const,
    question: { question_id: r.question_id, question: r.question, question_date: r.question_date, haystack_dates: r.haystack_dates, haystack_session_ids: r.haystack_session_ids, haystack_sessions: r.haystack_sessions },
  }));
}

/** The question text and date the reader sees, keyed like the LongMemEval dataset (no answers, no types). */
export function sealedDatasetView(q: QuestionsFile): Map<string, LmeQuestion> {
  return new Map(q.questions.map(x => [x.question_id, { question_id: x.question_id, question: x.question, question_date: x.question_date, question_type: 'sealed-unlabeled' } as unknown as LmeQuestion]));
}

export function decisionIdFor(m: DecisionManifest, winner: string): string {
  if (!m.family.candidates.includes(winner)) throw new Error(`${winner} is not a family candidate`);
  return `${m.id}:e2:${winner}`;
}

export type SealedCtx = Pick<E1Context, 'store' | 'renderer' | 'dataset' | 'readerModel' | 'manifest'>;

/** chunk and winner requests for one sealed question; everything but the evidence is identical by construction. */
export function buildSealedRequests(ctx: SealedCtx, q: FrozenQuestion, winner: string) {
  return { chunk: armRequest(ctx, q, 'chunk'), winner: armRequest(ctx, q, winner) };
}

export interface SealedAnswerRow { question_id: string; arm: string; hypothesis?: string; reader_error?: string; provider_input_tokens: number | null; request_sha256: string; evidence_sha256: string }

export interface SealedJudgments { question_id: string; arm: string; primary: 0 | 1 | null; confirmation: 0 | 1 | null }

/**
 * Evaluator side. `openLabels` must be the sealed runner's openLabels (it
 * checks the commitment, requires the decision id and logs the open);
 * `judgePrimary` / `judgeConfirm` are the gbrain judge and the sealed
 * protocol's official-prompt judge.
 */
export async function scoreSealed<D = E2Decision>(o: {
  manifest: DecisionManifest;
  winner: string;
  /** Overrides for a later manifest version: its decision id and its E2 rule. */
  decisionId?: string;
  decide?: (chunk: OutcomeRow[], winner: OutcomeRow[]) => D;
  questions: QuestionsFile;
  answers: SealedAnswerRow[];
  openLabels: (decisionId: string) => LabelsFile;
  judgePrimary: (label: LabelsFile['labels'][number], question: string, hypothesis: string) => Promise<0 | 1 | null>;
  judgeConfirm: (label: LabelsFile['labels'][number], question: string, hypothesis: string) => Promise<0 | 1 | null>;
}): Promise<{ decision_id: string; decision: D; judgments: SealedJudgments[] }> {
  const decisionId = o.decisionId ?? decisionIdFor(o.manifest, o.winner);
  const arms = ['chunk', o.winner];
  for (const arm of arms) {
    const ids = new Set(o.answers.filter(a => a.arm === arm).map(a => a.question_id));
    const missing = o.questions.questions.filter(x => !ids.has(x.question_id));
    if (missing.length) throw new Error(`${arm}: ${missing.length} sealed question(s) have no answer row; refusing to open labels`);
  }
  const labels = o.openLabels(decisionId);
  const qById = new Map(o.questions.questions.map(x => [x.question_id, x]));
  const persona = new Map(o.questions.questions.map(x => [x.question_id, x.haystack_id]));
  const judgments: SealedJudgments[] = [];
  const rows: Record<string, OutcomeRow[]> = { chunk: [], [o.winner]: [] };
  for (const arm of arms) {
    for (const l of labels.labels) {
      const a = o.answers.find(x => x.arm === arm && x.question_id === l.question_id)!;
      const question = qById.get(l.question_id)!.question;
      const ok = !a.reader_error && a.hypothesis !== undefined;
      const primary = ok ? await o.judgePrimary(l, question, a.hypothesis!) : 0;
      const confirmation = ok ? await o.judgeConfirm(l, question, a.hypothesis!) : 0;
      judgments.push({ question_id: l.question_id, arm, primary, confirmation });
      rows[arm].push({ question_id: l.question_id, question_type: l.question_type, cluster: persona.get(l.question_id)!, primary, confirmation, provider_input_tokens: a.provider_input_tokens, reader_error: a.reader_error ?? null });
    }
  }
  const decision = o.decide ? o.decide(rows.chunk, rows[o.winner]) : decideE2(o.manifest, rows.chunk, rows[o.winner]) as unknown as D;
  return { decision_id: decisionId, decision, judgments };
}

/** gbrain's judge keys abstention on an `_abs` id suffix; sealed ids are opaque, so abstention labels get the suffix here. */
export function gbrainJudgeId(label: { question_id: string; question_type: string }): string {
  return label.question_type === 'abstention' ? `${label.question_id}_abs` : label.question_id;
}
