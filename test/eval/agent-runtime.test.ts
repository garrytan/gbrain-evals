/**
 * The agent-runtime answering cell, keyless. Unit tests drive the driver
 * against a recorded host (the stream-json shapes below were captured from
 * the pinned runtime image on 2026-10-06); with AGENT_RUNTIME_KEYLESS=1 the
 * integration test brings up the bundle's sealed compose stack with a
 * scripted fake provider behind its egress relay and answers a fixture
 * question end to end through the real runtime.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DecideError } from '../../eval/runner/decisions/errors.ts';
import { loadFixture } from '../../eval/runner/memory-qa/corpus.ts';
import { AgentRuntimeSystem, cellConfig, openedFiles, parseTranscript, RUNTIME_ALLOWED_TOOLS, RUNTIME_DENIED_TOOLS, runtimeModel, type RuntimeHost, type RuntimeProcess } from '../../eval/runner/systems/agent-runtime.ts';
import { evidenceOpened, layoutSessions } from '../../eval/runner/systems/file-agent.ts';
import { Sanitizer } from '../../eval/runner/systems/sanitize.ts';

const line = (o: unknown) => JSON.stringify(o);
const call = (id: string, name: string, args: unknown) => line({ type: 'message', message_type: 'tool_call_message', tool_call: { name, tool_call_id: id, arguments: JSON.stringify(args) } });
const ret = (id: string, status = 'success') => line({ type: 'message', message_type: 'tool_return_message', status, tool_call_id: id, tool_return: '...' });
const usage = line({ type: 'message', message_type: 'usage_statistics', prompt_tokens: 100, completion_tokens: 10 });
const result = (text: string) => line({ type: 'result', subtype: 'success', result: text, usage: { prompt_tokens: 1200, completion_tokens: 40, cached_input_tokens: 900, cache_write_tokens: 100 } });

function recordingHost(stdout: (cwd: string) => string, extra: Partial<RuntimeProcess> = {}) {
  const seen: { copied: string[]; argv: string[]; cwd: string; removed: string[] } = { copied: [], argv: [], cwd: '', removed: [] };
  const host: RuntimeHost = {
    async copyIn(hostDir, dir) {
      seen.copied = spawnSync('find', [hostDir, '-type', 'f'], { encoding: 'utf8' }).stdout.trim().split('\n').map(p => p.slice(hostDir.length + 1)).sort();
      seen.cwd = dir;
    },
    async run(argv, cwd) { seen.argv = argv; return { code: 0, stdout: stdout(cwd), stderr: '', timed_out: false, ...extra }; },
    async remove(dir) { seen.removed.push(dir); },
  };
  return { host, seen };
}

const corpus = loadFixture();
const san = new Sanitizer(corpus, 'agent-runtime-test');
const conv = corpus.conversations[0];
const ns = san.ns(conv.id);
const q = corpus.questions.find(x => x.id === 'fx-00')!;

async function loaded(host: RuntimeHost, over = {}) {
  const sys = new AgentRuntimeSystem({ host, ...over });
  for (const step of san.ingestPlan(conv)) await sys.ingestSession(ns, step.input, step.event_time);
  return sys;
}

describe('agent-runtime driver (recorded host)', () => {
  const files = layoutSessions(ns, san.ingestPlan(conv).map(s => ({ source_id: s.input.source_id, event_time: s.event_time, turns: s.input.turns })));
  const pathOf = (session: string) => [...files].find(([, f]) => f.source_id === san.source(conv.id, session))![0];

  test('one fresh headless agent per question, sessions as workspace files, the fixed tool policy and the reader as model', async () => {
    const { host, seen } = recordingHost(cwd => [usage, call('c1', 'Read', { file_path: `${cwd}/${pathOf('s2')}` }), ret('c1'), usage, result('The vet visit cost 85 dollars.')].join('\n'));
    const sys = await loaded(host);
    const a = await sys.answer(ns, san.question(q), { reader: 'anthropic:claude-sonnet-5-5', replicate: 0 });
    expect(seen.copied).toEqual([...files.keys()].sort());
    expect(seen.argv.slice(0, 2)).toEqual([cellConfig().cli, '-p']);
    expect(seen.argv[2]).toContain('Question: How much did the vet visit for Pebble cost?');
    for (const flag of ['--new-agent', '--no-skills', '--no-mods', '--output-format']) expect(seen.argv).toContain(flag);
    expect(seen.argv[seen.argv.indexOf('-m') + 1]).toBe('anthropic/claude-sonnet-5-5');
    expect(seen.argv[seen.argv.indexOf('--max-turns') + 1]).toBe('40');
    expect(seen.argv[seen.argv.indexOf('--allowedTools') + 1]).toBe(RUNTIME_ALLOWED_TOOLS.join(','));
    expect(seen.argv[seen.argv.indexOf('--disallowedTools') + 1].split(',')).toEqual(expect.arrayContaining(['Edit', 'Write', 'ApplyPatch', 'Task']));
    expect(RUNTIME_DENIED_TOOLS.some(t => RUNTIME_ALLOWED_TOOLS.includes(t))).toBe(false);
    expect(seen.removed).toEqual([seen.cwd]);
    expect(a).toMatchObject({ text: 'The vet visit cost 85 dollars.', outcome: 'scored', stop_reason: 'submitted', turns: 2, provider_input_tokens: 1200,
      usage: { input: 200, output: 40, cache_read: 900, cache_write: 100 } });
    expect(a.usd).toBeCloseTo((200 * 2 + 900 * 0.2 + 100 * 2.5 + 40 * 10) / 1e6, 12);
    expect(evidenceOpened(a.opened_source_ids, [san.source(conv.id, 's2')])).toEqual({ gold: 1, opened_gold: 1, share: 1 });
    await expect(sys.retrieve()).rejects.toThrow(/no passive memory API/);
  });

  test('GPT readers run on the OpenAI-compatible provider; shell reads count as evidence, denied calls do not', async () => {
    const { host } = recordingHost(() => [
      call('c1', 'exec_command', { cmd: `rg -l vet . && cat ${pathOf('s2')}` }), ret('c1'),
      call('c2', 'Read', { file_path: pathOf('s3') }), ret('c2', 'error'),
      call('c3', 'Bash', { command: `grep -c Pebble ${pathOf('s1')}` }), ret('c3'),
      result('85 dollars'),
    ].join('\n'));
    const sys = await loaded(host);
    const a = await sys.answer(ns, san.question(q), { reader: 'openai:gpt-6.1-sol', replicate: 1 });
    expect(runtimeModel('openai:gpt-6.1-sol')).toBe('openai-compatible/gpt-6.1-sol');
    expect(a.opened_source_ids).toEqual([san.source(conv.id, 's2')]);
  });

  test('stop reasons map to outcomes', async () => {
    const cases: Array<[string, Partial<RuntimeProcess>, string, string]> = [
      [line({ type: 'error', message: 'Maximum turns limit reached (40/40 steps)', stop_reason: 'max_steps' }), {}, 'turn_cap', 'retrieval_error'],
      ['', { timed_out: true }, 'wall_time', 'retrieval_error'],
      [line({ type: 'error', message: 'LLM API error: 529 overloaded' }), {}, 'provider_error', 'reader_error'],
      ['', { stderr: 'Error: No such container' }, 'provider_error', 'reader_error'],
      [line({ type: 'result', subtype: 'success', result: '  ', usage: {} }), {}, 'empty_answer', 'retrieval_error'],
      [line({ type: 'error', message: 'tool loop crashed' }), {}, 'product_error', 'retrieval_error'],
    ];
    for (const [stdout, extra, stop, outcome] of cases) {
      const { host } = recordingHost(() => stdout, extra);
      const a = await (await loaded(host, { timeoutMs: 1000 })).answer(ns, san.question(q), { reader: 'anthropic:claude-opus-5-5', replicate: 0 });
      expect([a.stop_reason, a.outcome, a.text]).toEqual([stop, outcome, '']);
    }
  });

  test('readers outside the proxy providers, or unpriced, are refused with an operator message', async () => {
    const { host } = recordingHost(() => result('x'));
    const sys = await loaded(host);
    for (const reader of ['gemini:gemini-3', 'anthropic:claude-unpriced-9']) {
      const err = await sys.answer(ns, san.question(q), { reader, replicate: 0 }).catch(e => e);
      expect(err).toBeInstanceOf(DecideError);
      expect((err as DecideError).op.code).toBe('SPEC_INVALID');
    }
  });

  test('the transcript parser reads the runtime\'s recorded stream-json', () => {
    const t = parseTranscript([
      line({ type: 'system', subtype: 'init', tools: ['Bash', 'Read'] }), usage,
      line({ type: 'message', message_type: 'stop_reason', stop_reason: 'requires_approval' }),
      call('call_1', 'Read', { file_path: '/workspace/probe/2023/05/08/a.md' }), ret('call_1'), usage,
      line({ type: 'message', message_type: 'stop_reason', stop_reason: 'end_turn' }),
      line({ type: 'result', subtype: 'success', result: 'Pebble', usage: { prompt_tokens: 200, completion_tokens: 20, cached_input_tokens: 0, cache_write_tokens: 0 } }),
    ].join('\n'));
    expect(t).toMatchObject({ text: 'Pebble', stop: 'success', steps: 2, tool_calls: [{ name: 'Read', status: 'success' }] });
    expect(openedFiles(t, '/workspace/probe', new Map([['2023/05/08/a.md', { source_id: 'src-a', content: '' }]]))).toEqual(['src-a']);
  });
});

const KEYLESS = process.env.AGENT_RUNTIME_KEYLESS === '1';
const BUNDLE = join(import.meta.dir, '../../docs/comparison-systems/ext-agent-runtime');

describe.skipIf(!KEYLESS)('agent-runtime answering cell, keyless against the real runtime', () => {
  const port = Number(process.env.FAKE_TOOL_PROVIDER_PORT ?? 8791);
  const requests: Array<{ tools: string[]; roles: string[]; toolText: string }> = [];
  const compose = (args: string[]) => spawnSync('docker', ['compose', ...args], { cwd: BUNDLE, encoding: 'utf8', env: { ...process.env, PROXY_HOSTPORT: `host.docker.internal:${port}` } });
  afterAll(() => { compose(['--profile', 'keyless', 'down', '-v']); });

  test('a scripted model reads the gold session through the runtime\'s own tools and answers', async () => {
    const files = layoutSessions(ns, san.ingestPlan(conv).map(s => ({ source_id: s.input.source_id, event_time: s.event_time, turns: s.input.turns })));
    const gold = [...files].find(([, f]) => f.source_id === san.source(conv.id, 's2'))![0];
    const script = [
      { name: 'Write', arguments: { file_path: 'note.md', content: 'x' } },
      { name: 'Bash', arguments: { command: `cat ${gold}`, description: 'read the session' } },
    ];
    const server = Bun.serve({ port, hostname: '0.0.0.0', async fetch(req) {
      if (req.method === 'GET') return Response.json({ object: 'list', data: [{ id: 'gpt-4.1-mini', object: 'model' }] });
      const body = await req.json() as any;
      const done = (body.messages ?? []).filter((m: any) => m.role === 'tool').length;
      const toolText = (body.messages ?? []).filter((m: any) => m.role === 'tool').map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
      requests.push({ tools: (body.tools ?? []).map((t: any) => t.function?.name), roles: (body.messages ?? []).map((m: any) => m.role), toolText });
      const step = script[done];
      const message = step ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${done}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }
        : { role: 'assistant', content: `From the session: ${toolText.split('\n').find((l: string) => l.includes('vet')) ?? 'not found'}` };
      const chunk = { id: 'x', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: message, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
    try {
      const up = compose(['--profile', 'keyless', 'up', '-d', '--build', '--wait']);
      expect(up.status).toBe(0);
      const sys = await loaded((await import('../../eval/runner/systems/agent-runtime.ts')).dockerHost(), { keyless: true, timeoutMs: 300_000 });
      const a = await sys.answer(ns, san.question(q), { reader: 'openai:gpt-4.1-mini', replicate: 0 });
      expect(a.outcome).toBe('scored');
      expect(a.text).toContain('85 dollars');
      expect(a.opened_source_ids).toEqual([san.source(conv.id, 's2')]);
      expect(requests.length).toBe(3);
      expect(requests[0].tools).toContain('Bash');
      expect(a.usage.output).toBe(30);
      expect(requests[1].toolText).toMatch(/denied|disallowed|not allowed|permission/i);
    } finally {
      server.stop(true);
    }
  }, 900_000);
});
