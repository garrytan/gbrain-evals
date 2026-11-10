import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTurnLog, GbrainArm, type GbrainSlot } from '../../eval/runner/cat40/gbrain-arm.ts';
import { runAgent } from '../../eval/runner/cat40/loop.ts';

/** A slot whose MCP client answers every call with the tool's name; `newSession` swaps in a fresh client, as a restart does. */
function fakeSlot() {
  const client = () => ({
    tools: ['search', 'search_exact'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })),
    toolsVersion: 0, instructions: '', call: async (name: string) => `${name} ok`,
  });
  const slot = { id: 'slot3', client: client(), newSession() { slot.client = client(); } };
  return slot as unknown as GbrainSlot & { newSession(): void };
}

/** Each turn's tool calls, in each provider's wire format; the last turn submits. */
function provider(turns: string[][]) {
  let i = 0;
  return (async (url: string) => {
    const names = [...turns[i++]!];
    const anthropic = url.includes('anthropic');
    const payload = anthropic
      ? { content: names.map((name, k) => ({ type: 'tool_use', id: `t${i}-${k}`, name, input: name === 'submit_answer' ? { answer: 'x', sources: [] } : {} })), usage: { input_tokens: 1, output_tokens: 1 } }
      : { id: `r${i}`, output: names.map((name, k) => ({ type: 'function_call', call_id: `c${i}-${k}`, name, arguments: name === 'submit_answer' ? '{"answer":"x","sources":[]}' : '{}' })), usage: { input_tokens: 1, output_tokens: 1 } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
}

const turns = [['search', 'search_exact'], ['search'], ['submit_answer']];
const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { slot: string; turn: number; tool: string; at: string });

afterEach(() => { callTurnLog.path = null; });

describe('--gbrain-call-turns records the turn of each gbrain tool call', () => {
  for (const model of ['claude-opus-5-5', 'gpt-6.1-sol']) {
    test(model, async () => {
      callTurnLog.path = join(mkdtempSync(join(tmpdir(), 'call-turns-')), 'gbrain-call-turns.jsonl');
      const slot = fakeSlot();
      const arm = new GbrainArm(slot);
      const run = await runAgent({ model, system: 's', user: 'u', arm, fetchImpl: provider(turns) });
      expect(run.stop).toBe('submitted');
      expect(run.turns).toBe(3);
      expect(lines(callTurnLog.path).map(l => [l.slot, l.turn, l.tool])).toEqual([['slot3', 1, 'search'], ['slot3', 1, 'search_exact'], ['slot3', 2, 'search']]);
      // A second session on a restarted server counts its turns from 1 again.
      slot.newSession();
      await runAgent({ model, system: 's', user: 'u', arm, fetchImpl: provider([['search_exact'], ['submit_answer']]) });
      expect(lines(callTurnLog.path).slice(3).map(l => [l.turn, l.tool])).toEqual([[1, 'search_exact']]);
    });
  }

  test('off by default: nothing is written and the run is the same', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'call-turns-off-'));
    expect(callTurnLog.path).toBeNull();
    const off = await runAgent({ model: 'claude-opus-5-5', system: 's', user: 'u', arm: new GbrainArm(fakeSlot()), fetchImpl: provider(turns) });
    callTurnLog.path = join(dir, 'on.jsonl');
    const on = await runAgent({ model: 'claude-opus-5-5', system: 's', user: 'u', arm: new GbrainArm(fakeSlot()), fetchImpl: provider(turns) });
    const strip = (r: typeof off) => ({ stop: r.stop, turns: r.turns, tools: r.tools.map(t => [t.name, t.result]) });
    expect(strip(on)).toEqual(strip(off));
    expect(existsSync(join(dir, 'gbrain-call-turns.jsonl'))).toBe(false);
  });
});
