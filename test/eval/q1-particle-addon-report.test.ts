/**
 * The particle-1 add-on's report (eval/runner/q1/particle-addon-report.ts) over invented published cells: per-reader
 * means, correct answers and list-price dollars, particle-1's paired differences, the seeded clustered bootstrap, the
 * pairing of re-read and file-agent cells, shard merging, the disclosure lines, the refusal to print a question id, the
 * set's preregistered exclusions, the per-reader outcome counts, and the refusals of a pairing that cannot stand.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerRecord, sha256, type AnswerRecord, type JudgmentRecord } from '../../eval/runner/memory-qa/records.ts';
import { clusteredPairedDelta } from '../../eval/runner/stats/paired.ts';
import { loadCells, PARTICLE, renderReport, RESAMPLES, SEED, seedNumber, unitReport, unitsOf, writeReport } from '../../eval/runner/q1/particle-addon-report.ts';
import { REREAD_RECEIPT_SCHEMA } from '../../eval/runner/q1/reread-cell.ts';

const tmp = mkdtempSync(join(tmpdir(), 'q1-particle-report-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const OPUS = 'anthropic:claude-opus-5-5', SOL = 'openai:gpt-6.1-sol', SONNET = 'anthropic:claude-sonnet-5-5';
const INSTRUMENT = { id: 'locomo', sha256: sha256('instrument'), judge: 'openai:gpt-judge' };
const QUESTIONS = Array.from({ length: 12 }, (_, i) => ({ id: `invented-q${String(i).padStart(2, '0')}`, conversation: `invented-c${Math.floor(i / 3)}` }));
const usage = { input: 1000, output: 100, cache_read: 0, cache_write: 0 };
const CONFIG = sha256('run-config');

/** Scores per reader by question index: a number is the canonical score; a string is the answer's failure outcome. */
type Plan = Record<string, Array<number | 'retrieval_error' | 'reader_error' | 'turn_cap'>>;
function publish(root: string, cellId: string, system: string, plan: Plan, receipt: Record<string, unknown> = {}, only?: (i: number) => boolean, questions = QUESTIONS) {
  const dir = join(root, 'cells', cellId);
  mkdirSync(dir, { recursive: true });
  const answers: AnswerRecord[] = [], judgments: JudgmentRecord[] = [];
  for (const [reader, xs] of Object.entries(plan)) xs.forEach((x, i) => {
    if (only && !only(i)) return;
    const q = questions[i];
    const outcome = typeof x === 'number' ? 'scored' as const : x;
    const a = answerRecord({ cell_id: cellId, realization_id: 'r0', question_id: q.id, conversation: q.conversation, system, arm: 'component', reader, replicate: 0, effort: 'medium', context_sha256: sha256(`ctx-${i}`) },
      { text: `SECRET-ANSWER-${reader}-${i}`, outcome, usage, latency_ms: 10, provider_input_tokens: 1000 });
    answers.push(a);
    if (typeof x === 'number') judgments.push({ answer_id: a.answer_id, instrument_id: INSTRUMENT.id, instrument_sha256: INSTRUMENT.sha256, judge: INSTRUMENT.judge, judge_replicate: 0, temperature: 0, score: x, parse_ok: true, raw_sha256: sha256('raw'), outcome: 'scored' } as JudgmentRecord);
  });
  writeFileSync(join(dir, 'answers.ndjson'), answers.map(a => JSON.stringify(a) + '\n').join(''));
  writeFileSync(join(dir, 'judgments.ndjson'), judgments.map(j => JSON.stringify(j) + '\n').join(''));
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ cell_id: cellId, set: 'S3', block: 'T2-S3', run_status: 'complete', config_sha256: CONFIG, system: { kind: system }, instrument: INSTRUMENT, ...receipt }));
}

