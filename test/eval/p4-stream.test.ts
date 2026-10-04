import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeTranscript } from '../../eval/runner/p4-stream/transcript.ts';
import { additionalContext } from '../../eval/runner/p4-stream/hooks.ts';
import { ARMS, orderQuestions, priceUsage, sessionTime } from '../../eval/runner/p4-stream/run.ts';
import { pairedStats, requiredN } from '../../eval/runner/p4-stream/analyze.ts';

describe('p4-stream harness pieces', () => {
  test('transcript lines are Claude Code shaped, with usage and a compact boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p4t-'));
    try {
      const t = new ClaudeTranscript(join(dir, 'p', 's.jsonl'), 'sess', dir);
      t.user('hi');
      t.assistant('hello', 'claude-sonnet-5-5', { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 });
      const boundary = t.compactBoundary();
      const lines = readFileSync(t.path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(lines.map(l => l.type)).toEqual(['user', 'assistant', 'system']);
      expect(lines[1].message.usage.cache_read_input_tokens).toBe(3);
      expect(lines[2]).toMatchObject({ subtype: 'compact_boundary', uuid: boundary });
      expect(lines[1].parentUuid).toBe(lines[0].uuid);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('UserPromptSubmit stdout yields its additionalContext', () => {
    expect(additionalContext('noise\n{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"ctx"}}\n')).toBe('ctx');
    expect(additionalContext('')).toBe('');
  });

  test('arms: only C and D mark core; B and D set the simulated window', () => {
    expect(Object.values(ARMS).filter(a => a.core).map(a => a.id)).toEqual(['C', 'D']);
    expect(ARMS.B.config(32000)['memory.pressure.context_window']).toBe('32000');
    expect(ARMS.C.config(32000)['memory.pressure.enabled']).toBe('false');
  });

  test('question order depends on the seed only; LME dates sort chronologically', () => {
    const qs = ['a', 'b', 'c', 'd'].map(id => ({ id }) as never);
    expect(orderQuestions(qs, 42)).toEqual(orderQuestions([...qs].reverse(), 42));
    expect(sessionTime('2023/05/20 (Sat) 02:21')).toBeLessThan(sessionTime('2023/05/21 (Sun) 01:00'));
  });

  test('pricing and power math', () => {
    expect(priceUsage('claude-sonnet-5-5', { input: 1e6, cache_write: 0, cache_read: 0, output: 0 })).toBeCloseTo(2);
    const st = pairedStats([1, 0, 0, -1, 0, 1, 0, 0]);
    expect(st.discordant).toBeCloseTo(3 / 8);
    expect(requiredN(0.4, 0.03)).toBe(1396);
  });
});
