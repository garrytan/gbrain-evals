import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregatePilotCases, writePilotCaseOutcome, type PilotCaseOutcome } from '../../eval/runner/longmemeval-m-pilot-outcomes.ts';

const folder = mkdtempSync(join(tmpdir(), 'lme-m-outcomes-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const questionsPath = join(folder, 'selected-questions.json');
const selectionPath = join(folder, 'selection.json');
const selection = JSON.parse(readFileSync(join(import.meta.dir, '../../eval/data/longmemeval-m-pilot-selection.json'), 'utf8'));
const questions = selection.selected_ids.map((id: string) => ({ question_id: id,
  question_type: Object.entries(selection.selected as Record<string, string[]>).find(([, ids]) => ids.includes(id))?.[0] === 'abstention'
    ? 'single-session-user' : Object.entries(selection.selected as Record<string, string[]>).find(([, ids]) => ids.includes(id))?.[0],
  answer_session_ids: ['gold'], haystack_sessions: [{}, {}] }));
const questionBytes = JSON.stringify(questions) + '\n';
writeFileSync(questionsPath, questionBytes);
selection.selected_dataset.sha256 = createHash('sha256').update(questionBytes).digest('hex');
writeFileSync(selectionPath, JSON.stringify(selection));

function outcome(id: string): PilotCaseOutcome {
  const abs = id.endsWith('_abs');
  const bucket = Object.entries(selection.selected as Record<string, string[]>).find(([, ids]) => ids.includes(id))?.[0];
  const constructionPath = join(folder, `${id}-construction-receipt.json`);
  const replayPath = join(folder, `${id}-replay-receipt.json`);
  const base = { arm: 'B', question_id: id, attempt_id: 'attempt-1',
    registration_sha256: createHash('sha256').update(readFileSync(selectionPath)).digest('hex'),
    source_manifest_sha256: '1'.repeat(64), expected_product_sha: 'c'.repeat(40), expected_package_sha256: 'd'.repeat(64) };
  const buildProfile = { ...base, stage: 'construction', allocation: { id: `${id}-build`, usd: 9 } };
  const build = { status: 'complete', transport: 'provider', profile: buildProfile,
    source_sha256: selection.selected_source_details[id].source_sha256,
    indexed_manifest_sha256: 'a'.repeat(64), index_snapshot_sha256: 'b'.repeat(64),
    guard: { policy_context: { profile: buildProfile }, limits: { max_usd: 9, max_requests: 1968 },
      chat_sealed: true, publishable: false, failed_or_unreported_requests: 0, reserved_usd: 0,
      requests_with_unknown_byok_status: 0, requests_with_unreported_byok_cost: 0 } };
  writeFileSync(constructionPath, JSON.stringify(build));
  const constructionSha = createHash('sha256').update(readFileSync(constructionPath)).digest('hex');
  const replayProfile = { ...base, stage: 'replay', allocation: { id: `${id}-replay`, usd: 1 },
    construction_receipt_sha256: constructionSha };
  const replay = { ...build, profile: replayProfile,
    construction_receipt_sha256: constructionSha,
    guard: { ...build.guard, policy_context: { profile: replayProfile },
      limits: { max_usd: 1, max_requests: 32 } } };
  writeFileSync(replayPath, JSON.stringify(replay));
  const replaySha = createHash('sha256').update(readFileSync(replayPath)).digest('hex');
  return { schema_version: 2, arm: 'B', mode: 'live', question_id: id,
    selected_dataset_sha256: selection.selected_dataset.sha256,
    source_sha256: selection.selected_source_details[id].source_sha256,
    indexed_manifest_sha256: 'a'.repeat(64), index_snapshot_sha256: 'b'.repeat(64),
    product_sha: 'c'.repeat(40), product_package_sha256: 'd'.repeat(64),
    construction_stage_receipt_path: constructionPath, replay_stage_receipt_path: replayPath,
    build_guard_receipt_sha256: constructionSha, replay_guard_receipt_sha256: replaySha,
    row: { adapter: 'gbrain-hybrid', question_id: id, question_type: abs ? 'single-session-user' : bucket!,
      retrieved: [], ground_truth: ['gold'], hit_at_k: false, ...(abs ? { is_abs: true, abs_noise: 0 } : { recall_all: 0, recall_any: 0, ndcg_any: 0 }),
      num_haystack: 2, latency_ms: 3.5, latency_source: 'live_search', top_k: 5, dataset: 'm-cleaned-pilot',
      indexed_evidence: { schema_version: 2, provenance: 'indexed-projection', normalization: 'nfc-lf-v1', returned_chunks: [],
        strict_raw_grounding: { status: 'unavailable', reasons: ['no-returned-evidence'] } } },
  };
}

describe('pilot per-case outcomes and strict aggregate', () => {
  const paths = selection.selected_ids.map((id: string, i: number) => {
    const path = join(folder, `case-${i}.json`);
    writePilotCaseOutcome(path, outcome(id));
    return path;
  });

  test('aggregates only all 28 live rows while retaining unavailable raw grounding', () => {
    const aggregate = aggregatePilotCases(selectionPath, questionsPath, paths);
    expect(aggregate.completion).toEqual({ outcomes: 28, answerable: 24, abstention: 4 });
    expect(aggregate.native_summary.total).toBe(24);
    expect(aggregate.native_summary.n_abs).toBe(4);
    expect(aggregate.native_summary.recall_all_at_k).toBe(0);
    expect(aggregate.case_receipts).toHaveLength(28);
  });

  test('rejects missing, duplicated, foreign-source and mixed-product cases', () => {
    expect(() => aggregatePilotCases(selectionPath, questionsPath, paths.slice(1))).toThrow();
    expect(() => aggregatePilotCases(selectionPath, questionsPath, [...paths.slice(1), paths[1]])).toThrow();
    const altered = JSON.parse(readFileSync(paths[0], 'utf8')) as PilotCaseOutcome;
    const path = join(folder, 'foreign.json');
    writeFileSync(path, JSON.stringify({ ...altered, source_sha256: '0'.repeat(64) }));
    expect(() => aggregatePilotCases(selectionPath, questionsPath, [path, ...paths.slice(1)])).toThrow();
    writeFileSync(path, JSON.stringify({ ...altered, product_package_sha256: '0'.repeat(64) }));
    expect(() => aggregatePilotCases(selectionPath, questionsPath, [path, ...paths.slice(1)])).toThrow();
  });

  test('rejects mock zero latency, missing stage receipts and infrastructure exclusions', () => {
    const base = JSON.parse(readFileSync(paths[0], 'utf8')) as PilotCaseOutcome;
    const path = join(folder, 'invalid.json');
    writeFileSync(path, JSON.stringify({ ...base, row: { ...base.row, latency_source: 'mock', latency_ms: 0 } }));
    expect(() => aggregatePilotCases(selectionPath, questionsPath, [path, ...paths.slice(1)])).toThrow();
    writeFileSync(path, JSON.stringify({ ...base, build_guard_receipt_sha256: undefined }));
    expect(() => aggregatePilotCases(selectionPath, questionsPath, [path, ...paths.slice(1)])).toThrow();
    writeFileSync(path, JSON.stringify({ ...base, row: { ...base.row, error: 'HTTP 429', error_origin: 'dependency' } }));
    expect(() => aggregatePilotCases(selectionPath, questionsPath, [path, ...paths.slice(1)])).toThrow();
  });

  test('verifies answer labels and scores against the frozen selected questions', () => {
    const base = JSON.parse(readFileSync(paths[0], 'utf8')) as PilotCaseOutcome;
    const path = join(folder, 'wrong-score.json');
    writeFileSync(path, JSON.stringify({ ...base, row: { ...base.row, recall_all: 1 } }));
    expect(() => aggregatePilotCases(selectionPath, questionsPath, [path, ...paths.slice(1)])).toThrow();
    writeFileSync(path, JSON.stringify({ ...base, row: { ...base.row, ground_truth: ['another'] } }));
    expect(() => aggregatePilotCases(selectionPath, questionsPath, [path, ...paths.slice(1)])).toThrow();
    writeFileSync(path, JSON.stringify({ ...base, row: { ...base.row, retrieved: ['fake-session'] } }));
    expect(() => aggregatePilotCases(selectionPath, questionsPath, [path, ...paths.slice(1)])).toThrow();
  });

  test('rejects tampered stage receipts and any mock-transport quality row', () => {
    const base = JSON.parse(readFileSync(paths[0], 'utf8')) as PilotCaseOutcome;
    const stagePath = base.replay_stage_receipt_path!;
    const original = readFileSync(stagePath);
    try {
      writeFileSync(stagePath, JSON.stringify({ ...JSON.parse(original.toString()), transport: 'test-mock' }));
      expect(() => aggregatePilotCases(selectionPath, questionsPath, paths)).toThrow('stage receipt');
    } finally { writeFileSync(stagePath, original); }
    expect(aggregatePilotCases(selectionPath, questionsPath, paths).completion.outcomes).toBe(28);
  });

  test('rejects C1 options tampering even when a receipt hashes the altered config', () => {
    const path = join(folder, 'c1-tampered-construction');
    const configPath = join(path, 'c1-home', '.gbrain', 'config.json');
    mkdirSync(join(path, 'c1-home', '.gbrain'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ chat_model: 'openrouter:anthropic/claude-sonnet-4.6',
      provider_chat_options: {} }));
    const receiptPath = join(path, 'stage-receipt.json');
    const base = JSON.parse(readFileSync(paths[0], 'utf8')) as PilotCaseOutcome;
    const receipt = JSON.parse(readFileSync(base.construction_stage_receipt_path!, 'utf8'));
    receipt.prepared_gateway_config_sha256 = createHash('sha256').update(readFileSync(configPath)).digest('hex');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const badOutcome = join(folder, 'c1-tampered-outcome.json');
    writeFileSync(badOutcome, JSON.stringify({ ...base, arm: 'C1', construction_stage_receipt_path: receiptPath,
      build_guard_receipt_sha256: createHash('sha256').update(readFileSync(receiptPath)).digest('hex') }));
    expect(() => aggregatePilotCases(selectionPath, questionsPath, [badOutcome, ...paths.slice(1)]))
      .toThrow('C1 prepared provider options or config receipt changed');
  });

  test('keeps an attempted retrieval SUT failure in the 24-case denominator', () => {
    const base = JSON.parse(readFileSync(paths[0], 'utf8')) as PilotCaseOutcome;
    const path = join(folder, 'sut-failure.json');
    writeFileSync(path, JSON.stringify({ ...base, row: { ...base.row, error: 'gbrain query failed', error_origin: 'sut' } }));
    const result = aggregatePilotCases(selectionPath, questionsPath, [path, ...paths.slice(1)]);
    expect(result.native_summary.total).toBe(24);
    expect(result.native_summary.n_errors_sut).toBe(1);
  });

  test('never overwrites a settled case outcome', () => {
    expect(() => writePilotCaseOutcome(paths[0], outcome(selection.selected_ids[0]))).toThrow();
  });
});
