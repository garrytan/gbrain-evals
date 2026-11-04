/**
 * RS1 judge script (GST-1154): eval/runner/rs1/judge.ts. Keyless: synthetic stage 1 and counted cell outputs, a
 * synthetic corpus and fake judge clients; nothing reaches a provider. Covers the keyed-subset rules, the 90% and 95%
 * boundaries, the 300 minimum, the family rule, the label sheet's blindness, RS1_JUDGE_CHECK_FAIL's code and exit, and
 * that sensitivity's stdout carries counts and hashes only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Corpus, MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { RS1_CONVERSATIONS } from '../../eval/runner/memory-qa/corpus.ts';
import { instrumentFor, type Instrument } from '../../eval/runner/memory-qa/instruments.ts';
import type { ChatLike } from '../../eval/runner/memory-qa/qa-v2.ts';
import { answerId, rawSha256, readRecords, RecordLog, sha256, type AnswerRecord, type JudgmentRecord } from '../../eval/runner/memory-qa/records.ts';
import { countNames } from '../../eval/runner/name-guard.ts';
import { parseCsv, toCsv } from '../../eval/runner/q1/hedge.ts';
import { judgeInstrumentId } from '../../eval/runner/q1/cells/judging.ts';
import {
  barOf, BARS, collectRows, FALLBACK_JUDGE, keyShort, main, PREREG_BRANCH, referenceOf, runFallback, sensitivitySample, SHEET_HEADER,
} from '../../eval/runner/rs1/judge.ts';

const OPUS = 'anthropic:claude-opus-5-5', SOL = 'openai:gpt-6.1-sol', PARTICLE = 'particle:particle-1', MINI = 'openai:gpt-4.1-mini', HAIKU = 'anthropic:claude-haiku-5-5';
const PLAN = { by_reader: { [OPUS]: [MINI], [SOL]: [HAIKU], [PARTICLE]: [MINI, HAIKU] } };
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'rs1-judge-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const q = (id: string, category: string, answer: string, conversation = '1m-20'): MemoryQuestion => ({ id, conversation, question: `What about item ${id}?`, category, gold: [], abstention: category === 'abstention', answer, rubric: [answer] });
const answer = (cellId: string, question: MemoryQuestion, reader: string, text: string): AnswerRecord => ({
  answer_id: answerId(cellId, question.id, reader, 0), cell_id: cellId, realization_id: 'r0', question_id: question.id, conversation: question.conversation, system: 'sys-under-test', arm: 'p', reader, replicate: 0,
  effort: 'medium', context_sha256: sha256('context'), text, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, provider_input_tokens: null, latency_ms: 1, outcome: 'scored',
});
const judgment = (a: AnswerRecord, judge: string, score: number, inst: Instrument): JudgmentRecord => ({
  answer_id: a.answer_id, instrument_id: judgeInstrumentId(inst, judge), instrument_sha256: inst.sha256, judge, judge_replicate: 0, temperature: 0, score, parse_ok: true, raw_sha256: rawSha256([]), outcome: 'scored',
});
const nd = (xs: unknown[]) => xs.map(x => JSON.stringify(x) + '\n').join('');
const cellDef = (id: string, o: { set: string; block: string; benchmark: string; split: string; plan?: unknown; readers?: string[] }) => ({
  id, set: o.set, block: o.block, benchmark: o.benchmark, split: o.split, canonical_instrument: o.benchmark,
  arms: [{ id: 'p', cell_id: `${id}.p`, set: o.set, arm: 'component', mode: 'packed', readers: o.readers ?? [OPUS, SOL], reader_replicates: {}, ...(o.plan === null ? {} : { judging: o.plan ?? PLAN }) }],
});
/** A judge client that reads the response out of BEAM's rubric prompt and scores it with scoreOf. */
const client = (scoreOf: (response: string) => number): ChatLike => ({
  async chat(model, prompt) {
    const response = prompt.slice(prompt.indexOf('- RESPONSE TO EVALUATE: ') + '- RESPONSE TO EVALUATE: '.length, prompt.indexOf('\n\n## EVALUATION RUBRIC'));
    return { text: JSON.stringify({ score: scoreOf(response) }), input_tokens: 0, output_tokens: 0, cached: false, finish: 'stop', usage: null, response_model: model, attempt_errors: [] };
  },
});
const truth = (text: string) => (/March 15, 2024|no information|Summary/.test(text) ? 1 : 0);
const capture = () => { const out: string[] = [], err: string[] = []; return { out, err, deps: { log: (s: string) => out.push(s), error: (s: string) => err.push(s) } }; };

