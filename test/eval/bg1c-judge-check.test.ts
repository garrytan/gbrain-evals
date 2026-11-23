/**
 * BG1-C's judge check (eval/runner/bg1/bg1c-judge-check.ts) and reread-cell.ts's `gating` option, keyless: the pool
 * stratified by row and Opus's grade, each gate at its boundary, the estimate, the paid-window refusal before any output,
 * the paid path's refusal of fixture-made or unwindowed sources, the re-read of a dev arm with an explicit gating judge,
 * Gemini's grading with its stale-grade refusal, and a keyless rehearsal end to end through the command line and the real
 * lease proxy in front of a scripted loopback upstream. The dev loop's outputs are synthetic: BG1's dev cells on the fake
 * memory system with a scripted reader and judge, over the template fixtures, bg1-dev-04 to bg1-dev-13 for each row.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  analyzeBg1c, BG1C_GATING_JUDGE, BG1C_READER, BG1C_ROWS, BG1C_SECOND_JUDGE, BG1C_WORLDS, bg1cEstimate, Bg1cRefusal, buildBg1cPool, devRunOf, gradeWithGemini, loadDevWorlds, planRows, rowArm,
  type Bg1cItem, type Bg1cRow, type GatedAnswer,
} from '../../eval/runner/bg1/bg1c-judge-check.ts';
import { DEV_WORLD_END, RUN_SCHEMA, runDevCell, type Comparator } from '../../eval/runner/bg1/dev-loop.ts';
import { poolSha256, type Grade } from '../../eval/runner/bg1/judge-check.ts';
import { BG1_FIXTURES_ROOT } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import type { ChatLike, ChatOptions, ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { sha256 } from '../../eval/runner/memory-qa/records.ts';
import { metering } from '../../eval/runner/q1/cell.ts';
import { prepareReread, runReread } from '../../eval/runner/q1/reread-cell.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { FakeMemorySystem } from '../../eval/runner/systems/fake.ts';

const ROOT = resolve(import.meta.dir, '../..');
const SHA = '6ce7195b44a034f85aec811f11fbf862db376f50';
const NO_META = { finish: 'stop', usage: null, response_model: null, attempt_errors: [] as string[] };
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PARTICLE_API_KEY', 'VOYAGE_API_KEY', 'BG1_GEMINI_API_KEY'];
const tmp = mkdtempSync(join(tmpdir(), 'bg1c-judge-check-'));
const runs = Object.fromEntries(BG1C_ROWS.map(row => [row, join(tmp, 'dev', row)])) as Record<Bg1cRow, string>;
const devRuns = BG1C_ROWS.flatMap(row => ['--dev-run', runs[row]]);
const cliEnv = { ...process.env, ...Object.fromEntries(KEYS.map(k => [k, ''])), SHOOTOUT_PROXY: '', GBRAIN_EVALS_BG1_DEV_ROOT: BG1_FIXTURES_ROOT };
const prior = Object.fromEntries([...KEYS, 'GBRAIN_EVALS_BG1_DEV_ROOT', 'GBRAIN_EVALS_BG1_WORLD_END'].map(k => [k, process.env[k]]));
const ndjson = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const answerOf = (prompt: string) => { const q = /Question: (.*)\n/.exec(prompt)?.[1] ?? ''; return `${sha256(q)[0] === '0' ? 'WRONG' : 'RIGHT'} ${q}`; };
const responseOf = (prompt: string) => /\nResponse: ([\s\S]*?)\n\nThe response is correct/.exec(prompt)?.[1] ?? '';
const flipped = (response: string) => sha256(response)[1] === '0';

const devReader: ChatLike = { async chat(_m, prompt): Promise<ChatResult> { return { text: /Question: (.*)\n/.exec(prompt)?.[1] ?? 'unknown', input_tokens: 10, output_tokens: 8, cached: false, ...NO_META }; } };
const devJudge: ChatLike = { async chat(): Promise<ChatResult> { return { text: '{"correct": 1}', input_tokens: 100, output_tokens: 4, cached: false, ...NO_META }; } };

beforeAll(async () => {
  for (const k of KEYS) process.env[k] = '';
  process.env.GBRAIN_EVALS_BG1_DEV_ROOT = BG1_FIXTURES_ROOT;
  process.env.GBRAIN_EVALS_BG1_WORLD_END = DEV_WORLD_END;
  const corpus = loadDevWorlds(true);
  for (const row of BG1C_ROWS) {
    for (const world of BG1C_WORLDS) {
      const res = await runDevCell({ ...(row === 'gbrain-defaults' ? { sha: SHA } : { system: row as Comparator }), world, out: join(runs[row], 'worlds', world), systemUrl: null, env: { ...process.env, SHOOTOUT_PROXY: undefined } },
        { system: new FakeMemorySystem(), reader: devReader, judge: devJudge, corpus, clockMs: () => Date.parse('2026-11-09T00:00:00Z'), now: new Date('2026-11-17T08:00:00Z') });
      expect(res.share).toMatchObject({ questions: 64, complete: true });
    }
    writeFileSync(join(runs[row], 'run.json'), JSON.stringify(row === 'gbrain-defaults' ? { schema: RUN_SCHEMA, gbrain_ref: 'v0.60.741.0', gbrain_sha: SHA, worlds: [...BG1C_WORLDS], world_end: DEV_WORLD_END }
      : { schema: RUN_SCHEMA, system: row, worlds: [...BG1C_WORLDS], world_end: DEV_WORLD_END }));
  }
}, 240_000);
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const refusal = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e.op; throw e; }
  throw new Error('expected a refusal');
};

async function cli(args: string[], env: Record<string, string | undefined> = cliEnv) {
  const p = Bun.spawn(['bun', 'eval/runner/bg1/bg1c-judge-check.ts', ...args], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

describe('the pool', () => {
  const answer = (row: Bg1cRow, i: number, opus: number | null): GatedAnswer => ({ answer_id: sha256(`${row}|${i}`), row, question_id: `bg1-dev-04:s1_updated:${i % 8}`, conversation: 'bg1-dev-04', text: `answer ${row} ${i}`,
    outcome: opus === null ? 'reader_error' : 'scored', opus, truncated: false });
  const rowOf = (row: Bg1cRow, wrong: number, right: number, ungraded = 0) => Array.from({ length: wrong + right + ungraded }, (_, i) => answer(row, i, i < wrong ? 0 : i < wrong + right ? 1 : null));
  const tally = (pool: Bg1cItem[]) => Object.fromEntries(BG1C_ROWS.map(row => [row, { wrong: pool.filter(i => i.row === row && i.opus === 0).length, right: pool.filter(i => i.row === row && i.opus === 1).length }]));

  test('takes every answer Opus graded wrong and as many graded right, row by row; leaves ungraded answers out; is seeded and ignores input order', () => {
    const answers = [...rowOf('gbrain-defaults', 30, 200, 5), ...rowOf('ext-memory-bank', 15, 100), ...rowOf('ext-extract-first', 5, 150, 3)];
    const pool = buildBg1cPool(answers, 7);
    const wrong = answers.filter(a => a.opus === 0).map(a => `bg1c-${a.answer_id}`).sort();
    expect(wrong).toHaveLength(50);
    expect(pool.filter(i => i.opus === 0).map(i => i.id).sort()).toEqual(wrong);
    expect(tally(pool)).toEqual({ 'gbrain-defaults': { wrong: 30, right: 30 }, 'ext-memory-bank': { wrong: 15, right: 15 }, 'ext-extract-first': { wrong: 5, right: 5 } });
    const ungraded = new Set(answers.filter(a => a.opus === null).map(a => `bg1c-${a.answer_id}`));
    expect(pool.some(i => ungraded.has(i.id))).toBe(false);
    expect(new Set(pool.map(i => i.id)).size).toBe(pool.length);
    expect(pool.every(i => i.text_sha256 === sha256(i.text))).toBe(true);
    expect(buildBg1cPool([...answers].reverse(), 7)).toEqual(pool);
    const other = buildBg1cPool(answers, 8);
    expect(other.filter(i => i.opus === 0).map(i => i.id).sort()).toEqual(wrong);
    expect(tally(other)).toEqual(tally(pool));
    expect(other.filter(i => i.opus === 1).map(i => i.id).sort()).not.toEqual(pool.filter(i => i.opus === 1).map(i => i.id).sort());
  });

  test('a row short of right answers keeps all of them, and the other rows make up the rest', () => {
    const pool = buildBg1cPool([...rowOf('gbrain-defaults', 30, 10), ...rowOf('ext-memory-bank', 5, 100), ...rowOf('ext-extract-first', 5, 100)], 7);
    expect(pool.filter(i => i.opus === 0)).toHaveLength(40);
    expect(pool.filter(i => i.opus === 1)).toHaveLength(40);
    const t = tally(pool);
    expect(t['gbrain-defaults']).toEqual({ wrong: 30, right: 10 });
    expect(t['ext-memory-bank'].right + t['ext-extract-first'].right).toBe(30);
    expect(Math.min(t['ext-memory-bank'].right, t['ext-extract-first'].right)).toBeGreaterThanOrEqual(5);
  });

  test('with fewer than 40 wrong answers the pool still takes every one of them and as many right', () => {
    const pool = buildBg1cPool([...rowOf('gbrain-defaults', 6, 50), ...rowOf('ext-memory-bank', 4, 50), ...rowOf('ext-extract-first', 2, 50)], 7);
    expect(tally(pool)).toEqual({ 'gbrain-defaults': { wrong: 6, right: 6 }, 'ext-memory-bank': { wrong: 4, right: 4 }, 'ext-extract-first': { wrong: 2, right: 2 } });
  });
});

describe('the gates', () => {
  /** tt: both graded right; ff: both wrong; tf: Gemini right, Opus wrong; ft: Gemini wrong, Opus right; ungraded: Gemini gave no grade. */
  function scenario(c: { tt: number; ff: number; tf: number; ft: number; ungraded?: number }) {
    const items: Bg1cItem[] = [], gemini: Record<string, Grade> = {};
    const add = (n: number, opus: 0 | 1, score: number | null) => { for (let i = 0; i < n; i++) { const id = `bg1c-${items.length}`; items.push({ id, row: BG1C_ROWS[items.length % 3], question_id: 'q', conversation: 'bg1-dev-04', text: 't', text_sha256: 'x', opus }); gemini[id] = { score, truncated: false }; } };
    add(c.tt, 1, 1); add(c.ff, 0, 0); add(c.tf, 0, 1); add(c.ft, 1, 0); add(c.ungraded ?? 0, 1, null);
    return analyzeBg1c(items, gemini, []);
  }
  const gate = (r: ReturnType<typeof scenario>, name: string) => r.gates.find(g => g.gate === name)!;

  test('kappa passes at 0.6 and fails just below it', () => {
    const at = scenario({ tt: 20, ff: 20, tf: 5, ft: 5 });
    expect(gate(at, 'gemini_opus_kappa')).toMatchObject({ value: 0.6, line: 0.6, pass: true });
    expect(at.gates.every(g => g.pass)).toBe(true);
    expect(at.stop).toBe(false);
    expect(at.inter_judge.table).toEqual({ both_right: 20, both_wrong: 20, gemini_right_opus_wrong: 5, gemini_wrong_opus_right: 5 });
    const below = scenario({ tt: 20, ff: 20, tf: 5, ft: 6 });
    expect(gate(below, 'gemini_opus_kappa').pass).toBe(false);
    expect(gate(below, 'gemini_opus_kappa').value!).toBeLessThan(0.6);
    expect([gate(below, 'agreed_items').pass, gate(below, 'agreed_per_class').pass, below.stop]).toEqual([true, true, true]);
  });

  test('40 agreed items pass and 39 fail', () => {
    expect(gate(scenario({ tt: 20, ff: 20, tf: 0, ft: 0 }), 'agreed_items')).toMatchObject({ value: 40, line: 40, pass: true });
    const r = scenario({ tt: 20, ff: 19, tf: 0, ft: 0 });
    expect(gate(r, 'agreed_items')).toMatchObject({ value: 39, pass: false });
    expect([gate(r, 'gemini_opus_kappa').pass, gate(r, 'agreed_per_class').pass, r.stop]).toEqual([true, true, true]);
  });

  test('15 agreed items in each class pass and 14 in one fail', () => {
    expect(gate(scenario({ tt: 25, ff: 15, tf: 0, ft: 0 }), 'agreed_per_class')).toMatchObject({ value: 15, line: 15, pass: true });
    const r = scenario({ tt: 26, ff: 14, tf: 0, ft: 0 });
    expect(gate(r, 'agreed_per_class')).toMatchObject({ value: 14, pass: false });
    expect([gate(r, 'gemini_opus_kappa').pass, gate(r, 'agreed_items').pass, r.stop]).toEqual([true, true, true]);
    const flipped = scenario({ tt: 14, ff: 26, tf: 0, ft: 0 });
    expect(gate(flipped, 'agreed_per_class')).toMatchObject({ value: 14, pass: false });
  });

  test('items Gemini did not grade count in neither kappa nor agreement, and the report carries no dollar field', () => {
    const r = scenario({ tt: 20, ff: 20, tf: 5, ft: 5, ungraded: 7 });
    expect(r.gemini).toEqual({ graded: 50, ungraded: 7 });
    expect([r.inter_judge.kappa, r.inter_judge.n, r.agreed.items]).toEqual([0.6, 50, 40]);
    expect(JSON.stringify(r)).not.toMatch(/usd|cost|\$/i);
  });
});

