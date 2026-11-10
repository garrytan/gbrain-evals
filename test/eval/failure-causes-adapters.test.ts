import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ADAPTERS, classify, loadSource, nightlyFailure, validateManifest, SOURCES_SCHEMA } from '../../eval/runner/failure-causes/index.ts';
import { cat40Calls, cat40Fields, namesSlug } from '../../eval/runner/failure-causes/adapters/cat40.ts';
import { fileText, sha256, tarFiles, type LoadedFile } from '../../eval/runner/failure-causes/manifest.ts';
import { itemUnsupported } from '../../eval/runner/nightly/item-support.ts';
import { harnessOf } from '../../eval/runner/nightly/outcome.ts';
import { entry, failure, FX, loadFixture } from '../support/failure-causes-fixture.ts';

const byCase = (failures: ReturnType<typeof ADAPTERS.rs1>['failures']) => new Map(failures.map(f => [f.case_id, classify(f)]));
const mem = (path: string, role: string, rows: unknown[]): LoadedFile => {
  const bytes = new TextEncoder().encode(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { path, role, sha256: sha256(bytes), root: 'mem', bytes };
};
/** A tar.gz written by the system tar from files under one top directory, as a LoadedFile. */
const tarball = (path: string, role: string, files: Record<string, string>, format = 'gnu'): LoadedFile => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-tar-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'in', name)), { recursive: true });
    writeFileSync(join(dir, 'in', name), text);
  }
  execFileSync('tar', [`--format=${format}`, '-czf', join(dir, 'out.tar.gz'), '-C', join(dir, 'in'), ...new Set(Object.keys(files).map(n => n.split('/')[0]!))]);
  const bytes = new Uint8Array(readFileSync(join(dir, 'out.tar.gz')));
  return { path, role, sha256: sha256(bytes), root: 'mem', bytes };
};

