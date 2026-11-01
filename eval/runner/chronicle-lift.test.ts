import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { corpusDigest, matchPage, pairedBootstrap, renderCorpus, scoreAnswer, type Extracted, type GoldEvent, type QuestionDoc } from './chronicle-lift.ts';

const ev = (day: string, what: string): Extracted => ({ slug: `life/events/${day}-x`, depth: 'meetings/m', day, what, kind: 'event', who: [] });
const gold = (id: string, day: string, keywords: string[]): GoldEvent => ({ id, day, kind: 'meeting', keywords, basis: '' });

describe('matchPage', () => {
  test('needs the same day and a keyword', () => {
    expect(matchPage([gold('a', '2026-04-14', ['Elena'])], [ev('2026-04-14', 'Met elena about Meridian')])).toEqual([[0, 0]]);
    expect(matchPage([gold('a', '2026-04-14', ['Elena'])], [ev('2026-04-15', 'Met Elena')])).toEqual([]);
    expect(matchPage([gold('a', '2026-04-14', ['Elena'])], [ev('2026-04-14', 'Met Priya')])).toEqual([]);
  });
  test('is a maximum matching, one extracted event per expected event', () => {
    const g = [gold('a', '2026-04-18', ['Priya', 'CarbonLoop']), gold('b', '2026-04-18', ['bridge'])];
    const e = [ev('2026-04-18', 'Priya approved the bridge extension'), ev('2026-04-18', 'CarbonLoop review with Priya')];
    expect(matchPage(g, e).length).toBe(2);
    expect(matchPage(g, [e[0]]).length).toBe(1);
  });
});

describe('scoreAnswer', () => {
  const doc = JSON.parse(readFileSync(join(import.meta.dir, '../data/chronicle-lift-v1/questions.json'), 'utf8')) as QuestionDoc;
  const q = (id: string) => doc.questions.find(x => x.id === id)!;
  const c = doc.contacts_first_names;
  test('dates need exactly the gold date', () => {
    expect(scoreAnswer(q('when-1'), { answer: '2026-04-16', sources: [] }, c)).toBe(true);
    expect(scoreAnswer(q('when-1'), { answer: '2026-04-16 or 2026-04-17', sources: [] }, c)).toBe(false);
    expect(scoreAnswer(q('when-1'), null, c)).toBe(false);
  });
  test('names need the exact set of contacts', () => {
    expect(scoreAnswer(q('day-2'), { answer: 'Diego, Ravi, Tomoko', sources: [] }, c)).toBe(true);
    expect(scoreAnswer(q('day-2'), { answer: 'Diego, Ravi, Tomoko, Amara', sources: [] }, c)).toBe(true);
    expect(scoreAnswer(q('day-2'), { answer: 'Diego, Ravi', sources: [] }, c)).toBe(false);
    expect(scoreAnswer(q('day-2'), { answer: 'Diego, Ravi, Tomoko, Priya', sources: [] }, c)).toBe(false);
  });
  test('traps need UNKNOWN and no date', () => {
    expect(scoreAnswer(q('trap-1'), { answer: 'UNKNOWN', sources: [], notes: 'scheduled for May 15' }, c)).toBe(true);
    expect(scoreAnswer(q('trap-1'), { answer: '2026-05-15', sources: [] }, c)).toBe(false);
    expect(scoreAnswer(q('trap-1'), { answer: 'UNKNOWN (planned 2026-05-15)', sources: [] }, c)).toBe(false);
  });
  test('keywords read the answer and notes', () => {
    expect(scoreAnswer(q('decision-4'), { answer: 'Q3', sources: [] }, c)).toBe(true);
    expect(scoreAnswer(q('decision-5'), { answer: 'They agreed to hold off', sources: [] }, c)).toBe(true);
    expect(scoreAnswer(q('decision-6'), { answer: 'extension terms', sources: [], notes: 'the bridge extension' }, c)).toBe(true);
  });
});

describe('pairedBootstrap', () => {
  test('a constant difference has a degenerate interval', () => {
    const r = pairedBootstrap([0, 0, 1, 1], [1, 1, 1, 1], 2000);
    expect(r.diff).toBe(0.5);
    expect(r.lo).toBeGreaterThanOrEqual(0);
    expect(r.hi).toBeLessThanOrEqual(1);
  });
  test('no difference gives zero', () => {
    expect(pairedBootstrap([1, 0, 1], [1, 0, 1], 500)).toEqual({ diff: 0, lo: 0, hi: 0 });
  });
});

