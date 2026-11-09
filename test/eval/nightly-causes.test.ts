/**
 * The nightly's provisional failure causes (eval/runner/nightly/classify.ts): each rule on a fixture outcome, and the
 * order the rules are checked in.
 */
import { describe, expect, test } from 'bun:test';
import { CAUSES, CLASSIFIER_VERSION, classify } from '../../eval/runner/nightly/classify.ts';
import { row } from './nightly-fixtures.ts';

const cause = (o: Parameters<typeof row>[0]) => classify(row(o)).cause;

describe('nightly failure causes', () => {
  test('every result carries the taxonomy version, and every cause is one of the fixed list', () => {
    const r = classify(row());
    expect(r.version).toBe(CLASSIFIER_VERSION);
    expect(CAUSES).toContain(r.cause);
    expect([...CAUSES].sort() as string[]).toEqual(['abstained', 'agent_resend', 'answer_wrong', 'harness', 'partial_evidence', 'retrieval_miss', 'tool_error', 'tool_refused', 'turn_cap', 'unclassified', 'write_lost'].sort());
  });

  test('a harness row is harness whatever else it records, and a passing row is not a failure', () => {
    expect(cause({ harness: { error: 'provider 529' }, stop: 'turn_cap', tool_errors: [{ tool: 'get_page', code: null, refused: false }] })).toBe('harness');
    expect(classify(row({ pass: true })).detail).toBe('passed');
  });

  test('turn cap, then crashed or hung tools, then a resend, then lost writes, then refusals', () => {
    const refused = [{ tool: 'put_page', code: 'worktree_refreshing', refused: true }];
    expect(cause({ stop: 'turn_cap', tool_errors: refused })).toBe('turn_cap');
    expect(cause({ tool_errors: [...refused, { tool: 'search', code: null, refused: false, message: 'timeout' }] })).toBe('tool_error');
    expect(cause({ evidence: { failure_classes: ['deadlock'] } })).toBe('tool_error');
    expect(cause({ tool_errors: refused, evidence: { kind: 'write', resent: ['F2'], duplicated: ['F2'] } })).toBe('agent_resend');
    expect(cause({ tool_errors: refused, evidence: { kind: 'write', duplicated: ['F1'] } })).toBe('write_lost');
    expect(cause({ evidence: { kind: 'write', acknowledged_missing: ['F3'] } })).toBe('write_lost');
    expect(cause({ evidence: { kind: 'trials', failure_classes: ['lost', 'stuck'] } })).toBe('write_lost');
    expect(cause({ tool_errors: refused, evidence: { kind: 'write', missing: ['F1'] } })).toBe('tool_refused');
    expect(classify(row({ tool_errors: [...refused, ...refused] })).detail).toBe('2 refused: put_page/worktree_refreshing');
  });

  test('QA rows: no gold session retrieved, some retrieved, a declined answer, a wrong answer', () => {
    expect(cause({ evidence: { kind: 'qa', recall_any_at_5: 0, recall_all_at_5: 0, answer: 'Paris' } })).toBe('retrieval_miss');
    expect(cause({ evidence: { kind: 'qa', recall_any_at_5: 1, recall_all_at_5: 0.5, answer: 'Paris' } })).toBe('partial_evidence');
    expect(cause({ evidence: { kind: 'qa', recall_any_at_5: 1, recall_all_at_5: 1, answer: "I don't know.", abstention: false } })).toBe('abstained');
    expect(cause({ evidence: { kind: 'qa', recall_any_at_5: 1, recall_all_at_5: 1, answer: 'Paris' } })).toBe('answer_wrong');
    expect(cause({ evidence: { kind: 'qa', recall_any_at_5: null, recall_all_at_5: null, answer: 'Paris', abstention: true } })).toBe('answer_wrong');
  });

  test('agent QA rows (Cat 40): needed documents never read, some read, no answer, a wrong answer', () => {
    expect(cause({ evidence: { kind: 'agent-qa', evidence_cited: [], missed_evidence: ['d1', 'd2'], submitted: true } })).toBe('retrieval_miss');
    expect(cause({ evidence: { kind: 'agent-qa', evidence_cited: ['d1'], missed_evidence: ['d2'], submitted: true } })).toBe('partial_evidence');
    expect(cause({ evidence: { kind: 'agent-qa', evidence_cited: ['d1'], missed_evidence: [], submitted: false } })).toBe('abstained');
    expect(cause({ evidence: { kind: 'agent-qa', evidence_cited: ['d1'], missed_evidence: [], submitted: true, answer: 'UNKNOWN' } })).toBe('abstained');
    expect(cause({ evidence: { kind: 'agent-qa', evidence_cited: ['d1'], missed_evidence: [], submitted: true } })).toBe('answer_wrong');
  });

  test('write rows: a fact never written stays unclassified, a wrong report is answer_wrong', () => {
    expect(classify(row({ evidence: { kind: 'write', missing: ['F4'] } }))).toMatchObject({ cause: 'unclassified', detail: 'F4 never written' });
    expect(classify(row({ evidence: { kind: 'write', report_correct: false, misreports: ['F2'] } }))).toMatchObject({ cause: 'answer_wrong', detail: 'report wrong: F2' });
    expect(cause({ stop: 'fail', evidence: { kind: 'smoke' } })).toBe('unclassified');
  });
});