describe('the estimate', () => {
  test("prices 1,920 contexts at the preregistration's $38: gpt-6.2-sol's list price with gpt-6.1-sol's token parameters, and Opus at BG1's measured rate", () => {
    const all = bg1cEstimate(BG1C_ROWS.map(() => ({ contexts: 640, budget: 8000 })));
    expect(all).toMatchObject({ contexts: 1920, reads_usd: 33.43, opus_grades_usd: 4.63, reads_and_opus_usd: 38.06, gemini_pool_at_most_usd: 0.77, total_at_most_usd: 38.83 });
    expect(bg1cEstimate([{ contexts: 192, budget: 8000 }])).toMatchObject({ reads_usd: 3.34, opus_grades_usd: 0.46 });
  });
});

describe('re-reading a dev arm with an explicit gating judge', () => {
  function recording(text: (prompt: string) => string): ChatLike & { calls: Array<{ model: string; opts: ChatOptions }> } {
    const calls: Array<{ model: string; opts: ChatOptions }> = [];
    return { calls, async chat(model, prompt, opts): Promise<ChatResult> { calls.push({ model, opts }); return { text: text(prompt), input_tokens: 100, output_tokens: 5, cached: false, ...NO_META }; } };
  }

  // Value: protects=gpt-6.2-sol's re-reads are graded as a counted BG1-C row of that reader: by its named gating judge alone, in the gating view at the pinned settings; fails_when=a re-read of a dev arm refuses gpt-6.2-sol for want of a judge map entry, grades with the canonical Gemini view too, takes a judge of the reader's family, or resumes under another judge; why_new=BG1-C harness item 4; seam=one dev world's comparator source, scripted reader and judge, no proxy; no_claim=the judges' grades
  test('without a named judge gpt-6.2-sol is refused; with one, that judge grades alone in the gating view at the pinned settings, and a judge of the reader\'s family or another judge on resume is refused', async () => {
    const corpus = loadDevWorlds(true);
    const { def, arm } = rowArm(devRunOf(runs['ext-memory-bank']), corpus);
    const one = { ...arm, questions: { kind: 'ids' as const, ids: corpus.questions.filter(q => q.conversation === 'bg1-dev-04').map(q => q.id) } };
    const sources = [join(runs['ext-memory-bank'], 'worlds', 'bg1-dev-04', 'runs', def.id)];
    expect(refusal(() => prepareReread(def, one, { sources, reader: BG1C_READER, out: join(tmp, 'gating-none') }, { corpus })).message).toContain(`no per-reader judge is mapped for ${BG1C_READER}`);
    expect(refusal(() => prepareReread(def, one, { sources, reader: BG1C_READER, out: join(tmp, 'gating-own'), gating: 'openai:gpt-6-astra' }, { corpus })).message).toContain('a reader of its own family');
    for (const d of ['gating-none', 'gating-own']) expect(existsSync(join(tmp, d))).toBe(false);
    const out = join(tmp, 'gating');
    const judge = recording(() => '{"correct": 1}'), reader = recording(answerOf);
    const res = await runReread(prepareReread(def, one, { sources, reader: BG1C_READER, out, gating: BG1C_GATING_JUDGE }, { corpus }), {}, { reader, judge });
    expect(res.status).toBe('complete');
    expect(reader.calls.map(c => [c.model, c.opts.maxTokens, c.opts.effort])).toEqual(Array(64).fill([BG1C_READER, 2048, 'medium']));
    expect(judge.calls.map(c => [c.model, c.opts.maxTokens, c.opts.effort])).toEqual(Array(64).fill([BG1C_GATING_JUDGE, 8000, 'medium']));
    expect(ndjson(join(res.dir, 'judgments.ndjson')).map(j => [j.instrument_id, j.judge, j.view, j.settings])).toEqual(Array(64).fill([`bg1-dev@${BG1C_GATING_JUDGE}`, BG1C_GATING_JUDGE, 'gating', { effort: 'medium', max_tokens: 8000 }]));
    expect(res.receipt).toMatchObject({ run_status: 'complete', readers: [BG1C_READER], instrument: { judge: null }, per_reader_mean: { [BG1C_READER]: null }, per_reader_frontier_mean: { [BG1C_READER]: 1 },
      frontier: { per_reader: true, judge_by_reader: { [BG1C_READER]: BG1C_GATING_JUDGE }, instrument_ids: [`bg1-dev@${BG1C_GATING_JUDGE}`] }, counts: { answers: 64, judgments: 64, unjudged: 0 } });
    expect(JSON.parse(readFileSync(join(out, 'reread-source.json'), 'utf8')).gating).toBe(BG1C_GATING_JUDGE);
    const again = recording(() => '{"correct": 1}');
    expect((await runReread(prepareReread(def, one, { sources, reader: BG1C_READER, out, gating: BG1C_GATING_JUDGE }, { corpus }), {}, { reader, judge: again })).status).toBe('complete');
    expect(again.calls).toHaveLength(0);
    expect(refusal(() => prepareReread(def, one, { sources, reader: BG1C_READER, out, gating: BG1C_SECOND_JUDGE }, { corpus })).message).toContain('holds a re-read of other sources');
  });
});