describe('renderCorpus', () => {
  test('renders the frozen amara-life-v1 world deterministically', () => {
    const pages = renderCorpus();
    expect(pages.length).toBe(144);
    expect(pages.filter(p => /^(meetings|cal|conversations)\//.test(p.path)).length).toBe(48);
    expect(corpusDigest(pages)).toBe('1f7df155a5776e498d5439f67cb8dbe1785dc32479ab58c684340af368508625');
  });
});

describe('sampleIndices', () => {
  test('draws distinct indices deterministically', async () => {
    const { sampleIndices } = await import('./chronicle-lift.ts');
    const a = sampleIndices(60, 25, 4);
    expect(a).toEqual(sampleIndices(60, 25, 4));
    expect(new Set(a).size).toBe(25);
    expect(sampleIndices(10, 25, 4).length).toBe(10);
  });
});

describe('agent answer identity (#236)', () => {
  const doc = JSON.parse(readFileSync(join(import.meta.dir, '../data/chronicle-lift-v1/questions.json'), 'utf8')) as QuestionDoc;
  const right = (q: QuestionDoc['questions'][number]) => ({
    answer: q.answer_kind === 'date' ? q.gold as string : q.answer_kind === 'unknown' ? 'UNKNOWN'
      : q.answer_kind === 'names' ? (q.gold as string[]).join(', ') : (q.gold as string[][]).map(g => g[0]).join(' '),
    sources: [],
  });
  const row = (arm: string, q: QuestionDoc['questions'][number], repeat: number, model: string, correct: boolean, extra: Record<string, unknown> = {}) =>
    ({ key: `${arm}|${q.id}|${repeat}`, arm, question: q.id, type: q.type, repeat, correct, final: correct ? right(q) : null, wrote: false, run: { model, usd: 0, stop: 'submitted' }, ...extra });
  const score = (rows: unknown[], ...args: string[]) => {
    const out = mkdtempSync(join(tmpdir(), 'lift-score-'));
    writeFileSync(join(out, 'qa-results.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const r = spawnSync('bun', [join(import.meta.dir, 'chronicle-lift.ts'), 'score', '--out', out, ...args], { encoding: 'utf8' });
    const scores = existsSync(join(out, 'scores.json')) ? JSON.parse(readFileSync(join(out, 'scores.json'), 'utf8')) : null;
    rmSync(out, { recursive: true, force: true });
    return { code: r.status, stderr: r.stderr, error: r.stderr.split('\n').find(l => l.startsWith('error: ')) ?? '', qa: scores?.qa ?? null };
  };
  // The reviewer's keyless repro: the off arm answered by Sonnet 4.6, the on arm resumed under the Sonnet 5.5 default.
  const mixed = doc.questions.flatMap(q => [row('off', q, 1, 'claude-sonnet-4-6', false), row('on-a', q, 1, 'claude-sonnet-5-5', true)]);

  test('score refuses to pool answers from two agent models into one lift', () => {
    const r = score(mixed);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('claude-sonnet-4-6');
    expect(r.stderr).toContain('claude-sonnet-5-5');
    expect(r.error).toContain('Pass --model');
    expect(r.qa).toBeNull();
  });

  test('two answer identities of one model are refused without offering --model, which cannot separate them', () => {
    const identity = { model: 'claude-sonnet-5-5', max_turns: 12, gbrain: '0.60.531.0', questions: 'q' };
    const rows = doc.questions.flatMap(q => [row('off', q, 1, 'claude-sonnet-5-5', true), row('on-a', q, 1, 'claude-sonnet-5-5', true, { identity, brain: 'b' })]);
    const r = score(rows, '--model', 'claude-sonnet-5-5');
    expect(r.code).not.toBe(0);
    expect(r.qa).toBeNull();
    expect(r.error).toContain('2 answer identities');
    expect(r.error).not.toContain('--model');
  });

  test('score --model keeps one model\'s answers, so the false +100 pp lift disappears', () => {
    const r = score(mixed, '--model', 'claude-sonnet-5-5');
    expect(r.code).toBe(0);
    expect(r.qa.questions).toBe(0);
    expect(r.qa.lift).toBeNull();
    expect(r.qa.identity.model).toBe('claude-sonnet-5-5');
    expect(r.qa.excluded_runs).toBe(doc.questions.length);
  });

  test('score refuses answers from two builds of the same arm brain', () => {
    const identity = { model: 'claude-sonnet-5-5', max_turns: 12, gbrain: '0.60.531.0', questions: 'q' };
    const rows = doc.questions.flatMap(q => [row('off', q, 1, 'claude-sonnet-5-5', true, { identity, brain: 'b-off' }), row('on-a', q, 1, 'claude-sonnet-5-5', true, { identity, brain: q.id === 'when-1' ? 'b-on-old' : 'b-on-new' })]);
    const r = score(rows);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('on-a');
    const same = score(doc.questions.flatMap(q => [row('off', q, 1, 'claude-sonnet-5-5', false, { identity, brain: 'b-off' }), row('on-a', q, 1, 'claude-sonnet-5-5', true, { identity, brain: 'b-on' })]));
    expect(same.code).toBe(0);
    expect(same.qa.lift.diff).toBe(1);
  });

  test('the resume key changes with the model, the turn cap, the gbrain under test, the questions and the brain', async () => {
    const { qaKey } = await import('./chronicle-lift.ts');
    const identity = { model: 'claude-sonnet-5-5', max_turns: 12, gbrain: '0.60.531.0', questions: 'q' };
    const base = qaKey('off', 'when-1', 1, identity, 'brain-1');
    expect(qaKey('off', 'when-1', 1, { ...identity }, 'brain-1')).toBe(base);
    for (const changed of [qaKey('off', 'when-1', 1, { ...identity, model: 'claude-sonnet-4-6' }, 'brain-1'), qaKey('off', 'when-1', 1, { ...identity, max_turns: 8 }, 'brain-1'),
      qaKey('off', 'when-1', 1, { ...identity, gbrain: 'overlay 5a44025' }, 'brain-1'), qaKey('off', 'when-1', 1, { ...identity, questions: 'other' }, 'brain-1'), qaKey('off', 'when-1', 1, identity, 'brain-2')]) {
      expect(changed).not.toBe(base);
    }
    // A row written before the identity existed never counts as done.
    expect(base).not.toBe('off|when-1|1');
  });
});
