/**
 * outcome-v3: the versioned answer-outcome instrument (wave 1 item A10 of the
 * 10x memory advantage plan; shared with B4). It replaces no historical
 * scorer: `scoreAnswer` and `scoreAnswerV2` in a4-abstention.ts stay exactly
 * as they are, so old receipts rescore identically.
 *
 * Why a new version. scoreAnswerV2 (a4-abstention.ts:143-150) turns a stated
 * wrong or sibling value into `abstain` whenever its abstention pattern also
 * matches, and armMetrics (:166-171) drops errors from every denominator. So
 * "I don't know for sure, but the owner is <wrong value>" improves the wrong
 * rate and an error improves every rate. The binding definition is the
 * opposite: a committed wrong answer counts however it is hedged, and an
 * execution error is a failure.
 *
 * Axes, stored separately on every row:
 *   execution_error  no usable answer (failed or empty call, output cut at the
 *                    limit, judge failure); always in the denominator;
 *   commitment       `committed` (states a value or action) or `abstained`
 *                    (declines without one); null when an error left no answer;
 *   correctness      `correct` / `incorrect` from the question's grader (the
 *                    judge, or the ledger's values); null on error;
 *   hedge            the committed answer marks uncertainty about itself
 *                    ("probably", "about 3 years", a guess after a decline);
 *                    null when not labeled;
 *   answerable       whether the question has an answer in the data.
 *
 * Reporting categories are derived from the axes only:
 *   correct          answerable and correct; or unanswerable and graded
 *                    correct (it identified the question as unanswerable);
 *   committed_wrong  answerable, incorrect and committed (hedged or not); or
 *                    unanswerable and graded incorrect (it answered);
 *   abstained        answerable, incorrect and abstained (a false abstention);
 *   execution_error  no usable answer.
 * `hedged_wrong` is a sub-count of committed_wrong, never a separate bucket.
 * Program-primary failure = every row that is not `correct`.
 *
 * Commitment and hedge labels for free-text answers come from a labeler
 * (`judgedHedgeLabel`, one model call per answer, the three labels of the
 * Q1 labeling guide). The hedge axis reports nothing until that labeler is
 * validated against GBRA-49's 600 hand-labeled answers (precision >= 0.90 on
 * `hedged` and on `abstain`); `HEDGE_AXIS` records the validation receipt.
 */
import { ABSTAIN_RE_V2, finalAnswer, states, type Outcome } from '../a4-abstention.ts';
import type { A4Question } from '../../generators/a4-abstention-gen.ts';

export const OUTCOME_VERSION = 'outcome-v3';

export type Commitment = 'committed' | 'abstained';
export type Correctness = 'correct' | 'incorrect';
export type Category = 'correct' | 'committed_wrong' | 'abstained' | 'execution_error';
export type CommitmentLabel = 'abstain' | 'hedged' | 'confident';

export interface OutcomeAxes {
  version: typeof OUTCOME_VERSION;
  answerable: boolean;
  execution_error: string | null;
  commitment: Commitment | null;
  correctness: Correctness | null;
  hedge: boolean | null;
}

/** Validation state of the hedge axis: summaries report hedge counts only when `validated` is true. */
export const HEDGE_AXIS: { labeler: string; validated: boolean; receipt: string | null } = {
  labeler: 'judged-hedge-label-v1',
  validated: false,
  receipt: null,
};

export function axes(input: { answerable: boolean; executionError?: string | null; commitment?: Commitment | null; correctness?: Correctness | null; hedge?: boolean | null }): OutcomeAxes {
  const error = input.executionError ?? null;
  return {
    version: OUTCOME_VERSION,
    answerable: input.answerable,
    execution_error: error,
    commitment: error ? null : input.commitment ?? null,
    correctness: error ? null : input.correctness ?? null,
    hedge: error ? null : input.hedge ?? null,
  };
}

/** The reporting category, derived from the axes alone. Hedge never enters it. */
export function category(a: OutcomeAxes): Category {
  if (a.execution_error || a.correctness === null) return 'execution_error';
  if (!a.answerable) return a.correctness === 'correct' ? 'correct' : 'committed_wrong';
  if (a.correctness === 'correct') return 'correct';
  return a.commitment === 'abstained' ? 'abstained' : 'committed_wrong';
}