/**
 * Stage 1 on one cell: 40 abstention items (even ones abstain), 120 date items (three in four right) and the rest
 * summaries, answered by Opus and Sol in the cell and by particle-1 in its re-read; every counted judge scores the
 * truth, except that claude-haiku-5-5 flips its score on the first flips particle-1 summaries.
 */
function stage1(o: { questions?: number; flips?: number; plan?: unknown } = {}) {
  const root = scratch(), src = join(root, 'out');
  const n = o.questions ?? 320, inst = instrumentFor('beam-1m');
  const questions = Array.from({ length: n }, (_, i) => i < 40 ? q(`1m-20:abstention:${i}`, 'abstention', 'Based on the chat, there is no information about this.')
    : i < 160 ? q(`1m-20:information_extraction:${i}`, 'information_extraction', 'March 15, 2024') : q(`1m-20:summarization:${i}`, 'summarization', 'A long summary of several sessions.'));
  const text = (i: number) => i < 40 ? (i % 2 ? 'It was the blue one, I believe.' : 'There is no information about that in our conversation.') : i < 160 ? (i % 4 ? '**Answer:** March 15, 2024.' : 'It was March 16, 2024.') : 'Summary of the sessions.';
  const def = cellDef('rs1-dev.test', { set: 'RS1-dev', block: 'RS1-dry', benchmark: 'beam-1m', split: 'dev', plan: o.plan });
  const files: Record<string, { answers: AnswerRecord[]; judgments: JudgmentRecord[] }> = { 'rs1-dev.test.p': { answers: [], judgments: [] }, 'rs1-dev.test.p.reread-particle-particle-1': { answers: [], judgments: [] } };
  let flipped = 0;
  questions.forEach((question, i) => {
    for (const [cell, reader, judges] of [['rs1-dev.test.p', OPUS, [MINI]], ['rs1-dev.test.p', SOL, [HAIKU]], ['rs1-dev.test.p.reread-particle-particle-1', PARTICLE, [MINI, HAIKU]]] as const) {
      const a = answer(cell, question, reader, text(i));
      files[cell].answers.push(a);
      for (const j of judges) {
        const flip = j === HAIKU && reader === PARTICLE && i >= 160 && flipped < (o.flips ?? 0);
        if (flip) flipped++;
        files[cell].judgments.push(judgment(a, j, flip ? 1 - truth(a.text) : truth(a.text), inst));
      }
    }
  });
  for (const [cell, f] of Object.entries(files)) { mkdirSync(join(src, 'cells', cell), { recursive: true }); writeFileSync(join(src, 'cells', cell, 'answers.ndjson'), nd(f.answers)); writeFileSync(join(src, 'cells', cell, 'judgments.ndjson'), nd(f.judgments)); }
  const manifest = join(root, 'rs1-cells.json');
  writeFileSync(manifest, JSON.stringify({ cells: [], smoke_cells: [def] }));
  const corpus: Corpus = { benchmark: 'beam-1m', conversations: [], questions, source: { name: 'synthetic', files: [], revision: 'test', license: 'test' } };
  return { root, src, manifest, corpus };
}