const ones = (n: number) => Array<number>(n).fill(1);
const FRONTIER: Plan = { [OPUS]: [0, ...ones(11)], [SOL]: [0, 0, ...ones(10)], [SONNET]: [0, 0, 0, ...ones(9)] };
const PARTICLE_PLAN: Plan = { [PARTICLE]: [1, 0, 'retrieval_error', 'reader_error', 0, 1, 1, 0, 1, 1, 1, 0] };
const ARM = 's3.ext-graph-pipeline.recipe.component-b8000';
const REREAD = `${ARM}.reread-particle-particle-1`;
const VERIFY = { contexts_checked: 11, contexts_matched: 11, scheduled_questions: 12, questions_with_context: 11, questions_without_context: 1 };

// Shards: the frontier arm's answers split over two roots; the re-read in a third.
const shardA = join(tmp, 'shard-a'), shardB = join(tmp, 'shard-b'), reread = join(tmp, 'reread');
publish(shardA, ARM, 'ext-graph-pipeline', FRONTIER, {}, i => i < 6);
publish(shardB, ARM, 'ext-graph-pipeline', FRONTIER, {}, i => i >= 6);
publish(reread, REREAD, 'ext-graph-pipeline', PARTICLE_PLAN, { schema: REREAD_RECEIPT_SCHEMA, keyless: false, source: { arm_cell_id: ARM, config_sha256: CONFIG }, verify: VERIFY });
const roots = [shardA, shardB, reread];

/** A partial particle-1 re-read of questions 0-5 whose first judgment was lost. */
function unjudgedShard(name = 'unjudged'): string {
  const root = join(tmp, name);
  publish(root, REREAD, 'ext-graph-pipeline', PARTICLE_PLAN, { schema: REREAD_RECEIPT_SCHEMA, keyless: false, source: { arm_cell_id: ARM, config_sha256: CONFIG }, run_status: 'partial' }, i => i < 6);
  const file = join(root, 'cells', REREAD, 'judgments.ndjson');
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(1).map(l => l + '\n').join(''));
  return root;
}