describe('the sources', () => {
  // Value: protects=the check re-reads exactly one run of each row and all ten worlds; fails_when=two runs of a row, a run of another system, or a run missing one of the ten worlds is taken; why_new=BG1-C harness item 4; seam=the synthetic dev runs; no_claim=none
  test('one run of each row is required, and a run that misses one of the ten worlds is refused', () => {
    const corpus = loadDevWorlds(true);
    expect(planRows(BG1C_ROWS.map(r => runs[r]), corpus, true).map(p => [p.run.row, p.sources.length])).toEqual(BG1C_ROWS.map(r => [r, 10]));
    expect(() => planRows([runs['gbrain-defaults'], runs['gbrain-defaults'], runs['ext-memory-bank']], corpus, true)).toThrow('gbrain-defaults has 2, ext-extract-first has 0');
    const partial = join(tmp, 'partial');
    cpSync(join(runs['gbrain-defaults'], 'worlds', 'bg1-dev-04'), join(partial, 'worlds', 'bg1-dev-04'), { recursive: true });
    cpSync(join(runs['gbrain-defaults'], 'run.json'), join(partial, 'run.json'));
    expect(() => planRows([partial, runs['ext-memory-bank'], runs['ext-extract-first']], corpus, true)).toThrow(`stages no bg1-dev-extra.gbrain-defaults.rs1-stable output for ${BG1C_WORLDS.slice(1).join(', ')}`);
    const other = join(tmp, 'other-system');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'run.json'), JSON.stringify({ schema: RUN_SCHEMA, system: 'ext-temporal-graph' }));
    expect(() => devRunOf(other)).toThrow(Bg1cRefusal);
    writeFileSync(join(other, 'run.json'), JSON.stringify({ schema: RUN_SCHEMA, gbrain_sha: SHA, overlay: { 'search.evidence_titles': true } }));
    expect(() => devRunOf(other)).toThrow('without an overlay');
  });
});

