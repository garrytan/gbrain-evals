/**
 * GPT-6.1 Sol fills a tool's optional arguments with `""` instead of leaving them out. At gbrain `ca1281a2`
 * (v0.60.542.0) the SkillOpt rollout registry passed them to the handler, so every Sol `get_page` and
 * `get_backlinks` call in the N15 frontier probe failed (docs/benchmarks/2026-11-01-skillopt-method/REPORT.md,
 * "Tool errors in the SkillOpt rollout path"). gbrain v0.60.549.0 (gbrain#8429) drops `""` and `null` optional
 * arguments in the rollout and write-capture registries, then checks the rest against the operation's schema.
 * These tests drive the pinned registries with no provider key, and every one but the corpus check fails at
 * `ca1281a2`. The last replays the probe's recorded Sol calls. gbrain v0.60.553.0 (gbrain#8444) also reads the
 * empty values a parameter's schema rules out (`0`, `[]`, `{}` on read ops, `false`, and `context` without
 * `grep`) as absent, so 30 of the 38 `traverse_graph` calls now read; that replay fails at `a131fb20`. Every
 * recorded `get_page` call still refuses on a non-empty value. gbrain v0.60.557.0 (gbrain#8458) hands the model the
 * error an MCP caller gets for the same refused read (code, message, suggestion and a runnable `fix`), where it used
 * to hand over only the message; the four tests that read a refusal fail at `311a83bbe`. Following each refusal's
 * fix verbatim reads every two- and three-selector `get_page` call. A replay cannot show whether Sol follows it, so
 * only a live Sol rollout shows whether its page reads recover.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRollout, type BenchmarkTask } from 'gbrain/core/skillopt';
import type { ChatResult } from 'gbrain/ai/gateway';
import { loadCorpora } from '../../eval/generators/skillopt-method/common.ts';
import { withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import { readSeed } from '../../eval/runner/skillopt-method/dataset.ts';
import { fakeReply, FRONTIER_TARGETS, openBrain, withProbeGateway, type ChatTransport } from '../../eval/runner/skillopt-method/headroom.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { recordedCalls, withRegistry as withRootRegistry, type Call } from '../../eval/runner/nightly/tool-contract.ts';

const PAGE = 'people/vera-chen-14';
const TASK = { task_id: 'sol-empty-args', task: 'Who is Vera Chen?' } as BenchmarkTask;
const SOL_EMPTY = { known_as_of: '', cursor: '', section: '', grep: '' };
const SOL_NULL = { known_as_of: null, cursor: null, section: null, grep: null, around_chunk_id: null };

/** The pinned SkillOpt registries, through the nightly tool-contract replay's helpers (eval/runner/nightly/tool-contract.ts). */
const PINNED = resolveGbrainUnderTest(null).root;
const withRegistry = <T,>(registry: 'read-only' | 'write-capture', fn: (call: Call) => Promise<T>, tools?: string[]) => withRootRegistry(PINNED, registry, fn, tools);

