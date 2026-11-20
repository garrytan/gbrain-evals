/**
 * The SOTA loop's LongMemEval support builder (eval/runner/sota/lme-support.ts, W1-b): two invented LongMemEval-shaped
 * items, one with answer sessions and one abstention item, checked for their message numbering, cited ranges and
 * abstention flag, then run through validate.ts's own planner with its keyless fake validators and collected into
 * verdicts. Nothing here reaches a provider.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeClient, validateSet, VALIDATOR_IDS, writeReport } from '../../eval/custody/rs1/validate.ts';
import { build, collect, emptyIndex, itemSet, itemVerdict, selectRecords, type LmeRecord } from '../../eval/runner/sota/lme-support.ts';

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'sota-lme-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const turn = (role: string, content: string, has_answer = false) => ({ role, content, ...(has_answer ? { has_answer } : {}) });

/** Invented items: three sessions each; the first item's answer is in sessions b and c, its has_answer turn in b. */
const TEMPORAL: LmeRecord = {
  question_id: 'fx0001', question_type: 'temporal-reasoning', question: 'How many days passed between the pottery class and the kiln firing?',
  question_date: '2023/04/20 (Thu) 10:00', answer: '7 days',
  answer_session_ids: ['b', 'c'], haystack_session_ids: ['a', 'b', 'c'], haystack_dates: ['2023/04/01 (Sat) 09:00', '2023/04/05 (Wed) 18:30', '2023/04/12 (Wed) 18:30'],
  haystack_sessions: [
    [turn('user', 'Can you suggest a soup recipe?'), turn('assistant', 'Try a lentil soup.')],
    [turn('user', 'I went to my first pottery class today.', true), turn('assistant', 'That sounds fun.'), turn('user', 'The teacher was patient.')],
    [turn('user', 'The kiln firing for my bowl was today, 7 days after the class.'), turn('assistant', 'Congratulations.')],
  ],
};
const ABSTENTION: LmeRecord = {
  question_id: 'fx0002_abs', question_type: 'multi-session', question: 'What colour was my violin?', question_date: '2023/05/01 (Mon) 08:00',
  answer: 'You did not mention a violin.', answer_session_ids: ['y'], haystack_session_ids: ['x', 'y'], haystack_dates: ['2023/04/01 (Sat) 09:00', '2023/04/02 (Sun) 09:00'],
  haystack_sessions: [[turn('user', 'I bought a red guitar.'), turn('assistant', 'Nice.')], [turn('user', 'I practise every morning.'), turn('assistant', 'Good habit.')]],
};