describe('refresh-barrier Part C adapter', () => {
  const out = ADAPTERS['refresh-barrier'](loadFixture('partc', [['sol-off-task-1.json', 'episode'], ['opus-on-task-4.json', 'episode'], ['sol-on-task-1.json', 'episode']]), entry('partc', 'refresh-barrier', { condition: 'forced' }));
  const labels = byCase(out.failures);

  test('reads failure on the adjudicated rule and counts the passing episode', () => {
    expect(out.counts).toMatchObject({ read: 3, mapped: 3, failed: 2, duplicate: 0 });
    expect(labels.has('openai:gpt-6.1-sol|on|task-1')).toBe(false);
  });

  test('a refusal followed by a reissue under a new request id is tool_contract', () => {
    expect(labels.get('openai:gpt-6.1-sol|off|task-1')).toMatchObject({ cause: 'tool_contract', rule_id: 'tool.unrecovered_error', arm_role: 'gbrain_default', condition: 'forced' });
  });

  test('an untitled-capture duplicate is the scorer artifact, a harness error, not a gbrain write', () => {
    const l = labels.get('anthropic:claude-opus-5-5|on|task-4')!;
    expect(l).toMatchObject({ cause: 'harness_error', rule_id: 'harness.scorer_artifact.untitled_capture_duplicate', arm_role: 'gbrain_variant' });
    expect(l.secondary).not.toContain('write_integrity');
    expect(l.tags).toContain('untitled_capture_duplicate');
    expect(l.evidence[0]).toMatch(/^fx:opus-on-task-4\.json#[0-9a-f]{8}$/);
  });
});

describe('rs1 adapter', () => {
  const files = loadFixture('rs1', [['rows.ndjson', 'rows'], ['answers.ndjson', 'answers'], ['judgments.ndjson', 'judgments'], ['1m-90-probing_questions.json', 'gold'], ['contexts.ndjson', 'contexts']]);
  const out = ADAPTERS.rs1(files, entry('rs1', 'rs1', { visibility: 'public' }));
  const labels = new Map(out.failures.map(f => [f.case_id.split('|')[1], classify(f)]));

  test('fails a row on its gating frontier judge, never on the bridge judge', () => {
    expect(out.counts).toMatchObject({ read: 6, mapped: 6, failed: 5 });
    expect(labels.has('1m-90:information_extraction:0')).toBe(false);
  });

  test('maps recall at 10 to retrieval causes and leaves delivered-gold failures to the labeller', () => {
    expect(labels.get('1m-90:temporal_reasoning:0')?.cause).toBe('retrieval_miss');
    expect(labels.get('1m-90:multi_session_reasoning:0')?.cause).toBe('partial_evidence');
    expect(labels.get('1m-90:abstention:0')?.cause).toBe('citation_abstention');
    expect(labels.get('1m-90:knowledge_update:0')).toMatchObject({ basis: 'needs_model', arm_role: 'gbrain_default' });
    expect(labels.get('1m-90:preference_following:0')).toMatchObject({ cause: 'harness_error', rule_id: 'harness.error' });
  });

  test('public rows carry text for the labeller; other systems are tagged as such', () => {
    expect(out.failures.find(f => f.category === 'knowledge_update')?.text?.question).toContain('Synthetic knowledge_update question');
    const other = ADAPTERS.rs1(files, entry('rs1', 'rs1', { visibility: 'private', arm_roles: { 'gbrain-defaults': 'other_system' } }));
    expect(other.failures.every(f => f.arm_role === 'other_system' && f.text === undefined)).toBe(true);
  });
});

describe('rs1 adapter: cells and outcomes the cell never judges', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, category: 'knowledge_update', gold_count: 1, outcome: 'scored', recall_any_at_10: 1, recall_all_at_10: 1,
    packing_loss: { items_offered: 8, items_cut: 0, items_dropped: 0 }, ...extra });
  const answer = (cell: string, q: string, outcome: string) => ({ answer_id: `${cell}-${q}`, cell_id: cell, question_id: q, system: 'gbrain-defaults',
    reader: 'anthropic:claude-opus-5-5', replicate: 0, text: 'a', outcome });
  const judge = (id: string, score: number) => ({ answer_id: id, judge: 'openai:gpt-6.1-sol', score, parse_ok: true, outcome: 'scored' });
  const cell = (dir: string, rows: unknown[], answers: unknown[], judgments: unknown[]) =>
    [mem(`${dir}/rows.ndjson`, 'rows', rows), mem(`${dir}/answers.ndjson`, 'answers', answers), mem(`${dir}/judgments.ndjson`, 'judgments', judgments)];
  const files = [
    ...cell('a', ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'].map(q => row(q, q === 'q5' ? { outcome: 'retrieval_error', error_kind: 'product_error', recall_measurable: false } : {})),
      [answer('gbrain-a', 'q1', 'reader_error'), answer('gbrain-a', 'q2', 'turn_cap'), answer('gbrain-a', 'q3', 'budget_not_run'), answer('gbrain-a', 'q4', 'ingest_degraded'), answer('gbrain-a', 'q5', 'retrieval_error'),
        answer('gbrain-a', 'q6', 'does_not_fit'), answer('gbrain-a', 'q7', 'unsupported'), answer('gbrain-a', 'q8', 'judge_error')],
      [judge('gbrain-a-q4', 0)]),
    ...cell('b', [row('q1', { recall_any_at_10: 0, recall_all_at_10: 0 })], [answer('gbrain-b', 'q1', 'scored')], [judge('gbrain-b-q1', 0)]),
  ];
  const out = ADAPTERS.rs1(files, entry('rs1', 'rs1'));
  const labels = new Map(out.failures.map(f => [f.case_id.split('|').slice(0, 2).join('|'), classify(f)]));

  test('an unjudged answer follows outcomes.ts: harness errors, a turn cap, gbrain misses, and skips for budget_not_run and does_not_fit', () => {
    expect(out.counts).toMatchObject({ read: 9, mapped: 7, failed: 7, skipped: 2 });
    expect(out.counts.skipped_reasons).toEqual({ budget_not_run: 1, 'does_not_fit (not applicable)': 1 });
    expect(labels.has('gbrain-a|q6')).toBe(false);
    expect(labels.get('gbrain-a|q1')).toMatchObject({ cause: 'harness_error', rule_id: 'harness.error' });
    expect(labels.get('gbrain-a|q8')).toMatchObject({ cause: 'harness_error', rule_id: 'harness.error' });
    expect(labels.get('gbrain-a|q2')).toMatchObject({ cause: 'timeout_latency', rule_id: 'budget.turn_cap' });
    expect(labels.get('gbrain-a|q5')).toMatchObject({ cause: 'retrieval_miss', rule_id: 'retrieval.retrieve_error' });
    expect(labels.get('gbrain-a|q5')?.tags).toContain('retrieve_error');
    expect(labels.get('gbrain-a|q7')).toMatchObject({ cause: 'unclassified', rule_id: 'residual.no_answer' });
    expect(out.failures.filter(f => ['q5', 'q7'].includes(f.task_id!)).map(f => f.harness)).toEqual([null, null]);
    expect((out.not_run ?? []).map(f => [f.task_id, f.failed, classify(f).rule_id, classify(f).cause])).toEqual([['q3', false, 'not_run.budget_not_run', null], ['q6', false, 'not_run.does_not_fit', null]]);
  });

  test('a retrieval timeout is a timeout, and a store arm\'s retrieval_error is no retrieval miss', () => {
    const storeRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, category: 'knowledge_update', gold_count: 1, recall_measurable: false, ...extra });
    const t = ADAPTERS.rs1([
      ...cell('p', [row('q1', { outcome: 'retrieval_error', error_kind: 'timeout', recall_measurable: false }), row('q2', { gold_count: 0, category: 'abstention' })],
        [answer('gbrain-p', 'q1', 'retrieval_error'), answer('gbrain-p', 'q2', 'unsupported')], []),
      ...cell('s', [storeRow('q1'), storeRow('q2'), storeRow('q3'), storeRow('q4', { gold_count: 0, category: 'abstention' })],
        [answer('gbrain-s', 'q1', 'retrieval_error'), { ...answer('gbrain-s', 'q2', 'retrieval_error'), stop_reason: 'wall_time' }, answer('gbrain-s', 'q3', 'scored'), answer('gbrain-s', 'q4', 'retrieval_error')],
        [judge('gbrain-s-q3', 0)]),
    ], entry('rs1', 'rs1'));
    const got = new Map(t.failures.map(f => [f.case_id.split('|').slice(0, 2).join('|'), classify(f)]));
    expect(got.get('gbrain-p|q1')).toMatchObject({ cause: 'timeout_latency', rule_id: 'budget.timeout' });
    expect(got.get('gbrain-p|q1')?.tags).not.toContain('retrieve_error');
    expect(got.get('gbrain-p|q2')).toMatchObject({ cause: 'unclassified', rule_id: 'residual.no_answer' });
    expect(got.get('gbrain-s|q1')).toMatchObject({ cause: 'unclassified', rule_id: 'residual.no_answer' });
    expect(got.get('gbrain-s|q1')?.tags).toEqual(['measured_at_10', 'no_answer']);
    expect(got.get('gbrain-s|q2')).toMatchObject({ cause: 'timeout_latency', rule_id: 'budget.timeout' });
    expect(got.get('gbrain-s|q3')).toMatchObject({ cause: 'unclassified', rule_id: 'residual.delivery_unmeasured' });
    expect(got.get('gbrain-s|q4')).toMatchObject({ cause: 'unclassified', rule_id: 'residual.no_answer' });
  });

  test('an unsupported answer carries no labeller text, even on a public source', () => {
    const id = '1m-1:knowledge_update:0';
    const pub = ADAPTERS.rs1([
      ...cell('c', [row(id)], [answer('gbrain-c', id, 'unsupported'), { ...answer('gbrain-c', id, 'scored'), answer_id: 'gbrain-c-r1', replicate: 1 }], [judge('gbrain-c-r1', 0)]),
      mem('1m-1-probing_questions.json', 'gold', [{ knowledge_update: [{ question: 'Which plan?', answer: 'The second' }] }]),
    ], entry('rs1', 'rs1', { visibility: 'public' }));
    const byReplicate = new Map(pub.failures.map(f => [f.case_id.split('|')[3], f]));
    expect(byReplicate.get('r1')?.text?.question).toBe('Which plan?');
    expect(byReplicate.get('r0')).toMatchObject({ failed: true, harness: null });
    expect(byReplicate.get('r0')?.text).toBeUndefined();
  });

  test('a failed ingest_degraded answer is judged and counts as operations', () => {
    expect(labels.get('gbrain-a|q4')).toMatchObject({ cause: 'operations', rule_id: 'operations.ingest_degraded' });
  });

  test('each directory is its own cell: an answer reads its own rows file', () => {
    expect(labels.get('gbrain-b|q1')).toMatchObject({ cause: 'retrieval_miss', rule_id: 'retrieval.no_gold_retrieved', task_id: 'q1' });
    expect(labels.get('gbrain-a|q1')?.task_id).toBe('q1');
    expect(() => ADAPTERS.rs1([...files, mem('a/rows-2.ndjson', 'rows', [row('q9')])], entry('rs1', 'rs1'))).toThrow(/a second rows file in a/);
  });
});

