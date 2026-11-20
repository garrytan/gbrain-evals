import { describe, expect, test } from 'bun:test';
import { classify } from '../../eval/runner/failure-causes/index.ts';
import { TRUNCATED_FINISHES } from '../../eval/runner/memory-qa/qa-v2.ts';
import { failure } from '../support/failure-causes-fixture.ts';

const gold = (g: Partial<ReturnType<typeof failure>['gold']>) => ({ ...failure().gold, ...g });
const text = { question: 'q', expected: 'a', answer: 'b', context: 'ctx' };

describe('classify: deterministic rules', () => {
  test('a row with no signal goes to the labeller when its delivered context is recorded, with every unmeasured stage listed', () => {
    const l = classify(failure({ text }));
    expect(l).toMatchObject({ cause: null, basis: 'needs_model', rule_id: 'residual' });
    expect(l.unmeasured).toEqual(['ingest', 'visibility', 'tool_call', 'write', 'retrieval', 'ranking', 'presentation']);
  });

  test('a row with no signal, unmeasured delivery and no recorded context stays unclassified instead of reaching a reasoning-only labeller', () => {
    expect(classify(failure())).toMatchObject({ cause: 'unclassified', basis: 'unclassified', rule_id: 'residual.delivery_unmeasured' });
    expect(classify(failure({ text, gold: gold({ gold_count: 1, retrieved: 'all', delivered: 'all' }) }))).toMatchObject({ basis: 'needs_model' });
  });

  test('a residual row no labeller may read is unclassified, so it never waits for a label that cannot come', () => {
    const delivered = gold({ gold_count: 1, retrieved: 'all', delivered: 'all' });
    expect(classify(failure({ gold: delivered }))).toMatchObject({ cause: 'unclassified', basis: 'unclassified', rule_id: 'residual.no_labeller_text' });
    expect(classify(failure({ gold: delivered, text, visibility: 'private' }))).toMatchObject({ basis: 'unclassified', rule_id: 'residual.no_labeller_text' });
    expect(classify(failure({ gold: delivered, text, visibility: 'public' }))).toMatchObject({ basis: 'needs_model' });
  });

  test('a passed row is never given a cause', () => {
    expect(classify(failure({ failed: false, stop: 'turn_cap' }))).toMatchObject({ cause: null, basis: 'unclassified', rule_id: 'passed', secondary: [] });
  });

  test('a row for a task the system never ran is neither passed nor failed', () => {
    expect(classify(failure({ failed: false, not_run: 'does_not_fit' }))).toMatchObject({ cause: null, basis: 'unclassified', rule_id: 'not_run.does_not_fit', secondary: [] });
  });

  test('a row with no answer to judge is never an answered abstention question, and with no other signal is residual.no_answer', () => {
    const abstention = { category: 'abstention', gold: gold({ gold_count: 0 }), tags: ['no_answer' as const] };
    expect(classify(failure(abstention))).toMatchObject({ cause: 'unclassified', basis: 'unclassified', rule_id: 'residual.no_answer', secondary: [] });
    expect(classify(failure({ ...abstention, stop: 'timeout' }))).toMatchObject({ cause: 'timeout_latency', rule_id: 'budget.timeout', secondary: [] });
    expect(classify(failure({ gold: gold({ gold_count: 1, retrieved: 'all', delivered: 'all' }), text, visibility: 'public', tags: ['no_answer'] }))).toMatchObject({ basis: 'unclassified', rule_id: 'residual.no_answer' });
  });

  test('null evidence never yields retrieval_miss; measured-empty does', () => {
    expect(classify(failure({ gold: gold({ gold_count: 2 }) })).basis).not.toBe('deterministic');
    expect(classify(failure({ gold: gold({ gold_count: 2, retrieved: 'none' }) }))).toMatchObject({ cause: 'retrieval_miss', rule_id: 'retrieval.no_gold_retrieved' });
  });

  test('gold retrieved but cut before the model is wrong_ranking; partly retrieved is partial_evidence', () => {
    expect(classify(failure({ gold: gold({ gold_count: 1, retrieved: 'all', delivered: 'none' }) })).cause).toBe('wrong_ranking');
    expect(classify(failure({ gold: gold({ gold_count: 2, retrieved: 'all', delivered: 'partial' }) })).rule_id).toBe('ranking.some_gold_cut');
    expect(classify(failure({ gold: gold({ gold_count: 2, retrieved: 'partial', delivered: 'partial' }) })).cause).toBe('partial_evidence');
  });

  test('delivered gold with a wrong answer reaches the labeller, so stale, entity and time causes stay reachable', () => {
    const l = classify(failure({ category: 'knowledge_update', text, gold: gold({ gold_count: 1, retrieved: 'all', delivered: 'all' }) }));
    expect(l).toMatchObject({ cause: null, basis: 'needs_model' });
  });

  test('an agent that found the gold in search but never opened it is gold_unopened', () => {
    const l = classify(failure({ agent_loop: true, tool_calls: [{ name: 'search', error: null, recovered: null, ms: 5, memory: true }],
      gold: gold({ gold_count: 1, retrieved: 'all', delivered: 'all', opened: 'none' }) }));
    expect(l).toMatchObject({ cause: 'gold_unopened', rule_id: 'open.gold_never_opened' });
  });

  test('an agent loop with no memory call is memory_not_consulted', () => {
    expect(classify(failure({ agent_loop: true, tool_calls: [] })).cause).toBe('memory_not_consulted');
    expect(classify(failure({ agent_loop: true, tool_calls: [{ name: 'search', error: null, recovered: null, ms: 1, memory: true }], stop: 'no_tool_call' })).cause).toBe('memory_not_consulted');
  });

  test('an unrecovered tool error is tool_contract; a recovered one is only a tag', () => {
    const call = (recovered: boolean) => [{ name: 'get_page', error: 'invalid_params', recovered, ms: 3, memory: true }];
    expect(classify(failure({ tool_calls: call(false) }))).toMatchObject({ cause: 'tool_contract', rule_id: 'tool.unrecovered_error' });
    const recovered = classify(failure({ tool_calls: call(true) }));
    expect(recovered.basis).not.toBe('deterministic');
    expect(recovered.tags).toContain('recovered_tool_error');
  });

  test('a tool error whose recovery the source did not record is tool_contract under its own rule', () => {
    expect(classify(failure({ tool_calls: [{ name: 'get_page', error: 'invalid_params', recovered: null, ms: 3, memory: true }] })))
      .toMatchObject({ cause: 'tool_contract', rule_id: 'tool.error_recovery_unknown' });
  });

  test('write records give write_integrity by kind; an empty measured list gives nothing', () => {
    expect(classify(failure({ writes: { lost: ['F2'], stuck: [], overwritten: null, duplicated: [] } })).rule_id).toBe('write.lost');
    expect(classify(failure({ writes: { lost: [], stuck: [], overwritten: [], duplicated: [] } })).basis).not.toBe('deterministic');
  });

  test('harness, operations, ingest and visibility signals', () => {
    expect(classify(failure({ stop: 'harness_error' })).rule_id).toBe('harness.stop_harness_error');
    expect(classify(failure({ finish_reason: 'length' })).rule_id).toBe('harness.output_truncated');
    expect(classify(failure({ operation: { step: 'upgrade', error: 'migration v297 failed' } })).cause).toBe('operations');
    expect(classify(failure({ tags: ['wrong_stored_fact'] })).rule_id).toBe('ingest.wrong_stored_fact');
    expect(classify(failure({ gold: gold({ gold_count: 1, hidden: 'all' }) })).cause).toBe('privacy_hidden');
  });

  test('a reply cut off at its output limit is harness.output_truncated for every finish qa-v2 counts as cut, also beside the harness error that records the cut', () => {
    for (const finish of [...TRUNCATED_FINISHES, 'max_output_tokens']) {
      expect(classify(failure({ finish_reason: finish })).rule_id).toBe('harness.output_truncated');
      expect(classify(failure({ finish_reason: finish, harness: { error: `output_truncated: finish ${finish}`, scorer_artifact: null } }))).toMatchObject({ cause: 'harness_error', rule_id: 'harness.output_truncated' });
    }
    expect(classify(failure({ finish_reason: 'stop', harness: { error: 'provider 529', scorer_artifact: null } })).rule_id).toBe('harness.error');
  });

  test('an abstention question answered anyway is citation_abstention; a misreported write is too', () => {
    expect(classify(failure({ category: 'abstention', gold: gold({ gold_count: 0 }) })).rule_id).toBe('reasoning.answered_unanswerable');
    expect(classify(failure({ tags: ['misreport'], writes: { lost: [], stuck: [], overwritten: null, duplicated: [] } })).rule_id).toBe('reasoning.misreported_state');
  });
});

