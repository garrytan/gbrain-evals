/**
 * RS1's judge check (eval/runner/rs1/judge-check.ts), keyless: the gold screen and the scripted corruptions, the seeded
 * pool, the agreement statistics against hand-computed cases, the agreement filter and class splits, the gates and the
 * stop rule (exit 3), truncation counted as a judge error, the pinned settings and views each judge is graded with,
 * resume, cache hits, and published files that hold no answer text.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import type { ChatLike, ChatOptions, ChatResultV2 } from '../../eval/runner/memory-qa/qa-v2.ts';
import {
  ABSTAIN_TEXT, analyzeCheck, ASTRA, BRIDGE, buildPool, cohenKappa, corrupt, covers, gradePool, INVENTED_TEXT, OPUS_JUDGE, screen, weightedKappa, wilson, WRONG_VALUE,
  type Candidate, type Grade, type Grades, type RealAnswer,
} from '../../eval/runner/rs1/judge-check.ts';

const root = mkdtempSync(join(tmpdir(), 'rs1-judge-check-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = () => { const d = join(root, String(++n)); mkdirSync(d, { recursive: true }); return d; };

const question = (id: string, over: Partial<MemoryQuestion> = {}) => ({
  id, conversation: 'c1', question: 'Where did Maria move, and what does she do?', category: 'information_extraction', gold: [], abstention: false,
  answer: 'Maria moved to Lisbon in 2021, and she works as a nurse at the city hospital.',
  rubric: ['LLM response should state: Maria moved to Lisbon in 2021', 'LLM response should state: she works as a nurse'], ...over,
}) as unknown as MemoryQuestion;

describe('the gold screen and the scripted corruptions', () => {
  test('a gold answer passes the screen only when it states every rubric item, in a category built from gold', () => {
    expect(screen(question('q1'))).toBeNull();
    expect(screen(question('q2', { answer: 'Maria moved to Lisbon in 2021.' }))).toBe('gold does not state rubric item 1');
    expect(screen(question('q3', { category: 'event_ordering' }))).toBe('category event_ordering is not built from gold');
    expect(screen(question('q4', { rubric: [] }))).toBe('no rubric or no gold answer');
  });

  test('each edit removes its target item and keeps every other item; an edit that cannot do that, or leaves too little, is refused', () => {
    const q = question('q1');
    const donors = [question('d1', { answer: 'Your sister said her friend Rosa visits every summer, and the repairs cost $1,200.', rubric: ['LLM response should state: Rosa visits every summer', 'LLM response should state: $1,200'] })];
    const number = corrupt(q, q.answer!, 0, 'number')!;
    expect(number).toBe('Maria moved to Lisbon in 2829, and she works as a nurse at the city hospital.');
    const entity = corrupt(q, q.answer!, 0, 'entity', donors)!;
    expect(entity).toBe('Maria moved to Rosa in 2021, and she works as a nurse at the city hospital.');
    expect(corrupt(q, q.answer!, 0, 'entity')).toBeNull();
    const clock = question('q11', { answer: 'The train leaves at 11 PM on May 30, from the north platform.', rubric: ['LLM response should state: 11 PM', 'LLM response should state: May 30'] });
    expect(corrupt(clock, clock.answer!, 0, 'number')).toBe('The train leaves at 1 PM on May 30, from the north platform.');
    expect(corrupt(clock, clock.answer!, 1, 'number')).toBe('The train leaves at 11 PM on May 25, from the north platform.');
    const drop = corrupt(q, q.answer!, 1, 'drop')!;
    expect(drop).toBe('Maria moved to Lisbon in 2021, and at the city hospital.');
    const paid = question('q8', { answer: 'You paid $500 for the repairs, and the plumber came on Tuesday.', rubric: ['LLM response should state: $500', 'LLM response should state: the plumber came on Tuesday'] });
    const contradiction = corrupt(paid, paid.answer!, 0, 'contradiction', donors)!;
    expect(contradiction).toBe('You paid $1,200 for the repairs, and the plumber came on Tuesday.');
    const date = corrupt(paid, paid.answer!, 1, 'date')!;
    expect(date).toBe('You paid $500 for the repairs, and the plumber came on Thursday.');
    const lease = question('q9', { answer: 'The lease was signed in March, and the rent is due on the first of each month.', rubric: ['LLM response should state: the rent is due on the first of each month', 'LLM response should state: The lease was signed in March'] });
    const negation = corrupt(lease, lease.answer!, 0, 'negation')!;
    expect(negation).toBe('The lease was signed in March, and the rent is not due on the first of each month.');
    expect(corrupt(lease, lease.answer!, 1, 'date')).toBe('The lease was signed in June, and the rent is due on the first of each month.');
    for (const [qq, text, target] of [[q, number, 0], [q, entity, 0], [q, drop, 1], [paid, contradiction, 0], [paid, date, 1], [lease, negation, 0]] as const) {
      expect(covers(text, qq.rubric![target])).toBe(false);
      expect(covers(text, qq.rubric![1 - target])).toBe(true);
    }
    expect(corrupt(q, q.answer!, 1, 'number')).toBeNull();
    expect(corrupt(q, q.answer!, 1, 'contradiction', donors)).toBeNull();
    const place = question('q10', { answer: 'Four cities: Hanoi, Luang Prabang, Siem Reap, and Bangkok.', rubric: ['LLM response should state: Luang Prabang'] });
    expect(corrupt(place, place.answer!, 0, 'entity', donors)).toBeNull();
    const short = question('q5', { answer: '97% success rate', rubric: ['LLM response should state: 97% success rate'] });
    expect(corrupt(short, short.answer!, 0, 'drop')).toBeNull();
    const dated = question('q6', { answer: 'The tour starts at 11 AM on April 13 with the group.', rubric: ['LLM response should state: 11 AM on April 13'] });
    expect(corrupt(dated, dated.answer!, 0, 'entity')).toBeNull();
    expect(corrupt(q, q.answer!, 0, 'abstain')).toBe(ABSTAIN_TEXT);
    expect(corrupt(q, q.answer!, 0, 'invented')).toBeNull();
    const abst = question('q7', { category: 'abstention', abstention: true, answer: 'Based on the provided chat, there is no information about the trip.', rubric: ['Based on the provided chat, there is no information about the trip'] });
    expect(corrupt(abst, abst.answer!, 0, 'invented')).toBe(INVENTED_TEXT);
    expect(corrupt(abst, abst.answer!, 0, 'abstain')).toBeNull();
    expect(corrupt(abst, abst.answer!, 0, 'drop')).toBeNull();
  });
});

describe('the seeded pool', () => {
  const questions = [
    ...Array.from({ length: 12 }, (_, i) => question('g' + i, { answer: 'Maria moved to Lisbon in ' + (2001 + i) + ', and she works as a nurse at the city hospital.', rubric: ['LLM response should state: Maria moved to Lisbon in ' + (2001 + i), 'LLM response should state: she works as a nurse'] })),
    question('bad', { answer: 'Maria moved somewhere.' }),
    question('order', { category: 'event_ordering' }),
    question('abst', { category: 'abstention', abstention: true, answer: 'Based on the provided chat, there is no information about the trip.', rubric: ['Based on the provided chat, there is no information about the trip'] }),
  ];
  const real: RealAnswer[] = ['ext-memory-bank', 'gbrain-defaults'].flatMap(row => ['anthropic:claude-opus-5-5', 'particle:particle-1'].flatMap(reader =>
    [0, 0.5, 1].flatMap(b => [0, 1].map(k => ({ answer_id: row + reader + b + k + '0123456789abcdef', question_id: 'g' + k, conversation: 'c1', row, reader, text: 'an answer ' + k, bridge: b })))));

  test('real answers are drawn round-robin across row, reader and bridge-outcome strata; gold and corruptions carry construction labels', () => {
    const { pool, exclusions } = buildPool(questions, real, 7, { real: 12, gold: 4, corrupt: 9 });
    const reals = pool.filter(c => c.class === 'real');
    expect(reals).toHaveLength(12);
    expect(new Set(reals.map(c => c.stratum)).size).toBe(12);
    expect(reals.every(c => c.labels.every(l => l === null))).toBe(true);
    const gold = pool.filter(c => c.class === 'gold');
    expect(gold).toHaveLength(4);
    expect(gold.every(c => c.labels.every(l => l === true))).toBe(true);
    const bad = pool.filter(c => c.class === 'corrupt');
    expect(bad).toHaveLength(9);
    for (const c of bad) {
      const all = c.kind === 'abstain' || c.kind === 'invented';
      expect(c.labels).toEqual(c.labels.map((_, i) => !(all || i === c.target)));
    }
    const answered = bad.filter(c => c.kind !== 'invented');
    expect(bad.filter(c => c.kind === 'abstain').length).toBeLessThanOrEqual(Math.ceil(answered.length / 10));
    expect(answered.filter(c => WRONG_VALUE.includes(c.kind!)).length).toBeGreaterThanOrEqual(answered.length / 2);
    expect(exclusions).toEqual([{ question_id: 'bad', reason: 'gold does not state rubric item 0' }, { question_id: 'order', reason: 'category event_ordering is not built from gold' }]);
  });

  test('the same seed builds the same pool, and another seed a different one', () => {
    const ids = (seed: number) => buildPool(questions, real, seed, { real: 12, gold: 4, corrupt: 9 }).pool.map(c => c.id + c.text_sha256);
    expect(ids(7)).toEqual(ids(7));
    expect(ids(8)).not.toEqual(ids(7));
  });
});

describe('agreement statistics, hand-computed', () => {
  test('Cohen kappa on a 4/2/1/3 table is 0.4 with its large-sample interval; no variation gives null', () => {
    const a = [true, true, true, true, true, true, false, false, false, false];
    const b = [true, true, true, true, false, false, true, false, false, false];
    const k = cohenKappa(a, b);
    expect(k.po).toBeCloseTo(0.7, 10);
    expect(k.kappa).toBeCloseTo(0.4, 10);
    expect(k.ci95![0]).toBeCloseTo(-0.168052, 5);
    expect(k.ci95![1]).toBeCloseTo(0.968052, 5);
    expect(cohenKappa([true, true], [true, true]).kappa).toBeNull();
    expect(cohenKappa([], []).kappa).toBeNull();
  });

  test('linearly weighted kappa on the 0, 0.5 and 1 scale', () => {
    expect(weightedKappa([0, 0.5, 1, 1], [0, 1, 1, 0.5])).toBeCloseTo(0.428571, 5);
    expect(weightedKappa([0, 1], [0, 1])).toBeCloseTo(1, 10);
  });

  test('Wilson interval for 8 of 10 and for none', () => {
    const w = wilson(8, 10)!;
    expect(w[0]).toBeCloseTo(0.490164, 5);
    expect(w[1]).toBeCloseTo(0.943316, 5);
    expect(wilson(0, 0)).toBeNull();
  });
});

const cand = (cls: Candidate['class'], i: number, label: boolean | null): Candidate => ({ id: cls + ':' + i, class: cls, question_id: 'q' + i, conversation: 'c', category: 'information_extraction', text: 't' + i, text_sha256: 'h' + i, labels: [label] });
const g = (score: number | null, extra: Partial<Grade> = {}): Grade => ({ scores: score === null ? null : [score], truncated: false, cache_hits: 0, calls: 1, versions: ['v1'], ...extra });
/** 20 gold, 20 corrupted and 20 real one-item candidates; real i passes for Astra when i is even. */
function setup(opusReal: (i: number) => number = i => (i % 2 ? 0 : 1), bridge: (c: Candidate, i: number) => number = c => (c.labels[0] === false ? 0 : 1)) {
  const pool = [...Array.from({ length: 20 }, (_, i) => cand('gold', i, true)), ...Array.from({ length: 20 }, (_, i) => cand('corrupt', i, false)), ...Array.from({ length: 20 }, (_, i) => cand('real', i, null))];
  const grades: Grades = { [ASTRA]: {}, [OPUS_JUDGE]: {}, [BRIDGE]: {} };
  pool.forEach((c, k) => {
    const i = k % 20;
    const truth = c.class === 'real' ? (i % 2 ? 0 : 1) : c.labels[0] ? 1 : 0;
    grades[ASTRA][c.id] = g(truth);
    grades[OPUS_JUDGE][c.id] = g(c.class === 'real' ? opusReal(i) : truth);
    grades[BRIDGE][c.id] = g(bridge(c, i));
  });
  return { pool, grades };
}

