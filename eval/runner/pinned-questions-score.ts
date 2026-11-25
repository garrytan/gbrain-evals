/**
 * Scoring for the pinned-questions category (eval/runner/pinned-questions.ts).
 * Pure functions over the rows the runner writes; no gbrain import.
 *
 * Sentence level: every model sentence of a question's first answer is gold
 * "affected" when the change touched its claim (the ledger's AFFECTED set) and
 * is scored by whether the first status read after the change flagged it stale.
 * Question level: a question is gold "signalled" when any claim was affected,
 * and gbrain signalled it when the receipt read stale or reported new evidence
 * since the answer's watermark (either one makes the scheduler refresh it).
 */
import { CONTRADICTION_CLASSES, MUTATION_CLASSES, type Claim, type MutationClass } from '../generators/pinned-questions-gen.ts';
import { BOOTSTRAP_DRAWS, clusterBootstrapAll, clustersBy, pairedComparison, type PairedComparison } from './pinned-questions-stats.ts';

export interface SentenceRow {
  seed: number; company: string; mutation: MutationClass; claim: Claim; text: string;
  cites: string[]; affected: boolean; flagged: boolean; reasons: string[];
}

export interface QuestionRow {
  seed: number; company: string; mutation: MutationClass; affected: Claim[];
  /** Claims the first answer had no sentence for (evidence not retrieved at pin time); their sentences are not scored. */
  unanswered_at_pin: Claim[];
  baseline_stale: number;
  freshness: string; new_evidence: boolean; stale_sentences: number;
  gold_signal: boolean; signalled: boolean;
  /** Other questions (none of whose claims this change touched) that signalled right after this change. */
  spillover: number;
  /** Simulated days of the standing_questions phase after the change until the published answer matched the ledger and read fresh; null when it never did within the run. */
  cycles_to_correct: number | null;
  /** Refreshes the phase ran, on any question, in the days counted for this change. */
  refreshes: number;
  /** The gbrain error that stopped this change's measurement partway; the row is kept so the count is never lost, and the change's sentences are not recorded. */
  error?: string;
}

export interface Confusion { tp: number; fp: number; fn: number; tn: number; precision: number | null; recall: number | null; f1: number | null; false_flag_rate: number | null }

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export function confusion(rows: ReadonlyArray<{ affected: boolean; flagged: boolean }>): Confusion {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    if (r.affected && r.flagged) tp++;
    else if (!r.affected && r.flagged) fp++;
    else if (r.affected) fn++;
    else tn++;
  }
  const precision = ratio(tp, tp + fp), recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, tn, precision, recall, f1, false_flag_rate: ratio(fp, fp + tn) };
}