describe('Gemini\'s grading', () => {
  // Value: protects=Gemini's grades count only on the pool they were made on; fails_when=a resume grades a changed pool (another Opus grade or answer text) and keeps the old grades; why_new=BG1-C harness item 4; seam=a scripted Gemini, no proxy; no_claim=Gemini's grades
  test('grades each pool item once, as BG1 ran its canonical judge, resumes, and refuses grades of another pool before any call', async () => {
    const corpus = loadDevWorlds(true);
    const qs = new Map(corpus.questions.map(q => [q.id, q]));
    const [q1, q2] = corpus.questions;
    const pool: Bg1cItem[] = [q1, q2].map((q, i) => ({ id: `bg1c-${i}`, row: 'gbrain-defaults', question_id: q.id, conversation: q.conversation, text: `answer ${i}`, text_sha256: sha256(`answer ${i}`), opus: i ? 1 : 0 }));
    const out = join(tmp, 'gemini');
    mkdirSync(out, { recursive: true });
    const calls: Array<{ model: string; opts: ChatOptions }> = [];
    const gemini: ChatLike = { async chat(model, _p, opts): Promise<ChatResult> { calls.push({ model, opts }); return { text: '{"correct": 1}', input_tokens: 100, output_tokens: 5, cached: false, ...NO_META }; } };
    const instrument = instrumentFor('bg1-dev');
    const meter = metering(null, { meter: () => {} }, {});
    const first = await gradeWithGemini(pool, qs, gemini, meter, instrument, out, 7);
    expect(first.stopped).toBeNull();
    expect(Object.keys(first.grades).sort()).toEqual(['bg1c-0', 'bg1c-1']);
    expect(calls.map(c => [c.model, c.opts.maxTokens, c.opts.effort])).toEqual([[BG1C_SECOND_JUDGE, 1024, undefined], [BG1C_SECOND_JUDGE, 1024, undefined]]);
    const recs = ndjson(join(out, 'judgments.ndjson'));
    expect(recs.map(r => [r.item, r.judge, r.view, r.pool_sha256, r.seed])).toEqual(pool.map(i => [i.id, BG1C_SECOND_JUDGE, 'descriptive', poolSha256(pool, 7, qs, instrument), 7]));
    await gradeWithGemini(pool, qs, gemini, meter, instrument, out, 7);
    expect(calls).toHaveLength(2);
    for (const changed of [[{ ...pool[0], opus: 1 as const }, pool[1]], [{ ...pool[0], text: 'another', text_sha256: sha256('another') }, pool[1]]]) {
      await expect(gradeWithGemini(changed, qs, gemini, meter, instrument, out, 7)).rejects.toThrow('holds grades not made on pool');
      expect(calls).toHaveLength(2);
    }
  });
});