describe('classify: precedence', () => {
  test('a row that hit the turn cap carries the turn_cap tag whatever its primary cause', () => {
    expect(classify(failure({ stop: 'turn_cap', gold: gold({ gold_count: 2, retrieved: 'partial', delivered: 'partial' }) }))).toMatchObject({ cause: 'partial_evidence', secondary: ['timeout_latency'] });
    expect(classify(failure({ stop: 'turn_cap', gold: gold({ gold_count: 2, retrieved: 'partial', delivered: 'partial' }) })).tags).toContain('turn_cap');
    expect(classify(failure({ stop: 'context_overflow' })).tags).not.toContain('turn_cap');
    expect(classify(failure({ stop: 'max_turns' })).tags).toContain('turn_cap');
  });

  test('the earliest stage wins and later signals stay as secondary causes', () => {
    const l = classify(failure({
      harness: { error: 'judge reply did not parse', scorer_artifact: null },
      tool_calls: [{ name: 'capture', error: 'refused_retryable/worktree_refreshing', recovered: false, ms: 9805, memory: true }],
      writes: { lost: ['F1'], stuck: [], overwritten: null, duplicated: [] },
    }));
    expect(l).toMatchObject({ cause: 'harness_error', rule_id: 'harness.error' });
    expect(l.secondary).toEqual(['tool_contract', 'write_integrity']);
  });

  test('a scorer artifact is primary only when it is the only signal, so it never hides a real failure', () => {
    const artifact = { error: null, scorer_artifact: 'untitled_capture_duplicate' };
    const l = classify(failure({ harness: artifact,
      tool_calls: [{ name: 'capture', error: 'refused_retryable/worktree_refreshing', recovered: false, ms: 9805, memory: true }],
      writes: { lost: ['F1'], stuck: [], overwritten: null, duplicated: [] } }));
    expect(l).toMatchObject({ cause: 'tool_contract', rule_id: 'tool.unrecovered_error' });
    expect(l.secondary).toEqual(['write_integrity', 'harness_error']);
    expect(l.tags).toContain('scorer_artifact');
    expect(classify(failure({ harness: artifact, writes: { lost: [], stuck: [], overwritten: null, duplicated: [] } })))
      .toMatchObject({ cause: 'harness_error', rule_id: 'harness.scorer_artifact.untitled_capture_duplicate' });
  });

  test('a turn cap is primary only with no earlier signal, else a secondary cause', () => {
    expect(classify(failure({ stop: 'turn_cap' }))).toMatchObject({ cause: 'timeout_latency', rule_id: 'budget.turn_cap' });
    const l = classify(failure({ stop: 'turn_cap', gold: gold({ gold_count: 1, retrieved: 'none' }) }));
    expect(l.cause).toBe('retrieval_miss');
    expect(l.secondary).toEqual(['timeout_latency']);
  });

  test('a recovered refusal does not beat a later real cause', () => {
    const l = classify(failure({ tool_calls: [{ name: 'capture', error: 'refused_retryable', recovered: true, ms: 1, memory: true }], writes: { lost: [], stuck: [], overwritten: null, duplicated: ['F3'] } }));
    expect(l).toMatchObject({ cause: 'write_integrity', rule_id: 'write.duplicated' });
  });
});

