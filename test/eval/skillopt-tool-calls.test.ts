/**
 * The ceiling attempt's tool-call classifier (GBEV-30, plan section 4,
 * skillopt-method/tool-calls.ts), keyless: synthetic refusals with and without
 * recovery, stop reasons, decisive reads, and the 651 calls Sol made in #304's
 * frontier probe replayed through the pinned rollout registry, classified by
 * the refusal text the installed gbrain returns.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRollout, type BenchmarkTask } from 'gbrain/core/skillopt';
import { loadCorpora } from '../../eval/generators/skillopt-method/common.ts';
import { gbrainPin } from '../../eval/runner/gbrain-version.ts';
import { withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import { readSeed } from '../../eval/runner/skillopt-method/dataset.ts';
import { FRONTIER_TARGETS, openBrain } from '../../eval/runner/skillopt-method/headroom.ts';
import {
  countStops, decisivePages, harnessLimit, recovered, refusalClass, refusedDecisiveReads, stopClass, tallyRefusals, toolCallRecords, type RefusalClass, type ToolCallRecord,
} from '../../eval/runner/skillopt-method/tool-calls.ts';

const WINDOW = 'get_page: pass one window selector, not 2 (section, grep, around_chunk_id).';
const KNOWN = "get_page: known_as_of does not combine with body: 'window'.";
const HOPS = 'traverse_graph: hops cannot be combined with depth.';
const OLD_WINDOW = 'get_page: context applies to grep; pass grep with it.';

const ok = (name: string, slug: string): ToolCallRecord => ({ name, input: { slug }, pages: [{ slug, title: slug }] });
const refused = (name: string, slug: string, error: string): ToolCallRecord => ({ name, input: { slug }, error });

describe('refusal classes', () => {
  test("each class reads gbrain's own refusal text for its tool; any other failure, and a131fb20's wording of the window refusal, read other", () => {
    expect(refusalClass(refused('get_page', 'a', WINDOW))).toBe('multi-window-selector');
    expect(refusalClass(refused('get_page', 'a', KNOWN))).toBe('known-as-of-with-read-view');
    expect(refusalClass(refused('traverse_graph', 'a', HOPS))).toBe('hop-chain-with-depth');
    expect(refusalClass(refused('get_page', 'a', OLD_WINDOW))).toBe('other');
    expect(refusalClass(refused('traverse_graph', 'a', WINDOW))).toBe('other');
    expect(refusalClass(refused('get_page', 'a', 'page_not_found: people/a'))).toBe('other');
    expect(refusalClass(ok('get_page', 'a'))).toBeNull();
  });

  test('a refused call is recovered when the next call to the same tool succeeds, unrecovered when it fails too, and abandoned when none comes', () => {
    const calls = [refused('get_page', 'a', WINDOW), ok('search', 'a'), ok('get_page', 'a'), refused('get_page', 'b', KNOWN), refused('get_page', 'b', KNOWN), refused('traverse_graph', 'c', HOPS)];
    expect([0, 3, 4, 5].map(i => recovered(calls, i))).toEqual([true, false, null, null]);
    const t = tallyRefusals([calls, [ok('get_page', 'x')]]);
    expect(t.calls).toBe(7);
    expect(t.read).toBe(3);
    expect(t.refused).toEqual({ 'multi-window-selector': 1, 'known-as-of-with-read-view': 2, 'hop-chain-with-depth': 1, other: 0 });
    expect(t.recovered).toEqual({ 'multi-window-selector': 1, 'known-as-of-with-read-view': 0, 'hop-chain-with-depth': 0, other: 0 });
    expect(t.abandoned).toEqual({ 'multi-window-selector': 0, 'known-as-of-with-read-view': 1, 'hop-chain-with-depth': 1, other: 0 });
    expect(t.by_tool).toEqual({ get_page: 3, traverse_graph: 1 });
  });

  test("a rollout's tool calls keep the arguments, a failed call's error text and the pages a read returned by slug and title, never page text", () => {
    const records = toolCallRecords({
      tool_calls: [
        { name: 'get_page', input: { slug: 'people/a' }, output: { slug: 'people/a', title: 'A', compiled_truth: 'secret body text' } },
        { name: 'get_page', input: { slug: 'people/a', section: 'x', grep: 'y' }, output: { error: WINDOW }, failed: true },
        { name: 'search', input: { query: 'a' }, output: { results: [{ slug: 'people/a', title: 'A' }, { slug: 'deals/b', title: 'B' }] } },
      ],
    } as Parameters<typeof toolCallRecords>[0]);
    expect(records).toEqual([
      { name: 'get_page', input: { slug: 'people/a' }, pages: [{ slug: 'people/a', title: 'A' }] },
      { name: 'get_page', input: { slug: 'people/a', section: 'x', grep: 'y' }, error: WINDOW },
      { name: 'search', input: { query: 'a' }, pages: [{ slug: 'people/a', title: 'A' }, { slug: 'deals/b', title: 'B' }] },
    ]);
    expect(JSON.stringify(records)).not.toContain('secret body text');
  });
});

describe('decisive reads and harness limits', () => {
  test("a task's decisive pages are its gold pages, or for an abstention task its near-miss pages", () => {
    expect(decisivePages({ answerable: true, gold: { slugs: ['people/a', 'deals/b'] }, near_miss: ['people/c'] })).toEqual(['people/a', 'deals/b']);
    expect(decisivePages({ answerable: false, gold: { slugs: [] }, near_miss: ['people/c'] })).toEqual(['people/c']);
    expect(decisivePages({ answerable: false, gold: { slugs: [] } })).toEqual([]);
  });

  test('a refused decisive read is a refused get_page or traverse_graph call on a decisive page (any case, with or without .md); a refused read of another page or by another tool is not', () => {
    const calls = [refused('get_page', 'People/A.md', KNOWN), refused('get_page', 'people/z', KNOWN), refused('search', 'people/a', 'bad query'), refused('traverse_graph', 'deals/b', HOPS), ok('get_page', 'people/z')];
    expect(refusedDecisiveReads(calls, ['people/a', 'deals/b']).map(c => (c.input as { slug: string }).slug)).toEqual(['People/A.md', 'deals/b']);
  });

  test('a refused decisive read does not count when a get_page or traverse_graph call on the same page succeeded anywhere in the rollout; a read of another page or by another tool does not clear it', () => {
    expect(refusedDecisiveReads([refused('get_page', 'People/A.md', WINDOW), ok('get_page', 'people/a')], ['people/a'])).toEqual([]);
    expect(refusedDecisiveReads([refused('traverse_graph', 'deals/b', HOPS), ok('get_page', 'deals/b.md')], ['deals/b'])).toEqual([]);
    expect(refusedDecisiveReads([refused('get_page', 'people/a', WINDOW), ok('get_page', 'people/z'), ok('search', 'people/a')], ['people/a'])).toHaveLength(1);
    expect(refusedDecisiveReads([ok('get_page', 'people/a'), refused('get_page', 'people/a', WINDOW)], ['people/a'])).toEqual([]);
  });

  test('stop reasons: end is completed, max_turns the 20-turn limit, length the output limit; a rollout is harness-limited by either limit or a refused decisive read', () => {
    expect(['end', 'max_turns', 'length', 'error', undefined].map(stopClass)).toEqual(['completed', 'turn-limit', 'output-length', 'other', 'other']);
    expect(countStops(['end', 'end', 'max_turns', 'length', null])).toEqual({ completed: 2, 'turn-limit': 1, 'output-length': 1, other: 1 });
    expect(harnessLimit({ stop_reason: 'max_turns', tool_calls: [] }, ['people/a'])).toBe('turn-limit');
    expect(harnessLimit({ stop_reason: 'length' }, ['people/a'])).toBe('output-length');
    expect(harnessLimit({ stop_reason: 'end', tool_calls: [refused('get_page', 'people/a', WINDOW)] }, ['people/a'])).toBe('refused-decisive-read');
    expect(harnessLimit({ stop_reason: 'end', tool_calls: [refused('get_page', 'people/a', WINDOW), ok('get_page', 'people/z')] }, ['people/a'])).toBe('refused-decisive-read');
    expect(harnessLimit({ stop_reason: 'end', tool_calls: [refused('get_page', 'people/a', WINDOW), ok('get_page', 'people/a')] }, ['people/a'])).toBeNull();
    expect(harnessLimit({ stop_reason: 'end', tool_calls: [refused('get_page', 'people/z', WINDOW)] }, ['people/a'])).toBeNull();
    expect(harnessLimit({ stop_reason: 'end', tool_calls: [ok('get_page', 'people/a')] }, ['people/a'])).toBeNull();
  });
});

describe("Sol's 651 recorded calls from #304, replayed at the installed pin", () => {
  const INPUTS = join(import.meta.dir, '../../docs/benchmarks/2026-11-01-skillopt-method/probe/frontier/f0b-sol/one-shot');
  const PAGE = 'people/vera-chen-14';
  const SLUG: Record<string, string> = { get_page: PAGE, get_backlinks: PAGE, traverse_graph: 'companies/ranger-22' };
  const recorded = (['query', 'briefing', 'fact-check'] as const).flatMap(skill => readFileSync(join(INPUTS, `sol-${skill}-input.txt`), 'utf8').split('\n')).flatMap(line => {
    const m = /^- (get_page|traverse_graph|get_backlinks) ((?:\{|").*[}"]) returned /.exec(line);
    if (!m) return [];
    const input: unknown = JSON.parse(m[2]!);
    let args: Record<string, unknown> | null = null;
    try { args = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, unknown>; } catch { /* Sol sent arguments that are not JSON */ }
    return [{ tool: m[1]!, args }];
  });

  /** Per pin: the refusal classes and successful reads the 651 calls give (a call whose arguments are not JSON reads other). */
  const EXPECTED: Record<string, { refused: Record<RefusalClass, number>; read: number }> = {
    // v0.60.549.0: the window refusal still read "context applies to grep".
    a131fb20ef4aafd017f0c6a6565ce5627dc46897: { refused: { 'multi-window-selector': 0, 'known-as-of-with-read-view': 169, 'hop-chain-with-depth': 38, other: 438 }, read: 6 },
    // v0.60.553.0, the ceiling attempt's pin (plan decision S).
    '311a83bbefb127118acb252fe827cb047126aa4d': { refused: { 'multi-window-selector': 436, 'known-as-of-with-read-view': 169, 'hop-chain-with-depth': 8, other: 2 }, read: 36 },
  };

  test('every recorded get_page, traverse_graph and get_backlinks call, classified by the refusal text this pin returns', async () => {
    expect(recorded.length).toBe(651);
    expect(loadCorpora().pages.has(SLUG.traverse_graph!)).toBe(true);
    const pin = gbrainPin().split('#')[1]!;
    expect(Object.keys(EXPECTED)).toContain(pin);
    const records = await withHermeticEnv('n15-sol-recorded-classes', async () => {
      const engine = await openBrain();
      try {
        let out: ToolCallRecord[] = [];
        type Loop = NonNullable<Parameters<typeof runRollout>[0]['toolLoopFn']>;
        const toolLoopFn = (async ({ toolHandlers }: { toolHandlers: Parameters<Loop>[0]['toolHandlers'] }) => {
          for (const c of recorded) {
            const input = c.args ? { ...c.args, slug: SLUG[c.tool] } : null;
            if (!input) { out.push({ name: c.tool, input: null, error: 'arguments are not JSON' }); continue; }
            try { await toolHandlers.get(`brain_${c.tool}`)!.execute(input, {} as never); out.push({ name: c.tool, input }); } catch (e) { out.push({ name: c.tool, input, error: (e as Error).message }); }
          }
          return { messages: [], stopReason: 'end', totalTurns: 0, totalUsage: {} };
        }) as unknown as Loop;
        await runRollout({ engine, skillText: readSeed('query'), targetModel: FRONTIER_TARGETS.sol, task: { task_id: 'sol-recorded', task: 'Who is Vera Chen?' } as BenchmarkTask, toolLoopFn, allowedTools: new Set(['get_page', 'traverse_graph', 'get_backlinks']) });
        return out;
      } finally {
        await engine.disconnect().catch(() => {});
      }
    });
    const tally = tallyRefusals(records.map(r => [r]));
    expect({ refused: tally.refused, read: tally.read }).toEqual(EXPECTED[pin]!);
    expect(tally.calls).toBe(651);
  }, 120_000);
});
