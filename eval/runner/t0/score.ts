/**
 * Program primary (T0) scorer: one binary end-to-end failure per task run,
 * from the session-2 deliverable text and the generator's gold alone.
 *
 * Failure definition (plan 2026-10-07 section 3.1): an unsupported or stale
 * answer or action, or a missed commitment, not a missing benchmark point.
 * A run fails when any of these holds:
 *
 *   missed_commitment  none of the commitment's patterns appears;
 *   stale_date         the pre-change meeting date appears outside a change
 *                      context (see `changeContext`);
 *   stale_correction   the pre-correction value appears outside a change
 *                      context;
 *   unsupported        a value only the namesake has (their company, meeting
 *                      date, seat count, price or commitment) appears;
 *   execution_error    the session ended in a provider or harness error, or
 *                      without a deliverable; an error can never improve
 *                      the failure rate.
 *
 * Omitting the meeting date or the corrected value is not a failure under
 * the definition; it is reported as an omission, and `complete` (commitment,
 * new date and corrected value all present, no failure) is the secondary
 * success metric, so a system that avoids stating facts cannot look good on
 * both. Session-2 actions that change the brain are recorded by the runner,
 * not scored here.
 */
import type { Matcher, PPTask } from '../../generators/program-primary-gen.ts';

export const T0_SCORER_VERSION = 't0-score-v1';
export const FAILURE_KINDS = ['missed_commitment', 'stale_date', 'stale_correction', 'unsupported', 'execution_error'] as const;
export type FailureKind = typeof FAILURE_KINDS[number];

export interface T0Score {
  version: typeof T0_SCORER_VERSION;
  failed: boolean;
  kinds: FailureKind[];
  commitment_hit: boolean;
  new_date_hit: boolean;
  corrected_hit: boolean;
  /** Stale mentions outside a change context, with the matched text. */
  stale_date_mentions: string[];
  stale_correction_mentions: string[];
  /** Stale mentions excused by a change context ("moved from October 16"). */
  excused_mentions: string[];
  namesake_hits: string[];
  omissions: { date: boolean; correction: boolean };
  complete: boolean;
  answer_chars: number;
}

/** Words before a stale value, in the same sentence, that mark it as the old value. */
const PRE_CUE = /\b(?:not|isn'?t|wasn'?t|instead of|rather than|from|previously|originally|formerly|no longer|old|earlier|prior|replac\w*|supersed\w*|correct\w*|wrong|incorrect|outdated|mov(?:ed|ing)|reschedul\w*|chang(?:ed|ing)|shift\w*|push\w*|listed as|noted as|recorded as|had (?:it|been)|used to)\b|~~/i;
/** Words right after a stale value, in the same sentence, that mark it as the old value. */
const POST_CUE = /^[^.!?\n]{0,40}?(?:→|->|=>|\bmoved\b|\breschedul|\bchanged\b|\bshifted\b|\bpushed\b|\bis wrong\b|\bwas wrong\b|\bincorrect\b|\boutdated\b|\bsuperseded\b|\bno longer\b|\bcorrected\b|\breplaced\b|\(old|\(previous|\(was|\(not|~~)/i;

const regexes = (m: Matcher) => m.patterns.map(p => new RegExp(p, 'gi'));
export const matches = (m: Matcher, text: string) => regexes(m).some(r => r.test(text));

/** True when the match at [start, end) sits in a change context: a cue earlier in its sentence (within 80 characters) or right after it. */
export function changeContext(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 80), start);
  const sentenceStart = Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n'), before.lastIndexOf('! '), before.lastIndexOf('? '));
  const pre = sentenceStart >= 0 ? before.slice(sentenceStart + 1) : before;
  return PRE_CUE.test(pre) || POST_CUE.test(text.slice(end, end + 60));
}

/** Stale mentions split into those asserted as current and those excused by a change context. */
export function staleMentions(m: Matcher, text: string): { asserted: string[]; excused: string[] } {
  const asserted: string[] = [];
  const excused: string[] = [];
  for (const r of regexes(m)) {
    for (const hit of text.matchAll(r)) {
      const start = hit.index ?? 0;
      (changeContext(text, start, start + hit[0].length) ? excused : asserted).push(hit[0]);
    }
  }
  return { asserted, excused };
}

export function scoreAnswer(task: PPTask, answer: string | null | undefined, opts: { executionError?: string | null } = {}): T0Score {
  const text = answer ?? '';
  const g = task.gold;
  const commitment_hit = matches(g.commitment, text);
  const new_date_hit = matches(g.date.new, text);
  const corrected_hit = matches(g.correction.corrected, text);
  const staleDate = staleMentions(g.date.old, text);
  const staleCorr = staleMentions(g.correction.stale, text);
  const namesake_hits = g.namesake.filter(m => matches(m, text)).map(m => m.label);
  const kinds: FailureKind[] = [];
  if (opts.executionError || !text.trim()) kinds.push('execution_error');
  if (!commitment_hit) kinds.push('missed_commitment');
  if (staleDate.asserted.length) kinds.push('stale_date');
  if (staleCorr.asserted.length) kinds.push('stale_correction');
  if (namesake_hits.length) kinds.push('unsupported');
  const failed = kinds.length > 0;
  return {
    version: T0_SCORER_VERSION, failed, kinds, commitment_hit, new_date_hit, corrected_hit,
    stale_date_mentions: staleDate.asserted, stale_correction_mentions: staleCorr.asserted, excused_mentions: [...staleDate.excused, ...staleCorr.excused],
    namesake_hits,
    omissions: { date: !new_date_hit && !staleDate.asserted.length, correction: !corrected_hit && !staleCorr.asserted.length },
    complete: !failed && new_date_hit && corrected_hit,
    answer_chars: text.length,
  };
}

/** A deliverable that states exactly the truth, derived from gold only (the honest system of the mutation suite and the scripted reader's template). */
export function truthfulAnswer(task: PPTask, values: { date: string; correction: string; commitment: string | null }): string {
  const who = task.correction_kind === 'role' ? `${task.contact_name}, ${values.correction}.` : `${task.contact_name}.`;
  const terms = task.correction_kind === 'role' ? '' : ` Terms: ${values.correction}.`;
  const owe = values.commitment ? ` I owe them ${values.commitment}.` : '';
  return `${who} Meeting: ${values.date}.${terms}${owe}`;
}

export interface Aggregate { runs: number; failures: number; failure_rate: number; complete: number; by_kind: Record<FailureKind, number> }

export function aggregate(scores: readonly T0Score[]): Aggregate {
  const by_kind = Object.fromEntries(FAILURE_KINDS.map(k => [k, 0])) as Record<FailureKind, number>;
  for (const s of scores) for (const k of s.kinds) by_kind[k]++;
  const failures = scores.filter(s => s.failed).length;
  return { runs: scores.length, failures, failure_rate: scores.length ? failures / scores.length : 0, complete: scores.filter(s => s.complete).length, by_kind };
}
