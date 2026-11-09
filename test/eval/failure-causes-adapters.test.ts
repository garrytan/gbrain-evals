import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ADAPTERS, classify, loadSource, validateManifest, SOURCES_SCHEMA } from '../../eval/runner/failure-causes/index.ts';
import { sha256 } from '../../eval/runner/failure-causes/manifest.ts';
import { entry, FX, loadFixture } from '../support/failure-causes-fixture.ts';

const byCase = (failures: ReturnType<typeof ADAPTERS.rs1>['failures']) => new Map(failures.map(f => [f.case_id, classify(f)]));

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