describe('classify: more gold than the reader is given', () => {
  const over = (g: Partial<ReturnType<typeof failure>['gold']>) => gold({ gold_count: 6, reader_budget: 5, ...g });

  test('gold all retrieved but cut past the reader budget is reader_budget, not ranking.some_gold_cut (lme-s-hard a3838d2b: 6 gold at ranks 1 to 6, the reader given 5)', () => {
    expect(classify(failure({ gold: over({ retrieved: 'all', delivered: 'partial' }) }))).toMatchObject({ cause: 'reader_budget', basis: 'deterministic', rule_id: 'harness.gold_over_reader_budget', secondary: ['wrong_ranking'] });
  });

  test('gold over the budget with partial or no retrieval is reader_budget too, and the gbrain cause stays as a secondary cause', () => {
    expect(classify(failure({ gold: over({ gold_count: 9, retrieved: 'partial', delivered: 'partial' }) }))).toMatchObject({ cause: 'reader_budget', secondary: ['partial_evidence'] });
    expect(classify(failure({ gold: over({ gold_count: 24, retrieved: 'none', delivered: 'none' }) }))).toMatchObject({ cause: 'reader_budget', secondary: ['retrieval_miss'] });
    expect(classify(failure({ gold: over({ gold_count: 11, retrieved: null, delivered: 'none' }) }))).toMatchObject({ cause: 'reader_budget', secondary: ['retrieval_miss'] });
  });

  test('gold equal to the budget keeps its label (81507db6: 5 gold at ranks 1, 2, 3, 4 and 6 is wrong_ranking), and one gold item more is reader_budget', () => {
    expect(classify(failure({ gold: over({ gold_count: 5, retrieved: 'all', delivered: 'partial' }) }))).toMatchObject({ cause: 'wrong_ranking', rule_id: 'ranking.some_gold_cut', secondary: [] });
    expect(classify(failure({ gold: over({ gold_count: 6, retrieved: 'all', delivered: 'partial' }) })).cause).toBe('reader_budget');
  });

  test('a row that records no budget labels as before, and the same row with its run\'s budget is reader_budget', () => {
    for (const reader_budget of [undefined, null]) {
      expect(classify(failure({ gold: over({ retrieved: 'all', delivered: 'partial', reader_budget }) }))).toMatchObject({ cause: 'wrong_ranking', rule_id: 'ranking.some_gold_cut' });
    }
    expect(classify(failure({ gold: over({ retrieved: 'all', delivered: 'partial' }) })).cause).toBe('reader_budget');
  });

  test('a cut-off answer with more gold than the budget stays harness.output_truncated, with reader_budget and the gbrain cause as secondary causes', () => {
    expect(classify(failure({ finish_reason: 'max_tokens', gold: over({ gold_count: 9, retrieved: 'partial', delivered: 'partial' }) })))
      .toMatchObject({ cause: 'harness_error', rule_id: 'harness.output_truncated', secondary: ['reader_budget', 'partial_evidence'] });
    expect(classify(failure({ harness: { error: 'provider 529', scorer_artifact: null }, gold: over({ retrieved: 'all', delivered: 'partial' }) })))
      .toMatchObject({ cause: 'harness_error', rule_id: 'harness.error', secondary: ['reader_budget', 'wrong_ranking'] });
  });
});

