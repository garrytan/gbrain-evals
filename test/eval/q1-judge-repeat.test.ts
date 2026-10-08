/**
 * Judge-only repeats and the shared answer/judgment records (Q1 PLAN §4.4).
 * Keyless: a scripted judge client stands in for the provider.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, runJudgeRepeat, summarizeRepeats } from '../../eval/runner/judge-repeat.ts';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { INSTRUMENTS } from '../../eval/runner/memory-qa/instruments.ts';
import { READER_TEMPLATE, chatCacheKey, judgeAnswer, type ChatLike, type ChatOptions } from '../../eval/runner/memory-qa/qa.ts';
import { answerId, answerProblems, judgmentProblems, rawSha256, readRecords, RecordLog, type AnswerRecord } from '../../eval/runner/memory-qa/records.ts';
import { NATIVE_READER_TEMPLATE } from '../../eval/runner/systems/render.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'q1-judge-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const lme = INSTRUMENTS['lme-s'];
const JUDGE = lme.canonical_judge;
const questions = new Map<string, MemoryQuestion>([
  ['q1', { id: 'q1', conversation: 'q1', question: 'Where did I park?', category: 'single-session-user', gold: ['s1'], abstention: false, answer: 'Level 3' }],
  ['q2', { id: 'q2', conversation: 'q2', question: 'How many days?', category: 'temporal-reasoning', gold: ['s2'], abstention: false, answer: '18' }],
  ['q3_abs', { id: 'q3_abs', conversation: 'q3_abs', question: 'What is my cat called?', category: 'single-session-user', gold: [], abstention: true, answer: 'No cat was mentioned.' }],
]);

function answer(question_id: string, reader: string, text: string, extra: Partial<AnswerRecord> = {}): AnswerRecord {
  const cell_id = 'cell-lme-s-gbrain-defaults-8k';
  return { answer_id: answerId(cell_id, question_id, reader, 0), cell_id, realization_id: 'real-1', question_id, conversation: question_id, system: 'gbrain-defaults', arm: '8k', reader,
    replicate: 0, effort: 'medium', context_sha256: 'a'.repeat(64), text, usage: { input: 900, output: 120, cache_read: 0, cache_write: 0 }, provider_input_tokens: 905, latency_ms: 1200, outcome: 'scored', ...extra };
}
const answers = [answer('q1', 'anthropic:claude-sonnet-5-5', 'It was level 3.'), answer('q2', 'anthropic:claude-sonnet-5-5', 'About 19 days.'), answer('q3_abs', 'openai:gpt-6.1-sol', 'You never mentioned a cat.'),
  answer('q1', 'openai:gpt-6.1-sol', '', { outcome: 'retrieval_error' })];

/** Scripted judge: yes, except q2 flips to no on every third replicate; records every call. */
class ScriptedJudge implements ChatLike {
  calls: Array<{ model: string; prompt: string; opts: ChatOptions }> = [];
  constructor(private failAfter = Infinity, private reply?: (prompt: string, opts: ChatOptions) => string) {}
  async chat(model: string, prompt: string, opts: ChatOptions) {
    if (this.calls.length >= this.failAfter) throw Object.assign(new Error('openai 503: upstream unavailable'), { status: 503 });
    this.calls.push({ model, prompt, opts });
    const text = this.reply ? this.reply(prompt, opts) : prompt.includes('How many days?') && opts.replicate % 3 === 2 ? 'no' : 'yes';
    return { text, input_tokens: 10, output_tokens: 1, cached: false, finish: null, usage: null, response_model: null, attempt_errors: [] as string[] };
  }
}

