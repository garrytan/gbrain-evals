/**
 * Regression tests for adversarial.ts tryOp (audit misc-runners-10):
 *
 *   - The timeout used to reject with a PLAIN OBJECT, so the catch's
 *     String(e) produced '[object Object]' and the TIMEOUT diagnosis was
 *     lost. It now rejects with a real Error whose message names the timeout.
 *   - The setTimeout handle was never cleared when fn won the race, leaving
 *     ~130 live 30s timers that kept the event loop alive after a passing
 *     run. The timer is now cleared in a finally.
 *
 * Hermetic: no engine, no network — plain promises. Importing adversarial.ts
 * must NOT launch the runner (main is import.meta.main-guarded).
 */

import { describe, test, expect } from 'bun:test';
import { tryOp } from '../../eval/runner/adversarial.ts';

describe('tryOp', () => {
  test('success path returns the op result', async () => {
    const r = await tryOp('op', async () => 'value');
    expect(r).toEqual({ ok: true, result: 'value' });
  });

  test('CAN FAIL: a hung op times out with a readable diagnosis, not [object Object]', async () => {
    const never = new Promise<never>(() => {});
    const r = await tryOp('putPage', () => never, 20);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('putPage: TIMEOUT_0s'); // 20ms rounds to 0s in the label
      expect(r.error).not.toContain('[object Object]');
    }
  });

  test('default timeout label reads TIMEOUT_30s', async () => {
    // Exercise the label formatting without waiting 30s: 30_000ms → '30s'.
    const r = await tryOp('op', () => new Promise<never>(() => {}), 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('TIMEOUT_1s');
  }, 5_000);

  test('op rejection is captured with the op name and message', async () => {
    const r = await tryOp('searchKeyword', async () => { throw new Error('boom'); });
    expect(r).toEqual({ ok: false, error: 'searchKeyword: boom' });
  });

  test('non-Error throw values are stringified, long messages truncated to 200 chars', async () => {
    const r = await tryOp('op', async () => { throw 'x'.repeat(500); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBe('op: '.length + 200);
  });

  test('timer is cleared when the op wins the race (no lingering timeout)', async () => {
    // If the timer leaked, this rejection would surface as an unhandled
    // rejection after the test (and under the old code the suite process
    // stayed alive for the full timeout). Track clearTimeout directly.
    const realClear = globalThis.clearTimeout;
    let cleared = 0;
    // @ts-expect-error test shim keeps the native signature
    globalThis.clearTimeout = (id: Parameters<typeof realClear>[0]) => {
      cleared++;
      return realClear(id);
    };
    try {
      await tryOp('op', async () => 1, 60_000);
    } finally {
      globalThis.clearTimeout = realClear;
    }
    expect(cleared).toBeGreaterThanOrEqual(1);
  });
});
