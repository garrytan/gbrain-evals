import { describe, expect, test } from 'bun:test';
import { runAgent, type Arm, type ToolSpec } from '../../eval/runner/cat40/loop.ts';

/** An arm whose tool list grows when the model calls request_tools, the way an advertised MCP surface reveals tools. */
function revealingArm(): Arm {
  let revealed = false;
  let version = 0;
  const spec = (name: string): ToolSpec => ({ name, description: name, input_schema: { type: 'object', properties: {} } });
  return {
    name: 'gbrain',
    systemHint: () => '',
    tools: () => revealed ? [spec('recall'), spec('request_tools'), spec('put_page')] : [spec('recall'), spec('request_tools')],
    toolsVersion: () => version,
    writeTools: () => ['put_page'],
    call: async (name) => { if (name === 'request_tools' && !revealed) { revealed = true; version++; } return 'ok'; },
  };
}

function scriptedProvider(steps: Array<{ name: string; input: Record<string, unknown> }>, seen: string[][]) {
  let i = 0;
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const anthropic = url.includes('anthropic');
    seen.push((body.tools as Array<{ name: string }>).map(t => t.name));
    const step = steps[i++]!;
    const payload = anthropic
      ? { content: [{ type: 'tool_use', id: `t${i}`, name: step.name, input: step.input }], usage: { input_tokens: 1, output_tokens: 1 } }
      : { id: `r${i}`, output: [{ type: 'function_call', call_id: `c${i}`, name: step.name, arguments: JSON.stringify(step.input) }], usage: { input_tokens: 1, output_tokens: 1 } };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('agent loop resends tools after the arm reveals more', () => {
  for (const model of ['claude-sonnet-5-5', 'gpt-6.1-sol']) {
    test(model, async () => {
      const seen: string[][] = [];
      const steps = [{ name: 'request_tools', input: { tools: ['put_page'] } }, { name: 'put_page', input: {} }, { name: 'submit_answer', input: { answer: 'x' } }];
      const run = await runAgent({ model, system: 's', user: 'u', arm: revealingArm(), fetchImpl: scriptedProvider(steps, seen) });
      expect(run.stop).toBe('submitted');
      expect(seen[0]).not.toContain('put_page');
      expect(seen[1]).toContain('put_page');
      expect(run.tools.map(t => t.name)).toEqual(['request_tools', 'put_page']);
    });
  }
});