describe("GPT-6.1 Sol's empty optional arguments in the pinned SkillOpt registries (gbrain#8429)", () => {
  test('the corpus holds the page the calls read', () => {
    expect(loadCorpora().pages.has(PAGE)).toBe(true);
  });

  test('a Sol rollout through the gateway tool loop: get_page and get_backlinks with "" or null optional arguments answer as if they were left out', async () => {
    const transport: ChatTransport = async opts => {
      if (opts.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool-result'))) return fakeReply(opts, 'Vera Chen. [Source: people/vera-chen-14]');
      const blocks = [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'brain_get_page', input: { slug: PAGE, ...SOL_EMPTY } },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'brain_get_page', input: { slug: PAGE, ...SOL_NULL } },
        { type: 'tool-call', toolCallId: 'c3', toolName: 'brain_get_page', input: { slug: PAGE } },
        { type: 'tool-call', toolCallId: 'c4', toolName: 'brain_get_backlinks', input: { slug: PAGE, cursor: '' } },
        { type: 'tool-call', toolCallId: 'c5', toolName: 'brain_get_backlinks', input: { slug: PAGE } },
      ] as ChatResult['blocks'];
      return { ...fakeReply(opts, ''), blocks, stopReason: 'tool_calls' } as ChatResult;
    };
    const t = await withHermeticEnv('n15-sol-empty-args', async () => {
      const engine = await openBrain();
      try {
        return await withProbeGateway({ chatModel: FRONTIER_TARGETS.sol, fake: true, transport, keys: ['OPENAI_API_KEY'] }, () =>
          runRollout({ engine, skillText: readSeed('query'), targetModel: FRONTIER_TARGETS.sol, task: TASK, allowedTools: new Set(['get_page', 'get_backlinks']) }));
      } finally {
        await engine.disconnect().catch(() => {});
      }
    });
    expect(t.tool_calls.map(c => [c.name, !!c.failed])).toEqual([['get_page', false], ['get_page', false], ['get_page', false], ['get_backlinks', false], ['get_backlinks', false]]);
    const [emptyPage, nullPage, plainPage, emptyLinks, plainLinks] = t.tool_calls.map(c => JSON.stringify(c.output));
    expect(plainPage).toContain(PAGE);
    expect(emptyPage).toBe(plainPage);
    expect(nullPage).toBe(plainPage);
    expect(emptyLinks).toBe(plainLinks);
    expect(t.final_text).toContain(PAGE);
  }, 120_000);

  test('a refused read hands the model the error an MCP caller gets: code, message, suggestion and a runnable fix (gbrain#8458)', async () => {
    const seen: unknown[] = [];
    const transport: ChatTransport = async opts => {
      for (const m of opts.messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool-result') seen.push(b);
      if (seen.length) return fakeReply(opts, 'Vera Chen. [Source: people/vera-chen-14]');
      const blocks = [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'brain_get_page', input: { slug: PAGE, lines: { from: 1, count: 150 }, bytes: { offset: 0, length: 20000 } } },
      ] as ChatResult['blocks'];
      return { ...fakeReply(opts, ''), blocks, stopReason: 'tool_calls' } as ChatResult;
    };
    await withHermeticEnv('n15-sol-refusal-seen', async () => {
      const engine = await openBrain();
      try {
        await withProbeGateway({ chatModel: FRONTIER_TARGETS.sol, fake: true, transport, keys: ['OPENAI_API_KEY'] }, () =>
          runRollout({ engine, skillText: readSeed('query'), targetModel: FRONTIER_TARGETS.sol, task: TASK, allowedTools: new Set(['get_page']) }));
      } finally {
        await engine.disconnect().catch(() => {});
      }
    });
    const [result] = seen as Array<{ output: string; isError?: boolean }>;
    expect(result!.isError).toBe(true);
    expect(JSON.parse(result!.output)).toMatchObject({
      code: 'invalid_params',
      message: 'get_page: pass one window selector, not 2 (got lines and bytes).',
      suggestion: expect.stringContaining('Drop `bytes` to read the lines window'),
      fix: { mcp: { tool: 'get_page', arguments: { slug: PAGE, lines: { from: 1, count: 150 }, body: 'window' } } },
    });
  }, 120_000);

  for (const registry of ['read-only', 'write-capture'] as const) {
    test(`${registry} registry: "" and null optional arguments read the page, a non-empty bad value still refuses, and a wrong-typed argument is refused before the handler`, async () => {
      const r = await withHermeticEnv(`n15-sol-empty-args-${registry}`, () => withRegistry(registry, async call => ({
        plain: await call('get_page', { slug: PAGE }),
        empty: await call('get_page', { slug: PAGE, ...SOL_EMPTY }),
        nulls: await call('get_page', { slug: PAGE, ...SOL_NULL }),
        badDate: await call('get_page', { slug: PAGE, known_as_of: 'yesterday' }),
        wrongType: await call('get_page', { slug: PAGE, include_content: 'yes' }),
        links: await call('get_backlinks', { slug: PAGE }),
        emptyCursor: await call('get_backlinks', { slug: PAGE, cursor: '' }),
      })));
      expect('ok' in r.plain).toBe(true);
      expect(r.empty).toEqual(r.plain);
      expect(r.nulls).toEqual(r.plain);
      expect(r.emptyCursor).toEqual(r.links);
      expect(r.badDate).toEqual({ error: expect.objectContaining({ code: 'invalid_params', message: expect.stringContaining('known_as_of must be an ISO 8601 instant') }) });
      expect(r.wrongType).toEqual({ error: expect.objectContaining({ code: 'invalid_params', message: expect.stringContaining('Parameter "include_content" must be a boolean') }) });
    }, 120_000);
  }
});

