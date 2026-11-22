/** Keyless fixture coverage for the S1 custody pairing CLI; no benchmark rows or provider calls. */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { compare, primaryOutcome, wholeOutcome } from '../../eval/runner/bn10/pairing.ts';
import { answerId, sha256 } from '../../eval/runner/memory-qa/records.ts';
import { OPUS, PARTICLE, SOL, generateBN10Cells } from '../../eval/runner/q1/cells/bn10.ts';
import { ALL_SETS, frontierJudgeOf, PER_READER_JUDGE_SETTINGS, policyKey } from '../../eval/runner/q1/cells/definitions.ts';
import { F6_FILE_AGENT_CONFIG_SHA256 } from '../../eval/runner/q1/particle-addon-report.ts';
import { rereadCellId, REREAD_RECEIPT_SCHEMA } from '../../eval/runner/q1/reread-cell.ts';
import { CAMPAIGN_SCHEMA } from '../../eval/runner/scoreboard.ts';

const CLI = 'eval/runner/bn10/pairing.ts';
const def = generateBN10Cells()[0]!;
const bridgeJudge = 'openai:gpt-4.1-mini';
const instrument = { id: 'fixture-beam-graded', sha256: '1'.repeat(64), judge: bridgeJudge };
const f6Id = 's1.gbrain-defaults.f6-master', q1Id = 's1.gbrain-defaults.shipped-defaults';
const fileId = 's1.baseline-file-agent.baseline.whole-agent';
const exclusion = ALL_SETS.S1.exclusions[0]!;
const scheduled = Array.from({ length: 200 }, (_, i) => {
  const conversation = i < 20 ? exclusion.question_id.split(':')[0]! : `fixture-private-conversation-${Math.floor(i / 20)}`;
  return { question_id: i === 0 ? exclusion.question_id : `${conversation}:knowledge_update:${i}`, conversation };
});
const config = (id: string) => `fake-config-${id}`;
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const nd = (xs: readonly unknown[]) => xs.map(v => JSON.stringify(v) + '\n').join('');
const write = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v));
const launch = (args: string[], log = '') => Bun.spawnSync([process.execPath, '--no-env-file', CLI, ...args], {
  env: { ...process.env, GBRAIN_EVALS_CUSTODY_LOG: log, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '', VOYAGE_API_KEY: '',
    OPENAI_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', VOYAGE_BASE_URL: 'http://127.0.0.1:9' },
});

test('custody CLI freezes the four SDDs, then reports both views, both gates, and separate private costs', () => {
  const root = mkdtempSync(join(tmpdir(), 'bn10-pair-fixture-'));
  try {
    const [f6, q1, live, addOn, rereads] = ['f6', 'q1', 'live', 'old-reread', 'new-rereads'].map(n => join(root, n));
    const [out, costs, frozen, rejudged, log] = ['public.json', 'cost.json', 'freeze.json', 'rejudged.ndjson', 'custody.ndjson'].map(n => join(root, n));
    const frontiers: unknown[] = [];
    const receipt = (root: string, id: string, readers: string[], score: (i: number, reader: string) => [bridge: number, frontier: number],
      o: { rejudged?: boolean; source?: string; gaps?: boolean; gzip?: boolean; config?: string } = {}) => {
      const dir = join(root, 'cells', id);
      mkdirSync(dir, { recursive: true });
      write(join(dir, 'receipt.json'), { instrument, run_status: 'complete', set: 'S1', cell_id: id, config_sha256: o.config ?? config(id),
        ...(o.source ? { schema: REREAD_RECEIPT_SCHEMA, keyless: false, source: { arm_cell_id: o.source, config_sha256: config(o.source) } } : {}) });
      const judgments: unknown[] = [], answers: unknown[] = [];
      for (const r of readers) for (const [i, q] of scheduled.entries()) {
        const [b, f] = score(i, r);
        const key = answerId(id, q.question_id, r, 0);
        const outcome = o.gaps && r === OPUS && i === 21 ? 'retrieval_error' :
          o.gaps && r === OPUS && i === 22 ? 'reader_error' : 'scored';
        answers.push({ ...q, reader: r, cell_id: id, replicate: 0, answer_id: key, context_sha256: 'frozen-fixture-context', text: 'fixture answer never exported', outcome });
        if (outcome !== 'scored') continue;
        judgments.push({ answer_id: key, judge: bridgeJudge, judge_replicate: 0, instrument_id: instrument.id,
          instrument_sha256: instrument.sha256, score: b, parse_ok: true, outcome: 'scored' });
        if (o.gaps && r === OPUS && i === 23) continue;
        const j = frontierJudgeOf(r);
        (o.rejudged ? frontiers : judgments).push({ answer_id: key, judge: j, judge_replicate: 0, instrument_id: `${instrument.id}@${j}`,
          instrument_sha256: instrument.sha256, score: f, settings: PER_READER_JUDGE_SETTINGS, parse_ok: true, outcome: 'scored' });
      }
      if (o.gzip) writeFileSync(join(dir, 'answers.ndjson.gz'), gzipSync(nd(answers)));
      else writeFileSync(join(dir, 'answers.ndjson'), nd(answers));
      writeFileSync(join(dir, 'judgments.ndjson'), nd(judgments));
    };
    receipt(f6, f6Id + '.p', [OPUS], () => [0.60, 0.75], { rejudged: true, gzip: true });
    receipt(f6, f6Id + '.a', [OPUS], i => i < 100 ? [0.55, 0.65] : [0.50, 0.55], { rejudged: true });
    receipt(q1, q1Id + '.whole-default', [OPUS], i => i < 100 ? [0.50, 0.70] : [0.65, 0.65], { rejudged: true });
    receipt(q1, fileId, [OPUS], () => [0.68, 0.75], { rejudged: true });
    const set = { id: 'S1', scheduled, exclusions: [exclusion] };
    write(join(q1, 'campaign.json'), { schema: CAMPAIGN_SCHEMA, campaign_id: 'q1-scoreboard', sets: [set] });
    write(join(f6, 'campaign.json'), { schema: CAMPAIGN_SCHEMA, campaign_id: 'q1-scoreboard-f6-current-master', sets: [{ ...set,
      sensitivity: [{ id: 'f6-s1-gbrain-degraded-ingest', question_ids: scheduled.slice(160).map(q => q.question_id) }] }] });
    writeFileSync(rejudged, nd(frontiers));
    const inputs = ['--f6', f6, '--q1', q1, '--rejudged', rejudged];
    const first = launch(['freeze', ...inputs, '--out', frozen], log);
    expect(first.stderr.toString()).toBe('');
    expect(first.exitCode).toBe(0);
    expect(read(frozen).sdd_points).toMatchObject({
      primary: { frontier: expect.any(Number), bridge: expect.any(Number) }, whole_vs_file: { frontier: expect.any(Number), bridge: expect.any(Number) },
    });
    expect(read(frozen).sdd_points.primary.frontier).toBeCloseTo(4.6666, 2);
    expect(read(frozen)).not.toHaveProperty('primary');
    receipt(f6, f6Id + '.a0', [OPUS], () => [0.45, 0]);
    receipt(q1, q1Id + '.component-b8000', [OPUS], () => [0.55, 0]);
    receipt(f6, fileId, [OPUS], () => [0.70, 0.5], { config: F6_FILE_AGENT_CONFIG_SHA256 });
    receipt(addOn, rereadCellId(f6Id + '.p', PARTICLE), [PARTICLE], () => [0.45, 0], { source: f6Id + '.p' });
    for (const arm of def.arms) {
      const f = arm.id === 'whole' ? 0.90 : 0.50;
      receipt(live, arm.cell_id, [OPUS, SOL], () => [0.62, f], { gaps: arm.id === 'p' });
      receipt(rereads, rereadCellId(arm.cell_id, PARTICLE), [PARTICLE], () => [0.55, f], { source: arm.cell_id });
    }
    const run = join(live, 'runs', def.id);
    mkdirSync(run, { recursive: true });
    const pId = def.arms[0]!.cell_id;
    writeFileSync(join(run, 'meters.ndjson'), nd([
      { phase: 'ingest', key: 'fixture-ingest', usd: 2, unpriced: 0 },
      { phase: 'retrieval', key: `q:fixture:${policyKey(def.arms[0]!)}`, usd: 0.5, unpriced: 0 },
      { phase: 'reader', key: `read:${answerId(pId, scheduled[20]!.question_id, OPUS, 0).slice(0, 16)}`, usd: 1, unpriced: 0 },
      { phase: 'judge', key: 'fixture-judge', usd: 9, unpriced: 0 },
    ]));
    const report = launch(['report', ...inputs, '--frozen', frozen, '--root', live, '--reread', rereads, '--f6-reread', addOn,
      '--bridge-status', 'passed', '--measured', '2026-11-19', '--cost-out', costs, '--out', out], log);
    expect(report.stderr.toString()).toBe('');
    expect(report.exitCode).toBe(0);
    const result = read(out);
    expect(result.primary.frontier).toMatchObject({ scheduled: 199, scored: 197, dropped: 2, complete_for_claim: true,
      product_failures: { lhs: { retrieval_error: 1 } }, drops: { lhs: { reader_error: 1, judge_error: 1 } } });
    expect(result.primary.frontier.mean_points).toBeCloseTo(-25 - 50 / 197);
    expect(result.primary.frontier.question_ci95_points).toEqual(expect.any(Array));
    expect(result.primary.bridge.scored).toBe(198);
    expect(result.decision.primary.frontier.code).toBe('regression');
    expect(result.decision.views_disagree).toBe(true);
    expect(result.decision.whole_vs_file).toContain('Remove the file-agent comparison');
    expect(result.secondary.a0_vs_f6_a0.mean_points).toBeCloseTo(17);
    expect(result.secondary.a0_vs_q1_8000.mean_points).toBeCloseTo(7);
    expect(result.secondary.particle_p_vs_f6_particle_p.mean_points).toBeCloseTo(10);
    expect(result.secondary.whole_vs_q1_whole.frontier.mean_points).toBeGreaterThan(20);
    expect(result.secondary.whole_vs_f6_file_rerun.mean_points).toBeCloseTo(-8);
    expect(Object.keys(result.ability)).toHaveLength(10);
    expect(result.ability.knowledge_update.frontier.scored).toBe(197);
    expect(result.sensitivity_without_degraded_ingest.primary.frontier.scheduled).toBe(159);
    expect(result.first_table[0].reader).toBe(OPUS);
    expect(result.first_table[1].reader).toBe(PARTICLE);
    expect(result.first_table[0].complete_both_views).toBe(false);
    expect(result.reader_means.whole.all_three.frontier.mean_points).toBe(90);
    expect(result.fences.whole).toHaveProperty('mean_fence_tokens', null);
    expect(read(costs).first_table[0]).toMatchObject({ correct: 196, usd_per_correct: 1.5 / 196 });
    expect(read(costs).shared_build_usd_per_conversation).toBe(0.2);
    for (const path of [out, frozen, costs]) {
      const text = readFileSync(path, 'utf8');
      expect(text).not.toContain('fixture-private-');
      expect(text).not.toContain('fixture answer');
      expect(text).not.toContain(exclusion.question_id);
    }
    expect(readFileSync(out, 'utf8')).not.toMatch(/usd|spend|\$/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test('freeze refuses before reading inputs when the custody log is absent', () => {
  const r = launch(['freeze', '--f6', '/missing/f6', '--q1', '/missing/q1', '--rejudged', '/missing/grades', '--out', join(tmpdir(), 'bn10-forbidden.json')]);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain('CUSTODY_REQUIRED');
  expect(existsSync(join(tmpdir(), 'bn10-forbidden.json'))).toBe(false);
});

test('the completeness gate counts Q1-retained conversations, each drop reason, and worst/best bounds', () => {
  const questions = Array.from({ length: 100 }, (_, i) => ({ question_id: `fake-${i}`, conversation: i >= 96 ? `short-${i % 2}` : String(i % 8) }));
  const rhs = new Map(questions.map(q => [q.question_id, { value: 50 }]));
  const lhs = new Map(questions.slice(0, 96).map(q => [q.question_id, { value: 70 }]));
  const incomplete = compare(questions, lhs, rhs);
  expect(incomplete).toMatchObject({ coverage: 0.96, conversations_retained: 8, complete_for_claim: false, drops: { lhs: { missing_row: 4 } },
    worst_case_points: 15.2, best_case_points: 23.2 });
  expect(primaryOutcome(incomplete, 5).code).toBe('incomplete');
});

test('the SDD edge is inclusive, with a separate outcome for measured drops below the SDD', () => {
  const observ = { complete_for_claim: true, mean_points: -5, ci95_points: [-7, -2] as [number, number] };
  expect(primaryOutcome(observ, 5).code).toBe('regression');
  expect(primaryOutcome(observ, 5.1).code).toBe('measured_drop_below_sdd');
  expect(primaryOutcome({ ...observ, ci95_points: [-7, 0] }, 5.1).code).toBe('no_regression_claim');
  expect(wholeOutcome(observ, 5)).toContain('Keep the file-agent comparison');
  expect(wholeOutcome({ ...observ, ci95_points: [-7, 0] }, 5)).toContain('5 points');
});

test('freeze pairs Q1 answers whose ids F6 reused for another text under their root-qualified ids, as the re-judge wrote them', () => {
  const root = mkdtempSync(join(tmpdir(), 'bn10-pair-qualified-'));
  try {
    const [f6, q1] = ['f6', 'q1'].map(n => join(root, n));
    const [frozen, log] = ['freeze.json', 'custody.ndjson'].map(n => join(root, n));
    const cellAt = (base: string, id: string, text: string, i0: number, rejudged: unknown[], qualify: (key: string) => string) => {
      const dir = join(base, 'cells', id);
      mkdirSync(dir, { recursive: true });
      write(join(dir, 'receipt.json'), { instrument, run_status: 'complete', set: 'S1', cell_id: id, config_sha256: config(id) });
      const answers: unknown[] = [], judgments: unknown[] = [];
      for (const [i, q] of scheduled.entries()) {
        const key = answerId(id, q.question_id, OPUS, 0);
        answers.push({ ...q, reader: OPUS, cell_id: id, replicate: 0, answer_id: key, context_sha256: 'c', text, outcome: 'scored' });
        judgments.push({ answer_id: key, judge: bridgeJudge, judge_replicate: 0, instrument_id: instrument.id, instrument_sha256: instrument.sha256, score: (i + i0) % 3 ? 1 : 0, parse_ok: true, outcome: 'scored' });
        const j = frontierJudgeOf(OPUS);
        rejudged.push({ answer_id: qualify(key), judge: j, judge_replicate: 0, instrument_id: `${instrument.id}@${j}`, instrument_sha256: instrument.sha256,
          score: (i + i0) % 4 ? 1 : 0, settings: PER_READER_JUDGE_SETTINGS, parse_ok: true, outcome: 'scored' });
      }
      writeFileSync(join(dir, 'answers.ndjson'), nd(answers));
      writeFileSync(join(dir, 'judgments.ndjson'), nd(judgments));
    };
    const set = { id: 'S1', scheduled, exclusions: [exclusion] };
    for (const d of [f6, q1]) mkdirSync(d, { recursive: true });
    write(join(q1, 'campaign.json'), { schema: CAMPAIGN_SCHEMA, campaign_id: 'q1-scoreboard', sets: [set] });
    write(join(f6, 'campaign.json'), { schema: CAMPAIGN_SCHEMA, campaign_id: 'q1-scoreboard-f6-current-master', sets: [set] });
    const freezeWith = (qualifyQ1File: (key: string) => string) => {
      const rejudged: unknown[] = [];
      cellAt(f6, f6Id + '.p', 'p', 0, rejudged, k => k);
      cellAt(f6, f6Id + '.a', 'a', 1, rejudged, k => k);
      cellAt(q1, q1Id + '.whole-default', 'whole', 2, rejudged, k => k);
      cellAt(q1, fileId, 'q1 file agent', 0, rejudged, qualifyQ1File);
      cellAt(f6, fileId, 'f6 file agent rerun', 1, [], k => k);
      writeFileSync(join(root, 'rejudged.ndjson'), nd(rejudged));
      return launch(['freeze', '--f6', f6, '--q1', q1, '--rejudged', join(root, 'rejudged.ndjson'), '--out', frozen], log);
    };
    const raw = freezeWith(k => k);
    expect(raw.exitCode).not.toBe(0);
    expect(raw.stderr.toString()).toContain('outside the four pinned Opus sets');
    const qualified = freezeWith(k => sha256(`q1|${k}`));
    expect(qualified.stderr.toString()).toBe('');
    expect(qualified.exitCode).toBe(0);
    expect(read(frozen).sdd_points.whole_vs_file).toMatchObject({ frontier: expect.any(Number), bridge: expect.any(Number) });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

