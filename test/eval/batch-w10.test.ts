/**
 * W10 arm definitions and the W8 LongMemEval control's injections, built from
 * committed receipts only (no dataset, no network).
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.W10_STATE_DIR = join(tmpdir(), `w10-test-${process.pid}`);
const { ARMS, r1, subsets, swapDonors, topGoldSession, types, CAPS } = await import('../../eval/runner/batch/w10.ts');
const { refuseReaderFetch } = await import('../../eval/runner/batch/w10a-capture.ts');
const { parseSessionBlocks } = await import('../../eval/runner/batch/sources.ts');

describe('W10 arms', () => {
  test('replay arms build one body per question with the preregistered model and limit', () => {
    const notes = ARMS['w10b-sonnet55-notes'].build();
    expect(notes.bodies.size).toBe(500);
    const b = notes.bodies.get('a06e4cfe') as any;
    expect([b.model, b.max_tokens, b.output_config.effort]).toEqual(['claude-sonnet-5-5', 4096, 'low']);
    const fable = ARMS['w10b-fable51-notes'].build();
    expect(fable.bodies.size).toBe(200);
    expect((fable.bodies.values().next().value as any).max_tokens).toBe(2048);
    expect(ARMS['w10b-sol-notes'].build().bodies.get('a06e4cfe')).toMatchObject({ model: 'gpt-6.1-sol', reasoning_effort: 'medium', max_completion_tokens: 12000 });
    expect(ARMS['w10b-sonnet55-direct'].build().protocol.name).toBe('gbrain-lme-reader-v3-abstention-fullsessions');
    expect(CAPS).toEqual({ W10a: 28, W10b: 107, W10c: 50, 'W8-LME': 5 });
  });

  test('subsets are seeded, sized as preregistered, and W8 draws only answerable questions', () => {
    expect(subsets.fable200()).toEqual(subsets.fable200());
    expect(subsets.w10c150().length).toBe(150);
    const w8 = subsets.w8100();
    expect(w8.length).toBe(100);
    expect(w8.some(id => id.endsWith('_abs'))).toBe(false);
    const t = types();
    expect(new Set(subsets.w10c150().map(id => t.get(id))).size).toBe(7);
  });
});

describe('W8 LongMemEval control injections', () => {
  test('swap donors never carry the question\'s answer sessions or answer text', () => {
    const rows = r1();
    const ids = subsets.w8100();
    const donors = swapDonors(ids, rows);
    expect(donors.size).toBe(100);
    for (const [id, donorId] of donors) {
      expect(donorId).not.toBe(id);
      const q = rows.get(id)!, d = rows.get(donorId)!;
      expect(d.retrieved_session_ids.some(s => q.answer_session_ids.includes(s))).toBe(false);
      const answer = String(q.answer).toLowerCase();
      if (answer.length >= 3) expect(d.user.slice(d.user.indexOf('Retrieved sessions:')).toLowerCase().includes(answer)).toBe(false);
    }
    expect(swapDonors(ids, rows)).toEqual(donors);
  });

  test('the partial fault removes exactly the top-ranked gold session the reader saw', () => {
    const built = ARMS['w8-lme-partial'].build();
    const rows = r1();
    let applicable = 0;
    expect(subsets.w8partial50().every(id => subsets.w8100().includes(id))).toBe(true);
    for (const id of subsets.w8partial50()) {
      const gold = topGoldSession(rows.get(id)!);
      if (!gold) { expect(built.bodies.has(id)).toBe(false); continue; }
      applicable++;
      const user = (built.bodies.get(id) as any).messages[0].content as string;
      const before = parseSessionBlocks(rows.get(id)!.user).map(b => b.id);
      expect(parseSessionBlocks(user).map(b => b.id)).toEqual(before.filter(b => b !== gold));
    }
    expect(applicable).toBe(built.bodies.size);
    expect(applicable).toBeGreaterThan(40);
    expect(built.bodies.size).toBeLessThanOrEqual(50);
  });
});

test('the W10a capture refuses any reader call to a provider', async () => {
  const sent: string[] = [];
  const f = refuseReaderFetch((async (u: any) => { sent.push(String(u)); return new Response('{}'); }) as typeof fetch);
  await expect(f('https://api.anthropic.com/v1/messages', { method: 'POST' })).rejects.toThrow(/refused a reader call/);
  await expect(f('https://api.openai.com/v1/chat/completions', { method: 'POST' })).rejects.toThrow(/refused/);
  await f('https://api.openai.com/v1/embeddings', { method: 'POST' });
  await f('https://api.voyageai.com/v1/rerank', { method: 'POST' });
  expect(sent.length).toBe(2);
});
