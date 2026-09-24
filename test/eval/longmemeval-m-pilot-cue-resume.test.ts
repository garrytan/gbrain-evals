import { describe, expect, test } from 'bun:test';
import { runPilotBoundedCueBuild } from '../../eval/runner/longmemeval-m-pilot-build.ts';

describe('pre-registered durable C1 construction resume', () => {
  const run = async (results: Array<{ status: string; reason?: string; windowsProcessed: number }>, uncertainAt = -1) => {
    let calls = 0;
    const records: Array<{ status: string; windowsProcessed: number; reason?: string; attemptAtWindow: number }> = [];
    const action = runPilotBoundedCueBuild({
      run: async () => results[calls++] ?? { status: 'not_claimed', windowsProcessed: 0 },
      assertCertain: async () => { if (calls === uncertainAt) throw new Error('financial accounting uncertain'); },
      record: async (item, attemptAtWindow) => { records.push({ ...item, attemptAtWindow }); },
    });
    return { action, records, get calls() { return calls; } };
  };

  test.each(['invalid_output', 'unsupported_cue', 'unsupported_relation', 'incomplete_output'])(
    '%s permits only two extra same-window public build attempts', async reason => {
      const sequence = await run([{ status: 'failed', reason, windowsProcessed: 32 },
        { status: 'failed', reason, windowsProcessed: 0 }, { status: 'complete', windowsProcessed: 1 }]);
      await expect(sequence.action).resolves.toBeUndefined();
      expect(sequence.calls).toBe(3);
      expect(sequence.records.map(item => item.attemptAtWindow)).toEqual([1, 2, 0]);
      const exhausted = await run([{ status: 'failed', reason, windowsProcessed: 0 },
        { status: 'failed', reason, windowsProcessed: 0 }, { status: 'failed', reason, windowsProcessed: 0 },
        { status: 'complete', windowsProcessed: 1 }]);
      await expect(exhausted.action).rejects.toThrow('incomplete');
      expect(exhausted.calls).toBe(3);
      expect(exhausted.records.map(item => item.attemptAtWindow)).toEqual([1, 2, 3]);
    });

  test('advancing to a new failed window resets only the consecutive same-window count', async () => {
    const state = await run([{ status: 'failed', reason: 'unsupported_cue', windowsProcessed: 0 },
      { status: 'failed', reason: 'unsupported_cue', windowsProcessed: 3 },
      { status: 'failed', reason: 'unsupported_cue', windowsProcessed: 0 },
      { status: 'complete', windowsProcessed: 1 }]);
    await expect(state.action).resolves.toBeUndefined();
    expect(state.records.map(item => item.attemptAtWindow)).toEqual([1, 1, 2, 0]);
  });

  test.each(['provider_failed', 'budget_exhausted', 'source_changed', 'provider_rate_limited', 'not_claimed'])(
    '%s never resumes', async reason => {
      const state = await run([{ status: reason === 'not_claimed' ? reason : 'failed', reason, windowsProcessed: 0 },
        { status: 'complete', windowsProcessed: 1 }]);
      await expect(state.action).rejects.toThrow('incomplete');
      expect(state.calls).toBe(1);
    });

  test('uncertain financial accounting blocks an otherwise allowed retry', async () => {
    const state = await run([{ status: 'failed', reason: 'unsupported_cue', windowsProcessed: 32 },
      { status: 'complete', windowsProcessed: 1 }], 1);
    await expect(state.action).rejects.toThrow('financial accounting uncertain');
    expect(state.calls).toBe(1);
    expect(state.records).toHaveLength(1);
  });

  test('partial with no progress is incomplete, while normal progress continues', async () => {
    const stalled = await run([{ status: 'partial', windowsProcessed: 0 }, { status: 'complete', windowsProcessed: 1 }]);
    await expect(stalled.action).rejects.toThrow('incomplete');
    expect(stalled.calls).toBe(1);
    const advanced = await run([{ status: 'partial', windowsProcessed: 8 }, { status: 'complete', windowsProcessed: 2 }]);
    await expect(advanced.action).resolves.toBeUndefined();
    expect(advanced.calls).toBe(2);
  });
});
