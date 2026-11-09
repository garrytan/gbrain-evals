/**
 * Provisional failure-cause taxonomy for nightly outcomes, behind one small interface: classify(outcome) returns the
 * cause, a short detail and the taxonomy version. A sibling classifier can replace this module as long as it keeps
 * that signature; the report records the version it used, so nights classified by different versions are told apart.
 *
 * Causes, checked in this order:
 *   harness           a provider, child-process or harness failure; counted apart, never a gbrain failure
 *   turn_cap          the agent ran out of turns
 *   tool_error        a tool call crashed, timed out or hit a server error
 *   agent_resend      a write reissued under a new request id
 *   write_lost        a write lost, duplicated, stuck, overwritten, or acknowledged without landing
 *   tool_refused      gbrain returned an error to a call the model could make
 *   retrieval_miss    no gold evidence surfaced or was read
 *   partial_evidence  some of the needed evidence surfaced or was read
 *   abstained         the answer declined (unknown, not available) on a question that has an answer
 *   answer_wrong      the evidence was there and the answer or report was still wrong
 *   unclassified      none of the above
 */
import type { Outcome } from './outcome.ts';

export const CLASSIFIER_VERSION = 'nightly-causes/v0';
export const CAUSES = ['harness', 'turn_cap', 'tool_error', 'agent_resend', 'write_lost', 'tool_refused', 'retrieval_miss', 'partial_evidence', 'abstained', 'answer_wrong', 'unclassified'] as const;
export type Cause = typeof CAUSES[number];
export interface Classified { cause: Cause; detail: string; version: string }

const ABSTAIN = /\b(UNKNOWN|NOT_ACCESSIBLE|i (do not|don't) know|not (mentioned|available|enough information)|no information|cannot (determine|answer))\b/i;
const WRITE_LOST_CLASSES = ['lost', 'lost_git', 'phantom', 'duplicated', 'stuck', 'overwritten', 'wrong_expiry', 'unindexed', 'unpublished'];
const HANG_CLASSES = ['hang', 'deadlock', 'no_converge'];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const out = (cause: Cause, detail: string): Classified => ({ cause, detail, version: CLASSIFIER_VERSION });

export function classify(o: Outcome): Classified {
  if (o.harness) return out('harness', o.harness.error.slice(0, 200));
  if (o.pass) return out('unclassified', 'passed');
  const e = o.evidence;
  if (o.stop === 'turn_cap') return out('turn_cap', 'the agent used every turn');
  const crashed = o.tool_errors.filter(t => !t.refused);
  if (crashed.length) return out('tool_error', `${crashed[0]!.tool}: ${crashed[0]!.code ?? crashed[0]!.message?.slice(0, 120) ?? 'error'}`);
  const classes = list(e.failure_classes);
  const hung = classes.filter(c => HANG_CLASSES.includes(c));
  if (hung.length) return out('tool_error', hung.join(', '));
  const resent = list(e.resent);
  if (resent.length) return out('agent_resend', `${resent.join(', ')} reissued under a new request id`);
  const lostClasses = classes.filter(c => WRITE_LOST_CLASSES.includes(c));
  if (lostClasses.length) return out('write_lost', lostClasses.join(', '));
  const duplicated = list(e.duplicated), acknowledgedMissing = list(e.acknowledged_missing);
  if (duplicated.length || acknowledgedMissing.length) {
    return out('write_lost', [duplicated.length && `duplicated ${duplicated.join(', ')}`, acknowledgedMissing.length && `acknowledged but missing ${acknowledgedMissing.join(', ')}`].filter(Boolean).join('; '));
  }
  const refused = o.tool_errors.filter(t => t.refused);
  if (refused.length) {
    const codes = [...new Set(refused.map(t => `${t.tool}/${t.code ?? 'unknown'}`))];
    return out('tool_refused', `${refused.length} refused: ${codes.slice(0, 4).join(', ')}`);
  }
  if (e.kind === 'qa') {
    const any = num(e.recall_any_at_5), all = num(e.recall_all_at_5);
    if (any === 0) return out('retrieval_miss', 'no gold session in the top five');
    if (all !== null && all < 1) return out('partial_evidence', 'some gold sessions missing from the top five');
    if (typeof e.answer === 'string' && ABSTAIN.test(e.answer) && e.abstention !== true) return out('abstained', 'declined a question that has an answer');
    return out('answer_wrong', 'gold evidence retrieved, answer judged wrong');
  }
  if (e.kind === 'agent-qa') {
    const cited = list(e.evidence_cited), missed = list(e.missed_evidence);
    if (missed.length && !cited.length) return out('retrieval_miss', `none of ${missed.length} needed documents read`);
    if (missed.length) return out('partial_evidence', `${missed.length} of ${missed.length + cited.length} needed documents missed`);
    if (e.submitted === false || (typeof e.answer === 'string' && ABSTAIN.test(e.answer))) return out('abstained', 'no answer or an UNKNOWN answer');
    return out('answer_wrong', 'needed documents read, answer wrong');
  }
  if (e.kind === 'write') {
    const missing = list(e.missing);
    if (missing.length) return out('unclassified', `${missing.join(', ')} never written`);
    if (e.report_correct === false) return out('answer_wrong', `report wrong: ${list(e.misreports).concat(list(e.unreported)).join(', ') || 'unparseable'}`);
  }
  return out('unclassified', o.stop ?? 'failed');
}