describe('the analysis, the gates and the stop rule', () => {
  test('two judges that agree with each other and the construction labels pass every gate; the bridge is scored descriptively against the same truth', () => {
    const { pool, grades } = setup(undefined, (c, i) => (c.class === 'gold' ? (i < 2 ? 0 : 1) : c.class === 'corrupt' ? (i < 4 ? 1 : 0) : i % 2 ? 0 : 1));
    const r = analyzeCheck(pool, grades);
    expect(r.inter_judge.kappa).toBe(1);
    expect(r.labelled_set).toEqual({ items: 60, by_class: { real: 20, gold: 20, corrupt: 20 }, pass: 30, fail: 30 });
    expect(r.stop).toBe(false);
    expect(r.shortfalls).toEqual([]);
    const bridge = r.per_judge.find(j => j.judge === BRIDGE)!;
    expect(bridge.role).toBe('descriptive');
    expect(bridge.by_class.corrupt.catch_rate).toBe(0.8);
    expect(bridge.by_class.corrupt.catch_ci95).toEqual(wilson(16, 20)!.map(x => Math.round(x * 1e4) / 1e4) as [number, number]);
    expect(bridge.by_class.gold.false_fail_rate).toBe(0.1);
    expect(bridge.by_class.real).toMatchObject({ bad: 10, catch_rate: 1, good: 10, false_fail_rate: 0 });
    expect(r.gates.every(gt => gt.pass)).toBe(true);
  });

  test('Astra and Opus disagreeing on every real answer drops inter-judge kappa to 1/3 and stops; the real class falls out of the labelled set and reports n/a', () => {
    const { pool, grades } = setup(i => (i % 2 ? 1 : 0));
    const r = analyzeCheck(pool, grades);
    expect(r.inter_judge.kappa).toBe(0.3333);
    expect(r.stop).toBe(true);
    expect(r.gates.filter(gt => !gt.pass).map(gt => gt.gate)).toEqual(['inter-judge kappa, Astra vs Opus (i)']);
    expect(r.labelled_set.by_class.real).toBe(0);
    expect(r.shortfalls).toEqual(['0 labelled real items, below 15; its per-class numbers are n/a']);
    for (const j of r.per_judge) expect(j.by_class.real).toMatchObject({ catch_rate: null, false_fail_rate: null, kappa_vs_labelled: null, na: '0 labelled real items, below 15' });
  });

  test('a gating judge that passes every corrupted answer fails gate (ii) and stops', () => {
    const { pool, grades } = setup();
    for (const c of pool.filter(x => x.class === 'corrupt')) grades[OPUS_JUDGE][c.id] = g(1);
    const r = analyzeCheck(pool, grades);
    const failed = r.gates.filter(gt => !gt.pass).map(gt => gt.gate);
    expect(failed).toContain(OPUS_JUDGE + ' kappa against the construction labels (ii)');
    expect(failed).not.toContain(ASTRA + ' kappa against the construction labels (ii)');
    expect(r.per_judge.find(j => j.judge === OPUS_JUDGE)!.kappa_vs_construction).toBe(0);
    expect(r.stop).toBe(true);
  });

  test('truncation is a judge error; above 1% of a gating judge\'s judgments it stops, at 1% it does not', () => {
    for (const [cut, stop] of [[2, false], [3, true]] as const) {
      const pool = [...Array.from({ length: 100 }, (_, i) => cand('gold', i, true)), ...Array.from({ length: 100 }, (_, i) => cand('corrupt', i, false))];
      const grades: Grades = { [ASTRA]: {}, [OPUS_JUDGE]: {}, [BRIDGE]: {} };
      for (const c of pool) for (const j of [ASTRA, OPUS_JUDGE, BRIDGE]) grades[j][c.id] = g(c.labels[0] ? 1 : 0);
      for (const c of pool.slice(0, cut)) grades[ASTRA][c.id] = g(null, { truncated: true });
      const r = analyzeCheck(pool, grades);
      const astra = r.per_judge.find(j => j.judge === ASTRA)!;
      expect([astra.judgments, astra.judge_errors, astra.truncated, astra.truncation_rate]).toEqual([200, cut, cut, cut / 200]);
      expect(r.gates.find(gt => gt.gate === ASTRA + ' truncation rate')!.pass).toBe(!stop);
      expect(r.stop).toBe(stop);
      expect(r.inter_judge.items).toBe(200 - cut);
    }
  });
});