describe('the particle-1 add-on report', () => {
  // Value: protects=the add-on's published numbers; fails_when=a mean, denominator, correct count, list-price dollar figure or paired difference is computed off the outcome rules, or the shards are not merged; why_new=particle-addon-report.ts is new; seam=invented cells; no_claim=any real result
  test('per reader: denominator, mean, correct answers and list-price dollars; particle-1 minus Opus and Sol paired by question; Opus and particle-1 first', () => {
    const units = unitsOf(loadCells(roots));
    expect(units.map(u => [u.frontier.id, u.particle.id, u.frontier.answers.length])).toEqual([[ARM, REREAD, 36]]);
    const r = unitReport(units[0]);
    expect(r.readers.map(x => x.reader)).toEqual([OPUS, PARTICLE, SOL, SONNET]);
    const opus = r.readers[0], p = r.readers[1];
    // particle-1: the retrieval_error scores 0, the reader_error leaves the denominator: 6 correct of 11.
    expect([p.answers, p.scored, p.correct, p.mean]).toEqual([12, 11, 6, Math.round(6 / 11 * 1e4) / 1e4]);
    expect([opus.answers, opus.scored, opus.correct, opus.mean]).toEqual([12, 12, 11, Math.round(11 / 12 * 1e4) / 1e4]);
    // List price: Opus $4 in and $20 out per million, particle-1 $0.25 and $1; every answer used 1,000 in and 100 out.
    expect([opus.reader_usd, opus.usd_per_correct]).toEqual([0.072, Math.round(0.072 / 11 * 1e4) / 1e4]);
    expect([p.reader_usd, p.usd_per_correct]).toEqual([0.0042, 0.0007]);
    // Paired over the 11 questions both have: particle-1 6/11, Opus 10/11 there (question 0 is Opus's miss and particle-1's hit).
    const vsOpus = r.particle_minus.find(d => d.minus === OPUS)!;
    expect([vsOpus.pairs, vsOpus.clusters, vsOpus.delta]).toEqual([11, 4, Math.round((6 - 10) / 11 * 1e4) / 1e4]);
    expect(vsOpus.ci95![0]).toBeLessThan(vsOpus.delta);
    expect(vsOpus.ci95![1]).toBeGreaterThanOrEqual(vsOpus.delta);
    expect(r.particle_minus.map(d => d.minus)).toEqual([OPUS, SOL]);
    expect(r.verify).toEqual(VERIFY);
    expect([p.not_scored, opus.not_scored, r.excluded, r.run_status]).toEqual([{ reader_error: 1, retrieval_error: 1 }, {}, 0, { frontier: 'complete', particle: 'complete' }]);
  });

  // Value: protects=the preregistered bootstrap (seed f6-p1, 10,000 resamples, conversation clusters) is the one run, and reruns reproduce it; fails_when=the seed, resample count or clustering drifts, or the interval is not deterministic; why_new=new; seam=none; no_claim=none
  test('the bootstrap is seeded f6-p1 with 10,000 resamples over conversations, and a rerun is byte-identical', () => {
    expect([SEED, RESAMPLES, seedNumber(SEED)]).toEqual(['f6-p1', 10_000, parseInt(sha256('f6-p1').slice(0, 8), 16)]);
    const u = unitsOf(loadCells(roots))[0];
    const r = unitReport(u);
    const opusValues = new Map(u.frontier.answers.filter(a => a.reader === OPUS).map(a => [a.question_id, u.frontier.judgments.find(j => j.answer_id === a.answer_id)!.score!]));
    const pairs = u.particle.answers.filter(a => a.outcome !== 'reader_error').map(a => ({ id: a.question_id, cluster: a.conversation, a: opusValues.get(a.question_id)!, b: a.outcome === 'scored' ? u.particle.judgments.find(j => j.answer_id === a.answer_id)!.score! : 0 }));
    const d = clusteredPairedDelta(pairs, { seed: seedNumber('f6-p1'), draws: 10_000 });
    expect(r.particle_minus[0].ci95).toEqual([Math.round(d.ci95![0] * 1e4) / 1e4, Math.round(d.ci95![1] * 1e4) / 1e4]);
    expect(d.n_clusters).toBe(4);
    const a = writeReport(roots, join(tmp, 'out-a')), b = writeReport(roots, join(tmp, 'out-b'));
    for (const f of ['report.md', 'report.json']) expect(readFileSync(join(tmp, 'out-a', f), 'utf8')).toBe(readFileSync(join(tmp, 'out-b', f), 'utf8'));
    expect(JSON.parse(readFileSync(a.files[1], 'utf8'))).toMatchObject({ seed: 'f6-p1', resamples: 10_000, clusters: 'conversation' });
    expect(b.units).toEqual(a.units);
  });

  // Value: protects=aggregates only; fails_when=a question id, a question or an answer reaches report.md or report.json; why_new=new; seam=a question id equal to a reader name; no_claim=none
  test('the report carries no question id, conversation or answer text, and refuses to write when a question id would appear', () => {
    const { files } = writeReport(roots, join(tmp, 'out-clean'));
    const text = files.map(f => readFileSync(f, 'utf8')).join('\n');
    for (const q of QUESTIONS) { expect(text).not.toContain(q.id); expect(text).not.toContain(q.conversation); }
    expect(text).not.toContain('SECRET-ANSWER');
    const leaky = join(tmp, 'leaky');
    publish(leaky, REREAD, 'ext-graph-pipeline', PARTICLE_PLAN, { schema: REREAD_RECEIPT_SCHEMA, keyless: false, source: { arm_cell_id: ARM, config_sha256: CONFIG } }, undefined, [{ id: 'claude-opus-5-5', conversation: 'invented-c0' }, ...QUESTIONS.slice(1)]);
    expect(() => writeReport([shardA, shardB, leaky], join(tmp, 'out-leaky'))).toThrow('the report would carry 1 question id(s); nothing was written');
    expect(existsSync(join(tmp, 'out-leaky'))).toBe(false);
  });

  // Value: protects=docs/disclosures.md (a report giving particle-1 results carries the lines up front) and the file-agent pairing; fails_when=the Particle line is missing or not under the title, the gbrain or OpenAI line is missing when their results are shown, or the file-agent add-on is not paired with the rerun; why_new=new; seam=none; no_claim=none
  test('the Particle line sits under the title, with the gbrain and OpenAI lines when their results are shown; the file-agent add-on pairs with the file-agent rerun', () => {
    const fa = join(tmp, 'file-agent');
    const S1 = { set: 'S1', block: 'F6-S1' };
    publish(fa, 's1.baseline-file-agent.baseline.whole-agent', 'baseline-file-agent', { [OPUS]: ones(12), [SOL]: ones(12) }, S1);
    publish(fa, 's1.baseline-file-agent.particle.whole-agent', 'baseline-file-agent', { [PARTICLE]: [...ones(6), ...Array(6).fill(0)] }, { ...S1, block: 'F6-P1' });
    const gb = join(tmp, 'gbrain');
    publish(gb, 's1.gbrain-defaults.f6-master.p', 'gbrain-defaults', { [OPUS]: ones(12) }, S1);
    publish(gb, 's1.gbrain-defaults.f6-master.p.reread-particle-particle-1', 'gbrain-defaults', { [PARTICLE]: ones(12) }, { ...S1, schema: REREAD_RECEIPT_SCHEMA, keyless: false, source: { arm_cell_id: 's1.gbrain-defaults.f6-master.p', config_sha256: CONFIG } });
    const units = unitsOf(loadCells([fa, gb])).map(u => unitReport(u));
    expect(units.map(u => [u.frontier_cell, u.particle_cell, u.kind])).toEqual([['s1.baseline-file-agent.baseline.whole-agent', 's1.baseline-file-agent.particle.whole-agent', 'file agent'],
      ['s1.gbrain-defaults.f6-master.p', 's1.gbrain-defaults.f6-master.p.reread-particle-particle-1', 're-read']]);
    const md = renderReport(units).split('\n');
    expect(md.slice(0, 7)).toEqual(['# particle-1 add-on: F6 cells read by particle-1', '', 'Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.', '',
      'gbrain is Garry Tan\'s own project.', '', 'Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.']);
    expect(md).toContain('| s1.baseline-file-agent.baseline.whole-agent | file agent | complete | 12 | 100.0% | 50.0% | -50.0 points (' + md.find(l => l.startsWith('| s1.baseline-file-agent'))!.split('points (')[1]);
    const noOpenAi = renderReport(unitsOf(loadCells([gb])).map(u => unitReport(u)));
    expect(noOpenAi).toContain('gbrain is Garry Tan\'s own project.');
    expect(noOpenAi).not.toContain('OpenAI began');
    expect(() => unitsOf(loadCells([reread]))).toThrow(`pairs with ${ARM}, which no --root publishes`);
  });

  // Value: protects=the published add-on numbers match the scoreboard's cohort and compare like with like; fails_when=an S1 exclusion enters a mean, a file-agent stop is not counted per reader, or a re-read pairs with an invalid frontier, another run configuration, Q1's file agent or different contexts; why_new=review of #347; seam=invented cells; no_claim=none
  test('S1 leaves out its preregistered exclusion, counts stops per reader, and refuses a pairing that cannot stand', () => {
    const S1Q = [{ id: '10m-1:abstention:0', conversation: 'invented-c0' }, ...QUESTIONS.slice(1)];
    const S1 = { set: 'S1', block: 'F6-S1' };
    const ex = join(tmp, 'excluded');
    publish(ex, 's1.baseline-file-agent.baseline.whole-agent', 'baseline-file-agent', { [OPUS]: [0, ...ones(11)] }, S1, undefined, S1Q);
    publish(ex, 's1.baseline-file-agent.particle.whole-agent', 'baseline-file-agent', { [PARTICLE]: [1, 'turn_cap', 'turn_cap', ...ones(9)] }, { ...S1, block: 'F6-P1' }, undefined, S1Q);
    const r = unitReport(unitsOf(loadCells([ex]))[0]);
    const opus = r.readers.find(x => x.reader === OPUS)!, p = r.readers.find(x => x.reader === PARTICLE)!;
    expect([r.excluded, opus.answers, opus.mean, p.answers, p.scored, p.correct, p.not_scored]).toEqual([1, 11, 1, 11, 11, 9, { turn_cap: 2 }]);
    expect(r.particle_minus.find(d => d.minus === OPUS)!.pairs).toBe(11);
    expect(renderReport([r])).toContain('| particle-1 | 11 | 11 | ');
    expect(renderReport([r])).toContain('turn_cap 2 |');

    const bad = (name: string, frontier: Record<string, unknown>, particle: Record<string, unknown>, contexts = false) => {
      const root = join(tmp, name);
      publish(root, ARM, 'ext-graph-pipeline', FRONTIER, frontier);
      publish(root, REREAD, 'ext-graph-pipeline', PARTICLE_PLAN, { schema: REREAD_RECEIPT_SCHEMA, keyless: false, source: { arm_cell_id: ARM, config_sha256: CONFIG }, ...particle });
      if (contexts) {
        const file = join(root, 'cells', REREAD, 'answers.ndjson');
        writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.stringify({ ...JSON.parse(l), context_sha256: sha256('other') })).join('\n') + '\n');
      }
      return () => unitsOf(loadCells([root])).map(u => unitReport(u));
    };
    expect(bad('invalid', { run_status: 'invalid' }, {})).toThrow(`${ARM} is published as invalid`);
    expect(bad('config', {}, { source: { arm_cell_id: ARM, config_sha256: sha256('other config') } })).toThrow('re-read a run configuration other than the one');
    expect(bad('set', { set: 'S9' }, {})).toThrow('names no known set');
    expect(bad('contexts', {}, {}, true)).toThrow('particle-1 and anthropic:claude-opus-5-5 read different contexts for one question');
    const q1 = join(tmp, 'q1-file-agent');
    publish(q1, 's1.baseline-file-agent.baseline.whole-agent', 'baseline-file-agent', { [OPUS]: ones(12) }, { set: 'S1', block: 'T1' });
    publish(q1, 's1.baseline-file-agent.particle.whole-agent', 'baseline-file-agent', { [PARTICLE]: ones(12) }, { ...S1, block: 'F6-P1' });
    expect(() => unitsOf(loadCells([q1]))).toThrow("pairs only with F6's file-agent rerun, and s1.baseline-file-agent.baseline.whole-agent here is from block T1");
    const shardX = join(tmp, 'shard-x');
    publish(shardX, ARM, 'ext-graph-pipeline', FRONTIER, { run_status: 'partial' }, i => i >= 6);
    expect(loadCells([shardA, shardX]).get(ARM)!.receipt.run_status).toBe('partial');
  });

  // Value: protects=a merged cell holds one run's answers (review finding particle-addon-report.ts:70, pinned); fails_when=shards of one cell id from different run configurations, source arms or source configurations merge under the first receipt; why_new=#347 compared only the instrument; seam=invented shards; no_claim=none
  test('review finding particle-addon-report.ts:70: shards of one cell from different run configurations or sources refuse to merge', () => {
    const other = join(tmp, 'other-config');
    publish(other, ARM, 'ext-graph-pipeline', FRONTIER, { config_sha256: sha256('another run-config') }, i => i >= 6);
    expect(() => loadCells([shardA, other])).toThrow('comes from different run configurations, sources or keyless markers in different roots');
    const halves = (name: string, source: Record<string, unknown>) => {
      const [a, b] = [join(tmp, `${name}-a`), join(tmp, `${name}-b`)];
      publish(a, REREAD, 'ext-graph-pipeline', PARTICLE_PLAN, { schema: REREAD_RECEIPT_SCHEMA, keyless: false, source: { arm_cell_id: ARM, config_sha256: CONFIG } }, i => i < 6);
      publish(b, REREAD, 'ext-graph-pipeline', PARTICLE_PLAN, { schema: REREAD_RECEIPT_SCHEMA, keyless: false, source }, i => i >= 6);
      return () => loadCells([a, b]);
    };
    expect(halves('source-config', { arm_cell_id: ARM, config_sha256: sha256('another source run-config') })).toThrow('comes from different run configurations, sources or keyless markers in different roots');
    expect(halves('source-arm', { arm_cell_id: `${ARM}-other`, config_sha256: CONFIG })).toThrow('comes from different run configurations, sources or keyless markers in different roots');
    expect(halves('same', { arm_cell_id: ARM, config_sha256: CONFIG })().get(REREAD)!.answers).toHaveLength(PARTICLE_PLAN[PARTICLE].length);
  });

  // Value: protects=not_scored accounts for every answer that leaves the denominator (review finding particle-addon-report.ts:122, pinned); fails_when=an answer whose canonical judgment is missing leaves the denominator without a not_scored count; why_new=#347 counted not_scored by answer outcome only; seam=a re-read shard with one judgment removed; no_claim=none
  test('review finding particle-addon-report.ts:122: an answer whose canonical judgment is missing counts as unjudged in not_scored', () => {
    const p = unitReport(unitsOf(loadCells([shardA, shardB, unjudgedShard()]))[0]).readers.find(x => x.reader === PARTICLE)!;
    // Questions 0-5: question 0 lost its judgment (unjudged), 2 is a retrieval_error (scores 0), 3 a reader_error.
    expect([p.answers, p.scored, p.not_scored]).toEqual([6, 4, { reader_error: 1, retrieval_error: 1, unjudged: 1 }]);
  });

  // Value: protects=the add-on's published particle-1 rows are particle-1's paid answers, and its first table compares like with like; fails_when=a keyless rehearsal, a re-read with no keyless marker or another reader's re-read reports as particle-1, or the first table's means come from different denominators or hide a partial run; why_new=review of #347 (follow-up); seam=invented published cells; no_claim=none
  test('refuses keyless, unmarked and non-particle re-reads; the first table pairs its means and shows the pair count and run status', () => {
    const reread2 = (name: string, receipt: Record<string, unknown>, plan: Plan = PARTICLE_PLAN) => {
      const root = join(tmp, name);
      publish(root, REREAD, 'ext-graph-pipeline', plan, { schema: REREAD_RECEIPT_SCHEMA, source: { arm_cell_id: ARM, config_sha256: CONFIG }, ...receipt });
      return () => unitsOf(loadCells([shardA, shardB, root]));
    };
    expect(reread2('keyless', { keyless: true })).toThrow('is a keyless rehearsal, so it holds no particle-1 results');
    expect(reread2('unmarked', {})).toThrow('is a re-read with no keyless marker');
    expect(reread2('opus-reread', { keyless: false }, { [OPUS]: ones(12) })).toThrow(`holds answers by ${OPUS}, and a particle-1 cell holds particle-1's alone`);
    const r = unitReport(unitsOf(loadCells([shardA, shardB, unjudgedShard('unjudged-table')]))[0]);
    const d = r.particle_minus.find(x => x.minus === OPUS)!;
    // Paired on questions 1, 2, 4 and 5: Opus 1, 1, 1, 1; particle-1 0, 0, 0, 1.
    expect([d.pairs, d.frontier_mean, d.particle_mean, d.delta]).toEqual([4, 1, 0.25, -0.75]);
    expect(renderReport([r])).toContain(`| ${ARM} | re-read | partial | 4 | 100.0% | 25.0% | -75.0 points (`);
    expect(renderReport([r])).toContain('unjudged 1 |');
  });
});
