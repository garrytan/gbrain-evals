/**
 * The README-baseline LongMemEval reader arms (RB-LME): how their prompts pick and order sessions, the committed
 * retrieval they read and the guards on their renderer and budget. No dataset, no network.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.W10_STATE_DIR = join(tmpdir(), `rb-lme-test-${process.pid}`);
const { ARMS, RB_ARMS, budgetRun, parallelFor, rbHybridTop, rbRenderer } = await import('../../eval/runner/batch/w10.ts');
const { fullHistoryText, houseNotesText, parseSessionBlocks } = await import('../../eval/runner/batch/sources.ts');

const q = {
  question_id: 'rbq1', question_type: 'single-session-user', question: 'What ratio did I settle on?', question_date: '2023/05/30 (Tue) 10:00', answer: '3:1',
  answer_session_ids: ['answer_x'], haystack_session_ids: ['s0', 'answer_x', 's2'],
  haystack_dates: ['2023/05/01 (Mon) 10:00', '2023/05/02 (Tue) 10:00', '2023/05/03 (Wed) 10:00'],
  haystack_sessions: [[{ role: 'user', content: 'zero' }], [{ role: 'user', content: 'three to one' }], [{ role: 'user', content: 'two' }]],
};

describe('RB-LME arms', () => {
  test('four arms, Sonnet 5.5 at W10a\'s 3,500 tokens and Opus 5.5 at W10b\'s 4,096', () => {
    expect(RB_ARMS.map(a => a.id)).toEqual(['rb-sonnet55-full', 'rb-sonnet55-hybrid5', 'rb-sonnet55-none', 'rb-opus55-hybrid5']);
    expect(RB_ARMS.map(a => [a.model, a.maxOutputTokens ?? null, a.workstream])).toEqual([
      ['claude-sonnet-5-5', 3500, 'RB-LME'], ['claude-sonnet-5-5', 3500, 'RB-LME'], ['claude-sonnet-5-5', 3500, 'RB-LME'], ['claude-opus-5-5', null, 'RB-LME']]);
    expect(RB_ARMS.every(a => ARMS[a.id] === a)).toBe(true);
  });

  test('the house notes text keeps the given sessions in the given order; null is the whole history, [] none', () => {
    const ids = (indices: number[] | null) => parseSessionBlocks(houseNotesText(q as never, indices).user).map(b => b.date);
    expect(ids([2, 0])).toEqual([q.haystack_dates[2], q.haystack_dates[0]]);
    expect(ids(null)).toEqual(q.haystack_dates);
    expect(houseNotesText(q as never, null)).toEqual(fullHistoryText(q as never));
    const none = houseNotesText(q as never, []);
    expect([none.sessions, parseSessionBlocks(none.user).length]).toEqual([0, 0]);
    expect(none.user.startsWith('Question:\nWhat ratio did I settle on?\n\n')).toBe(true);
    expect(() => houseNotesText(q as never, [7])).toThrow(/no haystack session at index 7/);
  });

  test('plain hybrid top k reads haystack indices in rank order and refuses an incomplete file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-top-'));
    const row = (i: number) => ({ question_id: `q${i}`, question_top: [{ id: 'a', index: 4 }, { id: 'b', index: 1 }, { id: 'c', index: 9 }] });
    writeFileSync(join(dir, 'ok.ndjson'), Array.from({ length: 500 }, (_, i) => JSON.stringify(row(i))).join('\n') + '\n');
    expect(rbHybridTop(2, join(dir, 'ok.ndjson')).get('q7')).toEqual([4, 1]);
    writeFileSync(join(dir, 'short.ndjson'), JSON.stringify(row(0)) + '\n');
    expect(() => rbHybridTop(5, join(dir, 'short.ndjson'))).toThrow(/expected 500 retrieval rows/);
    writeFileSync(join(dir, 'dup.ndjson'), Array.from({ length: 500 }, (_, i) => JSON.stringify(row(i % 499))).join('\n') + '\n');
    expect(() => rbHybridTop(5, join(dir, 'dup.ndjson'))).toThrow(/expected 500 distinct question ids/);
  });

  test('the renderer must be named and at c5fb0201, and the run needs a runaway cap', async () => {
    const saved = process.env.RB_GBRAIN_DIR;
    delete process.env.RB_GBRAIN_DIR;
    try { await expect(rbRenderer()).rejects.toThrow(/set RB_GBRAIN_DIR/); } finally { if (saved !== undefined) process.env.RB_GBRAIN_DIR = saved; }
    expect(() => ARMS['rb-sonnet55-none'].build()).toThrow(/load gbrain c5fb0201's renderers/);
    expect([parallelFor('RB-LME', ['run', 'x', '--parallel']), parallelFor('RB-LME', ['run', 'x']), parallelFor('W10b', ['run', 'x', '--parallel'])]).toEqual([true, false, false]);
    expect(() => budgetRun('RB-LME', join(tmpdir(), `rb-ledger-${process.pid}.sqlite`))).toThrow(/pass --budget-usd/);
  });
});
