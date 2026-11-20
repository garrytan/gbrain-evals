/**
 * The LongMemEval plain-hybrid baseline runner (README baselines): the verbatim probe text and one question's
 * retrieval row, with a keyless deterministic embedder (no network, no provider).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PG_EMBED_DIMS } from '../../eval/runner/cat40/pg-arm.ts';
import type { Conversation, MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { eachConcurrently, RETRIEVE_K, runQuestion, verbatimProbe } from '../../eval/runner/lme-plain-hybrid.ts';
import { PlainHybridSystem } from '../../eval/runner/systems/baselines.ts';
import { Sanitizer } from '../../eval/runner/systems/sanitize.ts';

const fakeEmbed = async (texts: string[]) => texts.map(t => {
  const h = createHash('sha256').update(t).digest();
  return Array.from({ length: PG_EMBED_DIMS }, (_, i) => (h[i % 32] - 128) / 128);
});

describe('verbatimProbe', () => {
  test('takes the first 300 characters of the longest turn, wherever it starts', () => {
    const long = 'x'.repeat(900) + 'tail';
    expect(verbatimProbe({ source_id: 's', turns: [{ role: 'user', speaker: 'user', content: 'short' }, { role: 'assistant', speaker: 'assistant', content: 'y'.repeat(2000) }, { role: 'user', speaker: 'user', content: long }] })).toBe('y'.repeat(300));
    expect(verbatimProbe({ source_id: 's', turns: [{ role: 'user', speaker: 'user', content: '   ' }] })).toBeNull();
  });
});

describe('runQuestion', () => {
  test('ranks dataset session ids, scores recall, finds the probe target and empties the namespace', async () => {
    const conv: Conversation = { id: 'q1', sessions: [
      { id: 'answer_a', date: '2023/05/02 (Tue) 10:00', turns: [{ speaker: 'user', content: 'My martini ratio is three to one with citrus bitters.' }] },
      { id: 'noise_b', date: '2023/05/03 (Wed) 10:00', turns: [{ speaker: 'user', content: 'I walked the dog in the park today and fed the ducks.' }] },
      { id: 'noise_c', date: '2023/05/01 (Mon) 10:00', turns: [{ speaker: 'user', content: 'Planning a scuba trip to Bonaire, any dive shops?' }, { speaker: 'assistant', content: 'Bonaire has many shore dives and friendly dive shops along the coast.' }] },
    ] };
    const q: MemoryQuestion = { id: 'q1', conversation: 'q1', question: 'martini ratio with citrus bitters', question_date: '2023/05/30 (Tue) 10:00', category: 'single-session-user', gold: ['answer_a'], abstention: false, answer: '3:1' };
    const sanitizer = new Sanitizer({ conversations: [conv], questions: [q] }, 'test');
    const system = new PlainHybridSystem(fakeEmbed);
    try {
      const row = await runQuestion(system, sanitizer, conv, q);
      expect(RETRIEVE_K).toBe(50);
      expect(row.question_top.map(x => x.id).sort()).toEqual(['answer_a', 'noise_b', 'noise_c']);
      expect(row.question_top[0]).toEqual({ id: 'answer_a', index: 0 });
      expect([row.recall_all_at5, row.recall_any_at10]).toEqual([1, 1]);
      expect(row.probe).toMatchObject({ target: 'noise_b', target_index: 1, rank: 1 });
      const after = await system.retrieve(sanitizer.ns('q1'), { text: 'martini', query_time: null }, { name: 'x', mode: 'fixed-evidence', settings: { k: 5 } });
      expect(after.items).toEqual([]);
    } finally { await system.close(); }
  });

  test('a probe whose full-text query fails is a miss on the probe, and the question still scores', async () => {
    const dashes = Array.from({ length: 80 }, () => '-').join(' ');
    const conv: Conversation = { id: 'q2', sessions: [
      { id: 'answer_a', date: '2023/05/02 (Tue) 10:00', turns: [{ speaker: 'user', content: 'My martini ratio is three to one.' }] },
      { id: 'last_b', date: '2023/05/03 (Wed) 10:00', turns: [{ speaker: 'user', content: `a table ${dashes} end` }] },
    ] };
    const q: MemoryQuestion = { id: 'q2', conversation: 'q2', question: 'martini ratio', question_date: '2023/05/30 (Tue) 10:00', category: 'single-session-user', gold: ['answer_a'], abstention: false, answer: '3:1' };
    const sanitizer = new Sanitizer({ conversations: [conv], questions: [q] }, 'test');
    const system = new PlainHybridSystem(fakeEmbed);
    const real = system.retrieve.bind(system);
    system.retrieve = async (ns, pq, policy) => { if (pq.text.includes('- -')) throw new Error('tsquery stack too small'); return real(ns, pq, policy); };
    try {
      const row = await runQuestion(system, sanitizer, conv, q);
      expect(row.error).toBeUndefined();
      expect(row.recall_all_at5).toBe(1);
      expect(row.probe).toMatchObject({ target: 'last_b', rank: null, top: [], error: 'tsquery stack too small' });
    } finally { await system.close(); }
  });

  test('any other probe failure fails the question, so a rerun retries it', async () => {
    const conv: Conversation = { id: 'q3', sessions: [
      { id: 'answer_a', date: '2023/05/02 (Tue) 10:00', turns: [{ speaker: 'user', content: 'My martini ratio is three to one.' }] },
      { id: 'last_b', date: '2023/05/03 (Wed) 10:00', turns: [{ speaker: 'user', content: 'a table with a long description of the garden shed' }] },
    ] };
    const q: MemoryQuestion = { id: 'q3', conversation: 'q3', question: 'martini ratio', question_date: '2023/05/30 (Tue) 10:00', category: 'single-session-user', gold: ['answer_a'], abstention: false, answer: '3:1' };
    const sanitizer = new Sanitizer({ conversations: [conv], questions: [q] }, 'test');
    const system = new PlainHybridSystem(fakeEmbed);
    const real = system.retrieve.bind(system);
    system.retrieve = async (ns, pq, policy) => { if (pq.text.includes('garden shed')) throw new Error('embedding request failed: ECONNRESET'); return real(ns, pq, policy); };
    try {
      await expect(runQuestion(system, sanitizer, conv, q)).rejects.toThrow(/ECONNRESET/);
    } finally { await system.close(); }
  });
});

describe('eachConcurrently', () => {
  test('takes items in order and finishes them all, each worker closing what it opened', async () => {
    const seen: number[] = [];
    let opened = 0, closed = 0;
    await eachConcurrently([1, 2, 3, 4, 5], 2, () => ++opened, async (_w, x) => { await Bun.sleep(1); seen.push(x); }, async () => { closed++; });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect([opened, closed]).toEqual([2, 2]);
  });

  test('an item error stops every worker taking another and rejects only after every worker has closed', async () => {
    let open = 0, startedAfterFailure = 0, failed = false;
    const run = eachConcurrently(Array.from({ length: 20 }, (_, i) => i + 1), 3, () => { open++; }, async (_w, x) => {
      if (failed) startedAfterFailure++;
      await Bun.sleep(5);
      if (x === 2) { failed = true; throw new Error('budget exceeded'); }
    }, async () => { await Bun.sleep(20); open--; });
    await expect(run).rejects.toThrow('budget exceeded');
    expect(open).toBe(0);
    expect(startedAfterFailure).toBe(0);
  });
});
