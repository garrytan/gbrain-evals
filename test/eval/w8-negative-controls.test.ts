/**
 * W8: model flags and negative-control arms for Cat 14, 29 and 35, and the
 * OpenAI judge shim. Hermetic.
 */
import { describe, expect, test } from 'bun:test';
import { degradeProbes, loadProbes } from '../../eval/runner/cat14-calibration.ts';
import { optionsFromEnv as cat29Options } from '../../eval/runner/cat29-think-vs-search.ts';
import { firstHalf, unrelatedDonors } from '../../eval/runner/cat35-transcript-distill.ts';
import { acceptsTemperature, anthropicModelId, isOpenAIModel, judgeClientFor, judgeTransport, openAIMessagesShim } from '../../eval/runner/openai-judge-shim.ts';

describe('cat14 profile arms', () => {
  const probes = loadProbes();

  test('real leaves probes untouched', () => {
    expect(degradeProbes(probes, 'real')).toBe(probes);
  });

  test('none seeds an empty profile but keeps the real one for the judge', () => {
    const d = degradeProbes(probes, 'none');
    for (const [i, p] of d.entries()) {
      expect(p.seed_profile!.active_bias_tags).toEqual([]);
      expect(p.seed_profile!.pattern_statements).toEqual([]);
      expect(p.brain_setup.calibration_profile).toEqual(probes[i]!.brain_setup.calibration_profile);
    }
  });

  test('swap30 replaces ceil(30%) of each non-empty profile with facts from other probes, deterministically', () => {
    const d = degradeProbes(probes, 'swap30');
    expect(degradeProbes(probes, 'swap30')).toEqual(d);
    for (const [i, p] of d.entries()) {
      const real = probes[i]!.brain_setup.calibration_profile;
      const facts = [...real.active_bias_tags, ...real.pattern_statements];
      const seeded = [...p.seed_profile!.active_bias_tags, ...p.seed_profile!.pattern_statements];
      expect(seeded.length).toBe(facts.length);
      const changed = seeded.filter(f => !facts.includes(f)).length;
      if (facts.length > 0) expect(changed).toBeLessThanOrEqual(Math.ceil(facts.length * 0.3));
      expect(p.brain_setup.calibration_profile).toEqual(real);
    }
    expect(d.some((p, i) => JSON.stringify(p.seed_profile) !== JSON.stringify(probes[i]!.brain_setup.calibration_profile))).toBe(true);
  });
});

describe('cat29 flags', () => {
  test('--model, --judge-model and --embed-mode parse; a bad mode is refused', () => {
    const o = cat29Options(['--model', 'anthropic:claude-sonnet-5-5', '--judge-model', 'openai:gpt-6.1-sol', '--embed-mode', 'hash']);
    expect(o).toMatchObject({ model: 'anthropic:claude-sonnet-5-5', judgeModel: 'openai:gpt-6.1-sol', embedMode: 'hash' });
    expect(() => cat29Options(['--embed-mode', 'zero'])).toThrow(/real or hash/);
    expect(cat29Options([]).model).toBeUndefined();
  });
});

describe('cat35 control inputs', () => {
  test('every donor comes from another scenario', () => {
    const ids = [
      { id: 'a-01', scenario: 'a' }, { id: 'a-02', scenario: 'a' }, { id: 'b-01', scenario: 'b' }, { id: 'b-02', scenario: 'b' },
    ];
    const donors = unrelatedDonors(ids);
    for (const f of ids) expect(ids.find(x => x.id === donors.get(f.id))!.scenario).not.toBe(f.scenario);
    expect(() => unrelatedDonors([{ id: 'a-01', scenario: 'a' }, { id: 'a-02', scenario: 'a' }])).toThrow(/no donor/);
  });

  test('firstHalf cuts at a line break near the middle', () => {
    const t = 'line one\nline two\nline three\nline four\n';
    const h = firstHalf(t);
    expect(h.endsWith('\n')).toBe(true);
    expect(t.startsWith(h)).toBe(true);
    expect(h.length).toBeLessThanOrEqual(t.length / 2 + 1);
    expect(firstHalf('no breaks at all here')).toBe('no breaks ');
  });
});

describe('openai judge shim', () => {
  test('model routing helpers', () => {
    expect(isOpenAIModel('openai:gpt-6.1-sol')).toBe(true);
    expect(isOpenAIModel('gpt-6-luna')).toBe(true);
    expect(isOpenAIModel('claude-haiku-4-5-20251001')).toBe(false);
    expect(anthropicModelId('anthropic:claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    const anth = { tag: 'anthropic' };
    expect(judgeClientFor('claude-sonnet-5-5', () => anth)).toBe(anth);
    expect(judgeClientFor('openai:gpt-6.1-sol', () => anth)).not.toBe(anth);
    expect(judgeTransport('openai:gpt-6.1-sol')).toMatch(/Responses API/);
    expect(judgeTransport('claude-sonnet-5-5')).toBe('Anthropic Messages API');
  });

  test('temperature is sent only to models that accept it', () => {
    expect(acceptsTemperature('claude-sonnet-4-6')).toBe(true);
    expect(acceptsTemperature('claude-haiku-4-5-20251001')).toBe(true);
    expect(acceptsTemperature('anthropic:claude-sonnet-5-5')).toBe(false);
    expect(acceptsTemperature('claude-fable-5-1')).toBe(false);
    expect(acceptsTemperature('openai:gpt-6.1-sol')).toBe(false);
  });

  test('maps a forced tool to a json_schema format and returns a tool_use block', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'r1', model: 'gpt-6.1-sol', status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] }], usage: { input_tokens: 5, output_tokens: 3 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const shim = openAIMessagesShim({ apiKey: 'k', fetchImpl });
    const res = await shim.messages.create({ model: 'openai:gpt-6.1-sol', max_tokens: 700, temperature: 0, system: [{ type: 'text', text: 'sys' }],
      messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 't' } } as never) as unknown as { content: Array<{ type: string; input?: unknown }>; stop_reason: string; usage: unknown };
    expect(sent).toMatchObject({ model: 'gpt-6.1-sol', instructions: 'sys', input: [{ role: 'user', content: 'hi' }], max_output_tokens: 8000, reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 't', schema: { type: 'object' } } } });
    expect(sent).not.toHaveProperty('temperature');
    expect(res.content[0]).toMatchObject({ type: 'tool_use', input: { a: 1 } });
    expect(res.stop_reason).toBe('tool_use');
    expect(res.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
  });

  test('an incomplete reply comes back as max_tokens text; an HTTP error throws with its status', async () => {
    const incomplete = openAIMessagesShim({ apiKey: 'k', fetchImpl: (async () => new Response(JSON.stringify({ status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":' }] }] }), { status: 200 })) as unknown as typeof fetch });
    const r = await incomplete.messages.create({ model: 'gpt-6.1-sol', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], tools: [{ name: 't', input_schema: {} }], tool_choice: { type: 'tool', name: 't' } } as never) as unknown as { content: Array<{ type: string }>; stop_reason: string };
    expect(r.stop_reason).toBe('max_tokens');
    expect(r.content[0]!.type).toBe('text');
    const failing = openAIMessagesShim({ apiKey: 'k', fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 429 })) as unknown as typeof fetch });
    await expect(failing.messages.create({ model: 'gpt-6.1-sol', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] } as never)).rejects.toMatchObject({ status: 429 });
  });
});