/** Axes from a free-text answer graded by a judge, with a commitment label from the labeler. */
export function axesFromJudged(input: { answerable: boolean; executionError?: string | null; judgeCorrect: boolean | null; label: CommitmentLabel | null }): OutcomeAxes {
  if (input.executionError || input.judgeCorrect === null) return axes({ answerable: input.answerable, executionError: input.executionError ?? 'judge_error' });
  return axes({
    answerable: input.answerable,
    correctness: input.judgeCorrect ? 'correct' : 'incorrect',
    commitment: input.label === null ? null : input.label === 'abstain' ? 'abstained' : 'committed',
    hedge: input.label === null ? null : input.label === 'hedged',
  });
}

// ─── A4 structured answers (deterministic) ─────────────────────────

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const A4_SHAPE: Record<string, RegExp> = {
  headcount: /\b\d+\s*(employees|people|staff|headcount)\b/i,
  runway: /\b\d+\s*months?\b/i,
  arr: /\$?\s*\d+(\.\d+)?\s*(m\b|million)/i,
  founded: new RegExp(`\\b((${MONTHS})\\s+)?(19|20)\\d{2}\\b`, 'i'),
};
/** Uncertainty wording on a committed A4 answer (the hedge axis for structured answers). */
const A4_UNCERTAIN = /(not available|don['’]t know|do not know|no information|not enough information|insufficient|not sure|unsure|uncertain|probably|likely|may be|might be|i think|cannot (?:be )?determined?|can['’]t (?:be )?determined?|unable to (?:determine|answer|find)|(?:don['’]t|do not|doesn['’]t|does not) have (?:the |enough |any )?(?:information|data|details))/i;
const norm = (s: string) => s.toLowerCase().replace(/(\d),(\d)/g, '$1$2').replace(/[*_`]/g, '').replace(/\s+/g, ' ');

const A4_REJECT = /\b(?:belongs? to|is the (?:ceo|headquarters|hq) of|separate company|different company|won['’]t (?:use|assume)|will not (?:use|assume)|cannot confirm|can['’]t confirm|such as|thinking of|only (?:mentions?|discusses|covers|references|contains|includes|company)|rather than|not to\b|, not\b|not (?:the|for)\b)/i;
const A4_NAME = /([A-Z][A-Za-z'-]*(?: [A-Z][A-Za-z'-]*)*) Example\b/g;
const sentencesOf = (s: string) => s.split(/(?<=[.!?]["'”’)*]*)\s+|\n+/).filter(x => x.trim());
const A4_NEG = /\b(?:no|not|none|cannot)\b|n['’]t\b/i;

/**
 * outcome-v3 on an A4 answer. A value commits the answer when a sentence
 * offers it for the asked company: the sentence names no other company (or
 * names the asked one) and does not reject it ("belongs to", "not",
 * "won't use", "cannot confirm"), whatever abstention wording sits beside it.
 * A value named only to attribute it to another company or to reject it
 * leaves a declining answer abstained, as the Q1 labeling guide rules ("naming
 * a candidate only to reject it is still abstain"); without any abstention
 * wording, a stated wrong value commits.
 */
export function scoreA4V3(q: Pick<A4Question, 'attribute' | 'answer' | 'sibling_value' | 'entity'>, text: string | null, values: Record<string, readonly string[]>, answerable: boolean, executionError: string | null = null): OutcomeAxes & { final: string } {
  if (executionError || text === null || !text.trim()) return { ...axes({ answerable, executionError: executionError ?? 'empty_answer' }), final: '' };
  const final = finalAnswer(text);
  const declines = ABSTAIN_RE_V2.test(final);
  const uncertain = A4_UNCERTAIN.test(final);
  const wrongValue = (s: string) => (q.sibling_value && states(s, q.attribute, q.sibling_value)) || (values[q.attribute] ?? []).some(v => v !== q.answer && states(s, q.attribute, v)) || (!!A4_SHAPE[q.attribute]?.test(norm(s)) && !(q.answer && states(s, q.attribute, q.answer)));
  const offers = (s: string) => {
    const names = [...s.matchAll(A4_NAME)].map(m => `${m[1]} Example`);
    const other = names.some(n => !n.includes(q.entity) && !q.entity.includes(n));
    const asked = names.some(n => n.includes(q.entity) || q.entity.includes(n));
    return (!other || (asked && !A4_NEG.test(s))) && !A4_REJECT.test(s);
  };
  const sentences = sentencesOf(final);
  const correct = !!q.answer && states(final, q.attribute, q.answer) && sentences.some(s => states(s, q.attribute, q.answer!) && (offers(s) || !declines));
  if (correct) return { ...axes({ answerable, commitment: 'committed', correctness: answerable ? 'correct' : 'incorrect', hedge: uncertain && declines ? true : uncertain }), final };
  const committedWrong = sentences.some(s => wrongValue(s) && (offers(s) || !declines));
  if (committedWrong) return { ...axes({ answerable, commitment: 'committed', correctness: 'incorrect', hedge: uncertain }), final };
  if (!declines && sentences.some(wrongValue)) return { ...axes({ answerable, commitment: 'committed', correctness: 'incorrect', hedge: uncertain }), final };
  return { ...axes({ answerable, commitment: 'abstained', correctness: answerable ? 'incorrect' : 'correct', hedge: false }), final };
}

/** How a historical A4 outcome maps to the v3 category (for side-by-side rescoring only). */
export function v2CategoryOf(outcome: Outcome, answerable: boolean): Category {
  if (outcome === 'error') return 'execution_error';
  if (outcome === 'correct') return answerable ? 'correct' : 'committed_wrong';
  if (outcome === 'abstain') return answerable ? 'abstained' : 'correct';
  return 'committed_wrong';
}

// ─── Summaries ─────────────────────────────────────────────────────

export interface OutcomeSummary {
  version: typeof OUTCOME_VERSION;
  n: number;
  answerable: number;
  unanswerable: number;
  correct: number;
  committed_wrong: number;
  /** Committed-wrong rows with a hedge; null until the hedge axis is validated or when labels are missing. */
  hedged_wrong: number | null;
  abstained: number;
  execution_errors: number;
  /** Rows whose commitment label is missing (counted committed-wrong when incorrect, so a missing label never helps). */
  unlabeled_wrong: number;
  /** Every row that is not correct, over all rows (errors included). */
  failure_rate: number;
  committed_wrong_rate: number;
  false_abstention_rate: number | null;
  /** Share of correct answers that hedge; null until the hedge axis is validated. */
  hedge_among_correct: number | null;
  /** Committed answers over all rows. */
  coverage: number;
  /** Committed-wrong over committed answers (selective risk at the achieved coverage). */
  selective_risk: number | null;
}

const rate = (a: number, b: number) => (b ? a / b : 0);

export function summarize(rows: readonly OutcomeAxes[], hedgeValidated = HEDGE_AXIS.validated): OutcomeSummary {
  const cats = rows.map(category);
  const count = (c: Category) => cats.filter(x => x === c).length;
  const n = rows.length;
  const committed = rows.filter((r, i) => cats[i] === 'correct' ? r.commitment !== 'abstained' && r.answerable : cats[i] === 'committed_wrong').length;
  const wrongRows = rows.filter((_, i) => cats[i] === 'committed_wrong');
  const correctRows = rows.filter((r, i) => cats[i] === 'correct' && r.answerable);
  const answerable = rows.filter(r => r.answerable).length;
  const hedgeKnown = (xs: OutcomeAxes[]) => xs.every(r => r.hedge !== null);
  return {
    version: OUTCOME_VERSION, n, answerable, unanswerable: n - answerable,
    correct: count('correct'), committed_wrong: count('committed_wrong'),
    hedged_wrong: hedgeValidated && hedgeKnown(wrongRows) ? wrongRows.filter(r => r.hedge).length : null,
    abstained: count('abstained'), execution_errors: count('execution_error'),
    unlabeled_wrong: rows.filter((r, i) => cats[i] === 'committed_wrong' && r.answerable && r.commitment === null).length,
    failure_rate: rate(n - count('correct'), n),
    committed_wrong_rate: rate(count('committed_wrong'), n),
    false_abstention_rate: answerable ? count('abstained') / answerable : null,
    hedge_among_correct: hedgeValidated && correctRows.length && hedgeKnown(correctRows) ? correctRows.filter(r => r.hedge).length / correctRows.length : null,
    coverage: rate(committed, n),
    selective_risk: committed ? count('committed_wrong') / committed : null,
  };
}

// ─── Judged commitment and hedge label ─────────────────────────────

export const JUDGED_LABEL_VERSION = 'judged-hedge-label-v1';

/**
 * One model call per answer. The instruction condenses GBRA-49's Q1 labeling
 * guide for hedge-v3 (abstain, hedged, confident on the final answer only);
 * the answer is the only input, as it was for the human labelers.
 */
export const JUDGED_LABEL_SYSTEM = `You label how an answer commits to its FINAL answer. You do not judge whether it is right. Reply with exactly one word: abstain, hedged or confident.

1. Find the final answer: the last line starting "Answer:", "**Answer:**", "# Answer" or "Final answer" (the rest of that paragraph, or the next paragraph if the marker stands alone); else the last "Conclusion" or "Bottom line" section; else, if the answer opens with a plain statement (not "Step 1", "Relevant information" or a heading), its first paragraph; else the last paragraph that is not a note, caveat or offer to help. Steps, evidence lists and reasoning never change the label, even when they hedge.

2. abstain: the final answer declines. It says the question can't be answered ("I can't determine this", "I don't know", "there isn't enough information") or only notes that the records don't contain the answer. Naming a candidate only to reject it is still abstain ("naming a park would be speculation"). General help that does not answer is still abstain.

3. hedged: the final answer commits while marking uncertainty about the answer itself: hedge words ("probably", "likely", "I think", "may", "might", "possibly", "seems", "appears", "it suggests", "an inference", "assuming he follows through"); approximators on a number or date ("about 3 years", "around 2 April", "roughly May to June"); a decline that goes on to offer a candidate ("if a guess is needed, X", "the most likely candidate is X"); a first-person precision disclaimer followed by an answer ("I don't know the exact date, but it was in early April"). Any hedge inside the final answer counts, including on a secondary part.

4. confident: everything else, including premise corrections that answer ("It was Audrey, not Andrew; she ..."), missing-record or date notes beside a flat answer ("June 2023. None of the conversations give an exact day"), ranges without hedge words ("late March or early April"), approximate dates in an aside, "could become X" when the question asks for possibilities, and generic words like "usually".

When two rules fit, the more specific one wins. A wrong value stated with a hedge is hedged, never abstain. A decline followed by a stated value or action is not abstain.`;

export function judgedLabelUser(answer: string): string {
  return `Answer to label:\n<answer>\n${answer.replace(/<\/answer>/gi, '&lt;/answer&gt;')}\n</answer>\n\nLabel (abstain, hedged or confident):`;
}

/** Parse the labeler's reply; null when it names no single label. */
export function parseJudgedLabel(text: string): CommitmentLabel | null {
  const words = (text.toLowerCase().match(/\b(abstain|hedged|confident)\b/g) ?? []);
  const unique = [...new Set(words)];
  return unique.length === 1 ? unique[0] as CommitmentLabel : words.length ? words[words.length - 1] as CommitmentLabel : null;
}

/** Per-class precision and recall of predicted labels against human labels. */
export function labelAgreement(pairs: ReadonlyArray<{ label: CommitmentLabel; predicted: CommitmentLabel | null }>) {
  const classes: CommitmentLabel[] = ['abstain', 'hedged', 'confident'];
  const per: Record<string, { support: number; predicted: number; precision: number | null; recall: number | null }> = {};
  for (const c of classes) {
    const support = pairs.filter(p => p.label === c).length;
    const predicted = pairs.filter(p => p.predicted === c).length;
    const hit = pairs.filter(p => p.label === c && p.predicted === c).length;
    per[c] = { support, predicted, precision: predicted ? hit / predicted : null, recall: support ? hit / support : null };
  }
  const confusion = Object.fromEntries(classes.map(l => [l, Object.fromEntries([...classes, 'unparsed'].map(p => [p, pairs.filter(x => x.label === l && (x.predicted ?? 'unparsed') === p).length]))]));
  return { n: pairs.length, accuracy: pairs.length ? pairs.filter(p => p.label === p.predicted).length / pairs.length : 0, unparsed: pairs.filter(p => p.predicted === null).length, per_class: per, confusion };
}

/** The preregistered bar: precision >= 0.90 on `hedged` and on `abstain`. */
export function passesHedgeBar(agreement: ReturnType<typeof labelAgreement>, bar = 0.9): boolean {
  return (agreement.per_class.hedged.precision ?? 0) >= bar && (agreement.per_class.abstain.precision ?? 0) >= bar;
}