describe('classify: items whose cited turns don\'t support the answer', () => {
  test('an item both support validators reject is item_unsupported, not a gbrain cause, and the gbrain cause stays secondary (BEAM 1m-2:contradiction_resolution:0)', () => {
    expect(classify(failure({ gold: gold({ gold_count: 2, retrieved: 'partial', delivered: 'partial', unsupported: 'both_validators' }) })))
      .toMatchObject({ cause: 'item_unsupported', basis: 'deterministic', rule_id: 'harness.item_unsupported_by_both_validators', secondary: ['partial_evidence'] });
  });

  test('an item that cites no turn is item_unsupported under its own rule', () => {
    expect(classify(failure({ gold: gold({ gold_count: 1, retrieved: 'none', delivered: 'none', unsupported: 'uncited' }) })))
      .toMatchObject({ cause: 'item_unsupported', rule_id: 'harness.item_cites_no_turn', secondary: ['retrieval_miss'] });
  });

  test('a supported or unchecked item labels as before', () => {
    for (const unsupported of [undefined, null]) {
      expect(classify(failure({ gold: gold({ gold_count: 2, retrieved: 'partial', delivered: 'partial', unsupported }) }))).toMatchObject({ cause: 'partial_evidence' });
    }
    expect(classify(failure({ gold: gold({ gold_count: 2, retrieved: 'partial', delivered: 'partial', unsupported: 'both_validators' }) })).cause).toBe('item_unsupported');
  });

  test('item_unsupported comes after the harness rules and before reader_budget', () => {
    const both = gold({ gold_count: 9, reader_budget: 5, retrieved: 'partial', delivered: 'partial', unsupported: 'both_validators' });
    expect(classify(failure({ gold: both }))).toMatchObject({ cause: 'item_unsupported', secondary: ['reader_budget', 'partial_evidence'] });
    expect(classify(failure({ finish_reason: 'max_tokens', gold: both })))
      .toMatchObject({ cause: 'harness_error', rule_id: 'harness.output_truncated', secondary: ['item_unsupported', 'reader_budget', 'partial_evidence'] });
  });
});
