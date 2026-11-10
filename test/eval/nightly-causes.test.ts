/**
 * The nightly's failure causes: each outcome row becomes the EvalFailure the failure-cause library's nightly adapter builds
 * (nightlyFailure) and goes through classify(), the rules the weekly report uses too. One test per rule a nightly suite can
 * reach, and the order the stages are checked in.
 */
import { describe, expect, test } from 'bun:test';
import { CAUSE_IDS, TAXONOMY_VERSION, classify, nightlyFailure } from '../../eval/runner/failure-causes/index.ts';
import type { ToolCall } from '../../eval/runner/failure-causes/types.ts';
import type { Outcome } from '../../eval/runner/nightly/outcome.ts';
import { row } from './nightly-fixtures.ts';

const label = (o: Partial<Outcome>) => classify(nightlyFailure(row(o), 'nightly-suite-a', []));
const call = (name: string, error: string | null = null, recovered: boolean | null = null): ToolCall => ({ name, error, recovered, ms: null, memory: true });
const noWrites = { lost: [], stuck: null, overwritten: null, duplicated: [] };

describe('nightly failure causes through classify()', () => {
  test('every label carries the taxonomy version and a cause from its fixed list', () => {
    const l = label({ harness: { error: 'provider 529' } });
    expect(l.taxonomy_version).toBe(TAXONOMY_VERSION);
    expect(CAUSE_IDS as readonly string[]).toContain(l.cause!);
  });

  test('a harness row is harness_error whatever else it records, and a passing row has no cause', () => {
    expect(label({ harness: { error: 'provider 529' }, stop: 'turn_cap', calls: [call('put_page', 'refused/worktree_refreshing', false)] })).toMatchObject({ cause: 'harness_error', rule_id: 'harness.error' });
    expect(label({ stop: 'error' })).toMatchObject({ cause: 'harness_error', rule_id: 'harness.stop_harness_error' });
    expect(label({ pass: true })).toMatchObject({ cause: null, rule_id: 'passed' });
  });

  test('a turn cap is the cause only with no earlier signal; an unrecovered refusal before it wins', () => {
    expect(label({ stop: 'turn_cap' })).toMatchObject({ cause: 'timeout_latency', rule_id: 'budget.turn_cap', tags: ['turn_cap'] });
    const refused = label({ stop: 'turn_cap', calls: [call('put_page', 'refused/worktree_refreshing', false)] });
    expect(refused).toMatchObject({ cause: 'tool_contract', rule_id: 'tool.unrecovered_error' });
    expect(refused.secondary).toContain('timeout_latency');
  });

  test('tool calls: an unrecovered error is tool_contract, a recovered one only a tag, and tool_errors without calls leave the stage unmeasured', () => {
    expect(label({ calls: [call('get_page', 'invalid_params', false)] }).cause).toBe('tool_contract');
    expect(label({ calls: [call('get_page', 'invalid_params', true), call('get_page')] }).tags).toContain('recovered_tool_error');
    const bare = label({ tool_errors: [{ tool: 'get_page', code: 'invalid_params', refused: true }] });
    expect(bare.cause).not.toBe('tool_contract');
    expect(bare.unmeasured).toContain('tool_call');
  });

  test('writes: lost, stuck, overwritten and duplicated ids are write_integrity; empty lists are not', () => {
    expect(label({ writes: { ...noWrites, lost: ['F3'] } })).toMatchObject({ cause: 'write_integrity', rule_id: 'write.lost' });
    expect(label({ writes: { lost: [], stuck: ['w2.7'], overwritten: [], duplicated: [] } })).toMatchObject({ cause: 'write_integrity', rule_id: 'write.stuck' });
    expect(label({ writes: noWrites }).cause).not.toBe('write_integrity');
  });

  test('a wrong write report is citation_abstention, tagged misreport', () => {
    expect(label({ writes: noWrites, evidence: { kind: 'write', report_correct: false } })).toMatchObject({ cause: 'citation_abstention', rule_id: 'reasoning.misreported_state', tags: ['misreport'] });
  });

  test('QA rows: coverage at 10 picks retrieval_miss, partial_evidence or wrong_ranking; delivered gold with an answer goes to the labeller', () => {
    const qa = (o: Partial<Outcome>) => label({ gold_count: 2, evidence: { kind: 'qa', recall_any_at_10: 1 }, ...o });
    expect(qa({ retrieved: 'none', evidence: { kind: 'qa', recall_any_at_10: 0 } })).toMatchObject({ cause: 'retrieval_miss', tags: ['measured_at_10'] });
    expect(qa({ retrieved: 'partial', delivered: 'partial' }).cause).toBe('partial_evidence');
    expect(qa({ retrieved: 'all', delivered: 'none' })).toMatchObject({ cause: 'wrong_ranking', rule_id: 'ranking.gold_cut' });
    expect(qa({ retrieved: 'all', delivered: 'all', visibility: 'public', question: 'Which city?', expected: 'Paris', answer: 'Lyon' })).toMatchObject({ cause: null, basis: 'needs_model' });
  });

  test('QA rows: an abstention question answered anyway is citation_abstention; no answer to judge is residual.no_answer', () => {
    expect(label({ gold_count: 0, category: 'abstention', answered: true, answer: 'Paris' }).cause).toBe('citation_abstention');
    expect(label({ gold_count: 2, retrieved: 'all', delivered: 'all', answered: false })).toMatchObject({ cause: 'unclassified', rule_id: 'residual.no_answer', tags: ['no_answer'] });
  });

  test('agent rows: gold found in search and never opened is gold_unopened; no memory call is memory_not_consulted, which comes first', () => {
    const agent = (o: Partial<Outcome>) => label({ agent_loop: true, gold_count: 2, retrieved: 'all', delivered: 'all', ...o });
    expect(agent({ opened: 'none', calls: [call('search')] })).toMatchObject({ cause: 'gold_unopened', rule_id: 'open.gold_never_opened' });
    expect(agent({ opened: 'none', calls: [] })).toMatchObject({ cause: 'memory_not_consulted', rule_id: 'consult.no_memory_call' });
  });

  test('a failed smoke is its operation, and a smoke that ran out of time is a timeout as well', () => {
    expect(label({ reader: null, operation: { step: 'source-pinned-sync', error: 'delete_not_pushed' }, stop: 'delete_not_pushed' }))
      .toMatchObject({ cause: 'operations', rule_id: 'operations.source-pinned-sync', model: 'none (keyless)' });
    expect(label({ reader: null, operation: { step: 'upgrade-from-old', error: 'smoke_timeout' }, stop: 'smoke_timeout' })).toMatchObject({ cause: 'operations', secondary: ['timeout_latency'] });
  });
});
