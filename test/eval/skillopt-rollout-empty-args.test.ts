/**
 * GPT-6.1 Sol fills a tool's optional arguments with `""` instead of leaving them out. At gbrain `ca1281a2`
 * (v0.60.542.0) the SkillOpt rollout registry passed them to the handler, so every Sol `get_page` and
 * `get_backlinks` call in the N15 frontier probe failed (docs/benchmarks/2026-11-01-skillopt-method/REPORT.md,
 * "Tool errors in the SkillOpt rollout path"). gbrain v0.60.549.0 (gbrain#8429) drops `""` and `null` optional
 * arguments in the rollout and write-capture registries, then checks the rest against the operation's schema.
 * These tests drive the pinned registries with no provider key, and every one but the corpus check fails at
 * `ca1281a2`. The last replays the probe's recorded Sol calls: Sol's other filled-in defaults still break
 * `get_page` and `traverse_graph`, so a Sol rollout at this pin still loses those reads.
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

const PAGE = 'people/vera-chen-14';
const TASK = { task_id: 'sol-empty-args', task: 'Who is Vera Chen?' } as BenchmarkTask;
const SOL_EMPTY = { known_as_of: '', cursor: '', section: '', grep: '' };
const SOL_NULL = { known_as_of: null, cursor: null, section: null, grep: null, around_chunk_id: null };

type Loop = NonNullable<Parameters<typeof runRollout>[0]['toolLoopFn']>;
type Handlers = Parameters<Loop>[0]['toolHandlers'];

async function withRegistry<T>(registry: 'read-only' | 'write-capture', fn: (call: (tool: string, args: object) => Promise<{ ok: unknown } | { error: string }>) => Promise<T>, tools = ['get_page', 'get_backlinks']): Promise<T> {
  const engine = await openBrain();
  try {
    let out: T | undefined;
    const toolLoopFn = (async ({ toolHandlers }: { toolHandlers: Handlers }) => {
      const call = async (tool: string, args: object) => {
        try { return { ok: await toolHandlers.get(`brain_${tool}`)!.execute(args, {} as never) }; } catch (e) { return { error: (e as Error).message }; }
      };
      out = await fn(call);
      return { messages: [], stopReason: 'end', totalTurns: 0, totalUsage: {} };
    }) as unknown as Loop;
    await runRollout({ engine, skillText: readSeed('query'), targetModel: FRONTIER_TARGETS.sol, task: TASK, toolLoopFn, ...(registry === 'write-capture' ? { writeCapture: true } : { allowedTools: new Set(tools) }) });
    return out!;
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

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
      expect(r.badDate).toEqual({ error: expect.stringContaining('known_as_of must be an ISO 8601 instant') });
      expect(r.wrongType).toEqual({ error: expect.stringContaining('Parameter "include_content" must be a boolean') });
    }, 120_000);
  }
});

describe('what gbrain#8429 leaves refused: the frontier probe\'s recorded Sol calls, replayed', () => {
  const INPUTS = join(import.meta.dir, '../../docs/benchmarks/2026-11-01-skillopt-method/probe/frontier/f0b-sol/one-shot');
  const SLUG: Record<string, string> = { get_page: PAGE, get_backlinks: PAGE, traverse_graph: 'companies/ranger-22' };
  const lines = (['query', 'briefing', 'fact-check'] as const).flatMap(skill =>
    readFileSync(join(INPUTS, `sol-${skill}-input.txt`), 'utf8').split('\n'));
  const recorded = lines.flatMap(line => {
    const m = /^- (get_page|traverse_graph|get_backlinks) ((?:\{|").*[}"]) returned /.exec(line);
    if (!m) return [];
    const input: unknown = JSON.parse(m[2]!);
    let args: Record<string, unknown> | null = null;
    try { args = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, unknown>; } catch { /* Sol sent arguments that are not JSON */ }
    return [{ tool: m[1]!, args }];
  });

  test('every recorded get_backlinks call now reads; every get_page and traverse_graph call still fails, all but one on an argument rule #8429 does not touch', async () => {
    expect(loadCorpora().pages.has(SLUG.traverse_graph!)).toBe(true);
    for (const tool of Object.keys(SLUG)) {
      expect(recorded.filter(c => c.tool === tool).length).toBe(lines.filter(l => l.startsWith(`- ${tool} `)).length);
    }
    const outcomes = await withHermeticEnv('n15-sol-recorded-calls', () => withRegistry('read-only', async call => {
      const tally: Record<string, Record<string, number>> = {};
      for (const c of recorded) {
        const r = c.args ? await call(c.tool, { ...c.args, slug: SLUG[c.tool] }) : { error: 'arguments are not JSON' };
        const rule = 'ok' in r ? 'ok' : (/^(?:get_page|traverse_graph): ([a-z_]+ (?:applies to grep|does not combine with|returns part of the read view|cannot be combined with))/.exec(r.error)?.[1] ?? r.error);
        (tally[c.tool] ??= {})[rule] = (tally[c.tool]![rule] ?? 0) + 1;
      }
      return tally;
    }, ['get_page', 'traverse_graph', 'get_backlinks']));
    expect(outcomes).toEqual({
      get_page: { 'context applies to grep': 436, 'known_as_of does not combine with': 169, 'grep returns part of the read view': 1, 'arguments are not JSON': 1 },
      traverse_graph: { 'hops cannot be combined with': 38 },
      get_backlinks: { ok: 6 },
    });
  }, 120_000);
});