/** Writes the blind sheet through the CLI, then fills it the way a careful labeler would. */
async function labeledSheet(s: ReturnType<typeof stage1>) {
  const sheet = join(s.root, 'sheet.csv');
  const c = capture();
  expect(await main(['label', '--manifest', s.manifest, '--source', s.src, '--out', sheet], { corpus: s.corpus, ...c.deps })).toBe(0);
  const rows = parseCsv(readFileSync(sheet, 'utf8')).map(r => ({ ...r, label: r.task === 'abstention' ? (r.answer.includes('no information') ? 'abstained' : 'answered') : (r.answer.includes('March 15, 2024') ? 'correct' : 'incorrect') }));
  writeFileSync(sheet, toCsv(SHEET_HEADER, rows));
  return { sheet, text: readFileSync(sheet, 'utf8'), log: c.out };
}

const check = (s: ReturnType<typeof stage1>, sheet: string, extra: { client?: ChatLike } = {}) => {
  const c = capture(), out = join(s.root, 'check');
  return main(['check', '--manifest', s.manifest, '--source', s.src, '--labels', sheet, '--out', out, '--fake'], { corpus: s.corpus, client: extra.client ?? client(truth), ...c.deps })
    .then(code => ({ code, logs: c.out, err: c.err, dir: out, result: existsSync(join(out, 'judge-check.json')) ? JSON.parse(readFileSync(join(out, 'judge-check.json'), 'utf8')) : null }));
};

describe('the key', () => {
  const ref = (answer: string, category = 'information_extraction') => referenceOf({ category, abstention: false, answer });
  test('dates, numbers and short names key correct in their canonical forms', () => {
    const date = ref('March 15, 2024')!;
    expect(date.type).toBe('date');
    for (const t of ['You moved on March 15, 2024.', '**Answer:** 2024-03-15', 'It was the 15th of March 2024.', 'On 03/15/2024, after a long week.']) expect(keyShort(date, t)).toBe('correct');
    const money = ref('$1,500')!;
    expect(money.type).toBe('number');
    for (const t of ['You paid $1,500 for it.', 'It cost 1500 dollars.', 'About 1.5k.']) expect(keyShort(money, t)).toBe('correct');
    const days = ref('3 days')!;
    expect(keyShort(days, 'It took three days.')).toBe('correct');
    expect(keyShort(days, 'It took 3 weeks.')).toBe('wrong');
    const name = ref('Dr. Sarah Lee')!;
    expect(name).toMatchObject({ type: 'name', words: ['sarah', 'lee'] });
    expect(keyShort(name, 'Your doctor is Sarah Lee.')).toBe('correct');
    expect(keyShort(name, 'Based on what you told me, it was Dr. Sarah Lee.')).toBe('correct');
  });

  test('multi-candidate and negated answers are not keyed correct; an answer with nothing compatible is keyed wrong', () => {
    const date = ref('March 15, 2024')!, name = ref('Sarah Lee')!, num = ref('42')!;
    expect(keyShort(date, 'Either March 15, 2024 or March 16, 2024.')).toBe('unkeyed');
    expect(keyShort(date, 'It was not March 15, 2024.')).toBe('unkeyed');
    expect(keyShort(date, 'It was March 16, 2024.')).toBe('wrong');
    expect(keyShort(date, 'Sometime in March 2024.')).toBe('unkeyed');
    expect(keyShort(name, 'It was Sarah Lee or Maria Gomez.')).toBe('unkeyed');
    expect(keyShort(name, "It wasn't Sarah Lee.")).toBe('unkeyed');
    expect(keyShort(name, 'It was Maria Gomez.')).toBe('wrong');
    expect(keyShort(name, 'It was Sarah.')).toBe('unkeyed');
    expect(keyShort(num, 'Between 40 and 42.')).toBe('unkeyed');
    expect(keyShort(num, 'I do not have that information.')).toBe('wrong');
  });

  test('only short-answer abilities with a date, a number or a name of at most four words are keyed', () => {
    expect(ref('Maria de la Cruz Gomez')).toBeNull();
    expect(ref('Ana de la Cruz')).toMatchObject({ type: 'name' });
    expect(ref('the italian restaurant downtown')).toBeNull();
    expect(ref('Yes')).toBeNull();
    expect(ref('March 15, 2024', 'summarization')).toBeNull();
    expect(ref('March 15, 2024', 'event_ordering')).toBeNull();
    expect(referenceOf({ category: 'abstention', abstention: true, answer: 'No information.' })).toBeNull();
  });
});

