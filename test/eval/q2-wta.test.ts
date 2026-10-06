import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptCheckpoint, answerKey, interruptionReport, judgeKey, openOrContinue, resumeCommand, withAttempts } from '../../eval/runner/q2/checkpoints.ts';
import { crossedBootstrap, g6Gates, type AnswerRow } from '../../eval/runner/q2/crossed-bootstrap.ts';
import { fitPilot, powerTable, shiftFor, simulate } from '../../eval/runner/q2/power-sim.ts';
import { loadCareerCorpus, validateQuestions } from '../../eval/runner/q2/q-set.ts';
import { inAudit, parseWtaVerdict, wtaJudgePrompt } from '../../eval/runner/q2/wta-judge.ts';
import { CAREER_DEV_SEEDS, generateCareerDevWorld } from '../../eval/generators/career-chronicle-dev-gen.ts';
import { adoptionRecall, immediateQuestions } from '../../eval/runner/write-then-answer.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'q2-wta-'));

describe('answer and judge checkpoints', () => {
  const u = { corpus: 'career', ingest: 1, model: 'gpt-6.1-sol', arm: 'B', question: 'q7' };
  test('keys carry corpus, ingest, model, arm and question; answers and judgments never share a key', () => {
    expect(answerKey(u)).toBe('answer|career|ingest1|gpt-6.1-sol|B|q7');
    expect(judgeKey(u, 'gpt-6.1-sol')).toBe('judge|gpt-6.1-sol|career|ingest1|gpt-6.1-sol|B|q7');
    const keys = new Set([answerKey(u), answerKey({ ...u, ingest: 2 }), answerKey({ ...u, arm: 'A' }), answerKey({ ...u, corpus: 'amara' }), answerKey({ ...u, model: 'claude-opus-5-5' })]);
    expect(keys.size).toBe(5);
  });
  test('retryable attempts are retried, terminal ones are kept and skipped, spend counts every attempt, a torn tail is ignored', () => {
    const path = join(scratch(), 'answers.jsonl');
    const c = new AttemptCheckpoint<{ answer: string }>(path);
    c.record('a', {}, { state: 'retryable', error: '503', usd: 0.1 });
    c.record('b', {}, { state: 'terminal', error: '400', usd: 0.05 });
    c.record('a', {}, { state: 'done', result: { answer: 'x' }, usd: 0.2 });
    appendFileSync(path, '{"key":"c","sta');
    const again = new AttemptCheckpoint<{ answer: string }>(path);
    expect(again.todo(['a', 'b', 'c'])).toEqual(['c']);
    expect(again.get('a')).toMatchObject({ state: 'done', attempts: 2 });
    expect(again.spendUsd()).toBeCloseTo(0.35);
    expect(again.counts(['a', 'b', 'c'])).toEqual({ done: 1, retryable: 0, terminal: 1, not_started: 1 });
  });
  test('withAttempts: a terminal HTTP error stops at once; transport failures end retryable', async () => {
    const noSleep = async () => {};
    expect(await withAttempts(async () => { throw new Error('judge provider error 401: key'); }, { maxAttempts: 3, sleep: noSleep })).toMatchObject({ state: 'terminal', attempts: 1 });
    expect(await withAttempts(async () => { throw new Error('fetch failed'); }, { maxAttempts: 3, sleep: noSleep })).toMatchObject({ state: 'retryable', attempts: 3 });
    await expect(withAttempts(async () => { throw Object.assign(new Error('over'), { name: 'BudgetExceededError' }); }, { maxAttempts: 3, sleep: noSleep })).rejects.toThrow('over');
  });
  test('one opening per work root: the same identity continues it, another identity is refused', () => {
    const w = scratch();
    const first = openOrContinue(w, 'q-set/career', { build: 'abc' });
    expect(first.continues).toBe(false);
    expect(openOrContinue(w, 'q-set/career', { build: 'abc' })).toMatchObject({ continues: true, opening_id: first.opening_id });
    expect(() => openOrContinue(w, 'q-set/career', { build: 'def' })).toThrow('forbids');
  });
  test('the interruption report names the resume command, remaining work, spend and the opening', () => {
    const r = interruptionReport({ command: resumeCommand('eval/runner/write-then-answer.ts', ['--arm-label', 'B', '--purpose', 'G6 answers']), remaining: { answers: 12, judgments: 30 }, spentUsd: 41.5, opening: { id: 'op-1', set: 'q/career' }, reason: 'budget exhausted' });
    expect(r).toContain("Resume with: bun eval/runner/write-then-answer.ts --arm-label B --purpose 'G6 answers'");
    expect(r).toContain('12 answers, 30 judgments');
    expect(r).toContain('$41.50');
    expect(r).toContain('continues the same opening (q/career, opening op-1)');
  });
});