describe('cat40 adapter: calls, slugs and recovery', () => {
  test('two worlds that reuse keys and attempt ids stay apart, each with its own transcripts and gbrain sha', () => {
    const row = (run: string) => ({ schema: 'cat40-cell-v2', key: 'claude-opus-5-5|gbrain-next-baseline|H1-01|0', attempt_id: 'claude-opus-5-5|gbrain-next-baseline|H1-01|0#1',
      model: 'claude-opus-5-5', provider: 'anthropic', arm: 'gbrain-next-baseline', task: 'H1-01', family: 'H1', budget_run_id: run, stop: 'submitted',
      sessions: [{ run: { tool_calls: [{ name: 'search' }], final: 'x' } }], score: { success: false, evidence_cited: [], missed_evidence: ['people/alice'] } });
    const world = (dir: string, run: string, result: string, sha: string) => [mem(`${dir}/results.jsonl`, 'results', [row(run)]),
      mem(`${dir}/transcripts.jsonl`, 'transcripts', [{ attempt_id: row(run).attempt_id, tools: [{ name: 'search', args: { query: 'q' }, result }] }]),
      mem(`${dir}/experiment.json`, 'experiment', [{ gbrain_commit: sha, world_digest: sha.replace(/./g, dir.slice(-1)) }])];
    const out = ADAPTERS.cat40([...world('p1', 'run-1', '[{"slug":"people/alice"}]', 'a'.repeat(40)), ...world('p2', 'run-2', '[]', 'b'.repeat(40))], entry('cat40', 'cat40'));
    expect(out.counts).toMatchObject({ read: 2, duplicate: 0, failed: 2 });
    expect(out.failures.map(f => [f.run_id, f.gbrain_sha, f.gold.retrieved, f.task_id])).toEqual([['run-1', 'a'.repeat(40), 'all', `${'1'.repeat(12)}|H1-01`], ['run-2', 'b'.repeat(40), 'none', `${'2'.repeat(12)}|H1-01`]]);
  });

  test('a v1 row keeps its first session\'s calls before the second\'s', () => {
    expect(cat40Fields({ key: 'k', score: {}, session1: { tool_calls: [{ name: 'capture' }] }, run: { stop: 'submitted', tool_calls: [{ name: 'search' }] } })?.calls.map(c => c.name)).toEqual(['capture', 'search']);
  });

  test('a slug matches only whole, never as the start of a longer slug', () => {
    expect(namesSlug('{"slug":"people/alice"}', 'people/alice')).toBe(true);
    expect(namesSlug('read people/alice.md', 'people/alice')).toBe(true);
    expect(namesSlug('{"slug":"people/alice-smith"}', 'people/alice')).toBe(false);
    expect(namesSlug('archive/people/alice', 'people/alice')).toBe(false);
  });

  test('a tool error is recovered only by a later success of the same tool on the same target, and unknown without aligned transcript args', () => {
    const calls = [{ name: 'get_page', error: 'not_found' }, { name: 'get_page' }, { name: 'get_page', error: 'timeout' }, { name: 'get_page' }, { name: 'search', error: 'timeout' }, { name: 'submit_answer' }];
    const args = [{ args: { slug: 'a' } }, { args: { slug: 'b' } }, { args: { slug: 'c' } }, { args: { slug: 'c' } }, { args: { query: 'x' } }, { args: {} }];
    expect(cat40Calls(calls, args).map(c => c.recovered)).toEqual([false, null, true, null, false]);
    expect(cat40Calls(calls, undefined).map(c => c.recovered)).toEqual([null, null, null, null, null]);
    expect(cat40Calls(calls, args.slice(1)).map(c => c.recovered)).toEqual([null, null, null, null, null]);
    expect(classify(failure({ tool_calls: cat40Calls(calls, undefined) }))).toMatchObject({ cause: 'tool_contract', rule_id: 'tool.error_recovery_unknown' });
  });
});