/** A judge client that answers every rubric call with score 1 (Opus: a truncated reply on any answer containing "cut"), recording what each call sent. */
function fakeJudges(): ChatLike & { calls: Array<{ model: string; opts: ChatOptions }> } {
  const calls: Array<{ model: string; opts: ChatOptions }> = [];
  return {
    calls,
    async chat(model: string, prompt: string, opts: ChatOptions): Promise<ChatResultV2> {
      calls.push({ model, opts });
      const cut = model === OPUS_JUDGE && prompt.includes('please cut');
      return { text: cut ? '{"score": 1' : '{"score": 1.0, "reason": "ok"}', input_tokens: 1, output_tokens: 1, cached: model === BRIDGE, finish: cut ? 'max_tokens' : 'stop', usage: null, response_model: model.split(':')[1] + '-snap', attempt_errors: [] } as ChatResultV2;
    },
  };
}

describe('grading the pool', () => {
  const qs = new Map([['q1', question('q1')], ['q2', question('q2')]]);
  const pool: Candidate[] = [
    { ...cand('gold', 1, true), question_id: 'q1', text: question('q1').answer!, labels: [true, true] },
    { ...cand('corrupt', 2, false), question_id: 'q2', text: 'Maria moved to Lisbon in 2829, please cut', labels: [false, true] },
  ];

  test('the gating judges are sent at the pinned settings in the gating view, the bridge at its protocol request; truncation and cache hits are recorded; a rerun resumes', async () => {
    const out = dir();
    const client = fakeJudges();
    const grades = await gradePool(pool, qs, client, instrumentFor('beam-1m'), out);
    for (const j of [ASTRA, OPUS_JUDGE]) expect(client.calls.filter(c => c.model === j).every(c => c.opts.effort === 'medium' && c.opts.maxTokens === 8000)).toBe(true);
    expect(client.calls.filter(c => c.model === BRIDGE).every(c => c.opts.effort === undefined && c.opts.maxTokens === 1024)).toBe(true);
    expect(client.calls.filter(c => c.model === OPUS_JUDGE)).toHaveLength(3);
    const recs = readFileSync(join(out, 'judgments.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(recs.map(r => [r.candidate, r.judge, r.view, r.settings ?? null])).toEqual(pool.flatMap(c => [
      [c.id, ASTRA, 'gating', { effort: 'medium', max_tokens: 8000 }], [c.id, OPUS_JUDGE, 'gating', { effort: 'medium', max_tokens: 8000 }], [c.id, BRIDGE, 'descriptive', null]]));
    expect(grades[OPUS_JUDGE]['corrupt:2']).toMatchObject({ scores: null, truncated: true });
    expect(grades[ASTRA]['corrupt:2']).toMatchObject({ scores: [1, 1], truncated: false, versions: ['gpt-6-astra-snap'] });
    const r = analyzeCheck(pool, grades);
    expect(r.per_judge.find(j => j.judge === OPUS_JUDGE)).toMatchObject({ judgments: 2, judge_errors: 1, truncated: 1, truncation_rate: 0.5 });
    expect(r.stop).toBe(true);
    const again = fakeJudges();
    await gradePool(pool, qs, again, instrumentFor('beam-1m'), out);
    expect(again.calls).toHaveLength(0);
  });
});

