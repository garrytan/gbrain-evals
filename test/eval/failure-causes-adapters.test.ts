import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ADAPTERS, classify, loadSource, validateManifest, SOURCES_SCHEMA } from '../../eval/runner/failure-causes/index.ts';
import { cat40Calls, cat40Fields, namesSlug } from '../../eval/runner/failure-causes/adapters/cat40.ts';
import { sha256, type LoadedFile } from '../../eval/runner/failure-causes/manifest.ts';
import { entry, failure, FX, loadFixture } from '../support/failure-causes-fixture.ts';

const byCase = (failures: ReturnType<typeof ADAPTERS.rs1>['failures']) => new Map(failures.map(f => [f.case_id, classify(f)]));
const mem = (path: string, role: string, rows: unknown[]): LoadedFile => {
  const bytes = new TextEncoder().encode(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
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
    ...cell('a', ['q1', 'q2', 'q3', 'q4', 'q5'].map(q => row(q)),
      [answer('gbrain-a', 'q1', 'reader_error'), answer('gbrain-a', 'q2', 'turn_cap'), answer('gbrain-a', 'q3', 'budget_not_run'), answer('gbrain-a', 'q4', 'ingest_degraded'), answer('gbrain-a', 'q5', 'retrieval_error')],
      [judge('gbrain-a-q4', 0)]),
    ...cell('b', [row('q1', { recall_any_at_10: 0, recall_all_at_10: 0 })], [answer('gbrain-b', 'q1', 'scored')], [judge('gbrain-b-q1', 0)]),
  ];
  const out = ADAPTERS.rs1(files, entry('rs1', 'rs1'));
  const labels = new Map(out.failures.map(f => [f.case_id.split('|').slice(0, 2).join('|'), classify(f)]));

  test('an unjudged answer is a failure: errors are harness_error, a turn cap is timeout_latency, only budget_not_run is skipped', () => {
    expect(out.counts).toMatchObject({ read: 6, mapped: 5, failed: 5, skipped: 1 });
    expect(out.counts.skipped_reasons).toEqual({ budget_not_run: 1 });
    expect(labels.get('gbrain-a|q1')).toMatchObject({ cause: 'harness_error', rule_id: 'harness.error' });
    expect(labels.get('gbrain-a|q5')).toMatchObject({ cause: 'harness_error', rule_id: 'harness.error' });
    expect(labels.get('gbrain-a|q2')).toMatchObject({ cause: 'timeout_latency', rule_id: 'budget.turn_cap' });
  });

  test('a failed ingest_degraded answer is judged and counts as operations', () => {
    expect(labels.get('gbrain-a|q4')).toMatchObject({ cause: 'operations', rule_id: 'operations.ingest_degraded' });
  });

  test('each directory is its own cell: an answer reads its own rows file', () => {
    expect(labels.get('gbrain-b|q1')).toMatchObject({ cause: 'retrieval_miss', rule_id: 'retrieval.no_gold_retrieved' });
    expect(() => ADAPTERS.rs1([...files, mem('a/rows-2.ndjson', 'rows', [row('q9')])], entry('rs1', 'rs1'))).toThrow(/a second rows file in a/);
  });
});

describe('cat40 adapter: calls, slugs and recovery', () => {
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
});