describe('cat40 adapter', () => {
  const out = ADAPTERS.cat40(loadFixture('cat40', [['results.jsonl', 'results'], ['results-v1.jsonl', 'results'], ['transcripts.jsonl', 'transcripts']]), entry('cat40', 'cat40'));
  const labels = byCase(out.failures);

  test('counts a repeated key once and skips models not under test', () => {
    expect(out.counts).toMatchObject({ read: 7, mapped: 5, duplicate: 1, skipped: 1, failed: 3 });
    expect(out.counts.skipped_reasons).toEqual({ 'model not under test': 1 });
  });

  test('reads both row shapes: a v1 failure takes its stop from run.stop', () => {
    const v1 = out.failures.find(f => f.case_id === 'gpt-6.1-sol|fs|A09|0')!;
    expect(v1).toMatchObject({ stop: 'submitted', arm_role: 'other_system', agent_loop: true });
    expect(labels.get('claude-opus-5-5|gbrain-next-baseline|H1-03|0')?.secondary).toContain('timeout_latency');
  });

  test('reads gold coverage from the transcripts', () => {
    const f = out.failures.find(x => x.case_id === 'gpt-6.1-sol|gbrain-next-baseline|H1-04|0')!;
    expect(f.gold).toMatchObject({ gold_count: 40, retrieved: 'none', opened: 'none' });
    expect(labels.get(f.case_id)?.cause).toBe('retrieval_miss');
  });

  test('refuses a row shape it does not know', () => {
    const bad = { path: 'bad.jsonl', role: 'results', sha256: '0'.repeat(64), root: 'fx', bytes: new TextEncoder().encode(JSON.stringify({ key: 'k', score: {}, schema: 'cat40-cell-v9' }) + '\n') };
    expect(() => ADAPTERS.cat40([bad], entry('cat40', 'cat40'))).toThrow(/unknown Cat 40 row shape/);
  });
});

describe('stress adapters', () => {
  test('SkillOpt proposer inputs give refused-call counts with the empty-argument signature', () => {
    const out = ADAPTERS.skillopt(loadFixture('skillopt', [['sol-proposer-input.txt', 'proposer_input']]), entry('so', 'skillopt', { model: 'openai:gpt-6.1-sol', condition: 'forced', visibility: 'public' }));
    expect(out.failures).toEqual([]);
    expect(out.stress.map(s => [s.cause, s.count, s.of])).toEqual([['tool_contract', 3, 3], ['tool_contract', 1, 1]]);
    expect(out.stress[0].detail).toContain('cursor 3');
  });

  test('live-recall scorecards give aggregate counts only', () => {
    const out = ADAPTERS['live-recall'](loadFixture('live-recall', [['scorecard.json', 'scorecard']]), entry('lr', 'live-recall', { visibility: 'private' }));
    expect(out.stress.map(s => [s.system, s.cause, s.count, s.of])).toEqual([
      ['gbrain/keyword', 'retrieval_miss', 66, 100], ['gbrain/keyword', 'wrong_ranking', 2, 100],
      ['gbrain/hybrid', 'retrieval_miss', 33, 100], ['gbrain/hybrid', 'wrong_ranking', 13, 100],
    ]);
  });

  test('two scorecards of the same questions stay apart: each count names the gbrain version it loaded', () => {
    const card = (version: string, at20: number) => ({ schema: 'live-recall-scorecard/v1', run: { gbrain_loaded_version: version, gbrain_loaded_commit: 'c'.repeat(40) },
      arms: { hybrid_lexical: { overall: { all: { n: 100, success_at: { k5: { hits: 48 }, k20: { hits: at20 } } } } } } });
    const out = ADAPTERS['live-recall']([mem('b2-577.json', 'scorecard', [card('0.60.577.0', 60)]), mem('b2-593.json', 'scorecard', [card('0.60.593.0', 61)])], entry('lr', 'live-recall'));
    expect(out.stress.filter(s => s.cause === 'retrieval_miss').map(s => s.detail)).toEqual([
      'hybrid_lexical at gbrain 0.60.577.0: gold page not in the top 20 for 40 of 100 questions', 'hybrid_lexical at gbrain 0.60.593.0: gold page not in the top 20 for 39 of 100 questions']);
  });
});

