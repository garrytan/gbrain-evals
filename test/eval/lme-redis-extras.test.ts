import { describe, expect, test } from 'bun:test';
import { extras } from '../../eval/runner/batch/lme-redis-extras.ts';
import type { ScoredRow } from '../../eval/runner/batch/lme-redis-report.ts';
import type { AnyReader, Memories } from '../../eval/runner/batch/lme-redis.ts';

const order = ['q1', 'q2', 'q3', 'q4'];
const delivery = (turns: number, delivered: number) => ({ evidence_turns: turns, delivered, all_delivered: turns > 0 && delivered === turns, partial: 0, split_rule: null, conversation_level: delivered });
function row(reader: AnyReader, memories: Memories, q: string, cross: 0 | 1 | -1, protocol: 0 | 1 | -1 = cross, answered_by: Memories = memories, d = delivery(1, 1)): ScoredRow {
  return { question_id: q, question_type: q === 'q4' ? 'temporal-reasoning' : 'multi-session', reader, memories, answered_by, answer: 'a', truncated: false, protocol, cross, cross_redis_parse: cross, delivery: d, context_sha256: `${memories}-${q}` };
}
const retrieval = order.map(q => ({ question_id: q, queries: { off: { order: [1, 2, 3, 4, 5, 6], degraded: [] }, on: { order: q === 'q1' ? [1] : [1, 2, 3, 4, 5, 6], degraded: [] }, 'agent-default': { order: [1, 2, 3], degraded: [] } } }));

describe('lme-redis extras', () => {
  const rows: ScoredRow[] = [
    ...order.map(q => row('gpt4o', 'off', q, 1)),
    row('gpt4o', 'on', 'q1', 0, 0, 'on', delivery(2, 1)), row('gpt4o', 'on', 'q2', 1, 1, 'off'),
    row('gpt4o', 'on', 'q3', 1, 1, 'off'), row('gpt4o', 'on', 'q4', 1, 1, 'off'),
    row('gpt4o', 'agent-default', 'q1', 0, 1), row('gpt4o', 'agent-default', 'q2', 1), row('gpt4o', 'agent-default', 'q3', -1, 0), row('gpt4o', 'agent-default', 'q4', 1, 1, 'agent-default', delivery(0, 0)),
  ];
  const tokens = [
    ...order.map(q => ({ arm: 'gpt4o--off', question_id: q, input_tokens: 100, output_tokens: 10, finish: 'stop' })),
    { arm: 'gpt4o--on', question_id: 'q1', input_tokens: 20, output_tokens: 10, finish: 'length' },
  ];
  const out = extras({ rows, order, retrieval, pilotRetrieval: retrieval, tokens });
  const cell = (m: Memories) => out.cells.find(c => c.reader === 'gpt4o' && c.memories === m)!;

  test('the stopped on arm counts the first half only and charges a reused answer its source tokens', () => {
    expect(cell('on').questions).toBe(2);
    expect(cell('on').answers_reused_from_off).toBe(1);
    expect(cell('on').mean_input_tokens).toBe(60);
    expect(cell('on').truncated).toBe(1);
  });

  test('judge disagreement counts only answers both judges parsed', () => {
    expect(cell('agent-default').judged_by_both).toBe(3);
    expect(cell('agent-default').judges_disagree).toBe(1);
    expect(cell('agent-default').cross_unparsable).toBe(1);
  });

  test('delivery leaves out questions with no evidence turns', () => {
    const ad = out.delivery.arms.find(a => a.memories === 'agent-default')!;
    expect(ad.no_evidence_turns).toBe(1);
    expect(ad.all_delivered).toBe(3);
    const on = out.delivery.arms.find(a => a.memories === 'on')!;
    expect(on.some_turn_missing).toBe(1);
  });

  test('autocut counts cuts below 5 distinct conversations', () => {
    expect(out.autocut.contexts_differ_off_on).toBe(1);
    expect(out.autocut.on_below_5_conversations_all).toBe(1);
    expect(out.autocut.on_prefix_of_off).toBe(4);
  });
});