describe('rubric q2-wta-judge-v1', () => {
  test('answerable and unanswerable items are scored separately; UNKNOWN is correct only on unanswerable items', () => {
    expect(wtaJudgePrompt({ question: 'Q?', answer: 'Acme', answerable: true }, 'UNKNOWN')).toContain('UNKNOWN or a refusal is incorrect');
    const un = wtaJudgePrompt({ question: 'Q?', answer: 'UNKNOWN', answerable: false }, 'Acme');
    expect(un).not.toContain('Reference answer');
    expect(un).toContain('false_answer');
    expect(parseWtaVerdict({ correct: false, false_answer: true })).toEqual({ correct: 0, false_answer: 1 });
    expect(parseWtaVerdict({ verdict: 'yes' })).toBeNull();
  });
  test('the audit picks about a tenth of answers, deterministically', () => {
    const keys = Array.from({ length: 4000 }, (_, i) => `answer|c|ingest0|m|B|q${i}`);
    const share = keys.filter(k => inAudit(k)).length / keys.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.12);
    expect(keys.filter(k => inAudit(k))).toEqual(keys.filter(k => inAudit(k)));
  });
});

/** Rows for a design of corpora x models x arms x ingests x pairs (2 questions per pair, one unanswerable pair in five). */
function design(o: { pairs: number; ingests: number; models: string[]; pA: number; pB: number; seed: number }): AnswerRow[] {
  let s = o.seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s / 2 ** 31; };
  const rows: AnswerRow[] = [];
  for (const corpus of ['amara', 'career']) for (const model of o.models) for (const arm of ['A', 'B'] as const) for (let ingest = 0; ingest < o.ingests; ingest++) for (let p = 0; p < o.pairs; p++) {
    const answerable = p % 5 !== 0;
    for (const type of ['relational', 'temporal'] as const) {
      const correct = rnd() < (arm === 'A' ? o.pA : o.pB) ? 1 : 0;
      rows.push({ corpus, model, arm, ingest, pair: `${corpus}-p${p}`, question: `${corpus}-p${p}-${type}`, type, answerable, correct, false_answer: answerable ? 0 : 1 - correct });
    }
  }
  return rows;
}

describe('crossed bootstrap and G6 gates', () => {
  const models = ['claude-sonnet-5-5', 'gpt-6.1-sol', 'claude-opus-5-5', 'claude-fable-5-1'];
  test('point estimate is the B - A difference of arm means; the interval is reproducible from the seed', () => {
    const rows = design({ pairs: 30, ingests: 3, models, pA: 0.6, pB: 0.7, seed: 3 });
    const meanOf = (arm: string) => { const xs = rows.filter(r => r.arm === arm); return xs.reduce((a, r) => a + (r.correct as number), 0) / xs.length; };
    const r = crossedBootstrap(rows, { seed: 1, draws: 500 });
    expect(r.point).toBeCloseTo(meanOf('B') - meanOf('A'), 10);
    expect(crossedBootstrap(rows, { seed: 1, draws: 500 }).ci95).toEqual(r.ci95);
    expect(r.ci95![0]).toBeLessThan(r.point!);
    expect(r.ci95![1]).toBeGreaterThan(r.point!);
  });
  test('ingest brains carry their answers together: a single bad brain widens the interval', () => {
    const rows = design({ pairs: 40, ingests: 3, models: ['m'], pA: 0.6, pB: 0.6, seed: 5 });
    const narrow = crossedBootstrap(rows, { seed: 2, draws: 800 }).ci95!;
    const bad = rows.map(r => (r.arm === 'B' && r.ingest === 0 ? { ...r, correct: 0 } : r));
    const wide = crossedBootstrap(bad, { seed: 2, draws: 800 }).ci95!;
    expect(wide[1] - wide[0]).toBeGreaterThan(2 * (narrow[1] - narrow[0]));
  });
  test('a clear win passes every gate; a null fails the pooled bar; missing judgments leave the gates not run', () => {
    const win = g6Gates(design({ pairs: 50, ingests: 3, models, pA: 0.55, pB: 0.75, seed: 9 }), { seed: 4, draws: 400 });
    expect(win.gates.map(g => g.outcome).every(o => o === 'pass')).toBe(true);
    expect(win.gates.map(g => g.gate)).toEqual(['G6.pooled', ...[...models].sort().map(m => `G6.model.${m}`), 'G6.type.relational', 'G6.type.temporal', 'G6.unanswerable_false_answers']);
    const nul = g6Gates(design({ pairs: 50, ingests: 3, models, pA: 0.6, pB: 0.6, seed: 9 }), { seed: 4, draws: 400 });
    expect(nul.gates[0]).toMatchObject({ outcome: 'fail' });
    expect(nul.gates[0].failed_threshold).toContain('>= +0.03');
    const rows = design({ pairs: 10, ingests: 3, models: ['m'], pA: 0.5, pB: 0.8, seed: 1 });
    rows[0] = { ...rows[0], correct: null };
    const part = g6Gates(rows, { seed: 4, draws: 200 });
    expect(part.gates.every(g => g.outcome === 'not_run')).toBe(true);
    expect(part.gates[0].denominators).toMatchObject({ planned: rows.length, scored: rows.length - 1, errors: 1 });
  });
});