describe('nightly adapter', () => {
  const files = loadFixture('nightly', [['outcomes.jsonl', 'outcomes']]);
  const fixtureRows = fileText(files[0]!).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const out = ADAPTERS.nightly(files, entry('nightly-week', 'nightly'));
  const byItem = new Map(out.failures.map(f => [f.task_id, f]));
  const labels = new Map(out.failures.map(f => [f.task_id, classify(f)]));
  const sha = 'c'.repeat(40);

  test('reads every row once: a later row with the same identity replaces the earlier one, and a row without the suite facts is skipped', () => {
    expect(out.counts).toEqual({ read: 17, mapped: 13, duplicate: 1, skipped: 3, failed: 12, skipped_reasons: {
      'gbrain cccccccccccc predates the refused-write fix, which this suite needs': 1, 'keyless failure with no deterministic cause': 1, 'row predates the suite facts': 1 } });
    expect(out.failures.map(f => f.task_id).sort()).toEqual(['08f4fc43', '0a995998', '2001', 'H1-02', 'H1-03', 'H1-04']);
  });

  test('identity, the suite facts and the gold come from the row; model is the reader as provider:model; evidence points at the line', () => {
    expect(byItem.get('H1-02')).toMatchObject({ schema: 'eval-failure/1', source: 'nightly-week', run_id: `2026-11-09|master|${sha}`, case_id: 'cat40-hard-m|H1-02|gpt-6.1-sol|t1',
      system: 'gbrain', arm: 'cat40-hard-m@master', arm_role: 'gbrain_default', condition: 'natural', visibility: 'synthetic', model: 'openai:gpt-6.1-sol', gbrain_sha: sha,
      failed: true, score: 0, category: 'H1', agent_loop: true, stop: null, harness: null, operation: null, writes: null,
      gold: { gold_count: 2, stored: null, hidden: null, retrieved: 'partial', delivered: 'partial', opened: 'partial', summary_only: null } });
    expect(byItem.get('H1-02')!.evidence).toEqual([expect.stringMatching(/^fx:outcomes\.jsonl#[0-9a-f]{8} line=2$/)]);
    expect(byItem.get('08f4fc43')!.model).toBe('anthropic:claude-opus-5-5');
    expect(byItem.get('2001')!.writes).toEqual({ lost: [], stuck: null, overwritten: null, duplicated: [] });
  });

  test('causes: an unrecovered refusal, a retrieval miss measured at 10, a misreported write, a harness row, and an answer cut at its output limit', () => {
    expect(labels.get('H1-02')).toMatchObject({ cause: 'tool_contract', rule_id: 'tool.unrecovered_error' });
    expect(labels.get('08f4fc43')).toMatchObject({ cause: 'retrieval_miss', rule_id: 'retrieval.no_gold_retrieved', tags: ['measured_at_10'] });
    expect(labels.get('2001')).toMatchObject({ cause: 'citation_abstention', rule_id: 'reasoning.misreported_state', tags: ['misreport', 'recovered_tool_error'] });
    expect(labels.get('H1-04')).toMatchObject({ cause: 'harness_error', rule_id: 'harness.error' });
    expect(byItem.get('H1-04')!.harness).toEqual({ error: 'harness_error: MCP server exited', scorer_artifact: null });
    expect(labels.get('0a995998')).toMatchObject({ cause: 'harness_error', rule_id: 'harness.output_truncated', tags: ['measured_at_10', 'no_answer'] });
  });

  test('an answer cut off at its output limit reads the same from an older row and from one that records the cut as its harness error, and is a harness failure even when the judge passed it', () => {
    const older = fixtureRows.find(r => r.item === '0a995998');
    const marked = { ...older, harness: harnessOf(older) };
    expect(marked.harness).not.toBeNull();
    expect(nightlyFailure(marked, 'n', [])).toEqual(nightlyFailure(older, 'n', []));
    expect(classify(nightlyFailure(marked, 'n', []))).toMatchObject({ cause: 'harness_error', rule_id: 'harness.output_truncated' });
    const passed = ADAPTERS.nightly([mem('n/outcomes.jsonl', 'outcomes', [{ ...older, pass: true, score: 1 }, { ...marked, item: 'cut-2', pass: true, score: 1 }])], entry('n', 'nightly'));
    expect(passed.counts).toMatchObject({ read: 2, mapped: 2, failed: 2 });
    expect(passed.failures.map(f => classify(f)).map(l => [l.task_id, l.cause, l.rule_id])).toEqual([['0a995998', 'harness_error', 'harness.output_truncated'], ['cut-2', 'harness_error', 'harness.output_truncated']]);
  });

  test('stop: harness_error and error are harness_error, turn_cap stays, a smoke timeout is timeout, an ordinary end is null', () => {
    expect(['H1-02', 'H1-03', 'H1-04', '08f4fc43'].map(i => byItem.get(i)!.stop)).toEqual([null, 'turn_cap', 'harness_error', null]);
    expect(labels.get('H1-03')).toMatchObject({ cause: 'partial_evidence', secondary: ['timeout_latency'], tags: ['no_answer', 'turn_cap'] });
    const smoke = fixtureRows.find(r => r.item === 'upgrade-from-old');
    expect(nightlyFailure(smoke, 'n', []).stop).toBe('timeout');
    expect(nightlyFailure({ ...smoke, stop: 'error' }, 'n', []).stop).toBe('harness_error');
    expect(nightlyFailure({ ...smoke, stop: 'ok' }, 'n', []).stop).toBeNull();
  });

  test('row text only on public or synthetic rows with an answer', () => {
    expect(byItem.get('H1-02')!.text).toEqual({ question: 'Who leads the Acme Example deal?', expected: 'Ada Example', answer: 'Bo Example', context: null });
    expect(byItem.get('08f4fc43')!.text).toMatchObject({ question: 'Which city did the user move to?', answer: 'Lyon' });
    expect(byItem.get('0a995998')!.text).toBeUndefined();
    expect(byItem.get('H1-03')!.text).toBeUndefined();
    const hidden = ADAPTERS.nightly([mem('n/outcomes.jsonl', 'outcomes', [{ ...fixtureRows[1], visibility: 'private' }])], entry('n', 'nightly'));
    expect(hidden.failures[0]!.text).toBeUndefined();
  });

  test('a skipped row comes back as not_run, and classify gives it the not_run rule', () => {
    const reason = 'gbrain cccccccccccc predates the refused-write fix, which this suite needs';
    expect(out.not_run).toEqual([expect.objectContaining({ failed: false, not_run: reason, task_id: '2002', model: 'openai:gpt-6.1-sol', case_id: 'refused-write-agents|2002|gpt-6.1-sol|t1' })]);
    expect(classify(out.not_run![0]!)).toMatchObject({ cause: null, rule_id: `not_run.${reason}` });
  });

  test('keyless rows become stress counts per night, suite and cause, never failures; a keyless failure with no deterministic cause is skipped', () => {
    expect(out.stress.map(s => [s.cause, s.count, s.of, s.detail])).toEqual([
      ['write_integrity', 2, 5, 'concurrent-writers: write.duplicated (1), write.lost (1) in 2 of 5 items'],
      ['harness_error', 1, 5, 'concurrent-writers: harness.error (1) in 1 of 5 items'],
      ['operations', 2, 2, 'system-smokes: operations.source-pinned-sync (1), operations.upgrade-from-old (1) in 2 of 2 items'],
      ['tool_contract', 1, 1, 'tool-contract-replay: tool.unrecovered_error (1) in 1 of 1 items'],
    ]);
    expect(out.stress[0]).toMatchObject({ source: 'nightly-week', run_id: `2026-11-09|master|${sha}`, system: 'gbrain', model: 'none (keyless)', gbrain_sha: sha, condition: 'forced',
      visibility: 'synthetic', unit: 'episodes' });
    expect(out.stress[0]!.evidence).toEqual([expect.stringMatching(/ line=10$/), expect.stringMatching(/ line=13$/)]);
    expect(out.failures.some(f => f.model === 'none (keyless)')).toBe(false);
  });

  test('a logs archive gives each reader its run\'s session budget: a stored 2026-11-10 row with more gold than that is reader_budget, a cut-off one stays harness.output_truncated, and a row with no receipt labels as before', () => {
    const receipt = (reader: string, breadth_sessions: number) => JSON.stringify({ qa: { mode: 'reader', context: 'sessions', reader }, reading: { breadth_sessions }, product: { loaded_git_head: sha } });
    const logs = (opus: number) => tarball('2026-11-10/master/logs/lme-s-hard.tar.gz', 'logs', {
      'lme-s-hard/claude-opus-5-5/out/receipt.json': receipt('anthropic:claude-opus-5-5', opus), 'lme-s-hard/claude-opus-5-5/run.log': 'log',
      'lme-s-hard/gpt-6.1-sol/out/receipt.json': receipt('openai:gpt-6.1-sol', 5) });
    const stored = { schema: 'nightly-outcome/1', night: '2026-11-10', suite: 'lme-s-hard', suite_digest: 'd', role: 'headroom', ref: 'master', sha, trial: 1, pass: false, score: 0, cost_usd: null,
      stop: 'answered', tool_errors: [], evidence: {}, harness: null, system: 'gbrain', arm: 'lme-s-hard@master', arm_role: 'gbrain_default', condition: 'natural', visibility: 'public',
      agent_loop: false, category: 'multi-session', answered: true, finish_reason: 'stop', reader: 'claude-opus-5-5', gold_count: 6, retrieved: 'all', delivered: 'partial' };
    const rows = [
      { ...stored, item: 'a3838d2b' },
      { ...stored, item: '81507db6', gold_count: 5 },
      { ...stored, item: 'gpt4_7abb270c', retrieved: 'partial', finish_reason: 'max_tokens' },
      { ...stored, item: 'gpt4_7abb270c', reader: 'gpt-6.1-sol', retrieved: 'partial' },
      { ...stored, item: 'a3838d2b', reader: 'gpt-6.1-sol', sha: 'd'.repeat(40) },
    ];
    const out = ADAPTERS.nightly([mem('n/outcomes.jsonl', 'outcomes', rows), logs(5)], entry('n', 'nightly'));
    expect(out.failures.map(f => { const l = classify(f); return [f.task_id, f.gold.reader_budget, l.cause, l.rule_id, l.secondary]; })).toEqual([
      ['a3838d2b', 5, 'reader_budget', 'harness.gold_over_reader_budget', ['wrong_ranking']],
      ['81507db6', 5, 'wrong_ranking', 'ranking.some_gold_cut', []],
      ['gpt4_7abb270c', 5, 'harness_error', 'harness.output_truncated', ['reader_budget', 'partial_evidence']],
      ['gpt4_7abb270c', 5, 'reader_budget', 'harness.gold_over_reader_budget', ['partial_evidence']],
      ['a3838d2b', null, 'wrong_ranking', 'ranking.some_gold_cut', []],
    ]);
    expect(out.failures[0]!.evidence).toEqual([expect.stringMatching(/^mem:n\/outcomes\.jsonl#[0-9a-f]{8} line=1$/),
      expect.stringMatching(/^mem:2026-11-10\/master\/logs\/lme-s-hard\.tar\.gz#[0-9a-f]{8} lme-s-hard\/claude-opus-5-5\/out\/receipt\.json$/)]);
    expect(ADAPTERS.nightly([mem('n/outcomes.jsonl', 'outcomes', rows)], entry('n', 'nightly')).failures.map(f => classify(f).cause))
      .toEqual(['wrong_ranking', 'wrong_ranking', 'harness_error', 'partial_evidence', 'wrong_ranking']);
    expect(() => ADAPTERS.nightly([mem('n/outcomes.jsonl', 'outcomes', rows), logs(5), { ...logs(6), path: 'other/lme-s-hard.tar.gz' }], entry('n', 'nightly')))
      .toThrow(/lme-s-hard\/claude-opus-5-5\/out\/receipt\.json: gives lme-s-hard\|c{40}\|anthropic:claude-opus-5-5 6 reader sessions, .* gives 5$/);
    const facts = tarball('f.tar.gz', 'logs', { 'lme-s-hard/claude-opus-5-5/out/receipt.json': JSON.stringify({ qa: { mode: 'reader', context: 'facts', reader: 'anthropic:claude-opus-5-5' },
      reading: { breadth_sessions: 5 }, product: { loaded_git_head: sha } }) });
    expect(ADAPTERS.nightly([mem('n/outcomes.jsonl', 'outcomes', rows), facts], entry('n', 'nightly')).failures.map(f => f.gold.reader_budget)).toEqual([null, null, null, null, null]);
  });

  test('a BEAM item both support validators reject is item_unsupported, with its support record as evidence; one validator, no record or a cut-off answer label as before', () => {
    const beam = { schema: 'nightly-outcome/1', night: '2026-11-10', suite: 'beam-1m-hard', suite_digest: 'd', role: 'headroom', ref: 'master', sha, trial: 1, pass: false, score: 0,
      cost_usd: null, stop: 'answered', tool_errors: [], evidence: {}, harness: null, system: 'gbrain', arm: 'beam-1m-hard@master', arm_role: 'gbrain_default', condition: 'natural',
      visibility: 'public', agent_loop: false, category: 'contradiction_resolution', answered: true, finish_reason: 'stop', reader: 'claude-opus-5-5', gold_count: 2, retrieved: 'partial', delivered: 'partial' };
    const rows = [
      { ...beam, item: '1m-2:contradiction_resolution:0' },
      { ...beam, item: '1m-25:multi_session_reasoning:0' },
      { ...beam, item: '1m-2:not_an_item:0' },
      { ...beam, item: '1m-2:contradiction_resolution:0', reader: 'gpt-6.1-sol', finish_reason: 'max_tokens' },
      { ...beam, suite: 'lme-s-hard', arm: 'lme-s-hard@master', item: '1m-2:contradiction_resolution:0' },
    ];
    const out = ADAPTERS.nightly([mem('n/outcomes.jsonl', 'outcomes', rows)], entry('n', 'nightly'));
    expect(out.failures.map(f => { const l = classify(f); return [f.gold.unsupported, l.cause, l.rule_id]; })).toEqual([
      ['both_validators', 'item_unsupported', 'harness.item_unsupported_by_both_validators'],
      [null, 'partial_evidence', 'retrieval.partial_gold_retrieved'],
      [null, 'partial_evidence', 'retrieval.partial_gold_retrieved'],
      ['both_validators', 'harness_error', 'harness.output_truncated'],
      [null, 'partial_evidence', 'retrieval.partial_gold_retrieved'],
    ]);
    expect(out.failures[0]!.evidence[1]).toMatch(/^repo:eval\/data\/nightly\/beam-1m-hard-support\.json#[0-9a-f]{8} 1m-2:contradiction_resolution:0$/);
  });

  test('reads outcomes.jsonl.gz the same way, refuses a row of another schema, and is registered for manifests', () => {
    const bytes = gzipSync(files[0]!.bytes);
    const gz = ADAPTERS.nightly([{ ...files[0]!, path: 'outcomes.jsonl.gz', bytes, sha256: sha256(bytes) }], entry('nightly-week', 'nightly'));
    expect([gz.counts, gz.failures.length, gz.stress.length]).toEqual([out.counts, out.failures.length, out.stress.length]);
    expect(() => ADAPTERS.nightly([mem('n/outcomes.jsonl', 'outcomes', [{ schema: 'other/1' }])], entry('n', 'nightly'))).toThrow(/^mem:n\/outcomes\.jsonl#[0-9a-f]{8} line=1: not a nightly-outcome\/1 row$/);
    expect(validateManifest({ schema: SOURCES_SCHEMA, sources: [{ id: 'nightly-cat40-hard-m-w45', adapter: 'nightly', visibility: 'synthetic', condition: 'natural', root: 'nightly',
      files: [{ path: '2026-11-09/master/outcomes.jsonl.gz', sha256: 'a'.repeat(64), role: 'outcomes' }] }] })).toEqual([]);
  });
});

describe('source manifests', () => {
  const ok = { schema: SOURCES_SCHEMA, sources: [{ id: 's', adapter: 'cat40', visibility: 'synthetic', condition: 'natural', root: 'fx', files: [{ path: 'cat40/results.jsonl', sha256: 'a'.repeat(64), role: 'results' }] }] };
  const withFile = (path: string) => ({ ...ok, sources: [{ ...ok.sources[0], files: [{ path, sha256: 'a'.repeat(64), role: 'results' }] }] });

  test('a valid manifest passes', () => expect(validateManifest(ok)).toEqual([]));
  test('globs, absolute paths and sealed paths are refused', () => {
    expect(validateManifest(withFile('cat40/*.jsonl')).join()).toMatch(/glob/);
    expect(validateManifest(withFile('/home/x/results.jsonl')).join()).toMatch(/relative/);
    expect(validateManifest(withFile('custody/rs1-custody/answers.ndjson')).join()).toMatch(/sealed path/);
    expect(validateManifest({ ...ok, sources: [{ ...ok.sources[0], visibility: 'sealed' }] }).join()).toMatch(/never read/);
  });

  test('loadSource refuses a hash mismatch and a missing root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-manifest-'));
    writeFileSync(join(dir, 'a.jsonl'), 'x\n');
    const e = { ...ok.sources[0], adapter: 'cat40' as const, visibility: 'synthetic' as const, condition: 'natural' as const, files: [{ path: 'a.jsonl', sha256: sha256('y\n'), role: 'results' }] };
    expect(() => loadSource(e, { fx: dir })).toThrow(/sha256/);
    expect(() => loadSource(e, {})).toThrow(/no directory for root/);
    expect(loadSource({ ...e, files: [{ path: 'a.jsonl', sha256: sha256('x\n'), role: 'results' }] }, { fx: dir })[0].path).toBe('a.jsonl');
  });

  test('loadSource refuses a root that resolves to custody material, whatever the manifest says', () => {
    const custody = join(mkdtempSync(join(tmpdir(), 'fc-sealed-')), 'rs1-custody-x');
    mkdirSync(custody);
    writeFileSync(join(custody, '1m-90-probing_questions.json'), '{}');
    const e = { ...ok.sources[0], id: 'gold', adapter: 'rs1' as const, visibility: 'public' as const, condition: 'natural' as const, root: 'gold', files: [{ path: '1m-90-probing_questions.json', sha256: sha256('{}'), role: 'gold' }] };
    expect(validateManifest({ ...ok, sources: [e] })).toEqual([]);
    expect(() => loadSource(e, { gold: custody })).toThrow(/sealed path/);
    const link = join(dirname(custody), 'innocent');
    symlinkSync(custody, link);
    expect(() => loadSource(e, { gold: link })).toThrow(/sealed path/);
  });

  test('fixtures live where the helper says', () => expect(FX).toMatch(/test\/fixtures\/failure-causes$/));

  test('tarFiles reads GNU, ustar and pax archives, long paths included', () => {
    const long = `${'d'.repeat(60)}/${'e'.repeat(60)}/receipt.json`;
    const read = (f: LoadedFile) => Object.fromEntries([...tarFiles(f)].map(([p, b]) => [p, new TextDecoder().decode(b)]));
    expect(read(tarball('a.tar.gz', 'logs', { 'x/a.json': '1', 'x/b/c.json': '22' }))).toEqual({ 'x/a.json': '1', 'x/b/c.json': '22' });
    expect(read(tarball('p.tar.gz', 'logs', { [long]: 'r' }, 'ustar'))).toEqual({ [long]: 'r' });
    expect(read(tarball('g.tar.gz', 'logs', { [long]: 'r', 'x/a.json': '1' }, 'gnu'))).toEqual({ [long]: 'r', 'x/a.json': '1' });
    expect(read(tarball('x.tar.gz', 'logs', { [long]: 'r', 'x/a.json': '1' }, 'posix'))).toEqual({ [long]: 'r', 'x/a.json': '1' });
  });
});

describe('item support records', () => {
  test('an item is unsupported when both validators reject it or it cites no turn; one validator, an unchecked item, or a missing item or file is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-support-'));
    const validators = ['gemini:g', 'anthropic:h'];
    writeFileSync(join(dir, 's-support.json'), JSON.stringify({ schema: 'nightly-item-support/1', suite: 's', validators, items: {
      both: { checked: true, gates: ['support:anthropic:h', 'support:gemini:g'], cited: 2, source: 'x' }, one: { checked: true, gates: ['support:gemini:g'], cited: 2, source: 'x' },
      uncited: { checked: true, gates: ['uncited'], cited: 0, source: 'x' }, zero: { checked: true, gates: [], cited: 0, source: 'x' },
      abstention: { checked: false, reason: 'abstention cites no turn', source: 'x' } } }));
    const why = (item: string, suite = 's') => itemUnsupported(suite, item, dir)?.why ?? null;
    expect(['both', 'one', 'uncited', 'zero', 'abstention', 'missing'].map(i => why(i))).toEqual(['both_validators', null, 'uncited', 'uncited', null, null]);
    expect(why('both', 'other')).toBeNull();
    expect(itemUnsupported('s', 'both', dir)!.at).toMatch(/^repo:eval\/data\/nightly\/s-support\.json#[0-9a-f]{8} both$/);
    writeFileSync(join(dir, 'bad-support.json'), JSON.stringify({ schema: 'nightly-item-support/1', suite: 'other', validators, items: {} }));
    expect(() => itemUnsupported('bad', 'x', dir)).toThrow(/not a nightly-item-support\/1 file for bad$/);
  });

  test('the committed beam-1m-hard record covers every item of the suite and repeats GST-2339\'s published gates where they overlap', () => {
    const ids = (JSON.parse(readFileSync('eval/data/nightly/devset-v1.json', 'utf8')).suites as Array<{ id: string; items: Array<{ id: string }> }>).find(s => s.id === 'beam-1m-hard')!.items.map(i => i.id);
    const rec = JSON.parse(readFileSync('eval/data/nightly/beam-1m-hard-support.json', 'utf8'));
    const pubBytes = readFileSync(rec.sources.gst2339.file);
    expect(sha256(new Uint8Array(pubBytes))).toBe(rec.sources.gst2339.sha256);
    const pub = new Map((JSON.parse(pubBytes.toString('utf8')).items as Array<{ id: string; gates: string[]; cited: number }>).map(x => [x.id, x]));
    expect(Object.keys(rec.items).sort()).toEqual([...ids].sort());
    for (const [id, x] of Object.entries(rec.items as Record<string, { source: string; gates?: string[]; cited?: number }>)) {
      expect(x.source).toBe(pub.has(id) ? 'gst2339' : 'beam-nightly-check');
      if (pub.has(id)) expect([x.gates, x.cited]).toEqual([[...pub.get(id)!.gates].sort(), pub.get(id)!.cited]);
    }
    expect(itemUnsupported('beam-1m-hard', '1m-2:contradiction_resolution:0')?.why).toBe('both_validators');
  });
});