describe('judge-repeat', () => {
  test('judges fixed answers only: zero reader calls, one judge call per answer and replicate, distinct cache keys', async () => {
    const d = tmp();
    const client = new ScriptedJudge();
    const r = await runJudgeRepeat({ answers, questions, instrument: lme, judge: JUDGE, replicates: [0, 1, 2, 3, 4], log: new RecordLog(join(d, 'j.ndjson'), 'judgment'), client, concurrency: 3 });
    expect(r).toMatchObject({ judged: 15, skipped_existing: 0, judge_errors: 0, not_judged: 1, failed: [] });
    expect(client.calls.length).toBe(15);
    expect(client.calls.every(c => c.model === JUDGE)).toBe(true);
    const readerPrefixes = [READER_TEMPLATE.slice(0, 60), NATIVE_READER_TEMPLATE.slice(0, 60)];
    expect(client.calls.some(c => readerPrefixes.some(p => c.prompt.startsWith(p)))).toBe(false);
    expect(client.calls.some(c => answers.some(a => c.model === a.reader))).toBe(false);
    expect(new Set(client.calls.map(c => chatCacheKey(c.model, c.prompt, c.opts))).size).toBe(15);
    expect(client.calls.every(c => c.opts.temperature === 0)).toBe(true);
    const js = readRecords(join(d, 'j.ndjson'), 'judgment');
    expect(js.every(j => j.instrument_sha256 === lme.sha256 && j.raw_sha256 === rawSha256(j.raw!))).toBe(true);
  });

  test('a partial-repeat restart judges only what is missing and never duplicates a record', async () => {
    const d = tmp();
    const path = join(d, 'j.ndjson');
    const crashing = new ScriptedJudge(7);
    const first = await runJudgeRepeat({ answers, questions, instrument: lme, judge: JUDGE, replicates: [0, 1, 2, 3], log: new RecordLog(path, 'judgment'), client: crashing, concurrency: 1 });
    expect(first.judged).toBe(7);
    expect(first.failed.length).toBe(5);
    appendFileSync(path, '{"answer_id":"torn');
    const healthy = new ScriptedJudge();
    const second = await runJudgeRepeat({ answers, questions, instrument: lme, judge: JUDGE, replicates: [0, 1, 2, 3], log: new RecordLog(path, 'judgment'), client: healthy, concurrency: 2 });
    expect(second).toMatchObject({ judged: 5, skipped_existing: 7, failed: [] });
    expect(healthy.calls.length).toBe(5);
    const js = readRecords(path, 'judgment');
    expect(js.length).toBe(12);
    expect(new Set(js.map(j => `${j.answer_id}|${j.judge_replicate}`)).size).toBe(12);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  test('summary: per-answer SD, verdict flips and per-replicate group means', async () => {
    const d = tmp();
    const path = join(d, 'j.ndjson');
    await runJudgeRepeat({ answers, questions, instrument: lme, judge: JUDGE, replicates: [0, 1, 2, 3, 4, 5], log: new RecordLog(path, 'judgment'), client: new ScriptedJudge() });
    const s = summarizeRepeats(answers, readRecords(path, 'judgment'), lme, JUDGE);
    expect(s.replicates).toEqual([0, 1, 2, 3, 4, 5]);
    expect(s.answers).toBe(3);
    expect(s.answers_with_flip).toBe(1);
    const q2 = s.per_answer.find(p => p.question_id === 'q2')!;
    expect(q2.scores).toEqual([1, 1, 0, 1, 1, 0]);
    expect(q2.sd).toBeCloseTo(Math.sqrt((4 * (1 / 3) ** 2 + 2 * (2 / 3) ** 2) / 5), 12);
    expect(s.judge_sd_max).toBeCloseTo(q2.sd!, 12);
    expect(s.per_replicate[2].groups['gbrain-defaults|8k|anthropic:claude-sonnet-5-5']).toEqual({ mean: 0.5, n: 2 });
    expect(s.per_replicate[0].groups['gbrain-defaults|8k|openai:gpt-6.1-sol']).toEqual({ mean: 1, n: 1 });
  });

  test('a malformed judgment is retried as a fresh call, then recorded as a judge failure with no score', async () => {
    const empty = new ScriptedJudge(Infinity, () => '');
    const j = await judgeAnswer(empty, lme, questions.get('q1')!, 'It was level 3.', { judgeReplicate: 4, maxAttempts: 3 });
    expect(j).toMatchObject({ outcome: 'judge_error', score: null, parse_ok: false, judge_replicate: 4 });
    expect(empty.calls.map(c => c.opts.attempt ?? 0)).toEqual([0, 1, 2]);
    expect(new Set(empty.calls.map(c => chatCacheKey(c.model, c.prompt, c.opts))).size).toBe(3);
    const recovering = new ScriptedJudge(Infinity, (_p, o) => o.attempt ? 'Yes.' : 'The model response correctly identifies the');
    expect(await judgeAnswer(recovering, lme, questions.get('q1')!, 'x', { judgeReplicate: 0 })).toMatchObject({ outcome: 'scored', score: 1, raw: ['Yes.'] });
  });

  test('a judge that takes only its default temperature is sent none and recorded as null', async () => {
    const c = new ScriptedJudge();
    const j = await judgeAnswer(c, lme, questions.get('q1')!, 'x', { judge: 'openai:gpt-6.1-sol', judgeReplicate: 1 });
    expect(j.temperature).toBeNull();
    expect(c.calls[0].opts.temperature).toBeNull();
    expect(chatCacheKey('openai:gpt-6.1-sol', 'p', { maxTokens: 10, replicate: 0, temperature: null })).not.toBe(chatCacheKey('openai:gpt-6.1-sol', 'p', { maxTokens: 10, replicate: 0, temperature: 0 }));
  });

  test('CLI: summary costs nothing; a run without its arguments refuses with an operator message', async () => {
    const d = tmp();
    const ap = join(d, 'answers.ndjson'), jp = join(d, 'j.ndjson');
    writeFileSync(ap, answers.map(a => JSON.stringify(a)).join('\n') + '\n');
    await runJudgeRepeat({ answers, questions, instrument: lme, judge: JUDGE, replicates: [0, 1], log: new RecordLog(jp, 'judgment'), client: new ScriptedJudge() });
    const sp = join(d, 'summary.json');
    expect(await main(['summary', '--answers', ap, '--judgments', jp, '--benchmark', 'lme-s', '--summary', sp, '--json'])).toBe(0);
    expect(JSON.parse(readFileSync(sp, 'utf8'))).toMatchObject({ kind: 'q1-judge-repeat-summary', replicates: [0, 1], answers: 3 });
    const err: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string) => { err.push(s); return true; };
    try { expect(await main(['run', '--answers', ap, '--benchmark', 'lme-s', '--json'])).toBe(2); }
    finally { (process.stderr as { write: unknown }).write = write; }
    const op = JSON.parse(err.join(''));
    expect(op.code).toBe('SPEC_INVALID');
    expect(op.fix.next).toBe('run');
    expect(op.fix.argv.slice(0, 3)).toEqual(['bun', 'eval/runner/judge-repeat.ts', 'run']);
  });
});

describe('answer and judgment records', () => {
  test('answer ids are sha256 of cell|question|reader|replicate, and a mismatched id is refused', () => {
    expect(answers[0].answer_id).toBe(new Bun.CryptoHasher('sha256').update('cell-lme-s-gbrain-defaults-8k|q1|anthropic:claude-sonnet-5-5|0').digest('hex'));
    expect(answerProblems(answers[0])).toEqual([]);
    expect(answerProblems({ ...answers[0], replicate: 1 })).toContain('answer.answer_id is not sha256(cell_id|question_id|reader|replicate)');
  });

  test('records are immutable: an identical append is a no-op, a different one under the same key throws', () => {
    const d = tmp();
    const log = new RecordLog(join(d, 'a.ndjson'), 'answer');
    expect(log.append(answers[0])).toBe('appended');
    expect(log.append(answers[0])).toBe('exists');
    expect(() => log.append({ ...answers[0], text: 'changed' })).toThrow(/immutable/);
    expect(() => log.append({ ...answers[1], usage: { input: 1 } as never })).toThrow(/invalid answer/);
  });

  test('full answer text survives byte for byte, Unicode included', () => {
    const d = tmp();
    const text = '答案🙂 '.repeat(200_000) + '\u2028end';
    const log = new RecordLog(join(d, 'a.ndjson'), 'answer');
    log.append(answer('q1', 'r', text));
    expect(readRecords(join(d, 'a.ndjson'), 'answer')[0].text).toBe(text);
  });

  test('a failed judgment is never a "no": judge_error needs a null score, scored needs a score', () => {
    const base = { answer_id: answers[0].answer_id, instrument_id: 'lme-s', instrument_sha256: lme.sha256, judge: JUDGE, judge_replicate: 0, temperature: 0, raw_sha256: rawSha256([]) };
    expect(judgmentProblems({ ...base, score: 0, parse_ok: false, outcome: 'judge_error' })).toContain('judgment: a failed judgment has a null score, never a "no"');
    expect(judgmentProblems({ ...base, score: null, parse_ok: true, outcome: 'scored' })).toContain('judgment: a scored judgment needs a score and parse_ok');
    expect(judgmentProblems({ ...base, score: null, parse_ok: false, outcome: 'judge_error' })).toEqual([]);
  });

  test('a corrupt line that is not the torn tail is an error naming its line', () => {
    const d = tmp();
    const p = join(d, 'a.ndjson');
    writeFileSync(p, `${JSON.stringify(answers[0])}\nnot json\n${JSON.stringify(answers[1])}\n`);
    expect(() => readRecords(p, 'answer')).toThrow(/:2: not JSON/);
  });
});