describe('bars', () => {
  test('agreement: exactly 90% passes, one under fails, and 300 is the minimum', () => {
    expect(barOf('agreement', 270, 300, BARS.agreement, BARS.agreement_min).status).toBe('pass');
    expect(barOf('agreement', 269, 300, BARS.agreement, BARS.agreement_min).status).toBe('fail');
    expect(barOf('agreement', 299, 299, BARS.agreement, BARS.agreement_min).status).toBe('too_few');
    expect(BARS.agreement_min).toBe(300);
  });
  test('key: exactly 95% passes, one under fails', () => {
    expect(barOf('key', 95, 100, BARS.key, BARS.key_min).status).toBe('pass');
    expect(barOf('key', 94, 100, BARS.key, BARS.key_min).status).toBe('fail');
    expect(barOf('key', 190, 200, BARS.key, BARS.key_min).status).toBe('pass');
    expect(barOf('key', 189, 200, BARS.key, BARS.key_min).status).toBe('fail');
    expect(barOf('key', 10, 10, BARS.key, BARS.key_min, false).status).toBe('not_applied');
  });
});

describe('label and check', () => {
  test('the sheet is blind: answer ids and public text, no system, reader, cell or judge names', async () => {
    const s = stage1();
    const { text, log } = await labeledSheet(s);
    for (const name of ['claude', 'gpt', 'particle', 'gemini', 'haiku', 'opus', 'sol', 'sys-under-test', 'rs1-dev.test']) expect(text.toLowerCase()).not.toContain(name);
    const rows = parseCsv(text);
    expect(rows.filter(r => r.task === 'abstention')).toHaveLength(120);
    expect(rows.filter(r => r.task === 'short')).toHaveLength(100);
    expect(log[0]).toMatch(/^rs1-judge label rows=220 abstention=120 short=100 short_population=360 prefilter=hedge-v3 sheet_sha256=[0-9a-f]{64}$/);
    const design = JSON.parse(readFileSync(join(s.root, 'sheet.csv.design.json'), 'utf8'));
    expect(Object.keys(design.prefilter.verdicts)).toHaveLength(120);
  });

  test('every bar passes on judges that score the truth, and the fallback grades only the keyed and agreement rows', async () => {
    const s = stage1();
    const { sheet } = await labeledSheet(s);
    const r = await check(s, sheet);
    expect(r.code).toBe(0);
    expect(r.result.status).toBe('pass');
    expect(r.result.bars.agreement).toMatchObject({ count: 320, denominator: 320, status: 'pass' });
    expect(r.result.bars.key_validation).toMatchObject({ errors: 0, denominator: 100, status: 'pass' });
    expect(r.result.bars.key.map((b: any) => [b.bar, b.count, b.denominator, b.status])).toEqual([
      [`key:${MINI}`, 320, 320, 'pass'], [`key:${HAIKU}`, 320, 320, 'pass'], ['key:fake-gemini:gemini-3.8-flash', 480, 480, 'pass']]);
    expect(r.result.counts.fallback).toMatchObject({ needed: 640, judged: 640, reused: 0, call_errors: 0, missing: 0 });
    const fallback = readRecords(join(r.dir, 'fallback-judgments.ndjson'), 'judgment');
    expect(new Set(fallback.map(j => j.instrument_id))).toEqual(new Set(['beam-1m@fake-gemini:gemini-3.8-flash']));
    const again = await check(s, sheet);
    expect(again.result.counts.fallback).toMatchObject({ judged: 0, reused: 640 });
  });

  test('family rule: each counted judge is compared with the fallback only on its own planned rows, never its family\'s', async () => {
    const s = stage1();
    const { sheet } = await labeledSheet(s);
    const r = await check(s, sheet);
    const [mini, haiku] = r.result.bars.fallback_agreement;
    expect(mini).toMatchObject({ judge: MINI, denominator: 160 + 320, agree: 480 });
    expect(haiku).toMatchObject({ judge: HAIKU, denominator: 160 + 320, agree: 480 });
    const bad = stage1({ plan: { by_reader: { [OPUS]: [HAIKU], [SOL]: [HAIKU], [PARTICLE]: [MINI, HAIKU] } } });
    const c = capture();
    expect(await main(['label', '--manifest', bad.manifest, '--source', bad.src, '--out', join(bad.root, 'x.csv')], { corpus: bad.corpus, ...c.deps })).toBe(2);
    expect(c.err.join('\n')).toContain('[CAMPAIGN_INVALID]');
    expect(c.err.join('\n')).toContain(`plans ${HAIKU} for ${OPUS}, a reader of its own family`);
    const gpt = stage1({ plan: { by_reader: { [OPUS]: [MINI], [SOL]: [MINI], [PARTICLE]: [MINI, HAIKU] } } });
    const g = capture();
    expect(await main(['label', '--manifest', gpt.manifest, '--source', gpt.src, '--out', join(gpt.root, 'x.csv')], { corpus: gpt.corpus, ...g.deps })).toBe(2);
    expect(g.err.join('\n')).toContain(`plans ${MINI} for ${SOL}, a reader of its own family`);
  });

  test('the fallback never judges a row of its own family', async () => {
    const root = scratch(), src = join(root, 'out');
    const inst = instrumentFor('beam-1m');
    const GEM = 'gemini:gemini-3.8-flash';
    const question = q('1m-20:information_extraction:0', 'information_extraction', 'March 15, 2024');
    const def = cellDef('rs1-dev.gem', { set: 'RS1-dev', block: 'RS1-dry', benchmark: 'beam-1m', split: 'dev', readers: [GEM, OPUS], plan: { by_reader: { [GEM]: [MINI], [OPUS]: [MINI] } } });
    const answers = [answer('rs1-dev.gem.p', question, GEM, 'March 15, 2024'), answer('rs1-dev.gem.p', question, OPUS, 'March 15, 2024')];
    mkdirSync(join(src, 'cells', 'rs1-dev.gem.p'), { recursive: true });
    writeFileSync(join(src, 'cells', 'rs1-dev.gem.p', 'answers.ndjson'), nd(answers));
    writeFileSync(join(src, 'cells', 'rs1-dev.gem.p', 'judgments.ndjson'), nd(answers.map(a => judgment(a, MINI, 1, inst))));
    const rows = collectRows([def as any], [src], { benchmark: 'beam-1m', conversations: [], questions: [question], source: { name: 's', files: [], revision: 't', license: 't' } });
    const log = new RecordLog(join(root, 'fb.ndjson'), 'judgment');
    const run = await runFallback(rows, FALLBACK_JUDGE, client(truth), () => log, 2);
    expect(run).toMatchObject({ judged: 1, skipped_family: 1 });
    expect(log.all().map(j => j.answer_id)).toEqual([answers[1].answer_id]);
  });

  test('exactly 90% agreement passes; one pair under fails with RS1_JUDGE_CHECK_FAIL, exit 3, the result written first and the branch printed', async () => {
    const at = stage1({ flips: 32 });
    expect((await check(at, (await labeledSheet(at)).sheet)).result.bars.agreement).toMatchObject({ count: 288, denominator: 320, status: 'pass' });
    const under = stage1({ flips: 33 });
    const r = await check(under, (await labeledSheet(under)).sheet);
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ status: 'fail', failed: ['agreement'], next: PREREG_BRANCH });
    expect(r.result.bars.agreement).toMatchObject({ count: 287, denominator: 320, status: 'fail' });
    const err = r.err.join('\n');
    expect(err).toContain('[RS1_JUDGE_CHECK_FAIL]');
    expect(err).toContain('agreement 287 of 320 (bar 90%)');
    expect(err).toContain('gemini:gemini-3.8-flash judges every row');
    expect(existsSync(join(r.dir, 'judge-check.json'))).toBe(true);
    expect(r.logs).toContain(PREREG_BRANCH);
  });

  test('the fallback at exactly 95% on the key passes; one keyed answer under fails its bar', async () => {
    const wrongOn = (n: number) => { let k = 0; return client(t => (t.includes('March 15, 2024') && k++ < n ? 0 : truth(t))); };
    const at = stage1();
    const ok = await check(at, (await labeledSheet(at)).sheet, { client: wrongOn(24) });
    expect(ok.result.bars.key.find((b: any) => b.bar.startsWith('key:fake-gemini'))).toMatchObject({ count: 456, denominator: 480, status: 'pass' });
    expect(ok.code).toBe(0);
    const under = stage1();
    const bad = await check(under, (await labeledSheet(under)).sheet, { client: wrongOn(25) });
    expect(bad.result.bars.key.find((b: any) => b.bar.startsWith('key:fake-gemini'))).toMatchObject({ count: 455, denominator: 480, status: 'fail' });
    expect(bad.code).toBe(3);
    expect(bad.result.failed).toEqual(['key:fake-gemini:gemini-3.8-flash']);
    expect(bad.err.join('\n')).toContain('key:fake-gemini:gemini-3.8-flash 455 of 480 (bar 95%)');
  });

  test('under 300 scored pairs is RS1_JUDGE_CHECK_TOO_FEW, not a failure', async () => {
    const s = stage1({ questions: 299 });
    const r = await check(s, (await labeledSheet(s)).sheet);
    expect(r.code).toBe(3);
    expect(r.err.join('\n')).toContain('[RS1_JUDGE_CHECK_TOO_FEW]');
    expect(r.err.join('\n')).toContain('agreement has 299, needs 300');
    expect(r.err.join('\n')).not.toContain('RS1_JUDGE_CHECK_FAIL');
    expect(r.result.status).toBe('too_few');
  });

  test('a key that disagrees with the hand labels blocks the key bars without sending the program to the fallback branch', async () => {
    const s = stage1();
    const { sheet } = await labeledSheet(s);
    const rows = parseCsv(readFileSync(sheet, 'utf8'));
    let flipped = 0;
    writeFileSync(sheet, toCsv(SHEET_HEADER, rows.map(r => (r.task === 'short' && flipped++ < 3 ? { ...r, label: r.label === 'correct' ? 'incorrect' : 'correct' } : r))));
    const r = await check(s, sheet);
    expect(r.code).toBe(3);
    expect(r.result.status).toBe('key_invalid');
    expect(r.result.bars.key.every((b: any) => b.status === 'not_applied')).toBe(true);
    expect(r.err.join('\n')).toContain('[RS1_JUDGE_CHECK_KEY_INVALID]');
    expect(r.result.next).toBeNull();
  });
});

