/**
 * Every OpenAI request the Cat 40 agent loop sends is stateless: `store: false`, encrypted reasoning items, and the whole
 * conversation resent each turn. On 2026-11-14 the OpenAI organization behind the eval key began enforcing Zero Data
 * Retention, which refuses `previous_response_id` with HTTP 400, and every gpt-6.1-sol agent row of that night's nightly
 * check failed on it. Keyless: a scripted fetch answers every request.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { priceRequest, UNKNOWN_CHAIN_CONTEXT_TOKENS } from '../../eval/runner/budget-ledger.ts';
import { runAgent, type Arm } from '../../eval/runner/cat40/loop.ts';

const ROOT = join(import.meta.dir, '../..');
const URL_ = 'https://api.openai.com/v1/responses';
const ENCRYPTED = 'e'.repeat(6000);
const TURNS: unknown[][] = [
  [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: ENCRYPTED }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"key":"a"}' }],
  [{ type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'output_text', text: 'The value is known.' }] }],
  [{ type: 'function_call', id: 'fc_3', call_id: 'call_3', name: 'submit_answer', arguments: '{"answer":"42","sources":[]}' }],
];
const ARM: Arm = {
  name: 't', systemHint: () => '', writeTools: () => [], call: async () => 'value of a',
  tools: () => [{ name: 'lookup', description: 'Look up.', input_schema: { type: 'object', properties: { key: { type: 'string' } } } }],
};

async function bodiesOf(cfg: { effort?: string }): Promise<Array<Record<string, any>>> {
  const bodies: Array<Record<string, any>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `resp_${bodies.length}`, status: 'completed', output: TURNS[bodies.length - 1], usage: { input_tokens: 10, output_tokens: 5 } });
  }) as unknown as typeof fetch;
  const run = await runAgent({ model: 'gpt-6.1-sol', system: 's', user: 'u', arm: ARM, fetchImpl, ...cfg });
  expect(run.stop).toBe('submitted');
  return bodies;
}

describe('OpenAI requests from the agent loop work under Zero Data Retention', () => {
  test('no request carries previous_response_id or store true, with or without an effort, and each resends the whole conversation', async () => {
    for (const cfg of [{}, { effort: 'medium' }]) {
      const bodies = await bodiesOf(cfg);
      expect(bodies).toHaveLength(3);
      for (const b of bodies) {
        expect('previous_response_id' in b).toBe(false);
        expect(b.store).toBe(false);
        expect(b.include).toEqual(['reasoning.encrypted_content']);
      }
      expect(bodies.map(b => b.input.map((i: any) => i.type ?? i.role))).toEqual([
        ['user'],
        ['user', 'reasoning', 'function_call', 'function_call_output'],
        ['user', 'reasoning', 'function_call', 'function_call_output', 'message', 'user'],
      ]);
    }
  });

  test('the ledger reserves a resent turn by its whole input, encrypted reasoning included, with no chain context', async () => {
    const bodies = await bodiesOf({ effort: 'medium' });
    const [first, , last] = bodies.map(b => priceRequest(URL_, b)!);
    expect(last!.inputTokens - first!.inputTokens).toBeGreaterThanOrEqual(ENCRYPTED.length / 3);
    expect(priceRequest(URL_, { ...bodies[2], previous_response_id: 'resp_2' })!.inputTokens - last!.inputTokens).toBe(UNKNOWN_CHAIN_CONTEXT_TOKENS);
  });

  test('no source under eval/ or scripts/ sends previous_response_id or store true', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'data') walk(p); continue; }
        if (!/\.(ts|js|mjs)$/.test(e.name)) continue;
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/previous_response_id['"]?\s*:|\bstore['"]?\s*:\s*true\b/.test(line)) hits.push(`${relative(ROOT, p)}:${i + 1}`);
        });
      }
    };
    for (const d of ['eval', 'scripts']) walk(join(ROOT, d));
    expect(hits).toEqual([]);
  });
});