describe('power simulation from pilot receipts', () => {
  test('fits the pilot, simulates the planned matrix and reports power and coverage', () => {
    const pilot = design({ pairs: 10, ingests: 2, models: ['m1', 'm2'], pA: 0.6, pB: 0.6, seed: 11 });
    const fit = fitPilot(pilot);
    expect(fit.models).toEqual(['m1', 'm2']);
    const sim = simulate(fit, { pairs: 25, ingests: 3, shift: 0, seed: 1 });
    expect(sim.length).toBe(2 * 2 * 2 * 3 * 25 * 2);
    expect(shiftFor(fit, 5)).toBeGreaterThan(0);
    const table = powerTable(fit, { pairs: 25, ingests: 3, sims: 6, effects: [0, 20], seed: 3, bootDraws: 200, sparseRate: 0.02 }) as Record<string, { power_all_gates: number }>;
    expect(table.effect_0_points.power_all_gates).toBeLessThan(table.effect_20_points.power_all_gates + 1e-9);
    expect(table).toHaveProperty('sparse_error_null');
  });
});

describe('Q set and career corpus', () => {
  test('questions validate corpus, type, answerability and one corpus per pair', () => {
    const q = { id: 'a', pair: 'p', corpus: 'career', type: 'temporal', answerable: false, question: 'Q', answer: 'UNKNOWN' };
    expect(validateQuestions([q])).toEqual([]);
    expect(validateQuestions([{ ...q, answerable: 'no' }])[0]).toContain('answerable');
    expect(validateQuestions([q, { ...q, id: 'b', corpus: 'amara' }])).toContain('pair p spans corpora; a pair belongs to one corpus stratum');
  });
  test('the custody career corpus is hash-checked and access-logged file by file', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'e1.md'), 'Subject: hello');
    const sha = createHash('sha256').update('Subject: hello').digest('hex');
    writeFileSync(join(dir, 'career-manifest.json'), JSON.stringify({ files: [{ path: 'docs/e1.md', sha256: sha }], owner: 'Jordan Example' }));
    const c = loadCareerCorpus(dir, { decisionId: 'q2', purpose: 'G6 ingest' });
    expect(c.docs).toEqual([{ path: 'docs/e1.md', content: 'Subject: hello' }]);
    expect(c.owner).toBe('Jordan Example');
    writeFileSync(join(dir, 'docs', 'e1.md'), 'changed');
    expect(() => loadCareerCorpus(dir, { decisionId: 'q2', purpose: 'x' })).toThrow('custody copy changed');
  });
  test('the development career corpus is seeded, dev-only, and has paired, partly unanswerable questions', () => {
    for (const seed of CAREER_DEV_SEEDS) {
      const w = generateCareerDevWorld(seed);
      expect(generateCareerDevWorld(seed).fingerprint).toBe(w.fingerprint);
      expect(validateQuestions(w.questions)).toEqual([]);
      expect(w.questions.filter(q => !q.answerable).length).toBeGreaterThan(2);
    }
    expect(CAREER_DEV_SEEDS.some(seed => generateCareerDevWorld(seed).people.some(p => p.stints.some(s => s.part_time)))).toBe(true);
    expect(() => generateCareerDevWorld(7)).toThrow('dev seeds');
  });
  test('the immediate cell takes whole pairs, about a quarter', () => {
    const qs = Array.from({ length: 400 }, (_, i) => ({ id: `q${i}`, pair: `p${Math.floor(i / 2)}`, corpus: 'career' as const, type: (i % 2 ? 'temporal' : 'relational') as 'temporal' | 'relational', answerable: true, question: '', answer: '' }));
    const imm = immediateQuestions(qs);
    expect(imm.length / qs.length).toBeGreaterThan(0.15);
    expect(imm.length / qs.length).toBeLessThan(0.35);
    for (const q of imm) expect(imm.filter(x => x.pair === q.pair)).toHaveLength(2);
  });
});

describe('adoption recall', () => {
  test('of lines both judges say were meant as relation lines, the share minted; misses by reason code', () => {
    const l = (id: string, minted: 'relation' | null, reasons: string[] = [], model = 'm') => ({ id, corpus: 'career', model, arm: 'B', ingest: 0, slug: 's', line: 1, text: '', context: '', has_link: true, minted, reasons });
    const lines = [l('a', 'relation'), l('b', null, ['type_punctuation']), l('c', null), l('d', null), l('e', 'relation', [], 'n')];
    const out = adoptionRecall(lines, id => (id === 'd' ? 'no' : 'yes')) as { meant_as_relation_lines: number; minted: number; adoption_recall: number; misses_by_reason: Record<string, number>; per_model: Record<string, { adoption_recall: number }> };
    expect(out).toMatchObject({ meant_as_relation_lines: 4, minted: 2, adoption_recall: 0.5, misses_by_reason: { type_punctuation: 1, no_diagnostic: 1 } });
    expect(out.per_model.n.adoption_recall).toBe(1);
  });
});
