import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
