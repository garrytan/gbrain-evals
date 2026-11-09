/**
 * BG1's judge check (eval/runner/bg1/judge-check.ts), keyless: construction items from the plan's gold (each good and
 * bad kind, and the items it refuses to make), the seeded and stratified pool, kappa and Wilson against hand-computed
 * cases, the gates and the stop rule, truncation, grading at the pinned settings in the gating view with resume, the
 * paid stage 1 check, and the window guard that refuses before any lease, proxy or output.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import type { ChatLike, ChatOptions, ChatResultV2 } from '../../eval/runner/memory-qa/qa-v2.ts';
import {
  analyzeCheck, ASTRA, buildPool, cohenKappa, constructItems, gradePool, OPUS_JUDGE, stage1Unpaid, wilson,
  type Grades, type Item, type RealAnswer,
} from '../../eval/runner/bg1/judge-check.ts';
import { matchAnswer } from '../../eval/runner/bg1/match.ts';
import type { Bg1QuestionFields } from '../../eval/runner/bg1/types.ts';

const root = mkdtempSync(join(tmpdir(), 'bg1-judge-check-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = () => { const d = join(root, String(++n)); mkdirSync(d, { recursive: true }); return d; };

const question = (id: string, bg1: Partial<Bg1QuestionFields> = {}) => ({
  id, conversation: 'bg1-dev-01', question: 'Which city does Ana live in now?', answer: 'Porto', category: 's1_updated', gold: [], abstention: false,
  bg1: { stratum: 's1_updated', family: 'primary', form: 'exact', slot: 'person-01.city', gold_values: ['Porto'], stale_values: ['Lisbon'], decoy_values: ['Braga'], ...bg1 },
}) as unknown as MemoryQuestion;
const always = (x: number) => () => x;

describe('construction items', () => {
  test('a good item states the gold in a sentence; a bad one states a stale value, named by its stratum', () => {
    const c = constructItems(question('q1'), 0, always(0))!;
    expect(c).toEqual({ good: 'Porto.', bad: 'Lisbon.', kind: 'stale' });
    expect(constructItems(question('q2', { stratum: 's5_withdrawn' }), 1, always(0))).toMatchObject({ good: 'It is Porto.', bad: 'It is Lisbon.', kind: 'withdrawn' });
    expect(constructItems(question('q3', { stratum: 's6_as_of' }), 0, always(0))!.kind).toBe('wrong_date');
    expect(constructItems(question('q4', { stratum: 's7_as_known' }), 0, always(0))!.kind).toBe('wrong_date');
    expect(constructItems(question('q5', { stratum: 's2_corrected' }), 0, always(0))!.kind).toBe('stale');
  });

  test('every third question makes a decoy item where it has a decoy value', () => {
    expect(constructItems(question('q1'), 2, always(0))).toEqual({ good: 'The current answer is Porto.', bad: 'The current answer is Braga.', kind: 'decoy' });
    expect(constructItems(question('q2', { decoy_values: [] }), 2, always(0))!.kind).toBe('stale');
  });

  test('an ordered question\'s good item lists the gold in order, its bad item out of order, and the matcher agrees with both labels', () => {
    const q = question('q1', { stratum: 's8_history', family: 'secondary', ordered: true, gold_values: ['Lisbon', 'Porto', 'Faro'], stale_values: [] });
    const c = constructItems(q, 0, always(0))!;
    expect(c).toEqual({ good: 'Lisbon, then Porto, then Faro.', bad: 'Faro, then Porto, then Lisbon.', kind: 'wrong_order' });
    expect([matchAnswer(q, c.good), matchAnswer(q, c.bad)]).toEqual(['correct', 'other']);
  });

  test('a question that cannot make its due bad kind makes nothing', () => {
    expect(constructItems(question('q1', { stale_values: [] }), 0, always(0))).toBeNull();
    expect(constructItems(question('q2', { ordered: true, gold_values: ['Porto'], stale_values: [] }), 0, always(0))).toBeNull();
    expect(constructItems(question('q3', { ordered: true, gold_values: ['Porto', 'Lisbon', 'Porto'], stale_values: [] }), 0, always(0))).toBeNull();
    expect(constructItems(question('q4', { gold_values: [] }), 0, always(0))).toBeNull();
    expect(constructItems({ ...question('q5'), bg1: undefined } as MemoryQuestion, 0, always(0))).toBeNull();
    expect(constructItems(question('q6', { gold_values: ['Porto'], stale_values: ['Porto Alegre'] }), 0, always(0))).toEqual({ good: 'Porto.', bad: 'Porto Alegre.', kind: 'stale' });
  });
});

describe('the pool', () => {
  const questions = Array.from({ length: 48 }, (_, i) => question(`q${i}`, { stratum: (['s1_updated', 's5_withdrawn', 's6_as_of', 's8_history'] as const)[i % 4], ...(i % 4 === 3 ? { ordered: true, gold_values: ['Lisbon', 'Porto'] } : {}) }));
  const real: RealAnswer[] = Array.from({ length: 300 }, (_, i) => ({ answer_id: i.toString(16).padStart(64, '0'), question_id: `q${i % 48}`, conversation: 'bg1-dev-01', row: ['gbrain-defaults', 'ext-memory-bank', 'baseline-none'][i % 3], reader: i % 2 ? 'openai:gpt-6.1-sol' : 'anthropic:claude-opus-5-5', text: `answer ${i}`, canonical: i % 5 ? 1 : 0 }));

  test('the same seed gives the same pool, another seed another; ids are unique and every text is hashed', () => {
    const a = buildPool(questions, real, 7, { dev_answers: 40, construction_items: 20 }), b = buildPool(questions, real, 7, { dev_answers: 40, construction_items: 20 });
    expect(a).toEqual(b);
    expect(buildPool(questions, real, 8, { dev_answers: 40, construction_items: 20 })).not.toEqual(a);
    expect(new Set(a.map(i => i.id)).size).toBe(a.length);
    expect(a.filter(i => i.source === 'real')).toHaveLength(40);
    expect(a.filter(i => i.source === 'construction')).toHaveLength(20);
    expect(a.filter(i => i.label === 1)).toHaveLength(10);
  });

  test('real answers are drawn round-robin across row, reader and the canonical verdict', () => {
    const pool = buildPool(questions, real, 7, { dev_answers: 24, construction_items: 0 });
    const strata = new Map<string, number>();
    for (const i of pool) strata.set(`${i.row}|${i.reader}|${i.canonical}`, (strata.get(`${i.row}|${i.reader}|${i.canonical}`) ?? 0) + 1);
    expect(strata.size).toBe(12);
    expect([...strata.values()].every(x => x === 2)).toBe(true);
    expect(pool.every(i => i.label === null && i.kind === null)).toBe(true);
  });
});

describe('statistics', () => {
  test('Cohen\'s kappa and Wilson\'s interval match hand computations', () => {
    expect(cohenKappa([true, true, false, false], [true, false, false, false]).kappa).toBeCloseTo(0.5, 12);
    expect(cohenKappa([true, true], [true, true]).kappa).toBeNull();
    expect(cohenKappa([], []).kappa).toBeNull();
    const [lo, hi] = wilson(5, 10)!;
    expect(lo).toBeCloseTo(0.2366, 4);
    expect(hi).toBeCloseTo(0.7634, 4);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe('the gates', () => {
  const qs = new Map(Array.from({ length: 30 }, (_, i) => [`q${i}`, question(`q${i}`)]));
  const items: Item[] = Array.from({ length: 60 }, (_, i) => ({ id: `con-${i}`, source: 'construction', question_id: `q${i % 30}`, conversation: 'bg1-dev-01', text: i % 2 ? 'Porto.' : 'Lisbon.', text_sha256: 'x', label: i % 2 ? 1 : 0, kind: i % 2 ? 'good' : 'stale' }));
  const grades = (f: (i: Item, judge: string) => number | null, truncated = (_: Item, __: string) => false): Grades =>
    Object.fromEntries([ASTRA, OPUS_JUDGE].map(j => [j, Object.fromEntries(items.map(i => [i.id, { score: f(i, j), truncated: truncated(i, j) }]))]));

  test('two judges that grade like the labels pass every gate', () => {
    const r = analyzeCheck(items, grades(i => i.label), qs);
    expect(r.gates.every(g => g.pass)).toBe(true);
    expect(r.stop).toBe(false);
    expect(r.labelled).toEqual({ items: 60, pass: 30, fail: 30 });
    expect(r.judges[ASTRA].construction).toMatchObject({ kappa: 1, catch: { k: 30, n: 30, rate: 1 }, false_fail: { k: 0, n: 30, rate: 0 } });
    expect(r.judges[ASTRA].construction.catch_by_kind).toMatchObject({ stale: { k: 30, n: 30 } });
    expect(r.matcher.construction).toMatchObject({ kappa: 1, catch: { rate: 1 } });
    expect(JSON.stringify(r)).not.toMatch(/usd|cost|\$/i);
  });

  test('a judge that passes everything fails its construction kappa and stops the check', () => {
    const r = analyzeCheck(items, grades((i, j) => (j === OPUS_JUDGE ? 1 : i.label)), qs);
    expect(r.gates.find(g => g.gate === `construction_kappa:${OPUS_JUDGE}`)!.pass).toBe(false);
    expect(r.gates.find(g => g.gate === 'astra_opus_kappa')!.pass).toBe(false);
    expect(r.stop).toBe(true);
  });

  test('truncation above 1% fails, and fewer than 40 agreed items or 15 per class fail', () => {
    expect(analyzeCheck(items, grades(i => i.label, (i, j) => j === ASTRA && i.id === 'con-0'), qs).gates.find(g => g.gate === `truncation:${ASTRA}`)!.pass).toBe(false);
    const few = items.slice(0, 30);
    const r = analyzeCheck(few, grades(i => i.label), qs);
    expect(r.gates.find(g => g.gate === 'labelled_items')).toMatchObject({ value: 30, pass: false });
    expect(r.gates.find(g => g.gate === 'labelled_per_class')).toMatchObject({ value: 15, pass: true });
  });
});

function fakeJudges(): ChatLike & { calls: Array<{ model: string; prompt: string; opts: ChatOptions }> } {
  const calls: Array<{ model: string; prompt: string; opts: ChatOptions }> = [];
  return {
    calls,
    async chat(model: string, prompt: string, opts: ChatOptions): Promise<ChatResultV2> {
      calls.push({ model, prompt, opts });
      const cut = model === OPUS_JUDGE && prompt.includes('please cut');
      return { text: cut ? '{"correct": ' : prompt.includes('Response: Porto') ? '{"correct": 1}' : '{"correct": 0}', input_tokens: 1, output_tokens: 1, cached: false, finish: cut ? 'max_tokens' : 'stop', usage: null, response_model: model.split(':')[1] + '-snap', attempt_errors: [] } as ChatResultV2;
    },
  };
}

describe('grading', () => {
  test('both gating judges grade every item at the pinned settings in the gating view; truncation is recorded; a rerun resumes', async () => {
    const qs = new Map([['q1', question('q1')]]);
    const pool: Item[] = [
      { id: 'con-q1-good', source: 'construction', question_id: 'q1', conversation: 'bg1-dev-01', text: 'Porto.', text_sha256: 'a'.repeat(64), label: 1, kind: 'good' },
      { id: 'con-q1-stale', source: 'construction', question_id: 'q1', conversation: 'bg1-dev-01', text: 'Lisbon, please cut', text_sha256: 'b'.repeat(64), label: 0, kind: 'stale' },
    ];
    const out = dir();
    const client = fakeJudges();
    const grades = await gradePool(pool, qs, client, instrumentFor('bg1-dev'), out);
    expect(client.calls.every(c => c.opts.effort === 'medium' && c.opts.maxTokens === 8000)).toBe(true);
    expect(new Set(client.calls.map(c => c.model))).toEqual(new Set([ASTRA, OPUS_JUDGE]));
    const recs = readFileSync(join(out, 'judgments.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(recs.map(r => [r.item, r.judge, r.view, r.settings])).toEqual(pool.flatMap(i => [ASTRA, OPUS_JUDGE].map(j => [i.id, j, 'gating', { effort: 'medium', max_tokens: 8000 }])));
    expect(grades[ASTRA]['con-q1-good']).toEqual({ score: 1, truncated: false });
    expect(grades[ASTRA]['con-q1-stale']).toEqual({ score: 0, truncated: false });
    expect(grades[OPUS_JUDGE]['con-q1-stale']).toMatchObject({ score: null, truncated: true });
    const again = fakeJudges();
    await gradePool(pool, qs, again, instrumentFor('bg1-dev'), out);
    expect(again.calls).toHaveLength(0);
  });
});

describe('the command line', () => {
  const noKeys = { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '', VOYAGE_API_KEY: '' };
  const run = (args: string[]) => Bun.spawnSync(['bun', 'eval/runner/bg1/judge-check.ts', ...args], { cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe', env: noKeys });
  const paid = () => { const d = dir(); writeFileSync(join(d, 'upstream.json'), JSON.stringify({ keyless: false })); return d; };

  test('stage 1 must be a paid run: a keyless marker, a keyless lease or no marker is refused', () => {
    const keyless = dir(), lease = dir(), bare = dir(), ok = paid();
    writeFileSync(join(keyless, 'upstream.json'), JSON.stringify({ keyless: true }));
    writeFileSync(join(lease, 'lease-summary.json'), JSON.stringify({ keyless_upstream: true }));
    expect(stage1Unpaid(keyless)).toContain('holds a keyless run');
    expect(stage1Unpaid(lease)).toContain('holds a keyless campaign lease');
    expect(stage1Unpaid(bare)).toContain('has neither');
    expect(stage1Unpaid(ok)).toBeNull();
    const out = join(dir(), 'out');
    const r = run(['plan', '--stage1', ok, '--stage1', keyless, '--out', out]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain('--stage1 takes paid stage 1 outputs only');
    expect(existsSync(out)).toBe(false);
  });

  test('a run without --keyless-upstream needs the granted window, and a ledger cap or lease above the window cap is refused, before any output', () => {
    const base = (out: string) => ['run', '--stage1', paid(), '--out', out, '--budget-ledger', join(out, 'ledger.sqlite'), '--run-id', 'jc', '--lease-usd', '1', '--ledger-cap-usd', '2'];
    const bare = join(dir(), 'bare'), over = join(dir(), 'over'), lease = join(dir(), 'lease');
    const r = run(base(bare));
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain('needs --paid-window <unit> and --window-cap-usd <n>');
    const o = run([...base(over), '--paid-window', 'BG1-JC', '--window-cap-usd', '1.5']);
    expect(o.exitCode).toBe(2);
    expect(o.stderr.toString()).toContain('--ledger-cap-usd is above paid window BG1-JC\'s cap');
    const l = run(['run', '--stage1', paid(), '--out', lease, '--budget-ledger', join(lease, 'ledger.sqlite'), '--run-id', 'jc', '--lease-usd', '3', '--ledger-cap-usd', '2', '--paid-window', 'BG1-JC', '--window-cap-usd', '2']);
    expect(l.exitCode).toBe(2);
    expect(l.stderr.toString()).toContain('--lease-usd is above paid window BG1-JC\'s cap');
    for (const d of [bare, over, lease]) expect(existsSync(d)).toBe(false);
    expect(run(['run', '--stage1', paid(), '--out', join(dir(), 'x')]).exitCode).toBe(2);
    expect(run(['plan', '--out', join(dir(), 'x')]).exitCode).toBe(2);
  });
});