/** Wilson 95% interval for k of n, treating sentences as independent: exploratory only; the registered intervals are flagIntervals. */
export function wilson(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.959964, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Registered 95% intervals for precision, recall and false-flag rate: cluster bootstrap over questions (seed and company), BOOTSTRAP_DRAWS draws. */
export interface FlagIntervals { precision: [number, number] | null; recall: [number, number] | null; false_flag_rate: [number, number] | null; draws: number; clusters: number }

export function flagIntervals(sentences: readonly SentenceRow[], draws = BOOTSTRAP_DRAWS): FlagIntervals {
  const clusters = clustersBy(sentences, s => `${s.seed}|${s.company}`);
  const [precision, recall, false_flag_rate] = clusterBootstrapAll(clusters, rows => { const c = confusion(rows); return [c.precision, c.recall, c.false_flag_rate]; }, draws);
  return { precision: precision ?? null, recall: recall ?? null, false_flag_rate: false_flag_rate ?? null, draws, clusters: clusters.length };
}

/**
 * The fix build against the baseline on the same seeds: recall on the affected sentences of `classes`, paired by
 * sentence (seed, company, claim), with McNemar's exact test (the decision rule's "does not fall"); its interval
 * resamples whole questions (seed, company), as the plan clusters every interval.
 */
export function pairedRecall(base: readonly SentenceRow[], fix: readonly SentenceRow[], classes: readonly MutationClass[]): PairedComparison {
  const key = (s: SentenceRow) => `${s.seed}|${s.company}|${s.claim}`;
  const fixed = new Map(fix.map(s => [key(s), s]));
  const pairs = base.filter(s => s.affected && classes.includes(s.mutation) && fixed.has(key(s))).map(s => ({ a: s.flagged, b: fixed.get(key(s))!.flagged, cluster: `${s.seed}|${s.company}` }));
  return pairedComparison(pairs);
}

export interface ClassSummary {
  /** Questions measured, and questions whose measurement a gbrain error stopped (left out of every rate here, and failing exact conformance). */
  questions: number; errors: number; sentences: number; flags: Confusion; flags_ci: FlagIntervals;
  signal_rate: number | null; spillover_per_change: number | null; corrected_within_run: number | null; median_cycles_to_correct: number | null; refreshes: number;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

function classSummary(sentences: readonly SentenceRow[], all: readonly QuestionRow[]): ClassSummary {
  const questions = all.filter(q => !q.error);
  const affected = questions.filter(q => q.gold_signal);
  return {
    questions: questions.length, errors: all.length - questions.length, sentences: sentences.length, flags: confusion(sentences), flags_ci: flagIntervals(sentences),
    signal_rate: ratio(questions.filter(q => q.signalled).length, questions.length),
    spillover_per_change: ratio(questions.reduce((a, q) => a + q.spillover, 0), questions.length),
    corrected_within_run: ratio(affected.filter(q => q.cycles_to_correct !== null).length, affected.length),
    median_cycles_to_correct: median(affected.flatMap(q => (q.cycles_to_correct === null ? [] : [q.cycles_to_correct]))),
    refreshes: questions.reduce((a, q) => a + q.refreshes, 0),
  };
}

export interface PinnedQuestionsSummary {
  overall: ClassSummary & { precision_ci: [number, number] | null; recall_ci: [number, number] | null };
  /** Registered intervals for the two families the decision rule reads. */
  documented_ci: FlagIntervals; contradiction_ci: FlagIntervals;
  /** Edits, removals and unrelated changes: the changes gbrain's guide says it flags (or must not flag). */
  documented: Confusion;
  /** A contradicting source added beside the cited evidence. */
  contradiction: Confusion;
  question_signal: Confusion;
  by_class: Partial<Record<MutationClass, ClassSummary>>;
  /** Refreshes the phase ran after changes that affected no claim of any question (paid calls that change nothing). */
  wasted_refreshes: number;
  baseline_false_flags: number;
  unanswered_at_pin: number;
}

export function summarize(sentences: readonly SentenceRow[], questions: readonly QuestionRow[]): PinnedQuestionsSummary {
  const base = classSummary(sentences, questions);
  const f = base.flags;
  const by_class: PinnedQuestionsSummary['by_class'] = {};
  for (const m of MUTATION_CLASSES) {
    const qs = questions.filter(q => q.mutation === m);
    if (qs.length) by_class[m] = classSummary(sentences.filter(s => s.mutation === m), qs);
  }
  const isContra = (m: MutationClass) => CONTRADICTION_CLASSES.includes(m);
  return {
    overall: { ...base, precision_ci: base.flags_ci.precision, recall_ci: base.flags_ci.recall },
    documented: confusion(sentences.filter(s => !isContra(s.mutation))),
    contradiction: confusion(sentences.filter(s => isContra(s.mutation))),
    documented_ci: flagIntervals(sentences.filter(s => !isContra(s.mutation))),
    contradiction_ci: flagIntervals(sentences.filter(s => isContra(s.mutation))),
    question_signal: confusion(questions.filter(q => !q.error).map(q => ({ affected: q.gold_signal, flagged: q.signalled }))),
    by_class,
    wasted_refreshes: questions.filter(q => !q.gold_signal).reduce((a, q) => a + q.refreshes, 0),
    baseline_false_flags: questions.reduce((a, q) => a + q.baseline_stale, 0),
    unanswered_at_pin: questions.reduce((a, q) => a + q.unanswered_at_pin.length, 0),
  };
}

/** Exact conformance: every affected sentence flagged, no other sentence flagged, every question's signal right, no spillover. The scorer check's verdict; the category itself is report-only. */
export function exactConformance(sentences: readonly SentenceRow[], questions: readonly QuestionRow[]): { pass: boolean; detail: string } {
  const f = confusion(sentences), q = confusion(questions.map(x => ({ affected: x.gold_signal, flagged: x.signalled })));
  const spill = questions.reduce((a, x) => a + x.spillover, 0);
  const errors = questions.filter(x => x.error).length;
  return {
    pass: questions.length > 0 && sentences.length > 0 && errors === 0 && f.fp === 0 && f.fn === 0 && q.fp === 0 && q.fn === 0 && spill === 0,
    detail: `sentences tp ${f.tp} fp ${f.fp} fn ${f.fn}; questions tp ${q.tp} fp ${q.fp} fn ${q.fn}; spillover ${spill}; measurement errors ${errors}`,
  };
}