describe('the command line', () => {
  // Value: protects=no BG1-C judge-check call reaches a provider outside a granted paid window; fails_when=run without --keyless-upstream starts without --paid-window and --window-cap-usd, or with a ledger cap or lease above the window cap, or writes anything first; why_new=BG1-C harness item 4; seam=the synthetic dev runs, blank keys, the template fixtures as the dev root (so a broken guard still stops at the corpus load); no_claim=none
  test('run without --keyless-upstream needs the granted window, and a ledger cap or lease above it is refused, before any output', async () => {
    const base = (out: string, lease = '1', ledgerCap = '2') => ['run', ...devRuns, '--out', out, '--budget-ledger', join(out, 'ledger.sqlite'), '--run-id', 'jc', '--lease-usd', lease, '--ledger-cap-usd', ledgerCap];
    const [bare, over, lease, half, joined] = ['bare', 'over', 'lease', 'half', 'joined'].map(n => join(tmp, 'window', n));
    const cases: Array<[string[], string]> = [
      [base(bare), 'needs --paid-window <unit> and --window-cap-usd <n> from the granted paid window'],
      [[...base(over), '--paid-window', 'BG1C-JC', '--window-cap-usd', '1.5'], "--ledger-cap-usd is above paid window BG1C-JC's cap"],
      [[...base(lease, '3', '2'), '--paid-window', 'BG1C-JC', '--window-cap-usd', '2'], "--lease-usd is above paid window BG1C-JC's cap"],
      [[...base(half), '--paid-window', 'BG1C-JC'], '--window-cap-usd needs the granted window cap'],
      [[...base(joined), '--keyless-upstream=http://127.0.0.1:9'], "takes the fake upstream's URL as its own argument"],
    ];
    for (const [args, why] of cases) {
      const r = await cli(args);
      expect([r.code, r.stderr]).toEqual([2, expect.stringContaining(why)]);
    }
    for (const d of [bare, over, lease, half, joined]) expect(existsSync(d)).toBe(false);
    expect((await cli(['run', '--dev-run', runs['gbrain-defaults'], '--out', bare])).code).toBe(2);
    expect(existsSync(bare)).toBe(false);
  }, 60_000);

  // Value: protects=a paid check re-reads only the dev loop's own paid outputs of the rendered dev worlds; fails_when=a paid load takes the template fixtures, a dev run whose run.json names no paid window, or sources packed from other worlds than the ones it grades against; why_new=BG1-C harness item 4; seam=plan (which sends nothing) on a fresh --out over the synthetic dev runs; no_claim=none
  test('a paid plan refuses the template fixtures, dev runs without a paid window, and sources packed from other dev worlds', async () => {
    const out = join(tmp, 'paid-plan');
    const fixtures = await cli(['plan', ...devRuns, '--out', out]);
    expect([fixtures.code, fixtures.stderr]).toEqual([2, expect.stringContaining('is the committed template fixtures (eval/data/changing-facts-v1/fixtures), and this load is not keyless')]);
    const rendered = { ...cliEnv, GBRAIN_EVALS_BG1_DEV_ROOT: '' };
    delete (rendered as Record<string, string | undefined>).GBRAIN_EVALS_BG1_DEV_ROOT;
    const unwindowed = await cli(['plan', ...devRuns, '--out', out], rendered);
    expect([unwindowed.code, unwindowed.stderr]).toEqual([2, expect.stringContaining('a paid check re-reads only dev-loop runs whose run.json names their paid window')]);
    const saved = BG1C_ROWS.map(r => readFileSync(join(runs[r], 'run.json'), 'utf8'));
    try {
      for (const r of BG1C_ROWS) writeFileSync(join(runs[r], 'run.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(runs[r], 'run.json'), 'utf8')), paid_window: 'GST-2854-dev' }));
      const other = await cli(['plan', ...devRuns, '--out', out], rendered);
      expect([other.code, other.stderr]).toEqual([2, expect.stringContaining('sources did not read the dev worlds this check grades against')]);
    } finally { BG1C_ROWS.forEach((r, i) => writeFileSync(join(runs[r], 'run.json'), saved[i])); }
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  /** A loopback upstream: gpt-6.2-sol answers RIGHT or WRONG by the question's hash, Opus grades by that word, and Gemini agrees with Opus except on a hashed sixteenth. */
  function scriptedUpstream() {
    const log: Array<{ path: string; model: string; body: Record<string, any>; auth: string; prompt: string }> = [];
    const verdict = (prompt: string, flip: boolean) => JSON.stringify({ correct: responseOf(prompt).startsWith('RIGHT') !== flip ? 1 : 0 });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      const path = new URL(req.url).pathname, body = await req.json() as Record<string, any>;
      const prompt = (body.messages as Array<{ content: unknown }>).map(m => (typeof m.content === 'string' ? m.content : (m.content as Array<{ text?: string }>).map(c => c.text ?? '').join(''))).join('\n');
      log.push({ path, model: body.model, body, auth: req.headers.get('authorization') ?? req.headers.get('x-api-key') ?? '', prompt });
      if (path.endsWith('/v1/messages')) return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: verdict(prompt, false) }], usage: { input_tokens: 100, output_tokens: 5 } });
      if (path.endsWith('/chat/completions')) {
        const text = String(body.model).startsWith('gemini') ? verdict(prompt, flipped(responseOf(prompt))) : answerOf(prompt);
        return Response.json({ id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
      }
      return Response.json({ error: { message: `no route ${path}` } }, { status: 404 });
    } });
    return { url: `http://127.0.0.1:${server.port}`, log, stop: () => server.stop(true) };
  }

  // Value: protects=the keyless rehearsal of the whole check: 1,920 byte-for-byte gpt-6.2-sol re-reads graded by Opus alone, the stratified pool graded by Gemini alone, the gates, the report and a resume; fails_when=any context is skipped or altered, a reading or grade reaches the upstream with a key or at other settings, Gemini grades outside the pool, the pool is not every wrong answer and as many right, a resume sends anything, or a rehearsal's report passes as paid; why_new=BG1-C harness item 4; seam=the synthetic dev runs and a scripted loopback upstream behind the real lease proxy; no_claim=any model's grades
  test('a keyless rehearsal re-reads all 1,920 contexts, grades them with Opus, grades the pool with Gemini, reports the gates and resumes without a request', async () => {
    const up = scriptedUpstream();
    const out = join(tmp, 'rehearsal');
    const run = (runId: string) => cli(['run', ...devRuns, '--out', out, '--budget-ledger', join(tmp, 'rehearsal-ledger.sqlite'), '--run-id', runId, '--lease-usd', '10', '--ledger-cap-usd', '20', '--keyless-upstream', up.url]);
    try {
      const r = await run('bg1c-r1');
      expect(r.stderr).toContain('JUDGE_CHECK_NOT_PAID: a keyless rehearsal');
      expect(r.code).toBe(4);
      const readers = up.log.filter(l => l.model === 'gpt-6.2-sol'), opus = up.log.filter(l => l.model === 'claude-opus-5-5'), gemini = up.log.filter(l => l.model === 'gemini-3.8-flash');
      expect([readers.length, opus.length, readers.length + opus.length + gemini.length]).toEqual([1920, 1920, up.log.length]);
      expect(up.log.every(l => l.auth.includes('keyless-not-a-provider-key'))).toBe(true);
      expect(readers.every(l => l.path.endsWith('/v1/chat/completions') && l.body.max_completion_tokens === 2048 && l.body.reasoning_effort === 'medium' && !('n' in l.body))).toBe(true);
      expect(opus.every(l => l.path.endsWith('/v1/messages') && l.body.max_tokens === 8000 && l.body.output_config?.effort === 'medium')).toBe(true);
      expect(up.log.findIndex(l => l.model === 'gemini-3.8-flash')).toBeGreaterThan(up.log.findLastIndex(l => l.model !== 'gemini-3.8-flash'));
      const frozen = BG1C_ROWS.flatMap(row => BG1C_WORLDS.flatMap(w => ndjson(join(runs[row], 'worlds', w, 'runs', `bg1-dev-extra.${row}.${row === 'gbrain-defaults' ? 'rs1-stable' : row === 'ext-memory-bank' ? 'recipe' : 'common'}`, 'contexts.ndjson')).map(c => c.prompt_sha256)));
      expect(readers.map(l => sha256(l.body.messages.at(-1).content)).sort()).toEqual(frozen.sort());

      for (const row of BG1C_ROWS) {
        const cells = join(out, 'rereads', row, 'cells');
        const [cell] = readdirSync(cells);
        expect(cell.endsWith('.reread-openai-gpt-6.2-sol')).toBe(true);
        expect(ndjson(join(cells, cell, 'answers.ndjson'))).toHaveLength(640);
        expect(ndjson(join(cells, cell, 'judgments.ndjson')).every(j => j.judge === BG1C_GATING_JUDGE && j.view === 'gating' && j.instrument_id === `bg1-dev@${BG1C_GATING_JUDGE}`)).toBe(true);
      }
      const wrong = readers.filter(l => answerOf(l.prompt).startsWith('WRONG')).length;
      const { pool } = JSON.parse(readFileSync(join(out, 'pool.json'), 'utf8')) as { pool: Bg1cItem[] };
      expect([pool.filter(i => i.opus === 0).length, pool.filter(i => i.opus === 1).length]).toEqual([wrong, wrong]);
      expect(wrong).toBeGreaterThanOrEqual(40);
      expect(new Set(gemini.map(l => l.prompt)).size).toBe(gemini.length);
      expect([...new Set(gemini.map(l => sha256(responseOf(l.prompt))))].sort()).toEqual([...new Set(pool.map(i => i.text_sha256))].sort());
      const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
      const flips = pool.filter(i => flipped(i.text)).length;
      expect(report).toMatchObject({ reader: BG1C_READER, gating_judge: BG1C_GATING_JUDGE, second_judge: BG1C_SECOND_JUDGE, answers: { total: 1920, opus_graded: 1920, opus_ungraded: 0 },
        pool: { items: 2 * wrong, wrong, right: wrong }, gemini: { graded: 2 * wrong, ungraded: 0 }, agreed: { items: 2 * wrong - flips }, stop: false });
      expect(report.gates.map((g: { gate: string; pass: boolean }) => [g.gate, g.pass])).toEqual([['gemini_opus_kappa', true], ['agreed_items', true], ['agreed_per_class', true]]);
      for (const row of BG1C_ROWS) expect(report.rows[row]).toMatchObject({ answers: 640, opus_graded: 640, outcomes: { scored: 640 } });
      expect(JSON.stringify(report)).not.toMatch(/usd|cost|\$|RIGHT |WRONG /);
      const bytes = readFileSync(join(out, 'report.json'), 'utf8');

      const again = await report_(out);
      expect([again.code, readFileSync(join(out, 'report.json'), 'utf8')]).toEqual([4, bytes]);
      const resumed = await run('bg1c-r2');
      expect([resumed.code, up.log.length]).toEqual([4, 1920 + 1920 + gemini.length]);
      expect(readFileSync(join(out, 'report.json'), 'utf8')).toBe(bytes);

      const plan = await cli(['plan', ...devRuns, '--out', out]);
      expect(plan.code).toBe(0);
      expect(JSON.parse(plan.stdout)).toMatchObject({ rows: BG1C_ROWS.map(row => ({ row, sources: 10, contexts: 640, without_context: 0, budget: 8000 })), estimate: { contexts: 1920, reads_and_opus_usd: 38.06 } });
      expect(up.log.length).toBe(1920 + 1920 + gemini.length);

      const tampered = join(tmp, 'rehearsal-tampered');
      cpSync(out, tampered, { recursive: true });
      writeFileSync(join(tampered, 'pool.json'), JSON.stringify({ seed: 20261119, pool: pool.slice(1) }));
      const refused = await report_(tampered);
      expect([refused.code, refused.stderr]).toEqual([2, expect.stringContaining('is not the pool the re-reads in')]);
    } finally { up.stop(); }
  }, 300_000);

  const report_ = (out: string) => cli(['report', '--out', out]);
});