describe('what gbrain#8429 and gbrain#8444 leave refused, and where gbrain#8458\'s fix leads: the frontier probe\'s recorded Sol calls, replayed', () => {
  const INPUTS = join(import.meta.dir, '../../docs/benchmarks/2026-11-01-skillopt-method/probe/frontier/f0b-sol/one-shot');
  const SLUG: Record<string, string> = { get_page: PAGE, get_backlinks: PAGE, traverse_graph: 'companies/ranger-22' };
  const lines = (['query', 'briefing', 'fact-check'] as const).flatMap(skill =>
    readFileSync(join(INPUTS, `sol-${skill}-input.txt`), 'utf8').split('\n'));
  const recorded = (['query', 'briefing', 'fact-check'] as const).flatMap(skill => recordedCalls('sol', skill));

  test('every get_backlinks call and the 30 traverse_graph calls with hops: [] read; every get_page call and the 8 traverse_graph calls with a hop chain still fail, all but one on a non-empty argument; each refusal carries a suggestion, and following its fix reads all 436 multi-selector get_page calls', async () => {
    expect(loadCorpora().pages.has(SLUG.traverse_graph!)).toBe(true);
    for (const tool of Object.keys(SLUG)) {
      expect(recorded.filter(c => c.tool === tool).length).toBe(lines.filter(l => l.startsWith(`- ${tool} `)).length);
    }
    const { tally: outcomes, followed, unguided } = await withHermeticEnv('n15-sol-recorded-calls', () => withRegistry('read-only', async call => {
      const tally: Record<string, Record<string, number>> = {};
      const followed: Record<string, Record<string, number>> = {};
      let unguided = 0;
      for (const c of recorded) {
        if (!c.args) { (tally[c.tool] ??= {})['arguments are not JSON'] = (tally[c.tool]!['arguments are not JSON'] ?? 0) + 1; continue; }
        const r = await call(c.tool, { ...c.args, slug: SLUG[c.tool] });
        const rule = 'ok' in r ? 'ok' : (/^(?:get_page|traverse_graph): ([a-z_]+ (?:does not combine with|returns part of the read view|cannot be combined with)|pass one window selector, not \d \(got [a-z_ ]+\))/.exec(r.error.message)?.[1] ?? r.error.message);
        (tally[c.tool] ??= {})[rule] = (tally[c.tool]![rule] ?? 0) + 1;
        if ('ok' in r) continue;
        if (r.error.code !== 'invalid_params' || !r.error.suggestion) unguided++;
        const fix = r.error.fix?.mcp;
        const f = fix ? await call(fix.tool, fix.arguments) : null;
        const next = !f ? 'no fix' : 'ok' in f ? 'reads' : f.error.code === 'coverage_from' || / is in the future\.$/.test(f.error.message) ? 'no recorded page at that instant' : f.error.message;
        (followed[rule] ??= {})[next] = (followed[rule]![next] ?? 0) + 1;
      }
      return { tally, followed, unguided };
    }, ['get_page', 'traverse_graph', 'get_backlinks']));
    expect(unguided).toBe(0);
    expect(followed).toEqual({
      'pass one window selector, not 2 (got lines and bytes)': { reads: 183 },
      'pass one window selector, not 3 (got lines and bytes and around_chunk_id)': { reads: 253 },
      'known_as_of does not combine with': { 'no recorded page at that instant': 169 },
      'grep returns part of the read view': { 'no fix': 1 },
      'hops cannot be combined with': { 'no fix': 8 },
    });
    expect(outcomes).toEqual({
      get_page: {
        'pass one window selector, not 2 (got lines and bytes)': 183,
        'pass one window selector, not 3 (got lines and bytes and around_chunk_id)': 253,
        'known_as_of does not combine with': 169,
        'grep returns part of the read view': 1,
        'arguments are not JSON': 1,
      },
      traverse_graph: { ok: 30, 'hops cannot be combined with': 8 },
      get_backlinks: { ok: 6 },
    });
  }, 120_000);
});
