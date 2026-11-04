/**
 * Per-reader judging (RS1, GST-1154; the family rule GST-767). A cell arm may name, for each of its readers, the judges
 * that score that reader's answers (`ArmDefinition.judging.by_reader`). Q1 and F6 arms name none: their answers are
 * scored by the benchmark's one canonical judge, and their frontier judges are re-judges that score nothing.
 *
 * Every site that decides whether an answer is judged, or what it scored, asks scoringJudges: the runner's judge
 * loop, the resume check, the shard share, the published receipt, the re-read tool, the estimate and the lease peak.
 * A judge's records carry the canonical instrument id when the judge is the instrument's canonical judge, else
 * `<instrument>@<judge>` (the frontier convention), so one answer's judges never share an instrument id.
 */

/** The family a model belongs to for the family rule: its provider (anthropic, openai, gemini, particle, ...). */
export const modelFamily = (model: string) => model.includes(':') ? model.slice(0, model.indexOf(':')) : model;

/** The instrument id a judge's records carry: the canonical id for the canonical judge, else `<instrument>@<judge>`. */
export const judgeInstrumentId = (instrument: { id: string; canonical_judge: string }, judge: string) => judge === instrument.canonical_judge ? instrument.id : `${instrument.id}@${judge}`;

export interface JudgingPlan { by_reader: Record<string, string[]> }
export interface PlannedJudge { judge: string; instrument_id: string }

/** The judges whose replicate-0 scores make up an answer's score: the arm's plan for its reader, or the canonical judge alone. */
export function scoringJudges(arm: { judging?: JudgingPlan }, reader: string, instrument: { id: string; canonical_judge: string }): PlannedJudge[] {
  const judges = arm.judging ? arm.judging.by_reader[reader] ?? [] : [instrument.canonical_judge];
  return judges.map(judge => ({ judge, instrument_id: judgeInstrumentId(instrument, judge) }));
}

/** Every judge an arm's plan names (no plan: none), for the compatible-judge refusal and the price table. */
export const planJudges = (arm: { judging?: JudgingPlan }) => [...new Set(Object.values(arm.judging?.by_reader ?? {}).flat())].sort();

/**
 * An answer's score under its scoring judges: the mean of their replicate-0 scores, or null while any of them has no
 * numeric score. `scoreOf` returns the judge's replicate-0 score for this answer, undefined when it has none.
 */
export function plannedScore(planned: readonly PlannedJudge[], scoreOf: (p: PlannedJudge) => number | null | undefined): number | null {
  if (!planned.length) return null;
  const xs = planned.map(scoreOf);
  if (xs.some(x => typeof x !== 'number')) return null;
  return (xs as number[]).reduce((s, x) => s + x, 0) / xs.length;
}