describe('lme-support item sets', () => {
  test('numbers every message, a date line before each session, and cites the answer sessions whole', () => {
    const { chat, slot, item, built } = itemSet(TEMPORAL);
    expect(chat.map(m => m.id)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(chat.filter(m => m.role === 'session').map(m => [m.id, m.content])).toEqual([
      [1, 'Session date: 2023/04/01 (Sat) 09:00'], [4, 'Session date: 2023/04/05 (Wed) 18:30'], [8, 'Session date: 2023/04/12 (Wed) 18:30']]);
    expect(built.answer_sessions).toEqual([[4, 7], [8, 10]]);
    expect(built.has_answer).toEqual([5]);
    expect(chat[4]!.content).toBe('I went to my first pottery class today.');
    expect(item.source_chat_ids).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(built.cited).toBe(7);
    expect(built.abstention).toBe(false);
    expect(slot).toBe('temporal_reasoning#0');
    expect(item.answer).toBe('7 days');
    expect(item.question).toBe('(Asked on 2023/04/20 (Thu) 10:00.) How many days passed between the pottery class and the kiln firing?');
  });

  test('an abstention item cites nothing and takes the abstention slot', () => {
    const { item, slot, built } = itemSet(ABSTENTION);
    expect(built.abstention).toBe(true);
    expect(slot).toBe('abstention#0');
    expect(item.source_chat_ids).toBeUndefined();
    expect(item.ideal_response).toBe('You did not mention a violin.');
    expect(built.cited).toBe(0);
    expect(built.answer_sessions).toEqual([[4, 6]]);
  });

  test('refuses an unknown question type, an answer session outside the haystack and an unknown id', () => {
    expect(() => itemSet({ ...TEMPORAL, question_type: 'mystery' })).toThrow('no slot for question type mystery');
    expect(() => itemSet({ ...TEMPORAL, answer_session_ids: ['b', 'z'] })).toThrow('1 answer sessions are not in the haystack');
    expect(() => selectRecords([TEMPORAL], ['fx0001', 'fx9999'])).toThrow('1 ids are not LongMemEval-S questions');
  });

  test('validate.ts checks both sets with its fake validators, and collect turns the reports into verdicts', async () => {
    const out = scratch();
    const r = build({ records: [TEMPORAL, ABSTENTION], ids: ['fx0001', 'fx0002_abs'], out, beamDir: null });
    expect(r.items.map(i => i.id)).toEqual(['fx0001', 'fx0002_abs']);
    mkdirSync(join(out, 'reports'));
    const clients = VALIDATOR_IDS.map(id => fakeClient(`fake-${id}`));
    for (const i of r.items) {
      const report = await validateSet({ setDir: join(out, 'sets', i.id), beamDir: '', reportPath: '', targetTokens: i.tokens, tolerance: 0.5,
        windowTokens: 60_000, overlapTokens: 2_000, concurrency: 2 }, clients, emptyIndex());
      expect(report.totals.validator_errors).toBe(0);
      writeReport(join(out, 'reports', `${i.id}.json`), report);
    }
    const c = collect(out);
    expect(c.complete).toBe(true);
    const items = c.file.items as Record<string, ReturnType<typeof itemVerdict>>;
    expect(items.fx0001).toEqual({ checked: true, verdicts: { 'fake-gemini:gemini-3.8-flash': 'supported', 'fake-anthropic:claude-haiku-5-5': 'supported' }, gates: [], cited: 7, source: 'sota-w1-validate' });
    expect(items.fx0002_abs!.checked).toBe(true);
    expect(items.fx0002_abs!.cited).toBe(0);
    expect(c.counts).toMatchObject({ items: 2, checked: 2, validator_error: 0, unchecked: 0 });
  });

  test('the fake absence scan flags an abstention item whose haystack answers it, and a missing report leaves an item unchecked', async () => {
    const out = scratch();
    const answered = { ...ABSTENTION, question: 'Which instrument did I buy, the guitar?' };
    const r = build({ records: [answered, TEMPORAL], ids: ['fx0002_abs', 'fx0001'], out, beamDir: null });
    mkdirSync(join(out, 'reports'));
    const i = r.items[0]!;
    const report = await validateSet({ setDir: join(out, 'sets', i.id), beamDir: '', reportPath: '', targetTokens: i.tokens, tolerance: 0.5,
      windowTokens: 60_000, overlapTokens: 2_000, concurrency: 2 }, VALIDATOR_IDS.map(id => fakeClient(`fake-${id}`)), emptyIndex());
    writeReport(join(out, 'reports', `${i.id}.json`), report);
    const c = collect(out);
    const items = c.file.items as Record<string, ReturnType<typeof itemVerdict>>;
    expect(items.fx0002_abs!.gates).toEqual(['absence:fake-anthropic:claude-haiku-5-5', 'absence:fake-gemini:gemini-3.8-flash']);
    expect(Object.values(items.fx0002_abs!.verdicts!)).toEqual(['unsupported', 'unsupported']);
    expect(items.fx0001).toEqual({ checked: false, source: 'sota-w1-validate', reason: 'no validate report' });
    expect(c.complete).toBe(false);
    const built = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'));
    expect(JSON.stringify(built)).not.toContain('guitar');
    writeFileSync(join(out, 'reports', 'fx0001.json'), JSON.stringify({ ...report, conversations: {} }));
    expect((collect(out).file.items as Record<string, { reason?: string }>).fx0001!.reason).toBe('the report has no conversation');
  });
});