describe('sensitivity', () => {
  function counted() {
    const root = scratch(), src = join(root, 'custody', 'out');
    const inst = instrumentFor('beam-rs1');
    const questions = RS1_CONVERSATIONS.map(c => q(`${c}:information_extraction:0`, 'information_extraction', 'SEALED-SENTINEL-reference', c));
    const def = cellDef('rs1.test', { set: 'RS1', block: 'RS1-8k', benchmark: 'beam-rs1', split: 'sealed' });
    const answers = questions.flatMap(question => [OPUS, SOL, PARTICLE].map(reader => answer('rs1.test.p', question, reader, `SEALED-SENTINEL-answer ${question.id}`)));
    mkdirSync(join(src, 'cells', 'rs1.test.p'), { recursive: true });
    writeFileSync(join(src, 'cells', 'rs1.test.p', 'answers.ndjson'), nd(answers));
    writeFileSync(join(src, 'cells', 'rs1.test.p', 'judgments.ndjson'), nd(answers.flatMap(a => (PLAN.by_reader as Record<string, string[]>)[a.reader].map(j => judgment(a, j, 1, inst)))));
    const manifest = join(root, 'rs1-cells.json');
    writeFileSync(manifest, JSON.stringify({ cells: [def] }));
    return { root, src, manifest, corpus: { benchmark: 'beam-rs1', conversations: RS1_CONVERSATIONS.map(id => ({ id, sessions: [] })), questions, source: { name: 's', files: [], revision: 't', license: 't' } } as Corpus };
  }

  test('the seeded sample is 23 of 75 conversations by sha256("rs1-sensitivity", NUL, id)', () => {
    const sample = sensitivitySample(RS1_CONVERSATIONS);
    expect(sample).toHaveLength(23);
    const expected = [...RS1_CONVERSATIONS].sort((a, b) => (sha256(`rs1-sensitivity\u0000${a}`) < sha256(`rs1-sensitivity\u0000${b}`) ? -1 : 1)).slice(0, 23).sort();
    expect(sample).toEqual(expected);
  });

  test('grades every counted Opus and Sol answer in the sample beside the cell, and stdout carries counts and hashes only', async () => {
    const s = counted();
    const c = capture();
    const env = { GBRAIN_EVALS_CUSTODY_LOG: join(s.root, 'custody', 'access.log') };
    const code = await main(['sensitivity', '--manifest', s.manifest, '--source', s.src, '--paid'], { corpus: s.corpus, client: client(() => 1), env, ...c.deps });
    expect(code).toBe(0);
    const recs = readRecords(join(s.src, 'cells', 'rs1.test.p', 'sensitivity-judgments.ndjson'), 'judgment');
    expect(recs).toHaveLength(46);
    expect(new Set(recs.map(j => j.instrument_id))).toEqual(new Set(['beam-rs1@gemini:gemini-3.8-flash']));
    const answers = readRecords(join(s.src, 'cells', 'rs1.test.p', 'answers.ndjson'), 'answer');
    const sample = new Set(sensitivitySample(RS1_CONVERSATIONS));
    const judged = new Set(recs.map(j => j.answer_id));
    expect(answers.filter(a => judged.has(a.answer_id)).every(a => sample.has(a.conversation) && (a.reader === OPUS || a.reader === SOL))).toBe(true);
    const printed = [...c.out, ...c.err].join('\n');
    expect(printed).toContain('sample=23');
    expect(printed).toContain('answers=46 judged=46');
    expect(printed).not.toContain('SEALED-SENTINEL');
    expect(printed).not.toMatch(/rs1-0\d\d/);
    expect(printed).not.toContain('rs1.test');
  });

  test('refuses outside custody', async () => {
    const s = counted();
    const c = capture();
    expect(await main(['sensitivity', '--manifest', s.manifest, '--source', s.src, '--fake'], { corpus: s.corpus, client: client(() => 1), env: {}, ...c.deps })).toBe(3);
    expect(c.err.join('\n')).toContain('[CUSTODY_REQUIRED]');
    expect(existsSync(join(s.src, 'cells', 'rs1.test.p', 'sensitivity-judgments.ndjson'))).toBe(false);
  });
});

test('kind ids, never product names', () => {
  expect(countNames(readFileSync(join(import.meta.dir, '../../eval/runner/rs1/judge.ts'), 'utf8'))).toBe(0);
});