describe('the command line', () => {
  const run = (args: string[]) => Bun.spawnSync(['bun', 'eval/runner/rs1/judge-check.ts', ...args], { cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe' });
  const stage = (grades: Grades, pool: Candidate[]) => {
    const out = dir();
    writeFileSync(join(out, 'pool.json'), JSON.stringify({ seed: 1, pool, exclusions: [{ question_id: 'x', reason: 'gold does not state rubric item 0' }] }));
    writeFileSync(join(out, 'judgments.ndjson'), Object.entries(grades).flatMap(([judge, byC]) => Object.entries(byC).map(([candidate, gr]) =>
      JSON.stringify({ candidate, judge, outcome: gr.scores ? 'scored' : 'judge_error', detail: gr.scores ? { rubric_scores: gr.scores } : { truncated: gr.truncated }, calls: gr.calls, cache_hits: gr.cache_hits, judge_versions: gr.versions }))).join('\n') + '\n');
    return out;
  };

  test('report exits 3 with JUDGE_CHECK_STOP when a gate fails, and 0 when every gate passes; the published files hold ids and hashes, never answer text', () => {
    const failing = setup(i => (i % 2 ? 1 : 0));
    for (const c of failing.pool) c.text = 'SECRET ANSWER TEXT ' + c.id;
    const out = stage(failing.grades, failing.pool), pub = dir();
    const r = run(['report', '--out', out, '--publish', pub]);
    expect(r.exitCode).toBe(3);
    expect(r.stderr.toString()).toContain('JUDGE_CHECK_STOP: inter-judge kappa, Astra vs Opus (i) 0.3333 (line 0.6)');
    const json = readFileSync(join(pub, 'judge-check.json'), 'utf8');
    expect(json).not.toContain('SECRET ANSWER TEXT');
    expect(JSON.parse(json)).toMatchObject({ stop: true, gold_screen_exclusions: [{ question_id: 'x' }] });
    expect(readFileSync(join(pub, 'judge-check.md'), 'utf8')).toContain('**STOP: a gate failed.');
    const passing = setup();
    const ok = run(['report', '--out', stage(passing.grades, passing.pool)]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain('**Every gate passed.**');
  });

  test('a keyless rehearsal and a paid run never share an --out: the second refuses before it builds a pool or opens a lease, and report records which kind it read', () => {
    const out = dir(), stage1 = dir();
    mkdirSync(join(stage1, 'cells'));
    writeFileSync(join(out, 'upstream.json'), JSON.stringify({ keyless: false }) + '\n');
    const r = Bun.spawnSync(['bun', 'eval/runner/rs1/judge-check.ts', 'run', '--stage1', stage1, '--out', out, '--budget-ledger', join(out, 'ledger.ndjson'), '--run-id', 'jc-test',
      '--lease-usd', '1', '--ledger-cap-usd', '2', '--keyless-upstream', 'http://127.0.0.1:9'], { cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain('holds a paid judge-check run');
    const legacy = dir();
    writeFileSync(join(legacy, 'judgments.ndjson'), '');
    const l = Bun.spawnSync(['bun', 'eval/runner/rs1/judge-check.ts', 'run', '--stage1', stage1, '--out', legacy, '--budget-ledger', join(legacy, 'ledger.ndjson'), '--run-id', 'jc-test',
      '--lease-usd', '1', '--ledger-cap-usd', '2', '--keyless-upstream', 'http://127.0.0.1:9'], { cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' } });
    expect(l.exitCode).toBe(2);
    expect(l.stderr.toString()).toContain('no keyless/paid marker');
    expect(existsSync(join(legacy, 'upstream.json'))).toBe(false);
    expect(existsSync(join(out, 'pool.json'))).toBe(false);
    expect(existsSync(join(out, 'ledger.ndjson'))).toBe(false);
    const passing = setup();
    const staged = stage(passing.grades, passing.pool), pub = dir();
    writeFileSync(join(staged, 'upstream.json'), JSON.stringify({ keyless: true }) + '\n');
    const ok = run(['report', '--out', staged, '--publish', pub]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr.toString()).toContain('JUDGE_CHECK_KEYLESS');
    expect(JSON.parse(readFileSync(join(pub, 'judge-check.json'), 'utf8')).spend.keyless).toBe(true);
  });

  test('without --out or --stage1 it prints its usage and exits 2', () => {
    expect(run(['plan']).exitCode).toBe(2);
    expect(run(['run', '--out', dir()]).exitCode).toBe(2);
  });
});
